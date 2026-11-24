/**
 * Listening sessions from the boards: what was played on the decks, as the board reports it.
 *
 * A board publishes on cranium/<thing>/session (docs/customer-data.md, "What the board sends"), and the
 * rule BoardSessionRule (infra/template.yaml) hands it to the recorder as
 *
 *   SELECT *, topic(2) AS thing, 'session' AS channel, timestamp() AS received FROM 'cranium/+/session'
 *   WHERE startswith(topic(2), 'cranium-') AND isUndefined(thing) AND isUndefined(received)
 *     AND isUndefined(channel)
 *
 * `thing` comes from the topic, which the device policy lets a board publish on for itself only, and
 * `received` is when AWS IoT got the message. Everything else is the board's, and is checked here
 * strictly: a field that is not on the list, a value out of range, a text with a control character or
 * a message over MAX_BYTES is dropped whole, with a reason and never its content.
 *
 * Three kinds of message, all with "v": 1:
 *
 *   { v, type: "session", id, startedAt, endedAt?, title?, tracks?: [Track] }
 *   { v, type: "now", playing: false }
 *   { v, type: "now", playing: true, title, artist?, playedAt, durationS?, session? }
 *   { v, type: "play", ageS?, np: Np }                                    (firmware 1.20.1)
 *   Track: { title, artist?, playedAt, durationS }
 *   Np: { t: "np", ti?, ar?, ge?, bpm10?, dur?, ky? }, the Pi's own message as it came
 *
 * A play is one track Mixxx reported playing (the Pi's np, pi/cranium_collect.py), which the board
 * forwards whole. The board has no clock: `ageS` is how long ago the np reached it, and the play is
 * dated from `received` less that. The np's texts are the Pi's, so they are cleaned (a control
 * character becomes a space, then cut to MAX_TEXT) rather than refused, and a field the cloud does not
 * know yet is left out, not refused: the Pi can add one (the key, `ky`) before the cloud reads it.
 *
 * Items, in the events table, in a partition of their own (pk "SES#<thing>"), so that nothing that reads
 * a board's events sees them:
 *
 *   sk = "S#<startedAt>#<id>"   a session: { id, title?, startedAt, endedAt?, at }, kept SESSION_DAYS
 *   sk = "T#<playedAt>#<id>"    a track of session <id>: { session, title, artist, playedAt, durationS }
 *   sk = "NOW"                  what is on the decks now, replaced by each "now" message, kept a day
 *   sk = "P#<playedAt>"         a play: { title, artist, genre?, bpm10?, key?, lengthS?, playedAt, at },
 *                               kept SESSION_DAYS; a recent play also replaces "NOW"
 *
 * The same message again replaces its own items. No AWS here, and no clock: the caller passes the time.
 */

import { isThing } from './validate.mjs';

export const SESSION_DAYS = 400;
export const NOW_TTL_S = 86_400;
export const MAX_BYTES = 6144;
export const MAX_TRACKS = 20;
export const MAX_TEXT = 120;
export const MAX_DURATION_S = 14_400;
export const MAX_SESSION_MS = 24 * 3_600_000;
export const PARTITION = 'SES#';
// What a play with no title is called where a title must be shown.
export const UNTITLED = 'Untitled';
// A board that has no clock set reports a date before this; one that is ahead by more than a day is wrong.
export const EARLIEST_MS = Date.UTC(2024, 0, 1);
const AHEAD_MS = 86_400_000;
// A "now" with no length that is older than this has long ended.
export const NOW_STALE_MS = 15 * 60_000;
// Plays. An np waits on the board while it is offline, at most this long in what it reports.
export const MAX_AGE_S = 7 * 86_400;
export const MAX_BPM10 = 9_999;
export const MAX_KEY = 12;
// A track's length (np's dur) beyond this is not one: it is left out.
export const MAX_LENGTH_S = 86_400;
// A play whose length is not known counts as played at most this long, before the next.
export const PLAYED_CAP_S = 3_600;
// A pause longer than this between one play's end and the next play's start begins a new set.
export const SET_GAP_MS = 30 * 60_000;

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CONTROL = /[\p{C}\p{Zl}\p{Zp}]/u;
const SESSION_KEY = /^S#(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#([A-Za-z0-9_-]{1,40})$/;
const TRACK_KEY = /^T#(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#([A-Za-z0-9_-]{1,40})$/;
const PLAY_KEY = /^P#(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;
const CONTROLS = /[\p{C}\p{Zl}\p{Zp}]/gu;

const SESSION_FIELDS = ['v', 'type', 'id', 'startedAt', 'endedAt', 'title', 'tracks'];
const NOW_FIELDS = ['v', 'type', 'playing', 'title', 'artist', 'playedAt', 'durationS', 'session'];
const TRACK_FIELDS = ['title', 'artist', 'playedAt', 'durationS'];
const PLAY_FIELDS = ['v', 'type', 'ageS', 'np'];
// What the rule adds; the board may add none of it.
const RULE_FIELDS = ['thing', 'received', 'channel'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => (isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined);

/** Whether a message from a rule is one of the sessions: only that rule adds `channel`. */
export function isSessionMessage(message) {
  return own(message, 'channel') === 'session';
}

/** A text as it may be stored, or null: 1 to MAX_TEXT characters (0 allowed if `empty`), no control character. */
function textOf(value, { empty = false } = {}) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length > MAX_TEXT || CONTROL.test(text)) return null;
  return text === '' && !empty ? null : text;
}

/** A time as epoch ms, from the strict ISO form with a Z, within the bounds; else null. */
function timeOf(value, nowMs) {
  if (typeof value !== 'string' || value.length > 30 || !ISO.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= EARLIEST_MS && ms <= nowMs + AHEAD_MS ? ms : null;
}

const secondsOf = (value) => (Number.isSafeInteger(value) && value >= 1 && value <= MAX_DURATION_S ? value : null);

const onlyThese = (value, names) => Object.keys(value).every((key) => names.includes(key));

function trackOf(raw, { fromMs, toMs, nowMs }) {
  if (!isObject(raw) || !onlyThese(raw, TRACK_FIELDS)) return null;
  const title = textOf(raw.title);
  const artist = raw.artist === undefined ? '' : textOf(raw.artist, { empty: true });
  const playedMs = timeOf(raw.playedAt, nowMs);
  const durationS = secondsOf(raw.durationS);
  if (title === null || artist === null || playedMs === null || durationS === null) return null;
  if (playedMs < fromMs || playedMs > toMs) return null;
  return { title, artist, playedMs, durationS };
}

/**
 * What one message becomes:
 *   { thing, items: [item] }   to store, in order
 *   { ignored: why }           dropped; `why` is a word, never the message
 *
 * @param {object} message   as the rule selects it
 * @param {{ nowMs: number }} options  the recorder's clock
 */
export function recordsFromSession(message, { nowMs }) {
  const thing = own(message, 'thing');
  if (!isThing(thing)) return { ignored: 'not_a_board' };
  if (!Number.isFinite(own(message, 'received'))) return { ignored: 'no_receipt' };
  const body = Object.fromEntries(Object.entries(message).filter(([key]) => !RULE_FIELDS.includes(key)));
  let size;
  try {
    size = JSON.stringify(body).length;
  } catch {
    return { ignored: 'bad_message' };
  }
  if (size > MAX_BYTES) return { ignored: 'too_big' };
  if (body.v !== 1) return { ignored: 'bad_version' };
  if (body.type === 'session') return sessionItems(thing, body, nowMs);
  if (body.type === 'now') return nowItem(thing, body, nowMs);
  if (body.type === 'play') return playItems(thing, body, message.received, nowMs);
  return { ignored: 'unknown_type' };
}

/**
 * A text of the Pi's: a control character becomes a space, then at most `max` UTF-16 units, as the
 * read side counts them, never splitting a character; trimmed; or null if not a text.
 */
function cleanedOf(value, max) {
  if (value === undefined) return '';
  if (typeof value !== 'string') return null;
  let cut = '';
  for (const point of value.replace(CONTROLS, ' ').trim()) {
    if (cut.length + point.length > max) break;
    cut += point;
  }
  return cut.trim();
}

/** A whole number of the Pi's from 0 to `max`, 0 when it is not there; or null. */
const countOf = (value, max) =>
  value === undefined ? 0 : Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;

function playItems(thing, body, receivedMs, nowMs) {
  if (!onlyThese(body, PLAY_FIELDS)) return { ignored: 'unknown_field' };
  const ageS = countOf(body.ageS, MAX_AGE_S);
  if (ageS === null) return { ignored: 'bad_age' };
  const np = body.np;
  if (!isObject(np) || np.t !== 'np') return { ignored: 'bad_np' };
  const title = cleanedOf(np.ti, MAX_TEXT);
  const artist = cleanedOf(np.ar, MAX_TEXT);
  const genre = cleanedOf(np.ge, MAX_TEXT);
  const key = cleanedOf(np.ky, MAX_KEY);
  const bpm10 = countOf(np.bpm10, MAX_BPM10);
  // A length past MAX_LENGTH_S is not a track's: left out, as a length of 0 is.
  const dur = np.dur === undefined ? 0 : Number.isSafeInteger(np.dur) && np.dur >= 0 ? np.dur : null;
  if ([title, artist, genre, key, bpm10, dur].includes(null)) return { ignored: 'bad_np' };
  const playedMs = Math.round(receivedMs) - ageS * 1000;
  if (playedMs < EARLIEST_MS || playedMs > nowMs + AHEAD_MS) return { ignored: 'bad_time' };
  const playedAt = new Date(playedMs).toISOString();
  const pk = `${PARTITION}${thing}`;
  const play = {
    pk,
    sk: `P#${playedAt}`,
    title,
    artist,
    playedAt,
    at: nowMs,
    ttl: Math.floor(nowMs / 1000) + SESSION_DAYS * 86_400,
  };
  if (genre !== '') play.genre = genre;
  if (bpm10 > 0) play.bpm10 = bpm10;
  if (key !== '') play.key = key;
  if (dur > 0 && dur <= MAX_LENGTH_S) play.lengthS = dur;
  const items = [play];
  // What is on the decks now, as a "now" message says it, while the play is recent enough to be.
  if (nowMs - playedMs < NOW_STALE_MS) {
    const now = { pk, sk: 'NOW', playing: true, title: title || UNTITLED, artist, playedAt, at: nowMs };
    if (dur > 0 && dur <= MAX_DURATION_S) now.durationS = dur;
    now.ttl = Math.floor(nowMs / 1000) + NOW_TTL_S;
    items.push(now);
  }
  return { thing, items };
}

function sessionItems(thing, body, nowMs) {
  if (!onlyThese(body, SESSION_FIELDS)) return { ignored: 'unknown_field' };
  if (typeof body.id !== 'string' || !ID.test(body.id)) return { ignored: 'bad_id' };
  const startedMs = timeOf(body.startedAt, nowMs);
  if (startedMs === null) return { ignored: 'bad_time' };
  let endedMs = null;
  if (body.endedAt !== undefined) {
    endedMs = timeOf(body.endedAt, nowMs);
    if (endedMs === null || endedMs < startedMs || endedMs - startedMs > MAX_SESSION_MS) {
      return { ignored: 'bad_time' };
    }
  }
  const title = body.title === undefined ? null : textOf(body.title);
  if (body.title !== undefined && title === null) return { ignored: 'bad_text' };
  const list = body.tracks === undefined ? [] : body.tracks;
  if (!Array.isArray(list) || list.length > MAX_TRACKS) return { ignored: 'bad_tracks' };
  const bounds = { fromMs: startedMs, toMs: endedMs ?? startedMs + MAX_SESSION_MS, nowMs };
  const tracks = [];
  for (const raw of list) {
    const track = trackOf(raw, bounds);
    if (track === null) return { ignored: 'bad_track' };
    tracks.push(track);
  }
  const ttl = Math.floor(nowMs / 1000) + SESSION_DAYS * 86_400;
  const header = {
    pk: `${PARTITION}${thing}`,
    sk: `S#${new Date(startedMs).toISOString()}#${body.id}`,
    id: body.id,
    startedAt: new Date(startedMs).toISOString(),
    at: nowMs,
    ttl,
  };
  if (endedMs !== null) header.endedAt = new Date(endedMs).toISOString();
  if (title !== null) header.title = title;
  const items = [header];
  for (const track of tracks) {
    items.push({
      pk: header.pk,
      sk: `T#${new Date(track.playedMs).toISOString()}#${body.id}`,
      session: body.id,
      title: track.title,
      artist: track.artist,
      playedAt: new Date(track.playedMs).toISOString(),
      durationS: track.durationS,
      ttl,
    });
  }
  return { thing, items };
}

function nowItem(thing, body, nowMs) {
  if (!onlyThese(body, NOW_FIELDS)) return { ignored: 'unknown_field' };
  if (typeof body.playing !== 'boolean') return { ignored: 'bad_playing' };
  const item = {
    pk: `${PARTITION}${thing}`,
    sk: 'NOW',
    playing: body.playing,
    at: nowMs,
    ttl: Math.floor(nowMs / 1000) + NOW_TTL_S,
  };
  if (!body.playing) {
    if (Object.keys(body).some((key) => !['v', 'type', 'playing'].includes(key))) return { ignored: 'unknown_field' };
    return { thing, items: [item] };
  }
  const title = textOf(body.title);
  const artist = body.artist === undefined ? '' : textOf(body.artist, { empty: true });
  const playedMs = timeOf(body.playedAt, nowMs);
  if (title === null || artist === null || playedMs === null) return { ignored: 'bad_text' };
  Object.assign(item, { title, artist, playedAt: new Date(playedMs).toISOString() });
  if (body.durationS !== undefined) {
    const durationS = secondsOf(body.durationS);
    if (durationS === null) return { ignored: 'bad_track' };
    item.durationS = durationS;
  }
  if (body.session !== undefined) {
    if (typeof body.session !== 'string' || !ID.test(body.session)) return { ignored: 'bad_id' };
    item.session = body.session;
  }
  return { thing, items: [item] };
}

// Reading back. Items are checked again on the way out: the table is not trusted either.

export const SESSION_RANGE = Object.freeze({ low: 'S#', high: 'S#~' });
export const trackRange = (fromIso) => ({ low: `T#${fromIso}`, high: 'T#~' });
export const NOW_RANGE = Object.freeze({ low: 'NOW', high: 'NOW' });

function cleanTime(value) {
  return typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

/** { id, startedAt, endedAt?, title? } from a session item, or null. */
export function sessionFromItem(item) {
  if (!isObject(item) || typeof item.sk !== 'string') return null;
  const key = SESSION_KEY.exec(item.sk);
  if (key === null || item.id !== key[2] || cleanTime(item.startedAt) !== key[1]) return null;
  const session = { id: key[2], startedAt: key[1] };
  const endedAt = item.endedAt === undefined ? null : cleanTime(item.endedAt);
  if (endedAt !== null) session.endedAt = endedAt;
  const title = item.title === undefined ? null : textOf(item.title);
  if (title !== null) session.title = title;
  return session;
}

/** { session, title, artist, playedAt, durationS } from a track item, or null. */
export function trackFromItem(item) {
  if (!isObject(item) || typeof item.sk !== 'string') return null;
  const key = TRACK_KEY.exec(item.sk);
  if (key === null || item.session !== key[2] || cleanTime(item.playedAt) !== key[1]) return null;
  const title = textOf(item.title);
  const artist = textOf(item.artist ?? '', { empty: true });
  const durationS = secondsOf(item.durationS);
  if (title === null || artist === null || durationS === null) return null;
  return { session: key[2], title, artist, playedAt: key[1], durationS };
}

/**
 * What is on the decks, or null: a "now" that says playing and is not stale (its track ended no more
 * than a minute ago or, with no length, it was reported no more than NOW_STALE_MS ago).
 */
export function nowPlayingFromItem(item, nowMs) {
  if (!isObject(item) || item.sk !== 'NOW' || item.playing !== true) return null;
  const title = textOf(item.title);
  const artist = textOf(item.artist ?? '', { empty: true });
  const playedAt = cleanTime(item.playedAt);
  if (title === null || artist === null || playedAt === null || !Number.isFinite(item.at)) return null;
  const durationS = item.durationS === undefined ? null : secondsOf(item.durationS);
  const end = durationS === null ? item.at + NOW_STALE_MS : Date.parse(playedAt) + durationS * 1000 + 60_000;
  if (nowMs > end) return null;
  const now = { title, artist, playedAt };
  if (durationS !== null) now.durationS = durationS;
  return now;
}

// Plays, read back (GET /api/devices/{thing}/plays, and the customer's sessions).

export const PLAY_RANGE = Object.freeze({ low: 'P#', high: 'P#~' });
export const playRange = (fromIso) => ({ low: `P#${fromIso}`, high: 'P#~' });

/** { title, artist, genre, bpm, key, lengthS, playedAt } from a play item, or null; bpm is bpm10 / 10. */
export function playFromItem(item) {
  if (!isObject(item) || typeof item.sk !== 'string') return null;
  const found = PLAY_KEY.exec(item.sk);
  if (found === null || cleanTime(item.playedAt) !== found[1]) return null;
  const title = textOf(item.title ?? '', { empty: true });
  const artist = textOf(item.artist ?? '', { empty: true });
  const genre = textOf(item.genre ?? '', { empty: true });
  const key = textOf(item.key ?? '', { empty: true });
  if (title === null || artist === null || genre === null || key === null || key.length > MAX_KEY) return null;
  const bpm10 = Number.isSafeInteger(item.bpm10) && item.bpm10 >= 1 && item.bpm10 <= MAX_BPM10 ? item.bpm10 : null;
  const lengthS =
    Number.isSafeInteger(item.lengthS) && item.lengthS >= 1 && item.lengthS <= MAX_LENGTH_S ? item.lengthS : null;
  return {
    title,
    artist,
    genre,
    bpm: bpm10 === null ? null : bpm10 / 10,
    key: key || null,
    lengthS,
    playedAt: found[1],
  };
}

/**
 * Plays in the order they were played, each with `playedS`, how long it played: until the next one began, at most
 * its length (PLAYED_CAP_S when its length is not known). The newest is `playing` while its length has not run out
 * (NOW_STALE_MS with no length), its playedS then null; after that it played its length as far as is known, or
 * null with none. Order is by playedAt; the same time twice is one play.
 */
export function playsInOrder(plays, nowMs) {
  const sorted = [...plays].sort((a, b) => (a.playedAt < b.playedAt ? -1 : a.playedAt > b.playedAt ? 1 : 0));
  return sorted.map((play, index) => {
    const startMs = Date.parse(play.playedAt);
    const next = sorted[index + 1];
    if (next !== undefined) {
      const gapS = Math.max(0, Math.round((Date.parse(next.playedAt) - startMs) / 1000));
      return { ...play, playedS: Math.min(gapS, play.lengthS ?? PLAYED_CAP_S), playing: false };
    }
    const runsUntil = startMs + (play.lengthS === null ? NOW_STALE_MS : play.lengthS * 1000);
    if (nowMs < runsUntil) return { ...play, playedS: null, playing: true };
    return { ...play, playedS: play.lengthS, playing: false };
  });
}

/**
 * Plays in order (playsInOrder) as sets: a new set begins where the pause between one play's end and the next
 * play's start is longer than SET_GAP_MS. Each set is { startedAt, endedAt, plays }, oldest first; endedAt is null
 * while its last play is playing or of unknown length.
 */
export function playSets(ordered) {
  const sets = [];
  let endMs = null;
  for (const play of ordered) {
    const startMs = Date.parse(play.playedAt);
    // endMs is null only before the first play: every play but the newest has a playedS.
    if (sets.length === 0 || endMs === null || startMs - endMs > SET_GAP_MS) {
      sets.push({ startedAt: play.playedAt, endedAt: null, plays: [] });
    }
    const set = sets[sets.length - 1];
    set.plays.push(play);
    endMs = play.playedS === null ? null : startMs + play.playedS * 1000;
    set.endedAt = endMs === null ? null : new Date(endMs).toISOString();
  }
  return sets;
}
