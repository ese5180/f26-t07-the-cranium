/**
 * Tests for our own vitals in the console (docs/own-observability.md, stage 2): the Vitals page and a board's
 * vitals (vitals-page.js), their addresses under Monitoring (core.js, views.js), the client's one way to ask for
 * them, and the range switch. The scripts are the very files the browser loads, drawing into the stand-in
 * document of page.mjs.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE, VIEWS, VITALS, all, click, createDocument, one, textOf } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
const vitals = await import(VITALS);
globalThis.document = createDocument();

const NOW = Date.parse('2026-11-12T18:00:00Z');
const A = 'cranium-00000000000000aa';
const B = 'cranium-00000000000000bb';
const D = 'cranium-00000000000000dd';
const loaded = (value) => ({ value, error: null, loadedAt: NOW, loading: false });

const COUNTS = {
  knownHours: 48,
  onlineHours: 46,
  connectivity: 0.9576,
  restarts: 4,
  unexpected: 1,
  drops: 1,
  lowMemory: 1,
};
const FLEET = {
  vitals: {
    boards: 3,
    active: 2,
    unread: 0,
    crashFree: { boards: 1, of: 2, share: 0.5 },
    connectivity: { onlineHours: 70, knownHours: 72, share: 0.9718 },
    newest: { boards: 2, of: 3, share: 0.6667 },
    restarts: 4,
    unexpected: 1,
    drops: 1,
    lowMemory: 1,
    restartsPerDay: 1.33,
  },
  daily: [
    { day: '2026-11-11', boards: 1, crashFreeBoards: 0, crashFree: 0, connectivity: 0.9167, restarts: 1 },
    { day: '2026-11-12', boards: 2, crashFreeBoards: 2, crashFree: 1, connectivity: 0.9993, restarts: 3 },
  ],
  perBoard: [
    { thing: A, name: 'CRA', version: '1.1.0+0', newest: true, rssi: -60, active: true, crashFree: false, ...COUNTS },
    { thing: B, version: '1.0.0+0', active: true, crashFree: true, ...COUNTS, unexpected: 0 },
    // A board in a drawer all week.
    { thing: D, version: '1.0.0+0', newest: true },
  ],
  versions: [
    { version: '1.1.0+0', boards: 1, crashFreeBoards: 1, crashFree: 1, perThousandHours: 0, ...COUNTS, unexpected: 0 },
    { version: '1.0.0+0', boards: 2, crashFreeBoards: 1, crashFree: 0.5, perThousandHours: 23.8, ...COUNTS },
  ],
  from: '2026-11-05T18:00:00.000Z',
  to: '2026-11-12T18:00:00.000Z',
  days: 7,
};
const BOARD = {
  board: FLEET.perBoard[0],
  vitals: { active: true, crashFree: false, ...COUNTS, restartsPerDay: 2 },
  daily: [
    {
      day: '2026-11-11',
      active: true,
      ...COUNTS,
      samples: 2,
      rssiMean: -55,
      rssiLow: -61,
      heapLeast: 9216,
      uptimeMax: 3700,
    },
    {
      day: '2026-11-12',
      active: true,
      ...COUNTS,
      samples: 0,
      rssiMean: null,
      rssiLow: null,
      heapLeast: null,
      uptimeMax: null,
    },
  ],
  versions: FLEET.versions,
  samplesFrom: '2026-11-05T18:00:00.000Z',
  samplesUnread: false,
  cut: false,
  days: 7,
};

/** A table row's cells by their labels, as a phone shows them. */
const cells = (row) => Object.fromEntries(all(row, 'td').map((td) => [td.getAttribute('data-label'), textOf(td)]));

function draw(node) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  views.render(root, node);
  return root;
}

function ctx(route, ownVitals) {
  return {
    state: { now: NOW, route, me: { canWrite: false }, ownVitals, filters: {}, devices: { value: { devices: [] } } },
    actions: { redraw() {} },
  };
}

test('the Vitals page and a board have addresses of their own, under Monitoring', () => {
  assert.deepEqual(core.parseRoute('#/vitals'), { view: 'vitals' });
  assert.deepEqual(core.parseRoute(`#/vitals/${A}`), { view: 'board-vitals', thing: A });
  for (const hash of ['#/vitals/cranium-XYZ', '#/vitals/../x', `#/vitals/${A}0`]) {
    assert.equal(core.parseRoute(hash), null, hash);
  }
  assert.equal(core.routeHash({ view: 'board-vitals', thing: A }), `#/vitals/${A}`);
  assert.equal(core.routeHash({ view: 'board-vitals', thing: 'javascript:x' }), '#/overview');
  assert.equal(vitals.vitalsHref(A), `#/vitals/${A}`);
  assert.equal(vitals.vitalsHref('x'), null);
  for (const route of [{ view: 'vitals' }, { view: 'board-vitals', thing: A }]) {
    const nav = draw(views.navView({ state: { route, me: { canWrite: false } }, actions: {} }));
    const link = one(nav, 'a', 'Vitals');
    assert.equal(link.getAttribute('href'), '#/vitals');
    assert.equal(link.getAttribute('aria-current'), 'page');
  }
});

test('the client asks only for the vitals routes, and only with GET', async () => {
  const asked = [];
  const api = core.createApi({
    auth: { accessToken: () => 'TOKEN' },
    crypto: globalThis.crypto,
    clock: core.createClock(),
    onUnauthorized: () => {},
    pause: async () => {},
    fetch: async (url, init) => {
      asked.push([init?.method ?? 'GET', String(url)]);
      return Response.json({ vitals: {} });
    },
  });
  await api.vitalsRequest('/api/vitals?days=30');
  await api.vitalsRequest(`/api/vitals/${A}?days=90`);
  assert.deepEqual(asked, [
    ['GET', '/api/vitals?days=30'],
    ['GET', `/api/vitals/${A}?days=90`],
  ]);
  for (const path of ['/api/issues', '/api/vitals/../x', '/api/vitals?days=900', `/api/vitals/${A}/samples`]) {
    await assert.rejects(api.vitalsRequest(path), /not a request of the Vitals pages/, path);
  }
});

test('the pages read 7, 30 or 90 days, 7 at first, every 5 minutes', () => {
  assert.deepEqual(vitals.VITALS_RANGES, [7, 30, 90]);
  assert.equal(vitals.DEFAULT_RANGE, 7);
  assert.equal(vitals.VITALS_REFRESH_MS, 5 * 60_000);
});

test('what the server says is checked before it is drawn', () => {
  const read = vitals.readVitals({
    vitals: { crashFree: { boards: 1, of: 2, share: 7 }, restarts: -1, connectivity: 'all' },
    daily: [{ day: 'yesterday' }, { day: '2026-11-12', crashFree: 0.5, restarts: 2 }],
    perBoard: [{ thing: 'evil' }, { thing: A, version: '<b>', rssi: 20, name: { html: 1 } }],
    versions: [{ version: 'x', boards: 2 }],
  });
  assert.equal(read.vitals.crashFree.share, null);
  assert.equal(read.vitals.restarts, 0);
  assert.equal(read.vitals.connectivity.share, null);
  assert.deepEqual(
    read.daily.map((one) => [one.day, one.crashFree, one.restarts]),
    [['2026-11-12', 0.5, 2]]
  );
  assert.deepEqual(
    read.perBoard.map((one) => [one.thing, one.version, one.rssi, one.name]),
    [[A, null, null, null]]
  );
  assert.deepEqual(
    read.versions.map((one) => [one.version, one.boards]),
    [[null, 2]]
  );
  const board = vitals.readBoardVitals({ board: { thing: 'x' }, daily: null, samplesUnread: 'yes' });
  assert.equal(board.board, null);
  assert.deepEqual(board.daily, []);
  assert.equal(board.samplesUnread, false);
});

test('a share reads as a whole percent, unless that would round a gap away', () => {
  assert.equal(vitals.percent(0.5), '50%');
  assert.equal(vitals.percent(1), '100%');
  assert.equal(vitals.percent(0.9993), '99.9%');
  assert.equal(vitals.percent(0.97176), '97%');
  assert.equal(vitals.percent(null), '-');
  assert.equal(vitals.percent(0.004), '0.4%');
  assert.equal(vitals.percent(0.0001), '<0.1%');
  assert.equal(vitals.percent(0), '0%');
  assert.deepEqual(vitals.countScale([0, 1]), { yMin: 0, yMax: 4, yTicks: [0, 1, 2, 3, 4] });
  assert.deepEqual(vitals.countScale([0, 37]).yTicks, [0, 10, 20, 30, 40]);
});

test('the Vitals page shows the vitals, a chart a day, the boards and the versions', () => {
  const state = { days: 7, fleet: new Map([[7, loaded(vitals.readVitals(FLEET))]]), board: new Map() };
  const root = draw(vitals.vitalsView(ctx({ view: 'vitals' }, state)));
  assert.equal(textOf(one(root, 'h1')), 'Vitals');
  const figures = one(root, 'dl.ui-stats');
  assert.ok(figures.getAttribute('class').includes('is-tiles'));
  assert.match(textOf(figures), /Crash-free boards 50% 1 of 2 boards in 7 days/);
  assert.match(textOf(figures), /Connected 97% 70 h online/);
  assert.match(textOf(figures), /On the newest release 67% 2 of 3 boards with a known version/);
  // How it works says the days are UTC days, and which boards the newest-release share counts.
  assert.match(textOf(root), /Days are UTC days\./);
  assert.match(textOf(root), /its share is of every board whose version is known, seen in these days or not/);
  assert.match(textOf(figures), /Restarts 4 1 crash/);
  // Three charts, each with its table of days.
  assert.equal(all(root, 'figure.chart').length, 3);
  // The boards: a shared table that stacks on a phone, each board linking to its vitals.
  const boards = one(root, 'table.vitals-boards');
  assert.ok(boards.getAttribute('class').includes('is-stacked'));
  const rows = all(boards, 'tr.vitals-board');
  assert.equal(rows.length, 3);
  assert.equal(one(rows[0], 'a.ui-board').getAttribute('href'), `#/vitals/${A}`);
  assert.match(textOf(rows[0]), /1\.1\.0\+0 Newest 1 crash 96%/);
  assert.match(textOf(rows[1]), /Crash-free/);
  assert.match(textOf(rows[2]), /Not seen/);
  const cohorts = one(root, 'table.vitals-versions');
  const older = all(cohorts, 'tr')[2];
  assert.match(textOf(one(older, 'th')), /1\.0\.0\+0/);
  assert.deepEqual(cells(older), {
    Boards: '2',
    'Crash-free': '1 of 2',
    Connected: '96%',
    Crashes: '1',
    'Per 1,000 h': '23.8',
  });
  assert.doesNotMatch(textOf(root), /object Object|undefined|NaN/);
});

test('no board seen in the window: the page says so instead of empty charts', () => {
  const quiet = vitals.readVitals({ ...FLEET, vitals: { ...FLEET.vitals, active: 0, unread: 2 }, daily: [] });
  const state = { days: 7, fleet: new Map([[7, loaded(quiet)]]), board: new Map() };
  const root = draw(vitals.vitalsView(ctx({ view: 'vitals' }, state)));
  assert.match(textOf(root), /No board was seen\./);
  assert.match(textOf(root), /The events of 2 boards could not be read/);
  assert.equal(all(root, 'figure.chart').length, 0);
});

test('the range switch reads the days it names, and keeps each range apart', async () => {
  const asked = [];
  const state = { now: NOW, route: { view: 'vitals' }, me: { canWrite: false }, filters: {} };
  let draws = 0;
  vitals.connect({
    state,
    api: {
      vitalsRequest: async (path) => {
        asked.push(path);
        return FLEET;
      },
    },
    load: async (target, fetcher) => {
      target.value = await fetcher();
    },
    draw: () => {
      draws += 1;
    },
    now: () => NOW,
  });
  await vitals.refreshVitals();
  assert.deepEqual(asked, ['/api/vitals?days=7']);
  const root = draw(vitals.vitalsView({ state, actions: { redraw() {} } }));
  const range = one(root, 'div.vitals-range');
  assert.equal(one(range, 'button', '7 days').getAttribute('aria-pressed'), 'true');
  click(one(range, 'button', '30 days'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.ownVitals.days, 30);
  assert.deepEqual(asked, ['/api/vitals?days=7', '/api/vitals?days=30']);
  assert.ok(draws >= 1);
  assert.deepEqual([...state.ownVitals.fleet.keys()], [7, 30]);
  // A board's page asks for the same days.
  state.route = { view: 'board-vitals', thing: A };
  await vitals.refreshBoardVitals();
  assert.equal(asked.at(-1), `/api/vitals/${A}?days=30`);
  assert.equal(vitals.boardVitalsResources(state).length, 1);
});

test("a board's page shows its tiles, its days and its versions, with links to the board", () => {
  const state = {
    days: 7,
    fleet: new Map(),
    board: new Map([[`${A}|7`, loaded(vitals.readBoardVitals(BOARD))]]),
  };
  const root = draw(vitals.boardVitalsView(ctx({ view: 'board-vitals', thing: A }, state)));
  assert.match(textOf(one(root, 'h1')), /Vitals CRA/);
  assert.equal(one(root, 'a.back').getAttribute('href'), '#/vitals');
  assert.equal(one(root, 'a', 'Diagnostics').getAttribute('href'), `#/diagnostics/${A}`);
  const figures = textOf(one(root, 'dl.ui-stats'));
  assert.match(figures, /Crash-free No 1 crash/);
  assert.match(figures, /Restarts 4 2 a day/);
  assert.match(figures, /Version 1\.1\.0\+0 the newest/);
  assert.equal(all(root, 'figure.chart').length, 4);
  // The days, newest first, with the signal and memory where there were readings.
  assert.match(textOf(one(one(root, 'table.vitals-days'), 'thead')), /^Day \(UTC\)/);
  const days = all(one(root, 'table.vitals-days'), 'tr').slice(1);
  assert.equal(days.length, 2);
  assert.deepEqual(
    [cells(days[1]).Signal, cells(days[1])['Least free heap'], cells(days[1])['Longest up']],
    ['-55 (low -61) dBm', '9.0 KiB', '1 h']
  );
  assert.deepEqual(
    [cells(days[0]).Signal, cells(days[0])['Least free heap'], cells(days[0])['Longest up']],
    ['-', '-', '-']
  );
  assert.doesNotMatch(textOf(root), /object Object|undefined|NaN/);

  const cut = vitals.readBoardVitals({
    ...BOARD,
    cut: true,
    samplesUnread: true,
  });
  const noted = draw(
    vitals.boardVitalsView(
      ctx({ view: 'board-vitals', thing: A }, { days: 7, fleet: new Map(), board: new Map([[`${A}|7`, loaded(cut)]]) })
    )
  );
  assert.match(textOf(noted), /too many events to read all 7 days/);
  assert.match(textOf(noted), /could not be read/);

  // Not loaded yet: the page says so, with the way back.
  const waiting = draw(
    vitals.boardVitalsView(ctx({ view: 'board-vitals', thing: A }, { days: 7, fleet: new Map(), board: new Map() }))
  );
  assert.equal(one(waiting, 'a.back').getAttribute('href'), '#/vitals');
});
