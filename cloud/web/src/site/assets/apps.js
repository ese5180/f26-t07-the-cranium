/**
 * The Apps page: the phone apps, where to get them and how to put them on a phone (docs/mobile-apps.md,
 * "The Apps page"). Fetched when the page is first opened (app.js), and handed what it needs by connect().
 *
 *   Android   the newest release on the console (GET /api/apps), with its note, size and SHA-256, a
 *             Download button, and on request a QR code of a download link for a phone to scan; how to
 *             install it; the older releases, folded away
 *   iPhone    its version and note, from the changelog this deployment was built with (versions.json),
 *             and how to install it with a Mac: clone, the configuration, phone.sh, Trust, Run, renew
 *   Android, built by yourself: clone, the configuration, Gradle
 *
 * A download link is presigned for 15 minutes (cloud/api/src/handlers/apps.mjs) and goes on record when it
 * is made. The QR code holds such a link, made only when somebody asks for one: a phone that scans it
 * downloads the APK without signing in to the console, and so could anyone who sees the code in those 15
 * minutes. The page says so, and when it runs out. The code itself is drawn here, as SVG, from the modules
 * of qrcode.js (Project Nayuki's encoder, vendored and pinned).
 *
 * "Download the configuration" saves cranium.json for apps/config/ in a clone: the six values the apps are
 * built with, from this stack (GET /api/apps/config). They are no secret, but they name the AWS account, so
 * they stay out of the public repository.
 */

import { exactTime, fileSize, plainMessage, plural, sentence, timeAgo } from './core.js';
import { readVersions } from './history.js';
import { QrCode } from './qrcode.js';
import { badge, card, empty, facts, h, icon, loading, loadProblem, mono, notice, pageHead } from './views.js';

// Links for a person to follow, to this project on GitHub. Nothing is fetched from there.
export const REPOSITORY = 'https://github.com/ese5180/f26-t07-the-cranium.git';
export const SETUP_GUIDE = 'https://github.com/ese5180/f26-t07-the-cranium/blob/main/docs/new-board-setup.md#the-phone-apps';
const REFRESH_MS = 60_000;
// White around the code, in modules: the four the standard asks for.
const QUIET_ZONE = 4;
const CONFIG_NAME = 'cranium.json';

let given = null;
// The QR code on show: { version, url, expiresAt, size, path }, made when it was asked for.
let shown = null;
// What is being asked of the API just now: 'qr', 'download:<version>', 'config'.
let busy = '';

/** What app.js hands over: { state, api, load, draw, notify }. */
export function connect(parts) {
  given = parts;
  shown = null;
  busy = '';
}

export function appsResources(state) {
  return [state.apps];
}

export function appsInterval() {
  return REFRESH_MS;
}

/** The releases and the versions, read again. The versions file is read once: it changes with a deployment. */
export async function refreshApps() {
  const { state, api, load } = given;
  await Promise.all([
    load(state.apps, async () => readApps(await api.appsRequest('GET', '/api/apps'))),
    state.versions.value ? null : load(state.versions, () => readVersions(window.fetch.bind(window))),
  ]);
  if (shown !== null && shown.version !== state.apps.value?.android.latest) shown = null;
}

// What the API says, as the page uses it (cloud/api/src/handlers/apps.mjs).

const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,5}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function text(value, max = 600) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function readRelease(raw) {
  if (!VERSION.test(raw?.version ?? '') || !HEX64.test(raw.sha256 ?? '') || !Number.isInteger(raw.size)) return null;
  return {
    version: raw.version,
    versionCode: Number.isInteger(raw.versionCode) ? raw.versionCode : null,
    size: raw.size,
    sha256: raw.sha256,
    notes: text(raw.notes),
    filename: /^cranium-android-[\d.]+\.apk$/.test(raw.filename ?? '') ? raw.filename : `cranium-android-${raw.version}.apk`,
    publishedBy: text(raw.publishedBy?.email, 254),
    publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : null,
  };
}

export function readApps(body) {
  const releases = (Array.isArray(body?.android?.releases) ? body.android.releases : []).map(readRelease).filter(Boolean);
  return {
    android: { latest: releases[0]?.version ?? null, releases },
    ios: { version: VERSION.test(body?.ios?.version ?? '') ? body.ios.version : null, notes: text(body?.ios?.notes) },
  };
}

// The QR code.

/** The dark modules as one SVG path, a rectangle for each run along a row, inside the quiet zone. */
export function qrPath(qr) {
  const parts = [];
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (!qr.getModule(x, y)) continue;
      let run = 1;
      while (x + run < qr.size && qr.getModule(x + run, y)) run += 1;
      parts.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h${run}v1h-${run}z`);
      x += run - 1;
    }
  }
  return parts.join('');
}

/** A link as a QR code: the lowest error correction, which keeps a presigned URL's code as small as it can be. */
export function qrOf(url) {
  const qr = QrCode.encodeText(url, QrCode.Ecc.LOW);
  return { size: qr.size + 2 * QUIET_ZONE, path: qrPath(qr), modules: qr.size };
}

function qrPicture(code) {
  return h('svg', {
    class: 'qr-code',
    viewBox: `0 0 ${code.size} ${code.size}`,
    role: 'img',
    'aria-label': 'QR code of a link that downloads the Android app',
    focusable: 'false',
    'shape-rendering': 'crispEdges',
    vars: { '--qr-modules': String(code.size) },
  }, h('rect', { class: 'qr-paper', width: String(code.size), height: String(code.size) }), h('path', { class: 'qr-ink', d: code.path }));
}

// What the page does.

/** A link from the console: to S3, or, in the preview on this computer, to its stand-in on the same origin. */
function usable(link) {
  const url = link?.url;
  if (typeof url !== 'string') return false;
  const origin = window.location?.origin ?? '';
  return url.startsWith('https://') || (/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin) && url.startsWith(`${origin}/`));
}

function failed(what, error) {
  given.notify(`${what} ${sentence(plainMessage(error))}`, 'bad');
}

async function download(release) {
  if (busy !== '') return;
  busy = `download:${release.version}`;
  given.draw();
  try {
    const { download: link } = await given.api.appsRequest('GET', `/api/apps/android/${release.version}/download`);
    if (!usable(link)) throw new Error('The console gave no download link.');
    window.location.assign(link.url);
    given.notify(`Downloading ${release.filename}.`);
  } catch (error) {
    failed('The APK could not be downloaded.', error);
  } finally {
    busy = '';
    given.draw();
  }
}

async function showQr(release) {
  if (busy !== '') return;
  busy = 'qr';
  given.draw();
  try {
    const { download: link } = await given.api.appsRequest('GET', `/api/apps/android/${release.version}/download?via=qr`);
    if (!usable(link)) throw new Error('The console gave no download link.');
    shown = { version: release.version, url: link.url, expiresAt: link.expiresAt, ...qrOf(link.url) };
  } catch (error) {
    failed('No QR code could be made.', error);
  } finally {
    busy = '';
    given.draw();
  }
}

/** Save the apps' configuration as cranium.json, as apps/configure.sh writes it. */
async function saveConfig() {
  if (busy !== '') return;
  busy = 'config';
  given.draw();
  try {
    const config = await given.api.appsRequest('GET', '/api/apps/config');
    const blob = new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: 'application/json' });
    const address = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = address;
    link.download = CONFIG_NAME;
    link.click();
    setTimeout(() => URL.revokeObjectURL(address), 60_000);
    given.notify(`Saved ${CONFIG_NAME}. Put it in apps/config/ of your clone.`);
  } catch (error) {
    failed('The configuration could not be fetched.', error);
  } finally {
    busy = '';
    given.draw();
  }
}

// Drawing.

function command(line, ctx) {
  return h('div', { class: 'app-command', key: line },
    h('code', { class: 'code' }, line),
    h('button', {
      type: 'button', class: 'btn is-quiet is-icon', title: `Copy ${line}`, 'aria-label': `Copy ${line}`,
      onClick: () => ctx.actions.copy(line, 'the command'),
    }, icon('copy')));
}

function steps(items) {
  return h('ol', { class: 'app-steps' }, items.filter(Boolean).map((item, index) => h('li', { key: String(index) }, item)));
}

function configButton() {
  return h('button', {
    type: 'button', class: 'btn is-small', disabled: busy === 'config', onClick: saveConfig,
  }, icon('download'), 'Download the configuration');
}

function publishedLine(release, now, word = 'Published ') {
  return [
    release.publishedAt
      ? h('time', { datetime: release.publishedAt, title: exactTime(release.publishedAt) }, `${word}${timeAgo(release.publishedAt, now)}`)
      : word.trim(),
    release.publishedBy ? [' by ', h('span', { class: 'who' }, release.publishedBy)] : null,
  ];
}

function qrBlock(release, ctx) {
  const { now } = ctx.state;
  if (shown === null || shown.version !== release.version) {
    return h('div', { class: 'app-qr is-empty', key: 'qr' },
      h('button', { type: 'button', class: 'btn', disabled: busy === 'qr', onClick: () => showQr(release) },
        icon('arrow-right'), 'Show a QR code for a phone'),
      h('p', { class: 'card-note' }, 'A link the phone\'s camera can open: it downloads the APK without signing in, for 15 minutes.'));
  }
  const ends = Date.parse(shown.expiresAt);
  const over = !(ends > now);
  return h('div', { class: `app-qr ${over ? 'is-over' : ''}`.trim(), key: 'qr' },
    over ? null : qrPicture(shown),
    h('div', { class: 'app-qr-text' },
      over
        ? h('p', { class: 'app-qr-state', role: 'status' }, icon('clock'), h('span', null, 'This code has run out.'))
        : h('p', { class: 'app-qr-state' }, icon('clock'), h('span', null, 'Good until ',
          h('time', { datetime: shown.expiresAt, title: exactTime(shown.expiresAt) },
            new Date(ends).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })), '.')),
      h('p', { class: 'card-note' }, 'Point the phone\'s camera at it and open the link. Whoever scans it before then can download the ' +
        'APK without signing in: show it to your own phone only. The link is on record under your name.'),
      h('button', { type: 'button', class: 'btn is-small', disabled: busy === 'qr', onClick: () => showQr(release) },
        icon('restart'), over ? 'Make a new one' : 'Make another')));
}

function androidInstall() {
  return h('section', { class: 'app-how', key: 'install', 'aria-label': 'Installing it' },
    h('h3', { class: 'app-how-title' }, 'Install it on the phone'),
    steps([
      ['Open the APK from the browser\'s downloads, or from Files. Android asks to allow ', h('strong', null, 'Install unknown apps'),
        ' for the app you opened it with: allow it, go back, and tap Install.'],
      'A newer version installs over the one on the phone, and keeps its sign-in. One you built yourself has another key: uninstall it first.',
      ['Open Cranium and sign in with your console account: the e-mail address, the password, then the six-digit code. ',
        'A first sign-in sets a new password and an authenticator app on the AWS sign-in page, where the app sends you.'],
      'The first time it looks for a board, Android asks for Nearby devices (location on Android 11 and older): allow it.',
    ]));
}

function olderReleases(releases, ctx) {
  if (releases.length === 0) return null;
  return h('details', { class: 'app-older', key: 'older' },
    h('summary', null, `Older versions (${releases.length})`),
    h('ul', { class: 'app-older-list' }, releases.map((release) => h('li', { key: release.version, class: 'app-older-row' },
      h('div', { class: 'app-older-text' },
        h('p', { class: 'app-older-title' }, mono(release.version), ' ',
          h('span', { class: 'quiet' }, `${fileSize(release.size)} · `, publishedLine(release, ctx.state.now))),
        release.notes ? h('p', { class: 'card-note' }, release.notes) : null),
      h('button', {
        type: 'button', class: 'btn is-small', disabled: busy === `download:${release.version}`, onClick: () => download(release),
        'aria-label': `Download ${release.version}`,
      }, icon('download'), 'Download')))));
}

/** The newest Android app in the changelog, if it is newer than what is published: a release manager's reminder. */
function unpublished(apps, versions, ctx) {
  const newest = versions?.changelogs?.android?.[0];
  if (!ctx.state.me?.canWrite || !newest || newest.version === apps.android.latest) return null;
  if (apps.android.releases.some((release) => release.version === newest.version)) return null;
  return notice('wait', 'upload', ['Android ', mono(newest.version), ' is in the changelog and not on the console yet.'], {
    more: [' The release build publishes it: ', mono('apps/android/build-release.sh'), '.'],
  });
}

function androidCard(apps, versions, ctx) {
  const [latest, ...older] = apps.android.releases;
  if (!latest) {
    return card({ key: 'android', title: 'Android' },
      empty({
        iconName: 'package',
        title: 'No Android app is on the console yet.',
        text: ctx.state.me?.canWrite
          ? 'A release manager\'s build publishes it here, with an API token in ~/.cranium/console-token:'
          : 'A release manager\'s build publishes it here. Until then, build it yourself, below.',
        command: ctx.state.me?.canWrite ? 'apps/android/build-release.sh' : null,
      }),
      unpublished(apps, versions, ctx));
  }
  return card({ key: 'android', title: 'Android', className: 'app-card' },
    h('div', { class: 'app-latest', key: 'latest' },
      h('div', { class: 'app-latest-text' },
        h('p', { class: 'app-version' }, mono(latest.version), ' ', badge('good', 'check-circle', 'Newest')),
        latest.notes ? h('p', { class: 'app-note' }, latest.notes) : null,
        facts([
          ['Size', fileSize(latest.size),
            latest.size >= 1024 ? h('span', { class: 'quiet' }, ` (${latest.size.toLocaleString('en-US')} bytes)`) : null],
          ['SHA-256', h('span', { class: 'app-digest' }, mono(latest.sha256), h('button', {
            type: 'button', class: 'btn is-quiet is-icon', title: 'Copy the SHA-256', 'aria-label': 'Copy the SHA-256',
            onClick: () => ctx.actions.copy(latest.sha256, `the SHA-256 of ${latest.version}`),
          }, icon('copy')))],
          latest.versionCode !== null ? ['versionCode', mono(String(latest.versionCode))] : null,
          ['Published', publishedLine(latest, ctx.state.now, '')],
        ]),
        h('div', { class: 'button-row app-actions' },
          h('button', {
            type: 'button', class: 'btn is-primary', disabled: busy === `download:${latest.version}`, onClick: () => download(latest),
          }, icon('download'), `Download ${latest.filename}`))),
      qrBlock(latest, ctx)),
    unpublished(apps, versions, ctx),
    androidInstall(),
    olderReleases(older, ctx));
}

function iphoneCard(apps, versions, ctx) {
  const newest = versions?.changelogs?.ios?.[0] ?? null;
  const version = newest?.version ?? apps.ios.version;
  const note = newest?.note ?? apps.ios.notes;
  return card({ key: 'ios', title: 'iPhone', className: 'app-card' },
    h('div', { class: 'app-latest-text', key: 'about' },
      version
        ? h('p', { class: 'app-version' }, mono(version))
        : h('p', { class: 'quiet' }, 'Its version is not known to this copy of the console.'),
      note ? h('p', { class: 'app-note' }, note) : null),
    h('section', { class: 'app-how', key: 'mac', 'aria-label': 'Install it with a Mac' },
      h('h3', { class: 'app-how-title' }, 'Install it with a Mac'),
      h('p', { class: 'card-note' }, 'It takes Xcode 16 or later, ', mono('brew install xcodegen'),
        ', your Apple ID in Xcode (a free Personal Team), and Developer Mode on the iPhone.'),
      steps([
        ['Get the code:', command(`git clone ${REPOSITORY}`, ctx), command('cd f26-t07-the-cranium', ctx)],
        ['Download the configuration, and put ', mono(CONFIG_NAME), ' in ', mono('apps/config/'), ' of the clone.',
          h('div', { class: 'app-step-action' }, configButton())],
        ['Make the project and open it in Xcode:', command('apps/ios/scripts/phone.sh', ctx)],
        'Plug the iPhone in and tap Trust on it. In Xcode, choose the iPhone at the top, and press Run.',
        'The first time, on the iPhone: Settings > General > VPN & Device Management > your Apple ID > Trust. Then open the app.',
        ['Every 7 days the free team\'s app stops opening. Let the Mac renew it by itself:',
          command('apps/ios/scripts/renew.sh --schedule', ctx)],
      ]),
      h('p', { class: 'card-note' }, 'All of it, with what to do when something goes wrong: ',
        h('a', { href: SETUP_GUIDE, target: '_blank', rel: 'noopener noreferrer' }, 'the phone apps in the setup guide'),
        ' (opens GitHub).'),
      h('p', { class: 'card-note' }, 'An iPhone without a Mac needs the paid Apple Developer Program, and TestFlight.')));
}

function buildCard(ctx) {
  return card({ key: 'build', title: 'Build the Android app yourself', className: 'app-card' },
    h('p', { class: 'card-note', key: 'lede' }, 'On Windows, Linux or macOS, with JDK 17 and the Android SDK. A debug build is signed ' +
      'with your own computer\'s key: Android will not put it over the team\'s APK, so uninstall that first.'),
    steps([
      ['Get the code:', command(`git clone ${REPOSITORY}`, ctx), command('cd f26-t07-the-cranium', ctx)],
      ['Download the configuration, and put ', mono(CONFIG_NAME), ' in ', mono('apps/config/'), '.',
        h('div', { class: 'app-step-action' }, configButton())],
      ['Build it, and put it on the phone over USB:', command('cd apps/android', ctx), command('./gradlew assembleDebug', ctx),
        command('adb install -r app/build/outputs/apk/debug/app-debug.apk', ctx)],
    ]));
}

export function appsView(ctx) {
  const { state } = ctx;
  const resource = state.apps;
  const apps = resource.value;
  const versions = state.versions.value && !state.versions.value.missing && !state.versions.value.failed
    ? state.versions.value : null;
  return h('div', { class: 'page apps-page', key: 'page' },
    pageHead({
      title: 'Apps',
      lede: 'The console on a phone. Both apps do what this website does, and send firmware to a board over Bluetooth.',
    }),
    loadProblem(resource, 'the apps', ctx),
    apps
      ? h('div', { class: 'app-grid', key: 'apps' },
        androidCard(apps, versions, ctx),
        iphoneCard(apps, versions, ctx),
        buildCard(ctx))
      : resource.error ? null : loading('the apps'),
    apps && apps.android.releases.length > 1
      ? h('p', { class: 'quiet app-count', key: 'count' }, `${plural(apps.android.releases.length, 'Android version')} on the console.`)
      : null);
}
