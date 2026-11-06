/**
 * Checking a Cognito access token without API Gateway (docs/live.md).
 *
 * The HTTP API checks every token itself, with its JWT authorizers. A WebSocket API has no JWT
 * authorizer, so the live function (live-app.mjs) checks the token a page connects with here: the
 * RS256 signature against the user pool's published keys, the issuer, that it is an access token,
 * the app client it was made for, and its times. What the token says beyond that (who, which pool) is
 * only believed once the signature holds.
 *
 * The keys are each pool's JSON Web Key Set, at <issuer>/.well-known/jwks.json. createKeyRing keeps
 * them for a few hours, and asks again sooner for a key id it does not know (Cognito adds a key before
 * it signs with it), but not more than once every few minutes, so that tokens with made-up key ids
 * cannot make the function fetch on every connection.
 *
 * No AWS SDK here: only node:crypto, and the fetch that is passed in.
 */

import { createPublicKey, verify } from 'node:crypto';

// Three parts of base64url. A Cognito access token is about a kilobyte; groups make it longer.
export const MAX_TOKEN_LENGTH = 8192;
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,6144}\.[A-Za-z0-9_-]{100,1024}$/;
// The clocks of Cognito and Lambda agree to well within this.
export const SKEW_S = 60;
const KEYS_KEPT_MS = 6 * 3600 * 1000;
const UNKNOWN_KEY_RETRY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;
const MAX_KEYS = 10;
const MIN_MODULUS_BITS = 2048;
const ISSUER =
  /^https:\/\/cognito-idp\.[a-z]{2}(?:-[a-z]+)+-\d{1,2}\.amazonaws\.com\/[a-z]{2}(?:-[a-z]+)+-\d{1,2}_[0-9A-Za-z]{1,64}$/;
const KID = /^[A-Za-z0-9+/=_-]{1,128}$/;
// A Cognito sub is a UUID; this is the set auth.mjs accepts.
const SUB = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The issuer of a user pool's tokens. */
export function issuerOf(userPoolId) {
  const region = /^([a-z]{2}(?:-[a-z]+)+-\d{1,2})_[0-9A-Za-z]{1,64}$/.exec(String(userPoolId ?? ''))?.[1];
  if (!region) throw new TypeError('a user pool ID such as us-east-1_AbC123 is needed');
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

function base64url(part) {
  return Buffer.from(part, 'base64url');
}

function json(part) {
  try {
    const value = JSON.parse(base64url(part).toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The header and claims of a token, unchecked, or null if it is not shaped like one. */
export function readToken(token) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !TOKEN_SHAPE.test(token)) return null;
  const [head, body, signature] = token.split('.');
  const header = json(head);
  const claims = json(body);
  if (header === null || claims === null) return null;
  return { header, claims, signed: `${head}.${body}`, signature: base64url(signature) };
}

/** The RSA signing keys of a JSON Web Key Set, by key id. Anything else in the set is left out. */
export function keysOf(jwks) {
  const keys = new Map();
  for (const jwk of Array.isArray(jwks?.keys) ? jwks.keys.slice(0, MAX_KEYS) : []) {
    if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || !KID.test(jwk.kid)) continue;
    if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
    try {
      const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
      // Cognito's keys are 2048 bits. A shorter one is not a key of a pool.
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) >= MIN_MODULUS_BITS) keys.set(jwk.kid, key);
    } catch {
      // A key that does not read as one is no key.
    }
  }
  return keys;
}

/**
 * The pools' keys, fetched when first needed and kept.
 *
 * @param {object} options
 * @param {string[]} options.issuers  the issuers whose keys may be fetched; no other address is
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.now]
 * @returns {{ keyFor(issuer: string, kid: string): Promise<import('node:crypto').KeyObject|null> }}
 */
export function createKeyRing({ issuers, fetch: fetchKeys = globalThis.fetch, now = Date.now }) {
  const allowed = new Set(issuers);
  for (const issuer of allowed) {
    if (!ISSUER.test(issuer)) throw new TypeError('an issuer must be a Cognito user pool address');
  }
  const kept = new Map();
  const pending = new Map();

  async function load(issuer) {
    const response = await fetchKeys(`${issuer}/.well-known/jwks.json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`the keys of the user pool answered ${response.status}`);
    const keys = keysOf(await response.json());
    kept.set(issuer, { keys, at: now() });
    return keys;
  }

  function refresh(issuer) {
    if (!pending.has(issuer)) {
      pending.set(
        issuer,
        load(issuer).finally(() => pending.delete(issuer))
      );
    }
    return pending.get(issuer);
  }

  return Object.freeze({
    async keyFor(issuer, kid) {
      if (!allowed.has(issuer) || typeof kid !== 'string' || !KID.test(kid)) return null;
      const entry = kept.get(issuer);
      const age = entry ? now() - entry.at : Infinity;
      if (entry && age < KEYS_KEPT_MS && (entry.keys.has(kid) || age < UNKNOWN_KEY_RETRY_MS)) {
        return entry.keys.get(kid) ?? null;
      }
      try {
        return (await refresh(issuer)).get(kid) ?? null;
      } catch (error) {
        // Keys fetched before still count while Cognito cannot be asked.
        if (entry) return entry.keys.get(kid) ?? null;
        throw error;
      }
    },
  });
}

function seconds(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Check an access token. Fails closed: anything missing or unexpected is a refusal, with a reason
 * that names no part of the token.
 *
 * @param {string} token
 * @param {object} options
 * @param {Record<string, string[]>} options.clients  the app clients whose tokens count, by issuer
 * @param {(issuer: string, kid: string) => Promise<object|null>} options.keyFor  createKeyRing's
 * @param {number} options.nowS  the time, in epoch seconds
 * @returns {Promise<{ ok: true, issuer: string, sub: string, clientId: string, expiresAt: number }
 *                   | { ok: false, reason: string }>}
 */
export async function verifyAccessToken(token, { clients, keyFor, nowS }) {
  const read = readToken(token);
  if (read === null) return { ok: false, reason: 'malformed' };
  const { header, claims, signed, signature } = read;
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, reason: 'algorithm' };
  const issuer = claims.iss;
  if (typeof issuer !== 'string' || !Object.hasOwn(clients, issuer)) return { ok: false, reason: 'issuer' };
  const key = await keyFor(issuer, header.kid);
  if (!key) return { ok: false, reason: 'key' };
  if (!verify('sha256', Buffer.from(signed, 'ascii'), key, signature)) return { ok: false, reason: 'signature' };
  // From here on, what the token says was said by the pool.
  if (claims.token_use !== 'access') return { ok: false, reason: 'not_access' };
  if (typeof claims.client_id !== 'string' || !clients[issuer].includes(claims.client_id)) {
    return { ok: false, reason: 'client' };
  }
  if (typeof claims.sub !== 'string' || !SUB.test(claims.sub)) return { ok: false, reason: 'subject' };
  const expiresAt = seconds(claims.exp);
  if (expiresAt === null || expiresAt <= nowS - SKEW_S) return { ok: false, reason: 'expired' };
  const issuedAt = seconds(claims.iat);
  if (issuedAt !== null && issuedAt > nowS + SKEW_S) return { ok: false, reason: 'not_yet' };
  const notBefore = seconds(claims.nbf);
  if (notBefore !== null && notBefore > nowS + SKEW_S) return { ok: false, reason: 'not_yet' };
  return { ok: true, issuer, sub: claims.sub, clientId: claims.client_id, expiresAt };
}
