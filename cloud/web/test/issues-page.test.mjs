/**
 * Tests for our own issues in the console (docs/own-observability.md): the Issues page and an issue's page
 * (issues-page.js), their addresses under Memfault (core.js, views.js), the client's one way to ask for them,
 * and the link from the Memfault page. The scripts are the very files the browser loads, drawing into the
 * stand-in document of page.mjs.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE, ISSUES, MEMFAULT, VIEWS, all, createDocument, one, textOf } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
const issues = await import(ISSUES);
const memfault = await import(MEMFAULT);
globalThis.document = createDocument();

const NOW = Date.parse('2026-11-12T18:00:00Z');
const A = 'cranium-00000000000000aa';
const B = 'cranium-00000000000000bb';
const ID = '0123456789ab';
const loaded = (value) => ({ value, error: null, loadedAt: NOW, loading: false });

const ISSUE = {
  id: ID,
  signature: 'reset:watchdog',
  type: 'reset',
  title: 'Reset by the watchdog',
  count: 3,
  boards: 2,
  versions: ['1.13.0+0', '1.15.0+0'],
  firstSeen: '2026-11-02T10:00:00.000Z',
  lastSeen: '2026-11-12T09:00:00.000Z',
  firstVersion: '1.13.0+0',
  lastVersion: '1.15.0+0',
  status: 'regressed',
  fixedIn: '1.14.0+0',
  regressedIn: '1.15.0+0',
  regressed: true,
};
const FIXED = {
  ...ISSUE,
  id: 'abcdefabcdef',
  signature: 'stuck:no_cloud',
  type: 'stuck',
  title: 'Stuck: no connection to the cloud for 15 minutes',
  count: 1,
  boards: 1,
  status: 'fixed',
  fixedIn: '1.15.0+0',
  regressedIn: null,
  regressed: false,
};

function draw(node) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  views.render(root, node);
  return root;
}

function ctx(route, ownIssues, filters = {}) {
  return {
    state: { now: NOW, route, me: { canWrite: false }, ownIssues, filters, devices: { value: { devices: [] } } },
    actions: { setFilter() {}, clearFilters() {}, toggleFilters() {} },
  };
}

test('the Issues page and an issue have addresses of their own, under Memfault in the sections', () => {
  assert.deepEqual(core.parseRoute('#/issues'), { view: 'issues' });
  assert.deepEqual(core.parseRoute(`#/issues/${ID}`), { view: 'own-issue', id: ID });
  for (const hash of ['#/issues/0123456789AB', '#/issues/0123', '#/issues/../x', `#/issues/${ID}0`]) {
    assert.equal(core.parseRoute(hash), null, hash);
  }
  assert.equal(core.routeHash({ view: 'own-issue', id: ID }), `#/issues/${ID}`);
  assert.equal(core.routeHash({ view: 'own-issue', id: 'javascript:x' }), '#/overview');
  assert.equal(issues.ownIssueHref(ID), `#/issues/${ID}`);
  assert.equal(issues.ownIssueHref('x'), null);
  // Memfault stays current in the sections on both pages.
  for (const route of [{ view: 'issues' }, { view: 'own-issue', id: ID }]) {
    const nav = draw(views.navView({ state: { route, me: { canWrite: false } }, actions: {} }));
    assert.equal(one(nav, 'a', 'Memfault').getAttribute('aria-current'), 'page');
  }
});

test('the client asks only for the issue routes, and only with GET', async () => {
  const asked = [];
  const api = core.createApi({
    auth: { accessToken: () => 'TOKEN' },
    crypto: globalThis.crypto,
    clock: core.createClock(),
    onUnauthorized: () => {},
    pause: async () => {},
    fetch: async (url, init) => {
      asked.push([init?.method ?? 'GET', String(url)]);
      return Response.json({ issues: [] });
    },
  });
  await api.issuesRequest('/api/issues?days=90');
  await api.issuesRequest(`/api/issues/${ID}?days=90`);
  assert.deepEqual(asked, [
    ['GET', '/api/issues?days=90'],
    ['GET', `/api/issues/${ID}?days=90`],
  ]);
  for (const path of ['/api/firmware', '/api/issues/../x', `/api/issues/${ID}?days=900`, '/api/memfault/issues']) {
    await assert.rejects(api.issuesRequest(path), /not a request of the Issues pages/, path);
  }
});

test('what the server says is checked before it is drawn', () => {
  const read = issues.readOwnIssues({
    issues: [
      ISSUE,
      { id: 'x' },
      null,
      { ...ISSUE, id: 'ffffffffffff', title: { html: '<b>' }, status: 'gone', versions: ['<b>', '1.0.0+0'] },
    ],
    days: 90,
    boards: 4,
    unread: 'x',
  });
  assert.deepEqual(
    read.issues.map((issue) => [issue.id, issue.title, issue.status]),
    [
      [ID, ISSUE.title, 'regressed'],
      ['ffffffffffff', 'Untitled issue', 'open'],
    ]
  );
  assert.deepEqual(read.issues[1].versions, ['1.0.0+0']);
  assert.equal(read.unread, 0);
  const detail = issues.readOwnIssueDetail({
    issue: {
      ...ISSUE,
      perBoard: [{ thing: A, count: 2 }, { thing: 'evil' }],
      timeline: [
        { at: 'never', thing: A },
        { at: ISSUE.lastSeen, thing: B, version: '1.15.0+0' },
      ],
    },
  });
  assert.deepEqual(
    detail.perBoard.map((board) => board.thing),
    [A]
  );
  assert.deepEqual(
    detail.timeline.map((one) => one.thing),
    [B]
  );
});

test('the Issues page lists the issues with their status, and says when there are none', () => {
  const state = {
    list: loaded(issues.readOwnIssues({ issues: [ISSUE, FIXED], days: 90, boards: 2, unread: 0 })),
    issue: new Map(),
  };
  const root = draw(issues.issuesView(ctx({ view: 'issues' }, state)));
  assert.equal(textOf(one(root, 'h1')), 'Issues');
  const rows = all(root, '.own-issue-row');
  assert.equal(rows.length, 2);
  assert.equal(one(rows[0], 'a.row-title').getAttribute('href'), `#/issues/${ID}`);
  assert.match(textOf(rows[0]), /3 times on 2 boards/);
  assert.match(textOf(rows[0]), /Regressed in 1\.15\.0\+0/);
  assert.match(textOf(rows[1]), /Fixed in 1\.15\.0\+0/);
  // The status filter keeps only what it names.
  const only = draw(issues.issuesView(ctx({ view: 'issues' }, state, { issues: { q: '', status: 'fixed' } })));
  assert.equal(all(only, '.own-issue-row').length, 1);

  const none = { list: loaded(issues.readOwnIssues({ issues: [], days: 90, boards: 2, unread: 1 })), issue: new Map() };
  const quiet = draw(issues.issuesView(ctx({ view: 'issues' }, none)));
  assert.match(textOf(quiet), /No issues\./);
  assert.match(textOf(quiet), /could not be read/);
});

test("an issue's page shows the regression, its boards and its timeline", () => {
  const detail = issues.readOwnIssueDetail({
    issue: {
      ...ISSUE,
      perBoard: [
        {
          thing: A,
          count: 2,
          firstSeen: ISSUE.firstSeen,
          lastSeen: ISSUE.lastSeen,
          versions: ['1.13.0+0', '1.15.0+0'],
        },
        { thing: B, count: 1, firstSeen: ISSUE.firstSeen, lastSeen: ISSUE.firstSeen, versions: ['1.13.0+0'] },
      ],
      timeline: [
        { at: ISSUE.lastSeen, thing: A, version: '1.15.0+0', text: 'Last boot ended by the watchdog' },
        { at: ISSUE.firstSeen, thing: B, version: '1.13.0+0', text: 'Last boot ended by the watchdog' },
      ],
      timelineCut: false,
    },
    days: 90,
    boards: 2,
  });
  const state = { list: loaded(null), issue: new Map([[ID, loaded(detail)]]) };
  const root = draw(issues.ownIssueView(ctx({ view: 'own-issue', id: ID }, state)));
  assert.match(textOf(one(root, 'h1')), /Reset by the watchdog/);
  assert.equal(one(root, 'a.back').getAttribute('href'), '#/issues');
  assert.match(textOf(root), /Fixed in 1\.14\.0\+0, and back in 1\.15\.0\+0\./);
  assert.equal(all(root, '.own-issue-board').length, 2);
  assert.equal(one(all(root, '.own-issue-board')[0], 'a').getAttribute('href'), `#/devices/${A}`);
  assert.equal(all(one(root, '.own-issue-timeline'), 'li').length, 2);
  assert.match(textOf(one(root, '.own-issue-sig')), /reset:watchdog/);

  // Not loaded yet: the page says so, with the way back.
  const waiting = draw(
    issues.ownIssueView(ctx({ view: 'own-issue', id: ID }, { list: loaded(null), issue: new Map() }))
  );
  assert.equal(one(waiting, 'a.back').getAttribute('href'), '#/issues');
});

test('the Memfault page links to our own issues, and still draws as before', () => {
  const root = draw(
    memfault.memfaultView({
      state: {
        now: NOW,
        route: { view: 'memfault' },
        me: { canWrite: false },
        filters: {},
        memfault: { issues: loaded(null), fleet: loaded(null), issue: new Map(), boards: new Map() },
      },
      actions: {},
    })
  );
  assert.equal(textOf(one(root, 'h1')), 'Memfault');
  assert.equal(one(root, 'a', 'Our own issues').getAttribute('href'), '#/issues');
});
