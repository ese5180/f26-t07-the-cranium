/**
 * Board setup: a board plugged in by USB, taken from what it has to a board online on the console, from
 * this page with Web Serial. The steps of scripts/board/new-board.sh that need no debug probe:
 *
 *   1. Connect     the board's console port: what it is, what it runs, its state, and its bootloader.
 *   2. Golden      1.5.0, the golden image (firmware/golden.json), through serial recovery, as
 *                  tools/golden.py restore puts it on; then the person seals it with the gesture, and the
 *                  page watches the bootloader's log for the result, as tools/new_board.py watch-seal does.
 *   3. Firmware    the newest active release on the console for the board's type, the same way.
 *   4. Set up      first-time setup (INIT), the Wi-Fi network, the board's own key and the certificate
 *                  for it from the console's register route, Amazon's root CA, and the cloud settings, as
 *                  tools/provision_device.py does.
 *   5. Online      the console sees the board.
 *
 * The golden image goes on before the newest release: putting it back replaces the running image.
 *
 * The network's name and passphrase go to the board over the cable and nowhere else: never to the server,
 * never into the page's state or the browser's storage. They are read from their fields when they are
 * sent, the line's bytes are overwritten once written, and the passphrase's field is emptied. The fields
 * start with the console's Wi-Fi defaults (GET /api/setup/wifi-defaults, release managers only), put
 * straight into them and kept nowhere else; the person may change them, and the passphrase stays masked.
 *
 * The self-check (runSelfCheck) runs the whole flow against a board simulated in the page: the firmware's
 * console and MCUboot's serial recovery, with their line limits. It needs no board and changes nothing on
 * the console: its API is simulated too, but for the golden image, which it reads from the console.
 *
 * What it cannot do: a board with nothing on it has no bootloader, so serial recovery cannot reach it,
 * and it needs the debug probe once (scripts/board/new-board.sh, or west flash --recover). The page says
 * so when nothing answers. Web Serial exists only in Chrome and Edge on a computer, and in the desktop app.
 *
 * No dependencies beyond views.js and recovery.js.
 */

import {
  BAUD_RATE,
  BOOT_LINE_MAX,
  BOOT_RECEIVE_MAX,
  BoardError,
  CONSOLE_LINE_MAX,
  ENTER_BOOTLOADER,
  GROUP_OS,
  ID_OS_RESET,
  OP_WRITE,
  SEGGER_VENDOR_ID,
  SERIAL_BUFFER_BYTES,
  createLink,
  createSmpReader,
  crc16CcittFalse,
  frameLines,
  keyValues,
  parseImage,
  sha256Hex,
  smpPacket,
  toBase64,
  uploadImage,
} from './recovery.js';
import { button, developerTabs, empty, facts, h, icon, meter, mono, notice, pageHead } from './views.js';

// The frozen golden image: firmware/golden.json, which a test holds this to. The web function serves the
// file at GOLDEN_PATH (server.mjs).
export const GOLDEN = Object.freeze({
  version: '1.5.0+0',
  file: 'cranium-1.5.0-0.signed.bin',
  sha256: 'bb3683cb251e72d23fdfba7b61152a0a9fc8febe251827d0e7883491628d329e',
  hashTlv: '6d29aa53aa101a960d43e5aebafc0efb525ed77cc09ddd694bc4a61e370c5013',
  size: 759058,
});

// SHA-256 of the DER form of Amazon Root CA 1 (tools/provision_device.py ROOT_CA_SHA256).
export const ROOT_CA_SHA256 = '8ecde6884f3d87b1125ba31ac3fcb13d7016de7f57cc904fe1cb97c6ae98196e';
const THING_PREFIX = 'cranium-';
// Bytes of a certificate per STREAM_CHUNK line: 256 base64 characters, well inside the line buffer.
const CERT_CHUNK = 192;
const DEFAULT_BOARD = 'nrf7002dk';
// What the page keeps of STATUS (identifyFrom).
const KEPT = Object.freeze([
  'state',
  'id',
  'thing name',
  'firmware',
  'board',
  'layout',
  'wifi password',
  'wifi link',
  'cloud',
  'root CA',
  'private key',
  'certificate',
]);
const BOARD_LABELS = { nrf7002dk: 'nRF7002 DK', nrf5340dk: 'nRF5340 DK' };

// How long things take, in milliseconds (docs/new-board-setup.md, "Time-outs"). The tests and the self-check
// give shorter ones.
export const TIMING = Object.freeze({
  // The console's answer to ECHO|OFF, asked before every command, twice.
  handshake: 2000,
  // A bootloader that listens already: held there with Button 1, or with no image to start.
  listening: 3000,
  // From ENTER_BOOTLOADER to the bootloader's window, as recover.py gives it.
  restart: 15000,
  // The same through a swap being resumed, or a golden-image check that waits out a held button.
  swap: 150000,
  // From the bootloader's restart to the firmware answering STATUS.
  comeBack: 120000,
  status: 8000,
  // INIT erases settings and restarts.
  init: 15000,
  // WIFI_SEC, STREAM_START and CLOUD: each writes to flash.
  wifi: 6000,
  // KEYGEN makes the key in the secure partition.
  keygen: 15000,
  chunk: 8000,
  poll: 5000,
  online: 180000,
  seal: 240000,
});
const SELF_CHECK_TIMING = Object.freeze({
  handshake: 150,
  listening: 300,
  restart: 2000,
  swap: 2000,
  comeBack: 4000,
  status: 1000,
  init: 1000,
  wifi: 1000,
  keygen: 1000,
  chunk: 1000,
  poll: 20,
  online: 500,
  seal: 1000,
});

export const STEPS = Object.freeze([
  { key: 'connect', title: 'Connect' },
  { key: 'golden', title: 'Golden image' },
  { key: 'firmware', title: 'Newest firmware' },
  { key: 'setup', title: 'Set up' },
  { key: 'online', title: 'Online' },
]);

// What the golden image's code in the bootloader says (tools/new_board.py SEAL_DONE and SEAL_REFUSED).
const SEAL_DONE = { 'golden: sealed, restarting': 'sealed', 'golden: nothing to do': 'nothing to do' };
const SEAL_REFUSED = 'golden: refused';

export function sealResult(line) {
  for (const [said, result] of Object.entries(SEAL_DONE)) if (line.includes(said)) return result;
  return line.includes(SEAL_REFUSED) ? 'refused' : null;
}

// Words.

export const WORDS = Object.freeze({
  blank:
    'Nothing answers on this port: neither the firmware nor the bootloader. Either this is the board’s other port, ' +
    'or the board has nothing on it yet. Connect again and choose the other port. A new or erased board has no ' +
    'bootloader, so this page cannot reach it: it needs the debug probe once, from a computer with the repository: ' +
    'scripts/board/new-board.sh (or west flash --recover). Then come back here.',
  enter:
    'The bootloader did not answer. Put it in recovery by hand: hold Button 1, press and let go of RESET, keep ' +
    'holding Button 1 for a second, then let go of it and press Try again.',
  shell: 'The board runs firmware from before the console. The steps below put the newest firmware on it first.',
  noSerial:
    'Web Serial exists only in Chrome and Edge on a computer, and in the Windows and Linux desktop app. Phones and ' +
    'Safari do not have it. Open this page there.',
  probe:
    'A board with nothing on it has no bootloader, so serial recovery cannot reach it. It needs the debug probe ' +
    'once: scripts/board/new-board.sh on a computer with the repository and nRF Connect, or west flash --recover. ' +
    'The desktop app does not do this either: the console holds the signed application images, not the bootloader, ' +
    'TF-M and network core that a blank chip needs, which come from a build.',
  wifiOnly: 'The name and the passphrase go to the board over the cable, and nowhere else.',
  logPort:
    'This port prints the board’s log and takes no commands: it is the board’s other port. Connect again and ' +
    'choose the console port: the one ending in 3 on a Mac, the higher ttyACM on Linux, the other COM port on Windows.',
  wifiFilled: 'Filled in from the console’s Wi-Fi defaults. Change them if this board joins another network.',
  wifiNone: 'The console has no Wi-Fi defaults: type the network in.',
});

// Why a phone app has no Board setup (apps/android BoardSetupText, apps/ios BoardSetupWords: their tests hold
// them to these).
export const APP_WORDS = Object.freeze({
  title: 'Board setup needs a computer',
  android:
    'The Android app’s pages have no Web Serial, and its own USB console sends one command at a time: it cannot ' +
    'reach the bootloader’s half-second window or send it an image. Set the board up in the Windows or Linux ' +
    'desktop app, or in Chrome or Edge on a computer. The Serial console in this app still talks to a board ' +
    'that is set up.',
  ios:
    'An iPhone cannot open a board’s USB serial port: iOS gives apps no way to a USB serial device, and Safari ' +
    'has no Web Serial. Set the board up in the Windows or Linux desktop app, or in Chrome or Edge on a computer.',
});

const BUTTON_STEPS = Object.freeze([
  'Press and hold RESET.',
  'Press and hold Button 2.',
  'Let go of RESET.',
  'Keep holding Button 2 for 5 seconds, until LED1 blinks fast.',
  'Let go of Button 2 within the next 5 seconds.',
]);

// Rules for what is typed: the firmware's, in its words (serial.js has the same).

const encoder = new TextEncoder();
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export const RULES = Object.freeze({
  id(value) {
    return /^[0-9A-Za-z]{1,32}$/.test(value) ? null : 'The ID must be 1 to 32 letters or digits.';
  },
  ssid(value) {
    const bytes = encoder.encode(value).length;
    if (bytes === 0 || bytes > 32) return 'The network name must be 1 to 32 bytes.';
    if (value.includes('|')) return 'A network name with a | in it cannot be sent over the console.';
    return CONTROL.test(value) ? 'The network name cannot hold a control character.' : null;
  },
  passphrase(value) {
    const bytes = encoder.encode(value).length;
    if (bytes === 0) return 'Open networks are not allowed: type the passphrase.';
    if (bytes < 8 || bytes > 63) return 'The passphrase must be 8 to 63 characters.';
    return CONTROL.test(value) ? 'The passphrase cannot hold a control character.' : null;
  },
});
export const SECURITIES = Object.freeze(['WPA2_PSK', 'WPA2_PSK_SHA256', 'WPA3_SAE']);

// Versions and releases.

const VERSION = /^(\d{1,3})\.(\d{1,3})\.(\d{1,5})\+(\d{1,10})$/;

function versionParts(text) {
  const match = typeof text === 'string' ? VERSION.exec(text) : null;
  return match ? match.slice(1).map(Number) : null;
}

function newer(a, b) {
  for (let index = 0; index < 4; index += 1) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}

/** The newest active release for a board type and flash layout, or null. A release that says no type is an nRF7002 DK's. */
export function newestRelease(releases, board, layout = 1) {
  let best = null;
  for (const release of releases ?? []) {
    if (release?.status !== 'active') continue;
    if ((release.board ?? DEFAULT_BOARD) !== board) continue;
    if ((release.layout ?? 1) !== layout) continue;
    const parts = versionParts(release.version);
    if (!parts || !/^[0-9a-f]{64}$/.test(release.sha256 ?? '')) continue;
    if (!best || newer(parts, best.parts)) best = { parts, release };
  }
  return best?.release ?? null;
}

// Certificates.

function pemToDer(pem) {
  const body = String(pem)
    .replace(/-----(BEGIN|END) [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) der[at] = binary.charCodeAt(at);
  return der;
}

const PEM = /^-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/;
const HOST = /^[0-9A-Za-z][0-9A-Za-z.-]{0,126}$/;
const PREFIX = /^https:\/\/[0-9A-Za-z.-]+(?:\/[0-9A-Za-z._~/-]*)?$/;

/** The register route's answer, checked, or a BoardError that says what is wrong with it. */
export function checkRegistration(reply, thing) {
  const answer = reply && typeof reply === 'object' ? reply : {};
  if (answer.thing !== thing)
    throw new BoardError(
      `The console registered ${answer.thing || 'no board'}, and the board calls itself ${thing}. Nothing was loaded onto the board.`,
      'register'
    );
  if (typeof answer.certificatePem !== 'string' || !PEM.test(answer.certificatePem))
    throw new BoardError('The console’s answer has no certificate. Nothing was loaded onto the board.', 'register');
  if (typeof answer.rootCa !== 'string' || !PEM.test(answer.rootCa))
    throw new BoardError('The console’s answer has no root CA. Nothing was loaded onto the board.', 'register');
  if (typeof answer.endpoint !== 'string' || !HOST.test(answer.endpoint) || !answer.endpoint.includes('.'))
    throw new BoardError(
      'The console’s answer has no AWS IoT endpoint. Nothing was loaded onto the board.',
      'register'
    );
  if (
    typeof answer.downloadPrefix !== 'string' ||
    !PREFIX.test(answer.downloadPrefix) ||
    answer.downloadPrefix.includes('|')
  )
    throw new BoardError(
      'The console’s answer has no download address. Nothing was loaded onto the board.',
      'register'
    );
  return answer;
}

// The flow.

function initialSteps() {
  return Object.fromEntries(STEPS.map(({ key }) => [key, { status: 'todo', note: null, error: null }]));
}

/**
 * The page's state and what it does. Nothing typed is kept here: the values of the setup form come in
 * as arguments to runSetup and are gone when it returns.
 *
 * @param {object} options
 * @param {object} options.serial   navigator.serial
 * @param {object} options.api      the console's API (core.js createApi): firmware, image, golden,
 *                                  registerDevice, device
 * @param {object} options.subtle   crypto.subtle
 */
export function createSetupFlow({
  serial,
  api,
  subtle,
  onChange = () => {},
  timing = TIMING,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  let link = null;
  let logLink = null;
  const flow = {
    steps: initialSteps(),
    current: 'connect',
    busy: false,
    board: null,
    progress: null,
    phase: null,
    release: null,
    seal: { watching: false, lines: [], result: null, problem: null, waiting: false },
    // Whether the form's Wi-Fi fields have the console's defaults: idle, loading, filled, none, failed. Never
    // the values.
    wifiDefaults: { state: 'idle', problem: null },
    fillWifiDefaults,
    connect,
    run,
    skip,
    retry,
    runSetup,
    watchSeal,
    sealedByHand,
    disconnect,
  };

  function changed() {
    onChange();
  }

  function set(key, status, { note = null, error = null } = {}) {
    flow.steps[key] = { status, note, error };
    changed();
  }

  function phase(text, progress = null) {
    flow.phase = text;
    flow.progress = progress;
    changed();
  }

  function advance(from) {
    const index = STEPS.findIndex((step) => step.key === from);
    const next = STEPS.slice(index + 1).find((step) => !['done', 'skipped'].includes(flow.steps[step.key].status));
    flow.current = next?.key ?? null;
    // What does not apply to the board is passed over by itself.
    if (flow.current === 'golden' && flow.board?.type !== DEFAULT_BOARD) {
      set('golden', 'skipped', { note: `A ${label(flow.board?.type)} has no golden image.` });
      advance('golden');
      return;
    }
    if (flow.current === 'online' && flow.board?.type !== DEFAULT_BOARD) {
      set('online', 'skipped', {
        note: `A ${label(flow.board?.type)} has Bluetooth only, and never reaches AWS IoT itself.`,
      });
      advance('online');
      return;
    }
    changed();
  }

  /** Run a step's work, with its state kept and its error said in words. */
  async function step(key, work) {
    if (flow.busy) return;
    flow.busy = true;
    flow.current = key;
    set(key, 'running');
    try {
      const outcome = await work();
      flow.busy = false;
      flow.phase = null;
      flow.progress = null;
      if (outcome?.wait) {
        set(key, 'waiting', { note: outcome.note ?? null });
        return;
      }
      set(key, 'done', { note: outcome?.note ?? null });
      advance(key);
    } catch (error) {
      flow.busy = false;
      flow.phase = null;
      flow.progress = null;
      set(key, 'failed', { error: words(error) });
    }
  }

  function words(error) {
    if (error instanceof BoardError) return error.message;
    if (error?.name === 'ApiError' || typeof error?.status === 'number') {
      if (error.status === 403) return 'The console refused: only a release manager may do this.';
      if (error.status === 404) return 'The console does not have this yet.';
      return `The console could not do it: ${error.message ?? 'no reason given'}.`;
    }
    return error?.message ? String(error.message) : 'Something went wrong.';
  }

  // Connecting, and asking the board what it is.

  async function connect() {
    if (flow.busy) return;
    await step('connect', async () => {
      if (!serial) throw new BoardError(WORDS.noSerial, 'no-serial');
      await closeLinks();
      let port;
      try {
        port = await serial.requestPort({ filters: [{ usbVendorId: SEGGER_VENDOR_ID }] });
      } catch {
        throw new BoardError('No port was chosen. Press Connect and choose the board’s console port.', 'not-chosen');
      }
      try {
        await port.open({ baudRate: BAUD_RATE, bufferSize: SERIAL_BUFFER_BYTES });
      } catch {
        throw new BoardError(
          'The port could not be opened. Another program or tab may have it open: close it (the Serial console page too), and connect again.',
          'busy'
        );
      }
      link = createLink(port, { sleep, now, handshakeMs: timing.handshake });
      phase('Asking the board what it is.');
      flow.board = await identify();
      if (flow.board.logPort) throw new BoardError(WORDS.logPort, 'log-port');
      if (flow.board.blank) throw new BoardError(WORDS.blank, 'blank');
      return { note: describe(flow.board) };
    });
  }

  async function identify() {
    let status;
    try {
      status = await readStatus();
    } catch (error) {
      if (error?.code === 'shell') return { app: 'shell', type: DEFAULT_BOARD, bootloader: 'unknown', status: {} };
      // The firmware says nothing. Is the bootloader listening, with no image to start?
      if (await link.greet(timing.listening)) {
        return { app: 'none', type: DEFAULT_BOARD, bootloader: 'listening', status: {} };
      }
      // Lines came, but neither the console nor the bootloader answered: the log port.
      return link.heardText ? { blank: true, logPort: true } : { blank: true };
    }
    return identifyFrom(status);
  }

  /** What STATUS says; in factory mode, GET_ID and THING (board.py Console.status). */
  async function readStatus() {
    const { lines, final } = await link.command('STATUS', timing.status);
    if (final.startsWith('ERR factory mode')) {
      const id = await link.command('GET_ID');
      const match = /^OK ([^|]*)\|(\S+)$/.exec(id.final);
      const thing = await link.command('THING');
      return {
        state: 'FACTORY',
        id: match?.[1] ?? '',
        firmware: match?.[2] ?? null,
        'thing name': thing.final.replace(/^OK /, ''),
      };
    }
    const status = keyValues(lines);
    if (!status['thing name']) throw new BoardError(`The board did not answer STATUS properly: ${final}`, 'status');
    return status;
  }

  function describe(board) {
    if (board.app === 'shell') return WORDS.shell;
    if (board.app === 'none') return 'The bootloader is listening and no firmware runs: the next steps put it on.';
    return `${label(board.type)} ${board.thing}, firmware ${board.firmware}, ${board.state === 'FACTORY' ? 'in factory mode' : 'set up'}.`;
  }

  /** Wait for the firmware to answer again after a restart, running `version` if one is given. */
  async function comeBack(version) {
    const deadline = now() + timing.comeBack;
    let last = null;
    while (now() < deadline) {
      try {
        const status = await readStatus();
        last = status.firmware ?? null;
        if (!version || status.firmware === version) {
          flow.board = { ...(await identifyFrom(status)) };
          return;
        }
      } catch {
        // Restarting. The deadline is what counts.
      }
      await sleep(timing.poll / 5);
    }
    throw new BoardError(
      last
        ? `The board came back with ${last}, not ${version}. The bootloader refused the new image, or put the old one back.`
        : `The board did not come back within ${Math.round(timing.comeBack / 1000)} s.`,
      'come-back'
    );
  }

  /**
   * The board as STATUS describes it. Only what the steps need is kept: not the network's name, nor the
   * endpoint, which the page has no reason to hold.
   */
  function identifyFrom(status) {
    const kept = Object.fromEntries(Object.entries(status).filter(([key]) => KEPT.includes(key)));
    return {
      app: 'console',
      status: kept,
      thing: status['thing name'] ?? null,
      id: status.id ?? '',
      firmware: status.firmware ?? null,
      state: status.state ?? null,
      type: status.board ?? DEFAULT_BOARD,
      layout: Number(status.layout ?? 1) || 1,
      // It started this project's signed firmware: only a bootloader with this project's key does that.
      bootloader: 'ours',
    };
  }

  // Serial recovery.

  async function enterBootloader(deadline) {
    phase('Asking the board to restart into its bootloader.');
    // Firmware known to run is asked first: greetings sent to it are lines it refuses, one ERR each.
    // Otherwise the bootloader may be listening already: held there with Button 1, or no image to start.
    if (flow.board?.app !== 'console' && (await link.greet(timing.listening))) return;
    let running = false;
    try {
      await link.command('GET_ID');
      running = true;
    } catch {
      running = false;
    }
    if (running) {
      await link.writeText(ENTER_BOOTLOADER);
      if (await link.greet(deadline)) return;
    } else if (flow.board?.app === 'console' && (await link.greet(timing.listening))) {
      return;
    }
    throw new BoardError(WORDS.enter, 'enter');
  }

  async function install(image, label, deadline) {
    await enterBootloader(deadline);
    phase(`Sending ${label}.`, { sent: 0, total: image.length });
    await uploadImage(link, image, (sent, total) => phase(`Sending ${label}.`, { sent, total }));
    phase('Restarting. The bootloader checks the signature before it starts the image.');
    await link.smp(OP_WRITE, GROUP_OS, ID_OS_RESET, {});
  }

  // The golden image.

  async function golden() {
    requireBoard();
    if (flow.board.type !== DEFAULT_BOARD) return { note: `A ${label(flow.board.type)} has no golden image.` };
    phase('Fetching the golden image from the console.');
    const image = await api.golden(GOLDEN.file);
    phase('Checking it against firmware/golden.json.');
    if (image.length !== GOLDEN.size || (await sha256Hex(subtle, image)) !== GOLDEN.sha256)
      throw new BoardError(
        'What the console sent is not the frozen golden image: its SHA-256 differs from firmware/golden.json. Nothing was sent to the board.',
        'digest'
      );
    const parsed = parseImage(image);
    if (parsed.version !== GOLDEN.version || parsed.hashTlv !== GOLDEN.hashTlv)
      throw new BoardError(
        'The golden image’s own hash is not the one the bootloader pins. Nothing was sent to the board.',
        'digest'
      );
    await install(image, `the golden image ${GOLDEN.version}`, timing.swap);
    phase(`Waiting for the board to start ${GOLDEN.version}.`);
    await comeBack(GOLDEN.version);
    flow.seal = { watching: false, lines: [], result: null, problem: null, waiting: true };
    return { wait: true, note: `The board runs ${GOLDEN.version}. Now seal it with the gesture.` };
  }

  /**
   * Watch the bootloader's log on the board's other port (VCOM0) for the seal's result, while the person
   * does the gesture. Only the bootloader's "golden:" lines are kept, as watch-seal shows them.
   */
  async function watchSeal() {
    if (flow.seal.watching) return;
    flow.seal = { ...flow.seal, watching: true, problem: null, lines: [], result: null };
    changed();
    let port;
    try {
      port = await serial.requestPort({ filters: [{ usbVendorId: SEGGER_VENDOR_ID }] });
      await port.open({ baudRate: BAUD_RATE, bufferSize: SERIAL_BUFFER_BYTES });
    } catch {
      flow.seal = {
        ...flow.seal,
        watching: false,
        problem:
          'That port could not be opened. Choose the board’s other port: not the console, which this page has open already.',
      };
      changed();
      return;
    }
    logLink = createLink(port, { sleep, now, handshakeMs: timing.handshake });
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timing.seal);
      const stop = logLink.onText((line) => {
        const at = line.indexOf('golden:');
        if (at < 0) return;
        flow.seal.lines = [...flow.seal.lines, line.slice(at)].slice(-20);
        changed();
        const said = sealResult(line);
        if (said) {
          clearTimeout(timer);
          stop();
          resolve(said);
        }
      });
    });
    await logLink.close();
    logLink = null;
    flow.seal = { ...flow.seal, watching: false, result };
    if (result === 'sealed' || result === 'nothing to do') {
      flow.seal.waiting = false;
      set('golden', 'done', {
        note:
          result === 'sealed'
            ? 'Sealed: the golden copy is in external flash.'
            : 'Sealed already: the gesture had nothing to do.',
      });
      await comeBackQuietly();
      advance('golden');
    } else if (result === 'refused') {
      flow.seal.waiting = false;
      set('golden', 'failed', {
        error:
          'The bootloader refused: neither copy is the pinned golden image. Try this step again, which puts the golden image back on.',
      });
    } else {
      flow.seal.problem =
        'The bootloader said nothing about the golden image in 4 minutes. Do the gesture again, or, if LED1 stayed on for about 45 seconds and the board runs 1.5.0, say so below.';
      changed();
    }
  }

  /** The person saw it seal: LED1 on for about 45 seconds, and the board back on 1.5.0. */
  async function sealedByHand() {
    if (!flow.seal.waiting) return;
    flow.seal = { ...flow.seal, waiting: false };
    set('golden', 'done', { note: 'Sealed, by what you saw on the board.' });
    await comeBackQuietly();
    advance('golden');
  }

  async function comeBackQuietly() {
    try {
      await comeBack(null);
    } catch {
      // The next step asks again.
    }
  }

  // The newest release.

  async function firmware() {
    requireBoard();
    // What it runs now: a step done by hand, or skipped, may have changed it.
    if (flow.board.app === 'console') {
      phase('Asking the board what it runs.');
      flow.board = identifyFrom(await readStatus());
    }
    phase('Reading the console’s releases.');
    const { releases } = await api.firmware();
    const release = newestRelease(releases, flow.board.type, flow.board.layout ?? 1);
    if (!release)
      throw new BoardError(
        `The console has no active release for the ${label(flow.board.type)}. Upload one on the Firmware page first.`,
        'no-release'
      );
    flow.release = release.version;
    if (flow.board.app === 'console' && flow.board.firmware === release.version)
      return { note: `The board runs ${release.version}, the newest release, already.` };
    phase(`Fetching ${release.version} from the console.`);
    const image = await api.image(release.version);
    phase('Checking it against the release’s SHA-256.');
    if ((release.size && image.length !== release.size) || (await sha256Hex(subtle, image)) !== release.sha256)
      throw new BoardError(
        `What the console sent for ${release.version} is not that release’s image: its SHA-256 differs. Nothing was sent to the board.`,
        'digest'
      );
    const parsed = parseImage(image);
    if (parsed.board !== flow.board.type || parsed.layout !== (flow.board.layout ?? 1))
      throw new BoardError(`${release.version} is not for this board: it is for the ${label(parsed.board)}.`, 'unfit');
    await install(image, release.version, timing.restart);
    phase(`Waiting for the board to start ${release.version}.`);
    await comeBack(release.version);
    return { note: `The board runs ${release.version}.` };
  }

  // Setting it up.

  async function runSetup({
    id = '',
    ssid = '',
    security = SECURITIES[0],
    passphrase = '',
    keepWifi = false,
    newIdentity = false,
  } = {}) {
    await step('setup', async () => {
      requireBoard();
      if (flow.board.app !== 'console') throw new BoardError('Put the firmware on first: the steps above.', 'no-app');
      let status = await readStatus();
      const thing = status['thing name'];
      if (status.state === 'FACTORY') {
        const deviceId = id || thing.slice(THING_PREFIX.length);
        const problem = RULES.id(deviceId);
        if (problem) throw new BoardError(problem, 'id');
        phase(`First-time setup: ID ${deviceId}. The board restarts.`);
        await expectOk(`INIT|${deviceId}`, timing.init);
        await comeBack(null);
        status = await readStatus();
      }
      const type = status.board ?? DEFAULT_BOARD;
      if (type !== DEFAULT_BOARD) {
        flow.board = identifyFrom(status);
        return {
          note:
            `First-time setup is done. A ${label(type)} is registered with its own passkey by ` +
            'tools/provision_device.py --board nrf5340dk, which this page does not do yet.',
        };
      }

      const hasNetwork = status['wifi password'] === 'set';
      if (!(keepWifi && hasNetwork)) {
        const problem = RULES.ssid(ssid) ?? RULES.passphrase(passphrase);
        if (problem) throw new BoardError(problem, 'wifi');
        if (!SECURITIES.includes(security)) throw new BoardError('Choose the network’s security.', 'wifi');
        phase('Sending the Wi-Fi network to the board.');
        // The command holds the passphrase: its name only is ever shown.
        await expectOk(`WIFI_SEC|${ssid}|${security}|${passphrase}`, timing.wifi, 'WIFI_SEC');
      }

      const needsIdentity = newIdentity || status['private key'] !== 'set' || status.certificate !== 'set';
      if (needsIdentity) {
        phase('The board is making its own key pair. The private key never leaves it.');
        const replace = status['private key'] === 'set';
        const { lines, final } = await link.command(replace ? 'KEYGEN|REPLACE' : 'KEYGEN', timing.keygen);
        if (!final.startsWith('OK'))
          throw new BoardError(`The board did not make its key: ${final.slice(4)}`, 'keygen');
        const text = lines.join('\n');
        const match = /-----BEGIN CERTIFICATE REQUEST-----[\s\S]*?-----END CERTIFICATE REQUEST-----/.exec(text);
        if (!match) throw new BoardError('The board did not print a certificate signing request.', 'keygen');
        phase('Registering the board with the console.');
        const answer = checkRegistration(
          await api.registerDevice({
            id: thing.slice(THING_PREFIX.length),
            csr: `${match[0]}\n`,
            reregister: replace || newIdentity,
          }),
          thing
        );
        const rootCa = pemToDer(answer.rootCa);
        if ((await sha256Hex(subtle, rootCa)) !== ROOT_CA_SHA256)
          throw new BoardError(
            'The console’s root CA is not Amazon Root CA 1. Nothing was loaded onto the board.',
            'register'
          );
        phase('Loading the certificate onto the board.');
        await loadCertificate(pemToDer(answer.certificatePem), 'CERT');
        phase('Loading Amazon Root CA 1 onto the board.');
        await loadCertificate(rootCa, 'CA');
        phase('Storing the cloud settings on the board.');
        await expectOk(`CLOUD|${answer.endpoint}|${answer.downloadPrefix}`, timing.wifi, 'CLOUD');
      }
      status = await readStatus();
      flow.board = identifyFrom(status);
      return {
        note: needsIdentity
          ? 'The board has its network, its certificate and its cloud settings.'
          : 'The board had its certificate already.',
      };
    });
  }

  async function expectOk(line, wait, name = line.split('|', 1)[0]) {
    const { final } = await link.command(line, wait);
    if (!final.startsWith('OK')) throw new BoardError(`The board refused ${name}: ${final.slice(4)}`, 'refused');
  }

  async function loadCertificate(der, kind) {
    const chunks = [];
    for (let at = 0; at < der.length; at += CERT_CHUNK) chunks.push(der.subarray(at, at + CERT_CHUNK));
    const crc = crc16CcittFalse(der).toString(16).padStart(4, '0');
    await expectOk(`STREAM_START|${der.length}|${chunks.length}|${crc}|${kind}`, timing.wifi, 'STREAM_START');
    for (const [index, chunk] of chunks.entries()) {
      phase(`Loading the ${kind === 'CA' ? 'root CA' : 'certificate'} onto the board.`, {
        sent: index + 1,
        total: chunks.length,
      });
      await expectOk(`STREAM_CHUNK|${index}|${toBase64(chunk)}`, timing.chunk, 'STREAM_CHUNK');
    }
  }

  // Online.

  async function online() {
    requireBoard();
    const thing = flow.board.thing;
    const deadline = now() + timing.online;
    while (now() < deadline) {
      phase('Waiting for the console to see the board online.');
      try {
        const detail = await api.device(thing);
        if (detail?.device?.online) return { note: `${thing} is online on the console.` };
      } catch {
        // Not listed yet, or the network hiccuped. The deadline is what counts.
      }
      await sleep(timing.poll);
    }
    let said = '';
    try {
      const status = await readStatus();
      said = status.cloud
        ? ` The board says its cloud is ${status.cloud}, and its Wi-Fi link is ${status['wifi link'] ?? 'not known'}.`
        : '';
    } catch {
      said = '';
    }
    throw new BoardError(
      `The board is set up, but the console has not seen it online yet.${said} Check the Wi-Fi network's name and passphrase (Set up, again), and that the network is on.`,
      'offline'
    );
  }

  /**
   * Put the console's Wi-Fi defaults into the empty fields of the form: `fill({ ssid, passphrase, security })`
   * does that, and nothing here keeps them.
   */
  async function fillWifiDefaults(fill) {
    if (flow.wifiDefaults.state !== 'idle' || typeof api?.wifiDefaults !== 'function') return;
    flow.wifiDefaults = { state: 'loading', problem: null };
    let wifi = null;
    try {
      wifi = await api.wifiDefaults();
    } catch (error) {
      flow.wifiDefaults = { state: 'failed', problem: words(error) };
      changed();
      return;
    }
    if (!wifi) {
      flow.wifiDefaults = { state: 'none', problem: null };
      changed();
      return;
    }
    fill(wifi);
    wifi.passphrase = '';
    flow.wifiDefaults = { state: 'filled', problem: null };
    changed();
  }

  // The stepper's controls.

  function requireBoard() {
    if (!link || !flow.board || flow.board.blank) throw new BoardError('Connect to a board first.', 'no-board');
  }

  const WORK = { golden, firmware, online };

  async function run(key) {
    if (key === 'connect') return connect();
    if (key === 'setup' || !WORK[key]) return undefined;
    return step(key, WORK[key]);
  }

  function retry(key) {
    return run(key);
  }

  function skip(key) {
    if (flow.busy || key === 'connect' || !flow.board || flow.board.blank) return;
    if (key === 'golden') flow.seal = { watching: false, lines: [], result: null, problem: null, waiting: false };
    set(key, 'skipped', { note: 'Skipped: done already.' });
    advance(key);
  }

  async function closeLinks() {
    const closing = [link, logLink].filter(Boolean);
    link = null;
    logLink = null;
    await Promise.all(closing.map((item) => item.close()));
  }

  async function disconnect() {
    await closeLinks();
    flow.steps = initialSteps();
    flow.current = 'connect';
    flow.board = null;
    flow.release = null;
    flow.phase = null;
    flow.progress = null;
    flow.seal = { watching: false, lines: [], result: null, problem: null, waiting: false };
    flow.wifiDefaults = { state: 'idle', problem: null };
    changed();
  }

  return flow;
}

function label(type) {
  return BOARD_LABELS[type] ?? type ?? 'board';
}

// The page.

let shared = null;
let connected = null;

/** app.js hands over the console's API and its redraw, once. */
export function connect({ api, draw }) {
  connected = { api, draw };
}

function sharedFlow() {
  shared ??= createSetupFlow({
    serial: globalThis.navigator?.serial ?? null,
    api: connected?.api,
    subtle: globalThis.crypto?.subtle,
    onChange: () => connected?.draw(),
  });
  return shared;
}

const LEDE =
  'Plug a board in by USB and take it from what it has to online on the console: the golden image, the newest ' +
  'firmware, its ID, its Wi-Fi network and its certificate. For release managers, in Chrome or Edge on a computer, ' +
  'or in the desktop app.';

const STATUS_WORDS = {
  todo: 'To do',
  running: 'Under way',
  waiting: 'Your turn',
  done: 'Done',
  skipped: 'Skipped',
  failed: 'Stopped',
};
const STATUS_ICONS = { done: 'check', skipped: 'minus', failed: 'x', waiting: 'alert', running: 'clock' };

function explained(title, text, command) {
  return h(
    'div',
    { class: 'page', key: 'page' },
    developerTabs('setup'),
    pageHead({ title: 'Board setup', lede: LEDE }),
    h('section', { class: 'card', key: 'why' }, empty({ iconName: 'lock', title, text, command }))
  );
}

const field = (id) => globalThis.document?.getElementById(id) ?? null;

function boardFacts(flow) {
  const board = flow.board;
  if (!board || board.blank) return null;
  const rows =
    board.app === 'console'
      ? [
          ['Board', label(board.type)],
          ['Thing', mono(board.thing ?? '')],
          ['Firmware', mono(board.firmware ?? 'not known')],
          ['State', board.state === 'FACTORY' ? 'FACTORY: not set up yet' : (board.state ?? 'not known')],
          ['Bootloader', 'This project’s: it started this project’s signed firmware'],
        ]
      : [
          ['Board', label(board.type)],
          ['Firmware', board.app === 'shell' ? 'From before the console' : 'None runs'],
          ['Bootloader', board.app === 'none' ? 'Listening for serial recovery' : 'Not known'],
        ];
  return h('section', { class: 'card setup-board', key: 'board', 'aria-label': 'The board' }, facts(rows));
}

function progressOf(flow) {
  if (!flow.progress) return null;
  const { sent, total } = flow.progress;
  const percent = total ? Math.floor((sent * 100) / total) : 0;
  return h(
    'div',
    { class: 'setup-progress', key: 'progress' },
    meter(percent, flow.phase ?? 'Progress'),
    h('p', { class: 'field-hint' }, `${percent} %`)
  );
}

function stepTools(flow, key, status) {
  const busy = flow.busy;
  const start = {
    connect: 'Connect',
    golden: 'Put the golden image on',
    firmware: 'Put the newest firmware on',
    online: 'Wait for it online',
  }[key];
  const tools = [];
  // Set up's form is its own way to try again.
  if (status === 'failed' && key !== 'setup') tools.push(button('is-primary', () => flow.retry(key), 'Try again'));
  else if (start && key !== 'setup' && status !== 'waiting')
    tools.push(button('is-primary', () => flow.run(key), start));
  if (key !== 'connect' && flow.board && !flow.board.blank)
    tools.push(button('is-quiet', () => flow.skip(key), 'Skip: done already'));
  return busy ? null : h('div', { class: 'setup-tools', key: 'tools' }, tools);
}

function sealPanel(flow) {
  if (!flow.seal.waiting) return null;
  return h(
    'div',
    { class: 'setup-seal', key: 'seal' },
    notice(
      'warn',
      'alert',
      'Only on a board flashed with this project’s bootloader. On an older one, holding Button 2 while the firmware starts is a factory reset.'
    ),
    h(
      'p',
      { class: 'setup-text' },
      'First choose the board’s other port, its log port, so that this page can watch the bootloader. Then, at the board:'
    ),
    h(
      'ol',
      { class: 'setup-gesture' },
      BUTTON_STEPS.map((text, index) => h('li', { key: String(index) }, text))
    ),
    h(
      'p',
      { class: 'field-hint' },
      'LED1 stays on while it copies, for about 45 seconds, and the board then runs 1.5.0. The log port is the one ' +
        'ending in 1 on a Mac, the lower ttyACM on Linux, and the other COM port on Windows.'
    ),
    flow.seal.lines.length
      ? h(
          'pre',
          { class: 'code setup-log', key: 'log' },
          flow.seal.lines.map((line) => `bootloader: ${line}\n`)
        )
      : null,
    flow.seal.problem ? notice('warn', 'alert', flow.seal.problem) : null,
    h(
      'div',
      { class: 'setup-tools' },
      flow.seal.watching
        ? h('p', { class: 'field-hint' }, 'Watching the log port for 4 minutes. Do the gesture now.')
        : button('is-primary', () => flow.watchSeal(), 'Choose the log port and watch'),
      button('is-quiet', () => flow.sealedByHand(), 'It sealed: I saw it')
    )
  );
}

function setupForm(flow) {
  const status = flow.board?.status ?? {};
  const factory = status.state === 'FACTORY';
  const thing = flow.board?.thing ?? '';
  const hasNetwork = status['wifi password'] === 'set';
  const hasIdentity = status['private key'] === 'set' && status.certificate === 'set';
  const submit = () => {
    const passField = field('setup-passphrase');
    const values = {
      id: field('setup-id')?.value.trim() ?? '',
      ssid: field('setup-ssid')?.value ?? '',
      security: field('setup-security')?.value ?? SECURITIES[0],
      passphrase: passField?.value ?? '',
      keepWifi: hasNetwork && field('setup-replace-wifi')?.checked !== true,
      newIdentity: field('setup-new-identity')?.checked === true,
    };
    // Gone from the page as soon as it is on its way. A second try fills it again from the defaults.
    if (passField) passField.value = '';
    flow.wifiDefaults = { state: 'idle', problem: null };
    const done = flow.runSetup(values);
    values.passphrase = '';
    return done;
  };
  if (flow.wifiDefaults.state === 'idle') queueMicrotask(() => flow.fillWifiDefaults(fillFields));
  return h(
    'form',
    {
      class: 'setup-form',
      key: 'form',
      autocomplete: 'off',
      onSubmit: (event) => {
        event.preventDefault();
        submit();
      },
    },
    factory
      ? h(
          'div',
          { class: 'field', key: 'id' },
          h('label', { class: 'field-label', for: 'setup-id' }, 'Board ID'),
          h('input', {
            id: 'setup-id',
            class: 'input mono',
            type: 'text',
            placeholder: thing.slice(THING_PREFIX.length),
            autocomplete: 'off',
            autocapitalize: 'none',
            spellcheck: 'false',
            'aria-describedby': 'setup-id-hint',
          }),
          h(
            'p',
            { class: 'field-hint', id: 'setup-id-hint' },
            '1 to 32 letters or digits. Left empty, its chip’s identifier.'
          )
        )
      : null,
    hasNetwork
      ? h(
          'label',
          { class: 'choice', key: 'replace-wifi' },
          h('input', { id: 'setup-replace-wifi', type: 'checkbox' }),
          h(
            'span',
            { class: 'choice-body' },
            h('span', { class: 'choice-title' }, 'Replace its network'),
            ' It has one. Left unticked, it keeps it, and the fields below are not used.'
          )
        )
      : null,
    h(
      'div',
      { class: 'field', key: 'ssid' },
      h('label', { class: 'field-label', for: 'setup-ssid' }, 'Wi-Fi network name'),
      h('input', {
        id: 'setup-ssid',
        class: 'input',
        type: 'text',
        autocomplete: 'off',
        autocapitalize: 'none',
        spellcheck: 'false',
        'aria-describedby': 'setup-ssid-hint',
      }),
      h(
        'p',
        { class: 'field-hint', id: 'setup-ssid-hint' },
        'Exactly as the network spells it: a phone’s hotspot often has a curly apostrophe.'
      )
    ),
    h(
      'div',
      { class: 'field', key: 'security' },
      h('label', { class: 'field-label', for: 'setup-security' }, 'Security'),
      h(
        'select',
        { id: 'setup-security', class: 'input mono' },
        SECURITIES.map((choice) => h('option', { key: choice, value: choice }, choice))
      )
    ),
    h(
      'div',
      { class: 'field', key: 'pass' },
      h('label', { class: 'field-label', for: 'setup-passphrase' }, 'Passphrase'),
      h('input', {
        id: 'setup-passphrase',
        class: 'input',
        type: 'password',
        autocomplete: 'new-password',
        'aria-describedby': 'setup-pass-hint',
      }),
      h('p', { class: 'field-hint', id: 'setup-pass-hint' }, `8 to 63 characters. ${WORDS.wifiOnly}`)
    ),
    wifiDefaultsNote(flow),
    hasIdentity
      ? h(
          'label',
          { class: 'choice', key: 'identity' },
          h('input', { id: 'setup-new-identity', type: 'checkbox' }),
          h(
            'span',
            { class: 'choice-body' },
            h('span', { class: 'choice-title' }, 'Give it a new key and certificate'),
            ' The console retires the one it has.'
          )
        )
      : null,
    h(
      'div',
      { class: 'setup-tools' },
      h('button', { type: 'submit', class: 'btn is-primary', disabled: flow.busy }, 'Set it up')
    )
  );
}

/** The console's Wi-Fi defaults into the fields that are still empty: what the person typed stays. */
function fillFields({ ssid, passphrase, security }) {
  const name = field('setup-ssid');
  const pass = field('setup-passphrase');
  const kind = field('setup-security');
  if (name && !name.value) name.value = ssid;
  if (pass && !pass.value) pass.value = passphrase;
  if (kind && SECURITIES.includes(security)) kind.value = security;
}

function wifiDefaultsNote(flow) {
  const { state, problem } = flow.wifiDefaults;
  if (state === 'filled') return h('p', { class: 'field-hint', key: 'defaults' }, WORDS.wifiFilled);
  if (state === 'none') return h('p', { class: 'field-hint', key: 'defaults' }, WORDS.wifiNone);
  if (state === 'failed')
    return h('p', { class: 'field-hint', key: 'defaults' }, `The console’s Wi-Fi defaults: ${problem}`);
  return null;
}

function stepBody(flow, key, state) {
  const parts = [];
  if (key === 'connect' && state.status !== 'done')
    parts.push(
      h(
        'p',
        { class: 'setup-text', key: 'what' },
        'Choose the board’s console port: on an nRF7002 DK, the one ending in 3 on a Mac, the higher ttyACM on Linux. ' +
          'Close the Serial console page and any other program that has it open.'
      )
    );
  if (key === 'golden' && ['todo', 'failed'].includes(state.status))
    parts.push(
      h(
        'p',
        { class: 'setup-text', key: 'what' },
        `Puts the golden image ${GOLDEN.version} into the running slot through serial recovery, about 4 minutes, checked first ` +
          'against firmware/golden.json. You then seal it with a gesture at the board: the bootloader copies it to external flash, ' +
          'where the rescue gesture can always restore it. It goes on before the newest firmware, which it would replace.'
      )
    );
  if (key === 'firmware' && ['todo', 'failed'].includes(state.status))
    parts.push(
      h(
        'p',
        { class: 'setup-text', key: 'what' },
        'Puts the console’s newest active release for this board’s type on it the same way, checked against its SHA-256 first.'
      )
    );
  if (key === 'online' && ['todo', 'failed'].includes(state.status))
    parts.push(
      h('p', { class: 'setup-text', key: 'what' }, 'Waits up to 3 minutes for the console to see the board online.')
    );
  if (state.status === 'running' && flow.phase)
    parts.push(h('p', { class: 'setup-phase', key: 'phase', role: 'status' }, flow.phase));
  if (state.status === 'running') parts.push(progressOf(flow));
  if (state.error) parts.push(notice('bad', 'alert', state.error));
  if (key === 'golden' && state.status === 'waiting') parts.push(sealPanel(flow));
  if (key === 'setup' && ['todo', 'failed'].includes(state.status) && flow.current === 'setup')
    parts.push(setupForm(flow));
  if (state.status !== 'running') parts.push(stepTools(flow, key, state.status));
  return parts;
}

function stepper(flow) {
  return h(
    'ol',
    { class: 'setup-steps', key: 'steps', 'aria-label': 'Steps' },
    STEPS.map(({ key, title }, index) => {
      const state = flow.steps[key];
      const open = flow.current === key || state.status === 'failed' || state.status === 'waiting';
      return h(
        'li',
        {
          key,
          class: `setup-step is-${state.status}${flow.current === key ? ' is-current' : ''}`,
          'aria-current': flow.current === key ? 'step' : null,
        },
        h(
          'span',
          { class: 'setup-mark' },
          STATUS_ICONS[state.status] ? icon(STATUS_ICONS[state.status]) : String(index + 1)
        ),
        h(
          'div',
          { class: 'setup-step-text' },
          h(
            'h2',
            { class: 'setup-step-title' },
            title,
            h('span', { class: 'setup-step-state' }, ` · ${STATUS_WORDS[state.status]}`)
          ),
          state.note ? h('p', { class: 'setup-note' }, state.note) : null,
          open ? stepBody(flow, key, state) : null
        )
      );
    })
  );
}

/** The page. `flow` is given by the tests; otherwise the tab has one. */
export function setupView(ctx, flow) {
  if (!ctx.state.me?.canWrite) {
    return explained(
      'Board setup is for release managers.',
      'It writes firmware to a board, gives it a certificate and registers it in AWS IoT, so a viewer does not get ' +
        'its controls. Ask a release manager to set up the board, or to add you to their group.'
    );
  }
  if (!flow && !globalThis.navigator?.serial) {
    const app = appPlatform(globalThis);
    if (app) return explained(APP_WORDS.title, APP_WORDS[app]);
    return explained('This browser cannot reach a serial port.', WORDS.noSerial);
  }
  const current = flow ?? sharedFlow();
  return h(
    'div',
    { class: 'page setup-page', key: 'page' },
    developerTabs('setup'),
    pageHead({
      title: 'Board setup',
      lede: LEDE,
      tools: h(
        'div',
        { class: 'setup-tools', key: 'head-tools' },
        button('is-quiet', () => startSelfCheck(), selfCheck.running ? 'Self-check under way' : 'Self-check, no board'),
        current.board ? button('is-quiet', () => current.disconnect(), 'Start over') : null
      ),
    }),
    selfCheckCard(),
    notice('warn', 'alert', 'A board with nothing on it needs the debug probe once.', {
      more: h('span', { class: 'notice-more' }, ` ${WORDS.probe}`),
    }),
    boardFacts(current),
    stepper(current)
  );
}

/** The phone app this page is in, from its bridge's transport (bridge.js findTransport), or null. */
export function appPlatform(win) {
  if (win?.webkit?.messageHandlers?.cranium) return 'ios';
  if (win?.craniumNative) return 'android';
  return null;
}

// The self-check: the flow against a simulated board, with no board and no change on the console.

/** Amazon Root CA 1 (firmware/certs/AmazonRootCA1.pem), for the simulated register route's answer. */
export const AMAZON_ROOT_CA1 = `-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsF
ADA5MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6
b24gUm9vdCBDQSAxMB4XDTE1MDUyNjAwMDAwMFoXDTM4MDExNzAwMDAwMFowOTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJv
b3QgQ0EgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALJ4gHHKeNXj
ca9HgFB0fW7Y14h29Jlo91ghYPl0hAEvrAIthtOgQ3pOsqTQNroBvo3bSMgHFzZM
9O6II8c+6zf1tRn4SWiw3te5djgdYZ6k/oI2peVKVuRF4fn9tBb6dNqcmzU5L/qw
IFAGbHrQgLKm+a/sRxmPUDgH3KKHOVj4utWp+UhnMJbulHheb4mjUcAwhmahRWa6
VOujw5H5SNz/0egwLX0tdHA114gk957EWW67c4cX8jJGKLhD+rcdqsq08p8kDi1L
93FcXmn/6pUCyziKrlA4b9v7LWIbxcceVOF34GfID5yHI9Y/QCB/IIDEgEw+OyQm
jgSubJrIqg0CAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC
AYYwHQYDVR0OBBYEFIQYzIU07LwMlJQuCFmcx7IQTgoIMA0GCSqGSIb3DQEBCwUA
A4IBAQCY8jdaQZChGsV2USggNiMOruYou6r4lK5IpDB/G/wkjUu0yKGX9rbxenDI
U5PMCCjjmCXPI6T53iHTfIUJrU6adTrCC2qJeHZERxhlbI1Bjjt/msv0tadQ1wUs
N+gDS63pYaACbvXy8MWy7Vu33PqUXHeeE6V/Uq2V8viTO96LXFvKWlJbYK8U90vv
o/ufQJVtMVT8QtPHRh8jrdkPSHCa2XV4cdFyQzR1bldZwgJcJmApzyMZFo6IQ6XU
5MsI+yMRQ+hDKXJioaldXgjUkK642M4UwtBV8ob2xJNDd2ZhwLnoQdeXeGADbkpy
rqXRfboQnoZsG4q5WTP468SQvvG5
-----END CERTIFICATE-----
`;

const SIM_THING = 'cranium-5e1fc4ec000000aa';
const SIM_LINE_END = '\r\n';

/**
 * A board on its console port, simulated: the firmware's console (one command a line, refusing a line over
 * CONSOLE_LINE_MAX bytes or with a control character) and MCUboot's serial recovery (lines of at most
 * BOOT_LINE_MAX bytes, requests of at most BOOT_RECEIVE_MAX). `board.port` is what navigator.serial hands out.
 */
export function simulatedBoard({ firmware = '1.14.0+0', state = 'FACTORY' } = {}) {
  let source = null;
  let pending = [];
  const requests = createSmpReader();
  const encoder = new TextEncoder();
  const board = {
    mode: 'app',
    firmware,
    state,
    id: '',
    echo: true,
    lines: [],
    problems: [],
    wifi: null,
    key: false,
    stream: null,
    loaded: {},
    cloud: null,
    slot: null,
    port: null,
  };
  const say = (lines) => source?.enqueue(encoder.encode(lines.map((line) => `${line}${SIM_LINE_END}`).join('')));

  function status() {
    const row = (key, value) => `${key.padEnd(14)} ${value}`;
    return [
      row('state', board.state),
      row('id', board.id),
      row('thing name', SIM_THING),
      row('firmware', board.firmware),
      row('board', 'nrf7002dk'),
      row('layout', 1),
      row('wifi password', board.wifi ? 'set' : 'unset'),
      row('wifi link', board.wifi ? 'up' : 'down'),
      row('cloud', board.cloud ? 'connected' : 'not connected'),
      row('root CA', board.loaded.CA ? 'set' : 'unset'),
      row('private key', board.key ? 'set' : 'unset'),
      row('certificate', board.loaded.CERT ? 'set' : 'unset'),
    ];
  }

  function restart(into = 'app') {
    board.mode = 'restarting';
    setTimeout(() => {
      board.mode = into;
      board.echo = true;
      if (into === 'app') say(['[BOOT] started']);
    }, 5);
  }

  function console_(bytes) {
    const line = new TextDecoder().decode(Uint8Array.from(bytes));
    if (bytes.some((byte) => byte < 0x20 && byte !== 0x09))
      return say(['ERR line discarded, it held a control character']);
    if (bytes.length > CONSOLE_LINE_MAX) {
      board.problems.push(`a console line of ${bytes.length} bytes`);
      return say([`ERR line too long, the limit is ${CONSOLE_LINE_MAX} bytes`]);
    }
    if (line === '') return undefined;
    board.lines.push(line.split('|', 1)[0]);
    if (board.echo) say([line]);
    const [name, ...args] = line.split('|');
    switch (name) {
      case 'ECHO':
        board.echo = args[0] !== 'OFF';
        return say([`OK echo ${String(args[0]).toLowerCase()}`]);
      case 'GET_ID':
        return say([`OK ${board.id}|${board.firmware}`]);
      case 'THING':
        return say([`OK ${SIM_THING}`]);
      case 'STATUS':
        if (board.state === 'FACTORY') return say(['ERR factory mode: run INIT|<id> first']);
        return say([...status(), 'OK']);
      case 'ENTER_BOOTLOADER':
        return restart('bootloader');
      case 'INIT':
        board.id = args[0];
        board.state = 'OPERATING';
        say([`OK initialized as ${args[0]}, restarting`]);
        return restart();
      case 'WIFI_SEC':
        board.wifi = { ssid: args[0], security: args[1] };
        return say([`OK saved, connecting to ${args[0]}`]);
      case 'KEYGEN':
        board.key = true;
        return say([
          '-----BEGIN CERTIFICATE REQUEST-----',
          'MIIBHjCBxAIBADBiMQswCQYDVQQGEwJVUzEQMA4GA1UECgwHQ3Jhbml1bTEhMB8G',
          '-----END CERTIFICATE REQUEST-----',
          'OK key created',
        ]);
      case 'STREAM_START':
        board.stream = { size: Number(args[0]), count: Number(args[1]), crc: args[2], kind: args[3], parts: [] };
        return say(['OK ready']);
      case 'STREAM_CHUNK': {
        const binary = atob(args[1]);
        board.stream.parts.push(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
        if (board.stream.parts.length === board.stream.count) {
          const whole = new Uint8Array(board.stream.parts.reduce((sum, part) => sum + part.length, 0));
          let at = 0;
          for (const part of board.stream.parts) {
            whole.set(part, at);
            at += part.length;
          }
          const crc = crc16CcittFalse(whole).toString(16).padStart(4, '0');
          if (whole.length !== board.stream.size || crc !== board.stream.crc) return say(['ERR crc mismatch']);
          board.loaded[board.stream.kind] = whole;
        }
        return say(['OK chunk']);
      }
      case 'CLOUD':
        board.cloud = { endpoint: args[0], prefix: args[1] };
        return say(['OK cloud settings saved']);
      default:
        return say(['ERR unknown command']);
    }
  }

  function bootloader(request) {
    const answer = (body) => {
      const packet = smpPacket({
        op: request.op + 1,
        group: request.group,
        id: request.id,
        sequence: request.sequence,
        body,
      });
      for (const line of frameLines(packet)) source?.enqueue(line);
    };
    if (request.group === 0 && request.id === 0) return answer({ r: request.body.d });
    if (request.group === 1 && request.id === 1) {
      const { off, data } = request.body;
      if (off === 0) board.slot = new Uint8Array(request.body.len);
      if (!board.slot || off + data.length > board.slot.length) return answer({ rc: 3 });
      board.slot.set(data, off);
      return answer({ rc: 0, off: off + data.length });
    }
    if (request.group === 0 && request.id === 5) {
      answer({ rc: 0 });
      board.firmware = parseImage(board.slot).version;
      return restart();
    }
    return answer({ rc: 8 });
  }

  function take(bytes) {
    if (bytes.length === 0) return;
    const smp = bytes[0] === 0x06 || bytes[0] === 0x04;
    if (board.mode === 'bootloader' && smp) {
      // Its newline counts: the line held BOOT_LINE_MAX bytes at most.
      if (bytes.length + 1 > BOOT_LINE_MAX) {
        board.problems.push(`a recovery line of ${bytes.length + 1} bytes`);
        return;
      }
      const request = requests.feed(Uint8Array.from(bytes));
      if (request) {
        const size = cborSize(request);
        if (size > BOOT_RECEIVE_MAX) board.problems.push(`a recovery request of ${size} bytes`);
        else bootloader(request);
      }
      return;
    }
    if (board.mode === 'app') console_(bytes);
  }

  // A request's size as the bootloader receives it, near enough: its image data and 64 bytes of the rest.
  const cborSize = (request) => (request.body?.data?.length ?? 0) + 64;

  board.port = {
    readable: new ReadableStream({
      start(controller) {
        source = controller;
      },
    }),
    writable: new WritableStream({
      write(chunk) {
        for (const byte of chunk) {
          if (byte === 0x0a || byte === 0x0d) {
            take(pending);
            pending = [];
          } else pending.push(byte);
        }
      },
    }),
    open: async () => {},
    close: async () => {},
    getInfo: () => ({ usbVendorId: SEGGER_VENDOR_ID }),
  };
  return board;
}

/** A signed-looking MCUboot image for the self-check: header, body and a TLV area with a hash. */
async function simulatedImage(subtle, version, bodySize = 4096) {
  const [major, minor, revision, build] = version.split(/[.+]/).map(Number);
  const image = new Uint8Array(32 + bodySize + 40);
  const view = new DataView(image.buffer);
  view.setUint32(0, 0x96f3b83d, true);
  view.setUint16(8, 32, true);
  view.setUint32(12, bodySize, true);
  image[20] = major;
  image[21] = minor;
  view.setUint16(22, revision, true);
  view.setUint32(24, build, true);
  for (let at = 32; at < 32 + bodySize; at += 1) image[at] = (at * 31) & 0xff;
  const digest = new Uint8Array(await subtle.digest('SHA-256', image.subarray(0, 32 + bodySize)));
  const tlv = 32 + bodySize;
  view.setUint16(tlv, 0x6907, true);
  view.setUint16(tlv + 2, 40, true);
  image[tlv + 4] = 0x10;
  view.setUint16(tlv + 6, 32, true);
  image.set(digest, tlv + 8);
  return image;
}

/**
 * Run the flow end to end against simulatedBoard() and a simulated API: connect, the golden image (sealed by
 * hand), a release, setup and online. `golden(file)` is the real golden image (the console's /golden/ file).
 * Resolves to [{ name, ok, detail }]. Nothing reaches a board or changes the console.
 */
export async function runSelfCheck({ golden, subtle = globalThis.crypto?.subtle, timing = SELF_CHECK_TIMING } = {}) {
  const results = [];
  const note = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });
  const board = simulatedBoard();
  const release = await simulatedImage(subtle, '9.9.9+0');
  const certificate = `-----BEGIN CERTIFICATE-----\n${toBase64(release.subarray(0, 600)).replace(/.{64}/g, '$&\n')}\n-----END CERTIFICATE-----\n`;
  const api = {
    firmware: async () => ({
      releases: [
        {
          version: '9.9.9+0',
          status: 'active',
          sha256: await sha256Hex(subtle, release),
          size: release.length,
          board: 'nrf7002dk',
          layout: 1,
        },
      ],
    }),
    image: async () => release.slice(),
    golden: async (file) => golden(file),
    registerDevice: async () => ({
      thing: SIM_THING,
      certificatePem: certificate,
      rootCa: AMAZON_ROOT_CA1,
      endpoint: 'self-check.example.invalid',
      downloadPrefix: 'https://self-check.example.invalid/firmware/',
    }),
    device: async (thing) => ({ device: { thing, online: true } }),
    wifiDefaults: async () => null,
  };
  const serial = { requestPort: async () => board.port };
  const flow = createSetupFlow({ serial, api, subtle, timing });
  const stepOk = (key) => ['done', 'skipped'].includes(flow.steps[key].status);
  const said = (key) => flow.steps[key].error ?? flow.steps[key].note ?? '';
  try {
    await flow.connect();
    note('Connect: STATUS, or GET_ID and THING in factory mode', stepOk('connect'), said('connect'));
    if (stepOk('connect')) {
      await flow.run('golden');
      const waiting = flow.steps.golden.status === 'waiting';
      note('Golden image: ENTER_BOOTLOADER, serial recovery, the restart', waiting, said('golden'));
      if (waiting) await flow.sealedByHand();
      await flow.run('firmware');
      note('Newest firmware: the same way, checked against its SHA-256', stepOk('firmware'), said('firmware'));
      await flow.runSetup({
        id: 'SELFCHECK1',
        ssid: 'Self-check network',
        security: 'WPA2_PSK',
        passphrase: 'self-check-only',
      });
      note('Set up: INIT, WIFI_SEC, KEYGEN, the certificate, the root CA, CLOUD', stepOk('setup'), said('setup'));
      const loaded = board.loaded.CA && (await sha256Hex(subtle, board.loaded.CA)) === ROOT_CA_SHA256;
      note('The board holds Amazon Root CA 1 and a certificate, by their checksums', loaded && board.loaded.CERT, '');
      if (stepOk('setup')) await flow.run('online');
      note('Online: the console sees the board', stepOk('online'), said('online'));
    }
  } catch (error) {
    note('The self-check itself', false, error?.message ?? String(error));
  } finally {
    await flow.disconnect();
  }
  note(
    'Every line within the board’s limits: console lines, recovery lines and requests',
    board.problems.length === 0,
    board.problems.slice(0, 3).join('; ')
  );
  return results;
}

const selfCheck = { running: false, results: null };

async function startSelfCheck() {
  if (selfCheck.running) return;
  selfCheck.running = true;
  selfCheck.results = null;
  connected?.draw();
  try {
    selfCheck.results = await runSelfCheck({ golden: (file) => connected.api.golden(file) });
  } catch (error) {
    selfCheck.results = [{ name: 'The self-check itself', ok: false, detail: error?.message ?? String(error) }];
  }
  selfCheck.running = false;
  connected?.draw();
}

function selfCheckCard() {
  if (!selfCheck.running && !selfCheck.results) return null;
  const rows = selfCheck.results ?? [];
  return h(
    'section',
    { class: 'card setup-board', key: 'self-check', 'aria-label': 'Self-check' },
    h('h2', { class: 'setup-step-title' }, 'Self-check, against a simulated board'),
    selfCheck.running
      ? h('p', { class: 'setup-phase', role: 'status' }, 'Running the steps against a board simulated in this page.')
      : h(
          'ul',
          { class: 'setup-gesture' },
          rows.map((row, index) =>
            h(
              'li',
              { key: String(index) },
              `${row.ok ? 'Passed' : 'Failed'}: ${row.name}${row.detail ? `. ${row.detail}` : ''}`
            )
          )
        )
  );
}
