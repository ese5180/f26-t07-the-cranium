/**
 * Tests for the Database page (docs/database.md, db-page.js): its addresses, the client's one way to ask
 * for it, what the page reads of the server's answers, and what it draws: a viewer is told no, a release
 * manager sees the tables with their rough sizes, a page of items with a hidden field set apart, an item's
 * fields, Load more, and an export that goes to the app's share bridge where there is one.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE, DB, VIEWS, all, click, createDocument, one, textOf } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
const db = await import(DB);
globalThis.document = createDocument();

const NOW = Date.parse('2026-11-09T18:00:00Z');
const A = 'cranium-00000000000000aa';

function draw(node) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  views.render(root, node);
  return root;
}

const TABLES = {
  approximate: true,
  exportLimit: 10000,
  tables: [
    {
      name: 'state',
      label: 'State',
      about: 'Releases and tokens.',
      items: 42,
      bytes: 9000,
      kinds: [{ id: 'TOK', label: 'API tokens' }],
    },
    { name: 'audit', label: 'Audit', about: 'The activity log.', items: 1200, bytes: 2_500_000, kinds: [] },
    { name: 'events', label: 'Events', about: 'What the boards did.', items: null, bytes: null, kinds: [] },
    { name: '<script>', label: 'x', items: 1, bytes: 1, kinds: [] },
  ],
};

const PAGE = {
  table: 'state',
  reading: 'scan',
  partition: null,
  rows: [
    {
      key: { pk: 'GRP', sk: 'grp-lab' },
      item: { pk: 'GRP', sk: 'grp-lab', name: 'Lab', wifi: { passphrase: 'hidden' } },
    },
    { key: null, item: { pk: 'TOK', sk: 'hidden', name: 'ci', id: '0123456789abcdef' } },
  ],
  read: 50,
  cursor: 'eyJwayI6IkdSUCIsInNrIjoiZ3JwLWxhYiJ9',
  stopped: false,
};

/** The page connected to a stand-in API that answers from `answers` by path, and records what it asked. */
function harness({ canWrite = true, share = null, inApp = false, route = { view: 'database' } } = {}) {
  const asked = [];
  const shared = [];
  const state = { now: NOW, route, me: { canWrite }, interval: 0 };
  const api = {
    async dbRequest(path, options = {}) {
      asked.push([path, options.once === true]);
      if (path === '/api/db/tables') return TABLES;
      if (path.includes('/export')) {
        return {
          name: 'cranium-state-20261109T180000Z.csv',
          type: 'text/csv',
          content: 'pk,sk\r\nGRP,é\r\n',
          count: 1,
          capped: null,
        };
      }
      if (path.includes('/item')) return { table: 'state', key: { pk: 'GRP', sk: 'grp-lab' }, item: PAGE.rows[0].item };
      return path.includes('cursor=') ? { ...PAGE, rows: [], cursor: null } : PAGE;
    },
  };
  const load = async (resource, read) => {
    try {
      resource.value = await read();
      resource.error = null;
      resource.loadedAt = NOW;
    } catch (error) {
      resource.error = error;
    }
  };
  let draws = 0;
  db.connect({
    state,
    api,
    load,
    draw: () => {
      draws += 1;
    },
    inApp,
    share: share ? async (file) => shared.push(file) : null,
  });
  const ctx = { state, actions: { refresh: () => {} } };
  return { asked, shared, state, ctx, draws: () => draws };
}

test('the Database page and each table have an address, and nothing else does', () => {
  assert.deepEqual(core.parseRoute('#/database'), { view: 'database' });
  assert.deepEqual(core.parseRoute('#/database/audit'), { view: 'database', table: 'audit' });
  for (const hash of ['#/database/users', '#/database/State', '#/database/a-b'])
    assert.equal(core.parseRoute(hash), null, hash);
  assert.equal(core.routeHash({ view: 'database', table: 'events' }), '#/database/events');
  assert.equal(core.routeHash({ view: 'database', table: '../x' }), '#/database');
});

test('the client asks only for the Database routes, with GET, and an export only once', async () => {
  const asked = [];
  const api = core.createApi({
    auth: { accessToken: () => 'TOKEN' },
    crypto: globalThis.crypto,
    clock: core.createClock(),
    onUnauthorized: () => {},
    pause: async () => {},
    fetch: async (url, init) => {
      asked.push([init?.method ?? 'GET', String(url)]);
      return asked.length === 1 ? new Response('{}', { status: 503 }) : Response.json({ tables: [] });
    },
  });
  await assert.rejects(
    api.dbRequest('/api/db/state/export?format=csv', { once: true }),
    (error) => error.status === 503
  );
  await api.dbRequest(db.pathOf('audit', '', { text: "a b'(c)", from: '2026-11-09T10:00:00.000Z' }));
  assert.deepEqual(asked, [
    ['GET', '/api/db/state/export?format=csv'],
    ['GET', "/api/db/audit?text=a%20b'(c)&from=2026-11-09T10%3A00%3A00.000Z"],
  ]);
  for (const path of [
    '/api/db/users',
    '/api/db/state/item/x',
    '/api/tokens',
    '/api/db/state?x=<b>',
    'https://example.com/api/db/tables',
  ]) {
    await assert.rejects(api.dbRequest(path), /not a request of the Database page/, path);
  }
});

test('what the server says is checked before it is drawn', () => {
  const tables = db.readTables(TABLES);
  assert.deepEqual(
    tables.tables.map((table) => [table.name, table.items, table.bytes]),
    [
      ['state', 42, 9000],
      ['audit', 1200, 2_500_000],
      ['events', null, null],
    ]
  );
  const page = db.readPage({ ...PAGE, cursor: 'not a cursor!', rows: [...PAGE.rows, { key: { pk: 1 }, item: 'x' }] });
  assert.equal(page.cursor, null);
  assert.deepEqual(page.rows[2], { key: null, item: {} });
  assert.throws(() => db.readPage({ rows: 'x' }), /could not read/);
  assert.throws(() => db.readExport({ name: '../../etc/passwd', content: 'x' }), /could not read/);
  assert.equal(db.bytesWords(2_500_000), '2.4 MB');
  assert.equal(db.bytesWords(null), 'size not known');
});

test('the filters are checked on the page, in UTC, before anything is asked', () => {
  const empty = { kind: '', partition: '', board: '', from: '', to: '', text: '' };
  assert.deepEqual(db.filtersOf(empty), { query: {}, problem: null });
  assert.match(db.filtersOf({ ...empty, board: 'board-1' }).problem, /cranium-0123456789abcdef/);
  assert.match(db.filtersOf({ ...empty, from: '2026-11-09T12:00', to: '2026-11-09T11:00' }).problem, /before/);
  assert.match(db.filtersOf({ ...empty, text: 'x'.repeat(101) }).problem, /100/);
  const { query } = db.filtersOf({ ...empty, kind: 'TOK', board: ` ${A} `, from: '2026-11-09T12:00', text: ' lab ' });
  assert.deepEqual(Object.keys(query), ['kind', 'board', 'from', 'text']);
  assert.equal(query.board, A);
  assert.match(query.from, /^2026-11-09T\d{2}:00:00\.000Z$/);
  assert.equal(query.text, 'lab');
});

test('a viewer is told the page is for release managers, and nothing is asked', async () => {
  const h = harness({ canWrite: false });
  await db.refreshDatabase(true);
  assert.deepEqual(h.asked, []);
  const root = draw(db.databaseView(h.ctx));
  assert.match(textOf(root), /Only release managers can browse the database/);
  assert.equal(all(root, 'form').length, 0);
});

test('a release manager sees the tables with rough sizes, a page of items, hidden fields set apart, and Load more', async () => {
  const h = harness();
  await db.refreshDatabase(true);
  assert.deepEqual(
    h.asked.map(([path]) => path),
    ['/api/db/tables', '/api/db/state?limit=50']
  );
  const root = draw(db.databaseView(h.ctx));
  const text = textOf(root);
  assert.match(text, /about 42 items 8\.8 KB/);
  assert.match(text, /about 1,200 items 2\.4 MB/);
  assert.match(text, /\? items size not known/);
  assert.match(text, /rough/);
  assert.match(text, /A Scan of one page of the table\. 2 items shown of 50 read\./);
  // A row with a key opens from its title, with a chevron; one whose key is secret shows its fields in place, with no link to it.
  const rows = all(root, 'li.db-row');
  assert.equal(rows.length, 2);
  assert.equal(all(rows[0], 'button').length, 1);
  assert.equal(all(rows[1], 'button').length, 0);
  assert.equal(all(rows[1], 'details').length, 1);
  assert.match(textOf(rows[1]), /TOK hidden/);
  assert.equal(
    all(root, 'a.cover-link')
      .find((link) => textOf(link).startsWith('Audit'))
      .getAttribute('href'),
    '#/database/audit'
  );

  click(one(root, 'button', 'Load more'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.asked.at(-1)[0], /^\/api\/db\/state\?limit=50&cursor=/);
});

test('an item opens with all its fields, a hidden one marked so, and Back returns to the list', async () => {
  const h = harness();
  await db.refreshDatabase(true);
  let root = draw(db.databaseView(h.ctx));
  click(one(all(root, 'li.db-row')[0], 'button', 'grp-lab'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.asked.at(-1), ['/api/db/state/item?pk=GRP&sk=grp-lab', false]);
  root = draw(db.databaseView(h.ctx));
  const text = textOf(root);
  assert.match(text, /state table grp-lab/);
  assert.match(text, /passphrase/);
  assert.match(text, /hidden/);
  click(one(root, 'button', 'Back to the list'));
  root = draw(db.databaseView(h.ctx));
  assert.equal(all(root, 'li.db-row').length, 2);
});

test('an export in an app goes to its share bridge, as base64 of the UTF-8 text, asked once', async () => {
  const h = harness({ share: true, inApp: true });
  await db.refreshDatabase(true);
  let root = draw(db.databaseView(h.ctx));
  assert.match(textOf(root), /The app saves or shares the file/);
  click(one(root, 'button', 'CSV'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.asked.at(-1), ['/api/db/state/export?format=csv', true]);
  assert.equal(h.shared.length, 1);
  assert.equal(h.shared[0].name, 'cranium-state-20261109T180000Z.csv');
  assert.equal(h.shared[0].type, 'text/csv');
  assert.equal(Buffer.from(h.shared[0].data, 'base64').toString('utf8'), 'pk,sk\r\nGRP,é\r\n');
  root = draw(db.databaseView(h.ctx));
  assert.match(textOf(root), /cranium-state-20261109T180000Z\.csv: 1 item\./);
});

test('in an app without the share bridge the export buttons are off, and the page says why', async () => {
  const h = harness({ inApp: true });
  await db.refreshDatabase(true);
  const root = draw(db.databaseView(h.ctx));
  assert.match(textOf(root), /This app cannot save a file: export from the website/);
  assert.equal(one(root, 'button', 'CSV').disabled, true);
});

test('the Database page is under Developer, and its words for the activity log and its refusals are there', () => {
  const root = draw(views.developerTabs('database'));
  assert.equal(one(root, 'a', 'Database').getAttribute('href'), '#/database');
  assert.equal(one(root, 'a', 'Database').getAttribute('aria-current'), 'page');
  const said = (outcome, target = 'state') =>
    core.describeAudit({
      action: 'db.export',
      target,
      outcome,
      detail: [
        ['format', 'csv'],
        ['items', '12'],
      ],
    });
  const done = said('ok');
  assert.equal(`${done.verb} ${done.label} ${done.tail}`, 'exported the state table');
  assert.equal(said('denied', '').verb, 'tried to export from the database');
  assert.deepEqual(
    done.facts.map((fact) => [fact.label, fact.value]),
    [
      ['As', 'CSV'],
      ['Items', '12'],
    ]
  );
  for (const code of ['unknown_table', 'invalid_filter', 'invalid_key', 'invalid_format', 'unknown_item']) {
    assert.equal(typeof core.REFUSAL_WORDS[code], 'string', code);
  }
});
