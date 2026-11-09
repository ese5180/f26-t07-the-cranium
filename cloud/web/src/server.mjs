/**
 * The function that serves the web console and the public home page (WebFn).
 *
 * Both are a handful of static files. They are read once, when the function starts,
 * into a table of exact request path -> response, and a request is answered from that
 * table or not at all. The request path is only ever a lookup key: it is never decoded,
 * normalised or joined to a directory, so nothing outside site/ can be reached whatever
 * the path says.
 *
 * The host name decides which of the two a request gets, and each has its own table:
 * a name in HOME_HOSTS gets the home page and its stylesheet, and every other name gets
 * the console. The home page signs nobody in, so it carries no sign-in settings and
 * none of the console's files can be reached from it.
 *
 * Assets are served under /assets/<build id>/, where the build id is a hash of the
 * files of that site, and may be cached for ever; any other build id is a 404. A page
 * is revalidated on every load. The console's carries the public sign-in settings in a
 * <meta> tag: the app client, the login pages, the user pool and the address of its API.
 * Nothing in them is secret; a browser that signs in learns all of them anyway.
 *
 * The query string is never read and never logged: after sign-in it carries the
 * authorization code.
 *
 * A third site, the customer website (customer-site.mjs, docs/customer-site.md), answers on the
 * names in CUSTOMER_HOSTS: the first serves it at / and the console at /admin, as admin mode, so
 * that an admin signs in once; the others send the browser to the first. Only there.
 *
 * The phone apps' copy of both sites (bundle.mjs, docs/mobile-apps.md "The app shell") is served on the
 * console's names and the customer site's first: its manifest at /app/manifest.json and each of its
 * files at /app/files/<sha256>. It is made from these same files when the function starts.
 *
 * No dependencies: only node:crypto and node:fs.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import { APP_CONFIG, FILES_PREFIX, MANIFEST_PATH, consoleOf, makeBundle } from './bundle.mjs';
import { customerPolicy, loadCustomerSite } from './customer-site.mjs';

const SITE = new URL('./site/', import.meta.url);
const CUSTOMER = new URL('./customer/', import.meta.url);
// Where the customer site serves the console, for admins.
const ADMIN_PATH = '/admin';
const BUILD_ID_LENGTH = 12;
const BUILD_MARK = '%BUILD%';
const CONFIG_MARK = '%CONFIG%';

const CONSOLE_PAGE = 'index.html';
const HOME_PAGE = 'home.html';
const HOME_STYLE = 'home.css';
// In assets/, a file with this prefix belongs to the home page, and any other to the console.
const HOME_PREFIX = 'home.';

const ASSET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ASSET_TYPES = new Map([
  ['css', 'text/css; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['json', 'application/json; charset=utf-8'],
  // The licence of Leaflet, served beside it (leaflet-license.txt): the map's attribution links to it.
  ['txt', 'text/plain; charset=utf-8'],
]);
const HTML = 'text/html; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';
const PLAIN = 'text/plain; charset=utf-8';

const CACHE_ASSET = 'public, max-age=31536000, immutable';
const CACHE_PAGE = 'no-cache';
const CACHE_NEVER = 'no-store';

// Lower case, as API Gateway reports it. Anything else is refused, not repaired.
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
// The login origin is written into the Content-Security-Policy header, where a space,
// comma or semicolon would start a new source, policy or directive.
const ORIGIN = /^https?:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/;
// A user pool ID: the Region, an underscore, and letters and digits. The Region names the
// address of Cognito's user pool API, which goes into the policy too.
const USER_POOL_ID = /^([a-z]{2}(?:-[a-z]+)+-\d{1,2})_[0-9A-Za-z]{1,64}$/;
// The live API's address (docs/live.md): a WebSocket URL, an origin and a stage. Its origin goes into
// the policy, so it is held to the same characters as the login origin; the local preview's is ws://.
const LIVE_URL = /^(wss?:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?)\/[A-Za-z0-9_-]{1,128}$/;

const LOGGED_PATH_LENGTH = 200;

/**
 * The first digits of a hash that covers every file name and every byte, each prefixed
 * with its length so that no two different sets of files feed the hash the same input.
 */
function buildIdOf(files) {
  const hash = createHash('sha256');
  for (const { name, bytes } of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest('hex').slice(0, BUILD_ID_LENGTH);
}

function assetTable(files, buildId) {
  const assets = new Map();
  for (const { file, type, bytes } of files) {
    if (file !== undefined) assets.set(`/assets/${buildId}/${file}`, { type, body: bytes.toString('utf8') });
  }
  return assets;
}

/**
 * Read site/ into memory: the two pages and the files directly inside assets/. Anything
 * else there (a subdirectory, a link, a file type or a home page file that is not
 * expected) stops the function from starting, so it is noticed by the tests instead of
 * being shipped.
 *
 * The two sites have a build id each, so a change to the home page does not change one
 * byte that the console serves, and expires none of its cached files.
 */
export function loadSite(base) {
  const consoleFiles = [{ name: CONSOLE_PAGE, bytes: readFileSync(new URL(CONSOLE_PAGE, base)) }];
  const homeFiles = [{ name: HOME_PAGE, bytes: readFileSync(new URL(HOME_PAGE, base)) }];

  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name !== CONSOLE_PAGE && entry.name !== HOME_PAGE && entry.name !== 'assets') {
      throw new Error(`Unexpected entry in site/: ${entry.name}`);
    }
  }

  const assetsDir = new URL('assets/', base);
  for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const type = ASSET_TYPES.get(entry.name.slice(entry.name.lastIndexOf('.') + 1));
    const ofHome = entry.name.startsWith(HOME_PREFIX);
    if (!entry.isFile() || !ASSET_NAME.test(entry.name) || !type || (ofHome && entry.name !== HOME_STYLE)) {
      throw new Error(`Unexpected entry in site/assets/: ${entry.name}`);
    }
    (ofHome ? homeFiles : consoleFiles).push({
      name: `assets/${entry.name}`,
      file: entry.name,
      type,
      bytes: readFileSync(new URL(entry.name, assetsDir)),
    });
  }

  const consoleBuild = buildIdOf(consoleFiles);
  const page = consoleFiles[0].bytes.toString('utf8').replaceAll(BUILD_MARK, consoleBuild).split(CONFIG_MARK);
  if (page.length !== 2) {
    throw new Error(`${CONSOLE_PAGE} must contain ${CONFIG_MARK} exactly once`);
  }

  const homeBuild = buildIdOf(homeFiles);
  const homePage = homeFiles[0].bytes.toString('utf8');
  if (homePage.includes(CONFIG_MARK)) {
    throw new Error(`${HOME_PAGE} must not contain ${CONFIG_MARK}: it signs nobody in`);
  }
  if (homeFiles.length !== 2) {
    throw new Error(`site/assets/${HOME_STYLE} is missing`);
  }

  return {
    console: {
      buildId: consoleBuild,
      assets: assetTable(consoleFiles, consoleBuild),
      pageHead: page[0],
      pageTail: page[1],
    },
    home: {
      buildId: homeBuild,
      assets: assetTable(homeFiles, homeBuild),
      page: homePage.replaceAll(BUILD_MARK, homeBuild),
    },
  };
}

const site = loadSite(SITE);
const customerSite = loadCustomerSite(CUSTOMER, SITE);

/**
 * The frozen golden image (firmware/golden.json), for Board setup (assets/setup.js), which puts it on a
 * board over USB: at /golden/<its file name>, on the console's names and at the customer site's, where
 * the console is admin mode. It is a copy of binaries/golden/ (test/server.test.mjs holds the two to be
 * the same bytes, and to firmware/golden.json). Served here, beside the page, and not by the API: it is
 * public, as it is in git, it never changes, and the page checks it against the digest it carries.
 * Not in the phone apps' bundle, which holds text only; a phone has no Web Serial anyway.
 */
export const GOLDEN_DIR = new URL('./golden/', import.meta.url);
const GOLDEN_NAME = /^cranium-\d{1,3}\.\d{1,3}\.\d{1,5}-\d{1,10}\.signed\.bin$/;

export function loadGolden(dir) {
  const files = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isFile() || !GOLDEN_NAME.test(entry.name)) throw new Error(`Unexpected entry in golden/: ${entry.name}`);
    files.set(`/golden/${entry.name}`, readFileSync(new URL(entry.name, dir)).toString('base64'));
  }
  if (files.size !== 1) throw new Error('golden/ must hold the one golden image');
  return files;
}

const golden = loadGolden(GOLDEN_DIR);
const BINARY = 'application/octet-stream';

const ATTRIBUTE_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Make any text safe inside a double-quoted HTML attribute. */
function escapeAttribute(text) {
  return text.replace(/[&<>"']/g, (character) => ATTRIBUTE_ESCAPES[character]);
}

/**
 * The phone apps' bundle (bundle.mjs) of the two sites as loaded: the customer site's page at
 * index.html and the console's at admin/index.html, each with the app's settings tag, and every file
 * of both under assets/<build id>/, as the customer site's name serves them. Its files by SHA-256,
 * each with the type and the text the function answers with.
 */
export function loadAppBundle(consoleSite, customer) {
  const tag = escapeAttribute(APP_CONFIG);
  const files = [
    { path: 'index.html', bytes: Buffer.from(customer.pageHead + tag + customer.pageTail, 'utf8') },
    {
      path: 'admin/index.html',
      bytes: Buffer.from(consoleSite.console.pageHead + tag + consoleSite.console.pageTail, 'utf8'),
    },
  ];
  let versions = null;
  for (const assets of [consoleSite.console.assets, customer.assets]) {
    for (const [key, { body }] of assets) {
      files.push({ path: key.slice(1), bytes: Buffer.from(body, 'utf8') });
      if (key.endsWith('/versions.json')) versions = body;
    }
  }
  const { manifest, objects } = makeBundle(files, consoleOf(versions));
  return {
    manifest,
    manifestBody: `${JSON.stringify(manifest)}\n`,
    objects: new Map(
      [...objects].map(([digest, { type, bytes }]) => [digest, { type, body: bytes.toString('utf8'), bytes }])
    ),
  };
}

export const appBundle = loadAppBundle(site, customerSite);

function requireText(name, value) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

// The map's tiles (the Map page and a board's page, assets/map.js): OpenStreetMap's, as images only.
export const TILE_ORIGIN = 'https://tile.openstreetmap.org';

/**
 * The page may talk to its own origin, to the managed login pages (the token and the
 * revocation of the refresh token), to Cognito's user pool API (the console's own
 * sign-in page) and, with live updates, to the live API (docs/live.md). Nowhere else. It may
 * show images from itself and from OpenStreetMap's tile server, for the map, and from nowhere else.
 */
function consolePolicy(loginOrigin, idpOrigin, liveOrigin = null) {
  const connect = [...new Set(["'self'", loginOrigin, idpOrigin, ...(liveOrigin ? [liveOrigin] : [])])].join(' ');
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' data: ${TILE_ORIGIN}`,
    `connect-src ${connect}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ];
}

// The home page has no script and calls nothing. Its only image is the icon written out
// in its head; the drawings are inline.
const HOME_POLICY = Object.freeze([
  "default-src 'none'",
  "style-src 'self'",
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
]);

/**
 * `serial` is who may use a serial port. Only the console has a page that does: the
 * home page keeps it switched off.
 */
function securityHeaders(policy, serial) {
  return {
    'content-security-policy': policy.join('; '),
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': `camera=(), microphone=(), geolocation=(), usb=(), serial=${serial}, payment=()`,
  };
}

function writeLog(entry) {
  console.log(JSON.stringify(entry));
}

/**
 * Build a handler for API Gateway HTTP API events (payload format 2.0).
 *
 * @param {object} options
 * @param {string} options.clientId      app client id the console signs in with
 * @param {string} options.loginOrigin   origin of the managed login pages, for example
 *                                       https://<prefix>.auth.<region>.amazoncognito.com
 * @param {string} options.scope         OAuth scopes, space separated
 * @param {string} options.userPoolId    the user pool, for the console's own sign-in page
 * @param {string} [options.idpOrigin]   where Cognito's user pool API answers. Left out, it
 *                                       is https://cognito-idp.<the Region of the pool>
 *                                       .amazonaws.com. Only the local preview sets it.
 * @param {string} [options.redirectUri] the address the login pages send the browser
 *                                       back to. Left out, it is https://<the domain
 *                                       name of the request>/. Only the local preview
 *                                       sets it, to a loopback address.
 * @param {string[]} [options.homeHosts] the host names that get the home page, exactly as
 *                                       API Gateway reports them. Every other name gets
 *                                       the console.
 * @param {object} [options.customer]    the customer site: { hosts, userPoolId, clientId }, its
 *                                       names (the first is the one it is served on) and the
 *                                       customer pool's sign-in settings. Left out, no name gets it.
 * @param {string} [options.liveUrl]     the live API's address, wss://<host>/<stage> (docs/live.md),
 *                                       which both sites' pages connect to. Left out, they only poll.
 * @param {(entry: object) => void} [options.log]  receives one entry per request
 */
export function createWebHandler({
  clientId,
  loginOrigin,
  scope,
  userPoolId,
  idpOrigin,
  redirectUri,
  homeHosts = [],
  customer = null,
  liveUrl,
  log = writeLog,
} = {}) {
  requireText('clientId', clientId);
  requireText('scope', scope);
  requireText('loginOrigin', loginOrigin);
  if (!ORIGIN.test(loginOrigin)) {
    throw new TypeError('loginOrigin must be an origin such as https://login.example');
  }
  requireText('userPoolId', userPoolId);
  const pool = USER_POOL_ID.exec(userPoolId);
  if (!pool) throw new TypeError('userPoolId must be a user pool ID such as us-east-1_AbC123');
  const userPoolApi = idpOrigin ?? `https://cognito-idp.${pool[1]}.amazonaws.com`;
  if (typeof userPoolApi !== 'string' || !ORIGIN.test(userPoolApi)) {
    throw new TypeError('idpOrigin must be an origin such as https://cognito-idp.example');
  }
  if (redirectUri !== undefined) requireText('redirectUri', redirectUri);
  if (!Array.isArray(homeHosts) || !homeHosts.every((host) => typeof host === 'string' && HOST.test(host))) {
    throw new TypeError('homeHosts must be a list of host names in lower case');
  }

  let liveOrigin = null;
  if (liveUrl !== undefined && liveUrl !== null) {
    liveOrigin = typeof liveUrl === 'string' ? (LIVE_URL.exec(liveUrl)?.[1] ?? null) : null;
    if (liveOrigin === null) throw new TypeError('liveUrl must be a WebSocket address such as wss://live.example/live');
  }
  const live = liveOrigin === null ? {} : { liveUrl };

  const homeNames = new Set(homeHosts);
  const consoleHeaders = securityHeaders(consolePolicy(loginOrigin, userPoolApi, liveOrigin), '(self)');
  const homeHeaders = securityHeaders(HOME_POLICY, '()');

  // The customer site. Its pool is in the Region of the staff pool, so both talk to one user pool API.
  const customerNames = new Set();
  let customerHeaders = null;
  if (customer !== null) {
    const { hosts, userPoolId: customerPoolId, clientId: customerClientId } = customer ?? {};
    if (
      !Array.isArray(hosts) ||
      hosts.length === 0 ||
      !hosts.every((host) => typeof host === 'string' && HOST.test(host))
    ) {
      throw new TypeError('customer.hosts must be a list of host names in lower case');
    }
    if (hosts.some((host) => homeNames.has(host)))
      throw new TypeError('a name cannot be the home page and the customer site');
    requireText('customer.clientId', customerClientId);
    const customerPool = USER_POOL_ID.exec(String(customerPoolId ?? ''));
    if (!customerPool || customerPool[1] !== pool[1]) {
      throw new TypeError('customer.userPoolId must be a user pool ID in the Region of the staff pool');
    }
    for (const host of hosts) customerNames.add(host);
    customerHeaders = securityHeaders(customerPolicy(userPoolApi, liveOrigin), '()');
  }

  function respond(headers, statusCode, type, cacheControl, body, extra) {
    return {
      statusCode,
      headers: { ...headers, 'content-type': type, 'cache-control': cacheControl, ...extra },
      body,
      isBase64Encoded: false,
    };
  }

  /**
   * The phone apps' bundle: its manifest, revalidated each time, and a file by its SHA-256, for ever.
   * Null for any other path. The path is a key, as everywhere here.
   */
  function bundleAnswer(headers, path) {
    if (path === MANIFEST_PATH) return respond(headers, 200, JSON_TYPE, CACHE_PAGE, appBundle.manifestBody);
    if (typeof path !== 'string' || !path.startsWith(FILES_PREFIX)) return null;
    const object = appBundle.objects.get(path.slice(FILES_PREFIX.length));
    return object ? respond(headers, 200, object.type, CACHE_ASSET, object.body) : null;
  }

  /** The golden image, or null for any other path. The path is a key, as everywhere here. */
  function goldenAnswer(headers, path) {
    const body = typeof path === 'string' ? golden.get(path) : undefined;
    if (body === undefined) return null;
    return { ...respond(headers, 200, BINARY, CACHE_ASSET, body), isBase64Encoded: true };
  }

  /**
   * A browser asks first, with OPTIONS, before a page of another origin calls the API with a token:
   * the phone apps' pages, from the bundle (docs/mobile-apps.md, "The app shell"). The $default route
   * brings that request here instead of API Gateway answering it, so it is answered here, with
   * nothing: API Gateway adds the Access-Control-* headers of its CorsConfiguration
   * (infra/template.yaml) to this answer, as to every other. The answer must be a 2xx: a 405 there
   * stopped every request of those pages. Only under /api/; any other OPTIONS is still a 405.
   */
  function preflight(event, headers) {
    const path = event?.rawPath;
    if (event?.requestContext?.http?.method !== 'OPTIONS') return null;
    if (typeof path !== 'string' || !path.startsWith('/api/')) return null;
    return respond(headers, 204, PLAIN, CACHE_NEVER, '', { allow: 'GET, POST, PUT' });
  }

  /** The console's page; with `admin`, as admin mode of the customer site, at /admin. */
  function page(event, admin = false) {
    let returnTo = redirectUri;
    if (returnTo === undefined) {
      const host = event?.requestContext?.domainName;
      if (typeof host !== 'string' || !HOST.test(host)) {
        return respond(consoleHeaders, 400, PLAIN, CACHE_NEVER, 'Bad request\n');
      }
      returnTo = `https://${host}/`;
    }
    const config = JSON.stringify({
      clientId,
      loginOrigin,
      scope,
      redirectUri: admin ? `${returnTo}${ADMIN_PATH.slice(1)}` : returnTo,
      userPoolId,
      idpOrigin: userPoolApi,
      ...(admin ? { customerSite: '/' } : {}),
      ...live,
    });
    const { pageHead, pageTail } = site.console;
    return respond(consoleHeaders, 200, HTML, CACHE_PAGE, pageHead + escapeAttribute(config) + pageTail);
  }

  /** The customer site's page, with both pools' public sign-in settings. */
  function customerPage(event) {
    const host = event?.requestContext?.domainName;
    const home = redirectUri ?? `https://${host}/`;
    const config = JSON.stringify({
      customer: { clientId: customer.clientId, userPoolId: customer.userPoolId },
      admin: { clientId, userPoolId },
      idpOrigin: userPoolApi,
      home,
      adminPath: ADMIN_PATH,
      ...live,
    });
    const { pageHead, pageTail } = customerSite;
    return respond(customerHeaders, 200, HTML, CACHE_PAGE, pageHead + escapeAttribute(config) + pageTail);
  }

  /**
   * A request to a name of the customer site. The first name serves the site, the console at
   * /admin and the files of both; any other, such as www., sends the browser to the first, so
   * that a sign-in is kept in one origin and the staff client has one more return address, not two.
   */
  function customerAnswer(event, host) {
    const path = event.rawPath;
    const [canonical] = customer.hosts;
    if (host !== canonical) {
      const to = path === ADMIN_PATH ? ADMIN_PATH : '/';
      return respond(customerHeaders, 308, PLAIN, CACHE_NEVER, 'Moved\n', { location: `https://${canonical}${to}` });
    }
    const asked = preflight(event, customerHeaders);
    if (asked) return asked;
    if (event?.requestContext?.http?.method !== 'GET') {
      return respond(customerHeaders, 405, PLAIN, CACHE_NEVER, 'Method not allowed\n', { allow: 'GET' });
    }
    if (path === '/') return customerPage(event);
    if (path === ADMIN_PATH) return page(event, true);
    const bundled = bundleAnswer(customerHeaders, path) ?? goldenAnswer(customerHeaders, path);
    if (bundled) return bundled;
    const asset =
      typeof path === 'string' ? (customerSite.assets.get(path) ?? site.console.assets.get(path)) : undefined;
    if (asset) return respond(customerHeaders, 200, asset.type, CACHE_ASSET, asset.body);
    return respond(customerHeaders, 404, PLAIN, CACHE_NEVER, 'Not found\n');
  }

  function answer(event) {
    const host = event?.requestContext?.domainName;
    if (customerNames.has(host)) return customerAnswer(event, host);
    const home = homeNames.has(event?.requestContext?.domainName);
    const headers = home ? homeHeaders : consoleHeaders;
    const asked = home ? null : preflight(event, headers);
    if (asked) return asked;
    if (event?.requestContext?.http?.method !== 'GET') {
      return respond(headers, 405, PLAIN, CACHE_NEVER, 'Method not allowed\n', { allow: 'GET' });
    }
    const path = event.rawPath;
    if (path === '/') return home ? respond(headers, 200, HTML, CACHE_PAGE, site.home.page) : page(event);
    const bundled = home ? null : (bundleAnswer(headers, path) ?? goldenAnswer(headers, path));
    if (bundled) return bundled;
    const { assets } = home ? site.home : site.console;
    const asset = typeof path === 'string' ? assets.get(path) : undefined;
    if (asset) return respond(headers, 200, asset.type, CACHE_ASSET, asset.body);
    return respond(headers, 404, PLAIN, CACHE_NEVER, 'Not found\n');
  }

  return async function webHandler(event) {
    const response = answer(event);
    const context = event?.requestContext;
    log({
      requestId: typeof context?.requestId === 'string' ? context.requestId : null,
      method: typeof context?.http?.method === 'string' ? context.http.method : null,
      path: typeof event?.rawPath === 'string' ? event.rawPath.slice(0, LOGGED_PATH_LENGTH) : null,
      status: response.statusCode,
    });
    return response;
  };
}

function settingsFromEnvironment(env) {
  for (const name of ['USER_POOL_CLIENT_ID', 'LOGIN_DOMAIN', 'OAUTH_SCOPE', 'USER_POOL_ID']) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  return {
    clientId: env.USER_POOL_CLIENT_ID,
    loginOrigin: `https://${env.LOGIN_DOMAIN}`,
    scope: env.OAUTH_SCOPE,
    userPoolId: env.USER_POOL_ID,
    // Left out or empty, every name gets the console. Commas, no spaces: a name that is
    // not a host name is refused when the handler is made.
    homeHosts: (env.HOME_HOSTS ?? '').split(',').filter((name) => name !== ''),
    // The same for the customer site, whose first name is the one it is served on.
    customer: env.CUSTOMER_HOSTS
      ? {
          hosts: env.CUSTOMER_HOSTS.split(',').filter((name) => name !== ''),
          userPoolId: env.CUSTOMER_POOL_ID,
          clientId: env.CUSTOMER_CLIENT_ID,
        }
      : null,
    // Left out or empty, the pages do not keep a WebSocket, and only poll.
    liveUrl: env.LIVE_URL ? env.LIVE_URL : undefined,
  };
}

let deployed;

/**
 * Lambda entry point. The settings come from the function's environment and both the
 * login origin and the redirect address are always https. The environment is read on
 * the first request, so that the preview and the tests can import this module without
 * one; the site itself was read when the module was loaded.
 */
export const handler = async (event) => {
  deployed ??= createWebHandler(settingsFromEnvironment(process.env));
  return deployed(event);
};
