/**
 * Personal API tokens: what one looks like, and what is kept of it.
 *
 * A token is "crn_" followed by 32 random bytes in base64url, 47 characters in all. It is
 * shown once, in the answer to the request that made it, and never stored: the state
 * table keeps the SHA-256 of the token as the sort key of its item. A token that comes
 * with a request is hashed and looked up by that key, so the server compares digests and
 * holds a token no longer than the request that brought it. Neither a token nor its
 * digest is ever logged or sent back. A token is named by its id, 16 hex digits drawn
 * when it was made, which is no secret.
 *
 * Item: pk = "TOK", sk = <SHA-256 of the whole token text, lowercase hex>, with
 *   id, ownerSub, name, createdAt, expiresAt, revokedAt
 * the times as ISO text, revokedAt null until the token is revoked. Nothing is ever
 * deleted: revoking sets revokedAt, once.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_PREFIX = 'crn_';
export const TOKEN_ID = /^[0-9a-f]{16}$/;
export const MAX_ACTIVE_TOKENS = 10;
export const MIN_TOKEN_DAYS = 1;
export const MAX_TOKEN_DAYS = 90;
export const DEFAULT_TOKEN_DAYS = 30;
export const MAX_TOKEN_NAME = 40;

const DAY_MS = 24 * 60 * 60 * 1000;
const SECRET_BYTES = 32;
// Exactly "Bearer", one space and a token: anything else is not a token of this console.
const BEARER = /^Bearer (crn_([A-Za-z0-9_-]{43}))$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SUB = /^[A-Za-z0-9_.:-]{1,128}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNSAFE = /[\p{C}\p{Zl}\p{Zp}]/u;

/** A new token, from the system's CSPRNG. */
export function newToken() {
  return `${TOKEN_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`;
}

/**
 * The token in an Authorization header, or null. Only "Bearer " and a token of the
 * right form count. 43 characters of base64url hold 258 bits, so 32 bytes have four
 * spellings that decode alike; only the one that encodes back to itself is accepted.
 */
export function bearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = BEARER.exec(header);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64url');
  return bytes.length === SECRET_BYTES && bytes.toString('base64url') === match[2] ? match[1] : null;
}

/** The SHA-256 of a token, in lowercase hex: what the table keeps instead of the token. */
export function tokenDigest(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Whether two digests are the same, compared in constant time. */
export function sameDigest(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !DIGEST.test(a) || !DIGEST.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** An ISO time `days` whole days after `at` (epoch milliseconds). */
export function expiryAfter(at, days) {
  return new Date(at + days * DAY_MS).toISOString();
}

/**
 * Turn a stored item into a token record, or null if it is not one. The digest stays
 * inside the server: presentToken() leaves it out.
 */
export function tokenFromItem(item) {
  if (item === null || typeof item !== 'object') return null;
  const { sk, id, ownerSub, name, createdAt, expiresAt, revokedAt } = item;
  if (typeof sk !== 'string' || !DIGEST.test(sk)) return null;
  if (typeof id !== 'string' || !TOKEN_ID.test(id)) return null;
  if (typeof ownerSub !== 'string' || !SUB.test(ownerSub)) return null;
  if (typeof name !== 'string' || name === '' || name.length > MAX_TOKEN_NAME || UNSAFE.test(name)) return null;
  if (![createdAt, expiresAt].every((value) => typeof value === 'string' && ISO_TIME.test(value))) return null;
  if (revokedAt !== null && !(typeof revokedAt === 'string' && ISO_TIME.test(revokedAt))) return null;
  return { digest: sk, id, ownerSub, name, createdAt, expiresAt, revokedAt };
}

/** "revoked", "expired" or "active" at `nowMs`. A time that cannot be read counts as expired. */
export function tokenStatus(token, nowMs) {
  if (token.revokedAt !== null) return 'revoked';
  const expires = Date.parse(token.expiresAt);
  return Number.isFinite(expires) && nowMs < expires ? 'active' : 'expired';
}

/** A token as the API shows it to its owner: never the token, never its digest. */
export function presentToken(token, nowMs) {
  return {
    id: token.id,
    name: token.name,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    status: tokenStatus(token, nowMs),
  };
}
