/**
 * The customer site's mixes (customer-mixes.js): the demo, what the figures and the transitions
 * work out, reading a session file, and writing one.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scriptAddress } from './page.mjs';

const mixes = await import(
  scriptAddress('customer-mixes.js', {}, '', new URL('../src/customer/assets/', import.meta.url))
);
const {
  ImportProblem,
  LIMITS,
  cleanSession,
  clock,
  deckSeconds,
  demoJournal,
  emptyJournal,
  figures,
  fileName,
  inRange,
  journalFile,
  libraryOf,
  matches,
  mergeJournal,
  momentOf,
  momentToRevisit,
  onDecks,
  readImport,
  sampleFile,
  sessionId,
  sessionsCsv,
  transitionsOf,
  withMoment,
  withoutMoment,
  withoutSession,
} = mixes;

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const CSV = [
  'session,started,title,artist,deck,start,end,bpm,key',
  'Friday warm-up,2026-11-05T20:30:00Z,Opening Track,Test Artist,A,0,5:10,120,8A',
  'Friday warm-up,2026-11-05T20:30:00Z,"Second, with ""quotes""",Other Artist,b,4:40,10:00,122,9A',
  'Friday warm-up,2026-11-05T20:30:00Z,=HYPERLINK("x"),Bad Actor,C,9:20,15:00,999,TOOLONGKEY',
  'Friday warm-up,2026-11-05T20:30:00Z,,No Name,A,15:00,16:00,,',
  'Late one,2026-11-01T23:00:00Z,Only Track,Someone,,,,,',
].join('\r\n');

test('the demo: three made-up sessions, dated from today, that every figure can be worked out from', () => {
  const { sessions, moments } = demoJournal(NOW);
  assert.equal(sessions.length, 3);
  assert.deepEqual(moments, []);
  assert.ok(sessions.every((session) => session.source === 'demo' && /^s[0-9a-f]{8}$/.test(session.id)));
  assert.deepEqual(figures(sessions), {
    seconds: figures(sessions).seconds,
    sessions: 3,
    plays: 20,
    unique: 9,
    overlaps: 17,
  });
  assert.equal(inRange(sessions, '7', NOW).length, 2);
  assert.equal(inRange(sessions, '30', NOW).length, 3);
  assert.equal(inRange(sessions, 'all', NOW).length, 3);
  // The same day makes the same sessions: a saved moment of the demo finds its pair again.
  assert.deepEqual(
    demoJournal(NOW + 1000).sessions.map((session) => session.id),
    sessions.map((session) => session.id)
  );
  assert.equal(JSON.parse(sampleFile(NOW)).format, 'cranium-mixes');
});

test('time on the decks counts two decks at once once, and a transition is the overlap of two tracks in start order', () => {
  const session = cleanSession({
    title: 'Two',
    startedAt: '2026-11-05T20:00:00Z',
    tracks: [
      { title: 'B', deck: 'B', start: 100, end: 200 },
      { title: 'A', deck: 'A', start: 0, end: 130 },
      { title: 'C', deck: 'A', start: 300, end: 400 },
      { title: 'D', deck: 'B' },
    ],
  });
  assert.equal(deckSeconds(session), 300);
  const pairs = transitionsOf([session]);
  assert.deepEqual(
    pairs.map((pair) => [pair.from.title, pair.to.title, pair.overlap]),
    [
      ['A', 'B', 30],
      ['B', 'C', 0],
      ['C', 'D', null],
    ]
  );
  assert.equal(pairs[0].id, `${session.id}:1`);
  assert.equal(momentToRevisit([session]).to.title, 'B');
  assert.equal(clock(2274), '37:54');
  assert.equal(clock(3725), '1:02:05');
  assert.equal(onDecks(5640), '1h 34m');
  assert.equal(onDecks(45), '45s');
});

test('a CSV of tracks becomes sessions: quotes, m:ss, decks; what does not fit is left out, not guessed', () => {
  const imported = readImport(CSV, 'set.csv');
  assert.equal(imported.sessions.length, 2);
  const [friday, late] = imported.sessions;
  assert.equal(friday.title, 'Friday warm-up');
  assert.equal(friday.tracks.length, 3, 'the line without a name is dropped');
  assert.deepEqual(friday.tracks[1], {
    title: 'Second, with "quotes"',
    artist: 'Other Artist',
    deck: 'B',
    start: 280,
    end: 600,
    bpm: 122,
    key: '9A',
  });
  // Deck C is no deck, 999 is no tempo, and a key is at most four characters.
  assert.deepEqual([friday.tracks[2].deck, friday.tracks[2].bpm, friday.tracks[2].key], [null, null, 'TOOL']);
  assert.deepEqual(late.tracks, [
    { title: 'Only Track', artist: 'Someone', deck: null, start: null, end: null, bpm: null, key: null },
  ]);
  assert.equal(late.startedAt, '2026-11-01T23:00:00.000Z');
});

test('a file the site cannot read says why', () => {
  const problem = (source, name, pattern) =>
    assert.throws(
      () => readImport(source, name),
      (error) => error instanceof ImportProblem && pattern.test(error.message)
    );
  problem('', 'x.csv', /empty/);
  problem('title,artist\nA,B\n', 'x.csv', /no "started" column/);
  problem('{ not json', 'x.json', /not JSON/);
  problem('{"format":"other","version":1}', 'x.json', /not a Cranium session file/);
  problem('{"format":"cranium-mixes","version":2,"sessions":[]}', 'x.json', /version 2/);
  problem(
    '{"format":"cranium-mixes","version":1,"sessions":[{"title":"no time","tracks":[{"title":"A"}]}]}',
    'x.json',
    /No session/
  );
  problem('x'.repeat(LIMITS.bytes + 1), 'big.csv', /larger than 1 MB/);
  const skipped = readImport(
    JSON.stringify({
      format: 'cranium-mixes',
      version: 1,
      sessions: [
        { title: 'kept', startedAt: '2026-11-05T20:00:00Z', tracks: [{ title: 'A' }] },
        { title: 'dropped', tracks: [] },
      ],
    }),
    'x.json'
  );
  assert.equal(skipped.skipped, 1);
});

test('names are text, cut to size, without control characters', () => {
  const session = cleanSession({
    title: `  <b>Set</b>\u0000 ${'x'.repeat(300)}`,
    startedAt: '2026-11-05T20:00:00Z',
    tracks: [{ title: 'Line\nbreak\ttab', artist: 42 }, { title: '   ' }, null, 'nope'],
  });
  assert.equal(session.title.length, LIMITS.text);
  assert.ok(session.title.startsWith('<b>Set</b> '), 'kept as text: the page sets it as text');
  assert.deepEqual(
    session.tracks.map((track) => [track.title, track.artist]),
    [['Line break tab', '42']]
  );
  assert.equal(cleanSession({ title: 'x', startedAt: 'never', tracks: [{ title: 'A' }] }), null);
  assert.equal(cleanSession([]), null);
});

test('a backup brings the journal back as it was, and an export to a spreadsheet cannot run a formula', () => {
  let journal = mergeJournal(emptyJournal(), readImport(CSV, 'set.csv'));
  const [pair] = transitionsOf(journal.sessions);
  journal = withMoment(journal, momentOf(pair, 'Filter on B', NOW));
  const back = readImport(journalFile(journal, NOW), 'backup.json');
  assert.deepEqual(back.sessions, journal.sessions);
  assert.deepEqual(back.moments, journal.moments);
  // Importing it again replaces, not doubles.
  assert.equal(mergeJournal(journal, back).sessions.length, 2);
  assert.equal(mergeJournal(journal, back).moments.length, 1);

  const csv = sessionsCsv(journal.sessions);
  assert.match(csv, /^session,started,title,artist,deck,start,end,bpm,key\r\n/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"Second, with ""quotes"""/);
  assert.equal(readImport(csv, 'again.csv').sessions[0].tracks[2].title, '\'=HYPERLINK("x")');

  assert.equal(withoutMoment(journal, pair.id).moments.length, 0);
  assert.equal(withoutSession(journal, journal.sessions[0].id).sessions.length, 1);
  assert.equal(fileName('Friday warm-up!', NOW, 'csv'), 'cranium-friday-warm-up-2026-11-06.csv');
  assert.equal(sessionId('2026-11-05T20:30:00.000Z', 'Friday warm-up'), journal.sessions[0].id);
});

test('the library ranks tracks by plays, and the search finds a track by its name or artist', () => {
  const { sessions } = demoJournal(NOW);
  const library = libraryOf(sessions);
  assert.equal(library.length, 9);
  assert.ok(library.every((track, index) => index === 0 || library[index - 1].plays >= track.plays));
  assert.equal(
    library.reduce((sum, track) => sum + track.plays, 0),
    20
  );
  assert.ok(matches({ title: 'Copper Light', artist: 'Hollis Vane' }, 'hollis'));
  assert.ok(matches({ title: 'Copper Light', artist: 'Hollis Vane' }, ''));
  assert.equal(matches({ title: 'Copper Light', artist: 'Hollis Vane' }, 'radio'), false);
});
