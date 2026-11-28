/**
 * Tests for the weekly fleet report's pages (docs/reports.md): the addresses (core.js), the client, the Reports
 * page with its weeks and the Monday e-mail, a week's page with each section, its Print and Download CSV, the
 * print stylesheet and the phone layout (app.css), the nav, and the words of the new activity log entries.
 * reports.js and views.js are the very files the browser loads.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CORE, REPORTS, VIEWS, all, click, createDocument, one, textOf } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
const reports = await import(REPORTS);
globalThis.document = createDocument();

const NOW = Date.parse('2026-11-11T15:00:00Z');
const A = 'cranium-00000000000000aa';
const B = 'cranium-00000000000000bb';
const CSS = readFileSync(new URL('../src/site/assets/app.css', import.meta.url), 'utf8');

function draw(node) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  views.render(root, node);
  return root;
}

function recorder() {
  const calls = [];
  const actions = new Proxy(
    {},
    {
      get:
        (_target, name) =>
        (...args) =>
          calls.push([name, ...args.filter((value) => !(value?.type && value.currentTarget))]),
    }
  );
  return { calls, actions };
}

const LIST = {
  zone: 'America/New_York',
  mailHour: 8,
  weeks: [
    {
      week: '2026-11-09',
      from: '2026-11-09T05:00:00.000Z',
      to: '2026-11-16T05:00:00.000Z',
      complete: false,
      score: 81,
    },
    { week: '2026-11-02', from: '2026-11-02T05:00:00.000Z', to: '2026-11-09T05:00:00.000Z', complete: true, score: 75 },
    {
      week: '2026-10-26',
      from: '2026-10-26T04:00:00.000Z',
      to: '2026-11-02T05:00:00.000Z',
      complete: true,
      score: null,
    },
    { week: 'nonsense', complete: true, score: 5 },
  ],
  settings: { email: false, updatedAt: null, updatedBy: null },
  canChange: true,
};

const REPORT = {
  week: '2026-11-02',
  zone: 'America/New_York',
  from: '2026-11-02T05:00:00.000Z',
  to: '2026-11-09T05:00:00.000Z',
  complete: true,
  health: {
    days: ['02', '03', '04', '05', '06', '07', '08'].map((day, index) => ({
      day: `2026-11-${day}`,
      score: index === 2 ? null : 90 - index * 2,
    })),
    first: 90,
    last: 78,
    lowest: 78,
    previous: 92,
    change: -14,
  },
  boards: {
    known: true,
    from: 'snapshot',
    total: 2,
    online: 1,
    offline: 1,
    bluetoothOnly: 0,
    added: [B],
    addedCount: 1,
  },
  versions: {
    known: true,
    from: 'snapshot',
    list: [
      { version: '1.15.0+0', count: 1 },
      { version: '1.14.0+0', count: 1 },
    ],
    unknown: 0,
  },
  deployments: {
    count: 1,
    outcomes: { succeeded: 0, partial: 1, failed: 0, cancelled: 0, underway: 0 },
    list: [
      {
        id: 'cranium-1-15-0-b0-20261104T150000Z-ab12',
        version: '1.15.0+0',
        createdAt: '2026-11-04T15:00:00.000Z',
        boards: 2,
        succeeded: 1,
        failed: 1,
        outcome: 'partial',
      },
    ],
  },
  rollouts: {
    count: 2,
    outcomes: { done: 1, stopped: 1, cancelled: 0, underway: 0 },
    gateStops: 1,
    rollbacks: 1,
    list: [
      {
        id: 'rol-20261105T160000Z-bbbbbb',
        version: '1.14.0+0',
        purpose: 'rollback',
        rollback: true,
        createdAt: '2026-11-05T16:00:00.000Z',
        boards: 2,
        outcome: 'done',
        gated: false,
        stopCode: null,
        stopText: null,
      },
      {
        id: 'rol-20261105T150000Z-aaaaaa',
        version: '1.15.0+0',
        purpose: 'deploy',
        rollback: false,
        createdAt: '2026-11-05T15:00:00.000Z',
        boards: 2,
        outcome: 'stopped',
        gated: true,
        stopCode: 'health_failed',
        stopText: 'The health gate found a new Memfault issue',
      },
    ],
  },
  updates: { succeeded: 3, failed: 1, rolledBack: 1 },
  memfault: {
    state: 'ok',
    message: '',
    newIssueCount: 1,
    newIssues: [{ id: 21, title: 'Hard fault in wifi', firstSeen: '2026-11-04T05:00:00.000Z', boards: 2, traces: 3 }],
    reboots: [{ reason: 'HardFault', count: 2, boards: [A] }],
  },
  restarts: [{ reason: 'watchdog', label: 'The watchdog', count: 2, boards: [A, B] }],
  alerts: { known: true, count: 1, byKind: [{ kind: 'offline', count: 1 }], list: [] },
  changes: {
    count: 3,
    people: 2,
    byAction: [
      { action: 'alert.rules', count: 2 },
      { action: 'group.create', count: 1 },
    ],
    recent: [],
  },
  generatedAt: '2026-11-11T15:00:00.000Z',
};

/** reports.js connected to stand-ins of app.js, with the API's answers given. */
function connected({ list = LIST, report = REPORT, exportReply = null, share = null, inApp = false } = {}) {
  const asked = [];
  const notes = [];
  const state = { now: NOW, route: { view: 'report', week: '2026-11-02' } };
  const api = {
    reports: async () => {
      asked.push(['reports']);
      return structuredClone(list);
    },
    report: async (week) => {
      asked.push(['report', week]);
      return { report: structuredClone(report) };
    },
    reportExport: async (week) => {
      asked.push(['export', week]);
      return (
        exportReply ?? { name: `cranium-report-${week}.csv`, type: 'text/csv', content: 'section,item\r\n', rows: 1 }
      );
    },
    setReportEmail: async (on) => {
      asked.push(['email', on]);
      return { settings: { email: on, updatedAt: '2026-11-11T15:00:00.000Z', updatedBy: 'manager@example.com' } };
    },
  };
  const load = async (target, fetcher) => {
    target.value = await fetcher();
    target.loadedAt = NOW;
  };
  let printed = 0;
  reports.connect({
    state,
    api,
    load,
    draw: () => {},
    notify: (said) => notes.push(said),
    now: () => NOW,
    inApp,
    share,
    print: () => {
      printed += 1;
    },
  });
  return { asked, notes, state, printed: () => printed };
}

// Addresses and the client.

test('a week is a Monday: its page has an address of its own, under Reports', () => {
  assert.equal(core.isReportWeek('2026-11-02'), true);
  assert.equal(core.isReportWeek('2026-11-03'), false);
  assert.equal(core.isReportWeek('2026-13-02'), false);
  assert.deepEqual(core.parseRoute('#/reports'), { view: 'reports' });
  assert.deepEqual(core.parseRoute('#/reports/2026-11-02'), { view: 'report', week: '2026-11-02' });
  assert.equal(core.parseRoute('#/reports/2026-11-03'), null);
  assert.equal(core.routeHash({ view: 'report', week: '2026-11-02' }), '#/reports/2026-11-02');
  assert.equal(core.routeHash({ view: 'reports' }), '#/reports');
});

test('the client asks for the reports, a week, its CSV once, and the e-mail setting', async () => {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push([init.method, String(url).replace(/^https:\/\/[^/]+/, ''), init.body ?? null]);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const api = core.createApi({
    base: 'https://api.test',
    auth: { accessToken: () => 'token' },
    fetch: fetchStub,
    clock: { observe() {}, now: () => NOW },
  });
  await api.reports();
  await api.report('2026-11-02');
  await api.reportExport('2026-11-02');
  await api.setReportEmail(true);
  assert.deepEqual(
    calls.map(([method, path]) => `${method} ${path}`),
    [
      'GET /api/reports',
      'GET /api/reports/2026-11-02',
      'GET /api/reports/2026-11-02/export?format=csv',
      'POST /api/reports/settings',
    ]
  );
  assert.equal(calls[3][2], '{"email":true}');
  await assert.rejects(api.report('2026-11-03'), { code: 'bad_request' });
  await assert.rejects(api.setReportEmail('yes'), { code: 'bad_request' });
});

test('what the API says is read with care: a week that is not one is left out', () => {
  const read = reports.readReportList(LIST);
  assert.deepEqual(
    read.weeks.map((week) => week.week),
    ['2026-11-09', '2026-11-02', '2026-10-26']
  );
  assert.equal(read.canChange, true);
  const report = reports.readReport({ ...REPORT, health: { days: [{ day: '2026-11-02', score: 101 }] }, boards: 'x' });
  assert.equal(report.health.days[0].score, null);
  assert.equal(report.boards.known, false);
  assert.equal(reports.readReport(null).week, null);
});

test('a week in words, across a month and a year', () => {
  assert.equal(reports.weekWords('2026-11-02'), '2 to 8 November 2026');
  assert.equal(reports.weekWords('2026-10-26'), '26 October to 1 November 2026');
  assert.equal(reports.weekWords('2025-12-29'), '29 December 2025 to 4 January 2026');
});

// The Reports page.

test('the Reports page lists the weeks, newest first, each a link to its page', async () => {
  const run = connected();
  await reports.refreshReports();
  const { actions } = recorder();
  const root = draw(reports.reportsView({ state: run.state, actions }));
  assert.equal(one(root, 'h1').textContent, 'Reports');
  const rows = all(root, '.report-week');
  assert.equal(rows.length, 3);
  assert.equal(all(rows[0], 'a')[0].getAttribute('href'), '#/reports/2026-11-09');
  assert.match(textOf(rows[0]), /9 to 15 November 2026.*Health score 81.*So far.*Under way/);
  assert.match(textOf(rows[2]), /No health score/);
});

test('the Monday e-mail: off by default, and a release manager switches it on', async () => {
  const run = connected();
  await reports.refreshReports();
  const { calls, actions } = recorder();
  let root = draw(reports.reportsView({ state: run.state, actions }));
  assert.match(textOf(one(root, '.report-email')), /Off: no e-mail of the report goes out/);
  click(one(root, 'button', 'Switch the e-mail on'));
  assert.deepEqual(calls, [['setReportEmail', true]]);
  await reports.setEmail(true);
  assert.deepEqual(run.asked.at(-1), ['email', true]);
  assert.deepEqual(run.notes, ['The Monday e-mail of the report is on.']);
  root = draw(reports.reportsView({ state: run.state, actions }));
  assert.match(textOf(one(root, '.report-email')), /On: each Monday from 08:00 \(America\/New_York\)/);
  assert.match(textOf(one(root, '.report-email')), /Last changed by manager@example.com/);
  assert.ok(one(root, 'button', 'Switch the e-mail off'));
});

test('a viewer sees the setting and no button to change it', async () => {
  const run = connected({ list: { ...LIST, canChange: false } });
  await reports.refreshReports();
  const root = draw(reports.reportsView({ state: run.state, actions: {} }));
  assert.equal(all(root, 'button').length, 0);
  assert.match(textOf(root), /A release manager switches it on or off/);
  await reports.setEmail(true);
  assert.equal(
    run.asked.some(([what]) => what === 'email'),
    false
  );
});

// A week's page.

test('a week’s page has each section: score, boards, firmware, deployments, rollouts, Memfault, alerts, changes', async () => {
  const run = connected();
  await reports.refreshReport('2026-11-02', true);
  const root = draw(reports.reportView({ state: run.state, actions: recorder().actions }));
  assert.ok(one(root, '.report-page'));
  assert.match(textOf(one(root, 'h1')), /Weekly report 2 to 8 November 2026/);
  assert.match(textOf(root), /Monday to Sunday, America\/New_York time\./);
  const text = textOf(root);
  for (const title of [
    'Fleet health score',
    'Boards and firmware',
    'Deployments and rollouts',
    'Issues and reboots',
    'Alerts and changes',
  ]) {
    assert.ok(text.includes(title), title);
  }
  // The score of each day, a dash where there was none.
  const days = all(root, '.report-day');
  assert.equal(days.length, 7);
  assert.ok(days[2].getAttribute('class').includes('is-none'));
  assert.match(textOf(days[0]), /90.*Mon/);
  assert.match(text, /Down 14.*from 92/);
  assert.match(text, /New: cranium-00000000000000bb/);
  assert.match(textOf(one(root, '.report-versions')), /1\.15\.0\+0.*1 board/);
  // Rollouts: the health gate's stop and the rollback, each with how it ended.
  const rollouts = all(one(root, 'ul.report-rollouts'), 'li');
  assert.match(textOf(rollouts[0]), /Rollback to 1\.14\.0\+0.*Done/);
  assert.match(
    textOf(rollouts[1]),
    /Rollout of 1\.15\.0\+0.*health gate.*The health gate found a new Memfault issue.*Stopped/
  );
  assert.match(textOf(one(root, '.report-deployments')), /1 of 2 boards updated.*1 failed.*Some failed/);
  assert.match(text, /3 updates kept, 1 failed, 1 rolled back by the board/);
  assert.match(textOf(one(root, '.report-issues')), /Hard fault in wifi.*#21/);
  assert.equal(all(one(root, '.report-issues'), 'a')[0].getAttribute('href'), '#/memfault/21');
  assert.match(text, /Reboots in Memfault, by reason.*HardFault/);
  assert.match(text, /The boards’ own restarts, by cause.*The watchdog/);
  assert.match(text, /1 offline/);
  assert.match(text, /Top changes.*alert\.rules.*2/);
});

test('Print and Download CSV: the print dialog, and the file through the browser or the app', async () => {
  const run = connected();
  await reports.refreshReport('2026-11-02', true);
  const { calls, actions } = recorder();
  const root = draw(reports.reportView({ state: run.state, actions }));
  const tools = one(root, '.report-tools');
  click(one(tools, 'button', 'Print or save as PDF'));
  click(one(tools, 'button', 'Download CSV'));
  assert.deepEqual(calls, [['printReport'], ['exportReport', '2026-11-02']]);
  reports.print();
  assert.equal(run.printed(), 1);

  // In an app with a share sheet, the CSV goes there, as base64.
  const shared = [];
  connected({ share: async (file) => shared.push(file) });
  await reports.exportCsv('2026-11-02');
  assert.equal(shared.length, 1);
  assert.equal(shared[0].name, 'cranium-report-2026-11-02.csv');
  assert.equal(Buffer.from(shared[0].data, 'base64').toString('utf8'), 'section,item\r\n');

  // An answer that is not a report's CSV is not saved.
  const odd = connected({ exportReply: { name: '../x.csv', content: 'x' }, share: async (file) => shared.push(file) });
  await reports.exportCsv('2026-11-02');
  assert.equal(shared.length, 1);
  const page = draw(reports.reportView({ state: odd.state, actions: {} }));
  assert.match(textOf(page), /The server’s answer could not be read/);
});

test('a week not yet read says so, and one under way says it is so far', async () => {
  const run = connected({ report: { ...REPORT, complete: false, boards: { ...REPORT.boards, from: 'now' } } });
  run.state.route = { view: 'report', week: '2026-11-09' };
  let root = draw(reports.reportView({ state: run.state, actions: {} }));
  assert.match(textOf(root), /Loading the report/);
  assert.equal(all(root, '.report-tools').length, 0);
  await reports.refreshReport('2026-11-09', true);
  root = draw(reports.reportView({ state: run.state, actions: {} }));
  assert.match(textOf(root), /The week is under way: this is so far\./);
  assert.match(textOf(root), /Now, as the week is under way\./);
});

// The print stylesheet, the phone layout and the nav.

test('the print stylesheet prints the report alone: no bars, no buttons, sections kept whole', () => {
  const print = CSS.slice(CSS.lastIndexOf('@media print'));
  assert.match(print, /body:has\(\.report-page\) \.masthead/);
  assert.match(print, /body:has\(\.report-page\) \.foot/);
  assert.match(print, /\.report-page \.report-tools/);
  assert.match(print, /display: none !important/);
  assert.match(print, /\.report-page \.card \{\s*break-inside: avoid;/);
  assert.match(print, /background: white/);
});

test('on a phone the days stay seven across; colours are the tokens, so dark mode is theirs', () => {
  const block = CSS.slice(CSS.indexOf('.report-days {'));
  assert.match(block, /grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
  assert.match(CSS, /@media \(max-width: 460px\) \{\s*\.report-days/);
  const ours = CSS.slice(CSS.indexOf('The weekly fleet report (reports.js'), CSS.lastIndexOf('@media print'));
  assert.doesNotMatch(ours, /#[0-9a-f]{3,6}\b/i, 'no colour of its own outside print');
});

test('Reports is a section of the nav for everybody, and a week is under it', () => {
  const ctx = (canWrite) => ({
    state: { route: { view: 'report', week: '2026-11-02' }, me: { canWrite } },
    actions: {},
  });
  for (const canWrite of [true, false]) {
    const root = draw(views.navView(ctx(canWrite)));
    const link = all(root, 'a').find((a) => a.getAttribute('href') === '#/reports');
    assert.ok(link, `Reports for canWrite ${canWrite}`);
    assert.equal(link.getAttribute('aria-current'), 'page');
  }
});

test('the activity log says what the report entries did, and the refusals in words', () => {
  const said = (entry) => core.describeAudit({ outcome: 'ok', detail: [], ...entry });
  assert.ok(core.CHANGE_ACTIONS.includes('report.settings'));
  assert.deepEqual(core.activityActions('reports'), ['report.export', 'report.settings']);
  const exported = said({ action: 'report.export', target: '2026-11-02' });
  assert.match(`${exported.verb} ${exported.label}`, /downloaded the weekly report of 2026-11-02/);
  for (const code of [
    'invalid_week',
    'unknown_week',
    'invalid_report_format',
    'invalid_report_settings',
    'report_settings_changed',
  ]) {
    assert.equal(typeof core.REFUSAL_WORDS[code], 'string', code);
  }
  const rows = core.describeChanges({
    action: 'report.settings',
    outcome: 'ok',
    changes: [{ field: 'report_email', from: 'off', to: 'on' }],
  }).rows;
  assert.equal(rows[0].label, 'Monday e-mail of the weekly report');
});
