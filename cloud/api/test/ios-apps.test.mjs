// The iPhone app on the console (src/handlers/apps.mjs, docs/mobile-apps.md "Updates on every phone"):
// an unsigned IPA published in two calls with the file sent to S3 in between, as an APK is; what the
// console reads of it out of the zip in S3 (src/lib/ipa.mjs); once and only upward, by version and by
// build; a download link for every member; and each step on record.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { ipaKey } from '../src/lib/apps.mjs';
import { accessClaims, createTestConsole } from './fake-aws.mjs';
import { ipa } from './ipa-fixture.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function describe(version, buildVersion, bytes, notes = `What ${version} changed.`) {
  return { version, buildVersion, sha256: sha256(bytes), size: bytes.length, notes };
}

function setup() {
  const context = createTestConsole();
  const manager = context.addUser('manager', ['release-managers']);
  const viewer = context.addUser('viewer', ['viewers']);
  const call = (method, path, options) => context.call(method, path, options);
  const put = (url, headers, body) => context.fake.s3Request({ method: 'PUT', url, headers, body });

  /** The whole of a publish, as apps/ios/scripts/publish.sh does it. */
  async function publish(version, build, bytes = ipa({ version, build }), as = manager) {
    const description = describe(version, build, bytes);
    const started = await call('POST', '/api/apps/ios/uploads', { as, body: description });
    if (started.status !== 201) return started;
    const sent = put(started.body.upload.url, started.body.upload.headers, bytes);
    assert.equal(sent.status, 200, sent.body.toString());
    const { version: _, ...rest } = description;
    return call('POST', `/api/apps/ios/releases/${version}`, { as, body: rest });
  }
  return { ...context, manager, viewer, call, put, publish };
}

test('an IPA is published in two calls, checked inside, listed, and each step is on record', async () => {
  const { call, put, manager, viewer, fake, clock } = setup();
  const bytes = ipa({ version: '0.6.0', build: '8' });
  const description = describe('0.6.0', '8', bytes);

  const started = await call('POST', '/api/apps/ios/uploads', { as: manager, body: description });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.filename, 'cranium-ios-0.6.0.ipa');
  const address = new URL(started.body.upload.url);
  assert.equal(address.pathname, '/apps/ios/cranium-ios-0.6.0.ipa');
  assert.equal(address.searchParams.get('X-Amz-SignedHeaders'), 'content-length;host;x-amz-checksum-sha256');
  assert.deepEqual(started.body.upload.headers, {
    'content-length': String(bytes.length),
    'x-amz-checksum-sha256': Buffer.from(sha256(bytes), 'hex').toString('base64'),
  });
  assert.equal(put(started.body.upload.url, started.body.upload.headers, bytes).status, 200);

  const { version: _, ...rest } = description;
  const published = await call('POST', '/api/apps/ios/releases/0.6.0', { as: manager, body: rest });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  assert.deepEqual(published.body.release, {
    version: '0.6.0',
    buildVersion: '8',
    size: bytes.length,
    sha256: sha256(bytes),
    notes: 'What 0.6.0 changed.',
    filename: 'cranium-ios-0.6.0.ipa',
    bundleId: 'com.craniumiot.cranium',
    minOSVersion: '16.0',
    publishedBy: { sub: manager.sub, email: manager.email },
    publishedAt: new Date(clock.ms).toISOString(),
  });
  // What SideStore needs is kept on the record: the usage descriptions of the Info.plist.
  const item = fake.appItems.get('ios#000.006.00000');
  assert.deepEqual(Object.keys(item.privacy), ['NSBluetoothAlwaysUsageDescription', 'NSFaceIDUsageDescription']);
  assert.equal(item.versionCode, 8);

  const listed = await call('GET', '/api/apps', { as: viewer });
  assert.equal(listed.body.ios.latest, '0.6.0');
  assert.deepEqual(listed.body.ios.releases, [published.body.release]);
  // The Android list is apart from it.
  assert.deepEqual(listed.body.android, { latest: null, releases: [] });

  const entries = fake.auditLog().filter((entry) => entry.action.startsWith('app.'));
  assert.deepEqual(
    entries.map((entry) => [entry.action, entry.outcome, entry.target]),
    [
      ['app.ios_upload', 'ok', '0.6.0'],
      ['app.ios_publish', 'ok', '0.6.0'],
    ]
  );
  assert.deepEqual(entries[1].detail, { sha256: sha256(bytes), size: String(bytes.length), build: '8' });
});

test('the IPA must be the app, of the version and build described, configured for this console', async () => {
  const { call, put, manager, fake } = setup();
  const attempt = async (bytes, build = '8') => {
    const description = describe('0.6.0', build, bytes);
    const started = await call('POST', '/api/apps/ios/uploads', { as: manager, body: description });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(put(started.body.upload.url, started.body.upload.headers, bytes).status, 200);
    const { version: _, ...rest } = description;
    return call('POST', '/api/apps/ios/releases/0.6.0', { as: manager, body: rest });
  };
  for (const [bytes, pattern] of [
    [ipa({ bundleId: 'com.example.other' }), /is the app com\.example\.other, not com\.craniumiot\.cranium/],
    [ipa({ version: '0.6.1' }), /says it is version 0\.6\.1/],
    [ipa({ build: '9' }), /is build 9, not 8/],
    [ipa({ example: true }), /example configuration/],
    [ipa({ config: null }), /example configuration, or none/],
    [
      ipa({ config: { consoleUrl: 'https://another.example.invalid', mobileClientId: 'localmobile' } }),
      /another console/,
    ],
    [
      ipa({ config: { consoleUrl: 'https://console.example.invalid/', mobileClientId: 'someone-else' } }),
      /another console/,
    ],
  ]) {
    const answer = await attempt(bytes);
    assert.deepEqual([answer.status, answer.body.error.code], [422, 'ipa_mismatch'], pattern.source);
    assert.match(answer.body.error.message, pattern);
  }
  const notZip = await attempt(Buffer.from('PK but not a zip, and long enough to be read as one'.repeat(4)));
  assert.deepEqual([notZip.status, notZip.body.error.code], [422, 'ipa_unreadable']);
  assert.match(notZip.body.error.message, /cannot be read as an iPhone app: It is not a zip/);
  // A trailing slash on the console's address in cranium.json is the same console.
  const slash = await attempt(
    ipa({ config: { consoleUrl: 'https://console.example.invalid/', mobileClientId: 'localmobile' } })
  );
  assert.equal(slash.status, 201, JSON.stringify(slash.body));
  // Refused ones are on record with their codes, and nothing else was published.
  const codes = fake
    .auditLog()
    .filter((entry) => entry.action === 'app.ios_publish')
    .map((entry) => entry.detail.code ?? 'ok');
  assert.deepEqual(codes, [...Array(7).fill('ipa_mismatch'), 'ipa_unreadable', 'ok']);
});

test('what arrived is checked as for an APK: missing, another size, another SHA-256, no checksum', async () => {
  const { call, put, manager, fake } = setup();
  const bytes = ipa();
  const { version: _, ...rest } = describe('0.6.0', '8', bytes);
  const finish = (body) => call('POST', '/api/apps/ios/releases/0.6.0', { as: manager, body });
  const missing = await finish(rest);
  assert.deepEqual([missing.status, missing.body.error.code], [409, 'ipa_missing']);
  const { upload } = (await call('POST', '/api/apps/ios/uploads', { as: manager, body: describe('0.6.0', '8', bytes) }))
    .body;
  assert.equal(put(upload.url, upload.headers, bytes).status, 200);
  assert.deepEqual((await finish({ ...rest, size: bytes.length + 1 })).body.error.code, 'size_mismatch');
  assert.deepEqual((await finish({ ...rest, sha256: 'e'.repeat(64) })).body.error.code, 'sha256_mismatch');
  fake.storeApk(ipaKey('0.6.0'), bytes, { checksum: false });
  assert.deepEqual((await finish(rest)).body.error.code, 'checksum_missing');
});

test('a version is published once and only upward, by version and by build', async () => {
  const { call, manager, publish } = setup();
  assert.equal((await publish('0.6.0', '8')).status, 201);
  const again = await call('POST', '/api/apps/ios/uploads', { as: manager, body: describe('0.6.0', '8', ipa()) });
  assert.deepEqual([again.status, again.body.error.code], [409, 'version_exists']);
  assert.match(again.body.error.message, /^iPhone app 0\.6\.0 is on the console already/);
  const lower = await call('POST', '/api/apps/ios/uploads', { as: manager, body: describe('0.5.2', '7', ipa()) });
  assert.deepEqual([lower.status, lower.body.error.code], [422, 'version_not_newer']);
  assert.match(lower.body.error.message, /the newest iPhone app published/);
  const sameBuild = await call('POST', '/api/apps/ios/uploads', { as: manager, body: describe('0.7.0', '8', ipa()) });
  assert.deepEqual([sameBuild.status, sameBuild.body.error.code], [422, 'build_not_higher']);
  assert.equal((await publish('0.10.0', '10')).status, 201);
  const listed = (await call('GET', '/api/apps', { as: manager })).body.ios;
  assert.deepEqual(
    listed.releases.map((release) => release.version),
    ['0.10.0', '0.6.0']
  );
  // Android's versions are its own: an Android 0.6.0 is no iPhone 0.6.0.
  for (const [change, code] of [
    [{ buildVersion: 8 }, 'invalid_build'],
    [{ buildVersion: '08' }, 'invalid_build'],
    [{ buildVersion: '1.2' }, 'invalid_build'],
    [{ size: 100 * 1024 * 1024 + 1 }, 'invalid_size'],
    [{ version: 'x' }, 'invalid_version'],
  ]) {
    const answer = await call('POST', '/api/apps/ios/uploads', {
      as: manager,
      body: { ...describe('0.11.0', '11', ipa()), ...change },
    });
    assert.deepEqual([answer.status, answer.body.error.code], [400, code], JSON.stringify(change));
  }
});

test('only release managers publish, with a session or an API token; every member downloads, on record', async () => {
  const { call, manager, viewer, publish, fake, config, clock } = setup();
  const refused = await publish('0.6.0', '8', ipa(), viewer);
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'release_manager_required']);

  const token = (await call('POST', '/api/tokens', { as: manager, body: { name: 'builds' } })).body.token;
  const bytes = ipa();
  const description = describe('0.6.0', '8', bytes);
  const started = await call('POST', '/api/t/apps/ios/uploads', { token, body: description });
  assert.equal(started.status, 201);
  fake.s3Request({ method: 'PUT', url: started.body.upload.url, headers: started.body.upload.headers, body: bytes });
  const { version: _, ...rest } = description;
  assert.equal((await call('POST', '/api/t/apps/ios/releases/0.6.0', { token, body: rest })).status, 201);

  const link = await call('GET', '/api/apps/ios/0.6.0/download', { as: viewer });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  const address = new URL(link.body.download.url);
  assert.equal(
    address.searchParams.get('response-content-disposition'),
    'attachment; filename="cranium-ios-0.6.0.ipa"'
  );
  assert.equal(address.searchParams.get('response-content-type'), 'application/octet-stream');
  assert.equal(address.searchParams.get('X-Amz-Expires'), '900');
  assert.ok(fake.s3Request({ method: 'GET', url: link.body.download.url }).body.equals(bytes));
  assert.equal(link.body.download.sha256, sha256(bytes));
  const unknown = await call('GET', '/api/apps/ios/0.9.9/download', { as: viewer });
  assert.deepEqual([unknown.status, unknown.body.error.code], [404, 'unknown_version']);
  const downloads = fake.auditLog().filter((entry) => entry.action === 'app.ios_download');
  assert.deepEqual(
    downloads.map((entry) => [entry.outcome, entry.actor.sub, entry.target, entry.detail.via]),
    [
      ['ok', viewer.sub, '0.6.0', 'link'],
      ['rejected', viewer.sub, '0.9.9', 'link'],
    ]
  );

  // From a phone: a download is a read; publishing needs a fresh sign-in.
  const phone = accessClaims({
    sub: manager.sub,
    groups: ['release-managers'],
    clientId: config.mobileClientId,
    authTime: Math.floor(clock.ms / 1000) - 3600,
  });
  assert.equal((await call('GET', '/api/apps/ios/0.6.0/download', { claims: phone })).status, 200);
  // The iPhone app's own update (AppUpdate.swift) asks with via=app, and the log says so; nothing else is taken.
  const own = await call('GET', '/api/apps/ios/0.6.0/download', { claims: phone, query: { via: 'app' } });
  assert.equal(own.status, 200);
  assert.equal(own.body.download.sha256, sha256(bytes));
  assert.equal(
    fake
      .auditLog()
      .filter((entry) => entry.action === 'app.ios_download')
      .at(-1).detail.via,
    'app'
  );
  const odd = await call('GET', '/api/apps/ios/0.6.0/download', { claims: phone, query: { via: 'x' } });
  assert.deepEqual([odd.status, odd.body.error.code], [400, 'invalid_via']);
  const change = await call('POST', '/api/apps/ios/uploads', { claims: phone, body: describe('0.7.0', '9', ipa()) });
  assert.deepEqual([change.status, change.body.error.code], [403, 'phone_sign_in_again']);
});

test('the Android app may ask for its own update link, which says so in the log', async () => {
  const { call, viewer, manager, fake, put } = setup();
  const bytes = Buffer.alloc(4096, 1);
  const body = { version: '0.6.0', versionCode: 6, sha256: sha256(bytes), size: bytes.length, notes: 'n' };
  const { upload } = (await call('POST', '/api/apps/android/uploads', { as: manager, body })).body;
  put(upload.url, upload.headers, bytes);
  const { version: _, ...rest } = body;
  assert.equal((await call('POST', '/api/apps/android/releases/0.6.0', { as: manager, body: rest })).status, 201);
  assert.equal(
    (await call('GET', '/api/apps/android/0.6.0/download', { as: viewer, query: { via: 'app' } })).status,
    200
  );
  assert.equal(
    fake
      .auditLog()
      .filter((entry) => entry.action === 'app.download')
      .at(-1).detail.via,
    'app'
  );
});
