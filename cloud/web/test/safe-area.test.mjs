/**
 * The pages fill an iPhone's screen edge to edge in the apps (the shell's web view runs under the Dynamic Island,
 * the home indicator and the sides) and keep clear of what is there: they ask for the whole screen with
 * viewport-fit=cover and pad their bars with env(safe-area-inset-*), through the --safe-* properties of app.css.
 * A bar at the foot of the screen ends at least 44px up on a screen with rounded corners, so that its first and
 * last tabs are not in a corner.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const APP = read('../src/site/assets/app.css');
const CUSTOMER = read('../src/customer/assets/customer.css');

/** The declarations of every rule for a selector, in order. */
function rules(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(String.raw`(?:^|[}\n])\s*${escaped}\s*\{([^}]*)\}`, 'g'))].map((m) => m[1]);
}

test('the console and the customer site ask for the whole screen', () => {
  for (const page of ['../src/site/index.html', '../src/customer/index.html']) {
    assert.match(read(page), /<meta name="viewport" content="[^"]*viewport-fit=cover/, page);
  }
});

test('the safe areas have a name each, and the foot bar clears a rounded corner', () => {
  for (const side of ['top', 'right', 'bottom', 'left']) {
    assert.match(APP, new RegExp(String.raw`--safe-${side}: env\(safe-area-inset-${side}, 0px\);`));
  }
  // 0 with no inset (a browser), the inset when it is 44px or more, and 44px when it is less.
  assert.match(
    APP,
    /--safe-bottom-bar: max\(var\(--safe-bottom\), min\(calc\(var\(--safe-bottom\) \* 100\), 44px\)\);/
  );
});

test('the bars are clear of the island, the home indicator and the sides', () => {
  // The console: its tab bar on a phone, and its sidebar beside the island in landscape.
  assert.ok(
    rules(APP, '.nav').some((body) =>
      /padding: 0 var\(--safe-right-bar\) var\(--safe-bottom-bar\) var\(--safe-left-bar\)/.test(body)
    )
  );
  assert.match(APP, /body\.is-framed \{\s*padding-left: calc\(var\(--sidebar\) \+ var\(--safe-left\)\);/);
  assert.ok(rules(APP, '.main').some((body) => /max\(var\(--gutter\), var\(--safe-left\)\)/.test(body)));
  assert.match(rules(APP, '.gate-copy')[0], /var\(--safe-top\)/);
  assert.match(rules(APP, '.ui-dialog')[0], /--dialog-top: max\(16px, 9vh, calc\(var\(--safe-top\) \+ 12px\)\)/);
  // The customer site: its top bar under the island, its tab bar, its sidebar and the landing page's bar.
  assert.ok(rules(CUSTOMER, '.cs-top').some((body) => /padding: calc\(10px \+ var\(--safe-top\)\)/.test(body)));
  assert.ok(rules(CUSTOMER, '.cs-tabbar').some((body) => /var\(--safe-bottom-bar\)/.test(body)));
  assert.ok(rules(CUSTOMER, '.cs-body').some((body) => /calc\(68px \+ var\(--safe-bottom-bar\)\)/.test(body)));
  assert.match(rules(CUSTOMER, '.cs-side')[0], /calc\(18px \+ var\(--safe-left\)\)/);
  assert.match(rules(CUSTOMER, '.cs-landing-top')[0], /calc\(14px \+ var\(--safe-top\)\)/);
  // The customer site pads with the names alone.
  assert.doesNotMatch(CUSTOMER, /env\(safe-area-inset/);
});

test("the customer site's top bar fits a 402px iPhone: Connect device is its icon up to 460px", () => {
  // At 402 px the brand, the two icons and "Connect device" in words were 15 px wider than the screen: up to 460 px
  // (the breakpoint set of tokens v2) the button is its icon, and the brand keeps its word.
  const block = CUSTOMER.slice(CUSTOMER.indexOf('@media (max-width: 460px)'));
  assert.match(block, /^@media \(max-width: 460px\) \{\s*\.btn\.cs-connect \{/);
  assert.doesNotMatch(CUSTOMER, /\.cs-top-brand \.cs-brand-text \{[^}]*clip-path/);
});

test("the bars at the foot of the screen keep their ends out of the display's rounded corners", () => {
  // 0 in a browser (no inset anywhere), 20px on a screen with an inset at the foot or the sides: one with
  // rounded corners, about 55pt on an iPhone 17 Pro.
  assert.match(
    APP,
    /--safe-corner: min\(calc\(\(var\(--safe-bottom\) \+ var\(--safe-left\) \+ var\(--safe-right\)\) \* 100\), 20px\);/
  );
  assert.match(APP, /--safe-left-bar: max\(var\(--safe-left\), var\(--safe-corner\)\);/);
  assert.match(APP, /--safe-right-bar: max\(var\(--safe-right\), var\(--safe-corner\)\);/);
  // The console's tab bar and the customer site's: the first and last tabs clear the curve.
  const bar = /padding: 0 var\(--safe-right-bar\) var\(--safe-bottom-bar\) var\(--safe-left-bar\)/;
  assert.ok(rules(APP, '.nav').some((body) => bar.test(body)));
  assert.ok(rules(CUSTOMER, '.cs-tabbar').some((body) => bar.test(body)));
  // A dialog on a phone is a sheet to the foot of the screen: its foot's buttons are above the home indicator
  // and in from the corners.
  const sheet = APP.slice(APP.indexOf('@media (max-width: 700px) {\n  .console .dialog,'));
  assert.match(sheet, /^[^}]*padding: 0 var\(--safe-corner\) var\(--safe-bottom-bar\);/);
});
