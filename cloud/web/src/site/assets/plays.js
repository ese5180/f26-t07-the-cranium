/**
 * What each board played (firmware 1.20.1, docs/customer-data.md "Plays"): the Plays card of a board's page, a table
 * of the tracks Mixxx reported playing on the board's Raspberry Pi, in the order they were played, with each one's
 * title, artist, BPM, key, how long it played and when. The track playing now says so.
 *
 * It reads GET /api/devices/{thing}/plays (cloud/api/src/handlers/plays.mjs), the newest PLAYS_SHOWN, when a board's
 * page is first opened and again at most once a minute (app.js). Time played is the cloud's: until the next track
 * began, at most the track's length. The key is "—" until the Pi sends one.
 */

import { PLAYS_SHOWN, clockTime, exactTime, isThing } from './core.js';
import { badge, card, h, loading } from './views.js';

// A board's plays are read again at most once a minute.
export const PLAYS_REFRESH_MS = 60_000;
const MISSING = '—';

let tools = null;

/** app.js hands over what the card needs once: { state, api, load, now }. */
export function connect(given) {
  tools = given;
  tools.state.plays ??= new Map();
}

/** A board's plays: again only after PLAYS_REFRESH_MS, unless all is read again. */
export async function refreshPlays(thing, full = false) {
  const { state, api, load, now } = tools;
  if (!isThing(thing)) return;
  if (!state.plays.has(thing)) state.plays.set(thing, { value: null, error: null, loadedAt: 0, loading: false });
  const target = state.plays.get(thing);
  if (!full && target.loadedAt !== 0 && now() - target.loadedAt < PLAYS_REFRESH_MS) return;
  await load(target, () => api.plays(thing, { limit: PLAYS_SHOWN }));
}

// Words.

/** "128", "124.5", or "—" when the Pi did not say. */
export function bpmWords(bpm) {
  if (!Number.isFinite(bpm) || bpm <= 0) return MISSING;
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1);
}

/** "4:58", "1:02:03", or "—" when it is not known. */
export function playedWords(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return MISSING;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

// The card.

const COLUMNS = ['#', 'Title', 'Artist', 'BPM', 'Key', 'Time played', 'When'];

function playRow(play, order, nowMs) {
  return h(
    'tr',
    { key: `${play.playedAt}-${order}`, class: play.playing ? 'is-playing' : null },
    h('td', { class: 'plays-order' }, String(order)),
    h('th', { scope: 'row', class: 'plays-title' }, play.title || 'Untitled'),
    h('td', { class: 'plays-artist' }, play.artist || MISSING),
    h('td', { class: 'plays-number' }, bpmWords(play.bpm)),
    h('td', { class: 'plays-key' }, play.key ?? MISSING),
    h(
      'td',
      { class: 'plays-number' },
      play.playing ? badge('good', 'pulse', 'Playing', 'On the decks now') : playedWords(play.playedS)
    ),
    h(
      'td',
      { class: 'plays-when' },
      h('time', { datetime: play.playedAt, title: exactTime(play.playedAt) }, clockTime(play.playedAt, nowMs))
    )
  );
}

/** The table of a board's plays, oldest first and numbered in the order played; or why there is none. */
export function playsTable(thing, ctx) {
  const target = ctx.state.plays?.get(thing) ?? null;
  if (target === null || (!target.value && !target.error)) return loading('the plays');
  if (!target.value) return h('p', { class: 'quiet', key: 'failed' }, 'The plays could not be read.');
  const { plays, more } = target.value;
  if (plays.length === 0) {
    return h(
      'p',
      { class: 'quiet', key: 'none' },
      'Nothing played yet. A board on firmware 1.20.1 or later sends each track Mixxx plays on its Raspberry Pi.'
    );
  }
  return [
    h(
      'div',
      { class: 'plays-table-wrap', key: 'table' },
      h(
        'table',
        { class: 'ui-table data-table plays-table' },
        h('caption', { class: 'sr-only' }, 'Tracks played, in the order played'),
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            COLUMNS.map((name) => h('th', { scope: 'col', key: name }, name))
          )
        ),
        h(
          'tbody',
          null,
          plays.map((play, index) => playRow(play, index + 1, ctx.state.now))
        )
      )
    ),
    more
      ? h('p', { class: 'ui-card-note card-note', key: 'more' }, `The latest ${plays.length} are shown, oldest first.`)
      : null,
  ];
}

/** The Plays card of a board's page, the width of the page. */
export function playsSection(thing, ctx) {
  return card(
    { key: 'plays', title: 'Plays', className: 'plays' },
    playsTable(thing, ctx),
    h(
      'p',
      { class: 'ui-card-note card-note', key: 'note' },
      'Each track Mixxx played on this board’s Raspberry Pi, in order. Time played runs until the next track began, ',
      'at most the track’s length. The key shows once the Pi sends it.'
    )
  );
}
