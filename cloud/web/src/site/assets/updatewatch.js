/**
 * What became of an image sent over Bluetooth, step by step, and the board's own status over Bluetooth
 * that it reads first (docs/mobile-apps.md, "Following the board after a send" and "The status
 * characteristic"). The web pages' copy of the phone apps' UpdateWatch and BoardStatus
 * (CraniumKit/UpdateWatch.swift and BoardStatus.swift, core/UpdateWatch.kt and BoardStatus.kt): the same
 * rules, the same words, and the same test cases (test/updatewatch.test.mjs), so that the app shell's
 * Bluetooth page (bluetooth.js) says what the classic apps say at the same point.
 *
 * Times are milliseconds since 1970. Everything here is a pure function of what it is given. Nothing in
 * this file reads the document, so the unit tests load it as it is. No dependencies but core.js.
 */

import { compareVersions, parseVersion } from './core.js';

// The board's status characteristic (firmware/app/src/bt_status.h), from firmware 1.14.0.

export const STATUS_SERVICE = '9112B1B4-2A51-40F0-94D3-A76440F0E6CC';
export const STATUS_CHARACTERISTIC = '9112B1B5-2A51-40F0-94D3-A76440F0E6CC';
export const STATUS_FORMAT = 1;
export const STATUS_LENGTH = 64;

const WINDOWS = ['closed', 'open', 'linked', 'offer', 'status'];
const IMAGES = ['none', 'receiving', 'received', 'verified', 'refused'];
const REFUSALS = [
  'none',
  'older',
  'notImage0',
  'noHeader',
  'tooLarge',
  'badSizes',
  'incompatibleBoard',
  'incompatibleLayout',
  'malformed',
  'swapPending',
  'cannotInstall',
];
const RESULTS = ['none', 'installing', 'discarded', 'timedOut', 'closed'];
const SWAPS = ['none', 'test', 'permanent', 'revert', 'fail'];
const VIAS = ['none', 'bluetooth', 'wifi'];
const OUTCOMES = [
  'none',
  'pending',
  'kept',
  'rolledBack',
  'notInstalled',
  'trialLost',
  'superseded',
  'flashError',
  'incompatibleBoard',
  'incompatibleLayout',
  'failed',
];
const PROOFS = ['none', 'cloud', 'person'];
const OUTCOME_WORDS = {
  none: 'none',
  pending: 'pending',
  kept: 'succeeded',
  rolledBack: 'rolled_back',
  notInstalled: 'not_installed',
  trialLost: 'trial_lost',
  superseded: 'superseded',
  flashError: 'flash_error',
  incompatibleBoard: 'incompatible_board',
  incompatibleLayout: 'incompatible_layout',
  failed: 'failed',
  unknown: 'unknown',
};

const named = (names, value) => names[value] ?? 'unknown';

/** Reads a payload (bytes). Null when it is short, or of a format this page does not know. */
export function parseStatus(data) {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data ?? []);
  if (b.length < STATUS_LENGTH || b[0] !== STATUS_FORMAT) return null;
  const u16 = (at) => b[at] | (b[at + 1] << 8);
  const u32 = (at) => u16(at) + u16(at + 2) * 65536;
  const version = (at) =>
    b.subarray(at, at + 8).some((byte) => byte !== 0) ? `${b[at]}.${b[at + 1]}.${u16(at + 2)}+${u32(at + 4)}` : null;
  const hash = b.subarray(48, 56);
  return {
    window: named(WINDOWS, b[1]),
    secondsLeft: u16(2),
    image: named(IMAGES, b[4]),
    refusal: named(REFUSALS, b[5]),
    imageBytes: u32(6),
    imageVersion: version(10),
    result: named(RESULTS, b[18]),
    closedReason: b[19],
    running: version(20) ?? '0.0.0+0',
    onTrial: (b[28] & 1) !== 0,
    swap: named(SWAPS, (b[28] >> 1) & 7),
    lastVia: named(VIAS, b[29]),
    lastOutcome: named(OUTCOMES, b[30]),
    lastProof: named(PROOFS, b[31]),
    lastTarget: version(32),
    lastFrom: version(40),
    lastHash: hash.some((byte) => byte !== 0)
      ? [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      : null,
    lastCount: u16(56),
    uptime: u32(58),
  };
}

/** A payload that the app sent in base64 (bridge.js, the ble.status event). */
export function statusFromBase64(text) {
  if (typeof text !== 'string' || text.length > 1024) return null;
  let binary;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  return parseStatus(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

/** The record's own word for an outcome, as the board's log line and the shadow say it. */
export const outcomeWord = (outcome) => OUTCOME_WORDS[outcome] ?? 'unknown';
/** Over, one way or the other. */
export const outcomeIsEnd = (outcome) => outcome !== 'none' && outcome !== 'pending' && outcome !== 'unknown';
export const proofWord = (proof) => (proof === 'cloud' || proof === 'person' ? proof : 'none');

/** The two say something different, beyond what counts by itself: the seconds left, the bytes and the uptime. */
export function isNews(status, other) {
  if (!other) return true;
  return [
    'window',
    'image',
    'refusal',
    'imageVersion',
    'result',
    'closedReason',
    'running',
    'onTrial',
    'swap',
    'lastVia',
    'lastOutcome',
    'lastProof',
    'lastTarget',
    'lastFrom',
    'lastHash',
    'lastCount',
  ].some((field) => status[field] !== other[field]);
}

/** Why the board refused an image, in words. */
export function refusalWords(refusal) {
  switch (refusal) {
    case 'older':
      return 'It is not newer than what the board runs.';
    case 'notImage0':
      return 'It is not for image 0.';
    case 'noHeader':
      return 'It does not start with an image header.';
    case 'tooLarge':
      return "It would reach the end of the board's slot.";
    case 'badSizes':
      return 'Its header claims more than the file holds.';
    case 'incompatibleBoard':
      return 'It is for another kind of board.';
    case 'incompatibleLayout':
      return 'It is for another flash layout.';
    case 'malformed':
      return 'Its signed metadata is malformed, or it could not be read back.';
    case 'swapPending':
      return 'The bootloader has a swap to do already.';
    case 'cannotInstall':
      return 'The board could not record it or ask for the swap.';
    default:
      return 'The board did not say why.';
  }
}

/**
 * The image's own SHA-256, which the board keeps of it: from the TLV area after the image (type 0x10),
 * not the SHA-256 of the file. Lower-case hex, or null where the header's sizes lead to no TLV area.
 */
export function imageHash(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data ?? []);
  if (bytes.length < 32) return null;
  const u16 = (at) => bytes[at] | (bytes[at + 1] << 8);
  const u32 = (at) => u16(at) + u16(at + 2) * 65536;
  let at = u16(8) + u32(12) + u16(10);
  if (at + 4 > bytes.length || u16(at) !== 0x6907) return null;
  const end = Math.min(bytes.length, at + u16(at + 2));
  at += 4;
  while (at + 4 <= end) {
    const type = u16(at);
    const length = u16(at + 2);
    at += 4;
    if (type === 0x10 && length === 32 && at + 32 <= end) {
      return [...bytes.subarray(at, at + 32)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    at += length;
  }
  return null;
}

/** The first 16 hex digits of the image's own hash: what the board's status says of its last update. */
export const imageHashPrefix = (data) => imageHash(data)?.slice(0, 16) ?? null;

// The steps after a send.

const S = 1000;
/** The board keeps an image that has arrived for this long, for a button (BT_OTA_OFFER_SECONDS). */
export const OFFER_MS = 120 * S;
/** After the link drops, the console is followed for this long at most. */
export const FOLLOW_MS = 300 * S;
/** How often the console is asked while it is followed, and the most that is backed off to on a 429. */
export const POLL_MS = 3 * S;
export const SLOWEST_POLL_MS = 30 * S;
/** While the link is up, the image list is read this often: an answer says the link is still there. */
export const LINK_READ_MS = 3 * S;
/** A drop this close to the end of the 2 minutes, or after it, is taken for that rather than for Button 1. */
export const END_SLACK_MS = 3 * S;
/** Lines and events from this long before the send count: the phone's clock and AWS's differ a little. */
export const CLOCK_SLACK_MS = 30 * S;
/** A boot this long before the send still counts as after it: the board's uptime is in whole seconds. */
const BOOT_SLACK_MS = 10 * S;
/** A flow reopened this soon after its board was last followed shows how it went. */
export const KEEP_MS = 300 * S;
/** After the board was last seen over Bluetooth on trial with the new image, it is followed this much longer. */
export const TRIAL_FOLLOW_MS = 600 * S;

export const WORDS = Object.freeze({
  sentTitle: (version) => `Sent ${version}`,
  sentDetail: 'Press Button 1 on the board within 2 minutes to install it (Button 2 throws it away).',
  buttonTitle: 'Button 1 pressed, accepted',
  linkClosed: 'The board closed the link: it is installing.',
  declinedTitle: 'Button 2 pressed: the image was thrown away',
  expiredTitle: 'The 2 minutes ran out: the image was thrown away',
  likelyExpiredTitle: 'The 2 minutes ran out',
  likelyExpiredDetail:
    'The board closed the link at the end of its 2 minutes: it has most likely thrown the image away.',
  refusedTitle: 'The board did not take the image',
  installingTitle: 'Installing and restarting',
  installingDetail: 'The board is offline on the console while it installs.',
  trialTitle: (version) => `Running ${version} on trial`,
  trialDetail: 'Back online with the new version, not yet kept.',
  keptTitle: (version) => `Kept ${version}`,
  rolledBackTitle: (old) => (old ? `Rolled back to ${old}` : 'Rolled back'),
  cannotFollow:
    "The board is not on the console, so the app can't follow it from here. After it restarts, check its version over Bluetooth.",
  gaveUpNote: "5 minutes have passed, so the app has stopped following it. The board's page shows how it ends.",
  consoleFailedNote: 'The console could not be reached just now. The app keeps asking.',
  timeUp: 'The 2 minutes are up.',
  boardSaid: 'The board said so over Bluetooth.',
  buttonFromBoard: 'The board said so over Bluetooth, and is restarting to install it.',
  installingOverBluetooth: 'The board is restarting into the bootloader, which checks the image and swaps it in.',
  trialOverBluetooth: 'The board says so over Bluetooth: not yet kept.',
  lookingNote:
    'Looking for the board over Bluetooth: for 2 minutes after its restart, a phone can read how it went with no pairing.',
  gaveUpBluetoothNote:
    'The board was not seen over Bluetooth again, so the app has stopped looking for it. Its version shows when Button 1 opens its window again.',
});

const BAD_BLUETOOTH_RESULTS = new Set(['rolled_back', 'not_installed', 'trial_lost', 'flash_error']);

/** Who kept it, from the board's record. */
export function keptDetail(proof) {
  if (proof === 'cloud') return 'It reached AWS IoT, so the board keeps it.';
  if (proof === 'person') return 'A person at the board proved it.';
  return 'The board keeps it.';
}

/** Why it went back, from the board's record; "Back on the old version." when the board only shows it. */
export function rolledBackDetail(result) {
  switch (result) {
    case 'rolled_back':
      return 'The new image was not kept: the bootloader put the old one back.';
    case 'not_installed':
      return 'The bootloader did not install the new image.';
    case 'trial_lost':
      return 'The new image lost its trial.';
    case 'flash_error':
      return 'The new image could not be written to flash.';
    case 'superseded':
      return 'A cloud update replaced it.';
    case 'incompatible_board':
      return 'The image is for another kind of board.';
    case 'incompatible_layout':
      return 'The image is for another flash layout.';
    default:
      return 'Back on the old version.';
  }
}

/** "1:42 left", then "The 2 minutes are up." */
export function countdown(secondsLeft) {
  if (!(secondsLeft > 0)) return WORDS.timeUp;
  const seconds = secondsLeft % 60;
  return `${Math.floor(secondsLeft / 60)}:${seconds < 10 ? '0' : ''}${seconds} left`;
}

/** How long to wait before asking the console again, after `throttled` answers of 429 in a row. */
export function nextPoll(throttled) {
  return Math.min(SLOWEST_POLL_MS, POLL_MS * 2 ** Math.min(Math.max(throttled, 0), 8));
}

/** The same release version: `1.13.0+0` against `1.13.0+0`, by its four numbers. */
export function same(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  return left !== null && right !== null && compareVersions(left, right) === 0;
}

const time = (iso) => {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? null : ms;
};

/**
 * The facts of a send, with what is not known yet left out: { version, from, sentAt, thing, onConsole,
 * linkDroppedAt, lines, events, device, consoleFailed, gaveUp, readings: [{ status, at, afterRestart }],
 * sentHash }. `device` is the board as core.js reads it (fw, bt, lastSeen, uptime, online).
 */
export function facts(start) {
  return {
    from: null,
    thing: null,
    onConsole: null,
    linkDroppedAt: null,
    lines: [],
    events: [],
    device: null,
    consoleFailed: false,
    gaveUp: false,
    readings: [],
    sentHash: null,
    ...start,
  };
}

/** The console can follow this board: it knows which board it is, and did not have it offline. */
export const followable = (f) => f.thing !== null && f.onConsole !== false;
/** The board has the status characteristic (firmware 1.14.0 on): it is followed over Bluetooth too. */
export const tellsOverBluetooth = (f) => f.readings.some((reading) => !reading.afterRestart);

/** A status read after the restart is this board's, about this send: its last update over Bluetooth is the version sent, and its image. */
export function isAboutThisSend(f, status) {
  if (status.lastVia !== 'bluetooth' || !same(status.lastTarget, f.version)) return false;
  if (!f.sentHash || !status.lastHash) return true;
  return f.sentHash === status.lastHash;
}

/** Until when the board is followed, once the link has gone; null while the link is up. */
export function followUntil(f) {
  if (f.linkDroppedAt === null) return null;
  let until = f.linkDroppedAt + FOLLOW_MS;
  const trial = [...f.readings]
    .reverse()
    .find(
      (reading) =>
        reading.afterRestart &&
        reading.status.onTrial &&
        same(reading.status.running, f.version) &&
        isAboutThisSend(f, reading.status)
    );
  if (trial) until = Math.max(until, trial.at + TRIAL_FOLLOW_MS);
  return until;
}

const RECORD_KINDS = [
  'restarting into the bootloader',
  'on trial',
  'last update over Bluetooth',
  'update over Bluetooth',
];

/** One of the board's records of an update: "<what>: <to> from <from>, <result>, proof <who>, update N of this board". */
export function parseRecord(text) {
  const what = RECORD_KINDS.find((kind) => text.startsWith(`${kind}: `));
  if (!what) return null;
  const parts = text.slice(what.length + 2).split(', ');
  if (parts.length < 3 || !parts[2].startsWith('proof ')) return null;
  const versions = parts[0].split(' from ');
  if (versions.length !== 2) return null;
  return { what, to: versions[0], from: versions[1], result: parts[1], proof: parts[2].slice(6) };
}

const row = (step, state, title, detail = null, at = null) => ({ step, state, title, detail, at });

/** The steps, from everything seen since the send. */
export function timeline(f) {
  const since = f.sentAt - CLOCK_SLACK_MS;
  const { version } = f;

  // The board's own word, over Bluetooth: on the link of the send, then after the restart.
  const onLink = f.readings.filter((reading) => !reading.afterRestart);
  const windowEnd =
    onLink.find((reading) => reading.status.result !== 'none' && reading.status.result !== 'unknown') ?? null;
  const installing = windowEnd?.status.result === 'installing' ? windowEnd : null;
  const afterRestart = f.readings.filter((reading) => reading.afterRestart && isAboutThisSend(f, reading.status));
  const boardTrial =
    afterRestart.find((reading) => reading.status.onTrial && same(reading.status.running, version)) ?? null;
  const boardEnd = afterRestart.find((reading) => outcomeIsEnd(reading.status.lastOutcome)) ?? null;
  // The board counts its 2 minutes down itself.
  const offer = [...onLink].reverse().find((reading) => reading.status.window === 'offer') ?? null;
  const deadline = offer ? offer.at + offer.status.secondsLeft * S : f.sentAt + OFFER_MS;

  const lines = f.lines
    .filter((line) => (line.tag === 'BT' || line.tag === 'bt_ota') && (time(line.at) ?? -Infinity) >= since)
    .sort((a, b) => {
      const x = time(a.at) ?? -Infinity;
      const y = time(b.at) ?? -Infinity;
      if (x !== y) return x - y;
      return (a.boot ?? 0) - (b.boot ?? 0) || (a.seq ?? 0) - (b.seq ?? 0);
    });
  const first = (what) => {
    for (const line of lines) {
      const said = parseRecord(line.text);
      if (said && said.what === what && same(said.to, version)) return { said, at: time(line.at) };
    }
    return null;
  };
  const firstLine = (test) => lines.find((line) => test(line.text)) ?? null;

  const restarting = first('restarting into the bootloader');
  const onTrial = first('on trial');
  const finished = first('update over Bluetooth') ?? first('last update over Bluetooth');
  const button2 = firstLine((text) => text.startsWith('closed: by Button 2'));
  const refused = firstLine(
    (text) =>
      text.startsWith('refused the image') ||
      text.startsWith('what arrived cannot be installed') ||
      text.startsWith('the image could not be installed')
  );
  const noImage = firstLine((text) => text.startsWith('closed: no image to install'));

  const connections = f.events
    .filter((event) => event.kind === 'connection' && (time(event.at) ?? -Infinity) >= since)
    .map((event) => ({ what: event.what, at: time(event.at) }))
    .filter((event) => event.at !== null)
    .sort((a, b) => a.at - b.at);
  const offlineAt = connections.find((event) => event.what === 'disconnected')?.at ?? null;
  const backAt = connections.find((event) => event.what === 'connected' && event.at > (offlineAt ?? since))?.at ?? null;

  // The board as the console last read it: a boot after the send, and what that boot runs.
  const { device } = f;
  let bootAt = null;
  const seen = time(device?.lastSeen);
  if (seen !== null && Number.isFinite(device?.uptime)) {
    const boot = seen - device.uptime * S;
    if (boot >= f.sentAt - BOOT_SLACK_MS) bootAt = boot;
  }
  const runs = bootAt === null ? null : (device?.fw ?? null);
  const record = device?.bt && same(device.bt.to, version) ? device.bt : null;

  // How it ended, the board's own word first: over Bluetooth, then in its log.
  let outcome = null;
  let endAt = null;
  let proof = null;
  let reason = null;
  let old = null;
  let refusal = null;
  let fromBoard = false;
  const endedOnLink =
    windowEnd !== null &&
    (['discarded', 'timedOut'].includes(windowEnd.status.result) || windowEnd.status.image === 'refused');
  if (boardEnd) {
    const said = boardEnd.status;
    if (said.lastOutcome === 'kept') {
      outcome = 'kept';
      proof = proofWord(said.lastProof);
    } else {
      outcome = 'rolled_back';
      reason = outcomeWord(said.lastOutcome);
      old = same(said.running, version) ? said.lastFrom : said.running;
    }
    endAt = boardEnd.at;
  } else if (endedOnLink) {
    if (windowEnd.status.result === 'discarded') outcome = 'declined';
    else if (windowEnd.status.result === 'timedOut') outcome = 'expired';
    else {
      outcome = 'refused';
      refusal = refusalWords(windowEnd.status.refusal);
    }
    endAt = windowEnd.at;
    fromBoard = true;
  } else if (finished && finished.said.result !== 'pending') {
    if (finished.said.result === 'succeeded') {
      outcome = 'kept';
      proof = finished.said.proof;
    } else {
      outcome = 'rolled_back';
      reason = finished.said.result;
      old = finished.said.from;
    }
    endAt = finished.at;
  } else if (button2) {
    outcome = 'declined';
    endAt = time(button2.at);
  } else if (refused) {
    outcome = 'refused';
    endAt = time(refused.at);
    refusal = refused.text;
  } else if (noImage) {
    outcome = 'expired';
    endAt = time(noImage.at);
  } else if (runs && same(runs.version, version) && runs.confirmed) {
    outcome = 'kept';
    endAt = backAt ?? bootAt;
    proof = record?.proof ?? null;
  } else if (runs && !same(runs.version, version)) {
    outcome = 'rolled_back';
    endAt = backAt ?? bootAt;
    old = runs.version;
    reason = record && BAD_BLUETOOTH_RESULTS.has(record.result) ? record.result : null;
  }

  const dropped = f.linkDroppedAt;
  const ranOnTrial =
    onTrial !== null || boardTrial !== null || (runs ? same(runs.version, version) : false) || outcome === 'kept';
  const acceptedSure =
    installing !== null ||
    afterRestart.length > 0 ||
    restarting !== null ||
    ranOnTrial ||
    outcome === 'rolled_back' ||
    (dropped !== null && offlineAt !== null);
  const acceptedAt = installing?.at ?? restarting?.at ?? offlineAt ?? dropped;
  const likelyAccepted = !acceptedSure && outcome === null && dropped !== null && dropped < deadline - END_SLACK_MS;
  const likelyExpired = !acceptedSure && outcome === null && dropped !== null && dropped >= deadline - END_SLACK_MS;

  const rows = [row('sent', 'done', WORDS.sentTitle(version), WORDS.sentDetail, f.sentAt)];
  let tentative = false;
  let stopped = false;

  if (outcome === 'declined') {
    rows.push(row('button', 'failed', WORDS.declinedTitle, fromBoard ? WORDS.boardSaid : null, endAt));
    stopped = true;
  } else if (outcome === 'expired') {
    rows.push(row('button', 'failed', WORDS.expiredTitle, fromBoard ? WORDS.boardSaid : null, endAt));
    stopped = true;
  } else if (outcome === 'refused') {
    rows.push(row('button', 'failed', WORDS.refusedTitle, refusal, endAt));
    stopped = true;
  } else if (likelyExpired) {
    rows.push(row('button', 'likely', WORDS.likelyExpiredTitle, WORDS.likelyExpiredDetail, dropped));
    outcome = 'expired';
    tentative = true;
    stopped = true;
  } else if (installing) {
    rows.push(row('button', 'done', WORDS.buttonTitle, WORDS.buttonFromBoard, installing.at));
  } else if (acceptedSure) {
    rows.push(row('button', 'done', WORDS.buttonTitle, null, acceptedAt));
  } else if (likelyAccepted) {
    rows.push(row('button', 'likely', WORDS.buttonTitle, WORDS.linkClosed, dropped));
  } else {
    rows.push(row('button', 'current', WORDS.buttonTitle));
  }

  if (!stopped) {
    const offline = offlineAt !== null || (dropped !== null && device?.online === false) || installing !== null;
    const pastInstall = backAt !== null || ranOnTrial || outcome !== null || afterRestart.length > 0;
    const installedAt = offlineAt ?? installing?.at ?? null;
    if (pastInstall) {
      rows.push(row('installing', 'done', WORDS.installingTitle, null, installedAt));
    } else if (offline) {
      const detail = offlineAt === null && installing !== null ? WORDS.installingOverBluetooth : WORDS.installingDetail;
      rows.push(row('installing', 'current', WORDS.installingTitle, detail, installedAt));
    } else {
      rows.push(row('installing', 'waiting', WORDS.installingTitle));
    }

    const trialAt = onTrial?.at ?? boardTrial?.at ?? backAt ?? bootAt;
    const trialDone = onTrial !== null || boardTrial !== null;
    if (outcome === 'kept') {
      rows.push(row('trial', 'done', WORDS.trialTitle(version), null, trialAt));
    } else if (outcome === 'rolled_back') {
      rows.push(
        row(
          'trial',
          trialDone ? 'done' : 'waiting',
          WORDS.trialTitle(version),
          null,
          onTrial?.at ?? boardTrial?.at ?? null
        )
      );
    } else {
      const detail = onTrial === null && boardTrial !== null ? WORDS.trialOverBluetooth : WORDS.trialDetail;
      rows.push(
        ranOnTrial
          ? row('trial', 'current', WORDS.trialTitle(version), detail, trialAt)
          : row('trial', 'waiting', WORDS.trialTitle(version))
      );
    }

    if (outcome === 'kept') rows.push(row('end', 'done', WORDS.keptTitle(version), keptDetail(proof), endAt));
    else if (outcome === 'rolled_back')
      rows.push(row('end', 'failed', WORDS.rolledBackTitle(old ?? f.from), rolledBackDetail(reason), endAt));
    else rows.push(row('end', 'waiting', WORDS.keptTitle(version)));
  }

  // Once the link is gone, what the console can still tell.
  let note = null;
  let done = outcome !== null && !tentative;
  if (outcome === null || tentative) {
    if (dropped !== null && !followable(f) && !tellsOverBluetooth(f)) {
      note = WORDS.cannotFollow;
      done = true;
    } else if (f.gaveUp) {
      note = followable(f) ? WORDS.gaveUpNote : WORDS.gaveUpBluetoothNote;
      done = true;
    } else if (f.consoleFailed) {
      note = WORDS.consoleFailedNote;
    } else if (dropped !== null && !followable(f) && afterRestart.length === 0) {
      note = WORDS.lookingNote;
    }
  }

  return {
    rows,
    outcome,
    tentative,
    deadline,
    waitingForButton: dropped === null && !acceptedSure && outcome === null,
    note,
    finished: done,
    rolledBackTo: outcome === 'rolled_back' ? (old ?? f.from) : null,
    acceptedAt: acceptedSure || likelyAccepted ? acceptedAt : null,
  };
}

/** What a board's page keeps of a followed update; null for a board the console does not know. */
export function followedRecord(f, line) {
  if (f.thing === null) return null;
  return {
    thing: f.thing,
    version: f.version,
    at: line.acceptedAt ?? f.sentAt,
    outcome: line.outcome,
    tentative: line.tentative,
    rolledBackTo: line.rolledBackTo,
  };
}

function outcomeWords(outcome, rolledBackTo) {
  switch (outcome) {
    case 'kept':
      return 'kept';
    case 'rolled_back':
      return rolledBackTo ? `rolled back to ${rolledBackTo}` : 'rolled back';
    case 'declined':
      return 'thrown away with Button 2';
    case 'expired':
      return 'not installed: the 2 minutes ran out';
    case 'refused':
      return 'not taken by the board';
    default:
      return 'not followed to the end';
  }
}

function recordWords(bt) {
  if (bt.result === 'succeeded') return 'kept';
  if (bt.result === 'pending') return 'on trial';
  if (bt.result === 'superseded') return 'replaced by a cloud update';
  return BAD_BLUETOOTH_RESULTS.has(bt.result) ? `rolled back to ${bt.from}` : null;
}

/**
 * "1.13.0+0 over Bluetooth at 12:14, kept": what this phone followed, else the board's own record
 * (without a time, which it does not keep). Null when there is neither.
 */
export function summary(record, bt, timeOf) {
  if (record) {
    const head = `${record.version} over Bluetooth at ${timeOf(record.at)}`;
    if (bt && same(bt.to, record.version) && (record.outcome === null || record.tentative)) {
      const words = recordWords(bt);
      if (words) return `${head}, ${words}`;
    }
    return `${head}, ${outcomeWords(record.outcome, record.rolledBackTo)}`;
  }
  if (!bt) return null;
  const words = recordWords(bt);
  return words ? `${bt.to} over Bluetooth, ${words}` : null;
}
