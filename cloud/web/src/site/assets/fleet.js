/**
 * The fleet (docs/fleet.md): board types, groups of boards, staged rollouts, "Update everything" and
 * rolling a group back, and how the fleet is doing. The script is fetched once the console is shown
 * (app.js), and until it is here the pages are as they were without it: every page that shows
 * something of the fleet asks for it through ctx.fleet, and gets nothing while it is missing.
 *
 * What it draws:
 *
 *  - the Fleet page (#/fleet): each board type with its newest release and how many boards run it,
 *    the groups, the staged rollouts, and "Update everything";
 *  - a staged rollout's page (#/rollouts/<id>): its canary, its stages (or waves), what was left out and why,
 *    its health gate, and why it stopped, with the board and the Memfault issue when the gate stopped it;
 *  - on the Overview, the fleet's health: versions by type, the last week's updates, and the boards
 *    that need looking at;
 *  - on the Devices page, each board's type and groups, "Bluetooth only" for a board without Wi-Fi
 *    with its version as a phone last saw it, and the groups;
 *  - on the Deployments page, the staged rollouts.
 *
 * Every change it makes is a request to the API, which decides: the dialogs show what the server
 * will do, and the server's answer is what counts.
 *
 * No dependencies beyond the console's own two modules.
 */

import {
  ApiError,
  BOARD_TYPES,
  boardName,
  boardOf,
  boardTypeLabel,
  deploymentHref,
  describeStatus,
  isRolloutId,
  isThing,
  isVersion,
  plural,
  rolloutHref,
  sentence,
  singleLine,
} from './core.js';
import {
  SPACER,
  badge,
  boardLabel,
  boardThing,
  button,
  card,
  choice,
  consequences,
  dialogButton,
  dialogFrame,
  empty,
  facts,
  failure,
  freshness,
  h,
  icon,
  loadProblem,
  mono,
  notice,
  pageHead,
  pending,
  segments,
  stats,
  when,
  who,
} from './views.js';

const FLEET_REFRESH_MS = 30_000;
const ROLLOUT_REFRESH_MS = 5_000;
const ROLLOUTS_ON_DEPLOYMENTS = 4;
const ATTENTION_SHOWN = 6;
const LEFT_OUT_REASONS = Object.freeze({
  bluetooth_only: 'Bluetooth only',
  other_type: 'Another type',
  other_layout: 'Another layout',
  current: 'Already current',
  newer: 'Runs newer firmware',
  older_refused: 'Would refuse it',
  busy: 'Busy with another update',
  offline: 'Offline over a day',
  never: 'Never reported',
  gone: 'No longer registered',
  unticked: 'Left out by hand',
  no_release: 'No release yet',
  no_older: 'No older release',
  // Roll back to last good (console 2.14.0).
  no_good: 'No known good version',
  good_revoked: 'Last good was revoked',
  no_rebuild: 'No rebuild of it yet',
  unreadable: 'History not readable',
});
const STAGES = Object.freeze({
  canary: { tone: 'live', icon: 'restart', label: 'Canary' },
  stages: { tone: 'live', icon: 'send', label: 'Stages under way' },
  waves: { tone: 'live', icon: 'send', label: 'Waves under way' },
  done: { tone: 'good', icon: 'check-circle', label: 'Done' },
  stopped: { tone: 'bad', icon: 'stop', label: 'Stopped' },
  cancelled: { tone: 'idle', icon: 'stop', label: 'Cancelled' },
});

let tools = null;

function resource() {
  return { value: null, error: null, loadedAt: 0, loading: false };
}

/** What app.js hands over: the state, the API, and its ways of loading, drawing and opening dialogs. */
export function connect(given) {
  tools = given;
  const { state } = given;
  state.fleet ??= resource();
  state.fleetHealth ??= resource();
  state.rollouts ??= resource();
  state.rolloutDetails ??= new Map();
}

// Reading what the API answers: only what is expected, of the kind expected.

const object = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
const array = (value) => (Array.isArray(value) ? value : []);
const words = (value, max = 500) => (typeof value === 'string' ? value.slice(0, max) : '');
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
const version = (value) => (isVersion(value) ? value : null);
const things = (value) => array(value).filter(isThing);
const type = (value) => (BOARD_TYPES.includes(value) ? value : 'nrf7002dk');
const layout = (value) => (Number.isInteger(value) && value >= 1 && value <= 9999 ? value : 1);
const iso = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null);

function readBoard(raw) {
  const item = object(raw);
  const seen = item.seen === null || item.seen === undefined ? null : object(item.seen);
  return {
    thing: item.thing,
    name: typeof item.name === 'string' ? item.name : null,
    type: type(item.type),
    typeFrom: words(item.typeFrom, 16),
    layout: layout(item.layout),
    layoutFrom: words(item.layoutFrom, 16),
    bluetoothOnly: item.bluetoothOnly === true,
    online: item.online === true,
    lastSeen: iso(item.lastSeen),
    version: version(item.version),
    versionFrom: words(item.versionFrom, 16) || null,
    seen:
      seen === null
        ? null
        : {
            version: version(seen.version),
            at: iso(seen.at),
            by: words(seen.by, 320),
            name: words(seen.name, 32) || null,
          },
    groups: array(item.groups).filter((id) => typeof id === 'string'),
  };
}

function readGroup(raw) {
  const item = object(raw);
  return {
    id: words(item.id, 16),
    name: words(item.name, 40),
    things: things(item.things),
    gone: count(item.gone),
    updatedAt: iso(item.updatedAt),
    updatedBy: object(item.updatedBy),
  };
}

function readLeftOut(raw) {
  return array(raw)
    .map(object)
    .filter((entry) => isThing(entry.thing))
    .map((entry) => ({ thing: entry.thing, reason: words(entry.reason, 32), text: words(entry.text, 300) }));
}

function readRollout(raw) {
  const item = object(raw);
  const canary = object(item.canary);
  const rest = object(item.rest);
  const stopped = item.stopped === null || item.stopped === undefined ? null : object(item.stopped);
  const issue = stopped && stopped.issue ? object(stopped.issue) : null;
  const gate = item.healthGate ? object(item.healthGate) : null;
  return {
    id: isRolloutId(item.id) ? item.id : '',
    version: version(item.version) ?? '',
    board: type(item.board),
    purpose: words(item.purpose, 32) || 'deploy',
    target: object(item.target),
    note: words(item.note, 200),
    createdAt: iso(item.createdAt),
    createdBy: object(item.createdBy),
    stage: Object.hasOwn(STAGES, item.stage) ? item.stage : 'stopped',
    things: things(item.things),
    leftOut: readLeftOut(item.leftOut),
    canary: {
      things: things(canary.things),
      job: words(canary.job, 64) || null,
      doneAt: iso(canary.doneAt),
      gatePassedAt: iso(canary.gatePassedAt),
    },
    stages: array(item.stages).map(readStage),
    current: Number.isInteger(item.current) ? item.current : -1,
    soakMinutes: count(item.soakMinutes),
    // The health gate (console 2.13.0): null, or { minutes }.
    healthGate:
      gate && Number.isInteger(gate.minutes) && gate.minutes >= 0 && gate.minutes <= 120
        ? { minutes: gate.minutes }
        : null,
    rest: {
      things: things(rest.things),
      leftOut: readLeftOut(rest.leftOut),
      job: words(rest.job, 64) || null,
      startedAt: iso(rest.startedAt),
    },
    wave: count(item.wave) || 1,
    abortPercent: count(item.abortPercent) || 20,
    plan: array(item.plan).filter((size) => Number.isInteger(size) && size > 0),
    stopped:
      stopped === null
        ? null
        : {
            code: words(stopped.code, 32),
            text: words(stopped.text, 400),
            at: iso(stopped.at),
            // What the health gate found: the board, and the Memfault issue or the reboot's reason.
            thing: isThing(stopped.thing) ? stopped.thing : null,
            issue:
              issue && Number.isInteger(issue.id) && issue.id >= 0
                ? { id: issue.id, title: words(issue.title, 200) }
                : null,
            reason: words(stopped.reason, 40) || null,
          },
    finishedAt: iso(item.finishedAt),
    canaryJob: item.canaryJob ? readJob(item.canaryJob) : null,
    wavesJob: item.wavesJob ? readJob(item.wavesJob) : null,
    waves: array(item.waves)
      .map(object)
      .map((wave) => ({ wave: count(wave.wave), at: iso(wave.at), things: things(wave.things) })),
    notOffered: things(item.notOffered),
  };
}

const STAGE_STATES = Object.freeze(['planned', 'next', 'running', 'done', 'skipped', 'stopped', 'never']);

/** One stage of a rollout: its boards, its deployment, where it stands and how far its boards are. */
function readStage(raw, index) {
  const item = object(raw);
  const counts = object(item.counts);
  return {
    n: index + 1,
    things: things(item.things),
    leftOut: readLeftOut(item.leftOut),
    job: words(item.job, 64) || null,
    startedAt: iso(item.startedAt),
    doneAt: iso(item.doneAt),
    gatePassedAt: iso(item.gatePassedAt),
    state: STAGE_STATES.includes(item.state) ? item.state : 'planned',
    counts: {
      done: count(counts.done),
      inProgress: count(counts.inProgress),
      failed: count(counts.failed),
      waiting: count(counts.waiting),
    },
    deployment: item.deployment ? readJob(item.deployment) : null,
  };
}

/** What the console suggests for a rollout (GET /api/rollouts/suggest). */
function readSuggestion(raw) {
  const item = object(raw);
  const reasons = object(item.reasons);
  const batch = item.batch ? object(item.batch) : null;
  const gate = object(item.healthGate);
  return {
    things: things(item.things),
    canary: things(item.canary),
    canarySize: Math.min(Math.max(count(item.canarySize), 1), 5),
    stageCount: count(item.stageCount),
    stages: array(item.stages)
      .map(object)
      .map((stage) => ({ size: count(stage.size), percent: count(stage.percent), offline: count(stage.offline) })),
    batch:
      batch && batch.unit === 'count'
        ? { unit: 'count', sizes: array(batch.sizes).filter((size) => Number.isInteger(size) && size > 0) }
        : null,
    soakMinutes: Math.min(count(item.soakMinutes), 60),
    healthGate: {
      on: gate.on !== false,
      minutes: Number.isInteger(gate.minutes) ? Math.min(Math.max(gate.minutes, 0), 120) : 10,
    },
    abortPercent: Math.min(Math.max(count(item.abortPercent), 1), 100) || 20,
    reasons: ['canary', 'stages', 'batch', 'soak', 'health', 'offline']
      .map((key) => words(reasons[key], 300))
      .filter((line) => line !== ''),
    warnings: array(item.warnings)
      .map((line) => words(line, 300))
      .filter((line) => line !== ''),
  };
}

function readJob(raw) {
  const item = object(raw);
  return {
    id: words(item.id, 64),
    status: words(item.status, 32),
    executions: array(item.executions)
      .map(object)
      .filter((execution) => isThing(execution.thing))
      .map((execution) => ({
        thing: execution.thing,
        status: words(execution.status, 32),
        reason: words(execution.reason, 32) || null,
      })),
  };
}

function readPlan(raw) {
  const plan = object(raw);
  return {
    group: plan.group ? readGroup(plan.group) : null,
    types: array(plan.types)
      .map(object)
      .map((entry) => ({
        type: type(entry.type),
        release: entry.release
          ? {
              version: version(object(entry.release).version),
              layout: layout(object(entry.release).layout),
              notes: words(object(entry.release).notes),
            }
          : null,
        from: version(entry.from),
        things: things(entry.things),
        leftOut: readLeftOut(entry.leftOut),
        canary: things(entry.canary),
      })),
  };
}

/** The plan of a roll back to last good (GET /api/fleet/last-good, /api/groups/{id}/last-good). */
function readLastGoodPlan(raw) {
  const plan = object(raw);
  const moves = (value) =>
    array(value)
      .map(object)
      .filter((entry) => isThing(entry.thing))
      .map((entry) => ({ thing: entry.thing, from: version(entry.from), to: version(entry.to) }));
  const leftOutWith = (value) => {
    const found = moves(value);
    return readLeftOut(value).map((entry, index) => ({
      ...entry,
      from: found[index]?.from ?? null,
      to: found[index]?.to ?? null,
    }));
  };
  const gate = plan.healthGate ? object(plan.healthGate) : null;
  return {
    scope: object(plan.scope),
    targets: array(plan.targets)
      .map(object)
      .filter((entry) => version(object(entry.release).version))
      .map((entry) => ({
        type: type(entry.type),
        release: {
          version: version(object(entry.release).version),
          layout: layout(object(entry.release).layout),
          notes: words(object(entry.release).notes),
          rebuildOf: words(object(entry.release).rebuildOf, 32) || null,
        },
        boards: moves(entry.boards),
        things: things(entry.things),
        leftOut: leftOutWith(entry.leftOut),
        canary: things(entry.canary),
      })),
    leftOut: leftOutWith(plan.leftOut),
    healthGate:
      gate && Number.isInteger(gate.minutes) && gate.minutes >= 0 ? { on: true, minutes: gate.minutes } : null,
  };
}

// Talking to the API: GET and POST under /api/fleet, /api/groups and /api/rollouts only (core.js).

const request = (method, path, body) => tools.api.fleetRequest(method, path, body);

const fleetApi = {
  async fleet() {
    const body = await request('GET', '/api/fleet');
    return {
      boards: array(body.boards)
        .filter((item) => isThing(item?.thing))
        .map(readBoard),
      groups: array(body.groups)
        .map(readGroup)
        .filter((group) => group.id !== ''),
      types: array(body.types)
        .map(object)
        .map((entry) => ({
          type: type(entry.type),
          boards: count(entry.boards),
          newest: version(entry.newest),
          previous: version(entry.previous),
          bluetoothOnly: entry.bluetoothOnly === true,
        })),
    };
  },
  async health() {
    const body = await request('GET', '/api/fleet/health');
    return {
      types: array(body.types)
        .map(object)
        .map((entry) => ({
          type: type(entry.type),
          boards: count(entry.boards),
          newest: version(entry.newest),
          onNewest: count(entry.onNewest),
          bluetoothOnly: entry.bluetoothOnly === true,
          unknown: count(entry.unknown),
          versions: array(entry.versions)
            .map(object)
            .filter((row) => isVersion(row.version))
            .map((row) => ({ version: row.version, count: count(row.count), newest: row.newest === true })),
        })),
      updates: {
        days: count(object(body.updates).days) || 7,
        succeeded: count(object(body.updates).succeeded),
        failed: count(object(body.updates).failed),
        rolledBack: count(object(body.updates).rolledBack),
      },
      attention: array(body.attention)
        .map(object)
        .filter((entry) => isThing(entry.thing))
        .map((entry) => ({
          thing: entry.thing,
          name: typeof entry.name === 'string' ? entry.name : null,
          type: type(entry.type),
          reasons: array(entry.reasons)
            .map(object)
            .map((reason) => ({ code: words(reason.code, 32), text: words(reason.text, 200) })),
        })),
    };
  },
  rollouts: async () =>
    array((await request('GET', '/api/rollouts')).rollouts)
      .map(readRollout)
      .filter((item) => item.id),
  rollout: async (id) => readRollout((await request('GET', `/api/rollouts/${id}`)).rollout),
  startRollout: async (body) => readRollout((await request('POST', '/api/rollouts', body)).rollout),
  suggest: async (release, group = null) =>
    readSuggestion(
      (
        await request(
          'GET',
          `/api/rollouts/suggest?release=${encodeURIComponent(release)}${group ? `&group=${encodeURIComponent(group)}` : ''}`
        )
      ).suggestion
    ),
  cancelRollout: async (id) => readRollout((await request('POST', `/api/rollouts/${id}/cancel`, {})).rollout),
  createGroup: async (body) => readGroup((await request('POST', '/api/groups', body)).group),
  updateGroup: async (id, body) => readGroup((await request('POST', `/api/groups/${id}`, body)).group),
  deleteGroup: async (id) => readGroup((await request('POST', `/api/groups/${id}/delete`, {})).group),
  everythingPlan: async () => readPlan((await request('GET', '/api/fleet/update-everything')).plan),
  startEverything: async (body) =>
    array((await request('POST', '/api/fleet/update-everything', body)).rollouts).map(readRollout),
  rollbackPlan: async (id) => readPlan((await request('GET', `/api/groups/${id}/rollback`)).plan),
  startRollback: async (id, body) =>
    array((await request('POST', `/api/groups/${id}/rollback`, body)).rollouts).map(readRollout),
  // Roll back to last good: a group's boards, or (no id) the fleet's.
  lastGoodPlan: async (id = null) =>
    readLastGoodPlan((await request('GET', id ? `/api/groups/${id}/last-good` : '/api/fleet/last-good')).plan),
  startLastGood: async (id, body) =>
    array((await request('POST', id ? `/api/groups/${id}/last-good` : '/api/fleet/last-good', body)).rollouts).map(
      readRollout
    ),
};

/** Each board's type, for the New deployment dialog: thing -> { type, bluetoothOnly }. */
export async function boardTypes() {
  const fleet = await fleetApi.fleet();
  Object.assign(tools.state.fleet, { value: fleet, error: null, loadedAt: tools.clock.now() });
  return new Map(
    fleet.boards.map((board) => [
      board.thing,
      { type: board.type, layout: board.layout, bluetoothOnly: board.bluetoothOnly },
    ])
  );
}

/** A staged rollout of boards named one by one, from the New deployment dialog. */
export async function startRollout({ version: release, things: boards, note, canary, abortPercent, ...plan }) {
  const body = { version: release, target: { kind: 'boards', things: boards }, canary, abortPercent };
  if (plan.stages !== undefined) Object.assign(body, stageBody({ unit: 'even', sizes: [], ...plan }));
  if (note) body.note = note;
  const rollout = await fleetApi.startRollout(body);
  tools.keep(tools.state.rolloutDetails, rollout.id, rollout);
  return rollout;
}

// Loading.

// Never twice at once: a read on its way brings what a second one would.
const due = (target, full, every) =>
  !target.loading && (full || target.loadedAt === 0 || tools.clock.now() - target.loadedAt >= every - 2000);

/** What a page of the console shows of the fleet, read when the page is. */
export async function refreshFor(view, full) {
  const { state, load } = tools;
  const jobs = [];
  if (
    ['overview', 'devices', 'device', 'firmware', 'deployments'].includes(view) &&
    due(state.fleet, full, FLEET_REFRESH_MS)
  ) {
    jobs.push(load(state.fleet, fleetApi.fleet));
  }
  if (view === 'overview' && due(state.fleetHealth, full, FLEET_REFRESH_MS))
    jobs.push(load(state.fleetHealth, fleetApi.health));
  if (view === 'deployments' && due(state.rollouts, full, FLEET_REFRESH_MS / 3))
    jobs.push(load(state.rollouts, fleetApi.rollouts));
  await Promise.all(jobs);
}

export async function refreshFleet(full) {
  const { state, load, api } = tools;
  await Promise.all([
    load(state.fleet, fleetApi.fleet),
    load(state.rollouts, fleetApi.rollouts),
    due(state.fleetHealth, full, FLEET_REFRESH_MS) ? load(state.fleetHealth, fleetApi.health) : null,
    due(state.firmware, full, FLEET_REFRESH_MS) ? load(state.firmware, api.firmware) : null,
    due(state.devices, full, FLEET_REFRESH_MS) ? load(state.devices, api.devices) : null,
  ]);
}

function detailOf(state) {
  let item = state.rolloutDetails.get(state.route.id);
  if (!item) {
    item = resource();
    state.rolloutDetails.set(state.route.id, item);
  }
  return item;
}

export async function refreshRollout(full) {
  const { state, load, api } = tools;
  const { id } = state.route;
  await Promise.all([
    load(detailOf(state), () => fleetApi.rollout(id)),
    full || state.devices.loadedAt === 0 ? load(state.devices, api.devices) : null,
  ]);
}

export const fleetResources = (state) => [state.fleet, state.rollouts];
export const fleetInterval = (state) =>
  (state.rollouts?.value ?? []).some(open) ? ROLLOUT_REFRESH_MS * 2 : FLEET_REFRESH_MS;
export const rolloutResources = (state) => [detailOf(state)];
export function rolloutInterval(state) {
  const rollout = state.rolloutDetails?.get(state.route.id)?.value;
  return rollout && open(rollout) ? ROLLOUT_REFRESH_MS : 0;
}
export function rolloutTitle(route, state) {
  const rollout = state.rolloutDetails?.get(route.id)?.value;
  return rollout?.version ? `Staged rollout of ${rollout.version}` : 'Staged rollout';
}

function open(rollout) {
  return rollout.stage === 'canary' || rollout.stage === 'stages' || rollout.stage === 'waves';
}

// Small pieces.

function typeChip(boardType, extra = '') {
  return h(
    'span',
    { class: `fleet-chip board-chip ${extra}`.trim(), key: `type-${boardType}` },
    boardTypeLabel(boardType)
  );
}

/** A board's type and flash layout, as one chip: "nRF7002 DK · layout 1". */
function boardChipOf(board) {
  return h(
    'span',
    { class: 'fleet-chip board-chip', key: 'type' },
    `${boardTypeLabel(board.type)} · layout ${board.layout}`
  );
}

function stageBadge(rollout) {
  const look = STAGES[rollout.stage];
  return badge(look.tone, look.icon, look.label);
}

function fleetOf(ctx) {
  return ctx.state.fleet?.value ?? null;
}

function boardFrom(ctx, thing) {
  const devices = ctx.state.devices?.value?.devices ?? [];
  const fleet = fleetOf(ctx)?.boards ?? [];
  return (
    devices.find((device) => device.thing === thing) ??
    fleet.find((board) => board.thing === thing) ??
    boardOf(thing, [])
  );
}

function boardChip(ctx, thing) {
  return h('span', { class: 'fleet-chip', key: thing }, boardLabel(boardFrom(ctx, thing)));
}

function targetWords(rollout, ctx) {
  const target = rollout.target ?? {};
  if (rollout.purpose === 'update_everything') return `Update everything: every ${boardTypeLabel(rollout.board)}`;
  if (rollout.purpose === 'rollback') return `Roll back of the group ${target.groupName ?? ''}`.trim();
  if (rollout.purpose === 'last_good') {
    return target.kind === 'group'
      ? `Roll back to last good: the group ${target.groupName ?? target.group ?? ''}`.trim()
      : `Roll back to last good: every ${boardTypeLabel(target.type ?? rollout.board)}`;
  }
  if (target.kind === 'group') return `The group ${target.groupName ?? target.group ?? ''}`.trim();
  if (target.kind === 'type') return `Every ${boardTypeLabel(target.type ?? rollout.board)}`;
  if (target.kind === 'fleet') return 'The whole fleet';
  return plural(rollout.things.length, 'board named', 'boards named');
}

function leftOutList(entries, ctx) {
  if (entries.length === 0) return null;
  return h(
    'ul',
    { class: 'left-out' },
    entries.map((entry) =>
      h(
        'li',
        { key: `${entry.thing}-${entry.reason}` },
        boardLabel(boardFrom(ctx, entry.thing)),
        h('span', { class: 'tag' }, LEFT_OUT_REASONS[entry.reason] ?? entry.reason),
        h('span', { class: 'quiet' }, entry.text)
      )
    )
  );
}

// On the Devices page: a board's type and groups, and for a board without Wi-Fi what a phone saw.

export function boardTags(device, ctx) {
  const fleet = fleetOf(ctx);
  const board = fleet?.boards.find((item) => item.thing === device.thing);
  if (!board) return null;
  const groups = fleet.groups.filter((group) => board.groups.includes(group.id));
  return h(
    'p',
    { class: 'fleet-chips', 'aria-label': 'Type, layout and groups' },
    boardChipOf(board),
    groups.map((group) =>
      h('span', { class: 'fleet-chip group-chip', key: group.id }, icon('list', 'is-small'), group.name)
    )
  );
}

/** A board's type and the names of its groups, for the Devices page's search (docs/search-filters.md). */
export function groupsOf(device, ctx) {
  const fleet = fleetOf(ctx);
  const board = fleet?.boards.find((item) => item.thing === device.thing);
  if (!board) return [];
  const names = fleet.groups.filter((group) => board.groups.includes(group.id)).map((group) => group.name);
  return [board.type, ...names].filter((name) => typeof name === 'string');
}

export function bluetoothOnly(device, ctx) {
  const board = fleetOf(ctx)?.boards.find((item) => item.thing === device.thing);
  if (!board?.bluetoothOnly) return null;
  const seen = board.seen;
  return {
    badge: badge('idle', 'chip', 'Bluetooth only', 'No Wi-Fi: it updates over Bluetooth from a phone, or over USB'),
    line: seen?.version
      ? [
          'Runs ',
          mono(seen.version),
          ' as a phone saw it ',
          when(seen.at, ctx.state.now),
          seen.by ? [' (', seen.by, ')'] : null,
        ]
      : 'No phone has seen it yet. It shows its version here once the phone app connects to it.',
  };
}

// On a board's page: what it is, how its flash is laid out, and the newest release it can take.

const FROM_WORDS = Object.freeze({
  board: 'as it says itself',
  thing: 'as its thing says',
  default: 'neither it nor its thing says',
});

export function compatibilityCard(device, ctx) {
  const board = fleetOf(ctx)?.boards.find((item) => item.thing === device.thing);
  if (!board) return null;
  const releases = (ctx.state.firmware?.value?.releases ?? []).filter(
    (release) =>
      release.status === 'active' &&
      (release.board ?? 'nrf7002dk') === board.type &&
      (release.layout ?? 1) === board.layout
  );
  const newest = releases[0] ?? null;
  return card(
    { key: 'compatibility', title: 'Compatibility' },
    facts([
      ['Board type', boardTypeLabel(board.type), h('span', { class: 'fact-note' }, FROM_WORDS[board.typeFrom] ?? '')],
      ['Flash layout', String(board.layout), h('span', { class: 'fact-note' }, FROM_WORDS[board.layoutFrom] ?? '')],
      [
        'Takes',
        newest ? [mono(newest.version), ' is the newest release built for it'] : 'No release is built for it yet',
        board.bluetoothOnly
          ? h('span', { class: 'fact-note' }, 'Over Bluetooth from the phone app: it has no Wi-Fi')
          : null,
      ],
    ]),
    h(
      'p',
      { class: 'card-note' },
      'A release goes only to boards of its type and its flash layout; the board checks it again before it installs.'
    )
  );
}

// On the Overview: how the fleet is doing.

export function healthCard(ctx) {
  const health = ctx.state.fleetHealth?.value;
  if (!health) return null;
  const types = health.types.filter((entry) => entry.boards > 0);
  const attention = health.attention.slice(0, ATTENTION_SHOWN);
  const { updates } = health;
  return h(
    'section',
    { class: 'card health', key: 'health', 'aria-label': 'Fleet health' },
    h(
      'div',
      { class: 'health-part health-versions' },
      h('h2', { class: 'eyebrow' }, 'Versions by board type'),
      types.length === 0
        ? h('p', { class: 'quiet' }, 'No boards yet.')
        : types.map((entry) =>
            h(
              'div',
              { class: 'health-type', key: entry.type },
              h(
                'p',
                { class: 'health-type-head' },
                typeChip(entry.type),
                entry.bluetoothOnly ? h('span', { class: 'quiet' }, ' Bluetooth only') : null,
                h(
                  'span',
                  { class: 'health-share' },
                  entry.newest
                    ? [String(entry.onNewest), ' of ', plural(entry.boards, 'board'), ' on ', mono(entry.newest)]
                    : 'No release yet'
                )
              ),
              segments(
                [
                  ...entry.versions.map((row) => ({
                    key: row.version,
                    amount: row.count,
                    tone: row.newest ? 'good' : 'idle',
                    name: row.version,
                  })),
                  ...(entry.unknown > 0
                    ? [{ key: 'unknown', amount: entry.unknown, tone: 'wait', name: 'version not known' }]
                    : []),
                ],
                `${entry.onNewest} of ${entry.boards} on the newest release`,
                { thin: true }
              ),
              h(
                'p',
                { class: 'health-versions-list dotted' },
                entry.versions.map((row) => h('span', { key: row.version }, mono(row.version), ` × ${row.count}`)),
                entry.unknown > 0 ? h('span', { key: 'unknown' }, `${entry.unknown} not known`) : null
              )
            )
          )
    ),
    h(
      'div',
      { class: 'health-part' },
      h('h2', { class: 'eyebrow' }, `Updates, last ${updates.days} days`),
      stats([
        ['Succeeded', updates.succeeded],
        ['Failed', updates.failed],
        ['Rolled back', updates.rolledBack],
      ])
    ),
    h(
      'div',
      { class: 'health-part' },
      h('h2', { class: 'eyebrow' }, 'Needs attention'),
      attention.length === 0
        ? h('p', { class: 'health-fine' }, icon('check-circle', 'is-small'), 'Nothing needs looking at.')
        : h(
            'ul',
            { class: 'attention' },
            attention.map((entry) =>
              h(
                'li',
                { key: entry.thing },
                boardLabel(boardFrom(ctx, entry.thing)),
                h('span', { class: 'attention-why' }, entry.reasons.map((reason) => reason.text).join(' · '))
              )
            )
          ),
      health.attention.length > ATTENTION_SHOWN
        ? h('p', { class: 'quiet' }, `And ${health.attention.length - ATTENTION_SHOWN} more.`)
        : null
    )
  );
}

// The groups.

function groupRow(group, ctx, fleet) {
  const { canWrite } = ctx.state.me;
  const types = new Set(
    group.things.map((thing) => fleet.boards.find((board) => board.thing === thing)?.type).filter(Boolean)
  );
  const older = [...types].some((boardType) => fleet.types.find((entry) => entry.type === boardType)?.previous);
  return h(
    'li',
    { key: group.id, class: 'row group-row' },
    h(
      'div',
      { class: 'group-main' },
      h(
        'p',
        { class: 'group-name' },
        icon('list', 'is-small'),
        h('strong', null, group.name),
        h('span', { class: 'quiet' }, ` · ${plural(group.things.length, 'board')}`),
        group.gone > 0 ? h('span', { class: 'tag' }, `${group.gone} no longer registered`) : null
      ),
      h(
        'p',
        { class: 'fleet-chips' },
        group.things.length === 0
          ? h('span', { class: 'quiet' }, 'No boards in it yet.')
          : group.things.map((thing) => boardChip(ctx, thing))
      )
    ),
    canWrite
      ? h(
          'div',
          { class: 'group-actions' },
          group.things.length > 0 ? button('is-small', () => openGroupRollout(group), icon('send'), 'Roll out') : null,
          // Only where there is an older active release of a type in the group to go back to.
          older ? button('is-small is-quiet', () => openPlan({ group }), icon('undo'), 'Roll back') : null,
          group.things.length > 0
            ? button('is-small is-quiet', () => openLastGood({ group }), icon('undo'), 'Roll back to last good')
            : null,
          h(
            'button',
            {
              type: 'button',
              class: 'btn is-small is-quiet',
              'aria-label': `Edit ${group.name}`,
              onClick: () => openGroup(group),
            },
            'Edit'
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn is-small is-danger-quiet',
              'aria-label': `Delete ${group.name}`,
              onClick: () => openDeleteGroup(group),
            },
            'Delete'
          )
        )
      : null
  );
}

export function groupsCard(ctx) {
  const fleet = fleetOf(ctx);
  if (!fleet) return null;
  const { canWrite } = ctx.state.me;
  const byType = BOARD_TYPES.map((boardType) => ({
    boardType,
    boards: fleet.boards.filter((board) => board.type === boardType),
  })).filter((entry) => entry.boards.length > 0);
  return card(
    { key: 'groups', title: 'Groups', className: 'is-flush groups-card' },
    h(
      'div',
      { class: 'card-toolbar' },
      h(
        'p',
        { class: 'card-lede' },
        'Every board is in the group of its type. A release manager makes the others; a board can be in several.'
      ),
      canWrite ? button('is-small', () => openGroup(null), icon('plus'), 'New group') : null
    ),
    h(
      'ul',
      { class: 'rows' },
      byType.map((entry) =>
        h(
          'li',
          { key: entry.boardType, class: 'row group-row is-type' },
          h(
            'div',
            { class: 'group-main' },
            h(
              'p',
              { class: 'group-name' },
              typeChip(entry.boardType),
              h('span', { class: 'quiet' }, ` · ${plural(entry.boards.length, 'board')}`),
              fleet.types.find((item) => item.type === entry.boardType)?.bluetoothOnly
                ? h('span', { class: 'quiet' }, ' · Bluetooth only')
                : null
            ),
            h(
              'p',
              { class: 'fleet-chips' },
              entry.boards.map((board) => boardChip(ctx, board.thing))
            )
          )
        )
      ),
      fleet.groups.map((group) => groupRow(group, ctx, fleet)),
      fleet.groups.length === 0
        ? h('li', { key: 'none', class: 'row group-row' }, h('p', { class: 'quiet' }, 'No groups of your own yet.'))
        : null
    )
  );
}

// Staged rollouts, as a list.

function rolloutRow(rollout, ctx) {
  return h(
    'li',
    { key: rollout.id, class: 'row rollout-row' },
    h(
      'div',
      { class: 'rollout-main' },
      h(
        'p',
        { class: 'rollout-title' },
        h('a', { href: rolloutHref(rollout.id), class: 'mono rollout-version' }, rollout.version),
        typeChip(rollout.board),
        stageBadge(rollout)
      ),
      h(
        'p',
        { class: 'row-note dotted' },
        h('span', null, targetWords(rollout, ctx)),
        h('span', null, plural(rollout.things.length, 'board')),
        h('span', null, 'Started ', when(rollout.createdAt, ctx.state.now), ' by ', who(rollout.createdBy)),
        rollout.stopped && rollout.stage === 'stopped'
          ? h('span', { class: 'is-bad-text' }, rollout.stopped.text)
          : null
      )
    ),
    icon('arrow-right', 'is-small')
  );
}

export function rolloutsPanel(ctx) {
  const rollouts = ctx.state.rollouts?.value;
  if (!rollouts || rollouts.length === 0) return null;
  return card(
    {
      key: 'rollouts',
      title: 'Staged rollouts',
      more: { href: '#/fleet', label: 'All on the Fleet page' },
      className: 'is-flush rollouts-card',
    },
    h(
      'ul',
      { class: 'rows' },
      rollouts.slice(0, ROLLOUTS_ON_DEPLOYMENTS).map((rollout) => rolloutRow(rollout, ctx))
    )
  );
}

// The Fleet page.

function typesCard(ctx, fleet) {
  const health = ctx.state.fleetHealth?.value;
  return h(
    'section',
    { class: 'panel on-ink fleet-types', key: 'types', 'aria-label': 'Board types' },
    fleet.types.map((entry) => {
      const onNewest = health?.types.find((item) => item.type === entry.type)?.onNewest ?? null;
      return h(
        'div',
        { class: 'fleet-type', key: entry.type },
        h('h2', { class: 'eyebrow' }, boardTypeLabel(entry.type)),
        h(
          'p',
          { class: 'fleet-type-count' },
          String(entry.boards),
          h('span', null, entry.boards === 1 ? ' board' : ' boards')
        ),
        h(
          'p',
          { class: 'fleet-type-note' },
          entry.bluetoothOnly ? 'Bluetooth only: updated from a phone' : 'Wi-Fi: updated over the air'
        ),
        h(
          'p',
          { class: 'fleet-type-note' },
          entry.newest
            ? ['Newest ', mono(entry.newest), onNewest === null || entry.bluetoothOnly ? null : ` · ${onNewest} on it`]
            : 'No release for it yet'
        )
      );
    })
  );
}

export function fleetView(ctx) {
  const { state } = ctx;
  const fleet = fleetOf(ctx);
  const { canWrite } = state.me;
  let body;
  if (!fleet) {
    body = pending(state.fleet, 'the fleet');
  } else if (fleet.boards.length === 0) {
    body = card(
      { key: 'none' },
      empty({ iconName: 'chip', title: 'No boards yet.', text: 'Register a board with tools/provision_device.py.' })
    );
  } else {
    const rollouts = state.rollouts.value ?? [];
    body = [
      typesCard(ctx, fleet),
      groupsCard(ctx),
      card(
        { key: 'rollouts', title: 'Staged rollouts', className: 'is-flush' },
        rollouts.length === 0
          ? h(
              'p',
              { class: 'card-lede' },
              'A deployment to more than one board, a group or a type starts here: a canary first, then stages.'
            )
          : h(
              'ul',
              { class: 'rows' },
              rollouts.map((rollout) => rolloutRow(rollout, ctx))
            )
      ),
    ];
  }
  return h(
    'div',
    { class: 'page' },
    pageHead({
      title: 'Fleet',
      lede: 'Board types, groups of boards, and releases to many boards at once: a canary first, then stages once it has confirmed.',
      tools: [
        freshness(state.fleet, ctx),
        canWrite && fleet ? button('', () => openLastGood({}), icon('undo'), 'Roll back to last good') : null,
        canWrite && fleet ? button('is-primary', () => openPlan({}), icon('send'), 'Update everything') : null,
      ],
    }),
    loadProblem(state.fleet, 'the fleet', ctx),
    loadProblem(state.rollouts, 'the staged rollouts', ctx),
    body
  );
}

// A staged rollout's page.

function executionBadge(execution) {
  if (!execution) return badge('wait', 'clock', 'Not offered yet');
  const look = describeStatus(execution.status);
  return badge(look.tone, look.icon, execution.reason ? `${look.label} (${execution.reason})` : look.label);
}

function boardStatusList(ctx, thingsShown, job) {
  return h(
    'ul',
    { class: 'stage-boards' },
    thingsShown.map((thing) =>
      h(
        'li',
        { key: thing },
        boardLabel(boardFrom(ctx, thing)),
        boardThing(boardFrom(ctx, thing)),
        executionBadge(job?.executions.find((execution) => execution.thing === thing))
      )
    )
  );
}

function stageSteps(rollout) {
  const staged = rollout.stages.length > 0;
  const ended = rollout.stage === 'stopped' || rollout.stage === 'cancelled';
  const labels = [
    'Canary',
    ...(staged ? rollout.stages.map((stage) => `Stage ${stage.n}`) : ['Waves']),
    ended ? STAGES[rollout.stage].label : 'Done',
  ];
  const last = labels.length - 1;
  const over = (stage) => stage.state === 'done' || stage.state === 'skipped';
  let reached;
  if (rollout.stage === 'canary') reached = 0;
  else if (rollout.stage === 'done') reached = last;
  else if (!staged) reached = rollout.stage === 'waves' || rollout.rest.job ? 1 : 0;
  else if (rollout.stage === 'stages') reached = 1 + rollout.stages.filter(over).length;
  else {
    const started = rollout.stages.filter((stage) => stage.startedAt || over(stage)).length;
    reached = started > 0 ? started : rollout.canary.doneAt ? 1 : 0;
  }
  return h(
    'ol',
    { class: 'wizard-steps rollout-steps', key: 'steps' },
    labels.map((label, index) =>
      h(
        'li',
        {
          key: label,
          class:
            index < reached || (index === last && rollout.stage === 'done')
              ? 'is-done'
              : index === reached && !ended
                ? 'is-current'
                : ended && index === last
                  ? 'is-stopped'
                  : null,
        },
        h(
          'span',
          { class: 'wizard-number' },
          index < reached || (index === last && rollout.stage === 'done') ? icon('check') : String(index + 1)
        ),
        label
      )
    )
  );
}

const STAGE_LOOK = Object.freeze({
  planned: { tone: 'wait', icon: 'clock', label: 'Planned' },
  next: { tone: 'wait', icon: 'clock', label: 'Next' },
  running: { tone: 'live', icon: 'send', label: 'In progress' },
  done: { tone: 'good', icon: 'check-circle', label: 'Done' },
  skipped: { tone: 'idle', icon: 'check', label: 'Nothing left to update' },
  stopped: { tone: 'bad', icon: 'stop', label: 'Stopped' },
  never: { tone: 'idle', icon: 'stop', label: 'Never started' },
});

/** When a stage started and ended, or when it is due. */
function stageTiming(rollout, stage, index, now) {
  if (stage.startedAt && stage.doneAt) {
    return ['Started ', when(stage.startedAt, now), ', ended ', when(stage.doneAt, now)];
  }
  if (stage.startedAt) return ['Started ', when(stage.startedAt, now)];
  if (stage.doneAt) return ['Ended ', when(stage.doneAt, now)];
  if (stage.state !== 'next' && stage.state !== 'planned') return null;
  const before = index === 0 ? rollout.canary.doneAt : rollout.stages[index - 1]?.doneAt;
  const after = index === 0 ? 'the canary has confirmed' : `stage ${index} has ended`;
  if (!before)
    return `Starts once ${after}${rollout.soakMinutes > 0 ? `, and ${plural(rollout.soakMinutes, 'minute')} after` : ''}.`;
  const due = Date.parse(before) + rollout.soakMinutes * 60_000;
  return due > now ? `Starts in ${plural(Math.ceil((due - now) / 60_000), 'minute')}.` : 'Starts within a minute.';
}

/** Each stage of a rollout: its boards, how far they are, and when it ran. */
function stageCards(rollout, ctx) {
  const { now } = ctx.state;
  return rollout.stages.map((stage, index) => {
    const look = STAGE_LOOK[stage.state];
    const { done, inProgress, failed, waiting } = stage.counts;
    const timing = stageTiming(rollout, stage, index, now);
    return card(
      {
        key: `stage-${stage.n}`,
        title: `Stage ${stage.n}: ${plural(stage.things.length, 'board')}`,
        more: stage.job ? { href: deploymentHref(stage.job), label: 'Its deployment' } : null,
        className: 'rollout-stage',
      },
      h(
        'p',
        { class: 'card-lede stage-head' },
        badge(look.tone, look.icon, look.label),
        ' ',
        stage.job
          ? h(
              'span',
              { class: 'stage-counts' },
              `${done} done · ${inProgress} in progress · ${failed} failed · ${waiting} waiting`
            )
          : null
      ),
      timing ? h('p', { class: 'quiet stage-timing' }, timing) : null,
      stage.things.length > 0 ? boardStatusList(ctx, stage.things, stage.deployment) : null
    );
  });
}

export function rolloutView(ctx) {
  const { state } = ctx;
  const target = state.rolloutDetails?.get(state.route.id) ?? resource();
  const rollout = target.value;
  if (!rollout) {
    return h(
      'div',
      { class: 'page' },
      pageHead({ title: 'Staged rollout', back: { href: '#/fleet', label: 'Fleet' } }),
      loadProblem(target, 'the rollout', ctx),
      pending(target, 'the rollout')
    );
  }
  const canCancel = state.me.canWrite && open(rollout);
  const waveWords =
    `AWS IoT offers it to ${plural(rollout.wave, 'board')} a minute to start with, and twice as many each time as ` +
    `many more have confirmed. It stops by itself once ${rollout.abortPercent}% of the boards that finished have failed, ` +
    'and what has not started then never does.';
  const staged = rollout.stages.length > 0;
  const stageLede =
    `${plural(rollout.stages.length, 'stage')} after the canary. Each goes to all its boards at once, and the next ` +
    `starts only once it has ended with fewer than ${rollout.abortPercent}% of its finished boards failed` +
    `${rollout.soakMinutes > 0 ? `, and ${plural(rollout.soakMinutes, 'minute')} after` : ''}. ` +
    `A stage stops by itself once ${rollout.abortPercent}% have failed, and what has not started then never does.` +
    (rollout.healthGate
      ? ` Health gate: after the canary and each stage, the next waits ${plural(rollout.healthGate.minutes, 'minute')} ` +
        'and starts only if Memfault shows no new issue and no unexpected reboot on the release.'
      : ' No health gate.');
  const leftOut = [...rollout.leftOut, ...rollout.rest.leftOut, ...rollout.stages.flatMap((stage) => stage.leftOut)];
  return h(
    'div',
    { class: 'page' },
    pageHead({
      eyebrow: 'Staged rollout of',
      title: mono(rollout.version),
      back: { href: '#/fleet', label: 'Fleet' },
      lede: [
        targetWords(rollout, ctx),
        ' · ',
        boardTypeLabel(rollout.board),
        rollout.note ? [' · ', rollout.note] : null,
      ],
      meta: [
        h('span', { key: 'by' }, 'Started ', when(rollout.createdAt, state.now), ' by ', who(rollout.createdBy)),
        stageBadge(rollout),
      ],
      tools: [
        freshness(target, ctx),
        canCancel ? button('is-danger-quiet', () => openCancelRollout(rollout), icon('stop'), 'Cancel rollout') : null,
      ],
    }),
    loadProblem(target, 'the rollout', ctx),
    stageSteps(rollout),
    rollout.stopped && rollout.stage !== 'done'
      ? notice(rollout.stage === 'stopped' ? 'bad' : 'warn', 'stop', [
          h('strong', null, `${STAGES[rollout.stage].label}. `),
          sentence(rollout.stopped.text),
          ' ',
          when(rollout.stopped.at, state.now),
          stopFacts(rollout.stopped, ctx),
        ])
      : null,
    card(
      {
        key: 'canary',
        title: rollout.canary.things.length === 1 ? 'The canary' : `The canary: ${rollout.canary.things.length} boards`,
        more: rollout.canary.job ? { href: deploymentHref(rollout.canary.job), label: 'Its deployment' } : null,
      },
      h(
        'p',
        { class: 'card-lede' },
        `The first to get it. ${staged ? 'The first stage starts' : 'The waves start'} only once every one of them has installed it, ` +
          'restarted, reached AWS IoT and confirmed it; the console looks every minute.'
      ),
      boardStatusList(ctx, rollout.canary.things, rollout.canaryJob)
    ),
    staged ? h('p', { class: 'card-lede rollout-stages-lede', key: 'stages-lede' }, stageLede) : null,
    staged ? stageCards(rollout, ctx) : null,
    staged
      ? null
      : card(
          {
            key: 'waves',
            title: `The waves: ${plural(rollout.things.length - rollout.canary.things.length, 'board')}`,
            more: rollout.rest.job ? { href: deploymentHref(rollout.rest.job), label: 'Their deployment' } : null,
          },
          h('p', { class: 'card-lede' }, waveWords),
          rollout.rest.job === null
            ? h(
                'p',
                { class: 'quiet' },
                rollout.stage === 'canary'
                  ? [
                      'Waiting for the canary. Planned: ',
                      rollout.plan.length > 0 ? rollout.plan.join(', then ') : 'none',
                      ' boards.',
                    ]
                  : 'No wave was started.'
              )
            : [
                rollout.waves.map((wave) =>
                  h(
                    'div',
                    { class: 'wave', key: String(wave.wave) },
                    h(
                      'p',
                      { class: 'wave-head' },
                      h('strong', null, `Wave ${wave.wave}`),
                      ' ',
                      when(wave.at, state.now)
                    ),
                    boardStatusList(ctx, wave.things, rollout.wavesJob)
                  )
                ),
                rollout.notOffered.length > 0
                  ? h(
                      'div',
                      { class: 'wave', key: 'later' },
                      h(
                        'p',
                        { class: 'wave-head' },
                        h('strong', null, rollout.stage === 'waves' ? 'Still to come' : 'Never offered')
                      ),
                      boardStatusList(ctx, rollout.notOffered, null)
                    )
                  : null,
              ]
        ),
    leftOut.length > 0
      ? card(
          { key: 'left', title: `Left out: ${plural(leftOut.length, 'board')}` },
          h(
            'p',
            { class: 'card-lede' },
            'A rollout only takes boards of the release’s type that can take a job and do not run it already.'
          ),
          leftOutList(leftOut, ctx)
        )
      : null
  );
}

/** What the health gate found, under its stop: the board, and the issue on the Memfault page. */
function stopFacts(stopped, ctx) {
  if (!stopped.thing && !stopped.issue) return null;
  return h(
    'span',
    { class: 'stop-facts', key: 'facts' },
    stopped.thing ? [' Board: ', boardChip(ctx, stopped.thing), '.'] : null,
    stopped.issue
      ? [
          ' Issue: ',
          h('a', { href: `#/memfault/${stopped.issue.id}` }, `#${stopped.issue.id} ${stopped.issue.title}`),
          '.',
        ]
      : null,
    stopped.reason && !stopped.issue ? [` Reason: ${stopped.reason}.`] : null
  );
}

// Dialogs.

function after(error) {
  // What the dialog showed is out of date: read the fleet again.
  if (error?.status === 409) tools.refresh();
}

function openCancelRollout(rollout) {
  if (tools.dialogs.isOpen()) return;
  let self = null;
  const model = { sending: false, error: null };
  const submit = () =>
    tools.dialogs.submit(self, model, async () => {
      const changed = await fleetApi.cancelRollout(rollout.id);
      tools.keep(tools.state.rolloutDetails, rollout.id, changed);
      self.close(true);
      tools.notify(`The staged rollout of ${rollout.version} is cancelled.`);
      tools.draw();
    });
  self = tools.dialogs.open(() =>
    dialogFrame({
      title: ['Cancel the rollout of ', mono(rollout.version)],
      busy: model.sending,
      onClose: () => self.close(),
      onSubmit: submit,
      body: consequences([
        'What has not started is not offered any more: no stage starts after this.',
        'A board that has started finishes what it is doing; its deployment’s page can stop it with force.',
      ]),
      error: model.error ? failure('The rollout was not cancelled.', model.error, null, tools.dialogs.signIn) : null,
      foot: [
        dialogButton({ key: 'keep', disabled: model.sending, onClick: () => self.close() }, 'Keep it going'),
        SPACER(),
        dialogButton(
          { key: 'go', className: 'is-danger', submit: true, sending: model.sending },
          icon('stop'),
          'Cancel rollout'
        ),
      ],
    })
  );
}

function openGroup(group) {
  if (tools.dialogs.isOpen()) return;
  const fleet = tools.state.fleet.value;
  if (!fleet) return;
  let self = null;
  const model = { name: group?.name ?? '', things: new Set(group?.things ?? []), sending: false, error: null };
  const redraw = () => self.redraw();
  const submit = () =>
    tools.dialogs.submit(self, model, async () => {
      const body = { name: singleLine(model.name), things: [...model.things].sort() };
      let saved;
      try {
        saved = group ? await fleetApi.updateGroup(group.id, body) : await fleetApi.createGroup(body);
      } catch (error) {
        after(error);
        throw error;
      }
      self.close(true);
      tools.notify(group ? `The group ${saved.name} is saved.` : `The group ${saved.name} is made.`);
      tools.refresh();
    });
  self = tools.dialogs.open(() =>
    dialogFrame({
      title: group ? ['Edit ', group.name] : 'New group',
      busy: model.sending,
      onClose: () => self.close(),
      onSubmit: singleLine(model.name) ? submit : null,
      body: [
        h(
          'label',
          { class: 'field', key: 'name' },
          h('span', { class: 'field-label' }, 'Name'),
          h('input', {
            class: 'input',
            type: 'text',
            maxlength: '40',
            value: model.name,
            autofocus: true,
            onInput: (event) => {
              model.name = event.target.value;
              redraw();
            },
          })
        ),
        h(
          'fieldset',
          { class: 'choices', key: 'boards' },
          h('legend', null, 'Which boards are in it?'),
          fleet.boards.map((board) =>
            choice(
              {
                key: board.thing,
                type: 'checkbox',
                checked: model.things.has(board.thing),
                onChange: () => {
                  if (model.things.has(board.thing)) model.things.delete(board.thing);
                  else model.things.add(board.thing);
                  redraw();
                },
              },
              [mono(boardName(board)), boardThing(board)],
              h('span', { class: 'choice-note' }, typeChip(board.type), board.bluetoothOnly ? ' Bluetooth only' : null)
            )
          )
        ),
      ],
      error: model.error ? failure('The group was not saved.', model.error, null, tools.dialogs.signIn) : null,
      foot: [
        dialogButton({ key: 'cancel', disabled: model.sending, onClick: () => self.close() }, 'Cancel'),
        SPACER(),
        dialogButton(
          {
            key: 'save',
            className: 'is-primary',
            submit: true,
            disabled: !singleLine(model.name),
            sending: model.sending,
          },
          icon('check'),
          group ? 'Save group' : 'Make group'
        ),
      ],
    })
  );
}

function openDeleteGroup(group) {
  if (tools.dialogs.isOpen()) return;
  let self = null;
  const model = { sending: false, error: null };
  const submit = () =>
    tools.dialogs.submit(self, model, async () => {
      await fleetApi.deleteGroup(group.id);
      self.close(true);
      tools.notify(`The group ${group.name} is deleted.`);
      tools.refresh();
    });
  self = tools.dialogs.open(() =>
    dialogFrame({
      title: ['Delete ', group.name],
      busy: model.sending,
      onClose: () => self.close(),
      onSubmit: submit,
      body: consequences([
        `Its ${plural(group.things.length, 'board stays', 'boards stay')} as ${group.things.length === 1 ? 'it is' : 'they are'}: only the name goes.`,
        'A staged rollout that was started for it goes on.',
      ]),
      error: model.error ? failure('The group was not deleted.', model.error, null, tools.dialogs.signIn) : null,
      foot: [
        dialogButton({ key: 'keep', disabled: model.sending, onClick: () => self.close() }, 'Keep it'),
        SPACER(),
        dialogButton({ key: 'go', className: 'is-danger', submit: true, sending: model.sending }, 'Delete group'),
      ],
    })
  );
}

// The choices of a rollout: the canary, the stages after it, their batch sizes, the soak time
// between them and the failure limit. The server checks them all again (lib/stages.mjs).

const MAX_STAGES = 10;
const MAX_SOAK = 60;
const MAX_GATE = 120;
const DEFAULT_GATE = 10;
const MIN_USEFUL_STAGE = 2;
const BATCH_UNITS = Object.freeze([
  { unit: 'even', label: 'Split evenly' },
  { unit: 'percent', label: 'Percent of the boards' },
  { unit: 'count', label: 'Number of boards' },
]);

/** The stage choices a dialog starts from, before a suggestion or a person changes them. */
function stageModel() {
  return {
    stages: 1,
    unit: 'even',
    sizes: [],
    soakMinutes: 0,
    healthGate: true,
    gateMinutes: DEFAULT_GATE,
    suggestion: null,
    suggesting: false,
  };
}

/**
 * The body fields of the stage choices: { stages, soakMinutes, batch?, healthGate? }. The health gate
 * is sent when the model has the choice (every dialog of this console has it, on by default).
 */
export function stageBody(model) {
  const body = { stages: model.stages, soakMinutes: model.soakMinutes };
  if (typeof model.healthGate === 'boolean') {
    body.healthGate = { on: model.healthGate, minutes: model.gateMinutes ?? DEFAULT_GATE };
  }
  if (model.stages > 1 && model.unit !== 'even') {
    const sizes = Array.from({ length: model.stages - 1 }, (_, index) => model.sizes[index] ?? model.sizes.at(-1) ?? 1);
    body.batch = { unit: model.unit, sizes };
  }
  return body;
}

/**
 * The boards each stage would take of `rest` boards after the canary, as the server splits them
 * (lib/stages.mjs stageSizes): what the dialog shows before anything is started.
 */
export function plannedSizes(rest, model) {
  if (!Number.isInteger(rest) || rest <= 0) return [];
  const { stages, batch } = { batch: null, ...stageBody(model) };
  const sizes = [];
  if (batch === null) {
    const parts = Math.min(stages, rest);
    const base = Math.floor(rest / parts);
    const extra = rest % parts;
    for (let index = 0; index < parts; index += 1) sizes.push(base + (index >= parts - extra ? 1 : 0));
    return sizes;
  }
  let left = rest;
  for (const size of batch.sizes) {
    if (left === 0) break;
    const boards = batch.unit === 'percent' ? Math.max(1, Math.ceil((size * rest) / 100)) : size;
    const taken = Math.min(boards, left);
    sizes.push(taken);
    left -= taken;
  }
  if (left > 0) sizes.push(left);
  return sizes;
}

/** What to look at before starting: a stage too small to say anything about the next. */
export function stageWarnings(sizes) {
  return sizes
    .slice(0, -1)
    .map((size, index) =>
      size < MIN_USEFUL_STAGE
        ? `Stage ${index + 1} has ${plural(size, 'board')}: too few to tell anything about the next.`
        : null
    )
    .filter(Boolean);
}

/** Take what the console suggests into the dialog's choices; the person may change any of it. */
function applySuggestion(model, suggestion) {
  model.suggestion = suggestion;
  model.canary = suggestion.canarySize;
  model.stages = Math.max(1, suggestion.stageCount);
  model.unit = suggestion.batch ? 'count' : 'even';
  model.sizes = suggestion.batch ? [...suggestion.batch.sizes] : [];
  model.soakMinutes = suggestion.soakMinutes;
  model.abortPercent = suggestion.abortPercent;
  model.healthGate = suggestion.healthGate.on;
  model.gateMinutes = suggestion.healthGate.minutes;
}

function numberField(key, label, value, min, max, apply, unit) {
  return h(
    'label',
    { class: 'field is-inline', key },
    h('span', { class: 'field-label' }, label),
    h('input', {
      class: 'input is-number',
      type: 'number',
      min: String(min),
      max: String(max),
      step: '1',
      value: String(value),
      onInput: (event) => {
        const read = Number(event.target.value);
        if (Number.isInteger(read) && read >= min && read <= max) apply(read);
      },
    }),
    unit ? h('span', { class: 'quiet' }, unit) : null
  );
}

/**
 * The choices of a rollout. `most` is the most canary boards it may have; `rest`, when known, how
 * many boards follow the canary, for the plan it shows; `redraw` draws the dialog again.
 */
function rolloutOptions(model, most, rest = null, redraw = () => {}) {
  const set = (apply) => (value) => {
    apply(value);
    redraw();
  };
  const sizes = rest === null ? [] : plannedSizes(rest, model);
  const warnings = [...(model.suggestion?.warnings ?? []), ...stageWarnings(sizes)];
  return h(
    'div',
    { class: 'rollout-options', key: 'options' },
    model.suggesting
      ? h('p', { class: 'quiet', key: 'suggesting' }, 'Working out a suggestion…')
      : model.suggestion
        ? h(
            'div',
            { class: 'callout rollout-suggestion', key: 'suggestion' },
            h('p', { class: 'callout-title' }, 'Suggested, and filled in below: change anything'),
            h(
              'ul',
              { class: 'plain-list' },
              model.suggestion.reasons.map((line) => h('li', { key: line }, line))
            )
          )
        : null,
    h(
      'div',
      { class: 'staged-choices', key: 'numbers' },
      numberField(
        'canary',
        'Canary boards',
        Math.min(model.canary, Math.max(1, most)),
        1,
        Math.max(1, Math.min(5, most)),
        set((value) => {
          model.canary = value;
        }),
        null
      ),
      numberField(
        'stages',
        'Stages after it',
        model.stages,
        1,
        MAX_STAGES,
        set((value) => {
          model.stages = value;
        }),
        null
      ),
      numberField(
        'soak',
        'Wait between stages',
        model.soakMinutes,
        0,
        MAX_SOAK,
        set((value) => {
          model.soakMinutes = value;
        }),
        'min'
      ),
      numberField(
        'abort',
        'Stop when failures reach',
        model.abortPercent,
        1,
        100,
        set((value) => {
          model.abortPercent = value;
        }),
        '%'
      )
    ),
    gateChoice(model, set),
    model.stages > 1
      ? h(
          'fieldset',
          { class: 'choices is-inline', key: 'batch' },
          h('legend', null, 'Batch size of each stage but the last'),
          BATCH_UNITS.map((entry) =>
            choice(
              {
                key: entry.unit,
                type: 'radio',
                name: 'batch-unit',
                checked: model.unit === entry.unit,
                onChange: () => {
                  model.unit = entry.unit;
                  if (entry.unit === 'percent') model.sizes = model.sizes.map((size) => Math.min(size, 100));
                  redraw();
                },
              },
              entry.label
            )
          ),
          model.unit === 'even'
            ? null
            : h(
                'div',
                { class: 'staged-choices', key: 'sizes' },
                Array.from({ length: model.stages - 1 }, (_, index) =>
                  numberField(
                    `size-${index}`,
                    `Stage ${index + 1}`,
                    model.sizes[index] ?? model.sizes.at(-1) ?? 1,
                    1,
                    100,
                    set((value) => {
                      const filled = Array.from(
                        { length: model.stages - 1 },
                        (_, at) => model.sizes[at] ?? model.sizes.at(-1) ?? 1
                      );
                      filled[index] = value;
                      model.sizes = filled;
                    }),
                    model.unit === 'percent' ? '%' : 'boards'
                  )
                )
              )
        )
      : null,
    sizes.length > 0
      ? h(
          'p',
          { class: 'quiet rollout-plan', key: 'plan' },
          `After the canary: ${sizes.map((size, index) => `stage ${index + 1}, ${plural(size, 'board')}`).join('; ')}. ` +
            'Each stage goes to all its boards at once.'
        )
      : null,
    warnings.length > 0
      ? notice(
          'warn',
          'alert',
          h(
            'ul',
            { class: 'plain-list' },
            warnings.map((line) => h('li', { key: line }, line))
          )
        )
      : null
  );
}

/**
 * The health gate's choice (console 2.13.0): on by default, with its minutes. `set` wraps a change so
 * that the dialog is drawn again.
 */
export function gateChoice(model, set) {
  if (model.gateLocked) {
    return h(
      'div',
      { class: 'rollout-gate', key: 'gate' },
      h(
        'p',
        { class: 'choice-note' },
        'Health gate: always on for a roll back. The next stage starts only if Memfault shows no new issue and no ' +
          'unexpected reboot on the release for this long after the boards before it confirmed.'
      ),
      h(
        'div',
        { class: 'staged-choices', key: 'gate-minutes' },
        numberField(
          'gate-minutes',
          'Watch for',
          model.gateMinutes ?? DEFAULT_GATE,
          0,
          MAX_GATE,
          set((value) => {
            model.gateMinutes = value;
          }),
          'min'
        )
      )
    );
  }
  return h(
    'div',
    { class: 'rollout-gate', key: 'gate' },
    choice(
      {
        key: 'gate-on',
        type: 'checkbox',
        name: 'health-gate',
        checked: model.healthGate !== false,
        onChange: (event) =>
          set(() => {
            model.healthGate = event.target.checked;
          })(),
      },
      'Health gate',
      h(
        'span',
        { class: 'choice-note' },
        'The next stage starts only if Memfault shows no new issue and no unexpected reboot on the release ' +
          'for this long after the boards before it confirmed. If Memfault cannot be read, it waits up to 30 minutes and stops.'
      )
    ),
    model.healthGate !== false
      ? h(
          'div',
          { class: 'staged-choices', key: 'gate-minutes' },
          numberField(
            'gate-minutes',
            'Watch for',
            model.gateMinutes ?? DEFAULT_GATE,
            0,
            MAX_GATE,
            set((value) => {
              model.gateMinutes = value;
            }),
            'min'
          )
        )
      : null
  );
}

/** The words of "What happens" for the stage choices. */
function stageWords(model) {
  const gate =
    model.healthGate === false
      ? ''
      : ` Before each next stage the boards so far run it for ${plural(model.gateMinutes ?? DEFAULT_GATE, 'minute')} ` +
        'with no new Memfault issue and no unexpected reboot, or the rollout stops.';
  return model.stages === 1
    ? `Once it has confirmed, every other board gets it at once.${gate}`
    : `Once it has confirmed, the rest follow in ${model.stages} stages, each to all its boards at once; ` +
        `a stage starts only once the one before has ended${model.soakMinutes > 0 ? ` and ${plural(model.soakMinutes, 'minute')} have passed` : ''}.${gate}`;
}

/** A release to one group: of the group's types, the boards of the release's type take it. */
function openGroupRollout(group) {
  if (tools.dialogs.isOpen()) return;
  const fleet = tools.state.fleet.value;
  const releases = (tools.state.firmware.value?.releases ?? []).filter((release) => release.status === 'active');
  const types = new Set(
    group.things.map((thing) => fleet?.boards.find((board) => board.thing === thing)?.type).filter(Boolean)
  );
  const offered = releases.filter((release) => types.has(release.board ?? 'nrf7002dk'));
  let self = null;
  const model = {
    version: offered[0]?.version ?? null,
    canary: 1,
    abortPercent: 20,
    ...stageModel(),
    note: '',
    sending: false,
    error: null,
  };
  const redraw = () => self?.redraw?.();
  // What the console suggests for this release and group fills the choices in; a later answer
  // for a release no longer chosen is dropped.
  const suggest = async () => {
    const asked = model.version;
    if (asked === null) return;
    model.suggesting = true;
    redraw();
    try {
      const suggestion = await fleetApi.suggest(asked, group.id);
      if (model.version === asked) applySuggestion(model, suggestion);
    } catch {
      // Without a suggestion the choices stay as they are.
      if (model.version === asked) model.suggestion = null;
    }
    model.suggesting = false;
    redraw();
  };
  const submit = () =>
    tools.dialogs.submit(self, model, async () => {
      let rollout;
      try {
        rollout = await fleetApi.startRollout({
          version: model.version,
          target: { kind: 'group', group: group.id },
          canary: model.canary,
          ...stageBody(model),
          abortPercent: model.abortPercent,
          ...(singleLine(model.note) ? { note: singleLine(model.note) } : {}),
        });
      } catch (error) {
        after(error);
        throw error;
      }
      tools.keep(tools.state.rolloutDetails, rollout.id, rollout);
      self.close(true);
      tools.notify(`Staged rollout of ${rollout.version} to ${group.name} started.`);
      tools.go({ view: 'rollout', id: rollout.id });
    });
  self = tools.dialogs.open(() => {
    const release = offered.find((item) => item.version === model.version) ?? null;
    const ofType = group.things.filter(
      (thing) => fleet?.boards.find((board) => board.thing === thing)?.type === (release?.board ?? 'nrf7002dk')
    );
    return dialogFrame({
      title: ['Roll out to ', group.name],
      busy: model.sending,
      onClose: () => self.close(),
      onSubmit: release ? submit : null,
      body:
        offered.length === 0
          ? empty({
              iconName: 'package',
              title: 'No release for these boards.',
              text: 'Upload a release of their board type first.',
            })
          : [
              h(
                'fieldset',
                { class: 'choices', key: 'releases' },
                h('legend', null, 'Which release?'),
                offered.slice(0, 6).map((item) =>
                  choice(
                    {
                      key: item.version,
                      type: 'radio',
                      name: 'release',
                      checked: item.version === model.version,
                      onChange: () => {
                        model.version = item.version;
                        redraw();
                        suggest();
                      },
                    },
                    mono(item.version),
                    h('span', { class: 'choice-note' }, typeChip(item.board ?? 'nrf7002dk'), ' ', item.notes)
                  )
                )
              ),
              rolloutOptions(
                model,
                (model.suggestion?.things.length ?? ofType.length) - 1,
                Math.max(0, (model.suggestion?.things.length ?? ofType.length) - model.canary),
                redraw
              ),
              h(
                'div',
                { class: 'callout', key: 'what' },
                h('p', { class: 'callout-title' }, 'What happens'),
                consequences([
                  `The ${plural(ofType.length, 'board', 'boards')} of the group that are ${boardTypeLabel(release?.board ?? 'nrf7002dk')}s are considered; ` +
                    'the server leaves out those already on it, those busy with another update and any without Wi-Fi, and says why.',
                  `${plural(model.canary, 'board gets', 'boards get')} it first. ${stageWords(model)}`,
                  `It stops by itself once ${model.abortPercent}% of the boards that finished have failed.`,
                ])
              ),
            ],
      error: model.error ? failure('The rollout was not started.', model.error, null, tools.dialogs.signIn) : null,
      foot: [
        dialogButton({ key: 'cancel', disabled: model.sending, onClick: () => self.close() }, 'Cancel'),
        SPACER(),
        dialogButton(
          { key: 'go', className: 'is-primary', submit: true, disabled: !release, sending: model.sending },
          icon('send'),
          model.sending ? 'Starting…' : 'Start staged rollout'
        ),
      ],
    });
  });
  suggest();
}

/**
 * "Update everything", or with a group the roll back of that group: the plan as the server makes it
 * now, by board type, each type's boards ticked; what is left out is listed with why.
 */
function openPlan({ group = null }) {
  if (tools.dialogs.isOpen()) return;
  let self = null;
  const model = {
    plan: null,
    loading: true,
    loadError: null,
    picked: new Map(),
    canary: 1,
    ...stageModel(),
    abortPercent: 20,
    sending: false,
    error: null,
  };
  const redraw = () => self.redraw();
  const reload = async () => {
    model.loading = true;
    model.loadError = null;
    redraw();
    try {
      model.plan = group ? await fleetApi.rollbackPlan(group.id) : await fleetApi.everythingPlan();
      model.picked = new Map(
        model.plan.types
          .filter((entry) => entry.release && entry.things.length > 0)
          .map((entry) => [entry.type, new Set(entry.things)])
      );
    } catch (error) {
      model.loadError = error instanceof ApiError ? error : { message: String(error?.message ?? error) };
    }
    model.loading = false;
    redraw();
  };
  const submit = () =>
    tools.dialogs.submit(self, model, async () => {
      const types = model.plan.types
        .filter((entry) => (model.picked.get(entry.type)?.size ?? 0) > 0)
        .map((entry) => ({
          type: entry.type,
          version: entry.release.version,
          things: [...model.picked.get(entry.type)].sort(),
        }));
      const body = { types, canary: model.canary, ...stageBody(model), abortPercent: model.abortPercent };
      let started;
      try {
        started = group ? await fleetApi.startRollback(group.id, body) : await fleetApi.startEverything(body);
      } catch (error) {
        if (error?.status === 409) reload();
        throw error;
      }
      for (const rollout of started) tools.keep(tools.state.rolloutDetails, rollout.id, rollout);
      self.close(true);
      tools.notify(`${plural(started.length, 'staged rollout')} started.`);
      if (started.length === 1) tools.go({ view: 'rollout', id: started[0].id });
      else tools.go({ view: 'fleet' });
    });
  self = tools.dialogs.open(() => {
    const chosen = [...model.picked.values()].reduce((sum, set) => sum + set.size, 0);
    let body;
    if (model.loading) {
      body = h('p', { class: 'quiet' }, 'Reading the plan…');
    } else if (model.loadError) {
      body = notice(
        'bad',
        'alert',
        [h('strong', null, 'Could not read the plan. '), sentence(model.loadError.message)],
        { action: button('is-small', reload, 'Try again') }
      );
    } else {
      body = [
        h(
          'p',
          { class: 'dialog-lede', key: 'lede' },
          group
            ? 'For each board type in the group, the release before its newest, to the boards that can take it.'
            : 'For each board type, its newest release, to every board of the type that is not on it. Each type is a staged rollout of its own.'
        ),
        group
          ? h(
              'p',
              { class: 'callout', key: 'real' },
              icon('alert', 'is-small'),
              ' A board takes only firmware newer than what it runs, so this reaches only boards behind both releases. ' +
                'A real roll-back is a rebuild of the old source under a newer version, released and rolled out like any other.'
            )
          : null,
        model.plan.types.map((entry) =>
          h(
            'section',
            { class: 'plan-type', key: entry.type },
            h(
              'h3',
              { class: 'plan-type-head' },
              h(
                'span',
                { class: 'fleet-chip board-chip' },
                `${boardTypeLabel(entry.type)}${entry.release ? ` · layout ${entry.release.layout}` : ''}`
              ),
              entry.release ? [' ', mono(entry.release.version)] : h('span', { class: 'quiet' }, ' nothing to send'),
              entry.from ? h('span', { class: 'quiet' }, [' instead of ', mono(entry.from)]) : null
            ),
            entry.things.length > 0
              ? h(
                  'fieldset',
                  { class: 'choices' },
                  h('legend', { class: 'sr-only' }, `Boards of the ${boardTypeLabel(entry.type)}`),
                  entry.things.map((thing) =>
                    choice(
                      {
                        key: thing,
                        type: 'checkbox',
                        checked: model.picked.get(entry.type)?.has(thing) ?? false,
                        onChange: () => {
                          const set = model.picked.get(entry.type) ?? new Set();
                          if (set.has(thing)) set.delete(thing);
                          else set.add(thing);
                          model.picked.set(entry.type, set);
                          redraw();
                        },
                      },
                      [
                        boardLabel(boardFrom({ state: tools.state }, thing)),
                        boardThing(boardFrom({ state: tools.state }, thing)),
                      ],
                      entry.canary.includes(thing)
                        ? h('span', { class: 'choice-note' }, 'The canary: it goes first')
                        : null
                    )
                  )
                )
              : h('p', { class: 'quiet' }, 'No board of this type to update.'),
            entry.leftOut.length > 0
              ? [
                  h('p', { class: 'plan-left-head' }, `Left out: ${plural(entry.leftOut.length, 'board')}`),
                  leftOutList(entry.leftOut, { state: tools.state }),
                ]
              : null
          )
        ),
        chosen > 1 ? rolloutOptions(model, chosen - 1, null, redraw) : null,
      ];
    }
    return dialogFrame({
      title: group ? ['Roll back ', group.name] : 'Update everything',
      busy: model.sending,
      onClose: () => self.close(),
      onSubmit: chosen > 0 ? submit : null,
      body,
      error: model.error ? failure('Nothing was started.', model.error, null, tools.dialogs.signIn) : null,
      foot: [
        dialogButton({ key: 'cancel', disabled: model.sending, onClick: () => self.close() }, 'Cancel'),
        SPACER(),
        dialogButton(
          { key: 'go', className: 'is-primary', submit: true, disabled: chosen === 0, sending: model.sending },
          icon('send'),
          model.sending ? 'Starting…' : chosen === 0 ? 'Nothing to update' : `Start: ${plural(chosen, 'board')}`
        ),
      ],
    });
  });
  reload();
}

/**
 * "Roll back to last good" (console 2.14.0), for a group or (no group) the fleet: the plan as the
 * server makes it now. Each board with where it goes (from -> its last good version) under the
 * release that takes it there, one staged rollout per release, the health gate always on; what is
 * left out is listed with why (no known good version, revoked, no rebuild, offline, another type).
 */
function openLastGood({ group = null }) {
  if (tools.dialogs.isOpen()) return;
  let self = null;
  const model = {
    plan: null,
    loading: true,
    loadError: null,
    picked: new Map(),
    canary: 1,
    ...stageModel(),
    gateLocked: true,
    abortPercent: 20,
    sending: false,
    error: null,
  };
  const redraw = () => self.redraw();
  const reload = async () => {
    model.loading = true;
    model.loadError = null;
    redraw();
    try {
      model.plan = await fleetApi.lastGoodPlan(group?.id ?? null);
      model.picked = new Map(
        model.plan.targets
          .filter((target) => target.things.length > 0)
          .map((target) => [target.release.version, new Set(target.things)])
      );
      if (model.plan.healthGate) model.gateMinutes = model.plan.healthGate.minutes;
    } catch (error) {
      model.loadError = error instanceof ApiError ? error : { message: String(error?.message ?? error) };
    }
    model.loading = false;
    redraw();
  };
  const submit = () =>
    tools.dialogs.submit(self, model, async () => {
      const targets = model.plan.targets
        .filter((target) => (model.picked.get(target.release.version)?.size ?? 0) > 0)
        .map((target) => ({
          version: target.release.version,
          things: [...model.picked.get(target.release.version)].sort(),
        }));
      const body = {
        targets,
        canary: model.canary,
        ...stageBody({ ...model, healthGate: true }),
        abortPercent: model.abortPercent,
      };
      let started;
      try {
        started = await fleetApi.startLastGood(group?.id ?? null, body);
      } catch (error) {
        if (error?.status === 409) reload();
        throw error;
      }
      for (const rollout of started) tools.keep(tools.state.rolloutDetails, rollout.id, rollout);
      self.close(true);
      tools.notify(`${plural(started.length, 'staged rollout')} started.`);
      if (started.length === 1) tools.go({ view: 'rollout', id: started[0].id });
      else tools.go({ view: 'fleet' });
    });
  self = tools.dialogs.open(() => {
    const chosen = [...model.picked.values()].reduce((sum, set) => sum + set.size, 0);
    const ctx = { state: tools.state };
    let body;
    if (model.loading) {
      body = h('p', { class: 'quiet' }, 'Working out each board’s last good version…');
    } else if (model.loadError) {
      body = notice(
        'bad',
        'alert',
        [h('strong', null, 'Could not read the plan. '), sentence(model.loadError.message)],
        { action: button('is-small', reload, 'Try again') }
      );
    } else {
      body = [
        h(
          'p',
          { class: 'dialog-lede', key: 'lede' },
          `Each board ${group ? 'of the group' : 'of the fleet'} goes back to the last version it ran confirmed before the one it runs. ` +
            'Boards that go to the same release are one staged rollout, with the health gate on.'
        ),
        h(
          'p',
          { class: 'callout', key: 'real' },
          icon('alert', 'is-small'),
          ' A board takes only firmware newer than what it runs. So a board goes back by a rebuild of its last good ' +
            'version under a newer number: a release whose note says "Rebuild of <version>".'
        ),
        model.plan.targets.length === 0
          ? h('p', { class: 'quiet', key: 'none' }, 'No board has a last good version it can be sent.')
          : null,
        model.plan.targets.map((target) =>
          h(
            'section',
            { class: 'plan-type', key: target.release.version },
            h(
              'h3',
              { class: 'plan-type-head' },
              h(
                'span',
                { class: 'fleet-chip board-chip' },
                `${boardTypeLabel(target.type)} · layout ${target.release.layout}`
              ),
              ' ',
              mono(target.release.version),
              target.release.rebuildOf
                ? h('span', { class: 'quiet' }, [' rebuild of ', mono(target.release.rebuildOf)])
                : null
            ),
            target.things.length > 0
              ? h(
                  'fieldset',
                  { class: 'choices' },
                  h('legend', { class: 'sr-only' }, `Boards that ${target.release.version} takes back`),
                  target.things.map((thing) => {
                    const move = target.boards.find((entry) => entry.thing === thing);
                    return choice(
                      {
                        key: thing,
                        type: 'checkbox',
                        checked: model.picked.get(target.release.version)?.has(thing) ?? false,
                        onChange: () => {
                          const set = model.picked.get(target.release.version) ?? new Set();
                          if (set.has(thing)) set.delete(thing);
                          else set.add(thing);
                          model.picked.set(target.release.version, set);
                          redraw();
                        },
                      },
                      [boardLabel(boardFrom(ctx, thing)), boardThing(boardFrom(ctx, thing))],
                      h(
                        'span',
                        { class: 'choice-note' },
                        `${move?.from ?? 'unknown'} → ${move?.to ?? target.release.version}`,
                        target.canary.includes(thing) ? ' · the canary: it goes first' : ''
                      )
                    );
                  })
                )
              : h('p', { class: 'quiet' }, 'No board can take it now.'),
            target.leftOut.length > 0
              ? [
                  h('p', { class: 'plan-left-head' }, `Left out: ${plural(target.leftOut.length, 'board')}`),
                  leftOutList(target.leftOut, ctx),
                ]
              : null
          )
        ),
        model.plan.leftOut.length > 0
          ? h(
              'section',
              { class: 'plan-type', key: 'left-out' },
              h(
                'p',
                { class: 'plan-left-head' },
                `Left out: ${plural(model.plan.leftOut.length, 'board')} with nowhere to go`
              ),
              leftOutList(model.plan.leftOut, ctx)
            )
          : null,
        chosen > 1 ? rolloutOptions(model, chosen - 1, null, redraw) : null,
      ];
    }
    return dialogFrame({
      title: group ? ['Roll back ', group.name, ' to last good'] : 'Roll back the fleet to last good',
      busy: model.sending,
      onClose: () => self.close(),
      onSubmit: chosen > 0 ? submit : null,
      body,
      error: model.error ? failure('Nothing was started.', model.error, null, tools.dialogs.signIn) : null,
      foot: [
        dialogButton({ key: 'cancel', disabled: model.sending, onClick: () => self.close() }, 'Cancel'),
        SPACER(),
        dialogButton(
          { key: 'go', className: 'is-primary', submit: true, disabled: chosen === 0, sending: model.sending },
          icon('undo'),
          model.sending ? 'Starting…' : chosen === 0 ? 'Nothing to roll back' : `Roll back: ${plural(chosen, 'board')}`
        ),
      ],
    });
  });
  reload();
}

// For tests: the readers, as the pages use them.
export const readers = Object.freeze({ readBoard, readGroup, readRollout, readPlan, readLastGoodPlan });
export { fleetApi as api };
