// Tests for the search and filters of the long lists (docs/search-filters.md): the filters in the address,
// how each page's are checked, the bar every list shares, each page's filters, and what the client asks the API.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTIONS } from '../../api/src/lib/audit.mjs';
import { CORE, VIEWS, all, createDocument, one, textOf } from './page.mjs';
import { INSTALLING, NEVER, NOW, WAITING, WORLD, device, repliesFor } from './world.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
globalThis.document = createDocument();

const loaded = (value) => ({ value, error: null, loadedAt: NOW - 20000, loading: false });
const THING = 'cranium-0123456789abcdef';

function draw(node) {
  const box = document.createElement('div');
  views.render(box, node);
  return box;
}

/** Actions that note what they were asked: [name, ...args]. */
function recorder() {
  const calls = [];
  const actions = new Proxy(
    {},
    {
      get:
        (_target, name) =>
        (...args) =>
          calls.push([name, ...args.filter((value) => !(value?.type && value.currentTarget))]),
    }
  );
  return { actions, calls };
}

// The address.

test('a page with filters takes them after a ?, and a page without keeps its route as it was', () => {
  assert.deepEqual(core.parseRoute('#/devices?q=lab&status=online'), {
    view: 'devices',
    query: { q: 'lab', status: 'online' },
  });
  assert.deepEqual(core.parseRoute('#/devices'), { view: 'devices' });
  // A board's page or the overview has no filters: the query is let go, the page is still the page.
  assert.deepEqual(core.parseRoute(`#/devices/${THING}?q=x`), { view: 'device', thing: THING });
  assert.deepEqual(core.parseRoute('#/overview?q=x'), { view: 'overview' });
  // Characters an address of the console never has are not one of its pages.
  assert.equal(core.parseRoute('#/devices?q=<script>'), null);
  assert.equal(core.parseRoute(`#/devices?q=${'x'.repeat(900)}`), null);
  // The first of a name counts, and names that are not words are dropped.
  assert.deepEqual(core.parseRoute('#/firmware?status=active&status=revoked&Q=1').query, { status: 'active' });
});

test('each page checks its own filters: what is not one of them is as if absent', () => {
  assert.deepEqual(core.readFilters('devices', { status: 'online', version: '1.14', q: ' lab ', other: 'x' }), {
    q: 'lab',
    status: 'online',
    version: '1.14',
  });
  assert.deepEqual(core.readFilters('devices', { status: 'asleep', version: 'v1;drop' }), {
    q: '',
    status: '',
    version: '',
  });
  assert.deepEqual(
    core.readFilters('activity', { kind: 'people', outcome: 'denied', from: '2026-11-01', to: '2026-02-30' }),
    {
      q: '',
      kind: 'people',
      outcome: 'denied',
      from: '2026-11-01',
      to: '',
    }
  );
  const events = core.readFilters('events', {
    board: THING,
    hide: 'log,console',
    level: 'warn',
    tag: 'WIFI',
    range: '7d',
  });
  assert.deepEqual(events, { q: '', board: THING, level: 'warn', hide: 'console,log', tag: 'WIFI', range: '7d' });
  assert.equal(core.readFilters('events', { hide: 'log,log' }).hide, '');
  assert.equal(core.readFilters('events', { board: 'cranium-XYZ' }).board, '');
  assert.equal(core.readFilters('events', { range: '2y' }).range, '');
  for (const view of ['firmware', 'deployments', 'tokens', 'customers', 'memfault']) {
    assert.equal(core.readFilters(view, { q: 'x' }).q, 'x', view);
  }
});

test('the hash of a filtered page has only what is set, in the page’s order, and reads back the same', () => {
  const route = { view: 'events' };
  const hash = core.filtersHash(route, { hide: 'log,console', board: THING, q: 'wifi up', level: '' });
  assert.equal(hash, `#/events?q=wifi+up&board=${THING}&hide=console,log`);
  const back = core.parseRoute(hash);
  assert.deepEqual(core.readFilters('events', back.query), {
    q: 'wifi up',
    board: THING,
    level: '',
    hide: 'console,log',
    tag: '',
    range: '',
  });
  assert.equal(core.filtersHash({ view: 'devices' }, { q: '', status: '' }), '#/devices');
  assert.equal(core.filtersHash({ view: 'devices' }, { status: 'nonsense' }), '#/devices');
  assert.equal(core.filtersHash({ view: 'events' }, { board: THING }), `#/events?board=${THING}`);
  assert.equal(core.filtersSet({ q: 'x', status: 'online', version: '' }), 1);
  assert.equal(core.filtering({ q: '', status: '' }), false);
});

test('a search of a short list finds every word, in any case, in any field', () => {
  assert.equal(core.matchesSearch(['Lab board', 'cranium-00aa', '1.14.0+2'], 'LAB 1.14'), true);
  assert.equal(core.matchesSearch(['Lab board'], 'lab kitchen'), false);
  assert.equal(core.matchesSearch(['anything', null, 3], '   '), true);
  assert.equal(core.matchesSearch([null, undefined, 42], '42'), true);
  assert.equal(core.cleanSearch(`  a\u0000b  `), 'a b');
  assert.equal(core.cleanSearch('x'.repeat(150)).length, 100);
});

test('every action of the activity log is in exactly one kind of its filter', () => {
  const kinds = core.ACTIVITY_KINDS.map((kind) => core.activityActions(kind.id));
  const listed = kinds.flat();
  assert.deepEqual([...listed].sort(), [...ACTIONS].sort());
  assert.equal(new Set(listed).size, listed.length);
  assert.ok(kinds.every((actions) => actions.length > 0));
  assert.deepEqual(core.activityActions('nonsense'), []);
});

test('the refusals of a bad filter have words, on the website and in the apps', () => {
  for (const code of ['invalid_search', 'invalid_level', 'invalid_actions', 'invalid_outcomes']) {
    assert.equal(typeof core.REFUSAL_WORDS[code], 'string', code);
  }
});

// What the client asks the API.

function client() {
  const asked = [];
  const api = core.createApi({
    auth: { accessToken: () => 'TOKEN' },
    crypto: globalThis.crypto,
    clock: core.createClock(() => NOW),
    onUnauthorized: () => assert.fail('refused'),
    fetch: async (path) => {
      asked.push(path);
      if (path.startsWith('/api/audit')) return Response.json({ entries: [], next: null, read: 12 });
      if (path.startsWith('/api/events/log')) return Response.json({ lines: [], cursor: null });
      return Response.json({ events: [], cursor: null });
    },
  });
  return { api, asked };
}

test('the client sends a search of the activity log as checked query parameters, and reads how many were read', async () => {
  const { api, asked } = client();
  const page = await api.audit({
    limit: 50,
    q: 'ada',
    actions: ['token.create', 'token.revoke'],
    outcomes: ['denied'],
    from: '2026-11-01T00:00:00.000Z',
    to: '2026-11-02T00:00:00.000Z',
  });
  assert.equal(page.read, 12);
  const sent = new URL(asked[0], 'https://x').searchParams;
  assert.deepEqual(Object.fromEntries(sent), {
    limit: '50',
    q: 'ada',
    actions: 'token.create,token.revoke',
    outcomes: 'denied',
    from: '2026-11-01T00:00:00.000Z',
    to: '2026-11-02T00:00:00.000Z',
  });
  // Without a filter, the request is what it was.
  await api.audit({ limit: 50 });
  assert.equal(asked[1], '/api/audit?limit=50');
  await assert.rejects(api.audit({ actions: ['firmware.delete'] }), { code: 'bad_request' });
  await assert.rejects(api.audit({ outcomes: ['maybe'] }), { code: 'bad_request' });
  await assert.rejects(api.audit({ q: ' padded ' }), { code: 'bad_request' });
});

test('the client sends the search and level of the events and the board log', async () => {
  const { api, asked } = client();
  const from = '2026-11-01T00:00:00.000Z';
  const to = '2026-11-02T00:00:00.000Z';
  await api.events({ from, to, q: 'wifi', level: 'warn' });
  await api.boardLog({ from, to, thing: THING, q: 'Download', level: 'info' });
  await api.events({ from, to });
  assert.equal(new URL(asked[0], 'https://x').searchParams.get('q'), 'wifi');
  assert.equal(new URL(asked[0], 'https://x').searchParams.get('level'), 'warn');
  assert.equal(new URL(asked[1], 'https://x').searchParams.get('q'), 'Download');
  assert.equal(new URL(asked[1], 'https://x').searchParams.get('level'), 'info');
  assert.equal(new URL(asked[2], 'https://x').searchParams.has('q'), false);
  await assert.rejects(api.events({ from, to, level: 'loud' }), { code: 'bad_request' });
});

// The bar, and each page's filters.

async function stateOf(filters = {}, changes = {}) {
  const replies = repliesFor(WORLD);
  const api = core.createApi({
    auth: { accessToken: () => 'TOKEN' },
    crypto: globalThis.crypto,
    clock: core.createClock(() => NOW),
    onUnauthorized: () => assert.fail('refused'),
    fetch: async (path) => Response.json(replies.get(path)),
  });
  const audit = await api.audit();
  return {
    gate: null,
    me: await api.me(),
    route: { view: 'overview' },
    now: NOW,
    interval: 0,
    devices: loaded(await api.devices()),
    firmware: loaded(await api.firmware()),
    deployments: loaded(await api.deployments()),
    audit: { ...loaded(audit), loadingMore: false, moreError: null },
    deviceDetails: new Map(),
    deploymentDetails: new Map(),
    upload: { stage: 'idle', over: false },
    filters,
    ...changes,
  };
}

const page = (view, state, actions = recorder().actions) => draw(view({ state, actions }));

test('the bar has a search box, the page’s filters under a Filters button, a count, and Clear only when narrowed', async () => {
  const state = await stateOf();
  const drawn = page(views.devicesView, state);
  const bar = one(drawn, 'section.filter-bar');
  assert.equal(bar.getAttribute('role'), 'search');
  const input = one(bar, 'input.filter-input');
  assert.equal(input.getAttribute('type'), 'search');
  assert.equal(input.getAttribute('maxlength'), '100');
  assert.equal(textOf(one(bar, 'p.filter-count')), '3 shown');
  assert.equal(one(bar, 'button.filter-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(all(bar, 'button.filter-clear').length, 0);
  assert.equal(all(bar, 'select').length, 2);

  const narrowed = page(views.devicesView, await stateOf({ devices: { q: '', status: 'offline', version: '' } }));
  const narrowedBar = one(narrowed, 'section.filter-bar');
  assert.equal(textOf(one(narrowedBar, 'p.filter-count')), '1 of 3 shown');
  assert.equal(textOf(one(narrowedBar, 'button.filter-toggle')), 'Filters1');
  assert.equal(all(narrowedBar, 'button.filter-clear').length, 1);
  assert.equal(all(narrowed, 'article.device').length, 1);
  assert.match(textOf(one(narrowed, 'article.device')), new RegExp(NEVER));
});

test('typing, choosing and Clear go to the actions, with the page they are for', async () => {
  const { actions, calls } = recorder();
  const drawn = page(views.devicesView, await stateOf({ devices: { q: 'x', status: '', version: '' } }), actions);
  const input = one(drawn, 'input.filter-input');
  input.value = 'lab';
  input.dispatchEvent({ type: 'input' });
  const select = all(drawn, 'select')[0];
  select.value = 'online';
  select.dispatchEvent({ type: 'change' });
  one(drawn, 'button.filter-clear').dispatchEvent({ type: 'click' });
  one(drawn, 'button.filter-toggle').dispatchEvent({ type: 'click' });
  assert.deepEqual(calls, [
    ['setFilter', 'devices', 'q', 'lab'],
    ['setFilter', 'devices', 'status', 'online'],
    ['clearFilters', 'devices'],
    ['toggleFilters'],
  ]);
});

test('the Devices page narrows by search, state and version, and says when nothing matches', async () => {
  const byName = page(
    views.devicesView,
    await stateOf({ devices: { q: INSTALLING.slice(-6), status: '', version: '' } })
  );
  assert.equal(all(byName, 'article.device').length, 1);
  const updating = page(views.devicesView, await stateOf({ devices: { q: '', status: 'updating', version: '' } }));
  assert.equal(all(updating, 'article.device').length, 2);
  const version = page(views.devicesView, await stateOf({ devices: { q: '', status: '', version: '1.2.3' } }));
  assert.equal(all(version, 'article.device').length, 2);
  const none = page(views.devicesView, await stateOf({ devices: { q: 'no such board', status: '', version: '' } }));
  assert.equal(all(none, 'article.device').length, 0);
  assert.match(textOf(none), /No boards match\./);
  assert.ok(all(none, 'button').some((button) => textOf(button) === 'Clear the search and filters'));
  assert.equal(views.boardStanding(device(WAITING, { online: false }), { state: {} }), 'offline');
});

test('the Firmware, Deployments and API tokens pages narrow their lists as they are drawn', async () => {
  const revoked = page(views.firmwareView, await stateOf({ firmware: { q: '', status: 'revoked' } }));
  assert.deepEqual(
    all(revoked, 'li.release').map((row) => textOf(row).match(/\d+\.\d+\.\d+\+\d+/)[0]),
    ['2.0.0+0']
  );
  assert.equal(textOf(one(revoked, 'p.filter-count')), '1 of 4 shown');
  const searched = page(views.firmwareView, await stateOf({ firmware: { q: '1.2.3', status: '' } }));
  assert.equal(all(searched, 'li.release').length, 2);

  const ended = page(views.deploymentsView, await stateOf({ deployments: { q: '', status: 'ended' } }));
  const underWay = page(views.deploymentsView, await stateOf({ deployments: { q: '', status: 'underway' } }));
  const every = page(views.deploymentsView, await stateOf());
  assert.equal(
    all(ended, 'li.deployment-row').length + all(underWay, 'li.deployment-row').length,
    all(every, 'li.deployment-row').length
  );
  assert.ok(all(ended, 'li.deployment-row').length >= 1);

  const tokens = {
    value: {
      tokens: [
        {
          id: '0123456789abcdef',
          name: 'ota script',
          createdAt: NOW,
          expiresAt: NOW,
          revokedAt: null,
          status: 'active',
        },
        {
          id: 'fedcba9876543210',
          name: 'old laptop',
          createdAt: NOW,
          expiresAt: NOW,
          revokedAt: NOW,
          status: 'revoked',
        },
      ],
      limit: 10,
      maxDays: 90,
    },
    error: null,
    loadedAt: NOW,
    loading: false,
  };
  const listed = page(views.tokensView, await stateOf({ tokens: { q: 'laptop', status: '' } }, { tokens }));
  assert.equal(all(listed, 'li.token').length, 1);
  assert.match(textOf(one(listed, 'li.token')), /old laptop/);
});

test('the Activity page’s bar has its kinds, outcomes and days, and says how much of the log a search read', async () => {
  const state = await stateOf({ activity: { q: 'ada', kind: 'people', outcome: '', from: '', to: '' } });
  state.audit.value = { ...state.audit.value, filtered: true, read: 40, next: 'more' };
  const drawn = page(views.activityView, state);
  const bar = one(drawn, 'section.filter-bar');
  const labels = all(bar, 'span.inline-field-label').map(textOf);
  assert.deepEqual(labels, ['Kind', 'Outcome', 'From', 'To']);
  assert.equal(all(bar, 'input.filter-day').length, 2);
  assert.match(textOf(one(bar, 'p.filter-count')), /^4 of 40 entries read match, more to look through$/);
  assert.ok(all(bar, 'option').some((option) => textOf(option) === 'Sign-ins, tokens and alerts'));

  // A search that has found nothing yet in what it read offers to look further back.
  state.audit.value = { entries: [], filtered: true, read: 1000, next: 'more' };
  const empty = page(views.activityView, state);
  assert.match(textOf(empty), /No entries match\./);
  assert.match(textOf(empty), /None of the 1000 entries read so far match/);
  assert.ok(all(empty, 'button').some((button) => textOf(button) === 'Look further back'));
});

test('a board’s page leads to its events and log, filtered to it', async () => {
  const state = await stateOf();
  const replies = repliesFor(WORLD);
  const detail = replies.get(`/api/devices/${WAITING}`);
  const api = core.createApi({
    auth: { accessToken: () => 'TOKEN' },
    crypto: globalThis.crypto,
    clock: core.createClock(() => NOW),
    onUnauthorized: () => assert.fail('refused'),
    fetch: async () => Response.json(detail),
  });
  state.deviceDetails.set(WAITING, loaded(await api.device(WAITING)));
  state.route = { view: 'device', thing: WAITING };
  const drawn = page(views.deviceView, state);
  const link = all(drawn, 'a.card-more').find((el) => el.getAttribute('href').startsWith('#/events'));
  assert.equal(link.getAttribute('href'), `#/events?board=${WAITING}`);
});
