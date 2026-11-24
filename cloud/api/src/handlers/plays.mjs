/**
 * What a board played (lib/sessions.mjs, firmware 1.20.1): each track Mixxx reported playing on the board's
 * Raspberry Pi, as the board forwarded it, in the order played (docs/customer-data.md, "Plays").
 *
 *   GET /api/devices/{thing}/plays?limit=<1-500>
 *     -> { thing, plays: [Play], more, generatedAt }
 *        the newest `limit` plays (PLAYS_DEFAULT unless asked), oldest first
 *
 * A Play is { title, artist, genre, bpm, key, lengthS, playedAt, playedS, playing }. `bpm` is the Pi's bpm10 / 10
 * and `key` its `ky`, each null when the Pi did not say; `lengthS` is the track's length; `playedS` how long it
 * played: until the next play began, at most its length, null while it is `playing`. `more` says there are older
 * plays than the list has. A read, for viewers and release managers alike, from the website, a phone app or an API
 * token, like a board's timeline; it goes on no record.
 */

import { badRequest, field, notFound } from '../http.mjs';
import { PARTITION, PLAY_RANGE, playFromItem, playsInOrder } from '../lib/sessions.mjs';
import { requireThing } from '../lib/validate.mjs';

export const PLAYS_DEFAULT = 200;
export const PLAYS_MAX = 500;

/** The number of plays asked for, PLAYS_DEFAULT if none, or null if it is not one. */
export function playsLimit(value) {
  if (value === undefined) return PLAYS_DEFAULT;
  if (typeof value !== 'string' || !/^[1-9]\d{0,2}$/.test(value)) return null;
  const count = Number(value);
  return count <= PLAYS_MAX ? count : null;
}

export function createPlaysHandlers({ aws, now }, { devices }) {
  return {
    async board({ params, query }) {
      const thing = requireThing(params.thing);
      const limit = playsLimit(field(query, 'limit'));
      if (limit === null) throw badRequest('invalid_limit', `"limit" must be a number from 1 to ${PLAYS_MAX}.`);
      if (!(await devices.groupThings()).includes(thing)) {
        throw notFound('unknown_device', 'No board with that name is registered.');
      }
      const nowMs = now();
      // Newest first, and one more than asked for, to know whether there are older ones.
      const items = await aws.queryEvents({ thing: `${PARTITION}${thing}`, ...PLAY_RANGE, limit: limit + 1 });
      const live = items.filter((item) => !(Number.isFinite(item?.ttl) && item.ttl <= nowMs / 1000));
      const plays = live
        .slice(0, limit)
        .map(playFromItem)
        .filter((play) => play !== null);
      return {
        body: {
          thing,
          plays: playsInOrder(plays, nowMs),
          more: items.length > limit,
          generatedAt: new Date(nowMs).toISOString(),
        },
      };
    },
  };
}
