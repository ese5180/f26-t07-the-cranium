/**
 * The window's preload (docs/desktop-app.md, "The bridge"). Sandboxed and isolated: it runs in a world of
 * its own, and gives the page one thing only, on the bundle's origin only: the transport of the bridge.
 *
 * The transport is the iPhone app's (apps/shared/bridge.json "transport"): the page posts its request
 * with window.webkit.messageHandlers.cranium.postMessage(text), and the answer and events come as
 * `cranium-native` events on the window, with the text as their detail. So the console's pages, which
 * know that transport already (cloud/web/src/site/assets/bridge.js), work in this app as they are.
 *
 * Bluetooth: the main process drives the window's Web Bluetooth through __craniumGatt, in this world
 * (main.mjs runs it with executeJavaScriptInIsolatedWorld, where requestDevice may be called). The page
 * never sees it. Notifications and lost links go back to the main process over IPC.
 *
 * A sandboxed preload can require nothing but electron's own modules, so this file stands alone.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const ON_BUNDLE = location.protocol === 'cranium-app:' && location.host === 'bundle';
const MAX_TEXT = 4194304;

if (ON_BUNDLE) {
  contextBridge.exposeInMainWorld('webkit', {
    messageHandlers: {
      cranium: {
        postMessage(text) {
          if (typeof text === 'string' && text.length <= MAX_TEXT) ipcRenderer.send('cranium-bridge', text);
        },
      },
    },
  });
  ipcRenderer.on('cranium-bridge', (_event, text) => {
    if (typeof text === 'string') window.dispatchEvent(new CustomEvent('cranium-native', { detail: text }));
  });

  const SMP_SERVICE = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
  const SMP_CHARACTERISTIC = 'da2e7828-fbce-4e01-ae9e-261174997c48';
  const STATUS_SERVICE = '9112b1b4-2a51-40f0-94d3-a76440f0e6cc';
  const STATUS_CHARACTERISTIC = '9112b1b5-2a51-40f0-94d3-a76440f0e6cc';
  const devices = new Map();

  const toBase64 = (view) => {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  };
  const fromBase64 = (text) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
  const tell = (message) => ipcRenderer.send('cranium-gatt', message);
  const entryOf = (id) => {
    const entry = devices.get(id);
    if (!entry) throw new Error('no such board');
    return entry;
  };
  const serverOf = async (entry) => (entry.device.gatt.connected ? entry.device.gatt : entry.device.gatt.connect());

  // Not on the page's window: only this world, and so only the main process, can reach it.
  globalThis.__craniumGatt = Object.freeze({
    async availability() {
      if (!navigator.bluetooth) return 'unsupported';
      try {
        return (await navigator.bluetooth.getAvailability()) ? 'on' : 'off';
      } catch {
        return 'unknown';
      }
    },
    async request(services, optionalServices) {
      const device = await navigator.bluetooth.requestDevice({
        filters: services.map((service) => ({ services: [service] })),
        optionalServices,
      });
      const known = devices.get(device.id);
      if (!known) {
        device.addEventListener('gattserverdisconnected', () => tell({ kind: 'disconnected', id: device.id }));
        devices.set(device.id, { device, smp: null, status: null });
      }
      return { id: device.id, name: device.name || '' };
    },
    async openSmp(id) {
      const entry = entryOf(id);
      const server = await serverOf(entry);
      const characteristic = await (await server.getPrimaryService(SMP_SERVICE)).getCharacteristic(SMP_CHARACTERISTIC);
      if (entry.smp !== characteristic) {
        characteristic.addEventListener('characteristicvaluechanged', (event) =>
          tell({ kind: 'notify', id, key: 'smp', data: toBase64(event.target.value) })
        );
      }
      entry.smp = characteristic;
      // Asking for its notifications is what makes the computer pair: the board's SMP needs it.
      await characteristic.startNotifications();
      return true;
    },
    async write(id, base64) {
      const entry = entryOf(id);
      if (!entry.smp) throw new Error('no link to the board');
      await entry.smp.writeValueWithoutResponse(fromBase64(base64));
      return true;
    },
    async readStatus(id, follow) {
      const entry = entryOf(id);
      const server = await serverOf(entry);
      let characteristic;
      try {
        characteristic = await (await server.getPrimaryService(STATUS_SERVICE)).getCharacteristic(STATUS_CHARACTERISTIC);
      } catch {
        // Firmware before 1.14.0 has no status characteristic.
        return { supported: false, payload: null };
      }
      const value = await characteristic.readValue();
      if (follow) {
        if (entry.status !== characteristic) {
          characteristic.addEventListener('characteristicvaluechanged', (event) =>
            tell({ kind: 'notify', id, key: 'status', data: toBase64(event.target.value) })
          );
        }
        entry.status = characteristic;
        await characteristic.startNotifications().catch(() => {});
      }
      return { supported: true, payload: toBase64(value) };
    },
    close(id) {
      const entry = devices.get(id);
      if (entry?.device.gatt.connected) entry.device.gatt.disconnect();
      if (entry) {
        entry.smp = null;
        entry.status = null;
      }
      return true;
    },
  });
}
