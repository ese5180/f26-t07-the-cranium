/**
 * The app's Bluetooth page (assets/bluetooth.js): an update over Bluetooth as the contract has it
 * (docs/mobile-apps.md), with a stand-in for the app's bridge, the console's API and the clock. Which
 * releases are offered, the passkey on the clipboard, the checks of the image, the console's yes before
 * every send and nothing sent without it, and the board followed after the send with UpdateWatch.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { BLUETOOTH, CORE, createDocument } from './page.mjs';

globalThis.document ??= createDocument();
const bt = await import(BLUETOOTH);
const core = await import(CORE);

const THING = 'cranium-0123456789abcdef';
const BOARD = { id: 'peripheral-1', name: 'Cranium-1A2B', rssi: -60 };
const START = Date.parse('2026-11-05T12:00:00.000Z');

/** A signed image as MCUboot lays it out: header, payload, and a TLV area with the image's own SHA-256. */
function image(version) {
  const [major, minor, revision, build] = version.split(/[.+]/).map(Number);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0x96f3b83d, 0);
  header.writeUInt16LE(32, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt32LE(64, 12);
  header.writeUInt8(major, 20);
  header.writeUInt8(minor, 21);
  header.writeUInt16LE(revision, 22);
  header.writeUInt32LE(build, 24);
  const payload = Buffer.alloc(64, 7);
  const own = createHash('sha256').update(Buffer.concat([header, payload])).digest();
  const tlv = Buffer.concat([Buffer.from([0x07, 0x69, 40, 0x00, 0x10, 0x00, 0x20, 0x00]), own]);
  const bytes = new Uint8Array(Buffer.concat([header, payload, tlv]));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), hash: own.toString('hex').slice(0, 16) };
}

const SENT = image('1.13.0+0');
const RELEASES = [
  { version: '1.14.0+0', status: 'revoked', size: 1, sha256: 'a'.repeat(64) },
  { version: '1.13.0+0', status: 'active', size: SENT.bytes.length, sha256: SENT.sha256, notes: 'Bluetooth status' },
  { version: '1.12.5+0', status: 'active', size: 1, sha256: 'b'.repeat(64) },
  { version: '1.11.0+0', status: 'active', size: 1, sha256: 'c'.repeat(64) },
];

const WINDOW = { closed: 0, open: 1, linked: 2, offer: 3, status: 4 };
const RESULT = { none: 0, installing: 1, discarded: 2, timedOut: 3, closed: 4 };
const OUTCOME = { none: 0, pending: 1, kept: 2, rolledBack: 3 };

/** The board's status characteristic, in base64, as the app sends it. */
function status({ window = 'linked', left = 0, result = 'none', running = '1.12.0+0', onTrial = false, via = 1, outcome = 'none',
  proof = 0, target = null, hash = null } = {}) {
  const b = Buffer.alloc(64);
  const version = (at, text) => {
    if (!text) return;
    const [major, minor, revision, build] = text.split(/[.+]/).map(Number);
    b.writeUInt8(major, at);
    b.writeUInt8(minor, at + 1);
    b.writeUInt16LE(revision, at + 2);
    b.writeUInt32LE(build, at + 4);
  };
  b[0] = 1;
  b[1] = WINDOW[window];
  b.writeUInt16LE(left, 2);
  b[18] = RESULT[result];
  version(20, running);
  b[28] = onTrial ? 1 | (3 << 1) : 0;
  b[29] = via;
  b[30] = OUTCOME[outcome];
  b[31] = proof;
  version(32, target);
  version(40, '1.12.0+0');
  if (hash) Buffer.from(hash, 'hex').copy(b, 48);
  return b.toString('base64');
}

/** Everything a flow talks to, and what it was asked. */
function world({ clearance = null, imageBytes = SENT.bytes, radio = 'on' } = {}) {
  let now = START;
  const timers = new Map();
  let nextTimer = 0;
  const listeners = new Map();
  const calls = [];
  const apiCalls = [];
  const waiting = new Map();
  const answers = {
    'ble.state': () => ({ state: radio }),
    'ble.connect': () => ({ name: BOARD.name }),
    'ble.images': () => ({ images: [{ slot: 0, version: '1.12.0', active: true, confirmed: true, pending: false, permanent: false }] }),
    'ble.status': () => ({ supported: true, payload: status() }),
  };
  const bridge = {
    call(method, params = {}) {
      calls.push({ method, params });
      if (waiting.has(method)) return new Promise((resolve, reject) => waiting.get(method).push({ resolve, reject }));
      return Promise.resolve(answers[method]?.(params) ?? {});
    },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== listener));
    },
  };
  const api = {
    async pairing(name) {
      apiCalls.push(['pairing', name]);
      return { passkey: '123456', thing: THING, reportedAt: null };
    },
    async image(version) {
      apiCalls.push(['image', version]);
      return imageBytes;
    },
    async clearSend(version, body) {
      apiCalls.push(['clearSend', version, body]);
      if (clearance instanceof Error) throw clearance;
      return clearance ?? { version, sha256: body.sha256, status: 'active' };
    },
    lines: [],
    events: [],
    device: null,
    async boardLog(query) {
      apiCalls.push(['boardLog', query]);
      return { lines: api.lines };
    },
    async events(query) {
      apiCalls.push(['events', query]);
      return { events: api.events };
    },
    async device(thing) {
      apiCalls.push(['device', thing]);
      return { device: api.device };
    },
  };
  const flow = bt.createBluetoothFlow({
    api,
    bridge,
    now: () => now,
    timers: {
      setTimeout: (run, ms) => {
        nextTimer += 1;
        timers.set(nextTimer, { run, at: now + ms });
        return nextTimer;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    devices: () => [{ thing: THING, online: true }],
  });
  flow.setReleases(RELEASES);
  const settle = async () => {
    for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    flow, api, calls, apiCalls, bridge,
    asked: (method) => calls.filter((call) => call.method === method),
    hold(method) {
      waiting.set(method, []);
    },
    release(method, value) {
      const held = waiting.get(method) ?? [];
      waiting.delete(method);
      for (const { resolve } of held) resolve(value);
    },
    refuse(method, error) {
      const held = waiting.get(method) ?? [];
      waiting.delete(method);
      for (const { reject } of held) reject(error);
    },
    emit(event, data) {
      for (const listener of listeners.get(event) ?? []) listener(data);
    },
    /** Move the clock on, running each timer that falls due, in order. */
    async pass(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].run();
        await settle();
      }
      now = end;
      await settle();
    },
    settle,
    now: () => now,
  };
}

/** A flow at the board, paired and ready to send. */
async function atTheBoard(options) {
  const w = world(options);
  await w.flow.lookForBoards();
  w.emit('ble.boards', { boards: [BOARD, { id: 'x', name: 'Not-A-Board', rssi: -10 }] });
  assert.deepEqual(w.flow.flow.boards.map((board) => board.name), [BOARD.name]);
  // The passkey arrives while the phone's pairing box is up.
  w.hold('ble.images');
  const connecting = w.flow.connect(w.flow.flow.boards[0]);
  await w.settle();
  await w.pass(3000);
  w.release('ble.images', { images: [{ slot: 0, version: '1.12.0', active: true }] });
  await connecting;
  await w.settle();
  return w;
}

test('a board\'s version from its image list, and only active releases newer than it, newest first', () => {
  assert.equal(bt.boardVersion('1.12.0'), '1.12.0+0');
  assert.equal(bt.boardVersion('1.12.0.5'), '1.12.0+5');
  assert.equal(bt.boardVersion('1.12.0+5'), '1.12.0+5');
  assert.equal(bt.boardVersion('1.12'), null);
  assert.equal(bt.boardVersion(null), null);
  assert.deepEqual(bt.offerable(RELEASES, '1.12.0+0').map((release) => release.version), ['1.13.0+0', '1.12.5+0']);
  assert.deepEqual(bt.offerable(RELEASES, null).map((release) => release.version), ['1.13.0+0', '1.12.5+0', '1.11.0+0']);
  assert.deepEqual(bt.offerable(RELEASES, '1.13.0+0'), []);
});

test('the newest active release is chosen; Bluetooth that is off is said, and nothing is scanned', async () => {
  const w = world({ radio: 'off' });
  assert.equal(w.flow.flow.release, '1.13.0+0');
  await w.flow.lookForBoards();
  assert.equal(w.flow.flow.step, 'release');
  assert.match(w.flow.flow.problem, /Bluetooth is off/);
  assert.equal(w.asked('ble.scan').length, 0);
});

test('pairing: the passkey from the console, pinned and on this phone\'s clipboard for 2 minutes, until the board has paired', async () => {
  const w = world();
  await w.flow.lookForBoards();
  assert.deepEqual(w.asked('ble.scan')[0].params, { on: true });
  w.emit('ble.boards', { boards: [BOARD] });
  // The phone's pairing box is up while the image list waits.
  w.hold('ble.images');
  const connecting = w.flow.connect(w.flow.flow.boards[0]);
  await w.settle();
  assert.deepEqual(w.asked('ble.scan')[1].params, { on: false });
  assert.deepEqual(w.asked('ble.connect')[0].params, { id: BOARD.id });
  assert.equal(w.flow.flow.step, 'pairing');
  await w.pass(3000);
  assert.deepEqual(w.apiCalls[0], ['pairing', BOARD.name]);
  assert.deepEqual(w.flow.flow.passkey, { passkey: '123456', thing: THING, reportedAt: null });
  assert.deepEqual(w.asked('clipboard.write')[0].params, { text: '123456', expiresIn: 120 });
  // The same passkey again is not copied again.
  await w.pass(3000);
  assert.equal(w.asked('clipboard.write').length, 1);
  const view = bt.bluetoothView({ state: { app: { ble: true }, me: { canWrite: true }, now: w.now() }, bluetooth: w.flow });
  assert.equal(view.children[0].props.class, 'bt-passkey', 'the passkey is the first thing on the page');
  w.release('ble.images', { images: [{ slot: 0, version: '1.12.0', active: true }] });
  await connecting;
  assert.equal(w.flow.flow.step, 'ready');
  assert.equal(w.flow.flow.running, '1.12.0+0');
  const polls = w.apiCalls.length;
  await w.pass(30000);
  assert.equal(w.apiCalls.length, polls, 'no passkey asked for once paired');
  // The link is kept up: the image list now and then, while the person chooses.
  assert.ok(w.asked('ble.images').length >= 2);
});

test('on an iPhone, where connecting waits for the pairing, the passkey is asked for meanwhile', async () => {
  const w = world();
  await w.flow.lookForBoards();
  w.emit('ble.boards', { boards: [BOARD] });
  w.hold('ble.connect');
  const connecting = w.flow.connect(w.flow.flow.boards[0]);
  await w.settle();
  await w.pass(3000);
  assert.equal(w.flow.flow.passkey?.passkey, '123456');
  assert.deepEqual(w.asked('clipboard.write')[0].params, { text: '123456', expiresIn: 120 });
  w.release('ble.connect', { name: BOARD.name });
  await connecting;
  assert.equal(w.flow.flow.step, 'ready');
});

test('nothing is sent when the console says no, or cannot be reached, or answers for another image', async () => {
  for (const clearance of [
    new core.ApiError(409, 'release_revoked', 'Release 1.13.0+0 was revoked.'),
    new core.ApiError(0, 'network', 'The server could not be reached.'),
    { version: '1.13.0+0', sha256: 'f'.repeat(64), status: 'active' },
    { version: '1.13.0+0', sha256: SENT.sha256, status: 'revoked' },
  ]) {
    const w = await atTheBoard({ clearance });
    await w.flow.send();
    await w.settle();
    assert.equal(w.asked('ble.upload').length, 0, JSON.stringify(clearance));
    assert.equal(w.flow.flow.step, 'ready');
    assert.match(w.flow.flow.problem, /nothing was sent/);
  }
});

test('an image that is not the release\'s is not sent, and the console is not even asked', async () => {
  const other = image('1.13.0+0');
  other.bytes[100] ^= 1;
  const w = await atTheBoard({ imageBytes: other.bytes });
  await w.flow.send();
  await w.settle();
  assert.equal(w.apiCalls.some(([name]) => name === 'clearSend'), false);
  assert.equal(w.asked('ble.upload').length, 0);
  assert.match(w.flow.flow.problem, /SHA-256 differs.*Nothing was sent/);
  assert.match(await bt.imageProblem(image('1.12.0+0').bytes, { ...RELEASES[1], sha256: image('1.12.0+0').sha256 }), /header says 1\.12\.0\+0/);
});

test('a send: the console\'s yes, then the upload, then the board followed to the end', async () => {
  const w = await atTheBoard();
  await w.flow.send();
  await w.settle();
  // In this order: the image, the console's yes for this board, then the board's status and the upload.
  assert.deepEqual(w.apiCalls.filter(([name]) => name !== 'pairing').map(([name]) => name), ['image', 'clearSend']);
  assert.deepEqual(w.apiCalls.find(([name]) => name === 'clearSend')[2], { sha256: SENT.sha256, board: BOARD.name });
  const upload = w.asked('ble.upload')[0].params;
  assert.equal(upload.sha256, SENT.sha256);
  assert.deepEqual(new Uint8Array(Buffer.from(upload.image, 'base64')), SENT.bytes);
  assert.ok(w.calls.findIndex((call) => call.method === 'ble.status') < w.calls.findIndex((call) => call.method === 'ble.upload'));
  assert.equal(w.flow.flow.step, 'following');
  assert.equal(w.flow.flow.facts.sentHash, SENT.hash);
  assert.equal(w.flow.flow.facts.thing, THING);
  assert.equal(w.flow.flow.facts.onConsole, true);
  assert.deepEqual(w.flow.flow.line.rows.map((row) => row.state), ['done', 'current', 'waiting', 'waiting', 'waiting']);

  // The board offers it, counts down, and takes Button 1.
  w.emit('ble.status', { payload: status({ window: 'offer', left: 100 }), afterRestart: false });
  assert.equal(w.flow.flow.line.deadline, w.now() + 100000);
  const reads = w.asked('ble.images').length;
  await w.pass(6500);
  assert.equal(w.asked('ble.images').length, reads + 2, 'the link is read every 3 s while it waits for a button');
  w.emit('ble.status', { payload: status({ window: 'offer', left: 90, result: 'installing', outcome: 'pending', target: '1.13.0+0', hash: SENT.hash }),
    afterRestart: false });
  assert.equal(w.flow.flow.line.rows[1].detail, 'The board said so over Bluetooth, and is restarting to install it.');

  // The link goes: the board is looked for after its restart, and the console is asked.
  w.emit('ble.link', { state: 'disconnected', name: BOARD.name, error: null });
  assert.deepEqual(w.asked('ble.watch')[0].params, { on: true, version: '1.13.0+0', hash: SENT.hash });
  w.api.events = [{ thing: THING, at: new Date(w.now()).toISOString(), kind: 'connection', what: 'disconnected' }];
  await w.pass(100);
  const log = w.apiCalls.find(([name]) => name === 'boardLog')[1];
  assert.deepEqual(log.tags, ['BT', 'bt_ota']);
  assert.equal(log.thing, THING);
  assert.equal(Date.parse(log.from), w.flow.flow.facts.sentAt - 30000);

  // After the restart, the board says it on trial and then kept, with no pairing.
  w.emit('ble.status', { payload: status({ window: 'status', running: '1.13.0+0', onTrial: true, outcome: 'pending', target: '1.13.0+0', hash: SENT.hash }),
    afterRestart: true });
  assert.equal(w.flow.flow.line.rows[3].state, 'current');
  w.emit('ble.status', { payload: status({ window: 'status', running: '1.13.0+0', outcome: 'kept', proof: 1, target: '1.13.0+0', hash: SENT.hash }),
    afterRestart: true });
  assert.equal(w.flow.flow.line.outcome, 'kept');
  assert.equal(w.flow.flow.line.finished, true);
  await w.settle();
  // Finished: no more looking, no more asking, the screen may sleep.
  assert.deepEqual(w.asked('ble.watch').at(-1).params, { on: false });
  assert.deepEqual(w.asked('app.keepAwake').at(-1).params, { on: false });
  const asked = w.apiCalls.length;
  await w.pass(60000);
  assert.equal(w.apiCalls.length, asked);
});

test('an upload that breaks off says how to go on, and nothing is followed', async () => {
  const w = await atTheBoard();
  w.hold('ble.upload');
  const sending = w.flow.send();
  await w.settle();
  assert.equal(w.flow.flow.step, 'sending');
  w.emit('ble.progress', { sent: 40, total: 160 });
  assert.deepEqual(w.flow.flow.progress, { sent: 40, total: 160 });
  // Out of range: the app's own words for it, and what to do.
  w.refuse('ble.upload', Object.assign(new Error('The board went out of range.'), { code: 'failed' }));
  await sending;
  assert.equal(w.flow.flow.step, 'failed');
  assert.equal(w.flow.flow.facts, null);
  assert.equal(w.flow.flow.problem, 'The board went out of range. Open a new window and send it again: it starts over.');
  assert.equal(w.asked('ble.watch').length, 0);
  assert.deepEqual(w.asked('app.keepAwake').at(-1).params, { on: false });
  // Start again lets go of the board.
  w.flow.reset();
  assert.equal(w.flow.flow.step, 'release');
  assert.ok(w.asked('ble.disconnect').length >= 1);
});

test('the page is only for release managers in the app', () => {
  const words = (state) => JSON.stringify(bt.bluetoothView({ state, bluetooth: null }));
  assert.match(words({ app: null, me: { canWrite: true } }), /in the phone apps only/);
  assert.match(words({ app: { ble: true }, me: { canWrite: false } }), /Only a release manager/);
});
