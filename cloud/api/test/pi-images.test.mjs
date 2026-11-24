// Raspberry Pi images updated by blocks through the board (handlers/pi-images.mjs, lib/pi-images.mjs): the
// package's header checked as a board checks it, the upload straight to S3 and the check of what arrived, the
// estimate against what each board holds, the pi_delta job, its progress and its cancellation. The packages are
// the ones tools/pi_image.py of PR #279 made (fixtures/pi-delta.json), signed with a key made for the test.

import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { loadSigningKey } from '../src/lib/mcuboot.mjs';
import {
  MAX_TIMEOUT_MIN,
  MIN_TIMEOUT_MIN,
  buildPiJobDocument,
  buildPiJobId,
  decodeManifest,
  downloadEstimate,
  packageSize,
  parsePiJobId,
  piExecutionDetails,
  piObjectKey,
  readPi,
  signatureHolds,
  takesPiDelta,
  timeoutMinutes,
} from '../src/lib/pi-images.mjs';
import { readReported } from '../src/lib/shadow.mjs';
import { createTestConsole } from './fake-aws.mjs';

const fixtures = new URL('./fixtures/', import.meta.url);
const FIXTURE = JSON.parse(readFileSync(new URL('pi-delta.json', fixtures), 'utf8'));
const PUBLIC_PEM = readFileSync(new URL('pi_test_signing_pub.pem', fixtures), 'utf8');
const PUBLIC_DER = createPublicKey(PUBLIC_PEM).export({ type: 'spki', format: 'der' });
const KEY = loadSigningKey(PUBLIC_PEM);
const OTHER_KEY = loadSigningKey(readFileSync(new URL('other_signing_pub.pem', fixtures), 'utf8'));

const PI_BOARD = 'cranium-fe5b26c0c5b1dcd7';
const SECOND_PI_BOARD = 'cranium-1111111111111111';
const OLD_PI_BOARD = 'cranium-0123456789abcdef';
const PLAIN_BOARD = 'cranium-2222222222222222';

/** The image of a fixture package, rebuilt from the rule in its "about". */
function imageOf(part) {
  const out = Buffer.alloc(part.blocks * 4096);
  for (let block = 0; block < part.blocks; block += 1) {
    out.fill((block * 37 + (part.changed.includes(block) ? 101 : 0)) & 0xff, block * 4096, (block + 1) * 4096);
  }
  return out.subarray(0, out.length - part.cut);
}

/** The whole package: header, table, zeros to the image, the image. */
function packageOf(part) {
  const head = Buffer.from(part.header + part.table, 'hex');
  const pad = Buffer.alloc(part.imageOffset - head.length);
  return Buffer.concat([head, pad, imageOf(part)]);
}

const header = (part) => Buffer.from(part.header, 'hex');
const table = (part) => Buffer.from(part.table, 'hex');

function setup() {
  const world = createTestConsole({ env: { SIGNING_PUBLIC_KEY_B64: PUBLIC_DER.toString('base64') } });
  const manager = world.addUser('manager', ['release-managers']);
  const viewer = world.addUser('viewer', ['viewers']);
  const report = (thing, fw, pi) =>
    world.fake.device(thing).report({ fw: { version: fw, confirmed: true }, uptime: 60, ...(pi ? { pi } : {}) });
  for (const thing of [PI_BOARD, SECOND_PI_BOARD, OLD_PI_BOARD, PLAIN_BOARD]) world.fake.addThing(thing);
  const ready = (version) => ({ card: 'ready', version, generation: 1, step: 'idle', done: 0, total: 0 });
  report(PI_BOARD, '1.20.0+0', ready(FIXTURE.old.version));
  report(SECOND_PI_BOARD, '1.20.1+0', { card: 'empty', version: '', generation: 0, step: 'idle', done: 0, total: 0 });
  // A Pi build's report on firmware before 1.20.0 cannot be; a board that says so is refused all the same.
  report(OLD_PI_BOARD, '1.19.3+0', ready(FIXTURE.old.version));
  report(PLAIN_BOARD, '1.20.0+0', null);
  return { world, manager, viewer, report };
}

/** Upload and check a fixture package, as the Firmware page does. */
async function uploaded(world, manager, part, { body = packageOf(part) } = {}) {
  const described = await world.call('POST', '/api/pi-images', {
    as: manager,
    body: { header: part.header, notes: '' },
  });
  assert.equal(described.status, 201, JSON.stringify(described.body));
  const key = piObjectKey(part.version, decodeManifest(header(part)).sha256);
  assert.equal(world.fake.piUploads.receive(key, body).stored, true);
  return world.call('POST', `/api/pi-images/${encodeURIComponent(part.version)}/verify`, { as: manager });
}

// --- the formats, against the real tool ------------------------------------------------------------

test('the header tools/pi_image.py wrote reads as the board reads it, and its signature holds', () => {
  const old = decodeManifest(header(FIXTURE.old));
  assert.equal(old.version, '2026.11.10-1');
  assert.equal(old.blockSize, 4096);
  assert.equal(old.blocks, 10);
  assert.equal(old.imageSize, 40960);
  assert.equal(packageSize(old), FIXTURE.old.size);
  const next = decodeManifest(header(FIXTURE.new));
  assert.equal(next.version, '2026.11.24-1+r2');
  assert.equal(next.imageSize, 44032);
  assert.equal(packageSize(next), FIXTURE.new.size);
  assert.equal(signatureHolds(header(FIXTURE.new), KEY), true);
  assert.equal(signatureHolds(header(FIXTURE.new), OTHER_KEY), false);
});

test('any change to the signed bytes, or to the signature, makes it fail', () => {
  for (const offset of [0x08, 40, 72, 104, 300, 447, 448, 511]) {
    const raw = header(FIXTURE.new);
    raw[offset] ^= 0x01;
    let holds = false;
    try {
      decodeManifest(raw);
      holds = signatureHolds(raw, KEY);
    } catch {
      holds = false;
    }
    assert.equal(holds, false, `byte ${offset}`);
  }
});

test('a header a board refuses is refused, in words', () => {
  const cases = [
    [(raw) => raw.write('XPDM', 0, 'ascii'), /not the header/],
    [(raw) => raw.writeUInt32LE(3000, 8), /block size/],
    [(raw) => raw.writeUInt32LE(9, 12), /block count/],
    [(raw) => raw.writeBigUInt64LE(40961n, 16), /sectors/],
    [(raw) => raw.writeBigUInt64LE(1024n, 24), /offsets/],
    [(raw) => raw.writeBigUInt64LE(4097n, 32), /offsets/],
    [(raw) => raw.write('bad version!', 104, 'latin1'), /version/],
    [(raw) => raw.fill(0, 104, 136), /version/],
    [(raw) => raw.writeUInt32LE(1, 136), /flags/],
    [(raw) => (raw[200] = 1), /reserved/],
  ];
  for (const [spoil, words] of cases) {
    const raw = header(FIXTURE.old);
    spoil(raw);
    assert.throws(() => decodeManifest(raw), words);
  }
  assert.throws(() => decodeManifest(Buffer.alloc(100)), /512 bytes/);
});

test('the estimate is what tools/pi_image.py diff said', () => {
  const old = { ...decodeManifest(header(FIXTURE.old)), table: table(FIXTURE.old) };
  const next = { ...decodeManifest(header(FIXTURE.new)), table: table(FIXTURE.new) };
  const estimate = downloadEstimate(old, next);
  assert.deepEqual(
    {
      blocks: estimate.blocks,
      changed: estimate.changed,
      bytes: estimate.bytes,
      image_bytes: estimate.imageBytes,
      runs: estimate.runs,
    },
    FIXTURE.diff
  );
  // From nothing, or from another block size: every block.
  assert.equal(downloadEstimate(null, next).changed, 11);
  assert.equal(downloadEstimate(null, next).bytes, 512 + 11 * 32 + 44032);
  assert.equal(downloadEstimate({ ...old, blockSize: 8192 }, next).changed, 11);
  // The same image: nothing.
  assert.equal(downloadEstimate(next, next).changed, 0);
});

test('the object key, the job id, the document and the time limit', () => {
  const sha = 'a'.repeat(64);
  assert.equal(piObjectKey('2026.11.24-1+r2', sha), `firmware/pi-2026.11.24-1~r2-${sha}.cpd`);
  const id = buildPiJobId('2026.11.24-1+r2', Date.UTC(2026, 10, 24, 12, 30, 5), 'beef');
  assert.equal(id, 'pi-2026-11-24-1-r2-20261124T123005Z-beef');
  assert.ok(id.length <= 64);
  assert.equal(parsePiJobId(id).createdAt, Date.UTC(2026, 10, 24, 12, 30, 5));
  assert.equal(parsePiJobId('cranium-1-20-0-b0-20261124T123005Z-beef'), null);
  assert.equal(parsePiJobId('gold-1-19-3-b0-c1-20261124T123005Z-beef'), null);
  const longest = buildPiJobId('a'.repeat(31), Date.UTC(2026, 10, 24), '0000');
  assert.ok(longest.length <= 64);

  const document = buildPiJobDocument({
    version: '2026.11.24-1+r2',
    sha256: sha,
    key: piObjectKey('2026.11.24-1+r2', sha),
    region: 'us-east-1',
    bucket: 'example-bucket',
  });
  assert.deepEqual(JSON.parse(document), {
    op: 'pi_delta',
    v: 1,
    pi: {
      version: '2026.11.24-1+r2',
      sha256: sha,
      url: `\${aws:iot:s3-presigned-url-v2:https://s3.us-east-1.amazonaws.com/example-bucket/firmware/pi-2026.11.24-1~r2-${sha}.cpd}`,
    },
  });
  assert.ok(Buffer.byteLength(document) < 512);

  assert.equal(timeoutMinutes(0), MIN_TIMEOUT_MIN);
  assert.equal(timeoutMinutes(50 * 1024 * 1024), MIN_TIMEOUT_MIN);
  assert.equal(timeoutMinutes(4 * 1024 ** 3), MAX_TIMEOUT_MIN);
  assert.ok(timeoutMinutes(200 * 1024 * 1024) > MIN_TIMEOUT_MIN);
});

test("a board's reports on its job are read key by key, and nothing else", () => {
  assert.deepEqual(piExecutionDetails({ step: 'blocks', progress: '42', done: '120', total: '340', extra: 'x' }), {
    step: 'blocks',
    progress: 42,
    done: 120,
    total: 340,
    piVersion: null,
    generation: null,
    fetched: null,
    changed: null,
    bytes: null,
    reason: null,
    running: null,
  });
  const done = piExecutionDetails({
    pi_version: '2026.11.24-1',
    generation: '3',
    fetched: '37',
    changed: '40',
    bytes: '2424832',
    running: '1.20.0+0',
  });
  assert.equal(done.piVersion, '2026.11.24-1');
  assert.equal(done.fetched, 37);
  assert.equal(done.bytes, 2424832);
  assert.equal(done.running, '1.20.0+0');
  const failed = piExecutionDetails({ reason: 'digest_mismatch', step: 'blocks' });
  assert.equal(failed.reason, 'digest_mismatch');
  const junk = piExecutionDetails({
    step: 'flying',
    progress: '101',
    done: '-1',
    reason: 'Bad Reason',
    pi_version: '../x',
  });
  assert.deepEqual([junk.step, junk.progress, junk.done, junk.reason, junk.piVersion], [null, null, null, null, null]);
  assert.equal(piExecutionDetails(null).step, null);
});

test("a board's card is read from its shadow, and only while its heartbeat carries it", () => {
  const pi = { card: 'ready', version: '2026.11.24-1', generation: 2, step: 'idle', done: 0, total: 0 };
  const stamp = (at) => ({ timestamp: at });
  const metadata = (piAt, beatAt) => ({ pi: { card: stamp(piAt) }, uptime: stamp(beatAt) });
  assert.deepEqual(readPi({ pi }, metadata(1000, 1000)), pi);
  assert.deepEqual(readReported({ fw: { version: '1.20.0+0' }, pi }, metadata(1000, 1030)).pi, pi);
  // A report the last heartbeats did not carry: firmware the board no longer runs.
  assert.equal(readPi({ pi }, metadata(1000, 2000)), null);
  assert.equal(readReported({ fw: { version: '1.20.0+0' }, pi }, metadata(1000, 2000)).pi, undefined);
  assert.equal(readPi({ pi: { ...pi, card: 'flying' } }, metadata(1, 1)), null);
  assert.equal(readPi({}, undefined), null);
  assert.equal(readPi({ pi: { ...pi, version: '' } }, metadata(1, 1)).version, null);
  assert.equal(readPi({ pi: { ...pi, step: 'x', done: -3 } }, metadata(1, 1)).step, 'idle');
  assert.equal(readReported({ fw: { version: '1.19.3+0' } }).pi, undefined);

  assert.equal(takesPiDelta({ fw: { version: '1.20.0+0' }, pi }), true);
  assert.equal(takesPiDelta({ fw: { version: '1.21.3+7' }, pi }), true);
  assert.equal(takesPiDelta({ fw: { version: '1.19.3+0' }, pi }), false);
  assert.equal(takesPiDelta({ fw: { version: '1.20.0+0' } }), false);
  assert.equal(takesPiDelta({ fw: null, pi }), false);
});

// --- the API ---------------------------------------------------------------------------------------

test('only a release manager uploads, and a header whose signature does not hold is refused before anything is stored', async () => {
  const { world, manager, viewer } = setup();
  const asViewer = await world.call('POST', '/api/pi-images', { as: viewer, body: { header: FIXTURE.new.header } });
  assert.equal(asViewer.status, 403);

  const raw = header(FIXTURE.new);
  raw[100] ^= 0x01; // inside the table's SHA-256: still well-formed, and covered by the signature
  const spoiled = await world.call('POST', '/api/pi-images', { as: manager, body: { header: raw.toString('hex') } });
  assert.equal(spoiled.status, 422);
  assert.equal(spoiled.body.error.code, 'bad_signature');
  assert.equal(world.fake.piUploads.issued.length, 0);
  assert.deepEqual(await world.fake.listFleetItems('PIIMG'), []);

  const malformed = await world.call('POST', '/api/pi-images', { as: manager, body: { header: '00'.repeat(512) } });
  assert.equal(malformed.status, 422);
  assert.equal(malformed.body.error.code, 'bad_manifest');
  const short = await world.call('POST', '/api/pi-images', { as: manager, body: { header: 'abcd' } });
  assert.equal(short.status, 400);
  assert.equal(short.body.error.code, 'invalid_header');
  assert.equal(world.fake.piUploads.issued.length, 0);

  // The audit log has the refusal.
  const audit = await world.call('GET', '/api/audit', { as: manager });
  assert.ok(audit.body.entries.some((entry) => entry.action === 'firmware.pi_upload' && entry.outcome === 'rejected'));
});

test('an upload: a URL for exactly the package, then what arrived is checked, and the image can be deployed', async () => {
  const { world, manager } = setup();
  const described = await world.call('POST', '/api/pi-images', {
    as: manager,
    body: { header: FIXTURE.new.header, notes: 'Mixxx 2.5.1 and its settings' },
  });
  assert.equal(described.status, 201);
  assert.equal(described.body.image.status, 'uploading');
  assert.equal(described.body.image.kind, 'pi');
  assert.equal(described.body.image.version, '2026.11.24-1+r2');
  assert.equal(described.body.upload.method, 'PUT');
  assert.equal(described.body.upload.size, FIXTURE.new.size);
  assert.deepEqual(described.body.upload.headers, { 'if-none-match': '*' });
  assert.equal(world.fake.piUploads.issued[0].size, FIXTURE.new.size);
  assert.match(world.fake.piUploads.issued[0].key, /^firmware\/pi-2026\.11\.24-1~r2-[0-9a-f]{64}\.cpd$/);

  // Nothing has arrived yet.
  const early = await world.call('POST', '/api/pi-images/2026.11.24-1+r2/verify', { as: manager });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'pi_not_uploaded');
  // The same header again gets a new URL: an upload that broke off starts over.
  const again = await world.call('POST', '/api/pi-images', { as: manager, body: { header: FIXTURE.new.header } });
  assert.equal(again.status, 201);
  assert.equal(world.fake.piUploads.issued.length, 2);

  const key = world.fake.piUploads.issued[0].key;
  assert.equal(world.fake.piUploads.receive(key, packageOf(FIXTURE.new)).stored, true);
  // A "+" in a path arrives as a space from some clients.
  const checked = await world.call('POST', '/api/pi-images/2026.11.24-1 r2/verify', { as: manager });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.image.status, 'active');
  assert.equal(checked.body.image.blocks, 11);

  const listed = await world.call('GET', '/api/pi-images', { as: manager });
  assert.equal(listed.body.images.length, 1);
  assert.equal(listed.body.images[0].status, 'active');
  assert.equal(listed.body.images[0].notes, 'Mixxx 2.5.1 and its settings');
  assert.equal(listed.body.images[0].header, undefined);
  assert.equal(listed.body.firstFirmware, '1.20.0');

  // A version is used once.
  const taken = await world.call('POST', '/api/pi-images', { as: manager, body: { header: FIXTURE.new.header } });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'version_exists');

  const audit = await world.call('GET', '/api/audit', { as: manager });
  const actions = audit.body.entries.map((entry) => `${entry.action} ${entry.outcome}`);
  assert.ok(actions.includes('firmware.pi_upload ok'));
  assert.ok(actions.includes('firmware.pi_verify ok'));
});

test('a package whose table is not the one the header signs is refused, and the bucket stops serving it', async () => {
  const { world, manager } = setup();
  const body = packageOf(FIXTURE.new);
  body[600] ^= 0xff; // inside the table
  const checked = await uploaded(world, manager, FIXTURE.new, { body });
  assert.equal(checked.status, 422);
  assert.equal(checked.body.error.code, 'pi_package_mismatch');
  const key = world.fake.piUploads.issued[0].key;
  assert.equal(world.fake.piUploads.object(key).tags.revoked, 'true');
  const listed = await world.call('GET', '/api/pi-images', { as: manager });
  assert.equal(listed.body.images[0].status, 'refused');
  const deploy = await world.call('POST', '/api/pi-images/2026.11.24-1+r2/deploy', {
    as: manager,
    body: { things: [PI_BOARD], note: '' },
  });
  assert.equal(deploy.status, 409);
  assert.equal(deploy.body.error.code, 'pi_image_refused');
});

test('a package of another size is refused', async () => {
  const { world, manager } = setup();
  const checked = await uploaded(world, manager, FIXTURE.new, { body: packageOf(FIXTURE.new).subarray(0, 40000) });
  assert.equal(checked.status, 422);
  assert.match(checked.body.error.message, /40000 bytes arrived/);
});

test('the estimate is against what each board holds: its card, else its last Pi deployment, else nothing', async () => {
  const { world, manager, report } = setup();
  assert.equal((await uploaded(world, manager, FIXTURE.old)).status, 200);
  assert.equal((await uploaded(world, manager, FIXTURE.new)).status, 200);
  const estimate = await world.call('GET', '/api/pi-images/2026.11.24-1+r2/estimate', { as: manager });
  assert.equal(estimate.status, 200);
  const byThing = new Map(estimate.body.boards.map((board) => [board.thing, board]));
  // Boards without a Pi are not in it.
  assert.equal(byThing.has(PLAIN_BOARD), false);
  // The card holds the old image: what tools/pi_image.py diff said.
  const pi = byThing.get(PI_BOARD);
  assert.equal(pi.from, '2026.11.10-1');
  assert.equal(pi.fromSource, 'card');
  assert.deepEqual([pi.blocks, pi.changed, pi.bytes, pi.runs], [11, 3, 12128, 3]);
  // An empty card: every block.
  const empty = byThing.get(SECOND_PI_BOARD);
  assert.equal(empty.from, null);
  assert.equal(empty.changed, 11);
  assert.equal(empty.bytes, 512 + 11 * 32 + 44032);

  // A card that holds an image the console never stored: every block at most, and said so.
  report(SECOND_PI_BOARD, '1.20.1+0', {
    card: 'ready',
    version: 'hand-made-1',
    generation: 1,
    step: 'idle',
    done: 0,
    total: 0,
  });
  world.advance(10_000);
  const unknown = (
    await world.call('GET', '/api/pi-images/2026.11.24-1+r2/estimate', { as: manager })
  ).body.boards.find((board) => board.thing === SECOND_PI_BOARD);
  assert.equal(unknown.fromKnown, false);
  assert.equal(unknown.changed, 11);

  // A card that is updating: the last Pi deployment that succeeded on the board counts.
  const deployed = await world.call('POST', '/api/pi-images/2026.11.10-1/deploy', {
    as: manager,
    body: { things: [SECOND_PI_BOARD], note: '' },
  });
  assert.equal(deployed.status, 201, JSON.stringify(deployed.body));
  const id = deployed.body.deployment.id;
  world.fake.execution(id, SECOND_PI_BOARD).update('IN_PROGRESS', { step: 'manifest' });
  world.fake.execution(id, SECOND_PI_BOARD).update('SUCCEEDED', {
    pi_version: '2026.11.10-1',
    generation: '2',
    fetched: '10',
    changed: '10',
    bytes: '41824',
    running: '1.20.1+0',
  });
  report(SECOND_PI_BOARD, '1.20.1+0', {
    card: 'updating',
    version: 'other',
    generation: 2,
    step: 'blocks',
    done: 1,
    total: 9,
  });
  world.advance(10_000);
  const after = (await world.call('GET', '/api/pi-images/2026.11.24-1+r2/estimate', { as: manager })).body.boards.find(
    (board) => board.thing === SECOND_PI_BOARD
  );
  assert.equal(after.from, '2026.11.10-1');
  assert.equal(after.fromSource, 'deployment');
  assert.equal(after.changed, 3);
});

test('a deployment goes only to boards with a Pi build of 1.20.0 or later, as a pi_delta job', async () => {
  const { world, manager, viewer } = setup();
  await uploaded(world, manager, FIXTURE.old);
  await uploaded(world, manager, FIXTURE.new);
  const path = '/api/pi-images/2026.11.24-1+r2/deploy';

  for (const thing of [PLAIN_BOARD, OLD_PI_BOARD]) {
    const refused = await world.call('POST', path, { as: manager, body: { things: [PI_BOARD, thing], note: '' } });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'pi_unsupported');
    assert.match(refused.body.error.message, new RegExp(thing));
  }
  assert.equal((await world.call('POST', path, { as: viewer, body: { things: [PI_BOARD], note: '' } })).status, 403);
  const stranger = await world.call('POST', path, {
    as: manager,
    body: { things: ['cranium-9999999999999999'], note: '' },
  });
  assert.equal(stranger.status, 422);
  assert.equal(world.fake.methodsCalled().includes('createJob'), false);

  const created = await world.call('POST', path, {
    as: manager,
    body: { things: [PI_BOARD, SECOND_PI_BOARD], note: 'Mixxx 2.5.1' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { deployment } = created.body;
  assert.match(deployment.id, /^pi-2026-11-24-1-r2-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
  assert.equal(deployment.version, '2026.11.24-1+r2');
  assert.deepEqual(deployment.things, [SECOND_PI_BOARD, PI_BOARD].sort());

  const call = world.fake.calls.find((item) => item.method === 'createJob');
  const [{ document, urlExpiresInSec, inProgressTimeoutMinutes, description }] = call.args;
  assert.equal(urlExpiresInSec, 3600);
  assert.ok(inProgressTimeoutMinutes >= MIN_TIMEOUT_MIN);
  const parsed = JSON.parse(document);
  assert.equal(parsed.op, 'pi_delta');
  assert.equal(parsed.v, 1);
  assert.equal(parsed.pi.version, '2026.11.24-1+r2');
  assert.equal(parsed.pi.sha256, decodeManifest(header(FIXTURE.new)).sha256);
  assert.match(
    parsed.pi.url,
    /^\$\{aws:iot:s3-presigned-url-v2:https:\/\/s3\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9.-]+\/firmware\/pi-2026\.11\.24-1~r2-[0-9a-f]{64}\.cpd\}$/
  );
  assert.equal(JSON.parse(description).pi, '2026.11.24-1+r2');
  // What the board gets.
  assert.equal(world.fake.device(PI_BOARD).nextJob().document.op, 'pi_delta');

  // A Pi job is no firmware deployment: the Deployments list does not have it.
  const firmware = await world.call('GET', '/api/deployments', { as: manager });
  assert.equal(firmware.body.deployments.length, 0);

  // A board with an unfinished job takes no other.
  const busy = await world.call('POST', path, { as: manager, body: { things: [PI_BOARD], note: '' } });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, 'device_busy');
});

test('progress: blocks fetched of the changed ones while it runs, then the result', async () => {
  const { world, manager } = setup();
  await uploaded(world, manager, FIXTURE.old);
  await uploaded(world, manager, FIXTURE.new);
  const created = await world.call('POST', '/api/pi-images/2026.11.24-1+r2/deploy', {
    as: manager,
    body: { things: [PI_BOARD, SECOND_PI_BOARD], note: '' },
  });
  const { id } = created.body.deployment;
  world.fake.execution(id, PI_BOARD).update('IN_PROGRESS', { step: 'blocks', progress: '33', done: '1', total: '3' });
  world.fake.execution(id, SECOND_PI_BOARD).update('IN_PROGRESS', { step: 'manifest' });
  world.advance(5000);
  let shown = (await world.call('GET', '/api/pi-images', { as: manager })).body.deployments[0];
  assert.equal(shown.id, id);
  assert.equal(shown.version, '2026.11.24-1+r2');
  assert.equal(shown.counts.inProgress, 2);
  const rows = new Map(shown.executions.map((row) => [row.thing, row]));
  assert.deepEqual(
    [rows.get(PI_BOARD).step, rows.get(PI_BOARD).progress, rows.get(PI_BOARD).done, rows.get(PI_BOARD).total],
    ['blocks', 33, 1, 3]
  );
  assert.equal(rows.get(SECOND_PI_BOARD).step, 'manifest');

  world.fake.execution(id, PI_BOARD).update('SUCCEEDED', {
    pi_version: '2026.11.24-1+r2',
    generation: '2',
    fetched: '3',
    changed: '3',
    bytes: '12128',
    running: '1.20.0+0',
  });
  world.fake
    .execution(id, SECOND_PI_BOARD)
    .update('FAILED', { reason: 'sd_absent', step: 'table', running: '1.20.1+0' });
  world.advance(5000);
  shown = (await world.call('GET', '/api/pi-images', { as: manager })).body.deployments[0];
  const ended = new Map(shown.executions.map((row) => [row.thing, row]));
  assert.equal(ended.get(PI_BOARD).status, 'SUCCEEDED');
  assert.deepEqual(
    [ended.get(PI_BOARD).fetched, ended.get(PI_BOARD).changed, ended.get(PI_BOARD).bytes],
    [3, 3, 12128]
  );
  assert.equal(ended.get(PI_BOARD).piVersion, '2026.11.24-1+r2');
  assert.equal(ended.get(SECOND_PI_BOARD).status, 'FAILED');
  assert.equal(ended.get(SECOND_PI_BOARD).reason, 'sd_absent');
  assert.equal(shown.counts.succeeded, 1);
  assert.equal(shown.counts.failed, 1);
});

test('a Pi deployment is cancelled, with force for boards at work, and on record', async () => {
  const { world, manager } = setup();
  await uploaded(world, manager, FIXTURE.new);
  const created = await world.call('POST', '/api/pi-images/2026.11.24-1+r2/deploy', {
    as: manager,
    body: { things: [SECOND_PI_BOARD], note: '' },
  });
  const { id } = created.body.deployment;
  world.fake
    .execution(id, SECOND_PI_BOARD)
    .update('IN_PROGRESS', { step: 'blocks', progress: '5', done: '1', total: '11' });
  const bad = await world.call('POST', '/api/pi-deployments/cranium-1-20-0-b0-20261124T123005Z-beef/cancel', {
    as: manager,
    body: {},
  });
  assert.equal(bad.status, 400);
  const cancelled = await world.call('POST', `/api/pi-deployments/${id}/cancel`, {
    as: manager,
    body: { force: true },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.deployment.status, 'CANCELED');
  const again = await world.call('POST', `/api/pi-deployments/${id}/cancel`, { as: manager, body: {} });
  assert.equal(again.status, 409);
  const audit = await world.call('GET', '/api/audit', { as: manager });
  const entry = audit.body.entries.find((item) => item.action === 'deployment.pi_cancel' && item.outcome === 'ok');
  assert.ok(entry);
  assert.equal(entry.target, id);
  assert.ok(
    audit.body.entries.some((item) => item.action === 'deployment.pi_create' && item.target === '2026.11.24-1+r2')
  );
});

test('a package larger than one upload, or than a card holds, is refused', async () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = keys.publicKey.export({ type: 'spki', format: 'der' });
  const world = createTestConsole({ env: { SIGNING_PUBLIC_KEY_B64: der.toString('base64') } });
  const manager = world.addUser('manager', ['release-managers']);
  /** The real header with its sizes changed, signed again with the test's own key. */
  const signed = ({ blockSize, blocks, imageSize, imageOffset }) => {
    const raw = header(FIXTURE.new);
    raw.writeUInt32LE(blockSize, 8);
    raw.writeUInt32LE(blocks, 12);
    raw.writeBigUInt64LE(BigInt(imageSize), 16);
    raw.writeBigUInt64LE(BigInt(imageOffset), 32);
    sign('sha256', raw.subarray(0, 448), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).copy(raw, 448);
    return raw.toString('hex');
  };
  // 6 GiB in 1 MiB blocks: more than one PUT carries.
  const big = signed({ blockSize: 1 << 20, blocks: 6144, imageSize: 6 * 1024 ** 3, imageOffset: 4096 * 50 });
  const tooBig = await world.call('POST', '/api/pi-images', { as: manager, body: { header: big } });
  assert.equal(tooBig.status, 422, JSON.stringify(tooBig.body));
  assert.equal(tooBig.body.error.code, 'pi_too_large');
  // 4 GiB in 4 KiB blocks: 1,048,576 blocks, more than a card's layout holds.
  const blocks = 1024 * 1024;
  const many = signed({
    blockSize: 4096,
    blocks,
    imageSize: 4 * 1024 ** 3,
    imageOffset: Math.ceil((512 + blocks * 32) / 4096) * 4096,
  });
  const tooMany = await world.call('POST', '/api/pi-images', { as: manager, body: { header: many } });
  assert.equal(tooMany.status, 422);
  assert.equal(tooMany.body.error.code, 'pi_too_large');
  assert.match(tooMany.body.error.message, /262144/);
  assert.equal(world.fake.piUploads.issued.length, 0);
  // The same header signed with this key and its own sizes passes.
  const fine = signed({ blockSize: 4096, blocks: 11, imageSize: 44032, imageOffset: FIXTURE.new.imageOffset });
  assert.equal((await world.call('POST', '/api/pi-images', { as: manager, body: { header: fine } })).status, 201);
});
