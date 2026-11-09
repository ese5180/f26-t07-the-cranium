/**
 * What the app checks itself about a board, as the phone apps' ShellChecks do: the image ble.upload is
 * given, and whether a status read after the restart is about this send (ble.watch).
 *
 * The status characteristic's payload is the firmware's (firmware/app/src/bt/bt_status.h); the pages read
 * all of it (cloud/web/src/site/assets/updatewatch.js parseStatus). Here only what ble.watch needs.
 *
 * No dependencies: only node:crypto.
 */

import { createHash } from 'node:crypto';

import { BridgeError } from './bridge.mjs';

export const STATUS_SERVICE = '9112b1b4-2a51-40f0-94d3-a76440f0e6cc';
export const STATUS_CHARACTERISTIC = '9112b1b5-2a51-40f0-94d3-a76440f0e6cc';
export const STATUS_FORMAT = 1;
export const STATUS_LENGTH = 64;
// What ble.upload takes at most: 2.5 MiB of image.
export const MAX_IMAGE_BYTES = 2_621_440;
// MCUboot's image magic, at the start of a signed image, little end first.
export const MCUBOOT_MAGIC = Uint8Array.from([0x3d, 0xb8, 0xf3, 0x96]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * ble.upload's image: base64 that decodes, no larger than a slot can be, with the SHA-256 the page gave
 * and MCUboot's magic at the start. The page checked it against the console's release; this is the
 * app's own check that what it sends is what the page checked. { bytes, sha } or a bad_request.
 */
export function uploadImage(base64, sha256) {
  if (typeof base64 !== 'string' || base64.length % 4 !== 0 || !BASE64.test(base64)) {
    throw new BridgeError('bad_request', 'image: not base64');
  }
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new BridgeError('bad_request', 'image: not the size of an image');
  const sha = createHash('sha256').update(bytes).digest();
  if (sha.toString('hex') !== sha256) throw new BridgeError('bad_request', "The image's SHA-256 is not the one given.");
  if (!MCUBOOT_MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new BridgeError('bad_request', 'That is not a signed MCUboot image.');
  }
  return { bytes, sha: new Uint8Array(sha) };
}

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => u16(b, at) + u16(b, at + 2) * 65536;

/** A version of the payload, "1.14.0+3", or null when its eight bytes are zero. */
function versionAt(b, at) {
  if (!b.subarray(at, at + 8).some((byte) => byte !== 0)) return null;
  return `${b[at]}.${b[at + 1]}.${u16(b, at + 2)}+${u32(b, at + 4)}`;
}

/** The part of a status ble.watch needs: { lastVia, lastTarget, lastHash }, or null for a payload it cannot read. */
export function readStatus(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (b.length < STATUS_LENGTH || b[0] !== STATUS_FORMAT) return null;
  const hash = b.subarray(48, 56);
  return {
    lastVia: ['none', 'bluetooth', 'wifi'][b[29]] ?? 'unknown',
    lastTarget: versionAt(b, 32),
    lastHash: hash.some((byte) => byte !== 0) ? Buffer.from(hash).toString('hex') : null,
  };
}

/** "1.14.0+3" as four numbers, or null. */
function release(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,5})\+(\d{1,10})$/.exec(String(text ?? ''));
  return match ? match.slice(1).map(Number) : null;
}

/**
 * ble.watch's rule, as UpdateWatch's isAboutThisSend: the board's last update over Bluetooth is the
 * version sent, and of the image sent where both hashes are known.
 */
export function aboutThisSend(status, version, hash) {
  if (!status || status.lastVia !== 'bluetooth') return false;
  const theirs = release(status.lastTarget);
  const ours = release(version);
  if (!theirs || !ours || theirs.some((part, index) => part !== ours[index])) return false;
  if (!status.lastHash || !hash) return true;
  return status.lastHash === hash;
}
