/**
 * A board's version timeline (GET /api/devices/{thing}/timeline, docs/compare.md): every firmware
 * version it ran, when it started and ended, how it arrived, whether it was confirmed or rolled back,
 * and how many unexpected restarts and other problems the board reported while on it.
 *
 * It is made from the board's update history (lib/updates.mjs records, the same records lib/last-good.mjs
 * reads), the version its shadow says it runs now, the releases (a release whose note begins "Rebuild
 * of 1.13.0" is a roll back to last good), and its warnings in the events table:
 *
 *   - an update kept or still on trial starts the version it brought, at the update's start;
 *   - an update that rolled back is a short stay on the version it brought (rolled_back), and the
 *     version it came from starts again, arrived by rollback;
 *   - an update that was not installed changes nothing;
 *   - the version an update started from, with nothing before it, arrived before the history
 *     ("setup": by USB or at setup); a board starts an update only from firmware it has confirmed.
 *
 * Arrival: ota (a deployment), bluetooth, usb (USB or another tool), rollback, setup.
 * Status: confirmed, rolled_back, trial.
 *
 * The counts. A restart event with level warn is an unexpected restart (a bad cause, or a restart
 * for being stuck); any other warn event (an update that failed, low memory, ...) is an issue. Events
 * are kept EVENT_DAYS, so a version that ended before then has no counts (null), and one that began
 * before then is counted from then on (countedFrom).
 *
 * Every function here is plain.
 */

import { EVENT_DAYS } from './events.mjs';
import { versionOrder } from './fleet.mjs';
import { rebuildOf } from './last-good.mjs';

export const ARRIVALS = Object.freeze(['ota', 'bluetooth', 'usb', 'rollback', 'setup']);
export const STATUSES = Object.freeze(['confirmed', 'rolled_back', 'trial']);
export const DEFAULT_TIMELINE_PAGE = 20;
export const MAX_TIMELINE_PAGE = 50;
// More versions than a board could run: a cursor past it is not one of this list.
const MAX_OFFSET = 10_000;
const DAY_MS = 86_400_000;

const HOW_ARRIVAL = Object.freeze({ deployment: 'ota', bluetooth: 'bluetooth', usb_or_other: 'usb' });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && versionOrder(a, b) === 0;
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const timeOf = (record) => record.startedAt ?? record.endedAt ?? null;

/**
 * The versions a board ran, oldest first, without counts: [{ version, startMs, endMs, arrived,
 * deployment, status, current }]. `startMs` is null where the history does not say; `endMs` is null
 * for the version it runs, and for one whose end is not known.
 */
export function versionStays({ records, current = null, releases = [] }) {
  const rebuilds = new Set(
    (Array.isArray(releases) ? releases : [])
      .filter((release) => rebuildOf(release?.notes) !== null)
      .map((release) => release.version)
  );
  const arrivalOf = (record) => {
    const how = HOW_ARRIVAL[record.how] ?? 'usb';
    return how === 'ota' && [...rebuilds].some((version) => same(version, record.to)) ? 'rollback' : how;
  };
  const ordered = (Array.isArray(records) ? records : [])
    .filter((record) => record !== null && typeof record === 'object' && typeof record.to === 'string')
    .filter((record) => record.outcome !== 'not_installed' && Number.isFinite(timeOf(record)))
    .sort((a, b) => timeOf(a) - timeOf(b));

  const stays = [];
  let open = null;
  const close = (atMs) => {
    if (open === null) return;
    open.endMs = atMs;
    stays.push(open);
    open = null;
  };
  const begin = (version, startMs, arrived, status, deployment = null) => {
    open = { version, startMs, endMs: null, arrived, deployment, status, current: false };
  };

  for (const record of ordered) {
    const at = timeOf(record);
    // The version it updated from: known only by this update if nothing before it said so.
    if (typeof record.from === 'string' && (open === null || !same(open.version, record.from))) {
      close(open === null ? null : at);
      begin(record.from, null, stays.length === 0 ? 'setup' : 'usb', 'confirmed');
    }
    if (open !== null && typeof record.from === 'string' && open.status === 'trial') open.status = 'confirmed';
    close(at);
    const deployment = record.how === 'deployment' ? (record.deployment ?? null) : null;
    if (record.outcome === 'rolled_back') {
      const back = Number.isFinite(record.endedAt) ? record.endedAt : at;
      begin(record.to, at, arrivalOf(record), 'rolled_back', deployment);
      close(back);
      if (typeof record.from === 'string') begin(record.from, back, 'rollback', 'confirmed');
    } else {
      begin(record.to, at, arrivalOf(record), record.outcome === 'kept' ? 'confirmed' : 'trial', deployment);
    }
  }

  const version = typeof current?.version === 'string' ? current.version : null;
  if (version !== null && (open === null || !same(open.version, version))) {
    // It runs a version its history does not show arriving: when it did is not known.
    if (open !== null) stays.push(open);
    open = null;
    begin(version, null, stays.length === 0 ? 'setup' : 'usb', current.confirmed === false ? 'trial' : 'confirmed');
  }
  if (open !== null) {
    if (version !== null) {
      open.current = true;
      if (current.confirmed === true) open.status = 'confirmed';
    }
    stays.push(open);
  }
  return stays;
}

/**
 * The counts of each stay from the board's warnings (events with level warn): { reboots, issues,
 * countedFrom } with both null for a stay that ended before events were kept.
 */
export function countWarnings(stays, events, nowMs) {
  const keptFrom = nowMs - EVENT_DAYS * DAY_MS;
  const warnings = (Array.isArray(events) ? events : [])
    .filter((event) => event?.level === 'warn' && typeof event.at === 'string' && event.kind !== 'connection')
    .map((event) => ({ at: Date.parse(event.at), restart: event.kind === 'restart' }))
    .filter((event) => Number.isFinite(event.at));
  return stays.map((stay) => {
    const endMs = stay.endMs ?? (stay.current ? nowMs : null);
    if (endMs === null || endMs < keptFrom) return { ...stay, reboots: null, issues: null, countedFrom: null };
    const fromMs = Math.max(stay.startMs ?? -Infinity, keptFrom);
    let reboots = 0;
    let issues = 0;
    for (const event of warnings) {
      if (event.at < fromMs || event.at >= endMs) continue;
      if (event.restart) reboots += 1;
      else issues += 1;
    }
    return { ...stay, reboots, issues, countedFrom: iso(fromMs) };
  });
}

/** A stay as the API gives it. */
export function presentStay(stay) {
  return {
    version: stay.version,
    startedAt: iso(stay.startMs),
    endedAt: iso(stay.endMs),
    current: stay.current,
    arrived: stay.arrived,
    deployment: stay.deployment,
    status: stay.status,
    reboots: stay.reboots ?? null,
    issues: stay.issues ?? null,
    countedFrom: stay.countedFrom ?? null,
  };
}

/** A board's timeline, newest first, counted: the whole list a page is cut from. */
export function boardTimeline({ records, current, releases, events, nowMs }) {
  return countWarnings(versionStays({ records, current, releases }), events, nowMs).reverse().map(presentStay);
}

/** The page size asked for: DEFAULT_TIMELINE_PAGE if none, null if it is not 1 to MAX_TIMELINE_PAGE. */
export function timelinePageSize(text) {
  if (text === undefined) return DEFAULT_TIMELINE_PAGE;
  if (typeof text !== 'string' || !/^\d{1,3}$/.test(text)) return null;
  const size = Number(text);
  return size >= 1 && size <= MAX_TIMELINE_PAGE ? size : null;
}

/** A cursor: where the next page starts, opaque to the client. */
export function encodeTimelineCursor(offset) {
  return Buffer.from(`timeline|${offset}`, 'utf8').toString('base64url');
}

/** The offset a cursor names, or null if the text is not a cursor of this list. */
export function decodeTimelineCursor(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 40 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) return null;
  const found = /^timeline\|(\d{1,5})$/.exec(bytes.toString('utf8'));
  if (found === null) return null;
  const offset = Number(found[1]);
  return offset >= 1 && offset <= MAX_OFFSET ? offset : null;
}
