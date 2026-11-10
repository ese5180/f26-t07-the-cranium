/**
 * The input grammar of the console API.
 *
 * Everything that arrives in a path, a query string or a body passes through one of
 * these functions before it is used. A value that does not match is refused with 400;
 * a value that matches is rebuilt from its parsed parts, so that only one spelling of
 * it ever reaches AWS or the database.
 */

import { badRequest, notFound } from '../http.mjs';
import { formatVersion, parseVersion } from './mcuboot.mjs';
import { DEFAULT_TOKEN_DAYS, MAX_TOKEN_DAYS, MAX_TOKEN_NAME, MIN_TOKEN_DAYS, TOKEN_ID } from './tokens.mjs';

// "major.minor.revision+build", the build number always present.
const VERSION = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,4})\+(0|[1-9]\d{0,9})$/;
const THING = /^cranium-[0-9a-f]{16}$/;
// A deployment of board firmware; "-pi" after the build number when it brings a Pi image too (2.26.0).
const JOB_ID = /^cranium-(\d{1,3})-(\d{1,3})-(\d{1,5})-b(\d{1,10})(-pi)?-(\d{8}T\d{6}Z)-[0-9a-f]{4}$/;
// A deployment of a Raspberry Pi image alone (2.26.0): "pi-", the image's version as letters, digits,
// "_" and "-", the time and 4 hex. A board tells it from firmware by the "pi-" (firmware ota_job.h).
const PI_JOB_ID = /^pi-[A-Za-z0-9_-]{1,31}-\d{8}T\d{6}Z-[0-9a-f]{4}$/;
// A Raspberry Pi image's version, as a board takes it (firmware ota_job.c copy_pi_version).
export const PI_VERSION = /^[A-Za-z0-9._+-]{1,31}$/;
const FILENAME = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// The name a board advertises over Bluetooth while its window is open, drawn anew for each
// window. It is also the name a board reports while a phone pairs with it (lib/shadow.mjs).
export const BLUETOOTH_NAME = /^Cranium-[0-9A-F]{4}$/;

// Control and format characters, unpaired surrogates, private-use and unassigned code
// points, and the two Unicode line separators. None of them belongs in a one-line note.
const CONTROL = /[\p{C}\p{Zl}\p{Zp}]/u;

export const MAX_THINGS = 25;
export const MAX_NOTES = 500;
export const MAX_NOTE = 200;
export const MAX_REASON = 200;
export const MAX_AUDIT_PAGE = 100;
export const DEFAULT_AUDIT_PAGE = 50;

/**
 * Parse a version in the strict form of the API. Returns { text, parts } with the
 * canonical text, or null.
 */
export function strictVersion(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) return null;
  const parts = parseVersion(value);
  if (parts === null) return null;
  return { text: formatVersion(parts), parts };
}

export function isThing(value) {
  return typeof value === 'string' && THING.test(value);
}

/**
 * Parse a deployment (job) id. Returns the version it names, or null when the text is
 * not a deployment id of this console.
 */
export function parseJobId(value) {
  if (typeof value !== 'string') return null;
  const match = JOB_ID.exec(value);
  if (!match) return null;
  const parts = {
    major: Number(match[1]),
    minor: Number(match[2]),
    revision: Number(match[3]),
    build: Number(match[4]),
  };
  if (parts.major > 0xff || parts.minor > 0xff || parts.revision > 0xffff || parts.build > 0xffffffff) {
    return null;
  }
  return { id: value, version: formatVersion(parts), parts, withPi: match[5] !== undefined };
}

/**
 * Any deployment id of this console: one of firmware (parseJobId), or of a Pi image alone, which
 * names no firmware version: { id, version: null, parts: null, withPi: true, piOnly: true }.
 */
export function parseDeploymentId(value) {
  const firmware = parseJobId(value);
  if (firmware !== null) return { ...firmware, piOnly: false };
  if (typeof value !== 'string' || !PI_JOB_ID.test(value)) return null;
  return { id: value, version: null, parts: null, withPi: true, piOnly: true };
}

/** A Raspberry Pi image's version, as it is written: no other spelling is taken. */
export function requirePiVersion(value) {
  if (typeof value !== 'string' || !PI_VERSION.test(value)) {
    throw badRequest(
      'invalid_version',
      "A Pi image's version is 1 to 31 letters, digits, dots, dashes, underscores or plus signs."
    );
  }
  return value;
}

export function requireVersion(value) {
  const version = strictVersion(value);
  if (version === null) {
    throw badRequest('invalid_version', 'A version looks like 1.2.3+4: major.minor.revision+build.');
  }
  return version;
}

export function requireThing(value) {
  if (!isThing(value)) {
    throw badRequest('invalid_thing', 'A board name is "cranium-" followed by 16 lowercase hex digits.');
  }
  return value;
}

// A Memfault issue's id (handlers/memfault.mjs): Memfault numbers its issues. One that is not a number is no
// issue of Memfault's, so it is refused as an issue that is not there.
const ISSUE_ID = /^[1-9]\d{0,15}$/;

export function requireIssueId(value) {
  if (typeof value !== 'string' || !ISSUE_ID.test(value)) {
    throw notFound('not_found', 'Memfault has no issue with that id.');
  }
  return value;
}

export function requireJobId(value) {
  const job = parseDeploymentId(value);
  if (job === null) throw badRequest('invalid_deployment', 'That is not a deployment id.');
  return job;
}

export function requireFilename(value) {
  if (typeof value !== 'string' || !FILENAME.test(value)) {
    throw badRequest(
      'invalid_filename',
      'The file name may contain letters, digits, dots, dashes and underscores, 64 characters at most.'
    );
  }
  return value;
}

/**
 * A line of free text: a string, trimmed, without control characters, between min and
 * max characters long. An absent optional field is the empty string.
 */
export function requireText(value, name, { min = 0, max }) {
  if (value === undefined && min === 0) return '';
  if (typeof value !== 'string') {
    throw badRequest(`invalid_${name}`, `"${name}" must be text.`);
  }
  const text = value.trim();
  if (CONTROL.test(text)) {
    throw badRequest(`invalid_${name}`, `"${name}" must be one line of plain text without control characters.`);
  }
  if (text.length < min) {
    throw badRequest(`invalid_${name}`, `"${name}" is required.`);
  }
  if (text.length > max) {
    throw badRequest(`invalid_${name}`, `"${name}" may be at most ${max} characters long.`);
  }
  return text;
}

/** 1 to 25 board names, no name twice. Returned sorted. */
export function requireThings(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_THINGS) {
    throw badRequest('invalid_things', `Choose between 1 and ${MAX_THINGS} boards.`);
  }
  const seen = new Set();
  for (const thing of value) {
    if (!isThing(thing)) {
      throw badRequest('invalid_things', 'A board name is "cranium-" followed by 16 lowercase hex digits.');
    }
    if (seen.has(thing)) {
      throw badRequest('invalid_things', `${thing} is listed twice.`);
    }
    seen.add(thing);
  }
  return [...seen].sort();
}

export function requireBoolean(value, name, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw badRequest(`invalid_${name}`, `"${name}" must be true or false.`);
  }
  return value;
}

/**
 * Decode base64 that must be canonical: the bytes encode back to exactly the text that
 * was sent, so there is one accepted spelling of every upload.
 */
export function requireBase64(value, name) {
  if (typeof value !== 'string' || value === '') {
    throw badRequest(`invalid_${name}`, `"${name}" must be the file, base64 encoded.`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw badRequest(`invalid_${name}`, `"${name}" is not valid base64.`);
  }
  return bytes;
}

/** The SHA-256 of a file, as this API writes it: 64 lowercase hex digits, nothing else. */
export function requireSha256(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw badRequest('invalid_sha256', '"sha256" must be the SHA-256 of the image: 64 lowercase hex digits.');
  }
  return value;
}

/**
 * The name a board advertises over Bluetooth, where giving one is up to the caller:
 * "Cranium-" and four upper-case hex digits, or absent (null). Anything else, null included,
 * is refused.
 */
export function requireBluetoothName(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !BLUETOOTH_NAME.test(value)) {
    throw badRequest(
      'invalid_board',
      '"board" is the name the board advertises: Cranium- and four hexadecimal digits.'
    );
  }
  return value;
}

/** The name of an API token: one line of 1 to 40 printable characters, trimmed. */
export function requireTokenName(value) {
  if (typeof value !== 'string') {
    throw badRequest('invalid_token_name', 'Give the token a name, so that you can tell it from your others.');
  }
  const name = value.trim();
  if (name === '' || name.length > MAX_TOKEN_NAME || CONTROL.test(name)) {
    throw badRequest(
      'invalid_token_name',
      `A token's name is one line of 1 to ${MAX_TOKEN_NAME} characters, without control characters.`
    );
  }
  return name;
}

/** How many days an API token is valid: a whole number from 1 to 90, 30 when absent. */
export function requireTokenDays(value) {
  if (value === undefined) return DEFAULT_TOKEN_DAYS;
  if (!Number.isInteger(value) || value < MIN_TOKEN_DAYS || value > MAX_TOKEN_DAYS) {
    throw badRequest('invalid_days', `"days" must be a whole number from ${MIN_TOKEN_DAYS} to ${MAX_TOKEN_DAYS}.`);
  }
  return value;
}

/** The id of an API token: 16 lowercase hex digits. */
export function requireTokenId(value) {
  if (typeof value !== 'string' || !TOKEN_ID.test(value)) {
    throw badRequest('invalid_token_id', 'A token id is 16 lowercase hex digits.');
  }
  return value;
}

/** The page size of the activity log: 1 to 100, 50 when absent. */
export function requirePageSize(value) {
  if (value === undefined) return DEFAULT_AUDIT_PAGE;
  if (typeof value !== 'string' || !/^[1-9]\d{0,2}$/.test(value) || Number(value) > MAX_AUDIT_PAGE) {
    throw badRequest('invalid_limit', `"limit" must be a number from 1 to ${MAX_AUDIT_PAGE}.`);
  }
  return Number(value);
}

// The event log of the boards (handlers/events.mjs).

// An ISO time in UTC, to the second or the millisecond: what toISOString() writes, and the same without milliseconds.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export const MAX_EVENT_PAGE = 500;
export const MAX_EVENT_RANGE_DAYS = 31;
export const MAX_SAMPLE_HOURS = 168;
export const DEFAULT_SAMPLE_HOURS = 24;

/** A time in the query string, as epoch milliseconds; `fallback` when it is absent. */
export function requireTime(value, name, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  const ms = typeof value === 'string' && ISO_TIME.test(value) ? Date.parse(value) : NaN;
  // Date.parse takes 2026-02-31 for 3 March; such a date is not the one that was written.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw badRequest('invalid_time', `"${name}" must be a time in UTC, like 2026-11-02T14:30:00Z.`);
  }
  return ms;
}

/** The span of a query of the event log: `from` before `to`, at most 31 days apart. */
export function requireEventRange(fromMs, toMs) {
  if (!(fromMs < toMs)) throw badRequest('invalid_range', '"from" must be before "to".');
  if (toMs - fromMs > MAX_EVENT_RANGE_DAYS * 86_400_000) {
    throw badRequest('invalid_range', `A range of events may be at most ${MAX_EVENT_RANGE_DAYS} days long.`);
  }
}

/** Kinds of event, comma separated, each one of `known` and none twice; null when absent. */
export function requireKinds(value, known) {
  if (value === undefined) return null;
  const kinds = typeof value === 'string' ? value.split(',') : [];
  if (
    kinds.length === 0 ||
    kinds.length > known.length ||
    kinds.some((kind) => !known.includes(kind)) ||
    new Set(kinds).size !== kinds.length
  ) {
    throw badRequest('invalid_kinds', `"kinds" is a list of kinds separated by commas, from: ${known.join(', ')}.`);
  }
  return kinds;
}

/** Sources of the board log, comma separated, each one of `known` and none twice; null when absent. */
export function requireTags(value, known) {
  if (value === undefined) return null;
  const tags = typeof value === 'string' ? value.split(',') : [];
  if (
    tags.length === 0 ||
    tags.length > known.length ||
    tags.some((tag) => !known.includes(tag)) ||
    new Set(tags).size !== tags.length
  ) {
    throw badRequest('invalid_tags', `"tags" is a list of sources separated by commas, from: ${known.join(', ')}.`);
  }
  return tags;
}

/** The page size of the event log: 1 to 500, 500 when absent. */
export function requireEventPageSize(value) {
  if (value === undefined) return MAX_EVENT_PAGE;
  if (typeof value !== 'string' || !/^[1-9]\d{0,2}$/.test(value) || Number(value) > MAX_EVENT_PAGE) {
    throw badRequest('invalid_limit', `"limit" must be a number from 1 to ${MAX_EVENT_PAGE}.`);
  }
  return Number(value);
}

/** How many hours of a board's readings: 1 to 168, 24 when absent. */
export function requireHours(value) {
  if (value === undefined) return DEFAULT_SAMPLE_HOURS;
  if (typeof value !== 'string' || !/^[1-9]\d{0,2}$/.test(value) || Number(value) > MAX_SAMPLE_HOURS) {
    throw badRequest('invalid_hours', `"hours" must be a whole number from 1 to ${MAX_SAMPLE_HOURS}.`);
  }
  return Number(value);
}

// Searching and filtering the long lists (docs/search-filters.md): the activity log, the boards' events and
// their own log. Every filter rides on a Query of the list's key, read a page at a time, never a Scan.

export const MAX_SEARCH = 100;

/** Search text: one line of 1 to 100 characters, trimmed; null when absent. */
export function requireSearch(value) {
  if (value === undefined) return null;
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || text.length > MAX_SEARCH || CONTROL.test(text)) {
    throw badRequest('invalid_search', `"q" must be 1 to ${MAX_SEARCH} characters on one line.`);
  }
  return text;
}

/**
 * The spellings of search text that a DynamoDB filter looks for, since contains() tells capitals from small
 * letters: as written, all small, all capitals, and with a capital first letter. Never more than four.
 */
export function searchSpellings(text) {
  const lower = text.toLowerCase();
  return [...new Set([text, lower, text.toUpperCase(), lower.charAt(0).toUpperCase() + lower.slice(1)])];
}

/** Whether a stored text holds the search, as a DynamoDB filter of searchSpellings finds it. */
export function holdsSearch(value, text) {
  return typeof value === 'string' && searchSpellings(text).some((spelling) => value.includes(spelling));
}

/** The level of an event or a line of the board log: "warn" or "info"; null when absent. */
export function requireLevel(value) {
  if (value === undefined) return null;
  if (value !== 'warn' && value !== 'info') {
    throw badRequest('invalid_level', '"level" is warn or info.');
  }
  return value;
}

/** A list of names from `known`, comma separated, none twice; null when absent. */
function requireListOf(value, known, name, words) {
  if (value === undefined) return null;
  const list = typeof value === 'string' ? value.split(',') : [];
  if (
    list.length === 0 ||
    list.length > known.length ||
    list.some((item) => !known.includes(item)) ||
    new Set(list).size !== list.length
  ) {
    throw badRequest(`invalid_${name}`, `"${name}" is a list of ${words} separated by commas.`);
  }
  return list;
}

/** Actions of the activity log (lib/audit.mjs ACTIONS), comma separated; null when absent. */
export function requireActions(value, known) {
  return requireListOf(value, known, 'actions', 'actions of the activity log');
}

/** Outcomes of the activity log (ok, rejected, denied, error), comma separated; null when absent. */
export function requireOutcomes(value, known) {
  return requireListOf(value, known, 'outcomes', 'outcomes: ok, rejected, denied or error');
}

/** The span of a search of the activity log: `from` before `to`; either may be absent (null). */
export function requireAuditRange(fromValue, toValue) {
  const fromMs = fromValue === undefined ? null : requireTime(fromValue, 'from');
  const toMs = toValue === undefined ? null : requireTime(toValue, 'to');
  if (fromMs !== null && toMs !== null && !(fromMs < toMs)) {
    throw badRequest('invalid_range', '"from" must be before "to".');
  }
  return { fromMs, toMs };
}
