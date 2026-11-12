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
  // The console: its floating tab bar on a phone, a gap in from the sides past the safe areas, and its sidebar
  // beside the island in landscape.
  const bar = rules(APP, '.nav').find((body) => /position: fixed/.test(body));
  assert.match(bar, /right: calc\(var\(--edge-gap\) \+ var\(--safe-right\)\)/);
  assert.match(bar, /left: calc\(var\(--edge-gap\) \+ var\(--safe-left\)\)/);
  assert.match(bar, /bottom: var\(--edge-gap\)/);
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

// The iPhone 17 Pro (#212): designed with its rounded corners, not kept out of them. What floats near a corner is
// concentric with the screen's: a gap in from the edge, its radius the screen's less that gap.
test("the screen's corner is 55px where there is one, and what floats near it is concentric with it", () => {
  assert.match(APP, /--radius-screen: min\(calc\(var\(--safe-bottom\) \* 100\), 55px\);/);
  assert.match(APP, /--radius-tabbar: calc\(var\(--tabbar\) \/ 2\);/);
  assert.match(APP, /--edge-gap: max\(12px, calc\(var\(--radius-screen\) - var\(--radius-tabbar\)\)\);/);
  assert.match(
    APP,
    /--radius-sheet: max\(var\(--radius-card\), calc\(var\(--radius-screen\) - var\(--sheet-gap\)\)\);/
  );
  assert.match(APP, /--radius-inset: max\(var\(--radius-card\), calc\(var\(--radius-sheet\) - var\(--space-4\)\)\);/);
  // The tab bar is a pill; the current tab's pill inside it is its radius less the bar's padding.
  const bar = rules(APP, '.nav').find((body) => /position: fixed/.test(body));
  assert.match(bar, /border-radius: var\(--radius-tabbar\)/);
  assert.match(bar, /padding: 4px/);
  assert.match(APP, /--radius-tab: calc\(var\(--radius-tabbar\) - 4px\);/);
  assert.ok(rules(APP, '.nav-pill').some((body) => /border-radius: var\(--radius-tab\)/.test(body)));
  // Its glass is a layer of its own: a filter on the bar would hold the More sheet inside it to the bar's box.
  assert.ok(!bar.includes('filter'));
  assert.ok(rules(APP, '.nav::before').some((body) => /backdrop-filter/.test(body)));
  // The More sheet and a dialog on a phone: a gap in, the same corners top and bottom.
  assert.ok(
    rules(APP, '.nav-sheet-panel').some((body) => /border-radius: var\(--radius-sheet\);/.test(body)),
    "the sheet has the screen's corners"
  );
  assert.ok(rules(APP, '.nav-sheet-panel').some((body) => /bottom: var\(--sheet-gap\)/.test(body)));
  assert.ok(rules(APP, '.nav-sheet-list').some((body) => /border-radius: var\(--radius-inset\)/.test(body)));
  assert.ok(
    rules(APP, '.console .ui-dialog').some(
      (body) =>
        /border-radius: var\(--radius-sheet\)/.test(body) &&
        /margin: auto var\(--sheet-gap\) var\(--sheet-gap\)/.test(body)
    )
  );
  // The page runs on under the bar: its foot is clear of the bar, not of a blank band.
  assert.ok(
    rules(APP, '.main').some((body) =>
      /padding-bottom: calc\(var\(--tabbar\) \+ var\(--edge-gap\) \+ var\(--space-6\)\)/.test(body)
    )
  );
});

test('tab labels are words at the 13px floor, and the tabs keep a 44px target', () => {
  const phone = APP.slice(APP.indexOf('@media (max-width: 860px)'));
  const link = rules(phone, '.nav-link').find((body) => /flex-direction: column/.test(body));
  assert.match(link, /font-size: var\(--type-small\)/);
  assert.match(APP, /--type-small: 0\.8125rem;/);
  // 62px bar, 4px padding and a 1px border each side: 52px tabs.
  assert.match(phone, /--tabbar: 62px;/);
  assert.match(link, /min-height: calc\(var\(--tabbar\) - 10px\)/);
});
