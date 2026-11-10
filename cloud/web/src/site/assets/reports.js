/**
 * The weekly fleet report (docs/reports.md): the Reports page (#/reports) lists the last twelve weeks, and a
 * week (#/reports/2026-11-02) opens as one page: the fleet health score and its trend, the boards online,
 * offline and new, the firmware they ran, the deployments and staged rollouts of the week with how they ended
 * (the health gate's stops and the rollbacks said apart), Memfault's new issues and unexpected reboots by
 * reason, the boards' own restarts, the alerts sent, and the activity log's changes.
 *
 * A week is Monday to Sunday in America/New_York, the team's time zone, whatever the reader's clock says.
 * The page prints as itself: the print stylesheet in app.css leaves out the console around it, so "Save as
 * PDF" in the print dialog makes the PDF. Download CSV saves the main tables in one CSV file
 * (GET /api/reports/{week}/export), which goes on record. A release manager switches the Monday e-mail of the
 * summary on and off here (POST /api/reports/settings), for everybody who gets the alerts.
 *
 * Every member reads the reports. The script is fetched when the page is first opened (app.js).
 */

import { ApiError, exactTime, isReportWeek, plural } from './core.js';
import { badge, button, card, empty, failure, h, icon, loadProblem, loading, mono, pageHead, stats } from './views.js';

// A report of a week under way is read again at most this often; a finished week's does not change.
export const REPORT_REFRESH_MS = 5 * 60_000;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

let app = null;

const listing = { value: null, error: null, loadedAt: 0, loading: false };
const reports = new Map(); // week -> resource
const saving = { busy: false, error: null };
const exporting = { busy: false, error: null, done: null };

function resource() {
  return { value: null, error: null, loadedAt: 0, loading: false };
}

/** Hand the page what it needs from app.js: { state, api, load, draw, notify, now, share, inApp, print }. */
export function connect(given) {
  app = given;
}

function reportOf(week) {
  if (!reports.has(week)) reports.set(week, resource());
  return reports.get(week);
}

export function listResources() {
  return [listing];
}

export function reportResources(state) {
  const week = state.route?.week;
  return isReportWeek(week) ? [reportOf(week)] : [];
}

export function holdStill() {
  return saving.busy || exporting.busy !== false;
}

// Reading.

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const text = (value, max = 300) => (typeof value === 'string' ? value.slice(0, max) : '');
const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
const score = (value) => (Number.isInteger(value) && value >= 0 && value <= 100 ? value : null);
const signed = (value) => (Number.isInteger(value) ? value : null);

/** The list of GET /api/reports, as far as it can be trusted. */
export function readReportList(raw) {
  const value = object(raw);
  const settings = object(value.settings);
  return {
    zone: text(value.zone, 64) || 'America/New_York',
    mailHour: count(value.mailHour) ?? 8,
    weeks: list(value.weeks)
      .map(object)
      .filter((week) => isReportWeek(week.week))
      .map((week) => ({ week: week.week, complete: week.complete === true, score: score(week.score) })),
    settings: {
      email: settings.email === true,
      updatedAt: text(settings.updatedAt, 40) || null,
      updatedBy: text(settings.updatedBy, 320) || null,
    },
    canChange: value.canChange === true,
  };
}

/** A week's report, as far as it can be trusted: what is not as expected reads as not known. */
export function readReport(raw) {
  const value = object(raw);
  const health = object(value.health);
  const boards = object(value.boards);
  const versions = object(value.versions);
  const deployments = object(value.deployments);
  const rollouts = object(value.rollouts);
  const updates = object(value.updates);
  const memfault = object(value.memfault);
  const alerts = object(value.alerts);
  const changes = object(value.changes);
  return {
    week: isReportWeek(value.week) ? value.week : null,
    zone: text(value.zone, 64) || 'America/New_York',
    complete: value.complete === true,
    generatedAt: text(value.generatedAt, 40),
    health: {
      days: list(health.days)
        .map(object)
        .map((day) => ({ day: text(day.day, 10), score: score(day.score) })),
      first: score(health.first),
      last: score(health.last),
      lowest: score(health.lowest),
      previous: score(health.previous),
      change: signed(health.change),
    },
    boards: {
      known: boards.known === true,
      from: boards.from === 'now' ? 'now' : boards.from === 'snapshot' ? 'snapshot' : null,
      total: count(boards.total),
      online: count(boards.online),
      offline: count(boards.offline),
      bluetoothOnly: count(boards.bluetoothOnly),
      added: list(boards.added).filter((thing) => typeof thing === 'string'),
      addedCount: count(boards.addedCount) ?? 0,
    },
    versions: {
      known: versions.known === true,
      list: list(versions.list)
        .map(object)
        .map((one) => ({ version: text(one.version, 40), count: count(one.count) ?? 0 })),
      unknown: count(versions.unknown),
    },
    deployments: {
      count: count(deployments.count) ?? 0,
      outcomes: object(deployments.outcomes),
      list: list(deployments.list)
        .map(object)
        .map((one) => ({
          id: text(one.id, 64),
          version: text(one.version, 40),
          createdAt: text(one.createdAt, 40),
          boards: count(one.boards) ?? 0,
          succeeded: count(one.succeeded) ?? 0,
          failed: count(one.failed) ?? 0,
          outcome: text(one.outcome, 16),
        })),
    },
    rollouts: {
      count: count(rollouts.count) ?? 0,
      outcomes: object(rollouts.outcomes),
      gateStops: count(rollouts.gateStops) ?? 0,
      rollbacks: count(rollouts.rollbacks) ?? 0,
      list: list(rollouts.list)
        .map(object)
        .map((one) => ({
          id: text(one.id, 64),
          version: text(one.version, 40),
          rollback: one.rollback === true,
          createdAt: text(one.createdAt, 40),
          boards: count(one.boards) ?? 0,
          outcome: text(one.outcome, 16),
          gated: one.gated === true,
          stopCode: text(one.stopCode, 40) || null,
          stopText: text(one.stopText, 200) || null,
        })),
    },
    updates: {
      succeeded: count(updates.succeeded),
      failed: count(updates.failed),
      rolledBack: count(updates.rolledBack),
    },
    memfault: {
      state: text(memfault.state, 32) || 'not_configured',
      message: text(memfault.message, 300),
      newIssueCount: count(memfault.newIssueCount),
      newIssues: list(memfault.newIssues)
        .map(object)
        .map((one) => ({
          id: count(one.id),
          title: text(one.title, 200),
          firstSeen: text(one.firstSeen, 40),
          boards: count(one.boards) ?? 0,
        })),
      reboots: list(memfault.reboots)
        .map(object)
        .map((one) => ({
          reason: text(one.reason, 80),
          count: count(one.count) ?? 0,
          boards: list(one.boards).length,
        })),
    },
    restarts: list(value.restarts)
      .map(object)
      .map((one) => ({
        reason: text(one.reason, 80),
        label: text(one.label, 120),
        count: count(one.count) ?? 0,
        boards: list(one.boards).length,
      })),
    alerts: {
      known: alerts.known === true,
      count: count(alerts.count),
      byKind: list(alerts.byKind)
        .map(object)
        .map((one) => ({ kind: text(one.kind, 24), count: count(one.count) ?? 0 })),
    },
    changes: {
      count: count(changes.count) ?? 0,
      people: count(changes.people) ?? 0,
      byAction: list(changes.byAction)
        .map(object)
        .map((one) => ({ action: text(one.action, 40), count: count(one.count) ?? 0 })),
      recent: list(changes.recent)
        .map(object)
        .map((one) => ({
          at: text(one.at, 40),
          action: text(one.action, 40),
          target: text(one.target, 200),
          by: text(one.by, 320),
        })),
    },
  };
}

export async function refreshReports() {
  await app.load(listing, async () => readReportList(await app.api.reports()));
}

export async function refreshReport(week, full = false) {
  if (!isReportWeek(week)) return;
  const target = reportOf(week);
  const finished = target.value?.complete === true;
  if (!full && target.loadedAt !== 0 && (finished || app.now() - target.loadedAt < REPORT_REFRESH_MS)) return;
  await app.load(target, async () => readReport((await app.api.report(week)).report));
}

// Words.

const dayOf = (day) => {
  const [year, month, date] = day.split('-').map(Number);
  return { year, month, date };
};

/** "2 to 8 November 2026", "26 October to 1 November 2026", "29 December 2025 to 4 January 2026". */
export function weekWords(week) {
  const first = dayOf(week);
  const end = new Date(Date.UTC(first.year, first.month - 1, first.date + 6));
  const last = { year: end.getUTCFullYear(), month: end.getUTCMonth() + 1, date: end.getUTCDate() };
  const month = (one) => MONTHS[one.month - 1];
  if (first.year !== last.year)
    return `${first.date} ${month(first)} ${first.year} to ${last.date} ${month(last)} ${last.year}`;
  if (first.month !== last.month) return `${first.date} ${month(first)} to ${last.date} ${month(last)} ${last.year}`;
  return `${first.date} to ${last.date} ${month(last)} ${last.year}`;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function changeWords(change) {
  if (change === null) return 'Not known';
  if (change === 0) return 'No change';
  return change > 0 ? `Up ${change}` : `Down ${-change}`;
}

const DEPLOYMENT_LOOKS = Object.freeze({
  succeeded: ['good', 'check-circle', 'Succeeded'],
  partial: ['warn', 'alert', 'Some failed'],
  failed: ['bad', 'x-circle', 'Failed'],
  cancelled: ['idle', 'ban', 'Cancelled'],
  underway: ['idle', 'clock', 'Under way'],
});

const ROLLOUT_LOOKS = Object.freeze({
  done: ['good', 'check-circle', 'Done'],
  stopped: ['bad', 'stop', 'Stopped'],
  cancelled: ['idle', 'ban', 'Cancelled'],
  underway: ['idle', 'clock', 'Under way'],
});

const look = (looks, outcome) => badge(...(looks[outcome] ?? looks.underway));

// Drawing.

function weekRow(entry) {
  return h(
    'li',
    { key: entry.week, class: 'row report-week' },
    h(
      'div',
      { class: 'row-main' },
      h('a', { class: 'row-title cover-link', href: `#/reports/${entry.week}` }, weekWords(entry.week)),
      h(
        'span',
        { class: 'row-note dotted' },
        h('span', null, entry.score === null ? 'No health score' : `Health score ${entry.score}`),
        entry.complete ? null : h('span', null, 'So far')
      )
    ),
    entry.complete ? null : badge('idle', 'clock', 'Under way'),
    h('span', { class: 'row-chevron' }, icon('arrow-right'))
  );
}

function emailCard(data, ctx) {
  const { settings, canChange } = data;
  const said = settings.email
    ? `On: each Monday from ${String(data.mailHour).padStart(2, '0')}:00 (${data.zone}), the summary of the week before ` +
      'goes to everybody who gets the alerts, with a link to its page.'
    : 'Off: no e-mail of the report goes out.';
  return card(
    { key: 'email', title: 'Monday e-mail', className: 'report-email' },
    h(
      'p',
      { class: 'report-email-state' },
      badge(settings.email ? 'good' : 'idle', 'bell', settings.email ? 'On' : 'Off'),
      ' ',
      said
    ),
    settings.updatedBy
      ? h('p', { class: 'card-note' }, `Last changed by ${settings.updatedBy}, ${exactTime(settings.updatedAt)}.`)
      : null,
    canChange
      ? h(
          'p',
          { class: 'button-row' },
          button(
            settings.email ? '' : 'is-primary',
            () => ctx.actions.setReportEmail(!settings.email),
            saving.busy ? 'Saving…' : settings.email ? 'Switch the e-mail off' : 'Switch the e-mail on'
          )
        )
      : h('p', { class: 'card-note' }, 'A release manager switches it on or off.'),
    saving.error ? failure('The setting was not changed.', saving.error) : null
  );
}

/** The Reports page: the weeks, newest first, and the Monday e-mail. */
export function reportsView(ctx) {
  const head = pageHead({
    title: 'Reports',
    lede: 'One page a week, Monday to Sunday in New York time: how the fleet did, what was sent to it, and what changed.',
  });
  const data = listing.value;
  if (data === null) {
    return h(
      'div',
      { class: 'page reports-page', key: 'page' },
      head,
      loadProblem(listing, 'the reports', ctx),
      listing.error ? null : loading('the reports')
    );
  }
  return h(
    'div',
    { class: 'page reports-page', key: 'page' },
    head,
    loadProblem(listing, 'the reports', ctx),
    card(
      { key: 'weeks', title: 'Weeks' },
      data.weeks.length === 0
        ? empty({ iconName: 'file', title: 'No weeks yet.', text: 'The first report is this week’s.' })
        : h('ul', { class: 'rows report-weeks', 'aria-label': 'Weeks, newest first' }, data.weeks.map(weekRow))
    ),
    emailCard(data, ctx)
  );
}

function healthCard(report) {
  const { health } = report;
  return card(
    { key: 'health', title: 'Fleet health score', className: 'report-section' },
    stats([
      [
        'At the end of the week',
        health.last ?? '—',
        health.first !== null && health.first !== health.last ? `began at ${health.first}` : null,
      ],
      [
        'Since the week before',
        changeWords(health.change),
        health.previous !== null ? `from ${health.previous}` : null,
      ],
      ['Lowest', health.lowest ?? '—'],
    ]),
    h(
      'ol',
      { class: 'report-days', 'aria-label': 'The score of each day' },
      health.days.map((day, index) =>
        h(
          'li',
          {
            key: day.day,
            class: `report-day${day.score === null ? ' is-none' : ''}`,
            vars: { '--score': String(day.score ?? 0) },
          },
          h('span', { class: 'report-day-bar', 'aria-hidden': 'true' }),
          h('span', { class: 'report-day-value' }, day.score === null ? '—' : String(day.score)),
          h('span', { class: 'report-day-name' }, WEEKDAYS[index] ?? day.day)
        )
      )
    ),
    h('p', { class: 'card-note' }, 'From the daily snapshots of the score (0 to 100). A dash: no snapshot that day.')
  );
}

function boardsCard(report) {
  const { boards, versions } = report;
  const asOf =
    boards.from === 'now' ? 'Now, as the week is under way.' : 'At the end of the week, from its last daily snapshot.';
  return card(
    { key: 'boards', title: 'Boards and firmware', className: 'report-section' },
    boards.known
      ? stats([
          ['Boards', boards.total],
          ['Online', boards.online],
          ['Offline', boards.offline],
          ['New this week', boards.addedCount],
        ])
      : h(
          'p',
          { class: 'quiet' },
          `Not counted that week: the daily snapshot counts the boards from console 2.18.0. New this week: ${boards.addedCount}.`
        ),
    boards.added.length > 0
      ? h(
          'p',
          { class: 'report-new' },
          'New: ',
          boards.added.map((thing, index) => [index > 0 ? ', ' : null, mono(thing)])
        )
      : null,
    versions.list.length > 0
      ? h(
          'ul',
          { class: 'rows report-versions', 'aria-label': 'Firmware versions' },
          versions.list.map((one) =>
            h(
              'li',
              { key: one.version, class: 'row' },
              h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, mono(one.version))),
              h('span', { class: 'row-value' }, plural(one.count, 'board'))
            )
          )
        )
      : null,
    versions.unknown
      ? h('p', { class: 'card-note' }, `${plural(versions.unknown, 'board')} did not say which firmware.`)
      : null,
    boards.known ? h('p', { class: 'card-note' }, asOf) : null
  );
}

function deploymentsCard(report) {
  const { deployments, rollouts, updates } = report;
  const failedOutcomes = (deployments.outcomes.failed ?? 0) + (deployments.outcomes.partial ?? 0);
  return card(
    { key: 'deployments', title: 'Deployments and rollouts', className: 'report-section' },
    stats([
      ['Deployments', deployments.count, failedOutcomes > 0 ? `${failedOutcomes} with failures` : null],
      ['Staged rollouts', rollouts.count, rollouts.outcomes.stopped ? `${rollouts.outcomes.stopped} stopped` : null],
      ['Health gate stops', rollouts.gateStops],
      ['Rollbacks', rollouts.rollbacks],
    ]),
    rollouts.list.length > 0
      ? h(
          'ul',
          { class: 'rows report-rollouts', 'aria-label': 'Staged rollouts' },
          rollouts.list.map((one) =>
            h(
              'li',
              { key: one.id, class: 'row' },
              h(
                'div',
                { class: 'row-main' },
                h(
                  'a',
                  { class: 'row-title cover-link', href: `#/rollouts/${one.id}` },
                  one.rollback ? 'Rollback to ' : 'Rollout of ',
                  mono(one.version)
                ),
                h(
                  'span',
                  { class: 'row-note dotted' },
                  h('span', null, plural(one.boards, 'board')),
                  h('span', null, exactTime(one.createdAt)),
                  one.gated ? h('span', null, 'health gate') : null,
                  one.stopText ? h('span', null, one.stopText) : null
                )
              ),
              look(ROLLOUT_LOOKS, one.outcome)
            )
          )
        )
      : null,
    deployments.list.length > 0
      ? h(
          'ul',
          { class: 'rows report-deployments', 'aria-label': 'Deployments' },
          deployments.list.map((one) =>
            h(
              'li',
              { key: one.id, class: 'row' },
              h(
                'div',
                { class: 'row-main' },
                h(
                  'a',
                  { class: 'row-title cover-link', href: `#/deployments/${one.id}` },
                  'Deployment of ',
                  mono(one.version)
                ),
                h(
                  'span',
                  { class: 'row-note dotted' },
                  h('span', null, `${one.succeeded} of ${plural(one.boards, 'board')} updated`),
                  one.failed ? h('span', null, `${one.failed} failed`) : null,
                  h('span', null, exactTime(one.createdAt))
                )
              ),
              look(DEPLOYMENT_LOOKS, one.outcome)
            )
          )
        )
      : null,
    deployments.count === 0 && rollouts.count === 0
      ? h('p', { class: 'quiet' }, 'Nothing was sent to the boards this week.')
      : null,
    updates.succeeded !== null
      ? h(
          'p',
          { class: 'card-note' },
          `As the boards reported them: ${plural(updates.succeeded, 'update')} kept, ${updates.failed} failed, ` +
            `${updates.rolledBack} rolled back by the board.`
        )
      : null
  );
}

function memfaultCard(report) {
  const { memfault, restarts } = report;
  const reboots = memfault.reboots.reduce((sum, one) => sum + one.count, 0);
  return card(
    { key: 'memfault', title: 'Issues and reboots', className: 'report-section' },
    memfault.state === 'ok'
      ? stats([
          ['New Memfault issues', memfault.newIssueCount ?? 0],
          ['Unexpected reboots', reboots, 'in Memfault'],
          ['Board restarts', restarts.reduce((sum, one) => sum + one.count, 0), 'unexpected, from the boards'],
        ])
      : h('p', { class: 'quiet' }, memfault.message || 'Memfault could not be read for this report.'),
    memfault.newIssues.length > 0
      ? h(
          'ul',
          { class: 'rows report-issues', 'aria-label': 'New Memfault issues' },
          memfault.newIssues.map((one) =>
            h(
              'li',
              { key: String(one.id), class: 'row' },
              h(
                'div',
                { class: 'row-main' },
                h('a', { class: 'row-title cover-link', href: `#/memfault/${one.id}` }, one.title),
                h(
                  'span',
                  { class: 'row-note dotted' },
                  h('span', null, `#${one.id}`),
                  h('span', null, plural(one.boards, 'board')),
                  h('span', null, exactTime(one.firstSeen))
                )
              )
            )
          )
        )
      : null,
    reasonList(
      'Reboots in Memfault, by reason',
      memfault.reboots.map((one) => ({ key: one.reason, label: one.reason, count: one.count, boards: one.boards }))
    ),
    reasonList(
      'The boards’ own restarts, by cause',
      restarts.map((one) => ({ key: one.reason, label: one.label, count: one.count, boards: one.boards }))
    )
  );
}

function reasonList(title, rows) {
  if (rows.length === 0) return null;
  return h(
    'div',
    { class: 'report-reasons', key: title },
    h('h3', { class: 'report-subhead' }, title),
    h(
      'ul',
      { class: 'rows', 'aria-label': title },
      rows.map((row) =>
        h(
          'li',
          { key: row.key, class: 'row' },
          h(
            'div',
            { class: 'row-main' },
            h('span', { class: 'row-title' }, row.label),
            h('span', { class: 'row-note' }, plural(row.boards, 'board'))
          ),
          h('span', { class: 'row-value' }, String(row.count))
        )
      )
    )
  );
}

function alertsCard(report) {
  const { alerts, changes } = report;
  return card(
    { key: 'activity', title: 'Alerts and changes', className: 'report-section' },
    stats([
      ['Alerts sent', alerts.known ? alerts.count : '—', alerts.known ? null : 'kept 30 days'],
      ['Changes', changes.count, changes.people ? `by ${plural(changes.people, 'person', 'people')}` : null],
    ]),
    alerts.byKind.length > 0
      ? h(
          'p',
          { class: 'report-kinds' },
          alerts.byKind.map((one, index) => [index > 0 ? ' · ' : null, `${one.count} ${one.kind}`])
        )
      : null,
    changes.byAction.length > 0
      ? h(
          'div',
          { class: 'report-reasons' },
          h('h3', { class: 'report-subhead' }, 'Top changes'),
          h(
            'ul',
            { class: 'rows', 'aria-label': 'Changes by kind' },
            changes.byAction
              .slice(0, 10)
              .map((one) =>
                h(
                  'li',
                  { key: one.action, class: 'row' },
                  h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, mono(one.action))),
                  h('span', { class: 'row-value' }, String(one.count))
                )
              )
          ),
          h('p', { class: 'card-note' }, h('a', { href: '#/activity' }, 'The activity log'), ' has every entry.')
        )
      : null
  );
}

/** The page of one week. */
export function reportView(ctx) {
  const week = ctx.state.route?.week;
  const target = isReportWeek(week) ? reportOf(week) : resource();
  const head = (report) =>
    pageHead({
      back: { href: '#/reports', label: 'Reports' },
      eyebrow: 'Weekly report',
      title: isReportWeek(week) ? weekWords(week) : 'A week',
      lede: report
        ? `Monday to Sunday, ${report.zone} time.${report.complete ? '' : ' The week is under way: this is so far.'}`
        : null,
      tools: report
        ? h(
            'div',
            { class: 'report-tools' },
            button('', () => ctx.actions.printReport(), icon('file'), 'Print or save as PDF'),
            button(
              '',
              () => ctx.actions.exportReport(week),
              icon('download'),
              exporting.busy ? 'Saving…' : 'Download CSV'
            )
          )
        : null,
    });
  const report = target.value;
  if (report === null) {
    return h(
      'div',
      { class: 'page report-page', key: 'page' },
      head(null),
      loadProblem(target, 'the report', ctx),
      target.error ? null : loading('the report')
    );
  }
  return h(
    'div',
    { class: 'page report-page', key: 'page' },
    head(report),
    loadProblem(target, 'the report', ctx),
    exporting.error ? failure('The CSV was not saved.', exporting.error) : null,
    healthCard(report),
    boardsCard(report),
    deploymentsCard(report),
    memfaultCard(report),
    alertsCard(report),
    h('p', { class: 'card-note report-made' }, `Made ${exactTime(report.generatedAt)} from the console’s records.`)
  );
}

// Doing.

export async function setEmail(on) {
  if (saving.busy || !listing.value?.canChange) return;
  Object.assign(saving, { busy: true, error: null });
  app.draw();
  try {
    const reply = await app.api.setReportEmail(on === true);
    const settings = readReportList({ settings: reply.settings }).settings;
    listing.value = { ...listing.value, settings };
    app.notify?.(settings.email ? 'The Monday e-mail of the report is on.' : 'The Monday e-mail of the report is off.');
  } catch (error) {
    saving.error = error;
  } finally {
    saving.busy = false;
    app.draw();
  }
}

function base64Of(content) {
  const bytes = new TextEncoder().encode(content);
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** Download the week's CSV: in an app through its share sheet where it has one, else as a file. On record. */
export async function exportCsv(week) {
  if (exporting.busy || !isReportWeek(week)) return;
  Object.assign(exporting, { busy: true, error: null, done: null });
  app.draw();
  try {
    const reply = await app.api.reportExport(week);
    if (typeof reply.content !== 'string' || !/^cranium-report-\d{4}-\d{2}-\d{2}\.csv$/.test(reply.name ?? '')) {
      throw new ApiError(0, 'unreadable', 'The server’s answer could not be read.');
    }
    const file = { name: reply.name, type: 'text/csv', content: reply.content };
    if (app.share) {
      await app.share({ name: file.name, type: file.type, data: base64Of(file.content) });
    } else if (app.inApp) {
      throw new ApiError(0, 'unavailable', 'This app cannot save a file. Download it from the website instead.');
    } else {
      const address = URL.createObjectURL(new Blob([file.content], { type: file.type }));
      const link = document.createElement('a');
      link.href = address;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(address), 60_000);
    }
    exporting.done = file;
  } catch (error) {
    if (error?.code !== 'cancelled') exporting.error = error;
  } finally {
    exporting.busy = false;
    app.draw();
  }
}

/** The browser's print dialog, where "Save as PDF" is; app.css prints the report alone. */
export function print() {
  app.print?.();
}
