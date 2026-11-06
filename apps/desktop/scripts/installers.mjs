#!/usr/bin/env node
/**
 * The installers a release of one platform publishes, by name, as apps/write-dist-index.py knows them:
 * the files of `dist/` that are such an installer of that version, one a line. The release job
 * (.github/workflows/release-apps.yml) publishes exactly these, and fails when there are none.
 *
 *   node scripts/installers.mjs <windows|linux> <version> [folder]
 *
 * No dependencies.
 */

import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INSTALLERS = Object.freeze({
  windows: Object.freeze((v) => [`Cranium-Setup-${v}.exe`, `Cranium-Setup-${v}-arm64.exe`, `Cranium-${v}-portable.exe`]),
  linux: Object.freeze((v) => [
    `Cranium-${v}.AppImage`,
    `Cranium-${v}-arm64.AppImage`,
    `cranium_${v}_amd64.deb`,
    `cranium_${v}_arm64.deb`,
    `cranium-${v}.x86_64.rpm`,
    `cranium-${v}.aarch64.rpm`,
  ]),
});

export function installersIn(names, platform, version) {
  const wanted = INSTALLERS[platform]?.(version) ?? [];
  return wanted.filter((name) => names.includes(name));
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === here) {
  const [platform, version, folder = join(dirname(here), '..', 'dist')] = process.argv.slice(2);
  if (!Object.hasOwn(INSTALLERS, platform) || !/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    console.error('usage: installers.mjs <windows|linux> <version> [folder]');
    process.exit(2);
  }
  const found = installersIn(readdirSync(folder), platform, version);
  if (found.length === 0) {
    console.error(`No ${platform} installer of ${version} in ${folder}.`);
    process.exit(1);
  }
  console.log(found.join('\n'));
}
