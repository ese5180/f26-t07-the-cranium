/**
 * Vitals: how the boards are doing over time, from what they already send (docs/own-observability.md,
 * stage 2). Our own answer to Memfault's metrics and fleet vitals, made on each read from the events
 * table: nothing new is stored, and nothing new is asked of a board.
 *
 * From a board's events (kept 90 days, lib/events.mjs):
 *
 *   connected time   AWS IoT's own connected and disconnected events. Before a board's first connection
 *                    event in the window: online if that event is a disconnect (the connection began
 *                    earlier), unknown if it is a connect (the board may not have existed yet). With no
 *                    connection event at all, online the whole window if it is online now, else unknown.
 *                    Unknown time counts neither way.
 *   restarts         `restarted` (the uptime went down) and `stuck`, and a `boot` from the diary for each
 *                    boot it adds (`newBoots`), less the one a `restarted` without a cause or a `stuck`
 *                    up to 15 minutes before it already counted: the same restart, reported twice
 *   unexpected       a restart that is one of our own issues (lib/issues.mjs occurrenceOf): the watchdog,
 *                    a brownout, a lockup, a restart for being stuck, a fault
 *   drops            disconnects, but not those the board closed itself (CLIENT_INITIATED_DISCONNECT)
 *   low memory       `health` `memory`: the free heap fell below 15% (once per boot)
 *
 * and from its samples (kept 7 days, one per report): the Wi-Fi signal, the lowest free heap and the
 * uptime, by day, for one board's page only (a fleet's samples are too many to read on each view).
 *
 * Each is counted by UTC day, and by the version the board ran (withVersions, as an issue's version):
 * those are the daily trends and the cohorts by version. Fleet vitals are over the boards with Wi-Fi
 * that were seen in the window ("active": time known or an event): a board in a drawer all window
 * does not count against the fleet, and a Bluetooth-only board never connects to the cloud at all.
 *
 * No AWS here, and no clock: the caller passes the events and the times.
 */

import { BOOT_AFTER_RESTART_MS, occurrenceOf, withVersions } from './issues.mjs';
import { versionOrder } from './fleet.mjs';

export const DEFAULT_VITALS_DAYS = 7;
// The kinds a board's read asks for: neither updates nor Bluetooth say how a board is doing.
export const VITAL_KINDS = Object.freeze(['connection', 'restart', 'firmware', 'health']);
// A disconnect the board asked for is not a drop: it closes the connection itself before a restart it chose.
export const NOT_DROPS = new Set(['CLIENT_INITIATED_DISCONNECT']);
// Fewer hours online than this on a version, and its crash rate is not worked out: too little to say.
export const RATE_MIN_HOURS = 1;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The UTC day of a time, YYYY-MM-DD. */
export function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Every UTC day that [fromMs, toMs) touches, oldest first. */
export function daysBetween(fromMs, toMs) {
  const days = [];
  for (let ms = Date.UTC(...ymd(fromMs)); ms < toMs; ms += DAY_MS) days.push(dayOf(ms));
  return days;
}

function ymd(ms) {
  const date = new Date(ms);
  return [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
}

function tally() {
  return { knownMs: 0, onlineMs: 0, restarts: 0, unexpected: 0, drops: 0, lowMemory: 0, active: false };
}

const hours = (ms) => Math.round((ms / HOUR_MS) * 10) / 10;
const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null);

/**
 * One board's vitals over [fromMs, toMs).
 *
 * @param {object} options
 * @param {object[]} options.events   the board's events (eventFromItem), any order, any kinds
 * @param {number} options.fromMs
 * @param {number} options.toMs
 * @param {boolean} [options.onlineNow]  online by its shadow now
 * @param {string|null} [options.current]  the version it runs now
 * @returns {{ total, days: Map<string, object>, versions: Map<string, object> }} tallies of
 *   { knownMs, onlineMs, restarts, unexpected, drops, lowMemory, active }; days holds every day of the window
 */
export function boardVitals({ events, fromMs, toMs, onlineNow = false, current = null }) {
  const total = tally();
  const days = new Map(daysBetween(fromMs, toMs).map((day) => [day, tally()]));
  const versions = new Map();
  const ofVersion = (version) => {
    const key = version ?? 'unknown';
    if (!versions.has(key)) versions.set(key, tally());
    return versions.get(key);
  };

  const inWindow = events.filter((event) => {
    const ms = Date.parse(event?.at);
    return Number.isFinite(ms) && ms >= fromMs && ms < toMs;
  });
  const placed = withVersions(inWindow, current);
  const firstConnection = placed.find(({ event }) => event.kind === 'connection')?.event ?? null;
  let online;
  if (firstConnection === null) online = onlineNow ? true : null;
  else online = firstConnection.what === 'disconnected' ? true : null;
  let running = placed.length > 0 ? placed[0].version : current;
  let cursor = fromMs;

  // Time from `cursor` to `untilMs` in the state the board was in, split at each UTC midnight.
  const spend = (untilMs) => {
    if (online !== null) {
      let start = cursor;
      while (start < untilMs) {
        const midnight = Date.UTC(...ymd(start)) + DAY_MS;
        const end = Math.min(untilMs, midnight);
        const length = end - start;
        for (const one of [total, days.get(dayOf(start)), ofVersion(running)]) {
          if (one === undefined) continue;
          one.knownMs += length;
          if (online) one.onlineMs += length;
          one.active = true;
        }
        start = end;
      }
    }
    cursor = Math.max(cursor, untilMs);
  };

  let pending = null;
  for (const { event, version } of placed) {
    const ms = Date.parse(event.at);
    spend(ms);
    const counted = [total, days.get(dayOf(ms)), ofVersion(version)].filter(Boolean);
    const add = (name, count = 1) => {
      for (const one of counted) one[name] += count;
    };
    for (const one of counted) one.active = true;
    if (event.kind === 'connection') {
      if (event.what === 'connected') online = true;
      else if (event.what === 'disconnected') {
        if (!NOT_DROPS.has(event.reason)) add('drops');
        online = false;
      }
    } else if (event.kind === 'restart') {
      if (event.what === 'restarted' || event.what === 'stuck') {
        add('restarts');
        pending = event.what === 'stuck' || event.cause === undefined ? ms : null;
      } else if (event.what === 'boot') {
        let boots = Number.isInteger(event.newBoots) ? event.newBoots : 1;
        if (pending !== null && ms - pending <= BOOT_AFTER_RESTART_MS) boots -= 1;
        pending = null;
        if (boots > 0) add('restarts', boots);
      }
      if (occurrenceOf(event, version) !== null) add('unexpected');
    } else if (event.kind === 'health' && event.what === 'memory') {
      add('lowMemory');
    }
    running = event.kind === 'firmware' && typeof event.version === 'string' ? event.version : (version ?? running);
  }
  spend(toMs);
  return { total, days, versions };
}

/** A tally as the API returns it: hours, and the shares worked out. */
export function tallyOut({ knownMs, onlineMs, restarts, unexpected, drops, lowMemory }) {
  const knownDays = knownMs / DAY_MS;
  return {
    knownHours: hours(knownMs),
    onlineHours: hours(onlineMs),
    connectivity: share(onlineMs, knownMs),
    restarts,
    unexpected,
    drops,
    lowMemory,
    // Per day of known time: a board seen for a few hours is not judged as if seen all window.
    restartsPerDay: knownDays >= 1 / 24 ? Math.round((restarts / knownDays) * 100) / 100 : null,
  };
}

function addTally(into, from) {
  into.knownMs += from.knownMs;
  into.onlineMs += from.onlineMs;
  into.restarts += from.restarts;
  into.unexpected += from.unexpected;
  into.drops += from.drops;
  into.lowMemory += from.lowMemory;
}

/**
 * The cohorts by version, newest version first: each version's boards, time, restarts and drops, how many of
 * its boards had no unexpected restart on it, and its unexpected restarts per 1,000 hours online.
 *
 * @param {{ thing: string, versions: Map<string, object> }[]} boards
 */
export function versionCohorts(boards) {
  const cohorts = new Map();
  for (const { thing, versions } of boards) {
    for (const [version, one] of versions) {
      if (!one.active) continue;
      if (!cohorts.has(version)) cohorts.set(version, { sum: tally(), boards: new Set(), crashed: new Set() });
      const cohort = cohorts.get(version);
      addTally(cohort.sum, one);
      cohort.boards.add(thing);
      if (one.unexpected > 0) cohort.crashed.add(thing);
    }
  }
  return [...cohorts]
    .sort(([a], [b]) => (a === 'unknown' ? 1 : b === 'unknown' ? -1 : versionOrder(b, a)))
    .map(([version, { sum, boards, crashed }]) => {
      const onlineHours = sum.onlineMs / HOUR_MS;
      return {
        version: version === 'unknown' ? null : version,
        boards: boards.size,
        crashFreeBoards: boards.size - crashed.size,
        crashFree: share(boards.size - crashed.size, boards.size),
        ...tallyOut(sum),
        perThousandHours:
          onlineHours >= RATE_MIN_HOURS ? Math.round((sum.unexpected / onlineHours) * 1000 * 10) / 10 : null,
      };
    });
}

/**
 * The fleet's vitals from each board's.
 *
 * @param {object[]} boards  [{ thing, name, type, bluetoothOnly, online, version, rssi, vitals, cut }],
 *                           `vitals` boardVitals' answer, or null for a board whose events could not be read
 * @param {object} options
 * @param {Record<string, string|null>} options.newestByType  the newest active release of each board type
 */
export function fleetVitals(boards, { newestByType = {} } = {}) {
  const counted = boards.filter((board) => !board.bluetoothOnly && board.vitals !== null);
  const active = counted.filter((board) => board.vitals.total.active);
  const crashFree = active.filter((board) => board.vitals.total.unexpected === 0).length;
  const sum = tally();
  for (const board of active) addTally(sum, board.vitals.total);

  // On the newest release of its type, of the boards with a known version whose type has a release.
  const withRelease = boards.filter((board) => board.version && newestByType[board.type]);
  const onNewest = withRelease.filter((board) => board.version === newestByType[board.type]).length;

  const dayNames = counted.length > 0 ? [...counted[0].vitals.days.keys()] : [];
  const daily = dayNames.map((day) => {
    const daySum = tally();
    let seen = 0;
    let clean = 0;
    for (const board of counted) {
      const one = board.vitals.days.get(day);
      if (!one?.active) continue;
      seen += 1;
      if (one.unexpected === 0) clean += 1;
      addTally(daySum, one);
    }
    const out = tallyOut(daySum);
    return {
      day,
      boards: seen,
      crashFreeBoards: clean,
      crashFree: share(clean, seen),
      knownHours: out.knownHours,
      onlineHours: out.onlineHours,
      connectivity: out.connectivity,
      restarts: out.restarts,
      unexpected: out.unexpected,
      drops: out.drops,
      lowMemory: out.lowMemory,
    };
  });

  const perBoard = boards.map((board) => {
    const row = {
      thing: board.thing,
      name: board.name ?? null,
      type: board.type ?? null,
      bluetoothOnly: board.bluetoothOnly === true,
      online: board.online === true,
      version: board.version ?? null,
      newest: Boolean(board.version && newestByType[board.type] === board.version),
      rssi: Number.isInteger(board.rssi) ? board.rssi : null,
      unread: board.vitals === null && board.bluetoothOnly !== true,
      cut: board.cut === true,
    };
    if (board.vitals === null || board.bluetoothOnly) return { ...row, active: false };
    return {
      ...row,
      active: board.vitals.total.active,
      crashFree: board.vitals.total.active ? board.vitals.total.unexpected === 0 : null,
      ...tallyOut(board.vitals.total),
    };
  });

  const totals = tallyOut(sum);
  return {
    vitals: {
      boards: boards.length,
      active: active.length,
      bluetoothOnly: boards.filter((board) => board.bluetoothOnly).length,
      unread: boards.filter((board) => board.vitals === null && !board.bluetoothOnly).length,
      crashFree: { boards: crashFree, of: active.length, share: share(crashFree, active.length) },
      connectivity: { onlineHours: totals.onlineHours, knownHours: totals.knownHours, share: totals.connectivity },
      newest: { boards: onNewest, of: withRelease.length, share: share(onNewest, withRelease.length) },
      restarts: totals.restarts,
      unexpected: totals.unexpected,
      drops: totals.drops,
      lowMemory: totals.lowMemory,
      restartsPerDay: totals.restartsPerDay,
    },
    daily,
    perBoard,
    versions: versionCohorts(counted.map((board) => ({ thing: board.thing, versions: board.vitals.versions }))),
  };
}

/**
 * A board's samples by UTC day: the signal's mean and lowest, the lowest free heap, the longest uptime and how
 * many samples there were. Days without a sample are left out.
 *
 * @param {object[]} samples  sampleFromItem's, any order
 * @returns {Map<string, { samples, rssiMean, rssiLow, heapLeast, uptimeMax }>}
 */
export function samplesByDay(samples) {
  const byDay = new Map();
  for (const sample of samples) {
    const ms = Date.parse(sample?.at);
    if (!Number.isFinite(ms)) continue;
    const day = dayOf(ms);
    if (!byDay.has(day)) byDay.set(day, { samples: 0, rssi: [], heapLeast: null, uptimeMax: null });
    const one = byDay.get(day);
    one.samples += 1;
    if (Number.isInteger(sample.rssi)) one.rssi.push(sample.rssi);
    const least = Number.isInteger(sample.heapLeast) ? sample.heapLeast : sample.heapFree;
    if (Number.isInteger(least)) one.heapLeast = one.heapLeast === null ? least : Math.min(one.heapLeast, least);
    if (Number.isInteger(sample.uptime)) one.uptimeMax = Math.max(one.uptimeMax ?? 0, sample.uptime);
  }
  const out = new Map();
  for (const [day, one] of byDay) {
    out.set(day, {
      samples: one.samples,
      rssiMean: one.rssi.length > 0 ? Math.round(one.rssi.reduce((a, b) => a + b, 0) / one.rssi.length) : null,
      rssiLow: one.rssi.length > 0 ? Math.min(...one.rssi) : null,
      heapLeast: one.heapLeast,
      uptimeMax: one.uptimeMax,
    });
  }
  return out;
}

/** One board's vitals as its page has them: the totals, the days with their samples, its versions. */
export function boardDetail(vitals, sampleDays = new Map()) {
  const daily = [...vitals.days].map(([day, one]) => {
    const out = tallyOut(one);
    return {
      day,
      active: one.active,
      knownHours: out.knownHours,
      onlineHours: out.onlineHours,
      connectivity: out.connectivity,
      restarts: out.restarts,
      unexpected: out.unexpected,
      drops: out.drops,
      lowMemory: out.lowMemory,
      ...(sampleDays.get(day) ?? { samples: 0, rssiMean: null, rssiLow: null, heapLeast: null, uptimeMax: null }),
    };
  });
  return {
    vitals: {
      active: vitals.total.active,
      crashFree: vitals.total.active ? vitals.total.unexpected === 0 : null,
      ...tallyOut(vitals.total),
    },
    daily,
    versions: versionCohorts([{ thing: 'board', versions: vitals.versions }]),
  };
}
