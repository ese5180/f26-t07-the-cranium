#!/usr/bin/env node
/**
 * The version a platform's build has: `extraMetadata.version` in electron-builder.<platform>.yml
 * (docs/versions.md). The release job checks it against the tag.
 *
 *   node scripts/version-of.mjs <windows|linux>
 *
 * The file is read for that one key only, as electron-builder.<platform>.yml writes it:
 *
 *   extraMetadata:
 *     version: 0.1.0
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = /^extraMetadata:\n(?:[ \t]+.*\n)*?[ \t]+version:[ \t]*['"]?(\d+\.\d+\.\d+)['"]?[ \t]*$/m;

/** extraMetadata.version of an electron-builder file's text, or null. */
export function versionIn(text) {
  return VERSION.exec(String(text))?.[1] ?? null;
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === here) {
  const platform = process.argv[2];
  if (!['windows', 'linux'].includes(platform)) {
    console.error('usage: version-of.mjs <windows|linux>');
    process.exit(2);
  }
  let text;
  try {
    text = readFileSync(join(dirname(here), '..', `electron-builder.${platform}.yml`), 'utf8');
  } catch {
    console.error(`There is no electron-builder.${platform}.yml: that platform's packaging is not in this checkout.`);
    process.exit(1);
  }
  const version = versionIn(text);
  if (!version) {
    console.error(`electron-builder.${platform}.yml has no extraMetadata.version like 0.1.0.`);
    process.exit(1);
  }
  console.log(version);
}
