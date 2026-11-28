// Tests for the fleet health score (docs/fleet-health.md, lib/fleet-score.mjs, handlers/fleet.mjs): the maths
// of each part (an empty fleet, all offline, mixed), the weights, the daily snapshot that the schedule writes
// once (tick.mjs), the history and the week's change, and who may read it. Against the fake AWS, and a fake
// Memfault that is a real HTTP server (fake-memfault.mjs) for the crashes Memfault saw.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createMemfaultReader } from '../src/aws-memfault-api.mjs';
import { createRolloutTick } from '../src/tick.mjs';
import {
  GOOD_SIGNAL_DBM,
  HISTORY_DAYS,
  MAX_HISTORY_DAYS,
  PARTS,
  PART_IDS,
  SCORE_DAYS,
  SCORE_WEIGHTS,
  dayOf,
  fleetScore,
  historyDays,
  historyOf,
  scoreOf,
  scoreParts,
  snapshotFromItem,
  snapshotItem,
  weekChange,
} from '../src/lib/fleet-score.mjs';
import { HEALTH_DAYS } from '../src/lib/fleet.mjs';
import { MEMFAULT_ENV, TOKEN, startFakeMemfault } from './fake-memfault.mjs';
import { A, B, C, D, fleetConsole, report } from './fleet-world.mjs';

const DAY = 86_400_000;
const MINUTE = 60_000;

let memfault;
before(async () => {
  memfault = await startFakeMemfault();
});
after(() => memfault.close());

const board = (thing, online, bluetoothOnly = false) => ({ thing, online, bluetoothOnly });

// The parts' maths.

test('an empty fleet has no part to count, and no score', () => {
  const parts = scoreParts({ boards: [] });
  for (const id of PART_IDS) assert.deepEqual(parts[id], { counted: 0, of: 0, value: null }, id);
  const score = fleetScore(parts);
  assert.equal(score.value, null);
  assert.deepEqual(
    score.parts.map((part) => [part.id, part.value, part.weight]),
    PART_IDS.map((id) => [id, null, SCORE_WEIGHTS[id]])
  );
  // A board without Wi-Fi is not counted by any part: it is never online and has no events.
  assert.equal(fleetScore(scoreParts({ boards: [board(D, false, true)] })).value, null);
});

test('a fleet all offline: online 0, no signal heard, no update in the window, crash-free by the rest', () => {
  const boards = [board(A, false), board(B, false), board(C, false)];
  const parts = scoreParts({ boards, rssi: new Map([[A, -50]]), crashed: new Set([B]) });
  assert.deepEqual(parts.online, { counted: 0, of: 3, value: 0 });
  assert.deepEqual(parts.crashFree, { counted: 2, of: 3, value: 2 / 3 });
  // The signal of a board that is not online now is not counted.
  assert.deepEqual(parts.signal, { counted: 0, of: 0, value: null });
  assert.deepEqual(parts.updates, { counted: 0, of: 0, value: null });
  // (0.35 * 0 + 0.3 * 2/3) / 0.65
  assert.equal(fleetScore(parts).value, Math.round((100 * 0.3 * (2 / 3)) / 0.65));
  assert.equal(fleetScore(parts).value, 31);
});

test('a mixed fleet: each part counts its own boards, and the score is their weighted mean', () => {
  const boards = [board(A, true), board(B, true), board(C, false), board(D, false, true)];
  const rssi = new Map([
    [A, -60],
    [B, GOOD_SIGNAL_DBM - 1],
    [C, -40],
  ]);
  const parts = scoreParts({
    boards,
    rssi,
    // D is Bluetooth only, and not of the fleet with Wi-Fi; a thing not registered is not counted at all.
    crashed: new Set([C, D, 'cranium-00000000000000ff']),
    jobs: { succeeded: 3, failed: 1, rolledBack: 0 },
  });
  assert.deepEqual(parts.online, { counted: 2, of: 3, value: 2 / 3 });
  assert.deepEqual(parts.crashFree, { counted: 2, of: 3, value: 2 / 3 });
  assert.deepEqual(parts.updates, { counted: 3, of: 4, value: 3 / 4 });
  assert.deepEqual(parts.signal, { counted: 1, of: 2, value: 1 / 2 });
  const expected = 100 * (0.35 * (2 / 3) + 0.3 * (2 / 3) + 0.2 * 0.75 + 0.15 * 0.5);
  assert.equal(fleetScore(parts).value, Math.round(expected));
  assert.equal(fleetScore(parts).value, 66);
  // A signal at the threshold is good; just under it is not.
  assert.equal(scoreParts({ boards: [board(A, true)], rssi: new Map([[A, GOOD_SIGNAL_DBM]]) }).signal.value, 1);
});

test('the weights are constants that add up to 1, and each part has its meaning and its page', () => {
  assert.ok(Object.isFrozen(SCORE_WEIGHTS) && Object.isFrozen(PARTS));
  assert.deepEqual(SCORE_WEIGHTS, { online: 0.35, crashFree: 0.3, updates: 0.2, signal: 0.15 });
  assert.equal(Math.round(PART_IDS.reduce((sum, id) => sum + SCORE_WEIGHTS[id], 0) * 1e9), 1e9);
  assert.equal(SCORE_DAYS, HEALTH_DAYS);
  assert.deepEqual(
    PART_IDS.map((id) => PARTS[id].href),
    ['#/devices?status=offline', '#/memfault', '#/deployments', '#/diagnostics']
  );
  for (const id of PART_IDS) assert.match(PARTS[id].meaning, /^[A-Z].{10,120}\.$/, id);
  // All well is 100, all bad 0; a part alone is the score; the weights decide between two parts.
  const all = (value) => Object.fromEntries(PART_IDS.map((id) => [id, value]));
  assert.equal(scoreOf(all(1)), 100);
  assert.equal(scoreOf(all(0)), 0);
  assert.equal(scoreOf({ ...all(null), updates: 0.42 }), 42);
  assert.equal(scoreOf({ ...all(null), online: 1, signal: 0 }), Math.round((100 * 0.35) / 0.5));
  assert.equal(scoreOf({ ...all(null), online: 0, signal: 1 }), Math.round((100 * 0.15) / 0.5));
  // A value out of range is held to it; one that is not a number is left out.
  assert.equal(scoreOf({ ...all(null), online: 2, crashFree: Number.NaN }), 100);
});

test('history: days from the address, snapshots of the window oldest first, and the change since last week', () => {
  assert.equal(historyDays(undefined), HISTORY_DAYS);
  assert.equal(historyDays('7'), 7);
  assert.equal(historyDays(String(MAX_HISTORY_DAYS)), MAX_HISTORY_DAYS);
  for (const bad of ['0', '32', '-1', '1.5', 'abc', '', '007', ['3']])
    assert.equal(historyDays(bad), null, String(bad));

  const nowMs = Date.parse('2026-11-09T15:00:00Z');
  const score = fleetScore(
    scoreParts({ boards: [board(A, true), board(B, false)], rssi: new Map([[A, -50]]), jobs: { succeeded: 1 } })
  );
  const item = snapshotItem(score, nowMs);
  assert.deepEqual(item, {
    day: '2026-11-09',
    at: '2026-11-09T15:00:00.000Z',
    score: score.value,
    parts: { online: 0.5, crashFree: 1, updates: 1, signal: 1 },
  });
  const stored = (day, value) => ({ pk: 'HEALTH', sk: day, day, score: value, parts: item.parts });
  const items = [
    stored('2026-11-09', 80),
    stored('2026-11-02', 70),
    stored('2026-10-10', 10),
    { pk: 'HEALTH', sk: 'not a day', score: 1 },
    { ...stored('2026-11-03', 500) },
  ];
  assert.deepEqual(snapshotFromItem(items[4]).score, null);
  const history = historyOf(items, 30, nowMs);
  assert.deepEqual(
    history.map((one) => [one.day, one.score]),
    [
      ['2026-11-02', 70],
      ['2026-11-03', null],
      ['2026-11-09', 80],
    ]
  );
  assert.deepEqual(
    historyOf(items, 1, nowMs).map((one) => one.day),
    ['2026-11-09']
  );
  assert.equal(weekChange(history, 85, nowMs), 15);
  assert.equal(weekChange(history, null, nowMs), null);
  // No snapshot from 7 to 10 days back: no change to say.
  assert.equal(weekChange(historyOf([stored('2026-11-08', 50)], 30, nowMs), 85, nowMs), null);
  // The nearest before a week ago, up to 10 days back.
  assert.equal(weekChange(historyOf([stored('2026-10-31', 90)], 30, nowMs), 85, nowMs), -5);
  assert.equal(dayOf(Date.parse('2026-11-09T23:59:59Z')), '2026-11-09');
});

// Through the API and the schedule.

function useMemfault(world) {
  memfault.state.world = { devices: [], reboots: {}, issues: [], traces: [], releases: [], versions: [], log: [] };
  memfault.state.fail = () => null;
  world.fake.useMemfault(
    createMemfaultReader(MEMFAULT_ENV, {
      fetch: memfault.fetch,
      now: () => world.clock.ms,
      readSecret: async () => TOKEN,
    })
  );
}

test('GET /api/fleet/health has the score, its parts from the boards, their events and Memfault', async () => {
  const world = fleetConsole();
  useMemfault(world);
  // A well; B on a weak signal, stuck twice in a row (a restart at warning level); C quiet; D Bluetooth only.
  world.online(A, '1.13.0+0', { rssi: -55 });
  world.online(B, '1.13.0+0', { rssi: -82 });
  world.fake.device(B).report({ stuck: { count: 1, reason: 'wifi_silent' } });
  world.fake.device(B).report({ stuck: { count: 2, reason: 'wifi_silent' } });
  world.online(C, '1.13.0+0');
  world.bluetoothOnly(D);
  // A's update ended well; then one rolled back.
  world.fake.device(A).report({ ota: { state: 'downloading', progress: 0, last: 'none', error: '' } });
  world.fake.device(A).report({ ota: { state: 'idle', progress: 0, last: 'succeeded', error: '' } });
  world.fake.device(A).report({ ota: { state: 'downloading', progress: 0, last: 'succeeded', error: '' } });
  world.fake.device(A).report({ ota: { state: 'idle', progress: 0, last: 'rolled_back', error: 'not confirmed' } });
  world.advance(10 * MINUTE);
  world.fake.device(A).report(report('1.13.0+0', { rssi: -55 }));
  world.fake.device(B).report(report('1.13.0+0', { rssi: -82 }));

  const { status, body } = await world.call('GET', '/api/fleet/health', undefined, world.viewer);
  assert.equal(status, 200, JSON.stringify(body));
  const parts = Object.fromEntries(body.score.parts.map((part) => [part.id, [part.counted, part.of]]));
  assert.deepEqual(parts, { online: [2, 3], crashFree: [2, 3], updates: [1, 2], signal: [1, 2] });
  assert.equal(body.score.value, Math.round(100 * (0.35 * (2 / 3) + 0.3 * (2 / 3) + 0.2 * 0.5 + 0.15 * 0.5)));
  assert.equal(body.score.days, 7);
  assert.deepEqual(body.score.memfault, { state: 'ok', message: '' });
  assert.deepEqual([body.score.history, body.score.change, body.score.historyDays], [[], null, 30]);
  for (const part of body.score.parts) assert.ok(part.label && part.meaning && part.href && part.weight > 0);
  // What was there before stays: versions, updates, attention.
  assert.deepEqual(body.updates, { days: 7, succeeded: 1, failed: 0, rolledBack: 1 });
  assert.ok(Array.isArray(body.types) && Array.isArray(body.attention));

  // Memfault's unexpected reboot of A, and a new issue on C, count against crash-free; an expected reboot does not.
  const at = world.clock.ms - 5 * MINUTE;
  const entry = (thing, reason) => ({
    created_date: new Date(at + 1000).toISOString(),
    device_serial: thing,
    software_version: '1.13.0+0',
    event_type: 'ReceivedDataRebootEvent',
    level: 'info',
    source: 'trace',
    event_data: {
      received_event: { captured_date: new Date(at).toISOString(), event_info: { reason, coredump_saved: false } },
    },
  });
  memfault.state.world.log.push(entry(A, 0x8001), entry(C, 0x0003));
  memfault.state.world.issues.push({
    id: 5,
    title: 'Hard fault',
    status: 'open',
    trace_count: 1,
    device_count: 1,
    first_seen: new Date(at).toISOString(),
    last_seen: new Date(at).toISOString(),
    signature: 'sig-5',
  });
  memfault.state.world.traces.push({
    id: 50,
    title: 'Hard fault',
    captured_date: new Date(at).toISOString(),
    device: { device_serial: C },
    signature: 'sig-5',
    entries: { threads: [] },
  });
  world.advance(61_000);
  const again = (await world.call('GET', '/api/fleet/health', undefined, world.viewer)).body;
  const crashFree = again.score.parts.find((part) => part.id === 'crashFree');
  assert.deepEqual([crashFree.counted, crashFree.of, crashFree.value], [0, 3, 0]);

  // Memfault that cannot be read: the events table's restarts alone, and the page is told why.
  memfault.state.fail = () => 503;
  world.advance(61_000);
  const without = (await world.call('GET', '/api/fleet/health', undefined, world.viewer)).body;
  assert.equal(without.score.memfault.state, 'unreachable');
  assert.deepEqual([without.score.parts[1].counted, without.score.parts[1].of], [2, 3]);
});

test('the schedule stores one snapshot a day, once, and the history shows them with the change since last week', async () => {
  const world = fleetConsole();
  world.online(A, '1.13.0+0', { rssi: -55 });
  world.online(B, '1.13.0+0', { rssi: -55 });
  const snapshots = () => world.fake.listFleetItems('HEALTH');

  await world.tick();
  const [first] = await snapshots();
  assert.equal(first.sk, dayOf(world.clock.ms));
  assert.equal(first.score, 100);
  assert.deepEqual(first.parts, { online: 1, crashFree: 1, updates: null, signal: 1 });
  assert.equal(world.tickLogs.filter((line) => line.event === 'health_snapshot').length, 1);

  // Again the same day: nothing is written, and the stored snapshot is not changed, even by a schedule that
  // has never run before (a new Lambda instance) and a fleet that is worse now.
  world.advance(MINUTE);
  world.fake.device(B).report({ wifi: { rssi: -90 } });
  await world.tick();
  const fresh = createRolloutTick({ aws: world.fake, config: world.config, now: () => world.clock.ms, log: () => {} });
  await fresh();
  assert.deepEqual(await snapshots(), [first]);
  // Two runs at once write one: the second put finds the first.
  const put = await world.fake.putFleetItem({ pk: 'HEALTH', sk: first.sk, item: { score: 1 } });
  assert.deepEqual(put, { ok: false, reason: 'exists' });

  // Eight days on, with a snapshot each day: the boards went quiet after the first.
  for (let day = 1; day <= 8; day += 1) {
    world.advance(DAY);
    if (day === 8) world.online(A, '1.13.0+0', { rssi: -55 });
    await world.tick();
  }
  const stored = await snapshots();
  assert.equal(stored.length, 9);
  assert.equal(new Set(stored.map((item) => item.sk)).size, 9);

  const { status, body } = await world.call('GET', '/api/fleet/health?days=30', undefined, world.viewer);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.score.history.length, 9);
  assert.deepEqual(
    body.score.history.map((one) => one.day),
    [...stored.map((item) => item.sk)].sort()
  );
  // A week ago the boards were offline: online 0, crash-free 1, signal not heard.
  const weekAgo = body.score.history.find((one) => one.day === dayOf(world.clock.ms - 7 * DAY));
  assert.equal(weekAgo.score, Math.round((100 * 0.3) / 0.65));
  assert.equal(body.score.change, body.score.value - weekAgo.score);
  assert.ok(body.score.change > 0);

  const short = await world.call('GET', '/api/fleet/health?days=3', undefined, world.viewer);
  assert.deepEqual(
    short.body.score.history.map((one) => one.day),
    [2, 1, 0].map((back) => dayOf(world.clock.ms - back * DAY))
  );
  // The week's change does not depend on how much history is asked for.
  assert.equal(short.body.score.change, body.score.change);
});

test('a snapshot that cannot be made is logged and leaves the rollouts alone', async () => {
  const world = fleetConsole();
  world.online(A, '1.13.0+0');
  const put = world.fake.putFleetItem;
  world.fake.putFleetItem = async (input) => {
    if (input.pk === 'HEALTH') throw new Error('DynamoDB PutItem: AccessDenied');
    return put(input);
  };
  const outcome = await world.tick();
  assert.equal(typeof outcome.checked, 'number');
  assert.equal(world.tickLogs.filter((line) => line.event === 'health_snapshot_failed').length, 1);
  world.fake.putFleetItem = put;
  // The next run tries again.
  world.advance(MINUTE);
  await world.tick();
  assert.equal((await world.fake.listFleetItems('HEALTH')).length, 1);
});

test('fleet health is for every member, viewers too; ?days must be 1 to 31; nobody else may read it', async () => {
  const world = fleetConsole();
  world.online(A, '1.13.0+0');
  for (const who of [world.viewer, world.manager]) {
    assert.equal((await world.call('GET', '/api/fleet/health', undefined, who)).status, 200);
  }
  const nobody = world.addUser('nobody', []);
  assert.equal((await world.call('GET', '/api/fleet/health', undefined, nobody)).status, 403);
  for (const days of ['0', '32', 'x', '1.5']) {
    const refused = await world.call('GET', `/api/fleet/health?days=${days}`, undefined, world.viewer);
    assert.equal(refused.status, 400, days);
    assert.equal(refused.body.error.code, 'invalid_range');
  }
  assert.equal((await world.call('GET', '/api/fleet/health?days=31', undefined, world.viewer)).status, 200);
  // A read is no change: nothing goes on record.
  assert.equal(world.fake.auditLog().filter((entry) => entry.action?.startsWith('fleet')).length, 0);
});
