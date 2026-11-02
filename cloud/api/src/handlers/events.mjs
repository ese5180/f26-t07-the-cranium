/**
 * The event log of the boards: GET /api/events and GET /api/devices/{thing}/samples.
 *
 * The recorder (recorder.mjs) writes what boards did into the events table; these two read
 * it back, for the boards of this project only: the members of its thing group, as for
 * /api/devices. Both are reads, for viewers and release managers alike, and neither goes on
 * record.
 *
 *   GET /api/events?from=<ISO>&to=<ISO>&thing=<name>&kinds=<a,b>&limit=<n>&cursor=<cursor>
 *     -> { events: [{ thing, at, id, kind, what, level, text, ...fields }], cursor, from, to }
 *        newest first, at most 500 a page; `to` is now and `from` a day before it unless
 *        given, at most 31 days apart; every board of the group unless `thing` names one
 *
 *   GET /api/devices/{thing}/samples?hours=<1-168>
 *     -> { thing, hours, from, to, samples: [{ at, rssi, uptime, heapFree, heapLeast }],
 *          bucketSeconds }
 *        oldest first, at most 600; when there were more, each stands for a bucket of
 *        bucketSeconds (lib/events.mjs thinSamples), otherwise bucketSeconds is 0
 */

import { badRequest, field, notFound } from '../http.mjs';
import {
  KINDS, decodeEventCursor, encodeEventCursor, eventFromItem, eventRange, orderKey, sampleFromItem, sampleRange,
  thinSamples,
} from '../lib/events.mjs';
import {
  requireEventPageSize, requireEventRange, requireHours, requireKinds, requireThing, requireTime,
} from '../lib/validate.mjs';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_POINTS = 600;

const iso = (ms) => new Date(ms).toISOString();

export function createEventHandlers({ aws, now }, { devices }) {
  /** The board that was asked for, which must be in the group, or every board of it. */
  async function boardsOf(query) {
    const thing = field(query, 'thing');
    if (thing !== undefined) requireThing(thing);
    const things = await devices.groupThings();
    if (thing === undefined) return things;
    if (!things.includes(thing)) throw notFound('unknown_device', 'No board with that name is registered.');
    return [thing];
  }

  return {
    async list({ query }) {
      const toMs = requireTime(field(query, 'to'), 'to', now());
      const fromMs = requireTime(field(query, 'from'), 'from', toMs - DAY_MS);
      requireEventRange(fromMs, toMs);
      const kinds = requireKinds(field(query, 'kinds'), KINDS);
      const limit = requireEventPageSize(field(query, 'limit'));
      let cursor = null;
      if (field(query, 'cursor') !== undefined) {
        cursor = decodeEventCursor(field(query, 'cursor'));
        if (cursor === null) throw badRequest('invalid_cursor', '"cursor" is not a cursor from this log.');
      }
      const things = await boardsOf(query);

      // Each board's newest, from where the last page ended. An event of another board can
      // have the same time; the board's name decides the order then (orderKey).
      const range = eventRange(fromMs, toMs);
      const high = cursor !== null && cursor.sk < range.high ? cursor.sk : range.high;
      const after = cursor === null ? null : orderKey({ sk: cursor.sk, pk: cursor.thing });
      // Two more than a page: one to know that another page follows, one for the event the
      // last page ended on, which comes back with its board's part.
      const parts = await Promise.all(things.map((thing) =>
        aws.queryEvents({ thing, low: range.low, high, kinds, limit: limit + 2 })));
      // DynamoDB deletes an expired item some time after its ttl, and returns it until then.
      const nowSec = now() / 1000;
      const ordered = parts.flat()
        .filter((item) => typeof item?.sk === 'string' && typeof item?.pk === 'string')
        .filter((item) => !(Number.isFinite(item.ttl) && item.ttl <= nowSec))
        .filter((item) => after === null || orderKey(item) < after)
        .sort((a, b) => (orderKey(a) < orderKey(b) ? 1 : -1));
      const page = ordered.slice(0, limit);
      return {
        body: {
          events: page.map(eventFromItem).filter((event) => event !== null),
          cursor: ordered.length > limit ? encodeEventCursor(page[page.length - 1]) : null,
          from: iso(fromMs),
          to: iso(toMs),
        },
      };
    },

    async samples({ params, query }) {
      const thing = requireThing(params.thing);
      const hours = requireHours(field(query, 'hours'));
      if (!(await devices.groupThings()).includes(thing)) {
        throw notFound('unknown_device', 'No board with that name is registered.');
      }
      const toMs = now();
      const fromMs = toMs - hours * HOUR_MS;
      const items = await aws.querySamples({ thing, ...sampleRange(fromMs, toMs) });
      const readings = items.map(sampleFromItem).filter((sample) => sample !== null);
      const { samples, bucketSeconds } = thinSamples(readings, { fromMs, toMs, max: MAX_POINTS });
      return { body: { thing, hours, from: iso(fromMs), to: iso(toMs), samples, bucketSeconds } };
    },
  };
}
