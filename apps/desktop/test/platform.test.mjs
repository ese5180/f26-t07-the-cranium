// The platform modules: the default has every hook, and a system's own module (win32.mjs, linux.mjs)
// gives only hooks the default has, so main.mjs can take it over the default.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';

import * as base from '../src/platform/default.mjs';

const HOOKS = ['afterReady', 'beforeReady', 'menuTemplate', 'quitWhenAllClosed', 'windowOptions'];

test('the default has every hook, and its menu opens the settings and reloads the pages', () => {
  assert.deepEqual(Object.keys(base).sort(), HOOKS);
  const clicked = [];
  const menu = base.menuTemplate({
    name: 'Cranium',
    isPackaged: true,
    settings: () => clicked.push('settings'),
    reloadPages: () => clicked.push('reload'),
    about: () => clicked.push('about'),
  });
  const file = menu.find((item) => item.label === 'File').submenu;
  file.find((item) => item.label === 'Settings…').click();
  file.find((item) => item.label === 'Reload the pages').click();
  assert.deepEqual(clicked, ['settings', 'reload']);
  // No developer tools in a packaged build.
  assert.equal(JSON.stringify(menu).includes('toggleDevTools'), false);
  assert.equal(JSON.stringify(base.menuTemplate({ name: 'C', isPackaged: false, settings() {}, reloadPages() {}, about() {} })).includes('toggleDevTools'), true);
});

test("each system's module gives only the default's hooks", async () => {
  const modules = readdirSync(new URL('../src/platform/', import.meta.url)).filter((name) => name !== 'default.mjs');
  for (const name of modules) {
    assert.match(name, /^(win32|linux)\.mjs$/, name);
    const own = await import(new URL(`../src/platform/${name}`, import.meta.url));
    for (const key of Object.keys(own)) assert.ok(HOOKS.includes(key), `${name}: ${key}`);
  }
});
