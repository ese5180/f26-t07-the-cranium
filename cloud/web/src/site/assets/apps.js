/**
 * The Apps page: the phone apps, where to get them and how to put them on a phone (docs/mobile-apps.md,
 * "The Apps page"). Fetched when the page is first opened (app.js), and handed what it needs by connect().
 *
 *   Android   the newest release on the console (GET /api/apps), with its note, size and SHA-256, a
 *             Download button, and on request a QR code of a download link for a phone to scan; how to
 *             install it; the older releases, folded away
 *   iPhone    the newest version published as an IPA (GET /api/apps), or else the newest in the changelog this
 *             deployment was built with (versions.json); how to have it on any iPhone with SideStore, from
 *             the member's own source link (GET and POST /api/apps/sidestore); and how to install it with a
 *             Mac: clone, the configuration, phone.sh, Trust, Run, renew
 *   Android, built by yourself: clone, the configuration, Gradle
 *
 * A download link is presigned for 15 minutes (cloud/api/src/handlers/apps.mjs) and goes on record when it
 * is made. The QR code holds such a link, made only when somebody asks for one: a phone that scans it
 * downloads the APK without signing in to the console, and so could anyone who sees the code in those 15
 * minutes. The page says so, and when it runs out. The code itself is drawn here, as SVG, from the modules
 * of qrcode.js (Project Nayuki's encoder, vendored and pinned).
 *
 * A SideStore source link (cloud/api/src/handlers/sidestore.mjs) holds a key that downloads the iPhone app
 * without signing in, like an API token: it is shown once, when it is made, as an "Add to SideStore" link,
 * the address to copy, and a QR code of the link for the iPhone's camera. After that the page says only
 * when it was made and last used; making a new one, or turning it off, ends it.
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
export const SETUP_GUIDE =
  'https://github.com/ese5180/f26-t07-the-cranium/blob/main/docs/new-board-setup.md#the-phone-apps';
// SideStore's own installation guide, and this project's steps for the team.
export const SIDESTORE_GUIDE = 'https://docs.sidestore.io/docs/installation/prerequisites';
export const UPDATES_GUIDE =
  'https://github.com/ese5180/f26-t07-the-cranium/blob/main/docs/mobile-apps.md#updates-on-every-phone';
const REFRESH_MS = 60_000;
// White around the code, in modules: the four the standard asks for.
const QUIET_ZONE = 4;
const CONFIG_NAME = 'cranium.json';

let given = null;
// The QR code on show: { version, url, expiresAt, size, path }, made when it was asked for.
let shown = null;
// What is being asked of the API just now: 'qr', 'download:<version>', 'ipa:<version>', 'config', 'link'.
let busy = '';
// The member's SideStore link: status 'unknown' | 'none' | 'active' | 'failed', what the API says of it
// ({ id, createdAt, lastUsedAt }), and the link itself while it is on show, the once it was made:
// { id, url, add, size, path }. `confirming` is 'replace' or 'revoke' while the page asks first.
let link = { status: 'unknown', source: null, made: null, confirming: '' };

/** What app.js hands over: { state, api, load, draw, notify }. */
export function connect(parts) {
  given = parts;
  shown = null;
  busy = '';
  link = { status: 'unknown', source: null, made: null, confirming: '' };
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
    readLink(api),
  ]);
  if (shown !== null && shown.version !== state.apps.value?.android.latest) shown = null;
}

/** The member's SideStore link, as the API knows it. A link on show stays until it is replaced or turned off. */
async function readLink(api) {
  try {
    const source = readSource((await api.appsRequest('GET', '/api/apps/sidestore'))?.source);
    const made = source !== null && link.made?.id === source.id ? link.made : null;
    link = { ...link, status: source === null ? 'none' : 'active', source, made };
  } catch {
    if (link.status === 'unknown') link = { ...link, status: 'failed' };
  }
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
    filename: /^cranium-android-[\d.]+\.apk$/.test(raw.filename ?? '')
      ? raw.filename
      : `cranium-android-${raw.version}.apk`,
    publishedBy: text(raw.publishedBy?.email, 254),
    publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : null,
  };
}

function readIpa(raw) {
  if (!VERSION.test(raw?.version ?? '') || !HEX64.test(raw.sha256 ?? '') || !Number.isInteger(raw.size)) return null;
  return {
    version: raw.version,
    buildVersion: /^\d{1,10}$/.test(raw.buildVersion ?? '') ? raw.buildVersion : null,
    size: raw.size,
    sha256: raw.sha256,
    notes: text(raw.notes),
    filename: `cranium-ios-${raw.version}.ipa`,
    publishedBy: text(raw.publishedBy?.email, 254),
    publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : null,
  };
}

export function readApps(body) {
  const releases = (Array.isArray(body?.android?.releases) ? body.android.releases : [])
    .map(readRelease)
    .filter(Boolean);
  const ipas = (Array.isArray(body?.ios?.releases) ? body.ios.releases : []).map(readIpa).filter(Boolean);
  return {
    android: { latest: releases[0]?.version ?? null, releases },
    ios: {
      version: VERSION.test(body?.ios?.version ?? '') ? body.ios.version : null,
      notes: text(body?.ios?.notes),
      latest: ipas[0]?.version ?? null,
      releases: ipas,
    },
  };
}

const SOURCE_ID = /^[0-9a-f]{16}$/;
// The address of a source, as the console makes one: https, or plain http for the preview on this computer.
const SOURCE_URL =
  /^(?:https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?)\/api\/sidestore\/crs_[A-Za-z0-9_-]{43}\/source\.json$/;

/** A SideStore link as the API describes it to its owner, or null. */
export function readSource(raw) {
  if (!SOURCE_ID.test(raw?.id ?? '')) return null;
  return {
    id: raw.id,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    lastUsedAt: typeof raw.lastUsedAt === 'string' ? raw.lastUsedAt : null,
  };
}

/** A new link as POST /api/apps/sidestore gives it, or null: its address, and the sidestore:// link that adds it. */
export function readNewSource(body) {
  const source = readSource(body?.source);
  const url = body?.url;
  if (source === null || typeof url !== 'string' || !SOURCE_URL.test(url)) return null;
  const add = `sidestore://source?url=${encodeURIComponent(url)}`;
  if (body.add !== add) return null;
  return { source, url, add };
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

function qrPicture(code, label = 'QR code of a link that downloads the Android app') {
  return h(
    'svg',
    {
      class: 'qr-code',
      viewBox: `0 0 ${code.size} ${code.size}`,
      role: 'img',
      'aria-label': label,
      focusable: 'false',
      'shape-rendering': 'crispEdges',
      vars: { '--qr-modules': String(code.size) },
    },
    h('rect', { class: 'qr-paper', width: String(code.size), height: String(code.size) }),
    h('path', { class: 'qr-ink', d: code.path })
  );
}

// What the page does.

/** A link from the console: to S3, or, in the preview on this computer, to its stand-in on the same origin. */
function usable(link) {
  const url = link?.url;
  if (typeof url !== 'string') return false;
  const origin = window.location?.origin ?? '';
  return (
    url.startsWith('https://') ||
    (/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin) && url.startsWith(`${origin}/`))
  );
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
    const { download: link } = await given.api.appsRequest(
      'GET',
      `/api/apps/android/${release.version}/download?via=qr`
    );
    if (!usable(link)) throw new Error('The console gave no download link.');
    shown = { version: release.version, url: link.url, expiresAt: link.expiresAt, ...qrOf(link.url) };
  } catch (error) {
    failed('No QR code could be made.', error);
  } finally {
    busy = '';
    given.draw();
  }
}

async function downloadIpa(release) {
  if (busy !== '') return;
  busy = `ipa:${release.version}`;
  given.draw();
  try {
    const { download: answer } = await given.api.appsRequest('GET', `/api/apps/ios/${release.version}/download`);
    if (!usable(answer)) throw new Error('The console gave no download link.');
    window.location.assign(answer.url);
    given.notify(`Downloading ${release.filename}.`);
  } catch (error) {
    failed('The IPA could not be downloaded.', error);
  } finally {
    busy = '';
    given.draw();
  }
}

/** A new SideStore link, which ends the one before: shown this once. */
async function makeLink() {
  if (busy !== '') return;
  busy = 'link';
  given.draw();
  try {
    const made = readNewSource(await given.api.appsRequest('POST', '/api/apps/sidestore'));
    if (made === null) throw new Error('The console gave no source link.');
    link = {
      status: 'active',
      source: made.source,
      confirming: '',
      made: { id: made.source.id, url: made.url, add: made.add, ...qrOf(made.add) },
    };
    given.notify('Made your SideStore link. It is shown this once.');
  } catch (error) {
    link = { ...link, confirming: '' };
    failed('No SideStore link could be made.', error);
  } finally {
    busy = '';
    given.draw();
  }
}

async function revokeLink() {
  if (busy !== '') return;
  busy = 'link';
  given.draw();
  try {
    await given.api.appsRequest('POST', '/api/apps/sidestore/revoke');
    link = { status: 'none', source: null, made: null, confirming: '' };
    given.notify('Turned off your SideStore link. SideStore can no longer download the app with it.');
  } catch (error) {
    link = { ...link, confirming: '' };
    failed('The SideStore link could not be turned off.', error);
  } finally {
    busy = '';
    given.draw();
  }
}

function confirmFirst(what) {
  link = { ...link, confirming: what };
  given.draw();
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
  return h(
    'div',
    { class: 'app-command', key: line },
    h('code', { class: 'code' }, line),
    h(
      'button',
      {
        type: 'button',
        class: 'btn is-quiet is-icon',
        title: `Copy ${line}`,
        'aria-label': `Copy ${line}`,
        onClick: () => ctx.actions.copy(line, 'the command'),
      },
      icon('copy')
    )
  );
}

/** Commands and paths for a step, closed under "Commands" so that the step reads as words. */
function commands(...lines) {
  return h('details', { class: 'more is-spaced app-commands' }, h('summary', null, 'Commands'), lines);
}

function steps(items) {
  return h(
    'ol',
    { class: 'app-steps' },
    items.filter(Boolean).map((item, index) => h('li', { key: String(index) }, item))
  );
}

function configButton() {
  return h(
    'button',
    {
      type: 'button',
      class: 'btn is-small',
      disabled: busy === 'config',
      onClick: saveConfig,
    },
    icon('download'),
    'Download the configuration'
  );
}

function publishedLine(release, now, word = 'Published ') {
  return [
    release.publishedAt
      ? h(
          'time',
          { datetime: release.publishedAt, title: exactTime(release.publishedAt) },
          `${word}${timeAgo(release.publishedAt, now)}`
        )
      : word.trim(),
    release.publishedBy ? [' by ', h('span', { class: 'who' }, release.publishedBy)] : null,
  ];
}

function qrBlock(release, ctx) {
  const { now } = ctx.state;
  if (shown === null || shown.version !== release.version) {
    return h(
      'div',
      { class: 'app-qr is-empty', key: 'qr' },
      h(
        'button',
        { type: 'button', class: 'btn', disabled: busy === 'qr', onClick: () => showQr(release) },
        icon('arrow-right'),
        'Show a QR code for a phone'
      ),
      h(
        'p',
        { class: 'card-note' },
        "A link the phone's camera can open: it downloads the APK without signing in, for 15 minutes."
      )
    );
  }
  const ends = Date.parse(shown.expiresAt);
  const over = !(ends > now);
  return h(
    'div',
    { class: `app-qr ${over ? 'is-over' : ''}`.trim(), key: 'qr' },
    over ? null : qrPicture(shown),
    h(
      'div',
      { class: 'app-qr-text' },
      over
        ? h('p', { class: 'app-qr-state', role: 'status' }, icon('clock'), h('span', null, 'This code has run out.'))
        : h(
            'p',
            { class: 'app-qr-state' },
            icon('clock'),
            h(
              'span',
              null,
              'Good until ',
              h(
                'time',
                { datetime: shown.expiresAt, title: exactTime(shown.expiresAt) },
                new Date(ends).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
              ),
              '.'
            )
          ),
      h(
        'p',
        { class: 'card-note' },
        "Point the phone's camera at it and open the link. Whoever scans it before then can download the " +
          'APK without signing in: show it to your own phone only. The link is on record under your name.'
      ),
      h(
        'button',
        { type: 'button', class: 'btn is-small', disabled: busy === 'qr', onClick: () => showQr(release) },
        icon('restart'),
        over ? 'Make a new one' : 'Make another'
      )
    )
  );
}

function androidInstall() {
  return h(
    'section',
    { class: 'app-how', key: 'install', 'aria-label': 'Installing it' },
    h('h3', { class: 'app-how-title' }, 'Install it on the phone'),
    steps([
      [
        "Open the APK from the browser's downloads, or from Files. Android asks to allow ",
        h('strong', null, 'Install unknown apps'),
        ' for the app you opened it with: allow it, go back, and tap Install.',
      ],
      'A newer version installs over the one on the phone, and keeps its sign-in. One you built yourself has another key: uninstall it first.',
      [
        'Open Cranium and sign in with your console account: the e-mail address, the password, then the six-digit code. ',
        'A first sign-in sets a new password and an authenticator app on the sign-in page, where the app sends you.',
      ],
      'The first time it looks for a board, Android asks for Nearby devices (location on Android 11 and older): allow it.',
    ])
  );
}

function olderReleases(releases, ctx) {
  if (releases.length === 0) return null;
  return h(
    'details',
    { class: 'app-older', key: 'older' },
    h('summary', null, `Older versions (${releases.length})`),
    h(
      'ul',
      { class: 'app-older-list' },
      releases.map((release) =>
        h(
          'li',
          { key: release.version, class: 'app-older-row' },
          h(
            'div',
            { class: 'app-older-text' },
            h(
              'p',
              { class: 'app-older-title' },
              mono(release.version),
              ' ',
              h('span', { class: 'quiet' }, `${fileSize(release.size)} · `, publishedLine(release, ctx.state.now))
            ),
            release.notes ? h('p', { class: 'card-note' }, release.notes) : null
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn is-small',
              disabled: busy === `download:${release.version}`,
              onClick: () => download(release),
              'aria-label': `Download ${release.version}`,
              title: `Download ${release.version}`,
            },
            icon('download'),
            'Download'
          )
        )
      )
    )
  );
}

/** The newest Android app in the changelog, if it is newer than what is published: a release manager's reminder. */
function unpublished(apps, versions, ctx) {
  const newest = versions?.changelogs?.android?.[0];
  if (!ctx.state.me?.canWrite || !newest || newest.version === apps.android.latest) return null;
  if (apps.android.releases.some((release) => release.version === newest.version)) return null;
  return [
    notice('wait', 'upload', ['Android ', mono(newest.version), ' is in the changelog and not on the console yet.'], {
      more: ' The release build publishes it.',
    }),
    commands(command('apps/android/build-release.sh', ctx)),
  ];
}

function androidCard(apps, versions, ctx) {
  const [latest, ...older] = apps.android.releases;
  if (!latest) {
    return card(
      { key: 'android', title: 'Android' },
      empty({
        iconName: 'package',
        title: 'No Android app is on the console yet.',
        text: ctx.state.me?.canWrite
          ? "A release manager's build publishes it here, with the release manager's API token."
          : "A release manager's build publishes it here. Until then, build it yourself, below.",
      }),
      ctx.state.me?.canWrite
        ? commands(
            h('p', { class: 'card-note' }, 'The token is read from ', mono('~/.cranium/console-token'), '.'),
            command('apps/android/build-release.sh', ctx)
          )
        : null,
      unpublished(apps, versions, ctx)
    );
  }
  return card(
    { key: 'android', title: 'Android', className: 'app-card' },
    h(
      'div',
      { class: 'app-latest', key: 'latest' },
      h(
        'div',
        { class: 'app-latest-text' },
        h('p', { class: 'app-version' }, mono(latest.version), ' ', badge('good', 'check-circle', 'Newest')),
        latest.notes ? h('p', { class: 'app-note' }, latest.notes) : null,
        facts([
          [
            'Size',
            fileSize(latest.size),
            latest.size >= 1024
              ? h('span', { class: 'quiet' }, ` (${latest.size.toLocaleString('en-US')} bytes)`)
              : null,
          ],
          [
            'SHA-256',
            h(
              'span',
              { class: 'app-digest' },
              mono(latest.sha256),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn is-quiet is-icon',
                  title: 'Copy the SHA-256',
                  'aria-label': 'Copy the SHA-256',
                  onClick: () => ctx.actions.copy(latest.sha256, `the SHA-256 of ${latest.version}`),
                },
                icon('copy')
              )
            ),
          ],
          latest.versionCode !== null ? ['versionCode', mono(String(latest.versionCode))] : null,
          ['Published', publishedLine(latest, ctx.state.now, '')],
        ]),
        h(
          'div',
          { class: 'button-row app-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn is-primary',
              disabled: busy === `download:${latest.version}`,
              onClick: () => download(latest),
            },
            icon('download'),
            `Download ${latest.filename}`
          )
        )
      ),
      qrBlock(latest, ctx)
    ),
    unpublished(apps, versions, ctx),
    androidInstall(),
    olderReleases(older, ctx)
  );
}

/** The member's own source link: made, on show the once, or how it stands. */
function linkBlock(ctx) {
  const { now } = ctx.state;
  if (link.made !== null) {
    const { made } = link;
    return h(
      'div',
      { class: 'app-qr app-source', key: 'link' },
      qrPicture(made, 'QR code that adds your own source to SideStore'),
      h(
        'div',
        { class: 'app-qr-text' },
        h('a', { class: 'btn is-primary', href: made.add }, icon('plus'), 'Add to SideStore'),
        h(
          'div',
          { class: 'app-command' },
          h('code', { class: 'code' }, made.url),
          h(
            'button',
            {
              type: 'button',
              class: 'btn is-quiet is-icon',
              title: 'Copy the source link',
              'aria-label': 'Copy the source link',
              onClick: () => ctx.actions.copy(made.url, 'your source link'),
            },
            icon('copy')
          )
        ),
        h(
          'p',
          { class: 'card-note' },
          'On the iPhone, tap Add to SideStore, or scan the code with its camera. In SideStore you ' +
            'can also add the address under Sources. It is shown this once: keep it to yourself, since whoever has it can ' +
            'download the app without signing in. If it got out, make a new one, which ends this one.'
        )
      )
    );
  }
  const ask = (what, words, run) =>
    h(
      'div',
      { class: 'button-row', key: `ask-${what}` },
      h('button', { type: 'button', class: 'btn is-small is-danger', disabled: busy === 'link', onClick: run }, words),
      h('button', { type: 'button', class: 'btn is-small is-quiet', onClick: () => confirmFirst('') }, 'Keep it')
    );
  if (link.status === 'active' && link.source !== null) {
    const { source } = link;
    return h(
      'div',
      { class: 'app-source', key: 'link' },
      h(
        'p',
        null,
        'Your source link was made ',
        source.createdAt
          ? h(
              'time',
              { datetime: source.createdAt, title: exactTime(source.createdAt) },
              timeAgo(source.createdAt, now)
            )
          : 'earlier',
        source.lastUsedAt
          ? [
              ', and SideStore last used it ',
              h(
                'time',
                { datetime: source.lastUsedAt, title: exactTime(source.lastUsedAt) },
                timeAgo(source.lastUsedAt, now)
              ),
            ]
          : ', and has not been used yet',
        '. The console shows a link only when it is made.'
      ),
      link.confirming === 'replace'
        ? ask('replace', 'Make a new link: SideStore stops updating from this one', makeLink)
        : link.confirming === 'revoke'
          ? ask('revoke', 'Turn it off: SideStore stops updating the app', revokeLink)
          : h(
              'div',
              { class: 'button-row' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn is-small',
                  disabled: busy === 'link',
                  onClick: () => confirmFirst('replace'),
                },
                icon('restart'),
                'Make a new link'
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn is-small is-quiet',
                  disabled: busy === 'link',
                  onClick: () => confirmFirst('revoke'),
                },
                icon('ban'),
                'Turn it off'
              )
            )
    );
  }
  return h(
    'div',
    { class: 'app-source', key: 'link' },
    link.status === 'failed'
      ? h('p', { class: 'card-note' }, 'Whether you have a link could not be looked up just now.')
      : null,
    h(
      'button',
      { type: 'button', class: 'btn is-primary', disabled: busy === 'link', onClick: makeLink },
      icon('key'),
      'Make my SideStore link'
    ),
    h(
      'p',
      { class: 'card-note' },
      'A link of your own, which SideStore reads without signing in to the console. It is shown once.'
    )
  );
}

function sidestoreSection(apps, ctx) {
  return h(
    'section',
    { class: 'app-how', key: 'sidestore', 'aria-label': 'On any iPhone, with SideStore' },
    h('h3', { class: 'app-how-title' }, 'On any iPhone, with SideStore'),
    h(
      'p',
      { class: 'card-note' },
      'Free, with your own Apple ID, and a computer only the first time. SideStore signs the app ' +
        'on the iPhone and installs each new version from your own source.'
    ),
    apps.ios.latest === null
      ? h(
          'p',
          { class: 'card-note' },
          'No iPhone version is published on the console yet: your source lists it once one is.'
        )
      : null,
    steps([
      [
        'Install SideStore on the iPhone, once, with a computer, as ',
        h('a', { href: SIDESTORE_GUIDE, target: '_blank', rel: 'noopener noreferrer' }, "SideStore's own guide"),
        ' says (opens docs.sidestore.io). Sign in to it with your own Apple ID.',
      ],
      ['Add your own source to SideStore:', h('div', { class: 'app-step-action' }, linkBlock(ctx))],
      'In SideStore, open the Cranium source and install Cranium. Open it and sign in with your console account; Face ID works as in any app.',
      'SideStore renews the app on the iPhone every 7 days, over Wi-Fi, and shows each new version under Updates. Open SideStore once a week if it has not refreshed by itself.',
    ]),
    h(
      'p',
      { class: 'card-note' },
      'What to do when something goes wrong: ',
      h('a', { href: UPDATES_GUIDE, target: '_blank', rel: 'noopener noreferrer' }, 'updates on every phone'),
      ' (opens GitHub).'
    )
  );
}

function iphoneCard(apps, versions, ctx) {
  const [published] = apps.ios.releases;
  const newest = versions?.changelogs?.ios?.[0] ?? null;
  const version = published?.version ?? newest?.version ?? apps.ios.version;
  const note = published ? published.notes : (newest?.note ?? apps.ios.notes);
  return card(
    { key: 'ios', title: 'iPhone', className: 'app-card' },
    h(
      'div',
      { class: 'app-latest-text', key: 'about' },
      version
        ? h('p', { class: 'app-version' }, mono(version), published ? badge('good', 'check-circle', 'Newest') : null)
        : h('p', { class: 'quiet' }, 'Its version is not known to this copy of the console.'),
      note ? h('p', { class: 'app-note' }, note) : null,
      published
        ? facts([
            ['Size', fileSize(published.size)],
            ['SHA-256', h('span', { class: 'app-digest' }, mono(published.sha256))],
            published.buildVersion ? ['Build', mono(published.buildVersion)] : null,
            ['Published', publishedLine(published, ctx.state.now, '')],
          ])
        : null,
      published
        ? h(
            'div',
            { class: 'button-row app-actions' },
            h(
              'button',
              {
                type: 'button',
                class: 'btn is-small',
                disabled: busy === `ipa:${published.version}`,
                onClick: () => downloadIpa(published),
              },
              icon('download'),
              `Download ${published.filename}`
            )
          )
        : null
    ),
    sidestoreSection(apps, ctx),
    h(
      'section',
      { class: 'app-how', key: 'mac', 'aria-label': 'Install it with a Mac' },
      h('h3', { class: 'app-how-title' }, 'Or install it with a Mac'),
      h(
        'p',
        { class: 'card-note' },
        'It takes Xcode 16 or later, ',
        mono('brew install xcodegen'),
        ', your Apple ID in Xcode (a free Personal Team), and Developer Mode on the iPhone.'
      ),
      steps([
        ['Get the code.', commands(command(`git clone ${REPOSITORY}`, ctx), command('cd f26-t07-the-cranium', ctx))],
        [
          'Download the configuration, and put ',
          mono(CONFIG_NAME),
          ' in ',
          mono('apps/config/'),
          ' of the clone.',
          h('div', { class: 'app-step-action' }, configButton()),
        ],
        ['Make the project and open it in Xcode.', commands(command('apps/ios/scripts/phone.sh', ctx))],
        'Plug the iPhone in and tap Trust on it. In Xcode, choose the iPhone at the top, and press Run.',
        'The first time, on the iPhone: Settings > General > VPN & Device Management > your Apple ID > Trust. Then open the app.',
        [
          "Every 7 days the free team's app stops opening. Let the Mac renew it by itself.",
          commands(command('apps/ios/scripts/renew.sh --schedule', ctx)),
        ],
      ]),
      h(
        'p',
        { class: 'card-note' },
        'All of it, with what to do when something goes wrong: ',
        h(
          'a',
          { href: SETUP_GUIDE, target: '_blank', rel: 'noopener noreferrer' },
          'the phone apps in the setup guide'
        ),
        ' (opens GitHub).'
      ),
      h('p', { class: 'card-note' }, "The owner's iPhone is kept up to date this way, over the Mac's Wi-Fi.")
    )
  );
}

function buildCard(ctx) {
  return card(
    { key: 'build', title: 'Build the Android app yourself', className: 'app-card' },
    h(
      'p',
      { class: 'card-note', key: 'lede' },
      'On Windows, Linux or macOS, with JDK 17 and the Android SDK. A debug build is signed ' +
        "with your own computer's key: Android will not put it over the team's APK, so uninstall that first."
    ),
    steps([
      ['Get the code.', commands(command(`git clone ${REPOSITORY}`, ctx), command('cd f26-t07-the-cranium', ctx))],
      [
        'Download the configuration, and put ',
        mono(CONFIG_NAME),
        ' in ',
        mono('apps/config/'),
        '.',
        h('div', { class: 'app-step-action' }, configButton()),
      ],
      [
        'Build it, and put it on the phone over USB.',
        commands(
          command('cd apps/android', ctx),
          command('./gradlew assembleDebug', ctx),
          command('adb install -r app/build/outputs/apk/debug/app-debug.apk', ctx)
        ),
      ],
    ])
  );
}

export function appsView(ctx) {
  const { state } = ctx;
  const resource = state.apps;
  const apps = resource.value;
  const versions =
    state.versions.value && !state.versions.value.missing && !state.versions.value.failed ? state.versions.value : null;
  return h(
    'div',
    { class: 'page apps-page', key: 'page' },
    pageHead({
      title: 'Apps',
      lede: 'The console on a phone, including firmware updates over Bluetooth.',
      how: {
        title: 'How the apps work',
        text: ['Both apps do what this website does, and send firmware to a board over Bluetooth.'],
      },
    }),
    loadProblem(resource, 'the apps', ctx),
    apps
      ? h(
          'div',
          { class: 'app-grid', key: 'apps' },
          androidCard(apps, versions, ctx),
          iphoneCard(apps, versions, ctx),
          buildCard(ctx)
        )
      : resource.error
        ? null
        : loading('the apps'),
    apps && apps.android.releases.length > 1
      ? h(
          'p',
          { class: 'quiet app-count', key: 'count' },
          `${plural(apps.android.releases.length, 'Android version')} on the console.`
        )
      : null
  );
}
