// Tests for the shell scripts, with a stand-in for the AWS CLI first on the PATH: nothing
// here reaches AWS, and every call the scripts make is written down and looked at.
// A script's functions are run by loading it without its last line, which starts it.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { apiEvent, createTestConsole } from './fake-aws.mjs';

const CLOUD = fileURLToPath(new URL('../../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'cranium-scripts-'));
after(() => rmSync(work, { recursive: true, force: true }));

// Answers from environment variables. STUB_FAIL names a call that fails.
const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
if [ -n "\${STUB_FAIL:-}" ]; then
  case "$*" in
    *"$STUB_FAIL"*) echo "stand-in failure" >&2; exit 254 ;;
  esac
fi
case "$*" in
  --version) echo "aws-cli/2.31.0" ;;
  "sts get-caller-identity"*) echo 123456789012 ;;
  *"--stack-name cranium-trail"*"StackStatus"*)
    if [ -n "\${STUB_TRAIL_STACK:-}" ]; then echo "$STUB_TRAIL_STACK"; else
      echo "Stack with id cranium-trail does not exist" >&2; exit 254; fi ;;
  "cloudformation describe-stacks"*) echo stand-in-output ;;
  "cloudtrail describe-trails"*) printf '%s\\n' "\${STUB_TRAILS:-}" ;;
  "cloudtrail get-trail-status"*) echo True ;;
  "cloudtrail get-trail "*) printf 'True\\tTrue\\n' ;;
  *"admin-get-user"*"--query UserStatus"*)
    if [ "\${STUB_STATUS:-CONFIRMED}" = NONE ]; then
      echo "An error occurred (UserNotFoundException)" >&2; exit 254; fi
    echo "\${STUB_STATUS:-CONFIRMED}" ;;
  *"admin-get-user"*"--query Enabled"*) echo "\${STUB_ENABLED:-True}" ;;
  *"admin-list-groups-for-user"*) echo "\${STUB_GROUPS:-}" ;;
  *"list-users-in-group"*) echo "" ;;
  *"cognito-idp list-users"*) printf 'sub-1\\tsomeone@example.org\\tCONFIRMED\\tTrue\\n' ;;
  *"dynamodb describe-table"*)
    if [ "\${STUB_TABLE:-False}" = GONE ]; then
      echo "An error occurred (ResourceNotFoundException)" >&2; exit 254; fi
    echo "\${STUB_TABLE:-False}" ;;
  *"secretsmanager describe-secret"*) printf '%s\\n' "\${STUB_STAGES:-null}" ;;
esac
exit 0
`;

const stubDir = join(work, 'bin');
mkdirSync(stubDir);
writeFileSync(join(stubDir, 'aws'), STUB);
chmodSync(join(stubDir, 'aws'), 0o755);

let runs = 0;

/** The environment of a script: the stand-in first, and no trace of a real profile or git run. */
function environment(extra = {}) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('AWS_') && !name.startsWith('GIT_'))
  );
  return { ...clean, PATH: `${stubDir}:${process.env.PATH}`, ...extra };
}

/** Run a command line under bash. Returns its status, its output and the AWS calls it made. */
function bash(args, env = {}) {
  runs += 1;
  const log = join(work, `calls-${runs}`);
  writeFileSync(log, '');
  const result = spawnSync('bash', args, { env: environment({ STUB_LOG: log, ...env }), encoding: 'utf8' });
  const calls = readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line !== '' && line !== '--version');
  return { status: result.status, out: result.stdout, err: result.stderr, calls };
}

const script = (name, ...args) => bash([join(CLOUD, name), ...args]);
const scriptWith = (env, name, ...args) => bash([join(CLOUD, name), ...args], env);

/** Run one line in a copy of a script that has everything but the call that starts it. */
function inScript(name, line, env = {}) {
  const text = readFileSync(join(CLOUD, name), 'utf8');
  assert.ok(text.trimEnd().endsWith('main "$@"'), name);
  runs += 1;
  const copy = join(work, `script-${runs}.sh`);
  writeFileSync(copy, `${text.trimEnd().slice(0, -'main "$@"'.length)}\n${line}\n`);
  return bash([copy], env);
}

const position = (calls, words) => calls.findIndex((call) => call.includes(words));

test('every script parses', () => {
  for (const name of ['deploy.sh', 'teardown.sh', 'users.sh', 'smoke.sh', 'trail.sh', 'logs.sh']) {
    const { status, err } = bash(['-n', join(CLOUD, name)]);
    assert.equal(status, 0, `${name}: ${err}`);
  }
});

test('reset-mfa replaces the account with the same role, and never sets a password', () => {
  for (const [groups, role, group] of [
    ['release-managers', 'release-manager', 'release-managers'],
    ['viewers', 'viewer', 'viewers'],
    ['release-managers viewers', 'release-manager', 'release-managers'],
  ]) {
    const { status, out, calls } = scriptWith({ STUB_GROUPS: groups }, 'users.sh', 'reset-mfa', 'a@example.org');
    assert.equal(status, 0, out);
    const order = [
      'admin-user-global-sign-out',
      'admin-delete-user',
      'admin-create-user',
      'admin-add-user-to-group',
    ].map((words) => position(calls, words));
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
      JSON.stringify(calls)
    );
    assert.ok(
      order.every((at) => at !== -1),
      JSON.stringify(calls)
    );
    assert.ok(calls[order[3]].includes(`--group-name ${group}`));
    assert.ok(out.includes(`cloud/users.sh add a@example.org ${role}`));
    assert.ok(out.includes('Done.'));
    // Cognito sends the password. The authenticator alone is no longer what goes.
    assert.equal(
      calls.some((call) => /password|delete-software-token/.test(call)),
      false
    );
  }
});

test('reset-mfa says how to finish before it deletes anything', () => {
  const { status, out, calls } = scriptWith(
    { STUB_GROUPS: 'release-managers', STUB_FAIL: 'admin-create-user' },
    'users.sh',
    'reset-mfa',
    'a@example.org'
  );
  assert.notEqual(status, 0);
  assert.ok(position(calls, 'admin-delete-user') !== -1);
  assert.ok(out.includes('cloud/users.sh add a@example.org release-manager'));
  assert.equal(out.includes('Done.'), false);
});

test('reset-mfa leaves an account alone when replacing it would change more than it should', () => {
  const cases = [
    [{ STUB_ENABLED: 'False', STUB_GROUPS: 'viewers' }, 'disabled'],
    [{ STUB_GROUPS: '' }, 'no role'],
    [{ STUB_STATUS: 'FORCE_CHANGE_PASSWORD', STUB_GROUPS: 'viewers' }, 'resend'],
    [{ STUB_STATUS: 'NONE' }, 'There is no account'],
  ];
  for (const [env, words] of cases) {
    const { status, out, err, calls } = scriptWith(env, 'users.sh', 'reset-mfa', 'a@example.org');
    assert.notEqual(status, 0, words);
    assert.ok(`${out}${err}`.includes(words), `${words}: ${out}${err}`);
    for (const change of [
      'admin-delete-user',
      'admin-create-user',
      'admin-user-global-sign-out',
      'admin-add-user-to-group',
    ]) {
      assert.equal(position(calls, change), -1, `${words}: ${change}`);
    }
  }
});

test('removing an address that has no account does not look like a success', () => {
  const missing = scriptWith({ STUB_STATUS: 'NONE' }, 'users.sh', 'remove', 'gone@example.org');
  assert.notEqual(missing.status, 0);
  assert.ok(missing.err.includes('There is no account for gone@example.org'));
  assert.ok(missing.err.includes('someone@example.org'), 'the current accounts are shown');
  assert.equal(position(missing.calls, 'admin-delete-user'), -1);

  const found = script('users.sh', 'remove', 'a@example.org');
  assert.equal(found.status, 0);
  assert.ok(position(found.calls, 'admin-delete-user') !== -1);
  assert.ok(found.out.includes('within a minute'));
});

test('adding an address that has no account says what happens to one elsewhere', () => {
  const { status, out } = scriptWith(
    { STUB_STATUS: 'NONE', STUB_GROUPS: 'viewers' },
    'users.sh',
    'add',
    'new@example.org',
    'viewer'
  );
  assert.equal(status, 0);
  assert.ok(out.includes('cloud/users.sh list'));
});

test('users.sh list keeps the form that scripts/firmware/ota.sh reads', () => {
  const { status, out } = script('users.sh', 'list');
  assert.equal(status, 0);
  assert.match(out, /^E-MAIL\s+ROLE\s+STATE\n/);
  assert.match(out, /someone@example\.org\s+none\s+active\n/);
});

test("teardown switches a table's deletion protection off first", () => {
  const protectedTable = inScript('teardown.sh', 'delete_table "audit table" t1', { STUB_TABLE: 'True' });
  assert.equal(protectedTable.status, 0, protectedTable.err);
  const order = [
    'describe-table',
    'update-table --table-name t1 --no-deletion-protection-enabled',
    'wait table-exists',
    'delete-table --table-name t1',
    'wait table-not-exists',
  ].map((words) => position(protectedTable.calls, words));
  assert.ok(
    order.every((at) => at !== -1),
    JSON.stringify(protectedTable.calls)
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b)
  );

  const open = inScript('teardown.sh', 'delete_table "audit table" t1', { STUB_TABLE: 'False' });
  assert.equal(open.status, 0);
  assert.equal(position(open.calls, 'update-table'), -1);
  assert.ok(position(open.calls, 'delete-table') !== -1);

  // It can be run again if it stopped halfway.
  const gone = inScript('teardown.sh', 'delete_table "audit table" t1', { STUB_TABLE: 'GONE' });
  assert.equal(gone.status, 0, gone.err);
  assert.ok(gone.out.includes('already gone'));
  assert.equal(position(gone.calls, 'delete-table'), -1);

  const unknown = inScript('teardown.sh', 'delete_table "audit table" ""');
  assert.equal(unknown.status, 0);
  assert.deepEqual(unknown.calls, []);

  const refused = inScript('teardown.sh', 'delete_table "audit table" t1', {
    STUB_TABLE: 'True',
    STUB_FAIL: 'update-table',
  });
  assert.notEqual(refused.status, 0);
  assert.equal(position(refused.calls, 'delete-table'), -1);
});

test('deploy.sh tells the commit and which deployed files differ from it', () => {
  const repo = join(work, 'repo');
  const git = (...args) => {
    const result = spawnSync(
      'git',
      ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', ...args],
      {
        encoding: 'utf8',
        env: { ...environment(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const place = (path, text = 'x\n') => {
    const file = join(repo, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  };
  const state = (line) =>
    inScript('deploy.sh', `REPO_DIR=${repo}; ${line}`, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

  // No checkout at all.
  mkdirSync(repo);
  assert.equal(state('source_commit').out.trim(), 'unknown');

  git('init', '-q');
  for (const path of [
    'cloud/api/src/index.mjs',
    'cloud/web/src/server.mjs',
    'cloud/infra/template.yaml',
    'firmware/keys/fw_signing_pub.pem',
    'firmware/app/src/main.c',
    'README.md',
  ]) {
    place(path);
  }
  place('.gitignore', '.DS_Store\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  const head = git('rev-parse', 'HEAD');
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(state('source_commit').out.trim(), head);
  assert.equal(state('source_changes').out, '');

  // What is not deployed does not count.
  place('firmware/app/src/main.c', 'changed\n');
  place('notes.pdf');
  place('scripts/new.sh');
  assert.equal(state('source_changes').out, '');

  // What is deployed does: changed, new, ignored but packaged, and the signing key.
  const changed = [
    ['cloud/api/src/index.mjs', 'changed\n'],
    ['cloud/web/src/new.mjs', 'new\n'],
    ['cloud/web/src/.DS_Store', 'ignored\n'],
    ['cloud/infra/template.yaml', 'changed\n'],
    ['firmware/keys/fw_signing_pub.pem', 'changed\n'],
  ];
  for (const [path, text] of changed) {
    place(path, text);
    assert.ok(state('source_changes').out.includes(path), path);
  }
  // Except the history file, which this script writes from the commits themselves.
  const before = state('source_changes').out;
  place('cloud/web/src/site/assets/history.json', '{}\n');
  assert.equal(state('source_changes').out, before);
  // And the two versions files (web/build-versions.mjs), written from cloud/VERSION and the changelogs.
  place('cloud/web/src/site/assets/versions.json', '{}\n');
  place('cloud/api/src/versions.json', '{}\n');
  assert.equal(state('source_changes').out, before);
  // And none of this looked at the checkout in a way that changes it.
  assert.equal(git('rev-parse', 'HEAD'), head);
});

test('deploy.sh does not take the commit from the command line', () => {
  for (const argument of ['DeployedCommit=abc', 'DeployedTree=clean']) {
    const { status, err, calls } = script('deploy.sh', argument);
    assert.equal(status, 1);
    assert.ok(err.includes('unknown argument'));
    assert.deepEqual(calls, []);
  }
  // The new switch is known, which the refusal above shows it would not be otherwise.
  const text = readFileSync(join(CLOUD, 'deploy.sh'), 'utf8');
  assert.ok(text.includes('RestrictIotLoggingTrust=*'));
});

// Memfault (docs/memfault.md): the key from ~/.cranium/memfault_project_key into the stack's secret, and the
// slugs for the link to a board in Memfault. HOME is a folder of the test's own: never the real ~/.cranium.
const MEMFAULT_KEY = 'AbCdEf0123456789AbCdEf0123456789';

function memfaultHome(files = {}) {
  runs += 1;
  const home = join(work, `home-${runs}`);
  mkdirSync(join(home, '.cranium'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(home, '.cranium', name), text, { mode: 0o600 });
  return home;
}

const digestOf = (text) =>
  spawnSync('openssl', ['dgst', '-sha256', '-hex'], { input: text, encoding: 'utf8' }).stdout.trim().split(' ').at(-1);

test('deploy.sh stores the Memfault key by the digest of its file, from the file, and never shows it', () => {
  const home = memfaultHome({ memfault_project_key: `${MEMFAULT_KEY}\n` });
  const token = digestOf(`${MEMFAULT_KEY}\n`);
  const stored = inScript('deploy.sh', 'store_memfault_key', { HOME: home });
  assert.equal(stored.status, 0, stored.err);
  const put = stored.calls.find((call) => call.startsWith('secretsmanager put-secret-value'));
  assert.ok(put, JSON.stringify(stored.calls));
  assert.ok(put.includes('--secret-id stand-in-output'));
  assert.ok(put.includes(`--client-request-token ${token}`));
  assert.ok(put.includes(`--secret-string file://${home}/.cranium/memfault_project_key`));
  assert.ok(stored.out.includes('stored the project key'));
  for (const text of [stored.out, stored.err, ...stored.calls]) assert.equal(text.includes(MEMFAULT_KEY), false);

  // The same key again adds no version.
  const again = inScript('deploy.sh', 'store_memfault_key', {
    HOME: home,
    STUB_STAGES: JSON.stringify({ [token]: ['AWSCURRENT'] }),
  });
  assert.equal(again.status, 0, again.err);
  assert.equal(
    again.calls.some((call) => call.includes('put-secret-value') || call.includes('update-secret-version-stage')),
    false
  );
  assert.ok(again.out.includes('stored already'));

  // A key stored before, and replaced since, is made the current one again.
  const back = inScript('deploy.sh', 'store_memfault_key', {
    HOME: home,
    STUB_STAGES: JSON.stringify({ [token]: ['AWSPREVIOUS'], 'other-version': ['AWSCURRENT'] }),
  });
  assert.equal(back.status, 0, back.err);
  const move = back.calls.find((call) => call.startsWith('secretsmanager update-secret-version-stage'));
  assert.ok(
    move.includes(`--move-to-version-id ${token}`) && move.includes('--remove-from-version-id other-version'),
    move
  );
  assert.equal(
    back.calls.some((call) => call.includes('put-secret-value')),
    false
  );
});

test('deploy.sh without a Memfault key says how to add one, and asks nothing of AWS for it', () => {
  for (const files of [{}, { memfault_project_key: '' }]) {
    const none = inScript('deploy.sh', 'store_memfault_key', { HOME: memfaultHome(files) });
    assert.equal(none.status, 0, none.err);
    assert.deepEqual(none.calls, []);
    assert.ok(none.out.includes('docs/memfault.md'));
  }
  // A key that others can read is still stored, with a word about it.
  const home = memfaultHome({ memfault_project_key: MEMFAULT_KEY });
  chmodSync(join(home, '.cranium', 'memfault_project_key'), 0o644);
  const open = inScript('deploy.sh', 'store_memfault_key', { HOME: home });
  assert.equal(open.status, 0, open.err);
  assert.ok(open.out.includes('chmod 600'));
});

test('deploy.sh takes the Memfault slugs from the environment, else from ~/.cranium/memfault.json, and checks them', () => {
  const slugs = (env) => inScript('deploy.sh', 'memfault_slug_overrides', env);
  const fromFile = slugs({
    HOME: memfaultHome({ 'memfault.json': '{"org": "cranium-team", "project": "cranium-boards"}' }),
  });
  assert.equal(fromFile.status, 0, fromFile.err);
  assert.equal(fromFile.out, 'MemfaultOrgSlug=cranium-team\nMemfaultProjectSlug=cranium-boards\n');
  const fromEnv = slugs({
    HOME: memfaultHome({ 'memfault.json': '{"org": "file-org", "project": "file-project"}' }),
    MEMFAULT_ORG_SLUG: 'env-org',
    MEMFAULT_PROJECT_SLUG: 'env-project',
  });
  assert.equal(fromEnv.out, 'MemfaultOrgSlug=env-org\nMemfaultProjectSlug=env-project\n');
  // Neither: the stack keeps what it has.
  const none = slugs({ HOME: memfaultHome() });
  assert.deepEqual([none.status, none.out], [0, '']);
  for (const [env, files] of [
    [{ MEMFAULT_ORG_SLUG: 'Has Capitals', MEMFAULT_PROJECT_SLUG: 'p' }, {}],
    [{ MEMFAULT_ORG_SLUG: 'only-the-org' }, {}],
    [{}, { 'memfault.json': '{"org": "o"}' }],
    [{}, { 'memfault.json': 'not json' }],
    [{}, { 'memfault.json': '{"org": "o; rm -rf /", "project": "p"}' }],
  ]) {
    const refused = slugs({ HOME: memfaultHome(files), ...env });
    assert.notEqual(refused.status, 0, JSON.stringify([env, files]));
    assert.equal(refused.out, '');
  }
  // The arguments are known parameters: a typo is still refused before anything happens.
  const typo = script('deploy.sh', 'MemfaultOrgSlugs=x');
  assert.deepEqual([typo.status, typo.calls], [1, []]);
});

test('trail.sh deploys its own stack, and not next to another trail', () => {
  const alone = scriptWith({ STUB_TRAIL_STACK: '' }, 'trail.sh');
  assert.equal(alone.status, 0, alone.err);
  const deploy = alone.calls.find((call) => call.startsWith('cloudformation deploy'));
  assert.ok(deploy.includes('--stack-name cranium-trail'));
  assert.ok(deploy.includes('infra/trail.yaml'));
  // The stack has no role, so it needs no such right.
  assert.equal(deploy.includes('--capabilities'), false);

  const second = scriptWith({ STUB_TRAILS: 'other-trail\tus-east-1' }, 'trail.sh');
  assert.notEqual(second.status, 0);
  assert.ok(second.err.includes('$2.00 per 100,000'));
  assert.equal(
    second.calls.some((call) => call.startsWith('cloudformation deploy')),
    false
  );

  const status = scriptWith({ STUB_TRAIL_STACK: 'CREATE_COMPLETE' }, 'trail.sh', '--status');
  assert.equal(status.status, 0, status.err);
  assert.ok(status.out.includes('Logging: True'));
  assert.equal(
    status.calls.some((call) => call.startsWith('cloudformation deploy')),
    false
  );

  const none = scriptWith({ STUB_TRAIL_STACK: '' }, 'trail.sh', '--status');
  assert.equal(none.status, 0);
  assert.ok(none.out.includes('NONE'));
});

test('the event smoke.sh sends is one the API function takes, and it tells the two cases apart', async () => {
  const console_ = createTestConsole();
  const member = console_.addUser('member', ['release-managers']);
  const eventFor = (sub) => {
    const { status, out, err } = inScript(
      'smoke.sh',
      `API_HOST=abc.example.org; CLIENT_ID=${console_.config.userPoolClientId}; USER_POOL_ID=pool_1; api_event /api/devices ${sub}`
    );
    assert.equal(status, 0, err);
    return JSON.parse(out);
  };

  const real = eventFor(member.sub);
  assert.equal(real.routeKey, 'GET /api/{proxy+}');
  assert.equal((await console_.app(real)).statusCode, 200);

  const unknown = await console_.app(eventFor('00000000-0000-0000-0000-000000000000'));
  assert.equal(unknown.statusCode, 403);
  assert.equal(JSON.parse(unknown.body).error.code, 'account_inactive');
  // Writes nothing: this is a read, whoever it claims to be.
  assert.equal(console_.fake.auditLog().length, 0);
});

// scripts/firmware/ota.sh with a personal API token: curl to the console's /api/t/, no AWS at all.

const OTA = join(CLOUD, '..', 'scripts', 'firmware', 'ota.sh');
const IMAGE = fileURLToPath(new URL('./fixtures/valid-1.2.3+4.signed.bin', import.meta.url));
const BOARD = 'cranium-00000000000000aa';
const hasTools = ['curl', 'python3'].every((tool) => spawnSync(tool, ['--version']).status === 0);

/** Run ota.sh without blocking, so that the console in this process can answer it. */
function ota(args, env) {
  return new Promise((resolve) => {
    const child = spawn('bash', [OTA, ...args], { env: environment(env) });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('close', (status) => resolve({ status, out, err }));
  });
}

/**
 * The console behind a local address, as API Gateway serves /api/t/: no authorizer, the
 * request handed to the function as it came. Each request moves the console's clock on, so
 * that nothing is answered from a cache, and `onRequest` plays the board.
 */
async function consoleServer(t, { onRequest = () => {} } = {}) {
  const console_ = createTestConsole();
  console_.fake.addThing(BOARD);
  const manager = console_.addUser('manager', ['release-managers']);
  const seen = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization ?? null });
    console_.advance(5000);
    onRequest(console_, request.method, request.url);
    const headers = request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization };
    const answer = await console_.app(
      apiEvent(request.method, request.url, { headers, body: body === '' ? undefined : body })
    );
    response.writeHead(answer.statusCode, answer.headers);
    response.end(answer.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const made = await console_.call('POST', '/api/tokens', { as: manager, body: { name: 'ota' } });
  return {
    console_,
    manager,
    seen,
    token: made.body.token,
    id: made.body.id,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

test(
  'ota.sh with an API token uploads, deploys and follows the board through the console',
  { skip: !hasTools && 'needs curl and python3' },
  async (t) => {
    const { console_, seen, token, id, url } = await consoleServer(t, {
      // The board: it starts the update when the script first looks, and has it confirmed by the next look.
      onRequest(context, method, path) {
        const match = /^\/api\/t\/deployments\/([\w-]+)$/.exec(path);
        if (method !== 'GET' || !match) return;
        const execution = context.fake.execution(match[1], BOARD);
        if (execution.get().status === 'QUEUED') execution.update('IN_PROGRESS', { step: 'downloading' });
        else execution.update('SUCCEEDED', { running: '1.2.3+4' });
      },
    });
    const home = mkdtempSync(join(work, 'home-'));
    const { status, out, err } = await ota([IMAGE], {
      HOME: home,
      CRANIUM_TOKEN: token,
      CRANIUM_CONSOLE_URL: `${url}/`,
      CRANIUM_POLL_SECONDS: '1',
    });
    assert.equal(status, 0, `${out}\n${err}`);
    assert.match(out, /Using the API token from CRANIUM_TOKEN/);
    assert.match(out, /Uploaded release 1\.2\.3\+4/);
    assert.match(out, new RegExp(`Done: ${BOARD} installed 1\\.2\\.3\\+4 and reported running 1\\.2\\.3\\+4\\.`));
    // Never shown, and sent only as the header.
    for (const text of [out, err]) assert.equal(text.includes(token.slice(4)), false);
    assert.deepEqual(
      seen.map((request) => `${request.method} ${request.url.replace(/cranium-1-2-3-b4-\S+/, '<id>')}`).slice(0, 4),
      ['GET /api/t/me', 'GET /api/t/devices', 'POST /api/t/firmware', 'POST /api/t/deployments']
    );
    assert.ok(seen.every((request) => request.authorization === `Bearer ${token}`));

    // The changes are on record in the owner's name, with the token's id.
    const entries = console_.fake.auditLog().filter((entry) => entry.detail.token === id);
    assert.deepEqual(
      entries.map((entry) => [entry.action, entry.outcome]),
      [
        ['firmware.upload', 'ok'],
        ['deployment.create', 'ok'],
      ]
    );
    assert.equal(console_.fake.releases.size, 1);
  }
);

test(
  "ota.sh takes a token file only if it is its owner's alone, and never prints a token",
  { skip: !hasTools && 'needs curl and python3' },
  async (t) => {
    const { seen, token, url } = await consoleServer(t);
    const home = mkdtempSync(join(work, 'home-'));
    mkdirSync(join(home, '.cranium'));
    const file = join(home, '.cranium', 'console-token');
    const env = { HOME: home, CRANIUM_CONSOLE_URL: url };

    writeFileSync(file, `${token}\n`, { mode: 0o644 });
    chmodSync(file, 0o644);
    let run = await ota([IMAGE, '--thing', BOARD], env);
    assert.equal(run.status, 1);
    assert.match(run.err, /can be read or changed by others \(mode 644\)/);
    assert.match(run.err, /chmod 600/);
    assert.deepEqual(seen, []);

    // A link to a token is not a token file either.
    const elsewhere = join(home, 'kept');
    writeFileSync(elsewhere, token, { mode: 0o600 });
    rmSync(file);
    symlinkSync(elsewhere, file);
    run = await ota([IMAGE], env);
    assert.equal(run.status, 1);
    assert.match(run.err, /is not a plain file/);

    // Not a token of the console: refused without showing what it was.
    rmSync(file);
    writeFileSync(file, `crn_${'x'.repeat(10)}\n`, { mode: 0o600 });
    run = await ota([IMAGE], env);
    assert.equal(run.status, 1);
    assert.match(run.err, /is not one the console makes/);
    assert.equal(run.err.includes('xxxxxxxxxx'), false);
    assert.deepEqual(seen, []);

    // Well formed but unknown: the console says no, and the script says what to do.
    const unknown = `crn_${'B'.repeat(42)}A`;
    writeFileSync(file, `${unknown}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    run = await ota([IMAGE], env);
    assert.equal(run.status, 1);
    assert.match(run.err, /did not accept the API token/);
    assert.match(run.err, /Developer > API tokens/);
    for (const text of [run.out, run.err]) assert.equal(text.includes(unknown.slice(4)), false);
    assert.deepEqual(
      seen.map((request) => request.url),
      ['/api/t/me']
    );

    // The address must be https, but for the local preview on this computer.
    run = await ota([IMAGE], { HOME: home, CRANIUM_TOKEN: token, CRANIUM_CONSOLE_URL: 'http://console.example.com' });
    assert.equal(run.status, 1);
    assert.match(run.err, /must start with https:\/\//);
    run = await ota([IMAGE], {
      HOME: home,
      CRANIUM_TOKEN: token,
      CRANIUM_CONSOLE_URL: 'https://console.example.com/x?y',
    });
    assert.match(run.err, /not the address of a console/);
  }
);

test(
  "ota.sh with a viewer's token stops before it uploads anything",
  { skip: !hasTools && 'needs curl and python3' },
  async (t) => {
    const { console_, seen, url } = await consoleServer(t);
    const viewer = console_.addUser('viewer', ['viewers']);
    const made = await console_.call('POST', '/api/tokens', { as: viewer, body: { name: 'read only' } });
    const home = mkdtempSync(join(work, 'home-'));
    const run = await ota([IMAGE], { HOME: home, CRANIUM_TOKEN: made.body.token, CRANIUM_CONSOLE_URL: url });
    assert.equal(run.status, 1);
    assert.match(run.err, /viewer@example\.invalid, is not a release manager now, so it can only read/);
    assert.deepEqual(
      seen.map((request) => request.url),
      ['/api/t/me']
    );
    assert.equal(console_.fake.releases.size, 0);
  }
);
