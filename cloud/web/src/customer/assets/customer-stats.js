/**
 * "Your listening": what a customer's sessions say about the week, worked out in the browser from the
 * sessions the site already has (customer-mixes.js). Pure: it takes the sessions and the time, and every
 * day, week and hour is in the reader's own time zone (the Date methods without UTC).
 *
 * A track's play time is the session's start plus the track's start, in seconds. A week starts on Monday.
 * Ties are broken the same way everywhere: more plays first, then the one played most recently, then A to Z.
 */

import { deckSeconds, elapsedSeconds } from './customer-mixes.js';

const DAY_MS = 86400000;
export const WINDOW_DAYS = 30;
export const BAR_DAYS = 14;

const startOfDay = (when) => new Date(when.getFullYear(), when.getMonth(), when.getDate());
const addDays = (day, count) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + count);
const dayKey = (when) => `${when.getFullYear()}-${when.getMonth() + 1}-${when.getDate()}`;

/** Midnight at the start of the Monday of the week that holds the time. */
export function weekStart(time) {
  const day = startOfDay(new Date(time));
  return addDays(day, -((day.getDay() + 6) % 7));
}

/**
 * When a track started: the time the board sent for it (playedAt), else the session's start plus the track's
 * start. Null if neither is known.
 */
export function playedAt(session, track) {
  const sent = typeof track.playedAt === 'string' ? Date.parse(track.playedAt) : NaN;
  if (!Number.isNaN(sent)) return sent;
  const base = Date.parse(session.startedAt);
  if (Number.isNaN(base)) return null;
  return base + (Number.isFinite(track.start) ? track.start * 1000 : 0);
}

const nameKey = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

function rank(counts, limit) {
  return [...counts.values()]
    .sort((a, b) => b.plays - a.plays || b.last - a.last || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name, artist, plays }) => (artist === undefined ? { name, plays } : { name, artist, plays }));
}

/** Where the sessions came from: 'demo', 'imported', 'mixed', or 'board' (anything else); null with none. */
export function sourceOf(sessions) {
  if (sessions.length === 0) return null;
  const kinds = new Set(
    sessions.map((session) =>
      session.source === 'demo' ? 'demo' : session.source === 'journal' ? 'imported' : 'board'
    )
  );
  return kinds.size === 1 ? [...kinds][0] : 'mixed';
}

/**
 * The stats for the sessions, as of `now` (a time in ms).
 * { empty, source, thisWeek, lastWeek, days[14], topTracks, topArtists, longest, busiestHour }
 * where the weeks are seconds on the decks (a session counts in the week it started), days run oldest to
 * newest ending today, and the top lists, the longest session and the busiest hour are of the last 30 days.
 */
export function listeningStats(sessions, now, { limit = 5 } = {}) {
  const today = startOfDay(new Date(now));
  const thisMonday = weekStart(now);
  const lastMonday = addDays(thisMonday, -7);
  const from = now - WINDOW_DAYS * DAY_MS;

  const days = [];
  const dayAt = new Map();
  for (let back = BAR_DAYS - 1; back >= 0; back -= 1) {
    const date = addDays(today, -back);
    const entry = { date, sessions: 0, seconds: 0 };
    days.push(entry);
    dayAt.set(dayKey(date), entry);
  }

  let thisWeek = 0;
  let lastWeek = 0;
  const tracks = new Map();
  const artists = new Map();
  const hours = new Array(24).fill(0);
  let longest = null;
  let used = 0;

  for (const session of sessions) {
    const began = Date.parse(session.startedAt);
    if (Number.isNaN(began) || began > now) continue;
    used += 1;
    const seconds = deckSeconds(session);
    if (began >= thisMonday.getTime()) thisWeek += seconds;
    else if (began >= lastMonday.getTime()) lastWeek += seconds;
    const day = dayAt.get(dayKey(new Date(began)));
    if (day) {
      day.sessions += 1;
      day.seconds += seconds;
    }
    if (began >= from) {
      const length = Math.max(elapsedSeconds(session), seconds);
      if (!longest || length > longest.seconds || (length === longest.seconds && began > longest.at)) {
        longest = { id: session.id, title: session.title, seconds: length, at: began };
      }
    }
    for (const track of session.tracks) {
      const at = playedAt(session, track);
      if (at === null || at < from || at > now) continue;
      hours[new Date(at).getHours()] += 1;
      const key = `${nameKey(track.title)}\u0000${nameKey(track.artist)}`;
      const known = tracks.get(key);
      if (known) {
        known.plays += 1;
        known.last = Math.max(known.last, at);
      } else tracks.set(key, { name: track.title, artist: track.artist ?? '', plays: 1, last: at });
      if (nameKey(track.artist) !== '') {
        const artist = artists.get(nameKey(track.artist));
        if (artist) {
          artist.plays += 1;
          artist.last = Math.max(artist.last, at);
        } else artists.set(nameKey(track.artist), { name: track.artist.trim(), plays: 1, last: at });
      }
    }
  }

  let busiestHour = null;
  const most = Math.max(...hours);
  if (most > 0) busiestHour = { hour: hours.indexOf(most), plays: most };

  return {
    empty: used === 0,
    source: sourceOf(sessions),
    thisWeek,
    lastWeek,
    days: days.map(({ date, sessions: count, seconds }) => ({ date, sessions: count, seconds })),
    topTracks: rank(tracks, limit),
    topArtists: rank(artists, limit),
    longest: longest && { id: longest.id, title: longest.title, seconds: longest.seconds },
    busiestHour,
  };
}

/** "9 pm", "12 am": an hour of the day for a sentence. */
export function hourWords(hour) {
  const clock = hour % 12 === 0 ? 12 : hour % 12;
  return `${clock} ${hour < 12 ? 'am' : 'pm'}`;
}

/** The words that say where the numbers came from, or null for the board's own. */
export function sourceWords(source) {
  if (source === 'demo') return 'Made-up sessions, to show what this will be: no board sends what you play yet.';
  if (source === 'imported') return 'Worked out from the session files you imported, not from your board.';
  if (source === 'mixed') return 'Includes made-up or imported sessions as well as sessions from your board.';
  return null;
}
