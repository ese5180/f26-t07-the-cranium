/**
 * Vitals: the boards' connected time, restarts, drops and memory over time, for the fleet and for one board
 * (lib/vitals.mjs, docs/own-observability.md stage 2). Our own, from the events table; Memfault's metrics stay
 * on a board's page.
 *
 *   GET /api/vitals?days=<1-90>
 *     -> { vitals, daily: [Day], perBoard: [BoardRow], versions: [Cohort], from, to, days, boards, unread,
 *          generatedAt }
 *        the last 7 days unless `days` says otherwise
 *
 *   GET /api/vitals/{thing}?days=<1-90>
 *     -> { board: BoardRow, vitals, daily: [Day & samples], versions: [Cohort], samplesFrom, samplesUnread,
 *          from, to, days, cut, generatedAt }
 *        a day's samples (signal, lowest free heap, longest uptime) only for the last 7 days, which is as long
 *        as samples are kept
 *
 * Reads, for viewers and release managers alike, from the website, a phone app or an API token, as the events
 * they are made of; neither goes on record. A customer's sign-in opens neither (app.mjs). Each board's events
 * are read with one Query of its key range (connection, restart, firmware and health kinds), the newest
 * EVENTS_READ at most, at most MAX_IN_FLIGHT boards at once. A board with more is `cut`: its window starts at
 * the oldest event read. A board whose first connection event in the window is a connect also has its last
 * connection event before the window read (one more Query, connection kind, limit 1), so that the time it was
 * offline before that connect counts; at 90 days nothing older is kept, and a cut board's window starts later. A
 * board whose events cannot be read is left out and counted in `unread`, so one board never fails the page.
 * Samples are read for one board's page only: about 2,900 a day at a report every 30 s.
 */

import { badRequest, describeError, field, notFound } from '../http.mjs';
import { EVENT_DAYS, SAMPLE_DAYS, eventFromItem, eventRange, sampleFromItem, sampleRange } from '../lib/events.mjs';
import { MAX_IN_FLIGHT, mapLimit } from '../lib/jobs.mjs';
import { isThing } from '../lib/validate.mjs';
import {
  DEFAULT_VITALS_DAYS,
  VITAL_KINDS,
  boardDetail,
  boardVitals,
  firstConnectionOf,
  fleetVitals,
  samplesByDay,
} from '../lib/vitals.mjs';

const DAY_MS = 86_400_000;
// A board's connection, restart, firmware and health events in the window: far more than a board makes in
// 90 days unless its connection flaps all day.
export const EVENTS_READ = 5_000;

const iso = (ms) => new Date(ms).toISOString();

function requireDays(value) {
  if (value === undefined) return DEFAULT_VITALS_DAYS;
  const days = /^[1-9]\d{0,1}$/.test(value) ? Number(value) : NaN;
  if (!(days >= 1 && days <= EVENT_DAYS)) {
    throw badRequest('invalid_days', `"days" must be a whole number from 1 to ${EVENT_DAYS}.`);
  }
  return days;
}

export function createVitalsHandlers({ aws, now, log }, { fleet }) {
  /** One board's events of the window, read back and checked: { events, fromMs } with fromMs later when cut. */
  async function eventsOf(thing, fromMs, toMs) {
    const items = await aws.queryEvents({
      thing,
      ...eventRange(fromMs, toMs + 60_000),
      kinds: [...VITAL_KINDS],
      limit: EVENTS_READ,
    });
    const nowSec = now() / 1000;
    const events = items
      .filter((item) => !(Number.isFinite(item?.ttl) && item.ttl <= nowSec))
      .map(eventFromItem)
      .filter((event) => event !== null);
    if (items.length >= EVENTS_READ && events.length > 0) {
      // Newest first: the oldest read is where this board's window starts.
      const oldest = Math.min(...events.map((event) => Date.parse(event.at)));
      return { events, fromMs: Math.max(fromMs, oldest), cut: true, before: null };
    }
    return { events, fromMs, cut: false, before: await connectionBefore(thing, events, fromMs, toMs) };
  }

  /**
   * "connected" or "disconnected": the board's last connection event before the window, read only when its first in
   * the window is a connect, and only within the 90 days events are kept. Null when not read or not there.
   */
  async function connectionBefore(thing, events, fromMs, toMs) {
    const earliest = toMs - EVENT_DAYS * DAY_MS;
    if (fromMs <= earliest || firstConnectionOf(events, fromMs, toMs)?.what !== 'connected') return null;
    try {
      const nowSec = now() / 1000;
      const [last] = (
        await aws.queryEvents({ thing, ...eventRange(earliest, fromMs - 1), kinds: ['connection'], limit: 1 })
      )
        .filter((item) => !(Number.isFinite(item?.ttl) && item.ttl <= nowSec))
        .map(eventFromItem)
        .filter((event) => event !== null);
      return last?.what === 'connected' || last?.what === 'disconnected' ? last.what : null;
    } catch (error) {
      // Not knowing it leaves that time unknown, as before the read: the board still counts.
      log({ level: 'warn', event: 'events_unreadable', thing, error: describeError(error).message });
      return null;
    }
  }

  async function newestByType() {
    const byType = await fleet.releasesByType();
    return Object.fromEntries(Object.entries(byType).map(([type, list]) => [type, list[0]?.version ?? null]));
  }

  function windowOf(query) {
    const days = requireDays(field(query, 'days'));
    const toMs = now();
    return { days, fromMs: toMs - days * DAY_MS, toMs };
  }

  function rowOf({ board, device }) {
    return {
      thing: board.thing,
      name: board.name,
      type: board.type,
      online: board.online,
      version: board.version,
      rssi: device.rssi,
    };
  }

  return {
    async list({ query }) {
      const { days, fromMs, toMs } = windowOf(query);
      const [loaded, newest] = await Promise.all([fleet.boards(), newestByType()]);
      // At most MAX_IN_FLIGHT Queries at once, as the issues and the weekly report read the events.
      const read = await mapLimit(loaded, MAX_IN_FLIGHT, async (one) => {
        const row = rowOf(one);
        try {
          const { events, fromMs: from, cut, before } = await eventsOf(row.thing, fromMs, toMs);
          const vitals = boardVitals({
            events,
            fromMs: from,
            toMs,
            onlineNow: row.online,
            current: row.version,
            before,
          });
          // A cut board's days before its oldest event are left out of it, not counted as unknown.
          return { ...row, vitals, cut };
        } catch (error) {
          log({ level: 'warn', event: 'events_unreadable', thing: row.thing, error: describeError(error).message });
          return { ...row, vitals: null, cut: false };
        }
      });
      // Every board's days are the whole window's, so the fleet's daily rows line up.
      for (const board of read) {
        if (board.vitals === null || !board.cut) continue;
        const whole = boardVitals({ events: [], fromMs, toMs }).days;
        for (const [day, one] of board.vitals.days) whole.set(day, one);
        board.vitals.days = whole;
      }
      const made = fleetVitals(read, { newestByType: newest });
      return {
        body: {
          ...made,
          from: iso(fromMs),
          to: iso(toMs),
          days,
          boards: read.length,
          unread: made.vitals.unread,
          generatedAt: iso(toMs),
        },
      };
    },

    async get({ params, query }) {
      const { thing } = params;
      if (!isThing(thing)) throw notFound('unknown_device', 'No board of that name is registered.');
      const { days, fromMs, toMs } = windowOf(query);
      const [loaded, newest] = await Promise.all([fleet.boards({ only: [thing] }), newestByType()]);
      if (loaded.length === 0) throw notFound('unknown_device', 'No board of that name is registered.');
      const row = rowOf(loaded[0]);
      const samplesFromMs = Math.max(fromMs, toMs - SAMPLE_DAYS * DAY_MS);
      const [read, samples] = await Promise.all([
        eventsOf(thing, fromMs, toMs),
        Promise.resolve()
          .then(() => aws.querySamples({ thing, ...sampleRange(samplesFromMs, toMs + 60_000) }))
          .then(
            (items) => items.map(sampleFromItem).filter((sample) => sample !== null),
            (error) => {
              log({ level: 'warn', event: 'samples_unreadable', thing, error: describeError(error).message });
              return null;
            }
          ),
      ]);
      const vitals = boardVitals({
        events: read.events,
        fromMs: read.fromMs,
        toMs,
        onlineNow: row.online,
        current: row.version,
        before: read.before,
      });
      const detail = boardDetail(vitals, samples === null ? new Map() : samplesByDay(samples));
      const [board] = fleetVitals([{ ...row, vitals, cut: read.cut }], {
        newestByType: newest,
      }).perBoard;
      return {
        body: {
          board,
          ...detail,
          samplesFrom: iso(samplesFromMs),
          samplesUnread: samples === null,
          from: iso(read.fromMs),
          to: iso(toMs),
          days,
          cut: read.cut,
          generatedAt: iso(toMs),
        },
      };
    },
  };
}
