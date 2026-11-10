// Tests for scheduled starts and maintenance windows (console 2.19.0: lib/schedule.mjs, handlers/schedules.mjs,
// the window in handlers/groups.mjs and rollouts.mjs): local times in time zones across the changes to and
// from summer time, windows, a schedule that starts once when due (never early, not twice under two runs at
// once), editing and cancelling, waiting for a group's window, what goes on record, and who may do what.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { insideWindow, requireWindow, scheduleId, windowWords, zonedToUtc } from '../src/lib/schedule.mjs';
import { createRolloutTick } from '../src/tick.mjs';
import { A, B, C, D, fleetConsole } from './fleet-world.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms) => new Date(ms).toISOString();
const createJobs = (world) =>
  world.fake.calls.filter((call) => call.method === 'createJob').map((call) => call.args[0]);
const WEEKDAYS_NY = { days: [1, 2, 3, 4, 5], start: '01:00', end: '05:00', timeZone: 'America/New_York' };

// The rules, without AWS.

test('a local time in a time zone is one instant, across the changes to and from summer time', () => {
  assert.equal(iso(zonedToUtc('2026-11-10T02:00', 'America/New_York')), '2026-11-10T07:00:00.000Z');
  assert.equal(iso(zonedToUtc('2026-07-10T02:00', 'America/New_York')), '2026-07-10T06:00:00.000Z');
  assert.equal(iso(zonedToUtc('2026-11-10T02:00', 'UTC')), '2026-11-10T02:00:00.000Z');
  assert.equal(iso(zonedToUtc('2026-11-10T02:00', 'Asia/Kolkata')), '2026-11-09T20:30:00.000Z');
  // Skipped when the clocks go forward: the same time after the change.
  assert.equal(iso(zonedToUtc('2026-03-08T02:30', 'America/New_York')), '2026-03-08T07:30:00.000Z');
  assert.equal(iso(zonedToUtc('2026-03-29T02:30', 'Europe/Berlin')), '2026-03-29T01:30:00.000Z');
  // Twice when they go back: the first of the two.
  assert.equal(iso(zonedToUtc('2026-11-01T01:30', 'America/New_York')), '2026-11-01T05:30:00.000Z');
  assert.equal(iso(zonedToUtc('2026-10-25T02:30', 'Europe/Berlin')), '2026-10-25T00:30:00.000Z');
  // Not a date and time.
  for (const local of ['2026-02-30T01:00', '2026-11-10 02:00', '2026-11-10T24:00', '2026-11-10T02:00:00', null]) {
    assert.equal(zonedToUtc(local, 'UTC'), null, String(local));
  }
});

test('a window is inside on its days and hours in its own time zone, over midnight and across summer time', () => {
  const window = requireWindow(WEEKDAYS_NY);
  // Monday 2026-11-09: 01:00 to 05:00 in New York is 06:00 to 10:00 UTC (standard time).
  assert.equal(insideWindow(window, Date.parse('2026-11-09T05:59Z')), false);
  assert.equal(insideWindow(window, Date.parse('2026-11-09T06:00Z')), true);
  assert.equal(insideWindow(window, Date.parse('2026-11-09T09:59Z')), true);
  assert.equal(insideWindow(window, Date.parse('2026-11-09T10:00Z')), false);
  // In summer time the same hours are an hour earlier in UTC.
  assert.equal(insideWindow(window, Date.parse('2026-07-06T05:30Z')), true);
  assert.equal(insideWindow(window, Date.parse('2026-07-06T09:30Z')), false);
  // Not on a Sunday, though it is 02:00 there; and Monday 02:00 in New York is Monday 07:00 UTC.
  assert.equal(insideWindow(window, Date.parse('2026-11-08T07:00Z')), false);
  // On the morning the clocks go forward (a Sunday in the US, so a window of every day): 01:30 is in, 03:30 is
  // in, and 05:30 summer time (09:30 UTC, which was in on a standard day) is out.
  const daily = requireWindow({ ...WEEKDAYS_NY, days: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(insideWindow(daily, Date.parse('2026-03-08T06:30Z')), true);
  assert.equal(insideWindow(daily, Date.parse('2026-03-08T07:30Z')), true);
  assert.equal(insideWindow(daily, Date.parse('2026-03-08T09:30Z')), false);
  // And the morning they go back: 01:30 happens twice, both in; 05:30 standard time (10:30 UTC) is out.
  assert.equal(insideWindow(daily, Date.parse('2026-11-01T05:30Z')), true);
  assert.equal(insideWindow(daily, Date.parse('2026-11-01T06:30Z')), true);
  assert.equal(insideWindow(daily, Date.parse('2026-11-01T10:30Z')), false);
  // Over midnight: Friday 22:00 to Saturday 02:00 belongs to Friday, in Tokyo.
  const night = requireWindow({ days: [5], start: '22:00', end: '02:00', timeZone: 'Asia/Tokyo' });
  assert.equal(insideWindow(night, Date.parse('2026-11-13T13:30Z')), true); // Friday 22:30
  assert.equal(insideWindow(night, Date.parse('2026-11-13T16:30Z')), true); // Saturday 01:30
  assert.equal(insideWindow(night, Date.parse('2026-11-13T17:30Z')), false); // Saturday 02:30
  assert.equal(insideWindow(night, Date.parse('2026-11-12T16:30Z')), false); // Friday 01:30
  // None: always inside.
  assert.equal(insideWindow(null, Date.parse('2026-11-08T07:00Z')), true);
  assert.equal(windowWords(window), 'weekdays 01:00–05:00 America/New_York');
  assert.equal(windowWords(night), 'Fri 22:00–02:00 Asia/Tokyo');
});

test('a window is checked: days, hours and a time zone that exists', () => {
  for (const bad of [
    {},
    [],
    { ...WEEKDAYS_NY, days: [] },
    { ...WEEKDAYS_NY, days: [1, 1] },
    { ...WEEKDAYS_NY, days: [7] },
    { ...WEEKDAYS_NY, start: '1:00' },
    { ...WEEKDAYS_NY, end: '24:00' },
    { ...WEEKDAYS_NY, end: '01:00' },
    { ...WEEKDAYS_NY, timeZone: 'Mars/Olympus_Mons' },
    { ...WEEKDAYS_NY, timeZone: '' },
  ]) {
    assert.throws(
      () => requireWindow(bad),
      (error) => error.status === 400,
      JSON.stringify(bad)
    );
  }
  assert.equal(requireWindow(null), null);
  assert.deepEqual(requireWindow({ ...WEEKDAYS_NY, days: [5, 1, 3] }).days, [1, 3, 5]);
  assert.match(scheduleId(Date.parse('2026-11-09T12:00:00Z'), 'abcdef'), /^sch-20261109T120000Z-abcdef$/);
});

// Through the API, on the fake. The test console's clock starts on Saturday 2026-10-10 at 22:15 UTC.

async function bench() {
  const world = fleetConsole();
  world.online(A, '1.12.0+0');
  world.online(B, '1.12.0+0');
  world.online(C, '1.12.0+0');
  await world.release('1.13.0+0');
  return world;
}

const schedule = (world, body, as) => world.call('POST', '/api/schedules', body, as);
const listed = async (world) => (await world.call('GET', '/api/schedules', undefined, world.viewer)).body.schedules;

test('a scheduled deployment starts once when it is due, never before, and goes on record', async () => {
  const world = await bench();
  // 02:00 on Sunday in New York is 06:00 UTC.
  const made = await schedule(world, {
    kind: 'deployment',
    at: '2026-10-11T02:00',
    timeZone: 'America/New_York',
    request: { version: '1.13.0+0', things: [B, A], note: 'Overnight' },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const { schedule: item } = made.body;
  assert.deepEqual(
    [item.kind, item.status, item.at, item.timeZone, item.dueAt, item.request.things],
    ['deployment', 'scheduled', '2026-10-11T02:00', 'America/New_York', '2026-10-11T06:00:00.000Z', [A, B]]
  );
  assert.match(item.id, /^sch-20261010T221500Z-[0-9a-f]{6}$/);
  const created = world.entries('schedule.create').at(-1);
  assert.deepEqual([created.outcome, created.target, created.detail.kind], ['ok', item.id, 'deployment']);
  assert.deepEqual(
    created.changes.map((change) => [change.field, change.from, change.to]),
    [
      ['time', null, '2026-10-11T02:00 America/New_York'],
      ['kind', null, 'deployment'],
      ['version', null, '1.13.0+0'],
      ['boards', null, `${A} ${B}`],
      ['note', null, 'Overnight'],
      ['status', null, 'scheduled'],
    ]
  );

  // A minute before: nothing.
  world.clock.ms = Date.parse('2026-10-11T05:59:00Z');
  await world.tick();
  assert.equal(createJobs(world).length, 0);
  assert.equal((await listed(world))[0].status, 'scheduled');

  // Due: one deployment, as its creator, with the note.
  world.clock.ms = Date.parse('2026-10-11T06:00:30Z');
  await world.tick();
  const jobs = createJobs(world);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].things, [A, B]);
  assert.deepEqual(JSON.parse(jobs[0].description).note, 'Overnight');
  assert.equal(JSON.parse(jobs[0].description).by, world.manager.email);
  const [after] = await listed(world);
  assert.deepEqual([after.status, after.started.deployments, after.error], ['started', [jobs[0].jobId], null]);

  // The next run starts nothing more.
  world.advance(MINUTE);
  await world.tick();
  assert.equal(createJobs(world).length, 1);

  const started = world.entries('schedule.start');
  assert.equal(started.length, 1);
  assert.deepEqual(
    [started[0].outcome, started[0].target, started[0].actor.email, started[0].detail.by, started[0].detail.started],
    ['ok', item.id, '', world.manager.email, 'deployment.create']
  );
  assert.deepEqual(
    started[0].changes.map((change) => change.field),
    ['deployment', 'version', 'boards', 'status']
  );
  assert.deepEqual(started[0].changes.at(-1), { field: 'status', from: 'scheduled', to: 'started' });
});

test('two runs at the same moment start a due schedule once', async () => {
  const world = await bench();
  const made = await schedule(world, {
    kind: 'rollout',
    at: '2026-10-11T00:00',
    timeZone: 'UTC',
    request: { version: '1.13.0+0', target: { kind: 'fleet' } },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  world.clock.ms = Date.parse('2026-10-11T00:00:00Z');
  const other = createRolloutTick({
    aws: world.fake,
    config: world.config,
    now: () => world.clock.ms,
    log: () => {},
    randomHex: (count) => 'f'.repeat(2 * count),
  });
  const outcomes = await Promise.all([world.tick(), other(), world.tick()]);
  assert.equal(outcomes.length, 3);
  assert.equal(createJobs(world).length, 1);
  assert.equal((await world.fake.listFleetItems('ROL')).length, 1);
  assert.equal(world.entries('schedule.start').length, 1);
  const [after] = await listed(world);
  assert.equal(after.status, 'started');
  assert.equal(after.started.rollouts.length, 1);
});

test('a schedule can be edited and cancelled before it starts, with what changed on record, and not after', async () => {
  const world = await bench();
  const { schedule: item } = (
    await schedule(world, {
      kind: 'deployment',
      at: '2026-10-11T02:00',
      timeZone: 'America/New_York',
      request: { version: '1.13.0+0', things: [A] },
    })
  ).body;
  const path = `/api/schedules/${item.id}`;

  // A later time, in another zone, and another board.
  const edited = await world.call('POST', path, {
    at: '2026-10-11T09:00',
    timeZone: 'Europe/London',
    request: { version: '1.13.0+0', things: [B] },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(
    [edited.body.schedule.dueAt, edited.body.schedule.request.things],
    ['2026-10-11T08:00:00.000Z', [B]]
  );
  const entry = world.entries('schedule.edit').at(-1);
  assert.deepEqual(
    entry.changes.map((change) => [change.field, change.from, change.to]),
    [
      ['time', '2026-10-11T02:00 America/New_York', '2026-10-11T09:00 Europe/London'],
      ['boards', A, B],
    ]
  );
  // The old time passes: nothing starts.
  world.clock.ms = Date.parse('2026-10-11T06:30:00Z');
  await world.tick();
  assert.equal(createJobs(world).length, 0);

  // Nothing to change, a time in the past, and someone else's newer change are refused.
  assert.equal((await world.call('POST', path, {})).body.error.code, 'nothing_to_change');
  assert.equal(
    (await world.call('POST', path, { at: '2026-10-11T06:00', timeZone: 'UTC' })).body.error.code,
    'schedule_in_past'
  );

  const cancelled = await world.call('POST', `${path}/cancel`, {});
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.schedule.status, 'cancelled');
  assert.equal(cancelled.body.schedule.cancelledBy.email, world.manager.email);
  assert.deepEqual(world.entries('schedule.cancel').at(-1).changes, [
    { field: 'status', from: 'scheduled', to: 'cancelled' },
  ]);
  world.clock.ms = Date.parse('2026-10-11T08:30:00Z');
  await world.tick();
  assert.equal(createJobs(world).length, 0);
  // Over: neither changed nor cancelled again.
  const again = await world.call('POST', `${path}/cancel`, {});
  assert.deepEqual([again.status, again.body.error.code], [409, 'schedule_over']);
  const late = await world.call('POST', path, { at: '2026-10-12T09:00' });
  assert.deepEqual([late.status, late.body.error.code], [409, 'schedule_over']);
  assert.equal((await world.call('POST', '/api/schedules/sch-20261010T000000Z-000000/cancel', {})).status, 404);
  assert.equal((await world.call('POST', '/api/schedules/nonsense/cancel', {})).body.error.code, 'invalid_schedule');
});

test('a started schedule cannot be cancelled; one whose start fails says why, on record', async () => {
  const world = await bench();
  const first = (
    await schedule(world, {
      kind: 'deployment',
      at: '2026-10-11T00:00',
      timeZone: 'UTC',
      request: { version: '1.13.0+0', things: [A] },
    })
  ).body.schedule;
  const second = (
    await schedule(world, {
      kind: 'deployment',
      at: '2026-10-11T00:05',
      timeZone: 'UTC',
      request: { version: '1.13.0+0', things: [A, B] },
    })
  ).body.schedule;
  world.clock.ms = Date.parse('2026-10-11T00:10:00Z');
  await world.tick();
  // The first started; the second found A busy with it, as a start by hand would.
  const all = await listed(world);
  const byId = new Map(all.map((item) => [item.id, item]));
  assert.equal(byId.get(first.id).status, 'started');
  assert.deepEqual([byId.get(second.id).status, byId.get(second.id).error.code], ['failed', 'device_busy']);
  assert.equal(createJobs(world).length, 1);
  const entries = world.entries('schedule.start');
  assert.deepEqual(
    entries
      .map((entry) => [entry.target, entry.outcome, entry.detail.code ?? null])
      .sort((a, b) => (a[1] < b[1] ? -1 : 1)),
    [
      [first.id, 'ok', null],
      [second.id, 'rejected', 'device_busy'],
    ]
  );
  const refused = await world.call('POST', `/api/schedules/${first.id}/cancel`, {});
  assert.deepEqual([refused.status, refused.body.error.code], [409, 'schedule_over']);
});

test('a start cut off after its claim is never started again: after ten minutes it is marked lost', async () => {
  const world = await bench();
  const { schedule: item } = (
    await schedule(world, {
      kind: 'deployment',
      at: '2026-10-11T00:00',
      timeZone: 'UTC',
      request: { version: '1.13.0+0', things: [A] },
    })
  ).body;
  const stored = await world.fake.getFleetItem({ pk: 'SCH', sk: item.id });
  await world.fake.updateFleetItem({
    pk: 'SCH',
    sk: item.id,
    rev: stored.rev,
    set: { status: 'starting', startingAt: '2026-10-11T00:00:10.000Z' },
  });
  world.clock.ms = Date.parse('2026-10-11T00:05:00Z');
  await world.tick();
  assert.equal((await listed(world))[0].status, 'starting');
  world.clock.ms = Date.parse('2026-10-11T00:11:00Z');
  await world.tick();
  const [after] = await listed(world);
  assert.deepEqual([after.status, after.error.code], ['failed', 'start_lost']);
  assert.equal(createJobs(world).length, 0);
});

test("a group's maintenance window: set and cleared on record, a schedule for it waits for it", async () => {
  const world = await bench();
  const { group } = (await world.call('POST', '/api/groups', { name: 'Bench', things: [A, B] })).body;
  const set = await world.call('POST', `/api/groups/${group.id}`, { window: WEEKDAYS_NY });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.deepEqual(set.body.group.window, WEEKDAYS_NY);
  assert.deepEqual(world.entries('group.update').at(-1).changes, [
    { field: 'window', from: null, to: 'weekdays 01:00–05:00 America/New_York' },
  ]);
  const bad = await world.call('POST', `/api/groups/${group.id}`, { window: { ...WEEKDAYS_NY, end: '01:00' } });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'invalid_window']);
  assert.deepEqual(
    (await world.call('GET', '/api/groups', undefined, world.viewer)).body.groups[0].window,
    WEEKDAYS_NY
  );

  // Due at 02:00 on Sunday in New York: the window is weekdays only, so it waits for Monday 01:00 (05:00 UTC).
  const made = await schedule(world, {
    kind: 'rollout',
    at: '2026-10-11T02:00',
    timeZone: 'America/New_York',
    request: { version: '1.13.0+0', target: { kind: 'group', group: group.id } },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.schedule.groupName, 'Bench');
  world.clock.ms = Date.parse('2026-10-11T06:01:00Z');
  await world.tick();
  let [item] = await listed(world);
  assert.deepEqual(
    [item.status, item.waiting, item.window],
    ['scheduled', 'window', 'weekdays 01:00–05:00 America/New_York']
  );
  assert.equal(createJobs(world).length, 0);
  world.clock.ms = Date.parse('2026-10-12T04:59:00Z');
  await world.tick();
  assert.equal(createJobs(world).length, 0);
  world.clock.ms = Date.parse('2026-10-12T05:00:00Z');
  await world.tick();
  [item] = await listed(world);
  assert.deepEqual([item.status, item.waiting], ['started', null]);
  assert.equal(createJobs(world).length, 1);

  // Taken away: on record too.
  const cleared = await world.call('POST', `/api/groups/${group.id}`, { window: null });
  assert.equal(cleared.body.group.window, null);
  assert.deepEqual(world.entries('group.update').at(-1).changes, [
    { field: 'window', from: 'weekdays 01:00–05:00 America/New_York', to: null },
  ]);
});

test('a rollout to a group with a window starts no stage outside it, and says it waits for the window', async () => {
  const world = fleetConsole();
  for (const thing of [A, B, C, D]) world.online(thing, '1.12.0+0');
  await world.release('1.13.0+0');
  const { group } = (
    await world.call('POST', '/api/groups', { name: 'Night', things: [A, B, C, D], window: WEEKDAYS_NY })
  ).body;
  assert.deepEqual(group.window, WEEKDAYS_NY);
  // Started by hand on Saturday evening: its canary goes at once.
  const { rollout } = (
    await world.call('POST', '/api/rollouts', { version: '1.13.0+0', target: { kind: 'group', group: group.id } })
  ).body;
  assert.equal(createJobs(world).length, 1);
  world.finish(rollout.canary.job, rollout.canary.things[0], 'SUCCEEDED', '1.13.0+0');
  await world.tick();
  let detail = (await world.call('GET', `/api/rollouts/${rollout.id}`)).body.rollout;
  assert.deepEqual([detail.stage, detail.waiting], ['stages', 'window']);
  assert.equal(createJobs(world).length, 1);
  assert.equal((await world.call('GET', '/api/rollouts')).body.rollouts[0].waiting, 'window');
  // Monday 01:00 in New York: stage 1 starts.
  world.clock.ms = Date.parse('2026-10-12T05:00:00Z');
  assert.equal((await world.tick()).advanced, 1);
  assert.equal(createJobs(world).length, 2);
  detail = (await world.call('GET', `/api/rollouts/${rollout.id}`)).body.rollout;
  assert.equal(detail.waiting, null);
});

test('a scheduled roll back to last good starts from the plan as it is then, with the health gate on', async () => {
  const world = fleetConsole();
  for (const version of ['1.12.0+0', '1.13.0+0', '1.13.1+0']) await world.release(version);
  await world.release('1.13.2+0');
  const notes = await world.call('PUT', `/api/firmware/${encodeURIComponent('1.13.2+0')}/notes`, {
    notes: 'Rebuild of 1.13.0: the old source under a newer number.',
  });
  assert.equal(notes.status, 200, JSON.stringify(notes.body));
  world.online(A, '1.13.1+0');
  world.online(B, '1.13.1+0');
  for (const thing of [A, B]) {
    const at = world.clock.ms - 3 * HOUR;
    await world.fake.putUpdateFact({
      pk: `UPD#${thing}`,
      sk: `V#${iso(at)}`,
      fact: 'version',
      at,
      from: '1.13.0+0',
      to: '1.13.1+0',
      confirmed: true,
    });
  }
  const { group } = (await world.call('POST', '/api/groups', { name: 'Bench', things: [A, B] })).body;
  const off = await schedule(world, {
    kind: 'last_good',
    at: '2026-10-11T00:00',
    timeZone: 'UTC',
    request: { group: group.id, healthGate: { on: false } },
  });
  assert.deepEqual([off.status, off.body.error.code], [400, 'gate_required']);
  const made = await schedule(world, {
    kind: 'last_good',
    at: '2026-10-11T00:00',
    timeZone: 'UTC',
    request: { group: group.id, things: [B] },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  world.clock.ms = Date.parse('2026-10-11T00:00:00Z');
  await world.tick();
  const [item] = await listed(world);
  assert.equal(item.status, 'started', JSON.stringify(item.error));
  const rollout = (await world.call('GET', `/api/rollouts/${item.started.rollouts[0]}`)).body.rollout;
  assert.deepEqual(
    [rollout.purpose, rollout.version, rollout.things, rollout.healthGate],
    ['last_good', '1.13.2+0', [B], { minutes: 10 }]
  );
  assert.equal(world.entries('schedule.start').at(-1).detail.started, 'fleet.rollback_last_good');
});

test('only release managers schedule; every member reads; requests and times are checked', async () => {
  const world = await bench();
  const good = {
    kind: 'deployment',
    at: '2026-10-11T02:00',
    timeZone: 'America/New_York',
    request: { version: '1.13.0+0', things: [A] },
  };
  const viewer = await schedule(world, good, world.viewer);
  assert.equal(viewer.status, 403);
  assert.equal((await world.call('GET', '/api/schedules', undefined, world.viewer)).status, 200);
  const made = (await schedule(world, good)).body.schedule;
  assert.equal((await world.call('POST', `/api/schedules/${made.id}/cancel`, {}, world.viewer)).status, 403);
  assert.equal(
    (await world.call('POST', `/api/schedules/${made.id}`, { at: '2026-10-11T03:00' }, world.viewer)).status,
    403
  );

  const refusals = [
    [{ ...good, kind: 'reboot' }, 'invalid_kind'],
    [{ ...good, timeZone: 'Mars/Olympus_Mons' }, 'invalid_timeZone'],
    [{ ...good, timeZone: undefined }, 'invalid_timeZone'],
    [{ ...good, at: 'tonight' }, 'invalid_at'],
    [{ ...good, at: '2026-10-10T18:15' }, 'schedule_in_past'],
    [{ ...good, at: '2026-12-01T02:00' }, 'schedule_too_far'],
    [{ ...good, request: null }, 'invalid_request'],
    [{ ...good, request: { version: '1.13.0+0', things: [] } }, 'invalid_things'],
    [{ ...good, request: { version: '9.9.9+0', things: [A] } }, 'unknown_version'],
    [{ ...good, kind: 'rollout', request: { version: '1.13.0+0', target: { kind: 'moon' } } }, 'invalid_target'],
    [
      { ...good, kind: 'rollout', request: { version: '1.13.0+0', target: { kind: 'group', group: 'grp-0a0b0c0d' } } },
      'unknown_group',
    ],
    [
      { ...good, kind: 'rollout', request: { version: '1.13.0+0', target: { kind: 'fleet' }, stages: 99 } },
      'invalid_stages',
    ],
  ];
  for (const [body, code] of refusals) {
    const refused = await schedule(world, body);
    assert.equal(refused.body.error?.code, code, JSON.stringify(body));
  }
  // Refusals are on record as such.
  assert.ok(world.entries('schedule.create').some((entry) => entry.outcome === 'rejected'));
  assert.equal((await listed(world)).length, 1);
});

// The creator, asked of Cognito right before a scheduled start begins (and only then).

async function dueDeployment() {
  const world = await bench();
  const made = await schedule(world, {
    kind: 'deployment',
    at: '2026-10-11T00:00',
    timeZone: 'UTC',
    request: { version: '1.13.0+0', things: [A] },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  world.clock.ms = Date.parse('2026-10-11T00:00:30Z');
  return { world, item: made.body.schedule };
}

for (const [what, change, why] of [
  ['demoted to viewer', (user) => user.setGroups(['viewers']), /no longer a release manager/],
  ['disabled', (user) => user.disable(), /disabled, removed or not confirmed/],
  ['removed', (user) => user.remove(), /disabled, removed or not confirmed/],
]) {
  test(`a scheduled start whose creator was ${what} is not started: cancelled, on record, and an alert`, async () => {
    const { world, item } = await dueDeployment();
    change(world.fake.user(world.manager.sub));
    await world.tick();
    assert.equal(createJobs(world).length, 0);
    const stored = await world.fake.getFleetItem({ pk: 'SCH', sk: item.id });
    assert.deepEqual([stored.status, stored.error.code], ['cancelled', 'creator_not_allowed']);
    assert.match(stored.error.text, why);
    const [entry] = world.entries('schedule.cancel');
    assert.deepEqual(
      [entry.outcome, entry.target, entry.actor.email, entry.detail.code, entry.detail.by],
      ['ok', item.id, '', 'creator_not_allowed', world.manager.email]
    );
    assert.deepEqual(entry.changes.at(-1), { field: 'status', from: 'scheduled', to: 'cancelled' });
    assert.equal(world.entries('schedule.start').length, 0);
    assert.equal(world.raised.length, 1);
    assert.deepEqual([world.raised[0].kind, world.raised[0].deployment], ['deployment', item.id]);
    assert.match(world.raised[0].text, /Not started: its creator/);
    // Never again, whatever becomes of the account later.
    if (what === 'demoted to viewer') world.fake.user(world.manager.sub).setGroups(['release-managers']);
    world.advance(MINUTE);
    await world.tick();
    assert.equal(createJobs(world).length, 0);
  });
}

test('Cognito not to be asked: the scheduled start waits and is asked again, never started unasked', async () => {
  const { world, item } = await dueDeployment();
  world.fake.failNext('getUser', { times: 2 });
  await world.tick();
  assert.equal(createJobs(world).length, 0);
  assert.equal((await world.fake.getFleetItem({ pk: 'SCH', sk: item.id })).status, 'scheduled');
  assert.ok(world.tickLogs.some((line) => line.event === 'schedule_creator_unchecked'));
  world.advance(MINUTE);
  await world.tick();
  assert.equal(createJobs(world).length, 0);
  assert.equal(world.raised.length, 0);
  // Cognito answers again: it starts.
  world.advance(MINUTE);
  await world.tick();
  assert.equal(createJobs(world).length, 1);
  assert.equal((await world.fake.getFleetItem({ pk: 'SCH', sk: item.id })).status, 'started');
});

test('a rollout under way carries on through its stages after its creator is demoted', async () => {
  const world = fleetConsole();
  for (const thing of [A, B, C, D]) world.online(thing, '1.12.0+0');
  await world.release('1.13.0+0');
  const started = await world.call('POST', '/api/rollouts', {
    version: '1.13.0+0',
    target: { kind: 'fleet' },
    stages: 2,
    batch: { unit: 'count', sizes: [1] },
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { rollout } = started.body;
  world.fake.user(world.manager.sub).setGroups(['viewers']);
  world.finish(rollout.canary.job, rollout.canary.things[0], 'SUCCEEDED', '1.13.0+0');
  await world.tick();
  let jobs = createJobs(world);
  assert.equal(jobs.length, 2);
  for (const thing of jobs[1].things) world.finish(jobs[1].jobId, thing, 'SUCCEEDED', '1.13.0+0');
  await world.tick();
  jobs = createJobs(world);
  assert.equal(jobs.length, 3);
  for (const thing of jobs[2].things) world.finish(jobs[2].jobId, thing, 'SUCCEEDED', '1.13.0+0');
  assert.equal((await world.tick()).done, 1);
  const stored = await world.fake.getFleetItem({ pk: 'ROL', sk: rollout.id });
  assert.equal(stored.stage, 'done');
  assert.equal(world.entries('rollout.stop').length, 0);
});
