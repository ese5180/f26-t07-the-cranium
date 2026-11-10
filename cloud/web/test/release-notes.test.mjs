/**
 * The Release notes page (release-notes.js): a tab per product, as a tablist that the keyboard moves through, every
 * version of the product newest first with its summary, More, tag, commit and standing, and its addresses
 * (#/release-notes and #/release-notes/<product>). The data it reads is checked in versions.test.mjs.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE, HISTORY, RELEASE_NOTES, VIEWS, all, click, createDocument, one, textOf } from './page.mjs';

const notes = await import(RELEASE_NOTES);
const views = await import(VIEWS);
const core = await import(CORE);
const history = await import(HISTORY);
globalThis.document = createDocument();

const FILE = {
  console: { version: '2.25.4' },
  builtAt: '2026-11-10T00:00:00.000Z',
  products: {
    console: {
      current: '2.25.4',
      entries: [
        { version: '2.26.0', summary: 'A larger change.', more: [] },
        {
          version: '2.25.4',
          summary: 'Release notes, a tab per product.',
          more: [{ p: 'Under `release-notes.js`.' }, { list: ['One.', 'Two.'] }],
          tag: 'console-v2.25.4',
          commit: 'abcdef012345',
          date: '2026-11-10',
        },
        { version: '2.25.3', summary: 'Shorter ledes.', more: [], tag: 'console-v2.25.3', commit: '1234567' },
        { version: '2.10.0', summary: 'From before the tags.', more: [] },
      ],
    },
    firmware: {
      current: '1.15.0',
      entries: [
        {
          version: '1.18.0',
          summary: 'Sessions.',
          more: [{ p: 'Detail.' }],
          boards: ['nRF7002 DK'],
          flash: '749,176 of 794,474 bytes',
          ram: '404,404 of 405,504 bytes',
        },
        { version: '1.15.0', summary: 'Power status.', more: [], tag: 'firmware-v1.15.0', date: '2026-11-09' },
      ],
    },
    ios: { current: '0.8.16', entries: [{ version: '0.8.16', summary: 'iPhone.', more: [], tag: 'ios-v0.8.16' }] },
    android: { current: null, entries: [] },
    windows: {
      current: '0.1.0',
      entries: [
        { version: '0.1.1', summary: 'Schedules.', more: [] },
        { version: '0.1.0', summary: 'First.', more: [], tag: 'desktop-windows-v0.1.0' },
      ],
    },
    linux: {
      current: '0.1.0',
      entries: [
        { version: '0.1.1', summary: 'Schedules, on Linux.', more: [] },
        { version: '0.1.0', summary: 'First.', more: [], tag: 'desktop-linux-v0.1.0' },
      ],
    },
    macos: {
      current: null,
      entries: [{ version: '0.3.0', summary: 'The serial port.', more: [{ h: 'review fixes' }, { list: ['Fixes.'] }] }],
    },
  },
};

/** The page in a document of its own, with app.js's showReleaseNotes as a stand-in that redraws at once. */
function pageWith(value, { product, live = '2.25.4' } = {}) {
  const box = document.createElement('div');
  document.body.replaceChildren(box);
  const chosen = [];
  const ctx = {
    state: {
      route: product ? { view: 'release-notes', product } : { view: 'release-notes' },
      me: { canWrite: true, console: { version: live, commit: null } },
      releaseNotes: { value, error: null, loading: false },
    },
    actions: {
      redraw: () => views.render(box, notes.releaseNotesView(ctx)),
      showReleaseNotes(id) {
        chosen.push(id);
        ctx.state.route = { view: 'release-notes', product: id };
        ctx.actions.redraw();
      },
    },
  };
  ctx.actions.redraw();
  return { box, chosen };
}

const parsed = () => notes.parseReleaseNotes(FILE);
const selectedTab = (box) => all(box, 'button.rn-tab').find((tab) => tab.getAttribute('aria-selected') === 'true');
const versions = (box) => all(box, 'h3.rn-version').map(textOf);

test('the addresses: #/release-notes, and a tab of it by product; anything else is not a page', () => {
  assert.deepEqual(core.parseRoute('#/release-notes'), { view: 'release-notes' });
  for (const product of ['console', 'firmware', 'iphone', 'android', 'desktop', 'mac']) {
    const route = core.parseRoute(`#/release-notes/${product}`);
    assert.deepEqual(route, { view: 'release-notes', product });
    assert.equal(core.routeHash(route), `#/release-notes/${product}`);
  }
  assert.equal(core.routeHash({ view: 'release-notes' }), '#/release-notes');
  assert.equal(core.parseRoute('#/release-notes/windows'), null);
  assert.equal(core.parseRoute('#/release-notes-x'), null);
  assert.equal(core.parseRoute('#/release--notes'), null);
  assert.deepEqual(
    [...core.RELEASE_PRODUCTS],
    notes.PRODUCTS.map((product) => product.id)
  );
});

test('the tabs are a tablist, one per product, and #/release-notes opens the Console tab', () => {
  const { box } = pageWith(parsed());
  assert.equal(textOf(one(box, 'h1')), 'Release notes');
  const list = one(box, 'div.rn-tabs');
  assert.equal(list.getAttribute('role'), 'tablist');
  assert.equal(list.getAttribute('aria-label'), 'Products');
  const tabs = all(box, 'button.rn-tab');
  assert.deepEqual(tabs.map(textOf), ['Console', 'Firmware', 'iPhone app', 'Android app', 'Desktop app', 'Mac app']);
  for (const tab of tabs) {
    assert.equal(tab.getAttribute('role'), 'tab');
    assert.equal(tab.getAttribute('aria-controls'), 'rn-panel');
  }
  assert.equal(textOf(selectedTab(box)), 'Console');
  // Only the chosen tab is in the page's tab order; the arrow keys reach the others.
  assert.deepEqual(
    tabs.map((tab) => tab.getAttribute('tabindex')),
    ['0', '-1', '-1', '-1', '-1', '-1']
  );
  const panel = one(box, 'section.rn-panel');
  assert.equal(panel.getAttribute('role'), 'tabpanel');
  assert.equal(panel.getAttribute('aria-labelledby'), 'rn-tab-console');
  assert.equal(textOf(one(panel, 'h2')), 'Console');
  // It is under Developer, beside History.
  assert.equal(one(one(box, 'nav.dev-tabs'), 'a', 'Release notes').getAttribute('aria-current'), 'page');
  // The lede is one short sentence; the rest is under How release notes work.
  assert.ok(textOf(one(box, 'p.page-lede')).split(/\s+/).length <= 15);
  assert.equal(textOf(one(one(box, 'details.page-how'), 'summary')), 'How release notes work');
});

test('a deep link opens its tab; a click and the arrow keys, Home and End choose another', () => {
  const { box, chosen } = pageWith(parsed(), { product: 'firmware' });
  assert.equal(textOf(selectedTab(box)), 'Firmware');
  assert.equal(one(box, 'section.rn-panel').getAttribute('aria-labelledby'), 'rn-tab-firmware');

  click(one(box, 'button.rn-tab', 'Mac app'));
  assert.equal(textOf(selectedTab(box)), 'Mac app');
  const key = (name) => {
    const event = selectedTab(box).dispatchEvent({ type: 'keydown', key: name });
    return event.defaultPrevented;
  };
  assert.equal(key('ArrowRight'), true);
  assert.equal(textOf(selectedTab(box)), 'Console', 'from the last it wraps to the first');
  assert.equal(document.activeElement, selectedTab(box), 'and the focus moves with it');
  key('ArrowLeft');
  assert.equal(textOf(selectedTab(box)), 'Mac app');
  key('Home');
  assert.equal(textOf(selectedTab(box)), 'Console');
  key('End');
  assert.equal(textOf(selectedTab(box)), 'Mac app');
  key('ArrowLeft');
  assert.equal(textOf(selectedTab(box)), 'Desktop app');
  assert.equal(key('a'), false, 'other keys are left alone');
  assert.deepEqual(chosen, ['mac', 'console', 'mac', 'console', 'mac', 'desktop']);
});

test('each version shows its number, date, summary, More, tag and commit, and which one is current', () => {
  const { box } = pageWith(parsed());
  assert.deepEqual(versions(box), ['2.26.0', '2.25.4', '2.25.3', '2.10.0']);
  const [newer, current, older, untagged] = all(box, 'li.rn-entry');
  // The console you are using is marked; a newer version with no tag is not released yet.
  assert.match(textOf(current), /This console/);
  assert.match(textOf(newer), /Not released yet/);
  assert.doesNotMatch(textOf(older), /Not released yet|This console/);
  assert.match(textOf(untagged), /No release tag/);
  assert.doesNotMatch(textOf(untagged), /Not released yet/);
  // Date, summary, tag and commit.
  assert.equal(one(current, 'time').getAttribute('datetime'), '2026-11-10');
  assert.equal(textOf(one(current, 'p.rn-summary')), 'Release notes, a tab per product.');
  assert.match(textOf(one(current, 'p.rn-facts')), /Tag console-v2\.25\.4/);
  const link = one(one(current, 'p.rn-facts'), 'a');
  assert.equal(textOf(link), 'abcdef0');
  assert.equal(link.getAttribute('href'), 'https://github.com/ese5180/f26-t07-the-cranium/commit/abcdef012345');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  // The rest of the entry is behind More, with code as code and a list as a list.
  const more = one(current, 'details.rn-more');
  assert.equal(textOf(one(more, 'summary')), 'More');
  assert.equal(one(more, 'summary').getAttribute('aria-label'), 'More about Console 2.25.4');
  assert.equal(textOf(one(more, 'code')), 'release-notes.js');
  assert.deepEqual(all(more, 'li').map(textOf), ['One.', 'Two.']);
  assert.equal(all(newer, 'details').length, 0, 'nothing more, no More');
  assert.match(textOf(one(box, 'header.rn-panel-head')), /4 versions, newest first; this console is 2\.25\.4\./);
  // The live console, as the API says, is the one marked.
  const live = pageWith(parsed(), { live: '2.25.3' }).box;
  assert.match(textOf(all(live, 'li.rn-entry')[2]), /This console/);
  assert.match(textOf(all(live, 'li.rn-entry')[1]), /Not released yet|Tag/);
});

test('firmware shows its boards, flash and RAM; the desktop app joins Windows and Linux where they agree', () => {
  const firmware = pageWith(parsed(), { product: 'firmware' }).box;
  const [newest, released] = all(firmware, 'li.rn-entry');
  assert.match(textOf(newest), /Not released yet/);
  assert.match(textOf(newest), /Board: nRF7002 DK/);
  assert.match(textOf(newest), /Flash 749,176 of 794,474 bytes/);
  assert.match(textOf(newest), /RAM 404,404 of 405,504 bytes/);
  assert.match(textOf(released), /Current/);
  assert.match(textOf(one(firmware, 'header.rn-panel-head')), /newest release 1\.15\.0/);

  const desktop = pageWith(parsed(), { product: 'desktop' }).box;
  const rows = all(desktop, 'li.rn-entry');
  assert.deepEqual(
    rows.map((row) => [textOf(one(row, 'h3')), textOf(one(row, 'span.tag'))]),
    [
      ['0.1.1', 'Windows'],
      ['0.1.1', 'Linux'],
      ['0.1.0', 'Windows and Linux'],
    ]
  );
  assert.match(textOf(rows[2]), /Tags desktop-windows-v0\.1\.0, desktop-linux-v0\.1\.0/);
  assert.match(textOf(rows[2]), /Current/);
  assert.match(textOf(rows[0]), /Not released yet/);
  assert.match(textOf(one(desktop, 'header.rn-panel-head')), /Windows: newest release 0\.1\.0; Linux: newest release/);

  // The Mac app has no release yet; its added headings show under More.
  const mac = pageWith(parsed(), { product: 'mac' }).box;
  assert.match(textOf(one(mac, 'li.rn-entry')), /Not released yet/);
  assert.equal(textOf(one(mac, 'h4.rn-sub')), 'review fixes');
  assert.match(textOf(one(mac, 'header.rn-panel-head')), /no release yet/);
  // A product with no versions says so.
  assert.match(textOf(pageWith(parsed(), { product: 'android' }).box), /no versions yet/);
});

test('without the file the page says so, and a broken one is refused; it is fetched beside the script', async () => {
  const replying = (response) => async () => response;
  assert.deepEqual(await notes.readReleaseNotes(replying(new Response('', { status: 404 }))), { missing: true });
  assert.match(textOf(pageWith({ missing: true }).box), /no release notes in this copy/);
  for (const broken of [new Response('nonsense'), new Response('{"products":5}'), new Response('', { status: 500 })]) {
    const result = await notes.readReleaseNotes(replying(broken));
    assert.match(result.failed, /could not be read/);
    assert.match(textOf(pageWith(result).box), /could not be read/);
  }
  const offline = await notes.readReleaseNotes(async () => {
    throw new TypeError('offline');
  });
  assert.match(offline.failed, /could not be fetched/);
  assert.match(textOf(pageWith(null).box), /Loading the release notes/);

  const asked = [];
  const read = await notes.readReleaseNotes(async (...args) => {
    asked.push(args);
    return Response.json(FILE);
  });
  assert.deepEqual(asked, [['https://console.test/assets/build/release-notes.json']]);
  assert.equal(read.logs.console.entries.length, 4);
});

test('what is not of the form it should be is left out', () => {
  const data = notes.parseReleaseNotes({
    console: { version: '2.x' },
    products: {
      console: {
        current: 'nope',
        entries: [
          { version: '1.0', summary: 'x' },
          { version: '1.0.0', summary: 5 },
          {
            version: '1.0.1',
            summary: 'ok',
            more: [{ p: 'p' }, { script: 'x' }, { list: [5, 'item'] }],
            tag: '"><img>',
            commit: 'xyz',
            date: 'soon',
            boards: ['nRF7002 DK', 'other'],
            flash: '<b>',
          },
        ],
      },
    },
  });
  assert.equal(data.console, null);
  assert.equal(data.logs.console.current, null);
  assert.deepEqual(data.logs.console.entries, [
    {
      version: '1.0.1',
      summary: 'ok',
      more: [{ p: 'p' }, { list: ['item'] }],
      date: null,
      tag: null,
      commit: null,
      boards: ['nRF7002 DK'],
      flash: null,
      ram: null,
    },
  ]);
  assert.deepEqual(data.logs.macos, { current: null, entries: [] });
  assert.equal(notes.compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(notes.compareVersions('0.1.0', '0.1.0'), 0);
});

test("History's What's new leads to the release notes", () => {
  const box = document.createElement('div');
  document.body.replaceChildren(box);
  const ctx = {
    state: {
      now: Date.parse('2026-11-10T12:00:00Z'),
      me: { canWrite: true },
      commits: { value: { missing: true } },
      versions: {
        value: history.parseVersions({
          console: { version: '2.25.4' },
          changelogs: { console: [{ version: '2.25.4', note: 'Release notes.' }] },
        }),
      },
    },
    actions: { redraw() {} },
  };
  views.render(box, history.historyView(ctx));
  const link = one(box, 'a.whats-new-all');
  assert.equal(link.getAttribute('href'), '#/release-notes/console');
  assert.equal(textOf(one(box, 'p.whats-new-note')), 'Release notes.');
});
