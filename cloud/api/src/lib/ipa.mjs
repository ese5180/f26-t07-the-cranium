/**
 * What an iPhone app's IPA says of itself, read from S3 a few ranges at a time (handlers/apps.mjs):
 * an IPA is a zip of Payload/<Name>.app/, and the app's Info.plist inside it names its bundle ID,
 * its version (CFBundleShortVersionString), its build (CFBundleVersion), the oldest iOS it runs on
 * (MinimumOSVersion), and the reasons it gives for each permission it asks for (the keys
 * NS...UsageDescription), which a SideStore source must declare (lib/sidestore.mjs).
 *
 * The zip is never downloaded whole. Its central directory, at the end, lists the entries with their
 * sizes and where each starts; only that, and the two small entries the console wants, are read:
 * Info.plist and the app's configuration, cranium.json (apps/ios/scripts/copy-config.sh), whose
 * console and client must be this console's.
 *
 * The file comes from a release manager's build and is checked as if it came from anyone: every
 * offset and size is bounded, an entry is read only within the file, encrypted entries are refused,
 * a compressed entry is inflated with a cap on its size, and its CRC-32 must match. Anything that is
 * not as an IPA from Xcode would be is an IpaError, whose message says why in plain words.
 *
 *   readIpa({ size, read })   read(start, end) -> Promise<Buffer> of bytes start..end, inclusive
 *     -> { app, bundleId, version, build, minOS, privacy: { NS...UsageDescription: text },
 *          config: { consoleUrl, mobileClientId } | null, exampleConfig: boolean }
 */

import { crc32, inflateRawSync } from 'node:zlib';

import { PlistError, parsePlist } from './plist.mjs';

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const MAX_DIRECTORY = 8 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_PLIST = 1024 * 1024;
const MAX_CONFIG = 16 * 1024;
const MAX_LOCAL_HEADER = 30 + 0xffff + 0xffff;
const PRIVACY_KEY = /^NS[A-Za-z0-9]+UsageDescription$/;
const APP_DIR = /^Payload\/([^/]+)\.app\//;

export class IpaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IpaError';
  }
}

function refuse(message) {
  throw new IpaError(message);
}

async function readExactly(read, start, length) {
  const bytes = await read(start, start + length - 1);
  if (!Buffer.isBuffer(bytes) || bytes.length !== length) refuse('A part of the file could not be read.');
  return bytes;
}

/** Where the central directory is: { offset, size, entries }. */
async function directoryOf(read, size) {
  if (!Number.isSafeInteger(size) || size < EOCD_SIZE) refuse('It is too small to be a zip.');
  const tailLength = Math.min(size, EOCD_SIZE + MAX_COMMENT);
  const tailStart = size - tailLength;
  const tail = await readExactly(read, tailStart, tailLength);
  let at = -1;
  for (let index = tail.length - EOCD_SIZE; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD && index + EOCD_SIZE + tail.readUInt16LE(index + 20) === tail.length) {
      at = index;
      break;
    }
  }
  if (at === -1) refuse('It is not a zip: it has no end of central directory.');
  if (tail.readUInt16LE(at + 4) !== 0 || tail.readUInt16LE(at + 6) !== 0) refuse('It is a zip in several parts.');
  let entries = tail.readUInt16LE(at + 10);
  let directorySize = tail.readUInt32LE(at + 12);
  let offset = tail.readUInt32LE(at + 16);

  if (entries === 0xffff || directorySize === 0xffffffff || offset === 0xffffffff) {
    // ZIP64: a locator just before the end record says where the larger end record is.
    const locatorAt = at - 20;
    if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== ZIP64_LOCATOR) refuse('Its ZIP64 end record is missing.');
    const recordAt = Number(tail.readBigUInt64LE(locatorAt + 8));
    if (!Number.isSafeInteger(recordAt) || recordAt + 56 > size) refuse('Its ZIP64 end record is out of the file.');
    const record = await readExactly(read, recordAt, 56);
    if (record.readUInt32LE(0) !== ZIP64_EOCD) refuse('Its ZIP64 end record is damaged.');
    entries = Number(record.readBigUInt64LE(32));
    directorySize = Number(record.readBigUInt64LE(40));
    offset = Number(record.readBigUInt64LE(48));
  }
  if (!Number.isSafeInteger(entries) || entries < 1 || entries > MAX_ENTRIES)
    refuse('It lists too many files, or none.');
  if (!Number.isSafeInteger(directorySize) || directorySize < 46 || directorySize > MAX_DIRECTORY) {
    refuse('Its list of files is too large, or empty.');
  }
  if (!Number.isSafeInteger(offset) || offset + directorySize > size) refuse('Its list of files is out of the file.');
  return { offset, size: directorySize, entries };
}

/** The zip64 sizes and offset of an entry whose 32-bit fields are full. */
function zip64Fields(extra, entry) {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    const body = extra.subarray(at + 4, at + 4 + length);
    if (body.length !== length) break;
    if (id === 0x0001) {
      let field = 0;
      const next = () => {
        if (field + 8 > body.length) refuse("An entry's ZIP64 sizes are damaged.");
        const value = Number(body.readBigUInt64LE(field));
        field += 8;
        return value;
      };
      if (entry.size === 0xffffffff) entry.size = next();
      if (entry.compressedSize === 0xffffffff) entry.compressedSize = next();
      if (entry.localOffset === 0xffffffff) entry.localOffset = next();
      return;
    }
    at += 4 + length;
  }
}

/** The entries of the central directory: { name, method, flags, crc, compressedSize, size, localOffset }. */
function entriesOf(directory, count) {
  const entries = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL) refuse('Its list of files is damaged.');
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const end = at + 46 + nameLength + extraLength + commentLength;
    if (end > directory.length) refuse('Its list of files is damaged.');
    const entry = {
      name: directory.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      flags: directory.readUInt16LE(at + 8),
      method: directory.readUInt16LE(at + 10),
      crc: directory.readUInt32LE(at + 16),
      compressedSize: directory.readUInt32LE(at + 20),
      size: directory.readUInt32LE(at + 24),
      localOffset: directory.readUInt32LE(at + 42),
    };
    zip64Fields(directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength), entry);
    entries.push(entry);
    at = end;
  }
  return entries;
}

/** The bytes of one small entry, inflated and checked. */
async function contentOf(read, fileSize, entry, limit) {
  if (entry.flags & 0x0001) refuse(`${entry.name} is encrypted.`);
  if (!Number.isSafeInteger(entry.size) || entry.size > limit) refuse(`${entry.name} is too large.`);
  if (!Number.isSafeInteger(entry.compressedSize) || entry.compressedSize > limit)
    refuse(`${entry.name} is too large.`);
  if (!Number.isSafeInteger(entry.localOffset) || entry.localOffset + 30 > fileSize)
    refuse(`${entry.name} is out of the file.`);
  const header = await readExactly(read, entry.localOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL) refuse(`${entry.name} is damaged.`);
  const nameLength = header.readUInt16LE(26);
  const skip = nameLength + header.readUInt16LE(28);
  const start = entry.localOffset + 30 + skip;
  if (30 + skip > MAX_LOCAL_HEADER || start + entry.compressedSize > fileSize)
    refuse(`${entry.name} is out of the file.`);
  // The local header names the same file as the list does, or the list points at something else.
  if (
    nameLength === 0 ||
    (await readExactly(read, entry.localOffset + 30, nameLength)).toString('utf8') !== entry.name
  ) {
    refuse(`${entry.name} is damaged.`);
  }
  const stored = entry.compressedSize === 0 ? Buffer.alloc(0) : await readExactly(read, start, entry.compressedSize);
  let bytes;
  if (entry.method === 0) {
    bytes = stored;
  } else if (entry.method === 8) {
    try {
      bytes = inflateRawSync(stored, { maxOutputLength: limit });
    } catch {
      refuse(`${entry.name} could not be decompressed.`);
    }
  } else {
    refuse(`${entry.name} is compressed in a way the console does not read.`);
  }
  if (bytes.length !== entry.size || crc32(bytes) >>> 0 !== entry.crc)
    refuse(`${entry.name} is damaged: its checksum does not match.`);
  return bytes;
}

function text(value, max) {
  return typeof value === 'string' && value.length >= 1 && value.length <= max ? value : null;
}

/** What the IPA says of itself (see the top of this file). */
export async function readIpa({ size, read }) {
  const where = await directoryOf(read, size);
  const entries = entriesOf(await readExactly(read, where.offset, where.size), where.entries);

  const apps = new Set();
  for (const entry of entries) {
    const match = APP_DIR.exec(entry.name);
    if (match) apps.add(match[1]);
    else if (
      !entry.name.startsWith('Payload/') &&
      !entry.name.startsWith('__MACOSX/') &&
      !['META-INF/', 'iTunesMetadata.plist', 'iTunesArtwork', 'Symbols/'].some((top) => entry.name.startsWith(top))
    ) {
      refuse(`It holds ${entry.name.slice(0, 80)}, outside Payload/: it is not an IPA.`);
    }
  }
  if (apps.size !== 1)
    refuse(apps.size === 0 ? 'It has no Payload/<Name>.app: it is not an IPA.' : 'It holds more than one app.');
  const [app] = apps;
  const named = (file) => entries.filter((entry) => entry.name === `Payload/${app}.app/${file}`);

  const plists = named('Info.plist');
  if (plists.length !== 1) refuse(`Payload/${app}.app has ${plists.length === 0 ? 'no' : 'more than one'} Info.plist.`);
  let info;
  try {
    info = parsePlist(await contentOf(read, size, plists[0], MAX_PLIST));
  } catch (error) {
    if (error instanceof PlistError) refuse(`Its Info.plist cannot be read (${error.message}).`);
    throw error;
  }
  if (info === null || typeof info !== 'object' || Array.isArray(info) || Buffer.isBuffer(info))
    refuse('Its Info.plist is not a dictionary.');

  const privacy = {};
  for (const key of Object.keys(info).sort()) {
    if (PRIVACY_KEY.test(key) && typeof info[key] === 'string') privacy[key] = info[key].slice(0, 500);
  }

  let config = null;
  const configs = named('cranium.json');
  if (configs.length > 1) refuse('It holds more than one cranium.json.');
  if (configs.length === 1) {
    let parsed = null;
    try {
      parsed = JSON.parse((await contentOf(read, size, configs[0], MAX_CONFIG)).toString('utf8'));
    } catch (error) {
      if (error instanceof IpaError) throw error;
      refuse('Its cranium.json is not JSON.');
    }
    config = {
      consoleUrl: text(parsed?.consoleUrl, 300),
      mobileClientId: text(parsed?.mobileClientId, 128),
    };
  }

  return {
    app,
    bundleId: text(info.CFBundleIdentifier, 155),
    version: text(info.CFBundleShortVersionString, 32),
    build: text(info.CFBundleVersion, 32),
    minOS: text(info.MinimumOSVersion, 16),
    privacy,
    config,
    exampleConfig: named('cranium.example.json').length > 0,
  };
}
