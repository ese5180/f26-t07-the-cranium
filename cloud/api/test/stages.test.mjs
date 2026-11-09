// Tests for the stages of a staged rollout (lib/stages.mjs): how the boards after the canary are
// split, what a request may choose, and what the console suggests (GET /api/rollouts/suggest).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assignStages, requireStagePlan, stageSizes, suggestPlan } from '../src/lib/stages.mjs';
import { A, B, C, D, fleetConsole } from './fleet-world.mjs';

const HEX = '0123456789abcdef';
const thingAt = (index) =>
  `cranium-0000000000000${HEX[Math.floor(index / 256) % 16]}${HEX[Math.floor(index / 16) % 16]}${HEX[index % 16]}`;
const things = (count, from = 0) => Array.from({ length: count }, (_, index) => thingAt(from + index));
const reader = (body) => (name) => (Object.hasOwn(body, name) ? body[name] : undefined);

test('the boards after the canary are split evenly, by percent or by count; empty stages are left out', () => {
  assert.deepEqual(stageSizes(9, { stages: 3, batch: null }), [3, 3, 3]);
  assert.deepEqual(stageSizes(10, { stages: 3, batch: null }), [3, 3, 4]);
  assert.deepEqual(stageSizes(2, { stages: 5, batch: null }), [1, 1]);
  assert.deepEqual(stageSizes(9, { stages: 1, batch: null }), [9]);
  assert.deepEqual(stageSizes(0, { stages: 3, batch: null }), []);
  assert.deepEqual(stageSizes(9, { stages: 3, batch: { unit: 'percent', sizes: [10, 30] } }), [1, 3, 5]);
  assert.deepEqual(stageSizes(100, { stages: 3, batch: { unit: 'percent', sizes: [10, 30] } }), [10, 30, 60]);
  assert.deepEqual(stageSizes(10, { stages: 4, batch: { unit: 'count', sizes: [2, 2, 2] } }), [2, 2, 2, 4]);
  assert.deepEqual(stageSizes(3, { stages: 3, batch: { unit: 'count', sizes: [2, 2] } }), [2, 1]);
  assert.deepEqual(stageSizes(4, { stages: 2, batch: { unit: 'percent', sizes: [100] } }), [4]);
});

test('the boards that are away go last, the ones online first, each stage sorted', () => {
  const boards = [
    { thing: A, online: false, lastSeen: null },
    { thing: B, online: true, lastSeen: '2026-11-09T10:00:00Z' },
    { thing: C, online: true, lastSeen: '2026-11-09T11:00:00Z' },
    { thing: D, online: false, lastSeen: '2026-11-08T11:00:00Z' },
  ];
  assert.deepEqual(assignStages([A, B, C, D], boards, [1, 3]), [[C], [A, B, D]]);
  assert.deepEqual(assignStages([A, B, C, D], boards, [2, 1, 1]), [[B, C], [D], [A]]);
});

test('a request chooses 1 to 10 stages, a batch in percent or count, and 0 to 60 minutes of soak', () => {
  assert.deepEqual(requireStagePlan(reader({})), { stages: 1, batch: null, soakMinutes: 0 });
  assert.deepEqual(requireStagePlan(reader({ stages: 3, batch: { unit: 'percent', sizes: [10] }, soakMinutes: 60 })), {
    stages: 3,
    batch: { unit: 'percent', sizes: [10, 10] },
    soakMinutes: 60,
  });
  assert.deepEqual(requireStagePlan(reader({ stages: 3, batch: { unit: 'count', sizes: [2, 5] } })).batch, {
    unit: 'count',
    sizes: [2, 5],
  });
  assert.deepEqual(requireStagePlan(reader({ stages: 1, batch: { unit: 'count', sizes: [] } })).batch, null);
  assert.deepEqual(requireStagePlan(reader({ stages: 2, batch: null })).batch, null);
  for (const [body, code] of [
    [{ stages: 0 }, 'invalid_stages'],
    [{ stages: '3' }, 'invalid_stages'],
    [{ soakMinutes: 90 }, 'invalid_soakMinutes'],
    [{ stages: 2, batch: [10] }, 'invalid_batch'],
    [{ stages: 2, batch: { unit: 'percent' } }, 'invalid_batch'],
    [{ stages: 2, batch: { unit: 'count', sizes: [101] } }, 'invalid_batch'],
    [{ stages: 3, batch: { unit: 'percent', sizes: [50, 51] } }, 'invalid_batch'],
  ]) {
    assert.throws(() => requireStagePlan(reader(body)), { code }, JSON.stringify(body));
  }
});

test('one board: the canary is all of it, and there is no stage', () => {
  const plan = suggestPlan({ boards: things(1), online: things(1), types: {}, history: {} });
  assert.deepEqual(plan.canary, things(1));
  assert.deepEqual([plan.stageCount, plan.stages, plan.batch, plan.soakMinutes], [0, [], null, 0]);
  assert.match(plan.reasons.stages, /no stage after it/);
  assert.match(plan.reasons.canary, /^One board, online, with a clean update history/);
  assert.deepEqual(plan.warnings, []);
});

test('three boards: a canary and one stage of the other two, at once', () => {
  const plan = suggestPlan({ boards: things(3), online: things(3) });
  assert.equal(plan.canary.length, 1);
  assert.deepEqual(
    plan.stages.map((stage) => stage.size),
    [2]
  );
  assert.equal(plan.batch, null);
  assert.match(plan.reasons.stages, /^A group of 3 boards: one stage after the canary, all at once/);
  assert.deepEqual(plan.warnings, []);
});

test('ten boards: a canary, then a small stage and the rest, with no soak time', () => {
  const plan = suggestPlan({ boards: things(10), online: things(10) });
  assert.deepEqual(
    plan.stages.map((stage) => [stage.size, stage.percent]),
    [
      [2, 22],
      [7, 78],
    ]
  );
  assert.deepEqual(plan.batch, { unit: 'count', sizes: [2] });
  assert.equal(plan.soakMinutes, 0);
  assert.match(plan.reasons.stages, /^2 stages that grow \(22% → 78%\)/);
  assert.equal(plan.reasons.batch, '2 boards, and the last stage takes the rest.');
  assert.deepEqual(plan.stages.flatMap((stage) => stage.things).length, 9);
});

test('a hundred boards: stages that grow 10% → 30% → the rest, and a soak time between them', () => {
  const plan = suggestPlan({ boards: things(100), online: things(100) });
  assert.deepEqual(
    plan.stages.map((stage) => stage.size),
    [10, 30, 59]
  );
  assert.deepEqual(
    plan.stages.map((stage) => stage.percent),
    [10, 30, 60]
  );
  assert.deepEqual([plan.stageCount, plan.soakMinutes], [3, 10]);
  assert.deepEqual(plan.batch, { unit: 'count', sizes: [10, 30] });
  assert.match(plan.reasons.soak, /^10 minutes: a large group/);
  assert.deepEqual(plan.warnings, []);
  // Every board is in exactly one place.
  const placed = [...plan.canary, ...plan.stages.flatMap((stage) => stage.things)].sort();
  assert.deepEqual(placed, things(100));
});

test('mixed types: one canary of each, online, with the cleanest update history', () => {
  const nrf = things(4);
  const other = things(3, 16);
  const types = Object.fromEntries([
    ...nrf.map((thing) => [thing, 'nrf7002dk']),
    ...other.map((thing) => [thing, 'nrf5340dk']),
  ]);
  const history = new Map([
    [nrf[0], { updates: 6, failures: 2 }],
    [nrf[1], { updates: 4, failures: 0 }],
    [nrf[2], { updates: 9, failures: 0 }],
    [other[0], { updates: 1, failures: 1 }],
  ]);
  const plan = suggestPlan({
    boards: [...nrf, ...other],
    online: [...nrf.slice(0, 3), other[0], other[2]],
    types,
    history,
  });
  // nrf[2]: clean and the most updates; other[2]: online and clean, other[1] is offline.
  assert.deepEqual(plan.canary, [nrf[2], other[2]].sort());
  assert.match(plan.reasons.canary, /^One board of each of the 2 board types, online, with a clean update history/);
  assert.deepEqual(plan.stages.flatMap((stage) => stage.things).length, 5);
});

test('offline boards go in the last stage, with a note; most of the group away is a warning', () => {
  const all = things(10);
  const online = all.slice(0, 4);
  const plan = suggestPlan({ boards: all, online });
  assert.ok(online.includes(plan.canary[0]));
  const last = plan.stages.at(-1);
  for (const thing of all.slice(4)) assert.ok(last.things.includes(thing), `${thing} in the last stage`);
  assert.equal(last.offline, 6);
  assert.equal(plan.reasons.offline, '6 boards are offline: they are in the last stage, and take it when back.');
  assert.ok(plan.warnings.some((line) => /^Most of the group is offline \(6 of 10\)/.test(line)));

  // More away than the last stage would hold: the stages merge until it holds them.
  const fewOnline = suggestPlan({ boards: all, online: all.slice(0, 2) });
  assert.deepEqual(
    fewOnline.stages.map((stage) => [stage.size, stage.offline]),
    [[9, 8]]
  );
  // None online: the canary waits, and says so.
  const none = suggestPlan({ boards: all, online: [] });
  assert.equal(none.canary.length, 1);
  assert.ok(none.warnings.some((line) => /^No board of type unknown is online/.test(line)));
});

test('GET /api/rollouts/suggest: for a group or the fleet, for viewers too; it starts nothing', async () => {
  const world = fleetConsole();
  for (const thing of [A, B, C, D]) world.online(thing, '1.12.0+0');
  await world.release('1.13.0+0');
  const { group } = (await world.call('POST', '/api/groups', { name: 'Bench', things: [A, B, C] })).body;
  const ask = (query, as = world.viewer) => world.call('GET', `/api/rollouts/suggest?${query}`, undefined, as);

  const response = await ask(`release=${encodeURIComponent('1.13.0+0')}&group=${group.id}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const { suggestion } = response.body;
  assert.deepEqual(suggestion.group, { id: group.id, name: 'Bench' });
  assert.deepEqual(suggestion.things, [A, B, C]);
  assert.deepEqual([suggestion.canary.length, suggestion.canarySize, suggestion.stageCount], [1, 1, 1]);
  assert.equal(suggestion.stages[0].size, 2);
  assert.equal(suggestion.abortPercent, 20);
  assert.equal(typeof suggestion.reasons.stages, 'string');

  const fleet = (await ask(`release=${encodeURIComponent('1.13.0+0')}`, world.manager)).body.suggestion;
  assert.deepEqual([fleet.group, fleet.things], [null, [A, B, C, D]]);

  for (const [query, status, code] of [
    ['group=' + group.id, 400, 'invalid_version'],
    [`release=${encodeURIComponent('9.9.9+0')}`, 404, 'unknown_version'],
    [`release=${encodeURIComponent('1.13.0+0')}&group=grp-00000000`, 404, 'unknown_group'],
    [`release=${encodeURIComponent('1.13.0+0')}&group=nope`, 400, 'invalid_group'],
  ]) {
    const failed = await ask(query);
    assert.deepEqual([failed.status, failed.body.error?.code], [status, code], query);
  }
  assert.equal([...world.fake.fleetItems.keys()].filter((key) => key.startsWith('ROL ')).length, 0);
  assert.equal(world.fake.calls.filter((call) => call.method === 'createJob').length, 0);
});
