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
  assert.match(textOf(root), /No issues to show\./);
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
