/**
 * Raspberry Pi images (console 2.26.0, docs/pi-ota.md): what one is, how its signature is checked,
 * and how it is stored.
 *
 * A Pi image is a file for the Pi's partition B and the record that tools/pi_image.py writes beside
 * it: { version, size, sha256, sig, minFirmware? }. The signature is ECDSA P-256 (r||s, 64 bytes)
 * over the manifest below, with the project's firmware signing key, which is how a board checks it
 * (firmware src/pi/pi_image.h). This server checks the same signature before it takes an upload, so
 * that the Firmware page never lists an image that every board would refuse.
 *
 *   cranium-pi-image-v1
 *   version=<version>
 *   size=<decimal>
 *   sha256=<64 lowercase hex>
 *   min_firmware=<major.minor.revision+build, or none>
 *
 * The file goes to S3 at firmware/pi-<sha256>.img, written once, straight from the browser with a
 * presigned PUT that holds it to its size and SHA-256 (lib/presign.mjs), and is kept under firmware/
 * because that is where boards download from. Records are in the state table, pk PIIMG, sk the
 * version: "uploading" until the server has seen the object, then "active", or "revoked".
 *
 * No dependencies beyond node:crypto.
 */

import { verify } from 'node:crypto';

import { PI_VERSION, strictVersion } from './validate.mjs';

export const PI_PK = 'PIIMG';
// FAT32 on the board's card holds a file up to 4 GiB - 1, and a job's size is 32 bits.
export const MAX_PI_SIZE = 0xffffffff;
// A large file from a browser: the URL lasts long enough for a slow upload to start.
export const PI_UPLOAD_EXPIRES_SEC = 3600;
export const PI_STATUSES = Object.freeze(['uploading', 'active', 'revoked']);

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MANIFEST_MAGIC = 'cranium-pi-image-v1';

/**
 * The S3 key of a Pi image: its version and the SHA-256 of its file, firmware/pi-<version>-<sha256>.img,
 * with a version's "+" written "~" (which no version has), so that the key stays plain in a URL. One
 * object per version: revoking a version tags its own object only, never another version's with the
 * same bytes, and a version is created once, so a revoked one is never uploaded or activated again.
 */
export function piObjectKey({ version, sha256 }) {
  if (typeof version !== 'string' || !PI_VERSION.test(version)) throw new TypeError('Not a Pi image version');
  if (typeof sha256 !== 'string' || !HEX64.test(sha256)) throw new TypeError('Not a SHA-256 digest');
  return `firmware/pi-${version.replaceAll('+', '~')}-${sha256}.img`;
}

/**
 * minFirmware as the manifest and a board write it: "1.20.0" is "1.20.0+0". Null for none, and
 * undefined for a value that is not a firmware version.
 */
export function canonicalMinFirmware(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  return strictVersion(value.includes('+') ? value : `${value}+0`)?.text ?? undefined;
}

/** The text the signature covers, as firmware pi_manifest_text() and tools/pi_image.py build it. */
export function piManifest({ version, size, sha256, minFirmware = null }) {
  return (
    `${MANIFEST_MAGIC}\nversion=${version}\nsize=${size}\nsha256=${sha256}\n` +
    `min_firmware=${minFirmware ?? 'none'}\n`
  );
}

/**
 * True if `sig` (128 hex digits, r||s) is the project key's signature over the record's manifest.
 * `signingKey` is config.signingKey (config.mjs): { key: KeyObject }.
 */
export function verifyPiSignature(record, signingKey) {
  if (typeof record.sig !== 'string' || !HEX128.test(record.sig)) return false;
  try {
    return verify(
      'sha256',
      Buffer.from(piManifest(record), 'utf8'),
      { key: signingKey.key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(record.sig, 'hex')
    );
  } catch {
    return false;
  }
}

function text(value, max) {
  return typeof value === 'string' && value.length <= max ? value : '';
}

function instant(value) {
  return typeof value === 'string' && ISO_TIME.test(value) ? value : null;
}

/** A stored item as a PiImage, or null if it is not one. */
export function piImageFromItem(item) {
  if (item === null || typeof item !== 'object') return null;
  if (typeof item.version !== 'string' || !PI_VERSION.test(item.version)) return null;
  if (!Number.isInteger(item.size) || item.size <= 0 || item.size > MAX_PI_SIZE) return null;
  if (typeof item.sha256 !== 'string' || !HEX64.test(item.sha256)) return null;
  if (typeof item.sig !== 'string' || !HEX128.test(item.sig)) return null;
  const minFirmware = canonicalMinFirmware(item.minFirmware);
  if (minFirmware === undefined) return null;
  const by = item.uploadedBy ?? {};
  return {
    version: item.version,
    size: item.size,
    sha256: item.sha256,
    sig: item.sig,
    minFirmware,
    notes: text(item.notes, 500),
    // Anything that is not one of these reads as revoked: nothing unknown is deployed.
    status: PI_STATUSES.includes(item.status) ? item.status : 'revoked',
    uploadedAt: instant(item.uploadedAt),
    uploadedBy: { sub: text(by.sub, 128), email: text(by.email, 320) },
    activatedAt: instant(item.activatedAt),
    revokedAt: instant(item.revokedAt),
    revokedReason: text(item.revokedReason, 200),
    rev: Number.isInteger(item.rev) ? item.rev : 0,
  };
}

/** A PiImage as the API returns it: everything but the store's revision. */
export function presentPiImage(image) {
  const { rev, ...shown } = image;
  return { ...shown, key: piObjectKey(image) };
}
