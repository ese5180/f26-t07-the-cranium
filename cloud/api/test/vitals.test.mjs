// Tests for our own vitals (src/lib/vitals.mjs, src/handlers/vitals.mjs, docs/own-observability.md stage 2):
// connected time, restarts, drops and low memory per board, by day and by version; the fleet's vitals and
// cohorts; a board's samples by day; and GET /api/vitals and /api/vitals/{thing}: what they answer, what they
// refuse and who may read them.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { eventKey } from '../src/lib/events.mjs';
import {
  boardDetail,
  boardVitals,
  daysBetween,
  firstConnectionOf,
  fleetVitals,
  samplesByDay,
  tallyOut,
  versionCohorts,
} from '../src/lib/vitals.mjs';
import { A, B, C, fleetConsole, report } from './fleet-world.mjs';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const FROM = Date.UTC(2026, 10, 10);
const TO = Date.UTC(2026, 10, 12);
const at = (ms) => new Date(ms).toISOString();

let serial = 0;
function event(kind, what, ms, fields = {}) {
  serial += 1;
  return { kind, what, level: 'info', text: 'x', at: at(ms), id: serial.toString(16).padStart(6, '0'), ...fields };
}
const disconnected = (ms, reason = 'CONNECTION_LOST') => event('connection', 'disconnected', ms, { reason });
const connected = (ms) => event('connection', 'connected', ms);

// Board A over two days: a drop, a watchdog reset reported twice, an update, a disconnect it chose, low memory,
// and three boots by the reset pin in one diary.
const BOARD_A = [
  disconnected(FROM + 6 * HOUR),
  connected(FROM + 8 * HOUR),
  event('restart', 'restarted', FROM + 12 * HOUR, { upFor: 3600 }),
  event('restart', 'boot', FROM + 12 * HOUR + MINUTE, { cause: '10', version: '1.0.0+0', newBoots: 1 }),
  event('firmware', 'changed', FROM + 20 * HOUR, { from: '1.0.0+0', version: '1.1.0+0' }),
  disconnected(FROM + DAY + 3 * HOUR, 'CLIENT_INITIATED_DISCONNECT'),
  connected(FROM + DAY + 3 * HOUR + 2 * MINUTE),
  event('health', 'memory', FROM + DAY + 10 * HOUR, { heapLeast: 4000, heapSize: 44000 }),
  event('restart', 'boot', FROM + DAY + 15 * HOUR, { cause: '1', version: '1.1.0+0', newBoots: 3 }),
];

const pick = (one) => [one.knownMs / HOUR, one.onlineMs / HOUR, one.restarts, one.unexpected, one.drops, one.lowMemory];

test('connected time, restarts, drops and low memory are counted per board, by UTC day', () => {
  const made = boardVitals({ events: BOARD_A, fromMs: FROM, toMs: TO, onlineNow: true, current: '1.1.0+0' });
  // Online before its first disconnect, offline for two hours; the watchdog reset counted once as a restart.
  assert.deepEqual(pick(made.days.get('2026-11-10')), [24, 22, 1, 1, 1, 0]);
  // The disconnect the board chose is no drop; three boots in one diary are three restarts.
  assert.deepEqual(pick(made.days.get('2026-11-11')), [24, 24 - 2 / 60, 3, 0, 0, 1]);
  assert.deepEqual([...made.days.keys()], ['2026-11-10', '2026-11-11']);
  const total = tallyOut(made.total);
  assert.equal(total.knownHours, 48);
  assert.equal(total.onlineHours, 46);
  assert.equal(total.connectivity, 0.9576);
  assert.equal(total.restartsPerDay, 2);
});

test('each count goes to the version the board ran, and time to the version it ran then', () => {
  const made = boardVitals({ events: BOARD_A, fromMs: FROM, toMs: TO, onlineNow: true, current: '1.1.0+0' });
  assert.deepEqual(pick(made.versions.get('1.0.0+0')), [20, 18, 1, 1, 1, 0]);
  assert.deepEqual(pick(made.versions.get('1.1.0+0')), [28, 28 - 2 / 60, 3, 0, 0, 1]);
});

test('after an update, time goes to the new version, though its boot is counted on the old one', () => {
  const update = [
    connected(FROM + HOUR),
    // The first report after the update's restart: the uptime went down and the firmware changed.
    event('restart', 'restarted', FROM + 6 * HOUR, { upFor: 18_000 }),
    event('firmware', 'changed', FROM + 6 * HOUR + 1, { from: '1.0.0+0', version: '1.1.0+0' }),
    // Its diary a moment later, which withVersions places on the version the restart ran.
    event('restart', 'boot', FROM + 6 * HOUR + MINUTE, { cause: '2', version: '1.1.0+0', newBoots: 1 }),
  ];
  const made = boardVitals({ events: update, fromMs: FROM, toMs: TO, onlineNow: true, current: '1.1.0+0' });
  const hours = (version) => Math.round(made.versions.get(version).onlineMs / HOUR);
  assert.equal(hours('1.0.0+0'), 5);
  assert.equal(hours('1.1.0+0'), 42);
  assert.equal(made.versions.get('1.0.0+0').restarts, 1);
});

test('time before what a board said is unknown, and counts neither way', () => {
  // Its first connection event is a connect: it may not have existed before it.
  const late = boardVitals({ events: [connected(FROM + DAY)], fromMs: FROM, toMs: TO });
  assert.deepEqual(pick(late.days.get('2026-11-10')), [0, 0, 0, 0, 0, 0]);
  assert.equal(late.days.get('2026-11-10').active, false);
  assert.deepEqual(pick(late.total), [24, 24, 0, 0, 0, 0]);
  // Nothing said in the window: online all of it if online now, else nothing is known.
  assert.deepEqual(
    pick(boardVitals({ events: [], fromMs: FROM, toMs: TO, onlineNow: true }).total),
    [48, 48, 0, 0, 0, 0]
  );
  const drawer = boardVitals({ events: [], fromMs: FROM, toMs: TO, onlineNow: false });
  assert.equal(drawer.total.active, false);
  assert.equal(tallyOut(drawer.total).connectivity, null);
  assert.equal(tallyOut(drawer.total).restartsPerDay, null);
  // Events outside the window are not counted.
  const outside = boardVitals({ events: [disconnected(FROM - HOUR), connected(TO + HOUR)], fromMs: FROM, toMs: TO });
  assert.equal(outside.total.drops, 0);
});

test('a board offline when the window began is offline until its first connect, when the event before says so', () => {
  // Its last connection event before the window was a disconnect: the first day is known, and offline.
  const off = boardVitals({ events: [connected(FROM + DAY)], fromMs: FROM, toMs: TO, before: 'disconnected' });
  assert.deepEqual(pick(off.days.get('2026-11-10')), [24, 0, 0, 0, 0, 0]);
  assert.equal(off.days.get('2026-11-10').active, true);
  assert.equal(tallyOut(off.total).connectivity, 0.5);
  // A connect before it says nothing about the time in between; nor does a disconnect when the first event is one.
  assert.deepEqual(
    pick(boardVitals({ events: [connected(FROM + DAY)], fromMs: FROM, toMs: TO, before: 'connected' }).total),
    [24, 24, 0, 0, 0, 0]
  );
  assert.deepEqual(
    pick(boardVitals({ events: [disconnected(FROM + DAY)], fromMs: FROM, toMs: TO, before: 'disconnected' }).total),
    [48, 24, 0, 0, 1, 0]
  );
  // A board in a drawer stays out, whatever came before the window.
  assert.equal(boardVitals({ events: [], fromMs: FROM, toMs: TO, before: 'disconnected' }).total.active, false);
  assert.equal(firstConnectionOf([connected(FROM + DAY), disconnected(FROM + HOUR)], FROM, TO).what, 'disconnected');
  assert.equal(firstConnectionOf([connected(FROM - HOUR)], FROM, TO), null);
});

test('a restart reported twice counts once; a stuck restart and its diary too', () => {
  const twice = [
    event('restart', 'stuck', FROM + HOUR, { reason: 'no_cloud', count: 1 }),
    event('restart', 'boot', FROM + HOUR + 2 * MINUTE, { cause: '2', newBoots: 1 }),
    // A restart whose diary came in the same report: the cause is on it, and a later diary is a new boot.
    event('restart', 'restarted', FROM + 5 * HOUR, { cause: '10' }),
    event('restart', 'boot', FROM + 5 * HOUR + MINUTE, { cause: '1', newBoots: 1 }),
    // A diary that comes more than 15 minutes after the restart is a boot of its own.
    event('restart', 'restarted', FROM + 9 * HOUR),
    event('restart', 'boot', FROM + 9 * HOUR + 20 * MINUTE, { cause: '1', newBoots: 1 }),
  ];
  const made = boardVitals({ events: twice, fromMs: FROM, toMs: TO, onlineNow: true });
  assert.equal(made.total.restarts, 5);
  // The stuck restart and the watchdog: what our own Issues count.
  assert.equal(made.total.unexpected, 2);
});

test('every UTC day of the window is a day, the first and last in part', () => {
  assert.deepEqual(daysBetween(FROM + 18 * HOUR, FROM + 2 * DAY + HOUR), ['2026-11-10', '2026-11-11', '2026-11-12']);
  assert.deepEqual(daysBetween(FROM, FROM + DAY), ['2026-11-10']);
  const made = boardVitals({ events: [], fromMs: FROM + 18 * HOUR, toMs: FROM + DAY + 6 * HOUR, onlineNow: true });
  assert.deepEqual(
    [...made.days.values()].map((one) => one.knownMs / HOUR),
    [6, 6]
  );
});

function fleetOf() {
  const vitalsA = boardVitals({ events: BOARD_A, fromMs: FROM, toMs: TO, onlineNow: true, current: '1.1.0+0' });
  const vitalsB = boardVitals({ events: [connected(FROM + DAY)], fromMs: FROM, toMs: TO, current: '1.0.0+0' });
  const drawer = boardVitals({ events: [], fromMs: FROM, toMs: TO });
  const base = { type: 'nrf7002dk', bluetoothOnly: false, online: true, rssi: -60 };
  return fleetVitals(
    [
      { ...base, thing: A, name: 'CRA', version: '1.1.0+0', vitals: vitalsA },
      { ...base, thing: B, name: null, version: '1.0.0+0', vitals: vitalsB, rssi: null },
      { ...base, thing: C, version: null, online: false, vitals: drawer },
      {
        ...base,
        thing: 'cranium-00000000000000dd',
        type: 'nrf5340dk',
        bluetoothOnly: true,
        version: '1.0.0+0',
        vitals: null,
      },
      { ...base, thing: 'cranium-00000000000000ee', version: '1.1.0+0', vitals: null },
    ],
    { newestByType: { nrf7002dk: '1.1.0+0', nrf5340dk: '1.0.0+0' } }
  );
}

test('fleet vitals count the boards seen in the window: crash-free, connected and on the newest release', () => {
  const { vitals } = fleetOf();
  assert.equal(vitals.boards, 5);
  // A board in a drawer, a Bluetooth-only board and one that could not be read are not judged.
  assert.equal(vitals.active, 2);
  assert.equal(vitals.bluetoothOnly, 1);
  assert.equal(vitals.unread, 1);
  assert.deepEqual(vitals.crashFree, { boards: 1, of: 2, share: 0.5 });
  assert.deepEqual(vitals.connectivity, { onlineHours: 70, knownHours: 72, share: 0.9718 });
  // Of the four boards with a version whose type has a release: A, the Bluetooth-only board and the unread one.
  assert.deepEqual(vitals.newest, { boards: 3, of: 4, share: 0.75 });
  assert.deepEqual([vitals.restarts, vitals.unexpected, vitals.drops, vitals.lowMemory], [4, 1, 1, 1]);
});

test('the fleet has a row a day, a row a board and a cohort a version', () => {
  const { daily, perBoard, versions } = fleetOf();
  assert.deepEqual(
    daily.map((one) => [one.day, one.boards, one.crashFreeBoards, one.crashFree, one.connectivity]),
    [
      ['2026-11-10', 1, 0, 0, 0.9167],
      ['2026-11-11', 2, 2, 1, 0.9993],
    ]
  );
  assert.deepEqual(
    perBoard.map((one) => [one.thing, one.active, one.crashFree ?? null, one.newest, one.unread]),
    [
      [A, true, false, true, false],
      [B, true, true, false, false],
      [C, false, null, false, false],
      ['cranium-00000000000000dd', false, null, true, false],
      ['cranium-00000000000000ee', false, null, true, true],
    ]
  );
  assert.equal(perBoard[0].restarts, 4);
  assert.equal(perBoard[0].rssi, -60);
  assert.deepEqual(
    versions.map((one) => [one.version, one.boards, one.crashFreeBoards, one.unexpected, one.perThousandHours]),
    [
      ['1.1.0+0', 1, 1, 0, 0],
      ['1.0.0+0', 2, 1, 1, 23.8],
    ]
  );
});

test('a cohort with under an hour online has no crash rate, and an unknown version goes last', () => {
  const short = boardVitals({
    events: [connected(FROM), disconnected(FROM + 30 * MINUTE)],
    fromMs: FROM,
    toMs: FROM + HOUR,
  });
  const cohorts = versionCohorts([
    { thing: A, versions: short.versions },
    {
      thing: B,
      versions: boardVitals({ events: [], fromMs: FROM, toMs: TO, onlineNow: true, current: '1.0.0+0' }).versions,
    },
  ]);
  assert.deepEqual(
    cohorts.map((one) => [one.version, one.perThousandHours]),
    [
      ['1.0.0+0', 0],
      [null, null],
    ]
  );
});

test("a board's samples by day: the signal's mean and low, the lowest free heap, the longest uptime", () => {
  const days = samplesByDay([
    { at: at(FROM + HOUR), rssi: -50, uptime: 100, heapFree: 20000, heapLeast: 9000 },
    { at: at(FROM + 2 * HOUR), rssi: -61, uptime: 3700, heapFree: 19000, heapLeast: null },
    { at: at(FROM + DAY), rssi: null, uptime: 10, heapFree: null, heapLeast: null },
    { at: 'not a time', rssi: -40 },
  ]);
  assert.deepEqual(days.get('2026-11-10'), {
    samples: 2,
    rssiMean: -55,
    rssiLow: -61,
    heapLeast: 9000,
    uptimeMax: 3700,
  });
  assert.deepEqual(days.get('2026-11-11'), {
    samples: 1,
    rssiMean: null,
    rssiLow: null,
    heapLeast: null,
    uptimeMax: 10,
  });
  const detail = boardDetail(
    boardVitals({ events: BOARD_A, fromMs: FROM, toMs: TO, onlineNow: true, current: '1.1.0+0' }),
    days
  );
  assert.equal(detail.vitals.crashFree, false);
  assert.deepEqual(
    detail.daily.map((one) => [one.day, one.restarts, one.rssiMean, one.samples]),
    [
      ['2026-11-10', 1, -55, 2],
      ['2026-11-11', 3, null, 1],
    ]
  );
  assert.deepEqual(
    detail.versions.map((one) => one.version),
    ['1.1.0+0', '1.0.0+0']
  );
});

// The routes, on the fake: reports and presence go through the recorder as on AWS.

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

async function world() {
  const w = fleetConsole({ startMs: NOW - 3 * DAY });
  const outsider = w.addUser('outsider', []);
  await w.release('1.1.0+0');
  w.fake.addThing(A);
  w.fake.device(A).connect();
  w.fake.device(A).report(report('1.0.0+0', { heap: { free: 21000, least: 9000, size: 44000 }, uptime: 60 }));
  w.advance(HOUR);
  w.fake.device(A).report(report('1.0.0+0', { rssi: -70, uptime: 3660 }));
  // A watchdog reset: the uptime went down, and the diary's cause came straight after.
  w.advance(HOUR);
  w.fake.putEventItem({
    pk: A,
    sk: eventKey(w.clock.ms, 'abcdef'),
    kind: 'restart',
    what: 'boot',
    level: 'warn',
    text: 'Last boot ended by the watchdog',
    cause: '10',
    newBoots: 1,
    version: '1.0.0+0',
    ttl: Math.floor(w.clock.ms / 1000) + 90 * 86_400,
  });
  w.advance(MINUTE);
  w.fake.device(A).disconnect('CONNECTION_LOST');
  w.advance(10 * MINUTE);
  w.fake.device(A).connect();
  w.fake.device(A).report(report('1.1.0+0', { uptime: 30 }));
  // B reported once, three days ago, and was never heard from again.
  w.fake.addThing(B);
  w.fake.device(B).report(report('1.0.0+0'));
  w.clock.ms = NOW;
  w.fake.device(A).report(report('1.1.0+0', { uptime: (2 * DAY) / 1000 }));
  const get = (path, as = w.viewer) => w.call('GET', path, undefined, as);
  return { ...w, outsider, get };
}

test('GET /api/vitals gives the fleet vitals, the days, the boards and the versions to every member', async () => {
  const w = await world();
  for (const as of [w.viewer, w.manager]) {
    const response = await w.get('/api/vitals', as);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const body = response.body;
    assert.equal(body.days, 7);
    assert.equal(body.boards, 2);
    assert.equal(body.unread, 0);
    assert.equal(body.vitals.active, 2);
    // A's watchdog reset is the one unexpected restart; B did nothing wrong.
    assert.deepEqual(body.vitals.crashFree, { boards: 1, of: 2, share: 0.5 });
    assert.equal(body.vitals.unexpected, 1);
    assert.equal(body.vitals.drops, 1);
    // A runs the newest release; B does not.
    assert.deepEqual(body.vitals.newest, { boards: 1, of: 2, share: 0.5 });
    assert.ok(body.vitals.connectivity.share > 0.9 && body.vitals.connectivity.share < 1);
    assert.equal(body.daily.length, 8);
    assert.deepEqual(
      body.perBoard.map((one) => [one.thing, one.version, one.crashFree, one.newest]),
      [
        [A, '1.1.0+0', false, true],
        [B, '1.0.0+0', true, false],
      ]
    );
    assert.deepEqual(
      body.versions.map((one) => [one.version, one.boards, one.unexpected]),
      [
        ['1.1.0+0', 1, 0],
        ['1.0.0+0', 2, 1],
      ]
    );
  }
  assert.equal((await w.get('/api/vitals?days=90')).body.days, 90);
  assert.equal((await w.get('/api/vitals?days=1')).body.daily.length, 2);
});

test("GET /api/vitals/{thing} gives one board's days, with its samples of the last 7 days", async () => {
  const w = await world();
  const response = await w.get(`/api/vitals/${A}?days=30`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const body = response.body;
  assert.equal(body.board.thing, A);
  assert.equal(body.days, 30);
  assert.equal(body.cut, false);
  assert.equal(body.samplesUnread, false);
  assert.equal(body.samplesFrom, at(NOW - 7 * DAY));
  assert.deepEqual([body.vitals.restarts >= 1, body.vitals.unexpected, body.vitals.drops], [true, 1, 1]);
  // Samples are kept 7 days, so a longer window has them for its last 7 only.
  const sampled = body.daily.filter((one) => one.samples > 0);
  assert.deepEqual(
    sampled.map((one) => one.day),
    ['2026-11-09', '2026-11-12']
  );
  assert.equal(sampled[0].rssiLow, -70);
  assert.equal(sampled[0].heapLeast, 9000);
  assert.deepEqual(
    body.versions.map((one) => one.version),
    ['1.1.0+0', '1.0.0+0']
  );
});

test('the vitals routes refuse what they cannot answer, and need a member', async () => {
  const w = await world();
  for (const [path, status, code] of [
    ['/api/vitals?days=0', 400, 'invalid_days'],
    ['/api/vitals?days=91', 400, 'invalid_days'],
    ['/api/vitals?days=x', 400, 'invalid_days'],
    [`/api/vitals/${A}?days=100`, 400, 'invalid_days'],
    [`/api/vitals/${C}`, 404, 'unknown_device'],
    ['/api/vitals/not-a-board', 404, 'unknown_device'],
  ]) {
    const response = await w.get(path);
    assert.deepEqual([response.status, response.body.error?.code], [status, code], path);
  }
  assert.equal((await w.call('GET', '/api/vitals', undefined, null)).status, 401);
  assert.equal((await w.get('/api/vitals', w.outsider)).status, 403);
  assert.equal((await w.get(`/api/vitals/${A}`, w.outsider)).status, 403);
});

test('a board offline when the window began counts that time offline, from its last disconnect before it', async () => {
  const w = fleetConsole({ startMs: NOW - 3 * DAY });
  w.fake.addThing(C);
  w.fake.device(C).connect();
  w.fake.device(C).report(report('1.0.0+0'));
  w.advance(HOUR);
  w.fake.device(C).disconnect('MQTT_KEEP_ALIVE_TIMEOUT');
  // Off for two and a half days, then back 12 hours before now, and online since.
  w.clock.ms = NOW - 12 * HOUR;
  w.fake.device(C).connect();
  w.fake.device(C).report(report('1.0.0+0'));
  w.clock.ms = NOW;
  w.fake.device(C).report(report('1.0.0+0'));
  const day = await w.call('GET', '/api/vitals?days=1', undefined, w.viewer);
  assert.equal(day.status, 200);
  assert.equal(day.body.vitals.connectivity.share, 0.5);
  assert.deepEqual(day.body.vitals.connectivity, { onlineHours: 12, knownHours: 24, share: 0.5 });
  const board = await w.call('GET', `/api/vitals/${C}?days=1`, undefined, w.viewer);
  assert.equal(board.body.vitals.connectivity, 0.5);
  // If that read fails, the time before the connect is unknown again, and the board still counts.
  const query = w.fake.queryEvents;
  w.fake.queryEvents = async (args) => {
    if (args.limit === 1) throw new Error('throttled');
    return query(args);
  };
  const unknown = await w.call('GET', '/api/vitals?days=1', undefined, w.viewer);
  w.fake.queryEvents = query;
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body.vitals.connectivity, { onlineHours: 12, knownHours: 12, share: 1 });
  assert.equal(unknown.body.unread, 0);
});

test('a board whose events cannot be read is left out and counted; a board without samples still answers', async () => {
  const w = await world();
  w.fake.failNext('queryEvents');
  const response = await w.get('/api/vitals');
  assert.equal(response.status, 200);
  assert.equal(response.body.unread, 1);
  assert.equal(response.body.vitals.active, 1);
  assert.equal(response.body.perBoard.filter((one) => one.unread).length, 1);
  w.fake.failNext('querySamples');
  const board = await w.get(`/api/vitals/${A}`);
  assert.equal(board.status, 200);
  assert.equal(board.body.samplesUnread, true);
  assert.ok(board.body.daily.every((one) => one.samples === 0));
});

test('the reads are bounded: one Query per board, of the four kinds, with a limit each, and no samples', async () => {
  const w = await world();
  const before = w.fake.calls.length;
  await w.get('/api/vitals?days=90');
  const queries = w.fake.calls.slice(before).filter((call) => call.method === 'queryEvents');
  // At 90 days nothing older is kept, so no board's state before the window is read.
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.deepEqual(query.args[0].kinds, ['connection', 'restart', 'firmware', 'health']);
    assert.equal(query.args[0].limit, 5000);
  }
  // In 7 days A's first connection event is a connect: one more Query, of the last connection event before the window.
  const week = w.fake.calls.length;
  await w.get('/api/vitals');
  const weekQueries = w.fake.calls.slice(week).filter((call) => call.method === 'queryEvents');
  assert.equal(weekQueries.length, 3);
  const [extra] = weekQueries.filter((call) => call.args[0].limit === 1);
  assert.equal(extra.args[0].thing, A);
  assert.deepEqual(extra.args[0].kinds, ['connection']);
  assert.ok(extra.args[0].high < `E#${at(NOW - 7 * DAY)}`);
  // The fleet's samples are never read: one board's are, on its own page.
  assert.equal(w.fake.calls.slice(before).filter((call) => call.method === 'querySamples').length, 0);
});
