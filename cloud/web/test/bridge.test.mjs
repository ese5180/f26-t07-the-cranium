/**
 * The phone app's bridge, as the pages use it (assets/bridge.js, docs/mobile-apps.md "The app shell"):
 * how a page finds the app, the requests and answers and events on the line, what it takes from the
 * app's hello and configuration, and the sign-in that the app keeps (core.js createAuth with a vault):
 * the refresh token goes to the app and never stays in the page. And the contract, apps/shared/bridge.json,
 * which both shells check every request against: every method a page asks for is in it, with no
 * parameter it does not list.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createCognito } from './cognito.mjs';
import { BRIDGE, CORE } from './page.mjs';

const bridge = await import(BRIDGE);
const core = await import(CORE);

const CONTRACT = JSON.parse(readFileSync(new URL('../../../apps/shared/bridge.json', import.meta.url), 'utf8'));

/** A stand-in for the iPhone app's side: what the page posts, and a way to answer as the app does. */
function iosWindow() {
  const posted = [];
  const listeners = [];
  const win = {
    webkit: { messageHandlers: { cranium: { postMessage: (text) => posted.push(JSON.parse(text)) } } },
    addEventListener: (name, listener) => {
      assert.equal(name, bridge.NATIVE_EVENT);
      listeners.push(listener);
    },
  };
  const send = (message) => listeners.forEach((listener) => listener({ detail: JSON.stringify(message) }));
  return { win, posted, send };
}

function androidWindow() {
  const posted = [];
  const port = { postMessage: (text) => posted.push(JSON.parse(text)), onmessage: null };
  return { win: { craniumNative: port }, posted, send: (message) => port.onmessage({ data: JSON.stringify(message) }) };
}

/** Timers that run only when told. */
function manualTimers() {
  let next = 0;
  const due = new Map();
  return {
    setTimeout: (run, ms) => {
      next += 1;
      due.set(next, { run, ms });
      return next;
    },
    clearTimeout: (id) => due.delete(id),
    fire: () => {
      for (const [id, { run }] of [...due]) {
        due.delete(id);
        run();
      }
    },
    size: () => due.size,
  };
}

const HELLO = {
  bridge: 1,
  platform: 'ios',
  shell: { version: '0.8.0', build: '14' },
  bundle: { id: '0123456789abcdef', console: '2.1.1', source: 'downloaded' },
  features: [
    'auth',
    'biometric',
    'ble',
    'clipboard',
    'haptics',
    'share',
    'open',
    'keepAwake',
    'settings',
    'something-new',
  ],
};

test('on the website there is no app: no transport, and connectBridge answers null at once', async () => {
  assert.equal(bridge.findTransport({}), null);
  assert.equal(bridge.findTransport({ webkit: {} }), null);
  assert.equal(bridge.findTransport({ craniumNative: {} }), null);
  assert.equal(await bridge.connectBridge({}), null);
});

test('in the iPhone app: requests go to the message handler, answers come back as events on the window', async () => {
  const phone = iosWindow();
  const line = bridge.createBridge(bridge.findTransport(phone.win), { timers: manualTimers() });
  const asked = line.call('ble.state');
  assert.deepEqual(phone.posted, [{ v: 1, id: 1, method: 'ble.state', params: {} }]);
  phone.send({ id: 1, ok: true, result: { state: 'on' } });
  assert.deepEqual(await asked, { state: 'on' });

  const refused = line.call('app.open', { url: 'http://example.invalid/' });
  phone.send({
    id: 2,
    ok: false,
    error: { code: 'not_allowed', message: 'The app opens only https, SideStore and authenticator addresses.' },
  });
  await assert.rejects(
    refused,
    (error) =>
      error instanceof bridge.BridgeError &&
      error.code === 'not_allowed' &&
      error.message.startsWith('The app opens only')
  );

  // An answer to nothing, a message that is not JSON, and an event: none upsets what is waiting.
  const seen = [];
  const stop = line.on('ble.progress', (data) => seen.push(data));
  const waiting = line.call('ble.images');
  phone.send({ id: 99, ok: true, result: {} });
  phone.win.addEventListener(bridge.NATIVE_EVENT, () => {});
  phone.send({ event: 'ble.progress', data: { sent: 10, total: 100 } });
  stop();
  phone.send({ event: 'ble.progress', data: { sent: 20, total: 100 } });
  phone.send({ id: 3, ok: true, result: { images: [] } });
  assert.deepEqual(await waiting, { images: [] });
  assert.deepEqual(seen, [{ sent: 10, total: 100 }]);
});

test('in the Android app: the web message listener carries both ways', async () => {
  const phone = androidWindow();
  const line = bridge.createBridge(bridge.findTransport(phone.win), { timers: manualTimers() });
  const asked = line.call('clipboard.write', { text: '123456', expiresIn: 120 });
  assert.deepEqual(phone.posted[0], {
    v: 1,
    id: 1,
    method: 'clipboard.write',
    params: { text: '123456', expiresIn: 120 },
  });
  phone.send({ id: 1, ok: true, result: {} });
  assert.deepEqual(await asked, {});
  // An error code the page does not know is a failure; its words are kept.
  const odd = line.call('haptics.play', { kind: 'success' });
  phone.send({ id: 2, ok: false, error: { code: 'Not A Code', message: 'Nope.' } });
  await assert.rejects(odd, (error) => error.code === 'failed' && error.message === 'Nope.');
});

test('a quick call that the app never answers fails after a while; one that waits for a person does not', async () => {
  const phone = androidWindow();
  const timers = manualTimers();
  const line = bridge.createBridge(bridge.findTransport(phone.win), { timers });
  const quick = line.call('ble.state');
  assert.equal(timers.size(), 1);
  line.call('auth.session', { pool: 'admin' });
  line.call('ble.upload', { image: 'AAAA', sha256: 'a'.repeat(64) });
  assert.equal(timers.size(), 1, 'no time limit for Face ID or an upload');
  timers.fire();
  await assert.rejects(quick, (error) => error.code === 'failed' && error.message === 'The app did not answer.');
});

test('the hello: the version, the app and its pages, and only the features this page knows', async () => {
  const phone = iosWindow();
  const timers = manualTimers();
  const connecting = bridge.connectBridge(phone.win, { timers });
  assert.equal(phone.posted[0].method, 'app.hello');
  phone.send({ id: 1, ok: true, result: HELLO });
  const line = await connecting;
  assert.equal(line.platform, 'ios');
  assert.equal(line.has('ble'), true);
  assert.equal(line.has('appUpdate'), false);
  assert.equal(line.has('something-new'), false);
  assert.equal(phone.win.cranium.bridge, line, 'window.cranium.bridge, for feature detection');
  assert.equal(bridge.appWords(line.hello), 'iPhone app 0.8.0 (14), pages of console 2.1.1, from the console');
  assert.equal(
    bridge.appWords({ ...line.hello, platform: 'android', bundle: { ...line.hello.bundle, source: 'built-in' } }),
    'Android app 0.8.0 (14), pages of console 2.1.1, built into the app'
  );
  assert.equal(
    bridge.appWords({ ...line.hello, needsNewerApp: true }),
    'iPhone app 0.8.0 (14), pages of console 2.1.1, from the console. The console has newer pages, which need a newer app'
  );
  assert.equal(line.hello.needsNewerApp, false);
  assert.equal(bridge.readHello({ bridge: 0 }), null);
  assert.equal(bridge.readHello('hello'), null);

  const strange = iosWindow();
  const failing = bridge.connectBridge(strange.win, { timers: manualTimers() });
  strange.send({ id: 1, ok: true, result: { bridge: 'one' } });
  await assert.rejects(failing, /does not know/);
});

const APP_CONFIG = {
  consoleUrl: 'https://console.example/',
  region: 'xx-test-1',
  userPoolId: 'xx-test-1_Staff0Pool',
  mobileClientId: 'phoneclient0',
  customerApiUrl: 'https://cranium.example',
  customerRegion: 'xx-test-1',
  customerUserPoolId: 'xx-test-1_Customer0Pool',
  customerClientId: 'customerphone0',
  example: false,
};

test("the app's configuration gives the console the phone client, no managed login, and the API at its address", () => {
  const app = bridge.readAppConfig(APP_CONFIG);
  assert.equal(app.consoleUrl, 'https://console.example');
  const origin = 'cranium-app://bundle';
  assert.deepEqual(bridge.appConsoleConfig(app, origin), {
    clientId: 'phoneclient0',
    loginOrigin: '',
    scope: '',
    redirectUri: 'cranium-app://bundle/admin',
    userPoolId: 'xx-test-1_Staff0Pool',
    idpOrigin: 'https://cognito-idp.xx-test-1.amazonaws.com',
    apiBase: 'https://console.example',
    customerSite: '/',
  });
  assert.deepEqual(bridge.appSiteConfig(app, origin), {
    customer: { clientId: 'customerphone0', userPoolId: 'xx-test-1_Customer0Pool' },
    admin: { clientId: 'phoneclient0', userPoolId: 'xx-test-1_Staff0Pool' },
    idpOrigin: 'https://cognito-idp.xx-test-1.amazonaws.com',
    home: 'cranium-app://bundle/',
    adminPath: '/admin',
    customerApi: 'https://cranium.example',
    consoleApi: 'https://console.example',
  });
  // No customer pool: admin mode only, and no way back to a customer side.
  const staffOnly = bridge.readAppConfig({
    ...APP_CONFIG,
    customerApiUrl: null,
    customerRegion: null,
    customerUserPoolId: null,
    customerClientId: null,
  });
  assert.equal(staffOnly.customer, null);
  assert.equal(bridge.appSiteConfig(staffOnly, origin), null);
  assert.equal(bridge.appConsoleConfig(staffOnly, origin).customerSite, undefined);
  // Anything that does not look right is not used.
  for (const change of [
    { consoleUrl: 'http://console.example' },
    { consoleUrl: 'javascript:alert(1)' },
    { region: 'Region 1' },
    { userPoolId: 'yy-other-2_Staff0Pool' },
    { mobileClientId: 'has space' },
  ]) {
    assert.equal(bridge.readAppConfig({ ...APP_CONFIG, ...change }), null, JSON.stringify(change));
  }
  assert.equal(bridge.readAppConfig({ ...APP_CONFIG, customerRegion: 'yy-other-2' }).customer, null);
  assert.equal(bridge.readAppConfig(null), null);
});

test("the page's storage in the app lasts as long as the page", () => {
  const storage = bridge.memoryStorage();
  storage.setItem('a', 1);
  assert.equal(storage.getItem('a'), '1');
  storage.removeItem('a');
  assert.equal(storage.getItem('a'), null);
  storage.setItem('b', 'x');
  storage.clear();
  assert.equal(storage.getItem('b'), null);
});

test('every method a page asks the app for is in the contract, with only the parameters it lists', () => {
  const sources = [
    ['src/site/assets/bridge.js', 'bridge.call'],
    ['src/site/assets/app.js', 'appBridge'],
    ['src/site/assets/bluetooth.js', 'bridge.call'],
    ['src/customer/assets/customer.js', 'appBridge'],
  ].map(([path]) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
  const asked = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/\.call\(\s*'([a-zA-Z]+\.[a-zA-Z]+)'(?:\s*,\s*\{([^}]*)\})?/g)) {
      asked.add(match[1]);
      const method = CONTRACT.methods[match[1]];
      assert.ok(method, `${match[1]} is not in apps/shared/bridge.json`);
      const keys = [...(match[2] ?? '').matchAll(/(?:^|,)\s*([a-zA-Z]+)\s*(?::|,|$)/g)].map((key) => key[1]);
      for (const key of keys) assert.ok(Object.hasOwn(method.params, key), `${match[1]} takes no ${key}`);
    }
    // Through quietly(method, params), as bluetooth.js asks for what it can do without.
    for (const match of source.matchAll(/quietly\(\s*'([a-zA-Z]+\.[a-zA-Z]+)'/g)) {
      asked.add(match[1]);
      assert.ok(CONTRACT.methods[match[1]], `${match[1]} is not in apps/shared/bridge.json`);
    }
  }
  // The vault asks for the three of a sign-in.
  for (const name of [
    'app.hello',
    'app.config',
    'app.ready',
    'auth.store',
    'auth.session',
    'auth.signOut',
    'ble.upload',
    'ble.watch',
  ]) {
    assert.ok(asked.has(name), `${name} is asked for`);
  }
  // The features the page knows are the contract's, and so is the version.
  assert.equal(CONTRACT.bridge, bridge.BRIDGE_VERSION);
  assert.deepEqual(
    [...CONTRACT.features].sort(),
    ['appUpdate', 'auth', 'ble', 'biometric', 'clipboard', 'haptics', 'keepAwake', 'open', 'settings', 'share'].sort()
  );
  for (const [name, method] of Object.entries(CONTRACT.methods)) {
    assert.ok(method.feature === null || CONTRACT.features.includes(method.feature), `${name}: ${method.feature}`);
  }
});

// The sign-in the app keeps.

const POOL = 'xx-test-1_Staff0Pool';
const CLIENT = 'phoneclient0';
const IDP = 'https://cognito-idp.xx-test-1.amazonaws.com';
const USER = {
  email: 'person@example.invalid',
  userId: '6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b',
  password: 'Correct-Horse-B4ttery',
  code: '246810',
};

function appTab({ session = async () => ({ signedIn: false }), store = async () => ({}) } = {}) {
  const cognito = createCognito({ userPoolId: POOL, clientId: CLIENT, users: [USER] });
  const kept = [];
  const asked = [];
  const navigations = [];
  const fetches = [];
  const vault = {
    store: async (tokens) => {
      kept.push(tokens);
      return store(tokens);
    },
    session: async () => {
      asked.push('session');
      return session();
    },
    signOut: async () => {
      asked.push('signOut');
      return {};
    },
  };
  const storage = bridge.memoryStorage();
  const auth = core.createAuth({
    config: bridge.appConsoleConfig(bridge.readAppConfig({ ...APP_CONFIG, userPoolId: POOL }), 'cranium-app://bundle'),
    storage,
    location: { search: '', hash: '#/firmware', pathname: '/admin', assign: (url) => navigations.push(url) },
    history: { replaceState() {} },
    fetch: async (url, init) => {
      fetches.push(url);
      return cognito.fetch(IDP, url, init);
    },
    crypto: globalThis.crypto,
    vault,
  });
  return { auth, cognito, kept, asked, navigations, fetches, storage };
}

test('in the app the refresh token goes to the app, is never revoked, and the page keeps only the access token', async () => {
  const phone = appTab();
  assert.deepEqual(await phone.auth.resume(), { status: 'sign-in' }, 'nothing kept yet');
  assert.deepEqual(await phone.auth.passwordSignIn(USER.email, USER.password), { step: 'code' });
  assert.deepEqual(await phone.auth.sendCode(USER.code), { step: 'done' });
  assert.equal(await phone.auth.revocation(), 'kept');
  assert.equal(phone.kept.length, 1);
  const [tokens] = phone.kept;
  assert.match(tokens.refreshToken, /\S{10,}/);
  assert.match(tokens.accessToken, /\S{10,}/);
  assert.ok(tokens.expiresIn > 0);
  // Nothing was revoked, and only the user pool API was spoken to.
  assert.equal(
    phone.cognito.calls.some(({ operation }) => operation === 'RevokeToken'),
    false
  );
  assert.ok(phone.fetches.every((url) => url.startsWith(IDP)));
  // The page's own storage holds the access token, never the refresh token.
  const held = JSON.stringify([
    ...['cranium.session', 'cranium.signin', 'cranium.signedout'].map((key) => phone.storage.getItem(key)),
  ]);
  assert.equal(held.includes(tokens.refreshToken), false);
  assert.equal(phone.auth.accessToken(), tokens.accessToken);
  assert.equal(phone.auth.inApp, true);
  // Signing out: the app forgets and revokes it, then back to the site's own page.
  phone.auth.signOut();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(phone.asked, ['session', 'signOut']);
  assert.deepEqual(phone.navigations, ['cranium-app://bundle/admin']);
});

test('in the app a page that opens asks the app for an access token, and renews through it', async () => {
  let given = 0;
  const phone = appTab({
    session: async () => ({ signedIn: true, accessToken: `access-${(given += 1)}`, expiresIn: 3600 }),
  });
  assert.deepEqual(await phone.auth.resume(), { status: 'signed-in', route: null });
  assert.equal(phone.auth.accessToken(), 'access-1');
  assert.equal(await phone.auth.renew(), true);
  assert.equal(phone.auth.accessToken(), 'access-2');

  for (const [code, reason] of [
    ['cancelled', 'cancelled'],
    ['locked', 'locked'],
    ['network', 'network'],
    ['failed', 'failed'],
  ]) {
    const refusing = appTab({
      session: async () => {
        throw Object.assign(new Error('no'), { code });
      },
    });
    assert.deepEqual(await refusing.auth.resume(), { status: 'sign-in', reason }, code);
    assert.equal(await refusing.auth.renew(), false);
  }
  // A token that is not one is not taken.
  const odd = appTab({ session: async () => ({ signedIn: true, accessToken: '', expiresIn: 3600 }) });
  assert.deepEqual(await odd.auth.resume(), { status: 'sign-in' });
});

test("the vault hands the app the pool and the tokens, in the contract's ranges", async () => {
  const calls = [];
  const line = { call: async (method, params) => calls.push({ method, params }) };
  const vault = bridge.createVault(line, 'customer');
  await vault.store({ refreshToken: 'r', accessToken: 'a', idToken: 'i', expiresIn: 3600.7 });
  await vault.store({ refreshToken: 'r', accessToken: 'a', expiresIn: 10 ** 9 });
  await vault.session();
  await vault.signOut();
  assert.deepEqual(calls, [
    {
      method: 'auth.store',
      params: { pool: 'customer', refreshToken: 'r', accessToken: 'a', idToken: 'i', expiresIn: 3600 },
    },
    { method: 'auth.store', params: { pool: 'customer', refreshToken: 'r', accessToken: 'a', expiresIn: 86400 } },
    { method: 'auth.session', params: { pool: 'customer' } },
    { method: 'auth.signOut', params: { pool: 'customer' } },
  ]);
  const store = CONTRACT.methods['auth.store'].params;
  assert.deepEqual(Object.keys(calls[0].params).sort(), Object.keys(store).sort());
  assert.ok(calls[1].params.expiresIn <= store.expiresIn.max);
});

test("the API client in the app calls the console's address, and asks for a sign-in when a change needs a fresh one", async () => {
  const urls = [];
  const signIns = [];
  const api = core.createApi({
    auth: { accessToken: () => 'token' },
    fetch: async (url) => {
      urls.push(url);
      if (url.endsWith('/revoke')) {
        return new Response(
          JSON.stringify({
            error: { code: 'phone_sign_in_again', message: 'To change anything from the phone, sign in again first.' },
          }),
          { status: 403 }
        );
      }
      return new Response(JSON.stringify({ email: 'a@example.invalid', groups: [], canWrite: false }), { status: 200 });
    },
    crypto: globalThis.crypto,
    clock: { observe() {} },
    onUnauthorized() {},
    base: 'https://console.example',
    onSignInAgain: (error) => signIns.push(error.code),
  });
  await api.me();
  assert.equal(urls[0], 'https://console.example/api/me');
  await assert.rejects(api.revoke('1.13.0+0', 'bad'), (error) => error.code === 'phone_sign_in_again');
  assert.deepEqual(signIns, ['phone_sign_in_again']);
});
