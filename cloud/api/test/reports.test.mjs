// Tests for the weekly fleet report (docs/reports.md): the weeks in America/New_York (src/lib/reports.mjs), a
// report made of an empty fleet and of a week of mixed outcomes, what is kept and stored, the CSV, the Monday
// e-mail's setting and its sending by the schedule (src/tick.mjs), and who may do what (handlers/reports.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { eventKey } from '../src/lib/events.mjs';
import {
  REPORTS_PK,
  SETTLE_MS,
  addDays,
  buildReport,
  changesPart,
  deploymentOutcome,
  isWeek,
  listedWeeks,
  mailWeekDue,
  midnightOf,
  reportCsv,
  reportMail,
  requireWeek,
  rolloutsPart,
  weekOf,
  weekSpan,
} from '../src/lib/reports.mjs';
import { CURRENT_MS } from '../src/handlers/reports.mjs';
import { createRolloutTick } from '../src/tick.mjs';
import { createTestConsole } from './fake-aws.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const A = 'cranium-00000000000000aa';
const B = 'cranium-00000000000000bb';
// Wednesday 11 November 2026, 10:00 in New York (EST, UTC-5): the week of 9 November is under way.
const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);
const WEEK = '2026-11-02'; // the week before: Monday 2 Nov 05:00 UTC to Monday 9 Nov 05:00 UTC
const FROM = Date.UTC(2026, 10, 2, 5, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

// The weeks.

test('a week runs from Monday midnight to Monday midnight in New York, whatever UTC says', () => {
  // Sunday 1 November, 23:59 EST is still the week of 26 October; a minute later the week of 2 November.
  assert.equal(weekOf(Date.UTC(2026, 10, 2, 4, 59, 59)), '2026-10-26');
  assert.equal(weekOf(Date.UTC(2026, 10, 2, 5, 0, 0)), '2026-11-02');
  // Monday 01:00 UTC is still Sunday evening in New York.
  assert.equal(weekOf(Date.UTC(2026, 10, 9, 1, 0, 0)), '2026-11-02');
  assert.equal(weekOf(NOW), '2026-11-09');
  // Summer time: midnight is 04:00 UTC.
  assert.equal(midnightOf('2026-07-06'), Date.UTC(2026, 6, 6, 4, 0, 0));
  assert.equal(midnightOf('2026-11-02'), Date.UTC(2026, 10, 2, 5, 0, 0));
});

test('the weeks with a change of the clocks are 169 and 167 hours long', () => {
  // The clocks went back on Sunday 1 November 2026, and forward on Sunday 8 March 2026.
  const autumn = weekSpan('2026-10-26');
  assert.equal(autumn.fromMs, Date.UTC(2026, 9, 26, 4, 0, 0));
  assert.equal(autumn.toMs - autumn.fromMs, 169 * HOUR);
  const spring = weekSpan('2026-03-02');
  assert.equal(spring.toMs - spring.fromMs, 167 * HOUR);
  assert.equal(weekSpan(WEEK).toMs - weekSpan(WEEK).fromMs, 168 * HOUR);
  assert.deepEqual(weekSpan(WEEK).days, [
    '2026-11-02',
    '2026-11-03',
    '2026-11-04',
    '2026-11-05',
    '2026-11-06',
    '2026-11-07',
    '2026-11-08',
  ]);
});

test('a week is named by a real Monday, and only this one and the 52 before it have a report', () => {
  assert.equal(isWeek('2026-11-02'), true);
  assert.equal(isWeek('2026-11-03'), false); // a Tuesday
  assert.equal(isWeek('2026-02-30'), false);
  assert.equal(isWeek('2026-11-2'), false);
  assert.equal(isWeek(undefined), false);
  assert.equal(requireWeek('2026-11-09', NOW), '2026-11-09');
  assert.throws(() => requireWeek('2026-11-16', NOW), { code: 'unknown_week', status: 404 });
  assert.throws(() => requireWeek(addDays('2026-11-09', -7 * 53), NOW), { code: 'unknown_week' });
  assert.throws(() => requireWeek('2026-11-10', NOW), { code: 'invalid_week', status: 400 });
  assert.deepEqual(listedWeeks(NOW, 3), ['2026-11-09', '2026-11-02', '2026-10-26']);
});

test('the Monday e-mail is due on Monday from 08:00 in New York, for the week that just ended', () => {
  assert.equal(mailWeekDue(Date.UTC(2026, 10, 9, 12, 59)), null); // 07:59 EST
  assert.equal(mailWeekDue(Date.UTC(2026, 10, 9, 13, 0)), '2026-11-02'); // 08:00 EST
  assert.equal(mailWeekDue(Date.UTC(2026, 10, 9, 23, 0)), '2026-11-02');
  assert.equal(mailWeekDue(Date.UTC(2026, 10, 10, 13, 0)), null); // Tuesday
  assert.equal(mailWeekDue(Date.UTC(2026, 10, 9, 4, 0)), null); // Sunday night in New York
});

// The parts, without AWS.

test('deployments and rollouts are told by how they ended, the health gate and rollbacks counted apart', () => {
  const counts = (extra) => ({
    queued: 0,
    inProgress: 0,
    succeeded: 0,
    failed: 0,
    rejected: 0,
    canceled: 0,
    timedOut: 0,
    removed: 0,
    ...extra,
  });
  assert.equal(deploymentOutcome({ status: 'COMPLETED', counts: counts({ succeeded: 3 }) }), 'succeeded');
  assert.equal(deploymentOutcome({ status: 'COMPLETED', counts: counts({ succeeded: 2, failed: 1 }) }), 'partial');
  assert.equal(deploymentOutcome({ status: 'COMPLETED', counts: counts({ timedOut: 1 }) }), 'failed');
  assert.equal(deploymentOutcome({ status: 'CANCELED', counts: counts({ canceled: 2 }) }), 'cancelled');
  assert.equal(deploymentOutcome({ status: 'IN_PROGRESS', counts: counts({ queued: 1 }) }), 'underway');

  const span = weekSpan(WEEK);
  const rollout = (id, at, extra) => ({
    id,
    version: '1.15.0+0',
    purpose: 'deploy',
    createdAt: iso(at),
    finishedAt: null,
    things: [A, B],
    healthGate: null,
    stage: 'done',
    stopped: null,
    ...extra,
  });
  const part = rolloutsPart(span, [
    rollout('r1', FROM + DAY, {}),
    rollout('r2', FROM + 2 * DAY, {
      stage: 'stopped',
      stopped: { code: 'health_failed', text: 'gate' },
      healthGate: { minutes: 10 },
    }),
    rollout('r3', FROM + 3 * DAY, { stage: 'stopped', stopped: { code: 'aborted', text: 'too many' } }),
    rollout('r4', FROM + 4 * DAY, { purpose: 'rollback', stage: 'cancelled' }),
    rollout('r5', FROM + 5 * DAY, { purpose: 'last_good', stage: 'stages' }),
    // Begun the week before and ended in this one: in it. Begun and ended before: not.
    rollout('r6', FROM - DAY, { finishedAt: iso(FROM + HOUR) }),
    rollout('r7', FROM - 2 * DAY, { finishedAt: iso(FROM - DAY) }),
    null,
  ]);
  assert.equal(part.count, 6);
  assert.deepEqual(part.outcomes, { done: 2, stopped: 2, cancelled: 1, underway: 1 });
  assert.equal(part.gateStops, 1);
  assert.equal(part.rollbacks, 2);
  assert.equal(part.list.find((one) => one.id === 'r2').stopCode, 'health_failed');
  assert.equal(part.list.find((one) => one.id === 'r2').gated, true);
  assert.equal(part.list[0].id, 'r5', 'newest first');
});

test('the changes of the week are what was done, not what was read', () => {
  const entry = (action, at, outcome = 'ok', email = 'manager@example.com') => ({
    at,
    action,
    outcome,
    target: 'x',
    actor: { sub: 's', email },
  });
  const part = changesPart([
    entry('alert.rules', '2026-11-03T10:00:00.000Z'),
    entry('alert.rules', '2026-11-04T10:00:00.000Z', 'ok', 'other@example.com'),
    entry('group.create', '2026-11-05T10:00:00.000Z'),
    entry('firmware.download', '2026-11-05T11:00:00.000Z'),
    entry('account.sign_in', '2026-11-05T12:00:00.000Z'),
    entry('report.export', '2026-11-05T12:00:00.000Z'),
    entry('rollout.advance', '2026-11-05T12:00:00.000Z', 'ok', ''),
    entry('group.delete', '2026-11-06T10:00:00.000Z', 'rejected'),
  ]);
  assert.equal(part.count, 3);
  assert.equal(part.people, 2);
  assert.deepEqual(part.byAction, [
    { action: 'alert.rules', count: 2 },
    { action: 'group.create', count: 1 },
  ]);
  assert.equal(part.recent[0].action, 'group.create');
});

test('the e-mail says the week in a few lines, with the link to its page', () => {
  const report = buildReport({
    span: weekSpan(WEEK),
    nowMs: NOW,
    snapshots: [
      { day: '2026-11-08', score: 82, parts: {} },
      { day: '2026-11-01', score: 90, parts: {} },
    ],
    end: null,
    before: null,
    registered: [A],
    deployments: [],
    rollouts: [],
    updates: { succeeded: 0, failed: 0, rolledBack: 0 },
    events: [],
    memfault: null,
    sent: [],
    audit: [],
  });
  assert.equal(report.health.change, -8);
  const mail = reportMail(report, 'https://console.example.com/');
  assert.equal(mail.subject, 'Cranium: weekly fleet report, week of 2026-11-02');
  assert.match(mail.message, /Fleet health score: 82 \(change -8\)/);
  assert.match(mail.message, /Boards: not counted that week; 1 new\./);
  assert.match(mail.message, /https:\/\/console\.example\.com\/#\/reports\/2026-11-02/);
  assert.match(mail.message, /Memfault: could not be read\./);
  assert.doesNotMatch(reportMail(report, 'http://insecure/').message, /http:/);
});

// Through the API, on the fake.

function world({ startMs = NOW } = {}) {
  const console_ = createTestConsole({ startMs });
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  return { ...console_, manager, viewer };
}

test('an empty fleet: a past week with nothing in it, and this week with no boards', async () => {
  const w = world();
  const past = await w.call('GET', `/api/reports/${WEEK}`, { as: w.viewer });
  assert.equal(past.status, 200, JSON.stringify(past.body));
  const { report } = past.body;
  assert.equal(report.week, WEEK);
  assert.equal(report.zone, 'America/New_York');
  assert.equal(report.from, '2026-11-02T05:00:00.000Z');
  assert.equal(report.to, '2026-11-09T05:00:00.000Z');
  assert.equal(report.complete, true);
  assert.deepEqual(
    report.health.days.map((day) => day.score),
    [null, null, null, null, null, null, null]
  );
  assert.equal(report.health.change, null);
  assert.equal(report.boards.known, false, 'no snapshot counted the boards');
  assert.equal(report.boards.addedCount, 0);
  assert.deepEqual(report.versions, { known: false, from: null, list: [], unknown: null });
  assert.equal(report.deployments.count, 0);
  assert.equal(report.rollouts.count, 0);
  assert.deepEqual(report.updates, { succeeded: 0, failed: 0, rolledBack: 0 });
  assert.equal(report.memfault.state, 'not_configured');
  assert.deepEqual(report.restarts, []);
  assert.deepEqual(report.alerts, { known: true, count: 0, byKind: [], list: [] });
  assert.equal(report.changes.count, 0);

  const current = await w.call('GET', '/api/reports/2026-11-09', { as: w.viewer });
  assert.equal(current.body.report.complete, false);
  assert.equal(current.body.report.boards.known, true);
  assert.equal(current.body.report.boards.from, 'now');
  assert.equal(current.body.report.boards.total, 0);
});

test('a week of mixed outcomes: score, boards, versions, deployments, rollouts, Memfault, restarts, alerts and changes', async () => {
  // Start in the week, to make the changes then.
  const w = world({ startMs: FROM + 2 * DAY });
  w.fake.addThing(A);
  w.fake.addThing(B);
  const fleetOf = (things, online, versions) => ({
    boards: things.length,
    online,
    offline: things.length - online,
    bluetoothOnly: 0,
    versions,
    unknown: 0,
    things,
  });
  // The snapshot before the week knew A only; the last of the week knows both.
  await w.fake.putFleetItem({
    pk: 'HEALTH',
    sk: '2026-11-01',
    item: { day: '2026-11-01', score: 90, parts: {}, fleet: fleetOf([A], 1, { '1.14.0+0': 1 }) },
  });
  await w.fake.putFleetItem({ pk: 'HEALTH', sk: '2026-11-03', item: { day: '2026-11-03', score: 88, parts: {} } });
  await w.fake.putFleetItem({
    pk: 'HEALTH',
    sk: '2026-11-08',
    item: { day: '2026-11-08', score: 75, parts: {}, fleet: fleetOf([A, B], 1, { '1.15.0+0': 1, '1.14.0+0': 1 }) },
  });
  // A deployment of the week, one board kept it and one failed.
  const job = 'cranium-1-15-0-b0-20261104T150000Z-ab12';
  const created = await w.fake.createJob({
    jobId: job,
    things: [A, B],
    document: '{}',
    description: 'deployment',
    urlExpiresInSec: 3600,
    inProgressTimeoutMinutes: 60,
  });
  assert.equal(created.ok, true);
  w.advance(HOUR);
  assert.equal(w.fake.execution(job, A).update('SUCCEEDED').accepted, true);
  assert.equal(w.fake.execution(job, B).update('FAILED').accepted, true);
  // Rollouts: one stopped by the health gate, one rollback done.
  const rollout = (id, stage, extra) =>
    w.fake.putFleetItem({
      pk: 'ROL',
      sk: id,
      item: {
        id,
        version: '1.15.0+0',
        board: 'nrf7002dk',
        purpose: 'deploy',
        createdAt: iso(FROM + 3 * DAY),
        things: [A, B],
        stage,
        ...extra,
      },
    });
  await rollout('rol-20261105T150000Z-aaaaaa', 'stopped', {
    stopped: {
      code: 'health_failed',
      text: 'The health gate found a new Memfault issue',
      at: iso(FROM + 3 * DAY + HOUR),
    },
    healthGate: { minutes: 10 },
  });
  await rollout('rol-20261105T160000Z-bbbbbb', 'done', {
    purpose: 'rollback',
    finishedAt: iso(FROM + 3 * DAY + 2 * HOUR),
  });
  // The boards' own restarts, and an update that rolled back.
  const event = (thing, at, fields) =>
    w.fake.putEventItem({ pk: thing, sk: eventKey(at, 'a1b2c3'), level: 'warn', ...fields });
  event(A, FROM + DAY, {
    kind: 'restart',
    what: 'restarted',
    text: 'Restarted after 2 h up. The watchdog',
    cause: '10',
  });
  event(B, FROM + 2 * DAY, {
    kind: 'restart',
    what: 'restarted',
    text: 'Restarted after 1 h up. The watchdog',
    cause: '11',
  });
  event(B, FROM + 3 * DAY, {
    kind: 'restart',
    what: 'stuck',
    text: 'Restarted itself for being stuck',
    count: 1,
    reason: 1,
  });
  event(A, FROM - DAY, { kind: 'restart', what: 'restarted', text: 'Restarted before the week', cause: '4' });
  // An alert sent in the week.
  await w.fake.alertStore().putSentAlert({
    pk: 'ALERTS',
    sk: `S#${iso(FROM + DAY)}#${B}#offline`,
    kind: 'offline',
    subject: 'Cranium: offline',
    count: 1,
  });
  // Memfault: an issue first seen in the week, one before; an unexpected and an expected reboot.
  const reboot = (serial, at, reason) => ({
    created_date: at,
    device_serial: serial,
    software_version: '1.15.0+0',
    event_type: 'ReceivedDataRebootEvent',
    level: 'info',
    source: 'trace',
    event_data: { received_event: { captured_date: at, event_info: { reason, coredump_saved: false } } },
  });
  w.fake.useMemfault({
    async memfaultGet(path) {
      if (path === 'issues') {
        return {
          data: [
            { id: 21, title: 'Hard fault in wifi', trace_count: 3, device_count: 2, first_seen: iso(FROM + 2 * DAY) },
            { id: 20, title: 'Old one', trace_count: 1, device_count: 1, first_seen: iso(FROM - 3 * DAY) },
          ],
        };
      }
      if (path === 'processing-log') {
        return { data: [reboot(A, iso(FROM + DAY), 0x8008), reboot(B, iso(FROM + DAY), 3)] };
      }
      return { data: [] };
    },
  });
  // Changes on record: a release manager switches the e-mail on, a viewer exports.
  assert.equal((await w.call('POST', '/api/reports/settings', { as: w.manager, body: { email: true } })).status, 200);
  w.advance(5 * DAY); // Wednesday the week after
  const { status, body } = await w.call('GET', `/api/reports/${WEEK}`, { as: w.viewer });
  assert.equal(status, 200, JSON.stringify(body));
  const { report } = body;
  assert.deepEqual(
    report.health.days.map((day) => day.score),
    [null, 88, null, null, null, null, 75]
  );
  assert.equal(report.health.previous, 90);
  assert.equal(report.health.change, -15);
  assert.equal(report.health.lowest, 75);
  assert.deepEqual(
    [report.boards.known, report.boards.from, report.boards.total, report.boards.online, report.boards.offline],
    [true, 'snapshot', 2, 1, 1]
  );
  assert.deepEqual(report.boards.added, [B]);
  assert.deepEqual(report.versions.list, [
    { version: '1.15.0+0', count: 1 },
    { version: '1.14.0+0', count: 1 },
  ]);
  assert.equal(report.deployments.count, 1);
  assert.equal(report.deployments.list[0].outcome, 'partial');
  assert.deepEqual([report.deployments.list[0].succeeded, report.deployments.list[0].failed], [1, 1]);
  assert.equal(report.rollouts.count, 2);
  assert.equal(report.rollouts.gateStops, 1);
  assert.equal(report.rollouts.rollbacks, 1);
  assert.equal(report.memfault.state, 'ok');
  assert.deepEqual(
    report.memfault.newIssues.map((one) => one.id),
    [21]
  );
  assert.equal(report.memfault.reboots.length, 1, 'the expected reboot is left out');
  assert.equal(report.memfault.reboots[0].count, 1);
  assert.deepEqual(
    report.restarts.map((one) => [one.reason, one.count, one.boards]),
    [
      ['watchdog', 2, [A, B]],
      ['stuck', 1, [B]],
    ]
  );
  assert.equal(report.restarts[0].label, 'The watchdog');
  assert.equal(report.alerts.count, 1);
  assert.deepEqual(report.alerts.byKind, [{ kind: 'offline', count: 1 }]);
  assert.deepEqual(report.changes.byAction, [{ action: 'report.settings', count: 1 }]);
});

test('a report is kept: read again only after a while, and a settled week is stored and read from the table', async () => {
  const w = world();
  const audits = () => w.fake.methodsCalled().filter((name) => name === 'searchAudit').length;
  await w.call('GET', '/api/reports/2026-11-09', { as: w.viewer });
  await w.call('GET', '/api/reports/2026-11-09', { as: w.manager });
  assert.equal(audits(), 1, 'the second read came from memory');
  w.advance(CURRENT_MS);
  await w.call('GET', '/api/reports/2026-11-09', { as: w.viewer });
  assert.equal(audits(), 2, 'a week under way is made again after CURRENT_MS');

  // The week before has been over for more than SETTLE_MS: stored once, on the condition that keeps the first.
  assert.ok(NOW > weekSpan(WEEK).toMs + SETTLE_MS);
  await w.call('GET', `/api/reports/${WEEK}`, { as: w.viewer });
  const stored = await w.fake.getFleetItem({ pk: REPORTS_PK, sk: `week#${WEEK}` });
  assert.equal(stored.report.week, WEEK);
  // Another instance of the function reads it from the table rather than making it again.
  stored.report.changes.count = 99;
  await w.fake.putFleetItem({ pk: REPORTS_PK, sk: `week#${WEEK}`, item: stored, replace: true });
  const other = world();
  other.fake.putFleetItem({ pk: REPORTS_PK, sk: `week#${WEEK}`, item: stored });
  const before = other.fake.methodsCalled().filter((name) => name === 'searchAudit').length;
  const again = await other.call('GET', `/api/reports/${WEEK}`, { as: other.viewer });
  assert.equal(again.body.report.changes.count, 99);
  assert.equal(other.fake.methodsCalled().filter((name) => name === 'searchAudit').length, before);
});

test('the CSV export: one file of the main tables, on record for any member, and only as CSV', async () => {
  const w = world();
  const { status, body } = await w.call('GET', `/api/reports/${WEEK}/export`, {
    as: w.viewer,
    query: { format: 'csv' },
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.name, `cranium-report-${WEEK}.csv`);
  assert.equal(body.type, 'text/csv');
  const lines = body.content.trimEnd().split('\r\n');
  assert.equal(lines[0], 'section,item,value,detail,at');
  assert.equal(lines[1], 'week,from,2026-11-02T05:00:00.000Z,America/New_York,');
  assert.ok(lines.some((line) => line.startsWith('health,2026-11-08,')));
  assert.ok(lines.some((line) => line.startsWith('boards,total,,not recorded')));
  assert.equal(body.rows, lines.length - 1);
  const entry = w.fake.auditLog().at(-1);
  assert.equal(entry.action, 'report.export');
  assert.equal(entry.target, WEEK);
  assert.equal(entry.outcome, 'ok');
  assert.equal(entry.actor.email, w.viewer.email);
  assert.equal(entry.detail.format, 'csv');

  const json = await w.call('GET', `/api/reports/${WEEK}/export`, { as: w.viewer, query: { format: 'json' } });
  assert.equal(json.status, 400);
  assert.equal(json.body.error.code, 'invalid_report_format');
  assert.equal(w.fake.auditLog().at(-1).outcome, 'rejected');
  const tuesday = await w.call('GET', '/api/reports/2026-11-03/export', { as: w.viewer });
  assert.equal(tuesday.body.error.code, 'invalid_week');
});

test('a cell that looks like a formula is quoted so that a spreadsheet does not run it', () => {
  const report = buildReport({
    span: weekSpan(WEEK),
    nowMs: NOW,
    snapshots: [],
    end: null,
    before: null,
    registered: [],
    deployments: [],
    rollouts: [],
    updates: {},
    events: [],
    memfault: {
      state: 'ok',
      issues: [{ id: 5, title: '=HYPERLINK("x")', firstSeen: iso(FROM + HOUR), boards: 1, traces: 1 }],
      reboots: [],
    },
    sent: [],
    audit: [],
  });
  assert.match(reportCsv(report), /memfault issues,#5,1,"'=HYPERLINK\(""x""\)"/);
});

test('the e-mail setting: off until a release manager switches it on, on record with what changed', async () => {
  const w = world();
  const listed = await w.call('GET', '/api/reports', { as: w.viewer });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.settings, { email: false, updatedAt: null, updatedBy: null });
  assert.equal(listed.body.canChange, false);
  assert.equal(listed.body.zone, 'America/New_York');
  assert.equal(listed.body.weeks.length, 12);
  assert.equal(listed.body.weeks[0].week, '2026-11-09');
  assert.equal(listed.body.weeks[0].complete, false);
  assert.equal(listed.body.weeks[1].complete, true);

  const refused = await w.call('POST', '/api/reports/settings', { as: w.viewer, body: { email: true } });
  assert.equal(refused.status, 403);
  assert.equal(w.fake.auditLog().at(-1).action, 'report.settings');
  assert.equal(w.fake.auditLog().at(-1).outcome, 'denied');

  for (const body of [{}, { email: 'yes' }, { email: true, other: 1 }]) {
    const bad = await w.call('POST', '/api/reports/settings', { as: w.manager, body });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'invalid_report_settings');
  }

  const on = await w.call('POST', '/api/reports/settings', { as: w.manager, body: { email: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.settings.email, true);
  assert.equal(on.body.settings.updatedBy, w.manager.email);
  const entry = w.fake.auditLog().at(-1);
  assert.equal(entry.outcome, 'ok');
  assert.equal(entry.detail.email, 'on');
  assert.deepEqual(entry.changes, [{ field: 'report_email', from: 'off', to: 'on' }]);
  const off = await w.call('POST', '/api/reports/settings', { as: w.manager, body: { email: false } });
  assert.equal(off.body.settings.email, false);
  assert.deepEqual(w.fake.auditLog().at(-1).changes, [{ field: 'report_email', from: 'on', to: 'off' }]);
  const manager = await w.call('GET', '/api/reports', { as: w.manager });
  assert.equal(manager.body.canChange, true);
  assert.equal(manager.body.settings.email, false);
});

test('two changes of the setting at once: the second is refused', async () => {
  const w = world();
  await w.call('POST', '/api/reports/settings', { as: w.manager, body: { email: true } });
  const real = w.fake.updateFleetItem;
  w.fake.updateFleetItem = async () => ({ ok: false, reason: 'changed' });
  const raced = await w.call('POST', '/api/reports/settings', { as: w.manager, body: { email: false } });
  w.fake.updateFleetItem = real;
  assert.equal(raced.status, 409);
  assert.equal(raced.body.error.code, 'report_settings_changed');
});

test('viewers read every report and its CSV; nobody outside the console does', async () => {
  const w = world();
  const stranger = w.addUser('stranger', []);
  for (const path of ['/api/reports', `/api/reports/${WEEK}`]) {
    assert.equal((await w.call('GET', path, { as: w.viewer })).status, 200, path);
    assert.equal((await w.call('GET', path, { as: stranger })).status, 403, path);
  }
  assert.equal((await w.call('GET', '/api/reports/2026-11-16', { as: w.viewer })).status, 404);
});

test('the schedule sends the Monday e-mail once, only while it is switched on', async () => {
  // Monday 9 November, 07:30 in New York.
  const w = world({ startMs: Date.UTC(2026, 10, 9, 12, 30) });
  const mails = [];
  const tick = createRolloutTick({
    aws: w.fake,
    config: w.config,
    now: () => w.clock.ms,
    log: () => {},
    alerts: {
      raise: async () => 0,
      publish: async (mail) => {
        mails.push(mail);
        return true;
      },
    },
  });
  await tick();
  w.advance(HOUR); // 08:30, but switched off
  await tick();
  assert.equal(mails.length, 0);
  await w.call('POST', '/api/reports/settings', { as: w.manager, body: { email: true } });
  await tick();
  await tick();
  assert.equal(mails.length, 1, 'once');
  assert.equal(mails[0].subject, `Cranium: weekly fleet report, week of ${WEEK}`);
  assert.match(mails[0].message, new RegExp(`${w.config.consoleUrl}/#/reports/${WEEK}`));
  assert.ok(await w.fake.getFleetItem({ pk: REPORTS_PK, sk: `mail#${WEEK}` }));
  w.advance(DAY); // Tuesday: nothing more
  await tick();
  assert.equal(mails.length, 1);
});
