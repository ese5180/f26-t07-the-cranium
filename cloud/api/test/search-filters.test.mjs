// Tests for searching and filtering the long lists (docs/search-filters.md): the activity log, the boards'
// events and their own log. Each filter is checked, and each is part of a Query of the list's key with a page
// and a cursor, never a Scan.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SEARCH_BUDGET } from '../src/handlers/audit.mjs';
import { auditItem } from '../src/lib/audit.mjs';
import {
  MAX_SEARCH,
  holdsSearch,
  requireActions,
  requireAuditRange,
  requireLevel,
  requireOutcomes,
  requireSearch,
  searchSpellings,
} from '../src/lib/validate.mjs';
import { createTestConsole } from './fake-aws.mjs';

const THING = 'cranium-0123456789abcdef';
const OTHER = 'cranium-fedcba9876543210';
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const DAY = 86_400_000;
const MINUTE = 60_000;

const codeOf = (run) => {
  try {
    run();
  } catch (error) {
    return error.code;
  }
  return null;
};

// The grammar.

test('search text is one line of 1 to 100 characters, trimmed, and absent is no search', () => {
  assert.equal(requireSearch(undefined), null);
  assert.equal(requireSearch('  Wi-Fi  '), 'Wi-Fi');
  assert.equal(requireSearch('x'.repeat(MAX_SEARCH)), 'x'.repeat(MAX_SEARCH));
  for (const bad of ['', '   ', 'x'.repeat(MAX_SEARCH + 1), 'two\nlines', 'tab\there', ['a']]) {
    assert.equal(
      codeOf(() => requireSearch(bad)),
      'invalid_search',
      JSON.stringify(bad)
    );
  }
});

test('a search finds its text as written, in small letters, in capitals and with a capital first letter', () => {
  assert.deepEqual(searchSpellings('wifi'), ['wifi', 'WIFI', 'Wifi']);
  assert.deepEqual(searchSpellings('Download'), ['Download', 'download', 'DOWNLOAD']);
  assert.ok(searchSpellings('mIxEd').length <= 4);
  assert.equal(holdsSearch('WIFI connected', 'wifi'), true);
  assert.equal(holdsSearch('Download stalled', 'download'), true);
  assert.equal(holdsSearch('nothing here', 'wifi'), false);
  assert.equal(holdsSearch(undefined, 'wifi'), false);
});

test('levels, actions, outcomes and the range of the log are checked, each with its own code', () => {
  assert.equal(requireLevel(undefined), null);
  assert.equal(requireLevel('warn'), 'warn');
  assert.equal(requireLevel('info'), 'info');
  assert.equal(
    codeOf(() => requireLevel('error')),
    'invalid_level'
  );
  const known = ['firmware.upload', 'token.create'];
  assert.deepEqual(requireActions('token.create,firmware.upload', known), ['token.create', 'firmware.upload']);
  for (const bad of ['', 'nope', 'token.create,token.create', 'token.create,']) {
    assert.equal(
      codeOf(() => requireActions(bad, known)),
      'invalid_actions',
      bad
    );
  }
  assert.deepEqual(requireOutcomes('ok,denied', ['ok', 'rejected', 'denied', 'error']), ['ok', 'denied']);
  assert.equal(
    codeOf(() => requireOutcomes('fine', ['ok'])),
    'invalid_outcomes'
  );
  assert.deepEqual(requireAuditRange(undefined, undefined), { fromMs: null, toMs: null });
  assert.deepEqual(requireAuditRange('2026-11-01T00:00:00Z', undefined), {
    fromMs: Date.UTC(2026, 10, 1),
    toMs: null,
  });
  assert.equal(
    codeOf(() => requireAuditRange('2026-11-02T00:00:00Z', '2026-11-01T00:00:00Z')),
    'invalid_range'
  );
  assert.equal(
    codeOf(() => requireAuditRange('yesterday', undefined)),
    'invalid_time'
  );
});

// The activity log.

/** A console whose log holds `count` entries a minute apart, the newest a minute before now. */
function logOf(count, make) {
  const console_ = createTestConsole({ startMs: NOW });
  const viewer = console_.addUser('viewer', ['viewers']);
  for (let index = 0; index < count; index += 1) {
    const entry = make(index);
    console_.fake.putAudit(
      auditItem({
        at: NOW - (index + 1) * MINUTE,
        requestId: `req-${String(index).padStart(5, '0')}`,
        actor: { sub: entry.sub ?? 'sub-1', email: entry.email ?? 'ada@example.com' },
        action: entry.action ?? 'firmware.upload',
        target: entry.target ?? '1.2.3+4',
        outcome: entry.outcome ?? 'ok',
        detail: {},
      })
    );
  }
  const ask = (query) => console_.call('GET', '/api/audit', { as: viewer, query });
  return { console_, viewer, ask };
}

const reqs = (body) => body.entries.map((entry) => Number(entry.requestId.slice(4)));

test('GET /api/audit with no filter reads as before: no search, no `read`, of both partitions', async () => {
  const { console_, ask } = logOf(3, () => ({}));
  const { status, body } = await ask({ limit: '2' });
  assert.equal(status, 200);
  assert.deepEqual(reqs(body), [0, 1]);
  assert.equal('read' in body, false);
  assert.deepEqual(
    console_.fake.methodsCalled().filter((name) => name.endsWith('Audit')),
    // The console's own entries, and what customers did (lib/audit.mjs CUSTOMER_ACTIONS_PK).
    ['putAudit', 'putAudit', 'putAudit', 'queryAudit', 'queryAudit']
  );
});

test('GET /api/audit filters by action, outcome and text, in any case, newest first, with how many it read', async () => {
  const { ask } = logOf(
    6,
    (index) =>
      [
        { action: 'token.create', target: 'tok-1' },
        { action: 'firmware.upload', outcome: 'denied', email: 'bob@example.com' },
        { action: 'deployment.create', target: 'cranium-1-2-3-b4-20261109T110000Z-ab12' },
        { action: 'firmware.upload', target: '1.5.0+2' },
        { action: 'token.revoke', outcome: 'rejected' },
        { action: 'account.sign_in', email: 'Carol@Example.com' },
      ][index]
  );
  assert.deepEqual(reqs((await ask({ actions: 'firmware.upload' })).body), [1, 3]);
  assert.deepEqual(reqs((await ask({ actions: 'token.create,token.revoke' })).body), [0, 4]);
  assert.deepEqual(reqs((await ask({ outcomes: 'denied,rejected' })).body), [1, 4]);
  assert.deepEqual(reqs((await ask({ q: 'BOB' })).body), [1]);
  assert.deepEqual(reqs((await ask({ q: 'carol' })).body), [5]);
  assert.deepEqual(reqs((await ask({ q: '1.5.0' })).body), [3]);
  assert.deepEqual(reqs((await ask({ q: 'req-00002' })).body), [2]);
  assert.deepEqual(reqs((await ask({ q: 'example', outcomes: 'ok', actions: 'account.sign_in' })).body), [5]);
  const { body } = await ask({ q: 'nothing like it' });
  assert.deepEqual(body, { entries: [], next: null, read: 6 });
});

test('GET /api/audit from and to are a range of the key: both ends kept, and nothing outside read', async () => {
  const { console_, ask } = logOf(10, () => ({}));
  const at = (index) => new Date(NOW - (index + 1) * MINUTE).toISOString();
  const { body } = await ask({ from: at(6), to: at(3) });
  assert.deepEqual(reqs(body), [3, 4, 5, 6]);
  assert.equal(body.read, 4);
  const search = console_.fake.calls.filter((call) => call.method === 'searchAudit').at(-1).args[0];
  assert.equal(search.low, at(6));
  assert.equal(search.high, `${at(3)}#~`);
  assert.equal(search.budget, SEARCH_BUDGET);
  assert.deepEqual(reqs((await ask({ from: at(2) })).body), [0, 1, 2]);
  assert.deepEqual(reqs((await ask({ to: at(8) })).body), [8, 9]);
  // A range in the future, or before the log began, is empty, and a backwards one is refused.
  assert.deepEqual(reqs((await ask({ from: new Date(NOW + DAY).toISOString() })).body), []);
  assert.equal((await ask({ from: at(1), to: at(5) })).body.error.code, 'invalid_range');
});

test('GET /api/audit pages a search with its cursor, and a page never repeats or skips an entry', async () => {
  const { ask } = logOf(9, (index) => ({ outcome: index % 3 === 0 ? 'denied' : 'ok' }));
  const seen = [];
  let before;
  for (let page = 0; page < 5; page += 1) {
    const { body } = await ask(
      before === undefined ? { limit: '2', outcomes: 'ok' } : { limit: '2', outcomes: 'ok', before }
    );
    assert.ok(body.entries.length <= 2);
    seen.push(...reqs(body));
    if (body.next === null) break;
    before = body.next;
  }
  assert.deepEqual(seen, [1, 2, 4, 5, 7, 8]);
});

test(`GET /api/audit reads at most ${SEARCH_BUDGET} entries a page, and goes on from where it stopped`, async () => {
  // Only the oldest entry matches: the first page reads the budget, finds nothing, and says where to go on.
  const count = SEARCH_BUDGET + 5;
  const { ask } = logOf(count, (index) => ({ target: index === count - 1 ? 'the-one' : '1.2.3+4' }));
  const first = (await ask({ q: 'the-one' })).body;
  assert.deepEqual(first.entries, []);
  assert.equal(first.read, SEARCH_BUDGET);
  assert.equal(typeof first.next, 'string');
  const second = (await ask({ q: 'the-one', before: first.next })).body;
  assert.deepEqual(reqs(second), [count - 1]);
  // The five left, and the entry the cursor names, read again at the top of the range and left out.
  assert.equal(second.read, 6);
  assert.equal(second.next, null);
});

test('GET /api/audit refuses a filter it cannot read, with a code the console has words for', async () => {
  const { ask } = logOf(1, () => ({}));
  const refused = async (query, code) => {
    const answer = await ask(query);
    assert.deepEqual([answer.status, answer.body.error?.code], [400, code], JSON.stringify(query));
  };
  await refused({ q: '' }, 'invalid_search');
  await refused({ q: 'x'.repeat(MAX_SEARCH + 1) }, 'invalid_search');
  await refused({ actions: 'firmware.delete' }, 'invalid_actions');
  await refused({ outcomes: 'maybe' }, 'invalid_outcomes');
  await refused({ from: '2026-13-01T00:00:00Z' }, 'invalid_time');
  await refused({ q: 'x', limit: '500' }, 'invalid_limit');
  await refused({ q: 'x', before: 'not-a-cursor!' }, 'invalid_cursor');
});

// The events and the board log.

function boards() {
  const console_ = createTestConsole({ startMs: NOW - DAY });
  const { fake } = console_;
  fake.addThing(THING);
  fake.addThing(OTHER);
  console_.advance(DAY / 2);
  fake.device(THING).connect();
  fake.device(THING).log('WIFI', 'connected ip=10.0.0.7 rssi=-51');
  console_.advance(1000);
  fake.device(THING).log('ota', 'WRN: Download stalled at 40%');
  console_.advance(1000);
  fake.device(OTHER).connect();
  fake.device(OTHER).log('app', 'Connected to AWS IoT');
  console_.advance(1000);
  fake.device(OTHER).log('ota', 'Download done');
  console_.advance(DAY / 2 - 10_000);
  const viewer = console_.addUser('viewer', ['viewers']);
  return { console_, viewer };
}

const texts = (lines) => lines.map((line) => line.text);

test('GET /api/events/log finds text in any case and narrows to warnings, as part of each board’s Query', async () => {
  const { console_, viewer } = boards();
  const ask = (query) => console_.call('GET', '/api/events/log', { as: viewer, query });
  assert.deepEqual(texts((await ask({ q: 'download' })).body.lines), ['Download done', 'WRN: Download stalled at 40%']);
  assert.deepEqual(texts((await ask({ q: 'CONNECTED' })).body.lines), [
    'Connected to AWS IoT',
    'connected ip=10.0.0.7 rssi=-51',
  ]);
  assert.deepEqual(texts((await ask({ level: 'warn' })).body.lines), ['WRN: Download stalled at 40%']);
  assert.deepEqual(texts((await ask({ level: 'info', q: 'download' })).body.lines), ['Download done']);
  assert.deepEqual(texts((await ask({ q: 'download', thing: OTHER })).body.lines), ['Download done']);
  // The source is searched too.
  assert.deepEqual(texts((await ask({ q: 'wifi' })).body.lines), ['connected ip=10.0.0.7 rssi=-51']);
  const queries = console_.fake.calls.filter((call) => call.method === 'queryEvents').map((call) => call.args[0]);
  assert.ok(queries.some((query) => query.text === 'download' && query.level === undefined));
  assert.ok(queries.some((query) => query.level === 'warn'));

  // Paged: one at a time, the same lines, in the same order.
  const seen = [];
  let cursor;
  for (let page = 0; page < 5; page += 1) {
    const { body } = await ask(
      cursor === undefined ? { q: 'download', limit: '1' } : { q: 'download', limit: '1', cursor }
    );
    seen.push(...texts(body.lines));
    if (body.cursor === null) break;
    cursor = body.cursor;
  }
  assert.deepEqual(seen, ['Download done', 'WRN: Download stalled at 40%']);
});

test('GET /api/events takes the same search and level, and refuses bad ones', async () => {
  const { console_, viewer } = boards();
  const ask = (query) => console_.call('GET', '/api/events', { as: viewer, query });
  const all = (await ask({})).body.events;
  assert.ok(all.length >= 2);
  const connected = (await ask({ q: 'connected' })).body.events;
  assert.ok(connected.length >= 1);
  assert.ok(connected.every((event) => holdsSearch(`${event.text} ${event.what}`, 'connected')));
  assert.deepEqual((await ask({ q: 'zzz-nothing' })).body.events, []);
  assert.ok((await ask({ level: 'info' })).body.events.every((event) => event.level === 'info'));
  for (const [query, code] of [
    [{ q: '' }, 'invalid_search'],
    [{ q: 'a\u0000b' }, 'invalid_search'],
    [{ level: 'loud' }, 'invalid_level'],
  ]) {
    const answer = await ask(query);
    assert.deepEqual([answer.status, answer.body.error?.code], [400, code], JSON.stringify(query));
    const log = await console_.call('GET', '/api/events/log', { as: viewer, query });
    assert.deepEqual([log.status, log.body.error?.code], [400, code], JSON.stringify(query));
  }
});
