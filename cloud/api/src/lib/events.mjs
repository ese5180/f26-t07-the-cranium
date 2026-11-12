/**
 * The event log of the boards: what each board did, and readings of its signal and memory.
 *
 * Two AWS IoT rules hand messages to the recorder (recorder.mjs, the function EventsFn):
 *
 *   SELECT *, topic(3) AS thing FROM '$aws/things/+/shadow/update/documents'
 *     a board's shadow before and after one of its reports: { previous, current, timestamp }
 *   SELECT * FROM '$aws/events/presence/+/+'
 *     AWS IoT's own word that a client connected or disconnected
 *
 * Everything in them except the times AWS IoT stamped comes from a board, so it is read
 * through lib/shadow.mjs, which checks every field and drops what it does not know. A pairing
 * passkey (btpair) is never read, and so never stored. Of a presence message only the client
 * id, the time, the kind and the reason are kept: never the address or the certificate.
 *
 * What one shadow document becomes is worked out by comparing what the board reported
 * before with what it reports now (changesBetween). Each change is one event:
 *
 *   firmware   the version changed, or the version it runs was confirmed
 *   update     the update moved to another step, or ended with a result
 *   restart    the uptime went down; the boot diary said why; it restarted for being stuck
 *   bluetooth  the Bluetooth window opened or closed; the Bluetooth update record changed
 *   health     the Wi-Fi channel changed; the free memory fell below 15% at least once; the
 *              board reported its name (its device ID, from 1.11.4) for the first time, or another one
 *   connection connected or disconnected (from the presence rule)
 *
 * and every document is also one sample: the signal, the uptime and, from firmware 1.10.0,
 * the heap.
 *
 * Items, in the events table: pk = the thing name, and
 *
 *   sk = "E#<ISO time>#<6 hex>"   an event, kept 90 days
 *   sk = "S#<ISO time>"           a sample, kept 7 days
 *
 * and, from firmware 1.12.0, the lines of each board's console, with sk "L#..." and "K#..."
 * (lib/lines.mjs, the third rule). Every item has
 * `ttl` in epoch seconds, after which DynamoDB deletes the item. The time of an event is
 * the time AWS IoT stamped on the message, to the second for a shadow document. Within its
 * second, an event is placed by the shadow's version (ten milliseconds per version, modulo a
 * hundred) and by its place in the document (a millisecond each), so that two reports in one
 * second, and the events of one report, keep their order. Only the second is shown.
 *
 * No AWS here, and no clock: the caller passes the time and the random digits.
 */

import { BOARD_NAME, readReported } from './shadow.mjs';
import { isThing, parseJobId, strictVersion } from './validate.mjs';

export const KINDS = Object.freeze(['connection', 'firmware', 'update', 'restart', 'bluetooth', 'health']);
export const EVENT_DAYS = 90;
export const SAMPLE_DAYS = 7;
// Below this share of the heap free at its lowest, a board is warned about once per boot.
export const LOW_HEAP_SHARE = 0.15;

const DAY_MS = 86_400_000;
// The time AWS IoT stamped on a message is used if it is within these bounds of the
// recorder's own clock; otherwise the recorder's clock is.
const STAMP_PAST_MS = DAY_MS;
const STAMP_FUTURE_MS = 5 * 60_000;
const MAX_TEXT = 200;

const EVENT_KEY = /^E#(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#([0-9a-f]{6})$/;
const SAMPLE_KEY = /^S#(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;
const RANDOM = /^[0-9a-f]{6}$/;
const WHAT = /^[a-z][a-z_]{0,23}$/;
const WORD = /^[a-z][a-z_]{0,23}$/;
const REASON = /^[A-Z][A-Z_]{0,47}$/;
const SHORT_ASCII = /^[\x20-\x7e]{0,64}$/;
const PRINTABLE = /^[\x20-\x7e]{1,200}$/;
const HEX = /^[0-9a-f]{1,8}$/;
const FAULT_PC = /^0x[0-9a-f]{1,8}$/;
const FAULT_FRAME = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
const OTA_STATES = Object.freeze([
  'idle',
  'awaiting_user',
  'downloading',
  'verifying',
  'rebooting',
  'testing',
  'bluetooth',
]);

// The fields an event may carry, each with the check that it passes on its way in and out.
const int = (min, max) => (value) => Number.isInteger(value) && value >= min && value <= max;
const FIELDS = Object.freeze({
  version: (value) => strictVersion(value)?.text === value,
  from: (value) => strictVersion(value)?.text === value,
  to: (value) => strictVersion(value)?.text === value,
  confirmed: (value) => typeof value === 'boolean',
  job: (value) => parseJobId(value)?.id === value,
  state: (value) => OTA_STATES.includes(value),
  progress: int(0, 100),
  result: (value) => typeof value === 'string' && WORD.test(value),
  error: (value) => typeof value === 'string' && value !== '' && SHORT_ASCII.test(value),
  upFor: int(0, 2 ** 32),
  cause: (value) => typeof value === 'string' && HEX.test(value),
  stage: int(0, 255),
  boots: int(0, 2 ** 32),
  newBoots: int(1, 2 ** 32),
  count: int(0, 2 ** 32),
  reason: (value) => typeof value === 'string' && (WORD.test(value) || REASON.test(value)),
  proof: (value) => typeof value === 'string' && WORD.test(value),
  channel: int(1, 233),
  before: int(1, 233),
  heapLeast: int(0, 2 ** 31),
  heapSize: int(1, 2 ** 31),
  name: (value) => typeof value === 'string' && BOARD_NAME.test(value),
  nameBefore: (value) => typeof value === 'string' && BOARD_NAME.test(value),
  // Where a fault happened, once the firmware reports it with a reboot (docs/own-observability.md, stage 2):
  // the program counter in hex, and the function it was in. Read back and grouped now; sent later.
  pc: (value) => typeof value === 'string' && FAULT_PC.test(value),
  frame: (value) => typeof value === 'string' && FAULT_FRAME.test(value),
});

/** An own property of a plain object, or undefined. */
function own(value, key) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)
    ? value[key]
    : undefined;
}

// Words. What is stored is the text a person reads; the typed fields say the same for a program.

/** "42 s", "5 min", "2 h 14 min", "3 d 4 h". */
export function duration(seconds) {
  const total = Math.floor(seconds);
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

function ordinal(count) {
  const tens = count % 100;
  if (tens >= 11 && tens <= 13) return `${count}th`;
  return `${count}${{ 1: 'st', 2: 'nd', 3: 'rd' }[count % 10] ?? 'th'}`;
}

function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** What a deployment installs, as the job id says: "1.10.0+0", or "an update" for any other job. */
function target(job) {
  return parseJobId(job)?.version ?? null;
}

export const CAUSE_WORDS = Object.freeze({
  pin: 'the reset pin',
  software: 'a software restart',
  brownout: 'a brownout',
  power_on: 'a loss of power',
  watchdog: 'the watchdog',
  debugger: 'the debugger',
  security: 'a security reset',
  wake: 'a wake from off',
  lockup: 'a CPU lockup',
  parity: 'a parity error',
  pll: 'a clock fault',
  clock: 'a clock fault',
  hardware: 'a hardware reset',
  user: 'a user reset',
  temperature: 'a temperature reset',
});
// Causes that say that something went wrong, not that somebody restarted the board.
export const BAD_CAUSES = new Set([
  'brownout',
  'watchdog',
  'lockup',
  'security',
  'parity',
  'pll',
  'clock',
  'hardware',
  'temperature',
]);

const STAGE_WORDS = Object.freeze({
  1: 'started its program',
  2: 'started its update manager',
  3: 'got onto the network',
  4: 'reached the cloud',
});

export const STUCK_WORDS = Object.freeze({
  wifi_silent: 'the Wi-Fi chip stopped answering',
  no_cloud: 'no connection to the cloud for 15 minutes',
  update_stall: 'an update stopped moving',
});

const DISCONNECT_WORDS = Object.freeze({
  CLIENT_INITIATED_DISCONNECT: 'the board closed the connection',
  CONNECTION_LOST: 'the connection was lost',
  MQTT_KEEP_ALIVE_TIMEOUT: 'the board stopped answering',
  DUPLICATE_CLIENTID: 'another connection used its name',
  SERVER_INITIATED_DISCONNECT: 'AWS IoT closed the connection',
  AUTH_ERROR: 'it could not be authenticated',
  FORBIDDEN_ACCESS: 'it asked for something its policy does not allow',
  THROTTLED: 'it sent more than AWS IoT accepts',
  CLIENT_ERROR: 'it broke the protocol',
  SERVER_ERROR: 'AWS IoT had a problem',
  WEBSOCKET_TTL_EXPIRATION: 'its session expired',
  CUSTOMAUTH_TTL_EXPIRATION: 'its session expired',
});

const STEP_WORDS = Object.freeze({
  awaiting_user: (version) => `Offered ${version ?? 'an update'}; waiting for Button 1`,
  downloading: (version) => `Downloading ${version ?? 'an update'}`,
  verifying: (version) => `Checking the download of ${version ?? 'an update'}`,
  rebooting: (version) => `Restarting into ${version ?? 'an update'}`,
  testing: (version) => `On trial: ${version ?? 'an update'}`,
  idle: () => 'Update stopped, with no result reported',
});

const RESULT_WORDS = Object.freeze({
  succeeded: 'succeeded',
  failed: 'failed',
  rolled_back: 'rolled back to the previous firmware',
  declined: 'declined at the board',
  refused: 'refused by the board',
  cancelled: 'cancelled',
});
const BAD_RESULTS = new Set(['failed', 'rolled_back', 'refused']);

const BT_WORDS = Object.freeze({
  pending: 'waits to be proved',
  succeeded: 'succeeded',
  rolled_back: 'was rolled back',
  not_installed: 'was not installed',
  trial_lost: 'lost its trial',
  superseded: 'was replaced by a cloud update',
  flash_error: 'could not be written to flash',
  incompatible_board: 'was refused: the image is for another board',
  incompatible_layout: 'was refused: the image is for another flash layout',
});
const BAD_BT = new Set([
  'rolled_back',
  'not_installed',
  'trial_lost',
  'flash_error',
  'incompatible_board',
  'incompatible_layout',
]);
const PROOF_WORDS = Object.freeze({ person: ', kept by a person at the board', cloud: ', proved by the cloud' });

function causeWords(causes) {
  return causes
    .map((cause) => CAUSE_WORDS[cause] ?? 'an unknown cause')
    .filter((words, index, all) => all.indexOf(words) === index)
    .join(' and ');
}

function stageWords(stage) {
  return STAGE_WORDS[stage] ?? (stage === 0 ? 'had not started its program' : `reached stage ${stage}`);
}

/** One event as the diff makes it: no key and no time yet. */
function change(kind, what, text, fields = {}, level = 'info') {
  return { kind, what, level, text, fields };
}

/**
 * Why the newest boots in a diary started, if the diary grew: the newest entry's cause is why
 * the boot before it ended, and the entry before that says how far that boot got.
 */
function diaryNews(before, now) {
  if (before === null || now === null || now.boots <= before.boots || now.entries.length === 0) return null;
  const [newest, previous] = now.entries;
  const newBoots = now.boots - before.boots;
  const fields = { version: newest.version, cause: newest.cause, boots: now.boots, newBoots };
  if (previous !== undefined) fields.stage = previous.stage;
  const reached = previous === undefined ? '' : `; it had ${stageWords(previous.stage)}`;
  const lead = newBoots > 1 ? `${newBoots} boots since the last report. ` : '';
  const bad = newest.causes.some((cause) => BAD_CAUSES.has(cause));
  return change(
    'restart',
    'boot',
    `${lead}Last boot ended by ${causeWords(newest.causes)}${reached}`,
    fields,
    bad ? 'warn' : 'info'
  );
}

/**
 * The events that one report makes, from what the board reported before and after it. Both
 * are the raw state.reported of the document; neither is trusted.
 *
 * @returns {{kind, what, level, text, fields}[]} in the order they happened
 */
export function changesBetween(previousReported, currentReported) {
  const before = readReported(previousReported);
  const now = readReported(currentReported);
  const changes = [];

  // A restart first: what the board says after it, it says about the new boot. The diary
  // usually comes in a report of its own a moment later, and is then an event of its own.
  const restarted = before.uptime !== null && now.uptime !== null && now.uptime < before.uptime;
  const upFor = restarted ? { upFor: before.uptime } : {};
  // The count of restarts in a row for being stuck. A first sight of it says nothing new.
  const stuck = before.stuck !== null && now.stuck !== null && now.stuck.count > before.stuck.count ? now.stuck : null;
  let news = diaryNews(before.diary, now.diary);
  if (stuck !== null) {
    const { count, reason } = stuck;
    const why = STUCK_WORDS[reason] ?? `reason ${reason}`;
    changes.push(
      change(
        'restart',
        'stuck',
        `Restarted itself for being stuck: ${why} (${ordinal(count)} time in a row` +
          `${restarted ? `, after ${duration(before.uptime)} up` : ''})`,
        { count, reason, ...upFor },
        'warn'
      )
    );
  } else if (restarted) {
    const fields = { ...upFor };
    let why = '';
    if (news !== null) {
      fields.cause = news.fields.cause;
      if (news.fields.stage !== undefined) fields.stage = news.fields.stage;
      why = `. ${news.text}`;
    }
    changes.push(
      change(
        'restart',
        'restarted',
        `Restarted after ${duration(before.uptime)} up${why}`,
        fields,
        news?.level ?? 'info'
      )
    );
    news = null;
  }
  if (news !== null) changes.push(news);

  if (now.fw !== null && before.fw?.version !== now.fw.version) {
    const { version, confirmed } = now.fw;
    changes.push(
      before.fw === null
        ? change('firmware', 'reported', `Reported firmware ${version}${confirmed ? '' : ', on trial'}`, {
            version,
            confirmed,
          })
        : change(
            'firmware',
            'changed',
            `Firmware changed from ${before.fw.version} to ${version}${confirmed ? '' : ', on trial'}`,
            { version, from: before.fw.version, confirmed }
          )
    );
  } else if (now.fw !== null && before.fw?.confirmed === false && now.fw.confirmed) {
    changes.push(
      change('firmware', 'confirmed', `Firmware ${now.fw.version} confirmed`, {
        version: now.fw.version,
        confirmed: true,
      })
    );
  }

  const was = before.ota?.state ?? null;
  const is = now.ota?.state ?? null;
  const job = now.ota?.job ?? before.ota?.job ?? null;
  const jobField = job === null ? {} : { job };
  let result = null;
  if (now.ota !== null && now.ota.last !== 'none') {
    const moved = before.ota === null || before.ota.last !== now.ota.last || before.ota.error !== now.ota.error;
    // The same result again, after another update: the board went back to idle with it.
    const ended = was !== null && was !== 'idle' && was !== 'bluetooth' && is === 'idle';
    if (moved || ended) {
      const { last, error } = now.ota;
      const version = target(before.ota?.job ?? now.ota.job);
      const what = version === null ? 'Update' : `Update to ${version}`;
      result = change(
        'update',
        'result',
        `${what} ${RESULT_WORDS[last]}${error ? `: ${error}` : ''}`,
        { result: last, ...(error ? { error } : {}), ...jobField },
        BAD_RESULTS.has(last) ? 'warn' : 'info'
      );
    }
  }
  if (is !== null && was !== is) {
    if (is === 'bluetooth') {
      changes.push(change('bluetooth', 'opened', 'Bluetooth opened for an update from a phone'));
    } else if (was === 'bluetooth') {
      changes.push(change('bluetooth', 'closed', 'Bluetooth closed'));
    }
    const fromNothing = was === null || was === 'idle' || was === 'bluetooth';
    if (is !== 'bluetooth' && !(is === 'idle' && (fromNothing || result !== null))) {
      changes.push(
        change('update', 'step', STEP_WORDS[is](target(now.ota.job ?? before.ota?.job)), {
          state: is,
          progress: now.ota.progress,
          ...jobField,
        })
      );
    }
  }
  if (result !== null) changes.push(result);

  if (
    now.bt !== null &&
    (before.bt === null ||
      before.bt.result !== now.bt.result ||
      before.bt.count !== now.bt.count ||
      before.bt.to !== now.bt.to)
  ) {
    const { from, to, result: outcome, proof, count } = now.bt;
    const proved = outcome === 'succeeded' ? (PROOF_WORDS[proof] ?? '') : '';
    changes.push(
      change(
        'bluetooth',
        'record',
        `Bluetooth update from ${from} to ${to} ${BT_WORDS[outcome]}${proved}`,
        { from, to, result: outcome, proof, count },
        BAD_BT.has(outcome) ? 'warn' : 'info'
      )
    );
  }

  // The name a person gave the board at its serial console. A report without one says nothing
  // about it: older firmware has none to send.
  if (now.name !== null && before.name !== now.name) {
    changes.push(
      before.name === null
        ? change('health', 'named', `Reported its name ${now.name}`, { name: now.name })
        : change('health', 'named', `Name changed from ${before.name} to ${now.name}`, {
            name: now.name,
            nameBefore: before.name,
          })
    );
  }

  const channel = now.diag?.channel ?? 0;
  const channelBefore = before.diag?.channel ?? 0;
  if (channel > 0 && channelBefore > 0 && channel !== channelBefore) {
    changes.push(
      change('health', 'channel', `Wi-Fi channel changed from ${channelBefore} to ${channel}`, {
        channel,
        before: channelBefore,
      })
    );
  }

  const heap = now.diag?.heap ?? null;
  const heapBefore = before.diag?.heap ?? null;
  const low = (reading) => reading !== null && reading.least < reading.size * LOW_HEAP_SHARE;
  // Once per boot: the least only goes down until the board restarts.
  if (low(heap) && (!low(heapBefore) || heap.least > heapBefore.least)) {
    const share = Math.round((heap.least / heap.size) * 100);
    changes.push(
      change(
        'health',
        'memory',
        `Memory ran low: at one point only ${kib(heap.least)} of ${kib(heap.size)} was free (${share}%)`,
        { heapLeast: heap.least, heapSize: heap.size },
        'warn'
      )
    );
  }
  return changes;
}

/** The sample one document makes, or null if it carries no reading. */
export function sampleOf(currentReported) {
  const now = readReported(currentReported);
  const sample = {};
  if (now.rssi !== null) sample.rssi = now.rssi;
  if (now.uptime !== null) sample.uptime = now.uptime;
  if (now.diag?.heap) {
    sample.heapFree = now.diag.heap.free;
    sample.heapLeast = now.diag.heap.least;
  }
  return Object.keys(sample).length > 0 ? sample : null;
}

// Keys and items.

export function eventKey(atMs, random) {
  if (!RANDOM.test(random)) throw new TypeError('six hex digits are needed for an event key');
  return `E#${new Date(atMs).toISOString()}#${random}`;
}

export function sampleKey(atMs) {
  return `S#${new Date(atMs).toISOString()}`;
}

/** The lower and upper bound of the events between two times, for a query on the sort key. */
export function eventRange(fromMs, toMs) {
  return { low: `E#${new Date(fromMs).toISOString()}`, high: `E#${new Date(toMs).toISOString()}#~` };
}

export function sampleRange(fromMs, toMs) {
  return { low: `S#${new Date(fromMs).toISOString()}`, high: `S#${new Date(toMs).toISOString()}~` };
}

/** A message time that AWS IoT stamped, if it is believable; otherwise the recorder's clock. */
export function stamped(ms, nowMs) {
  return Number.isFinite(ms) && ms >= nowMs - STAMP_PAST_MS && ms <= nowMs + STAMP_FUTURE_MS ? Math.floor(ms) : nowMs;
}

function eventItem(thing, atMs, random, { kind, what, level, text, fields }) {
  const item = {
    pk: thing,
    sk: eventKey(atMs, random),
    kind,
    what,
    level,
    text: text.slice(0, MAX_TEXT),
    ttl: Math.floor(atMs / 1000) + EVENT_DAYS * 86_400,
  };
  for (const [name, value] of Object.entries(fields)) {
    if (Object.hasOwn(FIELDS, name) && FIELDS[name](value)) item[name] = value;
  }
  return item;
}

function draw(randomHex) {
  const digits = String(randomHex(3)).slice(0, 6).toLowerCase();
  if (!RANDOM.test(digits)) throw new TypeError('randomHex gave no hex digits');
  return digits;
}

/**
 * What one shadow document from the rule becomes: { thing, items } or { ignored: why }.
 *
 * @param {object} document   { previous, current, timestamp, thing } as the rule selects it
 * @param {object} options
 * @param {number} options.nowMs                  the recorder's clock
 * @param {(count: number) => string} options.randomHex
 */
export function recordsFromDocument(document, { nowMs, randomHex }) {
  const thing = own(document, 'thing');
  if (!isThing(thing)) return { ignored: 'not_a_board' };
  const current = own(own(own(document, 'current'), 'state'), 'reported');
  if (current === undefined) return { ignored: 'no_report' };
  const previous = own(own(own(document, 'previous'), 'state'), 'reported');
  const stamp = own(document, 'timestamp');
  const version = own(own(document, 'current'), 'version');
  const tick = Number.isInteger(stamp) && Number.isInteger(version) && version >= 0 ? (version % 100) * 10 : 0;
  const atMs = stamped(Number.isInteger(stamp) ? stamp * 1000 + tick : NaN, nowMs);

  // At most nine events a report: the tenth would take the place of the next version's first.
  const items = changesBetween(previous, current)
    .slice(0, 9)
    .map((made, index) => eventItem(thing, atMs + index, draw(randomHex), made));
  const sample = sampleOf(current);
  if (sample !== null) {
    items.push({ pk: thing, sk: sampleKey(atMs), ...sample, ttl: Math.floor(atMs / 1000) + SAMPLE_DAYS * 86_400 });
  }
  return { thing, items };
}

/** What one presence message becomes: { thing, items } or { ignored: why }. */
export function recordsFromPresence(message, { nowMs, randomHex }) {
  const thing = own(message, 'clientId');
  const type = own(message, 'eventType');
  if (!isThing(thing)) return { ignored: 'not_a_board' };
  if (type !== 'connected' && type !== 'disconnected') return { ignored: 'not_presence' };
  const atMs = stamped(own(message, 'timestamp'), nowMs);
  let made = change('connection', 'connected', 'Connected to AWS IoT');
  if (type === 'disconnected') {
    const reason = own(message, 'disconnectReason');
    const known = typeof reason === 'string' && REASON.test(reason) ? reason : null;
    const words = known === null ? undefined : DISCONNECT_WORDS[known];
    made = change(
      'connection',
      'disconnected',
      `Disconnected from AWS IoT${words ? `: ${words}` : ''}`,
      known === null ? {} : { reason: known }
    );
  }
  return { thing, items: [eventItem(thing, atMs, draw(randomHex), made)] };
}

/** Either kind of message, told apart by its shape. */
export function recordsOf(message, options) {
  if (own(message, 'eventType') !== undefined) return recordsFromPresence(message, options);
  if (own(message, 'current') !== undefined) return recordsFromDocument(message, options);
  return { ignored: 'unknown_message' };
}

// Reading back. Items are checked again on the way out: the table is not trusted either.

/**
 * An event as the API returns it, or null for an item that is not one:
 * { thing, at, id, kind, what, level, text, ...fields }.
 */
export function eventFromItem(item) {
  if (item === null || typeof item !== 'object') return null;
  const key = typeof item.sk === 'string' ? EVENT_KEY.exec(item.sk) : null;
  if (key === null || !isThing(item.pk) || !KINDS.includes(item.kind)) return null;
  if (typeof item.what !== 'string' || !WHAT.test(item.what)) return null;
  if (typeof item.text !== 'string' || !PRINTABLE.test(item.text)) return null;
  const event = {
    thing: item.pk,
    at: key[1],
    id: key[2],
    kind: item.kind,
    what: item.what,
    level: item.level === 'warn' ? 'warn' : 'info',
    text: item.text,
  };
  for (const [name, check] of Object.entries(FIELDS)) {
    if (Object.hasOwn(item, name) && check(item[name])) event[name] = item[name];
  }
  return event;
}

/** A sample as the API returns it, or null: { at, rssi, uptime, heapFree, heapLeast }, null where not reported. */
export function sampleFromItem(item) {
  const key = typeof item?.sk === 'string' ? SAMPLE_KEY.exec(item.sk) : null;
  if (key === null) return null;
  const pick = (name, check) => (check(item[name]) ? item[name] : null);
  return {
    at: key[1],
    rssi: pick('rssi', int(-127, 0)),
    uptime: pick('uptime', int(0, 2 ** 32)),
    heapFree: pick('heapFree', int(0, 2 ** 31)),
    heapLeast: pick('heapLeast', int(0, 2 ** 31)),
  };
}

/** The order of event items across boards: by this key, highest first. */
export function orderKey(item) {
  return `${item.sk}|${item.pk}`;
}

/** A page cursor: where the last page ended, opaque to the browser. */
export function encodeEventCursor(item) {
  return Buffer.from(orderKey(item), 'utf8').toString('base64url');
}

/** { sk, thing } from a cursor, or null if the text is not a cursor of this log. */
export function decodeEventCursor(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 200 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) return null;
  const [sk, thing, ...rest] = bytes.toString('utf8').split('|');
  if (rest.length > 0 || !EVENT_KEY.test(sk ?? '') || !isThing(thing)) return null;
  return { sk, thing };
}

/**
 * At most `max` samples over a time span, for a chart: the span is cut into equal buckets and
 * each bucket that has samples gives one, at the time of its last sample. The signal is the
 * mean of the bucket, the uptime its last, the heap its lowest: memory that ran short for a
 * moment is what a reader has to see.
 *
 * @returns {{ samples: object[], bucketSeconds: number }} oldest first; bucketSeconds is 0
 *          when nothing had to be merged
 */
export function thinSamples(samples, { fromMs, toMs, max = 600 }) {
  if (samples.length <= max) return { samples, bucketSeconds: 0 };
  const width = Math.ceil((toMs - fromMs) / max);
  const buckets = new Map();
  for (const sample of samples) {
    const index = Math.min(max - 1, Math.max(0, Math.floor((Date.parse(sample.at) - fromMs) / width)));
    if (!buckets.has(index)) buckets.set(index, []);
    buckets.get(index).push(sample);
  }
  const thinned = [];
  for (const index of [...buckets.keys()].sort((a, b) => a - b)) {
    const group = buckets.get(index);
    const values = (name) => group.map((sample) => sample[name]).filter((value) => value !== null);
    const rssi = values('rssi');
    const uptime = values('uptime');
    const free = values('heapFree');
    const least = values('heapLeast');
    thinned.push({
      at: group[group.length - 1].at,
      rssi: rssi.length > 0 ? Math.round(rssi.reduce((sum, value) => sum + value, 0) / rssi.length) : null,
      uptime: uptime.length > 0 ? uptime[uptime.length - 1] : null,
      heapFree: free.length > 0 ? Math.min(...free) : null,
      heapLeast: least.length > 0 ? Math.min(...least) : null,
    });
  }
  return { samples: thinned, bucketSeconds: Math.ceil(width / 1000) };
}
