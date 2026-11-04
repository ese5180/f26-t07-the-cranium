/**
 * Tests for the customer site in the local preview (docs/customer-site.md): its page and the
 * console's under /admin on one name, the two sign-ins with the console's own code (core.js
 * createAuth) against the stand-ins for both pools, the customer API behind the customer pool's
 * authorizer, and admin mode: the console finding the admin's session in the tab without a
 * second sign-in.
 *
 * The site's own script (customer-core.js) is loaded as the browser loads it. Run with
 * `node --test` in cloud/dev. No network beyond the loopback address, no AWS.
 */

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  PREVIEW_CODE, PREVIEW_CUSTOMER_PASSWORD, PREVIEW_PASSWORD, PREVIEW_TEMPORARY_PASSWORD, createPreview,
} from './preview.mjs';

const asData = (text) => `data:text/javascript;base64,${Buffer.from(text, 'utf8').toString('base64')}`;
const coreAddress = asData(readFileSync(new URL('../web/src/site/assets/core.js', import.meta.url), 'utf8'));
const core = await import(coreAddress);
const site = await import(asData(readFileSync(new URL('../web/src/customer/assets/customer-core.js', import.meta.url), 'utf8')
  .replaceAll("from './core.js'", `from '${coreAddress}'`)));

const ADA = 'ada@preview.invalid';
const CLEO = 'cleo@preview.invalid';
const MANAGER = 'manager@preview.invalid';

async function start(t) {
  const clock = { ms: Date.UTC(2026, 10, 4, 12, 0, 0) };
  const now = () => {
    clock.ms += 1;
    return clock.ms;
  };
  const preview = await createPreview({ scenario: 'customers', customer: true, port: 0, now });
  t.after(() => preview.stop());
  return { preview, clock, origin: preview.consoleUrl.slice(0, -1) };
}

/** The settings in a page, as its script reads them. */
async function pageConfig(url) {
  const response = await fetch(url);
  const page = await response.text();
  const content = /<meta name="cranium-config" content="([^"]*)">/.exec(page)[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  return { response, page, content };
}

/** One tab: its sessionStorage, its address and its history, shared by every script in it. */
function tab(origin, pathname = '/') {
  const stored = new Map();
  const location = { search: '', hash: '#/sign-in', pathname, assigned: null, assign(url) { location.assigned = url; } };
  return {
    stored,
    location,
    history: { replaceState() { location.search = ''; } },
    storage: {
      getItem: (key) => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => stored.set(key, String(value)),
      removeItem: (key) => stored.delete(key),
      clear: () => stored.clear(),
    },
    fetch: (path, init) => fetch(path.startsWith('/') ? `${origin}${path}` : path, init),
  };
}

/** The customer site's two sign-ins in a tab, made as customer.js makes them. */
function signIns(config, browser, clock) {
  const common = { location: browser.location, history: browser.history, fetch: browser.fetch, crypto: webcrypto, now: () => clock.ms };
  return {
    customer: core.createAuth({
      ...common, config: site.authConfig(config, 'customer'), storage: site.namespaced(browser.storage, site.CUSTOMER_PREFIX), newPasswordHere: true,
    }),
    admin: core.createAuth({ ...common, config: site.authConfig(config, 'admin'), storage: site.namespaced(browser.storage, '') }),
  };
}

async function call(origin, token, method, path, body) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

test('one name serves the customer site at / and the console as admin mode at /admin', async (t) => {
  const { origin } = await start(t);
  const home = await pageConfig(`${origin}/`);
  assert.equal(home.response.status, 200);
  const config = site.readSiteConfig(home.content);
  assert.ok(config, home.content);
  assert.equal(config.adminPath, '/admin');
  assert.notEqual(config.customer.userPoolId, config.admin.userPoolId);
  assert.notEqual(config.customer.clientId, config.admin.clientId);
  const policy = home.response.headers.get('content-security-policy');
  assert.match(policy, /require-trusted-types-for 'script'/);
  assert.match(policy, new RegExp(`connect-src 'self' ${config.idpOrigin}(;|$)`));
  assert.match(home.page, /Your DJ controller, without the laptop\./);

  const admin = await pageConfig(`${origin}/admin`);
  const consoleConfig = core.readConfig(admin.content);
  assert.equal(consoleConfig.redirectUri, `${origin}/admin`);
  assert.equal(consoleConfig.customerSite, '/');
  assert.equal(consoleConfig.clientId, config.admin.clientId);
  assert.doesNotMatch(admin.response.headers.get('content-security-policy'), /trusted-types/);
});

test('a customer signs in with the console\'s own SRP code and reads their boards, and nothing of the console', async (t) => {
  const { origin, clock } = await start(t);
  const config = site.readSiteConfig((await pageConfig(`${origin}/`)).content);
  const browser = tab(origin);
  const { customer } = signIns(config, browser, clock);
  assert.deepEqual(await customer.resume(), { status: 'sign-in' });
  assert.deepEqual(await customer.passwordSignIn(ADA, 'not the password'), { step: 'password', problem: 'wrong-password' });
  assert.deepEqual(await customer.passwordSignIn(ADA, PREVIEW_CUSTOMER_PASSWORD), { step: 'done' });
  // Revoked through the user pool API, with no managed login pages: none is kept.
  assert.equal(await customer.revocation(), 'revoked');
  // The session is under the customer's own keys, not the console's.
  assert.deepEqual([...browser.stored.keys()], ['customer:cranium.session']);

  const api = site.createCustomerApi({ auth: customer, fetch: browser.fetch, onUnauthorized: () => assert.fail('refused') });
  const boards = await api.boards();
  assert.deepEqual(boards.map((board) => [board.name, board.status]), [['Living room deck', 'online'], [null, 'offline']]);
  const raw = await call(origin, customer.accessToken(), 'GET', '/api/c/boards');
  for (const word of ['cranium-', 'thing', 'mac', 'heap', 'job']) assert.equal(JSON.stringify(raw.body).includes(word), false, word);
  const detail = await api.board(boards[0].id);
  assert.ok(detail.activity.length > 0);
  assert.deepEqual(await api.me(), { email: ADA, name: 'Ada', boards: 2 });

  // The console's API knows nothing of this token: the gateway's authorizer refuses it.
  for (const path of ['/api/me', '/api/devices', '/api/customers', '/api/audit']) {
    assert.equal((await call(origin, customer.accessToken(), 'GET', path)).status, 401, path);
  }
  assert.equal((await call(origin, customer.accessToken(), 'POST', '/api/deployments', {})).status, 401);
});

test('an admin signs in once on the customer site, and the console under /admin opens without asking again', async (t) => {
  const { origin, clock } = await start(t);
  const config = site.readSiteConfig((await pageConfig(`${origin}/`)).content);
  const browser = tab(origin);
  const { admin } = signIns(config, browser, clock);
  assert.deepEqual(await admin.passwordSignIn(MANAGER, PREVIEW_PASSWORD), { step: 'code' });
  assert.deepEqual(await admin.sendCode(PREVIEW_CODE), { step: 'done' });
  assert.equal(await admin.revocation(), 'revoked');
  const token = admin.accessToken();
  assert.equal((await call(origin, token, 'GET', '/api/me')).body.canWrite, true);
  // A staff token opens nothing of the customer API.
  assert.equal((await call(origin, token, 'GET', '/api/c/boards')).status, 401);

  // Admin mode: the same tab goes to /admin, and the console's own code finds the session there.
  const consoleConfig = core.readConfig((await pageConfig(`${origin}/admin`)).content);
  browser.location.pathname = '/admin';
  browser.location.hash = '#/customers';
  const consoleAuth = core.createAuth({
    config: consoleConfig, storage: browser.storage, location: browser.location, history: browser.history, fetch, crypto: webcrypto,
    now: () => clock.ms,
  });
  assert.deepEqual(await consoleAuth.resume(), { status: 'signed-in', route: null });
  assert.equal(consoleAuth.accessToken(), token);
  const customers = await call(origin, consoleAuth.accessToken(), 'GET', '/api/customers');
  assert.deepEqual(customers.body.customers.map((customer) => [customer.email, customer.status]),
    [[ADA, 'active'], ['ben@preview.invalid', 'active'], [CLEO, 'invited']]);
  assert.equal(customers.body.siteUrl, `${origin}/`);
  // Leaving admin mode and signing out there ends it in the tab, at the console's managed sign-out.
  consoleAuth.signOut();
  assert.match(browser.location.assigned, /\/logout\?client_id=.*logout_uri=.*%2Fadmin$/);
  assert.equal(browser.stored.get('cranium.session'), undefined);
});

test('an invited customer chooses a password on the site\'s own page, and the console then shows them active', async (t) => {
  const { origin, clock } = await start(t);
  const config = site.readSiteConfig((await pageConfig(`${origin}/`)).content);
  const { customer } = signIns(config, tab(origin), clock);
  assert.deepEqual(await customer.passwordSignIn(CLEO, PREVIEW_TEMPORARY_PASSWORD), { step: 'new-password' });
  assert.deepEqual(await customer.sendNewPassword('too short'), { step: 'new-password', problem: 'weak-password' });
  assert.deepEqual(await customer.sendNewPassword('a long one of her own'), { step: 'done' });
  assert.deepEqual((await call(origin, customer.accessToken(), 'GET', '/api/c/boards')).body.boards, []);

  const staff = signIns(config, tab(origin), clock).admin;
  await staff.passwordSignIn(MANAGER, PREVIEW_PASSWORD);
  await staff.sendCode(PREVIEW_CODE);
  const listed = await call(origin, staff.accessToken(), 'GET', '/api/customers');
  assert.equal(listed.body.customers.find((item) => item.email === CLEO).status, 'active');
});

test('a release manager gives a board and takes it back; the customer sees it come and go; all on record', async (t) => {
  const { origin, clock, preview } = await start(t);
  const config = site.readSiteConfig((await pageConfig(`${origin}/`)).content);
  const staff = signIns(config, tab(origin), clock).admin;
  await staff.passwordSignIn(MANAGER, PREVIEW_PASSWORD);
  await staff.sendCode(PREVIEW_CODE);
  const { customer } = signIns(config, tab(origin), clock);
  await customer.passwordSignIn('ben@preview.invalid', PREVIEW_CUSTOMER_PASSWORD);
  const benBoards = async () => (await call(origin, customer.accessToken(), 'GET', '/api/c/boards')).body.boards;
  assert.equal((await benBoards()).length, 1);

  const listed = (await call(origin, staff.accessToken(), 'GET', '/api/customers')).body.customers;
  const ben = listed.find((item) => item.email === 'ben@preview.invalid');
  const owned = new Set(listed.flatMap((item) => item.boards.map((board) => board.thing)));
  const free = preview.boards.map((board) => board.thing).find((thing) => !owned.has(thing));
  const given = await call(origin, staff.accessToken(), 'POST', `/api/customers/${ben.id}/boards`, { thing: free, label: 'Spare' });
  assert.equal(given.status, 200);
  const now = await benBoards();
  assert.deepEqual(now.map((board) => board.name).sort(), ['Spare', 'Studio']);
  const spare = now.find((board) => board.name === 'Spare');

  assert.equal((await call(origin, staff.accessToken(), 'POST', `/api/customers/${ben.id}/boards/${free}/remove`, {})).status, 200);
  assert.deepEqual((await benBoards()).map((board) => board.name), ['Studio']);
  assert.equal((await call(origin, customer.accessToken(), 'GET', `/api/c/boards/${spare.id}`)).status, 404);

  const log = (await call(origin, staff.accessToken(), 'GET', '/api/audit?limit=20')).body.entries.map((entry) => entry.action);
  assert.deepEqual(log.slice(0, 2), ['customer.unassign', 'customer.assign']);
  assert.ok(log.includes('customer.create'));
});

test('a forgotten password is reset with the code from the e-mail, and an authenticator app adds the six boxes', async (t) => {
  const { origin, clock, preview } = await start(t);
  const config = site.readSiteConfig((await pageConfig(`${origin}/`)).content);
  const browser = tab(origin);
  const account = site.createAccount({ fetch: browser.fetch, site: config, accessToken: () => null });
  assert.deepEqual(await account.forgotPassword(ADA), { ok: true });
  // The same answer for an address with no account.
  assert.deepEqual(await account.forgotPassword('nobody@preview.invalid'), { ok: true });
  // An unused invitation has no password to reset yet.
  assert.deepEqual(await account.forgotPassword(CLEO), { ok: false, problem: 'not-yet' });
  assert.deepEqual(await account.confirmForgotPassword(ADA, '000000', 'her new password'), { ok: false, problem: 'wrong-code' });
  assert.deepEqual(await account.confirmForgotPassword(ADA, '135790', 'her new password'), { ok: true });

  const { customer } = signIns(config, browser, clock);
  assert.deepEqual(await customer.passwordSignIn(ADA, PREVIEW_CUSTOMER_PASSWORD), { step: 'password', problem: 'wrong-password' });
  assert.deepEqual(await customer.passwordSignIn(ADA, 'her new password'), { step: 'done' });

  const mine = site.createAccount({ fetch: browser.fetch, site: config, accessToken: () => customer.accessToken() });
  assert.deepEqual(await mine.profile(), { ok: true, email: ADA, name: 'Ada', authenticator: false });
  const started = await mine.startAuthenticator();
  assert.equal(started.ok, true);
  assert.match(site.otpauthUri(started.secret, ADA), /^otpauth:\/\/totp\/Cranium%3Aada%40preview\.invalid\?secret=[A-Z2-7]+&issuer=Cranium$/);
  assert.deepEqual(await mine.confirmAuthenticator('000000'), { ok: false, problem: 'wrong-code' });
  assert.deepEqual(await mine.confirmAuthenticator(PREVIEW_CODE), { ok: true });
  assert.equal((await mine.profile()).authenticator, true);
  assert.equal(preview.customerPool.authenticatorOn(preview.customers.directory().find(ADA).sub), true);
  assert.deepEqual(await mine.changePassword('wrong', 'another long one'), { ok: false, problem: 'wrong-password' });
  assert.deepEqual(await mine.changePassword('her new password', 'another long one'), { ok: true });

  // From now on the sign-in asks for the code, in the same six boxes as the console's.
  const again = signIns(config, tab(origin), clock).customer;
  assert.deepEqual(await again.passwordSignIn(ADA, 'another long one'), { step: 'code' });
  assert.deepEqual(await again.sendCode('999999'), { step: 'code', problem: 'wrong-code' });
  assert.deepEqual(await again.sendCode(PREVIEW_CODE), { step: 'done' });
  assert.deepEqual(await mine.stopAuthenticator(), { ok: true });
  assert.equal((await mine.profile()).authenticator, false);
});
