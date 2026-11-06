// Tests for what the console API says and does of Memfault (docs/memfault.md): a board's page says whether
// its chunks reach Memfault and where it is there (handlers/devices.mjs, lib/memfault.mjs), the slugs of the
// configuration (config.mjs), and the command "memfault" (handlers/commands.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { MEMFAULT_KEY_CACHE_MS, MEMFAULT_KEY_RETRY_MS } from '../src/handlers/devices.mjs';
import { memfaultUrl, memfaultView, sendsMemfault } from '../src/lib/memfault.mjs';
import { accessClaims, createTestConsole, fakeEnv } from './fake-aws.mjs';

const THING = 'cranium-0123456789abcdef';
const SLUGS = { MEMFAULT_ORG_SLUG: 'cranium-team', MEMFAULT_PROJECT_SLUG: 'cranium-boards' };

function world(env = {}) {
  const console_ = createTestConsole({ env });
  const viewer = console_.addUser('viewer', ['viewers']);
  const manager = console_.addUser('manager', ['release-managers']);
  console_.fake.addThing(THING);
  const page = async () => (await console_.call('GET', `/api/devices/${THING}`, { as: viewer })).body.memfault;
  const report = (version) => console_.fake.device(THING).report({ fw: { version, confirmed: true }, uptime: 60 });
  return { ...console_, viewer, manager, page, report };
}

const keyChecks = (fake) => fake.calls.filter((call) => call.method === 'memfaultKeyStored').length;

test("firmware 1.14.0 and later sends Memfault's data, and nothing before it does", () => {
  for (const version of ['1.14.0+0', '1.14.0', '1.14.3+2', '1.15.0+0', '2.0.0+0'])
    assert.equal(sendsMemfault(version), true, version);
  for (const version of ['1.13.9+0', '1.13.0+7', '0.14.0+0', '1.9.99+0', '', 'v1.14.0', null, undefined, 1.14]) {
    assert.equal(sendsMemfault(version), false, String(version));
  }
});

test('the link to a board in Memfault needs both slugs, and names the board by its thing name', () => {
  assert.equal(
    memfaultUrl(THING, { org: 'cranium-team', project: 'cranium-boards' }),
    `https://app.memfault.com/organizations/cranium-team/projects/cranium-boards/devices/${THING}`
  );
  for (const slugs of [
    { org: '', project: 'p' },
    { org: 'o', project: '' },
    {},
    { org: 'Has-Capitals', project: 'p' },
    { org: 'o/../x', project: 'p' },
  ]) {
    assert.equal(memfaultUrl(THING, slugs), null, JSON.stringify(slugs));
  }
  assert.deepEqual(
    memfaultView({ thing: THING, fw: { version: '1.14.0+0' } }, { keyStored: true, org: '', project: '' }),
    { keyStored: true, firmware: true, url: null }
  );
  assert.deepEqual(memfaultView(null, { keyStored: 'yes' }), { keyStored: false, firmware: false, url: null });
});

test('the slugs are optional in the configuration, and a malformed one stops the function', () => {
  assert.deepEqual({ ...loadConfig(fakeEnv()).memfault }, { org: '', project: '' });
  assert.deepEqual({ ...loadConfig(fakeEnv(SLUGS)).memfault }, { org: 'cranium-team', project: 'cranium-boards' });
  assert.deepEqual(
    { ...loadConfig(fakeEnv({ MEMFAULT_ORG_SLUG: '', MEMFAULT_PROJECT_SLUG: '' })).memfault },
    { org: '', project: '' }
  );
  for (const value of ['Capitals', 'has space', '-leading', 'x'.repeat(64), 'a/b']) {
    assert.throws(() => loadConfig(fakeEnv({ MEMFAULT_ORG_SLUG: value })), /MEMFAULT_ORG_SLUG/, value);
    assert.throws(() => loadConfig(fakeEnv({ MEMFAULT_PROJECT_SLUG: value })), /MEMFAULT_PROJECT_SLUG/, value);
  }
});

test("a board's page says no key, then the firmware, then forwarding on, with the link once the slugs are set", async () => {
  const { page, report, fake, advance } = world(SLUGS);
  const url = `https://app.memfault.com/organizations/cranium-team/projects/cranium-boards/devices/${THING}`;
  report('1.13.0+0');
  assert.deepEqual(await page(), { keyStored: false, firmware: false, url });
  fake.storeMemfaultKey();
  advance(MEMFAULT_KEY_CACHE_MS);
  assert.deepEqual(await page(), { keyStored: true, firmware: false, url });
  report('1.14.0+0');
  advance(10_000);
  assert.deepEqual(await page(), { keyStored: true, firmware: true, url });

  // Without the slugs there is no link, and the rest is the same.
  const bare = world();
  bare.fake.storeMemfaultKey();
  bare.report('1.14.1+0');
  assert.deepEqual(await bare.page(), { keyStored: true, firmware: true, url: null });
  // A board that never reported has no firmware to send anything with.
  const silent = world(SLUGS);
  assert.deepEqual(await silent.page(), { keyStored: false, firmware: false, url });
});

test('AWS is asked whether a key is stored once in five minutes, and a question it does not answer says no for a minute', async () => {
  const { page, report, fake, advance, logs } = world();
  report('1.14.0+0');
  fake.storeMemfaultKey();
  await page();
  await page();
  advance(MEMFAULT_KEY_CACHE_MS - 1);
  await page();
  assert.equal(keyChecks(fake), 1);
  advance(1);
  fake.failNext('memfaultKeyStored');
  assert.equal((await page()).keyStored, false);
  assert.equal(keyChecks(fake), 2);
  assert.ok(logs.some((line) => line.event === 'memfault_key_unknown'));
  // The page itself still loads: the answer is only that no key is known to be stored.
  advance(MEMFAULT_KEY_RETRY_MS - 1);
  assert.equal((await page()).keyStored, false);
  advance(1);
  assert.equal((await page()).keyStored, true);
  assert.equal(keyChecks(fake), 3);
});

test('"memfault" is a command like report: published with an id and nothing else, on record, and needs a fresh sign-in from a phone', async () => {
  const { call, manager, viewer, fake, report, clock } = world();
  report('1.14.0+0');
  const path = `/api/devices/${THING}/commands`;
  const sent = await call('POST', path, { as: manager, body: { cmd: 'memfault' } });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  assert.equal(sent.body.command.cmd, 'memfault');
  assert.deepEqual(
    fake.commands.map(({ thing, payload }) => [thing, Object.keys(payload), payload.cmd]),
    [[THING, ['id', 'cmd'], 'memfault']]
  );
  const entry = fake.auditLog().find((item) => item.action === 'board.command');
  assert.deepEqual([entry.outcome, entry.detail.cmd], ['ok', 'memfault']);

  assert.equal((await call('POST', path, { as: manager, body: { cmd: 'memfault', seconds: 5 } })).status, 400);
  assert.equal((await call('POST', path, { as: viewer, body: { cmd: 'memfault' } })).status, 403);
  // An answer is the board's own business: the console never sends one.
  const ack = await call('POST', path, { as: manager, body: { cmd: 'memfault_ack' } });
  assert.deepEqual([ack.status, ack.body.error.code], [400, 'invalid_command']);
  assert.match(ack.body.error.message, /identify, report, memfault/);

  const phone = (ageSeconds) =>
    accessClaims({
      sub: manager.sub,
      groups: ['release-managers'],
      clientId: 'localmobile',
      authTime: Math.floor(clock.ms / 1000) - ageSeconds,
    });
  const stale = await call('POST', path, { claims: phone(16 * 60), body: { cmd: 'memfault' } });
  assert.deepEqual([stale.status, stale.body.error.code], [403, 'phone_sign_in_again']);
  assert.equal((await call('POST', path, { claims: phone(60), body: { cmd: 'memfault' } })).status, 202);
});
