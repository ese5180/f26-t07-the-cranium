/**
 * One pool's sign-in for the bridge (auth.* in apps/shared/bridge.json): the page signs in on its own
 * sign-in page and hands the tokens over (auth.store); from then on it gets only access tokens
 * (auth.session), and never sees the refresh token again. The phone apps' rules (ShellAuth), without a
 * biometric, which Electron does not reach on Windows or Linux:
 *
 *   - the refresh token is kept encrypted by the system (Electron's safeStorage: DPAPI on Windows, the
 *     Secret Service or KWallet on Linux), in the app's own folder; where the system has no such store it
 *     is kept in memory only, and a restart signs out;
 *   - it is forgotten an hour after the sign-in, as the phone apps forget one that is not behind Face ID
 *     or a fingerprint;
 *   - an access token with less than 2 minutes left is refreshed with Cognito; signing out revokes.
 *
 * Nothing here logs or returns a refresh token. Everything outside (storage, encryption, Cognito, the
 * clock) is passed in, so that the tests drive it with stand-ins.
 */

import { BridgeError } from './bridge.mjs';

export const REFRESH_BEFORE_S = 120;
export const KEPT_MS = 60 * 60 * 1000;
// What auth.store says of the biometric: there is none here.
export const NO_BIOMETRIC = Object.freeze({ available: false, kind: null, enabled: false });

/** One claim of a JWT's payload, as text; null when it is not a JWT or has no such claim. Not verified here. */
export function claim(token, name) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))?.[name];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** auth.store: the access token must be of the pool's app client and of its user pool. */
export function tokenFits(accessToken, { clientId, userPoolId }) {
  const client = claim(accessToken, 'client_id');
  const issuer = claim(accessToken, 'iss');
  return client === clientId && typeof issuer === 'string' && issuer.endsWith(`/${userPoolId}`);
}

/**
 * @param {object} options
 * @param {string} options.pool                    'admin' or 'customer'
 * @param {{ region: string, userPoolId: string, clientId: string }} options.client
 * @param {{ read(): Promise<Buffer|null>, write(bytes: Buffer): Promise<void>, remove(): Promise<void> }} options.storage
 * @param {{ available(): boolean, encrypt(text: string): Buffer, decrypt(bytes: Buffer): string }} options.secrets
 * @param {{ refresh(o: object): Promise<{ accessToken: string, expiresIn: number }>, revoke(o: object): Promise<void> }} options.cognito
 * @param {() => number} [options.now]
 */
export function createVault({ pool, client, storage, secrets, cognito, now = Date.now }) {
  let record = null; // { refreshToken, signedInAt } of the sign-in kept
  let loaded = false;
  let access = null; // { token, expiresAt } in ms, in memory only

  async function load() {
    if (loaded) return record;
    loaded = true;
    if (!secrets.available()) return record;
    const bytes = await storage.read().catch(() => null);
    if (!bytes) return record;
    try {
      const value = JSON.parse(secrets.decrypt(bytes));
      if (typeof value?.refreshToken === 'string' && Number.isFinite(value.signedInAt)) {
        record = { refreshToken: value.refreshToken, signedInAt: value.signedInAt };
      }
    } catch {
      // A store that will not decrypt (another user, a new keyring) is no sign-in.
      await storage.remove().catch(() => {});
    }
    return record;
  }

  async function forget() {
    record = null;
    access = null;
    await storage.remove().catch(() => {});
  }

  async function store({ refreshToken, accessToken, expiresIn }) {
    if (!tokenFits(accessToken, client)) {
      throw new BridgeError('bad_request', "That sign-in is not of this app's client for the pool.");
    }
    await load();
    record = { refreshToken, signedInAt: now() };
    access = { token: accessToken, expiresAt: now() + expiresIn * 1000 };
    if (secrets.available()) await storage.write(secrets.encrypt(JSON.stringify(record)));
    return { biometric: { ...NO_BIOMETRIC } };
  }

  async function session() {
    await load();
    if (record && now() - record.signedInAt > KEPT_MS) {
      await forget();
      return { signedIn: false };
    }
    if (access && access.expiresAt - now() >= REFRESH_BEFORE_S * 1000) {
      return { signedIn: true, accessToken: access.token, expiresIn: Math.floor((access.expiresAt - now()) / 1000) };
    }
    if (!record) return { signedIn: false };
    let renewed;
    try {
      renewed = await cognito.refresh({ ...client, refreshToken: record.refreshToken });
    } catch (error) {
      if (error?.code === 'not_authorized') {
        await forget();
        return { signedIn: false };
      }
      throw new BridgeError('network', 'Cognito could not be reached to renew the sign-in.');
    }
    access = { token: renewed.accessToken, expiresAt: now() + renewed.expiresIn * 1000 };
    return { signedIn: true, accessToken: access.token, expiresIn: renewed.expiresIn };
  }

  async function signOut() {
    await load();
    const token = record?.refreshToken;
    await forget();
    if (token) await cognito.revoke({ ...client, refreshToken: token }).catch(() => {});
    return {};
  }

  return Object.freeze({ pool, store, session, signOut });
}

/** Cognito's user pool API, for refreshing and revoking (InitiateAuth REFRESH_TOKEN_AUTH, RevokeToken). */
export function createCognito({ fetch: fetchIt = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  async function call(region, target, body) {
    let response;
    try {
      response = await fetchIt(`https://cognito-idp.${region}.amazonaws.com/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': `AWSCognitoIdentityProviderService.${target}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw Object.assign(new Error('Cognito could not be reached'), { code: 'network' });
    }
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) {
      const kind = String(answer?.__type ?? '').split('#').pop();
      const code = ['NotAuthorizedException', 'UserNotFoundException', 'InvalidParameterException'].includes(kind)
        ? 'not_authorized'
        : 'network';
      throw Object.assign(new Error(`Cognito answered ${response.status}`), { code });
    }
    return answer;
  }
  return Object.freeze({
    async refresh({ region, clientId, refreshToken }) {
      const answer = await call(region, 'InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      });
      const result = answer?.AuthenticationResult;
      if (typeof result?.AccessToken !== 'string' || !Number.isInteger(result.ExpiresIn)) {
        throw Object.assign(new Error('Cognito gave no access token'), { code: 'network' });
      }
      return { accessToken: result.AccessToken, expiresIn: result.ExpiresIn };
    },
    async revoke({ region, clientId, refreshToken }) {
      await call(region, 'RevokeToken', { Token: refreshToken, ClientId: clientId });
    },
  });
}
