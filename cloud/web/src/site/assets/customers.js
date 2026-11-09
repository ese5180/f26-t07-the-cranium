/**
 * The console's Customers page (docs/customer-site.md): the people who sign in to the customer
 * site, and which boards are theirs. For release managers: the API refuses anybody else, and the
 * console's nav leaves the page out for a viewer.
 *
 * What a release manager does here, each of it in the activity log (customer.*):
 *
 *   invite a customer      Cognito makes the account in the customer pool and e-mails the
 *                          invitation, with a temporary password nobody here sees
 *   send it again          while the customer has not signed in yet
 *   give a board           to one customer; a board has one owner at most
 *   take it back           the customer no longer sees it, and a link they kept leads nowhere
 *   switch an account off  the customer cannot sign in, and stops reading within a minute
 *
 * The page's script is fetched when the page is opened (app.js), and draws with views.js.
 */

import { ApiError, boardName, boardOf, dateAndTime, exactTime, isCustomerId, isThing, timeAgo } from './core.js';
import {
  badge,
  boardLabel,
  button,
  card,
  empty,
  failure,
  filterBar,
  filterSelect,
  filtered,
  h,
  icon,
  loadProblem,
  loading,
  mono,
  notice,
  pageHead,
} from './views.js';

let app = null;

function resource() {
  return { value: null, error: null, loadedAt: 0, loading: false };
}

const listing = resource();
const invite = { email: '', name: '', busy: false, error: null };
// Per customer: the board and the name chosen for it, and an action under way or failed.
const rows = new Map();
// The one change that waits for a second press: "<action> <customer id> [<thing>]".
let confirming = null;

/** Hand the page what it needs from app.js. */
export function connect(given) {
  app = given;
}

export function resources(state) {
  return [listing, state.devices];
}

/** Hold the refresh while something is being typed or sent. */
export function holdStill() {
  return (
    invite.busy ||
    invite.email !== '' ||
    [...rows.values()].some((row) => row.busy || row.thing !== '') ||
    confirming !== null
  );
}

// Reading the reply into known shapes.

const STATUSES = ['invited', 'active', 'disabled', 'gone', 'other'];
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const text = (value, limit) => (typeof value === 'string' ? value.replace(/[\p{C}]/gu, '').slice(0, limit) : '');

function readCustomer(raw) {
  if (raw === null || typeof raw !== 'object' || !isCustomerId(raw.id)) return null;
  return {
    id: raw.id,
    email: text(raw.email, 320),
    name: text(raw.name, 60),
    status: STATUSES.includes(raw.status) ? raw.status : 'other',
    createdAt: typeof raw.createdAt === 'string' && TIME.test(raw.createdAt) ? raw.createdAt : null,
    boards: (Array.isArray(raw.boards) ? raw.boards : [])
      .filter((board) => isThing(board?.thing))
      .map((board) => ({
        thing: board.thing,
        label: text(board.label, 40),
        assignedAt: typeof board.assignedAt === 'string' && TIME.test(board.assignedAt) ? board.assignedAt : null,
      })),
  };
}

export function readCustomers(body) {
  if (body === null || typeof body !== 'object' || !Array.isArray(body.customers)) {
    throw new ApiError(0, 'unreadable', 'The server sent a reply the console could not read.');
  }
  return {
    configured: body.configured === true,
    // https when deployed; the local preview's own address is http.
    siteUrl: typeof body.siteUrl === 'string' && /^https?:\/\/[^\s/?#]+\/$/.test(body.siteUrl) ? body.siteUrl : '',
    customers: body.customers.map(readCustomer).filter((customer) => customer !== null),
  };
}

export async function refresh(full) {
  const { state, api, load } = app;
  await Promise.all([
    load(listing, async () => readCustomers(await api.customers())),
    full || state.devices.loadedAt === 0 ? load(state.devices, api.devices) : null,
  ]);
}

// Changes.

function rowOf(id) {
  if (!rows.has(id)) rows.set(id, { thing: '', label: '', busy: false, error: null, done: null });
  return rows.get(id);
}

async function act(id, work, done) {
  const row = rowOf(id);
  row.busy = true;
  row.error = null;
  row.done = null;
  confirming = null;
  app.draw();
  try {
    await work();
    row.done = done;
    app.notify(done);
  } catch (error) {
    row.error = error;
  } finally {
    row.busy = false;
    await app.load(listing, async () => readCustomers(await app.api.customers()));
  }
}

async function sendInvite() {
  if (invite.busy) return;
  invite.busy = true;
  invite.error = null;
  app.draw();
  try {
    const reply = await app.api.inviteCustomer({ email: invite.email.trim(), name: invite.name.trim() });
    const email = text(reply?.customer?.email, 320) || invite.email.trim();
    invite.email = '';
    invite.name = '';
    app.notify(`Invited ${email}. Cognito e-mails the invitation, with a temporary password.`);
  } catch (error) {
    invite.error = error;
  } finally {
    invite.busy = false;
    await app.load(listing, async () => readCustomers(await app.api.customers()));
  }
}

function ask(key) {
  confirming = key;
  app.draw();
}

// Drawing.

const STATUS_BADGES = {
  invited: ['warn', 'clock', 'Invited', 'Has not signed in yet'],
  active: ['good', 'check', 'Active', 'Has signed in with their own password'],
  disabled: ['idle', 'ban', 'Switched off', 'Cannot sign in'],
  gone: ['bad', 'alert', 'Account gone', 'Not in the customer pool any more: take its boards back'],
  other: ['idle', 'minus', 'Other state', 'Cognito reports another state'],
};

function statusBadge(status) {
  const [tone, iconName, label, title] = STATUS_BADGES[status] ?? STATUS_BADGES.other;
  return badge(tone, iconName, label, title);
}

function inviteCard(ctx, data) {
  const noAddress = data.siteUrl === '';
  return card(
    { key: 'invite', title: 'Invite a customer' },
    h(
      'form',
      {
        class: 'customer-invite',
        novalidate: true,
        'aria-busy': invite.busy ? 'true' : null,
        onSubmit(event) {
          event.preventDefault();
          sendInvite();
        },
      },
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label' }, 'E-mail address'),
        h('input', {
          class: 'input',
          id: 'customer-email',
          type: 'email',
          autocomplete: 'off',
          inputmode: 'email',
          autocapitalize: 'off',
          spellcheck: 'false',
          value: invite.email,
          readonly: invite.busy,
          onInput: (event) => {
            invite.email = event.target.value;
          },
        })
      ),
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label' }, 'Name ', h('span', { class: 'quiet' }, '(optional)')),
        h('input', {
          class: 'input',
          id: 'customer-name',
          type: 'text',
          autocomplete: 'off',
          maxlength: '60',
          value: invite.name,
          readonly: invite.busy,
          onInput: (event) => {
            invite.name = event.target.value;
          },
        })
      ),
      h(
        'div',
        { class: 'button-row' },
        h(
          'button',
          {
            type: 'submit',
            class: 'btn is-primary',
            'aria-disabled': invite.busy || noAddress ? 'true' : null,
          },
          invite.busy ? 'Inviting…' : 'Invite'
        )
      )
    ),
    h(
      'p',
      { class: 'card-note' },
      noAddress
        ? 'Invitations wait for the customer site to have an address (CustomerDomainName): an invitation names it.'
        : [
            'Cognito e-mails the invitation with a temporary password, which works for 7 days. The customer signs in at ',
            h('a', { href: data.siteUrl }, data.siteUrl),
            '.',
          ]
    ),
    invite.error ? failure('Nobody was invited.', invite.error) : null
  );
}

/** The boards nobody has, for the list of boards to give. */
function freeBoards(ctx, customers) {
  const owned = new Set(customers.flatMap((customer) => customer.boards.map((board) => board.thing)));
  return (ctx.state.devices.value?.devices ?? []).filter((device) => !owned.has(device.thing));
}

function assignForm(customer, free) {
  const row = rowOf(customer.id);
  if (free.length === 0) return h('p', { class: 'card-note' }, 'Every board has a customer already.');
  return h(
    'form',
    {
      class: 'customer-assign',
      novalidate: true,
      onSubmit(event) {
        event.preventDefault();
        if (row.busy || !isThing(row.thing)) return;
        const { thing, label } = row;
        act(
          customer.id,
          async () => {
            await app.api.assignBoard(customer.id, { thing, label: label.trim() });
            row.thing = '';
            row.label = '';
          },
          `${boardName(boardOf(thing, free))} is ${customer.email || 'the customer'}'s now.`
        );
      },
    },
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label' }, 'Give a board'),
      h(
        'select',
        {
          class: 'input',
          value: row.thing,
          onChange: (event) => {
            row.thing = event.target.value;
            app.draw();
          },
        },
        h('option', { value: '' }, 'Choose a board…'),
        free.map((device) => h('option', { key: device.thing, value: device.thing }, boardName(device, { full: true })))
      )
    ),
    h(
      'label',
      { class: 'field' },
      h(
        'span',
        { class: 'field-label' },
        'Called ',
        h('span', { class: 'quiet' }, '(optional, what the customer sees)')
      ),
      h('input', {
        class: 'input',
        type: 'text',
        maxlength: '40',
        value: row.label,
        autocomplete: 'off',
        onInput: (event) => {
          row.label = event.target.value;
        },
      })
    ),
    h(
      'div',
      { class: 'button-row' },
      h(
        'button',
        { type: 'submit', class: 'btn', 'aria-disabled': row.busy || !isThing(row.thing) ? 'true' : null },
        icon('plus'),
        row.busy ? 'Giving…' : 'Give board'
      )
    )
  );
}

function boardItem(customer, board, devices) {
  const key = `remove ${customer.id} ${board.thing}`;
  const known = boardOf(board.thing, devices);
  return h(
    'li',
    { class: 'customer-board', key: board.thing },
    h(
      'span',
      { class: 'customer-board-name' },
      boardLabel(known),
      board.label ? h('span', { class: 'quiet' }, ` · called “${board.label}”`) : null
    ),
    h(
      'span',
      { class: 'customer-board-since quiet' },
      board.assignedAt ? `since ${dateAndTime(board.assignedAt)}` : ''
    ),
    confirming === key
      ? h(
          'span',
          { class: 'button-row' },
          button(
            'is-small is-danger',
            () =>
              act(
                customer.id,
                () => app.api.unassignBoard(customer.id, board.thing),
                `${boardName(known)} is taken back.`
              ),
            'Take it back'
          ),
          button('is-small is-quiet', () => ask(null), 'Keep')
        )
      : button('is-small', () => ask(key), icon('undo'), 'Take back')
  );
}

function customerRow(ctx, customer, free) {
  const row = rowOf(customer.id);
  const devices = ctx.state.devices.value?.devices ?? [];
  const off = `disable ${customer.id}`;
  const name = customer.email || customer.name || 'This account';
  return h(
    'li',
    { class: 'customer', key: customer.id },
    h(
      'div',
      { class: 'customer-head' },
      h(
        'div',
        { class: 'customer-who' },
        h(
          'span',
          { class: 'customer-email' },
          customer.email || h('span', { class: 'quiet' }, 'No address: the account is gone')
        ),
        h(
          'span',
          { class: 'customer-meta quiet' },
          customer.name ? `${customer.name} · ` : '',
          customer.createdAt
            ? h(
                'time',
                { datetime: customer.createdAt, title: exactTime(customer.createdAt) },
                `invited ${timeAgo(customer.createdAt, ctx.state.now)}`
              )
            : '',
          ' · ',
          mono(customer.id, 'customer-id')
        )
      ),
      statusBadge(customer.status)
    ),
    h(
      'ul',
      { class: 'customer-boards' },
      customer.boards.length === 0
        ? h('li', { class: 'quiet' }, 'No boards yet.')
        : customer.boards.map((board) => boardItem(customer, board, devices))
    ),
    customer.status === 'gone' ? null : assignForm(customer, free),
    h(
      'div',
      { class: 'button-row customer-actions' },
      customer.status === 'invited'
        ? button(
            'is-small',
            () =>
              act(customer.id, () => app.api.resendInvitation(customer.id), `The invitation to ${name} is sent again.`),
            icon('send'),
            'Send the invitation again'
          )
        : null,
      customer.status === 'disabled'
        ? button(
            'is-small',
            () => act(customer.id, () => app.api.setCustomerEnabled(customer.id, true), `${name} can sign in again.`),
            icon('check'),
            'Switch on'
          )
        : null,
      customer.status === 'active' || customer.status === 'invited'
        ? confirming === off
          ? [
              h(
                'span',
                { class: 'card-note', key: 'ask' },
                `${name} will not be able to sign in, and stops seeing their boards within a minute.`
              ),
              button(
                'is-small is-danger',
                () =>
                  act(customer.id, () => app.api.setCustomerEnabled(customer.id, false), `${name} is switched off.`),
                'Switch off'
              ),
              button('is-small is-quiet', () => ask(null), 'Keep'),
            ]
          : button('is-small', () => ask(off), icon('ban'), 'Switch off')
        : null
    ),
    row.error ? failure('That did not change.', row.error) : null
  );
}

export function customersView(ctx) {
  const data = listing.value;
  const head = pageHead({
    title: 'Customers',
    lede:
      'The people who sign in to the customer site, and the boards that are theirs. A customer sees their own boards ' +
      'and nothing else of the fleet. Every change here is in the activity log.',
    tools: data?.siteUrl
      ? h('a', { class: 'btn is-small', href: data.siteUrl }, 'Open the customer site', icon('arrow-right'))
      : null,
  });
  if (data === null) {
    return h(
      'div',
      { class: 'page customers-page', key: 'page' },
      head,
      loadProblem(listing, 'the customers', ctx),
      listing.error ? null : loading('the customers')
    );
  }
  if (!data.configured) {
    return h(
      'div',
      { class: 'page customers-page', key: 'page' },
      head,
      notice(
        'warn',
        'alert',
        'This deployment has no customer pool, so it has no customers. Deploying the stack again sets it up (docs/customer-site.md).'
      )
    );
  }
  const free = freeBoards(ctx, data.customers);
  // The search and filters (docs/search-filters.md): by address, name, a board or its label, and status.
  const devices = ctx.state.devices?.value?.devices ?? [];
  const shown = filtered(ctx, 'customers', data.customers, {
    words: (customer) => [
      customer.email,
      customer.name,
      ...customer.boards.flatMap((board) => [board.thing, board.label, boardName(boardOf(board.thing, devices))]),
    ],
    keep: (customer, filters) => filters.status === '' || customer.status === filters.status,
  });
  return h(
    'div',
    { class: 'page customers-page', key: 'page' },
    head,
    loadProblem(listing, 'the customers', ctx),
    data.siteUrl === ''
      ? h(
          'div',
          { class: 'page-notice' },
          notice('warn', 'alert', [
            h('strong', null, 'The customer site has no address yet. '),
            'Boards can be given out already; invitations wait until CustomerDomainName is set.',
          ])
        )
      : null,
    h(
      'div',
      { class: 'customers-layout' },
      card(
        { key: 'list', title: `${data.customers.length === 1 ? '1 customer' : `${data.customers.length} customers`}` },
        data.customers.length === 0
          ? empty({
              iconName: 'user',
              title: 'No customers yet.',
              text: 'Invite the first one: they get an e-mail with a temporary password.',
            })
          : [
              filterBar(ctx, 'customers', {
                label: 'customers',
                placeholder: 'Search by e-mail, name or board',
                shown: shown.length,
                total: data.customers.length,
                controls: [
                  filterSelect(ctx, 'customers', {
                    name: 'status',
                    label: 'Status',
                    all: 'Any status',
                    options: [
                      ['invited', 'Invited'],
                      ['active', 'Active'],
                      ['disabled', 'Disabled'],
                      ['gone', 'Gone'],
                    ],
                  }),
                ],
              }),
              shown.length === 0
                ? h('p', { class: 'quiet filter-none', key: 'none' }, 'No customers match. Try other words, or Clear.')
                : h(
                    'ul',
                    { class: 'customers', key: 'rows' },
                    shown.map((customer) => customerRow(ctx, customer, free))
                  ),
            ]
      ),
      h(
        'div',
        { class: 'customers-side' },
        inviteCard(ctx, data),
        card(
          { key: 'free', title: 'Boards nobody has' },
          free.length === 0
            ? h('p', { class: 'card-note' }, 'None: every board has a customer.')
            : h(
                'ul',
                { class: 'customers-free' },
                free.map((device) => h('li', { key: device.thing }, boardLabel(device)))
              )
        )
      )
    )
  );
}
