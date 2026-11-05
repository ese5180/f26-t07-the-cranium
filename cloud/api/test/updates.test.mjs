// Tests for the update history: the facts the boards' reports make (src/lib/updates.mjs), the records
// they and the job executions fold into, the backfill from what the events table already holds, and
// the routes that read it (GET /api/updates, the last update of GET /api/devices/{thing}, the counts
// of GET /api/fleet/health), in src/handlers/updates.mjs.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { eventKey } from '../src/lib/events.mjs';
import { lineKey } from '../src/lib/lines.mjs';
import {
  BACKFILL_KEY, CHECK_BEFORE_MS, decodeUpdateCursor, encodeUpdateCursor, factFromItem, factsFromItems, foldUpdates,
  personName, pickCheck, presentUpdate, updateCounts,
} from '../src/lib/updates.mjs';
import { createRecorder } from '../src/recorder.mjs';
import { createFakeAws, createTestConsole, fixture } from './fake-aws.mjs';

const THING = 'cranium-0123456789abcdef';
const OTHER = 'cranium-fedcba9876543210';
const NOW = Date.UTC(2026, 10, 5, 20, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const JOB = 'cranium-1-12-0-b0-20261104T150000Z-ab12';
const IMAGE = fixture('valid-1.2.3+4.signed.bin');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// What firmware 1.12.0 and later prints on its console for an update over Bluetooth (bt_ota.c).
const arrived = (to) => `firmware ${to} has arrived, hash 0123456789abcdef: press Button 1 to install it, Button 2 to erase it`;
const onTrial = (to, from, count) => `on trial: ${to} from ${from}, pending, proof none, update ${count} of this board`;
const done = (to, from, result, proof, count, what = 'update over Bluetooth') =>
  `${what}: ${to} from ${from}, ${result}, proof ${proof}, update ${count} of this board`;

/** An item of the events table as the recorder stores it. */
function event(thing, atMs, fields, random = '00000a') {
  return { pk: thing, sk: eventKey(atMs, random), level: 'info', text: 'Something', ttl: Math.floor(atMs / 1000) + 90 * 86_400, ...fields };
}

function lineItem(thing, atMs, text, seq, boot = 7) {
  return {
    pk: thing, sk: lineKey(atMs, boot, seq), kind: 'bluetooth', what: 'line', level: 'info', tag: 'BT', text, boot, seq,
    ttl: Math.floor(atMs / 1000) + 90 * 86_400,
  };
}

/**
 * What this board's table held on 2026-11-05: 1.11.4 over Bluetooth from 1.11.3 (firmware of before the
 * board log, so the shadow's events only), 1.12.0 by deployment, then 1.13.0 and 1.14.0 over Bluetooth
 * from the iPhone app, each kept once it reached the cloud.
 */
function history(thing = THING) {
  const at = (iso) => Date.parse(iso);
  return [
    // 1.11.4 over Bluetooth, from the shadow: the record, the version, its confirmation.
    event(thing, at('2026-11-02T18:00:05.000Z'), { kind: 'bluetooth', what: 'record', from: '1.11.3+0', to: '1.11.4+0', result: 'pending', proof: 'none', count: 3 }),
    event(thing, at('2026-11-02T18:00:05.001Z'), { kind: 'firmware', what: 'changed', version: '1.11.4+0', from: '1.11.3+0', confirmed: false }, '00000b'),
    event(thing, at('2026-11-02T18:04:10.000Z'), { kind: 'bluetooth', what: 'record', from: '1.11.3+0', to: '1.11.4+0', result: 'succeeded', proof: 'cloud', count: 3 }),
    event(thing, at('2026-11-02T18:04:10.001Z'), { kind: 'firmware', what: 'confirmed', version: '1.11.4+0', confirmed: true }, '00000c'),
    // 1.12.0 by deployment: the board's report of its trial names the job.
    event(thing, at('2026-11-04T15:06:00.000Z'), { kind: 'firmware', what: 'changed', version: '1.12.0+0', from: '1.11.4+0', confirmed: false }),
    event(thing, at('2026-11-04T15:06:00.001Z'), { kind: 'update', what: 'step', state: 'testing', progress: 100, job: JOB }, '00000d'),
    event(thing, at('2026-11-04T15:07:30.000Z'), { kind: 'update', what: 'result', result: 'succeeded', job: JOB }),
    event(thing, at('2026-11-04T15:07:30.001Z'), { kind: 'firmware', what: 'confirmed', version: '1.12.0+0', confirmed: true }, '00000e'),
    // 1.13.0 over Bluetooth, 17:14: the image arrives, the board restarts into it on trial and keeps it.
    lineItem(thing, at('2026-11-05T17:12:40.000Z'), arrived('1.13.0+0'), 40, 7),
    lineItem(thing, at('2026-11-05T17:14:02.000Z'), onTrial('1.13.0+0', '1.12.0+0', 4), 3, 8),
    event(thing, at('2026-11-05T17:14:20.000Z'), { kind: 'firmware', what: 'changed', version: '1.13.0+0', from: '1.12.0+0', confirmed: false }),
    event(thing, at('2026-11-05T17:14:21.000Z'), { kind: 'bluetooth', what: 'record', from: '1.12.0+0', to: '1.13.0+0', result: 'pending', proof: 'none', count: 4 }),
    lineItem(thing, at('2026-11-05T17:15:05.000Z'), done('1.13.0+0', '1.12.0+0', 'succeeded', 'cloud', 4), 9, 8),
    event(thing, at('2026-11-05T17:15:06.000Z'), { kind: 'firmware', what: 'confirmed', version: '1.13.0+0', confirmed: true }),
    // 1.14.0 over Bluetooth, 19:30 to 19:32, the same way; the next boot says the record again.
    lineItem(thing, at('2026-11-05T19:30:30.000Z'), arrived('1.14.0+0'), 30, 8),
    lineItem(thing, at('2026-11-05T19:31:50.000Z'), onTrial('1.14.0+0', '1.13.0+0', 5), 3, 9),
    event(thing, at('2026-11-05T19:32:00.000Z'), { kind: 'firmware', what: 'changed', version: '1.14.0+0', from: '1.13.0+0', confirmed: false }),
    lineItem(thing, at('2026-11-05T19:32:41.000Z'), done('1.14.0+0', '1.13.0+0', 'succeeded', 'cloud', 5), 8, 9),
    event(thing, at('2026-11-05T19:32:42.000Z'), { kind: 'firmware', what: 'confirmed', version: '1.14.0+0', confirmed: true }),
    lineItem(thing, at('2026-11-05T19:45:00.000Z'), done('1.14.0+0', '1.13.0+0', 'succeeded', 'cloud', 5, 'last update over Bluetooth'), 2, 10),
    // Lines that say nothing of an update, and events of other kinds.
    lineItem(thing, at('2026-11-05T19:30:00.000Z'), 'a phone connected', 29, 8),
    event(thing, at('2026-11-05T19:33:00.000Z'), { kind: 'connection', what: 'connected' }),
  ];
}

/** The executions AWS IoT Jobs lists for the board: the 1.12.0 deployment. */
const EXECUTIONS = [{
  jobId: JOB, status: 'SUCCEEDED', queuedAt: Date.parse('2026-11-04T15:00:01Z'), startedAt: Date.parse('2026-11-04T15:00:30Z'),
  lastUpdatedAt: Date.parse('2026-11-04T15:07:31Z'),
}];

const factsOf = (items) => factsFromItems(items).map(factFromItem);
const brief = (record) => [record.how, record.from, record.to, record.outcome];

// Facts.

test('the reports of an update become facts, one for each thing said, the same keys from events and lines', () => {
  const facts = factsFromItems(history());
  assert.ok(facts.every((item) => item.pk === `UPD#${THING}` && Number.isSafeInteger(item.at) && item.ttl === undefined));
  assert.deepEqual(facts.map((item) => item.sk).sort(), [
    'A#2026-11-05T17:12:40.000Z#7.40', 'A#2026-11-05T19:30:30.000Z#8.30',
    'B#3#1.11.3+0#1.11.4+0#pending', 'B#3#1.11.3+0#1.11.4+0#succeeded',
    // The shadow's record and the line "on trial" are the same fact: one key.
    'B#4#1.12.0+0#1.13.0+0#pending', 'B#4#1.12.0+0#1.13.0+0#pending', 'B#4#1.12.0+0#1.13.0+0#succeeded',
    'B#5#1.13.0+0#1.14.0+0#pending',
    // "update over Bluetooth" and the next boot's "last update over Bluetooth": one key.
    'B#5#1.13.0+0#1.14.0+0#succeeded', 'B#5#1.13.0+0#1.14.0+0#succeeded',
    'C#2026-11-02T18:04:10.001Z', 'C#2026-11-04T15:07:30.001Z', 'C#2026-11-05T17:15:06.000Z', 'C#2026-11-05T19:32:42.000Z',
    `R#${JOB}#succeeded`,
    'V#2026-11-02T18:00:05.001Z', 'V#2026-11-04T15:06:00.000Z', 'V#2026-11-05T17:14:20.000Z', 'V#2026-11-05T19:32:00.000Z',
  ]);
  // The version change of the deployment carries the job its report named.
  assert.equal(facts.find((item) => item.sk === 'V#2026-11-04T15:06:00.000Z').job, JOB);
  assert.equal(facts.find((item) => item.sk === 'V#2026-11-05T17:14:20.000Z').job, undefined);
  const trial = facts.find((item) => item.sk.startsWith('B#5') && item.result === 'pending');
  assert.deepEqual([trial.from, trial.to, trial.proof, trial.count, trial.at], ['1.13.0+0', '1.14.0+0', 'none', 5, Date.parse('2026-11-05T19:31:50Z')]);
});

test('a line or an event that is not what the firmware says makes no fact', () => {
  const at = Date.parse('2026-11-05T12:00:00Z');
  for (const text of [
    'on trial: 1.13.0 from 1.12.0+0, pending, proof none, update 4 of this board',
    'on trial: 1.13.0+0 from 1.12.0+0, exploded, proof none, update 4 of this board',
    'on trial: 1.13.0+0 from 1.12.0+0, pending, proof maybe, update 4 of this board',
    'update over Bluetooth: 1.13.0+0 from 1.12.0+0, succeeded, proof cloud, update 4 of this board, really',
    'firmware 1.13.0+0 has arrived, hash 0123: press Button 1',
    'refused an upload: it is for nrf5340dk, and this board is nrf7002dk',
  ]) {
    assert.deepEqual(factsFromItems([lineItem(THING, at, text, 1)]), [], text);
  }
  // A line of another source, and an event of another kind, say nothing of an update either.
  assert.deepEqual(factsFromItems([{ ...lineItem(THING, at, onTrial('1.13.0+0', '1.12.0+0', 4), 1), tag: 'app', kind: 'log' }]), []);
  assert.deepEqual(factsFromItems([event(THING, at, { kind: 'firmware', what: 'reported', version: '1.13.0+0', confirmed: true })]), []);
  // A fact read back is checked again.
  const [good] = factsFromItems([lineItem(THING, at, onTrial('1.13.0+0', '1.12.0+0', 4), 1)]);
  assert.equal(factFromItem({ ...good, pk: THING }), null);
  assert.equal(factFromItem({ ...good, at: 'soon' }), null);
  assert.equal(factFromItem({ ...good, result: 'exploded' }), null);
  assert.equal(factFromItem({ ...good, fact: 'version' }), null);
  assert.deepEqual(factFromItem(good), { thing: THING, sk: good.sk, fact: 'bluetooth', at, from: '1.12.0+0', to: '1.13.0+0', result: 'pending', count: 4, proof: 'none' });
});

// Records.

test('the board\'s history folds into one record per update: Bluetooth, the deployment, Bluetooth again', () => {
  const records = foldUpdates({ thing: THING, facts: factsOf(history()), executions: EXECUTIONS, nowMs: NOW });
  assert.deepEqual(records.map(brief), [
    ['bluetooth', '1.13.0+0', '1.14.0+0', 'kept'],
    ['bluetooth', '1.12.0+0', '1.13.0+0', 'kept'],
    ['deployment', '1.11.4+0', '1.12.0+0', 'kept'],
    ['bluetooth', '1.11.3+0', '1.11.4+0', 'kept'],
  ]);
  const [newest, second, deployment, oldest] = records.map(presentUpdate);
  // From the image's arrival to the board's word that the cloud proved it.
  assert.deepEqual([newest.startedAt, newest.endedAt], ['2026-11-05T19:30:30.000Z', '2026-11-05T19:32:41.000Z']);
  assert.deepEqual([second.startedAt, second.endedAt], ['2026-11-05T17:12:40.000Z', '2026-11-05T17:15:05.000Z']);
  assert.deepEqual(deployment, {
    id: `deployment:${THING}:${JOB}`, thing: THING, from: '1.11.4+0', to: '1.12.0+0', how: 'deployment', deployment: JOB, who: null,
    outcome: 'kept', startedAt: '2026-11-04T15:00:30.000Z', endedAt: '2026-11-04T15:07:31.000Z', status: 'SUCCEEDED',
  });
  // Before the board log: the shadow's record is all there is, from its first report of it.
  assert.deepEqual([oldest.startedAt, oldest.endedAt], ['2026-11-02T18:00:05.000Z', '2026-11-02T18:04:10.000Z']);
  assert.deepEqual(new Set(records.map((record) => record.id)).size, 4);
});

test('the same update said twice, or by the shadow and the log both, is one record', () => {
  const items = history();
  const twice = [...items, ...items.map((item) => ({ ...item }))];
  const once = foldUpdates({ thing: THING, facts: factsOf(items), executions: EXECUTIONS, nowMs: NOW });
  const again = foldUpdates({ thing: THING, facts: factsOf(twice), executions: EXECUTIONS, nowMs: NOW });
  assert.deepEqual(again.map(presentUpdate), once.map(presentUpdate));
});

test('a rollback, an update that was not installed, a USB flash and a job AWS no longer lists', () => {
  const at = (minutes) => Date.parse('2026-11-05T10:00:00Z') + minutes * MINUTE;
  const items = [
    // Over Bluetooth to 1.13.0, on trial, and back to 1.12.0 when the trial was lost.
    lineItem(THING, at(0), onTrial('1.13.0+0', '1.12.0+0', 6), 1),
    event(THING, at(1), { kind: 'firmware', what: 'changed', version: '1.13.0+0', from: '1.12.0+0', confirmed: false }),
    event(THING, at(8), { kind: 'firmware', what: 'changed', version: '1.12.0+0', from: '1.13.0+0', confirmed: true }),
    lineItem(THING, at(8), done('1.13.0+0', '1.12.0+0', 'trial_lost', 'none', 6), 2),
    // An image that arrived and was erased.
    lineItem(THING, at(20), done('1.13.0+0', '1.12.0+0', 'not_installed', 'none', 7), 3),
    // Flashed by USB, confirmed as it was written.
    event(THING, at(30), { kind: 'firmware', what: 'changed', version: '1.13.1+0', from: '1.12.0+0', confirmed: true }),
    // A job of this console that AWS IoT no longer lists, still on trial.
    event(THING, at(40), { kind: 'firmware', what: 'changed', version: '1.13.2+0', from: '1.13.1+0', confirmed: false }),
    event(THING, at(40) + 1, { kind: 'update', what: 'step', state: 'testing', progress: 100, job: 'cranium-1-13-2-b0-20261105T103900Z-cd34' }, '00000f'),
    // By USB again, on trial, and it went back by itself.
    event(THING, at(50), { kind: 'firmware', what: 'changed', version: '1.13.3+0', from: '1.13.2+0', confirmed: false }),
    event(THING, at(55), { kind: 'firmware', what: 'changed', version: '1.13.2+0', from: '1.13.3+0', confirmed: false }),
  ];
  const records = foldUpdates({ thing: THING, facts: factsOf(items), executions: [], nowMs: NOW }).map(presentUpdate);
  assert.deepEqual(records.map((record) => [record.how, record.from, record.to, record.outcome, record.endedAt]), [
    ['usb_or_other', '1.13.2+0', '1.13.3+0', 'rolled_back', new Date(at(55)).toISOString()],
    ['deployment', '1.13.1+0', '1.13.2+0', 'pending', null],
    ['usb_or_other', '1.12.0+0', '1.13.1+0', 'kept', new Date(at(30)).toISOString()],
    ['bluetooth', '1.12.0+0', '1.13.0+0', 'not_installed', new Date(at(20)).toISOString()],
    ['bluetooth', '1.12.0+0', '1.13.0+0', 'rolled_back', new Date(at(8)).toISOString()],
  ]);
  assert.equal(records[1].deployment, 'cranium-1-13-2-b0-20261105T103900Z-cd34');
});

test('a deployment the board rolled back, and one that never reached the board', () => {
  const at = (minutes) => Date.parse('2026-11-05T10:00:00Z') + minutes * MINUTE;
  const job = 'cranium-1-13-0-b0-20261105T095900Z-ef56';
  const executions = [
    { jobId: job, status: 'FAILED', queuedAt: at(-1), startedAt: at(0), lastUpdatedAt: at(9) },
    { jobId: 'cranium-1-13-1-b0-20261105T110000Z-ab78', status: 'CANCELED', queuedAt: at(60), startedAt: null, lastUpdatedAt: at(61) },
    { jobId: 'some-other-tool', status: 'SUCCEEDED', queuedAt: at(120), startedAt: at(121), lastUpdatedAt: at(125) },
  ];
  const items = [
    event(THING, at(4), { kind: 'firmware', what: 'changed', version: '1.13.0+0', from: '1.12.0+0', confirmed: false }),
    event(THING, at(4) + 1, { kind: 'update', what: 'step', state: 'testing', progress: 100, job }, '00000f'),
    event(THING, at(8), { kind: 'firmware', what: 'changed', version: '1.12.0+0', from: '1.13.0+0', confirmed: true }),
  ];
  const records = foldUpdates({ thing: THING, facts: factsOf(items), executions, nowMs: NOW }).map(presentUpdate);
  assert.deepEqual(records.map((record) => [record.deployment, record.from, record.to, record.outcome, record.status]), [
    ['some-other-tool', null, null, 'kept', 'SUCCEEDED'],
    ['cranium-1-13-1-b0-20261105T110000Z-ab78', null, '1.13.1+0', 'not_installed', 'CANCELED'],
    [job, '1.12.0+0', '1.13.0+0', 'rolled_back', 'FAILED'],
  ]);
  // Only the updates that are not deployments are counted from the history: those are counted from the jobs.
  const counted = updateCounts(foldUpdates({ thing: THING, facts: factsOf(history()), executions: EXECUTIONS, nowMs: NOW }),
    { sinceMs: NOW - 7 * DAY });
  assert.deepEqual(counted, { succeeded: 3, failed: 0, rolledBack: 0 });
});

test('who sent an update over Bluetooth is whoever\'s phone checked the image for that board and version just before', () => {
  const [record] = foldUpdates({ thing: THING, facts: factsOf(history()), executions: [], nowMs: NOW });
  const entry = (minutesBefore, changes = {}) => ({
    at: new Date(Date.parse('2026-11-05T19:30:30Z') - minutesBefore * MINUTE).toISOString(),
    actor: { sub: 's-1', email: 'vihaan.ravishankar@example.invalid' }, action: 'firmware.bluetooth_send', target: '1.14.0+0',
    outcome: 'ok', detail: { sha256: 'a'.repeat(64), thing: THING }, ...changes,
  });
  assert.equal(pickCheck(record, [entry(3)]).at, entry(3).at);
  // The latest of those for this board, before one that names no board.
  assert.equal(pickCheck(record, [entry(20), entry(3, { detail: {} }), entry(5)]).at, entry(5).at);
  assert.equal(pickCheck(record, [entry(3, { detail: {} })]).at, entry(3).at);
  // Not another board's, another version's, a refused one, another action, or one out of its window.
  for (const other of [
    entry(3, { detail: { thing: OTHER } }), entry(3, { target: '1.13.0+0' }), entry(3, { outcome: 'rejected' }),
    entry(3, { action: 'firmware.download' }), entry(CHECK_BEFORE_MS / MINUTE + 1), entry(-11),
  ]) {
    assert.equal(pickCheck(record, [other]), null, JSON.stringify(other));
  }
  assert.deepEqual(['vihaan.ravishankar@x.invalid', 'adam@x.invalid', 'j_smith+cranium@x.invalid', '..@x', '', null]
    .map(personName), ['Vihaan', 'Adam', 'J', '', '', '']);
});

test('a page cursor is opaque, and only a cursor of this list is taken back', () => {
  const [record] = foldUpdates({ thing: THING, facts: factsOf(history()), executions: [], nowMs: NOW });
  const cursor = encodeUpdateCursor(record);
  assert.deepEqual(decodeUpdateCursor(cursor), { sortAt: record.sortAt, id: record.id });
  for (const text of ['', 'not a cursor', Buffer.from('2026-11-05T19:30:30.000Z|nobody').toString('base64url'),
    Buffer.from(`soon|${record.id}`).toString('base64url'), `${cursor}=`]) {
    assert.equal(decodeUpdateCursor(text), null, text);
  }
});

// The recorder.

test('the recorder puts each fact once, keeps the first time it was said, and puts a document\'s facts first', async () => {
  let ms = NOW;
  const fake = createFakeAws({ now: () => ms });
  const recorder = createRecorder({ store: fake.eventStore(), now: () => ms, log: () => {}, randomHex: () => 'abcdef' });
  const message = (text, seq, received) => ({ t: 1000, seq, boot: 9, up: 1000, tag: 'BT', text, thing: THING, received });
  await recorder(message(done('1.14.0+0', '1.13.0+0', 'succeeded', 'cloud', 5), 8, ms));
  // Lambda's retry, then the next boot's "last update", a while later.
  await recorder(message(done('1.14.0+0', '1.13.0+0', 'succeeded', 'cloud', 5), 8, ms));
  ms += HOUR;
  await recorder(message(done('1.14.0+0', '1.13.0+0', 'succeeded', 'cloud', 5, 'last update over Bluetooth'), 2, ms));
  const facts = fake.updateFacts(THING);
  assert.deepEqual(facts.map((item) => [item.sk, item.at]), [['B#5#1.13.0+0#1.14.0+0#succeeded', NOW]]);

  fake.calls.length = 0;
  const reported = (version, confirmed) => ({ state: { reported: { fw: { version, confirmed }, uptime: 60 } } });
  await recorder({ previous: reported('1.13.0+0', true), current: { ...reported('1.14.0+0', false), version: 7 }, timestamp: Math.floor(ms / 1000), thing: THING });
  assert.deepEqual(fake.methodsCalled(), ['putUpdateFact', 'putEvent', 'putEvent']);
  assert.equal(fake.updateFacts(THING).filter((item) => item.fact === 'version').length, 1);
});

// The routes.

function setup() {
  const console_ = createTestConsole({ startMs: NOW - 4 * DAY });
  const manager = console_.addUser('vihaan.ravishankar', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  console_.fake.addThing(THING);
  console_.fake.addThing(OTHER);
  const get = (path, query, as = viewer) => console_.call('GET', path, { as, query });
  return { ...console_, manager, viewer, get };
}

test('GET /api/updates: the backfill makes the board\'s history from what the table held, once', async () => {
  const context = setup();
  const { fake } = context;
  context.clock.ms = NOW;
  // As the recorder before 2.1.1 left it: events and lines, and no fact.
  for (const item of history()) fake.putEventItem(item);
  fake.device(THING).setRaw({ state: { reported: { fw: { version: '1.14.0+0', confirmed: true } } } });

  const { status, body } = await context.get('/api/updates');
  assert.equal(status, 200);
  assert.deepEqual(body.updates.map((update) => [update.thing, update.how, update.to, update.outcome]), [
    [THING, 'bluetooth', '1.14.0+0', 'kept'],
    [THING, 'bluetooth', '1.13.0+0', 'kept'],
    // The deployment of 1.12.0 is the board's report alone here: AWS IoT lists no job for it.
    [THING, 'deployment', '1.12.0+0', 'kept'],
    [THING, 'bluetooth', '1.11.4+0', 'kept'],
  ]);
  assert.equal(body.cursor, null);
  assert.equal(body.generatedAt, new Date(NOW).toISOString());
  const stored = fake.updateFacts(THING);
  assert.equal(stored.find((item) => item.sk === BACKFILL_KEY).facts, stored.length - 1);
  assert.equal(stored.find((item) => item.sk === BACKFILL_KEY).oldest, Date.parse('2026-11-02T18:00:05.000Z'));
  // The other board has nothing, and is backfilled with nothing.
  assert.deepEqual(fake.updateFacts(OTHER).map((item) => item.sk), [BACKFILL_KEY]);

  // A second read, after the list's moment in memory: the facts, and no backfill again.
  context.advance(10_000);
  fake.calls.length = 0;
  const again = await context.get('/api/updates');
  assert.deepEqual(again.body.updates, body.updates);
  assert.equal(fake.methodsCalled().includes('queryEvents'), false);
  assert.equal(fake.methodsCalled().filter((method) => method === 'putUpdateFact').length, 0);
});

test('a backfill that cannot be written is shown all the same, and tried again later', async () => {
  const context = setup();
  const { fake } = context;
  context.clock.ms = NOW;
  for (const item of history()) fake.putEventItem(item);
  fake.failNext('putUpdateFact', { times: 1, awsName: 'AccessDeniedException' });
  const first = await context.get('/api/updates', { thing: THING });
  assert.deepEqual(first.body.updates.map((update) => update.to), ['1.14.0+0', '1.13.0+0', '1.12.0+0', '1.11.4+0']);
  assert.ok(context.logs.some((line) => line.event === 'updates_backfill_unwritten'));
  assert.equal(fake.updateFacts(THING).some((item) => item.sk === BACKFILL_KEY), false);
  // Within ten minutes the facts it made serve; after that it is tried again, and written.
  context.advance(60_000);
  fake.calls.length = 0;
  assert.deepEqual((await context.get('/api/updates', { thing: THING })).body.updates, first.body.updates);
  assert.equal(fake.methodsCalled().includes('queryEvents'), false);
  context.advance(10 * MINUTE);
  await context.get('/api/updates', { thing: THING });
  assert.equal(fake.updateFacts(THING).some((item) => item.sk === BACKFILL_KEY), true);
});

test('GET /api/updates: a deployment and an update over Bluetooth, with who started each', async () => {
  const context = setup();
  const { fake, manager, call } = context;
  const uploaded = await call('POST', '/api/firmware', {
    as: manager, body: { filename: 'zephyr.signed.bin', data: IMAGE.toString('base64'), notes: '' },
  });
  assert.equal(uploaded.status, 201);
  // OTHER is offered 1.2.3+4 by a deployment and takes it.
  fake.device(OTHER).report({ fw: { version: '1.2.3+3', confirmed: true }, ota: { state: 'idle', progress: 0, last: 'none', error: '' } });
  const created = await call('POST', '/api/deployments', { as: manager, body: { version: '1.2.3+4', things: [OTHER] } });
  assert.equal(created.status, 201);
  const job = created.body.deployment.id;
  context.advance(MINUTE);
  fake.execution(job, OTHER).update('IN_PROGRESS', { step: 'downloading' });
  fake.device(OTHER).report({ fw: { version: '1.2.3+4', confirmed: false }, ota: { state: 'testing', job, progress: 100, last: 'none', error: '' } });
  context.advance(MINUTE);
  fake.execution(job, OTHER).update('SUCCEEDED', { running: '1.2.3+4' });
  fake.device(OTHER).report({ fw: { version: '1.2.3+4', confirmed: true }, ota: { state: 'idle', progress: 0, last: 'succeeded', error: '' } });

  // THING takes it over Bluetooth from the manager's phone, which checked the image just before.
  fake.device(THING).report({ fw: { version: '1.2.3+3', confirmed: true } });
  context.advance(HOUR);
  const checkedAt = new Date(context.clock.ms).toISOString();
  const check = await call('POST', '/api/firmware/1.2.3+4/bluetooth', { as: manager, body: { sha256: sha256(IMAGE), thing: THING } });
  assert.equal(check.status, 200);
  context.advance(2 * MINUTE);
  fake.device(THING).log('BT', arrived('1.2.3+4'));
  context.advance(MINUTE);
  fake.device(THING).log('BT', onTrial('1.2.3+4', '1.2.3+3', 1), { boot: 2, seq: 1 });
  fake.device(THING).report({ fw: { version: '1.2.3+4', confirmed: false }, uptime: 30 });
  context.advance(MINUTE);
  fake.device(THING).log('BT', done('1.2.3+4', '1.2.3+3', 'succeeded', 'cloud', 1));
  const endedAt = new Date(context.clock.ms).toISOString();
  fake.device(THING).report({ fw: { version: '1.2.3+4', confirmed: true } });

  const { body } = await context.get('/api/updates');
  const [viaPhone, deployed] = body.updates;
  const who = { sub: manager.sub, email: manager.email, name: 'Vihaan' };
  assert.deepEqual(viaPhone, {
    id: `bluetooth:${THING}:1:1.2.3+3:1.2.3+4`, thing: THING, from: '1.2.3+3', to: '1.2.3+4', how: 'bluetooth', deployment: null,
    who, outcome: 'kept', startedAt: checkedAt, endedAt, status: null,
  });
  assert.deepEqual([deployed.how, deployed.deployment, deployed.from, deployed.to, deployed.outcome, deployed.status, deployed.who],
    ['deployment', job, '1.2.3+3', '1.2.3+4', 'kept', 'SUCCEEDED', who]);
  assert.equal(body.updates.length, 2);

  // One board's, and its last on its own page.
  const own = await context.get('/api/updates', { thing: THING });
  assert.deepEqual(own.body.updates, [viaPhone]);
  const page = await context.get(`/api/devices/${THING}`);
  assert.deepEqual(page.body.lastUpdate, viaPhone);
  assert.deepEqual((await context.get(`/api/devices/${OTHER}`)).body.lastUpdate, deployed);

  // Fleet health counts both: the deployment as the board reported its job's end, the other from the history.
  const health = await context.get('/api/fleet/health');
  assert.deepEqual(health.body.updates, { days: 7, succeeded: 2, failed: 0, rolledBack: 0 });
});

test('GET /api/updates pages newest first, each update exactly once, and refuses what it cannot answer', async () => {
  const context = setup();
  const { fake } = context;
  context.clock.ms = NOW;
  for (const item of history(THING)) fake.putEventItem(item);
  for (const item of history(OTHER)) fake.putEventItem(item);
  const seen = [];
  let cursor;
  for (let pages = 0; pages < 10; pages += 1) {
    const { status, body } = await context.get('/api/updates', { limit: '3', ...(cursor ? { cursor } : {}) });
    assert.equal(status, 200);
    assert.ok(body.updates.length <= 3);
    seen.push(...body.updates);
    cursor = body.cursor;
    if (cursor === null) break;
  }
  assert.equal(seen.length, 8);
  assert.equal(new Set(seen.map((update) => update.id)).size, 8);
  const times = seen.map((update) => update.startedAt);
  assert.deepEqual(times, [...times].sort().reverse());

  for (const [query, code] of [
    [{ limit: '0' }, 'invalid_limit'], [{ limit: '101' }, 'invalid_limit'], [{ limit: 'ten' }, 'invalid_limit'],
    [{ cursor: 'nope' }, 'invalid_cursor'], [{ thing: 'cranium-00' }, 'invalid_thing'],
  ]) {
    const response = await context.get('/api/updates', query);
    assert.deepEqual([response.status, response.body.error.code], [400, code], JSON.stringify(query));
  }
  const stranger = await context.get('/api/updates', { thing: 'cranium-1111111111111111' });
  assert.deepEqual([stranger.status, stranger.body.error.code], [404, 'unknown_device']);
  // A read: it goes on no record, and needs a member.
  assert.equal(fake.auditLog().length, 0);
  const nobody = await context.call('GET', '/api/updates');
  assert.equal(nobody.status, 401);
});
