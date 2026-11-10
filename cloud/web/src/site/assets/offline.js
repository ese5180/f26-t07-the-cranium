/**
 * Offline mode, in the iPhone, Android and Mac apps (docs/mobile-apps.md, "Offline mode"): a board's own
 * status straight over Bluetooth, with no Wi-Fi, no internet and no console, and the one thing a person
 * may do there: accept the update that has arrived at the board and waits. From firmware 1.19.0.
 *
 * The board's offline service (firmware/app/src/bt/bt_offline.c, its bytes in
 * src/policy/bt_offline_policy.h) answers only a link paired with the board's own passkey, the one
 * `BT_OFFLINE|NEW` showed once on its serial console. The system of the phone or the Mac asks for it in
 * its own pairing box; neither the app nor this page ever sees it. The app does the Bluetooth
 * (bridge.json, ble.offline.*) and hands over the status as bytes; this page reads them, says them in
 * words, and asks before it accepts, naming the version.
 *
 * The page is shown only where the app's hello offers `bleOffline`, and works signed out as well: the
 * sign-in page and "No connection" lead here, since offline mode is for when there is no network.
 *
 * The flow (createOfflineFlow) is given the bridge and timers, so that the tests drive it with stand-ins.
 * offlineView draws it.
 */

import { signalQuality } from './core.js';
import { button, h, icon, mono, notice, pageHead, signalBars } from './views.js';

// The status, format 1 (bt_offline_policy.h): 20 bytes, least significant first.
export const OFFLINE_FORMAT = 1;
export const OFFLINE_LEN = 20;
const BOARD_NAME = /^Cranium-[0-9A-F]{4}$/;

const WIFI = ['none', 'down', 'up'];
const CLOUD = ['none', 'down', 'up'];
const UPDATE = ['idle', 'cloudOffer', 'cloudBusy', 'trial', 'waiting', 'receiving'];
// enum reset_kind (firmware/app/src/diag/reset_cause.h), in its order; 0xff is "not known".
const REBOOT = [
  'Brown-out',
  'Power on',
  'Watchdog',
  'Debugger',
  'Security',
  'Wake from low power',
  'Lock-up',
  'Parity',
  'Clock',
  'Hardware',
  'Reset by the user',
  'Temperature',
  'Software',
  'Reset pin',
];

/** The board's offline status from its bytes; null when short or of a format this page does not know. */
export function parseOfflineStatus(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < OFFLINE_LEN || bytes[0] !== OFFLINE_FORMAT) return null;
  const u16 = (at) => bytes[at] | (bytes[at + 1] << 8);
  const u32 = (at) => (u16(at) + u16(at + 2) * 65536) >>> 0;
  const update = UPDATE[bytes[3]] ?? 'unknown';
  return {
    wifi: WIFI[bytes[1]] ?? 'unknown',
    cloud: CLOUD[bytes[2]] ?? 'unknown',
    update,
    reboot: bytes[4],
    running: `${bytes[6]}.${bytes[7]}.${u16(8)}+${u32(10)}`,
    uptime: u32(14),
    // An update that waits is named by its major and minor, which is what the person confirms.
    waiting: update === 'waiting' ? `${bytes[18]}.${bytes[19]}` : null,
  };
}

/** The status from the base64 the app sends; null when it is not one. */
export function offlineStatusFromBase64(text) {
  if (typeof text !== 'string' || text.length > 256) return null;
  try {
    const binary = atob(text);
    return parseOfflineStatus(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** "1.19.0", or "1.19.0 (build 5)": the running version as a person reads it. */
export function runningWords(running) {
  const [version, build] = String(running).split('+');
  return build && build !== '0' ? `${version} (build ${build})` : version;
}

export const wifiWords = (wifi) =>
  ({ none: 'No Wi-Fi on this board', down: 'Not connected', up: 'Connected' })[wifi] ?? 'Not known';

export const cloudWords = (cloud) =>
  ({ none: 'No cloud on this board', down: 'Not connected', up: 'Connected' })[cloud] ?? 'Not known';

export function updateWords(status) {
  switch (status.update) {
    case 'idle':
      return 'No update';
    case 'cloudOffer':
      return 'An update from the cloud waits for a button press at the board';
    case 'cloudBusy':
      return 'An update from the cloud is being installed';
    case 'trial':
      return 'A new version is on trial';
    case 'waiting':
      return `Version ${status.waiting} has arrived and waits`;
    case 'receiving':
      return 'An update is arriving';
    default:
      return 'Not known';
  }
}

export const rebootWords = (code) => REBOOT[code] ?? 'Not known';

/** "3 d 4 h", "2 h 5 min", "4 min 10 s". */
export function uptimeWords(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} d ${hours} h`;
  if (hours > 0) return `${hours} h ${m} min`;
  return `${m} min ${s % 60} s`;
}

// What the radio's state means, in the words of the device the app runs on.
const radioWords = (device) => ({
  off: 'Bluetooth is off. Switch it on, then look again.',
  unauthorized: `The app may not use Bluetooth. Allow it for Cranium in the settings of this ${device}.`,
  unsupported: `This ${device} has no Bluetooth LE.`,
  unknown: 'Bluetooth is not ready yet. Look again in a moment.',
});

function bridgeWords(error, fallback) {
  if (error?.code === 'busy') return 'An update over Bluetooth is using the radio. Let it finish, then look again.';
  return typeof error?.message === 'string' && error.message !== '' ? error.message : fallback;
}

/**
 * The flow of one visit to a board. Steps: start (nothing yet), boards (looking), connecting (connecting
 * and pairing: the system asks for the passkey), ready (the status is shown), failed (with `problem`).
 */
export function createOfflineFlow({ bridge, onChange = () => {}, device = 'device' }) {
  const flow = {
    step: 'start',
    boards: [],
    board: null,
    status: null,
    readAt: null,
    problem: null,
    // The version the person is asked to confirm, while the question stands.
    confirming: null,
    accepting: false,
    // The version the board took, once it has.
    accepted: null,
  };
  const changed = () => onChange();
  const quietly = (method, params = {}) => bridge.call(method, params).catch(() => null);
  let visit = 0;

  function take(payload) {
    const status = offlineStatusFromBase64(payload);
    if (!status) return false;
    flow.status = status;
    flow.readAt = Date.now();
    // The question was about a version that no longer waits: it is not asked any more.
    if (flow.confirming && status.waiting !== flow.confirming) flow.confirming = null;
    return true;
  }

  bridge.on('ble.boards', ({ boards }) => {
    if (flow.step !== 'boards') return;
    flow.boards = (Array.isArray(boards) ? boards : [])
      .filter((board) => typeof board?.id === 'string' && BOARD_NAME.test(board?.name ?? ''))
      .map((board) => ({ id: board.id, name: board.name, rssi: Number.isFinite(board.rssi) ? board.rssi : null }));
    changed();
  });
  bridge.on('ble.offline.status', ({ payload }) => {
    if (flow.step !== 'ready' || !take(payload)) return;
    changed();
  });
  bridge.on('ble.offline.link', ({ error }) => {
    if (flow.step !== 'connecting' && flow.step !== 'ready') return;
    flow.confirming = null;
    flow.accepting = false;
    if (flow.accepted) {
      // The board restarts to install what it took, and its window closes with it.
      flow.step = 'restarting';
    } else {
      flow.step = 'failed';
      flow.problem =
        typeof error === 'string' && error !== ''
          ? error
          : 'The board closed the link. Its Bluetooth window ends after 3 minutes: hold Button 1 for 5 s to open it again.';
    }
    changed();
  });

  async function lookForBoards() {
    visit += 1;
    flow.problem = null;
    flow.board = null;
    flow.status = null;
    flow.accepted = null;
    flow.confirming = null;
    const radio = await bridge.call('ble.state').catch(() => ({ state: 'unknown' }));
    if (radio?.state !== 'on') {
      flow.step = 'start';
      flow.problem = radioWords(device)[radio?.state] ?? radioWords(device).unknown;
      changed();
      return;
    }
    flow.step = 'boards';
    flow.boards = [];
    changed();
    try {
      await bridge.call('ble.scan', { on: true });
    } catch (error) {
      flow.step = 'start';
      flow.problem = bridgeWords(error, `This ${device} could not look for boards.`);
      changed();
    }
  }

  async function connect(board) {
    if (flow.step !== 'boards') return;
    const mine = ++visit;
    flow.step = 'connecting';
    flow.board = board;
    flow.problem = null;
    changed();
    await quietly('ble.scan', { on: false });
    if (mine !== visit) return;
    try {
      const answer = await bridge.call('ble.offline.connect', { id: board.id });
      if (mine !== visit) return;
      if (!take(answer?.payload)) throw new Error('The board sent a status this page cannot read. Update the app.');
      flow.step = 'ready';
    } catch (error) {
      if (mine !== visit) return;
      flow.step = 'failed';
      flow.problem = bridgeWords(error, 'The board did not answer.');
      quietly('ble.offline.disconnect');
    }
    changed();
  }

  function askToAccept() {
    if (flow.step !== 'ready' || flow.status?.update !== 'waiting' || !flow.status.waiting) return;
    flow.confirming = flow.status.waiting;
    flow.problem = null;
    changed();
  }

  function dontAccept() {
    flow.confirming = null;
    changed();
  }

  async function accept() {
    const version = flow.confirming;
    if (!version || flow.accepting) return;
    flow.accepting = true;
    changed();
    try {
      await bridge.call('ble.offline.accept', { version });
      flow.accepted = version;
      flow.confirming = null;
    } catch (error) {
      flow.problem = bridgeWords(error, 'The board did not take it.');
      flow.confirming = null;
      // What waits now, read at once rather than at the next read.
      const now = await quietly('ble.offline.status');
      if (now?.payload) take(now.payload);
    }
    flow.accepting = false;
    changed();
  }

  /** Lets go of the board and the scan: another board, or the page is left. */
  async function leave() {
    visit += 1;
    const was = flow.step;
    flow.step = 'start';
    flow.boards = [];
    flow.board = null;
    flow.status = null;
    flow.confirming = null;
    flow.accepting = false;
    flow.accepted = null;
    flow.problem = null;
    changed();
    if (was === 'boards') await quietly('ble.scan', { on: false });
    if (was === 'connecting' || was === 'ready') await quietly('ble.offline.disconnect');
  }

  return {
    flow,
    lookForBoards,
    connect,
    askToAccept,
    dontAccept,
    accept,
    leave,
    /** Another board: let this one go, and look again. */
    async again() {
      await leave();
      await lookForBoards();
    },
  };
}

// Drawing.

/** "How offline mode works", under the lede (views.js pageHead's `how`). */
function offlineHow(device) {
  return {
    title: 'How offline mode works',
    text: [
      `This ${device} talks to the board directly over Bluetooth. Nothing goes through Wi-Fi, the internet or the console, so it works where the board has no network.`,
      [
        'The board answers only after pairing with its own passkey, the six digits that ',
        mono('BT_OFFLINE|NEW'),
        ` showed once on its serial console. This ${device} asks for it in its own pairing box; the app never sees it.`,
      ],
      'You can read the board’s status, and accept an update that has already arrived at it over Bluetooth. You cannot send firmware or change settings here. The board checks that the version you accept is the one that waits before it installs it.',
    ],
  };
}

function windowStep() {
  return h(
    'p',
    { class: 'bt-window' },
    'At the board, hold ',
    h('strong', null, 'Button 1'),
    ' for 5 s and let go. LED1 flashes four times: Bluetooth is open for 3 minutes.'
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

function linkTone(word) {
  if (word === 'up') return 'good';
  if (word === 'down') return 'warn';
  return 'quiet';
}

function statusFacts(status) {
  const row = (term, value, tone = null) =>
    h(
      'div',
      { class: 'fact', key: term },
      h('dt', null, term),
      h('dd', null, tone ? h('span', { class: `status is-${tone}` }, value) : value)
    );
  return h(
    'dl',
    { class: 'facts of-facts' },
    row('Firmware', mono(runningWords(status.running))),
    row('Up for', uptimeWords(status.uptime)),
    row('Wi-Fi', wifiWords(status.wifi), linkTone(status.wifi)),
    row('Cloud', cloudWords(status.cloud), linkTone(status.cloud)),
    row('Update', updateWords(status), status.update === 'waiting' ? 'work' : null),
    row('Last restart', rebootWords(status.reboot))
  );
}

function updatePanel(model, flow, device) {
  const { status } = flow;
  if (flow.accepted) {
    return h(
      'div',
      { class: 'of-update is-good', key: 'accepted', role: 'status' },
      h('p', { class: 'status is-good' }, icon('check'), h('span', null, `The board took ${flow.accepted}.`)),
      h(
        'p',
        { class: 'quiet' },
        'It restarts to install it and closes Bluetooth while it does. Look for it again in a minute to see its version.'
      )
    );
  }
  if (flow.confirming) {
    return h(
      'div',
      { class: 'of-update is-asking', key: 'confirm', role: 'group', 'aria-labelledby': 'of-confirm-title' },
      h(
        'p',
        { class: 'of-confirm-title', id: 'of-confirm-title' },
        `Install version ${flow.confirming} on ${flow.board?.name ?? 'this board'}?`
      ),
      h(
        'p',
        { class: 'quiet' },
        'The board restarts to install it. The new version runs on trial, and the board goes back to this one if it fails its checks.'
      ),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn is-primary',
            disabled: flow.accepting,
            'aria-busy': flow.accepting ? 'true' : null,
            onClick: model.accept,
          },
          flow.accepting ? 'Sending…' : `Install ${flow.confirming}`
        ),
        button('is-quiet', model.dontAccept, 'Cancel')
      )
    );
  }
  if (status.update === 'waiting' && status.waiting) {
    return h(
      'div',
      { class: 'of-update', key: 'waiting' },
      h('p', null, `Version ${status.waiting} has arrived at the board and waits for your yes.`),
      h(
        'div',
        { class: 'actions' },
        button('is-primary', model.askToAccept, icon('check'), 'Accept the waiting update')
      )
    );
  }
  if (status.update === 'cloudOffer') {
    return h(
      'p',
      { class: 'of-update quiet', key: 'cloud' },
      `An update from the cloud waits for a button press at the board. This ${device} cannot accept that one.`
    );
  }
  return null;
}

function boardCard(model, flow, device) {
  const connecting = flow.step === 'connecting';
  return h(
    'article',
    { class: 'card of-board', key: 'board' },
    h(
      'header',
      { class: 'of-board-head' },
      h('h2', { class: 'of-board-name' }, mono(flow.board?.name ?? 'Board')),
      h('span', { class: 'bt-via quiet' }, icon('bluetooth'), ` Direct, from this ${device}`)
    ),
    connecting
      ? h(
          'div',
          { class: 'bt-looking', role: 'status' },
          h('span', { class: 'bt-pulse', 'aria-hidden': 'true' }),
          h('p', null, 'Connecting…'),
          h('p', { class: 'quiet' }, `When this ${device} asks, type the board’s passkey.`)
        )
      : [statusFacts(flow.status), updatePanel(model, flow, device)],
    flow.problem && flow.step === 'ready' ? notice('bad', 'alert', flow.problem) : null,
    h(
      'div',
      { class: 'actions of-board-actions' },
      button('is-quiet', model.again, icon('arrow-left'), connecting ? 'Cancel' : 'Another board')
    )
  );
}

/**
 * The page. `ctx.offline` is the flow's controls (createOfflineFlow), `ctx.state.app` what the app offers.
 * `ctx.back`, when the page is opened from the sign-in page, leads back to it.
 */
export function offlineView(ctx) {
  const { state } = ctx;
  const model = ctx.offline;
  const device = state.app?.device ?? 'device';
  const head = [
    ctx.back
      ? h(
          'button',
          { type: 'button', class: 'back of-back', key: 'back', onClick: ctx.back.run },
          icon('chevron-left'),
          ctx.back.label
        )
      : null,
    pageHead({
      title: 'Offline',
      lede: 'A board’s status over Bluetooth, with no Wi-Fi or cloud.',
      how: offlineHow(device),
    }),
  ];
  if (!state.app?.offline || !model) {
    return h(
      'div',
      { class: 'page of-page', key: 'page' },
      head,
      notice('warn', 'alert', 'Offline mode is in the iPhone, Android and Mac apps only.')
    );
  }
  const { flow } = model;
  const body = [];
  if (flow.step === 'connecting' || flow.step === 'ready') {
    body.push(boardCard(model, flow, device));
  } else if (flow.step === 'boards') {
    body.push(
      h(
        'section',
        { key: 'boards', class: 'card bt-pick' },
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
        h('div', { class: 'actions' }, button('is-quiet', model.leave, icon('arrow-left'), 'Back'))
      )
    );
  } else if (flow.step === 'restarting') {
    body.push(
      h(
        'section',
        { key: 'restarting', class: 'card of-board' },
        h(
          'p',
          { class: 'status is-good' },
          icon('check'),
          h('span', null, `${flow.board?.name ?? 'The board'} is installing ${flow.accepted}.`)
        ),
        h(
          'p',
          { class: 'quiet' },
          'It closed Bluetooth to restart. Open its window again in a minute to check its version.'
        ),
        h('div', { class: 'actions' }, button('is-primary', model.again, icon('locate'), 'Look for boards'))
      )
    );
  } else {
    body.push(
      h(
        'section',
        { key: 'start', class: 'card bt-pick' },
        h('h2', { class: 'bt-pick-title' }, 'Open the board’s window'),
        windowStep(),
        flow.problem ? notice('bad', 'alert', flow.problem) : null,
        h(
          'div',
          { class: 'actions' },
          button(
            'is-primary',
            model.lookForBoards,
            icon('locate'),
            flow.step === 'failed' ? 'Look again' : 'Look for boards'
          )
        )
      )
    );
  }
  return h('div', { class: `page of-page bt-page${ctx.back ? ' is-standalone' : ''}`, key: 'page' }, head, body);
}
