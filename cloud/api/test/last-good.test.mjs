// Tests for "Roll back to last good" (lib/last-good.mjs, handlers/rollouts.mjs): each board's last good
// version from a fake update history, the release that takes it there (a rebuild under a newer number),
// the boards grouped by that release, the ones left out and why, the preview, and the staged launch
// with the health gate on.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OFFLINE_LONG_MS } from '../src/lib/fleet.mjs';
import { lastGoodVersion, planLastGood, rebuildOf, releaseFor } from '../src/lib/last-good.mjs';
import { A, B, C, D, E, fleetConsole } from './fleet-world.mjs';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const HOUR = 3_600_000;
const kept = (from, to, hoursAgo) => ({
  from,
  to,
  outcome: 'kept',
  startedAt: NOW - hoursAgo * HOUR,
  endedAt: NOW - hoursAgo * HOUR + 60_000,
});
const rolledBack = (from, to, hoursAgo) => ({ ...kept(from, to, hoursAgo), outcome: 'rolled_back' });
const board = (thing, version, changes = {}) => ({
  thing,
  type: 'nrf7002dk',
  layout: 1,
  bluetoothOnly: false,
  online: true,
  lastSeen: new Date(NOW).toISOString(),
  version,
  ...changes,
});
const release = (version, changes = {}) => ({
  version,
  board: 'nrf7002dk',
  layout: 1,
  status: 'active',
  notes: '',
  ...changes,
});

// The rules, without AWS.

test("a board's last good version is the newest it ran confirmed before the one it runs", () => {
  // Updated twice, both kept: the one before the current.
  assert.deepEqual(
    lastGoodVersion({
      current: '1.13.1+0',
      records: [kept('1.13.0+0', '1.13.1+0', 2), kept('1.12.0+0', '1.13.0+0', 30)],
    }),
    { version: '1.13.0+0', at: NOW - 2 * HOUR, how: 'ran_before' }
  );
  // The newest update rolled back: the board runs what it came from, and the one before that is good.
  assert.equal(
    lastGoodVersion({
      current: '1.13.1+0',
      records: [
        rolledBack('1.13.1+0', '1.13.2+0', 1),
        kept('1.13.0+0', '1.13.1+0', 5),
        kept('1.12.0+0', '1.13.0+0', 30),
      ],
    }).version,
    '1.13.0+0'
  );
  // A version that never confirmed is never good, even if it is the newest the board was sent.
  assert.equal(
    lastGoodVersion({
      current: '1.13.3+0',
      records: [
        kept('1.13.1+0', '1.13.3+0', 1),
        rolledBack('1.13.1+0', '1.13.2+0', 3),
        kept('1.13.0+0', '1.13.1+0', 9),
      ],
    }).version,
    '1.13.1+0'
  );
  // One update in its history: the version it started from.
  assert.deepEqual(lastGoodVersion({ current: '1.13.1+0', records: [kept('1.12.0+0', '1.13.1+0', 4)] }), {
    version: '1.12.0+0',
    at: NOW - 4 * HOUR,
    how: 'ran_before',
  });
  // No history, only the version it runs, or no version at all: none.
  assert.equal(lastGoodVersion({ current: '1.13.1+0', records: [] }), null);
  assert.equal(lastGoodVersion({ current: '1.13.1+0', records: [kept('1.13.1+0', '1.13.1+0', 4)] }), null);
  assert.equal(lastGoodVersion({ current: null, records: [kept('1.12.0+0', '1.13.0+0', 4)] }), null);
});

test('a release says it rebuilds an older version where its note begins', () => {
  assert.equal(rebuildOf('Rebuild of 1.13.0'), '1.13.0');
  assert.equal(rebuildOf('rebuild of v1.13.0+0. Back to the old Wi-Fi code.'), '1.13.0+0');
  assert.equal(rebuildOf('Not a rebuild of 1.13.0'), null);
  assert.equal(rebuildOf('Rebuild of 1.13.0.1'), null);
  assert.equal(rebuildOf('Rebuild of 999.0.0'), null);
  assert.equal(rebuildOf(''), null);
  assert.equal(rebuildOf(null), null);
});

test('the release that takes a board back: the old one if newer, else the newest rebuild of it the board would take', () => {
  const releases = [
    release('1.13.0+0'),
    release('1.13.1+0'),
    release('1.13.2+0', { notes: 'Rebuild of 1.13.0' }),
    release('1.13.4+0', { notes: 'Rebuild of 1.13.0+0' }),
    release('1.13.5+0', { notes: 'Rebuild of 1.13.0', status: 'revoked' }),
  ];
  const on = (version, changes) => board(A, version, changes);
  assert.equal(releaseFor({ board: on('1.13.1+0'), good: '1.13.0+0', releases }).release.version, '1.13.4+0');
  // A board already past every rebuild has none it would take.
  assert.equal(releaseFor({ board: on('1.13.4+0'), good: '1.13.0+0', releases }).reason, 'no_rebuild');
  // A board taken back by hand to something older than its last good gets that one itself.
  assert.equal(releaseFor({ board: on('1.12.0+0'), good: '1.13.1+0', releases }).release.version, '1.13.1+0');
  // A revoked last good is not gone back to, rebuilt or not.
  const revoked = [release('1.13.0+0', { status: 'revoked' }), release('1.13.2+0', { notes: 'Rebuild of 1.13.0' })];
  assert.equal(releaseFor({ board: on('1.13.1+0'), good: '1.13.0+0', releases: revoked }).reason, 'good_revoked');
  // Of its own type where there is one.
  const typed = [
    release('1.13.2+0', { notes: 'Rebuild of 1.13.0', board: 'nrf5340dk' }),
    release('1.13.3+0', { notes: 'Rebuild of 1.13.0' }),
    release('1.13.6+0', { notes: 'Rebuild of 1.13.0', board: 'nrf5340dk' }),
  ];
  assert.equal(releaseFor({ board: on('1.13.1+0'), good: '1.13.0+0', releases: typed }).release.version, '1.13.3+0');
});

test('the plan groups the boards by the release that takes them back, and says why the others are left out', () => {
  const releases = [
    release('1.12.0+0'),
    release('1.13.0+0'),
    release('1.13.1+0'),
    release('1.13.2+0', { notes: 'Rebuild of 1.13.0' }),
    release('1.13.3+0', { notes: 'Rebuild of 1.12.0' }),
    release('1.11.0+0', { status: 'revoked' }),
    release('1.13.4+0', { notes: 'Rebuild of 1.10.0', board: 'nrf5340dk' }),
  ];
  const F = 'cranium-00000000000000ff';
  const G = 'cranium-0000000000000011';
  const H = 'cranium-0000000000000022';
  const I = 'cranium-0000000000000033';
  const J = 'cranium-0000000000000044';
  const boards = [
    board(A, '1.13.1+0'),
    board(B, '1.13.1+0'),
    board(C, '1.13.1+0'),
    board(D, '1.13.1+0'),
    board(E, '1.13.1+0', { online: false, lastSeen: new Date(NOW - OFFLINE_LONG_MS - 1).toISOString() }),
    board(F, '1.13.1+0'),
    board(G, '1.13.1+0'),
    board(H, '1.13.1+0'),
    board(I, null, { type: 'nrf5340dk', bluetoothOnly: true }),
    board(J, '1.13.1+0'),
  ];
  const histories = new Map([
    [A, [kept('1.13.0+0', '1.13.1+0', 3)]],
    [B, [kept('1.12.0+0', '1.13.1+0', 3)]],
    [C, [kept('1.13.0+0', '1.13.1+0', 3)]],
    [D, []],
    [E, [kept('1.13.0+0', '1.13.1+0', 3)]],
    [F, [kept('1.11.0+0', '1.13.1+0', 3)]],
    [G, [kept('1.10.0+0', '1.13.1+0', 3)]],
    [H, [kept('1.9.0+0', '1.13.1+0', 3)]],
    // J's history could not be read: no entry.
  ]);
  const busy = new Map([[C, 'cranium-1-13-1-b0-20261109T110000Z-aaaa']]);
  const plan = planLastGood({ boards, histories, releases, busy, nowMs: NOW });

  assert.deepEqual(
    plan.targets.map((target) => [target.release.version, target.rebuildOf, target.things]),
    [
      ['1.13.4+0', '1.10.0', []],
      ['1.13.3+0', '1.12.0', [B]],
      ['1.13.2+0', '1.13.0', [A]],
    ]
  );
  const back = plan.targets.find((target) => target.release.version === '1.13.2+0');
  assert.deepEqual(back.boards, [
    { thing: A, from: '1.13.1+0', to: '1.13.0+0', how: 'ran_before' },
    { thing: C, from: '1.13.1+0', to: '1.13.0+0', how: 'ran_before' },
    { thing: E, from: '1.13.1+0', to: '1.13.0+0', how: 'ran_before' },
  ]);
  assert.deepEqual(
    back.leftOut.map((entry) => [entry.thing, entry.reason, entry.from, entry.to]),
    [
      [C, 'busy', '1.13.1+0', '1.13.0+0'],
      [E, 'offline', '1.13.1+0', '1.13.0+0'],
    ]
  );
  // A rebuild only for another type of board.
  assert.deepEqual(
    plan.targets[0].leftOut.map((entry) => [entry.thing, entry.reason]),
    [[G, 'other_type']]
  );
  assert.deepEqual(
    plan.leftOut.map((entry) => [entry.thing, entry.reason]),
    [
      [H, 'no_rebuild'],
      [I, 'bluetooth_only'],
      [J, 'unreadable'],
      [D, 'no_good'],
      [F, 'good_revoked'],
    ]
  );
  assert.match(
    plan.leftOut[0].text,
    /Its last good version is 1\.9\.0\+0, older than 1\.13\.1\+0.*"Rebuild of 1\.9\.0\+0"/
  );
  assert.equal(plan.leftOut[0].to, '1.9.0+0');
});

// Through the API, on the fake.

/** A version change of a board, as the recorder writes it into its update history. */
async function history(world, thing, from, to, hoursAgo) {
  const at = world.clock.ms - hoursAgo * HOUR;
  const iso = new Date(at).toISOString();
  await world.fake.putUpdateFact({
    pk: `UPD#${thing}`,
    sk: `V#${iso}`,
    fact: 'version',
    at,
    from,
    to,
    confirmed: true,
  });
}

async function rebuilt(world, version, of) {
  await world.release(version);
  const response = await world.call('PUT', `/api/firmware/${encodeURIComponent(version)}/notes`, {
    notes: `Rebuild of ${of}: the old source under a newer number.`,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

async function bench() {
  const world = fleetConsole();
  for (const version of ['1.12.0+0', '1.13.0+0', '1.13.1+0']) await world.release(version);
  await rebuilt(world, '1.13.2+0', '1.13.0');
  await rebuilt(world, '1.13.3+0', '1.12.0');
  world.online(A, '1.13.1+0');
  world.online(B, '1.13.1+0');
  world.online(C, '1.13.1+0');
  world.online(D, '1.13.1+0');
  await history(world, A, '1.13.0+0', '1.13.1+0', 3);
  await history(world, B, '1.12.0+0', '1.13.1+0', 3);
  await history(world, D, '1.13.0+0', '1.13.1+0', 3);
  // C has no history: nothing known to be good.
  const { group } = (await world.call('POST', '/api/groups', { name: 'Bench', things: [A, B, C] })).body;
  return { world, group };
}

test('the preview of a group: per board from and to, one target per release, and what is left out', async () => {
  const { world, group } = await bench();
  const response = await world.call('GET', `/api/groups/${group.id}/last-good`, undefined, world.viewer);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const { plan } = response.body;
  assert.deepEqual(plan.scope, { kind: 'group', id: group.id, name: 'Bench' });
  assert.deepEqual(plan.healthGate, { on: true, minutes: 10 });
  assert.deepEqual(
    plan.targets.map((target) => [target.release.version, target.release.rebuildOf, target.boards, target.canary]),
    [
      ['1.13.3+0', '1.12.0', [{ thing: B, from: '1.13.1+0', to: '1.12.0+0', how: 'ran_before' }], [B]],
      ['1.13.2+0', '1.13.0', [{ thing: A, from: '1.13.1+0', to: '1.13.0+0', how: 'ran_before' }], [A]],
    ]
  );
  assert.deepEqual(
    plan.leftOut.map((entry) => [entry.thing, entry.reason]),
    [[C, 'no_good']]
  );
  // The fleet's has D too, which is in no group.
  const fleetPlan = (await world.call('GET', '/api/fleet/last-good')).body.plan;
  assert.deepEqual(fleetPlan.scope, { kind: 'fleet' });
  assert.deepEqual(fleetPlan.targets.find((target) => target.release.version === '1.13.2+0').things, [A, D]);
  assert.equal((await world.call('GET', '/api/groups/grp-00000000/last-good')).status, 404);
});

test('one click starts one staged rollout per release, each with the health gate on, and goes on record', async () => {
  const { world, group } = await bench();
  const { plan } = (await world.call('GET', `/api/groups/${group.id}/last-good`)).body;
  const targets = plan.targets.map((target) => ({ version: target.release.version, things: target.things }));
  const started = await world.call('POST', `/api/groups/${group.id}/last-good`, { targets });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { rollouts } = started.body;
  assert.deepEqual(
    rollouts.map((rollout) => [rollout.purpose, rollout.version, rollout.things, rollout.target, rollout.healthGate]),
    [
      [
        'last_good',
        '1.13.3+0',
        [B],
        { kind: 'group', group: group.id, groupName: 'Bench', type: 'nrf7002dk' },
        { minutes: 10 },
      ],
      [
        'last_good',
        '1.13.2+0',
        [A],
        { kind: 'group', group: group.id, groupName: 'Bench', type: 'nrf7002dk' },
        { minutes: 10 },
      ],
    ]
  );
  // Each starts with its canary, as a job of the rebuild.
  const jobs = world.fake.calls.filter((call) => call.method === 'createJob').map((call) => call.args[0]);
  assert.equal(jobs.length, 2);
  assert.deepEqual(
    rollouts.map((rollout) => rollout.canary.things),
    [[B], [A]]
  );
  const entry = world.entries('fleet.rollback_last_good').at(-1);
  assert.deepEqual(
    [entry.outcome, entry.target, entry.detail.group, entry.detail.versions, entry.detail.things],
    ['ok', group.id, 'Bench', '1.13.3+0, 1.13.2+0', '2']
  );
  assert.deepEqual(
    entry.changes.map((change) => change.field),
    ['rollout', 'rollout', 'plan']
  );
  assert.match(entry.changes.at(-1).to, /gate 10 min/);
});

test('the health gate cannot be turned off, the plan is checked again, and the fleet has its own', async () => {
  const { world, group } = await bench();
  const path = `/api/groups/${group.id}/last-good`;
  const off = await world.call('POST', path, {
    targets: [{ version: '1.13.2+0', things: [A] }],
    healthGate: { on: false },
  });
  assert.deepEqual([off.status, off.body.error.code], [400, 'gate_required']);
  const none = await world.call('POST', path, { targets: [{ version: '1.13.2+0', things: [A] }], healthGate: null });
  assert.deepEqual([none.status, none.body.error.code], [400, 'gate_required']);
  for (const targets of [
    [],
    'all',
    [
      { version: '1.13.2+0', things: [A] },
      { version: '1.13.2+0', things: [B] },
    ],
  ]) {
    assert.equal(
      (await world.call('POST', path, { targets })).body.error.code,
      'invalid_targets',
      JSON.stringify(targets)
    );
  }
  // A board the release would not take back, and a release that takes nobody back.
  const outside = await world.call('POST', path, { targets: [{ version: '1.13.2+0', things: [B] }] });
  assert.deepEqual([outside.status, outside.body.error.code], [409, 'plan_changed']);
  const nobody = await world.call('POST', path, { targets: [{ version: '1.13.1+0', things: [A] }] });
  assert.deepEqual([nobody.status, nobody.body.error.code], [409, 'plan_changed']);
  assert.equal(world.fake.calls.filter((call) => call.method === 'createJob').length, 0);
  // A gate asked for longer is kept.
  const longer = await world.call('POST', '/api/fleet/last-good', {
    targets: [{ version: '1.13.2+0', things: [A, D] }],
    healthGate: { on: true, minutes: 30 },
    stages: 1,
  });
  assert.equal(longer.status, 201, JSON.stringify(longer.body));
  const [rollout] = longer.body.rollouts;
  assert.deepEqual([rollout.target, rollout.healthGate], [{ kind: 'fleet', type: 'nrf7002dk' }, { minutes: 30 }]);
  assert.equal(world.entries('fleet.rollback_last_good').at(-1).target, 'fleet');
});

test('after the canary of a roll back confirms, the next stage waits for the health gate', async () => {
  const { world } = await bench();
  const started = await world.call('POST', '/api/fleet/last-good', {
    targets: [{ version: '1.13.2+0', things: [A, D] }],
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const [rollout] = started.body.rollouts;
  const [canary] = rollout.canary.things;
  world.finish(rollout.canary.job, canary, 'SUCCEEDED', '1.13.2+0');
  await world.tick();
  const after = (await world.call('GET', `/api/rollouts/${rollout.id}`)).body.rollout;
  // Confirmed, and held: the stage has not started while the gate's minutes run.
  assert.equal(after.stopped, null);
  assert.equal(after.stages[0].job, null);
  assert.equal(world.fake.calls.filter((call) => call.method === 'createJob').length, 1);
});
