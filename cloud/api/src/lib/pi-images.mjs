/**
 * Raspberry Pi images, updated by blocks through the board (console 2.30.0; docs/pi-delta-update.md, PR #279).
 *
 * The Pi has no network. A board wired to it (an nRF7002 DK running a firmware built with
 * scripts/firmware/build.sh --pi, from 1.20.0) keeps a copy of the Pi's image on an SD card and brings it
 * up to date by downloading only the blocks that changed. The console stores the package, checks it the
 * way the board does, and sends it to boards as an AWS IoT job.
 *
 * The package, as tools/pi_image.py package writes it, is one object:
 *
 *   0                 the manifest header, 512 bytes, signed (decodeManifest below)
 *   512               the table: the SHA-256 of each block, 32 bytes each, in order
 *   a multiple of 4096 the image
 *
 * The header (little-endian) is the board's pi_manifest_decode() in firmware/app/src/pi/pi_delta_fmt.c:
 *
 *   0 "CPDM" | 4 format 1 (u16) | 6 header size 512 (u16) | 8 block size (u32) | 12 block count (u32) |
 *   16 image size (u64) | 24 table offset 512 (u64) | 32 image offset (u64) | 40 image SHA-256 |
 *   72 table SHA-256 | 104 version, 1 to 31 of A-Z a-z 0-9 . _ + -, zero padded (32) | 136 flags 0 (u32) |
 *   140 zeros to 448 | 448 ECDSA P-256 signature over bytes 0 to 447, SHA-256, r then s (64)
 *
 * signed with the firmware signing key, whose public half the board has built in
 * (firmware/keys/fw_signing_pub.pem): the key the console already checks every release with. The header
 * signs the table's hash and the table signs every block, so the board checks every byte it writes.
 *
 * The job (ota_job.c on #279):
 *
 *   { "op": "pi_delta", "v": 1,
 *     "pi": { "version": "2026.11.24-1", "sha256": "<image SHA-256>",
 *             "url": "${aws:iot:s3-presigned-url-v2:https://s3.<region>.amazonaws.com/<bucket>/firmware/pi-...cpd}" } }
 *
 * with an id pi-<version, other characters as "-">-<yyyymmddThhmmssZ>-<4 hex>, which no firmware deployment
 * (lib/jobs.mjs) or golden promotion takes. The board reports on its execution (strings, as AWS IoT keeps them):
 *
 *   IN_PROGRESS  step (manifest, table, compare, blocks), progress (percent), done, total (blocks)
 *   SUCCEEDED    pi_version, generation, fetched (blocks downloaded), changed, bytes, running (its firmware)
 *   FAILED       reason, step, running
 *
 * And, from a Pi build that reports it beside its heartbeat (not yet: see PI_REPORT below), its card in the
 * shadow: "pi": { "card", "version", "generation", "step", "done", "total" } (pi_delta_ota_report()).
 */

import { createHash, verify } from 'node:crypto';

import { asciiJson } from './jobs.mjs';
import { strictVersion } from './validate.mjs';

// The state table's partition of the Pi images (aws.mjs FLEET_PKS): one item per version.
export const PI_PK = 'PIIMG';

// The first firmware that takes a pi_delta job, and only when built with --pi (docs/pi-delta-update.md).
export const PI_FIRST_FIRMWARE = '1.20.0+0';

// The formats: firmware/app/src/pi/pi_delta_fmt.h, and tools/pi_image.py.
export const HEADER_SIZE = 512;
export const SIGNED_SIZE = 448;
export const HASH_SIZE = 32;
const SECTOR = 512;
const MAGIC = Buffer.from('CPDM', 'ascii');
const FORMAT = 1;
const BLOCK_MIN = 4096;
const BLOCK_MAX = 1024 * 1024;
const IMAGE_ALIGN = 4096;
const VERSION_FIELD = 32;
// CONFIG_APP_PI_DELTA_MAX_BLOCKS: the layout a board gives a new card (16 GiB of 64 KiB blocks). More blocks
// than that and a board answers too_large.
export const MAX_BLOCKS = 262144;
// One presigned PUT carries at most 5 GiB (S3's limit for a single upload): a larger package would need a
// multipart upload, which the bucket's write-once rule does not allow today.
export const MAX_PACKAGE_SIZE = 5 * 1024 ** 3;
export const PI_VERSION = /^[A-Za-z0-9._+-]{1,31}$/;

// The URL a browser PUTs the package to is good for an hour; S3 checks it when the upload starts.
export const UPLOAD_EXPIRES_SEC = 3600;
// The download URL in the job: AWS IoT allows an hour at most. An update takes hours; the board asks for its
// job again on a 403 or any failed range, and gets a fresh URL each time.
export const PI_URL_EXPIRES_SEC = 3600;
// The one measured rate: firmware downloads at roughly 10 KB/s (docs/test-results.md). The time limit of a
// job assumes half that, at least 6 hours and at most what AWS IoT allows, 7 days.
export const MEASURED_BYTES_PER_SEC = 10_000;
const SLOW_BYTES_PER_SEC = 5_000;
export const MIN_TIMEOUT_MIN = 6 * 60;
export const MAX_TIMEOUT_MIN = 7 * 24 * 60;

// The board parses the document in a small buffer, before the URL is substituted (lib/jobs.mjs).
const DOCUMENT_LIMIT = 512;
const PI_JOB_ID = /^pi-([A-Za-z0-9_-]{1,31})-(\d{8}T\d{6}Z)-[0-9a-f]{4}$/;
const OBJECT_KEY = /^firmware\/pi-[A-Za-z0-9._~-]{1,31}-[0-9a-f]{64}\.cpd$/;
const HEX64 = /^[0-9a-f]{64}$/;

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.code = 'bad_manifest';
  }
}

const isPowerOfTwo = (value) => value > 0 && (value & (value - 1)) === 0;

/**
 * The fields of a manifest header, with every check the board makes but the signature
 * (pi_manifest_decode()). Throws ManifestError, in words, for anything a board would refuse.
 */
export function decodeManifest(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== HEADER_SIZE) throw new ManifestError('A package header is 512 bytes.');
  if (!raw.subarray(0, 4).equals(MAGIC) || raw.readUInt16LE(4) !== FORMAT || raw.readUInt16LE(6) !== HEADER_SIZE) {
    throw new ManifestError('This is not the header of a Pi image package (CPDM, format 1).');
  }
  const blockSize = raw.readUInt32LE(8);
  const blocks = raw.readUInt32LE(12);
  const imageSize = raw.readBigUInt64LE(16);
  const tableOffset = raw.readBigUInt64LE(24);
  const imageOffset = raw.readBigUInt64LE(32);
  if (!isPowerOfTwo(blockSize) || blockSize < BLOCK_MIN || blockSize > BLOCK_MAX) {
    throw new ManifestError('The block size is not a power of two from 4 KiB to 1 MiB.');
  }
  if (imageSize === 0n || imageSize % BigInt(SECTOR) !== 0n || imageSize > 1n << 48n) {
    throw new ManifestError('The image size is not a whole number of 512-byte sectors.');
  }
  const size = Number(imageSize);
  if (Math.ceil(size / blockSize) !== blocks) throw new ManifestError('The block count does not match the size.');
  if (
    tableOffset !== BigInt(HEADER_SIZE) ||
    imageOffset % BigInt(IMAGE_ALIGN) !== 0n ||
    imageOffset < tableOffset + BigInt(blocks) * BigInt(HASH_SIZE) ||
    imageOffset > 1n << 50n
  ) {
    throw new ManifestError('The offsets of the table and the image do not fit together.');
  }
  const field = raw.subarray(104, 104 + VERSION_FIELD);
  const end = field.indexOf(0);
  const length = end < 0 ? VERSION_FIELD : end;
  const version = field.subarray(0, length).toString('latin1');
  if (length === VERSION_FIELD || !PI_VERSION.test(version) || field.subarray(length).some((byte) => byte !== 0)) {
    throw new ManifestError('The version is not 1 to 31 letters, digits or . _ + -.');
  }
  if (raw.readUInt32LE(136) !== 0) throw new ManifestError('The flags are not 0.');
  if (raw.subarray(140, SIGNED_SIZE).some((byte) => byte !== 0)) {
    throw new ManifestError('The reserved bytes of the header are not zero.');
  }
  return {
    version,
    blockSize,
    blocks,
    imageSize: size,
    imageOffset: Number(imageOffset),
    sha256: raw.subarray(40, 72).toString('hex'),
    tableSha256: raw.subarray(72, 104).toString('hex'),
  };
}

/** Whether the header's signature holds with the project's key, as the board's PSA check: r then s, 64 bytes. */
export function signatureHolds(raw, signingKey) {
  try {
    return verify(
      'sha256',
      raw.subarray(0, SIGNED_SIZE),
      { key: signingKey.key, dsaEncoding: 'ieee-p1363' },
      raw.subarray(SIGNED_SIZE, HEADER_SIZE)
    );
  } catch {
    return false;
  }
}

/** The package's size: the image ends it (tools/pi_image.py verify refuses bytes after it). */
export function packageSize(manifest) {
  return manifest.imageOffset + manifest.imageSize;
}

/** Where the package goes: under firmware/, which the presign role and a board's download prefix allow. */
export function piObjectKey(version, sha256) {
  if (!PI_VERSION.test(version) || !HEX64.test(sha256)) throw new TypeError('Not a Pi version and SHA-256');
  return `firmware/pi-${version.replaceAll('+', '~')}-${sha256}.cpd`;
}

/** The bytes of the table in the package: [first, last], both kept, as a Range header asks. */
export function tableRange(image) {
  return [HEADER_SIZE, HEADER_SIZE + image.blocks * HASH_SIZE - 1];
}

/** Whether a firmware version takes a pi_delta job, if built with --pi: 1.20.0 and later. */
export function takesPiVersion(version) {
  const parsed = strictVersion(version);
  const first = strictVersion(PI_FIRST_FIRMWARE);
  if (parsed === null) return false;
  for (const name of ['major', 'minor', 'revision', 'build']) {
    if (parsed.parts[name] !== first.parts[name]) return parsed.parts[name] > first.parts[name];
  }
  return true;
}

/** Whether a board can take a Pi image now: it reports its card (a Pi build) and has one in it, on 1.20.0 or later. */
export function takesPiDelta(device) {
  return Boolean(device?.pi) && device.pi.card !== 'no_card' && takesPiVersion(device.fw?.version ?? null);
}

// --- the job ---------------------------------------------------------------------------------------

/** The id of a new Pi deployment, as tools/pi_image.py job_id makes it. */
export function buildPiJobId(version, nowMs, suffix) {
  if (!PI_VERSION.test(version)) throw new TypeError('Not a Pi version');
  if (typeof suffix !== 'string' || !/^[0-9a-f]{4}$/.test(suffix)) throw new TypeError('The suffix is 4 hex digits');
  const stamp = new Date(nowMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const id = `pi-${version.replace(/[^A-Za-z0-9_-]/g, '-')}-${stamp}-${suffix}`;
  if (parsePiJobId(id) === null) throw new TypeError('The version or the time does not make a job id');
  return id;
}

/** { id, createdAt } of a Pi deployment's id, or null. The version itself is in the description. */
export function parsePiJobId(value) {
  const match = typeof value === 'string' ? PI_JOB_ID.exec(value) : null;
  if (match === null) return null;
  const s = match[2];
  const ms = Date.UTC(
    +s.slice(0, 4),
    +s.slice(4, 6) - 1,
    +s.slice(6, 8),
    +s.slice(9, 11),
    +s.slice(11, 13),
    +s.slice(13, 15)
  );
  return Number.isFinite(ms) ? { id: value, createdAt: ms } : null;
}

/** The job document. Throws when a value does not fit the contract or the board's buffer. */
export function buildPiJobDocument({ version, sha256, key, region, bucket }) {
  if (!PI_VERSION.test(version ?? '')) throw new TypeError('Not a Pi version');
  if (!HEX64.test(sha256 ?? '')) throw new TypeError('The digest is not SHA-256 hex');
  if (!OBJECT_KEY.test(key ?? '')) throw new TypeError('Not the key of a Pi package');
  if (!/^[a-z0-9-]{1,32}$/.test(region ?? '')) throw new TypeError('The region is not usable');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? '')) throw new TypeError('The bucket name is not usable');
  // Nothing in this URL needs encoding ("~" is unreserved), which is the form the v2 placeholder expects.
  const url = `\${aws:iot:s3-presigned-url-v2:https://s3.${region}.amazonaws.com/${bucket}/${key}}`;
  const document = JSON.stringify({ op: 'pi_delta', v: 1, pi: { version, sha256, url } });
  const bytes = Buffer.byteLength(document);
  if (bytes >= DOCUMENT_LIMIT) {
    throw new RangeError(`The job document is ${bytes} bytes; the board accepts fewer than ${DOCUMENT_LIMIT}`);
  }
  return document;
}

/** The job description: who, their note, and the Pi image's version, which the id cannot carry exactly. */
export function buildPiJobDescription({ email, sub, note, version }) {
  const text = asciiJson({ by: email, sub, note, pi: version });
  return text.length <= 2028 ? text : asciiJson({ by: '', sub, note, pi: version });
}

/** The Pi image a description names, or null. Anyone with AWS access can write one: checked. */
export function piVersionOfDescription(text) {
  try {
    const value = JSON.parse(text);
    return typeof value?.pi === 'string' && PI_VERSION.test(value.pi) ? value.pi : null;
  } catch {
    return null;
  }
}

/** The in-progress time limit of a job whose largest download is `bytes`: hours, never less than 6. */
export function timeoutMinutes(bytes) {
  const minutes = Math.ceil(bytes / SLOW_BYTES_PER_SEC / 60) + 60;
  return Math.min(MAX_TIMEOUT_MIN, Math.max(MIN_TIMEOUT_MIN, Number.isFinite(minutes) ? minutes : MAX_TIMEOUT_MIN));
}

const STEPS = Object.freeze(['idle', 'manifest', 'table', 'compare', 'blocks', 'done']);
const REASON = /^[a-z][a-z0-9_]{0,31}$/;

function count(value, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= max ? number : null;
}

/**
 * What a board wrote into its execution of a Pi job, each key checked on its own: the board is outside the
 * trust boundary. Every field is null when it is not there or not what the contract allows.
 */
export function piExecutionDetails(statusDetails) {
  const read = (name) =>
    statusDetails !== null &&
    typeof statusDetails === 'object' &&
    !Array.isArray(statusDetails) &&
    Object.hasOwn(statusDetails, name)
      ? statusDetails[name]
      : undefined;
  const step = read('step');
  const reason = read('reason');
  const piVersion = read('pi_version');
  return {
    step: typeof step === 'string' && STEPS.includes(step) ? step : null,
    progress: count(read('progress'), 100),
    done: count(read('done'), 2 ** 32),
    total: count(read('total'), 2 ** 32),
    piVersion: typeof piVersion === 'string' && PI_VERSION.test(piVersion) ? piVersion : null,
    generation: count(read('generation'), 2 ** 32),
    fetched: count(read('fetched'), 2 ** 32),
    changed: count(read('changed'), 2 ** 32),
    bytes: count(read('bytes')),
    reason: typeof reason === 'string' && REASON.test(reason) ? reason : null,
    running: strictVersion(read('running'))?.text ?? null,
  };
}

// --- the shadow ------------------------------------------------------------------------------------

export const CARD_STATES = Object.freeze(['empty', 'ready', 'updating', 'no_card']);
// A Pi build is to report its card with its heartbeat (PR #279 has pi_delta_ota_report() and does not send
// it yet). A "pi" that the last heartbeat did not carry is from firmware the board no longer runs.
const PI_REPORT_SLACK_SEC = 90;

function own(value, key) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)
    ? value[key]
    : undefined;
}

function whole(value, max) {
  return Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

/**
 * A board's card, as a Pi build reports it under "pi", or null: when it reports none, when it is not what the
 * contract allows, and when it did not come with the last heartbeat (`metadata` is metadata.reported).
 */
export function readPi(reported, metadata) {
  const pi = own(reported, 'pi');
  const card = own(pi, 'card');
  if (typeof card !== 'string' || !CARD_STATES.includes(card)) return null;
  const at = own(own(own(metadata, 'pi'), 'card'), 'timestamp');
  const heartbeat = own(own(metadata, 'uptime'), 'timestamp');
  if (
    metadata !== undefined &&
    Number.isInteger(at) &&
    Number.isInteger(heartbeat) &&
    heartbeat - at > PI_REPORT_SLACK_SEC
  ) {
    return null;
  }
  const version = own(pi, 'version');
  const step = own(pi, 'step');
  return {
    card,
    version: typeof version === 'string' && PI_VERSION.test(version) ? version : null,
    generation: whole(own(pi, 'generation'), 2 ** 32) ?? 0,
    step: typeof step === 'string' && STEPS.includes(step) ? step : 'idle',
    done: whole(own(pi, 'done'), 2 ** 32) ?? 0,
    total: whole(own(pi, 'total'), 2 ** 32) ?? 0,
  };
}

// --- the estimate ----------------------------------------------------------------------------------

/**
 * The blocks a board fetches to go from `old` to `next`, and what that costs, as tools/pi_image.py diff
 * computes it: every block whose hash differs or that is past the old image's end, or every block when there
 * is no old image or it has another block size. Each is { blockSize, blocks, imageSize, table } with the
 * table as a Buffer of 32-byte hashes. The board also skips a listed block its card holds already, so this
 * is the most it downloads.
 */
export function downloadEstimate(old, next) {
  const { blockSize, blocks, imageSize, table } = next;
  const blockLen = (block) => Math.min(blockSize, imageSize - block * blockSize);
  const same = old !== null && old.blockSize === blockSize;
  let changed = 0;
  let runs = 0;
  let data = 0;
  let previous = -2;
  for (let block = 0; block < blocks; block += 1) {
    const start = block * HASH_SIZE;
    const differs =
      !same ||
      block >= old.blocks ||
      old.table.compare(table, start, start + HASH_SIZE, start, start + HASH_SIZE) !== 0;
    if (!differs) continue;
    changed += 1;
    if (block !== previous + 1) runs += 1;
    previous = block;
    data += blockLen(block);
  }
  return { blocks, changed, bytes: HEADER_SIZE + table.length + data, imageBytes: imageSize, runs };
}

/** The SHA-256 of a table, hex. */
export function tableDigest(table) {
  return createHash('sha256').update(table).digest('hex');
}

// --- the record ------------------------------------------------------------------------------------

export const PI_STATUSES = Object.freeze(['uploading', 'active', 'refused']);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function text(value, max) {
  return typeof value === 'string' && value.length <= max ? value : '';
}

function person(value) {
  return { sub: text(value?.sub, 128), email: text(value?.email, 320) };
}

/** A stored Pi image, checked, or null if the item is not one. */
export function piImageFromItem(item) {
  if (item === null || typeof item !== 'object') return null;
  const ok =
    typeof item.version === 'string' &&
    PI_VERSION.test(item.version) &&
    HEX64.test(item.sha256 ?? '') &&
    HEX64.test(item.tableSha256 ?? '') &&
    Number.isSafeInteger(item.size) &&
    item.size > 0 &&
    Number.isSafeInteger(item.imageSize) &&
    Number.isSafeInteger(item.imageOffset) &&
    Number.isInteger(item.blockSize) &&
    Number.isInteger(item.blocks) &&
    typeof item.header === 'string' &&
    /^[0-9a-f]{1024}$/.test(item.header) &&
    PI_STATUSES.includes(item.status);
  if (!ok) return null;
  return {
    version: item.version,
    status: item.status,
    size: item.size,
    imageSize: item.imageSize,
    imageOffset: item.imageOffset,
    sha256: item.sha256,
    tableSha256: item.tableSha256,
    blockSize: item.blockSize,
    blocks: item.blocks,
    header: item.header,
    object: piObjectKey(item.version, item.sha256),
    notes: text(item.notes, 500),
    uploadedBy: person(item.uploadedBy),
    uploadedAt: text(item.uploadedAt, 40),
    verifiedAt: ISO_TIME.test(item.verifiedAt ?? '') ? item.verifiedAt : null,
    refusedReason: text(item.refusedReason, 300),
    rev: Number.isInteger(item.rev) ? item.rev : 0,
  };
}

/** A Pi image as the API returns it: the record without its header or its revision. */
export function presentPiImage(image) {
  const { header: _header, rev: _rev, object: _object, ...shown } = image;
  return { ...shown, kind: 'pi' };
}
