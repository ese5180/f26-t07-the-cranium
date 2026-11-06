// Bluetooth for the bridge on Web Bluetooth's chooser: the boards found become ble.boards, a connect picks
// one even just after the scan stopped, and after the restart the board of this send is found and followed.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBluetooth } from '../src/lib/ble.mjs';
import { STATUS_SERVICE } from '../src/lib/board.mjs';
import { SMP_SERVICE } from '../src/lib/smp.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A status payload (firmware/app/src/bt_status.h): format 1, last update over Bluetooth to `version`. */
function statusPayload({ via = 1, version = [1, 14, 0, 2], hash = null } = {}) {
  const b = new Uint8Array(64);
  b[0] = 1;
  b[29] = via;
  b[32] = version[0];
  b[33] = version[1];
  b[34] = version[2] & 0xff;
  b[35] = version[2] >> 8;
  b[36] = version[3];
  if (hash) b.set(Buffer.from(hash, 'hex'), 48);
  return Buffer.from(b).toString('base64');
}

/** The window's Web Bluetooth, with a chooser the test fills. */
function standInWindow() {
  const calls = [];
  let pending = null;
  const statuses = new Map();
  const gatt = {
    availability: async () => 'on',
    request(services, optional) {
      calls.push(['request', services, optional]);
      return new Promise((resolve, reject) => {
        pending = { services, resolve, reject };
      });
    },
    openSmp: async (id) => calls.push(['openSmp', id]),
    write: async (id, data) => calls.push(['write', id, data]),
    readStatus: async (id, follow) => {
      calls.push(['readStatus', id, follow]);
      return statuses.has(id) ? { supported: true, payload: statuses.get(id) } : { supported: false, payload: null };
    },
    close: async (id) => calls.push(['close', id]),
  };
  return {
    gatt,
    calls,
    statuses,
    get pending() {
      return pending;
    },
    /** Electron's select-bluetooth-device, with the callback that settles the request. */
    chooserCallback() {
      const request = pending;
      return (deviceId) => {
        pending = null;
        if (deviceId === '') request.reject(new Error('NotFoundError'));
        else request.resolve({ id: `web-${deviceId}`, name: `name-${deviceId}` });
      };
    },
  };
}

function setup() {
  const win = standInWindow();
  const events = [];
  const bluetooth = createBluetooth({ gatt: win.gatt, send: (name, data) => events.push([name, data]) });
  return { win, events, bluetooth, h: bluetooth.handlers };
}

test('a scan asks for boards with SMP, and passes the ones found to the page; a stopped scan keeps its chooser to connect', async () => {
  const { win, events, bluetooth, h } = setup();
  assert.deepEqual(await h['ble.state'](), { state: 'on' });
  await h['ble.scan']({ on: true });
  assert.deepEqual(win.calls[0], ['request', [SMP_SERVICE], [STATUS_SERVICE]]);
  bluetooth.devicesFound([{ deviceId: 'AA', deviceName: 'CRANIUM-1' }], win.chooserCallback());
  assert.deepEqual(events.at(-1), ['ble.boards', { boards: [{ id: 'AA', name: 'CRANIUM-1', rssi: null }] }]);

  // The page stops the scan, then connects: the chooser is still there.
  await h['ble.scan']({ on: false });
  assert.deepEqual(await h['ble.connect']({ id: 'AA' }), { name: 'CRANIUM-1' });
  assert.deepEqual(win.calls.at(-1), ['openSmp', 'web-AA']);
  assert.deepEqual(events.at(-1), ['ble.link', { state: 'connected', name: 'CRANIUM-1', error: null }]);
  await assert.rejects(h['ble.connect']({ id: 'AA' }), (error) => error.code === 'busy');

  // The link goes: the page is told, and nothing is connected.
  bluetooth.fromWindow({ kind: 'disconnected', id: 'web-AA' });
  assert.deepEqual(events.at(-1), ['ble.link', { state: 'disconnected', name: 'CRANIUM-1', error: null }]);
  await assert.rejects(h['ble.images'](), (error) => error.code === 'failed');
});

test('a board not in the list cannot be connected to; an upload is checked first', async () => {
  const { win, bluetooth, h } = setup();
  await assert.rejects(h['ble.connect']({ id: 'BB' }), (error) => error.code === 'failed');
  await h['ble.scan']({ on: true });
  bluetooth.devicesFound([{ deviceId: 'AA', deviceName: 'CRANIUM-1' }], win.chooserCallback());
  await h['ble.connect']({ id: 'AA' });
  await assert.rejects(h['ble.upload']({ image: 'AAAA', sha256: '0'.repeat(64) }), (error) => error.code === 'bad_request');
});

test('after the restart: boards with the status service, each read once, and the one about this send followed', async () => {
  const { win, events, bluetooth, h } = setup();
  win.statuses.set('web-OLD', statusPayload({ version: [1, 13, 0, 0] }));
  win.statuses.set('web-NEW', statusPayload({ version: [1, 14, 0, 2], hash: '0011223344556677' }));
  await h['ble.watch']({ on: true, version: '1.14.0+2', hash: '0011223344556677' });
  await flush();
  assert.deepEqual(win.calls.at(-1), ['request', [STATUS_SERVICE], []]);
  const devices = [
    { deviceId: 'OLD', deviceName: 'CRANIUM-2' },
    { deviceId: 'NEW', deviceName: 'CRANIUM-1' },
  ];
  // The first one not read yet is picked: OLD, which is about another update.
  bluetooth.devicesFound(devices, win.chooserCallback());
  await flush();
  await flush();
  assert.ok(win.calls.some((call) => call[0] === 'close' && call[1] === 'web-OLD'));
  // The next look: NEW is read, and followed.
  await flush();
  bluetooth.devicesFound(devices, win.chooserCallback());
  for (let index = 0; index < 4; index += 1) await flush();
  assert.deepEqual(events.at(-1), ['ble.status', { payload: win.statuses.get('web-NEW'), afterRestart: true }]);
  assert.deepEqual(win.calls.at(-1), ['readStatus', 'web-NEW', true]);
  // Its notifications go to the page as after the restart.
  bluetooth.fromWindow({ kind: 'notify', id: 'web-NEW', key: 'status', data: 'AQ==' });
  assert.deepEqual(events.at(-1), ['ble.status', { payload: 'AQ==', afterRestart: true }]);
  await h['ble.watch']({ on: false });
  assert.deepEqual(win.calls.at(-1), ['close', 'web-NEW']);
});
