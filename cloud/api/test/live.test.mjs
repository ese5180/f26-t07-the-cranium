// Tests for live updates (docs/live.md): what the tables' streams mean (src/lib/live.mjs), and the live
// function's routes and fan-out (src/live-app.mjs), with the store, the sockets and Cognito in memory.

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';

import { createLiveHandler } from '../src/live-app.mjs';
import { issuerOf, keysOf } from '../src/lib/jwt.mjs';
import { MAX_CONNECTION_S, PROTOCOL, changesOf, messageFor, tokenFromProtocols } from '../src/lib/live.mjs';

const TABLES = Object.freeze({
  events: 'cranium-ota-EventsTable-1',
  state: 'cranium-ota-StateTable-1',
  audit: 'cranium-ota-AuditTable-1',
});
const A = 'cranium-0123456789abcdef';
const B = 'cranium-fedcba9876543210';
const C = 'cranium-1111222233334444';
const TEAM = issuerOf('us-east-1_Team12345');
const CUSTOMERS = issuerOf('us-east-1_Cust12345');
const POOLS = Object.freeze({
  team: { issuer: TEAM, clients: ['consoleclient', 'mobileclient'] },
  customer: { issuer: CUSTOMERS, clients: ['siteclient', 'customermobile'] },
});
const NOW_MS = Date.parse('2026-11-06T18:00:00.000Z');
const NOW_S = NOW_MS / 1000;
const ALICE = 'aaaaaaaa-0000-0000-0000-000000000001';
const BOB = 'bbbbbbbb-0000-0000-0000-000000000002';
const MEMBER = 'cccccccc-0000-0000-0000-000000000003';
const REF_A = '0a1b2c3d4e5f6071';
const REF_B = '8191a2b3c4d5e6f7';

function record(table, eventName, pk, sk) {
  return {
    eventName,
    eventSource: 'aws:dynamodb',
    eventSourceARN: `arn:aws:dynamodb:us-east-1:000000000000:table/${table}/stream/2026-11-06T00:00:00.000`,
    dynamodb: { Keys: { pk: { S: pk }, ...(sk === undefined ? {} : { sk: { S: sk } }) } },
  };
}

test('what the streams changed: board events and update facts, ownership, releases, the fleet, apps and the activity log', () => {
  const change = changesOf(
    [
      record(TABLES.events, 'INSERT', A, 'E#2026-11-06T17:59:59.000Z#a1b2c3'),
      record(TABLES.events, 'INSERT', `UPD#${B}`, '2026-11-06T17:00:00.000Z#job'),
      record(TABLES.state, 'MODIFY', 'OWN', C),
      record(TABLES.state, 'INSERT', 'REL', '1.14.0'),
      record(TABLES.state, 'INSERT', 'ROL', 'r1'),
      record(TABLES.audit, 'INSERT', 'AUD', '2026-11-06T17:59:59.000Z#x'),
    ],
    TABLES
  );
  assert.deepEqual(change, {
    things: [A, C, B],
    what: ['board', 'updates', 'ownership', 'releases', 'rollouts', 'activity'],
  });

  // What is not a change: a sample, a line of the console, an expired event, the alerts' and the
  // tokens' parts, another table, a name that is not a board, a deletion of the audit log.
  const nothing = changesOf(
    [
      record(TABLES.events, 'INSERT', A, 'S#2026-11-06T17:59:59.000Z'),
      record(TABLES.events, 'INSERT', A, 'L#2026-11-06T17:59:59.000Z#1.2'),
      record(TABLES.events, 'INSERT', A, 'K#1.2'),
      record(TABLES.events, 'REMOVE', A, 'E#2026-08-01T00:00:00.000Z#a1b2c3'),
      record(TABLES.events, 'INSERT', 'ALERTS', A),
      record(TABLES.events, 'INSERT', 'not-a-board', 'E#2026-11-06T17:59:59.000Z#a1b2c3'),
      record(TABLES.events, 'INSERT', 'UPD#nope', 'x'),
      record(TABLES.state, 'INSERT', 'TOK', 'digest'),
      record(TABLES.state, 'INSERT', 'SEEN', A),
      record(TABLES.audit, 'MODIFY', 'AUD', 'x'),
      record('SomeOtherTable', 'INSERT', A, 'E#2026-11-06T17:59:59.000Z#a1b2c3'),
      { eventName: 'INSERT' },
      null,
    ],
    TABLES
  );
  assert.deepEqual(nothing, { things: [], what: [] });
  assert.deepEqual(changesOf('no', TABLES), { things: [], what: [] });
});

test('the team hears of every change; a customer only of their own boards, by their refs, and that ownership changed somewhere', () => {
  const owners = new Map([
    [A, { owner: ALICE, ref: REF_A }],
    [B, { owner: BOB, ref: REF_B }],
  ]);
  const team = { audience: 'team', sub: MEMBER };
  const alice = { audience: 'customer', sub: ALICE };
  const carol = { audience: 'customer', sub: 'nobody-owns-anything' };
  const at = '2026-11-06T18:00:00.000Z';
  const change = { things: [A, B], what: ['board', 'releases', 'activity'] };
  assert.deepEqual(messageFor(team, change, null, NOW_MS), { type: 'changed', ...change, at });
  // Never a thing name: the customer site knows a board by its ref.
  assert.deepEqual(messageFor(alice, change, owners, NOW_MS), {
    type: 'changed',
    boards: [REF_A],
    what: ['board'],
    at,
  });
  assert.equal(JSON.stringify(messageFor(alice, change, owners, NOW_MS)).includes('cranium-'), false);
  assert.equal(messageFor(carol, change, owners, NOW_MS), null);
  // Releases and the activity log are the team's alone.
  assert.equal(messageFor(alice, { things: [], what: ['releases', 'activity'] }, owners, NOW_MS), null);
  // A board was taken from someone: every customer reads their list again, and learns no name.
  const moved = { things: [C], what: ['ownership'] };
  assert.deepEqual(messageFor(carol, moved, owners, NOW_MS), { type: 'changed', boards: [], what: ['ownership'], at });
  assert.deepEqual(messageFor(alice, moved, owners, NOW_MS), { type: 'changed', boards: [], what: ['ownership'], at });
  assert.equal(messageFor(team, { things: [], what: [] }, null, NOW_MS), null);
  assert.equal(messageFor({ audience: 'other', sub: ALICE }, change, owners, NOW_MS), null);
});

test('the token comes in the second subprotocol, after cranium-live', () => {
  assert.equal(tokenFromProtocols('cranium-live, abc.def.ghi'), 'abc.def.ghi');
  assert.equal(tokenFromProtocols('cranium-live,abc.def.ghi'), 'abc.def.ghi');
  for (const value of [
    'abc.def.ghi',
    'cranium-live',
    'other, abc',
    'abc, cranium-live',
    'cranium-live, a, b',
    'cranium-live, ',
    null,
    42,
  ]) {
    assert.equal(tokenFromProtocols(value), null, String(value));
  }
});

// The world of the handler: a pool's key, the connections, the owners, what each socket was sent.

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEYS = keysOf({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] });

function token(claims = {}) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = part({ alg: 'RS256', kid: 'k1' });
  const body = part({
    sub: MEMBER,
    iss: TEAM,
    client_id: 'consoleclient',
    token_use: 'access',
    iat: NOW_S - 60,
    exp: NOW_S + 3000,
    ...claims,
  });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), pair.privateKey).toString('base64url')}`;
}

function world({
  team = [MEMBER],
  customers = [ALICE, BOB],
  owners = [
    [A, { owner: ALICE, ref: REF_A }],
    [B, { owner: BOB, ref: REF_B }],
  ],
} = {}) {
  const connections = new Map();
  const sent = [];
  const closed = [];
  const logs = [];
  const calls = { listOwners: 0, accounts: 0 };
  const gone = new Set();
  let failNext = null;
  const store = {
    async putConnection(connection) {
      if (failNext === 'store') throw new Error('DynamoDB is down');
      connections.set(connection.connectionId, { ...connection });
    },
    async deleteConnection(id) {
      connections.delete(id);
    },
    async listConnections() {
      if (failNext === 'list') throw new Error('DynamoDB is down');
      return [...connections.values()].map((connection) => ({ ...connection }));
    },
    async listOwners() {
      calls.listOwners += 1;
      return new Map(owners);
    },
  };
  const sockets = {
    async send(id, text) {
      if (id === 'broken') throw new Error('network');
      if (gone.has(id)) return 'gone';
      sent.push({ id, message: JSON.parse(text) });
      return 'sent';
    },
    async close(id) {
      closed.push(id);
    },
  };
  const accounts = {
    async teamMember(sub) {
      calls.accounts += 1;
      if (failNext === 'cognito') throw new Error('Cognito is down');
      return team.includes(sub);
    },
    async customer(sub) {
      calls.accounts += 1;
      return customers.includes(sub);
    },
  };
  const handler = createLiveHandler({
    store,
    sockets,
    accounts,
    keyFor: async (issuer, kid) => ([TEAM, CUSTOMERS].includes(issuer) ? (KEYS.get(kid) ?? null) : null),
    pools: POOLS,
    tables: TABLES,
    now: () => NOW_MS,
    log: (line) => logs.push(line),
  });
  const connect = (id, protocols) =>
    handler({
      requestContext: { routeKey: '$connect', connectionId: id, eventType: 'CONNECT' },
      headers: protocols === undefined ? {} : { 'Sec-WebSocket-Protocol': protocols },
    });
  return {
    handler,
    connect,
    connections,
    sent,
    closed,
    logs,
    calls,
    gone,
    fail(what) {
      failNext = what;
    },
  };
}

test('a page connects with its token: the answer names the subprotocol, and the connection is kept until the token expires', async () => {
  const w = world();
  assert.deepEqual(await w.connect('conn-1=', `${PROTOCOL}, ${token()}`), {
    statusCode: 200,
    headers: { 'Sec-WebSocket-Protocol': PROTOCOL },
  });
  assert.deepEqual(w.connections.get('conn-1='), {
    connectionId: 'conn-1=',
    audience: 'team',
    sub: MEMBER,
    until: NOW_S + 3000,
  });
  // A customer, from the phone app's client; and a token good for longer than a connection lasts.
  const long = token({ iss: CUSTOMERS, client_id: 'customermobile', sub: ALICE, exp: NOW_S + 5 * 3600 });
  assert.equal((await w.connect('conn-2', `${PROTOCOL}, ${long}`)).statusCode, 200);
  assert.deepEqual(w.connections.get('conn-2'), {
    connectionId: 'conn-2',
    audience: 'customer',
    sub: ALICE,
    until: NOW_S + MAX_CONNECTION_S,
  });
  // The header's name in any case, as clients send it.
  const lower = await w.handler({
    requestContext: { routeKey: '$connect', connectionId: 'conn-3' },
    headers: { 'sec-websocket-protocol': `${PROTOCOL}, ${token()}` },
  });
  assert.equal(lower.statusCode, 200);
  // The log says who connected as which audience, and never the token or the sub.
  for (const line of w.logs) {
    const text = JSON.stringify(line);
    assert.equal(text.includes(MEMBER) || text.includes(ALICE) || text.includes('eyJ'), false, text);
  }
});

test('no token, a bad one, or an account that may not connect is refused; a check that cannot be made is a failure', async () => {
  const w = world({ team: [], customers: [] });
  assert.equal((await w.connect('c1')).statusCode, 401);
  assert.equal((await w.connect('c2', token())).statusCode, 401, 'the token alone, without cranium-live');
  assert.equal((await w.connect('c3', `${PROTOCOL}, not-a-token`)).statusCode, 401);
  assert.equal((await w.connect('c4', `${PROTOCOL}, ${token({ token_use: 'id' })}`)).statusCode, 401);
  assert.equal((await w.connect('c5', `${PROTOCOL}, ${token({ exp: NOW_S - 3600 })}`)).statusCode, 401);
  assert.equal(w.calls.accounts, 0, 'Cognito is asked only about a good token');
  assert.equal((await w.connect('c6', `${PROTOCOL}, ${token()}`)).statusCode, 403);
  assert.equal(
    (await w.connect('c7', `${PROTOCOL}, ${token({ iss: CUSTOMERS, client_id: 'siteclient', sub: ALICE })}`))
      .statusCode,
    403
  );
  assert.equal(w.connections.size, 0);
  assert.deepEqual(
    w.logs.map((line) => line.reason),
    ['no_token', 'no_token', 'malformed', 'not_access', 'expired', 'account', 'account']
  );

  const down = world();
  down.fail('cognito');
  assert.equal((await down.connect('c8', `${PROTOCOL}, ${token()}`)).statusCode, 500);
  down.fail('store');
  assert.equal(
    (await down.connect('c9', `${PROTOCOL}, ${token({ iss: CUSTOMERS, client_id: 'siteclient', sub: ALICE })}`))
      .statusCode,
    500
  );
  assert.equal(down.connections.size, 0);
  assert.equal(
    (await down.handler({ requestContext: { routeKey: '$connect', connectionId: 'bad id!' } })).statusCode,
    400
  );
});

test('a page that goes is forgotten, and a ping is answered with nothing', async () => {
  const w = world();
  await w.connect('conn-1', `${PROTOCOL}, ${token()}`);
  assert.deepEqual(
    await w.handler({ requestContext: { routeKey: '$default', connectionId: 'conn-1' }, body: '{"action":"ping"}' }),
    { statusCode: 200 }
  );
  assert.deepEqual(await w.handler({ requestContext: { routeKey: '$disconnect', connectionId: 'conn-1' } }), {
    statusCode: 200,
  });
  assert.equal(w.connections.size, 0);
});

test('a change is sent to each connection that may hear of it; expired and vanished ones are closed and forgotten', async () => {
  const w = world();
  w.connections.set('team', { connectionId: 'team', audience: 'team', sub: MEMBER, until: NOW_S + 600 });
  w.connections.set('alice', { connectionId: 'alice', audience: 'customer', sub: ALICE, until: NOW_S + 600 });
  w.connections.set('bob', { connectionId: 'bob', audience: 'customer', sub: BOB, until: NOW_S + 600 });
  w.connections.set('old', { connectionId: 'old', audience: 'team', sub: MEMBER, until: NOW_S });
  w.connections.set('left', { connectionId: 'left', audience: 'team', sub: MEMBER, until: NOW_S + 600 });
  w.connections.set('broken', { connectionId: 'broken', audience: 'team', sub: MEMBER, until: NOW_S + 600 });
  w.gone.add('left');
  const result = await w.handler({
    Records: [
      record(TABLES.events, 'INSERT', A, 'E#2026-11-06T17:59:59.000Z#a1b2c3'),
      record(TABLES.audit, 'INSERT', 'AUD', 'x'),
    ],
  });
  assert.deepEqual(result, { sent: 2, closed: 2 });
  const at = '2026-11-06T18:00:00.000Z';
  assert.deepEqual(
    w.sent.sort((a, b) => (a.id < b.id ? -1 : 1)),
    [
      { id: 'alice', message: { type: 'changed', boards: [REF_A], what: ['board'], at } },
      { id: 'team', message: { type: 'changed', things: [A], what: ['board', 'activity'], at } },
    ]
  );
  assert.deepEqual(w.closed, ['old']);
  assert.deepEqual([...w.connections.keys()].sort(), ['alice', 'bob', 'broken', 'team']);
  assert.equal(w.calls.listOwners, 1);
  assert.equal(w.logs.at(-1).failed, 1, 'a send that fails is logged and the batch goes on');
});

test('a batch with no change, or no one to tell, reads nothing more; a batch whose connections cannot be read fails', async () => {
  const w = world();
  assert.deepEqual(await w.handler({ Records: [record(TABLES.events, 'INSERT', A, 'S#2026-11-06T17:59:59.000Z')] }), {
    sent: 0,
    closed: 0,
  });
  assert.deepEqual(
    await w.handler({ Records: [record(TABLES.events, 'INSERT', A, 'E#2026-11-06T17:59:59.000Z#a1b2c3')] }),
    { sent: 0, closed: 0 }
  );
  // Only the team is connected: who owns what is not asked.
  w.connections.set('team', { connectionId: 'team', audience: 'team', sub: MEMBER, until: NOW_S + 600 });
  await w.handler({ Records: [record(TABLES.state, 'INSERT', 'REL', '1.15.0')] });
  assert.equal(w.calls.listOwners, 0);
  assert.deepEqual(
    w.sent.map((entry) => entry.message.what),
    [['releases']]
  );
  w.fail('list');
  await assert.rejects(w.handler({ Records: [record(TABLES.state, 'INSERT', 'REL', '1.15.1')] }), /DynamoDB is down/);
});
