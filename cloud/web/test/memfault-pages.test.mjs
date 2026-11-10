/**
 * Tests for what the console shows of Memfault (docs/memfault.md, "In the console"): the Memfault page's
 * issues, an issue's page with its backtraces, and the Memfault section of a board's page with its reboots
 * and their reasons (memfault-page.js), the routes to them and the client's one way to ask for them
 * (core.js). The scripts are the very files the browser loads, drawing into the stand-in document of page.mjs.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE, MEMFAULT, VIEWS, all, createDocument, one, textOf } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
const memfault = await import(MEMFAULT);
globalThis.document = createDocument();

const NOW = Date.parse('2026-11-09T18:00:00Z');
const A = 'cranium-00000000000000aa';
const OK = { state: 'ok', message: '' };
const loaded = (value) => ({ value, error: null, loadedAt: NOW, loading: false });

const ISSUE = {
  id: 11,
  title: 'Kernel panic at crash_demo_on_tick',
  status: 'open',
  traces: 2,
  boards: 1,
  firstSeen: '2026-11-09T16:01:28.000Z',
  lastSeen: '2026-11-09T16:01:28.000Z',
  firstVersion: '1.14.0+1',
  lastVersion: '1.14.0+1',
};

const TRACE = {
  id: 101,
  title: 'Kernel panic at crash_demo_on_tick',
  reason: 'KernelPanic',
  capturedAt: '2026-11-09T16:01:27.000Z',
  serial: A,
  thing: A,
  version: '1.14.0+1',
  threads: [
    {
      id: 1,
      name: 'main',
      crashed: true,
      current: true,
      state: 'running',
      frames: [
        { index: 0, function: 'crash_demo_on_tick', file: 'src/mflt.c', line: 301, address: '0x0003c074' },
        { index: 1, function: 'z_work_q_main', file: 'kernel/work.c', line: 640, address: '0x00039599' },
      ],
      registers: [{ name: 'pc', value: '0x0003c074' }],
    },
  ],
};

function draw(node) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  views.render(root, node);
  return root;
}

function ctx(route, memfaultState) {
  return { state: { now: NOW, route, me: { canWrite: false }, memfault: memfaultState }, actions: {} };
}

function tools() {
  return {
    issues: loaded(null),
    issue: new Map(),
    boards: new Map(),
  };
}

test('the Memfault page and an issue have addresses of their own, and nothing else does', () => {
  assert.deepEqual(core.parseRoute('#/memfault'), { view: 'memfault' });
  assert.deepEqual(core.parseRoute('#/memfault/11'), { view: 'issue', id: '11' });
  for (const hash of ['#/memfault/0', '#/memfault/abc', '#/memfault/1-2', `#/memfault/${'1'.repeat(17)}`]) {
    assert.equal(core.parseRoute(hash), null, hash);
  }
  assert.equal(core.routeHash({ view: 'issue', id: '11' }), '#/memfault/11');
  assert.equal(core.routeHash({ view: 'issue', id: '../x' }), '#/overview');
  assert.equal(memfault.issueHref(11), '#/memfault/11');
  assert.equal(memfault.issueHref('javascript:x'), null);
});

test('the client asks only for the Memfault routes, and only with GET', async () => {
  const asked = [];
  const api = core.createApi({
    auth: { accessToken: () => 'TOKEN' },
    crypto: globalThis.crypto,
    clock: core.createClock(),
    onUnauthorized: () => {},
    pause: async () => {},
    fetch: async (url, init) => {
      asked.push([init?.method ?? 'GET', String(url)]);
      return Response.json({ memfault: OK, issues: [] });
    },
  });
  await api.memfaultRequest('/api/memfault/issues');
  await api.memfaultRequest('/api/memfault/issues/11');
  await api.memfaultRequest(`/api/devices/${A}/memfault?hours=168`);
  assert.deepEqual(
    asked.map(([method, url]) => [method, url]),
    [
      ['GET', '/api/memfault/issues'],
      ['GET', '/api/memfault/issues/11'],
      ['GET', `/api/devices/${A}/memfault?hours=168`],
    ]
  );
  for (const path of [
    '/api/firmware',
    '/api/memfault/issues/../x',
    'https://api.memfault.com/api/v0/x',
    '/api/devices/x/memfault',
  ]) {
    await assert.rejects(api.memfaultRequest(path), /not a request of the Memfault pages/, path);
  }
});

test('what the server says is checked before it is drawn: a field of another type is left out', () => {
  const read = memfault.readIssues({
    memfault: { state: 'nonsense', message: 7 },
    issues: [ISSUE, { id: 'x' }, null, { id: 0 }, { ...ISSUE, id: 12, title: { html: '<b>' } }],
  });
  assert.equal(read.memfault.state, 'unreachable');
  assert.deepEqual(
    read.issues.map((item) => [item.id, item.title]),
    [
      [11, ISSUE.title],
      [12, 'Untitled issue'],
    ]
  );
  const board = memfault.readBoard({
    memfault: OK,
    known: true,
    reboots: [
      { at: '2026-11-09T16:06:49.759Z', reason: { name: 'FirmwareUpdate', expected: true, code: 3 } },
      { at: 'never' },
    ],
    events: [{ at: '2026-11-09T16:06:54.000Z', name: 'update_succeeded', detail: '1.15.0+0' }, { name: 'x' }],
  });
  assert.equal(board.reboots.length, 1);
  assert.equal(board.events.length, 1);
});

test('the Memfault page lists the issues, each a link to its own page', () => {
  const state = tools();
  state.issues = loaded({ memfault: OK, issues: [ISSUE] });
  const root = draw(memfault.memfaultView(ctx({ view: 'memfault' }, state)));
  const link = one(root, 'a', ISSUE.title);
  assert.equal(link.getAttribute('href'), '#/memfault/11');
  assert.match(textOf(root), /2 traces on 1 board/);
  assert.match(textOf(root), /1\.14\.0\+1/);
});

test('when Memfault cannot be read the page says why, in the words of the server', () => {
  const state = tools();
  const words = 'Memfault could not be reached just now. Its data is safe there; this page tries again in a minute.';
  state.issues = loaded({ memfault: { state: 'unreachable', message: words }, issues: [] });
  const root = draw(memfault.memfaultView(ctx({ view: 'memfault' }, state)));
  assert.ok(textOf(root).includes(words));
  // Not a tick: nothing was read, so nothing is known to be well.
  assert.match(textOf(root), /No issues could be read\./);
  assert.doesNotMatch(textOf(root), /No issues to show|No issues\./);
});

test('when Memfault is not connected the page says so plainly, with how to connect it under Details', () => {
  const state = tools();
  const words =
    'The console has no Memfault token yet, so it cannot show what Memfault knows. Store one with cloud/deploy.sh.';
  state.issues = loaded({ memfault: { state: 'not_configured', message: words }, issues: [] });
  const root = draw(memfault.memfaultView(ctx({ view: 'memfault' }, state)));
  assert.match(textOf(root), /Memfault is not connected\./);
  assert.match(textOf(root), /Crashes and traces show here once the console is connected to Memfault\./);
  assert.doesNotMatch(textOf(root), /No issues/);
  // The server's words, which name the script, are behind Details and not in a warning above the page.
  const details = one(root, 'details.memfault-connect');
  assert.ok(textOf(details).includes(words));
  assert.equal(all(root, '.page-notice').length, 0);
  // No fleet from Memfault either, which would say "no reboots" of a fleet nobody read.
  assert.doesNotMatch(textOf(root), /No board reported a reboot/);
});

test("an issue's page shows each trace's board, version and the crashed thread's backtrace and registers", () => {
  const state = tools();
  state.issue.set('11', loaded({ memfault: OK, issue: ISSUE, traces: [TRACE], boards: [A] }));
  const root = draw(memfault.issueView(ctx({ view: 'issue', id: '11' }, state)));
  const text = textOf(root);
  assert.match(text, /Kernel panic at crash_demo_on_tick/);
  assert.match(text, /first on 1\.14\.0\+1/);
  assert.equal(one(root, 'a', A).getAttribute('href'), `#/devices/${A}`);
  const frames = all(one(root, 'ol.backtrace'), 'li').map((item) => textOf(item));
  assert.equal(frames.length, 2);
  assert.match(frames[0], /crash_demo_on_tick.*src\/mflt\.c:301/);
  assert.match(textOf(one(root, 'table.registers')), /pc.*0x0003c074/);
  assert.equal(one(root, 'details.thread').getAttribute('open'), '');
  assert.equal(one(root, 'a', 'Memfault').getAttribute('href'), '#/memfault');
});

test("a board's page shows its reboots with their reasons, its events and its issues", () => {
  const state = tools();
  state.boards.set(
    A,
    loaded({
      memfault: OK,
      known: true,
      reboots: [
        {
          at: '2026-11-09T16:06:49.759Z',
          reason: { name: 'FirmwareUpdate', expected: true, code: 3 },
          version: '1.15.0+0',
        },
        {
          at: '2026-11-09T16:01:28.151Z',
          reason: { name: 'KernelPanic', expected: false, code: 32776 },
          version: '1.14.0+1',
        },
      ],
      events: [{ at: '2026-11-09T16:06:54.000Z', name: 'update_succeeded', detail: '1.15.0+0' }],
      issues: [ISSUE],
    })
  );
  const root = draw(memfault.boardSection(A, ctx({ view: 'device', thing: A }, state)));
  const reboots = all(root, 'ul.rows')[0];
  assert.deepEqual(
    all(reboots, 'li').map((item) => textOf(one(item, '.badge'))),
    ['FirmwareUpdate', 'KernelPanic']
  );
  assert.ok(one(reboots, '.badge.is-bad', 'KernelPanic'));
  assert.match(textOf(root), /update_succeeded/);
  assert.equal(one(root, 'a', ISSUE.title).getAttribute('href'), '#/memfault/11');

  // Not read yet: nothing is drawn; a board Memfault never heard of says so.
  assert.equal(memfault.boardSection('cranium-00000000000000bb', ctx({ view: 'device' }, state)), null);
  state.boards.set(A, loaded({ memfault: OK, known: false, reboots: [], events: [], issues: [] }));
  const silent = draw(memfault.boardSection(A, ctx({ view: 'device', thing: A }, state)));
  assert.match(textOf(silent), /Memfault has not heard from this board yet\./);
  assert.match(textOf(silent), /No reboot reported\./);
});

test('Memfault is in the sections, and an issue belongs to it', () => {
  const nav = draw(views.navView({ state: { route: { view: 'issue', id: '11' } } }));
  const link = one(nav, 'a', 'Memfault');
  assert.equal(link.getAttribute('href'), '#/memfault');
  assert.equal(link.getAttribute('aria-current'), 'page');
});

// Memfault part 2 (console 2.11.0): the fleet on the Memfault page, and a board's metric charts.

const B = 'cranium-00000000000000bb';
const FLEET = {
  memfault: OK,
  hours: 168,
  devices: [
    { serial: A, thing: A, software: '1.15.0+0', lastSeen: '2026-11-09T17:00:00Z', registered: true },
    { serial: B, thing: B, software: '1.15.0+0', registered: true },
    { serial: 'bench-1', thing: null, software: '1.14.0+1', registered: false },
    { serial: 7 },
  ],
  releases: [
    { version: '1.15.0+0', createdAt: '2026-11-08T12:00:00Z', symbols: true },
    { version: '1.14.0+1', createdAt: '2026-11-01T12:00:00Z', symbols: false },
  ],
  reboots: {
    byReason: [
      { reason: { name: 'FirmwareUpdate', expected: true, code: 3 }, count: 3, boards: [A, B] },
      { reason: { name: 'KernelPanic', expected: false, code: 32776 }, count: 1, boards: [A] },
      { reason: { name: 'Nothing', expected: false }, count: 0, boards: [] },
    ],
    recent: [],
  },
  metrics: {
    keys: ['cpu_usage_pct', 'supply_mv', 'wifi_sta_rssi'],
    boards: [
      {
        serial: A,
        thing: A,
        at: '2026-11-09T17:00:00Z',
        values: {
          power_usb_present: { v: 1, at: '2026-11-09T17:00:00Z' },
          supply_mv: { v: 3297, at: '2026-11-09T17:00:00Z' },
          wifi_sta_rssi: { v: -58, at: '2026-11-09T17:00:00Z' },
          cpu_usage_pct: { v: 1234, at: '2026-11-09T17:00:00Z' },
          bogus: { v: 'x' },
        },
        unnamed: 0,
      },
      { serial: 'bench-1', thing: null, at: '2026-11-09T16:00:00Z', values: {}, unnamed: 2 },
    ],
  },
};

test('the client may read the fleet too, and nothing else new', async () => {
  const asked = [];
  const api = core.createApi({
    auth: { accessToken: () => 'TOKEN' },
    crypto: globalThis.crypto,
    clock: core.createClock(),
    onUnauthorized: () => {},
    pause: async () => {},
    fetch: async (url, init) => {
      asked.push([init?.method ?? 'GET', String(url)]);
      return Response.json(FLEET);
    },
  });
  await api.memfaultRequest('/api/memfault/fleet');
  assert.deepEqual(asked, [['GET', '/api/memfault/fleet']]);
  for (const path of ['/api/memfault/fleet/x', '/api/memfault/fleets', '/api/memfault/fleet?hours=1']) {
    await assert.rejects(api.memfaultRequest(path), /not a request of the Memfault pages/, path);
  }
});

test("the fleet's answer is checked before it is drawn", () => {
  const read = memfault.readFleet(FLEET);
  assert.equal(read.devices.length, 3);
  assert.deepEqual(
    read.reboots.map((item) => [item.reason.name, item.count, item.boards]),
    [
      ['FirmwareUpdate', 3, 2],
      ['KernelPanic', 1, 1],
    ]
  );
  assert.deepEqual(Object.keys(read.boards[0].values).sort(), [
    'cpu_usage_pct',
    'power_usb_present',
    'supply_mv',
    'wifi_sta_rssi',
  ]);
  assert.deepEqual(memfault.readFleet(null).boards, []);
  assert.deepEqual(
    memfault.versionsOf(read).map((item) => [item.version, item.boards, item.symbols]),
    [
      ['1.15.0+0', 2, true],
      ['1.14.0+1', 1, false],
    ]
  );
});

test("the Memfault page shows the reboots by reason, the versions and each board's latest metrics", () => {
  const state = tools();
  state.issues = loaded({ memfault: OK, issues: [] });
  state.fleet = loaded(memfault.readFleet(FLEET));
  const root = draw(memfault.memfaultView(ctx({ view: 'memfault' }, state)));
  assert.match(textOf(root), /4 reboots, 1 unexpected\./);
  const reasons = all(root, 'li.reason-row');
  assert.equal(reasons.length, 2);
  assert.ok(one(reasons[1], '.badge.is-bad', 'KernelPanic'));
  assert.match(textOf(reasons[1]), /unexpected/);
  assert.doesNotMatch(textOf(reasons[0]), /unexpected/);
  assert.equal(one(reasons[0], '.meter').getAttribute('aria-valuenow'), '75');
  const versions = all(root, 'li.version-row').map((item) => textOf(item));
  assert.match(versions[0], /1\.15\.0\+0.*Symbols uploaded.*2 boards/);
  assert.match(versions[1], /1\.14\.0\+1.*No symbols.*1 board/);
  const rows = all(root, 'li.metric-row');
  assert.equal(one(rows[0], 'a', A).getAttribute('href'), `#/devices/${A}`);
  assert.match(textOf(rows[0]), /USB power.*On USB.*Supply voltage.*3\.30 V.*Wi-Fi signal.*−58 dBm.*CPU use.*12\.3 %/);
  assert.match(textOf(rows[1]), /lacks the symbols/);

  // While the fleet is read, the issues stand alone and the page says what it is reading.
  state.fleet = { value: null, error: null, loadedAt: 0, loading: true };
  assert.match(textOf(draw(memfault.memfaultView(ctx({ view: 'memfault' }, state)))), /the fleet/i);
});

const hoursAgo = (hours) => new Date(NOW - hours * 3_600_000).toISOString();

function boardWithSeries(series, unnamed = 0) {
  return loaded(
    memfault.readBoard({
      memfault: OK,
      known: true,
      reboots: [],
      events: [],
      issues: [],
      to: new Date(NOW).toISOString(),
      metrics: { keys: Object.keys(series), series, unnamed },
    })
  );
}

test("a board's page charts each metric of its heartbeats, grouped and named, over 24 h or 7 d", () => {
  const state = tools();
  state.boards.set(
    A,
    boardWithSeries({
      supply_mv: [
        { at: hoursAgo(100), v: 3250 },
        { at: hoursAgo(2), v: 3297 },
        { at: hoursAgo(1), v: 3301 },
      ],
      power_usb_present: [{ at: hoursAgo(1), v: 1 }],
      cpu_usage_pct: [{ at: hoursAgo(1), v: 1250 }],
      memory_sysworkq_pct_max: [{ at: hoursAgo(1), v: 4100 }],
      wifi_sta_rssi: [{ at: hoursAgo(1), v: -61 }],
      stuck_restart_count: [{ at: hoursAgo(1), v: 0 }],
      some_new_key: [{ at: hoursAgo(1), v: 7 }],
      'bad key!': [{ at: hoursAgo(1), v: 1 }],
      boot_time_ms: [{ at: 'never', v: 1 }],
    })
  );
  const root = draw(memfault.metricsSection(A, ctx({ view: 'device', thing: A }, state)));
  assert.deepEqual(
    all(root, 'h3.card-sub').map((item) => textOf(item)),
    ['Power', 'Wi-Fi', 'CPU', 'Memory and stacks', 'Restarts and boot', 'Other metrics']
  );
  assert.deepEqual(
    all(root, '.chart-title').map((item) => textOf(item)),
    [
      'USB power',
      'Supply voltage',
      'Wi-Fi signal',
      'CPU use',
      'System work queue stack, highest use',
      'Stuck restarts in a row',
      'some_new_key',
    ]
  );
  // The last 24 hours: the reading of 100 hours ago is left out.
  const text = textOf(root);
  assert.match(text, /Now 3\.30 V · lowest 3\.30 V · highest 3\.30 V/);
  assert.match(text, /Now 12\.5 %/);
  assert.match(text, /Now 41 %/);
  assert.match(text, /Now On USB/);
  assert.equal(one(root, 'button', '24 h').getAttribute('aria-pressed'), 'true');

  state.range = '7d';
  const week = draw(memfault.metricsSection(A, ctx({ view: 'device', thing: A }, state)));
  assert.match(textOf(week), /Now 3\.30 V · lowest 3\.25 V · highest 3\.30 V/);
  assert.equal(one(week, 'button', '7 d').getAttribute('aria-pressed'), 'true');
});

test("a board's metrics say when there are none, and leave Memfault's state to the other card", () => {
  const state = tools();
  state.boards.set(A, boardWithSeries({}, 3));
  const root = draw(memfault.metricsSection(A, ctx({ view: 'device', thing: A }, state)));
  assert.match(textOf(root), /No heartbeat with metrics in the last 7 days\./);
  assert.match(textOf(root), /3 heartbeats of the week came without names/);
  state.boards.set(A, loaded({ memfault: { state: 'unreachable', message: 'x' }, known: false, metrics: {} }));
  assert.equal(memfault.metricsSection(A, ctx({ view: 'device', thing: A }, state)), null);
  assert.equal(memfault.metricsSection(B, ctx({ view: 'device' }, state)), null);
});

test('a chart scale is on whole steps, from 0 unless told not to, and values are in their unit', () => {
  assert.deepEqual(memfault.niceScale([3, 9]), { yMin: 0, yMax: 10, yTicks: [0, 2.5, 5, 7.5, 10] });
  const volts = memfault.niceScale([3.25, 3.3], { zero: false });
  assert.ok(volts.yMin <= 3.25 && volts.yMax >= 3.3 && volts.yTicks.length <= 6, JSON.stringify(volts));
  assert.deepEqual(memfault.niceScale([0, 0]), { yMin: 0, yMax: 1, yTicks: [0, 0.25, 0.5, 0.75, 1] });
  assert.equal(memfault.metricText('Heap_BytesFree', 40_960), '40 KiB');
  assert.equal(memfault.metricText('unknown_thing', 1.5), '1.5');
  assert.equal(memfault.metricOf('unknown_thing').group, 'other');
});
