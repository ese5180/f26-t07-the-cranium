// IPAs for the tests, made here: a zip writer (stored or deflated entries, optionally with ZIP64 end
// records) and a binary plist writer, enough to make the files an iPhone app's IPA holds and to break
// them in the ways lib/ipa.mjs and lib/plist.mjs must refuse.
//
//   ipa({ version, build, bundleId, config, example, plist: 'binary' | 'xml', extra, zip64 }) -> Buffer
//   zip(entries, { zip64 }) -> Buffer      entries: [{ name, data, method: 0 | 8, crc }]
//   binaryPlist(value) -> Buffer           a dict, array, string, whole number or boolean
//   xmlPlist(value) -> string
//
// This file is test code. It is never packaged with the function.

import { crc32, deflateRawSync } from 'node:zlib';

/** A zip of the entries, in order. */
export function zip(entries, { zip64 = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '');
    const method = entry.method ?? 8;
    const stored = method === 8 ? deflateRawSync(data) : data;
    const crc = entry.crc ?? crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.localOffset ?? offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const parts = [...locals, directory];
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
    end.writeUInt16LE(0xffff, 8);
    end.writeUInt16LE(0xffff, 10);
    end.writeUInt32LE(0xffffffff, 12);
    end.writeUInt32LE(0xffffffff, 16);
  } else {
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
  }
  parts.push(end);
  return Buffer.concat(parts);
}

/** A binary plist ("bplist00") of plain values, as Xcode writes an app's Info.plist. */
export function binaryPlist(value) {
  const objects = [];
  const add = (item) => {
    const index = objects.length;
    objects.push(null);
    if (Array.isArray(item)) {
      objects[index] = { array: item.map(add) };
    } else if (item !== null && typeof item === 'object') {
      const keys = Object.keys(item).map(add);
      const values = Object.values(item).map(add);
      objects[index] = { keys, values };
    } else {
      objects[index] = { scalar: item };
    }
    return index;
  };
  add(value);
  const refSize = objects.length < 256 ? 1 : 2;
  const ref = (index) => {
    const bytes = Buffer.alloc(refSize);
    bytes.writeUIntBE(index, 0, refSize);
    return bytes;
  };
  const marker = (type, length) => {
    if (length < 15) return Buffer.from([(type << 4) | length]);
    // The length as an integer object of its own: two bytes.
    const size = Buffer.alloc(4);
    size[0] = (type << 4) | 0x0f;
    size[1] = 0x11;
    size.writeUInt16BE(length, 2);
    return size;
  };
  const chunks = [Buffer.from('bplist00', 'latin1')];
  const offsets = [];
  let at = 8;
  for (const object of objects) {
    offsets.push(at);
    let bytes;
    if (object.array) {
      bytes = Buffer.concat([marker(0xa, object.array.length), ...object.array.map(ref)]);
    } else if (object.keys) {
      bytes = Buffer.concat([marker(0xd, object.keys.length), ...object.keys.map(ref), ...object.values.map(ref)]);
    } else if (typeof object.scalar === 'string') {
      // eslint-disable-next-line no-control-regex
      if (/^[\x00-\x7f]*$/.test(object.scalar)) {
        bytes = Buffer.concat([marker(0x5, object.scalar.length), Buffer.from(object.scalar, 'latin1')]);
      } else {
        const units = Buffer.from(object.scalar, 'utf16le');
        units.swap16();
        bytes = Buffer.concat([marker(0x6, units.length / 2), units]);
      }
    } else if (typeof object.scalar === 'boolean') {
      bytes = Buffer.from([object.scalar ? 0x09 : 0x08]);
    } else if (Number.isInteger(object.scalar) && object.scalar >= 0) {
      const number = Buffer.alloc(9);
      number[0] = 0x13;
      number.writeBigUInt64BE(BigInt(object.scalar), 1);
      bytes = number;
    } else {
      throw new TypeError(`binaryPlist cannot write ${typeof object.scalar}`);
    }
    chunks.push(bytes);
    at += bytes.length;
  }
  const offsetSize = at < 256 ? 1 : at < 65536 ? 2 : 4;
  const table = Buffer.alloc(objects.length * offsetSize);
  offsets.forEach((offset, index) => table.writeUIntBE(offset, index * offsetSize, offsetSize));
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return Buffer.concat([...chunks, table, trailer]);
}

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The same values as an XML plist. */
export function xmlPlist(value) {
  const write = (item, indent) => {
    const pad = '\t'.repeat(indent);
    if (Array.isArray(item))
      return `${pad}<array>\n${item.map((one) => write(one, indent + 1)).join('')}${pad}</array>\n`;
    if (item !== null && typeof item === 'object') {
      return `${pad}<dict>\n${Object.entries(item)
        .map(([key, one]) => `${pad}\t<key>${escapeXml(key)}</key>\n${write(one, indent + 1)}`)
        .join('')}${pad}</dict>\n`;
    }
    if (typeof item === 'boolean') return `${pad}<${item}/>\n`;
    if (Number.isInteger(item)) return `${pad}<integer>${item}</integer>\n`;
    return `${pad}<string>${escapeXml(String(item))}</string>\n`;
  };
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n' +
    write(value, 0) +
    '</plist>\n'
  );
}

/** `length` bytes that look random and are the same on every run. */
function noise(length) {
  const bytes = Buffer.alloc(length);
  let state = 0x2545f491;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

/** The Info.plist of the app, as apps/ios/App/Info.plist becomes when Xcode builds it. */
export function infoPlist({ version = '0.6.0', build = '8', bundleId = 'com.craniumiot.cranium', extra = {} } = {}) {
  return {
    CFBundleDevelopmentRegion: 'en',
    CFBundleDisplayName: 'Cranium',
    CFBundleExecutable: 'Cranium',
    CFBundleIdentifier: bundleId,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: 'Cranium',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: version,
    CFBundleVersion: build,
    LSRequiresIPhoneOS: true,
    MinimumOSVersion: '16.0',
    NSBluetoothAlwaysUsageDescription: 'Cranium uses Bluetooth to find a board whose Bluetooth window is open.',
    NSFaceIDUsageDescription: 'Cranium uses Face ID to open your saved sign-in.',
    UIDeviceFamily: [1],
    UIRequiredDeviceCapabilities: ['arm64', 'bluetooth-le'],
    ...extra,
  };
}

/** An unsigned IPA of the app, as apps/ios/scripts/build-ipa.sh makes one. */
export function ipa({
  version = '0.6.0',
  build = '8',
  bundleId = 'com.craniumiot.cranium',
  plist = 'binary',
  extra = {},
  config = { consoleUrl: 'https://console.example.invalid', mobileClientId: 'localmobile' },
  example = false,
  zip64 = false,
  more = [],
  padding = 2048,
} = {}) {
  const info = infoPlist({ version, build, bundleId, extra });
  const entries = [
    { name: 'Payload/', data: '', method: 0 },
    { name: 'Payload/Cranium.app/', data: '', method: 0 },
    // The executable: bytes that do not compress, stored, so that the IPA is as large as asked.
    { name: 'Payload/Cranium.app/Cranium', data: noise(padding), method: 0 },
    { name: 'Payload/Cranium.app/Info.plist', data: plist === 'xml' ? xmlPlist(info) : binaryPlist(info), method: 8 },
    { name: 'Payload/Cranium.app/help.json', data: '{"topics":[]}', method: 8 },
  ];
  if (config !== null) {
    entries.push({
      name: 'Payload/Cranium.app/cranium.json',
      data: JSON.stringify({ ...config, redirectUri: 'cranium://signin' }),
      method: 8,
    });
  }
  if (example) entries.push({ name: 'Payload/Cranium.app/cranium.example.json', data: '{}', method: 8 });
  return zip([...entries, ...more], { zip64 });
}
