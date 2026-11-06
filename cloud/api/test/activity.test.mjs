// Tests for the two entries of the activity log that are not a change made through the API:
// a sign-in (account.sign_in, recorded by src/app.mjs) and a command that changed a board at its
// serial console (serial.command, posted to src/handlers/serial.mjs by the page that sent it).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApp } from '../src/app.mjs';
import { SERIAL_COMMANDS, SERIAL_PER_MINUTE } from '../src/handlers/serial.mjs';
import { entryFromItem, signInRequestId } from '../src/lib/audit.mjs';
import { accessClaims, apiEvent, createTestConsole, manualTimers } from './fake-aws.mjs';

const START = Date.UTC(2026, 10, 3, 9, 0, 0);
const SIGNED_IN = Math.floor(START / 1000) - 120;

function setup(options = {}) {
  const console_ = createTestConsole({ startMs: START, ...options });
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  const session = (user, { authTime = SIGNED_IN, client = console_.config.userPoolClientId, exp = 4102444800 } = {}) =>
    accessClaims({
      sub: user.sub,
      groups: user === viewer ? ['viewers'] : ['release-managers'],
      clientId: client,
      authTime,
      exp,
    });
  const signIns = () => console_.fake.auditLog().filter((entry) => entry.action === 'account.sign_in');
  const changes = () => console_.fake.auditLog().filter((entry) => entry.action !== 'account.sign_in');
  return { ...console_, manager, viewer, session, signIns, changes };
}

// Sign-ins.

test('the first request of a sign-in records it, once, with who, when, and whether it was the website or the phone app', async () => {
  const { call, fake, logs, manager, viewer, session, signIns, config } = setup();
  for (const path of ['/api/me', '/api/firmware', '/api/me']) {
    assert.equal((await call('GET', path, { claims: session(manager) })).status, 200, path);
  }
  const [entry] = signIns();
  assert.equal(signIns().length, 1);
  const iso = new Date(SIGNED_IN * 1000).toISOString();
  assert.deepEqual(entry, {
    pk: 'AUD',
    sk: `${iso}#signin.${manager.sub}.web.${SIGNED_IN}`,
    at: iso,
    requestId: `signin.${manager.sub}.web.${SIGNED_IN}`,
    actor: { sub: manager.sub, email: manager.email },
    action: 'account.sign_in',
    target: '',
    outcome: 'ok',
    detail: { client: 'web' },
  });
  // It is an entry like any other: listed, and its digest in the log.
  assert.deepEqual(entryFromItem(entry).at, iso);
  assert.equal(logs.filter((line) => line.event === 'audit_entry' && line.action === 'account.sign_in').length, 1);
  assert.equal(fake.calls.filter((call_) => call_.method === 'putAudit').length, 1);

  // A refreshed token keeps the time of its sign-in: the same sign-in, not a new one.
  await call('GET', '/api/me', { claims: session(manager, { exp: 4102444900 }) });
  assert.equal(signIns().length, 1);
  // Signing in again is a new one; so are the phone app's and another person's.
  await call('GET', '/api/me', { claims: session(manager, { authTime: SIGNED_IN + 3600 }) });
  await call('GET', '/api/me', { claims: session(manager, { client: config.mobileClientId }) });
  await call('GET', '/api/devices', { claims: session(viewer) });
  assert.deepEqual(
    signIns().map((item) => [item.actor.email, item.detail.client, item.at]),
    [
      [manager.email, 'phone', iso],
      [manager.email, 'web', iso],
      [viewer.email, 'web', iso],
      [manager.email, 'web', new Date((SIGNED_IN + 3600) * 1000).toISOString()],
    ].sort((a, b) => (a[2] === b[2] ? 0 : a[2] < b[2] ? -1 : 1))
  );
  // No address of the caller anywhere in it.
  assert.equal(JSON.stringify(fake.auditLog()).includes('127.0.0.1'), false);
});

test("a write records the sign-in too, after the change's own entry, and the GET of the log lists it", async () => {
  const { call, manager, session, signIns, changes } = setup();
  const made = await call('POST', '/api/tokens', { claims: session(manager), body: { name: 'laptop' } });
  assert.equal(made.status, 201);
  assert.deepEqual([changes().length, signIns().length], [1, 1]);
  const listed = (await call('GET', '/api/audit', { claims: session(manager) })).body.entries;
  assert.deepEqual(
    listed.map((entry) => entry.action),
    ['token.create', 'account.sign_in']
  );
});

test('every instance makes the same entry, and the log keeps one: the others are refused, quietly', async () => {
  const { app, call, fake, manager, session, signIns, config, clock } = setup();
  const logs = [];
  const other = createApp({ aws: fake, config, now: () => clock.ms, log: (line) => logs.push(line) });
  await call('GET', '/api/me', { claims: session(manager) });
  const response = await other(apiEvent('GET', '/api/me', { claims: session(manager) }));
  assert.equal(response.statusCode, 200);
  assert.equal(signIns().length, 1);
  assert.equal(fake.calls.filter((call_) => call_.method === 'putAudit').length, 2);
  assert.equal(
    logs.some((line) => line.level === 'error' || line.event === 'sign_in_unrecorded'),
    false
  );
  // And each instance puts once per sign-in: from then on it asks nobody.
  await other(apiEvent('GET', '/api/me', { claims: session(manager) }));
  await app(apiEvent('GET', '/api/devices', { claims: session(manager) }));
  assert.equal(fake.calls.filter((call_) => call_.method === 'putAudit').length, 2);
  assert.equal(
    signInRequestId({ sub: manager.sub, client: 'web', authTime: SIGNED_IN }),
    `signin.${manager.sub}.web.${SIGNED_IN}`
  );
  assert.equal(signInRequestId({ sub: manager.sub, client: 'web', authTime: 0 }), null);
  assert.equal(signInRequestId({ sub: 'x'.repeat(128), client: 'web', authTime: SIGNED_IN }), null);
});

test("no sign-in without auth_time, for an API token, for a script's request, or for an account the live check refuses", async () => {
  const { call, fake, manager, viewer, session, signIns, addUser } = setup();
  // A token without the claim.
  await call('GET', '/api/me', { as: manager });
  // An API token is no sign-in, though making one is.
  const { token } = (await call('POST', '/api/tokens', { as: manager, body: { name: 'script' } })).body;
  assert.equal((await call('GET', '/api/t/me', { token })).status, 200);
  assert.equal((await call('POST', '/api/t/serial/commands', { token, body: { command: 'REBOOT' } })).status, 201);
  // cloud/smoke.sh and the bench invoke the function with claims they wrote.
  for (const requestId of ['smoke-0123456789abcdef', 'bench-0123456789abcdef']) {
    assert.equal((await call('GET', '/api/me', { claims: session(manager), requestId })).status, 200);
  }
  assert.deepEqual(signIns(), []);
  // An account that is disabled, or in neither group by now, is refused before it is a sign-in.
  const gone = addUser('gone', ['viewers'], { enabled: false });
  assert.equal(
    (await call('GET', '/api/me', { claims: { ...gone.claims, auth_time: String(SIGNED_IN) } })).status,
    403
  );
  const outsider = addUser('outsider', []);
  const outsiderClaims = accessClaims({ sub: outsider.sub, groups: [], authTime: SIGNED_IN });
  assert.equal((await call('GET', '/api/me', { claims: outsiderClaims })).status, 403);
  // A viewer's refused write is not one either; the viewer's next read is.
  assert.equal(
    (await call('POST', '/api/serial/commands', { claims: session(viewer), body: { command: 'WIFI' } })).status,
    403
  );
  assert.deepEqual(signIns(), []);
  assert.equal((await call('GET', '/api/me', { claims: session(viewer) })).status, 200);
  assert.deepEqual(
    signIns().map((entry) => entry.actor.sub),
    [viewer.sub]
  );
  assert.ok(fake.auditLog().length > 1);
});

test('a sign-in that cannot be recorded never fails or changes the request, and the next request tries again', async () => {
  const { call, fake, logs, manager, session, signIns } = setup();
  const put = fake.putAudit;
  let failing = 1;
  fake.putAudit = async (item) => {
    if (item.action === 'account.sign_in' && failing > 0) {
      failing -= 1;
      throw Object.assign(new Error('PutItem: InternalServerError'), { name: 'AwsError', code: 'failed' });
    }
    return put(item);
  };
  const first = await call('GET', '/api/me', { claims: session(manager) });
  assert.equal(first.status, 200);
  assert.equal(first.body.email, manager.email);
  assert.deepEqual(signIns(), []);
  assert.equal(logs.filter((line) => line.event === 'sign_in_unrecorded').length, 1);
  // The change made in the same breath is on record as usual.
  assert.equal(
    (await call('POST', '/api/serial/commands', { claims: session(manager), body: { command: 'MQTT_RECONNECT' } }))
      .status,
    201
  );
  assert.equal(signIns().length, 1);
});

test('a sign-in whose write hangs is given up after its time, and the answer goes out as it was', async () => {
  const timers = manualTimers();
  const { call, fake, manager, session, logs } = setup({ timers });
  fake.putAudit = () => new Promise(() => {});
  const answer = call('GET', '/api/me', { claims: session(manager) });
  for (let turn = 0; turn < 50 && !timers.waiting().includes(1500); turn += 1) await new Promise(setImmediate);
  assert.deepEqual(timers.waiting(), [1500]);
  timers.expire();
  const { status, body } = await answer;
  assert.deepEqual([status, body.email], [200, manager.email]);
  assert.equal(logs.find((line) => line.event === 'sign_in_unrecorded').why, 'late');
  assert.deepEqual(timers.waiting(), []);
});

// Commands at a board's serial console.

test("a release manager's command at the serial console is on record: which, on which board and firmware, never a value", async () => {
  const { call, manager, session, changes } = setup();
  const posted = await call('POST', '/api/serial/commands', {
    claims: session(manager),
    body: { command: 'WIFI', device: 'CRVIHAAN01', version: '1.12.0+0' },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.deepEqual(posted.body, { recorded: { command: 'WIFI', device: 'CRVIHAAN01', version: '1.12.0+0' } });
  const entry = changes().at(-1);
  assert.deepEqual(
    [entry.action, entry.outcome, entry.target, entry.detail, entry.actor.email],
    ['serial.command', 'ok', 'CRVIHAAN01', { command: 'WIFI', version: '1.12.0+0' }, manager.email]
  );
  // A board in factory mode has no ID yet, and its firmware may not be known.
  assert.equal(
    (await call('POST', '/api/serial/commands', { claims: session(manager), body: { command: 'INIT' } })).status,
    201
  );
  assert.deepEqual([changes().at(-1).target, changes().at(-1).detail], ['', { command: 'INIT' }]);
  assert.ok(SERIAL_COMMANDS.includes('FACTORY_RESET') && SERIAL_COMMANDS.includes('ENTER_BOOTLOADER'));
});

test('a post with a value in it, or with what is not a command, a device ID or a version, is refused and on record as refused', async () => {
  const { call, manager, session, changes, fake } = setup();
  const refused = async (body, code) => {
    const before = changes().length;
    const answer = await call('POST', '/api/serial/commands', { claims: session(manager), body });
    assert.deepEqual([answer.status, answer.body.error?.code], [400, code], JSON.stringify(body));
    assert.deepEqual(
      changes()
        .slice(before)
        .map((entry) => [entry.outcome, entry.detail.code]),
      [['rejected', code]]
    );
  };
  await refused({ command: 'WIFI', ssid: 'HomeNet', password: 'hunter2222' }, 'unexpected_field');
  await refused({ command: 'WIFI|HomeNet|hunter2222' }, 'invalid_command');
  await refused({ command: 'wifi' }, 'invalid_command');
  await refused({ command: 'GET_ID' }, 'invalid_command');
  await refused({}, 'invalid_command');
  await refused({ command: 'SET_ID', device: 'CR-VIHAAN' }, 'invalid_device');
  await refused({ command: 'SET_ID', device: 'x'.repeat(33) }, 'invalid_device');
  await refused({ command: 'SET_ID', device: 7 }, 'invalid_device');
  await refused({ command: 'SET_ID', version: '1.12.0' }, 'invalid_version');
  for (const secret of ['HomeNet', 'hunter2222', 'CR-VIHAAN']) {
    assert.equal(JSON.stringify(fake.auditLog()).includes(secret), false, secret);
  }
});

test('only a release manager may post one, now; from the phone it needs no fresh sign-in, and a token may post too', async () => {
  const { call, viewer, manager, session, changes, config, fake } = setup();
  const denied = await call('POST', '/api/serial/commands', { claims: session(viewer), body: { command: 'REBOOT' } });
  assert.deepEqual([denied.status, denied.body.error.code], [403, 'release_manager_required']);
  assert.deepEqual([changes().at(-1).outcome, changes().at(-1).actor.sub], ['denied', viewer.sub]);
  // A token that still says release manager, of an account that is not one any more.
  fake.user(manager.sub).setGroups(['viewers']);
  assert.equal(
    (await call('POST', '/api/serial/commands', { claims: session(manager), body: { command: 'REBOOT' } })).status,
    403
  );
  fake.user(manager.sub).setGroups(['release-managers']);
  // Signed in on the phone two hours ago: a deployment would ask for a sign-in, this does not.
  const old = session(manager, { client: config.mobileClientId, authTime: SIGNED_IN - 7200 });
  const phone = await call('POST', '/api/serial/commands', {
    claims: old,
    body: { command: 'CLEAR_WIFI', device: 'CRVIHAAN01' },
  });
  assert.equal(phone.status, 201);
  assert.equal(changes().at(-1).detail.from, 'phone');
  const { token } = (await call('POST', '/api/tokens', { as: manager, body: { name: 'provisioning' } })).body;
  assert.equal((await call('POST', '/api/t/serial/commands', { token, body: { command: 'KEYGEN' } })).status, 201);
  assert.match(changes().at(-1).detail.token, /^[0-9a-f]{16}$/);
});

test(`at most ${SERIAL_PER_MINUTE} a minute per person; one more is refused with 429 and leaves no entry`, async () => {
  const { call, manager, session, changes, advance, addUser, logs } = setup();
  const other = addUser('other', ['release-managers']);
  const post = (user) => call('POST', '/api/serial/commands', { claims: session(user), body: { command: 'BUTTON' } });
  for (let count = 0; count < SERIAL_PER_MINUTE; count += 1) {
    assert.equal((await post(manager)).status, 201, `post ${count + 1}`);
    advance(1000);
  }
  const before = changes().length;
  const over = await post(manager);
  assert.deepEqual([over.status, over.body.error.code], [429, 'rate_limited']);
  assert.match(over.body.error.message, /done on the board all the same/);
  assert.equal(changes().length, before);
  assert.equal(logs.at(-1).status, 429);
  // Another person is not held back by it.
  assert.equal((await post(other)).status, 201);
  // A minute after the first, there is room for one again.
  advance(31_000);
  assert.equal((await post(manager)).status, 201);
});
