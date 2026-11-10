/**
 * The weekly fleet report (docs/reports.md, lib/reports.mjs): one page a week, Monday to Sunday in the team's
 * time zone, made on demand from what the console keeps already, and kept.
 *
 *   GET  /api/reports                     -> { zone, mailHour, weeks: [{ week, from, to, complete, score }],
 *                                              settings: { email, updatedAt, updatedBy }, canChange }
 *        the last WEEKS_LISTED weeks, this one first; `score` the week's last daily health score, or null
 *   GET  /api/reports/{week}              -> { report }     400 invalid_week, 404 unknown_week
 *   GET  /api/reports/{week}/export?format=csv
 *                                         -> { name, type, content, rows }                      report.export
 *        the main tables in one CSV, each row led by its section (lib/reports.mjs reportCsv)
 *   POST /api/reports/settings            body { email: true | false } -> { settings }          report.settings
 *        the Monday e-mail of the report through the alert topic, for everybody who gets the alerts; off
 *        until a release manager switches it on. Written only if nobody changed it meanwhile (409
 *        report_settings_changed).
 *
 * Every member reads the reports; an export goes on record (a read that is recorded, as the Database page's
 * exports are), and only a release manager changes the setting (app.mjs).
 *
 * Kept. A report is made from the records at the first read and kept in memory: CURRENT_MS for a week under
 * way, FINISHED_MS for one that is over. Once a week has been over SETTLE_MS it is also stored (state table,
 * pk RPT, sk week#<monday>) on the condition that keeps the first, and read from there after that: what a past
 * week says does not change between two readers or two days.
 *
 * mailDue() is the schedule's (tick.mjs): on Monday from MAIL_HOUR, when the setting is on, the report of the
 * week that ended goes to the alert topic once, claimed first by a conditional put (sk mail#<monday>), so that
 * two runs at once never both send it.
 */

import { RELEASE_MANAGERS } from '../auth.mjs';
import { badRequest, conflict, field } from '../http.mjs';
import { change } from '../lib/audit.mjs';
import { sentFromItem } from '../lib/alerts.mjs';
import { eventFromItem, eventRange } from '../lib/events.mjs';
import { rolloutFromItem, updateResults } from '../lib/fleet.mjs';
import { SNAPSHOT_PK, fleetCounts, snapshotFleet, snapshotFromItem } from '../lib/fleet-score.mjs';
import { MAX_IN_FLIGHT, mapLimit } from '../lib/jobs.mjs';
import {
  MAIL_HOUR,
  REPORTS_PK,
  REPORT_ZONE,
  SETTINGS_SK,
  SETTLE_MS,
  WEEKS_KEPT,
  buildReport,
  listedWeeks,
  mailKey,
  mailWeekDue,
  reportCsv,
  reportMail,
  reportRows,
  requireSettings,
  requireWeek,
  settingsOf,
  weekKey,
  weekSpan,
} from '../lib/reports.mjs';

export const CURRENT_MS = 5 * 60_000;
export const FINISHED_MS = 60 * 60_000;
const SNAPSHOTS_READ = 7 * WEEKS_KEPT + 14;
const EVENTS_READ = 1000;
const AUDIT_READ = 2000;
const AUDIT_BUDGET = 10_000;
const SENT_READ = 1000;
const MAX_KEPT = 64;

export function createReportHandlers(
  { aws, now, log, config },
  { devices, fleet, deployments, memfault = () => null, publish = null }
) {
  const kept = new Map(); // week -> { report, until }

  const readSettings = () => aws.getFleetItem({ pk: REPORTS_PK, sk: SETTINGS_SK });

  async function snapshots() {
    return aws.listFleetItems(SNAPSHOT_PK, { limit: SNAPSHOTS_READ });
  }

  /** The boards at the end of the week, and in the last snapshot before it. */
  function fleetAt(span, items, live) {
    const sunday = span.days[6];
    const monday = span.days[0];
    const withFleet = items
      .filter((item) => typeof item?.sk === 'string' && snapshotFleet(item) !== null)
      .sort((a, b) => (a.sk < b.sk ? 1 : -1));
    const last = withFleet.find((item) => item.sk >= monday && item.sk <= sunday) ?? null;
    const before = withFleet.find((item) => item.sk < monday) ?? null;
    const end =
      live !== null ? { from: 'now', ...live } : last === null ? null : { from: 'snapshot', ...snapshotFleet(last) };
    return { end, before: before === null ? null : snapshotFleet(before) };
  }

  /** The boards' update and restart events of the week, each board read on its own. */
  async function weekEvents(span) {
    const things = await devices.groupThings();
    const range = eventRange(span.fromMs, span.toMs - 1);
    const lists = await mapLimit(things, MAX_IN_FLIGHT, async (thing) => {
      try {
        const items = await aws.queryEvents({ thing, ...range, kinds: ['update', 'restart'], limit: EVENTS_READ });
        return items.map(eventFromItem).filter((event) => event !== null);
      } catch (error) {
        log({ level: 'warn', event: 'events_unreadable', thing, error: String(error?.message ?? error).slice(0, 200) });
        return [];
      }
    });
    return lists.flat();
  }

  async function memfaultWeek(span) {
    const reader = memfault();
    if (reader === null || typeof reader.week !== 'function') return { state: 'not_configured', message: '' };
    try {
      return await reader.week({ sinceMs: span.fromMs, untilMs: span.toMs });
    } catch (error) {
      log({ level: 'warn', event: 'memfault_failed', error: String(error?.message ?? error).slice(0, 200) });
      return { state: 'unreachable', message: 'Memfault could not be read just now.' };
    }
  }

  async function sentAlerts() {
    if (typeof aws.listSentAlerts !== 'function') return null;
    return (await aws.listSentAlerts({ limit: SENT_READ })).map(sentFromItem).filter((one) => one !== null);
  }

  async function auditOf(span) {
    const found = await aws.searchAudit({
      low: new Date(span.fromMs).toISOString(),
      high: `${new Date(span.toMs - 1).toISOString()}#~`,
      outcomes: ['ok'],
      limit: AUDIT_READ,
      budget: AUDIT_BUDGET,
    });
    return found.items;
  }

  /** A week's report made from the records now. */
  async function make(span) {
    const nowMs = now();
    const live = nowMs < span.toMs ? fleetCounts((await fleet.boards()).map(({ board }) => board)) : null;
    const [items, summaries, rolloutItems, events, mf, sent, audit] = await Promise.all([
      snapshots(),
      deployments.between({ sinceMs: span.fromMs, untilMs: span.toMs }),
      aws.listFleetItems('ROL'),
      weekEvents(span),
      memfaultWeek(span),
      sentAlerts(),
      auditOf(span),
    ]);
    const { end, before } = fleetAt(span, items, live);
    const registered = audit
      .filter((entry) => entry?.action === 'device.register' && typeof entry.target === 'string' && entry.target !== '')
      .map((entry) => entry.target);
    return buildReport({
      span,
      nowMs,
      snapshots: items.map(snapshotFromItem),
      end,
      before,
      registered,
      deployments: summaries,
      rollouts: rolloutItems.map(rolloutFromItem),
      updates: updateResults(events),
      events,
      memfault: mf,
      sent,
      audit,
    });
  }

  /** A week's report: from memory, from the table once it is stored, or made now (and stored once settled). */
  async function reportOf(week) {
    const known = kept.get(week);
    if (known !== undefined && now() < known.until) return known.report;
    const span = weekSpan(week);
    const settled = now() >= span.toMs + SETTLE_MS;
    let report = null;
    if (settled) {
      const stored = await aws.getFleetItem({ pk: REPORTS_PK, sk: weekKey(week) });
      if (stored?.report?.week === week) report = stored.report;
    }
    if (report === null) {
      report = await make(span);
      if (settled) {
        const put = await aws.putFleetItem({
          pk: REPORTS_PK,
          sk: weekKey(week),
          item: { week, report, storedAt: new Date(now()).toISOString() },
        });
        if (put.ok) log({ level: 'info', event: 'report_stored', week });
      }
    }
    if (kept.size >= MAX_KEPT) kept.clear();
    kept.set(week, { report, until: now() + (now() >= span.toMs ? FINISHED_MS : CURRENT_MS) });
    return report;
  }

  return {
    reportOf,

    async list({ caller }) {
      const [items, settingsItem] = await Promise.all([snapshots(), readSettings()]);
      const scores = new Map(
        items
          .map(snapshotFromItem)
          .filter((one) => one !== null)
          .map((one) => [one.day, one.score])
      );
      const weeks = listedWeeks(now()).map((week) => {
        const span = weekSpan(week);
        const score = [...span.days].reverse().find((day) => scores.get(day) !== undefined && scores.get(day) !== null);
        return {
          week,
          from: new Date(span.fromMs).toISOString(),
          to: new Date(span.toMs).toISOString(),
          complete: now() >= span.toMs,
          score: score === undefined ? null : scores.get(score),
        };
      });
      return {
        body: {
          zone: REPORT_ZONE,
          mailHour: MAIL_HOUR,
          weeks,
          settings: settingsOf(settingsItem),
          canChange: caller.groups.includes(RELEASE_MANAGERS),
        },
      };
    },

    async get({ params }) {
      const week = requireWeek(params.week, now());
      return { body: { report: await reportOf(week) } };
    },

    async exportCsv({ params, query, entry }) {
      const week = requireWeek(params.week, now());
      entry.target = week;
      const format = field(query ?? {}, 'format') ?? 'csv';
      if (format !== 'csv') throw badRequest('invalid_report_format', 'A report is exported as CSV: format=csv.');
      entry.detail.format = format;
      const report = await reportOf(week);
      entry.detail.rows = String(reportRows(report).length);
      return {
        body: {
          name: `cranium-report-${week}.csv`,
          type: 'text/csv',
          content: reportCsv(report),
          rows: reportRows(report).length,
        },
      };
    },

    async setSettings({ actor, json, entry }) {
      entry.target = 'settings';
      const wanted = requireSettings(json());
      entry.detail.email = wanted.email ? 'on' : 'off';
      const item = await readSettings();
      const current = settingsOf(item);
      const at = new Date(now()).toISOString();
      const by = { sub: actor.sub, email: actor.email };
      const written =
        item === null
          ? await aws.putFleetItem({
              pk: REPORTS_PK,
              sk: SETTINGS_SK,
              item: { email: wanted.email, updatedAt: at, updatedBy: by, rev: 1 },
            })
          : await aws.updateFleetItem({
              pk: REPORTS_PK,
              sk: SETTINGS_SK,
              rev: Number.isSafeInteger(item.rev) ? item.rev : 0,
              set: { email: wanted.email, updatedAt: at, updatedBy: by },
            });
      if (!written.ok) {
        throw conflict('report_settings_changed', 'Someone changed the report e-mail at the same moment. Look again.');
      }
      change(entry, 'report_email', current.email ? 'on' : 'off', wanted.email ? 'on' : 'off');
      return { body: { settings: settingsOf({ email: wanted.email, updatedAt: at, updatedBy: by }) } };
    },

    /**
     * The schedule's Monday e-mail (tick.mjs): -> { week, sent } with week null when none is due. Sent once
     * a week at most, and only while the setting is on.
     */
    async mailDue() {
      const week = mailWeekDue(now());
      if (week === null || typeof publish !== 'function') return { week: null, sent: false };
      if (!settingsOf(await readSettings()).email) return { week: null, sent: false };
      const claimed = await aws.putFleetItem({
        pk: REPORTS_PK,
        sk: mailKey(week),
        item: { week, at: new Date(now()).toISOString() },
      });
      if (!claimed.ok) return { week, sent: false };
      const mail = reportMail(await reportOf(week), config?.consoleUrl ? `${config.consoleUrl}/` : null);
      const sent = await publish(mail);
      log({ level: sent ? 'info' : 'error', event: sent ? 'report_mailed' : 'report_unmailed', week });
      return { week, sent };
    },
  };
}
