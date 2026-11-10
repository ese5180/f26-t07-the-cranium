/**
 * Firmware releases: list, upload, look up and revoke, and the check a phone app makes before
 * it sends a release to a board over Bluetooth.
 *
 * A release exists only for an image that this server has verified itself: a
 * well-formed MCUboot image, built for this product's flash layout, whose SHA-256 and
 * ECDSA P-256 signature check out against the project's public key. The version is
 * read from the signed header and from nowhere else.
 *
 * Releases are stored under pk "REL" with the version as a zero-padded sort key
 * (MMM.mmm.rrrrr.bbbbbbbbbb), so that string order is version order. A pointer item
 * remembers the highest version ever registered. A new release must be newer than
 * that, including releases that were revoked since: versions only go up, which is what
 * lets a board refuse anything that is not newer than what it runs.
 *
 * The image itself is stored once, under the SHA-256 of the file, and never
 * overwritten. Revoking a release tags that object; the bucket policy then refuses
 * every download of it, including through URLs that were already handed out.
 *
 * Every release is for one board type and one flash layout (lib/boards.mjs): the ones its image
 * names in its protected TLVs 0xA1 and 0xA2, which the signature covers, or nrf7002dk and layout 1
 * for an image that names none, as every release up to 1.12.0. Versions are one sequence across all
 * board types: one version is one image. A release's note can be changed later (PUT .../notes);
 * nothing else of it.
 *
 * Revoking is three steps: mark the record, tag the object, cancel the deployments.
 * The mark comes first, so that nothing new can start, which also means that a request
 * that fails or is cut off after it leaves a release that reads "revoked" with work
 * outstanding. The record therefore says when the other two steps were completed
 * (revoked.enforcedAt). Until then it is null, and revoking again completes the work.
 */

import { createHash } from 'node:crypto';

import { HttpError, badRequest, conflict, describeError, field, notFound, unprocessable } from '../http.mjs';
import {
  BOARD_TYPES,
  BoardTlvError,
  boardOfImage,
  isBoardType,
  isLayout,
  isPiBuild,
  layoutOfImage,
  releaseBoard,
  releaseLayout,
} from '../lib/boards.mjs';
import { change } from '../lib/audit.mjs';
import { ImageError, compareVersions, formatVersion, validateImage } from '../lib/mcuboot.mjs';
import {
  MAX_NOTES,
  MAX_REASON,
  requireBase64,
  requireBluetoothName,
  requireFilename,
  requireSha256,
  requireText,
  requireThing,
  requireVersion,
  strictVersion,
} from '../lib/validate.mjs';

// Enough for an image that fills the slot, base64 encoded, with its notes.
export const UPLOAD_BODY_LIMIT = 1_400_000;

const HEX64 = /^[0-9a-f]{64}$/;
const SORT_KEY = /^(\d{3})\.(\d{3})\.(\d{5})\.(\d{10})$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The sort key of a version: fixed-width fields, so that text order is version order. */
export function releaseKey(parts) {
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${pad(parts.major, 3)}.${pad(parts.minor, 3)}.${pad(parts.revision, 5)}.${pad(parts.build, 10)}`;
}

/** The version a sort key stands for, or null. */
export function versionOfKey(sortKey) {
  const match = typeof sortKey === 'string' ? SORT_KEY.exec(sortKey) : null;
  if (!match) return null;
  return formatVersion({
    major: Number(match[1]),
    minor: Number(match[2]),
    revision: Number(match[3]),
    build: Number(match[4]),
  });
}

/** The S3 key of an image, from the SHA-256 of the file. */
export function objectKey(sha256) {
  if (typeof sha256 !== 'string' || !HEX64.test(sha256)) throw new TypeError('Not a SHA-256 digest');
  return `firmware/${sha256}.bin`;
}

/**
 * The version named in a path. A "+" in a URL is read as a space by anything that
 * decodes it the way a form is decoded; a version has no other use for a space, so
 * one is taken for the plus sign it stood for. The result is validated like any other.
 */
function versionInPath(segment) {
  return requireVersion(typeof segment === 'string' ? segment.replaceAll(' ', '+') : segment);
}

function text(value, max) {
  return typeof value === 'string' && value.length <= max ? value : '';
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function person(value) {
  return { sub: text(value?.sub, 128), email: text(value?.email, 320) };
}

/** A time as this API writes it, or null. */
function instant(value) {
  return typeof value === 'string' && ISO_TIME.test(value) ? value : null;
}

/**
 * Turn a stored item into a Release, or null if it is not one. A release whose status
 * is not exactly "active" is treated as revoked, and a revocation counts as completed
 * only if the record says when.
 */
export function releaseFromItem(item) {
  if (item === null || typeof item !== 'object') return null;
  const version = strictVersion(item.version);
  if (version === null || typeof item.sha256 !== 'string' || !HEX64.test(item.sha256)) return null;
  if (!Number.isInteger(item.size) || item.size <= 0) return null;
  const uploadedAt = text(item.uploadedAt, 40);
  const active = item.status === 'active';
  return {
    version: version.text,
    size: item.size,
    sha256: item.sha256,
    imageHash: text(item.imageHash, 64),
    keyHash: text(item.keyHash, 64),
    payloadSize: count(item.payloadSize),
    headerSize: count(item.headerSize),
    loadAddress: count(item.loadAddress),
    filename: text(item.filename, 64),
    // The board type and flash layout the image is for (lib/boards.mjs); nrf7002dk and 1 for every
    // release from before them.
    board: releaseBoard(item),
    layout: releaseLayout(item),
    // A build with Raspberry Pi image updates (TLV 0xA3, firmware 1.20.0): only such a release goes out
    // with a Pi image in one deployment. Left out for every other release, which reads as before.
    ...(item.pi === true ? { pi: true } : {}),
    notes: text(item.notes, MAX_NOTES),
    uploadedBy: person(item.uploadedBy),
    uploadedAt,
    status: active ? 'active' : 'revoked',
    revoked: active
      ? null
      : {
          by: person(item.revoked?.by),
          at: text(item.revoked?.at, 40) || uploadedAt,
          reason: text(item.revoked?.reason, MAX_REASON),
          enforcedAt: instant(item.revoked?.enforcedAt),
        },
  };
}

function versionExists(version) {
  return conflict(
    'version_exists',
    `Release ${version} already exists. A version is registered once and never replaced.`
  );
}

function versionNotNewer(version, highestKey) {
  const highest = versionOfKey(highestKey);
  return unprocessable(
    'version_not_newer',
    highest === null
      ? `Version ${version} is not newer than the releases that already exist.`
      : `Version ${version} is not newer than ${highest}, the highest version ever ` +
          'registered. Versions only go up, revoked releases included.'
  );
}

/**
 * A revocation whose record is written but whose other steps are not all done. Says
 * which, in the words of the console; what went wrong inside is in the log.
 *
 * @param {string} version
 * @param {string[]} steps        "tag", "cancel" or "record"
 * @param {string[]} unconfirmed  deployments with a board that may still be at work
 */
function revokeIncomplete(version, steps, unconfirmed) {
  if (steps.includes('record')) {
    return new HttpError(
      500,
      'revoke_incomplete',
      `Release ${version} is revoked: its image is blocked and ` +
        'its deployments are cancelled. Only the record that this is done could not be written. Revoke it ' +
        'again to finish.'
    );
  }
  const open = [];
  if (steps.includes('tag')) open.push('its image could not be blocked');
  if (steps.includes('cancel')) {
    if (unconfirmed.length === 0) {
      open.push('its deployments could not be checked');
    } else {
      const which =
        unconfirmed.length > 3
          ? `${unconfirmed.length} deployments`
          : `${unconfirmed.length === 1 ? 'deployment' : 'deployments'} ${unconfirmed.join(', ')}`;
      open.push(`${which} could not be confirmed as stopped (a board may still be at work)`);
    }
  }
  return new HttpError(
    500,
    'revoke_incomplete',
    `Release ${version} is marked revoked, but ${open.join(' and ')}. ` + 'Revoke it again to finish.'
  );
}

export function createFirmwareHandlers({ aws, config, now, log }, { deployments, fleet = null }) {
  async function findRelease(version) {
    return releaseFromItem(await aws.getRelease(releaseKey(version.parts)));
  }

  return {
    async list() {
      const releases = (await aws.listReleases())
        .map(releaseFromItem)
        .filter((release) => release !== null)
        .sort((a, b) => compareVersions(strictVersion(b.version).parts, strictVersion(a.version).parts));
      return {
        body: {
          releases,
          signingKey: { fingerprint: config.signingKeyFingerprint },
          slotSize: config.slotSize,
        },
      };
    },

    async get({ params }) {
      const version = versionInPath(params.version);
      const release = await findRelease(version);
      if (release === null) throw notFound('unknown_version', `There is no release ${version.text}.`);
      return { body: { release } };
    },

    /**
     * The signed image of an active release, for a release manager's phone app to send to
     * a board over Bluetooth. The board and its bootloader check it again, but the bytes are
     * checked here first against the release, which this server verified when it stored it.
     */
    async image({ params, entry }) {
      const version = versionInPath(params.version);
      entry.target = version.text;
      const release = await findRelease(version);
      if (release === null || release.status !== 'active') {
        throw notFound('unknown_version', `There is no active release ${version.text}.`);
      }
      const data = await aws.getFirmwareObject(objectKey(release.sha256));
      if (data === null) {
        throw notFound('image_unavailable', `The image of ${version.text} cannot be read. It may have been revoked.`);
      }
      if (data.length !== release.size || createHash('sha256').update(data).digest('hex') !== release.sha256) {
        log({ level: 'error', event: 'stored_image_mismatch', version: version.text });
        throw new HttpError(
          500,
          'image_mismatch',
          `The stored image of ${version.text} is not the one that was verified.`
        );
      }
      entry.detail.sha256 = release.sha256;
      const safeName = /^[A-Za-z0-9._+-]{1,64}$/.test(release.filename ?? '') ? release.filename : 'cranium.signed.bin';
      return { file: { data, name: safeName } };
    },

    /**
     * POST /api/firmware/{version}/bluetooth, body { "sha256": "<hex>", "board": "Cranium-1A2B" }
     * with "board" optional: may this image be sent to a board over Bluetooth now? A phone app
     * asks right before every send, whether its image was downloaded just now, kept from
     * earlier, or held in memory, and sends nothing unless the answer is 200 with the same
     * SHA-256. Only an active release whose image has exactly that SHA-256 gets it.
     *
     * Nothing changes, but the question goes on record (firmware.bluetooth_send), its refusals
     * included, so that a send leaves a trace even when it needed no download. What the board
     * finally takes is not known here: the board does not report a Bluetooth upload.
     *
     * The board cannot be made to enforce a revocation. A board takes any image that is
     * signed with the project's key and newer than what it runs, from whoever is at it with a
     * window open; this check holds the apps to the console's word, not anyone else.
     */
    async bluetooth({ params, json, entry }) {
      const version = versionInPath(params.version);
      entry.target = version.text;
      const body = json();
      const sha256 = requireSha256(field(body, 'sha256'));
      entry.detail.sha256 = sha256;
      const board = requireBluetoothName(field(body, 'board'));
      if (board !== null) entry.detail.board = board;
      // Which board it is, by its thing name, and the type it told the phone it is: either one lets
      // the console refuse a release of another type (400 incompatible_board). Both are optional.
      const thing = field(body, 'thing') === undefined ? null : requireThing(field(body, 'thing'));
      if (thing !== null) entry.detail.thing = thing;
      const type = field(body, 'type');
      if (type !== undefined && !isBoardType(type)) {
        throw badRequest('invalid_type', `"type" is the board type the board gave: ${BOARD_TYPES.join(' or ')}.`);
      }
      if (type !== undefined) entry.detail.type = type;
      // And the flash layout it gave, a whole number from 1.
      const layout = field(body, 'layout');
      if (layout !== undefined && !isLayout(layout)) {
        throw badRequest('invalid_layout', '"layout" is the flash layout the board gave: a whole number from 1.');
      }
      if (layout !== undefined) entry.detail.layout = String(layout);

      const release = await findRelease(version);
      if (release === null || release.version !== version.text) {
        throw notFound('unknown_version', `There is no release ${version.text}.`);
      }
      if (release.status !== 'active') {
        throw conflict('release_revoked', `Release ${version.text} is revoked. Do not send it to a board.`);
      }
      if (release.sha256 !== sha256) {
        throw conflict(
          'sha256_mismatch',
          `That image is not the one of release ${version.text}: ` +
            'its SHA-256 is different. Do not send it to a board.'
        );
      }
      if (fleet !== null)
        await fleet.requireBluetoothBoard({ thing, type: type ?? null, layout: layout ?? null }, release);
      return { body: { version: release.version, sha256: release.sha256, status: 'active' } };
    },

    async upload({ actor, json, entry }) {
      const body = json();
      const filename = requireFilename(field(body, 'filename'));
      entry.target = filename;
      entry.detail.filename = filename;
      const notes = requireText(field(body, 'notes'), 'notes', { max: MAX_NOTES });
      const image = requireBase64(field(body, 'data'), 'data');

      let info;
      try {
        info = validateImage(image, config.signingKey, { maxSize: config.slotSize, loadAddress: config.loadAddress });
      } catch (error) {
        if (error instanceof ImageError) throw unprocessable(error.code, error.message);
        throw error;
      }
      // From here on the version is known, and it comes from the signed header only. So does the
      // board type: from the protected TLVs, which the signature that was just checked covers.
      entry.target = info.version;
      entry.detail.sha256 = info.sha256;
      entry.detail.size = String(info.size);
      let board;
      let layout;
      try {
        board = boardOfImage(info.protectedTlvs);
        layout = layoutOfImage(info.protectedTlvs);
      } catch (error) {
        if (error instanceof BoardTlvError) throw unprocessable(error.code, error.message);
        throw error;
      }
      entry.detail.board = board;
      entry.detail.layout = String(layout);
      if (info.version === '0.0.0+0') {
        throw unprocessable(
          'version_zero',
          'The image has version 0.0.0+0. Set a version when you build the firmware.'
        );
      }

      // A version that cannot be registered is refused before the image is stored, so
      // that a refused upload leaves nothing behind. The transaction further down
      // still decides; two uploads at the same moment are settled there.
      const sk = releaseKey(info.versionParts);
      const [taken, highest] = await Promise.all([aws.getRelease(sk), aws.highestReleaseKey()]);
      if (taken !== null) throw versionExists(info.version);
      if (typeof highest === 'string' && !(highest < sk)) throw versionNotNewer(info.version, highest);

      // Stored under its own digest and never replaced. If the key is taken, the same
      // bytes are already there.
      await aws.putFirmwareObject({
        key: objectKey(info.sha256),
        body: image,
        sha256Base64: Buffer.from(info.sha256, 'hex').toString('base64'),
      });

      const release = {
        version: info.version,
        size: info.size,
        sha256: info.sha256,
        imageHash: info.imageHash,
        keyHash: info.keyHash,
        payloadSize: info.payloadSize,
        headerSize: info.headerSize,
        loadAddress: info.loadAddress,
        filename,
        board,
        layout,
        ...(isPiBuild(info.protectedTlvs) ? { pi: true } : {}),
        notes,
        uploadedBy: { sub: actor.sub, email: actor.email },
        uploadedAt: new Date(now()).toISOString(),
        status: 'active',
        revoked: null,
      };
      const registered = await aws.registerRelease({ sk, release });
      if (!registered.ok) {
        if (registered.reason === 'exists') throw versionExists(info.version);
        if (registered.reason === 'not_newer') throw versionNotNewer(info.version, registered.highest);
        throw conflict('upload_conflict', 'Another upload was being registered at the same moment. Try again.');
      }
      change(entry, 'status', null, 'active');
      change(entry, 'notes', null, notes);
      return { status: 201, body: { release } };
    },

    /**
     * PUT /api/firmware/{version}/notes, body { "notes": "..." }: what the release changed, in up to
     * MAX_NOTES characters of one line, as on upload. Active and revoked releases alike; nothing else
     * of the release changes. On record as firmware.notes, with the old note's length and the new
     * note as far as a detail holds it.
     */
    async notes({ params, json, entry }) {
      const version = versionInPath(params.version);
      entry.target = version.text;
      const given = field(json(), 'notes');
      // The whole note, every time: "" clears it, and leaving it out is no way to say so.
      if (given === undefined) throw badRequest('invalid_notes', '"notes" is required: the new note, or "" for none.');
      const notes = requireText(given, 'notes', { max: MAX_NOTES });
      entry.detail.notes = notes.slice(0, 200);
      const existing = await findRelease(version);
      if (existing === null) throw notFound('unknown_version', `There is no release ${version.text}.`);
      entry.detail.oldLength = String(existing.notes.length);
      const changed = await aws.setReleaseNotes({ sk: releaseKey(version.parts), notes });
      if (!changed.ok) throw notFound('unknown_version', `There is no release ${version.text}.`);
      change(entry, 'notes', existing.notes, notes);
      const release = releaseFromItem(changed.release) ?? { ...existing, notes };
      return { body: { release } };
    },

    async revoke({ actor, params, json, entry }) {
      const version = versionInPath(params.version);
      entry.target = version.text;
      const reason = requireText(field(json(), 'reason'), 'reason', { min: 1, max: MAX_REASON });

      const existing = await findRelease(version);
      if (existing === null) throw notFound('unknown_version', `There is no release ${version.text}.`);
      const sk = releaseKey(version.parts);

      // 1. The record: from here on no new deployment of this release can be created.
      const revoked = {
        by: { sub: actor.sub, email: actor.email },
        at: new Date(now()).toISOString(),
        reason,
      };
      const marked = await aws.markReleaseRevoked({ sk, revoked });
      if (marked.ok) {
        entry.detail.reason = reason;
        change(entry, 'status', existing.status ?? 'active', 'revoked');
        change(entry, 'reason', null, reason);
      }

      // 2. and 3. are repeated even if the record was revoked before, so that a
      // revocation that was interrupted half way can be completed by asking again.
      const incomplete = [];
      const failed = (step, error) => {
        incomplete.push(step);
        log({
          level: 'error',
          event: 'revoke_incomplete',
          step,
          version: version.text,
          error: describeError(error),
        });
      };

      // 2. The image: the bucket refuses to serve a tagged object, whatever URL is used.
      try {
        const tagged = await aws.tagFirmwareRevoked(objectKey(existing.sha256));
        if (!tagged.ok) log({ level: 'warn', event: 'revoked_image_missing', version: version.text });
      } catch (error) {
        failed('tag', error);
      }

      // 3. The deployments: boards that have not installed it yet stop before they do.
      let cancelled = [];
      let unconfirmed = [];
      try {
        const result = await deployments.cancelUnfinished(version.text, actor.sub);
        cancelled = result.cancelled;
        unconfirmed = result.failed;
        if (unconfirmed.length > 0) incomplete.push('cancel');
      } catch (error) {
        failed('cancel', error);
      }
      entry.detail.cancelled = String(cancelled.length);

      // 4. The record again: that 2. and 3. are done, and since when. It is written
      // once, by the first request that got that far.
      const enforcedAt = new Date(now()).toISOString();
      let enforced = null;
      if (incomplete.length === 0) {
        try {
          enforced = await aws.markRevocationEnforced({ sk, at: enforcedAt });
        } catch (error) {
          failed('record', error);
        }
      }

      if (incomplete.length > 0) {
        entry.detail.incomplete = incomplete.join(' ');
        throw revokeIncomplete(version.text, incomplete, unconfirmed);
      }
      if (!marked.ok && !enforced.ok) {
        // Revoked before, and nothing was outstanding.
        throw conflict('already_revoked', `Release ${version.text} is already revoked.`);
      }
      // This request completed a revocation that an earlier one had begun.
      if (!marked.ok) entry.detail.resumed = 'true';

      let release = enforced.ok ? releaseFromItem(enforced.release) : null;
      if (release === null) {
        // Another request recorded the completion at the same moment: read what it wrote.
        try {
          release = await findRelease(version);
        } catch (error) {
          log({
            level: 'warn',
            event: 'release_unreadable',
            version: version.text,
            error: describeError(error).message,
          });
        }
      }
      release ??= { ...existing, status: 'revoked', revoked: { ...(existing.revoked ?? revoked), enforcedAt } };
      return { body: { release, cancelled } };
    },
  };
}
