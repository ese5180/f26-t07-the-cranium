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
import {
  BRIDGE,
  CORE,
  LIVE,
  VIEWS,
  all,
  click,
  createDocument,
  descendants,
  one,
  scriptAddress,
  textOf,
} from './page.mjs';

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
const SITE_MIXES = customerScript('customer-mixes.js');
const SITE_STATS = customerScript('customer-stats.js', { 'customer-mixes.js': SITE_MIXES });
const SITE_MIX_VIEWS = customerScript('customer-mix-views.js', {
  'views.js': VIEWS,
  'customer-core.js': SITE_CORE,
  'customer-mixes.js': SITE_MIXES,
  'customer-stats.js': SITE_STATS,
});
const SITE_PHOTOS = customerScript('customer-team-photos.js');
const SITE_VIEWS = customerScript('customer-views.js', {
  'core.js': CORE,
  'views.js': VIEWS,
  'customer-core.js': SITE_CORE,
  'customer-mix-views.js': SITE_MIX_VIEWS,
  'customer-team-photos.js': SITE_PHOTOS,
});
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
    clientId: 'staffclient',
    loginOrigin: 'https://login.example',
    scope: 'openid cranium/console',
    userPoolId: 'us-east-1_staff',
    customer: {
      hosts: ['cranium.example', 'www.cranium.example'],
      userPoolId: 'us-east-1_customers',
      clientId: 'customerclient',
    },
    log: () => {},
    ...extra,
  });
}

const request = (host, path, method = 'GET') => ({
  rawPath: path,
  requestContext: { domainName: host, http: { method }, requestId: 'r' },
});
const metaOf = (body) =>
  JSON.parse(/<meta name="cranium-config" content="([^"]*)">/.exec(body)[1].replaceAll('&quot;', '"'));

test("the customer site's name gets the site at /, the console as admin mode at /admin, and the files of both", async () => {
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
  assert.deepEqual(files.map((path) => path.split('/').pop()).sort(), [
    'app.css',
    'core.js',
    'customer-core.js',
    'customer-mix-views.js',
    'customer-mixes.js',
    'customer-stats.js',
    'customer-team-photos.js',
    'customer-views.js',
    'customer.css',
    'customer.js',
    'views.js',
  ]);
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
  // Opened on the console's own name, the console still links back to the customer site.
  const direct = metaOf((await web(request('console.cranium.example', '/'))).body);
  assert.equal(direct.customerSite, 'https://cranium.example/');
  assert.equal(core.readConfig(JSON.stringify(direct)).customerSite, 'https://cranium.example/');
  // Only an https origin is taken: nothing that could run or go elsewhere.
  for (const bad of [
    'javascript:alert(1)',
    'http://cranium.example/',
    'https://cranium.example/x',
    '//evil.example/',
  ]) {
    assert.equal(core.readConfig(JSON.stringify({ ...direct, customerSite: bad })).customerSite, undefined, bad);
  }
  // Nothing else, and only GET.
  assert.equal((await web(request('cranium.example', '/admin/'))).statusCode, 404);
  assert.equal((await web(request('cranium.example', '/index.html'))).statusCode, 404);
  assert.equal((await web(request('cranium.example', '/', 'POST'))).statusCode, 405);
  // The apps' customer pages ask first before they call the customer API with a token.
  const asked = await web(request('cranium.example', '/api/c/boards', 'OPTIONS'));
  assert.equal(asked.statusCode, 204);
  assert.equal(asked.body, '');
  assert.equal((await web(request('cranium.example', '/', 'OPTIONS'))).statusCode, 405);
});

test('www., and any other name of the site, sends the browser to the one name', async () => {
  const web = webHandler();
  for (const [path, to] of [
    ['/', '/'],
    ['/admin', '/admin'],
    ['/assets/x/app.css', '/'],
    ['/anything', '/'],
  ]) {
    const moved = await web(request('www.cranium.example', path));
    assert.deepEqual([moved.statusCode, moved.headers.location], [308, `https://cranium.example${to}`], path);
  }
});

test("the site's policy: its own origin and Cognito's user pool API, no inline code, Trusted Types, no serial port", async () => {
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
  assert.match(
    admin.headers['content-security-policy'],
    /connect-src 'self' https:\/\/login\.example https:\/\/cognito-idp/
  );
  assert.match(admin.headers['permissions-policy'], /serial=\(self\)/);
});

test("every other name gets what it got before, apart from the console's link back to the customer site", async () => {
  const before = createWebHandler({
    clientId: 'staffclient',
    loginOrigin: 'https://login.example',
    scope: 'openid cranium/console',
    userPoolId: 'us-east-1_staff',
    homeHosts: ['home.example'],
    log: () => {},
  });
  const after = webHandler({ homeHosts: ['home.example'] });
  for (const [host, path] of [
    ['console.example', '/'],
    ['home.example', '/'],
    ['console.example', '/admin'],
    ['home.example', '/admin'],
  ]) {
    const [a, b] = [await before(request(host, path)), await after(request(host, path))];
    // The one difference: the console's settings now name the customer site, for its link back.
    const link = ',&quot;customerSite&quot;:&quot;https://cranium.example/&quot;}';
    const expected = host === 'console.example' ? a.body.replace('}">', `${link}">`) : a.body;
    assert.deepEqual([b.statusCode, b.headers, b.body], [a.statusCode, a.headers, expected], `${host}${path}`);
  }
});

test("the customer site's settings are checked when the function starts", () => {
  const base = {
    clientId: 'c',
    loginOrigin: 'https://login.example',
    scope: 's',
    userPoolId: 'us-east-1_staff',
    log: () => {},
  };
  const customer = { hosts: ['cranium.example'], userPoolId: 'us-east-1_customers', clientId: 'cc' };
  assert.throws(
    () => createWebHandler({ ...base, customer: { ...customer, userPoolId: 'eu-west-1_customers' } }),
    /Region/
  );
  assert.throws(() => createWebHandler({ ...base, customer: { ...customer, hosts: [] } }), /hosts/);
  assert.throws(() => createWebHandler({ ...base, customer: { ...customer, hosts: ['Cranium.example'] } }), /hosts/);
  assert.throws(() => createWebHandler({ ...base, customer: { ...customer, clientId: '' } }), /clientId/);
  assert.throws(
    () => createWebHandler({ ...base, homeHosts: ['cranium.example'], customer }),
    /home page and the customer site/
  );
});

test("deployed, the names and the customer pool come from the function's environment", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    USER_POOL_CLIENT_ID: 'staffclient',
    LOGIN_DOMAIN: 'login.example',
    OAUTH_SCOPE: 'openid cranium/console',
    USER_POOL_ID: 'us-east-1_staff',
    CUSTOMER_HOSTS: 'cranium.example,www.cranium.example',
    CUSTOMER_POOL_ID: 'us-east-1_customers',
    CUSTOMER_CLIENT_ID: 'customerclient',
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
const ownAssets = readdirSync(new URL('assets/', CUSTOMER_DIR))
  .filter((name) => !name.startsWith('.'))
  .sort();
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

test("the site serves the console's own core.js, views.js and app.css, byte for byte: nothing to drift", () => {
  const loaded = loadCustomerSite(CUSTOMER_DIR, SITE_DIR);
  for (const name of SHARED_ASSETS) {
    const served = loaded.assets.get(`/assets/${loaded.buildId}/${name}`);
    assert.equal(served.body, readFileSync(new URL(`assets/${name}`, SITE_DIR), 'utf8'), name);
  }
  assert.deepEqual(ownAssets, [
    'customer-core.js',
    'customer-mix-views.js',
    'customer-mixes.js',
    'customer-stats.js',
    'customer-team-photos.js',
    'customer-views.js',
    'customer.css',
    'customer.js',
  ]);
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
  const fetched = [...page.matchAll(/\s(?:href|src)="([^"#][^"]*)"/g)]
    .map((match) => match[1])
    .filter((reference) => !reference.startsWith('data:') && !reference.startsWith('https://github.com/'));
  assert.deepEqual(
    [...new Set(fetched)].sort(),
    [
      'app.css',
      'core.js',
      'customer-core.js',
      'customer-mix-views.js',
      'customer-mixes.js',
      'customer-stats.js',
      'customer-team-photos.js',
      'customer-views.js',
      'customer.css',
      'customer.js',
      'views.js',
    ]
      .map((name) => `/assets/%BUILD%/${name}`)
      .sort()
  );
  assert.equal((page.match(/%CONFIG%/g) ?? []).length, 1);
  assert.match(page, /<noscript>[\s\S]+<\/noscript>/);
  // No CDN, no font, no image to fetch.
  assert.doesNotMatch(page, /cdn|googleapis|\.woff|\.png|\.jpg/i);
});

test("the site's scripts never write markup or run text as code, and hold no e-mail address", () => {
  for (const name of ownAssets) {
    const source = readFileSync(new URL(`assets/${name}`, CUSTOMER_DIR), 'utf8');
    for (const pattern of [
      /\.innerHTML\b/,
      /\.outerHTML\b/,
      /insertAdjacentHTML/,
      /document\.write/,
      /\beval\s*\(/,
      /new\s+Function\b/,
      /DOMParser|setHTML|createContextualFragment/,
      /set(?:Timeout|Interval)\s*\(\s*['"`]/,
    ]) {
      assert.doesNotMatch(code(source), pattern, `${name}: ${pattern}`);
    }
    assert.doesNotMatch(source, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, name);
  }
  assert.doesNotMatch(page, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
});

test('the home page says what is built and what is not, and promises nothing more', () => {
  const words = page.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const fact of [
    'In development',
    'there is no sign-up',
    'every 30 seconds',
    '5 minutes',
    'Not built yet',
    'tested on one board',
  ]) {
    assert.ok(words.includes(fact), fact);
  }
  assert.equal((words.match(/Not built yet/g) ?? []).length, 5);
  for (const claim of [/for sale/i, /buy/i, /price/i, /\bfree\b/i, /guarantee/i]) assert.doesNotMatch(words, claim);
});

// The console's activity log, for the Customers page's entries. The phone apps keep the same examples
// (apps/android AuditParityTest, apps/ios ParityTests).

test("the Customers page's entries read as sentences: a customer by address, a board then whose it is", () => {
  const SUB = '7ec17d2e-9ee4-4734-8901-33c8fec73372';
  const THING = 'cranium-fe5b26c0c5b1dcd7';
  const actor = { sub: 's', email: 'a@b' };
  const entry = (action, target, outcome, detail) => ({
    at: '2026-11-04T12:00:00Z',
    actor,
    action,
    target,
    outcome,
    detail,
    requestId: '',
  });
  const facts = (described) => described.facts.map((fact) => [fact.label, fact.value]);
  const email = ['email', 'ada@example.invalid'];

  assert.equal(
    core.auditSentence(entry('customer.create', SUB, 'ok', [email])),
    'a@b invited the customer ada@example.invalid'
  );
  assert.deepEqual(facts(core.describeAudit(entry('customer.create', SUB, 'ok', [email]))), []);
  assert.equal(
    core.auditSentence(entry('customer.create', '', 'rejected', [email, ['code', 'customer_exists']])),
    'a@b tried to invite the customer ada@example.invalid'
  );
  const given = entry('customer.assign', THING, 'ok', [['customer', SUB], email, ['label', 'Deck']]);
  assert.equal(core.auditSentence(given), `a@b gave ${THING} to ada@example.invalid`);
  assert.deepEqual(facts(core.describeAudit(given)), [
    ['Customer', SUB],
    ['Called', 'Deck'],
  ]);
  assert.equal(core.describeAudit(given).thing, THING);
  assert.equal(
    core.auditSentence(entry('customer.unassign', THING, 'ok', [['customer', SUB]])),
    `a@b took ${THING} back from a customer`
  );
  assert.equal(
    core.auditSentence(entry('customer.assign', '', 'denied', [['code', 'release_manager_required']])),
    'a@b tried to give a board to a customer'
  );
  assert.equal(core.auditSentence(entry('customer.resend', '', 'ok', [])), 'a@b sent an invitation again');
  assert.equal(
    core.auditSentence(entry('customer.disable', SUB, 'ok', [email])),
    'a@b switched off the customer account of ada@example.invalid'
  );
  assert.equal(
    core.auditSentence(entry('customer.enable', '', 'denied', [])),
    'a@b tried to switch on a customer account'
  );
  assert.equal(
    core.describeAudit(entry('customer.assign', THING, 'rejected', [['code', 'board_taken']])).facts[0].words,
    'That board belongs to another customer'
  );
});

// The site's logic.

test('routes: the pages of the site, a board by its assignment id, and nothing else', () => {
  assert.deepEqual(site.parseRoute(''), { view: 'landing' });
  assert.deepEqual(site.parseRoute('#/'), { view: 'landing' });
  assert.deepEqual(site.parseRoute('#/overview'), { view: 'overview' });
  assert.deepEqual(site.parseRoute('#/devices/0123456789abcdef'), { view: 'device', id: '0123456789abcdef' });
  assert.deepEqual(site.parseRoute('#/mixes/library'), { view: 'mixes', tab: 'library' });
  for (const hash of [
    '#/devices/cranium-0123456789abcdef',
    '#/mixes/other',
    '#/firmware',
    '#how',
    '#/devices/ABC',
    '#/overview/x',
  ]) {
    assert.equal(site.parseRoute(hash), null, hash);
  }
  assert.equal(site.routeHash({ view: 'device', id: '0123456789abcdef' }), '#/devices/0123456789abcdef');
  assert.equal(site.routeHash({ view: 'device', id: 'cranium-x' }), '#/');
  assert.equal(site.routeHash({ view: 'nowhere' }), '#/');
  assert.deepEqual(site.parseRoute('#/about'), { view: 'about' });
  assert.equal(site.routeHash({ view: 'about' }), '#/about');
  assert.deepEqual([...site.PUBLIC_VIEWS], ['landing', 'sign-in', 'forgot', 'help', 'about']);
  // One sign-in for everybody: the admin sign-in of before is no page any more.
  assert.equal(site.parseRoute('#/admin-sign-in'), null);
});

test('the settings in the page are read with care, and each sign-in gets its own pool and no managed login', () => {
  const config = site.readSiteConfig(JSON.stringify(SITE_CONFIG));
  assert.deepEqual(config, SITE_CONFIG);
  for (const broken of [
    { ...SITE_CONFIG, home: 'https://cranium.example/x' },
    { ...SITE_CONFIG, idpOrigin: 'javascript:x' },
    { ...SITE_CONFIG, adminPath: '/console' },
    { ...SITE_CONFIG, customer: { clientId: 'c' } },
  ]) {
    assert.equal(site.readSiteConfig(JSON.stringify(broken)), null);
  }
  assert.equal(site.readSiteConfig('not json'), null);
  assert.deepEqual(site.authConfig(config, 'customer'), {
    clientId: 'customerclient',
    userPoolId: CUSTOMER_POOL,
    idpOrigin: IDP,
    redirectUri: HOME,
    scope: '',
    loginOrigin: '',
  });
  assert.equal(site.authConfig(config, 'admin').clientId, 'staffclient');
});

test("a customer's keys are their own: clearing them leaves the admin's session, which the console reads", () => {
  const stored = new Map([
    ['cranium.session', 'admin'],
    ['other', 'x'],
  ]);
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
  };
  const mine = site.namespaced(storage, site.CUSTOMER_PREFIX);
  mine.setItem('cranium.session', 'customer');
  mine.setItem('cranium.signedout', '1');
  assert.equal(mine.getItem('cranium.session'), 'customer');
  mine.clear();
  assert.deepEqual(
    [...stored],
    [
      ['cranium.session', 'admin'],
      ['other', 'x'],
    ]
  );
  const theirs = site.namespaced(storage, '');
  theirs.clear();
  assert.deepEqual([...stored], [['other', 'x']]);
});

const BOARD = {
  id: '0123456789abcdef',
  name: 'Living room deck',
  // The customer's own name for it: none yet.
  label: null,
  boardName: 'CRADA01',
  status: 'online',
  online: true,
  lastSeen: '2026-11-04T11:59:40.000Z',
  firmware: { version: '1.11.2+0', confirmed: true },
  update: { state: 'idle', progress: 0, last: 'succeeded' },
  rssi: -58,
  uptime: 600,
  location: null,
  since: '2026-11-01T10:00:00.000Z',
  health: {
    state: 'attention',
    summary: 'Restarted unexpectedly twice this week',
    unexpectedRestarts7d: 2,
    lastIssueAt: '2026-11-04T08:00:00.000Z',
    restarts7d: [
      { at: '2026-11-02T14:00:00.000Z', unexpected: false },
      { at: '2026-11-03T09:00:00.000Z', unexpected: true },
      { at: '2026-11-04T08:00:00.000Z', unexpected: true },
    ],
  },
};

test('a board is read into a known shape, and anything else from the API is left out', () => {
  assert.deepEqual(site.readBoard(BOARD), BOARD);
  assert.equal(site.readBoard({ ...BOARD, id: 'cranium-0123456789abcdef' }), null);
  assert.equal(site.readBoard({ ...BOARD, status: 'hacked' }), null);
  const odd = site.readBoard({
    ...BOARD,
    name: 'Deck\u0000‮<b>',
    firmware: { version: '1.2' },
    rssi: 5,
    thing: 'cranium-x',
    mac: 'aa',
  });
  assert.deepEqual(
    [odd.name, odd.firmware, odd.rssi, Object.hasOwn(odd, 'thing'), Object.hasOwn(odd, 'mac')],
    ['Deck<b>', null, null, false, false]
  );
  assert.equal(site.readEvent({ at: BOARD.lastSeen, board: BOARD.id, kind: 'health', what: 'memory' }), null);
  assert.deepEqual(
    site.readEvent({
      at: BOARD.lastSeen,
      board: BOARD.id,
      kind: 'firmware',
      what: 'changed',
      version: '1.11.3+0',
      from: '1.11.2+0',
      confirmed: false,
      text: 'x',
    }),
    {
      at: BOARD.lastSeen,
      board: BOARD.id,
      kind: 'firmware',
      what: 'changed',
      version: '1.11.3+0',
      from: '1.11.2+0',
      confirmed: false,
    }
  );
});

test("a board's health is read with care, said in plain words in the reader's time, and drawn as a week", () => {
  // Anything that is not a health of the server's is none; a fault name in a sentence is not a sentence.
  for (const raw of [null, 'ok', { state: 'fine', summary: 'Running normally' }, { state: 'ok', summary: '' }]) {
    assert.equal(site.readHealth(raw), null, JSON.stringify(raw));
  }
  assert.equal(site.readHealth({ state: 'ok', summary: 'BusFault <at> 0x0800' }), null);
  const odd = site.readHealth({
    state: 'ok',
    summary: 'Running normally',
    unexpectedRestarts7d: -1,
    lastIssueAt: 'yesterday',
    reason: 'HardFault',
    restarts7d: [{ at: 'x' }, { at: '2026-11-03T09:00:00.000Z', unexpected: 'yes', reason: 'Watchdog' }],
  });
  assert.deepEqual(odd, {
    state: 'ok',
    summary: 'Running normally',
    unexpectedRestarts7d: 0,
    restarts7d: [{ at: '2026-11-03T09:00:00.000Z', unexpected: false }],
  });

  const words = (health, extra = {}) => site.healthWords({ ...BOARD, ...extra, health });
  assert.deepEqual(words(BOARD.health), {
    state: 'attention',
    tone: 'warn',
    text: 'Restarted unexpectedly twice this week',
  });
  assert.equal(site.healthWords({ ...BOARD, health: null }), null);
  const local = (iso) => site.dayLabel(iso);
  assert.match(local('2026-11-03T12:00:00.000Z'), /^Tue 3 Nov$/);
  assert.equal(
    words({
      state: 'ok',
      summary: 'Recovered from a problem on Tue 3 Nov',
      unexpectedRestarts7d: 1,
      lastIssueAt: '2026-11-03T23:30:00.000Z',
      restarts7d: [],
    }).text,
    `Recovered from a problem on ${local('2026-11-03T23:30:00.000Z')}`
  );
  assert.equal(
    words({
      state: 'ok',
      summary: 'Updated to 1.15.0 on Thu 5 Nov',
      unexpectedRestarts7d: 0,
      updatedTo: { version: '1.15.0', at: '2026-11-05T08:00:00.000Z' },
      restarts7d: [],
    }).text,
    `Updated to 1.15.0 on ${local('2026-11-05T08:00:00.000Z')}`
  );
  assert.deepEqual(
    words(
      { state: 'offline', summary: 'Offline since Wed 4 Nov', unexpectedRestarts7d: 0, restarts7d: [] },
      { status: 'offline' }
    ),
    { state: 'offline', tone: 'idle', text: `Offline since ${local(BOARD.lastSeen)}` }
  );
  assert.equal(
    words({ state: 'ok', summary: 'Running normally', unexpectedRestarts7d: 0, restarts7d: [] }).tone,
    'good'
  );

  const now = Date.parse('2026-11-04T12:00:00.000Z');
  const week = site.restartWeek(BOARD.health, now);
  assert.equal(week.length, 7);
  assert.equal(week.at(-1).date, local(new Date(now).toISOString()));
  assert.equal(
    week.reduce((sum, day) => sum + day.unexpected, 0),
    2
  );
  assert.equal(
    week.reduce((sum, day) => sum + day.expected, 0),
    1
  );
  // A restart older than the week is not drawn.
  assert.equal(
    site
      .restartWeek({ restarts7d: [{ at: '2026-10-20T10:00:00.000Z', unexpected: true }] }, now)
      .every((day) => day.unexpected === 0),
    true
  );
});

test('what a board is doing, in plain words, for every state and every result', () => {
  const now = Date.parse('2026-11-04T12:00:00.000Z');
  assert.deepEqual(site.statusWords(BOARD, now), {
    tone: 'good',
    icon: 'online',
    label: 'Online',
    text: 'Connected, and reporting every 30 seconds.',
  });
  assert.match(
    site.statusWords({ ...BOARD, status: 'offline', online: false }, now).text,
    /^Last heard from 20 s ago\./
  );
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
  for (const [kind, what, extra] of [
    ['connection', 'connected'],
    ['connection', 'disconnected'],
    ['firmware', 'reported', { version: '1.0.0+0' }],
    ['firmware', 'changed', { version: '1.1.0+0', from: '1.0.0+0' }],
    ['firmware', 'confirmed', {}],
    ['update', 'step', { state: 'downloading' }],
    ['update', 'step', { state: 'awaiting_user' }],
    ['update', 'result', { result: 'rolled_back' }],
    ['restart', 'restarted'],
    ['restart', 'stuck'],
    ['bluetooth', 'opened'],
    ['bluetooth', 'closed'],
    ['bluetooth', 'record', { result: 'succeeded', to: '1.2.0+0' }],
  ]) {
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
  assert.equal(
    site.otpauthUri('ABCDEFGHIJKLMNOP', 'ada@example.invalid'),
    'otpauth://totp/Cranium%3Aada%40example.invalid?secret=ABCDEFGHIJKLMNOP&issuer=Cranium'
  );
  assert.equal(site.otpauthUri('javascript:alert(1)', 'x'), null);
  assert.equal(site.accountProblem('NotAuthorizedException', 'change'), 'wrong-password');
  assert.equal(site.accountProblem('NotAuthorizedException', 'forgot'), 'not-yet');
  assert.equal(site.accountProblem('CodeMismatchException'), 'wrong-code');
  assert.equal(site.accountProblem('Whatever'), 'failed');
  for (const words of Object.values(site.ACCOUNT_WORDS)) assert.match(words, /\.$/);
});

test("the customer API's client sends the customer's token, and a refusal ends the session", async () => {
  let token = 'CUSTOMER-TOKEN';
  let refused = 0;
  const sent = [];
  const auth = {
    accessToken: () => token,
    tokenRefused: () => {
      token = null;
    },
  };
  const api = site.createCustomerApi({
    auth,
    onUnauthorized: () => {
      refused += 1;
    },
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
  const accounts = new Map([
    [
      '5d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6',
      { sub: '5d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6', email: 'ada@example.invalid', name: 'Ada', enabled: true, status },
    ],
  ]);
  const directory = {
    find: (email) => [...accounts.values()].find((account) => account.email === email) ?? null,
    bySub: (sub) => accounts.get(sub) ?? null,
    confirm: (sub) => {
      accounts.get(sub).status = 'CONFIRMED';
    },
  };
  const cognito = createCustomerCognito({
    userPoolId: CUSTOMER_POOL,
    clientId: 'customerclient',
    directory,
    now: () => NOW,
  });
  cognito.addCredentials({
    sub: '5d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6',
    password: 'her own password',
    code: '246810',
    authenticator,
  });
  return { cognito, accounts };
}

function authFor(cognito, { newPasswordHere = true, stored = new Map() } = {}) {
  const location = {
    search: '',
    hash: '#/sign-in',
    pathname: '/',
    assigned: null,
    assign(url) {
      location.assigned = url;
    },
  };
  const auth = core.createAuth({
    config: site.authConfig(SITE_CONFIG, 'customer'),
    storage: site.namespaced(
      {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
        removeItem: (key) => stored.delete(key),
      },
      'customer:'
    ),
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
  assert.deepEqual(await asConsole.passwordSignIn('ada@example.invalid', 'her own password'), {
    step: 'elsewhere',
    challenge: 'NEW_PASSWORD_REQUIRED',
  });
  assert.deepEqual(await asConsole.sendNewPassword('a long one of her own'), { step: 'password', problem: 'expired' });
  assert.equal(
    core.SIGN_IN_WORDS['weak-password'],
    'That password is not accepted. Choose one of at least 10 characters.'
  );
});

test("a customer with an authenticator app gives the code in the same step as the console's", async () => {
  const { cognito } = customerWorld({ authenticator: true });
  const { auth } = authFor(cognito);
  assert.deepEqual(await auth.passwordSignIn('ada@example.invalid', 'her own password'), { step: 'code' });
  assert.deepEqual(await auth.sendCode('111111'), { step: 'code', problem: 'wrong-code' });
  assert.deepEqual(await auth.sendCode('246810'), { step: 'done' });
});

// One sign-in for everybody (customer-core.js signInEither): the team's pool first, then the customer pool.

const TEAM = {
  email: 'manager@example.invalid',
  userId: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  password: 'Only-For-Tests-7',
  code: '135790',
};

/** Both pools behind one fetch, as the site has them: the team's (with its code always) and the customer pool. */
function bothPools({ status = 'CONFIRMED', authenticator = false, fail } = {}) {
  const { cognito: customers, accounts } = customerWorld({ status, authenticator });
  const team = createCognito({
    userPoolId: STAFF_POOL,
    clientId: 'staffclient',
    users: [{ ...TEAM, groups: ['release-managers'] }],
    now: () => NOW,
    fail,
  });
  const fetch = (url, init) => {
    const body = JSON.parse(init.body);
    return body.ClientId === 'staffclient' ? team.fetch(IDP, url, init) : customers.fetch(IDP, url, init);
  };
  const kept = new Map();
  const tabStorage = {
    getItem: (key) => kept.get(key) ?? null,
    setItem: (key, value) => kept.set(key, value),
    removeItem: (key) => kept.delete(key),
  };
  const authOf = (which) =>
    core.createAuth({
      config: site.authConfig(SITE_CONFIG, which),
      storage: site.namespaced(tabStorage, which === 'customer' ? 'customer:' : ''),
      location: { search: '', hash: '', pathname: '/', assign() {} },
      history: { replaceState() {} },
      fetch,
      crypto: globalThis.crypto,
      now: () => NOW,
      newPasswordHere: which === 'customer',
    });
  const signIns = { admin: authOf('admin'), customer: authOf('customer') };
  return { team, customers, accounts, signIns, fetch };
}

const initiations = (pool) => pool.calls.filter((call) => call.operation === 'InitiateAuth');

test('one form: a team account signs in at the team pool, with its code, and the customer pool is never asked', async () => {
  const { team, customers, signIns } = bothPools();
  const first = await site.signInEither(signIns, TEAM.email, TEAM.password);
  assert.deepEqual(first, { kind: 'admin', outcome: { step: 'code' } });
  assert.deepEqual(await signIns.admin.sendCode('000000'), { step: 'code', problem: 'wrong-code' });
  assert.deepEqual(await signIns.admin.sendCode(TEAM.code), { step: 'done' });
  assert.equal(initiations(team).length, 1);
  assert.equal(initiations(customers).length, 0);
});

test('one form: a customer is refused by the team pool, then signed in by the customer pool, one try each', async () => {
  const { team, customers, signIns } = bothPools();
  assert.deepEqual(await site.signInEither(signIns, 'ada@example.invalid', 'her own password'), {
    kind: 'customer',
    outcome: { step: 'done' },
  });
  assert.equal(initiations(team).length, 1);
  assert.equal(initiations(customers).length, 1);
  // Her own authenticator, and a first sign-in's new password, are the customer pool's steps as before.
  const coded = bothPools({ authenticator: true });
  assert.deepEqual(await site.signInEither(coded.signIns, 'ada@example.invalid', 'her own password'), {
    kind: 'customer',
    outcome: { step: 'code' },
  });
  assert.deepEqual(await coded.signIns.customer.sendCode('246810'), { step: 'done' });
  const invited = bothPools({ status: 'FORCE_CHANGE_PASSWORD' });
  assert.deepEqual(await site.signInEither(invited.signIns, 'ada@example.invalid', 'her own password'), {
    kind: 'customer',
    outcome: { step: 'new-password' },
  });
});

test('one form: a wrong password and an unknown address get the same words, whichever pool has the account', async () => {
  const wrong = core.SIGN_IN_WORDS['wrong-password'];
  assert.equal(wrong, 'The e-mail address or password is wrong.');
  for (const [email, password] of [
    [TEAM.email, 'not the password'],
    ['ada@example.invalid', 'not the password'],
    ['nobody@example.invalid', 'any password at all'],
  ]) {
    const { team, customers, signIns } = bothPools();
    const answer = await site.signInEither(signIns, email, password);
    assert.deepEqual(answer.outcome, { step: 'password', problem: 'wrong-password' }, email);
    // One try at each pool, never more: the brute-force limits of each pool count every one.
    assert.equal(initiations(team).length, 1, email);
    assert.equal(initiations(customers).length, 1, email);
  }
  // Nothing is asked of either pool without an address and a password.
  const { team, customers, signIns } = bothPools();
  assert.deepEqual((await site.signInEither(signIns, '', 'x')).outcome, { step: 'password', problem: 'missing' });
  assert.equal(team.calls.length + customers.calls.length, 0);
});

test("one form: the team pool's throttling stops there, with its own words, and the customer pool is not asked", async () => {
  const { customers, signIns } = bothPools({
    fail: (operation) => (operation === 'InitiateAuth' ? 'TooManyRequestsException' : null),
  });
  assert.deepEqual(await site.signInEither(signIns, TEAM.email, TEAM.password), {
    kind: 'admin',
    outcome: { step: 'password', problem: 'too-many' },
  });
  assert.equal(initiations(customers).length, 0);
  assert.equal(core.SIGN_IN_WORDS['too-many'], 'Too many tries. Wait a minute.');
});

test('one form: the address goes to the team pool in lower case, as users.sh keeps its names', async () => {
  const { team, signIns } = bothPools();
  assert.deepEqual(await site.signInEither(signIns, '  Manager@Example.INVALID ', TEAM.password), {
    kind: 'admin',
    outcome: { step: 'code' },
  });
  assert.equal(initiations(team)[0].body.AuthParameters.USERNAME, 'manager@example.invalid');
});

test('one form for a forgotten password: both pools are asked once, and the page says the same either way', async () => {
  // The team pool hides unknown names: it answers as if a code went out. A team account resets with an admin.
  const teamSays = [];
  const world = bothPools();
  const fetch = (url, init) => {
    const body = JSON.parse(init.body);
    if (body.ClientId !== 'staffclient') return world.fetch(url, init);
    const target = init.headers['x-amz-target'].split('.').pop();
    teamSays.push([target, body.Username]);
    if (target === 'ForgotPassword') return Response.json({ CodeDeliveryDetails: { DeliveryMedium: 'EMAIL' } });
    return Response.json({ __type: 'CodeMismatchException' }, { status: 400 });
  };
  const account = site.createAccount({ fetch, site: SITE_CONFIG, accessToken: () => null });
  // A customer: the code comes from the customer pool, and the new password is set there.
  assert.deepEqual(await account.forgotPassword(' Ada@Example.invalid'), { ok: true });
  const asked = world.customers.calls.filter((call) => call.operation === 'ForgotPassword');
  assert.deepEqual(
    asked.map((call) => call.body.Username),
    ['ada@example.invalid']
  );
  assert.deepEqual(await account.confirmForgotPassword('ada@example.invalid', '000000', 'a new long password'), {
    ok: false,
    problem: 'wrong-code',
  });
  assert.deepEqual(await account.confirmForgotPassword('ada@example.invalid', '135790', 'a new long password'), {
    ok: true,
  });
  assert.deepEqual(await site.signInEither(world.signIns, 'ada@example.invalid', 'a new long password'), {
    kind: 'customer',
    outcome: { step: 'done' },
  });
  // An address no pool has: the same answers, and still one request to each pool.
  const before = teamSays.length;
  assert.deepEqual(await account.forgotPassword('nobody@example.invalid'), { ok: true });
  assert.deepEqual(await account.confirmForgotPassword('nobody@example.invalid', '135790', 'a new long password'), {
    ok: false,
    problem: 'wrong-code',
  });
  assert.deepEqual(teamSays.slice(before), [
    ['ForgotPassword', 'nobody@example.invalid'],
    ['ConfirmForgotPassword', 'nobody@example.invalid'],
  ]);
  assert.deepEqual(await account.forgotPassword('  '), { ok: false, problem: 'missing-email' });
});

test('one form for a forgotten password: a team account whose pool sends codes resets there, and stops there', async () => {
  const customerCalls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const target = init.headers['x-amz-target'].split('.').pop();
    if (body.ClientId !== 'staffclient') {
      customerCalls.push(target);
      if (target === 'ForgotPassword') return Response.json({ CodeDeliveryDetails: { DeliveryMedium: 'EMAIL' } });
      return Response.json({ __type: 'CodeMismatchException' }, { status: 400 });
    }
    if (target === 'ForgotPassword') return Response.json({ CodeDeliveryDetails: { DeliveryMedium: 'EMAIL' } });
    if (body.ConfirmationCode === '999999') return Response.json({ __type: 'ExpiredCodeException' }, { status: 400 });
    return Response.json({});
  };
  const account = site.createAccount({ fetch, site: SITE_CONFIG, accessToken: () => null });
  assert.deepEqual(await account.forgotPassword(TEAM.email), { ok: true });
  assert.deepEqual(customerCalls, ['ForgotPassword']);
  // The team pool's own refusal is the one shown: the customer pool's "not right" says nothing about this account.
  assert.deepEqual(await account.confirmForgotPassword(TEAM.email, '999999', 'a new long password'), {
    ok: false,
    problem: 'expired-code',
  });
  assert.deepEqual(await account.confirmForgotPassword(TEAM.email, '123456', 'a new long password'), { ok: true });
  assert.deepEqual(customerCalls, ['ForgotPassword', 'ConfirmForgotPassword']);
  assert.equal(site.plainestProblem(['wrong-code', 'too-many']), 'too-many');
  assert.equal(site.plainestProblem(['failed', 'wrong-code']), 'wrong-code');
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

const STAFF = {
  email: 'manager@example.invalid',
  userId: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  password: 'Only-For-Tests-7',
  code: '135790',
};
let copies = 0;

// In the phone app (docs/mobile-apps.md, "The app shell"): the customer API and the console at their own
// addresses, and Cognito's user pool API of the pools' Region.
const APP_CUSTOMER_API = 'https://cranium.example';
const APP_CONSOLE = 'https://console.example';
const APP_IDP = 'https://cognito-idp.xx-test-1.amazonaws.com';
const APP_CONFIG = {
  consoleUrl: APP_CONSOLE,
  region: 'xx-test-1',
  userPoolId: STAFF_POOL,
  mobileClientId: 'staffclient',
  customerApiUrl: APP_CUSTOMER_API,
  customerRegion: 'xx-test-1',
  customerUserPoolId: CUSTOMER_POOL,
  customerClientId: 'customerclient',
  example: false,
};

/**
 * The customer site, started in a stand-in for a tab, with both pools and the customer API behind it.
 * With `app`, the tab is the iPhone app's, with a stand-in for its bridge: answers by method.
 */
async function openSite(
  t,
  {
    hash = '',
    status = 'CONFIRMED',
    app: phone = null,
    liveUrl = null,
    WebSocket = null,
    local = null,
    board: served = BOARD,
  } = {}
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  // Node has a WebSocket of its own: a tab never gets it, only the stand-in it is given (docs/live.md).
  const realSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: WebSocket ?? undefined, configurable: true, writable: true });
  t.after(() =>
    Object.defineProperty(globalThis, 'WebSocket', { value: realSocket, configurable: true, writable: true })
  );
  const { cognito: customers, accounts } = customerWorld({ status });
  const staff = createCognito({
    userPoolId: STAFF_POOL,
    clientId: 'staffclient',
    users: [{ ...STAFF, groups: ['release-managers'] }],
    now: () => NOW,
    issue: () => ({ AccessToken: 'STAFF-TOKEN', ExpiresIn: 3600, RefreshToken: 'STAFF-REFRESH', IdToken: 'ID' }),
  });
  const document = createDocument(['skip', 'landing', 'app', 'toasts', 'announcer']);
  document.getElementById('app').hidden = true;
  document.visibilityState = 'visible';
  document.querySelector = (selector) =>
    selector === 'meta[name="cranium-config"]'
      ? { content: JSON.stringify(liveUrl ? { ...SITE_CONFIG, liveUrl } : SITE_CONFIG) }
      : null;
  const stored = new Map();
  const sessionStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key),
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
    get hash() {
      return address;
    },
    set hash(value) {
      address = value;
      for (const listener of [...(listeners.get('hashchange') ?? [])]) listener({ type: 'hashchange' });
    },
    assign: (url) => navigations.push(url),
  };
  const requests = [];
  const addresses = [];
  // What the customer changed, as the customer API would keep it (cloud/api/src/customer/app.mjs).
  let board = { ...served };
  let choices = { offline: false, updated: false, unexpectedRestart: false };
  const writes = [];
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
      if (url === `/api/c/boards/${BOARD.id}/label` && init.method === 'POST') {
        const { label } = JSON.parse(init.body);
        writes.push({ url, body: JSON.parse(init.body), type: init.headers['content-type'] });
        if (label.length > 40) {
          return Response.json(
            { error: { code: 'label_too_long', message: "A board's name is at most 40 characters." } },
            { status: 400 }
          );
        }
        board = { ...board, label: label || null, name: label || BOARD.name };
        return Response.json({ board });
      }
      if (url === '/api/c/preferences') {
        if (init.method === 'POST') {
          writes.push({ url, body: JSON.parse(init.body), type: init.headers['content-type'] });
          choices = { ...choices, ...JSON.parse(init.body) };
        }
        return Response.json({ notifications: choices, emails: 'off' });
      }
      if (url === '/api/c/me') return Response.json({ email: 'ada@example.invalid', name: 'Ada', boards: 1 });
      if (url === '/api/c/boards') return Response.json({ boards: [board] });
      if (url === '/api/c/activity')
        return Response.json({
          activity: [{ at: BOARD.lastSeen, board: BOARD.id, kind: 'connection', what: 'connected' }],
        });
      if (url === `/api/c/boards/${BOARD.id}`) return Response.json({ board, activity: [] });
      return Response.json(
        { error: { code: 'not_your_board', message: 'There is no board of yours at this address.' } },
        { status: 404 }
      );
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
    btoa: globalThis.btoa,
    fetch,
    sessionStorage,
    // The browser's localStorage, when the test gives one (a Map): none otherwise, as when a browser keeps nothing.
    ...(local
      ? {
          localStorage: {
            getItem: (key) => local.get(key) ?? null,
            setItem: (key, value) => local.set(key, String(value)),
            removeItem: (key) => local.delete(key),
          },
        }
      : {}),
    location,
    history: {
      replaceState() {
        location.search = '';
      },
    },
    navigator: { clipboard: { writeText: async () => {} } },
  };
  const appCalls = [];
  if (phone) {
    const answers = {
      'app.hello': {
        bridge: 1,
        platform: 'ios',
        shell: { version: '0.8.0', build: '14' },
        bundle: {},
        features: ['auth', 'biometric', 'clipboard', 'open', 'settings'],
      },
      'app.config': APP_CONFIG,
      'app.ready': {},
      'auth.session': { signedIn: false },
      'auth.store': { biometric: { available: true, kind: 'faceID', enabled: false } },
      'biometric.status': { available: true, kind: 'faceID', enabled: false },
      ...phone,
    };
    window.webkit = {
      messageHandlers: {
        cranium: {
          postMessage(text) {
            const message = JSON.parse(text);
            appCalls.push(message);
            const result =
              typeof answers[message.method] === 'function'
                ? answers[message.method](message.params)
                : answers[message.method];
            queueMicrotask(() => {
              const detail = JSON.stringify(
                result === undefined
                  ? { id: message.id, ok: false, error: { code: 'unknown_method', message: 'No such method.' } }
                  : { id: message.id, ok: true, result }
              );
              for (const listener of [...(listeners.get('cranium-native') ?? [])])
                listener({ type: 'cranium-native', detail });
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
  await import(
    customerScript(
      'customer.js',
      {
        'core.js': CORE,
        'views.js': VIEWS,
        'customer-core.js': SITE_CORE,
        'customer-views.js': SITE_VIEWS,
        'bridge.js': BRIDGE,
        'customer-mixes.js': SITE_MIXES,
        'live.js': LIVE,
      },
      `tab ${copies}`
    )
  );
  await settle();
  const app = document.getElementById('app');
  return {
    document,
    location,
    stored,
    writes,
    requests,
    addresses,
    appCalls,
    navigations,
    accounts,
    app,
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
  await until(
    () => tab.location.hash === '#/sign-in' && tab.document.getElementById('signin-email') !== null,
    'the sign-in page'
  );
  assert.equal(tab.landing.hidden, true);
  assert.match(tab.text(), /Sign in With the e-mail address and the password of your Cranium account\./);
  // One form for everybody: no choice of admin or customer, and the way to a new password for all.
  assert.doesNotMatch(tab.text(), /Admin sign-in|Customer sign-in/);
  assert.equal(
    all(tab.app, 'a').some((link) => link.getAttribute('href') === '#/admin-sign-in'),
    false
  );
  assert.ok(all(tab.app, 'a').some((link) => link.getAttribute('href') === '#/forgot'));
  tab.go('#/help');
  await until(() => /How can we help\?/.test(tab.text()), 'the help page');
  assert.equal(tab.location.hash, '#/help');
  assert.match(tab.text(), /A support address for customers is not set up yet/);
  assert.equal(
    tab.requests.filter((line) => line.includes('/api/')).length,
    0,
    'nothing is asked of the API while signed out'
  );
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
  assert.equal(tab.stored.has('cranium.session'), false, "the console's keys stay the admin's");

  // The list has a dot for each board's health, said for screen readers too.
  const dot = one(tab.app, 'span.cs-health-dot');
  assert.equal(dot.getAttribute('class'), 'cs-health-dot is-attention');
  assert.match(text, /Restarted unexpectedly twice this week/);

  tab.go(`#/devices/${BOARD.id}`);
  await until(() => /How it is/.test(tab.text()), 'the board');
  assert.match(tab.text(), /Location Not reported: boards cannot tell where they are yet\./);
  // The week: the sentence, and seven days of restarts, two of them unexpected.
  assert.match(tab.text(), /This week Restarted unexpectedly twice this week/);
  const strip = one(tab.app, 'span.cs-week');
  assert.equal(all(strip, '.cs-week-day').length, 7);
  assert.equal(all(strip, '.cs-week-mark.is-unexpected').length, 2);
  assert.equal(all(strip, '.cs-week-mark.is-expected').length, 1);
  assert.match(strip.getAttribute('aria-label'), /^Restarts this week: .*unexpected.*\.$/);
  assert.doesNotMatch(tab.text(), /Fault|watchdog|stack|core ?dump/i);
  tab.go('#/mixes/transitions');
  await until(() => /The space between tracks\./.test(tab.text()), 'the mixes');
  // The demo first, said to be made up; the journal is empty, and says why.
  assert.match(tab.text(), /Made-up sessions, to show what this will be/);
  assert.match(tab.text(), /Copper Light → Low Tide Radio/);
  click(all(tab.app, 'button').find((button) => textOf(button) === 'My journal'));
  await until(() => /Your journal is empty\./.test(tab.text()), 'the empty journal');
  assert.match(tab.text(), /Not built yet/);
  assert.match(tab.text(), /Nothing here is made up in the meantime\./);
  // No admin mode for a customer.
  assert.equal(
    all(tab.app, 'a').some((link) => link.getAttribute('href') === '/admin'),
    false
  );
});

test('the overview: figures, the boards and what they did; the account page labels every field', async (t) => {
  const tab = await openSite(t);
  await signInAsCustomer(tab);
  await until(() => all(tab.app, 'div.cs-tiles').length === 2 && /Came online/.test(tab.text()), 'the overview');
  assert.match(tab.text(), /Hello, Ada\./);
  assert.match(tab.text(), /Online now 1 of 1/);
  // Each board on the overview says how its week went, with its strip.
  assert.match(tab.text(), /Restarted unexpectedly twice this week/);
  assert.equal(all(tab.app, 'span.cs-week').length, 1);
  tab.go('#/account');
  await until(() => tab.document.getElementById('current-password') !== null, 'the account page');
  for (const el of descendants(tab.app).filter(
    (node) => node.localName === 'input' && node.getAttribute('type') !== 'hidden'
  )) {
    assert.ok(
      el.parentNode.localName === 'label' || el.getAttribute('aria-label'),
      `input ${el.getAttribute('id')} has a label`
    );
  }
  await until(() => /Two-step sign-in/.test(tab.text()) && /Turn on/.test(tab.text()), 'the authenticator card');
});

test('with the live API, a change to one of her boards makes the page read them again at once; a board page only for its board', async (t) => {
  const sockets = [];
  class FakeSocket {
    constructor(url, protocols) {
      Object.assign(this, { url, protocols });
      sockets.push(this);
    }
    send() {}
    close() {}
  }
  const tab = await openSite(t, { liveUrl: 'wss://live.example/live', WebSocket: FakeSocket });
  // Signed out: no WebSocket.
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(sockets.length, 0);
  await signInAsCustomer(tab);
  await until(() => all(tab.app, 'div.cs-tiles').length === 2, 'the overview');
  t.mock.timers.tick(5000);
  await until(() => sockets.length === 1, 'the WebSocket');
  assert.equal(sockets[0].url, 'wss://live.example/live');
  assert.equal(sockets[0].protocols[0], 'cranium-live');
  sockets[0].onopen({});
  const boardsRead = () => tab.requests.filter((line) => line === 'GET /api/c/boards').length;
  const before = boardsRead();
  sockets[0].onmessage({ data: JSON.stringify({ type: 'changed', boards: [BOARD.id], what: ['board'], at: 'x' }) });
  t.mock.timers.tick(300);
  await until(() => boardsRead() === before + 1, 'the boards read again');

  // On her board's page, a change to another board is not hers to read.
  tab.go(`#/devices/${BOARD.id}`);
  await until(() => tab.requests.includes(`GET /api/c/boards/${BOARD.id}`), 'the board page');
  await settle();
  const boardRead = () => tab.requests.filter((line) => line === `GET /api/c/boards/${BOARD.id}`).length;
  const once = boardRead();
  sockets[0].onmessage({
    data: JSON.stringify({ type: 'changed', boards: ['ffffffffffffffff'], what: ['board'], at: 'x' }),
  });
  t.mock.timers.tick(300);
  await settle();
  assert.equal(boardRead(), once);
  sockets[0].onmessage({ data: JSON.stringify({ type: 'changed', boards: [BOARD.id], what: ['updates'], at: 'x' }) });
  t.mock.timers.tick(300);
  await until(() => boardRead() === once + 1, 'the board read again');
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
  await until(() => all(tab.app, 'div.cs-tiles').length === 2, 'the overview');
  assert.equal(tab.accounts.get('5d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6').status, 'CONFIRMED');
});

test('an admin signs in on the one form with password and code, lands in admin mode at /admin, and has the site too', async (t) => {
  const tab = await openSite(t);
  tab.go('#/sign-in');
  await until(() => tab.document.getElementById('signin-email') !== null, 'the sign-in');
  assert.doesNotMatch(tab.text(), /Admin sign-in/);
  // Typed with capitals: the team pool's names are lower case.
  await tab.type('signin-email', 'Manager@Example.invalid');
  tab.document.getElementById('signin-password').value = STAFF.password;
  tab.submit();
  await until(() => tab.document.getElementById('code-digit-1') !== null, 'the six boxes');
  assert.equal(all(tab.app, 'input.code-digit').length, 6);
  const first = tab.document.getElementById('code-digit-1');
  first.value = STAFF.code;
  first.dispatchEvent({ type: 'input', target: first, data: STAFF.code });
  await until(() => tab.navigations.includes('/admin'), 'admin mode');
  assert.deepEqual(tab.navigations, ['/admin']);
  // The session is under the console's own keys: the console at /admin reads it from this tab.
  assert.equal(JSON.parse(tab.stored.get('cranium.session')).accessToken, 'STAFF-TOKEN');
  assert.equal(tab.stored.has('customer:cranium.session'), false);
  assert.equal(
    tab.requests.filter((line) => line === 'POST https://idp.example/').length,
    4,
    "the team pool's three steps and the revocation: the customer pool is never asked"
  );
  // The customer site stays open to the admin, with admin mode where a customer has their boards.
  tab.go('#/overview');
  await until(() => /The console, for every board\./.test(tab.text()), 'the admin overview');
  const ways = all(tab.app, 'a').filter((link) => link.getAttribute('href') === '/admin');
  assert.ok(ways.length >= 2, 'the panel and the sidebar');
  assert.ok(ways.every((link) => /admin mode/i.test(textOf(link))));
  await until(() => /release manager/.test(tab.text()), 'who the admin is');
  // No token in any address.
  for (const link of all(tab.app, 'a')) assert.doesNotMatch(link.getAttribute('href') ?? '', /TOKEN|token=/);
  // Every link of the side panel (and of the tab bar of a small screen) opens its own page for an admin, who has no
  // boards of their own: not the overview, which Devices and Account once fell back to.
  const titles = new Map([
    ['overview', 'Find your next great mix.'],
    ['devices', 'Boards, for admins'],
    ...MIX_TITLES,
    ['account', 'Your account'],
    ['help', 'How can we help?'],
    ['about', 'Your DJ controller, without the laptop.'],
  ]);
  await openEverySection(tab, titles);
  // A board's own page is a customer's: an admin gets the list's page.
  tab.go(`#/devices/${BOARD.id}`);
  await until(() => tab.location.hash === '#/devices', 'the devices page');
  assert.match(tab.text(), /Boards, for admins/);
  assert.ok(
    all(tab.app, 'a').some((link) => link.getAttribute('href') === '/admin' && /admin mode/i.test(textOf(link)))
  );
});

// The mixes' four pages, in the side panel; the tab bar of a small screen has the first three.
const MIX_TITLES = [
  ['mixes/sessions', 'Every set has a story.'],
  ['mixes/transitions', 'The space between tracks.'],
  ['mixes/library', 'Your rotation, revealed.'],
  ['mixes/listening', 'Your week on the decks.'],
  ['mixes/moments', 'Keep the good ones.'],
];
const TAB_BAR = ['overview', 'mixes/sessions', 'mixes/transitions', 'mixes/library', 'devices'];

/** Click each link of the sections, as the browser follows an anchor, and check the page that opens. */
async function openEverySection(tab, titles) {
  for (const group of ['a.cs-nav-link', 'a.cs-tab']) {
    for (const [view, title] of titles) {
      if (group === 'a.cs-tab' && !TAB_BAR.includes(view)) continue;
      tab.go('#/help');
      await until(() => tab.location.hash === '#/help', 'help');
      const link = all(tab.app, group.split('.')[0])
        .filter((a) => a.getAttribute('class') === group.split('.')[1])
        .find((a) => a.getAttribute('href') === `#/${view}`);
      assert.ok(link, `${group} to ${view} exists`);
      link.dispatchEvent({ type: 'click', target: link });
      tab.go(link.getAttribute('href'));
      await until(
        () =>
          tab.location.hash === `#/${view}` &&
          descendants(tab.app).some((el) => el.getAttribute('id') === 'page-title' && textOf(el) === title),
        `${view} to open as "${title}"`
      );
      assert.equal(tab.location.hash, `#/${view}`, `${group} to ${view} stays there`);
    }
  }
}

test('a customer opens every section of the side panel and the tab bar, and each is its own page', async (t) => {
  const tab = await openSite(t);
  await signInAsCustomer(tab);
  await until(() => all(tab.app, 'div.cs-tiles').length === 2, 'the overview');
  const titles = new Map([
    ['overview', 'Find your next great mix.'],
    ['devices', 'Your boards'],
    ...MIX_TITLES,
    ['account', 'Your account'],
    ['help', 'How can we help?'],
    ['about', 'Your DJ controller, without the laptop.'],
  ]);
  await openEverySection(tab, titles);
});

test('signing out ends the session in the tab and takes it home', async (t) => {
  const tab = await openSite(t);
  await signInAsCustomer(tab);
  await until(() => all(tab.app, 'div.cs-tiles').length === 2, 'the overview');
  click(all(tab.app, 'button').find((button) => /Sign out/.test(textOf(button))));
  await settle();
  assert.deepEqual(tab.navigations, [HOME]);
  assert.equal(tab.stored.has('customer:cranium.session'), false);
});

test("in the phone app the site opens on its sign-in, and the customer's refresh token goes to the app, never into the tab", async (t) => {
  const tab = await openSite(t, { app: {} });
  await until(() => tab.document.getElementById('signin-email') !== null, 'the sign-in page');
  assert.equal(tab.landing.hidden, true, 'no home page in the app');
  assert.deepEqual(
    tab.appCalls.slice(0, 2).map((message) => message.method),
    ['app.hello', 'app.config']
  );
  assert.deepEqual(
    tab.appCalls
      .filter((message) => message.method === 'auth.session')
      .map((message) => message.params.pool)
      .sort(),
    ['admin', 'customer']
  );
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
  assert.equal(
    tab.requests.some((line) => line.includes('RevokeToken')),
    false
  );
  assert.ok(tab.addresses.includes(`${APP_CUSTOMER_API}/api/c/boards`));
  assert.ok(
    tab.addresses.every((address) => !address.startsWith('/')),
    "nothing at the page's own origin"
  );
  // The account page has the phone's own card.
  tab.go('#/account');
  await until(() => /On this phone/.test(tab.text()), 'the account page');
  assert.match(tab.text(), /iPhone app 0\.8\.0 \(14\)/);
  assert.match(tab.text(), /Unlock with Face ID/);
});

test('in the phone app, signing out of the customer side makes the app forget both sign-ins, as the website does', async (t) => {
  const tab = await openSite(t, {
    app: {
      'auth.session': ({ pool }) =>
        pool === 'admin' ? { signedIn: true, accessToken: 'STAFF-TOKEN', expiresIn: 3600 } : { signedIn: false },
      'auth.signOut': {},
    },
  });
  // The admin is signed in already, from the app: the customer signs in as well, on the same one form.
  await until(() => /The console, for every board/.test(tab.text()), 'the admin overview');
  tab.go('#/sign-in');
  await until(() => tab.document.getElementById('signin-email') !== null, 'the sign-in page');
  await tab.type('signin-email', 'ada@example.invalid');
  tab.document.getElementById('signin-password').value = 'her own password';
  tab.submit();
  await until(() => /Hello, Ada\./.test(tab.text()), 'the overview');
  click(all(tab.app, 'button').find((button) => textOf(button) === 'Sign out'));
  await until(() => tab.appCalls.filter((message) => message.method === 'auth.signOut').length === 2, 'both sign-outs');
  assert.deepEqual(
    tab.appCalls
      .filter((message) => message.method === 'auth.signOut')
      .map((message) => message.params.pool)
      .sort(),
    ['admin', 'customer']
  );
  await until(() => tab.navigations.length === 1, 'the way home');
  assert.deepEqual(tab.navigations, ['cranium-app://bundle/']);
});

// The journal in the phone app: the app keeps it (storage.*), the page's own storage does not last on an iPhone.

const JOURNAL = 'cranium.mixes.journal.v1:ada@example.invalid';
const PREFS = 'cranium.mixes.prefs.v1';
const SET_CSV = [
  'session,started,title,artist,deck,start,end',
  'Friday,2026-11-03T20:30:00Z,Opening Track,Test Artist,A,0,5:10',
  'Friday,2026-11-03T20:30:00Z,Second Track,Other Artist,B,4:40,10:00',
].join('\r\n');
const OLDER_JOURNAL = JSON.stringify({
  sessions: [
    {
      title: 'Older set',
      startedAt: '2026-11-02T20:00:00.000Z',
      tracks: [{ title: 'Old Track', artist: 'Someone', start: 0, end: 300 }],
    },
  ],
  moments: [],
});

/** An app that keeps the page's values in a Map, and shares files into a list. */
function keepingApp(
  kept,
  shared = [],
  features = ['auth', 'biometric', 'clipboard', 'open', 'settings', 'share', 'storage']
) {
  return {
    'app.hello': { bridge: 1, platform: 'ios', shell: { version: '0.8.2', build: '15' }, bundle: {}, features },
    'storage.get': ({ key }) => ({ value: kept.get(key) ?? null }),
    'storage.set': ({ key, value }) => {
      kept.set(key, value);
      return {};
    },
    'storage.remove': ({ key }) => {
      kept.delete(key);
      return {};
    },
    'file.share': (params) => {
      shared.push(params);
      return {};
    },
  };
}

async function signedInInApp(t, app, options = {}) {
  const tab = await openSite(t, { app, ...options });
  await until(() => tab.document.getElementById('signin-email') !== null, 'the sign-in page');
  await signInAsCustomer(tab);
  await until(() => /Hello, Ada\./.test(tab.text()), 'the overview');
  return tab;
}

const buttonNamed = (tab, label) => all(tab.app, 'button').find((button) => textOf(button).includes(label));

async function openImport(tab) {
  tab.go('#/mixes/sessions');
  await until(() => buttonNamed(tab, 'Import session') !== undefined, 'the mixes');
  click(buttonNamed(tab, 'Import session'));
  await until(() => all(tab.app, 'input.cs-file-input').length > 0, 'the import dialog');
}

async function importSet(tab, name = 'set.csv', text = SET_CSV) {
  await openImport(tab);
  const input = one(tab.app, 'input.cs-file-input');
  const file = { name, size: text.length, text: async () => text };
  input.files = [file];
  input.dispatchEvent({ type: 'change' });
  await until(() => /Imported 1 session/.test(tab.text()), 'the import');
}

test('in the phone app, an imported session file is kept by the app, with the choice of the journal', async (t) => {
  const kept = new Map();
  const tab = await signedInInApp(t, keepingApp(kept));
  await importSet(tab);
  const stored = JSON.parse(kept.get(JOURNAL));
  assert.equal(stored.sessions.length, 1);
  assert.equal(stored.sessions[0].title, 'Friday');
  assert.equal(JSON.parse(kept.get(PREFS)).source, 'journal');
  // The page's own storage is not where it went.
  assert.equal(tab.stored.size, 0);
});

test('in the phone app, Back up and CSV go through the share sheet as files', async (t) => {
  const shared = [];
  const tab = await signedInInApp(t, keepingApp(new Map(), shared));
  await importSet(tab);
  click(one(tab.app, 'button.cs-export'));
  await until(() => buttonNamed(tab, 'Back up') !== undefined, 'the Back up button');
  click(buttonNamed(tab, 'Back up'));
  click(all(tab.app, 'button').find((button) => textOf(button) === 'CSV'));
  await until(() => shared.length === 2, 'both files');
  assert.equal(shared[0].type, 'application/json');
  assert.match(shared[0].name, /\.json$/);
  assert.equal(JSON.parse(Buffer.from(shared[0].data, 'base64').toString('utf8')).sessions.length, 1);
  assert.equal(shared[1].type, 'text/csv');
  assert.match(shared[1].name, /\.csv$/);
  assert.match(Buffer.from(shared[1].data, 'base64').toString('utf8'), /^session,started,title/);
});

test('in the phone app, the kept journal is there again at the next start', async (t) => {
  const kept = new Map();
  const first = await signedInInApp(t, keepingApp(kept));
  await importSet(first);
  t.mock.timers.reset();
  await t.test('the next start', async (next) => {
    const again = await signedInInApp(next, keepingApp(kept));
    again.go('#/mixes/sessions');
    await until(() => /Friday/.test(again.text()), 'the kept session');
    assert.equal(again.stored.size, 0);
  });
});

test("in the phone app, a journal an older app left in the page's storage is moved to the app once", async (t) => {
  const kept = new Map();
  const tab = await signedInInApp(t, keepingApp(kept), { local: new Map([[JOURNAL, OLDER_JOURNAL]]) });
  await until(() => kept.has(JOURNAL), 'the move');
  assert.equal(JSON.parse(kept.get(JOURNAL)).sessions[0].title, 'Older set');
  tab.go('#/mixes/sessions');
  await until(() => buttonNamed(tab, 'My journal') !== undefined, 'the mixes');
  click(buttonNamed(tab, 'My journal'));
  await until(() => /Older set/.test(tab.text()), 'the older session');
});

test('an app without storage says it cannot keep the journal, and asks the app for nothing', async (t) => {
  const tab = await signedInInApp(t, keepingApp(new Map(), [], ['auth', 'biometric', 'clipboard', 'open', 'settings']));
  await openImport(tab);
  assert.match(tab.text(), /This app cannot keep the journal/);
  assert.equal(
    tab.appCalls.some((message) => message.method.startsWith('storage.')),
    false
  );
});

// About: what Cranium is and the team, for anybody, signed in or not, on the website and in the apps.

const FOUNDERS = ['Vihaan Ravishankar', 'Demetrius Bosket', 'Adam Shalabi', 'Christian Durante'];

/** The About page as drawn: its founders, each with the name of their portrait and its initials, if any. */
function aboutPage(tab) {
  const people = all(tab.app, 'li').filter((li) => li.getAttribute('class') === 'cs-person');
  return people.map((person) => {
    const [portrait] = descendants(person).filter((el) => /\bcs-person-photo\b/.test(el.getAttribute('class') ?? ''));
    const tag = portrait.tagName.toLowerCase();
    return {
      name: textOf(all(person, 'h3')[0]),
      role: textOf(all(person, 'p')[0]),
      tag,
      label: portrait.getAttribute('alt') ?? portrait.getAttribute('aria-label'),
      src: portrait.getAttribute('src'),
      initials: tag === 'img' ? null : textOf(portrait),
    };
  });
}

function checkAbout(tab) {
  const main = one(tab.app, 'main');
  const words = textOf(main);
  assert.match(words, /About Cranium/);
  assert.match(words, /mounts on a beginner DJ controller, starting with the Pioneer FLX4/);
  assert.match(words, /no longer needs a laptop/);
  assert.match(words, /Bluetooth LE Audio/);
  assert.match(words, /Raspberry Pi drives the screen/);
  assert.match(words, /New and intermediate DJs who play on an FLX4/);
  assert.match(words, /about \$200/);
  // No market figures, no other company's name, no address.
  assert.doesNotMatch(words, /\$\d+M|million|XDJ|Numark|Denon|DeckShark|@/);
  assert.deepEqual(all(main, 'h2').map(textOf), ['What it is', 'The problem', 'Who it is for', 'The team']);
  const people = aboutPage(tab);
  assert.deepEqual(
    people.map((person) => person.name),
    FOUNDERS
  );
  assert.ok(people.every((person) => person.role === 'Founder'));
  assert.ok(
    people.every((person) => person.label === person.name),
    'every portrait is named for its person'
  );
  // Whoever has a photo in cloud/web/team-photos/ shows it; everyone else shows their initials.
  const withPhoto = new Set(['Vihaan Ravishankar', 'Adam Shalabi']);
  const initials = {
    'Demetrius Bosket': 'DB',
    'Adam Shalabi': 'AS',
    'Christian Durante': 'CD',
    'Vihaan Ravishankar': 'VR',
  };
  for (const person of people) {
    if (withPhoto.has(person.name)) {
      assert.equal(person.tag, 'img', person.name);
      assert.match(person.src, /^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/, person.name);
    } else {
      assert.deepEqual([person.tag, person.initials], ['span', initials[person.name]], person.name);
    }
  }
}

test('About: signed out, the home page links to it, and it says what Cranium is and who makes it', async (t) => {
  for (const nav of ['cs-landing-nav', 'cs-landing-foot-nav']) {
    assert.match(page, new RegExp(`class="${nav}"[^>]*>[^]*?<a href="#/about">About</a>[^]*?</nav>`), nav);
  }
  const tab = await openSite(t);
  tab.go('#/about');
  await until(() => /The team/.test(tab.text()), 'the about page');
  assert.equal(tab.location.hash, '#/about');
  assert.equal(tab.landing.hidden, true);
  assert.equal(tab.document.title, 'About · Cranium');
  checkAbout(tab);
  assert.ok(all(tab.app, 'a').some((link) => link.getAttribute('href') === '#/sign-in'));
  assert.ok(all(tab.app, 'a').some((link) => link.getAttribute('href') === '#/help'));
  // From the sign-in page too.
  tab.go('#/sign-in');
  await until(() => tab.document.getElementById('signin-email') !== null, 'the sign-in page');
  assert.ok(all(tab.app, 'a').some((link) => link.getAttribute('href') === '#/about'));
  assert.equal(
    tab.requests.filter((line) => line.includes('/api/')).length,
    0,
    'nothing is asked of the API while signed out'
  );
});

test('About: signed in, it is in the side panel and the foot of every page', async (t) => {
  const tab = await openSite(t);
  await signInAsCustomer(tab);
  await until(() => all(tab.app, 'div.cs-tiles').length === 2, 'the overview');
  assert.ok(
    all(tab.app, 'a').some(
      (link) => link.getAttribute('class') === 'cs-nav-link' && link.getAttribute('href') === '#/about'
    )
  );
  const foot = all(tab.app, 'footer').find((footer) => footer.getAttribute('class') === 'cs-foot');
  assert.ok(all(foot, 'a').some((link) => link.getAttribute('href') === '#/about'));
  tab.go('#/about');
  await until(() => /The team/.test(tab.text()), 'the about page');
  checkAbout(tab);
  // In the studio's frame, with no way to sign in again.
  assert.equal(all(tab.app, 'aside').length, 1);
  assert.equal(
    all(tab.app, 'a').some((link) => link.getAttribute('href') === '#/sign-in'),
    false
  );
});

test('About: in the phone app it opens before the sign-in, from the sign-in page, and after it', async (t) => {
  const tab = await openSite(t, { app: {} });
  await until(() => tab.document.getElementById('signin-email') !== null, 'the sign-in page');
  assert.ok(
    all(tab.app, 'a').some((a) => a.getAttribute('href') === '#/about'),
    'the sign-in page links to About'
  );
  tab.go('#/about');
  await until(() => /The team/.test(tab.text()), 'the about page');
  assert.equal(tab.location.hash, '#/about', 'not sent to the sign-in');
  checkAbout(tab);
  await signInAsCustomer(tab);
  await until(() => /Hello, Ada\./.test(tab.text()), 'the overview');
  tab.go('#/about');
  await until(() => /The team/.test(tab.text()) && all(tab.app, 'aside').length === 1, 'the about page, signed in');
  checkAbout(tab);
});

test("About: the team's photos are the folder's, small, and a person without one gets initials", async () => {
  const { MAX_PHOTO_BYTES, MODULE_PATH, photosModule, readPhotos } = await import('../build-team-photos.mjs');
  const photos = readPhotos();
  assert.equal(
    readFileSync(MODULE_PATH, 'utf8'),
    photosModule(photos),
    'customer-team-photos.js is what node cloud/web/build-team-photos.mjs writes'
  );
  assert.deepEqual(Object.keys(photos).sort(), ['adam-shalabi', 'vihaan-ravishankar']);
  for (const uri of Object.values(photos)) {
    const bytes = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
    assert.ok(bytes.length <= MAX_PHOTO_BYTES, `${bytes.length} bytes`);
  }
  // Every founder's photo has a name the folder can hold.
  const views = await import(SITE_VIEWS);
  for (const [, photo] of views.TEAM) assert.match(`${photo}.webp`, /^[a-z]+(?:-[a-z]+)+\.webp$/);
});

// A customer's changes (docs/customer-site.md, "Customer actions").

test('Rename: a dialog with a label, the name as typed, saved to the API and shown at once; too long is refused', async (t) => {
  const tab = await openSite(t);
  await signInAsCustomer(tab);
  await until(() => /Hello, Ada\./.test(tab.text()), 'the overview');
  tab.go(`#/devices/${BOARD.id}`);
  await until(() => /How it is/.test(tab.text()), 'the board');
  assert.equal(all(tab.app, 'dialog').length, 0);
  click(all(tab.app, 'button').find((button) => /Rename/.test(textOf(button))));
  await until(() => tab.document.getElementById('board-name') !== null, 'the rename dialog');
  const dialog = one(tab.app, 'dialog');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'board-dialog-title');
  assert.match(textOf(dialog), /Rename this board/);
  const input = tab.document.getElementById('board-name');
  assert.equal(input.parentNode.localName, 'label', 'the field has a label');
  assert.equal(input.getAttribute('aria-describedby'), 'board-name-hint');

  // Too long: said before anything is sent.
  await tab.type('board-name', 'x'.repeat(41));
  assert.match(textOf(one(tab.app, 'dialog')), /1 characters too many\./);
  click(all(tab.app, 'button').find((button) => textOf(button) === 'Save the name'));
  await settle();
  assert.match(textOf(one(tab.app, 'dialog')), /At most 40 characters\./);
  assert.equal(tab.writes.length, 0);

  await tab.type('board-name', '  Kitchen deck ');
  click(all(tab.app, 'button').find((button) => textOf(button) === 'Save the name'));
  await until(() => all(tab.app, 'dialog').length === 0, 'the dialog to close');
  assert.deepEqual(tab.writes, [
    { url: `/api/c/boards/${BOARD.id}/label`, body: { label: 'Kitchen deck' }, type: 'application/json' },
  ]);
  assert.equal(one(tab.app, 'h1').textContent ?? textOf(one(tab.app, 'h1')), 'Kitchen deck');
  assert.ok(tab.requests.includes(`POST /api/c/boards/${BOARD.id}/label`));
  // Cancel closes it and sends nothing.
  click(all(tab.app, 'button').find((button) => /Rename/.test(textOf(button))));
  await until(() => tab.document.getElementById('board-name') !== null, 'the dialog again');
  assert.equal(tab.document.getElementById('board-name').value, 'Kitchen deck');
  click(all(tab.app, 'button').find((button) => textOf(button) === 'Cancel'));
  await until(() => all(tab.app, 'dialog').length === 0, 'the dialog to close');
  assert.equal(tab.writes.length, 1);
});

test('a waiting update: the board page says how to install it at the board, and offers no button that would', async (t) => {
  const tab = await openSite(t, {
    board: { ...BOARD, update: { state: 'awaiting_user', progress: 0, last: 'succeeded' } },
  });
  await signInAsCustomer(tab);
  await until(() => /Hello, Ada\./.test(tab.text()), 'the overview');
  tab.go(`#/devices/${BOARD.id}`);
  await until(() => /An update is waiting for you/.test(tab.text()), 'the waiting card');
  assert.match(tab.text(), /Press Button 1 on the board to install it, or Button 2 to turn it down\./);
  click(all(tab.app, 'button').find((button) => textOf(button) === 'How to install it'));
  await until(() => all(tab.app, 'dialog').length === 1, 'the instructions');
  const text = textOf(one(tab.app, 'dialog'));
  assert.match(text, /Install the waiting update/);
  assert.match(text, /Press Button 1 on the board/);
  assert.match(text, /over Bluetooth with the phone app/);
  assert.equal(
    all(one(tab.app, 'dialog'), 'button').some((button) => /^(Install|Accept|Approve)/.test(textOf(button))),
    false
  );
  click(all(tab.app, 'button').find((button) => textOf(button) === 'Got it'));
  await until(() => all(tab.app, 'dialog').length === 0, 'the dialog to close');
  assert.equal(tab.writes.length, 0);
  assert.equal(
    tab.requests.some((request) => request.startsWith('POST /api/')),
    false
  );
});

test('E-mails: three switches on the account page, off until turned on, each saved as it is turned', async (t) => {
  const tab = await openSite(t);
  await signInAsCustomer(tab);
  await until(() => /Hello, Ada\./.test(tab.text()), 'the overview');
  tab.go('#/account');
  await until(() => tab.document.getElementById('email-offline') !== null, 'the e-mails card');
  assert.match(tab.text(), /E-mails about your boards/);
  assert.match(tab.text(), /no e-mails go out yet/);
  for (const kind of ['offline', 'updated', 'unexpectedRestart']) {
    const box = tab.document.getElementById(`email-${kind}`);
    assert.equal(box.checked, false, kind);
    assert.equal(box.getAttribute('role'), 'switch');
    assert.equal(box.parentNode.localName, 'label');
  }
  // As a browser does: the box is ticked, then its change is told.
  tab.document.getElementById('email-offline').checked = true;
  click(tab.document.getElementById('email-offline'));
  await until(() => /Saved\./.test(tab.text()), 'the save');
  assert.deepEqual(tab.writes, [{ url: '/api/c/preferences', body: { offline: true }, type: 'application/json' }]);
  assert.equal(tab.document.getElementById('email-offline').checked, true);
  assert.equal(tab.document.getElementById('email-updated').checked, false);
});

test('on a narrow phone the top bar fits: Connect device is its icon, and keeps its words for a screen reader', async (t) => {
  const tab = await openSite(t);
  await signInAsCustomer(tab);
  await until(() => /Hello, Ada\./.test(tab.text()), 'the overview');
  const connect = one(tab.app, 'button.cs-connect');
  assert.equal(textOf(one(connect, 'span.cs-connect-label')), 'Connect device');
  assert.equal(connect.getAttribute('title'), 'Connect device');
  // At 375 px the brand, the two icons and the words were 13 px wider than the screen, at 360 px 28.
  const css = readFileSync(new URL('assets/customer.css', CUSTOMER_DIR), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // Each @media (max-width: N px) block's body, found by counting braces.
  const narrow = [...css.matchAll(/@media \(max-width: (\d+)px\) \{/g)]
    .filter((match) => Number(match[1]) >= 375 && Number(match[1]) < 560)
    .map((match) => {
      let depth = 1;
      let at = match.index + match[0].length;
      const start = at;
      for (; at < css.length && depth > 0; at += 1) depth += css[at] === '{' ? 1 : css[at] === '}' ? -1 : 0;
      return css.slice(start, at - 1);
    })
    .join('\n');
  assert.match(narrow, /\.cs-connect-label \{[^}]*clip-path: inset\(50%\)/);
  assert.match(narrow, /\.btn\.cs-connect \{[^}]*width: 34px/);
  // After the 560 px block, whose padding would otherwise win.
  assert.ok(css.indexOf('.cs-connect-label {') > css.lastIndexOf('@media (max-width: 560px)'));
});

test("on a 320 px phone the Overview's last set stays inside the page: its track table scrolls in its panel", () => {
  // The main column took the width of the track table (316 px) in a page of 288, and the page scrolled sideways.
  const css = readFileSync(new URL('assets/customer.css', CUSTOMER_DIR), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /(?:^|\n)\.cs-grid-main,\n\.cs-grid-side \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /(?:^|\n)\.cs-tracks \{[^}]*overflow-x: auto/);
});

test('in an app with offline mode, the sign-in page offers it above the form, and nowhere else does without it', async () => {
  const views = await import(SITE_VIEWS);
  const model = (offline) => ({
    kind: null,
    step: 'password',
    email: '',
    digits: ['', '', '', '', '', ''],
    busy: false,
    problem: null,
    tries: 0,
    lead: null,
    adminPath: '/admin',
    offline,
  });
  const find = (node, test) => {
    if (Array.isArray(node)) return node.map((child) => find(child, test)).find(Boolean) ?? null;
    if (!node || typeof node !== 'object') return null;
    return test(node) ? node : find(node.children ?? [], test);
  };
  const order = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.props?.class === 'cs-offline') order.push('offline');
    if (node.tag === 'form' || /signin-form/.test(node.props?.class ?? '')) order.push('form');
    walk(node.children ?? []);
  };
  const page = views.signInView(model(true));
  const link = find(page, (node) => node.props?.class === 'cs-offline');
  assert.ok(link, 'Offline mode is on the sign-in page');
  assert.equal(link.props.href, '/admin#/offline');
  assert.match(JSON.stringify(link), /Offline mode/);
  walk(page);
  assert.ok(order.indexOf('offline') > -1 && order.indexOf('offline') < order.indexOf('form'), order.join(' '));
  assert.equal(
    find(views.signInView(model(false)), (node) => node.props?.class === 'cs-offline'),
    null,
    'not on the website, or in an app without it'
  );
});
