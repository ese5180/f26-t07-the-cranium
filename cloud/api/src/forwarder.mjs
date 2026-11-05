/**
 * The Memfault forwarder (MemfaultFn, docs/memfault.md): a board's Memfault chunks, from its own MQTT
 * connection to Memfault's chunks API.
 *
 * From firmware 1.14.0 a board publishes one frame at a time on cranium/<thing>/memfault, and the rule
 * MemfaultRule (infra/template.yaml) hands it over as { frame: <base64>, thing, received }. A frame is
 *
 *   byte 0      1, the version of the frame
 *   bytes 1-2   the frame's sequence number, big-endian
 *   bytes 3...  one Memfault chunk, 1 to CHUNK_MAX bytes, exactly as the Memfault SDK's packetizer made it
 *
 * For each frame:
 *
 *   1. hold it to that contract; a frame that breaks it is dropped, with a line in the log that names
 *      the board if it can and why, never what the frame held, and the board is not answered
 *   2. read the project key from AWS Secrets Manager, kept for KEY_CACHE_MS. Without one the chunk is
 *      dropped with one line in the log (chunk_dropped, no_project_key) and the board is not answered:
 *      it keeps the chunk and sends it again later, so that nothing is lost while no key is stored
 *   3. post the chunk, without the frame's three bytes, to https://<host>/api/v0/chunks/<thing>
 *   4. Memfault took it (2xx): answer the board on cranium/<thing>/commands with
 *      { id, cmd: "memfault_ack", seq }, and it sends the next one. Memfault refused it for good (a 4xx
 *      other than 401, 403, 408 and 429): say so and answer all the same, since sending it again changes
 *      nothing. A refused key (401, 403), a busy or failing Memfault and a post that did not get
 *      through are not answered: the board tries again, and a refused key is read again first.
 *
 * Nothing here ever logs the key, the chunk or what Memfault answered beyond its status. A failed answer
 * to the board is logged and not thrown: Lambda does not try this function again (MemfaultFnInvokeConfig),
 * and the board sends the chunk again when no answer comes.
 *
 * Like app.mjs, nothing here imports the AWS SDK: the store is passed in (aws-memfault.mjs createMemfaultStore).
 */

import { randomBytes } from 'node:crypto';

import { describeError } from './http.mjs';
import { isThing } from './lib/validate.mjs';

export const FRAME_VERSION = 1;
export const FRAME_HEADER = 3;
// The firmware sends at most 400 bytes of chunk (CONFIG_APP_MEMFAULT_CHUNK_MAX); its MQTT buffer holds 460.
export const CHUNK_MAX = 460;
export const KEY_CACHE_MS = 5 * 60_000;
export const ACK_COMMAND = 'memfault_ack';

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// Memfault project keys are 32 letters and digits. A value that does not look like a key is none.
const PROJECT_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const ACK_ID = /^[0-9a-f]{16}$/;

/**
 * Read a message of MemfaultRule. Returns { thing, seq, chunk } or { ignored: reason, thing? }, where thing is
 * there only if it is a board's name.
 */
export function readFrame(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return { ignored: 'not_a_message' };
  const { thing, frame } = message;
  if (!isThing(thing)) return { ignored: 'bad_thing' };
  if (typeof frame !== 'string' || !BASE64.test(frame)) return { ignored: 'bad_frame', thing };
  const bytes = Buffer.from(frame, 'base64');
  if (bytes.length < FRAME_HEADER + 1 || bytes.length > FRAME_HEADER + CHUNK_MAX) return { ignored: 'frame_size', thing };
  if (bytes[0] !== FRAME_VERSION) return { ignored: 'frame_version', thing };
  return { thing, seq: bytes.readUInt16BE(1), chunk: bytes.subarray(FRAME_HEADER) };
}

/** The answer to a board for the frame with this sequence number, as its command parser reads it (command.h). */
export function ackPayload(seq, id) {
  return { id, cmd: ACK_COMMAND, seq };
}

/** What a status from Memfault's chunks API means for the frame: forwarded, refused, key_refused or failed. */
export function verdictOf(status) {
  if (status >= 200 && status < 300) return 'forwarded';
  if (status === 401 || status === 403) return 'key_refused';
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return 'refused';
  return 'failed';
}

/**
 * @param {object} options
 * @param {{ readProjectKey: () => Promise<string|null>,
 *           postChunk: ({ thing, chunk, key }) => Promise<{ status: number }>,
 *           publishAck: ({ thing, payload }) => Promise<void> }} options.store   aws-memfault.mjs createMemfaultStore
 * @param {() => number|Date} [options.now]
 * @param {(count: number) => string} [options.randomHex]
 * @param {(line: object) => void} [options.log]
 * @returns {(message: object) => Promise<{ outcome: string }>} the Lambda handler
 */
export function createForwarder({
  store,
  now = Date.now,
  randomHex = (count) => randomBytes(count).toString('hex'),
  log = (line) => console.log(JSON.stringify(line)),
}) {
  if (store === undefined || store === null) throw new TypeError('createForwarder needs a store');
  const clock = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : value;
  };
  // The key as last read, or null for none, and when: { key, at }.
  let cached = null;

  /** The project key, or null when none is stored. A read that fails is not kept. */
  async function projectKey() {
    if (cached !== null && clock() - cached.at < KEY_CACHE_MS) return cached.key;
    const value = await store.readProjectKey();
    const key = typeof value === 'string' && PROJECT_KEY.test(value.trim()) ? value.trim() : null;
    cached = { key, at: clock() };
    return key;
  }

  /** 16 hex digits for an answer, from the CSPRNG. */
  function ackId() {
    const drawn = String(randomHex(8)).slice(0, 16);
    return ACK_ID.test(drawn) ? drawn : randomBytes(8).toString('hex');
  }

  async function answer(thing, seq) {
    try {
      await store.publishAck({ thing, payload: ackPayload(seq, ackId()) });
      return true;
    } catch (error) {
      log({ level: 'error', event: 'ack_failed', thing, seq, error: describeError(error) });
      return false;
    }
  }

  return async function handler(message) {
    const frame = readFrame(message);
    if (frame.ignored !== undefined) {
      log({ level: 'warn', event: 'frame_ignored', reason: frame.ignored, ...(frame.thing ? { thing: frame.thing } : {}) });
      return { outcome: 'ignored' };
    }
    const { thing, seq, chunk } = frame;

    let key;
    try {
      key = await projectKey();
    } catch (error) {
      log({ level: 'error', event: 'chunk_dropped', reason: 'key_unreadable', thing, seq, error: describeError(error) });
      return { outcome: 'dropped' };
    }
    if (key === null) {
      log({ level: 'warn', event: 'chunk_dropped', reason: 'no_project_key', thing, seq });
      return { outcome: 'dropped' };
    }

    let status;
    try {
      ({ status } = await store.postChunk({ thing, chunk, key }));
    } catch (error) {
      log({ level: 'warn', event: 'chunk_failed', thing, seq, bytes: chunk.length, error: describeError(error) });
      return { outcome: 'failed' };
    }

    const verdict = verdictOf(status);
    if (verdict === 'forwarded') {
      const answered = await answer(thing, seq);
      log({ event: 'chunk_forwarded', thing, seq, bytes: chunk.length, status, answered });
      return { outcome: 'forwarded' };
    }
    if (verdict === 'refused') {
      const answered = await answer(thing, seq);
      log({ level: 'warn', event: 'chunk_refused', thing, seq, bytes: chunk.length, status, answered });
      return { outcome: 'refused' };
    }
    if (verdict === 'key_refused') {
      // Read again with the next chunk: the key may have been replaced since.
      cached = null;
      log({ level: 'error', event: 'chunk_failed', reason: 'key_refused', thing, seq, bytes: chunk.length, status });
      return { outcome: 'failed' };
    }
    log({ level: 'warn', event: 'chunk_failed', thing, seq, bytes: chunk.length, status });
    return { outcome: 'failed' };
  };
}
