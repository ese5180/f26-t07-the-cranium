/**
 * Where a board is, from the Wi-Fi it hears (docs/fleet.md, "Location by Wi-Fi").
 *
 * From firmware 1.13.0 an nrf7002dk board publishes, QoS 0, on cranium/<thing>/location what it
 * hears of the access points around it, and the rule LocationRule (infra/template.yaml) hands it to
 * the location function (locator.mjs) as
 *
 *   SELECT *, topic(2) AS thing, timestamp() AS received FROM 'cranium/+/location'
 *   WHERE startswith(topic(2), 'cranium-') AND isUndefined(thing) AND isUndefined(received)
 *
 *   { aps: [{ mac, rss }, ...], boot, t, thing, received }
 *
 * `thing` comes from the topic, which only that board may publish on, and `received` from AWS IoT.
 * Everything else is the board's, and is held to the contract strictly: 2 to 10 access points,
 * each exactly { mac, rss }; a BSSID written as six pairs of hex digits with colons, unicast and
 * globally administered (the two lowest bits of the first byte clear: a phone's hotspot and other
 * randomised addresses move, and say nothing about where the board is); a signal from -120 to
 * 0 dBm; no BSSID twice; `boot` and `t` whole numbers; and no other field. A message that breaks
 * any of it is not solved at all. One with fewer than 2 access points is noted as "too few", so
 * that the console can say why the board has no position, and is not solved either.
 *
 * What is kept is the position and the last 20 of them, never the access points: of those only
 * their number and a short hash of the set, to tell whether the board hears the same ones as last
 * time. The hash covers the board's thing name and the sorted BSSIDs; it is 64 bits of SHA-256,
 * enough to notice a change and too short to be worth much to anyone holding a list of BSSIDs.
 *
 * Items, in the events table beside the boards' own (one partition for every board, so that the
 * list of boards reads them with one query):
 *
 *   pk = "LOC", sk = <thing>   { rev, position, history, status, statusAt, apCount, apHash,
 *                                outcome, triedAt, seenAt, checkedAt }
 *
 * `rev` counts the writes, and every write is conditional on the one before it (aws-map.mjs), so that two
 * copies of a message never both solve.
 *
 * No AWS here, and no clock: the caller passes the time.
 */

import { createHash } from 'node:crypto';

import { isThing } from './validate.mjs';

export const LOCATION_PK = 'LOC';
export const MIN_APS = 2;
export const MAX_APS = 10;
export const RSS_MIN = -120;
export const RSS_MAX = 0;
// At most one solve per board in this time, whatever the board sends (docs/fleet.md).
export const SOLVE_FLOOR_MS = 10 * 60_000;
export const HISTORY_KEPT = 20;
// A position this far from the last one, and further than both of their uncertainties together,
// is a move: an event on the board, and an alert.
export const MOVED_METRES = 1000;
// The statuses of a board's location, as the API gives them: no scan yet ("none" is the absence
// of an item), a position, too few access points, a scan AWS could not place, a solve that failed.
export const STATUSES = Object.freeze(['ok', 'too_few', 'unsolved', 'failed']);

const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i;
const FIELDS = new Set(['aps', 'boot', 't', 'thing', 'received']);
const AP_FIELDS = ['mac', 'rss'];
const HASH = /^[0-9a-f]{16}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_UPTIME = 2 ** 42;
const MAX_COUNT = 2 ** 32 - 1;
const EARTH_RADIUS_M = 6_371_008.8;

const whole = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** True for a BSSID that names one access point for good: unicast, globally administered, not all zero. */
export function isFixedBssid(mac) {
  if (typeof mac !== 'string' || !MAC.test(mac)) return false;
  const first = Number.parseInt(mac.slice(0, 2), 16);
  return (first & 0x03) === 0 && mac.replace(/[:0]/g, '') !== '';
}

/**
 * What one message of the location topic becomes:
 *   { thing, aps, count, hash, receivedMs }   to solve; `aps` in lower case, as sent
 *   { thing, tooFew: count, receivedMs }      fewer than 2 access points
 *   { ignored: why }                          anything else: not solved, not stored
 *
 * @param {object} message   as the rule selects it
 * @param {{ nowMs: number }} options  the function's clock, for a time of arrival that is missing
 */
export function readScan(message, { nowMs }) {
  if (!isPlain(message)) return { ignored: 'not_an_object' };
  const thing = message.thing;
  if (!isThing(thing)) return { ignored: 'not_a_board' };
  if (Object.keys(message).some((key) => !FIELDS.has(key))) return { ignored: 'unexpected_field' };
  if (!whole(message.boot, 0, MAX_COUNT) || !whole(message.t, 0, MAX_UPTIME)) return { ignored: 'bad_count' };
  const received = message.received;
  const receivedMs = Number.isSafeInteger(received) && received > 0 && Math.abs(received - nowMs) < 86_400_000
    ? received
    : nowMs;
  const { aps } = message;
  if (!Array.isArray(aps)) return { ignored: 'no_access_points' };
  if (aps.length > MAX_APS) return { ignored: 'too_many' };
  const seen = new Set();
  const clean = [];
  for (const ap of aps) {
    if (!isPlain(ap) || Object.keys(ap).length !== AP_FIELDS.length || !AP_FIELDS.every((key) => Object.hasOwn(ap, key))) {
      return { ignored: 'bad_access_point' };
    }
    if (typeof ap.mac !== 'string' || !MAC.test(ap.mac)) return { ignored: 'bad_mac' };
    if (!isFixedBssid(ap.mac)) return { ignored: 'not_global' };
    if (!whole(ap.rss, RSS_MIN, RSS_MAX)) return { ignored: 'bad_rss' };
    const mac = ap.mac.toLowerCase();
    if (seen.has(mac)) return { ignored: 'repeated_mac' };
    seen.add(mac);
    clean.push({ mac, rss: ap.rss });
  }
  if (clean.length < MIN_APS) return { thing, tooFew: clean.length, receivedMs };
  return { thing, aps: clean, count: clean.length, hash: apSetHash(thing, clean), receivedMs };
}

/** 16 hex digits for the set of access points a board heard: the same set, the same hash, in any order. */
export function apSetHash(thing, aps) {
  const macs = aps.map((ap) => ap.mac.toLowerCase()).sort();
  return createHash('sha256').update(`cranium location v1\n${thing}\n${macs.join(',')}`, 'utf8').digest('hex').slice(0, 16);
}

/** The request of GetPositionEstimate for a scan: the Wi-Fi solver, with nothing but BSSID and signal. */
export function estimateRequest(aps) {
  return { WiFiAccessPoints: aps.map(({ mac, rss }) => ({ MacAddress: mac, Rss: rss })) };
}

/**
 * The position in the GeoJSON that GetPositionEstimate answers with, or null if it holds none:
 *
 *   { "type": "Point", "coordinates": [lon, lat, alt?],
 *     "properties": { "horizontalAccuracy": 303, "horizontalConfidenceLevel": 0.68, "timestamp": "..." } }
 *
 * -> { lat, lon, accuracy } with the accuracy in whole metres (at least 1), lat and lon to six places.
 */
export function positionFromGeoJson(text) {
  let value = text;
  if (typeof text === 'string') {
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!isPlain(value) || value.type !== 'Point' || !Array.isArray(value.coordinates)) return null;
  const [lon, lat] = value.coordinates;
  const accuracy = value.properties?.horizontalAccuracy;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1e7) return null;
  return { lat: round6(lat), lon: round6(lon), accuracy: Math.max(1, Math.round(accuracy)) };
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** The distance in metres between two positions on the Earth's surface (haversine). */
export function distanceMetres(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True if a new position is a move: more than 1 km away, and further than both uncertainties together. */
export function isMove(before, after) {
  if (!before || !after) return false;
  const distance = distanceMetres(before, after);
  return distance > MOVED_METRES && distance > before.accuracy + after.accuracy;
}

/** "40 m", "1.3 km", "12 km". */
export function metres(value) {
  if (value < 1000) return `${Math.round(value)} m`;
  return value < 10_000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value / 1000)} km`;
}

/**
 * What the location function does with a scan, given what it has on the board: one of
 *   { act: 'drop', why }          nothing is written (too soon, or nothing new)
 *   { act: 'confirm' }            the same access points as the position came from: noted, not solved
 *   { act: 'solve' }              ask AWS
 *   { act: 'too_few' }            note that there were too few
 *
 * At most one solve per board in SOLVE_FLOOR_MS, and not while the set of access points is the one the
 * last solve was asked about (`apHash`), unless that solve failed or never finished (`outcome`). A write
 * of any kind also happens at most once in that time, so a board that sends too often costs a read and
 * nothing more.
 */
export function decide(item, scan, nowMs) {
  const seenAt = Number.isFinite(item?.seenAt) ? item.seenAt : null;
  if (seenAt !== null && nowMs - seenAt < SOLVE_FLOOR_MS) return { act: 'drop', why: 'too_soon' };
  if (scan.tooFew !== undefined) return { act: 'too_few' };
  if (item?.apHash === scan.hash) {
    if (item.outcome === 'ok' && item.position) return { act: 'confirm' };
    if (item.outcome === 'unsolved') return { act: 'drop', why: 'same_access_points' };
  }
  return { act: 'solve' };
}

/** The item as it is before anything about a board is known. */
export function emptyLocation(thing) {
  return {
    pk: LOCATION_PK, sk: thing, rev: 0, position: null, history: [], status: null, statusAt: null, apCount: null,
    apHash: null, outcome: null, triedAt: null, seenAt: null, checkedAt: null,
  };
}

const iso = (ms) => new Date(ms).toISOString();

/** The item after a scan with too few access points. */
export function withTooFew(item, count, atMs) {
  return { ...item, status: 'too_few', statusAt: iso(atMs), apCount: count, seenAt: atMs };
}

/** The item after the same access points were heard again: the position still holds. */
export function withConfirmation(item, scan) {
  const at = iso(scan.receivedMs);
  return { ...item, status: 'ok', statusAt: at, apCount: scan.count, seenAt: scan.receivedMs, checkedAt: at };
}

/** The item while a solve is under way: claimed, so that a second copy of the message does not solve again. */
export function withAttempt(item, scan) {
  return {
    ...item, apCount: scan.count, apHash: scan.hash, outcome: 'pending', triedAt: scan.receivedMs, seenAt: scan.receivedMs,
  };
}

/**
 * The item after AWS answered, and what that means for the board:
 *   { item, change: 'first' | 'moved' | null, distance }
 * `found` is the position from positionFromGeoJson, or null when AWS could not place the scan.
 */
export function withAnswer(item, scan, found) {
  const at = iso(scan.receivedMs);
  if (found === null) {
    return { item: { ...item, status: 'unsolved', statusAt: at, outcome: 'unsolved' }, change: null, distance: null };
  }
  const position = { ...found, at };
  const before = item.position;
  const history = [position, ...(Array.isArray(item.history) ? item.history : [])].slice(0, HISTORY_KEPT);
  const next = { ...item, position, history, status: 'ok', statusAt: at, outcome: 'ok', checkedAt: at };
  if (!before) return { item: next, change: 'first', distance: null };
  const distance = distanceMetres(before, position);
  return { item: next, change: isMove(before, position) ? 'moved' : null, distance };
}

/** The item after a solve that failed: tried again after SOLVE_FLOOR_MS, even for the same access points. */
export function withFailure(item, scan) {
  return { ...item, status: 'failed', statusAt: iso(scan.receivedMs), outcome: 'failed' };
}

/** The text of the event a change makes. Never a coordinate and never a BSSID: those are not for the event log. */
export function changeText(change, position, distance) {
  if (change === 'first') return `Position found from Wi-Fi, to within ${metres(position.accuracy)}`;
  return `Moved ${metres(distance)} from where it was, to within ${metres(position.accuracy)}`;
}

// Reading back. Items are checked again on the way out: the table is not trusted either.

/** A position as the API returns it, or null: { lat, lon, accuracy, at }. */
export function positionFromItem(value) {
  if (!isPlain(value)) return null;
  const { lat, lon, accuracy, at } = value;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (!whole(accuracy, 1, 1e7) || typeof at !== 'string' || !ISO.test(at)) return null;
  return { lat, lon, accuracy, at };
}

/**
 * A board's location as the API returns it, from its item or from none:
 *   { status: 'none' | 'ok' | 'too_few' | 'unsolved' | 'failed', at, apCount, checkedAt }
 * `at` is when the status was set, `checkedAt` when the position was last heard to hold.
 */
export function locationFromItem(item) {
  if (!isPlain(item) || !STATUSES.includes(item.status)) {
    return { status: 'none', at: null, apCount: null, checkedAt: null };
  }
  return {
    status: item.status,
    at: typeof item.statusAt === 'string' && ISO.test(item.statusAt) ? item.statusAt : null,
    apCount: whole(item.apCount, 0, MAX_APS) ? item.apCount : null,
    checkedAt: typeof item.checkedAt === 'string' && ISO.test(item.checkedAt) ? item.checkedAt : null,
  };
}

/** The positions of an item, newest first, at most HISTORY_KEPT. */
export function historyFromItem(item) {
  const history = Array.isArray(item?.history) ? item.history : [];
  return history.map(positionFromItem).filter((position) => position !== null).slice(0, HISTORY_KEPT);
}

/** True for an item of a location this module made: its hash, if any, is the short kind. */
export function isLocationItem(item) {
  return isPlain(item) && item.pk === LOCATION_PK && isThing(item.sk) &&
    (item.apHash === null || item.apHash === undefined || HASH.test(item.apHash));
}
