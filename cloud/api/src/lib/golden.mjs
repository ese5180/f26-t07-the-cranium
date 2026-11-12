/**
 * Golden image promotion records and their jobs (firmware 1.22.0, firmware/README.md "Golden image").
 *
 * A promotion record is 130 bytes, signed offline with the golden key (tools/golden_promote.py
 * sign), and names one signed image: its hash TLV, size and version, under a golden counter that only
 * goes up. The format is firmware/app/sysbuild/mcuboot/golden/src/golden_record.h:
 *
 *   0 "CGLD" | 4 format 1 | 5 three zero bytes | 8 counter u32 | 12 size u32 |
 *   16 major u8, minor u8, revision u16, build u32 | 24 SHA-256 (32) |
 *   56 signature length | 57 zero | 58 signature, DER, zero after it (72)
 *
 * all little-endian, the ECDSA P-256 signature over bytes 0 to 55. The console checks the signature
 * with the golden PUBLIC key and that the record names the release it is uploaded for; it can never
 * make one. The board's bootloader checks it again, with the key compiled into it, and seals the image
 * only if the board runs it, has confirmed it, and has taken no higher counter.
 *
 * A promotion is an AWS IoT job with the document
 *
 *   { "op": "golden_promote", "v": 1, "record": "<260 lower-case hex digits>" }
 *
 * and an id gold-<major>-<minor>-<revision>-b<build>-c<counter>-<yyyymmddThhmmssZ>-<4 hex>, at most the 64
 * characters AWS IoT allows, which deployments (lib/jobs.mjs) never take for one of theirs.
 */

import { createPublicKey, verify } from 'node:crypto';

import { strictVersion } from './validate.mjs';

export const RECORD_SIZE = 130;
const SIGNED = 56;
const SIG_MIN = 8;
const SIG_MAX = 72;
const MAGIC = Buffer.from('CGLD', 'ascii');
const MAX_COUNTER = 0xffffffff;

export class RecordError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** A record's fields, as the board reads them. Throws RecordError for anything malformed. */
export function parseRecord(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== RECORD_SIZE) {
    throw new RecordError('record_size', `A promotion record is ${RECORD_SIZE} bytes.`);
  }
  if (!bytes.subarray(0, 4).equals(MAGIC) || bytes[4] !== 1 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) {
    throw new RecordError('record_format', 'This is not a promotion record of format 1.');
  }
  const counter = bytes.readUInt32LE(8);
  const size = bytes.readUInt32LE(12);
  const sigLength = bytes[SIGNED];
  if (counter === 0 || size === 0 || bytes[SIGNED + 1] !== 0 || sigLength < SIG_MIN || sigLength > SIG_MAX) {
    throw new RecordError('record_format', "The record's counter, size or signature length is not usable.");
  }
  if (bytes.subarray(SIGNED + 2 + sigLength).some((byte) => byte !== 0)) {
    throw new RecordError('record_format', 'The record has bytes after its signature.');
  }
  const version = `${bytes[16]}.${bytes[17]}.${bytes.readUInt16LE(18)}+${bytes.readUInt32LE(20)}`;
  return {
    counter,
    size,
    version,
    imageHash: bytes.subarray(24, SIGNED).toString('hex'),
    signed: bytes.subarray(0, SIGNED),
    signature: bytes.subarray(SIGNED + 2, SIGNED + 2 + sigLength),
  };
}

/** The golden public key from the base64 DER the stack holds, or null when the stack has none. */
export function loadGoldenKey(base64) {
  if (typeof base64 !== 'string' || base64 === '') return null;
  const key = createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('The golden key is not an ECDSA P-256 public key');
  }
  return key;
}

/** Whether the record's signature is good with the golden key. */
export function signatureOk(record, key) {
  try {
    return verify('sha256', record.signed, { key, dsaEncoding: 'der' }, record.signature);
  } catch {
    return false;
  }
}

/**
 * Why a record does not belong to a release, or null when it does: the same image (hash TLV, size and
 * version) that the console verified when the release was uploaded.
 */
export function mismatch(record, release) {
  if (strictVersion(record.version)?.text !== release.version) {
    return `The record is for ${record.version}, not ${release.version}.`;
  }
  if (record.size !== release.size) return `The record names an image of ${record.size} bytes, not ${release.size}.`;
  if (record.imageHash !== release.imageHash) return "The record's SHA-256 is not this release's image hash.";
  return null;
}

/** The job document for a record, which the board parses in a small buffer. */
export function buildGoldenDocument(recordBytes) {
  if (!Buffer.isBuffer(recordBytes) || recordBytes.length !== RECORD_SIZE) {
    throw new TypeError(`The record is not ${RECORD_SIZE} bytes`);
  }
  return JSON.stringify({ op: 'golden_promote', v: 1, record: recordBytes.toString('hex') });
}

const ID = /^gold-(\d{1,3})-(\d{1,3})-(\d{1,5})-b(\d{1,10})-c(\d{1,10})-(\d{8}T\d{6}Z)-([0-9a-f]{4})$/;

/** The id of a new promotion job: at most 64 characters, as AWS IoT allows. */
export function buildGoldenJobId(version, counter, nowMs, suffix) {
  const parsed = strictVersion(version);
  if (parsed === null) throw new TypeError('The version is not usable');
  if (!Number.isInteger(counter) || counter < 1 || counter > MAX_COUNTER)
    throw new TypeError('The counter is not usable');
  if (typeof suffix !== 'string' || !/^[0-9a-f]{4}$/.test(suffix)) throw new TypeError('The suffix is 4 hex digits');
  const stamp = new Date(nowMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const { major, minor, revision, build } = parsed.parts;
  const id = `gold-${major}-${minor}-${revision}-b${build}-c${counter}-${stamp}-${suffix}`;
  if (id.length > 64 || parseGoldenJobId(id) === null)
    throw new TypeError('The version or the time does not make a job id');
  return id;
}

/** What a promotion job's id says, or null when it is not one. */
export function parseGoldenJobId(value) {
  const match = typeof value === 'string' ? ID.exec(value) : null;
  if (match === null) return null;
  const version = strictVersion(`${match[1]}.${match[2]}.${match[3]}+${match[4]}`);
  const counter = Number(match[5]);
  if (version === null || counter < 1 || counter > MAX_COUNTER) return null;
  return { id: value, version: version.text, counter };
}

const STATES = Object.freeze([
  'none',
  'pending',
  'sealed',
  'bad_record',
  'bad_signature',
  'not_newer',
  'not_running',
  'not_confirmed',
  'flash_error',
  'unknown',
]);

/**
 * What a board says of its golden image, from firmware 1.22.0, in the report beside "diag":
 * { "golden": { "version": "1.19.2+0", "counter": 1, "state": "sealed" } }. version is null before the
 * first promotion on a board. Null when there is no such report, or it is not usable.
 */
export function readGolden(reported) {
  const golden = reported?.golden;
  if (golden === null || typeof golden !== 'object' || Array.isArray(golden)) return null;
  const counter = golden.counter;
  const state = golden.state;
  if (!Number.isInteger(counter) || counter < 0 || counter > MAX_COUNTER || !STATES.includes(state)) return null;
  const version = golden.version === null ? null : (strictVersion(golden.version)?.text ?? undefined);
  if (version === undefined) return null;
  return { version, counter, state };
}
