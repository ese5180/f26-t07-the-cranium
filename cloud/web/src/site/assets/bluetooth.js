/**
 * Updating a board over Bluetooth, in the phone app (docs/mobile-apps.md, "What a person does"): the
 * console's own page for what the classic apps' Bluetooth screens do, shown only where the app's bridge
 * offers Bluetooth (bridge.js). The rules are the contract's, as the classic apps have them:
 *
 *   - only active releases newer than what the board runs (its slot 0) are offered, newest first;
 *   - the passkey comes from the console while the board pairs, every 3 s for 90 s at most, and is
 *     shown pinned at the top of the page and put on the clipboard for this phone, for 2 minutes;
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
  fileSize,
  formatVersion,
  isRefusal,
  parseVersion,
  plainMessage,
  readImageHeader,
  sentence,
  sha256Hex,
  timeOfDay,
  toBase64,
} from './core.js';
import { button, card, h, icon, meter, mono, notice, pageHead } from './views.js';
import * as watch from './updatewatch.js';

export const PASSKEY_EVERY_MS = 3000;
export const PASSKEY_FOR_MS = 90000;
// The board drops an authenticated link with nothing on it for 120 s: read the image list well before.
export const KEEPALIVE_MS = 15000;
// The passkey on the clipboard, for this phone and this long (the pairing box hides the page).
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

const RADIO_WORDS = {
  off: 'Bluetooth is off. Switch it on, then look again.',
  unauthorized: "The app may not use Bluetooth. Allow it for Cranium in the phone's settings, then look again.",
  unsupported: 'This phone has no Bluetooth LE.',
  unknown: 'Bluetooth is not ready yet. Look again in a moment.',
};

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
}) {
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
      fail(bridgeWords(error, 'The phone could not look for boards.'));
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
    // The passkey from the moment the phone connects: the iPhone app's ble.connect returns only once the
    // board has paired, the Android app's at once, with the pairing still to come.
    pollPasskey(board.name, now());
    try {
      await bridge.call('ble.connect', { id: board.id });
    } catch (error) {
      fail(bridgeWords(error, 'The phone could not connect to the board.'));
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
    changed();
    try {
      await bridge.call('ble.upload', { image: toBase64(bytes), sha256: release.sha256 });
    } catch (error) {
      collecting = null;
      flow.step = 'failed';
      flow.busy = false;
      flow.problem = `${bridgeWords(error, 'The upload did not finish.')} Open a new window and send it again: it starts over.`;
      quietly('app.keepAwake', { on: false });
      changed();
      return;
    }
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

const STEP_ICONS = { done: 'check-circle', current: 'clock', waiting: 'minus', likely: 'check', failed: 'x-circle' };

function timelineView(line, now) {
  return h(
    'ol',
    { class: 'bt-steps', key: 'steps' },
    line.rows.map((row) =>
      h(
        'li',
        { key: row.step, class: `bt-step is-${row.state}` },
        icon(STEP_ICONS[row.state] ?? 'minus'),
        h(
          'div',
          { class: 'bt-step-text' },
          h(
            'span',
            { class: 'bt-step-title' },
            row.title,
            row.at ? h('span', { class: 'quiet' }, ` · ${timeOfDay(new Date(row.at).toISOString())}`) : null
          ),
          row.step === 'button' && line.waitingForButton
            ? h(
                'span',
                { class: 'bt-countdown mono' },
                watch.countdown(Math.max(0, Math.ceil((line.deadline - now) / 1000)))
              )
            : null,
          row.detail ? h('span', { class: 'bt-step-detail' }, row.detail) : null
        )
      )
    )
  );
}

function releaseList(model, flow) {
  const choices = offerable(flow.releases, flow.running);
  if (choices.length === 0) return h('p', { class: 'quiet', key: 'none' }, 'No active release to send.');
  return h(
    'div',
    { class: 'choices', key: 'releases' },
    choices.map((release) =>
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
          h('span', { class: 'choice-title' }, mono(release.version)),
          h('span', { class: 'choice-note' }, fileSize(release.size), release.notes ? ` · ${release.notes}` : '')
        )
      )
    )
  );
}

/** The page. `ctx.bluetooth` is the flow's controls (createBluetoothFlow), `ctx.state.app` what the app offers. */
export function bluetoothView(ctx) {
  const { state } = ctx;
  const model = ctx.bluetooth;
  const head = pageHead({
    title: 'Update over Bluetooth',
    lede: 'Send a release to a board in reach, from this phone.',
  });
  if (!state.app?.ble) {
    return h(
      'div',
      { class: 'page', key: 'page' },
      head,
      notice('warn', 'alert', 'Bluetooth updates are in the phone apps only.')
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
  const problem = flow.problem
    ? notice('bad', 'alert', flow.problem, {
        action: flow.step === 'failed' ? button('is-small', model.reset, 'Start again') : null,
      })
    : null;

  const body = [];
  if (flow.step === 'release' || flow.step === 'failed') {
    body.push(card({ key: 'release', title: '1. Release' }, releaseList(model, flow)));
    body.push(
      card(
        { key: 'open', title: "2. Open the board's window" },
        h(
          'p',
          null,
          'At the board, hold ',
          h('strong', null, 'Button 1'),
          ' for 5 s and let go. LED1 flashes four times: Bluetooth is open for 3 minutes.'
        ),
        button('is-primary', model.lookForBoards, icon('locate'), 'Look for boards')
      )
    );
  } else if (flow.step === 'boards') {
    body.push(
      card(
        { key: 'boards', title: '3. Pick the board' },
        flow.boards.length === 0
          ? h('p', { class: 'loading' }, 'Looking for boards… Hold Button 1 for 5 s if its window is not open.')
          : h(
              'ul',
              { class: 'bt-boards' },
              flow.boards.map((board) =>
                h(
                  'li',
                  { key: board.id },
                  button(
                    '',
                    () => model.connect(board),
                    icon('chip'),
                    mono(board.name),
                    board.rssi !== null ? h('span', { class: 'quiet' }, ` ${board.rssi} dBm`) : null
                  )
                )
              )
            ),
        button('is-quiet', model.reset, 'Back')
      )
    );
  } else if (flow.step === 'pairing') {
    body.push(
      card(
        { key: 'pairing', title: `Pairing with ${flow.board.name}` },
        h('p', null, "Type the 6-digit passkey into the phone's pairing box."),
        flow.passkey
          ? null
          : h(
              'p',
              { class: 'quiet' },
              flow.passkeyMissing
                ? "The console has no passkey for this board: it may be offline. The passkey is on the board's serial console, [BT] passkey."
                : 'Asking the console for the passkey…'
            ),
        button('is-quiet', model.reset, 'Cancel')
      )
    );
  } else if (['ready', 'downloading', 'clearing'].includes(flow.step)) {
    body.push(
      card(
        { key: 'ready', title: `${flow.board.name} runs ${flow.running ?? 'a version this page cannot read'}` },
        releaseList(model, flow),
        h(
          'p',
          { class: 'quiet' },
          'The console is asked right before the send whether the release is still active: without its yes nothing is sent.'
        ),
        h(
          'div',
          { class: 'actions' },
          button(
            'is-primary',
            model.send,
            icon('send'),
            flow.step === 'downloading' ? 'Downloading…' : flow.step === 'clearing' ? 'Asking the console…' : 'Send'
          ),
          button('is-quiet', model.reset, 'Cancel')
        )
      )
    );
  } else if (flow.step === 'sending') {
    const percent = flow.progress ? Math.floor((flow.progress.sent / flow.progress.total) * 100) : 0;
    body.push(
      card(
        { key: 'sending', title: `Sending ${flow.release} to ${flow.board.name}` },
        meter(percent, 'Sent'),
        h('p', { class: 'quiet' }, `${percent}% · keep the phone near the board`)
      )
    );
  }
  if (flow.line) {
    body.push(
      card(
        { key: 'follow', title: `${flow.facts.version} to ${flow.board?.name ?? 'the board'}` },
        timelineView(flow.line, state.now ?? Date.now()),
        flow.line.note ? h('p', { class: 'quiet', key: 'note' }, flow.line.note) : null,
        flow.line.finished
          ? button('', model.reset, 'Update another board')
          : button('is-quiet', model.reset, 'Stop following')
      )
    );
  }
  return h('div', { class: 'page', key: 'page' }, pinned, head, problem, body);
}
