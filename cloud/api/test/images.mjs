// MCUboot images made here, for the tests of board types and for the local preview's fleet
// (cloud/dev/preview.mjs): the layout of lib/mcuboot.mjs, with a protected TLV area that may
// carry the board type (tag 0xA1, lib/boards.mjs), signed with a key made for the run.
//
//   const key = imageKey();                              // ECDSA P-256, never leaves the process
//   const image = buildImage({ version: '1.13.0+0', board: 'nrf5340dk', key });
//   createTestConsole({ env: keyEnv(key) });             // a console that trusts that key
//
// Nothing here is a real image and no board trusts the key. This file is test and preview code.

import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { BOARD_TLV } from '../src/lib/boards.mjs';
import { parseVersion } from '../src/lib/mcuboot.mjs';

export const LOAD_ADDRESS = 0x30000;
const HEADER_SIZE = 0x200;
const IMAGE_MAGIC = 0x96f3b83d;
const ROM_FIXED = 0x100;
const TLV_INFO = 0x6907;
const TLV_PROT_INFO = 0x6908;
const TLV_SHA256 = 0x10;
const TLV_KEYHASH = 0x01;
const TLV_ECDSA_SIG = 0x22;
// imgtool --security-counter puts this in the protected area.
export const TLV_SEC_CNT = 0x50;

/** A signing key for the run: { privateKey, publicKey, der }. */
export function imageKey() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { ...pair, der: pair.publicKey.export({ type: 'spki', format: 'der' }) };
}

/** What loadConfig (src/config.mjs) needs to trust the key, for fakeEnv's overrides. */
export function keyEnv(key) {
  return { SIGNING_PUBLIC_KEY_B64: key.der.toString('base64') };
}

function entry(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(data.length, 2);
  return Buffer.concat([head, data]);
}

function area(magic, entries) {
  const body = Buffer.concat(entries.map(([type, data]) => entry(type, Buffer.from(data))));
  const info = Buffer.alloc(4);
  info.writeUInt16LE(magic, 0);
  info.writeUInt16LE(info.length + body.length, 2);
  return Buffer.concat([info, body]);
}

/**
 * A signed image.
 *
 * @param {object} options
 * @param {string} options.version         "major.minor.revision+build"
 * @param {object} options.key             from imageKey()
 * @param {string|null} [options.board]    the board type, in the protected area; null for none
 * @param {Array<[number, Buffer|string]>} [options.protectedTlvs]    more protected entries
 * @param {Array<[number, Buffer|string]>} [options.unprotectedTlvs]  entries after the signature,
 *                                         which the signature does not cover
 * @param {Buffer} [options.payload]       the program; bytes of `fill` unless given
 */
export function buildImage({
  version, key, board = null, protectedTlvs = [], unprotectedTlvs = [], payload = null, fill = 0xa5, payloadSize = 96,
  loadAddress = LOAD_ADDRESS,
}) {
  const { major, minor, revision, build } = parseVersion(version);
  const program = payload ?? Buffer.alloc(payloadSize, fill);
  const protectedEntries = [...(board === null ? [] : [[BOARD_TLV, board]]), ...protectedTlvs];
  const guarded = protectedEntries.length === 0 ? Buffer.alloc(0) : area(TLV_PROT_INFO, protectedEntries);
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(IMAGE_MAGIC, 0);
  header.writeUInt32LE(loadAddress, 4);
  header.writeUInt16LE(HEADER_SIZE, 8);
  header.writeUInt16LE(guarded.length, 10);
  header.writeUInt32LE(program.length, 12);
  header.writeUInt32LE(ROM_FIXED, 16);
  header.writeUInt8(major, 20);
  header.writeUInt8(minor, 21);
  header.writeUInt16LE(revision, 22);
  header.writeUInt32LE(build, 24);
  // The hash and the signature cover the header, the program and the protected area.
  const signed = Buffer.concat([header, program, guarded]);
  const trailer = area(TLV_INFO, [
    [TLV_SHA256, createHash('sha256').update(signed).digest()],
    [TLV_KEYHASH, createHash('sha256').update(key.der).digest()],
    [TLV_ECDSA_SIG, sign('sha256', signed, { key: key.privateKey, dsaEncoding: 'der' })],
    ...unprotectedTlvs,
  ]);
  return Buffer.concat([signed, trailer]);
}
