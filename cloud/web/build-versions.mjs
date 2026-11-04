#!/usr/bin/env node
/**
 * Write versions.json: the console's own version and the first paragraph of every entry of the four
 * changelogs (docs/versions.md). cloud/deploy.sh runs this while it deploys, beside build-history.mjs,
 * and writes it twice: into the site's assets, for the console's footer, its History page ("What's new")
 * and its Apps page, and beside the API's code, for GET /api/me and GET /api/apps (api/src/lib/versions.mjs).
 * Git ignores both, so a checkout that was never deployed does not have them, and the pages say so.
 *
 *   node cloud/web/build-versions.mjs [--repo <dir>] [--commit <full id>] [--tree <clean|dirty|unknown>]
 *                                     [--out <file>]...
 *
 * What it holds:
 *
 *   { "console": { "version": "1.9.1", "commit": "<40 hex>" | null, "tree": "clean", "builtAt": "<ISO time>" },
 *     "changelogs": { "console": [entry...], "firmware": [...], "ios": [...], "android": [...] } }
 *
 * where an entry is { "version", "note" } and, when the entry names them, "commit" (the first short id) and
 * "date": newest first, as each changelog has them. The note is the entry's first paragraph on one line.
 *
 * The files are not left behind when anything fails: a stale version that looks current is worse than none.
 *
 * No dependencies.
 */

import { readFileSync, chmodSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const OUTPUTS = Object.freeze([
  fileURLToPath(new URL('./src/site/assets/versions.json', import.meta.url)),
  fileURLToPath(new URL('../api/src/versions.json', import.meta.url)),
]);
// Each changelog, by the name versions.json gives it.
export const CHANGELOGS = Object.freeze({
  console: 'cloud/CHANGELOG.md',
  firmware: 'firmware/CHANGELOG.md',
  ios: 'apps/ios/CHANGELOG.md',
  android: 'apps/android/CHANGELOG.md',
});
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const HEADING = /^## (\S+)[ \t]*$/;
const NOTE_MAX = 1000;
const ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const CONTROL = /[\p{C}\p{Zl}\p{Zp}]/gu;
// "Commit 7f34f56, 2026-11-04." or "Commits 5bd2eca and 19226de, 2026-11-03." or "Commit 792ad07. RAM ..."
const COMMIT_LINE = /^Commits? ([0-9a-f]{7,40})\b(?:[^\n]*?, (\d{4}-\d{2}-\d{2})\.)?/;

/** A paragraph as one line of plain text, of a sensible length, without an address in it. */
function oneLine(text) {
  const line = text.split(/\s+/).join(' ').trim().replace(ADDRESS, '(address removed)').replace(CONTROL, ' ');
  return line.length > NOTE_MAX ? `${line.slice(0, NOTE_MAX - 1)}…` : line;
}

/**
 * The entries of a changelog, in its order: every "## <version>" heading, the first paragraph after it as the
 * note, and the commit and date of the line that names them, if one does. A heading that is not a version is
 * skipped.
 */
export function parseChangelog(text) {
  const entries = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const heading = HEADING.exec(lines[index]);
    if (!heading || !VERSION.test(heading[1])) continue;
    const paragraphs = [];
    let current = [];
    let end = index + 1;
    for (; end < lines.length && !lines[end].startsWith('## '); end += 1) {
      if (lines[end].trim() === '') {
        if (current.length > 0) paragraphs.push(current.join('\n'));
        current = [];
      } else {
        current.push(lines[end]);
      }
    }
    if (current.length > 0) paragraphs.push(current.join('\n'));
    index = end - 1;
    if (paragraphs.length === 0 || COMMIT_LINE.test(paragraphs[0])) continue;
    const entry = { version: heading[1], note: oneLine(paragraphs[0]) };
    const named = paragraphs.slice(1).map((paragraph) => COMMIT_LINE.exec(paragraph.trim())).find(Boolean);
    if (named) {
      entry.commit = named[1].slice(0, 12);
      if (named[2]) entry.date = named[2];
    }
    entries.push(entry);
  }
  return entries;
}

/** The console's version, from cloud/VERSION. */
export function readConsoleVersion(repo) {
  const version = readFileSync(join(repo, 'cloud', 'VERSION'), 'utf8').trim();
  if (!VERSION.test(version)) throw new Error(`cloud/VERSION holds no version: ${JSON.stringify(version.slice(0, 40))}`);
  return version;
}

export function buildVersions({ repo = REPO, commit = null, tree = 'unknown', now = new Date() } = {}) {
  const changelogs = {};
  for (const [name, path] of Object.entries(CHANGELOGS)) {
    changelogs[name] = parseChangelog(readFileSync(join(repo, path), 'utf8'));
  }
  return {
    console: {
      version: readConsoleVersion(repo),
      commit: /^[0-9a-f]{40}$/.test(commit ?? '') ? commit : null,
      tree: ['clean', 'dirty'].includes(tree) ? tree : 'unknown',
      builtAt: now.toISOString(),
    },
    changelogs,
  };
}

/**
 * Write the file so that the functions can read it: they run as another user, the package keeps each file's
 * permission bits, and deploy.sh runs with umask 077.
 */
export function writeVersions(versions, out) {
  const work = `${out}.tmp`;
  writeFileSync(work, `${JSON.stringify(versions)}\n`);
  chmodSync(work, 0o644);
  renameSync(work, out);
}

function options(args, name) {
  const found = [];
  for (let at = args.indexOf(name); at >= 0; at = args.indexOf(name, at + 1)) found.push(args[at + 1]);
  return found;
}

function main(args) {
  const outs = options(args, '--out');
  const targets = outs.length > 0 ? outs : OUTPUTS;
  for (const out of targets) rmSync(out, { force: true });
  try {
    const versions = buildVersions({
      repo: options(args, '--repo')[0] ?? REPO,
      commit: options(args, '--commit')[0] ?? null,
      tree: options(args, '--tree')[0] ?? 'unknown',
    });
    for (const out of targets) writeVersions(versions, out);
    const counts = Object.entries(versions.changelogs).map(([name, entries]) => `${entries.length} ${name}`).join(', ');
    console.log(`Console ${versions.console.version}; changelog entries: ${counts}. Wrote ${targets.join(' and ')}`);
  } catch (error) {
    for (const out of targets) rmSync(out, { force: true });
    console.error(`The versions could not be written: ${error.message}`);
    process.exitCode = 1;
  }
}

// Node gives this module's real path, and the command line whatever path it was called by.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main(process.argv.slice(2));
