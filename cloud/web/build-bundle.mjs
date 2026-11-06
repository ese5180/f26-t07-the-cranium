#!/usr/bin/env node
/**
 * Write the phone apps' web bundle (src/bundle.mjs) into a folder: the copy each app carries inside
 * itself, which it serves when it has never fetched one from the console, or when what it fetched does
 * not check out. Both app builds run this (apps/ios/scripts/copy-bundle.sh, apps/android/app/build.gradle.kts).
 *
 *   node cloud/web/build-bundle.mjs --out <folder> [--commit <full id>]
 *
 * The folder then holds manifest.json and files/<sha256>, one file for each distinct file of the
 * bundle, exactly as the web function serves them at /app/manifest.json and /app/files/<sha256>. A
 * folder that is there already is replaced, but only if it is empty or holds a bundle: anything else
 * stops the run, so that a wrong --out cannot remove someone's files.
 *
 * The bundle is made from cloud/web/src as it is on disk, with versions.json and history.json if a
 * deployment wrote them there; without versions.json the manifest takes the console's version from
 * cloud/VERSION, and the commit from --commit or else from git, where that says.
 *
 * No dependencies.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appBundle } from './src/server.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** The manifest with what the bundle itself did not say: the version from cloud/VERSION, and the commit. */
export function describedManifest(manifest, { repo = REPO, commit = null } = {}) {
  const about = { ...manifest.console };
  if (about.version === null) {
    const version = readFileSync(join(repo, 'cloud', 'VERSION'), 'utf8').trim();
    if (VERSION.test(version)) about.version = version;
  }
  if (about.commit === null) {
    let found = commit;
    if (found === null) {
      const git = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', 'HEAD'], { encoding: 'utf8' });
      found = git.status === 0 ? git.stdout.trim() : null;
    }
    if (COMMIT.test(found ?? '')) about.commit = found;
  }
  return { ...manifest, console: about };
}

/** Only an empty folder, or one that holds a bundle and nothing else, may be replaced. */
function replaceable(folder) {
  if (!existsSync(folder)) return true;
  const entries = readdirSync(folder).filter((name) => name !== '.DS_Store');
  return entries.every((name) => name === 'manifest.json' || name === 'files');
}

export function writeBundle(out, { bundle = appBundle, repo = REPO, commit = null } = {}) {
  const folder = resolve(out);
  if (!replaceable(folder)) throw new Error(`${folder} holds other files than a bundle; nothing was written`);
  const work = `${folder}.tmp-${process.pid}`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'files'), { recursive: true });
  for (const [digest, { bytes }] of bundle.objects) {
    writeFileSync(join(work, 'files', digest), bytes);
    chmodSync(join(work, 'files', digest), 0o644);
  }
  const manifest = describedManifest(bundle.manifest, { repo, commit });
  writeFileSync(join(work, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  chmodSync(join(work, 'manifest.json'), 0o644);
  mkdirSync(dirname(folder), { recursive: true });
  rmSync(folder, { recursive: true, force: true });
  renameSync(work, folder);
  return manifest;
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? null) : null;
}

function main(args) {
  const out = option(args, '--out');
  if (!out) {
    console.error('usage: node cloud/web/build-bundle.mjs --out <folder> [--commit <full id>]');
    process.exitCode = 2;
    return;
  }
  try {
    const manifest = writeBundle(out, { commit: option(args, '--commit') });
    const version = manifest.console.version ?? 'unknown';
    console.log(`Web bundle ${manifest.id} (console ${version}, ${manifest.files.length} files) in ${resolve(out)}`);
  } catch (error) {
    console.error(`The web bundle could not be written: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main(process.argv.slice(2));
