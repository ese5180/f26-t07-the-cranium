// Tests for the fleet as a whole (handlers/fleet.mjs): the guard that keeps a release from a board of
// another type, what a phone saw of a board, and the Overview's account of how the fleet is doing.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { attentionReasons, updateResults, versionsByType } from '../src/lib/fleet.mjs';
import { A, B, C, E, fleetConsole, report } from './fleet-world.mjs';

const V = (version) => encodeURIComponent(version);

test('the check before a Bluetooth send refuses a type or a board it does not know, on record', async () => {
  const world = fleetConsole();
  world.online(A, '1.0.0+0');
  await world.release('1.13.0+0', 'nrf7002dk');
  // An image is signed afresh each time it is built: the release says which one was uploaded.
  const { sha256: digest } = (await world.call('GET', `/api/firmware/${V('1.13.0+0')}`)).body.release;
  const check = (body) => world.call('POST', `/api/firmware/${V('1.13.0+0')}/bluetooth`, { sha256: digest, ...body });

  assert.equal((await check({ thing: A })).status, 200);
  assert.equal((await check({ type: 'nrf7002dk', board: 'Cranium-1A2B' })).status, 200);
  // Without either the console has nothing to go by, as before types.
  assert.equal((await check({})).status, 200);

  const unknown = await check({ thing: E });
  assert.deepEqual([unknown.status, unknown.body.error.code], [404, 'unknown_device']);
  const bad = await check({ type: 'esp32' });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'invalid_type']);
  // The nRF5340 DK is not a type this console knows.
  const gone = await check({ type: 'nrf5340dk' });
  assert.deepEqual([gone.status, gone.body.error.code], [400, 'invalid_type']);

  const entries = world.entries('firmware.bluetooth_send');
  assert.deepEqual(
    entries.map((entry) => entry.outcome),
    ['ok', 'ok', 'ok', 'rejected', 'rejected', 'rejected']
  );
  assert.deepEqual([entries[3].detail.thing, entries[3].detail.code], [E, 'unknown_device']);
});

test('a phone says what it saw of a board: kept and on record', async () => {
  const world = fleetConsole();
  world.fake.addThing(C);
  const before = (await world.call('GET', '/api/fleet')).body.boards.find((board) => board.thing === C);
  assert.deepEqual([before.version, before.versionFrom, before.seen], [null, null, null]);

  const seen = await world.call('POST', `/api/devices/${C}/seen`, { version: '1.13.0+0', name: 'Cranium-1A2B' });
  assert.equal(seen.status, 201, JSON.stringify(seen.body));
  assert.deepEqual(seen.body.seen, {
    thing: C,
    version: '1.13.0+0',
    at: new Date(world.clock.ms).toISOString(),
    name: 'Cranium-1A2B',
    by: world.manager.email,
  });
  const entry = world.entries('device.seen').at(-1);
  assert.deepEqual(
    [entry.target, entry.outcome, entry.detail],
    [C, 'ok', { version: '1.13.0+0', board: 'Cranium-1A2B' }]
  );
  // What the board runs is what it reports itself: a sighting is kept beside it.
  const after = (await world.call('GET', '/api/fleet')).body.boards.find((board) => board.thing === C);
  assert.deepEqual(
    [after.version, after.versionFrom, after.seen.version, after.seen.by],
    [null, null, '1.13.0+0', world.manager.email]
  );

  // The last sighting is the one kept.
  world.advance(60_000);
  assert.equal((await world.call('POST', `/api/devices/${C}/seen`, { version: '1.13.1+0' })).status, 201);
  world.advance(6000);
  const later = (await world.call('GET', '/api/fleet')).body.boards.find((board) => board.thing === C);
  assert.deepEqual([later.seen.version, later.seen.name], ['1.13.1+0', null]);
});

test('a sighting takes a version and a name only, of a registered board, from a release manager', async () => {
  const world = fleetConsole();
  world.fake.addThing(C);
  for (const [body, code] of [
    [{}, 'invalid_version'],
    [{ version: '1.0' }, 'invalid_version'],
    [{ version: '1.0.0+0', name: 'cranium-1a2b' }, 'invalid_board'],
    [{ version: '1.0.0+0', where: 'lab' }, 'unexpected_field'],
  ]) {
    const response = await world.call('POST', `/api/devices/${C}/seen`, body);
    assert.deepEqual([response.status, response.body.error.code], [400, code], JSON.stringify(body));
  }
  const stranger = await world.call('POST', `/api/devices/${E}/seen`, { version: '1.0.0+0' });
  assert.deepEqual([stranger.status, stranger.body.error.code], [404, 'unknown_device']);
  const viewer = await world.call('POST', `/api/devices/${C}/seen`, { version: '1.0.0+0' }, world.viewer);
  assert.deepEqual([viewer.status, viewer.body.error.code], [403, 'release_manager_required']);
  assert.equal(world.fake.fleetItems.size, 0);
  // Every refusal is on record.
  assert.equal(world.entries('device.seen').length, 6);
});

test('at most 60 sightings a minute for one person; one over that leaves no entry', async () => {
  const world = fleetConsole();
  world.fake.addThing(C);
  for (let index = 0; index < 60; index += 1) {
    assert.equal((await world.call('POST', `/api/devices/${C}/seen`, { version: '1.0.0+0' })).status, 201);
  }
  const over = await world.call('POST', `/api/devices/${C}/seen`, { version: '1.0.0+0' });
  assert.deepEqual([over.status, over.body.error.code], [429, 'rate_limited']);
  assert.equal(world.entries('device.seen').length, 60);
  world.advance(61_000);
  assert.equal((await world.call('POST', `/api/devices/${C}/seen`, { version: '1.0.0+0' })).status, 201);
});

test('GET /api/fleet: every board with its type and groups, and each type with its newest releases', async () => {
  const world = fleetConsole();
  world.online(A, '1.13.1+0');
  world.fake.addThing(C);
  await world.release('1.13.1+0');
  await world.release('1.13.2+0');
  const group = await world.call('POST', '/api/groups', { name: 'Bench', things: [A, C] });
  const { body } = await world.call('GET', '/api/fleet');
  assert.deepEqual(
    body.boards.map((board) => [board.thing, board.type, board.groups]),
    [
      [A, 'nrf7002dk', [group.body.group.id]],
      [C, 'nrf7002dk', [group.body.group.id]],
    ]
  );
  assert.deepEqual(
    body.groups.map((item) => [item.name, item.things]),
    [['Bench', [A, C]]]
  );
  assert.deepEqual(
    body.types.map((type) => [type.type, type.boards, type.newest, type.previous]),
    [['nrf7002dk', 2, '1.13.2+0', '1.13.1+0']]
  );
  assert.equal((await world.call('GET', '/api/fleet', undefined, world.viewer)).status, 200);
});

test("fleet health: versions by type, the last week's updates, and the boards that need looking at", async () => {
  const world = fleetConsole();
  await world.release('1.13.0+0');
  await world.release('1.13.1+0');
  // A on the newest; B behind, with a weak signal, short of memory and stuck once; C gone quiet.
  world.online(A, '1.13.1+0', { board: 'nrf7002dk' });
  world.online(B, '1.13.0+0', { rssi: -82, heap: { free: 4000, least: 3000, size: 44240 } });
  world.fake.device(B).report({ stuck: { count: 2, reason: 'wifi_silent' } });
  world.online(C, '1.13.0+0');
  // A's last week: an update that succeeded, and one before that which rolled back.
  world.fake.device(A).report({ ota: { state: 'downloading', progress: 0, last: 'none', error: '' } });
  world.fake.device(A).report({ ota: { state: 'idle', progress: 0, last: 'rolled_back', error: 'not confirmed' } });
  world.fake
    .device(A)
    .report({ ota: { state: 'downloading', progress: 0, last: 'rolled_back', error: 'not confirmed' } });
  world.fake.device(A).report({ ota: { state: 'idle', progress: 0, last: 'succeeded', error: '' } });
  world.advance(2 * 3_600_000);
  world.fake.device(A).report(report('1.13.1+0', { board: 'nrf7002dk' }));
  world.fake.device(B).report(report('1.13.0+0', { rssi: -82, heap: { free: 4000, least: 3000, size: 44240 } }));

  const { body } = await world.call('GET', '/api/fleet/health');
  const wifi = body.types.find((type) => type.type === 'nrf7002dk');
  assert.deepEqual([wifi.boards, wifi.newest, wifi.onNewest, wifi.share], [3, '1.13.1+0', 1, 1 / 3]);
  assert.deepEqual(wifi.versions, [
    { version: '1.13.1+0', count: 1, newest: true },
    { version: '1.13.0+0', count: 2, newest: false },
  ]);
  assert.deepEqual(body.updates, { days: 7, succeeded: 1, failed: 0, rolledBack: 1 });
  const attention = Object.fromEntries(
    body.attention.map((entry) => [entry.thing, entry.reasons.map((reason) => reason.code)])
  );
  assert.deepEqual(attention[B], ['stuck', 'low_memory', 'weak_signal']);
  assert.deepEqual(attention[C], ['offline']);
  assert.equal(attention[A], undefined);
});

test('the pieces of fleet health, one by one', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  assert.deepEqual(
    updateResults([
      { kind: 'update', what: 'result', result: 'succeeded' },
      { kind: 'update', what: 'result', result: 'failed' },
      { kind: 'update', what: 'result', result: 'refused' },
      { kind: 'update', what: 'result', result: 'declined' },
      { kind: 'update', what: 'step', result: 'succeeded' },
      { kind: 'update', what: 'result', result: 'rolled_back' },
      // An update over Bluetooth is counted from the update history (lib/updates.mjs updateCounts), not from its events.
      { kind: 'bluetooth', what: 'record', result: 'trial_lost' },
      { kind: 'bluetooth', what: 'record', result: 'succeeded' },
    ]),
    { succeeded: 1, failed: 2, rolledBack: 1 }
  );
  const boards = [
    { type: 'nrf7002dk', version: '1.2.0+0' },
    { type: 'nrf7002dk', version: null },
    { type: 'otherboard', version: '1.0.0+0' },
  ];
  const [wifi, other] = versionsByType(boards, { nrf7002dk: '1.3.0+0', otherboard: '1.0.0+0' }, [
    'nrf7002dk',
    'otherboard',
  ]);
  assert.deepEqual([wifi.onNewest, wifi.share, wifi.unknown], [0, 0, 1]);
  assert.deepEqual([other.onNewest, other.share], [1, 1]);
  const board = {
    online: false,
    lastSeen: new Date(now - 3 * 86_400_000).toISOString(),
    seen: null,
  };
  assert.deepEqual(
    attentionReasons(board, { ota: { last: 'failed' } }, now).map((reason) => reason.text),
    ['Offline for 3 days', 'Its last update failed']
  );
  // A weak signal is said of a board that is online, from what it reports now.
  assert.deepEqual(
    attentionReasons({ ...board, online: true }, { rssi: -80 }, now).map((reason) => reason.code),
    ['weak_signal']
  );
});
