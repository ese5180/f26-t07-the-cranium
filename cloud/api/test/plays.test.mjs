// Tests for plays (firmware 1.20.1): each track Mixxx reports playing on a board's Raspberry Pi, the Pi's np
// message as the board forwards it on cranium/<thing>/session. What the message must look like and what it is
// stored as (src/lib/sessions.mjs), how long each track played and how plays make sets, the console's
// GET /api/devices/{thing}/plays (src/handlers/plays.mjs), and the customer's sessions made from them
// (GET /api/c/sessions). Every message here is simulated as the board would send it, through the recorder.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PLAYS_DEFAULT, PLAYS_MAX, playsLimit } from '../src/handlers/plays.mjs';
import {
  MAX_TEXT,
  NOW_STALE_MS,
  PLAYED_CAP_S,
  SET_GAP_MS,
  nowPlayingFromItem,
  playFromItem,
  playSets,
  playsInOrder,
  recordsFromSession,
} from '../src/lib/sessions.mjs';
import { createRecorder } from '../src/recorder.mjs';
import { createTestConsole } from './fake-aws.mjs';
import { createCustomerWorld } from './fake-customers.mjs';

const THING = 'cranium-0123456789abcdef';
const OTHER = 'cranium-fedcba9876543210';
const NOW = Date.UTC(2026, 10, 20, 22, 0, 0);
const MINUTE = 60_000;
const iso = (ms) => new Date(ms).toISOString();

/** The Pi's np, as pi/cranium_collect.py writes it. */
const np = (fields = {}) => ({ t: 'np', ti: 'Strobe', ar: 'deadmau5', ge: 'House', bpm10: 1280, dur: 600, ...fields });
/** A play as the board sends it (firmware 1.20.1), and as the rule hands it over. */
const play = (body = {}, received = NOW - 500) => ({
  v: 1,
  type: 'play',
  ageS: 2,
  np: np(),
  ...body,
  thing: THING,
  channel: 'session',
  received,
});
const made = (body, received) => recordsFromSession(play(body, received), { nowMs: NOW });

test('a play is stored in the board partition, dated from when AWS IoT took it less its age, and is now playing', () => {
  const result = made();
  assert.equal(result.thing, THING);
  const [item, now] = result.items;
  const playedAt = iso(NOW - 500 - 2000);
  assert.deepEqual(item, {
    pk: `SES#${THING}`,
    sk: `P#${playedAt}`,
    title: 'Strobe',
    artist: 'deadmau5',
    genre: 'House',
    bpm10: 1280,
    lengthS: 600,
    playedAt,
    at: NOW,
    ttl: Math.floor(NOW / 1000) + 400 * 86_400,
  });
  assert.deepEqual(
    { sk: now.sk, playing: now.playing, title: now.title, playedAt: now.playedAt, durationS: now.durationS },
    { sk: 'NOW', playing: true, title: 'Strobe', playedAt, durationS: 600 }
  );
  assert.deepEqual(nowPlayingFromItem(now, NOW), { title: 'Strobe', artist: 'deadmau5', playedAt, durationS: 600 });
  assert.deepEqual(playFromItem(item), {
    title: 'Strobe',
    artist: 'deadmau5',
    genre: 'House',
    bpm: 128,
    key: null,
    lengthS: 600,
    playedAt,
  });
});

test("the Pi's key, once it sends one, is kept; a field the cloud does not know yet is left out, not refused", () => {
  const [item] = made({ np: np({ ky: '8A', bpm10: 1245, mood: 'happy' }) }).items;
  assert.equal(item.key, '8A');
  assert.equal(item.mood, undefined);
  assert.deepEqual([playFromItem(item).key, playFromItem(item).bpm], ['8A', 124.5]);
});

test("the Pi's texts are cleaned rather than refused, and what it did not say is left out", () => {
  const long = 'x'.repeat(MAX_TEXT + 30);
  const [item] = made({ np: np({ ti: ` Can I\u0007Live\n${long}`, ar: 'Jaÿ‐Z', ge: '', ky: ' C#m\u0000 ' }) }).items;
  assert.equal(item.title.length, MAX_TEXT);
  assert.ok(item.title.startsWith('Can I Live '));
  assert.equal(item.artist, 'Jaÿ‐Z');
  assert.equal(item.genre, undefined);
  assert.equal(item.key, 'C#m');
  // No BPM, no length and no title: left out, and the play is still a play.
  const [bare, now] = made({ np: { t: 'np', ti: '', bpm10: 0, dur: 0 } }).items;
  assert.deepEqual([bare.title, bare.bpm10, bare.lengthS, bare.artist], ['', undefined, undefined, '']);
  assert.equal(now.title, 'Untitled');
  assert.equal(now.durationS, undefined);
  // A length too long to be a track's is not one.
  assert.equal(made({ np: np({ dur: 90_000 }) }).items[0].lengthS, undefined);
  // An age of nothing is no age.
  assert.equal(made({ ageS: undefined }).items[0].playedAt, iso(NOW - 500));
});

test('a play that is not one is dropped whole, by a reason that never quotes it', () => {
  const cases = [
    [{ extra: 1 }, 'unknown_field'],
    [{ ageS: -1 }, 'bad_age'],
    [{ ageS: 1.5 }, 'bad_age'],
    [{ ageS: 8 * 86_400 }, 'bad_age'],
    [{ ageS: '2' }, 'bad_age'],
    [{ np: 'np' }, 'bad_np'],
    [{ np: [np()] }, 'bad_np'],
    [{ np: np({ t: 'hb' }) }, 'bad_np'],
    [{ np: np({ ti: 7 }) }, 'bad_np'],
    [{ np: np({ ar: null }) }, 'bad_np'],
    [{ np: np({ bpm10: -1 }) }, 'bad_np'],
    [{ np: np({ bpm10: 10_000 }) }, 'bad_np'],
    [{ np: np({ bpm10: 128.5 }) }, 'bad_np'],
    [{ np: np({ dur: -5 }) }, 'bad_np'],
    [{ np: np({ ky: 8 }) }, 'bad_np'],
    [{ v: 2 }, 'bad_version'],
  ];
  for (const [body, reason] of cases) assert.equal(made(body).ignored, reason, JSON.stringify(body));
  // A board that brings what only the rule may add is not heard.
  assert.equal(recordsFromSession({ ...play(), received: undefined }, { nowMs: NOW }).ignored, 'no_receipt');
  // A receipt from before 2024, less its age, is no time at all.
  assert.equal(made({}, Date.UTC(2023, 11, 31)).ignored, 'bad_time');
});

test('an old play is stored but is not what is on the decks now', () => {
  const result = made({ ageS: (NOW_STALE_MS + MINUTE) / 1000 });
  assert.deepEqual(
    result.items.map((item) => item.sk),
    [`P#${iso(NOW - 500 - NOW_STALE_MS - MINUTE)}`]
  );
});

/** A play as playFromItem gives it. */
const read = (playedMs, lengthS = 300, extra = {}) => ({
  title: `At ${iso(playedMs)}`,
  artist: '',
  genre: '',
  bpm: 128,
  key: null,
  lengthS,
  playedAt: iso(playedMs),
  ...extra,
});

test('each track played until the next began, at most its length; the newest is playing until its length runs out', () => {
  const start = NOW - 60 * MINUTE;
  const ordered = playsInOrder(
    [
      read(start + 10 * MINUTE, 300), // the next 4 min later: 240 s
      read(start, 300), // the next 10 min later: its length
      read(start + 14 * MINUTE, null), // no length, the next 40 min later: the cap
      read(start + 54 * MINUTE, 600), // the newest, 6 min ago, 10 min long: playing
    ],
    NOW
  );
  assert.deepEqual(
    ordered.map((one) => [one.playedAt, one.playedS, one.playing]),
    [
      [iso(start), 300, false],
      [iso(start + 10 * MINUTE), 240, false],
      [iso(start + 14 * MINUTE), Math.min(40 * 60, PLAYED_CAP_S), false],
      [iso(start + 54 * MINUTE), null, true],
    ]
  );
  // Once its length has run out, the newest played its length as far as is known; with none, it is not known.
  assert.deepEqual(
    playsInOrder([read(NOW - 20 * MINUTE, 600)], NOW).map((one) => [one.playedS, one.playing]),
    [[600, false]]
  );
  assert.deepEqual(
    playsInOrder([read(NOW - 20 * MINUTE, null)], NOW).map((one) => [one.playedS, one.playing]),
    [[null, false]]
  );
  assert.deepEqual(
    playsInOrder([read(NOW - 5 * MINUTE, null)], NOW).map((one) => one.playing),
    [true]
  );
  assert.deepEqual(playsInOrder([], NOW), []);
});

test('plays make sets, the next beginning after a pause of more than half an hour', () => {
  const start = NOW - 5 * 3_600_000;
  const ordered = playsInOrder(
    [
      read(start, 300),
      read(start + 5 * MINUTE, 300),
      // 5 min after the second's end + 30 min: still the same set.
      read(start + 10 * MINUTE + SET_GAP_MS, 300),
      // An hour after: a new set.
      read(start + 75 * MINUTE + SET_GAP_MS, 300),
    ],
    NOW
  );
  const sets = playSets(ordered);
  assert.deepEqual(
    sets.map((set) => [set.startedAt, set.plays.length, set.endedAt]),
    [
      [iso(start), 3, iso(start + 15 * MINUTE + SET_GAP_MS)],
      [iso(start + 75 * MINUTE + SET_GAP_MS), 1, iso(start + 80 * MINUTE + SET_GAP_MS)],
    ]
  );
  assert.deepEqual(playSets([]), []);
});

// The console: GET /api/devices/{thing}/plays.

function setup() {
  const console_ = createTestConsole({ startMs: NOW - 3_600_000 });
  const viewer = console_.addUser('viewer', ['viewers']);
  const manager = console_.addUser('manager', ['release-managers']);
  console_.fake.addThing(THING);
  console_.fake.addThing(OTHER);
  console_.clock.ms = NOW;
  const recorder = createRecorder({ store: console_.fake.eventStore(), now: () => console_.clock.ms, log: () => {} });
  /** A board's play, simulated: what the board sends `agoMs` before NOW. */
  const send = (thing, fields, agoMs, ageS = 1) =>
    recorder({ v: 1, type: 'play', ageS, np: np(fields), thing, channel: 'session', received: NOW - agoMs });
  const get = (path, query, as = viewer) => console_.call('GET', path, { as, query });
  return { ...console_, viewer, manager, send, get };
}

test('GET /api/devices/{thing}/plays: the plays in the order played, with BPM, key and how long each played', async () => {
  const context = setup();
  // A set of four, as a board on 1.20.1 forwards them from its Pi.
  // 30 minutes ago: stored, but long past being what is on the decks now.
  assert.deepEqual(await context.send(THING, { ti: 'Strobe', bpm10: 1280, dur: 600 }, 30 * MINUTE), { recorded: 1 });
  await context.send(THING, { ti: 'Ghosts n Stuff', bpm10: 1280, dur: 300 }, 22 * MINUTE);
  await context.send(THING, { ti: 'Opus', ar: 'Eric Prydz', bpm10: 1260, dur: 540, ky: '8A' }, 17 * MINUTE, 3);
  await context.send(THING, { ti: 'Pjanoo', ar: 'Eric Prydz', bpm10: 1255, dur: 420 }, 2 * MINUTE);
  // Another board's play is not this board's.
  await context.send(OTHER, { ti: 'Elsewhere' }, 5 * MINUTE);

  const { status, body } = await context.get(`/api/devices/${THING}/plays`);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.thing, THING);
  assert.equal(body.more, false);
  assert.equal(body.generatedAt, iso(NOW));
  assert.deepEqual(
    body.plays.map((one) => [one.title, one.artist, one.bpm, one.key, one.playedS, one.playing]),
    [
      ['Strobe', 'deadmau5', 128, null, 8 * 60, false],
      // Opus came in 3 s before the board sent it: Ghosts n Stuff played 2 s short of its length.
      ['Ghosts n Stuff', 'deadmau5', 128, null, 298, false],
      // Played 15 minutes, at most its length of 9.
      ['Opus', 'Eric Prydz', 126, '8A', 540, false],
      ['Pjanoo', 'Eric Prydz', 125.5, null, null, true],
    ]
  );
  assert.deepEqual(body.plays[0], {
    title: 'Strobe',
    artist: 'deadmau5',
    genre: 'House',
    bpm: 128,
    key: null,
    lengthS: 600,
    playedAt: iso(NOW - 30 * MINUTE - 1000),
    playedS: 480,
    playing: false,
  });
  // A read: on no record.
  assert.equal(context.fake.auditLog().length, 0);

  // The newest `limit`, still oldest first, and `more` says there are older ones.
  const two = await context.get(`/api/devices/${THING}/plays`, { limit: '2' });
  assert.deepEqual(
    two.body.plays.map((one) => one.title),
    ['Opus', 'Pjanoo']
  );
  assert.equal(two.body.more, true);
});

test('GET /api/devices/{thing}/plays refuses what it cannot answer, and needs a member', async () => {
  const context = setup();
  for (const [path, query, code, status] of [
    [`/api/devices/${THING}/plays`, { limit: '0' }, 'invalid_limit', 400],
    [`/api/devices/${THING}/plays`, { limit: String(PLAYS_MAX + 1) }, 'invalid_limit', 400],
    [`/api/devices/${THING}/plays`, { limit: '1e2' }, 'invalid_limit', 400],
    ['/api/devices/cranium-XYZ/plays', undefined, 'invalid_thing', 400],
    ['/api/devices/cranium-1111111111111111/plays', undefined, 'unknown_device', 404],
  ]) {
    const response = await context.get(path, query);
    assert.deepEqual([response.status, response.body.error.code], [status, code], path);
  }
  // A board that played nothing has no plays, for viewers and release managers alike.
  for (const as of [context.viewer, context.manager]) {
    const empty = await context.get(`/api/devices/${OTHER}/plays`, undefined, as);
    assert.equal(empty.status, 200);
    assert.deepEqual([empty.body.plays, empty.body.more], [[], false]);
  }
  assert.equal((await context.call('GET', `/api/devices/${THING}/plays`)).status, 401);
  assert.deepEqual(
    [playsLimit(undefined), playsLimit('1'), playsLimit('500'), playsLimit('05'), playsLimit(['2'])],
    [PLAYS_DEFAULT, 1, 500, null, null]
  );
});

// The customer's sessions, made from their board's plays.

test("a customer's board that sends plays has sessions on the site, with BPM and key, and what is playing now", async () => {
  const GIVEN = NOW - 6 * 3_600_000;
  const w = createCustomerWorld({ startMs: GIVEN - MINUTE });
  const admin = w.addStaff('admin', ['release-managers']);
  const ada = w.addCustomer('ada');
  const ben = w.addCustomer('ben');
  w.fake.addThing(THING);
  w.fake.addThing(OTHER);
  for (const [customer, thing] of [
    [ada, THING],
    [ben, OTHER],
  ]) {
    const given = await w.console('POST', `/api/customers/${customer.sub}/boards`, { as: admin, body: { thing } });
    assert.equal(given.status, 200, JSON.stringify(given.body));
  }
  w.advance(NOW - GIVEN + MINUTE);
  const recorder = createRecorder({ store: w.fake.eventStore(), now: () => NOW, log: () => {} });
  const send = (thing, fields, agoMs) =>
    recorder({ v: 1, type: 'play', ageS: 0, np: np(fields), thing, channel: 'session', received: NOW - agoMs });
  // Before the board was hers: a play that is not Ada's.
  await send(THING, { ti: 'Before her' }, 7 * 3_600_000);
  // An evening set, then a pause of two hours, then the set going on now.
  await send(THING, { ti: 'Strobe', dur: 600, ky: '8A' }, 4 * 3_600_000);
  await send(THING, { ti: 'Ghosts n Stuff', dur: 300, bpm10: 1275 }, 4 * 3_600_000 - 8 * MINUTE);
  await send(THING, { ti: 'Opus', dur: 540 }, 5 * MINUTE);
  await send(OTHER, { ti: 'Ben plays' }, MINUTE);

  const answer = await w.customer('/api/c/sessions', { as: ada });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const { sessions, nowPlaying } = answer.body;
  assert.deepEqual(
    sessions.map((session) => [session.startedAt, session.tracks.map((track) => track.title), session.endedAt]),
    [
      [iso(NOW - 5 * MINUTE), ['Opus'], undefined],
      [iso(NOW - 4 * 3_600_000), ['Strobe', 'Ghosts n Stuff'], iso(NOW - 4 * 3_600_000 + 13 * MINUTE)],
    ]
  );
  const evening = sessions[1];
  assert.deepEqual(evening.tracks[0], {
    title: 'Strobe',
    artist: 'deadmau5',
    deck: null,
    start: 0,
    end: 480,
    bpm: 128,
    key: '8A',
    playedAt: iso(NOW - 4 * 3_600_000),
    durationS: 480,
  });
  assert.deepEqual([evening.tracks[1].start, evening.tracks[1].end, evening.tracks[1].bpm], [480, 780, 127.5]);
  assert.deepEqual([evening.source, evening.title], ['board', 'A session']);
  assert.match(evening.id, /^s[0-9a-f]{8}$/);
  // Playing now: until now so far, and it is the site's now playing.
  assert.deepEqual([sessions[0].tracks[0].durationS, sessions[0].tracks[0].end], [300, 300]);
  assert.deepEqual(
    nowPlaying.map((one) => [one.title, one.durationS]),
    [['Opus', 540]]
  );
  // Never the board's thing name, and never another customer's plays.
  const text = JSON.stringify(answer.body);
  assert.ok(!text.includes(THING) && !text.includes('SES#') && !text.includes('Ben plays'));
  const theirs = (await w.customer('/api/c/sessions', { as: ben })).body.sessions;
  assert.deepEqual(
    theirs.map((session) => session.tracks.map((track) => track.title)),
    [['Ben plays']]
  );
});
