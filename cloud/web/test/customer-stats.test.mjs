/**
 * The customer site's listening stats (customer-stats.js): weeks in the customer's own time, empty data,
 * ties, and where the numbers came from.
 */

process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scriptAddress } from './page.mjs';

const dir = new URL('../src/customer/assets/', import.meta.url);
const mixesAddress = scriptAddress('customer-mixes.js', {}, '', dir);
const stats = await import(scriptAddress('customer-stats.js', { 'customer-mixes.js': mixesAddress }, '', dir));
const { cleanSession } = await import(mixesAddress);
const { BAR_DAYS, hourWords, listeningStats, playedAt, sourceOf, sourceWords, weekStart } = stats;

// Wednesday 11 November 2026, 12:00 in New York (17:00 UTC). That week began on Monday the 9th.
const NOW = Date.parse('2026-11-11T17:00:00Z');

function session(startedAt, tracks, source = 'journal', title = 'Set') {
  return cleanSession({ startedAt, title, tracks }, source);
}
const track = (title, artist, start = 0, end = start + 300) => ({ title, artist, deck: 'A', start, end });

test('a week begins on Monday at local midnight', () => {
  assert.equal(weekStart(NOW).getTime(), new Date(2026, 10, 9).getTime());
  // Sunday evening local time is still the week before: 03:30 UTC Monday is 22:30 Sunday in New York.
  assert.equal(weekStart(Date.parse('2026-11-09T03:30:00Z')).getTime(), new Date(2026, 10, 2).getTime());
  assert.equal(weekStart(Date.parse('2026-11-09T05:00:00Z')).getTime(), new Date(2026, 10, 9).getTime());
});

test('this week and last week are counted by the local week a session started in', () => {
  const sessions = [
    session('2026-11-10T01:00:00Z', [track('A', 'X', 0, 600)]), // Mon 9th 20:00 local: this week
    session('2026-11-09T03:30:00Z', [track('B', 'X', 0, 1200)]), // Sun 8th 22:30 local: last week
    session('2026-11-02T05:00:00Z', [track('C', 'X', 0, 300)]), // Mon 2nd 00:00 local: last week
    session('2026-11-02T04:59:00Z', [track('D', 'X', 0, 900)]), // Sun 1st 23:59 local: before
  ];
  const result = listeningStats(sessions, NOW);
  assert.equal(result.thisWeek, 600);
  assert.equal(result.lastWeek, 1500);
});

test('the day bars run oldest to newest for 14 local days, ending today', () => {
  const sessions = [
    session('2026-11-11T14:00:00Z', [track('A', 'X')]),
    session('2026-11-11T15:00:00Z', [track('B', 'X')]),
    session('2026-11-10T03:00:00Z', [track('C', 'X')]), // Mon 9th 22:00 local
    session('2026-10-29T12:00:00Z', [track('D', 'X')]), // 13 days ago: first bar
    session('2026-10-28T12:00:00Z', [track('E', 'X')]), // 14 days ago: out
  ];
  const { days } = listeningStats(sessions, NOW);
  assert.equal(days.length, BAR_DAYS);
  assert.deepEqual(
    days.map((day) => day.sessions),
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2]
  );
  assert.equal(days.at(-1).date.getDate(), 11);
  assert.equal(days[0].date.getDate(), 29);
});

test('no data gives an empty result, and a future session is not counted', () => {
  const none = listeningStats([], NOW);
  assert.equal(none.empty, true);
  assert.equal(none.source, null);
  assert.equal(none.thisWeek, 0);
  assert.deepEqual(none.topTracks, []);
  assert.deepEqual(none.topArtists, []);
  assert.equal(none.longest, null);
  assert.equal(none.busiestHour, null);
  assert.ok(none.days.every((day) => day.sessions === 0));
  assert.equal(listeningStats([session('2026-11-20T12:00:00Z', [track('A', 'X')])], NOW).empty, true);
});

test('top tracks and artists count plays over 30 days, and break ties by recency, then name', () => {
  const sessions = [
    session('2026-11-10T20:00:00Z', [track('Alpha', 'Zed'), track('Beta', 'Yan', 400), track('alpha', 'zed', 800)]),
    session('2026-11-05T20:00:00Z', [track('Gamma', 'Yan'), track('Delta', 'Xia', 400)]),
    session('2026-09-01T20:00:00Z', [
      track('Old', 'Ancient'),
      track('Old', 'Ancient', 400),
      track('Old', 'Ancient', 800),
    ]),
  ];
  const result = listeningStats(sessions, NOW);
  // Alpha twice (case does not matter); then Beta (recent) before Gamma and Delta (older, Gamma first).
  assert.deepEqual(
    result.topTracks.map((row) => [row.name, row.plays]),
    [
      ['Alpha', 2],
      ['Beta', 1],
      ['Delta', 1],
      ['Gamma', 1],
    ]
  );
  assert.deepEqual(
    result.topArtists.map((row) => [row.name, row.plays]),
    [
      ['Zed', 2],
      ['Yan', 2],
      ['Xia', 1],
    ]
  );
  assert.equal(listeningStats(sessions, NOW, { limit: 1 }).topTracks.length, 1);
});

test('a track with no artist is a track but not an artist', () => {
  const result = listeningStats([session('2026-11-10T20:00:00Z', [track('Solo', '')])], NOW);
  assert.equal(result.topTracks.length, 1);
  assert.equal(result.topArtists.length, 0);
});

test('the longest session is the longest of the last 30 days, the newest on a tie', () => {
  const sessions = [
    session('2026-11-10T20:00:00Z', [track('A', 'X', 0, 3600)], 'journal', 'Long'),
    session('2026-11-09T20:00:00Z', [track('B', 'X', 0, 3600)], 'journal', 'Tie'),
    session('2026-08-01T20:00:00Z', [track('C', 'X', 0, 9999)], 'journal', 'Ancient'),
  ];
  const result = listeningStats(sessions, NOW);
  assert.equal(result.longest.title, 'Long');
  assert.equal(result.longest.seconds, 3600);
});

test('the busiest hour is in local time, the earlier hour on a tie', () => {
  // 02:00 UTC is 21:00 in New York (the evening before); 15:00 UTC is 10:00.
  const sessions = [
    session('2026-11-10T02:00:00Z', [track('A', 'X'), track('B', 'X', 600)]),
    session('2026-11-10T15:00:00Z', [track('C', 'X'), track('D', 'X', 600)]),
  ];
  assert.deepEqual(listeningStats(sessions, NOW).busiestHour, { hour: 10, plays: 2 });
  const lone = listeningStats([session('2026-11-10T02:00:00Z', [track('A', 'X')])], NOW);
  assert.deepEqual(lone.busiestHour, { hour: 21, plays: 1 });
});

test("a track's play time is the session's start plus the track's start", () => {
  const set = session('2026-11-10T20:00:00Z', [track('A', 'X', 90)]);
  assert.equal(playedAt(set, set.tracks[0]), Date.parse('2026-11-10T20:01:30Z'));
});

test('the source says whether the numbers are made up, imported or the board', () => {
  const demo = session('2026-11-10T20:00:00Z', [track('A', 'X')], 'demo');
  const mine = session('2026-11-10T20:00:00Z', [track('A', 'X')], 'journal');
  const board = session('2026-11-10T20:00:00Z', [track('A', 'X')], 'board');
  assert.equal(sourceOf([]), null);
  assert.equal(sourceOf([demo]), 'demo');
  assert.equal(sourceOf([mine]), 'imported');
  assert.equal(sourceOf([board]), 'board');
  assert.equal(sourceOf([demo, mine]), 'mixed');
  assert.match(sourceWords('demo'), /Made-up/);
  assert.match(sourceWords('imported'), /imported/);
  assert.match(sourceWords('mixed'), /imported/);
  assert.equal(sourceWords('board'), null);
  assert.equal(hourWords(0), '12 am');
  assert.equal(hourWords(12), '12 pm');
  assert.equal(hourWords(21), '9 pm');
});
