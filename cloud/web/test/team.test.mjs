/**
 * Tests for the Team page (docs/accounts.md, team.js) and the Customers page's new status and actions
 * (customers.js): what the client asks the API, the rows and their badges, the search and filters, the guards
 * the page keeps (your own account, the last release manager), the dialogs and the confirm steps, and that no
 * password ever reaches the page. team.js, customers.js and views.js are the very files the browser loads.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE, CUSTOMERS, TEAM, VIEWS, all, click, controls, createDocument, one, textOf } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
const team = await import(TEAM);
const customers = await import(CUSTOMERS);
globalThis.document = createDocument();

const NOW = Date.parse('2026-11-09T18:00:00Z');
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const VIEWER = '00000000-0000-4000-8000-000000000003';
const PENDING = '00000000-0000-4000-8000-000000000004';
const OFF = '00000000-0000-4000-8000-000000000005';

const account = (id, email, changes = {}) => ({
  id,
  email,
  name: '',
  tier: 'viewer',
  enabled: true,
  status: 'confirmed',
  mfa: true,
  createdAt: iso(400),
  lastSignIn: iso(2),
  you: false,
  ...changes,
});

const TEAM_REPLY = {
  you: ME,
  lastSignInFrom: 'activity-log',
  accounts: [
    account(ME, 'me@example.invalid', { tier: 'release-manager', you: true }),
    account(OTHER, 'other@example.invalid', { tier: 'release-manager' }),
    account(VIEWER, 'viewer@example.invalid'),
    account(PENDING, 'pending@example.invalid', { status: 'pending', mfa: false, lastSignIn: null }),
    account(OFF, 'off@example.invalid', { enabled: false }),
  ],
};

function draw(node) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  views.render(root, node);
  return root;
}

const ctx = (filters = {}) => ({
  state: { now: NOW, filters: { team: filters }, me: { canWrite: true } },
  actions: {},
});

/** What app.js hands the page, with dialogs that draw into a box of their own, and a record of the calls. */
function fakeApp(replies = {}) {
  const calls = [];
  const notes = [];
  const box = { node: null, open: false, self: null };
  const api = new Proxy(
    {},
    {
      get:
        (_target, name) =>
        async (...args) => {
          calls.push([name, ...args]);
          if (name === 'team') return replies.team ?? TEAM_REPLY;
          if (Object.hasOwn(replies, name)) {
            const reply = replies[name];
            if (reply instanceof Error) throw reply;
            return reply;
          }
          return {};
        },
    }
  );
  const app = {
    api,
    calls,
    notes,
    box,
    draw() {},
    notify: (text) => notes.push(text),
    async load(resource, read) {
      try {
        resource.value = await read();
        resource.error = null;
      } catch (error) {
        resource.error = error;
      }
    },
    dialogs: {
      isOpen: () => box.open,
      open(build) {
        box.open = true;
        const self = {
          busy: false,
          redraw: () => {
            box.node = draw(build());
          },
          close: () => {
            box.open = false;
          },
        };
        box.self = self;
        self.redraw();
        return self;
      },
      async submit(self, model, task) {
        model.sending = true;
        self.redraw();
        try {
          await task();
        } catch (error) {
          model.error = error;
          model.sending = false;
          self.redraw();
        }
      },
      signIn() {},
    },
  };
  return app;
}

/** Submit the open dialog and wait for its work. */
async function confirmDialog(app) {
  const form = all(app.box.node, 'form')[0];
  form.dispatchEvent({ type: 'submit' });
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

// The client.

test("the client asks the Team page's routes, with no password in any request", async () => {
  const asked = [];
  const api = core.createApi({
    auth: { accessToken: () => 'TOKEN' },
    crypto: globalThis.crypto,
    clock: core.createClock(() => NOW),
    onUnauthorized: () => assert.fail('the token was refused'),
    fetch: async (url, init) => {
      asked.push([init?.method ?? 'GET', String(url), init?.body ? JSON.parse(init.body) : null]);
      return Response.json({});
    },
  });
  await api.team();
  await api.inviteTeamMember({ email: 'new@example.invalid', tier: 'viewer' });
  await api.resendTeamInvitation(PENDING);
  await api.setTeamTier(VIEWER, 'release-manager');
  await api.setTeamEnabled(OFF, true);
  await api.setTeamEnabled(VIEWER, false);
  await api.resetTeamMember(OTHER);
  await api.removeTeamMember(VIEWER);
  await api.resetCustomerPassword(OTHER);
  await api.removeCustomer(OTHER);
  assert.deepEqual(asked, [
    ['GET', '/api/team', null],
    ['POST', '/api/team', { email: 'new@example.invalid', tier: 'viewer' }],
    ['POST', `/api/team/${PENDING}/resend`, {}],
    ['POST', `/api/team/${VIEWER}/tier`, { tier: 'release-manager' }],
    ['POST', `/api/team/${OFF}/enable`, {}],
    ['POST', `/api/team/${VIEWER}/disable`, {}],
    ['POST', `/api/team/${OTHER}/reset`, {}],
    ['POST', `/api/team/${VIEWER}/remove`, {}],
    ['POST', `/api/customers/${OTHER}/reset-password`, {}],
    ['POST', `/api/customers/${OTHER}/remove`, {}],
  ]);
  assert.equal(/password/i.test(JSON.stringify(asked.map(([, , body]) => body))), false);
  await assert.rejects(api.removeTeamMember('../me'));
  await assert.rejects(api.setTeamTier(VIEWER, 'owner'));
  await assert.rejects(api.inviteTeamMember({ email: 'x@example.invalid', tier: 'admin' }));
});

test('the reply is read into known fields only: a stray password never reaches the page', () => {
  const read = team.readTeam({
    you: ME,
    accounts: [
      { ...TEAM_REPLY.accounts[1], password: 'Hunter2-Hunter2!', temporaryPassword: 'x' },
      { id: 'not-an-id', email: 'x' },
      { ...TEAM_REPLY.accounts[2], tier: 'owner', status: 'weird', mfa: 'yes', createdAt: 'yesterday' },
    ],
  });
  assert.equal(read.accounts.length, 2);
  assert.equal(JSON.stringify(read).includes('Hunter2'), false);
  assert.deepEqual(Object.keys(read.accounts[0]).sort(), [
    'createdAt',
    'email',
    'enabled',
    'id',
    'lastSignIn',
    'mfa',
    'name',
    'status',
    'tier',
    'you',
  ]);
  assert.deepEqual(
    [read.accounts[1].tier, read.accounts[1].status, read.accounts[1].mfa, read.accounts[1].createdAt],
    ['none', 'other', null, null]
  );
  assert.throws(() => team.readTeam({}), /could not read/);
});

// The page.

test('the Team page lists every account with its tier, state, authenticator, when added and last sign-in', async () => {
  const app = fakeApp();
  team.connect(app);
  await team.refresh();
  const root = draw(team.teamView(ctx()));
  assert.match(textOf(one(root, 'h1', 'Team')), /Team/);
  const rows = all(root, 'li.team-account');
  assert.equal(rows.length, 5);
  assert.match(textOf(rows[0]), /me@example\.invalid.*You.*Release manager.*Active.*Authenticator/);
  assert.match(textOf(rows[0]), /Your own account: another release manager changes it\./);
  // Your own row offers nothing.
  assert.deepEqual(controls(rows[0]), []);
  assert.match(textOf(rows[3]), /pending@example\.invalid.*no sign-in on record.*Viewer.*Invited.*No authenticator/);
  assert.match(textOf(rows[4]), /off@example\.invalid.*Disabled/);
  assert.match(textOf(rows[2]), /last signed in 2 h ago/);
  assert.deepEqual(controls(rows[1]), ['Make viewer', 'Disable', 'Reset password and authenticator', 'Remove']);
  assert.deepEqual(controls(rows[2]), [
    'Make release manager',
    'Disable',
    'Reset password and authenticator',
    'Remove',
  ]);
  assert.deepEqual(controls(rows[3]), ['Send the invitation again', 'Make release manager', 'Disable', 'Remove']);
  assert.deepEqual(controls(rows[4]), ['Make release manager', 'Enable', 'Remove']);
  // The invitation: an address and a tier, never a password field.
  assert.equal(
    all(root, 'input[type=password]').length +
      all(root, 'input').filter((el) => el.getAttribute('type') === 'password').length,
    0
  );
  assert.ok(one(root, 'section', 'Invite a person'));
});

test('search and filters: by words, tier and state, with the shared filter bar', async () => {
  const app = fakeApp();
  team.connect(app);
  await team.refresh();
  const emails = (filters) => all(draw(team.teamView(ctx(filters))), 'span.team-email').map((el) => textOf(el));
  assert.deepEqual(emails({ tier: 'viewer' }), [
    'viewer@example.invalid',
    'pending@example.invalid',
    'off@example.invalid',
  ]);
  assert.deepEqual(emails({ status: 'disabled' }), ['off@example.invalid']);
  assert.deepEqual(emails({ status: 'pending' }), ['pending@example.invalid']);
  assert.deepEqual(emails({ q: 'other' }), ['other@example.invalid']);
  assert.deepEqual(emails({ tier: 'release-manager', status: 'disabled' }), []);
  assert.deepEqual(core.readFilters('team', { tier: 'admin', status: 'pending' }), {
    q: '',
    tier: '',
    status: 'pending',
  });
  assert.match(textOf(draw(team.teamView(ctx({ q: 'nobody' })))), /No accounts match/);
});

test('the last enabled release manager is offered nothing that would leave none', async () => {
  const reply = {
    you: ME,
    accounts: [
      account(ME, 'me@example.invalid', { tier: 'release-manager', you: true }),
      account(OTHER, 'other@example.invalid', { tier: 'release-manager', enabled: false }),
    ],
  };
  const app = fakeApp({ team: reply });
  team.connect(app);
  await team.refresh();
  const accounts = team._internal.listing.value.accounts;
  // From the view of another release manager, the only one who can write is not to be taken away.
  const only = accounts[0];
  assert.equal(team.leavesAReleaseManager(accounts, only), false);
  assert.deepEqual(
    team.actionsFor({ ...only, you: false }, accounts).map(([key]) => key),
    []
  );
  assert.equal(team.leavesAReleaseManager(accounts, accounts[1]), true);
  assert.deepEqual(
    team.actionsFor(accounts[1], accounts).map(([key]) => key),
    ['demote', 'enable', 'remove']
  );
});

test('a destructive change opens a dialog that says what follows; Cancel changes nothing', async () => {
  const app = fakeApp();
  team.connect(app);
  await team.refresh();
  const root = draw(team.teamView(ctx()));
  const row = all(root, 'li.team-account')[2];
  click(one(row, 'button', 'Remove'));
  assert.equal(app.box.open, true);
  const dialog = app.box.node;
  assert.match(textOf(dialog), /Remove viewer@example\.invalid/);
  assert.match(textOf(dialog), /signed out everywhere and their account is deleted.*cannot be undone/);
  assert.deepEqual(controls(dialog), ['Close', 'Cancel', 'Remove']);
  click(one(dialog, 'button', 'Cancel'));
  assert.equal(app.box.open, false);
  assert.equal(
    app.calls.some(([name]) => name === 'removeTeamMember'),
    false
  );
});

test('confirming a dialog makes the change, says so and reads the team again', async () => {
  const app = fakeApp();
  team.connect(app);
  await team.refresh();
  const root = draw(team.teamView(ctx()));
  click(one(all(root, 'li.team-account')[1], 'button', 'Reset password and authenticator'));
  assert.match(textOf(app.box.node), /replaced by a new one with the same tier.*Nobody here sees it/);
  const before = app.calls.filter(([name]) => name === 'team').length;
  await confirmDialog(app);
  assert.deepEqual(
    app.calls.filter(([name]) => name === 'resetTeamMember'),
    [['resetTeamMember', OTHER]]
  );
  assert.equal(app.box.open, false);
  assert.deepEqual(app.notes, ['other@example.invalid gets a new invitation.']);
  assert.equal(app.calls.filter(([name]) => name === 'team').length, before + 1);

  // The tier, the invitation again, disable and enable go the same way.
  for (const [rowIndex, label, call, args] of [
    [2, 'Make release manager', 'setTeamTier', [VIEWER, 'release-manager']],
    [1, 'Make viewer', 'setTeamTier', [OTHER, 'viewer']],
    [3, 'Send the invitation again', 'resendTeamInvitation', [PENDING]],
    [2, 'Disable', 'setTeamEnabled', [VIEWER, false]],
    [4, 'Enable', 'setTeamEnabled', [OFF, true]],
  ]) {
    const page = draw(team.teamView(ctx()));
    click(one(all(page, 'li.team-account')[rowIndex], 'button', label));
    await confirmDialog(app);
    assert.deepEqual(app.calls.at(-2), [call, ...args], label);
  }
});

test("a refusal stays in the dialog, in the server's words, and the dialog stays open", async () => {
  const refusal = new core.ApiError(409, 'last_release_manager', 'This is the only enabled release manager.');
  const app = fakeApp({ removeTeamMember: refusal });
  team.connect(app);
  await team.refresh();
  click(one(all(draw(team.teamView(ctx())), 'li.team-account')[1], 'button', 'Remove'));
  await confirmDialog(app);
  assert.equal(app.box.open, true);
  assert.match(textOf(app.box.node), /Nothing was changed\..*only enabled release manager/);
  assert.equal(core.REFUSAL_WORDS.last_release_manager, 'It would have left no enabled release manager');
  assert.equal(core.REFUSAL_WORDS.own_account, 'Nobody can demote, disable, reset or remove their own account');
});

test('the Team page is in the nav for release managers only', () => {
  const nav = (canWrite) =>
    all(draw(views.navView({ state: { route: { view: 'team' }, me: { canWrite } } })), 'a').map((el) => textOf(el));
  assert.ok(nav(true).includes('Team'));
  assert.equal(nav(false).includes('Team'), false);
  assert.deepEqual(core.parseRoute('#/team'), { view: 'team' });
  assert.deepEqual(core.parseRoute('#/team?tier=viewer'), { view: 'team', query: { tier: 'viewer' } });
});

test('the activity log tells a team change by the address, with the tier before and after', () => {
  const entry = {
    at: iso(1),
    actor: { sub: ME, email: 'me@example.invalid' },
    action: 'account.tier',
    target: VIEWER,
    outcome: 'ok',
    detail: [
      ['email', 'viewer@example.invalid'],
      ['tier', 'release-manager'],
    ],
    changes: [{ field: 'tier', from: 'viewer', to: 'release-manager' }],
    requestId: 'r1',
  };
  assert.equal(core.auditSentence(entry), 'me@example.invalid changed the tier of viewer@example.invalid');
  assert.deepEqual(
    core.describeChanges(entry).rows.map((row) => [row.label, row.from, row.to]),
    [['Tier', 'viewer', 'release-manager']]
  );
  const refused = {
    ...entry,
    action: 'account.remove',
    outcome: 'rejected',
    detail: [['code', 'own_account']],
    changes: [],
  };
  assert.equal(core.auditSentence(refused), 'me@example.invalid tried to remove the account of ' + VIEWER);
  assert.deepEqual(
    core.activityActions('people').filter((action) => action.startsWith('account.')),
    [
      'account.sign_in',
      'account.invite',
      'account.resend',
      'account.tier',
      'account.disable',
      'account.enable',
      'account.reset',
      'account.remove',
    ]
  );
});

// The Customers page.

const CUSTOMER = '7ec17d2e-9ee4-4734-8901-33c8fec73372';
const CUSTOMER_REPLY = {
  configured: true,
  siteUrl: 'https://customer.example/',
  customers: [
    {
      id: CUSTOMER,
      email: 'ada@example.invalid',
      name: 'Ada',
      status: 'active',
      enabled: true,
      confirmed: true,
      mfa: true,
      createdAt: iso(100),
      boards: [],
    },
  ],
};

test('the Customers page shows the authenticator, and asks twice before a reset of the password or a removal', async () => {
  const app = fakeApp({ customers: CUSTOMER_REPLY });
  app.state = { devices: { value: { devices: [] }, error: null, loadedAt: NOW, loading: false } };
  customers.connect(app);
  const listing = customers.resources(app.state)[0];
  listing.value = customers.readCustomers(CUSTOMER_REPLY);
  const page = () =>
    draw(
      customers.customersView({
        state: { now: NOW, filters: { customers: {} }, devices: app.state.devices },
        actions: {},
      })
    );
  let root = page();
  const row = one(root, 'li.customer', 'ada@example.invalid');
  assert.match(textOf(row), /Active.*Authenticator/);
  assert.ok(controls(row).includes('Reset password'));
  assert.ok(controls(row).includes('Remove'));

  click(one(row, 'button', 'Reset password'));
  root = page();
  assert.match(textOf(one(root, 'li.customer')), /ada@example\.invalid gets a code by e-mail/);
  assert.equal(
    app.calls.some(([name]) => name === 'resetCustomerPassword'),
    false
  );
  click(
    all(one(root, 'li.customer'), 'button').find(
      (el) => textOf(el) === 'Reset password' && el.getAttribute('class').includes('is-danger')
    )
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    app.calls.filter(([name]) => name === 'resetCustomerPassword'),
    [['resetCustomerPassword', CUSTOMER]]
  );

  root = page();
  click(one(one(root, 'li.customer'), 'button', 'Remove'));
  root = page();
  assert.match(textOf(one(root, 'li.customer')), /signed out and their account deleted\. This cannot be undone/);
  click(one(one(root, 'li.customer'), 'button', 'Keep'));
  assert.equal(
    app.calls.some(([name]) => name === 'removeCustomer'),
    false
  );
  assert.deepEqual(customers.readCustomers(CUSTOMER_REPLY).customers[0].mfa, true);
  assert.deepEqual(core.readFilters('customers', { status: 'reset' }).status, 'reset');
});

test("the Customers page labels a customer's own name as theirs, without control or direction characters", () => {
  const app = fakeApp({ customers: CUSTOMER_REPLY });
  app.state = { devices: { value: { devices: [] }, error: null, loadedAt: NOW, loading: false } };
  customers.connect(app);
  const listing = customers.resources(app.state)[0];
  const spoof = { ...CUSTOMER_REPLY.customers[0], name: '\u202EAdmin \u2066(staff)\u2069 ' + 'x'.repeat(200) };
  listing.value = customers.readCustomers({ ...CUSTOMER_REPLY, customers: [spoof] });
  const root = draw(
    customers.customersView({
      state: { now: NOW, filters: { customers: {} }, devices: app.state.devices },
      actions: {},
    })
  );
  const meta = textOf(one(root, 'li.customer'));
  assert.match(meta, /customer's name: Admin \(staff\) x+/);
  assert.doesNotMatch(meta, /[‮⁦⁩]/u);
  assert.ok(!meta.includes('x'.repeat(61)));
});

test('in the apps the Team page shows every account, and its changes open the console’s website', async () => {
  const app = fakeApp();
  team.connect(app);
  await team.refresh();
  const opened = [];
  const inApp = {
    state: { now: NOW, filters: { team: {} }, me: { canWrite: true }, app: { ble: true } },
    actions: { openOnWebsite: (view) => opened.push(view) },
  };
  const root = draw(team.teamView(inApp));
  const rows = all(root, 'li.team-account');
  assert.equal(rows.length, 5);
  // No row can change anything here: each offers the website instead.
  assert.deepEqual(controls(rows[1]), ['Change on the website']);
  assert.equal(all(root, 'form.team-invite').length, 0);
  click(one(root, 'button', 'Invite on the website'));
  click(one(rows[1], 'button', 'Change on the website'));
  assert.deepEqual(opened, ['team', 'team']);
});

test('in the apps the Customers page shows each customer, and its changes open the console’s website', async () => {
  const app = fakeApp({ customers: CUSTOMER_REPLY });
  app.state = { devices: { value: { devices: [] }, error: null, loadedAt: NOW, loading: false } };
  customers.connect(app);
  const listing = customers.resources(app.state)[0];
  listing.value = customers.readCustomers(CUSTOMER_REPLY);
  const opened = [];
  const root = draw(
    customers.customersView({
      state: { now: NOW, filters: { customers: {} }, devices: app.state.devices, app: { ble: true } },
      actions: { openOnWebsite: (view) => opened.push(view) },
    })
  );
  const row = one(root, 'li.customer', 'ada@example.invalid');
  assert.match(textOf(row), /Active.*Authenticator/);
  assert.deepEqual(controls(row), ['Change on the website']);
  click(one(row, 'button', 'Change on the website'));
  assert.deepEqual(opened, ['customers']);
  assert.equal(app.calls.length, 0);
});

// Copy rules: a short lede with the rest under "How … works", and no AWS service or doc path outside a Details.
const outsideDetails = (node) =>
  node.nodeType === 3
    ? node.textContent
    : node.localName === 'details'
      ? ' '
      : node.childNodes.map(outsideDetails).join(' ');

test('Team and Customers open with a short lede, say how they work below it, and name no AWS service outside Details', async () => {
  const app = fakeApp({ customers: CUSTOMER_REPLY });
  app.state = { devices: { value: { devices: [] }, error: null, loadedAt: NOW, loading: false } };
  team.connect(app);
  await team.refresh();
  customers.connect(app);
  customers.resources(app.state)[0].value = customers.readCustomers(CUSTOMER_REPLY);
  const pages = [
    draw(team.teamView(ctx())),
    draw(
      customers.customersView({
        state: { now: NOW, filters: { customers: {} }, devices: app.state.devices },
        actions: {},
      })
    ),
  ];
  for (const root of pages) {
    const lede = textOf(one(root, 'p.page-lede'));
    assert.ok(lede.split(' ').length <= 15, lede);
    assert.match(textOf(one(root, 'details.page-how')), /Every change here is in the activity log\./);
    assert.doesNotMatch(outsideDetails(root), /Cognito|DynamoDB|cloud\/deploy\.sh|docs\//);
  }
  assert.match(textOf(pages[0]), /No password is ever shown or set here\./);
  assert.match(textOf(pages[1]), /A customer sees their own boards and nothing else of the fleet\./);
  // Why a reset replaces the account is kept, under Details.
  assert.match(
    textOf(pages[0]),
    /Cognito can neither e-mail a reset code nor forget an authenticator\. See docs\/accounts\.md\./
  );
});
