/**
 * Raspberry Pi images on the Firmware page (console 2.30.0; lib/pi-images.mjs, docs/pi-delta-update.md).
 *
 *   GET  /api/pi-images
 *        The Pi images, newest first, and the latest Pi deployments with each board's progress.
 *
 *   POST /api/pi-images                          { "header": "<1024 hex>", "notes": "..." }
 *        A release manager describes a package by its 512-byte header, which the page reads from the file.
 *        It is checked as a board checks it, its signature with the project's key included, before anything is
 *        stored: a header a board would refuse gets 422 and no URL. Then the record is kept as "uploading" and
 *        the answer holds a URL to PUT the package to, signed for its exact size and "only if new". The same
 *        header again, while its package has not arrived, gets a new URL. On record as firmware.pi_upload.
 *
 *   POST /api/pi-images/{version}/verify
 *        What arrived in S3 is checked before it can be deployed: its size, its header byte for byte, and its
 *        table against the table SHA-256 the signed header names (the board checks every block against that
 *        table). Good, the image is "active"; anything else, it is "refused" and its object is tagged revoked,
 *        so the bucket never serves it. On record as firmware.pi_verify.
 *
 *   GET  /api/pi-images/{version}/estimate
 *        For each board that has a Pi: the image it is taken to hold (its card, as it reports it; else the
 *        last Pi image deployed to it that succeeded; else none) and what it would download, computed as
 *        tools/pi_image.py diff does.
 *
 *   POST /api/pi-images/{version}/deploy        { "things": [...], "note": "..." }
 *        A pi_delta job to boards that report their card and run 1.20.0 or later; refused for any other, and
 *        for a board with an unfinished job. The URL is good for an hour (the board asks again for a fresh
 *        one), and the job's time limit is sized to the largest download. On record as deployment.pi_create.
 *
 *   POST /api/pi-deployments/{id}/cancel         { "force": false }
 *        Cancels a Pi deployment; with force, boards at work stop at their next piece too, and their cards keep
 *        what they had. On record as deployment.pi_cancel.
 */

import { badRequest, conflict, describeError, field, notFound, unprocessable } from '../http.mjs';
import { change } from '../lib/audit.mjs';
import {
  EXECUTION_STATUSES,
  MAX_IN_FLIGHT,
  countExecutions,
  isActiveExecution,
  isoTime,
  mapLimit,
  parseJobDescription,
} from '../lib/jobs.mjs';
import {
  HEADER_SIZE,
  MAX_BLOCKS,
  MAX_PACKAGE_SIZE,
  MEASURED_BYTES_PER_SEC,
  ManifestError,
  PI_FIRST_FIRMWARE,
  PI_PK,
  PI_URL_EXPIRES_SEC,
  PI_VERSION,
  UPLOAD_EXPIRES_SEC,
  buildPiJobDescription,
  buildPiJobDocument,
  buildPiJobId,
  decodeManifest,
  downloadEstimate,
  packageSize,
  parsePiJobId,
  piExecutionDetails,
  piImageFromItem,
  piObjectKey,
  piVersionOfDescription,
  presentPiImage,
  signatureHolds,
  tableDigest,
  tableRange,
  takesPiDelta,
  timeoutMinutes,
} from '../lib/pi-images.mjs';
import { MAX_NOTE, MAX_NOTES, requireBoolean, requireText, requireThings } from '../lib/validate.mjs';

const LIST_LIMIT = 10;
const CACHE_MS = 2000;
const MAX_BOARDS_NAMED = 200;
// The tables last read, by version: a 4 GiB image's is 2 MiB.
const TABLES_KEPT = 4;
const MAX_CACHED = 1000;
const HEADER_HEX = /^[0-9a-f]{1024}$/;

function requirePiVersion(value) {
  // A "+" in a path may arrive as a space (handlers/firmware.mjs, versionInPath).
  const version = typeof value === 'string' ? value.replaceAll(' ', '+') : value;
  if (typeof version !== 'string' || !PI_VERSION.test(version)) {
    throw badRequest('invalid_version', 'A Pi image version is 1 to 31 letters, digits or . _ + -.');
  }
  return version;
}

function unknownImage(version) {
  return notFound('unknown_pi_image', `There is no Raspberry Pi image ${version}.`);
}

function unknownDeployment() {
  return notFound('unknown_deployment', 'There is no Pi deployment with that id.');
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function createPiImageHandlers({ aws, config, now, randomHex, log }, { devices, deployments }) {
  const tables = new Map(); // version -> Buffer, the latest read last
  const closed = new Map(); // "id/thing" -> an execution that has ended, described once
  let listed = null; // { body, at }

  async function find(version) {
    return piImageFromItem(await aws.getFleetItem({ pk: PI_PK, sk: version }));
  }

  /** An image that may be deployed, or the error that says why not. */
  async function requireActive(version) {
    const image = await find(version);
    if (image === null) throw unknownImage(version);
    if (image.status === 'uploading') {
      throw conflict('pi_not_uploaded', `Pi image ${version} has not been uploaded and checked yet.`);
    }
    if (image.status !== 'active')
      throw conflict('pi_image_refused', `Pi image ${version} was refused: ${image.refusedReason}`);
    return image;
  }

  /** A stored image's table, read from its package once and kept for the next estimates. */
  async function tableOf(image) {
    if (tables.has(image.version)) {
      const kept = tables.get(image.version);
      tables.delete(image.version);
      tables.set(image.version, kept);
      return kept;
    }
    const [first, last] = tableRange(image);
    const table = await aws.getFirmwareRange(image.object, first, last);
    if (table === null || table.length !== last - first + 1 || tableDigest(table) !== image.tableSha256) return null;
    tables.set(image.version, table);
    while (tables.size > TABLES_KEPT) tables.delete(tables.keys().next().value);
    return table;
  }

  async function uploadFor(image) {
    const signed = await aws.presignPiUpload({ key: image.object, size: image.size, expiresIn: UPLOAD_EXPIRES_SEC });
    return { method: 'PUT', url: signed.url, headers: signed.headers, size: image.size, expiresAt: signed.expiresAt };
  }

  /** The Pi image a board is taken to hold: its card's, if ready; else the last one deployed that succeeded. */
  async function heldBy(device, executions) {
    if (device.pi?.card === 'ready' && device.pi.version !== null) return { version: device.pi.version, from: 'card' };
    const succeeded = executions
      .filter((execution) => execution.status === 'SUCCEEDED' && parsePiJobId(execution.jobId) !== null)
      .sort((a, b) => (b.lastUpdatedAt ?? 0) - (a.lastUpdatedAt ?? 0));
    for (const execution of succeeded) {
      const described = await aws.describeJobExecution(execution.jobId, device.thing);
      const version = piExecutionDetails(described?.statusDetails).piVersion;
      if (version !== null) return { version, from: 'deployment' };
    }
    return { version: null, from: 'none' };
  }

  /** What each board would download to take `image`. */
  async function estimatesFor(image, things) {
    const table = await tableOf(image);
    if (table === null) throw conflict('pi_package_mismatch', `The stored package of ${image.version} cannot be read.`);
    const next = { ...image, table };
    const boards = await devices.loadDevices(things);
    const executions = await mapLimit(things, MAX_IN_FLIGHT, (thing) => aws.listJobExecutionsForThing(thing));
    const held = await mapLimit(boards, MAX_IN_FLIGHT, (device, index) => heldBy(device, executions[index]));
    const olds = new Map();
    for (const { version } of held) {
      if (version === null || olds.has(version)) continue;
      const old = version === image.version ? image : await find(version);
      const oldTable = old === null || old.status === 'refused' ? null : await tableOf(old);
      olds.set(version, oldTable === null ? null : { ...old, table: oldTable });
    }
    return boards.map((device, index) => {
      const { version, from } = held[index];
      const old = version === null ? null : olds.get(version);
      // The card already holds this image: the board says so at once, and downloads nothing.
      const estimate =
        version === image.version
          ? { blocks: image.blocks, changed: 0, bytes: 0, imageBytes: image.imageSize, runs: 0 }
          : downloadEstimate(old ?? null, next);
      return {
        thing: device.thing,
        from: version,
        fromSource: from,
        // A version the console has no table of (a card written by hand): every block, at most.
        fromKnown: version === null || old !== null,
        ...estimate,
        minutes: Math.ceil(estimate.bytes / MEASURED_BYTES_PER_SEC / 60),
      };
    });
  }

  /** One execution of a Pi job, with its board's report. One that has ended is described once. */
  async function executionOf(id, item) {
    const key = `${id}/${item.thing}`;
    const kept = closed.get(key);
    if (kept !== undefined && kept.lastUpdatedAt === item.lastUpdatedAt && kept.status === item.status) return kept.row;
    let described = null;
    try {
      described = await aws.describeJobExecution(id, item.thing);
    } catch (error) {
      log({
        level: 'warn',
        event: 'execution_unreadable',
        deployment: id,
        thing: item.thing,
        error: describeError(error).message,
      });
    }
    const row = {
      thing: item.thing,
      status: item.status,
      ...piExecutionDetails(described?.statusDetails ?? null),
      lastUpdatedAt: isoTime(item.lastUpdatedAt),
      secondsLeft: Number.isInteger(described?.secondsLeft) ? described.secondsLeft : null,
    };
    if (described !== null && !isActiveExecution(item.status)) {
      if (closed.size >= MAX_CACHED) closed.clear();
      closed.set(key, { status: item.status, lastUpdatedAt: item.lastUpdatedAt, row });
    }
    return row;
  }

  async function deploymentOf(id) {
    const parsed = parsePiJobId(id);
    const job = parsed === null ? null : await aws.describeJob(id);
    if (job === null) return null;
    const version = piVersionOfDescription(job.description);
    if (version === null) return null;
    const listedExecutions = (await aws.listJobExecutionsForJob(id)).filter((item) =>
      EXECUTION_STATUSES.includes(item.status)
    );
    const executions = await mapLimit(listedExecutions, MAX_IN_FLIGHT, (item) => executionOf(id, item));
    const { createdBy, note } = parseJobDescription(job.description);
    return {
      id,
      version,
      status: job.status,
      createdAt: isoTime(job.createdAt) ?? isoTime(parsed.createdAt),
      completedAt: isoTime(job.completedAt),
      createdBy,
      note,
      things: [...(job.things ?? [])].sort(),
      counts: countExecutions(listedExecutions),
      executions: executions.sort((a, b) => (a.thing < b.thing ? -1 : 1)),
    };
  }

  return {
    async list() {
      if (listed !== null && now() - listed.at < CACHE_MS) return { body: listed.body };
      const images = (await aws.listFleetItems(PI_PK))
        .map(piImageFromItem)
        .filter((image) => image !== null)
        .sort((a, b) => (b.uploadedAt < a.uploadedAt ? -1 : b.uploadedAt > a.uploadedAt ? 1 : 0))
        .map(presentPiImage);
      const jobs = (await aws.listJobs())
        .filter((job) => parsePiJobId(job.jobId) !== null)
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .slice(0, LIST_LIMIT);
      const found = await mapLimit(jobs, MAX_IN_FLIGHT, (job) => deploymentOf(job.jobId));
      const body = {
        images,
        deployments: found.filter((deployment) => deployment !== null),
        firstFirmware: PI_FIRST_FIRMWARE.replace(/\+0$/, ''),
        maxPackageSize: MAX_PACKAGE_SIZE,
      };
      listed = { body, at: now() };
      return { body };
    },

    async upload({ actor, json, entry }) {
      const body = json();
      const hex = field(body, 'header');
      if (typeof hex !== 'string' || !HEADER_HEX.test(hex)) {
        throw badRequest('invalid_header', 'The header is the first 512 bytes of the package, in lowercase hex.');
      }
      const notes = requireText(field(body, 'notes'), 'notes', { max: MAX_NOTES });
      const raw = Buffer.from(hex, 'hex');
      let manifest;
      try {
        manifest = decodeManifest(raw);
      } catch (error) {
        if (error instanceof ManifestError) throw unprocessable('bad_manifest', error.message);
        throw error;
      }
      entry.target = manifest.version;
      entry.detail.sha256 = manifest.sha256;
      entry.detail.size = String(packageSize(manifest));
      // The board's own check, with the key it has built in: before anything is stored.
      if (!signatureHolds(raw, config.signingKey)) {
        throw unprocessable(
          'bad_signature',
          "The header's signature does not hold with the project's firmware signing key: every board would " +
            'refuse it. Package it again with tools/pi_image.py package and the project key.'
        );
      }
      const size = packageSize(manifest);
      if (size > MAX_PACKAGE_SIZE || manifest.blocks > MAX_BLOCKS) {
        throw unprocessable(
          'pi_too_large',
          size > MAX_PACKAGE_SIZE
            ? `The package is ${size} bytes; one upload takes at most 5 GiB.`
            : `The image has ${manifest.blocks} blocks; a board's card holds at most ${MAX_BLOCKS}. Use larger blocks.`
        );
      }

      const image = {
        version: manifest.version,
        status: 'uploading',
        size,
        imageSize: manifest.imageSize,
        imageOffset: manifest.imageOffset,
        sha256: manifest.sha256,
        tableSha256: manifest.tableSha256,
        blockSize: manifest.blockSize,
        blocks: manifest.blocks,
        header: hex,
        notes,
        uploadedBy: { sub: actor.sub, email: actor.email },
        uploadedAt: new Date(now()).toISOString(),
        verifiedAt: null,
        refusedReason: '',
        rev: 0,
      };
      const existing = await find(manifest.version);
      if (existing !== null) {
        // The same package again, while it has not arrived: a new URL, so that a broken upload can start over.
        if (existing.status === 'uploading' && existing.header === hex) {
          return { status: 201, body: { image: presentPiImage(existing), upload: await uploadFor(existing) } };
        }
        throw conflict('version_exists', `There is a Pi image ${manifest.version} already. A version is used once.`);
      }
      const put = await aws.putFleetItem({ pk: PI_PK, sk: manifest.version, item: image });
      if (!put.ok) throw conflict('version_exists', `There is a Pi image ${manifest.version} already.`);
      listed = null;
      change(entry, 'pi_image', null, manifest.version);
      const stored = piImageFromItem(image);
      return { status: 201, body: { image: presentPiImage(stored), upload: await uploadFor(stored) } };
    },

    async verify({ params, entry }) {
      const version = requirePiVersion(params.version);
      entry.target = version;
      const image = await find(version);
      if (image === null) throw unknownImage(version);
      if (image.status === 'active') return { body: { image: presentPiImage(image) } };
      if (image.status === 'refused')
        throw conflict('pi_image_refused', `Pi image ${version} was refused: ${image.refusedReason}`);

      const arrived = await aws.headFirmwareObject(image.object);
      if (arrived === null) {
        throw conflict(
          'pi_not_uploaded',
          `The package of ${version} has not arrived. Send the file, then check again.`
        );
      }
      let wrong = null;
      if (arrived.size !== image.size) {
        wrong = `${arrived.size} bytes arrived, and the header says ${image.size}.`;
      } else {
        const header = await aws.getFirmwareRange(image.object, 0, HEADER_SIZE - 1);
        if (header === null || header.toString('hex') !== image.header) {
          wrong = 'The header that arrived is not the one that was checked.';
        } else {
          const [first, last] = tableRange(image);
          const table = await aws.getFirmwareRange(image.object, first, last);
          if (table === null || table.length !== last - first + 1 || tableDigest(table) !== image.tableSha256) {
            wrong = 'The table of block hashes that arrived is not the one the signed header names.';
          }
        }
      }
      const at = new Date(now()).toISOString();
      const set = wrong === null ? { status: 'active', verifiedAt: at } : { status: 'refused', refusedReason: wrong };
      const updated = await aws.updateFleetItem({ pk: PI_PK, sk: version, rev: image.rev, set });
      if (!updated.ok) throw conflict('upload_conflict', 'The Pi image changed meanwhile. Load the page again.');
      listed = null;
      change(entry, 'status', 'uploading', set.status);
      if (wrong !== null) {
        // Write-once: the object cannot be replaced, so the bucket is told never to serve it.
        try {
          await aws.tagFirmwareRevoked(image.object);
        } catch (error) {
          log({ level: 'error', event: 'pi_refused_untagged', version, error: describeError(error) });
        }
        throw unprocessable('pi_package_mismatch', `${wrong} The package is refused; upload it under a new version.`);
      }
      return { body: { image: presentPiImage(piImageFromItem(updated.item)) } };
    },

    async estimate({ params }) {
      const version = requirePiVersion(params.version);
      const image = await requireActive(version);
      const reported = await devices.loadDevices(await devices.groupThings());
      const things = reported.filter((device) => Boolean(device.pi)).map((device) => device.thing);
      return { body: { version, boards: things.length === 0 ? [] : await estimatesFor(image, things) } };
    },

    async deploy({ actor, params, json, entry }) {
      const version = requirePiVersion(params.version);
      entry.target = version;
      const body = json();
      const things = requireThings(field(body, 'things'));
      entry.detail.things = String(things.length);
      const named = things.join(' ');
      if (named.length <= MAX_BOARDS_NAMED) entry.detail.boards = named;
      const note = requireText(field(body, 'note'), 'note', { max: MAX_NOTE });
      const image = await requireActive(version);

      const members = new Set(await devices.groupThings());
      const strangers = things.filter((thing) => !members.has(thing));
      if (strangers.length > 0) {
        throw unprocessable('unknown_device', `Not registered boards: ${strangers.join(', ')}.`);
      }
      // A board takes the job only if it runs a Pi build of 1.20.0 or later, which reports its card. Any other
      // answers "unsupported"; it is named here instead.
      const reported = await devices.loadDevices(things);
      const unable = reported.filter((device) => !takesPiDelta(device)).map((device) => device.thing);
      if (unable.length > 0) {
        throw conflict(
          'pi_unsupported',
          `These boards do not report a Pi image card, which a firmware built with --pi reports from ` +
            `${PI_FIRST_FIRMWARE.replace(/\+0$/, '')}: ${unable.join(', ')}.`,
          { boards: unable }
        );
      }
      const busy = await deployments.unfinishedOn(things);
      if (busy.length > 0) {
        const boards = [...new Set(busy.map((item) => item.thing))];
        throw conflict(
          'device_busy',
          `${boards.length === 1 ? `${boards[0]} has` : `${boards.length} boards have`} an unfinished update. ` +
            'Wait for it or cancel it first.',
          busy
        );
      }

      // The time limit covers the largest download at a slow link; a board whose job runs out keeps its card's
      // progress, and the same image deployed again goes on from there.
      const estimates = await estimatesFor(image, things);
      const largest = Math.max(...estimates.map((item) => item.bytes), 0);
      const minutes = timeoutMinutes(largest);
      entry.detail.timeoutMinutes = String(minutes);
      const document = buildPiJobDocument({
        version: image.version,
        sha256: image.sha256,
        key: image.object,
        region: config.region,
        bucket: config.firmwareBucket,
      });
      const description = buildPiJobDescription({ email: actor.email, sub: actor.sub, note, version: image.version });
      let id = null;
      for (let attempt = 0; attempt < 3 && id === null; attempt += 1) {
        const candidate = buildPiJobId(image.version, now(), String(randomHex(4)).slice(0, 4));
        const created = await aws.createJob({
          jobId: candidate,
          things,
          document,
          description,
          urlExpiresInSec: PI_URL_EXPIRES_SEC,
          inProgressTimeoutMinutes: minutes,
        });
        if (created.ok) id = candidate;
        else if (created.reason === 'target_not_found') {
          throw unprocessable('unknown_device', 'One of the chosen boards is no longer registered.');
        } else if (created.reason !== 'exists') {
          throw new Error(`The job could not be created: ${String(created.reason)}`);
        }
      }
      if (id === null) throw new Error('No free job id after three attempts');
      listed = null;
      entry.detail.deployment = id;
      change(entry, 'deployment', null, id);
      change(entry, 'boards', null, plural(things.length, 'board'));
      let deployment = null;
      try {
        deployment = await deploymentOf(id);
      } catch (error) {
        log({ level: 'warn', event: 'deployment_unreadable', deployment: id, error: describeError(error).message });
      }
      return { status: 201, body: { deployment: deployment ?? { id, version: image.version, things }, estimates } };
    },

    async cancel({ actor, params, json, entry }) {
      const parsed = parsePiJobId(params.id);
      if (parsed === null) throw badRequest('invalid_deployment', 'That is not the id of a Pi deployment.');
      entry.target = parsed.id;
      const force = requireBoolean(field(json(), 'force'), 'force', false);
      entry.detail.force = String(force);
      const job = await aws.describeJob(parsed.id);
      if (job === null || piVersionOfDescription(job.description) === null) throw unknownDeployment();
      if (job.status === 'COMPLETED' || job.status === 'DELETION_IN_PROGRESS') {
        throw conflict('already_finished', 'This Pi deployment has already finished; there is nothing left to cancel.');
      }
      if (job.status === 'CANCELED' && !force) {
        throw conflict(
          'already_cancelled',
          'This Pi deployment is already cancelled. Cancel with force to stop boards at work.'
        );
      }
      const result = await aws.cancelJob({ jobId: parsed.id, force, reasonCode: 'CONSOLE_CANCEL', comment: actor.sub });
      if (!result.ok) {
        if (result.reason === 'not_found') throw unknownDeployment();
        throw conflict('cancel_refused', 'AWS did not accept the cancellation. Try again in a moment.');
      }
      listed = null;
      change(entry, 'status', job.status, force ? 'CANCELED (force)' : 'CANCELED');
      return { body: { deployment: await deploymentOf(parsed.id) } };
    },
  };
}
