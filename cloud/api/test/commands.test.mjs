// Tests for POST /api/devices/{thing}/commands (src/handlers/commands.mjs): who may send a command,
// what is published, the limit per person, and what goes on record.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMMANDS_PER_MINUTE } from '../src/handlers/commands.mjs';
import { accessClaims, createTestConsole } from './fake-aws.mjs';

const THING = 'cranium-0123456789abcdef';
const OFFLINE = 'cranium-fedcba9876543210';
const PATH = `/api/devices/${THING}/commands`;
const PHONE_CLIENT = 'localmobile';

function world() {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  console_.fake.addThing(THING);
  console_.fake.addThing(OFFLINE);
  console_.fake.device(THING).report({ fw: { version: '1.13.0+0', confirmed: true }, uptime: 60 });
  const phone = (ageSeconds) => accessClaims({
    sub: manager.sub, groups: ['release-managers'], clientId: PHONE_CLIENT,
    authTime: Math.floor(console_.clock.ms / 1000) - ageSeconds,
  });
  const commands = () => console_.fake.auditLog().filter((entry) => entry.action === 'board.command');
  return { ...console_, manager, viewer, phone, commands };
}

test('identify is published once, QoS 1 on the board\'s commands topic, with a 16-hex id from the server', async () => {
  const { call, manager, fake, commands } = world();
  const sent = await call('POST', PATH, { as: manager, body: { cmd: 'identify', seconds: 20 } });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const { command } = sent.body;
  assert.match(command.id, /^[0-9a-f]{16}$/);
  assert.deepEqual(command, {
    id: command.id, cmd: 'identify', seconds: 20, thing: THING, sentAt: new Date(fake.commands[0].at).toISOString(), online: true,
  });
  assert.deepEqual(fake.commands.map(({ thing, payload }) => ({ thing, payload })),
    [{ thing: THING, payload: { id: command.id, cmd: 'identify', seconds: 20 } }]);
  const [entry] = commands();
  assert.deepEqual([entry.outcome, entry.target, entry.actor.sub], ['ok', THING, manager.sub]);
  assert.deepEqual(entry.detail, { cmd: 'identify', seconds: '20', id: command.id });

  // Without a length the board blinks for 15 s; report carries none.
  const plain = await call('POST', PATH, { as: manager, body: { cmd: 'identify' } });
  assert.equal(plain.body.command.seconds, 15);
  const report = await call('POST', PATH, { as: manager, body: { cmd: 'report' } });
  assert.deepEqual(Object.keys(fake.commands.at(-1).payload), ['id', 'cmd']);
  assert.equal(report.body.command.cmd, 'report');
  // Every id is new.
  assert.equal(new Set(fake.commands.map((sent_) => sent_.payload.id)).size, 3);
});

test('an offline board is sent the command all the same, and the answer says it was offline', async () => {
  const { call, manager } = world();
  const sent = await call('POST', `/api/devices/${OFFLINE}/commands`, { as: manager, body: { cmd: 'identify' } });
  assert.deepEqual([sent.status, sent.body.command.online], [202, false]);
});

test('a viewer may not send a command, and the refusal is on record', async () => {
  const { call, viewer, fake, commands } = world();
  const refused = await call('POST', PATH, { as: viewer, body: { cmd: 'identify' } });
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'release_manager_required']);
  assert.equal(fake.commands.length, 0);
  assert.deepEqual(commands().map((entry) => [entry.outcome, entry.detail.code]), [['denied', 'release_manager_required']]);
});

test('a command is exactly one of the two, with a length from 1 to 60 for identify only', async () => {
  const { call, manager, fake } = world();
  const cases = [
    [{ cmd: 'reboot' }, 'invalid_command'],
    [{ cmd: 'IDENTIFY' }, 'invalid_command'],
    [{}, 'invalid_command'],
    [{ cmd: 'identify', seconds: 0 }, 'invalid_seconds'],
    [{ cmd: 'identify', seconds: 61 }, 'invalid_seconds'],
    [{ cmd: 'identify', seconds: 1.5 }, 'invalid_seconds'],
    [{ cmd: 'identify', seconds: '15' }, 'invalid_seconds'],
    [{ cmd: 'report', seconds: 15 }, 'unexpected_field'],
    [{ cmd: 'identify', id: '0123456789abcdef' }, 'unexpected_field'],
  ];
  for (const [body, code] of cases) {
    const answer = await call('POST', PATH, { as: manager, body });
    assert.deepEqual([answer.status, answer.body.error.code], [400, code], JSON.stringify(body));
  }
  assert.equal((await call('POST', '/api/devices/cranium-1111111111111111/commands', { as: manager, body: { cmd: 'identify' } })).status, 404);
  assert.equal((await call('POST', '/api/devices/someone/commands', { as: manager, body: { cmd: 'identify' } })).status, 400);
  assert.equal(fake.commands.length, 0);
});

test('a Bluetooth-only board is never sent a command', async () => {
  const { call, manager, fake, commands } = world();
  // A nrf5340dk never connects: its type is its thing's attribute, set when it is provisioned (docs/fleet.md).
  const bluetooth = 'cranium-00000000000000ee';
  fake.addThing(bluetooth, { attributes: { board: 'nrf5340dk' } });
  const answer = await call('POST', `/api/devices/${bluetooth}/commands`, { as: manager, body: { cmd: 'identify' } });
  assert.deepEqual([answer.status, answer.body.error.code], [409, 'bluetooth_only']);
  assert.equal(fake.commands.length, 0);
  assert.deepEqual(commands().map((entry) => [entry.outcome, entry.detail.code]), [['rejected', 'bluetooth_only']]);
  // The map says why it has no position.
  const listed = (await call('GET', '/api/devices', { as: manager })).body.devices;
  assert.equal(listed.find((device) => device.thing === bluetooth).location.bluetoothOnly, true);
  assert.equal(listed.find((device) => device.thing === THING).location.bluetoothOnly, false);
});

test(`at most ${COMMANDS_PER_MINUTE} a minute per person; one over that is refused and leaves no entry`, async () => {
  const { call, manager, fake, commands, advance, addUser } = world();
  for (let index = 0; index < COMMANDS_PER_MINUTE; index += 1) {
    assert.equal((await call('POST', PATH, { as: manager, body: { cmd: 'identify' } })).status, 202);
  }
  const over = await call('POST', PATH, { as: manager, body: { cmd: 'identify' } });
  assert.deepEqual([over.status, over.body.error.code], [429, 'rate_limited']);
  assert.equal(commands().length, COMMANDS_PER_MINUTE);
  assert.equal(fake.commands.length, COMMANDS_PER_MINUTE);
  // Somebody else is not held back by it, and a minute later neither is this person.
  const other = addUser('other', ['release-managers']);
  assert.equal((await call('POST', PATH, { as: other, body: { cmd: 'identify' } })).status, 202);
  advance(61_000);
  assert.equal((await call('POST', PATH, { as: manager, body: { cmd: 'identify' } })).status, 202);
});

test('from the phone, identify needs no fresh sign-in and report does', async () => {
  const { call, phone, fake, commands } = world();
  const stale = phone(16 * 60);
  const identify = await call('POST', PATH, { claims: stale, body: { cmd: 'identify' } });
  assert.equal(identify.status, 202, JSON.stringify(identify.body));
  const report = await call('POST', PATH, { claims: stale, body: { cmd: 'report' } });
  assert.deepEqual([report.status, report.body.error.code], [403, 'phone_sign_in_again']);
  const fresh = await call('POST', PATH, { claims: phone(60), body: { cmd: 'report' } });
  assert.equal(fresh.status, 202);
  assert.deepEqual(fake.commands.map((sent) => sent.payload.cmd), ['identify', 'report']);
  assert.deepEqual(commands().map((entry) => [entry.detail.cmd, entry.detail.from, entry.outcome]),
    [['identify', 'phone', 'ok'], ['report', 'phone', 'denied'], ['report', 'phone', 'ok']]);
});

test('a publish that fails is a failure of the request, on record as an error', async () => {
  const { call, manager, fake, commands } = world();
  fake.failNext('publishCommand');
  const answer = await call('POST', PATH, { as: manager, body: { cmd: 'identify' } });
  assert.equal(answer.status, 500);
  assert.deepEqual(commands().map((entry) => [entry.outcome, entry.detail.code]), [['error', 'internal_error']]);
});
