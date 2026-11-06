#!/usr/bin/env node
/**
 * Make apps/desktop/build/, what the app is built with and what `npm start` runs with:
 *
 *   build/bundle/            the pages built into the app (cloud/web/build-bundle.mjs), for a first start
 *                            and as the last resort, as the phone apps carry them
 *   build/shared/bridge.json the bridge's contract (apps/shared/bridge.json)
 *   build/cranium.json       the configuration: apps/config/cranium.json (apps/configure.sh writes it from
 *                            the deployed stack), or else the example one, which signs nobody in
 *   build/cranium.source     "configured" or "example"
 *
 *   node scripts/prepare.mjs [--example]
 *
 * No dependencies.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const apps = join(desktop, '..');
const repo = join(apps, '..');
const build = join(desktop, 'build');

const configured = join(apps, 'config', 'cranium.json');
const example = join(apps, 'config', 'cranium.example.json');
const useExample = process.argv.includes('--example') || !existsSync(configured);

rmSync(build, { recursive: true, force: true });
mkdirSync(join(build, 'shared'), { recursive: true });
execFileSync(process.execPath, [join(repo, 'cloud', 'web', 'build-bundle.mjs'), '--out', join(build, 'bundle')], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
copyFileSync(join(apps, 'shared', 'bridge.json'), join(build, 'shared', 'bridge.json'));
copyFileSync(useExample ? example : configured, join(build, 'cranium.json'));
writeFileSync(join(build, 'cranium.source'), useExample ? 'example\n' : 'configured\n');
console.log(
  `apps/desktop/build: the bundle, the contract, and the ${useExample ? 'example' : "stack's"} configuration` +
    (useExample ? ' (apps/configure.sh writes the real one)' : '')
);
