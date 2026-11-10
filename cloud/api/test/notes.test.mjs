// Tests for a release's note, changed after its upload (PUT /api/firmware/{version}/notes): for
// release managers, with a session or an API token, active and revoked releases alike, on record.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTestConsole, fixture } from './fake-aws.mjs';

const VERSION = '1.2.3+4';
const PATH = `/api/firmware/${encodeURIComponent(VERSION)}/notes`;

async function setup() {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  const uploaded = await console_.call('POST', '/api/firmware', {
    as: manager,
    body: {
      filename: 'zephyr.signed.bin',
      data: fixture('valid-1.2.3+4.signed.bin').toString('base64'),
      notes: 'first',
    },
  });
  assert.equal(uploaded.status, 201);
  const entries = () => console_.fake.auditLog().filter((entry) => entry.action === 'firmware.notes');
  return { ...console_, manager, viewer, entries };
}

test("a release manager changes a release's note, and only its note, on record", async () => {
  const { call, manager, fake, entries } = await setup();
  const before = { ...[...fake.releases.values()][0] };
  const notes = 'Reconnects faster after the Wi-Fi drops out. Fixes the LED stuck on after an update.';
  const response = await call('PUT', PATH, { as: manager, body: { notes: `  ${notes}  ` } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.release.notes, notes);
  const after = [...fake.releases.values()][0];
  assert.deepEqual({ ...after, notes: before.notes }, before);
  assert.equal((await call('GET', '/api/firmware', { as: manager })).body.releases[0].notes, notes);
  const [entry] = entries();
  assert.deepEqual([entry.target, entry.outcome, entry.detail], [VERSION, 'ok', { notes, oldLength: '5' }]);

  // A note can be emptied; a long one is on record as far as a detail holds it.
  assert.equal((await call('PUT', PATH, { as: manager, body: { notes: '' } })).body.release.notes, '');
  const long = 'x'.repeat(500);
  assert.equal((await call('PUT', PATH, { as: manager, body: { notes: long } })).status, 200);
  assert.deepEqual(entries().at(-1).detail, { notes: 'x'.repeat(200), oldLength: '0' });
  // The note before and after (docs/audit-diff.md): an emptied note is none, and a long one is cut to fit.
  assert.deepEqual(
    entries().map((one) => one.changes),
    [
      [{ field: 'notes', from: 'first', to: notes }],
      [{ field: 'notes', from: notes, to: null }],
      [{ field: 'notes', from: null, to: `${'x'.repeat(199)}\u2026` }],
    ]
  );
});

test("a revocation says what changed: the release's status, and why", async () => {
  const { call, manager, fake } = await setup();
  const path = `/api/firmware/${encodeURIComponent(VERSION)}/revoke`;
  assert.equal((await call('POST', path, { as: manager, body: { reason: 'bad' } })).status, 200);
  const [entry] = fake.auditLog().filter((one) => one.action === 'firmware.revoke');
  assert.deepEqual(entry.changes, [
    { field: 'status', from: 'active', to: 'revoked' },
    { field: 'reason', from: null, to: 'bad' },
  ]);
  const [upload] = fake.auditLog().filter((one) => one.action === 'firmware.upload');
  assert.deepEqual(upload.changes, [
    { field: 'status', from: null, to: 'active' },
    { field: 'notes', from: null, to: 'first' },
  ]);
});

test("a revoked release's note can be changed too", async () => {
  const { call, manager } = await setup();
  assert.equal(
    (
      await call('POST', `/api/firmware/${encodeURIComponent(VERSION)}/revoke`, {
        as: manager,
        body: { reason: 'bad' },
      })
    ).status,
    200
  );
  const response = await call('PUT', PATH, { as: manager, body: { notes: 'Revoked: bricks the encoder' } });
  assert.deepEqual(
    [response.status, response.body.release.status, response.body.release.notes],
    [200, 'revoked', 'Revoked: bricks the encoder']
  );
});

test('a note is one line of at most 500 characters, for a release that exists, from a release manager', async () => {
  const { call, manager, viewer, fake, entries } = await setup();
  for (const body of [{}, { notes: 7 }, { notes: 'x'.repeat(501) }, { notes: 'two\nlines' }]) {
    const response = await call('PUT', PATH, { as: manager, body });
    assert.deepEqual([response.status, response.body.error.code], [400, 'invalid_notes'], JSON.stringify(body));
  }
  const unknown = await call('PUT', `/api/firmware/${encodeURIComponent('9.9.9+9')}/notes`, {
    as: manager,
    body: { notes: 'x' },
  });
  assert.deepEqual([unknown.status, unknown.body.error.code], [404, 'unknown_version']);
  const refused = await call('PUT', PATH, { as: viewer, body: { notes: 'mine' } });
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'release_manager_required']);
  assert.equal([...fake.releases.values()][0].notes, 'first');
  assert.deepEqual(
    entries().map((entry) => entry.outcome),
    ['rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'denied']
  );
  // Only PUT: a POST there is no route.
  assert.equal((await call('POST', PATH, { as: manager, body: { notes: 'x' } })).status, 404);
});

test('an API token sets a note, as scripts/release-notes.sh does, and the entry names the token', async () => {
  const { call, manager, entries } = await setup();
  const made = await call('POST', '/api/tokens', { as: manager, body: { name: 'release notes' } });
  assert.equal(made.status, 201);
  const response = await call('PUT', `/api/t/firmware/${encodeURIComponent(VERSION)}/notes`, {
    token: made.body.token,
    body: { notes: 'From CHANGELOG.md' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual([entries().at(-1).detail.token, entries().at(-1).outcome], [made.body.id, 'ok']);
});
