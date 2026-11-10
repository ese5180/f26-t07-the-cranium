// Tests for the calls the phone apps make for an update over Bluetooth
// (docs/mobile-apps.md): the signed image of a release, the passkey of the board a phone is
// pairing with, and the check right before every send. All three are for release managers
// only, and all three go on record. And for what a phone app's sign-in may reach: those
// calls and a few reads, nothing else.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  const upload = () =>
    console_.call('POST', '/api/firmware', {
      as: manager,
      body: { filename: 'zephyr.signed.bin', data: IMAGE.toString('base64'), notes: '' },
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

test("a token from the phone apps' client counts like one from the console, where the apps call", async () => {
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
    as: manager,
    body: { reason: 'bricks the encoder' },
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
    name: 'Cranium-1A2B',
    passkey: '012345',
    reportedAt: '2026-11-02T17:59:50.000Z',
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
    thing: THING,
    name: 'Cranium-1A2B',
    passkey: '012345',
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

test("a board outside the project's group is never asked", async () => {
  const { call, manager, fake, clock } = setup();
  fake.addThing(THING, { inGroup: false });
  fake.device(THING).setRaw(shadowWithPairing(clock.ms, 5000));
  assert.equal((await call('GET', '/api/pairing/Cranium-1A2B', { as: manager })).status, 404);
});

test('a board with its Bluetooth window open says so, and the console passes it on', () => {
  const now = Date.parse('2026-11-02T18:00:00Z');
  const stamp = Math.floor(now / 1000) - 5;
  const device = deviceFromShadow(
    THING,
    {
      state: { reported: { ota: { state: 'bluetooth', job: null, progress: 0, last: 'none', error: '' }, uptime: 9 } },
      metadata: { reported: { uptime: { timestamp: stamp } } },
    },
    now
  );
  assert.equal(device.ota.state, 'bluetooth');
  assert.equal(device.online, true);
});

// What a phone app's sign-in reaches (app.mjs, "The phone apps").

const PHONE_CLIENT = 'localmobile';
const V = encodeURIComponent(VERSION);
const SOME_DEPLOYMENT = 'cranium-1-2-3-b4-20261102T180000Z-abcd';
const CUSTOMER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
// The second account of setup(): the viewer.
const VIEWER = '00000000-0000-4000-8000-000000000002';

/**
 * Every route of the API, with a request that a release manager of the console may make in
 * the world below, what the console's own session gets for it, and whether a phone app's
 * session may make it. `body` is a function where it must be made afresh for each call.
 */
const ROUTES = [
  { route: 'GET /api/me', status: 200, phone: true },
  { route: 'GET /api/devices', status: 200, phone: true },
  { route: 'GET /api/devices/{thing}', path: `/api/devices/${THING}`, status: 200, phone: true },
  { route: 'GET /api/devices/{thing}/samples', path: `/api/devices/${THING}/samples`, status: 200, phone: true },
  { route: 'GET /api/devices/{thing}/timeline', path: `/api/devices/${THING}/timeline`, status: 200, phone: true },
  // What Memfault knows (handlers/memfault.mjs): read-only, and with no Memfault token here it says so in a 200.
  { route: 'GET /api/devices/{thing}/memfault', path: `/api/devices/${THING}/memfault`, status: 200, phone: true },
  { route: 'GET /api/memfault/fleet', status: 200, phone: true },
  { route: 'GET /api/memfault/issues', status: 200, phone: true },
  { route: 'GET /api/memfault/issues/{id}', path: '/api/memfault/issues/7', status: 200, phone: true },
  { route: 'GET /api/events', status: 200, phone: true },
  { route: 'GET /api/events/log', status: 200, phone: true },
  { route: 'GET /api/firmware', status: 200, phone: true },
  {
    route: 'POST /api/firmware',
    status: 201,
    phone: true,
    body: () => ({
      filename: 'zephyr.signed.bin',
      data: fixture('valid-1.2.3+5.signed.bin').toString('base64'),
      notes: '',
    }),
  },
  { route: 'GET /api/firmware/{version}', path: `/api/firmware/${V}`, status: 200, phone: true },
  { route: 'GET /api/firmware/{version}/image', path: `/api/firmware/${V}/image`, status: 200, phone: true },
  { route: 'GET /api/pairing/{name}', path: '/api/pairing/Cranium-1A2B', status: 200, phone: true },
  {
    route: 'POST /api/firmware/{version}/revoke',
    path: `/api/firmware/${V}/revoke`,
    status: 200,
    phone: true,
    body: { reason: 'bricks the encoder' },
  },
  {
    route: 'POST /api/firmware/{version}/bluetooth',
    path: `/api/firmware/${V}/bluetooth`,
    status: 200,
    phone: true,
    body: { sha256: sha256(IMAGE), board: 'Cranium-1A2B' },
  },
  { route: 'GET /api/deployments', status: 200, phone: true },
  // Every update however it came (handlers/updates.mjs): the apps' Overview and a board's Updates.
  { route: 'GET /api/updates', status: 200, phone: true },
  { route: 'POST /api/deployments', status: 201, phone: true, body: { version: VERSION, things: [THING] } },
  // No such deployment: the console's session gets as far as looking for it.
  { route: 'GET /api/deployments/{id}', path: `/api/deployments/${SOME_DEPLOYMENT}`, status: 404, phone: true },
  {
    route: 'POST /api/deployments/{id}/cancel',
    path: `/api/deployments/${SOME_DEPLOYMENT}/cancel`,
    status: 404,
    phone: true,
    body: {},
  },
  { route: 'GET /api/audit', status: 200, phone: true },
  { route: 'GET /api/tokens', status: 200, phone: true },
  { route: 'POST /api/tokens', status: 201, phone: true, body: { name: 'laptop' } },
  {
    route: 'POST /api/tokens/{id}/revoke',
    path: '/api/tokens/0123456789abcdef/revoke',
    status: 404,
    phone: true,
    body: {},
  },
  {
    route: 'POST /api/serial/commands',
    status: 201,
    phone: true,
    body: { command: 'WIFI', device: 'CRVIHAAN01', version: '1.12.0+0' },
  },
  // The map, commands and alerts (docs/fleet.md).
  { route: 'GET /api/devices/{thing}/positions', path: `/api/devices/${THING}/positions`, status: 200, phone: true },
  {
    route: 'POST /api/devices/{thing}/commands',
    path: `/api/devices/${THING}/commands`,
    status: 202,
    phone: true,
    body: { cmd: 'identify' },
  },
  // Provisioning through the console: a release manager's, on the website, with a token, or with the apps'
  // sign-in, which the desktop app's Board setup uses.
  {
    route: 'POST /api/devices/register',
    status: 200,
    phone: true,
    body: { id: '00000000000000aa', board: 'nrf5340dk' },
  },
  // Board setup's Wi-Fi defaults: none stored in this world.
  { route: 'GET /api/setup/wifi-defaults', status: 200, phone: true },
  { route: 'GET /api/alerts', status: 200, phone: true },
  { route: 'POST /api/alerts/subscribe', status: 202, phone: true, body: {} },
  // Nobody has subscribed in this world: the console's session gets as far as looking.
  { route: 'POST /api/alerts/unsubscribe', status: 404, phone: true, body: {} },
  // The alert rules: a change that holds, for release managers.
  { route: 'POST /api/alerts/rules', status: 200, phone: true, body: { rules: { voltage: { on: false } } } },
  // The weekly fleet report (docs/reports.md): a week before this world's clock, its CSV, and the e-mail.
  { route: 'GET /api/reports', status: 200, phone: true },
  { route: 'GET /api/reports/{week}', path: '/api/reports/2026-09-28', status: 200, phone: true },
  {
    route: 'GET /api/reports/{week}/export',
    path: '/api/reports/2026-09-28/export',
    status: 200,
    phone: true,
  },
  { route: 'POST /api/reports/settings', status: 200, phone: true, body: { email: true } },
  // Board types, groups and staged rollouts (docs/fleet.md). No group or rollout exists in this world:
  // the console's session gets as far as looking for one.
  { route: 'GET /api/fleet', status: 200, phone: true },
  { route: 'GET /api/fleet/health', status: 200, phone: true },
  { route: 'GET /api/groups', status: 200, phone: true },
  { route: 'POST /api/groups', status: 201, phone: true, body: { name: 'Bench', things: [THING] } },
  {
    route: 'POST /api/groups/{id}',
    path: '/api/groups/grp-0a0b0c0d',
    status: 404,
    phone: true,
    body: { name: 'Desk' },
  },
  {
    route: 'POST /api/groups/{id}/delete',
    path: '/api/groups/grp-0a0b0c0d/delete',
    status: 404,
    phone: true,
    body: {},
  },
  { route: 'GET /api/groups/{id}/rollback', path: '/api/groups/grp-0a0b0c0d/rollback', status: 404, phone: true },
  {
    route: 'POST /api/groups/{id}/rollback',
    path: '/api/groups/grp-0a0b0c0d/rollback',
    status: 404,
    phone: true,
    body: {},
  },
  // Roll back to last good (console 2.14.0): the fleet's plan, and a start that names no release.
  { route: 'GET /api/fleet/last-good', status: 200, phone: true },
  { route: 'POST /api/fleet/last-good', status: 400, phone: true, body: {} },
  { route: 'GET /api/groups/{id}/last-good', path: '/api/groups/grp-0a0b0c0d/last-good', status: 404, phone: true },
  {
    route: 'POST /api/groups/{id}/last-good',
    path: '/api/groups/grp-0a0b0c0d/last-good',
    status: 404,
    phone: true,
    body: {},
  },
  { route: 'GET /api/rollouts', status: 200, phone: true },
  {
    route: 'POST /api/rollouts',
    status: 201,
    phone: true,
    body: { version: VERSION, target: { kind: 'boards', things: [THING] } },
  },
  { route: 'GET /api/rollouts/suggest', status: 400, phone: true },
  { route: 'GET /api/rollouts/{id}', path: '/api/rollouts/rol-20261102T180000Z-abcdef', status: 404, phone: true },
  {
    route: 'POST /api/rollouts/{id}/cancel',
    path: '/api/rollouts/rol-20261102T180000Z-abcdef/cancel',
    status: 404,
    phone: true,
    body: {},
  },
  { route: 'GET /api/fleet/update-everything', status: 200, phone: true },
  // The board has never reported, so the plan leaves it out: asked for all the same, it is refused.
  {
    route: 'POST /api/fleet/update-everything',
    status: 409,
    phone: true,
    body: { types: [{ type: 'nrf7002dk', version: VERSION, things: [THING] }] },
  },
  {
    route: 'POST /api/devices/{thing}/seen',
    path: `/api/devices/${THING}/seen`,
    status: 201,
    phone: true,
    body: { version: VERSION, name: 'Cranium-1A2B' },
  },
  {
    route: 'PUT /api/firmware/{version}/notes',
    path: `/api/firmware/${V}/notes`,
    status: 200,
    phone: true,
    body: { notes: 'Reconnects faster after the Wi-Fi drops out.' },
  },
  // The phone apps on the Apps page (docs/mobile-apps.md). No Android app is published in this world, and
  // no APK has arrived: the console's session gets a URL to send one to, and then as far as looking for it.
  { route: 'GET /api/apps', status: 200, phone: true },
  { route: 'GET /api/apps/config', status: 200, phone: true },
  {
    route: 'POST /api/apps/android/uploads',
    status: 201,
    phone: true,
    body: { version: '0.4.0', versionCode: 4, sha256: 'a'.repeat(64), size: 4096, notes: '' },
  },
  {
    route: 'POST /api/apps/android/releases/{version}',
    path: '/api/apps/android/releases/0.4.0',
    status: 409,
    phone: true,
    body: { versionCode: 4, sha256: 'a'.repeat(64), size: 4096 },
  },
  {
    route: 'GET /api/apps/android/{version}/download',
    path: '/api/apps/android/0.4.0/download',
    status: 404,
    phone: true,
  },
  // The iPhone app's IPAs, the same way; and a member's SideStore link, on the website alone (sidestore.test.mjs).
  {
    route: 'POST /api/apps/ios/uploads',
    status: 201,
    phone: true,
    body: { version: '0.6.0', buildVersion: '8', sha256: 'a'.repeat(64), size: 4096, notes: '' },
  },
  {
    route: 'POST /api/apps/ios/releases/{version}',
    path: '/api/apps/ios/releases/0.6.0',
    status: 409,
    phone: true,
    body: { buildVersion: '8', sha256: 'a'.repeat(64), size: 4096 },
  },
  { route: 'GET /api/apps/ios/{version}/download', path: '/api/apps/ios/0.6.0/download', status: 404, phone: true },
  { route: 'GET /api/apps/sidestore', status: 200, phone: false },
  { route: 'POST /api/apps/sidestore', status: 201, phone: false, body: {} },
  { route: 'POST /api/apps/sidestore/revoke', status: 404, phone: false, body: {} },
  // The customer site's Customers page: the website's alone. This console has no customer pool,
  // so a release manager is told so (customers.test.mjs has them with one).
  { route: 'GET /api/customers', status: 200, phone: false },
  { route: 'POST /api/customers', status: 409, phone: false, body: { email: 'dee@example.invalid' } },
  {
    route: 'POST /api/customers/{id}/resend',
    path: `/api/customers/${CUSTOMER}/resend`,
    status: 409,
    phone: false,
    body: {},
  },
  {
    route: 'POST /api/customers/{id}/boards',
    path: `/api/customers/${CUSTOMER}/boards`,
    status: 409,
    phone: false,
    body: { thing: THING },
  },
  {
    route: 'POST /api/customers/{id}/boards/{thing}/remove',
    path: `/api/customers/${CUSTOMER}/boards/${THING}/remove`,
    status: 409,
    phone: false,
    body: {},
  },
  {
    route: 'POST /api/customers/{id}/disable',
    path: `/api/customers/${CUSTOMER}/disable`,
    status: 409,
    phone: false,
    body: {},
  },
  {
    route: 'POST /api/customers/{id}/enable',
    path: `/api/customers/${CUSTOMER}/enable`,
    status: 409,
    phone: false,
    body: {},
  },
  {
    route: 'POST /api/customers/{id}/reset-password',
    path: `/api/customers/${CUSTOMER}/reset-password`,
    status: 409,
    phone: false,
    body: {},
  },
  {
    route: 'POST /api/customers/{id}/remove',
    path: `/api/customers/${CUSTOMER}/remove`,
    status: 409,
    phone: false,
    body: {},
  },
  // The Team page (team.test.mjs): the website's alone, like the customers. The viewer of the world below is
  // the account changed.
  { route: 'GET /api/team', status: 200, phone: false },
  { route: 'POST /api/team', status: 201, phone: false, body: { email: 'dee@example.invalid', tier: 'viewer' } },
  {
    route: 'POST /api/team/{id}/resend',
    path: `/api/team/${VIEWER}/resend`,
    status: 409,
    phone: false,
    body: {},
  },
  {
    route: 'POST /api/team/{id}/tier',
    path: `/api/team/${VIEWER}/tier`,
    status: 200,
    phone: false,
    body: { tier: 'release-manager' },
  },
  {
    route: 'POST /api/team/{id}/disable',
    path: `/api/team/${VIEWER}/disable`,
    status: 200,
    phone: false,
    body: {},
  },
  {
    route: 'POST /api/team/{id}/enable',
    path: `/api/team/${VIEWER}/enable`,
    status: 200,
    phone: false,
    body: {},
  },
  {
    route: 'POST /api/team/{id}/reset',
    path: `/api/team/${VIEWER}/reset`,
    status: 200,
    phone: false,
    body: {},
  },
  {
    route: 'POST /api/team/{id}/remove',
    path: `/api/team/${VIEWER}/remove`,
    status: 200,
    phone: false,
    body: {},
  },
  // The Database page (db.test.mjs): the apps' pages read it as the website does.
  { route: 'GET /api/db/tables', status: 200, phone: true },
  { route: 'GET /api/db/{table}', path: '/api/db/state', status: 200, phone: true },
  { route: 'GET /api/db/{table}/item', path: '/api/db/state/item', status: 400, phone: true },
  { route: 'GET /api/db/{table}/export', path: '/api/db/state/export', status: 400, phone: true },
];

/** A console with a release, and a board online that is pairing as Cranium-1A2B. */
async function world() {
  const context = setup();
  context.fake.addThing(THING);
  context.fake.device(THING).setRaw(shadowWithPairing(context.clock.ms, 5000));
  assert.equal((await context.upload()).status, 201);
  // Signed in on the phone just now: a phone's deployment needs a recent sign-in.
  const phone = accessClaims({
    sub: context.manager.sub,
    groups: ['release-managers'],
    clientId: PHONE_CLIENT,
    authTime: Math.floor(context.clock.ms / 1000),
  });
  return { ...context, phone };
}

/** An answer without request ids, which differ from one request to the next, at any depth. */
function withoutRequestId(value) {
  if (Array.isArray(value)) return value.map(withoutRequestId);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'requestId')
      .map(([key, inner]) => [key, withoutRequestId(inner)])
  );
}

function requestOf(entry) {
  const [method, pattern] = entry.route.split(' ');
  const body = typeof entry.body === 'function' ? entry.body() : entry.body;
  return { method, path: entry.path ?? pattern, body };
}

/** What state a refused request must leave alone: releases, tokens, deployments. */
function snapshot(fake) {
  return JSON.stringify([
    [...fake.releases.entries()],
    [...fake.tokens.entries()],
    fake.calls.filter((call) =>
      [
        'createJob',
        'cancelJob',
        'putFirmwareObject',
        'registerRelease',
        'markReleaseRevoked',
        'tagFirmwareRevoked',
        'putToken',
        'markTokenRevoked',
      ].includes(call.method)
    ).length,
  ]);
}

test('the table below names every route of the API', () => {
  const source = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const declared = [...source.matchAll(/\broute\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    ([, method, path]) => `${method} ${path}`
  );
  assert.ok(declared.length > 15, `found ${declared.length} routes`);
  assert.deepEqual(ROUTES.map((entry) => entry.route).sort(), [...declared].sort());
});

test("every route takes the console's session; a phone app's only where the apps call", async () => {
  for (const entry of ROUTES) {
    const { method, path, body } = requestOf(entry);

    const ours = await world();
    const console_ = await ours.call(method, path, { as: ours.manager, body });
    assert.equal(
      console_.status,
      entry.status,
      `${entry.route} with the console's session: ${JSON.stringify(console_.body)}`
    );

    const theirs = await world();
    const before = theirs.fake.auditLog().length;
    const untouched = snapshot(theirs.fake);
    const phone = await theirs.call(method, path, { claims: theirs.phone, body: requestOf(entry).body });
    if (entry.phone) {
      // The same answer as the console's session gets, to the byte.
      assert.equal(phone.status, entry.status, `${entry.route} with a phone app's session`);
      if (Buffer.isBuffer(console_.body)) assert.ok(console_.body.equals(phone.body), entry.route);
      else if (entry.route === 'POST /api/tokens') assert.equal(typeof phone.body.token, 'string', entry.route);
      else assert.deepEqual(withoutRequestId(phone.body), withoutRequestId(console_.body), entry.route);
      continue;
    }
    assert.deepEqual(
      [phone.status, phone.body.error?.code],
      [403, 'phone_not_allowed'],
      `${entry.route} with a phone app's session`
    );
    assert.match(phone.body.error.message, /Sign in to the console instead\./);
    assert.equal(snapshot(theirs.fake), untouched, `${entry.route}: nothing changed`);
    // A write that is refused is on record, as every write is; a read is not.
    const added = theirs.fake.auditLog().slice(before);
    if (method === 'POST') {
      assert.equal(added.length, 1, entry.route);
      assert.deepEqual(
        [added[0].outcome, added[0].actor.sub, added[0].detail.code],
        ['denied', theirs.manager.sub, 'phone_not_allowed'],
        entry.route
      );
    } else {
      assert.equal(added.length, 0, entry.route);
    }
  }
});

test("a phone app's session reaches no address the API does not have, and still needs a member", async () => {
  const { call, phone, viewer } = await world();
  const nowhere = await call('GET', '/api/nowhere', { claims: phone });
  assert.deepEqual([nowhere.status, nowhere.body.error.code], [403, 'phone_not_allowed']);
  // On a route the apps call, everything else still applies: a viewer reads, and cannot download.
  const viewers = accessClaims({ sub: viewer.sub, groups: ['viewers'], clientId: PHONE_CLIENT });
  assert.equal((await call('GET', '/api/firmware', { claims: viewers })).status, 200);
  const image = await call('GET', imagePath(VERSION), { claims: viewers });
  assert.deepEqual([image.status, image.body.error.code], [403, 'release_manager_required']);
  const nobody = accessClaims({ sub: viewer.sub, groups: [], clientId: PHONE_CLIENT });
  const outsider = await call('GET', '/api/firmware', { claims: nobody });
  assert.deepEqual([outsider.status, outsider.body.error.code], [403, 'forbidden']);
});

// POST /api/firmware/{version}/bluetooth: the check before every Bluetooth send.

const sendPath = (version) => `/api/firmware/${encodeURIComponent(version)}/bluetooth`;

test('an active release with the same SHA-256 may be sent, and the check is on record', async () => {
  const { call, manager, upload, fake } = setup();
  await upload();
  const before = fake.auditLog().length;
  const response = await call('POST', sendPath(VERSION), {
    as: manager,
    body: { sha256: sha256(IMAGE), board: 'Cranium-1A2B' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { version: VERSION, sha256: sha256(IMAGE), status: 'active' });

  // Without the board's name, too.
  const bare = await call('POST', sendPath(VERSION), { as: manager, body: { sha256: sha256(IMAGE) } });
  assert.deepEqual(bare.body, response.body);

  const added = fake.auditLog().slice(before);
  assert.deepEqual(
    added.map((entry) => [entry.action, entry.outcome, entry.target, entry.actor.sub]),
    [
      ['firmware.bluetooth_send', 'ok', VERSION, manager.sub],
      ['firmware.bluetooth_send', 'ok', VERSION, manager.sub],
    ]
  );
  assert.deepEqual(added[0].detail, { sha256: sha256(IMAGE), board: 'Cranium-1A2B' });
  assert.deepEqual(added[1].detail, { sha256: sha256(IMAGE) });
  // It changes nothing: the release is as it was.
  assert.equal(
    (await call('GET', `/api/firmware/${encodeURIComponent(VERSION)}`, { as: manager })).body.release.status,
    'active'
  );
});

test('a revoked release, another image or an unknown version may not be sent, on record', async () => {
  const { call, manager, upload, fake } = setup();
  await upload();
  const other = 'f'.repeat(64);
  const before = fake.auditLog().length;

  const mismatch = await call('POST', sendPath(VERSION), {
    as: manager,
    body: { sha256: other, board: 'Cranium-1A2B' },
  });
  assert.deepEqual([mismatch.status, mismatch.body.error.code], [409, 'sha256_mismatch']);
  const unknown = await call('POST', sendPath('9.9.9+9'), { as: manager, body: { sha256: sha256(IMAGE) } });
  assert.deepEqual([unknown.status, unknown.body.error.code], [404, 'unknown_version']);

  const revoked = await call('POST', `/api/firmware/${encodeURIComponent(VERSION)}/revoke`, {
    as: manager,
    body: { reason: 'bricks the encoder' },
  });
  assert.equal(revoked.status, 200);
  const refused = await call('POST', sendPath(VERSION), { as: manager, body: { sha256: sha256(IMAGE) } });
  assert.deepEqual([refused.status, refused.body.error.code], [409, 'release_revoked']);

  const added = fake
    .auditLog()
    .slice(before)
    .filter((entry) => entry.action === 'firmware.bluetooth_send');
  assert.deepEqual(
    added.map((entry) => [entry.outcome, entry.target, entry.detail.code, entry.detail.sha256]),
    [
      ['rejected', VERSION, 'sha256_mismatch', other],
      ['rejected', '9.9.9+9', 'unknown_version', sha256(IMAGE)],
      ['rejected', VERSION, 'release_revoked', sha256(IMAGE)],
    ]
  );
  assert.equal(added[0].detail.board, 'Cranium-1A2B');
});

test("the check takes a SHA-256 and a board's name in exactly one spelling each", async () => {
  const { call, manager, upload, fake } = setup();
  await upload();
  const good = sha256(IMAGE);
  for (const value of [undefined, null, '', good.toUpperCase(), good.slice(1), `${good}0`, ` ${good}`, 42, [good]]) {
    const response = await call('POST', sendPath(VERSION), {
      as: manager,
      body: value === undefined ? {} : { sha256: value },
    });
    assert.deepEqual([response.status, response.body.error.code], [400, 'invalid_sha256'], JSON.stringify(value));
  }
  for (const board of [
    null,
    '',
    'cranium-1a2b',
    'Cranium-1a2b',
    'Cranium-12345',
    'Cranium-1A2',
    'Cranium-1A2G',
    7,
    ['Cranium-1A2B'],
  ]) {
    const response = await call('POST', sendPath(VERSION), { as: manager, body: { sha256: good, board } });
    assert.deepEqual([response.status, response.body.error.code], [400, 'invalid_board'], JSON.stringify(board));
  }
  const badVersion = await call('POST', '/api/firmware/not-a-version/bluetooth', {
    as: manager,
    body: { sha256: good },
  });
  assert.deepEqual([badVersion.status, badVersion.body.error.code], [400, 'invalid_version']);
  const notJson = await call('POST', sendPath(VERSION), { as: manager, body: '{' });
  assert.deepEqual([notJson.status, notJson.body.error.code], [400, 'invalid_json']);
  const large = await call('POST', sendPath(VERSION), { as: manager, body: { sha256: good, pad: 'x'.repeat(20_000) } });
  assert.deepEqual([large.status, large.body.error.code], [413, 'payload_too_large']);
  // Each refusal is on record, as every write is.
  assert.ok(
    fake.auditLog().filter((entry) => entry.action === 'firmware.bluetooth_send' && entry.outcome === 'rejected')
      .length >= 21
  );
});

test('a viewer may not send, and the refusal is on record', async () => {
  const { call, viewer, upload, fake } = setup();
  await upload();
  const before = fake.auditLog().length;
  const response = await call('POST', sendPath(VERSION), { as: viewer, body: { sha256: sha256(IMAGE) } });
  assert.deepEqual([response.status, response.body.error.code], [403, 'release_manager_required']);
  const added = fake.auditLog().slice(before);
  assert.deepEqual(
    added.map((entry) => [entry.action, entry.outcome]),
    [['firmware.bluetooth_send', 'denied']]
  );
});

test("a release manager's API token may ask too, and the entry names the token", async () => {
  const { call, manager, upload, fake } = setup();
  await upload();
  const made = await call('POST', '/api/tokens', { as: manager, body: { name: 'bench' } });
  assert.equal(made.status, 201);
  const response = await call('POST', `/api/t/firmware/${encodeURIComponent(VERSION)}/bluetooth`, {
    token: made.body.token,
    body: { sha256: sha256(IMAGE) },
  });
  assert.equal(response.status, 200);
  const entry = fake.auditLog().at(-1);
  assert.deepEqual([entry.action, entry.outcome, entry.detail.token], ['firmware.bluetooth_send', 'ok', made.body.id]);
});

test('a change from the phone needs a sign-in in the last 15 minutes; at a board it does not', async () => {
  const context = await world();
  context.fake.addThing(OTHER_THING);
  const stale = accessClaims({
    sub: context.manager.sub,
    groups: ['release-managers'],
    clientId: PHONE_CLIENT,
    authTime: Math.floor(context.clock.ms / 1000) - 16 * 60,
  });
  const unknown = accessClaims({ sub: context.manager.sub, groups: ['release-managers'], clientId: PHONE_CLIENT });

  // The changes, and not the sign-in that the first of them records.
  const changes = () => context.fake.auditLog().filter((entry) => entry.action !== 'account.sign_in');
  for (const claims of [stale, unknown]) {
    const before = changes().length;
    const deploy = await context.call('POST', '/api/deployments', {
      claims,
      body: { version: VERSION, things: [THING] },
    });
    assert.deepEqual([deploy.status, deploy.body.error?.code], [403, 'phone_sign_in_again']);
    const revoke = await context.call('POST', `/api/firmware/${V}/revoke`, { claims, body: { reason: 'old build' } });
    assert.equal(revoke.body.error?.code, 'phone_sign_in_again');
    const token = await context.call('POST', '/api/tokens', { claims, body: { name: 'phone' } });
    assert.equal(token.body.error?.code, 'phone_sign_in_again');
    // Refused, and on record as refused.
    const added = changes().slice(before);
    assert.deepEqual(
      added.map((entry) => [entry.outcome, entry.detail.code]),
      [
        ['denied', 'phone_sign_in_again'],
        ['denied', 'phone_sign_in_again'],
        ['denied', 'phone_sign_in_again'],
      ]
    );
  }
  assert.equal(context.fake.calls.filter((call) => call.method === 'createJob').length, 0);

  // Reading never asks for a new sign-in, nor does what a person at a board does.
  assert.equal((await context.call('GET', '/api/firmware', { claims: stale })).status, 200);
  assert.equal((await context.call('GET', `/api/firmware/${V}/image`, { claims: stale })).status, 200);
  const check = await context.call('POST', `/api/firmware/${V}/bluetooth`, {
    claims: stale,
    body: { sha256: sha256(IMAGE) },
  });
  assert.equal(check.status, 200);
  // Nor does saying what was done at a board's serial console, which is done already.
  const serial = await context.call('POST', '/api/serial/commands', { claims: stale, body: { command: 'CLEAR_WIFI' } });
  assert.equal(serial.status, 201, JSON.stringify(serial.body));
  assert.deepEqual([changes().at(-1).action, changes().at(-1).detail.from], ['serial.command', 'phone']);

  // Signed in just now: a deployment to two boards goes ahead, and says it came from the phone.
  const both = await context.call('POST', '/api/deployments', {
    claims: context.phone,
    body: { version: VERSION, things: [THING, OTHER_THING] },
  });
  assert.equal(both.status, 201, JSON.stringify(both.body));
  const entry = changes().at(-1);
  assert.equal(entry.action, 'deployment.create');
  assert.equal(entry.detail.from, 'phone');
});

test("from the phone, the fleet's changes need a recent sign-in; saying what a phone saw of a board does not", async () => {
  const context = await world();
  const stale = accessClaims({
    sub: context.manager.sub,
    groups: ['release-managers'],
    clientId: PHONE_CLIENT,
    authTime: Math.floor(context.clock.ms / 1000) - 16 * 60,
  });
  const changes = () => context.fake.auditLog().filter((entry) => entry.action !== 'account.sign_in');
  const before = changes().length;
  for (const [method, path, body] of [
    ['POST', '/api/groups', { name: 'Bench', things: [THING] }],
    ['POST', '/api/rollouts', { version: VERSION, target: { kind: 'fleet' } }],
    ['POST', '/api/fleet/update-everything', { types: [] }],
    ['PUT', `/api/firmware/${V}/notes`, { notes: 'From the phone' }],
  ]) {
    const refused = await context.call(method, path, { claims: stale, body });
    assert.deepEqual([refused.status, refused.body.error?.code], [403, 'phone_sign_in_again'], path);
  }
  assert.deepEqual(
    changes()
      .slice(before)
      .map((entry) => [entry.action, entry.outcome]),
    [
      ['group.create', 'denied'],
      ['rollout.create', 'denied'],
      ['fleet.update_everything', 'denied'],
      ['firmware.notes', 'denied'],
    ]
  );
  const seen = await context.call('POST', `/api/devices/${THING}/seen`, { claims: stale, body: { version: VERSION } });
  assert.equal(seen.status, 201, JSON.stringify(seen.body));
  assert.deepEqual([changes().at(-1).action, changes().at(-1).detail.from], ['device.seen', 'phone']);
});
