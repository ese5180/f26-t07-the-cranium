// Tests for what the console shows of Memfault (docs/memfault.md, "In the console"): the reader of Memfault's
// REST API (src/aws-memfault-api.mjs), what its answers are made into (src/lib/memfault-data.mjs), and the
// routes (src/handlers/memfault.mjs), against a fake Memfault that is a real HTTP server (fake-memfault.mjs).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  GET_TIMEOUT_MS,
  TOKEN_CACHE_MS,
  basicAuth,
  createMemfaultReader,
  queryString,
} from '../src/aws-memfault-api.mjs';
import { FAILED_MS, FRESH_MS, MEMFAULT_WORDS } from '../src/handlers/memfault.mjs';
import { device, logEntries, rebootReason, trace, traceReason } from '../src/lib/memfault-data.mjs';
import { createTestConsole } from './fake-aws.mjs';
import { A, B, MEMFAULT_ENV, TOKEN, memfaultWorld, startFakeMemfault } from './fake-memfault.mjs';

let memfault;
before(async () => {
  memfault = await startFakeMemfault();
});
after(() => memfault.close());

function fresh() {
  memfault.state.world = memfaultWorld();
  memfault.state.token = TOKEN;
  memfault.state.fail = () => null;
  memfault.state.logPageSize = null;
  memfault.requests.length = 0;
}

function reader({ secret = TOKEN, env = MEMFAULT_ENV, clock = { ms: 0 } } = {}) {
  const reads = { count: 0 };
  const made = createMemfaultReader(env, {
    fetch: memfault.fetch,
    now: () => clock.ms,
    readSecret: async () => {
      reads.count += 1;
      return typeof secret === 'function' ? secret() : secret;
    },
  });
  return { reader: made, reads, clock };
}

async function failsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'MemfaultError');
    assert.equal(error.code, code);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
}

// The reader.

test('a read is a GET of the project, with the organization auth token as Basic auth and no user', async () => {
  fresh();
  const { reader: r } = reader();
  const body = await r.memfaultGet('devices', { per_page: '100' });
  assert.equal(body.data.length, 2);
  const [request] = memfault.requests;
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/api/v0/organizations/cranium-team/projects/cranium-boards/devices');
  assert.equal(request.query.get('per_page'), '100');
  assert.equal(request.auth, `Basic ${Buffer.from(`:${TOKEN}`).toString('base64')}`);
  // A Memfault user's e-mail and API key, for a Viewer: that user and password.
  assert.equal(
    basicAuth('viewer@example.invalid:key123'),
    `Basic ${Buffer.from('viewer@example.invalid:key123').toString('base64')}`
  );
  // Lists repeat their name; names and values are checked before anything is sent.
  assert.equal(
    queryString({ level: ['error', 'info'], 'page[size]': '500' }),
    'level=error&level=info&page%5Bsize%5D=500'
  );
  assert.throws(() => queryString({ 'a b': 'x' }), /query name/);
  assert.throws(() => queryString({ q: 'x&y=1' }), /query value/);
  for (const path of ['../auth/me', 'devices/../../x', '/devices', 'devices?x=1', 'https://evil.example', '']) {
    await assert.rejects(r.memfaultGet(path), TypeError, path);
  }
});

test('without the secret, the slugs or a value in the secret, nothing is sent and the answer is not_configured', async () => {
  fresh();
  for (const env of [
    { ...MEMFAULT_ENV, MEMFAULT_TOKEN_SECRET_ARN: '' },
    { ...MEMFAULT_ENV, MEMFAULT_ORG_SLUG: '' },
    { ...MEMFAULT_ENV, MEMFAULT_PROJECT_SLUG: undefined },
  ]) {
    await failsWith(reader({ env }).reader.memfaultGet('devices'), 'not_configured');
  }
  await failsWith(reader({ secret: null }).reader.memfaultGet('devices'), 'not_configured');
  await failsWith(reader({ secret: '' }).reader.memfaultGet('devices'), 'not_configured');
  await failsWith(reader({ secret: 'has a space in it' }).reader.memfaultGet('devices'), 'not_configured');
  assert.equal(memfault.requests.length, 0);
  assert.throws(
    () => createMemfaultReader({ ...MEMFAULT_ENV, MEMFAULT_TOKEN_SECRET_ARN: 'not an arn' }),
    /MEMFAULT_TOKEN_SECRET_ARN/
  );
});

test('the token is read once in five minutes, and again at once after Memfault refused it', async () => {
  fresh();
  let secret = 'oat_an_old_token_that_was_revoked';
  const { reader: r, reads, clock } = reader({ secret: () => secret });
  await failsWith(r.memfaultGet('devices'), 'refused');
  secret = TOKEN;
  await r.memfaultGet('devices');
  await r.memfaultGet('issues');
  assert.equal(reads.count, 2);
  clock.ms += TOKEN_CACHE_MS;
  await r.memfaultGet('issues');
  assert.equal(reads.count, 3);
  memfault.state.fail = () => 403;
  await failsWith(r.memfaultGet('issues'), 'refused');
});

test("Memfault's failures are named: not found, limited, unreachable; never the token", async () => {
  fresh();
  const { reader: r } = reader();
  await failsWith(r.memfaultGet('devices/nobody'), 'not_found');
  memfault.state.fail = () => 429;
  await failsWith(r.memfaultGet('devices'), 'limited');
  for (const status of [500, 502, 503]) {
    memfault.state.fail = () => status;
    await failsWith(r.memfaultGet('devices'), 'unreachable');
  }
  memfault.state.fail = () => 'garbage';
  await failsWith(r.memfaultGet('devices'), 'unreachable');
  // No answer: the network, or the time limit.
  const offline = createMemfaultReader(MEMFAULT_ENV, {
    readSecret: async () => TOKEN,
    fetch: async (url, init) => {
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.method, 'GET');
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    },
  });
  await failsWith(offline.memfaultGet('devices'), 'unreachable');
  assert.ok(GET_TIMEOUT_MS <= 8000);
});

// What the answers are made into.

test("reboot reasons by name, the SDK's and this firmware's, and an unknown one by its number", () => {
  assert.deepEqual(rebootReason(3), { code: 3, name: 'FirmwareUpdate', expected: true });
  assert.deepEqual(rebootReason(0x8008), { code: 0x8008, name: 'KernelPanic', expected: false });
  assert.deepEqual(rebootReason(0x8005), { code: 0x8005, name: 'HardwareWatchdog', expected: false });
  assert.equal(rebootReason(0x8009).name, 'FirmwareUpdateError');
  assert.equal(rebootReason(0x1001).name, 'FactoryReset');
  assert.equal(rebootReason(0x1001).expected, true);
  assert.deepEqual(
    [0xa001, 0xa002, 0xa003].map((code) => rebootReason(code).name),
    ['StuckWifiSilent', 'StuckNoCloud', 'StuckUpdateStall']
  );
  assert.deepEqual(rebootReason(0xa004), { code: 0xa004, name: '0xa004', expected: false });
  assert.equal(rebootReason('7').name, 'Unknown');
  assert.equal(traceReason(1, true), 'update_succeeded');
  assert.equal(traceReason(6, true), 'update_rolled_back');
  assert.equal(traceReason(9, true), 'user_reason_9');
  assert.equal(traceReason(2, false), 'reason_2');
});

test("a device's serial is its thing name; one that is not a thing name is shown but tied to no board", () => {
  const [ours, other] = memfaultWorld().devices.map(device);
  assert.deepEqual(ours, {
    serial: A,
    thing: A,
    hardware: 'nrf7002dk',
    software: '1.15.0+0',
    softwareType: 'app',
    cohort: 'default',
    firstSeen: '2026-11-05T19:32:33.723Z',
    lastSeen: '2026-11-09T16:06:49.759Z',
  });
  assert.equal(other.serial, 'bench-unit-1');
  assert.equal(other.thing, null);
  assert.equal(device({ device_serial: 'has/slash' }), null);
  assert.equal(device(null), null);
});

test('a trace keeps its threads, the crashed one first, with frames and registers as far as Memfault gives them', () => {
  const shown = trace(memfaultWorld().traces[0]);
  assert.equal(shown.thing, A);
  assert.equal(shown.version, '1.14.0+1');
  assert.deepEqual(
    shown.threads.map((one) => [one.name, one.crashed]),
    [
      ['main', true],
      ['sysworkq', false],
    ]
  );
  assert.deepEqual(shown.threads[0].frames[0], {
    index: 0,
    function: 'crash_demo_on_tick',
    file: 'src/mflt.c',
    line: 301,
    address: '0x0003c074',
  });
  assert.deepEqual(shown.threads[0].registers, [
    { name: 'pc', value: '0x0003c074' },
    { name: 'lr', value: '0x00039599' },
    { name: 'sp', value: '0x20010000' },
  ]);
  // Anything else in a trace is left out, not passed on.
  assert.equal(trace({ entries: { threads: 'no' }, title: 5 }).threads.length, 0);
  assert.equal(trace({ title: 5 }).title, null);
});

test('the processing log becomes reboots, trace events, heartbeats with every key, and problems', () => {
  const entries = memfaultWorld().log.flatMap(logEntries);
  const kinds = entries.map((one) => one.kind);
  assert.deepEqual(kinds, ['heartbeat', 'heartbeat', 'reboot', 'event', 'heartbeat', 'problem', 'reboot']);
  assert.deepEqual(entries[0].values, {
    Heap_BytesFree: 21624,
    power_usb_present: 1,
    supply_mv: 3300,
    cpu_usage_pct: 12.5,
  });
  assert.equal(entries[2].reason.name, 'FirmwareUpdate');
  assert.deepEqual([entries[3].name, entries[3].detail], ['update_succeeded', '1.15.0+0']);
  // Without the build's symbols Memfault cannot name a heartbeat's values: they are counted, not guessed.
  assert.deepEqual([entries[4].values, entries[4].unnamed], [null, 2]);
  assert.deepEqual([entries[5].type, entries[5].builds, entries[5].thing], ['SymbolFileMissing', ['2fdf2f7e8b95'], B]);
  assert.equal(entries[6].crashed, true);
  assert.deepEqual(logEntries({ event_type: 'Other' }), []);
});

// The routes.

function world({ configured = true } = {}) {
  fresh();
  const console_ = createTestConsole();
  console_.fake.addThing(A);
  console_.fake.addThing(B);
  if (configured) {
    console_.fake.useMemfault(
      createMemfaultReader(MEMFAULT_ENV, { fetch: memfault.fetch, readSecret: async () => TOKEN })
    );
  }
  const viewer = console_.addUser('viewer', ['viewers']);
  const get = (path, as = viewer) => {
    const [bare, search] = path.split('?');
    const query = search === undefined ? undefined : Object.fromEntries(new URLSearchParams(search));
    return console_.call('GET', bare, { as, query });
  };
  return { ...console_, viewer, get };
}

test('GET /api/memfault/fleet: devices tied to boards, releases with their symbols, reboots by reason, latest metrics', async () => {
  const { get, fake } = world();
  const { status, body } = await get('/api/memfault/fleet');
  assert.equal(status, 200);
  assert.deepEqual(body.memfault, { state: 'ok', message: '' });
  assert.deepEqual(
    body.devices.map((one) => [one.serial, one.thing, one.registered]),
    [
      ['bench-unit-1', null, false],
      [A, A, true],
    ]
  );
  assert.deepEqual(
    body.releases.map((one) => [one.version, one.symbols]),
    [
      ['1.15.0+0', true],
      ['1.14.0+0', false],
    ]
  );
  assert.deepEqual(
    body.reboots.byReason.map((one) => [one.reason.name, one.count, one.boards]),
    [
      ['FirmwareUpdate', 1, [A]],
      ['KernelPanic', 1, [B]],
    ]
  );
  // Every metric key that any heartbeat has, the newest value of each.
  assert.deepEqual(body.metrics.keys, ['Heap_BytesFree', 'cpu_usage_pct', 'power_usb_present', 'supply_mv']);
  const a = body.metrics.boards.find((one) => one.serial === A);
  assert.deepEqual(a.values.supply_mv, { v: 3300, at: '2026-11-09T17:06:39.000Z' });
  assert.equal(body.metrics.boards.find((one) => one.serial === B).unnamed, 1);
  assert.deepEqual(
    body.events.map((one) => one.name),
    ['update_succeeded']
  );
  assert.deepEqual(
    body.problems.map((one) => [one.type, one.builds, one.boards]),
    [['SymbolFileMissing', ['2fdf2f7e8b95'], [B]]]
  );
  // Read-only: GETs alone, and nothing on record.
  assert.ok(memfault.requests.every((request) => request.method === 'GET'));
  assert.equal(fake.auditLog().length, 0);
});

test('the processing log is followed page by page, a few pages at most', async () => {
  const { get } = world();
  memfault.state.logPageSize = 2;
  const { body } = await get('/api/memfault/fleet');
  const pages = memfault.requests.filter((request) => request.path.endsWith('/processing-log'));
  assert.equal(pages.length, 3);
  assert.equal(pages[0].query.get('include_event_data'), 'true');
  assert.equal(pages[0].query.get('sort'), '-created_date');
  assert.match(pages[0].query.get('start'), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(pages[1].query.get('page[after]'), '2026-11-09T16:06:55+00:00');
  assert.equal(body.reboots.byReason.length, 2);
});

test('GET /api/memfault/issues and /issues/{id}: the list, then an issue with its traces and backtraces', async () => {
  const { get } = world();
  const list = await get('/api/memfault/issues');
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.body.issues.map((one) => [one.id, one.title, one.traces, one.boards]),
    [
      [11, 'Kernel panic at crash_demo_on_tick', 2, 1],
      [12, 'update_failed', 1, 1],
    ]
  );
  const one = await get('/api/memfault/issues/11');
  assert.equal(one.status, 200);
  assert.equal(one.body.issue.firstVersion, '1.14.0+1');
  // Only this issue's traces, even though the list Memfault gave held another's.
  assert.deepEqual(
    one.body.traces.map((item) => item.id),
    [101]
  );
  assert.deepEqual(one.body.boards, [A]);
  assert.equal(one.body.traces[0].threads[0].frames[0].function, 'crash_demo_on_tick');

  assert.deepEqual(
    [(await get('/api/memfault/issues/999')).status, (await get('/api/memfault/issues/999')).body.error.code],
    [404, 'not_found']
  );
  for (const id of ['abc', '0', '-1', '1.5', '1'.repeat(17)]) {
    const refused = await get(`/api/memfault/issues/${id}`);
    assert.deepEqual([refused.status, refused.body.error.code], [404, 'not_found'], id);
  }
});

test("GET /api/devices/{thing}/memfault: a board's reboots, metric series, events, traces and issues", async () => {
  const { get } = world();
  const { status, body } = await get(`/api/devices/${A}/memfault?hours=168`);
  assert.equal(status, 200);
  assert.equal(body.known, true);
  assert.equal(body.device.software, '1.15.0+0');
  assert.equal(body.hours, 168);
  assert.deepEqual(
    body.reboots.map((one) => one.reason.name),
    ['FirmwareUpdate', 'KernelPanic', 'StuckNoCloud']
  );
  assert.deepEqual(body.metrics.keys, ['Heap_BytesFree', 'cpu_usage_pct', 'power_usb_present', 'supply_mv']);
  assert.deepEqual(body.metrics.series.supply_mv, [
    { at: '2026-11-09T16:06:39.000Z', v: 3290 },
    { at: '2026-11-09T17:06:39.000Z', v: 3300 },
  ]);
  assert.deepEqual(
    body.events.map((one) => one.name),
    ['update_succeeded']
  );
  assert.deepEqual(
    body.traces.map((one) => one.id),
    [101]
  );
  assert.equal(body.traces[0].threads, undefined);
  assert.deepEqual(
    body.issues.map((one) => one.id),
    [11]
  );
  const asked = memfault.requests.find((request) => request.path.endsWith('/processing-log'));
  assert.equal(asked.query.get('device_serial'), A);

  // A board Memfault never heard of is no failure.
  const silent = await get(`/api/devices/${B}/memfault`);
  assert.equal(silent.status, 200);
  assert.deepEqual([silent.body.known, silent.body.reboots, silent.body.hours], [false, [], 24]);
});

test('a board page refuses what it cannot answer, as the other routes do', async () => {
  const { get } = world();
  const refused = async (path, code, status = 400) => {
    const answer = await get(path);
    assert.deepEqual([answer.status, answer.body.error.code], [status, code], path);
  };
  await refused('/api/devices/cranium-XYZ/memfault', 'invalid_thing');
  await refused('/api/devices/cranium-1111111111111111/memfault', 'unknown_device', 404);
  for (const hours of ['0', '169', 'x', '1.5', ''])
    await refused(`/api/devices/${A}/memfault?hours=${hours}`, 'invalid_hours');
});

test('answers are kept a minute, failures a quarter of a minute, and Memfault is asked again after', async () => {
  const { get, advance } = world();
  await get('/api/memfault/issues');
  await get('/api/memfault/issues');
  assert.equal(memfault.requests.length, 1);
  advance(FRESH_MS);
  await get('/api/memfault/issues');
  assert.equal(memfault.requests.length, 2);

  memfault.state.fail = () => 503;
  advance(FRESH_MS);
  const down = await get('/api/memfault/issues');
  assert.equal(down.status, 200);
  assert.deepEqual(down.body.memfault, { state: 'unreachable', message: MEMFAULT_WORDS.unreachable });
  assert.deepEqual(down.body.issues, []);
  await get('/api/memfault/issues');
  assert.equal(memfault.requests.length, 3);
  memfault.state.fail = () => null;
  advance(FAILED_MS);
  assert.equal((await get('/api/memfault/issues')).body.issues.length, 2);
  assert.equal(memfault.requests.length, 4);
});

test('Memfault unreachable, refusing or limiting, or no token: plain words in a 200, never a failure', async () => {
  for (const [status, state] of [
    [401, 'refused'],
    [429, 'limited'],
    [500, 'unreachable'],
  ]) {
    const { get } = world();
    memfault.state.fail = () => status;
    for (const path of [
      '/api/memfault/fleet',
      '/api/memfault/issues',
      '/api/memfault/issues/11',
      `/api/devices/${A}/memfault`,
    ]) {
      const answer = await get(path);
      assert.equal(answer.status, 200, path);
      assert.equal(answer.body.memfault.state, state, path);
      assert.equal(answer.body.memfault.message, MEMFAULT_WORDS[state]);
    }
  }
  const { get, logs } = world({ configured: false });
  const answer = await get('/api/memfault/fleet');
  assert.deepEqual([answer.status, answer.body.memfault.state], [200, 'not_configured']);
  assert.match(answer.body.memfault.message, /cloud\/deploy\.sh/);
  assert.equal(JSON.stringify(logs).includes(TOKEN), false);
  // Every state has words; none of them names a token or a slug.
  for (const words of Object.values(MEMFAULT_WORDS))
    assert.equal(/oat_|cranium-team|cranium-boards/.test(words), false);
});

test('viewers, release managers and API tokens may read; nothing is written', async () => {
  const console_ = world();
  const manager = console_.addUser('manager', ['release-managers']);
  for (const as of [console_.viewer, manager]) {
    assert.equal((await console_.get('/api/memfault/issues', as)).status, 200);
  }
  const nobody = console_.addUser('nobody', []);
  assert.equal((await console_.get('/api/memfault/issues', nobody)).status, 403);
  assert.equal(console_.fake.auditLog().length, 0);
});
