/**
 * Offline mode (offline.js): the board's offline status as the firmware sends it
 * (firmware/app/src/policy/bt_offline_policy.h, format 1), the flow against a stand-in bridge, and what the
 * page says. The phones' own parsers (CraniumKit OfflineStatus, Android core/OfflineStatus) read the same bytes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OFFLINE } from './page.mjs';

const off = await import(OFFLINE);

const BOARD = { id: 'AA:BB:CC:DD:EE:01', name: 'Cranium-1A2B', rssi: -58 };

const UPDATE = { idle: 0, cloudOffer: 1, cloudBusy: 2, trial: 3, waiting: 4, receiving: 5 };

/** A status as the board encodes it. */
function status({
  wifi = 2,
  cloud = 1,
  update = 'idle',
  reboot = 1,
  running = '1.19.0+0',
  uptime = 3725,
  waiting = null,
} = {}) {
  const b = Buffer.alloc(20);
  const [major, minor, revision, build] = running.split(/[.+]/).map(Number);
  b[0] = 1;
  b[1] = wifi;
  b[2] = cloud;
  b[3] = UPDATE[update];
  b[4] = reboot;
  b[6] = major;
  b[7] = minor;
  b.writeUInt16LE(revision, 8);
  b.writeUInt32LE(build, 10);
  b.writeUInt32LE(uptime, 14);
  if (waiting) {
    const [wMajor, wMinor] = waiting.split('.').map(Number);
    b[18] = wMajor;
    b[19] = wMinor;
  }
  return b.toString('base64');
}

test('the status reads as the firmware writes it, and nothing else does', () => {
  const read = off.offlineStatusFromBase64(status({ update: 'waiting', waiting: '1.20', running: '1.19.0+3' }));
  assert.deepEqual(read, {
    wifi: 'up',
    cloud: 'down',
    update: 'waiting',
    reboot: 1,
    running: '1.19.0+3',
    uptime: 3725,
    waiting: '1.20',
  });
  // The waiting version is named only while an update waits.
  assert.equal(off.offlineStatusFromBase64(status({ update: 'trial', waiting: '1.20' })).waiting, null);
  // Short, another format, not base64.
  assert.equal(off.parseOfflineStatus(new Uint8Array(19).fill(1)), null);
  const other = Buffer.from(status(), 'base64');
  other[0] = 2;
  assert.equal(off.parseOfflineStatus(new Uint8Array(other)), null);
  assert.equal(off.offlineStatusFromBase64('not base64!'), null);
  assert.equal(off.offlineStatusFromBase64(null), null);
  // Values from a newer firmware read as not known, not as something else.
  const newer = off.offlineStatusFromBase64(status({ wifi: 9, cloud: 9, reboot: 200 }));
  assert.equal(newer.wifi, 'unknown');
  assert.equal(off.wifiWords(newer.wifi), 'Not known');
  assert.equal(off.rebootWords(newer.reboot), 'Not known');
  // A large uptime and build stay unsigned.
  const big = off.offlineStatusFromBase64(status({ uptime: 0xfffffff0, running: '1.19.0+4000000000' }));
  assert.equal(big.uptime, 0xfffffff0);
  assert.equal(big.running, '1.19.0+4000000000');
});

test("the firmware's own sample (firmware/tests/host: build/bt_offline_tests --print) reads as the phones read it", () => {
  const sample = Buffer.from('010101040200011202010d0c0b0a040302010113', 'hex');
  assert.deepEqual(off.parseOfflineStatus(new Uint8Array(sample)), {
    wifi: 'down',
    cloud: 'down',
    update: 'waiting',
    reboot: 2,
    running: '1.18.258+168496141',
    uptime: 0x01020304,
    waiting: '1.19',
  });
});

test('the status in words', () => {
  assert.equal(off.uptimeWords(3725), '1 h 2 min');
  assert.equal(off.uptimeWords(250), '4 min 10 s');
  assert.equal(off.uptimeWords(3 * 86400 + 4 * 3600), '3 d 4 h');
  assert.equal(off.runningWords('1.19.0+0'), '1.19.0');
  assert.equal(off.runningWords('1.19.0+5'), '1.19.0 (build 5)');
  assert.equal(off.wifiWords('none'), 'No Wi-Fi on this board');
  assert.equal(off.cloudWords('up'), 'Connected');
  assert.equal(off.rebootWords(10), 'Reset by the user');
  assert.equal(off.updateWords({ update: 'waiting', waiting: '1.20' }), 'Version 1.20 has arrived and waits');
});

/** The bridge as the app answers, and what it was asked. */
function world({ radio = 'on', connect = () => ({ name: BOARD.name, payload: status() }) } = {}) {
  const listeners = new Map();
  const calls = [];
  const held = new Map();
  const answers = {
    'ble.state': () => ({ state: radio }),
    'ble.offline.connect': connect,
  };
  const bridge = {
    call(method, params = {}) {
      calls.push({ method, params });
      if (held.has(method)) return new Promise((resolve, reject) => held.get(method).push({ resolve, reject }));
      try {
        return Promise.resolve(answers[method]?.(params) ?? {});
      } catch (error) {
        return Promise.reject(error);
      }
    },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => {};
    },
  };
  let draws = 0;
  const flow = off.createOfflineFlow({ bridge, onChange: () => (draws += 1), device: 'phone' });
  return {
    flow,
    calls,
    asked: (method) => calls.filter((call) => call.method === method),
    emit: (event, data) => (listeners.get(event) ?? []).forEach((listener) => listener(data)),
    hold: (method) => held.set(method, []),
    release(method, value, error = null) {
      const list = held.get(method) ?? [];
      held.delete(method);
      for (const waiting of list) error ? waiting.reject(error) : waiting.resolve(value);
    },
    draws: () => draws,
  };
}

const view = (w, extra = {}) =>
  off.offlineView({ state: { app: { offline: true, device: 'phone' } }, offline: w.flow, ...extra });
const words = (node) => JSON.stringify(node);

test('look, pick a board, pair, see its status; the scan stops before connecting', async () => {
  const w = world();
  assert.match(words(view(w)), /Look for boards/);
  await w.flow.lookForBoards();
  assert.equal(w.flow.flow.step, 'boards');
  assert.deepEqual(w.asked('ble.scan')[0].params, { on: true });
  // Only boards by their advertised name.
  w.emit('ble.boards', { boards: [BOARD, { id: 'x', name: 'Headphones', rssi: -40 }] });
  assert.deepEqual(w.flow.flow.boards, [BOARD]);
  w.hold('ble.offline.connect');
  const connecting = w.flow.connect(w.flow.flow.boards[0]);
  await Promise.resolve();
  assert.deepEqual(w.asked('ble.scan')[1].params, { on: false });
  assert.equal(w.flow.flow.step, 'connecting');
  assert.match(words(view(w)), /type the board’s passkey/);
  w.release('ble.offline.connect', { name: BOARD.name, payload: status() });
  await connecting;
  assert.deepEqual(w.asked('ble.offline.connect')[0].params, { id: BOARD.id });
  assert.equal(w.flow.flow.step, 'ready');
  const shown = words(view(w));
  for (const said of ['1.19.0', '1 h 2 min', 'Connected', 'Not connected', 'No update', 'Power on']) {
    assert.ok(shown.includes(said), said);
  }
  assert.doesNotMatch(shown, /Accept the waiting update/);
  // Each status the app reads after that is shown.
  w.emit('ble.offline.status', { payload: status({ uptime: 3730 }) });
  assert.equal(w.flow.flow.status.uptime, 3730);
});

test('accepting asks first, naming the version, and sends that version', async () => {
  const w = world({ connect: () => ({ name: BOARD.name, payload: status({ update: 'waiting', waiting: '1.20' }) }) });
  await w.flow.lookForBoards();
  w.emit('ble.boards', { boards: [BOARD] });
  await w.flow.connect(BOARD);
  assert.match(words(view(w)), /Accept the waiting update/);
  w.flow.askToAccept();
  assert.equal(w.asked('ble.offline.accept').length, 0, 'nothing is sent before the yes');
  const asking = words(view(w));
  assert.match(asking, /Install version 1\.20 on Cranium-1A2B\?/);
  assert.match(asking, /Install 1\.20/);
  // Cancel sends nothing.
  w.flow.dontAccept();
  assert.equal(w.flow.flow.confirming, null);
  w.flow.askToAccept();
  await w.flow.accept();
  assert.deepEqual(w.asked('ble.offline.accept')[0].params, { version: '1.20' });
  assert.equal(w.flow.flow.accepted, '1.20');
  assert.match(words(view(w)), /The board took 1\.20/);
  // The board restarts to install it: the link goes, and the page says why.
  w.emit('ble.offline.link', { state: 'disconnected', error: null });
  assert.equal(w.flow.flow.step, 'restarting');
  assert.match(words(view(w)), /is installing 1\.20/);
});

test('a question about a version that no longer waits is withdrawn', async () => {
  const w = world({ connect: () => ({ name: BOARD.name, payload: status({ update: 'waiting', waiting: '1.20' }) }) });
  await w.flow.lookForBoards();
  w.emit('ble.boards', { boards: [BOARD] });
  await w.flow.connect(BOARD);
  w.flow.askToAccept();
  w.emit('ble.offline.status', { payload: status({ update: 'waiting', waiting: '1.21' }) });
  assert.equal(w.flow.flow.confirming, null);
  await w.flow.accept();
  assert.equal(w.asked('ble.offline.accept').length, 0);
});

test('a refusal of the board is said, and the link stays', async () => {
  const w = world({ connect: () => ({ name: BOARD.name, payload: status({ update: 'waiting', waiting: '1.20' }) }) });
  await w.flow.lookForBoards();
  w.emit('ble.boards', { boards: [BOARD] });
  await w.flow.connect(BOARD);
  w.flow.askToAccept();
  w.hold('ble.offline.accept');
  const accepting = w.flow.accept();
  assert.match(words(view(w)), /Sending…/);
  w.release('ble.offline.accept', null, Object.assign(new Error('That update no longer waits.'), { code: 'failed' }));
  await accepting;
  assert.equal(w.flow.flow.step, 'ready');
  assert.equal(w.asked('ble.offline.status').length, 1, 'what waits now is read at once');
  assert.equal(w.flow.flow.accepted, null);
  assert.match(words(view(w)), /That update no longer waits/);
});

test('a failed pairing, a closed window, a busy radio and Bluetooth off are each said', async () => {
  const refused = world({
    connect: () => {
      throw Object.assign(new Error('The board needs its passkey.'), { code: 'failed' });
    },
  });
  await refused.flow.lookForBoards();
  refused.emit('ble.boards', { boards: [BOARD] });
  await refused.flow.connect(BOARD);
  assert.equal(refused.flow.flow.step, 'failed');
  assert.match(words(view(refused)), /The board needs its passkey\..*Look again/);
  assert.equal(refused.asked('ble.offline.disconnect').length, 1);

  const busy = world({
    connect: () => {
      throw Object.assign(new Error('A board is connected already.'), { code: 'busy' });
    },
  });
  await busy.flow.lookForBoards();
  busy.emit('ble.boards', { boards: [BOARD] });
  await busy.flow.connect(BOARD);
  assert.match(busy.flow.flow.problem, /An update over Bluetooth is using the radio/);

  const closed = world();
  await closed.flow.lookForBoards();
  closed.emit('ble.boards', { boards: [BOARD] });
  await closed.flow.connect(BOARD);
  closed.emit('ble.offline.link', { state: 'disconnected', error: null });
  assert.equal(closed.flow.flow.step, 'failed');
  assert.match(closed.flow.flow.problem, /hold Button 1 for 5 s/);

  const off_ = world({ radio: 'off' });
  await off_.flow.lookForBoards();
  assert.equal(off_.flow.flow.step, 'start');
  assert.match(off_.flow.flow.problem, /Bluetooth is off/);
  assert.equal(off_.asked('ble.scan').length, 0);
});

test('leaving lets go of the board; another board looks again', async () => {
  const w = world();
  await w.flow.lookForBoards();
  w.emit('ble.boards', { boards: [BOARD] });
  await w.flow.connect(BOARD);
  await w.flow.again();
  assert.equal(w.asked('ble.offline.disconnect').length, 1);
  assert.equal(w.flow.flow.step, 'boards');
  await w.flow.leave();
  assert.equal(w.flow.flow.step, 'start');
  assert.deepEqual(w.asked('ble.scan').at(-1).params, { on: false });
});

test('the page: a short lede, How offline mode works, and only in the apps that offer it', () => {
  const w = world();
  const page = view(w);
  const lede = words(page).match(/"class":"page-lede"[^}]*},"children":\["([^"]*)"/)?.[1] ?? '';
  assert.ok(lede.split(/\s+/).length <= 15, lede);
  assert.match(words(page), /How offline mode works/);
  assert.match(words(page), /BT_OFFLINE\|NEW/);
  const outside = words(off.offlineView({ state: { app: null }, offline: null }));
  assert.match(outside, /in the iPhone, Android and Mac apps only/);
  // From the sign-in page: a way back.
  let back = 0;
  const standalone = view(w, { back: { label: 'Sign in', run: () => (back += 1) } });
  assert.match(standalone.props.class, /is-standalone/);
  const find = (node) => {
    if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
    if (!node || typeof node !== 'object') return null;
    return node.props?.class === 'back of-back' ? node : find(node.children ?? []);
  };
  find(standalone).props.onClick();
  assert.equal(back, 1);
});
