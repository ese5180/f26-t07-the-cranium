// apps/ios/scripts/publish.sh, which the release workflow runs after apps/ios/scripts/build-ipa.sh: it publishes
// the iPhone app on the console with an API token, the IPA going to S3 directly. Run here against the console's
// own code behind a local address, as API Gateway serves /api/t/, with the S3 stand-in of test/fake-apps.mjs
// answering the presigned PUT on the same address, as publish.test.mjs does for the Android app's script. The
// script runs from a copy of apps/ios of its own, with a project.yml and a changelog the test writes, and
// IPAs made by test/ipa-fixture.mjs.

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
import { ipa } from './ipa-fixture.mjs';

const PUBLISH = fileURLToPath(new URL('../../../apps/ios/scripts/publish.sh', import.meta.url));
const hasTools = ['curl', 'python3'].every((tool) => spawnSync(tool, ['--version']).status === 0);
const skip = !hasTools && 'needs curl and python3';

const work = mkdtempSync(join(tmpdir(), 'cranium-ios-publish-'));
after(() => rmSync(work, { recursive: true, force: true }));

const CHANGELOG = `# iPhone app changes

## Unreleased

Not a version.

## 0.6.0

Updates on every iPhone, with SideStore,
from your own source on the Apps page.

2026-11-05.

## 0.5.2

Plain words.
`;

let trees = 0;

/** A repository of its own: apps/ios with the script, its project.yml and its changelog, and an IPA. */
function tree({ version = '0.6.0', build = '8', changelog = CHANGELOG, bytes = ipa({ version, build }), file } = {}) {
  trees += 1;
  const root = join(work, `repo-${trees}`);
  const ios = join(root, 'apps', 'ios');
  mkdirSync(join(root, 'apps', 'dist'), { recursive: true });
  mkdirSync(join(ios, 'scripts'), { recursive: true });
  copyFileSync(PUBLISH, join(ios, 'scripts', 'publish.sh'));
  chmodSync(join(ios, 'scripts', 'publish.sh'), 0o755);
  writeFileSync(join(ios, 'project.yml'), `settings:\n  base:\n    MARKETING_VERSION: "${version}"\n    CURRENT_PROJECT_VERSION: "${build}"\n`);
  writeFileSync(join(ios, 'CHANGELOG.md'), changelog);
  const path = join(root, 'apps', 'dist', file ?? `cranium-ios-${version}.ipa`);
  writeFileSync(path, bytes);
  return { root, script: join(ios, 'scripts', 'publish.sh'), path, bytes };
}

function run(script, args, env) {
  return new Promise((resolve) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AWS_') && !name.startsWith('CRANIUM_')));
    const home = mkdtempSync(join(work, 'home-'));
    const child = spawn('bash', [script, ...args], { env: { ...clean, HOME: home, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (status) => resolve({ status, out, err }));
  });
}

/** The console and its S3 behind one local address, with a release manager who has a token. */
async function consoleServer(t) {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  const seen = [];
  let base = '';
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    seen.push(`${request.method} ${request.url.split('?')[0]}`);
    if (request.url.startsWith('/local-s3/')) {
      const answer = console_.fake.s3Request({ method: request.method, url: `${base}${request.url}`, headers: request.headers, body });
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
  const token = (await console_.call('POST', '/api/tokens', { as: manager, body: { name: 'builds' } })).body.token;
  return { console_, manager, seen, url: base, token };
}

test('an IPA is published: its build from its Info.plist, the changelog\'s note, the file to S3, the check', { skip }, async (t) => {
  const { console_, seen, url, token, manager } = await consoleServer(t);
  const { script, bytes } = tree();
  const { status, out, err } = await run(script, [], { CRANIUM_TOKEN: token, CRANIUM_CONSOLE_URL: url });
  assert.equal(status, 0, `${out}\n${err}`);
  assert.match(out, /Publishing iPhone app 0\.6\.0 \(build 8, \d+ bytes\)/);
  assert.match(out, /Published iPhone app 0\.6\.0\. Every member's SideStore source lists it now\./);
  assert.deepEqual(seen, ['POST /api/t/apps/ios/uploads', 'PUT /local-s3/apps/ios/cranium-ios-0.6.0.ipa',
    'POST /api/t/apps/ios/releases/0.6.0']);
  const [release] = (await console_.call('GET', '/api/apps', { as: manager })).body.ios.releases;
  assert.equal(release.notes, 'Updates on every iPhone, with SideStore, from your own source on the Apps page.');
  assert.deepEqual([release.version, release.buildVersion, release.size, release.sha256],
    ['0.6.0', '8', bytes.length, createHash('sha256').update(bytes).digest('hex')]);
  for (const text of [out, err]) {
    assert.equal(text.includes(token.slice(4)), false);
    assert.equal(text.includes('X-Amz-Signature'), false);
  }
  // Again, the same bytes: published already.
  const again = await run(script, [], { CRANIUM_TOKEN: token, CRANIUM_CONSOLE_URL: url });
  assert.equal(again.status, 0, again.err);
  assert.match(again.out, /on the console already, with these same bytes/);
});

test('refused before anything is sent: a mislabelled IPA, the example configuration, no note, no token', { skip }, async (t) => {
  const { url, token, seen } = await consoleServer(t);
  const env = { CRANIUM_TOKEN: token, CRANIUM_CONSOLE_URL: url };
  const mislabelled = await run(tree({ bytes: ipa({ version: '0.5.9' }) }).script, [], env);
  assert.equal(mislabelled.status, 1);
  assert.match(mislabelled.err, /says it is version 0\.5\.9 in its Info\.plist/);
  const example = await run(tree({ bytes: ipa({ example: true }) }).script, [], env);
  assert.match(example.err, /has the example configuration/);
  const other = await run(tree({ bytes: ipa({ bundleId: 'com.example.other' }) }).script, [], env);
  assert.match(other.err, /is the app com\.example\.other/);
  const broken = await run(tree({ bytes: Buffer.from('not a zip') }).script, [], env);
  assert.equal(broken.status, 1);
  assert.match(broken.err, /cannot be read as an IPA|not an IPA/);
  const unwritten = await run(tree({ version: '0.7.0', build: '9' }).script, [], env);
  assert.match(unwritten.err, /CHANGELOG\.md has no entry for 0\.7\.0/);
  const named = await run(tree({ file: 'Cranium.ipa' }).script, [join(work, `repo-${trees}`, 'apps', 'dist', 'Cranium.ipa')], env);
  assert.match(named.err, /is not named as build-ipa\.sh names an IPA/);
  assert.deepEqual(seen, [], 'nothing was sent');
  const none = await run(tree().script, [], { CRANIUM_CONSOLE_URL: url });
  assert.equal(none.status, 2);
  assert.match(none.err, /Not published: no API token/);
  const plain = await run(tree().script, [], { CRANIUM_TOKEN: token, CRANIUM_CONSOLE_URL: 'http://console.example.com' });
  assert.match(plain.err, /must start with https:\/\//);
});

test('the console\'s own refusals come through: an IPA for another console', { skip }, async (t) => {
  const { url, token } = await consoleServer(t);
  const bytes = ipa({ config: { consoleUrl: 'https://another.example.invalid', mobileClientId: 'localmobile' } });
  const refused = await run(tree({ bytes }).script, [], { CRANIUM_TOKEN: token, CRANIUM_CONSOLE_URL: url });
  assert.equal(refused.status, 1);
  assert.match(refused.err, /refused to publish 0\.6\.0 \(422\)/);
  assert.match(refused.err, /ipa_mismatch/);
});
