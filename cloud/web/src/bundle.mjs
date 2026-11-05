/**
 * The web bundle of the phone apps (docs/mobile-apps.md, "The app shell").
 *
 * From 0.8.0 each phone app is a thin native shell around the console's and the customer site's own
 * pages. The shell never loads a page from the network: it keeps a copy of the pages and their files on
 * the phone and serves that copy to its web view through a scheme of its own. This file says what the
 * copy is, and the web function (server.mjs) serves it:
 *
 *   GET /app/manifest.json       what the bundle holds: every file's path, size and SHA-256, the
 *                                console's version and commit, and the bundle's id. Revalidated on
 *                                every request, like a page.
 *   GET /app/files/<sha256>      one file, by the SHA-256 of its bytes. Immutable, cached for ever.
 *
 * The bundle is the customer site's origin as the web function serves it on the customer site's name:
 * the customer site at /, the console at /admin, as admin mode, and the files of both under
 * /assets/<build id>/. Its two pages are the site's own, with the build ids written in, and with
 * `{"app":true}` in the settings tag instead of the server's settings: in the app, a page asks the app
 * for its settings over the bridge (assets/bridge.js). So nothing in the bundle depends on the stack,
 * and nothing in it is secret: it is the same files every visitor of the sites gets.
 *
 * The manifest is built from the very files the function serves, when the function starts, so it can
 * never disagree with them. The apps check every file against its SHA-256 before they keep it, and the
 * manifest against its id, which is a hash of all it says (canonicalText below). The manifest itself
 * comes over HTTPS from the console's address that is built into the app. It is not signed: whoever can
 * change what this function serves can change the console's pages in every browser too, and the bridge
 * gives a page no more than the website already has (docs/mobile-apps.md, "Security").
 *
 * build-bundle.mjs writes the same bundle into a folder, for the copy each app carries inside itself.
 *
 * No dependencies: only node:crypto.
 */

import { createHash } from 'node:crypto';

export const BUNDLE_FORMAT = 1;
// The version of the bridge (apps/shared/bridge.json) that the pages of this bundle need. A shell
// with an older bridge keeps the bundle it has, and says that the app itself needs an update.
export const BRIDGE_VERSION = 1;
export const MANIFEST_PATH = '/app/manifest.json';
export const FILES_PREFIX = '/app/files/';
// What a page of the bundle carries in its settings tag (cranium-config).
export const APP_CONFIG = '{"app":true}';
// The two pages, by the path the shell answers them on, and the policy it sends with each: the
// console's (as server.mjs sends it) or the customer site's (customer-site.mjs), each for the app.
export const ROUTES = Object.freeze({
  '/': Object.freeze({ file: 'index.html', policy: 'customer' }),
  '/admin': Object.freeze({ file: 'admin/index.html', policy: 'console' }),
});

// A path in the bundle: at most four parts of lower-case letters, digits, dots, dashes and
// underscores, none starting with a dot. It is only ever a key into the manifest: the apps keep each
// file under its SHA-256, so a path never becomes a file name on the phone.
export const PATH = /^(?:[a-z0-9][a-z0-9._-]{0,63}\/){0,3}[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{16}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const COMMIT = /^[0-9a-f]{40}$/;

// The only kinds of file a bundle may hold, by the end of the path. The apps go by the same table and
// never by what a server says.
export const TYPES = Object.freeze({
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
});

export const LIMITS = Object.freeze({ files: 300, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 });

/** The type of a file by its path, or null for a kind a bundle may not hold. */
export function typeOf(path) {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? null : TYPES[path.slice(dot + 1)] ?? null;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Everything the manifest says that changes what an app serves, one fact a line, in a fixed order:
 *
 *   cranium-bundle 1
 *   bridge 1
 *   route / index.html customer
 *   route /admin admin/index.html console
 *   file <path> <size> <sha256>          one a file, by path in byte order
 *
 * each line ended by "\n". The id is the first 16 hex digits of its SHA-256. Both apps compute it the
 * same way (apps/shared/bundle-sample.json is a manifest whose id they check).
 */
export function canonicalText({ format, bridge, routes, files }) {
  const lines = [`cranium-bundle ${format}`, `bridge ${bridge}`];
  for (const key of Object.keys(routes).sort(byBytes)) lines.push(`route ${key} ${routes[key].file} ${routes[key].policy}`);
  for (const file of [...files].sort((a, b) => byBytes(a.path, b.path))) lines.push(`file ${file.path} ${file.size} ${file.sha256}`);
  return `${lines.join('\n')}\n`;
}

function byBytes(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function bundleId(manifest) {
  return sha256(Buffer.from(canonicalText(manifest), 'utf8')).slice(0, 16);
}

/** The console's version, commit and build time, from versions.json (build-versions.mjs), where it is there. */
export function consoleOf(versionsText) {
  let value = null;
  try {
    value = JSON.parse(versionsText ?? '');
  } catch {
    value = null;
  }
  const own = value?.console;
  return {
    version: typeof own?.version === 'string' && VERSION.test(own.version) ? own.version : null,
    commit: typeof own?.commit === 'string' && COMMIT.test(own.commit) ? own.commit : null,
    builtAt: typeof own?.builtAt === 'string' && !Number.isNaN(Date.parse(own.builtAt)) ? own.builtAt : null,
  };
}

/**
 * The bundle of a set of files ({ path, bytes }): its manifest, and its files by SHA-256. Throws on
 * anything the apps would refuse, so that it is found by the tests and never served.
 *
 * @param {{path: string, bytes: Buffer}[]} files
 * @param {{version: string|null, commit: string|null, builtAt: string|null}} about  the console
 */
export function makeBundle(files, about = { version: null, commit: null, builtAt: null }) {
  const listed = new Map();
  const objects = new Map();
  let total = 0;
  for (const { path, bytes } of files) {
    if (!PATH.test(path) || typeOf(path) === null) throw new Error(`A bundle cannot hold ${JSON.stringify(path)}`);
    const digest = sha256(bytes);
    const before = listed.get(path);
    if (before) {
      if (before.sha256 !== digest) throw new Error(`Two different files for ${path} in the bundle`);
      continue;
    }
    if (bytes.length > LIMITS.fileBytes) throw new Error(`${path} is larger than a bundle takes`);
    total += bytes.length;
    listed.set(path, { path, size: bytes.length, sha256: digest });
    if (!objects.has(digest)) objects.set(digest, { type: typeOf(path), bytes });
  }
  for (const [key, route] of Object.entries(ROUTES)) {
    if (!listed.has(route.file)) throw new Error(`The bundle has no ${route.file} for ${key}`);
  }
  if (listed.size > LIMITS.files || total > LIMITS.totalBytes) throw new Error('The bundle is larger than the apps take');

  const body = {
    format: BUNDLE_FORMAT,
    bridge: BRIDGE_VERSION,
    routes: ROUTES,
    files: [...listed.values()].sort((a, b) => byBytes(a.path, b.path)),
  };
  const manifest = {
    format: body.format,
    id: bundleId(body),
    bridge: body.bridge,
    console: { version: about.version ?? null, commit: about.commit ?? null },
    builtAt: about.builtAt ?? null,
    routes: body.routes,
    files: body.files,
  };
  return { manifest, objects };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A manifest as the apps read it: everything checked, the id worked out again. Returns the manifest,
 * or throws with the reason. The shells do the same (BundleManifest.swift, BundleManifest.kt); the
 * tests keep the three in step through apps/shared/bundle-sample.json.
 */
export function readManifest(text) {
  if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('not a manifest');
  const value = JSON.parse(text);
  if (!isRecord(value) || value.format !== BUNDLE_FORMAT) throw new Error('not a manifest of this format');
  if (typeof value.id !== 'string' || !ID.test(value.id)) throw new Error('no id');
  if (!Number.isInteger(value.bridge) || value.bridge < 1 || value.bridge > 1000) throw new Error('no bridge version');
  if (!isRecord(value.routes)) throw new Error('no routes');
  const routes = {};
  for (const [key, route] of Object.entries(value.routes)) {
    if (!(key in ROUTES) || !isRecord(route) || typeof route.file !== 'string' || !['console', 'customer'].includes(route.policy)) {
      throw new Error(`a route that is not one: ${key}`);
    }
    routes[key] = { file: route.file, policy: route.policy };
  }
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > LIMITS.files) throw new Error('no files');
  const paths = new Set();
  let total = 0;
  const files = value.files.map((file) => {
    if (!isRecord(file) || typeof file.path !== 'string' || !PATH.test(file.path) || typeOf(file.path) === null) {
      throw new Error('a file that is not one');
    }
    if (paths.has(file.path)) throw new Error(`${file.path} twice`);
    paths.add(file.path);
    if (!Number.isInteger(file.size) || file.size < 0 || file.size > LIMITS.fileBytes) throw new Error(`${file.path}: no size`);
    if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) throw new Error(`${file.path}: no SHA-256`);
    total += file.size;
    return { path: file.path, size: file.size, sha256: file.sha256 };
  });
  if (total > LIMITS.totalBytes) throw new Error('too large');
  for (const route of Object.values(routes)) if (!paths.has(route.file)) throw new Error(`no file for ${route.file}`);
  if (Object.keys(routes).length === 0) throw new Error('no routes');
  const manifest = { format: value.format, id: value.id, bridge: value.bridge, routes, files };
  if (bundleId(manifest) !== value.id) throw new Error('the id is not that of what the manifest says');
  return manifest;
}
