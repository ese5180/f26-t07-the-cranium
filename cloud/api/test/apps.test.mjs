// The phone apps on the console (src/handlers/apps.mjs, docs/mobile-apps.md): publishing the Android
// app in two calls with the file sent to S3 in between, the checks of what arrived, once and only
// upward, the download link, the apps' configuration, and the console's own version.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { apkKey, parseAppVersion } from '../src/lib/apps.mjs';
import { parseBundledVersions } from '../src/lib/versions.mjs';
import { accessClaims, createTestConsole } from './fake-aws.mjs';

const COMMIT = '1036507aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'.slice(0, 40);
const VERSIONS = parseBundledVersions({
  console: { version: '1.9.1', commit: COMMIT, tree: 'clean' },
  changelogs: {
    console: [{ version: '1.9.1', note: 'Phone sessions can last 30 days.' }],
    ios: [{ version: '0.4.0', note: 'Open the app with Face ID.' }, { version: '0.3.0', note: 'Older.' }],
    android: [{ version: '0.4.0', note: 'Open the app with your fingerprint.' }],
    firmware: [],
  },
});

/** Bytes that stand for an APK of a version: what matters is their size and their SHA-256. */
function apk(version, size = 4096) {
  const bytes = Buffer.alloc(size);
  Buffer.from(`PK\u0003\u0004 cranium-android-${version}`).copy(bytes);
  return bytes;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function describe(version, versionCode, bytes, notes = `What ${version} changed.`) {
  return { version, versionCode, sha256: sha256(bytes), size: bytes.length, notes };
}

function setup() {
  const context = createTestConsole({ versions: VERSIONS });
  const manager = context.addUser('manager', ['release-managers']);
  const viewer = context.addUser('viewer', ['viewers']);
  const call = (method, path, options) => context.call(method, path, options);
  const put = (url, headers, body) => context.fake.s3Request({ method: 'PUT', url, headers, body });

  /** The whole of a publish, as apps/android/publish.sh does it. */
  async function publish(version, versionCode, bytes = apk(version), as = manager) {
    const description = describe(version, versionCode, bytes);
    const started = await call('POST', '/api/apps/android/uploads', { as, body: description });
    if (started.status !== 201) return started;
    const sent = put(started.body.upload.url, started.body.upload.headers, bytes);
    assert.equal(sent.status, 200, sent.body.toString());
    const { version: _, ...rest } = description;
    return call('POST', `/api/apps/android/releases/${version}`, { as, body: rest });
  }
  return { ...context, manager, viewer, call, put, publish };
}

test('an APK is published in two calls with the file sent to S3 in between, and listed', async () => {
  const { call, put, manager, viewer, fake, clock } = setup();
  const bytes = apk('0.4.0', 12_027_314 % 50_000);
  const description = describe('0.4.0', 4, bytes);

  const started = await call('POST', '/api/apps/android/uploads', { as: manager, body: description });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { upload } = started.body;
  assert.equal(started.body.filename, 'cranium-android-0.4.0.apk');
  assert.equal(upload.method, 'PUT');
  assert.equal(upload.expiresAt, new Date(clock.ms + 15 * 60_000).toISOString());
  // The size and the SHA-256 are signed: S3 takes the PUT only with exactly these.
  assert.deepEqual(upload.headers, {
    'content-length': String(bytes.length),
    'x-amz-checksum-sha256': Buffer.from(sha256(bytes), 'hex').toString('base64'),
  });
  const address = new URL(upload.url);
  assert.equal(address.origin, 'https://local-firmware.s3.us-east-1.amazonaws.com');
  assert.equal(address.pathname, '/apps/android/cranium-android-0.4.0.apk');
  assert.equal(address.searchParams.get('X-Amz-SignedHeaders'), 'content-length;host;x-amz-checksum-sha256');
  assert.equal(address.searchParams.get('X-Amz-Expires'), '900');
  assert.equal(address.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');

  // Nothing is published until what arrived is checked.
  assert.deepEqual((await call('GET', '/api/apps', { as: viewer })).body.android, { latest: null, releases: [] });
  assert.equal(put(upload.url, upload.headers, bytes).status, 200);
  const { version: _, ...rest } = description;
  const published = await call('POST', '/api/apps/android/releases/0.4.0', { as: manager, body: rest });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  assert.deepEqual(published.body.release, {
    version: '0.4.0', versionCode: 4, size: bytes.length, sha256: sha256(bytes), notes: 'What 0.4.0 changed.',
    filename: 'cranium-android-0.4.0.apk', publishedBy: { sub: manager.sub, email: manager.email },
    publishedAt: new Date(clock.ms).toISOString(),
  });

  // Every member sees it, and the iPhone app's version and note from the changelog the deployment was built with.
  const listed = await call('GET', '/api/apps', { as: viewer });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.android.latest, '0.4.0');
  assert.deepEqual(listed.body.android.releases, [published.body.release]);
  assert.deepEqual(listed.body.ios, { version: '0.4.0', notes: 'Open the app with Face ID.' });
  assert.deepEqual(listed.body.console, { version: '1.9.1', commit: COMMIT });

  // Both calls are on record, with what the APK is; the note is on the release, not in the log.
  const entries = fake.auditLog().filter((entry) => entry.action.startsWith('app.'));
  assert.deepEqual(entries.map((entry) => [entry.action, entry.outcome, entry.target, entry.actor.sub]), [
    ['app.upload', 'ok', '0.4.0', manager.sub], ['app.publish', 'ok', '0.4.0', manager.sub],
  ]);
  assert.deepEqual(entries[1].detail, { sha256: sha256(bytes), size: String(bytes.length), versionCode: '4' });
});

test('S3 takes only the bytes the URL was made for, and only for 15 minutes', async () => {
  const { call, put, manager, fake, advance } = setup();
  const bytes = apk('0.4.0');
  const { upload } = (await call('POST', '/api/apps/android/uploads', { as: manager, body: describe('0.4.0', 4, bytes) })).body;
  const other = apk('0.4.0');
  other[100] = 1;
  // Other bytes of the same size: refused by their checksum. Another size: by the signature.
  assert.equal(put(upload.url, upload.headers, other).status, 400);
  const longer = Buffer.concat([bytes, Buffer.from('x')]);
  assert.equal(put(upload.url, { ...upload.headers, 'content-length': String(longer.length) }, longer).status, 403);
  // Another checksum header, even the right one for other bytes: the signature does not hold.
  assert.equal(put(upload.url, { ...upload.headers, 'x-amz-checksum-sha256': createHash('sha256').update(other).digest('base64') }, other).status, 403);
  // Without the signed headers at all.
  assert.equal(put(upload.url, {}, bytes).status, 403);
  assert.deepEqual(fake.apkVersions(apkKey('0.4.0')), []);
  advance(15 * 60_000 + 1000);
  assert.equal(put(upload.url, upload.headers, bytes).status, 403);
  assert.deepEqual(fake.apkVersions(apkKey('0.4.0')), []);
});

test('the check of what arrived refuses a missing file, another size, another SHA-256 and one with no checksum', async () => {
  const { call, put, manager, fake } = setup();
  const bytes = apk('0.4.0');
  const { version: _, ...rest } = describe('0.4.0', 4, bytes);
  const finish = (body) => call('POST', '/api/apps/android/releases/0.4.0', { as: manager, body });

  const missing = await finish(rest);
  assert.deepEqual([missing.status, missing.body.error.code], [409, 'apk_missing']);

  const { upload } = (await call('POST', '/api/apps/android/uploads', { as: manager, body: describe('0.4.0', 4, bytes) })).body;
  assert.equal(put(upload.url, upload.headers, bytes).status, 200);
  const size = await finish({ ...rest, size: bytes.length + 1 });
  assert.deepEqual([size.status, size.body.error.code], [422, 'size_mismatch']);
  const digest = await finish({ ...rest, sha256: 'e'.repeat(64) });
  assert.deepEqual([digest.status, digest.body.error.code], [422, 'sha256_mismatch']);
  // The body may name the version too, but only the one in the address.
  const elsewhere = await finish({ ...rest, version: '0.5.0' });
  assert.deepEqual([elsewhere.status, elsewhere.body.error.code], [400, 'invalid_version']);

  // An object put some other way, as a multipart upload would leave it: no SHA-256 of the file.
  fake.storeApk(apkKey('0.4.0'), bytes, { checksum: false });
  const unchecked = await finish(rest);
  assert.deepEqual([unchecked.status, unchecked.body.error.code], [422, 'checksum_missing']);
  assert.deepEqual((await call('GET', '/api/apps', { as: manager })).body.android.releases, []);

  // Each refusal is on record as rejected, with its code.
  const refused = fake.auditLog().filter((entry) => entry.action === 'app.publish').map((entry) => [entry.outcome, entry.detail.code]);
  assert.deepEqual(refused, [['rejected', 'apk_missing'], ['rejected', 'size_mismatch'], ['rejected', 'sha256_mismatch'],
    ['rejected', 'invalid_version'], ['rejected', 'checksum_missing']]);
});

test('a version is published once and only upward, by its version and by its versionCode', async () => {
  const { call, manager, publish, fake } = setup();
  assert.equal((await publish('0.4.0', 4)).status, 201);

  // The same version again: refused before a URL is handed out, with the same bytes or others.
  const again = await call('POST', '/api/apps/android/uploads', { as: manager, body: describe('0.4.0', 4, apk('0.4.0')) });
  assert.deepEqual([again.status, again.body.error.code], [409, 'version_exists']);
  const { version: _, ...rest } = describe('0.4.0', 4, apk('0.4.0'));
  const twice = await call('POST', '/api/apps/android/releases/0.4.0', { as: manager, body: rest });
  assert.deepEqual([twice.status, twice.body.error.code], [409, 'version_exists']);

  const lower = await call('POST', '/api/apps/android/uploads', { as: manager, body: describe('0.3.0', 3, apk('0.3.0')) });
  assert.deepEqual([lower.status, lower.body.error.code], [422, 'version_not_newer']);
  assert.match(lower.body.error.message, /0\.4\.0, the newest Android app published/);
  const sameCode = await call('POST', '/api/apps/android/uploads', { as: manager, body: describe('0.5.0', 4, apk('0.5.0')) });
  assert.deepEqual([sameCode.status, sameCode.body.error.code], [422, 'version_code_not_higher']);
  // 0.10.0 is above 0.9.0, as numbers and not as text.
  assert.equal((await publish('0.9.0', 9)).status, 201);
  assert.equal((await publish('0.10.0', 10)).status, 201);
  const listed = (await call('GET', '/api/apps', { as: manager })).body.android;
  assert.deepEqual(listed.releases.map((release) => release.version), ['0.10.0', '0.9.0', '0.4.0']);
  assert.equal(listed.latest, '0.10.0');

  // Two publishes of the same new version at once: one of them is registered.
  const bytes = apk('0.11.0');
  const first = describe('0.11.0', 11, bytes);
  const urls = await Promise.all([1, 2].map(() => call('POST', '/api/apps/android/uploads', { as: manager, body: first })));
  assert.deepEqual(urls.map((answer) => answer.status), [201, 201]);
  fake.s3Request({ method: 'PUT', url: urls[0].body.upload.url, headers: urls[0].body.upload.headers, body: bytes });
  const { version: __, ...body } = first;
  const results = await Promise.all([1, 2].map(() => call('POST', '/api/apps/android/releases/0.11.0', { as: manager, body })));
  assert.deepEqual(results.map((answer) => answer.status).sort(), [201, 409]);
});

test('what a publish says of its APK is checked before anything is handed out', async () => {
  const { call, manager, fake } = setup();
  const good = describe('0.4.0', 4, apk('0.4.0'));
  for (const [change, code] of [
    [{ version: '0.4' }, 'invalid_version'], [{ version: '0.4.0+1' }, 'invalid_version'], [{ version: '00.4.0' }, 'invalid_version'],
    [{ versionCode: 0 }, 'invalid_version_code'], [{ versionCode: '4' }, 'invalid_version_code'],
    [{ versionCode: 2_100_000_001 }, 'invalid_version_code'],
    [{ size: 0 }, 'invalid_size'], [{ size: 100 * 1024 * 1024 + 1 }, 'invalid_size'], [{ size: 1.5 }, 'invalid_size'],
    [{ sha256: 'A'.repeat(64) }, 'invalid_sha256'], [{ sha256: 'a'.repeat(63) }, 'invalid_sha256'],
    [{ notes: 'one\nline' }, 'invalid_notes'], [{ notes: 'x'.repeat(501) }, 'invalid_notes'],
  ]) {
    const answer = await call('POST', '/api/apps/android/uploads', { as: manager, body: { ...good, ...change } });
    assert.deepEqual([answer.status, answer.body.error.code], [400, code], JSON.stringify(change));
  }
  const path = await call('POST', '/api/apps/android/releases/latest', { as: manager, body: good });
  assert.deepEqual([path.status, path.body.error.code], [400, 'invalid_version']);
  assert.equal(fake.calls.some((entry) => entry.method === 'presignAppUpload'), false);
});

test('only a release manager publishes; every member downloads, and each link is on record', async () => {
  const { call, manager, viewer, publish, fake, clock } = setup();
  const bytes = apk('0.4.0');
  assert.equal((await publish('0.4.0', 4, bytes)).status, 201);

  const refused = await publish('0.5.0', 5, apk('0.5.0'), viewer);
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'release_manager_required']);
  const { version: _, ...rest } = describe('0.5.0', 5, apk('0.5.0'));
  const notYours = await call('POST', '/api/apps/android/releases/0.5.0', { as: viewer, body: rest });
  assert.deepEqual([notYours.status, notYours.body.error.code], [403, 'release_manager_required']);

  const link = await call('GET', '/api/apps/android/0.4.0/download', { as: viewer });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  const { download } = link.body;
  assert.deepEqual({ ...download, url: undefined }, {
    url: undefined, expiresAt: new Date(clock.ms + 15 * 60_000).toISOString(), version: '0.4.0',
    filename: 'cranium-android-0.4.0.apk', size: bytes.length, sha256: sha256(bytes),
  });
  const address = new URL(download.url);
  assert.equal(address.searchParams.get('response-content-disposition'), 'attachment; filename="cranium-android-0.4.0.apk"');
  assert.equal(address.searchParams.get('response-content-type'), 'application/vnd.android.package-archive');
  assert.equal(address.searchParams.get('X-Amz-Expires'), '900');
  // Of the version of the object that was checked.
  const [checked] = fake.apkVersions(apkKey('0.4.0'));
  assert.equal(address.searchParams.get('versionId'), checked.versionId);
  const served = fake.s3Request({ method: 'GET', url: download.url });
  assert.equal(served.status, 200);
  assert.ok(served.body.equals(bytes));
  assert.equal(served.headers['content-disposition'], 'attachment; filename="cranium-android-0.4.0.apk"');

  // Whatever is put under the same key later, that link and every new one still serve what was checked.
  fake.storeApk(apkKey('0.4.0'), apk('0.4.0', 10));
  assert.ok(fake.s3Request({ method: 'GET', url: download.url }).body.equals(bytes));
  const later = (await call('GET', '/api/apps/android/0.4.0/download', { as: manager, query: { via: 'qr' } })).body.download;
  assert.ok(fake.s3Request({ method: 'GET', url: later.url }).body.equals(bytes));

  const unknown = await call('GET', '/api/apps/android/0.9.9/download', { as: viewer });
  assert.deepEqual([unknown.status, unknown.body.error.code], [404, 'unknown_version']);
  const via = await call('GET', '/api/apps/android/0.4.0/download', { as: viewer, query: { via: 'mail' } });
  assert.deepEqual([via.status, via.body.error.code], [400, 'invalid_via']);

  const downloads = fake.auditLog().filter((entry) => entry.action === 'app.download');
  assert.deepEqual(downloads.map((entry) => [entry.outcome, entry.actor.sub, entry.target, entry.detail.via ?? null]), [
    ['ok', viewer.sub, '0.4.0', 'link'], ['ok', manager.sub, '0.4.0', 'qr'],
    ['rejected', viewer.sub, '0.9.9', 'link'], ['rejected', viewer.sub, '0.4.0', null],
  ]);
});

test('with an API token a release manager publishes, as the build does; a token never makes one a viewer can use to', async () => {
  const { call, manager, viewer, fake } = setup();
  const token = (await call('POST', '/api/tokens', { as: manager, body: { name: 'builds' } })).body.token;
  const theirs = (await call('POST', '/api/tokens', { as: viewer, body: { name: 'mine' } })).body.token;
  const bytes = apk('0.4.0');
  const description = describe('0.4.0', 4, bytes);
  const started = await call('POST', '/api/t/apps/android/uploads', { token, body: description });
  assert.equal(started.status, 201);
  fake.s3Request({ method: 'PUT', url: started.body.upload.url, headers: started.body.upload.headers, body: bytes });
  const { version: _, ...rest } = description;
  const published = await call('POST', '/api/t/apps/android/releases/0.4.0', { token, body: rest });
  assert.equal(published.status, 201);
  assert.equal((await call('GET', '/api/t/apps', { token })).body.android.latest, '0.4.0');
  const entry = fake.auditLog().find((item) => item.action === 'app.publish');
  assert.match(entry.detail.token, /^[0-9a-f]{16}$/);

  const viewers = await call('POST', '/api/t/apps/android/uploads', { token: theirs, body: describe('0.5.0', 5, apk('0.5.0')) });
  assert.deepEqual([viewers.status, viewers.body.error.code], [403, 'release_manager_required']);
  assert.equal((await call('GET', '/api/t/apps', { token: theirs })).status, 200);
});

test('from a phone, a download and the configuration are reads; starting a publish is a change', async () => {
  const { call, manager, publish, config, clock } = setup();
  assert.equal((await publish('0.4.0', 4)).status, 201);
  // Signed in on the phone an hour ago, and unlocked with the fingerprint since: no fresh sign-in.
  const phone = accessClaims({
    sub: manager.sub, groups: ['release-managers'], clientId: config.mobileClientId, authTime: Math.floor(clock.ms / 1000) - 3600,
  });
  assert.equal((await call('GET', '/api/apps', { claims: phone })).status, 200);
  assert.equal((await call('GET', '/api/apps/config', { claims: phone })).status, 200);
  assert.equal((await call('GET', '/api/apps/android/0.4.0/download', { claims: phone })).status, 200);
  const change = await call('POST', '/api/apps/android/uploads', { claims: phone, body: describe('0.5.0', 5, apk('0.5.0')) });
  assert.deepEqual([change.status, change.body.error.code], [403, 'phone_sign_in_again']);
  const { version: _, ...rest } = describe('0.5.0', 5, apk('0.5.0'));
  const finish = await call('POST', '/api/apps/android/releases/0.5.0', { claims: phone, body: rest });
  assert.deepEqual([finish.status, finish.body.error.code], [403, 'phone_sign_in_again']);
});

test('the apps\' configuration is apps/config/cranium.json, from the stack, for every member', async () => {
  const { call, viewer } = setup();
  const answer = await call('GET', '/api/apps/config', { as: viewer });
  assert.equal(answer.status, 200);
  // Exactly the keys of the file, in its order, as apps/configure.sh writes them.
  assert.deepEqual(Object.keys(answer.body), ['consoleUrl', 'loginDomain', 'mobileClientId', 'redirectUri', 'region', 'userPoolId']);
  assert.deepEqual(answer.body, {
    consoleUrl: 'https://console.example.invalid',
    loginDomain: 'https://local.auth.us-east-1.amazoncognito.com',
    mobileClientId: 'localmobile',
    redirectUri: 'cranium://signin',
    region: 'us-east-1',
    userPoolId: 'us-east-1_local',
  });
  // The stack's ConsoleUrl ends in a slash; the configuration's does not.
  const other = createTestConsole({ env: { CONSOLE_URL: 'https://console.craniumiot.com/' } });
  const someone = other.addUser('someone', ['viewers']);
  assert.equal((await other.call('GET', '/api/apps/config', { as: someone })).body.consoleUrl, 'https://console.craniumiot.com');
  const nobody = other.addUser('nobody', []);
  assert.equal((await other.call('GET', '/api/apps/config', { as: nobody })).status, 403);
});

test('GET /api/me carries the console\'s version and commit; without versions.json they are null', async () => {
  const { call, viewer } = setup();
  const me = await call('GET', '/api/me', { as: viewer });
  assert.deepEqual(me.body.console, { version: '1.9.1', commit: COMMIT });
  assert.equal(me.body.email, viewer.email);

  const bare = createTestConsole({ versions: parseBundledVersions(null) });
  const someone = bare.addUser('someone', ['viewers']);
  assert.deepEqual((await bare.call('GET', '/api/me', { as: someone })).body.console, { version: null, commit: null });
  assert.deepEqual((await bare.call('GET', '/api/apps', { as: someone })).body.ios, { version: null, notes: '' });
});

test('what versions.json says is taken only where it has the form it should', () => {
  assert.deepEqual(parseBundledVersions({ console: { version: '1.9', commit: 'abc' }, changelogs: { ios: [{ version: 'x' }] } }),
    { console: { version: null, commit: null }, ios: null, android: null });
  const noted = parseBundledVersions({ console: {}, changelogs: { ios: [{ version: '0.4.0', note: 'a\u0000b‮c' }] } });
  assert.deepEqual(noted.ios, { version: '0.4.0', note: 'a b c' });
  assert.equal(parseAppVersion('0.4.0').patch, 0);
  assert.equal(parseAppVersion('1.2.3.4'), null);
});
