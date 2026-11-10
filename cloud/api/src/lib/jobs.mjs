/**
 * Deployments as AWS IoT jobs.
 *
 * A deployment is one snapshot job. Nothing about it is stored anywhere else: the job
 * id carries the version, the job description carries who created it and why, and the
 * job document is what the board acts on:
 *
 *   { "op": "fw_update", "v": 1,
 *     "fw": { "version": "1.1.0+7", "size": 815284, "sha256": "<64 hex>",
 *             "url": "${aws:iot:s3-presigned-url-v2:<S3 URL of the image>}" } }
 *
 * where the S3 URL is https://s3.<region>.amazonaws.com/<bucket>/firmware/<sha256>.bin.
 * AWS IoT replaces the placeholder with a short-lived download URL each time a board
 * asks for the document. This module never sees such a URL.
 *
 * From console 2.26.0 a deployment can bring a Raspberry Pi image (docs/pi-ota.md): alone
 * ("op": "pi_image", id pi-<version>-<time>-<hex>), or with board firmware ("op": "fw_pi_update",
 * the firmware's id with "-pi" after the build number). Its version and digest are in the job's
 * description too, which is what the console reads them back from.
 */

import { PI_VERSION, isThing, parseDeploymentId, strictVersion } from './validate.mjs';

export const URL_EXPIRES_SEC = 600;
export const IN_PROGRESS_TIMEOUT_MIN = 30;
export const MAX_IN_FLIGHT = 5;
// The longest that AWS IoT lets an execution be in progress: a week.
export const MAX_IN_PROGRESS_TIMEOUT_MIN = 10_080;
// What a Pi image's time limit is reckoned with (docs/pi-ota.md, "Speed"): the download at the 10 KB/s
// measured for firmware, the transfer to the Pi at 100 KB/s, and twice that for a bad day.
const PI_DOWNLOAD_BYTES_PER_SEC = 10_240;
const PI_SEND_BYTES_PER_SEC = 102_400;

// The board parses the document in a small buffer, before the URL is substituted.
const DOCUMENT_LIMIT = 512;
// Limits of AWS IoT for a job description.
const DESCRIPTION_LIMIT = 2028;

export const JOB_STATUSES = Object.freeze([
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELED',
  'SCHEDULED',
  'DELETION_IN_PROGRESS',
]);

const COUNT_NAMES = Object.freeze({
  QUEUED: 'queued',
  IN_PROGRESS: 'inProgress',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  REJECTED: 'rejected',
  CANCELED: 'canceled',
  TIMED_OUT: 'timedOut',
  REMOVED: 'removed',
});

export const EXECUTION_STATUSES = Object.freeze(Object.keys(COUNT_NAMES));

/** An execution that can still change: the board has not finished with it. */
export function isActiveExecution(status) {
  return status === 'QUEUED' || status === 'IN_PROGRESS';
}

export function emptyCounts() {
  return Object.fromEntries(Object.values(COUNT_NAMES).map((name) => [name, 0]));
}

export function countExecutions(executions) {
  const counts = emptyCounts();
  for (const { status } of executions) {
    if (Object.hasOwn(COUNT_NAMES, status)) counts[COUNT_NAMES[status]] += 1;
  }
  return counts;
}

/** ISO 8601 for epoch milliseconds, or null when there is no usable time. */
export function isoTime(ms) {
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}

/**
 * The id of a new deployment of the given version:
 * cranium-<major>-<minor>-<revision>-b<build>-<yyyymmddThhmmssZ>-<4 random hex>.
 * At most 55 characters, so it always fits the 64 that AWS IoT allows.
 */
export function buildJobId(parts, nowMs, suffix, { withPi = false } = {}) {
  if (typeof suffix !== 'string' || !/^[0-9a-f]{4}$/.test(suffix)) {
    throw new TypeError('The job id suffix must be 4 lowercase hex digits');
  }
  const stamp = new Date(nowMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  // With a Pi image too: "-pi" after the build number, at most 58 characters.
  const pi = withPi ? '-pi' : '';
  const id = `cranium-${parts.major}-${parts.minor}-${parts.revision}-b${parts.build}${pi}-${stamp}-${suffix}`;
  if (parseDeploymentId(id)?.withPi !== withPi) throw new TypeError('The version or the time does not make a job id');
  return id;
}

/**
 * How long a deployment with a Pi image of `size` bytes may be in progress on a board, in minutes:
 * the firmware's 30 and the Pi image's download and transfer twice over, at most a week.
 */
export function piTimeoutMinutes(size) {
  const seconds = size / PI_DOWNLOAD_BYTES_PER_SEC + size / PI_SEND_BYTES_PER_SEC;
  return Math.min(MAX_IN_PROGRESS_TIMEOUT_MIN, IN_PROGRESS_TIMEOUT_MIN + Math.ceil((2 * seconds) / 60));
}

/** When the id says the deployment was created, in epoch milliseconds, or null. */
function timeInJobId(id) {
  const match = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{4}$/.exec(id);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The job document for a release. Throws when a value does not fit the contract or
 * the document would not fit the board's buffer.
 */
export function buildJobDocument({ version, size, sha256, region, bucket }) {
  const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
  if (strictVersion(version)?.text !== version) throw new TypeError('The version is not canonical');
  if (!Number.isInteger(size) || size <= 0) throw new TypeError('The size is not a positive integer');
  if (!matches(sha256, /^[0-9a-f]{64}$/)) throw new TypeError('The digest is not SHA-256 hex');
  if (!matches(region, /^[a-z0-9-]{1,32}$/)) throw new TypeError('The region is not usable');
  if (!matches(bucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)) {
    throw new TypeError('The bucket name is not usable');
  }
  // Nothing in this URL needs encoding, which is the form the v2 placeholder expects.
  const object = `https://s3.${region}.amazonaws.com/${bucket}/firmware/${sha256}.bin`;
  const url = `\${aws:iot:s3-presigned-url-v2:${object}}`;
  const document = JSON.stringify({ op: 'fw_update', v: 1, fw: { version, size, sha256, url } });
  const bytes = Buffer.byteLength(document);
  if (bytes >= DOCUMENT_LIMIT) {
    throw new RangeError(`The job document is ${bytes} bytes; the board accepts fewer than ${DOCUMENT_LIMIT}`);
  }
  return document;
}

// A Pi image's document carries a signature as well: still far below what a board takes in, a
// message of 4 KB with the download URL substituted (firmware/app/prj.conf).
const PI_DOCUMENT_LIMIT = 768;
// A firmware version as a board takes it in minFirmware.
const FIRMWARE_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,5}(\+\d{1,10})?$/;
// Firmware and a Pi image in one document: the two parts as they are alone, before the URLs go in.
const BUNDLE_DOCUMENT_LIMIT = 1024;

/**
 * From 1.20.0, a Raspberry Pi image's job document (docs/pi-ota.md, "Cloud"), from the record that
 * tools/pi_image.py writes: { version, size, sha256, sig, minFirmware? }. The image is under
 * firmware/, where boards download from, as pi-<sha256>.img. The signature is checked by the board,
 * not here. Throws when a value does not fit the contract.
 */
export function buildPiJobDocument({ version, size, sha256, sig, minFirmware, region, bucket }) {
  const pi = piPart({ version, size, sha256, sig, minFirmware, region, bucket });
  const document = JSON.stringify({ op: 'pi_image', v: 1, pi });
  const bytes = Buffer.byteLength(document);
  if (bytes >= PI_DOCUMENT_LIMIT) {
    throw new RangeError(`The job document is ${bytes} bytes; a Pi image's takes fewer than ${PI_DOCUMENT_LIMIT}`);
  }
  return document;
}

/**
 * From 2.26.0, board firmware and a Raspberry Pi image in one job ("fw_pi_update", docs/pi-ota.md,
 * "Both at once"): `fw` as in buildJobDocument, `pi` as in buildPiJobDocument. A board downloads both,
 * installs the firmware, and sends the Pi its image once that firmware is confirmed.
 */
export function buildBundleJobDocument({ version, size, sha256, pi, region, bucket }) {
  const firmware = JSON.parse(buildJobDocument({ version, size, sha256, region, bucket })).fw;
  const image = piPart({ ...pi, region, bucket });
  const document = JSON.stringify({ op: 'fw_pi_update', v: 1, fw: firmware, pi: image });
  const bytes = Buffer.byteLength(document);
  if (bytes >= BUNDLE_DOCUMENT_LIMIT) {
    throw new RangeError(
      `The job document is ${bytes} bytes; one with both parts takes fewer than ${BUNDLE_DOCUMENT_LIMIT}`
    );
  }
  return document;
}

/** The "pi" object of a document, checked. */
function piPart({ version, size, sha256, sig, minFirmware, region, bucket }) {
  const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
  if (!matches(version, PI_VERSION)) throw new TypeError('The version is not 1 to 31 of A-Z a-z 0-9 . _ + -');
  if (!Number.isInteger(size) || size <= 0 || size > 0xffffffff) {
    throw new TypeError('The size is not a positive integer below 4 GiB');
  }
  if (!matches(sha256, /^[0-9a-f]{64}$/)) throw new TypeError('The digest is not SHA-256 hex');
  if (!matches(sig, /^[0-9a-f]{128}$/)) throw new TypeError('The signature is not 64 bytes of hex');
  if (minFirmware !== undefined && minFirmware !== null && !matches(minFirmware, FIRMWARE_VERSION)) {
    throw new TypeError('minFirmware is not a firmware version');
  }
  if (!matches(region, /^[a-z0-9-]{1,32}$/)) throw new TypeError('The region is not usable');
  if (!matches(bucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)) {
    throw new TypeError('The bucket name is not usable');
  }
  const object = `https://s3.${region}.amazonaws.com/${bucket}/firmware/pi-${sha256}.img`;
  const url = `\${aws:iot:s3-presigned-url-v2:${object}}`;
  const pi = { version, size, sha256, sig, url };
  if (minFirmware !== undefined && minFirmware !== null) pi.minFirmware = minFirmware;
  return pi;
}

/**
 * The id of a Pi image's deployment: pi-<version>-<yyyymmddThhmmssZ>-<4 random hex>. A board tells a
 * Pi image from firmware in the list of its pending jobs by the "pi-" (src/ota_job.h).
 */
export function buildPiJobId(version, nowMs, suffix) {
  if (typeof version !== 'string' || !PI_VERSION.test(version)) throw new TypeError('The version is not usable');
  if (typeof suffix !== 'string' || !/^[0-9a-f]{4}$/.test(suffix)) {
    throw new TypeError('The job id suffix must be 4 lowercase hex digits');
  }
  const stamp = new Date(nowMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `pi-${version.replace(/[^A-Za-z0-9_-]/g, '-')}-${stamp}-${suffix}`;
}

/** JSON in printable ASCII only, which every AWS text field accepts. */
function asciiJson(value) {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/**
 * The job description: who created the deployment and their note, as compact JSON.
 * The e-mail address is display data and is left out if the text would not fit.
 */
export function buildJobDescription({ email, sub, note, pi = null }) {
  // A Pi image: its version and digest, which the id cannot hold (2.26.0).
  const image = pi === null ? {} : { pi: pi.version, pis: pi.sha256 };
  const text = asciiJson({ by: email, sub, note, ...image });
  return text.length <= DESCRIPTION_LIMIT ? text : asciiJson({ by: '', sub, note, ...image });
}

const UNSAFE = /[\p{C}\p{Zl}\p{Zp}]/u;

function line(value, max) {
  return typeof value === 'string' && value.length <= max && !UNSAFE.test(value) ? value : '';
}

/** Read a job description back. Anyone with AWS access can write one: trust nothing. */
export function parseJobDescription(text) {
  const unknown = { createdBy: null, note: '' };
  if (typeof text !== 'string' || text.length > DESCRIPTION_LIMIT) return unknown;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return unknown;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return unknown;
  const sub = Object.hasOwn(value, 'sub') ? line(value.sub, 128) : '';
  const email = Object.hasOwn(value, 'by') ? line(value.by, 320) : '';
  const note = Object.hasOwn(value, 'note') ? line(value.note, 200) : '';
  const piVersion = Object.hasOwn(value, 'pi') ? value.pi : null;
  const piSha = Object.hasOwn(value, 'pis') ? value.pis : null;
  const pi =
    typeof piVersion === 'string' &&
    PI_VERSION.test(piVersion) &&
    typeof piSha === 'string' &&
    /^[0-9a-f]{64}$/.test(piSha)
      ? { version: piVersion, sha256: piSha }
      : null;
  // Only a deployment with a Pi image has one (2.26.0).
  return { createdBy: sub === '' ? null : { sub, email }, note, ...(pi === null ? {} : { pi }) };
}

/** What a deployment brings: ["nrf"], ["pi"] or ["nrf", "pi"]. */
export function partsOf(parsed) {
  if (parsed.piOnly) return ['pi'];
  return parsed.withPi ? ['nrf', 'pi'] : ['nrf'];
}

/**
 * Turn a job as the adapter describes it into a DeploymentSummary. Returns null for a
 * job that is not a deployment of this console.
 */
export function summarizeJob(job) {
  const parsed = parseDeploymentId(job?.jobId);
  if (parsed === null || !JOB_STATUSES.includes(job.status)) return null;
  const createdAt = isoTime(job.createdAt) ?? isoTime(timeInJobId(parsed.id));
  if (createdAt === null) return null;

  const things = [...new Set((Array.isArray(job.things) ? job.things : []).filter(isThing))].sort();
  const counts = emptyCounts();
  let counted = 0;
  for (const name of Object.keys(counts)) {
    const value = job.counts?.[name];
    if (Number.isInteger(value) && value > 0) {
      counts[name] = value;
      counted += value;
    }
  }
  // AWS creates the executions shortly after the job. Until it has, a board the job
  // names is queued by definition.
  if (job.status === 'IN_PROGRESS' && counted < things.length) {
    counts.queued += things.length - counted;
  }
  const { createdBy, note, pi } = parseJobDescription(job.description);
  return {
    id: parsed.id,
    // The board firmware it brings; null for a Pi image alone.
    version: parsed.version,
    // From 2.26.0: what it brings, and its Pi image ({ version, sha256 }) when it brings one.
    parts: partsOf(parsed),
    ...(parsed.withPi ? { pi: pi ?? null } : {}),
    status: job.status,
    createdAt,
    completedAt: isoTime(job.completedAt),
    createdBy,
    note,
    things,
    counts,
  };
}

/**
 * A deployment whose summary can no longer change: the job is over, no board is still
 * queued or at work, and every board is accounted for. The last two matter because a
 * cancelled job keeps the boards that had started, and because AWS updates the counts
 * a moment after the status.
 */
export function isSettled(summary) {
  if (summary.status !== 'COMPLETED' && summary.status !== 'CANCELED') return false;
  const counted = Object.values(summary.counts).reduce((sum, value) => sum + value, 0);
  return summary.counts.queued === 0 && summary.counts.inProgress === 0 && counted >= summary.things.length;
}

const REASON = /^[a-z][a-z0-9_]{0,31}$/;
const DETAIL = /^[\x20-\x7e]{1,200}$/;
// The steps a board names in an execution: firmware's, and from 2.26.0 a Pi image's. "sending" is a Pi
// image alone on its way to the Pi; "downloading_pi" and "flashing_pi" are the Pi part of a job with both.
const STEPS = Object.freeze([
  'downloading',
  'rebooting',
  'downloading_pi',
  'flashing_pi',
  'sending',
  'before_pi_image',
]);
const PI_OUTCOMES = Object.freeze(['failed', 'not_flashed']);
const NRF_OUTCOMES = Object.freeze(['installed', 'not_installed']);

/**
 * What a board wrote into the statusDetails of its execution, reduced to the keys of
 * the device contract. Every key is optional and every value is checked: a board is
 * outside the trust boundary.
 */
export function executionDetails(statusDetails) {
  const read = (name) =>
    statusDetails !== null &&
    typeof statusDetails === 'object' &&
    !Array.isArray(statusDetails) &&
    Object.hasOwn(statusDetails, name)
      ? statusDetails[name]
      : undefined;
  const reason = read('reason');
  const detail = read('detail');
  const step = read('step');
  const progress = read('progress');
  const piVersion = read('pi_version');
  const percent = typeof progress === 'string' && /^(0|[1-9]\d?|100)$/.test(progress) ? Number(progress) : null;
  return {
    reason: typeof reason === 'string' && REASON.test(reason) ? reason : null,
    detail: typeof detail === 'string' && DETAIL.test(detail) ? detail : null,
    step: STEPS.includes(step) ? step : null,
    running: strictVersion(read('running'))?.text ?? null,
    // From 2.26.0, what a board says of a Pi image: how far it is, the version the Pi verified, and
    // for a job with both parts, what became of each when it did not succeed.
    // Each only when the board said it, so that a firmware job's details read as they always did.
    ...(percent === null ? {} : { progress: percent }),
    ...(typeof piVersion === 'string' && PI_VERSION.test(piVersion) ? { piVersion } : {}),
    ...(PI_OUTCOMES.includes(read('pi')) ? { piOutcome: read('pi') } : {}),
    ...(NRF_OUTCOMES.includes(read('nrf')) ? { nrfOutcome: read('nrf') } : {}),
  };
}

/** Run a task for every item, at most `limit` at a time. Results keep the order. */
export async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await task(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
