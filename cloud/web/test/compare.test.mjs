/**
 * Tests for Compare and the version timeline (docs/compare.md): the address of the Compare page and the boards it
 * takes (core.js), the client's read of a board's timeline, the Version timeline card of a board's page, the
 * Compare page with what differs marked, the tick boxes and the bar of what is ticked on the Devices page, and the
 * layout on a phone (app.css). compare.js and views.js are the very files the browser loads.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { COMPARE, CORE, MEMFAULT, VIEWS, all, click, controls, createDocument, one, textOf } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
const compare = await import(COMPARE);
const memfault = await import(MEMFAULT);
globalThis.document = createDocument();

const NOW = Date.parse('2026-11-09T18:00:00Z');
const A = 'cranium-00000000000000aa';
const B = 'cranium-00000000000000bb';
const C = 'cranium-00000000000000cc';
const JOB = 'cranium-1-13-0-b0-20261104T150000Z-ab12';
const loaded = (value) => ({ value, error: null, loadedAt: NOW, loading: false });
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

function board(thing, changes = {}) {
  return {
    thing,
    name: null,
    online: true,
    lastSeen: iso(0.01),
    fw: { version: '1.14.0+0', confirmed: true },
    ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' },
    rssi: -50,
    uptime: 7200,
    ...changes,
  };
}

/** A timeline as the API gives it, newest first. */
const TIMELINE = {
  thing: A,
  current: '1.14.0+0',
  versions: [
    {
      version: '1.14.0+0',
      startedAt: iso(30),
      endedAt: null,
      current: true,
      arrived: 'bluetooth',
      deployment: null,
      status: 'confirmed',
      reboots: 0,
      issues: 0,
      countedFrom: iso(30),
    },
    {
      version: '1.13.1+0',
      startedAt: iso(50),
      endedAt: iso(49),
      current: false,
      arrived: 'ota',
      deployment: JOB,
      status: 'rolled_back',
      reboots: 2,
      issues: 1,
      countedFrom: iso(50),
    },
    {
      version: '1.13.0+0',
      startedAt: null,
      endedAt: iso(50),
      current: false,
      arrived: 'setup',
      deployment: null,
      status: 'confirmed',
      reboots: null,
      issues: null,
      countedFrom: null,
    },
  ],
  cursor: 'dGltZWxpbmV8Mw',
  countedFrom: iso(90 * 24),
  generatedAt: iso(0),
};

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
  return { actions, calls };
}

function api(replies, asked = []) {
  return core.createApi({
    auth: { accessToken: () => 'TOKEN' },
    crypto: globalThis.crypto,
    clock: core.createClock(() => NOW),
    onUnauthorized: () => assert.fail('the token was refused'),
    fetch: async (url) => {
      asked.push(String(url));
      const reply = replies.get(String(url));
      assert.ok(reply, `no reply for ${url}`);
      return Response.json(reply);
    },
  });
}

// The address and the client.

test('the Compare page takes 2 to 4 boards in its address, each once, and nothing else', () => {
  const route = core.parseRoute(`#/compare?boards=${A},${B}`);
  assert.equal(route.view, 'compare');
  const filters = core.readFilters('compare', route.query);
  assert.deepEqual(core.compareThings(filters), [A, B]);
  assert.equal(core.compareHref([A, B, C]), `#/compare?boards=${A},${B},${C}`);
  assert.equal(core.filtersHash({ view: 'compare' }, { boards: `${B},${A}` }), `#/compare?boards=${B},${A}`);
  for (const boards of [`${A},${A}`, `${A},x`, [A, B, C, A.replace('aa', 'dd'), A.replace('aa', 'ee')].join(',')]) {
    assert.deepEqual(core.compareThings(core.readFilters('compare', { boards })), [], boards);
  }
  assert.equal(core.compareHref([A]), null);
  assert.equal(core.compareHref([A, 'javascript:x']), null);
  assert.equal(core.compareHref([A, B, C, 'cranium-00000000000000dd', 'cranium-00000000000000ee']), null);
  assert.deepEqual(core.parseRoute('#/compare'), { view: 'compare' });
});

test("the client reads a board's timeline a page at a time, and keeps only what it knows", async () => {
  const asked = [];
  const strange = { ...TIMELINE.versions[0], arrived: 'teleport', status: 'maybe', reboots: -1, deployment: '../x' };
  const replies = new Map([
    [`/api/devices/${A}/timeline`, TIMELINE],
    [
      `/api/devices/${A}/timeline?limit=20&cursor=${TIMELINE.cursor}`,
      { ...TIMELINE, versions: [strange], cursor: null },
    ],
  ]);
  const client = api(replies, asked);
  const first = await client.timeline(A);
  assert.deepEqual(
    first.versions.map((stay) => [stay.version, stay.arrived, stay.status, stay.current]),
    [
      ['1.14.0+0', 'bluetooth', 'confirmed', true],
      ['1.13.1+0', 'ota', 'rolled_back', false],
      ['1.13.0+0', 'setup', 'confirmed', false],
    ]
  );
  assert.equal(first.versions[1].deployment, JOB);
  assert.equal(first.versions[2].reboots, null);
  assert.equal(first.cursor, TIMELINE.cursor);
  const next = await client.timeline(A, { limit: 20, cursor: first.cursor });
  assert.deepEqual(
    [next.versions[0].arrived, next.versions[0].status, next.versions[0].reboots, next.versions[0].deployment],
    ['usb', 'trial', null, null]
  );
  assert.equal(next.cursor, null);
  await assert.rejects(client.timeline('x'));
  await assert.rejects(client.timeline(A, { limit: 51 }));
  assert.deepEqual(asked, [
    `/api/devices/${A}/timeline`,
    `/api/devices/${A}/timeline?limit=20&cursor=${TIMELINE.cursor}`,
  ]);
});

// The Version timeline card.

test("a board's page has its versions as a vertical timeline, newest first, with how each came and how it went", () => {
  const { actions, calls } = recorder();
  const state = { now: NOW, timelines: new Map([[A, loaded(TIMELINE)]]) };
  const root = draw(compare.timelineSection(A, { state, actions }));
  assert.match(textOf(one(root, 'h2', 'Version timeline')), /Version timeline/);
  const items = all(root, 'li.vtimeline-item');
  assert.deepEqual(
    items.map((item) => all(item, 'span.vtimeline-version').map(textOf)[0]),
    ['1.14.0+0', '1.13.1+0', '1.13.0+0']
  );
  assert.match(
    textOf(items[0]),
    /Confirmed.*Runs now.*Since .*Over Bluetooth from a phone.*0 unexpected restarts · 0 issues/
  );
  assert.ok(items[0].getAttribute('class').includes('is-current'));
  // The link says where it leads, with the deployment's id as its tooltip; a time reads "Nov 3, 2026, 2:02 PM".
  assert.match(textOf(items[1]), /Rolled back.*Over the air, in a deployment/);
  assert.ok(items[1].getAttribute('class').includes('is-rolled-back'));
  assert.equal(all(items[1], 'a')[0].getAttribute('href'), `#/deployments/${JOB}`);
  assert.equal(all(items[1], 'a')[0].getAttribute('title'), JOB);
  assert.doesNotMatch(textOf(items[0]), /\d:\d{2}:\d{2}/, 'no seconds in a span of days');
  assert.match(textOf(items[1]), /2 unexpected restarts · 1 issue/);
  assert.match(textOf(items[2]), /Before the history: by USB or at setup.*not known: before events were kept/);
  // Older versions, when there are more.
  click(one(root, 'button', 'Show older versions'));
  assert.deepEqual(calls, [['moreTimeline', A]]);
});

test('the timeline says what it is waiting for, and what it could not read', () => {
  const ctx = (target) => ({ state: { now: NOW, timelines: new Map(target ? [[A, target]] : []) }, actions: {} });
  assert.match(textOf(draw(compare.timelineSection(A, ctx(null)))), /Loading the versions/);
  const failed = { value: null, error: new Error('x'), loadedAt: 0, loading: false };
  assert.match(textOf(draw(compare.timelineSection(A, ctx(failed)))), /could not be read/);
  const none = loaded({ ...TIMELINE, versions: [], cursor: null });
  const root = draw(compare.timelineSection(A, ctx(none)));
  assert.match(textOf(root), /has not said which version it runs/);
  assert.equal(all(root, 'button').length, 0);
});

// The Compare page.

function compareState(things, changes = {}) {
  const devices = [
    board(A, { name: 'Bench' }),
    board(B, { fw: { version: '1.13.0+0', confirmed: false }, rssi: -80, online: false }),
    board(C),
  ];
  return {
    now: NOW,
    route: { view: 'compare' },
    filters: { compare: { boards: things.join(',') } },
    devices: loaded({ devices }),
    timelines: new Map(things.map((thing) => [thing, loaded({ ...TIMELINE, thing })])),
    weekWarnings: new Map([
      [A, loaded({ reboots: 0, issues: 1, more: false })],
      [B, loaded({ reboots: 3, issues: 1, more: false })],
      [C, loaded({ reboots: 0, issues: 1, more: false })],
    ]),
    memfault: {
      boards: new Map([
        [A, loaded({ metrics: { series: { supply_mv: [{ ms: NOW, v: 3300 }] }, unnamed: 0 } })],
        [
          B,
          loaded({
            metrics: {
              series: {
                supply_mv: [
                  { ms: NOW - 1, v: 3000 },
                  { ms: NOW, v: 3300 },
                ],
              },
              unnamed: 0,
            },
          }),
        ],
      ]),
    },
    ...changes,
  };
}

test('Compare sets the boards side by side and marks, in words, every row where they differ', () => {
  const state = compareState([A, B]);
  const root = draw(compare.compareView({ state, actions: recorder().actions, memfault }));
  const columns = all(root, 'section.compare-board');
  // The facts, then the timelines: a column each.
  assert.equal(columns.length, 4);
  assert.match(textOf(columns[0]), /Bench/);
  const facts = (column) =>
    Object.fromEntries(all(column, 'div.compare-fact').map((fact) => [textOf(all(fact, 'dt')[0]), fact]));
  const left = facts(columns[0]);
  const right = facts(columns[1]);
  assert.match(textOf(right.Firmware), /1\.13\.0\+0, on trial differs/);
  assert.ok(left.Firmware.getAttribute('class').includes('is-different'));
  assert.match(textOf(right.State), /Offline differs/);
  assert.match(textOf(right['Wi-Fi signal']), /-80 dBm, Weak differs/);
  assert.match(textOf(right['Unexpected restarts, 7 d']), /3 differs/);
  // The same on both: not marked.
  assert.equal(textOf(right['Issues, 7 d']), 'Issues, 7 d 1');
  assert.equal(right['Issues, 7 d'].getAttribute('class').includes('is-different'), false);
  // The latest Memfault metric, as the metrics card words it.
  assert.equal(textOf(right['Supply voltage']), 'Supply voltage 3.30 V');
  // A time ago and an uptime always differ, so they are not marked.
  assert.equal(left['Last report'].getAttribute('class').includes('is-different'), false);
  assert.equal(left.Uptime.getAttribute('class').includes('is-different'), false);
  assert.match(textOf(root), /4 rows differ\./);
  // The timelines, in parallel.
  assert.equal(all(columns[2], 'li.vtimeline-item').length, 3);
  assert.equal(all(columns[3], 'li.vtimeline-item').length, 3);
  assert.ok(all(root, 'ol.vtimeline').every((list) => list.getAttribute('class').includes('is-compact')));
});

test('Compare with fewer than two boards says how to pick them; a board not listed is said so', () => {
  const lonely = draw(compare.compareView({ state: compareState([A]), actions: {}, memfault }));
  assert.match(textOf(lonely), /Pick 2 to 4 boards to compare/);
  assert.equal(all(lonely, 'section.compare-board').length, 0);
  const gone = 'cranium-00000000000000ff';
  const root = draw(compare.compareView({ state: compareState([A, gone]), actions: {}, memfault: null }));
  assert.match(textOf(all(root, 'section.compare-board')[1]), /Not registered/);
  // Without Memfault's script, no metric rows.
  assert.equal(
    all(root, 'dt').some((dt) => textOf(dt) === 'Supply voltage'),
    false
  );
});

test('the rows of Compare, without drawing: one cell a board, and what is compared', () => {
  const rows = compare.compareRows(
    [
      { thing: A, device: board(A), week: { reboots: 1, issues: 0, more: true }, memfault: null },
      { thing: B, device: board(B), week: null, memfault: null },
    ],
    { now: NOW }
  );
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId.version.differs, false);
  assert.deepEqual(
    byId.reboots.cells.map((cell) => cell.text),
    ['1+', '—']
  );
  assert.equal(byId.reboots.differs, true);
  assert.deepEqual(
    compare.countWeek([
      { kind: 'restart', level: 'warn' },
      { kind: 'restart', level: 'info' },
      { kind: 'health', level: 'warn' },
      { kind: 'connection', level: 'warn' },
    ]),
    { reboots: 1, issues: 1, more: false }
  );
});

// The Devices page.

test('the Devices page ticks boards, and Compare opens once 2 to 4 are ticked', async () => {
  const devices = [board(A), board(B), board(C)];
  const state = (selected) => ({
    now: NOW,
    route: { view: 'devices' },
    me: { canWrite: false },
    filters: { devices: {} },
    devices: loaded({ devices }),
    firmware: loaded(null),
    deployments: loaded(null),
    selected,
  });
  const { actions, calls } = recorder();
  const none = draw(views.devicesView({ state: state([]), actions }));
  const boxes = all(none, 'label.device-select');
  assert.equal(boxes.length, 3);
  assert.equal(all(none, 'div.selection-bar').length, 0);
  click(all(boxes[1], 'input')[0]);
  assert.deepEqual(calls, [['toggleSelected', B]]);

  const lone = draw(views.devicesView({ state: state([B]), actions }));
  assert.match(textOf(one(lone, 'div.selection-bar', '1 board selected')), /Tick 1 to 3 more to compare/);
  assert.equal(all(lone, 'button').find((el) => textOf(el) === 'Compare').disabled, true);
  assert.equal(all(lone, 'input').filter((input) => input.checked).length, 1);

  const two = draw(views.devicesView({ state: state([B, A]), actions }));
  const link = all(two, 'a').find((el) => textOf(el) === 'Compare');
  assert.equal(link.getAttribute('href'), `#/compare?boards=${B},${A}`);
  click(all(two, 'button').find((el) => textOf(el) === 'Clear'));
  assert.deepEqual(calls.at(-1), ['clearSelected']);
  assert.ok(controls(two).includes('Compare'));
});

test("a board's page has Compare with…, which picks it on the Devices page", () => {
  const { actions, calls } = recorder();
  const device = board(A);
  const state = {
    now: NOW,
    route: { view: 'device', thing: A },
    me: { canWrite: false },
    devices: loaded({ devices: [device] }),
    firmware: loaded(null),
    deployments: loaded(null),
    deviceDetails: new Map([
      [A, loaded({ device, certificates: [], executions: [], olderExecutions: 0, memfault: null })],
    ]),
    timelines: new Map([[A, loaded(TIMELINE)]]),
  };
  const root = draw(views.deviceView({ state, actions, compare }));
  click(all(root, 'button').find((el) => textOf(el) === 'Compare with…'));
  assert.deepEqual(calls.at(-1), ['compareWith', A]);
  assert.equal(all(root, 'li.vtimeline-item').length, 3);
});

// The layout.

test('on a phone the boards stack, one card each; from 48rem they stand side by side; colours are tokens', () => {
  const css = readFileSync(new URL('../src/site/assets/app.css', import.meta.url), 'utf8');
  const start = css.indexOf('Compare and the version timeline');
  assert.ok(start > 0);
  const part = css.slice(start);
  // One column unless the page is wide.
  assert.match(part, /\.compare-grid \{\s+display: grid;\s+grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(part, /@container page \(min-width: 48rem\) \{\s+\.compare-grid\.is-2 \{/);
  for (const count of [2, 3, 4]) {
    assert.match(part, new RegExp(`\\.compare-grid\\.is-${count} \\{\\s+grid-template-columns: repeat\\(${count}, `));
  }
  // Dark mode is the tokens': no colour of its own.
  const rules = part.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i.test(rules), false);
  // The tick box is a target of 44 px at least.
  assert.match(part, /\.device-select \{[^}]*min-width: var\(--tap\);[^}]*min-height: var\(--tap\);/);
});
