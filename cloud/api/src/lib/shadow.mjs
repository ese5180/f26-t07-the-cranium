/**
 * Reading a board's shadow.
 *
 * The board writes its state under state.reported:
 *
 *   { "fw":   { "version": "1.0.0+3", "confirmed": true },
 *     "ota":  { "state": "idle", "job": null, "progress": 0, "last": "none", "error": "" },
 *     "wifi": { "rssi": -52 },
 *     "uptime": 1234 }
 *
 * All of it comes from outside the trust boundary. Each field is checked on its own
 * and dropped if it is not exactly what the contract allows; nothing is repaired and
 * nothing is passed through. What the console shows from here is for display only: no
 * decision of the server depends on it.
 *
 * This report is the board's heartbeat: it comes every 30 s, and there is no other message and no
 * last will. A board is online if AWS IoT received its uptime less than 90 s ago, which allows for
 * one late report of a board on 60 s, as the golden image is, but not for one that is lost: that board
 * counts as offline from 90 s until its next report. That time is set by AWS
 * (metadata.reported.uptime.timestamp, in epoch seconds), not by the board.
 *
 * A board that last said `rebooting` gets 240 s. That is the one state in which it goes quiet on
 * purpose, and a real restart takes longer than 90 s: from the report, 20 s of settling and a reply
 * make about 21 s to the reset, the swap takes 81 s, and the first report of the image comes about
 * 113 s after the report. So a board that dies in this state says Restarting for up to 240 s. The
 * other states around a swap have no such gap on the way forward. `verifying` is followed by
 * `rebooting`, and a new image reports as soon as it is on the cloud. A trial that fails goes quiet
 * too, in `testing`, for the swap back, and offline is what that should look like.
 */

import { readGolden } from './golden.mjs';
import { BLUETOOTH_NAME, parseJobId, strictVersion } from './validate.mjs';

export const ONLINE_WINDOW_MS = 90_000;
export const RESTART_WINDOW_MS = 240_000;

// `bluetooth`: a person opened the board's Bluetooth window, for an update from a phone. Cloud
// updates wait until it closes.
const OTA_STATES = Object.freeze([
  'idle',
  'awaiting_user',
  'downloading',
  'verifying',
  'rebooting',
  'testing',
  'bluetooth',
]);
const OTA_RESULTS = Object.freeze(['none', 'succeeded', 'failed', 'rolled_back', 'declined', 'refused', 'cancelled']);
const SHORT_ASCII = /^[\x20-\x7e]{0,64}$/;
// Later than any real timestamp, small enough to stay a valid date in milliseconds.
const MAX_EPOCH_SEC = 99_999_999_999;

/** An own property of a plain object, or undefined. */
function own(value, key) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)
    ? value[key]
    : undefined;
}

function integerIn(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function oneOf(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}

// What else a board reports, each in a message of its own (firmware/README.md):
//
//   { "stuck": { "count": 0, "reason": "none" } }                     with the heartbeat, from 1.7.0
//   { "diary": { "boots": 42, "log": ["1.10.0+0/10/4", ...] } }       on connecting, from 1.7.4
//   { "bt": { "from": "1.5.0+0", "to": "1.6.0+0", "result": "succeeded",
//             "proof": "person", "count": 3 } }                       on connecting, from 1.9.0
//   { "diag": { "mac": "f4:ce:36:12:34:56", "channel": 6,
//               "heap": { "free": 21312, "least": 9840, "size": 44240 } } }   every 5 min, from 1.10.0
//
// From 1.11.4 the diagnostics also carry the board's own name, the device ID that a person
// gave it at its serial console (INIT|<id>, SET_ID|<id>): "diag": { "id": "CRVIHAAN01", ... }.
// The thing name is the board's identity in AWS IoT and never changes; this name only says
// which board it is to a person, and is shown beside the thing name, never in its place.
//
// A stuck reason the console does not know yet is kept if it looks like one: a later firmware
// may add a timer.
const STUCK_REASON = /^[a-z][a-z_]{0,31}$/;
export const BT_RESULTS = Object.freeze([
  'pending',
  'succeeded',
  'rolled_back',
  'not_installed',
  'trial_lost',
  'superseded',
  'flash_error',
]);
export const BT_PROOFS = Object.freeze(['none', 'cloud', 'person']);
const MAC = /^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}$/;
// device_id_valid() in firmware/app/src/device.c: 1 to 32 letters and digits.
export const BOARD_NAME = /^[A-Za-z0-9]{1,32}$/;
// version/cause/stage: the cause in hex, as the firmware prints it with %x.
const DIARY_ENTRY = /^([0-9.+]{5,24})\/([0-9a-f]{1,8})\/(\d{1,3})$/;
const DIARY_MAX = 16;
// Zephyr's RESET_ bits (zephyr/drivers/hwinfo.h). The firmware reports the raw value.
export const RESET_CAUSES = Object.freeze([
  [0x1, 'pin'],
  [0x2, 'software'],
  [0x4, 'brownout'],
  [0x8, 'power_on'],
  [0x10, 'watchdog'],
  [0x20, 'debugger'],
  [0x40, 'security'],
  [0x80, 'wake'],
  [0x100, 'lockup'],
  [0x200, 'parity'],
  [0x400, 'pll'],
  [0x800, 'clock'],
  [0x1000, 'hardware'],
  [0x2000, 'user'],
  [0x4000, 'temperature'],
]);
// Larger than any heap of this board, and still exact in a double.
const MAX_HEAP = 2 ** 31;

/** The names of the reset causes in a cause the diary gives in hex. No bit at all is a power-on. */
export function resetCauses(hex) {
  const value = parseInt(hex, 16);
  if (!Number.isInteger(value) || value === 0) return ['power_on'];
  const names = RESET_CAUSES.filter(([bit]) => (value & bit) !== 0).map(([, name]) => name);
  return names.length > 0 ? names : ['unknown'];
}

function readStuck(reported) {
  const stuck = own(reported, 'stuck');
  const count = integerIn(own(stuck, 'count'), 0, 2 ** 32);
  const reason = own(stuck, 'reason');
  if (count === null || typeof reason !== 'string' || !STUCK_REASON.test(reason)) return null;
  return { count, reason };
}

function readHeap(heap) {
  const free = integerIn(own(heap, 'free'), 0, MAX_HEAP);
  const least = integerIn(own(heap, 'least'), 0, MAX_HEAP);
  const size = integerIn(own(heap, 'size'), 1, MAX_HEAP);
  // A build without heap statistics reports zeros: that is no reading.
  if (free === null || least === null || size === null || free > size || least > size) return null;
  return { free, least, size };
}

/** The diagnostics report; `at` is when AWS IoT received it, or null if the shadow does not say. */
function readDiag(reported, metadata) {
  const diag = own(reported, 'diag');
  if (diag === undefined) return null;
  const mac = own(diag, 'mac');
  const result = {
    mac: typeof mac === 'string' && MAC.test(mac) ? mac.toLowerCase() : null,
    channel: integerIn(own(diag, 'channel'), 0, 233),
    heap: readHeap(own(diag, 'heap')),
    at: null,
  };
  if (result.mac === null && result.channel === null && result.heap === null) return null;
  const stamp = own(own(own(metadata, 'diag'), 'channel'), 'timestamp');
  if (Number.isInteger(stamp) && stamp > 0 && stamp <= MAX_EPOCH_SEC) result.at = new Date(stamp * 1000).toISOString();
  return result;
}

/** The board's own name, from its diagnostics, or null if it has not reported one that is valid. */
function readName(reported) {
  const id = own(own(reported, 'diag'), 'id');
  return typeof id === 'string' && BOARD_NAME.test(id) ? id : null;
}

/** The boot diary, newest boot first. Each entry: its version, why the boot before it ended, how far it got. */
function readDiary(reported) {
  const diary = own(reported, 'diary');
  const boots = integerIn(own(diary, 'boots'), 0, 2 ** 32);
  const log = own(diary, 'log');
  if (boots === null || !Array.isArray(log) || log.length > DIARY_MAX) return null;
  const entries = [];
  for (const line of log) {
    const match = typeof line === 'string' ? DIARY_ENTRY.exec(line) : null;
    const version = match ? strictVersion(match[1]) : null;
    if (version === null) continue;
    entries.push({
      version: version.text,
      cause: match[2],
      causes: resetCauses(match[2]),
      stage: Number(match[3]),
    });
  }
  return { boots, entries: entries.reverse() };
}

function readBt(reported) {
  const bt = own(reported, 'bt');
  const from = strictVersion(own(bt, 'from'));
  const to = strictVersion(own(bt, 'to'));
  const result = oneOf(own(bt, 'result'), BT_RESULTS);
  if (from === null || to === null || result === null) return null;
  return {
    from: from.text,
    to: to.text,
    result,
    proof: oneOf(own(bt, 'proof'), BT_PROOFS) ?? 'none',
    count: integerIn(own(bt, 'count'), 0, 2 ** 32) ?? 0,
  };
}

/**
 * What a board says about itself under state.reported, each part checked on its own: its
 * name, the version it runs, its update, its signal and uptime, and the reports beside the
 * heartbeat. `pairing` (btpair) is never read here. `metadata` is metadata.reported, if there is one.
 */
export function readReported(reported, metadata) {
  const result = {
    name: null,
    fw: null,
    ota: null,
    rssi: null,
    uptime: null,
    stuck: null,
    diag: null,
    diary: null,
    bt: null,
  };
  if (reported === undefined || reported === null || typeof reported !== 'object' || Array.isArray(reported)) {
    return result;
  }
  const fw = own(reported, 'fw');
  const version = strictVersion(own(fw, 'version'));
  if (version !== null) result.fw = { version: version.text, confirmed: own(fw, 'confirmed') === true };

  const ota = own(reported, 'ota');
  const state = oneOf(own(ota, 'state'), OTA_STATES);
  if (state !== null) {
    const error = own(ota, 'error');
    result.ota = {
      state,
      // AWS deletes a key whose value is null, so no job is the usual case.
      job: parseJobId(own(ota, 'job'))?.id ?? null,
      progress: integerIn(own(ota, 'progress'), 0, 100) ?? 0,
      last: oneOf(own(ota, 'last'), OTA_RESULTS) ?? 'none',
      error: typeof error === 'string' && SHORT_ASCII.test(error) ? error : '',
    };
  }

  result.rssi = integerIn(own(own(reported, 'wifi'), 'rssi'), -127, 0);
  result.uptime = integerIn(own(reported, 'uptime'), 0, 2 ** 32);
  result.stuck = readStuck(reported);
  result.name = readName(reported);
  result.diag = readDiag(reported, metadata);
  result.diary = readDiary(reported);
  result.bt = readBt(reported);
  // From firmware 1.22.0, on a board that reports it (lib/golden.mjs): only then is it there at all.
  const golden = readGolden(reported);
  if (golden !== null) result.golden = golden;
  return result;
}

/**
 * The Device for a thing that has never reported. `name` is the board's own name, null until
 * it reports one; `thing` stays what names the board to the API.
 */
export function unknownDevice(thing) {
  return {
    thing,
    name: null,
    online: false,
    lastSeen: null,
    fw: null,
    ota: null,
    rssi: null,
    uptime: null,
    stuck: null,
    diag: null,
    diary: null,
    bt: null,
  };
}

/**
 * Turn a raw shadow document into a Device.
 *
 * @param {string} thing    the thing name, already validated
 * @param {unknown} shadow  the document from GetThingShadow, or null if there is none
 * @param {number} nowMs    the current time in epoch milliseconds
 */
export function deviceFromShadow(thing, shadow, nowMs) {
  const device = unknownDevice(thing);
  const reported = own(own(shadow, 'state'), 'reported');
  if (reported === undefined) return device;
  const metadata = own(own(shadow, 'metadata'), 'reported');
  Object.assign(device, readReported(reported, metadata));

  const seenSec = own(own(metadata, 'uptime'), 'timestamp');
  if (Number.isInteger(seenSec) && seenSec > 0 && seenSec <= MAX_EPOCH_SEC) {
    const seenMs = seenSec * 1000;
    device.lastSeen = new Date(seenMs).toISOString();
    device.online = nowMs - seenMs < (device.ota?.state === 'rebooting' ? RESTART_WINDOW_MS : ONLINE_WINDOW_MS);
  }
  return device;
}

// While a person has a board's Bluetooth window open and a phone is pairing, the board also
// reports the name it advertises and the passkey it shows on its console:
//
//   { "btpair": { "name": "Cranium-1A2B", "passkey": "012345" } }
//
// and clears it when the window closes. A passkey is good for one attempt, in a window of
// 2 minutes, so a report older than this is not handed out, whatever the board last said.
export const PAIRING_NAME = BLUETOOTH_NAME;
export const PAIRING_FRESH_MS = 150_000;
const PASSKEY = /^\d{6}$/;
// How far ahead of this server's clock a report may seem to be.
const CLOCK_SLACK_MS = 30_000;

/**
 * The pairing a board reports, if it is fresh: { name, passkey, reportedAt }, else null.
 * The time is the one AWS IoT stamped on the passkey, not the board's.
 */
export function pairingFromShadow(shadow, nowMs) {
  const pair = own(own(own(shadow, 'state'), 'reported'), 'btpair');
  const name = own(pair, 'name');
  const passkey = own(pair, 'passkey');
  if (typeof name !== 'string' || !PAIRING_NAME.test(name)) return null;
  if (typeof passkey !== 'string' || !PASSKEY.test(passkey)) return null;
  const sec = own(own(own(own(own(shadow, 'metadata'), 'reported'), 'btpair'), 'passkey'), 'timestamp');
  if (!Number.isInteger(sec) || sec <= 0 || sec > MAX_EPOCH_SEC) return null;
  const atMs = sec * 1000;
  if (nowMs - atMs > PAIRING_FRESH_MS || atMs - nowMs > CLOCK_SLACK_MS) return null;
  return { name, passkey, reportedAt: new Date(atMs).toISOString() };
}
