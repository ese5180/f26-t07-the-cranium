/**
 * Makes CraniumKitTests/SRPVectors.swift: what the website's own SRP code makes of fixed numbers,
 * for SRPTests.swift to expect of the app's (Sources/CraniumKit/CognitoSRP.swift, BigUInt.swift).
 * From the repository's root:
 *
 *   node apps/ios/CraniumKit/Tests/srp-vectors.mjs > apps/ios/CraniumKit/Tests/CraniumKitTests/SRPVectors.swift
 *
 * Node 22 or later. It loads the website's core.js the way the website's own tests do
 * (cloud/web/test/page.mjs), runs startSrp with a fixed random source and srpClaim with fixed
 * challenges, and writes down A, u, x, S, the key and the signature. Before it writes a vector it
 * checks the signature twice: it is what core.js's srpClaim gives, and it is what Cognito's side
 * of the exchange expects (cloud/web/test/cognito.mjs, a stand-in for Cognito written apart from
 * core.js, with Node's own crypto and Node's copy of the prime). The "random" numbers come from
 * SHA-256 of fixed labels, so that a second run writes the same file.
 *
 * It also writes the time stamps and a set of sums, products, remainders and powers that Node's
 * BigInt worked out, for BigUInt.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { CORE } from '../../../../cloud/web/test/page.mjs';
import { N, expectedClaim, g, k as serverK, passwordNumber, powMod } from '../../../../cloud/web/test/cognito.mjs';

const core = await import(CORE);
const { subtle } = globalThis.crypto;

/** `count` bytes that look random and are always the same for `label`. */
function stream(label, count) {
  const out = [];
  for (let block = 0; out.length < count; block += 1) {
    out.push(...createHash('sha256').update(`${label}/${block}`).digest());
  }
  return Uint8Array.from(out.slice(0, count));
}

const hexOf = (bytes) => Buffer.from(bytes).toString('hex');
const numberOf = (bytes) => BigInt(`0x${hexOf(bytes) || '0'}`);
const bytesOfHex = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map((part) => Buffer.from(part)))).digest();
/** H of numbers written one after the other, the website's way (core.srpHex). */
const hashOfNumbers = (...values) => numberOf(sha256(...values.map((value) => bytesOfHex(core.srpHex(value)))));

function swiftString(text) {
  assert.doesNotMatch(text, /[\u0000-\u001f]/, 'no control characters');
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// The exchanges. The salts are as Cognito sends them: hex without leading zeros, with the top bit
// set or not, of odd length. One answer comes in capitals, which the website reads too.
const CASES = [
  {
    name: 'ascii',
    userPoolId: 'us-east-1_AbCdEf123',
    userId: '6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b',
    password: 'Correct-Horse-B4ttery',
    salt: numberOf(Uint8Array.from([0xc3, ...stream('salt/ascii', 15)])),
    at: '2026-11-02T03:04:05Z',
  },
  {
    name: 'unicode password, short salt',
    userPoolId: 'eu-west-2_Pool0Tests',
    userId: 'a1b2c3d4-0000-4fff-8000-123456789abc',
    password: 'pässwörd-ñ-日本-🔑',
    salt: 0x123n,
    at: '2027-01-09T12:30:07.999Z',
  },
  {
    name: 'salt without its top bit, answer in capitals',
    userPoolId: 'ap-southeast-2_Z9',
    userId: '0b5e',
    password: 'p@ss "quoted" \\ backslash',
    salt: numberOf(Uint8Array.from([0x1f, ...stream('salt/caps', 15)])),
    at: '2026-03-01T00:00:00Z',
    capitals: true,
  },
  {
    name: 'long user ID',
    userPoolId: 'us-gov-west-1_LongPool0000000000',
    userId: 'u'.repeat(128),
    password: 'x',
    salt: numberOf(stream('salt/long', 32)),
    at: '2028-02-29T23:59:59Z',
  },
];

const vectors = [];
for (const item of CASES) {
  const aBytes = stream(`a/${item.name}`, 128);
  // The website's own start, with a random source that gives these bytes.
  const { a, A } = core.startSrp({ getRandomValues: (array) => { array.set(aBytes); return array; } });
  assert.equal(a, numberOf(aBytes));

  // Cognito's half: the verifier of the password, a secret b, and B.
  const verifier = powMod(g, passwordNumber({ userPoolId: item.userPoolId, userId: item.userId, password: item.password, salt: item.salt }), N);
  const b = numberOf(stream(`b/${item.name}`, 32));
  const B = (serverK * verifier + powMod(g, b, N)) % N;
  const srpB = item.capitals ? B.toString(16).toUpperCase() : B.toString(16);
  const salt = item.capitals ? item.salt.toString(16).toUpperCase() : item.salt.toString(16);
  const secretBlock = Buffer.from(stream(`block/${item.name}`, 96 + vectors.length)).toString('base64');
  const timestamp = core.cognitoTimestamp(Date.parse(item.at));

  // The steps of core.js's srpClaim, with its own pieces.
  const k = hashOfNumbers(N, g);
  assert.equal(k, serverK);
  const u = hashOfNumbers(A, B);
  const poolName = item.userPoolId.slice(item.userPoolId.indexOf('_') + 1);
  const inner = sha256(Buffer.from(`${poolName}${item.userId}:${item.password}`, 'utf8'));
  const x = numberOf(sha256(bytesOfHex(core.srpHex(item.salt)), inner));
  const S = core.modPow(B - k * core.modPow(g, x, N), a + u * x, N);
  const key = await core.srpKey(subtle, bytesOfHex(core.srpHex(S)), bytesOfHex(core.srpHex(u)));

  const signature = await core.srpClaim({
    subtle, userPoolId: item.userPoolId, userId: item.userId, password: item.password, a, A, srpB, salt, secretBlock, timestamp,
  });
  // The same steps by hand give core.js's signature, and Cognito's side expects it.
  const message = Buffer.concat([
    Buffer.from(poolName, 'utf8'), Buffer.from(item.userId, 'utf8'), Buffer.from(secretBlock, 'base64'), Buffer.from(timestamp, 'utf8'),
  ]);
  const hmacKey = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  assert.equal(Buffer.from(await subtle.sign('HMAC', hmacKey, message)).toString('base64'), signature);
  assert.equal(expectedClaim({ userPoolId: item.userPoolId, userId: item.userId, verifier, A, b, B, secretBlock, timestamp }), signature);

  vectors.push({
    name: item.name, userPoolId: item.userPoolId, userId: item.userId, password: item.password,
    aBytes: hexOf(aBytes), A: A.toString(16), srpA: A.toString(16), salt, srpB, secretBlock, timestamp,
    u: u.toString(16), x: x.toString(16), S: S.toString(16), key: hexOf(key), signature,
  });
}

// Time stamps: the website's test vectors and a few more.
const TIMES = [
  '2026-11-02T03:04:05Z', '2026-12-31T23:59:59Z', '2026-03-01T00:00:00Z', '2027-01-09T12:30:07.999Z',
  '2026-10-10T09:00:00Z', '2028-02-29T23:59:59.5Z', '2030-07-04T14:05:09Z', '2026-01-01T00:00:00Z',
];
const timestamps = TIMES.map((iso) => ({ ms: Date.parse(iso), text: core.cognitoTimestamp(Date.parse(iso)) }));

// Arithmetic for BigUInt, by Node's BigInt, on numbers of many sizes.
const sizes = [1, 7, 8, 9, 15, 16, 17, 31, 64, 65, 200, 384, 385, 512];
const arithmetic = [];
for (const [index, left] of sizes.entries()) {
  const right = sizes[(index * 5 + 3) % sizes.length];
  const p = numberOf(stream(`left/${index}`, left));
  const q = numberOf(stream(`right/${index}`, right)) || 1n;
  const [big, small] = p >= q ? [p, q] : [q, p];
  arithmetic.push({
    p: p.toString(16), q: q.toString(16), sum: (p + q).toString(16), difference: (big - small).toString(16),
    product: (p * q).toString(16), remainder: (p % q).toString(16),
  });
}
// Powers modulo odd numbers of one limb, of two, of an odd count, and N itself.
const powers = [];
for (const [index, bytes] of [1, 8, 9, 16, 136, 384].entries()) {
  for (let round = 0; round < 3; round += 1) {
    let modulus = numberOf(stream(`modulus/${index}`, bytes)) | 1n;
    if (modulus === 1n) modulus = 251n;
    const base = numberOf(stream(`base/${index}/${round}`, bytes + 5));
    const exponent = numberOf(stream(`exponent/${index}/${round}`, 1 + round * 40));
    powers.push({ base: base.toString(16), exponent: exponent.toString(16), modulus: modulus.toString(16), result: core.modPow(base, exponent, modulus).toString(16) });
  }
}
for (let round = 0; round < 3; round += 1) {
  const base = numberOf(stream(`base/N/${round}`, 400));
  const exponent = numberOf(stream(`exponent/N/${round}`, 128));
  powers.push({ base: base.toString(16), exponent: exponent.toString(16), modulus: N.toString(16), result: core.modPow(base, exponent, N).toString(16) });
}
powers.push({ base: 'abc', exponent: '0', modulus: N.toString(16), result: '1' });

const field = (name, value) => `${name}: ${swiftString(value)}`;
const lines = [];
lines.push('// Made by apps/ios/CraniumKit/Tests/srp-vectors.mjs from the website\'s own SRP code (core.js), and');
lines.push('// checked there against the website\'s stand-in for Cognito. Do not edit: run it again.');
lines.push('//');
lines.push('//   node apps/ios/CraniumKit/Tests/srp-vectors.mjs > apps/ios/CraniumKit/Tests/CraniumKitTests/SRPVectors.swift');
lines.push('//');
lines.push('// Made-up accounts and passwords: nothing here is a real one.');
lines.push('');
lines.push('struct SRPVector {');
lines.push('    let name, userPoolId, userId, password: String');
lines.push('    /// The 128 random bytes that make a, in hex.');
lines.push('    let aBytes: String');
lines.push('    let A, srpA, salt, srpB, secretBlock, timestamp, u, x, S, key, signature: String');
lines.push('}');
lines.push('');
lines.push('struct ArithmeticVector { let p, q, sum, difference, product, remainder: String }');
lines.push('struct PowerVector { let base, exponent, modulus, result: String }');
lines.push('');
lines.push('enum SRPVectors {');
lines.push(`    static let k = ${swiftString(serverK.toString(16))}`);
lines.push('');
lines.push('    static let exchanges: [SRPVector] = [');
for (const vector of vectors) {
  lines.push('        SRPVector(');
  const entries = Object.entries(vector);
  entries.forEach(([name, value], index) => lines.push(`            ${field(name, value)}${index < entries.length - 1 ? ',' : ''}`));
  lines.push('        ),');
}
lines.push('    ]');
lines.push('');
lines.push('    /// Milliseconds since 1970, and the time as the website writes it for Cognito.');
lines.push('    static let timestamps: [(ms: Double, text: String)] = [');
for (const { ms, text } of timestamps) lines.push(`        (${ms}, ${swiftString(text)}),`);
lines.push('    ]');
lines.push('');
lines.push('    static let arithmetic: [ArithmeticVector] = [');
for (const item of arithmetic) {
  lines.push(`        ArithmeticVector(${Object.entries(item).map(([name, value]) => field(name, value)).join(', ')}),`);
}
lines.push('    ]');
lines.push('');
lines.push('    static let powers: [PowerVector] = [');
for (const item of powers) {
  lines.push(`        PowerVector(${Object.entries(item).map(([name, value]) => field(name, value)).join(', ')}),`);
}
lines.push('    ]');
lines.push('}');
process.stdout.write(`${lines.join('\n')}\n`);
