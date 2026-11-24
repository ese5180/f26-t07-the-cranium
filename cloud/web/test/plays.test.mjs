/**
 * Tests for the Plays card of a board's page (plays.js, firmware 1.20.1): the client's read of a board's plays
 * (core.js), the table in the order played with title, artist, BPM, key, time played and when, the track playing
 * now, what the card says while it waits or when there is nothing, and the words for BPM and times. plays.js,
 * core.js and views.js are the very files the browser loads; the replies are simulated as the API gives them.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CORE, PLAYS, VIEWS, all, createDocument, one, textOf } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
const plays = await import(PLAYS);
globalThis.document = createDocument();

const NOW = Date.parse('2026-11-20T22:00:00Z');
const A = 'cranium-00000000000000aa';
const MINUTE = 60_000;
const iso = (agoMs) => new Date(NOW - agoMs).toISOString();
const loaded = (value) => ({ value, error: null, loadedAt: NOW, loading: false });

function draw(node) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  views.render(root, node);
  return root;
}

/** A board's plays as GET /api/devices/{thing}/plays gives them: oldest first. */
const PLAYS_REPLY = {
  thing: A,
  plays: [
    {
      title: 'Strobe',
      artist: 'deadmau5',
      genre: 'House',
      bpm: 128,
      key: null,
      lengthS: 600,
      playedAt: iso(30 * MINUTE),
      playedS: 480,
      playing: false,
    },
    {
      title: 'Opus',
      artist: 'Eric Prydz',
      genre: '',
      bpm: 125.5,
      key: '8A',
      lengthS: 540,
      playedAt: iso(22 * MINUTE),
      playedS: 3723,
      playing: false,
    },
    {
      title: '',
      artist: '',
      genre: '',
      bpm: null,
      key: null,
      lengthS: null,
      playedAt: iso(2 * MINUTE),
      playedS: null,
      playing: true,
    },
  ],
  more: false,
  generatedAt: iso(0),
};

function api(replies, asked = []) {
  return core.createApi({
    auth: { accessToken: () => 'TOKEN' },
    crypto: globalThis.crypto,
    clock: core.createClock(() => NOW),
    onUnauthorized: () => assert.fail('the token was refused'),
    fetch: async (url) => {
      asked.push(String(url));
      const reply = replies.get(String(url));
      assert.ok(reply, `no reply for ${url}`);
      return Response.json(reply);
    },
  });
}

test("the client reads a board's plays, and keeps only what it knows", async () => {
  const asked = [];
  const strange = {
    title: 7,
    artist: 'X',
    bpm: -3,
    key: 'C#m'.repeat(10),
    playedS: -1,
    playing: 'yes',
    playedAt: iso(1),
  };
  const replies = new Map([
    [`/api/devices/${A}/plays?limit=${core.PLAYS_SHOWN}`, PLAYS_REPLY],
    [`/api/devices/${A}/plays`, { ...PLAYS_REPLY, plays: [strange, { title: 'No time' }], more: 'yes' }],
  ]);
  const client = api(replies, asked);
  const first = await client.plays(A, { limit: core.PLAYS_SHOWN });
  assert.deepEqual(
    first.plays.map((one_) => [one_.title, one_.bpm, one_.key, one_.playedS, one_.playing]),
    [
      ['Strobe', 128, null, 480, false],
      ['Opus', 125.5, '8A', 3723, false],
      ['', null, null, null, true],
    ]
  );
  assert.equal(first.more, false);
  const odd = await client.plays(A);
  // A text that is not one is empty, a number out of range not known, and a play with no time is left out.
  assert.deepEqual(odd.plays, [
    {
      title: '',
      artist: 'X',
      genre: '',
      bpm: null,
      key: 'C#mC#mC#mC#m',
      lengthS: null,
      playedAt: iso(1),
      playedS: null,
      playing: false,
    },
  ]);
  assert.equal(odd.more, false);
  await assert.rejects(client.plays('x'));
  await assert.rejects(client.plays(A, { limit: 501 }));
  assert.deepEqual(asked, [`/api/devices/${A}/plays?limit=${core.PLAYS_SHOWN}`, `/api/devices/${A}/plays`]);
});

test("a board's page lists what it played in order: title, artist, BPM, key, time played and when", () => {
  const state = { now: NOW, plays: new Map([[A, loaded(PLAYS_REPLY)]]) };
  const root = draw(plays.playsSection(A, { state, actions: {} }));
  assert.match(textOf(one(root, 'h2', 'Plays')), /Plays/);
  const [head] = all(root, 'thead');
  const [body] = all(root, 'tbody');
  assert.deepEqual(all(head, 'th').map(textOf), ['#', 'Title', 'Artist', 'BPM', 'Key', 'Time played', 'When']);
  const rows = all(body, 'tr').map((row) => [...row.children].map(textOf));
  assert.deepEqual(
    rows.map((cells) => cells.slice(0, 6)),
    [
      ['1', 'Strobe', 'deadmau5', '128', '—', '8:00'],
      ['2', 'Opus', 'Eric Prydz', '125.5', '8A', '1:02:03'],
      ['3', 'Untitled', '—', '—', '—', 'Playing'],
    ]
  );
  // When: the time of day, the exact moment in its tooltip and its machine-readable form.
  const times = all(body, 'time');
  assert.equal(times[0].getAttribute('datetime'), iso(30 * MINUTE));
  assert.equal(times[0].getAttribute('title'), core.exactTime(iso(30 * MINUTE)));
  assert.equal(textOf(times[0]), core.clockTime(iso(30 * MINUTE), NOW));
  // The track playing now is marked, in words as well as colour.
  const playing = all(body, 'tr')[2];
  assert.ok(playing.getAttribute('class').includes('is-playing'));
  assert.match(textOf(playing), /Playing/);
  assert.match(textOf(root), /until the next track began, at most the track’s length/);
  assert.doesNotMatch(textOf(root), /latest \d+ are shown/);
  // More than the page shows: it says which.
  const more = draw(
    plays.playsSection(A, { state: { now: NOW, plays: new Map([[A, loaded({ ...PLAYS_REPLY, more: true })]]) } })
  );
  assert.match(textOf(more), /The latest 3 are shown, oldest first/);
});

test('the Plays card says what it is waiting for, what it could not read, and when nothing has played', () => {
  const ctx = (target) => ({ state: { now: NOW, plays: new Map(target ? [[A, target]] : []) }, actions: {} });
  assert.match(textOf(draw(plays.playsSection(A, ctx(null)))), /Loading the plays/);
  const failed = { value: null, error: new Error('x'), loadedAt: 0, loading: false };
  assert.match(textOf(draw(plays.playsSection(A, ctx(failed)))), /could not be read/);
  const none = draw(plays.playsSection(A, ctx(loaded({ ...PLAYS_REPLY, plays: [] }))));
  assert.match(textOf(none), /Nothing played yet\. A board on firmware 1\.20\.1 or later/);
  assert.equal(all(none, 'table').length, 0);
});

test('BPM and times in words', () => {
  assert.deepEqual([128, 125.5, 0, null, Number.NaN].map(plays.bpmWords), ['128', '125.5', '—', '—', '—']);
  assert.deepEqual([0, 59, 60, 298, 3600, 3723, -1, null].map(plays.playedWords), [
    '0:00',
    '0:59',
    '1:00',
    '4:58',
    '1:00:00',
    '1:02:03',
    '—',
    '—',
  ]);
});

test("the card reads a board's plays when its page opens, then at most once a minute", async () => {
  const asked = [];
  let clockMs = NOW;
  const state = {};
  const load = async (target, read) => {
    target.value = await read();
    target.loadedAt = clockMs;
  };
  plays.connect({
    state,
    api: { plays: async (thing, options) => asked.push([thing, options]) && PLAYS_REPLY },
    load,
    now: () => clockMs,
  });
  await plays.refreshPlays(A);
  await plays.refreshPlays(A);
  clockMs += plays.PLAYS_REFRESH_MS;
  await plays.refreshPlays(A);
  await plays.refreshPlays(A, true);
  await plays.refreshPlays('not a board');
  assert.deepEqual(asked, Array(3).fill([A, { limit: core.PLAYS_SHOWN }]));
});

test('the table scrolls sideways in its card on a narrow screen, never the page, and its colours are tokens', () => {
  const css = readFileSync(new URL('../src/site/assets/app.css', import.meta.url), 'utf8');
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.match(rule('.plays-table-wrap'), /overflow-x: auto/);
  assert.match(rule('.plays-table-wrap'), /max-width: 100%/);
  assert.match(rule('.plays-table tr.is-playing > *'), /background: var\(--well\)/);
  // The page's own table styles: the same as every table of the console.
  const source = readFileSync(new URL('../src/site/assets/plays.js', import.meta.url), 'utf8');
  assert.match(source, /class: 'ui-table data-table plays-table'/);
});
