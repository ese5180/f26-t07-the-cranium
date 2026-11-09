// Tests for the alert rules (console 2.12.0): the rules release managers turn on and tune (src/handlers/alerts.mjs,
// src/lib/alerts.mjs RULES), each rule firing and being held back by the alerter (src/alerts.mjs), the look at
// Memfault the schedule makes for them (watch), and the live message an alert makes for open pages (lib/live.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAlerter } from '../src/alerts.mjs';
import {
  ALERT_EVERY_MS,
  WATCH_EVERY_MS,
  defaultRules,
  emailOf,
  emptyWatch,
  normalizeRules,
  ruleAllows,
  watchFindings,
} from '../src/lib/alerts.mjs';
import { changesOf, messageFor } from '../src/lib/live.mjs';
import { rebootReason } from '../src/lib/memfault-data.mjs';
import { createFakeAws, createTestConsole } from './fake-aws.mjs';

const THING = 'cranium-0123456789abcdef';
const OTHER = 'cranium-00000000000000bb';
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const CONSOLE = 'https://console.example.com/';
const MINUTE = 60_000;
const iso = (ms) => new Date(ms).toISOString();

/** The alerter on the stand-in's store, with its rules in the stand-in's state table, and a clock the test moves. */
function alerter(rules = null) {
  const clock = { ms: NOW };
  const fake = createFakeAws({ now: () => clock.ms });
  if (rules !== null) fake.putFleetItem({ pk: 'ALR', sk: 'rules', item: { rules, rev: 1 } });
  const logs = [];
  const run = createAlerter({
    store: fake.alertStore(),
    consoleUrl: CONSOLE,
    now: () => clock.ms,
    log: (line) => logs.push(line),
  });
  return { run, fake, clock, logs, emails: fake.alertEmails };
}

const unexpected = (thing, at, code = 0x8001, version = '1.13.0+0') => ({
  kind: 'reboot',
  thing,
  serial: thing,
  at: iso(at),
  version,
  reason: rebootReason(code),
});
const heartbeat = (thing, at, mv) => ({
  kind: 'heartbeat',
  thing,
  serial: thing,
  at: iso(at),
  values: { supply_mv: mv },
});

/** What handlers/memfault.mjs gives the watch: what the test says Memfault has, and every look counted. */
function memfaultSource(facts) {
  const source = {
    looks: 0,
    facts,
    boards: {},
    async watch({ minutes }) {
      source.looks += 1;
      source.minutes = minutes;
      return typeof source.facts === 'function' ? source.facts() : { state: 'ok', ...source.facts };
    },
    async issueBoards(id) {
      return source.boards[id] ?? [];
    },
  };
  return source;
}

// The rules, without AWS.

test('the rules: their defaults, what a stored item may change, and which kinds each holds back', () => {
  assert.deepEqual(defaultRules(), {
    offline: { on: true, minutes: 15 },
    issue: { on: true },
    crashLoop: { on: true, reboots: 3, minutes: 30 },
    rollout: { on: true },
    voltage: { on: true, mv: 3000 },
  });
  const rules = normalizeRules({
    rules: {
      offline: { on: false, minutes: 2 },
      voltage: { mv: 3200, extra: 1 },
      crashLoop: 'all',
      nope: { on: false },
    },
  });
  assert.deepEqual(
    [rules.offline, rules.voltage, rules.crashLoop],
    [
      { on: false, minutes: 15 },
      { on: true, mv: 3200 },
      { on: true, reboots: 3, minutes: 30 },
    ]
  );
  assert.equal(ruleAllows(rules, 'offline'), false);
  assert.equal(ruleAllows(rules, 'online'), false);
  assert.equal(ruleAllows(rules, 'update'), true);
  assert.equal(ruleAllows({ ...rules, rollout: { on: false } }, 'deployment'), false);
});

test('the watch learns the issues there are on its first look, then finds new ones, crash loops and low voltage once each', () => {
  const rules = defaultRules();
  const issues = [{ id: 11, title: 'Old' }];
  const first = watchFindings(emptyWatch(), { issues, reboots: [], heartbeats: [] }, rules, NOW);
  assert.deepEqual([first.newIssues, first.alerts, first.state.issues], [[], [], [11]]);
  const reboots = [
    unexpected(THING, NOW - 20 * MINUTE),
    unexpected(THING, NOW - 10 * MINUTE),
    unexpected(THING, NOW - MINUTE, 0x9400),
  ];
  const facts = {
    issues: [...issues, { id: 12, title: 'New crash' }],
    // Two unexpected restarts of another board, an expected one, and one too long ago: no loop.
    reboots: [
      ...reboots,
      unexpected(OTHER, NOW - 5 * MINUTE),
      unexpected(OTHER, NOW - 4 * MINUTE),
      unexpected(OTHER, NOW - 3 * MINUTE, 0x0003),
      unexpected(OTHER, NOW - 45 * MINUTE),
    ],
    heartbeats: [
      heartbeat(THING, NOW - 70 * MINUTE, 2800),
      heartbeat(THING, NOW - 10 * MINUTE, 3300),
      heartbeat(OTHER, NOW - 5 * MINUTE, 2900),
    ],
  };
  const second = watchFindings(first.state, facts, rules, NOW + WATCH_EVERY_MS);
  assert.deepEqual(second.newIssues, [{ id: 12, title: 'New crash' }]);
  assert.deepEqual(
    second.alerts.map((alert) => [alert.kind, alert.thing, alert.text]),
    [
      ['crashloop', THING, '3 unexpected restarts in 30 min, the last HardFault on 1.13.0+0'],
      [
        'voltage',
        OTHER,
        `Supply 2900 mV in the heartbeat of ${iso(NOW - 5 * MINUTE)
          .slice(0, 16)
          .replace('T', ' ')} UTC, under 3000 mV`,
      ],
    ]
  );
  // The same restarts and the same heartbeat again: nothing new.
  const third = watchFindings(second.state, facts, rules, NOW + 2 * WATCH_EVERY_MS);
  assert.deepEqual([third.newIssues, third.alerts], [[], []]);
  // A rule that is off finds nothing.
  const off = {
    ...rules,
    crashLoop: { ...rules.crashLoop, on: false },
    voltage: { ...rules.voltage, on: false },
    issue: { on: false },
  };
  const quiet = watchFindings(first.state, facts, off, NOW + WATCH_EVERY_MS);
  assert.deepEqual([quiet.newIssues, quiet.alerts], [[], []]);
});

// Each rule, firing and held back.

test('offline: the rule sets the minutes before the alert, and off it never goes', async () => {
  const { run, clock, emails } = alerter({ offline: { on: true, minutes: 30 } });
  await run.presence({ clientId: THING, eventType: 'disconnected', timestamp: NOW, versionNumber: 3 });
  clock.ms = NOW + 20 * MINUTE;
  assert.equal(await run.check(), 0);
  clock.ms = NOW + 31 * MINUTE;
  assert.equal(await run.check(), 1);
  assert.match(emails[0].subject, /is offline$/);
  assert.match(emails[0].message, /longer than the offline alert rule allows/);

  const quiet = alerter({ offline: { on: false } });
  await quiet.run.presence({ clientId: THING, eventType: 'disconnected', timestamp: NOW, versionNumber: 3 });
  quiet.clock.ms = NOW + 3 * 60 * MINUTE;
  assert.equal(await quiet.run.check(), 0);
  assert.equal(quiet.emails.length, 0);
});

test('a new Memfault issue: an e-mail per board with its traces, linking to the issue, and held back within the hour', async () => {
  const { run, clock, emails } = alerter();
  const source = memfaultSource({ issues: [{ id: 11, title: 'Old' }], reboots: [], heartbeats: [] });
  assert.equal(await run.watch(source), 0);
  // Within 5 minutes Memfault is not asked again.
  clock.ms += MINUTE;
  assert.equal(await run.watch(source), 0);
  assert.equal(source.looks, 1);
  assert.equal(source.minutes, 120);

  source.facts = {
    issues: [
      { id: 11, title: 'Old' },
      { id: 12, title: 'Kernel panic at tick' },
    ],
    reboots: [],
    heartbeats: [],
  };
  source.boards[12] = [THING];
  clock.ms = NOW + WATCH_EVERY_MS;
  assert.equal(await run.watch(source), 1);
  assert.equal(emails[0].subject, `Cranium: A new Memfault issue on ${THING}`);
  assert.match(
    emails[0].message,
    /New Memfault issue #12: Kernel panic at tick\n {4}https:\/\/console\.example\.com\/#\/memfault\/12/
  );

  // Another new issue on the same board within the hour: held back, and sent with the next e-mail.
  source.facts = { ...source.facts, issues: [...source.facts.issues, { id: 13, title: 'Bus fault' }] };
  source.boards[13] = [THING];
  clock.ms += WATCH_EVERY_MS;
  assert.equal(await run.watch(source), 0);
  assert.equal(emails.length, 1);
  clock.ms = NOW + WATCH_EVERY_MS + ALERT_EVERY_MS;
  assert.equal(await run.check(), 1);
  assert.match(emails[1].message, /New Memfault issue #13: Bus fault/);
});

test('a crash loop: N unexpected restarts in M minutes on one board, once, and held back within the hour', async () => {
  const { run, clock, emails } = alerter({ crashLoop: { reboots: 2, minutes: 10 } });
  const source = memfaultSource({
    issues: [],
    reboots: [unexpected(THING, NOW - 8 * MINUTE), unexpected(THING, NOW - MINUTE)],
    heartbeats: [],
  });
  assert.equal(await run.watch(source), 1);
  assert.equal(emails[0].subject, `Cranium: ${THING} keeps restarting`);
  assert.match(emails[0].message, /2 unexpected restarts in 10 min, the last Assert on 1\.13\.0\+0/);
  // It goes on restarting: held back, not a new e-mail every 5 minutes.
  clock.ms += WATCH_EVERY_MS;
  source.facts = { ...source.facts, reboots: [...source.facts.reboots, unexpected(THING, clock.ms - MINUTE)] };
  assert.equal(await run.watch(source), 0);
  assert.equal(emails.length, 1);
  const off = alerter({ crashLoop: { on: false } });
  assert.equal(await off.run.watch(memfaultSource(source.facts)), 0);
});

test('low supply voltage: under the threshold in a heartbeat, once per heartbeat, held back within the hour', async () => {
  const { run, clock, emails } = alerter({ voltage: { mv: 3100 } });
  const source = memfaultSource({ issues: [], reboots: [], heartbeats: [heartbeat(THING, NOW - 5 * MINUTE, 3050)] });
  assert.equal(await run.watch(source), 1);
  assert.equal(emails[0].subject, `Cranium: ${THING} has a low supply voltage`);
  assert.match(emails[0].message, /Supply 3050 mV in the heartbeat of .* under 3100 mV/);
  clock.ms += WATCH_EVERY_MS;
  source.facts = {
    ...source.facts,
    heartbeats: [...source.facts.heartbeats, heartbeat(THING, clock.ms - MINUTE, 3000)],
  };
  assert.equal(await run.watch(source), 0);
  assert.equal(emails.length, 1);
});

test('a staged rollout that stopped by itself: an e-mail that links to the rollout, and none with its rule off', async () => {
  const { run, emails } = alerter();
  const alert = {
    kind: 'deployment',
    deployment: 'cranium-1-13-0-b0-20261109T115500Z-4d1b',
    version: '1.13.0+0',
    rollout: 'rol-20261109T115500Z-64653b',
    at: NOW,
    text: 'Staged rollout rol-20261109T115500Z-64653b of 1.13.0+0: After the canary, the health gate failed',
    link: '#/memfault/21',
  };
  assert.equal(await run.raise(alert), 1);
  assert.match(emails[0].message, /#\/memfault\/21/);
  assert.match(
    emails[0].message,
    /Open it on the console: https:\/\/console\.example\.com\/#\/rollouts\/rol-20261109T115500Z-64653b/
  );
  assert.equal(await run.raise({ ...alert, at: NOW + 1 }), 0, 'held back within the hour');
  const off = alerter({ rollout: { on: false } });
  assert.equal(await off.run.raise(alert), 0);
  assert.equal(off.emails.length, 0);
});

test('a look Memfault does not answer raises nothing and is tried again at the next run', async () => {
  const { run, logs } = alerter();
  const source = memfaultSource(() => ({ state: 'unreachable', message: 'no' }));
  assert.equal(await run.watch(source), 0);
  assert.equal(await run.watch(source), 0);
  assert.equal(source.looks, 2);
  assert.ok(logs.some((line) => line.event === 'alert_watch_unread'));
  // With every Memfault rule off, Memfault is not asked at all.
  const off = alerter({ issue: { on: false }, crashLoop: { on: false }, voltage: { on: false } });
  const untouched = memfaultSource({ issues: [], reboots: [], heartbeats: [] });
  assert.equal(await off.run.watch(untouched), 0);
  assert.equal(untouched.looks, 0);
});

test('an e-mail line links only to a page of the console', () => {
  const item = { thing: THING, name: null, sk: `B#${THING}` };
  const mail = (link) => ({ kind: 'issue', lines: [{ at: NOW, text: 'x', link }], more: 0 });
  assert.match(
    emailOf(item, mail('#/memfault/12'), CONSOLE).message,
    /\n {4}https:\/\/console\.example\.com\/#\/memfault\/12/
  );
  assert.equal(emailOf(item, mail('https://evil.example/'), CONSOLE).message.includes('evil'), false);
});

// The routes.

function accountWorld() {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  return { ...console_, manager, viewer };
}

test('every member reads the rules; a release manager changes them, a field at a time, on record', async () => {
  const { call, manager, viewer, fake } = accountWorld();
  const seen = await call('GET', '/api/alerts', { as: viewer });
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.body.alertRules, defaultRules());
  assert.deepEqual(seen.body.ruleLimits.crashLoop, { reboots: [2, 20], minutes: [5, 1440] });
  assert.equal(seen.body.canChangeRules, false);

  const changed = await call('POST', '/api/alerts/rules', {
    as: manager,
    body: { rules: { offline: { minutes: 30 }, voltage: { on: false } } },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(
    [changed.body.alertRules.offline, changed.body.alertRules.voltage],
    [
      { on: true, minutes: 30 },
      { on: false, mv: 3000 },
    ]
  );
  const again = await call('POST', '/api/alerts/rules', {
    as: manager,
    body: { rules: { crashLoop: { reboots: 5 } } },
  });
  assert.equal(again.status, 200);
  const after = (await call('GET', '/api/alerts', { as: manager })).body;
  assert.deepEqual(
    [
      after.alertRules.offline.minutes,
      after.alertRules.voltage.on,
      after.alertRules.crashLoop.reboots,
      after.rules.offlineMinutes,
    ],
    [30, false, 5, 30]
  );
  assert.equal(after.canChangeRules, true);
  const entries = fake.auditLog().filter((entry) => entry.action === 'alert.rules');
  assert.deepEqual(
    entries.map((entry) => [entry.outcome, entry.target, entry.detail.changes]),
    [
      ['ok', 'rules', 'offline minutes 30; voltage off'],
      ['ok', 'rules', 'crashLoop reboots 5'],
    ]
  );
});

test('a viewer may not change the rules, and a rule or a value that is not one is refused, each on record', async () => {
  const { call, manager, viewer, fake } = accountWorld();
  const refused = await call('POST', '/api/alerts/rules', { as: viewer, body: { rules: { issue: { on: false } } } });
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'release_manager_required']);
  for (const body of [
    {},
    { rules: {} },
    { rules: { nope: { on: true } } },
    { rules: { offline: { minutes: 2 } } },
    { rules: { offline: { on: 'yes' } } },
    { rules: { voltage: { volts: 3 } } },
    { rules: { issue: {} } },
    { rules: { issue: { on: true } }, extra: 1 },
  ]) {
    const bad = await call('POST', '/api/alerts/rules', { as: manager, body });
    assert.deepEqual([bad.status, bad.body.error.code], [400, 'invalid_rules'], JSON.stringify(body));
  }
  const entries = fake.auditLog().filter((entry) => entry.action === 'alert.rules');
  assert.equal(entries.length, 9);
  assert.deepEqual([entries[0].outcome, entries[0].detail.code], ['denied', 'release_manager_required']);
  assert.ok(entries.slice(1).every((entry) => entry.outcome === 'rejected' && entry.detail.code === 'invalid_rules'));
  assert.deepEqual((await call('GET', '/api/alerts', { as: viewer })).body.alertRules, defaultRules());
});

// Live, to the open pages.

test('an alert e-mail that went out is a live change for the team, and never for a customer', () => {
  const tables = { events: 'events-t', state: 'state-t', audit: 'audit-t' };
  const record = (eventName, pk, sk) => ({
    eventName,
    eventSourceARN: 'arn:aws:dynamodb:us-east-1:000000000000:table/events-t/stream/2026',
    dynamodb: { Keys: { pk: { S: pk }, sk: { S: sk } } },
  });
  const change = changesOf([record('INSERT', 'ALERTS', `S#${iso(NOW)}#${THING}#issue`)], tables);
  assert.deepEqual(change, { things: [], what: ['alerts'] });
  // What the alerts keep of each board, and a change of a sent item, are not.
  assert.deepEqual(
    changesOf([record('MODIFY', 'ALERTS', `B#${THING}`), record('MODIFY', 'ALERTS', 'S#x')], tables).what,
    []
  );
  assert.deepEqual(messageFor({ audience: 'team', sub: 'a' }, change, null, NOW).what, ['alerts']);
  assert.equal(messageFor({ audience: 'customer', sub: 'a' }, change, new Map(), NOW), null);
});
