// What the website makes of Raspberry Pi images and of deployments that bring one (console 2.26.0).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// As core.test.mjs does: core.js imports nothing, so a data: URL loads it on every Node 22.
const source = readFileSync(new URL('../src/site/assets/core.js', import.meta.url));
const core = await import(`data:text/javascript;base64,${source.toString('base64')}`);

test('a deployment id of a Pi image, alone or with firmware, is one', () => {
  assert.equal(core.isDeploymentId('cranium-1-20-0-b0-pi-20261110T120000Z-ab12'), true);
  assert.equal(core.versionOfDeployment('cranium-1-20-0-b0-pi-20261110T120000Z-ab12'), '1.20.0+0');
  assert.equal(core.isDeploymentId('pi-2026-11-06-1-20261110T120000Z-ab12'), true);
  assert.equal(core.versionOfDeployment('pi-2026-11-06-1-20261110T120000Z-ab12'), null);
  assert.equal(core.isDeploymentId('pi-has.dot-20261110T120000Z-ab12'), false);
  assert.equal(core.isDeploymentId('cranium-1-20-0-b0-px-20261110T120000Z-ab12'), false);
});

test('a Pi image is read strictly, and anything unknown is not deployable', () => {
  const good = {
    version: '2026.11.06-1',
    size: 1000,
    sha256: 'a'.repeat(64),
    sig: 'b'.repeat(128),
    minFirmware: '1.20.0+0',
    status: 'active',
    uploadedAt: '2026-11-10T12:00:00.000Z',
    uploadedBy: { sub: 's', email: 'm' },
    key: `firmware/pi-${'a'.repeat(64)}.img`,
  };
  const read = core.readPiImage(good);
  assert.equal(read.version, '2026.11.06-1');
  assert.equal(read.status, 'active');
  assert.equal(read.minFirmware, '1.20.0+0');
  assert.equal(core.readPiImage({ ...good, status: 'whatever' }).status, 'revoked');
  assert.equal(core.readPiImage({ ...good, version: 'has space' }), null);
  assert.equal(core.readPiImage({ ...good, sha256: 'xyz' }), null);
});

test("each board's Pi part has words, with its progress while it moves", () => {
  for (const state of ['waiting', 'downloading', 'on_card', 'flashing', 'flashed', 'failed', 'not_flashed']) {
    const said = core.describePiPart({ state, progress: null, version: 'v' });
    assert.ok(said.label.length > 0, state);
    assert.doesNotMatch(said.label, /[a-z]_[a-z]/);
  }
  assert.equal(core.describePiPart({ state: 'flashing', progress: 42 }).label, 'Sending to the Pi · 42%');
  assert.equal(core.describePiPart({ state: 'flashed', progress: 100 }).label, 'On the Pi, verified');
  assert.equal(core.describePiPart(null), null);
});

test('the two phases of a Pi image have words of their own', () => {
  for (const phase of ['downloading_pi', 'flashing_pi']) {
    const said = core.describeExecution({ phase, status: 'IN_PROGRESS', online: true, progress: 10 });
    assert.notEqual(said.title, 'Unknown state', phase);
    assert.match(said.title, /10%$/);
  }
});
