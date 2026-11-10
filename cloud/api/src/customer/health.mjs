/**
 * A board's health in plain words, for its owner (docs/customer-site.md, "Board health").
 *
 * Worked out from the events table, which the customer API's role may already read: the restart
 * events (lib/events.mjs) with the reset cause the board's boot diary gave, the firmware events and
 * the update events. Not from Memfault: its reboot reasons and coredumps are read with the org
 * token, a secret the customer function is not given (infra/template.yaml), and they say more
 * than a customer is shown anyway.
 *
 * Every restart is one of two plain categories, and nothing more is said about it:
 *
 *   expected     an update, a power cycle, the reset button, a restart the board was asked for
 *   unexpected   any fault or watchdog: the causes lib/events.mjs BAD_CAUSES names (brownout,
 *                watchdog, lockup, ...), and a restart the board made itself for being stuck
 *
 * Never a cause's name, a fault name, a stack or a thing name: the health object holds a state,
 * a sentence, counts and times.
 *
 * No AWS here and no clock: the caller passes the events and the time.
 */

import { BAD_CAUSES } from '../lib/events.mjs';
import { resetCauses } from '../lib/shadow.mjs';

export const HEALTH_DAYS = 7;
// What a health check reads of the events table.
export const HEALTH_KINDS = Object.freeze(['restart', 'firmware', 'update']);
export const HEALTH_EVENTS = 200;
const DAY_MS = 86_400_000;
// A restart event and the boot-diary event that says why it happened can come in two reports.
const SAME_RESTART_MS = 10 * 60_000;
// A restart this close to an update's own events is the update's.
const UPDATE_NEAR_MS = 15 * 60_000;
// An unexpected restart this recent still needs attention; an older one, alone, was recovered from.
const RECENT_MS = DAY_MS;
// The restarts listed for the week's strip.
const LISTED = 50;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue 3 Nov", in UTC: the pages say it again in the reader's own time. */
export function dayWords(iso) {
  const date = new Date(iso);
  return `${DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** "once", "twice", "3 times". */
export function timesWords(count) {
  return count === 1 ? 'once' : count === 2 ? 'twice' : `${count} times`;
}

/** A version as a customer reads it: no "+0". */
function shownVersion(version) {
  return typeof version === 'string' ? version.replace(/\+0$/, '') : null;
}

/**
 * Why a restart event happened, in a plain category, or null for an event that is no restart.
 * `why` is for this module and its tests: 'power', 'reset', 'restart', 'problem' ('update' is
 * decided later, from the events around it).
 *
 * @returns {{ unexpected: boolean, why: string, known: boolean } | null}
 */
export function restartCategory(event) {
  if (event?.kind !== 'restart') return null;
  if (event.what === 'stuck') return { unexpected: true, why: 'problem', known: true };
  if (event.what !== 'restarted' && event.what !== 'boot') return null;
  if (typeof event.cause !== 'string') return { unexpected: false, why: 'restart', known: false };
  const causes = resetCauses(event.cause);
  if (causes.some((cause) => BAD_CAUSES.has(cause))) return { unexpected: true, why: 'problem', known: true };
  if (causes.includes('power_on')) return { unexpected: false, why: 'power', known: true };
  if (causes.includes('pin') || causes.includes('user')) return { unexpected: false, why: 'reset', known: true };
  return { unexpected: false, why: 'restart', known: true };
}

/** An update's own events: the firmware changed, or an update restarted into or ended with a result. */
function isUpdateEvent(event) {
  return (
    (event.kind === 'firmware' && event.what === 'changed') ||
    (event.kind === 'update' && (event.what === 'result' || (event.what === 'step' && event.state === 'rebooting')))
  );
}

/**
 * The restarts in some events (lib/events.mjs eventFromItem, any order), oldest first: one per
 * restart, however many events said it. [{ at, atMs, unexpected, why }]
 */
export function restartsOf(events) {
  const sorted = events
    .filter((event) => event !== null && typeof event?.at === 'string' && Number.isFinite(Date.parse(event.at)))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const updates = sorted.filter(isUpdateEvent).map((event) => Date.parse(event.at));
  const restarts = [];
  for (const event of sorted) {
    const category = restartCategory(event);
    if (category === null) continue;
    const atMs = Date.parse(event.at);
    const last = restarts.at(-1);
    // The diary's word, or a stuck count, after the uptime already said the board restarted.
    if (last !== undefined && atMs - last.atMs <= SAME_RESTART_MS && event.what !== 'restarted') {
      if (category.unexpected) Object.assign(last, { unexpected: true, why: 'problem', known: true });
      else if (!last.known) Object.assign(last, { why: category.why, known: category.known });
      continue;
    }
    restarts.push({ at: event.at, atMs, ...category });
  }
  for (const restart of restarts) {
    if (!restart.unexpected && updates.some((at) => Math.abs(at - restart.atMs) <= UPDATE_NEAR_MS)) {
      restart.why = 'update';
    }
  }
  return restarts.map(({ at, atMs, unexpected, why }) => ({ at, atMs, unexpected, why }));
}

/**
 * The health of a board as its owner is shown it.
 *
 * @param {object} options
 * @param {string} options.status     customer/boards.mjs boardStatus
 * @param {string|null} options.lastSeen
 * @param {object[]} options.events   the board's events of at least the last HEALTH_DAYS days
 * @param {number} options.nowMs
 * @returns {{ state: 'ok'|'attention'|'offline', summary: string, unexpectedRestarts7d: number,
 *             lastIssueAt?: string, updatedTo?: { version: string, at: string },
 *             restarts7d: { at: string, unexpected: boolean }[] }}
 */
export function boardHealth({ status, lastSeen, events, nowMs }) {
  const fromMs = nowMs - HEALTH_DAYS * DAY_MS;
  const week = restartsOf(events ?? []).filter((restart) => restart.atMs >= fromMs && restart.atMs <= nowMs);
  const unexpected = week.filter((restart) => restart.unexpected);
  const lastIssue = unexpected.at(-1);
  const updated = (events ?? [])
    .filter(
      (event) =>
        event?.kind === 'firmware' &&
        event.what === 'changed' &&
        typeof event.version === 'string' &&
        Date.parse(event.at) >= fromMs &&
        Date.parse(event.at) <= nowMs
    )
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];

  const health = { state: 'ok', summary: 'Running normally', unexpectedRestarts7d: unexpected.length };
  if (lastIssue !== undefined) health.lastIssueAt = lastIssue.at;
  if (updated !== undefined) health.updatedTo = { version: shownVersion(updated.version), at: updated.at };
  health.restarts7d = week.slice(-LISTED).map(({ at, unexpected: bad }) => ({ at, unexpected: bad }));

  if (status === 'new') {
    Object.assign(health, { state: 'offline', summary: 'Not heard from yet' });
  } else if (status === 'offline') {
    health.state = 'offline';
    health.summary = typeof lastSeen === 'string' ? `Offline since ${dayWords(lastSeen)}` : 'Offline';
  } else if (unexpected.length >= 2 || (lastIssue !== undefined && nowMs - lastIssue.atMs < RECENT_MS)) {
    Object.assign(health, {
      state: 'attention',
      summary: `Restarted unexpectedly ${timesWords(unexpected.length)} this week`,
    });
  } else if (lastIssue !== undefined) {
    health.summary = `Recovered from a problem on ${dayWords(lastIssue.at)}`;
  } else if (status === 'updating' || status === 'restarting') {
    health.summary = 'Installing an update';
  } else if (updated !== undefined) {
    health.summary = `Updated to ${health.updatedTo.version} on ${dayWords(updated.at)}`;
  }
  return health;
}
