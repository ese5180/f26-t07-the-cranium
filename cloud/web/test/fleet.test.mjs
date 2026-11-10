/**
 * Tests for the fleet's part of the console (fleet.js, and what core.js and views.js do for it):
 * board types and groups on the Devices page, the health card on the Overview, a staged rollout's
 * page, the New deployment dialog offering a release to the boards of its type only, a release's
 * note, and how the activity log tells all of it. The scripts are the very files the browser loads,
 * drawing into the stand-in document of page.mjs.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE, TELEMETRY, VIEWS, all, createDocument, one, scriptAddress, textOf } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
const fleet = await import(
  scriptAddress('fleet.js', { 'core.js': CORE, 'views.js': VIEWS, 'telemetry.js': TELEMETRY })
);
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
  // The old group "Roll back" is gone: only "Roll back to last good" remains.
  assert.equal(
    all(groups, 'button').some((el) => textOf(el) === 'Roll back'),
    false
  );
});

test('a viewer has no group buttons', async () => {
  const { state, answers, ctx } = connected();
  answers.set('GET /api/fleet', FLEET);
  await fleet.refreshFor('devices', true);
  state.me = { canWrite: false };
  assert.equal(all(draw(fleet.groupsCard(ctx)), 'button').length, 0);
});

test("the Overview's health card: versions by type, the last week's updates, and the boards to look at", async () => {
  const { state, answers, ctx } = connected({ route: { view: 'overview' } });
  answers.set('GET /api/fleet', FLEET);
  answers.set('GET /api/fleet/health?days=30', {
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
  answers.set('GET /api/fleet/health?days=30', { types: [], updates: {}, attention: [] });
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
  await api.fleetRequest('GET', '/api/groups/grp-0a0b0c0d/last-good');
  assert.deepEqual(calls.at(-1).slice(0, 2), ['GET', '/api/groups/grp-0a0b0c0d/last-good']);
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
  answers.set('GET /api/fleet/health?days=30', { types: [], updates: {}, attention: [] });
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

// Roll back to last good (console 2.14.0).

const LAST_GOOD_PLAN = {
  scope: { kind: 'group', id: 'grp-0a0b0c0d', name: 'Bench' },
  targets: [
    {
      type: 'nrf7002dk',
      label: 'nRF7002 DK',
      release: { version: '1.13.2+0', board: 'nrf7002dk', layout: 1, notes: 'Rebuild of 1.13.0', rebuildOf: '1.13.0' },
      boards: [
        { thing: A, from: '1.13.1+0', to: '1.13.0+0', how: 'ran_before' },
        { thing: B, from: '1.13.1+0', to: '1.13.0+0', how: 'kept' },
      ],
      things: [A, B],
      leftOut: [],
      canary: [A],
    },
  ],
  leftOut: [
    {
      thing: C,
      reason: 'no_good',
      text: 'No version it ran confirmed before the one it runs',
      from: '1.0.0+0',
      to: null,
    },
    {
      thing: 'cranium-00000000000000dd',
      reason: 'no_rebuild',
      text: 'Its last good version is 1.12.0+0, older than 1.13.1+0',
      from: '1.13.1+0',
      to: '1.12.0+0',
    },
  ],
  healthGate: { on: true, minutes: 10 },
};

/** The fleet module with a dialog that is drawn and submitted as app.js would, and what was posted. */
function lastGoodConsole() {
  const { state, answers, ctx } = connected();
  const posted = [];
  const went = [];
  let build = null;
  let closed = false;
  fleet.connect({
    state,
    api: {
      fleetRequest: async (method, path, body) => {
        if (method === 'POST') posted.push([path, body]);
        if (!answers.has(`${method} ${path}`)) throw new core.ApiError(404, 'not_found', 'Nothing there');
        return answers.get(`${method} ${path}`);
      },
    },
    load: async (target, fetcher) => {
      target.value = await fetcher();
      target.loadedAt = NOW;
    },
    draw: () => {},
    clock: { now: () => NOW },
    refresh: () => {},
    notify: () => {},
    keep: () => {},
    go: (where) => went.push(where),
    dialogs: {
      open: (made) => {
        build = made;
        return {
          redraw() {},
          close() {
            closed = true;
          },
        };
      },
      submit: async (self, model, run) => run(),
      isOpen: () => false,
      signIn: () => {},
    },
  });
  return { state, answers, ctx, posted, went, dialog: () => draw(build()), closed: () => closed };
}

test('a group and the Fleet page offer Roll back to last good, to release managers only', async () => {
  const { state, answers, ctx } = lastGoodConsole();
  answers.set('GET /api/fleet', FLEET);
  answers.set('GET /api/rollouts', { rollouts: [] });
  answers.set('GET /api/fleet/health?days=30', { types: [], updates: {}, attention: [] });
  await fleet.refreshFor('devices', true);
  assert.ok(all(draw(fleet.groupsCard(ctx)), 'button').some((el) => textOf(el) === 'Roll back to last good'));
  state.route = { view: 'fleet' };
  state.firmware.loadedAt = NOW;
  state.devices.loadedAt = NOW;
  assert.ok(all(draw(fleet.fleetView(ctx)), 'button').some((el) => textOf(el) === 'Roll back to last good'));
  state.me = { canWrite: false };
  assert.ok(!all(draw(fleet.groupsCard(ctx)), 'button').some((el) => textOf(el) === 'Roll back to last good'));
  assert.ok(!all(draw(fleet.fleetView(ctx)), 'button').some((el) => textOf(el) === 'Roll back to last good'));
});

test('the preview: each board from and to under its release, the canary, what is left out and why, the gate always on', async () => {
  const { answers, ctx, dialog } = lastGoodConsole();
  answers.set('GET /api/fleet', FLEET);
  answers.set('GET /api/groups/grp-0a0b0c0d/last-good', { plan: LAST_GOOD_PLAN });
  await fleet.refreshFor('devices', true);
  one(draw(fleet.groupsCard(ctx)), 'button', 'Roll back to last good').dispatchEvent({ type: 'click' });
  await new Promise((resolve) => setImmediate(resolve));
  const shown = dialog();
  const text = textOf(shown);
  assert.match(text, /Roll back Bench to last good/);
  assert.match(text, /nRF7002 DK · layout 1 1\.13\.2\+0 rebuild of 1\.13\.0/);
  assert.match(text, /1\.13\.1\+0 → 1\.13\.0\+0 · the canary: it goes first/);
  assert.match(text, /a release whose note says "Rebuild of <version>"/);
  assert.match(text, /Left out: 2 boards with nowhere to go/);
  assert.match(text, /No known good version/);
  assert.match(text, /No rebuild of it yet.*older than 1\.13\.1\+0/);
  assert.match(text, /Health gate: always on for a roll back/);
  // No switch to turn it off.
  assert.equal(all(shown, 'input').filter((el) => el.getAttribute('name') === 'health-gate').length, 0);
  assert.equal(all(shown, 'input').filter((el) => el.getAttribute('type') === 'checkbox').length, 2);
  assert.match(textOf(all(shown, 'button').at(-1)), /Roll back: 2 boards/);

  const plan = fleet.readers.readLastGoodPlan(LAST_GOOD_PLAN);
  assert.deepEqual(plan.leftOut[1], {
    thing: 'cranium-00000000000000dd',
    reason: 'no_rebuild',
    text: 'Its last good version is 1.12.0+0, older than 1.13.1+0',
    from: '1.13.1+0',
    to: '1.12.0+0',
  });
  assert.deepEqual(plan.healthGate, { on: true, minutes: 10 });
});

test('the dialog starts one staged rollout per release with the health gate on, for a group or the fleet', async () => {
  const { answers, ctx, posted, went, dialog, closed } = lastGoodConsole();
  answers.set('GET /api/fleet', FLEET);
  answers.set('GET /api/groups/grp-0a0b0c0d/last-good', { plan: LAST_GOOD_PLAN });
  const started = {
    ...DETAIL,
    purpose: 'last_good',
    target: { kind: 'group', group: 'grp-0a0b0c0d', groupName: 'Bench', type: 'nrf7002dk' },
  };
  answers.set('POST /api/groups/grp-0a0b0c0d/last-good', { rollouts: [started] });
  await fleet.refreshFor('devices', true);
  one(draw(fleet.groupsCard(ctx)), 'button', 'Roll back to last good').dispatchEvent({ type: 'click' });
  await new Promise((resolve) => setImmediate(resolve));
  one(dialog(), 'form').dispatchEvent({ type: 'submit', preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posted, [
    [
      '/api/groups/grp-0a0b0c0d/last-good',
      {
        targets: [{ version: '1.13.2+0', things: [A, B] }],
        canary: 1,
        stages: 1,
        soakMinutes: 0,
        healthGate: { on: true, minutes: 10 },
        abortPercent: 20,
      },
    ],
  ]);
  assert.ok(closed());
  assert.deepEqual(went, [{ view: 'rollout', id: ROLLOUT }]);

  // The rollout says what it is.
  const page = connected({ route: { view: 'rollout', id: ROLLOUT } });
  page.answers.set(`GET /api/rollouts/${ROLLOUT}`, { rollout: started });
  await fleet.refreshRollout(false);
  assert.match(textOf(draw(fleet.rolloutView(page.ctx))), /Roll back to last good: the group Bench/);
});

test('the fleet asks for its own plan, and nothing is offered when no board has somewhere to go', async () => {
  const { state, answers, ctx, posted, dialog } = lastGoodConsole();
  answers.set('GET /api/fleet', FLEET);
  answers.set('GET /api/rollouts', { rollouts: [] });
  answers.set('GET /api/fleet/health?days=30', { types: [], updates: {}, attention: [] });
  answers.set('GET /api/fleet/last-good', { plan: { ...LAST_GOOD_PLAN, scope: { kind: 'fleet' }, targets: [] } });
  await fleet.refreshFor('devices', true);
  state.route = { view: 'fleet' };
  state.firmware.loadedAt = NOW;
  state.devices.loadedAt = NOW;
  // The page's own, beside Update everything; each group has one too.
  all(draw(fleet.fleetView(ctx)), 'button')
    .find((el) => textOf(el) === 'Roll back to last good' && !el.getAttribute('class').includes('is-small'))
    .dispatchEvent({ type: 'click' });
  await new Promise((resolve) => setImmediate(resolve));
  const shown = dialog();
  assert.match(textOf(shown), /Roll back the fleet to last good/);
  assert.match(textOf(shown), /No board has a last good version it can be sent/);
  assert.match(textOf(all(shown, 'button').at(-1)), /Nothing to roll back/);
  assert.deepEqual(posted, []);
});

const SCORE = {
  value: 72,
  days: 7,
  change: 5,
  historyDays: 30,
  memfault: { state: 'ok', message: '' },
  parts: [
    {
      id: 'online',
      label: 'Online',
      meaning: 'Boards with Wi-Fi that are connected now.',
      weight: 0.35,
      counted: 2,
      of: 3,
      value: 2 / 3,
    },
    {
      id: 'crashFree',
      label: 'Crash-free',
      meaning: 'No unexpected restart.',
      weight: 0.3,
      counted: 3,
      of: 3,
      value: 1,
    },
    {
      id: 'updates',
      label: 'Update success',
      meaning: 'Updates that ended confirmed.',
      weight: 0.2,
      counted: 0,
      of: 0,
      value: null,
    },
    // A link of the answer's own is never followed: the console's are.
    {
      id: 'signal',
      label: 'Wi-Fi signal',
      meaning: 'Good signal.',
      weight: 0.15,
      counted: 1,
      of: 2,
      value: 0.5,
      href: 'https://evil.example',
    },
    { id: 'unknown', label: 'Not a part', weight: 1, value: 1 },
  ],
  history: [
    { day: '2026-10-28', score: 67 },
    { day: '2026-11-01', score: null },
    { day: 'yesterday', score: 50 },
    { day: '2026-11-04', score: 70 },
  ],
};

test("the Overview's fleet health score: the number, the week's change, the trend and each part with its page", async () => {
  const { answers, ctx } = connected({ route: { view: 'overview' } });
  answers.set('GET /api/fleet', FLEET);
  answers.set('GET /api/fleet/health?days=30', { types: [], updates: {}, attention: [], score: SCORE });
  await fleet.refreshFor('overview', true);
  const read = ctx.state.fleetHealth.value.score;
  assert.deepEqual(
    read.parts.map((part) => [part.id, part.href]),
    [
      ['online', '#/devices?status=offline'],
      ['crashFree', '#/memfault'],
      ['updates', '#/deployments'],
      ['signal', '#/diagnostics'],
    ]
  );
  assert.deepEqual(
    read.history.map((one) => [one.day, one.score]),
    [
      ['2026-10-28', 67],
      ['2026-11-01', null],
      ['2026-11-04', 70],
    ]
  );

  const card = draw(fleet.healthScoreCard(ctx));
  assert.equal(textOf(one(card, 'h2')), 'Fleet health score');
  assert.equal(textOf(one(card, 'p.health-score-value')), '72 / 100');
  assert.ok(one(card, 'p.health-score-value').getAttribute('class').includes('is-warn'));
  assert.equal(textOf(one(card, 'p.health-score-change')), '↑ 5 since last week');
  // The trend: the telemetry chart, a point a day and the score now, with a table of the days.
  assert.equal(textOf(one(card, '.chart-title')), 'Score, last 30 days');
  assert.equal(textOf(one(card, '.chart-summary')), 'Now 72 · lowest 67 · highest 72');
  const table = one(card, 'details.chart-table');
  assert.equal(textOf(one(table, 'summary')), 'Score, last 30 days by the day, as a table');
  // A header, and a row for each day with a score: two snapshots and now.
  assert.equal(all(table, 'tr').length, 4);
  // Each part: its value, what it means, how many of how many, and a link to its page.
  const links = all(card, 'a.score-part-link');
  assert.deepEqual(
    links.map((link) => link.getAttribute('href')),
    ['#/devices?status=offline', '#/memfault', '#/deployments', '#/diagnostics']
  );
  assert.deepEqual(
    links.map((link) => textOf(one(link, '.score-part-value'))),
    ['67%', '100%', '–', '50%']
  );
  assert.equal(textOf(one(links[0], '.score-part-meaning')), 'Boards with Wi-Fi that are connected now.');
  assert.equal(textOf(one(links[2], '.score-part-count')), 'Nothing to count yet');
  assert.equal(textOf(one(links[3], '.score-part-count')), '1 of 2');
  assert.equal(textOf(one(links[0], '.score-part-weight')), 'weight 35%');
  // On the Overview, before the health card.
  const page = textOf(draw(views.overviewView(ctx)));
  assert.ok(page.indexOf('Fleet health score') >= 0);
  assert.ok(page.indexOf('Fleet health score') < page.indexOf('Needs attention'));
});

test('the score card says when the score went down, when nothing can be counted, and when Memfault is not read', async () => {
  const { answers, ctx } = connected({ route: { view: 'overview' } });
  answers.set('GET /api/fleet', FLEET);
  answers.set('GET /api/fleet/health?days=30', {
    types: [],
    updates: {},
    attention: [],
    score: {
      ...SCORE,
      value: 41,
      change: -9,
      memfault: { state: 'unreachable', message: 'Memfault could not be reached.' },
    },
  });
  await fleet.refreshFor('overview', true);
  let card = draw(fleet.healthScoreCard(ctx));
  assert.equal(textOf(one(card, 'p.health-score-change')), '↓ 9 since last week');
  assert.ok(one(card, 'p.health-score-change').getAttribute('class').includes('is-down'));
  assert.ok(one(card, 'p.health-score-value').getAttribute('class').includes('is-bad'));
  assert.match(
    textOf(card),
    /Crash-free counts the restarts in the boards’ events only just now\. Memfault could not be reached\./
  );

  answers.set('GET /api/fleet/health?days=30', {
    types: [],
    updates: {},
    attention: [],
    score: { value: null, change: null, history: [], parts: [], memfault: { state: 'not_configured' } },
  });
  await fleet.refreshFor('overview', true);
  card = draw(fleet.healthScoreCard(ctx));
  assert.equal(textOf(one(card, 'p.health-score-value')), '– / 100');
  assert.equal(textOf(one(card, 'p.health-score-change')), 'No snapshot from a week ago yet');
  assert.match(textOf(card), /No boards with Wi-Fi to count yet\./);
  assert.match(textOf(card), /The first snapshot is stored today/);
  assert.match(textOf(card), /the console has no Memfault token/);
  // An answer without a score (an older API) draws no card.
  answers.set('GET /api/fleet/health?days=30', { types: [], updates: {}, attention: [] });
  await fleet.refreshFor('overview', true);
  assert.equal(ctx.state.fleetHealth.value.score, null);
  assert.equal(fleet.healthScoreCard(ctx), null);

  assert.deepEqual(
    [0, 3, -2, null].map((change) => fleet.changeWords(change)),
    ['No change since last week', '↑ 3 since last week', '↓ 2 since last week', 'No snapshot from a week ago yet']
  );
  assert.deepEqual([100, 80, 79, 50, 49, 0, null].map(fleet.scoreTone), [
    'good',
    'good',
    'warn',
    'warn',
    'bad',
    'bad',
    'idle',
  ]);
});
