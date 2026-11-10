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
 * Two kinds of message, both with "v": 1:
 *
 *   { v, type: "session", id, startedAt, endedAt?, title?, tracks?: [Track] }
 *   { v, type: "now", playing: false }
 *   { v, type: "now", playing: true, title, artist?, playedAt, durationS?, session? }
 *   Track: { title, artist?, playedAt, durationS }
 *
 * Items, in the events table, in a partition of their own (pk "SES#<thing>"), so that nothing that reads
 * a board's events sees them:
 *
 *   sk = "S#<startedAt>#<id>"   a session: { id, title?, startedAt, endedAt?, at }, kept SESSION_DAYS
 *   sk = "T#<playedAt>#<id>"    a track of session <id>: { session, title, artist, playedAt, durationS }
 *   sk = "NOW"                  what is on the decks now, replaced by each "now" message, kept a day
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
// A board that has no clock set reports a date before this; one that is ahead by more than a day is wrong.
export const EARLIEST_MS = Date.UTC(2024, 0, 1);
const AHEAD_MS = 86_400_000;
// A "now" with no length that is older than this has long ended.
export const NOW_STALE_MS = 15 * 60_000;

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CONTROL = /[\p{C}\p{Zl}\p{Zp}]/u;
const SESSION_KEY = /^S#(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#([A-Za-z0-9_-]{1,40})$/;
const TRACK_KEY = /^T#(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#([A-Za-z0-9_-]{1,40})$/;

const SESSION_FIELDS = ['v', 'type', 'id', 'startedAt', 'endedAt', 'title', 'tracks'];
const NOW_FIELDS = ['v', 'type', 'playing', 'title', 'artist', 'playedAt', 'durationS', 'session'];
const TRACK_FIELDS = ['title', 'artist', 'playedAt', 'durationS'];
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
  return { ignored: 'unknown_type' };
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
