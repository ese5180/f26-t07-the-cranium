/**
 * MCUmgr's Simple Management Protocol over the board's SMP characteristic (docs/desktop-app.md,
 * "Bluetooth"): the image list and the image upload, and nothing else. No test, no confirm, no reset:
 * the board decides what becomes of an image (docs/mobile-apps.md, "Bluetooth"), as with the phone apps.
 *
 * A packet is an 8-byte header and a CBOR map:
 *
 *   op (0 read, 1 read answer, 2 write, 3 write answer), flags, length (2 bytes, big end first),
 *   group (2 bytes), sequence, command
 *
 * The page's side writes each request without response; answers come as notifications, perhaps in more
 * than one, and are put back together by their length. One request is in flight at a time.
 *
 * The write and the notifications are passed in (the window's Web Bluetooth, through main.mjs and the
 * preload), so the tests drive this with a stand-in board.
 */

import { CborError, decode, encode } from './cbor.mjs';

export const SMP_SERVICE = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
export const SMP_CHARACTERISTIC = 'da2e7828-fbce-4e01-ae9e-261174997c48';
export const OP = Object.freeze({ read: 0, readAnswer: 1, write: 2, writeAnswer: 3 });
export const GROUP_IMAGE = 1;
export const IMAGE_STATE = 0;
export const IMAGE_UPLOAD = 1;
export const HEADER_BYTES = 8;
// The largest packets tried, largest first: what an ATT MTU of 498 (the board's), 247 and 185 carry in
// one write without response, and the smallest one every link carries. The board's buffers take 512.
export const PACKET_SIZES = Object.freeze([495, 244, 182, 100]);
export const PROBE_TIMEOUT_MS = 2500;
export const ANSWER_TIMEOUT_MS = 10_000;
// The first chunk of an upload may wait for the board to erase its slot.
export const FIRST_CHUNK_TIMEOUT_MS = 45_000;

export class SmpError extends Error {
  constructor(message, { rc = null, timeout = false } = {}) {
    super(message);
    this.name = 'SmpError';
    this.rc = rc;
    this.timeout = timeout;
  }
}

/** A packet's bytes. */
export function packet({ op, group, sequence, command, body }) {
  const payload = encode(body ?? {});
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  out.set([op, 0, payload.length >> 8, payload.length & 0xff, group >> 8, group & 0xff, sequence & 0xff, command]);
  out.set(payload, HEADER_BYTES);
  return out;
}

/** Puts answers back together from notifications: each push gives the whole packets it completed. */
export function createReassembler() {
  let pending = new Uint8Array(0);
  return {
    push(bytes) {
      const joined = new Uint8Array(pending.length + bytes.length);
      joined.set(pending);
      joined.set(bytes, pending.length);
      pending = joined;
      const packets = [];
      while (pending.length >= HEADER_BYTES) {
        const length = (pending[2] << 8) | pending[3];
        if (pending.length < HEADER_BYTES + length) break;
        const whole = pending.slice(0, HEADER_BYTES + length);
        pending = pending.slice(HEADER_BYTES + length);
        let body = null;
        try {
          body = decode(whole, HEADER_BYTES).value;
        } catch (error) {
          if (!(error instanceof CborError)) throw error;
        }
        packets.push({
          op: whole[0] & 0x07,
          group: (whole[4] << 8) | whole[5],
          sequence: whole[6],
          command: whole[7],
          body,
        });
      }
      return packets;
    },
    reset() {
      pending = new Uint8Array(0);
    },
  };
}

/** The error an answer carries, as SMP 1 (rc) or SMP 2 (err: { group, rc }) says it; null when none. */
export function answerError(body) {
  if (body === null || typeof body !== 'object') return 'an answer that does not read';
  if (Number.isInteger(body.rc) && body.rc !== 0) return `the board answered rc ${body.rc}`;
  if (body.err && Number.isInteger(body.err.rc) && body.err.rc !== 0) return `the board answered rc ${body.err.rc}`;
  return null;
}

/** ble.images's list: image 0's slots, as the board lists them. */
export function imagesOf(body) {
  const list = Array.isArray(body?.images) ? body.images : [];
  return list
    .filter((slot) => (slot.image ?? 0) === 0 && Number.isInteger(slot.slot) && typeof slot.version === 'string')
    .map((slot) => ({
      slot: slot.slot,
      version: slot.version,
      active: slot.active === true,
      confirmed: slot.confirmed === true,
      pending: slot.pending === true,
      permanent: slot.permanent === true,
    }));
}

/** How many bytes of image fit in a chunk of an upload, in a packet of `size` bytes. */
export function chunkBytes(size, { first, total, sha }) {
  const bodyFor = (data) =>
    first ? { image: 0, len: total, off: 0, sha, data } : { off: Math.max(total - 1, 0), data };
  let data = size;
  while (data > 0 && HEADER_BYTES + encode(bodyFor(new Uint8Array(data))).length > size) data -= 1;
  return data;
}

/**
 * @param {object} options
 * @param {(bytes: Uint8Array) => Promise<void>} options.write  one write without response to the characteristic
 * @param {(ms: number) => object} [options.timeoutAfter]       setTimeout's stand-in for the tests
 */
export function createSmpClient({ write, timers = globalThis }) {
  const reassembler = createReassembler();
  let sequence = 0;
  let waiting = null;
  let size = null;

  function notified(bytes) {
    for (const answer of reassembler.push(bytes)) {
      if (!waiting) continue;
      const { expect, resolve } = waiting;
      if (answer.sequence === expect.sequence && answer.group === expect.group && answer.command === expect.command) {
        waiting = null;
        resolve(answer);
      }
    }
  }

  async function request({ op, group, command, body, timeoutMs = ANSWER_TIMEOUT_MS, packetSize = size }) {
    if (waiting) throw new SmpError('another request is under way');
    sequence = (sequence + 1) & 0xff;
    const bytes = packet({ op, group, sequence, command, body });
    if (packetSize !== null && bytes.length > packetSize) throw new SmpError('a request larger than the link takes');
    const expect = { sequence, group, command };
    const answer = new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => {
        if (waiting?.expect === expect) waiting = null;
        reject(new SmpError('the board did not answer in time', { timeout: true }));
      }, timeoutMs);
      waiting = {
        expect,
        resolve: (value) => {
          timers.clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          timers.clearTimeout(timer);
          reject(error);
        },
      };
    });
    try {
      await write(bytes);
    } catch (error) {
      const pending = waiting;
      waiting = null;
      pending?.reject(new SmpError(`the write did not go: ${String(error?.message ?? error).slice(0, 80)}`));
    }
    const got = await answer;
    const problem = answerError(got.body);
    if (problem) throw new SmpError(problem, { rc: got.body?.rc ?? got.body?.err?.rc ?? null });
    return got.body;
  }

  /**
   * The largest packet the link carries, found once per link: the image list is asked for with padding
   * the board ignores, at each size in turn, until an answer comes.
   */
  async function packetSize() {
    if (size !== null) return size;
    for (const candidate of PACKET_SIZES) {
      const empty = packet({ op: OP.read, group: GROUP_IMAGE, sequence: 0, command: IMAGE_STATE, body: { pad: new Uint8Array(0) } });
      const pad = new Uint8Array(Math.max(0, candidate - empty.length - 2));
      try {
        await request({
          op: OP.read,
          group: GROUP_IMAGE,
          command: IMAGE_STATE,
          body: { pad },
          timeoutMs: PROBE_TIMEOUT_MS,
          packetSize: candidate,
        });
        size = candidate;
        return size;
      } catch (error) {
        reassembler.reset();
        if (!(error instanceof SmpError)) throw error;
        // A refusal that is an answer (not a timeout) also means the packet got there whole.
        if (error.rc !== null) {
          size = candidate;
          return size;
        }
      }
    }
    throw new SmpError('the board does not answer over Bluetooth');
  }

  async function images() {
    // The first request on a link is also the one that makes the computer pair, so it may take a while.
    const body = await request({ op: OP.read, group: GROUP_IMAGE, command: IMAGE_STATE, body: {}, timeoutMs: 90_000 });
    return imagesOf(body);
  }

  /**
   * Upload an image, chunk after chunk, each once the board has taken the one before.
   *
   * @param {Uint8Array} image
   * @param {Uint8Array} sha  its SHA-256, 32 bytes
   * @param {{ progress(sent: number, total: number): void, cancelled(): boolean }} hooks
   */
  async function upload(image, sha, { progress, cancelled }) {
    const link = await packetSize();
    let offset = 0;
    progress(0, image.length);
    while (offset < image.length) {
      if (cancelled()) throw new SmpError('cancelled');
      const first = offset === 0;
      const room = chunkBytes(link, { first, total: image.length, sha });
      const data = image.subarray(offset, offset + room);
      const body = first ? { image: 0, len: image.length, off: 0, sha, data } : { off: offset, data };
      const answer = await request({
        op: OP.write,
        group: GROUP_IMAGE,
        command: IMAGE_UPLOAD,
        body,
        timeoutMs: first ? FIRST_CHUNK_TIMEOUT_MS : ANSWER_TIMEOUT_MS,
      });
      const next = Number.isInteger(answer?.off) ? answer.off : offset + data.length;
      if (next <= offset && next !== image.length) throw new SmpError('the board did not take the chunk');
      offset = Math.min(next, image.length);
      progress(offset, image.length);
    }
  }

  return Object.freeze({
    notified,
    images,
    upload,
    packetSize,
    /** The link went: whatever was asked fails, and the next link finds its size again. */
    reset() {
      const pending = waiting;
      waiting = null;
      size = null;
      reassembler.reset();
      pending?.reject(new SmpError('the link went'));
    },
  });
}
