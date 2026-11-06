// main.mjs needs Electron to run, so these read it: the app names itself Cranium before Electron is ready
// (a checkout runs Electron's own binary, which says "Electron" otherwise), and a smoke run never puts a
// window in front of anybody.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const main = readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const base = readFileSync(new URL('../electron-builder.base.yml', import.meta.url), 'utf8');

test('the app is Cranium everywhere it is named, from before Electron is ready', () => {
  assert.equal(pkg.productName, 'Cranium');
  assert.match(base, /^productName: Cranium$/m);
  const ready = main.indexOf('app.whenReady()');
  assert.ok(ready > 0);
  assert.ok(main.indexOf("const APP_NAME = 'Cranium';") > 0);
  for (const call of ['app.setName(APP_NAME)', 'app.setAboutPanelOptions({ applicationName: APP_NAME', 'protocol.registerSchemesAsPrivileged(']) {
    const at = main.indexOf(call);
    assert.ok(at > 0 && at < ready, `${call} before app.whenReady()`);
  }
  assert.match(main, /title: 'Cranium',/);
});

test('a smoke run draws offscreen, never shows its window, hides from the dock, and gives up in time', () => {
  assert.match(main, /const SMOKE = app\.isPackaged \? null : process\.env\.CRANIUM_DESKTOP_SMOKE \|\| null;/);
  assert.match(main, /offscreen: SMOKE !== null,/);
  assert.match(main, /if \(!SMOKE\) window\.show\(\);/);
  assert.match(main, /app\.dock\?\.hide\(\);/);
  assert.match(main, /app\.exit\(1\);\n {2}\}, SMOKE_LIMIT_MS\)\.unref\(\);/);
  // The window is made hidden, and only ready-to-show shows it.
  assert.match(main, /show: false,/);
  assert.equal((main.match(/window\.show\(\)/g) ?? []).length, 1);
});
