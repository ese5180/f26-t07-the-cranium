/**
 * Tests for the update history on the website (GET /api/updates, console 2.1.1): how core.js reads it
 * and words it, and how the Overview's Updates card, the Deployments page and a board's page show it.
 * The scripts are the very files the browser loads, through page.mjs; the state is made from replies
 * in the shape of the API (world.mjs), read by the console's own client.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE, VIEWS, all, createDocument, descendants, one, textOf } from './page.mjs';
import { FINISHED, MANAGER, NOW, WAITING, ago, deployment, device, execution, release, repliesFor } from './world.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
globalThis.document = createDocument();

const loaded = (value) => ({ value, error: null, loadedAt: NOW - 20000, loading: false });
const VIHAAN = {
  sub: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  email: 'vihaan.ravishankar@example.invalid',
  name: 'Vihaan',
};

/** An update as the server describes it. */
function update(changes = {}) {
  return {
    id: `bluetooth:${WAITING}:5:1.2.3+5:1.2.4+0`,
    thing: WAITING,
    from: '1.2.3+5',
    to: '1.2.4+0',
    how: 'bluetooth',
    deployment: null,
    who: VIHAAN,
    outcome: 'kept',
    startedAt: ago(1800),
    endedAt: ago(1700),
    status: null,
    ...changes,
  };
}

const OVER_BLUETOOTH = update();
const BY_DEPLOYMENT = update({
  id: `deployment:${WAITING}:${FINISHED}`,
  from: '1.2.3+4',
  to: '1.2.3+4',
  how: 'deployment',
  deployment: FINISHED,
  who: { ...MANAGER, name: 'Manager' },
  startedAt: ago(93300),
  endedAt: ago(93000),
  status: 'SUCCEEDED',
});
const BY_USB = update({
  id: `usb_or_other:${WAITING}:${ago(200000)}`,
  from: '1.2.3+3',
  to: '1.2.3+4',
  how: 'usb_or_other',
  who: null,
  outcome: 'rolled_back',
  startedAt: ago(200000),
  endedAt: ago(199000),
});

/** A calm console: one board, on what it got over Bluetooth after the last deployment. */
const CALM = Object.freeze({
  devices: [device(WAITING, { fw: { version: '1.2.4+0', confirmed: true } })],
  releases: [release('1.2.4+0'), release('1.2.3+5'), release('1.2.3+4')],
  deployments: [
    deployment(FINISHED, {
      status: 'COMPLETED',
      createdAt: ago(93600),
      completedAt: ago(93000),
      executions: [execution(WAITING, 'succeeded', { status: 'SUCCEEDED', startedAt: ago(93300) })],
    }),
  ],
  entries: [],
  updates: [OVER_BLUETOOTH, BY_DEPLOYMENT, BY_USB],
});

/** The state of the console for a world, read by the console's own client, the update history with it. */
async function consoleState(world, changes = {}) {
  const replies = repliesFor(world);
  const asked = [];
  const api = core.createApi({
    auth: { accessToken: () => 'TOKEN' },
    crypto: globalThis.crypto,
    clock: core.createClock(() => NOW),
    onUnauthorized: () => assert.fail('the token was refused'),
    fetch: async (path) => {
      asked.push(path);
      assert.equal(replies.has(path), true, `no reply for ${path}`);
      return Response.json(replies.get(path));
    },
  });
  const audit = await api.audit();
  const state = {
    gate: null,
    me: await api.me(),
    route: { view: 'overview' },
    now: NOW,
    interval: 0,
    sessionLeft: 3000,
    devices: loaded(await api.devices()),
    firmware: loaded(await api.firmware()),
    deployments: loaded(await api.deployments()),
    recent: loaded(audit),
    audit: { ...loaded(audit), loadingMore: false, moreError: null },
    updates: loaded(await api.updates({ limit: 25 })),
    deviceDetails: new Map(),
    deploymentDetails: new Map(),
    boardUpdates: new Map(),
    upload: { stage: 'idle', over: false },
  };
  for (const { thing } of world.devices) {
    state.deviceDetails.set(thing, loaded(await api.device(thing)));
    state.boardUpdates.set(thing, loaded(await api.updates({ thing, limit: 25 })));
  }
  for (const { id } of world.deployments) state.deploymentDetails.set(id, loaded(await api.deployment(id)));
  return { state: { ...state, ...changes }, asked };
}

function draw(node) {
  const box = document.createElement('div');
  views.render(box, node);
  return box;
}

const page = (view, state, route = {}) =>
  draw(view({ state: { ...state, route: { ...state.route, ...route } }, actions: {} }));

// Reading and words.

test('an update is read field by field, and a way or an outcome the console does not know reads as the vaguest', async () => {
  const { api } = {
    api: core.createApi({
      auth: { accessToken: () => 'TOKEN' },
      crypto: globalThis.crypto,
      clock: core.createClock(() => NOW),
      onUnauthorized: () => {},
      fetch: async () =>
        Response.json({
          updates: [
            OVER_BLUETOOTH,
            { ...OVER_BLUETOOTH, id: 'x', how: 'carrier_pigeon', outcome: 'exploded', who: null, from: 'soon' },
            { ...OVER_BLUETOOTH, thing: 'not-a-board' },
            { ...OVER_BLUETOOTH, id: '' },
          ],
          cursor: 'abc_DEF-1',
          generatedAt: ago(0),
        }),
    }),
  };
  const read = await api.updates();
  assert.deepEqual(read.updates[0], OVER_BLUETOOTH);
  assert.deepEqual(
    [read.updates[1].how, read.updates[1].outcome, read.updates[1].who, read.updates[1].from],
    ['usb_or_other', 'pending', null, null]
  );
  assert.equal(read.updates.length, 2);
  assert.equal(read.cursor, 'abc_DEF-1');
  await assert.rejects(api.updates({ thing: 'nope' }), /not valid/);
  await assert.rejects(api.updates({ limit: 101 }), /not valid/);
});

test('the words of an update are those of every client: who sent it over Bluetooth, which deployment, or USB', () => {
  assert.equal(core.updateHow(OVER_BLUETOOTH), 'over Bluetooth from Vihaan’s phone');
  assert.equal(core.updateHow({ ...OVER_BLUETOOTH, who: null }), 'over Bluetooth from a phone');
  assert.equal(core.updateHow({ ...OVER_BLUETOOTH, who: { ...VIHAAN, name: '' } }), 'over Bluetooth from a phone');
  assert.equal(core.updateHow(BY_DEPLOYMENT), `deployment ${FINISHED}`);
  assert.equal(core.updateHow(BY_USB), 'USB or another tool');
  assert.deepEqual(
    ['kept', 'rolled_back', 'not_installed', 'pending'].map((outcome) => core.describeOutcome({ outcome })),
    [
      { tone: 'good', icon: 'check-circle', label: 'Kept' },
      { tone: 'bad', icon: 'undo', label: 'Rolled back' },
      { tone: 'warn', icon: 'minus-circle', label: 'Not installed' },
      { tone: 'idle', icon: 'clock', label: 'Pending' },
    ]
  );
  assert.equal(core.updateTime(OVER_BLUETOOTH), OVER_BLUETOOTH.endedAt);
  assert.equal(core.updateTime({ ...OVER_BLUETOOTH, endedAt: null }), OVER_BLUETOOTH.startedAt);
});

// The pages.

test('the Overview tells of the update over Bluetooth that came after the last deployment, and lists those before', async () => {
  const { state, asked } = await consoleState(CALM);
  assert.ok(asked.includes('/api/updates?limit=25'));
  const card = one(page(views.overviewView, state), 'section.overview-updates');
  assert.equal(textOf(one(card, 'p.calm-title')), 'No update is in progress.');
  assert.ok(one(card, 'div.calm').getAttribute('class').includes('is-good'));
  assert.equal(
    textOf(one(card, 'p.calm-note')),
    'Last update: 1.2.4+0 Kept over Bluetooth from Vihaan’s phone, 28 min ago'
  );
  // That the board left what the deployment installed is said by the update, not as a mystery.
  assert.equal(all(card, 'p.calm-since').length, 0);
  const rows = all(card, 'li.update-row');
  assert.deepEqual(
    rows.map((row) => textOf(one(row, '.row-title'))),
    ['1.2.3+4', '1.2.3+4']
  );
  // The row leads to the deployment, so the deployment's id is its tooltip rather than more words in it.
  assert.match(textOf(rows[0]), /from 1\.2\.3\+4.*in a deployment.*Kept/);
  assert.equal(one(rows[0], 'span.update-how').getAttribute('title'), FINISHED);
  assert.match(textOf(rows[1]), /from 1\.2\.3\+3.*USB or another tool.*Rolled back/);
  assert.equal(one(rows[0], 'a.row-title').getAttribute('href'), `#/deployments/${FINISHED}`);
  assert.equal(one(rows[1], 'a.row-title').getAttribute('href'), `#/devices/${WAITING}`);
  assert.equal(textOf(one(card, 'a.card-more')), 'All updates');

  // One still on trial is not over, and the card does not say that nothing is going on.
  const onTrial = { ...OVER_BLUETOOTH, outcome: 'pending', endedAt: null };
  const { state: trial } = await consoleState({ ...CALM, updates: [onTrial, BY_DEPLOYMENT] });
  const waiting = one(page(views.overviewView, trial), 'section.overview-updates');
  assert.equal(textOf(one(waiting, 'p.calm-title')), 'The last update has not ended yet.');
  assert.equal(
    textOf(one(waiting, 'p.calm-note')),
    'Last update: 1.2.4+0 Pending over Bluetooth from Vihaan’s phone, 30 min ago'
  );
});

test('the Overview is as before when the newest update is the last deployment, or the list has not come', async () => {
  const { state } = await consoleState({ ...CALM, updates: [BY_DEPLOYMENT, BY_USB], devices: [device(WAITING)] });
  const card = one(page(views.overviewView, state), 'section.overview-updates');
  assert.match(textOf(one(card, 'p.calm-note')), /^1\.2\.3\+4 Succeeded/);
  // The deployment's own row is the note: the list goes on with what came before it.
  assert.deepEqual(
    all(card, 'li.update-row').map((row) => textOf(one(row, '.row-title'))),
    ['1.2.3+4']
  );

  const none = one(
    page(views.overviewView, { ...state, updates: { value: null, error: null, loading: true, loadedAt: 0 } }),
    'section.overview-updates'
  );
  assert.match(textOf(one(none, 'p.calm-note')), /^1\.2\.3\+4 Succeeded/);
  assert.equal(all(none, 'li.update-row').length, 0);
  assert.equal(textOf(one(none, 'a.card-more')), 'All deployments');
});

test('the Deployments page lists every update of every board, however it came', async () => {
  const { state } = await consoleState(CALM);
  const drawn = page(views.deploymentsView, state);
  const rows = all(one(drawn, 'section.every-update'), 'li.update-row');
  assert.deepEqual(
    rows.map((row) => textOf(one(row, '.row-title'))),
    ['1.2.4+0', '1.2.3+4', '1.2.3+4']
  );
  assert.match(textOf(rows[0]), /from 1\.2\.3\+5.*over Bluetooth from Vihaan’s phone.*Kept/);
  // The page leads with them: the sums of every update first, the deployments' own figure labelled as theirs, and
  // the list of updates before the list of deployments, which stay links to their detail.
  const order = descendants(drawn)
    .filter((el) => el.localName === 'section')
    .map((el) => el.getAttribute('class') ?? '')
    .join(' | ');
  assert.ok(
    order.indexOf('updates-panel') < order.indexOf('every-update') &&
      order.indexOf('every-update') < order.indexOf('jobs-panel')
  );
  const top = one(drawn, 'section.updates-panel');
  const stats = all(top, 'div.stat').map((stat) => textOf(stat).replace(/\s+/g, ' '));
  assert.equal(stats[0], 'Updates 3 of every board');
  assert.match(stats[1], /^Deployments under way \d+ of \d+ deployments$/);
  assert.deepEqual(stats.slice(2), ['Over Bluetooth 1 from a phone', 'By USB or another tool 1']);
  assert.equal(
    one(top, 'div.segments').getAttribute('aria-label'),
    '3 updates: 1 by deployment, 1 over Bluetooth, 1 by USB or another tool; 2 kept, 1 rolled back.'
  );
  assert.match(textOf(one(drawn, 'section.jobs-panel')), /Deployments.*sent to boards.*Under way.*deployments/);
  assert.ok(all(drawn, 'li.deployment-row').length >= 1);
  // The Overview says the same sums.
  const { state: overview } = await consoleState(CALM);
  assert.equal(
    textOf(one(page(views.overviewView, overview), 'p.update-summary')),
    '3 updates: 1 by deployment, 1 over Bluetooth, 1 by USB or another tool; 2 kept, 1 rolled back.'
  );
  // With no deployment at all, the updates the boards reported are still there.
  const { state: bare } = await consoleState({ ...CALM, deployments: [], updates: [OVER_BLUETOOTH] });
  const alone = page(views.deploymentsView, bare);
  assert.match(textOf(alone), /No deployments yet\./);
  assert.equal(all(one(alone, 'section.every-update'), 'li.update-row').length, 1);
});

test('the sums of a list of updates, by how they came and how they ended', () => {
  assert.deepEqual(core.updateTotals([OVER_BLUETOOTH, BY_USB, BY_DEPLOYMENT, BY_USB]).how, {
    deployment: 1,
    bluetooth: 1,
    usb_or_other: 2,
  });
  assert.equal(core.updateSummary([]), 'No update has been reported yet.');
  assert.equal(core.updateSummary([BY_USB], true), 'The newest 1 update: 1 by USB or another tool; 1 rolled back.');
});

test("a board's page shows its every update, and its jobs where the console has no history", async () => {
  const { state } = await consoleState(CALM);
  const history = (drawn) => all(drawn, 'section.card').find((section) => /Update history/.test(textOf(section)));
  const own = history(page(views.deviceView, state, { view: 'device', thing: WAITING }));
  assert.deepEqual(
    all(own, 'li.update-row').map((row) => textOf(one(row, '.row-title'))),
    ['1.2.4+0', '1.2.3+4', '1.2.3+4']
  );
  assert.match(textOf(own), /over Bluetooth from Vihaan’s phone/);
  // From a console without the history, or while it has not come: the board's executions, as before.
  const older = history(
    page(views.deviceView, { ...state, boardUpdates: new Map() }, { view: 'device', thing: WAITING })
  );
  assert.equal(all(older, 'li.update-row').length, 0);
  assert.equal(all(older, 'li.history-row').length, 1);
  // A board with nothing in its history says so.
  const empty = new Map([[WAITING, loaded({ updates: [], cursor: null, generatedAt: ago(0) })]]);
  assert.match(
    textOf(history(page(views.deviceView, { ...state, boardUpdates: empty }, { view: 'device', thing: WAITING }))),
    /This board has not reported an update yet\./
  );
});
