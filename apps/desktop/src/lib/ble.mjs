/**
 * Bluetooth for the bridge's ble.* methods (apps/shared/bridge.json; docs/desktop-app.md, 'Bluetooth'),
 * on the window's Web Bluetooth: one board at a time, the image list and the upload only.
 *
 * Web Bluetooth has no scan of its own: a page asks for a device (requestDevice) and the browser shows a
 * chooser. Here there is no chooser on screen: Electron hands the app the devices it finds
 * (select-bluetooth-device, as they come), and the app passes them to the page as ble.boards; ble.connect
 * picks one. The page's Bluetooth flow stops the scan just before it connects, so a stopped scan keeps
 * its chooser for a few seconds.
 *
 * After the restart (ble.watch) the app asks again, for boards that advertise the status service, reads
 * each one's status without pairing, and follows the one whose last update over Bluetooth is the version
 * sent, as the phone apps do.
 *
 * The window's side (preload.cjs __craniumGatt) is passed in as `gatt`, so that the tests drive this with
 * a stand-in board.
 */

import { BridgeError } from './bridge.mjs';
import { STATUS_SERVICE, aboutThisSend, readStatus, uploadImage } from './board.mjs';
import { SMP_SERVICE, SmpError, createSmpClient } from './smp.mjs';

export const CHOOSER_KEPT_MS = 8000;
export const WATCH_LOOK_MS = 10_000;
export const WATCH_AGAIN_MS = 3000;
export const PROGRESS_EVERY_MS = 200;

const base64 = (bytes) => Buffer.from(bytes).toString('base64');
const bytesOf = (text) => new Uint8Array(Buffer.from(text, 'base64'));

/**
 * @param {object} options
 * @param {object} options.gatt  availability(), request(services, optional), openSmp(id), write(id, base64),
 *                               readStatus(id, follow), close(id): the window's Web Bluetooth
 * @param {(event: string, data: object) => void} options.send  an event for the page
 * @param {object} [options.timers]
 * @param {() => number} [options.now]
 */
export function createBluetooth({ gatt, send, timers = globalThis, now = Date.now }) {
  let chooser = null; // the callback of the request under way, and how it is being used
  let scanning = false;
  let dropChooser = null;
  let request = null;
  let link = null; // { id, name, smp }
  let uploading = null;
  let watch = null;

  function chooserGone() {
    if (dropChooser) timers.clearTimeout(dropChooser);
    dropChooser = null;
    chooser = null;
  }

  function cancelChooser() {
    const callback = chooser?.callback;
    chooserGone();
    if (callback) callback('');
  }

  /** Electron's select-bluetooth-device: the devices found so far, and the callback that picks one. */
  function devicesFound(list, callback) {
    const found = (Array.isArray(list) ? list : []).map((device) => ({
      id: String(device.deviceId ?? ''),
      name: String(device.deviceName ?? ''),
    }));
    chooser = { ...(chooser ?? {}), callback, found };
    if (watch?.looking) {
      watchChoose();
      return;
    }
    if (scanning) {
      send('ble.boards', {
        boards: found.filter((device) => device.id !== '').map((device) => ({ id: device.id, name: device.name, rssi: null })),
      });
    }
  }

  function startRequest(services, optional) {
    request = gatt.request(services, optional).finally(() => {
      request = null;
    });
    // A request that ends without a device (cancelled, nothing chosen) is not an error here.
    request.catch(() => {});
    return request;
  }

  async function scan(on) {
    if (!on) {
      scanning = false;
      if (chooser && !dropChooser) dropChooser = timers.setTimeout(cancelChooser, CHOOSER_KEPT_MS);
      return {};
    }
    if (watch) stopWatching();
    scanning = true;
    if (dropChooser) {
      timers.clearTimeout(dropChooser);
      dropChooser = null;
    }
    if (!request) startRequest([SMP_SERVICE], [STATUS_SERVICE]);
    return {};
  }

  function linkGone(error = null) {
    if (!link) return;
    const { name, smp } = link;
    link = null;
    smp.reset();
    send('ble.link', { state: 'disconnected', name, error });
  }

  async function connect(pageId) {
    if (link) throw new BridgeError('busy', 'A board is connected already. Let it go first.');
    const callback = chooser?.callback;
    const known = chooser?.found?.find((device) => device.id === pageId);
    if (!callback || !request || !known) throw new BridgeError('failed', 'That board is not in the list any more. Look again.');
    const pending = request;
    scanning = false;
    chooserGone();
    callback(pageId);
    let picked;
    try {
      picked = await pending;
    } catch {
      throw new BridgeError('failed', 'The computer could not reach that board.');
    }
    const smp = createSmpClient({ write: (bytes) => gatt.write(picked.id, base64(bytes)), timers });
    link = { id: picked.id, name: known.name || picked.name, smp };
    try {
      await gatt.openSmp(picked.id);
    } catch (error) {
      const name = link.name;
      link = null;
      await Promise.resolve(gatt.close(picked.id)).catch(() => {});
      throw new BridgeError('failed', `The computer could not pair with ${name}: ${String(error?.message ?? error).slice(0, 80)}`);
    }
    send('ble.link', { state: 'connected', name: link.name, error: null });
    return { name: link.name };
  }

  function needLink() {
    if (!link) throw new BridgeError('failed', 'No board is connected.');
    return link;
  }

  function smpWords(error, fallback) {
    if (error instanceof SmpError && error.timeout) return new BridgeError('failed', 'The board did not answer.');
    if (error instanceof SmpError) return new BridgeError('failed', `${fallback}: ${error.message}`);
    return new BridgeError('failed', fallback);
  }

  async function images() {
    const { smp } = needLink();
    try {
      return { images: await smp.images() };
    } catch (error) {
      throw smpWords(error, 'The board did not list its images');
    }
  }

  async function upload({ image, sha256 }) {
    const { smp } = needLink();
    if (uploading) throw new BridgeError('busy', 'An upload is under way.');
    const { bytes, sha } = uploadImage(image, sha256);
    uploading = { cancelled: false };
    const mine = uploading;
    let told = 0;
    try {
      await smp.upload(bytes, sha, {
        progress(sent, total) {
          if (sent === total || now() - told >= PROGRESS_EVERY_MS) {
            told = now();
            send('ble.progress', { sent, total });
          }
        },
        cancelled: () => mine.cancelled,
      });
    } catch (error) {
      if (mine.cancelled) throw new BridgeError('cancelled', 'The upload was stopped.');
      throw smpWords(error, 'The upload stopped');
    } finally {
      uploading = null;
    }
    return {};
  }

  async function status() {
    const { id } = needLink();
    try {
      return await gatt.readStatus(id, true);
    } catch {
      throw new BridgeError('failed', "The board's status could not be read.");
    }
  }

  async function disconnect() {
    if (link) {
      const { id } = link;
      linkGone(null);
      await Promise.resolve(gatt.close(id)).catch(() => {});
    }
    return {};
  }

  // After the restart: one look at a time, each a request for boards with the status service.

  const pause = (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms));

  function stopWatching() {
    if (!watch) return;
    const { followed } = watch;
    watch = null;
    cancelChooser();
    if (followed) Promise.resolve(gatt.close(followed)).catch(() => {});
  }

  /** The chooser of a look has boards: the first not read yet in this pass is picked. */
  function watchChoose() {
    const candidate = chooser?.found?.find((device) => device.id !== '' && !watch.tried.has(device.id));
    if (!candidate) return;
    watch.tried.add(candidate.id);
    watch.looking = false;
    const callback = chooser.callback;
    chooserGone();
    callback(candidate.id);
  }

  /** One look: the board picked, or null when none new came in time. */
  async function lookOnce(mine) {
    if (request) await request.catch(() => {});
    if (watch !== mine) return null;
    mine.looking = true;
    const pending = startRequest([STATUS_SERVICE], []);
    const timer = timers.setTimeout(() => {
      if (mine.looking) {
        mine.looking = false;
        cancelChooser();
      }
    }, WATCH_LOOK_MS);
    try {
      return await pending;
    } catch {
      return null;
    } finally {
      timers.clearTimeout(timer);
      mine.looking = false;
    }
  }

  async function watchLoop(mine) {
    while (watch === mine && !mine.followed) {
      const picked = await lookOnce(mine);
      if (watch !== mine) return;
      if (!picked) {
        // Every board in reach was read in this pass, or none came: read them all again in a moment.
        mine.tried.clear();
        await pause(WATCH_AGAIN_MS);
        continue;
      }
      const answer = await Promise.resolve(gatt.readStatus(picked.id, false)).catch(() => null);
      if (watch !== mine) {
        await Promise.resolve(gatt.close(picked.id)).catch(() => {});
        return;
      }
      const payload = answer?.supported ? answer.payload : null;
      if (payload && aboutThisSend(readStatus(bytesOf(payload)), mine.version, mine.hash)) {
        mine.followed = picked.id;
        send('ble.status', { payload, afterRestart: true });
        // Its notifications from here on; the first read is told either way.
        await Promise.resolve(gatt.readStatus(picked.id, true)).catch(() => {});
        return;
      }
      await Promise.resolve(gatt.close(picked.id)).catch(() => {});
    }
  }

  async function watchOn({ on, version, hash }) {
    stopWatching();
    if (!on) return {};
    if (!version) throw new BridgeError('bad_request', 'version is missing.');
    scanning = false;
    cancelChooser();
    watch = { version, hash: hash ?? null, tried: new Set(), looking: false, followed: null };
    watchLoop(watch);
    return {};
  }

  /** The window's Web Bluetooth told the app something: a notification, or a lost link. */
  function fromWindow(message) {
    if (message?.kind === 'disconnected') {
      if (link && message.id === link.id) linkGone(null);
      if (watch?.followed === message.id) {
        // The board it followed went (it restarted again, or went out of reach): look for it again.
        const mine = watch;
        mine.followed = null;
        mine.tried.clear();
        pause(WATCH_AGAIN_MS).then(() => watch === mine && !mine.followed && watchLoop(mine));
      }
      return;
    }
    if (message?.kind !== 'notify' || typeof message.data !== 'string') return;
    if (message.key === 'smp' && link && message.id === link.id) link.smp.notified(bytesOf(message.data));
    if (message.key === 'status') {
      const afterRestart = watch?.followed === message.id;
      if (afterRestart || (link && message.id === link.id)) send('ble.status', { payload: message.data, afterRestart });
    }
  }

  return Object.freeze({
    devicesFound,
    fromWindow,
    handlers: {
      'ble.state': async () => ({ state: await Promise.resolve(gatt.availability()).catch(() => 'unknown') }),
      'ble.scan': ({ on }) => scan(on),
      'ble.connect': ({ id }) => connect(id),
      'ble.images': () => images(),
      'ble.upload': (params) => upload(params),
      'ble.cancel': () => {
        if (uploading) uploading.cancelled = true;
        return {};
      },
      'ble.status': () => status(),
      'ble.disconnect': () => disconnect(),
      'ble.watch': (params) => watchOn(params),
    },
    /** The window went away: nothing of Bluetooth goes on. */
    stop() {
      stopWatching();
      scanning = false;
      cancelChooser();
      if (link) linkGone(null);
    },
  });
}
