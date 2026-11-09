/**
 * The stages of a staged rollout (docs/fleet.md, Groups and rollouts), without AWS: how the boards
 * after the canary are split into stages, how a stage's job is offered, and what the console
 * suggests for a group.
 *
 * A rollout is a canary followed by 1 to MAX_STAGES stages. Each stage is one AWS IoT job on all its
 * boards at once (STAGE_ROLLOUT: as many a minute as AWS IoT allows), and the next starts only once
 * it has ended within its failure limit, after an optional soak time.
 *
 * The plan a person chooses is { stages, batch, soakMinutes }:
 *   - `stages`: how many stages, 1 to MAX_STAGES;
 *   - `batch`: null to split the boards evenly, or { unit: "percent" | "count", sizes } where `sizes`
 *     gives each stage but the last its share of the boards after the canary (one number for all of
 *     them, or one per stage); the last stage takes the rest;
 *   - `soakMinutes`: how long to wait after a stage has ended before the next starts, 0 to 60;
 *   - `healthGate`: null for none, or { minutes } (0 to 120): after the canary or a stage has
 *     confirmed, the next stage starts only once its boards have run the release for `minutes` with
 *     no new Memfault issue and no unexpected reboot (lib/health.mjs). A request gives it as
 *     { on, minutes }; a request without it (a script or a client from before 2.13.0) has none.
 *
 * Every function here is plain.
 */

import { badRequest } from '../http.mjs';

export const MAX_STAGES = 10;
export const DEFAULT_STAGES = 1;
export const MAX_SOAK_MINUTES = 60;
export const DEFAULT_SOAK_MINUTES = 0;
export const MAX_GATE_MINUTES = 120;
export const DEFAULT_GATE_MINUTES = 10;
export const BATCH_UNITS = Object.freeze(['percent', 'count']);
// The most a stage holds by count: a rollout's own limit (lib/fleet.mjs MAX_ROLLOUT_BOARDS).
export const MAX_BATCH_COUNT = 100;
// AWS IoT offers a job to at most 1000 boards a minute: a stage goes out at that rate, all at once.
export const AWS_MAX_PER_MINUTE = 1000;
export const STAGE_ROLLOUT = Object.freeze({ maximumPerMinute: AWS_MAX_PER_MINUTE });
// A stage of fewer boards than this says little about the next: one failure is all of it.
export const MIN_USEFUL_STAGE = 2;
// The share of the boards after the canary that the first suggested stage takes, and how much
// larger each next one is.
export const FIRST_SHARE = 0.1;
export const GROWTH = 3;
// Groups up to this size get a single stage after the canary.
export const TINY_GROUP = 3;

const SOAK_STEPS = Object.freeze([
  { upTo: 10, minutes: 0, text: 'a small group: each stage follows as soon as the one before has ended' },
  { upTo: 50, minutes: 5, text: 'a few minutes between stages to see how the boards behave on it' },
  { upTo: Infinity, minutes: 10, text: 'a large group: ten minutes between stages to see how the boards behave' },
]);

function whole(value, name, low, high, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < low || value > high) {
    throw badRequest(`invalid_${name}`, `"${name}" must be a whole number from ${low} to ${high}.`);
  }
  return value;
}

function badBatch(message) {
  return badRequest('invalid_batch', message);
}

/**
 * The health gate of a request body: null (off) or { minutes }. It is { on, minutes? } with
 * `minutes` 0 to MAX_GATE_MINUTES, DEFAULT_GATE_MINUTES if not given; absent or null is off.
 */
export function requireHealthGate(raw) {
  if (raw === undefined || raw === null) return null;
  const bad = () =>
    badRequest(
      'invalid_healthGate',
      `"healthGate" is { on: true or false, minutes: a whole number from 0 to ${MAX_GATE_MINUTES} }.`
    );
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad();
  if (Object.keys(raw).some((key) => key !== 'on' && key !== 'minutes')) throw bad();
  if (typeof raw.on !== 'boolean') throw bad();
  const minutes = raw.minutes === undefined ? DEFAULT_GATE_MINUTES : raw.minutes;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_GATE_MINUTES) throw bad();
  return raw.on ? { minutes } : null;
}

/**
 * The stage choices of a request body: { stages, batch, soakMinutes }, each checked, and
 * `healthGate` when the body gives one. `read` is the body's field reader (http.mjs field).
 */
export function requireStagePlan(read) {
  const gate = read('healthGate');
  const plan = stagePlanOf(read);
  return gate === undefined ? plan : { ...plan, healthGate: requireHealthGate(gate) };
}

function stagePlanOf(read) {
  const stages = whole(read('stages'), 'stages', 1, MAX_STAGES, DEFAULT_STAGES);
  const soakMinutes = whole(read('soakMinutes'), 'soakMinutes', 0, MAX_SOAK_MINUTES, DEFAULT_SOAK_MINUTES);
  const raw = read('batch');
  if (raw === undefined || raw === null) return { stages, batch: null, soakMinutes };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw badBatch('"batch" is { unit: "percent" or "count", sizes: [whole numbers] }.');
  }
  const unit = Object.hasOwn(raw, 'unit') ? raw.unit : undefined;
  if (!BATCH_UNITS.includes(unit)) throw badBatch('A batch is counted in "percent" or "count".');
  const sizes = Object.hasOwn(raw, 'sizes') ? raw.sizes : undefined;
  const high = unit === 'percent' ? 100 : MAX_BATCH_COUNT;
  if (stages === 1) {
    if (sizes === undefined || (Array.isArray(sizes) && sizes.length === 0))
      return { stages, batch: null, soakMinutes };
    throw badBatch('With one stage, it takes every board after the canary: there is no batch size to give.');
  }
  if (
    !Array.isArray(sizes) ||
    (sizes.length !== 1 && sizes.length !== stages - 1) ||
    !sizes.every((size) => Number.isInteger(size) && size >= 1 && size <= high)
  ) {
    throw badBatch(
      `Give one batch size, or one for each stage but the last (${stages - 1}): whole numbers from 1 to ${high}` +
        `${unit === 'percent' ? ' percent' : ' boards'}.`
    );
  }
  const each = sizes.length === 1 ? Array(stages - 1).fill(sizes[0]) : [...sizes];
  if (unit === 'percent' && each.reduce((sum, size) => sum + size, 0) > 100) {
    throw badBatch('The batches before the last stage add up to more than 100 percent.');
  }
  return { stages, batch: { unit, sizes: each }, soakMinutes };
}

/**
 * How many boards each stage takes, of `count` boards after the canary: positive whole numbers that
 * add up to `count`. Stages that would be empty are left out, so a plan of more stages than boards
 * has fewer stages.
 */
export function stageSizes(count, { stages = DEFAULT_STAGES, batch = null } = {}) {
  if (!Number.isInteger(count) || count <= 0) return [];
  const sizes = [];
  let left = count;
  if (batch === null) {
    const parts = Math.min(stages, count);
    const base = Math.floor(count / parts);
    const extra = count % parts;
    // The later stages take the remainder: the first stays the smallest.
    for (let index = 0; index < parts; index += 1) sizes.push(base + (index >= parts - extra ? 1 : 0));
    return sizes;
  }
  for (const size of batch.sizes.slice(0, stages - 1)) {
    if (left === 0) break;
    const boards = batch.unit === 'percent' ? Math.max(1, Math.ceil((size * count) / 100)) : size;
    const taken = Math.min(boards, left);
    sizes.push(taken);
    left -= taken;
  }
  if (left > 0) sizes.push(left);
  return sizes;
}

/**
 * The boards of each stage: online boards first, heard from most recently, so that the boards that
 * are away come last, in the last stage, and take it when they are back. Each stage's boards sorted.
 */
export function assignStages(things, boards, sizes) {
  const byThing = new Map(boards.map((board) => [board.thing, board]));
  const ranked = [...things].sort((a, b) => {
    const left = byThing.get(a);
    const right = byThing.get(b);
    const online = Number(right?.online === true) - Number(left?.online === true);
    if (online !== 0) return online;
    const seen = (Date.parse(right?.lastSeen ?? '') || 0) - (Date.parse(left?.lastSeen ?? '') || 0);
    return seen !== 0 ? seen : a < b ? -1 : 1;
  });
  const stages = [];
  let at = 0;
  for (const size of sizes) {
    stages.push(ranked.slice(at, at + size).sort());
    at += size;
  }
  if (at < ranked.length && stages.length > 0) stages[stages.length - 1].push(...ranked.slice(at).sort());
  return stages;
}

/**
 * Where a stage stands from its job's executions once the job is over: { executed, failed, percent }
 * is what lib/fleet.mjs failureShare says; `over` is true when the failures reach the limit.
 */
export function stageVerdict(share, abortPercent) {
  return { ...share, over: share.executed > 0 && share.percent >= abortPercent };
}

// The suggestion (GET /api/rollouts/suggest).

const asMap = (value) => {
  if (value instanceof Map) return value;
  if (value instanceof Set) return new Map([...value].map((key) => [key, true]));
  if (Array.isArray(value)) return new Map(value.map((key) => [key, true]));
  if (value !== null && typeof value === 'object') return new Map(Object.entries(value));
  return new Map();
};
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** A board's update history as the suggestion reads it: { updates, failures }. */
function historyOf(history, thing) {
  const entry = history.get(thing);
  return {
    updates: Number.isInteger(entry?.updates) && entry.updates > 0 ? entry.updates : 0,
    failures: Number.isInteger(entry?.failures) && entry.failures > 0 ? entry.failures : 0,
  };
}

/** The geometric stage sizes for `count` boards after the canary of a group of `total`. */
function growingSizes(count, total) {
  if (count <= 0) return [];
  if (total <= TINY_GROUP) return [count];
  const sizes = [];
  let left = count;
  let size = Math.max(MIN_USEFUL_STAGE, Math.ceil(count * FIRST_SHARE));
  // A stage is worth its own only if what is left after it is more than twice its size: else the
  // rest goes together.
  while (left > 2 * size && sizes.length < MAX_STAGES - 1) {
    sizes.push(size);
    left -= size;
    size *= GROWTH;
  }
  sizes.push(left);
  return sizes;
}

/**
 * What the console suggests for a rollout: the canary, the stages, their batch sizes and the soak
 * time, each with a one-line reason, and the warnings a person should read first.
 *
 * @param {object} input
 * @param {string[]} input.boards     the boards the release would go to
 * @param {Set|Map|object|string[]} [input.online]  the boards online now
 * @param {Map|object} [input.types]  thing -> board type
 * @param {Map|object} [input.history]  thing -> { updates, failures } from the update history
 * @returns {{ canary: string[], stages: { things: string[], size: number, percent: number,
 *   offline: number }[], stageCount: number, batch: { unit: 'count', sizes: number[] } | null,
 *   soakMinutes: number, healthGate: { on: true, minutes: number }, reasons: { canary: string,
 *   stages: string, batch: string, soak: string, health: string, offline: string | null },
 *   warnings: string[] }}
 */
export function suggestPlan({ boards, online = [], types = {}, history = {} }) {
  const things = [
    ...new Set((Array.isArray(boards) ? boards : []).filter((thing) => typeof thing === 'string')),
  ].sort();
  const onlineOf = asMap(online);
  const typeOf = asMap(types);
  const pastOf = asMap(history);
  const isOnline = (thing) => onlineOf.get(thing) === true;
  const warnings = [];

  // The canary: per board type, one online board, the one with the cleanest update history.
  const canary = [];
  const byType = new Map();
  for (const thing of things) {
    const type = typeOf.get(thing) ?? 'unknown';
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(thing);
  }
  const noOnline = [];
  for (const [type, members] of [...byType].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const ranked = [...members].sort((a, b) => {
      const up = Number(isOnline(b)) - Number(isOnline(a));
      if (up !== 0) return up;
      const left = historyOf(pastOf, a);
      const right = historyOf(pastOf, b);
      if (left.failures !== right.failures) return left.failures - right.failures;
      if (left.updates !== right.updates) return right.updates - left.updates;
      return a < b ? -1 : 1;
    });
    if (!isOnline(ranked[0])) noOnline.push(type);
    canary.push(ranked[0]);
  }
  canary.sort();
  const clean = canary.filter((thing) => historyOf(pastOf, thing).failures === 0).length;
  const canaryReason =
    canary.length === 0
      ? 'No board to update.'
      : `${canary.length === 1 ? 'One board' : `One board of each of the ${byType.size} board types`}, ` +
        `${noOnline.length === 0 ? 'online' : 'online where there is one'}` +
        `${clean === canary.length ? ', with a clean update history' : ', with the fewest failed updates'}: it goes first.`;
  if (noOnline.length > 0) {
    warnings.push(
      `No board of type ${noOnline.join(', ')} is online: its canary waits until it is back, and so does the rest.`
    );
  }

  // The stages: growing, offline boards last.
  const rest = things.filter((thing) => !canary.includes(thing));
  const away = rest.filter((thing) => !isOnline(thing));
  const sizes = growingSizes(rest.length, things.length);
  // The boards that are away all go in the last stage: merge stages until it holds them.
  while (sizes.length > 1 && sizes[sizes.length - 1] < away.length) {
    const last = sizes.pop();
    sizes[sizes.length - 1] += last;
  }
  const boardsOf = assignStages(
    rest,
    rest.map((thing) => ({ thing, online: isOnline(thing), lastSeen: null })),
    sizes
  );
  const stages = boardsOf.map((members) => ({
    things: members,
    size: members.length,
    percent: rest.length === 0 ? 0 : Math.round((100 * members.length) / rest.length),
    offline: members.filter((thing) => !isOnline(thing)).length,
  }));
  let stagesReason;
  if (stages.length === 0) stagesReason = 'The canary is the whole group: there is no stage after it.';
  else if (things.length <= TINY_GROUP)
    stagesReason = `A group of ${plural(things.length, 'board')}: one stage after the canary, all at once.`;
  else if (stages.length === 1)
    stagesReason = `${plural(rest.length, 'board')} after the canary: too few to split, so one stage, all at once.`;
  else
    stagesReason =
      `${plural(stages.length, 'stage')} that grow (${stages.map((stage) => `${stage.percent}%`).join(' → ')}): ` +
      'a small first stage finds a problem early, and each next one is larger.';
  const batchReason =
    stages.length <= 1
      ? 'One stage takes every board after the canary.'
      : `${stages
          .slice(0, -1)
          .map((stage) => stage.size)
          .join(', then ')} boards, and the last stage takes the rest.`;

  for (const [index, stage] of stages.entries()) {
    if (stage.size < MIN_USEFUL_STAGE && index < stages.length - 1) {
      warnings.push(`Stage ${index + 1} has ${plural(stage.size, 'board')}: too few to tell anything about the next.`);
    }
  }
  if (things.length > 0 && things.filter((thing) => !isOnline(thing)).length * 2 > things.length) {
    warnings.push(
      `Most of the group is offline (${things.filter((thing) => !isOnline(thing)).length} of ${things.length}): ` +
        'the rollout waits for them.'
    );
  }

  const soak = SOAK_STEPS.find((step) => things.length <= step.upTo);
  const soakMinutes = stages.length <= 1 ? 0 : soak.minutes;
  return {
    canary,
    stages,
    stageCount: stages.length,
    batch: stages.length <= 1 ? null : { unit: 'count', sizes: stages.slice(0, -1).map((stage) => stage.size) },
    soakMinutes,
    healthGate: { on: true, minutes: DEFAULT_GATE_MINUTES },
    reasons: {
      canary: canaryReason,
      stages: stagesReason,
      batch: batchReason,
      soak:
        stages.length <= 1
          ? 'No soak time: there is no stage after the first to wait for.'
          : `${soakMinutes === 0 ? 'No soak time' : `${soakMinutes} minutes`}: ${soak.text}.`,
      health:
        stages.length === 0
          ? 'Health gate on: with no stage after the canary there is nothing for it to hold back, but it costs nothing.'
          : `Health gate on, ${DEFAULT_GATE_MINUTES} minutes: the next stage starts only once the boards before it ` +
            'have run the release that long with no new Memfault issue and no unexpected reboot.',
      offline:
        away.length === 0
          ? null
          : `${plural(away.length, 'board is', 'boards are')} offline: ${away.length === 1 ? 'it is' : 'they are'} in the last stage, and take it when back.`,
    },
    warnings,
  };
}
