/**
 * Tests for the console's own sign-in page, below the page itself: the proof of the
 * password that Cognito asks for (SRP, as Cognito does it), the conversation with
 * Cognito's user pool API, what each answer leads to, and the rules of the six boxes for
 * the code. The page that draws all this is tested in app.test.mjs and views.test.mjs.
 *
 * Cognito's side is cognito.mjs: written apart from core.js, with Node's own crypto and
 * the prime from Node's copy of RFC 3526, so that the two cannot share a mistake.
 */

import assert from 'node:assert/strict';
import { createHmac, getDiffieHellman, hkdfSync, randomBytes } from 'node:crypto';
import { test } from 'node:test';

import {
  N, createCognito, expectedClaim, g, javaBytes, k, passwordNumber, powMod, timestampAt,
} from './cognito.mjs';
import { CORE } from './page.mjs';

const core = await import(CORE);
const { subtle } = globalThis.crypto;

const POOL = 'xx-test-1_Pool0Tests';
const CLIENT = 'client-1';
const CONFIG = {
  clientId: CLIENT,
  loginOrigin: 'https://login.example',
  scope: 'openid cranium/console',
  redirectUri: 'https://console.example/',
  userPoolId: POOL,
  idpOrigin: 'https://idp.example',
};
const NOW = Date.parse('2026-11-02T03:04:05Z');
// Made up for these tests, as are the addresses: a reserved domain that cannot receive mail.
const PASSWORD = 'Correct-Horse-B4ttery';
const USER = { email: 'person@example.invalid', userId: '6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b', password: PASSWORD, code: '246810' };

const hex = (bytes) => Buffer.from(bytes).toString('hex');

// The numbers, the hash input and the time.

test('the group is the 3072-bit prime of RFC 3526 with g = 2, as Cognito uses', () => {
  assert.equal(core.SRP_GROUP.N, BigInt(`0x${getDiffieHellman('modp15').getPrime('hex')}`));
  assert.equal(core.SRP_GROUP.N.toString(2).length, 3072);
  assert.equal(core.SRP_GROUP.g, 2n);
});

test('a number is hashed as Java writes it: a 00 byte in front when the top bit is set', () => {
  const vectors = [
    [0n, '00'], [1n, '01'], [0x7fn, '7f'], [0x80n, '0080'], [0xffn, '00ff'], [0x100n, '0100'],
    [0xabcn, '0abc'], [0x8abcn, '008abc'], [0x0123n, '0123'], [0x7fffn, '7fff'], [0x8000n, '008000'],
  ];
  for (const [value, written] of vectors) {
    assert.equal(core.srpHex(value), written, value.toString(16));
    assert.equal(javaBytes(value).toString('hex'), written, `the stand-in agrees on ${value.toString(16)}`);
  }
  // N's top bit is set, so it is hashed as 385 bytes.
  assert.match(core.srpHex(N), /^00ffffffffffffffffc90fdaa2/);
  assert.equal(core.srpHex(N).length, 2 * 385);
  // And two ways of writing agree on many numbers of every length.
  for (let length = 1; length <= 48; length += 1) {
    const value = BigInt(`0x${randomBytes(length).toString('hex')}`);
    assert.equal(core.srpHex(value), javaBytes(value).toString('hex'));
  }
  assert.throws(() => core.srpHex(-1n), RangeError);
  assert.throws(() => core.srpHex(5), RangeError);
});

test('k is H(N | g) over those bytes', async () => {
  // Computed here from the bytes the server hashes.
  const expected = BigInt(`0x${hex(await subtle.digest('SHA-256', Buffer.concat([javaBytes(N), Buffer.from([2])])))}`);
  assert.equal(k, expected);
});

test('the time is written as Cognito wants it: the day of the month without a leading zero', () => {
  const vectors = [
    ['2026-11-02T03:04:05Z', 'Mon Nov 2 03:04:05 UTC 2026'],
    ['2026-12-31T23:59:59Z', 'Thu Dec 31 23:59:59 UTC 2026'],
    ['2026-03-01T00:00:00Z', 'Sun Mar 1 00:00:00 UTC 2026'],
    ['2027-01-09T12:30:07.999Z', 'Sat Jan 9 12:30:07 UTC 2027'],
    ['2026-10-10T09:00:00Z', 'Sat Oct 10 09:00:00 UTC 2026'],
  ];
  for (const [iso, written] of vectors) {
    assert.equal(core.cognitoTimestamp(Date.parse(iso)), written);
    // The stand-in reads it back to the second, weekday checked.
    assert.equal(timestampAt(written), Math.floor(Date.parse(iso) / 1000) * 1000);
  }
  assert.equal(timestampAt('Mon Nov 02 03:04:05 UTC 2026'), Number.NaN, 'a leading zero is not Cognito\'s format');
  assert.equal(timestampAt('Tue Nov 2 03:04:05 UTC 2026'), Number.NaN, 'nor a weekday that is wrong');
});

test('the key is 16 bytes of HKDF-SHA-256 (RFC 5869), with "Caldera Derived Key" as the info', async () => {
  // RFC 5869, test case 1, cut to 16 bytes.
  const ikm = new Uint8Array(22).fill(0x0b);
  const salt = Uint8Array.from(Buffer.from('000102030405060708090a0b0c', 'hex'));
  const info = Uint8Array.from(Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'));
  assert.equal(hex(await core.srpKey(subtle, ikm, salt, info)), '3cb25f25faacd57a90434f64d0362f2a');

  // With Cognito's info: as Node's HKDF makes it, and as Cognito's own library writes it
  // out, HMAC(HMAC(salt, ikm), info | 01) cut to 16 bytes.
  const input = randomBytes(385);
  const u = randomBytes(33);
  const derived = hex(await core.srpKey(subtle, input, u));
  assert.equal(derived, Buffer.from(hkdfSync('sha256', input, u, 'Caldera Derived Key', 16)).toString('hex'));
  const prk = createHmac('sha256', u).update(input).digest();
  const okm = createHmac('sha256', prk).update(Buffer.concat([Buffer.from('Caldera Derived Key'), Buffer.from([1])])).digest();
  assert.equal(derived, okm.subarray(0, 16).toString('hex'));
});

test('modular powers agree with the stand-in\'s, also for a base below zero', () => {
  for (let round = 0; round < 8; round += 1) {
    const base = BigInt(`0x${randomBytes(400).toString('hex')}`);
    const exponent = BigInt(`0x${randomBytes(160).toString('hex')}`);
    assert.equal(core.modPow(base, exponent, N), powMod(base, exponent, N));
    assert.equal(core.modPow(-base, exponent, N), powMod(((-base % N) + N) % N, exponent, N));
  }
  assert.equal(core.modPow(5n, 0n, N), 1n);
});

test('a is 128 bytes from the CSPRNG, and A = g^a mod N', () => {
  const asked = [];
  const crypto = { getRandomValues: (array) => { asked.push(array.length); return array.fill(7); } };
  const { a, A } = core.startSrp(crypto);
  assert.deepEqual(asked, [128]);
  assert.equal(a, BigInt(`0x${'07'.repeat(128)}`));
  assert.equal(A, powMod(g, a, N));
  // A random source that gives nothing is refused, not used.
  assert.throws(() => core.startSrp({ getRandomValues: (array) => array.fill(0) }));
});

/** One exchange: the server's half, and the claim the browser makes in answer. */
async function exchange({ salt, password = PASSWORD, claimed = password, userId = USER.userId } = {}) {
  const verifier = powMod(g, passwordNumber({ userPoolId: POOL, userId, password, salt }), N);
  const { a, A } = core.startSrp(globalThis.crypto);
  const b = BigInt(`0x${randomBytes(32).toString('hex')}`);
  const B = (k * verifier + powMod(g, b, N)) % N;
  const secretBlock = randomBytes(96).toString('base64');
  const timestamp = core.cognitoTimestamp(NOW);
  const claim = await core.srpClaim({
    subtle, userPoolId: POOL, userId, password: claimed, a, A, srpB: B.toString(16), salt: salt.toString(16),
    secretBlock, timestamp,
  });
  return { claim, expected: expectedClaim({ userPoolId: POOL, userId, verifier, A, b, B, secretBlock, timestamp }) };
}

test('the claim the browser makes is the one Cognito\'s side of the exchange expects', async () => {
  // Salts as Cognito sends them: hex without leading zeros, top bit set or not, of odd length.
  const salts = [
    BigInt(`0x${randomBytes(16).toString('hex')}`),
    BigInt(`0xf${randomBytes(16).toString('hex')}`),
    BigInt(`0x8${randomBytes(15).toString('hex')}`),
    BigInt(`0x1${randomBytes(15).toString('hex')}`),
    0x0123n,
  ];
  for (const salt of salts) {
    const { claim, expected } = await exchange({ salt });
    assert.equal(claim, expected, `salt ${salt.toString(16)}`);
    assert.match(claim, /^[A-Za-z0-9+/]{43}=$/, 'base64 of 32 bytes');
  }
  // A password with letters outside ASCII is hashed as UTF-8, and so is the name.
  const accents = await exchange({ salt: 0xabcdefn, password: 'pässwörd-ñ-日本-🔑' });
  assert.equal(accents.claim, accents.expected);
  // A wrong password, by one letter, makes another claim.
  const wrong = await exchange({ salt: 0xabcdefn, claimed: `${PASSWORD}x` });
  assert.notEqual(wrong.claim, wrong.expected);
});

test('a challenge that cannot be used is refused, not answered', async () => {
  const { a, A } = core.startSrp(globalThis.crypto);
  const fine = {
    subtle, userPoolId: POOL, userId: USER.userId, password: PASSWORD, a, A, srpB: 'abc123', salt: 'beef',
    secretBlock: 'AAAA', timestamp: core.cognitoTimestamp(NOW),
  };
  await core.srpClaim(fine);
  const broken = [
    { srpB: '0' }, { srpB: N.toString(16) }, { srpB: (2n * N).toString(16) }, { srpB: 'xyz' }, { srpB: '' },
    { srpB: 'f'.repeat(1025) }, { salt: '' }, { salt: '12 34' }, { secretBlock: 'not base64!' }, { secretBlock: '' },
    { userId: '' }, { userId: 'a:b' }, { userId: 'two words' },
  ];
  for (const change of broken) {
    await assert.rejects(core.srpClaim({ ...fine, ...change }), JSON.stringify(change));
  }
});

// The conversation with Cognito.

/**
 * A browser tab whose fetch reaches the stand-in for Cognito (at CONFIG.idpOrigin) and
 * the managed login pages (for the revocation of the refresh token).
 */
function tab({ users = [USER], fail, now = () => NOW, cognitoNow = now, dateHeader = null, idp } = {}) {
  const cognito = createCognito({ userPoolId: POOL, clientId: CLIENT, users, now: cognitoNow, fail });
  const items = new Map();
  const writes = [];
  const storage = {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { writes.push([key, String(value)]); items.set(key, String(value)); },
    removeItem: (key) => items.delete(key),
    clear: () => items.clear(),
  };
  const fetches = [];
  const navigations = [];
  async function fetch(url, init = {}) {
    fetches.push({ url, init });
    if (url.startsWith(CONFIG.idpOrigin)) {
      const answer = await (idp ?? ((u, i) => cognito.fetch(CONFIG.idpOrigin, u, i)))(url, init);
      if (dateHeader === null) return answer;
      const headers = new Headers(answer.headers);
      headers.set('date', dateHeader);
      return new Response(await answer.text(), { status: answer.status, headers });
    }
    if (url === `${CONFIG.loginOrigin}/oauth2/revoke`) return new Response(null, { status: 200 });
    throw new TypeError(`nothing at ${url}`);
  }
  const auth = core.createAuth({
    config: CONFIG,
    storage,
    location: { search: '', hash: '#/firmware', pathname: '/', assign: (url) => navigations.push(url) },
    history: { replaceState() {} },
    fetch,
    crypto: globalThis.crypto,
    now,
  });
  return { auth, cognito, fetches, navigations, items, writes };
}

const calls = (browser) => browser.cognito.calls.map(({ operation, body }) => body.ChallengeName ?? operation);

test('e-mail address, password and code: a session in the tab, and the password sent nowhere', async () => {
  const browser = tab();
  assert.deepEqual(await browser.auth.passwordSignIn('  Person@Example.INVALID ', PASSWORD), { step: 'code' });
  assert.deepEqual(await browser.auth.sendCode(USER.code), { step: 'done' });
  assert.deepEqual(calls(browser), ['InitiateAuth', 'PASSWORD_VERIFIER', 'SOFTWARE_TOKEN_MFA']);

  // Each call is to the user pool API, as Cognito's JSON protocol has it, and carries
  // nothing of the browser.
  const [start, verifier, code] = browser.fetches.filter((call) => call.url.startsWith(CONFIG.idpOrigin));
  for (const [call, operation] of [[start, 'InitiateAuth'], [verifier, 'RespondToAuthChallenge'], [code, 'RespondToAuthChallenge']]) {
    assert.equal(call.url, `${CONFIG.idpOrigin}/`);
    assert.equal(call.init.method, 'POST');
    assert.deepEqual(call.init.headers, {
      'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${operation}`,
    });
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.referrerPolicy, 'no-referrer');
    assert.equal(call.init.cache, 'no-store');
  }
  const sent = browser.cognito.calls.map((call) => call.body);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['AuthFlow', 'AuthParameters', 'ClientId']);
  assert.equal(sent[0].AuthFlow, 'USER_SRP_AUTH');
  assert.equal(sent[0].ClientId, CLIENT);
  // The address as the account has it: trimmed and in lower case.
  assert.equal(sent[0].AuthParameters.USERNAME, USER.email);
  assert.match(sent[0].AuthParameters.SRP_A, /^[0-9a-f]+$/);
  assert.deepEqual(Object.keys(sent[1].ChallengeResponses).sort(),
    ['PASSWORD_CLAIM_SECRET_BLOCK', 'PASSWORD_CLAIM_SIGNATURE', 'TIMESTAMP', 'USERNAME']);
  // Cognito's own name for the user, not what was typed.
  assert.equal(sent[1].ChallengeResponses.USERNAME, USER.userId);
  assert.equal(sent[1].ChallengeResponses.TIMESTAMP, 'Mon Nov 2 03:04:05 UTC 2026');
  assert.deepEqual(sent[2].ChallengeResponses, { USERNAME: USER.userId, SOFTWARE_TOKEN_MFA_CODE: USER.code });
  assert.equal(typeof sent[2].Session, 'string');

  // The password itself went nowhere: not in a request, not in an address, not in storage.
  for (const call of browser.fetches) {
    assert.equal(`${call.url} ${call.init.body ?? ''} ${JSON.stringify(call.init.headers ?? {})}`.includes(PASSWORD), false);
  }
  for (const [, value] of browser.writes) assert.equal(value.includes(PASSWORD), false);
  // Never the flow that sends it.
  assert.equal(JSON.stringify(sent).includes('USER_PASSWORD_AUTH'), false);

  // The same session as the AWS sign-in page leaves, and its refresh token revoked at once.
  assert.deepEqual([...browser.items.keys()], ['cranium.session']);
  assert.deepEqual(JSON.parse(browser.items.get('cranium.session')), { accessToken: 'SRP-ACCESS-1', expiresAt: NOW / 1000 + 3600 });
  assert.equal(browser.auth.accessToken(), 'SRP-ACCESS-1');
  assert.equal(await browser.auth.revocation(), 'revoked');
  const revoke = browser.fetches.find((call) => call.url.endsWith('/oauth2/revoke'));
  assert.deepEqual(Object.fromEntries(new URLSearchParams(revoke.init.body)), { token: 'SRP-REFRESH-1', client_id: CLIENT });
  for (const [, value] of browser.writes) {
    for (const secret of ['SRP-REFRESH-1', 'SRP-ID-1']) assert.equal(value.includes(secret), false, secret);
  }
  assert.equal(browser.auth.signedInWithin(30), true);
  assert.deepEqual(browser.navigations, []);
});

test('a wrong password and an unknown address get the same answer, and nothing is kept', async () => {
  const wrong = tab();
  const unknown = tab();
  const outcomes = [
    await wrong.auth.passwordSignIn(USER.email, 'Not-The-Password-1'),
    await unknown.auth.passwordSignIn('nobody@example.invalid', PASSWORD),
  ];
  assert.deepEqual(outcomes, [{ step: 'password', problem: 'wrong-password' }, { step: 'password', problem: 'wrong-password' }]);
  for (const browser of [wrong, unknown]) {
    assert.deepEqual(calls(browser), ['InitiateAuth', 'PASSWORD_VERIFIER']);
    assert.deepEqual([...browser.items.keys()], []);
    // There is no step of the code to send one to.
    assert.deepEqual(await browser.auth.sendCode(USER.code), { step: 'password', problem: 'expired' });
  }
  assert.equal(core.SIGN_IN_WORDS['wrong-password'], 'The e-mail address or password is wrong.');
});

test('an empty address or password is not sent', async () => {
  for (const [email, password] of [['', PASSWORD], ['   ', PASSWORD], [USER.email, ''], [USER.email, undefined]]) {
    const browser = tab();
    assert.deepEqual(await browser.auth.passwordSignIn(email, password), { step: 'password', problem: 'missing' });
    assert.equal(browser.fetches.length, 0);
  }
});

test('a wrong code leaves the sign-in waiting for the next; a sign-in Cognito ended starts again', async () => {
  const browser = tab();
  await browser.auth.passwordSignIn(USER.email, PASSWORD);
  assert.deepEqual(await browser.auth.sendCode('000000'), { step: 'code', problem: 'wrong-code' });
  assert.deepEqual(await browser.auth.sendCode(USER.code), { step: 'done' });

  // The third wrong code ends Cognito's session: what follows starts with the password.
  const unlucky = tab();
  await unlucky.auth.passwordSignIn(USER.email, PASSWORD);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual(await unlucky.auth.sendCode('000000'), { step: 'code', problem: 'wrong-code' });
  }
  assert.deepEqual(await unlucky.auth.sendCode(USER.code), { step: 'password', problem: 'expired' });
  assert.deepEqual(await unlucky.auth.sendCode(USER.code), { step: 'password', problem: 'expired' }, 'and stays ended');
  assert.deepEqual([...unlucky.items.keys()], []);

  // So does one that waited too long.
  let at = NOW;
  const slow = tab({ now: () => at });
  await slow.auth.passwordSignIn(USER.email, PASSWORD);
  at += 16 * 60 * 1000;
  assert.deepEqual(await slow.auth.sendCode(USER.code), { step: 'password', problem: 'expired' });
});

test('every answer of Cognito is put in the console\'s words, never in Cognito\'s', () => {
  const table = [
    ['NotAuthorizedException', 'password', 'wrong-password'],
    ['UserNotFoundException', 'password', 'wrong-password'],
    ['NotAuthorizedException', 'code', 'expired'],
    ['CodeMismatchException', 'code', 'wrong-code'],
    ['ExpiredCodeException', 'code', 'expired'],
    ['TooManyRequestsException', 'password', 'too-many'],
    ['LimitExceededException', 'code', 'too-many'],
    ['TooManyFailedAttemptsException', 'code', 'too-many'],
    ['PasswordResetRequiredException', 'password', 'elsewhere'],
    ['InternalErrorException', 'password', 'failed'],
    ['', 'code', 'failed'],
  ];
  for (const [name, step, problem] of table) assert.equal(core.signInProblem(name, step), problem, `${name} at ${step}`);
  assert.equal(core.SIGN_IN_WORDS['wrong-code'], 'That code is not right. Try the next one from your authenticator app.');
  assert.equal(core.SIGN_IN_WORDS['too-many'], 'Too many tries. Wait a minute.');
  for (const words of Object.values(core.SIGN_IN_WORDS)) assert.doesNotMatch(words, /Exception|Cognito/);

  // How Cognito names an error: in the body, perhaps with a namespace, or in a header.
  assert.equal(core.cognitoErrorName({ __type: 'NotAuthorizedException', message: 'x' }), 'NotAuthorizedException');
  assert.equal(core.cognitoErrorName({ __type: 'com.amazon.coral.service#UnknownOperationException' }), 'UnknownOperationException');
  assert.equal(core.cognitoErrorName(null, 'CodeMismatchException:http://internal.amazon.com/coral/'), 'CodeMismatchException');
  assert.equal(core.cognitoErrorName({ __type: '<script>' }), '');
  assert.equal(core.cognitoErrorName(null, null), '');
});

test('refusals, limits and failures at each step', async () => {
  const at = (operation, challenge, name) => (op, body) =>
    (op === operation && (challenge === null || body.ChallengeName === challenge) ? name : null);
  const cases = [
    [at('InitiateAuth', null, 'TooManyRequestsException'), 'password', { step: 'password', problem: 'too-many' }],
    [at('RespondToAuthChallenge', 'PASSWORD_VERIFIER', 'LimitExceededException'), 'password', { step: 'password', problem: 'too-many' }],
    [at('InitiateAuth', null, 'PasswordResetRequiredException'), 'password', { step: 'elsewhere', challenge: 'PASSWORD_RESET_REQUIRED' }],
    [at('InitiateAuth', null, 'InternalErrorException'), 'password', { step: 'password', problem: 'failed' }],
    [at('RespondToAuthChallenge', 'SOFTWARE_TOKEN_MFA', 'TooManyRequestsException'), 'code', { step: 'code', problem: 'too-many' }],
    [at('RespondToAuthChallenge', 'SOFTWARE_TOKEN_MFA', 'ExpiredCodeException'), 'code', { step: 'password', problem: 'expired' }],
    [at('RespondToAuthChallenge', 'SOFTWARE_TOKEN_MFA', 'NotAuthorizedException'), 'code', { step: 'password', problem: 'expired' }],
  ];
  for (const [fail, step, expected] of cases) {
    const browser = tab({ fail });
    let outcome = await browser.auth.passwordSignIn(USER.email, PASSWORD);
    if (step === 'code') outcome = await browser.auth.sendCode(USER.code);
    assert.deepEqual(outcome, expected, JSON.stringify(expected));
    assert.deepEqual([...browser.items.keys()], []);
  }

  // The network, and answers that cannot be read.
  const offline = tab({ idp: () => { throw new TypeError('Failed to fetch'); } });
  assert.deepEqual(await offline.auth.passwordSignIn(USER.email, PASSWORD), { step: 'password', problem: 'network' });
  const garbled = tab({ idp: () => new Response('<html>', { status: 200 }) });
  assert.deepEqual(await garbled.auth.passwordSignIn(USER.email, PASSWORD), { step: 'password', problem: 'failed' });
  const bare = tab({ idp: () => new Response('{}', { status: 500 }) });
  assert.deepEqual(await bare.auth.passwordSignIn(USER.email, PASSWORD), { step: 'password', problem: 'failed' });
  const odd = tab({ idp: () => Response.json({ ChallengeName: 'PASSWORD_VERIFIER', ChallengeParameters: { SRP_B: 'zz' } }) });
  assert.deepEqual(await odd.auth.passwordSignIn(USER.email, PASSWORD), { step: 'password', problem: 'failed' });
  // A code that went out but whose answer never came back keeps the step of the code.
  let down = false;
  const flaky = tab({ idp: (url, init) => { if (down) throw new TypeError('Failed to fetch'); return flaky.cognito.fetch(CONFIG.idpOrigin, url, init); } });
  await flaky.auth.passwordSignIn(USER.email, PASSWORD);
  down = true;
  assert.deepEqual(await flaky.auth.sendCode(USER.code), { step: 'code', problem: 'network' });
  down = false;
  assert.deepEqual(await flaky.auth.sendCode(USER.code), { step: 'done' });
});

test('a step this page does not do goes to the AWS sign-in page, with nothing kept', async () => {
  for (const next of ['NEW_PASSWORD_REQUIRED', 'MFA_SETUP', 'SELECT_MFA_TYPE', 'SMS_MFA', 'EMAIL_OTP', 'CUSTOM_CHALLENGE']) {
    const browser = tab({ users: [{ ...USER, next }] });
    assert.deepEqual(await browser.auth.passwordSignIn(USER.email, PASSWORD), { step: 'elsewhere', challenge: next });
    assert.deepEqual([...browser.items.keys()], []);
    assert.deepEqual(await browser.auth.sendCode(USER.code), { step: 'password', problem: 'expired' });
    // Leaving is the page's to do, through the AWS sign-in page's own flow.
    assert.deepEqual(browser.navigations, []);
  }
  // A name that is not a name is not repeated.
  const strange = tab({ idp: () => Response.json({ ChallengeName: '<b>x</b>', Session: 's' }) });
  assert.deepEqual(await strange.auth.passwordSignIn(USER.email, PASSWORD), { step: 'password', problem: 'failed' });
});

test('the time in the claim goes by Cognito\'s clock where its answer says it', async () => {
  // This computer's clock is an hour behind.
  const behind = () => NOW - 3600 * 1000;
  const told = tab({ now: behind, cognitoNow: () => NOW, dateHeader: new Date(NOW).toUTCString() });
  assert.deepEqual(await told.auth.passwordSignIn(USER.email, PASSWORD), { step: 'code' });
  // Without the header the claim carries this computer's time, which Cognito refuses.
  const untold = tab({ now: behind, cognitoNow: () => NOW });
  assert.deepEqual(await untold.auth.passwordSignIn(USER.email, PASSWORD), { step: 'password', problem: 'wrong-password' });
});

test('signing out drops a sign-in that waits for its code, and a new session clears the mark of a sign-out', async () => {
  const browser = tab();
  await browser.auth.passwordSignIn(USER.email, PASSWORD);
  browser.auth.signedOutElsewhere();
  assert.deepEqual(await browser.auth.sendCode(USER.code), { step: 'password', problem: 'expired' });
  assert.deepEqual([...browser.items.keys()], ['cranium.signedout']);
  // Signed in again: a reload finds the session, not the sign-out.
  await browser.auth.passwordSignIn(USER.email, PASSWORD);
  await browser.auth.sendCode(USER.code);
  assert.deepEqual([...browser.items.keys()], ['cranium.session']);
  assert.deepEqual(await browser.auth.resume(), { status: 'signed-in', route: null });

  const dropped = tab();
  await dropped.auth.passwordSignIn(USER.email, PASSWORD);
  dropped.auth.cancelPasswordSignIn();
  assert.deepEqual(await dropped.auth.sendCode(USER.code), { step: 'password', problem: 'expired' });
});

// The six boxes.

const empty = () => ['', '', '', '', '', ''];
const boxes = (text) => [...text.padEnd(6, ' ')].map((digit) => (digit === ' ' ? '' : digit));

test('a typed digit fills its box and moves on; anything but a digit changes nothing', () => {
  assert.equal(core.CODE_LENGTH, 6);
  assert.deepEqual(core.enterCode(empty(), 0, '4'), { digits: boxes('4'), focus: 1 });
  assert.deepEqual(core.enterCode(boxes('4'), 1, '2'), { digits: boxes('42'), focus: 2 });
  // The last box stays where it is.
  assert.deepEqual(core.enterCode(boxes('12345'), 5, '6'), { digits: boxes('123456'), focus: 5 });
  // Typed over a digit: the new one.
  assert.deepEqual(core.enterCode(boxes('123'), 1, '9'), { digits: boxes('193'), focus: 2 });
  for (const text of ['a', ' ', '-', 'e', '٣', '.']) {
    assert.deepEqual(core.enterCode(boxes('12'), 2, text), { digits: boxes('12'), focus: 2 }, JSON.stringify(text));
  }
  // An emptied box is empty.
  assert.deepEqual(core.enterCode(boxes('123'), 2, ''), { digits: boxes('12'), focus: 2 });
  assert.equal(core.codeComplete(boxes('123456')), true);
  assert.equal(core.codeComplete(boxes('12345')), false);
  assert.equal(core.codeComplete(['1', '2', '3', '4', '5', 'x']), false);
});

test('a whole code fills all six boxes wherever it arrives, with or without a space; part of one fills from there', () => {
  for (const text of ['123456', '123 456', ' 123-456 ', '1 2 3 4 5 6', '123456\n']) {
    for (const index of [0, 3, 5]) {
      assert.deepEqual(core.enterCode(empty(), index, text), { digits: boxes('123456'), focus: 5 }, `${JSON.stringify(text)} at ${index}`);
    }
  }
  // Over what was there before.
  assert.deepEqual(core.enterCode(boxes('999'), 1, '123456'), { digits: boxes('123456'), focus: 5 });
  // More than six digits: the first six.
  assert.deepEqual(core.enterCode(empty(), 0, '12345678'), { digits: boxes('123456'), focus: 5 });
  // Fewer: from that box on, as far as the boxes go.
  assert.deepEqual(core.enterCode(empty(), 1, '789'), { digits: boxes(' 789'), focus: 4 });
  assert.deepEqual(core.enterCode(boxes('12'), 4, '789'), { digits: boxes('12  78'), focus: 5 });
});

test('Backspace, Delete, the arrows, Home and End', () => {
  // Backspace empties the box, or in an empty box the one before it, and goes there.
  assert.deepEqual(core.keyInCode(boxes('123'), 2, 'Backspace'), { digits: boxes('12'), focus: 2 });
  assert.deepEqual(core.keyInCode(boxes('12'), 2, 'Backspace'), { digits: boxes('1'), focus: 1 });
  assert.deepEqual(core.keyInCode(empty(), 0, 'Backspace'), { digits: empty(), focus: 0 });
  assert.deepEqual(core.keyInCode(boxes('123'), 1, 'Delete'), { digits: ['1', '', '3', '', '', ''], focus: 1 });
  assert.deepEqual(core.keyInCode(boxes('123'), 1, 'ArrowLeft'), { digits: boxes('123'), focus: 0 });
  assert.deepEqual(core.keyInCode(boxes('123'), 0, 'ArrowLeft'), { digits: boxes('123'), focus: 0 });
  assert.deepEqual(core.keyInCode(boxes('123'), 4, 'ArrowRight'), { digits: boxes('123'), focus: 5 });
  assert.deepEqual(core.keyInCode(boxes('123'), 5, 'ArrowRight'), { digits: boxes('123'), focus: 5 });
  assert.deepEqual(core.keyInCode(boxes('123'), 3, 'Home'), { digits: boxes('123'), focus: 0 });
  assert.deepEqual(core.keyInCode(boxes('123'), 0, 'End'), { digits: boxes('123'), focus: 5 });
  // Everything else is the browser's: digits come as input, Tab and Enter do what they do.
  for (const key of ['1', 'Tab', 'Enter', 'a', 'Shift']) assert.equal(core.keyInCode(boxes('1'), 0, key), null, key);
});
