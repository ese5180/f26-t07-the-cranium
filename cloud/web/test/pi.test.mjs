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

test('a Pi image alone has the Pi steps: the board never restarts for one, and nothing claims firmware', () => {
  const run = (pi, more = {}) =>
    core.describeExecution(
      { phase: 'downloading_pi', status: 'IN_PROGRESS', online: true, progress: 40, pi, ...more },
      { version: null }
    );
  const names = (said) => said.steps.map((step) => step.label);
  const states = (said) => said.steps.map((step) => step.state);

  const downloading = run({ state: 'downloading', progress: 40, version: '2026.11.10-2' });
  assert.deepEqual(names(downloading), [
    'Offered',
    'Accepted by the board',
    'Downloading onto the SD card',
    'Sent to the Pi',
    'Verified by the Pi',
  ]);
  assert.deepEqual(states(downloading), ['done', 'done', 'current', 'upcoming', 'upcoming']);
  assert.ok(!names(downloading).some((name) => /Restart|trial|Confirmed/.test(name)));

  const sending = run({ state: 'flashing', progress: 50, version: '2026.11.10-2' }, { phase: 'flashing_pi' });
  assert.deepEqual(states(sending), ['done', 'done', 'done', 'current', 'upcoming']);

  const done = run(
    { state: 'flashed', progress: 100, version: '2026.11.10-2' },
    { phase: 'succeeded', status: 'SUCCEEDED' }
  );
  assert.equal(done.title, 'On the Pi, verified');
  assert.match(done.text, /the Pi verified 2026\.11\.10-2/);
  assert.doesNotMatch(done.text, /confirmed|runs \d/);
  assert.deepEqual(states(done), ['done', 'done', 'done', 'done', 'done']);

  const refused = run(
    { state: 'failed', progress: null, version: '2026.11.10-2' },
    { phase: 'failed', status: 'FAILED', reason: 'pi_verify_failed' }
  );
  assert.equal(refused.tone, 'bad');
  assert.equal(refused.title, 'The Pi’s check failed');
  assert.match(refused.text, /firmware was not touched/);
  assert.deepEqual(states(refused), ['done', 'done', 'done', 'failed', 'skipped']);

  const noCard = run(
    { state: 'failed', progress: null, version: '2026.11.10-2' },
    { phase: 'failed', status: 'FAILED', reason: 'sd_absent' }
  );
  assert.equal(noCard.title, 'No SD card in the board');
  assert.deepEqual(states(noCard), ['done', 'done', 'failed', 'skipped', 'skipped']);

  // Offline while it sends: where it was when last seen, not drawn as moving.
  const quiet = run({ state: 'flashing', progress: 50, version: 'v' }, { phase: 'flashing_pi', online: false });
  assert.equal(quiet.steps[3].state, 'stopped');
});

test('board firmware and a Pi image: the firmware steps, then the Pi, once the firmware is confirmed', () => {
  const run = (pi, more = {}) =>
    core.describeExecution(
      { phase: 'flashing_pi', status: 'IN_PROGRESS', online: true, progress: 40, pi, ...more },
      { version: '1.20.1+0' }
    );
  const states = (said) => said.steps.map((step) => step.state);
  const sending = run({ state: 'flashing', progress: 40, version: '2026.11.10-1' });
  assert.equal(sending.steps.length, core.STEPS.length + 1);
  assert.equal(sending.steps.at(-1).label, 'Sending to the Pi');
  assert.deepEqual(states(sending), ['done', 'done', 'done', 'done', 'done', 'done', 'done', 'current']);

  const downloading = run({ state: 'downloading', progress: 40, version: 'v' }, { phase: 'downloading_pi' });
  assert.equal(downloading.steps.at(-1).state, 'upcoming');

  const failed = run(
    { state: 'failed', progress: null, version: '2026.11.10-1' },
    { phase: 'failed', status: 'FAILED', reason: 'pi_rejected' }
  );
  assert.equal(failed.title, 'The Pi refused the image');
  assert.match(failed.text, /installed and confirmed/);
  assert.deepEqual(states(failed).slice(0, 7), Array(7).fill('done'));
  assert.equal(failed.steps.at(-1).state, 'failed');

  // Firmware that did not stay: the Pi's step never came.
  const rolled = run(
    { state: 'not_flashed', progress: null, version: 'v' },
    { phase: 'failed', status: 'FAILED', reason: 'rolled_back' }
  );
  assert.equal(rolled.steps.at(-1).state, 'skipped');
});

test('a Pi image alone says nothing of firmware it did not bring, draws its sending step as the headline does, and no way back', () => {
  const alone = core.describeExecution(
    {
      phase: 'flashing_pi',
      status: 'IN_PROGRESS',
      online: true,
      progress: 20,
      pi: { state: 'flashing', progress: 20, version: 'v' },
    },
    { version: null }
  );
  assert.doesNotMatch(alone.text, /firmware/);
  assert.equal(alone.icon, 'upload');
  assert.equal(alone.marks[3], 'upload');
  assert.equal(alone.noReturn, true);
  const downloading = core.describeExecution(
    { phase: 'downloading_pi', status: 'IN_PROGRESS', online: true, progress: 20, pi: { state: 'downloading' } },
    { version: null }
  );
  assert.doesNotMatch(downloading.text, /spare slot|if this brings/);

  const both = core.describeExecution(
    {
      phase: 'flashing_pi',
      status: 'IN_PROGRESS',
      online: true,
      progress: 20,
      pi: { state: 'flashing', progress: 20, version: 'v' },
    },
    { version: '1.20.1+0' }
  );
  assert.match(both.text, /Its new firmware, 1\.20\.1\+0, is confirmed already\./);
  assert.equal(both.marks.length, both.steps.length);
  assert.equal(both.marks.at(-1), 'upload');
  assert.notEqual(both.noReturn, true);
});

test("a board's update card names the Pi steps of a job with both", () => {
  for (const [state, title] of [
    ['downloading_pi', 'Downloading the Raspberry Pi image'],
    ['flashing_pi', 'Sending the Raspberry Pi its image'],
  ]) {
    const said = core.describeUpdate({
      thing: 'cranium-0000000000000001',
      online: true,
      fw: { version: '1.20.0+0', confirmed: true },
      ota: { state, job: 'cranium-1-20-1-b0-pi-20261110T120000Z-ab12', progress: 30, last: 'none', error: '' },
    });
    assert.equal(said.title, title, state);
    assert.equal(said.progress, 30);
  }
});
