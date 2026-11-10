// Tests for what a customer may change on the customer site (docs/customer-site.md, "Customer
// actions"): their own name for a board of theirs, and which e-mails they want. Every write checks
// the token, the account (asked of Cognito again), the limits and the ownership; every write that
// gets that far is on record in the customers' partition of the audit table, which the console's
// activity log shows as done by a customer. An update that waits at a board cannot be accepted from
// here: the firmware takes it from Button 1 only.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WRITES_PER_HOUR, WRITES_PER_MINUTE } from '../src/customer/app.mjs';
import { LABEL_LIMIT } from '../src/customer/boards.mjs';
import {
  CUSTOMER_EMAILS_ENABLED,
  createCustomerMailer,
  emailWords,
  notificationOf,
  planCustomerEmails,
} from '../src/customer/notify.mjs';
import { accessClaims } from './fake-aws.mjs';
import { createCustomerWorld, customerClaims } from './fake-customers.mjs';

const MINUTE = 60_000;
const BOARD_A = 'cranium-00000000000000aa';
const BOARD_B = 'cranium-00000000000000bb';
const BOARD_C = 'cranium-00000000000000cc';

async function world() {
  const w = createCustomerWorld();
  const admin = w.addStaff('admin', ['release-managers']);
  const ada = w.addCustomer('ada', { name: 'Ada' });
  const ben = w.addCustomer('ben');
  for (const thing of [BOARD_A, BOARD_B, BOARD_C]) w.fake.addThing(thing);
  w.fake.device(BOARD_A).connect();
  w.fake.device(BOARD_A).report({
    fw: { version: '1.11.2+0', confirmed: true },
    uptime: 600,
    wifi: { rssi: -58 },
    ota: { state: 'idle', progress: 0, last: 'succeeded', error: '' },
    diag: { id: 'CRADA01', mac: 'f4:ce:36:12:34:56', channel: 6, heap: { free: 21000, least: 9000, size: 44000 } },
  });
  w.advance(MINUTE);
  for (const [customer, thing, label] of [
    [ada, BOARD_A, 'Living room deck'],
    [ada, BOARD_B, undefined],
    [ben, BOARD_C, 'Studio'],
  ]) {
    const response = await w.console('POST', `/api/customers/${customer.sub}/boards`, {
      as: admin,
      body: { thing, label },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  const idOf = async (customer, index = 0) =>
    (await w.customer('/api/c/boards', { as: customer })).body.boards[index].id;
  const rename = (customer, id, body) =>
    w.customer(`/api/c/boards/${id}/label`, { as: customer, method: 'POST', body });
  const choose = (customer, body) => w.customer('/api/c/preferences', { as: customer, method: 'POST', body });
  return { ...w, admin, ada, ben, idOf, rename, choose };
}

const actionsOf = (w) =>
  w.fake.customerActionLog().map((item) => [item.action, item.outcome, item.target, item.detail.code ?? '']);

// Renaming a board.

test("a customer names a board of theirs; the thing name and the admin's label stay as they were", async () => {
  const w = await world();
  const id = await w.idOf(w.ada);
  const renamed = await w.rename(w.ada, id, { label: '  Kitchen deck ' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.board.id, id);
  assert.equal(renamed.body.board.name, 'Kitchen deck');
  assert.equal(renamed.body.board.label, 'Kitchen deck');

  const stored = w.store.ownership(BOARD_A);
  assert.equal(stored.sk, BOARD_A);
  assert.equal(stored.customerLabel, 'Kitchen deck');
  assert.equal(stored.label, 'Living room deck');
  assert.equal(stored.owner, w.ada.sub);
  assert.equal(stored.ref, id);

  const boards = (await w.customer('/api/c/boards', { as: w.ada })).body.boards;
  assert.deepEqual(
    boards.map((board) => [board.name, board.label]),
    [
      ['Kitchen deck', 'Kitchen deck'],
      [null, null],
    ]
  );
  // The board's own page says the same, and the board is still found by the same id.
  assert.equal((await w.customer(`/api/c/boards/${id}`, { as: w.ada })).body.board.name, 'Kitchen deck');

  // The console's Customers page shows it as the customer's label, beside the admin's.
  const listed = (await w.console('GET', '/api/customers', { as: w.admin })).body.customers.find(
    (customer) => customer.id === w.ada.sub
  );
  assert.deepEqual(
    listed.boards.find((board) => board.thing === BOARD_A),
    {
      thing: BOARD_A,
      label: 'Living room deck',
      customerLabel: 'Kitchen deck',
      assignedAt: listed.boards.find((board) => board.thing === BOARD_A).assignedAt,
    }
  );

  // An empty name takes theirs away: the admin's shows again.
  const cleared = await w.rename(w.ada, id, { label: '' });
  assert.equal(cleared.status, 200);
  assert.deepEqual([cleared.body.board.name, cleared.body.board.label], ['Living room deck', null]);
  assert.equal(w.store.ownership(BOARD_A).customerLabel, undefined);

  // Nothing of the fleet in what came back.
  for (const body of [renamed.body, cleared.body]) {
    const text = JSON.stringify(body);
    for (const secret of ['cranium-', 'f4:ce:36', 'mac', 'channel', 'heap', 'thing', 'job', 'arn:', '@']) {
      assert.equal(text.includes(secret), false, `${secret} in ${text}`);
    }
  }
});

test('a name of 40 characters is taken; longer, of control characters, or not text, is refused and on record', async () => {
  const w = await world();
  const id = await w.idOf(w.ada);
  assert.equal(LABEL_LIMIT, 40);
  const forty = `Café ${'x'.repeat(35)}`;
  assert.equal([...forty].length, 40);
  assert.equal((await w.rename(w.ada, id, { label: forty })).status, 200);
  for (const [body, code] of [
    [{ label: 'x'.repeat(41) }, 'label_too_long'],
    [{ label: 'Deck\u0007' }, 'invalid_label'],
    [{ label: 'Deck‮evil' }, 'invalid_label'],
    [{ label: '\u{1F3A7} Deck' }, 'invalid_label'],
    [{ label: 42 }, 'invalid_label'],
    [{ label: null }, 'invalid_label'],
    [{}, 'invalid_label'],
    [{ label: 'Deck', thing: BOARD_C }, 'unknown_field'],
    [{ label: 'Deck', owner: w.ben.sub }, 'unknown_field'],
  ]) {
    const response = await w.rename(w.ada, id, body);
    assert.deepEqual([response.status, response.body.error.code], [400, code], JSON.stringify(body));
  }
  // Not JSON, not an object, and too large, a minute later: ten changes a minute at most.
  w.advance(MINUTE);
  for (const [body, status] of [
    ['not json', 400],
    ['[1,2]', 400],
    [JSON.stringify({ label: 'x'.repeat(2000) }), 413],
  ]) {
    const event = await w.customerApp({
      ...(await import('./fake-customers.mjs')).customerEvent(`/api/c/boards/${id}/label`, {
        claims: w.ada.claims,
        method: 'POST',
      }),
      body,
    });
    assert.equal(event.statusCode, status, body.slice(0, 20));
  }
  assert.equal(w.store.ownership(BOARD_A).customerLabel, forty);
  const log = actionsOf(w);
  assert.equal(log.length, 13);
  assert.deepEqual(log[0], ['customer_action.rename', 'ok', BOARD_A, '']);
  assert.ok(log.slice(1).every(([action, outcome]) => action === 'customer_action.rename' && outcome === 'rejected'));
});

test("another customer's board is as unknown as one that does not exist, and a thing name is no id", async () => {
  const w = await world();
  const adas = await w.idOf(w.ada);
  for (const id of [adas, '0123456789abcdef', BOARD_A, 'ABCDEF0123456789']) {
    const response = await w.rename(w.ben, id, { label: 'Mine now' });
    assert.deepEqual([response.status, response.body.error.code], [404, 'not_your_board'], id);
    assert.equal(response.body.error.message, 'There is no board of yours at this address.');
  }
  assert.equal(w.store.ownership(BOARD_A).customerLabel, undefined);
  // Each refusal is on record, denied, with no board named but the id that was asked for.
  const log = w.fake.customerActionLog();
  assert.deepEqual(
    log.map((item) => [item.outcome, item.target, item.detail.board ?? '']),
    [
      ['denied', '', adas],
      ['denied', '', '0123456789abcdef'],
      ['denied', '', ''],
      ['denied', '', ''],
    ]
  );

  // A board taken back while the customer's page was open is no longer theirs either.
  const id = await w.idOf(w.ada);
  const back = await w.console('POST', `/api/customers/${w.ada.sub}/boards/${BOARD_A}/remove`, { as: w.admin });
  assert.equal(back.status, 200);
  assert.equal((await w.rename(w.ada, id, { label: 'Too late' })).status, 404);
  assert.equal(w.store.ownership(BOARD_A).customerLabel, undefined);
});

test("taking a board back takes the customer's name for it too: the next owner starts with none", async () => {
  const w = await world();
  const id = await w.idOf(w.ada);
  assert.equal((await w.rename(w.ada, id, { label: 'Kitchen deck' })).status, 200);
  await w.console('POST', `/api/customers/${w.ada.sub}/boards/${BOARD_A}/remove`, { as: w.admin });
  assert.equal(w.store.ownership(BOARD_A).customerLabel, undefined);
  await w.console('POST', `/api/customers/${w.ben.sub}/boards`, { as: w.admin, body: { thing: BOARD_A } });
  const bens = (await w.customer('/api/c/boards', { as: w.ben })).body.boards.map((board) => board.name);
  assert.equal(bens.includes('Kitchen deck'), false);
});

// Notification preferences.

test('e-mails are off until the customer turns one on, each their own, and the reply says none are sent yet', async () => {
  const w = await world();
  const first = await w.customer('/api/c/preferences', { as: w.ada });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, {
    notifications: { offline: false, updated: false, unexpectedRestart: false },
    emails: 'off',
  });
  assert.equal(CUSTOMER_EMAILS_ENABLED, false);

  const on = await w.choose(w.ada, { offline: true, unexpectedRestart: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual(on.body.notifications, { offline: true, updated: false, unexpectedRestart: true });
  const off = await w.choose(w.ada, { offline: false });
  assert.deepEqual(off.body.notifications, { offline: false, updated: false, unexpectedRestart: true });
  assert.deepEqual((await w.customer('/api/c/preferences', { as: w.ada })).body.notifications, off.body.notifications);
  // Ben's are his own.
  assert.deepEqual((await w.customer('/api/c/preferences', { as: w.ben })).body.notifications, {
    offline: false,
    updated: false,
    unexpectedRestart: false,
  });

  for (const [body, code] of [
    [{}, 'nothing_chosen'],
    [{ offline: 'yes' }, 'invalid_choice'],
    [{ offline: 1 }, 'invalid_choice'],
    [{ email: 'ada@example.invalid' }, 'unknown_field'],
    [{ offline: true, sub: w.ben.sub }, 'unknown_field'],
  ]) {
    const response = await w.choose(w.ada, body);
    assert.deepEqual([response.status, response.body.error.code], [400, code], JSON.stringify(body));
  }
  const log = w.fake.customerActionLog();
  assert.deepEqual(
    log.map((item) => [item.action, item.outcome]),
    [
      ['customer_action.notifications', 'ok'],
      ['customer_action.notifications', 'ok'],
      ...Array(5).fill(['customer_action.notifications', 'rejected']),
    ]
  );
  assert.deepEqual(log[0].changes, [
    { field: 'offline', from: 'off', to: 'on' },
    { field: 'unexpectedRestart', from: 'off', to: 'on' },
  ]);
});

// Limits.

test('at most 10 changes a minute and 60 an hour per customer; one over is refused and leaves no entry', async () => {
  const w = await world();
  const id = await w.idOf(w.ada);
  assert.deepEqual([WRITES_PER_MINUTE, WRITES_PER_HOUR], [10, 60]);
  for (let count = 0; count < 10; count += 1) {
    assert.equal((await w.rename(w.ada, id, { label: `Deck ${count}` })).status, 200);
  }
  const over = await w.rename(w.ada, id, { label: 'One too many' });
  assert.deepEqual([over.status, over.body.error.code], [429, 'too_many_changes']);
  assert.equal((await w.choose(w.ada, { offline: true })).status, 429);
  assert.equal(w.fake.customerActionLog().length, 10);
  assert.equal(w.store.ownership(BOARD_A).customerLabel, 'Deck 9');
  // Refusals count too: a flood of bad requests is held to the same limit.
  assert.equal((await w.rename(w.ben, id, { label: 'x' })).status, 404);

  // Ben is not held back by Ada.
  assert.equal((await w.choose(w.ben, { updated: true })).status, 200);
  // A minute later Ada may again, until the hour is full.
  let made = 10;
  while (made < 60) {
    w.advance(MINUTE);
    for (let count = 0; count < 10 && made < 60; count += 1, made += 1) {
      assert.equal((await w.choose(w.ada, { offline: made % 2 === 0 })).status, 200, `change ${made}`);
    }
  }
  w.advance(MINUTE);
  assert.equal((await w.choose(w.ada, { offline: true })).status, 429);
  w.advance(60 * MINUTE);
  assert.equal((await w.choose(w.ada, { offline: true })).status, 200);
});

test('when the count of recent changes cannot be read, the write fails closed and changes nothing', async () => {
  const w = await world();
  const id = await w.idOf(w.ada);
  const real = w.fake.recentCustomerActions;
  w.fake.recentCustomerActions = async () => {
    throw new Error('throttled');
  };
  const response = await w.rename(w.ada, id, { label: 'Fine' });
  assert.deepEqual([response.status, response.body.error.code], [503, 'unavailable']);
  assert.equal(w.store.ownership(BOARD_A).customerLabel, undefined);
  assert.equal(w.fake.customerActionLog().length, 0);
  w.fake.recentCustomerActions = real;
  assert.equal((await w.rename(w.ada, id, { label: 'Fine' })).status, 200);
});

test('a change whose entry cannot be stored is still made, and the failure is logged', async () => {
  const w = await world();
  const id = await w.idOf(w.ada);
  const real = w.fake.putCustomerAction;
  w.fake.putCustomerAction = async () => {
    throw new Error('throttled');
  };
  assert.equal((await w.rename(w.ada, id, { label: 'Kitchen' })).status, 200);
  assert.ok(w.logs.some((line) => line.event === 'audit_write_failed' && line.action === 'customer_action.rename'));
  w.fake.putCustomerAction = real;
});

// Who may write.

test("a staff token, a phone app's staff token and an ID token are refused by the customer API's writes", async () => {
  const w = await world();
  const id = await w.idOf(w.ada);
  for (const claims of [
    w.admin.claims,
    accessClaims({ sub: w.admin.sub, groups: ['release-managers'], clientId: 'localmobile' }),
    customerClaims({ sub: w.ada.sub, tokenUse: 'id' }),
    customerClaims({ sub: w.ada.sub, clientId: 'someoneelse' }),
    customerClaims({ sub: w.ada.sub, poolId: 'us-east-1_another' }),
  ]) {
    const response = await w.customer(`/api/c/boards/${id}/label`, {
      claims,
      method: 'POST',
      body: { label: 'Not allowed' },
    });
    assert.equal(response.status, 401);
    const prefs = await w.customer('/api/c/preferences', { claims, method: 'POST', body: { offline: true } });
    assert.equal(prefs.status, 401);
  }
  assert.equal(w.store.ownership(BOARD_A).customerLabel, undefined);
  assert.equal(w.fake.customerActionLog().length, 0);
  // And a customer's token opens no write of the console's.
  for (const path of ['/api/customers', `/api/customers/${w.ada.sub}/boards`, '/api/audit']) {
    assert.equal((await w.console('POST', path, { claims: w.ada.claims, body: {} })).status, 401, path);
  }
});

test('a write asks Cognito again: an account switched off a moment ago cannot change anything', async () => {
  const w = await world();
  const id = await w.idOf(w.ada);
  assert.equal((await w.customer('/api/c/boards', { as: w.ada })).status, 200);
  await w.console('POST', `/api/customers/${w.ada.sub}/disable`, { as: w.admin });
  const response = await w.rename(w.ada, id, { label: 'Still mine?' });
  assert.deepEqual([response.status, response.body.error.code], [403, 'account_inactive']);
  assert.equal(w.store.ownership(BOARD_A).customerLabel, undefined);
  assert.equal(w.fake.customerActionLog().length, 0);

  // When Cognito cannot be asked, a write fails, even with an answer from the last minute.
  await w.console('POST', `/api/customers/${w.ada.sub}/enable`, { as: w.admin });
  // A read takes Cognito's answer of the last minute: a minute on, she reads again.
  w.advance(MINUTE);
  assert.equal((await w.customer('/api/c/boards', { as: w.ada })).status, 200);
  w.store.failNext('getCustomer');
  assert.equal((await w.rename(w.ada, id, { label: 'Kitchen' })).status, 503);
});

test('other methods and paths of the customer API are nothing, and there is no route that accepts an update', async () => {
  const w = await world();
  const id = await w.idOf(w.ada);
  for (const [method, path] of [
    ['POST', '/api/c/boards'],
    ['POST', `/api/c/boards/${id}`],
    ['POST', `/api/c/boards/${id}/approve`],
    ['POST', `/api/c/boards/${id}/update`],
    ['POST', `/api/c/boards/${id}/label/x`],
    ['POST', '/api/c/me'],
    ['PUT', `/api/c/boards/${id}/label`],
    ['DELETE', '/api/c/preferences'],
  ]) {
    const response = await w.customer(path, { as: w.ada, method, body: {} });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.equal(w.fake.customerActionLog().length, 0);
});

test('an update waiting at a board is shown to its owner as waiting, to be accepted at the board', async () => {
  const w = await world();
  w.fake.device(BOARD_A).report({ ota: { state: 'awaiting_user', progress: 0, last: 'succeeded', error: '' } });
  const [board] = (await w.customer('/api/c/boards', { as: w.ada })).body.boards;
  assert.deepEqual(board.update, { state: 'awaiting_user', progress: 0, last: 'succeeded' });
  assert.equal(board.status, 'online');
});

// The record, and what the console makes of it.

test("each change is on record in the customers' partition, by a customer, with no e-mail address anywhere", async () => {
  const w = await world();
  const id = await w.idOf(w.ada);
  await w.rename(w.ada, id, { label: 'Kitchen deck' });
  await w.choose(w.ada, { updated: true });
  const [renamed, chose] = w.fake.customerActionLog();
  assert.equal(renamed.pk, 'CUS');
  assert.equal(renamed.by, 'customer');
  assert.deepEqual(renamed.actor, { sub: w.ada.sub, email: '' });
  assert.equal(renamed.target, BOARD_A);
  assert.deepEqual(renamed.detail, { label: 'Kitchen deck', board: id });
  assert.deepEqual(renamed.changes, [{ field: 'label', from: null, to: 'Kitchen deck' }]);
  assert.equal(chose.action, 'customer_action.notifications');
  // The console's own partition has none of it.
  assert.equal(
    w.fake.auditLog().some((item) => item.action.startsWith('customer_action.')),
    false
  );
  // No address in any entry or any log line of the customer API.
  const text = JSON.stringify([w.fake.customerActionLog(), w.logs]);
  assert.equal(text.includes('ada@example.invalid'), false);
  assert.ok(w.logs.some((line) => line.event === 'audit_entry' && /^[0-9a-f]{64}$/.test(line.digest)));

  // The console's activity log shows them among its own, newest first, marked as a customer's.
  const audit = await w.console('GET', '/api/audit', { as: w.admin, query: { limit: '50' } });
  assert.equal(audit.status, 200);
  const shown = audit.body.entries.filter((entry) => entry.by === 'customer');
  assert.deepEqual(
    shown.map((entry) => [entry.action, entry.target]),
    [
      ['customer_action.notifications', ''],
      ['customer_action.rename', BOARD_A],
    ]
  );
  assert.equal(audit.body.entries[0].action, 'customer_action.notifications');
  assert.ok(audit.body.entries.some((entry) => entry.action === 'customer.assign' && entry.by === undefined));
  // A search for a customer's action reads their partition only.
  const searched = await w.console('GET', '/api/audit', {
    as: w.admin,
    query: { actions: 'customer_action.rename' },
  });
  assert.deepEqual(
    searched.body.entries.map((entry) => entry.action),
    ['customer_action.rename']
  );
});

test("the console's activity log pages through both partitions in order, with nothing twice and nothing missed", async () => {
  const w = await world();
  const id = await w.idOf(w.ada);
  for (let count = 0; count < 7; count += 1) {
    w.advance(MINUTE);
    await w.rename(w.ada, id, { label: `Deck ${count}` });
    w.advance(MINUTE);
    await w.console('POST', `/api/customers/${w.ada.sub}/resend`, { as: w.admin });
  }
  const want = [...w.fake.auditLog(), ...w.fake.customerActionLog()]
    .map((item) => item.sk)
    .sort()
    .reverse();
  for (const query of [{}, { q: 'cranium' }, { outcomes: 'ok,rejected' }]) {
    const seen = [];
    let before;
    for (let pages = 0; pages < 20; pages += 1) {
      const page = await w.console('GET', '/api/audit', {
        as: w.admin,
        query: { limit: '4', ...query, ...(before ? { before } : {}) },
      });
      assert.equal(page.status, 200);
      seen.push(...page.body.entries.map((entry) => `${entry.at}#${entry.requestId}`));
      if (page.body.next === null) break;
      before = page.body.next;
    }
    const expected =
      query.q === undefined
        ? want
        : want.filter((sk) => {
            const item = [...w.fake.auditLog(), ...w.fake.customerActionLog()].find((entry) => entry.sk === sk);
            return item.target.includes('cranium');
          });
    const filtered = query.outcomes
      ? expected.filter((sk) =>
          ['ok', 'rejected'].includes(
            [...w.fake.auditLog(), ...w.fake.customerActionLog()].find((entry) => entry.sk === sk).outcome
          )
        )
      : expected;
    assert.deepEqual(seen, filtered, JSON.stringify(query));
  }
});

// E-mails: decided here, sent by nothing yet.

test('which e-mails some events call for: only for an owner who asked, naming the board as they do', async () => {
  const ownership = [
    { thing: BOARD_A, owner: 'sub-ada', ref: 'aaaaaaaaaaaaaaaa', label: 'Living room deck', customerLabel: 'Kitchen' },
    { thing: BOARD_B, owner: 'sub-ada', ref: 'bbbbbbbbbbbbbbbb', label: '', customerLabel: '' },
    { thing: BOARD_C, owner: 'sub-ben', ref: 'cccccccccccccccc', label: 'Studio', customerLabel: '' },
  ];
  const stored = { 'sub-ada': { offline: true, updated: true, unexpectedRestart: false }, 'sub-ben': null };
  const at = '2026-11-09T12:00:00.000Z';
  const plans = await planCustomerEmails({
    ownership,
    preferencesOf: async (sub) => stored[sub] ?? null,
    events: [
      { thing: BOARD_A, event: { at, kind: 'connection', what: 'disconnected' } },
      { thing: BOARD_B, event: { at, kind: 'firmware', what: 'changed', from: '1.11.2+0', to: '1.12.0+0' } },
      { thing: BOARD_A, event: { at, kind: 'restart', what: 'restarted', cause: '10' } },
      { thing: BOARD_C, event: { at, kind: 'connection', what: 'disconnected' } },
      { thing: 'cranium-00000000000000dd', event: { at, kind: 'connection', what: 'disconnected' } },
      { thing: BOARD_A, event: { at, kind: 'connection', what: 'connected' } },
    ],
  });
  assert.deepEqual(plans, [
    {
      sub: 'sub-ada',
      ref: 'aaaaaaaaaaaaaaaa',
      kind: 'offline',
      subject: 'Kitchen is offline',
      text: 'Cranium lost touch with Kitchen. It reports again once it is on and on Wi-Fi.',
    },
    {
      sub: 'sub-ada',
      ref: 'bbbbbbbbbbbbbbbb',
      kind: 'updated',
      subject: 'your board was updated',
      text: 'your board now runs firmware 1.12.0.',
    },
  ]);
  assert.equal(notificationOf({ kind: 'restart', what: 'restarted', cause: '10' }), 'unexpectedRestart');
  assert.equal(notificationOf({ kind: 'restart', what: 'restarted', cause: '8' }), null);
  assert.equal(notificationOf({ kind: 'restart', what: 'stuck' }), 'unexpectedRestart');
  assert.match(emailWords('unexpectedRestart', ownership[2], {}).subject, /^Studio restarted unexpectedly$/);
  for (const plan of plans) assert.equal(JSON.stringify(plan).includes('cranium-'), false);
});

test('the mailer sends nothing while e-mails are off; turned on, it sends to an active account and logs no address', async () => {
  const logs = [];
  const sent = [];
  const accounts = {
    'sub-ada': { email: 'ada@example.invalid', enabled: true, status: 'CONFIRMED' },
    'sub-off': { email: 'off@example.invalid', enabled: false, status: 'CONFIRMED' },
  };
  const plans = [
    { sub: 'sub-ada', ref: 'aaaaaaaaaaaaaaaa', kind: 'offline', subject: 's', text: 't' },
    { sub: 'sub-off', ref: 'bbbbbbbbbbbbbbbb', kind: 'offline', subject: 's', text: 't' },
    { sub: 'sub-gone', ref: 'cccccccccccccccc', kind: 'offline', subject: 's', text: 't' },
  ];
  const getCustomer = async (sub) => accounts[sub] ?? null;
  const off = createCustomerMailer({
    getCustomer,
    send: async (mail) => sent.push(mail),
    log: (line) => logs.push(line),
  });
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.deliver(plans), { sent: 0, skipped: 3 });
  assert.equal(sent.length, 0);

  const on = createCustomerMailer({
    enabled: true,
    getCustomer,
    send: async (mail) => {
      if (mail.to.startsWith('ada')) sent.push(mail);
    },
    log: (line) => logs.push(line),
  });
  assert.deepEqual(await on.deliver(plans), { sent: 1, skipped: 2 });
  assert.deepEqual(sent, [{ to: 'ada@example.invalid', subject: 's', text: 't' }]);
  const failing = createCustomerMailer({
    enabled: true,
    getCustomer,
    send: async (mail) => {
      throw new Error(`could not send to ${mail.to}`);
    },
    log: (line) => logs.push(line),
  });
  assert.deepEqual(await failing.deliver(plans.slice(0, 1)), { sent: 0, skipped: 1 });
  assert.equal(JSON.stringify(logs).includes('@'), false);
  // With no sender, turning it on sends nothing either.
  assert.equal(createCustomerMailer({ enabled: true, getCustomer }).enabled, false);
});
