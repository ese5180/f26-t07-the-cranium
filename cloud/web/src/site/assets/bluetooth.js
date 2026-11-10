/**
 * Updating a board over Bluetooth, in the phone, Mac and desktop apps (docs/mobile-apps.md, "What a person does"): the
 * console's own page for what the classic apps' Bluetooth screens do, shown only where the app's bridge
 * offers Bluetooth (bridge.js). The rules are the contract's, as the classic apps have them:
 *
 *   - only active releases newer than what the board runs (its slot 0) are offered, newest first;
 *   - the passkey comes from the console while the board pairs, every 3 s for 90 s at most, and is
 *     shown pinned at the top of the page and put on the clipboard of this device, for 2 minutes;
 *   - the image is checked before it goes (its size and SHA-256 against the release, MCUboot's magic,
 *     the version in its header), and right before every send the console is asked whether the release
 *     is still active and the image still its own (POST /api/firmware/{version}/bluetooth). Without a
 *     yes nothing is sent: not after a refusal, and not when the console cannot be reached;
 *   - after the upload the board is followed with UpdateWatch (updatewatch.js): its status over
 *     Bluetooth on the link of the send and after its restart, the link itself, and the console.
 *
 * The flow (createBluetoothFlow) is given the API, the bridge, a clock and timers, so that the tests
 * drive it with stand-ins. bluetoothView draws it.
 */

import {
  ApiError,
  compareVersions,
  deviceHref,
  fileSize,
  formatVersion,
  isRefusal,
  parseVersion,
  plainMessage,
  readImageHeader,
  sentence,
  sha256Hex,
  signalQuality,
  timeOfDay,
  toBase64,
} from './core.js';
import { button, h, icon, linkTo, mono, notice, pageHead, signalBars, stepList } from './views.js';
import * as watch from './updatewatch.js';

export const PASSKEY_EVERY_MS = 3000;
export const PASSKEY_FOR_MS = 90000;
// The board drops an authenticated link with nothing on it for 120 s: read the image list well before.
export const KEEPALIVE_MS = 15000;
// The passkey on the clipboard, for this device and this long (the pairing box hides the page).
export const PASSKEY_ON_CLIPBOARD_S = 120;
const NO_PASSKEY_AFTER_MS = 8000;
const BOARD_NAME = /^Cranium-[0-9A-F]{4}$/;

/** The version a board's image list gives, `1.8.0` or `1.8.0.5` (or `1.8.0+5`), in a release's form. */
export function boardVersion(text) {
  if (typeof text !== 'string') return null;
  if (text.includes('+')) return parseVersion(text) ? text : null;
  const parts = text.split('.');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const release = `${parts[0]}.${parts[1]}.${parts[2]}+${parts[3] ?? '0'}`;
  const parsed = parseVersion(release);
  return parsed ? formatVersion(parsed) : null;
}

/** The releases that may be sent to a board that runs `running` (null: not known yet), newest first. */
export function offerable(releases, running) {
  const floor = running ? parseVersion(running) : null;
  return (releases ?? [])
    .filter((release) => release.status === 'active' && parseVersion(release.version) !== null)
    .filter((release) => floor === null || compareVersions(parseVersion(release.version), floor) > 0)
    .sort((a, b) => compareVersions(parseVersion(b.version), parseVersion(a.version)));
}

/**
 * A downloaded image against its release, in the contract's order: size, SHA-256, MCUboot's magic, the
 * version in its header, and that the header's sizes fit in the file. A problem in words, or null.
 */
export async function imageProblem(bytes, release, subtle = globalThis.crypto.subtle) {
  if (bytes.length !== release.size)
    return `The image is ${fileSize(bytes.length)}, not the ${fileSize(release.size)} the console lists.`;
  if ((await sha256Hex(bytes, subtle)) !== release.sha256)
    return 'The image is not the one the console lists: its SHA-256 differs.';
  const header = readImageHeader(bytes);
  if (!header.ok) return 'The download is not an MCUboot image.';
  if (header.version !== release.version) return `The image's header says ${header.version}, not ${release.version}.`;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.headerSize + view.getUint16(10, true) + header.payloadSize > bytes.length)
    return "The image's header claims more than the file holds.";
  return null;
}

function bridgeWords(error, fallback) {
  return typeof error?.message === 'string' && error.message !== '' ? error.message : fallback;
}

// What the radio's state means, in the words of the device the app runs on ("phone", "Mac", "computer").
const radioWords = (device) => ({
  off: 'Bluetooth is off. Switch it on, then look again.',
  unauthorized: `The app may not use Bluetooth. Allow it for Cranium in the settings of this ${device}, then look again.`,
  unsupported: `This ${device} has no Bluetooth LE.`,
  unknown: 'Bluetooth is not ready yet. Look again in a moment.',
});

/** The latest few seconds of progress count for the speed. */
export const SPEED_WINDOW_MS = 8000;
/** Less progress than this says nothing about a speed. */
export const SPEED_MIN_MS = 1500;

/**
 * The speed of an upload and the time it still needs, from the progress the app reported
 * (`samples`: [{at, sent}] oldest first). Both are estimates, null until there is enough to go on or
 * while nothing moves; the time left is the bytes to go over the recent speed.
 */
export function transferStats(samples, total) {
  const last = samples?.at(-1);
  if (!last || !(total > 0)) return { speed: null, secondsLeft: null };
  const from = samples.find((sample) => last.at - sample.at <= SPEED_WINDOW_MS) ?? last;
  const span = last.at - from.at;
  if (span < SPEED_MIN_MS || last.sent <= from.sent) return { speed: null, secondsLeft: null };
  const speed = ((last.sent - from.sent) * 1000) / span;
  return { speed, secondsLeft: Math.max(0, Math.ceil((total - last.sent) / speed)) };
}

/** "about 1 min 20 s", "about 45 s", "under 5 s": a time left that is an estimate says so. */
export function timeLeftWords(seconds) {
  if (!Number.isFinite(seconds)) return null;
  if (seconds < 5) return 'under 5 s';
  const total = Math.round(seconds / 5) * 5;
  if (total < 60) return `about ${total} s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `about ${minutes} min` : `about ${minutes} min ${rest} s`;
}

/**
 * The flow of one update over Bluetooth. `devices()` is the console's list of boards, for whether the
 * board was online when it was sent; `onChange` is called whenever there is something new to draw.
 */
export function createBluetoothFlow({
  api,
  bridge,
  now = () => Date.now(),
  timers = globalThis,
  onChange = () => {},
  devices = () => [],
  subtle = globalThis.crypto?.subtle,
  device = 'phone',
}) {
  const RADIO_WORDS = radioWords(device);
  const flow = {
    step: 'release',
    releases: [],
    release: null,
    boards: [],
    board: null,
    passkey: null,
    passkeyMissing: false,
    running: null,
    image: null,
    progress: null,
    samples: [],
    problem: null,
    busy: false,
    facts: null,
    line: null,
  };
  let generation = 0;
  // The facts of a send while its upload goes: the board's status during it counts too.
  let collecting = null;
  const pending = new Set();
  const changed = () => onChange(flow);

  function later(ms, run) {
    const mine = generation;
    const id = timers.setTimeout(() => {
      pending.delete(id);
      if (mine === generation) run();
    }, ms);
    pending.add(id);
    return id;
  }

  function stopTimers() {
    for (const id of pending) timers.clearTimeout(id);
    pending.clear();
  }

  function quietly(method, params = {}) {
    return bridge.call(method, params).catch(() => null);
  }

  // What the app says, as it says it.
  const off = [
    bridge.on('ble.boards', ({ boards }) => {
      if (flow.step !== 'boards') return;
      flow.boards = (Array.isArray(boards) ? boards : [])
        .filter((board) => typeof board?.id === 'string' && BOARD_NAME.test(board?.name ?? ''))
        .map((board) => ({ id: board.id, name: board.name, rssi: Number.isFinite(board.rssi) ? board.rssi : null }));
      changed();
    }),
    bridge.on('ble.progress', ({ sent, total }) => {
      if (flow.step !== 'sending' || !(total > 0)) return;
      flow.progress = { sent: Math.max(0, Math.min(sent, total)), total };
      flow.samples.push({ at: now(), sent: flow.progress.sent });
      if (flow.samples.length > 40) flow.samples.splice(0, flow.samples.length - 40);
      changed();
    }),
    bridge.on('ble.status', ({ payload, afterRestart }) => {
      const f = flow.facts ?? collecting;
      if (!f) return;
      const status = watch.statusFromBase64(payload);
      if (!status) return;
      const after = afterRestart === true;
      const last = [...f.readings].reverse().find((reading) => reading.afterRestart === after);
      // A read that says nothing new is kept only for an offer's seconds left: the newest is the countdown's.
      if (last && !watch.isNews(status, last.status) && (after || status.window !== 'offer')) return;
      f.readings.push({ status, at: now(), afterRestart: after });
      if (flow.facts) settle();
    }),
    bridge.on('ble.link', ({ state }) => {
      if (state !== 'disconnected') return;
      if (flow.facts && flow.facts.linkDroppedAt === null) {
        flow.facts.linkDroppedAt = now();
        quietly('ble.watch', {
          on: true,
          version: flow.facts.version,
          ...(flow.facts.sentHash ? { hash: flow.facts.sentHash } : {}),
        });
        if (watch.followable(flow.facts)) askConsole(0);
        settle();
      } else if (['pairing', 'ready', 'downloading', 'clearing'].includes(flow.step)) {
        fail('The board closed the link. Open its window again (hold Button 1 for 5 s) and look again.');
      }
    }),
  ];

  function fail(problem) {
    stopTimers();
    flow.busy = false;
    flow.problem = problem;
    flow.step = flow.facts ? 'following' : 'failed';
    quietly('app.keepAwake', { on: false });
    changed();
  }

  /** The releases, from the console's list. The newest one that may be sent is chosen, unless one was. */
  function setReleases(releases) {
    flow.releases = offerable(releases, null);
    if (!flow.releases.some((release) => release.version === flow.release))
      flow.release = flow.releases[0]?.version ?? null;
    changed();
  }

  function chooseRelease(version) {
    if (!offerable(flow.releases, flow.running).some((release) => release.version === version)) return;
    flow.release = version;
    flow.problem = null;
    changed();
  }

  async function lookForBoards() {
    flow.problem = null;
    const radio = await bridge.call('ble.state').catch(() => ({ state: 'unknown' }));
    if (radio.state !== 'on') {
      flow.problem = RADIO_WORDS[radio.state] ?? RADIO_WORDS.unknown;
      changed();
      return;
    }
    flow.step = 'boards';
    flow.boards = [];
    changed();
    try {
      await bridge.call('ble.scan', { on: true });
    } catch (error) {
      fail(bridgeWords(error, `This ${device} could not look for boards.`));
    }
  }

  // The passkey, while the board pairs: the console has it about a second after each attempt starts.
  function pollPasskey(name, since) {
    later(PASSKEY_EVERY_MS, async () => {
      if (flow.step !== 'pairing') return;
      try {
        const answer = await api.pairing(name);
        if (answer && answer.passkey !== flow.passkey?.passkey) {
          flow.passkey = answer;
          flow.passkeyMissing = false;
          quietly('clipboard.write', { text: answer.passkey, expiresIn: PASSKEY_ON_CLIPBOARD_S });
          quietly('haptics.play', { kind: 'selection' });
        }
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) flow.passkeyMissing = flow.passkey === null;
      }
      if (flow.passkey === null && now() - since > NO_PASSKEY_AFTER_MS) flow.passkeyMissing = true;
      changed();
      if (now() - since < PASSKEY_FOR_MS) pollPasskey(name, since);
    });
  }

  function keepAlive() {
    later(KEEPALIVE_MS, async () => {
      if (!['ready', 'downloading', 'clearing'].includes(flow.step)) return;
      await quietly('ble.images');
      keepAlive();
    });
  }

  async function connect(board) {
    if (flow.step !== 'boards' || flow.busy) return;
    quietly('ble.scan', { on: false });
    generation += 1;
    stopTimers();
    Object.assign(flow, {
      step: 'pairing',
      board: { id: board.id, name: board.name },
      passkey: null,
      passkeyMissing: false,
      running: null,
      problem: null,
      busy: true,
    });
    changed();
    quietly('app.keepAwake', { on: true });
    // The passkey from the moment the app connects: the iPhone app's ble.connect returns only once the
    // board has paired, the Android app's at once, with the pairing still to come.
    pollPasskey(board.name, now());
    try {
      await bridge.call('ble.connect', { id: board.id });
    } catch (error) {
      fail(bridgeWords(error, `This ${device} could not connect to the board.`));
      return;
    }
    let images;
    try {
      // The phone asks for the passkey here, at the first command.
      images = await bridge.call('ble.images');
    } catch (error) {
      fail(bridgeWords(error, 'The board did not pair. Open its window again, and type the new passkey.'));
      return;
    }
    const running = (Array.isArray(images.images) ? images.images : []).find((image) => image?.slot === 0);
    flow.running = boardVersion(running?.version);
    flow.step = 'ready';
    flow.busy = false;
    stopTimers();
    keepAlive();
    const choices = offerable(flow.releases, flow.running);
    if (!choices.some((release) => release.version === flow.release)) flow.release = choices[0]?.version ?? null;
    if (choices.length === 0) {
      flow.problem = `The board runs ${flow.running ?? 'a version this page cannot read'}: no active release is newer.`;
    }
    changed();
  }

  /** Download, check, ask the console, send. Nothing goes to the board without the console's yes. */
  async function send() {
    if (flow.step !== 'ready' || flow.busy) return;
    const release = offerable(flow.releases, flow.running).find((item) => item.version === flow.release);
    if (!release) return;
    flow.busy = true;
    flow.problem = null;
    flow.step = 'downloading';
    changed();
    let bytes;
    try {
      bytes = await api.image(release.version);
      if (flow.step !== 'downloading') return;
    } catch (error) {
      if (flow.step !== 'downloading') return;
      flow.step = 'ready';
      flow.busy = false;
      flow.problem = `The image could not be downloaded, so nothing was sent. ${sentence(plainMessage(error))}`;
      changed();
      return;
    }
    const problem = await imageProblem(bytes, release, subtle);
    if (problem) {
      flow.step = 'ready';
      flow.busy = false;
      flow.problem = `${problem} Nothing was sent.`;
      changed();
      return;
    }
    flow.image = { size: bytes.length, sha256: release.sha256, hash: watch.imageHashPrefix(bytes) };
    flow.step = 'clearing';
    changed();
    let cleared;
    try {
      cleared = await api.clearSend(release.version, { sha256: release.sha256, board: flow.board.name });
      if (flow.step !== 'clearing') return;
    } catch (error) {
      if (flow.step !== 'clearing') return;
      flow.step = 'ready';
      flow.busy = false;
      flow.problem = isRefusal(error)
        ? `The console did not clear the send, so nothing was sent: ${sentence(plainMessage(error))}`
        : 'The console could not be reached, so nothing was sent: an image is only sent once the console says the release is still active.';
      changed();
      return;
    }
    if (cleared.version !== release.version || cleared.sha256 !== release.sha256 || cleared.status !== 'active') {
      flow.step = 'ready';
      flow.busy = false;
      flow.problem = "The console's answer was not a yes for this image, so nothing was sent.";
      changed();
      return;
    }

    // The board's own status on this link, from firmware 1.14.0: it is followed from the first piece.
    const thing = flow.passkey?.thing ?? null;
    const board = thing ? devices().find((device) => device.thing === thing) : null;
    flow.facts = null;
    const start = watch.facts({
      version: release.version,
      from: flow.running,
      sentAt: now(),
      thing,
      onConsole: board ? board.online === true : null,
      sentHash: flow.image.hash,
    });
    collecting = start;
    const told = await bridge.call('ble.status').catch(() => ({ supported: false }));
    const first = told?.supported === true ? watch.statusFromBase64(told.payload) : null;
    if (first) start.readings.unshift({ status: first, at: now(), afterRestart: false });
    flow.step = 'sending';
    flow.progress = { sent: 0, total: bytes.length };
    flow.samples = [{ at: now(), sent: 0 }];
    changed();
    try {
      await bridge.call('ble.upload', { image: toBase64(bytes), sha256: release.sha256 });
    } catch (error) {
      // Cancelled by the person: the page already says so.
      if (flow.step !== 'sending') return;
      collecting = null;
      flow.step = 'failed';
      flow.busy = false;
      flow.problem = `${bridgeWords(error, 'The upload did not finish.')} Open a new window and send it again: it starts over.`;
      quietly('app.keepAwake', { on: false });
      changed();
      return;
    }
    if (flow.step !== 'sending') return;
    quietly('haptics.play', { kind: 'success' });
    start.sentAt = now();
    collecting = null;
    flow.facts = start;
    flow.step = 'following';
    flow.busy = false;
    readLink();
    tick();
  }

  // While the link of the send is up: the image list every 3 s, which the board allows while it waits.
  function readLink() {
    later(watch.LINK_READ_MS, async () => {
      if (!flow.facts || flow.facts.linkDroppedAt !== null || flow.line?.finished) return;
      await quietly('ble.images');
      readLink();
    });
  }

  let throttled = 0;

  // Once the link has gone: the board's log, its connections and its report, from the console.
  function askConsole(wait) {
    later(wait, async () => {
      const f = flow.facts;
      if (!f || flow.line?.finished || f.thing === null) return;
      const from = new Date(f.sentAt - watch.CLOCK_SLACK_MS).toISOString();
      const to = new Date(now() + 60000).toISOString();
      try {
        const [log, events, detail] = await Promise.all([
          api.boardLog({ from, to, thing: f.thing, tags: ['BT', 'bt_ota'] }),
          api.events({ from, to, thing: f.thing, kinds: ['connection'] }),
          api.device(f.thing),
        ]);
        f.lines = log.lines;
        f.events = events.events;
        f.device = detail.device;
        f.consoleFailed = false;
        throttled = 0;
      } catch (error) {
        if (error?.status === 429) throttled += 1;
        else f.consoleFailed = true;
      }
      settle();
      if (!flow.line?.finished) askConsole(watch.nextPoll(throttled));
    });
  }

  // Every second while it is followed: the countdown, and the end of following.
  function tick() {
    settle();
    if (flow.facts && !flow.line?.finished) later(1000, tick);
  }

  function settle() {
    const f = flow.facts;
    if (!f) return;
    const until = watch.followUntil(f);
    if (until !== null && now() > until && !f.gaveUp) f.gaveUp = true;
    flow.line = watch.timeline(f);
    if (flow.line.finished) finish();
    changed();
  }

  function finish() {
    stopTimers();
    quietly('ble.watch', { on: false });
    quietly('ble.disconnect');
    quietly('app.keepAwake', { on: false });
    if (flow.line?.outcome === 'kept') quietly('haptics.play', { kind: 'success' });
    else if (flow.line?.outcome) quietly('haptics.play', { kind: 'warning' });
  }

  /**
   * Stops a send that is under way (ble.cancel) and says so, rather than going back to the start: the
   * board keeps what it runs, and a new send starts over. Before the first piece goes it is a reset.
   */
  function cancel() {
    if (flow.step !== 'sending') return reset();
    generation += 1;
    collecting = null;
    stopTimers();
    flow.step = 'cancelled';
    flow.busy = false;
    flow.problem = null;
    quietly('ble.cancel');
    quietly('ble.disconnect');
    quietly('app.keepAwake', { on: false });
    changed();
  }

  /** Back to the start, letting go of the board. */
  function reset() {
    generation += 1;
    collecting = null;
    stopTimers();
    if (flow.facts && !flow.line?.finished) quietly('ble.watch', { on: false });
    quietly('ble.scan', { on: false });
    quietly('ble.cancel');
    quietly('ble.disconnect');
    quietly('app.keepAwake', { on: false });
    Object.assign(flow, {
      step: 'release',
      boards: [],
      board: null,
      passkey: null,
      passkeyMissing: false,
      running: null,
      image: null,
      progress: null,
      samples: [],
      problem: null,
      busy: false,
      facts: null,
      line: null,
    });
    changed();
  }

  return {
    flow,
    setReleases,
    chooseRelease,
    lookForBoards,
    connect,
    send,
    cancel,
    reset,
    copyPasskey: () =>
      flow.passkey
        ? quietly('clipboard.write', { text: flow.passkey.passkey, expiresIn: PASSKEY_ON_CLIPBOARD_S })
        : null,
    dispose() {
      reset();
      for (const stop of off) stop();
    },
  };
}

// Drawing.

// The steps of one update, in the order they happen, with what each is drawn with until it is done. The
// first three are the app's own (Bluetooth link, the checks, the upload); the last four are the ones
// UpdateWatch reports about the board (updatewatch.js timeline): its button, its install, its trial, its keeping.
const STEPS = [
  { key: 'connect', label: 'Connect', mark: 'bluetooth' },
  { key: 'check', label: 'Check', mark: 'shield' },
  { key: 'send', label: 'Send', mark: 'send' },
  { key: 'button', label: 'Button 1', mark: 'press' },
  { key: 'installing', label: 'Install', mark: 'restart' },
  { key: 'trial', label: 'On trial', mark: 'pulse' },
  { key: 'end', label: 'Kept', mark: 'check-circle' },
];
const SEND_AT = 2;
const MARKS = STEPS.map((step) => step.mark);
const LINE_STATES = { done: 'done', current: 'current', waiting: 'upcoming', likely: 'done', failed: 'failed' };

/** A release's notes in one line of at most `limit` characters. */
export function notesSnippet(notes, limit = 140) {
  const text = typeof notes === 'string' ? notes.replace(/\s+/g, ' ').trim() : '';
  if (text === '') return null;
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/** The percentage of an upload, rounded down: 100 only when every byte went. */
export function percentSent(progress) {
  if (!progress || !(progress.total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.floor((progress.sent / progress.total) * 100)));
}

/**
 * What the page says about the update that is under way, from the flow alone: the tone, the headline and
 * its words, the seven steps, and the figures of the upload. Only what the app reports is claimed: the
 * link, the checks, the pieces sent, and from the board its own status and the console's record of it.
 * `device` is "phone", "Mac", "computer" or "device"; `now` is the clock, for the countdown at the board.
 */
export function describeRun(flow, { device = 'device', now = Date.now() } = {}) {
  const version = flow.facts?.version ?? flow.release;
  const board = flow.board?.name ?? 'the board';
  const thing = flow.facts?.thing ?? flow.passkey?.thing ?? null;
  const percent = percentSent(flow.progress);
  const steps = STEPS.map((step) => ({ label: step.label, state: 'upcoming' }));
  const mark = (index, state, word) => {
    steps[index] = { ...steps[index], state, ...(word ? { word } : {}) };
  };
  const out = {
    tone: 'live',
    icon: 'bluetooth',
    title: '',
    text: '',
    next: null,
    steps,
    progress: null,
    busy: false,
    phase: flow.step,
    outcome: null,
    thing,
    version,
    percent,
    announce: '',
  };

  switch (flow.step) {
    case 'pairing':
      mark(0, 'current');
      Object.assign(out, {
        busy: true,
        title: `Pairing with ${board}`,
        text: `Type the 6-digit passkey into the pairing box of this ${device}.`,
        announce: `Pairing with ${board}.`,
      });
      return out;
    case 'ready':
      mark(0, 'done', 'paired');
      Object.assign(out, {
        icon: 'check-circle',
        title: `Paired with ${board}`,
        text: 'Choose the release to send, then press Send.',
        announce: `Paired with ${board}. Choose a release.`,
      });
      return out;
    case 'downloading':
    case 'clearing':
      mark(0, 'done', 'paired');
      mark(1, 'current', flow.step === 'downloading' ? 'downloading' : 'asking the console');
      Object.assign(out, {
        icon: 'shield',
        busy: true,
        title: flow.step === 'downloading' ? `Downloading ${version}` : 'Asking the console',
        text:
          flow.step === 'downloading'
            ? 'The image is checked against the release before anything is sent.'
            : 'Nothing is sent without the console’s yes that this release is still active.',
        announce: flow.step === 'downloading' ? `Downloading ${version}.` : 'Asking the console.',
      });
      return out;
    case 'sending': {
      mark(0, 'done', 'paired');
      mark(1, 'done', 'checked');
      mark(SEND_AT, 'current');
      // Announced every tenth only: a screen reader would otherwise read out every piece.
      const tenth = Math.floor(percent / 10) * 10;
      Object.assign(out, {
        icon: 'send',
        title: `Sending ${version} to ${board}`,
        text: `Keep this ${device} near the board until it has all been sent.`,
        progress: percent,
        announce: `Sending ${version} to ${board}: ${tenth}% sent.`,
      });
      return out;
    }
    case 'cancelled':
      mark(0, 'done');
      mark(1, 'done');
      mark(SEND_AT, 'stopped', 'cancelled');
      for (let index = SEND_AT + 1; index < steps.length; index += 1) mark(index, 'skipped');
      Object.assign(out, {
        tone: 'wait',
        icon: 'ban',
        title: 'Cancelled',
        text: `The send was stopped. ${board} keeps running ${flow.running ?? 'what it ran'}; sending again starts over.`,
        outcome: 'cancelled',
        announce: 'The send was cancelled.',
      });
      return out;
    case 'failed': {
      const at = flow.progress ? SEND_AT : flow.running !== null ? 1 : 0;
      for (let index = 0; index < at; index += 1) mark(index, 'done');
      mark(at, 'failed', 'stopped here');
      for (let index = at + 1; index < steps.length; index += 1) mark(index, 'skipped');
      Object.assign(out, {
        tone: 'bad',
        icon: 'x-circle',
        title: 'The update did not go through',
        text: flow.problem ?? 'The update stopped.',
        outcome: 'failed',
        announce: `The update did not go through. ${flow.problem ?? ''}`.trim(),
      });
      return out;
    }
    case 'following': {
      mark(0, 'done');
      mark(1, 'done');
      mark(SEND_AT, 'done', 'sent');
      const line = flow.line;
      const byKey = new Map((line?.rows ?? []).map((row) => [row.step, row]));
      let stopped = false;
      for (const [index, step] of STEPS.entries()) {
        if (index <= SEND_AT) continue;
        const row = byKey.get(step.key);
        if (!row) {
          mark(index, stopped ? 'skipped' : 'upcoming');
          continue;
        }
        const state = LINE_STATES[row.state] ?? 'upcoming';
        const at = row.at ? timeOfDay(new Date(row.at).toISOString()) : null;
        mark(index, state, state === 'done' ? (row.state === 'likely' ? 'probably' : at) : null);
        if (state === 'failed') stopped = true;
      }
      const rows = line?.rows ?? [];
      const failed = rows.find((row) => row.state === 'failed');
      const current = rows.find((row) => row.state === 'current') ?? rows.find((row) => row.state === 'likely');
      const outcome = line?.outcome ?? null;
      if (outcome === 'kept' && !line.tentative) {
        Object.assign(out, {
          tone: 'good',
          icon: 'check-circle',
          title: `Kept ${version}`,
          text: `${board} runs ${version} and keeps it.`,
          outcome: 'kept',
          announce: `The update is done. ${board} runs ${version}.`,
        });
      } else if (outcome === 'rolled_back') {
        Object.assign(out, {
          tone: 'bad',
          icon: 'undo',
          title: line.rolledBackTo ? `Rolled back to ${line.rolledBackTo}` : 'Rolled back',
          text: failed?.detail ?? `${board} did not keep ${version}.`,
          outcome: 'rolled_back',
          announce: `The update did not stick. ${failed?.title ?? ''}`.trim(),
        });
      } else if (failed || outcome === 'expired') {
        const row = failed ?? current ?? rows.at(-1);
        Object.assign(out, {
          tone: 'warn',
          icon: 'minus',
          title: row?.title ?? 'The board did not take the image',
          text: row?.detail ?? 'Nothing was installed.',
          outcome: outcome ?? 'failed',
          announce: `${row?.title ?? 'The update stopped.'}`,
        });
      } else if (line?.finished) {
        // Following ended with no word on the end: the note says why, and where the answer is.
        Object.assign(out, {
          tone: 'idle',
          icon: 'clock',
          title: `${version} was sent`,
          text: line.note ?? 'The app has stopped following the board.',
          outcome: 'unknown',
          announce: `${version} was sent. ${line.note ?? ''}`.trim(),
        });
      } else if (current?.step === 'button') {
        const left = Math.max(0, Math.ceil((line.deadline - now) / 1000));
        Object.assign(out, {
          tone: 'act',
          icon: 'press',
          title: 'Press Button 1 on the board',
          text: line.waitingForButton
            ? `It installs ${version}. Button 2 throws it away. ${watch.countdown(left)}`
            : (current.detail ?? WORDS_BUTTON),
          next: null,
          announce: 'Sent. Press Button 1 on the board within 2 minutes to install it.',
        });
      } else if (current?.step === 'installing') {
        Object.assign(out, {
          icon: 'restart',
          busy: true,
          title: `${board} is restarting into ${version}`,
          text: current.detail ?? 'The bootloader checks the image and swaps it in.',
          announce: `${board} is restarting into ${version}.`,
        });
      } else if (current?.step === 'trial') {
        Object.assign(out, {
          icon: 'pulse',
          title: `${board} runs ${version} on trial`,
          text: current.detail ?? 'Back with the new version, not yet kept.',
          announce: `${board} runs ${version} on trial.`,
        });
      } else {
        Object.assign(out, {
          icon: 'clock',
          busy: true,
          title: 'Waiting for the board',
          text: line?.note ?? 'The board is being followed over Bluetooth and the console.',
          announce: 'Waiting for the board.',
        });
      }
      if (line?.note && out.outcome === null && out.text !== line.note) out.next = line.note;
      return out;
    }
    default:
      return null;
  }
}

const WORDS_BUTTON = 'The board accepted the image.';

function runStats(model) {
  const { flow } = model;
  if (!flow.progress) return null;
  const { sent, total } = flow.progress;
  const { speed, secondsLeft } = transferStats(flow.samples, total);
  const left = timeLeftWords(secondsLeft);
  return h(
    'dl',
    { class: 'bt-stats' },
    h('div', { key: 'sent' }, h('dt', null, 'Sent'), h('dd', null, `${fileSize(sent)} of ${fileSize(total)}`)),
    h(
      'div',
      { key: 'speed' },
      h('dt', null, 'Speed'),
      h('dd', null, speed ? `${fileSize(Math.round(speed))}/s` : 'measuring…')
    ),
    h(
      'div',
      { key: 'left' },
      h('dt', null, 'Time left'),
      h('dd', null, left ? [left, h('span', { class: 'bt-estimate' }, ' (estimate)')] : 'measuring…')
    )
  );
}

function versionLine(flow) {
  const to = flow.facts?.version ?? flow.release;
  return h(
    'p',
    { class: 'bt-versions' },
    flow.running
      ? [mono(flow.running), h('span', { class: 'bt-arrow', 'aria-label': 'to' }, icon('arrow-right')), mono(to)]
      : mono(to)
  );
}

/** The card of the update under way: the board, from and to, what is happening, the steps. */
function runCard(model, ctx, run, device) {
  const { flow } = model;
  const release = flow.releases.find((item) => item.version === run.version);
  const notes = notesSnippet(release?.notes);
  const sending = flow.step === 'sending';
  const finished = ['failed', 'cancelled'].includes(flow.step) || (flow.step === 'following' && flow.line?.finished);
  const canCancel = ['pairing', 'downloading', 'clearing', 'sending'].includes(flow.step);
  const boardHref = run.thing ? deviceHref(run.thing) : null;
  const figure = sending
    ? h(
        'p',
        { class: 'execution-figure bt-figure', 'aria-hidden': 'true' },
        String(run.percent),
        h('span', { class: 'execution-percent' }, '%')
      )
    : null;
  return h(
    'article',
    { key: 'run', class: `card execution bt-run is-${run.tone}`, 'data-phase': flow.step },
    h(
      'header',
      { class: 'execution-head' },
      h('h2', { class: 'execution-name' }, flow.board?.name ?? 'Board'),
      h('span', { class: 'bt-via quiet' }, icon('bluetooth'), ` Over Bluetooth, from this ${device}`)
    ),
    h(
      'div',
      { class: 'bt-release' },
      versionLine(flow),
      release ? h('span', { class: 'quiet' }, fileSize(release.size)) : null,
      notes ? h('p', { class: 'bt-notes' }, notes) : null
    ),
    h(
      'div',
      { class: 'execution-state' },
      h(
        'div',
        { class: 'execution-words' },
        h('p', { class: `execution-title status is-${run.tone}` }, icon(run.icon), h('span', null, run.title)),
        h('p', { class: 'execution-text' }, run.text),
        run.next ? h('p', { class: 'execution-next' }, run.next) : null,
        sending || run.busy
          ? h(
              'div',
              {
                class: `meter bt-meter${run.busy ? ' is-busy' : ''}`,
                role: 'progressbar',
                'aria-label': run.busy ? 'Working' : `${run.version} sent to ${flow.board?.name}`,
                'aria-valuemin': '0',
                'aria-valuemax': '100',
                'aria-valuenow': run.busy ? null : String(run.percent),
                vars: { '--progress': `${run.percent}%` },
              },
              h('span', { class: 'meter-fill' })
            )
          : null,
        sending ? runStats(model) : null,
        flow.step === 'ready' ? [releaseList(model, flow), readyNote()] : null
      ),
      figure
    ),
    h(
      'div',
      { class: 'pipeline', key: 'pipeline' },
      stepList(
        { steps: run.steps, tone: run.tone, progress: sending ? run.percent : null, icon: run.icon },
        { marks: MARKS, progressAt: SEND_AT, label: 'Steps of the update over Bluetooth' }
      )
    ),
    // One polite line that changes at a phase, and every tenth of the upload.
    h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite', key: 'live' }, run.announce),
    h(
      'div',
      { class: 'actions bt-actions' },
      flow.step === 'ready' ? button('is-primary', model.send, icon('send'), 'Send') : null,
      run.outcome === 'kept' && boardHref
        ? linkTo(boardHref, { class: 'btn is-primary' }, icon('chip'), 'Open the board’s page')
        : null,
      run.outcome === 'kept' || run.outcome === 'unknown' ? button('', model.reset, 'Update another board') : null,
      run.outcome && !['kept', 'unknown'].includes(run.outcome)
        ? button('is-primary', model.reset, icon('restart'), 'Try again')
        : null,
      run.outcome && !['kept', 'unknown'].includes(run.outcome) && boardHref
        ? linkTo(boardHref, { class: 'btn' }, 'Open the board’s page')
        : null,
      canCancel ? button('is-quiet', model.cancel, icon('x'), 'Cancel') : null,
      flow.step === 'ready' ? button('is-quiet', model.reset, 'Cancel') : null,
      flow.step === 'following' && !finished ? button('is-quiet', model.reset, 'Stop following') : null
    )
  );
}

const readyNote = () =>
  h(
    'p',
    { class: 'quiet bt-fineprint', key: 'fine' },
    'The console is asked right before the send whether the release is still active: without its yes nothing is sent.'
  );

function releaseList(model, flow) {
  const choices = offerable(flow.releases, flow.running);
  if (choices.length === 0)
    return h(
      'p',
      { class: 'quiet', key: 'none' },
      flow.running ? 'No active release is newer than this board.' : 'No active release to send.'
    );
  return h(
    'fieldset',
    { class: 'choices bt-choices', key: 'releases' },
    h('legend', { class: 'sr-only' }, 'Release to send'),
    choices.map((release, index) =>
      h(
        'label',
        { key: release.version, class: 'choice' },
        h('input', {
          type: 'radio',
          name: 'bt-release',
          checked: release.version === flow.release,
          onChange: () => model.chooseRelease(release.version),
        }),
        h(
          'span',
          { class: 'choice-body' },
          h(
            'span',
            { class: 'choice-title' },
            mono(release.version),
            index === 0 ? h('span', { class: 'badge is-good' }, 'Newest') : null,
            h('span', { class: 'quiet' }, fileSize(release.size))
          ),
          notesSnippet(release.notes) ? h('span', { class: 'choice-note' }, notesSnippet(release.notes)) : null
        )
      )
    )
  );
}

/** The window of the board, drawn with its two buttons: Button 1 is the one held. */
function windowHelp(device) {
  return h(
    'div',
    { class: 'bt-window' },
    h(
      'p',
      null,
      'At the board, hold ',
      h('strong', null, 'Button 1'),
      ` for 5 s and let go. LED1 flashes four times: Bluetooth is open for 3 minutes, for this ${device} to find.`
    )
  );
}

function boardTile(model, board) {
  const quality = signalQuality(board.rssi);
  return h(
    'li',
    { key: board.id },
    h(
      'button',
      { type: 'button', class: 'bt-board', onClick: () => model.connect(board) },
      icon('chip'),
      h('span', { class: 'bt-board-name' }, mono(board.name)),
      quality
        ? h(
            'span',
            { class: 'bt-board-signal', title: `${board.rssi} dBm` },
            signalBars(quality),
            h('span', { class: 'quiet' }, quality.label)
          )
        : null,
      icon('chevron-right', 'bt-board-go')
    )
  );
}

const SETUP = ['Release', 'Board', 'Send'];

function setupHead(at) {
  return h(
    'ol',
    { class: 'bt-setup', 'aria-label': 'Steps before sending' },
    SETUP.map((name, index) =>
      h(
        'li',
        {
          key: name,
          class: index < at ? 'is-done' : index === at ? 'is-current' : '',
          'aria-current': index === at ? 'step' : null,
        },
        h('span', { class: 'bt-setup-n' }, index < at ? icon('check') : String(index + 1)),
        name
      )
    )
  );
}

/** The page. `ctx.bluetooth` is the flow's controls (createBluetoothFlow), `ctx.state.app` what the app offers. */
export function bluetoothView(ctx) {
  const { state } = ctx;
  const model = ctx.bluetooth;
  const device = state.app?.device ?? 'device';
  const head = pageHead({
    title: 'Update over Bluetooth',
    lede: `Send a release to a board in reach, from this ${device}.`,
  });
  if (!state.app?.ble) {
    return h(
      'div',
      { class: 'page', key: 'page' },
      head,
      notice('warn', 'alert', 'Bluetooth updates are in the apps only.')
    );
  }
  if (state.me?.canWrite !== true) {
    return h(
      'div',
      { class: 'page', key: 'page' },
      head,
      notice('warn', 'lock', 'Only a release manager can send firmware to a board.')
    );
  }
  if (!model) return h('div', { class: 'page', key: 'page' }, head, h('p', { class: 'loading' }, 'Loading…'));
  const { flow } = model;
  const pinned =
    flow.step === 'pairing' && flow.passkey
      ? h(
          'div',
          { class: 'bt-passkey', key: 'passkey', role: 'status' },
          h('span', { class: 'eyebrow' }, 'Passkey'),
          h('span', { class: 'bt-passkey-digits mono' }, flow.passkey.passkey),
          h(
            'span',
            { class: 'quiet' },
            'On the clipboard for 2 minutes. Board in the console: ',
            mono(flow.passkey.thing ?? 'not known')
          ),
          button('is-small is-quiet', model.copyPasskey, icon('copy'), 'Copy')
        )
      : null;

  const run = describeRun(flow, { device, now: state.now ?? Date.now() });
  const body = [];
  if (run) {
    // A problem with the passkey, while pairing, is a note under the card; a failure is the card's own words.
    body.push(runCard(model, ctx, run, device));
    if (flow.step === 'pairing' && !flow.passkey) {
      body.push(
        h(
          'p',
          { class: 'quiet bt-fineprint', key: 'nopasskey' },
          flow.passkeyMissing
            ? 'The console has no passkey for this board: it may be offline. The passkey is on the board’s serial console, [BT] passkey.'
            : 'Asking the console for the passkey…'
        )
      );
    }
    if (flow.step === 'ready' && flow.problem) body.push(notice('bad', 'alert', flow.problem, { key: 'problem' }));
  } else {
    const problem = flow.problem ? notice('bad', 'alert', flow.problem) : null;
    if (flow.step === 'boards') {
      body.push(
        h(
          'section',
          { key: 'boards', class: 'card bt-pick' },
          setupHead(1),
          h('h2', { class: 'bt-pick-title' }, 'Pick the board'),
          flow.boards.length === 0
            ? h(
                'div',
                { class: 'bt-looking', role: 'status' },
                h('span', { class: 'bt-pulse', 'aria-hidden': 'true' }),
                h('p', null, 'Looking for boards…'),
                h('p', { class: 'quiet' }, 'Hold Button 1 for 5 s if its window is not open.')
              )
            : h(
                'ul',
                { class: 'bt-boards' },
                flow.boards.map((board) => boardTile(model, board))
              ),
          h('div', { class: 'actions' }, button('is-quiet', model.reset, icon('arrow-left'), 'Back'))
        )
      );
    } else {
      body.push(
        h(
          'section',
          { key: 'release', class: 'card bt-pick' },
          setupHead(0),
          h(
            'div',
            { class: 'bt-columns' },
            h(
              'div',
              { class: 'bt-col' },
              h('h2', { class: 'bt-pick-title' }, 'Which release?'),
              releaseList(model, flow)
            ),
            h(
              'div',
              { class: 'bt-col' },
              h('h2', { class: 'bt-pick-title' }, 'Open the board’s window'),
              windowHelp(device),
              problem,
              h(
                'div',
                { class: 'actions' },
                button('is-primary', model.lookForBoards, icon('locate'), 'Look for boards')
              )
            )
          )
        )
      );
    }
  }
  return h('div', { class: 'page bt-page', key: 'page' }, pinned, head, body);
}
