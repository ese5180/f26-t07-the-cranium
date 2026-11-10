/**
 * Raspberry Pi images on the Firmware page (console 2.26.0, docs/pi-ota.md, "Cloud").
 *
 *   GET  /api/pi-images                      -> { images: [PiImage] }, newest first; any member
 *   POST /api/pi-images                      body { version, size, sha256, sig, minFirmware?, notes? }
 *                                            -> 201 { image, upload: { method, url, headers, expiresAt } }
 *                                               a URL to PUT the file to; release managers (pi_image.upload)
 *   POST /api/pi-images/{version}/complete   -> { image }  the file that arrived is checked, and the
 *                                               image can be deployed; release managers (pi_image.complete)
 *   POST /api/pi-images/{version}/revoke     body { reason } -> { image, cancelled, failed }
 *                                               release managers (pi_image.revoke)
 *
 * The body of the first is the record that tools/pi_image.py writes beside the image (its .pi.json),
 * which the Firmware page reads from the file a person picks. Its signature is checked here, against
 * the project's key, the way a board checks it (lib/pi-images.mjs): an image whose signature does not
 * hold is refused before a byte is sent (422 bad_signature). A version is taken once; the same record
 * again, while its file has not arrived, gets a new URL, so that an upload that broke off can start over.
 *
 * An image of up to 4 GiB never passes through the API: the browser sends it straight to S3 with a
 * presigned PUT that signs its size, its SHA-256 and "only if new" (the bucket refuses any other write
 * under firmware/). The second call asks S3 what arrived, and the image is "active" only if it is that
 * size and that SHA-256. Revoking marks the record, tags the object so that the bucket serves it no
 * more, also through URLs handed out before, and cancels with force the deployments that carry it.
 */

import { badRequest, conflict, describeError, field, notFound, unprocessable } from '../http.mjs';
import { change } from '../lib/audit.mjs';
import {
  MAX_PI_SIZE,
  PI_PK,
  PI_UPLOAD_EXPIRES_SEC,
  canonicalMinFirmware,
  piImageFromItem,
  piObjectKey,
  presentPiImage,
  verifyPiSignature,
} from '../lib/pi-images.mjs';
import { MAX_NOTES, MAX_REASON, requirePiVersion, requireSha256, requireText } from '../lib/validate.mjs';

const HEX128 = /^[0-9a-f]{128}$/;

function unknownImage(version) {
  return notFound('unknown_version', `There is no Pi image ${version}.`);
}

/** The record of an image, as a request describes it. */
function describedImage(body) {
  const version = requirePiVersion(field(body, 'version'));
  const size = field(body, 'size');
  if (!Number.isInteger(size) || size <= 0 || size > MAX_PI_SIZE) {
    throw badRequest('invalid_size', 'The size is a whole number of bytes, from 1 to 4 GiB - 1.');
  }
  const sha256 = requireSha256(field(body, 'sha256'));
  const sig = field(body, 'sig');
  if (typeof sig !== 'string' || !HEX128.test(sig)) {
    throw badRequest('bad_signature', 'The signature is 128 lowercase hex digits (r and s).');
  }
  const minFirmware = canonicalMinFirmware(field(body, 'minFirmware'));
  if (minFirmware === undefined) {
    throw badRequest('invalid_version', 'minFirmware is a firmware version such as 1.20.0 or 1.20.0+3.');
  }
  const notes = requireText(field(body, 'notes'), 'notes', { max: MAX_NOTES });
  return { version, size, sha256, sig, minFirmware, notes };
}

/** S3's checksum, base64, as lowercase hex. */
function hexOf(base64) {
  return typeof base64 === 'string' ? Buffer.from(base64, 'base64').toString('hex') : '';
}

export function createPiImageHandlers({ aws, config, now, log }, { deployments }) {
  async function find(version) {
    return piImageFromItem(await aws.getFleetItem({ pk: PI_PK, sk: version }));
  }

  /** An image that may be deployed now, or the error that says why not. */
  async function requireActive(version) {
    const image = await find(version);
    if (image === null) throw unknownImage(version);
    if (image.status === 'uploading') {
      throw conflict('not_uploaded', `Pi image ${version} has not finished uploading.`);
    }
    if (image.status !== 'active') {
      throw conflict('release_revoked', `Pi image ${version} is revoked and cannot be deployed.`);
    }
    return image;
  }

  async function uploadFor(image) {
    return {
      method: 'PUT',
      ...(await aws.presignFirmwareUpload({
        key: piObjectKey(image.sha256),
        size: image.size,
        sha256Base64: Buffer.from(image.sha256, 'hex').toString('base64'),
        expiresIn: PI_UPLOAD_EXPIRES_SEC,
      })),
    };
  }

  return {
    find,
    requireActive,

    async list() {
      const items = await aws.listFleetItems(PI_PK);
      const images = items
        .map(piImageFromItem)
        .filter((image) => image !== null)
        .sort((a, b) => ((b.uploadedAt ?? '') < (a.uploadedAt ?? '') ? -1 : 1))
        .map(presentPiImage);
      return { body: { images } };
    },

    async create({ actor, json, entry }) {
      const described = describedImage(json());
      entry.target = described.version;
      entry.detail.version = described.version;
      entry.detail.size = String(described.size);
      if (!verifyPiSignature(described, config.signingKey)) {
        throw unprocessable(
          'bad_signature',
          "The signature does not hold for this record with the project's key: a board would refuse it. " +
            'Sign it with tools/pi_image.py sign.'
        );
      }

      const existing = await find(described.version);
      if (existing !== null) {
        const same =
          existing.status === 'uploading' &&
          existing.sha256 === described.sha256 &&
          existing.size === described.size &&
          existing.sig === described.sig &&
          existing.minFirmware === described.minFirmware;
        if (!same) {
          throw conflict('version_exists', `There is a Pi image ${described.version} already. A version is used once.`);
        }
        return { status: 201, body: { image: presentPiImage(existing), upload: await uploadFor(existing) } };
      }

      const item = {
        ...described,
        status: 'uploading',
        uploadedAt: new Date(now()).toISOString(),
        uploadedBy: { sub: actor.sub, email: actor.email },
        activatedAt: null,
        revokedAt: null,
        revokedReason: '',
        rev: 0,
      };
      const put = await aws.putFleetItem({ pk: PI_PK, sk: described.version, item });
      if (!put.ok) throw conflict('version_exists', `There is a Pi image ${described.version} already.`);
      change(entry, 'pi_image', null, described.version);
      const image = piImageFromItem(item);
      return { status: 201, body: { image: presentPiImage(image), upload: await uploadFor(image) } };
    },

    async complete({ params, entry }) {
      const version = requirePiVersion(params.version);
      entry.target = version;
      const image = await find(version);
      if (image === null) throw unknownImage(version);
      if (image.status === 'active') return { body: { image: presentPiImage(image) } };
      if (image.status !== 'uploading') throw conflict('release_revoked', `Pi image ${version} is revoked.`);

      const arrived = await aws.headFirmwareObject(piObjectKey(image.sha256));
      if (arrived === null) {
        throw conflict('not_uploaded', `The file of Pi image ${version} has not arrived. Send it, then try again.`);
      }
      if (arrived.size !== image.size || hexOf(arrived.sha256Base64) !== image.sha256) {
        throw unprocessable(
          'image_mismatch',
          `What arrived is not the image that was described: ${arrived.size} bytes, not ${image.size}, or another SHA-256.`
        );
      }
      const updated = await aws.updateFleetItem({
        pk: PI_PK,
        sk: version,
        rev: image.rev,
        set: { status: 'active', activatedAt: new Date(now()).toISOString() },
      });
      if (!updated.ok) throw conflict('upload_conflict', 'The image changed meanwhile. Load the page again.');
      change(entry, 'status', 'uploading', 'active');
      return { body: { image: presentPiImage(piImageFromItem(updated.item)) } };
    },

    async revoke({ actor, params, json, entry }) {
      const version = requirePiVersion(params.version);
      entry.target = version;
      const reason = requireText(field(json(), 'reason'), 'reason', { min: 1, max: MAX_REASON });
      const image = await find(version);
      if (image === null) throw unknownImage(version);

      let current = image;
      if (image.status !== 'revoked') {
        const updated = await aws.updateFleetItem({
          pk: PI_PK,
          sk: version,
          rev: image.rev,
          set: { status: 'revoked', revokedAt: new Date(now()).toISOString(), revokedReason: reason },
        });
        if (!updated.ok) throw conflict('upload_conflict', 'The image changed meanwhile. Load the page again.');
        current = piImageFromItem(updated.item);
        entry.detail.reason = reason;
        change(entry, 'status', image.status, 'revoked');
        change(entry, 'reason', null, reason);
      }

      // Repeated on a second revoke, so that one cut off half way is completed by asking again.
      try {
        const tagged = await aws.tagFirmwareRevoked(piObjectKey(image.sha256));
        if (!tagged.ok) log({ level: 'warn', event: 'revoked_pi_image_missing', version });
      } catch (error) {
        log({ level: 'error', event: 'revoke_incomplete', step: 'tag', version, error: describeError(error) });
      }
      const { cancelled, failed } = await deployments.cancelUnfinishedPi(version, actor.sub);
      if (cancelled.length > 0) entry.detail.cancelled = cancelled.join(' ').slice(0, 200);
      return { body: { image: presentPiImage(current), cancelled, failed } };
    },
  };
}
