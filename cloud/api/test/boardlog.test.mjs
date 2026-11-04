// Tests for the board log: what a line a board publishes on cranium/<thing>/events becomes
// (src/lib/lines.mjs), how the recorder stores it once (src/recorder.mjs), and the route that
// reads it back (GET /api/events/log in src/handlers/events.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EVENT_DAYS } from '../src/lib/events.mjs';
import {
  KIND_OF_TAG, LINE_KINDS, LINE_TEXT_MAX, NEVER_STORED, SAME_LINE_MS, TAGS, cleanLineText, decodeLineCursor,
  isLineMessage, lineFromItem, recordsFromLine,
} from '../src/lib/lines.mjs';
import { createRecorder } from '../src/recorder.mjs';
import { createFakeAws, createTestConsole } from './fake-aws.mjs';

const THING = 'cranium-0123456789abcdef';
const OTHER = 'cranium-fedcba9876543210';
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const RECEIVED = NOW - 400;

/** A line as the rule hands it over. */
const line = (changes = {}) => ({
  t: 61_234, seq: 17, boot: 42, up: 61_240, tag: 'WIFI', text: 'connected ip=10.0.0.7 rssi=-51',
  thing: THING, received: RECEIVED, ...changes,
});
const made = (changes, nowMs = NOW) => recordsFromLine(line(changes), { nowMs });

// What a line becomes.

test('each source has a kind: the existing ones where they fit, setting and log for the rest, never connection', () => {
  assert.deepEqual(Object.keys(KIND_OF_TAG).sort(), [...TAGS].sort());
  const kinds = Object.fromEntries(TAGS.map((tag) => [tag, made({ tag, text: 'something happened' }).items[0].kind]));
  assert.deepEqual(kinds, {
    BT: 'bluetooth', bt_ota: 'bluetooth', ota: 'update', STUCK: 'restart', stuck: 'restart', boot_diary: 'restart',
    WIFI: 'health', net: 'health', health: 'health', CONSOLE: 'setting', factory: 'setting',
    app: 'log', cloud: 'log', identity: 'log', store: 'log', ui: 'log',
  });
  assert.equal(Object.values(kinds).includes('connection'), false);
  assert.deepEqual([...new Set(Object.values(kinds))].sort(), [...LINE_KINDS].sort());
});

test('a line is dated when AWS IoT got it, less the time it waited on the board', () => {
  const [item] = made({ t: 1_000, up: 61_000 }).items;
  // 60 s on the board, then sent: it happened a minute before it arrived.
  assert.equal(item.sk, `L#${new Date(RECEIVED - 60_000).toISOString()}#42.17`);
  assert.equal(item.ttl, Math.floor((RECEIVED - 60_000) / 1000) + EVENT_DAYS * 86_400);
  // A time of arrival that cannot be right is replaced by the recorder's own clock.
  for (const received of [NOW + 10 * 60_000, NOW - 2 * 86_400_000, 'soon', null]) {
    assert.equal(made({ t: 1_000, up: 1_500, received }).items[0].sk, `L#${new Date(NOW - 500).toISOString()}#42.17`, String(received));
  }
});

test('a line is stored with its tag, its numbers and how many lines were lost before it, and a warning is a warning', () => {
  const result = made({ dropped: 3 });
  assert.equal(result.thing, THING);
  const [item] = result.items;
  assert.deepEqual(item, {
    pk: THING, sk: item.sk, kind: 'health', what: 'line', level: 'info', tag: 'WIFI', text: 'connected ip=10.0.0.7 rssi=-51',
    boot: 42, seq: 17, ttl: item.ttl, dropped: 3,
  });
  assert.deepEqual(result.claim, { pk: THING, sk: 'K#42.17', at: Date.parse(item.sk.slice(2, 26)), ttl: item.ttl });
  // No count when nothing was lost.
  assert.equal(Object.hasOwn(made({ dropped: 0 }).items[0], 'dropped'), false);
  assert.equal(Object.hasOwn(made().items[0], 'dropped'), false);
  assert.equal(made({ tag: 'ota', text: 'WRN: Download stalled' }).items[0].level, 'warn');
  assert.equal(made({ tag: 'cloud', text: 'ERR: AWS IoT library could not be initialised: -12' }).items[0].level, 'warn');
  assert.equal(made({ tag: 'STUCK', text: 'restarting reason=no_cloud count=1' }).items[0].level, 'warn');
  assert.equal(made({ tag: 'app', text: 'Network is up' }).items[0].level, 'info');
});

test('nothing the board sends is taken on trust: numbers, ranges, tag, text', () => {
  const ignored = (changes) => made(changes).ignored;
  assert.equal(ignored({ thing: 'not-a-board' }), 'not_a_board');
  assert.equal(ignored({ thing: undefined }), 'not_a_board');
  for (const t of [-1, 1.5, '61234', null, 2 ** 43]) assert.equal(ignored({ t }), 'bad_time', String(t));
  assert.equal(ignored({ t: 70_000, up: 60_000 }), 'bad_time');
  assert.equal(ignored({ up: undefined }), 'bad_time');
  for (const seq of [0, -1, 2 ** 32, 1.5, '17']) assert.equal(ignored({ seq }), 'bad_count', String(seq));
  for (const boot of [-1, 2 ** 32, '42', null]) assert.equal(ignored({ boot }), 'bad_count', String(boot));
  for (const dropped of [-1, 2 ** 32, '3']) assert.equal(ignored({ dropped }), 'bad_count', String(dropped));
  for (const tag of ['wifi', 'zephyr', 'mqtt', '', 'BT ', null, ['BT']]) assert.equal(ignored({ tag }), 'unknown_tag', String(tag));
  for (const text of [17, null, { a: 1 }, 'x'.repeat(1025)]) assert.equal(ignored({ text }), 'bad_text', String(text).slice(0, 20));
  // Fields the rule does not know are left behind; a line stays a line whatever else it carries.
  const extra = made({ eventType: 'connected', clientId: OTHER, current: { state: {} }, kind: 'connection', what: 'connected' });
  assert.equal(extra.items[0].kind, 'health');
  assert.equal(extra.items[0].pk, THING);
  assert.equal(JSON.stringify(extra).includes(OTHER), false);
  assert.equal(isLineMessage(line()), true);
  assert.equal(isLineMessage({ eventType: 'connected', clientId: THING }), false);
});

test('the text is made printable and cut to 160 characters, as the board makes it', () => {
  assert.equal(cleanLineText('app', 'tab\there\u0000 é ✓\u001b[1m').text, 'tab?here? ? ??[1m');
  const long = cleanLineText('app', 'x'.repeat(400)).text;
  assert.equal(long.length, LINE_TEXT_MAX);
  assert.ok(long.endsWith('...'));
  assert.equal(cleanLineText('app', 'y'.repeat(160)).text, 'y'.repeat(160));
  assert.deepEqual(cleanLineText('app', '   '), { withheld: 'empty' });
  assert.deepEqual(cleanLineText('app', ''), { withheld: 'empty' });
  assert.deepEqual(cleanLineText('CONSOLE', 'DBG: raw bytes'), { withheld: 'debug' });
});

test('a network name between quotes, a URL and an AWS host name are replaced', () => {
  assert.equal(cleanLineText('net', 'ERR: Leaving "Home "5G"": its security mode (2) is not allowed').text,
    'ERR: Leaving the network: its security mode (2) is not allowed');
  assert.equal(cleanLineText('WIFI', 'joining "half').text, 'joining the network');
  // Only where the firmware says quotes hold a network.
  assert.equal(cleanLineText('app', 'said "hello"').text, 'said "hello"');
  assert.equal(cleanLineText('ota', 'fetching https://bucket.s3.amazonaws.com/firmware/x.bin now').text, 'fetching a URL now');
  assert.equal(cleanLineText('cloud', 'mqtts://abc-ats.iot.us-east-1.amazonaws.com:8883 "next"').text, 'a URL "next"');
  assert.equal(cleanLineText('cloud', 'Connecting to a1b2c3d4e5f6g7-ats.iot.us-east-1.amazonaws.com:8883').text,
    'Connecting to AWS:8883');
  assert.equal(cleanLineText('cloud', 'endpoint A1B2-ATS.IOT.EU-WEST-1.AMAZONAWS.COM, then').text, 'endpoint AWS, then');
  assert.equal(cleanLineText('cloud', 'amazonaws.com alone, notamazonaws.com.example').text, 'amazonaws.com alone, notamazonaws.com.example');
});

test('a line with a passkey, a password, a key or a signed URL is never stored, in any case, from any source', () => {
  for (const word of NEVER_STORED) {
    for (const spelled of [word, word.toUpperCase(), word[0].toUpperCase() + word.slice(1)]) {
      for (const tag of ['BT', 'app', 'WIFI']) {
        assert.deepEqual(cleanLineText(tag, `before ${spelled} after`), { withheld: 'secret' }, `${tag} ${spelled}`);
      }
    }
  }
  assert.deepEqual(cleanLineText('BT', 'passkey 012345'), { withheld: 'secret' });
  assert.deepEqual(cleanLineText('bt_ota', 'Passkey for Cranium-1A2B'), { withheld: 'secret' });
  // Checked before anything is replaced: a signed URL is not let through as "a URL".
  assert.deepEqual(cleanLineText('ota', 'https://b.s3.amazonaws.com/x?X-Amz-Signature=abc'), { withheld: 'secret' });
  // What the firmware itself lets go, goes.
  assert.equal(cleanLineText('WIFI', 'failed reason=wrong password').text, 'failed reason=wrong password');
  assert.deepEqual(made({ tag: 'BT', text: 'passkey 012345' }), { thing: THING, withheld: 'secret', tag: 'BT' });
});

// What a line read back is.

test('a line read back is checked again, and only a line of this log is taken back as a cursor', () => {
  const [item] = made({ dropped: 2 }).items;
  assert.deepEqual(lineFromItem(item), {
    thing: THING, at: item.sk.slice(2, 26), id: '42.17', kind: 'health', tag: 'WIFI', level: 'info',
    text: 'connected ip=10.0.0.7 rssi=-51', boot: 42, seq: 17, dropped: 2,
  });
  for (const broken of [
    { ...item, sk: item.sk.replace('L#', 'E#') }, { ...item, sk: `${item.sk}x` }, { ...item, pk: 'someone' },
    { ...item, kind: 'connection' }, { ...item, tag: 'zephyr' }, { ...item, text: 'é' }, { ...item, text: 'x'.repeat(161) },
    { ...item, sk: item.sk.replace('#42.17', '#42.0') }, null, 'line',
  ]) {
    assert.equal(lineFromItem(broken), null, JSON.stringify(broken));
  }
  assert.equal(lineFromItem({ ...item, level: 'loud' }).level, 'info');
  assert.equal(Object.hasOwn(lineFromItem({ ...item, dropped: -1 }), 'dropped'), false);
  const cursor = Buffer.from(`${item.sk}|${THING}`).toString('base64url');
  assert.deepEqual(decodeLineCursor(cursor), { sk: item.sk, thing: THING });
  assert.equal(decodeLineCursor(Buffer.from(`E#2026-11-03T12:00:00.000Z#abcdef|${THING}`).toString('base64url')), null);
  assert.equal(decodeLineCursor('not a cursor'), null);
});

// The recorder.

function recorderOn(fake, nowMs = NOW) {
  const logs = [];
  const recorder = createRecorder({ store: fake.eventStore(), now: () => nowMs, log: (entry) => logs.push(entry) });
  return { recorder, logs };
}

test('the recorder claims a line, then stores it, and logs its board, kind and tag but never its text', async () => {
  const fake = createFakeAws({ now: () => NOW });
  const { recorder, logs } = recorderOn(fake);
  assert.deepEqual(await recorder(line()), { recorded: 1 });
  assert.deepEqual(fake.methodsCalled(), ['claimLine', 'putEvent']);
  assert.deepEqual(fake.eventItems(THING).map((item) => item.sk.slice(0, 2)), ['K#', 'L#']);
  assert.deepEqual(logs, [{ event: 'recorded', thing: THING, kinds: ['health'], tag: 'WIFI', samples: 0 }]);
  assert.equal(JSON.stringify(logs).includes('10.0.0.7'), false);
});

test('a message handed over again replaces its own line, and a copy the board sent again is not stored twice', async () => {
  const fake = createFakeAws({ now: () => NOW });
  const { recorder, logs } = recorderOn(fake);
  const lines = () => fake.eventItems(THING).filter((item) => item.sk.startsWith('L#'));
  // Lambda's retry: the very same message.
  await recorder(line());
  await recorder(line());
  assert.equal(lines().length, 1);
  // The first line of a boot, sent again in the next connection: another `up`, another time of
  // arrival, a date a little off. The same line.
  assert.deepEqual(await recorder(line({ up: 95_000, received: RECEIVED + 33_760 + 180 })), { recorded: 0 });
  assert.equal(lines().length, 1);
  assert.deepEqual(logs.at(-1), { event: 'line_repeated', thing: THING, boot: 42, seq: 17 });
  // The same boot and line number much later is another life of the board, after a factory reset.
  assert.deepEqual(await recorder(line({ received: RECEIVED + SAME_LINE_MS + 1 })), { recorded: 1 });
  assert.equal(lines().length, 2);
  // And another board's line of the same numbers is its own.
  assert.deepEqual(await recorder(line({ thing: OTHER })), { recorded: 1 });
});

test('a line that is never stored is withheld with a log line that names its board and tag, and nothing is written', async () => {
  const fake = createFakeAws({ now: () => NOW });
  const { recorder, logs } = recorderOn(fake);
  assert.deepEqual(await recorder(line({ tag: 'BT', text: 'passkey 424242' })), { recorded: 0 });
  assert.deepEqual(await recorder(line({ tag: 'app', text: 'psk=hunter22' })), { recorded: 0 });
  assert.deepEqual(logs, [
    { level: 'warn', event: 'line_withheld', thing: THING, tag: 'BT', reason: 'secret' },
    { level: 'warn', event: 'line_withheld', thing: THING, tag: 'app', reason: 'secret' },
  ]);
  assert.deepEqual(fake.methodsCalled(), []);
  assert.equal(JSON.stringify(logs).includes('424242'), false);
  assert.equal(JSON.stringify(logs).includes('hunter22'), false);

  assert.deepEqual(await recorder(line({ seq: 0 })), { recorded: 0 });
  assert.deepEqual(logs.at(-1), { level: 'warn', event: 'message_ignored', reason: 'bad_count' });
});

test('a claim or a line that cannot be written is thrown, so that Lambda tries the message again', async () => {
  const fail = async () => { throw Object.assign(new Error('PutItem: ThrottlingException'), { code: 'throttled' }); };
  for (const store of [{ claimLine: fail, putEvent: async () => {} }, { claimLine: async () => ({ ok: true }), putEvent: fail }]) {
    const logs = [];
    const recorder = createRecorder({ store, now: () => NOW, log: (entry) => logs.push(entry) });
    await assert.rejects(recorder(line()), /ThrottlingException/);
    assert.deepEqual([logs[0].event, logs[0].thing], ['record_failed', THING]);
  }
  // The retry that follows a stored claim finds its own claim, and stores the line.
  const fake = createFakeAws({ now: () => NOW });
  const store = fake.eventStore();
  const { claim } = recordsFromLine(line(), { nowMs: NOW });
  assert.deepEqual(await store.claimLine(claim), { ok: true });
  assert.deepEqual(await createRecorder({ store, now: () => NOW, log: () => {} })(line()), { recorded: 1 });
});

// The route.

const DAY = 86_400_000;

/** A console with two boards that have said a few things over the last hours. */
function history() {
  const console_ = createTestConsole({ startMs: NOW - DAY });
  const { fake } = console_;
  fake.addThing(THING);
  fake.addThing(OTHER);
  fake.addThing('cranium-1111111111111111', { inGroup: false });
  console_.advance(DAY / 2);
  fake.device(THING).connect();
  fake.device(THING).log('WIFI', 'connected ip=10.0.0.7 rssi=-51', { waitedMs: 2000 });
  console_.advance(1000);
  fake.device(THING).log('ota', 'WRN: Download stalled at 40%');
  console_.advance(1000);
  fake.device(OTHER).log('CONSOLE', 'WIFI done on the serial console: save a WPA2 network and join it');
  console_.advance(1000);
  fake.device(OTHER).log('BT', 'passkey 424242');
  fake.device('cranium-1111111111111111').log('app', 'Network is up');
  console_.advance(1000);
  fake.device(THING).log('app', 'Connected to AWS IoT', { dropped: 2 });
  console_.advance(DAY / 2 - 10_000);
  return { console_, fake, viewer: console_.addUser('viewer', ['viewers']) };
}

const said = (body) => body.lines.map((entry) => `${entry.thing === THING ? 'A' : 'B'}:${entry.tag}`);

test('GET /api/events/log lists every board\'s lines of the last day, newest first, for a viewer too', async () => {
  const { console_, fake, viewer } = history();
  const { status, body } = await console_.call('GET', '/api/events/log', { as: viewer });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(said(body), ['A:app', 'B:CONSOLE', 'A:ota', 'A:WIFI']);
  assert.deepEqual(Object.keys(body.lines[0]).sort(), ['at', 'boot', 'dropped', 'id', 'kind', 'level', 'seq', 'tag', 'text', 'thing']);
  assert.deepEqual(body.lines.map((entry) => entry.kind), ['log', 'setting', 'update', 'health']);
  assert.equal(body.lines[2].level, 'warn');
  assert.equal(body.cursor, null);
  // The line waited two seconds on the board before it was sent.
  assert.equal(Date.parse(body.lines[3].at), NOW - DAY + DAY / 2 - 2000);
  // The passkey was never stored, and the board outside the group is not shown.
  assert.equal(JSON.stringify(body).includes('424242'), false);
  // A read: nothing on record. And the events are where they were: no line among them.
  assert.deepEqual(fake.auditLog(), []);
  const events = (await console_.call('GET', '/api/events', { as: viewer })).body.events;
  assert.deepEqual(events.map((event) => event.what), ['connected']);
});

test('GET /api/events/log narrows to a board, kinds and sources, pages, and refuses what it cannot answer', async () => {
  const { console_, viewer } = history();
  const ask = (query) => console_.call('GET', '/api/events/log', { as: viewer, query });
  assert.deepEqual(said((await ask({ thing: OTHER })).body), ['B:CONSOLE']);
  assert.deepEqual(said((await ask({ kinds: 'setting,update' })).body), ['B:CONSOLE', 'A:ota']);
  assert.deepEqual(said((await ask({ tags: 'WIFI,app' })).body), ['A:app', 'A:WIFI']);
  assert.deepEqual(said((await ask({ tags: 'app', kinds: 'health' })).body), []);

  const seen = [];
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const { body } = await ask(cursor === undefined ? { limit: '1' } : { limit: '1', cursor });
    seen.push(...said(body));
    if (body.cursor === null) break;
    cursor = body.cursor;
  }
  assert.deepEqual(seen, ['A:app', 'B:CONSOLE', 'A:ota', 'A:WIFI']);

  const refused = async (query, code) => {
    const answer = await ask(query);
    assert.deepEqual([answer.status, answer.body.error?.code], [400, code], JSON.stringify(query));
  };
  await refused({ tags: 'zephyr' }, 'invalid_tags');
  await refused({ tags: 'BT,BT' }, 'invalid_tags');
  await refused({ tags: '' }, 'invalid_tags');
  await refused({ kinds: 'connection' }, 'invalid_kinds');
  await refused({ kinds: 'firmware' }, 'invalid_kinds');
  // A cursor of the events is not one of the board log.
  const events = (await console_.call('GET', '/api/events', { as: viewer, query: { limit: '1' } })).body;
  assert.equal(events.cursor, null);
  await refused({ cursor: Buffer.from(`E#2026-11-03T12:00:00.000Z#abcdef|${THING}`).toString('base64url') }, 'invalid_cursor');
  assert.equal((await console_.call('GET', '/api/events/log')).status, 401);
});
