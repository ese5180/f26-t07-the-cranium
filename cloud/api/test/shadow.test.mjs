// Tests for reading a board's shadow. A shadow is written by a device, so these tests
// mostly feed it things a well-behaved board would never send.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { ONLINE_WINDOW_MS, RESTART_WINDOW_MS, deviceFromShadow, unknownDevice } from '../src/lib/shadow.mjs';

const THING = 'cranium-fe5b26c0c5b1dcd7';
const JOB = 'cranium-1-1-0-b7-20261010T221500Z-9f3a';
const NOW = Date.UTC(2026, 9, 10, 22, 15, 0);
const SEEN = Math.floor(NOW / 1000) - 20;

/**
 * A shadow document as GetThingShadow returns it. `seen` is the time AWS noted for the
 * uptime; pass it explicitly, undefined included, to try other values.
 */
function shadow(reported, options = {}) {
  const seen = Object.hasOwn(options, 'seen') ? options.seen : SEEN;
  return {
    state: { reported },
    metadata: { reported: { uptime: { timestamp: seen } } },
    version: 3,
    timestamp: SEEN,
  };
}

const healthy = () => ({
  fw: { version: '1.0.0+3', confirmed: true },
  ota: { state: 'idle', progress: 0, last: 'none', error: '' },
  wifi: { rssi: -52 },
  uptime: 1234,
});

const read = (reported, options) => deviceFromShadow(THING, shadow(reported, options), NOW);

test('a well-formed shadow becomes a Device', () => {
  assert.deepEqual(read(healthy()), {
    thing: THING,
    online: true,
    lastSeen: new Date(SEEN * 1000).toISOString(),
    fw: { version: '1.0.0+3', confirmed: true },
    ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' },
    rssi: -52,
    uptime: 1234,
    stuck: null, diag: null, diary: null, bt: null,
  });

  const busy = read({
    ...healthy(),
    fw: { version: '1.0.0+3', confirmed: false },
    ota: { state: 'downloading', job: JOB, progress: 40, last: 'failed', error: 'http 403' },
  });
  assert.deepEqual(busy.fw, { version: '1.0.0+3', confirmed: false });
  assert.deepEqual(busy.ota, { state: 'downloading', job: JOB, progress: 40, last: 'failed', error: 'http 403' });
});

test('a thing without a shadow has never reported', () => {
  const never = {
    thing: THING, online: false, lastSeen: null, fw: null, ota: null, rssi: null, uptime: null,
    stuck: null, diag: null, diary: null, bt: null,
  };
  assert.deepEqual(deviceFromShadow(THING, null, NOW), never);
  assert.deepEqual(unknownDevice(THING), never);
  for (const document of [undefined, {}, { state: {} }, { state: null }, { state: { desired: { x: 1 } } },
    'shadow', 7, [], [healthy()], true]) {
    assert.deepEqual(deviceFromShadow(THING, document, NOW), never);
  }
});

const KCONFIG = new URL('../../../firmware/app/Kconfig', import.meta.url);

test('the window has room for a late heartbeat at the interval that the firmware has by default', { skip: !existsSync(KCONFIG) }, () => {
  const seconds = /config APP_SHADOW_INTERVAL_SECONDS\n[^\n]*\n\s*default (\d+)/.exec(readFileSync(KCONFIG, 'utf8'));
  assert.notEqual(seconds, null);
  const interval = Number(seconds[1]);
  assert.equal(interval, 30);
  assert.equal(ONLINE_WINDOW_MS, interval * 3 * 1000);
});

test('what a board says about being stuck is for the Diagnostics page, and nothing in it upsets the rest', () => {
  const said = { ...healthy(), stuck: { count: 2, reason: 'no_cloud' } };
  assert.deepEqual(read(said), { ...read(healthy()), stuck: { count: 2, reason: 'no_cloud' } });
  for (const stuck of [null, 'no', 7, [], { count: 'many', reason: {} }]) {
    assert.deepEqual(read({ ...healthy(), stuck }), read(healthy()), JSON.stringify(stuck));
  }
});

test('a board that said it is restarting has the time a restart takes, and only that state has', () => {
  const seenAgo = (state, secondsAgo) => {
    const reported = healthy();
    reported.ota = { ...reported.ota, state };
    return read(reported, { seen: Math.floor(NOW / 1000) - secondsAgo }).online;
  };
  assert.equal(RESTART_WINDOW_MS, 240_000);
  for (const seconds of [0, 21, 89, 90, 102, 113, 120, 239]) assert.equal(seenAgo('rebooting', seconds), true, `${seconds} s`);
  assert.equal(seenAgo('rebooting', 240), false);
  assert.equal(seenAgo('rebooting', 86400), false);
  for (const state of ['idle', 'awaiting_user', 'downloading', 'verifying', 'testing']) {
    assert.equal(seenAgo(state, 89), true, state);
    assert.equal(seenAgo(state, 90), false, state);
  }
  // A state that is not in the contract has no claim on it.
  assert.equal(seenAgo('rebooting!', 90), false);
});

test('online means AWS received the uptime less than 90 seconds ago', () => {
  const at = (secondsAgo) => read(healthy(), { seen: Math.floor(NOW / 1000) - secondsAgo });
  assert.equal(ONLINE_WINDOW_MS, 90_000);
  assert.equal(at(0).online, true);
  assert.equal(at(89).online, true);
  assert.equal(at(90).online, false);
  assert.equal(at(86400).online, false);
  assert.equal(at(90).lastSeen, new Date(NOW - 90_000).toISOString());

  // Every 30 s, with one heartbeat lost; and the golden image's 60 s, with its report 29 s late.
  assert.equal(at(30 + 30 + 29).online, true);
  assert.equal(at(60 + 29).online, true);

  // The timestamp comes from AWS, but it is still checked before it is used.
  for (const seen of [undefined, null, 'now', '1790000000', 12.5, -5, 0, NaN, Infinity, 1e15, {}, [SEEN], true]) {
    const device = read(healthy(), { seen });
    assert.equal(device.online, false, String(seen));
    assert.equal(device.lastSeen, null, String(seen));
    // The rest of the shadow is still shown.
    assert.equal(device.uptime, 1234);
  }
  // The board cannot make itself look online through its own state.
  const forged = deviceFromShadow(THING, {
    state: { reported: { ...healthy(), online: true, lastSeen: 'now', metadata: { uptime: { timestamp: SEEN } } } },
    metadata: { reported: {} },
  }, NOW);
  assert.equal(forged.online, false);
  assert.equal(forged.lastSeen, null);
});

test('a firmware version must be exact or it is not shown', () => {
  const fw = (value) => read({ ...healthy(), fw: value }).fw;
  assert.deepEqual(fw({ version: '255.255.65535+4294967295', confirmed: true }),
    { version: '255.255.65535+4294967295', confirmed: true });

  for (const version of ['1.0.0', 'v1.0.0+3', '1.0.0+3 ', '01.0.0+3', '256.0.0+0', '1.0.0+3\n', '<b>1.0.0+3</b>',
    '', null, undefined, 1, 1.0, ['1.0.0+3'], { major: 1 }]) {
    assert.equal(fw({ version, confirmed: true }), null, JSON.stringify(version));
  }
  for (const value of [null, undefined, '1.0.0+3', 5, [], [{ version: '1.0.0+3' }]]) {
    assert.equal(fw(value), null);
  }
  // Confirmed only when the board says exactly true.
  for (const confirmed of [false, 'true', 1, null, undefined, 'yes', {}, []]) {
    assert.deepEqual(fw({ version: '1.0.0+3', confirmed }), { version: '1.0.0+3', confirmed: false });
  }
});

test('the update state is checked field by field', () => {
  const ota = (value) => read({ ...healthy(), ota: value }).ota;

  for (const state of ['idle', 'awaiting_user', 'downloading', 'verifying', 'rebooting', 'testing']) {
    assert.equal(ota({ state }).state, state);
  }
  // Without a known state there is nothing to show.
  for (const state of ['IDLE', 'done', 'idle ', '', null, undefined, 0, ['idle'], { state: 'idle' }, 'constructor',
    'toString', '__proto__']) {
    assert.equal(ota({ state, job: JOB, progress: 10, last: 'failed', error: 'x' }), null, JSON.stringify(state));
  }
  for (const value of [null, undefined, 'idle', 3, [], [{ state: 'idle' }]]) {
    assert.equal(ota(value), null);
  }

  // A missing or deleted job key means no job.
  assert.equal(ota({ state: 'idle' }).job, null);
  assert.equal(ota({ state: 'idle', job: null }).job, null);
  assert.equal(ota({ state: 'awaiting_user', job: JOB }).job, JOB);
  for (const job of ['other-job', `${JOB} `, `${JOB}/../x`, 'cranium-256-0-0-b0-20261010T221500Z-9f3a', '', 5,
    [JOB], { id: JOB }, '<img src=x onerror=alert(1)>']) {
    assert.equal(ota({ state: 'awaiting_user', job }).job, null, JSON.stringify(job));
  }

  for (const progress of [0, 10, 55, 100]) assert.equal(ota({ state: 'downloading', progress }).progress, progress);
  for (const progress of [-1, 101, 50.5, '50', null, undefined, NaN, Infinity, 1e9, [50], {}]) {
    assert.equal(ota({ state: 'downloading', progress }).progress, 0, String(progress));
  }

  for (const last of ['none', 'succeeded', 'failed', 'rolled_back', 'declined', 'refused', 'cancelled']) {
    assert.equal(ota({ state: 'idle', last }).last, last);
  }
  for (const last of ['ok', 'canceled', 'FAILED', '', null, undefined, 1, ['failed']]) {
    assert.equal(ota({ state: 'idle', last }).last, 'none', JSON.stringify(last));
  }

  assert.equal(ota({ state: 'idle', error: 'x'.repeat(64) }).error, 'x'.repeat(64));
  assert.equal(ota({ state: 'idle', error: 'download: http 403 (attempt 3/3)' }).error, 'download: http 403 (attempt 3/3)');
  for (const error of ['x'.repeat(65), 'line\nbreak', 'tab\there', 'nul\u0000', 'del\u007f', 'café', 'ünïcode',
    '\u202eevil', 5, null, undefined, ['x'], { message: 'x' }]) {
    assert.equal(ota({ state: 'idle', error }).error, '', JSON.stringify(error));
  }
});

test('signal strength and uptime are integers in range', () => {
  const rssi = (value) => read({ ...healthy(), wifi: { rssi: value } }).rssi;
  for (const value of [-127, -52, -1, 0]) assert.equal(rssi(value), value);
  for (const value of [-128, 1, 30, -52.5, '-52', null, undefined, NaN, -Infinity, [-52], {}]) {
    assert.equal(rssi(value), null, String(value));
  }
  for (const wifi of [null, undefined, -52, 'rssi', [], [{ rssi: -52 }]]) {
    assert.equal(read({ ...healthy(), wifi }).rssi, null);
  }

  const uptime = (value) => read({ ...healthy(), uptime: value }).uptime;
  for (const value of [0, 1, 1234, 2 ** 32 - 1, 2 ** 32]) assert.equal(uptime(value), value);
  for (const value of [-1, 2 ** 32 + 1, 1.5, '1234', null, undefined, NaN, Infinity, [1], {}]) {
    assert.equal(uptime(value), null, String(value));
  }
});

test('nothing a board adds to its shadow reaches the output', () => {
  const hostile = JSON.parse(`{
    "state": { "reported": {
      "fw": { "version": "1.0.0+3", "confirmed": true, "note": "<script>alert(1)</script>", "__proto__": { "admin": true } },
      "ota": { "state": "idle", "job": null, "progress": 0, "last": "none", "error": "",
               "extra": "x", "constructor": { "prototype": { "polluted": true } } },
      "wifi": { "rssi": -40, "ssid": "home network", "password": "should never be shown" },
      "uptime": 9,
      "thing": "cranium-0000000000000000",
      "online": true,
      "role": "release-managers",
      "__proto__": { "polluted": true },
      "big": "${'A'.repeat(4000)}"
    } },
    "metadata": { "reported": { "uptime": { "timestamp": ${SEEN}, "extra": 1 } } }
  }`);
  const device = deviceFromShadow(THING, hostile, NOW);
  assert.deepEqual(device, {
    thing: THING,
    online: true,
    lastSeen: new Date(SEEN * 1000).toISOString(),
    fw: { version: '1.0.0+3', confirmed: true },
    ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' },
    rssi: -40,
    uptime: 9,
    stuck: null, diag: null, diary: null, bt: null,
  });
  assert.equal({}.polluted, undefined);
  assert.equal({}.admin, undefined);
  assert.equal(JSON.stringify(device).includes('password'), false);
});

test('fields inherited from a prototype are not read', () => {
  const inherited = Object.create({ state: { reported: healthy() }, metadata: { reported: { uptime: { timestamp: SEEN } } } });
  assert.deepEqual(deviceFromShadow(THING, inherited, NOW), unknownDevice(THING));

  const reported = Object.create(healthy());
  assert.deepEqual(deviceFromShadow(THING, { state: { reported } }, NOW), unknownDevice(THING));
});

test('deeply nested and oversized shadows are handled without effort', () => {
  let nested = { state: 'idle' };
  for (let depth = 0; depth < 5000; depth += 1) nested = { ota: nested, fw: nested, wifi: nested };
  const device = deviceFromShadow(THING, shadow(nested), NOW);
  assert.equal(device.fw, null);
  assert.equal(device.ota, null);
  assert.equal(device.rssi, null);

  const wide = Object.fromEntries(Array.from({ length: 20000 }, (_, n) => [`key${n}`, n]));
  assert.deepEqual(deviceFromShadow(THING, shadow({ ...wide, uptime: 5 }), NOW).uptime, 5);
});

test('the reports beside the heartbeat are read field by field: stuck, diagnostics, boot diary, Bluetooth record', () => {
  const metadata = { uptime: { timestamp: SEEN }, diag: { channel: { timestamp: SEEN - 60 } } };
  const device = deviceFromShadow(THING, {
    state: { reported: {
      ...healthy(),
      stuck: { count: 2, reason: 'wifi_silent' },
      diag: { mac: 'F4:CE:36:00:8B:C9', channel: 6, heap: { free: 21312, least: 9840, size: 44240 } },
      diary: { boots: 42, log: ['1.7.4+0/8/4', '1.10.0+0/10/3', '1.10.0+0/1/1'] },
      bt: { from: '1.5.0+0', to: '1.6.0+0', result: 'succeeded', proof: 'person', count: 3 },
      btpair: { name: 'Cranium-1A2B', passkey: '480913' },
    } },
    metadata: { reported: metadata },
  }, NOW);
  assert.deepEqual(device.stuck, { count: 2, reason: 'wifi_silent' });
  assert.deepEqual(device.diag, {
    mac: 'f4:ce:36:00:8b:c9', channel: 6, heap: { free: 21312, least: 9840, size: 44240 },
    at: new Date((SEEN - 60) * 1000).toISOString(),
  });
  // Newest first: the boot that is running, why the one before it ended, how far each got.
  assert.deepEqual(device.diary, {
    boots: 42,
    entries: [
      { version: '1.10.0+0', cause: '1', causes: ['pin'], stage: 1 },
      { version: '1.10.0+0', cause: '10', causes: ['watchdog'], stage: 3 },
      { version: '1.7.4+0', cause: '8', causes: ['power_on'], stage: 4 },
    ],
  });
  assert.deepEqual(device.bt, { from: '1.5.0+0', to: '1.6.0+0', result: 'succeeded', proof: 'person', count: 3 });
  // The passkey is for the pairing route alone.
  assert.equal(JSON.stringify(device).includes('480913'), false);
});

test('a report beside the heartbeat that is not what the firmware sends is left out', () => {
  const read2 = (extra) => read({ ...healthy(), ...extra });
  for (const stuck of [{ count: -1, reason: 'none' }, { count: 1, reason: 'Wi-Fi!' }, { count: '1', reason: 'none' }, 'stuck']) {
    assert.equal(read2({ stuck }).stuck, null, JSON.stringify(stuck));
  }
  // An address that is not one, a channel out of range and a heap without statistics are each dropped alone.
  assert.deepEqual(read2({ diag: { mac: 'unknown', channel: 300, heap: { free: 0, least: 0, size: 0 } } }).diag, null);
  assert.deepEqual(read2({ diag: { mac: 'unknown', channel: 0, heap: { free: 5, least: 9, size: 8 } } }).diag,
    { mac: null, channel: 0, heap: null, at: null });
  assert.equal(read2({ diag: 'x' }).diag, null);
  // Entries that are not entries go; a diary that is not one is none.
  assert.deepEqual(read2({ diary: { boots: 3, log: ['1.0.0+0/8/4', 'x/y/z', '1.0.0/8/4', '1.0.0+0/8g/4', 7, '1.0.0+0/4000/2'] } }).diary,
    { boots: 3, entries: [
      { version: '1.0.0+0', cause: '4000', causes: ['temperature'], stage: 2 },
      { version: '1.0.0+0', cause: '8', causes: ['power_on'], stage: 4 },
    ] });
  for (const diary of [{ boots: -1, log: [] }, { boots: 1, log: 'x' }, { boots: 1, log: Array(17).fill('1.0.0+0/8/4') }]) {
    assert.equal(read2({ diary }).diary, null);
  }
  assert.deepEqual(read2({ diary: { boots: 1, log: ['1.0.0+0/0/1', '1.0.0+0/8000/1'] } }).diary.entries.map((entry) => entry.causes),
    [['unknown'], ['power_on']]);
  for (const bt of [{ from: '1.5.0', to: '1.6.0+0', result: 'succeeded' }, { from: '1.5.0+0', to: '1.6.0+0', result: 'great' }]) {
    assert.equal(read2({ bt }).bt, null);
  }
  assert.deepEqual(read2({ bt: { from: '1.5.0+0', to: '1.6.0+0', result: 'pending', proof: 'magic', count: -2 } }).bt,
    { from: '1.5.0+0', to: '1.6.0+0', result: 'pending', proof: 'none', count: 0 });
});
