/**
 * The Apps page (apps.js) with its QR encoder (qrcode.js), the console's version in the foot of every page
 * (views.js footView), and What's new on the History page (history.js), each drawn in the stand-in
 * document with the scripts the browser loads.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  APPS, CORE, HISTORY, NEIGHBOURS, QR, VIEWS, all, click, controls, createDocument, one, textOf,
} from './page.mjs';

const apps = await import(APPS);
const { QrCode } = await import(QR);
const views = await import(VIEWS);
const history = await import(HISTORY);
const core = await import(CORE);
globalThis.document = createDocument();

const NOW = Date.parse('2026-11-04T18:00:00Z');
const SHA = 'c0ffee'.padEnd(64, '0');
const PRESIGNED = 'https://cranium-firmwarebucket-1.s3.us-east-1.amazonaws.com/apps/android/cranium-android-0.4.0.apk' +
  `?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Security-Token=${'IQoJb3JpZ2luX2Vj'.repeat(60)}&X-Amz-Signature=${'ab'.repeat(32)}`;
const RELEASES = [
  {
    version: '0.4.0', versionCode: 4, size: 12_027_314, sha256: SHA, notes: 'Open the app with your fingerprint.',
    filename: 'cranium-android-0.4.0.apk', publishedBy: { sub: 's', email: 'manager@preview.invalid' }, publishedAt: '2026-11-04T15:00:00.000Z',
  },
  {
    version: '0.3.0', versionCode: 3, size: 11_760_344, sha256: 'b'.repeat(64), notes: 'A cleaner design.',
    filename: 'cranium-android-0.3.0.apk', publishedBy: { sub: 's', email: 'manager@preview.invalid' }, publishedAt: '2026-11-03T19:00:00.000Z',
  },
];
const VERSIONS = history.parseVersions({
  console: { version: '1.10.0', commit: 'a'.repeat(40) },
  changelogs: {
    console: ['1.10.0', '1.9.1', '1.9.0', '1.8.0', '1.7.1', '1.7.0'].map((version, index) => ({
      version, note: `What ${version} brought.`, commit: '7f34f56', date: `2026-11-0${4 - Math.min(index, 3)}`,
    })),
    ios: [{ version: '0.4.0', note: 'Open the app with Face ID.' }],
    android: [{ version: '0.5.0', note: 'The board log.' }, { version: '0.4.0', note: 'Open the app with your fingerprint.' }],
    firmware: [],
  },
});

/** The card of the page whose heading is exactly `title`. */
function cardOf(root, title) {
  const found = all(root, 'section.card').filter((card) => textOf(all(card, 'h2')[0] ?? card) === title);
  assert.equal(found.length, 1, title);
  return found[0];
}

/** The button whose accessible name is `label`. */
function labelled(root, label) {
  const found = all(root, 'button').filter((button) => button.getAttribute('aria-label') === label);
  assert.equal(found.length, 1, label);
  return found[0];
}

function resource(value) {
  return { value, error: null, loading: false, loadedAt: NOW };
}

/** The Apps page in a box, with an API that answers from `answers` and remembers what it was asked. */
function appsPage({ releases = RELEASES, canWrite = true, versions = VERSIONS, answers = {} } = {}) {
  const box = document.createElement('div');
  document.body.replaceChildren(box);
  const asked = [];
  const notes = [];
  const copied = [];
  const state = {
    now: NOW,
    me: { canWrite },
    apps: resource(apps.readApps({ android: { releases }, ios: { version: '0.4.0', notes: 'From the API.' } })),
    versions: resource(versions),
  };
  const ctx = { state, actions: { copy: (value) => copied.push(value) } };
  const draw = () => views.render(box, apps.appsView(ctx));
  const api = {
    async appsRequest(method, path) {
      asked.push(`${method} ${path}`);
      const answer = answers[path];
      if (answer instanceof Error) throw answer;
      return answer ?? {};
    },
  };
  apps.connect({ state, api, load: async () => {}, draw, notify: (message, tone = 'good') => notes.push([tone, message]) });
  globalThis.window = { location: { origin: 'https://console.example', assign: () => {} } };
  draw();
  return { box, asked, notes, copied, state, draw, ctx };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the QR encoder is the pinned library: its output is the C version\'s, module for module', () => {
  // Digests of the modules (rows of 0 and 1) that the C version of the same commit makes of these texts.
  const LONG = `https://cranium-firmwarebucket-1a2b3c4d5e6f.s3.us-east-1.amazonaws.com/apps/android/cranium-android-0.4.0.apk?X-Amz-Security-Token=${'IQoJb3JpZ2luX2VjEJr'.repeat(70).slice(0, 1300)}&X-Amz-Signature=${'ab'.repeat(32)}`;
  for (const [ecc, text, size, digest] of [
    [QrCode.Ecc.MEDIUM, 'Hello, world!', 21, '60e12c4292e429687bcfde01ea5bbfeb22f28963c13cac92d48e3cbfe60cb21a'],
    [QrCode.Ecc.LOW, 'https://console.craniumiot.com/#/apps', 29, '9e9774615f6c760100dbb2e7e33047e41454fb609e9bde0538291db6d43ca2ae'],
    [QrCode.Ecc.LOW, LONG, 129, 'a9cc9e24c45bd5efaaab643a6e75f6ed4dfd688c27e2a6953cd4e2874ecfa8ff'],
  ]) {
    const qr = QrCode.encodeText(text, ecc);
    assert.equal(qr.size, size, text.slice(0, 20));
    const rows = [];
    for (let y = 0; y < qr.size; y += 1) {
      let row = '';
      for (let x = 0; x < qr.size; x += 1) row += qr.getModule(x, y) ? '1' : '0';
      rows.push(row);
    }
    assert.equal(createHash('sha256').update(rows.join('\n')).digest('hex'), digest, text.slice(0, 20));
  }
  const source = readFileSync(new URL('../src/site/assets/qrcode.js', import.meta.url), 'utf8');
  assert.match(source, /commit 8518684c0f33d004fa93971be2c6a8eca3167d1e/);
  assert.match(source, /Copyright \(c\) Project Nayuki\. \(MIT License\)/);
  assert.match(source, /Permission is hereby granted, free of charge/);
  const licence = readFileSync(new URL('../src/site/assets/qrcode-license.txt', import.meta.url), 'utf8');
  assert.match(licence, /^QR Code generator library/);
  assert.match(licence, /MIT License\n\nCopyright \(c\) Project Nayuki\./);
  // Only the Apps page imports it.
  for (const name of ['app.js', 'core.js', 'views.js', 'history.js', 'fleet.js', 'telemetry.js', 'serial.js']) {
    assert.equal(readFileSync(new URL(`../src/site/assets/${name}`, import.meta.url), 'utf8').includes('qrcode.js'), false, name);
  }
});

test('the SVG path of a code draws exactly its dark modules, inside a quiet zone of four', () => {
  const qr = QrCode.encodeText(PRESIGNED, QrCode.Ecc.LOW);
  const drawn = new Set();
  for (const [, x, y, run] of apps.qrPath(qr).matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    for (let step = 0; step < Number(run); step += 1) drawn.add(`${Number(x) + step - 4},${Number(y) - 4}`);
  }
  let dark = 0;
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.getModule(x, y)) dark += 1;
      assert.equal(drawn.has(`${x},${y}`), qr.getModule(x, y), `${x},${y}`);
    }
  }
  assert.equal(drawn.size, dark);
  assert.equal(apps.qrPath(qr).replace(/M\d+ \d+h\d+v1h-\d+z/g, ''), '');
  assert.equal(apps.qrOf(PRESIGNED).size, qr.size + 8);
});

test('Android: the newest version with its note, size and SHA-256, Download, and the older ones folded away', async () => {
  const { box, asked, notes, copied } = appsPage({
    answers: { '/api/apps/android/0.4.0/download': { download: { url: PRESIGNED, expiresAt: '2026-11-04T18:15:00.000Z' } } },
  });
  const android = cardOf(box, 'Android');
  assert.match(textOf(one(android, 'p.app-version')), /^0\.4\.0 Newest$/);
  assert.equal(textOf(one(android, 'p.app-note')), 'Open the app with your fingerprint.');
  const facts = textOf(one(android, 'dl.facts'));
  assert.match(facts, /Size 11\.47 MiB \(12,027,314 bytes\)/);
  assert.match(facts, new RegExp(`SHA-256 ${SHA}`));
  assert.match(facts, /versionCode 4/);
  assert.match(facts, /Published 3 h ago by manager@preview\.invalid/);
  assert.deepEqual(textOf(one(android, 'ol.app-steps')).match(/Install unknown apps/g), ['Install unknown apps']);
  assert.match(textOf(one(android, 'ol.app-steps')), /sign in with your console account/);
  // The older version is folded away, with its own Download.
  const older = one(android, 'details.app-older');
  assert.equal(textOf(one(older, 'summary')), 'Older versions (1)');
  assert.match(textOf(older), /0\.3\.0 11\.22 MiB · Published 23 h ago by manager@preview\.invalid A cleaner design\./);
  assert.ok(controls(older).includes('Download 0.3.0'));
  // A release manager is told that a newer version is in the changelog and not published.
  assert.match(textOf(android), /Android 0\.5\.0 is in the changelog and not on the console yet/);

  const assigned = [];
  globalThis.window = { location: { origin: 'https://console.example', assign: (url) => assigned.push(url) } };
  click(one(android, 'button', 'Download cranium-android-0.4.0.apk'));
  await settle();
  assert.deepEqual(asked, ['GET /api/apps/android/0.4.0/download']);
  assert.deepEqual(assigned, [PRESIGNED]);
  assert.deepEqual(notes, [['good', 'Downloading cranium-android-0.4.0.apk.']]);
  click(labelled(android, 'Copy the SHA-256'));
  assert.deepEqual(copied, [SHA]);
});

test('the QR code is made when asked for, holds a presigned link, says until when, and runs out', async () => {
  const page = appsPage({
    answers: { '/api/apps/android/0.4.0/download?via=qr': { download: { url: PRESIGNED, expiresAt: '2026-11-04T18:15:00.000Z' } } },
  });
  // Nothing is asked for, and no link made, until somebody wants one.
  assert.equal(all(page.box, 'svg.qr-code').length, 0);
  assert.deepEqual(page.asked, []);
  click(one(page.box, 'button', 'Show a QR code for a phone'));
  await settle();
  await settle();
  assert.deepEqual(page.asked, ['GET /api/apps/android/0.4.0/download?via=qr']);
  const svg = one(page.box, 'svg.qr-code');
  const qr = QrCode.encodeText(PRESIGNED, QrCode.Ecc.LOW);
  assert.equal(svg.getAttribute('viewBox'), `0 0 ${qr.size + 8} ${qr.size + 8}`);
  assert.equal(svg.getAttribute('role'), 'img');
  assert.equal(one(svg, 'path.qr-ink').getAttribute('d'), apps.qrPath(qr));
  const words = textOf(one(page.box, 'div.app-qr'));
  assert.match(words, /Good until \d{1,2}:\d{2}(?: [AP]M)?\./);
  assert.match(words, /without signing in: show it to your own phone only/);
  assert.equal(all(one(page.box, 'div.app-qr'), 'time')[0].getAttribute('datetime'), '2026-11-04T18:15:00.000Z');

  // At the time it ends, the code is gone and a new one can be made.
  page.state.now = Date.parse('2026-11-04T18:15:01Z');
  page.draw();
  assert.equal(all(page.box, 'svg.qr-code').length, 0);
  assert.match(textOf(one(page.box, 'div.app-qr')), /This code has run out\./);
  assert.ok(controls(page.box).includes('Make a new one'));
});

test('a refused link or a link that is not S3\'s says so, and draws no code', async () => {
  const refused = Object.assign(new Error('There is no Android app 0.4.0 on the console.'), { status: 404, code: 'unknown_version' });
  const page = appsPage({
    answers: {
      '/api/apps/android/0.4.0/download?via=qr': refused,
      '/api/apps/android/0.4.0/download': { download: { url: 'http://elsewhere.example/x.apk' } },
    },
  });
  globalThis.window = { location: { origin: 'https://console.example', assign: () => assert.fail('no download') } };
  click(one(page.box, 'button', 'Show a QR code for a phone'));
  await settle();
  assert.equal(all(page.box, 'svg.qr-code').length, 0);
  assert.equal(page.notes[0][0], 'bad');
  assert.match(page.notes[0][1], /^No QR code could be made\. There is no Android app 0\.4\.0 on the console\./);
  click(one(page.box, 'button', 'Download cranium-android-0.4.0.apk'));
  await settle();
  assert.deepEqual(page.notes[1], ['bad', 'The APK could not be downloaded. The console gave no download link.']);
});

test('iPhone: its version and note from versions.json, and how to install it with a Mac', () => {
  const { box, copied } = appsPage();
  const iphone = cardOf(box, 'iPhone');
  assert.equal(textOf(one(iphone, 'p.app-version')), '0.4.0');
  assert.equal(textOf(one(iphone, 'p.app-note')), 'Open the app with Face ID.');
  const text = textOf(iphone);
  for (const words of ['git clone https://github.com/ese5180/f26-t07-the-cranium.git', 'apps/ios/scripts/phone.sh',
    'tap Trust', 'press Run', 'VPN & Device Management', 'apps/ios/scripts/renew.sh --schedule', 'Every 7 days',
    'An iPhone without a Mac needs the paid Apple Developer Program, and TestFlight.']) {
    assert.ok(text.includes(words), words);
  }
  const guide = one(iphone, 'a', 'the phone apps in the setup guide');
  assert.equal(guide.getAttribute('href'), 'https://github.com/ese5180/f26-t07-the-cranium/blob/main/docs/new-board-setup.md#the-phone-apps');
  assert.equal(guide.getAttribute('rel'), 'noopener noreferrer');
  click(labelled(iphone, 'Copy apps/ios/scripts/phone.sh'));
  assert.deepEqual(copied, ['apps/ios/scripts/phone.sh']);
  // Without versions.json, the API's word for it.
  const bare = appsPage({ versions: { missing: true } });
  assert.equal(textOf(one(cardOf(bare.box, 'iPhone'), 'p.app-note')), 'From the API.');
});

test('the configuration is saved as cranium.json, exactly as the API gives it; building Android yourself', async () => {
  const config = {
    consoleUrl: 'https://console.example', loginDomain: 'https://login.example', mobileClientId: 'abc', redirectUri: 'cranium://signin',
    region: 'us-east-1', userPoolId: 'us-east-1_x',
  };
  const page = appsPage({ answers: { '/api/apps/config': config } });
  const saved = [];
  const original = document.createElement;
  const blobs = [];
  const created = URL.createObjectURL;
  URL.createObjectURL = (blob) => {
    blobs.push(blob);
    return 'blob:console/1';
  };
  document.createElement = (tag) => (tag === 'a' ? { click() { saved.push([this.href, this.download]); } } : original(tag));
  try {
    click(one(cardOf(page.box, 'iPhone'), 'button', 'Download the configuration'));
    await settle();
    await settle();
  } finally {
    document.createElement = original;
    URL.createObjectURL = created;
  }
  assert.deepEqual(page.asked, ['GET /api/apps/config']);
  assert.deepEqual(saved, [['blob:console/1', 'cranium.json']]);
  assert.equal(await blobs[0].text(), `${JSON.stringify(config, null, 2)}\n`);
  assert.deepEqual(page.notes, [['good', 'Saved cranium.json. Put it in apps/config/ of your clone.']]);

  const build = cardOf(page.box, 'Build the Android app yourself');
  for (const words of ['git clone https://github.com/ese5180/f26-t07-the-cranium.git', './gradlew assembleDebug',
    'adb install -r app/build/outputs/apk/debug/app-debug.apk', 'Download the configuration']) {
    assert.ok(textOf(build).includes(words), words);
  }
});

test('before anything is published: what a release manager runs, and what a viewer can do instead', () => {
  const manager = textOf(cardOf(appsPage({ releases: [] }).box, 'Android'));
  assert.match(manager, /No Android app is on the console yet\./);
  assert.match(manager, /apps\/android\/build-release\.sh/);
  const viewer = appsPage({ releases: [], canWrite: false });
  const words = textOf(cardOf(viewer.box, 'Android'));
  assert.match(words, /build it yourself, below/);
  assert.doesNotMatch(words, /build-release\.sh|in the changelog/);
  assert.equal(all(viewer.box, 'svg.qr-code').length, 0);
});

test('what the API says is taken only where it has the form it should', () => {
  const read = apps.readApps({
    android: { releases: [{ version: '0.4', sha256: SHA, size: 1 }, { ...RELEASES[0], filename: '../x' }, null] },
    ios: { version: 'x', notes: 5 },
  });
  assert.deepEqual(read.android.releases.map((release) => [release.version, release.filename]), [['0.4.0', 'cranium-android-0.4.0.apk']]);
  assert.deepEqual(read.ios, { version: null, notes: '' });
});

test('the foot of every page says the console\'s version, and leads to what is new and to the apps', () => {
  const box = document.createElement('div');
  views.render(box, views.footView({ state: { me: { console: { version: '1.9.1', commit: '1036507'.padEnd(40, 'a') } } } }));
  assert.match(textOf(box), /^Console 1\.9\.1 · 1036507/);
  assert.deepEqual(all(box, 'a').map((link) => [textOf(link), link.getAttribute('href')]),
    [['What’s new', '#/history'], ['Phone apps', '#/apps']]);
  views.render(box, views.footView({ state: { me: { console: { version: null, commit: null } } } }));
  assert.match(textOf(box), /^Console version not known/);
  // /api/me's console part, as the page reads it: only a version and a full commit id.
  const api = core.createApi({
    auth: { accessToken: () => 'T' }, crypto: globalThis.crypto, clock: { observe() {} }, onUnauthorized() {},
    fetch: async () => new Response(JSON.stringify({ sub: 's', console: { version: '1.9.1<', commit: 'abc' } }), { status: 200 }),
  });
  return api.me().then((me) => assert.deepEqual(me.console, { version: null, commit: null }));
});

test('What\'s new on the History page: the console\'s versions with their notes, newest first, the rest folded away', async () => {
  const box = document.createElement('div');
  const ctx = {
    state: { now: NOW, me: { canWrite: true }, commits: resource({ missing: true }), versions: resource(VERSIONS) },
    actions: { redraw() {} },
  };
  views.render(box, history.historyView(ctx));
  const section = one(box, 'section.whats-new');
  assert.match(textOf(one(section, 'header')), /What’s new This console is 1\.10\.0/);
  const shown = all(all(section, 'ol.whats-new-list')[0], 'li.whats-new-row');
  assert.deepEqual(shown.map((row) => textOf(one(row, 'p.whats-new-version')).split(' ')[0]), ['1.10.0', '1.9.1', '1.9.0', '1.8.0']);
  assert.match(textOf(shown[0]), /This console/);
  assert.equal(textOf(one(shown[1], 'p.whats-new-note')), 'What 1.9.1 brought.');
  assert.equal(textOf(one(section, 'summary')), 'Earlier versions (2)');

  // Without the file, the page says where the list is.
  ctx.state.versions = resource({ missing: true });
  views.render(box, history.historyView(ctx));
  assert.match(textOf(one(box, 'section.whats-new')), /cloud\/CHANGELOG\.md has them/);

  // The file beside the script, as readHistory reads its own.
  const asked = [];
  const answer = await history.readVersions(async (url) => {
    asked.push(url);
    return Response.json({ console: { version: '1.9.1' }, changelogs: { console: [{ version: '1.9.1', note: 'n' }] } });
  });
  assert.deepEqual(asked, [`${NEIGHBOURS}versions.json`]);
  assert.deepEqual(answer.changelogs.console, [{ version: '1.9.1', note: 'n', commit: null, date: null }]);
  assert.deepEqual(await history.readVersions(async () => new Response('', { status: 404 })), { missing: true });
  assert.ok((await history.readVersions(async () => { throw new Error('offline'); })).failed);
});

test('the Apps page is a section of the console, in the masthead and in the address bar', () => {
  assert.deepEqual(core.parseRoute('#/apps'), { view: 'apps' });
  assert.equal(core.routeHash({ view: 'apps' }), '#/apps');
  const box = document.createElement('div');
  views.render(box, views.navView({ state: { route: { view: 'apps' }, me: { canWrite: false } } }));
  const link = one(box, 'a', 'Apps');
  assert.equal(link.getAttribute('href'), '#/apps');
  assert.equal(link.getAttribute('aria-current'), 'page');
  // The page asks the API for its own reads and nothing else.
  const api = core.createApi({
    auth: { accessToken: () => 'T' }, crypto: globalThis.crypto, clock: { observe() {} }, onUnauthorized() {},
    fetch: async () => Response.json({}),
  });
  return Promise.all([
    assert.rejects(api.appsRequest('POST', '/api/apps/android/uploads'), /not a request of the Apps page/),
    assert.rejects(api.appsRequest('GET', '/api/apps/android/0.4.0/download?via=mail'), /not a request of the Apps page/),
    api.appsRequest('GET', '/api/apps/android/0.4.0/download?via=qr'),
  ]);
});

test('the audit log has words for the apps\' actions', () => {
  const said = (action, outcome = 'ok') => core.describeAudit({ action, target: '0.4.0', outcome, detail: [['via', 'qr']] });
  assert.equal(said('app.publish').verb, 'published the Android app');
  assert.equal(said('app.download').verb, 'downloaded the Android app');
  assert.equal(said('app.upload', 'rejected').verb, 'tried to start publishing the Android app');
  assert.deepEqual(said('app.download').facts.map((fact) => [fact.label, fact.words ?? fact.value]), [['As', 'a QR code for a phone']]);
});
