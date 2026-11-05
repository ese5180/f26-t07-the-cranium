/**
 * The update history: GET /api/updates, and the last update on a board's own page.
 *
 *   GET /api/updates?thing=<name>&limit=<1-100>&cursor=<cursor>
 *     -> { updates: [Update], cursor, generatedAt }
 *        newest first, 25 a page unless `limit` says otherwise; every board of the group unless
 *        `thing` names one
 *
 * An Update is { id, thing, from, to, how, deployment, who, outcome, startedAt, endedAt, status }
 * (lib/updates.mjs presentUpdate): `how` is deployment, bluetooth or usb_or_other; `who` is
 * { sub, email, name } of whoever started the deployment, or of whoever's phone checked the image
 * right before an update over Bluetooth, or null; `status` is a deployment's execution status.
 * A read, for viewers and release managers alike, from the website, a phone app or an API token;
 * it goes on no record.
 *
 * What each board's list is made of: its executions in AWS IoT Jobs, and its facts (pk
 * "UPD#<thing>" in the events table), which the recorder puts as the board reports. Who started a
 * deployment is in its job's description, read through the deployments' cache; who sent an update
 * over Bluetooth is looked up in the activity log, in a window of a little over two hours, and
 * remembered once that window is over. A board's list is kept for LIST_MS.
 *
 * The backfill. A board whose partition of facts has no marker (M#backfill) has its facts made
 * once from what the events table already holds of it: its shadow's events of the last 90 days
 * (firmware, update and Bluetooth: how long events are kept) and its log's BT lines (from firmware
 * 1.12.0 on, kept as long). They are put like the recorder's, so nothing is there twice, and then
 * the marker. That is done by the first read that needs the board's list, of whatever route. If a
 * fact cannot be put, the facts that were made serve this instance for BACKFILL_RETRY_MS, and the
 * backfill is tried again after that; the list never waits on the backfill's writes to be shown.
 */

import { badRequest, describeError, field, notFound } from '../http.mjs';
import { eventRange } from '../lib/events.mjs';
import { MAX_IN_FLIGHT, mapLimit } from '../lib/jobs.mjs';
import { lineRange } from '../lib/lines.mjs';
import {
  BACKFILL_KEY, afterCursor, backfillMarker, checkWindow, decodeUpdateCursor, encodeUpdateCursor, factFromItem,
  factsFromItems, foldUpdates, newestFirst, pageSizeOf, personOf, pickCheck, presentUpdate,
} from '../lib/updates.mjs';
import { parseJobId, requireThing } from '../lib/validate.mjs';

const LIST_MS = 5_000;
const BACKFILL_RETRY_MS = 10 * 60_000;
// What the backfill reads of a board: the kinds of event that say something of an update, and the BT lines.
const BACKFILL_KINDS = Object.freeze(['firmware', 'update', 'bluetooth']);
const BACKFILL_LIMIT = 20_000;
// The entries of the activity log read for one update over Bluetooth: its window holds few.
const CHECK_ENTRIES = 500;
const MAX_REMEMBERED = 2048;

const iso = (ms) => new Date(ms).toISOString();

function remember(map, key, value) {
  if (map.size >= MAX_REMEMBERED) map.clear();
  map.set(key, value);
}

export function createUpdateHandlers({ aws, now, log }, { devices, deployments }) {
  const lists = new Map();      // thing -> { records, at }
  const unwritten = new Map();  // thing -> { facts, at }: a backfill whose facts could not all be put
  const checks = new Map();     // update id + window -> the check before its send, or null
  const creators = new Map();   // deployment id -> who started it, or null

  function warn(event, fields, error) {
    log({ level: 'warn', event, ...fields, error: describeError(error).message });
  }

  /** Make a board's facts from what the events table holds, and put them. Returns the facts. */
  async function backfill(thing) {
    const nowMs = now();
    const [events, lines] = await Promise.all([
      aws.queryEvents({ thing, ...eventRange(0, nowMs + 60_000), kinds: [...BACKFILL_KINDS], limit: BACKFILL_LIMIT }),
      aws.queryEvents({ thing, ...lineRange(0, nowMs + 60_000), kinds: ['bluetooth'], tags: ['BT'], limit: BACKFILL_LIMIT }),
    ]);
    // One for each key, at its first time: the board says some of them again and again.
    const first = new Map();
    for (const item of factsFromItems([...events, ...lines])) {
      if (!first.has(item.sk) || first.get(item.sk).at > item.at) first.set(item.sk, item);
    }
    const facts = [...first.values()];
    try {
      await mapLimit(facts, MAX_IN_FLIGHT, (item) => aws.putUpdateFact(item));
      const oldest = facts.reduce((least, item) => Math.min(least, item.at), Infinity);
      await aws.putUpdateFact(backfillMarker(thing, {
        at: nowMs, facts: facts.length, oldest: Number.isFinite(oldest) ? oldest : null,
      }));
      unwritten.delete(thing);
    } catch (error) {
      warn('updates_backfill_unwritten', { thing }, error);
      remember(unwritten, thing, { facts, at: nowMs });
    }
    return facts;
  }

  /** A board's facts: those stored, and those of its backfill if it has not been written yet. */
  async function factsOf(thing) {
    const stored = await aws.queryUpdateFacts(thing);
    const facts = stored.map(factFromItem).filter((item) => item !== null);
    if (stored.some((item) => item?.sk === BACKFILL_KEY)) return facts;
    const kept = unwritten.get(thing);
    let made = kept !== undefined && now() - kept.at < BACKFILL_RETRY_MS ? kept.facts : null;
    if (made === null) {
      try {
        made = await backfill(thing);
      } catch (error) {
        warn('updates_backfill_failed', { thing }, error);
        made = [];
      }
    }
    // The earliest of each key, as the table keeps it.
    const byKey = new Map(facts.map((item) => [item.sk, item]));
    for (const item of made.map(factFromItem).filter((candidate) => candidate !== null)) {
      const there = byKey.get(item.sk);
      if (there === undefined || there.at > item.at) byKey.set(item.sk, item);
    }
    return [...byKey.values()];
  }

  /** Who started each deployment among the records, from its job's description. */
  async function addCreators(records) {
    const ids = [...new Set(records.filter((record) => record.how === 'deployment' && parseJobId(record.deployment) !== null)
      .map((record) => record.deployment))].filter((id) => !creators.has(id));
    await mapLimit(ids, MAX_IN_FLIGHT, async (id) => {
      try {
        const summary = await deployments.summary(id);
        // A job that is gone says nobody, and stays so.
        remember(creators, id, personOf(summary?.createdBy ?? null));
      } catch (error) {
        warn('deployment_unreadable', { deployment: id }, error);
      }
    });
    for (const record of records) {
      if (record.how === 'deployment') record.who = creators.get(record.deployment) ?? null;
    }
  }

  /** Who sent each update over Bluetooth among the records, from the check their phone made before the send. */
  async function addSenders(records) {
    const nowMs = now();
    await mapLimit(records.filter((record) => record.how === 'bluetooth'), MAX_IN_FLIGHT, async (record) => {
      const window = checkWindow(record);
      const key = `${record.id} ${window.fromMs}`;
      let found = checks.get(key);
      if (found === undefined) {
        try {
          const entries = await aws.queryAudit({
            before: `${iso(window.toMs)}~`, after: iso(window.fromMs), limit: CHECK_ENTRIES,
          });
          const check = pickCheck(record, entries);
          found = check === null ? null : { who: personOf(check.actor), at: Date.parse(check.at) };
          // A window that is over cannot gain an entry: remember what it held.
          if (window.toMs < nowMs) remember(checks, key, found);
        } catch (error) {
          warn('checks_unreadable', { thing: record.thing }, error);
          found = null;
        }
      }
      record.who = found?.who ?? null;
      // The update began when the phone was about to send it.
      if (found !== null && Number.isFinite(found.at)) record.startedAt = Math.min(record.startedAt, found.at);
    });
  }

  /**
   * One board's updates, newest first, as records (lib/updates.mjs foldUpdates) with who. `executions`
   * are the board's executions if the caller has read them already.
   */
  async function recordsOf(thing, { executions = null } = {}) {
    const cached = lists.get(thing);
    if (cached !== undefined && now() - cached.at < LIST_MS) return cached.records;
    const [facts, listed] = await Promise.all([
      factsOf(thing),
      executions === null ? aws.listJobExecutionsForThing(thing) : executions,
    ]);
    const records = foldUpdates({ thing, facts, executions: listed, nowMs: now() });
    await Promise.all([addCreators(records), addSenders(records)]);
    for (const record of records) record.sortAt = record.startedAt ?? record.endedAt;
    records.sort(newestFirst);
    remember(lists, thing, { records, at: now() });
    return records;
  }

  /** Every registered board's updates (or those of `only`), newest first. */
  async function allRecords(only = null) {
    const things = only ?? await devices.groupThings();
    const lists_ = await mapLimit(things, MAX_IN_FLIGHT, (thing) => recordsOf(thing));
    return lists_.flat().sort(newestFirst);
  }

  /** The last update of a board, as GET /api/devices/{thing} gives it, or null; never a failure. */
  async function lastOf(thing) {
    try {
      const [newest] = await recordsOf(thing);
      return newest === undefined ? null : presentUpdate(newest);
    } catch (error) {
      warn('updates_unreadable', { thing }, error);
      return null;
    }
  }

  return {
    recordsOf,
    allRecords,
    lastOf,

    /** A board's own page with its last update beside it. */
    withLastUpdate(run) {
      return async (request) => {
        const result = await run(request);
        const thing = result.body?.device?.thing;
        if (typeof thing === 'string') result.body.lastUpdate = await lastOf(thing);
        return result;
      };
    },

    async list({ query }) {
      const thing = field(query, 'thing');
      if (thing !== undefined) requireThing(thing);
      const limit = pageSizeOf(field(query, 'limit'));
      if (limit === null) throw badRequest('invalid_limit', '"limit" must be a number from 1 to 100.');
      let cursor = null;
      if (field(query, 'cursor') !== undefined) {
        cursor = decodeUpdateCursor(field(query, 'cursor'));
        if (cursor === null) throw badRequest('invalid_cursor', '"cursor" is not a cursor of this list.');
      }
      let only = null;
      if (thing !== undefined) {
        if (!(await devices.groupThings()).includes(thing)) {
          throw notFound('unknown_device', 'No board with that name is registered.');
        }
        only = [thing];
      }
      const records = (await allRecords(only)).filter((record) => cursor === null || afterCursor(record, cursor));
      const shown = records.slice(0, limit);
      return {
        body: {
          updates: shown.map(presentUpdate),
          cursor: records.length > limit ? encodeUpdateCursor(shown[shown.length - 1]) : null,
          generatedAt: iso(now()),
        },
      };
    },
  };
}
