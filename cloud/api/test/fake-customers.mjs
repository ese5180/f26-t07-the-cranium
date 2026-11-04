// An in-memory stand-in for src/customer/aws.mjs: the customer pool and the ownership records
// (createCustomerStore). The board reader's two methods (getShadow, queryEvents) are those of
// test/fake-aws.mjs, which a test merges in. It keeps to what the console depends on: a sub per
// account, invitations that leave an account waiting for its first password, one owner per
// board and conditional writes for it. It starts empty; what it holds a test put there.
//
//   const customers = createFakeCustomers({ now });
//   customers.addCustomer({ email: 'a@example.invalid' });            // an active account
//   customers.customer(sub);                                           // how it is now
//
// Also: customerClaims and customerEvent (a request as API Gateway hands it to the customer
// API), and createCustomerWorld (both APIs on one set of fakes, as the tests and the preview use
// them). This file is test and preview code. It is never packaged with the function.

import { createHash } from 'node:crypto';

import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { createCustomerApp } from '../src/customer/app.mjs';
import { issuerOf } from '../src/customer/config.mjs';
import { accessClaims, apiEvent, awsError, createFakeAws, fakeEnv } from './fake-aws.mjs';

export const CUSTOMER_POOL_ID = 'us-east-1_customers';
export const CUSTOMER_CLIENT_ID = 'localcustomer';
const OWNERSHIP_PK = 'OWN';

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/** A sub as Cognito makes one: a UUID, here one that is the same on every run. */
function subOf(count) {
  const hex = createHash('sha256').update(`customer ${count}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createFakeCustomers({ now = Date.now } = {}) {
  const accounts = new Map();   // sub -> { sub, email, name, enabled, status, createdAt }
  const owned = new Map();      // thing -> item of the ownership partition
  const faults = new Map();
  const calls = [];
  const invitations = [];       // { email, resent } in the order Cognito would have sent them
  let made = 0;

  const clock = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : value;
  };

  function byEmail(email) {
    return [...accounts.values()].find((account) => account.email === email.toLowerCase()) ?? null;
  }

  const adapter = {
    async listCustomers() {
      return [...accounts.values()].map(copy);
    },
    async getCustomer(sub) {
      return copy(accounts.get(sub) ?? null);
    },
    async inviteCustomer({ email, name }) {
      if (byEmail(email) !== null) return { ok: false, reason: 'exists' };
      made += 1;
      const account = {
        sub: subOf(made), email: email.toLowerCase(), name: name ?? '', enabled: true, status: 'FORCE_CHANGE_PASSWORD',
        createdAt: clock(),
      };
      accounts.set(account.sub, account);
      invitations.push({ email: account.email, resent: false });
      return { ok: true, customer: copy(account) };
    },
    async resendInvitation(email) {
      const account = byEmail(email);
      if (account === null) return { ok: false, reason: 'not_found' };
      if (account.status !== 'FORCE_CHANGE_PASSWORD') return { ok: false, reason: 'not_invited' };
      invitations.push({ email: account.email, resent: true });
      return { ok: true };
    },
    async setCustomerEnabled(sub, enabled) {
      const account = accounts.get(sub);
      if (account === undefined) return { ok: false, reason: 'not_found' };
      account.enabled = enabled === true;
      return { ok: true };
    },
    async listOwnership() {
      return [...owned.values()].filter((item) => typeof item.owner === 'string')
        .map((item) => ({
          thing: item.sk, owner: item.owner, ref: item.ref, label: item.label ?? '',
          assignedAt: item.assignedAt, assignedBy: item.assignedBy,
        }));
    },
    async assignBoard({ thing, owner, ref, label, at, by }) {
      const there = owned.get(thing);
      if (there !== undefined && typeof there.owner === 'string') return { ok: false, reason: 'taken' };
      const item = { pk: OWNERSHIP_PK, sk: thing, owner, ref, assignedAt: at, assignedBy: by };
      if (label) item.label = label;
      owned.set(thing, item);
      return { ok: true };
    },
    async unassignBoard({ thing, owner, at }) {
      const there = owned.get(thing);
      if (there === undefined || there.owner !== owner) return { ok: false, reason: 'not_owner' };
      owned.set(thing, { pk: OWNERSHIP_PK, sk: thing, unassignedAt: at });
      return { ok: true };
    },
  };

  const fake = {};
  for (const [method, run] of Object.entries(adapter)) {
    fake[method] = async (...args) => {
      calls.push({ method, args });
      const queued = faults.get(method);
      if (queued !== undefined && queued.length > 0) throw queued.shift()();
      return run(...args);
    };
  }

  return Object.assign(fake, {
    calls,
    invitations,
    /** Make the next `times` calls of a method throw, as the real adapter would. */
    failNext(method, { times = 1, code = 'failed' } = {}) {
      if (!Object.hasOwn(adapter, method)) throw new TypeError(`No adapter method ${method}`);
      const queued = faults.get(method) ?? [];
      for (let count = 0; count < times; count += 1) queued.push(() => awsError(method, 'InternalErrorException', { code }));
      faults.set(method, queued);
    },
    /** An account as an admin would have made it, already through its first sign-in. */
    addCustomer({ email, name = '', enabled = true, status = 'CONFIRMED', sub } = {}) {
      made += 1;
      const account = { sub: sub ?? subOf(made), email: email.toLowerCase(), name, enabled, status, createdAt: clock() };
      accounts.set(account.sub, account);
      return copy(account);
    },
    /** The account in the pool now, or null. */
    customer(sub) {
      return copy(accounts.get(sub) ?? null);
    },
    /** The account's first sign-in, with its own password: no longer invited. */
    confirm(sub) {
      accounts.get(sub).status = 'CONFIRMED';
    },
    /** The account is deleted from the pool, as an administrator could do in the AWS console. */
    removeCustomer(sub) {
      accounts.delete(sub);
    },
    /** The ownership item of a board, as stored, or undefined. */
    ownership(thing) {
      return copy(owned.get(thing));
    },
  });
}

/** The claims of a customer's access token, as the customer authorizer hands them on. */
export function customerClaims({ sub, clientId = CUSTOMER_CLIENT_ID, poolId = CUSTOMER_POOL_ID, tokenUse = 'access' }) {
  return {
    sub,
    token_use: tokenUse,
    client_id: clientId,
    iss: issuerOf(poolId),
    scope: 'aws.cognito.signin.user.admin',
    username: sub,
    exp: '4102444800',
  };
}

/** A GET to the customer API, as API Gateway builds it once the customer authorizer has passed it. */
export function customerEvent(path, { claims, method = 'GET' } = {}) {
  const event = apiEvent(method, path, {});
  event.routeKey = 'GET /api/c/{proxy+}';
  event.requestContext.routeKey = event.routeKey;
  if (claims !== undefined) event.requestContext.authorizer = { jwt: { claims, scopes: ['aws.cognito.signin.user.admin'] } };
  return event;
}

// A reserved domain that can never receive mail.
const MAIL_DOMAIN = 'example.invalid';

/**
 * The console's API and the customer API on one set of fakes, with a clock moved by hand.
 *
 *   const world = createCustomerWorld();
 *   const admin = world.addStaff('admin', ['release-managers']);
 *   await world.console('POST', '/api/customers', { as: admin, body: { email } });
 *   await world.customer('/api/c/boards', { as: customerSub });
 */
export function createCustomerWorld({
  startMs = Date.UTC(2026, 10, 4, 12, 0, 0), siteUrl = 'https://customer.example/', customers: wired = true,
} = {}) {
  const clock = { ms: startMs };
  const now = () => clock.ms;
  const fake = createFakeAws({ now });
  const store = createFakeCustomers({ now });
  const logs = [];
  let draws = 0;
  const config = Object.freeze({
    ...loadConfig(fakeEnv()),
    customers: wired ? Object.freeze({ customerPoolId: CUSTOMER_POOL_ID, siteUrl }) : null,
  });
  const consoleApp = createApp({
    aws: wired ? { ...fake, ...store } : fake,
    config,
    now,
    log: (line) => logs.push(line),
    randomHex: (count) => {
      draws += 1;
      return createHash('sha256').update(`draw ${draws}`).digest('hex').repeat(4).slice(0, 2 * count);
    },
  });
  const customerConfig = Object.freeze({
    region: 'us-east-1', stateTable: 'local-state', eventsTable: 'local-events',
    customerPoolId: CUSTOMER_POOL_ID, customerClientId: CUSTOMER_CLIENT_ID, issuer: issuerOf(CUSTOMER_POOL_ID),
  });
  const customerApp = createCustomerApp({
    aws: { getShadow: fake.getShadow, queryEvents: fake.queryEvents, ...store },
    config: customerConfig,
    now,
    log: (line) => logs.push(line),
  });
  let people = 0;

  const decoded = (response) => ({ status: response.statusCode, headers: response.headers, body: JSON.parse(response.body) });

  return {
    fake,
    store,
    clock,
    logs,
    config,
    customerConfig,
    consoleApp,
    customerApp,
    advance(ms) {
      clock.ms += ms;
    },
    /** A person of the staff pool: a release manager or a viewer. */
    addStaff(name, groups) {
      people += 1;
      const sub = `00000000-0000-4000-8000-${String(people).padStart(12, '0')}`;
      const email = `${name}@${MAIL_DOMAIN}`;
      fake.addUser({ sub, email, groups });
      return { sub, email, claims: accessClaims({ sub, groups, clientId: config.userPoolClientId }) };
    },
    /** A customer that has signed in already. */
    addCustomer(name, options = {}) {
      const account = store.addCustomer({ email: `${name}@${MAIL_DOMAIN}`, ...options });
      return { ...account, claims: customerClaims({ sub: account.sub }) };
    },
    /** A request to the console's API. */
    async console(method, path, { as, claims, body } = {}) {
      return decoded(await consoleApp(apiEvent(method, path, { claims: claims ?? as?.claims, body })));
    },
    /** A request to the customer API. */
    async customer(path, { as, claims, method } = {}) {
      return decoded(await customerApp(customerEvent(path, { claims: claims ?? as?.claims, method })));
    },
  };
}
