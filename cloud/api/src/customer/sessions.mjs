/**
 * What a customer's boards played (GET /api/c/sessions): the sessions and tracks the boards sent
 * (lib/sessions.mjs), as the customer site reads them, and what is on each board's decks now.
 *
 * Only the boards given are read, and the caller gives only the boards the customer owns now, and of each
 * only what it played since it was given to them (`assignedAt`): a session that started before, a track
 * played before and a now playing from before belong to an earlier owner, and are left out. A
 * board's thing name, its ownership and the session ids the board chose never leave: a board is its
 * `ref`, and a session's id is a hash of the two. A board that sent nothing adds nothing, and a
 * board whose items cannot be read is left out with a line in the log, not an error for the page.
 */

import { createHash } from 'node:crypto';

import {
  NOW_RANGE,
  PARTITION,
  SESSION_RANGE,
  nowPlayingFromItem,
  sessionFromItem,
  trackFromItem,
  trackRange,
} from '../lib/sessions.mjs';

export const SESSIONS_PER_BOARD = 100;
export const TRACKS_PER_BOARD = 2000;

/** The id the site uses (customer-core.js SESSION_ID): "s" and 8 hex digits, per board and session. */
export function siteSessionId(ref, id, startedAt) {
  return `s${createHash('sha256').update(`${ref}\u0000${id}\u0000${startedAt}`).digest('hex').slice(0, 8)}`;
}

const seconds = (ms) => Math.max(0, Math.round(ms / 100) / 10);

/** A session in the shape customer-mixes.js reads, with `source: "board"` and the board's ref. */
function shown(ref, session, tracks) {
  const began = Date.parse(session.startedAt);
  const list = tracks
    .filter((track) => track.session === session.id)
    .sort((a, b) => (a.playedAt < b.playedAt ? -1 : a.playedAt > b.playedAt ? 1 : 0))
    .map((track) => {
      const start = seconds(Date.parse(track.playedAt) - began);
      return {
        title: track.title,
        artist: track.artist,
        deck: null,
        start,
        end: Math.round((start + track.durationS) * 10) / 10,
        bpm: null,
        key: null,
        playedAt: track.playedAt,
        durationS: track.durationS,
      };
    });
  const out = {
    id: siteSessionId(ref, session.id, session.startedAt),
    title: session.title ?? 'A session',
    startedAt: session.startedAt,
    source: 'board',
    board: ref,
    tracks: list,
  };
  if (session.endedAt !== undefined) out.endedAt = session.endedAt;
  return out;
}

/**
 * @param {object} options
 * @param {{ queryEvents: Function }} options.aws
 * @param {{ thing: string, ref: string, assignedAt?: string }[]} options.boards  the customer's own, from the
 *                                 ownership items
 * @param {number} options.nowMs
 * @returns {Promise<{ sessions: object[], nowPlaying: object[] }>} sessions newest first
 */
export async function boardSessions({ aws, boards, nowMs, log = () => {} }) {
  const nowSec = nowMs / 1000;
  const live = (item) => !(Number.isFinite(item?.ttl) && item.ttl <= nowSec);
  const parts = await Promise.allSettled(
    boards.map(async ({ thing, ref, assignedAt }) => {
      const pk = `${PARTITION}${thing}`;
      const since = typeof assignedAt === 'string' ? Date.parse(assignedAt) : Number.NaN;
      const theirs = (iso) => !Number.isFinite(since) || Date.parse(iso) >= since;
      const sessions = (await aws.queryEvents({ thing: pk, ...SESSION_RANGE, limit: SESSIONS_PER_BOARD }))
        .filter(live)
        .map(sessionFromItem)
        .filter((session) => session !== null && theirs(session.startedAt));
      const oldest = sessions.reduce((low, session) => (session.startedAt < low ? session.startedAt : low), '9');
      const tracks =
        sessions.length === 0
          ? []
          : (await aws.queryEvents({ thing: pk, ...trackRange(oldest), limit: TRACKS_PER_BOARD }))
              .filter(live)
              .map(trackFromItem)
              .filter((track) => track !== null && theirs(track.playedAt));
      const [now] = await aws.queryEvents({ thing: pk, ...NOW_RANGE, limit: 1 });
      const found = live(now) ? nowPlayingFromItem(now, nowMs) : null;
      const playing = found !== null && theirs(found.playedAt) ? found : null;
      return {
        sessions: sessions.map((session) => shown(ref, session, tracks)).filter((session) => session.tracks.length > 0),
        nowPlaying: playing === null ? [] : [{ board: ref, ...playing }],
      };
    })
  );
  const sessions = [];
  const nowPlaying = [];
  parts.forEach((part, index) => {
    if (part.status === 'fulfilled') {
      sessions.push(...part.value.sessions);
      nowPlaying.push(...part.value.nowPlaying);
    } else {
      log({ level: 'warn', event: 'sessions_unreadable', board: boards[index].ref });
    }
  });
  sessions.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return { sessions, nowPlaying };
}
