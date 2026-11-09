// Tests for the health gate of a staged rollout (handlers/rollouts.mjs, lib/health.mjs, handlers/memfault.mjs
// health): after the canary, the next stage waits for the gate's minutes and then for Memfault to show no new
// issue and no unexpected reboot on the release; a problem or a Memfault that cannot be read stops it, says why
// and raises an alert. Against the fake AWS and a fake Memfault that is a real HTTP server (fake-memfault.mjs).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createMemfaultReader } from '../src/aws-memfault-api.mjs';
import { candidateIssues, gateBoards, judgeHealth, sameVersion } from '../src/lib/health.mjs';
import { rebootReason } from '../src/lib/memfault-data.mjs';
import { requireHealthGate, suggestPlan } from '../src/lib/stages.mjs';
import { MEMFAULT_ENV, TOKEN, startFakeMemfault } from './fake-memfault.mjs';
import { A, B, C, fleetConsole } from './fleet-world.mjs';

const MINUTE = 60_000;
const VERSION = '1.13.0+0';

let memfault;
before(async () => {
  memfault = await startFakeMemfault();
});
after(() => memfault.close());

const iso = (ms) => new Date(ms).toISOString();
const createJobs = (world) =>
  world.fake.calls.filter((call) => call.method === 'createJob').map((call) => call.args[0]);
const detailOf = async (world, id) => (await world.call('GET', `/api/rollouts/${id}`)).body.rollout;

function emptyMemfault() {
  return { devices: [], reboots: {}, issues: [], traces: [], releases: [], versions: [], log: [] };
}

/** A fleet of three boards on 1.12.0, a release 1.13.0, and Memfault read through the fake. */
async function gatedWorld() {
  memfault.state.world = emptyMemfault();
  memfault.state.fail = () => null;
  memfault.requests.length = 0;
  const world = fleetConsole();
  for (const thing of [A, B, C]) world.online(thing, '1.12.0+0');
  await world.release(VERSION);
  world.fake.useMemfault(
    createMemfaultReader(MEMFAULT_ENV, {
      fetch: memfault.fetch,
      now: () => world.clock.ms,
      readSecret: async () => TOKEN,
    })
  );
  return world;
}

/** A gated rollout to the fleet whose canary has confirmed: { world, rollout, canary, confirmedAt }. */
async function confirmedCanary(gate = { on: true, minutes: 10 }) {
  const world = await gatedWorld();
  const made = await world.call('POST', '/api/rollouts', {
    version: VERSION,
    target: { kind: 'fleet' },
    healthGate: gate,
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const { rollout } = made.body;
  const [canary] = rollout.canary.things;
  world.finish(rollout.canary.job, canary, 'SUCCEEDED', VERSION);
  world.advance(MINUTE);
  assert.equal((await world.tick()).advanced, 1);
  const confirmedAt = world.clock.ms;
  return { world, rollout, canary, confirmedAt };
}

function rebootEntry(thing, at, reason, version = VERSION) {
  return {
    created_date: iso(at + 1000),
    device_serial: thing,
    software_version: version,
    event_type: 'ReceivedDataRebootEvent',
    level: 'info',
    source: 'trace',
    event_data: { received_event: { captured_date: iso(at), event_info: { reason, coredump_saved: false } } },
  };
}

function issueWith(id, title, thing, at, version = VERSION) {
  return {
    issue: {
      id,
      title,
      status: 'open',
      trace_count: 1,
      device_count: 1,
      first_seen: iso(at),
      last_seen: iso(at),
      first_release: { id: 1, version },
      last_release: { id: 1, version },
      signature: `sig-${id}`,
    },
    trace: {
      id: id * 10,
      title,
      reason: 'Assert',
      captured_date: iso(at),
      received_date: iso(at + 2000),
      device: { id: 1, device_serial: thing },
      release: { id: 1, version },
      signature: `sig-${id}`,
      entries: { threads: [] },
    },
  };
}

// The rules, without Memfault.

test('the gate looks at the boards updated so far, each since its own part started, on the new version only', () => {
  const item = {
    createdAt: '2026-11-04T12:00:00.000Z',
    canary: { things: [A] },
    stages: [
      { things: [B], startedAt: '2026-11-04T12:20:00.000Z' },
      { things: [C], startedAt: null },
    ],
  };
  const t = (at) => Date.parse(at);
  assert.deepEqual(gateBoards(item, -1), [{ thing: A, since: t('2026-11-04T12:00:00.000Z') }]);
  assert.deepEqual(gateBoards(item, 0), [
    { thing: A, since: t('2026-11-04T12:00:00.000Z') },
    { thing: B, since: t('2026-11-04T12:20:00.000Z') },
  ]);
  assert.ok(sameVersion('1.13.0', '1.13.0+0') && !sameVersion('1.13.0+1', '1.13.0+0') && !sameVersion(null, 'x'));

  const boards = gateBoards(item, 0);
  const reboot = (thing, at, code, version = VERSION) => ({ thing, at, version, reason: rebootReason(code) });
  // An expected reboot (the update's own), one before B's stage, and one on the old version: none counts.
  const quiet = [
    reboot(A, '2026-11-04T12:05:00.000Z', 0x0003),
    reboot(B, '2026-11-04T12:10:00.000Z', 0x8001),
    reboot(A, '2026-11-04T12:30:00.000Z', 0x8001, '1.12.0+0'),
  ];
  assert.equal(judgeHealth({ version: VERSION, boards, reboots: quiet, issues: [] }), null);
  assert.deepEqual(
    judgeHealth({
      version: VERSION,
      boards,
      reboots: [...quiet, reboot(B, '2026-11-04T12:25:00.000Z', 0x9400)],
      issues: [],
    }),
    { kind: 'reboot', thing: B, at: '2026-11-04T12:25:00.000Z', reason: 'HardFault' }
  );
  // Of the issues, only those seen since the start on this version are read, newest first.
  const issues = [
    { id: 1, lastSeen: '2026-11-04T11:00:00.000Z', firstVersion: VERSION, lastVersion: VERSION },
    { id: 2, lastSeen: '2026-11-04T12:40:00.000Z', firstVersion: '1.12.0+0', lastVersion: '1.12.0+0' },
    { id: 3, lastSeen: '2026-11-04T12:30:00.000Z', firstVersion: '1.12.0+0', lastVersion: VERSION },
    { id: 4, lastSeen: '2026-11-04T12:45:00.000Z', firstVersion: null, lastVersion: null },
  ];
  assert.deepEqual(
    candidateIssues(issues, VERSION, t('2026-11-04T12:00:00.000Z')).map((issue) => issue.id),
    [4, 3]
  );
});

test('a health gate is { on, minutes } in a request, 0 to 120 minutes, 10 unless given; the suggestion has it on', () => {
  assert.equal(requireHealthGate(undefined), null);
  assert.equal(requireHealthGate(null), null);
  assert.equal(requireHealthGate({ on: false, minutes: 30 }), null);
  assert.deepEqual(requireHealthGate({ on: true }), { minutes: 10 });
  assert.deepEqual(requireHealthGate({ on: true, minutes: 0 }), { minutes: 0 });
  for (const bad of [
    true,
    [],
    { on: 'yes' },
    { on: true, minutes: 121 },
    { on: true, minutes: -1 },
    { on: true, extra: 1 },
  ]) {
    assert.throws(() => requireHealthGate(bad), { code: 'invalid_healthGate' }, JSON.stringify(bad));
  }
  const plan = suggestPlan({ boards: [A, B, C], online: [A, B, C] });
  assert.deepEqual(plan.healthGate, { on: true, minutes: 10 });
  assert.match(plan.reasons.health, /^Health gate on, 10 minutes: .*no new Memfault issue and no unexpected reboot/);
});

// The gate, end to end.

test('a gate that passes: the next stage waits its minutes, Memfault shows nothing new, and the stage starts', async () => {
  const { world, rollout, canary, confirmedAt } = await confirmedCanary();
  assert.deepEqual(rollout.healthGate, { minutes: 10 });
  assert.match(world.entries('rollout.create').at(-1).detail.stages, /, gate 10 min$/);
  // What Memfault has is no problem: the update's own restart, an issue on the old version, a crash before the
  // rollout started.
  const known = issueWith(11, 'Old crash', canary, Date.parse(rollout.createdAt) + 2 * MINUTE, '1.12.0+0');
  memfault.state.world.issues.push(known.issue);
  memfault.state.world.traces.push(known.trace);
  memfault.state.world.log.push(
    rebootEntry(canary, Date.parse(rollout.createdAt) + 30_000, 0x0003),
    rebootEntry(canary, Date.parse(rollout.createdAt) - 10 * MINUTE, 0x8001)
  );
  assert.equal(createJobs(world).length, 1);
  assert.equal(memfault.requests.length, 0, 'Memfault is not asked before the gate is due');
  world.advance(9 * MINUTE);
  assert.equal((await world.tick()).advanced, 0);
  assert.equal(createJobs(world).length, 1);

  world.clock.ms = confirmedAt + 10 * MINUTE;
  assert.equal((await world.tick()).advanced, 1);
  assert.equal(createJobs(world).length, 2);
  const paths = memfault.requests.map((request) => request.path.split('/').slice(-1)[0]);
  assert.ok(paths.includes('processing-log') && paths.includes('issues'), paths.join(' '));
  assert.ok(memfault.requests.every((request) => request.method === 'GET'));
  const detail = await detailOf(world, rollout.id);
  assert.equal(detail.canary.gatePassedAt, iso(world.clock.ms));
  assert.deepEqual([detail.stage, detail.stages[0].state], ['stages', 'running']);
  const passed = world.entries('rollout.advance').find((entry) => entry.detail.gate === 'passed');
  assert.deepEqual([passed.detail.after, passed.actor.sub], ['canary', '']);
  assert.equal(world.raised.length, 0);
});

test('a new Memfault issue on the release stops the rollout with the board, the issue and a link, and an alert', async () => {
  const { world, rollout, canary, confirmedAt } = await confirmedCanary();
  const found = issueWith(21, 'Assert at sensor_read', canary, confirmedAt + 3 * MINUTE);
  memfault.state.world.issues.push(found.issue);
  memfault.state.world.traces.push(found.trace);
  world.clock.ms = confirmedAt + 10 * MINUTE;
  assert.equal((await world.tick()).stopped, 1);
  assert.equal(createJobs(world).length, 1, 'stage 1 never starts');
  const detail = await detailOf(world, rollout.id);
  assert.equal(detail.stage, 'stopped');
  assert.equal(detail.stopped.code, 'health_failed');
  assert.equal(
    detail.stopped.text,
    `After the canary, the health gate failed: ${canary} has a new Memfault issue on this version, ` +
      '#21 "Assert at sensor_read": the next stage was not started'
  );
  assert.deepEqual([detail.stopped.thing, detail.stopped.issue], [canary, { id: 21, title: 'Assert at sensor_read' }]);
  assert.deepEqual(
    world.entries('rollout.stop').map((entry) => entry.detail.code),
    ['health_failed']
  );
  assert.equal(world.raised.length, 1);
  assert.deepEqual(
    [world.raised[0].kind, world.raised[0].deployment, world.raised[0].rollout, world.raised[0].link],
    ['deployment', rollout.canary.job, rollout.id, '#/memfault/21']
  );
  assert.match(world.raised[0].text, /health gate failed: .* #21 "Assert at sensor_read"/);
  await world.tick();
  assert.equal(world.raised.length, 1);
});

test('an unexpected reboot on the release stops the rollout and names the board and the reason', async () => {
  const { world, rollout, canary, confirmedAt } = await confirmedCanary({ on: true, minutes: 5 });
  memfault.state.world.log.push(rebootEntry(canary, confirmedAt + MINUTE, 0x8001));
  world.clock.ms = confirmedAt + 5 * MINUTE;
  assert.equal((await world.tick()).stopped, 1);
  const detail = await detailOf(world, rollout.id);
  assert.deepEqual(
    [detail.stopped.code, detail.stopped.thing, detail.stopped.reason],
    ['health_failed', canary, 'Assert']
  );
  assert.match(detail.stopped.text, new RegExp(`${canary} restarted unexpectedly on this version \\(Assert\\)`));
  assert.equal(createJobs(world).length, 1);
  assert.equal(world.raised[0].link, `#/rollouts/${rollout.id}`);
});

test('a Memfault that cannot be read holds the gate, never passes it, and stops the rollout after 30 minutes', async () => {
  const { world, rollout, confirmedAt } = await confirmedCanary();
  memfault.state.fail = () => 503;
  world.clock.ms = confirmedAt + 10 * MINUTE;
  assert.deepEqual(await world.tick(), { checked: 1, advanced: 0, stopped: 0, done: 0, failed: 0 });
  assert.ok(world.tickLogs.some((line) => line.event === 'health_gate_unread' && line.state === 'unreachable'));
  world.clock.ms = confirmedAt + 39 * MINUTE;
  assert.equal((await world.tick()).stopped, 0);
  assert.equal(createJobs(world).length, 1);
  assert.equal((await detailOf(world, rollout.id)).stage, 'stages');

  world.clock.ms = confirmedAt + 40 * MINUTE;
  assert.equal((await world.tick()).stopped, 1);
  const detail = await detailOf(world, rollout.id);
  assert.equal(detail.stopped.code, 'health_unknown');
  assert.equal(
    detail.stopped.text,
    'After the canary, the health gate could not read Memfault for 30 minutes (Memfault could not be reached): ' +
      'the next stage was not started'
  );
  assert.equal(createJobs(world).length, 1);
  assert.equal(world.raised.length, 1);
  assert.equal(world.raised[0].kind, 'deployment');
});

test('without a Memfault token the gate waits too, and stops saying so; a rollout without a gate does not wait', async () => {
  const world = await gatedWorld();
  world.fake.useMemfault(null);
  const { rollout } = (
    await world.call('POST', '/api/rollouts', { version: VERSION, target: { kind: 'fleet' }, healthGate: { on: true } })
  ).body;
  world.finish(rollout.canary.job, rollout.canary.things[0], 'SUCCEEDED', VERSION);
  await world.tick();
  const confirmedAt = world.clock.ms;
  world.clock.ms = confirmedAt + 40 * MINUTE;
  assert.equal((await world.tick()).stopped, 1);
  assert.match((await detailOf(world, rollout.id)).stopped.text, /\(the console has no Memfault token\)/);

  // Without a gate (a script, or a client from before it): the stage starts once the canary has confirmed.
  const plain = await gatedWorld();
  const made = (await plain.call('POST', '/api/rollouts', { version: VERSION, target: { kind: 'fleet' } })).body
    .rollout;
  assert.equal(made.healthGate, null);
  plain.finish(made.canary.job, made.canary.things[0], 'SUCCEEDED', VERSION);
  assert.equal((await plain.tick()).advanced, 1);
  assert.equal(createJobs(plain).length, 2);
});

test('a bad health gate is refused and on record; the suggestion carries the gate', async () => {
  const world = await gatedWorld();
  const bad = await world.call('POST', '/api/rollouts', {
    version: VERSION,
    target: { kind: 'fleet' },
    healthGate: { on: true, minutes: 500 },
  });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'invalid_healthGate']);
  assert.equal(world.entries('rollout.create').at(-1).outcome, 'rejected');
  const viewer = await world.call(
    'POST',
    '/api/rollouts',
    { version: VERSION, target: { kind: 'fleet' }, healthGate: { on: true } },
    world.viewer
  );
  assert.deepEqual([viewer.status, viewer.body.error.code], [403, 'release_manager_required']);
  const suggested = await world.call('GET', `/api/rollouts/suggest?release=${encodeURIComponent(VERSION)}`);
  assert.deepEqual(suggested.body.suggestion.healthGate, { on: true, minutes: 10 });
  assert.match(suggested.body.suggestion.reasons.health, /Health gate on/);
});
