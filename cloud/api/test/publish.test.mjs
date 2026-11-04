// apps/android/publish.sh, which apps/android/build-release.sh runs after every build: it publishes the
// Android app on the console's Apps page with an API token, the APK going to S3 directly. Run here against
// the console's own code behind a local address, as API Gateway serves /api/t/, with the S3 stand-in of
// test/fake-apps.mjs answering the presigned PUT on the same address. The script runs from a copy of
// apps/android of its own, with a gradle.properties and a changelog the test writes.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { apiEvent, createTestConsole } from './fake-aws.mjs';

const PUBLISH = fileURLToPath(new URL('../../../apps/android/publish.sh', import.meta.url));
const hasTools = ['curl', 'python3'].every((tool) => spawnSync(tool, ['--version']).status === 0);
const skip = !hasTools && 'needs curl and python3';

const work = mkdtempSync(join(tmpdir(), 'cranium-publish-'));
after(() => rmSync(work, { recursive: true, force: true }));

const CHANGELOG = `# Android app changes

One entry per version, newest first.

## 0.5.0

Something that is not out yet.

## 0.4.0

Open the app with your fingerprint instead of the password
and code, for up to 30 days.

Commit 1c95768, 2026-11-04.

## 0.3.0

A cleaner design.
`;

let trees = 0;

/** A repository of its own: apps/android with the script, its properties and its changelog, and an APK. */
function tree({ name = '0.4.0', code = 4, changelog = CHANGELOG, bytes = Buffer.from('PK\u0003\u0004 the APK of 0.4.0') } = {}) {
  trees += 1;
  const root = join(work, `repo-${trees}`);
  const android = join(root, 'apps', 'android');
  mkdirSync(join(root, 'apps', 'dist'), { recursive: true });
  mkdirSync(android, { recursive: true });
  copyFileSync(PUBLISH, join(android, 'publish.sh'));
  chmodSync(join(android, 'publish.sh'), 0o755);
  writeFileSync(join(android, 'gradle.properties'), `craniumVersionName=${name}\ncraniumVersionCode=${code}\n`);
  writeFileSync(join(android, 'CHANGELOG.md'), changelog);
  const apk = join(root, 'apps', 'dist', `cranium-android-${name}.apk`);
  writeFileSync(apk, bytes);
  return { root, script: join(android, 'publish.sh'), apk, bytes };
}

function run(script, args, env) {
  return new Promise((resolve) => {
    const clean = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !name.startsWith('AWS_') && !name.startsWith('CRANIUM_') && !name.startsWith('ANDROID_')));
    const home = mkdtempSync(join(work, 'home-'));
    // No SDK here: the APKs of these tests are not real ones for aapt2 to read.
    const child = spawn('bash', [script, ...args], { env: { ...clean, HOME: home, CRANIUM_AAPT2: 'none', ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (status) => resolve({ status, out, err }));
  });
}

/** The console and its S3 behind one local address, with a release manager and a viewer who each have a token. */
async function consoleServer(t, { s3Refuses = false } = {}) {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  const seen = [];
  let base = '';
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    seen.push(`${request.method} ${request.url.split('?')[0]}`);
    if (request.url.startsWith('/local-s3/')) {
      const answer = s3Refuses
        ? { status: 403, headers: {}, body: Buffer.from('<Error><Code>AccessDenied</Code></Error>') }
        : console_.fake.s3Request({ method: request.method, url: `${base}${request.url}`, headers: request.headers, body });
      response.writeHead(answer.status, answer.headers);
      response.end(answer.body);
      return;
    }
    console_.advance(5000);
    const headers = request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization };
    const text = body.toString('utf8');
    const answer = await console_.app(apiEvent(request.method, request.url, { headers, body: text === '' ? undefined : text }));
    response.writeHead(answer.statusCode, answer.headers);
    response.end(answer.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  base = `http://127.0.0.1:${server.address().port}`;
  console_.fake.setS3Endpoint(`${base}/local-s3`);
  const token = async (as) => (await console_.call('POST', '/api/tokens', { as, body: { name: 'builds' } })).body.token;
  return { console_, manager, seen, url: base, managerToken: await token(manager), viewerToken: await token(viewer) };
}

test('an APK is published: the URL, the file to S3, the check, with the changelog\'s note', { skip }, async (t) => {
  const { console_, seen, url, managerToken, manager } = await consoleServer(t);
  const { script, bytes } = tree();
  const { status, out, err } = await run(script, [], { CRANIUM_TOKEN: managerToken, CRANIUM_CONSOLE_URL: url });
  assert.equal(status, 0, `${out}\n${err}`);
  assert.match(out, /Published Android app 0\.4\.0\./);
  assert.deepEqual(seen, ['POST /api/t/apps/android/uploads', 'PUT /local-s3/apps/android/cranium-android-0.4.0.apk',
    'POST /api/t/apps/android/releases/0.4.0']);
  const { body } = await console_.call('GET', '/api/apps', { as: manager });
  const [release] = body.android.releases;
  // The first paragraph of the version's entry, on one line, and nothing after it.
  assert.equal(release.notes, 'Open the app with your fingerprint instead of the password and code, for up to 30 days.');
  assert.deepEqual([release.version, release.versionCode, release.size, release.sha256],
    ['0.4.0', 4, bytes.length, createHash('sha256').update(bytes).digest('hex')]);
  for (const text of [out, err]) {
    assert.equal(text.includes(managerToken.slice(4)), false);
    assert.equal(text.includes('X-Amz-Signature'), false);
  }
});

test('the same APK again counts as published; other bytes under the same version are an error', { skip }, async (t) => {
  const { url, managerToken } = await consoleServer(t);
  const env = { CRANIUM_TOKEN: managerToken, CRANIUM_CONSOLE_URL: url };
  const first = tree();
  assert.equal((await run(first.script, [], env)).status, 0);
  const again = await run(first.script, [], env);
  assert.equal(again.status, 0, again.err);
  assert.match(again.out, /on the console already, with these same bytes/);

  const other = tree({ bytes: Buffer.from('PK\u0003\u0004 another build of 0.4.0') });
  const refused = await run(other.script, [], env);
  assert.equal(refused.status, 1);
  assert.match(refused.err, /has Android app 0\.4\.0 already, with other bytes/);
});

test('no token: nothing is tried, and the build is told how to make one', { skip }, async (t) => {
  const { seen, url } = await consoleServer(t);
  const { script } = tree();
  const { status, err } = await run(script, [], { CRANIUM_CONSOLE_URL: url });
  assert.equal(status, 2);
  assert.match(err, /Not published: no API token/);
  assert.deepEqual(seen, []);
});

test('refusals: a viewer\'s token, a version not newer, a version with no changelog entry, and S3 saying no', { skip }, async (t) => {
  const { url, managerToken, viewerToken, seen } = await consoleServer(t);
  const viewer = await run(tree().script, [], { CRANIUM_TOKEN: viewerToken, CRANIUM_CONSOLE_URL: url });
  assert.equal(viewer.status, 1);
  assert.match(viewer.err, /refused to publish 0\.4\.0 \(403\)/);
  assert.match(viewer.err, /release_manager_required/);

  const env = { CRANIUM_TOKEN: managerToken, CRANIUM_CONSOLE_URL: url };
  assert.equal((await run(tree().script, [], env)).status, 0);
  const lower = await run(tree({ name: '0.3.0', code: 3, bytes: Buffer.from('PK 0.3.0') }).script, [], env);
  assert.equal(lower.status, 1);
  assert.match(lower.err, /\(422\)/);
  assert.match(lower.err, /version_not_newer/);

  const before = seen.length;
  const unwritten = await run(tree({ name: '0.6.0', code: 6 }).script, [], env);
  assert.equal(unwritten.status, 1);
  assert.match(unwritten.err, /CHANGELOG\.md has no entry for 0\.6\.0/);
  assert.equal(seen.length, before, 'nothing was sent');

  // gradle.properties at another version: the versionCode has to be given.
  const elsewhere = tree({ name: '0.5.0', code: 5 });
  const named = join(elsewhere.root, 'apps', 'dist', 'cranium-android-0.3.0.apk');
  copyFileSync(elsewhere.apk, named);
  const unknownCode = await run(elsewhere.script, [named], env);
  assert.equal(unknownCode.status, 1);
  assert.match(unknownCode.err, /gradle\.properties is at 0\.5\.0, not 0\.3\.0/);

  const s3 = await consoleServer(t, { s3Refuses: true });
  const blocked = await run(tree({ name: '0.5.0', code: 5 }).script, [], { CRANIUM_TOKEN: s3.managerToken, CRANIUM_CONSOLE_URL: s3.url });
  assert.equal(blocked.status, 1);
  assert.match(blocked.err, /S3 refused the APK \(403, AccessDenied\)/);
  assert.equal(s3.seen.includes('POST /api/t/apps/android/releases/0.5.0'), false);
});

test('only https, except for the preview on this computer, and only an APK named as the build names it', { skip }, async () => {
  const token = `crn_${'A'.repeat(43)}`;
  const { script, root } = tree();
  const plain = await run(script, [], { CRANIUM_TOKEN: token, CRANIUM_CONSOLE_URL: 'http://console.example.com' });
  assert.equal(plain.status, 1);
  assert.match(plain.err, /must start with https:\/\//);
  const odd = join(root, 'apps', 'dist', 'app-release.apk');
  writeFileSync(odd, 'PK');
  const misnamed = await run(script, [odd], { CRANIUM_TOKEN: token, CRANIUM_CONSOLE_URL: 'https://console.example.com' });
  assert.equal(misnamed.status, 1);
  assert.match(misnamed.err, /not named as build-release\.sh names an APK/);
});

test('build-release.sh publishes at the end unless told not to, and never an APK that cannot sign in', () => {
  const script = spawnSync('bash', ['-n', fileURLToPath(new URL('../../../apps/android/build-release.sh', import.meta.url))]);
  assert.equal(script.status, 0, String(script.stderr));
  const text = spawnSync('cat', [fileURLToPath(new URL('../../../apps/android/build-release.sh', import.meta.url))]).stdout.toString();
  assert.match(text, /--no-publish\) publish=false ;;/);
  assert.match(text, /"\$ANDROID_DIR\/publish\.sh" "\$OUT"/);
  // The example configuration is checked before the publish.
  assert.ok(text.indexOf('Not published: it has the example configuration') < text.indexOf('"$ANDROID_DIR/publish.sh" "$OUT"'));
  assert.equal(spawnSync('bash', ['-n', PUBLISH]).status, 0);
});
