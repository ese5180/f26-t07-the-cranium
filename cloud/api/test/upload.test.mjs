// scripts/upload-to-console.sh, which scripts/build.sh runs after every build: it uploads the image
// to the console with an API token and never deploys it. Run here against the console's own code
// behind a local address, as API Gateway serves /api/t/.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { apiEvent, createTestConsole } from './fake-aws.mjs';

const UPLOAD = fileURLToPath(new URL('../../../scripts/upload-to-console.sh', import.meta.url));
const IMAGE = fileURLToPath(new URL('./fixtures/valid-1.2.3+4.signed.bin', import.meta.url));
const OTHER = fileURLToPath(new URL('./fixtures/signed-with-other-key.signed.bin', import.meta.url));
const hasTools = ['curl', 'python3'].every((tool) => spawnSync(tool, ['--version']).status === 0);
const skip = !hasTools && 'needs curl and python3';

const work = mkdtempSync(join(tmpdir(), 'cranium-upload-'));
after(() => rmSync(work, { recursive: true, force: true }));

// The script takes the release's note from the repository it is in: its firmware/CHANGELOG.md, else
// the firmware commits since the last version. So it runs here from a copy in a folder of its own,
// outside git, with a changelog the test writes: what the real repository holds never decides a test.
const repo = join(work, 'repo');
mkdirSync(join(repo, 'scripts'), { recursive: true });
mkdirSync(join(repo, 'firmware'));
const SCRIPT = join(repo, 'scripts', 'upload-to-console.sh');
copyFileSync(UPLOAD, SCRIPT);
const CHANGELOG = join(repo, 'firmware', 'CHANGELOG.md');
writeFileSync(CHANGELOG, '# Firmware changelog\n\n## 1.0.0\n\nThe first release.\n');

function run(args, env) {
  return new Promise((resolve) => {
    const clean = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !name.startsWith('AWS_') && !name.startsWith('CRANIUM_')));
    const child = spawn('bash', [SCRIPT, ...args], { env: { ...clean, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (status) => resolve({ status, out, err }));
  });
}

/** The console behind a local address, with a release manager and a viewer who each have a token. */
async function consoleServer(t) {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  const seen = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push(`${request.method} ${request.url}`);
    console_.advance(5000);
    const headers = request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization };
    const answer = await console_.app(apiEvent(request.method, request.url, { headers, body: body === '' ? undefined : body }));
    response.writeHead(answer.statusCode, answer.headers);
    response.end(answer.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const token = async (as) => (await console_.call('POST', '/api/tokens', { as, body: { name: 'builds' } })).body.token;
  return {
    console_, seen, url: `http://127.0.0.1:${server.address().port}`,
    managerToken: await token(manager), viewerToken: await token(viewer),
  };
}

test('an image is uploaded, and only uploaded: nothing is deployed', { skip }, async (t) => {
  const { console_, seen, url, managerToken } = await consoleServer(t);
  const home = mkdtempSync(join(work, 'home-'));
  const { status, out, err } = await run([IMAGE, 'Built by scripts/build.sh from commit abc1234'],
    { HOME: home, CRANIUM_TOKEN: managerToken, CRANIUM_CONSOLE_URL: url });
  assert.equal(status, 0, `${out}\n${err}`);
  assert.match(out, /Uploaded release 1\.2\.3\+4\./);
  assert.deepEqual(seen, ['POST /api/t/firmware']);
  assert.equal(console_.fake.releases.size, 1);
  const [release] = console_.fake.releases.values();
  assert.equal(release.notes, 'Built by scripts/build.sh from commit abc1234');
  for (const text of [out, err]) assert.equal(text.includes(managerToken.slice(4)), false);
});

test("the note is the version's changelog entry, with the given note after it in brackets", { skip }, async (t) => {
  const { console_, url, managerToken } = await consoleServer(t);
  const home = mkdtempSync(join(work, 'home-'));
  writeFileSync(CHANGELOG, '# Firmware changelog\n\n## 1.2.3\n\nThe board blinks\nfaster.\n\nMore detail that is not\nthe note.\n\n'
    + '## 1.0.0\n\nThe first release.\n');
  t.after(() => writeFileSync(CHANGELOG, '# Firmware changelog\n\n## 1.0.0\n\nThe first release.\n'));
  const { status, out, err } = await run([IMAGE, 'Built by scripts/build.sh from commit abc1234'],
    { HOME: home, CRANIUM_TOKEN: managerToken, CRANIUM_CONSOLE_URL: url });
  assert.equal(status, 0, `${out}\n${err}`);
  const [release] = console_.fake.releases.values();
  assert.equal(release.notes, 'The board blinks faster. (Built by scripts/build.sh from commit abc1234)');
});

test('the same image again counts as uploaded', { skip }, async (t) => {
  const { url, managerToken } = await consoleServer(t);
  const home = mkdtempSync(join(work, 'home-'));
  const env = { HOME: home, CRANIUM_TOKEN: managerToken, CRANIUM_CONSOLE_URL: url };
  assert.equal((await run([IMAGE], env)).status, 0);
  const again = await run([IMAGE], env);
  assert.equal(again.status, 0, again.err);
  assert.match(again.out, /already on the console, with these same bytes/);
});

test('no token: nothing is tried, and the build is told how to make one', { skip }, async () => {
  const home = mkdtempSync(join(work, 'home-'));
  const { status, err } = await run([IMAGE], { HOME: home, CRANIUM_CONSOLE_URL: 'http://127.0.0.1:9' });
  assert.equal(status, 2);
  assert.match(err, /Not uploaded: no API token/);
});

test('a token file others can read is refused before anything is sent', { skip }, async (t) => {
  const { seen, url, managerToken } = await consoleServer(t);
  const home = mkdtempSync(join(work, 'home-'));
  mkdirSync(join(home, '.cranium'));
  writeFileSync(join(home, '.cranium', 'console-token'), `${managerToken}\n`);
  chmodSync(join(home, '.cranium', 'console-token'), 0o644);
  const { status, err } = await run([IMAGE], { HOME: home, CRANIUM_CONSOLE_URL: url });
  assert.equal(status, 1);
  assert.match(err, /can be read or changed by others/);
  assert.deepEqual(seen, []);
});

test('a viewer\'s token, and an image signed with another key, are refused with the console\'s words', { skip }, async (t) => {
  const { console_, url, managerToken, viewerToken } = await consoleServer(t);
  const home = mkdtempSync(join(work, 'home-'));
  const viewer = await run([IMAGE], { HOME: home, CRANIUM_TOKEN: viewerToken, CRANIUM_CONSOLE_URL: url });
  assert.equal(viewer.status, 1);
  assert.match(viewer.err, /refused the upload \(403\)/);

  const copy = join(work, 'other.signed.bin');
  copyFileSync(OTHER, copy);
  const other = await run([copy], { HOME: home, CRANIUM_TOKEN: managerToken, CRANIUM_CONSOLE_URL: url });
  assert.equal(other.status, 1);
  assert.match(other.err, /refused the upload \(422\)/);
  assert.equal(console_.fake.releases.size, 0);
});

test('only https, except for the preview on this computer', { skip }, async () => {
  const home = mkdtempSync(join(work, 'home-'));
  const token = `crn_${'A'.repeat(43)}`;
  const { status, err } = await run([IMAGE], { HOME: home, CRANIUM_TOKEN: token, CRANIUM_CONSOLE_URL: 'http://console.example.com' });
  assert.equal(status, 1);
  assert.match(err, /must start with https:\/\//);
});
