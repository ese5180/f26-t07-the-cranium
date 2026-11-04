/**
 * The board log: what a board printed on its serial console, line by line, from firmware 1.12.0
 * ("Events to the console" in firmware/README.md, firmware/app/src/cloud_events.c).
 *
 * A board publishes each line on cranium/<thing>/events, and the rule BoardLogRule
 * (infra/template.yaml) hands it to the recorder as
 *
 *   SELECT *, topic(2) AS thing, timestamp() AS received FROM 'cranium/+/events'
 *   WHERE startswith(topic(2), 'cranium-') AND isUndefined(thing) AND isUndefined(received)
 *
 *   { t, seq, boot, up, dropped?, tag, text, thing, received }
 *
 * `thing` comes from the topic, which the device policy lets a board publish on for itself only,
 * and `received` is when AWS IoT got the message. The rule passes no message that carries either
 * of its own: a board cannot name another board or choose its own time of arrival. Everything else
 * is the board's, and is checked again here as if the board had done none of its own checks: the
 * numbers and their ranges, the tag against the list of sources the firmware may send, the text
 * made printable ASCII and cut to 160 characters, and the firmware's rule of what never goes, again.
 * A line with a passkey, a password or anything else on that list is not stored at all, and the
 * recorder logs that it was withheld, with its board and tag and never its text. A network name
 * between quotes, a URL and an AWS host name are replaced, as the board replaces the first two.
 *
 * Each line becomes one event, with a kind from its tag:
 *
 *   BT, bt_ota                      bluetooth
 *   ota                             update
 *   STUCK, stuck, boot_diary        restart
 *   WIFI, net, health               health (the Events page's "Wi-Fi and memory")
 *   CONSOLE, factory                setting: a setting of the board changed, at its serial console
 *   CMD                             setting: the board's answer to a command from the console (1.13.0)
 *   app, cloud, identity, store, ui log
 *
 * `connection` is left to AWS IoT's own word that a board connected or disconnected (the presence
 * rule), from which the Events page draws when a board was online: a line of the board's is never one.
 *
 * Dated: when AWS IoT got the message, less (up - t), the milliseconds the line waited on the board.
 *
 * Items, in the events table beside the events and samples of lib/events.mjs:
 *
 *   sk = "L#<ISO time>#<boot>.<seq>"   a line, kept 90 days like an event
 *   sk = "K#<boot>.<seq>"              the claim of that line: { at } in epoch ms, kept as long
 *
 * A message that Lambda hands over again is the same message, with the same `received`, so it
 * makes the same line key and replaces its own item. The board can also send the first line of a
 * boot twice, in two connections (firmware/README.md, "The device policy"); the second copy has
 * another `up` and arrives at another time, so its date differs by how much longer one copy took
 * on its way. The claim catches it: it is written only where none is, where the one there has the
 * same date, or where the one there is more than SAME_LINE_MS away, which is a board that counts
 * its boots from 1 again after a factory reset. A copy within SAME_LINE_MS of the claim is the same
 * line, and is not stored again.
 *
 * No AWS here, and no clock: the caller passes the time.
 */

import { EVENT_DAYS, stamped } from './events.mjs';
import { isThing } from './validate.mjs';

export const TAGS = Object.freeze([
  'BT', 'WIFI', 'STUCK', 'CONSOLE',
  // A board's answer to a command from the console (docs/fleet.md, cranium/<thing>/commands), from 1.13.0.
  'CMD',
  'app', 'boot_diary', 'bt_ota', 'cloud', 'factory', 'health', 'identity', 'net', 'ota', 'store', 'stuck', 'ui',
]);

export const KIND_OF_TAG = Object.freeze({
  BT: 'bluetooth',
  bt_ota: 'bluetooth',
  ota: 'update',
  STUCK: 'restart',
  stuck: 'restart',
  boot_diary: 'restart',
  WIFI: 'health',
  net: 'health',
  health: 'health',
  CONSOLE: 'setting',
  factory: 'setting',
  CMD: 'setting',
  app: 'log',
  cloud: 'log',
  identity: 'log',
  store: 'log',
  ui: 'log',
});

export const LINE_KINDS = Object.freeze(['bluetooth', 'update', 'restart', 'health', 'setting', 'log']);
export const LINE_TEXT_MAX = 160;
export const SAME_LINE_MS = 10_000;

// cloud_events.c never_anywhere[], in lower case: a line with any of these in it, in any case, is not
// stored. "passkey" is also the rule of its own for BT and bt_ota.
export const NEVER_STORED = Object.freeze([
  'passkey', 'passphrase', 'password=', 'password:', 'psk=', 'secret', '-----begin', 'private key', 'x-amz-',
]);
// The sources whose lines may hold a network's name between quotes (cloud_events.c RULE_QUOTES_HOLD_A_NETWORK).
const QUOTES_HOLD_A_NETWORK = new Set(['WIFI', 'net']);

const MAX_UPTIME = 2 ** 42;
const MAX_COUNT = 2 ** 32 - 1;
// A text this long is not one the firmware makes: at most 160 characters, and a quote or a
// backslash takes two in JSON, which is undone by the time it is here.
const MAX_RAW_TEXT = 1024;
const CUT = '...';

const LINE_KEY = /^L#(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#(0|[1-9]\d{0,9})\.([1-9]\d{0,9})$/;
const PRINTABLE = /^[\x20-\x7e]{1,160}$/;
const NOT_PRINTABLE = /[^\x20-\x7e]/g;
// A URL as cloud_events.c url_at() finds one: a scheme that starts after no other scheme
// character, "://", and everything up to a blank or a quote.
const URL = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"']*/g;
// A host name ending in .amazonaws.com, such as an AWS IoT endpoint or a bucket's address.
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const AWS_HOST = new RegExp(`(?<![A-Za-z0-9.-])${LABEL}(?:\\.${LABEL})*\\.amazonaws\\.com(?![A-Za-z0-9-])`, 'gi');

/** An own property of a plain object, or undefined. */
function own(value, key) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)
    ? value[key]
    : undefined;
}

const whole = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

/** Whether a message from a rule is a line of a board log: only that rule adds `received`. */
export function isLineMessage(message) {
  return own(message, 'received') !== undefined;
}

/**
 * The text of a line as it may be stored: { text } or { withheld: why }. `why` is "secret" for
 * a line with a word that is never stored, "debug" for a debug line and "empty" for no text.
 */
export function cleanLineText(tag, raw) {
  let text = raw.replace(NOT_PRINTABLE, '?');
  if (text.trim() === '') return { withheld: 'empty' };
  // The console marks a debug line so; those are for whoever has the cable.
  if (text.startsWith('DBG: ')) return { withheld: 'debug' };
  const lower = text.toLowerCase();
  if (NEVER_STORED.some((word) => lower.includes(word))) return { withheld: 'secret' };
  if (QUOTES_HOLD_A_NETWORK.has(tag)) {
    const first = text.indexOf('"');
    if (first >= 0) {
      const last = text.lastIndexOf('"');
      text = `${text.slice(0, first)}the network${last > first ? text.slice(last + 1) : ''}`;
    }
  }
  text = text.replace(URL, 'a URL').replace(AWS_HOST, 'AWS');
  if (text.length > LINE_TEXT_MAX) text = `${text.slice(0, LINE_TEXT_MAX - CUT.length)}${CUT}`;
  return { text };
}

export function lineKey(atMs, boot, seq) {
  return `L#${new Date(atMs).toISOString()}#${boot}.${seq}`;
}

export function claimKey(boot, seq) {
  return `K#${boot}.${seq}`;
}

/** The lower and upper bound of the lines between two times, for a query on the sort key. */
export function lineRange(fromMs, toMs) {
  return { low: `L#${new Date(fromMs).toISOString()}`, high: `L#${new Date(toMs).toISOString()}#~` };
}

/**
 * What one message of the board log becomes:
 *   { thing, items: [line], claim }   to store, the claim first
 *   { thing, withheld: why, tag }     a line that is not stored (cleanLineText)
 *   { ignored: why }                  not a line at all
 *
 * @param {object} message   as the rule selects it
 * @param {{ nowMs: number }} options  the recorder's clock
 */
export function recordsFromLine(message, { nowMs }) {
  const thing = own(message, 'thing');
  if (!isThing(thing)) return { ignored: 'not_a_board' };
  const t = own(message, 't');
  const up = own(message, 'up');
  const seq = own(message, 'seq');
  const boot = own(message, 'boot');
  const dropped = own(message, 'dropped') ?? 0;
  const tag = own(message, 'tag');
  const raw = own(message, 'text');
  if (!whole(t, 0, MAX_UPTIME) || !whole(up, 0, MAX_UPTIME) || t > up) return { ignored: 'bad_time' };
  if (!whole(seq, 1, MAX_COUNT) || !whole(boot, 0, MAX_COUNT) || !whole(dropped, 0, MAX_COUNT)) {
    return { ignored: 'bad_count' };
  }
  if (typeof tag !== 'string' || !TAGS.includes(tag)) return { ignored: 'unknown_tag' };
  if (typeof raw !== 'string' || raw.length > MAX_RAW_TEXT) return { ignored: 'bad_text' };

  const cleaned = cleanLineText(tag, raw);
  if (cleaned.withheld !== undefined) return { thing, withheld: cleaned.withheld, tag };

  const atMs = stamped(own(message, 'received'), nowMs) - (up - t);
  if (!(atMs > 0)) return { ignored: 'bad_time' };
  const ttl = Math.floor(atMs / 1000) + EVENT_DAYS * 86_400;
  const level = /^(WRN|ERR): /.test(cleaned.text) || tag === 'STUCK' ? 'warn' : 'info';
  const line = {
    pk: thing,
    sk: lineKey(atMs, boot, seq),
    kind: KIND_OF_TAG[tag],
    what: 'line',
    level,
    tag,
    text: cleaned.text,
    boot,
    seq,
    ttl,
  };
  if (dropped > 0) line.dropped = dropped;
  return { thing, items: [line], claim: { pk: thing, sk: claimKey(boot, seq), at: atMs, ttl } };
}

// Reading back. Items are checked again on the way out: the table is not trusted either.

/**
 * A line as the API returns it, or null for an item that is not one:
 * { thing, at, id, kind, tag, level, text, boot, seq, dropped? }.
 */
export function lineFromItem(item) {
  if (item === null || typeof item !== 'object') return null;
  const key = typeof item.sk === 'string' ? LINE_KEY.exec(item.sk) : null;
  if (key === null || !isThing(item.pk) || !LINE_KINDS.includes(item.kind) || !TAGS.includes(item.tag)) return null;
  if (typeof item.text !== 'string' || !PRINTABLE.test(item.text)) return null;
  const boot = Number(key[2]);
  const seq = Number(key[3]);
  if (boot > MAX_COUNT || seq > MAX_COUNT) return null;
  const line = {
    thing: item.pk, at: key[1], id: `${boot}.${seq}`, kind: item.kind, tag: item.tag,
    level: item.level === 'warn' ? 'warn' : 'info', text: item.text, boot, seq,
  };
  if (whole(item.dropped, 1, MAX_COUNT)) line.dropped = item.dropped;
  return line;
}

/** { sk, thing } from a cursor of the board log, or null if the text is not one. */
export function decodeLineCursor(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 200 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) return null;
  const [sk, thing, ...rest] = bytes.toString('utf8').split('|');
  if (rest.length > 0 || !LINE_KEY.test(sk ?? '') || !isThing(thing)) return null;
  return { sk, thing };
}
