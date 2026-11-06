// What the console reads of an iPhone app's IPA (src/lib/ipa.mjs) and of the Info.plist inside it
// (src/lib/plist.mjs): the values a release is checked against, from a zip read a few ranges at a
// time, and a refusal in plain words for anything that is not an IPA as Xcode makes one.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { IpaError, readIpa } from '../src/lib/ipa.mjs';
import { PlistError, parsePlist } from '../src/lib/plist.mjs';
import { binaryPlist, infoPlist, ipa, xmlPlist, zip } from './ipa-fixture.mjs';

/** Read a file as the handler does, from S3 in ranges, and count what was asked for. */
function reader(file) {
  const asked = [];
  return {
    asked,
    source: {
      size: file.length,
      read: async (start, end) => {
        asked.push([start, end]);
        return file.subarray(start, end + 1);
      },
    },
  };
}

async function refused(file, pattern) {
  await assert.rejects(readIpa(reader(file).source), (error) => {
    assert.ok(error instanceof IpaError, error.stack);
    assert.match(error.message, pattern);
    return true;
  });
}

test('an IPA says its bundle ID, version, build, oldest iOS, usage descriptions and configuration', async () => {
  for (const plist of ['binary', 'xml']) {
    for (const zip64 of [false, true]) {
      const file = ipa({ version: '0.6.0', build: '8', plist, zip64, padding: 200_000 });
      const { asked, source } = reader(file);
      const read = await readIpa(source);
      assert.deepEqual(
        read,
        {
          app: 'Cranium',
          bundleId: 'com.craniumiot.cranium',
          version: '0.6.0',
          build: '8',
          minOS: '16.0',
          privacy: {
            NSBluetoothAlwaysUsageDescription: 'Cranium uses Bluetooth to find a board whose Bluetooth window is open.',
            NSFaceIDUsageDescription: 'Cranium uses Face ID to open your saved sign-in.',
          },
          config: { consoleUrl: 'https://console.example.invalid', mobileClientId: 'localmobile' },
          exampleConfig: false,
        },
        `${plist} ${zip64}`
      );
      // Never the whole file: the end, the list of files, and two small entries.
      const bytes = asked.reduce((sum, [start, end]) => sum + end - start + 1, 0);
      assert.ok(bytes < file.length / 2, `${bytes} of ${file.length}`);
      assert.ok(asked.every(([start, end]) => start >= 0 && end < file.length && start <= end));
    }
  }
  const example = await readIpa(reader(ipa({ example: true })).source);
  assert.equal(example.exampleConfig, true);
  const bare = await readIpa(reader(ipa({ config: null })).source);
  assert.equal(bare.config, null);
});

test('what is not an IPA as Xcode makes one is refused, saying why', async () => {
  await refused(Buffer.from('not a zip at all, just some text that is long enough'), /not a zip/);
  await refused(Buffer.alloc(10), /too small/);
  const two = ipa({ more: [{ name: 'Payload/Other.app/Info.plist', data: binaryPlist(infoPlist()) }] });
  await refused(two, /more than one app/);
  await refused(
    zip([
      { name: 'Payload/', data: '' },
      { name: 'readme.txt', data: 'hi' },
    ]),
    /outside Payload/
  );
  await refused(zip([{ name: 'Payload/Cranium.app/Cranium', data: 'x' }]), /no Info\.plist/);
  await refused(zip([{ name: 'Payload/', data: '' }]), /no Payload\/<Name>\.app/);
  // The checksum, the compression, encryption, and an offset outside the file.
  await refused(
    zip([{ name: 'Payload/Cranium.app/Info.plist', data: binaryPlist(infoPlist()), crc: 1 }]),
    /checksum does not match/
  );
  await refused(
    zip([{ name: 'Payload/Cranium.app/Info.plist', data: binaryPlist(infoPlist()), method: 12 }]),
    /compressed in a way/
  );
  await refused(
    zip([{ name: 'Payload/Cranium.app/Info.plist', data: binaryPlist(infoPlist()), flags: 1 }]),
    /encrypted/
  );
  await refused(
    zip([{ name: 'Payload/Cranium.app/Info.plist', data: binaryPlist(infoPlist()), localOffset: 10_000_000 }]),
    /out of the file/
  );
  // A list that points at another entry's header: the names do not agree.
  const swapped = zip([
    { name: 'Payload/Cranium.app/help.json', data: '{}' },
    { name: 'Payload/Cranium.app/Info.plist', data: binaryPlist(infoPlist()), localOffset: 0 },
  ]);
  await refused(swapped, /damaged/);
  // An Info.plist that is not one, and a configuration that is not JSON.
  await refused(zip([{ name: 'Payload/Cranium.app/Info.plist', data: 'hello' }]), /Info\.plist cannot be read/);
  await refused(zip([{ name: 'Payload/Cranium.app/Info.plist', data: binaryPlist(['a']) }]), /not a dictionary/);
  await refused(ipa({ more: [] }).subarray(0, 200), /not a zip/);
  const badConfig = zip([
    { name: 'Payload/Cranium.app/Info.plist', data: binaryPlist(infoPlist()) },
    { name: 'Payload/Cranium.app/cranium.json', data: '{not json' },
  ]);
  await refused(badConfig, /cranium\.json is not JSON/);
  // A file that ends early: S3 hands back fewer bytes than asked for.
  const file = ipa();
  await assert.rejects(
    readIpa({ size: file.length + 100, read: async (start, end) => file.subarray(start, end + 1) }),
    IpaError
  );
});

test('a binary plist is read as Xcode writes one; a broken or hostile one is refused', () => {
  const values = { a: 'text', b: 7, c: true, d: false, e: ['x', 'y'], f: { g: 'café ✓' }, long: 'z'.repeat(300) };
  const parsed = parsePlist(binaryPlist(values));
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), values);
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.deepEqual(JSON.parse(JSON.stringify(parsePlist(Buffer.from(xmlPlist(values))))), values);

  // The app's own Info.plist, as it is in the repository (XML, with Xcode's variables not yet filled in).
  const source = parsePlist(readFileSync(new URL('../../../apps/ios/App/Info.plist', import.meta.url)));
  assert.equal(source.CFBundleShortVersionString, '$(MARKETING_VERSION)');
  assert.match(source.NSFaceIDUsageDescription, /Face ID/);

  const broken = (bytes, pattern) =>
    assert.throws(
      () => parsePlist(bytes),
      (error) => error instanceof PlistError && pattern.test(error.message)
    );
  broken(Buffer.alloc(0), /empty/);
  broken(Buffer.from('bplist00'), /truncated/);
  const good = binaryPlist({ a: ['b'] });
  // An array that holds itself: its one reference points back at it.
  const cyclic = Buffer.from(binaryPlist(['x']));
  const arrayAt = 8;
  assert.equal(cyclic[arrayAt], 0xa1);
  cyclic[arrayAt + 1] = 0;
  broken(cyclic, /refers to itself/);
  // A reference past the objects, and an offset table past the end.
  const badRef = Buffer.from(good);
  assert.equal(badRef[8], 0xd1);
  badRef[9] = 0xff;
  broken(badRef, /bad reference/);
  const badTable = Buffer.from(good);
  badTable.writeBigUInt64BE(BigInt(good.length), good.length - 8);
  broken(badTable, /bad offset table/);
  broken(
    Buffer.from('<?xml version="1.0"?><plist version="1.0"><dict><key>a</key></dict></plist>'),
    /expected a tag|unexpected|bad/
  );
  broken(Buffer.from('<plist><string>a</string><string>b</string></plist>'), /more than one value/);
  broken(Buffer.from('<plist><string>a &bogus; b</string></plist>'), /unknown entity/);
  broken(Buffer.alloc(2 * 1024 * 1024, 0x20), /too large/);
  // Shared objects that stand for billions of values in a few bytes: eight arrays, each of fourteen
  // references to the next. What is bounded is the count of values, not only the size of the file.
  const levels = 8;
  const parts = [Buffer.from('bplist00', 'latin1')];
  const offsets = [];
  let at = 8;
  for (let level = 0; level < levels; level += 1) {
    offsets.push(at);
    parts.push(Buffer.from([0xae, ...Array(14).fill(level + 1)]));
    at += 15;
  }
  offsets.push(at);
  parts.push(Buffer.from([0x51, 0x78]));
  at += 2;
  const trailer = Buffer.alloc(32);
  trailer[6] = 1;
  trailer[7] = 1;
  trailer.writeBigUInt64BE(BigInt(levels + 1), 8);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  broken(Buffer.concat([...parts, Buffer.from(offsets), trailer]), /too many objects/);
  assert.equal(parsePlist(binaryPlist(Array.from({ length: 200 }, () => 'x'))).length, 200);
});
