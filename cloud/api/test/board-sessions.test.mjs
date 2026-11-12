// Tests for the sessions and tracks a board sends on cranium/<thing>/session: what the message must
// look like (src/lib/sessions.mjs), how the recorder stores it (src/recorder.mjs), and what the
// customer API serves from it, for the customer's own boards only (GET /api/c/sessions).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createRecorder } from '../src/recorder.mjs';
import {
  MAX_BYTES,
  MAX_TRACKS,
  isSessionMessage,
  recordsFromSession,
  sessionFromItem,
  trackFromItem,
} from '../src/lib/sessions.mjs';
import { createCustomerWorld } from './fake-customers.mjs';

const THING = 'cranium-0123456789abcdef';
const NOW = Date.UTC(2026, 10, 9, 23, 30, 0);
const START = '2026-11-09T21:04:00Z';
const END = '2026-11-09T23:10:00Z';

/** A message as the rule hands it over. */
const message = (body = {}, rule = {}) => ({
  v: 1,
  type: 'session',
  id: 'a1',
  startedAt: START,
  endedAt: END,
  title: 'Friday set',
  tracks: [
    { title: 'Strobe', artist: 'deadmau5', playedAt: '2026-11-09T21:09:12Z', durationS: 600 },
    { title: 'Ghosts n Stuff', artist: 'deadmau5', playedAt: '2026-11-09T21:19:00Z', durationS: 300 },
  ],
  ...body,
  thing: THING,
  channel: 'session',
  received: NOW - 500,
  ...rule,
});
const made = (body, rule) => recordsFromSession(message(body, rule), { nowMs: NOW });

test('a session message becomes a session item and one item per track, in a partition of its own', () => {
  const result = made();
  assert.equal(result.thing, THING);
  assert.deepEqual(
    result.items.map((item) => item.sk),
    ['S#2026-11-09T21:04:00.000Z#a1', 'T#2026-11-09T21:09:12.000Z#a1', 'T#2026-11-09T21:19:00.000Z#a1']
  );
  for (const item of result.items) assert.equal(item.pk, `SES#${THING}`);
  assert.equal(result.items[0].title, 'Friday set');
  assert.equal(result.items[0].endedAt, '2026-11-09T23:10:00.000Z');
  assert.deepEqual(sessionFromItem(result.items[0]), {
    id: 'a1',
    startedAt: '2026-11-09T21:04:00.000Z',
    endedAt: '2026-11-09T23:10:00.000Z',
    title: 'Friday set',
  });
  assert.deepEqual(trackFromItem(result.items[1]), {
    session: 'a1',
    title: 'Strobe',
    artist: 'deadmau5',
    playedAt: '2026-11-09T21:09:12.000Z',
    durationS: 600,
  });
  assert.ok(result.items.every((item) => item.ttl > NOW / 1000));
  assert.ok(isSessionMessage(message()));
  assert.equal(isSessionMessage({ ...message(), channel: undefined }), false);
});

test('a session with no end and no tracks is a start; a now playing message is one item', () => {
  const start = made({ endedAt: undefined, tracks: undefined, title: undefined });
  assert.equal(start.items.length, 1);
  assert.equal(start.items[0].endedAt, undefined);
  const now = recordsFromSession(
    message({ type: 'now', playing: true, title: 'Strobe', artist: 'deadmau5', playedAt: START, durationS: 600 }, {}),
    { nowMs: NOW }
  );
  assert.equal(now.ignored, 'unknown_field', 'a session body is not a now body');
  const body = { type: 'now', playing: true, title: 'Strobe', artist: 'deadmau5', playedAt: START, durationS: 600 };
  const ok = recordsFromSession({ v: 1, ...body, thing: THING, channel: 'session', received: NOW }, { nowMs: NOW });
  assert.equal(ok.items.length, 1);
  assert.equal(ok.items[0].sk, 'NOW');
  const off = recordsFromSession(
    { v: 1, type: 'now', playing: false, thing: THING, channel: 'session', received: NOW },
    { nowMs: NOW }
  );
  assert.equal(off.items[0].playing, false);
});

test('strict validation: anything unexpected drops the whole message with a reason and no content', () => {
  const bad = {
    unknown_field: made({ extra: 1 }),
    bad_version: made({ v: 2 }),
    unknown_type: made({ type: 'other' }),
    bad_id: made({ id: 'has space' }),
    bad_time: made({ startedAt: '2026-11-09 21:04:00' }),
    bad_time2: made({ startedAt: '2019-01-01T00:00:00Z' }),
    bad_time3: made({ startedAt: '2027-06-01T00:00:00Z' }),
    bad_time4: made({ endedAt: '2026-11-09T20:00:00Z' }),
    bad_time5: made({ endedAt: '2026-11-10T22:00:00Z' }),
    bad_text: made({ title: 'a\u0000b' }),
    bad_tracks: made({ tracks: 'no' }),
    bad_track1: made({ tracks: [{ title: 'x', playedAt: START }] }),
    bad_track2: made({ tracks: [{ title: 'x', playedAt: START, durationS: 0 }] }),
    bad_track3: made({ tracks: [{ title: 'x', playedAt: START, durationS: 1.5 }] }),
    bad_track4: made({ tracks: [{ title: '', playedAt: START, durationS: 10 }] }),
    bad_track5: made({ tracks: [{ title: 'x', playedAt: '2026-11-09T20:00:00Z', durationS: 10 }] }),
    bad_track6: made({ tracks: [{ title: 'x', playedAt: START, durationS: 10, deck: 'A' }] }),
    bad_track7: made({ tracks: [{ title: 'x‮', playedAt: START, durationS: 10 }] }),
    bad_track8: made({ tracks: [null] }),
  };
  for (const [name, result] of Object.entries(bad)) {
    assert.ok(result.ignored !== undefined && result.items === undefined, name);
    assert.match(result.ignored, /^[a-z_]+$/, name);
  }
  assert.equal(made({ tracks: Array(MAX_TRACKS + 1).fill(message().tracks[0]) }).ignored, 'bad_tracks');
  const long = made({ title: 'x'.repeat(121) });
  assert.equal(long.ignored, 'bad_text');
  assert.equal(made({ title: 'x'.repeat(MAX_BYTES) }).ignored, 'too_big');
  // The board cannot name another board or date itself.
  assert.equal(recordsFromSession({ ...message(), thing: 'someone' }, { nowMs: NOW }).ignored, 'not_a_board');
  assert.equal(recordsFromSession({ ...message(), received: 'now' }, { nowMs: NOW }).ignored, 'no_receipt');
  assert.equal(recordsFromSession(null, { nowMs: NOW }).ignored, 'not_a_board');
  assert.equal(
    recordsFromSession(
      { v: 1, type: 'now', playing: 'yes', thing: THING, channel: 'session', received: NOW },
      { nowMs: NOW }
    ).ignored,
    'bad_playing'
  );
});

test('the recorder stores the items once, a repeat replaces them, and a bad message stores nothing', async () => {
  const w = createCustomerWorld({ startMs: NOW });
  const store = w.fake.eventStore();
  const logs = [];
  const recorder = createRecorder({ store, now: () => NOW, log: (entry) => logs.push(entry) });
  assert.deepEqual(await recorder(message()), { recorded: 3 });
  assert.deepEqual(await recorder(message()), { recorded: 3 });
  const kept = await w.fake.queryEvents({ thing: `SES#${THING}`, low: 'S#', high: 'S#~', limit: 10 });
  assert.equal(kept.length, 1);
  const tracks = await w.fake.queryEvents({ thing: `SES#${THING}`, low: 'T#', high: 'T#~', limit: 10 });
  assert.equal(tracks.length, 2);
  assert.deepEqual(await recorder(message({ extra: true })), { recorded: 0 });
  assert.equal(logs.at(-1).reason, 'unknown_field');
  assert.ok(!JSON.stringify(logs.at(-1)).includes('Friday'));
  // The board's own events are not touched.
  assert.deepEqual(await w.fake.queryEvents({ thing: THING, low: 'E#', high: 'E#~', limit: 10 }), []);
  // A write that fails is thrown, so that Lambda tries again.
  const failing = createRecorder({
    store: {
      putEvent: async () => {
        throw new Error('ThrottlingException');
      },
    },
    now: () => NOW,
    log: () => {},
  });
  await assert.rejects(failing(message()), /ThrottlingException/);
});

// The customer API.

const BOARD_A = 'cranium-00000000000000aa';
const BOARD_B = 'cranium-00000000000000bb';

async function world() {
  // The boards are given to their owners before the session of 21:04, and the clock then moves on to NOW.
  const GIVEN = Date.UTC(2026, 10, 9, 20, 0, 0);
  const w = createCustomerWorld({ startMs: GIVEN });
  const admin = w.addStaff('admin', ['release-managers']);
  const ada = w.addCustomer('ada');
  const ben = w.addCustomer('ben');
  for (const thing of [BOARD_A, BOARD_B]) w.fake.addThing(thing);
  for (const [customer, thing] of [
    [ada, BOARD_A],
    [ben, BOARD_B],
  ]) {
    const response = await w.console('POST', `/api/customers/${customer.sub}/boards`, {
      as: admin,
      body: { thing, label: undefined },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  w.advance(NOW - GIVEN);
  const recorder = createRecorder({ store: w.fake.eventStore(), now: () => NOW, log: () => {} });
  const send = (thing, body) => recorder({ ...body, thing, channel: 'session', received: NOW - 100 });
  return { ...w, ada, ben, send };
}

test('a customer reads the sessions and the now playing of their own boards, in the shape of the site', async () => {
  const w = await world();
  const { thing: _t, channel: _c, received: _r, ...body } = message();
  await w.send(BOARD_A, body);
  await w.send(BOARD_A, {
    v: 1,
    type: 'now',
    playing: true,
    title: 'Ghosts n Stuff',
    artist: 'deadmau5',
    playedAt: '2026-11-09T23:29:00Z',
    durationS: 300,
  });
  const answer = await w.customer('/api/c/sessions', { as: w.ada });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const [session] = answer.body.sessions;
  assert.equal(answer.body.sessions.length, 1);
  assert.match(session.id, /^s[0-9a-f]{8}$/);
  assert.deepEqual(
    { title: session.title, startedAt: session.startedAt, source: session.source },
    { title: 'Friday set', startedAt: '2026-11-09T21:04:00.000Z', source: 'board' }
  );
  assert.deepEqual(session.tracks[0], {
    title: 'Strobe',
    artist: 'deadmau5',
    deck: null,
    start: 312,
    end: 912,
    bpm: null,
    key: null,
    playedAt: '2026-11-09T21:09:12.000Z',
    durationS: 600,
  });
  assert.equal(answer.body.nowPlaying.length, 1);
  assert.equal(answer.body.nowPlaying[0].title, 'Ghosts n Stuff');
  // The board's reference, never its thing name or the board's own session id.
  const text = JSON.stringify(answer.body);
  assert.ok(!text.includes(BOARD_A) && !text.includes('"a1"') && !text.includes('SES#'));
  assert.match(session.board, /^[0-9a-f]{16}$/);
});

test("another customer's sessions are not served, and a customer with no board gets none", async () => {
  const w = await world();
  const { thing: _t, channel: _c, received: _r, ...body } = message();
  await w.send(BOARD_A, body);
  await w.send(BOARD_B, { ...body, id: 'b1', title: 'Ben set' });
  const ben = await w.customer('/api/c/sessions', { as: w.ben });
  assert.deepEqual(
    ben.body.sessions.map((session) => session.title),
    ['Ben set']
  );
  const none = w.addCustomer('cleo');
  const cleo = await w.customer('/api/c/sessions', { as: none });
  assert.deepEqual([cleo.body.sessions, cleo.body.nowPlaying], [[], []]);
  assert.equal((await w.customer('/api/c/sessions', { claims: undefined })).status, 401);
  assert.equal((await w.customer('/api/c/sessions', { as: w.ada, method: 'POST', body: {} })).status, 404);
});

test('a now playing that has ended, or that was switched off, is not shown; with no sessions the answer is empty', async () => {
  const w = await world();
  assert.deepEqual((await w.customer('/api/c/sessions', { as: w.ada })).body.sessions, []);
  await w.send(BOARD_A, {
    v: 1,
    type: 'now',
    playing: true,
    title: 'Old',
    playedAt: '2026-11-09T21:00:00Z',
    durationS: 200,
  });
  assert.deepEqual((await w.customer('/api/c/sessions', { as: w.ada })).body.nowPlaying, []);
  await w.send(BOARD_A, { v: 1, type: 'now', playing: true, title: 'Live', playedAt: '2026-11-09T23:29:00Z' });
  assert.equal((await w.customer('/api/c/sessions', { as: w.ada })).body.nowPlaying[0].title, 'Live');
  await w.send(BOARD_A, { v: 1, type: 'now', playing: false });
  assert.deepEqual((await w.customer('/api/c/sessions', { as: w.ada })).body.nowPlaying, []);
});

test('the template: its own rule and topic, the policy lets a board publish only on its own, nothing wider', () => {
  const template = readFileSync(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
  assert.match(template, /FROM 'cranium\/\+\/session'/);
  assert.match(template, /topic\/cranium\/\$\{!iot:Connection\.Thing\.ThingName\}\/session'/);
  assert.match(template, /SourceArn: !GetAtt BoardSessionRule\.Arn/);
  assert.ok(!/topic\/cranium\/\*/.test(template));
});

test('a board given to another customer shows them nothing that its earlier owner played', async () => {
  const w = await world();
  const { thing: _t, channel: _c, received: _r, ...body } = message();
  await w.send(BOARD_A, body);
  await w.send(BOARD_A, { v: 1, type: 'now', playing: true, title: 'Ada now', playedAt: '2026-11-09T23:29:00Z' });
  assert.equal((await w.customer('/api/c/sessions', { as: w.ada })).body.sessions.length, 1);
  const admin = w.addStaff('admin2', ['release-managers']);
  const back = await w.console('POST', `/api/customers/${w.ada.sub}/boards/${BOARD_A}/remove`, { as: admin });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const given = await w.console('POST', `/api/customers/${w.ben.sub}/boards`, { as: admin, body: { thing: BOARD_A } });
  assert.equal(given.status, 200, JSON.stringify(given.body));
  const ben = (await w.customer('/api/c/sessions', { as: w.ben })).body;
  assert.deepEqual(
    ben.sessions.map((session) => session.title),
    [],
    "Ada's session on the board is not Ben's"
  );
  assert.deepEqual(ben.nowPlaying, []);
  // What the board plays once it is Ben's is his.
  w.advance(60_000);
  await w.send(BOARD_A, {
    ...body,
    id: 'b2',
    title: 'Ben on A',
    startedAt: new Date(NOW + 30_000).toISOString(),
    endedAt: new Date(NOW + 50_000).toISOString(),
    tracks: [{ title: 'Mine', artist: 'Ben', playedAt: new Date(NOW + 31_000).toISOString(), durationS: 10 }],
  });
  assert.deepEqual(
    (await w.customer('/api/c/sessions', { as: w.ben })).body.sessions.map((session) => session.title),
    ['Ben on A']
  );
});
