#!/usr/bin/env node
/**
 * For the release job: check apps/config/cranium.json as the app reads it, and print a GitHub Actions mask
 * for each of its values that names the stack, before anything else could print them.
 *
 *   node scripts/mask-config.mjs ../config/cranium.json
 */

import { readFileSync } from 'node:fs';

import { readConfig } from '../src/lib/config.mjs';

let config;
try {
  const text = readFileSync(process.argv[2], 'utf8');
  for (const value of Object.values(JSON.parse(text))) {
    if (typeof value !== 'string' || value === '' || /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/.test(value)) continue;
    console.log(`::add-mask::${value}`);
    if (value.includes('://')) console.log(`::add-mask::${value.split('://')[1].replace(/\/+$/, '')}`);
  }
  config = readConfig(text);
} catch (error) {
  console.log(`::error::CRANIUM_CONFIG_JSON is not apps/config/cranium.json as apps/configure.sh writes it (${error.name}).`);
  process.exit(1);
}
if (!config.customer) console.log('::warning::This configuration has no customer pool: the app will sign admins in only.');
