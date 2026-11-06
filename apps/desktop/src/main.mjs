/**
 * The Cranium desktop app for Windows and Linux (docs/desktop-app.md; the Mac has a native app of its own):
 * the console's and the customer site's own pages, from a copy kept on the computer and brought up to
 * date from the console, in a window that shows nothing else,
 * with the phone apps' bridge for what a page cannot do itself. The same model as the phone apps' shells
 * (docs/mobile-apps.md, "The app shell"), on Chromium: the console's USB page uses Web Serial as it does
 * in Chrome, and Bluetooth updates go through Web Bluetooth (lib/ble.mjs).
 *
 * Everything that is the same on every system is here and in lib/. A system's own parts (its menu bar,
 * its switches, its packaging) are in platform/<system>.mjs, over platform/default.mjs.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  net,
  powerSaveBlocker,
  protocol,
  safeStorage,
  session,
  shell,
} from 'electron';

import { createBluetooth } from './lib/ble.mjs';
import { BridgeError, createDispatcher, eventText, readContract } from './lib/bridge.mjs';
import { ConfigError, configResult, poolOf, readConfig } from './lib/config.mjs';
import { METHODS, FEATURES, platformWord } from './lib/features.mjs';
import { PATH } from './lib/manifest.mjs';
import {
  ORIGIN,
  SCHEME,
  contentSecurityPolicy,
  headersFor,
  isBundle,
  mayOpenOutside,
  navigation,
  originOf,
  requestPath,
  startUrl,
} from './lib/policy.mjs';
import { createBundleStore } from './lib/store.mjs';
import { CHECK_EVERY_MS, checkForNewerBuild } from './lib/updates.mjs';
import { createCognito, createVault } from './lib/vault.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PARTITION = 'persist:cranium';
// The world Electron runs an isolated preload in (webContents.executeJavaScriptInIsolatedWorld).
const PRELOAD_WORLD = 999;
const UPDATE_PAGES_EVERY_MS = 10 * 60 * 1000;
const SHELL_BUILD = '1';

let platform = await import('./platform/default.mjs');
try {
  platform = { ...platform, ...(await import(`./platform/${process.platform}.mjs`)) };
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

const log = (line) => console.log(JSON.stringify({ at: new Date().toISOString(), ...line }));

// What the app was built with: in a packaged app, its resources; from a checkout, build/ (scripts/prepare.mjs).
const RESOURCES = app.isPackaged ? process.resourcesPath : join(HERE, '..', 'build');

// The app's own name wherever Electron shows one (menus, dialogs, About, the folder of its data): a checkout runs
// Electron's own binary, which would otherwise say "Electron". A built app has it from productName as well.
const APP_NAME = 'Cranium';
app.setName(APP_NAME);
app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() });

// From a checkout only: CRANIUM_DESKTOP_SMOKE=<png> runs the app with nothing on screen (an offscreen window
// that is never shown, no dock icon), takes a picture once the page has drawn, and quits; or gives up and
// quits after SMOKE_LIMIT_MS. CI and the tests use it; it never opens a window in front of anybody.
const SMOKE = app.isPackaged ? null : process.env.CRANIUM_DESKTOP_SMOKE || null;
const SMOKE_LIMIT_MS = 45_000;
if (SMOKE) {
  app.dock?.hide();
  setTimeout(() => {
    log({ smoke: 'timed out' });
    app.exit(1);
  }, SMOKE_LIMIT_MS).unref();
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
  },
]);
platform.beforeReady({ app });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(start, (error) => {
    log({ start: 'failed', reason: String(error?.message ?? error) });
    app.quit();
  });
}

let window = null;
let launched = null;
let lastPagesCheck = 0;
let keepAwake = null;
let newerBuild = null;

async function loadConfig() {
  const source = (await readFile(join(RESOURCES, 'cranium.source'), 'utf8').catch(() => 'example')).trim();
  const text = await readFile(join(RESOURCES, 'cranium.json'), 'utf8');
  return readConfig(text, { example: source !== 'configured' });
}

async function start() {
  let contract;
  let config;
  try {
    contract = readContract(await readFile(join(RESOURCES, 'shared', 'bridge.json'), 'utf8'));
    config = await loadConfig();
  } catch (error) {
    const reason = error instanceof ConfigError ? error.message : 'the app was built without its files';
    dialog.showErrorBox('Cranium cannot start', `${reason}. Build it again (apps/desktop/README.md).`);
    app.quit();
    return;
  }

  const ses = session.fromPartition(PARTITION);
  const userData = app.getPath('userData');
  const store = createBundleStore({
    root: join(userData, 'bundle'),
    builtIn: join(RESOURCES, 'bundle'),
    fetch: (url, init) => net.fetch(url, init),
    log,
  });
  launched = await store.launch();
  if (!launched) {
    dialog.showErrorBox('Cranium cannot start', 'Not even the pages built into the app check out. Install it again.');
    app.quit();
    return;
  }

  // Only the pages' requests leave the app, and only to the console, the customer API, Cognito, the live
  // API and the map's tiles (the pages' policy says the same to the browser).
  const allowed = new Set(
    [
      originOf(config.consoleUrl),
      config.customer ? originOf(config.customer.apiUrl) : null,
      `https://cognito-idp.${config.region}.amazonaws.com`,
      config.customer ? `https://cognito-idp.${config.customer.region}.amazonaws.com` : null,
      config.liveUrl ? originOf(config.liveUrl) : null,
      'https://tile.openstreetmap.org',
    ].filter(Boolean)
  );
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    if (url.startsWith(`${SCHEME}:`) || url.startsWith('devtools:') || url.startsWith('data:')) return callback({});
    callback({ cancel: !allowed.has(originOf(url)) });
  });

  ses.protocol.handle(SCHEME, async (request) => {
    if (request.method !== 'GET' || !isBundle(request.url)) return new Response('Not found', { status: 404 });
    const path = requestPath(request.url);
    const route = Object.hasOwn(launched.manifest.routes, path) ? launched.manifest.routes[path] : null;
    const key = route ? route.file : path.slice(1);
    if (!PATH.test(key)) return new Response('Not found', { status: 404 });
    const file = await store.read(launched, key);
    if (!file) return new Response('Not found', { status: 404 });
    const csp = route ? contentSecurityPolicy(contract.policies, route.policy, config) : null;
    if (route && !csp) return new Response('Not found', { status: 404 });
    return new Response(file.bytes, { status: 200, headers: headersFor(file.type, csp) });
  });

  // Permissions: the clipboard and notifications for the bundle's pages; serial ports through the chooser
  // below; Bluetooth through lib/ble.mjs. Nothing else, and nothing for any other origin.
  const fromBundle = (url) => typeof url === 'string' && isBundle(url);
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(fromBundle(details?.requestingUrl) && ['clipboard-sanitized-write', 'notifications'].includes(permission));
  });
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    requestingOrigin === ORIGIN && ['clipboard-sanitized-write', 'notifications', 'serial'].includes(permission)
  );
  ses.setDevicePermissionHandler((details) => details.origin === ORIGIN && details.deviceType === 'serial');
  ses.on('select-serial-port', (event, ports, contents, callback) => {
    event.preventDefault();
    chooseSerialPort(ports).then(callback, () => callback(''));
  });
  ses.setBluetoothPairingHandler((details, callback) => {
    pairBoard(details).then(callback, () => callback({ confirmed: false }));
  });

  // The sign-ins: one keeper per pool, the refresh token encrypted by the system.
  const cognito = createCognito({ fetch: (url, init) => net.fetch(url, init) });
  const vaults = {};
  for (const pool of ['admin', 'customer']) {
    const client = poolOf(config, pool);
    if (!client) continue;
    const file = join(userData, `sign-in-${pool}.bin`);
    vaults[pool] = createVault({
      pool,
      client,
      storage: {
        read: () => readFile(file).catch(() => null),
        write: async (bytes) => {
          await mkdir(userData, { recursive: true });
          await writeFile(file, bytes, { mode: 0o600 });
        },
        remove: () => rm(file, { force: true }),
      },
      secrets: {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (text) => safeStorage.encryptString(text),
        decrypt: (bytes) => safeStorage.decryptString(bytes),
      },
      cognito,
    });
  }
  const vaultOf = (params) => {
    const vault = vaults[params.pool];
    if (!vault) {
      throw new BridgeError('unavailable', params.pool === 'customer' ? 'This build has no customer sign-in.' : 'This build has no sign-in.');
    }
    return vault;
  };

  function send(name, data) {
    if (!window || window.isDestroyed() || !isBundle(window.webContents.getURL())) return;
    window.webContents.send('cranium-bridge', eventText(contract, name, data));
  }

  const inPreload = (code, userGesture = false) => {
    if (!window || window.isDestroyed()) return Promise.reject(new Error('no window'));
    return window.webContents.executeJavaScriptInIsolatedWorld(PRELOAD_WORLD, [{ code }], userGesture);
  };
  const call = (name, ...args) => `globalThis.__craniumGatt.${name}(${args.map((arg) => JSON.stringify(arg)).join(', ')})`;
  const bluetooth = createBluetooth({
    gatt: {
      availability: () => inPreload(call('availability')),
      // requestDevice needs a user's gesture: the app gives the call one, as a click would.
      request: (services, optional) => inPreload(call('request', services, optional), true),
      openSmp: (id) => inPreload(call('openSmp', id)),
      write: (id, data) => inPreload(call('write', id, data)),
      readStatus: (id, follow) => inPreload(call('readStatus', id, follow)),
      close: (id) => inPreload(call('close', id)),
    },
    send,
  });

  function reloadPages() {
    store
      .launch()
      .then((next) => {
        if (next) launched = next;
        if (window && !window.isDestroyed()) {
          const current = window.webContents.getURL();
          window.loadURL(isBundle(current) ? current : startUrl(config));
        }
      })
      .catch((error) => log({ reload: 'failed', reason: String(error?.message ?? error) }));
  }

  async function lookForPages() {
    lastPagesCheck = Date.now();
    const result = await store.update(config.consoleUrl);
    if (result.status === 'new') send('app.bundleReady', { id: result.id, console: result.console });
    return result;
  }

  async function showSettings() {
    const pages = launched.manifest.consoleVersion ? `console ${launched.manifest.consoleVersion}` : 'the console';
    const source = launched.source === 'built-in' ? 'built into the app' : 'from the console';
    const lines = [
      `The pages of ${pages}, ${source} (${launched.manifest.id}).`,
      store.needsNewerApp ? 'The console has newer pages, which need a newer app.' : null,
      newerBuild ? `Cranium ${newerBuild.version} is out.` : null,
      config.example ? 'This build has the example configuration: it signs nobody in.' : null,
    ].filter(Boolean);
    const buttons = ['Look for newer pages', 'Reload the pages', ...(newerBuild ? ['Download the new app'] : []), 'Close'];
    const { response } = await dialog.showMessageBox(window, {
      type: 'info',
      title: 'Cranium',
      message: `Cranium ${app.getVersion()}`,
      detail: lines.join('\n'),
      buttons,
      defaultId: buttons.length - 1,
      cancelId: buttons.length - 1,
    });
    const chosen = buttons[response];
    if (chosen === 'Look for newer pages') {
      const result = await lookForPages();
      const words = {
        new: 'Newer pages are ready: Reload the pages shows them.',
        same: 'These are the newest pages.',
        needsNewerApp: 'The console has newer pages, which need a newer app.',
        failed: 'The console could not be reached.',
      };
      await dialog.showMessageBox(window, { type: 'info', message: words[result.status], buttons: ['OK'] });
    } else if (chosen === 'Reload the pages') {
      reloadPages();
    } else if (chosen === 'Download the new app' && newerBuild) {
      await shell.openExternal(newerBuild.url);
    }
  }

  const handlers = {
    'app.hello': () => ({
      bridge: contract.version,
      platform: platformWord(process.platform),
      shell: { version: app.getVersion(), build: SHELL_BUILD },
      bundle: { id: launched.manifest.id, console: launched.manifest.consoleVersion, source: launched.source },
      features: dispatcher.features(),
      needsNewerApp: store.needsNewerApp,
    }),
    'app.config': () => configResult(config),
    'app.ready': async () => {
      await store.ready(launched.manifest.id);
      return {};
    },
    'app.reload': () => {
      reloadPages();
      return {};
    },
    'app.open': async ({ url }) => {
      if (!mayOpenOutside(url)) throw new BridgeError('not_allowed', 'The app opens https: and otpauth: addresses only.');
      try {
        await shell.openExternal(url);
      } catch {
        throw new BridgeError('failed', 'Nothing on this computer opens that address.');
      }
      return {};
    },
    'app.settings': () => {
      showSettings().catch(() => {});
      return {};
    },
    'app.keepAwake': ({ on }) => {
      if (on && keepAwake === null) keepAwake = powerSaveBlocker.start('prevent-display-sleep');
      if (!on && keepAwake !== null) {
        powerSaveBlocker.stop(keepAwake);
        keepAwake = null;
      }
      return {};
    },
    'auth.store': (params) => vaultOf(params).store(params),
    'auth.session': (params) => vaultOf(params).session(),
    'auth.signOut': (params) => vaultOf(params).signOut(),
    'clipboard.write': ({ text, expiresIn }) => {
      clipboard.writeText(text);
      if (expiresIn) {
        setTimeout(() => {
          if (clipboard.readText() === text) clipboard.clear();
        }, expiresIn * 1000);
      }
      return {};
    },
    'file.share': async ({ name, type, data }) => {
      const extension = { 'text/csv': 'csv', 'application/json': 'json', 'text/plain': 'txt', 'application/pdf': 'pdf' }[type];
      const { canceled, filePath } = await dialog.showSaveDialog(window, {
        defaultPath: join(app.getPath('downloads'), name),
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      });
      if (canceled || !filePath) return { shared: false };
      await writeFile(filePath, Buffer.from(data, 'base64'));
      return { shared: true };
    },
    ...bluetooth.handlers,
  };
  // Exactly the methods of lib/features.mjs, which the tests hold to the contract.
  const missing = METHODS.filter((method) => !handlers[method]);
  const extra = Object.keys(handlers).filter((method) => !METHODS.includes(method));
  if (missing.length > 0 || extra.length > 0) throw new Error(`the bridge's handlers are not lib/features.mjs: ${[...missing, ...extra]}`);
  const dispatcher = createDispatcher(contract, handlers, [...FEATURES]);

  // Only the window's main frame, on the bundle's origin, is heard.
  const fromWindow = (event) =>
    window !== null &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    isBundle(event.senderFrame?.url ?? '');
  ipcMain.on('cranium-bridge', (event, text) => {
    if (!fromWindow(event)) return;
    dispatcher.handle(text).then((answer) => {
      if (answer && !event.sender.isDestroyed()) event.sender.send('cranium-bridge', answer);
    });
  });
  ipcMain.on('cranium-gatt', (event, message) => {
    if (fromWindow(event)) bluetooth.fromWindow(message);
  });

  async function chooseSerialPort(ports) {
    if (!Array.isArray(ports) || ports.length === 0) return '';
    if (ports.length === 1) return ports[0].portId;
    const names = ports.map((port) => port.displayName || port.portName || port.portId);
    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      message: 'Which serial port is the board?',
      buttons: [...names, 'Cancel'],
      cancelId: names.length,
    });
    return response < names.length ? ports[response].portId : '';
  }

  /** Windows and Linux ask the app to pair: confirm, or type the passkey the console shows. */
  async function pairBoard(details) {
    if (details.pairingKind === 'providePin') {
      const pin = await askPasskey();
      return pin ? { confirmed: true, pin } : { confirmed: false };
    }
    const shown = details.pairingKind === 'confirmPin' && details.pin ? ` The board shows ${details.pin}.` : '';
    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      message: 'Pair with the board?',
      detail: `It asks to pair, for the update over Bluetooth.${shown}`,
      buttons: ['Pair', 'Cancel'],
      cancelId: 1,
    });
    return { confirmed: response === 0 };
  }

  function askPasskey() {
    return new Promise((resolve) => {
      const box = new BrowserWindow({
        parent: window ?? undefined,
        modal: true,
        width: 360,
        height: 220,
        resizable: false,
        minimizable: false,
        maximizable: false,
        title: 'Pair with the board',
        webPreferences: {
          preload: join(HERE, 'prompt', 'passkey-preload.cjs'),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          devTools: false,
        },
      });
      box.setMenu(null);
      box.webContents.on('will-navigate', (event) => event.preventDefault());
      let done = false;
      const finish = (pin) => {
        if (done) return;
        done = true;
        ipcMain.removeListener('cranium-passkey', listener);
        if (!box.isDestroyed()) box.close();
        resolve(pin);
      };
      const listener = (event, pin) => {
        if (event.sender === box.webContents) finish(pin);
      };
      ipcMain.on('cranium-passkey', listener);
      box.on('closed', () => finish(null));
      box.loadFile(join(HERE, 'prompt', 'passkey.html'));
    });
  }

  function open() {
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.focus();
      return;
    }
    window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 380,
      minHeight: 480,
      show: false,
      title: 'Cranium',
      icon: join(HERE, '..', 'resources', 'icon.png'),
      backgroundColor: '#faf7f2',
      ...platform.windowOptions(),
      webPreferences: {
        partition: PARTITION,
        preload: join(HERE, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: !app.isPackaged,
        spellcheck: false,
        navigateOnDragDrop: false,
        safeDialogs: true,
        // A smoke run draws offscreen: nothing appears, and the picture is still taken.
        offscreen: SMOKE !== null,
      },
    });
    const contents = window.webContents;
    contents.on('select-bluetooth-device', (event, devices, callback) => {
      event.preventDefault();
      bluetooth.devicesFound(devices, callback);
    });
    const decide = (event, url, mainFrame) => {
      const what = navigation(url, { mainFrame, newWindow: false });
      if (what === 'allow') return;
      event.preventDefault();
      if (what === 'outside') shell.openExternal(url).catch(() => {});
    };
    contents.on('will-navigate', (event) => decide(event, event.url, true));
    contents.on('will-redirect', (event) => decide(event, event.url, event.isMainFrame));
    contents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame) decide(event, event.url, false);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (navigation(url, { mainFrame: true, newWindow: true }) === 'outside') shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    window.on('blur', () => {
      send('app.lifecycle', { state: 'background' });
    });
    window.on('focus', () => {
      send('app.lifecycle', { state: 'foreground' });
      if (Date.now() - lastPagesCheck >= UPDATE_PAGES_EVERY_MS) lookForPages().catch(() => {});
    });
    // A smoke run's window is never shown (SMOKE, above).
    window.once('ready-to-show', () => {
      if (!SMOKE) window.show();
    });
    if (!app.isPackaged) {
      // From a checkout: the page's warnings and errors in the terminal (apps/desktop/README.md, "Trying it").
      contents.on('console-message', (event) => {
        if (['warning', 'error'].includes(event.level)) log({ page: event.level, message: String(event.message).slice(0, 300) });
      });
    }
    if (SMOKE) {
      contents.once('did-finish-load', () => {
        setTimeout(async () => {
          const picture = await contents.capturePage();
          await writeFile(SMOKE, picture.toPNG());
          log({ smoke: 'done', url: contents.getURL(), title: contents.getTitle(), name: app.getName() });
          app.quit();
        }, Number(process.env.CRANIUM_DESKTOP_SMOKE_MS ?? 6000));
      });
    }
    window.on('closed', () => {
      bluetooth.stop();
      if (keepAwake !== null) {
        powerSaveBlocker.stop(keepAwake);
        keepAwake = null;
      }
      window = null;
    });
    // From a checkout, CRANIUM_DESKTOP_PAGE=admin opens the console first, as a build without customers does.
    const admin = !app.isPackaged && process.env.CRANIUM_DESKTOP_PAGE === 'admin';
    window.loadURL(admin ? `${ORIGIN}/admin` : startUrl(config));
  }

  const context = {
    name: app.getName(),
    isPackaged: app.isPackaged,
    settings: () => showSettings().catch(() => {}),
    reloadPages,
    about: () =>
      dialog.showMessageBox(window, {
        type: 'info',
        title: 'Cranium',
        message: `Cranium ${app.getVersion()}`,
        detail: `Pages of ${launched.manifest.consoleVersion ? `console ${launched.manifest.consoleVersion}` : 'the console'}. Electron ${process.versions.electron}.`,
        buttons: ['OK'],
      }),
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate(platform.menuTemplate(context)));

  app.on('second-instance', open);
  app.on('window-all-closed', () => {
    if (platform.quitWhenAllClosed) app.quit();
  });
  platform.afterReady({ app, open });
  open();
  lookForPages().catch(() => {});

  async function lookForBuild() {
    newerBuild = await checkForNewerBuild({
      fetch: (url, init) => net.fetch(url, init),
      platform: process.platform,
      version: app.getVersion(),
    });
    if (newerBuild) log({ newerBuild: newerBuild.version });
  }
  lookForBuild();
  setInterval(lookForBuild, CHECK_EVERY_MS).unref?.();
}

// Any other web contents (there are none) gets no window and no webview.
app.on('web-contents-created', (event, contents) => {
  contents.on('will-attach-webview', (attach) => attach.preventDefault());
});
