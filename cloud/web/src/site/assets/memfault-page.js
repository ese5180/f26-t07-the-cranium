/**
 * What Memfault knows of the boards, in the console (docs/memfault.md, "In the console"): the Memfault
 * page with its issues and the fleet (reboots by reason, the software versions, each board's latest
 * metrics), an issue's page with its traces and backtraces, and two cards of a board's page: its reboots
 * and their reasons, its trace events and its issues, and its heartbeat metrics as charts over 24 h or 7 d.
 * The charts are the console's own line charts (telemetry.js lineChart), so no library comes in.
 *
 * Everything comes through the console's own API (cloud/api/src/handlers/memfault.mjs), which reads
 * Memfault's REST API on the server: the browser never talks to Memfault, so the page's policy is as
 * strict as before. Fetched when one of these pages is first opened (app.js).
 *
 * Every answer of the server is checked here, field by field, before it is drawn: a field of another
 * type is left out.
 */

import { isThing, plural, signalQuality } from './core.js';
import { lineChart } from './telemetry.js';
import {
  badge,
  card,
  empty,
  filterBar,
  filterSelect,
  filtered,
  h,
  icon,
  loadProblem,
  loading,
  meter,
  mono,
  notice,
  pageHead,
  pending,
  when,
} from './views.js';

// One read of the server per page a minute is plenty: the server keeps Memfault's answers a minute.
export const MEMFAULT_REFRESH_MS = 60_000;
// A week of a board's heartbeats and events.
export const BOARD_HOURS = 168;
const ISSUE_ID = /^[1-9]\d{0,15}$/;
const STATES = ['ok', 'not_configured', 'refused', 'limited', 'unreachable', 'failed'];
const METRIC_KEY = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
const HOUR_MS = 3_600_000;
// The ranges of a board's metric charts; the board's answer holds the week, so a change asks nothing.
export const RANGES = Object.freeze([
  { id: '24h', label: '24 h', name: 'the last 24 hours', hours: 24 },
  { id: '7d', label: '7 d', name: 'the last 7 days', hours: 168 },
]);

let tools = null;

function resource() {
  return { value: null, error: null, loadedAt: 0, loading: false };
}

/** app.js hands over what the pages need once: { state, api, load, draw }. */
export function connect(given) {
  tools = given;
  tools.state.memfault ??= {
    issues: resource(),
    fleet: resource(),
    issue: new Map(),
    boards: new Map(),
    range: RANGES[0].id,
  };
}

function entry(map, key) {
  if (!map.has(key)) map.set(key, resource());
  return map.get(key);
}

// Reading the server's answers.

const text = (value, max = 300) => (typeof value === 'string' ? value.slice(0, max) : null);
const whole = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});

function instant(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function readState(raw) {
  const value = object(raw);
  const state = STATES.includes(value.state) ? value.state : 'unreachable';
  return { state, message: text(value.message, 400) ?? '' };
}

function readReason(raw) {
  const value = object(raw);
  return { name: text(value.name, 64) ?? 'Unknown', expected: value.expected === true, code: whole(value.code) };
}

export function readIssueSummary(raw) {
  const value = object(raw);
  const id = whole(value.id);
  if (id === null || id === 0) return null;
  return {
    id,
    title: text(value.title) ?? 'Untitled issue',
    status: text(value.status, 32),
    traces: whole(value.traces) ?? 0,
    boards: whole(value.boards) ?? 0,
    firstSeen: instant(value.firstSeen),
    lastSeen: instant(value.lastSeen),
    firstVersion: text(value.firstVersion, 64),
    lastVersion: text(value.lastVersion, 64),
  };
}

function readFrame(raw) {
  const value = object(raw);
  return {
    index: whole(value.index),
    function: text(value.function, 200),
    file: text(value.file, 300),
    line: whole(value.line),
    address: text(value.address, 20),
  };
}

function readThread(raw) {
  const value = object(raw);
  return {
    id: whole(value.id),
    name: text(value.name, 64),
    crashed: value.crashed === true,
    current: value.current === true,
    state: text(value.state, 32),
    frames: list(value.frames).slice(0, 64).map(readFrame),
    registers: list(value.registers)
      .slice(0, 64)
      .map((one) => ({ name: text(object(one).name, 16), value: text(object(one).value, 40) }))
      .filter((one) => one.value !== null),
  };
}

function readTrace(raw) {
  const value = object(raw);
  return {
    id: whole(value.id),
    title: text(value.title),
    reason: text(value.reason, 64),
    message: text(value.message, 2000),
    capturedAt: instant(value.capturedAt),
    serial: text(value.serial, 128),
    thing: isThing(value.thing) ? value.thing : null,
    version: text(value.version, 64),
    threads: list(value.threads).slice(0, 32).map(readThread),
  };
}

/** GET /api/memfault/issues */
export function readIssues(raw) {
  const value = object(raw);
  return {
    memfault: readState(value.memfault),
    issues: list(value.issues)
      .map(readIssueSummary)
      .filter((one) => one !== null),
  };
}

/** GET /api/memfault/issues/{id} */
export function readIssue(raw) {
  const value = object(raw);
  return {
    memfault: readState(value.memfault),
    issue: value.issue ? readIssueSummary(value.issue) : null,
    traces: list(value.traces).slice(0, 50).map(readTrace),
    boards: list(value.boards)
      .filter((one) => typeof one === 'string')
      .map((one) => one.slice(0, 128)),
  };
}

/** GET /api/devices/{thing}/memfault: what this page shows of it. */
export function readBoard(raw) {
  const value = object(raw);
  return {
    memfault: readState(value.memfault),
    known: value.known === true,
    software: text(object(value.device).software, 64),
    lastSeen: instant(object(value.device).lastSeen),
    reboots: list(value.reboots)
      .map((one) => ({
        at: instant(object(one).at),
        reason: readReason(object(one).reason),
        version: text(object(one).version, 64),
      }))
      .filter((one) => one.at !== null),
    events: list(value.events)
      .map((one) => ({
        at: instant(object(one).at),
        name: text(object(one).name, 64),
        detail: text(object(one).detail, 200),
      }))
      .filter((one) => one.at !== null && one.name !== null),
    issues: list(value.issues)
      .map(readIssueSummary)
      .filter((one) => one !== null),
    to: instant(value.to),
    metrics: readSeries(value.metrics),
  };
}

/** A number the board sent, or null. */
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** A board's heartbeat metrics: { series: { key: [{ ms, v }] oldest first }, unnamed }. */
export function readSeries(raw) {
  const value = object(raw);
  const series = {};
  for (const [key, points] of Object.entries(object(value.series)).slice(0, 128)) {
    if (!METRIC_KEY.test(key)) continue;
    const kept = list(points)
      .map((one) => ({ ms: Date.parse(instant(object(one).at) ?? ''), v: number(object(one).v) }))
      .filter((one) => Number.isFinite(one.ms) && one.v !== null)
      .sort((a, b) => a.ms - b.ms);
    if (kept.length > 0) series[key] = kept;
  }
  return { series, unnamed: whole(value.unnamed) ?? 0 };
}

/** GET /api/memfault/fleet: the reboots by reason, the devices and releases, each board's latest metrics. */
export function readFleet(raw) {
  const value = object(raw);
  return {
    memfault: readState(value.memfault),
    hours: whole(value.hours) ?? 168,
    devices: list(value.devices)
      .map((one) => ({
        serial: text(object(one).serial, 128),
        thing: isThing(object(one).thing) ? object(one).thing : null,
        software: text(object(one).software, 64),
        lastSeen: instant(object(one).lastSeen),
        registered: object(one).registered === true,
      }))
      .filter((one) => one.serial !== null),
    releases: list(value.releases)
      .map((one) => ({
        version: text(object(one).version, 64),
        createdAt: instant(object(one).createdAt),
        symbols: typeof object(one).symbols === 'boolean' ? object(one).symbols : null,
      }))
      .filter((one) => one.version !== null),
    reboots: list(object(value.reboots).byReason)
      .map((one) => ({
        reason: readReason(object(one).reason),
        count: whole(object(one).count) ?? 0,
        boards: list(object(one).boards).filter((serial) => typeof serial === 'string').length,
      }))
      .filter((one) => one.count > 0),
    boards: list(object(value.metrics).boards)
      .map((one) => {
        const board = object(one);
        const values = {};
        for (const [key, entry] of Object.entries(object(board.values)).slice(0, 128)) {
          const v = number(object(entry).v);
          if (METRIC_KEY.test(key) && v !== null) values[key] = v;
        }
        return {
          serial: text(board.serial, 128),
          thing: isThing(board.thing) ? board.thing : null,
          at: instant(board.at),
          values,
          unnamed: whole(board.unnamed) ?? 0,
        };
      })
      .filter((one) => one.serial !== null),
  };
}

// The metrics the firmware and the SDK send (firmware/app/config/memfault_metrics_heartbeat_config.def and
// the SDK's Zephyr port), with names a person reads. A board sends them as whole numbers: a percentage in
// hundredths, a time in milliseconds; `scale` makes them the unit shown. Any other key is drawn too, under
// its own name, as the board sent it.

const GROUPS = Object.freeze([
  ['power', 'Power'],
  ['wifi', 'Wi-Fi'],
  ['cpu', 'CPU'],
  ['memory', 'Memory and stacks'],
  ['link', 'Connection to the cloud'],
  ['restarts', 'Restarts and boot'],
  ['updates', 'Updates'],
  ['other', 'Other metrics'],
]);

const decimal = (value, digits = 2) =>
  value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const signedText = (value) => (value > 0 ? `+${decimal(value, 0)}` : decimal(value, 0).replace('-', '−'));
const count = (one, many) => ({ format: (value) => plural(Math.round(value), one, many), axis: '', unit: many });
const minutes = (unit) => ({ scale: 1 / 60_000, format: (value) => `${decimal(value, 1)} min`, axis: 'min', unit });
const percent = (unit) => ({
  scale: 1 / 100,
  format: (value) => `${decimal(value, 1)} %`,
  axis: '%',
  unit,
  fixed: [0, 100, [0, 25, 50, 75, 100]],
});

export const METRICS = Object.freeze({
  power_usb_present: {
    group: 'power',
    label: 'USB power',
    format: (value) => (value >= 0.5 ? 'On USB' : 'No USB'),
    tick: (value) => (value >= 0.5 ? 'Yes' : 'No'),
    axis: 'USB',
    unit: 'whether the USB regulator saw VBUS (1) or not (0)',
    fixed: [0, 1, [0, 1]],
  },
  supply_mv: {
    group: 'power',
    label: 'Supply voltage',
    scale: 1 / 1000,
    format: (value) => `${value.toFixed(2)} V`,
    tick: (value) => value.toFixed(2),
    axis: 'V',
    unit: 'volts of VDD, one sample, not calibrated',
    zero: false,
  },
  wifi_sta_rssi: {
    group: 'wifi',
    label: 'Wi-Fi signal',
    format: (value) => `${signedText(value)} dBm`,
    tick: signedText,
    axis: 'dBm',
    unit: 'dBm (0 is the strongest)',
    fixed: [-100, -30, [-90, -75, -60, -45]],
    refs: [
      { v: -67, label: 'Good' },
      { v: -75, label: 'Fair' },
    ],
    words: (value) => signalQuality(value)?.label,
  },
  wifi_primary_channel: {
    group: 'wifi',
    label: 'Wi-Fi channel',
    format: (value) => `Channel ${Math.round(value)}`,
    axis: 'ch',
    unit: 'the channel of the access point',
  },
  wifi_connected_time_ms: { group: 'wifi', label: 'Time on Wi-Fi', ...minutes('minutes of each hour') },
  wifi_disconnect_count: { group: 'wifi', label: 'Wi-Fi disconnections', ...count('disconnection') },
  cpu_usage_pct: { group: 'cpu', label: 'CPU use', ...percent('per cent of the CPU') },
  TimerTaskCpuUsage: { group: 'cpu', label: 'Timer thread, CPU time', ...count('cycle'), axis: 'cycles' },
  AllTasksCpuUsage: { group: 'cpu', label: 'All threads, CPU time', ...count('cycle'), axis: 'cycles' },
  Heap_BytesFree: {
    group: 'memory',
    label: 'Free heap',
    scale: 1 / 1024,
    format: (value) => `${decimal(value, 1)} KiB`,
    axis: 'KiB',
    unit: 'KiB of the system heap',
  },
  memory_pct_max: { group: 'memory', label: 'Heap, highest use', ...percent('per cent of the heap') },
  memory_idle_pct_max: {
    group: 'memory',
    label: 'Idle thread stack, highest use',
    ...percent('per cent of the stack'),
  },
  memory_sysworkq_pct_max: {
    group: 'memory',
    label: 'System work queue stack, highest use',
    ...percent('per cent of the stack'),
  },
  TimerTaskFreeStack: {
    group: 'memory',
    label: 'Timer thread stack, free',
    format: (value) => `${decimal(value, 0)} B`,
    axis: 'B',
    unit: 'bytes',
  },
  connectivity_connected_time: { group: 'link', label: 'Time connected', ...minutes('minutes of each hour') },
  connectivity_connected_time_ms: { group: 'link', label: 'Time connected', ...minutes('minutes of each hour') },
  connectivity_expected_time_ms: {
    group: 'link',
    label: 'Time meant to be connected',
    ...minutes('minutes of each hour'),
  },
  sync_successful: { group: 'link', label: 'Reports sent', ...count('report') },
  sync_failure: { group: 'link', label: 'Reports that failed', ...count('report') },
  mqtt_reconnect_count: { group: 'link', label: 'AWS IoT reconnections', ...count('reconnection') },
  memfault_chunk_retry_count: { group: 'link', label: 'Memfault chunks sent again', ...count('chunk') },
  stuck_restart_count: { group: 'restarts', label: 'Stuck restarts in a row', ...count('restart') },
  boot_time_ms: {
    group: 'restarts',
    label: 'Boot time',
    format: (value) => `${decimal(value, 0)} ms`,
    axis: 'ms',
    unit: 'milliseconds from reset to the application',
  },
  MemfaultSdkMetric_UnexpectedRebootCount: { group: 'restarts', label: 'Unexpected reboots', ...count('reboot') },
  uptime_s: {
    group: 'restarts',
    label: 'Uptime',
    scale: 1 / 3600,
    format: (value) => `${decimal(value, 1)} h`,
    axis: 'h',
    unit: 'hours since the last boot',
  },
  ota_attempt_count: { group: 'updates', label: 'Updates started', ...count('update') },
  ota_failure_count: { group: 'updates', label: 'Updates failed', ...count('update') },
  ota_refusal_count: { group: 'updates', label: 'Updates refused', ...count('update') },
});

/** How to show a metric: its entry, or one made for a key no one named. */
export function metricOf(key) {
  if (Object.hasOwn(METRICS, key)) return METRICS[key];
  return { group: 'other', label: key, format: (value) => decimal(value), axis: '', unit: 'as the board sent it' };
}

/** A value as the board sent it, in the unit it is shown in. */
export function shown(key, raw) {
  return raw * (metricOf(key).scale ?? 1);
}

/** A value as words, in its unit: "3.30 V", "On USB", "12.5 %". */
export function metricText(key, raw) {
  return metricOf(key).format(shown(key, raw));
}

/** The scale of a chart: from 0 (or the lowest value) to the highest, on at most five whole steps. */
export function niceScale(values, { zero = true } = {}) {
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (zero) low = Math.min(0, low);
  if (!(high > low)) {
    const pad = Math.abs(low) > 1 ? Math.abs(low) * 0.05 : 1;
    high = low + pad;
    if (!zero) low -= pad;
  }
  const rough = (high - low) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((one) => one * magnitude).find((one) => (high - low) / one <= 4);
  const yMin = Math.floor(low / step) * step;
  const yMax = Math.ceil(high / step) * step;
  const yTicks = [];
  for (let at = yMin; at <= yMax + step / 2; at += step) yTicks.push(Math.round(at * 1e6) / 1e6);
  return { yMin, yMax, yTicks };
}

// Loading.

export function issueHref(id) {
  return ISSUE_ID.test(String(id)) ? `#/memfault/${id}` : null;
}

async function request(path) {
  return tools.api.memfaultRequest(path);
}

export function memfaultResources(state) {
  return state.memfault ? [state.memfault.issues, state.memfault.fleet] : [];
}

export async function refreshMemfault() {
  const { state, load } = tools;
  await Promise.all([
    load(state.memfault.issues, async () => readIssues(await request('/api/memfault/issues'))),
    load(state.memfault.fleet, async () => readFleet(await request('/api/memfault/fleet'))),
  ]);
}

export function issueResources(state) {
  return state.memfault && ISSUE_ID.test(state.route.id ?? '') ? [entry(state.memfault.issue, state.route.id)] : [];
}

export async function refreshIssue() {
  const { state, load } = tools;
  const { id } = state.route;
  if (!ISSUE_ID.test(id ?? '')) return;
  await load(entry(state.memfault.issue, id), async () => readIssue(await request(`/api/memfault/issues/${id}`)));
}

/** A board's Memfault section, read with its page: again only after MEMFAULT_REFRESH_MS. */
export async function refreshBoard(thing, full = false) {
  const { state, load, now } = tools;
  if (!isThing(thing)) return;
  const target = entry(state.memfault.boards, thing);
  if (!full && target.loadedAt !== 0 && now() - target.loadedAt < MEMFAULT_REFRESH_MS) return;
  await load(target, async () => readBoard(await request(`/api/devices/${thing}/memfault?hours=${BOARD_HOURS}`)));
}

// Drawing.

/** Why Memfault's data is not there, when it is not. */
function stateNotice(memfault) {
  if (memfault.state === 'ok' || memfault.state === 'not_configured') return null;
  return h('div', { class: 'page-notice', key: 'memfault-state' }, notice('warn', 'alert', memfault.message));
}

/**
 * Memfault not connected: said plainly, never as "No issues", with how to connect it behind Details (the
 * server's words name the script and the doc, which are for whoever runs the console).
 */
function notConnected(memfault) {
  return card(
    { key: 'not-connected', title: 'Issues' },
    empty({
      iconName: 'minus-circle',
      title: 'Memfault is not connected.',
      text: 'Crashes and traces show here once the console is connected to Memfault. Until then nothing is checked.',
    }),
    memfault.message
      ? h(
          'details',
          { class: 'more is-spaced memfault-connect', key: 'details' },
          h('summary', null, 'Details'),
          h('p', { class: 'ui-card-note card-note' }, memfault.message)
        )
      : null
  );
}

function reasonBadge(reason) {
  return badge(reason.expected ? 'idle' : 'bad', reason.expected ? 'restart' : 'alert', reason.name);
}

function issueRows(issues, now) {
  return h(
    'ul',
    { class: 'rows', key: 'issues' },
    issues.map((one) =>
      h(
        'li',
        { key: String(one.id), class: 'row issue-row' },
        h(
          'div',
          { class: 'row-main' },
          h('a', { href: issueHref(one.id), class: 'row-title cover-link' }, one.title),
          h(
            'span',
            { class: 'row-note dotted' },
            h(
              'span',
              { key: 'traces' },
              `${plural(one.traces, 'trace', 'traces')} on ${plural(one.boards, 'board', 'boards')}`
            ),
            one.lastVersion ? h('span', { key: 'version' }, 'last on ', mono(one.lastVersion)) : null,
            one.lastSeen ? h('span', { key: 'seen' }, 'last ', when(one.lastSeen, now)) : null
          )
        ),
        h('span', { class: 'row-chevron' }, icon('arrow-right'))
      )
    )
  );
}

/** The issues the search and the version keep (docs/search-filters.md), with their bar. */
function issuesFiltered(ctx, issues) {
  const shown = filtered(ctx, 'memfault', issues, {
    words: (issue) => [issue.title, String(issue.id), issue.lastVersion],
    keep: (issue, filters) => filters.version === '' || (issue.lastVersion ?? '').startsWith(filters.version),
  });
  const versions = [...new Set(issues.map((issue) => issue.lastVersion).filter(Boolean))].sort().reverse();
  return [
    filterBar(ctx, 'memfault', {
      label: 'issues',
      placeholder: 'Search by title, number or version',
      shown: shown.length,
      total: issues.length,
      controls:
        versions.length > 1
          ? [
              filterSelect(ctx, 'memfault', {
                name: 'version',
                label: 'Last on',
                all: 'Any version',
                options: versions.map((version) => [version, version]),
              }),
            ]
          : [],
    }),
    shown.length === 0
      ? h(
          'p',
          { class: 'quiet ui-filter-none filter-none', key: 'none' },
          'No issues match. Try other words, or Clear.'
        )
      : issueRows(shown, ctx.state.now),
  ];
}

/** The Memfault page: the issues, newest first, then the fleet: reboots by reason, versions, latest metrics. */
export function memfaultView(ctx) {
  const { state } = ctx;
  const target = state.memfault?.issues ?? resource();
  const head = pageHead({
    title: 'Memfault',
    lede: 'Crashes and traces the boards sent to Memfault, grouped into issues.',
    how: {
      title: 'How Memfault works',
      text: [
        'Below the issues is the fleet as Memfault sees it: reboots by reason, versions and the latest metrics.',
        'The console reads all of it from Memfault.',
      ],
    },
  });
  const data = target.value;
  if (!data)
    return h(
      'div',
      { class: 'page' },
      head,
      loadProblem(target, 'Memfault', ctx),
      pending(target, 'the issues'),
      fleetCards(ctx)
    );
  return h(
    'div',
    { class: 'page' },
    head,
    loadProblem(target, 'Memfault', ctx),
    stateNotice(data.memfault),
    data.memfault.state === 'not_configured' ? notConnected(data.memfault) : null,
    data.memfault.state === 'not_configured'
      ? null
      : card(
          { key: 'issues', title: 'Issues' },
          data.issues.length === 0
            ? empty({
                iconName: data.memfault.state === 'ok' ? 'check' : 'minus-circle',
                title: data.memfault.state === 'ok' ? 'No issues.' : 'No issues could be read.',
                text:
                  data.memfault.state === 'ok'
                    ? 'No board has sent a crash or a trace that Memfault made an issue of.'
                    : null,
              })
            : issuesFiltered(ctx, data.issues)
        ),
    data.memfault.state === 'not_configured' ? null : fleetCards(ctx)
  );
}

function frameLine(frame) {
  const where = frame.file ? `${frame.file}${frame.line !== null ? `:${frame.line}` : ''}` : null;
  return h(
    'li',
    { key: String(frame.index ?? where ?? frame.address), class: 'frame' },
    mono(frame.function ?? frame.address ?? '?'),
    where ? h('span', { class: 'quiet' }, ' ', mono(where)) : null,
    frame.address && frame.function ? h('span', { class: 'quiet' }, ' ', mono(frame.address)) : null
  );
}

function threadBlock(thread, index) {
  const title = `${thread.name ?? `Thread ${thread.id ?? index + 1}`}${thread.crashed ? ' (crashed)' : thread.current ? ' (running)' : ''}`;
  return h(
    'details',
    { key: `thread-${index}`, class: 'thread', open: thread.crashed || index === 0 ? true : null },
    h('summary', null, title, thread.state ? h('span', { class: 'quiet' }, ` · ${thread.state}`) : null),
    thread.frames.length === 0
      ? h('p', { class: 'quiet' }, 'No backtrace: Memfault may lack the symbols of this build.')
      : h('ol', { class: 'backtrace' }, thread.frames.map(frameLine)),
    thread.registers.length > 0
      ? h(
          'table',
          { class: 'ui-table data-table registers' },
          h(
            'tbody',
            null,
            thread.registers.map((one, at) =>
              h(
                'tr',
                { key: `r${at}` },
                h('th', { scope: 'row' }, mono(one.name ?? '')),
                h('td', null, mono(one.value))
              )
            )
          )
        )
      : null
  );
}

function traceCard(trace, index, now) {
  return card(
    { key: `trace-${trace.id ?? index}`, title: trace.title ?? trace.reason ?? 'Trace' },
    h(
      'p',
      { class: 'trace-meta row-note dotted' },
      h(
        'span',
        { key: 'board' },
        trace.thing
          ? h('a', { href: `#/devices/${trace.thing}`, class: 'mono' }, trace.thing)
          : mono(trace.serial ?? 'Unknown board')
      ),
      trace.version ? h('span', { key: 'version' }, 'on ', mono(trace.version)) : null,
      trace.capturedAt ? h('span', { key: 'when' }, when(trace.capturedAt, now)) : null
    ),
    trace.message ? h('p', { class: 'trace-message' }, trace.message) : null,
    trace.threads.length === 0
      ? h('p', { class: 'quiet' }, 'This trace has no threads: it is a trace event, not a coredump.')
      : trace.threads.map(threadBlock)
  );
}

/** An issue's page: what it is, then each trace with its threads, backtrace and registers. */
export function issueView(ctx) {
  const { state } = ctx;
  const id = state.route.id;
  const target = state.memfault ? entry(state.memfault.issue, id) : resource();
  const data = target.value;
  const back = { href: '#/memfault', label: 'Memfault' };
  if (!data) {
    return h(
      'div',
      { class: 'page' },
      pageHead({ title: `Issue ${id}`, back }),
      loadProblem(target, 'this issue', ctx),
      pending(target, 'the issue')
    );
  }
  const issue = data.issue;
  return h(
    'div',
    { class: 'page' },
    pageHead({
      eyebrow: 'Memfault issue',
      title: issue?.title ?? `Issue ${id}`,
      back,
      lede: issue
        ? `${plural(issue.traces, 'trace', 'traces')} on ${plural(issue.boards, 'board', 'boards')}` +
          (issue.firstVersion ? `, first on ${issue.firstVersion}` : '') +
          (issue.lastVersion && issue.lastVersion !== issue.firstVersion ? `, last on ${issue.lastVersion}` : '')
        : null,
    }),
    loadProblem(target, 'this issue', ctx),
    stateNotice(data.memfault),
    data.traces.length === 0 && data.memfault.state === 'ok'
      ? card({ key: 'none' }, h('p', { class: 'quiet' }, 'Memfault gave no trace of this issue.'))
      : data.traces.map((trace, index) => traceCard(trace, index, state.now))
  );
}

/** The Memfault section of a board's page: its reboots with reasons, trace events and issues. */
export function boardSection(thing, ctx) {
  const target = ctx.state.memfault?.boards.get(thing) ?? null;
  if (target === null) return null;
  const data = target.value;
  const body = !data
    ? target.error
      ? loadProblem(target, 'Memfault', ctx)
      : loading('Memfault')
    : [
        stateNotice(data.memfault),
        data.memfault.state === 'ok' && !data.known
          ? h('p', { class: 'quiet', key: 'unknown' }, 'Memfault has not heard from this board yet.')
          : null,
        h('h3', { class: 'card-sub', key: 'reboots-head' }, 'Reboots'),
        data.reboots.length === 0
          ? h('p', { class: 'quiet', key: 'no-reboots' }, 'No reboot reported.')
          : h(
              'ul',
              { class: 'rows', key: 'reboots' },
              data.reboots.map((one, index) =>
                h(
                  'li',
                  { key: `${one.at}-${index}`, class: 'row reboot-row' },
                  reasonBadge(one.reason),
                  h(
                    'span',
                    { class: 'row-note dotted' },
                    h('span', { key: 'when' }, when(one.at, ctx.state.now)),
                    one.version ? h('span', { key: 'version' }, 'on ', mono(one.version)) : null
                  )
                )
              )
            ),
        data.events.length > 0
          ? [
              h('h3', { class: 'card-sub', key: 'events-head' }, 'Events'),
              h(
                'ul',
                { class: 'rows', key: 'events' },
                data.events.map((one, index) =>
                  h(
                    'li',
                    { key: `${one.at}-${index}`, class: 'row event-row' },
                    h(
                      'div',
                      { class: 'row-main' },
                      h('span', { class: 'mono row-title' }, one.name),
                      h(
                        'span',
                        { class: 'row-note dotted' },
                        one.detail ? h('span', { key: 'detail' }, one.detail) : null,
                        h('span', { key: 'when' }, when(one.at, ctx.state.now))
                      )
                    )
                  )
                )
              ),
            ]
          : null,
        data.issues.length > 0
          ? [h('h3', { class: 'card-sub', key: 'issues-head' }, 'Issues'), issueRows(data.issues, ctx.state.now)]
          : null,
      ];
  return card({ key: 'memfault-data', title: 'In Memfault', className: 'memfault-section' }, body);
}

// The fleet, on the Memfault page.

/** The reboots of the week by reason, most first: each with how many, on how many boards, and its share. */
function rebootCard(fleet) {
  const total = fleet.reboots.reduce((sum, one) => sum + one.count, 0);
  const unexpected = fleet.reboots.filter((one) => !one.reason.expected).reduce((sum, one) => sum + one.count, 0);
  return card(
    { key: 'fleet-reboots', title: 'Reboots this week', className: 'memfault-fleet' },
    total === 0
      ? h('p', { class: 'quiet', key: 'none' }, 'No board reported a reboot in the last 7 days.')
      : [
          h(
            'p',
            { class: 'ui-card-note card-note', key: 'total' },
            `${plural(total, 'reboot', 'reboots')}, ${unexpected === 0 ? 'none' : unexpected} unexpected.`
          ),
          h(
            'ul',
            { class: 'rows', key: 'reasons' },
            fleet.reboots.map((one) =>
              h(
                'li',
                { key: one.reason.name, class: `row reason-row ${one.reason.expected ? '' : 'is-unexpected'}`.trim() },
                reasonBadge(one.reason),
                h(
                  'span',
                  { class: 'row-note dotted' },
                  h('span', { key: 'count' }, plural(one.count, 'reboot', 'reboots')),
                  one.boards > 0 ? h('span', { key: 'boards' }, `on ${plural(one.boards, 'board', 'boards')}`) : null,
                  one.reason.expected ? null : h('span', { key: 'kind', class: 'reason-unexpected' }, 'unexpected')
                ),
                meter(
                  Math.round((one.count / total) * 100),
                  `${one.reason.name}: ${Math.round((one.count / total) * 100)} per cent of the reboots`
                )
              )
            )
          ),
        ]
  );
}

/** The software versions the boards last ran, as Memfault saw them, with whether its symbols are there. */
export function versionsOf(fleet) {
  const found = new Map();
  for (const device of fleet.devices) {
    const name = device.software ?? 'Not known';
    found.set(name, (found.get(name) ?? 0) + 1);
  }
  const symbols = new Map(fleet.releases.map((one) => [one.version, one.symbols]));
  return [...found.entries()]
    .map(([version, boards]) => ({ version, boards, symbols: symbols.get(version) ?? null }))
    .sort((a, b) => b.boards - a.boards || (a.version < b.version ? 1 : -1));
}

function versionCard(fleet) {
  const versions = versionsOf(fleet);
  return card(
    { key: 'fleet-versions', title: 'Software versions', className: 'memfault-fleet' },
    versions.length === 0
      ? h('p', { class: 'quiet', key: 'none' }, 'Memfault knows no board yet.')
      : h(
          'ul',
          { class: 'rows', key: 'versions' },
          versions.map((one) =>
            h(
              'li',
              { key: one.version, class: 'row version-row' },
              h(
                'div',
                { class: 'row-main' },
                h('span', { class: 'row-title mono' }, one.version),
                h(
                  'span',
                  { class: 'row-note' },
                  one.symbols === true
                    ? 'Symbols uploaded'
                    : one.symbols === false
                      ? 'No symbols: its crashes have no backtrace'
                      : 'Not a release in Memfault'
                )
              ),
              h('span', { class: 'row-value' }, plural(one.boards, 'board', 'boards'))
            )
          )
        ),
    fleet.releases.length > 0
      ? h(
          'p',
          { class: 'ui-card-note card-note', key: 'releases' },
          `${plural(fleet.releases.length, 'release', 'releases')} in Memfault in all.`
        )
      : null
  );
}

// The metrics each board's row shows on the Memfault page, in this order, when it sent them.
export const FLEET_METRICS = Object.freeze([
  'power_usb_present',
  'supply_mv',
  'wifi_sta_rssi',
  'wifi_primary_channel',
  'cpu_usage_pct',
  'Heap_BytesFree',
  'memory_sysworkq_pct_max',
  'stuck_restart_count',
]);

function latestCard(fleet, now) {
  return card(
    { key: 'fleet-metrics', title: 'Latest metrics', className: 'memfault-fleet' },
    fleet.boards.length === 0
      ? h('p', { class: 'quiet', key: 'none' }, 'No heartbeat in the last 7 days.')
      : h(
          'ul',
          { class: 'rows', key: 'boards' },
          fleet.boards.map((board) => {
            const shownKeys = FLEET_METRICS.filter((key) => Object.hasOwn(board.values, key));
            return h(
              'li',
              { key: board.serial, class: 'row metric-row' },
              h(
                'div',
                { class: 'row-main' },
                board.thing
                  ? h('a', { href: `#/devices/${board.thing}`, class: 'row-title mono' }, board.thing)
                  : h('span', { class: 'row-title mono' }, board.serial),
                shownKeys.length === 0
                  ? h(
                      'span',
                      { class: 'row-note' },
                      board.unnamed > 0
                        ? 'Its heartbeats have no names yet: Memfault lacks the symbols of its build.'
                        : 'None of the key metrics in its heartbeat.'
                    )
                  : h(
                      'dl',
                      { class: 'metric-values' },
                      shownKeys.map((key) =>
                        h(
                          'div',
                          { key, class: 'metric-value' },
                          h('dt', null, metricOf(key).label),
                          h('dd', null, metricText(key, board.values[key]))
                        )
                      )
                    )
              ),
              board.at ? h('span', { class: 'row-value' }, when(board.at, now)) : null
            );
          })
        )
  );
}

/** The fleet's three groups, under the issues: or why they are not there. */
function fleetCards(ctx) {
  const target = ctx.state.memfault?.fleet ?? resource();
  const data = target.value;
  if (!data) {
    return target.error ? loadProblem(target, 'the fleet in Memfault', ctx) : pending(target, 'the fleet');
  }
  return [
    loadProblem(target, 'the fleet in Memfault', ctx),
    rebootCard(data),
    versionCard(data),
    latestCard(data, ctx.state.now),
  ];
}

// A board's metric charts.

/** The range chosen for the charts of a board's page. */
function rangeNow(state) {
  return RANGES.find((one) => one.id === state.memfault?.range) ?? RANGES[0];
}

function chooseRange(id) {
  if (!tools?.state.memfault || !RANGES.some((one) => one.id === id)) return;
  tools.state.memfault.range = id;
  tools.draw();
}

function rangeTools(range) {
  return h(
    'div',
    { class: 'segmented metric-range', role: 'group', 'aria-label': 'Time range', key: 'range' },
    RANGES.map((one) =>
      h(
        'button',
        {
          key: one.id,
          type: 'button',
          class: 'segmented-option',
          'aria-pressed': one.id === range.id ? 'true' : 'false',
          title: `Show ${one.name}`,
          onClick: () => chooseRange(one.id),
        },
        one.label
      )
    )
  );
}

/** One metric's chart over the range, in its unit, with its known scale or one made to fit. */
function metricChart(ctx, thing, key, all, span) {
  const metric = metricOf(key);
  const points = all
    .filter((point) => point.ms >= span.fromMs && point.ms <= span.toMs)
    .map((point) => ({ ms: point.ms, v: shown(key, point.v) }));
  const values = points.length > 0 ? points.map((point) => point.v) : all.map((point) => shown(key, point.v));
  const { yMin, yMax, yTicks } = metric.fixed
    ? { yMin: metric.fixed[0], yMax: metric.fixed[1], yTicks: metric.fixed[2] }
    : niceScale(values, { zero: metric.zero !== false });
  return lineChart(ctx, {
    key: `memfault-${thing}-${key}`,
    title: metric.label,
    unit: metric.unit,
    axisUnit: metric.axis,
    points,
    fromMs: span.fromMs,
    toMs: span.toMs,
    yMin,
    yMax,
    yTicks,
    refs: metric.refs ?? [],
    format: metric.format,
    tickFormat: metric.tick ?? ((value) => value.toLocaleString('en-US', { maximumFractionDigits: 2 })),
    // A heartbeat each hour: a line breaks where more than two are missing.
    gapMs: 2.5 * HOUR_MS,
    words: metric.words,
    describe: `${key} from the hourly Memfault heartbeat`,
    emptyText: `No heartbeat in ${span.name}.`,
  });
}

/** The keys a board sent, by group, in the order of the catalogue and then by name. */
export function groupedKeys(keys) {
  const order = Object.keys(METRICS);
  const rank = (key) => (order.includes(key) ? order.indexOf(key) : order.length);
  return GROUPS.map(([id, title]) => ({
    id,
    title,
    keys: keys.filter((key) => metricOf(key).group === id).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1)),
  })).filter((group) => group.keys.length > 0);
}

/**
 * The Memfault metrics of a board's page: a chart of each key its heartbeats had in the week, grouped,
 * over the last 24 hours or 7 days.
 */
export function metricsSection(thing, ctx) {
  const target = ctx.state.memfault?.boards.get(thing) ?? null;
  if (target === null) return null;
  const data = target.value;
  if (!data || data.memfault.state !== 'ok' || !data.known) {
    // The card "In Memfault" says why there is nothing; this one waits for the data.
    if (data || target.error) return null;
    return card(
      { key: 'memfault-metrics', title: 'Memfault metrics', className: 'memfault-metrics' },
      loading('the metrics')
    );
  }
  const range = rangeNow(ctx.state);
  const toMs = Date.parse(data.to ?? '') || ctx.state.now;
  const span = { fromMs: toMs - range.hours * HOUR_MS, toMs, name: range.name };
  const keys = Object.keys(data.metrics.series);
  const unnamed =
    data.metrics.unnamed > 0
      ? h(
          'p',
          { class: 'ui-card-note card-note', key: 'unnamed' },
          `${plural(data.metrics.unnamed, 'heartbeat', 'heartbeats')} of the week came without names: Memfault lacks the symbols of their build.`
        )
      : null;
  return card(
    { key: 'memfault-metrics', title: 'Memfault metrics', className: 'memfault-metrics' },
    h(
      'div',
      { class: 'metric-head', key: 'head' },
      rangeTools(range),
      h('span', { class: 'quiet' }, 'From the hourly heartbeat')
    ),
    keys.length === 0
      ? h('p', { class: 'quiet', key: 'none' }, 'No heartbeat with metrics in the last 7 days.')
      : groupedKeys(keys).map((group) =>
          h(
            'div',
            { class: 'metric-group', key: group.id },
            h('h3', { class: 'card-sub' }, group.title),
            h(
              'div',
              { class: 'metric-charts' },
              group.keys.map((key) => metricChart(ctx, thing, key, data.metrics.series[key], span))
            )
          )
        ),
    unnamed
  );
}
