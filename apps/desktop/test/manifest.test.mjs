// The manifest reader against apps/shared/bundle-sample.json, as the phone apps' tests read it, and against
// cloud/web/src/bundle.mjs itself on every broken manifest and on changes made here.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as web from '../../../cloud/web/src/bundle.mjs';
import { ManifestError, bundleId, canonicalText, fileOf, readManifest, sha256Hex, typeOf } from '../src/lib/manifest.mjs';

const sample = JSON.parse(readFileSync(new URL('../../shared/bundle-sample.json', import.meta.url), 'utf8'));

test('the sample reads, its id is the one its canonical text works out to, and each file has its SHA-256', () => {
  const manifest = readManifest(JSON.stringify(sample.manifest));
  assert.equal(manifest.id, sample.manifest.id);
  assert.equal(canonicalText(manifest), sample.canonical);
  assert.equal(bundleId(manifest), sample.manifest.id);
  assert.equal(manifest.consoleVersion, sample.manifest.console.version);
  for (const [path, text] of Object.entries(sample.files)) {
    const file = fileOf(manifest, path);
    assert.ok(file, path);
    assert.equal(sha256Hex(Buffer.from(text, 'utf8')), file.sha256, path);
    assert.equal(Buffer.byteLength(text, 'utf8'), file.size, path);
  }
});

test('every broken manifest of the sample is refused, as bundle.mjs refuses it', () => {
  for (const [name, broken] of Object.entries(sample.broken)) {
    const text = typeof broken === 'string' ? broken : JSON.stringify(broken);
    assert.throws(() => readManifest(text), ManifestError, name);
    assert.throws(() => web.readManifest(text), Error, name);
  }
});

test('this reader and bundle.mjs agree on what they take, change by change', () => {
  const base = sample.manifest;
  const variants = [
    { ...base, format: 2 },
    { ...base, bridge: 0 },
    { ...base, bridge: 2 },
    { ...base, id: base.id.toUpperCase() },
    { ...base, routes: { ...base.routes, '/other': { file: 'index.html', policy: 'customer' } } },
    { ...base, routes: { '/': base.routes['/'] } },
    { ...base, files: [] },
    { ...base, files: base.files.map((file, index) => (index === 0 ? { ...file, size: -1 } : file)) },
    { ...base, files: base.files.map((file, index) => (index === 0 ? { ...file, path: `/${file.path}` } : file)) },
    { ...base, files: base.files.map((file, index) => (index === 0 ? { ...file, path: 'a/b/c/d/e.js' } : file)) },
    { ...base, files: base.files.map((file, index) => (index === 0 ? { ...file, path: 'x.exe' } : file)) },
    { ...base, console: { version: 'not one' } },
  ];
  for (const variant of variants) {
    const text = JSON.stringify(variant);
    let ours = true;
    let theirs = true;
    try {
      readManifest(text);
    } catch {
      ours = false;
    }
    try {
      web.readManifest(text);
    } catch {
      theirs = false;
    }
    assert.equal(ours, theirs, text.slice(0, 120));
  }
  // A bundle that needs a newer bridge reads (with its id worked out again) so that the app can say so.
  const newer = { ...base, bridge: 2 };
  newer.id = bundleId(newer);
  assert.equal(readManifest(JSON.stringify(newer)).bridge, 2);
});

test('only the five kinds of file, by the end of the path', () => {
  assert.equal(typeOf('index.html'), 'text/html; charset=utf-8');
  assert.equal(typeOf('assets/x/app.js'), 'text/javascript; charset=utf-8');
  assert.equal(typeOf('a.svg'), null);
  assert.equal(typeOf('noend'), null);
  assert.throws(() => readManifest('{'), ManifestError);
  assert.throws(() => readManifest('x'.repeat(1024 * 1024 + 1)), ManifestError);
});
