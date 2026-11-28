/**
 * The script that writes versions.json at deployment (build-versions.mjs): the console's version from
 * cloud/VERSION and every changelog's entries, newest first, each a version and its first paragraph; and
 * how cloud/deploy.sh runs it. It runs here against a repository made for the test.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHANGELOGS,
  NOTES_OUTPUT,
  OUTPUTS,
  RELEASE_CHANGELOGS,
  buildReleaseNotes,
  buildVersions,
  parseChangelog,
  parseEntries,
  readTags,
} from '../build-versions.mjs';
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
    'firmware/CHANGELOG.md':
      '# Firmware\n\n## 1.13.0\n\nIdentify blinks both LEDs.\n\nCommit 792ad07. RAM 393.2 KB of 400 KB.\n',
    'apps/ios/CHANGELOG.md':
      '# iPhone\n\n## 0.5.0\n\nThe board log.\n\n## 0.4.0\n\nFace ID.\n\nCommit a244efa, 2026-11-04.\n',
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
    {
      version: '1.10.0',
      note: 'The Apps page: the phone apps to download and to build, with a QR code.',
      commit: '1234567',
      date: '2026-11-05',
    },
    // No address of a person in what the console shows.
    {
      version: '1.9.1',
      note: 'Phone sessions can last 30 days. Ask (address removed).',
      commit: '7f34f56',
      date: '2026-11-04',
    },
    { version: '1.9.0', note: "Each board's own log." },
  ]);
  assert.deepEqual(parseChangelog('## 1.0.0\n\nCommit 42998d6.\n'), []);
  assert.deepEqual(parseChangelog('## 1.13.0\n\nNote.\n\nCommit 792ad07. RAM 393.2 KB.\n'), [
    { version: '1.13.0', note: 'Note.', commit: '792ad07' },
  ]);
  assert.equal(parseChangelog(`## 1.0.0\n\n${'x'.repeat(1200)}\n`)[0].note.length, 1000);
});

test("versions.json holds the console's version, the commit, and each changelog newest first", () => {
  const versions = buildVersions({
    repo: repository(),
    commit: 'f'.repeat(40),
    tree: 'clean',
    now: new Date('2026-11-04T18:00:00Z'),
  });
  assert.deepEqual(versions.console, {
    version: '1.10.0',
    commit: 'f'.repeat(40),
    tree: 'clean',
    builtAt: '2026-11-04T18:00:00.000Z',
  });
  assert.deepEqual(Object.keys(versions.changelogs), Object.keys(CHANGELOGS));
  assert.deepEqual(
    versions.changelogs.console.map((entry) => entry.version),
    ['1.10.0', '1.9.1', '1.9.0']
  );
  assert.deepEqual(versions.changelogs.firmware, [
    { version: '1.13.0', note: 'Identify blinks both LEDs.', commit: '792ad07' },
  ]);
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
  const ok = spawnSync(
    'node',
    [SCRIPT, '--repo', repo, '--commit', 'a'.repeat(40), '--tree', 'dirty', '--out', outs[0], '--out', outs[1]],
    { encoding: 'utf8' }
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^Console 1\.10\.0; changelog entries: 3 console, 1 firmware, 2 ios, 1 android\./);
  for (const out of outs) {
    assert.equal(statSync(out).mode & 0o777, 0o644, out);
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(
      [written.console.version, written.console.commit, written.console.tree],
      ['1.10.0', 'a'.repeat(40), 'dirty']
    );
  }
  // A broken VERSION, or a changelog that is not there: no file is left behind, old or new.
  for (const broken of [repository({ 'cloud/VERSION': 'one.nine\n' }), repository({ 'apps/ios/CHANGELOG.md': null })]) {
    const failed = spawnSync('node', [SCRIPT, '--repo', broken, '--out', outs[0], '--out', outs[1]], {
      encoding: 'utf8',
    });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /The versions could not be written/);
    for (const out of outs) assert.equal(existsSync(out), false, out);
  }
  // By default it writes the two the deployment packages: the site's and the API's.
  assert.deepEqual(OUTPUTS, [join(CLOUD, 'web/src/site/assets/versions.json'), join(CLOUD, 'api/src/versions.json')]);
});

test('deploy.sh writes both while it packages, leaves them out of what makes a tree dirty, and git ignores them', () => {
  const deploy = readFileSync(join(CLOUD, 'deploy.sh'), 'utf8');
  assert.match(
    deploy,
    /node "\$CLOUD_DIR\/web\/build-versions\.mjs" --repo "\$REPO_DIR" --commit "\$commit" --tree "\$tree" \\\n {4}--out "\$CLOUD_DIR\/web\/src\/site\/assets\/versions\.json" --out "\$CLOUD_DIR\/api\/src\/versions\.json"/
  );
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

// release-notes.json (buildReleaseNotes): every entry in full, of the four changelogs and the desktop and Mac apps'.

const MAC = `# Mac app changelog

## 0.3.0

- The serial port, through the bridge (\`usb.open\`); see [the guide](../../docs/mac-app.md).
- **Menus** again.

## 0.3.0 (review fixes)

- Windows share the sign-ins.

## 0.2.0

- The console's pages in a web view.

Live updates from \`wss://<API id>.execute-api.<region>.amazonaws.com/<stage>\` and https://x.execute-api.example/a.
`;
const FIRMWARE = `# Firmware

## 1.18.0

Sessions to the cloud. Tested on an nRF7002 DK.

Flash 749,176 of 794,474 bytes (1.15.0: 746,488); RAM 404,404 of 405,504 (1,100 free); signed image
880,422 bytes.

## 1.13.0

Identify blinks both LEDs on the nRF5340DK too.

Commit 792ad07, 2026-11-05. RAM 393.2 KB of 400 KB.
`;

function notesRepository() {
  const root = repository({
    'firmware/CHANGELOG.md': FIRMWARE,
    'apps/desktop/CHANGELOG.windows.md': '# Windows\n\n## 0.1.1\n\nSchedules.\n\n## 0.1.0\n\nFirst.\n',
    'apps/desktop/CHANGELOG.linux.md': '# Linux\n\n## 0.1.1\n\nSchedules, on Linux.\n\n## 0.1.0\n\nFirst.\n',
    'apps/macos/CHANGELOG.md': MAC,
  });
  const git = (...args) =>
    execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'A',
        GIT_AUTHOR_EMAIL: 'a@example.invalid',
        GIT_COMMITTER_NAME: 'A',
        GIT_COMMITTER_EMAIL: 'a@example.invalid',
        GIT_AUTHOR_DATE: '2026-11-06T10:00:00Z',
        GIT_COMMITTER_DATE: '2026-11-06T10:00:00Z',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'Changelogs');
  // An annotated tag and lightweight ones, as the repository has both.
  git('tag', '-a', 'firmware-v1.13.0', '-m', 'Identify');
  git('tag', 'desktop-windows-v0.1.0');
  git('tag', 'desktop-linux-v0.1.0');
  git('tag', 'ios-v0.4.0');
  git('tag', 'console-v1.9.1');
  git('tag', 'not-a-release');
  return { root, head: git('rev-parse', 'HEAD') };
}

test('release notes hold every entry in full, its tag and commit, and what is current', () => {
  const { root, head } = notesRepository();
  const tags = readTags(root);
  assert.deepEqual(tags.get('firmware-v1.13.0'), { commit: head.slice(0, 12), date: '2026-11-06' });
  assert.equal(tags.has('not-a-release'), false);

  const notes = buildReleaseNotes({ repo: root, now: new Date('2026-11-10T00:00:00Z') });
  assert.deepEqual(Object.keys(notes.products), ['console', 'firmware', 'ios', 'android', 'windows', 'linux', 'macos']);
  assert.deepEqual(Object.keys(RELEASE_CHANGELOGS), Object.keys(notes.products));
  assert.deepEqual(notes.console, { version: '1.10.0' });
  assert.equal(notes.builtAt, '2026-11-10T00:00:00.000Z');

  // The console: its current version is this deployment's; the rest of an entry is under more.
  const consoleLog = notes.products.console;
  assert.equal(consoleLog.current, '1.10.0');
  assert.deepEqual(consoleLog.entries[0], {
    version: '1.10.0',
    summary: 'The Apps page: the phone apps to download and to build, with a QR code.',
    more: [{ p: 'Commit 1234567, 2026-11-05.' }],
    commit: '1234567',
    date: '2026-11-05',
  });
  // A tagged version: the tag, and the tag's commit over the one the changelog names.
  assert.equal(consoleLog.entries[1].tag, 'console-v1.9.1');
  assert.equal(consoleLog.entries[1].commit, head.slice(0, 12));
  assert.equal(consoleLog.entries[1].date, '2026-11-04');
  assert.match(consoleLog.entries[1].summary, /\(address removed\)/);

  // The firmware: the boards, flash and RAM where an entry names them; the date from the tag's commit when the
  // changelog gives none; the newest tagged version is current.
  const firmware = notes.products.firmware;
  assert.equal(firmware.current, '1.13.0');
  assert.deepEqual(
    firmware.entries.map(({ version, boards, flash, ram, tag, date }) => ({ version, boards, flash, ram, tag, date })),
    [
      {
        version: '1.18.0',
        boards: ['nRF7002 DK'],
        flash: '749,176 of 794,474 bytes',
        ram: '404,404 of 405,504 bytes',
        tag: undefined,
        date: undefined,
      },
      {
        version: '1.13.0',
        boards: ['nRF5340 DK'],
        flash: undefined,
        ram: '393.2 KB of 400 KB',
        tag: 'firmware-v1.13.0',
        date: '2026-11-05',
      },
    ]
  );
  assert.equal(notes.products.ios.current, '0.4.0');
  assert.equal(notes.products.ios.entries[1].date, '2026-11-04');
  assert.equal(notes.products.android.current, null);

  // The desktop app, a changelog per platform, and the Mac app's lists, links and added headings.
  assert.equal(notes.products.windows.current, '0.1.0');
  assert.equal(notes.products.linux.entries[0].summary, 'Schedules, on Linux.');
  assert.equal(notes.products.windows.entries[1].tag, 'desktop-windows-v0.1.0');
  assert.equal(notes.products.windows.entries[1].date, '2026-11-06');
  assert.equal(notes.products.macos.current, null);
  assert.deepEqual(notes.products.macos.entries, [
    {
      version: '0.3.0',
      summary: 'The serial port, through the bridge (`usb.open`); see the guide.',
      more: [{ list: ['Menus again.'] }, { h: 'review fixes' }, { list: ['Windows share the sign-ins.'] }],
    },
    // No AWS address, even as a pattern: the app bundle carries the file (bundle.test.mjs).
    {
      version: '0.2.0',
      summary: "The console's pages in a web view.",
      more: [{ p: 'Live updates from `an AWS address` and an AWS address' }],
    },
  ]);

  // Without git (a copy of the files), there are no tags, and nothing else is lost.
  const copy = buildReleaseNotes({ repo: root, tags: new Map() });
  assert.equal(copy.products.firmware.current, null);
  assert.equal(copy.products.firmware.entries[1].commit, '792ad07');
  assert.deepEqual(readTags(join(work, 'nowhere')), new Map());
});

test('a version is one entry, and a heading that is not a version ends the entry before it', () => {
  assert.deepEqual(parseEntries('## 1.0.0\n\nOne.\n\n## Unreleased\n\nNot this.\n\n## 0.9.0\n\nCommit 42998d6.\n'), [
    { version: '1.0.0', paragraphs: ['One.'] },
  ]);
  assert.deepEqual(parseEntries('## 2.0.0 (again)\n\nTwo.\n'), [{ version: '2.0.0', paragraphs: ['Two.'] }]);
});

test("the command writes release-notes.json with --notes, and deploy.sh asks for it into the site's assets", () => {
  const { root } = notesRepository();
  const outs = [join(work, 'n-versions.json'), join(work, 'n-api.json'), join(work, 'n-notes.json')];
  const args = (repo) => [SCRIPT, '--repo', repo, '--out', outs[0], '--out', outs[1], '--notes', outs[2]];
  const ok = spawnSync('node', args(root), { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  for (const out of outs) assert.equal(statSync(out).mode & 0o777, 0o644, out);
  assert.equal(JSON.parse(readFileSync(outs[2], 'utf8')).products.firmware.entries.length, 2);
  // versions.json keeps to the four changelogs' first paragraphs: small, for every page and the API.
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(outs[0], 'utf8')).changelogs), Object.keys(CHANGELOGS));
  // A changelog only the release notes read is not there: versions.json is still written, fresh, and the old
  // release notes are not left behind.
  const noMac = spawnSync('node', args(repository({ 'apps/macos/CHANGELOG.md': null })), { encoding: 'utf8' });
  assert.equal(noMac.status, 0, noMac.stderr);
  assert.match(noMac.stderr, /the release notes could not be written/);
  for (const out of outs.slice(0, 2)) assert.equal(JSON.parse(readFileSync(out, 'utf8')).console.version, '1.10.0');
  assert.equal(existsSync(outs[2]), false);
  assert.equal(existsSync(`${outs[2]}.tmp`), false);
  // A changelog both read is not there: no file is left behind, and the command fails.
  const failed = spawnSync('node', args(repository({ 'apps/ios/CHANGELOG.md': null })), { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  for (const out of outs) assert.equal(existsSync(out), false, out);
  // Without --out, it writes all three where the deployment packages them.
  assert.equal(NOTES_OUTPUT, join(CLOUD, 'web/src/site/assets/release-notes.json'));
  const deploy = readFileSync(join(CLOUD, 'deploy.sh'), 'utf8');
  assert.match(
    deploy,
    /--out "\$CLOUD_DIR\/api\/src\/versions\.json" \\\n {4}--notes "\$CLOUD_DIR\/web\/src\/site\/assets\/release-notes\.json"/
  );
  assert.ok(deploy.includes("':(exclude)cloud/web/src/site/assets/release-notes.json'"));
  const ignored = spawnSync('git', [
    '-C',
    CLOUD,
    'check-ignore',
    '-q',
    join(CLOUD, 'web/src/site/assets/release-notes.json'),
  ]);
  assert.equal(ignored.status, 0);
});

test(
  'the release notes on disk, where this checkout has them, hold what they may',
  { skip: !existsSync(NOTES_OUTPUT) },
  () => {
    const text = readFileSync(NOTES_OUTPUT, 'utf8');
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    assert.match(JSON.parse(text).console.version, /^\d+\.\d+\.\d+$/);
  }
);
