/**
 * Tests for the map, the commands and the alerts on the website (docs/fleet.md): the Map page and the
 * map on a board's page (map.js, with a stand-in for Leaflet), why a board is not on the map, the
 * Identify button and the board's answer in its log (views.js, core.js), the Account page and its
 * alerts (account.js), and a CMD line on the Events page (telemetry.js). The scripts are the very
 * files the browser loads, drawing into the stand-in document of page.mjs.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACCOUNT, CORE, MAP, TELEMETRY, VIEWS, all, click, createDocument, one, textOf } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
const map = await import(MAP);
const account = await import(ACCOUNT);
const telemetry = await import(TELEMETRY);
globalThis.document = createDocument();

const NOW = Date.parse('2026-11-04T12:00:00Z');
const MINUTE = 60_000;
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const A = 'cranium-00000000000000aa';
const B = 'cranium-00000000000000bb';
const C = 'cranium-00000000000000cc';
const D = 'cranium-00000000000000dd';
const E = 'cranium-00000000000000ee';
const NONE = Object.freeze({ status: 'none', at: null, apCount: null, checkedAt: null, bluetoothOnly: false });

function board(thing, changes = {}) {
  return {
    thing, name: null, online: true, lastSeen: at(20_000), fw: { version: '1.13.0+0', confirmed: true },
    ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' }, rssi: -52, uptime: 3600,
    stuck: null, diag: null, diary: null, bt: null, position: null, location: NONE, ...changes,
  };
}

const placed = (lat, lon, accuracy, msAgo = 5 * MINUTE) => ({
  position: { lat, lon, accuracy, at: at(msAgo) },
  location: { ...NONE, status: 'ok', at: at(msAgo), apCount: 4, checkedAt: at(msAgo) },
});

const FLEET = [
  board(A, { name: 'CRVIHAAN01', ...placed(39.9522, -75.191, 25) }),
  board(B, { online: false, lastSeen: at(3 * 3_600_000), ...placed(39.9437, -75.2022, 60, 3_600_000) }),
  board(C, { fw: { version: '1.12.0+0', confirmed: true } }),
  board(D, { location: { ...NONE, status: 'too_few', at: at(MINUTE), apCount: 1 } }),
  board(E, { online: false, lastSeen: null, fw: null, ota: null, location: { ...NONE, bluetoothOnly: true } }),
];

const loaded = (value) => ({ value, error: null, loadedAt: NOW, loading: false });

function context({ devices = FLEET, canWrite = true, route = { view: 'map' }, commands = new Map(), positions = new Map() } = {}) {
  const pressed = [];
  const state = {
    now: NOW, route, me: { canWrite, email: 'manager@example.invalid', sub: 'sub-1' }, sessionLeft: 1800, interval: 0,
    devices: loaded({ devices }), deviceDetails: new Map(), positions, commands, deployments: loaded([]), firmware: loaded(null),
    alerts: { ...loaded(null), busy: false },
  };
  // Every action, by name, with what it was given: plain values only, never an event.
  const actions = new Proxy({}, {
    get: (target, name) => (...args) => pressed.push([name, ...args.filter((arg) => arg === null || typeof arg !== 'object')]),
  });
  return { state, actions, pressed };
}

function drawn(node) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  views.render(root, node);
  return root;
}

/** A stand-in for Leaflet's L: what the map script asks of it, kept for the test to look at. */
function fakeLeaflet() {
  const made = { maps: [], layers: [] };
  const layer = (kind, args) => {
    const item = {
      kind, args, popup: null, opened: false,
      addTo(group) {
        group.children.push(item);
        return item;
      },
      bindPopup(content, options) {
        item.popup = { content, options };
        return item;
      },
      openPopup() {
        item.opened = true;
      },
      getLatLng: () => args[0],
    };
    made.layers.push(item);
    return item;
  };
  const L = {
    made,
    map(el, options) {
      const instance = {
        el, options, tiles: null, group: null, view: null, bounds: null, removed: false,
        setView(where, zoom) {
          instance.view = [where, zoom];
          return instance;
        },
        fitBounds(points, options_) {
          instance.bounds = [points, options_];
          return instance;
        },
        remove() {
          instance.removed = true;
        },
        invalidateSize() {},
        getZoom: () => 12,
      };
      made.maps.push(instance);
      return instance;
    },
    tileLayer(url, options) {
      return {
        url, options,
        addTo(instance) {
          instance.tiles = this;
          return this;
        },
      };
    },
    layerGroup() {
      const group = {
        children: [],
        addTo(instance) {
          instance.group = group;
          return group;
        },
        clearLayers() {
          group.children.length = 0;
        },
      };
      return group;
    },
    circle: (...args) => layer('circle', args),
    circleMarker: (...args) => layer('circleMarker', args),
    polyline: (...args) => layer('polyline', args),
  };
  return L;
}

// Why a board is not on the map, and the colours of the markers.

test('a board without a position says why: Bluetooth only, no scan yet, too few access points, and the rest', () => {
  const reason = (changes) => core.unplacedReason(board(A, changes))?.code ?? null;
  assert.equal(reason(placed(1, 2, 3)), null);
  assert.equal(reason({ location: { ...NONE, bluetoothOnly: true } }), 'bluetooth');
  assert.equal(reason({}), 'no_scan');
  assert.equal(reason({ location: { ...NONE, status: 'too_few', apCount: 1 } }), 'too_few');
  assert.equal(reason({ location: { ...NONE, status: 'unsolved' } }), 'unsolved');
  assert.equal(reason({ location: { ...NONE, status: 'failed' } }), 'failed');
  assert.equal(reason({ location: { ...NONE, status: 'unknown' } }), 'unknown');
  assert.match(core.unplacedReason(board(A, { location: { ...NONE, status: 'too_few', apCount: 1 } })).text, /heard one/);
  assert.deepEqual(FLEET.map(core.markerTone), ['good', 'idle', 'good', 'good', 'idle']);
  assert.equal(core.markerTone(board(A, { ota: { state: 'downloading', job: null, progress: 40, last: 'none', error: '' } })), 'act');
  assert.equal(core.markerTone(board(A, { ota: { state: 'idle', job: null, progress: 0, last: 'rolled_back', error: '' } })), 'warn');
});

test('the client reads positions strictly, and leaves out what is not one', async () => {
  const replies = {
    '/api/devices': { devices: [{ ...board(A), position: { lat: 39.95, lon: -75.19, accuracy: 25, at: at(0) }, location: { status: 'ok', bluetoothOnly: true } },
      { ...board(B), position: { lat: 95, lon: 0, accuracy: 3, at: at(0) }, location: { status: 'somewhere' } },
      { ...board(C), position: { lat: 1, lon: 2, accuracy: 0.5, at: at(0) } }] },
    [`/api/devices/${A}/positions`]: { thing: A, location: { status: 'ok' }, positions: [{ lat: 1, lon: 2, accuracy: 9, at: at(0) }, { lat: 'x' }] },
  };
  const api = core.createApi({
    auth: { accessToken: () => 'TOKEN' }, crypto: globalThis.crypto, clock: core.createClock(), onUnauthorized: () => {},
    pause: async () => {},
    fetch: async (path) => Response.json(replies[path] ?? {}, { status: replies[path] ? 200 : 404 }),
  });
  const { devices } = await api.devices();
  assert.deepEqual(devices[0].position, { lat: 39.95, lon: -75.19, accuracy: 25, at: at(0) });
  assert.equal(devices[0].location.bluetoothOnly, true);
  assert.deepEqual([devices[1].position, devices[1].location.status], [null, 'none']);
  assert.equal(devices[2].position, null);
  const history = await api.positions(A);
  assert.equal(history.positions.length, 1);
  await assert.rejects(api.positions('not-a-thing'));
});

// The Map page.

test('the Map page puts the boards with a position on the map and in a list, and the others beside it with why', () => {
  const ctx = context();
  const page = drawn(map.mapView(ctx));
  assert.equal(textOf(one(page, 'h1')), 'Map');
  assert.equal(all(page, 'div.map-canvas').length, 1);
  assert.equal(one(page, 'div.map-canvas').getAttribute('id'), 'fleet-map');
  // The credit is on the map itself, with the links the tile usage policy and Leaflet's licence ask for.
  const credit = one(page, 'p.map-credit');
  assert.equal(textOf(credit), '© OpenStreetMap contributors · Leaflet');
  assert.deepEqual(all(credit, 'a').map((link) => link.getAttribute('href')),
    ['https://www.openstreetmap.org/copyright', 'https://console.test/assets/build/leaflet-license.txt']);
  const [on, off] = all(page, 'section.card').filter((section) => /map ·/.test(textOf(section)));
  assert.match(textOf(on), /^On the map · 2/);
  assert.deepEqual(all(on, 'li.map-row').map((row) => textOf(one(row, 'p.map-row-name'))), [`${B}`, `CRVIHAAN01 ${A}`]);
  assert.match(textOf(on), /Within 25 m · placed 5 min ago/);
  assert.match(textOf(off), /^Not on the map · 3/);
  const why = Object.fromEntries(all(off, 'li.map-row').map((row) => [textOf(one(row, 'p.map-row-name')), textOf(one(row, 'p.map-row-note'))]));
  assert.match(why[C], /^No scan yet\. /);
  assert.match(why[D], /^Too few access points\. It heard one/);
  assert.match(why[E], /^Bluetooth only\. /);
  // The legend says what each colour is, and what the circle is.
  assert.match(textOf(one(page, 'ul.map-legend')), /Online Updating Last update failed Offline How sure/);
  assert.match(textOf(page), /never the access points/);
});

test('with no board placed, or none at all, the Map page says so', () => {
  const nothing = drawn(map.mapView(context({ devices: [board(C)] })));
  assert.equal(all(nothing, 'div.map-canvas').length, 0);
  assert.match(textOf(nothing), /No board has a position yet/);
  assert.match(textOf(drawn(map.mapView(context({ devices: [] })))), /No boards/i);
});

test('Leaflet draws a marker per board in its colour, its circle of uncertainty, and a popup made of elements', async () => {
  const L = fakeLeaflet();
  map.connect({ draw: () => {}, leaflet: L });
  const ctx = context();
  document.body.replaceChildren();
  drawn(map.mapView(ctx));
  map.sync(ctx.state);
  assert.equal(L.made.maps.length, 1);
  const [instance] = L.made.maps;
  assert.equal(instance.el.getAttribute('id'), 'fleet-map');
  assert.equal(instance.options.attributionControl, false);
  assert.equal(instance.tiles.url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.deepEqual([instance.tiles.options.maxZoom, instance.tiles.options.referrerPolicy], [19, 'strict-origin-when-cross-origin']);
  const markers = instance.group.children.filter((item) => item.kind === 'circleMarker');
  const circles = instance.group.children.filter((item) => item.kind === 'circle');
  assert.deepEqual(markers.map((item) => [item.args[0], item.args[1].className]).sort(), [
    [[39.9437, -75.2022], 'map-marker is-idle'], [[39.9522, -75.191], 'map-marker is-good'],
  ].sort());
  assert.deepEqual(circles.map((item) => item.args[1].radius).sort(), [25, 60]);
  // Both boards in view.
  assert.deepEqual(instance.bounds[0].length, 2);
  // The popup is an element, never markup: name, thing, firmware, online, when and how sure.
  const popup = markers.find((item) => item.args[0][0] === 39.9522).popup.content;
  assert.equal(typeof popup, 'object');
  assert.match(textOf(popup), /^CRVIHAAN01 cranium-00000000000000aa Online Firmware 1\.13\.0\+0 Placed 5 min ago Within 25 m Open the board$/);
  assert.equal(one(popup, 'a.map-popup-link').getAttribute('href'), `#/devices/${A}`);

  // Drawn again with nothing new, nothing is drawn again; the page gone, the map is taken down.
  const before = L.made.layers.length;
  map.sync(ctx.state);
  assert.equal(L.made.layers.length, before);
  document.body.replaceChildren();
  map.sync(ctx.state);
  assert.equal(instance.removed, true);
});

test('a board text never becomes markup in a popup', () => {
  const hostile = board(A, { name: null, fw: { version: '<img src=x onerror=alert(1)>', confirmed: true }, ...placed(1, 2, 3) });
  const popup = drawn(map.popupOf(hostile, NOW));
  assert.equal(all(popup, 'img').length, 0);
  assert.match(textOf(popup), /<img src=x onerror=alert\(1\)>/);
});

test('a board\'s page shows its last positions on a small map, with a trail, and lists them', () => {
  const L = fakeLeaflet();
  map.connect({ draw: () => {}, leaflet: L });
  const device = board(A, { name: 'CRVIHAAN01', ...placed(39.9437, -75.2022, 35) });
  const positions = new Map([[A, loaded({ thing: A, location: device.location, positions: [
    device.position, { lat: 39.9522, lon: -75.191, accuracy: 25, at: at(3 * 3_600_000) }, { lat: 39.9523, lon: -75.1911, accuracy: 30, at: at(9 * 3_600_000) },
  ] })]]);
  const ctx = context({ route: { view: 'device', thing: A }, positions });
  ctx.state.deviceDetails.set(A, loaded({ device, certificates: [], executions: [], olderExecutions: 0 }));
  document.body.replaceChildren();
  const page = drawn(views.deviceView(ctx));
  const card = one(page, 'section.location-card');
  assert.equal(one(card, 'div.map-canvas').getAttribute('id'), 'board-map');
  assert.match(textOf(card), /Within 35 m Placed 5 min ago/);
  // Newest first, each with how far it was from the one before (when that is more than a few metres).
  // The time of day in brackets is the reader's own, so it is not compared.
  const listed = all(one(card, 'ol.position-list'), 'li').map((item) => textOf(item).replace(/ \([^)]*\)/, ''));
  assert.deepEqual(listed, [
    '5 min ago within 35 m, 1.3 km from the one before',
    '3 h ago within 25 m',
    '9 h ago within 30 m',
  ]);
  map.sync(ctx.state);
  const [instance] = L.made.maps;
  assert.equal(instance.options.scrollWheelZoom, false);
  const kinds = instance.group.children.map((item) => [item.kind, item.args[1]?.className ?? item.args[1]?.className]);
  assert.deepEqual(kinds.filter(([kind]) => kind === 'polyline').length, 1);
  assert.deepEqual(instance.group.children.filter((item) => item.kind === 'circleMarker').map((item) => item.args[1].className),
    ['map-marker is-past', 'map-marker is-past', 'map-marker is-good']);
});

test('a board without a position has a Location card that says why, and no map', () => {
  const ctx = context({ route: { view: 'device', thing: E } });
  const device = FLEET[4];
  ctx.state.deviceDetails.set(E, loaded({ device, certificates: [], executions: [], olderExecutions: 0 }));
  const page = drawn(views.deviceView(ctx));
  assert.equal(all(page, 'div.map-canvas').length, 0);
  assert.match(textOf(one(page, 'section.card', 'Location')), /Bluetooth only An nRF5340 DK has no Wi-Fi/);
});

// Identify and Report now.

test('Identify is on every board row and on the board page, for release managers, and Report now in its menu', () => {
  const ctx = context({ route: { view: 'devices' } });
  const rows = drawn(views.devicesView(ctx));
  const buttons = all(rows, 'button.identify-button');
  // Not the Bluetooth-only board, nor one that never connected.
  assert.deepEqual(buttons.map((el) => el.getAttribute('aria-label')), ['Identify CRVIHAAN01', `Identify ${B.slice(0, 12)}…`,
    `Identify ${C.slice(0, 12)}…`, `Identify ${D.slice(0, 12)}…`]);
  // An offline board would miss it.
  assert.equal(buttons[1].disabled, true);
  assert.match(buttons[1].getAttribute('title'), /offline, so it would miss the command/);
  click(buttons[0]);
  assert.deepEqual(ctx.pressed, [['identify', A]]);

  assert.equal(all(drawn(views.devicesView(context({ route: { view: 'devices' }, canWrite: false }))), 'button.identify-button').length, 0);

  const pageCtx = context({ route: { view: 'device', thing: A } });
  pageCtx.state.deviceDetails.set(A, loaded({ device: FLEET[0], certificates: [], executions: [], olderExecutions: 0 }));
  const boardPage = drawn(views.deviceView(pageCtx));
  click(one(one(boardPage, 'div.page-tools'), 'button.identify-button', 'Identify'));
  click(one(one(boardPage, 'details.menu'), 'button.menu-item', 'Report now'));
  assert.deepEqual(pageCtx.pressed, [['identify', A], ['reportNow', A]]);
});

test('the board\'s answer to a command is found in its log by the command\'s id, and shown', () => {
  const lines = [
    { tag: 'CMD', text: 'identify for 15 s (0123456789abcdef)', at: at(0) },
    { tag: 'CMD', text: 'ignored: unknown command (fedcba9876543210)', at: at(0) },
    { tag: 'app', text: 'identify for 15 s (aaaaaaaaaaaaaaaa)', at: at(0) },
  ];
  assert.deepEqual(core.commandAnswer(lines, '0123456789abcdef'), { text: 'identify for 15 s (0123456789abcdef)', at: at(0), ignored: false });
  assert.equal(core.commandAnswer(lines, 'fedcba9876543210').ignored, true);
  assert.equal(core.commandAnswer(lines, 'aaaaaaaaaaaaaaaa'), null);
  assert.equal(core.commandAnswer(lines, '(.*)'), null);

  const said = (command) => {
    const ctx = context({ route: { view: 'device', thing: A }, commands: new Map([[A, command]]) });
    ctx.state.deviceDetails.set(A, loaded({ device: FLEET[0], certificates: [], executions: [], olderExecutions: 0 }));
    return textOf(one(drawn(views.deviceView(ctx)), 'div.notice'));
  };
  assert.match(said({ cmd: 'identify', status: 'sent', id: '0123456789abcdef' }), /Identify sent 0123456789abcdef\. Waiting for the board/);
  assert.match(said({ cmd: 'identify', status: 'answered', id: '0123456789abcdef', answer: core.commandAnswer(lines, '0123456789abcdef') }),
    /Identify: the board answered “identify for 15 s \(0123456789abcdef\)”/);
  assert.match(said({ cmd: 'report', status: 'unanswered', id: '0123456789abcdef' }), /has not answered.*1\.13\.0/);
  assert.match(said({ cmd: 'report', status: 'failed', error: 'To change anything from the phone, sign in again first' }), /Report now was not sent/);
});

test('a CMD line of a board\'s log is shown on the Events page, as a setting', async () => {
  assert.equal(core.LINE_TAGS.includes('CMD'), true);
  const line = { thing: A, at: at(MINUTE), id: '42.7', kind: 'setting', tag: 'CMD', level: 'info', text: 'identify for 15 s (0123456789abcdef)', boot: 42, seq: 7 };
  // The client keeps it.
  const api = core.createApi({
    auth: { accessToken: () => 'TOKEN' }, crypto: globalThis.crypto, clock: core.createClock(), onUnauthorized: () => {},
    pause: async () => {},
    fetch: async () => Response.json({ lines: [line], cursor: null, from: at(86_400_000), to: at(0) }),
  });
  const read = await api.boardLog({ from: at(86_400_000), to: at(0), tags: ['CMD'] });
  assert.deepEqual(read.lines.map((item) => [item.tag, item.kind, item.text]), [['CMD', 'setting', line.text]]);
  // And the Events page shows it.
  const state = { now: NOW, route: { view: 'events' }, interval: 0, me: { canWrite: false }, devices: loaded({ devices: [board(A)] }) };
  const fake = {
    events: async () => ({ events: [], cursor: null }),
    audit: async () => ({ entries: [], next: null }),
    boardLog: async () => ({ lines: read.lines, cursor: null }),
    devices: async () => ({ devices: [board(A)] }),
  };
  const load = async (target, fetcher) => {
    target.value = await fetcher();
    target.loadedAt = NOW;
  };
  telemetry.connect({ state, api: fake, load, draw: () => {}, clock: { now: () => NOW }, refresh: () => {} });
  await telemetry.refreshEvents(true);
  const page = drawn(telemetry.eventsView({ state, actions: { refresh: () => {}, redraw: () => {}, copy: () => {} } }));
  const row = one(one(page, 'section.log-card'), 'tr.log-row');
  assert.match(textOf(row), /CMD.*identify for 15 s \(0123456789abcdef\)/);
  // The source can be chosen on its own.
  assert.ok(all(page, 'option').some((option) => textOf(option) === 'CMD'));
});

// The Account page.

const ALERTS = {
  email: 'manager@example.invalid', subscription: 'none', canSubscribe: true, subscribers: 2,
  recent: [{ at: at(20 * MINUTE), kind: 'offline', thing: B, deployment: null, subject: `Cranium: ${B} is offline`, count: 1 },
    { at: at(2 * 3_600_000), kind: 'stuck', thing: A, deployment: null, subject: 'Cranium: CRVIHAAN01 restarted itself for being stuck (3 alerts)', count: 3 }],
  rules: { offlineMinutes: 15, everyMinutes: 60, movedMetres: 1000 },
};

test('the Account page says who is signed in, what the alerts are, and lets a release manager ask for them', () => {
  const ctx = context({ route: { view: 'account' } });
  ctx.state.alerts = { ...loaded(ALERTS), busy: false };
  const page = drawn(account.accountPageView(ctx));
  assert.equal(textOf(one(page, 'h1')), 'Account');
  assert.match(textOf(one(page, 'section.card', 'Signed in')), /Address manager@example\.invalid Role Release manager Account sub-1/);
  const alerts = one(page, 'section.alerts-card');
  assert.match(textOf(alerts), /Not asked for 2 addresses get them\./);
  assert.match(textOf(alerts), /offline for more than 15 minutes, and when it is back/);
  assert.match(textOf(alerts), /moved by more than 1 km/);
  assert.match(textOf(alerts), /At most one e-mail an hour for each board and kind/);
  click(one(alerts, 'button', 'Send alerts to manager@example.invalid'));
  assert.deepEqual(ctx.pressed, [['subscribeAlerts']]);
  const sent = one(page, 'section.card', 'Sent lately');
  assert.deepEqual(all(sent, 'li.alert-row').map((row) => textOf(one(row, 'a'))), [`${B} is offline`, 'CRVIHAAN01 restarted itself for being stuck (3 alerts)']);
  assert.match(textOf(sent), /Restarted, stuck · CRVIHAAN01 · 3 alerts in one e-mail/);
  assert.match(textOf(sent), /Offline · cranium-0000…/);
});

test('waiting for the confirmation, subscribed, or a viewer: each sees what fits', () => {
  const show = (changes, canWrite = true) => {
    const ctx = context({ route: { view: 'account' }, canWrite });
    ctx.state.alerts = { ...loaded({ ...ALERTS, ...changes }), busy: false };
    return { page: drawn(account.accountPageView(ctx)), ctx };
  };
  const pending = show({ subscription: 'pending' }).page;
  assert.match(textOf(pending), /Waiting for you to confirm/);
  assert.match(textOf(pending), /Send the link again.*AWS Notifications/);
  const { page: on, ctx } = show({ subscription: 'confirmed' });
  click(one(on, 'button', 'Stop the alerts'));
  assert.deepEqual(ctx.pressed, [['unsubscribeAlerts']]);
  const viewer = show({ canSubscribe: false }, false).page;
  assert.equal(all(viewer, 'button').filter((el) => /alerts/i.test(textOf(el))).length, 0);
  assert.match(textOf(viewer), /Release managers can ask for them/);
  assert.match(textOf(show({ recent: [] }).page), /No alert has gone out in the last 30 days/);
});

test('the Activity page reads a command and a subscription as sentences', () => {
  const entry = (action, target, detail, outcome = 'ok') => ({
    at: at(0), actor: { sub: 's', email: 'manager@example.invalid' }, action, target, outcome, detail, requestId: 'r',
  });
  assert.equal(core.auditSentence(entry('board.command', A, [['cmd', 'identify'], ['seconds', '15'], ['id', '0123456789abcdef']])),
    `manager@example.invalid asked ${A} to blink its lights`);
  assert.equal(core.auditSentence(entry('board.command', A, [['cmd', 'report']])), `manager@example.invalid asked ${A} to report now`);
  assert.equal(core.auditSentence(entry('alert.subscribe', 'manager@example.invalid', [['subscription', 'pending']])),
    'manager@example.invalid asked for e-mail alerts at manager@example.invalid');
  assert.equal(core.auditSentence(entry('alert.unsubscribe', 'manager@example.invalid', [])),
    'manager@example.invalid stopped the e-mail alerts to manager@example.invalid');
  assert.match(core.auditSentence(entry('board.command', A, [['cmd', 'identify'], ['code', 'rate_limited']], 'rejected')), /tried to send a command to/);
});
