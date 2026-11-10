// Raspberry Pi images on the console (2.25.0, docs/pi-ota.md): their upload, and deployments that bring
// a Pi image alone or with board firmware, with what each board's execution says of both parts.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';

import {
  buildBundleJobDocument,
  buildJobDescription,
  buildJobId,
  piTimeoutMinutes,
  summarizeJob,
} from '../src/lib/jobs.mjs';
import { canonicalMinFirmware, piManifest, verifyPiSignature } from '../src/lib/pi-images.mjs';
import { deviceFromShadow } from '../src/lib/shadow.mjs';
import { deriveTimeline } from '../src/lib/timeline.mjs';
import { parseDeploymentId, parseJobId } from '../src/lib/validate.mjs';
import { createTestConsole, fixture } from './fake-aws.mjs';

const PI_BOARD = 'cranium-00000000000000aa';
const PLAIN_BOARD = 'cranium-00000000000000bb';
const SECOND_PI = 'cranium-00000000000000cc';

const idle = (withPi) => ({
  fw: { version: '1.0.0+3', confirmed: true },
  ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' },
  ...(withPi
    ? { pi: { state: 'idle', job: '', progress: 0, last: 'none', error: '', installed: '', card: true } }
    : {}),
  uptime: 600,
});

/** A signed record, as tools/pi_image.py writes it, for an image of these bytes. */
function signedRecord(privateKey, body, { version = '2026.11.06-1', minFirmware = undefined } = {}) {
  const record = {
    version,
    size: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    ...(minFirmware === undefined ? {} : { minFirmware }),
  };
  const manifest = piManifest({ ...record, minFirmware: canonicalMinFirmware(minFirmware) });
  record.sig = sign('sha256', Buffer.from(manifest), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('hex');
  return record;
}

const keys = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });

/** A console whose signing key is a fresh one, with a Pi board and a plain one. */
function setup() {
  const { privateKey, publicKey } = keys();
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const context = createTestConsole({ env: { SIGNING_PUBLIC_KEY_B64: der.toString('base64') } });
  const manager = context.addUser('manager', ['release-managers']);
  const viewer = context.addUser('viewer', ['viewers']);
  for (const thing of [PI_BOARD, PLAIN_BOARD, SECOND_PI]) context.fake.addThing(thing);
  context.fake.device(PI_BOARD).report(idle(true));
  context.fake.device(SECOND_PI).report(idle(true));
  context.fake.device(PLAIN_BOARD).report(idle(false));
  const call = (method, path, body, as = manager) => context.call(method, path, { as, body });
  return { ...context, privateKey, manager, viewer, call };
}

/** Upload a Pi image all the way: the record, the file in S3, and the check. */
async function uploadPi(world, body = Buffer.from('pi image bytes'), options = {}) {
  const record = signedRecord(world.privateKey, body, options);
  const created = await world.call('POST', '/api/pi-images', record);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  world.fake.objects.set(created.body.image.key, { body });
  const done = await world.call('POST', `/api/pi-images/${encodeURIComponent(record.version)}/complete`, {});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return { record, image: done.body.image };
}

/** A release in the fake's store, as an upload of the fixture would leave it: board firmware 1.2.3+4. */
function addRelease(world) {
  const image = fixture('valid-1.2.3+4.signed.bin');
  const sha256 = createHash('sha256').update(image).digest('hex');
  world.fake.releases.set('001.002.00003.0000000004', {
    version: '1.2.3+4',
    size: image.length,
    sha256,
    status: 'active',
    uploadedAt: '2026-10-10T22:00:00.000Z',
    board: 'nrf7002dk',
    layout: 1,
  });
  return { version: '1.2.3+4', size: image.length, sha256 };
}

test('the manifest is the one a board and tools/pi_image.py build, and its signature is checked', () => {
  assert.equal(
    piManifest({ version: '2026.11.06-1', size: 104857600, sha256: 'ab'.repeat(32), minFirmware: '1.20.0+0' }),
    `cranium-pi-image-v1\nversion=2026.11.06-1\nsize=104857600\nsha256=${'ab'.repeat(32)}\nmin_firmware=1.20.0+0\n`
  );
  assert.equal(piManifest({ version: 'x', size: 1, sha256: '00'.repeat(32) }).endsWith('min_firmware=none\n'), true);
  assert.equal(canonicalMinFirmware('1.20.0'), '1.20.0+0');
  assert.equal(canonicalMinFirmware('1.20.0+3'), '1.20.0+3');
  assert.equal(canonicalMinFirmware(undefined), null);
  assert.equal(canonicalMinFirmware('one'), undefined);

  const { privateKey, publicKey } = keys();
  const record = signedRecord(privateKey, Buffer.from('abc'), { minFirmware: '1.20.0' });
  const signingKey = { key: publicKey };
  assert.equal(verifyPiSignature({ ...record, minFirmware: '1.20.0+0' }, signingKey), true);
  // Any field changed, and it fails: what a board would refuse.
  assert.equal(verifyPiSignature({ ...record, minFirmware: null }, signingKey), false);
  assert.equal(verifyPiSignature({ ...record, minFirmware: '1.20.0+0', size: 4 }, signingKey), false);
  assert.equal(verifyPiSignature({ ...record, minFirmware: '1.20.0+0' }, { key: keys().publicKey }), false);
  assert.equal(verifyPiSignature({ ...record, sig: 'zz' }, signingKey), false);
});

test('a Pi image is uploaded straight to S3 and is deployable only once the file that arrived is the one described', async () => {
  const world = setup();
  const body = Buffer.from('a whole Raspberry Pi OS image, in short');
  const record = signedRecord(world.privateKey, body, { minFirmware: '1.20.0' });

  // A signature that does not hold is refused before anything is handed out.
  const forged = await world.call('POST', '/api/pi-images', { ...record, size: record.size + 1 });
  assert.equal(forged.status, 422);
  assert.equal(forged.body.error.code, 'bad_signature');
  // A viewer may not upload.
  assert.equal((await world.call('POST', '/api/pi-images', record, world.viewer)).status, 403);

  const created = await world.call('POST', '/api/pi-images', record);
  assert.equal(created.status, 201);
  const { image, upload } = created.body;
  assert.equal(image.status, 'uploading');
  assert.equal(image.minFirmware, '1.20.0+0');
  assert.equal(image.key, `firmware/pi-${record.sha256}.img`);
  assert.equal(upload.method, 'PUT');
  assert.equal(upload.size, body.length);
  // Only if new, and that SHA-256: S3 refuses anything else.
  assert.deepEqual(upload.headers, {
    'if-none-match': '*',
    'x-amz-checksum-sha256': Buffer.from(record.sha256, 'hex').toString('base64'),
  });

  // The same record again, while its file has not arrived: a new URL. Another record of that version: no.
  assert.equal((await world.call('POST', '/api/pi-images', record)).status, 201);
  const other = signedRecord(world.privateKey, Buffer.from('other'), { version: record.version });
  assert.equal((await world.call('POST', '/api/pi-images', other)).body.error.code, 'version_exists');

  // Not deployable while it uploads.
  const early = await world.call('POST', '/api/deployments', { pi: record.version, things: [PI_BOARD] });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'not_uploaded');

  // Nothing arrived, then something else did.
  const path = `/api/pi-images/${record.version}/complete`;
  assert.equal((await world.call('POST', path, {})).body.error.code, 'not_uploaded');
  world.fake.objects.set(image.key, { body: Buffer.from('not it') });
  assert.equal((await world.call('POST', path, {})).body.error.code, 'image_mismatch');
  world.fake.objects.set(image.key, { body });
  const done = await world.call('POST', path, {});
  assert.equal(done.status, 200);
  assert.equal(done.body.image.status, 'active');

  const listed = await world.call('GET', '/api/pi-images', undefined, world.viewer);
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.images.map((item) => [item.version, item.status, item.size]),
    [[record.version, 'active', body.length]]
  );
  assert.equal(Object.hasOwn(listed.body.images[0], 'rev'), false);
  const actions = world.fake.auditLog().map((entry) => entry.action);
  assert.ok(actions.includes('pi_image.upload') && actions.includes('pi_image.complete'));
});

test('a Pi image alone goes as a "pi_image" job, only to boards that report a Pi, with a time limit for its size', async () => {
  const world = setup();
  const { record } = await uploadPi(world, Buffer.alloc(50_000, 7));

  const refused = await world.call('POST', '/api/deployments', { pi: record.version, things: [PI_BOARD, PLAIN_BOARD] });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'no_pi');
  assert.deepEqual(refused.body.error.details, [{ thing: PLAIN_BOARD }]);

  const response = await world.call('POST', '/api/deployments', { pi: record.version, things: [PI_BOARD] });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const { deployment } = response.body;
  assert.match(deployment.id, /^pi-2026-11-06-1-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
  assert.deepEqual(deployment.parts, ['pi']);
  assert.equal(deployment.version, null);
  assert.deepEqual(deployment.pi, { version: record.version, sha256: record.sha256 });
  assert.deepEqual(deployment.executions[0].pi, { state: 'waiting', progress: null, version: record.version });

  const [created] = world.fake.calls.filter((call) => call.method === 'createJob').map((call) => call.args[0]);
  const document = JSON.parse(created.document);
  assert.equal(document.op, 'pi_image');
  assert.equal(document.pi.sha256, record.sha256);
  assert.match(document.pi.url, /firmware\/pi-[0-9a-f]{64}\.img\}$/);
  assert.equal(created.inProgressTimeoutMinutes, piTimeoutMinutes(50_000));
  assert.deepEqual(JSON.parse(created.description).pi, record.version);

  // It is listed and read back like any other deployment.
  world.advance(2500);
  const list = await world.call('GET', '/api/deployments', undefined, world.viewer);
  assert.ok(list.body.deployments.some((item) => item.id === deployment.id && item.parts[0] === 'pi'));

  // The board downloads it, then sends it to the Pi: the phases and progress come from the execution.
  world.fake.execution(deployment.id, PI_BOARD).update('IN_PROGRESS', { step: 'downloading', progress: '40' });
  world.advance(2500);
  let detail = (await world.call('GET', `/api/deployments/${deployment.id}`, undefined, world.viewer)).body.deployment;
  assert.equal(detail.executions[0].phase, 'downloading_pi');
  assert.equal(detail.executions[0].progress, 40);
  assert.deepEqual(detail.executions[0].pi, { state: 'downloading', progress: 40, version: record.version });
  world.fake.execution(deployment.id, PI_BOARD).update('IN_PROGRESS', { step: 'sending', progress: '75' });
  world.advance(2500);
  detail = (await world.call('GET', `/api/deployments/${deployment.id}`, undefined, world.viewer)).body.deployment;
  assert.equal(detail.executions[0].phase, 'flashing_pi');
  assert.equal(detail.executions[0].pi.state, 'flashing');

  // Cancelled like any other.
  const cancelled = await world.call('POST', `/api/deployments/${deployment.id}/cancel`, { force: true });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
});

test('firmware and a Pi image together go as one "fw_pi_update" job, and each board shows both parts', async () => {
  const world = setup();
  const release = addRelease(world);
  const { record } = await uploadPi(world, Buffer.alloc(9000, 3), { minFirmware: '1.2.3' });

  const response = await world.call('POST', '/api/deployments', {
    version: release.version,
    pi: record.version,
    things: [PI_BOARD, SECOND_PI],
    note: 'both',
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const { deployment } = response.body;
  assert.ok(deployment.id.startsWith('cranium-1-2-3-b4-pi-'));
  assert.deepEqual(deployment.parts, ['nrf', 'pi']);
  assert.equal(deployment.version, '1.2.3+4');

  const [created] = world.fake.calls.filter((call) => call.method === 'createJob').map((call) => call.args[0]);
  const document = JSON.parse(created.document);
  assert.equal(document.op, 'fw_pi_update');
  assert.equal(document.fw.sha256, release.sha256);
  assert.equal(document.pi.sha256, record.sha256);
  assert.equal(document.pi.minFirmware, '1.2.3+0');
  assert.ok(document.fw.url.includes(`/firmware/${release.sha256}.bin`));
  assert.ok(document.pi.url.includes(`/firmware/pi-${record.sha256}.img`));

  // A board through the combined order (firmware ota.c): the parts as the console shows them.
  const at = async (status, details) => {
    world.fake.execution(deployment.id, PI_BOARD).update(status, details);
    world.advance(2500);
    const detail = (await world.call('GET', `/api/deployments/${deployment.id}`, undefined, world.viewer)).body
      .deployment;
    return detail.executions.find((row) => row.thing === PI_BOARD);
  };
  let row = await at('IN_PROGRESS', { step: 'downloading' });
  assert.equal(row.phase, 'downloading');
  assert.equal(row.pi.state, 'waiting');
  row = await at('IN_PROGRESS', { step: 'downloading_pi', progress: '12' });
  assert.equal(row.phase, 'downloading_pi');
  assert.deepEqual(row.pi, { state: 'downloading', progress: 12, version: record.version });
  row = await at('IN_PROGRESS', { step: 'rebooting' });
  assert.equal(row.phase, 'rebooting');
  assert.equal(row.pi.state, 'on_card');
  row = await at('IN_PROGRESS', { step: 'flashing_pi', progress: '60', running: '1.2.3+4' });
  assert.equal(row.phase, 'flashing_pi');
  assert.deepEqual(row.pi, { state: 'flashing', progress: 60, version: record.version });
  row = await at('SUCCEEDED', { running: '1.2.3+4', pi_version: record.version });
  assert.equal(row.phase, 'succeeded');
  assert.deepEqual(row.pi, { state: 'flashed', progress: 100, version: record.version });

  // The other board: its firmware did not stay, so its Pi was never touched.
  world.fake.execution(deployment.id, SECOND_PI).update('FAILED', {
    reason: 'rolled_back',
    running: '1.0.0+3',
    nrf: 'not_installed',
    pi: 'not_flashed',
  });
  world.advance(2500);
  const detail = (await world.call('GET', `/api/deployments/${deployment.id}`, undefined, world.viewer)).body
    .deployment;
  const second = detail.executions.find((item) => item.thing === SECOND_PI);
  assert.equal(second.phase, 'rolled_back');
  assert.equal(second.pi.state, 'not_flashed');
});

test('a Pi that fails after its firmware stayed reads as failed, and a revoked Pi image cancels its deployments', async () => {
  const world = setup();
  addRelease(world);
  const { record } = await uploadPi(world);
  const both = (
    await world.call('POST', '/api/deployments', { version: '1.2.3+4', pi: record.version, things: [PI_BOARD] })
  ).body.deployment;
  world.fake.execution(both.id, PI_BOARD).update('FAILED', {
    reason: 'pi_verify_failed',
    running: '1.2.3+4',
    nrf: 'installed',
    pi: 'failed',
  });
  world.advance(2500);
  const row = (await world.call('GET', `/api/deployments/${both.id}`, undefined, world.viewer)).body.deployment
    .executions[0];
  assert.equal(row.reason, 'pi_verify_failed');
  assert.equal(row.pi.state, 'failed');

  // Another deployment of it, still open: revoking the image cancels it with force.
  const open = (await world.call('POST', '/api/deployments', { pi: record.version, things: [SECOND_PI] })).body
    .deployment;
  const revoked = await world.call('POST', `/api/pi-images/${record.version}/revoke`, {
    reason: 'boots to a black screen',
  });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.image.status, 'revoked');
  assert.deepEqual(revoked.body.cancelled, [open.id]);
  const cancel = world.fake.calls.filter((call) => call.method === 'cancelJob').map((call) => call.args[0]);
  assert.ok(
    cancel.some((args) => args.jobId === open.id && args.force === true && args.reasonCode === 'PI_IMAGE_REVOKED')
  );
  assert.equal(world.fake.objects.get(`firmware/pi-${record.sha256}.img`).tags.revoked, 'true');

  // And it cannot be deployed again.
  const again = await world.call('POST', '/api/deployments', { pi: record.version, things: [SECOND_PI] });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'release_revoked');
});

test('a deployment can go in waves that AWS IoT paces and stops at a failure threshold', async () => {
  const world = setup();
  const { record } = await uploadPi(world);
  const bad = await world.call('POST', '/api/deployments', {
    pi: record.version,
    things: [PI_BOARD],
    waves: { perMinute: 0, abortPercent: 20 },
  });
  assert.equal(bad.body.error.code, 'invalid_wave');
  const response = await world.call('POST', '/api/deployments', {
    pi: record.version,
    things: [PI_BOARD, SECOND_PI],
    waves: { perMinute: 1, abortPercent: 50 },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const [created] = world.fake.calls.filter((call) => call.method === 'createJob').map((call) => call.args[0]);
  assert.equal(created.rollout.exponentialRate.baseRatePerMinute, 1);
  assert.equal(created.abort.criteriaList[0].thresholdPercentage, 50);
});

test('a request with neither part, or a Pi version that is not one, is refused before anything is looked up', async () => {
  const world = setup();
  for (const [body, code] of [
    [{ things: [PI_BOARD] }, 'invalid_version'],
    [{ pi: 'has space', things: [PI_BOARD] }, 'invalid_version'],
    [{ pi: 'x'.repeat(32), things: [PI_BOARD] }, 'invalid_version'],
  ]) {
    const response = await world.call('POST', '/api/deployments', body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, code);
  }
  assert.equal((await world.call('POST', '/api/deployments', { pi: 'nope', things: [PI_BOARD] })).status, 404);
});

test('a staged rollout can bring a Pi image: boards without a Pi are left out, and its jobs carry both', async () => {
  const world = setup();
  addRelease(world);
  const { record } = await uploadPi(world);
  const response = await world.call('POST', '/api/rollouts', {
    version: '1.2.3+4',
    pi: record.version,
    target: { kind: 'fleet' },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const { rollout } = response.body;
  assert.deepEqual(rollout.pi, { version: record.version, sha256: record.sha256 });
  assert.ok(rollout.leftOut.some((item) => item.thing === PLAIN_BOARD && item.reason === 'no_pi'));
  assert.ok(!rollout.things.includes(PLAIN_BOARD));
  const [created] = world.fake.calls.filter((call) => call.method === 'createJob').map((call) => call.args[0]);
  assert.equal(JSON.parse(created.document).op, 'fw_pi_update');
  assert.ok(created.jobId.includes('-pi-'));

  // Named one by one, a board without a Pi is refused.
  const named = await world.call('POST', '/api/rollouts', {
    version: '1.2.3+4',
    pi: record.version,
    target: { kind: 'boards', things: [PLAIN_BOARD] },
  });
  assert.equal(named.status, 400);
  assert.equal(named.body.error.code, 'no_pi');
});

test('ids, documents, the shadow and the timeline of the Pi parts', () => {
  const now = Date.UTC(2026, 10, 10, 12, 0, 0);
  const id = buildJobId({ major: 1, minor: 20, revision: 0, build: 0 }, now, 'ab12', { withPi: true });
  assert.equal(id, 'cranium-1-20-0-b0-pi-20261110T120000Z-ab12');
  assert.ok(id.length <= 64);
  assert.equal(parseJobId(id).withPi, true);
  assert.equal(parseJobId(id).version, '1.20.0+0');
  assert.deepEqual(parseDeploymentId('pi-2026-11-06-1-20261110T120000Z-ab12'), {
    id: 'pi-2026-11-06-1-20261110T120000Z-ab12',
    version: null,
    parts: null,
    withPi: true,
    piOnly: true,
  });
  assert.equal(parseDeploymentId('pi-has.dot-20261110T120000Z-ab12'), null);

  // Both parts in one document, below what it is checked against before the URLs go in.
  const document = buildBundleJobDocument({
    version: '1.20.0+0',
    size: 800_000,
    sha256: 'a'.repeat(64),
    pi: {
      version: 'x'.repeat(31),
      size: 2 ** 32 - 1,
      sha256: 'b'.repeat(64),
      sig: 'c'.repeat(128),
      minFirmware: '1.20.0+0',
    },
    region: 'us-east-1',
    bucket: 'b'.repeat(63),
  });
  assert.ok(Buffer.byteLength(document) < 1024);
  assert.throws(() =>
    buildBundleJobDocument({
      version: '1.20.0+0',
      size: 1,
      sha256: 'a'.repeat(64),
      pi: { version: 'x', size: 1, sha256: 'b'.repeat(64), sig: 'short' },
      region: 'us-east-1',
      bucket: 'bucket-1',
    })
  );
  // Time limits: the firmware's 30 minutes at least, a week at most.
  assert.ok(piTimeoutMinutes(1) >= 30);
  assert.equal(piTimeoutMinutes(2 ** 32 - 1), 10_080);

  // A description with a Pi image says which, and a summary reads it back.
  const description = buildJobDescription({
    email: 'm',
    sub: 's',
    note: 'n',
    pi: { version: 'v1', sha256: 'd'.repeat(64) },
  });
  const summary = summarizeJob({
    jobId: id,
    status: 'IN_PROGRESS',
    description,
    things: [],
    createdAt: now,
    counts: {},
  });
  assert.deepEqual(summary.pi, { version: 'v1', sha256: 'd'.repeat(64) });
  assert.deepEqual(summary.parts, ['nrf', 'pi']);

  // The shadow: a board with a Pi build says so; a board without reads as it always did.
  const shadow = (reported) => ({
    state: { reported },
    metadata: { reported: { uptime: { timestamp: now / 1000 - 5 } } },
  });
  const withPi = deviceFromShadow(
    PI_BOARD,
    shadow({ ...idle(true), ota: { state: 'flashing_pi', job: id, progress: 0, last: 'none', error: '' } }),
    now
  );
  assert.deepEqual(withPi.pi, {
    state: 'idle',
    job: null,
    progress: 0,
    last: 'none',
    error: '',
    installed: null,
    card: true,
  });
  assert.equal(withPi.ota.state, 'flashing_pi');
  assert.equal(withPi.ota.job, id);
  assert.equal(Object.hasOwn(deviceFromShadow(PLAIN_BOARD, shadow(idle(false)), now), 'pi'), false);
  const odd = deviceFromShadow(PI_BOARD, shadow({ ...idle(false), pi: { state: 'exploding' } }), now);
  assert.equal(Object.hasOwn(odd, 'pi'), false);

  // The timeline: the live state a step further than the execution, and a Pi step's own progress.
  const device = { online: true, ota: { state: 'downloading_pi', job: id, progress: 0 } };
  assert.deepEqual(deriveTimeline({ status: 'IN_PROGRESS', step: 'downloading', jobId: id, device }), {
    phase: 'downloading_pi',
    progress: null,
  });
  assert.deepEqual(deriveTimeline({ status: 'IN_PROGRESS', step: 'flashing_pi', jobId: id, device, progress: 33 }), {
    phase: 'flashing_pi',
    progress: 33,
  });
  assert.deepEqual(
    deriveTimeline({ status: 'IN_PROGRESS', step: 'sending', jobId: 'pi-x', piOnly: true, progress: 5 }),
    {
      phase: 'flashing_pi',
      progress: 5,
    }
  );
});
