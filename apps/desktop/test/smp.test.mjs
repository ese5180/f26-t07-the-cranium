// CBOR and MCUmgr's SMP against a stand-in board: the image list, an upload in chunks, answers split
// over notifications, the largest packet the link carries, refusals and silence.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { CborError, decode, encode } from '../src/lib/cbor.mjs';
import {
  GROUP_IMAGE,
  HEADER_BYTES,
  IMAGE_STATE,
  IMAGE_UPLOAD,
  OP,
  SmpError,
  chunkBytes,
  createReassembler,
  createSmpClient,
  imagesOf,
  packet,
} from '../src/lib/smp.mjs';

test('CBOR: what MCUmgr sends, both ways, and the indefinite maps zcbor writes', () => {
  const value = {
    rc: 0,
    off: 70000,
    n: -3,
    ok: true,
    no: false,
    nothing: null,
    text: 'é',
    bytes: new Uint8Array([1, 2]),
    list: [1, 'a'],
  };
  assert.deepEqual(decode(encode(value)).value, value);
  // {_ "images": [_ {_ "slot": 0, "version": "1.14.0" } ] } in indefinite form.
  const indefinite = Uint8Array.from([
    0xbf,
    0x66,
    ...Buffer.from('images'),
    0x9f,
    0xbf,
    0x64,
    ...Buffer.from('slot'),
    0x00,
    0x67,
    ...Buffer.from('version'),
    0x66,
    ...Buffer.from('1.14.0'),
    0xff,
    0xff,
    0xff,
  ]);
  assert.deepEqual(decode(indefinite).value, { images: [{ slot: 0, version: '1.14.0' }] });
  assert.equal(decode(Uint8Array.from([0xf9, 0x3c, 0x00])).value, 1);
  assert.throws(() => decode(Uint8Array.from([0x63, 0x61])), CborError);
  assert.throws(() => decode(Uint8Array.from([0xff])), CborError);
  assert.throws(() => encode(1.5), CborError);
});

test('CBOR: a break only ends something of indefinite length, and "__proto__" is a key like any other', () => {
  // [1, break]: an array of one whose item is a break. It came back as [Symbol(break)].
  assert.throws(() => decode(Uint8Array.from([0x81, 0xff])), CborError);
  // {break}: a map of one whose key is a break. It came back as {}.
  assert.throws(() => decode(Uint8Array.from([0xa1, 0xff])), CborError);
  // A tag on a break.
  assert.throws(() => decode(Uint8Array.from([0xc0, 0xff])), CborError);
  // (_ "a", 1): an indefinite text string with a number for a chunk. It came back as "a1".
  assert.throws(() => decode(Uint8Array.from([0x7f, 0x61, 0x61, 0x01, 0xff])), CborError);
  // {"__proto__": {"images": []}}: an own key, not the map's prototype.
  const proto = Uint8Array.from([0xa1, 0x69, ...Buffer.from('__proto__'), 0xa1, 0x66, ...Buffer.from('images'), 0x80]);
  const map = decode(proto).value;
  assert.equal(Object.getPrototypeOf(map), Object.prototype);
  assert.equal(map.images, undefined);
  assert.deepEqual(Object.keys(map), ['__proto__']);
  assert.deepEqual(Object.getOwnPropertyDescriptor(map, '__proto__').value, { images: [] });
  // What zcbor sends still reads: indefinite strings of chunks of their own kind.
  assert.equal(decode(Uint8Array.from([0x7f, 0x61, 0x61, 0x61, 0x62, 0xff])).value, 'ab');
  assert.deepEqual([...decode(Uint8Array.from([0x5f, 0x41, 0x01, 0x41, 0x02, 0xff])).value], [1, 2]);
});

/** A board that answers SMP: its image list, and uploads, as Zephyr's img_mgmt does. */
function standInBoard({ maxPacket = 512, split = 20, silentFor = new Set() } = {}) {
  const received = [];
  let notify = () => {};
  let image = null;
  const board = {
    attach(listener) {
      notify = listener;
    },
    received,
    get image() {
      return image;
    },
    async write(bytes) {
      if (bytes.length > maxPacket) return; // a write the link cannot carry never arrives whole
      const op = bytes[0];
      const group = (bytes[4] << 8) | bytes[5];
      const sequence = bytes[6];
      const command = bytes[7];
      const body = decode(bytes, HEADER_BYTES).value;
      received.push({ op, group, command, body });
      if (silentFor.has(command)) return;
      let answer;
      if (group === GROUP_IMAGE && command === IMAGE_STATE) {
        answer = {
          images: [
            { slot: 0, version: '1.13.0', active: true, confirmed: true },
            { image: 1, slot: 0, version: '9.9.9' },
            { slot: 1, version: '1.14.0', pending: true },
          ],
        };
      } else if (group === GROUP_IMAGE && command === IMAGE_UPLOAD) {
        if (body.off === 0) image = { len: body.len, sha: body.sha, data: [] };
        image.data.push(...body.data);
        answer = { rc: 0, off: image.data.length };
      } else {
        answer = { rc: 8 };
      }
      const reply = packet({ op: op + 1, group, sequence, command, body: answer });
      // Split over several notifications, as a link with a small MTU does.
      queueMicrotask(() => {
        for (let at = 0; at < reply.length; at += split) notify(reply.subarray(at, at + split));
      });
    },
  };
  return board;
}

function clientFor(board) {
  const client = createSmpClient({ write: (bytes) => board.write(bytes) });
  board.attach((bytes) => client.notified(bytes));
  return client;
}

test("the image list: image 0's slots only, as ble.images gives them", async () => {
  const client = clientFor(standInBoard());
  assert.deepEqual(await client.images(), [
    { slot: 0, version: '1.13.0', active: true, confirmed: true, pending: false, permanent: false },
    { slot: 1, version: '1.14.0', active: false, confirmed: false, pending: true, permanent: false },
  ]);
  assert.deepEqual(imagesOf(null), []);
});

test('an upload goes in chunks that fit the largest packet the link carries, each once the board has the one before', async () => {
  const board = standInBoard({ maxPacket: 244 });
  const client = clientFor(board);
  const image = new Uint8Array(5000).map((_, index) => index & 0xff);
  const sha = new Uint8Array(createHash('sha256').update(image).digest());
  const progress = [];
  await client.upload(image, sha, { progress: (sent, total) => progress.push([sent, total]), cancelled: () => false });
  assert.deepEqual(Uint8Array.from(board.image.data), image);
  assert.equal(board.image.len, 5000);
  assert.deepEqual(board.image.sha, sha);
  assert.deepEqual(progress.at(-1), [5000, 5000]);
  // The probe found 244: no packet above it was sent after it.
  assert.equal(await client.packetSize(), 244);
  const uploads = board.received.filter((entry) => entry.command === IMAGE_UPLOAD);
  assert.equal(uploads[0].body.image, 0);
  assert.ok(uploads.every((entry) => HEADER_BYTES + encode(entry.body).length <= 244));
  // Never a test, a confirm or a reset: image state is only read.
  assert.ok(
    board.received.every((entry) => (entry.op === OP.write ? entry.command === IMAGE_UPLOAD : entry.op === OP.read))
  );
});

test('an answer split over notifications, and two answers in one, are put back together', () => {
  const reassembler = createReassembler();
  const one = packet({ op: 1, group: 1, sequence: 5, command: 0, body: { rc: 0 } });
  const two = packet({ op: 3, group: 1, sequence: 6, command: 1, body: { off: 9 } });
  assert.deepEqual(reassembler.push(one.subarray(0, 3)), []);
  const both = new Uint8Array([...one.subarray(3), ...two]);
  const got = reassembler.push(both);
  assert.deepEqual(
    got.map((answer) => [answer.sequence, answer.body]),
    [
      [5, { rc: 0 }],
      [6, { off: 9 }],
    ]
  );
});

test("a refusal is the board's rc; silence is a timeout; a cancel stops between chunks", async () => {
  const quiet = standInBoard({ silentFor: new Set([IMAGE_STATE]) });
  const timers = { setTimeout: (fn) => setTimeout(fn, 5), clearTimeout };
  const client = createSmpClient({ write: (bytes) => quiet.write(bytes), timers });
  quiet.attach((bytes) => client.notified(bytes));
  await assert.rejects(client.images(), (error) => error instanceof SmpError && error.timeout);

  const board = standInBoard();
  const other = clientFor(board);
  const image = new Uint8Array(3000);
  let chunks = 0;
  await assert.rejects(
    other.upload(image, new Uint8Array(32), { progress: () => (chunks += 1), cancelled: () => chunks > 2 }),
    (error) => error instanceof SmpError && error.message === 'cancelled'
  );
  assert.ok(chunkBytes(495, { first: true, total: 2_621_440, sha: new Uint8Array(32) }) > 400);
  assert.ok(chunkBytes(100, { first: false, total: 2_621_440, sha: new Uint8Array(32) }) > 70);
});
