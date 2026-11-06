#!/usr/bin/env node
/**
 * Build the installers of one platform: `npm run dist -- windows` or `-- linux` (the system it runs on,
 * when none is named). Each platform's electron-builder settings are a file of their own,
 * electron-builder.<platform>.yml, over electron-builder.base.yml, added with that platform's packaging;
 * a checkout without the file says so. The Mac has a native app of its own, not this one.
 *
 *   npm run dist -- windows [--example] [more electron-builder arguments]
 *
 * --example builds with the example configuration even where apps/config/cranium.json is there: CI does,
 * as this repository is public and a configured build names the stack.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const words = { win32: 'windows', linux: 'linux' };
const flags = { windows: '--win', linux: '--linux' };
const args = process.argv.slice(2);
const named = args.find((arg) => Object.hasOwn(flags, arg));
const platform = named ?? words[process.platform];
if (!platform) {
  console.error(`No packaging for ${process.platform}: name windows or linux.`);
  process.exit(2);
}
const config = join(desktop, `electron-builder.${platform}.yml`);
if (!existsSync(config)) {
  console.error(`This checkout has no packaging for ${platform}: electron-builder.${platform}.yml comes with it.`);
  process.exit(2);
}
const rest = args.filter((arg) => arg !== named && arg !== '--example');

execFileSync(process.execPath, [join(desktop, 'scripts', 'prepare.mjs'), ...(args.includes('--example') ? ['--example'] : [])], {
  stdio: 'inherit',
});
const builder = join(desktop, 'node_modules', 'electron-builder', 'cli.js');
execFileSync(process.execPath, [builder, '--config', config, flags[platform], '--publish', 'never', ...rest], {
  cwd: desktop,
  stdio: 'inherit',
});
