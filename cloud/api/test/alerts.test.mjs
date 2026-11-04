// Tests for the e-mail alerts: which events make one and what it says (src/lib/alerts.mjs), the
// throttle and the folding, presence and the scheduled check (src/alerts.mjs), the recorder that
// feeds them (src/recorder.mjs), and the Account page's routes (src/handlers/alerts.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAlerter, isScheduledCheck } from '../src/alerts.mjs';
import {
  ALERT_EVERY_MS, FOLDED_KEPT, OFFLINE_AFTER_MS, alertOfEvent, applyPresence, emailOf, emptyBoard, isNewerPresence,
  presenceOf, sentFromItem, spell, takeAlert, utc,
} from '../src/lib/alerts.mjs';
import { createRecorder } from '../src/recorder.mjs';
import { createFakeAws, createTestConsole } from './fake-aws.mjs';

const THING = 'cranium-0123456789abcdef';
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const CONSOLE = 'https://console.example.com/';
const MINUTE = 60_000;

const event = (kind, what, changes = {}) => ({
  pk: THING, sk: `E#${new Date(NOW).toISOString()}#0a0b0c`, kind, what, level: 'warn', text: 'Something happened', ...changes,
});
const presence = (eventType, at, changes = {}) => ({ clientId: THING, eventType, timestamp: at, versionNumber: 3, ...changes });

/** The alerter on the stand-in's store, with a clock the test moves. */
function alerter({ failPublish = 0 } = {}) {
  const clock = { ms: NOW };
  const fake = createFakeAws({ now: () => clock.ms });
  const store = fake.alertStore();
  let failures = failPublish;
  const logs = [];
  const run = createAlerter({
    store: {
      ...store,
      async publishAlert(mail) {
        if (failures > 0) {
          failures -= 1;
          throw Object.assign(new Error('Publish: InternalError'), { name: 'AwsError', code: 'failed' });
        }
        return store.publishAlert(mail);
      },
    },
    consoleUrl: CONSOLE,
    now: () => clock.ms,
    log: (line) => logs.push(line),
  });
  return { run, fake, clock, logs, emails: fake.alertEmails, board: () => store.getAlertItem(`B#${THING}`) };
}

// Which events make an alert.

test('a failed or rolled-back update, a bad Bluetooth update, a restart for being stuck and a move make alerts', () => {
  const cases = [
    [event('update', 'result', { result: 'failed' }), 'update'],
    [event('update', 'result', { result: 'rolled_back' }), 'update'],
    [event('update', 'result', { result: 'succeeded' }), null],
    [event('update', 'result', { result: 'declined' }), null],
    [event('bluetooth', 'record', { result: 'rolled_back' }), 'update'],
    [event('bluetooth', 'record', { result: 'trial_lost' }), 'update'],
    [event('bluetooth', 'record', { result: 'succeeded' }), null],
    [event('restart', 'stuck'), 'stuck'],
    [event('restart', 'restarted'), null],
    [event('health', 'moved'), 'moved'],
    [event('health', 'located'), null],
    [event('connection', 'disconnected'), null],
    [event('update', 'stopped', { job: 'cranium-1-2-3-b5-20261104T110000Z-0a0a' }), 'deployment'],
    [event('update', 'stopped'), null],
  ];
  for (const [item, kind] of cases) assert.equal(alertOfEvent(item)?.kind ?? null, kind, `${item.kind} ${item.what} ${item.result}`);
  const stopped = alertOfEvent(cases.at(-2)[0]);
  assert.deepEqual([stopped.deployment, stopped.version], ['cranium-1-2-3-b5-20261104T110000Z-0a0a', '1.2.3+5']);
  // Not an event of a board, or a text the log would not keep.
  assert.equal(alertOfEvent({ ...event('restart', 'stuck'), pk: 'LOC' }), null);
  assert.equal(alertOfEvent({ ...event('restart', 'stuck'), text: 'é' }), null);
  assert.equal(alertOfEvent({ ...event('restart', 'stuck') }).at, NOW);
});

test('presence: a newer message by time, else by AWS\'s version, and within one connection the disconnect last', () => {
  const kept = presenceOf(presence('disconnected', NOW, { disconnectReason: 'CONNECTION_LOST' }), NOW);
  assert.deepEqual(kept, { thing: THING, state: 'offline', at: NOW, version: 3, reason: 'CONNECTION_LOST' });
  const of = (type, at, version) => presenceOf(presence(type, at, { versionNumber: version }), at);
  assert.equal(isNewerPresence(null, kept), true);
  // Out of order: the connect of the same connection, arriving after its disconnect.
  assert.equal(isNewerPresence(kept, of('connected', NOW - 30_000, 3)), false);
  // A new connection takes over the name (DUPLICATE_CLIENTID): its connect may be stamped first.
  assert.equal(isNewerPresence(kept, of('connected', NOW - 5, 4)), true);
  assert.equal(isNewerPresence(of('connected', NOW, 4), of('disconnected', NOW + 5, 3)), false);
  // An hour later AWS has counted from 0 again: time decides.
  assert.equal(isNewerPresence(kept, of('connected', NOW + 61 * MINUTE, 0)), true);
  // The same message twice changes nothing.
  assert.equal(isNewerPresence(kept, kept), false);
  assert.equal(presenceOf({ clientId: 'other', eventType: 'connected' }, NOW), null);
  assert.equal(presenceOf({ clientId: THING, eventType: 'subscribed' }, NOW), null);
  assert.equal(presenceOf({ clientId: THING, eventType: 'connected', timestamp: 'soon' }, NOW).at, NOW);
});

test('at most one e-mail per board and kind an hour: the rest are folded, at most 20 and a count', () => {
  let item = emptyBoard(THING);
  const taken = (text, at) => {
    const result = takeAlert(item, { kind: 'stuck', text, at }, at);
    item = result.state;
    return result.mail;
  };
  const first = taken('first', NOW);
  assert.deepEqual(first, { kind: 'stuck', lines: [{ at: NOW, text: 'first' }], more: 0, before: null });
  for (let index = 0; index < 25; index += 1) assert.equal(taken(`folded ${index}`, NOW + (index + 1) * MINUTE), null);
  assert.equal(item.kinds.stuck.folded.length, FOLDED_KEPT);
  assert.equal(item.kinds.stuck.more, 5);
  // Another kind is not held back by this one.
  assert.notEqual(takeAlert(item, { kind: 'update', text: 'u', at: NOW }, NOW + 2 * MINUTE).mail, null);
  // The next one after the hour carries what was folded.
  const next = taken('next', NOW + ALERT_EVERY_MS);
  assert.equal(next.lines.length, FOLDED_KEPT + 1);
  assert.equal(next.lines.at(-1).text, 'next');
  assert.equal(next.more, 5);
  assert.deepEqual(item.kinds.stuck, { sentAt: NOW + ALERT_EVERY_MS, folded: [], more: 0 });
});

test('the e-mail is plain, names the board by its name, and links to the console', () => {
  const item = { ...emptyBoard(THING), name: 'CRVIHAAN01' };
  const mail = { kind: 'offline', lines: [{ at: NOW, text: 'Offline since 2026-11-04 11:44 UTC, for 16 min now' }], more: 0 };
  const { subject, message } = emailOf(item, mail, CONSOLE);
  assert.equal(subject, 'Cranium: CRVIHAAN01 is offline');
  assert.match(message, /^CRVIHAAN01 \(AWS IoT thing cranium-0123456789abcdef\)\n/);
  assert.ok(message.includes('2026-11-04 12:00 UTC  Offline since 2026-11-04 11:44 UTC, for 16 min now'));
  assert.ok(message.includes(`Open it on the console: ${CONSOLE}#/devices/${THING}`));
  assert.ok(message.includes('at most one e-mail an hour about the same board'));
  assert.doesNotMatch(message, /[^\x20-\x7e\n]/);
  // A board with no name is called by its thing name; several alerts say how many.
  const folded = emailOf(emptyBoard(THING), { kind: 'stuck', lines: [mail.lines[0], mail.lines[0]], more: 3 }, CONSOLE);
  assert.equal(folded.subject, `Cranium: ${THING} restarted itself for being stuck (5 alerts)`);
  assert.ok(folded.message.includes('... and 3 more of these, left out.'));
  // A name that is not a plain device ID is never put in an e-mail.
  assert.equal(emailOf({ ...item, name: 'CR"V\n' }, mail, CONSOLE).subject, `Cranium: ${THING} is offline`);
  // Without a console address there is no link at all, rather than a wrong one.
  assert.doesNotMatch(emailOf(item, mail, 'javascript:alert(1)').message, /Open it|javascript/);
  assert.deepEqual([spell(16 * MINUTE), spell(125 * MINUTE), spell(52 * 60 * MINUTE)], ['16 min', '2 h 5 min', '2 d 4 h']);
  assert.equal(utc(NOW), '2026-11-04 12:00 UTC');
});

// The alerter.

test('offline for 15 minutes: the scheduled check sends one e-mail, and "back" when the board connects', async () => {
  const { run, clock, emails, board } = alerter();
  await run.noteName(THING, 'CRVIHAAN01');
  await run.presence(presence('connected', NOW - 2 * 3_600_000, { versionNumber: 2 }));
  await run.presence(presence('disconnected', NOW, { disconnectReason: 'MQTT_KEEP_ALIVE_TIMEOUT' }));
  clock.ms = NOW + 10 * MINUTE;
  assert.equal(await run.check(), 0);
  clock.ms = NOW + OFFLINE_AFTER_MS + MINUTE;
  assert.equal(await run.check(), 1);
  assert.equal(await run.check(), 0);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].subject, 'Cranium: CRVIHAAN01 is offline');
  assert.match(emails[0].message, /Offline since 2026-11-04 12:00 UTC, for 16 min now: the board stopped answering/);
  assert.equal((await board()).offlineAlerted, true);

  clock.ms = NOW + 47 * MINUTE;
  assert.equal(await run.presence(presence('connected', clock.ms, { versionNumber: 4 })), 1);
  assert.equal(emails[1].subject, 'Cranium: CRVIHAAN01 is back online');
  assert.match(emails[1].message, /Connected to AWS IoT again, after 47 min offline/);
  assert.equal((await board()).offlineAlerted, false);
});

test('a board back within 15 minutes, or a disconnect that arrives late, makes no e-mail', async () => {
  const { run, clock, emails } = alerter();
  await run.presence(presence('disconnected', NOW, { versionNumber: 3 }));
  await run.presence(presence('connected', NOW + 20_000, { versionNumber: 4 }));
  // The disconnect of the old connection, arriving after the new one's connect.
  await run.presence(presence('disconnected', NOW + 20_005, { versionNumber: 3 }));
  clock.ms = NOW + 3_600_000;
  assert.equal(await run.check(), 0);
  assert.equal(emails.length, 0);
});

test('what was folded goes out with the scheduled check once its hour is up', async () => {
  const { run, clock, emails } = alerter();
  await run.raise({ kind: 'stuck', thing: THING, text: 'Restarted itself for being stuck: one', at: NOW });
  clock.ms = NOW + 10 * MINUTE;
  await run.raise({ kind: 'stuck', thing: THING, text: 'Restarted itself for being stuck: two', at: clock.ms });
  clock.ms = NOW + 20 * MINUTE;
  await run.raise({ kind: 'stuck', thing: THING, text: 'Restarted itself for being stuck: three', at: clock.ms });
  assert.equal(emails.length, 1);
  clock.ms = NOW + 59 * MINUTE;
  assert.equal(await run.check(), 0);
  clock.ms = NOW + 61 * MINUTE;
  assert.equal(await run.check(), 1);
  assert.equal(emails[1].subject, `Cranium: ${THING} restarted itself for being stuck (2 alerts)`);
  assert.ok(emails[1].message.includes('stuck: two') && emails[1].message.includes('stuck: three'));
  assert.equal(await run.check(), 0);
});

test('an e-mail that cannot be sent is put back and goes with the next check', async () => {
  const { run, clock, emails, logs } = alerter({ failPublish: 1 });
  assert.equal(await run.raise({ kind: 'update', thing: THING, text: 'Update to 1.2.3+5 failed: download_failed', at: NOW }), 0);
  assert.equal(emails.length, 0);
  assert.equal(logs.some((line) => line.event === 'alert_unsent'), true);
  clock.ms = NOW + 5 * MINUTE;
  assert.equal(await run.check(), 1);
  assert.ok(emails[0].message.includes('Update to 1.2.3+5 failed: download_failed'));
});

test('two invocations at once never both send: every change is conditional on the item read', async () => {
  const { run, emails } = alerter();
  const alert = { kind: 'moved', thing: THING, text: 'Moved 1.3 km from where it was, to within 35 m', at: NOW };
  await Promise.all([run.raise(alert), run.raise(alert), run.raise(alert)]);
  assert.equal(emails.length, 1);
});

test('the alerter never throws: a store that fails is logged, and the caller goes on', async () => {
  const logs = [];
  const broken = createAlerter({
    store: { getAlertItem: async () => { throw new Error('Query: InternalServerError'); } },
    consoleUrl: CONSOLE, now: () => NOW, log: (line) => logs.push(line),
  });
  assert.equal(await broken.raise({ kind: 'stuck', thing: THING, text: 'x', at: NOW }), 0);
  assert.equal(await broken.check(), 0);
  assert.deepEqual(logs.map((line) => [line.event, line.what]), [['alert_failed', 'stuck'], ['alert_failed', 'check']]);
});

// The recorder.

test('the recorder hands presence, names and events to the alerter, and the scheduled check to it alone', async () => {
  const clock = { ms: NOW };
  const fake = createFakeAws({ now: () => clock.ms });
  const told = [];
  const recorder = createRecorder({
    store: fake.eventStore(),
    alerts: { afterRecord: async (message, items) => told.push([message, items]), check: async () => 2 },
    now: () => clock.ms,
    randomHex: () => 'abcdef',
    log: () => {},
  });
  const scheduled = { version: '0', id: 'x', 'detail-type': 'Scheduled Event', source: 'aws.events', detail: {} };
  assert.equal(isScheduledCheck(scheduled), true);
  assert.deepEqual(await recorder(scheduled), { recorded: 0, alerts: 2 });
  // A board's own line can carry the same fields, and is still only a line.
  const line = { t: 1, seq: 1, boot: 1, up: 2, tag: 'app', text: 'hello', thing: THING, received: NOW, ...scheduled };
  assert.deepEqual(await recorder(line), { recorded: 1 });
  await recorder(presence('disconnected', NOW));
  assert.equal(told.length, 1);
  assert.equal(told[0][1][0].kind, 'connection');
  // Without an alerter the recorder records as before.
  const plain = createRecorder({ store: fake.eventStore(), now: () => clock.ms, log: () => {} });
  assert.deepEqual(await plain(scheduled), { recorded: 0, alerts: 0 });
});

test('end to end on the stand-in: a restart for being stuck makes an e-mail, and so does an update that failed', async () => {
  const clock = { ms: NOW };
  const fake = createFakeAws({ now: () => clock.ms });
  fake.enableAlerts(CONSOLE);
  fake.addThing(THING);
  const device = fake.device(THING);
  device.report({ fw: { version: '1.12.0+0', confirmed: true }, uptime: 500, stuck: { count: 0, reason: 'none' },
    diag: { id: 'CRVIHAAN01' } });
  clock.ms += 1000;
  device.report({ uptime: 5, stuck: { count: 1, reason: 'wifi_silent' } });
  clock.ms += 1000;
  device.report({ ota: { state: 'downloading', job: 'cranium-1-2-3-b5-20261104T110000Z-0a0a', progress: 40, last: 'none', error: '' } });
  clock.ms += 1000;
  device.report({ ota: { state: 'idle', progress: 0, last: 'failed', error: 'download_failed' } });
  await fake.alertsSettled();
  assert.deepEqual(fake.alertEmails.map((mail) => mail.subject), [
    'Cranium: CRVIHAAN01 restarted itself for being stuck',
    'Cranium: An update did not go through on CRVIHAAN01',
  ]);
  assert.match(fake.alertEmails[1].message, /Update to 1\.2\.3\+5 failed: download_failed/);
});

// The Account page's routes.

function accountWorld() {
  const console_ = createTestConsole({ startMs: NOW });
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  return { ...console_, manager, viewer };
}

test('a release manager subscribes their own address, confirms it by e-mail, and unsubscribes, each on record', async () => {
  const { call, manager, fake } = accountWorld();
  const before = await call('GET', '/api/alerts', { as: manager });
  assert.equal(before.status, 200);
  assert.deepEqual([before.body.email, before.body.subscription, before.body.canSubscribe, before.body.subscribers],
    [manager.email, 'none', true, 0]);
  assert.deepEqual(before.body.rules, { offlineMinutes: 15, everyMinutes: 60, movedMetres: 1000 });

  const made = await call('POST', '/api/alerts/subscribe', { as: manager, body: {} });
  assert.deepEqual([made.status, made.body], [202, { subscription: 'pending' }]);
  assert.equal((await call('GET', '/api/alerts', { as: manager })).body.subscription, 'pending');
  // Waiting for the confirmation, there is nothing to remove yet.
  const early = await call('POST', '/api/alerts/unsubscribe', { as: manager, body: {} });
  assert.deepEqual([early.status, early.body.error.code], [409, 'not_confirmed']);

  fake.confirmSubscription(manager.email);
  const confirmed = await call('GET', '/api/alerts', { as: manager });
  assert.deepEqual([confirmed.body.subscription, confirmed.body.subscribers], ['confirmed', 1]);
  const again = await call('POST', '/api/alerts/subscribe', { as: manager, body: {} });
  assert.deepEqual([again.status, again.body.error.code], [409, 'already_subscribed']);

  const removed = await call('POST', '/api/alerts/unsubscribe', { as: manager, body: {} });
  assert.deepEqual([removed.status, removed.body], [200, { subscription: 'none' }]);
  const gone = await call('POST', '/api/alerts/unsubscribe', { as: manager, body: {} });
  assert.deepEqual([gone.status, gone.body.error.code], [404, 'not_subscribed']);

  const entries = fake.auditLog().filter((entry) => entry.action.startsWith('alert.'));
  assert.deepEqual(entries.map((entry) => [entry.action, entry.outcome, entry.target, entry.detail.code ?? entry.detail.subscription]), [
    ['alert.subscribe', 'ok', manager.email, 'pending'],
    ['alert.unsubscribe', 'rejected', manager.email, 'not_confirmed'],
    ['alert.subscribe', 'rejected', manager.email, 'already_subscribed'],
    ['alert.unsubscribe', 'ok', manager.email, undefined],
    ['alert.unsubscribe', 'rejected', manager.email, 'not_subscribed'],
  ]);
});

test('only release managers subscribe, only their own address, and at most 3 times an hour', async () => {
  const { call, manager, viewer, fake, advance } = accountWorld();
  const seen = await call('GET', '/api/alerts', { as: viewer });
  assert.deepEqual([seen.status, seen.body.canSubscribe], [200, false]);
  const refused = await call('POST', '/api/alerts/subscribe', { as: viewer, body: {} });
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'release_manager_required']);
  // Somebody else's address is not something the request can even say.
  const other = await call('POST', '/api/alerts/subscribe', { as: manager, body: { email: 'someone@example.invalid' } });
  assert.deepEqual([other.status, other.body.error.code], [400, 'unexpected_field']);
  for (let index = 0; index < 3; index += 1) assert.equal((await call('POST', '/api/alerts/subscribe', { as: manager, body: {} })).status, 202);
  const fourth = await call('POST', '/api/alerts/subscribe', { as: manager, body: {} });
  assert.deepEqual([fourth.status, fourth.body.error.code], [429, 'rate_limited']);
  advance(61 * MINUTE);
  assert.equal((await call('POST', '/api/alerts/subscribe', { as: manager, body: {} })).status, 202);
  assert.deepEqual((await fake.listAlertSubscriptions()).map((entry) => entry.endpoint), [manager.email]);
});

test('the Account page lists the e-mails that went out, newest first', async () => {
  const { call, viewer, fake, clock } = accountWorld();
  fake.enableAlerts(CONSOLE);
  fake.addThing(THING);
  fake.device(THING).disconnect('CONNECTION_LOST');
  clock.ms += OFFLINE_AFTER_MS + MINUTE;
  await fake.alertsSettled();
  assert.equal(await fake.checkAlerts(), 1);
  const page = await call('GET', '/api/alerts', { as: viewer });
  assert.deepEqual(page.body.recent, [{
    at: new Date(clock.ms).toISOString(), kind: 'offline', subject: `Cranium: ${THING} is offline`, count: 1, thing: THING,
  }]);
  assert.equal(sentFromItem({ sk: 'S#bad', kind: 'offline', subject: 'x' }), null);
  // The stand-in's e-mail says the same as the console.
  assert.equal(fake.alertEmails[0].subject, page.body.recent[0].subject);
  assert.equal(applyPresence(emptyBoard(THING), presenceOf(presence('connected', NOW), NOW)).alert, null);
});
