// Tests for the Memfault forwarder (src/forwarder.mjs, MemfaultFn, docs/memfault.md): what a frame must be,
// what is posted to Memfault and how, when a board is answered and when not, and the project key's cache.
// The store is a stand-in that records every call; src/aws-memfault.mjs has its own tests.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHUNK_MAX, FRAME_HEADER, KEY_CACHE_MS, ackPayload, createForwarder, readFrame, verdictOf,
} from '../src/forwarder.mjs';

const THING = 'cranium-0123456789abcdef';
const KEY = 'AbCdEf0123456789AbCdEf0123456789';

/** A frame as the firmware makes it: version, sequence number big-endian, the chunk. */
function frame(seq, chunk, version = 1) {
  const bytes = Buffer.alloc(FRAME_HEADER + chunk.length);
  bytes[0] = version;
  bytes.writeUInt16BE(seq, 1);
  Buffer.from(chunk).copy(bytes, FRAME_HEADER);
  return bytes.toString('base64');
}

const message = (seq, chunk, extra = {}) => ({ frame: frame(seq, chunk), thing: THING, received: 1_700_000_000_000, ...extra });

function world({ key = `${KEY}\n`, status = 202, post = null, publish = null } = {}) {
  const clock = { ms: Date.UTC(2026, 10, 4, 12) };
  const calls = { keys: 0, posts: [], acks: [] };
  const logs = [];
  let draws = 0;
  const store = {
    async readProjectKey() {
      calls.keys += 1;
      return typeof key === 'function' ? key() : key;
    },
    async postChunk(input) {
      calls.posts.push({ ...input, chunk: Buffer.from(input.chunk) });
      if (post !== null) return post(input);
      return { status };
    },
    async publishAck(input) {
      if (publish !== null) await publish(input);
      calls.acks.push(input);
    },
  };
  const handler = createForwarder({
    store,
    now: () => clock.ms,
    log: (line) => logs.push(line),
    randomHex: (count) => {
      draws += 1;
      return String(draws).padStart(2 * count, 'a').slice(0, 2 * count);
    },
  });
  return { handler, calls, logs, clock, setKey: (value) => { key = value; }, setStatus: (value) => { status = value; } };
}

test('a frame is version 1, a big-endian sequence number and one chunk of 1 to 460 bytes', () => {
  const read = readFrame(message(0x1234, [9, 8, 7]));
  assert.deepEqual([read.thing, read.seq, [...read.chunk]], [THING, 0x1234, [9, 8, 7]]);
  assert.equal(readFrame(message(65535, [1])).seq, 65535);
  assert.equal(readFrame(message(0, Buffer.alloc(CHUNK_MAX, 1))).chunk.length, CHUNK_MAX);

  const ignored = (input) => readFrame(input).ignored;
  assert.equal(ignored(null), 'not_a_message');
  assert.equal(ignored([message(1, [1])]), 'not_a_message');
  assert.equal(ignored(message(1, [1], { thing: 'cranium-ZZ' })), 'bad_thing');
  assert.equal(ignored(message(1, [1], { thing: undefined })), 'bad_thing');
  assert.equal(ignored({ thing: THING }), 'bad_frame');
  assert.equal(ignored({ thing: THING, frame: 'not base64!' }), 'bad_frame');
  assert.equal(ignored({ thing: THING, frame: 'AQID' + '=' }), 'bad_frame');
  // The header alone, and one byte over the largest chunk.
  assert.equal(ignored({ thing: THING, frame: Buffer.from([1, 0, 1]).toString('base64') }), 'frame_size');
  assert.equal(ignored(message(1, Buffer.alloc(CHUNK_MAX + 1, 1))), 'frame_size');
  assert.equal(ignored({ thing: THING, frame: frame(1, [1], 2) }), 'frame_version');
  // The board is named in what is ignored only when it is a board's name.
  assert.equal(readFrame({ thing: THING, frame: frame(1, [1], 0) }).thing, THING);
  assert.equal(readFrame(message(1, [1], { thing: 'x' })).thing, undefined);
});

test('the chunk goes to Memfault without the frame\'s header, and the board is answered with its sequence number', async () => {
  const { handler, calls, logs } = world();
  assert.deepEqual(await handler(message(513, [0xa1, 0xb2, 0xc3, 0xd4])), { outcome: 'forwarded' });
  assert.equal(calls.posts.length, 1);
  const [post] = calls.posts;
  assert.equal(post.thing, THING);
  assert.deepEqual([...post.chunk], [0xa1, 0xb2, 0xc3, 0xd4]);
  // The key as stored, without the line break the file had.
  assert.equal(post.key, KEY);

  assert.equal(calls.acks.length, 1);
  const [ack] = calls.acks;
  assert.equal(ack.thing, THING);
  assert.deepEqual(Object.keys(ack.payload), ['id', 'cmd', 'seq']);
  assert.match(ack.payload.id, /^[0-9a-f]{16}$/);
  assert.equal(ack.payload.cmd, 'memfault_ack');
  assert.equal(ack.payload.seq, 513);
  // What the firmware's strict command parser reads (firmware/app/src/command.h).
  assert.match(JSON.stringify(ack.payload), /^\{"id":"[0-9a-f]{16}","cmd":"memfault_ack","seq":513\}$/);

  assert.deepEqual(logs, [{ event: 'chunk_forwarded', thing: THING, seq: 513, bytes: 4, status: 202, answered: true }]);
  assert.equal(JSON.stringify(logs).includes(KEY), false);
});

test('every answer has an id of its own', async () => {
  const { handler, calls } = world();
  for (let seq = 0; seq < 4; seq += 1) await handler(message(seq, [seq + 1]));
  assert.deepEqual(calls.acks.map((ack) => ack.payload.seq), [0, 1, 2, 3]);
  assert.equal(new Set(calls.acks.map((ack) => ack.payload.id)).size, 4);
  assert.deepEqual(ackPayload(7, 'aaaaaaaaaaaaaaaa'), { id: 'aaaaaaaaaaaaaaaa', cmd: 'memfault_ack', seq: 7 });
});

test('without a project key the chunk is dropped with one line, nothing is posted, and the board is not answered', async () => {
  for (const key of [null, '', '   \n', 'no', 'has spaces in it but is long enough to be one', 42]) {
    const { handler, calls, logs } = world({ key });
    assert.deepEqual(await handler(message(9, [1, 2])), { outcome: 'dropped' });
    assert.deepEqual([calls.posts.length, calls.acks.length], [0, 0], String(key));
    assert.deepEqual(logs, [{ level: 'warn', event: 'chunk_dropped', reason: 'no_project_key', thing: THING, seq: 9 }]);
  }
});

test('a key that cannot be read drops the chunk unanswered, and is asked for again with the next one', async () => {
  let fail = true;
  const { handler, calls, logs } = world({
    key: () => {
      if (fail) throw Object.assign(new Error('GetSecretValue: AccessDeniedException'), { name: 'AwsError', code: 'failed' });
      return KEY;
    },
  });
  assert.deepEqual(await handler(message(1, [1])), { outcome: 'dropped' });
  assert.equal(logs[0].event, 'chunk_dropped');
  assert.equal(logs[0].reason, 'key_unreadable');
  assert.equal(calls.acks.length, 0);
  fail = false;
  assert.deepEqual(await handler(message(1, [1])), { outcome: 'forwarded' });
  assert.equal(calls.keys, 2);
});

test('the key is read once in five minutes, a key that is missing too, and again after that', async () => {
  const context = world({ key: null });
  const { handler, calls, clock } = context;
  await handler(message(1, [1]));
  await handler(message(1, [1]));
  assert.equal(calls.keys, 1);
  // Stored meanwhile: it is seen once the five minutes are over.
  context.setKey(KEY);
  clock.ms += KEY_CACHE_MS - 1;
  assert.deepEqual(await handler(message(1, [1])), { outcome: 'dropped' });
  clock.ms += 1;
  assert.deepEqual(await handler(message(1, [1])), { outcome: 'forwarded' });
  assert.equal(calls.keys, 2);
  for (let count = 0; count < 5; count += 1) await handler(message(2 + count, [1]));
  assert.equal(calls.keys, 2);
});

test('what Memfault refuses for good is answered all the same, so that the board moves on', async () => {
  for (const status of [400, 404, 413, 422]) {
    const { handler, calls, logs } = world({ status });
    assert.deepEqual(await handler(message(3, [1, 2, 3])), { outcome: 'refused' }, String(status));
    assert.equal(calls.acks.length, 1);
    assert.equal(calls.acks[0].payload.seq, 3);
    assert.deepEqual(logs, [{ level: 'warn', event: 'chunk_refused', thing: THING, seq: 3, bytes: 3, status, answered: true }]);
  }
});

test('a busy or failing Memfault, a lost post and a time-out are not answered: the board tries again', async () => {
  for (const status of [408, 429, 500, 502, 503, 504, 302, 100]) {
    const { handler, calls, logs } = world({ status });
    assert.deepEqual(await handler(message(4, [1])), { outcome: 'failed' }, String(status));
    assert.equal(calls.acks.length, 0, String(status));
    assert.deepEqual(logs, [{ level: 'warn', event: 'chunk_failed', thing: THING, seq: 4, bytes: 1, status }]);
  }
  for (const code of ['timeout', 'network']) {
    const { handler, calls, logs } = world({
      post: () => { throw Object.assign(new Error('POST chunks: TimeoutError'), { name: 'ChunkPostError', code }); },
    });
    assert.deepEqual(await handler(message(5, [1])), { outcome: 'failed' });
    assert.equal(calls.acks.length, 0);
    assert.equal(logs[0].event, 'chunk_failed');
    assert.equal(logs[0].error.code, code);
  }
});

test('a key Memfault refuses is not answered, and is read again before the next chunk', async () => {
  for (const status of [401, 403]) {
    const context = world({ status });
    const { handler, calls, logs } = context;
    assert.deepEqual(await handler(message(6, [1])), { outcome: 'failed' });
    assert.equal(calls.acks.length, 0);
    assert.deepEqual(logs, [{ level: 'error', event: 'chunk_failed', reason: 'key_refused', thing: THING, seq: 6, bytes: 1, status }]);
    context.setStatus(202);
    assert.deepEqual(await handler(message(6, [1])), { outcome: 'forwarded' });
    assert.equal(calls.keys, 2, String(status));
  }
});

test('an answer that cannot be published is logged and not thrown', async () => {
  const { handler, calls, logs } = world({
    publish: () => { throw Object.assign(new Error('Publish: InternalFailureException'), { name: 'AwsError', code: 'failed' }); },
  });
  assert.deepEqual(await handler(message(7, [1])), { outcome: 'forwarded' });
  assert.equal(calls.acks.length, 0);
  assert.equal(logs[0].event, 'ack_failed');
  assert.equal(logs[0].seq, 7);
  assert.deepEqual(logs[1], { event: 'chunk_forwarded', thing: THING, seq: 7, bytes: 1, status: 202, answered: false });
});

test('a frame that breaks the contract is dropped unanswered, and its bytes are never logged', async () => {
  const { handler, calls, logs } = world();
  const secretish = Buffer.from('chunk bytes the log must not have');
  assert.deepEqual(await handler({ thing: THING, frame: frame(1, secretish, 2) }), { outcome: 'ignored' });
  assert.deepEqual(await handler({ thing: 'not-a-board', frame: frame(1, secretish) }), { outcome: 'ignored' });
  assert.deepEqual([calls.keys, calls.posts.length, calls.acks.length], [0, 0, 0]);
  assert.deepEqual(logs, [
    { level: 'warn', event: 'frame_ignored', reason: 'frame_version', thing: THING },
    { level: 'warn', event: 'frame_ignored', reason: 'bad_thing' },
  ]);
  assert.equal(JSON.stringify(logs).includes('chunk bytes'), false);
});

test('what each status from Memfault means', () => {
  assert.deepEqual([200, 201, 202, 204, 299].map(verdictOf), Array(5).fill('forwarded'));
  assert.deepEqual([401, 403].map(verdictOf), ['key_refused', 'key_refused']);
  assert.deepEqual([400, 404, 409, 413, 499].map(verdictOf), Array(5).fill('refused'));
  assert.deepEqual([408, 429, 500, 503, 301, 0].map(verdictOf), Array(6).fill('failed'));
  assert.throws(() => createForwarder({}), /needs a store/);
});
