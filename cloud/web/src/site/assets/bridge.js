/**
 * The bridge to the phone app around this page, when there is one (docs/mobile-apps.md, "The app
 * shell"). From 0.8.0 the iPhone and Android apps are a thin native shell that shows the console and
 * the customer site from a copy kept on the phone, and offers the page a few things a page cannot do
 * itself: keep the sign-in behind Face ID or a fingerprint, Bluetooth to a board, the clipboard,
 * haptics, sharing a file, opening SideStore or the system browser. apps/shared/bridge.json is the
 * contract, method by method; both shells check every request against it.
 *
 * On the website none of this is there: connectBridge() answers null at once, and the pages are what
 * they always were. In the app, a page finds out what it may use from the app's hello (`has`), never
 * from the kind of phone, so an older app with fewer features simply shows less.
 *
 * What the app gives the page of a sign-in is an access token, kept in memory (memoryStorage): the
 * refresh token goes to the app the moment Cognito hands it over (createVault, core.js createAuth's
 * `vault`) and never comes back.
 *
 * Nothing in this file reads the document, so the unit tests load it as it is. No dependencies.
 */

export const BRIDGE_VERSION = 1;
// What the iPhone app dispatches on the window for each message (apps/shared/bridge.json, "transport").
export const NATIVE_EVENT = 'cranium-native';
const CALL_TIMEOUT_MS = 15000;
const HELLO_TIMEOUT_MS = 5000;
// Methods that wait for a person (a biometric prompt, the pairing box, a share sheet) or for a board
// (an upload): no time limit of the page's own.
const UNTIMED = new Set([
  'auth.store',
  'auth.session',
  'biometric.set',
  'file.share',
  'update.install',
  'ble.connect',
  'ble.images',
  'ble.upload',
  'ble.status',
  'ble.watch',
]);
const FEATURES = new Set([
  'auth',
  'biometric',
  'ble',
  'clipboard',
  'haptics',
  'share',
  'open',
  'keepAwake',
  'settings',
  'appUpdate',
]);
const MAX_ID = 2147483647;

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * How messages go to the app and come back, or null on the website. The iPhone app has a script
 * message handler named cranium, and answers with an event on the window; the Android app has a
 * web message listener named craniumNative, which answers through its onmessage.
 */
export function findTransport(win) {
  const ios = win?.webkit?.messageHandlers?.cranium;
  if (ios && typeof ios.postMessage === 'function') {
    return {
      platform: 'ios',
      send: (text) => ios.postMessage(text),
      listen: (receive) => win.addEventListener(NATIVE_EVENT, (event) => receive(event?.detail)),
    };
  }
  const android = win?.craniumNative;
  if (android && typeof android.postMessage === 'function') {
    return {
      platform: 'android',
      send: (text) => android.postMessage(text),
      listen: (receive) => {
        android.onmessage = (event) => receive(event?.data);
      },
    };
  }
  return null;
}

/**
 * Requests and events over a transport: call(method, params) is a promise of the result, or a
 * BridgeError with the app's code; on(event, listener) returns a function that stops listening.
 */
export function createBridge(transport, { timers = globalThis } = {}) {
  let next = 0;
  const pending = new Map();
  const listeners = new Map();

  function settle(id, outcome) {
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    if (waiting.timer !== null) timers.clearTimeout(waiting.timer);
    outcome(waiting);
  }

  function receive(text) {
    let message;
    try {
      message = JSON.parse(String(text));
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message.event === 'string') {
      const data = isRecord(message.data) ? message.data : {};
      for (const listener of [...(listeners.get(message.event) ?? [])]) {
        try {
          listener(data);
        } catch (error) {
          console.error(error);
        }
      }
      return;
    }
    if (!Number.isInteger(message.id)) return;
    if (message.ok === true) {
      settle(message.id, ({ resolve }) => resolve(isRecord(message.result) ? message.result : {}));
    } else {
      const error = isRecord(message.error) ? message.error : {};
      const code = typeof error.code === 'string' && /^[a-z_]{1,32}$/.test(error.code) ? error.code : 'failed';
      const words =
        typeof error.message === 'string' && error.message !== ''
          ? error.message.slice(0, 500)
          : 'The app could not do that.';
      settle(message.id, ({ reject }) => reject(new BridgeError(code, words)));
    }
  }

  transport.listen(receive);

  function call(method, params = {}, { timeoutMs = UNTIMED.has(method) ? null : CALL_TIMEOUT_MS } = {}) {
    next = next >= MAX_ID ? 1 : next + 1;
    const id = next;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : timers.setTimeout(() => {
              settle(id, (waiting) => waiting.reject(new BridgeError('failed', 'The app did not answer.')));
            }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        transport.send(JSON.stringify({ v: BRIDGE_VERSION, id, method, params }));
      } catch {
        settle(id, (waiting) => waiting.reject(new BridgeError('failed', 'The app could not be asked.')));
      }
    });
  }

  function on(event, listener) {
    const list = listeners.get(event) ?? new Set();
    list.add(listener);
    listeners.set(event, list);
    return () => list.delete(listener);
  }

  return { call, on };
}

/** The app's hello, reduced to what the pages use; null when it is not one. */
export function readHello(value) {
  if (!isRecord(value) || !Number.isInteger(value.bridge) || value.bridge < 1) return null;
  const text = (item, limit = 40) => (typeof item === 'string' && item !== '' ? item.slice(0, limit) : null);
  const shell = isRecord(value.shell) ? value.shell : {};
  const bundle = isRecord(value.bundle) ? value.bundle : {};
  return {
    bridge: value.bridge,
    platform: value.platform === 'ios' || value.platform === 'android' ? value.platform : null,
    shell: { version: text(shell.version), build: text(shell.build) },
    bundle: {
      id: text(bundle.id, 16),
      console: text(bundle.console),
      source: bundle.source === 'downloaded' || bundle.source === 'built-in' ? bundle.source : null,
    },
    features: Array.isArray(value.features) ? value.features.filter((name) => FEATURES.has(name)) : [],
    // The console has newer pages than this app can take: its bridge is older than they need.
    needsNewerApp: value.needsNewerApp === true,
  };
}

/**
 * The bridge of the app this page is in, once it has said hello; null on the website. It is also
 * window.cranium.bridge, for feature detection from anywhere in the page.
 */
export async function connectBridge(win = globalThis, options = {}) {
  const transport = findTransport(win);
  if (!transport) return null;
  const bridge = createBridge(transport, options);
  const hello = readHello(await bridge.call('app.hello', {}, { timeoutMs: HELLO_TIMEOUT_MS }));
  if (!hello) throw new BridgeError('failed', 'The app said hello in a way this page does not know.');
  const features = new Set(hello.features);
  const connected = Object.freeze({
    ...bridge,
    hello,
    platform: hello.platform ?? transport.platform,
    has: (feature) => features.has(feature),
  });
  try {
    win.cranium = Object.freeze({ bridge: connected });
  } catch {
    // A window that will not take it: the pages hold the bridge themselves anyway.
  }
  return connected;
}

// The app's configuration (app.config): the values of apps/config/cranium.json that the pages need.

const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const POOL = /^([a-z]{2}(?:-[a-z]+)+-\d{1,2})_[0-9A-Za-z]{1,64}$/;
const CLIENT = /^[A-Za-z0-9]{1,128}$/;

/** The app's configuration, checked; null if it is not usable. The customer side is null without its four values. */
export function readAppConfig(value) {
  if (!isRecord(value)) return null;
  const { consoleUrl, region, userPoolId, mobileClientId } = value;
  if (typeof consoleUrl !== 'string' || !HTTPS.test(consoleUrl)) return null;
  if (typeof region !== 'string' || !REGION.test(region)) return null;
  if (typeof userPoolId !== 'string' || POOL.exec(userPoolId)?.[1] !== region) return null;
  if (typeof mobileClientId !== 'string' || !CLIENT.test(mobileClientId)) return null;
  let customer = null;
  const { customerApiUrl, customerRegion, customerUserPoolId, customerClientId } = value;
  if (
    typeof customerApiUrl === 'string' &&
    HTTPS.test(customerApiUrl) &&
    customerRegion === region &&
    typeof customerUserPoolId === 'string' &&
    POOL.exec(customerUserPoolId)?.[1] === region &&
    typeof customerClientId === 'string' &&
    CLIENT.test(customerClientId)
  ) {
    customer = {
      apiUrl: customerApiUrl.replace(/\/+$/, ''),
      userPoolId: customerUserPoolId,
      clientId: customerClientId,
    };
  }
  return {
    consoleUrl: consoleUrl.replace(/\/+$/, ''),
    region,
    userPoolId,
    mobileClientId,
    customer,
    example: value.example === true,
  };
}

const idpOf = (region) => `https://cognito-idp.${region}.amazonaws.com`;

/**
 * The console's sign-in settings in the app (core.js readConfig's shape): the phone apps' client, so
 * that the API knows a phone's session as it always has (from: phone, the 15 minutes before a change),
 * the user pool API and no managed login pages, and the console's API at its address.
 */
export function appConsoleConfig(app, origin) {
  return {
    clientId: app.mobileClientId,
    loginOrigin: '',
    scope: '',
    redirectUri: `${origin}/admin`,
    userPoolId: app.userPoolId,
    idpOrigin: idpOf(app.region),
    apiBase: app.consoleUrl,
    ...(app.customer ? { customerSite: '/' } : {}),
  };
}

/** The customer site's settings in the app (customer-core.js readSiteConfig's shape), with both APIs' addresses. */
export function appSiteConfig(app, origin) {
  if (!app.customer) return null;
  return {
    customer: { clientId: app.customer.clientId, userPoolId: app.customer.userPoolId },
    admin: { clientId: app.mobileClientId, userPoolId: app.userPoolId },
    idpOrigin: idpOf(app.region),
    home: `${origin}/`,
    adminPath: '/admin',
    customerApi: app.customer.apiUrl,
    consoleApi: app.consoleUrl,
  };
}

/** Storage that lasts as long as the page: where the access token is kept in the app. */
export function memoryStorage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => {
      items.set(key, String(value));
    },
    removeItem: (key) => {
      items.delete(key);
    },
    clear: () => items.clear(),
  };
}

/**
 * Where a sign-in is kept in the app, for createAuth (core.js): `store` hands the app the refresh
 * token, `session` asks it for an access token (it refreshes, behind the biometric if that is on),
 * `signOut` makes it forget and revoke. `pool` is 'admin' or 'customer'.
 */
export function createVault(bridge, pool) {
  return {
    store: ({ refreshToken, accessToken, idToken = null, expiresIn }) =>
      bridge.call('auth.store', {
        pool,
        refreshToken,
        accessToken,
        ...(typeof idToken === 'string' && idToken !== '' ? { idToken } : {}),
        expiresIn: Math.max(1, Math.min(86400, Math.floor(expiresIn))),
      }),
    session: () => bridge.call('auth.session', { pool }),
    signOut: () => bridge.call('auth.signOut', { pool }),
  };
}

/** The line a page shows about the app it is in: "iPhone app 0.8.0 (14), pages 2.1.1 from the console". */
export function appWords(hello) {
  if (!hello) return null;
  const name = hello.platform === 'ios' ? 'iPhone app' : hello.platform === 'android' ? 'Android app' : 'The app';
  const shell = hello.shell.version
    ? ` ${hello.shell.version}${hello.shell.build ? ` (${hello.shell.build})` : ''}`
    : '';
  const pages = hello.bundle.console ? `pages of console ${hello.bundle.console}` : 'pages';
  const source = hello.bundle.source === 'built-in' ? 'built into the app' : 'from the console';
  const newer = hello.needsNewerApp ? '. The console has newer pages, which need a newer app' : '';
  return `${name}${shell}, ${pages}, ${source}${newer}`;
}
