/**
 * Tests for the function that serves the console: which paths it answers, what it
 * refuses, the headers on every reply and the settings it writes into the page.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createWebHandler, handler } from '../src/server.mjs';

const SITE = new URL('../src/site/', import.meta.url);
// The home page's own stylesheet is not part of the console: see home.test.mjs.
const ofConsole = (name) => !name.startsWith('.') && !name.startsWith('home.');
const DOMAIN = 'a1b2c3d4e5.execute-api.region-1.cloud.test';
const LOGIN = 'https://cranium-0a1b2c3d.auth.region-1.login.test';
// A made-up Region: the pool's ID names it, and the address of the user pool API follows.
const POOL = 'xx-test-1_Pool0Tests';
const USER_POOL_API = 'https://cognito-idp.xx-test-1.amazonaws.com';
const SETTINGS = {
  clientId: 'client-id-for-tests',
  loginOrigin: LOGIN,
  scope: 'openid cranium/console',
  userPoolId: POOL,
};

// Images also from OpenStreetMap's tile server, for the map (assets/map.js), and from nowhere else.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; " +
  `connect-src 'self' ${LOGIN} ${USER_POOL_API}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

/** An event as API Gateway sends it. A value given as undefined stays undefined. */
function request(rawPath, options = {}) {
  const { method, domainName, ...rest } = { method: 'GET', domainName: DOMAIN, ...options };
  return { rawPath, requestContext: { requestId: 'request-1', domainName, http: { method } }, ...rest };
}

function quiet(settings = SETTINGS) {
  return createWebHandler({ ...settings, log: () => {} });
}

const serve = quiet();

/** The build id, taken from the page the way a browser gets it. */
async function currentBuild() {
  const page = await serve(request('/'));
  return /\/assets\/([0-9a-f]{12})\/app\.css/.exec(page.body)[1];
}

/** What a browser reads from the settings attribute of the page. */
function settingsIn(html) {
  const matches = [...html.matchAll(/<meta name="cranium-config" content="([^"]*)">/g)];
  assert.equal(matches.length, 1, 'the page must carry exactly one settings tag');
  const raw = matches[0][1];
  assert.doesNotMatch(raw, /[<>"']/, 'the attribute value must not contain markup characters');
  const text = raw
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
  return JSON.parse(text);
}

function assertSecurityHeaders(response) {
  const { headers } = response;
  assert.equal(headers['content-security-policy'], CSP);
  assert.equal(headers['strict-transport-security'], 'max-age=63072000; includeSubDomains');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
  for (const feature of ['camera', 'microphone', 'geolocation', 'usb', 'payment']) {
    assert.match(headers['permissions-policy'], new RegExp(`(^|, )${feature}=\\(\\)(,|$)`));
  }
  // The serial console's page uses it, and only that page's own origin may.
  assert.match(headers['permissions-policy'], /(^|, )serial=\(self\)(,|$)/);
}

test('the page is served at / and is revalidated on every load', async () => {
  const response = await serve(request('/'));
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'no-cache');
  assert.equal(response.isBase64Encoded, false);
  assert.match(response.body, /^<!doctype html>/);
  assert.match(response.body, /Loading the console… reload the page if this does not go away\./);
  assert.match(response.body, /<noscript>/);
  assert.doesNotMatch(response.body, /%BUILD%|%CONFIG%/);
  assertSecurityHeaders(response);
});

test('the page carries the sign-in settings', async () => {
  const response = await serve(request('/'));
  assert.deepEqual(settingsIn(response.body), {
    clientId: SETTINGS.clientId,
    loginOrigin: LOGIN,
    scope: SETTINGS.scope,
    redirectUri: `https://${DOMAIN}/`,
    // For the console's own sign-in page: the pool, and its API in the pool's Region.
    userPoolId: POOL,
    idpOrigin: USER_POOL_API,
  });
});

test('the page may talk to itself, the login pages and the user pool API, and to nothing else', async () => {
  const policy = (await serve(request('/'))).headers['content-security-policy'];
  const connect = policy.split('; ').find((directive) => directive.startsWith('connect-src '));
  assert.deepEqual(connect.split(' ').slice(1), ["'self'", LOGIN, USER_POOL_API]);
  // Each pool talks to the API of its own Region.
  const elsewhere = await quiet({ ...SETTINGS, userPoolId: 'yy-other-2_AbC123' })(request('/'));
  assert.equal(settingsIn(elsewhere.body).idpOrigin, 'https://cognito-idp.yy-other-2.amazonaws.com');
  assert.match(
    elsewhere.headers['content-security-policy'],
    /connect-src 'self' \S+ https:\/\/cognito-idp\.yy-other-2\.amazonaws\.com;/
  );
  // Sending a form stays forbidden: the sign-in page never posts one.
  assert.match(policy, /(^|; )form-action 'none'(;|$)/);
});

test("with the live API, both sites' pages are told where it is, and may talk to its origin and no more of it", async () => {
  const LIVE = 'wss://f6e5d4c3b2.execute-api.region-1.cloud.test/live';
  const customer = { hosts: ['customer.test'], userPoolId: 'xx-test-1_Customers1', clientId: 'customer-client' };
  const live = quiet({ ...SETTINGS, customer, liveUrl: LIVE });
  const page = await live(request('/'));
  assert.equal(settingsIn(page.body).liveUrl, LIVE);
  const connect = (response) =>
    response.headers['content-security-policy'].split('; ').find((directive) => directive.startsWith('connect-src '));
  assert.deepEqual(connect(page).split(' ').slice(1), [
    "'self'",
    LOGIN,
    USER_POOL_API,
    'wss://f6e5d4c3b2.execute-api.region-1.cloud.test',
  ]);
  const site = await live(request('/', { domainName: 'customer.test' }));
  assert.equal(settingsIn(site.body).liveUrl, LIVE);
  assert.ok(connect(site).endsWith(' wss://f6e5d4c3b2.execute-api.region-1.cloud.test'));
  const admin = await live(request('/admin', { domainName: 'customer.test' }));
  assert.equal(settingsIn(admin.body).liveUrl, LIVE);
  // Without it, nothing about it.
  assert.equal(Object.hasOwn(settingsIn((await serve(request('/'))).body), 'liveUrl'), false);
  // Only a WebSocket address of a host and a stage: nothing that could add a source to the policy.
  for (const bad of [
    'https://x.test/live',
    'wss://x.test',
    "wss://x.test/live 'unsafe-inline'",
    'wss://x.test/live;',
    42,
  ]) {
    assert.throws(() => quiet({ ...SETTINGS, liveUrl: bad }), /liveUrl/, String(bad));
  }
});

test('a user pool ID that is not one is refused when the handler is made', () => {
  const refused = [
    'xx-test-1_Pool0Tests evil.example',
    'xx-test-1_Pool;script-src *',
    'xx-test-1_',
    '_Pool0Tests',
    'xx-test-1',
    'XX-TEST-1_Pool0Tests',
    'xx-test-1_Pool-0',
    'xx-test-1_Pool0Tests\n',
    '',
    undefined,
    null,
    5,
  ];
  for (const userPoolId of refused) {
    assert.throws(() => createWebHandler({ ...SETTINGS, userPoolId }), TypeError, String(userPoolId));
  }
  for (const idpOrigin of ['https://idp.example; script-src *', 'https://idp.example/', '', 7]) {
    assert.throws(() => createWebHandler({ ...SETTINGS, idpOrigin }), TypeError, String(idpOrigin));
  }
});

test('the redirect address is https on the domain of the request, unless one is given', async () => {
  const other = await serve(request('/', { domainName: 'other.execute-api.region-2.cloud.test' }));
  assert.equal(settingsIn(other.body).redirectUri, 'https://other.execute-api.region-2.cloud.test/');

  const loopback = 'http://127.0.0.1:8787';
  // The preview's stand-in for the user pool API answers on its login origin: named once.
  const preview = quiet({ ...SETTINGS, loginOrigin: loopback, idpOrigin: loopback, redirectUri: `${loopback}/` });
  const local = await preview(request('/', { domainName: 'ignored.example' }));
  const settings = settingsIn(local.body);
  assert.equal(settings.redirectUri, 'http://127.0.0.1:8787/');
  assert.equal(settings.loginOrigin, 'http://127.0.0.1:8787');
  assert.equal(settings.idpOrigin, 'http://127.0.0.1:8787');
  assert.match(local.headers['content-security-policy'], /connect-src 'self' http:\/\/127\.0\.0\.1:8787;/);
});

test('settings cannot break out of the attribute they are written into', async () => {
  const hostile = [
    '"><script>alert(1)</script>',
    "' onmouseover='alert(1)",
    '</head><body onload=alert(1)>',
    '&quot;&lt;&amp;#39;',
    'a&b<c>d"e\'f',
    "$& $' $` $1 $$",
    '%BUILD% %CONFIG%',
    'line\nbreak\ttab\u2028separator',
    '<!-- --!> ]]>',
  ];
  const template = readFileSync(new URL('index.html', SITE), 'utf8');
  const scripts = (html) => (html.match(/<script/gi) ?? []).length;

  for (const value of hostile) {
    for (const field of ['clientId', 'scope', 'redirectUri']) {
      const response = await quiet({ ...SETTINGS, [field]: value })(request('/'));
      assert.equal(response.statusCode, 200);
      assert.equal(settingsIn(response.body)[field], value, `${field} must come back unchanged`);
      assert.equal(scripts(response.body), scripts(template), 'no script element may be added');
    }
  }
});

test('a domain name that is not a host name is refused, not written into the page', async () => {
  for (const domainName of [
    'evil.example"><script>alert(1)</script>',
    "evil.example'",
    'two words.example',
    'evil.example/path',
    'evil.example:8443',
    'UPPER.example',
    '-leading.example',
    '',
    undefined,
    null,
    42,
  ]) {
    const response = await serve(request('/', { domainName }));
    assert.equal(response.statusCode, 400, String(domainName));
    assert.equal(response.body, 'Bad request\n');
    assert.equal(response.headers['cache-control'], 'no-store');
    assertSecurityHeaders(response);
  }
});

test('a login origin that could alter the security policy is refused when the handler is made', () => {
  const refused = [
    'https://login.example"><script>',
    'https://login.example; script-src *',
    'https://login.example,https://evil.example',
    'https://login.example evil.example',
    'https://login.example/',
    'https://login.example/path',
    'https://LOGIN.example',
    'javascript:alert(1)',
    '//login.example',
    'login.example',
    'https://',
    '',
    undefined,
    null,
  ];
  for (const loginOrigin of refused) {
    assert.throws(() => createWebHandler({ ...SETTINGS, loginOrigin }), TypeError, String(loginOrigin));
  }
  assert.throws(() => createWebHandler({ ...SETTINGS, clientId: '' }), TypeError);
  assert.throws(() => createWebHandler({ ...SETTINGS, scope: undefined }), TypeError);
  assert.throws(() => createWebHandler({ ...SETTINGS, redirectUri: 7 }), TypeError);
  assert.throws(() => createWebHandler(), TypeError);
});

test('every file of the site is served under the build id and may be cached for ever', async () => {
  const build = await currentBuild();
  const types = {
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    // Leaflet's licence, beside it.
    txt: 'text/plain; charset=utf-8',
  };
  const names = readdirSync(new URL('assets/', SITE)).filter(ofConsole);
  assert.equal(names.length > 0, true);

  for (const name of names) {
    const response = await serve(request(`/assets/${build}/${name}`));
    assert.equal(response.statusCode, 200, name);
    assert.equal(response.body, readFileSync(new URL(`assets/${name}`, SITE), 'utf8'));
    assert.equal(response.headers['content-type'], types[name.split('.').pop()]);
    assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(response.isBase64Encoded, false);
    assertSecurityHeaders(response);
  }
});

test('the build id is the first 12 hex digits of a SHA-256 over the names and contents', async () => {
  const names = [
    'index.html',
    ...readdirSync(new URL('assets/', SITE))
      .filter(ofConsole)
      .map((name) => `assets/${name}`),
  ].sort();
  const hash = createHash('sha256');
  for (const name of names) {
    const bytes = readFileSync(new URL(name, SITE));
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  assert.equal(await currentBuild(), hash.digest('hex').slice(0, 12));
});

test('everything the page refers to is served', async () => {
  const build = await currentBuild();
  const page = await serve(request('/'));
  const links = [...page.body.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((match) => match[1]);
  assert.equal(links.length > 0, true);
  for (const link of links) {
    assert.equal(link.startsWith(`/assets/${build}/`), true, link);
    assert.equal((await serve(request(link))).statusCode, 200, link);
  }
});

test('nothing outside the site can be reached, whatever the path says', async () => {
  const build = await currentBuild();
  const paths = [
    // Plain traversal.
    '/assets/../server.mjs',
    `/assets/${build}/../server.mjs`,
    `/assets/${build}/../../server.mjs`,
    `/assets/${build}/../../../test/server.test.mjs`,
    '/../server.mjs',
    '/server.mjs',
    '/site/index.html',
    `/assets/${build}/..`,
    `/assets/${build}/./app.js`,
    `/assets/${build}/sub/../app.js`,
    // Encoded traversal, once and twice.
    '/assets/%2e%2e/server.mjs',
    `/assets/${build}/%2e%2e/server.mjs`,
    `/assets/${build}/%2E%2E/server.mjs`,
    `/assets/${build}/..%2fserver.mjs`,
    `/assets/${build}/%2e%2e%2fserver.mjs`,
    `/assets/${build}/%252e%252e/server.mjs`,
    `/assets/${build}/..%5cserver.mjs`,
    `/assets/${build}/..\\server.mjs`,
    `/assets/${build}/\uff0e\uff0e/server.mjs`,
    `/assets/${build}/%c0%ae%c0%ae/server.mjs`,
    // Near misses of a real path.
    '/index.html',
    `/assets/${build}/index.html`,
    `/assets/${build}`,
    `/assets/${build}/`,
    `/assets/${build}/app.js/`,
    `/assets/${build}//app.js`,
    `/assets//${build}/app.js`,
    `//assets/${build}/app.js`,
    `/assets/${build}/APP.JS`,
    `/ASSETS/${build}/app.js`,
    `/assets/${build}/app.js%00`,
    `/assets/${build}/app.js\0.css`,
    `/assets/${build}/app.js?x=1`,
    `/assets/${build}/app.js#x`,
    ` /assets/${build}/app.js`,
    `/assets/${build}/app.js `,
    `/assets/${build}/missing.js`,
    `/assets/${build}/app.css.map`,
    '/assets/',
    '/assets',
    '/favicon.ico',
    '',
    // Names an object has even when nothing was put into it.
    `/assets/${build}/__proto__`,
    `/assets/${build}/constructor`,
    '__proto__',
    'toString',
  ];
  for (const path of paths) {
    const response = await serve(request(path));
    assert.equal(response.statusCode, 404, JSON.stringify(path));
    assert.equal(response.body, 'Not found\n');
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store');
    assertSecurityHeaders(response);
  }
});

test('any other build id is a 404 that is not cached', async () => {
  const build = await currentBuild();
  const flipped = (build[0] === '0' ? '1' : '0') + build.slice(1);
  const upper = build.toUpperCase() === build ? 'ffffffffffff' : build.toUpperCase();
  const others = ['000000000000', flipped, upper, build.slice(0, 11), `${build}0`, '%BUILD%', 'latest', '..'];
  for (const id of others) {
    const response = await serve(request(`/assets/${id}/app.js`));
    assert.equal(response.statusCode, 404, id);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('a path that is not text is a 404', async () => {
  for (const rawPath of [undefined, null, 0, 1, true, {}, ['/'], { toString: () => '/' }]) {
    const response = await serve(request(rawPath));
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('only GET is answered', async () => {
  const build = await currentBuild();
  const methods = ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'get', 'Get', '', undefined];
  for (const method of methods) {
    for (const path of ['/', `/assets/${build}/app.js`, '/nothing']) {
      const response = await serve(request(path, { method }));
      assert.equal(response.statusCode, 405, `${method} ${path}`);
      assert.equal(response.headers.allow, 'GET');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.body, 'Method not allowed\n');
      assertSecurityHeaders(response);
    }
  }
});

test('a browser asking first, before a page of another origin calls the API, is answered with nothing', async () => {
  // The phone apps' pages come from the bundle, so each request with a token is asked about first.
  // API Gateway adds the Access-Control-* headers; a 2xx is what a browser needs from here.
  for (const path of ['/api/me', '/api/devices', '/api/t/devices', '/api/c/boards']) {
    const response = await serve(request(path, { method: 'OPTIONS' }));
    assert.equal(response.statusCode, 204, path);
    assert.equal(response.body, '', path);
    assert.equal(response.headers['cache-control'], 'no-store', path);
    assert.equal(response.headers.allow, 'GET, POST, PUT', path);
    assertSecurityHeaders(response);
  }
  // Nothing but the API is asked about, and only OPTIONS is answered like this.
  for (const path of ['/', '/api', '/apis/me', '/app/manifest.json']) {
    assert.equal((await serve(request(path, { method: 'OPTIONS' }))).statusCode, 405, path);
  }
  assert.equal((await serve(request('/api/me', { method: 'options' }))).statusCode, 405);
  assert.equal((await serve(request('/api/me', { method: 'DELETE' }))).statusCode, 405);
});

test('an event without the expected outline is refused without throwing', async () => {
  const events = [
    undefined,
    null,
    {},
    { rawPath: '/' },
    { requestContext: {} },
    { requestContext: { http: {} } },
    'GET /',
  ];
  for (const event of events) {
    const response = await serve(event);
    assert.equal(response.statusCode, 405);
    assertSecurityHeaders(response);
  }
});

test('one line is logged per request, and never the query string', async () => {
  const lines = [];
  const logged = createWebHandler({ ...SETTINGS, log: (entry) => lines.push(entry) });
  const build = await currentBuild();

  await logged(
    request('/', {
      rawQueryString: 'code=AUTHORIZATION-CODE&state=STATE-VALUE',
      queryStringParameters: { code: 'AUTHORIZATION-CODE', state: 'STATE-VALUE' },
      headers: { referer: 'https://example.invalid/?code=AUTHORIZATION-CODE', cookie: 'session=COOKIE-VALUE' },
    })
  );
  await logged(request(`/assets/${build}/app.js`));
  await logged(request(`/${'x'.repeat(5000)}`));
  await logged(request('/', { method: 'POST' }));

  assert.deepEqual(
    lines.map((line) => line.status),
    [200, 200, 404, 405]
  );
  assert.deepEqual(lines[0], { requestId: 'request-1', method: 'GET', path: '/', status: 200 });
  assert.equal(lines[2].path.length, 200);
  const everything = JSON.stringify(lines);
  for (const secret of ['AUTHORIZATION-CODE', 'STATE-VALUE', 'COOKIE-VALUE', 'code=', 'referer']) {
    assert.equal(everything.includes(secret), false, secret);
  }
});

test('the deployed handler reads its settings from the environment and always uses https', async (t) => {
  const names = ['USER_POOL_CLIENT_ID', 'LOGIN_DOMAIN', 'OAUTH_SCOPE', 'USER_POOL_ID'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const lines = [];
  const consoleLog = console.log;
  console.log = (line) => lines.push(line);
  t.after(() => {
    console.log = consoleLog;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  for (const name of names) delete process.env[name];
  await assert.rejects(handler(request('/')), /USER_POOL_CLIENT_ID is not set/);

  process.env.USER_POOL_CLIENT_ID = 'deployed-client';
  process.env.OAUTH_SCOPE = 'openid cranium/console';
  process.env.LOGIN_DOMAIN = LOGIN.slice('https://'.length);
  await assert.rejects(handler(request('/')), /USER_POOL_ID is not set/);
  process.env.USER_POOL_ID = 'xx-test-1_Pool0Tests" connect-src *';
  await assert.rejects(handler(request('/')), TypeError);
  process.env.USER_POOL_ID = POOL;
  process.env.LOGIN_DOMAIN = 'login.example"><script>';
  await assert.rejects(handler(request('/')), TypeError);

  process.env.LOGIN_DOMAIN = LOGIN.slice('https://'.length);
  const callback = request('/', { rawQueryString: 'code=AUTHORIZATION-CODE&state=STATE-VALUE' });
  const response = await handler(callback);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(settingsIn(response.body), {
    clientId: 'deployed-client',
    loginOrigin: LOGIN,
    scope: 'openid cranium/console',
    redirectUri: `https://${DOMAIN}/`,
    userPoolId: POOL,
    idpOrigin: USER_POOL_API,
  });
  assertSecurityHeaders(response);

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { requestId: 'request-1', method: 'GET', path: '/', status: 200 });
  assert.equal(lines[0].includes('AUTHORIZATION-CODE'), false);
});
