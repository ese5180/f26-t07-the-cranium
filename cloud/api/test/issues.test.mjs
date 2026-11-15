// Tests for our own issues (src/lib/issues.mjs, src/handlers/issues.mjs, docs/own-observability.md): which
// restarts are issues, their signatures, the version each happened on, counts and boards, regressions, and
// GET /api/issues and /api/issues/{id}: what they answer, what they refuse and who may read them.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { eventKey } from '../src/lib/events.mjs';
import { groupIssues, issueId, occurrenceOf, parseIssueId, versionStanding, withVersions } from '../src/lib/issues.mjs';
import { createTestConsole } from './fake-aws.mjs';

const A = 'cranium-0123456789abcdef';
const B = 'cranium-fedcba9876543210';
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms) => new Date(ms).toISOString();

let serial = 0;
function event(fields, ms) {
  serial += 1;
  return { kind: 'restart', level: 'warn', text: 'x', at: at(ms), id: serial.toString(16).padStart(6, '0'), ...fields };
}
const watchdog = (ms, extra = {}) => event({ what: 'boot', cause: '10', ...extra }, ms);
const stuck = (ms, reason = 'wifi_silent') => event({ what: 'stuck', reason, count: 1 }, ms);
const firmware = (ms, version, from) =>
  event(
    { kind: 'firmware', what: from ? 'changed' : 'reported', level: 'info', version, ...(from ? { from } : {}) },
    ms
  );

// The rules, without AWS.

test('only a restart that says something went wrong is an issue', () => {
  assert.equal(occurrenceOf(event({ what: 'restarted', level: 'info' }, NOW)), null);
  // The reset pin, software and a loss of power are people and updates, not crashes.
  for (const cause of ['1', '2', '8', '0', '3']) assert.equal(occurrenceOf(watchdog(NOW, { cause })), null, cause);
  assert.equal(occurrenceOf({ kind: 'health', what: 'memory' }), null);
  assert.equal(occurrenceOf(null), null);

  const dog = occurrenceOf(watchdog(NOW));
  assert.equal(dog.signature, 'reset:watchdog');
  assert.equal(dog.title, 'Reset by the watchdog');
  // A software restart with a lockup: the bad cause alone names it, in a fixed order.
  assert.equal(occurrenceOf(watchdog(NOW, { cause: '112' })).signature, 'reset:lockup+watchdog');
  const wifi = occurrenceOf(stuck(NOW));
  assert.equal(wifi.signature, 'stuck:wifi_silent');
  assert.equal(wifi.title, 'Stuck: the Wi-Fi chip stopped answering');
});

test('a fault is grouped by its function across builds, and by its address within one build', () => {
  const fault = (extra) => event({ what: 'fault', reason: 'HARDFAULT', ...extra }, NOW);
  assert.equal(
    occurrenceOf(fault({ frame: 'crash_demo_on_tick' }), '1.14.0+1').signature,
    'fault:hardfault@crash_demo_on_tick'
  );
  assert.equal(
    occurrenceOf(fault({ frame: 'crash_demo_on_tick' }), '1.15.0+0').signature,
    'fault:hardfault@crash_demo_on_tick'
  );
  assert.equal(occurrenceOf(fault({ pc: '0x3c074' }), '1.14.0+1').signature, 'fault:hardfault@0x3c074/1.14.0+1');
  assert.notEqual(
    issueId(occurrenceOf(fault({ pc: '0x3c074' }), '1.14.0+1').signature),
    issueId(occurrenceOf(fault({ pc: '0x3c074' }), '1.15.0+0').signature)
  );
  assert.equal(occurrenceOf(fault({ frame: 'z_fatal' })).title, 'Fault: hardfault at z_fatal');
});

test('an issue id is 12 hex digits, the same for the same signature, and nothing else is one', () => {
  assert.match(issueId('reset:watchdog'), /^[0-9a-f]{12}$/);
  assert.equal(issueId('reset:watchdog'), issueId('reset:watchdog'));
  assert.notEqual(issueId('reset:watchdog'), issueId('reset:brownout'));
  assert.equal(parseIssueId(issueId('x')), issueId('x'));
  for (const bad of ['', 'ABCDEF012345', '0123456789a', '0123456789abc', '../x', 7, null]) {
    assert.equal(parseIssueId(bad), null, String(bad));
  }
});

test('each occurrence happened on the version the board ran just before it', () => {
  const events = [
    watchdog(NOW - 5 * DAY, { version: '1.13.0+0' }),
    firmware(NOW - 4 * DAY, '1.14.0+0', '1.13.0+0'),
    stuck(NOW - 3 * DAY),
  ];
  assert.deepEqual(
    withVersions(events, '1.14.0+0').map(({ event: one, version }) => [one.what, version]),
    [
      ['boot', '1.13.0+0'],
      ['changed', '1.13.0+0'],
      ['stuck', '1.14.0+0'],
    ]
  );
  // With no firmware event at all, what the event says, then what the board runs now.
  assert.equal(withVersions([stuck(NOW)], '1.12.0+0')[0].version, '1.12.0+0');
  assert.equal(withVersions([stuck(NOW)])[0].version, null);
});

test('issues group across boards, with counts, first and last seen, boards and versions', () => {
  const issues = groupIssues([
    {
      thing: A,
      current: '1.14.0+0',
      events: [
        watchdog(NOW - 3 * DAY, { version: '1.14.0+0' }),
        watchdog(NOW - DAY, { version: '1.14.0+0' }),
        stuck(NOW - 2 * HOUR),
      ],
    },
    { thing: B, current: '1.13.0+0', events: [watchdog(NOW - 2 * DAY, { version: '1.13.0+0' })] },
  ]);
  assert.deepEqual(
    issues.map((one) => [one.signature, one.count, one.boards]),
    [
      ['stuck:wifi_silent', 1, 1],
      ['reset:watchdog', 3, 2],
    ]
  );
  const dog = issues[1];
  assert.deepEqual(dog.versions, ['1.13.0+0', '1.14.0+0']);
  assert.equal(dog.firstSeen, at(NOW - 3 * DAY));
  assert.equal(dog.lastSeen, at(NOW - DAY));
  assert.deepEqual([dog.firstVersion, dog.lastVersion], ['1.13.0+0', '1.14.0+0']);
  assert.deepEqual(
    dog.perBoard.map((board) => [board.thing, board.count, board.versions]),
    [
      [A, 2, ['1.14.0+0']],
      [B, 1, ['1.13.0+0']],
    ]
  );
  assert.equal(dog.occurrences[0].at, at(NOW - DAY));
  assert.equal(dog.status, 'open');
});

test('a fix is a newer version that never had it; a regression is the issue again after the fix', () => {
  assert.deepEqual(versionStanding(new Set(['1.13.0+0']), ['1.13.0+0', '1.14.0+0']), {
    status: 'fixed',
    fixedIn: '1.14.0+0',
    regressedIn: null,
    regression: null,
  });
  const back = versionStanding(new Set(['1.13.0+0', '1.15.0+0']), ['1.13.0+0', '1.14.0+0', '1.15.0+0']);
  assert.equal(back.status, 'regressed');
  assert.deepEqual([back.fixedIn, back.regressedIn], ['1.14.0+0', '1.15.0+0']);
  // An older version with no occurrence fixes nothing.
  assert.equal(versionStanding(new Set(['1.14.0+0']), ['1.13.0+0', '1.14.0+0']).status, 'open');

  // Board A: the watchdog on 1.13, none on 1.14, again on 1.15.
  const [issue] = groupIssues([
    {
      thing: A,
      current: '1.15.0+0',
      events: [
        firmware(NOW - 10 * DAY, '1.13.0+0'),
        watchdog(NOW - 9 * DAY),
        firmware(NOW - 8 * DAY, '1.14.0+0', '1.13.0+0'),
        firmware(NOW - 4 * DAY, '1.15.0+0', '1.14.0+0'),
        watchdog(NOW - 2 * DAY),
      ],
    },
  ]);
  assert.deepEqual(
    [issue.status, issue.regressed, issue.fixedIn, issue.regressedIn],
    ['regressed', true, '1.14.0+0', '1.15.0+0']
  );
});

// The routes.

function setup() {
  const console_ = createTestConsole({ startMs: NOW - 30 * DAY });
  const viewer = console_.addUser('viewer', ['viewers']);
  const manager = console_.addUser('vihaan.ravishankar', ['release-managers']);
  const outsider = console_.addUser('outsider', []);
  console_.fake.addThing(A);
  console_.fake.addThing(B);
  const get = (path, query, as = viewer) => console_.call('GET', path, { as, query });
  return { ...console_, viewer, manager, outsider, get };
}

function item(thing, ms, fields, random) {
  return {
    pk: thing,
    sk: eventKey(ms, random),
    level: 'warn',
    text: 'Restarted',
    ttl: Math.floor(ms / 1000) + 90 * 86_400,
    ...fields,
  };
}

function seed(fake) {
  fake.putEventItem(
    item(A, NOW - 3 * DAY, { kind: 'restart', what: 'boot', cause: '10', version: '1.14.0+0' }, '00000a')
  );
  fake.putEventItem(item(A, NOW - DAY, { kind: 'restart', what: 'boot', cause: '10', version: '1.14.0+0' }, '00000b'));
  fake.putEventItem(item(B, NOW - 2 * DAY, { kind: 'restart', what: 'stuck', reason: 'no_cloud', count: 1 }, '00000c'));
  // Neither of these is an issue: a restart by the reset pin, and a change of channel.
  fake.putEventItem(
    item(B, NOW - 2 * DAY + HOUR, { kind: 'restart', what: 'boot', cause: '1', level: 'info' }, '00000d')
  );
  fake.putEventItem(
    item(B, NOW - DAY, { kind: 'health', what: 'channel', channel: 6, before: 1, level: 'info' }, '00000e')
  );
  // Older than the default 30 days: only a longer window sees it.
  fake.putEventItem(
    item(B, NOW - 45 * DAY, { kind: 'restart', what: 'boot', cause: '4', version: '1.12.0+0' }, '00000f')
  );
}

test('GET /api/issues lists the issues of the window, most recent first, for every member', async () => {
  const context = setup();
  seed(context.fake);
  context.clock.ms = NOW;
  for (const as of [context.viewer, context.manager]) {
    const response = await context.get('/api/issues', undefined, as);
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.issues.map((one) => [one.signature, one.count, one.boards]),
      [
        ['reset:watchdog', 2, 1],
        ['stuck:no_cloud', 1, 1],
      ]
    );
    assert.equal(response.body.days, 30);
    assert.equal(response.body.boards, 2);
    assert.equal(response.body.unread, 0);
    // The list carries no boards or timeline: those are the issue's own page.
    assert.equal(response.body.issues[0].perBoard, undefined);
    assert.equal(response.body.issues[0].occurrences, undefined);
  }
  const longer = await context.get('/api/issues', { days: '60' });
  assert.deepEqual(
    longer.body.issues.map((one) => one.signature),
    ['reset:watchdog', 'stuck:no_cloud', 'reset:brownout']
  );
});

test('GET /api/issues/{id} gives the boards and the timeline of one issue', async () => {
  const context = setup();
  seed(context.fake);
  context.clock.ms = NOW;
  const id = issueId('reset:watchdog');
  const response = await context.get(`/api/issues/${id}`);
  assert.equal(response.status, 200);
  const { issue } = response.body;
  assert.equal(issue.id, id);
  assert.equal(issue.title, 'Reset by the watchdog');
  assert.deepEqual(
    issue.perBoard.map((board) => [board.thing, board.count]),
    [[A, 2]]
  );
  assert.deepEqual(
    issue.timeline.map((one) => [one.at, one.thing, one.version]),
    [
      [at(NOW - DAY), A, '1.14.0+0'],
      [at(NOW - 3 * DAY), A, '1.14.0+0'],
    ]
  );
  assert.equal(issue.timelineCut, false);
});

test('the issue routes refuse what they cannot answer, and need a member', async () => {
  const context = setup();
  seed(context.fake);
  context.clock.ms = NOW;
  for (const [path, query, status, code] of [
    ['/api/issues', { days: '0' }, 400, 'invalid_days'],
    ['/api/issues', { days: '91' }, 400, 'invalid_days'],
    ['/api/issues', { days: 'x' }, 400, 'invalid_days'],
    ['/api/issues/NOT-AN-ID', undefined, 400, 'invalid_issue'],
    [`/api/issues/${issueId('reset:temperature')}`, undefined, 404, 'unknown_issue'],
  ]) {
    const response = await context.get(path, query);
    assert.deepEqual([response.status, response.body.error.code], [status, code], `${path} ${JSON.stringify(query)}`);
  }
  assert.equal((await context.call('GET', '/api/issues')).status, 401);
  assert.equal((await context.get('/api/issues', undefined, context.outsider)).status, 403);
  assert.equal(
    (await context.get(`/api/issues/${issueId('reset:watchdog')}`, undefined, context.outsider)).status,
    403
  );
});

test('a board whose events cannot be read is left out and counted, and the rest still answer', async () => {
  const context = setup();
  seed(context.fake);
  context.clock.ms = NOW;
  context.fake.failNext('queryEvents');
  const response = await context.get('/api/issues');
  assert.equal(response.status, 200);
  assert.equal(response.body.unread, 1);
  assert.equal(response.body.issues.length, 1);
});
