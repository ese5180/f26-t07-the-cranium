/**
 * The vectors that tie the Android app's proof of a password (core/Srp.kt) to the website's own
 * (cloud/web/src/site/assets/core.js): the same a, salt, B, user, password and time must give
 * the same A, u, k, x, S, key and signature in both. SrpTest.kt reads the output.
 *
 *   node apps/android/app/src/test/resources/srp/make-vectors.mjs > apps/android/app/src/test/resources/srp/vectors.json
 *
 * A, the key and the signature come from the website's exported functions (startSrp, srpKey,
 * srpClaim); u, k, x and S, which core.js keeps to itself, are worked out here with its own
 * srpHex and modPow, step by step as srpClaim does, and the signature made from them is checked
 * against srpClaim's before anything is written. Every input is fixed, so the file is the same
 * on every run. The passwords and the user IDs are made up.
 */

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

const core = await import(new URL('../../../../../../../cloud/web/src/site/assets/core.js', import.meta.url));
const { subtle } = globalThis.crypto;
const { N, g } = core.SRP_GROUP;

/** Fixed bytes from a seed: SHA-256 of seed and a counter, as long as needed. */
function seeded(seed, length) {
  const out = Buffer.alloc(length);
  for (let block = 0; block * 32 < length; block += 1) {
    createHash('sha256').update(`${seed}/${block}`).digest().copy(out, block * 32);
  }
  return out;
}

const bytesOfHex = (hex) => Buffer.from(hex, 'hex');
const H = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const numberOf = (bytes) => BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
const hashOfNumbers = (...values) => numberOf(H(...values.map((value) => bytesOfHex(core.srpHex(value)))));

const CASES = [
  {
    name: 'plain',
    userPoolId: 'xx-test-1_Pool0Tests',
    userId: '6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b',
    password: 'Correct-Horse-B4ttery',
    salt: 'b7c9e3a1d5f20468a3c1e5f7092b4d6f',
    at: Date.parse('2026-11-02T03:04:05Z'),
  },
  {
    // A salt with its top bit set, and of odd length: hashed with a 00 in front, and a 0.
    name: 'top bit, odd length',
    userPoolId: 'us-east-1_AbC123xyz',
    userId: '0a1b2c3d-4e5f-4061-8273-94a5b6c7d8e9',
    password: 'Another-Made-Up-Pass-77',
    salt: 'f3e2d1c0b9a8978685746352413020f1e',
    at: Date.parse('2026-12-31T23:59:59Z'),
  },
  {
    // Letters outside ASCII, hashed as UTF-8, and a day of one digit.
    name: 'non-ASCII password',
    userPoolId: 'eu-west-2_Zz9Yy8Xx7',
    userId: 'c0ffee00-1234-4abc-9def-0123456789ab',
    password: 'pässwörd-ñ-日本-🔑',
    salt: '0123',
    at: Date.parse('2027-01-09T12:30:07.999Z'),
  },
  {
    name: 'short salt with a leading digit',
    userPoolId: 'ap-southeast-2_Q1w2E3r4T',
    userId: '11111111-2222-4333-8444-555555555555',
    password: 'Yet-Another-Test-Password-1',
    salt: '8',
    at: Date.parse('2026-03-01T00:00:00Z'),
  },
];

const vectors = [];
for (const [index, item] of CASES.entries()) {
  // a, from the website's own startSrp, handed fixed bytes for its 128 random ones.
  const aBytes = seeded(`a-${index}`, 128);
  const { a, A } = core.startSrp({ getRandomValues: (array) => { array.set(aBytes); return array; } });
  assert.equal(a, numberOf(aBytes));

  // Cognito's side: a verifier from the password, and B from a fixed b.
  const poolName = item.userPoolId.slice(item.userPoolId.indexOf('_') + 1);
  const inner = H(Buffer.from(`${poolName}${item.userId}:${item.password}`, 'utf8'));
  const x = numberOf(H(bytesOfHex(core.srpHex(BigInt(`0x${item.salt}`))), inner));
  const k = hashOfNumbers(N, g);
  const verifier = core.modPow(g, x, N);
  const b = numberOf(seeded(`b-${index}`, 32));
  const B = (k * verifier + core.modPow(g, b, N)) % N;
  const secretBlock = seeded(`block-${index}`, 96).toString('base64');
  const timestamp = core.cognitoTimestamp(item.at);

  // The phone's side, step by step as srpClaim does it.
  const u = hashOfNumbers(A, B);
  const S = core.modPow(B - k * core.modPow(g, x, N), a + u * x, N);
  const key = Buffer.from(await core.srpKey(subtle, bytesOfHex(core.srpHex(S)), bytesOfHex(core.srpHex(u))));
  const own = createHmac('sha256', key).update(Buffer.concat([
    Buffer.from(poolName, 'utf8'), Buffer.from(item.userId, 'utf8'), Buffer.from(secretBlock, 'base64'),
    Buffer.from(timestamp, 'utf8'),
  ])).digest('base64');

  // The website's own claim must be the same.
  const claim = await core.srpClaim({
    subtle, userPoolId: item.userPoolId, userId: item.userId, password: item.password, a, A,
    srpB: B.toString(16), salt: item.salt, secretBlock, timestamp,
  });
  assert.equal(claim, own, `case ${item.name}: srpClaim and the steps here disagree`);

  // And Cognito's side agrees: S from the server's half of the exchange is the same S.
  const serverS = core.modPow((A * core.modPow(verifier, u, N)) % N, b, N);
  assert.equal(serverS, S, `case ${item.name}: the two halves of the exchange disagree`);

  vectors.push({
    name: item.name,
    userPoolId: item.userPoolId,
    userId: item.userId,
    password: item.password,
    a: aBytes.toString('hex'),
    A: A.toString(16),
    B: B.toString(16),
    salt: item.salt,
    secretBlock,
    timestampMs: item.at,
    timestamp,
    u: u.toString(16),
    k: k.toString(16),
    x: x.toString(16),
    S: S.toString(16),
    key: key.toString('hex'),
    signature: claim,
  });
}

process.stdout.write(`${JSON.stringify({ source: 'cloud/web/src/site/assets/core.js', vectors }, null, 2)}\n`);
