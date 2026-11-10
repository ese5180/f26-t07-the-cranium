// The bundle store: the built-in copy, an update from a stand-in console, the current and previous
// bundles, the two-starts rule, and files that do not check out.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { makeBundle } from '../../../cloud/web/src/bundle.mjs';
import { createBundleStore, isNewerConsole } from '../src/lib/store.mjs';

const CONSOLE = 'https://console.test';

function bundleOf(label, extra = {}, version = '2.4.1') {
  const files = [
    { path: 'index.html', bytes: Buffer.from(`<!doctype html><title>${label}</title>`) },
    { path: 'admin/index.html', bytes: Buffer.from(`<!doctype html><title>${label} console</title>`) },
    { path: 'assets/0123456789ab/core.js', bytes: Buffer.from(`export const label = '${label}';`) },
    { path: 'assets/0123456789ab/shared.js', bytes: Buffer.from('export const same = 1;') },
  ];
  const { manifest, objects } = makeBundle(files, { version, commit: null, builtAt: null });
  return { manifest: { ...manifest, ...extra }, objects };
}

async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), 'cranium-desktop-'));
  // Best-effort: on Windows a file may still be held for a moment (by the antivirus), and that is no failure.
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));
  return root;
}

async function writeBuiltIn(dir, bundle) {
  await mkdir(join(dir, 'files'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(bundle.manifest));
  for (const [sha, { bytes }] of bundle.objects) await writeFile(join(dir, 'files', sha), bytes);
}

/** A console that serves one bundle, and counts what it was asked. */
function consoleServing(bundle, { corrupt = null } = {}) {
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    const ok = (bytes) => new Response(bytes, { status: 200 });
    if (url === `${CONSOLE}/app/manifest.json`) return ok(JSON.stringify(bundle.manifest));
    const sha = url.startsWith(`${CONSOLE}/app/files/`) ? url.slice(`${CONSOLE}/app/files/`.length) : null;
    const object = sha ? bundle.objects.get(sha) : null;
    if (!object) return new Response('no', { status: 404 });
    return ok(sha === corrupt ? Buffer.from('not it') : object.bytes);
  };
  return { fetch, asked };
}

test('a first start shows the built-in copy; an update takes the console\'s, which the next start shows', async (t) => {
  const root = await folder(t);
  const builtIn = join(root, 'built-in');
  const first = bundleOf('built in');
  await writeBuiltIn(builtIn, first);
  const second = bundleOf('from the console');
  const { fetch, asked } = consoleServing(second);
  const store = createBundleStore({ root: join(root, 'store'), builtIn, fetch });

  const launched = await store.launch();
  assert.equal(launched.source, 'built-in');
  assert.equal(launched.manifest.id, first.manifest.id);
  assert.match((await store.read(launched, 'index.html')).bytes.toString(), /built in/);
  assert.equal(await store.read(launched, 'nothing.js'), null);

  const result = await store.update(CONSOLE);
  assert.deepEqual(result, { status: 'new', id: second.manifest.id, console: '2.4.1' });
  // Four distinct files, each fetched once, by its SHA-256.
  assert.equal(asked.filter((url) => url.includes('/app/files/')).length, 4);
  assert.deepEqual(await store.update(CONSOLE), { status: 'same' });

  const next = await store.launch();
  assert.equal(next.source, 'downloaded');
  assert.equal(next.manifest.id, second.manifest.id);
  assert.match((await store.read(next, 'admin/index.html')).bytes.toString(), /from the console console/);
});

test('a file that is not what the manifest says keeps the bundle out, and nothing changes', async (t) => {
  const root = await folder(t);
  const bundle = bundleOf('corrupt');
  const [corrupt] = bundle.objects.keys();
  const store = createBundleStore({ root, builtIn: null, fetch: consoleServing(bundle, { corrupt }).fetch });
  assert.deepEqual(await store.update(CONSOLE), { status: 'failed' });
  assert.equal(await store.launch(), null);
  assert.equal((await readdir(root)).includes('current.json'), false);
});

test('a bundle that needs a newer bridge is not taken, and the app says it needs an update', async (t) => {
  const root = await folder(t);
  const bundle = bundleOf('newer');
  const newer = { ...bundle.manifest, bridge: 2 };
  const { bundleId } = await import('../src/lib/manifest.mjs');
  newer.id = bundleId(newer);
  const store = createBundleStore({ root, builtIn: null, fetch: consoleServing({ ...bundle, manifest: newer }).fetch });
  assert.deepEqual(await store.update(CONSOLE), { status: 'needsNewerApp' });
  assert.equal(store.needsNewerApp, true);
});

test('a bundle that never said app.ready is marked bad after two starts, and the previous one is shown', async (t) => {
  const root = await folder(t);
  const good = bundleOf('good');
  const broken = bundleOf('never ready');
  const store = createBundleStore({ root, builtIn: null, fetch: consoleServing(good).fetch });
  await store.update(CONSOLE);
  const launched = await store.launch();
  await store.ready(launched.manifest.id);

  const later = createBundleStore({ root, builtIn: null, fetch: consoleServing(broken).fetch });
  assert.equal((await later.update(CONSOLE)).status, 'new');
  assert.equal((await later.launch()).manifest.id, broken.manifest.id);
  assert.equal((await later.launch()).manifest.id, broken.manifest.id);
  // The third start: it has had two, without a word from its pages.
  const third = await later.launch();
  assert.equal(third.manifest.id, good.manifest.id);
  const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  assert.deepEqual(state.bad, [broken.manifest.id]);
  // And it is never fetched again.
  assert.deepEqual(await later.update(CONSOLE), { status: 'same' });
});

test('a file changed on disk is not served, and that bundle is not shown again', async (t) => {
  const root = await folder(t);
  const bundle = bundleOf('changed');
  const store = createBundleStore({ root, builtIn: null, fetch: consoleServing(bundle).fetch });
  await store.update(CONSOLE);
  const launched = await store.launch();
  const file = launched.manifest.files.find((entry) => entry.path === 'index.html');
  await writeFile(join(root, 'objects', file.sha256), 'something else');
  assert.equal(await store.read(launched, 'index.html'), null);
  assert.equal(await store.launch(), null);
});

test('files neither manifest names are deleted after an update', async (t) => {
  const root = await folder(t);
  const store = createBundleStore({ root, builtIn: null, fetch: consoleServing(bundleOf('one')).fetch });
  await store.update(CONSOLE);
  const two = createBundleStore({ root, builtIn: null, fetch: consoleServing(bundleOf('two')).fetch });
  await two.update(CONSOLE);
  const three = createBundleStore({ root, builtIn: null, fetch: consoleServing(bundleOf('three')).fetch });
  await three.update(CONSOLE);
  // 'three' and 'two' (previous) share shared.js: 3 + 3 + 1 shared = 7 objects, none of 'one'.
  assert.equal((await readdir(join(root, 'objects'))).length, 7);
});

test('built-in pages of a newer console win over an older download; a newer, equal or unversioned one still wins', async (t) => {
  const root = await folder(t);
  const builtIn = join(root, 'built-in');
  await writeBuiltIn(builtIn, bundleOf('built in', {}, '2.27.0'));
  const older = bundleOf('older console', {}, '2.25.5');
  const served = consoleServing(older);
  const store = createBundleStore({ root: join(root, 'store'), builtIn, fetch: served.fetch });
  // Nothing older than the app's own pages is fetched.
  assert.deepEqual(await store.update(CONSOLE), { status: 'same' });
  assert.equal(served.asked.filter((url) => url.includes('/app/files/')).length, 0);
  assert.equal((await store.launch()).source, 'built-in');

  // An older download kept from before the app was updated gives way too, and its starts are not counted.
  const kept = join(root, 'kept');
  const before = createBundleStore({ root: kept, builtIn: null, fetch: consoleServing(older).fetch });
  assert.equal((await before.update(CONSOLE)).status, 'new');
  const after = createBundleStore({ root: kept, builtIn, fetch: consoleServing(older).fetch });
  for (let i = 0; i < 3; i += 1) assert.equal((await after.launch()).source, 'built-in');

  for (const [deployed, label] of [
    ['2.27.1', 'newer'],
    ['2.27.0', 'equal'],
    [null, 'unversioned'],
  ]) {
    const place = join(root, label);
    const fresh = bundleOf(label, {}, deployed);
    const other = createBundleStore({ root: place, builtIn, fetch: consoleServing(fresh).fetch });
    assert.equal((await other.update(CONSOLE)).status, 'new', label);
    assert.equal((await other.launch()).manifest.id, fresh.manifest.id, label);
  }
  assert.equal(isNewerConsole('2.10.0', '2.9.9'), true);
  assert.equal(isNewerConsole('2.25.5', '2.27.0'), false);
  assert.equal(isNewerConsole('2.27.0', null), false);
});
