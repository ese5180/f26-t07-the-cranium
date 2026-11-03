// Tests for the event log of the boards: what a report becomes (src/lib/events.mjs), the
// recorder that writes it (src/recorder.mjs), and the two routes that read it back
// (src/handlers/events.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EVENT_DAYS, KINDS, SAMPLE_DAYS, changesBetween, decodeEventCursor, encodeEventCursor, eventFromItem, eventKey,
  recordsFromDocument, recordsFromPresence, recordsOf, sampleFromItem, sampleOf, thinSamples,
} from '../src/lib/events.mjs';
import { createRecorder } from '../src/recorder.mjs';
import { createFakeAws, createTestConsole } from './fake-aws.mjs';

const THING = 'cranium-0123456789abcdef';
const OTHER = 'cranium-fedcba9876543210';
const JOB = 'cranium-1-2-3-b5-20261010T221500Z-9f3a';
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const STAMP = Math.floor(NOW / 1000) - 2;

const heartbeat = (changes = {}) => ({
  fw: { version: '1.2.3+4', confirmed: true },
  ota: { state: 'idle', progress: 0, last: 'none', error: '' },
  wifi: { rssi: -52 },
  stuck: { count: 0, reason: 'none' },
  uptime: 600,
  ...changes,
});

const diag = (heap = { free: 21312, least: 9840, size: 44240 }, channel = 6) =>
  ({ mac: 'f4:ce:36:12:34:56', channel, heap });

/** What one report changes: [kind, what, level] of each event. */
const summary = (before, after) => changesBetween(before, after).map(({ kind, what, level }) => [kind, what, level]);

let draws = 0;
const randomHex = (count) => {
  draws += 1;
  return draws.toString(16).padStart(2 * count, '0').slice(-2 * count);
};
const options = { nowMs: NOW, randomHex };
const documentOf = (before, after, extra = {}) => ({
  previous: { state: { reported: before }, version: 7 },
  current: { state: { reported: after }, version: 8 },
  timestamp: STAMP,
  thing: THING,
  ...extra,
});

// What a report becomes.

test('a heartbeat that changes nothing makes no event', () => {
  assert.deepEqual(changesBetween(heartbeat(), heartbeat({ uptime: 630, wifi: { rssi: -60 } })), []);
  assert.deepEqual(changesBetween(heartbeat({ diag: diag() }), heartbeat({ uptime: 630, diag: diag({ free: 20000, least: 9000, size: 44240 }) })), []);
});

test('a new version, its confirmation and the first version seen are firmware events', () => {
  const changed = changesBetween(heartbeat(), heartbeat({ fw: { version: '1.2.3+5', confirmed: false }, uptime: 8 }));
  const firmware = changed.find((event) => event.kind === 'firmware');
  assert.deepEqual(firmware, {
    kind: 'firmware', what: 'changed', level: 'info', text: 'Firmware changed from 1.2.3+4 to 1.2.3+5, on trial',
    fields: { version: '1.2.3+5', from: '1.2.3+4', confirmed: false },
  });
  const confirmed = changesBetween(heartbeat({ fw: { version: '1.2.3+5', confirmed: false } }),
    heartbeat({ fw: { version: '1.2.3+5', confirmed: true } }));
  assert.deepEqual(confirmed.map((event) => event.text), ['Firmware 1.2.3+5 confirmed']);
  assert.deepEqual(summary({}, heartbeat()), [['firmware', 'reported', 'info']]);
  assert.equal(changesBetween(undefined, heartbeat())[0].text, 'Reported firmware 1.2.3+4');
  // A version that is not one is not a change.
  assert.deepEqual(changesBetween(heartbeat(), heartbeat({ fw: { version: '1.2.3', confirmed: true } })), []);
});

test('each step of an update is an event with its deployment and its progress', () => {
  const at = (state, progress = 0, job = JOB) => heartbeat({ ota: { state, job, progress, last: 'none', error: '' } });
  const steps = [
    [heartbeat(), at('awaiting_user'), 'Offered 1.2.3+5; waiting for Button 1'],
    [at('awaiting_user'), at('downloading'), 'Downloading 1.2.3+5'],
    [at('downloading', 100), at('verifying', 100), 'Checking the download of 1.2.3+5'],
    [at('verifying', 100), at('rebooting', 100), 'Restarting into 1.2.3+5'],
  ];
  for (const [before, after, text] of steps) {
    const [event] = changesBetween(before, after);
    assert.equal(event.text, text);
    assert.equal(event.fields.job, JOB);
    assert.equal(event.fields.state, after.ota.state);
    assert.equal(event.fields.progress, after.ota.progress);
  }
  // Progress alone is not a step.
  assert.deepEqual(changesBetween(at('downloading', 10), at('downloading', 60)), []);
  // A job of some other tool has no version to name.
  assert.equal(changesBetween(heartbeat(), at('downloading', 0, 'some-other-job'))[0].text, 'Downloading an update');
});

test('an update that ends is one result, not a step back to idle, and a bad one is a warning', () => {
  const testing = heartbeat({ fw: { version: '1.2.3+5', confirmed: false }, ota: { state: 'testing', job: JOB, progress: 100, last: 'none', error: '' } });
  const done = heartbeat({ fw: { version: '1.2.3+5', confirmed: true }, ota: { state: 'idle', progress: 0, last: 'succeeded', error: '' } });
  const events = changesBetween(testing, done);
  assert.deepEqual(events.map((event) => [event.kind, event.what, event.text]), [
    ['firmware', 'confirmed', 'Firmware 1.2.3+5 confirmed'],
    ['update', 'result', 'Update to 1.2.3+5 succeeded'],
  ]);
  assert.deepEqual(events[1].fields, { result: 'succeeded', job: JOB });

  const downloading = heartbeat({ ota: { state: 'downloading', job: JOB, progress: 40, last: 'none', error: '' } });
  const failed = heartbeat({ ota: { state: 'idle', progress: 0, last: 'failed', error: 'download_failed' } });
  assert.deepEqual(changesBetween(downloading, failed), [{
    kind: 'update', what: 'result', level: 'warn', text: 'Update to 1.2.3+5 failed: download_failed',
    fields: { result: 'failed', error: 'download_failed', job: JOB },
  }]);
  // The same result as last time, after another update, is reported again.
  const again = heartbeat({ ota: { state: 'downloading', job: JOB, progress: 20, last: 'failed', error: 'download_failed' } });
  assert.deepEqual(summary(again, failed), [['update', 'result', 'warn']]);
  for (const [last, words, level] of [['rolled_back', 'rolled back to the previous firmware', 'warn'],
    ['declined', 'declined at the board', 'info'], ['cancelled', 'cancelled', 'info'], ['refused', 'refused by the board', 'warn']]) {
    const [event] = changesBetween(downloading, heartbeat({ ota: { state: 'idle', progress: 0, last, error: '' } }));
    assert.equal(event.text, `Update to 1.2.3+5 ${words}`);
    assert.equal(event.level, level);
  }
  // An update that went back to idle without a result says so.
  assert.equal(changesBetween(downloading, heartbeat())[0].text, 'Update stopped, with no result reported');
});

test('the Bluetooth window opening and closing are events of their own, not update steps', () => {
  const open = heartbeat({ ota: { state: 'bluetooth', progress: 0, last: 'none', error: '' } });
  assert.deepEqual(changesBetween(heartbeat(), open).map((event) => [event.kind, event.what, event.text]),
    [['bluetooth', 'opened', 'Bluetooth opened for an update from a phone']]);
  assert.deepEqual(changesBetween(open, heartbeat()).map((event) => [event.kind, event.what, event.text]),
    [['bluetooth', 'closed', 'Bluetooth closed']]);
});

test('a restart is told by the uptime, and the boot diary says why', () => {
  const [restart] = changesBetween(heartbeat({ uptime: 7500 }), heartbeat({ uptime: 9 }));
  assert.deepEqual(restart, {
    kind: 'restart', what: 'restarted', level: 'info', text: 'Restarted after 2 h 5 min up', fields: { upFor: 7500 },
  });

  // The diary comes a moment later, in a report of its own: the newest entry is the boot that
  // just began, and its cause is why the one before it ended; that one got as far as its stage.
  const before = { diary: { boots: 41, log: ['1.2.3+4/8/4', '1.2.3+4/2/4'] } };
  const after = { diary: { boots: 42, log: ['1.2.3+4/8/4', '1.2.3+4/2/3', '1.2.3+5/10/1'] } };
  assert.deepEqual(changesBetween(heartbeat(before), heartbeat(after)), [{
    kind: 'restart', what: 'boot', level: 'warn',
    text: 'Last boot ended by the watchdog; it had got onto the network',
    fields: { version: '1.2.3+5', cause: '10', boots: 42, newBoots: 1, stage: 3 },
  }]);
  // In the same report, the restart carries it.
  const merged = changesBetween(heartbeat({ ...before, uptime: 300 }), heartbeat({ ...after, uptime: 5 }));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, 'Restarted after 5 min up. Last boot ended by the watchdog; it had got onto the network');
  assert.deepEqual(merged[0].fields, { upFor: 300, cause: '10', stage: 3 });

  const several = changesBetween(heartbeat({ diary: { boots: 3, log: ['1.0.0+0/8/4'] } }),
    heartbeat({ diary: { boots: 6, log: ['1.0.0+0/8/4', '1.0.0+0/1/2', '1.0.0+0/2/4'] } }));
  assert.equal(several[0].text, '3 boots since the last report. Last boot ended by a software restart; it had started its update manager');
  assert.equal(several[0].level, 'info');
  assert.equal(changesBetween(heartbeat({ diary: { boots: 3, log: ['1.0.0+0/8/4'] } }),
    heartbeat({ diary: { boots: 4, log: ['1.0.0+0/8/4', '1.0.0+0/0/1'] } }))[0].text,
  'Last boot ended by a loss of power; it had reached the cloud');
  assert.equal(changesBetween(heartbeat({ diary: { boots: 3, log: [] } }),
    heartbeat({ diary: { boots: 4, log: ['1.0.0+0/104/1'] } }))[0].text, 'Last boot ended by a brownout and a CPU lockup');
  // A diary seen for the first time, or sent again on reconnecting, is no news.
  assert.deepEqual(changesBetween(heartbeat(), heartbeat(after)), []);
  assert.deepEqual(changesBetween(heartbeat(after), heartbeat(after)), []);
});

test('a restart for being stuck is a warning that says which timer fired', () => {
  const [stuck] = changesBetween(heartbeat({ uptime: 9000 }), heartbeat({ uptime: 12, stuck: { count: 2, reason: 'wifi_silent' } }));
  assert.deepEqual(stuck, {
    kind: 'restart', what: 'stuck', level: 'warn',
    text: 'Restarted itself for being stuck: the Wi-Fi chip stopped answering (2nd time in a row, after 2 h 30 min up)',
    fields: { count: 2, reason: 'wifi_silent', upFor: 9000 },
  });
  assert.match(changesBetween(heartbeat(), heartbeat({ stuck: { count: 1, reason: 'no_cloud' } }))[0].text,
    /no connection to the cloud for 15 minutes \(1st time in a row\)$/);
  assert.match(changesBetween(heartbeat(), heartbeat({ stuck: { count: 11, reason: 'some_new_timer' } }))[0].text,
    /reason some_new_timer \(11th time in a row\)$/);
  // Back to zero, or a count seen for the first time, is not a restart.
  assert.deepEqual(changesBetween(heartbeat({ stuck: { count: 3, reason: 'no_cloud' } }), heartbeat()), []);
  assert.deepEqual(changesBetween(heartbeat({ stuck: undefined }), heartbeat({ stuck: { count: 3, reason: 'no_cloud' } })), []);
});

test('a change to the Bluetooth update record is an event, and a record sent again is not', () => {
  const record = (result, count = 3, proof = 'person') => ({ bt: { from: '1.5.0+0', to: '1.6.0+0', result, proof, count } });
  assert.deepEqual(changesBetween(heartbeat(), heartbeat(record('succeeded'))), [{
    kind: 'bluetooth', what: 'record', level: 'info',
    text: 'Bluetooth update from 1.5.0+0 to 1.6.0+0 succeeded, kept by a person at the board',
    fields: { from: '1.5.0+0', to: '1.6.0+0', result: 'succeeded', proof: 'person', count: 3 },
  }]);
  assert.deepEqual(changesBetween(heartbeat(record('succeeded')), heartbeat(record('succeeded'))), []);
  const [lost] = changesBetween(heartbeat(record('pending')), heartbeat(record('trial_lost')));
  assert.equal(lost.text, 'Bluetooth update from 1.5.0+0 to 1.6.0+0 lost its trial');
  assert.equal(lost.level, 'warn');
  assert.equal(changesBetween(heartbeat(record('succeeded')), heartbeat(record('succeeded', 4, 'cloud')))[0].text,
    'Bluetooth update from 1.5.0+0 to 1.6.0+0 succeeded, proved by the cloud');
  assert.deepEqual(changesBetween(heartbeat(), heartbeat({ bt: { from: '1.5.0+0', to: '1.6.0+0', result: 'hacked' } })), []);
});

test('a new Wi-Fi channel and memory that ran low are health events, the low memory once per boot', () => {
  assert.deepEqual(changesBetween(heartbeat({ diag: diag(undefined, 6) }), heartbeat({ diag: diag(undefined, 11) }))
    .map((event) => [event.text, event.fields]), [['Wi-Fi channel changed from 6 to 11', { channel: 11, before: 6 }]]);
  // Not associated is channel 0: no channel to change from or to.
  assert.deepEqual(changesBetween(heartbeat({ diag: diag(undefined, 0) }), heartbeat({ diag: diag(undefined, 11) })), []);

  const low = { free: 9000, least: 6200, size: 44240 };
  const [memory] = changesBetween(heartbeat({ diag: diag() }), heartbeat({ diag: diag(low) }));
  assert.deepEqual(memory, {
    kind: 'health', what: 'memory', level: 'warn',
    text: 'Memory ran low: at one point only 6.1 KiB of 43.2 KiB was free (14%)',
    fields: { heapLeast: 6200, heapSize: 44240 },
  });
  // Lower still in the same boot: already said.
  assert.deepEqual(changesBetween(heartbeat({ diag: diag(low) }), heartbeat({ diag: diag({ ...low, least: 5000 }) })), []);
  // After a restart the least starts over; low again is said again.
  assert.deepEqual(summary(heartbeat({ diag: diag({ ...low, least: 5000 }) }), heartbeat({ diag: diag(low) })),
    [['health', 'memory', 'warn']]);
  // No statistics in the build: zeros, which are no reading.
  assert.deepEqual(changesBetween(heartbeat({ diag: diag() }), heartbeat({ diag: diag({ free: 0, least: 0, size: 0 }) })), []);
});

test('nothing malformed makes an event, a crash or a field that was not checked', () => {
  const junk = [undefined, null, 7, 'reported', [], [heartbeat()], { __proto__: { polluted: true } },
    JSON.parse('{"__proto__": {"admin": true}, "fw": {"version": "<b>1</b>", "confirmed": "yes"}}'),
    { fw: [], ota: 'idle', wifi: { rssi: 'strong' }, uptime: -5, stuck: { count: -1, reason: 'Bad Reason' },
      diag: { mac: 'nope', channel: 999, heap: { free: 10, least: 20, size: 5 } },
      diary: { boots: 'many', log: 'x' }, bt: { from: 1, to: 2, result: 'succeeded' } },
    { ota: { state: 'exploding', job: '../../etc', progress: 1e9, last: 'pwned', error: 'x'.repeat(500) } },
    { diary: { boots: 2, log: ['not/an/entry', '1.0.0+0/zz/1', `1.0.0+0/${'f'.repeat(20)}/1`, 42] } }];
  for (const before of junk) {
    for (const after of junk) {
      const events = changesBetween(before, after);
      for (const event of events) {
        assert.ok(KINDS.includes(event.kind));
        assert.doesNotMatch(event.text, /<|pwned|exploding|etc|polluted|admin/);
      }
    }
  }
  assert.equal({}.polluted, undefined);
  assert.equal({}.admin, undefined);
  // An error a board sends is kept only as the short printable text the console shows.
  assert.deepEqual(changesBetween(heartbeat({ ota: { state: 'downloading', job: JOB, progress: 1, last: 'none', error: '' } }),
    heartbeat({ ota: { state: 'idle', progress: 0, last: 'failed', error: 'x'.repeat(65) } }))[0].fields,
  { result: 'failed', job: JOB });
});

test('a pairing passkey is never read, stored or shown', () => {
  const pairing = (passkey) => ({ btpair: { name: 'Cranium-1A2B', passkey } });
  const before = heartbeat({ ...pairing('480913'), ota: { state: 'bluetooth', progress: 0, last: 'none', error: '' } });
  const after = heartbeat({ ...pairing('736251') });
  const made = recordsFromDocument(documentOf(before, after), options);
  const stored = JSON.stringify(made.items);
  assert.ok(made.items.length > 0);
  for (const secret of ['480913', '736251', 'passkey', 'btpair', 'Cranium-1A2B']) {
    assert.equal(stored.includes(secret), false, secret);
  }
  assert.deepEqual(changesBetween(heartbeat(pairing('111111')), heartbeat(pairing('222222'))), []);
});

test('every report is one sample of the signal, the uptime and, from 1.10.0, the heap', () => {
  assert.deepEqual(sampleOf(heartbeat()), { rssi: -52, uptime: 600 });
  assert.deepEqual(sampleOf(heartbeat({ diag: diag() })), { rssi: -52, uptime: 600, heapFree: 21312, heapLeast: 9840 });
  assert.equal(sampleOf({ btpair: { passkey: '123456' } }), null);
  assert.equal(sampleOf('nothing'), null);
});

// Items.

test('a shadow document becomes events and a sample, keyed by board and time, with their lifetimes', () => {
  const before = heartbeat({ ota: { state: 'downloading', job: JOB, progress: 100, last: 'none', error: '' } });
  const after = heartbeat({ ota: { state: 'verifying', job: JOB, progress: 100, last: 'none', error: '' }, stuck: { count: 1, reason: 'update_stall' } });
  const made = recordsFromDocument(documentOf(before, after), options);
  assert.equal(made.thing, THING);
  const [first, second, sample] = made.items;
  // The second AWS IoT stamped, and within it 10 ms for each version of the shadow (version 8).
  const at = STAMP * 1000 + 80;
  assert.match(first.sk, new RegExp(`^E#${new Date(at).toISOString()}#[0-9a-f]{6}$`));
  // One millisecond apart, so that they keep their order.
  assert.match(second.sk, new RegExp(`^E#${new Date(at + 1).toISOString()}#[0-9a-f]{6}$`));
  assert.equal(first.kind, 'restart');
  assert.equal(second.kind, 'update');
  assert.equal(first.ttl, STAMP + EVENT_DAYS * 86400);
  assert.deepEqual(sample, { pk: THING, sk: `S#${new Date(at).toISOString()}`, rssi: -52, uptime: 600, ttl: STAMP + SAMPLE_DAYS * 86400 });
  assert.deepEqual(Object.keys(second).sort(), ['job', 'kind', 'level', 'pk', 'progress', 'sk', 'state', 'text', 'ttl', 'what']);

  // A time that AWS IoT cannot have stamped is replaced by the recorder's.
  for (const timestamp of [0, STAMP - 3 * 86400, STAMP + 3600, 'now', 1.5, undefined]) {
    const [item] = recordsFromDocument(documentOf(heartbeat(), heartbeat(), { timestamp }), options).items;
    assert.equal(item.sk, `S#${new Date(NOW).toISOString()}`, String(timestamp));
  }
  // The first report of a board has no previous state.
  assert.deepEqual(recordsFromDocument({ current: { state: { reported: heartbeat() } }, timestamp: STAMP, thing: THING }, options)
    .items.map((item) => item.what ?? 'sample'), ['reported', 'sample']);
});

test('two reports in one second keep their order, by the version of the shadow', () => {
  const downloading = heartbeat({ ota: { state: 'downloading', job: JOB, progress: 100, last: 'none', error: '' } });
  const verifying = heartbeat({ ota: { state: 'verifying', job: JOB, progress: 100, last: 'none', error: '' } });
  const rebooting = heartbeat({ ota: { state: 'rebooting', job: JOB, progress: 100, last: 'none', error: '' } });
  const keyOf = (before, after, version) => recordsFromDocument({
    previous: { state: { reported: before } }, current: { state: { reported: after }, version }, timestamp: STAMP, thing: THING,
  }, options).items[0].sk;
  // Only where the version passes a hundred (199, then 200) is the order left to the random digits.
  assert.ok(keyOf(downloading, verifying, 141) < keyOf(verifying, rebooting, 142));
  assert.match(keyOf(downloading, verifying, 141), /T11:59:58\.410Z#/);
  assert.match(keyOf(downloading, verifying, 'x'), /T11:59:58\.000Z#/);
});

test('a document about anything but one of the boards is dropped', () => {
  for (const thing of [undefined, 'cranium-XYZ', 'other-0123456789abcdef', `${THING}/x`, 42, null]) {
    assert.deepEqual(recordsFromDocument(documentOf(heartbeat(), heartbeat(), { thing }), options), { ignored: 'not_a_board' });
  }
  assert.deepEqual(recordsFromDocument({ thing: THING, current: { state: { desired: {} } } }, options), { ignored: 'no_report' });
  assert.deepEqual(recordsOf({ hello: 'world' }, options), { ignored: 'unknown_message' });
  assert.deepEqual(recordsOf('text', options), { ignored: 'unknown_message' });
});

test('presence messages keep the time, the kind and the reason, and never the address or the certificate', () => {
  const connected = {
    clientId: THING, timestamp: NOW - 5000, eventType: 'connected', sessionIdentifier: 'a4666d2a7d844ae4ac5d7b38c9cb7967',
    principalIdentifier: '12345678901234567890123456789012', ipAddress: '192.0.2.10', versionNumber: 0,
  };
  const [item] = recordsOf(connected, options).items;
  assert.deepEqual(Object.keys(item).sort(), ['kind', 'level', 'pk', 'sk', 'text', 'ttl', 'what']);
  assert.equal(item.text, 'Connected to AWS IoT');
  assert.match(item.sk, new RegExp(`^E#${new Date(NOW - 5000).toISOString()}#`));
  for (const secret of ['192.0.2.10', '1234567890123456', 'a4666d2a']) assert.equal(JSON.stringify(item).includes(secret), false);

  const [lost] = recordsOf({ ...connected, eventType: 'disconnected', disconnectReason: 'MQTT_KEEP_ALIVE_TIMEOUT' }, options).items;
  assert.equal(lost.text, 'Disconnected from AWS IoT: the board stopped answering');
  assert.equal(lost.reason, 'MQTT_KEEP_ALIVE_TIMEOUT');
  const [odd] = recordsOf({ ...connected, eventType: 'disconnected', disconnectReason: 'something new; DROP' }, options).items;
  assert.equal(odd.text, 'Disconnected from AWS IoT');
  assert.equal(odd.reason, undefined);
  assert.equal(recordsOf({ ...connected, eventType: 'disconnected', disconnectReason: 'BRAND_NEW' }, options).items[0].reason, 'BRAND_NEW');

  assert.deepEqual(recordsFromPresence({ ...connected, clientId: 'my-laptop' }, options), { ignored: 'not_a_board' });
  assert.deepEqual(recordsFromPresence({ ...connected, eventType: 'subscribed' }, options), { ignored: 'not_presence' });
});

test('an item read back is checked again, field by field', () => {
  const [item] = recordsFromDocument(documentOf(heartbeat(), heartbeat({ fw: { version: '1.2.3+5', confirmed: false } })), options).items;
  const event = eventFromItem(item);
  assert.deepEqual(event, {
    thing: THING, at: new Date(STAMP * 1000 + 80).toISOString(), id: item.sk.slice(-6), kind: 'firmware', what: 'changed',
    level: 'info', text: 'Firmware changed from 1.2.3+4 to 1.2.3+5, on trial', version: '1.2.3+5', from: '1.2.3+4', confirmed: false,
  });
  for (const broken of [
    { ...item, sk: 'E#yesterday#abcdef' }, { ...item, pk: 'not-a-board' }, { ...item, kind: 'rumour' },
    { ...item, what: 'Not A Word' }, { ...item, text: 'line\nbreak' }, { ...item, text: '' }, null, 'item',
  ]) {
    assert.equal(eventFromItem(broken), null);
  }
  assert.deepEqual(Object.keys(eventFromItem({ ...item, version: '<b>', progress: 101, admin: true, level: 'panic' })).sort(),
    ['at', 'confirmed', 'from', 'id', 'kind', 'level', 'text', 'thing', 'what']);
  assert.equal(eventFromItem({ ...item, level: 'panic' }).level, 'info');

  assert.deepEqual(sampleFromItem({ sk: 'S#2026-11-02T10:00:00.000Z', rssi: -60, uptime: 5, heapFree: 'lots' }),
    { at: '2026-11-02T10:00:00.000Z', rssi: -60, uptime: 5, heapFree: null, heapLeast: null });
  assert.equal(sampleFromItem({ sk: 'E#2026-11-02T10:00:00.000Z#abcdef' }), null);
});

test('a page cursor is opaque, and only a cursor of this log is taken back', () => {
  const sk = eventKey(NOW, 'a1b2c3');
  const cursor = encodeEventCursor({ sk, pk: THING });
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeEventCursor(cursor), { sk, thing: THING });
  const encode = (text) => Buffer.from(text).toString('base64url');
  for (const bad of ['', 'x', '!!!', encode(`${sk}|not-a-board`), encode(`S#2026|${THING}`), encode(`${sk}|${THING}|x`),
    `${cursor}=`, 'A'.repeat(300), 42, null]) {
    assert.equal(decodeEventCursor(bad), null, String(bad));
  }
  assert.throws(() => eventKey(NOW, 'xyz'), TypeError);
});

test('samples are thinned to buckets: the mean signal, the last uptime, the lowest heap', () => {
  const fromMs = NOW - 3_600_000;
  const at = (seconds) => new Date(fromMs + seconds * 1000).toISOString();
  const few = [{ at: at(0), rssi: -50, uptime: 1, heapFree: null, heapLeast: null }];
  assert.deepEqual(thinSamples(few, { fromMs, toMs: NOW, max: 10 }), { samples: few, bucketSeconds: 0 });

  const many = Array.from({ length: 120 }, (_, index) => ({
    at: at(index * 30), rssi: index % 2 ? -60 : -50, uptime: index, heapFree: 20000 - index, heapLeast: index === 7 ? 100 : 9000,
  }));
  const { samples, bucketSeconds } = thinSamples(many, { fromMs, toMs: NOW, max: 10 });
  assert.equal(samples.length, 10);
  assert.equal(bucketSeconds, 360);
  assert.deepEqual(samples[0], { at: at(330), rssi: -55, uptime: 11, heapFree: 19989, heapLeast: 100 });
  assert.deepEqual(samples.map((sample) => sample.at), [...samples.map((sample) => sample.at)].sort());
  // A bucket where only some samples have a heap reading takes the lowest of those.
  const mixed = many.map((sample, index) => (index % 3 ? { ...sample, heapFree: null, heapLeast: null } : sample));
  assert.equal(thinSamples(mixed, { fromMs, toMs: NOW, max: 10 }).samples[0].heapFree, 19991);
});

// The recorder.

test('the recorder writes what a message makes, in order, and logs nothing of what the board said', async () => {
  const fake = createFakeAws({ now: () => NOW });
  const logs = [];
  const recorder = createRecorder({ store: fake.eventStore(), now: () => NOW, randomHex, log: (line) => logs.push(line) });
  const before = heartbeat({ ota: { state: 'downloading', job: JOB, progress: 40, last: 'none', error: '' } });
  const after = heartbeat({ ota: { state: 'idle', progress: 0, last: 'failed', error: 'secret-looking-error' }, uptime: 3 });
  assert.deepEqual(await recorder(documentOf(before, after)), { recorded: 3 });
  assert.deepEqual(fake.eventItems(THING).map((item) => item.kind ?? 'sample'), ['restart', 'update', 'sample']);
  assert.deepEqual(fake.methodsCalled(), ['putEvent', 'putEvent', 'putEvent']);
  assert.deepEqual(logs, [{ event: 'recorded', thing: THING, kinds: ['restart', 'update'], samples: 1 }]);

  assert.deepEqual(await recorder({ eventType: 'connected', clientId: 'not-a-board', ipAddress: '192.0.2.1' }), { recorded: 0 });
  assert.deepEqual(logs.at(-1), { level: 'warn', event: 'message_ignored', reason: 'not_a_board' });
  assert.equal(JSON.stringify(logs).includes('192.0.2.1'), false);
  assert.equal(JSON.stringify(logs).includes('secret-looking-error'), false);
});

test('a write that fails is thrown, so that Lambda tries the message again', async () => {
  const logs = [];
  const store = { putEvent: async () => { throw Object.assign(new Error('PutItem: ThrottlingException'), { code: 'throttled' }); } };
  const recorder = createRecorder({ store, now: () => NOW, randomHex, log: (line) => logs.push(line) });
  await assert.rejects(recorder(documentOf(heartbeat(), heartbeat())), /ThrottlingException/);
  assert.equal(logs[0].event, 'record_failed');
  assert.equal(logs[0].thing, THING);
  assert.throws(() => createRecorder({}), TypeError);
});

test('the stand-in plays the rules: reports and connections land in its events table', () => {
  let ms = NOW;
  const fake = createFakeAws({ now: () => ms });
  fake.addThing(THING);
  fake.device(THING).connect();
  ms += 1000;
  fake.device(THING).report(heartbeat());
  ms += 30_000;
  fake.device(THING).report(heartbeat({ fw: { version: '1.2.3+5', confirmed: true }, uptime: 4 }));
  ms += 1000;
  fake.device(THING).disconnect('CLIENT_INITIATED_DISCONNECT');
  const items = fake.eventItems(THING);
  assert.deepEqual(items.filter((item) => item.sk.startsWith('E#')).map((item) => item.what),
    ['connected', 'reported', 'restarted', 'changed', 'disconnected']);
  assert.equal(items.filter((item) => item.sk.startsWith('S#')).length, 2);
  assert.deepEqual(fake.deliver({ nothing: true }), { ignored: 'unknown_message' });
});

// The routes.

const DAY = 86_400_000;

/** A console with two boards in the group and one outside it, and a day of history. */
function history() {
  const console_ = createTestConsole({ startMs: NOW - DAY });
  const { fake } = console_;
  fake.addThing(THING);
  fake.addThing(OTHER);
  fake.addThing('cranium-1111111111111111', { inGroup: false });
  // A second apart, so that no two events share a time.
  for (const thing of [THING, OTHER, 'cranium-1111111111111111']) {
    fake.device(thing).connect();
    console_.advance(1000);
    fake.device(thing).report(heartbeat());
    console_.advance(1000);
  }
  console_.advance(DAY / 2);
  const restartedAt = console_.clock.ms;
  fake.device(THING).report(heartbeat({ fw: { version: '1.2.3+5', confirmed: true }, uptime: 5 }));
  console_.advance(60_000);
  fake.device(OTHER).disconnect();
  console_.advance(DAY / 2 - 120_000);
  return {
    console_, fake, restartedAt,
    viewer: console_.addUser('viewer', ['viewers']),
    manager: console_.addUser('manager', ['release-managers']),
  };
}

const NEWEST_FIRST = ['B:disconnected', 'A:changed', 'A:restarted', 'B:reported', 'B:connected', 'A:reported', 'A:connected'];

const whats = (body) => body.events.map((event) => `${event.thing === THING ? 'A' : 'B'}:${event.what}`);

test('GET /api/events lists the last day of every board in the group, newest first, for a viewer too', async () => {
  const { console_, fake, viewer, manager } = history();
  const { status, body } = await console_.call('GET', '/api/events', { as: viewer });
  assert.equal(status, 200);
  assert.deepEqual(whats(body), NEWEST_FIRST);
  assert.deepEqual(body.events.map((event) => event.at), [...body.events.map((event) => event.at)].sort().reverse());
  assert.equal(body.events.some((event) => event.thing === 'cranium-1111111111111111'), false);
  assert.equal(body.cursor, null);
  assert.equal(body.to, new Date(console_.clock.ms).toISOString());
  assert.equal(body.from, new Date(console_.clock.ms - DAY).toISOString());
  assert.deepEqual(Object.keys(body.events[0]).sort(), ['at', 'id', 'kind', 'level', 'reason', 'text', 'thing', 'what']);
  assert.equal((await console_.call('GET', '/api/events', { as: manager })).status, 200);
  // A read: nothing goes on record.
  assert.deepEqual(fake.auditLog(), []);
  assert.equal((await console_.call('GET', '/api/events')).status, 401);
});

test('GET /api/events narrows to one board, some kinds and a time span', async () => {
  const { console_, viewer, restartedAt } = history();
  const ask = (query) => console_.call('GET', '/api/events', { as: viewer, query });
  assert.deepEqual(whats((await ask({ thing: OTHER })).body), ['B:disconnected', 'B:reported', 'B:connected']);
  assert.deepEqual(whats((await ask({ kinds: 'connection' })).body), ['B:disconnected', 'B:connected', 'A:connected']);
  assert.deepEqual((await ask({ kinds: 'firmware,restart', thing: THING })).body.events.map((event) => event.what),
    ['changed', 'restarted', 'reported']);
  const after = new Date(restartedAt + 30_000).toISOString();
  assert.deepEqual(whats((await ask({ from: after })).body), ['B:disconnected']);
  assert.deepEqual(whats((await ask({ to: after, from: new Date(console_.clock.ms - DAY - 1000).toISOString(), thing: THING })).body),
    ['A:changed', 'A:restarted', 'A:reported', 'A:connected']);
  // Seconds without milliseconds are a time too.
  assert.equal((await ask({ from: '2026-11-01T12:00:00Z', to: '2026-11-02T12:00:00Z' })).status, 200);
});

test('GET /api/events refuses what it cannot answer, with a code for each', async () => {
  const { console_, viewer } = history();
  const refused = async (query, code, status = 400) => {
    const answer = await console_.call('GET', '/api/events', { as: viewer, query });
    assert.equal(answer.status, status, JSON.stringify(query));
    assert.equal(answer.body.error.code, code, JSON.stringify(query));
  };
  await refused({ thing: 'cranium-XYZ' }, 'invalid_thing');
  await refused({ thing: 'cranium-1111111111111111' }, 'unknown_device', 404);
  await refused({ kinds: 'rumour' }, 'invalid_kinds');
  await refused({ kinds: 'firmware,firmware' }, 'invalid_kinds');
  await refused({ kinds: '' }, 'invalid_kinds');
  for (const time of ['yesterday', '2026-11-02', '2026-02-31T00:00:00Z', '2026-11-02T10:00:00+01:00', '1730000000000']) {
    await refused({ from: time }, 'invalid_time');
  }
  await refused({ from: '2026-11-02T10:00:00Z', to: '2026-11-02T10:00:00Z' }, 'invalid_range');
  await refused({ from: '2026-11-02T10:00:00Z', to: '2026-11-01T10:00:00Z' }, 'invalid_range');
  await refused({ from: '2026-09-01T00:00:00Z', to: '2026-10-02T00:00:01Z' }, 'invalid_range');
  await refused({ limit: '0' }, 'invalid_limit');
  await refused({ limit: '501' }, 'invalid_limit');
  await refused({ cursor: 'not-a-cursor' }, 'invalid_cursor');
  assert.equal((await console_.call('GET', '/api/events', { as: viewer, query: { from: '2026-09-01T00:00:00Z', to: '2026-10-02T00:00:00Z' } })).status, 200);
});

test('GET /api/events pages through every board at once, each event exactly once', async () => {
  const { console_, viewer } = history();
  const all = (await console_.call('GET', '/api/events', { as: viewer })).body.events;
  const seen = [];
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const query = cursor === undefined ? { limit: '2' } : { limit: '2', cursor };
    const { body } = await console_.call('GET', '/api/events', { as: viewer, query });
    assert.equal(body.events.length <= 2, true);
    seen.push(...body.events);
    if (body.cursor === null) break;
    cursor = body.cursor;
  }
  assert.deepEqual(seen, all);
  assert.equal(all.length, 7);
});

test('GET /api/events orders two boards with the same time by name, across pages', async () => {
  const console_ = createTestConsole({ startMs: NOW });
  const { fake } = console_;
  fake.addThing(THING);
  fake.addThing(OTHER);
  const store = fake.eventStore();
  const sk = eventKey(NOW - 1000, 'aaaaaa');
  for (const pk of [THING, OTHER]) {
    await store.putEvent({ pk, sk, kind: 'health', what: 'channel', level: 'info', text: `Channel of ${pk}`, ttl: NOW / 1000 + 100 });
  }
  const viewer = console_.addUser('viewer', ['viewers']);
  const first = (await console_.call('GET', '/api/events', { as: viewer, query: { limit: '1' } })).body;
  const second = (await console_.call('GET', '/api/events', { as: viewer, query: { limit: '1', cursor: first.cursor } })).body;
  assert.deepEqual([...first.events, ...second.events].map((event) => event.thing), [OTHER, THING]);
  assert.equal(second.cursor, null);
});

test('GET /api/events leaves out what has expired and what is not an event', async () => {
  const console_ = createTestConsole({ startMs: NOW });
  const { fake } = console_;
  fake.addThing(THING);
  const store = fake.eventStore();
  const item = (seconds, ttl, extra = {}) => ({
    pk: THING, sk: eventKey(NOW - seconds * 1000, String(seconds).padStart(6, '0')), kind: 'firmware', what: 'changed',
    level: 'info', text: 'Firmware changed', ttl, ...extra,
  });
  await store.putEvent(item(10, NOW / 1000 + 60));
  await store.putEvent(item(20, NOW / 1000 - 1));
  await store.putEvent(item(30, NOW / 1000 + 60, { kind: 'gossip' }));
  const viewer = console_.addUser('viewer', ['viewers']);
  const { body } = await console_.call('GET', '/api/events', { as: viewer });
  assert.deepEqual(body.events.map((event) => event.id), ['000010']);
});

test('GET /api/devices/{thing}/samples gives the readings of the last hours, oldest first, thinned', async () => {
  const { console_, fake, viewer } = history();
  const { status, body } = await console_.call('GET', `/api/devices/${THING}/samples`, { as: viewer });
  assert.equal(status, 200);
  assert.equal(body.hours, 24);
  assert.equal(body.bucketSeconds, 0);
  assert.deepEqual(body.samples.map((sample) => sample.uptime), [600, 5]);
  assert.deepEqual(Object.keys(body.samples[0]), ['at', 'rssi', 'uptime', 'heapFree', 'heapLeast']);
  assert.deepEqual((await console_.call('GET', `/api/devices/${THING}/samples`, { as: viewer, query: { hours: '1' } })).body.samples, []);

  // A week of a board on 1.10.0: far more than a chart needs.
  const store = fake.eventStore();
  const end = console_.clock.ms;
  for (let index = 0; index < 2000; index += 1) {
    const at = end - index * 60_000;
    await store.putEvent({ pk: OTHER, sk: `S#${new Date(at).toISOString()}`, rssi: -50 - (index % 10), uptime: 99999 - index,
      heapFree: 20000 + index, heapLeast: 9000, ttl: at / 1000 + 7 * 86400 });
  }
  const week = (await console_.call('GET', `/api/devices/${OTHER}/samples`, { as: viewer, query: { hours: '168' } })).body;
  assert.equal(week.samples.length <= 600, true);
  assert.ok(week.bucketSeconds > 0);
  assert.deepEqual(week.samples.map((sample) => sample.at), [...week.samples.map((sample) => sample.at)].sort());
  assert.ok(week.samples.every((sample) => sample.heapLeast === 9000));
});

test('GET /api/devices/{thing}/samples refuses what it cannot answer', async () => {
  const { console_, viewer } = history();
  const refused = async (path, query, code, status = 400) => {
    const answer = await console_.call('GET', path, { as: viewer, query });
    assert.equal(answer.status, status);
    assert.equal(answer.body.error.code, code);
  };
  for (const hours of ['0', '169', '1.5', 'day', '-1', '024x']) {
    await refused(`/api/devices/${THING}/samples`, { hours }, 'invalid_hours');
  }
  await refused('/api/devices/cranium-XYZ/samples', undefined, 'invalid_thing');
  await refused('/api/devices/cranium-1111111111111111/samples', undefined, 'unknown_device', 404);
  await refused('/api/devices/cranium-2222222222222222/samples', undefined, 'unknown_device', 404);
});
