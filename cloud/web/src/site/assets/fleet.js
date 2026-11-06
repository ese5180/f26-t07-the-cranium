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
 *  - a staged rollout's page (#/rollouts/<id>): its canary, its waves, what was left out and why,
 *    and why it stopped;
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
});
const STAGES = Object.freeze({
  canary: { tone: 'live', icon: 'restart', label: 'Canary' },
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
    canary: { things: things(canary.things), job: words(canary.job, 64) || null },
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
      stopped === null ? null : { code: words(stopped.code, 32), text: words(stopped.text, 300), at: iso(stopped.at) },
    finishedAt: iso(item.finishedAt),
    canaryJob: item.canaryJob ? readJob(item.canaryJob) : null,
    wavesJob: item.wavesJob ? readJob(item.wavesJob) : null,
    waves: array(item.waves)
      .map(object)
      .map((wave) => ({ wave: count(wave.wave), at: iso(wave.at), things: things(wave.things) })),
    notOffered: things(item.notOffered),
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
export async function startRollout({ version: release, things: boards, note, canary, abortPercent }) {
  const body = { version: release, target: { kind: 'boards', things: boards }, canary, abortPercent };
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
  return rollout.stage === 'canary' || rollout.stage === 'waves';
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
              'A deployment to more than one board, a group or a type starts here: a canary first, then waves.'
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
      lede: 'Board types, groups of boards, and releases to many boards at once: a canary first, then waves once it has confirmed.',
      tools: [
        freshness(state.fleet, ctx),
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
  const reached = {
    canary: 0,
    waves: 1,
    done: 2,
    stopped: rollout.rest.job ? 1 : 0,
    cancelled: rollout.rest.job ? 1 : 0,
  }[rollout.stage];
  const ended = rollout.stage === 'stopped' || rollout.stage === 'cancelled';
  const labels = ['Canary', 'Waves', ended ? STAGES[rollout.stage].label : 'Done'];
  return h(
    'ol',
    { class: 'wizard-steps rollout-steps', key: 'steps' },
    labels.map((label, index) =>
      h(
        'li',
        {
          key: label,
          class:
            index < reached || (index === 2 && rollout.stage === 'done')
              ? 'is-done'
              : index === reached && !ended
                ? 'is-current'
                : ended && index === 2
                  ? 'is-stopped'
                  : null,
        },
        h(
          'span',
          { class: 'wizard-number' },
          index < reached || (index === 2 && rollout.stage === 'done') ? icon('check') : String(index + 1)
        ),
        label
      )
    )
  );
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
  const leftOut = [...rollout.leftOut, ...rollout.rest.leftOut];
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
        'The first to get it. The waves start only once every one of them has installed it, ' +
          'restarted, reached AWS IoT and confirmed it; the console looks every minute.'
      ),
      boardStatusList(ctx, rollout.canary.things, rollout.canaryJob)
    ),
    card(
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
                h('p', { class: 'wave-head' }, h('strong', null, `Wave ${wave.wave}`), ' ', when(wave.at, state.now)),
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
        'What has not started is not offered any more: no wave starts after this.',
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

function rolloutOptions(model, most) {
  const number = (key, label, value, min, max, apply, unit) =>
    h(
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
  return h(
    'div',
    { class: 'staged-choices', key: 'options' },
    number(
      'canary',
      'Canary boards',
      model.canary,
      1,
      Math.max(1, most),
      (value) => {
        model.canary = value;
      },
      null
    ),
    number(
      'abort',
      'Stop when failures reach',
      model.abortPercent,
      1,
      100,
      (value) => {
        model.abortPercent = value;
      },
      '%'
    )
  );
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
    note: '',
    sending: false,
    error: null,
  };
  const redraw = () => self.redraw();
  const submit = () =>
    tools.dialogs.submit(self, model, async () => {
      let rollout;
      try {
        rollout = await fleetApi.startRollout({
          version: model.version,
          target: { kind: 'group', group: group.id },
          canary: model.canary,
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
                      },
                    },
                    mono(item.version),
                    h('span', { class: 'choice-note' }, typeChip(item.board ?? 'nrf7002dk'), ' ', item.notes)
                  )
                )
              ),
              rolloutOptions(model, ofType.length - 1),
              h(
                'div',
                { class: 'callout', key: 'what' },
                h('p', { class: 'callout-title' }, 'What happens'),
                consequences([
                  `The ${plural(ofType.length, 'board', 'boards')} of the group that are ${boardTypeLabel(release?.board ?? 'nrf7002dk')}s are considered; ` +
                    'the server leaves out those already on it, those busy with another update and any without Wi-Fi, and says why.',
                  `${plural(model.canary, 'board gets', 'boards get')} it first. The rest follow in waves once that has confirmed.`,
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
      const body = { types, canary: model.canary, abortPercent: model.abortPercent };
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
        chosen > 1 ? rolloutOptions(model, chosen - 1) : null,
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

// For tests: the readers, as the pages use them.
export const readers = Object.freeze({ readBoard, readGroup, readRollout, readPlan });
export { fleetApi as api };
