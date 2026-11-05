/**
 * Tests for the customer site (docs/customer-site.md): how the web function serves it and admin
 * mode on its names, the files it is made of, the site's own logic (customer-core.js), the parts
 * of the console's sign-in it now uses (createAuth without managed login pages, and a first
 * sign-in's new password on the page), and the site itself, customer.js, started in a stand-in for
 * a browser tab, the way app.test.mjs starts the console.
 *
 * Cognito's side is cognito.mjs (the staff pool) and customer-cognito.mjs (the customer pool),
 * both written apart from core.js.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SHARED_ASSETS, customerPolicy, loadCustomerSite } from '../src/customer-site.mjs';
import { createWebHandler, handler } from '../src/server.mjs';
import { createCognito } from './cognito.mjs';
import { createCustomerCognito } from './customer-cognito.mjs';
import { BRIDGE, CORE, VIEWS, all, click, createDocument, descendants, one, scriptAddress, textOf } from './page.mjs';

const core = await import(CORE);

const CUSTOMER_DIR = new URL('../src/customer/', import.meta.url);
const SITE_DIR = new URL('../src/site/', import.meta.url);

/**
 * One of the customer site's scripts as a module Node can import, its imports pointed at the given
 * addresses: written out as a file of this run, as page.mjs does the console's.
 */
function customerScript(name, imports = {}, mark = '') {
  return scriptAddress(name, imports, mark, new URL('assets/', CUSTOMER_DIR));
}

const SITE_CORE = customerScript('customer-core.js', { 'core.js': CORE });
const SITE_VIEWS = customerScript('customer-views.js', { 'core.js': CORE, 'views.js': VIEWS, 'customer-core.js': SITE_CORE });
const site = await import(SITE_CORE);

const STAFF_POOL = 'xx-test-1_Staff0Pool';
const CUSTOMER_POOL = 'xx-test-1_Customer0Pool';
const IDP = 'https://idp.example';
const HOME = 'https://cranium.example/';
const SITE_CONFIG = {
  customer: { clientId: 'customerclient', userPoolId: CUSTOMER_POOL },
  admin: { clientId: 'staffclient', userPoolId: STAFF_POOL },
  idpOrigin: IDP,
  home: HOME,
  adminPath: '/admin',
};

// The web function.

function webHandler(extra = {}) {
  return createWebHandler({
    clientId: 'staffclient', loginOrigin: 'https://login.example', scope: 'openid cranium/console', userPoolId: 'us-east-1_staff',
    customer: { hosts: ['cranium.example', 'www.cranium.example'], userPoolId: 'us-east-1_customers', clientId: 'customerclient' },
    log: () => {},
    ...extra,
  });
}

const request = (host, path, method = 'GET') => ({ rawPath: path, requestContext: { domainName: host, http: { method }, requestId: 'r' } });
const metaOf = (body) => JSON.parse(/<meta name="cranium-config" content="([^"]*)">/.exec(body)[1].replaceAll('&quot;', '"'));

test('the customer site\'s name gets the site at /, the console as admin mode at /admin, and the files of both', async () => {
  const web = webHandler();
  const home = await web(request('cranium.example', '/'));
  assert.equal(home.statusCode, 200);
  assert.deepEqual(metaOf(home.body), {
    customer: { clientId: 'customerclient', userPoolId: 'us-east-1_customers' },
    admin: { clientId: 'staffclient', userPoolId: 'us-east-1_staff' },
    idpOrigin: 'https://cognito-idp.us-east-1.amazonaws.com',
    home: 'https://cranium.example/',
    adminPath: '/admin',
  });
  const files = [...home.body.matchAll(/"(\/assets\/[0-9a-f]{12}\/[a-z.-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(files.map((path) => path.split('/').pop()).sort(),
    ['app.css', 'core.js', 'customer-core.js', 'customer-views.js', 'customer.css', 'customer.js', 'views.js']);
  for (const path of files) {
    const asset = await web(request('cranium.example', path));
    assert.equal(asset.statusCode, 200, path);
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
  }

  const admin = await web(request('cranium.example', '/admin'));
  assert.equal(admin.statusCode, 200);
  const config = metaOf(admin.body);
  assert.equal(config.redirectUri, 'https://cranium.example/admin');
  assert.equal(config.customerSite, '/');
  assert.equal(core.readConfig(JSON.stringify(config)).customerSite, '/');
  for (const [, path] of admin.body.matchAll(/"(\/assets\/[0-9a-f]{12}\/[a-z.]+)"/g)) {
    assert.equal((await web(request('cranium.example', path))).statusCode, 200, path);
  }
  // Nothing else, and only GET.
  assert.equal((await web(request('cranium.example', '/admin/'))).statusCode, 404);
  assert.equal((await web(request('cranium.example', '/index.html'))).statusCode, 404);
  assert.equal((await web(request('cranium.example', '/', 'POST'))).statusCode, 405);
});

test('www., and any other name of the site, sends the browser to the one name', async () => {
  const web = webHandler();
  for (const [path, to] of [['/', '/'], ['/admin', '/admin'], ['/assets/x/app.css', '/'], ['/anything', '/']]) {
    const moved = await web(request('www.cranium.example', path));
    assert.deepEqual([moved.statusCode, moved.headers.location], [308, `https://cranium.example${to}`], path);
  }
});

test('the site\'s policy: its own origin and Cognito\'s user pool API, no inline code, Trusted Types, no serial port', async () => {
  const web = webHandler();
  const home = await web(request('cranium.example', '/'));
  const policy = home.headers['content-security-policy'];
  assert.equal(policy, customerPolicy('https://cognito-idp.us-east-1.amazonaws.com').join('; '));
  assert.match(policy, /script-src 'self';/);
  assert.match(policy, /connect-src 'self' https:\/\/cognito-idp\.us-east-1\.amazonaws\.com;/);
  assert.match(policy, /require-trusted-types-for 'script'; trusted-types 'none'$/);
  assert.doesNotMatch(policy, /unsafe|login\.example|\*/);
  assert.match(home.headers['permissions-policy'], /serial=\(\)/);
  assert.equal(home.headers['x-content-type-options'], 'nosniff');
  assert.equal(home.headers['referrer-policy'], 'no-referrer');
  assert.match(home.headers['strict-transport-security'], /max-age=63072000/);
  // Admin mode keeps the console's own policy, with its managed login pages and its serial port.
  const admin = await web(request('cranium.example', '/admin'));
  assert.match(admin.headers['content-security-policy'], /connect-src 'self' https:\/\/login\.example https:\/\/cognito-idp/);
  assert.match(admin.headers['permissions-policy'], /serial=\(self\)/);
});

test('every other name gets what it got before: the console, and the home page where it is set', async () => {
  const before = createWebHandler({
    clientId: 'staffclient', loginOrigin: 'https://login.example', scope: 'openid cranium/console', userPoolId: 'us-east-1_staff',
    homeHosts: ['home.example'], log: () => {},
  });
  const after = webHandler({ homeHosts: ['home.example'] });
  for (const [host, path] of [['console.example', '/'], ['home.example', '/'], ['console.example', '/admin'], ['home.example', '/admin']]) {
    const [a, b] = [await before(request(host, path)), await after(request(host, path))];
    assert.deepEqual([b.statusCode, b.headers, b.body], [a.statusCode, a.headers, a.body], `${host}${path}`);
  }
});

test('the customer site\'s settings are checked when the function starts', () => {
  const base = { clientId: 'c', loginOrigin: 'https://login.example', scope: 's', userPoolId: 'us-east-1_staff', log: () => {} };
  const customer = { hosts: ['cranium.example'], userPoolId: 'us-east-1_customers', clientId: 'cc' };
  assert.throws(() => createWebHandler({ ...base, customer: { ...customer, userPoolId: 'eu-west-1_customers' } }), /Region/);
  assert.throws(() => createWebHandler({ ...base, customer: { ...customer, hosts: [] } }), /hosts/);
  assert.throws(() => createWebHandler({ ...base, customer: { ...customer, hosts: ['Cranium.example'] } }), /hosts/);
  assert.throws(() => createWebHandler({ ...base, customer: { ...customer, clientId: '' } }), /clientId/);
  assert.throws(() => createWebHandler({ ...base, homeHosts: ['cranium.example'], customer }), /home page and the customer site/);
});

test('deployed, the names and the customer pool come from the function\'s environment', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    USER_POOL_CLIENT_ID: 'staffclient', LOGIN_DOMAIN: 'login.example', OAUTH_SCOPE: 'openid cranium/console',
    USER_POOL_ID: 'us-east-1_staff', CUSTOMER_HOSTS: 'cranium.example,www.cranium.example',
    CUSTOMER_POOL_ID: 'us-east-1_customers', CUSTOMER_CLIENT_ID: 'customerclient',
  });
  try {
    const home = await handler(request('cranium.example', '/'));
    assert.equal(metaOf(home.body).customer.clientId, 'customerclient');
    assert.equal((await handler(request('www.cranium.example', '/'))).statusCode, 308);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});

// The files of the site.

const page = readFileSync(new URL('index.html', CUSTOMER_DIR), 'utf8');
const ownAssets = readdirSync(new URL('assets/', CUSTOMER_DIR)).filter((name) => !name.startsWith('.')).sort();
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

test('the site serves the console\'s own core.js, views.js and app.css, byte for byte: nothing to drift', () => {
  const loaded = loadCustomerSite(CUSTOMER_DIR, SITE_DIR);
  for (const name of SHARED_ASSETS) {
    const served = loaded.assets.get(`/assets/${loaded.buildId}/${name}`);
    assert.equal(served.body, readFileSync(new URL(`assets/${name}`, SITE_DIR), 'utf8'), name);
  }
  assert.deepEqual(ownAssets, ['customer-core.js', 'customer-views.js', 'customer.css', 'customer.js']);
  // No copy of the sign-in: the site's scripts have no SRP of their own.
  for (const name of ownAssets.filter((file) => file.endsWith('.js'))) {
    const source = code(readFileSync(new URL(`assets/${name}`, CUSTOMER_DIR), 'utf8'));
    assert.doesNotMatch(source, /SRP_A|PASSWORD_VERIFIER|modPow|Caldera/, name);
  }
});

test('the page has no inline script, style or handler, and refers only to its own files', () => {
  assert.doesNotMatch(page, /<style[\s>]|\sstyle\s*=|\son[a-z]+\s*=|javascript:/i);
  for (const match of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(match[1], /\ssrc="/);
    assert.equal(match[2].trim(), '');
  }
  const fetched = [...page.matchAll(/\s(?:href|src)="([^"#][^"]*)"/g)].map((match) => match[1])
    .filter((reference) => !reference.startsWith('data:') && !reference.startsWith('https://github.com/'));
  assert.deepEqual([...new Set(fetched)].sort(), ['app.css', 'core.js', 'customer-core.js', 'customer-views.js', 'customer.css',
    'customer.js', 'views.js'].map((name) => `/assets/%BUILD%/${name}`).sort());
  assert.equal((page.match(/%CONFIG%/g) ?? []).length, 1);
  assert.match(page, /<noscript>[\s\S]+<\/noscript>/);
  // No CDN, no font, no image to fetch.
  assert.doesNotMatch(page, /cdn|googleapis|\.woff|\.png|\.jpg/i);
});

test('the site\'s scripts never write markup or run text as code, and hold no e-mail address', () => {
  for (const name of ownAssets) {
    const source = readFileSync(new URL(`assets/${name}`, CUSTOMER_DIR), 'utf8');
    for (const pattern of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\b/,
      /DOMParser|setHTML|createContextualFragment/, /set(?:Timeout|Interval)\s*\(\s*['"`]/]) {
      assert.doesNotMatch(code(source), pattern, `${name}: ${pattern}`);
    }
    assert.doesNotMatch(source, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, name);
  }
  assert.doesNotMatch(page, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
});

test('the home page says what is built and what is not, and promises nothing more', () => {
  const words = page.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const fact of ['In development', 'there is no sign-up', 'every 30 seconds', '5 minutes', 'Not built yet', 'tested on one board']) {
    assert.ok(words.includes(fact), fact);
  }
  assert.equal((words.match(/Not built yet/g) ?? []).length, 5);
  for (const claim of [/for sale/i, /buy/i, /price/i, /\bfree\b/i, /guarantee/i]) assert.doesNotMatch(words, claim);
});

// The console's activity log, for the Customers page's entries. The phone apps keep the same examples
// (apps/android AuditParityTest, apps/ios ParityTests).

test('the Customers page\'s entries read as sentences: a customer by address, a board then whose it is', () => {
  const SUB = '7ec17d2e-9ee4-4734-8901-33c8fec73372';
  const THING = 'cranium-fe5b26c0c5b1dcd7';
  const actor = { sub: 's', email: 'a@b' };
  const entry = (action, target, outcome, detail) => ({ at: '2026-11-04T12:00:00Z', actor, action, target, outcome, detail, requestId: '' });
  const facts = (described) => described.facts.map((fact) => [fact.label, fact.value]);
  const email = ['email', 'ada@example.invalid'];

  assert.equal(core.auditSentence(entry('customer.create', SUB, 'ok', [email])), 'a@b invited the customer ada@example.invalid');
  assert.deepEqual(facts(core.describeAudit(entry('customer.create', SUB, 'ok', [email]))), []);
  assert.equal(core.auditSentence(entry('customer.create', '', 'rejected', [email, ['code', 'customer_exists']])),
    'a@b tried to invite the customer ada@example.invalid');
  const given = entry('customer.assign', THING, 'ok', [['customer', SUB], email, ['label', 'Deck']]);
  assert.equal(core.auditSentence(given), `a@b gave ${THING} to ada@example.invalid`);
  assert.deepEqual(facts(core.describeAudit(given)), [['Customer', SUB], ['Called', 'Deck']]);
  assert.equal(core.describeAudit(given).thing, THING);
  assert.equal(core.auditSentence(entry('customer.unassign', THING, 'ok', [['customer', SUB]])), `a@b took ${THING} back from a customer`);
  assert.equal(core.auditSentence(entry('customer.assign', '', 'denied', [['code', 'release_manager_required']])),
    'a@b tried to give a board to a customer');
  assert.equal(core.auditSentence(entry('customer.resend', '', 'ok', [])), 'a@b sent an invitation again');
  assert.equal(core.auditSentence(entry('customer.disable', SUB, 'ok', [email])), 'a@b switched off the customer account of ada@example.invalid');
  assert.equal(core.auditSentence(entry('customer.enable', '', 'denied', [])), 'a@b tried to switch on a customer account');
  assert.equal(core.describeAudit(entry('customer.assign', THING, 'rejected', [['code', 'board_taken']])).facts[0].words,
    'That board belongs to another customer');
});

// The site's logic.

test('routes: the pages of the site, a board by its assignment id, and nothing else', () => {
  assert.deepEqual(site.parseRoute(''), { view: 'landing' });
  assert.deepEqual(site.parseRoute('#/'), { view: 'landing' });
  assert.deepEqual(site.parseRoute('#/overview'), { view: 'overview' });
  assert.deepEqual(site.parseRoute('#/devices/0123456789abcdef'), { view: 'device', id: '0123456789abcdef' });
  assert.deepEqual(site.parseRoute('#/mixes/library'), { view: 'mixes', tab: 'library' });
  for (const hash of ['#/devices/cranium-0123456789abcdef', '#/mixes/other', '#/firmware', '#how', '#/devices/ABC', '#/overview/x']) {
    assert.equal(site.parseRoute(hash), null, hash);
  }
  assert.equal(site.routeHash({ view: 'device', id: '0123456789abcdef' }), '#/devices/0123456789abcdef');
  assert.equal(site.routeHash({ view: 'device', id: 'cranium-x' }), '#/');
  assert.equal(site.routeHash({ view: 'nowhere' }), '#/');
  assert.deepEqual([...site.PUBLIC_VIEWS], ['landing', 'sign-in', 'forgot', 'admin-sign-in', 'help']);
});

test('the settings in the page are read with care, and each sign-in gets its own pool and no managed login', () => {
  const config = site.readSiteConfig(JSON.stringify(SITE_CONFIG));
  assert.deepEqual(config, SITE_CONFIG);
  for (const broken of [{ ...SITE_CONFIG, home: 'https://cranium.example/x' }, { ...SITE_CONFIG, idpOrigin: 'javascript:x' },
    { ...SITE_CONFIG, adminPath: '/console' }, { ...SITE_CONFIG, customer: { clientId: 'c' } }]) {
    assert.equal(site.readSiteConfig(JSON.stringify(broken)), null);
  }
  assert.equal(site.readSiteConfig('not json'), null);
  assert.deepEqual(site.authConfig(config, 'customer'), {
    clientId: 'customerclient', userPoolId: CUSTOMER_POOL, idpOrigin: IDP, redirectUri: HOME, scope: '', loginOrigin: '',
  });
  assert.equal(site.authConfig(config, 'admin').clientId, 'staffclient');
});

test('a customer\'s keys are their own: clearing them leaves the admin\'s session, which the console reads', () => {
  const stored = new Map([['cranium.session', 'admin'], ['other', 'x']]);
  const storage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) };
  const mine = site.namespaced(storage, site.CUSTOMER_PREFIX);
  mine.setItem('cranium.session', 'customer');
  mine.setItem('cranium.signedout', '1');
  assert.equal(mine.getItem('cranium.session'), 'customer');
  mine.clear();
  assert.deepEqual([...stored], [['cranium.session', 'admin'], ['other', 'x']]);
  const theirs = site.namespaced(storage, '');
  theirs.clear();
  assert.deepEqual([...stored], [['other', 'x']]);
});

const BOARD = {
  id: '0123456789abcdef', name: 'Living room deck', boardName: 'CRADA01', status: 'online', online: true,
  lastSeen: '2026-11-04T11:59:40.000Z', firmware: { version: '1.11.2+0', confirmed: true },
  update: { state: 'idle', progress: 0, last: 'succeeded' }, rssi: -58, uptime: 600, location: null, since: '2026-11-01T10:00:00.000Z',
};

test('a board is read into a known shape, and anything else from the API is left out', () => {
  assert.deepEqual(site.readBoard(BOARD), BOARD);
  assert.equal(site.readBoard({ ...BOARD, id: 'cranium-0123456789abcdef' }), null);
  assert.equal(site.readBoard({ ...BOARD, status: 'hacked' }), null);
  const odd = site.readBoard({ ...BOARD, name: 'Deck\u0000‮<b>', firmware: { version: '1.2' }, rssi: 5, thing: 'cranium-x', mac: 'aa' });
  assert.deepEqual([odd.name, odd.firmware, odd.rssi, Object.hasOwn(odd, 'thing'), Object.hasOwn(odd, 'mac')],
    ['Deck<b>', null, null, false, false]);
  assert.equal(site.readEvent({ at: BOARD.lastSeen, board: BOARD.id, kind: 'health', what: 'memory' }), null);
  assert.deepEqual(site.readEvent({ at: BOARD.lastSeen, board: BOARD.id, kind: 'firmware', what: 'changed', version: '1.11.3+0', from: '1.11.2+0', confirmed: false, text: 'x' }),
    { at: BOARD.lastSeen, board: BOARD.id, kind: 'firmware', what: 'changed', version: '1.11.3+0', from: '1.11.2+0', confirmed: false });
});

test('what a board is doing, in plain words, for every state and every result', () => {
  const now = Date.parse('2026-11-04T12:00:00.000Z');
  assert.deepEqual(site.statusWords(BOARD, now), { tone: 'good', icon: 'online', label: 'Online', text: 'Connected, and reporting every 30 seconds.' });
  assert.match(site.statusWords({ ...BOARD, status: 'offline', online: false }, now).text, /^Last heard from 20 s ago\./);
  assert.equal(site.statusWords({ ...BOARD, status: 'new', lastSeen: null }, now).label, 'Not heard from yet');
  const update = (changes) => site.updateWords({ ...BOARD, update: { ...BOARD.update, ...changes } });
  assert.equal(update({ state: 'downloading', progress: 40 }), 'Downloading an update: 40% so far.');
  assert.match(update({ state: 'awaiting_user' }), /press Button 1/);
  assert.match(update({ state: 'testing' }), /within 5 minutes/);
  for (const last of ['succeeded', 'failed', 'rolled_back', 'declined', 'refused', 'cancelled', 'none']) {
    assert.ok(update({ last }), last);
  }
  assert.equal(site.updateWords({ ...BOARD, update: null }), null);
  assert.equal(site.shortVersion('1.11.2+0'), '1.11.2');
  assert.equal(site.shortVersion('1.11.2+3'), '1.11.2, build 3');
  assert.equal(site.boardTitle({ ...BOARD, name: null }), 'Your Cranium');
  assert.equal(site.onlineWords(site.summarize([BOARD, { ...BOARD, online: false }])), '1 of 2 online');
  for (const [kind, what, extra] of [['connection', 'connected'], ['connection', 'disconnected'], ['firmware', 'reported', { version: '1.0.0+0' }],
    ['firmware', 'changed', { version: '1.1.0+0', from: '1.0.0+0' }], ['firmware', 'confirmed', {}], ['update', 'step', { state: 'downloading' }],
    ['update', 'step', { state: 'awaiting_user' }], ['update', 'result', { result: 'rolled_back' }], ['restart', 'restarted'], ['restart', 'stuck'],
    ['bluetooth', 'opened'], ['bluetooth', 'closed'], ['bluetooth', 'record', { result: 'succeeded', to: '1.2.0+0' }]]) {
    const words = site.eventWords({ kind, what, ...extra });
    assert.notEqual(words.text, 'Something changed', `${kind} ${what}`);
    assert.doesNotMatch(words.text, /AWS|IoT|job|cranium-/, `${kind} ${what}`);
  }
});

test('passwords of at least 10 characters, a setup key people can copy, and an address that opens an authenticator', () => {
  assert.equal(site.passwordProblem('short', 'short'), 'too-short');
  assert.equal(site.passwordProblem('long enough', 'long enougj'), 'mismatch');
  assert.equal(site.passwordProblem('long enough', 'long enough'), null);
  assert.equal(site.groupSecret('ABCDEFGHIJKLMNOP'), 'ABCD EFGH IJKL MNOP');
  assert.equal(site.groupSecret('not a secret'), '');
  assert.equal(site.otpauthUri('ABCDEFGHIJKLMNOP', 'ada@example.invalid'),
    'otpauth://totp/Cranium%3Aada%40example.invalid?secret=ABCDEFGHIJKLMNOP&issuer=Cranium');
  assert.equal(site.otpauthUri('javascript:alert(1)', 'x'), null);
  assert.equal(site.accountProblem('NotAuthorizedException', 'change'), 'wrong-password');
  assert.equal(site.accountProblem('NotAuthorizedException', 'forgot'), 'not-yet');
  assert.equal(site.accountProblem('CodeMismatchException'), 'wrong-code');
  assert.equal(site.accountProblem('Whatever'), 'failed');
  for (const words of Object.values(site.ACCOUNT_WORDS)) assert.match(words, /\.$/);
});

test('the customer API\'s client sends the customer\'s token, and a refusal ends the session', async () => {
  let token = 'CUSTOMER-TOKEN';
  let refused = 0;
  const sent = [];
  const auth = { accessToken: () => token, tokenRefused: () => { token = null; } };
  const api = site.createCustomerApi({
    auth,
    onUnauthorized: () => { refused += 1; },
    async fetch(path, init) {
      sent.push([path, init.headers.authorization, init.credentials]);
      if (path === '/api/c/boards') return Response.json({ boards: [BOARD, { id: 'bad' }] });
      return Response.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 });
    },
  });
  assert.deepEqual(await api.boards(), [BOARD]);
  assert.deepEqual(sent, [['/api/c/boards', 'Bearer CUSTOMER-TOKEN', 'omit']]);
  await assert.rejects(api.me(), (error) => error.status === 401);
  assert.equal(refused, 1);
  assert.equal(token, null);
  await assert.rejects(api.board('cranium-0123456789abcdef'), (error) => error.status === 404);
  assert.equal(sent.length, 2, 'a board that is not an id is never asked for');
});

// What the console's sign-in code does for the customer site.

const NOW = Date.parse('2026-11-04T12:00:00.000Z');

function customerWorld({ status = 'CONFIRMED', authenticator = false } = {}) {
  const accounts = new Map([['5d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6',
    { sub: '5d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6', email: 'ada@example.invalid', name: 'Ada', enabled: true, status }]]);
  const directory = {
    find: (email) => [...accounts.values()].find((account) => account.email === email) ?? null,
    bySub: (sub) => accounts.get(sub) ?? null,
    confirm: (sub) => { accounts.get(sub).status = 'CONFIRMED'; },
  };
  const cognito = createCustomerCognito({ userPoolId: CUSTOMER_POOL, clientId: 'customerclient', directory, now: () => NOW });
  cognito.addCredentials({ sub: '5d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6', password: 'her own password', code: '246810', authenticator });
  return { cognito, accounts };
}

function authFor(cognito, { newPasswordHere = true, stored = new Map() } = {}) {
  const location = { search: '', hash: '#/sign-in', pathname: '/', assigned: null, assign(url) { location.assigned = url; } };
  const auth = core.createAuth({
    config: site.authConfig(SITE_CONFIG, 'customer'),
    storage: site.namespaced({ getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) }, 'customer:'),
    location,
    history: { replaceState() {} },
    fetch: (url, init) => cognito.fetch(IDP, url, init),
    crypto: globalThis.crypto,
    now: () => NOW,
    newPasswordHere,
  });
  return { auth, location, stored };
}

test('with no managed login pages, the refresh token is revoked through the user pool API and a sign-out comes home', async () => {
  const { cognito } = customerWorld();
  const { auth, location, stored } = authFor(cognito);
  assert.deepEqual(await auth.passwordSignIn('Ada@Example.invalid', 'her own password'), { step: 'done' });
  assert.equal(await auth.revocation(), 'revoked');
  assert.equal(cognito.refreshTokensLeft(), 0);
  const revoke = cognito.calls.find((call) => call.operation === 'RevokeToken');
  assert.deepEqual(Object.keys(revoke.body).sort(), ['ClientId', 'Token']);
  assert.ok(stored.has('customer:cranium.session'));
  auth.signOut();
  assert.equal(location.assigned, HOME);
  assert.deepEqual([...stored.keys()], ['customer:cranium.signedout']);
  // SRP: the password is never sent.
  for (const call of cognito.calls) assert.equal(JSON.stringify(call.body).includes('her own password'), false);
});

test('a first sign-in chooses its password on the page; the console, which does not ask for it, leaves it elsewhere', async () => {
  const { cognito, accounts } = customerWorld({ status: 'FORCE_CHANGE_PASSWORD' });
  const { auth } = authFor(cognito);
  assert.deepEqual(await auth.passwordSignIn('ada@example.invalid', 'her own password'), { step: 'new-password' });
  assert.deepEqual(await auth.sendCode('123456'), { step: 'password', problem: 'expired' });
  assert.deepEqual(await auth.passwordSignIn('ada@example.invalid', 'her own password'), { step: 'new-password' });
  assert.deepEqual(await auth.sendNewPassword(''), { step: 'new-password', problem: 'missing-new' });
  assert.deepEqual(await auth.sendNewPassword('too short'), { step: 'new-password', problem: 'weak-password' });
  assert.deepEqual(await auth.sendNewPassword('a long one of her own'), { step: 'done' });
  assert.equal(accounts.get('5d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6').status, 'CONFIRMED');
  assert.deepEqual(await auth.sendNewPassword('again and again'), { step: 'password', problem: 'expired' });

  const second = customerWorld({ status: 'FORCE_CHANGE_PASSWORD' });
  const asConsole = authFor(second.cognito, { newPasswordHere: false }).auth;
  assert.deepEqual(await asConsole.passwordSignIn('ada@example.invalid', 'her own password'),
    { step: 'elsewhere', challenge: 'NEW_PASSWORD_REQUIRED' });
  assert.deepEqual(await asConsole.sendNewPassword('a long one of her own'), { step: 'password', problem: 'expired' });
  assert.equal(core.SIGN_IN_WORDS['weak-password'], 'That password is not accepted. Choose one of at least 10 characters.');
});

test('a customer with an authenticator app gives the code in the same step as the console\'s', async () => {
  const { cognito } = customerWorld({ authenticator: true });
  const { auth } = authFor(cognito);
  assert.deepEqual(await auth.passwordSignIn('ada@example.invalid', 'her own password'), { step: 'code' });
  assert.deepEqual(await auth.sendCode('111111'), { step: 'code', problem: 'wrong-code' });
  assert.deepEqual(await auth.sendCode('246810'), { step: 'done' });
});

// The site in a tab.

const realTimeout = globalThis.setTimeout;
const pause = (ms) => new Promise((resolve) => realTimeout(resolve, ms));

async function settle() {
  for (let round = 0; round < 4; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function until(check, what) {
  for (let waited = 0; waited < 8000; waited += 4) {
    await settle();
    if (check()) return;
    await pause(4);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const STAFF = { email: 'manager@example.invalid', userId: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d', password: 'Only-For-Tests-7', code: '135790' };
let copies = 0;

// In the phone app (docs/mobile-apps.md, "The app shell"): the customer API and the console at their own
// addresses, and Cognito's user pool API of the pools' Region.
const APP_CUSTOMER_API = 'https://cranium.example';
const APP_CONSOLE = 'https://console.example';
const APP_IDP = 'https://cognito-idp.xx-test-1.amazonaws.com';
const APP_CONFIG = {
  consoleUrl: APP_CONSOLE, region: 'xx-test-1', userPoolId: STAFF_POOL, mobileClientId: 'staffclient', customerApiUrl: APP_CUSTOMER_API,
  customerRegion: 'xx-test-1', customerUserPoolId: CUSTOMER_POOL, customerClientId: 'customerclient', example: false,
};

/**
 * The customer site, started in a stand-in for a tab, with both pools and the customer API behind it.
 * With `app`, the tab is the iPhone app's, with a stand-in for its bridge: answers by method.
 */
async function openSite(t, { hash = '', status = 'CONFIRMED', app: phone = null } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const { cognito: customers, accounts } = customerWorld({ status });
  const staff = createCognito({
    userPoolId: STAFF_POOL, clientId: 'staffclient', users: [{ ...STAFF, groups: ['release-managers'] }], now: () => NOW,
    issue: () => ({ AccessToken: 'STAFF-TOKEN', ExpiresIn: 3600, RefreshToken: 'STAFF-REFRESH', IdToken: 'ID' }),
  });
  const document = createDocument(['skip', 'landing', 'app', 'toasts', 'announcer']);
  document.getElementById('app').hidden = true;
  document.visibilityState = 'visible';
  document.querySelector = (selector) => (selector === 'meta[name="cranium-config"]' ? { content: JSON.stringify(SITE_CONFIG) } : null);
  const stored = new Map();
  const sessionStorage = {
    getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)), removeItem: (key) => stored.delete(key),
    clear: () => stored.clear(),
  };
  const listeners = new Map();
  let address = hash;
  const navigations = [];
  const location = {
    pathname: '/',
    search: '',
    // The app's origin, in the app (bridge.json "origins"); the site's own reads none.
    ...(phone ? { origin: 'cranium-app://bundle' } : {}),
    get hash() { return address; },
    set hash(value) {
      address = value;
      for (const listener of [...listeners.get('hashchange') ?? []]) listener({ type: 'hashchange' });
    },
    assign: (url) => navigations.push(url),
  };
  const requests = [];
  const addresses = [];
  async function fetch(address, init = {}) {
    addresses.push(address);
    let url = address;
    if (phone) {
      if (address === `${APP_IDP}/`) url = `${IDP}/`;
      else if (address.startsWith(`${APP_CUSTOMER_API}/api/c/`)) url = address.slice(APP_CUSTOMER_API.length);
      else if (address.startsWith(`${APP_CONSOLE}/api/`)) url = address.slice(APP_CONSOLE.length);
    }
    requests.push(`${init.method ?? 'GET'} ${url}`);
    if (url === `${IDP}/`) {
      const body = JSON.parse(init.body);
      const target = init.headers['x-amz-target'].split('.').pop();
      if (body.ClientId === 'staffclient' && target === 'RevokeToken') return Response.json({});
      return body.ClientId === 'staffclient' ? staff.fetch(IDP, url, init) : customers.fetch(IDP, url, init);
    }
    const token = String(init.headers?.authorization ?? '').replace('Bearer ', '');
    if (url.startsWith('/api/c/')) {
      if (customers.session(token) === null) return Response.json({ message: 'Unauthorized' }, { status: 401 });
      if (url === '/api/c/me') return Response.json({ email: 'ada@example.invalid', name: 'Ada', boards: 1 });
      if (url === '/api/c/boards') return Response.json({ boards: [BOARD] });
      if (url === '/api/c/activity') return Response.json({ activity: [{ at: BOARD.lastSeen, board: BOARD.id, kind: 'connection', what: 'connected' }] });
      if (url === `/api/c/boards/${BOARD.id}`) return Response.json({ board: BOARD, activity: [] });
      return Response.json({ error: { code: 'not_your_board', message: 'There is no board of yours at this address.' } }, { status: 404 });
    }
    if (url === '/api/me') {
      return token === 'STAFF-TOKEN'
        ? Response.json({ email: STAFF.email, canWrite: true, groups: ['release-managers'] })
        : Response.json({ message: 'Unauthorized' }, { status: 401 });
    }
    return new Response('Not found', { status: 404 });
  }
  const window = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    scrollTo() {},
    crypto: globalThis.crypto,
    fetch,
    sessionStorage,
    location,
    history: { replaceState() { location.search = ''; } },
    navigator: { clipboard: { writeText: async () => {} } },
  };
  const appCalls = [];
  if (phone) {
    const answers = { 'app.hello': { bridge: 1, platform: 'ios', shell: { version: '0.8.0', build: '14' }, bundle: {}, features: ['auth', 'biometric', 'clipboard', 'open', 'settings'] },
      'app.config': APP_CONFIG, 'app.ready': {}, 'auth.session': { signedIn: false }, 'auth.store': { biometric: { available: true, kind: 'faceID', enabled: false } },
      'biometric.status': { available: true, kind: 'faceID', enabled: false },
      ...phone };
    window.webkit = {
      messageHandlers: {
        cranium: {
          postMessage(text) {
            const message = JSON.parse(text);
            appCalls.push(message);
            const result = typeof answers[message.method] === 'function' ? answers[message.method](message.params) : answers[message.method];
            queueMicrotask(() => {
              const detail = JSON.stringify(result === undefined
                ? { id: message.id, ok: false, error: { code: 'unknown_method', message: 'No such method.' } }
                : { id: message.id, ok: true, result });
              for (const listener of [...listeners.get('cranium-native') ?? []]) listener({ type: 'cranium-native', detail });
            });
          },
        },
      },
    };
  }
  for (const [name, value] of Object.entries({ document, window, location, navigator: window.navigator })) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  copies += 1;
  await import(customerScript('customer.js', {
    'core.js': CORE, 'views.js': VIEWS, 'customer-core.js': SITE_CORE, 'customer-views.js': SITE_VIEWS, 'bridge.js': BRIDGE,
  }, `tab ${copies}`));
  await settle();
  const app = document.getElementById('app');
  return {
    document, location, stored, requests, addresses, appCalls, navigations, accounts, app,
    landing: document.getElementById('landing'),
    text: () => textOf(app),
    go(to) {
      location.hash = to;
    },
    async type(id, value) {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent({ type: 'input', target: el, data: value });
      await settle();
    },
    submit() {
      one(app, 'form.signin-form').dispatchEvent({ type: 'submit' });
    },
  };
}

async function signInAsCustomer(tab, password = 'her own password') {
  tab.go('#/sign-in');
  await until(() => tab.document.getElementById('signin-email') !== null, 'the sign-in page');
  await tab.type('signin-email', 'ada@example.invalid');
  tab.document.getElementById('signin-password').value = password;
  tab.submit();
}

test('signed out, the home page is shown; a page of the studio asks for a sign-in first, and Help does not', async (t) => {
  const tab = await openSite(t);
  assert.equal(tab.landing.hidden, false);
  assert.equal(tab.app.hidden, true);
  tab.go('#/devices');
  await until(() => tab.location.hash === '#/sign-in' && tab.document.getElementById('signin-email') !== null, 'the sign-in page');
  assert.equal(tab.landing.hidden, true);
  assert.match(tab.text(), /Sign in With the e-mail address and the password of your Cranium account\./);
  assert.ok(all(tab.app, 'a').some((link) => link.getAttribute('href') === '#/admin-sign-in'));
  tab.go('#/help');
  await until(() => /How can we help\?/.test(tab.text()), 'the help page');
  assert.equal(tab.location.hash, '#/help');
  assert.match(tab.text(), /A support address for customers is not set up yet/);
  assert.equal(tab.requests.filter((line) => line.includes('/api/')).length, 0, 'nothing is asked of the API while signed out');
});

test('a customer signs in, lands on the page they asked for, and sees their boards in plain words', async (t) => {
  const tab = await openSite(t);
  tab.go('#/devices');
  await until(() => tab.document.getElementById('signin-email') !== null, 'the sign-in page');
  await tab.type('signin-email', 'ada@example.invalid');
  tab.document.getElementById('signin-password').value = 'wrong password';
  tab.submit();
  await until(() => /The e-mail address or password is wrong\./.test(tab.text()), 'the refusal');
  assert.equal(tab.document.getElementById('signin-password').value, '');
  tab.document.getElementById('signin-password').value = 'her own password';
  tab.submit();
  await until(() => all(tab.app, 'table.cs-table').length === 1, 'the devices page');
  assert.equal(tab.location.hash, '#/devices');
  const text = tab.text();
  assert.match(text, /Living room deck/);
  assert.match(text, /Online/);
  assert.match(text, /1\.11\.2/);
  assert.match(text, /The last update finished\./);
  assert.doesNotMatch(text, /cranium-|AWS|thing/i);
  assert.ok(tab.stored.has('customer:cranium.session'));
  assert.equal(tab.stored.has('cranium.session'), false, 'the console\'s keys stay the admin\'s');

  tab.go(`#/devices/${BOARD.id}`);
  await until(() => /How it is/.test(tab.text()), 'the board');
  assert.match(tab.text(), /Location Not reported: boards cannot tell where they are yet\./);
  tab.go('#/mixes/transitions');
  await until(() => /The space between tracks\./.test(tab.text()), 'the mixes');
  assert.match(tab.text(), /Not built yet/);
  assert.match(tab.text(), /Nothing here is made up in the meantime\./);
  // No admin mode for a customer.
  assert.equal(all(tab.app, 'a').some((link) => link.getAttribute('href') === '/admin'), false);
});

test('the overview: figures, the boards and what they did; the account page labels every field', async (t) => {
  const tab = await openSite(t);
  await signInAsCustomer(tab);
  await until(() => all(tab.app, 'div.cs-tiles').length === 1 && /Came online/.test(tab.text()), 'the overview');
  assert.match(tab.text(), /Hello, Ada\./);
  assert.match(tab.text(), /Online now 1 of 1/);
  tab.go('#/account');
  await until(() => tab.document.getElementById('current-password') !== null, 'the account page');
  for (const el of descendants(tab.app).filter((node) => node.localName === 'input' && node.getAttribute('type') !== 'hidden')) {
    assert.ok(el.parentNode.localName === 'label' || el.getAttribute('aria-label'), `input ${el.getAttribute('id')} has a label`);
  }
  await until(() => /Two-step sign-in/.test(tab.text()) && /Turn on/.test(tab.text()), 'the authenticator card');
});

test('an invited customer chooses a password on the page, and signs in with it', async (t) => {
  const tab = await openSite(t, { status: 'FORCE_CHANGE_PASSWORD' });
  await signInAsCustomer(tab);
  await until(() => tab.document.getElementById('first-password') !== null, 'the new password step');
  assert.match(tab.text(), /Choose your password/);
  tab.document.getElementById('first-password').value = 'a long one of her own';
  tab.document.getElementById('first-again').value = 'a long one of hers';
  tab.submit();
  await until(() => /The two new passwords are not the same\./.test(tab.text()), 'the mismatch');
  tab.document.getElementById('first-password').value = 'a long one of her own';
  tab.document.getElementById('first-again').value = 'a long one of her own';
  tab.submit();
  await until(() => all(tab.app, 'div.cs-tiles').length === 1, 'the overview');
  assert.equal(tab.accounts.get('5d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6').status, 'CONFIRMED');
});

test('an admin signs in with password and code, and is offered admin mode, which is the console at /admin', async (t) => {
  const tab = await openSite(t);
  tab.go('#/admin-sign-in');
  await until(() => tab.document.getElementById('signin-email') !== null, 'the admin sign-in');
  assert.match(tab.text(), /Admin sign-in/);
  await tab.type('signin-email', STAFF.email);
  tab.document.getElementById('signin-password').value = STAFF.password;
  tab.submit();
  await until(() => tab.document.getElementById('code-digit-1') !== null, 'the six boxes');
  assert.equal(all(tab.app, 'input.code-digit').length, 6);
  const first = tab.document.getElementById('code-digit-1');
  first.value = STAFF.code;
  first.dispatchEvent({ type: 'input', target: first, data: STAFF.code });
  await until(() => /Signed in as an admin\./.test(tab.text()), 'the admin overview');
  // The session is under the console's own keys: the console at /admin reads it from this tab.
  assert.equal(JSON.parse(tab.stored.get('cranium.session')).accessToken, 'STAFF-TOKEN');
  const ways = all(tab.app, 'a').filter((link) => link.getAttribute('href') === '/admin');
  assert.ok(ways.length >= 2, 'the panel and the sidebar');
  assert.ok(ways.every((link) => /admin mode/i.test(textOf(link))));
  await until(() => /release manager/.test(tab.text()), 'who the admin is');
  // No token in any address.
  for (const link of all(tab.app, 'a')) assert.doesNotMatch(link.getAttribute('href') ?? '', /TOKEN|token=/);
  // Customer pages are not an admin's: the devices of a customer are not theirs to see here.
  tab.go('#/devices');
  await until(() => tab.location.hash === '#/overview', 'back to the overview');
});

test('signing out ends the session in the tab and takes it home', async (t) => {
  const tab = await openSite(t);
  await signInAsCustomer(tab);
  await until(() => all(tab.app, 'div.cs-tiles').length === 1, 'the overview');
  click(all(tab.app, 'button').find((button) => /Sign out/.test(textOf(button))));
  await settle();
  assert.deepEqual(tab.navigations, [HOME]);
  assert.equal(tab.stored.has('customer:cranium.session'), false);
});

test('in the phone app the site opens on its sign-in, and the customer\'s refresh token goes to the app, never into the tab', async (t) => {
  const tab = await openSite(t, { app: {} });
  await until(() => tab.document.getElementById('signin-email') !== null, 'the sign-in page');
  assert.equal(tab.landing.hidden, true, 'no home page in the app');
  assert.deepEqual(tab.appCalls.slice(0, 2).map((message) => message.method), ['app.hello', 'app.config']);
  assert.deepEqual(tab.appCalls.filter((message) => message.method === 'auth.session').map((message) => message.params.pool).sort(),
    ['admin', 'customer']);
  assert.ok(tab.appCalls.some((message) => message.method === 'app.ready'));

  await tab.type('signin-email', 'ada@example.invalid');
  tab.document.getElementById('signin-password').value = 'her own password';
  tab.submit();
  await until(() => /Hello, Ada\./.test(tab.text()), 'the overview');
  const stored = tab.appCalls.filter((message) => message.method === 'auth.store');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].params.pool, 'customer');
  assert.match(stored[0].params.refreshToken, /\S{10,}/);
  // Nothing in the tab's storage, no revocation of the token the app keeps, and the API at its own address.
  assert.equal(tab.stored.size, 0);
  assert.equal(tab.requests.some((line) => line.includes('RevokeToken')), false);
  assert.ok(tab.addresses.includes(`${APP_CUSTOMER_API}/api/c/boards`));
  assert.ok(tab.addresses.every((address) => !address.startsWith('/')), 'nothing at the page\'s own origin');
  // The account page has the phone's own card.
  tab.go('#/account');
  await until(() => /On this phone/.test(tab.text()), 'the account page');
  assert.match(tab.text(), /iPhone app 0\.8\.0 \(14\)/);
  assert.match(tab.text(), /Unlock with Face ID/);
});

test('in the phone app, signing out of the customer side makes the app forget both sign-ins, as the website does', async (t) => {
  const tab = await openSite(t, {
    app: { 'auth.session': ({ pool }) => (pool === 'admin' ? { signedIn: true, accessToken: 'STAFF-TOKEN', expiresIn: 3600 } : { signedIn: false }),
      'auth.signOut': {} },
  });
  // The admin is signed in already, from the app: the customer signs in as well.
  await until(() => /Signed in as an admin/.test(tab.text()), 'the admin overview');
  tab.go('#/sign-in');
  await until(() => tab.document.getElementById('signin-email') !== null, 'the sign-in page');
  await tab.type('signin-email', 'ada@example.invalid');
  tab.document.getElementById('signin-password').value = 'her own password';
  tab.submit();
  await until(() => /Hello, Ada\./.test(tab.text()), 'the overview');
  click(all(tab.app, 'button').find((button) => textOf(button) === 'Sign out'));
  await until(() => tab.appCalls.filter((message) => message.method === 'auth.signOut').length === 2, 'both sign-outs');
  assert.deepEqual(tab.appCalls.filter((message) => message.method === 'auth.signOut').map((message) => message.params.pool).sort(),
    ['admin', 'customer']);
  await until(() => tab.navigations.length === 1, 'the way home');
  assert.deepEqual(tab.navigations, ['cranium-app://bundle/']);
});
