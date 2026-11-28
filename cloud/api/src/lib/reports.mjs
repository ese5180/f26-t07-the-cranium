/**
 * The weekly fleet report (docs/reports.md): one page per week, made on demand from what the console keeps
 * already. Plain functions: the handler (handlers/reports.mjs) reads the records, these say which week, make
 * the report of them, and write it as CSV and as the Monday e-mail.
 *
 * A week runs from Monday 00:00 to the next Monday 00:00 in REPORT_ZONE, the team's time zone (America/
 * New_York), so a week with a change of the clocks is 167 or 169 hours long. A week is named by its Monday,
 * "2026-11-02". The daily HEALTH snapshots are named by their UTC day: a week holds the snapshots of its seven
 * days by name.
 *
 * The parts of a report, each with what it is made from:
 *
 *   health       the fleet health score of each day of the week, from the daily snapshots
 *                (lib/fleet-score.mjs), its first and last, and how far it moved since the week before
 *   boards       boards in all, online, offline and new, at the end of the week: from the week's last
 *                snapshot (from console 2.19.0 a snapshot also counts the boards), or for the week under
 *                way the boards now. New: registered through the console that week (device.register), or
 *                in the week's last snapshot and not in the one before the week
 *   versions     the firmware the boards ran at the end of the week, from the same
 *   deployments  the deployments started that week (AWS IoT Jobs), with how their boards ended
 *   rollouts     the staged rollouts started or ended that week, with how each ended: done, stopped (the
 *                health gate's stops counted apart), cancelled; and which were rollbacks
 *   updates      how the boards' updates over the air ended that week, as they reported them
 *   memfault     the issues Memfault first saw that week, and its unexpected reboots by reason
 *   restarts     the boards' own unexpected restarts by cause, from the events table
 *   alerts       the e-mail alerts sent that week (kept 30 days: an older week says it is not known)
 *   changes      the activity log's changes of the week: how many of each action, and the newest
 */

import { badRequest, notFound } from '../http.mjs';
import { BAD_CAUSES, CAUSE_WORDS } from './events.mjs';
import { resetCauses } from './shadow.mjs';

export const REPORT_ZONE = 'America/New_York';
// The weeks the Reports page lists, newest first, and the oldest a report may be asked for.
export const WEEKS_LISTED = 12;
export const WEEKS_KEPT = 52;
// The state table's partition of the reports: the setting (sk "settings"), a week's stored report once it
// is over (sk "week#<monday>"), and the claim of a week's Monday e-mail (sk "mail#<monday>").
export const REPORTS_PK = 'RPT';
export const SETTINGS_SK = 'settings';
export const weekKey = (week) => `week#${week}`;
export const mailKey = (week) => `mail#${week}`;
// The Monday e-mail goes on Monday from this hour in REPORT_ZONE, for the week that ended at midnight.
export const MAIL_HOUR = 8;
// A finished week is stored once it has been over this long, so that late reports of the boards are in it.
export const SETTLE_MS = 6 * 3_600_000;
// How much of each list a report keeps.
export const SHOWN = Object.freeze({
  deployments: 50,
  rollouts: 50,
  issues: 25,
  alerts: 50,
  changes: 20,
  newBoards: 50,
});
// What the activity log holds that is no change to the fleet: reads that go on record, and the schedule's steps.
export const NOT_CHANGES = new Set([
  'account.sign_in',
  'firmware.download',
  'pairing.read',
  'firmware.bluetooth_send',
  'app.download',
  'app.ios_download',
  'setup.wifi_defaults',
  'db.export',
  'report.export',
  'device.seen',
  'rollout.advance',
]);
export const ALERTS_KEPT_DAYS = 30;

const DAY_MS = 86_400_000;
const WEEK_ID = /^\d{4}-\d{2}-\d{2}$/;
const STOP_GATE = new Set(['health_failed', 'health_unknown']);
const ROLLBACK_PURPOSES = new Set(['rollback', 'last_good']);

// Time in REPORT_ZONE.

const zoneFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The wall clock in REPORT_ZONE at a time: { year, month, day, hour, minute, second }. */
export function zoned(ms) {
  const parts = Object.fromEntries(
    zoneFormat
      .formatToParts(new Date(ms))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** How far REPORT_ZONE's clock is ahead of UTC at a time, in milliseconds (negative in New York). */
function offsetAt(ms) {
  const wall = zoned(ms);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The time of midnight starting a day in REPORT_ZONE ("2026-11-02"). */
export function midnightOf(day) {
  const [year, month, date] = day.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, date);
  let ms = wall - offsetAt(wall);
  // Once more with the offset of that very moment: the first guess may be on the other side of a change.
  ms = wall - offsetAt(ms);
  return ms;
}

const dayText = (ms) => new Date(ms).toISOString().slice(0, 10);
/** A calendar day moved by whole days: "2026-11-02" + 7 -> "2026-11-09". */
export const addDays = (day, count) => dayText(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS);

/** The week a time falls in: its Monday in REPORT_ZONE, "2026-11-02". */
export function weekOf(ms) {
  const wall = zoned(ms);
  const day = dayText(Date.UTC(wall.year, wall.month - 1, wall.day));
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday 0 ... Sunday 6
  return addDays(day, -weekday);
}

/** Whether a value names a week: a real date that is a Monday. */
export function isWeek(value) {
  if (typeof value !== 'string' || !WEEK_ID.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && dayText(ms) === value && new Date(ms).getUTCDay() === 1;
}

/** A week's span: { week, fromMs, toMs, days } with toMs the next Monday's midnight (left out). */
export function weekSpan(week) {
  return {
    week,
    fromMs: midnightOf(week),
    toMs: midnightOf(addDays(week, 7)),
    days: Array.from({ length: 7 }, (_, index) => addDays(week, index)),
  };
}

/** The week of a request's path, checked: 400 invalid_week, 404 unknown_week for one not yet begun or too old. */
export function requireWeek(value, nowMs) {
  if (!isWeek(value)) {
    throw badRequest('invalid_week', 'A week is named by its Monday, like 2026-11-02.');
  }
  const current = weekOf(nowMs);
  if (value > current || value < addDays(current, -7 * WEEKS_KEPT)) {
    throw notFound('unknown_week', `There is a report for each of the last ${WEEKS_KEPT} weeks and this one only.`);
  }
  return value;
}

/** The weeks the Reports page lists: this one and those before it, newest first. */
export function listedWeeks(nowMs, count = WEEKS_LISTED) {
  const current = weekOf(nowMs);
  return Array.from({ length: count }, (_, index) => addDays(current, -7 * index));
}

/** Whether the Monday e-mail of the week before is due at a time: Monday, from MAIL_HOUR in REPORT_ZONE. */
export function mailWeekDue(nowMs) {
  const wall = zoned(nowMs);
  const current = weekOf(nowMs);
  const monday = dayText(Date.UTC(wall.year, wall.month - 1, wall.day)) === current;
  return monday && wall.hour >= MAIL_HOUR ? addDays(current, -7) : null;
}

// The setting.

/** The report setting as stored, or the default (no e-mail): { email, updatedAt, updatedBy }. */
export function settingsOf(item) {
  return {
    email: item?.email === true,
    updatedAt: typeof item?.updatedAt === 'string' ? item.updatedAt : null,
    updatedBy: typeof item?.updatedBy?.email === 'string' ? item.updatedBy.email : null,
  };
}

/** The body of POST /api/reports/settings, checked: { email: true | false } and nothing else. */
export function requireSettings(body) {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'email' || typeof body.email !== 'boolean') {
    throw badRequest(
      'invalid_report_settings',
      'This takes { "email": true } or { "email": false }, and nothing else.'
    );
  }
  return { email: body.email };
}

// Making a report.

const inSpan = (span, iso) => {
  const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) && ms >= span.fromMs && ms < span.toMs;
};

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** The health part: each day's score of the week (null where none was taken), first, last and the change. */
export function healthPart(span, snapshots) {
  const byDay = new Map(snapshots.filter((one) => one !== null).map((one) => [one.day, one]));
  const days = span.days.map((day) => ({ day, score: byDay.get(day)?.score ?? null }));
  const known = days.filter((one) => one.score !== null);
  const before = snapshots
    .filter((one) => one !== null && one.day < span.days[0] && one.score !== null)
    .sort((a, b) => (a.day < b.day ? 1 : -1))[0];
  const first = known[0]?.score ?? null;
  const last = known.at(-1)?.score ?? null;
  const previous = before?.score ?? null;
  return {
    days,
    first,
    last,
    lowest: known.length === 0 ? null : Math.min(...known.map((one) => one.score)),
    previous,
    // Since the week before ended, or else since the week's first day.
    change: last === null ? null : previous !== null ? last - previous : known.length > 1 ? last - first : null,
  };
}

/**
 * The boards and versions at the end of the week. `end` is { from: "snapshot" | "now", boards, online,
 * offline, bluetoothOnly, versions: { version: count }, unknown, things } or null when nothing counted them;
 * `before` the same of the snapshot before the week, or null; `registered` the boards registered through the
 * console that week.
 */
export function boardsPart({ end, before, registered }) {
  const fresh = new Set(registered);
  if (end !== null && before !== null && Array.isArray(end.things) && Array.isArray(before.things)) {
    const had = new Set(before.things);
    for (const thing of end.things) if (!had.has(thing)) fresh.add(thing);
  }
  const added = [...fresh].sort();
  if (end === null) {
    return {
      known: false,
      from: null,
      total: null,
      online: null,
      offline: null,
      bluetoothOnly: null,
      added: added.slice(0, SHOWN.newBoards),
      addedCount: added.length,
    };
  }
  return {
    known: true,
    from: end.from,
    total: end.boards,
    online: end.online,
    offline: end.offline,
    bluetoothOnly: end.bluetoothOnly,
    added: added.slice(0, SHOWN.newBoards),
    addedCount: added.length,
  };
}

export function versionsPart(end) {
  if (end === null) return { known: false, from: null, list: [], unknown: null };
  const list = Object.entries(end.versions ?? {})
    .filter(([, count]) => Number.isInteger(count) && count > 0)
    .map(([version, count]) => ({ version, count }))
    .sort((a, b) => b.count - a.count || versionOrder(b.version, a.version));
  return { known: true, from: end.from, list, unknown: Number.isInteger(end.unknown) ? end.unknown : 0 };
}

function versionOrder(a, b) {
  const parts = (text) => text.split(/[.+]/).map((part) => Number(part) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    if ((x[index] ?? 0) !== (y[index] ?? 0)) return (x[index] ?? 0) - (y[index] ?? 0);
  }
  return 0;
}

/** How a deployment ended, from its summary (lib/jobs.mjs summarizeJob). */
export function deploymentOutcome(summary) {
  const counts = summary.counts ?? {};
  const failed = (counts.failed ?? 0) + (counts.rejected ?? 0) + (counts.timedOut ?? 0);
  const open = (counts.queued ?? 0) + (counts.inProgress ?? 0);
  if (summary.status === 'IN_PROGRESS' && open > 0) return 'underway';
  if (summary.status === 'CANCELED' && (counts.succeeded ?? 0) === 0 && failed === 0) return 'cancelled';
  if (failed > 0) return (counts.succeeded ?? 0) > 0 ? 'partial' : 'failed';
  if (summary.status === 'CANCELED') return 'cancelled';
  return 'succeeded';
}

export function deploymentsPart(span, summaries) {
  const list = summaries
    .filter((one) => one !== null && inSpan(span, one.createdAt))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((one) => ({
      id: one.id,
      version: one.version,
      createdAt: one.createdAt,
      createdBy: one.createdBy ?? null,
      boards: one.things.length,
      succeeded: one.counts?.succeeded ?? 0,
      failed: (one.counts?.failed ?? 0) + (one.counts?.rejected ?? 0) + (one.counts?.timedOut ?? 0),
      outcome: deploymentOutcome(one),
    }));
  const outcomes = countBy(list.map((one) => one.outcome));
  return {
    count: list.length,
    outcomes: Object.fromEntries(
      ['succeeded', 'partial', 'failed', 'cancelled', 'underway'].map((id) => [id, outcomes.get(id) ?? 0])
    ),
    list: list.slice(0, SHOWN.deployments),
  };
}

/** How a staged rollout stands: done, stopped, cancelled or underway. */
export function rolloutOutcome(rollout) {
  if (rollout.stage === 'done') return 'done';
  if (rollout.stage === 'cancelled') return 'cancelled';
  if (rollout.stage === 'stopped') return rollout.stopped?.code === 'cancelled' ? 'cancelled' : 'stopped';
  return 'underway';
}

export function rolloutsPart(span, rollouts) {
  const list = rollouts
    .filter((one) => one !== null && (inSpan(span, one.createdAt) || inSpan(span, one.finishedAt)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((one) => ({
      id: one.id,
      version: one.version,
      purpose: one.purpose,
      rollback: ROLLBACK_PURPOSES.has(one.purpose),
      createdAt: one.createdAt,
      finishedAt: one.finishedAt ?? null,
      boards: one.things.length,
      outcome: rolloutOutcome(one),
      gated: one.healthGate !== null,
      stopCode: rolloutOutcome(one) === 'stopped' ? (one.stopped?.code ?? null) : null,
      stopText: rolloutOutcome(one) === 'stopped' ? (one.stopped?.text ?? null) : null,
    }));
  const outcomes = countBy(list.map((one) => one.outcome));
  return {
    count: list.length,
    outcomes: Object.fromEntries(['done', 'stopped', 'cancelled', 'underway'].map((id) => [id, outcomes.get(id) ?? 0])),
    gateStops: list.filter((one) => STOP_GATE.has(one.stopCode)).length,
    rollbacks: list.filter((one) => one.rollback).length,
    list: list.slice(0, SHOWN.rollouts),
  };
}

/**
 * The boards' unexpected restarts by cause, from their warn events of kind restart (lib/events.mjs): a
 * restart for being stuck is "stuck", any other by the reset causes its boot diary gave (in hex, the
 * Zephyr bits of lib/shadow.mjs), the bad ones where there are any.
 */
export function restartsPart(events) {
  const found = new Map();
  for (const event of events) {
    if (event.kind !== 'restart' || event.level !== 'warn') continue;
    const causes =
      event.what === 'stuck' ? ['stuck'] : typeof event.cause === 'string' ? resetCauses(event.cause) : ['unknown'];
    const bad = causes.filter((cause) => BAD_CAUSES.has(cause));
    const reason = (bad.length > 0 ? bad : causes).join('+');
    const entry = found.get(reason) ?? { reason, label: reasonLabel(reason), count: 0, boards: new Set() };
    entry.count += 1;
    entry.boards.add(event.thing);
    found.set(reason, entry);
  }
  return [...found.values()]
    .map((entry) => ({ ...entry, boards: [...entry.boards].sort() }))
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1));
}

function reasonLabel(reason) {
  if (reason === 'stuck') return 'Restarted itself for being stuck';
  if (reason === 'unknown') return 'Cause not known';
  const words = reason
    .split('+')
    .map((cause) => CAUSE_WORDS[cause] ?? cause)
    .join(' and ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function memfaultPart(span, found) {
  if (found === null || found.state !== 'ok') {
    return {
      state: found?.state ?? 'not_configured',
      message: found?.message ?? '',
      newIssueCount: null,
      newIssues: [],
      reboots: [],
    };
  }
  const issues = found.issues
    .filter((one) => inSpan(span, one.firstSeen))
    .sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : -1))
    .map((one) => ({ id: one.id, title: one.title, firstSeen: one.firstSeen, boards: one.boards, traces: one.traces }));
  return {
    state: 'ok',
    message: '',
    newIssueCount: issues.length,
    newIssues: issues.slice(0, SHOWN.issues),
    reboots: found.reboots.map((one) => ({
      reason: one.reason.name,
      count: one.count,
      boards: one.boards,
    })),
  };
}

export function alertsPart(span, sent, nowMs) {
  if (sent === null || span.fromMs < nowMs - ALERTS_KEPT_DAYS * DAY_MS) {
    return { known: false, count: null, byKind: [], list: [] };
  }
  const list = sent.filter((one) => one !== null && inSpan(span, one.at)).sort((a, b) => (a.at < b.at ? 1 : -1));
  const byKind = [...countBy(list.map((one) => one.kind))]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1));
  return { known: true, count: list.length, byKind, list: list.slice(0, SHOWN.alerts) };
}

/** The changes of the week from the activity log: what was done ok, without the reads it also keeps. */
export function changesPart(entries) {
  const done = entries.filter(
    (one) => one !== null && one.outcome === 'ok' && typeof one.action === 'string' && !NOT_CHANGES.has(one.action)
  );
  const byAction = [...countBy(done.map((one) => one.action))]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count || (a.action < b.action ? -1 : 1));
  return {
    count: done.length,
    people: new Set(done.map((one) => one.actor?.email).filter(Boolean)).size,
    byAction,
    recent: done
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, SHOWN.changes)
      .map((one) => ({
        at: one.at,
        action: one.action,
        target: one.target ?? '',
        by: one.actor?.email || 'The console',
      })),
  };
}

/** The whole report of a week from what was read for it. */
export function buildReport({
  span,
  nowMs,
  snapshots,
  end,
  before,
  registered,
  deployments,
  rollouts,
  updates,
  events,
  memfault,
  sent,
  audit,
}) {
  return {
    week: span.week,
    zone: REPORT_ZONE,
    from: new Date(span.fromMs).toISOString(),
    to: new Date(span.toMs).toISOString(),
    complete: nowMs >= span.toMs,
    health: healthPart(span, snapshots),
    boards: boardsPart({ end, before, registered }),
    versions: versionsPart(end),
    deployments: deploymentsPart(span, deployments),
    rollouts: rolloutsPart(span, rollouts),
    updates,
    memfault: memfaultPart(span, memfault),
    restarts: restartsPart(events),
    alerts: alertsPart(span, sent, nowMs),
    changes: changesPart(audit),
    generatedAt: new Date(nowMs).toISOString(),
  };
}

// The report as CSV: the main tables in one file, each row led by its section.

function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let text = String(value);
  // A spreadsheet would run a cell that starts like a formula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const CSV_COLUMNS = Object.freeze(['section', 'item', 'value', 'detail', 'at']);

/** The rows of the CSV: [section, item, value, detail, at]. */
export function reportRows(report) {
  const rows = [];
  const add = (section, item, value, detail = '', at = '') => rows.push([section, item, value, detail, at]);
  add('week', 'from', report.from, report.zone);
  add('week', 'to', report.to, report.complete ? 'complete' : 'under way');
  for (const day of report.health.days) add('health', day.day, day.score);
  add('health', 'change', report.health.change, 'since the week before');
  const { boards } = report;
  add('boards', 'total', boards.total, boards.from ?? 'not recorded');
  add('boards', 'online', boards.online);
  add('boards', 'offline', boards.offline);
  add('boards', 'bluetooth only', boards.bluetoothOnly);
  add('boards', 'new', boards.addedCount, boards.added.join(' '));
  for (const one of report.versions.list) add('versions', one.version, one.count);
  if (report.versions.unknown) add('versions', 'not known', report.versions.unknown);
  for (const one of report.deployments.list) {
    add(
      'deployments',
      one.id,
      one.outcome,
      `${one.version}; ${one.boards} boards, ${one.succeeded} ok, ${one.failed} failed`,
      one.createdAt
    );
  }
  for (const one of report.rollouts.list) {
    const detail = [
      one.version,
      one.purpose,
      one.stopCode ? `stopped: ${one.stopCode}` : '',
      one.gated ? 'health gate' : '',
    ]
      .filter(Boolean)
      .join('; ');
    add('rollouts', one.id, one.outcome, detail, one.createdAt);
  }
  const updates = report.updates ?? {};
  for (const name of ['succeeded', 'failed', 'rolledBack']) add('updates', name, updates[name] ?? null);
  for (const one of report.memfault.newIssues)
    add('memfault issues', `#${one.id}`, one.boards, one.title, one.firstSeen);
  for (const one of report.memfault.reboots) add('memfault reboots', one.reason, one.count, one.boards.join(' '));
  for (const one of report.restarts) add('restarts', one.label, one.count, one.boards.join(' '));
  for (const one of report.alerts.list) add('alerts', one.kind, one.thing ?? one.deployment ?? '', one.subject, one.at);
  for (const one of report.changes.byAction) add('changes', one.action, one.count);
  return rows;
}

export function reportCsv(report) {
  const lines = [CSV_COLUMNS.join(','), ...reportRows(report).map((row) => row.map(cell).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

// The Monday e-mail: the summary in a few lines, and the link to the page.

const signed = (value) => (value === null ? 'not known' : value > 0 ? `+${value}` : String(value));
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

export function reportMail(report, consoleUrl) {
  const base = typeof consoleUrl === 'string' && /^https:\/\/[^\s]+\/$/.test(consoleUrl) ? consoleUrl : null;
  const { health, boards, deployments, rollouts, memfault, alerts, changes } = report;
  const lines = [
    `The week of ${report.week} (Monday to Sunday, ${report.zone}).`,
    '',
    `Fleet health score: ${health.last ?? 'not known'} (change ${signed(health.change)}).`,
    boards.known
      ? `Boards: ${boards.total}, ${boards.online} online, ${boards.offline} offline, ${boards.addedCount} new.`
      : `Boards: not counted that week; ${boards.addedCount} new.`,
    `Deployments: ${deployments.count} (${deployments.outcomes.succeeded} succeeded, ${deployments.outcomes.failed + deployments.outcomes.partial} with failures).`,
    `Staged rollouts: ${rollouts.count} (${rollouts.outcomes.done} done, ${rollouts.outcomes.stopped} stopped, ` +
      `${rollouts.gateStops} by the health gate; ${plural(rollouts.rollbacks, 'rollback', 'rollbacks')}).`,
    memfault.state === 'ok'
      ? `Memfault: ${plural(memfault.newIssueCount, 'new issue', 'new issues')}, ` +
        `${plural(
          memfault.reboots.reduce((sum, one) => sum + one.count, 0),
          'unexpected reboot',
          'unexpected reboots'
        )}.`
      : 'Memfault: could not be read.',
    alerts.known ? `Alerts sent: ${alerts.count}.` : 'Alerts sent: not known.',
    `Changes in the activity log: ${changes.count}.`,
    '',
    base === null ? null : `The report: ${base}#/reports/${report.week}`,
    '',
    'This e-mail goes out each Monday while a release manager keeps it switched on, on the Reports page.',
  ].filter((line) => line !== null);
  return { subject: `Cranium: weekly fleet report, week of ${report.week}`, message: lines.join('\n') };
}
