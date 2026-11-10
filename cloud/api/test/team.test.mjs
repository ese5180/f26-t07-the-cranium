// Tests for the Team page's API (src/handlers/team.mjs, docs/accounts.md), against the fake Cognito of
// test/fake-aws.mjs: each action, the guards (your own account, the last release manager), who is refused,
// what goes in the activity log, and that no password is ever in an answer, an entry or a log line.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { anotherReleaseManager, createTeamHandlers, tierOf } from '../src/handlers/team.mjs';
import { accessClaims, createFakeAws, createTestConsole } from './fake-aws.mjs';

function setup() {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  const other = console_.addUser('other', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  const pending = console_.addUser('pending', ['viewers'], { status: 'FORCE_CHANGE_PASSWORD' });
  const entries = () =>
    console_.fake
      .auditLog()
      .filter((item) => item.action.startsWith('account.') && item.action !== 'account.sign_in')
      .map((item) => ({
        action: item.action,
        outcome: item.outcome,
        target: item.target,
        code: item.detail?.code ?? '',
        changes: item.changes ?? [],
      }));
  return { ...console_, manager, other, viewer, pending, entries };
}

const post = (c, path, as, body = {}) => c.call('POST', path, { as, body });

test('the list has every account: tier, enabled, confirmed or pending, the authenticator, created and last sign-in', async () => {
  const c = setup();
  // A sign-in on record, made by the manager's first request.
  await c.call('GET', '/api/me', {
    claims: accessClaims({ sub: c.manager.sub, groups: ['release-managers'], authTime: 1_700_000_000 }),
  });
  const { status, body } = await c.call('GET', '/api/team', { as: c.manager });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.you, c.manager.sub);
  const byEmail = Object.fromEntries(body.accounts.map((account) => [account.email, account]));
  assert.deepEqual(Object.keys(byEmail), [
    'manager@example.invalid',
    'other@example.invalid',
    'pending@example.invalid',
    'viewer@example.invalid',
  ]);
  const me = byEmail['manager@example.invalid'];
  assert.deepEqual(
    [me.tier, me.enabled, me.status, me.mfa, me.you, typeof me.createdAt, typeof me.lastSignIn],
    ['release-manager', true, 'confirmed', true, true, 'string', 'string']
  );
  const waiting = byEmail['pending@example.invalid'];
  assert.deepEqual(
    [waiting.tier, waiting.status, waiting.mfa, waiting.lastSignIn, waiting.you],
    ['viewer', 'pending', false, null, false]
  );
  assert.equal(byEmail['viewer@example.invalid'].tier, 'viewer');
});

test('viewers, API tokens and phone sessions are refused; reads by viewers too', async () => {
  const c = setup();
  assert.equal((await c.call('GET', '/api/team', { as: c.viewer })).status, 403);
  const refused = await post(c, '/api/team', c.viewer, { email: 'new@example.invalid', tier: 'viewer' });
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'release_manager_required']);
  const made = await c.call('POST', '/api/tokens', { as: c.manager, body: { name: 'ci' } });
  assert.equal(made.status, 201);
  const byToken = await c.call('POST', '/api/t/team', {
    token: made.body.token,
    body: { email: 'x@example.invalid', tier: 'viewer' },
  });
  assert.equal(byToken.status, 403);
  assert.equal((await c.call('GET', '/api/t/team', { token: made.body.token })).status, 403);
  const phone = accessClaims({
    sub: c.manager.sub,
    groups: ['release-managers'],
    clientId: c.config.mobileClientId,
    authTime: Math.floor(c.clock.ms / 1000),
  });
  assert.equal((await c.call('GET', '/api/team', { claims: phone })).status, 403);
  // A release manager who lost the tier a moment ago cannot change anything with the old token.
  c.fake.user(c.other.sub).setGroups(['viewers']);
  const stale = await post(c, `/api/team/${c.viewer.sub}/disable`, c.other);
  assert.deepEqual([stale.status, stale.body.error.code], [403, 'release_manager_required']);
  assert.equal(c.fake.user(c.viewer.sub).state().enabled, true);
  assert.equal(c.fake.teamMail.length, 0);
});

test('invite: Cognito e-mails the invitation, the account gets its tier, and the entry says what changed', async () => {
  const c = setup();
  const made = await post(c, '/api/team', c.manager, { email: '  New@Example.invalid ', tier: 'release-manager' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(
    [made.body.account.email, made.body.account.tier, made.body.account.status, made.body.account.mfa],
    ['new@example.invalid', 'release-manager', 'pending', false]
  );
  assert.deepEqual(c.fake.user(made.body.account.id).groups(), ['release-managers']);
  assert.deepEqual(c.fake.teamMail, [{ email: 'new@example.invalid', kind: 'invitation' }]);
  const again = await post(c, '/api/team', c.manager, { email: 'new@example.invalid', tier: 'viewer' });
  assert.deepEqual([again.status, again.body.error.code], [409, 'account_exists']);
  for (const body of [
    { email: 'nope', tier: 'viewer' },
    { email: 'a@example.invalid', tier: 'admin' },
    { email: 'a@example.invalid' },
  ]) {
    assert.equal((await post(c, '/api/team', c.manager, body)).status, 400, JSON.stringify(body));
  }
  const [first] = c.entries();
  assert.deepEqual(first, {
    action: 'account.invite',
    outcome: 'ok',
    target: made.body.account.id,
    code: '',
    changes: [
      { field: 'email', from: null, to: 'new@example.invalid' },
      { field: 'account', from: null, to: 'pending' },
      { field: 'tier', from: null, to: 'release-manager' },
    ],
  });
  assert.equal(c.entries()[1].code, 'account_exists');
});

test('send the invitation again: only while the person has not signed in', async () => {
  const c = setup();
  assert.equal((await post(c, `/api/team/${c.pending.sub}/resend`, c.manager)).status, 200);
  assert.deepEqual(c.fake.teamMail, [{ email: 'pending@example.invalid', kind: 'invitation again' }]);
  const signedIn = await post(c, `/api/team/${c.viewer.sub}/resend`, c.manager);
  assert.deepEqual([signedIn.status, signedIn.body.error.code], [409, 'account_not_invited']);
  const unknown = await post(c, '/api/team/00000000-0000-4000-8000-0000000000ff/resend', c.manager);
  assert.deepEqual([unknown.status, unknown.body.error.code], [404, 'unknown_account']);
  assert.deepEqual((await post(c, '/api/team/not-an-id/resend', c.manager)).body.error.code, 'invalid_account');
});

test('change tier: a viewer up and back, with the new group added before the old one goes', async () => {
  const c = setup();
  const up = await post(c, `/api/team/${c.viewer.sub}/tier`, c.manager, { tier: 'release-manager' });
  assert.equal(up.body.account.tier, 'release-manager');
  assert.deepEqual(c.fake.user(c.viewer.sub).groups(), ['release-managers']);
  const order = c.fake.calls.filter((call) => /TeamMember(To|From)Group/.test(call.method)).map((call) => call.method);
  assert.deepEqual(order, ['addTeamMemberToGroup', 'removeTeamMemberFromGroup']);
  const down = await post(c, `/api/team/${c.viewer.sub}/tier`, c.manager, { tier: 'viewer' });
  assert.equal(down.body.account.tier, 'viewer');
  assert.deepEqual(c.fake.user(c.viewer.sub).groups(), ['viewers']);
  assert.deepEqual(
    c.entries().map((entry) => entry.changes),
    [
      [{ field: 'tier', from: 'viewer', to: 'release-manager' }],
      [{ field: 'tier', from: 'release-manager', to: 'viewer' }],
    ]
  );
  assert.equal((await post(c, `/api/team/${c.viewer.sub}/tier`, c.manager, { tier: 'owner' })).status, 400);
});

test('disable and enable; a disabled account can neither read nor write', async () => {
  const c = setup();
  const off = await post(c, `/api/team/${c.viewer.sub}/disable`, c.manager);
  assert.equal(off.status, 200);
  assert.equal(off.body.account.enabled, false);
  c.advance(61_000);
  assert.equal((await c.call('GET', '/api/devices', { as: c.viewer })).status, 403);
  const on = await post(c, `/api/team/${c.viewer.sub}/enable`, c.manager);
  assert.equal(on.body.account.enabled, true);
  assert.deepEqual(
    c.entries().map((entry) => [entry.action, entry.changes]),
    [
      ['account.disable', [{ field: 'account', from: 'confirmed', to: 'disabled' }]],
      ['account.enable', [{ field: 'account', from: 'disabled', to: 'confirmed' }]],
    ]
  );
});

test('nobody demotes, disables, resets or removes their own account', async () => {
  const c = setup();
  for (const [path, body] of [
    ['tier', { tier: 'viewer' }],
    ['disable', {}],
    ['reset', {}],
    ['remove', {}],
  ]) {
    const response = await post(c, `/api/team/${c.manager.sub}/${path}`, c.manager, body);
    assert.deepEqual([response.status, response.body.error.code], [409, 'own_account'], path);
  }
  assert.deepEqual(c.fake.user(c.manager.sub).groups(), ['release-managers']);
  assert.equal(c.fake.user(c.manager.sub).state().enabled, true);
  assert.deepEqual(
    c.entries().map((entry) => [entry.action, entry.outcome, entry.code]),
    [
      ['account.tier', 'rejected', 'own_account'],
      ['account.disable', 'rejected', 'own_account'],
      ['account.reset', 'rejected', 'own_account'],
      ['account.remove', 'rejected', 'own_account'],
    ]
  );
});

test('there is always an enabled release manager: the rule, and the API keeping to it', async () => {
  const rm = (sub, changes = {}) => ({ sub, enabled: true, status: 'CONFIRMED', tier: 'release-manager', ...changes });
  assert.equal(anotherReleaseManager([rm('a'), rm('b')], 'a'), true);
  assert.equal(anotherReleaseManager([rm('a')], 'a'), false);
  assert.equal(anotherReleaseManager([rm('a'), rm('b', { enabled: false })], 'a'), false);
  assert.equal(anotherReleaseManager([rm('a'), rm('b', { status: 'FORCE_CHANGE_PASSWORD' })], 'a'), false);
  assert.equal(anotherReleaseManager([rm('a'), rm('b', { tier: 'viewer' })], 'a'), false);
  assert.equal(tierOf(['viewers', 'release-managers']), 'release-manager');
  assert.equal(tierOf([]), 'none');

  // Through the API the caller is always a release manager who can write, so the guard is met when Cognito's
  // answer changes between the live check and the count: here the caller was disabled a moment before.
  const fake = createFakeAws({ now: () => Date.UTC(2026, 10, 9) });
  const me = '00000000-0000-4000-8000-0000000000a1';
  const them = '00000000-0000-4000-8000-0000000000a2';
  const viewer = '00000000-0000-4000-8000-0000000000a3';
  fake.addUser({ sub: me, email: 'me@example.invalid', groups: ['release-managers'], enabled: false });
  fake.addUser({ sub: them, email: 'them@example.invalid', groups: ['release-managers'] });
  fake.addUser({ sub: viewer, email: 'v@example.invalid', groups: ['viewers'] });
  const team = createTeamHandlers({ aws: fake, directory: { requireLiveWriter: async () => '' } });
  const run = (name, id, body = {}) =>
    team[name]({
      caller: { sub: me },
      params: { id },
      entry: { target: '', detail: {}, changes: [] },
      json: () => body,
    });
  for (const [name, body] of [
    ['remove', {}],
    ['tier', { tier: 'viewer' }],
    ['disable', {}],
    ['reset', {}],
  ]) {
    await assert.rejects(run(name, them, body), (error) => error.code === 'last_release_manager', name);
  }
  assert.equal(fake.hasUser(them), true);
  assert.deepEqual(fake.user(them).groups(), ['release-managers']);
  assert.equal(fake.user(them).state().enabled, true);
  // A viewer is no release manager: removing one needs nobody else.
  assert.deepEqual((await run('remove', viewer)).body, { removed: viewer });
});

test('reset: the account is replaced with the same tier and a new invitation; a pending or disabled one is not', async () => {
  const c = setup();
  const reset = await post(c, `/api/team/${c.other.sub}/reset`, c.manager);
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  const fresh = reset.body.account;
  assert.notEqual(fresh.id, c.other.sub);
  assert.deepEqual(
    [fresh.email, fresh.tier, fresh.status, fresh.mfa],
    ['other@example.invalid', 'release-manager', 'pending', false]
  );
  assert.equal(c.fake.hasUser(c.other.sub), false);
  assert.deepEqual(c.fake.user(fresh.id).groups(), ['release-managers']);
  assert.deepEqual(c.fake.teamMail, [{ email: 'other@example.invalid', kind: 'invitation' }]);
  // The old session can change nothing.
  const old = await post(c, `/api/team/${c.viewer.sub}/disable`, c.other);
  assert.equal(old.status, 403);
  const [entry] = c.entries();
  assert.deepEqual(entry.changes, [
    { field: 'account', from: 'confirmed', to: 'pending' },
    { field: 'authenticator', from: 'set up', to: 'not set up' },
  ]);
  const waiting = await post(c, `/api/team/${c.pending.sub}/reset`, c.manager);
  assert.deepEqual([waiting.status, waiting.body.error.code], [409, 'account_not_signed_in']);
  c.fake.user(c.viewer.sub).disable();
  const off = await post(c, `/api/team/${c.viewer.sub}/reset`, c.manager);
  assert.deepEqual([off.status, off.body.error.code], [409, 'account_disabled']);
});

test('remove: the account is signed out and deleted, and the entry records it', async () => {
  const c = setup();
  const gone = await post(c, `/api/team/${c.viewer.sub}/remove`, c.manager);
  assert.deepEqual(gone.body, { removed: c.viewer.sub });
  assert.equal(c.fake.hasUser(c.viewer.sub), false);
  const again = await post(c, `/api/team/${c.viewer.sub}/remove`, c.manager);
  assert.deepEqual([again.status, again.body.error.code], [404, 'unknown_account']);
  assert.deepEqual(c.entries()[0].changes, [
    { field: 'account', from: 'confirmed', to: null },
    { field: 'tier', from: 'viewer', to: null },
  ]);
});

test('no password, temporary or otherwise, is ever in an answer, an entry or a log line', async () => {
  const c = setup();
  const answers = [];
  answers.push(
    await post(c, '/api/team', c.manager, { email: 'n@example.invalid', tier: 'viewer', password: 'Hunter2-Hunter2!' })
  );
  answers.push(await post(c, `/api/team/${c.other.sub}/reset`, c.manager));
  answers.push(await post(c, `/api/team/${c.pending.sub}/resend`, c.manager));
  answers.push(await c.call('GET', '/api/team', { as: c.manager }));
  const text = JSON.stringify([answers.map((answer) => answer.body), c.fake.auditLog(), c.logs]);
  assert.equal(/Hunter2/.test(text), false);
  assert.equal(/password"\s*:/i.test(text), false);
  assert.equal(/temporaryPassword|TemporaryPassword/.test(text), false);
  // And Cognito is never asked to set one.
  assert.equal(
    c.fake.calls.some((call) => JSON.stringify(call.args).includes('Hunter2')),
    false
  );
});
