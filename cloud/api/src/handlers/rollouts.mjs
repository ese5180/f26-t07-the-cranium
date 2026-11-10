/**
 * Staged rollouts (docs/fleet.md, Groups and rollouts): a release to many boards at once, a canary
 * first, then stages, each on all its boards at once, stopping by itself when too many fail.
 *
 *   GET  /api/rollouts                   -> { rollouts: [Rollout] }, newest first, at most 25
 *   GET  /api/rollouts/suggest?release=&group=
 *                                        -> { suggestion }  the canary, stages, batch sizes and soak
 *                                           the console suggests (lib/stages.mjs suggestPlan), each
 *                                           with its reason; without `group`, for the whole fleet
 *   GET  /api/rollouts/{id}              -> { rollout: RolloutDetail }
 *   POST /api/rollouts                   body { version, target, canary?, stages?, batch?, soakMinutes?,
 *                                          abortPercent?, note? }
 *                                        -> 201 { rollout: RolloutDetail }                 rollout.create
 *   POST /api/rollouts/{id}/cancel       body { force? } -> { rollout: RolloutDetail }     rollout.cancel
 *   GET  /api/fleet/update-everything    -> { plan }   what "Update everything" would do now
 *   POST /api/fleet/update-everything    body { types: [{ type, version, things }], canary?, stages?,
 *                                          batch?, soakMinutes?, abortPercent?, note? }
 *                                        -> 201 { rollouts }                               fleet.update_everything
 *   GET  /api/groups/{id}/rollback       -> { plan }   the previous release of each type, for the group
 *   POST /api/groups/{id}/rollback       body as for update-everything -> 201 { rollouts }  group.rollback
 *
 * `target` is { kind: "boards", things } | { kind: "group", group } | { kind: "type", type } |
 * { kind: "fleet" }. Whatever it is, a rollout only ever takes boards of the release's type that
 * can take a job and are not on the release already (lib/fleet.mjs selectTargets). Boards named
 * one by one are refused if they cannot (400 incompatible_board, 400 bluetooth_only, 409
 * device_busy); boards that a group, a type or the fleet stand for are left out, each with why.
 * "Update everything" and a rollback also leave out boards offline for more than a day.
 *
 * How it runs. Stage "canary": a job on the canary alone (one board unless asked for more; online
 * boards with a clean update history first). A board reports SUCCEEDED only from the new
 * firmware, once that has started, reached AWS IoT and confirmed itself (firmware/app/src/ota/ota.c,
 * send_final_report); that is the canary's confirmation. Nothing in AWS IoT Jobs waits for one job
 * before it starts another, so the console does: every minute a schedule (infra/template.yaml,
 * RolloutTickFn) runs advance() below, which reads each open rollout's current job.
 *
 * Once every canary board has SUCCEEDED, the rollout is in "stages": 1 to 10 stages, planned when
 * it was created (lib/stages.mjs: their sizes from `stages` and `batch`, online boards first, the
 * ones away in the last). Each stage is one job on all its boards at once, offered as fast as AWS
 * IoT allows (STAGE_ROLLOUT), and stopped by AWS IoT (abortConfig: cancel what has not started
 * once failures reach `abortPercent` of the boards that have finished, from the first one on). The
 * next stage starts once the job of the one before has COMPLETED with its failures under
 * `abortPercent`, and `soakMinutes` after that (the same wait follows the canary). Before a stage
 * starts its boards are looked at again: one that has meanwhile got the release, another update or
 * left the project is left out then. A canary that fails, a stage's failures at the limit, a
 * release revoked, a job cancelled elsewhere or gone: the rollout is "stopped", and says why.
 * Cancelled here: "cancelled".
 *
 * A rollout created before console 2.8.0 has no stages: after its canary comes "waves", one job on
 * the rest that AWS IoT paces (`wave` boards a minute, growing as boards succeed). advance() still
 * takes such a rollout to its end.
 *
 * The health gate (console 2.13.0, lib/health.mjs): a rollout created with one waits, after the canary
 * and after each stage has ended, `healthGate.minutes` and then asks Memfault (handlers/memfault.mjs
 * health) whether a board it has updated so far shows a new issue or an unexpected reboot on the new
 * version. None: the gate has passed (`gatePassedAt` on the canary or the stage) and the next stage
 * starts once its soak time is over too. One: the rollout is "stopped", code "health_failed", with the
 * board, and the issue's id and title when it is one. Memfault not to be read: it waits, and after
 * GATE_WAIT_MS stops with "health_unknown". Either stop is the boards' own doing, so an alert.
 *
 * Two runs of advance() at the same moment cannot both start a stage: each change of stage is a
 * conditional write on the rollout (its rev), and only the run that made it creates the job. A
 * cancellation that comes between the two is seen right after the job exists, which is then
 * cancelled at once.
 *
 * Stored in the state table, pk ROL, sk the rollout's id (rol-<time>-<6 hex>, in time order). The
 * jobs themselves are deployments like any other (handlers/deployments.mjs launch), and their
 * notes say which rollout and which stage they are.
 */

import { HttpError, badRequest, conflict, describeError, field, notFound, unprocessable } from '../http.mjs';
import { boardsValue, change as noteChange } from '../lib/audit.mjs';
import { BOARD_TYPES, isBoardType } from '../lib/boards.mjs';
import {
  DEFAULT_ABORT_PERCENT,
  DEFAULT_CANARY,
  DEFAULT_WAVE,
  MAX_CANARY,
  MAX_ROLLOUT_BOARDS,
  MAX_WAVE,
  boardLabel,
  canaryVerdict,
  chooseCanary,
  failureShare,
  isOpenRollout,
  requireGroupId,
  requireRolloutId,
  requireWhole,
  rolloutConfigs,
  rolloutFromItem,
  rolloutId,
  selectTargets,
} from '../lib/fleet.mjs';
import { GATE_WAIT_MS, UNREAD_WORDS, gateBoards, healthWords } from '../lib/health.mjs';
import { buildJobDescription, isoTime, mapLimit } from '../lib/jobs.mjs';
import {
  STAGE_ROLLOUT,
  assignStages,
  requireStagePlan,
  stageSizes,
  stageVerdict,
  suggestPlan,
} from '../lib/stages.mjs';
import { MAX_NOTE, isThing, parseJobId, requireBoolean, requireText, requireVersion } from '../lib/validate.mjs';
import { releaseFromItem, releaseKey } from './firmware.mjs';

const LIST_LIMIT = 25;
const HISTORY_IN_FLIGHT = 8;
// The update outcomes that count against a board as a canary (lib/updates.mjs OUTCOMES).
const FAILED_OUTCOMES = new Set(['rolled_back', 'not_installed']);
const MAX_BOARDS_NAMED = 200;
// A start of the waves that has not named its job after this long is looked for once and given up.
const LOST_START_MS = 5 * 60_000;
// The console's own name in the activity log, for what the schedule does.
const CONSOLE_ACTOR = Object.freeze({ sub: '', email: '' });
// The stops that are the boards' own doing: each is a "deployment" alert (lib/alerts.mjs) when the
// schedule is given an alerter. A revocation, a cancellation or a lost job is a person's or AWS's.
const SELF_STOPS = new Set(['canary_failed', 'aborted', 'health_failed', 'health_unknown']);
const ALERT_TEXT_MAX = 200;

const STOP_TEXT = Object.freeze({
  canary_failed: 'The canary did not confirm the update',
  aborted: 'Too many boards failed: AWS IoT stopped the rest',
  revoked: 'The release was revoked',
  cancelled_elsewhere: 'A deployment of it was cancelled outside the rollout',
  job_missing: 'Its job is gone from AWS IoT',
  job_failed: 'The next stage could not be started',
  health_failed: 'The health gate found a new Memfault issue or an unexpected reboot',
  health_unknown: 'The health gate could not read Memfault',
});

function unknownRollout() {
  return notFound('unknown_rollout', 'There is no staged rollout with that id.');
}

function nothingToDeploy(leftOut) {
  const error = unprocessable(
    'nothing_to_deploy',
    leftOut.length === 0
      ? 'There is no board to update.'
      : `No board would take it: ${leftOut
          .slice(0, 3)
          .map((entry) => `${entry.thing}: ${entry.text}`)
          .join('; ')}` + `${leftOut.length > 3 ? `, and ${leftOut.length - 3} more` : ''}.`
  );
  error.details = leftOut;
  return error;
}

function planChanged(message, details) {
  return conflict('plan_changed', `${message} Look at the plan again.`, details);
}

/** 1 to MAX_ROLLOUT_BOARDS board names, none twice, sorted. */
function requireBoardList(value, name = 'things') {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ROLLOUT_BOARDS || !value.every(isThing)) {
    throw badRequest(`invalid_${name}`, `Name 1 to ${MAX_ROLLOUT_BOARDS} boards: "cranium-" and 16 hex digits each.`);
  }
  if (new Set(value).size !== value.length) throw badRequest(`invalid_${name}`, 'A board is listed twice.');
  return [...value].sort();
}

function requireBoardType(value) {
  if (!isBoardType(value)) throw badRequest('invalid_type', `A board type is one of: ${BOARD_TYPES.join(', ')}.`);
  return value;
}

/**
 * The options of a rollout, the same for every way of starting one. `wave` is what a client from
 * before the stages sent: it is still checked, and has no effect.
 */
function rolloutOptions(body) {
  requireWhole(field(body, 'wave'), 'wave', 1, MAX_WAVE, DEFAULT_WAVE);
  return {
    canary: requireWhole(field(body, 'canary'), 'canary', 1, MAX_CANARY, DEFAULT_CANARY),
    ...requireStagePlan((name) => field(body, name)),
    abortPercent: requireWhole(field(body, 'abortPercent'), 'abortPercent', 1, 100, DEFAULT_ABORT_PERCENT),
    note: requireText(field(body, 'note'), 'note', { max: MAX_NOTE }),
  };
}

/** What the activity log keeps of a rollout's stage choices: "3 (2,6), soak 5 min". */
function planWords(options) {
  const batch =
    options.batch === null ? 'even' : `${options.batch.sizes.join(',')}${options.batch.unit === 'percent' ? '%' : ''}`;
  const gate = options.healthGate ? `, gate ${options.healthGate.minutes} min` : '';
  return `${options.stages} (${batch}), soak ${options.soakMinutes} min${gate}`;
}

/** Where a rollout stands, as its activity entries say it: canary, waves, stage <n>, done, stopped or cancelled. */
function phaseOf(item) {
  // Between the canary and the first stage, a rollout is still where its canary left it.
  if (item?.stage === 'stages') {
    return Number.isSafeInteger(item.current) && item.current >= 0 ? `stage ${item.current + 1}` : 'canary';
  }
  return typeof item?.stage === 'string' ? item.stage : null;
}

/** Where a stage of a rollout stands: "planned", "running", "soaking", "done", "skipped" or "stopped". */
function stageState(rollout, stage, index) {
  if (stage.doneAt !== null) return stage.job === null ? 'skipped' : 'done';
  if (stage.startedAt !== null) return isOpenRollout(rollout) ? 'running' : 'stopped';
  if (!isOpenRollout(rollout)) return 'never';
  return rollout.stage === 'stages' && index === rollout.current + 1 ? 'next' : 'planned';
}

/** A stage's boards by how far they are: { done, inProgress, failed, waiting, total }. */
function stageCounts(stage, job) {
  const counts = { done: 0, inProgress: 0, failed: 0, waiting: 0, total: stage.things.length };
  const byThing = new Map((job?.executions ?? []).map((execution) => [execution.thing, execution.status]));
  for (const thing of stage.things) {
    const status = byThing.get(thing) ?? 'QUEUED';
    if (status === 'SUCCEEDED') counts.done += 1;
    else if (status === 'IN_PROGRESS') counts.inProgress += 1;
    else if (status === 'QUEUED') counts.waiting += 1;
    else counts.failed += 1;
  }
  return counts;
}

function nameBoards(entry, key, things) {
  const names = things.join(' ');
  if (names.length <= MAX_BOARDS_NAMED && names !== '') entry.detail[key] = names;
}

/** The note a stage's job carries: which rollout it is part of, within the 200 characters a note has. */
function stageNote(rollout, part) {
  const name =
    part === 'canary' ? 'Canary' : part === 'waves' ? 'Waves' : `Stage ${part} of ${rollout.stages?.length ?? part}`;
  const head = `${name} of staged rollout ${rollout.id}`;
  return (rollout.note ? `${head}: ${rollout.note}` : head).slice(0, MAX_NOTE);
}

export function createRolloutHandlers(
  { aws, config, now, randomHex, log, alert = null },
  { devices, deployments, fleet, audit, updates = () => null, memfault = () => null }
) {
  /**
   * thing -> { updates, failures } from each board's update history, for the boards that have one.
   * Never a failure: without the history, every board's is clean.
   */
  async function historyOf(things) {
    const history = updates();
    const found = new Map();
    if (history === null || things.length === 0) return found;
    await mapLimit(things, HISTORY_IN_FLIGHT, async (thing) => {
      try {
        const records = await history.recordsOf(thing);
        found.set(thing, {
          updates: records.length,
          failures: records.filter((record) => FAILED_OUTCOMES.has(record.outcome)).length,
        });
      } catch (error) {
        log({ level: 'warn', event: 'updates_unreadable', thing, error: describeError(error) });
      }
    });
    return found;
  }

  const failuresOf = (history) => new Map([...history].map(([thing, entry]) => [thing, entry.failures]));

  async function findRelease(version) {
    const release = releaseFromItem(await aws.getRelease(releaseKey(version.parts)));
    if (release === null || release.version !== version.text) {
      throw notFound('unknown_version', `There is no release ${version.text}.`);
    }
    if (release.status !== 'active') {
      throw conflict('release_revoked', `Release ${version.text} is revoked and cannot be deployed.`);
    }
    return release;
  }

  /** thing -> the deployment it has open, for the boards that have one. */
  async function busyOf(things) {
    const busy = new Map();
    for (const { thing, deployment } of things.length === 0 ? [] : await deployments.unfinishedOn(things)) {
      if (!busy.has(thing)) busy.set(thing, deployment);
    }
    return busy;
  }

  async function readItem(id) {
    const item = await aws.getFleetItem({ pk: 'ROL', sk: id });
    if (item === null) throw unknownRollout();
    return item;
  }

  /** Which executions of the waves' job were offered when: [{ wave, at, things }], and who is still to come. */
  async function wavesOf(rollout, job) {
    if (rollout.rest.job === null) return { waves: [], notOffered: rollout.rest.things };
    const listed = await aws.listJobExecutionsForJob(rollout.rest.job);
    const start = Date.parse(job?.createdAt ?? rollout.rest.startedAt ?? '') || 0;
    const byMinute = new Map();
    for (const execution of listed) {
      const minute = Math.max(0, Math.floor(((execution.queuedAt ?? start) - start) / 60_000));
      if (!byMinute.has(minute)) byMinute.set(minute, { at: execution.queuedAt ?? start, things: [] });
      byMinute.get(minute).things.push(execution.thing);
    }
    const waves = [...byMinute]
      .sort(([a], [b]) => a - b)
      .map(([, value], index) => ({
        wave: index + 1,
        at: isoTime(value.at),
        things: value.things.sort(),
      }));
    const offered = new Set(listed.map((execution) => execution.thing));
    return { waves, notOffered: rollout.rest.things.filter((thing) => !offered.has(thing)) };
  }

  /**
   * A rollout with its jobs as deployments: the canary's, each stage's with its counts and where it
   * stands, and for a rollout from before the stages its waves.
   */
  async function detailOf(item) {
    const rollout = rolloutFromItem(item);
    const [canaryJob, wavesJob, stageJobs] = await Promise.all([
      rollout.canary.job === null ? null : deployments.detail(rollout.canary.job),
      rollout.rest.job === null ? null : deployments.detail(rollout.rest.job),
      Promise.all(rollout.stages.map((stage) => (stage.job === null ? null : deployments.detail(stage.job)))),
    ]);
    const { waves, notOffered } = await wavesOf(rollout, wavesJob);
    const stages = rollout.stages.map((stage, index) => ({
      ...stage,
      state: stageState(rollout, stage, index),
      counts: stageCounts(stage, stageJobs[index]),
      deployment: stageJobs[index],
    }));
    return { ...rollout, stages, canaryJob, wavesJob, waves, notOffered };
  }

  /**
   * Start a rollout on boards that were chosen already: its canary job, then its record. If the
   * record cannot be written, the job is cancelled again: a canary nobody follows is no rollout.
   */
  async function start({ release, things, leftOut, target, purpose, options, actor, entry }) {
    if (things.length > MAX_ROLLOUT_BOARDS) {
      throw unprocessable('too_many_boards', `A rollout takes at most ${MAX_ROLLOUT_BOARDS} boards.`);
    }
    const loaded = (await fleet.boards({ only: things })).map(({ board }) => board);
    const canary = chooseCanary(things, loaded, options.canary, failuresOf(await historyOf(things)));
    const restThings = things.filter((thing) => !canary.includes(thing));
    const stages = assignStages(restThings, loaded, stageSizes(restThings.length, options));
    const id = rolloutId(now(), String(randomHex(6)).slice(0, 6));
    const createdAt = new Date(now()).toISOString();
    const record = {
      id,
      version: release.version,
      board: release.board,
      layout: release.layout,
      purpose,
      target,
      note: options.note,
      createdAt,
      createdBy: { sub: actor.sub, email: actor.email },
      stage: 'canary',
      things,
      leftOut,
      canary: { size: canary.length, things: canary, job: null, doneAt: null },
      // All the boards after the canary; its job stays null (the waves of a rollout from before).
      rest: { things: restThings, leftOut: [], job: null, startedAt: null },
      stages: stages.map((members) => ({ things: members, leftOut: [], job: null, startedAt: null, doneAt: null })),
      // The index of the stage started last: -1 until the first.
      current: -1,
      stagePlan: { stages: options.stages, batch: options.batch },
      soakMinutes: options.soakMinutes,
      // From console 2.13.0: null, or { minutes } (lib/health.mjs).
      healthGate: options.healthGate ?? null,
      abortPercent: options.abortPercent,
      stopped: null,
      finishedAt: null,
      updatedAt: createdAt,
      rev: 0,
    };
    const { abort } = rolloutConfigs(options);
    const description = buildJobDescription({ email: actor.email, sub: actor.sub, note: stageNote(record, 'canary') });
    const { id: job } = await deployments.launch({
      release,
      things: canary,
      description,
      actorSub: actor.sub,
      // One canary needs no stop of its own: the console stops the rollout on its failure.
      abort: canary.length > 1 ? abort : null,
    });
    record.canary.job = job;
    if (record.rest.things.length === 0) record.canary.only = true;
    let stored = false;
    try {
      stored = (await aws.putFleetItem({ pk: 'ROL', sk: id, item: record })).ok;
    } catch (error) {
      log({ level: 'error', event: 'rollout_unrecorded', rollout: id, error: describeError(error) });
    }
    if (!stored) {
      await aws
        .cancelJob({ jobId: job, force: true, reasonCode: 'CONSOLE_CANCEL', comment: actor.sub })
        .catch(() => null);
      throw new HttpError(
        500,
        'rollout_unrecorded',
        'The rollout could not be recorded, so its canary was cancelled again.'
      );
    }
    if (entry) {
      entry.detail.canary = canary.join(' ').length <= MAX_BOARDS_NAMED ? canary.join(' ') : String(canary.length);
      entry.detail.stages = planWords(options);
      noteChange(entry, 'rollout', null, id);
      noteChange(entry, 'version', null, release.version);
      noteChange(entry, 'phase', null, 'canary');
      noteChange(entry, 'boards', null, boardsValue(things));
      noteChange(entry, 'plan', null, planWords(options));
    }
    return record;
  }

  /** Boards named in a request, checked as a deployment checks them; current and newer ones left out. */
  async function namedBoards(things, release) {
    const registered = new Set(await devices.groupThings());
    const strangers = things.filter((thing) => !registered.has(thing));
    if (strangers.length > 0) {
      throw unprocessable(
        'unknown_device',
        strangers.length === 1
          ? `${strangers[0]} is not a registered board.`
          : `These are not registered boards: ${strangers.join(', ')}.`
      );
    }
    const loaded = await fleet.requireJobTargets(things, release);
    const busy = await busyOf(things);
    if (busy.size > 0) {
      const list = [...busy].map(([thing, deployment]) => ({ thing, deployment }));
      throw conflict(
        'device_busy',
        `${list.length === 1 ? `${list[0].thing} still has` : `${list.length} boards still have`} ` +
          'an update that is not finished. Wait for it or cancel it first.',
        list
      );
    }
    return selectTargets({ release, candidates: loaded, nowMs: now() });
  }

  /** The boards a group, a type or the fleet stands for, with why the others are left out. */
  async function computedBoards(candidates, release, { leaveOutAway = false, older = false } = {}) {
    const busy = await busyOf(
      candidates.filter((board) => !board.bluetoothOnly && board.type === release.board).map((board) => board.thing)
    );
    return selectTargets({ release, candidates, busy, nowMs: now(), leaveOutAway, older });
  }

  /**
   * A plan of rollouts, one per board type: for "Update everything" the newest active release of
   * each type, for a group's rollback the one before it. [{ type, label, release, from, things,
   * leftOut, canary }]; `release` is null where there is nothing to send.
   */
  async function plan({ group = null, rollback = false } = {}) {
    const [loaded, byType] = await Promise.all([fleet.boards(), fleet.releasesByType()]);
    const fleetBoards = loaded.map(({ board }) => board);
    const inScope = group === null ? fleetBoards : fleetBoards.filter((board) => group.things.includes(board.thing));
    const types = [];
    for (const type of BOARD_TYPES) {
      const candidates = inScope.filter((board) => board.type === type);
      if (group !== null && candidates.length === 0) continue;
      const releases = byType[type] ?? [];
      const release = rollback ? (releases[1] ?? null) : (releases[0] ?? null);
      const from = rollback ? (releases[0]?.version ?? null) : null;
      if (release === null) {
        const text = rollback
          ? 'There is no older active release of this type'
          : 'There is no release of this type yet';
        types.push({
          type,
          label: boardLabel(type),
          release: null,
          from,
          things: [],
          leftOut: candidates.map((board) => ({
            thing: board.thing,
            reason: rollback ? 'no_older' : 'no_release',
            text,
          })),
          canary: [],
        });
        continue;
      }
      const chosen = await computedBoards(candidates, release, { leaveOutAway: true, older: rollback });
      types.push({
        type,
        label: boardLabel(type),
        release: {
          version: release.version,
          layout: release.layout,
          uploadedAt: release.uploadedAt,
          notes: release.notes,
        },
        from,
        ...chosen,
        canary: chosen.things.length === 0 ? [] : chooseCanary(chosen.things, fleetBoards, DEFAULT_CANARY),
      });
    }
    return { types, generatedAt: new Date(now()).toISOString() };
  }

  /** Start what a reviewed plan says, checked against the plan as it is now. */
  /** What a plan started: its rollouts, each with the release it sends. */
  function noteStarted(entry, started) {
    for (const record of started) noteChange(entry, 'rollout', null, `${record.id} (${record.version})`);
  }

  async function startPlan({ body, actor, entry, purpose, target, group = null }) {
    const options = rolloutOptions(body);
    const asked = field(body, 'types');
    if (!Array.isArray(asked) || asked.length < 1 || asked.length > BOARD_TYPES.length) {
      throw badRequest(
        'invalid_types',
        `"types" lists 1 to ${BOARD_TYPES.length} board types, each with its version and boards.`
      );
    }
    const wanted = asked.map((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw badRequest('invalid_types', 'Each entry of "types" is { type, version, things }.');
      }
      return {
        type: requireBoardType(field(item, 'type')),
        version: requireVersion(field(item, 'version')),
        things: requireBoardList(field(item, 'things')),
      };
    });
    if (new Set(wanted.map((item) => item.type)).size !== wanted.length) {
      throw badRequest('invalid_types', 'A board type is listed twice.');
    }
    entry.detail.versions = wanted.map((item) => `${item.type} ${item.version.text}`).join(', ');
    entry.detail.things = String(wanted.reduce((sum, item) => sum + item.things.length, 0));

    const now_ = await plan({ group, rollback: purpose === 'rollback' });
    const loaded = (await fleet.boards()).map(({ board }) => board);
    const typeOf = new Map(loaded.map((board) => [board.thing, board.type]));
    const layoutOf = new Map(loaded.map((board) => [board.thing, board.layout]));
    const chosen = [];
    for (const item of wanted) {
      const planned = now_.types.find((entry_) => entry_.type === item.type);
      if (!planned || planned.release === null) {
        if (purpose === 'rollback') {
          throw conflict(
            'no_older_release',
            `There is no older active release of the ${boardLabel(item.type)} to go back to.`
          );
        }
        throw planChanged(`There is no release of the ${boardLabel(item.type)}.`);
      }
      if (planned.release.version !== item.version.text) {
        throw planChanged(`The release for the ${boardLabel(item.type)} is now ${planned.release.version}.`);
      }
      const others = item.things.filter((thing) => typeOf.has(thing) && typeOf.get(thing) !== item.type);
      if (others.length > 0) {
        throw new HttpError(
          400,
          'incompatible_board',
          `Release ${item.version.text} is for the ${boardLabel(item.type)}: ` +
            `${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} not.`,
          others.map((thing) => ({ thing, type: typeOf.get(thing) }))
        );
      }
      // Of the type, and of another flash layout: refused the same way, by name.
      const laidOut = item.things.filter(
        (thing) => layoutOf.has(thing) && layoutOf.get(thing) !== planned.release.layout
      );
      if (laidOut.length > 0) {
        throw new HttpError(
          400,
          'incompatible_layout',
          `Release ${item.version.text} is built for flash layout ` +
            `${planned.release.layout}: ${laidOut.join(', ')} ${laidOut.length === 1 ? 'has' : 'have'} another.`,
          laidOut.map((thing) => ({ thing, layout: layoutOf.get(thing) }))
        );
      }
      const outside = item.things.filter((thing) => !planned.things.includes(thing));
      if (outside.length > 0) {
        const why = outside.map(
          (thing) =>
            planned.leftOut.find((left) => left.thing === thing) ?? {
              thing,
              reason: 'not_in_plan',
              text: 'Not part of this plan',
            }
        );
        throw planChanged(`${outside.join(', ')} would not take it now: ${why[0].text}.`, why);
      }
      chosen.push({ planned, things: item.things });
    }

    const started = [];
    try {
      for (const { planned, things } of chosen) {
        const release = await findRelease(requireVersion(planned.release.version));
        const leftOut = planned.leftOut.concat(
          planned.things
            .filter((thing) => !things.includes(thing))
            .map((thing) => ({ thing, reason: 'unticked', text: 'Left out by hand' }))
        );
        started.push(
          await start({ release, things, leftOut, target: { ...target, type: planned.type }, purpose, options, actor })
        );
        entry.detail.rollouts = started.map((record) => record.id).join(' ');
      }
    } catch (error) {
      noteStarted(entry, started);
      if (started.length === 0) throw error;
      log({
        level: 'error',
        event: 'plan_partly_started',
        started: started.map((record) => record.id),
        error: describeError(error),
      });
      throw new HttpError(
        500,
        'partly_started',
        `${started.length} of ${chosen.length} rollouts were started ` +
          `(${started.map((record) => record.id).join(', ')}); the next could not be: ${error.message ?? 'see the log'}`
      );
    }
    noteStarted(entry, started);
    return { status: 201, body: { rollouts: await Promise.all(started.map(detailOf)) } };
  }

  // The schedule's part: moving open rollouts on.

  /** Change a rollout if nobody changed it in the meantime; the item after it, or null. */
  async function change(item, set) {
    const result = await aws.updateFleetItem({
      pk: 'ROL',
      sk: item.id,
      rev: item.rev,
      set: { ...set, updatedAt: new Date(now()).toISOString() },
    });
    return result.ok ? result.item : null;
  }

  /**
   * On record once, whoever runs it: `step` is "waves", "stage-<n>" or, for a stop, nothing. `to` is where
   * the rollout went from where `item` stood: what the entry says changed.
   */
  async function note(item, action, detail, step = 'waves', to = null) {
    const entry = { changes: [] };
    noteChange(entry, 'phase', phaseOf(item), to);
    await audit.recordOnce({
      at: now(),
      requestId: `rollout.${item.id}.${action === 'rollout.advance' ? step : 'stop'}`,
      actor: CONSOLE_ACTOR,
      action,
      target: item.id,
      outcome: 'ok',
      detail: { version: item.version, ...detail },
      changes: entry.changes,
    });
  }

  async function stop(item, code, text = STOP_TEXT[code], extra = {}) {
    const at = new Date(now()).toISOString();
    const changed = await change(item, { stage: 'stopped', stopped: { code, text, at, ...extra }, finishedAt: at });
    if (changed !== null) {
      await note(item, 'rollout.stop', { code, text }, undefined, 'stopped');
      if (SELF_STOPS.has(code)) await alertStopped(item, text, Date.parse(at), extra);
    }
    return changed === null ? 'raced' : 'stopped';
  }

  /**
   * The "deployment" alert of a rollout that stopped by itself, for the job that failed: the
   * canary's, or the waves'. The alerter never throws; it logs what it could not send.
   */
  async function alertStopped(item, text, at, extra = {}) {
    if (typeof alert !== 'function') return;
    const deployment =
      item.stage === 'waves'
        ? item.rest?.job
        : item.stage === 'stages' && item.current >= 0
          ? item.stages?.[item.current]?.job
          : item.canary?.job;
    if (typeof deployment !== 'string') return;
    const line = `Staged rollout ${item.id} of ${item.version}: ${String(text ?? '').replace(/[^\x20-\x7e]/g, '?')}`;
    await alert({
      kind: 'deployment',
      deployment,
      version: item.version,
      rollout: item.id,
      at,
      text: line.length > ALERT_TEXT_MAX ? `${line.slice(0, ALERT_TEXT_MAX - 3)}...` : line,
      link: Number.isInteger(extra.issue?.id) ? `#/memfault/${extra.issue.id}` : `#/rollouts/${item.id}`,
    });
  }

  async function finish(item, extra = {}) {
    const at = new Date(now()).toISOString();
    return (await change(item, { stage: 'done', finishedAt: at, ...extra })) === null ? 'raced' : 'done';
  }

  /** What a CANCELED job of a rollout says about why it stopped; `where` names the stage. */
  function cancelledWhy(job, executions, item, where = '') {
    if (job.reasonCode === 'RELEASE_REVOKED') return ['revoked'];
    const share = failureShare(executions);
    if (job.reasonCode === null && share.executed > 0 && share.percent >= item.abortPercent) {
      return [
        'aborted',
        `${where}${share.failed} of ${share.executed} finished boards failed, which reaches ` +
          `${item.abortPercent}%: AWS IoT stopped the rest`,
      ];
    }
    return ['cancelled_elsewhere'];
  }

  /** Why each failed canary board failed, as the board wrote it into its job. */
  async function canaryWords(job, failed) {
    const words = [];
    for (const { thing, status } of failed) {
      let reason = null;
      try {
        reason = (await aws.describeJobExecution(job, thing))?.statusDetails?.reason ?? null;
      } catch {
        // The status says enough.
      }
      words.push(
        `${thing} ${status.toLowerCase().replace('_', ' ')}${reason && /^[a-z_]{1,32}$/.test(reason) ? ` (${reason})` : ''}`
      );
    }
    return `The canary did not confirm the update: ${words.join(', ')}`;
  }

  /** The canary has confirmed: look at the rest again, and start the waves on what is left. */
  async function startWaves(item) {
    const releaseItem = await aws.getRelease(releaseKey(requireVersion(item.version).parts));
    const release = releaseFromItem(releaseItem);
    if (release === null || release.status !== 'active') return stop(item, 'revoked');
    const rest = item.rest?.things ?? [];
    const loaded = (await fleet.boards({ only: rest })).map(({ board }) => board);
    const gone = rest
      .filter((thing) => !loaded.some((board) => board.thing === thing))
      .map((thing) => ({ thing, reason: 'gone', text: 'No longer registered' }));
    const chosen = await computedBoards(loaded, release, {
      leaveOutAway: item.purpose !== 'deploy',
      older: item.purpose === 'rollback',
    });
    const leftOut = [...gone, ...chosen.leftOut];
    const startedAt = new Date(now()).toISOString();
    if (chosen.things.length === 0) return finish(item, { rest: { things: [], leftOut, job: null, startedAt: null } });
    const claimed = await change(item, {
      stage: 'waves',
      rest: { things: chosen.things, leftOut, job: null, startedAt },
    });
    if (claimed === null) return 'raced';

    const { rollout: pace, abort } = rolloutConfigs(item);
    const by = item.createdBy ?? CONSOLE_ACTOR;
    const description = buildJobDescription({ email: by.email, sub: by.sub, note: stageNote(item, 'waves') });
    let job;
    try {
      ({ id: job } = await deployments.launch({
        release,
        things: chosen.things,
        description,
        actorSub: by.sub || 'rollout',
        rollout: pace,
        abort,
      }));
    } catch (error) {
      log({ level: 'error', event: 'waves_not_started', rollout: item.id, error: describeError(error) });
      return stop(
        claimed,
        'job_failed',
        `The waves could not be started: ${String(error?.message ?? 'see the log').slice(0, 160)}`
      );
    }
    const named = await change(claimed, { rest: { things: chosen.things, leftOut, job, startedAt } });
    await note(item, 'rollout.advance', { things: String(chosen.things.length), job }, 'waves', 'waves');
    // Cancelled while the job was being made: then it goes too.
    const after = named ?? (await aws.getFleetItem({ pk: 'ROL', sk: item.id }));
    if (after?.stage === 'cancelled') {
      await aws
        .cancelJob({ jobId: job, force: true, reasonCode: 'CONSOLE_CANCEL', comment: 'rollout cancelled' })
        .catch(() => null);
      if (named === null) await change(after, { rest: { ...after.rest, job } });
    }
    return 'advanced';
  }

  /** The stages with stage `index` changed. */
  function withStage(item, index, changes) {
    return item.stages.map((stage, at) => (at === index ? { ...stage, ...changes } : stage));
  }

  /**
   * Start stage `index`: look at its boards again, claim the start (a conditional write, so that
   * only one run starts it), create its job on all of them at once, and name the job.
   */
  async function startStage(item, index) {
    const n = index + 1;
    const releaseItem = await aws.getRelease(releaseKey(requireVersion(item.version).parts));
    const release = releaseFromItem(releaseItem);
    if (release === null || release.status !== 'active') return stop(item, 'revoked');
    const planned = item.stages[index].things ?? [];
    const loaded = (await fleet.boards({ only: planned })).map(({ board }) => board);
    const gone = planned
      .filter((thing) => !loaded.some((board) => board.thing === thing))
      .map((thing) => ({ thing, reason: 'gone', text: 'No longer registered' }));
    const chosen = await computedBoards(loaded, release, {
      leaveOutAway: item.purpose !== 'deploy',
      older: item.purpose === 'rollback',
    });
    const leftOut = [...gone, ...chosen.leftOut];
    const at = new Date(now()).toISOString();
    if (chosen.things.length === 0) {
      // Nothing of it is left to update: it is over at once, and the next one is due.
      const skipped = await change(item, {
        current: index,
        stages: withStage(item, index, { things: [], leftOut, job: null, startedAt: null, doneAt: at }),
      });
      return skipped === null ? 'raced' : advanceStages(skipped);
    }
    const claimed = await change(item, {
      current: index,
      stages: withStage(item, index, { things: chosen.things, leftOut, job: null, startedAt: at, doneAt: null }),
    });
    if (claimed === null) return 'raced';

    const { abort } = rolloutConfigs(item);
    const by = item.createdBy ?? CONSOLE_ACTOR;
    const description = buildJobDescription({ email: by.email, sub: by.sub, note: stageNote(item, n) });
    let job;
    try {
      ({ id: job } = await deployments.launch({
        release,
        things: chosen.things,
        description,
        actorSub: by.sub || 'rollout',
        rollout: STAGE_ROLLOUT,
        abort,
      }));
    } catch (error) {
      log({ level: 'error', event: 'stage_not_started', rollout: item.id, stage: n, error: describeError(error) });
      return stop(
        claimed,
        'job_failed',
        `Stage ${n} could not be started: ${String(error?.message ?? 'see the log').slice(0, 160)}`
      );
    }
    const named = await change(claimed, { stages: withStage(claimed, index, { job }) });
    await note(
      item,
      'rollout.advance',
      { stage: String(n), things: String(chosen.things.length), job },
      `stage-${n}`,
      `stage ${n}`
    );
    // Cancelled while the job was being made: then it goes too.
    const after = named ?? (await aws.getFleetItem({ pk: 'ROL', sk: item.id }));
    if (after?.stage === 'cancelled') {
      await aws
        .cancelJob({ jobId: job, force: true, reasonCode: 'CONSOLE_CANCEL', comment: 'rollout cancelled' })
        .catch(() => null);
      if (named === null) await change(after, { stages: withStage(after, index, { job }) });
    }
    return 'advanced';
  }

  /**
   * A rollout in "stages": the stage under way, if it has ended, is marked done (or stops the
   * rollout); then, once the soak time after the last one ended is over, the next starts.
   */
  async function advanceStages(item) {
    const index = Number.isInteger(item.current) ? item.current : -1;
    const stage = index >= 0 ? item.stages[index] : null;
    if (stage !== null && !stage.doneAt) {
      const where = `Stage ${index + 1}: `;
      if (stage.job === null) {
        // The start was cut off before it named its job: look for it once it is late.
        if (now() - (Date.parse(stage.startedAt ?? '') || 0) < LOST_START_MS) return 'waiting';
        const open = await deployments.unfinishedOn(stage.things);
        const found = [...new Set(open.map((entry) => entry.deployment))].filter(
          (id) => parseJobId(id)?.version === item.version
        );
        if (found.length === 1)
          return (await change(item, { stages: withStage(item, index, { job: found[0] }) })) ? 'advanced' : 'raced';
        return stop(item, 'job_failed', `${where}its job was never named`);
      }
      const job = await aws.describeJob(stage.job);
      if (job === null) return stop(item, 'job_missing');
      if (job.status === 'CANCELED') {
        const [code, text] = cancelledWhy(job, await aws.listJobExecutionsForJob(stage.job), item, where);
        return stop(item, code, text);
      }
      if (job.status !== 'COMPLETED') return 'waiting';
      const verdict = stageVerdict(failureShare(await aws.listJobExecutionsForJob(stage.job)), item.abortPercent);
      if (verdict.over) {
        return stop(
          item,
          'aborted',
          `${where}${verdict.failed} of ${verdict.executed} finished boards failed, which reaches ` +
            `${item.abortPercent}%: the next stage was not started`
        );
      }
      const done = await change(item, { stages: withStage(item, index, { doneAt: new Date(now()).toISOString() }) });
      if (done === null) return 'raced';
      return advanceStages(done);
    }
    const next = index + 1;
    if (next >= item.stages.length) return finish(item);
    const endedAt = Date.parse((index >= 0 ? stage.doneAt : item.canary?.doneAt) ?? '') || 0;
    const gated = await healthGate(item, index, endedAt);
    if (typeof gated === 'string') return gated;
    if (now() < endedAt + (gated.soakMinutes ?? 0) * 60_000) return 'waiting';
    return startStage(gated, next);
  }

  /**
   * The health gate after part `index` (-1 the canary) ended at `endedAt`: the item, with the gate
   * marked passed if it has just passed, to go on with; or what happened instead ("waiting",
   * "stopped", "raced").
   */
  async function healthGate(item, index, endedAt) {
    const gate = item.healthGate;
    if (gate === null || typeof gate !== 'object' || !Number.isInteger(gate.minutes)) return item;
    const part = index < 0 ? item.canary : item.stages[index];
    if (part?.gatePassedAt) return item;
    const due = endedAt + gate.minutes * 60_000;
    if (now() < due) return 'waiting';
    const where = index < 0 ? 'After the canary, ' : `After stage ${index + 1}, `;
    const reader = memfault();
    const seen =
      reader === null
        ? { state: 'not_configured' }
        : await reader.health({ version: item.version, boards: gateBoards(item, index) });
    if (seen.state === 'ok' && seen.problem === null) {
      const at = new Date(now()).toISOString();
      const passed =
        index < 0
          ? await change(item, { canary: { ...item.canary, gatePassedAt: at } })
          : await change(item, { stages: withStage(item, index, { gatePassedAt: at }) });
      if (passed === null) return 'raced';
      await note(
        item,
        'rollout.advance',
        { gate: 'passed', after: index < 0 ? 'canary' : `stage ${index + 1}` },
        `gate-${index + 1}`
      );
      return passed;
    }
    if (seen.state === 'ok') {
      const { problem } = seen;
      const extra = {
        thing: problem.thing,
        ...(problem.kind === 'issue' ? { issue: problem.issue } : { reason: problem.reason }),
      };
      return stop(item, 'health_failed', `${healthWords(problem, where)}: the next stage was not started`, extra);
    }
    log({ level: 'warn', event: 'health_gate_unread', rollout: item.id, state: seen.state });
    if (now() < due + GATE_WAIT_MS) return 'waiting';
    const why = UNREAD_WORDS[seen.state] ?? UNREAD_WORDS.unreachable;
    return stop(
      item,
      'health_unknown',
      `${where}the health gate could not read Memfault for ${GATE_WAIT_MS / 60_000} minutes (${why}): ` +
        'the next stage was not started'
    );
  }

  /** One open rollout, one step on if there is one to take. Returns what happened. */
  async function advanceOne(item) {
    if (item.stage === 'canary') {
      const job = await aws.describeJob(item.canary.job);
      if (job === null) return stop(item, 'job_missing');
      const executions = await aws.listJobExecutionsForJob(item.canary.job);
      const verdict = canaryVerdict(item.canary.things, executions);
      // Cancelled, by a revocation or a person: its boards' executions say CANCELED, which is no
      // failure of theirs. A board that did fail first still makes it the canary's failure.
      const failedItself = verdict.failed.some((entry) => entry.status !== 'CANCELED');
      if (job.status === 'CANCELED' && (job.reasonCode === 'RELEASE_REVOKED' || !failedItself)) {
        const [code, text] = cancelledWhy(job, executions, item);
        return stop(item, code, text);
      }
      if (verdict.state === 'failed') {
        // What has not started of a larger canary does not start either.
        if (job.status === 'IN_PROGRESS') {
          await aws
            .cancelJob({ jobId: item.canary.job, force: false, reasonCode: 'CANARY_FAILED', comment: item.id })
            .catch(() => null);
        }
        return stop(item, 'canary_failed', await canaryWords(item.canary.job, verdict.failed));
      }
      if (verdict.state !== 'confirmed') return 'waiting';
      if (item.canary.only || (item.rest?.things ?? []).length === 0) return finish(item);
      // A rollout from before the stages goes on in waves.
      if (!Array.isArray(item.stages)) return startWaves(item);
      if (item.stages.length === 0) return finish(item);
      const confirmed = await change(item, {
        stage: 'stages',
        canary: { ...item.canary, doneAt: new Date(now()).toISOString() },
      });
      if (confirmed === null) return 'raced';
      const next = await advanceStages(confirmed);
      return next === 'waiting' ? 'advanced' : next;
    }
    if (item.stage === 'stages') return advanceStages(item);
    if (item.stage === 'waves') {
      if (item.rest.job === null) {
        // The start of the waves was cut off before it named its job: look for it once it is late.
        if (now() - (Date.parse(item.rest.startedAt ?? '') || 0) < LOST_START_MS) return 'waiting';
        const open = await deployments.unfinishedOn(item.rest.things);
        const found = [...new Set(open.map((entry) => entry.deployment))].filter(
          (id) => parseJobId(id)?.version === item.version
        );
        if (found.length === 1)
          return (await change(item, { rest: { ...item.rest, job: found[0] } })) ? 'advanced' : 'raced';
        return stop(item, 'job_failed');
      }
      const job = await aws.describeJob(item.rest.job);
      if (job === null) return stop(item, 'job_missing');
      if (job.status === 'COMPLETED') return finish(item);
      if (job.status === 'CANCELED') {
        const [code, text] = cancelledWhy(job, await aws.listJobExecutionsForJob(item.rest.job), item);
        return stop(item, code, text);
      }
      return 'waiting';
    }
    return 'over';
  }

  /** Move every open rollout on as far as it goes now: what the schedule runs every minute. */
  async function advance() {
    const items = (await aws.listFleetItems('ROL')).filter((item) => isOpenRollout(item));
    const outcome = { checked: items.length, advanced: 0, stopped: 0, done: 0, failed: 0 };
    for (const item of items.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      try {
        const result = await advanceOne(item);
        if (result in outcome) outcome[result] += 1;
      } catch (error) {
        outcome.failed += 1;
        log({ level: 'error', event: 'rollout_not_advanced', rollout: item.id, error: describeError(error) });
      }
    }
    return outcome;
  }

  return {
    advance,

    async list() {
      const items = (await aws.listFleetItems('ROL')).slice(0, LIST_LIMIT);
      return { body: { rollouts: items.map(rolloutFromItem).filter((rollout) => rollout !== null) } };
    },

    /**
     * What the console suggests for a rollout of `release` to `group` (or to the fleet): the boards
     * it would go to, and lib/stages.mjs suggestPlan of them. A read: it starts nothing.
     */
    async suggest({ query }) {
      const version = requireVersion(query?.release);
      const release = await findRelease(version);
      const loaded = (await fleet.boards()).map(({ board }) => board);
      let candidates = loaded.filter((board) => board.type === release.board);
      let group = null;
      if (query?.group !== undefined && query.group !== '') {
        const id = requireGroupId(query.group);
        const found = (await fleet.groups(new Set(loaded.map((board) => board.thing)))).find((item) => item.id === id);
        if (found === undefined) throw notFound('unknown_group', 'There is no group with that id.');
        group = { id: found.id, name: found.name };
        candidates = loaded.filter((board) => found.things.includes(board.thing));
      }
      const chosen = await computedBoards(candidates, release);
      const byThing = new Map(loaded.map((board) => [board.thing, board]));
      const plan = suggestPlan({
        boards: chosen.things,
        online: chosen.things.filter((thing) => byThing.get(thing)?.online === true),
        types: Object.fromEntries(chosen.things.map((thing) => [thing, byThing.get(thing)?.type ?? release.board])),
        history: await historyOf(chosen.things),
      });
      return {
        body: {
          suggestion: {
            release: { version: release.version, board: release.board },
            group,
            things: chosen.things,
            leftOut: chosen.leftOut,
            canarySize: Math.min(Math.max(plan.canary.length, 1), MAX_CANARY),
            abortPercent: DEFAULT_ABORT_PERCENT,
            ...plan,
            generatedAt: new Date(now()).toISOString(),
          },
        },
      };
    },

    async get({ params }) {
      const id = requireRolloutId(params.id);
      return { body: { rollout: await detailOf(await readItem(id)) } };
    },

    async create({ caller, actor, json, entry }) {
      const body = json();
      const version = requireVersion(field(body, 'version'));
      entry.target = version.text;
      entry.detail.version = version.text;
      const target = field(body, 'target');
      const kind =
        target !== null && typeof target === 'object' && !Array.isArray(target) ? field(target, 'kind') : undefined;
      if (!['boards', 'group', 'type', 'fleet'].includes(kind)) {
        throw badRequest(
          'invalid_target',
          '"target" is { kind: "boards", things }, { kind: "group", group }, ' +
            '{ kind: "type", type } or { kind: "fleet" }.'
        );
      }
      entry.detail.kind = kind;
      const options = rolloutOptions(body);
      if (caller?.clientId !== undefined && caller.clientId === config.mobileClientId) entry.detail.from = 'phone';
      const release = await findRelease(version);

      let chosen;
      let stored = { kind };
      if (kind === 'boards') {
        const things = requireBoardList(field(target, 'things'));
        chosen = await namedBoards(things, release);
      } else {
        const loaded = (await fleet.boards()).map(({ board }) => board);
        let candidates = loaded;
        if (kind === 'group') {
          const id = requireGroupId(field(target, 'group'));
          const group = (await fleet.groups(new Set(loaded.map((board) => board.thing)))).find(
            (item) => item.id === id
          );
          if (group === undefined) throw notFound('unknown_group', 'There is no group with that id.');
          entry.detail.group = id;
          stored = { kind, group: id, groupName: group.name };
          candidates = loaded.filter((board) => group.things.includes(board.thing));
        } else if (kind === 'type') {
          const type = requireBoardType(field(target, 'type'));
          if (type !== release.board) {
            throw new HttpError(
              400,
              'incompatible_board',
              `Release ${release.version} is for the ${boardLabel(release.board)}, ` + `not the ${boardLabel(type)}.`
            );
          }
          stored = { kind, type };
          candidates = loaded.filter((board) => board.type === type);
        }
        chosen = await computedBoards(candidates, release);
      }
      entry.detail.things = String(chosen.things.length);
      nameBoards(entry, 'boards', chosen.things);
      if (chosen.things.length === 0) throw nothingToDeploy(chosen.leftOut);
      const record = await start({
        release,
        things: chosen.things,
        leftOut: chosen.leftOut,
        target: stored,
        purpose: 'deploy',
        options,
        actor,
        entry,
      });
      entry.target = record.id;
      return { status: 201, body: { rollout: await detailOf(record) } };
    },

    async cancel({ actor, params, json, entry }) {
      const id = requireRolloutId(params.id);
      entry.target = id;
      const force = requireBoolean(field(json(), 'force'), 'force', false);
      entry.detail.force = String(force);
      let item = await readItem(id);
      entry.detail.version = item.version;
      for (let attempt = 0; ; attempt += 1) {
        if (!isOpenRollout(item))
          throw conflict('already_finished', 'This rollout has already ended; there is nothing left to cancel.');
        const at = new Date(now()).toISOString();
        const changed = await change(item, {
          stage: 'cancelled',
          finishedAt: at,
          stopped: {
            code: 'cancelled',
            text: `Cancelled by ${actor.email || 'a release manager'}`,
            at,
            by: actor.email,
          },
        });
        if (changed !== null) {
          noteChange(entry, 'phase', phaseOf(item), 'cancelled');
          item = changed;
          break;
        }
        if (attempt >= 2)
          throw conflict('rollout_changed', 'The rollout moved on while it was being cancelled. Try again.');
        item = await readItem(id);
      }
      const cancelled = [];
      const jobs = [item.canary?.job, item.rest?.job, ...(item.stages ?? []).map((stage) => stage?.job)];
      for (const job of jobs.filter((value) => typeof value === 'string')) {
        const result = await aws.cancelJob({ jobId: job, force, reasonCode: 'CONSOLE_CANCEL', comment: actor.sub });
        if (result.ok) cancelled.push(job);
      }
      entry.detail.cancelled = String(cancelled.length);
      return { body: { rollout: await detailOf(item) } };
    },

    async everythingPlan() {
      return { body: { plan: await plan() } };
    },

    async everything({ actor, json, entry }) {
      entry.target = 'fleet';
      return startPlan({ body: json(), actor, entry, purpose: 'update_everything', target: { kind: 'type' } });
    },

    async rollbackPlan({ params }) {
      const id = requireGroupId(params.id);
      const group = await liveGroup(id);
      const found = await plan({ group, rollback: true });
      return { body: { plan: { ...found, group: { id: group.id, name: group.name } } } };
    },

    async rollback({ actor, params, json, entry }) {
      const id = requireGroupId(params.id);
      entry.target = id;
      const group = await liveGroup(id);
      entry.detail.group = group.name;
      return startPlan({
        body: json(),
        actor,
        entry,
        purpose: 'rollback',
        target: { kind: 'group', group: id, groupName: group.name },
        group,
      });
    },
  };

  async function liveGroup(id) {
    const registered = new Set(await devices.groupThings());
    const group = (await fleet.groups(registered)).find((item) => item.id === id);
    if (group === undefined) throw notFound('unknown_group', 'There is no group with that id.');
    return group;
  }
}

/**
 * The schedule's entry (rollouts-tick.mjs): the handlers of a rollout on an adapter, with no request
 * around them. Every minute it moves the open rollouts on; it serves nothing.
 */
export async function runRolloutTick(handlers, log) {
  const outcome = await handlers.advance();
  if (outcome.checked > 0) log({ event: 'rollouts_advanced', ...outcome });
  return outcome;
}

export { STOP_TEXT };
