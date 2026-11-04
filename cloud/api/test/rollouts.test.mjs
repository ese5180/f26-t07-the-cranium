// Tests for staged rollouts (handlers/rollouts.mjs, lib/fleet.mjs): which boards a release goes to and
// why the others are left out, the canary and what moves a rollout on from it, the waves AWS IoT
// paces and stops, cancelling, "Update everything" and rolling a group back.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LEFT_OUT, OFFLINE_LONG_MS, canaryVerdict, chooseCanary, failureShare, rolloutConfigs, selectTargets, wavePlan,
} from '../src/lib/fleet.mjs';
import { A, B, C, D, E, fleetConsole, report } from './fleet-world.mjs';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const board = (thing, changes = {}) => ({
  thing, type: 'nrf7002dk', bluetoothOnly: false, online: true, lastSeen: new Date(NOW).toISOString(), version: '1.0.0+0',
  ...changes,
});
const createJobs = (world) => world.fake.calls.filter((call) => call.method === 'createJob').map((call) => call.args[0]);

// The rules, without AWS.

test('a release goes to the boards of its type that can take it; the others are left out, each with why', () => {
  const release = { version: '1.13.0+0', board: 'nrf7002dk' };
  const { things, leftOut } = selectTargets({
    release,
    candidates: [
      board(A), board(B, { version: '1.13.0+0' }), board(C, { version: '1.14.0+0' }), board(D, { type: 'nrf5340dk', bluetoothOnly: true }),
      board(E, { online: false, lastSeen: new Date(NOW - OFFLINE_LONG_MS - 1).toISOString() }),
      board('cranium-00000000000000ff', { online: false, lastSeen: null, version: null }),
      board('cranium-0000000000000011'),
    ],
    busy: new Map([['cranium-0000000000000011', 'cranium-1-0-0-b0-20261104T110000Z-aaaa']]),
    nowMs: NOW,
    leaveOutAway: true,
  });
  assert.deepEqual(things, [A]);
  assert.deepEqual(leftOut.map((entry) => [entry.thing, entry.reason]), [
    ['cranium-0000000000000011', 'busy'], [B, 'current'], [C, 'newer'], [D, 'other_type'], [E, 'offline'],
    ['cranium-00000000000000ff', 'never'],
  ]);
  assert.match(leftOut[0].text, /cranium-1-0-0-b0-20261104T110000Z-aaaa/);
  // Without leaving out the boards that are away, they are offered it and take it when they are back.
  assert.deepEqual(selectTargets({ release, candidates: [board(E, { online: false, lastSeen: null })], nowMs: NOW }).things, [E]);
  // A release of the Bluetooth-only type: its boards are left out of every job.
  const bt = selectTargets({ release: { version: '1.0.0+0', board: 'nrf5340dk' }, candidates: [board(D, { type: 'nrf5340dk', bluetoothOnly: true })], nowMs: NOW });
  assert.deepEqual(bt.leftOut.map((entry) => [entry.reason, entry.text]), [['bluetooth_only', LEFT_OUT.bluetooth_only]]);
  // Going back to an older release, a board on something newer would refuse it.
  const older = selectTargets({ release, candidates: [board(C, { version: '1.14.0+0' })], nowMs: NOW, older: true });
  assert.equal(older.leftOut[0].reason, 'older_refused');
});

test('the canary is a board that is online and heard from last; the waves are paced and stopped by AWS IoT', () => {
  const boards = [board(A, { online: false }), board(B, { lastSeen: new Date(NOW - 60_000).toISOString() }), board(C)];
  assert.deepEqual(chooseCanary([A, B, C], boards, 1), [C]);
  assert.deepEqual(chooseCanary([A, B, C], boards, 2), [B, C]);
  assert.deepEqual(chooseCanary([A], boards, 3), [A]);

  assert.deepEqual(rolloutConfigs(), {
    rollout: {
      maximumPerMinute: 50,
      exponentialRate: { baseRatePerMinute: 1, incrementFactor: 2, rateIncreaseCriteria: { numberOfSucceededThings: 1 } },
    },
    abort: { criteriaList: [{ failureType: 'ALL', action: 'CANCEL', thresholdPercentage: 20, minNumberOfExecutedThings: 1 }] },
  });
  assert.equal(rolloutConfigs({ wave: 60, abortPercent: 50 }).rollout.maximumPerMinute, 60);
  assert.deepEqual(wavePlan(10), [1, 2, 4, 3]);
  assert.deepEqual(wavePlan(10, 3), [3, 6, 1]);
  assert.deepEqual(wavePlan(0), []);

  const executions = (statuses) => statuses.map(([thing, status]) => ({ thing, status }));
  assert.equal(canaryVerdict([A], executions([[A, 'IN_PROGRESS']])).state, 'waiting');
  assert.equal(canaryVerdict([A], []).state, 'waiting');
  assert.equal(canaryVerdict([A, B], executions([[A, 'SUCCEEDED'], [B, 'QUEUED']])).state, 'waiting');
  assert.equal(canaryVerdict([A, B], executions([[A, 'SUCCEEDED'], [B, 'SUCCEEDED']])).state, 'confirmed');
  assert.deepEqual(canaryVerdict([A, B], executions([[A, 'SUCCEEDED'], [B, 'FAILED']])).failed, [{ thing: B, status: 'FAILED' }]);
  assert.deepEqual(failureShare(executions([[A, 'SUCCEEDED'], [B, 'FAILED'], [C, 'QUEUED'], [D, 'TIMED_OUT']])),
    { executed: 3, failed: 2, percent: 200 / 3 });
});

// Starting a rollout.

async function fiveBoards() {
  const world = fleetConsole();
  for (const thing of [A, B, C, D]) world.online(thing, '1.12.0+0');
  world.bluetoothOnly(E);
  await world.release('1.13.0+0');
  return world;
}

test('a rollout to boards named one by one refuses another type, a Bluetooth-only board or a busy one', async () => {
  const world = await fiveBoards();
  await world.release('1.13.1+0', 'nrf5340dk');
  const post = (body) => world.call('POST', '/api/rollouts', { version: '1.13.0+0', ...body });
  const other = await world.call('POST', '/api/rollouts', { version: '1.13.1+0', target: { kind: 'boards', things: [A] } });
  assert.deepEqual([other.status, other.body.error.code], [400, 'incompatible_board']);
  const away = await post({ target: { kind: 'boards', things: [A, E] } });
  assert.deepEqual([away.status, away.body.error.code], [400, 'incompatible_board']);
  const typed = await post({ target: { kind: 'type', type: 'nrf5340dk' } });
  assert.deepEqual([typed.status, typed.body.error.code], [400, 'incompatible_board']);

  assert.equal((await world.call('POST', '/api/deployments', { version: '1.13.0+0', things: [B] })).status, 201);
  const busy = await post({ target: { kind: 'boards', things: [A, B] } });
  assert.deepEqual([busy.status, busy.body.error.code, busy.body.error.details], [409, 'device_busy', [{ thing: B, deployment: busy.body.error.details[0].deployment }]]);

  for (const [body, code] of [[{ target: { kind: 'all' } }, 'invalid_target'], [{ target: { kind: 'boards', things: [] } }, 'invalid_things'],
    [{ target: { kind: 'fleet' }, canary: 0 }, 'invalid_canary'], [{ target: { kind: 'fleet' }, abortPercent: 101 }, 'invalid_abortPercent'],
    [{ target: { kind: 'fleet' }, wave: 1.5 }, 'invalid_wave']]) {
    const response = await post(body);
    assert.deepEqual([response.status, response.body.error.code], [400, code], JSON.stringify(body));
  }
  assert.deepEqual(world.entries('rollout.create').map((entry) => entry.outcome),
    ['rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
  assert.equal(world.fake.fleetItems.size, 0);
});

test('a rollout to the fleet takes the boards of the release\'s type, starts with one canary, and is on record', async () => {
  const world = await fiveBoards();
  world.online(D, '1.13.0+0');
  const response = await world.call('POST', '/api/rollouts', { version: '1.13.0+0', target: { kind: 'fleet' }, note: 'Evening build' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const { rollout } = response.body;
  assert.match(rollout.id, /^rol-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  assert.deepEqual([rollout.stage, rollout.board, rollout.things], ['canary', 'nrf7002dk', [A, B, C]]);
  assert.deepEqual(rollout.leftOut.map((entry) => [entry.thing, entry.reason]), [[D, 'current'], [E, 'other_type']]);
  assert.equal(rollout.canary.things.length, 1);
  assert.deepEqual(rollout.rest.things, [A, B, C].filter((thing) => !rollout.canary.things.includes(thing)));
  assert.deepEqual(rollout.plan, [1, 1]);
  // The canary's job, on the canary alone; one canary needs no stop of its own.
  const [job] = createJobs(world);
  assert.deepEqual(job.things, rollout.canary.things);
  assert.equal(job.rollout, undefined);
  assert.equal(job.abort, undefined);
  assert.match(JSON.parse(job.description).note, new RegExp(`^Canary of staged rollout ${rollout.id}: Evening build$`));
  assert.equal(rollout.canaryJob.id, job.jobId);
  const entry = world.entries('rollout.create').at(-1);
  assert.deepEqual([entry.outcome, entry.target, entry.detail.kind, entry.detail.things, entry.detail.canary],
    ['ok', rollout.id, 'fleet', '3', rollout.canary.things[0]]);

  // A larger canary is stopped by AWS too, when its boards fail.
  world.advance(1000);
  for (const thing of [A, B, C]) world.fake.device(thing).report(report('1.12.0+0'));
  const two = await world.call('POST', '/api/rollouts', { version: '1.13.0+0', target: { kind: 'boards', things: [D] } });
  assert.deepEqual([two.status, two.body.error.code], [422, 'nothing_to_deploy']);
  assert.equal(two.body.error.details[0].reason, 'current');
});

test('the canary\'s confirmation starts the waves: one job on the rest, paced and stopped by AWS IoT', async () => {
  const world = await fiveBoards();
  const { rollout } = (await world.call('POST', '/api/rollouts', {
    version: '1.13.0+0', target: { kind: 'fleet' }, wave: 2, abortPercent: 25,
  })).body;
  const [canary] = rollout.canary.things;
  // While the canary works, nothing moves on.
  assert.deepEqual(await world.tick(), { checked: 1, advanced: 0, stopped: 0, done: 0, failed: 0 });
  world.fake.execution(rollout.canary.job, canary).update('IN_PROGRESS', { step: 'rebooting' });
  assert.equal((await world.tick()).advanced, 0);
  assert.equal(createJobs(world).length, 1);

  // Meanwhile one of the rest got the release some other way: it is left out of the waves.
  const others = rollout.rest.things;
  world.fake.device(others[0]).report(report('1.13.0+0'));
  world.finish(rollout.canary.job, canary, 'SUCCEEDED', '1.13.0+0');
  world.advance(60_000);
  assert.equal((await world.tick()).advanced, 1);
  const waves = createJobs(world)[1];
  assert.deepEqual(waves.things, others.slice(1));
  assert.deepEqual(waves.rollout, rolloutConfigs({ wave: 2, abortPercent: 25 }).rollout);
  assert.deepEqual(waves.abort, rolloutConfigs({ wave: 2, abortPercent: 25 }).abort);
  assert.match(JSON.parse(waves.description).note, /^Waves of staged rollout /);
  // In the creator's name, started by the console, and said so in the activity log.
  assert.equal(JSON.parse(waves.description).sub, world.manager.sub);
  const advance = world.entries('rollout.advance').at(-1);
  assert.deepEqual([advance.actor, advance.target, advance.detail.job, advance.detail.things],
    [{ sub: '', email: '' }, rollout.id, waves.jobId, '2']);

  const detail = (await world.call('GET', `/api/rollouts/${rollout.id}`)).body.rollout;
  assert.equal(detail.stage, 'waves');
  assert.deepEqual(detail.rest.leftOut.map((entry) => [entry.thing, entry.reason]), [[others[0], 'current']]);
  assert.equal(detail.wavesJob.id, waves.jobId);
  assert.deepEqual(detail.waves.map((wave) => wave.things.length), [2]);
  assert.deepEqual(detail.notOffered, []);

  // The waves end: the rollout is done. The tick does not touch it again.
  for (const thing of waves.things) world.finish(waves.jobId, thing, 'SUCCEEDED', '1.13.0+0');
  assert.equal((await world.tick()).done, 1);
  assert.equal((await world.call('GET', `/api/rollouts/${rollout.id}`)).body.rollout.stage, 'done');
  assert.deepEqual(await world.tick(), { checked: 0, advanced: 0, stopped: 0, done: 0, failed: 0 });
});

test('a canary that does not confirm stops the rollout, and the rest are never offered it', async () => {
  const world = await fiveBoards();
  const { rollout } = (await world.call('POST', '/api/rollouts', { version: '1.13.0+0', target: { kind: 'fleet' } })).body;
  world.finish(rollout.canary.job, rollout.canary.things[0], 'FAILED');
  assert.equal((await world.tick()).stopped, 1);
  const detail = (await world.call('GET', `/api/rollouts/${rollout.id}`)).body.rollout;
  assert.deepEqual([detail.stage, detail.stopped.code], ['stopped', 'canary_failed']);
  assert.equal(detail.stopped.text, `The canary did not confirm the update: ${rollout.canary.things[0]} failed (rolled_back)`);
  assert.equal(createJobs(world).length, 1);
  assert.deepEqual(world.entries('rollout.stop').map((entry) => entry.detail.code), ['canary_failed']);
  // And it is an e-mail alert, of the canary's job, once.
  assert.deepEqual(world.raised, [{
    kind: 'deployment', deployment: rollout.canary.job, version: '1.13.0+0', at: world.clock.ms,
    text: `Staged rollout ${rollout.id} of 1.13.0+0: ${detail.stopped.text}`,
  }]);
  await world.tick();
  assert.equal(world.raised.length, 1);
});

test('the waves stop by themselves once failures reach the threshold: what has not started never does', async () => {
  const world = await fiveBoards();
  const { rollout } = (await world.call('POST', '/api/rollouts', { version: '1.13.0+0', target: { kind: 'fleet' }, wave: 2 })).body;
  world.finish(rollout.canary.job, rollout.canary.things[0], 'SUCCEEDED', '1.13.0+0');
  await world.tick();
  const waves = createJobs(world)[1];
  // Two are offered in the first minute, the third waits for the next.
  const [first, second, third] = waves.things;
  assert.deepEqual(world.fake.jobs.get(waves.jobId).executions.size, 2);
  world.finish(waves.jobId, first, 'FAILED');
  assert.equal(world.fake.execution(waves.jobId, second).get().status, 'CANCELED');
  world.advance(5 * 60_000);
  assert.equal(world.fake.execution(waves.jobId, third).get(), null);

  assert.equal((await world.tick()).stopped, 1);
  const detail = (await world.call('GET', `/api/rollouts/${rollout.id}`)).body.rollout;
  assert.deepEqual([detail.stage, detail.stopped.code], ['stopped', 'aborted']);
  assert.match(detail.stopped.text, /^1 of 1 finished boards failed, which reaches 20%: AWS IoT stopped the rest$/);
  assert.deepEqual(detail.notOffered, [third]);
  // An e-mail alert of the waves' job, not the canary's.
  assert.deepEqual(world.raised.map((alert) => [alert.kind, alert.deployment, alert.text]),
    [['deployment', waves.jobId, `Staged rollout ${rollout.id} of 1.13.0+0: ${detail.stopped.text}`]]);
});

test('a release revoked while its canary works stops the rollout', async () => {
  const world = await fiveBoards();
  const { rollout } = (await world.call('POST', '/api/rollouts', { version: '1.13.0+0', target: { kind: 'fleet' } })).body;
  const revoked = await world.call('POST', `/api/firmware/${encodeURIComponent('1.13.0+0')}/revoke`, { reason: 'Bricks the encoder' });
  assert.equal(revoked.status, 200);
  assert.equal((await world.tick()).stopped, 1);
  const detail = (await world.call('GET', `/api/rollouts/${rollout.id}`)).body.rollout;
  assert.deepEqual([detail.stage, detail.stopped.code], ['stopped', 'revoked']);
  // A person revoked it: no alert of a deployment that stopped by itself.
  assert.deepEqual(world.raised, []);
});

test('two runs of the schedule at once start the waves once', async () => {
  const world = await fiveBoards();
  const { rollout } = (await world.call('POST', '/api/rollouts', { version: '1.13.0+0', target: { kind: 'fleet' } })).body;
  world.finish(rollout.canary.job, rollout.canary.things[0], 'SUCCEEDED', '1.13.0+0');
  const results = await Promise.all([world.tick(), world.tick()]);
  assert.equal(results.reduce((sum, result) => sum + result.advanced, 0), 1);
  assert.equal(createJobs(world).length, 2);
});

test('a rollout is cancelled with its jobs; one cancelled while its waves start loses them too', async () => {
  const world = await fiveBoards();
  const first = (await world.call('POST', '/api/rollouts', { version: '1.13.0+0', target: { kind: 'boards', things: [A, B] } })).body.rollout;
  const cancelled = await world.call('POST', `/api/rollouts/${first.id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.deepEqual([cancelled.body.rollout.stage, cancelled.body.rollout.stopped.code], ['cancelled', 'cancelled']);
  assert.equal(world.fake.jobs.get(first.canary.job).status, 'CANCELED');
  assert.equal(world.entries('rollout.cancel').at(-1).detail.cancelled, '1');
  const again = await world.call('POST', `/api/rollouts/${first.id}/cancel`, {});
  assert.deepEqual([again.status, again.body.error.code], [409, 'already_finished']);
  assert.equal((await world.tick()).checked, 0);

  // The race: the cancellation lands between the start of the waves and the job's id being written.
  const second = (await world.call('POST', '/api/rollouts', { version: '1.13.0+0', target: { kind: 'boards', things: [C, D] } })).body.rollout;
  world.finish(second.canary.job, second.canary.things[0], 'SUCCEEDED', '1.13.0+0');
  const original = world.fake.createJob;
  world.fake.createJob = async (input) => {
    const result = await original(input);
    world.fake.createJob = original;
    assert.equal((await world.call('POST', `/api/rollouts/${second.id}/cancel`, {})).status, 200);
    return result;
  };
  await world.tick();
  const waves = createJobs(world).at(-1);
  assert.equal(world.fake.jobs.get(waves.jobId).status, 'CANCELED');
  assert.equal((await world.call('GET', `/api/rollouts/${second.id}`)).body.rollout.stage, 'cancelled');
});

test('a rollout to a group leaves out its other boards and says why; a viewer reads it and cannot start one', async () => {
  const world = await fiveBoards();
  world.online(C, '1.13.0+0');
  const { group } = (await world.call('POST', '/api/groups', { name: 'Bench', things: [A, C, E] })).body;
  const viewer = await world.call('POST', '/api/rollouts', { version: '1.13.0+0', target: { kind: 'group', group: group.id } }, world.viewer);
  assert.equal(viewer.status, 403);
  const response = await world.call('POST', '/api/rollouts', { version: '1.13.0+0', target: { kind: 'group', group: group.id } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.deepEqual(response.body.rollout.target, { kind: 'group', group: group.id, groupName: 'Bench' });
  assert.deepEqual(response.body.rollout.things, [A]);
  assert.deepEqual(response.body.rollout.leftOut.map((entry) => entry.reason), ['current', 'other_type']);
  const listed = (await world.call('GET', '/api/rollouts', undefined, world.viewer)).body.rollouts;
  assert.deepEqual(listed.map((item) => item.id), [response.body.rollout.id]);
  assert.equal((await world.call('GET', '/api/rollouts/rol-20261010T000000Z-000000')).status, 404);
  assert.equal((await world.call('POST', '/api/rollouts', { version: '1.13.0+0', target: { kind: 'group', group: 'grp-00000000' } })).status, 404);
});

// Update everything.

async function mixedFleet() {
  const world = fleetConsole();
  world.online(A, '1.12.0+0');
  world.online(B, '1.12.0+0');
  world.online(C, '1.13.1+0');
  world.bluetoothOnly(D);
  world.online(E, '1.12.0+0');
  world.advance(OFFLINE_LONG_MS + 60_000);
  for (const thing of [A, B, C]) world.fake.device(thing).report(report(world.fake.device(thing).get().state.reported.fw.version));
  await world.release('1.13.0+0', 'nrf5340dk');
  await world.release('1.13.1+0');
  return world;
}

test('"Update everything" plans, for each type, its newest release and the boards behind, and what is left out', async () => {
  const world = await mixedFleet();
  const { plan } = (await world.call('GET', '/api/fleet/update-everything', undefined, world.viewer)).body;
  const [wifi, bt] = plan.types;
  assert.deepEqual([wifi.type, wifi.release.version, wifi.things], ['nrf7002dk', '1.13.1+0', [A, B]]);
  assert.deepEqual(wifi.leftOut.map((entry) => [entry.thing, entry.reason]), [[C, 'current'], [E, 'offline']]);
  assert.equal(wifi.canary.length, 1);
  assert.deepEqual([bt.type, bt.release.version, bt.things], ['nrf5340dk', '1.13.0+0', []]);
  assert.deepEqual(bt.leftOut.map((entry) => [entry.thing, entry.reason]), [[D, 'bluetooth_only']]);
});

test('"Update everything" starts a staged rollout per type, checked against the plan as it is now', async () => {
  const world = await mixedFleet();
  const start = (types, as) => world.call('POST', '/api/fleet/update-everything', { types, note: 'Everything' }, as);
  const behind = [{ type: 'nrf7002dk', version: '1.13.1+0', things: [A, B] }];

  assert.equal((await start(behind, world.viewer)).status, 403);
  const stale = await start([{ type: 'nrf7002dk', version: '1.13.0+0', things: [A] }]);
  assert.deepEqual([stale.status, stale.body.error.code], [409, 'plan_changed']);
  const left = await start([{ type: 'nrf7002dk', version: '1.13.1+0', things: [A, E] }]);
  assert.deepEqual([left.status, left.body.error.code, left.body.error.details[0].reason], [409, 'plan_changed', 'offline']);
  const other = await start([{ type: 'nrf7002dk', version: '1.13.1+0', things: [A, D] }]);
  assert.deepEqual([other.status, other.body.error.code], [400, 'incompatible_board']);
  const away = await start([{ type: 'nrf5340dk', version: '1.13.0+0', things: [D] }]);
  assert.deepEqual([away.status, away.body.error.details[0].reason], [409, 'bluetooth_only']);
  for (const types of [[], 'all', [{ type: 'esp32', version: '1.0.0+0', things: [A] }], [...behind, ...behind]]) {
    assert.equal((await start(types)).status, 400, JSON.stringify(types));
  }
  assert.equal(world.fake.fleetItems.size, 0);

  const started = await start(behind);
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const [rollout] = started.body.rollouts;
  assert.deepEqual([rollout.purpose, rollout.version, rollout.things, rollout.target], ['update_everything', '1.13.1+0', [A, B], { kind: 'type', type: 'nrf7002dk' }]);
  const entry = world.entries('fleet.update_everything').at(-1);
  assert.deepEqual([entry.outcome, entry.target, entry.detail.rollouts, entry.detail.versions, entry.detail.things],
    ['ok', 'fleet', rollout.id, 'nrf7002dk 1.13.1+0', '2']);
});

// Rolling a group back.

test('a rollback plans the release before the newest for each type in the group, and boards on something newer would refuse it', async () => {
  const world = fleetConsole();
  world.online(A, '1.13.1+0');
  world.online(B, '1.13.0+0');
  world.online(C, '1.12.0+0');
  await world.release('1.12.0+0');
  await world.release('1.13.0+0');
  await world.release('1.13.1+0');
  const { group } = (await world.call('POST', '/api/groups', { name: 'Bench', things: [A, B, C] })).body;
  const { plan } = (await world.call('GET', `/api/groups/${group.id}/rollback`)).body;
  assert.deepEqual(plan.group, { id: group.id, name: 'Bench' });
  const [wifi] = plan.types;
  assert.deepEqual([wifi.from, wifi.release.version, wifi.things], ['1.13.1+0', '1.13.0+0', [C]]);
  assert.deepEqual(wifi.leftOut.map((entry) => [entry.thing, entry.reason]), [[A, 'older_refused'], [B, 'current']]);
  assert.match(wifi.leftOut[0].text, /a board takes only firmware newer than what it runs, so it would refuse 1\.13\.0\+0/);

  const started = await world.call('POST', `/api/groups/${group.id}/rollback`, { types: [{ type: 'nrf7002dk', version: '1.13.0+0', things: [C] }] });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.deepEqual([started.body.rollouts[0].purpose, started.body.rollouts[0].target.groupName], ['rollback', 'Bench']);
  const entry = world.entries('group.rollback').at(-1);
  assert.deepEqual([entry.outcome, entry.target, entry.detail.group], ['ok', group.id, 'Bench']);
});

test('a group with no older active release of its type has nothing to roll back to', async () => {
  const world = fleetConsole();
  world.online(A, '1.13.1+0');
  await world.release('1.13.1+0');
  const { group } = (await world.call('POST', '/api/groups', { name: 'Bench', things: [A] })).body;
  const { plan } = (await world.call('GET', `/api/groups/${group.id}/rollback`)).body;
  assert.equal(plan.types[0].release, null);
  assert.equal(plan.types[0].leftOut[0].reason, 'no_older');
  const response = await world.call('POST', `/api/groups/${group.id}/rollback`, { types: [{ type: 'nrf7002dk', version: '1.13.1+0', things: [A] }] });
  assert.deepEqual([response.status, response.body.error.code], [409, 'no_older_release']);
  assert.equal((await world.call('GET', '/api/groups/grp-00000000/rollback')).status, 404);
});
