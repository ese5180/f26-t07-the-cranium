/**
 * A board's version timeline (lib/board-timeline.mjs, docs/compare.md).
 *
 *   GET /api/devices/{thing}/timeline?limit=<1-50>&cursor=<cursor>
 *     -> { thing, current, versions: [Stay], cursor, countedFrom, generatedAt }
 *        newest first, 20 a page unless `limit` says otherwise
 *
 * A Stay is { version, startedAt, endedAt, current, arrived, deployment, status, reboots, issues,
 * countedFrom }. A read, for viewers and release managers alike, from the website, a phone app or an
 * API token; it goes on no record. Compare (#/compare) reads this route and the board routes it
 * already had, nothing of its own.
 *
 * What it reads: the board's update history (handlers/updates.mjs recordsOf, the same as GET
 * /api/updates and the roll back to last good), its shadow, the releases, and its warnings in the
 * events table of the last EVENT_DAYS. A list of releases that cannot be read leaves the rebuilds
 * unknown (an arrival by a roll back to last good then shows as ota); warnings that cannot be read
 * leave the counts null. Neither fails the read.
 */

import { badRequest, describeError, field, notFound } from '../http.mjs';
import { EVENT_DAYS, KINDS, eventFromItem, eventRange } from '../lib/events.mjs';
import { boardTimeline, decodeTimelineCursor, encodeTimelineCursor, timelinePageSize } from '../lib/board-timeline.mjs';
import { requireThing } from '../lib/validate.mjs';
import { releaseFromItem } from './firmware.mjs';

const DAY_MS = 86_400_000;
const WARNINGS_LIMIT = 5_000;

export function createTimelineHandlers({ aws, now, log }, { devices, updates }) {
  function warn(event, fields, error) {
    log({ level: 'warn', event, ...fields, error: describeError(error).message });
  }

  async function releases() {
    try {
      return (await aws.listReleases()).map(releaseFromItem).filter((release) => release !== null);
    } catch (error) {
      warn('releases_unreadable', {}, error);
      return [];
    }
  }

  async function warnings(thing, nowMs) {
    try {
      const items = await aws.queryEvents({
        thing,
        ...eventRange(nowMs - EVENT_DAYS * DAY_MS, nowMs + 60_000),
        kinds: KINDS.filter((kind) => kind !== 'connection'),
        level: 'warn',
        limit: WARNINGS_LIMIT,
      });
      return items.map(eventFromItem).filter((event) => event !== null);
    } catch (error) {
      warn('events_unreadable', { thing }, error);
      return null;
    }
  }

  return {
    async board({ params, query }) {
      const thing = requireThing(params.thing);
      const limit = timelinePageSize(field(query, 'limit'));
      if (limit === null) throw badRequest('invalid_limit', '"limit" must be a number from 1 to 50.');
      let offset = 0;
      if (field(query, 'cursor') !== undefined) {
        offset = decodeTimelineCursor(field(query, 'cursor'));
        if (offset === null) throw badRequest('invalid_cursor', '"cursor" is not a cursor of this timeline.');
      }
      if (!(await devices.groupThings()).includes(thing)) {
        throw notFound('unknown_device', 'No board with that name is registered.');
      }
      const nowMs = now();
      const [records, [device], listed, events] = await Promise.all([
        updates.recordsOf(thing),
        devices.loadDevices([thing]),
        releases(),
        warnings(thing, nowMs),
      ]);
      let versions = boardTimeline({
        records,
        current: device?.fw ?? null,
        releases: listed,
        events: events ?? [],
        nowMs,
      });
      if (events === null)
        versions = versions.map((stay) => ({ ...stay, reboots: null, issues: null, countedFrom: null }));
      const shown = versions.slice(offset, offset + limit);
      return {
        body: {
          thing,
          current: device?.fw?.version ?? null,
          versions: shown,
          cursor: versions.length > offset + limit ? encodeTimelineCursor(offset + limit) : null,
          countedFrom: new Date(nowMs - EVENT_DAYS * DAY_MS).toISOString(),
          generatedAt: new Date(nowMs).toISOString(),
        },
      };
    },
  };
}
