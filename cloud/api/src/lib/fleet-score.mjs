/**
 * The fleet health score (docs/fleet-health.md): one number from 0 to 100 for how the fleet is doing,
 * made of four parts, and the daily snapshots that make its trend. Plain functions: the handlers read
 * the boards, their events and Memfault (handlers/fleet.mjs), and these do the sums.
 *
 * The parts, each a share from 0 to 1 of the boards (or updates) it counts:
 *
 *   online     boards online, of the registered boards with Wi-Fi (a Bluetooth-only board never is)
 *   crashFree  boards with no unexpected restart and no new Memfault issue in the last SCORE_DAYS days, of
 *              the registered boards with Wi-Fi. Unexpected: a restart event at warning level in the events
 *              table (a bad cause, or stuck), an unexpected reboot reason in Memfault, or a trace of an issue
 *              Memfault first saw in the window
 *   updates    updates over the air that ended confirmed, of those that ended in the last SCORE_DAYS days
 *              (succeeded, failed, refused or rolled back), as the boards reported the ends of their jobs
 *   signal     boards online whose Wi-Fi signal is at GOOD_SIGNAL_DBM or above, of the boards online that
 *              report one, from their shadows
 *
 * The score is the weighted mean of the parts that have something to count, times 100, rounded: a part
 * with nothing to count (no boards, no updates in the window) is left out and the others weigh the same
 * among themselves. With no part to count, the score is null.
 */

import { WEAK_SIGNAL_DBM } from './fleet.mjs';

const DAY_MS = 86_400_000;

// The weights, which add up to 1. Being reachable matters most, then not crashing, then updates landing,
// then the signal, which is more a warning than a failure.
export const SCORE_WEIGHTS = Object.freeze({ online: 0.35, crashFree: 0.3, updates: 0.2, signal: 0.15 });
export const PART_IDS = Object.freeze(['online', 'crashFree', 'updates', 'signal']);
// The window of the crash-free and update parts.
export const SCORE_DAYS = 7;
// A signal at this or above counts as good: the console's "Weak" band starts below it.
export const GOOD_SIGNAL_DBM = WEAK_SIGNAL_DBM;
// The trend: snapshots of this many days by default, and at most MAX_HISTORY_DAYS.
export const HISTORY_DAYS = 30;
export const MAX_HISTORY_DAYS = 31;
// The partition of the state table that holds one snapshot a day, sk the UTC day (YYYY-MM-DD).
export const SNAPSHOT_PK = 'HEALTH';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// What each part means, in one line, and the page that explains it.
export const PARTS = Object.freeze({
  online: Object.freeze({
    label: 'Online',
    meaning: 'Boards with Wi-Fi that are connected now.',
    href: '#/devices?status=offline',
  }),
  crashFree: Object.freeze({
    label: 'Crash-free',
    meaning: `Boards with no unexpected restart and no new Memfault issue in the last ${SCORE_DAYS} days.`,
    href: '#/memfault',
  }),
  updates: Object.freeze({
    label: 'Update success',
    meaning: `Updates over the air that ended confirmed, of those that ended in the last ${SCORE_DAYS} days.`,
    href: '#/deployments',
  }),
  signal: Object.freeze({
    label: 'Wi-Fi signal',
    meaning: `Boards online with a signal of ${GOOD_SIGNAL_DBM} dBm or better.`,
    href: '#/diagnostics',
  }),
});

const share = (counted, of) => (of > 0 ? counted / of : null);

/**
 * The four parts: { online, crashFree, updates, signal }, each { counted, of, value } with value null when
 * there is nothing to count.
 *
 *   boards     the fleet boards (handlers/fleet.mjs): { thing, bluetoothOnly, online }
 *   rssi       thing -> the signal the board reports now, in dBm, or null
 *   crashed    the things that crashed in the window, from the events table and Memfault together
 *   jobs       how the updates over the air of the window ended: { succeeded, failed, rolledBack }
 */
export function scoreParts({ boards, rssi = new Map(), crashed = new Set(), jobs = {} }) {
  const wifi = boards.filter((board) => !board.bluetoothOnly);
  const online = wifi.filter((board) => board.online);
  const crashedHere = wifi.filter((board) => crashed.has(board.thing)).length;
  const succeeded = whole(jobs.succeeded);
  const ended = succeeded + whole(jobs.failed) + whole(jobs.rolledBack);
  const heard = online.map((board) => rssi.get(board.thing)).filter((value) => Number.isInteger(value));
  const good = heard.filter((value) => value >= GOOD_SIGNAL_DBM).length;
  const part = (counted, of) => ({ counted, of, value: share(counted, of) });
  return {
    online: part(online.length, wifi.length),
    crashFree: part(wifi.length - crashedHere, wifi.length),
    updates: part(succeeded, ended),
    signal: part(good, heard.length),
  };
}

function whole(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** The score from 0 to 100 of the parts' values ({ id: value | null }), or null when none has a value. */
export function scoreOf(values) {
  let weighed = 0;
  let total = 0;
  for (const id of PART_IDS) {
    const value = values[id];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    weighed += SCORE_WEIGHTS[id] * Math.min(1, Math.max(0, value));
    total += SCORE_WEIGHTS[id];
  }
  return total === 0 ? null : Math.round((100 * weighed) / total);
}

/** The score and its parts as the API gives them: { value, parts: [{ id, label, meaning, href, weight, ... }] }. */
export function fleetScore(parts) {
  const values = Object.fromEntries(PART_IDS.map((id) => [id, parts[id]?.value ?? null]));
  return {
    value: scoreOf(values),
    days: SCORE_DAYS,
    parts: PART_IDS.map((id) => ({
      id,
      ...PARTS[id],
      weight: SCORE_WEIGHTS[id],
      counted: parts[id]?.counted ?? 0,
      of: parts[id]?.of ?? 0,
      value: values[id],
    })),
  };
}

/** The UTC day of a time, as a snapshot's key: "2026-11-09". */
export function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The state-table item of the day's snapshot: { day, at, score, parts: { id: value | null } }, and from console
 * 2.19.0 `fleet`, what fleetCounts() made of the boards, for the weekly report (lib/reports.mjs).
 */
export function snapshotItem(score, nowMs, fleet = null) {
  return {
    day: dayOf(nowMs),
    at: new Date(nowMs).toISOString(),
    score: score.value,
    parts: Object.fromEntries(score.parts.map((part) => [part.id, part.value === null ? null : round(part.value)])),
    ...(fleet === null ? {} : { fleet }),
  };
}

// The most boards a snapshot names, so that an item stays far below DynamoDB's 400 KB.
export const SNAPSHOT_THINGS = 500;
const COUNT = (value) => Number.isInteger(value) && value >= 0;

/**
 * What a snapshot keeps of the boards (console 2.19.0), for the weekly report: how many, online and offline of
 * those with Wi-Fi, Bluetooth only, the versions they run and how many of each, and their names, so that a
 * later week can tell which are new. `boards` are FleetBoards (handlers/fleet.mjs).
 */
export function fleetCounts(boards) {
  const versions = {};
  let unknown = 0;
  for (const board of boards) {
    if (typeof board.version !== 'string') unknown += 1;
    else versions[board.version] = (versions[board.version] ?? 0) + 1;
  }
  const wifi = boards.filter((board) => !board.bluetoothOnly);
  const online = wifi.filter((board) => board.online).length;
  return {
    boards: boards.length,
    online,
    offline: wifi.length - online,
    bluetoothOnly: boards.length - wifi.length,
    versions,
    unknown,
    things: boards
      .map((board) => board.thing)
      .sort()
      .slice(0, SNAPSHOT_THINGS),
  };
}

/** The `fleet` of a stored snapshot, checked, or null for a snapshot from before console 2.19.0 or not one. */
export function snapshotFleet(item) {
  const fleet = item?.fleet;
  if (fleet === null || typeof fleet !== 'object') return null;
  if (!['boards', 'online', 'offline', 'bluetoothOnly'].every((name) => COUNT(fleet[name]))) return null;
  const versions = {};
  for (const [version, count] of Object.entries(fleet.versions ?? {})) if (COUNT(count)) versions[version] = count;
  return {
    boards: fleet.boards,
    online: fleet.online,
    offline: fleet.offline,
    bluetoothOnly: fleet.bluetoothOnly,
    versions,
    unknown: COUNT(fleet.unknown) ? fleet.unknown : 0,
    things: Array.isArray(fleet.things) ? fleet.things.filter((thing) => typeof thing === 'string') : null,
  };
}

const round = (value) => Math.round(value * 10_000) / 10_000;

/** A snapshot read back from the table, or null for an item that is not one. */
export function snapshotFromItem(item) {
  if (item === null || typeof item !== 'object' || typeof item.sk !== 'string' || !DAY.test(item.sk)) return null;
  const score = Number.isInteger(item.score) && item.score >= 0 && item.score <= 100 ? item.score : null;
  const parts = {};
  for (const id of PART_IDS) {
    const value = item.parts?.[id];
    parts[id] = typeof value === 'number' && value >= 0 && value <= 1 ? value : null;
  }
  return { day: item.sk, score, parts };
}

/** The snapshots of the last `days` days up to and with today's, oldest first. */
export function historyOf(items, days, nowMs) {
  const first = dayOf(nowMs - (days - 1) * DAY_MS);
  const last = dayOf(nowMs);
  return items
    .map(snapshotFromItem)
    .filter((one) => one !== null && one.day >= first && one.day <= last)
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * How the score moved since last week: today's score less the snapshot's of 7 days ago (or the nearest
 * before it, up to 3 days earlier), or null when either is not known.
 */
export function weekChange(history, value, nowMs) {
  if (value === null) return null;
  for (let back = 7; back <= 10; back += 1) {
    const found = history.find((one) => one.day === dayOf(nowMs - back * DAY_MS));
    if (found !== undefined) return found.score === null ? null : value - found.score;
  }
  return null;
}

/** The ?days= of GET /api/fleet/health: HISTORY_DAYS when not given, else a whole number from 1 to the most. */
export function historyDays(value) {
  if (value === undefined || value === null) return HISTORY_DAYS;
  if (typeof value !== 'string' || !/^[1-9]\d?$/.test(value) || Number(value) > MAX_HISTORY_DAYS) return null;
  return Number(value);
}
