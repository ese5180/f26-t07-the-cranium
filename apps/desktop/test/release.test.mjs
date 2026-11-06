// The release path: the installers a release publishes (scripts/installers.mjs) are the ones
// apps/write-dist-index.py lists in apps/dist/latest.json, under the system's entry, and the ones the check
// for a newer build takes; and a platform's version is read from its electron-builder file.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { INSTALLERS, installersIn } from '../scripts/installers.mjs';
import { versionIn } from '../scripts/version-of.mjs';
import { newerBuild } from '../src/lib/updates.mjs';

const WRITER = fileURLToPath(new URL('../../write-dist-index.py', import.meta.url));
const python = ['python3', 'python'].find((name) => spawnSync(name, ['--version']).status === 0);

test('each published installer is in latest.json under its system, the first one offered, and the update check takes it', { skip: !python }, (t) => {
  const dist = mkdtempSync(join(tmpdir(), 'cranium-dist-'));
  // Best-effort: on Windows a file may still be held for a moment (by the antivirus), and that is no failure.
  t.after(() => {
    try {
      rmSync(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Left in the temporary folder.
    }
  });
  const names = { windows: INSTALLERS.windows('0.1.0'), linux: INSTALLERS.linux('0.2.0') };
  for (const name of [...names.windows, ...names.linux, 'cranium-android-0.8.0.apk', 'Cranium-0.1.0.zip']) {
    writeFileSync(join(dist, name), name);
  }
  execFileSync(python, ['-I', WRITER, dist]);
  const latest = JSON.parse(readFileSync(join(dist, 'latest.json'), 'utf8'));
  assert.deepEqual(Object.keys(latest).sort(), ['android', 'desktop-linux', 'desktop-windows']);
  assert.deepEqual(latest['desktop-windows'].files.map((file) => file.file), names.windows);
  assert.deepEqual(latest['desktop-linux'].files.map((file) => file.file), names.linux);
  assert.equal(latest['desktop-windows'].file, 'Cranium-Setup-0.1.0.exe');
  assert.equal(latest['desktop-linux'].file, 'Cranium-0.2.0.AppImage');
  const sums = readFileSync(join(dist, 'SHA256SUMS'), 'utf8');
  assert.equal(sums.includes('Cranium-0.1.0.zip'), false);
  for (const [system, platform] of [['windows', 'win32'], ['linux', 'linux']]) {
    for (const file of latest[`desktop-${system}`].files) {
      const entry = { [`desktop-${system}`]: { ...file, version: latest[`desktop-${system}`].version } };
      assert.equal(newerBuild(JSON.stringify(entry), { platform, version: '0.0.1' })?.file, file.file, file.file);
    }
  }
  assert.deepEqual(installersIn(['Cranium-Setup-0.1.0.exe', 'other.exe'], 'windows', '0.1.0'), ['Cranium-Setup-0.1.0.exe']);
});

test("a platform's version is extraMetadata.version in its electron-builder file", () => {
  const script = fileURLToPath(new URL('../scripts/version-of.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, 'nowhere']);
  assert.equal(run.status, 2);
  assert.equal(versionIn('extends: base\nextraMetadata:\n  name: x\n  version: 0.1.2\nwin: {}\n'), '0.1.2');
  assert.equal(versionIn("extraMetadata:\n  version: '1.0.0'\n"), '1.0.0');
  assert.equal(versionIn('version: 0.1.0\n'), null);
  assert.equal(versionIn('extraMetadata:\n  name: x\nversion: 0.1.0\n'), null);
});
