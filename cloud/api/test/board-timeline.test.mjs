// Tests for a board's version timeline: the stays made from its update history (src/lib/board-timeline.mjs)
// and GET /api/devices/{thing}/timeline (src/handlers/timeline.mjs): order, how each version arrived,
// confirmed or rolled back, the counts of its warnings, pages, what it refuses and who may read it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  boardTimeline,
  decodeTimelineCursor,
  encodeTimelineCursor,
  timelinePageSize,
  versionStays,
} from '../src/lib/board-timeline.mjs';
import { eventKey } from '../src/lib/events.mjs';
import { createTestConsole } from './fake-aws.mjs';

const THING = 'cranium-0123456789abcdef';
const OTHER = 'cranium-fedcba9876543210';
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const JOB = 'cranium-1-13-0-b0-20261104T150000Z-ab12';

const record = (how, from, to, outcome, startedAt, endedAt = startedAt + HOUR, extra = {}) => ({
  how,
  from,
  to,
  outcome,
  startedAt,
  endedAt,
  ...extra,
});
const warning = (kind, atMs) => ({ kind, level: 'warn', at: new Date(atMs).toISOString() });
const brief = (stay) => [stay.version, stay.arrived, stay.status, stay.current];

// The rules, without AWS.

test('a timeline runs in time order: the first version before the history, then each update the board kept', () => {
  // Given newest first, as the update history keeps them.
  const records = [
    record('bluetooth', '1.13.0+0', '1.14.0+0', 'kept', NOW - 2 * DAY),
    record('deployment', '1.12.0+0', '1.13.0+0', 'kept', NOW - 5 * DAY, NOW - 5 * DAY + HOUR, { deployment: JOB }),
    record('usb_or_other', '1.11.0+0', '1.12.0+0', 'kept', NOW - 9 * DAY),
  ];
  const stays = versionStays({ records, current: { version: '1.14.0+0', confirmed: true } });
  assert.deepEqual(stays.map(brief), [
    ['1.11.0+0', 'setup', 'confirmed', false],
    ['1.12.0+0', 'usb', 'confirmed', false],
    ['1.13.0+0', 'ota', 'confirmed', false],
    ['1.14.0+0', 'bluetooth', 'confirmed', true],
  ]);
  // Each ends where the next begins; the first's start is not known, the current one has no end.
  assert.equal(stays[0].startMs, null);
  assert.equal(stays[0].endMs, NOW - 9 * DAY);
  assert.equal(stays[2].startMs, NOW - 5 * DAY);
  assert.equal(stays[2].deployment, JOB);
  assert.equal(stays[1].deployment, null);
  assert.equal(stays[3].endMs, null);
});

test('an update that rolled back is a short stay, and the version before it comes back by rollback', () => {
  const records = [
    record('deployment', '1.12.0+0', '1.13.0+0', 'rolled_back', NOW - 3 * DAY, NOW - 3 * DAY + 600_000),
    record('bluetooth', '1.12.0+0', '1.12.5+0', 'not_installed', NOW - 4 * DAY),
    record('usb_or_other', '1.11.0+0', '1.12.0+0', 'kept', NOW - 6 * DAY),
  ];
  const stays = versionStays({ records, current: { version: '1.12.0+0', confirmed: true } });
  // The one not installed changes nothing.
  assert.deepEqual(stays.map(brief), [
    ['1.11.0+0', 'setup', 'confirmed', false],
    ['1.12.0+0', 'usb', 'confirmed', false],
    ['1.13.0+0', 'ota', 'rolled_back', false],
    ['1.12.0+0', 'rollback', 'confirmed', true],
  ]);
  assert.equal(stays[2].endMs, NOW - 3 * DAY + 600_000);
  assert.equal(stays[3].startMs, NOW - 3 * DAY + 600_000);
});

test('a release that rebuilds an older version arrives as a rollback; a trial is confirmed by the next update', () => {
  const releases = [
    { version: '1.13.2+0', notes: 'Rebuild of 1.12.0' },
    { version: '1.13.0+0', notes: '' },
  ];
  const records = [
    record('deployment', '1.13.0+0', '1.13.2+0', 'pending', NOW - DAY, null),
    record('bluetooth', '1.12.0+0', '1.13.0+0', 'pending', NOW - 3 * DAY, null),
  ];
  const stays = versionStays({ records, releases, current: { version: '1.13.2+0', confirmed: false } });
  assert.deepEqual(stays.map(brief), [
    ['1.12.0+0', 'setup', 'confirmed', false],
    // The board started an update from it, which it does only from firmware it confirmed.
    ['1.13.0+0', 'bluetooth', 'confirmed', false],
    ['1.13.2+0', 'rollback', 'trial', true],
  ]);
});

test('a version the history never shows arriving, and a board with no history at all', () => {
  const records = [record('bluetooth', '1.12.0+0', '1.13.0+0', 'kept', NOW - 3 * DAY)];
  const stays = versionStays({ records, current: { version: '1.14.0+0', confirmed: true } });
  assert.deepEqual(stays.map(brief), [
    ['1.12.0+0', 'setup', 'confirmed', false],
    ['1.13.0+0', 'bluetooth', 'confirmed', false],
    ['1.14.0+0', 'usb', 'confirmed', true],
  ]);
  // Its end is not known, nor its start.
  assert.equal(stays[1].endMs, null);
  assert.equal(stays[2].startMs, null);
  assert.deepEqual(versionStays({ records: [], current: { version: '1.0.0+0', confirmed: true } }).map(brief), [
    ['1.0.0+0', 'setup', 'confirmed', true],
  ]);
  assert.deepEqual(versionStays({ records: [], current: null }), []);
});

test('the unexpected restarts and issues of each version, newest first, and none for a stay before events were kept', () => {
  const records = [
    record('bluetooth', '1.12.0+0', '1.13.0+0', 'kept', NOW - 2 * DAY),
    record('usb_or_other', '1.11.0+0', '1.12.0+0', 'kept', NOW - 10 * DAY),
    record('usb_or_other', '1.10.0+0', '1.11.0+0', 'kept', NOW - 200 * DAY),
  ];
  const events = [
    warning('restart', NOW - HOUR),
    warning('restart', NOW - 3 * HOUR),
    warning('health', NOW - 5 * HOUR),
    warning('restart', NOW - 5 * DAY),
    warning('update', NOW - 6 * DAY),
    { kind: 'restart', level: 'info', at: new Date(NOW - 4 * DAY).toISOString() },
    warning('connection', NOW - 4 * DAY),
  ];
  const timeline = boardTimeline({ records, current: { version: '1.13.0+0', confirmed: true }, events, nowMs: NOW });
  assert.deepEqual(
    timeline.map((stay) => [stay.version, stay.reboots, stay.issues]),
    [
      ['1.13.0+0', 2, 1],
      ['1.12.0+0', 1, 1],
      // Began before events were kept: counted from then on.
      ['1.11.0+0', 0, 0],
      // Ended before then: not known.
      ['1.10.0+0', null, null],
    ]
  );
  assert.equal(timeline[2].countedFrom, new Date(NOW - 90 * DAY).toISOString());
  assert.equal(timeline[0].countedFrom, new Date(NOW - 2 * DAY).toISOString());
  assert.equal(timeline[0].startedAt, new Date(NOW - 2 * DAY).toISOString());
  assert.equal(timeline[0].endedAt, null);
});

test('a page size is 1 to 50, and only a cursor of this list is taken back', () => {
  assert.equal(timelinePageSize(undefined), 20);
  assert.equal(timelinePageSize('50'), 50);
  for (const text of ['0', '51', 'ten', '-1', '1.5', '']) assert.equal(timelinePageSize(text), null, text);
  assert.equal(decodeTimelineCursor(encodeTimelineCursor(20)), 20);
  for (const text of [
    'nope!',
    '',
    'a'.repeat(50),
    Buffer.from('updates|20').toString('base64url'),
    encodeTimelineCursor(0),
  ]) {
    assert.equal(decodeTimelineCursor(text), null, text);
  }
});

// The route.

function setup() {
  const console_ = createTestConsole({ startMs: NOW - 30 * DAY });
  const viewer = console_.addUser('viewer', ['viewers']);
  const manager = console_.addUser('vihaan.ravishankar', ['release-managers']);
  console_.fake.addThing(THING);
  console_.fake.addThing(OTHER);
  const get = (path, query, as = viewer) => console_.call('GET', path, { as, query });
  return { ...console_, viewer, manager, get };
}

function item(atMs, fields, random = '00000a') {
  return {
    pk: THING,
    sk: eventKey(atMs, random),
    level: 'info',
    text: 'Something',
    ttl: Math.floor(atMs / 1000) + 90 * 86_400,
    ...fields,
  };
}

/** USB from 1.11.0 to 1.12.0, kept; 1.13.0 by USB, rolled back; a restart and a low memory warning on 1.12.0. */
function history() {
  return [
    item(NOW - 10 * DAY, { kind: 'firmware', what: 'reported', version: '1.11.0+0', confirmed: true }, '000001'),
    item(NOW - 8 * DAY, { kind: 'firmware', what: 'changed', version: '1.12.0+0', from: '1.11.0+0', confirmed: false }),
    item(
      NOW - 8 * DAY + 60_000,
      { kind: 'firmware', what: 'confirmed', version: '1.12.0+0', confirmed: true },
      '000002'
    ),
    item(NOW - 6 * DAY, { kind: 'restart', what: 'restarted', level: 'warn', cause: 'watchdog' }, '000003'),
    item(NOW - 5 * DAY, { kind: 'health', what: 'heap_low', level: 'warn' }, '000004'),
    item(
      NOW - 3 * DAY,
      { kind: 'firmware', what: 'changed', version: '1.13.0+0', from: '1.12.0+0', confirmed: false },
      '000005'
    ),
    item(
      NOW - 3 * DAY + 300_000,
      { kind: 'firmware', what: 'changed', version: '1.12.0+0', from: '1.13.0+0', confirmed: true },
      '000006'
    ),
    item(NOW - DAY, { kind: 'connection', what: 'disconnected', level: 'warn' }, '000007'),
  ];
}

test('GET /api/devices/{thing}/timeline: newest first, how each version came and whether it stayed', async () => {
  const context = setup();
  const { fake } = context;
  context.clock.ms = NOW;
  for (const event of history()) fake.putEventItem(event);
  fake.device(THING).setRaw({ state: { reported: { fw: { version: '1.12.0+0', confirmed: true } } } });

  const { status, body } = await context.get(`/api/devices/${THING}/timeline`);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.thing, THING);
  assert.equal(body.current, '1.12.0+0');
  assert.deepEqual(
    body.versions.map((stay) => [stay.version, stay.arrived, stay.status, stay.current]),
    [
      ['1.12.0+0', 'rollback', 'confirmed', true],
      ['1.13.0+0', 'usb', 'rolled_back', false],
      ['1.12.0+0', 'usb', 'confirmed', false],
      ['1.11.0+0', 'setup', 'confirmed', false],
    ]
  );
  // The watchdog restart and the low memory were on 1.12.0, before the try of 1.13.0.
  assert.deepEqual([body.versions[2].reboots, body.versions[2].issues], [1, 1]);
  assert.deepEqual([body.versions[0].reboots, body.versions[0].issues], [0, 0]);
  // Times in order: each stay begins where the one before it ended.
  for (let at = 0; at < body.versions.length - 1; at += 1) {
    assert.equal(body.versions[at].startedAt, body.versions[at + 1].endedAt);
  }
  assert.equal(body.cursor, null);
  assert.equal(body.generatedAt, new Date(NOW).toISOString());
  // A read: on no record.
  assert.equal(fake.auditLog().length, 0);
});

test('GET /api/devices/{thing}/timeline pages, each version once', async () => {
  const context = setup();
  const { fake } = context;
  context.clock.ms = NOW;
  for (const event of history()) fake.putEventItem(event);
  fake.device(THING).setRaw({ state: { reported: { fw: { version: '1.12.0+0', confirmed: true } } } });
  const seen = [];
  let cursor;
  for (let pages = 0; pages < 5; pages += 1) {
    const { status, body } = await context.get(`/api/devices/${THING}/timeline`, {
      limit: '3',
      ...(cursor ? { cursor } : {}),
    });
    assert.equal(status, 200);
    assert.ok(body.versions.length <= 3);
    seen.push(...body.versions);
    cursor = body.cursor;
    if (cursor === null) break;
  }
  assert.deepEqual(
    seen.map((stay) => stay.version),
    ['1.12.0+0', '1.13.0+0', '1.12.0+0', '1.11.0+0']
  );
});

test('GET /api/devices/{thing}/timeline refuses what it cannot answer, and needs a member', async () => {
  const context = setup();
  context.clock.ms = NOW;
  for (const [path, query, code, status] of [
    [`/api/devices/${THING}/timeline`, { limit: '0' }, 'invalid_limit', 400],
    [`/api/devices/${THING}/timeline`, { limit: '51' }, 'invalid_limit', 400],
    [`/api/devices/${THING}/timeline`, { cursor: 'nope' }, 'invalid_cursor', 400],
    ['/api/devices/cranium-XYZ/timeline', undefined, 'invalid_thing', 400],
    ['/api/devices/cranium-1111111111111111/timeline', undefined, 'unknown_device', 404],
  ]) {
    const response = await context.get(path, query);
    assert.deepEqual([response.status, response.body.error.code], [status, code], path);
  }
  // A board that never reported has an empty timeline, for viewers and release managers alike.
  for (const as of [context.viewer, context.manager]) {
    const empty = await context.get(`/api/devices/${OTHER}/timeline`, undefined, as);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.versions, []);
  }
  const nobody = await context.call('GET', `/api/devices/${THING}/timeline`);
  assert.equal(nobody.status, 401);
});
