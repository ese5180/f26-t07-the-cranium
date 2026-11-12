/**
 * Tests for the console as a whole: app.js, the very file the browser loads, started
 * in a stand-in for a browser tab. The API is a table of replies, the clock and the
 * timers are the test's, and the tests do what a person does: they look at the page,
 * press buttons, type into fields and wait.
 *
 * What is checked here is what only the whole can show: that the page stops asking
 * while the tab is hidden, that it leaves for the sign-in page in time and not in the
 * middle of something, that it comes back to where it was, and that a dialog tells the
 * truth after the server has said no.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createCognito } from './cognito.mjs';
import {
  CORE,
  HISTORY,
  NEIGHBOURS,
  SERIAL,
  TELEMETRY,
  VIEWS,
  all,
  click,
  controls,
  createDocument,
  descendants,
  one,
  scriptAddress,
  textOf,
} from './page.mjs';
// The Map and Account pages (docs/fleet.md).
import { ACCOUNT, APPS, BLUETOOTH, BRIDGE, CUSTOMERS, FLEET, LABELS, LIVE, MAP, MEMFAULT } from './page.mjs';
import {
  INSTALLING,
  MANAGER,
  NEVER,
  NOW,
  OFFERED,
  REASON,
  WAITING,
  WITHDRAWN,
  WORLD,
  ago,
  deployment,
  device,
  execution,
  release,
  repliesFor,
  revoked,
} from './world.mjs';

// The scripts app.js fetches when it needs them (fleet.js once it has started, the others with their
// pages): read here first, each arrives at once, as from a browser's cache, and not part way through
// a test's clock.
await Promise.all(
  [FLEET, MAP, ACCOUNT, SERIAL, HISTORY, TELEMETRY, BRIDGE, BLUETOOTH, MEMFAULT].map((address) => import(address))
);

// The real timer, kept for waiting on work that is not on the test's clock (hashing).
const realTimeout = globalThis.setTimeout;
const pause = (ms) => new Promise((resolve) => realTimeout(resolve, ms));

/** Let everything that is ready to run, run. */
async function settle() {
  for (let round = 0; round < 4; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function until(check, what) {
  for (let waited = 0; waited < 3000; waited += 2) {
    await settle();
    if (check()) return;
    await pause(2);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const LOGIN = 'https://login.example';
const IDP = 'https://idp.example';
const CONFIG = {
  clientId: 'client-1',
  loginOrigin: LOGIN,
  scope: 'openid cranium/console',
  redirectUri: 'https://console.example/',
  userPoolId: 'xx-test-1_Pool0Tests',
  idpOrigin: IDP,
};
// The account the console's own sign-in page signs in with. Made up for these tests.
const PERSON = {
  email: MANAGER.email,
  userId: MANAGER.sub,
  password: 'Only-For-Tests-7',
  code: '135790',
};
const TOKENS = {
  access_token: 'FRESH-TOKEN',
  refresh_token: 'REFRESH',
  token_type: 'Bearer',
  expires_in: 3600,
};

const refusal = (status, code, message, details) =>
  Response.json({ error: { code, message, requestId: 'req-9', details } }, { status });
/** An answer of the gateway itself, which carries no error code of the API. */
const gateway = (status, message) => Response.json({ message }, { status });

let copies = 0;

/** Give the tab's browser Web Serial, with no port to offer. */
function navigatorSerial() {
  globalThis.navigator.serial = {
    requestPort: async () => {
      throw Object.assign(new Error('none'), { name: 'NotFoundError' });
    },
    addEventListener() {},
  };
}

/**
 * A browser tab with the console in it, signed in unless told otherwise.
 *
 * @param {object} t                      the test: its clock and timers become the tab's
 * @param {object} [options]
 * @param {object} [options.world]        what the API has (world.mjs)
 * @param {boolean} [options.viewer]      signed in as a viewer
 * @param {string} [options.hash]         the address the tab is opened at
 * @param {string} [options.search]       its query string, as after coming back from sign-in
 * @param {number|null} [options.session] seconds the stored token is still good for; null for none
 * @param {object} [options.stored]       what else session storage holds
 * @param {boolean} [options.touch]       the tab is on a touch screen
 * @param {Function} [options.answer]     (method, url, body) => Response, asked first; whatever
 *                                        it leaves unanswered comes from the table of replies
 * @param {Function} [options.upload]     (body) => { status, body } for an upload
 * @param {Function} [options.BroadcastChannel]  what the tab has for a line to other tabs; by
 *                                        default nothing, as in a browser without one
 * @param {object[]} [options.users]      the accounts of Cognito's user pool API (cognito.mjs)
 * @param {Function} [options.fail]       an error for Cognito to answer a call with, by name
 * @param {object} [options.app]          the tab is the phone app's (bridge.js): a stand-in for the iPhone
 *                                        app's bridge, with answers by method that replace APP_ANSWERS'
 * @param {string} [options.liveUrl]      the live API's address in the page's settings (docs/live.md)
 * @param {Function} [options.WebSocket]  what the tab has for a WebSocket, with liveUrl
 */
async function openTab(t, options = {}) {
  const {
    world = WORLD,
    viewer = false,
    hash = '#/overview',
    search = '',
    session = 3600,
    stored = {},
    touch = false,
    answer = () => null,
    upload = () => ({ status: 500, body: {} }),
    BroadcastChannel,
    users = [PERSON],
    fail,
    app = null,
    liveUrl = null,
    WebSocket = null,
    // The page's own origin, for a board's QR code: none, as before, unless a test gives one.
    origin = undefined,
  } = options;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  // Node has a WebSocket of its own: a tab never gets it, only the stand-in it is given.
  const realSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: WebSocket ?? undefined, configurable: true, writable: true });
  t.after(() =>
    Object.defineProperty(globalThis, 'WebSocket', { value: realSocket, configurable: true, writable: true })
  );
  const cognito = createCognito({ userPoolId: CONFIG.userPoolId, clientId: CONFIG.clientId, users, fail });

  const replies = repliesFor(world, { viewer });
  const requests = [];
  const headersSent = [];
  const navigations = [];
  const document = createDocument(['skip', 'main', 'nav', 'account', 'toasts', 'announcer']);
  document.querySelector = (selector) =>
    selector === 'meta[name="cranium-config"]'
      ? { content: JSON.stringify(liveUrl ? { ...CONFIG, liveUrl } : CONFIG) }
      : null;

  const storage = new Map(Object.entries(stored));
  if (session !== null) {
    const expiresAt = NOW / 1000 + session;
    storage.set('cranium.session', JSON.stringify({ accessToken: 'TOKEN', expiresAt }));
  }
  const sessionStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  };

  const listeners = new Map();
  const tell = (type) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener({ type });
  };
  let address = hash;
  const location = {
    pathname: '/',
    origin,
    search,
    get hash() {
      return address;
    },
    set hash(value) {
      address = value;
      tell('hashchange');
    },
    assign: (url) => navigations.push(url),
    reload: () => navigations.push('reload'),
  };
  const history = {
    replaceState(_state, _title, url) {
      const mark = url.indexOf('#');
      location.search = '';
      address = mark === -1 ? '' : url.slice(mark);
    },
  };

  async function fetch(address, init = {}) {
    // In the app the API is at the console's address; the table of replies goes by path.
    const url = app && address.startsWith(APP_API) ? address.slice(APP_API.length) : address;
    const method = init.method ?? 'GET';
    const json = typeof init.body === 'string' && init.body.startsWith('{');
    const body = json ? JSON.parse(init.body) : init.body;
    requests.push({ method, url, body, token: init.headers?.authorization ?? null, ...(app ? { address } : {}) });
    headersSent.push(init.headers ?? {});
    const special = answer(method, url, body);
    if (special) return special;
    if (url.startsWith(IDP)) return cognito.fetch(IDP, url, init);
    if (url === `${LOGIN}/oauth2/revoke`) return new Response(null, { status: 200 });
    if (method === 'GET' && replies.has(url)) return Response.json(replies.get(url));
    return refusal(404, 'not_found', `There is nothing at ${url}.`);
  }

  // The little of XMLHttpRequest that the upload uses.
  class Upload {
    constructor() {
      this.upload = {};
    }

    open(method, path) {
      this.method = method;
      this.path = path;
    }

    setRequestHeader() {}

    getResponseHeader() {
      return null;
    }

    send(text) {
      const sent = JSON.parse(text);
      requests.push({ method: this.method, url: this.path, body: { ...sent, data: '(the file)' } });
      const reply = upload(sent);
      this.upload.onprogress({ lengthComputable: true, loaded: 1, total: 2 });
      this.upload.onload();
      this.status = reply.status;
      this.responseText = JSON.stringify(reply.body);
      this.onload();
    }
  }

  const window = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    scrollTo() {},
    matchMedia: (query) => ({ matches: touch && query === '(pointer: coarse)' }),
    crypto: globalThis.crypto,
    fetch,
    sessionStorage,
    location,
    history,
    XMLHttpRequest: Upload,
    BroadcastChannel,
  };
  // The phone app: what the page asks of it, answered a moment later as the app does, by an event.
  const appCalls = [];
  if (app) {
    const answers = { ...APP_ANSWERS, ...app };
    window.webkit = {
      messageHandlers: {
        cranium: {
          postMessage(text) {
            const message = JSON.parse(text);
            appCalls.push(message);
            const reply = answers[message.method];
            queueMicrotask(() => {
              const result = typeof reply === 'function' ? reply(message.params) : reply;
              let detail;
              if (result === undefined)
                detail = { id: message.id, ok: false, error: { code: 'unknown_method', message: 'No such method.' } };
              else if (result.refuse)
                detail = { id: message.id, ok: false, error: { code: result.refuse, message: 'Refused.' } };
              else detail = { id: message.id, ok: true, result };
              detail = JSON.stringify(detail);
              for (const listener of [...(listeners.get('cranium-native') ?? [])])
                listener({ type: 'cranium-native', detail });
            });
          },
        },
      },
    };
  }
  const navigator = { clipboard: { writeText: async () => {} } };
  for (const [name, value] of Object.entries({ document, window, location, history, navigator })) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }

  // A copy of app.js of its own: the script starts the console when it is loaded.
  copies += 1;
  await import(
    scriptAddress(
      'app.js',
      {
        'core.js': CORE,
        'views.js': VIEWS,
        'serial.js': SERIAL,
        'history.js': HISTORY,
        'telemetry.js': TELEMETRY,
        'map.js': MAP,
        'account.js': ACCOUNT,
        'fleet.js': FLEET,
        'bridge.js': BRIDGE,
        'bluetooth.js': BLUETOOTH,
        'live.js': LIVE,
        'memfault-page.js': MEMFAULT,
        'labels.js': LABELS,
        'apps.js': APPS,
        'customers.js': CUSTOMERS,
      },
      `tab ${copies}`
    )
  );
  await settle();

  const main = document.getElementById('main');
  const tab = {
    document,
    location,
    cognito,
    appCalls,
    requests,
    headersSent,
    navigations,
    replies,
    storage,
    main,
    nav: document.getElementById('nav'),
    account: document.getElementById('account'),
    /** The open dialog, or null. */
    dialog: () => all(document.body, 'dialog').find((el) => el.open) ?? null,
    toasts: () => all(document.getElementById('toasts'), 'div.toast').map(textOf),
    /** Requests since the mark, as "METHOD path". */
    since: (mark) => requests.slice(mark).map((request) => `${request.method} ${request.url}`),
    /** From now on the API has this world. */
    becomes(next) {
      for (const [path, body] of repliesFor(next, { viewer })) replies.set(path, body);
    },
    /** Let time pass on the tab's clock, then let what that set off run. */
    async wait(ms) {
      t.mock.timers.tick(ms);
      await settle();
    },
    async goto(route) {
      location.hash = route;
      await settle();
    },
    async press(root, selector, words) {
      click(one(root, selector, words));
      await settle();
    },
    /** Submit the form of the open dialog, as Enter on its submit button does. */
    async submit() {
      one(tab.dialog(), 'form').dispatchEvent({ type: 'submit' });
      await settle();
    },
    async type(field, text) {
      field.value = text;
      field.dispatchEvent({ type: 'input', target: field });
      await settle();
    },
    async hide(hidden) {
      document.visibilityState = hidden ? 'hidden' : 'visible';
      document.dispatchEvent({ type: 'visibilitychange' });
      await settle();
    },
  };
  return tab;
}

const sentTo = (tab, url) => tab.requests.filter((request) => request.url === url);

// The phone app's side (bridge.js, apps/shared/bridge.json): an iPhone app with everything, signed in as the
// release manager of the world, with the console's API at its own address.
const APP_API = 'https://console.example';
const APP_ANSWERS = {
  'app.hello': {
    bridge: 1,
    platform: 'ios',
    shell: { version: '0.8.0', build: '14' },
    bundle: { id: '0123456789abcdef', console: '2.1.1', source: 'downloaded' },
    features: ['auth', 'biometric', 'ble', 'clipboard', 'haptics', 'share', 'open', 'keepAwake', 'settings'],
  },
  'app.config': {
    consoleUrl: APP_API,
    region: 'xx-test-1',
    userPoolId: CONFIG.userPoolId,
    mobileClientId: 'phoneclient0',
    customerApiUrl: null,
    customerRegion: null,
    customerUserPoolId: null,
    customerClientId: null,
    example: false,
  },
  'app.ready': {},
  'auth.session': { signedIn: true, accessToken: 'APP-TOKEN', expiresIn: 3600 },
  'ble.state': { state: 'on' },
  'clipboard.write': {},
};
const WRITES = new Set([
  'Deploy',
  'Revoke',
  'Finish revoking',
  'Apply the revocation again',
  'New deployment',
  'Cancel deployment',
  'Upload for verification',
]);
// The buttons of a release are named with its version, as in "Revoke 1.2.3+5".
const writes = (root) => controls(root).filter((label) => WRITES.has(label.replace(/ \d\S*$/, '')));
const releaseRow = (tab, version) => one(tab.main, 'li.release', version);
const badges = (row) => all(one(row, 'div.release-title'), 'span.badge').map(textOf);

// Starting up.

test('the console starts on the page in the address and loads what that page shows', async (t) => {
  const tab = await openTab(t);
  assert.equal(tab.document.title, 'Overview · Cranium');
  assert.equal(textOf(one(tab.main, 'h1')), 'Overview');
  assert.equal(one(tab.nav, 'a', 'Overview').getAttribute('aria-current'), 'page');
  assert.equal(textOf(one(tab.account, 'span.account-email')), MANAGER.email);
  assert.equal(textOf(one(tab.account, 'span.account-role')), 'Release manager');
  assert.equal(textOf(one(tab.account, 'span.account-session')), 'Session ends in 1 h');

  assert.deepEqual(tab.since(0).sort(), [
    'GET /api/audit?limit=6',
    'GET /api/deployments',
    `GET /api/deployments/${OFFERED}`,
    // Cancelled, but its board is still installing: its boards are followed too.
    `GET /api/deployments/${WITHDRAWN}`,
    'GET /api/devices',
    'GET /api/firmware',
    // What fleet.js shows on the overview: the boards' types and groups, and the fleet's health.
    'GET /api/fleet',
    'GET /api/fleet/health?days=30',
    'GET /api/me',
    // Every update of every board however it came, for the Updates card.
    'GET /api/updates?limit=25',
  ]);
  assert.equal(
    tab.requests.every((request) => request.token === 'Bearer TOKEN'),
    true
  );
  assert.deepEqual(
    all(tab.main, 'li.run').map((run) => textOf(one(run, 'a.run-version'))),
    ['1.2.3+5', '1.2.4+0']
  );
  assert.deepEqual(tab.navigations, []);
});

test('an address that is not a page of the console becomes the overview, and says so', async (t) => {
  const tab = await openTab(t, { hash: '#/https://evil.example/' });
  assert.equal(tab.location.hash, '#/overview');
  assert.equal(textOf(one(tab.main, 'h1')), 'Overview');
  assert.deepEqual(tab.toasts(), ['That address is not a page of this console. Here is the overview.']);
});

test('the Fleet page has moved (#115): its address leads to Deployments, and says where its parts went', async (t) => {
  const tab = await openTab(t, { hash: '#/fleet' });
  assert.equal(tab.location.hash, '#/deployments');
  assert.equal(textOf(one(tab.main, 'h1')), 'Deployments');
  assert.deepEqual(tab.toasts(), ['The Fleet page is now part of Deployments; groups of boards are on Devices.']);
});

test('the console opened without an address is not an address that went wrong', async (t) => {
  const tab = await openTab(t, { hash: '' });
  assert.equal(tab.location.hash, '#/overview');
  assert.deepEqual(tab.toasts(), []);
});

test('the title of the tab tells open tabs apart', async (t) => {
  const tab = await openTab(t, { hash: `#/devices/${WAITING}` });
  assert.equal(tab.document.title, 'cranium-0000… · Cranium');
  await tab.goto(`#/deployments/${OFFERED}`);
  assert.equal(tab.document.title, 'Deployment of 1.2.3+5 · Cranium');
  await tab.goto('#/firmware');
  assert.equal(tab.document.title, 'Firmware · Cranium');
});

test('a board with a name of its own has its tab called by it, once the board has been read', async (t) => {
  const named = {
    ...WORLD,
    devices: WORLD.devices.map((item) => (item.thing === WAITING ? { ...item, name: 'CRVIHAAN01' } : item)),
  };
  const tab = await openTab(t, { world: named, hash: `#/devices/${WAITING}` });
  await until(() => tab.document.title === 'CRVIHAAN01 · Cranium', "the title with the board's name");
  assert.equal(textOf(one(tab.main, 'h1')), 'Board CRVIHAAN01');
  await tab.goto(`#/devices/${INSTALLING}`);
  assert.equal(tab.document.title, 'cranium-0000… · Cranium');
});

test('a screen reader hears a board change state on every page but the one that says it itself', async (t) => {
  const waiting = { ...WORLD, devices: [WORLD.devices[0]] };
  const tab = await openTab(t, { world: waiting });
  const heard = () => textOf(tab.document.getElementById('announcer'));
  assert.equal(heard(), '', 'the first look at a board is not news');
  const moved = {
    ...WORLD.devices[0],
    ota: { state: 'downloading', job: OFFERED, progress: 10, last: 'none', error: '' },
  };
  tab.becomes({ ...WORLD, devices: [moved] });
  await tab.wait(3000);
  assert.equal(heard(), 'cranium-0000…: Downloading 1.2.3+5.');
});

const NAMED_WORLD = {
  ...WORLD,
  devices: WORLD.devices.map((item) => (item.thing === WAITING ? { ...item, name: 'CRVIHAAN01' } : item)),
};

test('the activity log does not read the list of boards when no entry names a board', async (t) => {
  const tab = await openTab(t, { world: NAMED_WORLD, hash: '#/activity' });
  await until(() => all(tab.main, 'li.log-line').length > 0, 'the log');
  assert.equal(sentTo(tab, '/api/devices').length, 0);
});

test('the activity log reads the list of boards when an entry names a board, to call it by its name', async (t) => {
  const named = NAMED_WORLD;
  const read = {
    at: ago(30),
    actor: MANAGER,
    action: 'pairing.read',
    target: 'Cranium-1A2B',
    outcome: 'ok',
    detail: { thing: WAITING },
    requestId: 'req-2',
  };
  const tab = await openTab(t, { world: { ...named, entries: [read, ...named.entries] }, hash: '#/activity' });
  await until(
    () => all(tab.main, 'li.log-line').length > 0 && sentTo(tab, '/api/devices').length > 0,
    'the log and the boards'
  );
  await settle();
  assert.match(textOf(all(tab.main, 'li.log-line')[0]), new RegExp(`Board CRVIHAAN01 ${WAITING}`));
});

test('a toast stays until it has been read, and can be closed', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware' });
  const copy = async () => {
    click(all(tab.main, 'button').find((item) => item.getAttribute('aria-label') === 'Copy the key fingerprint'));
    await settle();
  };
  await copy();
  assert.deepEqual(tab.toasts(), ['Copied the key fingerprint.']);
  const [toast] = all(tab.document.getElementById('toasts'), 'div.toast');
  // Held while the pointer is on it.
  toast.dispatchEvent({ type: 'mouseenter' });
  await tab.wait(60000);
  assert.equal(tab.toasts().length, 1);
  toast.dispatchEvent({ type: 'mouseleave' });
  await tab.wait(5000);
  assert.deepEqual(tab.toasts(), []);

  await copy();
  click(one(tab.document.getElementById('toasts'), 'button'));
  assert.deepEqual(tab.toasts(), []);
});

test('closing a toast with the keyboard leaves the keyboard in the page', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware' });
  click(all(tab.main, 'button').find((item) => item.getAttribute('aria-label') === 'Copy the key fingerprint'));
  await settle();
  const toast = one(tab.document.getElementById('toasts'), 'div.toast');
  const close = one(toast, 'button');
  const before = one(tab.main, 'h1');
  // Where the keyboard came from is where it goes back to.
  const from = all(tab.main, 'button').find((item) => item.getAttribute('aria-label') === 'Copy the key fingerprint');
  from.focus();
  close.focus();
  toast.dispatchEvent({ type: 'focusin', relatedTarget: from });
  click(close);
  assert.deepEqual(tab.toasts(), []);
  assert.equal(tab.document.activeElement, from);

  // If that is gone, the page's title has it.
  click(from);
  await settle();
  const second = one(tab.document.getElementById('toasts'), 'div.toast');
  one(second, 'button').focus();
  second.dispatchEvent({ type: 'focusin', relatedTarget: null });
  click(one(second, 'button'));
  assert.equal(tab.document.activeElement.id, 'page-title');
  assert.equal(before.id, 'page-title');
});

test('a toast that goes by itself does not move the keyboard', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware' });
  const from = all(tab.main, 'button').find((item) => item.getAttribute('aria-label') === 'Copy the key fingerprint');
  from.focus();
  click(from);
  await settle();
  await tab.wait(5000);
  assert.deepEqual(tab.toasts(), []);
  assert.equal(tab.document.activeElement, from);
});

test('the second press of a double click does not close the dialog that the first one opened', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware' });
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Revoke');
  const dialog = tab.dialog();
  const pressBackdrop = () => {
    dialog.dispatchEvent({ type: 'mousedown', target: dialog });
    dialog.dispatchEvent({ type: 'click', target: dialog });
  };
  pressBackdrop();
  assert.notEqual(tab.dialog(), null);
  await tab.wait(400);
  pressBackdrop();
  assert.equal(tab.dialog(), null, 'after that, the backdrop closes it as usual');
});

test('when the control that had the focus goes away, the keyboard stays in the page', async (t) => {
  const finished = deployment(OFFERED, {
    status: 'COMPLETED',
    completedAt: ago(0),
    executions: [execution(WAITING, 'succeeded', { status: 'SUCCEEDED', startedAt: ago(100) })],
  });
  const tab = await openTab(t, { hash: `#/deployments/${OFFERED}` });
  one(tab.main, 'button', 'Cancel deployment').focus();
  tab.becomes({ ...WORLD, deployments: [finished] });
  await tab.wait(3000);
  assert.deepEqual(writes(tab.main), []);
  assert.equal(tab.document.activeElement.id, 'page-title');
});

test('a deployment that ends while its cancel button has the focus does not hand it to another button', async (t) => {
  const declined = deployment(OFFERED, {
    status: 'COMPLETED',
    completedAt: ago(0),
    executions: [execution(WAITING, 'declined', { status: 'REJECTED', reason: 'declined', startedAt: null })],
  });
  const tab = await openTab(t, { hash: `#/deployments/${OFFERED}` });
  one(tab.main, 'button', 'Cancel deployment').focus();
  tab.becomes({ ...WORLD, deployments: [declined] });
  await tab.wait(3000);
  assert.equal(one(tab.main, 'button', 'Offer again').getAttribute('class'), 'ui-btn btn');
  assert.equal(tab.document.activeElement.id, 'page-title');
});

test('an account that was removed or disabled is told that, and not that it can be added to a group', async (t) => {
  const tab = await openTab(t, {
    answer: (method, url) =>
      url === '/api/me' ? refusal(403, 'account_inactive', 'Your account is disabled or not confirmed.') : null,
  });
  const words = textOf(tab.main);
  assert.match(words, /^.*Your account is not active/);
  assert.match(words, /disabled or removed/);
  assert.doesNotMatch(words, /no access yet|neither|add you/);
  assert.equal(all(tab.main, 'button').map(textOf).join(), 'Sign out');
});

test('an account that is in no group is told so', async (t) => {
  const tab = await openTab(t, {
    answer: (method, url) => (url === '/api/me' ? refusal(403, 'no_access', 'Not in a group.') : null),
  });
  assert.match(textOf(tab.main), /Your account has no access yet/);
});

test('the same message twice is one toast, that stays for longer', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware' });
  const copy = async () => {
    click(all(tab.main, 'button').find((item) => item.getAttribute('aria-label') === 'Copy the key fingerprint'));
    await settle();
  };
  await copy();
  await tab.wait(4000);
  await copy();
  assert.deepEqual(tab.toasts(), ['Copied the key fingerprint.']);
  await tab.wait(4000);
  assert.deepEqual(tab.toasts(), ['Copied the key fingerprint.'], 'its time started again');
  await tab.wait(1000);
  assert.deepEqual(tab.toasts(), []);
  await copy();
  assert.deepEqual(tab.toasts(), ['Copied the key fingerprint.'], 'and once it is gone it can come again');
});

test('a viewer gets the pages without the controls', async (t) => {
  const tab = await openTab(t, { viewer: true, hash: '#/firmware' });
  assert.equal(textOf(one(tab.account, 'span.account-role')), 'Viewer');
  assert.equal(all(tab.main, 'li.release').length, 4);
  assert.deepEqual(writes(tab.main), []);
  assert.equal(all(tab.main, 'label.drop').length, 0);
  await tab.goto(`#/deployments/${OFFERED}`);
  assert.equal(textOf(one(tab.main, 'h1')), 'Deployment of 1.2.3+5 Waiting for boards');
  assert.deepEqual(writes(tab.main), []);
});

// Refreshing.

test('a page is read again while boards are busy, and not while the tab is hidden', async (t) => {
  const tab = await openTab(t);
  // A board is downloading: every 3 s.
  assert.match(textOf(one(tab.main, 'span.freshness-live')), /Live · every 3 s/);
  let mark = tab.requests.length;
  await tab.wait(2900);
  assert.deepEqual(tab.since(mark), []);
  await tab.wait(100);
  assert.deepEqual(
    tab.since(mark).sort(),
    [
      'GET /api/deployments',
      `GET /api/deployments/${OFFERED}`,
      `GET /api/deployments/${WITHDRAWN}`,
      'GET /api/devices',
    ],
    'the releases and the log are not asked for every time'
  );

  await tab.hide(true);
  mark = tab.requests.length;
  await tab.wait(60000);
  assert.deepEqual(tab.since(mark), [], 'nothing is asked for in the background');

  // Back in front, the page is brought up to date at once.
  await tab.hide(false);
  assert.equal(tab.since(mark).includes('GET /api/devices'), true);
  mark = tab.requests.length;
  await tab.wait(3000);
  assert.equal(tab.since(mark).includes('GET /api/devices'), true, 'and the schedule goes on');
});

test('a page whose boards are at rest is read every 30 s, and so are lists that others can change', async (t) => {
  const calm = { ...WORLD, devices: [WORLD.devices[2]], deployments: [WORLD.deployments[2]] };
  const tab = await openTab(t, { world: calm });
  assert.equal(all(tab.main, 'span.freshness-live').length, 0);
  let mark = tab.requests.length;
  await tab.wait(29000);
  assert.deepEqual(tab.since(mark), []);
  await tab.wait(1000);
  assert.equal(tab.since(mark).includes('GET /api/devices'), true);

  await tab.goto('#/firmware');
  mark = tab.requests.length;
  await tab.wait(29000);
  assert.deepEqual(tab.since(mark), []);
  await tab.wait(1000);
  assert.deepEqual(tab.since(mark).sort(), ['GET /api/firmware', 'GET /api/fleet'], 'and what fleet.js shows of it');

  await tab.goto('#/activity');
  mark = tab.requests.length;
  await tab.wait(30000);
  assert.equal(tab.since(mark).includes('GET /api/audit?limit=50'), true);
});

test('a refresh by the clock waits while it would get in the way', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware' });
  // With a dialog open.
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Revoke');
  let mark = tab.requests.length;
  await tab.wait(60000);
  assert.deepEqual(tab.since(mark), []);
  await tab.press(tab.dialog(), 'button', 'Keep the release');
  mark = tab.requests.length;
  await tab.wait(30000);
  assert.deepEqual(tab.since(mark).sort(), ['GET /api/firmware', 'GET /api/fleet']);

  // With a file in hand.
  await chooseFile(tab);
  mark = tab.requests.length;
  await tab.wait(60000);
  assert.deepEqual(tab.since(mark), []);
  await tab.press(tab.main, 'button', 'Choose another file');
  await tab.wait(30000);
  assert.deepEqual(tab.since(mark).sort(), ['GET /api/firmware', 'GET /api/fleet']);
});

test('the log does not take away the pages that were loaded by hand', async (t) => {
  const entries = Array.from({ length: 51 }, () => WORLD.entries[0]);
  const tab = await openTab(t, {
    hash: '#/activity',
    answer: (method, url) => {
      if (url === '/api/audit?limit=50') return Response.json({ entries: entries.slice(0, 50), next: 'more' });
      if (url === '/api/audit?limit=50&before=more') return Response.json({ entries: entries.slice(50), next: null });
      return null;
    },
  });
  await tab.press(tab.main, 'button', 'Load more');
  assert.equal(all(tab.main, 'li.log-line').length, 51);
  const mark = tab.requests.length;
  await tab.wait(60000);
  assert.deepEqual(tab.since(mark), []);
  assert.equal(all(tab.main, 'li.log-line').length, 51);
});

test('a board that a forced cancellation found restarting is followed until it is back', async (t) => {
  const started = { status: 'CANCELED', startedAt: ago(100), lastUpdatedAt: ago(1) };
  const run = (reported) =>
    deployment(OFFERED, {
      status: 'CANCELED',
      executions: [execution(WAITING, 'cancelled', { ...started, reported })],
    });
  const restarting = device(WAITING, {
    ota: { state: 'rebooting', job: OFFERED, progress: 0, last: 'none', error: '' },
  });
  const tab = await openTab(t, {
    hash: `#/deployments/${OFFERED}`,
    world: { ...WORLD, devices: [restarting], deployments: [run('1.2.3+4')] },
  });
  await tab.wait(0);
  assert.match(textOf(one(tab.main, 'p.execution-title')), /^Finishing despite the cancellation/);
  assert.match(textOf(one(tab.main, 'span.freshness-live')), /every 3 s/);
  assert.equal(
    all(tab.main, 'button').some((item) => textOf(item) === 'Offer again'),
    false
  );

  tab.becomes({
    ...WORLD,
    devices: [
      device(WAITING, {
        fw: { version: '1.2.3+5', confirmed: true },
        ota: { state: 'idle', job: null, progress: 0, last: 'succeeded', error: '' },
      }),
    ],
    deployments: [run('1.2.3+5')],
  });
  await tab.wait(3000);
  await tab.wait(0);
  assert.match(textOf(one(tab.main, 'p.execution-title')), /^Installed despite the cancellation/);
  assert.equal(all(tab.main, 'span.freshness-live').length, 0, 'and then it stops');
  const mark = tab.requests.length;
  await tab.wait(60000);
  assert.deepEqual(tab.since(mark), []);
});

test("a board's list of updates is not read again while the copy in hand is of what it reports now", async (t) => {
  const board = device(WAITING, {
    fw: { version: '1.2.3+5', confirmed: true },
    ota: { state: 'testing', job: OFFERED, progress: 0, last: 'none', error: '' },
  });
  const run = deployment(OFFERED, {
    status: 'CANCELED',
    executions: [
      execution(WAITING, 'cancelled', {
        status: 'CANCELED',
        startedAt: ago(100),
        lastUpdatedAt: ago(1),
        reported: '1.2.3+5',
      }),
    ],
  });
  const tab = await openTab(t, {
    hash: `#/deployments/${OFFERED}`,
    world: { ...WORLD, devices: [board], deployments: [run] },
  });
  await tab.wait(0);
  assert.match(textOf(one(tab.main, 'span.freshness-live')), /every 3 s/);
  const mark = tab.requests.length;
  await tab.wait(3000);
  await tab.wait(3000);
  const asked = tab.since(mark);
  assert.equal(asked.includes(`GET /api/deployments/${OFFERED}`), true, 'the page is being followed');
  assert.equal(asked.includes(`GET /api/devices/${WAITING}`), false);
});

test('a release revoked elsewhere stops being offered again on a page that is already open', async (t) => {
  const declined = deployment(OFFERED, {
    status: 'COMPLETED',
    completedAt: ago(10),
    executions: [execution(WAITING, 'declined', { status: 'REJECTED', reason: 'declined' })],
  });
  const world = { ...WORLD, deployments: [declined] };
  const tab = await openTab(t, { hash: `#/deployments/${OFFERED}`, world });
  assert.equal(
    all(tab.main, 'button').some((item) => textOf(item) === 'Offer again'),
    true
  );

  tab.becomes({
    ...world,
    releases: WORLD.releases.map((item) =>
      item.version === '1.2.3+5'
        ? release('1.2.3+5', { status: 'revoked', revoked: revoked({ enforcedAt: ago(1) }) })
        : item
    ),
  });
  await tab.wait(30000);
  assert.equal(
    all(tab.main, 'button').some((item) => textOf(item) === 'Offer again'),
    false
  );
  assert.match(textOf(tab.main), /was revoked/);
  // There is no more to wait for.
  const mark = tab.requests.length;
  await tab.wait(60000);
  assert.deepEqual(tab.since(mark), []);
});

test("a copy of a board's history from before it ran the version is read again, and a failed read is said and retried", async (t) => {
  const board = (version) => device(WAITING, { fw: { version, confirmed: true } });
  const cancelled = deployment(OFFERED, {
    status: 'CANCELED',
    executions: [execution(WAITING, 'cancelled', { status: 'CANCELED', startedAt: ago(100), reported: '1.2.3+4' })],
  });
  let down = false;
  const tab = await openTab(t, {
    hash: `#/devices/${WAITING}`,
    world: { ...WORLD, devices: [board('1.2.3+4')], deployments: [cancelled] },
    answer: (method, url) => (down && url === `/api/devices/${WAITING}` ? gateway(500, 'Internal Server Error') : null),
  });
  // The board moves on while this copy stays in memory. A later deployment did it.
  const later = deployment('cranium-1-2-3-b5-20261010T115800Z-0d0d', {
    status: 'COMPLETED',
    executions: [execution(WAITING, 'succeeded', { status: 'SUCCEEDED', startedAt: ago(50), ranAtEnd: '1.2.3+5' })],
  });
  const run = deployment(OFFERED, {
    status: 'CANCELED',
    executions: [execution(WAITING, 'cancelled', { status: 'CANCELED', startedAt: ago(100), reported: '1.2.3+5' })],
  });
  tab.becomes({ ...WORLD, devices: [board('1.2.3+5')], deployments: [run, later] });
  down = true;
  await tab.goto(`#/deployments/${OFFERED}`);
  await tab.wait(2000);
  await tab.wait(2000);
  // The read fails, and the copy is not taken for an answer.
  const words = () => textOf(tab.main);
  assert.doesNotMatch(words(), /Installed despite/);
  assert.match(words(), /Could not refresh the board’s list of updates/);
  assert.equal(
    all(tab.main, 'button').some((item) => textOf(item) === 'Offer again'),
    false
  );

  down = false;
  await tab.press(tab.main, 'button', 'Try again');
  assert.doesNotMatch(words(), /Installed despite|Could not refresh the board/);
  assert.match(words(), /Another deployment installed 1\.2\.3\+5\./);
});

test('while a board restarts after a forced cancel the overview follows it and does not say that nothing is going on', async (t) => {
  const run = deployment(OFFERED, {
    status: 'CANCELED',
    executions: [execution(WAITING, 'cancelled', { status: 'CANCELED', startedAt: ago(100), lastUpdatedAt: ago(1) })],
  });
  const restarting = device(WAITING, {
    ota: { state: 'rebooting', job: OFFERED, progress: 0, last: 'none', error: '' },
  });
  const tab = await openTab(t, { world: { ...WORLD, devices: [restarting], deployments: [run] } });
  assert.doesNotMatch(textOf(tab.main), /No update is in progress/);
  assert.match(textOf(one(tab.main, 'li.run')), /Finishing despite the cancellation/);
  assert.match(textOf(one(tab.main, 'span.freshness-live')), /every 3 s/);

  const done = device(WAITING, { fw: { version: '1.2.3+5', confirmed: true } });
  tab.becomes({ ...WORLD, devices: [done], deployments: [run] });
  await tab.wait(3000);
  assert.equal(all(tab.main, 'li.run').length, 0);
  assert.match(textOf(tab.main), /No update is in progress/);
});

test('a page that could not be loaded says so, and is asked for again more slowly', async (t) => {
  let down = true;
  const tab = await openTab(t, {
    answer: (method, url) => (down && url === '/api/devices' ? gateway(503, 'Service Unavailable') : null),
  });
  // Three tries, with pauses between them that are on the tab's clock.
  await tab.wait(2000);
  await tab.wait(2000);
  const notice = one(tab.main, 'div.notice.is-bad');
  assert.match(textOf(notice), /^Could not load the boards\. Service Unavailable \(HTTP 503\)\./);
  assert.equal(sentTo(tab, '/api/devices').length, 3);

  // The page would be read every 3 s; after a failure not before 15 s.
  const mark = tab.requests.length;
  await tab.wait(10000);
  assert.equal(tab.since(mark).includes('GET /api/devices'), false);
  down = false;
  await tab.wait(5000);
  assert.equal(tab.since(mark).includes('GET /api/devices'), true);
  assert.equal(all(tab.main, 'div.notice.is-bad').length, 0);
  assert.equal(all(tab.main, 'li.board-line').length, 3);
});

// The session, and the console's own sign-in page.

const leaving = (tab) => until(() => tab.navigations.length > 0, 'the way to the AWS sign-in page');
const authorizeUrl = (tab) => new URL(tab.navigations.at(-1));
const pendingRoute = (tab) => JSON.parse(tab.storage.get('cranium.signin')).route;
const signInPage = (tab) => all(tab.main, 'form.signin-form')[0] ?? null;
const asked = (tab) => until(() => signInPage(tab) !== null, 'the sign-in page');
const focused = (tab) => tab.document.activeElement?.id ?? null;
const box = (tab, n) => tab.document.getElementById(`code-digit-${n}`);
const digits = (tab) =>
  all(tab.main, 'input.code-digit')
    .map((el) => el.value)
    .join('');
const codeCalls = (tab) => tab.cognito.calls.filter((call) => call.body.ChallengeName === 'SOFTWARE_TOKEN_MFA');

/** Type into the box that has the keyboard, as a keyboard does. */
async function key(tab, text) {
  const el = tab.document.activeElement;
  el.value = `${el.value}${text}`;
  el.dispatchEvent({ type: 'input', target: el, data: text });
  await settle();
}

/** Press a key that is not typed, such as Backspace, in the box that has the keyboard. */
async function hit(tab, name) {
  const event = tab.document.activeElement.dispatchEvent({ type: 'keydown', key: name });
  await settle();
  return event;
}

/** Paste into a box; what the boxes hold straight after, before anything was answered. */
async function paste(tab, el, text) {
  const event = el.dispatchEvent({
    type: 'paste',
    clipboardData: { getData: (type) => (type === 'text' ? text : '') },
  });
  const held = digits(tab);
  await settle();
  return { event, held };
}

/** The address and the password, sent as Enter or the button sends them. */
async function givePassword(tab, email = PERSON.email, password = PERSON.password) {
  await tab.type(tab.document.getElementById('signin-email'), email);
  tab.document.getElementById('signin-password').value = password;
  one(tab.main, 'form.signin-form').dispatchEvent({ type: 'submit' });
  await settle();
}

const atCode = (tab) =>
  until(
    () => box(tab, 1) !== null && !one(tab.main, 'form.signin-form').hasAttribute('aria-busy'),
    'the boxes for the code'
  );
const settled = (tab) => until(() => !signInPage(tab)?.hasAttribute('aria-busy'), 'an answer from Cognito');

/** From the password to the console, on the console's own page. */
async function signInHere(tab) {
  await givePassword(tab);
  await atCode(tab);
  for (const digit of PERSON.code) await key(tab, digit);
  await until(() => !tab.document.body.contains(box(tab, 1) ?? tab.main) || signInPage(tab) === null, 'the console');
  await until(() => tab.nav.hidden === false, 'the console');
}

/** Whatever a script wrote to the browser's console, as one text. */
function consoleSpy(t) {
  const written = [];
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, name, (...items) =>
      written.push(items.map((item) => String(item?.stack ?? item)).join(' '))
    );
  }
  return written;
}

test('without a session the console asks on its own page, and opens at the address after the code', async (t) => {
  const written = consoleSpy(t);
  const tab = await openTab(t, { session: null, hash: '#/devices' });
  await asked(tab);
  assert.equal(textOf(one(tab.main, 'h1')), 'Sign in');
  assert.equal(tab.nav.hidden, true);
  assert.deepEqual(controls(tab.main), ['Continue', 'Forgot your password?', 'Use the AWS sign-in page']);
  assert.equal(focused(tab), 'signin-email');
  // Nothing was asked of anybody, and the browser went nowhere.
  assert.deepEqual(tab.requests, []);
  assert.deepEqual(tab.navigations, []);

  await givePassword(tab);
  await atCode(tab);
  assert.equal(textOf(one(tab.main, 'h1')), 'Enter the code');
  assert.match(textOf(tab.main), new RegExp(`Signing in as ${PERSON.email.replace('.', '\\.')}\\.`));
  // The password field is gone with its step, and it was emptied before that.
  assert.equal(
    all(tab.main, 'input').some((el) => el.getAttribute('type') === 'password'),
    false
  );
  assert.equal(focused(tab), 'code-digit-1');

  // Each digit moves the keyboard on; the sixth sends the code by itself.
  for (const [index, digit] of [...PERSON.code].entries()) {
    await key(tab, digit);
    if (index < 5) assert.equal(focused(tab), `code-digit-${index + 2}`, `after digit ${index + 1}`);
  }
  await until(() => tab.document.title.startsWith('Devices'), 'the devices page');
  assert.equal(tab.location.hash, '#/devices');
  assert.equal(codeCalls(tab).length, 1);

  // The session is what the AWS sign-in page would have left, and its refresh token is revoked.
  assert.deepEqual([...tab.storage.keys()], ['cranium.session']);
  assert.equal(sentTo(tab, '/api/me')[0].token, 'Bearer SRP-ACCESS-1');
  const revoke = sentTo(tab, `${LOGIN}/oauth2/revoke`);
  assert.equal(revoke.length, 1);
  assert.equal(new URLSearchParams(revoke[0].body).get('token'), 'SRP-REFRESH-1');
  assert.deepEqual(tab.navigations, []);

  // The password is nowhere: not sent, not stored, not in the page, not written to the console.
  const everything = [
    ...tab.requests.map((request) => `${request.url} ${JSON.stringify(request.body)}`),
    ...tab.headersSent.map((headers) => JSON.stringify(headers)),
    ...tab.storage.values(),
    ...descendants(tab.document.body).map((el) => `${el.value} ${[...el.attributes.values()].join(' ')}`),
    textOf(tab.document.body),
    ...written,
  ].join('\n');
  assert.equal(everything.includes(PERSON.password), false);
  assert.equal(JSON.stringify(tab.cognito.calls).includes(PERSON.password), false);
});

test('a wrong password, and an address nobody has, get the same words; the field is emptied', async (t) => {
  const tab = await openTab(t, { session: null, hash: '#/firmware' });
  await asked(tab);
  const said = [];
  for (const [email, password] of [
    [PERSON.email, 'Not-It-At-All-1'],
    ['nobody@example.invalid', PERSON.password],
  ]) {
    await givePassword(tab, email, password);
    await settled(tab);
    said.push(textOf(one(tab.main, 'p.signin-problem')));
    assert.equal(one(tab.main, 'p.signin-problem').getAttribute('role'), 'alert');
    assert.equal(tab.document.getElementById('signin-password').value, '');
    assert.equal(focused(tab), 'signin-password');
    assert.equal(tab.document.getElementById('signin-email').value, email, 'the address is kept');
  }
  assert.deepEqual(said, ['The e-mail address or password is wrong.', 'The e-mail address or password is wrong.']);
  // Each attempt is a new message, so that a screen reader says the second one too.
  assert.deepEqual(tab.storage.size, 0);

  // Nothing typed at all is said before anything is sent.
  const calls = tab.cognito.calls.length;
  await givePassword(tab, '', '');
  assert.equal(textOf(one(tab.main, 'p.signin-problem')), 'Enter your e-mail address and your password.');
  assert.equal(tab.cognito.calls.length, calls);
  assert.equal(focused(tab), 'signin-email');
});

test('a wrong code clears the boxes, puts the keyboard in the first, says so; the right one then signs in', async (t) => {
  const tab = await openTab(t, { session: null, hash: '#/overview' });
  await asked(tab);
  await givePassword(tab);
  await atCode(tab);
  for (const digit of '000000') await key(tab, digit);
  await settled(tab);
  assert.equal(codeCalls(tab).length, 1, 'sent once');
  assert.equal(digits(tab), '');
  assert.equal(focused(tab), 'code-digit-1');
  const problem = one(tab.main, 'p.signin-problem');
  assert.equal(textOf(problem), 'That code is not right. Try the next one from your authenticator app.');
  assert.equal(problem.getAttribute('role'), 'alert');
  assert.equal(one(tab.main, 'div.code-boxes').getAttribute('aria-describedby'), 'signin-problem code-hint');
  assert.equal(box(tab, 1).getAttribute('aria-invalid'), 'true');

  for (const digit of PERSON.code) await key(tab, digit);
  await until(() => tab.nav.hidden === false, 'the console');
  assert.equal(codeCalls(tab).length, 2);
  assert.deepEqual([...tab.storage.keys()], ['cranium.session']);
});

test('the boxes: Backspace goes back and clears, the arrows move, anything but a digit is ignored', async (t) => {
  const tab = await openTab(t, { session: null });
  await asked(tab);
  await givePassword(tab);
  await atCode(tab);

  await key(tab, '1');
  await key(tab, 'a');
  assert.equal(digits(tab), '1');
  assert.equal(focused(tab), 'code-digit-2', 'a letter does not move the keyboard on');
  assert.equal(box(tab, 2).value, '', 'and is not left in the box');
  await key(tab, '2');
  await key(tab, '3');
  assert.equal(focused(tab), 'code-digit-4');

  // In an empty box Backspace goes back one and clears that box.
  assert.equal((await hit(tab, 'Backspace')).defaultPrevented, true);
  assert.equal(focused(tab), 'code-digit-3');
  assert.equal(digits(tab), '12');
  // In a full box it clears it and stays.
  await hit(tab, 'ArrowLeft');
  assert.equal(focused(tab), 'code-digit-2');
  await hit(tab, 'Backspace');
  assert.deepEqual(
    all(tab.main, 'input.code-digit').map((el) => el.value),
    ['1', '', '', '', '', '']
  );
  assert.equal(focused(tab), 'code-digit-2');
  await hit(tab, 'ArrowRight');
  await hit(tab, 'ArrowRight');
  assert.equal(focused(tab), 'code-digit-4');
  await hit(tab, 'Home');
  assert.equal(focused(tab), 'code-digit-1');
  await hit(tab, 'End');
  assert.equal(focused(tab), 'code-digit-6');
  // Tab and the like are left to the browser.
  assert.equal((await hit(tab, 'Tab')).defaultPrevented, false);
  assert.equal(codeCalls(tab).length, 0, 'nothing was sent on the way');
});

test('a whole code pasted or filled in, with or without a space, fills every box and is sent once', async (t) => {
  for (const [text, where] of [
    [PERSON.code, 1],
    [`${PERSON.code.slice(0, 3)} ${PERSON.code.slice(3)}`, 4],
  ]) {
    const tab = await openTab(t, { session: null });
    await asked(tab);
    await givePassword(tab);
    await atCode(tab);
    const { event, held } = await paste(tab, box(tab, where), text);
    assert.equal(event.defaultPrevented, true, 'the browser does not paste it into one box as well');
    assert.equal(held, PERSON.code);
    await until(() => tab.nav.hidden === false, 'the console');
    assert.equal(codeCalls(tab).length, 1, JSON.stringify(text));
    t.mock.timers.reset();
  }

  // The browser filling the code into the first box (autocomplete="one-time-code").
  const tab = await openTab(t, { session: null });
  await asked(tab);
  await givePassword(tab);
  await atCode(tab);
  const first = box(tab, 1);
  first.value = PERSON.code;
  first.dispatchEvent({ type: 'input', target: first, data: null });
  await settle();
  // While it is on its way, what is typed changes nothing and sends nothing more.
  await key(tab, '9');
  await until(() => tab.nav.hidden === false, 'the console');
  assert.equal(codeCalls(tab).length, 1);
});

test('a code sent from the button needs all six digits; Start again goes back to the password', async (t) => {
  const tab = await openTab(t, { session: null });
  await asked(tab);
  await givePassword(tab);
  await atCode(tab);
  await key(tab, '1');
  await key(tab, '3');
  await tab.press(tab.main, 'button', 'Sign in');
  assert.equal(textOf(one(tab.main, 'p.signin-problem')), 'Type all six digits of the code.');
  assert.equal(focused(tab), 'code-digit-3');
  assert.equal(codeCalls(tab).length, 0);

  await tab.press(tab.main, 'button', 'Start again');
  assert.equal(textOf(one(tab.main, 'h1')), 'Sign in');
  assert.equal(tab.document.getElementById('signin-email').value, PERSON.email);
  assert.equal(focused(tab), 'signin-password');
});

test("limits, an ended sign-in and a lost connection are said in words, never in Cognito's", async (t) => {
  let rule = null;
  const tab = await openTab(t, { session: null, fail: (operation, body) => rule?.(operation, body) ?? null });
  await asked(tab);
  rule = (operation) => (operation === 'InitiateAuth' ? 'TooManyRequestsException' : null);
  await givePassword(tab);
  await settled(tab);
  assert.equal(textOf(one(tab.main, 'p.signin-problem')), 'Too many tries. Wait a minute.');

  rule = (operation, body) => (body.ChallengeName === 'SOFTWARE_TOKEN_MFA' ? 'NotAuthorizedException' : null);
  await givePassword(tab);
  await atCode(tab);
  for (const digit of PERSON.code) await key(tab, digit);
  await settled(tab);
  // Cognito ended its sign-in: back to the password.
  assert.equal(textOf(one(tab.main, 'h1')), 'Sign in');
  assert.equal(
    textOf(one(tab.main, 'p.signin-problem')),
    'The sign-in took too long, so it starts again. Enter your password once more.'
  );
  assert.equal(focused(tab), 'signin-password');
  assert.doesNotMatch(textOf(tab.main), /Exception|Incorrect|Invalid session/);
});

test('a step this page does not do goes to the AWS sign-in page by itself, to come back to the same page', async (t) => {
  for (const [next, words] of [
    ['NEW_PASSWORD_REQUIRED', /needs a new password first/],
    ['MFA_SETUP', /needs an authenticator app first/],
    ['SELECT_MFA_TYPE', /a step that only that page does/],
  ]) {
    const tab = await openTab(t, { session: null, hash: '#/deployments', users: [{ ...PERSON, next }] });
    await asked(tab);
    await givePassword(tab);
    await leaving(tab);
    assert.equal(authorizeUrl(tab).origin + authorizeUrl(tab).pathname, `${LOGIN}/oauth2/authorize`);
    assert.equal(authorizeUrl(tab).searchParams.get('prompt'), 'login');
    assert.equal(pendingRoute(tab), '#/deployments');
    assert.equal(textOf(one(tab.main, 'h1')), 'Taking you to the AWS sign-in page…');
    assert.match(textOf(tab.main), words);
    assert.equal(tab.storage.has('cranium.session'), false);
    t.mock.timers.reset();
  }
});

test('the AWS sign-in page is always one press away, and so is a forgotten password', async (t) => {
  for (const label of ['Use the AWS sign-in page', 'Forgot your password?']) {
    const tab = await openTab(t, { session: null, hash: '#/activity' });
    await asked(tab);
    await tab.press(tab.main, 'button', label);
    await leaving(tab);
    assert.equal(authorizeUrl(tab).searchParams.get('code_challenge_method'), 'S256');
    assert.equal(pendingRoute(tab), '#/activity');
    assert.deepEqual(tab.cognito.calls, [], label);
    t.mock.timers.reset();
  }
  // Also from the step of the code.
  const tab = await openTab(t, { session: null });
  await asked(tab);
  await givePassword(tab);
  await atCode(tab);
  await tab.press(tab.main, 'button', 'Use the AWS sign-in page');
  await leaving(tab);
  assert.equal(codeCalls(tab).length, 0);
});

test('a minute before the token ends the console asks for the password again, in place', async (t) => {
  const tab = await openTab(t, { session: 100, hash: `#/devices/${WAITING}` });
  await tab.wait(35000);
  assert.equal(signInPage(tab), null, 'with 65 s left');
  await tab.wait(5000);
  await asked(tab);
  assert.match(textOf(one(tab.main, 'p.gate-text')), /^Your session has ended\. Sign in again/);
  // It goes nowhere, and keeps the address.
  assert.deepEqual(tab.navigations, []);
  assert.equal(tab.location.hash, `#/devices/${WAITING}`);
  await tab.wait(30000);
  assert.deepEqual(tab.navigations, []);

  await signInHere(tab);
  assert.equal(tab.location.hash, `#/devices/${WAITING}`);
  assert.match(tab.document.title, /^cranium-0000/);
  assert.equal(sentTo(tab, '/api/me').at(-1).token, 'Bearer SRP-ACCESS-1');
  // The listeners of the console are set up once: one change of address, one load.
  const mark = sentTo(tab, '/api/devices').length;
  await tab.goto('#/devices');
  assert.equal(sentTo(tab, '/api/devices').length, mark + 1);
});

test('a hidden tab does not ask for the password; it does when it is looked at again', async (t) => {
  const tab = await openTab(t, { session: 100, hash: '#/firmware' });
  await tab.hide(true);
  await tab.wait(90000);
  await pause(20);
  assert.equal(signInPage(tab), null);
  await tab.hide(false);
  await asked(tab);
  assert.equal(tab.location.hash, '#/firmware');
});

test('an open dialog is not interrupted by the end of the session', async (t) => {
  const tab = await openTab(t, { session: 100, hash: '#/firmware' });
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Revoke');
  assert.equal(textOf(one(tab.dialog(), 'h2')), 'Revoke 1.2.4+0?');

  await tab.wait(60000);
  await pause(20);
  assert.equal(signInPage(tab), null, 'the dialog is left alone');
  assert.notEqual(tab.dialog(), null);

  // Closed, the console asks at once.
  await tab.press(tab.dialog(), 'button', 'Keep the release');
  assert.equal(tab.dialog(), null);
  await asked(tab);
});

/** An MCUboot image as far as the browser looks at one: a header with a version. */
function imageFile(version = [2, 0, 1, 0], name = 'zephyr.signed.bin') {
  const bytes = new Uint8Array(1264);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x96f3b83d, true);
  view.setUint16(8, 512, true);
  view.setUint32(12, 600, true);
  view.setUint8(20, version[0]);
  view.setUint8(21, version[1]);
  view.setUint16(22, version[2], true);
  view.setUint32(24, version[3], true);
  return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer };
}

async function chooseFile(tab, file = imageFile()) {
  const input = one(tab.main, 'input.drop-input');
  input.dispatchEvent({ type: 'change', target: { files: [file], value: file.name } });
  await until(() => all(tab.main, 'ul.checks').length > 0, 'the file to be read');
}

test('a request made after the session has ended says so, and keeps the dialog with what was typed', async (t) => {
  const tab = await openTab(t, { session: 100, hash: '#/firmware' });
  const dialog = await openRevoke(tab, '1.2.4+0');
  await tab.type(one(dialog, 'textarea'), REASON);
  await tab.wait(101000);
  const mark = tab.requests.filter((request) => request.method === 'POST').length;
  await tab.submit();

  assert.equal(tab.requests.filter((request) => request.method === 'POST').length, mark, 'nothing was sent');
  assert.equal(signInPage(tab), null, 'and the console has not asked');
  assert.equal(tab.dialog(), dialog);
  assert.equal(
    textOf(one(dialog, 'span.notice-said')),
    'Not revoked. Your session has ended. Sign in again to continue.'
  );
  assert.equal(one(dialog, 'textarea').value, REASON);
  assert.equal(textOf(one(tab.account, 'span.account-session')), 'Session ended');

  await tab.press(dialog, 'button', 'Sign in again');
  await asked(tab);
  assert.equal(tab.dialog(), null);
  assert.deepEqual(tab.navigations, []);
});

test('a refresh that finds the session over does not take away what is in hand', async (t) => {
  const tab = await openTab(t, { session: 100, hash: `#/deployments/${OFFERED}` });
  await tab.press(tab.main, 'button', 'Cancel deployment');
  await tab.wait(110000);
  assert.equal(signInPage(tab), null);
  assert.notEqual(tab.dialog(), null);
});

test('a chosen file is not thrown away by the end of the session, nor by signing in again', async (t) => {
  const tab = await openTab(t, { session: 100, hash: '#/firmware' });
  await chooseFile(tab);
  assert.equal(textOf(one(tab.main, 'p.upload-title')), 'zephyr.signed.bin');
  // With less than five minutes left the panel says what is about to happen.
  assert.match(textOf(one(tab.main, 'div.notice.is-warn')), /^Your session is about to end\. It ends in/);

  await tab.wait(60000);
  await pause(20);
  assert.equal(signInPage(tab), null, 'the file is still in hand');
  assert.equal(textOf(one(tab.main, 'p.upload-title')), 'zephyr.signed.bin');

  // The session is over by now; the panel says so and offers the way back in. Sending
  // the file is not on offer any more, and the masthead says the same.
  await tab.wait(45000);
  assert.match(textOf(one(tab.main, 'div.notice.is-warn')), /^Your session has ended\./);
  assert.equal(
    all(tab.main, 'button').some((item) => textOf(item) === 'Upload for verification'),
    false
  );
  assert.equal(textOf(one(tab.account, 'span.account-session')), 'Session ended');
  await tab.press(tab.main, 'button', 'Sign in again');
  await asked(tab);

  // Signed in again in place, the file is still there, and may be sent.
  await signInHere(tab);
  await until(() => all(tab.main, 'p.upload-title').length > 0, 'the firmware page');
  assert.equal(textOf(one(tab.main, 'p.upload-title')), 'zephyr.signed.bin');
  assert.equal(
    all(tab.main, 'button').some((item) => textOf(item) === 'Upload for verification'),
    true
  );
  assert.deepEqual(tab.navigations, []);
});

test('with the file put down again, the console asks as usual', async (t) => {
  const tab = await openTab(t, { session: 100, hash: '#/firmware' });
  await chooseFile(tab);
  await tab.wait(60000);
  assert.equal(signInPage(tab), null);
  await tab.press(tab.main, 'button', 'Choose another file');
  assert.equal(all(tab.main, 'label.drop').length, 1);
  await tab.wait(5000);
  await asked(tab);
});

/** A tab that comes back from the sign-in page with a code for the sign-in it started. */
function returning(t, route, answer = () => null) {
  const pending = { state: 'STATE-1', verifier: 'v'.repeat(43), route };
  return openTab(t, {
    session: null,
    hash: '',
    search: '?code=THE-CODE&state=STATE-1',
    stored: { 'cranium.signin': JSON.stringify(pending) },
    answer(method, url, body) {
      if (url === `${LOGIN}/oauth2/token`) return Response.json(TOKENS);
      if (url === `${LOGIN}/oauth2/revoke`) return new Response(null, { status: 200 });
      return answer(method, url, body);
    },
  });
}

test('back from the AWS sign-in page, the console redeems the code and returns to where it was', async (t) => {
  const tab = await returning(t, `#/deployments/${OFFERED}`);
  await until(() => tab.document.title.startsWith('Deployment'), 'the page');

  assert.equal(tab.requests[0].url, `${LOGIN}/oauth2/token`, 'before anything else is asked for');
  assert.equal(tab.location.search, '', 'the code is out of the address bar');
  assert.equal(tab.location.hash, `#/deployments/${OFFERED}`);
  assert.equal(textOf(one(tab.main, 'h1')), 'Deployment of 1.2.3+5 Waiting for boards');
  // Neither the code nor the refresh token is kept; the refresh token is revoked.
  assert.deepEqual([...tab.storage.keys()], ['cranium.session']);
  assert.equal(sentTo(tab, `${LOGIN}/oauth2/revoke`).length, 1);
  assert.equal(sentTo(tab, '/api/me')[0].token, 'Bearer FRESH-TOKEN');
  assert.deepEqual(tab.navigations, []);
});

test('a reply from the sign-in page that this tab did not ask for is dropped unredeemed', async (t) => {
  const tab = await openTab(t, { session: null, hash: '', search: '?code=STOLEN&state=someone-elses' });
  assert.equal(textOf(one(tab.main, 'h1')), 'That sign-in did not start here');
  assert.deepEqual(tab.requests, []);
  assert.equal(tab.location.search, '');
  assert.deepEqual(controls(tab.main), ['Sign in']);
  await tab.press(tab.main, 'button', 'Sign in');
  await asked(tab);
});

test('a token the API refuses counts as over, whatever time it had left', async (t) => {
  const refused = (method, url) => (url.startsWith('/api/firmware/') ? refusal(401, 'unauthorized', 'Nope.') : null);
  const tab = await openTab(t, { hash: '#/firmware', answer: refused });
  assert.equal(textOf(one(tab.account, 'span.account-session')), 'Session ends in 1 h');
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Revoke');
  await tab.type(one(tab.dialog(), 'textarea'), 'A reason.');
  await tab.submit();
  // The dialog stays, with what was typed, and says so; and so does the masthead.
  assert.match(textOf(tab.dialog()), /Your session has ended/);
  assert.equal(textOf(one(tab.account, 'span.account-session')), 'Session ended');
  assert.equal(tab.storage.has('cranium.session'), false, 'a token that is refused is not kept');
  // Once the work is put down, the console asks for the password as it does at the end of a session.
  assert.equal(signInPage(tab), null);
  await tab.press(tab.dialog(), 'button', 'Keep the release');
  await tab.wait(5000);
  await asked(tab);
  assert.deepEqual(tab.navigations, []);
});

test('a token the API refuses leads back to sign-in, on the page the user was on', async (t) => {
  const tab = await openTab(t, {
    hash: '#/devices',
    answer: (method, url) => (url === '/api/devices' ? gateway(401, 'Unauthorized') : null),
  });
  await asked(tab);
  assert.equal(tab.location.hash, '#/devices');
  assert.equal(sentTo(tab, '/api/devices').length, 1, 'a refused token is not tried again');
});

test('a token refused straight after signing in does not send the user round in circles', async (t) => {
  const tab = await returning(t, '#/overview', (method, url) =>
    url === '/api/me' ? gateway(401, 'Unauthorized') : null
  );
  await until(() => all(tab.main, 'h1').length > 0, 'a message');
  assert.equal(textOf(one(tab.main, 'h1')), 'The server did not accept this sign-in');
  assert.deepEqual(tab.navigations, []);
  assert.deepEqual(controls(tab.main), ['Sign out']);

  // The same on the console's own page, and for a token without the console's scope,
  // which the gateway turns away with a 403 of its own.
  t.mock.timers.reset();
  for (const status of [401, 403]) {
    const here = await openTab(t, {
      session: null,
      answer: (method, url) =>
        url === '/api/me' ? gateway(status, status === 401 ? 'Unauthorized' : 'Forbidden') : null,
    });
    await asked(here);
    await givePassword(here);
    await atCode(here);
    for (const digit of PERSON.code) await key(here, digit);
    await until(
      () =>
        signInPage(here) === null &&
        all(here.main, 'h1').length > 0 &&
        textOf(one(here.main, 'h1')) !== 'Loading the console…',
      'a message'
    );
    assert.equal(textOf(one(here.main, 'h1')), 'The server did not accept this sign-in', String(status));
    assert.deepEqual(controls(here.main), ['Sign out']);
    t.mock.timers.reset();
  }
});

// Revoking.

/** The world once revoking `version` has been carried out as far as `mark` says. */
function afterRevoking(version, mark) {
  const releases = WORLD.releases.map((item) =>
    item.version === version ? { ...item, status: 'revoked', revoked: mark } : item
  );
  return { ...WORLD, releases };
}

async function openRevoke(tab, version, button = 'Revoke') {
  await tab.press(releaseRow(tab, version), 'button', button);
  return tab.dialog();
}

test('revoking sends the reason, says what it cancelled and shows the release as revoked', async (t) => {
  const done = revoked({ enforcedAt: ago(0) });
  const tab = await openTab(t, {
    hash: '#/firmware',
    answer(method) {
      if (method !== 'POST') return null;
      tab.becomes(afterRevoking('1.2.4+0', done));
      const marked = { ...release('1.2.4+0'), status: 'revoked', revoked: done };
      return Response.json({ release: marked, cancelled: [WITHDRAWN] });
    },
  });
  const dialog = await openRevoke(tab, '1.2.4+0');
  assert.equal(tab.document.activeElement.localName, 'textarea', 'typing starts in the reason');
  await tab.type(one(dialog, 'textarea'), `  ${REASON}\n`);
  const mark = tab.requests.length;
  await tab.submit();

  assert.deepEqual(tab.requests[mark], {
    method: 'POST',
    url: '/api/firmware/1.2.4+0/revoke',
    body: { reason: REASON },
    token: 'Bearer TOKEN',
  });
  assert.equal(tab.dialog(), null);
  assert.deepEqual(tab.toasts(), ['Revoked 1.2.4+0. 1 unfinished deployment was cancelled.']);
  assert.equal(tab.since(mark).includes('GET /api/firmware'), true);
  assert.equal(tab.since(mark).includes('GET /api/devices'), true, 'to name the boards that run it');
  assert.deepEqual(badges(releaseRow(tab, '1.2.4+0')), ['Revoked']);
  assert.deepEqual(writes(releaseRow(tab, '1.2.4+0')), []);
});

test('a revocation is confirmed at once; which boards still run the release follows', async (t) => {
  const runsIt = device(WAITING, { fw: { version: '1.2.4+0', confirmed: true } });
  let answerBoards = null;
  let holding = false;
  const world = { ...WORLD, devices: [runsIt], deployments: [] };
  const replies = repliesFor(world);
  const tab = await openTab(t, {
    world,
    hash: '#/firmware',
    answer(method, url) {
      if (method === 'POST' && url === '/api/firmware/1.2.4+0/revoke') {
        return Response.json({
          release: release('1.2.4+0', { status: 'revoked', revoked: revoked({ enforcedAt: ago(0) }) }),
          cancelled: [],
        });
      }
      if (url === '/api/devices' && holding) {
        return new Promise((resolve) => {
          answerBoards = () => resolve(Response.json(replies.get(url)));
        });
      }
      return null;
    },
  });
  holding = true;
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Revoke');
  await tab.type(one(tab.dialog(), 'textarea'), 'A reason.');
  await tab.submit();
  assert.equal(tab.dialog(), null);
  assert.deepEqual(tab.toasts(), ['Revoked 1.2.4+0. No deployment of it was still open.']);
  answerBoards();
  await settle();
  assert.deepEqual(tab.toasts(), [
    'Revoked 1.2.4+0. No deployment of it was still open.',
    `${WAITING} still runs it; to replace it there, upload a newer version and deploy that.`,
  ]);
});

const REVOKED_AWAY = { online: false, lastSeen: ago(3600) };
const onRevoked = (thing, changes) => device(thing, { fw: { version: '1.2.4+0', confirmed: true }, ...changes });
for (const [who, devices, said] of [
  [
    'one board offline',
    [onRevoked(WAITING, REVOKED_AWAY)],
    `${WAITING} last reported running it; to replace it there, upload a newer version and deploy that.`,
  ],
  [
    'one board online and one offline',
    [onRevoked(WAITING), onRevoked(INSTALLING, REVOKED_AWAY)],
    '1 board still runs it and 1 board last reported running it; to replace it there, upload a newer version and deploy that.',
  ],
  [
    'an offline board on something else',
    [device(WAITING, REVOKED_AWAY)],
    'Revoked 1.2.4+0. No deployment of it was still open.',
  ],
]) {
  test(`after a revocation, an offline board is told by what it last reported: ${who}`, async (t) => {
    const tab = await openTab(t, {
      world: { ...WORLD, devices, deployments: [] },
      hash: '#/firmware',
      answer(method, url) {
        if (method === 'POST' && url === '/api/firmware/1.2.4+0/revoke') {
          return Response.json({
            release: release('1.2.4+0', { status: 'revoked', revoked: revoked({ enforcedAt: ago(0) }) }),
            cancelled: [],
          });
        }
        return null;
      },
    });
    await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Revoke');
    await tab.type(one(tab.dialog(), 'textarea'), 'A reason.');
    await tab.submit();
    await settle();
    assert.equal(tab.toasts().at(-1), said);
  });
}

test('a release that somebody else revoked first is not reported as "not revoked"', async (t) => {
  const already = () => refusal(409, 'already_revoked', 'Release 1.2.4+0 is already revoked.');
  const tab = await openTab(t, {
    hash: '#/firmware',
    answer: (method) => (method === 'POST' ? already() : null),
  });
  const dialog = await openRevoke(tab, '1.2.4+0');
  await tab.type(one(dialog, 'textarea'), 'Second thoughts.');
  await tab.submit();
  assert.equal(tab.dialog(), null, 'the release is revoked: there is nothing left to ask');
  assert.deepEqual(tab.toasts(), ['1.2.4+0 was revoked already, and that revocation is in place.']);
  assert.equal(all(tab.document.body, 'div.notice.is-bad').length, 0);
});

test('a revocation that stopped half way is finished from the release, reason and all', async (t) => {
  const done = revoked({ enforcedAt: ago(0) });
  const tab = await openTab(t, {
    hash: '#/firmware',
    answer(method) {
      if (method !== 'POST') return null;
      tab.becomes(afterRevoking('2.0.0+0', done));
      return Response.json({ release: { ...WORLD.releases[0], revoked: done }, cancelled: [] });
    },
  });
  assert.deepEqual(badges(releaseRow(tab, '2.0.0+0')), ['Revoked', 'Revocation incomplete']);

  const dialog = await openRevoke(tab, '2.0.0+0', 'Finish revoking');
  assert.equal(textOf(one(dialog, 'h2')), 'Finish revoking 2.0.0+0?');
  assert.equal(all(dialog, 'textarea').length, 0);
  const mark = tab.requests.length;
  await tab.submit();

  assert.equal(tab.requests[mark].url, '/api/firmware/2.0.0+0/revoke');
  assert.deepEqual(tab.requests[mark].body, { reason: REASON });
  assert.equal(tab.dialog(), null);
  assert.deepEqual(tab.toasts(), ['The revocation of 2.0.0+0 is in place. No deployment of it was still open.']);
  assert.deepEqual(badges(releaseRow(tab, '2.0.0+0')), ['Revoked']);
  assert.deepEqual(writes(releaseRow(tab, '2.0.0+0')), []);
});

test('a revocation that fails half way leaves a dialog that offers to finish it', async (t) => {
  const reason = 'A fault in the field.';
  const posted = [];
  const tab = await openTab(t, {
    hash: '#/firmware',
    answer(method, url, body) {
      if (method !== 'POST') return null;
      posted.push(body);
      if (posted.length > 1) return refusal(409, 'already_revoked', 'Release 1.2.4+0 is already revoked.');
      // The mark is written; the step after it failed.
      tab.becomes(afterRevoking('1.2.4+0', { ...revoked({ enforcedAt: null }), reason }));
      return refusal(
        500,
        'revoke_incomplete',
        'Release 1.2.4+0 is marked revoked, but its image could not be blocked. Revoke it again to finish.'
      );
    },
  });
  const dialog = await openRevoke(tab, '1.2.4+0');
  await tab.type(one(dialog, 'textarea'), reason);
  await tab.submit();

  // Not closed: nothing is certain. The page behind it was read again and shows the mark.
  assert.notEqual(tab.dialog(), null);
  const said = textOf(one(tab.dialog(), 'span.notice-said'));
  assert.match(said, /^It is not certain whether this went through\. Release 1\.2\.4\+0 is marked revoked/);
  assert.match(said, /its image could not be blocked\. Revoke it again to finish\.$/);
  assert.deepEqual(badges(releaseRow(tab, '1.2.4+0')), ['Revoked', 'Revocation incomplete']);
  // The dialog now speaks of what is true: a revocation to finish, not one to begin.
  assert.equal(textOf(one(tab.dialog(), 'h2')), 'Finish revoking 1.2.4+0?');
  assert.equal(all(tab.dialog(), 'textarea').length, 0);

  await tab.submit();
  assert.deepEqual(posted, [{ reason }, { reason }], 'the second request carries the reason on record');
  assert.equal(tab.dialog(), null);
  assert.deepEqual(tab.toasts(), [
    'The revocation of 1.2.4+0 is in place: its image is refused and no deployment of it is open.',
  ]);
});

test('on a touch screen the revoke dialog does not open with the keyboard over what it says', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware', touch: true });
  await openRevoke(tab, '1.2.4+0');
  assert.equal(textOf(tab.document.activeElement), 'Keep the release');
});

// Deploying.

test('a new deployment: the only free board is ticked, and a refusal updates the dialog', async (t) => {
  const rival = 'cranium-1-2-4-b0-20261010T120000Z-0d0d';
  const offline = execution(NEVER, 'waiting_for_device', { online: false });
  const tab = await openTab(t, {
    hash: '#/deployments',
    answer(method) {
      if (method !== 'POST') return null;
      // Somebody else was faster: the board has an update now.
      const taken = deployment(rival, { executions: [offline] });
      tab.becomes({ ...WORLD, deployments: [taken, ...WORLD.deployments] });
      return refusal(
        409,
        'device_busy',
        `${NEVER} still has an update that is not finished. Wait for it or cancel it first.`,
        [{ thing: NEVER, deployment: rival }]
      );
    },
  });
  await tab.press(tab.main, 'button', 'New deployment');
  const dialog = tab.dialog();
  // Only releases that can be deployed are offered, the newest first and chosen.
  assert.deepEqual(
    all(dialog, 'label.choice').map((choice) => textOf(one(choice, 'span.choice-title'))),
    ['1.2.4+0', '1.2.3+5', '1.2.3+4']
  );
  assert.equal(all(dialog, 'input')[0].checked, true);
  await tab.press(dialog, 'button', 'Next');

  // Two boards have an unfinished update. The third is the only choice, and is made.
  const boards = () =>
    all(tab.dialog(), 'label.choice').map((choice) => {
      const box = one(choice, 'input');
      return [textOf(one(one(choice, 'span.choice-title'), 'span.mono')), box.checked, box.disabled];
    });
  assert.deepEqual(boards(), [
    [WAITING, false, true],
    [INSTALLING, false, true],
    [NEVER, true, false],
  ]);
  assert.equal(all(dialog, 'span.dialog-hint').length, 0);
  await tab.press(dialog, 'button', 'Next');
  assert.equal(textOf(one(dialog, 'button.is-primary')), 'Deploy to 1 board');

  const mark = tab.requests.length;
  await tab.press(dialog, 'button', 'Deploy to 1 board');
  assert.deepEqual(tab.requests[mark].body, { version: '1.2.4+0', things: [NEVER] });

  // Back at the boards, read again: the board cannot be chosen once more.
  assert.deepEqual(boards(), [
    [WAITING, false, true],
    [INSTALLING, false, true],
    [NEVER, false, true],
  ]);
  assert.equal(textOf(one(dialog, 'span.dialog-hint')), 'Every board has an unfinished update.');
  assert.equal(one(dialog, 'button', 'Next').disabled, true);
  const notice = one(dialog, 'div.notice.is-bad');
  assert.match(textOf(notice), /^The deployment was not started\. cranium-00000000000000cc still has/);
  assert.equal(one(notice, 'a').getAttribute('href'), `#/deployments/${rival}`);
  // And the page behind the dialog shows the deployment that got there first.
  assert.equal(tab.since(mark).includes('GET /api/deployments'), true);
  assert.equal(all(tab.main, 'li.deployment-row').length, 4);
});

test('pressing Deploy on a release that was revoked since says so, and suggests no other', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware' });
  // Somebody else revokes it after this page has read the list.
  const mark = revoked({ enforcedAt: ago(0) });
  tab.becomes({
    ...WORLD,
    releases: WORLD.releases.map((item) =>
      item.version === '1.2.4+0' ? { ...item, status: 'revoked', revoked: mark } : item
    ),
  });
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Deploy');
  const dialog = tab.dialog();
  assert.match(textOf(one(dialog, 'div.notice.is-warn')), /^1\.2\.4\+0 has been revoked/);
  assert.equal(
    all(dialog, 'input').every((input) => !input.checked),
    true
  );
  assert.equal(one(dialog, 'button', 'Next').disabled, true);
  // The page behind the dialog has learned it too.
  assert.deepEqual(badges(releaseRow(tab, '1.2.4+0')), ['Revoked']);

  // Choosing another takes the note away.
  click(all(dialog, 'input')[0]);
  await settle();
  assert.equal(all(tab.dialog(), 'div.notice.is-warn').length, 0);
  assert.equal(one(tab.dialog(), 'button', 'Next').disabled, false);
});

test('a deployment that starts takes the console to its page', async (t) => {
  const created = 'cranium-1-2-4-b0-20261010T120000Z-0e0e';
  const offline = execution(NEVER, 'waiting_for_device', { online: false });
  const started = deployment(created, { executions: [offline] });
  const tab = await openTab(t, {
    hash: '#/firmware',
    answer(method) {
      if (method !== 'POST') return null;
      tab.replies.set(`/api/deployments/${created}`, { deployment: started });
      return Response.json({ deployment: started }, { status: 201 });
    },
  });
  // From a release: the dialog starts at the boards.
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Deploy');
  assert.equal(textOf(one(tab.dialog(), 'legend')), 'Which boards get 1.2.4+0?');
  await tab.press(tab.dialog(), 'button', 'Next');
  await tab.press(tab.dialog(), 'button', 'Deploy to 1 board');

  assert.equal(tab.dialog(), null);
  assert.equal(tab.location.hash, `#/deployments/${created}`);
  assert.equal(textOf(one(tab.main, 'h1')), 'Deployment of 1.2.4+0 Waiting for boards');
  assert.deepEqual(tab.toasts(), ['Deployment of 1.2.4+0 started.']);
});

// Cancelling.

test('cancelling a deployment that somebody else has cancelled: the dialog comes up to date', async (t) => {
  const cancelled = execution(WAITING, 'cancelled', { status: 'CANCELED' });
  const tab = await openTab(t, {
    hash: `#/deployments/${OFFERED}`,
    answer(method) {
      if (method !== 'POST') return null;
      const over = deployment(OFFERED, { status: 'CANCELED', executions: [cancelled] });
      tab.replies.set(`/api/deployments/${OFFERED}`, { deployment: over });
      return refusal(409, 'already_finished', 'This deployment has already finished; there is nothing left to cancel.');
    },
  });
  await tab.press(tab.main, 'button', 'Cancel deployment');
  assert.match(textOf(tab.dialog()), /Right now 1 board is waiting and 0 boards have started\./);
  // The dialog opens on the safe choice.
  assert.equal(textOf(tab.document.activeElement), 'Keep the deployment');
  const mark = tab.requests.length;
  await tab.submit();

  assert.deepEqual(tab.requests[mark].body, { force: false });
  // A conflict: the page is read again, and the dialog counts from the new record.
  assert.equal(tab.since(mark).includes(`GET /api/deployments/${OFFERED}`), true);
  const dialog = tab.dialog();
  assert.match(textOf(dialog), /Nothing is left to cancel\./);
  assert.doesNotMatch(textOf(dialog), /Right now/);
  assert.equal(one(dialog, 'button.is-danger').disabled, true);
  // What was refused has nothing to add to that, and cannot contradict it.
  assert.equal(all(dialog, 'span.notice-said').length, 0);
  // Nothing more can be sent from here.
  const before = tab.requests.length;
  await tab.submit();
  assert.equal(tab.requests.length, before);
});

test('a deployment that was cancelled without force can still have its boards stopped', async (t) => {
  const stopped = deployment(WITHDRAWN, {
    status: 'CANCELED',
    createdAt: ago(1200),
    executions: [execution(INSTALLING, 'cancelled', { status: 'CANCELED', startedAt: ago(100) })],
  });
  const tab = await openTab(t, {
    hash: `#/deployments/${WITHDRAWN}`,
    answer(method) {
      if (method !== 'POST') return null;
      tab.replies.set(`/api/deployments/${WITHDRAWN}`, { deployment: stopped });
      return Response.json({ deployment: stopped });
    },
  });
  // The page is still live: the job is cancelled, the board is not.
  assert.match(textOf(one(tab.main, 'span.freshness-live')), /every 3 s/);
  await tab.press(tab.main, 'button', 'Stop boards that have started');
  // Withdrawing the offer is done already; stopping the board is what is left, and chosen.
  assert.deepEqual(
    all(tab.dialog(), 'input').map((input) => [input.checked, input.disabled]),
    [
      [false, true],
      [true, false],
    ]
  );
  const mark = tab.requests.length;
  await tab.submit();

  assert.deepEqual(tab.requests[mark].body, { force: true });
  assert.equal(tab.dialog(), null);
  assert.deepEqual(tab.toasts(), ['Stop requested. Boards that had started have been asked to stop.']);
  assert.deepEqual(writes(tab.main), []);
  assert.equal(all(tab.main, 'span.freshness-live').length, 0, 'nothing is left to wait for');
});

// Uploading.

test('a board that runs what was cancelled: its own list of updates says who installed it', async (t) => {
  const later = 'cranium-1-2-3-b5-20261010T115800Z-0d0d';
  const cancelled = deployment(OFFERED, {
    status: 'CANCELED',
    executions: [execution(WAITING, 'cancelled', { status: 'CANCELED', startedAt: ago(300), reported: '1.2.3+5' })],
  });
  const installer = deployment(later, {
    status: 'COMPLETED',
    executions: [execution(WAITING, 'succeeded', { status: 'SUCCEEDED', startedAt: ago(100), ranAtEnd: '1.2.3+5' })],
  });
  const board = device(WAITING, { fw: { version: '1.2.3+5', confirmed: true } });
  const tab = await openTab(t, {
    world: { ...WORLD, devices: [board], deployments: [installer, cancelled] },
    hash: `#/deployments/${OFFERED}`,
  });
  assert.equal(sentTo(tab, `/api/devices/${WAITING}`).length, 1);
  assert.equal(textOf(one(tab.main, 'p.execution-title')), 'Cancelled');
  assert.equal(
    one(tab.main, 'a', 'Open the deployment that installed it').getAttribute('href'),
    `#/deployments/${later}`
  );
  // It does not offer again what the board runs already.
  assert.equal(
    all(tab.main, 'button').some((item) => textOf(item).includes('Offer again')),
    false
  );
});

test('a deployment page reads no list of updates that it has no use for', async (t) => {
  const tab = await openTab(t, { hash: `#/deployments/${OFFERED}` });
  assert.equal(sentTo(tab, `/api/devices/${WAITING}`).length, 0);
});

test('signing out in one tab ends the others, whatever they hold', async (t) => {
  // Two tabs of the same browser, as far as the line between them goes.
  const lines = new Set();
  class Line {
    constructor(name) {
      this.name = name;
      this.listeners = [];
      lines.add(this);
    }

    addEventListener(type, listener) {
      if (type === 'message') this.listeners.push(listener);
    }

    postMessage(data) {
      for (const line of lines) {
        if (line !== this && line.name === this.name) for (const listener of line.listeners) listener({ data });
      }
    }
  }
  const tab = await openTab(t, { hash: '#/firmware', BroadcastChannel: Line });
  const [here] = lines;
  const other = new Line(here.name);
  const signedOut = () => textOf(one(tab.main, 'h1'));

  // Something else on the line changes nothing.
  for (const listener of here.listeners) listener({ data: 'hello' });
  assert.equal(signedOut(), 'Firmware');

  // A dialog is open, and a file is in hand.
  await chooseFile(tab);
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Revoke');
  assert.notEqual(tab.dialog(), null);

  other.postMessage('signed-out');
  await settle();
  assert.equal(tab.dialog(), null);
  assert.equal(signedOut(), 'You are signed out');
  assert.deepEqual(controls(tab.main), ['Sign in']);
  assert.deepEqual([...tab.storage.keys()], ['cranium.signedout'], 'no token left here');
  assert.deepEqual(tab.navigations, [], 'not sent anywhere: the other tab has ended the login session');
  assert.equal(all(tab.main, 'div.upload-main').length, 0);

  // And nothing is asked for any more.
  const mark = tab.requests.length;
  await tab.wait(60000);
  assert.equal(tab.since(mark).length, 0);
});

test('signing out says so on the line between tabs, and nothing else', async (t) => {
  const posted = [];
  class Line {
    constructor(name) {
      this.name = name;
    }

    addEventListener() {}

    postMessage(data) {
      posted.push([this.name, data]);
    }
  }
  const tab = await openTab(t, { BroadcastChannel: Line });
  await tab.press(tab.account, 'button', 'Sign out');
  assert.deepEqual(posted, [['cranium.session', 'signed-out']]);
  assert.match(tab.navigations[0], /\/logout\?/);
});

test('a browser that cannot open the line between tabs still signs out', async (t) => {
  class Refusing {
    constructor() {
      throw new Error('Not allowed.');
    }
  }
  const tab = await openTab(t, { BroadcastChannel: Refusing });
  assert.equal(textOf(one(tab.main, 'h1')), 'Overview');
  await tab.press(tab.account, 'button', 'Sign out');
  assert.match(tab.navigations[0], /\/logout\?/);
});

test('an upload: read in the browser, verified by the server, and said once when registered', async (t) => {
  const registered = release('2.0.1+0', { uploadedAt: ago(0), notes: 'Fixes the pads.' });
  const wrongKey = {
    code: 'wrong_key',
    message: "The image is signed with a different key than this project's",
    requestId: 'req-9',
  };
  const answers = [
    { status: 422, body: { error: wrongKey } },
    { status: 201, body: { release: registered } },
  ];
  const sent = [];
  const tab = await openTab(t, {
    hash: '#/firmware',
    upload(body) {
      sent.push(body);
      return answers.shift();
    },
  });
  const panel = () => one(tab.main, 'div.upload-state');

  await chooseFile(tab);
  const facts = Object.fromEntries(
    all(panel(), 'div.fact').map((fact) => [textOf(one(fact, 'dt')), textOf(one(fact, 'dd'))])
  );
  assert.equal(facts.Version, '2.0.1+0');
  assert.equal(facts.Size, '1,264 bytes (1 KiB)');
  assert.match(facts['SHA-256'], /^[0-9a-f]{64}$/);
  assert.deepEqual(
    all(tab.main, 'li.check').map((check) => check.getAttribute('class')),
    ['check is-good', 'check is-good', 'check is-wait']
  );
  assert.deepEqual(sent, [], 'nothing is sent before it is asked for');

  await tab.type(one(tab.main, 'textarea'), 'Fixes the pads.\n');
  await tab.press(tab.main, 'button', 'Upload for verification');
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['data', 'filename', 'notes']);
  assert.equal(sent[0].filename, 'zephyr.signed.bin');
  assert.equal(sent[0].notes, 'Fixes the pads.');
  assert.equal(Buffer.from(sent[0].data, 'base64').length, 1264);

  // Refused for what the file is: the way on is another file.
  assert.equal(
    textOf(one(tab.main, 'span.notice-said')),
    "The server refused this image. The image is signed with a different key than this project's."
  );
  assert.deepEqual(controls(panel()), ['Choose another file']);

  await tab.press(tab.main, 'button', 'Choose another file');
  await chooseFile(tab);
  const mark = tab.requests.length;
  await tab.press(tab.main, 'button', 'Upload for verification');
  assert.equal(textOf(one(tab.main, 'p.upload-title')), 'Registered as 2.0.1+0');
  assert.deepEqual(tab.toasts(), [], 'the panel says it; a message on top would say it twice');
  assert.equal(tab.since(mark).includes('GET /api/firmware'), true);
  assert.deepEqual(controls(panel()), ['Deploy this release', 'Upload another']);
});

test('the image the browser reads is the one the API tests sign', async (t) => {
  const fixture = new URL('../../api/test/fixtures/valid-1.2.3+5.signed.bin', import.meta.url);
  if (!existsSync(fixture)) {
    t.skip('the firmware fixtures of the API are not present');
    return;
  }
  const bytes = new Uint8Array(readFileSync(fixture));
  const name = 'valid-1.2.3+5.signed.bin';
  const file = { name, size: bytes.length, arrayBuffer: async () => bytes.buffer };
  const tab = await openTab(t, { hash: '#/firmware', world: { ...WORLD, releases: [release('1.2.3+4')] } });
  await chooseFile(tab, file);
  const state = one(tab.main, 'div.upload-state');
  const fact = (label) => textOf(one(one(state, 'div.fact', label), 'dd'));
  assert.equal(fact('Version'), '1.2.3+5');
  // The name is recorded in the characters the API accepts.
  assert.equal(fact('Recorded as'), 'valid-1.2.3_5.signed.bin');
  assert.match(textOf(state), /Newer than every registered release \(highest so far: 1\.2\.3\+4\)\./);
});

// The Developer section.

test('the serial console opens by its address and asks the API for nothing', async (t) => {
  const tab = await openTab(t, { hash: '#/overview' });
  navigatorSerial();
  const mark = tab.requests.length;
  await tab.goto('#/serial');
  assert.equal(textOf(one(tab.main, 'h1')), 'Serial console');
  assert.equal(tab.document.title, 'Serial console · Cranium');
  assert.deepEqual(tab.since(mark), []);
  await tab.wait(120000);
  assert.deepEqual(tab.since(mark), [], 'and it does not poll');
});

test('a viewer who opens the serial console gets an explanation and no controls', async (t) => {
  const tab = await openTab(t, { viewer: true, hash: '#/serial' });
  await tab.wait(0);
  assert.match(textOf(tab.main), /for release managers/);
  assert.deepEqual(all(tab.main, 'input'), []);
  assert.equal(all(tab.main, 'button').length, 0);
});

test('a browser without Web Serial is told so and gets no controls', async (t) => {
  const tab = await openTab(t, { hash: '#/serial' });
  await tab.wait(0);
  assert.match(textOf(tab.main), /Chrome and Edge/);
  assert.match(textOf(tab.main), /115200 baud/);
  assert.deepEqual(all(tab.main, 'input'), []);
  assert.equal(all(tab.main, 'button').length, 0);
});

test('the history page says plainly that a checkout that was never deployed has none', async (t) => {
  const tab = await openTab(t, { hash: '#/history' });
  await tab.wait(0);
  assert.equal(textOf(one(tab.main, 'h1')), 'History');
  assert.match(textOf(tab.main), /no history in this copy/);
  assert.equal(
    tab.requests.some(({ url }) => url === `${NEIGHBOURS}history.json`),
    true
  );
});

test('the history page shows the file beside its script, and fetches it once', async (t) => {
  const file = {
    deployment: { commit: 'a'.repeat(40), tree: 'clean', deployedAt: new Date(NOW - 60000).toISOString() },
    commits: [
      {
        short: 'aaaaaaa',
        hash: 'a'.repeat(40),
        date: new Date(NOW - 3600000).toISOString(),
        subject: 'Add a page',
        tags: ['website'],
      },
    ],
  };
  const tab = await openTab(t, {
    hash: '#/history',
    answer: (method, url) => (url === `${NEIGHBOURS}history.json` ? Response.json(file) : null),
  });
  await tab.wait(0);
  assert.match(textOf(tab.main), /Add a page/);
  await tab.goto('#/overview');
  const mark = tab.requests.length;
  await tab.goto('#/history');
  assert.equal(
    tab.since(mark).some((request) => request.includes('history.json')),
    false
  );
  assert.match(textOf(tab.main), /Add a page/);
});

// API tokens.

const NEW_SECRET = `crn_${'Z'.repeat(42)}A`;
const IN_30_DAYS = new Date(NOW + 30 * 86400000).toISOString();

/** The API's side of the tokens page: a list that a POST adds to and a revocation changes. */
function tokenServer() {
  const server = {
    tokens: [
      {
        id: 'aaaaaaaaaaaaaaaa',
        name: 'laptop',
        createdAt: ago(3600),
        expiresAt: IN_30_DAYS,
        revokedAt: null,
        status: 'active',
      },
    ],
    answer(method, url, body) {
      if (method === 'GET' && url === '/api/tokens')
        return Response.json({ tokens: server.tokens, limit: 10, maxDays: 90 });
      if (method === 'POST' && url === '/api/tokens') {
        const made = { id: 'bbbbbbbbbbbbbbbb', name: body.name, createdAt: ago(0), expiresAt: IN_30_DAYS };
        server.tokens = [{ ...made, revokedAt: null, status: 'active' }, ...server.tokens];
        return Response.json({ token: NEW_SECRET, ...made }, { status: 201 });
      }
      const revoke = /^\/api\/tokens\/([0-9a-f]{16})\/revoke$/.exec(url);
      if (method === 'POST' && revoke) {
        const token = server.tokens.find((item) => item.id === revoke[1]);
        if (token.revokedAt) return refusal(409, 'token_already_revoked', 'It is revoked already.');
        Object.assign(token, { revokedAt: ago(0), status: 'revoked' });
        return Response.json({ token });
      }
      return null;
    },
  };
  return server;
}

test('a token is made on its own page, shown once in its dialog, and gone with the dialog', async (t) => {
  const server = tokenServer();
  const tab = await openTab(t, { hash: '#/tokens', answer: server.answer });
  assert.equal(tab.document.title, 'API tokens · Cranium');
  assert.equal(one(tab.nav, 'a', 'Developer').getAttribute('aria-current'), 'page');
  assert.deepEqual(
    tab.since(0).filter((line) => line.includes('/api/tokens')),
    ['GET /api/tokens']
  );
  assert.equal(all(tab.main, 'li.token').length, 1);

  await tab.press(tab.main, 'button', 'New token');
  const [name] = all(tab.dialog(), 'input');
  await tab.type(name, '  ci runner ');
  await tab.press(tab.dialog(), 'button', 'Make token');
  assert.deepEqual(
    tab.requests.filter((request) => request.method === 'POST').map((request) => [request.url, request.body]),
    [['/api/tokens', { name: 'ci runner', days: 30 }]]
  );

  // Shown once, and not to be lost by a stray Escape or a click beside the dialog.
  const dialog = tab.dialog();
  assert.equal(textOf(one(dialog, 'code.token-value')), NEW_SECRET);
  assert.equal(dialog.dispatchEvent({ type: 'cancel' }).defaultPrevented, true);
  await tab.wait(400);
  dialog.dispatchEvent({ type: 'mousedown', target: dialog });
  dialog.dispatchEvent({ type: 'click', target: dialog });
  assert.equal(tab.dialog(), dialog);
  // The list behind it is read again, and holds no token.
  assert.equal(all(tab.main, 'li.token').length, 2);
  assert.equal(textOf(tab.main).includes(NEW_SECRET), false);

  await tab.press(dialog, 'button', 'Done');
  assert.equal(tab.dialog(), null);
  assert.equal(textOf(tab.document.body).includes(NEW_SECRET), false);
});

test('the copy button puts the new token on the clipboard and says so', async (t) => {
  const server = tokenServer();
  const tab = await openTab(t, { hash: '#/tokens', answer: server.answer });
  const copied = [];
  globalThis.navigator.clipboard.writeText = async (text) => copied.push(text);
  await tab.press(tab.main, 'button', 'New token');
  await tab.type(all(tab.dialog(), 'input')[0], 'ci');
  await tab.press(tab.dialog(), 'button', 'Make token');
  click(all(tab.dialog(), 'button').find((el) => el.getAttribute('aria-label') === 'Copy the token'));
  await settle();
  assert.deepEqual(copied, [NEW_SECRET]);
  assert.deepEqual(tab.toasts(), ['Copied the token.']);
});

test("a token is revoked through the page's own dialog, never a browser prompt", async (t) => {
  const server = tokenServer();
  const tab = await openTab(t, { hash: '#/tokens', answer: server.answer });
  const prompts = [];
  for (const name of ['confirm', 'alert', 'prompt']) {
    Object.defineProperty(globalThis.window, name, { value: () => prompts.push(name), configurable: true });
  }
  await tab.press(tab.main, 'button', 'Revoke');
  assert.match(textOf(one(tab.dialog(), 'h2')), /Revoke the token “laptop”\?/);
  // Keeping it sends nothing.
  await tab.press(tab.dialog(), 'button', 'Keep the token');
  assert.equal(tab.dialog(), null);
  assert.equal(
    tab.requests.some((request) => request.method === 'POST'),
    false
  );

  await tab.press(tab.main, 'button', 'Revoke');
  await tab.press(tab.dialog(), 'button', 'Revoke token');
  assert.equal(tab.dialog(), null);
  assert.deepEqual(
    tab.requests.filter((request) => request.method === 'POST').map((request) => request.url),
    ['/api/tokens/aaaaaaaaaaaaaaaa/revoke']
  );
  assert.deepEqual(tab.toasts(), ['Revoked the token “laptop”. A script that uses it is refused from now on.']);
  assert.equal(textOf(one(tab.main, 'li.token', 'laptop')).includes('Revoked'), true);
  assert.equal(
    all(tab.main, 'button').some((el) => textOf(el) === 'Revoke'),
    false
  );
  assert.deepEqual(prompts, []);
});

test('a refused token is said in the dialog, which keeps what was typed', async (t) => {
  const tab = await openTab(t, {
    hash: '#/tokens',
    answer(method, url) {
      if (method === 'GET' && url === '/api/tokens') return Response.json({ tokens: [], limit: 10, maxDays: 90 });
      if (method === 'POST' && url === '/api/tokens') {
        return refusal(409, 'too_many_tokens', 'You have 10 API tokens that are still valid.');
      }
      return null;
    },
  });
  await tab.press(tab.main, 'button', 'New token');
  await tab.type(all(tab.dialog(), 'input')[0], 'eleventh');
  await tab.press(tab.dialog(), 'button', 'Make token');
  assert.match(
    textOf(one(tab.dialog(), 'div.dialog-error')),
    /No token was made\. You have 10 API tokens that are still valid\./
  );
  assert.equal(all(tab.dialog(), 'input')[0].value, 'eleventh');
  assert.equal(all(tab.dialog(), 'code.token-value').length, 0);
});

// The map, commands and alerts (docs/fleet.md).

const COMMAND_ID = '3f9c2a1b7d4e6f80';

test("Identify sends the command, and the page shows the board's answer when its log brings it", async (t) => {
  let answered = false;
  const posted = [];
  const tab = await openTab(t, {
    hash: '#/devices',
    answer(method, url, body) {
      if (method === 'POST' && url === `/api/devices/${WAITING}/commands`) {
        posted.push(body);
        return Response.json(
          { command: { id: COMMAND_ID, cmd: 'identify', seconds: 15, thing: WAITING, sentAt: ago(0), online: true } },
          { status: 202 }
        );
      }
      if (method === 'GET' && url.startsWith('/api/events/log?')) {
        const lines = answered
          ? [
              {
                thing: WAITING,
                at: ago(0),
                id: '42.9',
                kind: 'setting',
                tag: 'CMD',
                level: 'info',
                text: `identify for 15 s (${COMMAND_ID})`,
                boot: 42,
                seq: 9,
              },
            ]
          : [];
        return Response.json({ lines, cursor: null, from: ago(60), to: ago(0) });
      }
      return null;
    },
  });
  const row = one(tab.main, 'article.device', WAITING);
  await tab.press(row, 'button.identify-button');
  assert.deepEqual(posted, [{ cmd: 'identify', seconds: 15 }]);
  assert.deepEqual(tab.toasts().filter((text) => text.startsWith('Sent:')).length, 1);
  // The page looks in the board's log, for its CMD lines only, until the answer is there.
  await tab.wait(3000);
  const looked = tab.requests.filter((request) => request.url.startsWith('/api/events/log?'));
  assert.equal(looked.length, 1);
  assert.match(looked[0].url, new RegExp(`thing=${WAITING}.*tags=CMD|tags=CMD.*thing=${WAITING}`));
  answered = true;
  await tab.wait(3000);
  assert.ok(tab.toasts().some((text) => text.includes(`identify for 15 s (${COMMAND_ID})`)));
  await tab.goto(`#/devices/${WAITING}`);
  assert.match(textOf(one(tab.main, 'div.notice', 'answered')), /Identify: the board answered “identify for 15 s/);
  // No more looking once it has answered.
  const after = tab.requests.length;
  await tab.wait(10_000);
  assert.equal(tab.requests.slice(after).filter((request) => request.url.startsWith('/api/events/log?')).length, 0);
});

test('a viewer has no Identify, and the Map and Account pages open from the masthead', async (t) => {
  const tab = await openTab(t, {
    hash: '#/devices',
    viewer: true,
    answer(method, url) {
      if (method === 'GET' && url === '/api/alerts') {
        return Response.json({
          email: MANAGER.email,
          subscription: 'none',
          canSubscribe: false,
          subscribers: 1,
          recent: [],
          rules: { offlineMinutes: 15, everyMinutes: 60, movedMetres: 1000 },
        });
      }
      return null;
    },
  });
  assert.equal(all(tab.main, 'button.identify-button').length, 0);
  assert.equal(one(tab.nav, 'a', 'Map').getAttribute('href'), '#/map');
  await tab.goto('#/map');
  assert.equal(textOf(one(tab.main, 'h1')), 'Map');
  assert.equal(tab.document.title, 'Map · Cranium');
  assert.equal(one(tab.account, 'a.account-link').getAttribute('href'), '#/account');
  await tab.goto('#/account');
  assert.equal(textOf(one(tab.main, 'h1')), 'Account');
  assert.match(textOf(tab.main), /Release managers can ask for them, at their own address\./);
});

test('a release manager asks for the e-mail alerts and is told to confirm them', async (t) => {
  let subscription = 'none';
  const tab = await openTab(t, {
    hash: '#/account',
    answer(method, url) {
      if (method === 'GET' && url === '/api/alerts') {
        return Response.json({
          email: MANAGER.email,
          subscription,
          canSubscribe: true,
          subscribers: 0,
          recent: [],
          rules: { offlineMinutes: 15, everyMinutes: 60, movedMetres: 1000 },
        });
      }
      if (method === 'POST' && url === '/api/alerts/subscribe') {
        subscription = 'pending';
        return Response.json({ subscription }, { status: 202 });
      }
      return null;
    },
  });
  await tab.press(tab.main, 'button', `Send alerts to ${MANAGER.email}`);
  assert.deepEqual(
    tab.requests.filter((request) => request.method === 'POST').map((request) => request.url),
    ['/api/alerts/subscribe']
  );
  assert.ok(tab.toasts().some((text) => /AWS Notifications is sending you an e-mail with a link/.test(text)));
  assert.match(textOf(tab.main), /Waiting for you to confirm/);
});

// In the phone app (docs/mobile-apps.md, "The app shell").

test("in the phone app the console takes its settings and its session from the app, and calls the API at the console's address", async (t) => {
  const tab = await openTab(t, { session: null, app: {} });
  await until(() => textOf(tab.main).includes('Overview'), 'the overview');
  const asked = tab.appCalls.map((message) => message.method);
  assert.deepEqual(asked.slice(0, 3), ['app.hello', 'app.config', 'auth.session']);
  assert.deepEqual(tab.appCalls[2].params, { pool: 'admin' });
  assert.ok(asked.includes('app.ready'), 'the app is told the pages started');
  const me = tab.requests.find((request) => request.url === '/api/me');
  assert.equal(me.address, `${APP_API}/api/me`);
  assert.equal(me.token, 'Bearer APP-TOKEN');
  // Every request of the API went to the console's address, none to the page's own origin.
  assert.ok(
    tab.requests
      .filter((request) => request.url.startsWith('/api/'))
      .every((request) => request.address.startsWith(APP_API))
  );
  // Nothing of the session in the tab's storage: the app holds it.
  assert.equal(tab.storage.size, 0);
  // Bluetooth is in the masthead of a release manager in the app, and the app's own settings in the account box.
  assert.ok(textOf(tab.nav).includes('Bluetooth'));
  await tab.press(tab.account, 'button', 'App');
  assert.ok(tab.appCalls.some((message) => message.method === 'app.settings'));
  // The Bluetooth page, with the newest active release chosen and the way to open the board's window.
  await tab.goto('#/bluetooth');
  await until(() => textOf(tab.main).includes('Look for boards'), 'the Bluetooth page');
  assert.ok(textOf(tab.main).includes('Update over Bluetooth'));
});

test("a board's page shows its QR code and label on the console's own origin, and hides them again", async (t) => {
  const tab = await openTab(t, { hash: `#/devices/${WAITING}`, origin: 'https://console.test' });
  await until(() => controls(tab.main).includes('Show QR / Print label'), 'the button');
  await tab.press(tab.main, 'button', 'Show QR / Print label');
  await until(() => all(tab.main, 'figure.board-label').length === 1, 'the label');
  assert.match(
    textOf(tab.main),
    new RegExp(`The code opens https://console\\.test/#/devices/${WAITING} on this console`)
  );
  assert.equal(textOf(one(tab.main, 'span.board-label-thing')), WAITING);
  await tab.press(tab.main, 'button', 'Hide QR');
  assert.equal(all(tab.main, 'figure.board-label').length, 0);
});

test('in the app, the label links to the console, not to the app’s own pages', async (t) => {
  const tab = await openTab(t, { session: null, app: {}, hash: `#/devices/${WAITING}` });
  await until(() => controls(tab.main).includes('Show QR / Print label'), 'the button');
  await tab.press(tab.main, 'button', 'Show QR / Print label');
  await until(() => all(tab.main, 'figure.board-label').length === 1, 'the label');
  assert.match(
    textOf(tab.main),
    new RegExp(`The code opens https://console\\.example/#/devices/${WAITING} on this console`)
  );
});

test('Scan board: in a phone app with a camera, a board of this console opens its page; anything else is refused', async (t) => {
  const hello = { ...APP_ANSWERS['app.hello'], features: [...APP_ANSWERS['app.hello'].features, 'camera'] };
  let answer = { thing: WAITING };
  const tab = await openTab(t, {
    session: null,
    app: { 'app.hello': hello, 'camera.scan': () => answer },
    hash: '#/devices',
  });
  await until(() => controls(tab.main).includes('Scan board'), 'Scan board');
  await tab.press(tab.main, 'button', 'Scan board');
  await until(() => tab.location.hash === `#/devices/${WAITING}`, "the board's page");
  assert.deepEqual(
    tab.appCalls.filter((call) => call.method === 'camera.scan').map((call) => call.params),
    [{}]
  );

  // The app refused a link of another console: nothing opens, and the page says why.
  await tab.goto('#/devices');
  answer = { refuse: 'not_allowed' };
  await tab.press(tab.main, 'button', 'Scan board');
  await until(() => tab.toasts().length > 0, 'the refusal');
  assert.deepEqual(tab.toasts(), ['That code is not a board of this console, so the app did not open it.']);
  assert.equal(tab.location.hash, '#/devices');
  // A thing name the page would not open is refused by the page too.
  answer = { thing: '../evil' };
  await tab.press(tab.main, 'button', 'Scan board');
  assert.equal(tab.location.hash, '#/devices');
  // Closing the camera says nothing.
  answer = { refuse: 'cancelled' };
  const before = tab.toasts().length;
  await tab.press(tab.main, 'button', 'Scan board');
  assert.equal(tab.toasts().length, before);
});

test('there is no Scan board on the website', async (t) => {
  const web = await openTab(t, { hash: '#/devices' });
  assert.ok(textOf(web.main).includes('Every board registered'));
  assert.equal(controls(web.main).includes('Scan board'), false);
});

test('there is no Scan board in an app without a camera', async (t) => {
  const app = await openTab(t, { session: null, app: {}, hash: '#/devices' });
  await until(() => textOf(app.main).includes('Every board registered'), 'the Devices page');
  assert.equal(controls(app.main).includes('Scan board'), false);
});

test('on the website, and for a viewer in the app, there is no Bluetooth page in the masthead', async (t) => {
  const web = await openTab(t);
  assert.equal(textOf(web.nav).includes('Bluetooth'), false);
  assert.equal(web.appCalls.length, 0);
});

test('in the app, Face ID cancelled leaves the console locked with a way to unlock, and the sign-in kept', async (t) => {
  const tab = await openTab(t, { session: null, app: { 'auth.session': { refuse: 'cancelled' } } });
  await until(() => textOf(tab.main).includes('Cranium is locked'), 'the locked page');
  assert.equal(
    tab.appCalls.some((message) => message.method === 'auth.signOut'),
    false,
    'nothing is forgotten'
  );
  await tab.press(tab.main, 'button', 'Unlock');
  assert.deepEqual(tab.navigations, ['reload']);
});

test('in the app, a saved sign-in the biometric can no longer open asks for the password and code, and says why', async (t) => {
  const tab = await openTab(t, { session: null, app: { 'auth.session': { refuse: 'locked' } } });
  await until(() => textOf(tab.main).includes('can no longer open the saved sign-in'), 'the sign-in page');
  assert.ok(tab.document.getElementById('signin-email'));
});

// Live updates (live.js, docs/live.md).

test('with the live API, a change it tells makes the page read again once, at once; without it the console only polls', async (t) => {
  const sockets = [];
  class FakeSocket {
    constructor(url, protocols) {
      Object.assign(this, { url, protocols, sent: [] });
      sockets.push(this);
    }
    send(text) {
      this.sent.push(text);
    }
    close() {}
  }
  const LIVE_URL = 'wss://live.example/live';
  const tab = await openTab(t, { liveUrl: LIVE_URL, WebSocket: FakeSocket });
  await until(() => sockets.length === 1, 'the WebSocket');
  // The token goes in the subprotocols, never in the address.
  assert.equal(sockets[0].url, LIVE_URL);
  assert.deepEqual(sockets[0].protocols, ['cranium-live', 'TOKEN']);
  sockets[0].onopen({});
  await settle();
  assert.ok(textOf(tab.main).includes('Live'), 'the page says it is live');

  const mark = tab.requests.length;
  sockets[0].onmessage({ data: JSON.stringify({ type: 'changed', things: [], what: ['board'], at: 'x' }) });
  sockets[0].onmessage({ data: JSON.stringify({ type: 'changed', things: [], what: ['updates'], at: 'x' }) });
  await tab.wait(300);
  await until(() => tab.since(mark).includes('GET /api/devices'), 'the boards read again');
  await settle();
  assert.equal(tab.since(mark).filter((line) => line === 'GET /api/devices').length, 1, 'two changes, one read');

  // Hidden, the WebSocket is closed within a few seconds.
  await tab.hide(true);
  await tab.wait(5000);
  assert.equal(sockets[0].onmessage, null);
});

test('without the live API in its settings, the console opens no WebSocket', async (t) => {
  let made = 0;
  class FakeSocket {
    constructor() {
      made += 1;
    }
  }
  const tab = await openTab(t, { WebSocket: FakeSocket });
  await tab.wait(60_000);
  assert.equal(made, 0);
  assert.ok(tab.requests.length > 0);
});

// Search and filters (docs/search-filters.md): the address carries them, and the long lists are asked again.

test('a filtered address opens the list filtered, and a change is written back to it without a new page', async (t) => {
  const tab = await openTab(t, { hash: '#/devices?status=offline' });
  await tab.wait(0);
  assert.equal(all(tab.main, 'article.device').length, 1);
  assert.equal(textOf(one(tab.main, 'p.filter-count')), '1 of 3 shown');
  const mark = tab.requests.length;
  const input = one(tab.main, 'input.filter-input');
  input.value = 'nothing like it';
  input.dispatchEvent({ type: 'input' });
  await settle();
  assert.equal(tab.location.hash, '#/devices?q=nothing+like+it&status=offline');
  assert.match(textOf(tab.main), /No boards match\./);
  // A short list is filtered as it is drawn: nothing is asked of the API.
  assert.deepEqual(tab.since(mark), []);
  await tab.press(tab.main, 'button.filter-clear', 'Clear');
  assert.equal(tab.location.hash, '#/devices');
  assert.equal(all(tab.main, 'article.device').length, 3);
  // A filter the page does not have, or a value it does not take, is as if absent.
  await tab.goto('#/devices?status=asleep');
  assert.equal(all(tab.main, 'article.device').length, 3);
});

test('the activity log is searched by the server, a moment after the typing stops', async (t) => {
  const asked = [];
  const tab = await openTab(t, {
    hash: '#/activity?outcome=rejected',
    answer: (method, url) => {
      if (!url.startsWith('/api/audit?') || url === '/api/audit?limit=50') return null;
      asked.push(url);
      return Response.json({ entries: WORLD.entries.slice(3), next: null, read: 4 });
    },
  });
  await tab.wait(0);
  assert.deepEqual(asked, ['/api/audit?limit=50&outcomes=rejected']);
  assert.match(textOf(one(tab.main, 'p.filter-count')), /^1 of 4 entries read match$/);
  const input = one(tab.main, 'input.filter-input');
  for (const typed of ['z', 'ze', 'zep']) {
    input.value = typed;
    input.dispatchEvent({ type: 'input' });
    await tab.wait(100);
  }
  assert.equal(asked.length, 1, 'not while typing');
  await tab.wait(400);
  assert.deepEqual(asked.slice(1), ['/api/audit?limit=50&q=zep&outcomes=rejected']);
  assert.equal(tab.location.hash, '#/activity?q=zep&outcome=rejected');
  // Clear asks for the whole log again.
  await tab.press(tab.main, 'button.filter-clear', 'Clear');
  await tab.wait(0);
  assert.equal(tab.location.hash, '#/activity');
  assert.ok(tab.requests.some((request) => request.url === '/api/audit?limit=50'));
});

// Copy rules of the redesign: a page opens with one short sentence of at most 15 words, and the pages people use
// name no script, key path or AWS service in their text. A Developer page (Board setup, Serial, API tokens, Database,
// History) may, and so may a "Details" or a "How … works", which are closed until someone opens them.
const PRODUCT_PAGES = [
  '#/overview',
  '#/devices',
  '#/map',
  '#/diagnostics',
  '#/events',
  '#/firmware',
  '#/deployments',
  '#/memfault',
  '#/alerts',
  '#/activity',
  '#/apps',
  '#/customers',
  '#/account',
];
// A board's page, Reports, Team, Board setup and Database fetch scripts of their own, which this harness does not
// serve: copy.test.mjs, team.test.mjs and memfault.test.mjs hold those to the same rules.
const DEVELOPER_PAGES = ['#/serial', '#/tokens', '#/history'];
const INTERNALS = /deploy\.sh|DynamoDB|Cognito|~\/\.cranium|scripts\/|\bAWS\b|CustomerDomainName/;

/** The text of a node, leaving out every <details>, which is closed until someone opens it. */
const outsideDetails = (node) =>
  node.nodeType === 3
    ? node.textContent
    : node.localName === 'details'
      ? ' '
      : node.childNodes.map(outsideDetails).join(' ');

test('every page opens with a lede of at most 15 words, and no product page names internals outside Details', async (t) => {
  // No app published yet, and no address for the customer site yet: the cards that say so are drawn too.
  const replies = {
    '/api/apps': { android: { releases: [] }, ios: {} },
    '/api/customers': { configured: true, customers: [], siteUrl: '' },
  };
  const tab = await openTab(t, {
    answer: (method, url) => (Object.hasOwn(replies, url) ? Response.json(replies[url]) : null),
  });
  let ledes = 0;
  const named = [];
  for (const route of [...PRODUCT_PAGES, ...DEVELOPER_PAGES]) {
    await tab.goto(route);
    await tab.wait(0);
    // A page whose script is fetched when it opens says "Loading the page…" until it has come.
    await until(() => !textOf(tab.main).includes('Loading the page'), route);
    for (const lede of all(tab.main, 'p.page-lede')) {
      const words = textOf(lede).split(/\s+/).filter(Boolean);
      assert.ok(words.length <= 15, `${route}: "${textOf(lede)}" is ${words.length} words`);
      ledes += 1;
    }
    if (PRODUCT_PAGES.includes(route)) {
      const text = outsideDetails(tab.main).replace(/\s+/g, ' ');
      for (const found of text.matchAll(new RegExp(INTERNALS, 'g'))) {
        named.push(`${route}: …${text.slice(Math.max(0, found.index - 60), found.index + 40)}…`);
      }
    }
  }
  assert.deepEqual(named, []);
  // The pages were drawn, not only their loading lines.
  await tab.goto('#/apps');
  assert.match(textOf(tab.main), /Get the code\. Commands/);
  await tab.goto('#/customers');
  assert.match(textOf(tab.main), /invitations wait until the customer site has its address/);
  // Most pages have a lede; a page that failed to draw would have none and prove nothing.
  assert.ok(ledes >= 12, `${ledes} ledes`);
});
