/**
 * Customers: the console's Customers page (docs/customer-site.md). Release managers only, for
 * reading as for changing: a customer's e-mail address and boards are not for viewers. Every
 * change goes on record in the activity log, as every write does (app.mjs).
 *
 *   GET  /api/customers                               -> { configured, siteUrl, customers: [Customer] }
 *   POST /api/customers { email, name? }              -> 201 { customer }       customer.create
 *        Cognito makes the account in the customer pool and e-mails the invitation, with a
 *        temporary password that nobody here sees
 *   POST /api/customers/{id}/resend                   -> { customer }           customer.resend
 *   POST /api/customers/{id}/boards { thing, label? } -> { customer }           customer.assign
 *   POST /api/customers/{id}/boards/{thing}/remove    -> { customer }           customer.unassign
 *   POST /api/customers/{id}/disable                  -> { customer }           customer.disable
 *   POST /api/customers/{id}/enable                   -> { customer }           customer.enable
 *
 * Customer: { id, email, name, status, createdAt, boards: [{ thing, label, assignedAt }] }, with
 * status invited (has not signed in yet), active, disabled or gone (boards are still assigned to
 * an account that is no longer in the pool, so that they can be taken back).
 *
 * A board has one owner at most. Assigning it gives it a new id for its owner (customer/boards.mjs),
 * so a link that an earlier owner kept leads nowhere.
 */

import { badRequest, conflict, field, notFound } from '../http.mjs';
import { LABEL_LIMIT, REF } from '../customer/boards.mjs';
import { requireText, requireThing } from '../lib/validate.mjs';

// A Cognito sub.
const CUSTOMER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Enough to refuse what is plainly not an address; Cognito decides the rest.
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;
const NAME_LIMIT = 60;

const STATUS = Object.freeze({ FORCE_CHANGE_PASSWORD: 'invited', CONFIRMED: 'active' });

function requireCustomerId(value) {
  if (typeof value !== 'string' || !CUSTOMER_ID.test(value)) {
    throw badRequest('invalid_customer', 'That is not the id of a customer.');
  }
  return value;
}

function requireEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL.test(email) || /[\p{C}]/u.test(email)) {
    throw badRequest('invalid_email', 'Give the customer\'s e-mail address, such as name@example.com.');
  }
  return email;
}

function statusOf(customer) {
  if (customer === null) return 'gone';
  if (!customer.enabled) return 'disabled';
  return STATUS[customer.status] ?? 'other';
}

function view(customer, boards, id = customer?.sub) {
  return {
    id,
    email: customer?.email ?? '',
    name: customer?.name ?? '',
    status: statusOf(customer),
    createdAt: Number.isFinite(customer?.createdAt) ? new Date(customer.createdAt).toISOString() : null,
    boards: boards.filter((item) => item.owner === id)
      .map(({ thing, label, assignedAt }) => ({ thing, label, assignedAt }))
      .sort((a, b) => (a.thing < b.thing ? -1 : 1)),
  };
}

export function createCustomerHandlers({ aws, config, now, randomHex, directory }, { devices }) {
  const settings = config.customers ?? null;
  const iso = () => new Date(now()).toISOString();

  function requireSetUp() {
    if (settings === null) {
      throw conflict('customers_not_set_up', 'This deployment has no customer site, so it has no customers either.');
    }
  }

  /** The customer, as Cognito has them now, or 404. */
  async function existing(id, entry) {
    const customer = await aws.getCustomer(id);
    if (customer === null) throw notFound('unknown_customer', 'There is no customer with this id.');
    entry.detail.email = customer.email;
    return customer;
  }

  async function current(customer) {
    return view(customer, await aws.listOwnership());
  }

  /** A fresh id for a board's assignment: 16 hex digits from the CSPRNG. */
  function newRef() {
    const ref = String(randomHex(8)).slice(0, 16);
    if (!REF.test(ref)) throw new Error('randomHex did not give 16 hex digits');
    return ref;
  }

  /** Switch a customer's account off, or on again. */
  async function switchTo(enabled, params, entry) {
    requireSetUp();
    const id = requireCustomerId(params.id);
    entry.target = id;
    const customer = await existing(id, entry);
    const result = await aws.setCustomerEnabled(id, enabled);
    if (!result.ok) throw notFound('unknown_customer', 'There is no customer with this id.');
    return { body: { customer: await current({ ...customer, enabled }) } };
  }

  return {
    async list({ caller }) {
      // A read, and still for release managers only, asked of Cognito now.
      await directory.requireLiveWriter(caller);
      if (settings === null) return { body: { configured: false, siteUrl: '', customers: [] } };
      const [customers, ownership] = await Promise.all([aws.listCustomers(), aws.listOwnership()]);
      const known = new Set(customers.map((customer) => customer.sub));
      const gone = [...new Set(ownership.map((item) => item.owner).filter((owner) => !known.has(owner)))];
      return {
        body: {
          configured: true,
          siteUrl: settings.siteUrl,
          customers: [
            ...customers.map((customer) => view(customer, ownership)),
            ...gone.map((owner) => view(null, ownership, owner)),
          ].sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : a.id < b.id ? -1 : 1)),
        },
      };
    },

    async create({ entry, json }) {
      requireSetUp();
      const body = json();
      const email = requireEmail(field(body, 'email'));
      entry.detail.email = email;
      const name = requireText(field(body, 'name'), 'name', { max: NAME_LIMIT });
      if (settings.siteUrl === '') {
        throw conflict('customer_site_has_no_address', 'The customer site has no address yet, so an invitation ' +
          'would lead nowhere. Set CustomerDomainName first (docs/customer-site.md).');
      }
      const result = await aws.inviteCustomer({ email, name });
      if (!result.ok) throw conflict('customer_exists', 'There is a customer with this e-mail address already.');
      entry.target = result.customer.sub;
      return { status: 201, body: { customer: view(result.customer, []) } };
    },

    async resend({ params, entry }) {
      requireSetUp();
      const id = requireCustomerId(params.id);
      entry.target = id;
      const customer = await existing(id, entry);
      if (customer.status !== 'FORCE_CHANGE_PASSWORD') {
        throw conflict('customer_not_invited', 'This customer has signed in already: there is no invitation to send again.');
      }
      if (settings.siteUrl === '') {
        throw conflict('customer_site_has_no_address', 'The customer site has no address yet.');
      }
      const result = await aws.resendInvitation(customer.email);
      if (!result.ok && result.reason === 'not_found') throw notFound('unknown_customer', 'There is no customer with this id.');
      if (!result.ok) throw conflict('customer_not_invited', 'This customer has signed in already.');
      return { body: { customer: await current(customer) } };
    },

    async assign({ params, actor, entry, json }) {
      requireSetUp();
      const id = requireCustomerId(params.id);
      entry.detail.customer = id;
      const body = json();
      const thing = requireThing(field(body, 'thing'));
      entry.target = thing;
      const label = requireText(field(body, 'label'), 'label', { max: LABEL_LIMIT });
      if (label) entry.detail.label = label;
      const customer = await existing(id, entry);
      if (!(await devices.groupThings()).includes(thing)) {
        throw notFound('unknown_device', 'No board with that name is registered.');
      }
      const owner = (await aws.listOwnership()).find((item) => item.thing === thing)?.owner;
      if (owner === id) throw conflict('already_assigned', 'This board is this customer\'s already.');
      if (owner !== undefined) {
        throw conflict('board_taken', 'This board belongs to another customer. Take it back from them first.');
      }
      const result = await aws.assignBoard({ thing, owner: id, ref: newRef(), label, at: iso(), by: actor.sub });
      if (!result.ok) throw conflict('board_taken', 'This board was given to another customer a moment ago.');
      return { body: { customer: await current(customer) } };
    },

    async unassign({ params, entry }) {
      requireSetUp();
      const id = requireCustomerId(params.id);
      entry.detail.customer = id;
      const thing = requireThing(params.thing);
      entry.target = thing;
      // An account that is gone from the pool can still have its boards taken back.
      const customer = await aws.getCustomer(id);
      if (customer !== null) entry.detail.email = customer.email;
      const result = await aws.unassignBoard({ thing, owner: id, at: iso() });
      if (!result.ok) throw notFound('not_assigned', 'This board is not this customer\'s.');
      return { body: { customer: view(customer, await aws.listOwnership(), id) } };
    },

    async disable({ params, entry }) {
      return switchTo(false, params, entry);
    },

    async enable({ params, entry }) {
      return switchTo(true, params, entry);
    },
  };
}
