// The sign-in keeper: the token is the pool's client's, the hour after a sign-in, refreshing, revoking,
// and a computer with no store for secrets.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BridgeError } from '../src/lib/bridge.mjs';
import { KEPT_MS, claim, createCognito, createVault, tokenFits } from '../src/lib/vault.mjs';

const CLIENT = { region: 'us-east-1', userPoolId: 'us-east-1_Pool1', clientId: 'client1' };
const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const ACCESS = jwt({ client_id: 'client1', iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Pool1', sub: 's1' });

function setup({ secretsAvailable = true, refresh } = {}) {
  let clock = 1_000_000;
  let stored = null;
  const calls = [];
  const vault = createVault({
    pool: 'admin',
    client: CLIENT,
    storage: {
      read: async () => stored,
      write: async (bytes) => {
        stored = bytes;
      },
      remove: async () => {
        stored = null;
      },
    },
    secrets: {
      available: () => secretsAvailable,
      encrypt: (text) => Buffer.from(`sealed:${text}`),
      decrypt: (bytes) => {
        const text = bytes.toString();
        if (!text.startsWith('sealed:')) throw new Error('not ours');
        return text.slice(7);
      },
    },
    cognito: {
      refresh: async (options) => {
        calls.push(['refresh', options.clientId, options.refreshToken]);
        if (refresh) return refresh(options);
        return { accessToken: 'renewed', expiresIn: 3600 };
      },
      revoke: async (options) => {
        calls.push(['revoke', options.refreshToken]);
      },
    },
    now: () => clock,
  });
  return {
    vault,
    calls,
    stored: () => stored,
    tick: (ms) => {
      clock += ms;
    },
  };
}

test('a token of another client or pool is refused before anything is kept', async () => {
  const { vault, stored } = setup();
  const other = jwt({ client_id: 'client2', iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Pool1' });
  await assert.rejects(vault.store({ refreshToken: 'r', accessToken: other, expiresIn: 3600 }), BridgeError);
  assert.equal(stored(), null);
  assert.equal(tokenFits(ACCESS, CLIENT), true);
  assert.equal(tokenFits(jwt({ client_id: 'client1', iss: 'https://x/us-east-1_Pool2' }), CLIENT), false);
  assert.equal(claim('not.a.jwt!', 'sub'), null);
});

test('kept sealed; the access token from memory; refreshed with less than 2 minutes left; gone after an hour', async () => {
  const { vault, calls, stored, tick } = setup();
  const answer = await vault.store({ refreshToken: 'refresh-1', accessToken: ACCESS, expiresIn: 600 });
  assert.deepEqual(answer, { biometric: { available: false, kind: null, enabled: false } });
  assert.match(stored().toString(), /^sealed:/);
  assert.deepEqual(await vault.session(), { signedIn: true, accessToken: ACCESS, expiresIn: 600 });
  tick(500_000);
  assert.deepEqual(await vault.session(), { signedIn: true, accessToken: 'renewed', expiresIn: 3600 });
  assert.deepEqual(calls, [['refresh', 'client1', 'refresh-1']]);
  tick(KEPT_MS);
  assert.deepEqual(await vault.session(), { signedIn: false });
  assert.equal(stored(), null);
});

test('a refresh Cognito refuses signs out; one that cannot reach it is a network error, and keeps the sign-in', async () => {
  const refused = setup({
    refresh: () => {
      throw Object.assign(new Error('no'), { code: 'not_authorized' });
    },
  });
  await refused.vault.store({ refreshToken: 'r', accessToken: ACCESS, expiresIn: 60 });
  assert.deepEqual(await refused.vault.session(), { signedIn: false });
  assert.equal(refused.stored(), null);

  const offline = setup({
    refresh: () => {
      throw Object.assign(new Error('down'), { code: 'network' });
    },
  });
  await offline.vault.store({ refreshToken: 'r', accessToken: ACCESS, expiresIn: 60 });
  await assert.rejects(offline.vault.session(), (error) => error.code === 'network');
  assert.notEqual(offline.stored(), null);
});

test('signing out revokes and forgets; with no store for secrets, the sign-in lasts as long as the app', async () => {
  const { vault, calls, stored } = setup();
  await vault.store({ refreshToken: 'refresh-2', accessToken: ACCESS, expiresIn: 3600 });
  assert.deepEqual(await vault.signOut(), {});
  assert.deepEqual(calls, [['revoke', 'refresh-2']]);
  assert.equal(stored(), null);
  assert.deepEqual(await vault.session(), { signedIn: false });

  const bare = setup({ secretsAvailable: false });
  await bare.vault.store({ refreshToken: 'r', accessToken: ACCESS, expiresIn: 60 });
  assert.equal(bare.stored(), null);
  assert.equal((await bare.vault.session()).signedIn, true);
});

test("Cognito's API: the refresh asked for, its answer read, and a refusal told apart from no network", async () => {
  const sent = [];
  const cognito = createCognito({
    fetch: async (url, init) => {
      sent.push({ url, target: init.headers['x-amz-target'], body: JSON.parse(init.body) });
      if (sent.length === 1) return Response.json({ AuthenticationResult: { AccessToken: 'a', ExpiresIn: 3600 } });
      return Response.json({ __type: 'NotAuthorizedException', message: 'x' }, { status: 400 });
    },
  });
  assert.deepEqual(await cognito.refresh({ region: 'eu-west-1', clientId: 'c', refreshToken: 't' }), { accessToken: 'a', expiresIn: 3600 });
  assert.equal(sent[0].url, 'https://cognito-idp.eu-west-1.amazonaws.com/');
  assert.equal(sent[0].target, 'AWSCognitoIdentityProviderService.InitiateAuth');
  assert.deepEqual(sent[0].body, { AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: 'c', AuthParameters: { REFRESH_TOKEN: 't' } });
  await assert.rejects(cognito.refresh({ region: 'eu-west-1', clientId: 'c', refreshToken: 't' }), (error) => error.code === 'not_authorized');
  const down = createCognito({
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(down.revoke({ region: 'eu-west-1', clientId: 'c', refreshToken: 't' }), (error) => error.code === 'network');
});
