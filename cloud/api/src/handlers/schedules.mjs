/**
 * Scheduled starts (console 2.20.0, docs/mass-updates.md, Scheduled starts): a deployment, a staged
 * rollout or a roll back to last good, asked for now and started later by the schedule that moves the
 * rollouts on (tick.mjs), with the same handlers as a start by hand.
 *
 *   GET  /api/schedules               -> { schedules: [Schedule] }, newest first, at most 50
 *   POST /api/schedules               body { kind, at, timeZone, request }   -> 201 { schedule }  schedule.create
 *   POST /api/schedules/{id}          body { at?, timeZone?, request? }      -> { schedule }      schedule.edit
 *   POST /api/schedules/{id}/cancel   body {}                                -> { schedule }      schedule.cancel
 *
 * `kind` is "deployment" (request as for POST /api/deployments), "rollout" (as for POST /api/rollouts)
 * or "last_good" ({ group?, things?, canary?, stages?, batch?, soakMinutes?, healthGate?, abortPercent?,
 * note? }: a roll back to last good of the group, or of the fleet, for the boards in `things` or all).
 * `at` is a local date and time ("2026-11-10T02:00") in `timeZone` (lib/schedule.mjs), at least a minute
 * and at most 30 days ahead. The request is checked as far as it can be without starting anything: its
 * fields as the start would check them, the release active and the group there. Everything else (busy
 * boards, the board types and layouts, a release revoked since, the health gate) is checked when it
 * starts, by the handler a start by hand runs.
 *
 * How it starts. Every minute the schedule (tick.mjs startDue) looks at the open schedules that are due.
 * A schedule for a group with a maintenance window (handlers/groups.mjs) waits for the window: it is
 * marked `waiting: "window"`, and the console says so. One that may start is first claimed, from
 * "scheduled" to "starting", by a write on the condition that nobody changed it since (its rev): of two
 * runs at the same moment only one gets it, and only that one starts it. Then the start runs as its
 * creator, as if they had pressed the button then, and the schedule is "started" with what it started,
 * or "failed" with why. Right before the claim its creator is asked of Cognito, as every write by hand is
 * (auth.mjs requireLiveWriter): an account that is gone, disabled, not confirmed or no longer a release
 * manager does not start it; it is "cancelled" with code creator_not_allowed, on record as schedule.cancel by
 * the console, and an alert. Cognito not to be asked: it waits and is asked again on the next run, never
 * started unasked. This is only for a start that has not begun: a deployment or staged rollout under way is
 * never paused, stopped or cancelled for what becomes of its creator. A run cut off between the claim and its end leaves "starting", which is never
 * started again: after START_LOST_MS it is "failed" with code start_lost, to be looked at by a person.
 *
 * A Schedule is { id, kind, request, group, at, timeZone, dueAt, status, waiting, createdAt, createdBy,
 * updatedAt, updatedBy, startedAt, started, error, cancelledAt, cancelledBy }; `started` is
 * { deployments?, rollouts? } of ids. Stored in the state table, pk SCH, sk the id (sch-<time>-<6 hex>);
 * never deleted (no role may delete there), cancelled instead. Each create, edit, cancel and start goes
 * on record with what it changed, before and after (lib/audit.mjs change).
 */

import { HttpError, badRequest, conflict, describeError, field, notFound } from '../http.mjs';
import { boardsValue, change as noteChange } from '../lib/audit.mjs';
import { BOARD_TYPES, isBoardType } from '../lib/boards.mjs';
import { requireGroupId } from '../lib/fleet.mjs';
import {
  MAX_OPEN_SCHEDULES,
  SCHEDULE_KINDS,
  insideWindow,
  isOpenSchedule,
  requireAhead,
  requireLocalTime,
  requireScheduleId,
  scheduleId,
  windowFromItem,
  windowWords,
} from '../lib/schedule.mjs';
import { MAX_NOTE, requireText, requireThings, requireVersion } from '../lib/validate.mjs';
import { releaseFromItem, releaseKey } from './firmware.mjs';
import { requireBoardList, rolloutOptions } from './rollouts.mjs';

const LIST_LIMIT = 50;
export const START_LOST_MS = 10 * 60_000;
const CONSOLE_ACTOR = Object.freeze({ sub: '', email: '' });
const ERROR_TEXT_MAX = 300;
const STARTED_BY = Object.freeze({
  deployment: 'deployment.create',
  rollout: 'rollout.create',
  last_good: 'fleet.rollback_last_good',
});

function unknownSchedule() {
  return notFound('unknown_schedule', 'There is no scheduled start with that id.');
}

function scheduleOver(item) {
  return conflict(
    'schedule_over',
    item.status === 'cancelled'
      ? 'This scheduled start was cancelled already.'
      : 'This scheduled start has begun or ended: it can no longer be changed.'
  );
}

/** A plain object of a request body, or a 400. */
function requireObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`invalid_${name}`, `"${name}" is an object.`);
  }
  return value;
}

/** A stored schedule as the API shows it. */
export function scheduleFromItem(item) {
  if (item === null || typeof item !== 'object' || typeof item.id !== 'string') return null;
  return {
    id: item.id,
    kind: item.kind,
    request: item.request ?? {},
    group: item.group ?? null,
    groupName: item.groupName ?? null,
    at: item.at,
    timeZone: item.timeZone,
    dueAt: item.dueAt,
    status: item.status,
    waiting: item.status === 'scheduled' && item.waiting === 'window' ? 'window' : null,
    window: item.status === 'scheduled' ? (item.window ?? null) : null,
    createdAt: item.createdAt ?? null,
    createdBy: item.createdBy ?? null,
    updatedAt: item.updatedAt ?? item.createdAt ?? null,
    updatedBy: item.updatedBy ?? item.createdBy ?? null,
    startedAt: item.startedAt ?? null,
    started: item.started ?? null,
    error: item.error ?? null,
    cancelledAt: item.cancelledAt ?? null,
    cancelledBy: item.cancelledBy ?? null,
  };
}

/** What the activity log keeps of a schedule, field by field, for the before and after of a change. */
function summary(item) {
  if (item === null) return {};
  const request = item.request ?? {};
  const target = request.target ?? null;
  let boards = null;
  if (Array.isArray(request.things)) boards = boardsValue(request.things);
  else if (target?.kind === 'boards') boards = boardsValue(target.things);
  let scope = null;
  if (item.kind === 'last_good') scope = item.group ? `group ${item.groupName ?? item.group}` : 'fleet';
  else if (target !== null) {
    scope =
      target.kind === 'group'
        ? `group ${item.groupName ?? target.group}`
        : target.kind === 'type'
          ? `type ${target.type}`
          : target.kind;
  }
  return {
    time: `${item.at} ${item.timeZone}`,
    kind: item.kind,
    version: typeof request.version === 'string' ? request.version : null,
    target: scope,
    boards,
    note: typeof request.note === 'string' && request.note !== '' ? request.note : null,
    status: item.status,
  };
}

function noteDifferences(entry, before, after) {
  const was = summary(before);
  const now = summary(after);
  for (const key of ['time', 'kind', 'version', 'target', 'boards', 'note', 'status']) {
    noteChange(entry, key, was[key] ?? null, now[key] ?? null);
  }
}

/**
 * @param {object} context  { aws, now, randomHex, log }
 * @param {object} handlers { deployments, rollouts, audit, directory }: the handlers a start by hand runs, the
 *        log, and the live check of an account (auth.mjs createDirectory), which the schedule's start needs
 */
export function createScheduleHandlers(
  { aws, now, randomHex, log, alert = null },
  { deployments, rollouts, audit, directory = null }
) {
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

  async function liveGroup(id) {
    const item = await aws.getFleetItem({ pk: 'GRP', sk: id });
    if (item === null || item.deletedAt) throw notFound('unknown_group', 'There is no group with that id.');
    return item;
  }

  /**
   * A request of `kind`, checked as far as it can be before it starts: { request, group, groupName },
   * the request as it will be handed to the start.
   */
  async function checkRequest(kind, raw) {
    const body = requireObject(raw, 'request');
    if (kind === 'deployment') {
      const version = requireVersion(field(body, 'version'));
      const things = requireThings(field(body, 'things'));
      const note = requireText(field(body, 'note'), 'note', { max: MAX_NOTE });
      await findRelease(version);
      return { request: { version: version.text, things: [...things].sort(), note }, group: null, groupName: null };
    }
    rolloutOptions(body);
    const options = {};
    for (const name of ['canary', 'stages', 'batch', 'soakMinutes', 'healthGate', 'abortPercent', 'note']) {
      if (field(body, name) !== undefined) options[name] = field(body, name);
    }
    if (kind === 'rollout') {
      const version = requireVersion(field(body, 'version'));
      const release = await findRelease(version);
      const target = requireObject(field(body, 'target'), 'target');
      const targetKind = field(target, 'kind');
      let stored;
      let group = null;
      if (targetKind === 'boards') stored = { kind: 'boards', things: requireBoardList(field(target, 'things')) };
      else if (targetKind === 'fleet') stored = { kind: 'fleet' };
      else if (targetKind === 'type') {
        const type = field(target, 'type');
        if (!isBoardType(type)) throw badRequest('invalid_type', `A board type is one of: ${BOARD_TYPES.join(', ')}.`);
        if (type !== release.board) {
          throw new HttpError(400, 'incompatible_board', `Release ${release.version} is for another board type.`);
        }
        stored = { kind: 'type', type };
      } else if (targetKind === 'group') {
        group = await liveGroup(requireGroupId(field(target, 'group')));
        stored = { kind: 'group', group: group.id };
      } else {
        throw badRequest(
          'invalid_target',
          '"target" is { kind: "boards", things }, { kind: "group", group }, { kind: "type", type } or { kind: "fleet" }.'
        );
      }
      return {
        request: { ...options, version: version.text, target: stored },
        group: group?.id ?? null,
        groupName: group?.name ?? null,
      };
    }
    // A roll back to last good: its health gate cannot be off, as by hand.
    const gate = field(body, 'healthGate');
    if (gate === null || (gate !== undefined && gate?.on === false)) {
      throw badRequest('gate_required', 'A roll back to last good runs with the health gate on.');
    }
    const groupId = field(body, 'group');
    const group = groupId === undefined || groupId === null ? null : await liveGroup(requireGroupId(groupId));
    const things = field(body, 'things');
    const request = { ...options };
    if (group !== null) request.group = group.id;
    if (things !== undefined) request.things = requireBoardList(things);
    return { request, group: group?.id ?? null, groupName: group?.name ?? null };
  }

  function requireKind(value) {
    if (!SCHEDULE_KINDS.includes(value)) {
      throw badRequest('invalid_kind', `"kind" is one of: ${SCHEDULE_KINDS.join(', ')}.`);
    }
    return value;
  }

  async function readItem(id) {
    const item = await aws.getFleetItem({ pk: 'SCH', sk: id });
    if (item === null) throw unknownSchedule();
    return item;
  }

  /** A change of a schedule, if nobody changed it since `item` was read: the item after it, or null. */
  async function change(item, set) {
    const result = await aws.updateFleetItem({
      pk: 'SCH',
      sk: item.id,
      rev: item.rev,
      set: { ...set, updatedAt: set.updatedAt ?? new Date(now()).toISOString() },
    });
    return result.ok ? result.item : null;
  }

  /** The window of a schedule's group, as it is now: null for none, or for no group. */
  async function windowOf(item) {
    if (!item.group) return null;
    const group = await aws.getFleetItem({ pk: 'GRP', sk: item.group });
    if (group === null || group.deletedAt) return null;
    return windowFromItem(group.window);
  }

  // The start, by the schedule.

  /** Run the start of a claimed schedule as its creator: what it started, or a thrown refusal. */
  async function run(item, entry) {
    const actor = { sub: item.createdBy?.sub ?? '', email: item.createdBy?.email ?? '' };
    const request = structuredClone(item.request ?? {});
    if (item.kind === 'deployment') {
      const { body } = await deployments.create({ caller: null, actor, json: () => request, entry });
      return { deployments: [body.deployment.id] };
    }
    if (item.kind === 'rollout') {
      const { body } = await rollouts.create({ caller: null, actor, json: () => request, entry });
      return { rollouts: [body.rollout.id] };
    }
    // A roll back to last good, as the plan is now: each board picked (or all) to the release that
    // takes it to its last good version now.
    const params = request.group ? { id: request.group } : {};
    const { plan } = (await rollouts.lastGoodPlan({ params })).body;
    const picked = Array.isArray(request.things) ? new Set(request.things) : null;
    const targets = plan.targets
      .map((target) => ({
        version: target.release.version,
        things: target.things.filter((thing) => picked === null || picked.has(thing)),
      }))
      .filter((target) => target.things.length > 0);
    if (targets.length === 0) {
      throw new HttpError(422, 'nothing_to_deploy', 'No board has a last good version it can be sent now.');
    }
    const { group: _group, things: _things, ...options } = request;
    const { body } = await rollouts.lastGood({ actor, params, json: () => ({ ...options, targets }), entry });
    return { rollouts: body.rollouts.map((rollout) => rollout.id) };
  }

  /** The start on record once, as the console's, with who scheduled it and what the start's handler noted. */
  async function record(item, action, outcome, entry, extra = {}) {
    const detail = {
      kind: item.kind,
      by: item.createdBy?.email ?? '',
      ...(extra.code ? { code: extra.code } : {}),
      started: action,
      ...entry.detail,
    };
    await audit.recordOnce({
      at: now(),
      requestId: `schedule.${item.id}.start`,
      actor: CONSOLE_ACTOR,
      action: 'schedule.start',
      target: item.id,
      outcome,
      detail,
      changes: entry.changes,
    });
  }

  /**
   * Whether the person who scheduled `item` may still start it: "yes", "unknown" when Cognito cannot be
   * asked (it waits and is asked again on the next run, and never starts unasked), or why not, in words.
   * The same check auth.mjs makes of every write (requireLiveWriter). Only a start that has not begun is
   * asked: a deployment or rollout already under way carries on whatever becomes of its creator.
   */
  async function creatorAllowed(item) {
    const sub = item.createdBy?.sub;
    if (typeof sub !== 'string' || sub === '') return 'its creator is not known';
    if (directory === null) return 'unknown';
    try {
      await directory.requireLiveWriter({ sub, groups: [] });
      return 'yes';
    } catch (error) {
      if (error instanceof HttpError && error.status === 403) {
        return error.code === 'account_inactive'
          ? 'its creator’s account is disabled, removed or not confirmed'
          : 'its creator is no longer a release manager';
      }
      log({
        level: 'warn',
        event: 'schedule_creator_unchecked',
        schedule: item.id,
        error: describeError(error),
      });
      return 'unknown';
    }
  }

  /** A due schedule whose creator may no longer start it: cancelled, on record, and an alert. */
  async function refuse(item, why) {
    const at = new Date(now()).toISOString();
    const text = `Not started: ${why}.`;
    const cancelled = await change(item, {
      status: 'cancelled',
      waiting: null,
      cancelledAt: at,
      cancelledBy: CONSOLE_ACTOR,
      error: { code: 'creator_not_allowed', text },
    });
    if (cancelled === null) return 'raced';
    const entry = { changes: [] };
    noteDifferences(entry, item, cancelled);
    await audit.recordOnce({
      at: now(),
      requestId: `schedule.${item.id}.cancel`,
      actor: CONSOLE_ACTOR,
      action: 'schedule.cancel',
      target: item.id,
      outcome: 'ok',
      detail: { kind: item.kind, by: item.createdBy?.email ?? '', code: 'creator_not_allowed' },
      changes: entry.changes,
    });
    if (typeof alert === 'function') {
      const line = `Scheduled start ${item.id}${item.request?.version ? ` of ${item.request.version}` : ''}: ${text}`;
      await alert({
        kind: 'deployment',
        deployment: item.id,
        version: typeof item.request?.version === 'string' ? item.request.version : null,
        at: Date.parse(at),
        text: line.replace(/[^\x20-\x7e]/g, "'").slice(0, 200),
      });
    }
    return 'refused';
  }

  /** Start one due schedule if it may start now: "started", "failed", "waiting", "raced" or "lost". */
  async function startOne(item) {
    if (item.status === 'starting') {
      if (now() - (Date.parse(item.startingAt ?? '') || 0) < START_LOST_MS) return 'raced';
      const lost = await change(item, {
        status: 'failed',
        error: {
          code: 'start_lost',
          text: 'The start was cut off before it said what it started. Look at the deployments before scheduling it again.',
        },
      });
      return lost === null ? 'raced' : 'lost';
    }
    const window = await windowOf(item);
    if (!insideWindow(window, now())) {
      if (item.waiting !== 'window' || item.window !== windowWords(window)) {
        await change(item, { waiting: 'window', window: windowWords(window) });
      }
      return 'waiting';
    }
    // Its creator, asked of Cognito now, as a write by hand is: still enabled, confirmed and a release manager.
    const allowed = await creatorAllowed(item);
    if (allowed === 'unknown') return 'waiting';
    if (allowed !== 'yes') return refuse(item, allowed);
    const at = new Date(now()).toISOString();
    const claimed = await change(item, { status: 'starting', startingAt: at, waiting: null });
    if (claimed === null) return 'raced';
    const entry = { target: '', detail: {}, changes: [] };
    let started = null;
    let failure = null;
    try {
      started = await run(claimed, entry);
    } catch (error) {
      failure = error;
    }
    const action = STARTED_BY[claimed.kind];
    if (failure === null) {
      const done = await change(claimed, { status: 'started', startedAt: at, started });
      noteChange(entry, 'status', 'scheduled', 'started');
      await record(done ?? claimed, action, 'ok', entry);
      return 'started';
    }
    const code = failure instanceof HttpError ? failure.code : 'internal_error';
    const text = String(failure?.message ?? 'see the log').slice(0, ERROR_TEXT_MAX);
    if (!(failure instanceof HttpError)) {
      log({ level: 'error', event: 'schedule_not_started', schedule: claimed.id, error: describeError(failure) });
    }
    await change(claimed, { status: 'failed', startedAt: at, error: { code, text } });
    noteChange(entry, 'status', 'scheduled', 'failed');
    const outcome = failure instanceof HttpError && failure.status < 500 ? 'rejected' : 'error';
    await record(claimed, action, outcome, entry, { code });
    return 'failed';
  }

  return {
    /** The tick's part: every open schedule that is due, started if it may start. */
    async startDue() {
      const items = (await aws.listFleetItems('SCH')).filter(
        (item) =>
          (item.status === 'scheduled' && (Date.parse(item.dueAt ?? '') || Infinity) <= now()) ||
          item.status === 'starting'
      );
      const outcome = { due: items.length, started: 0, failed: 0, waiting: 0, raced: 0, lost: 0, refused: 0 };
      for (const item of items.sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0))) {
        try {
          const result = await startOne(item);
          if (result in outcome) outcome[result] += 1;
        } catch (error) {
          outcome.failed += 1;
          log({ level: 'error', event: 'schedule_not_started', schedule: item.id, error: describeError(error) });
        }
      }
      return outcome;
    },

    async list() {
      const items = (await aws.listFleetItems('SCH')).slice(0, LIST_LIMIT);
      return { body: { schedules: items.map(scheduleFromItem).filter((item) => item !== null) } };
    },

    async create({ actor, json, entry }) {
      const body = json();
      const kind = requireKind(field(body, 'kind'));
      entry.detail.kind = kind;
      const { local, timeZone, dueMs } = requireLocalTime(field(body, 'at'), field(body, 'timeZone'));
      requireAhead(dueMs, now());
      const checked = await checkRequest(kind, field(body, 'request'));
      const open = (await aws.listFleetItems('SCH')).filter(isOpenSchedule);
      if (open.length >= MAX_OPEN_SCHEDULES) {
        throw conflict(
          'too_many_schedules',
          `There can be at most ${MAX_OPEN_SCHEDULES} scheduled starts. Cancel one first.`
        );
      }
      const at = new Date(now()).toISOString();
      const by = { sub: actor.sub, email: actor.email };
      const window = checked.group === null ? null : windowFromItem((await liveGroup(checked.group)).window);
      let item = null;
      for (let attempt = 0; attempt < 3 && item === null; attempt += 1) {
        const id = scheduleId(now(), String(randomHex(6)).slice(0, 6));
        const candidate = {
          id,
          kind,
          request: checked.request,
          group: checked.group,
          groupName: checked.groupName,
          at: local,
          timeZone,
          dueAt: new Date(dueMs).toISOString(),
          status: 'scheduled',
          waiting: null,
          window: windowWords(window),
          createdAt: at,
          createdBy: by,
          updatedAt: at,
          updatedBy: by,
          rev: 0,
        };
        if ((await aws.putFleetItem({ pk: 'SCH', sk: id, item: candidate })).ok) item = candidate;
      }
      if (item === null) throw new HttpError(500, 'internal_error', 'No free schedule id after three attempts.');
      entry.target = item.id;
      entry.detail.dueAt = item.dueAt;
      noteDifferences(entry, null, item);
      return { status: 201, body: { schedule: scheduleFromItem(item) } };
    },

    async edit({ actor, params, json, entry }) {
      const id = requireScheduleId(params.id);
      entry.target = id;
      const body = json();
      const item = await readItem(id);
      entry.detail.kind = item.kind;
      if (!isOpenSchedule(item)) throw scheduleOver(item);
      const asked = ['at', 'timeZone', 'request'].filter((name) => field(body, name) !== undefined);
      if (asked.length === 0) throw badRequest('nothing_to_change', 'Give a new "at", "timeZone", "request", or more.');
      const set = { updatedBy: { sub: actor.sub, email: actor.email } };
      const { local, timeZone, dueMs } = requireLocalTime(
        field(body, 'at') ?? item.at,
        field(body, 'timeZone') ?? item.timeZone
      );
      requireAhead(dueMs, now());
      Object.assign(set, { at: local, timeZone, dueAt: new Date(dueMs).toISOString() });
      if (field(body, 'request') !== undefined) {
        const checked = await checkRequest(item.kind, field(body, 'request'));
        const window = checked.group === null ? null : windowFromItem((await liveGroup(checked.group)).window);
        Object.assign(set, {
          request: checked.request,
          group: checked.group,
          groupName: checked.groupName,
          window: windowWords(window),
        });
      }
      // A new time is a new wait: whether it waits for the window is seen again when it is due.
      set.waiting = null;
      const changed = await change(item, set);
      if (changed === null) {
        throw conflict('schedule_changed', 'The scheduled start changed or began a moment ago. Look at it again.');
      }
      entry.detail.dueAt = changed.dueAt;
      noteDifferences(entry, item, changed);
      return { body: { schedule: scheduleFromItem(changed) } };
    },

    async cancel({ actor, params, entry }) {
      const id = requireScheduleId(params.id);
      entry.target = id;
      const item = await readItem(id);
      entry.detail.kind = item.kind;
      if (!isOpenSchedule(item)) throw scheduleOver(item);
      const at = new Date(now()).toISOString();
      const changed = await change(item, {
        status: 'cancelled',
        waiting: null,
        cancelledAt: at,
        cancelledBy: { sub: actor.sub, email: actor.email },
        updatedBy: { sub: actor.sub, email: actor.email },
      });
      if (changed === null) {
        throw conflict('schedule_changed', 'The scheduled start changed or began a moment ago. Look at it again.');
      }
      noteDifferences(entry, item, changed);
      return { body: { schedule: scheduleFromItem(changed) } };
    },
  };
}
