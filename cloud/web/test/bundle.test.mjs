/**
 * The phone apps' web bundle (src/bundle.mjs, docs/mobile-apps.md "The app shell"): what it holds, how
 * the web function serves it, the rules both apps read a manifest by (apps/shared/bundle-sample.json
 * keeps the three readers in step), and build-bundle.mjs, which writes the copy built into each app.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { describedManifest, writeBundle } from '../build-bundle.mjs';
import {
  APP_CONFIG,
  BRIDGE_VERSION,
  LIMITS,
  ROUTES,
  bundleId,
  canonicalText,
  consoleOf,
  makeBundle,
  readManifest,
  typeOf,
} from '../src/bundle.mjs';
import { appBundle, createWebHandler } from '../src/server.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SAMPLE = JSON.parse(readFileSync(new URL('../../../apps/shared/bundle-sample.json', import.meta.url), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'cranium-bundle-'));
after(() => rmSync(work, { recursive: true, force: true }));

const files = (entries) => Object.entries(entries).map(([path, text]) => ({ path, bytes: Buffer.from(text) }));

test("the shared sample is what this code makes of its files, and the apps' readers are held to it", () => {
  const { manifest, objects } = makeBundle(files(SAMPLE.files), {
    version: SAMPLE.manifest.console.version,
    commit: SAMPLE.manifest.console.commit,
    builtAt: SAMPLE.manifest.builtAt,
  });
  assert.deepEqual(
    manifest,
    SAMPLE.manifest,
    'apps/shared/bundle-sample.json is out of date: write it again from bundle.mjs'
  );
  assert.equal(objects.size, SAMPLE.objects, 'the same bytes under two paths are one file');
  assert.equal(canonicalText(manifest), SAMPLE.canonical);
  assert.equal(manifest.id, sha256(Buffer.from(SAMPLE.canonical)).slice(0, 16));
  for (const file of manifest.files) assert.equal(sha256(Buffer.from(SAMPLE.files[file.path])), file.sha256, file.path);
  assert.deepEqual(readManifest(JSON.stringify(SAMPLE.manifest)).id, SAMPLE.manifest.id);
  for (const [why, broken] of Object.entries(SAMPLE.broken)) {
    assert.throws(() => readManifest(JSON.stringify(broken)), Error, why);
  }
});

test('the id covers every path, size, SHA-256 and route, and nothing else', () => {
  const { manifest } = makeBundle(files(SAMPLE.files));
  const changed = (change) => bundleId({ ...manifest, ...change });
  assert.equal(
    changed({ console: { version: '9.9.9', commit: null }, builtAt: '2030-01-01T00:00:00.000Z' }),
    manifest.id
  );
  assert.notEqual(changed({ bridge: 2 }), manifest.id);
  assert.notEqual(
    changed({ files: manifest.files.map((file, at) => (at === 0 ? { ...file, size: file.size + 1 } : file)) }),
    manifest.id
  );
  assert.notEqual(changed({ files: manifest.files.slice(1) }), manifest.id);
  assert.notEqual(
    changed({ routes: { ...manifest.routes, '/': { file: 'index.html', policy: 'console' } } }),
    manifest.id
  );
  // Order does not matter: the text is sorted.
  assert.equal(changed({ files: [...manifest.files].reverse() }), manifest.id);
});

test('a bundle holds only what the apps take', () => {
  const pages = { 'index.html': 'a', 'admin/index.html': 'b' };
  assert.throws(() => makeBundle(files({ ...pages, 'assets/x/run.sh': '#!' })), /cannot hold/);
  assert.throws(() => makeBundle(files({ ...pages, '../up.js': '' })), /cannot hold/);
  assert.throws(() => makeBundle(files({ ...pages, 'Assets/x.js': '' })), /cannot hold/);
  assert.throws(() => makeBundle(files({ ...pages, 'a/b/c/d/e.js': '' })), /cannot hold/);
  assert.throws(() => makeBundle(files({ 'index.html': 'a' })), /admin\/index\.html/);
  assert.throws(
    () => makeBundle([...files(pages), { path: 'index.html', bytes: Buffer.from('other') }]),
    /Two different files/
  );
  assert.throws(
    () => makeBundle([...files(pages), { path: 'big.js', bytes: Buffer.alloc(LIMITS.fileBytes + 1) }]),
    /larger/
  );
  assert.equal(typeOf('a/b.js'), 'text/javascript; charset=utf-8');
  assert.equal(typeOf('a/b.svg'), null);
  assert.equal(typeOf('noextension'), null);
});

test("the console's version and commit come from versions.json, and nothing else from it", () => {
  const commit = 'ab'.repeat(20);
  assert.deepEqual(
    consoleOf(
      JSON.stringify({ console: { version: '2.1.1', commit, builtAt: '2026-11-05T12:00:00.000Z', tree: 'clean' } })
    ),
    { version: '2.1.1', commit, builtAt: '2026-11-05T12:00:00.000Z' }
  );
  assert.deepEqual(consoleOf('not json'), { version: null, commit: null, builtAt: null });
  assert.deepEqual(consoleOf(JSON.stringify({ console: { version: 'v2', commit: 'short', builtAt: 'yesterday' } })), {
    version: null,
    commit: null,
    builtAt: null,
  });
});

test("the deployed bundle: both sites, their pages with the app's settings tag, and every file of both", () => {
  const { manifest } = appBundle;
  assert.equal(manifest.bridge, BRIDGE_VERSION);
  assert.deepEqual(manifest.routes, ROUTES);
  assert.equal(readManifest(appBundle.manifestBody).id, manifest.id);
  const paths = manifest.files.map((file) => file.path);
  for (const name of [
    'app.js',
    'core.js',
    'views.js',
    'bridge.js',
    'bluetooth.js',
    'updatewatch.js',
    'app.css',
    'leaflet.js',
  ]) {
    assert.ok(
      paths.some((path) => /^assets\/[0-9a-f]{12}\//.test(path) && path.endsWith(`/${name}`)),
      name
    );
  }
  for (const name of [
    'customer.js',
    'customer-core.js',
    'customer-views.js',
    'customer-mixes.js',
    'customer-mix-views.js',
    'customer-team-photos.js',
    'customer.css',
  ]) {
    assert.ok(
      paths.some((path) => path.endsWith(`/${name}`)),
      name
    );
  }
  // The About page's photos travel in the bundle as text, and stay small: at most four of 60 KB each, as
  // base64 (build-team-photos.mjs).
  const photos = manifest.files.find((file) => file.path.endsWith('/customer-team-photos.js'));
  assert.ok(photos.size <= 4 * Math.ceil((60 * 1024) / 3) * 4 + 1024, `${photos.size} bytes of photos`);
  // Each page refers only to files the bundle has.
  for (const page of ['index.html', 'admin/index.html']) {
    const object = appBundle.objects.get(manifest.files.find((file) => file.path === page).sha256);
    const html = object.body;
    assert.ok(
      html.includes(`content="${APP_CONFIG.replaceAll('"', '&quot;')}"`),
      `${page} carries the app's settings tag`
    );
    assert.doesNotMatch(html, /%BUILD%|%CONFIG%/);
    for (const [, reference] of html.matchAll(/\s(?:href|src)="(\/assets\/[^"]+)"/g)) {
      assert.ok(paths.includes(reference.slice(1)), `${page} refers to ${reference}`);
    }
  }
  // No home page: the app has no use for it.
  assert.equal(
    paths.some((path) => path.endsWith('home.css') || path.endsWith('home.html')),
    false
  );
});

const SETTINGS = {
  clientId: 'console-client-for-tests',
  loginOrigin: 'https://login.example',
  scope: 'openid cranium/console',
  userPoolId: 'xx-test-1_Staff0Pool',
  homeHosts: ['home.example'],
  customer: {
    hosts: ['cranium.example', 'www.cranium.example'],
    userPoolId: 'xx-test-1_Customer0Pool',
    clientId: 'customer-client-for-tests',
  },
  log: () => {},
};
const web = createWebHandler(SETTINGS);
const request = (path, { host = 'console.example', method = 'GET' } = {}) =>
  web({ rawPath: path, requestContext: { domainName: host, http: { method }, requestId: 'r' } });

test('the web function serves the manifest, revalidated, and each file by its SHA-256, for ever', async () => {
  const manifest = await request('/app/manifest.json');
  assert.equal(manifest.statusCode, 200);
  assert.equal(manifest.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(manifest.headers['cache-control'], 'no-cache');
  assert.equal(manifest.headers['x-content-type-options'], 'nosniff');
  assert.equal(manifest.body, appBundle.manifestBody);
  const listed = JSON.parse(manifest.body);
  for (const file of listed.files) {
    const served = await request(`/app/files/${file.sha256}`);
    assert.equal(served.statusCode, 200, file.path);
    assert.equal(served.headers['cache-control'], 'public, max-age=31536000, immutable');
    const bytes = Buffer.from(served.body, 'utf8');
    assert.equal(bytes.length, file.size, file.path);
    assert.equal(sha256(bytes), file.sha256, file.path);
  }
  // Only those: a digest it does not hold, a path below one, a path that is not a digest.
  for (const path of [
    `/app/files/${'0'.repeat(64)}`,
    `/app/files/${listed.files[0].sha256}/x`,
    '/app/files/',
    '/app/',
    '/app/manifest',
    `/app/files/${listed.files[0].sha256.toUpperCase()}`,
  ]) {
    assert.equal((await request(path)).statusCode, 404, path);
  }
  assert.equal((await request('/app/manifest.json', { method: 'POST' })).statusCode, 405);
});

test("the bundle is on the console's names and the customer site's, not on the home page's", async () => {
  assert.equal((await request('/app/manifest.json', { host: 'cranium.example' })).body, appBundle.manifestBody);
  assert.equal((await request('/app/manifest.json', { host: 'home.example' })).statusCode, 404);
  // The customer site's other names send the browser to its first, as for any path.
  assert.equal((await request('/app/manifest.json', { host: 'www.cranium.example' })).statusCode, 308);
});

test('the bundle holds nothing of the stack: no client, no pool, no address of the deployment', () => {
  const everything = [appBundle.manifestBody, ...[...appBundle.objects.values()].map((object) => object.body)].join(
    '\n'
  );
  for (const value of [
    SETTINGS.clientId,
    SETTINGS.userPoolId,
    SETTINGS.customer.clientId,
    SETTINGS.customer.userPoolId,
    'login.example',
    'cranium.example',
    'console.example',
  ]) {
    assert.equal(everything.includes(value), false, value);
  }
  // Nor the managed login pages or the API Gateway address of any deployment.
  assert.doesNotMatch(everything, /amazoncognito\.com|execute-api/);
});

test('build-bundle.mjs writes the bundle as the function serves it, and replaces only a bundle', () => {
  const out = join(work, 'WebBundle');
  const manifest = writeBundle(out, { commit: 'cd'.repeat(20) });
  assert.equal(manifest.id, appBundle.manifest.id);
  assert.equal(readManifest(readFileSync(join(out, 'manifest.json'), 'utf8')).id, manifest.id);
  const written = readdirSync(join(out, 'files')).sort();
  assert.deepEqual(written, [...appBundle.objects.keys()].sort());
  for (const digest of written) assert.equal(sha256(readFileSync(join(out, 'files', digest))), digest);
  // The version from cloud/VERSION when the deployment wrote no versions.json, and the commit given.
  const version = readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();
  if (appBundle.manifest.console.version === null) assert.equal(manifest.console.version, version);
  if (appBundle.manifest.console.commit === null) assert.equal(manifest.console.commit, 'cd'.repeat(20));
  // Again, over it: fine.
  writeBundle(out, { commit: 'cd'.repeat(20) });
  // A folder with anything else in it is left alone.
  const other = join(work, 'someone-else');
  mkdirSync(other);
  writeFileSync(join(other, 'notes.txt'), 'mine');
  assert.throws(() => writeBundle(other), /other files/);
  assert.equal(readFileSync(join(other, 'notes.txt'), 'utf8'), 'mine');
  assert.equal(existsSync(join(other, 'manifest.json')), false);
  // describedManifest keeps what the bundle said.
  const said = { ...appBundle.manifest, console: { version: '1.2.3', commit: 'ef'.repeat(20) } };
  assert.deepEqual(describedManifest(said).console, said.console);
});
