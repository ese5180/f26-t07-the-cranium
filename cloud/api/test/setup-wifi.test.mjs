// Tests for GET /api/setup/wifi-defaults (src/handlers/setup.mjs, src/aws-wifi-defaults.mjs): Board setup's
// Wi-Fi defaults. Who may read them, how they are checked, that they are never cached, and that neither the
// log nor the activity log ever holds them. Every value here is made up.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createWifiDefaultsReader } from '../src/aws-wifi-defaults.mjs';
import { parseWifiDefaults } from '../src/handlers/setup.mjs';
import { accessClaims, createTestConsole } from './fake-aws.mjs';

const PATH = '/api/setup/wifi-defaults';
const FAKE = Object.freeze({ ssid: 'Test’s network', passphrase: 'not-a-real-passphrase-1', security: 'WPA3_SAE' });

function world() {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  const entries = () => console_.fake.auditLog().filter((entry) => entry.action === 'setup.wifi_defaults');
  return { ...console_, manager, viewer, entries };
}

test('a release manager gets the stored network, never cached, and the entry says only that one was given', async () => {
  const { call, manager, fake, entries, logs } = world();
  fake.storeWifiDefaults(JSON.stringify(FAKE));
  const answer = await call('GET', PATH, { as: manager });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { wifi: FAKE });
  assert.equal(answer.headers['cache-control'], 'no-store');
  const [entry] = entries();
  assert.deepEqual([entry.outcome, entry.actor.sub, entry.detail], ['ok', manager.sub, { stored: 'true' }]);
  const everything = JSON.stringify([entries(), logs]);
  assert.equal(everything.includes(FAKE.passphrase), false);
  assert.equal(everything.includes('not-a-real'), false);
});

test('with none stored the answer is null, and the page leaves the fields empty', async () => {
  const { call, manager, entries } = world();
  const answer = await call('GET', PATH, { as: manager });
  assert.deepEqual([answer.status, answer.body], [200, { wifi: null }]);
  assert.deepEqual(entries()[0].detail, { stored: 'false' });
});

test('a viewer never gets it, nor an API token; the apps’ sign-in does, as the desktop app reads it', async () => {
  const { call, viewer, manager, fake, entries, clock } = world();
  fake.storeWifiDefaults(JSON.stringify(FAKE));
  const refused = await call('GET', PATH, { as: viewer });
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'release_manager_required']);
  assert.equal(JSON.stringify(refused.body).includes(FAKE.passphrase), false);

  const made = await call('POST', '/api/tokens', { as: manager, body: { name: 'bench', days: 30 } });
  const byToken = await call('GET', '/api/t/setup/wifi-defaults', { token: made.body.token });
  assert.equal(byToken.status, 403);
  assert.equal(byToken.body.error.code, 'token_not_allowed');

  // The desktop app signs in with the apps' client. A read needs no fresh sign-in.
  const app = accessClaims({
    sub: manager.sub,
    groups: ['release-managers'],
    clientId: 'localmobile',
    authTime: Math.floor(clock.ms / 1000) - 3600,
  });
  const fromApp = await call('GET', PATH, { claims: app });
  assert.deepEqual([fromApp.status, fromApp.body], [200, { wifi: FAKE }]);
  assert.deepEqual(
    entries().map((entry) => [entry.outcome, entry.detail.code ?? null]),
    [
      ['denied', 'release_manager_required'],
      ['denied', 'token_not_allowed'],
      ['ok', null],
    ]
  );
});

test('what the firmware would refuse is refused here too, and a failed read says so without the value', async () => {
  const { call, manager, fake, logs } = world();
  for (const bad of [
    'not json',
    '[]',
    JSON.stringify({ ...FAKE, ssid: '' }),
    JSON.stringify({ ...FAKE, ssid: 'a'.repeat(33) }),
    JSON.stringify({ ...FAKE, ssid: 'with|bar' }),
    JSON.stringify({ ...FAKE, passphrase: 'short' }),
    JSON.stringify({ ...FAKE, passphrase: `${'p'.repeat(20)}\n` }),
    JSON.stringify({ ...FAKE, security: 'WEP' }),
  ]) {
    fake.storeWifiDefaults(bad);
    const answer = await call('GET', PATH, { as: manager });
    assert.deepEqual([answer.status, answer.body.error?.code], [500, 'wifi_defaults_invalid'], bad);
  }
  fake.storeWifiDefaults(JSON.stringify(FAKE));
  fake.failNext('wifiDefaults', { awsName: 'AccessDeniedException' });
  const failed = await call('GET', PATH, { as: manager });
  assert.deepEqual([failed.status, failed.body.error.code], [503, 'wifi_defaults_unavailable']);
  assert.equal(JSON.stringify(logs).includes(FAKE.passphrase), false);
});

test('a security left out is WPA2-PSK, as tools/cranium_secrets.py writes it', () => {
  assert.deepEqual(parseWifiDefaults(JSON.stringify({ ssid: 'Lab', passphrase: 'fake-pass-123' })), {
    ssid: 'Lab',
    passphrase: 'fake-pass-123',
    security: 'WPA2_PSK',
  });
});

test('the reader asks nothing without the secret’s ARN, and never puts the value in its error', async () => {
  assert.equal(await createWifiDefaultsReader({}).wifiDefaults(), null);
  const reader = createWifiDefaultsReader(
    {},
    {
      readSecret: async () => {
        const error = new Error('fake-secret-value');
        error.name = 'ThrottlingException';
        throw error;
      },
    }
  );
  await assert.rejects(reader.wifiDefaults(), (error) => {
    assert.equal(error.name, 'WifiDefaultsError');
    assert.equal(error.message, 'GetSecretValue: ThrottlingException');
    return true;
  });
  const stored = createWifiDefaultsReader({}, { readSecret: async () => '{"ssid":"x"}' });
  assert.equal(await stored.wifiDefaults(), '{"ssid":"x"}');
});
