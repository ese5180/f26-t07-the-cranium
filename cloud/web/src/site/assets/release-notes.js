/**
 * The Release notes page: every version of every product, newest first, a tab each. Console, Firmware, iPhone app,
 * Android app, Desktop app (Windows and Linux) and Mac app. Each version shows its number, its date, the first
 * paragraph of its changelog entry and the rest under More, its release tag and commit where it has them, and for
 * the firmware the boards and the flash and RAM the entry names.
 *
 * The data is release-notes.json next to this script, written at deployment by cloud/web/build-versions.mjs from
 * the seven changelogs and the repository's tags. A checkout that was never deployed does not have it.
 *
 * #/release-notes opens the Console tab, #/release-notes/<product> the product's (core.js RELEASE_PRODUCTS). A tab
 * replaces the address rather than adding to the browser's history (app.js showReleaseNotes).
 *
 * No dependencies.
 */

import { RELEASE_PRODUCTS } from './core.js';
import { badge, button, developerTabs, empty, h, loading, mono, notice, pageHead } from './views.js';

// A link that a person follows. Nothing is fetched from there.
const COMMIT_BASE = 'https://github.com/ese5180/f26-t07-the-cranium/commit/';
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TAG = /^[a-z-]{1,24}-v\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const TEXT_MAX = 4000;
const ENTRIES_MAX = 400;
const BLOCKS_MAX = 60;
const ITEMS_MAX = 60;
const BOARDS = Object.freeze(['nRF7002 DK', 'nRF5340 DK']);
const FIGURE = /^[\d,. ]{1,24}(?:KB )?of [\d,. ]{1,24}(?:KB|bytes)$/;

// The tabs: id (in the address), name, and the changelogs of release-notes.json it shows.
export const PRODUCTS = Object.freeze([
  { id: 'console', name: 'Console', logs: ['console'] },
  { id: 'firmware', name: 'Firmware', logs: ['firmware'] },
  { id: 'iphone', name: 'iPhone app', logs: ['ios'] },
  { id: 'android', name: 'Android app', logs: ['android'] },
  { id: 'desktop', name: 'Desktop app', logs: ['windows', 'linux'] },
  { id: 'mac', name: 'Mac app', logs: ['macos'] },
]);
const PLATFORMS = Object.freeze({ windows: 'Windows', linux: 'Linux' });
const LOGS = PRODUCTS.flatMap((product) => product.logs);

const NOT_READABLE = 'The release notes could not be read. Reload the page to try again.';

const text = (value) => (typeof value === 'string' ? value.slice(0, TEXT_MAX) : null);

function blockOf(raw) {
  if (typeof raw?.p === 'string') return { p: text(raw.p) };
  if (typeof raw?.h === 'string') return { h: text(raw.h) };
  if (Array.isArray(raw?.list)) {
    const items = raw.list.slice(0, ITEMS_MAX).map(text).filter(Boolean);
    return items.length > 0 ? { list: items } : null;
  }
  return null;
}

function entryOf(raw) {
  if (!VERSION.test(raw?.version ?? '') || typeof raw.summary !== 'string') return null;
  return {
    version: raw.version,
    summary: text(raw.summary),
    more: Array.isArray(raw.more) ? raw.more.slice(0, BLOCKS_MAX).map(blockOf).filter(Boolean) : [],
    date: DATE.test(raw.date ?? '') ? raw.date : null,
    tag: TAG.test(raw.tag ?? '') ? raw.tag : null,
    commit: COMMIT.test(raw.commit ?? '') ? raw.commit : null,
    boards: Array.isArray(raw.boards) ? BOARDS.filter((board) => raw.boards.includes(board)) : [],
    flash: FIGURE.test(raw.flash ?? '') ? raw.flash : null,
    ram: FIGURE.test(raw.ram ?? '') ? raw.ram : null,
  };
}

/** release-notes.json with only what the page uses, or null if it is not what was written. */
export function parseReleaseNotes(data) {
  if (data === null || typeof data !== 'object' || typeof data.products !== 'object' || data.products === null) {
    return null;
  }
  const logs = {};
  for (const name of LOGS) {
    const raw = data.products[name];
    const entries = Array.isArray(raw?.entries) ? raw.entries.slice(0, ENTRIES_MAX).map(entryOf).filter(Boolean) : [];
    logs[name] = { current: VERSION.test(raw?.current ?? '') ? raw.current : null, entries };
  }
  return { console: VERSION.test(data.console?.version ?? '') ? data.console.version : null, logs };
}

/** Fetch release-notes.json from beside this script. A file that is not there is not a fault of the page. */
export async function readReleaseNotes(fetch, address = new URL('release-notes.json', import.meta.url).href) {
  let response;
  try {
    response = await fetch(address);
  } catch {
    return { failed: 'The release notes could not be fetched. Check the connection and reload the page.' };
  }
  if (response.status === 404) return { missing: true };
  if (!response.ok) return { failed: NOT_READABLE };
  try {
    return parseReleaseNotes(await response.json()) ?? { failed: NOT_READABLE };
  } catch {
    return { failed: NOT_READABLE };
  }
}

/** -1, 0 or 1, as version a is older, the same or newer than b. */
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  for (let at = 0; at < 3; at += 1) if (x[at] !== y[at]) return x[at] < y[at] ? -1 : 1;
  return 0;
}

function dateWords(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** A line of the changelog: `code` as code, the rest as words. */
function inline(line) {
  return line.split('`').map((part, at) => (at % 2 === 1 ? h('code', { key: String(at), class: 'mono' }, part) : part));
}

function blockView(block, at) {
  if (block.h) return h('h4', { key: String(at), class: 'rn-sub' }, inline(block.h));
  if (block.list) {
    return h(
      'ul',
      { key: String(at), class: 'rn-items' },
      block.list.map((item, index) => h('li', { key: String(index) }, inline(item)))
    );
  }
  return h('p', { key: String(at) }, inline(block.p));
}

/**
 * The rows of a tab: one per version, or for the desktop app one per version of each platform, joined where the
 * Windows and Linux entries say the same.
 */
function rowsOf(product, data) {
  const rowsOfLog = (name) => data.logs[name].entries.map((entry) => ({ ...entry, logs: [name], tags: [entry.tag] }));
  if (product.logs.length === 1) return rowsOfLog(product.logs[0]);
  const rows = [];
  const [first, second] = product.logs;
  const others = new Map(data.logs[second].entries.map((entry) => [entry.version, entry]));
  for (const entry of data.logs[first].entries) {
    const other = others.get(entry.version);
    others.delete(entry.version);
    const same = other && other.summary === entry.summary && JSON.stringify(other.more) === JSON.stringify(entry.more);
    if (same) {
      rows.push({ ...entry, date: entry.date ?? other.date, logs: [first, second], tags: [entry.tag, other.tag] });
    } else {
      rows.push({ ...entry, logs: [first], tags: [entry.tag] });
      if (other) rows.push({ ...other, logs: [second], tags: [other.tag] });
    }
  }
  for (const other of others.values()) rows.push({ ...other, logs: [second], tags: [other.tag] });
  return rows.sort((a, b) => compareVersions(b.version, a.version));
}

/** Current, or not released yet: what a version is, by its tags and each changelog's current version. */
function standing(row, product, data, live) {
  const currentOf = (name) => (name === 'console' && live ? live : data.logs[name].current);
  const currentOn = row.logs.filter((name) => currentOf(name) === row.version);
  const marks = [];
  if (currentOn.length > 0) {
    const where =
      product.logs.length > 1 && currentOn.length < product.logs.length
        ? ` on ${currentOn.map((name) => PLATFORMS[name]).join(' and ')}`
        : '';
    const word = product.id === 'console' ? 'This console' : 'Current';
    marks.push(badge('good', 'check-circle', `${word}${where}`));
  } else if (row.tags.every((tag) => !tag)) {
    const newest = row.logs.map(currentOf).filter(Boolean);
    if (newest.length === 0 || newest.some((current) => compareVersions(row.version, current) > 0)) {
      marks.push(badge('idle', 'clock', 'Not released yet'));
    }
  }
  return marks;
}

function commitLink(commit) {
  return h(
    'a',
    {
      class: 'mono',
      href: `${COMMIT_BASE}${commit}`,
      target: '_blank',
      rel: 'noopener noreferrer',
      'aria-label': `Commit ${commit.slice(0, 7)} on GitHub, opens in a new tab`,
    },
    commit.slice(0, 7)
  );
}

function entryRow(row, product, data, live) {
  const tags = row.tags.filter(Boolean);
  const marks = standing(row, product, data, live);
  const unreleased = tags.length === 0 && marks.length > 0;
  const facts = [
    tags.length > 0
      ? h(
          'span',
          { key: 'tag' },
          tags.length > 1 ? 'Tags ' : 'Tag ',
          tags.map((tag, at) => [at > 0 ? ', ' : '', mono(tag)])
        )
      : null,
    tags.length === 0 && !unreleased ? h('span', { key: 'none' }, 'No release tag') : null,
    row.commit ? h('span', { key: 'commit' }, 'Commit ', commitLink(row.commit)) : null,
    row.boards.length > 0
      ? h('span', { key: 'boards' }, `Board${row.boards.length > 1 ? 's' : ''}: ${row.boards.join(', ')}`)
      : null,
    row.flash ? h('span', { key: 'flash' }, `Flash ${row.flash}`) : null,
    row.ram ? h('span', { key: 'ram' }, `RAM ${row.ram}`) : null,
  ].filter(Boolean);
  const label = `${product.name} ${row.version}`;
  return h(
    'li',
    { key: `${row.logs.join('-')}-${row.version}`, class: 'rn-entry' },
    h(
      'div',
      { class: 'rn-entry-head' },
      h('h3', { class: 'rn-version' }, mono(row.version)),
      product.logs.length > 1
        ? h('span', { class: 'tag' }, row.logs.map((name) => PLATFORMS[name]).join(' and '))
        : null,
      row.date ? h('time', { class: 'rn-date', datetime: row.date }, dateWords(row.date)) : null,
      marks
    ),
    h('p', { class: 'rn-summary' }, inline(row.summary)),
    facts.length > 0 ? h('p', { class: 'rn-facts dotted' }, facts) : null,
    row.more.length > 0
      ? h(
          'details',
          { class: 'rn-more' },
          h('summary', { 'aria-label': `More about ${label}` }, 'More'),
          h('div', { class: 'rn-more-body' }, row.more.map(blockView))
        )
      : null
  );
}

function currentLine(product, data, live) {
  const parts = product.logs.map((name) => {
    const current = name === 'console' && live ? live : data.logs[name].current;
    const prefix = product.logs.length > 1 ? `${PLATFORMS[name]}: ` : '';
    if (!current) return `${prefix}no release yet`;
    return [prefix, product.id === 'console' ? 'this console is ' : 'newest release ', mono(current)];
  });
  return parts.flatMap((part, at) => (at > 0 ? ['; ', part] : [part]));
}

function panel(product, data, live) {
  const rows = rowsOf(product, data);
  return h(
    'section',
    {
      key: 'panel',
      class: 'rn-panel',
      id: 'rn-panel',
      role: 'tabpanel',
      'aria-labelledby': `rn-tab-${product.id}`,
      tabindex: '0',
    },
    h(
      'header',
      { class: 'rn-panel-head' },
      h('h2', { class: 'rn-panel-title' }, product.name),
      h(
        'p',
        { class: 'quiet' },
        `${rows.length} version${rows.length === 1 ? '' : 's'}, newest first; `,
        currentLine(product, data, live),
        '.'
      )
    ),
    rows.length > 0
      ? h(
          'ol',
          { class: 'rn-list' },
          rows.map((row) => entryRow(row, product, data, live))
        )
      : h('p', { class: 'quiet' }, 'This changelog has no versions yet.')
  );
}

/**
 * Where the strip of tabs is wider than the screen (a phone), mark the edge beyond which more tabs lie, for the
 * stylesheet's fade: data-more-start, data-more-end.
 */
function markEdges(strip) {
  const left = strip.scrollLeft ?? 0;
  const more = { 'data-more-start': left > 1, 'data-more-end': left + strip.clientWidth < strip.scrollWidth - 1 };
  for (const [name, on] of Object.entries(more)) {
    if (on) strip.setAttribute(name, '');
    else strip.removeAttribute(name);
  }
}

// The strip last brought into view. A tab, and a link straight to one, draw a new strip; a redraw keeps the same
// one, and then where the reader scrolled it stays.
let placedStrip = null;

/**
 * After each paint (app.js): a new strip is scrolled so that the chosen tab is in view, centred when it was not, and
 * its edges are marked. Only the strip moves, never the page.
 */
export function keepTabInView(doc = globalThis.document) {
  const strip = doc?.getElementById?.('rn-tabs');
  if (!strip) return;
  if (strip !== placedStrip) {
    placedStrip = strip;
    const tab = [...strip.children].find((el) => el.getAttribute('aria-selected') === 'true');
    if (tab) {
      const box = strip.getBoundingClientRect();
      const own = tab.getBoundingClientRect();
      if (own.left < box.left || own.right > box.right) {
        strip.scrollLeft += own.left - box.left - (box.width - own.width) / 2;
      }
    }
  }
  markEdges(strip);
}

function choose(ctx, id) {
  ctx.actions.showReleaseNotes(id);
  globalThis.document?.getElementById(`rn-tab-${id}`)?.focus();
}

/** The tabs, as a tablist: the arrow keys, Home and End move between them, and choosing is moving. */
function tabs(ctx, selected) {
  const onKeydown = (event) => {
    const at = PRODUCTS.findIndex((product) => product.id === selected.id);
    const to = {
      ArrowRight: (at + 1) % PRODUCTS.length,
      ArrowLeft: (at - 1 + PRODUCTS.length) % PRODUCTS.length,
      Home: 0,
      End: PRODUCTS.length - 1,
    }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    choose(ctx, PRODUCTS[to].id);
  };
  return h(
    'div',
    {
      key: 'tabs',
      class: 'rn-tabs',
      id: 'rn-tabs',
      role: 'tablist',
      'aria-label': 'Products',
      onScroll: (event) => markEdges(event.currentTarget),
    },
    PRODUCTS.map((product) =>
      h(
        'button',
        {
          key: product.id,
          type: 'button',
          class: 'rn-tab',
          role: 'tab',
          id: `rn-tab-${product.id}`,
          'aria-selected': product.id === selected.id ? 'true' : 'false',
          'aria-controls': 'rn-panel',
          tabindex: product.id === selected.id ? '0' : '-1',
          onClick: () => choose(ctx, product.id),
          onKeydown,
        },
        product.name
      )
    )
  );
}

function body(ctx, selected) {
  const data = ctx.state.releaseNotes?.value;
  if (!data) return loading('the release notes');
  if (data.missing) {
    return h(
      'section',
      { class: 'card', key: 'missing' },
      empty({
        iconName: 'list',
        title: 'There are no release notes in this copy of the console.',
        text: 'They are written when the console is deployed, and this copy never was. To write them by hand:',
        command: 'node cloud/web/build-versions.mjs',
      })
    );
  }
  if (data.failed) {
    return notice('bad', 'alert', data.failed, { action: button('is-small', () => location.reload(), 'Reload') });
  }
  // The console this page came from, as the API says; else the version the file was written with.
  const live = VERSION.test(ctx.state.me?.console?.version ?? '') ? ctx.state.me.console.version : data.console;
  return [tabs(ctx, selected), panel(selected, data, live)];
}

export function releaseNotesView(ctx) {
  const id = RELEASE_PRODUCTS.includes(ctx.state.route?.product) ? ctx.state.route.product : 'console';
  const selected = PRODUCTS.find((product) => product.id === id);
  return h(
    'div',
    { class: 'page release-notes-page', key: 'page' },
    developerTabs('release-notes'),
    pageHead({
      title: 'Release notes',
      lede: 'Every version of the console, the firmware and the apps, newest first.',
      how: {
        title: 'How release notes work',
        text: [
          'Each tab is one product’s changelog, entry by entry. The first paragraph is the summary; More has the rest.',
          'A version is current when it is the console you are using, or the newest with a release tag. ' +
            'A version with no tag that is newer than that has not been released yet.',
          'Dates come from the changelog, or else from the release tag’s commit. Firmware entries name the boards ' +
            'and the flash and RAM they used, where the changelog says.',
        ],
      },
    }),
    body(ctx, selected)
  );
}
