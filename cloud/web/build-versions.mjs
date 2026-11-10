#!/usr/bin/env node
/**
 * Write versions.json: the console's own version and the first paragraph of every entry of the four
 * changelogs (docs/versions.md). cloud/deploy.sh runs this while it deploys, beside build-history.mjs,
 * and writes it twice: into the site's assets, for the console's footer, its History page ("What's new")
 * and its Apps page, and beside the API's code, for GET /api/me and GET /api/apps (api/src/lib/versions.mjs).
 * Git ignores both, so a checkout that was never deployed does not have them, and the pages say so.
 *
 *   node cloud/web/build-versions.mjs [--repo <dir>] [--commit <full id>] [--tree <clean|dirty|unknown>]
 *                                     [--out <file>]... [--notes <file>]
 *
 * What it holds:
 *
 *   { "console": { "version": "1.9.1", "commit": "<40 hex>" | null, "tree": "clean", "builtAt": "<ISO time>" },
 *     "changelogs": { "console": [entry...], "firmware": [...], "ios": [...], "android": [...] } }
 *
 * where an entry is { "version", "note" } and, when the entry names them, "commit" (the first short id) and
 * "date": newest first, as each changelog has them. The note is the entry's first paragraph on one line.
 *
 * With --notes <file> (and by default, when no --out is given) it also writes release-notes.json, for the
 * console's Release notes page only: every entry of those four changelogs and of the desktop app's two and the
 * Mac app's (RELEASE_CHANGELOGS) in full, with its date and its release
 * tag from git (buildReleaseNotes). That is many times the size of versions.json, so only that page fetches it,
 * and the API does not get it.
 *
 * The files are not left behind when anything fails: a stale version that looks current is worse than none.
 *
 * No dependencies.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, chmodSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const OUTPUTS = Object.freeze([
  fileURLToPath(new URL('./src/site/assets/versions.json', import.meta.url)),
  fileURLToPath(new URL('../api/src/versions.json', import.meta.url)),
]);
// release-notes.json: the site's only.
export const NOTES_OUTPUT = fileURLToPath(new URL('./src/site/assets/release-notes.json', import.meta.url));
// Each changelog, by the name versions.json gives it.
export const CHANGELOGS = Object.freeze({
  console: 'cloud/CHANGELOG.md',
  firmware: 'firmware/CHANGELOG.md',
  ios: 'apps/ios/CHANGELOG.md',
  android: 'apps/android/CHANGELOG.md',
});
// And release-notes.json's: those four and the desktop and Mac apps', which no page but Release notes reads.
export const RELEASE_CHANGELOGS = Object.freeze({
  ...CHANGELOGS,
  windows: 'apps/desktop/CHANGELOG.windows.md',
  linux: 'apps/desktop/CHANGELOG.linux.md',
  macos: 'apps/macos/CHANGELOG.md',
});
// Each changelog's release tags, `<prefix><version>` on the commit it was built from (docs/versions.md).
export const TAG_PREFIXES = Object.freeze({
  console: 'console-v',
  firmware: 'firmware-v',
  ios: 'ios-v',
  android: 'android-v',
  windows: 'desktop-windows-v',
  linux: 'desktop-linux-v',
  macos: 'macos-v',
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
    const named = paragraphs
      .slice(1)
      .map((paragraph) => COMMIT_LINE.exec(paragraph.trim()))
      .find(Boolean);
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
  if (!VERSION.test(version))
    throw new Error(`cloud/VERSION holds no version: ${JSON.stringify(version.slice(0, 40))}`);
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

// Release notes: every entry in full (release-notes.json).

// "## 0.3.0" and also "## 0.3.0 (review fixes)", which the Mac app's changelog adds to a version it already has.
const FULL_HEADING = /^## (\d{1,4}\.\d{1,4}\.\d{1,6})(?:[ \t]+\(([^()\n]{1,60})\))?[ \t]*$/;
const BLOCK_MAX = 4000;
const ENTRY_MAX = 24000;
const ITEM = /^\s{0,3}[-*] /;
// Where a firmware entry names them: the boards it was tried on or is for, and its flash and RAM.
const BOARDS = Object.freeze([
  ['nRF7002 DK', /\bnRF7002[ -]?DK\b/i],
  ['nRF5340 DK', /\bnRF5340[ -]?DK\b/i],
]);
const FLASH = /\bFlash (\d[\d,]{1,10}\d) of (\d[\d,]{1,10}\d) bytes/;
const RAM = /\bRAM (\d(?:[\d,.]{0,10}\d)?)( KB)? of (\d(?:[\d,.]{0,10}\d)?)( KB)?/;

// The form of an AWS service's address, even as a pattern with <placeholders>: the app bundle, which carries this file,
// names no address of the stack (bundle.test.mjs), and a reader has no use for one.
const AWS_HOST = String.raw`(?:execute-api|amazoncognito\.com|amazonaws\.com)`;
const URL_PART = String.raw`(?:<[^<>\s]{1,12}(?: [^<>\s]{1,12})?>|[^\s\`()<>])`;
const AWS_ADDRESS = new RegExp(
  String.raw`(?:wss?|https?):\/\/${URL_PART}*${AWS_HOST}${URL_PART}*|${URL_PART}*${AWS_HOST}${URL_PART}*`,
  'g'
);

/** Text as one line for reading: no address, no control characters, Markdown links as their words, no bold. */
function plain(text) {
  const line = text
    .split(/\s+/)
    .join(' ')
    .trim()
    .replace(/\[([^\]\n]{1,200})\]\([^)\s]{1,400}\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(ADDRESS, '(address removed)')
    .replace(AWS_ADDRESS, 'an AWS address')
    .replace(CONTROL, ' ');
  return line.length > BLOCK_MAX ? `${line.slice(0, BLOCK_MAX - 1)}…` : line;
}

/** A paragraph as the page draws it: { p: text }, or { list: [item...] } when every line is an item or under one. */
function blockOf(paragraph) {
  const lines = paragraph.split('\n');
  if (!ITEM.test(lines[0])) return { p: plain(paragraph) };
  const items = [];
  for (const line of lines) {
    if (ITEM.test(line)) items.push(line.replace(ITEM, ''));
    else items[items.length - 1] += ` ${line}`;
  }
  return { list: items.map(plain) };
}

/**
 * The entries of a changelog in full, in its order: each version's paragraphs, with a heading "## <version> (<words>)"
 * of a version already seen added to it under those words.
 */
export function parseEntries(text) {
  const entries = [];
  let entry = null;
  let current = [];
  const close = () => {
    if (entry && current.length > 0) entry.paragraphs.push(current.join('\n'));
    current = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('## ')) {
      close();
      const heading = FULL_HEADING.exec(line);
      if (!heading) {
        entry = null;
      } else if (heading[2] && entries.at(-1)?.version === heading[1]) {
        entry = entries.at(-1);
        entry.paragraphs.push({ h: plain(heading[2]) });
      } else {
        entry = { version: heading[1], paragraphs: [] };
        entries.push(entry);
      }
    } else if (line.trim() === '') {
      close();
    } else if (entry) {
      current.push(line);
    }
  }
  close();
  return entries.filter((one) => typeof one.paragraphs[0] === 'string' && !COMMIT_LINE.test(one.paragraphs[0].trim()));
}

/**
 * The release tags git has: name -> { commit (12 hex), date (yyyy-mm-dd of that commit) }. Annotated tags are
 * followed to their commit. Empty when git cannot say, as in a copy without .git: the page then shows no tags.
 */
export function readTags(repo) {
  let out;
  try {
    out = execFileSync(
      'git',
      [
        '-C',
        repo,
        'for-each-ref',
        '--format=%(refname:short)%09%(*objectname)%09%(objectname)%09%(*committerdate:short)%09%(committerdate:short)',
        'refs/tags',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 }
    );
  } catch {
    return new Map();
  }
  const tags = new Map();
  for (const line of out.split('\n')) {
    const [name, peeled, own, peeledDate, ownDate] = line.split('\t');
    const commit = peeled || own;
    const date = peeledDate || ownDate;
    if (!/^[a-z-]+-v\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(name ?? '') || !/^[0-9a-f]{40,64}$/.test(commit ?? '')) continue;
    tags.set(name, { commit: commit.slice(0, 12), date: /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? date : null });
  }
  return tags;
}

/** One entry of release-notes.json. */
function noteOf(raw, name, tags) {
  const blocks = raw.paragraphs.map((paragraph) => (typeof paragraph === 'string' ? blockOf(paragraph) : paragraph));
  const [first, ...rest] = blocks;
  // A list as the first paragraph (the Mac app's changelog): its first item is the summary.
  const summary = first.p ?? first.list[0];
  const more = first.list && first.list.length > 1 ? [{ list: first.list.slice(1) }, ...rest] : rest;
  const entry = { version: raw.version, summary };
  // Cut at a whole block, so that what is shown is never half a sentence and a list.
  let size = summary.length;
  entry.more = [];
  for (const block of more) {
    size += JSON.stringify(block).length;
    if (size > ENTRY_MAX) break;
    entry.more.push(block);
  }
  const named = raw.paragraphs
    .slice(1)
    .filter((paragraph) => typeof paragraph === 'string')
    .map((paragraph) => COMMIT_LINE.exec(paragraph.trim()))
    .find(Boolean);
  const tag = tags.get(`${TAG_PREFIXES[name]}${raw.version}`);
  if (tag) entry.tag = `${TAG_PREFIXES[name]}${raw.version}`;
  const commit = tag?.commit ?? named?.[1]?.slice(0, 12);
  if (commit) entry.commit = commit;
  const date = named?.[2] ?? tag?.date;
  if (date) entry.date = date;
  if (name === 'firmware') {
    const whole = raw.paragraphs
      .filter((paragraph) => typeof paragraph === 'string')
      .join(' ')
      .replace(/\s+/g, ' ');
    const boards = BOARDS.filter(([, pattern]) => pattern.test(whole)).map(([board]) => board);
    if (boards.length > 0) entry.boards = boards;
    const flash = FLASH.exec(whole);
    if (flash) entry.flash = `${flash[1]} of ${flash[2]} bytes`;
    const ram = RAM.exec(whole);
    if (ram) entry.ram = ram[2] || ram[4] ? `${ram[1]} KB of ${ram[3]} KB` : `${ram[1]} of ${ram[3]} bytes`;
  }
  return entry;
}

/**
 * release-notes.json: for each changelog, its entries in full, newest first, and its current version: for the console
 * the one this deployment is (cloud/VERSION), for the others the newest that has a release tag.
 *
 *   { "console": { "version" }, "builtAt",
 *     "products": { "<name>": { "current": "<version>" | null,
 *                               "entries": [{ "version", "summary", "more": [{ "p" } | { "list" } | { "h" }],
 *                                             "date"?, "tag"?, "commit"?, "boards"?, "flash"?, "ram"? }] } } }
 */
export function buildReleaseNotes({ repo = REPO, tags = readTags(repo), now = new Date() } = {}) {
  const version = readConsoleVersion(repo);
  const products = {};
  for (const [name, path] of Object.entries(RELEASE_CHANGELOGS)) {
    const entries = parseEntries(readFileSync(join(repo, path), 'utf8')).map((raw) => noteOf(raw, name, tags));
    const current = name === 'console' ? version : (entries.find((entry) => entry.tag)?.version ?? null);
    products[name] = { current, entries };
  }
  return { console: { version }, builtAt: now.toISOString(), products };
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
  const notesOut = options(args, '--notes')[0] ?? (outs.length > 0 ? null : NOTES_OUTPUT);
  const all = notesOut ? [...targets, notesOut] : targets;
  for (const out of all) rmSync(out, { force: true });
  try {
    const repo = options(args, '--repo')[0] ?? REPO;
    const versions = buildVersions({
      repo,
      commit: options(args, '--commit')[0] ?? null,
      tree: options(args, '--tree')[0] ?? 'unknown',
    });
    const notes = notesOut ? buildReleaseNotes({ repo }) : null;
    for (const out of targets) writeVersions(versions, out);
    if (notes) writeVersions(notes, notesOut);
    const counts = Object.entries(versions.changelogs)
      .map(([name, entries]) => `${entries.length} ${name}`)
      .join(', ');
    console.log(`Console ${versions.console.version}; changelog entries: ${counts}. Wrote ${all.join(' and ')}`);
  } catch (error) {
    for (const out of all) rmSync(out, { force: true });
    console.error(`The versions could not be written: ${error.message}`);
    process.exitCode = 1;
  }
}

// Node gives this module's real path, and the command line whatever path it was called by.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main(process.argv.slice(2));
