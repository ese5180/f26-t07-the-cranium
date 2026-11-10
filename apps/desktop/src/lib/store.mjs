/**
 * The bundle on the computer (docs/desktop-app.md, "The bundle"): apps/shared/bridge.json "bundle", as the
 * phone apps' BundleStore does it.
 *
 *   <root>/objects/<sha256>   each file, kept under its SHA-256 only once it has that size and SHA-256
 *   <root>/current.json       the newest manifest whose files are all here
 *   <root>/previous.json      the one before it
 *   <root>/state.json         { starts: { <id>: n }, good: [<id>], bad: [<id>] }
 *
 * At start: the current bundle if every file it names is here and matches, and it is not bad; else the
 * previous one, the same way; else the copy built into the app. A bundle that has not said app.ready
 * after two starts is marked bad and never fetched again. A downloaded bundle of an older console than the
 * built-in copy gives way to it (an app built with newer pages than the console has deployed shows them);
 * an equal or unknown version keeps the downloaded one, and nothing older than the built-in copy is fetched.
 * In the background: the manifest from the console, and the files it names that are not here yet, four at
 * a time.
 *
 * A path in a manifest is only a key: no path from a server ever becomes a file name here.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BRIDGE_VERSION, LIMITS, MAX_MANIFEST_BYTES, ManifestError, fileOf, readManifest, sha256Hex, typeOf } from './manifest.mjs';

export const FETCH_TIMEOUT_MS = 15_000;
export const FILES_AT_ONCE = 4;
export const STARTS_BEFORE_BAD = 2;
const SHA256 = /^[0-9a-f]{64}$/;

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function writeAtomically(path, data) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

/** A response's body, no larger than `limit` bytes. */
async function bodyOf(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('larger than expected');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error('larger than expected');
  return bytes;
}

/**
 * Whether console version `a` is newer than `b` ("2.27.0" against "2.25.5"); false when either is missing
 * or not three numbers, so that a manifest without a version keeps the rule from before.
 */
export function isNewerConsole(a, b) {
  const parts = (text) => {
    if (typeof text !== 'string') return null;
    const numbers = text.split('+')[0].split('.');
    return numbers.length === 3 && numbers.every((part) => /^\d{1,6}$/.test(part)) ? numbers.map(Number) : null;
  };
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * @param {object} options
 * @param {string} options.root      the app's own folder for the bundle (userData/bundle)
 * @param {string|null} options.builtIn  the folder of the built-in copy (manifest.json, files/<sha256>)
 * @param {typeof fetch} [options.fetch]
 * @param {(line: object) => void} [options.log]
 */
export function createBundleStore({ root, builtIn, fetch: fetchIt = globalThis.fetch, log = () => {} }) {
  const objects = join(root, 'objects');
  let state = null;
  let updating = null;
  let needsNewerApp = false;

  async function loadState() {
    if (state) return state;
    const text = await readText(join(root, 'state.json'));
    let value = null;
    try {
      value = JSON.parse(text ?? '');
    } catch {
      value = null;
    }
    const ids = (list) => (Array.isArray(list) ? list.filter((id) => /^[0-9a-f]{16}$/.test(id)) : []);
    state = {
      starts: value && typeof value.starts === 'object' && value.starts !== null ? { ...value.starts } : {},
      good: new Set(ids(value?.good)),
      bad: new Set(ids(value?.bad)),
    };
    return state;
  }

  async function saveState() {
    await mkdir(root, { recursive: true });
    const { starts, good, bad } = state;
    await writeAtomically(join(root, 'state.json'), JSON.stringify({ starts, good: [...good], bad: [...bad] }));
  }

  async function manifestAt(path) {
    const text = await readText(path);
    if (text === null) return null;
    try {
      return { manifest: readManifest(text), text };
    } catch {
      return null;
    }
  }

  /** Whether every file the manifest names is in the folder, with its size and SHA-256. */
  async function complete(manifest, folder) {
    for (const file of manifest.files) {
      const bytes = await readFile(join(folder, file.sha256)).catch(() => null);
      if (bytes === null || bytes.length !== file.size || sha256Hex(bytes) !== file.sha256) return false;
    }
    return true;
  }

  /**
   * The bundle to show now: { manifest, source: 'downloaded'|'built-in', folder }, or null when not even
   * the built-in copy checks out. Counts the start.
   */
  async function shipped() {
    if (!builtIn) return null;
    const found = await manifestAt(join(builtIn, 'manifest.json'));
    return found && found.manifest.bridge <= BRIDGE_VERSION ? found.manifest : null;
  }

  async function builtInBundle() {
    const manifest = await shipped();
    const folder = builtIn ? join(builtIn, 'files') : null;
    return manifest && (await complete(manifest, folder)) ? { manifest, source: 'built-in', folder } : null;
  }

  async function launch() {
    const s = await loadState();
    const own = await shipped();
    for (const name of ['current.json', 'previous.json']) {
      const found = await manifestAt(join(root, name));
      if (!found || found.manifest.bridge > BRIDGE_VERSION || s.bad.has(found.manifest.id)) continue;
      const { id } = found.manifest;
      if (!s.good.has(id) && (s.starts[id] ?? 0) >= STARTS_BEFORE_BAD) {
        s.bad.add(id);
        log({ bundle: id, outcome: 'marked_bad', reason: 'no app.ready after two starts' });
        continue;
      }
      // Older than the pages built into the app: those, and no start of this one is counted.
      if (own && isNewerConsole(own.consoleVersion, found.manifest.consoleVersion)) {
        const bundle = await builtInBundle();
        if (bundle) {
          await saveState();
          return bundle;
        }
      }
      if (!(await complete(found.manifest, objects))) continue;
      s.starts[id] = (s.starts[id] ?? 0) + 1;
      await saveState();
      return { manifest: found.manifest, source: 'downloaded', folder: objects };
    }
    await saveState();
    return builtInBundle();
  }

  /** app.ready: the pages of this bundle started, so it is good for good. */
  async function ready(id) {
    const s = await loadState();
    if (s.good.has(id)) return;
    s.good.add(id);
    delete s.starts[id];
    await saveState();
  }

  /** A file of the bundle that is showing, checked again: { bytes, type } or null. */
  async function read(launched, path) {
    const file = fileOf(launched.manifest, path);
    if (!file) return null;
    const bytes = await readFile(join(launched.folder, file.sha256)).catch(() => null);
    if (bytes === null || bytes.length !== file.size || sha256Hex(bytes) !== file.sha256) return null;
    return { bytes, type: typeOf(file.path) };
  }

  async function fetchWithin(url, limit) {
    // The manifest is served no-cache and each file is immutable, so the HTTP cache is right as it is.
    const response = await fetchIt(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
    if (!response.ok) throw new Error(`${response.status}`);
    return bodyOf(response, limit);
  }

  async function fetchObject(consoleUrl, file) {
    const target = join(objects, file.sha256);
    const kept = await readFile(target).catch(() => null);
    if (kept && kept.length === file.size && sha256Hex(kept) === file.sha256) return;
    const bytes = await fetchWithin(`${consoleUrl}/app/files/${file.sha256}`, LIMITS.fileBytes);
    if (bytes.length !== file.size || sha256Hex(bytes) !== file.sha256) {
      throw new Error(`a file of the bundle is not what the manifest says (${file.path})`);
    }
    await writeAtomically(target, bytes);
  }

  async function collectGarbage() {
    const keep = new Set();
    for (const name of ['current.json', 'previous.json']) {
      const found = await manifestAt(join(root, name));
      for (const file of found?.manifest.files ?? []) keep.add(file.sha256);
    }
    for (const name of await readdir(objects).catch(() => [])) {
      if (!keep.has(name) && (SHA256.test(name) || name.endsWith('.tmp'))) await rm(join(objects, name), { force: true });
    }
  }

  async function update(consoleUrl) {
    const s = await loadState();
    let fetched;
    try {
      const text = (await fetchWithin(`${consoleUrl}/app/manifest.json`, MAX_MANIFEST_BYTES)).toString('utf8');
      fetched = { manifest: readManifest(text), text };
    } catch (error) {
      log({ update: 'failed', step: 'manifest', reason: error instanceof ManifestError ? error.message : 'unreachable' });
      return { status: 'failed' };
    }
    const { manifest, text } = fetched;
    if (manifest.bridge > BRIDGE_VERSION) {
      needsNewerApp = true;
      return { status: 'needsNewerApp' };
    }
    needsNewerApp = false;
    // The console's pages are older than the ones built into the app: nothing to fetch or to offer.
    const own = await shipped();
    if (own && isNewerConsole(own.consoleVersion, manifest.consoleVersion)) return { status: 'same' };
    const current = await manifestAt(join(root, 'current.json'));
    if (current?.manifest.id === manifest.id || s.bad.has(manifest.id)) return { status: 'same' };
    try {
      await mkdir(objects, { recursive: true });
      const unique = [...new Map(manifest.files.map((file) => [file.sha256, file])).values()];
      const queue = [...unique];
      await Promise.all(
        Array.from({ length: Math.min(FILES_AT_ONCE, queue.length) }, async () => {
          while (queue.length > 0) await fetchObject(consoleUrl, queue.shift());
        })
      );
    } catch (error) {
      log({ update: 'failed', step: 'files', bundle: manifest.id, reason: String(error.message).slice(0, 120) });
      return { status: 'failed' };
    }
    if (current) await rename(join(root, 'current.json'), join(root, 'previous.json'));
    await writeAtomically(join(root, 'current.json'), text);
    await collectGarbage();
    log({ update: 'new', bundle: manifest.id, console: manifest.consoleVersion });
    return { status: 'new', id: manifest.id, console: manifest.consoleVersion };
  }

  return Object.freeze({
    launch,
    ready,
    read,
    /** One update at a time: a second call while one is under way waits for that one. */
    update(consoleUrl) {
      if (!updating) updating = update(consoleUrl).finally(() => (updating = null));
      return updating;
    },
    get needsNewerApp() {
      return needsNewerApp;
    },
  });
}
