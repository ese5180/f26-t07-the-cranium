// The Linux packaging: the packages' install script is electron-builder's own with the udev step after it, the
// J-Link rule gives the seat's user the port, the packages install it, and Web Bluetooth is switched on.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { versionIn } from '../scripts/version-of.mjs';
import { INSTALLERS } from '../scripts/installers.mjs';
import { beforeReady } from '../src/platform/linux.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const config = read('../electron-builder.linux.yml');
const ours = read('../resources/linux/after-install.tpl');
const theirs = new URL('../node_modules/app-builder-lib/templates/linux/after-install.tpl', import.meta.url);

test("the install script is electron-builder's own, word for word, with udev told about the rule after it", { skip: !existsSync(theirs) && 'npm ci first' }, () => {
  const part = ours.split('# --- electron-builder\'s after-install.tpl ---\n')[1].split('# --- end of electron-builder\'s after-install.tpl ---\n')[0];
  const template = readFileSync(theirs, 'utf8').replace(/^#!\/bin\/bash\n\n/, '');
  assert.equal(part.trimEnd(), template.trimEnd());
  assert.match(ours.split('# --- end of')[1], /udevadm control --reload-rules/);
});

test('the J-Link rule: SEGGER\'s vendor, for the seat\'s user, before 73-seat-late.rules; and both packages install it', () => {
  const rule = read('../resources/linux/70-cranium-jlink.rules');
  for (const subsystem of ['tty', 'usb']) {
    assert.match(rule, new RegExp(`^SUBSYSTEM=="${subsystem}", ATTRS?\\{idVendor\\}=="1366", MODE="0660", TAG\\+="uaccess"$`, 'm'));
  }
  const install = 'resources/linux/70-cranium-jlink.rules=/usr/lib/udev/rules.d/70-cranium-jlink.rules';
  assert.equal(config.split(install).length - 1, 2, 'in the .deb and the .rpm');
  assert.equal(config.split('afterInstall: resources/linux/after-install.tpl').length - 1, 2);
});

test('the packages are named as a release publishes them, and the version is read from the file', () => {
  assert.equal(versionIn(config), '0.1.6');
  assert.match(config, /^extends: electron-builder\.base\.yml$/m);
  assert.match(config, /^ {2}executableName: cranium$/m);
  assert.match(config, /^ {6}Name: Cranium$/m);
  // electron-builder's ${arch} is amd64 for a .deb and x86_64 for an .rpm.
  const names = { AppImage: 'Cranium-${version}.${ext}', deb: 'cranium_${version}_${arch}.${ext}', rpm: 'cranium-${version}.${arch}.${ext}' };
  for (const pattern of Object.values(names)) assert.ok(config.includes(`artifactName: ${pattern}`), pattern);
  const published = INSTALLERS.linux('0.1.0');
  for (const name of ['Cranium-0.1.0.AppImage', 'cranium_0.1.0_amd64.deb', 'cranium-0.1.0.x86_64.rpm']) {
    assert.ok(published.includes(name), name);
  }
});

test('Web Bluetooth is switched on before Electron is ready', () => {
  const switches = [];
  beforeReady({ app: { commandLine: { appendSwitch: (...args) => switches.push(args) } } });
  assert.deepEqual(switches, [['enable-features', 'WebBluetooth'], ['enable-experimental-web-platform-features']]);
});
