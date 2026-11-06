/**
 * The bundle's manifest, as the desktop app reads it (docs/desktop-app.md, "The bundle"). The same rules
 * as cloud/web/src/bundle.mjs readManifest and the phone apps' BundleManifest: test/manifest.test.mjs
 * reads apps/shared/bundle-sample.json, as their tests do, and compares this reader with bundle.mjs on
 * every broken manifest in it.
 *
 * A copy and not an import: the app is packaged from apps/desktop/ alone, and cloud/ has no package.
 *
 * No dependencies: only node:crypto.
 */

import { createHash } from 'node:crypto';

export const BUNDLE_FORMAT = 1;
// The bridge this app speaks (apps/shared/bridge.json "bridge"). A bundle that needs a newer one is not taken.
export const BRIDGE_VERSION = 1;
export const ROUTES = Object.freeze({
  '/': Object.freeze({ file: 'index.html', policy: 'customer' }),
  '/admin': Object.freeze({ file: 'admin/index.html', policy: 'console' }),
});
export const PATH = /^(?:[a-z0-9][a-z0-9._-]{0,63}\/){0,3}[a-z0-9][a-z0-9._-]{0,63}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{16}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
export const TYPES = Object.freeze({
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
});
export const LIMITS = Object.freeze({ files: 300, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 });
export const MAX_MANIFEST_BYTES = 1024 * 1024;

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** The type of a file by its path, or null for a kind a bundle may not hold. */
export function typeOf(path) {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? null : (TYPES[path.slice(dot + 1)] ?? null);
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function byBytes(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every fact the app acts on, one a line (bundle.mjs canonicalText). */
export function canonicalText({ format, bridge, routes, files }) {
  const lines = [`cranium-bundle ${format}`, `bridge ${bridge}`];
  for (const key of Object.keys(routes).sort(byBytes)) lines.push(`route ${key} ${routes[key].file} ${routes[key].policy}`);
  for (const file of [...files].sort((a, b) => byBytes(a.path, b.path))) {
    lines.push(`file ${file.path} ${file.size} ${file.sha256}`);
  }
  return `${lines.join('\n')}\n`;
}

export function bundleId(manifest) {
  return sha256Hex(Buffer.from(canonicalText(manifest), 'utf8')).slice(0, 16);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A manifest, checked: { format, id, bridge, consoleVersion, routes, files }. Throws a ManifestError with
 * the reason for anything the phone apps would refuse. A bundle whose bridge is above this app's reads
 * (so that the app can say it needs an update) but is never kept: see store.mjs.
 */
export function readManifest(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new ManifestError('not a manifest');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ManifestError('not JSON');
  }
  if (!isRecord(value) || value.format !== BUNDLE_FORMAT) throw new ManifestError('not a manifest of this format');
  if (typeof value.id !== 'string' || !ID.test(value.id)) throw new ManifestError('no id');
  if (!Number.isInteger(value.bridge) || value.bridge < 1 || value.bridge > 1000) {
    throw new ManifestError('no bridge version');
  }
  if (!isRecord(value.routes)) throw new ManifestError('no routes');
  const routes = {};
  for (const [key, route] of Object.entries(value.routes)) {
    if (
      !Object.hasOwn(ROUTES, key) ||
      !isRecord(route) ||
      typeof route.file !== 'string' ||
      !['console', 'customer'].includes(route.policy)
    ) {
      throw new ManifestError(`a route that is not one: ${key}`);
    }
    routes[key] = { file: route.file, policy: route.policy };
  }
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > LIMITS.files) {
    throw new ManifestError('no files');
  }
  const paths = new Set();
  let total = 0;
  const files = value.files.map((file) => {
    if (!isRecord(file) || typeof file.path !== 'string' || !PATH.test(file.path) || typeOf(file.path) === null) {
      throw new ManifestError('a file that is not one');
    }
    if (paths.has(file.path)) throw new ManifestError(`${file.path} twice`);
    paths.add(file.path);
    if (!Number.isInteger(file.size) || file.size < 0 || file.size > LIMITS.fileBytes) {
      throw new ManifestError(`${file.path}: no size`);
    }
    if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) throw new ManifestError(`${file.path}: no SHA-256`);
    total += file.size;
    return { path: file.path, size: file.size, sha256: file.sha256 };
  });
  if (total > LIMITS.totalBytes) throw new ManifestError('too large');
  for (const route of Object.values(routes)) {
    if (!paths.has(route.file)) throw new ManifestError(`no file for ${route.file}`);
  }
  if (Object.keys(routes).length === 0) throw new ManifestError('no routes');
  const manifest = { format: value.format, id: value.id, bridge: value.bridge, routes, files };
  if (bundleId(manifest) !== value.id) throw new ManifestError('the id is not that of what the manifest says');
  const consoleVersion =
    isRecord(value.console) && typeof value.console.version === 'string' && VERSION.test(value.console.version)
      ? value.console.version
      : null;
  return { ...manifest, consoleVersion };
}

/** The file of a path, or null: a path is only ever a key into the manifest. */
export function fileOf(manifest, path) {
  return manifest.files.find((file) => file.path === path) ?? null;
}
