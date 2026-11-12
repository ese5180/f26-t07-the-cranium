// Tests for a board's health as its owner is shown it (src/customer/health.mjs): each restart in a
// plain category, the sentences, the week's window, offline, the cache, and that nothing of the
// board's internals reaches the customer.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RESET_CAUSES } from '../src/lib/shadow.mjs';
import { boardHealth, dayWords, restartCategory, restartsOf } from '../src/customer/health.mjs';
import { createCustomerWorld } from './fake-customers.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Mon 9 Nov 2026, noon UTC.
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

let draws = 0;
const restart = (atMs, fields = {}, what = 'restarted') => ({ at: iso(atMs), kind: 'restart', what, ...fields });
const changed = (atMs, version) => ({ at: iso(atMs), kind: 'firmware', what: 'changed', version, from: '1.14.0+0' });

test('each reset cause is expected or unexpected, and a stuck restart is unexpected', () => {
  const expected = {
    pin: 'reset',
    user: 'reset',
    software: 'restart',
    power_on: 'power',
    debugger: 'restart',
    wake: 'restart',
  };
  const unexpected = [
    'brownout',
    'watchdog',
    'lockup',
    'security',
    'parity',
    'pll',
    'clock',
    'hardware',
    'temperature',
  ];
  assert.equal(Object.keys(expected).length + unexpected.length, RESET_CAUSES.length, 'every cause is decided');
  for (const [bit, name] of RESET_CAUSES) {
    const category = restartCategory(restart(NOW, { cause: bit.toString(16) }));
    if (unexpected.includes(name)) {
      assert.deepEqual([category.unexpected, category.why], [true, 'problem'], name);
    } else {
      assert.deepEqual([category.unexpected, category.why], [false, expected[name]], name);
    }
  }
  // No bit at all is a power-on; the reset pin and the watchdog together is the watchdog.
  assert.equal(restartCategory(restart(NOW, { cause: '0' })).why, 'power');
  assert.equal(restartCategory(restart(NOW, { cause: '11' })).unexpected, true);
  assert.equal(restartCategory(restart(NOW, { cause: '10' }, 'boot')).unexpected, true);
  assert.deepEqual(restartCategory(restart(NOW, { count: 1, reason: 'no_cloud' }, 'stuck')).unexpected, true);
  // A restart the board gave no cause for is not counted against it.
  assert.equal(restartCategory(restart(NOW)).unexpected, false);
  assert.equal(restartCategory({ at: iso(NOW), kind: 'firmware', what: 'changed' }), null);
});

test('a restart and the diary entry that says why are one restart; a software restart near an update is the update', () => {
  const restarts = restartsOf([
    restart(NOW - 3 * HOUR),
    restart(NOW - 3 * HOUR + 30_000, { cause: '10', newBoots: 1 }, 'boot'),
    restart(NOW - 2 * DAY, { cause: '2' }),
    changed(NOW - 2 * DAY + 20_000, '1.15.0+0'),
    restart(NOW - 4 * DAY, { cause: '2' }),
  ]);
  assert.deepEqual(
    restarts.map(({ unexpected, why }) => [unexpected, why]),
    [
      [false, 'restart'],
      [false, 'update'],
      [true, 'problem'],
    ]
  );
  // Two restarts minutes apart are two.
  assert.equal(restartsOf([restart(NOW - 5 * MINUTE, { cause: '10' }), restart(NOW, { cause: '10' })]).length, 2);
});

test('the sentences', () => {
  const at = (events, status = 'online', lastSeen = iso(NOW)) => boardHealth({ status, lastSeen, events, nowMs: NOW });

  assert.deepEqual(at([]), { state: 'ok', summary: 'Running normally', unexpectedRestarts7d: 0, restarts7d: [] });
  // Expected restarts only: still running normally.
  assert.equal(
    at([restart(NOW - HOUR, { cause: '8' }), restart(NOW - DAY, { cause: '1' })]).summary,
    'Running normally'
  );

  const twice = at([restart(NOW - 2 * DAY, { cause: '10' }), restart(NOW - 3 * DAY, { cause: '100' })]);
  assert.deepEqual(
    [twice.state, twice.summary, twice.unexpectedRestarts7d, twice.lastIssueAt],
    ['attention', 'Restarted unexpectedly twice this week', 2, iso(NOW - 2 * DAY)]
  );
  assert.equal(
    at([1, 2, 3].map((n) => restart(NOW - n * HOUR, { cause: '10' }))).summary,
    'Restarted unexpectedly 3 times this week'
  );
  // One, today: attention. One, days ago and running since: recovered.
  assert.equal(at([restart(NOW - 2 * HOUR, { cause: '10' })]).summary, 'Restarted unexpectedly once this week');
  const recovered = at([restart(Date.UTC(2026, 10, 3, 9), { count: 1, reason: 'wifi_silent' }, 'stuck')]);
  assert.deepEqual([recovered.state, recovered.summary], ['ok', 'Recovered from a problem on Tue 3 Nov']);

  const updated = at([
    restart(Date.UTC(2026, 10, 5, 8), { cause: '2' }),
    changed(Date.UTC(2026, 10, 5, 8, 1), '1.15.0+0'),
  ]);
  assert.deepEqual(
    [updated.state, updated.summary, updated.updatedTo, updated.unexpectedRestarts7d],
    ['ok', 'Updated to 1.15.0 on Thu 5 Nov', { version: '1.15.0', at: iso(Date.UTC(2026, 10, 5, 8, 1)) }, 0]
  );
  assert.equal(at([], 'updating').summary, 'Installing an update');

  const offline = at([restart(NOW - 3 * DAY, { cause: '10' })], 'offline', iso(Date.UTC(2026, 10, 7, 22)));
  assert.deepEqual(
    [offline.state, offline.summary, offline.unexpectedRestarts7d],
    ['offline', 'Offline since Sat 7 Nov', 1]
  );
  assert.deepEqual([at([], 'new', null).state, at([], 'new', null).summary], ['offline', 'Not heard from yet']);
  assert.equal(dayWords('2026-11-03T23:59:59.000Z'), 'Tue 3 Nov');
});

test('only the last seven days count', () => {
  const health = boardHealth({
    status: 'online',
    lastSeen: iso(NOW),
    events: [
      restart(NOW - 7 * DAY - MINUTE, { cause: '10' }),
      changed(NOW - 8 * DAY, '1.14.0+0'),
      restart(NOW - 7 * DAY + MINUTE, { cause: '8' }),
    ],
    nowMs: NOW,
  });
  assert.deepEqual(health, {
    state: 'ok',
    summary: 'Running normally',
    unexpectedRestarts7d: 0,
    restarts7d: [{ at: iso(NOW - 7 * DAY + MINUTE), unexpected: false }],
  });
});

// Through the customer API.

const BOARD = 'cranium-00000000000000aa';

function putEvent(w, atMs, fields) {
  draws += 1;
  const random = draws.toString(16).padStart(6, '0');
  w.fake.putEventItem({ pk: BOARD, sk: `E#${iso(atMs)}#${random}`, text: 'Written for the console', ...fields });
}

async function boardWorld() {
  // Ada has had the board for longer than the week its health covers.
  const w = createCustomerWorld({ startMs: NOW - 8 * DAY });
  const admin = w.addStaff('admin', ['release-managers']);
  const ada = w.addCustomer('ada', { name: 'Ada' });
  w.fake.addThing(BOARD);
  const assigned = await w.console('POST', `/api/customers/${ada.sub}/boards`, { as: admin, body: { thing: BOARD } });
  assert.equal(assigned.status, 200);
  w.advance(8 * DAY);
  // The board is on line now, with the week being read in each test.
  w.fake.device(BOARD).connect();
  w.fake.device(BOARD).report({
    fw: { version: '1.15.0+0', confirmed: true },
    uptime: 600,
    diag: { id: 'CRADA01', mac: 'f4:ce:36:12:34:56', channel: 6, heap: { free: 21000, least: 9000, size: 44000 } },
  });
  return { w, ada };
}

test('a board in the API has its health, and nothing of a fault reaches the customer', async () => {
  const { w, ada } = await boardWorld();
  putEvent(w, NOW - 2 * DAY, {
    kind: 'restart',
    what: 'restarted',
    level: 'warn',
    cause: '10',
    upFor: 3600,
    text: 'Restarted after 1 h up. Last boot ended by the watchdog; it had reached the cloud',
  });
  putEvent(w, NOW - DAY, { kind: 'restart', what: 'stuck', level: 'warn', count: 1, reason: 'no_cloud' });
  w.advance(MINUTE);

  const list = await w.customer('/api/c/boards', { as: ada });
  assert.equal(list.status, 200);
  const [board] = list.body.boards;
  assert.deepEqual(Object.keys(board.health).sort(), [
    'lastIssueAt',
    'restarts7d',
    'state',
    'summary',
    'unexpectedRestarts7d',
  ]);
  assert.deepEqual(
    [board.health.state, board.health.summary, board.health.unexpectedRestarts7d],
    ['attention', 'Restarted unexpectedly twice this week', 2]
  );
  const single = await w.customer(`/api/c/boards/${board.id}`, { as: ada });
  assert.deepEqual(single.body.board.health, board.health);

  for (const body of [list.body, single.body]) {
    const text = JSON.stringify(body);
    for (const secret of [
      'cranium-',
      'thing',
      'f4:ce:36',
      'watchdog',
      'Watchdog',
      'no_cloud',
      'BusFault',
      'Fault',
      'cause',
      'reason',
      'upFor',
      'stack',
      'coredump',
      'Last boot',
      'Written for the console',
    ]) {
      assert.equal(text.includes(secret), false, `${secret} in ${text}`);
    }
  }
});

test("a board's health is read at most once a minute, and an unreadable week leaves it without one", async () => {
  const { w, ada } = await boardWorld();
  const reads = () => w.fake.calls.filter((call) => call.method === 'queryEvents').length;
  await w.customer('/api/c/boards', { as: ada });
  const first = reads();
  await w.customer('/api/c/boards', { as: ada });
  assert.equal(reads(), first, 'the second read within the minute is kept');

  putEvent(w, NOW + 10_000, { kind: 'restart', what: 'restarted', cause: '10' });
  w.advance(MINUTE);
  const later = await w.customer('/api/c/boards', { as: ada });
  assert.equal(later.body.boards[0].health.unexpectedRestarts7d, 1);
  assert.ok(reads() > first);

  // Offline: unheard for more than 90 s.
  w.advance(2 * MINUTE);
  const offline = await w.customer('/api/c/boards', { as: ada });
  assert.equal(offline.body.boards[0].health.state, 'offline');
  assert.match(offline.body.boards[0].health.summary, /^Offline since Mon 9 Nov$/);

  w.fake.failNext('queryEvents');
  w.advance(MINUTE);
  const failed = await w.customer('/api/c/boards', { as: ada });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.boards[0].health, null);
});
