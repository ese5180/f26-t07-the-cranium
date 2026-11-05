// Each member's SideStore source (src/handlers/sidestore.mjs, src/lib/sidestore.mjs): a link made on the
// website and shown once, stored as its digest, replaced or turned off by its owner; what SideStore
// reads with no sign-in, in AltStore's source format; a download that answers 302 with a fresh
// presigned S3 link and goes on record in the owner's name; and every way a link stops working.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { SOURCE_USES_PER_MINUTE, buildSource, sourceKeyOf } from '../src/lib/sidestore.mjs';
import { accessClaims, createTestConsole } from './fake-aws.mjs';
import { ipa } from './ipa-fixture.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CONSOLE = 'https://console.example.invalid';

function setup() {
  const context = createTestConsole();
  const manager = context.addUser('manager', ['release-managers']);
  const viewer = context.addUser('viewer', ['viewers']);
  const call = (method, path, options) => context.call(method, path, options);

  async function publish(version, build) {
    const bytes = ipa({ version, build, padding: 4096 + Number(build) });
    const description = { version, buildVersion: build, sha256: sha256(bytes), size: bytes.length, notes: `What ${version} changed.` };
    const started = await call('POST', '/api/apps/ios/uploads', { as: manager, body: description });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    context.fake.s3Request({ method: 'PUT', url: started.body.upload.url, headers: started.body.upload.headers, body: bytes });
    const { version: _, ...rest } = description;
    const done = await call('POST', `/api/apps/ios/releases/${version}`, { as: manager, body: rest });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    return bytes;
  }

  /** What SideStore asks for: a GET with no sign-in at all, at the path of a URL the console gave. */
  const sidestore = (url) => call('GET', new URL(url).pathname);
  return { ...context, manager, viewer, call, publish, sidestore };
}

test('a member makes a link, shown once; SideStore reads the source with it, with no sign-in', async () => {
  const { call, viewer, manager, publish, sidestore, fake, clock, advance } = setup();
  await publish('0.6.0', '8');
  advance(60_000);
  const newest = await publish('0.6.1', '9');

  assert.deepEqual((await call('GET', '/api/apps/sidestore', { as: viewer })).body, { source: null, perMinute: SOURCE_USES_PER_MINUTE });
  const made = await call('POST', '/api/apps/sidestore', { as: viewer, body: {} });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const { url, add, source } = made.body;
  const key = url.split('/')[5];
  assert.ok(sourceKeyOf(key), url);
  assert.equal(url, `${CONSOLE}/api/sidestore/${key}/source.json`);
  assert.equal(add, `sidestore://source?url=${encodeURIComponent(url)}`);
  assert.deepEqual(Object.keys(source), ['id', 'createdAt', 'lastUsedAt']);
  // The key is never stored, only its digest; the owner's list shows the id, never the key again.
  const stored = JSON.stringify([...fake.sourceItems.values()]);
  assert.equal(stored.includes(key), false);
  assert.ok(stored.includes(sha256(key)));
  const shown = await call('GET', '/api/apps/sidestore', { as: viewer });
  assert.equal(JSON.stringify(shown.body).includes(key), false);
  assert.equal(shown.body.source.id, source.id);

  const read = await sidestore(url);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.headers['cache-control'], 'no-store');
  const body = read.body;
  assert.deepEqual([body.name, body.identifier, body.sourceURL], ['Cranium', 'com.craniumiot.cranium.source', url]);
  assert.match(body.iconURL, /^https:\/\/raw\.githubusercontent\.com\/ese5180\/f26-t07-the-cranium\/main\/apps\/ios\//);
  const [app] = body.apps;
  assert.equal(body.apps.length, 1);
  assert.deepEqual([app.name, app.bundleIdentifier, app.category], ['Cranium', 'com.craniumiot.cranium', 'utilities']);
  for (const field of ['developerName', 'localizedDescription', 'iconURL']) assert.equal(typeof app[field], 'string', field);
  assert.deepEqual(app.appPermissions, {
    entitlements: [],
    privacy: {
      NSBluetoothAlwaysUsageDescription: 'Cranium uses Bluetooth to find a board whose Bluetooth window is open.',
      NSFaceIDUsageDescription: 'Cranium uses Face ID to open your saved sign-in.',
    },
  });
  // Newest first, each with what SideStore checks of the file it downloads, and a date it can read.
  assert.deepEqual(app.versions.map((version) => [version.version, version.buildVersion]), [['0.6.1', '9'], ['0.6.0', '8']]);
  assert.deepEqual(app.versions[0], {
    version: '0.6.1', buildVersion: '9', date: new Date(clock.ms).toISOString().replace('.000Z', 'Z'),
    localizedDescription: 'What 0.6.1 changed.', downloadURL: `${CONSOLE}/api/sidestore/${key}/cranium-ios-0.6.1.ipa`,
    size: newest.length, sha256: sha256(newest), minOSVersion: '16.0',
  });
  assert.match(app.versions[0].date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  // The download is a redirect to a fresh presigned GET of the IPA, which S3 serves.
  const got = await sidestore(app.versions[0].downloadURL);
  assert.equal(got.status, 302);
  assert.equal(got.body, null);
  assert.equal(got.headers['cache-control'], 'no-store');
  const location = new URL(got.headers.location);
  assert.equal(location.pathname, '/apps/ios/cranium-ios-0.6.1.ipa');
  assert.equal(location.searchParams.get('X-Amz-Expires'), '300');
  assert.ok(fake.s3Request({ method: 'GET', url: got.headers.location }).body.equals(newest));
  // On record in the owner's name, with the link's id; the source itself is not.
  const entries = fake.auditLog().filter((entry) => entry.action.startsWith('app.source') || entry.action === 'app.ios_download');
  assert.deepEqual(entries.map((entry) => [entry.action, entry.outcome, entry.actor.sub, entry.actor.email, entry.target]), [
    ['app.source_create', 'ok', viewer.sub, viewer.email, source.id],
    ['app.ios_download', 'ok', viewer.sub, viewer.email, '0.6.1'],
  ]);
  assert.deepEqual(entries[1].detail, { via: 'sidestore', source: source.id, sha256: sha256(newest) });
  // The owner sees when it was last used.
  assert.equal((await call('GET', '/api/apps/sidestore', { as: viewer })).body.source.lastUsedAt, new Date(clock.ms).toISOString());
  // A release manager's link is the same; each member has their own.
  const theirs = (await call('POST', '/api/apps/sidestore', { as: manager, body: {} })).body;
  assert.notEqual(theirs.source.id, source.id);
  assert.equal((await sidestore(theirs.url)).status, 200);
  assert.equal((await sidestore(url)).status, 200);
});

test('the log never holds the key; a dead key gets one 404 that names nothing, and leaves no entry', async () => {
  const { call, viewer, manager, publish, sidestore, fake, logs } = setup();
  await publish('0.6.0', '8');
  const first = (await call('POST', '/api/apps/sidestore', { as: viewer, body: {} })).body;
  const key = first.url.split('/')[5];
  assert.equal((await sidestore(first.url)).status, 200);
  assert.equal(JSON.stringify(logs).includes(key), false);
  const line = logs.find((entry) => entry.route === 'GET /api/sidestore/{key}/source.json');
  assert.deepEqual([line.status, line.via, line.source, line.sub], [200, 'sidestore', first.source.id, viewer.sub]);

  // A new link ends the old one at once.
  const second = (await call('POST', '/api/apps/sidestore', { as: viewer, body: {} })).body;
  assert.notEqual(second.url, first.url);
  const before = fake.auditLog().length;
  const dead = await sidestore(first.url);
  assert.deepEqual([dead.status, dead.body.error.code], [404, 'unknown_source']);
  assert.equal((await sidestore(first.url.replace('source.json', 'cranium-ios-0.6.0.ipa'))).status, 404);
  assert.equal((await sidestore(second.url)).status, 200);

  // Turned off: every address of it is the same 404.
  assert.equal((await call('POST', '/api/apps/sidestore/revoke', { as: viewer, body: {} })).status, 200);
  assert.equal((await call('GET', '/api/apps/sidestore', { as: viewer })).body.source, null);
  for (const url of [second.url, second.url.replace('source.json', 'cranium-ios-0.6.0.ipa')]) {
    const answer = await sidestore(url);
    assert.deepEqual([answer.status, answer.body.error.code], [404, 'unknown_source'], url);
  }
  const again = await call('POST', '/api/apps/sidestore/revoke', { as: viewer, body: {} });
  assert.deepEqual([again.status, again.body.error.code], [404, 'no_source']);
  // Made-up and malformed keys, another spelling of the same bytes, and other files.
  const made = `crs_${'A'.repeat(43)}`;
  const spelling = key.slice(0, -1) + String.fromCharCode(key.charCodeAt(key.length - 1) ^ 1);
  for (const path of [`/api/sidestore/${made}/source.json`, '/api/sidestore/crs_short/source.json', `/api/sidestore/${spelling}/source.json`]) {
    assert.equal((await call('GET', path)).body.error.code, 'unknown_source', path);
  }
  for (const path of [`/api/sidestore/${made}/apps.json`, `/api/sidestore/${made}/cranium-ios-0.6.ipa`, `/api/sidestore/${made}`,
    `/api/sidestore/${made}/source.json/more`]) {
    const answer = await call('GET', path);
    assert.ok([404].includes(answer.status), path);
  }
  // None of the refusals above went on record; the revocation and the two links did.
  const added = fake.auditLog().slice(before).map((entry) => [entry.action, entry.outcome]);
  assert.deepEqual(added, [['app.source_revoke', 'ok'], ['app.source_revoke', 'rejected']]);
  // Another member's revocation does not reach this member's link.
  const third = (await call('POST', '/api/apps/sidestore', { as: viewer, body: {} })).body;
  assert.equal((await call('POST', '/api/apps/sidestore/revoke', { as: manager, body: {} })).body.error.code, 'no_source');
  assert.equal((await sidestore(third.url)).status, 200);
});

test('someone who is no longer a member takes their source with them; the use of a key is limited', async () => {
  const { call, viewer, publish, sidestore, fake, advance } = setup();
  await publish('0.6.0', '8');
  const { url } = (await call('POST', '/api/apps/sidestore', { as: viewer, body: {} })).body;
  for (let use = 0; use < SOURCE_USES_PER_MINUTE; use += 1) assert.equal((await sidestore(url)).status, 200, String(use));
  const limited = await sidestore(url);
  assert.deepEqual([limited.status, limited.body.error.code], [429, 'rate_limited']);
  advance(60_000);
  assert.equal((await sidestore(url)).status, 200);

  fake.user(viewer.sub).setGroups([]);
  const gone = await sidestore(url);
  assert.deepEqual([gone.status, gone.body.error.code], [404, 'unknown_source']);
  fake.user(viewer.sub).setGroups(['viewers']);
  assert.equal((await sidestore(url)).status, 200);
  fake.user(viewer.sub).disable();
  assert.equal((await sidestore(url)).status, 404);
  fake.user(viewer.sub).enable();
  fake.user(viewer.sub).remove();
  assert.equal((await sidestore(url)).status, 404);
});

test('a link is made and turned off on the website only, by its owner: not with a token or the phone', async () => {
  const { call, viewer, config, clock } = setup();
  const token = (await call('POST', '/api/tokens', { as: viewer, body: { name: 'mine' } })).body.token;
  const byToken = await call('POST', '/api/t/apps/sidestore', { token, body: {} });
  assert.deepEqual([byToken.status, byToken.body.error.code], [403, 'token_not_allowed']);
  assert.equal((await call('GET', '/api/t/apps/sidestore', { token })).status, 403);
  const phone = accessClaims({ sub: viewer.sub, groups: ['viewers'], clientId: config.mobileClientId, authTime: Math.floor(clock.ms / 1000) });
  assert.deepEqual((await call('POST', '/api/apps/sidestore', { claims: phone, body: {} })).body.error.code, 'phone_not_allowed');
  // Another member's link is theirs alone.
  const other = await call('POST', '/api/apps/sidestore/revoke', { as: viewer, body: {} });
  assert.equal(other.body.error.code, 'no_source');
});

test('the source lists nothing until an IPA is published, and declares every version\'s usage descriptions', () => {
  const empty = buildSource({ consoleUrl: `${CONSOLE}/`, key: 'crs_k', releases: [] });
  assert.deepEqual([empty.apps, empty.news, empty.sourceURL], [[], [], `${CONSOLE}/api/sidestore/crs_k/source.json`]);
  const release = (version, privacy, publishedAt = '2026-11-05T12:00:00.000Z') => ({
    version, buildVersion: '1', publishedAt, notes: '', filename: `cranium-ios-${version}.ipa`, size: 1, sha256: 'a'.repeat(64),
    minOSVersion: null, bundleId: 'com.craniumiot.cranium', privacy,
  });
  const built = buildSource({
    consoleUrl: CONSOLE,
    key: 'crs_k',
    releases: [release('0.7.0', { NSFaceIDUsageDescription: 'new words' }), release('0.6.0', { NSCameraUsageDescription: 'c', NSFaceIDUsageDescription: 'old' }),
      release('0.5.0', {}, null)],
  });
  assert.deepEqual(built.apps[0].appPermissions.privacy, { NSCameraUsageDescription: 'c', NSFaceIDUsageDescription: 'new words' });
  assert.deepEqual(built.apps[0].versions.map((version) => version.version), ['0.7.0', '0.6.0']);
  assert.equal(Object.hasOwn(built.apps[0].versions[0], 'minOSVersion'), false);
});
