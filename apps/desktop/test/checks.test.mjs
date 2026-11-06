// The app's own checks, held to the pages' code where the pages have the same: the image an upload takes,
// the board's status after the restart (updatewatch.js), the configuration (bridge.js readAppConfig), and
// the check for a newer build.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as watch from '../../../cloud/web/src/site/assets/updatewatch.js';
import { readAppConfig } from '../../../cloud/web/src/site/assets/bridge.js';
import { BridgeError } from '../src/lib/bridge.mjs';
import { MCUBOOT_MAGIC, aboutThisSend, readStatus, uploadImage } from '../src/lib/board.mjs';
import { ConfigError, configResult, poolOf, readConfig } from '../src/lib/config.mjs';
import { compareVersions, newerBuild, platformWord } from '../src/lib/updates.mjs';

test('an upload takes a signed MCUboot image of its SHA-256, and nothing else', () => {
  const image = new Uint8Array(1000);
  image.set(MCUBOOT_MAGIC);
  const sha = createHash('sha256').update(image).digest('hex');
  const base64 = Buffer.from(image).toString('base64');
  assert.equal(uploadImage(base64, sha).bytes.length, 1000);
  assert.throws(() => uploadImage(base64, '0'.repeat(64)), BridgeError);
  assert.throws(() => uploadImage('not base64!', sha), BridgeError);
  const plain = new Uint8Array(1000);
  assert.throws(() => uploadImage(Buffer.from(plain).toString('base64'), createHash('sha256').update(plain).digest('hex')), BridgeError);
  assert.throws(() => uploadImage('', createHash('sha256').update(new Uint8Array(0)).digest('hex')), BridgeError);
});

test("the status after the restart reads as updatewatch.js reads it, and ble.watch's rule is the pages' isAboutThisSend", () => {
  const cases = [];
  for (const via of [0, 1, 2]) {
    for (const target of [[1, 14, 0, 2], [1, 14, 0, 3], [0, 0, 0, 0]]) {
      for (const hash of [null, '0011223344556677', '8899aabbccddeeff']) {
        const b = new Uint8Array(64);
        b[0] = 1;
        b[29] = via;
        b.set([target[0], target[1], target[2] & 0xff, target[2] >> 8, target[3], 0, 0, 0], 32);
        if (hash) b.set(Buffer.from(hash, 'hex'), 48);
        cases.push(b);
      }
    }
  }
  for (const bytes of cases) {
    const ours = readStatus(bytes);
    const pages = watch.parseStatus(bytes);
    assert.equal(ours.lastVia, pages.lastVia);
    assert.equal(ours.lastTarget, pages.lastTarget);
    assert.equal(ours.lastHash, pages.lastHash);
    for (const [version, sentHash] of [
      ['1.14.0+2', '0011223344556677'],
      ['1.14.0+2', null],
      ['1.14.0+3', '8899aabbccddeeff'],
    ]) {
      assert.equal(aboutThisSend(ours, version, sentHash), watch.isAboutThisSend({ version, sentHash }, pages), `${version} ${sentHash}`);
    }
  }
  assert.equal(readStatus(new Uint8Array(10)), null);
});

const example = readFileSync(new URL('../../config/cranium.example.json', import.meta.url), 'utf8');

test('the configuration is read as the pages read it, and app.config gives what the phone apps give', () => {
  const config = readConfig(example, { example: true });
  const pages = readAppConfig(JSON.parse(example));
  assert.equal(config.consoleUrl, pages.consoleUrl);
  assert.equal(config.customer?.apiUrl ?? null, pages.customer?.apiUrl ?? null);
  const result = configResult(config);
  assert.deepEqual(Object.keys(result).sort(), [
    'consoleUrl', 'customerApiUrl', 'customerClientId', 'customerRegion', 'customerUserPoolId', 'example', 'mobileClientId', 'region', 'userPoolId',
  ]);
  assert.equal(result.example, true);
  assert.deepEqual(readAppConfig(result).consoleUrl, config.consoleUrl);
  assert.equal(poolOf(config, 'admin').clientId, config.mobileClientId);
  assert.equal(poolOf(readConfig(JSON.stringify({ ...JSON.parse(example), customerApiUrl: null })), 'customer'), null);
  for (const broken of ['{', '[]', JSON.stringify({ ...JSON.parse(example), consoleUrl: 'http://x' }), JSON.stringify({ ...JSON.parse(example), userPoolId: 'eu-west-1_X' })]) {
    assert.throws(() => readConfig(broken), ConfigError);
  }
});

test('a newer build is news only for this platform, upward, and named as a file of the app', () => {
  const latest = (entry) => JSON.stringify({ android: { version: '9.9.9' }, 'desktop-windows': entry });
  const good = { file: 'Cranium-Setup-0.2.0.exe', version: '0.2.0', sha256: 'a'.repeat(64), size: 100 };
  const found = newerBuild(latest(good), { platform: 'win32', version: '0.1.0' });
  assert.equal(found.version, '0.2.0');
  assert.equal(found.url, 'https://github.com/ese5180/f26-t07-the-cranium/raw/main/apps/dist/Cranium-Setup-0.2.0.exe');
  assert.equal(newerBuild(latest(good), { platform: 'win32', version: '0.2.0' }), null);
  assert.equal(newerBuild(latest(good), { platform: 'linux', version: '0.1.0' }), null);
  assert.equal(newerBuild(latest(good), { platform: 'darwin', version: '0.1.0' }), null);
  assert.equal(newerBuild(latest({ ...good, file: '../evil.exe' }), { platform: 'win32', version: '0.1.0' }), null);
  assert.equal(newerBuild('not json', { platform: 'win32', version: '0.1.0' }), null);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(platformWord('darwin'), null);
});
