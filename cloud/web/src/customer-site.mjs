/**
 * The customer website's files (customer/), for the web function (server.mjs) and nothing
 * else. docs/customer-site.md says what the site is.
 *
 * Like the console's, its files are read once into a table of exact path -> response, and its
 * assets are served under /assets/<build id>/, where the build id is a hash of every file it
 * serves. It serves four of the console's own files as they are, so that the two cannot drift
 * apart: core.js (the sign-in with SRP, the six boxes of the code, the words of sign-in
 * problems), views.js (the renderer that can only make elements and text, and the pieces
 * every page uses), app.css (the colours, the type and the components) and bridge.js (the phone
 * app around the page, docs/mobile-apps.md "The app shell"). Its own files are
 * named customer*, so that no name of its own can ever stand in for one of those four.
 *
 * Its page carries the public sign-in settings of both pools in a <meta> tag: the customer
 * pool's, for customers, and the staff pool's, for an admin's sign-in. Nothing in them is
 * secret. The policy lets the page talk to its own origin and to Cognito's user pool API,
 * which both pools share because they are in the same Region; no managed login pages, no
 * other origin. Trusted Types are required, so that no string can ever become markup or a
 * script on this page, whatever a bug in it would try.
 *
 * No dependencies: only node:crypto and node:fs.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

export const CUSTOMER_PAGE = 'index.html';
// What the customer site serves of the console's own files, byte for byte.
export const SHARED_ASSETS = Object.freeze(['core.js', 'views.js', 'app.css', 'bridge.js']);
const OWN_PREFIX = 'customer';
const BUILD_ID_LENGTH = 12;
const BUILD_MARK = '%BUILD%';
const CONFIG_MARK = '%CONFIG%';
const ASSET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ASSET_TYPES = new Map([
  ['css', 'text/css; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
]);

function buildIdOf(files) {
  const hash = createHash('sha256');
  for (const { name, bytes } of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest('hex').slice(0, BUILD_ID_LENGTH);
}

/**
 * Read customer/ into memory, with the three shared files from site/assets/. Anything else in
 * customer/ (a subdirectory, a link, a file type or a name that is not expected) stops the
 * function from starting, so that it is noticed by the tests instead of being shipped.
 *
 * @param {URL} base      the customer/ directory
 * @param {URL} siteBase  the console's site/ directory
 */
export function loadCustomerSite(base, siteBase) {
  const files = [{ name: CUSTOMER_PAGE, bytes: readFileSync(new URL(CUSTOMER_PAGE, base)) }];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name !== CUSTOMER_PAGE && entry.name !== 'assets') throw new Error(`Unexpected entry in customer/: ${entry.name}`);
  }
  const assetsDir = new URL('assets/', base);
  for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const type = ASSET_TYPES.get(entry.name.slice(entry.name.lastIndexOf('.') + 1));
    if (!entry.isFile() || !ASSET_NAME.test(entry.name) || !type || !entry.name.startsWith(OWN_PREFIX)) {
      throw new Error(`Unexpected entry in customer/assets/: ${entry.name}`);
    }
    files.push({ name: `assets/${entry.name}`, file: entry.name, type, bytes: readFileSync(new URL(entry.name, assetsDir)) });
  }
  const siteAssets = new URL('assets/', siteBase);
  for (const name of SHARED_ASSETS) {
    const type = ASSET_TYPES.get(name.slice(name.lastIndexOf('.') + 1));
    files.push({ name: `shared/${name}`, file: name, type, bytes: readFileSync(new URL(name, siteAssets)) });
  }

  const buildId = buildIdOf(files);
  const page = files[0].bytes.toString('utf8').replaceAll(BUILD_MARK, buildId).split(CONFIG_MARK);
  if (page.length !== 2) throw new Error(`customer/${CUSTOMER_PAGE} must contain ${CONFIG_MARK} exactly once`);
  const assets = new Map();
  for (const { file, type, bytes } of files) {
    if (file !== undefined) assets.set(`/assets/${buildId}/${file}`, { type, body: bytes.toString('utf8') });
  }
  return { buildId, assets, pageHead: page[0], pageTail: page[1] };
}

/** The customer site's policy: its own origin, Cognito's user pool API, and nothing else. */
export function customerPolicy(idpOrigin) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' ${idpOrigin}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ];
}
