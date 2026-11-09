// Tests for the Database page's API (src/handlers/db.mjs, src/lib/db.mjs, src/aws-db.mjs, docs/database.md):
// who may read the tables, that no secret ever leaves, paging and filters that read a page and never a
// table, and the export with its cap and its entry in the activity log. Every value here is made up.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDbAws, expressionsOf } from '../src/aws-db.mjs';
import {
  EXPORT_MAX_ITEMS,
  HIDDEN,
  SECRET_ENDINGS,
  SECRET_NAMES,
  SECRET_PARTS,
  decodeCursor,
  encodeCursor,
  hideSecrets,
  planOf,
  readFilters,
  secretName,
  toCsv,
} from '../src/lib/db.mjs';
import { accessClaims, createTestConsole } from './fake-aws.mjs';

const BOARD = 'cranium-00000000000000aa';
const OTHER = 'cranium-00000000000000bb';

function world() {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  const reads = () => console_.fake.calls.filter((call) => call.method === 'dbRead').map((call) => call.args[0]);
  const exports = () => console_.fake.auditLog().filter((entry) => entry.action === 'db.export');
  return { ...console_, manager, viewer, reads, exports };
}

const get = (w, path, query, as = w.manager) => w.call('GET', path, { as, query });

// Who may read.

test('release managers read the tables, with DescribeTable’s rough counts and sizes said to be rough', async () => {
  const w = world();
  w.fake.describeDb('events', { items: 1234, bytes: 56789 });
  const answer = await get(w, '/api/db/tables');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.approximate, true);
  assert.equal(answer.body.exportLimit, EXPORT_MAX_ITEMS);
  assert.deepEqual(
    answer.body.tables.map((table) => table.name),
    ['state', 'audit', 'events']
  );
  const events = answer.body.tables.find((table) => table.name === 'events');
  assert.deepEqual([events.items, events.bytes], [1234, 56789]);
  assert.ok(events.kinds.some((kind) => kind.id === 'event' && kind.timed && kind.board));
  // DescribeTable only: listing the tables reads no item.
  assert.equal(w.reads().length, 0);
});

test('a viewer, an API token and a customer are refused every route, and nothing is read for them', async () => {
  const w = world();
  for (const path of ['/api/db/tables', '/api/db/state', '/api/db/audit/item', '/api/db/events/export']) {
    const query = path.endsWith('item') ? { pk: 'AUD', sk: 'x' } : path.endsWith('export') ? { format: 'csv' } : {};
    const refused = await get(w, path, query, w.viewer);
    assert.deepEqual([refused.status, refused.body.error.code], [403, 'release_manager_required'], path);
  }
  const made = await w.call('POST', '/api/tokens', { as: w.manager, body: { name: 'bench', days: 30 } });
  for (const path of ['/api/t/db/tables', '/api/t/db/state', '/api/t/db/state/export']) {
    const byToken = await w.call('GET', path, { token: made.body.token, query: { format: 'json' } });
    assert.deepEqual([byToken.status, byToken.body.error.code], [403, 'token_not_allowed'], path);
  }
  // A token of another pool, as a customer's is, is no session of this console at all.
  const customer = await w.call('GET', '/api/db/tables', {
    claims: accessClaims({ sub: w.manager.sub, groups: ['release-managers'], clientId: 'customerclient' }),
  });
  assert.equal(customer.status, 401);
  assert.equal(w.reads().length, 0);
  // The refused exports are on record, as every refused write is.
  assert.deepEqual(
    w.exports().map((entry) => [entry.outcome, entry.detail.code]),
    [
      ['denied', 'release_manager_required'],
      ['denied', 'token_not_allowed'],
    ]
  );
});

test("the apps' sign-in reads the tables as the website's does, and an export from them needs no fresh sign-in", async () => {
  const w = world();
  const app = accessClaims({
    sub: w.manager.sub,
    groups: ['release-managers'],
    clientId: 'localmobile',
    authTime: Math.floor(w.clock.ms / 1000) - 3600,
  });
  assert.equal((await w.call('GET', '/api/db/tables', { claims: app })).status, 200);
  const exported = await w.call('GET', '/api/db/state/export', { claims: app, query: { format: 'json' } });
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
});

// Never a secret.

test('a token’s digest, a SideStore key and every credential-like field read "hidden", even to a release manager', async () => {
  const w = world();
  const made = await w.call('POST', '/api/tokens', { as: w.manager, body: { name: 'ci', days: 30 } });
  assert.equal(made.status, 201);
  const [digest] = [...w.fake.tokens.keys()];
  w.fake.seedDb('state', { pk: 'SRC', sk: `key#${'ab'.repeat(32)}`, id: '0123456789abcdef', ownerSub: w.manager.sub });
  w.fake.seedDb('state', { pk: 'SRC', sk: `owner#${w.manager.sub}`, digest: 'cd'.repeat(32), id: '0123456789abcdef' });
  w.fake.seedDb('state', {
    pk: 'GRP',
    sk: 'grp-lab',
    name: 'Lab',
    things: [BOARD],
    wifi: { ssid: 'Lab', passphrase: 'not-a-real-passphrase', security: 'WPA2_PSK' },
    certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    apiKey: 'fake-api-key',
    note: 'crn_ThisLooksLikeATokenAndIsHidden',
    nested: [{ password: 'x', tokenId: 'abc', passkey: 123456 }],
  });
  const everything = [];
  for (const query of [{}, { kind: 'TOK' }, { kind: 'SRC' }, { kind: 'GRP' }]) {
    const answer = await get(w, '/api/db/state', query);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    everything.push(JSON.stringify(answer.body));
  }
  const exported = await get(w, '/api/db/state/export', { format: 'csv' });
  everything.push(exported.body.content);
  const json = await get(w, '/api/db/state/export', { format: 'json' });
  everything.push(json.body.content);
  const text = everything.join('\n');
  for (const secret of [
    digest,
    'ab'.repeat(32),
    'cd'.repeat(32),
    'not-a-real',
    'BEGIN CERTIFICATE',
    'fake-api-key',
    'crn_',
  ]) {
    assert.equal(text.includes(secret), false, secret);
  }

  const tokens = (await get(w, '/api/db/state', { kind: 'TOK' })).body;
  assert.equal(tokens.reading, 'query');
  const [row] = tokens.rows;
  assert.equal(row.key, null);
  assert.equal(row.item.sk, HIDDEN);
  assert.equal(row.item.name, 'ci');
  const group = (await get(w, '/api/db/state', { kind: 'GRP' })).body.rows.find((one) => one.item.sk === 'grp-lab');
  assert.deepEqual(group.item.wifi, { ssid: 'Lab', passphrase: HIDDEN, security: 'WPA2_PSK' });
  assert.deepEqual(group.item.nested, [{ password: HIDDEN, tokenId: 'abc', passkey: HIDDEN }]);
  assert.deepEqual([group.item.certificatePem, group.item.apiKey, group.item.note], [HIDDEN, HIDDEN, HIDDEN]);
  assert.deepEqual(group.key, { pk: 'GRP', sk: 'grp-lab' });
  // The text filter looks in what is shown, so a hidden value cannot be found by searching for it.
  const searched = await get(w, '/api/db/state', { kind: 'GRP', text: 'not-a-real-passphrase' });
  assert.deepEqual(searched.body.rows, []);
});

test('the denylist: every name it holds is hidden, in any case and spelling, and ordinary names are not', () => {
  for (const name of [...SECRET_NAMES, ...SECRET_PARTS, ...SECRET_ENDINGS]) {
    assert.equal(secretName(name), true, name);
    assert.equal(secretName(name.toUpperCase()), true, name);
  }
  for (const name of [
    'tokenHash',
    'token_digest',
    'api-key',
    'projectKey',
    'privateKey',
    'refresh_token',
    'wifiPassphrase',
    'clientSecret',
    'signingCert',
    'sessionId',
    'ref',
  ]) {
    assert.equal(secretName(name), true, name);
  }
  for (const name of [
    'pk',
    'sk',
    'id',
    'tokenId',
    'keyId',
    'name',
    'thing',
    'things',
    'version',
    'at',
    'sha256',
    'owner',
    'status',
  ]) {
    assert.equal(secretName(name), false, name);
  }
  // An item of a secret key: its sk hidden, the rest as any item's.
  const shown = hideSecrets('state', { pk: 'TOK', sk: 'ef'.repeat(32), name: 'n', ownerSub: 's' });
  assert.deepEqual(shown, { pk: 'TOK', sk: HIDDEN, name: 'n', ownerSub: 's' });
  // The same key in another table is just a key.
  assert.equal(hideSecrets('events', { pk: 'TOK', sk: 'x' }).sk, 'x');
});

// Pages, never a table.

test('a page is one read of `limit` items, and the cursor goes on from where it stopped', async () => {
  const w = world();
  for (let index = 0; index < 7; index += 1)
    w.fake.seedDb('state', { pk: 'GRP', sk: `grp-${index}`, name: `G${index}` });
  const seen = [];
  let cursor;
  for (let page = 0; page < 4; page += 1) {
    const answer = await get(w, '/api/db/state', { kind: 'GRP', limit: '3', ...(cursor ? { cursor } : {}) });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    seen.push(...answer.body.rows.map((row) => row.item.sk));
    cursor = answer.body.cursor;
    if (cursor === null) break;
  }
  assert.deepEqual(seen, ['grp-6', 'grp-5', 'grp-4', 'grp-3', 'grp-2', 'grp-1', 'grp-0']);
  assert.ok(w.reads().every((read) => read.op === 'query' && read.pk === 'GRP' && read.limit === 3));
  assert.equal(w.reads().length, 3);
});

test('with no filter the page is a Scan of 50 items, read once; a filter on the key is a Query of its partition', async () => {
  const w = world();
  for (let index = 0; index < 120; index += 1) {
    w.fake.seedDb('events', {
      pk: BOARD,
      sk: `E#2026-10-10T${String(index % 24).padStart(2, '0')}:00:00.000Z#${index}`,
      kind: 'boot',
    });
  }
  const scan = await get(w, '/api/db/events');
  assert.deepEqual([scan.body.reading, scan.body.rows.length, scan.body.read], ['scan', 50, 50]);
  assert.deepEqual(
    w.reads().map((read) => [read.op, read.limit, read.start]),
    [['scan', 50, null]]
  );
  const query = await get(w, '/api/db/events', {
    board: BOARD,
    kind: 'event',
    from: '2026-10-10T05:00:00Z',
    to: '2026-10-10T06:00:00Z',
  });
  assert.equal(query.body.reading, 'query');
  assert.equal(query.body.partition, BOARD);
  const last = w.reads().at(-1);
  assert.deepEqual(
    [last.op, last.pk, last.sk],
    ['query', BOARD, { between: ['E#2026-10-10T05:00:00.000Z', 'E#2026-10-10T06:00:00.000Z￿'] }]
  );
  assert.ok(query.body.rows.length > 0);
  assert.ok(query.body.rows.every((row) => row.item.sk >= 'E#2026-10-10T05' && row.item.sk < 'E#2026-10-10T06:01'));
});

test('a page never ends on a secret key: it reads on, and the cursor never carries a digest', async () => {
  const w = world();
  for (let index = 0; index < 5; index += 1) {
    w.fake.seedDb('state', { pk: 'TOK', sk: `${String(index).repeat(64)}`, id: `000000000000000${index}`, name: 't' });
  }
  w.fake.seedDb('state', { pk: 'AAA', sk: 'before', name: 'before the tokens' });
  w.fake.seedDb('state', { pk: 'ZZZ', sk: 'after', name: 'after the tokens' });
  // A Scan goes in key order in the stand-in: AAA, TOK, ZZZ.
  const first = await get(w, '/api/db/state', { limit: '1' });
  assert.deepEqual(decodeCursor(first.body.cursor), { pk: 'AAA', sk: 'before' });
  // The next page would end on the first token: it reads on past the five, to the item after them.
  const second = await get(w, '/api/db/state', { limit: '1', cursor: first.body.cursor });
  assert.deepEqual(
    second.body.rows.map((row) => [row.item.pk, row.item.sk, row.key === null]),
    [...Array(5).fill(['TOK', HIDDEN, true]), ['ZZZ', 'after', false]]
  );
  assert.equal(second.body.cursor, null);
  assert.equal(second.body.stopped, false);
  // A cursor made up to point at a token is refused.
  const forged = await get(w, '/api/db/state', { cursor: encodeCursor({ pk: 'TOK', sk: '0'.repeat(64) }) });
  assert.deepEqual([forged.status, forged.body.error.code], [400, 'invalid_cursor']);
});

test('filters: the audit log by time and board, text, and what is refused before anything is read', async () => {
  const w = world();
  w.fake.seedDb('audit', {
    pk: 'AUD',
    sk: '2026-10-01T10:00:00.000Z#a',
    action: 'board.command',
    target: BOARD,
    outcome: 'ok',
  });
  w.fake.seedDb('audit', {
    pk: 'AUD',
    sk: '2026-10-02T10:00:00.000Z#b',
    action: 'board.command',
    target: OTHER,
    outcome: 'ok',
  });
  w.fake.seedDb('audit', {
    pk: 'AUD',
    sk: '2026-10-03T10:00:00.000Z#c',
    action: 'firmware.upload',
    target: '1.0.0+1',
    outcome: 'ok',
  });
  const timed = await get(w, '/api/db/audit', { from: '2026-10-01T12:00:00Z', to: '2026-10-03T00:00:00Z' });
  assert.deepEqual(
    timed.body.rows.map((row) => row.item.sk),
    ['2026-10-02T10:00:00.000Z#b']
  );
  const board = await get(w, '/api/db/audit', { board: BOARD });
  assert.deepEqual(
    board.body.rows.map((row) => row.item.sk),
    ['2026-10-01T10:00:00.000Z#a']
  );
  const text = await get(w, '/api/db/audit', { text: 'FIRMWARE.upload' });
  assert.deepEqual(
    text.body.rows.map((row) => row.item.sk),
    ['2026-10-03T10:00:00.000Z#c']
  );

  const before = w.reads().length;
  for (const [path, query, code] of [
    ['/api/db/nope', {}, 'unknown_table'],
    ['/api/db/state', { kind: 'nope' }, 'invalid_filter'],
    ['/api/db/state', { board: 'not-a-board' }, 'invalid_filter'],
    ['/api/db/state', { from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }, 'invalid_filter'],
    ['/api/db/state', { from: 'yesterday' }, 'invalid_time'],
    ['/api/db/state', { text: 'x'.repeat(101) }, 'invalid_filter'],
    ['/api/db/state', { limit: '101' }, 'invalid_limit'],
    ['/api/db/state', { cursor: 'not a cursor' }, 'invalid_cursor'],
    ['/api/db/state', { partition: '\u0007' }, 'invalid_key'],
    ['/api/db/events', { board: BOARD, from: '2026-10-01T00:00:00Z' }, 'invalid_filter'],
    ['/api/db/state/item', { pk: 'GRP' }, 'invalid_key'],
    ['/api/db/state/export', { format: 'xml' }, 'invalid_format'],
  ]) {
    const answer = await get(w, path, query);
    assert.deepEqual([answer.status, answer.body.error.code], [400, code], `${path} ${JSON.stringify(query)}`);
  }
  assert.equal(w.reads().length, before);
});

test('the plan: a Query wherever a filter names a partition, never a filter on the key of a Query', () => {
  const plan = (table, query) => planOf(table, readFilters(table, query));
  assert.equal(plan('state', {}).op, 'scan');
  assert.deepEqual(plan('state', { kind: 'SEEN', board: BOARD }), {
    op: 'query',
    pk: 'SEEN',
    sk: { equals: BOARD },
    newestFirst: true,
    where: [],
  });
  assert.equal(plan('events', { board: BOARD, kind: 'update' }).pk, `UPD#${BOARD}`);
  assert.deepEqual(plan('events', { kind: 'LOC', board: BOARD }).sk, { equals: BOARD });
  assert.deepEqual(plan('events', { board: BOARD, kind: 'line' }).sk, { begins: 'L#' });
  assert.equal(plan('audit', {}).pk, 'AUD');
  for (const [table, query] of [
    ['state', { kind: 'GRP', board: BOARD, from: '2026-10-01T00:00:00Z' }],
    ['events', { partition: 'ALERTS', board: BOARD }],
    ['audit', { board: BOARD, from: '2026-10-01T00:00:00Z' }],
  ]) {
    const made = plan(table, query);
    assert.equal(made.op, 'query');
    const names = JSON.stringify(made.where);
    assert.equal(/"(?:pk|sk)"/.test(names), false, names);
  }
});

// Items.

test("an item's page has every field of it, secrets hidden; an unknown key is 404", async () => {
  const w = world();
  w.fake.seedDb('events', { pk: BOARD, sk: 'S#2026-10-10T10:00:00.000Z', rssi: -60, heap: { free: 1 }, csr: 'x' });
  const answer = await get(w, '/api/db/events/item', { pk: BOARD, sk: 'S#2026-10-10T10:00:00.000Z' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body.item, {
    pk: BOARD,
    sk: 'S#2026-10-10T10:00:00.000Z',
    rssi: -60,
    heap: { free: 1 },
    csr: HIDDEN,
  });
  assert.deepEqual(answer.body.key, { pk: BOARD, sk: 'S#2026-10-10T10:00:00.000Z' });
  const missing = await get(w, '/api/db/events/item', { pk: BOARD, sk: 'S#nothing' });
  assert.deepEqual([missing.status, missing.body.error.code], [404, 'unknown_item']);
});

// Exports.

test('an export is the filtered items as CSV or JSON, on record with its table, filters and count', async () => {
  const w = world();
  w.fake.seedDb('state', {
    pk: 'GRP',
    sk: 'grp-a',
    name: '=HYPERLINK("x")',
    things: [BOARD],
    note: 'a, "quoted" note',
  });
  w.fake.seedDb('state', { pk: 'GRP', sk: 'grp-b', name: 'B', things: [OTHER] });
  const csv = await get(w, '/api/db/state/export', { format: 'csv', kind: 'GRP', board: BOARD });
  assert.equal(csv.status, 200, JSON.stringify(csv.body));
  assert.equal(csv.body.type, 'text/csv');
  assert.match(csv.body.name, /^cranium-state-\d{8}T\d{6}Z\.csv$/);
  assert.equal(csv.body.count, 1);
  assert.equal(csv.body.capped, null);
  assert.equal(
    csv.body.content,
    'pk,sk,name,note,things\r\nGRP,grp-a,"\'=HYPERLINK(""x"")","a, ""quoted"" note","[""cranium-00000000000000aa""]"\r\n'
  );
  const json = await get(w, '/api/db/state/export', { format: 'json', kind: 'GRP' });
  assert.deepEqual(
    JSON.parse(json.body.content).map((item) => item.sk),
    ['grp-b', 'grp-a']
  );
  assert.deepEqual(
    w.exports().map((entry) => [entry.outcome, entry.target, entry.actor.sub, entry.detail]),
    [
      ['ok', 'state', w.manager.sub, { format: 'csv', filters: `kind=GRP board=${BOARD}`, items: '1' }],
      ['ok', 'state', w.manager.sub, { format: 'json', filters: 'kind=GRP', items: '2' }],
    ]
  );
});

test(`an export stops at ${EXPORT_MAX_ITEMS} items and says so, in its answer and on record`, async () => {
  const w = world();
  for (let index = 0; index < EXPORT_MAX_ITEMS + 25; index += 1) {
    w.fake.seedDb('events', { pk: BOARD, sk: `K#${String(index).padStart(6, '0')}`, at: index });
  }
  const answer = await get(w, '/api/db/events/export', { format: 'json', board: BOARD, kind: 'claim' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body).slice(0, 300));
  assert.deepEqual([answer.body.count, answer.body.capped], [EXPORT_MAX_ITEMS, 'items']);
  assert.equal(JSON.parse(answer.body.content).length, EXPORT_MAX_ITEMS);
  const [entry] = w.exports();
  assert.deepEqual([entry.detail.items, entry.detail.capped], [String(EXPORT_MAX_ITEMS), 'items']);
  // Read a thousand at a time, a Query of the board's partition.
  assert.ok(w.reads().every((read) => read.op === 'query' && read.pk === BOARD && read.limit === 1000));
});

test('a failed read of DynamoDB fails the export, and the failure is on record', async () => {
  const w = world();
  w.fake.failNext('dbRead', { code: 'throttled', awsName: 'ThrottlingException' });
  const answer = await get(w, '/api/db/audit/export', { format: 'csv' });
  assert.deepEqual([answer.status, answer.body.error.code], [429, 'throttled']);
  assert.deepEqual(
    w.exports().map((entry) => [entry.outcome, entry.detail.code]),
    [['error', 'throttled']]
  );
});

test('CSV: a column for every field, in one order, and nothing a spreadsheet would run', () => {
  assert.equal(
    toCsv([
      { sk: '2', pk: 'A', b: 1 },
      { pk: 'A', sk: '1', a: '+1', c: { d: '-x' } },
    ]),
    'pk,sk,a,b,c\r\nA,2,,1,\r\nA,1,\'+1,,"{""d"":""-x""}"\r\n'
  );
});

// The adapter.

test('the adapter: placeholders for every name and value, a Limit, the start key, and plain values back', async () => {
  const sent = [];
  const aws = createDbAws(
    { STATE_TABLE: 'state-t', AUDIT_TABLE: 'audit-t', EVENTS_TABLE: 'events-t' },
    {
      send: async (operation, input) => {
        sent.push([operation, input]);
        if (operation === 'DescribeTable') return { Table: { ItemCount: 12, TableSizeBytes: 3456 } };
        return {
          Items: [
            {
              pk: { S: 'GRP' },
              sk: { S: 'a' },
              n: { N: '2' },
              l: { L: [{ BOOL: true }, { NULL: true }] },
              ss: { SS: ['x'] },
            },
          ],
          LastEvaluatedKey: { pk: { S: 'GRP' }, sk: { S: 'a' } },
          ScannedCount: 3,
        };
      },
    }
  );
  assert.deepEqual(await aws.dbDescribe('events'), { items: 12, bytes: 3456 });
  const out = await aws.dbRead({
    table: 'state',
    op: 'query',
    pk: 'GRP',
    sk: { begins: 'a' },
    where: [{ any: [{ equals: ['thing', "x') OR 1=1"] }, { contains: ['things', 'y'] }] }],
    limit: 25,
    start: { pk: 'GRP', sk: 'z' },
  });
  assert.deepEqual(out, {
    items: [{ pk: 'GRP', sk: 'a', n: 2, l: [true, null], ss: ['x'] }],
    next: { pk: 'GRP', sk: 'a' },
    read: 3,
  });
  const [, [name, input]] = sent;
  assert.equal(name, 'Query');
  assert.equal(input.TableName, 'state-t');
  assert.equal(input.Limit, 25);
  assert.equal(input.ScanIndexForward, false);
  assert.deepEqual(input.ExclusiveStartKey, { pk: { S: 'GRP' }, sk: { S: 'z' } });
  assert.equal(input.KeyConditionExpression, '#n0 = :v0 AND begins_with(#n1, :v1)');
  assert.equal(input.FilterExpression, '(#n2 = :v2 OR contains(#n3, :v3))');
  assert.equal(input.ExpressionAttributeValues[':v2'].S, "x') OR 1=1");
  await aws.dbRead({ table: 'audit', op: 'scan', limit: 5 });
  const scan = sent.at(-1)[1];
  assert.equal(sent.at(-1)[0], 'Scan');
  assert.deepEqual(Object.keys(scan).sort(), ['Limit', 'TableName']);
  assert.throws(() => expressionsOf({ op: 'scan', where: [{ nope: [] }] }), TypeError);
  await assert.rejects(aws.dbDescribe('users'), TypeError);
});

test('the adapter reports throttling as the other adapters do, and the stand-in has its methods', async () => {
  const aws = createDbAws(
    { STATE_TABLE: 's', AUDIT_TABLE: 'a', EVENTS_TABLE: 'e' },
    {
      send: async () => {
        const error = new Error('slow down');
        error.name = 'ProvisionedThroughputExceededException';
        throw error;
      },
    }
  );
  await assert.rejects(aws.dbRead({ table: 'events', op: 'scan', limit: 1 }), (error) => {
    assert.deepEqual([error.name, error.code, error.operation], ['AwsError', 'throttled', 'Scan']);
    return true;
  });
  const { fake } = createTestConsole();
  for (const method of Object.keys(aws)) assert.equal(typeof fake[method], 'function', method);
});
