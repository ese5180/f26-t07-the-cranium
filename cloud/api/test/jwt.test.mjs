// Tests for the check of a Cognito access token without API Gateway (src/lib/jwt.mjs, docs/live.md):
// tokens signed here with a key made for the test, as Cognito signs them (RS256, its key id in the header).

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';

import { createKeyRing, issuerOf, keysOf, readToken, verifyAccessToken } from '../src/lib/jwt.mjs';

const TEAM = issuerOf('us-east-1_Team12345');
const CUSTOMERS = issuerOf('us-east-1_Cust12345');
const CLIENTS = { [TEAM]: ['consoleclient', 'mobileclient'], [CUSTOMERS]: ['siteclient'] };
const NOW_S = 1_800_000_000;

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (key, kid) => ({ ...key.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });
const JWKS = { keys: [jwk(pair, 'key-1')] };

function part(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(claims = {}, { header = {}, key = pair.privateKey } = {}) {
  const head = part({ alg: 'RS256', kid: 'key-1', ...header });
  const body = part({
    sub: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    iss: TEAM,
    client_id: 'consoleclient',
    token_use: 'access',
    scope: 'aws.cognito.signin.user.admin',
    iat: NOW_S - 100,
    exp: NOW_S + 3500,
    'cognito:groups': ['viewers'],
    ...claims,
  });
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${signature}`;
}

const keys = keysOf(JWKS);
const keyFor = async (issuer, kid) => (issuer === TEAM || issuer === CUSTOMERS ? (keys.get(kid) ?? null) : null);
const check = (value) => verifyAccessToken(value, { clients: CLIENTS, keyFor, nowS: NOW_S });

test("an access token of one of the pool's app clients, signed by the pool, says who and until when", async () => {
  assert.deepEqual(await check(token()), {
    ok: true,
    issuer: TEAM,
    sub: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    clientId: 'consoleclient',
    expiresAt: NOW_S + 3500,
  });
  assert.equal((await check(token({ client_id: 'mobileclient' }))).ok, true);
  assert.equal((await check(token({ iss: CUSTOMERS, client_id: 'siteclient' }))).issuer, CUSTOMERS);
});

test('every other token is refused, with a reason that names no part of it', async () => {
  const refused = async (value, reason) => assert.deepEqual(await check(value), { ok: false, reason });
  await refused('', 'malformed');
  await refused('not.a.token', 'malformed');
  await refused(`${token()}x`.replace(/\.[^.]+$/, '.!!!'), 'malformed');
  await refused('x'.repeat(9000), 'malformed');
  // Signed with another key, or changed after signing.
  await refused(token({}, { key: other.privateKey }), 'signature');
  const [head, , signature] = token().split('.');
  await refused(`${head}.${part({ sub: 'someone-else', iss: TEAM })}.${signature}`, 'signature');
  // Not RS256, or no key id; a key id the pool does not have.
  await refused(token({}, { header: { alg: 'HS256' } }), 'algorithm');
  await refused(token({}, { header: { alg: 'none' } }), 'algorithm');
  await refused(token({}, { header: { kid: 42 } }), 'algorithm');
  await refused(token({}, { header: { kid: 'key-9' } }), 'key');
  // Another issuer, even one that looks like a pool; an ID token; another app client.
  await refused(token({ iss: issuerOf('us-east-1_Other1234') }), 'issuer');
  await refused(token({ iss: undefined }), 'issuer');
  await refused(token({ token_use: 'id' }), 'not_access');
  await refused(token({ client_id: 'siteclient' }), 'client');
  await refused(token({ iss: CUSTOMERS, client_id: 'consoleclient' }), 'client');
  await refused(token({ sub: 'has spaces' }), 'subject');
  // Expired a minute ago and more, or made in the future.
  await refused(token({ exp: NOW_S - 61 }), 'expired');
  await refused(token({ exp: '1800003500' }), 'expired');
  await refused(token({ iat: NOW_S + 61 }), 'not_yet');
  await refused(token({ nbf: NOW_S + 61 }), 'not_yet');
  assert.equal((await check(token({ exp: NOW_S - 30 }))).ok, true, 'within the skew');
  assert.equal(readToken(token()).header.kid, 'key-1');
});

test('a key set gives its RSA signing keys only', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  const set = keysOf({
    keys: [
      jwk(pair, 'a'),
      { ...jwk(pair, 'b'), alg: 'RS512' },
      { ...jwk(pair, 'c'), use: 'enc' },
      { ...ec, kid: 'd' },
      { kty: 'RSA', kid: 'e', n: 'not', e: 'AQAB' },
      { ...jwk(pair, 'has space') },
    ],
  });
  assert.deepEqual([...set.keys()], ['a']);
  assert.equal(keysOf(null).size, 0);
  assert.equal(keysOf({ keys: 'no' }).size, 0);
  assert.throws(() => issuerOf('not a pool'), TypeError);
});

test('the keys are fetched once, again for an unknown key id at most every five minutes, and kept through an outage', async () => {
  let clock = 1_000_000;
  const asked = [];
  let answer = () => new Response(JSON.stringify(JWKS), { status: 200 });
  const fetch = async (url) => {
    asked.push(url);
    return answer();
  };
  const ring = createKeyRing({ issuers: [TEAM, CUSTOMERS], fetch, now: () => clock });
  assert.ok(await ring.keyFor(TEAM, 'key-1'));
  assert.ok(await ring.keyFor(TEAM, 'key-1'));
  assert.deepEqual(asked, [`${TEAM}/.well-known/jwks.json`]);
  // An unknown key id: not fetched again within five minutes, then once.
  assert.equal(await ring.keyFor(TEAM, 'key-2'), null);
  assert.equal(asked.length, 1);
  clock += 5 * 60 * 1000;
  assert.equal(await ring.keyFor(TEAM, 'key-2'), null);
  assert.equal(asked.length, 2);
  // Only the pools' own addresses, and only key ids that could be one.
  assert.equal(await ring.keyFor('https://example.org', 'key-1'), null);
  assert.equal(await ring.keyFor(TEAM, '../../x'), null);
  assert.equal(asked.length, 2);
  // Six hours on, Cognito does not answer: the keys it gave before still count.
  clock += 6 * 3600 * 1000;
  answer = () => new Response('no', { status: 503 });
  assert.ok(await ring.keyFor(TEAM, 'key-1'));
  // A pool asked for the first time while Cognito does not answer: the check fails, it is not a refusal.
  await assert.rejects(ring.keyFor(CUSTOMERS, 'key-1'), /503/);
  assert.throws(() => createKeyRing({ issuers: ['https://example.org'], fetch }), TypeError);
});
