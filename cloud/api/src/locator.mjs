/**
 * The location function (LocationFn): from what a board hears of the Wi-Fi around it to where it is
 * (lib/position.mjs says what a scan may hold and what is kept).
 *
 * For each scan from the rule LocationRule:
 *
 *   1. hold the message to the contract; a message that breaks it is dropped, with a line in the log
 *      that names the board and why, never what it held
 *   2. read what is known of the board, and decide (position.mjs decide): nothing to do, the same
 *      access points as before, too few of them, or a solve
 *   3. for a solve, claim it first, by a write that only succeeds if nobody else wrote since the read,
 *      so that a second copy of the message, or a second board message at the same moment, does not
 *      solve again; then ask AWS IoT Core Device Location (GetPositionEstimate, the Wi-Fi solver)
 *   4. keep the answer: the position, the last 20, and an event when the board has a position for the
 *      first time or has moved by more than 1 km, with an alert for a move
 *
 * The scan itself, the BSSIDs and their signals, goes to AWS for the solve and nowhere else: not to
 * the table, not to the log. A solve that fails is not tried again for this message (Lambda does not
 * retry this function: EventInvokeConfig, infra/template.yaml), and the next scan after 10 minutes may
 * try again, even with the same access points.
 *
 * Like app.mjs, nothing here imports the AWS SDK: the store is passed in (aws-map.mjs createLocationStore).
 */

import { randomBytes } from 'node:crypto';

import { describeError } from './http.mjs';
import { EVENT_DAYS, eventKey } from './lib/events.mjs';
import {
  changeText,
  decide,
  emptyLocation,
  estimateRequest,
  positionFromGeoJson,
  readScan,
  withAnswer,
  withAttempt,
  withConfirmation,
  withFailure,
  withTooFew,
} from './lib/position.mjs';

/**
 * @param {object} options
 * @param {{ getLocation: Function, putLocation: Function, putEvent: Function, solvePosition: Function }} options.store
 * @param {{ raise: Function } | null} [options.alerts]   the alerter (alerts.mjs), for a move
 * @param {() => number|Date} [options.now]
 * @param {(count: number) => string} [options.randomHex]
 * @param {(line: object) => void} [options.log]
 * @returns {(message: object) => Promise<{ outcome: string }>} the Lambda handler
 */
export function createLocator({
  store,
  alerts = null,
  now = Date.now,
  randomHex = (count) => randomBytes(count).toString('hex'),
  log = (line) => console.log(JSON.stringify(line)),
}) {
  if (store === undefined || store === null) throw new TypeError('createLocator needs a store');
  const clock = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : value;
  };

  /** The event of a first position or a move, as the recorder's events are (lib/events.mjs). */
  function eventOf(thing, change, position, distance, atMs) {
    const digits = String(randomHex(3)).slice(0, 6).toLowerCase();
    return {
      pk: thing,
      sk: eventKey(atMs, /^[0-9a-f]{6}$/.test(digits) ? digits : randomBytes(3).toString('hex')),
      kind: 'health',
      what: change === 'first' ? 'located' : 'moved',
      level: change === 'first' ? 'info' : 'warn',
      text: changeText(change, position, distance),
      ttl: Math.floor(atMs / 1000) + EVENT_DAYS * 86_400,
    };
  }

  return async function handler(message) {
    const scan = readScan(message, { nowMs: clock() });
    if (scan.ignored !== undefined) {
      log({ level: 'warn', event: 'scan_ignored', reason: scan.ignored });
      return { outcome: 'ignored' };
    }
    const { thing } = scan;
    const known = (await store.getLocation(thing)) ?? emptyLocation(thing);
    const rev = Number.isSafeInteger(known.rev) ? known.rev : 0;
    const decision = decide(known, scan, clock());
    if (decision.act === 'drop') {
      log({ event: 'scan_skipped', thing, why: decision.why });
      return { outcome: decision.why };
    }
    if (decision.act === 'too_few' || decision.act === 'confirm') {
      const next =
        decision.act === 'too_few' ? withTooFew(known, scan.tooFew, scan.receivedMs) : withConfirmation(known, scan);
      const put = await store.putLocation({ ...next, rev: rev + 1 }, rev);
      log({ event: put.ok ? 'scan_noted' : 'scan_raced', thing, act: decision.act });
      return { outcome: put.ok ? decision.act : 'raced' };
    }

    // A solve: claimed first.
    const claimed = { ...withAttempt(known, scan), rev: rev + 1 };
    if (!(await store.putLocation(claimed, rev)).ok) {
      log({ event: 'scan_raced', thing, act: 'solve' });
      return { outcome: 'raced' };
    }
    let answer;
    try {
      answer = await store.solvePosition(estimateRequest(scan.aps));
    } catch (error) {
      log({ level: 'error', event: 'solve_failed', thing, error: describeError(error) });
      await store.putLocation({ ...withFailure(claimed, scan), rev: rev + 2 }, rev + 1);
      return { outcome: 'failed' };
    }
    const found = answer.found ? positionFromGeoJson(answer.geoJson) : null;
    if (answer.found && found === null) log({ level: 'warn', event: 'solve_unreadable', thing });
    const { item, change, distance } = withAnswer(claimed, scan, found);
    const stored = await store.putLocation({ ...item, rev: rev + 2 }, rev + 1);
    log({
      event: found === null ? 'solve_unplaced' : 'solved',
      thing,
      accessPoints: scan.count,
      accuracy: found?.accuracy ?? null,
      change,
      stored: stored.ok,
    });
    if (!stored.ok || change === null) return { outcome: found === null ? 'unsolved' : 'solved' };

    const event = eventOf(thing, change, item.position, distance, scan.receivedMs);
    await store.putEvent(event);
    if (change === 'moved' && alerts !== null) {
      await alerts.raise({ kind: 'moved', thing, text: event.text, at: scan.receivedMs });
    }
    return { outcome: change };
  };
}
