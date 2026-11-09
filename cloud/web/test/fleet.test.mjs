/**
 * Tests for the fleet's part of the console (fleet.js, and what core.js and views.js do for it):
 * board types and groups on the Devices page, the health card on the Overview, a staged rollout's
 * page, the New deployment dialog offering a release to the boards of its type only, a release's
 * note, and how the activity log tells all of it. The scripts are the very files the browser loads,
 * drawing into the stand-in document of page.mjs.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE, VIEWS, all, createDocument, one, scriptAddress, textOf } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
const fleet = await import(scriptAddress('fleet.js', { 'core.js': CORE, 'views.js': VIEWS }));
globalThis.document = createDocument();

const NOW = Date.parse('2026-11-04T12:00:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const A = 'cranium-00000000000000aa';
const B = 'cranium-00000000000000bb';
const C = 'cranium-00000000000000cc';
const ROLLOUT = 'rol-20261104T110000Z-0a0b0c';
const CANARY_JOB = 'cranium-1-13-1-b0-20261104T110000Z-aaaa';
const WAVES_JOB = 'cranium-1-13-1-b0-20261104T111000Z-bbbb';
const loaded = (value) => ({ value, error: null, loadedAt: NOW, loading: false });

function draw(node) {
  const box = document.createElement('div');
  views.render(box, node);
  return box;
}

function device(thing, changes = {}) {
  return {
    thing,
    name: null,
    online: true,
    lastSeen: at(20_000),
    fw: { version: '1.13.0+0', confirmed: true },
    ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' },
    rssi: -52,
    uptime: 3600,
    stuck: null,
    diag: null,
    diary: null,
    bt: null,
    ...changes,
  };
}

const FLEET = {
  boards: [
    {
      thing: A,
      name: 'CRVIHAAN01',
      type: 'nrf7002dk',
      typeFrom: 'board',
      bluetoothOnly: false,
      online: true,
      lastSeen: at(20_000),
      version: '1.13.0+0',
      versionFrom: 'board',
      seen: null,
      groups: ['grp-0a0b0c0d'],
    },
    {
      thing: B,
      name: null,
      type: 'nrf7002dk',
      typeFrom: 'default',
      bluetoothOnly: false,
      online: true,
      lastSeen: at(20_000),
      version: '1.13.1+0',
      versionFrom: 'board',
      seen: null,
      groups: [],
    },
    {
      thing: C,
      name: null,
      type: 'nrf5340dk',
      typeFrom: 'thing',
      bluetoothOnly: true,
      online: false,
      lastSeen: null,
      version: '1.0.0+0',
      versionFrom: 'phone',
      seen: { version: '1.0.0+0', at: at(2 * 3_600_000), by: 'manager@example.invalid', name: 'Cranium-1A2B' },
      groups: ['grp-0a0b0c0d'],
    },
  ],
  groups: [{ id: 'grp-0a0b0c0d', name: 'Bench', things: [A, C], gone: 0 }],
  types: [
    { type: 'nrf7002dk', boards: 2, newest: '1.13.1+0', previous: '1.13.0+0', bluetoothOnly: false },
    { type: 'nrf5340dk', boards: 1, newest: '1.0.0+0', previous: null, bluetoothOnly: true },
  ],
};

/** The fleet module connected to a state, with an API that answers from the test. */
function connected(extra = {}) {
  const state = {
    now: NOW,
    route: { view: 'devices' },
    me: { canWrite: true },
    devices: loaded({
      devices: [device(A, { name: 'CRVIHAAN01' }), device(B), device(C, { online: false, lastSeen: null, fw: null })],
    }),
    firmware: loaded({ releases: [] }),
    deployments: loaded([]),
    deploymentDetails: new Map(),
    recent: loaded({ entries: [], next: null }),
    ...extra,
  };
  const asked = [];
  const answers = new Map();
  const api = {
    async fleetRequest(method, path, body) {
      asked.push([method, path, body]);
      if (!answers.has(`${method} ${path}`)) throw new core.ApiError(404, 'not_found', 'Nothing there');
      return answers.get(`${method} ${path}`);
    },
  };
  const load = async (target, fetcher) => {
    target.value = await fetcher();
    target.loadedAt = NOW;
  };
  fleet.connect({
    state,
    api,
    load,
    draw: () => {},
    clock: { now: () => NOW },
    refresh: () => {},
    notify: () => {},
    keep: () => {},
    dialogs: { open: () => ({}), submit: () => {}, isOpen: () => false, signIn: () => {} },
    go: () => {},
  });
  return { state, asked, answers, ctx: { state, actions: {}, fleet } };
}

test('a board says its type and its groups; a board without Wi-Fi says what a phone saw', async () => {
  const { state, answers, ctx } = connected();
  answers.set('GET /api/fleet', FLEET);
  await fleet.refreshFor('devices', true);
  assert.equal(state.fleet.value.boards.length, 3);
  const tags = draw(fleet.boardTags(state.devices.value.devices[0], ctx));
  assert.deepEqual(all(tags, 'span.fleet-chip').map(textOf), ['nRF7002 DK · layout 1', 'Bench']);
  assert.equal(fleet.bluetoothOnly(state.devices.value.devices[0], ctx), null);
  const phone = fleet.bluetoothOnly(state.devices.value.devices[2], ctx);
  assert.equal(textOf(draw(phone.badge)), 'Bluetooth only');
  assert.match(
    textOf(draw(views.h('p', null, phone.line))),
    /^Runs 1\.0\.0\+0 as a phone saw it 2 h ago \(manager@example\.invalid\)$/
  );

  // On the Devices page itself: the chips, and Bluetooth only in place of Offline.
  const page = draw(views.devicesView(ctx));
  const third = all(page, 'article.device')[2];
  assert.match(textOf(third), /Bluetooth only/);
  assert.doesNotMatch(textOf(third), /Has not reported to AWS IoT yet/);
  // The groups, with each type's group first.
  const groups = one(page, 'section.groups-card');
  assert.deepEqual(all(groups, 'p.group-name').map(textOf), [
    'nRF7002 DK · 2 boards',
    'nRF5340 DK · 1 board · Bluetooth only',
    'Bench · 2 boards',
  ]);
  // Roll back is offered for the group: its nRF7002 DK has an older release to go back to.
  assert.ok(all(groups, 'button').some((el) => textOf(el) === 'Roll back'));
});

test('a group whose types have no older release is not offered a roll back; a viewer has no buttons', async () => {
  const { state, answers, ctx } = connected();
  answers.set('GET /api/fleet', { ...FLEET, types: FLEET.types.map((entry) => ({ ...entry, previous: null })) });
  await fleet.refreshFor('devices', true);
  assert.equal(
    all(draw(fleet.groupsCard(ctx)), 'button').some((el) => textOf(el) === 'Roll back'),
    false
  );
  state.me = { canWrite: false };
  assert.equal(all(draw(fleet.groupsCard(ctx)), 'button').length, 0);
});

test("the Overview's health card: versions by type, the last week's updates, and the boards to look at", async () => {
  const { state, answers, ctx } = connected({ route: { view: 'overview' } });
  answers.set('GET /api/fleet', FLEET);
  answers.set('GET /api/fleet/health', {
    types: [
      {
        type: 'nrf7002dk',
        boards: 2,
        newest: '1.13.1+0',
        onNewest: 1,
        share: 0.5,
        bluetoothOnly: false,
        unknown: 0,
        versions: [
          { version: '1.13.1+0', count: 1, newest: true },
          { version: '1.13.0+0', count: 1, newest: false },
        ],
      },
      {
        type: 'nrf5340dk',
        boards: 0,
        newest: null,
        onNewest: 0,
        share: null,
        bluetoothOnly: true,
        unknown: 0,
        versions: [],
      },
    ],
    updates: { days: 7, succeeded: 3, failed: 1, rolledBack: 1 },
    attention: [
      {
        thing: B,
        name: null,
        type: 'nrf7002dk',
        reasons: [
          { code: 'weak_signal', text: 'Weak Wi-Fi signal (-82 dBm)' },
          { code: 'stuck', text: 'Restarted once for being stuck' },
        ],
      },
    ],
  });
  await fleet.refreshFor('overview', true);
  const card = draw(fleet.healthCard(ctx));
  assert.deepEqual(all(card, 'h2').map(textOf), ['Versions by board type', 'Updates, last 7 days', 'Needs attention']);
  // A type with no boards is not shown.
  assert.deepEqual(
    all(card, 'div.health-type').map((el) => textOf(one(el, 'p.health-type-head'))),
    ['nRF7002 DK1 of 2 boards on 1.13.1+0']
  );
  assert.deepEqual(all(card, 'dd.stat-value').map(textOf), ['3', '1', '1']);
  assert.equal(textOf(one(card, 'ul.attention')), `${B}Weak Wi-Fi signal (-82 dBm) · Restarted once for being stuck`);
  // And on the Overview page, between the panel and the cards.
  assert.ok(textOf(draw(views.overviewView(ctx))).includes('Needs attention'));
});

const DETAIL = {
  id: ROLLOUT,
  version: '1.13.1+0',
  board: 'nrf7002dk',
  purpose: 'update_everything',
  target: { kind: 'type', type: 'nrf7002dk' },
  note: '',
  createdAt: at(3_600_000),
  createdBy: { sub: 's', email: 'manager@example.invalid' },
  stage: 'stopped',
  things: [A, B, C],
  leftOut: [
    { thing: 'cranium-00000000000000dd', reason: 'bluetooth_only', text: 'Bluetooth only: updated from a phone' },
  ],
  canary: { size: 1, things: [A], job: CANARY_JOB },
  rest: { things: [B, C], leftOut: [], job: WAVES_JOB, startedAt: at(50 * 60_000) },
  wave: 1,
  abortPercent: 20,
  plan: [1, 1],
  stopped: {
    code: 'aborted',
    text: '1 of 1 finished boards failed, which reaches 20%: AWS IoT stopped the rest',
    at: at(40 * 60_000),
  },
  finishedAt: at(40 * 60_000),
  canaryJob: { id: CANARY_JOB, status: 'COMPLETED', executions: [{ thing: A, status: 'SUCCEEDED', reason: null }] },
  wavesJob: { id: WAVES_JOB, status: 'CANCELED', executions: [{ thing: B, status: 'FAILED', reason: 'rolled_back' }] },
  waves: [{ wave: 1, at: at(50 * 60_000), things: [B] }],
  notOffered: [C],
};

test("a staged rollout's page: the canary, the waves, what was never offered, and why it stopped", async () => {
  const { state, answers, ctx } = connected({ route: { view: 'rollout', id: ROLLOUT } });
  answers.set(`GET /api/rollouts/${ROLLOUT}`, { rollout: DETAIL });
  await fleet.refreshRollout(false);
  assert.equal(fleet.rolloutTitle(state.route, state), 'Staged rollout of 1.13.1+0');
  assert.equal(fleet.rolloutInterval(state), 0);
  const page = draw(fleet.rolloutView(ctx));
  assert.match(textOf(one(page, 'h1')), /Staged rollout of 1\.13\.1\+0/);
  assert.match(textOf(page), /Update everything: every nRF7002 DK/);
  assert.match(
    textOf(one(page, '.notice')),
    /Stopped\. 1 of 1 finished boards failed, which reaches 20%: AWS IoT stopped the rest\./
  );
  assert.deepEqual(all(one(page, 'ol.rollout-steps'), 'li').map(textOf), ['Canary', '2Waves', '3Stopped']);
  const cards = all(page, 'section.card');
  assert.match(textOf(cards[0]), /The canary.*Installed/s);
  assert.match(textOf(cards[1]), /Wave 1.*Failed \(rolled_back\).*Never offered.*Not offered yet/s);
  assert.match(textOf(cards[2]), /Left out: 1 board.*Bluetooth only/s);
  // Stopped: nothing left to cancel.
  assert.equal(
    all(page, 'button').some((el) => textOf(el) === 'Cancel rollout'),
    false
  );

  // While it is waiting for its canary, it is followed, and can be cancelled.
  state.rolloutDetails.get(ROLLOUT).value = fleet.readers.readRollout({
    ...DETAIL,
    stage: 'canary',
    stopped: null,
    rest: { things: [B, C], leftOut: [], job: null },
    waves: [],
    wavesJob: null,
  });
  assert.equal(fleet.rolloutInterval(state), 5000);
  const waiting = draw(fleet.rolloutView(ctx));
  assert.ok(all(waiting, 'button').some((el) => textOf(el) === 'Cancel rollout'));
  assert.match(textOf(waiting), /Waiting for the canary\. Planned: 1, then 1 boards\./);
});

test('the Deployments page lists the staged rollouts; the Fleet page has types, groups and Update everything', async () => {
  const { state, answers, ctx } = connected({ route: { view: 'fleet' }, deployments: loaded([]) });
  answers.set('GET /api/fleet', FLEET);
  answers.set('GET /api/rollouts', { rollouts: [{ ...DETAIL, stage: 'waves', stopped: null }] });
  answers.set('GET /api/fleet/health', { types: [], updates: {}, attention: [] });
  state.firmware.loadedAt = NOW;
  state.devices.loadedAt = NOW;
  await fleet.refreshFor('deployments', true);
  const panel = draw(fleet.rolloutsPanel(ctx));
  assert.equal(textOf(one(panel, 'p.rollout-title')), '1.13.1+0nRF7002 DK Waves under way');
  assert.equal(one(panel, 'a.rollout-version').getAttribute('href'), `#/rollouts/${ROLLOUT}`);
  const page = draw(fleet.fleetView(ctx));
  assert.deepEqual(
    all(page, 'div.fleet-type').map((el) => textOf(one(el, 'h2'))),
    ['nRF7002 DK', 'nRF5340 DK']
  );
  assert.ok(all(page, 'button').some((el) => textOf(el) === 'Update everything'));
});

test('the fleet asks the API at its own addresses only', async () => {
  const { asked, answers } = connected();
  answers.set('GET /api/fleet', FLEET);
  answers.set('POST /api/rollouts', { rollout: DETAIL });
  const types = await fleet.boardTypes();
  assert.deepEqual(types.get(C), { type: 'nrf5340dk', layout: 1, bluetoothOnly: true });
  const started = await fleet.startRollout({
    version: '1.13.1+0',
    things: [A, B],
    note: 'Evening',
    canary: 1,
    abortPercent: 20,
  });
  assert.equal(started.id, ROLLOUT);
  assert.deepEqual(asked.at(-1), [
    'POST',
    '/api/rollouts',
    { version: '1.13.1+0', target: { kind: 'boards', things: [A, B] }, canary: 1, abortPercent: 20, note: 'Evening' },
  ]);
});

test('the New deployment dialog offers a release to the boards of its type only', () => {
  const types = new Map(
    FLEET.boards.map((board) => [board.thing, { type: board.type, bluetoothOnly: board.bluetoothOnly }])
  );
  const devices = [device(A), device(B), device(C, { online: false, lastSeen: null, fw: null })];
  assert.deepEqual(
    core.offeredBoards(devices, types, { board: 'nrf7002dk' }).map((item) => item.thing),
    [A, B]
  );
  // A release of the Bluetooth-only type goes to no job at all.
  assert.deepEqual(core.offeredBoards(devices, types, { board: 'nrf5340dk' }), []);
  // Without the fleet's word every board is offered, and the server decides.
  assert.equal(core.offeredBoards(devices, null, { board: 'nrf5340dk' }).length, 3);
  // A release from a server before types is a nrf7002dk one.
  assert.deepEqual(
    core.offeredBoards(devices, types, { version: '1.0.0+0' }).map((item) => item.thing),
    [A, B]
  );

  const model = {
    step: 1,
    version: '1.13.1+0',
    things: new Set([A, B]),
    busy: new Map(),
    note: '',
    loading: false,
    loadError: null,
    releases: [
      {
        version: '1.13.1+0',
        board: 'nrf7002dk',
        size: 1000,
        sha256: 'a'.repeat(64),
        uploadedAt: at(60_000),
        uploadedBy: {},
        notes: '',
      },
    ],
    devices,
    types,
    canary: 1,
    abortPercent: 20,
    sending: false,
    error: null,
    close() {},
    toggle() {},
    toggleAll() {},
    next() {},
    back() {},
    choose() {},
    setNote() {},
    setCanary() {},
    setAbortPercent() {},
  };
  const ctx = { state: { now: NOW, me: { canWrite: true } }, actions: {}, fleet };
  const boards = draw(views.deployDialog(model, ctx));
  assert.equal(all(boards, 'input').filter((el) => el.getAttribute('type') === 'checkbox').length, 2);
  assert.match(
    textOf(boards),
    /For the nRF7002 DK, layout 1, only: 1 board of another type or flash layout, or without Wi-Fi, is not offered it\./
  );
  const review = draw(views.deployDialog({ ...model, step: 2 }, ctx));
  assert.match(textOf(review), /A staged rollout: 1 board gets 1\.13\.1\+0 first/);
  assert.ok(all(review, 'button').some((el) => textOf(el) === 'Start staged rollout to 2 boards'));
});

test("a release shows its board type and a clamped note; a release manager may edit any release's note", () => {
  const release = (changes) => ({
    version: '1.13.1+0',
    size: 1000,
    sha256: 'a'.repeat(64),
    imageHash: '',
    keyHash: '',
    payloadSize: 900,
    headerSize: 512,
    loadAddress: 196608,
    filename: 'zephyr.signed.bin',
    notes: 'Reconnects faster after the Wi-Fi drops out.',
    uploadedBy: { sub: 's', email: 'manager@example.invalid' },
    uploadedAt: at(60_000),
    status: 'active',
    revoked: null,
    board: 'nrf5340dk',
    ...changes,
  });
  const calls = [];
  const page = (canWrite, releases) =>
    draw(
      views.firmwareView({
        state: {
          now: NOW,
          me: { canWrite },
          route: { view: 'firmware' },
          upload: { stage: 'idle', over: false },
          firmware: loaded({ releases, fingerprint: 'd'.repeat(64), slotSize: 933888 }),
          deployments: loaded([]),
          devices: loaded({ devices: [] }),
        },
        actions: new Proxy(
          {},
          {
            get:
              (target, name) =>
              (...args) =>
                calls.push([name, ...args]),
          }
        ),
      })
    );
  const written = page(true, [
    release({}),
    release({ version: '1.13.0+0', status: 'revoked', revoked: { by: {}, at: at(1000), reason: 'bad' } }),
  ]);
  const rows = all(written, 'li.release');
  assert.equal(textOf(one(rows[0], 'span.board-chip')), 'For nRF5340 DK · layout 1');
  // And in its details, where it was read from.
  assert.match(
    textOf(one(rows[0], 'details')),
    /Compatible with nRF5340 DK, flash layout 1 Read from the image’s signed TLVs/
  );
  const note = one(rows[0], 'p.release-notes');
  assert.equal(note.getAttribute('title'), 'Reconnects faster after the Wi-Fi drops out.');
  assert.match(note.getAttribute('class'), /is-clamped/);
  // On the revoked release too.
  for (const row of rows) one(row, 'button', 'Edit note').dispatchEvent({ type: 'click' });
  assert.deepEqual(
    calls.filter(([name]) => name === 'openNotes').map(([, item]) => item.version),
    ['1.13.1+0', '1.13.0+0']
  );
  // A viewer reads the note and has no button for it.
  assert.equal(
    all(page(false, [release({})]), 'button').some((el) => textOf(el) === 'Edit note'),
    false
  );

  const dialog = draw(
    views.notesDialog({
      release: release({}),
      notes: 'x'.repeat(480),
      sending: false,
      error: null,
      close() {},
      setNotes() {},
      submit() {},
    })
  );
  assert.match(textOf(dialog), /20 characters left/);
});

test("the client sends a note with PUT and asks the fleet's addresses only", async () => {
  const calls = [];
  const api = core.createApi({
    auth: { accessToken: () => 'T' },
    crypto: globalThis.crypto,
    clock: core.createClock(),
    onUnauthorized() {},
    pause: async () => {},
    fetch: async (path, options) => {
      calls.push([options.method, path, options.body]);
      return new Response(
        JSON.stringify({ release: { version: '1.11.3+0', notes: 'Fixed', status: 'active', board: 'nrf7002dk' } }),
        { status: 200 }
      );
    },
  });
  const release = await api.setNotes('1.11.3+0', 'Fixed');
  assert.deepEqual(calls[0], ['PUT', '/api/firmware/1.11.3%2B0/notes', JSON.stringify({ notes: 'Fixed' })]);
  assert.deepEqual([release.notes, release.board], ['Fixed', 'nrf7002dk']);
  for (const [method, path] of [
    ['GET', '/api/tokens'],
    ['DELETE', '/api/groups'],
    ['GET', '/api/fleet/../tokens'],
    ['GET', 'https://elsewhere/api/fleet'],
  ]) {
    await assert.rejects(api.fleetRequest(method, path), (error) => error.code === 'bad_request', path);
  }
  await api.fleetRequest('GET', '/api/groups/grp-0a0b0c0d/rollback');
  assert.deepEqual(calls.at(-1).slice(0, 2), ['GET', '/api/groups/grp-0a0b0c0d/rollback']);
});

test('a rollout has an address of its own, under the Fleet section', () => {
  assert.deepEqual(core.parseRoute(`#/rollouts/${ROLLOUT}`), { view: 'rollout', id: ROLLOUT });
  assert.equal(core.routeHash({ view: 'rollout', id: ROLLOUT }), `#/rollouts/${ROLLOUT}`);
  assert.equal(core.parseRoute('#/rollouts/rol-1'), null);
  assert.deepEqual(core.parseRoute('#/fleet'), { view: 'fleet' });
  const nav = draw(views.navView({ state: { route: { view: 'rollout', id: ROLLOUT } } }));
  assert.equal(one(nav, 'a', 'Fleet').getAttribute('aria-current'), 'page');
});

test("the activity log tells the fleet's changes in words, the note of a release among them", () => {
  const entry = (action, target, detail = [], extra = {}) => ({
    at: at(60_000),
    actor: { sub: 's', email: 'manager@example.invalid' },
    action,
    target,
    outcome: 'ok',
    detail,
    requestId: 'r',
    ...extra,
  });
  const notes = entry('firmware.notes', '1.11.3+0', [
    ['notes', 'Fixed the LED'],
    ['oldLength', '0'],
  ]);
  assert.equal(core.auditSentence(notes), 'manager@example.invalid changed the note of 1.11.3+0');
  const described = core.describeAudit(notes);
  assert.deepEqual(
    described.facts.map((fact) => [fact.label, fact.value]),
    [
      ['New note', 'Fixed the LED'],
      ['Old note', 'none'],
    ]
  );
  assert.equal(described.href, '#/firmware');
  assert.equal(
    core.describeAudit(
      entry('firmware.notes', '1.11.3+0', [
        ['notes', ''],
        ['oldLength', '12'],
      ])
    ).facts[1].value,
    '12 characters'
  );

  for (const [action, words] of [
    ['group.create', 'made the group'],
    ['group.update', 'changed the group'],
    ['group.delete', 'deleted the group'],
    ['group.rollback', 'rolled back the group'],
    ['rollout.create', 'started a staged rollout of'],
    ['rollout.cancel', 'cancelled the staged rollout'],
    ['fleet.update_everything', 'started updating everything'],
    ['device.seen', 'saw'],
  ]) {
    assert.equal(core.describeAudit(entry(action, 'x')).verb, words, action);
  }
  // What the schedule did is the console's own, and leads to the rollout.
  const advanced = entry(
    'rollout.advance',
    ROLLOUT,
    [
      ['version', '1.13.1+0'],
      ['things', '2'],
      ['job', WAVES_JOB],
    ],
    { actor: { sub: '', email: '' } }
  );
  assert.equal(core.auditSentence(advanced), 'The console went on with the staged rollout 1.13.1+0');
  assert.equal(
    core.auditSentence(entry('group.create', 'grp-0a0b0c0d', [['name', 'Bench']])),
    'manager@example.invalid made the group Bench'
  );
  assert.equal(core.describeAudit(advanced).href, `#/rollouts/${ROLLOUT}`);
  // The refusals of the fleet have words too.
  const refused = core.describeAudit({
    ...entry('deployment.create', '1.13.1+0', [['code', 'incompatible_board']]),
    outcome: 'rejected',
  });
  assert.equal(refused.facts.find((fact) => fact.key === 'code').words, 'The release is for another type of board');
});

test('a release is offered to the boards of its flash layout only, and says what it is built for', () => {
  const types = new Map([
    [A, { type: 'nrf7002dk', layout: 1, bluetoothOnly: false }],
    [B, { type: 'nrf7002dk', layout: 2, bluetoothOnly: false }],
  ]);
  const devices = [device(A), device(B)];
  assert.deepEqual(
    core.offeredBoards(devices, types, { board: 'nrf7002dk', layout: 2 }).map((item) => item.thing),
    [B]
  );
  assert.deepEqual(
    core.offeredBoards(devices, types, { board: 'nrf7002dk' }).map((item) => item.thing),
    [A]
  );
  assert.equal(core.compatibilityWords({ board: 'nrf7002dk', layout: 2 }), 'For nRF7002 DK · layout 2');
  assert.equal(core.compatibilityWords({ version: '1.0.0+0' }), '');
  const refused = core.describeAudit({
    at: at(1000),
    actor: { sub: 's', email: 'e' },
    action: 'deployment.create',
    target: '1.13.1+0',
    outcome: 'rejected',
    detail: [['code', 'incompatible_layout']],
    requestId: 'r',
  });
  assert.equal(
    refused.facts.find((fact) => fact.key === 'code').words,
    'The release is built for another flash layout'
  );
});

test("a board's page says its type and layout, where each is known from, and the newest release it can take", async () => {
  const releases = [
    { version: '1.13.1+0', board: 'nrf7002dk', layout: 2, status: 'active' },
    { version: '1.13.0+0', board: 'nrf7002dk', layout: 1, status: 'active' },
  ];
  const { state, answers, ctx } = connected({ firmware: loaded({ releases }) });
  answers.set('GET /api/fleet', {
    ...FLEET,
    boards: FLEET.boards.map((board) => (board.thing === A ? { ...board, layout: 1, layoutFrom: 'thing' } : board)),
  });
  await fleet.refreshFor('device', true);
  const card = draw(fleet.compatibilityCard(state.devices.value.devices[0], ctx));
  assert.match(textOf(card), /Board type nRF7002 DK as it says itself/);
  assert.match(textOf(card), /Flash layout 1 as its thing says/);
  assert.match(textOf(card), /Takes 1\.13\.0\+0 is the newest release built for it/);
  // A board without Wi-Fi with nothing built for it yet.
  assert.match(
    textOf(draw(fleet.compatibilityCard(state.devices.value.devices[2], ctx))),
    /No release is built for it yet.*Over Bluetooth from the phone app/
  );
});

test('the Overview says the newest release of each board type, and a board without Wi-Fi is not one that never connected', async () => {
  const releases = [
    {
      version: '1.13.0+1',
      board: 'nrf5340dk',
      layout: 1,
      status: 'active',
      uploadedAt: at(3_600_000),
      uploadedBy: { sub: 's', email: 'e' },
      size: 9,
      sha256: 'a'.repeat(64),
    },
    {
      version: '1.13.0+0',
      board: 'nrf7002dk',
      layout: 1,
      status: 'active',
      uploadedAt: at(7_200_000),
      uploadedBy: { sub: 's', email: 'e' },
      size: 9,
      sha256: 'b'.repeat(64),
    },
  ];
  const { state, answers, ctx } = connected({
    firmware: loaded({ releases, fingerprint: 'd'.repeat(64), slotSize: 933888 }),
  });
  answers.set('GET /api/fleet', { ...FLEET, boards: FLEET.boards.map((board) => ({ ...board, layout: 1 })) });
  answers.set('GET /api/fleet/health', { types: [], updates: {}, attention: [] });
  await fleet.refreshFor('overview', true);
  const page = draw(views.overviewView(ctx));
  const newest = all(page, 'section.card').find((el) => textOf(el).startsWith('Newest releases'));
  assert.deepEqual(
    all(newest, 'li').map((el) => textOf(one(el, 'span.board-chip'))),
    ['For nRF5340 DK · layout 1', 'For nRF7002 DK · layout 1']
  );
  assert.match(textOf(newest), /1\.13\.0\+1.*0 of 1 board on it.*1\.13\.0\+0.*1 of 2 boards on it/s);
  const online = all(page, 'section.card').find((el) => textOf(el).startsWith('Fleet'));
  assert.match(textOf(online), /2 of 2 boards online/);
  assert.match(textOf(online), /1 Bluetooth only/);
  assert.doesNotMatch(textOf(online), /never connected/);
  assert.equal(all(online, 'span.tile').filter((el) => el.getAttribute('class').includes('is-phone')).length, 1);

  // Without the fleet's word, as before: one card for the newest, and the board counted as it reported.
  const before = draw(views.overviewView({ state: { ...state, fleet: { value: null } }, actions: {} }));
  assert.match(textOf(all(before, 'section.card').find((el) => textOf(el).startsWith('Fleet'))), /1 never connected/);
});

test('the roll back review says that a real roll-back is a rebuild of the old source under a newer version', async () => {
  const { state, answers, ctx } = connected();
  answers.set('GET /api/fleet', FLEET);
  answers.set('GET /api/groups/grp-0a0b0c0d/rollback', {
    plan: {
      group: { id: 'grp-0a0b0c0d', name: 'Bench' },
      types: [
        {
          type: 'nrf7002dk',
          release: { version: '1.13.0+0', layout: 1, notes: '' },
          from: '1.13.1+0',
          things: [],
          leftOut: [
            {
              thing: A,
              reason: 'older_refused',
              text: 'Runs 1.13.1+0: a board takes only firmware newer than what it runs',
            },
          ],
          canary: [],
        },
      ],
    },
  });
  await fleet.refreshFor('devices', true);
  // The dialog as app.js would open it: drawn from what it builds.
  let build = null;
  fleet.connect({
    state,
    api: { fleetRequest: async (method, path) => answers.get(`${method} ${path}`) },
    load: async () => {},
    draw: () => {},
    clock: { now: () => NOW },
    refresh: () => {},
    notify: () => {},
    keep: () => {},
    go: () => {},
    dialogs: {
      open: (made) => {
        build = made;
        return { redraw() {}, close() {} };
      },
      submit: () => {},
      isOpen: () => false,
      signIn: () => {},
    },
  });
  one(draw(fleet.groupsCard(ctx)), 'button', 'Roll back').dispatchEvent({ type: 'click' });
  await new Promise((resolve) => setImmediate(resolve));
  const dialog = draw(build());
  assert.match(textOf(dialog), /Roll back Bench/);
  assert.match(textOf(dialog), /A real roll-back is a rebuild of the old source under a newer version/);
  assert.match(textOf(dialog), /Would refuse it/);
  assert.match(textOf(dialog), /nRF7002 DK · layout 1 1\.13\.0\+0 instead of 1\.13\.1\+0/);
});

// The stages after the canary (console 2.8.0).

const STAGE_JOB = 'cranium-1-13-1-b0-20261104T112000Z-cccc';
const D = 'cranium-00000000000000dd';
const E = 'cranium-00000000000000ee';
const STAGED = {
  ...DETAIL,
  purpose: 'deploy',
  target: { kind: 'group', group: 'grp-0a0b0c0d', groupName: 'Bench' },
  stage: 'stages',
  stopped: null,
  finishedAt: null,
  things: [A, B, C, D, E],
  leftOut: [],
  canary: { size: 1, things: [A], job: CANARY_JOB, doneAt: at(30 * 60_000) },
  rest: { things: [B, C, D, E], leftOut: [], job: null, startedAt: null },
  current: 0,
  soakMinutes: 5,
  stages: [
    {
      n: 1,
      things: [B, C],
      leftOut: [],
      job: STAGE_JOB,
      startedAt: at(25 * 60_000),
      doneAt: null,
      state: 'running',
      counts: { done: 1, inProgress: 1, failed: 0, waiting: 0, total: 2 },
      deployment: {
        id: STAGE_JOB,
        status: 'IN_PROGRESS',
        executions: [
          { thing: B, status: 'SUCCEEDED', reason: null },
          { thing: C, status: 'IN_PROGRESS', reason: null },
        ],
      },
    },
    {
      n: 2,
      things: [D, E],
      leftOut: [],
      job: null,
      startedAt: null,
      doneAt: null,
      state: 'next',
      counts: { done: 0, inProgress: 0, failed: 0, waiting: 2, total: 2 },
      deployment: null,
    },
  ],
  wavesJob: null,
  waves: [],
  notOffered: [],
};

test("a staged rollout's page shows each stage: its boards, how far they are, and when it runs", async () => {
  const { state, answers, ctx } = connected({ route: { view: 'rollout', id: ROLLOUT } });
  answers.set(`GET /api/rollouts/${ROLLOUT}`, { rollout: STAGED });
  await fleet.refreshRollout(false);
  // Open: followed every few seconds, as the live updates bring changes.
  assert.equal(fleet.rolloutInterval(state), 5000);
  const page = draw(fleet.rolloutView(ctx));
  assert.deepEqual(all(one(page, 'ol.rollout-steps'), 'li').map(textOf), ['Canary', '2Stage 1', '3Stage 2', '4Done']);
  assert.match(textOf(page), /2 stages after the canary\. Each goes to all its boards at once/);
  assert.match(textOf(page), /and 5 minutes after/);
  const stages = all(page, 'section.rollout-stage');
  assert.equal(stages.length, 2);
  assert.match(textOf(stages[0]), /Stage 1: 2 boards/);
  assert.match(textOf(stages[0]), /In progress 1 done · 1 in progress · 0 failed · 0 waiting/);
  assert.match(textOf(stages[0]), /Started /);
  assert.equal(one(stages[0], 'a', 'Its deployment').getAttribute('href'), core.deploymentHref(STAGE_JOB));
  assert.match(textOf(stages[1]), /Stage 2: 2 boards.*Next.*Starts once stage 1 has ended, and 5 minutes after/s);
  assert.match(textOf(stages[1]), /Not offered yet/);
  assert.ok(all(page, 'button').some((el) => textOf(el) === 'Cancel rollout'));

  // Stage 1 has ended: stage 2 is due once the soak time is over.
  const ended = structuredClone(STAGED);
  ended.stages[0] = { ...ended.stages[0], doneAt: at(2 * 60_000), state: 'done' };
  state.rolloutDetails.get(ROLLOUT).value = fleet.readers.readRollout(ended);
  const soaking = draw(fleet.rolloutView(ctx));
  assert.deepEqual(all(one(soaking, 'ol.rollout-steps'), 'li').map(textOf), ['Canary', 'Stage 1', '3Stage 2', '4Done']);
  assert.match(textOf(all(soaking, 'section.rollout-stage')[1]), /Starts in 3 minutes/);

  // Stopped in stage 1: stage 2 never starts.
  const stopped = structuredClone(STAGED);
  stopped.stage = 'stopped';
  stopped.stopped = { code: 'aborted', text: 'Stage 1: 1 of 2 finished boards failed', at: at(60_000) };
  stopped.stages[0].state = 'stopped';
  stopped.stages[1].state = 'never';
  state.rolloutDetails.get(ROLLOUT).value = fleet.readers.readRollout(stopped);
  const over = draw(fleet.rolloutView(ctx));
  assert.deepEqual(all(one(over, 'ol.rollout-steps'), 'li').map(textOf), [
    'Canary',
    '2Stage 1',
    '3Stage 2',
    '4Stopped',
  ]);
  assert.match(textOf(all(over, 'section.rollout-stage')[1]), /Never started/);
  assert.equal(fleet.rolloutInterval(state), 0);
});

test("a health gate shows on the rollout's page, and when it stopped the rollout, the board and the Memfault issue", async () => {
  const { state, answers, ctx } = connected({ route: { view: 'rollout', id: ROLLOUT } });
  const gated = { ...structuredClone(STAGED), healthGate: { minutes: 10 } };
  gated.canary.gatePassedAt = at(20 * 60_000);
  answers.set(`GET /api/rollouts/${ROLLOUT}`, { rollout: gated });
  await fleet.refreshRollout(false);
  const page = draw(fleet.rolloutView(ctx));
  assert.match(textOf(page), /Health gate: after the canary and each stage, the next waits 10 minutes/);
  const read = fleet.readers.readRollout(gated);
  assert.deepEqual([read.healthGate, read.canary.gatePassedAt], [{ minutes: 10 }, at(20 * 60_000)]);
  assert.equal(fleet.readers.readRollout({ ...gated, healthGate: { minutes: 500 } }).healthGate, null);

  const failed = structuredClone(gated);
  failed.stage = 'stopped';
  failed.stopped = {
    code: 'health_failed',
    text: `After stage 1, the health gate failed: ${B} has a new Memfault issue on this version, #21 "Assert at read"`,
    at: at(60_000),
    thing: B,
    issue: { id: 21, title: 'Assert at read' },
  };
  state.rolloutDetails.get(ROLLOUT).value = fleet.readers.readRollout(failed);
  const over = draw(fleet.rolloutView(ctx));
  const notice = one(over, '.notice');
  assert.match(textOf(notice), /Stopped\. After stage 1, the health gate failed/);
  assert.equal(one(notice, 'a', '#21 Assert at read').getAttribute('href'), '#/memfault/21');
  assert.match(textOf(notice), /Board: /);
  assert.equal(core.REFUSAL_WORDS.invalid_healthGate, 'The health gate was not on or off with 0 to 120 minutes');
});

test('the stage choices: what is sent, the split the server will make, and the warnings', () => {
  assert.deepEqual(
    fleet.stageBody({ stages: 1, unit: 'even', sizes: [], soakMinutes: 0, healthGate: false, gateMinutes: 10 }),
    {
      stages: 1,
      soakMinutes: 0,
      healthGate: { on: false, minutes: 10 },
    }
  );
  const model = { stages: 3, unit: 'percent', sizes: [10, 30], soakMinutes: 5 };
  assert.deepEqual(fleet.stageBody(model), {
    stages: 3,
    soakMinutes: 5,
    batch: { unit: 'percent', sizes: [10, 30] },
  });
  assert.deepEqual(fleet.stageBody({ stages: 3, unit: 'count', sizes: [2], soakMinutes: 0 }).batch, {
    unit: 'count',
    sizes: [2, 2],
  });
  assert.deepEqual(fleet.stageBody({ stages: 3, unit: 'even', sizes: [], soakMinutes: 0 }), {
    stages: 3,
    soakMinutes: 0,
  });
  assert.deepEqual(fleet.stageBody({ stages: 1, unit: 'count', sizes: [4], soakMinutes: 0 }), {
    stages: 1,
    soakMinutes: 0,
  });
  assert.deepEqual(fleet.plannedSizes(99, model), [10, 30, 59]);
  assert.deepEqual(fleet.plannedSizes(10, { stages: 3, unit: 'even', sizes: [], soakMinutes: 0 }), [3, 3, 4]);
  assert.deepEqual(fleet.plannedSizes(9, model), [1, 3, 5]);
  assert.deepEqual(fleet.plannedSizes(0, model), []);
  assert.deepEqual(fleet.stageWarnings([1, 3, 5]), ['Stage 1 has 1 board: too few to tell anything about the next.']);
  assert.deepEqual(fleet.stageWarnings([2, 7]), []);
  assert.deepEqual(fleet.stageWarnings([1]), []);
});

test('Roll out to a group pre-fills the suggestion with its reasons, and sends the choices', async () => {
  const releases = [
    {
      version: '1.13.1+0',
      board: 'nrf7002dk',
      status: 'active',
      size: 1000,
      sha256: 'a'.repeat(64),
      uploadedAt: at(60_000),
      uploadedBy: {},
      notes: '',
    },
  ];
  const { state, answers, asked, ctx } = connected({ firmware: loaded({ releases }) });
  answers.set('GET /api/fleet', FLEET);
  answers.set(`GET /api/rollouts/suggest?release=${encodeURIComponent('1.13.1+0')}&group=grp-0a0b0c0d`, {
    suggestion: {
      things: [A, B, D, E, 'cranium-00000000000000ff'],
      canary: [A],
      canarySize: 1,
      stageCount: 2,
      stages: [
        { size: 2, percent: 50, offline: 0 },
        { size: 2, percent: 50, offline: 1 },
      ],
      batch: { unit: 'count', sizes: [2] },
      soakMinutes: 5,
      healthGate: { on: true, minutes: 15 },
      abortPercent: 20,
      reasons: {
        canary: 'One board, online, with a clean update history: it goes first.',
        health: 'Health gate on, 15 minutes: the next stage waits for no new Memfault issue.',
        stages: '2 stages that grow (50% → 50%)',
        batch: '2 boards, and the last stage takes the rest.',
        soak: '5 minutes: a few minutes between stages.',
        offline: '1 board is offline: it is in the last stage, and takes it when back.',
      },
      warnings: ['Most of the group is offline (3 of 5): the rollout waits for them.'],
    },
  });
  answers.set('POST /api/rollouts', { rollout: STAGED });
  await fleet.refreshFor('devices', true);
  let build = null;
  let submitted = null;
  fleet.connect({
    state,
    api: {
      async fleetRequest(method, path, body) {
        asked.push([method, path, body]);
        return answers.get(`${method} ${path}`);
      },
    },
    load: async () => {},
    draw: () => {},
    clock: { now: () => NOW },
    refresh: () => {},
    notify: () => {},
    keep: () => {},
    go: () => {},
    dialogs: {
      open: (made) => {
        build = made;
        return { redraw() {}, close() {} };
      },
      submit: (self, model, run) => {
        submitted = run;
      },
      isOpen: () => false,
      signIn: () => {},
    },
  });
  one(draw(fleet.groupsCard(ctx)), 'button', 'Roll out').dispatchEvent({ type: 'click' });
  await new Promise((resolve) => setImmediate(resolve));
  const dialog = draw(build());
  assert.match(textOf(dialog), /Suggested, and filled in below: change anything/);
  assert.match(textOf(dialog), /One board, online, with a clean update history/);
  assert.match(textOf(dialog), /1 board is offline: it is in the last stage/);
  assert.match(textOf(dialog), /Most of the group is offline \(3 of 5\)/);
  assert.match(textOf(dialog), /After the canary: stage 1, 2 boards; stage 2, 2 boards\./);
  assert.match(textOf(dialog), /the rest follow in 2 stages, each to all its boards at once/);
  // The health gate: on, with the suggested minutes, and said in "What happens".
  assert.match(textOf(dialog), /Health gate on, 15 minutes/);
  assert.equal(all(dialog, 'input').find((el) => el.getAttribute('name') === 'health-gate').checked, true);
  assert.match(textOf(dialog), /run it for 15 minutes with no new Memfault issue and no unexpected reboot/);
  const value = (key) => all(dialog, 'input').find((el) => el.getAttribute('min') !== null && key(el));
  assert.ok(
    value((el) => el.getAttribute('max') === '10' && String(el.value) === '2'),
    'stages: 2'
  );
  assert.ok(
    value((el) => el.getAttribute('max') === '60' && String(el.value) === '5'),
    'soak: 5'
  );

  // The person changes the number of stages; what is sent is what the dialog shows.
  value((el) => el.getAttribute('max') === '10').dispatchEvent({ type: 'input', target: { value: '3' } });
  const changed = draw(build());
  assert.match(textOf(changed), /the rest follow in 3 stages/);
  // Two batches of two take the four boards after the canary: the third stage would be empty.
  assert.match(textOf(changed), /After the canary: stage 1, 2 boards; stage 2, 2 boards\./);
  submitted = null;
  one(changed, 'form')?.dispatchEvent({ type: 'submit' });
  if (submitted === null) one(changed, 'button', 'Start staged rollout').dispatchEvent({ type: 'click' });
  assert.equal(typeof submitted, 'function');
  await submitted();
  assert.deepEqual(asked.at(-1), [
    'POST',
    '/api/rollouts',
    {
      version: '1.13.1+0',
      target: { kind: 'group', group: 'grp-0a0b0c0d' },
      canary: 1,
      stages: 3,
      soakMinutes: 5,
      batch: { unit: 'count', sizes: [2, 2] },
      healthGate: { on: true, minutes: 15 },
      abortPercent: 20,
    },
  ]);
});
