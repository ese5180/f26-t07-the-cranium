// The console's pages in this app (apps/shared/pages.json): each one in the bundle, in the sections, in the window,
// with its API calls taken from the app's sign-in. A page the console gains fails here until pages.json has it.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { readContract } from '../src/lib/bridge.mjs';
import { readConfig } from '../src/lib/config.mjs';
import { ORIGIN, contentSecurityPolicy, navigation } from '../src/lib/policy.mjs';

const repo = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, repo), 'utf8');
const pages = JSON.parse(read('apps/shared/pages.json'));
const assets = new URL('cloud/web/src/site/assets/', repo);
const core = read('cloud/web/src/site/assets/core.js');
const views = read('cloud/web/src/site/assets/views.js');
const app = read('cloud/web/src/site/assets/app.js');
const api = read('cloud/api/src/app.mjs');

/** The names in a `const SECTIONS = [ ... ];` of a script, without its comments. */
function block(source) {
  const start = source.indexOf('const SECTIONS = [');
  assert.ok(start >= 0, 'a list of sections');
  return source
    .slice(start, source.indexOf('];', start))
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}
const coreSections = [...block(core).matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
const navSections = [...block(views).matchAll(/\['([a-z]+)', '/g)].map((m) => m[1]);
const sectionOf = (route) => /^#\/([a-z]+)(?:\/([A-Za-z0-9-]+))?$/.exec(route);

test("every section of the console is a page of pages.json, and every page one of the console's", () => {
  assert.ok(coreSections.includes('memfault'));
  const listed = new Set(pages.console.map(({ route }) => sectionOf(route)?.[1]));
  for (const section of coreSections) assert.ok(listed.has(section), `#/${section} in pages.json`);
  for (const { route } of pages.console) {
    const match = sectionOf(route);
    assert.ok(match, route);
    assert.ok(coreSections.includes(match[1]), `${route} in core.js`);
    if (match[2] !== undefined) assert.ok(core.includes(`section === '${match[1]}' &&`), `${route}'s item in core.js`);
  }
});

test('each page is in the sections, and its script is in the bundle and loaded by the console', () => {
  for (const { route, nav, script } of pages.console) {
    if (nav !== null) assert.ok(navSections.includes(nav), `${route} under ${nav} in views.js`);
    if (script === null) continue;
    assert.match(script, /^[a-z0-9][a-z0-9._-]{0,63}\.js$/, `${script} is a path the bundle takes`);
    assert.ok(existsSync(new URL(script, assets)), `${script} in site/assets/`);
    assert.ok(app.includes(`import('./${script}')`), `${script} loaded by app.js`);
  }
});

test("each board card is drawn by its script and called on the board's page", () => {
  for (const { title, script, draw } of pages.cards) {
    const source = readFileSync(new URL(script, assets), 'utf8');
    assert.ok(source.includes(`export function ${draw}(`), `${draw} in ${script}`);
    assert.ok(source.includes(`title: '${title}'`), `${title} in ${script}`);
    assert.ok(views.includes(`.${draw}(`), `${draw} called by views.js`);
  }
});

test("each page's API routes take the apps' sign-in as the website's", () => {
  const routes = [...pages.console, ...pages.cards].flatMap((page) => page.api ?? []);
  assert.ok(routes.includes('GET /api/devices/{thing}/memfault'));
  for (const name of routes) {
    const [method, path] = name.split(' ');
    const escaped = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    // No options: `phone` and `token` keep their defaults, so the apps' client is taken.
    assert.match(api, new RegExp(`route\\('${method}', '${escaped}', [A-Za-z_.]+\\),`), `${name} in app.mjs`);
  }
});

test('the window keeps every page, lets it reach the console, and sends Memfault links to the system', () => {
  const contract = readContract(read('apps/shared/bridge.json'));
  const config = readConfig(
    JSON.stringify({ consoleUrl: 'https://console.example.com', region: 'us-east-1', userPoolId: 'us-east-1_A', mobileClientId: 'c' })
  );
  for (const { route } of pages.console) {
    assert.equal(navigation(`${ORIGIN}/admin${route}`, { mainFrame: true, newWindow: false }), 'allow', route);
  }
  const csp = contentSecurityPolicy(contract.policies, 'console', config);
  assert.match(csp, /connect-src [^;]*https:\/\/console\.example\.com/);
  for (const url of pages.outside) {
    assert.equal(navigation(url, { mainFrame: true, newWindow: true }), 'outside', url);
    assert.equal(navigation(url, { mainFrame: true, newWindow: false }), 'outside', url);
  }
});
