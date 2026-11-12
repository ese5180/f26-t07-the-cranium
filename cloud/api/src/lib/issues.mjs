/**
 * Issues: the boards' crashes, faults and stuck restarts, grouped by what went wrong
 * (docs/own-observability.md, stage 1). Our own answer to Memfault's issues, made from the
 * events the boards already send: nothing new is stored, and nothing new is asked of a board.
 *
 * An occurrence is a restart event (lib/events.mjs) that says something went wrong:
 *
 *   what "stuck"                     the board restarted itself for being stuck: { reason }
 *   what "restarted" or "boot"       a reset whose cause has a bad bit (BAD_CAUSES): the
 *                                    watchdog, a brownout, a lockup, ...
 *   what "fault"                     a fault the firmware reports with its reboot (stage 2)
 *
 * A restart by the reset pin, by software (an update, a command) or by a loss of power is
 * not an issue. The same restart can be reported twice, as "restarted" and then as "boot" when
 * the boot diary comes a moment later; the second has the cause and the first does not, so only
 * one of them counts.
 *
 * The signature of an occurrence, which groups it into an issue:
 *
 *   <type>:<detail>[@<where>]
 *
 *   type     stuck, reset or fault
 *   detail   the stuck reason; the bad causes, sorted and joined by "+"; the fault's reason
 *   where    the function the fault was in when the firmware names it (`frame`), else the
 *            program counter with the version (`pc`/version): an address means something only
 *            in the build it came from, while a function's name holds across builds
 *
 * so that the same crash in a newer version is the same issue, and can be seen to come back.
 * An issue's id is the first 12 hex digits of the SHA-256 of its signature: the same on every
 * read, and the same on every console.
 *
 * The version an occurrence happened on is the one the board ran just before it: the last
 * firmware event of the board before the occurrence, else the version the event carries (a
 * boot diary's), else the version the board's first firmware change came from, else the
 * version it runs now.
 *
 * Regressions. An issue counts as fixed in a version when a newer version than one it happened
 * on ran on a board and never had it; it has regressed when it then happens on a version newer
 * than that fix. Versions are those any board was seen on in the window (firmware events and
 * what each board runs now). A fix that a person marks by hand is stage 2.
 *
 * No AWS here, and no clock: the caller passes the events and the time.
 */

import { createHash } from 'node:crypto';

import { BAD_CAUSES, CAUSE_WORDS, STUCK_WORDS } from './events.mjs';
import { versionOrder } from './fleet.mjs';
import { resetCauses } from './shadow.mjs';

export const ISSUE_ID = /^[0-9a-f]{12}$/;
// The most occurrences an issue's page lists, newest first; the counts take them all.
export const TIMELINE_MAX = 200;
export const ISSUE_TYPES = Object.freeze(['stuck', 'reset', 'fault']);

const DETAIL = /^[a-z][a-z0-9_+]{0,63}$/;

/** The id of an issue from its signature. */
export function issueId(signature) {
  return createHash('sha256').update(signature, 'utf8').digest('hex').slice(0, 12);
}

/** An issue id from a path, or null. */
export function parseIssueId(value) {
  return typeof value === 'string' && ISSUE_ID.test(value) ? value : null;
}

function title(type, detail, where) {
  let words;
  if (type === 'stuck') words = `Stuck: ${STUCK_WORDS[detail] ?? `reason ${detail}`}`;
  else if (type === 'reset') {
    const causes = detail.split('+').map((cause) => CAUSE_WORDS[cause] ?? 'an unknown cause');
    words = `Reset by ${causes.join(' and ')}`;
  } else words = `Fault: ${detail.replace(/_/g, ' ')}`;
  return where ? `${words} at ${where}` : words;
}

/**
 * What an event is as an issue: { signature, type, detail, where, title }, or null for an event
 * that is not one. `version` is the version it happened on, for an address that needs one.
 */
export function occurrenceOf(event, version = null) {
  if (event?.kind !== 'restart') return null;
  let type;
  let detail;
  if (event.what === 'stuck' && typeof event.reason === 'string') {
    type = 'stuck';
    detail = event.reason;
  } else if (event.what === 'fault') {
    type = 'fault';
    detail = typeof event.reason === 'string' ? event.reason.toLowerCase() : 'unknown';
  } else if ((event.what === 'restarted' || event.what === 'boot') && typeof event.cause === 'string') {
    const bad = resetCauses(event.cause).filter((cause) => BAD_CAUSES.has(cause));
    if (bad.length === 0) return null;
    type = 'reset';
    detail = [...new Set(bad)].sort().join('+');
  } else return null;
  if (!DETAIL.test(detail)) return null;
  let where = null;
  if (typeof event.frame === 'string') where = event.frame;
  else if (typeof event.pc === 'string') where = version === null ? event.pc : `${event.pc}/${version}`;
  const signature = `${type}:${detail}${where === null ? '' : `@${where}`}`;
  return {
    signature,
    type,
    detail,
    where,
    title: title(type, detail, where === null ? null : (event.frame ?? event.pc)),
  };
}

/**
 * Each event of one board with the version it happened on, oldest first.
 *
 * @param {object[]} events   the board's events (eventFromItem), restarts and firmware, any order
 * @param {string|null} current  the version the board runs now
 */
export function withVersions(events, current = null) {
  const ordered = [...events].sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1));
  const firstChange = ordered.find((event) => event.kind === 'firmware' && typeof event.from === 'string');
  let running = firstChange?.from ?? null;
  let seenFirmware = false;
  return ordered.map((event) => {
    const isFirmware = event.kind === 'firmware';
    // A firmware event happened on the version it changed from.
    const own = isFirmware ? (event.from ?? null) : (event.version ?? null);
    const on = seenFirmware ? running : (own ?? running ?? current);
    if (isFirmware && typeof event.version === 'string') {
      running = event.version;
      seenFirmware = true;
    }
    return { event, version: on ?? null };
  });
}

/** Where an issue stands across versions: { status, fixedIn, regressedIn }. */
export function versionStanding(affected, seen) {
  const all = [...new Set([...seen, ...affected])].filter(Boolean).sort(versionOrder);
  let sawAffected = false;
  let fix = null;
  let regression = null;
  for (const version of all) {
    if (affected.has(version)) {
      if (fix !== null) regression = { fixedIn: fix, regressedIn: version };
      sawAffected = true;
      fix = null;
    } else if (sawAffected && fix === null) {
      fix = version;
    }
  }
  if (fix !== null) return { status: 'fixed', fixedIn: fix, regressedIn: null, regression };
  if (regression !== null)
    return { status: 'regressed', fixedIn: regression.fixedIn, regressedIn: regression.regressedIn, regression };
  return { status: 'open', fixedIn: null, regressedIn: null, regression: null };
}

/**
 * The issues of the boards, most recent first.
 *
 * @param {{ thing: string, current: string|null, events: object[] }[]} boards
 * @returns {object[]} issues: { id, signature, type, title, count, boards, versions, firstSeen,
 *   lastSeen, firstVersion, lastVersion, status, fixedIn, regressedIn, regressed, perBoard, occurrences }
 */
export function groupIssues(boards) {
  const issues = new Map();
  const seen = new Set();
  for (const { thing, current, events } of boards) {
    if (current) seen.add(current);
    for (const { event, version } of withVersions(events, current)) {
      if (event.kind === 'firmware') {
        if (event.version) seen.add(event.version);
        if (event.from) seen.add(event.from);
        continue;
      }
      if (version) seen.add(version);
      const made = occurrenceOf(event, version);
      if (made === null) continue;
      const id = issueId(made.signature);
      if (!issues.has(id)) {
        issues.set(id, { id, signature: made.signature, type: made.type, title: made.title, occurrences: [] });
      }
      issues.get(id).occurrences.push({ at: event.at, thing, version, text: event.text });
    }
  }
  const out = [];
  for (const issue of issues.values()) {
    const occurrences = issue.occurrences.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const versions = [...new Set(occurrences.map((one) => one.version).filter(Boolean))].sort(versionOrder);
    const perBoard = new Map();
    for (const one of occurrences) {
      const board = perBoard.get(one.thing) ?? {
        thing: one.thing,
        count: 0,
        firstSeen: one.at,
        lastSeen: one.at,
        versions: new Set(),
      };
      board.count += 1;
      if (one.at < board.firstSeen) board.firstSeen = one.at;
      if (one.at > board.lastSeen) board.lastSeen = one.at;
      if (one.version) board.versions.add(one.version);
      perBoard.set(one.thing, board);
    }
    const standing = versionStanding(new Set(versions), seen);
    out.push({
      id: issue.id,
      signature: issue.signature,
      type: issue.type,
      title: issue.title,
      count: occurrences.length,
      boards: perBoard.size,
      versions,
      firstSeen: occurrences[occurrences.length - 1].at,
      lastSeen: occurrences[0].at,
      firstVersion: versions[0] ?? null,
      lastVersion: versions[versions.length - 1] ?? null,
      status: standing.status,
      fixedIn: standing.fixedIn,
      regressedIn: standing.regressedIn,
      // Came back after a fix at least once, even if a newer fix holds now.
      regressed: standing.regression !== null,
      perBoard: [...perBoard.values()]
        .map((board) => ({ ...board, versions: [...board.versions].sort(versionOrder) }))
        .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1)),
      occurrences,
    });
  }
  return out.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : a.id < b.id ? -1 : 1));
}

/** An issue as the list returns it: no boards, no timeline. */
export function issueSummary({ perBoard, occurrences, ...rest }) {
  return rest;
}

/** An issue as its page returns it: its boards and its newest occurrences. */
export function issueDetail({ perBoard, occurrences, ...rest }) {
  return {
    ...rest,
    perBoard,
    timeline: occurrences.slice(0, TIMELINE_MAX),
    timelineCut: occurrences.length > TIMELINE_MAX,
  };
}
