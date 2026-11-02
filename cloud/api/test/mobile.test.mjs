// Tests for the two calls the phone apps make for an update over Bluetooth
// (docs/mobile-apps.md): the signed image of a release, and the passkey of the board a
// phone is pairing with. Both are for release managers only, and both go on record.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { objectKey } from '../src/handlers/firmware.mjs';
import { PAIRING_FRESH_MS, deviceFromShadow, pairingFromShadow } from '../src/lib/shadow.mjs';
import { accessClaims, createTestConsole, fixture } from './fake-aws.mjs';

const THING = 'cranium-fe5b26c0c5b1dcd7';
const OTHER_THING = 'cranium-0123456789abcdef';
const VERSION = '1.2.3+4';
const IMAGE = fixture('valid-1.2.3+4.signed.bin');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function setup() {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  const upload = () => console_.call('POST', '/api/firmware', {
    as: manager, body: { filename: 'zephyr.signed.bin', data: IMAGE.toString('base64'), notes: '' },
  });
  return { ...console_, manager, viewer, upload };
}

const imagePath = (version) => `/api/firmware/${encodeURIComponent(version)}/image`;

test('a release manager gets the signed image of an active release, byte for byte', async () => {
  const { call, manager, upload, fake } = setup();
  assert.equal((await upload()).status, 201);
  const before = fake.auditLog().length;

  const response = await call('GET', imagePath(VERSION), { as: manager });
  assert.equal(response.status, 200);
  assert.ok(Buffer.isBuffer(response.body));
  assert.equal(sha256(response.body), sha256(IMAGE));
  assert.equal(response.headers['content-type'], 'application/octet-stream');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['content-disposition'], 'attachment; filename="zephyr.signed.bin"');

  const added = fake.auditLog().slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].action, 'firmware.download');
  assert.equal(added[0].outcome, 'ok');
  assert.equal(added[0].target, VERSION);
  assert.equal(added[0].detail.sha256, sha256(IMAGE));
});

test('a token from the phone apps\' client counts like one from the console', async () => {
  const { call, manager, upload } = setup();
  await upload();
  const claims = accessClaims({ sub: manager.sub, groups: ['release-managers'], clientId: 'localmobile' });
  assert.equal((await call('GET', imagePath(VERSION), { claims })).status, 200);
  assert.equal((await call('GET', '/api/firmware', { claims })).status, 200);

  const stranger = accessClaims({ sub: manager.sub, groups: ['release-managers'], clientId: 'someoneelse' });
  assert.equal((await call('GET', imagePath(VERSION), { claims: stranger })).status, 401);
  assert.equal((await call('GET', '/api/firmware', { claims: stranger })).status, 401);
});

test('a viewer cannot download an image, and the refusal goes on record', async () => {
  const { call, viewer, upload, fake } = setup();
  await upload();
  const before = fake.auditLog().length;
  const response = await call('GET', imagePath(VERSION), { as: viewer });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'release_manager_required');
  const added = fake.auditLog().slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].outcome, 'denied');
});

test('an unknown, revoked or unreadable image is not handed out', async () => {
  const context = setup();
  const { call, manager, upload, fake } = context;
  assert.equal((await call('GET', imagePath('9.9.9+9'), { as: manager })).status, 404);
  assert.equal((await call('GET', '/api/firmware/not-a-version/image', { as: manager })).status, 400);

  await upload();
  const revoked = await call('POST', `/api/firmware/${encodeURIComponent(VERSION)}/revoke`, {
    as: manager, body: { reason: 'bricks the encoder' },
  });
  assert.equal(revoked.status, 200);
  const response = await call('GET', imagePath(VERSION), { as: manager });
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'unknown_version');

  // The bucket's own refusal is the last line, should the record still say active.
  assert.equal(await fake.getFirmwareObject(objectKey(sha256(IMAGE))), null);
});

test('an image whose stored bytes differ from the release is refused, not sent', async () => {
  const { call, manager, upload, fake } = setup();
  await upload();
  const original = fake.getFirmwareObject.bind(fake);
  fake.getFirmwareObject = async (key) => {
    const data = await original(key);
    data[data.length - 1] ^= 0x01;
    return data;
  };
  const response = await call('GET', imagePath(VERSION), { as: manager });
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'image_mismatch');
});

/** A shadow with a pairing reported `ageMs` ago, in the form AWS IoT keeps it. */
function shadowWithPairing(nowMs, ageMs, pair = { name: 'Cranium-1A2B', passkey: '012345' }) {
  const stamp = Math.floor((nowMs - ageMs) / 1000);
  return {
    state: { reported: { btpair: pair, uptime: 10 } },
    metadata: { reported: { btpair: { name: { timestamp: stamp }, passkey: { timestamp: stamp } } } },
  };
}

test('a fresh, well-formed pairing is read from a shadow, and nothing else is', () => {
  const now = Date.parse('2026-11-02T18:00:00Z');
  assert.deepEqual(pairingFromShadow(shadowWithPairing(now, 10_000), now), {
    name: 'Cranium-1A2B', passkey: '012345', reportedAt: '2026-11-02T17:59:50.000Z',
  });
  assert.equal(pairingFromShadow(shadowWithPairing(now, PAIRING_FRESH_MS + 1000), now), null);
  assert.equal(pairingFromShadow(shadowWithPairing(now, -60_000), now), null);
  for (const pair of [
    { name: 'Cranium-1a2b', passkey: '012345' },
    { name: 'Other-1A2B', passkey: '012345' },
    { name: 'Cranium-1A2B', passkey: '12345' },
    { name: 'Cranium-1A2B', passkey: 12345 },
    { name: 'Cranium-1A2B' },
    null,
  ]) {
    assert.equal(pairingFromShadow(shadowWithPairing(now, 1000, pair), now), null, JSON.stringify(pair));
  }
  assert.equal(pairingFromShadow(null, now), null);
  assert.equal(pairingFromShadow({ state: { reported: {} } }, now), null);
});

test('a release manager gets the passkey of the board that is pairing, on record', async () => {
  const { call, manager, fake, clock } = setup();
  fake.addThing(THING);
  fake.addThing(OTHER_THING);
  fake.device(OTHER_THING).setRaw(shadowWithPairing(clock.ms, 5000, { name: 'Cranium-FFFF', passkey: '999999' }));
  fake.device(THING).setRaw(shadowWithPairing(clock.ms, 5000));
  const before = fake.auditLog().length;

  const response = await call('GET', '/api/pairing/Cranium-1A2B', { as: manager });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    thing: THING, name: 'Cranium-1A2B', passkey: '012345',
    reportedAt: new Date(Math.floor((clock.ms - 5000) / 1000) * 1000).toISOString(),
  });
  const added = fake.auditLog().slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].action, 'pairing.read');
  assert.equal(added[0].target, 'Cranium-1A2B');
  assert.equal(added[0].detail.thing, THING);
  // The passkey itself is never written to the log.
  assert.equal(JSON.stringify(added[0]).includes('012345'), false);
});

test('no passkey for a viewer, a stale report, an unknown name or a malformed one', async () => {
  const { call, manager, viewer, fake, clock } = setup();
  fake.addThing(THING);
  fake.device(THING).setRaw(shadowWithPairing(clock.ms, 5000));

  const refusedBefore = fake.auditLog().length;
  const refused = await call('GET', '/api/pairing/Cranium-1A2B', { as: viewer });
  assert.equal(refused.status, 403);
  // A refusal is always on record.
  assert.equal(fake.auditLog().length, refusedBefore + 1);
  assert.equal(fake.auditLog().at(-1).outcome, 'denied');

  const before = fake.auditLog().length;
  assert.equal((await call('GET', '/api/pairing/Cranium-0000', { as: manager })).status, 404);
  // A phone asks again every few seconds until there is one: "none yet" is not put on record.
  assert.equal(fake.auditLog().length, before);
  const bad = await call('GET', '/api/pairing/cranium-1a2b', { as: manager });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_name');

  fake.device(THING).setRaw(shadowWithPairing(clock.ms, PAIRING_FRESH_MS + 1000));
  const stale = await call('GET', '/api/pairing/Cranium-1A2B', { as: manager });
  assert.equal(stale.status, 404);
  assert.equal(stale.body.error.code, 'no_pairing');
});

test('a board outside the project\'s group is never asked', async () => {
  const { call, manager, fake, clock } = setup();
  fake.addThing(THING, { inGroup: false });
  fake.device(THING).setRaw(shadowWithPairing(clock.ms, 5000));
  assert.equal((await call('GET', '/api/pairing/Cranium-1A2B', { as: manager })).status, 404);
});

test('a board with its Bluetooth window open says so, and the console passes it on', () => {
  const now = Date.parse('2026-11-02T18:00:00Z');
  const stamp = Math.floor(now / 1000) - 5;
  const device = deviceFromShadow(THING, {
    state: { reported: { ota: { state: 'bluetooth', job: null, progress: 0, last: 'none', error: '' }, uptime: 9 } },
    metadata: { reported: { uptime: { timestamp: stamp } } },
  }, now);
  assert.equal(device.ota.state, 'bluetooth');
  assert.equal(device.online, true);
});
