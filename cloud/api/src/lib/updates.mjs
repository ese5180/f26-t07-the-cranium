/**
 * The update history of the boards (GET /api/updates, docs/aws-iot.md "Update history"): every update
 * of every board, however it came. A deployment is an AWS IoT job, and AWS IoT Jobs keeps what became
 * of it on each board. An update over Bluetooth from a phone, or one written by USB or another tool,
 * is in no job: only the board says it happened, in its shadow (fw, bt) and in its log (the BT lines
 * of firmware 1.12.0 and later). This file turns what the boards said into facts, and the facts and
 * the jobs into one record per update.
 *
 * Facts. The recorder (recorder.mjs) makes them from the events and log lines it has just made, and
 * the backfill (handlers/updates.mjs) from the ones the events table already holds, with the same
 * function, factsFromItems, so that both make the same keys. Each is an item of the events table in
 * a partition of its own per board, kept for good (no ttl):
 *
 *   pk = "UPD#<thing>"
 *   sk = "V#<ISO time>"                        the version it reports changed: { from, to, confirmed, job? }
 *   sk = "C#<ISO time>"                        the version it runs was confirmed: { version }
 *   sk = "B#<count>#<from>#<to>#<result>"      its record of its update number <count> over Bluetooth,
 *                                             from the shadow's bt or a BT line: { from, to, result, proof, count }
 *   sk = "A#<ISO time>#<boot>.<seq>"           "firmware <to> has arrived" (a BT line): { to }
 *   sk = "R#<job>#<result>"                    how it said a cloud job ended (ota.last): { job, result }
 *   sk = "M#backfill"                          the backfill of this board is done: { facts, oldest }
 *
 * and every fact has `fact` (its kind) and `at`, epoch milliseconds: when the board said it. A fact is
 * put only where none is or where the one there is later (aws.mjs putUpdateFact), so the same thing
 * said again, by a retried message, by the board on every boot ("last update over Bluetooth: …"), by
 * the shadow and the log both, or by the backfill after the recorder, is one fact with its first time.
 *
 * Records. foldUpdates makes one record per update from a board's facts and its job executions:
 *
 *   { thing, from, to, how: deployment | bluetooth | usb_or_other, deployment, who, status,
 *     outcome: kept | rolled_back | not_installed | pending, startedAt, endedAt }
 *
 * A deployment is each of the board's executions, with what its status says. An update over Bluetooth
 * is each of the board's Bluetooth records (its count), with the result the board gave it. A version
 * change is the change of one of those when it is near it (the same versions, within a day; for a job,
 * the version change it reported with the job's id or in the job's time), the end of one of them when it
 * goes back where that one came from (a rollback, within a day), and otherwise an update of its own,
 * by USB or another tool. Who sent an update over Bluetooth is the person whose phone made the check
 * before the send (POST /api/firmware/{version}/bluetooth, firmware.bluetooth_send in the activity log)
 * for that version and board, in the two hours before the board first said anything of the update.
 *
 * No AWS here, and no clock: the caller passes the time.
 */

import { eventFromItem } from './events.mjs';
import { EXECUTION_STATUSES, isoTime } from './jobs.mjs';
import { lineFromItem } from './lines.mjs';
import { isThing, parseJobId, strictVersion } from './validate.mjs';

export const FACT_PARTITION = 'UPD#';
export const HOWS = Object.freeze(['deployment', 'bluetooth', 'usb_or_other']);
export const OUTCOMES = Object.freeze(['kept', 'rolled_back', 'not_installed', 'pending']);
export const BACKFILL_KEY = 'M#backfill';
export const DEFAULT_UPDATE_PAGE = 25;
export const MAX_UPDATE_PAGE = 100;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// The check before a Bluetooth send that is the one of an update: at most this long before the board
// first said anything of it, or this long after (the phone's clock and the board's differ).
export const CHECK_BEFORE_MS = 2 * HOUR_MS;
export const CHECK_AFTER_MS = 10 * MINUTE_MS;
// "firmware X has arrived" at most this long before the board first said anything else of the update.
const ARRIVAL_MS = 2 * HOUR_MS;
// A version change this close to a Bluetooth record of the same two versions is that update's.
const SAME_UPDATE_MS = DAY_MS;
// A version change back to where an unfinished update came from, this soon after it, is its rollback.
const ROLLBACK_MS = DAY_MS;
// A version change reported with no job, in a job's time on the board: from a little before the board
// started it to a while after it ended (the first report of the new image).
const JOB_BEFORE_MS = 5 * MINUTE_MS;
const JOB_AFTER_MS = 30 * MINUTE_MS;

// What the board says of its update over Bluetooth (firmware bt_ota_result_text), and what that means.
const BT_OUTCOME = Object.freeze({
  pending: 'pending',
  succeeded: 'kept',
  // A cloud update came after it, which a board starts only from firmware it has kept.
  superseded: 'kept',
  rolled_back: 'rolled_back',
  trial_lost: 'rolled_back',
  not_installed: 'not_installed',
  flash_error: 'not_installed',
  incompatible_board: 'not_installed',
  incompatible_layout: 'not_installed',
});
export const BT_RESULTS = Object.freeze(Object.keys(BT_OUTCOME));
const BT_PROOFS = Object.freeze(['none', 'cloud', 'person']);
// How a cloud job ended, as the board reports it (shadow ota.last).
const JOB_RESULTS = Object.freeze(['succeeded', 'failed', 'rolled_back', 'declined', 'refused', 'cancelled']);
// An execution's status, and what it means for the update on its board.
const EXECUTION_OUTCOME = Object.freeze({
  QUEUED: 'pending',
  IN_PROGRESS: 'pending',
  SUCCEEDED: 'kept',
  FAILED: 'not_installed',
  REJECTED: 'not_installed',
  TIMED_OUT: 'not_installed',
  CANCELED: 'not_installed',
  REMOVED: 'not_installed',
});
const OPEN_STATUSES = new Set(['QUEUED', 'IN_PROGRESS']);

// The board's BT lines (firmware/app/src/bt/bt_ota.c say_record and the offer of an image that arrived).
const LEVEL = '(?:(?:INF|WRN|ERR): )?';
const BT_RECORD_LINE = new RegExp(
  `^${LEVEL}(update over Bluetooth|last update over Bluetooth|on trial): ` +
    '(\\S+) from (\\S+), ([a-z_]+), proof ([a-z]+), update (\\d{1,10}) of this board$'
);
const ARRIVED_LINE = new RegExp(`^${LEVEL}firmware (\\S+) has arrived, hash [0-9a-f]{16}: press Button 1`);

const ISO = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';
const VERSION_TEXT = '\\d{1,3}\\.\\d{1,3}\\.\\d{1,5}\\+\\d{1,10}';
const FACT_KEYS = Object.freeze({
  version: new RegExp(`^V#${ISO}$`),
  confirmed: new RegExp(`^C#${ISO}$`),
  bluetooth: new RegExp(`^B#\\d{1,10}#${VERSION_TEXT}#${VERSION_TEXT}#[a-z_]{1,24}$`),
  arrived: new RegExp(`^A#${ISO}#\\d{1,10}\\.\\d{1,10}$`),
  result: /^R#[A-Za-z0-9_-]{1,64}#[a-z_]{1,24}$/,
  backfill: /^M#backfill$/,
});
const ANY_JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

const version = (value) => strictVersion(value)?.text === value;
const time = (value) => Number.isSafeInteger(value) && value > 0;

/** The partition of a board's facts. */
export function factPartition(thing) {
  return `${FACT_PARTITION}${thing}`;
}

function fact(thing, sk, kind, at, fields) {
  return { pk: factPartition(thing), sk, fact: kind, at, ...fields };
}

/** The facts in the text of one BT line, if it says something of an update. */
function factsOfLine(line) {
  const at = Date.parse(line.at);
  const record = BT_RECORD_LINE.exec(line.text);
  if (record !== null) {
    const [, , to, from, result, proof, digits] = record;
    const count = Number(digits);
    if (!version(to) || !version(from) || !BT_RESULTS.includes(result) || !BT_PROOFS.includes(proof)) return [];
    if (!Number.isSafeInteger(count) || count > 2 ** 32) return [];
    return [
      fact(line.thing, `B#${count}#${from}#${to}#${result}`, 'bluetooth', at, { from, to, result, proof, count }),
    ];
  }
  const arrived = ARRIVED_LINE.exec(line.text);
  if (arrived !== null && version(arrived[1])) {
    return [fact(line.thing, `A#${line.at}#${line.boot}.${line.seq}`, 'arrived', at, { to: arrived[1] })];
  }
  return [];
}

/**
 * The facts of an update that some items of the events table hold: the events of a shadow document
 * and the lines of a board's log (lib/events.mjs, lib/lines.mjs), as the recorder makes them or as
 * the table returns them. Anything else among them is passed over. One board's or several boards'.
 */
export function factsFromItems(items) {
  const events = [];
  const lines = [];
  for (const item of items) {
    if (typeof item?.sk !== 'string') continue;
    if (item.sk.startsWith('E#')) {
      const event = eventFromItem(item);
      if (event !== null) events.push(event);
    } else if (item.sk.startsWith('L#')) {
      const line = lineFromItem(item);
      if (line !== null && line.tag === 'BT') lines.push(line);
    }
  }
  // The job a board named in a report, for the version change in the same report: one second.
  const jobs = new Map();
  for (const event of events) {
    if (event.kind === 'update' && typeof event.job === 'string')
      jobs.set(`${event.thing} ${event.at.slice(0, 19)}`, event.job);
  }
  const facts = [];
  for (const event of events) {
    const at = Date.parse(event.at);
    if (event.kind === 'firmware' && event.what === 'changed' && version(event.from) && version(event.version)) {
      const job = jobs.get(`${event.thing} ${event.at.slice(0, 19)}`);
      facts.push(
        fact(event.thing, `V#${event.at}`, 'version', at, {
          from: event.from,
          to: event.version,
          confirmed: event.confirmed === true,
          ...(job === undefined ? {} : { job }),
        })
      );
    } else if (event.kind === 'firmware' && event.what === 'confirmed' && version(event.version)) {
      facts.push(fact(event.thing, `C#${event.at}`, 'confirmed', at, { version: event.version }));
    } else if (
      event.kind === 'bluetooth' &&
      event.what === 'record' &&
      version(event.from) &&
      version(event.to) &&
      BT_RESULTS.includes(event.result) &&
      Number.isInteger(event.count)
    ) {
      const { from, to, result, count } = event;
      const proof = BT_PROOFS.includes(event.proof) ? event.proof : 'none';
      facts.push(
        fact(event.thing, `B#${count}#${from}#${to}#${result}`, 'bluetooth', at, { from, to, result, proof, count })
      );
    } else if (
      event.kind === 'update' &&
      event.what === 'result' &&
      typeof event.job === 'string' &&
      JOB_RESULTS.includes(event.result)
    ) {
      facts.push(
        fact(event.thing, `R#${event.job}#${event.result}`, 'result', at, { job: event.job, result: event.result })
      );
    }
  }
  for (const line of lines) facts.push(...factsOfLine(line));
  return facts;
}

/** The marker that a board's backfill is done. */
export function backfillMarker(thing, { at, facts, oldest }) {
  return fact(thing, BACKFILL_KEY, 'backfill', at, { facts, oldest });
}

/**
 * A fact as the table returns it, checked again: { thing, sk, fact, at, ...fields }, or null for an
 * item that is not one. The marker of a backfill is a fact too (`fact: "backfill"`).
 */
export function factFromItem(item) {
  if (item === null || typeof item !== 'object' || typeof item.pk !== 'string' || typeof item.sk !== 'string')
    return null;
  const thing = item.pk.startsWith(FACT_PARTITION) ? item.pk.slice(FACT_PARTITION.length) : null;
  if (
    !isThing(thing) ||
    !Object.hasOwn(FACT_KEYS, item.fact) ||
    !FACT_KEYS[item.fact].test(item.sk) ||
    !time(item.at)
  ) {
    return null;
  }
  const base = { thing, sk: item.sk, fact: item.fact, at: item.at };
  switch (item.fact) {
    case 'version':
      if (!version(item.from) || !version(item.to)) return null;
      return {
        ...base,
        from: item.from,
        to: item.to,
        confirmed: item.confirmed === true,
        job: typeof item.job === 'string' && ANY_JOB_ID.test(item.job) ? item.job : null,
      };
    case 'confirmed':
      return version(item.version) ? { ...base, version: item.version } : null;
    case 'bluetooth':
      if (!version(item.from) || !version(item.to) || !BT_RESULTS.includes(item.result)) return null;
      if (!Number.isSafeInteger(item.count) || item.count < 0) return null;
      return {
        ...base,
        from: item.from,
        to: item.to,
        result: item.result,
        count: item.count,
        proof: BT_PROOFS.includes(item.proof) ? item.proof : 'none',
      };
    case 'arrived':
      return version(item.to) ? { ...base, to: item.to } : null;
    case 'result':
      if (typeof item.job !== 'string' || !ANY_JOB_ID.test(item.job) || !JOB_RESULTS.includes(item.result)) return null;
      return { ...base, job: item.job, result: item.result };
    default:
      return {
        ...base,
        facts: Number.isSafeInteger(item.facts) ? item.facts : 0,
        oldest: time(item.oldest) ? item.oldest : null,
      };
  }
}

/** A time in epoch milliseconds from a number of them or an ISO text, or null. */
function msOf(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

const byTime = (a, b) => a.at - b.at || (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0);

/** The candidate nearest in time, or null. */
function nearest(candidates, at, timeOf) {
  let best = null;
  for (const candidate of candidates) {
    if (best === null || Math.abs(timeOf(candidate) - at) < Math.abs(timeOf(best) - at)) best = candidate;
  }
  return best;
}

/**
 * The updates of one board, from its facts (factFromItem) and its job executions (as ListJobExecutionsForThing
 * lists them, or as GET /api/devices/{thing} has them: times in ms or ISO). Each record is
 * { thing, how, from, to, deployment, count, status, outcome, startedAt, endedAt, firstAt } with times in ms,
 * and `anchor` for a Bluetooth record: the time the board first said anything of it, which the check
 * before the send is looked for around (attachChecks). Newest first.
 */
export function foldUpdates({ thing, facts, executions = [], nowMs }) {
  const records = [];
  const deployments = [];
  for (const execution of executions) {
    const jobId = execution?.jobId ?? execution?.deployment;
    if (typeof jobId !== 'string' || !ANY_JOB_ID.test(jobId) || !EXECUTION_STATUSES.includes(execution.status))
      continue;
    const startedAt = msOf(execution.startedAt) ?? msOf(execution.queuedAt) ?? msOf(execution.lastUpdatedAt);
    if (startedAt === null) continue;
    const open = OPEN_STATUSES.has(execution.status);
    const record = {
      thing,
      how: 'deployment',
      from: null,
      to: parseJobId(jobId)?.version ?? null,
      deployment: jobId,
      count: null,
      status: execution.status,
      outcome: EXECUTION_OUTCOME[execution.status],
      startedAt,
      endedAt: open ? null : (msOf(execution.lastUpdatedAt) ?? startedAt),
      firstAt: startedAt,
    };
    deployments.push(record);
    records.push(record);
  }

  // One fact for each key, at its first time, as the table keeps them.
  const byKey = new Map();
  for (const item of facts) {
    if (item === null || item.thing !== thing) continue;
    const there = byKey.get(item.sk);
    if (there === undefined || there.at > item.at) byKey.set(item.sk, item);
  }
  const own = [...byKey.values()];
  const ofKind = (kind) => own.filter((item) => item.fact === kind).sort(byTime);

  // Over Bluetooth: one record for each of the board's own counts, with the first result it gave that is not "pending".
  const bluetooth = new Map();
  for (const item of ofKind('bluetooth')) {
    const key = `${item.count}|${item.from}|${item.to}`;
    let record = bluetooth.get(key);
    if (record === undefined) {
      record = {
        thing,
        how: 'bluetooth',
        from: item.from,
        to: item.to,
        deployment: null,
        count: item.count,
        status: null,
        outcome: 'pending',
        startedAt: item.at,
        endedAt: null,
        firstAt: item.at,
        final: false,
      };
      bluetooth.set(key, record);
      records.push(record);
    }
    if (item.result !== 'pending' && !record.final) {
      record.final = true;
      record.outcome = BT_OUTCOME[item.result];
      record.endedAt = item.at;
    }
  }
  const viaPhone = [...bluetooth.values()];

  for (const change of ofKind('version')) {
    // The change of an update over Bluetooth of the same two versions.
    const phone = nearest(
      viaPhone.filter(
        (record) =>
          record.from === change.from &&
          record.to === change.to &&
          record.changedAt === undefined &&
          Math.abs(change.at - record.firstAt) <= SAME_UPDATE_MS
      ),
      change.at,
      (record) => record.firstAt
    );
    if (phone !== null) {
      phone.changedAt = change.at;
      continue;
    }
    // The change of a deployment: reported with its job, or in its time on the board.
    const job = deployments.find(
      (record) =>
        record.changedAt === undefined &&
        (change.job !== null
          ? change.job === record.deployment
          : record.to === change.to &&
            change.at >= record.startedAt - JOB_BEFORE_MS &&
            change.at <= (record.endedAt ?? nowMs) + JOB_AFTER_MS)
    );
    if (job !== undefined) {
      job.from = change.from;
      job.to ??= change.to;
      job.changedAt = change.at;
      continue;
    }
    // Back where an update that was not kept came from: its rollback.
    const undone = records
      .filter(
        (record) =>
          record.changedAt !== undefined &&
          record.revertedAt === undefined &&
          record.to === change.from &&
          record.from === change.to &&
          record.outcome !== 'kept' &&
          change.at >= record.changedAt &&
          change.at - record.changedAt <= ROLLBACK_MS
      )
      .sort((a, b) => b.changedAt - a.changedAt)[0];
    if (undone !== undefined) {
      undone.revertedAt = change.at;
      if (undone.outcome === 'pending' || undone.outcome === 'not_installed') undone.outcome = 'rolled_back';
      undone.endedAt ??= change.at;
      continue;
    }
    // A job that AWS IoT no longer lists, by its id in the board's report.
    if (change.job !== null) {
      const record = {
        thing,
        how: 'deployment',
        from: change.from,
        to: change.to,
        deployment: change.job,
        count: null,
        status: null,
        outcome: change.confirmed ? 'kept' : 'pending',
        startedAt: change.at,
        endedAt: change.confirmed ? change.at : null,
        firstAt: change.at,
        changedAt: change.at,
      };
      deployments.push(record);
      records.push(record);
      continue;
    }
    records.push({
      thing,
      how: 'usb_or_other',
      from: change.from,
      to: change.to,
      deployment: null,
      count: null,
      status: null,
      outcome: change.confirmed ? 'kept' : 'pending',
      startedAt: change.at,
      endedAt: change.confirmed ? change.at : null,
      firstAt: change.at,
      changedAt: change.at,
    });
  }

  // A confirmation ends the update that last brought the board to that version, if nothing else has.
  for (const confirmation of ofKind('confirmed')) {
    const record = records
      .filter(
        (candidate) =>
          candidate.to === confirmation.version &&
          candidate.changedAt !== undefined &&
          candidate.changedAt <= confirmation.at &&
          candidate.revertedAt === undefined
      )
      .sort((a, b) => b.changedAt - a.changedAt)[0];
    if (
      record !== undefined &&
      record.outcome === 'pending' &&
      (record.how !== 'deployment' || record.status === null)
    ) {
      record.outcome = 'kept';
      record.endedAt = confirmation.at;
    }
  }

  // A job the board said it rolled back, whatever AWS IoT calls its end.
  for (const result of ofKind('result')) {
    const record = deployments.find((candidate) => candidate.deployment === result.job);
    if (record !== undefined && result.result === 'rolled_back' && record.outcome !== 'kept')
      record.outcome = 'rolled_back';
  }

  // An update over Bluetooth starts when its image arrived, if the board said so.
  const arrivals = ofKind('arrived');
  for (const record of viaPhone) {
    const first = Math.min(record.firstAt, record.changedAt ?? Infinity);
    const arrived = arrivals
      .filter((item) => item.to === record.to && item.at <= first + MINUTE_MS && first - item.at <= ARRIVAL_MS)
      .sort((a, b) => b.at - a.at)[0];
    record.anchor = arrived === undefined ? first : Math.min(arrived.at, first);
    record.startedAt = record.anchor;
  }

  for (const record of records) {
    delete record.final;
    record.sortAt = record.startedAt ?? record.endedAt;
    record.id = updateId(record);
  }
  return records.sort(newestFirst);
}

/** A record's id: unique among the records of every board, and the same on every read. */
function updateId(record) {
  if (record.how === 'deployment') return `deployment:${record.thing}:${record.deployment}`;
  if (record.how === 'bluetooth') return `bluetooth:${record.thing}:${record.count}:${record.from}:${record.to}`;
  return `usb_or_other:${record.thing}:${new Date(record.changedAt).toISOString()}`;
}

/** The order of the list: newest first, by when an update started, and by id within the same time. */
export function newestFirst(a, b) {
  if (a.sortAt !== b.sortAt) return b.sortAt - a.sortAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** The span of the activity log in which the check before a Bluetooth update's send is looked for. */
export function checkWindow(record) {
  return { fromMs: record.anchor - CHECK_BEFORE_MS, toMs: record.anchor + CHECK_AFTER_MS };
}

/**
 * Of the entries of the activity log (as stored: { at, actor, action, target, outcome, detail }), the
 * check before the send of this update over Bluetooth: one that was answered yes, for its version, for
 * this board or for no board named, in its window (checkWindow); one for this board before one that
 * names none, and the latest of those. Null if there is none.
 */
export function pickCheck(record, entries) {
  const { fromMs, toMs } = checkWindow(record);
  const fitting = entries.filter((entry) => {
    const at = msOf(entry?.at);
    const named = entry?.detail?.thing;
    return (
      entry?.action === 'firmware.bluetooth_send' &&
      entry.outcome === 'ok' &&
      entry.target === record.to &&
      at !== null &&
      at >= fromMs &&
      at <= toMs &&
      (named === undefined || named === record.thing)
    );
  });
  const ranked = fitting.sort(
    (a, b) =>
      Number(b.detail?.thing === record.thing) - Number(a.detail?.thing === record.thing) || msOf(b.at) - msOf(a.at)
  );
  return ranked[0] ?? null;
}

/**
 * What a person is called in "over Bluetooth from Vihaan’s phone": the first part of the address
 * before the @, up to a dot, a plus, a dash or an underscore, without the digits at its end
 * ("vihaan1" is Vihaan), with a capital. "" if there is none.
 */
export function personName(email) {
  if (typeof email !== 'string') return '';
  const local = email.split('@')[0] ?? '';
  const first = local.split(/[._+-]/).find((part) => part !== '') ?? '';
  const letters = first.replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
  // An address that is all digits has nothing but them to go by.
  const name = letters.replace(/\d+$/, '') || letters;
  return name === '' ? '' : `${name[0].toUpperCase()}${name.slice(1)}`;
}

/**
 * The first word of the name an account has in the user pool (its given name, else its name), cleaned to
 * what a name in a sentence may hold: letters, with accents, apostrophes and hyphens. "" if it has none.
 */
export function accountName(given, full) {
  for (const candidate of [given, full]) {
    if (typeof candidate !== 'string') continue;
    const word = candidate.trim().split(/\s+/)[0] ?? '';
    const name = word.replace(/[^\p{L}\p{M}'’-]/gu, '').slice(0, 32);
    if (name !== '') return `${name[0].toUpperCase()}${name.slice(1)}`;
  }
  return '';
}

/** A person as an update names them, or null. */
export function personOf(person) {
  if (person === null || typeof person !== 'object') return null;
  const sub = typeof person.sub === 'string' ? person.sub.slice(0, 128) : '';
  const email = typeof person.email === 'string' ? person.email.slice(0, 320) : '';
  if (sub === '' && email === '') return null;
  return { sub, email, name: personName(email) };
}

/** A record as the API returns it. */
export function presentUpdate(record) {
  return {
    id: record.id,
    thing: record.thing,
    from: record.from ?? null,
    to: record.to ?? null,
    how: record.how,
    deployment: record.deployment ?? null,
    who: record.who ?? null,
    outcome: record.outcome,
    startedAt: isoTime(record.startedAt),
    endedAt: isoTime(record.endedAt),
    status: record.status ?? null,
  };
}

/** A page cursor: where the last page ended, opaque to the client. */
export function encodeUpdateCursor(record) {
  return Buffer.from(`${new Date(record.sortAt).toISOString()}|${record.id}`, 'utf8').toString('base64url');
}

/** { sortAt, id } from a cursor, or null if the text is not one of this list. */
export function decodeUpdateCursor(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 400 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) return null;
  const decoded = bytes.toString('utf8');
  const bar = decoded.indexOf('|');
  if (bar < 0) return null;
  const at = decoded.slice(0, bar);
  const id = decoded.slice(bar + 1);
  const sortAt = new RegExp(`^${ISO}$`).test(at) ? Date.parse(at) : NaN;
  if (
    !Number.isFinite(sortAt) ||
    !/^(?:deployment|bluetooth|usb_or_other):cranium-[0-9a-f]{16}:[\x21-\x7e]{1,120}$/.test(id)
  ) {
    return null;
  }
  return { sortAt, id };
}

/** Whether a record comes after the end of the last page. */
export function afterCursor(record, cursor) {
  return newestFirst(record, cursor) > 0;
}

/**
 * How the updates that ended since `sinceMs` went, for fleet health: { succeeded, failed, rolledBack }.
 * Deployments are counted elsewhere (from what the boards reported of their jobs), so only the others
 * are counted here: over Bluetooth, and by USB or another tool.
 */
export function updateCounts(records, { sinceMs }) {
  const counts = { succeeded: 0, failed: 0, rolledBack: 0 };
  for (const record of records) {
    if (record.how === 'deployment' || !Number.isFinite(record.endedAt) || record.endedAt < sinceMs) continue;
    if (record.outcome === 'kept') counts.succeeded += 1;
    else if (record.outcome === 'rolled_back') counts.rolledBack += 1;
    else if (record.outcome === 'not_installed') counts.failed += 1;
  }
  return counts;
}

/** The page size of the update history: 1 to 100, 25 when absent; null when it is not one. */
export function pageSizeOf(value) {
  if (value === undefined) return DEFAULT_UPDATE_PAGE;
  if (typeof value !== 'string' || !/^[1-9]\d{0,2}$/.test(value) || Number(value) > MAX_UPDATE_PAGE) return null;
  return Number(value);
}
