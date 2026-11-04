/**
 * The script that writes versions.json at deployment (build-versions.mjs): the console's version from
 * cloud/VERSION and every changelog's entries, newest first, each a version and its first paragraph; and
 * how cloud/deploy.sh runs it. It runs here against a repository made for the test.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CHANGELOGS, OUTPUTS, buildVersions, parseChangelog } from '../build-versions.mjs';
import { parseBundledVersions } from '../../api/src/lib/versions.mjs';

const SCRIPT = fileURLToPath(new URL('../build-versions.mjs', import.meta.url));
const CLOUD = fileURLToPath(new URL('../../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'cranium-versions-'));
after(() => rmSync(work, { recursive: true, force: true }));

const CONSOLE = `# Console changes

One entry per version, newest first. The first paragraph is what the console shows.

## 1.10.0

The Apps page: the phone apps to download
and to build, with a QR code.

Commit 1234567, 2026-11-05.

## 1.9.1

Phone sessions can last 30 days. Ask someone@example.org.

Commits 7f34f56 and 89abcde, 2026-11-04.

## Unreleased

Not a version.

## 1.9.0

Each board's own log.
`;

function repository(files = {}) {
  const root = mkdtempSync(join(work, 'repo-'));
  const all = {
    'cloud/VERSION': '1.10.0\n',
    'cloud/CHANGELOG.md': CONSOLE,
    'firmware/CHANGELOG.md': '# Firmware\n\n## 1.13.0\n\nIdentify blinks both LEDs.\n\nCommit 792ad07. RAM 393.2 KB of 400 KB.\n',
    'apps/ios/CHANGELOG.md': '# iPhone\n\n## 0.5.0\n\nThe board log.\n\n## 0.4.0\n\nFace ID.\n\nCommit a244efa, 2026-11-04.\n',
    'apps/android/CHANGELOG.md': '# Android\r\n\r\n## 0.4.0\r\n\r\nYour fingerprint.\r\n',
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    if (text === null) continue;
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('an entry is its version and its first paragraph on one line, with the commit and date that name it', () => {
  assert.deepEqual(parseChangelog(CONSOLE), [
    { version: '1.10.0', note: 'The Apps page: the phone apps to download and to build, with a QR code.', commit: '1234567', date: '2026-11-05' },
    // No address of a person in what the console shows.
    { version: '1.9.1', note: 'Phone sessions can last 30 days. Ask (address removed).', commit: '7f34f56', date: '2026-11-04' },
    { version: '1.9.0', note: 'Each board\'s own log.' },
  ]);
  assert.deepEqual(parseChangelog('## 1.0.0\n\nCommit 42998d6.\n'), []);
  assert.deepEqual(parseChangelog('## 1.13.0\n\nNote.\n\nCommit 792ad07. RAM 393.2 KB.\n'), [{ version: '1.13.0', note: 'Note.', commit: '792ad07' }]);
  assert.equal(parseChangelog(`## 1.0.0\n\n${'x'.repeat(1200)}\n`)[0].note.length, 1000);
});

test('versions.json holds the console\'s version, the commit, and each changelog newest first', () => {
  const versions = buildVersions({ repo: repository(), commit: 'f'.repeat(40), tree: 'clean', now: new Date('2026-11-04T18:00:00Z') });
  assert.deepEqual(versions.console, { version: '1.10.0', commit: 'f'.repeat(40), tree: 'clean', builtAt: '2026-11-04T18:00:00.000Z' });
  assert.deepEqual(Object.keys(versions.changelogs), Object.keys(CHANGELOGS));
  assert.deepEqual(versions.changelogs.console.map((entry) => entry.version), ['1.10.0', '1.9.1', '1.9.0']);
  assert.deepEqual(versions.changelogs.firmware, [{ version: '1.13.0', note: 'Identify blinks both LEDs.', commit: '792ad07' }]);
  assert.deepEqual(versions.changelogs.ios[0], { version: '0.5.0', note: 'The board log.' });
  assert.deepEqual(versions.changelogs.android, [{ version: '0.4.0', note: 'Your fingerprint.' }]);
  // What the API keeps of it (cloud/api/src/lib/versions.mjs).
  assert.deepEqual(parseBundledVersions(versions), {
    console: { version: '1.10.0', commit: 'f'.repeat(40) },
    ios: { version: '0.5.0', note: 'The board log.' },
    android: { version: '0.4.0', note: 'Your fingerprint.' },
  });
  const unknown = buildVersions({ repo: repository(), commit: 'unknown', tree: 'odd' });
  assert.deepEqual([unknown.console.commit, unknown.console.tree], [null, 'unknown']);
});

test('the command writes every file it is given, readable by the functions, and none when it fails', () => {
  const repo = repository();
  const outs = [join(work, 'site-versions.json'), join(work, 'api-versions.json')];
  const ok = spawnSync('node', [SCRIPT, '--repo', repo, '--commit', 'a'.repeat(40), '--tree', 'dirty', '--out', outs[0], '--out', outs[1]],
    { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^Console 1\.10\.0; changelog entries: 3 console, 1 firmware, 2 ios, 1 android\./);
  for (const out of outs) {
    assert.equal(statSync(out).mode & 0o777, 0o644, out);
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual([written.console.version, written.console.commit, written.console.tree], ['1.10.0', 'a'.repeat(40), 'dirty']);
  }
  // A broken VERSION, or a changelog that is not there: no file is left behind, old or new.
  for (const broken of [repository({ 'cloud/VERSION': 'one.nine\n' }), repository({ 'apps/ios/CHANGELOG.md': null })]) {
    const failed = spawnSync('node', [SCRIPT, '--repo', broken, '--out', outs[0], '--out', outs[1]], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /The versions could not be written/);
    for (const out of outs) assert.equal(existsSync(out), false, out);
  }
  // By default it writes the two the deployment packages: the site's and the API's.
  assert.deepEqual(OUTPUTS, [join(CLOUD, 'web/src/site/assets/versions.json'), join(CLOUD, 'api/src/versions.json')]);
});

test('deploy.sh writes both while it packages, leaves them out of what makes a tree dirty, and git ignores them', () => {
  const deploy = readFileSync(join(CLOUD, 'deploy.sh'), 'utf8');
  assert.match(deploy, /node "\$CLOUD_DIR\/web\/build-versions\.mjs" --repo "\$REPO_DIR" --commit "\$commit" --tree "\$tree" \\\n {4}--out "\$CLOUD_DIR\/web\/src\/site\/assets\/versions\.json" --out "\$CLOUD_DIR\/api\/src\/versions\.json"/);
  // After the history, and before the package is made.
  assert.ok(deploy.indexOf('build-history.mjs" --repo') < deploy.indexOf('build-versions.mjs" --repo'));
  assert.ok(deploy.indexOf('build-versions.mjs" --repo') < deploy.indexOf('aws cloudformation package'));
  for (const path of ['cloud/web/src/site/assets/versions.json', 'cloud/api/src/versions.json']) {
    assert.ok(deploy.includes(`':(exclude)${path}'`), path);
    const ignored = spawnSync('git', ['-C', CLOUD, 'check-ignore', '-q', join(CLOUD, '..', path)]);
    assert.equal(ignored.status, 0, `${path} is ignored`);
  }
});

test('the files on disk, where this checkout has them, hold what they may', { skip: !OUTPUTS.some(existsSync) }, () => {
  for (const out of OUTPUTS.filter(existsSync)) {
    const text = readFileSync(out, 'utf8');
    const data = JSON.parse(text);
    assert.match(data.console.version, /^\d+\.\d+\.\d+$/);
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  }
});
