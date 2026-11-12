// Golden image promotion (handlers/golden.mjs, lib/golden.mjs): the record a release manager uploads,
// the job that promotes it, and what a board reports of its golden image. Every key here is made by the
// test, in memory.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';

import { RECORD_SIZE, buildGoldenJobId, parseGoldenJobId, parseRecord, readGolden } from '../src/lib/golden.mjs';
import { parseVersion } from '../src/lib/mcuboot.mjs';
import { readReported } from '../src/lib/shadow.mjs';
import { createTestConsole } from './fake-aws.mjs';

const THING = 'cranium-fe5b26c0c5b1dcd7';
const OTHER_THING = 'cranium-0123456789abcdef';
const LOAD_ADDRESS = 0x30000;

const imageKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const imageKeyDer = imageKey.publicKey.export({ type: 'spki', format: 'der' });
const goldenKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const goldenKeyDer = goldenKey.publicKey.export({ type: 'spki', format: 'der' });
const otherKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

/** A minimal MCUboot image of the given version, signed with the image key, and its hash TLV. */
function builtImage(version, fill = 0xa5) {
  const { major, minor, revision, build } = parseVersion(version);
  const header = Buffer.alloc(0x200);
  const payload = Buffer.alloc(96, fill);
  header.writeUInt32LE(0x96f3b83d, 0);
  header.writeUInt32LE(LOAD_ADDRESS, 4);
  header.writeUInt16LE(header.length, 8);
  header.writeUInt32LE(payload.length, 12);
  header.writeUInt32LE(0x100, 16);
  header.writeUInt8(major, 20);
  header.writeUInt8(minor, 21);
  header.writeUInt16LE(revision, 22);
  header.writeUInt32LE(build, 24);
  const signed = Buffer.concat([header, payload]);
  const hash = createHash('sha256').update(signed).digest();
  const entry = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(type, 0);
    head.writeUInt16LE(data.length, 2);
    return Buffer.concat([head, data]);
  };
  const entries = Buffer.concat([
    entry(0x10, hash),
    entry(0x01, createHash('sha256').update(imageKeyDer).digest()),
    entry(0x22, sign('sha256', signed, { key: imageKey.privateKey, dsaEncoding: 'der' })),
  ]);
  const info = Buffer.alloc(4);
  info.writeUInt16LE(0x6907, 0);
  info.writeUInt16LE(info.length + entries.length, 2);
  return { image: Buffer.concat([signed, info, entries]), hash };
}

/** A promotion record, as tools/golden_promote.py sign writes it. */
function record({ version, size, hash, counter, key = goldenKey.privateKey }) {
  const { major, minor, revision, build } = parseVersion(version);
  const body = Buffer.alloc(56);
  body.write('CGLD', 0, 'ascii');
  body[4] = 1;
  body.writeUInt32LE(counter, 8);
  body.writeUInt32LE(size, 12);
  body[16] = major;
  body[17] = minor;
  body.writeUInt16LE(revision, 18);
  body.writeUInt32LE(build, 20);
  hash.copy(body, 24);
  const signature = sign('sha256', body, { key, dsaEncoding: 'der' });
  const out = Buffer.alloc(RECORD_SIZE);
  body.copy(out, 0);
  out[56] = signature.length;
  signature.copy(out, 58);
  return out;
}

function setup({ golden = true } = {}) {
  const env = { SIGNING_PUBLIC_KEY_B64: imageKeyDer.toString('base64') };
  if (golden) env.GOLDEN_PUBLIC_KEY_B64 = goldenKeyDer.toString('base64');
  const console_ = createTestConsole({ env });
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  for (const thing of [THING, OTHER_THING]) {
    console_.fake.addThing(thing);
    console_.fake.device(thing).report({ fw: { version: '1.19.2+0', confirmed: true }, uptime: 60 });
  }
  const releases = {};
  async function release(version, fill) {
    const built = builtImage(version, fill);
    const response = await console_.call('POST', '/api/firmware', {
      as: manager,
      body: { filename: 'zephyr.signed.bin', data: built.image.toString('base64') },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    releases[version] = built;
    return built;
  }
  const uploadRecord = (version, bytes, as = manager) =>
    console_.call('POST', `/api/firmware/${encodeURIComponent(version)}/golden`, {
      as,
      body: { record: bytes.toString('base64') },
    });
  const recordFor = (version, counter, extra = {}) =>
    record({ version, size: releases[version].image.length, hash: releases[version].hash, counter, ...extra });
  const promote = (version, things, as = manager) =>
    console_.call('POST', '/api/golden/promotions', { as, body: { version, things, note: 'golden' } });
  return { ...console_, manager, viewer, release, uploadRecord, recordFor, promote };
}

test('a record parses as the board reads it, and its job id names version and counter', () => {
  const built = builtImage('1.19.2+0');
  const bytes = record({ version: '1.19.2+0', size: built.image.length, hash: built.hash, counter: 3 });
  const parsed = parseRecord(bytes);
  assert.equal(parsed.version, '1.19.2+0');
  assert.equal(parsed.counter, 3);
  assert.equal(parsed.imageHash, built.hash.toString('hex'));
  assert.throws(() => parseRecord(bytes.subarray(1)), { code: 'record_size' });
  const trailing = Buffer.from(bytes);
  trailing[RECORD_SIZE - 1] = 1;
  if (trailing[56] < 72) assert.throws(() => parseRecord(trailing), { code: 'record_format' });

  const id = buildGoldenJobId('1.19.2+0', 3, Date.UTC(2026, 10, 11, 9, 0, 0), 'abcd');
  assert.equal(id, 'gold-1-19-2-b0-c3-20261111T090000Z-abcd');
  assert.deepEqual(parseGoldenJobId(id), { id, version: '1.19.2+0', counter: 3 });
  assert.equal(parseGoldenJobId('cranium-1-19-2-b0-20261111T090000Z-abcd'), null);
  const longest = buildGoldenJobId('255.255.65535+4294967295', 4294967295, Date.UTC(2026, 10, 11), 'ffff');
  assert.equal(longest.length, 64);
});

test('a board reports its golden image, and nothing else is read from it', () => {
  const golden = { version: '1.19.2+0', counter: 1, state: 'sealed' };
  assert.deepEqual(readGolden({ golden }), golden);
  assert.deepEqual(readGolden({ golden: { version: null, counter: 0, state: 'none' } }), {
    version: null,
    counter: 0,
    state: 'none',
  });
  assert.equal(readGolden({ golden: { ...golden, state: '<script>' } }), null);
  assert.equal(readGolden({ golden: { ...golden, version: 'v1' } }), null);
  assert.equal(readGolden({ golden: { ...golden, counter: -1 } }), null);
  assert.equal(readGolden({}), null);
  assert.deepEqual(readReported({ golden }).golden, golden);
  assert.equal('golden' in readReported({ fw: { version: '1.19.2+0' } }), false);
});

test('a release manager uploads a signed record for a release, once, and it goes on record', async () => {
  const { release, uploadRecord, recordFor, call, manager, viewer } = setup();
  await release('1.19.2+0');

  assert.equal((await uploadRecord('1.19.2+0', recordFor('1.19.2+0', 1), viewer)).status, 403);

  const response = await uploadRecord('1.19.2+0', recordFor('1.19.2+0', 1));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.release.golden.counter, 1);
  assert.deepEqual(response.body.release.golden.uploadedBy, { sub: manager.sub, email: manager.email });

  const again = await uploadRecord('1.19.2+0', recordFor('1.19.2+0', 2));
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'golden_record_exists');

  const listed = await call('GET', '/api/firmware', { as: viewer });
  assert.equal(listed.body.releases[0].golden.counter, 1);
  // The bytes stay with the release: the job carries them, the list never does.
  assert.equal(JSON.stringify(listed.body).includes('record'), false);

  const audit = await call('GET', '/api/audit', { as: manager });
  const entry = audit.body.entries.find((item) => item.action === 'firmware.golden_record' && item.outcome === 'ok');
  assert.ok(entry, JSON.stringify(audit.body.entries.map((item) => item.action)));
  assert.equal(entry.target, '1.19.2+0');
});

test('a record is refused unless the golden key signed it for this very release', async () => {
  const { release, uploadRecord, recordFor } = setup();
  const built = await release('1.19.2+0');
  await release('1.19.3+0', 0x5a);

  const cases = [
    ['another key', recordFor('1.19.2+0', 1, { key: otherKey.privateKey }), 422, 'bad_signature'],
    ['the image key', recordFor('1.19.2+0', 1, { key: imageKey.privateKey }), 422, 'bad_signature'],
    ['another release', recordFor('1.19.3+0', 1), 422, 'record_mismatch'],
    [
      'another size',
      record({ version: '1.19.2+0', size: built.image.length + 1, hash: built.hash, counter: 1 }),
      422,
      'record_mismatch',
    ],
    ['too short', recordFor('1.19.2+0', 1).subarray(0, 100), 422, 'invalid_record'],
  ];
  for (const [name, bytes, status, code] of cases) {
    const response = await uploadRecord('1.19.2+0', bytes);
    assert.equal(response.status, status, name);
    assert.equal(response.body.error.code, code, name);
  }
  // A changed counter breaks the signature.
  const changed = recordFor('1.19.2+0', 1);
  changed[8] = 2;
  assert.equal((await uploadRecord('1.19.2+0', changed)).body.error.code, 'bad_signature');
});

test('counters only go up across releases, as they do on a board', async () => {
  const { release, uploadRecord, recordFor } = setup();
  await release('1.19.2+0');
  await release('1.19.3+0', 0x5a);
  assert.equal((await uploadRecord('1.19.3+0', recordFor('1.19.3+0', 5))).status, 201);
  const lower = await uploadRecord('1.19.2+0', recordFor('1.19.2+0', 5));
  assert.equal(lower.status, 409);
  assert.equal(lower.body.error.code, 'counter_not_higher');
  assert.equal((await uploadRecord('1.19.2+0', recordFor('1.19.2+0', 6))).status, 201);
});

test('without a golden key the console takes no record and starts no promotion', async () => {
  const { release, uploadRecord, recordFor, promote, call, viewer } = setup({ golden: false });
  await release('1.19.2+0');
  const response = await uploadRecord('1.19.2+0', recordFor('1.19.2+0', 1));
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'golden_key_missing');
  assert.equal((await promote('1.19.2+0', [THING])).body.error.code, 'golden_key_missing');
  const listed = await call('GET', '/api/golden/promotions', { as: viewer });
  assert.equal(listed.body.goldenKey.present, false);
});

test('a promotion is one job with the record, to the chosen boards, and shows in the list', async () => {
  const { release, uploadRecord, recordFor, promote, call, fake, viewer, manager } = setup();
  await release('1.19.2+0');
  const bytes = recordFor('1.19.2+0', 1);

  const early = await promote('1.19.2+0', [THING]);
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'no_golden_record');

  assert.equal((await uploadRecord('1.19.2+0', bytes)).status, 201);
  assert.equal((await promote('1.19.2+0', [THING], viewer)).status, 403);

  const response = await promote('1.19.2+0', [THING, OTHER_THING]);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const { promotion } = response.body;
  assert.match(promotion.id, /^gold-1-19-2-b0-c1-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
  assert.equal(promotion.version, '1.19.2+0');
  assert.equal(promotion.counter, 1);
  assert.deepEqual(promotion.things, [OTHER_THING, THING].sort());

  const job = fake.device(THING).nextJob();
  assert.equal(job.jobId, promotion.id);
  assert.deepEqual(job.document, { op: 'golden_promote', v: 1, record: bytes.toString('hex') });
  // The board's buffer for a document is 512 bytes.
  assert.ok(JSON.stringify(job.document).length < 512);

  // A promotion is not a deployment, and a board at work on it takes no other job.
  const deployments = await call('GET', '/api/deployments', { as: viewer });
  assert.equal(
    deployments.body.deployments.some((item) => item.id === promotion.id),
    false
  );
  const busy = await promote('1.19.2+0', [THING]);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, 'device_busy');

  const listed = await call('GET', '/api/golden/promotions', { as: viewer });
  assert.equal(listed.body.goldenKey.present, true);
  assert.equal(listed.body.promotions[0].id, promotion.id);

  const audit = await call('GET', '/api/audit', { as: manager });
  const entry = audit.body.entries.find((item) => item.action === 'golden.promote' && item.outcome === 'ok');
  assert.ok(entry);
  assert.equal(entry.target, promotion.id);
});

test('a promotion goes to registered boards only, and never of a revoked release', async () => {
  const { release, uploadRecord, recordFor, promote, call, manager } = setup();
  await release('1.19.2+0');
  await uploadRecord('1.19.2+0', recordFor('1.19.2+0', 1));
  const stranger = await promote('1.19.2+0', ['cranium-aaaaaaaaaaaaaaaa']);
  assert.equal(stranger.status, 422);
  assert.equal(stranger.body.error.code, 'unknown_device');

  const revoked = await call('POST', `/api/firmware/${encodeURIComponent('1.19.2+0')}/revoke`, {
    as: manager,
    body: { reason: 'bad build' },
  });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  const response = await promote('1.19.2+0', [THING]);
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'release_revoked');
});

test("a board's golden image is on its page and in the list of boards", async () => {
  const { fake, call, viewer } = setup();
  fake.device(THING).report({ golden: { version: '1.19.2+0', counter: 1, state: 'sealed' } });
  const one = await call('GET', `/api/devices/${THING}`, { as: viewer });
  assert.deepEqual(one.body.device.golden, { version: '1.19.2+0', counter: 1, state: 'sealed' });
  const all = await call('GET', '/api/devices', { as: viewer });
  const listed = all.body.devices.find((device) => device.thing === THING);
  assert.deepEqual(listed.golden, { version: '1.19.2+0', counter: 1, state: 'sealed' });
});
