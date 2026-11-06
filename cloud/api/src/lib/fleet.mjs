/**
 * The fleet's rules, without AWS (docs/fleet.md, Groups and rollouts): which boards a release
 * may go to and why the others are left out, which board is the canary, how AWS IoT Jobs is told
 * to pace a wave and stop it, what a staged rollout is as a record, and how the fleet is doing.
 *
 * Every function here is plain: it takes what the handlers read and gives back what they act on
 * or answer with. Nothing here decides who may do something; the router does (app.mjs).
 *
 * A board here is a fleet board (handlers/fleet.mjs): { thing, name, type, bluetoothOnly, online,
 * lastSeen, version, groups, ... }, where `version` is what it runs as far as it is known: what it
 * reported itself, or for a Bluetooth-only board what a phone last saw.
 */

import { badRequest } from '../http.mjs';
import { BOARD_LABELS, isBluetoothOnly } from './boards.mjs';
import { compareVersions, parseVersion } from './mcuboot.mjs';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// "Update everything" and a rollback leave out a board that has not reported for this long: a
// board that is away is not going to take an update soon, and would hold a wave open.
export const OFFLINE_LONG_MS = DAY_MS;
// On the Overview, a board that has been offline this long needs looking at.
export const ATTENTION_OFFLINE_MS = HOUR_MS;
// Signal and memory below these need looking at: the console's "Weak" band, and the recorder's line.
export const WEAK_SIGNAL_DBM = -75;
export const LOW_HEAP_SHARE = 0.15;
export const HEALTH_DAYS = 7;

export const DEFAULT_CANARY = 1;
export const MAX_CANARY = 5;
export const DEFAULT_WAVE = 1;
export const MAX_WAVE = 50;
export const WAVE_FACTOR = 2;
export const MAX_PER_MINUTE = 50;
export const DEFAULT_ABORT_PERCENT = 20;
// AWS IoT may only stop a job after this many of its boards have finished: one, so that the
// first failure of a small fleet is enough.
export const MIN_EXECUTED = 1;
// The most boards one rollout takes, all its waves together.
export const MAX_ROLLOUT_BOARDS = 100;

export const MAX_GROUPS = 50;
export const MAX_GROUP_BOARDS = 100;
export const MAX_GROUP_NAME = 40;

export const GROUP_ID = /^grp-[0-9a-f]{8}$/;
export const ROLLOUT_ID = /^rol-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const CONTROL = /[\p{C}\p{Zl}\p{Zp}]/u;

// Why a board is not in a rollout. The words are the console's; `text` adds the details.
export const LEFT_OUT = Object.freeze({
  bluetooth_only: 'Bluetooth only: updated from a phone',
  other_type: 'Another type of board',
  other_layout: 'Another flash layout',
  current: 'Already runs this release',
  newer: 'Runs a newer version, and a board takes only newer firmware',
  older_refused: 'Runs a newer version, so it would refuse this older one',
  busy: 'Has another update open',
  offline: 'Offline for more than a day',
  never: 'Has never reported',
});

export function boardLabel(type) {
  return BOARD_LABELS[type] ?? type;
}

function versionParts(text) {
  return typeof text === 'string' ? parseVersion(text) : null;
}

/** Negative, zero or positive as version a is older than, equal to, or newer than b. Unknown is oldest. */
export function versionOrder(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  if (left === null || right === null) return (left === null ? 0 : 1) - (right === null ? 0 : 1);
  return compareVersions(left, right);
}

/** The active releases of each board type, newest first: { [type]: Release[] }. */
export function releasesByType(releases) {
  const byType = {};
  for (const release of releases) {
    if (release.status !== 'active') continue;
    (byType[release.board] ??= []).push(release);
  }
  for (const list of Object.values(byType)) list.sort((a, b) => versionOrder(b.version, a.version));
  return byType;
}

/** How long a board has not been heard from, in ms: Infinity if never, 0 while online. */
function silentFor(board, nowMs) {
  if (board.online) return 0;
  const seen = Date.parse(board.lastSeen ?? '');
  return Number.isNaN(seen) ? Infinity : Math.max(0, nowMs - seen);
}

/**
 * Which of `candidates` a release goes to, and why the others are left out.
 *
 * @param {object} options
 * @param {object} options.release          the release (version, board, layout)
 * @param {object[]} options.candidates     fleet boards, each considered once
 * @param {Map<string, string>} [options.busy]  thing -> the deployment it has open
 * @param {number} options.nowMs
 * @param {boolean} [options.leaveOutAway]  leave out boards offline for more than a day
 * @param {boolean} [options.older]         the release is older than the type's newest: a board
 *                                          on something newer would refuse it
 * @returns {{ things: string[], leftOut: { thing: string, reason: string, text: string }[] }}
 */
export function selectTargets({ release, candidates, busy = new Map(), nowMs, leaveOutAway = false, older = false }) {
  const things = [];
  const leftOut = [];
  const out = (board, reason, text = LEFT_OUT[reason]) => leftOut.push({ thing: board.thing, reason, text });
  for (const board of [...candidates].sort((a, b) => (a.thing < b.thing ? -1 : 1))) {
    const order = versionOrder(board.version, release.version);
    if (board.type !== release.board) {
      out(board, 'other_type', `An ${boardLabel(board.type)}: this release is for the ${boardLabel(release.board)}`);
    } else if ((board.layout ?? 1) !== (release.layout ?? 1)) {
      out(
        board,
        'other_layout',
        `Flash layout ${board.layout ?? 1}: this release is built for layout ${release.layout ?? 1}`
      );
    } else if (board.bluetoothOnly) {
      out(board, 'bluetooth_only');
    } else if (board.version !== null && order === 0) {
      out(board, 'current', `Already runs ${release.version}`);
    } else if (board.version !== null && order > 0) {
      out(
        board,
        older ? 'older_refused' : 'newer',
        older
          ? `Runs ${board.version}: a board takes only firmware newer than what it runs, so it would refuse ${release.version}`
          : `Runs ${board.version}, newer than ${release.version}: a board takes only newer firmware`
      );
    } else if (busy.has(board.thing)) {
      out(board, 'busy', `Has another update open (${busy.get(board.thing)})`);
    } else if (leaveOutAway && board.lastSeen === null && !board.online) {
      out(board, 'never');
    } else if (leaveOutAway && silentFor(board, nowMs) > OFFLINE_LONG_MS) {
      out(board, 'offline', `Offline since ${board.lastSeen}: more than a day`);
    } else {
      things.push(board.thing);
    }
  }
  return { things, leftOut };
}

/**
 * The canary: the boards that take the update first. Online boards first, then the one heard from
 * most recently, then by name, so that the first board to try it is one that can.
 */
export function chooseCanary(things, boards, size) {
  const byThing = new Map(boards.map((board) => [board.thing, board]));
  const ranked = [...things].sort((a, b) => {
    const left = byThing.get(a);
    const right = byThing.get(b);
    const online = Number(right?.online === true) - Number(left?.online === true);
    if (online !== 0) return online;
    const seen = (Date.parse(right?.lastSeen ?? '') || 0) - (Date.parse(left?.lastSeen ?? '') || 0);
    return seen !== 0 ? seen : a < b ? -1 : 1;
  });
  return ranked.slice(0, Math.max(1, size)).sort();
}

/**
 * What AWS IoT Jobs is told for a wave: how fast to offer it (jobExecutionsRolloutConfig) and when
 * to stop it by itself (abortConfig). `wave` boards a minute to start with, twice as many each time
 * that many more have succeeded, up to MAX_PER_MINUTE; stopped, cancelling what has not started,
 * once failures, rejections and timeouts together reach `abortPercent` of the boards that have
 * finished, from the first one on.
 */
export function rolloutConfigs({ wave = DEFAULT_WAVE, abortPercent = DEFAULT_ABORT_PERCENT } = {}) {
  return {
    rollout: {
      maximumPerMinute: Math.max(wave, MAX_PER_MINUTE),
      exponentialRate: {
        baseRatePerMinute: wave,
        incrementFactor: WAVE_FACTOR,
        rateIncreaseCriteria: { numberOfSucceededThings: wave },
      },
    },
    abort: {
      criteriaList: [
        {
          failureType: 'ALL',
          action: 'CANCEL',
          thresholdPercentage: abortPercent,
          minNumberOfExecutedThings: MIN_EXECUTED,
        },
      ],
    },
  };
}

/**
 * The waves AWS will make of `count` boards if each wave confirms before the next minute: their
 * sizes, in order. It goes faster only as boards succeed, so a slow wave makes the next one wait
 * at the same size.
 */
export function wavePlan(count, wave = DEFAULT_WAVE) {
  const sizes = [];
  let rate = wave;
  let left = count;
  while (left > 0) {
    const size = Math.min(rate, left);
    sizes.push(size);
    left -= size;
    rate = Math.min(Math.max(wave, MAX_PER_MINUTE), rate * WAVE_FACTOR);
  }
  return sizes;
}

/**
 * Where a rollout's canary stands, from the executions of its job: "confirmed" once every canary
 * board has SUCCEEDED, which a board reports only after the new firmware has started, reached AWS
 * IoT and confirmed itself (firmware/app/src/ota.c); "failed" as soon as one has ended any other
 * way; otherwise "waiting".
 */
export function canaryVerdict(canary, executions) {
  const byThing = new Map(executions.map((execution) => [execution.thing, execution]));
  const failed = [];
  let confirmed = 0;
  for (const thing of canary) {
    const status = byThing.get(thing)?.status ?? 'QUEUED';
    if (status === 'SUCCEEDED') confirmed += 1;
    else if (status !== 'QUEUED' && status !== 'IN_PROGRESS') failed.push({ thing, status });
  }
  if (failed.length > 0) return { state: 'failed', failed, confirmed };
  return { state: confirmed === canary.length ? 'confirmed' : 'waiting', failed, confirmed };
}

/** The share of a wave's finished boards that failed, was rejected or timed out: { executed, failed, percent }. */
export function failureShare(executions) {
  const executed = executions.filter((execution) =>
    ['SUCCEEDED', 'FAILED', 'REJECTED', 'TIMED_OUT'].includes(execution.status)
  ).length;
  const failed = executions.filter((execution) =>
    ['FAILED', 'REJECTED', 'TIMED_OUT'].includes(execution.status)
  ).length;
  return { executed, failed, percent: executed === 0 ? 0 : (100 * failed) / executed };
}

/** A rollout's id: rol-<yyyymmddThhmmssZ>-<6 hex>, in time order. */
export function rolloutId(nowMs, hex) {
  const stamp = new Date(nowMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const id = `rol-${stamp}-${hex}`;
  if (!ROLLOUT_ID.test(id)) throw new TypeError('The time or the hex does not make a rollout id');
  return id;
}

export function requireRolloutId(value) {
  if (typeof value !== 'string' || !ROLLOUT_ID.test(value)) {
    throw badRequest('invalid_rollout', 'That is not the id of a staged rollout.');
  }
  return value;
}

export function requireGroupId(value) {
  if (typeof value !== 'string' || !GROUP_ID.test(value))
    throw badRequest('invalid_group', 'That is not the id of a group.');
  return value;
}

/** A group's name: one line of 1 to 40 characters, trimmed. */
export function requireGroupName(value) {
  const name = typeof value === 'string' ? value.trim() : null;
  if (name === null || name === '' || name.length > MAX_GROUP_NAME || CONTROL.test(name)) {
    throw badRequest('invalid_name', `A group's name is one line of 1 to ${MAX_GROUP_NAME} characters.`);
  }
  return name;
}

/** A whole number from `low` to `high`, or `fallback` when absent. */
export function requireWhole(value, name, low, high, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < low || value > high) {
    throw badRequest(`invalid_${name}`, `"${name}" must be a whole number from ${low} to ${high}.`);
  }
  return value;
}

/** A stored rollout item as the API shows it, or null if it is not one. */
export function rolloutFromItem(item) {
  if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || !ROLLOUT_ID.test(item.id))
    return null;
  const list = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []);
  const reasons = (value) =>
    (Array.isArray(value) ? value : [])
      .filter((entry) => typeof entry?.thing === 'string' && typeof entry?.reason === 'string')
      .map(({ thing, reason, text }) => ({
        thing,
        reason,
        text: typeof text === 'string' ? text : (LEFT_OUT[reason] ?? reason),
      }));
  return {
    id: item.id,
    version: item.version,
    board: item.board,
    layout: Number.isInteger(item.layout) ? item.layout : 1,
    purpose: item.purpose ?? 'deploy',
    target: item.target ?? { kind: 'boards' },
    note: typeof item.note === 'string' ? item.note : '',
    createdAt: item.createdAt,
    createdBy: item.createdBy ?? null,
    stage: item.stage,
    things: list(item.things),
    leftOut: reasons(item.leftOut),
    canary: { size: item.canary?.size ?? 1, things: list(item.canary?.things), job: item.canary?.job ?? null },
    rest: {
      things: list(item.rest?.things),
      leftOut: reasons(item.rest?.leftOut),
      job: item.rest?.job ?? null,
      startedAt: item.rest?.startedAt ?? null,
    },
    wave: item.wave ?? DEFAULT_WAVE,
    abortPercent: item.abortPercent ?? DEFAULT_ABORT_PERCENT,
    plan: wavePlan(list(item.things).length - list(item.canary?.things).length, item.wave ?? DEFAULT_WAVE),
    stopped: item.stopped ?? null,
    finishedAt: item.finishedAt ?? null,
    updatedAt: item.updatedAt ?? item.createdAt,
  };
}

/** True for a rollout that is still going: waiting for its canary, or with its waves under way. */
export function isOpenRollout(rollout) {
  return rollout.stage === 'canary' || rollout.stage === 'waves';
}

// Fleet health (GET /api/fleet/health).

// A result of an update over the air, as the board reported it (lib/events.mjs). An update over
// Bluetooth, or by USB or another tool, is counted from the update history (lib/updates.mjs updateCounts).
const JOB_RESULTS = Object.freeze({
  succeeded: 'succeeded',
  failed: 'failed',
  refused: 'failed',
  rolled_back: 'rolledBack',
});

/** How the cloud updates of the last days ended, from the boards' events: { succeeded, failed, rolledBack }. */
export function updateResults(events) {
  const counts = { succeeded: 0, failed: 0, rolledBack: 0 };
  for (const event of events) {
    const counted = event.kind === 'update' && event.what === 'result' ? JOB_RESULTS[event.result] : undefined;
    if (counted !== undefined) counts[counted] += 1;
  }
  return counts;
}

/** Versions by board type, and how many boards of each run the type's newest release. */
export function versionsByType(boards, newestByType, types) {
  return types.map((type) => {
    const ofType = boards.filter((board) => board.type === type);
    const newest = newestByType[type] ?? null;
    const counts = new Map();
    let unknown = 0;
    for (const board of ofType) {
      if (board.version === null) unknown += 1;
      else counts.set(board.version, (counts.get(board.version) ?? 0) + 1);
    }
    const versions = [...counts]
      .sort(([a], [b]) => versionOrder(b, a))
      .map(([version, count]) => ({ version, count, newest: version === newest }));
    const onNewest = newest === null ? 0 : (counts.get(newest) ?? 0);
    return {
      type,
      label: boardLabel(type),
      bluetoothOnly: isBluetoothOnly(type),
      boards: ofType.length,
      newest,
      onNewest,
      share: ofType.length === 0 || newest === null ? null : onNewest / ofType.length,
      versions,
      unknown,
    };
  });
}

function hoursOrDays(ms) {
  const hours = Math.floor(ms / HOUR_MS);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}

/** Why a board needs looking at: [{ code, text }], empty when nothing is wrong. */
export function attentionReasons(board, device, nowMs) {
  const reasons = [];
  if (board.bluetoothOnly) {
    if (board.seen === null) reasons.push({ code: 'unseen', text: 'No phone has seen it yet' });
    return reasons;
  }
  const silent = silentFor(board, nowMs);
  if (board.lastSeen === null && !board.online) {
    reasons.push({ code: 'offline', text: 'Has never reported' });
  } else if (silent > ATTENTION_OFFLINE_MS) {
    reasons.push({ code: 'offline', text: `Offline for ${hoursOrDays(silent)}` });
  }
  if (device?.stuck && device.stuck.count > 0) {
    reasons.push({
      code: 'stuck',
      text:
        `Restarted ${device.stuck.count === 1 ? 'once' : `${device.stuck.count} times`} for being stuck` +
        (device.stuck.reason && device.stuck.reason !== 'none' ? ` (${device.stuck.reason})` : ''),
    });
  }
  if (device?.ota && ['failed', 'rolled_back'].includes(device.ota.last)) {
    reasons.push({
      code: 'update_failed',
      text: device.ota.last === 'rolled_back' ? 'Its last update was rolled back' : 'Its last update failed',
    });
  }
  const heap = device?.diag?.heap ?? null;
  if (heap !== null && heap.size > 0 && heap.least / heap.size < LOW_HEAP_SHARE) {
    reasons.push({
      code: 'low_memory',
      text: `Memory ran down to ${Math.round((100 * heap.least) / heap.size)}% free`,
    });
  }
  if (Number.isInteger(device?.rssi) && device.rssi < WEAK_SIGNAL_DBM && silent === 0) {
    reasons.push({ code: 'weak_signal', text: `Weak Wi-Fi signal (${device.rssi} dBm)` });
  }
  return reasons;
}
