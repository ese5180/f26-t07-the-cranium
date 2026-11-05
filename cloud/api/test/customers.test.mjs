// Tests for the customer site's two halves (docs/customer-site.md): the customer API, which a
// customer reads their own boards through, and the console's Customers routes, which release
// managers invite customers and hand out boards with. Above all, that the two never mix: a
// customer's token opens nothing of the console's, a staff token nothing of the customer API's,
// and a customer sees their own boards and nothing else of the fleet.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { customerEvent as shownEvent } from '../src/customer/boards.mjs';
import { loadCustomerAdminConfig, loadCustomerApiConfig } from '../src/customer/config.mjs';
import { accessClaims, apiEvent, createFakeAws, fakeEnv } from './fake-aws.mjs';
import {
  CUSTOMER_CLIENT_ID, CUSTOMER_POOL_ID, createCustomerWorld, customerClaims, createFakeCustomers,
} from './fake-customers.mjs';

const MINUTE = 60_000;
const BOARD_A = 'cranium-00000000000000aa';
const BOARD_B = 'cranium-00000000000000bb';
const BOARD_C = 'cranium-00000000000000cc';

/** Two customers, three boards, a release manager and a viewer; the first board online on 1.11.2. */
async function world({ siteUrl } = {}) {
  const w = createCustomerWorld(siteUrl === undefined ? {} : { siteUrl });
  const admin = w.addStaff('admin', ['release-managers']);
  const viewer = w.addStaff('viewer', ['viewers']);
  const ada = w.addCustomer('ada', { name: 'Ada' });
  const ben = w.addCustomer('ben');
  for (const thing of [BOARD_A, BOARD_B, BOARD_C]) w.fake.addThing(thing);
  w.fake.device(BOARD_A).connect();
  w.fake.device(BOARD_A).report({
    fw: { version: '1.11.2+0', confirmed: true }, uptime: 600, wifi: { rssi: -58 },
    ota: { state: 'idle', progress: 0, last: 'succeeded', error: '' },
    diag: { id: 'CRADA01', mac: 'f4:ce:36:12:34:56', channel: 6, heap: { free: 21000, least: 9000, size: 44000 } },
  });
  w.advance(MINUTE);
  const assign = async (customer, thing, label) => {
    const response = await w.console('POST', `/api/customers/${customer.sub}/boards`, { as: admin, body: { thing, label } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response;
  };
  return { ...w, admin, viewer, ada, ben, assign };
}

const auditOf = (w) => w.fake.auditLog().map((entry) => [entry.action, entry.outcome, entry.target, entry.detail.code ?? '']);

// The two sides do not mix.

test('a customer\'s token opens nothing of the console\'s API, read or write', async () => {
  const w = await world();
  for (const [method, path] of [
    ['GET', '/api/me'], ['GET', '/api/devices'], ['GET', `/api/devices/${BOARD_A}`], ['GET', '/api/events'],
    ['GET', '/api/firmware'], ['GET', '/api/audit'], ['GET', '/api/customers'], ['GET', '/api/tokens'],
    ['POST', '/api/deployments'], ['POST', '/api/customers'],
  ]) {
    const response = await w.console(method, path, { claims: w.ada.claims, body: method === 'POST' ? {} : undefined });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test('a staff token, a phone app\'s, an ID token and another pool\'s are all refused by the customer API', async () => {
  const w = await world();
  await w.assign(w.ada, BOARD_A);
  const refused = [
    w.admin.claims,
    accessClaims({ sub: w.admin.sub, groups: ['release-managers'], clientId: 'localmobile' }),
    customerClaims({ sub: w.ada.sub, tokenUse: 'id' }),
    customerClaims({ sub: w.ada.sub, clientId: 'localclient' }),
    customerClaims({ sub: w.ada.sub, poolId: 'us-east-1_local' }),
    { ...customerClaims({ sub: w.ada.sub }), sub: 'not a sub!' },
  ];
  for (const claims of refused) {
    for (const path of ['/api/c/me', '/api/c/boards']) {
      const response = await w.customer(path, { claims });
      assert.deepEqual([response.status, response.body.error.code], [401, 'unauthorized'], `${path} ${JSON.stringify(claims)}`);
    }
  }
  assert.equal((await w.customer('/api/c/boards')).status, 401);
  // And the customer's own token works, so the refusals are about the tokens.
  assert.equal((await w.customer('/api/c/boards', { as: w.ada })).status, 200);
});

test('the customer API only reads: any other method and any other path are nothing', async () => {
  const w = await world();
  assert.equal((await w.customer('/api/c/boards', { as: w.ada, method: 'POST' })).status, 404);
  for (const path of ['/api/c/', '/api/c/firmware', '/api/c/boards/x/y', '/api/devices', '/api/c/me/']) {
    assert.equal((await w.customer(path, { as: w.ada })).status, 404, path);
  }
});

// Ownership.

test('a customer sees their own boards and no other: by assignment id, never by thing name', async () => {
  const w = await world();
  await w.assign(w.ada, BOARD_A, 'Living room deck');
  await w.assign(w.ada, BOARD_B);
  await w.assign(w.ben, BOARD_C, 'Studio');

  const ada = await w.customer('/api/c/boards', { as: w.ada });
  assert.equal(ada.status, 200);
  assert.deepEqual(ada.body.boards.map((board) => board.name), ['Living room deck', null]);
  const ben = await w.customer('/api/c/boards', { as: w.ben });
  assert.deepEqual(ben.body.boards.map((board) => board.name), ['Studio']);

  // Nothing of the fleet, of AWS or of the board's internals is in what a customer is sent.
  for (const body of [ada.body, ben.body]) {
    const text = JSON.stringify(body);
    for (const secret of ['cranium-', 'f4:ce:36', 'mac', 'channel', 'heap', 'thing', 'job', 'certificate', 'arn:']) {
      assert.equal(text.includes(secret), false, `${secret} in ${text}`);
    }
  }

  const [first] = ada.body.boards;
  assert.match(first.id, /^[0-9a-f]{16}$/);
  assert.deepEqual(
    [first.status, first.online, first.firmware, first.update, first.rssi, first.boardName, first.location],
    ['online', true, { version: '1.11.2+0', confirmed: true }, { state: 'idle', progress: 0, last: 'succeeded' }, -58,
      'CRADA01', null]);
  assert.equal(ada.body.boards[1].status, 'new');

  // Ben cannot open Ada's board, however he comes by its id, and a thing name is no id at all.
  assert.equal((await w.customer(`/api/c/boards/${first.id}`, { as: w.ada })).status, 200);
  for (const path of [`/api/c/boards/${first.id}`, `/api/c/boards/${BOARD_A}`, '/api/c/boards/0123456789abcdef']) {
    const response = await w.customer(path, { as: w.ben });
    assert.deepEqual([response.status, response.body.error.code], [404, 'not_your_board'], path);
  }
  assert.deepEqual((await w.customer('/api/c/me', { as: w.ada })).body, { email: 'ada@example.invalid', name: 'Ada', boards: 2 });
});

test('a board taken back and given to someone else gets a new id: the old one leads nowhere', async () => {
  const w = await world();
  await w.assign(w.ada, BOARD_A);
  const old = (await w.customer('/api/c/boards', { as: w.ada })).body.boards[0].id;
  assert.equal((await w.console('POST', `/api/customers/${w.ada.sub}/boards/${BOARD_A}/remove`, { as: w.admin })).status, 200);
  assert.deepEqual((await w.customer('/api/c/boards', { as: w.ada })).body.boards, []);
  assert.equal((await w.customer(`/api/c/boards/${old}`, { as: w.ada })).status, 404);

  await w.assign(w.ben, BOARD_A);
  const fresh = (await w.customer('/api/c/boards', { as: w.ben })).body.boards[0].id;
  assert.notEqual(fresh, old);
  assert.equal((await w.customer(`/api/c/boards/${old}`, { as: w.ben })).status, 404);
  assert.equal((await w.customer(`/api/c/boards/${old}`, { as: w.ada })).status, 404);
});

test('a board\'s activity: what its owner can make sense of, in typed fields, never the console\'s text', async () => {
  const w = await world();
  await w.assign(w.ada, BOARD_A);
  w.fake.device(BOARD_A).report({ uptime: 5, fw: { version: '1.11.3+0', confirmed: false } });
  w.fake.device(BOARD_A).report({ fw: { version: '1.11.3+0', confirmed: true } });
  w.fake.device(BOARD_A).report({ diag: { id: 'CRADA01', mac: 'f4:ce:36:12:34:56', channel: 11, heap: { free: 900, least: 100, size: 44000 } } });
  w.fake.device(BOARD_A).disconnect('CONNECTION_LOST');
  w.advance(MINUTE);
  const id = (await w.customer('/api/c/boards', { as: w.ada })).body.boards[0].id;
  const { body } = await w.customer(`/api/c/boards/${id}`, { as: w.ada });
  const seen = body.activity.map((event) => `${event.kind} ${event.what}`);
  assert.ok(seen.includes('firmware changed'), seen.join(', '));
  assert.ok(seen.includes('firmware confirmed'));
  assert.ok(seen.includes('restart restarted'));
  assert.ok(seen.includes('connection disconnected'));
  assert.equal(seen.some((line) => line.startsWith('health')), false, 'memory, channel and names are the console\'s');
  for (const event of body.activity) {
    assert.equal(event.board, id);
    assert.equal(Object.hasOwn(event, 'text'), false);
    assert.equal(Object.hasOwn(event, 'reason'), false);
    assert.equal(Object.hasOwn(event, 'thing'), false);
  }
  const changed = body.activity.find((event) => event.what === 'changed');
  assert.deepEqual([changed.from, changed.version, changed.confirmed], ['1.11.2+0', '1.11.3+0', false]);
  // The overview's list: every board of hers, the last week.
  const overview = await w.customer('/api/c/activity', { as: w.ada });
  assert.ok(overview.body.activity.length >= 4);
  assert.deepEqual((await w.customer('/api/c/activity', { as: w.ben })).body.activity, []);
});

test('an update step names its version, taken from the job, and the job id itself is never passed on', () => {
  const event = {
    at: '2026-11-04T12:00:00.000Z', kind: 'update', what: 'step', state: 'downloading', progress: 40,
    job: 'cranium-1-12-0-b0-20261104T115500Z-0a0a', text: 'Downloading 1.12.0+0', thing: BOARD_A,
  };
  assert.deepEqual(shownEvent(event, 'abc'), {
    at: event.at, board: 'abc', kind: 'update', what: 'step', state: 'downloading', progress: 40, version: '1.12.0+0',
  });
  // The steps after the download say nothing to an owner that the result does not.
  for (const state of ['verifying', 'rebooting', 'testing', 'idle']) assert.equal(shownEvent({ ...event, state }, 'abc'), null);
  assert.equal(shownEvent({ ...event, kind: 'health', what: 'memory' }, 'abc'), null);
  assert.equal(shownEvent(null, 'abc'), null);
});

// The account behind the token, asked of Cognito.

test('a customer switched off stops reading within a minute; one who never set a password cannot read', async () => {
  const w = await world();
  await w.assign(w.ada, BOARD_A);
  assert.equal((await w.customer('/api/c/boards', { as: w.ada })).status, 200);
  assert.equal((await w.console('POST', `/api/customers/${w.ada.sub}/disable`, { as: w.admin })).status, 200);
  // The answer from a moment ago still counts, for at most a minute.
  assert.equal((await w.customer('/api/c/boards', { as: w.ada })).status, 200);
  w.advance(MINUTE);
  const refused = await w.customer('/api/c/boards', { as: w.ada });
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'account_inactive']);
  assert.equal((await w.console('POST', `/api/customers/${w.ada.sub}/enable`, { as: w.admin })).status, 200);
  w.advance(MINUTE);
  assert.equal((await w.customer('/api/c/boards', { as: w.ada })).status, 200);

  const invited = w.addCustomer('cleo', { status: 'FORCE_CHANGE_PASSWORD' });
  assert.equal((await w.customer('/api/c/boards', { as: invited })).status, 403);
  // An account that is gone from the pool is refused like one that is switched off.
  w.store.removeCustomer(w.ben.sub);
  assert.equal((await w.customer('/api/c/boards', { as: w.ben })).status, 403);
});

test('when Cognito cannot be asked and there is no answer from the last minute, the request fails', async () => {
  const w = await world();
  w.store.failNext('getCustomer');
  const failed = await w.customer('/api/c/boards', { as: w.ada });
  assert.deepEqual([failed.status, failed.body.error.code], [503, 'unavailable']);
  assert.ok(w.logs.some((line) => line.event === 'live_check_failed'));
  assert.equal((await w.customer('/api/c/boards', { as: w.ada })).status, 200);
});

// The console's Customers routes.

test('only a release manager sees the customers, and an invitation is on record either way', async () => {
  const w = await world();
  const denied = await w.console('GET', '/api/customers', { as: w.viewer });
  assert.deepEqual([denied.status, denied.body.error.code], [403, 'release_manager_required']);
  const listed = await w.console('GET', '/api/customers', { as: w.admin });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.customers.map((customer) => [customer.email, customer.status]),
    [['ada@example.invalid', 'active'], ['ben@example.invalid', 'active']]);
  assert.equal(listed.body.siteUrl, 'https://customer.example/');

  const byViewer = await w.console('POST', '/api/customers', { as: w.viewer, body: { email: 'dee@example.invalid' } });
  assert.equal(byViewer.status, 403);
  assert.equal(w.store.invitations.length, 0);

  const invited = await w.console('POST', '/api/customers', { as: w.admin, body: { email: ' Dee@Example.INVALID ', name: 'Dee' } });
  assert.equal(invited.status, 201);
  assert.deepEqual([invited.body.customer.email, invited.body.customer.status, invited.body.customer.name],
    ['dee@example.invalid', 'invited', 'Dee']);
  assert.deepEqual(w.store.invitations, [{ email: 'dee@example.invalid', resent: false }]);

  const again = await w.console('POST', '/api/customers', { as: w.admin, body: { email: 'dee@example.invalid' } });
  assert.deepEqual([again.status, again.body.error.code], [409, 'customer_exists']);
  const bad = await w.console('POST', '/api/customers', { as: w.admin, body: { email: 'not an address' } });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'invalid_email']);

  assert.deepEqual(auditOf(w), [
    ['customer.create', 'denied', '', 'release_manager_required'],
    ['customer.create', 'ok', invited.body.customer.id, ''],
    ['customer.create', 'rejected', '', 'customer_exists'],
    ['customer.create', 'rejected', '', 'invalid_email'],
  ]);
  assert.equal(w.fake.auditLog()[1].detail.email, 'dee@example.invalid');
  assert.equal(w.fake.auditLog()[1].actor.email, 'admin@example.invalid');
});

test('an invitation waits for the customer site to have an address, and can be sent again until it is used', async () => {
  const early = await world({ siteUrl: '' });
  const refused = await early.console('POST', '/api/customers', { as: early.admin, body: { email: 'dee@example.invalid' } });
  assert.deepEqual([refused.status, refused.body.error.code], [409, 'customer_site_has_no_address']);
  assert.equal(early.store.invitations.length, 0);

  const w = await world();
  const { body } = await w.console('POST', '/api/customers', { as: w.admin, body: { email: 'dee@example.invalid' } });
  const id = body.customer.id;
  assert.equal((await w.console('POST', `/api/customers/${id}/resend`, { as: w.admin })).status, 200);
  assert.deepEqual(w.store.invitations.map((sent) => sent.resent), [false, true]);
  w.store.confirm(id);
  const used = await w.console('POST', `/api/customers/${id}/resend`, { as: w.admin });
  assert.deepEqual([used.status, used.body.error.code], [409, 'customer_not_invited']);
  assert.deepEqual(auditOf(w).map(([action, outcome]) => `${action} ${outcome}`),
    ['customer.create ok', 'customer.resend ok', 'customer.resend rejected']);
});

test('a board has one owner: assigning is checked, and every assignment and return is on record', async () => {
  const w = await world();
  const path = (customer) => `/api/customers/${customer.sub}/boards`;
  const viewerTry = await w.console('POST', path(w.ada), { as: w.viewer, body: { thing: BOARD_A } });
  assert.equal(viewerTry.status, 403);
  await w.assign(w.ada, BOARD_A, 'Deck');

  const cases = [
    [w.ben, { thing: BOARD_A }, 409, 'board_taken'],
    [w.ada, { thing: BOARD_A }, 409, 'already_assigned'],
    [w.ada, { thing: 'cranium-0000000000000099' }, 404, 'unknown_device'],
    [w.ada, { thing: 'not-a-board' }, 400, 'invalid_thing'],
    [w.ada, { thing: BOARD_B, label: 'x'.repeat(41) }, 400, 'invalid_label'],
    [{ sub: '00000000-0000-4000-8000-00000000abcd' }, { thing: BOARD_B }, 404, 'unknown_customer'],
  ];
  for (const [customer, body, status, code] of cases) {
    const response = await w.console('POST', path(customer), { as: w.admin, body });
    assert.deepEqual([response.status, response.body.error?.code], [status, code], JSON.stringify(body));
  }
  assert.equal((await w.console('POST', '/api/customers/nobody/boards', { as: w.admin, body: { thing: BOARD_B } })).status, 400);

  const notHers = await w.console('POST', `/api/customers/${w.ben.sub}/boards/${BOARD_A}/remove`, { as: w.admin });
  assert.deepEqual([notHers.status, notHers.body.error.code], [404, 'not_assigned']);
  const back = await w.console('POST', `/api/customers/${w.ada.sub}/boards/${BOARD_A}/remove`, { as: w.admin });
  assert.equal(back.status, 200);
  assert.deepEqual(back.body.customer.boards, []);

  const entries = w.fake.auditLog();
  assert.deepEqual(entries.map((entry) => `${entry.action} ${entry.outcome} ${entry.detail.code ?? ''}`.trim()), [
    'customer.assign denied release_manager_required',
    'customer.assign ok',
    'customer.assign rejected board_taken',
    'customer.assign rejected already_assigned',
    'customer.assign rejected unknown_device',
    'customer.assign rejected invalid_thing',
    'customer.assign rejected invalid_label',
    'customer.assign rejected unknown_customer',
    'customer.assign rejected invalid_customer',
    'customer.unassign rejected not_assigned',
    'customer.unassign ok',
  ]);
  const assigned = entries[1];
  assert.deepEqual([assigned.target, assigned.detail.customer, assigned.detail.email, assigned.detail.label],
    [BOARD_A, w.ada.sub, 'ada@example.invalid', 'Deck']);
});

test('switching a customer off and on is on record, and the list says which they are', async () => {
  const w = await world();
  assert.equal((await w.console('POST', `/api/customers/${w.ben.sub}/disable`, { as: w.viewer })).status, 403);
  const off = await w.console('POST', `/api/customers/${w.ben.sub}/disable`, { as: w.admin });
  assert.deepEqual([off.status, off.body.customer.status], [200, 'disabled']);
  assert.equal(w.store.customer(w.ben.sub).enabled, false);
  const listed = (await w.console('GET', '/api/customers', { as: w.admin })).body.customers;
  assert.equal(listed.find((customer) => customer.id === w.ben.sub).status, 'disabled');
  const on = await w.console('POST', `/api/customers/${w.ben.sub}/enable`, { as: w.admin });
  assert.deepEqual([on.status, on.body.customer.status], [200, 'active']);
  // A refusal before the handler runs has no target, as on every route: the entry names who asked.
  assert.deepEqual(auditOf(w).map(([action, outcome, target]) => [action, outcome, target]), [
    ['customer.disable', 'denied', ''],
    ['customer.disable', 'ok', w.ben.sub],
    ['customer.enable', 'ok', w.ben.sub],
  ]);
});

test('an account gone from the pool still shows with its boards, so that they can be taken back', async () => {
  const w = await world();
  await w.assign(w.ben, BOARD_C);
  w.store.removeCustomer(w.ben.sub);
  const listed = (await w.console('GET', '/api/customers', { as: w.admin })).body.customers;
  const gone = listed.find((customer) => customer.id === w.ben.sub);
  assert.deepEqual([gone.status, gone.email, gone.boards.map((board) => board.thing)], ['gone', '', [BOARD_C]]);
  const back = await w.console('POST', `/api/customers/${w.ben.sub}/boards/${BOARD_C}/remove`, { as: w.admin });
  assert.equal(back.status, 200);
  assert.equal(w.store.ownership(BOARD_C).owner, undefined);
});

test('the Customers routes are for the website: an API token or a phone app\'s session is refused', async () => {
  const w = await world();
  const phone = accessClaims({
    sub: w.admin.sub, groups: ['release-managers'], clientId: 'localmobile', authTime: Math.floor(w.clock.ms / 1000),
  });
  const read = await w.console('GET', '/api/customers', { claims: phone });
  assert.deepEqual([read.status, read.body.error.code], [403, 'phone_not_allowed']);
  const made = await w.console('POST', '/api/tokens', { as: w.admin, body: { name: 'script' } });
  assert.equal(made.status, 201);
  const viaToken = await w.consoleApp(apiEvent('GET', '/api/t/customers', { headers: { authorization: `Bearer ${made.body.token}` } }));
  assert.equal(viaToken.statusCode, 403);
  assert.equal(JSON.parse(viaToken.body).error.code, 'token_not_allowed');
});

test('a deployment with no customer pool says so, and changes nothing', async () => {
  const w = createCustomerWorld({ customers: false });
  const admin = w.addStaff('admin', ['release-managers']);
  const listed = await w.console('GET', '/api/customers', { as: admin });
  assert.deepEqual([listed.status, listed.body], [200, { configured: false, siteUrl: '', customers: [] }]);
  const invite = await w.console('POST', '/api/customers', { as: admin, body: { email: 'dee@example.invalid' } });
  assert.deepEqual([invite.status, invite.body.error.code], [409, 'customers_not_set_up']);
});

// Configuration.

test('the customer API needs all of its settings, and the console only the pool and the address', () => {
  const env = {
    AWS_REGION: 'us-east-1', STATE_TABLE: 'local-state', EVENTS_TABLE: 'local-events',
    CUSTOMER_POOL_ID: CUSTOMER_POOL_ID, CUSTOMER_CLIENT_ID: CUSTOMER_CLIENT_ID,
  };
  const config = loadCustomerApiConfig(env);
  assert.equal(config.issuer, `https://cognito-idp.us-east-1.amazonaws.com/${CUSTOMER_POOL_ID}`);
  for (const name of Object.keys(env)) {
    assert.throws(() => loadCustomerApiConfig({ ...env, [name]: '' }), new RegExp(name));
  }
  assert.equal(loadCustomerAdminConfig({}), null);
  assert.deepEqual({ ...loadCustomerAdminConfig({ CUSTOMER_POOL_ID }) }, { customerPoolId: CUSTOMER_POOL_ID, siteUrl: '' });
  assert.equal(loadCustomerAdminConfig({ CUSTOMER_POOL_ID, CUSTOMER_SITE_URL: 'https://cranium.example/' }).siteUrl,
    'https://cranium.example/');
  for (const url of ['http://cranium.example/', 'https://cranium.example', 'https://cranium.example/x', 'javascript:x']) {
    assert.throws(() => loadCustomerAdminConfig({ CUSTOMER_POOL_ID, CUSTOMER_SITE_URL: url }), /CUSTOMER_SITE_URL/);
  }
});

test('the console\'s API takes the customer store beside its own adapter, and names no customer method twice', async () => {
  const fake = createFakeAws();
  const store = createFakeCustomers();
  for (const name of Object.keys(store)) {
    if (typeof store[name] === 'function' && !['failNext', 'addCustomer', 'customer', 'confirm', 'removeCustomer', 'ownership'].includes(name)) {
      assert.equal(Object.hasOwn(fake, name), false, name);
    }
  }
  const app = createApp({
    aws: { ...fake, ...store },
    config: { ...loadConfig(fakeEnv()), customers: { customerPoolId: CUSTOMER_POOL_ID, siteUrl: '' } },
    log: () => {},
  });
  fake.addUser({ sub: '00000000-0000-4000-8000-000000000001', email: 'a@example.invalid', groups: ['release-managers'] });
  const claims = accessClaims({ sub: '00000000-0000-4000-8000-000000000001', groups: ['release-managers'] });
  const response = await app(apiEvent('GET', '/api/customers', { claims }));
  assert.equal(response.statusCode, 200);
});
