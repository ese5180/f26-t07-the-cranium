/**
 * The Events and Diagnostics pages: what every board did over time, and how each board is
 * doing now. The script is fetched when one of the two is opened (app.js), so the console
 * loads no faster or slower for them.
 *
 * Both read what the recorder in the cloud made of the boards' reports (cloud/api/src/
 * lib/events.mjs): events, and readings of the signal and the memory. The Events page adds
 * the console's own activity log as a lane of its own, and the boards' own log (cloud/api/src/
 * lib/lines.mjs, firmware 1.12.0 and later): every line a board prints on its serial console, in a
 * list of its own, with a tick for each at the foot of its board's lane, so that the markers of the
 * events stay as few as they were.
 *
 * The charts are drawn here, as SVG with the console's own renderer: no library, no canvas,
 * and no inline style, only custom properties and attributes. How they look follows one
 * method throughout:
 *
 *  - Event markers take one of three hues by family (the update path, people, the board's
 *    health) and a shape by kind. With markers that can sit next to each other in any
 *    pairing, three hues are the most that every reader tells apart (checked with a colour
 *    validator for both themes); the shape tells the kinds within a family apart, and the
 *    legend, the tooltip and the table name every one in words. Connections are grey: they
 *    are the edges of the online band, which carries them.
 *  - A line chart has one series and one axis. Its line is 2 px with a faint wash below,
 *    the grid is a hairline, the latest value is written at the end, and a crosshair with a
 *    readout follows the pointer and the arrow keys. Every chart has a table beside it.
 *
 * No dependencies beyond the console's own two modules.
 */

import {
  EVENT_KINDS,
  LINE_KINDS,
  LINE_TAGS,
  auditSentence,
  boardName,
  boardOf,
  cleanSearch,
  clockTime,
  dateAndTime,
  dayLabel,
  describeAudit,
  describeUpdate,
  deploymentHref,
  duration,
  exactTime,
  fileSize,
  isThing,
  plural,
  readFilters,
  routeHash,
  signalQuality,
  timeAgo,
  timeOfDay,
} from './core.js';
import {
  NO_BOARDS,
  badge,
  boardLabel,
  boardThing,
  button,
  card,
  empty,
  factNote,
  facts,
  failure,
  filterBar,
  thingId,
  filterSelect,
  freshness,
  h,
  icon,
  linkTo,
  loadProblem,
  loading,
  meter,
  mono,
  pageHead,
  pending,
  presence,
  signalBars,
  statusLine,
  when,
} from './views.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const PRESETS = Object.freeze([
  { id: '1h', label: '1 h', ms: HOUR, name: 'the last hour' },
  { id: '6h', label: '6 h', ms: 6 * HOUR, name: 'the last 6 hours' },
  { id: '24h', label: '24 h', ms: DAY, name: 'the last 24 hours' },
  { id: '7d', label: '7 d', ms: 7 * DAY, name: 'the last 7 days' },
  { id: '30d', label: '30 d', ms: 30 * DAY, name: 'the last 30 days' },
]);
const LONGEST_RANGE = 31 * DAY;
const SHORTEST_ZOOM = MINUTE;
export const EVENTS_REFRESH_MS = 15_000;
export const DIAGNOSTICS_REFRESH_MS = 10_000;
const SAMPLES_REFRESH_MS = 60_000;
const DETAILS_REFRESH_MS = 5 * MINUTE;
// How much of the activity log the Console lane reads: enough for a month of a small team.
const AUDIT_PAGE = 100;
const AUDIT_PAGES = 5;
// Up to this many boards each get a card; with more, one at a time and a list to pick from.
export const CARDS_AT_ONCE = 3;
// A board counts as online for this long after a heartbeat (cloud/api/src/lib/shadow.mjs).
const ONLINE_WINDOW_MS = 90_000;
// Diagnostics reports come from this firmware on; the boot diary from 1.7.4.
const DIAG_FROM = [1, 10, 0];
const DIARY_FROM = [1, 7, 4];
// Below this share of the heap free, memory is short (the recorder warns at the same line).
export const LOW_HEAP_SHARE = 0.15;
const TIGHT_HEAP_SHARE = 0.3;

function resource() {
  return { value: null, error: null, loadedAt: 0, loading: false };
}

const iso = (ms) => new Date(ms).toISOString();
const signed = (number) => (number < 0 ? `−${Math.abs(number)}` : String(number));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// The look of each kind of event: a family hue and a shape. In the order of the legend.

export const KINDS = Object.freeze([
  { id: 'update', label: 'Update', shape: 'circle', tone: 'a' },
  { id: 'firmware', label: 'Firmware', shape: 'square', tone: 'a' },
  { id: 'restart', label: 'Restart', shape: 'diamond', tone: 'c' },
  { id: 'health', label: 'Wi-Fi and memory', shape: 'down', tone: 'c' },
  { id: 'bluetooth', label: 'Bluetooth', shape: 'up', tone: 'b' },
  { id: 'console', label: 'Console', shape: 'ring', tone: 'b' },
  // Lines of the board log only: a setting changed at a board's serial console, and the rest.
  { id: 'setting', label: 'Settings', shape: 'plus', tone: 'b' },
  { id: 'log', label: 'Other lines', shape: 'dot', tone: 'quiet' },
  { id: 'connection', label: 'Connection', shape: 'bar', tone: 'quiet' },
]);

export function kindOf(id) {
  return KINDS.find((kind) => kind.id === id) ?? KINDS[0];
}

/** The shape of a kind, drawn around 0,0 in about 12 px. */
function glyph(shape) {
  switch (shape) {
    case 'square':
      return h('rect', { class: 'glyph', x: '-4.5', y: '-4.5', width: '9', height: '9', rx: '1.5' });
    case 'diamond':
      return h('path', { class: 'glyph', d: 'M0 -6.2L6.2 0L0 6.2L-6.2 0Z' });
    case 'up':
      return h('path', { class: 'glyph', d: 'M0 -6L5.8 4.6H-5.8Z' });
    case 'down':
      return h('path', { class: 'glyph', d: 'M0 6L5.8 -4.6H-5.8Z' });
    case 'ring':
      return h('circle', { class: 'glyph is-ring', r: '4.4' });
    case 'bar':
      return h('rect', { class: 'glyph', x: '-1.6', y: '-7', width: '3.2', height: '14', rx: '1.6' });
    case 'plus':
      return h('path', { class: 'glyph', d: 'M-1.8 -6H1.8V-1.8H6V1.8H1.8V6H-1.8V1.8H-6V-1.8H-1.8Z' });
    case 'dot':
      return h('circle', { class: 'glyph', r: '3.2' });
    default:
      return h('circle', { class: 'glyph', r: '5' });
  }
}

/** A kind's mark on its own, for a legend, a tooltip or a row of the table. */
function swatch(id) {
  const kind = kindOf(id);
  return h(
    'svg',
    {
      class: `swatch is-${kind.tone}`,
      viewBox: '-8 -8 16 16',
      width: '16',
      height: '16',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    glyph(kind.shape)
  );
}

// Times and ranges.

/** The span a range stands for now: { fromMs, toMs, live }. A preset ends now and moves with it. */
export function rangeOf(range, nowMs) {
  const preset = PRESETS.find((item) => item.id === range?.preset);
  if (preset) return { fromMs: nowMs - preset.ms, toMs: nowMs, live: true, preset };
  return { fromMs: range.fromMs, toMs: range.toMs, live: false, preset: null };
}

/** The words for a range, for the line above the chart and for its accessible name. */
export function rangeWords(span) {
  if (span.preset) return `${span.preset.name}, up to now`;
  return `${dateAndTime(iso(span.fromMs))} to ${dateAndTime(iso(span.toMs))}`;
}

/** Where a time lies across a span, as a percentage from 0 to 100. */
export function place(ms, fromMs, toMs) {
  return clamp(((ms - fromMs) / (toMs - fromMs)) * 100, 0, 100);
}

const percent = (value) => `${Math.round(value * 100) / 100}%`;

const STEPS = [
  MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
];

/**
 * The ticks of a time axis: at most `most`, on whole steps of local time (the hour, midnight),
 * each with a label. Where a day begins the label is the day.
 */
export function timeTicks(fromMs, toMs, most = 7) {
  const span = toMs - fromMs;
  const step = STEPS.find((candidate) => span / candidate <= most) ?? 7 * DAY;
  // Counted on the local clock, from the local midnight before the range: a day with a change
  // of daylight saving time has 23 or 25 hours, and the ticks still fall on 00:00, 06:00, ...
  const start = new Date(fromMs);
  const [year, month, day] = [start.getFullYear(), start.getMonth(), start.getDate()];
  const local = (index) =>
    step >= DAY
      ? new Date(year, month, day + index * (step / DAY)).getTime()
      : new Date(year, month, day, 0, index * (step / MINUTE)).getTime();
  let index = 0;
  while (local(index) < fromMs) index += 1;
  const ticks = [];
  for (let at = local(index); at <= toMs && ticks.length < most + 1; index += 1, at = local(index)) {
    const date = new Date(at);
    const newDay = date.getHours() === 0 && date.getMinutes() === 0;
    let label = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (step >= DAY) label = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    else if (newDay) label = date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    ticks.push({ ms: at, label, newDay });
  }
  return ticks;
}

/** A local date and time as a datetime-local field writes it. */
export function localInput(ms) {
  const date = new Date(ms);
  const two = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

/**
 * The range a person typed into the two fields: { fromMs, toMs } or { error }. The fields
 * hold local times.
 */
export function customRange(fromText, toText, nowMs) {
  const read = (text) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text ?? '') ? new Date(text).getTime() : NaN);
  const fromMs = read(fromText);
  const toMs = Math.min(read(toText), nowMs);
  if (!Number.isFinite(fromMs) || !Number.isFinite(read(toText)))
    return { error: 'Give a start and an end, both with a date and a time.' };
  if (!(fromMs < toMs)) return { error: 'The start has to be before the end, and before now.' };
  if (toMs - fromMs > LONGEST_RANGE) return { error: 'A range can be at most 31 days long.' };
  return { fromMs, toMs };
}

// Lanes and what is in them.

/** A key for an event that holds only letters, digits and dashes, and stays the same from one load to the next. */
export function eventKey(event) {
  const owner = event.thing ? event.thing.slice(-8) : 'console';
  return `${owner}-${Date.parse(event.at)}-${String(event.id).replace(/[^A-Za-z0-9]/g, '_')}`;
}

/** An entry of the activity log as an event of the Console lane. Boards are called what `devices` calls them. */
export function consoleEvent(entry, devices = []) {
  const description = describeAudit(entry);
  const what = auditSentence(entry, devices);
  return {
    thing: null,
    at: entry.at,
    id: entry.requestId || '0',
    kind: 'console',
    what: entry.action,
    level: entry.outcome === 'ok' ? 'info' : 'warn',
    text: description.outcome ? `${what} (${description.outcome.label.toLowerCase()})` : what,
    href: description.href,
  };
}

/**
 * The lanes of the timeline: one per board, in the order of their thing names, and the
 * Console lane last. Every board of the group has one, also without events; a board that
 * has events and is no longer in the list keeps its lane for them. A lane is labelled with
 * what the board is called (boardName in core.js), and `thing` is its thing name.
 */
export function lanesOf({ events, devices, thing = '', consoleEvents = null }) {
  const names = thing
    ? [thing]
    : [...new Set([...devices.map((device) => device.thing), ...events.map((event) => event.thing)])]
        .filter(isThing)
        .sort();
  const lanes = names.map((name) => ({
    id: name,
    thing: name,
    label: boardName(boardOf(name, devices)),
    device: devices.find((device) => device.thing === name) ?? null,
    events: events.filter((event) => event.thing === name),
  }));
  if (consoleEvents !== null)
    lanes.push({ id: 'console', thing: null, label: 'Console', device: null, events: consoleEvents });
  return lanes;
}

/**
 * When a board was online within the range, as [{ fromMs, toMs, inferred }], from its
 * connected and disconnected events. Before the first of them it was the opposite of what
 * the first says. With none in the range, a range that ends now goes by the board's
 * heartbeat; an older one shows nothing, because nothing is known. A board that went quiet
 * without a disconnect ends its band when its heartbeat stopped counting. `inferred` marks
 * a band that the heartbeat says and no connection event does.
 */
export function onlineBands(events, { fromMs, toMs, device = null, live = false }) {
  const changes = events
    .filter((event) => event.kind === 'connection')
    .map((event) => ({ ms: Date.parse(event.at), up: event.what === 'connected' }))
    .filter((change) => Number.isFinite(change.ms))
    .sort((a, b) => a.ms - b.ms);
  const heard = live && device?.lastSeen ? Date.parse(device.lastSeen) : NaN;
  const bands = [];
  let up = changes.length > 0 ? !changes[0].up : live && device?.online === true;
  let since = fromMs;
  for (const change of changes) {
    if (change.up && !up) {
      up = true;
      since = change.ms;
    } else if (!change.up && up) {
      bands.push({ fromMs: since, toMs: change.ms, inferred: false });
      up = false;
    }
  }
  if (up) {
    // Still connected when the range ends, unless its heartbeat has stopped since.
    const end =
      live && device && !device.online && Number.isFinite(heard) ? Math.min(toMs, heard + ONLINE_WINDOW_MS) : toMs;
    bands.push({ fromMs: since, toMs: end, inferred: false });
  } else if (live && device?.online && changes.length > 0) {
    // Connected now, with no event to say since when: from its last disconnection, as far as is known.
    bands.push({ fromMs: changes[changes.length - 1].ms, toMs, inferred: true });
  }
  return bands
    .map((band) => ({ ...band, fromMs: clamp(band.fromMs, fromMs, toMs), toMs: clamp(band.toMs, fromMs, toMs) }))
    .filter((band) => band.toMs > band.fromMs);
}

/** Events newest first, the kinds that are switched off left out. */
export function shownEvents(lanes, hidden) {
  return lanes
    .flatMap((lane) => lane.events)
    .filter((event) => !hidden.has(event.kind))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (eventKey(a) < eventKey(b) ? 1 : -1));
}

/**
 * Events that would be drawn on top of each other become one spot. Each spot is
 * { key, at, ms, x, events, lead }: the newest event's key and time, where the spot is drawn
 * (the middle of its events, as a percentage), every event of it newest first, and the one
 * that stands for it (a warning first, else the newest). A spot takes in the events within
 * `reachPx` pixels of its first, on a plot `widthPx` wide; the spots are newest first.
 */
export function spotsOf(events, { fromMs, toMs }, widthPx = 1000, reachPx = 14) {
  const oldestFirst = [...events].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || (eventKey(a) < eventKey(b) ? -1 : 1)
  );
  const groups = [];
  let anchor = -Infinity;
  for (const event of oldestFirst) {
    const x = place(Date.parse(event.at), fromMs, toMs);
    if (groups.length > 0 && ((x - anchor) / 100) * widthPx <= reachPx) groups[groups.length - 1].push(event);
    else {
      anchor = x;
      groups.push([event]);
    }
  }
  return groups
    .map((group) => {
      const newestFirst = group.reverse();
      const x =
        newestFirst.reduce((sum, event) => sum + place(Date.parse(event.at), fromMs, toMs), 0) / newestFirst.length;
      return {
        key: eventKey(newestFirst[0]),
        at: newestFirst[0].at,
        ms: Date.parse(newestFirst[0].at),
        x,
        events: newestFirst,
        lead: newestFirst.find((event) => event.level === 'warn') ?? newestFirst[0],
      };
    })
    .reverse();
}

// Words for what a board reports.

const CAUSE_WORDS = {
  pin: 'the reset pin',
  software: 'a software restart',
  brownout: 'a brownout',
  power_on: 'a loss of power',
  watchdog: 'the watchdog',
  debugger: 'the debugger',
  security: 'a security reset',
  wake: 'a wake from off',
  lockup: 'a CPU lockup',
  parity: 'a parity error',
  pll: 'a clock fault',
  clock: 'a clock fault',
  hardware: 'a hardware reset',
  user: 'a user reset',
  temperature: 'a temperature reset',
  unknown: 'an unknown cause',
};
const BAD_CAUSES = new Set([
  'brownout',
  'watchdog',
  'lockup',
  'security',
  'parity',
  'pll',
  'clock',
  'hardware',
  'temperature',
]);
const STAGE_WORDS = {
  0: 'Did not start its program',
  1: 'Started its program',
  2: 'Started its update manager',
  3: 'Got onto the network',
  4: 'Reached the cloud',
};
const STUCK_WORDS = {
  wifi_silent: 'the Wi-Fi chip stopped answering',
  no_cloud: 'no connection to the cloud for 15 minutes',
  update_stall: 'an update stopped moving',
};
const BT_WORDS = {
  pending: 'Waiting to be proved',
  succeeded: 'Succeeded',
  rolled_back: 'Rolled back',
  not_installed: 'Not installed',
  trial_lost: 'Lost its trial',
  superseded: 'Replaced by a cloud update',
  flash_error: 'Could not be written to flash',
  incompatible_board: 'Refused: the image is for another board',
  incompatible_layout: 'Refused: the image is for another flash layout',
};
const PROOF_WORDS = { person: 'Kept by a person at the board', cloud: 'Proved by the cloud', none: 'Not proved' };

/** Why a boot ended, in words: "the watchdog", "a brownout and a CPU lockup". */
export function causeWords(causes) {
  const words = [...new Set((causes ?? []).map((cause) => CAUSE_WORDS[cause] ?? CAUSE_WORDS.unknown))];
  return words.length > 0 ? words.join(' and ') : CAUSE_WORDS.unknown;
}

export function stageWords(stage) {
  return STAGE_WORDS[stage] ?? `Stage ${stage}`;
}

/** The boot diary as table rows, newest first: each boot, why the one before it ended, and how far each got. */
export function diaryRows(diary) {
  if (!diary) return [];
  return diary.entries.map((entry, index) => ({
    boot: diary.boots - index,
    version: entry.version,
    ended: index === 0 ? null : stageWords(entry.stage),
    running: index === 0,
    reached: stageWords(entry.stage),
    before: causeWords(entry.causes),
    bad: entry.causes.some((cause) => BAD_CAUSES.has(cause)),
  }));
}

export function stuckWords(stuck) {
  if (!stuck) return null;
  if (stuck.count === 0) return { tone: 'good', text: 'Has not had to restart itself for being stuck' };
  const why = STUCK_WORDS[stuck.reason] ?? `reason ${stuck.reason}`;
  return stuck.count === 1
    ? { tone: 'warn', badge: 'Once', text: `Restarted itself once for being stuck, because ${why}` }
    : {
        tone: 'warn',
        badge: `${stuck.count} in a row`,
        text: `Restarted itself ${stuck.count} times in a row for being stuck; the last time because ${why}`,
      };
}

/**
 * How much memory is free, as words and a tone for the bar. The tone is for what is free now;
 * that it ran low earlier in this boot is said beside it (`ranLow`).
 */
export function heapWords(heap) {
  if (!heap) return null;
  const share = heap.free / heap.size;
  const leastShare = heap.least / heap.size;
  let tone = 'live';
  if (share < LOW_HEAP_SHARE) tone = 'bad';
  else if (share < TIGHT_HEAP_SHARE) tone = 'warn';
  return {
    tone,
    ranLow: leastShare < LOW_HEAP_SHARE,
    used: Math.round((1 - share) * 100),
    leastUsed: Math.round((1 - leastShare) * 100),
    text: `${fileSize(heap.free)} free of ${fileSize(heap.size)}`,
    least: `At least ${fileSize(heap.least)} has stayed free since it started (${Math.round(leastShare * 100)}%)`,
  };
}

function versionAtLeast(version, [major, minor, revision]) {
  const match = /^(\d+)\.(\d+)\.(\d+)\+/.exec(version ?? '');
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (const [index, need] of [major, minor, revision].entries()) {
    if (parts[index] !== need) return parts[index] > need;
  }
  return true;
}

/** Why a board shows no diagnostics report: plainly, by its firmware. */
export function diagMissing(device) {
  const version = device.fw?.version ?? null;
  if (version && !versionAtLeast(version, DIAG_FROM)) {
    return `Needs firmware 1.10.0 or later. This board runs ${version}.`;
  }
  if (!version) return 'Needs firmware 1.10.0 or later. This board has not said what it runs.';
  return 'No diagnostics report yet. A board on 1.10.0 or later sends one when it connects and every 5 minutes.';
}

export function diaryMissing(device) {
  const version = device.fw?.version ?? null;
  if (version && !versionAtLeast(version, DIARY_FROM))
    return `Needs firmware 1.7.4 or later. This board runs ${version}.`;
  return 'No boot diary yet. A board on 1.7.4 or later sends it when it connects.';
}

/** "12 s ago" to the second for the first two minutes, then as the rest of the console says it. */
export function heartbeatAge(lastSeen, nowMs) {
  const seconds = Math.floor((nowMs - Date.parse(lastSeen)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 120) return `${Math.max(0, seconds)} s ago`;
  return timeAgo(lastSeen, nowMs);
}

/** The uptime now, counted on from the last heartbeat while the board is online. */
export function uptimeNow(device, nowMs) {
  if (device.uptime === null) return null;
  if (!device.online || !device.lastSeen) return device.uptime;
  return device.uptime + Math.max(0, Math.floor((nowMs - Date.parse(device.lastSeen)) / 1000));
}

// Readings.

/**
 * A series as runs of points that belong together: a gap longer than `gapMs` between two
 * readings breaks the line, because the board was not reporting then.
 */
export function lineRuns(points, gapMs) {
  const runs = [];
  let run = [];
  for (const point of points) {
    if (run.length > 0 && point.ms - run[run.length - 1].ms > gapMs) {
      runs.push(run);
      run = [];
    }
    run.push(point);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** The longest gap between readings that still counts as reporting, for points `bucketSeconds` apart. */
export function gapFor(bucketSeconds) {
  return Math.max(150_000, 2.5 * bucketSeconds * 1000);
}

/** The readings of one field as points { ms, v }, oldest first; readings without it are left out. */
export function pointsOf(samples, field) {
  return samples
    .filter((sample) => Number.isFinite(sample[field]))
    .map((sample) => ({ ms: Date.parse(sample.at), v: sample[field] }))
    .filter((point) => Number.isFinite(point.ms));
}

/** The readings of each hour, for a chart's table: its lowest, mean and highest. */
export function hourlyRows(points) {
  const hours = new Map();
  for (const point of points) {
    const start = new Date(point.ms);
    start.setMinutes(0, 0, 0);
    const key = start.getTime();
    if (!hours.has(key)) hours.set(key, []);
    hours.get(key).push(point.v);
  }
  return [...hours.entries()]
    .sort(([a], [b]) => b - a)
    .map(([ms, values]) => ({
      ms,
      low: Math.min(...values),
      mean: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
      high: Math.max(...values),
      count: values.length,
    }));
}

/** The index of the point nearest a time. */
function nearest(points, ms) {
  let best = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (Math.abs(points[index].ms - ms) < Math.abs(points[best].ms - ms)) best = index;
  }
  return best;
}

// The page's state, and what it does. app.js hands over its tools once.

let tools = null;
// Charts under the pointer or the keyboard, by key: the index of the point read out. A chart
// that the keyboard moves in also says the value to a screen reader; the pointer does not.
const chartReadouts = new Map();
const keyboardCharts = new Set();
// A drag across the timeline that may become a zoom.
let dragging = null;
let justDragged = false;

export function connect(given) {
  tools = given;
}

// The range chosen last is this browser's: the next visit opens on it.
const RANGE_KEY = 'cranium.events.range';

function rememberedPreset() {
  try {
    const stored = globalThis.localStorage?.getItem(RANGE_KEY);
    return PRESETS.some((preset) => preset.id === stored) ? stored : '24h';
  } catch {
    return '24h';
  }
}

function rememberPreset(id) {
  try {
    globalThis.localStorage?.setItem(RANGE_KEY, id);
  } catch {
    // A browser that keeps nothing still shows the range it was given.
  }
}

function eventsPage(state) {
  state.eventLog ??= {
    range: { preset: rememberedPreset() },
    zooms: [],
    thing: '',
    hidden: new Set(),
    // The board log: shown or not, and the one source it is narrowed to ('' for all of them).
    log: true,
    tag: '',
    data: resource(),
    more: { loading: false, error: null },
    linesMore: { loading: false, error: null },
    selected: null,
    focused: null,
    hovered: null,
    drag: null,
    custom: null,
    // The search and the level asked of the server (docs/search-filters.md), and the range the address
    // named last: a range chosen by zooming or by Custom… is the page's own, and stays until the address changes it.
    q: '',
    level: '',
    addressRange: '',
  };
  return state.eventLog;
}

/**
 * Take the page's filters from the address (state.filters.events, app.js): the board, the kinds hidden, the
 * source of the board log, warnings only, the search, and a range preset when the address names a new one.
 */
export function followFilters(state) {
  const page = eventsPage(state);
  const filters = { ...readFilters('events'), ...state.filters?.events };
  page.thing = filters.board;
  page.hidden = new Set(filters.hide.split(',').filter(Boolean));
  page.tag = filters.tag;
  page.level = filters.level;
  page.q = cleanSearch(filters.q ?? '');
  if (filters.range !== page.addressRange) {
    page.addressRange = filters.range;
    if (filters.range) {
      page.range = { preset: filters.range };
      page.zooms = [];
    }
  }
  return page;
}

/** Whether a search or the level narrows what the server sends: the online bands are then not whole. */
function searched(page) {
  return page.q !== '' || page.level !== '';
}

function diagnosticsPage(state) {
  state.diagnostics ??= { samples: new Map(), details: new Map() };
  return state.diagnostics;
}

/**
 * The entries of the activity log within a span, newest first, with the search if there is one:
 * { entries, cut }. The server reads the span as a range of the log's key (GET /api/audit?from=&to=).
 */
async function consoleEntries(api, fromMs, toMs, q = '') {
  const entries = [];
  let before = null;
  for (let page = 0; page < AUDIT_PAGES; page += 1) {
    const read = await api.audit({
      limit: AUDIT_PAGE,
      before,
      from: iso(fromMs),
      to: iso(toMs),
      ...(q ? { q } : {}),
    });
    for (const entry of read.entries) {
      const ms = Date.parse(entry.at);
      if (ms >= fromMs && ms <= toMs) entries.push(entry);
    }
    if (!read.next) return { entries, cut: false };
    before = read.next;
  }
  return { entries, cut: true };
}

/**
 * The board log of the range, as the page shows it: { lines, cursor, query, pages }, { error }
 * when it could not be read, which leaves the events as they are, or null while it is hidden.
 */
async function boardLogOf(api, page, span) {
  if (!page.log) return null;
  const kinds = LINE_KINDS.filter((kind) => !page.hidden.has(kind));
  const query = { from: iso(span.fromMs), to: iso(span.toMs), thing: page.thing || null };
  if (kinds.length < LINE_KINDS.length) query.kinds = kinds;
  if (page.tag) query.tags = [page.tag];
  if (page.q) query.q = page.q;
  if (page.level) query.level = page.level;
  if (kinds.length === 0) return { lines: [], cursor: null, query, pages: 1 };
  try {
    const read = await api.boardLog(query);
    return { lines: read.lines, cursor: read.cursor, query, pages: 1 };
  } catch (error) {
    return { error };
  }
}

/** What the Events page reads: the boards' events of the range, the Console lane, and the board log. */
export async function refreshEvents(full) {
  const { state, api, load, clock } = tools;
  const page = followFilters(state);
  const span = rangeOf(page.range, clock.now());
  // Connections are read even while their markers are hidden: the online bands are drawn from them.
  const kinds = EVENT_KINDS.filter((kind) => kind === 'connection' || !page.hidden.has(kind));
  const query = { from: iso(span.fromMs), to: iso(span.toMs), thing: page.thing || null };
  if (kinds.length < EVENT_KINDS.length) query.kinds = kinds;
  if (page.q) query.q = page.q;
  if (page.level) query.level = page.level;
  // The Console lane has no warnings: it is left out while only warnings are asked for.
  const consoleLane = !page.hidden.has('console') && page.level !== 'warn';
  const devicesDue = full || state.devices.loadedAt === 0 || clock.now() - state.devices.loadedAt > 25_000;
  await Promise.all([
    load(page.data, async () => {
      const [read, audit, log] = await Promise.all([
        kinds.length === 0 ? { events: [], cursor: null } : api.events(query),
        consoleLane ? consoleEntries(api, span.fromMs, span.toMs, page.q) : null,
        boardLogOf(api, page, span),
      ]);
      page.more = { loading: false, error: null };
      page.linesMore = { loading: false, error: null };
      return { events: read.events, cursor: read.cursor, query, span, audit, log, pages: 1, searched: searched(page) };
    }),
    devicesDue ? load(state.devices, api.devices) : null,
  ]);
}

async function loadMoreEvents() {
  const { state, api, draw } = tools;
  const page = eventsPage(state);
  const value = page.data.value;
  if (!value?.cursor || page.more.loading) return;
  page.more = { loading: true, error: null };
  draw();
  try {
    const next = await api.events({ ...value.query, cursor: value.cursor });
    page.data.value = {
      ...value,
      events: value.events.concat(next.events),
      cursor: next.cursor,
      pages: value.pages + 1,
    };
    page.more = { loading: false, error: null };
  } catch (error) {
    page.more = { loading: false, error };
  }
  draw();
}

async function loadMoreLines() {
  const { state, api, draw } = tools;
  const page = eventsPage(state);
  const value = page.data.value;
  const log = value?.log;
  if (!log?.cursor || page.linesMore.loading) return;
  page.linesMore = { loading: true, error: null };
  draw();
  try {
    const next = await api.boardLog({ ...log.query, cursor: log.cursor });
    page.data.value = {
      ...value,
      log: { ...log, lines: log.lines.concat(next.lines), cursor: next.cursor, pages: log.pages + 1 },
    };
    page.linesMore = { loading: false, error: null };
  } catch (error) {
    page.linesMore = { loading: false, error };
  }
  draw();
}

export function eventsInterval(state) {
  const page = eventsPage(state);
  return rangeOf(page.range, 0).live ? EVENTS_REFRESH_MS : 0;
}

/** A refresh would take away pages loaded by hand, or a drag under way. */
export function eventsHoldStill(state) {
  const page = eventsPage(state);
  return (
    page.more.loading ||
    page.linesMore.loading ||
    (page.data.value?.pages ?? 1) > 1 ||
    (page.data.value?.log?.pages ?? 1) > 1 ||
    page.drag !== null
  );
}

export function eventsResources(state) {
  return [eventsPage(state).data, state.devices];
}

/** What the Diagnostics page reads: the boards every 10 s, their readings every minute, their certificates now and then. */
export async function refreshDiagnostics(full) {
  const { state, api, load, clock } = tools;
  const page = diagnosticsPage(state);
  await load(state.devices, api.devices);
  const devices = state.devices.value?.devices ?? [];
  const shown = shownBoards(devices, state.route.thing);
  const due = (target, every) => full || target.loadedAt === 0 || clock.now() - target.loadedAt >= every - 2000;
  const entry = (map, key) => {
    if (!map.has(key)) map.set(key, resource());
    return map.get(key);
  };
  await Promise.all(
    shown.flatMap((device) => {
      const samples = entry(page.samples, device.thing);
      const details = entry(page.details, device.thing);
      return [
        due(samples, SAMPLES_REFRESH_MS) ? load(samples, () => api.samples(device.thing, 24)) : null,
        due(details, DETAILS_REFRESH_MS) ? load(details, () => api.device(device.thing)) : null,
      ];
    })
  );
}

export function diagnosticsResources(state) {
  return [state.devices];
}

/** The boards that get a card: the one in the address, every one when there are few, else the first. */
export function shownBoards(devices, thing) {
  if (thing) return devices.filter((device) => device.thing === thing);
  return devices.length <= CARDS_AT_ONCE ? devices : devices.slice(0, 1);
}

// What a person does on the Events page.

function changeRange(range) {
  const page = eventsPage(tools.state);
  page.range = range;
  page.selected = null;
  page.focused = null;
  page.custom = null;
  tools.refresh();
}

function choosePreset(id) {
  rememberPreset(id);
  const page = eventsPage(tools.state);
  page.zooms = [];
  page.range = { preset: id };
  page.selected = null;
  page.focused = null;
  page.custom = null;
  // The address says it, and the page is read again from there.
  tools.setFilter('events', 'range', id);
}

function zoomTo(fromMs, toMs) {
  const page = eventsPage(tools.state);
  page.zooms.push(page.range);
  changeRange({ fromMs, toMs });
}

function zoomOut() {
  const page = eventsPage(tools.state);
  changeRange(page.zooms.pop() ?? { preset: '24h' });
}

function openCustom() {
  const page = eventsPage(tools.state);
  const span = rangeOf(page.range, tools.clock.now());
  page.custom = { from: localInput(span.fromMs), to: localInput(span.toMs), error: null };
  tools.draw();
}

function applyCustom(event) {
  event?.preventDefault?.();
  const page = eventsPage(tools.state);
  const chosen = customRange(page.custom?.from, page.custom?.to, tools.clock.now());
  if (chosen.error) {
    page.custom = { ...page.custom, error: chosen.error };
    tools.draw();
    return;
  }
  page.zooms = [];
  changeRange({ fromMs: chosen.fromMs, toMs: chosen.toMs });
}

function toggleLog() {
  const page = eventsPage(tools.state);
  page.log = !page.log;
  tools.refresh();
}

function chooseTag(tag) {
  tools.setFilter('events', 'tag', LINE_TAGS.includes(tag) ? tag : '');
}

function toggleKind(id) {
  const page = eventsPage(tools.state);
  const hidden = new Set(page.hidden);
  if (hidden.has(id)) hidden.delete(id);
  else hidden.add(id);
  page.hidden = hidden;
  page.selected = null;
  tools.setFilter('events', 'hide', [...hidden].join(','));
}

/** Pick an event, from its marker or its row; the other one follows. Again: let it go. */
function select(key, { from }) {
  const page = eventsPage(tools.state);
  page.selected = page.selected === key ? null : key;
  page.focused = key;
  tools.draw();
  if (page.selected === null) return;
  // The row comes into view when the marker was picked; the marker is always in view.
  if (from === 'marker') {
    queueMicrotask(() => document.getElementById?.(`event-row-${key}`)?.scrollIntoView?.({ block: 'nearest' }));
  }
}

// The timeline.

const AXIS = 24;
const LANE_HEAD = 22;
const TRACK = 44;
const LANE_GAP = 16;
const LANE = LANE_HEAD + TRACK + LANE_GAP;

/** Move the keyboard from one marker to the next: along a lane, or to the nearest in the next lane. */
function markerKeys(event, lanes, laneIndex, index) {
  const lane = lanes[laneIndex];
  let target = null;
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    // The lane's events are newest first; to the right is newer.
    target = lane.clusters[index + (event.key === 'ArrowRight' ? -1 : 1)] ?? null;
  } else if (event.key === 'Home') {
    target = lane.clusters[lane.clusters.length - 1] ?? null;
  } else if (event.key === 'End') {
    target = lane.clusters[0] ?? null;
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const step = event.key === 'ArrowUp' ? -1 : 1;
    const at = Date.parse(lane.clusters[index].at);
    for (let other = laneIndex + step; other >= 0 && other < lanes.length && target === null; other += step) {
      const candidates = lanes[other].clusters;
      if (candidates.length > 0) {
        target = candidates.reduce(
          (best, item) => (Math.abs(Date.parse(item.at) - at) < Math.abs(Date.parse(best.at) - at) ? item : best),
          candidates[0]
        );
      }
    }
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    select(lane.clusters[index].key, { from: 'marker' });
    return;
  } else if (event.key === 'Escape') {
    eventsPage(tools.state).selected = null;
    tools.draw();
    return;
  } else {
    return;
  }
  event.preventDefault();
  if (target === null) return;
  const key = target.key;
  const page = eventsPage(tools.state);
  page.focused = key;
  page.hovered = null;
  tools.draw();
  event.currentTarget?.ownerSVGElement?.querySelector?.(`[data-key="${key}"]`)?.focus?.();
}

/** The fraction of the plot's width under the pointer. */
function fractionAt(event) {
  const box = event.currentTarget.getBoundingClientRect();
  return box.width > 0 ? clamp((event.clientX - box.left) / box.width, 0, 1) : 0;
}

function dragHandlers(span) {
  const page = () => eventsPage(tools.state);
  return {
    onPointerDown(event) {
      if (event.button !== 0 || !event.isPrimary) return;
      dragging = { x: event.clientX, from: fractionAt(event), id: event.pointerId, moved: false };
    },
    onPointerMove(event) {
      if (dragging === null || event.pointerId !== dragging.id) return;
      if (!dragging.moved && Math.abs(event.clientX - dragging.x) < 6) return;
      if (!dragging.moved) {
        dragging.moved = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
      page().drag = { from: dragging.from, to: fractionAt(event) };
      tools.draw();
    },
    onPointerUp() {
      if (dragging === null) return;
      const drag = page().drag;
      const moved = dragging.moved;
      dragging = null;
      page().drag = null;
      if (!moved || drag === null) return;
      justDragged = true;
      setTimeout(() => {
        justDragged = false;
      }, 0);
      const [low, high] = [drag.from, drag.to].sort((a, b) => a - b);
      const width = span.toMs - span.fromMs;
      const fromMs = Math.round(span.fromMs + low * width);
      const toMs = Math.round(span.fromMs + high * width);
      if (toMs - fromMs >= SHORTEST_ZOOM) zoomTo(fromMs, toMs);
      else tools.draw();
    },
    onPointerCancel() {
      dragging = null;
      page().drag = null;
      tools.draw();
    },
  };
}

// How many events a readout lists before it sends the reader to the table.
const TIP_ROWS = 8;

/** The readout over the timeline for a spot: every event there, the newest first, each with its time. */
function timelineTip(lane, spot, span, y, below) {
  const x = spot.x;
  const shown = spot.events.slice(0, TIP_ROWS);
  const many = spot.events.length > 1;
  return h(
    'div',
    {
      class: ['timeline-tip', x < 22 ? 'is-left' : '', x > 78 ? 'is-right' : '', below ? 'is-below' : '']
        .filter(Boolean)
        .join(' '),
      role: 'presentation',
      vars: { '--x': percent(x), '--y': `${y}px` },
    },
    h(
      'p',
      { class: 'tip-head' },
      lane.id === 'console'
        ? 'Console'
        : [
            lane.label === lane.thing ? thingId(lane.thing) : mono(lane.label),
            boardThing({ thing: lane.thing, name: lane.label }),
          ],
      many ? h('span', { class: 'tip-count' }, `${spot.events.length} events close together`) : null
    ),
    h(
      'ul',
      { class: 'tip-list' },
      shown.map((event) =>
        h(
          'li',
          { key: eventKey(event), class: 'tip-row' },
          swatch(event.kind),
          h(
            'span',
            { class: 'tip-text' },
            h('strong', null, event.text),
            h(
              'span',
              { class: 'tip-meta' },
              `${exactTime(event.at)} · ${kindOf(event.kind).label}`,
              event.level === 'warn' ? ' · warning' : ''
            )
          )
        )
      )
    ),
    spot.events.length > shown.length
      ? h('p', { class: 'tip-more' }, `and ${spot.events.length - shown.length} more: zoom in, or see All events below`)
      : null
  );
}

// The width the plot was last measured at, in pixels: spots are made for it. Until it is measured, a desktop's.
let plotWidth = 1000;
let measureTimer = 0;

/** Measure the plot after it is drawn; if its width is not the one the spots were made for, draw again. */
function remeasure() {
  clearTimeout(measureTimer);
  measureTimer = setTimeout(() => {
    const width = globalThis.document?.querySelector?.('.timeline-plot')?.clientWidth ?? 0;
    if (width > 0 && Math.abs(width - plotWidth) > plotWidth * 0.04) {
      plotWidth = width;
      tools?.draw();
    }
  }, 60);
}

/** For tests, which have no layout: the width of the plot, in pixels. */
export function measurePlot(width) {
  plotWidth = width;
}

if (typeof globalThis.addEventListener === 'function') globalThis.addEventListener('resize', remeasure);

function timeline(lanes, span, page, data) {
  const height = AXIS + lanes.length * LANE;
  const ticks = timeTicks(span.fromMs, span.toMs, 7);
  // Events close together are one marker; an event picked in the table lights the marker it is in.
  const reach = Math.max(plotWidth - 12, 100);
  for (const lane of lanes) lane.clusters = spotsOf(lane.shown, span, reach);
  const spotOf = new Map();
  for (const lane of lanes)
    for (const spot of lane.clusters) for (const event of spot.events) spotOf.set(eventKey(event), spot.key);
  const focusedEvent = page.focused ?? page.selected;
  const focused = spotOf.get(focusedEvent) ?? focusedEvent;
  const selected = spotOf.get(page.selected) ?? page.selected;
  // The one marker the keyboard reaches with Tab: the chosen one, else the newest.
  const all = lanes.flatMap((lane) => lane.clusters);
  const reachable = all.some((spot) => spot.key === focused) ? focused : all[0] ? all[0].key : null;
  // Where the loaded events of a range with more pages begin.
  const oldestLoaded =
    data.cursor && data.events.length > 0 ? Date.parse(data.events[data.events.length - 1].at) : null;
  const pointed = spotOf.get(page.hovered) ?? page.hovered ?? focused;
  let tip = null;

  const laneNodes = lanes.map((lane, laneIndex) => {
    const top = AXIS + laneIndex * LANE;
    const middle = top + LANE_HEAD + TRACK / 2;
    // A search or warnings only leave connections out: the bands would then say a board was offline when it was not.
    const bands =
      lane.id === 'console' || data.searched ? [] : onlineBands(lane.events, { ...span, device: lane.device });
    const state = lane.device ? laneState(lane.device) : null;
    const markers = lane.clusters.map((spot, index) => {
      const key = spot.key;
      const event = spot.lead;
      const kind = kindOf(event.kind);
      const count = spot.events.length;
      const holdsSelected = spot.events.some((member) => eventKey(member) === page.selected);
      const warns = spot.events.some((member) => member.level === 'warn');
      if (key === pointed) tip = timelineTip(lane, spot, span, middle, laneIndex === 0);
      const who = lane.id === 'console' ? 'Console' : lane.label;
      return h(
        'svg',
        {
          key,
          class: [
            'tl-mark',
            `is-${kind.tone}`,
            warns ? 'is-warn' : '',
            count > 1 ? 'is-group' : '',
            holdsSelected ? 'is-selected' : '',
          ]
            .filter(Boolean)
            .join(' '),
          x: percent(spot.x),
          y: String(middle),
          overflow: 'visible',
          tabindex: key === reachable ? '0' : '-1',
          role: 'button',
          'aria-pressed': holdsSelected ? 'true' : 'false',
          'aria-label':
            count > 1
              ? `${who}, ${count} events from ${exactTime(spot.events[count - 1].at)} to ${exactTime(spot.at)}, the newest: ${spot.events[0].text}` +
                `${warns ? '. Includes a warning' : ''}`
              : `${who}, ${exactTime(event.at)}: ${event.text}${event.level === 'warn' ? '. Warning' : ''}`,
          'data-key': key,
          onClick: () => {
            if (!justDragged) select(key, { from: 'marker' });
          },
          onKeyDown: (keyEvent) => markerKeys(keyEvent, lanes, laneIndex, index),
          onFocus: () => {
            page.focused = key;
            tools.draw();
          },
          onBlur: () => {
            if (page.focused === key && page.hovered === null) {
              page.focused = page.selected;
              tools.draw();
            }
          },
          onPointerEnter: () => {
            page.hovered = key;
            tools.draw();
          },
          onPointerLeave: () => {
            if (page.hovered === key) {
              page.hovered = null;
              tools.draw();
            }
          },
        },
        h('circle', { class: 'tl-hit', r: '14' }),
        h('circle', { class: 'tl-ring', r: '12' }),
        glyph(kind.shape),
        count > 1
          ? h(
              'g',
              { class: 'tl-count' },
              h('circle', { cx: '9', cy: '-10', r: '8' }),
              h(
                'text',
                { x: '9', y: '-10', 'text-anchor': 'middle', 'dominant-baseline': 'central' },
                count > 99 ? '99+' : String(count)
              )
            )
          : null
      );
    });
    return h(
      'g',
      { key: lane.id, class: `tl-lane ${lane.id === 'console' ? 'is-console' : ''}`.trim() },
      h(
        'text',
        { class: 'tl-lane-name', x: '0', y: String(top + 14) },
        lane.id === 'console' ? 'Console' : shortThing(lane.label),
        // The thing name after the board's own, quieter; left out where the timeline is narrow.
        lane.thing && lane.label !== lane.thing
          ? h('tspan', { class: 'tl-lane-thing', dx: '8' }, shortThing(lane.thing))
          : null,
        state ? h('tspan', { class: `tl-lane-state is-${state.tone}`, dx: '10' }, state.words) : null,
        lane.shown.length === 0 ? h('tspan', { class: 'tl-lane-state', dx: '10' }, 'No events') : null,
        // A thing name is in its short form, "…5da0b9e5": the whole of it is the lane's tooltip.
        lane.thing ? h('title', null, lane.thing) : null
      ),
      h('rect', {
        class: 'tl-track',
        x: '0',
        y: String(top + LANE_HEAD),
        width: '100%',
        height: String(TRACK),
        rx: '3',
      }),
      bands.map((band) =>
        h('rect', {
          key: `band-${band.fromMs}`,
          class: `tl-band ${band.inferred ? 'is-inferred' : ''}`.trim(),
          x: percent(place(band.fromMs, span.fromMs, span.toMs)),
          y: String(top + LANE_HEAD),
          width: percent(place(band.toMs, span.fromMs, span.toMs) - place(band.fromMs, span.fromMs, span.toMs)),
          height: String(TRACK),
        })
      ),
      logTicks(lane, span, top + LANE_HEAD + TRACK),
      markers
    );
  });

  const shade =
    oldestLoaded !== null && oldestLoaded > span.fromMs
      ? h(
          'g',
          { key: 'unloaded', class: 'tl-unloaded' },
          h('rect', {
            x: '0',
            y: String(AXIS - 2),
            width: percent(place(oldestLoaded, span.fromMs, span.toMs)),
            height: String(height - AXIS + 2),
          }),
          h('text', { class: 'tl-unloaded-label', x: '6', y: String(AXIS + 12) }, 'Not loaded yet')
        )
      : null;
  const drag = page.drag
    ? h('rect', {
        key: 'drag',
        class: 'tl-drag',
        x: percent(Math.min(page.drag.from, page.drag.to) * 100),
        y: String(AXIS - 4),
        width: percent(Math.abs(page.drag.to - page.drag.from) * 100),
        height: String(height - AXIS + 4),
      })
    : null;

  remeasure();
  return h(
    'div',
    { class: 'timeline-plot', ...dragHandlers(span) },
    h(
      'svg',
      {
        class: 'timeline-svg',
        width: '100%',
        height: String(height),
        role: 'group',
        'aria-label':
          `Timeline of events, ${rangeWords(span)}. One lane per board${lanes.some((lane) => lane.id === 'console') ? ' and one for the console' : ''}. ` +
          'Events close together are one marker with their number. Use the arrow keys to move between markers and Enter to pick one; the table below lists every event' +
          `${lanes.some((lane) => lane.lines?.length > 0) ? ', and the board log under it every line of the boards’ own logs' : ''}.`,
      },
      ticks.map((tick) => {
        const x = place(tick.ms, span.fromMs, span.toMs);
        let anchor = 'middle';
        if (x < 4) anchor = 'start';
        else if (x > 96) anchor = 'end';
        return h(
          'g',
          { key: `tick-${tick.ms}`, class: `tl-tick ${tick.newDay ? 'is-day' : ''}`.trim() },
          h('line', { class: 'tl-grid', x1: percent(x), x2: percent(x), y1: String(AXIS - 6), y2: String(height) }),
          h('text', { class: 'tl-tick-label', x: percent(x), y: '13', 'text-anchor': anchor }, tick.label)
        );
      }),
      shade,
      laneNodes,
      drag
    ),
    tip
  );
}

/** What the marks of the timeline mean: the kinds that are drawn, a group, the online band and the log ticks. */
function timelineKey(lanes) {
  const drawn = new Set(lanes.flatMap((lane) => lane.shown.map((event) => event.kind)));
  const hasLines = lanes.some((lane) => lane.lines?.length > 0);
  return h(
    'ul',
    { class: 'tl-key', key: 'key', 'aria-label': 'What the marks mean' },
    KINDS.filter((kind) => drawn.has(kind.id)).map((kind) => h('li', { key: kind.id }, swatch(kind.id), kind.label)),
    h(
      'li',
      { key: 'group' },
      h(
        'svg',
        {
          class: 'swatch',
          viewBox: '-8 -8 20 20',
          width: '20',
          height: '20',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('circle', { class: 'key-group', cx: '0', cy: '0', r: '6' }),
        h('circle', { class: 'key-count', cx: '6', cy: '-6', r: '5' })
      ),
      'A number: that many events close together'
    ),
    h('li', { key: 'band' }, h('span', { class: 'band-swatch', 'aria-hidden': 'true' }), 'Board online'),
    hasLines
      ? h('li', { key: 'tick' }, h('span', { class: 'tick-swatch', 'aria-hidden': 'true' }), 'Line of the board’s log')
      : null
  );
}

/**
 * The lines of a board's own log, as ticks at the foot of its lane: where it was talking, and
 * in which family's hue, without a marker for each. They are not reached with the keyboard and
 * not read out; the Board log under the timeline lists every one.
 */
function logTicks(lane, span, bottom) {
  if (!lane.lines || lane.lines.length === 0) return null;
  return h(
    'g',
    { key: 'log', class: 'tl-log', 'aria-hidden': 'true' },
    lane.lines.map((line) => {
      const x = percent(place(Date.parse(line.at), span.fromMs, span.toMs));
      return h('line', {
        key: `${line.thing}-${line.id}`,
        class: `tl-log-tick is-${kindOf(line.kind).tone}${line.level === 'warn' ? ' is-warn' : ''}`,
        x1: x,
        x2: x,
        y1: String(bottom - 7),
        y2: String(bottom - 1),
      });
    })
  );
}

/** A board's state now, for its lane: online words from the same source as the rest of the console. */
function laneState(device) {
  if (device.online) return { tone: 'good', words: 'Online now' };
  if (!device.lastSeen) return { tone: 'idle', words: 'Never connected' };
  return { tone: 'idle', words: 'Offline now' };
}

// The Events page.

function rangeTools(page, span) {
  return h(
    'div',
    { class: 'event-filters', key: 'filters' },
    h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Time range' },
      PRESETS.map((preset) =>
        h(
          'button',
          {
            key: preset.id,
            type: 'button',
            class: 'segmented-option',
            'aria-pressed': span.preset?.id === preset.id && page.zooms.length === 0 ? 'true' : 'false',
            title: `Show ${preset.name}`,
            onClick: () => choosePreset(preset.id),
          },
          preset.label
        )
      ),
      h(
        'button',
        {
          key: 'custom',
          type: 'button',
          class: 'segmented-option',
          'aria-pressed': !span.preset || page.custom ? 'true' : 'false',
          'aria-expanded': page.custom ? 'true' : 'false',
          onClick: openCustom,
        },
        'Custom…'
      )
    ),
    page.zooms.length > 0 ? button('is-small', zoomOut, icon('arrow-left', 'is-small'), 'Zoom out') : null
  );
}

/**
 * What each board is called in the list to choose from: its name, and with its thing name too
 * where two boards report the same name, since an option has no room for anything else to tell them apart.
 */
export function boardChoices(things, devices) {
  const names = things.map((thing) => boardName(boardOf(thing, devices)));
  return things.map((thing, index) => ({
    thing,
    label:
      names.indexOf(names[index]) === names.lastIndexOf(names[index])
        ? names[index]
        : boardName(boardOf(thing, devices), { full: true }),
  }));
}

/** The search and filters of the Events page: the search, the board and warnings only; the rest stand by their lists. */
function eventsFilterBar(ctx, page, devices, data, shown, lines) {
  const things = devices.map((device) => device.thing);
  if (page.thing && !things.includes(page.thing)) things.push(page.thing);
  let count = null;
  if (data) {
    const more = data.cursor || data.log?.cursor ? ', more in this range' : '';
    count = `${plural(shown, 'event')} and ${plural(lines, 'line')} shown${more}`;
  }
  return filterBar(ctx, 'events', {
    label: 'events and the board log',
    placeholder: 'Search what happened, or a line of the log',
    count,
    controls: [
      filterSelect(ctx, 'events', {
        name: 'board',
        label: 'Board',
        all: `All boards (${things.length})`,
        options: boardChoices(things, devices).map(({ thing, label }) => [thing, label, thing]),
      }),
      filterSelect(ctx, 'events', {
        name: 'level',
        label: 'Level',
        all: 'Everything',
        options: [['warn', 'Warnings only']],
      }),
    ],
  });
}

function customForm(page) {
  if (!page.custom) return null;
  const set = (name) => (event) => {
    page.custom = { ...page.custom, [name]: event.currentTarget.value, error: null };
  };
  return h(
    'form',
    { class: 'custom-range', key: 'custom', onSubmit: applyCustom },
    h(
      'label',
      { class: 'inline-field' },
      h('span', { class: 'inline-field-label' }, 'From'),
      h('input', {
        class: 'input',
        type: 'datetime-local',
        value: page.custom.from,
        onInput: set('from'),
        required: true,
      })
    ),
    h(
      'label',
      { class: 'inline-field' },
      h('span', { class: 'inline-field-label' }, 'To'),
      h('input', { class: 'input', type: 'datetime-local', value: page.custom.to, onInput: set('to'), required: true })
    ),
    h('button', { type: 'submit', class: 'ui-btn btn is-small is-primary' }, 'Show'),
    button(
      'is-small is-quiet',
      () => {
        page.custom = null;
        tools.draw();
      },
      'Cancel'
    ),
    page.custom.error ? h('p', { class: 'custom-error', role: 'alert' }, page.custom.error) : null,
    h('p', { class: 'custom-note' }, 'Local times, at most 31 days. You can also drag across the timeline to zoom in.')
  );
}

function kindChips(page, counts) {
  return h(
    'div',
    { class: 'kind-chips', role: 'group', 'aria-label': 'Kinds of event shown', key: 'kinds' },
    KINDS.map((kind) => {
      const on = !page.hidden.has(kind.id);
      return h(
        'button',
        {
          key: kind.id,
          type: 'button',
          class: `chip ${on ? 'is-on' : 'is-off'}`,
          'aria-pressed': on ? 'true' : 'false',
          title: on ? `Hide ${kind.label.toLowerCase()} events` : `Show ${kind.label.toLowerCase()} events`,
          onClick: () => toggleKind(kind.id),
        },
        swatch(kind.id),
        h('span', null, kind.label),
        on && counts.has(kind.id) ? h('span', { class: 'chip-count' }, String(counts.get(kind.id))) : null
      );
    }),
    h('span', { class: 'chip-band', key: 'band' }, h('span', { class: 'band-swatch', 'aria-hidden': 'true' }), 'Online')
  );
}

function eventRow(event, board, page) {
  const key = eventKey(event);
  const kind = kindOf(event.kind);
  const selected = key === page.selected;
  const deployment = event.job ? deploymentHref(event.job) : null;
  return h(
    'tr',
    { key, id: `event-row-${key}`, class: `event-row ${selected ? 'is-selected' : ''}`.trim() },
    h(
      'td',
      { class: 'event-time' },
      h(
        'button',
        {
          type: 'button',
          class: 'event-pick',
          'aria-pressed': selected ? 'true' : 'false',
          title: `${exactTime(event.at)}. Show it on the timeline.`,
          onClick: () => select(key, { from: 'row' }),
        },
        h('time', { datetime: event.at }, timeOfDay(event.at))
      )
    ),
    h('td', { class: 'event-board' }, board ? boardLabel(board) : h('span', null, 'Console')),
    h('td', { class: 'event-kind' }, swatch(event.kind), h('span', null, kind.label)),
    h(
      'td',
      { class: 'event-text' },
      h('span', null, event.text),
      event.level === 'warn' ? [' ', badge('warn', 'alert', 'Warning')] : null,
      deployment
        ? [' ', linkTo(deployment, { class: 'event-link' }, 'Deployment', icon('arrow-right', 'is-small'))]
        : null,
      event.kind === 'console' && event.href
        ? [' ', linkTo(event.href, { class: 'event-link' }, 'Open', icon('arrow-right', 'is-small'))]
        : null
    )
  );
}

function eventTable(events, page, now, devices) {
  const rows = [];
  let day = null;
  for (const event of events) {
    const label = dayLabel(event.at, now);
    if (label !== day) {
      day = label;
      rows.push(
        h('tr', { key: `day-${label}`, class: 'event-day' }, h('th', { colspan: '4', scope: 'colgroup' }, label))
      );
    }
    rows.push(eventRow(event, event.thing ? boardOf(event.thing, devices) : null, page));
  }
  return h(
    'div',
    { class: 'event-table-wrap' },
    h(
      'table',
      { class: 'event-table' },
      h('caption', { class: 'sr-only' }, 'Every event shown on the timeline, newest first'),
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { scope: 'col' }, 'Time'),
          h('th', { scope: 'col' }, 'Board'),
          h('th', { scope: 'col' }, 'Kind'),
          h('th', { scope: 'col' }, 'What happened')
        )
      ),
      h('tbody', null, rows)
    )
  );
}

// The board log.

/** The time of day to the second: lines of a log come many to a minute. */
function secondOfDay(iso) {
  const then = new Date(Date.parse(iso));
  if (Number.isNaN(then.getTime())) return '';
  return then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** The lines of the log that the page shows: those of the kinds that are switched on, newest first. */
export function shownLines(log, hidden) {
  if (!log || log.error) return [];
  return log.lines.filter((line) => !hidden.has(line.kind));
}

function tagFilter(page) {
  return h(
    'label',
    { class: 'inline-field', key: 'tag' },
    h('span', { class: 'inline-field-label' }, 'Source'),
    h(
      'select',
      {
        class: 'input is-select',
        value: page.tag,
        onChange: (event) => chooseTag(event.currentTarget.value),
      },
      h('option', { value: '', key: 'all', selected: page.tag === '' }, 'All sources'),
      LINE_TAGS.map((tag) => h('option', { value: tag, key: tag, selected: page.tag === tag }, tag))
    )
  );
}

function lineRow(line, board) {
  const kind = kindOf(line.kind);
  return h(
    'tr',
    {
      key: `${line.thing}-${line.id}`,
      class: `event-row log-row ${line.level === 'warn' ? 'is-warn' : ''}`.trim(),
      title: line.boot !== null && line.seq !== null ? `Boot ${line.boot}, line ${line.seq} of that boot` : null,
    },
    h('td', { class: 'event-time' }, h('time', { datetime: line.at, title: exactTime(line.at) }, secondOfDay(line.at))),
    h('td', { class: 'event-board' }, boardLabel(board)),
    h(
      'td',
      { class: 'event-kind', title: kind.label },
      swatch(line.kind),
      h('span', { class: 'mono log-tag' }, line.tag)
    ),
    h(
      'td',
      { class: 'event-text' },
      h('span', { class: 'mono log-text' }, line.text),
      line.level === 'warn' ? [' ', badge('warn', 'alert', 'Warning')] : null,
      line.dropped ? h('span', { class: 'log-dropped' }, `${plural(line.dropped, 'line')} lost before this one`) : null
    )
  );
}

function lineTable(lines, now, devices) {
  const rows = [];
  let day = null;
  for (const line of lines) {
    const label = dayLabel(line.at, now);
    if (label !== day) {
      day = label;
      rows.push(
        h('tr', { key: `day-${label}`, class: 'event-day' }, h('th', { colspan: '4', scope: 'colgroup' }, label))
      );
    }
    rows.push(lineRow(line, boardOf(line.thing, devices)));
  }
  return h(
    'div',
    { class: 'event-table-wrap' },
    h(
      'table',
      { class: 'event-table log-table' },
      h('caption', { class: 'sr-only' }, 'Every line of the boards’ own logs in this range, newest first'),
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { scope: 'col' }, 'Time'),
          h('th', { scope: 'col' }, 'Board'),
          h('th', { scope: 'col' }, 'Source'),
          h('th', { scope: 'col' }, 'Line')
        )
      ),
      h('tbody', null, rows)
    )
  );
}

/** What every board printed on its serial console, as far as it sends it (firmware 1.12.0 and later). */
function boardLogCard(page, data, devices, now) {
  const { log } = data;
  const lines = shownLines(log, page.hidden);
  const warnings = lines.filter((line) => line.level === 'warn').length;
  let body;
  if (!page.log) {
    body = h(
      'p',
      { class: 'ui-card-note card-note', key: 'off' },
      'Hidden. The board log is every line a board on firmware 1.12.0 or ' +
        'later prints on its serial console, a passkey or anything like a password never among them.'
    );
  } else if (log?.error) {
    body = failure('Could not load the board log.', log.error);
  } else if (lines.length === 0) {
    body = empty({
      iconName: 'list',
      title: 'No lines in this range.',
      text:
        page.tag || page.thing || LINE_KINDS.some((kind) => page.hidden.has(kind))
          ? 'Some sources, kinds or boards are left out: show them all, or choose a longer range.'
          : 'A board on firmware 1.12.0 or later sends what it prints on its serial console. Older firmware sends nothing here.',
    });
  } else {
    body = lineTable(lines, now, devices);
  }
  return h(
    'section',
    { key: 'log', class: 'ui-card card log-card', 'aria-label': 'Board log' },
    h(
      'header',
      { class: 'ui-card-head card-head log-head' },
      h('h2', { class: 'eyebrow' }, 'Board log'),
      page.log && log && !log.error
        ? h(
            'p',
            { class: 'event-count dotted' },
            h('span', null, plural(lines.length, 'line')),
            warnings > 0
              ? h('span', { class: 'status is-warn' }, icon('alert', 'is-small'), plural(warnings, 'warning'))
              : null,
            log.cursor ? h('span', null, 'more in this range') : null
          )
        : null,
      h(
        'div',
        { class: 'log-tools' },
        page.log ? tagFilter(page) : null,
        h(
          'button',
          {
            type: 'button',
            class: 'ui-btn btn is-small',
            'aria-pressed': page.log ? 'true' : 'false',
            onClick: toggleLog,
          },
          page.log ? 'Hide the board log' : 'Show the board log'
        )
      )
    ),
    body,
    page.log && log?.cursor
      ? h(
          'div',
          { class: 'log-more', key: 'more' },
          h(
            'button',
            { type: 'button', class: 'ui-btn btn', disabled: page.linesMore.loading, onClick: loadMoreLines },
            page.linesMore.loading ? 'Loading…' : 'Load 500 more lines'
          ),
          page.linesMore.error ? failure('Could not load more.', page.linesMore.error) : null
        )
      : null
  );
}

export function eventsView(ctx) {
  const { state } = ctx;
  const page = followFilters(state);
  const now = state.now;
  const span = page.data.value?.span ?? rangeOf(page.range, now);
  const data = page.data.value;
  const devices = state.devices.value?.devices ?? [];
  const head = pageHead({
    title: 'Events',
    lede: 'What every board did and printed, with what people did in this console.',
    how: {
      title: 'How events work',
      text: [
        'Each board’s connections, updates, restarts, Bluetooth and its health, as it reported them, with what people ' +
          'did in this console alongside, and every line a board prints on its serial console.',
        'Events and lines are kept for 90 days.',
      ],
    },
    tools: freshness(page.data, ctx),
  });

  let body;
  let counted = { shown: 0, lines: 0 };
  if (!data) {
    body = pending(page.data, 'events');
  } else {
    const consoleEvents = data.audit ? data.audit.entries.map((entry) => consoleEvent(entry, devices)) : null;
    const lines = shownLines(page.log ? data.log : null, page.hidden);
    const lanes = lanesOf({ events: data.events, devices, thing: page.thing, consoleEvents }).map((lane) => ({
      ...lane,
      shown: shownEvents([lane], page.hidden),
      lines: lane.thing ? lines.filter((line) => line.thing === lane.thing) : [],
    }));
    const shown = shownEvents(lanes, page.hidden);
    const counts = new Map();
    for (const item of [...shown, ...lines]) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    const warnings = shown.filter((event) => event.level === 'warn').length;
    counted = { shown: shown.length, lines: lines.length };
    // No board at all, and none that was ever heard of in this range: the way to get one first.
    if (lanes.length === 0 || (state.devices.value && devices.length === 0 && data.events.length === 0)) {
      body = card({ key: 'none' }, empty(NO_BOARDS));
    } else {
      body = [
        kindChips(page, counts),
        h(
          'section',
          {
            key: 'chart',
            class: `ui-card card timeline-card ${page.data.loading ? 'is-refreshing' : ''}`.trim(),
            'aria-label': 'Timeline',
          },
          h(
            'header',
            { class: 'ui-card-head card-head' },
            h('h2', { class: 'eyebrow' }, 'Timeline'),
            h('p', { class: 'timeline-range' }, rangeWords(span))
          ),
          timeline(lanes, span, page, data),
          timelineKey(lanes),
          h(
            'p',
            { class: 'ui-card-note card-note timeline-note' },
            'Hover, tap or tab to a marker for the time and what happened; drag across the timeline to zoom in.',
            lines.length > 0
              ? ' A tick at the foot of a lane is a line of that board’s own log, listed under Board log.'
              : '',
            data.audit?.cut ? ' The Console lane shows the newest 500 entries of the activity log in this range.' : '',
            data.searched ? ' While a search or warnings only narrows the events, the online bands are not drawn.' : ''
          )
        ),
        h(
          'section',
          { key: 'list', class: 'ui-card card event-card' },
          h(
            'header',
            { class: 'ui-card-head card-head' },
            h('h2', { class: 'eyebrow' }, 'All events'),
            h(
              'p',
              { class: 'event-count dotted' },
              h('span', null, plural(shown.length, 'event')),
              warnings > 0
                ? h('span', { class: 'status is-warn' }, icon('alert', 'is-small'), plural(warnings, 'warning'))
                : null,
              data.cursor ? h('span', null, 'more in this range') : null
            )
          ),
          shown.length === 0
            ? empty({
                iconName: 'list',
                title: 'No events in this range.',
                text:
                  page.hidden.size > 0 || page.thing || searched(page)
                    ? 'A search, some kinds or boards narrow the list: clear them, or choose a longer range.'
                    : 'Boards record events when they connect, update, restart or change state. Choose a longer range.',
              })
            : eventTable(shown, page, now, devices),
          h(
            'div',
            { class: 'log-more', key: 'more' },
            data.cursor
              ? h(
                  'button',
                  { type: 'button', class: 'ui-btn btn', disabled: page.more.loading, onClick: loadMoreEvents },
                  page.more.loading ? 'Loading…' : 'Load 500 more'
                )
              : null,
            page.more.error ? failure('Could not load more.', page.more.error) : null
          )
        ),
        boardLogCard(page, data, devices, now),
      ];
    }
  }

  return h(
    'div',
    { class: 'page is-events' },
    head,
    h('div', { class: 'event-toolbar', key: 'toolbar' }, rangeTools(page, span)),
    eventsFilterBar(ctx, page, devices, data, counted.shown, counted.lines),
    customForm(page),
    loadProblem(page.data, 'the events', ctx),
    body
  );
}

// Line charts.

const PLOT_W = 1000;
const PLOT_H = 160;

/**
 * A line chart of one series over time. `points` are { ms, v }, oldest first. The latest
 * value is written at the end; a crosshair and readout follow the pointer and the arrow keys
 * when the chart has the focus; the table under it has every hour. Also drawn by the Memfault
 * metrics of a board's page (memfault-page.js), so that every chart of the console is one, and by the
 * fleet health score's trend on the Overview (fleet.js), with `daily`: one point a day, and a table of
 * the days.
 */
/** A daily chart's table: a row a day, newest first. */
function dailyTable(title, points, format) {
  return h(
    'details',
    { class: 'chart-table' },
    h('summary', null, `${title} by the day, as a table`),
    h(
      'table',
      { class: 'ui-table data-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Day'), h('th', { scope: 'col' }, 'Value'))),
      h(
        'tbody',
        null,
        [...points]
          .reverse()
          .map((point) =>
            h(
              'tr',
              { key: String(point.ms) },
              h(
                'th',
                { scope: 'row' },
                new Date(point.ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
              ),
              h('td', null, format(point.v))
            )
          )
      )
    )
  );
}

export function lineChart(ctx, options) {
  const {
    key,
    title,
    unit,
    axisUnit,
    points,
    fromMs,
    toMs,
    yMin,
    yMax,
    yTicks,
    refs = [],
    format,
    tickFormat,
    gapMs,
    describe,
    emptyText,
    words,
    daily = false,
  } = options;
  const x = (ms) => ((ms - fromMs) / (toMs - fromMs)) * PLOT_W;
  const y = (v) => PLOT_H - ((clamp(v, yMin, yMax) - yMin) / (yMax - yMin)) * PLOT_H;
  const top = (v) => percent((1 - (clamp(v, yMin, yMax) - yMin) / (yMax - yMin)) * 100);
  const runs = lineRuns(points, gapMs);
  const line = runs
    .map((run) =>
      run.length === 1
        ? `M${(x(run[0].ms) - 2).toFixed(1)} ${y(run[0].v).toFixed(1)}h4`
        : run.map((point, index) => `${index ? 'L' : 'M'}${x(point.ms).toFixed(1)} ${y(point.v).toFixed(1)}`).join('')
    )
    .join('');
  const area = runs
    .filter((run) => run.length > 1)
    .map(
      (run) =>
        `M${x(run[0].ms).toFixed(1)} ${PLOT_H}${run.map((point) => `L${x(point.ms).toFixed(1)} ${y(point.v).toFixed(1)}`).join('')}` +
        `L${x(run[run.length - 1].ms).toFixed(1)} ${PLOT_H}Z`
    )
    .join('');
  const latest = points[points.length - 1] ?? null;
  const index = chartReadouts.get(key);
  const read = index !== undefined ? (points[clamp(index, 0, points.length - 1)] ?? null) : null;
  const values = points.map((point) => point.v);
  const summary = latest
    ? `Now ${format(latest.v)} · lowest ${format(Math.min(...values))} · highest ${format(Math.max(...values))}`
    : emptyText;

  const move = (to) => {
    if (points.length === 0) return;
    chartReadouts.set(key, clamp(to, 0, points.length - 1));
    ctx.actions.redraw();
  };
  const handlers =
    points.length === 0
      ? {}
      : {
          tabindex: '0',
          onPointerMove: (event) => {
            keyboardCharts.delete(key);
            const box = event.currentTarget.getBoundingClientRect();
            if (box.width <= 0) return;
            const at = fromMs + clamp((event.clientX - box.left) / box.width, 0, 1) * (toMs - fromMs);
            const found = nearest(points, at);
            if (found !== chartReadouts.get(key)) move(found);
          },
          onPointerLeave: () => {
            chartReadouts.delete(key);
            ctx.actions.redraw();
          },
          onFocus: () => {
            keyboardCharts.add(key);
            if (!chartReadouts.has(key)) move(points.length - 1);
          },
          onBlur: () => {
            keyboardCharts.delete(key);
            chartReadouts.delete(key);
            ctx.actions.redraw();
          },
          onKeyDown: (event) => {
            const at = chartReadouts.get(key) ?? points.length - 1;
            const steps = { ArrowLeft: -1, ArrowRight: 1, PageUp: -10, PageDown: 10 };
            if (event.key in steps) move(at + steps[event.key]);
            else if (event.key === 'Home') move(0);
            else if (event.key === 'End') move(points.length - 1);
            else if (event.key === 'Escape') {
              chartReadouts.delete(key);
              ctx.actions.redraw();
            } else return;
            event.preventDefault();
          },
        };
  const xTicks = timeTicks(fromMs, toMs, 5);

  return h(
    'figure',
    { class: 'chart', key },
    h(
      'figcaption',
      { class: 'chart-head' },
      h('span', { class: 'chart-title' }, title),
      h('span', { class: 'chart-summary' }, summary)
    ),
    h(
      'div',
      { class: 'chart-frame' },
      h(
        'div',
        { class: 'chart-y', 'aria-hidden': 'true' },
        h('span', { class: 'chart-unit' }, axisUnit),
        yTicks.map((tick) =>
          h('span', { key: String(tick), class: 'chart-y-label', vars: { '--top': top(tick) } }, tickFormat(tick))
        )
      ),
      h(
        'div',
        {
          class: `chart-plot ${points.length === 0 ? 'is-empty' : ''}`.trim(),
          role: 'img',
          'aria-label': `${title}, ${describe}. ${summary}.${points.length > 0 ? ` Use the arrow keys to read the values; the table below has every ${daily ? 'day' : 'hour'}.` : ''}`,
          ...handlers,
        },
        h(
          'svg',
          {
            class: 'chart-svg',
            viewBox: `0 0 ${PLOT_W} ${PLOT_H}`,
            preserveAspectRatio: 'none',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          yTicks.map((tick) =>
            h('line', {
              key: `grid-${tick}`,
              class: 'chart-grid',
              x1: '0',
              x2: String(PLOT_W),
              y1: String(y(tick)),
              y2: String(y(tick)),
              'vector-effect': 'non-scaling-stroke',
            })
          ),
          refs.map((ref) =>
            h('line', {
              key: `ref-${ref.label}`,
              class: 'chart-ref',
              x1: '0',
              x2: String(PLOT_W),
              y1: String(y(ref.v)),
              y2: String(y(ref.v)),
              'vector-effect': 'non-scaling-stroke',
            })
          ),
          area ? h('path', { class: 'chart-area', d: area }) : null,
          line ? h('path', { class: 'chart-line', d: line, 'vector-effect': 'non-scaling-stroke' }) : null
        ),
        latest
          ? h('span', {
              class: 'chart-dot is-end',
              vars: { '--x': percent(place(latest.ms, fromMs, toMs)), '--top': top(latest.v) },
            })
          : null,
        read
          ? [
              h('span', { key: 'cross', class: 'chart-cross', vars: { '--x': percent(place(read.ms, fromMs, toMs)) } }),
              h('span', {
                key: 'dot',
                class: 'chart-dot',
                vars: { '--x': percent(place(read.ms, fromMs, toMs)), '--top': top(read.v) },
              }),
              h(
                'span',
                {
                  key: 'tip',
                  class: `chart-tip ${place(read.ms, fromMs, toMs) > 70 ? 'is-right' : ''}`.trim(),
                  vars: { '--x': percent(place(read.ms, fromMs, toMs)) },
                },
                h('strong', null, format(read.v)),
                h('span', null, [words?.(read.v), clockTime(iso(read.ms), toMs)].filter(Boolean).join(' · '))
              ),
            ]
          : null,
        points.length === 0 ? h('p', { class: 'chart-empty' }, emptyText) : null
      ),
      h(
        'div',
        { class: 'chart-refs', 'aria-hidden': 'true' },
        refs.map((ref) =>
          h('span', { key: `label-${ref.label}`, class: 'chart-ref-label', vars: { '--top': top(ref.v) } }, ref.label)
        )
      ),
      h(
        'div',
        { class: 'chart-x', 'aria-hidden': 'true' },
        xTicks.map((tick) =>
          h(
            'span',
            {
              key: String(tick.ms),
              class: 'chart-x-label',
              vars: { '--x': percent(place(tick.ms, fromMs, toMs)) },
            },
            tick.label
          )
        )
      )
    ),
    h(
      'span',
      { class: 'sr-only', 'aria-live': 'polite' },
      read && keyboardCharts.has(key) ? `${format(read.v)} at ${exactTime(iso(read.ms))}` : ''
    ),
    points.length > 0 && daily ? dailyTable(title, points, format) : null,
    points.length > 0 && !daily
      ? h(
          'details',
          { class: 'chart-table' },
          h('summary', null, `${title} by the hour, as a table`),
          h(
            'table',
            { class: 'ui-table data-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col' }, 'Hour'),
                h('th', { scope: 'col' }, 'Lowest'),
                h('th', { scope: 'col' }, 'Mean'),
                h('th', { scope: 'col' }, 'Highest'),
                h('th', { scope: 'col' }, 'Readings')
              )
            ),
            h(
              'tbody',
              null,
              hourlyRows(points).map((row) =>
                h(
                  'tr',
                  { key: String(row.ms) },
                  h('th', { scope: 'row' }, clockTime(iso(row.ms), toMs)),
                  h('td', null, format(row.low)),
                  h('td', null, format(row.mean)),
                  h('td', null, format(row.high)),
                  h('td', null, String(row.count))
                )
              )
            )
          ),
          h('p', { class: 'ui-card-note card-note' }, `In ${unit}. Each reading is one report of the board.`)
        )
      : null
  );
}

// The Diagnostics page.

const RSSI_TICKS = [-90, -75, -60, -45];

function rssiChart(ctx, device, samples) {
  const points = pointsOf(samples.samples, 'rssi');
  const toMs = Date.parse(samples.to) || ctx.state.now;
  return lineChart(ctx, {
    key: `${device.thing}-rssi`,
    title: 'Wi-Fi signal, 24 h',
    unit: 'dBm (0 is the strongest)',
    points,
    fromMs: toMs - samples.hours * HOUR,
    toMs,
    yMin: -100,
    yMax: -30,
    yTicks: RSSI_TICKS,
    refs: [
      { v: -67, label: 'Good' },
      { v: -75, label: 'Fair' },
    ],
    format: (value) => `${signed(value)} dBm`,
    tickFormat: signed,
    axisUnit: 'dBm',
    words: (value) => signalQuality(value)?.label,
    gapMs: gapFor(samples.bucketSeconds),
    describe: 'from the heartbeat every 30 seconds',
    emptyText: 'No readings in the last 24 hours.',
  });
}

function heapChart(ctx, device, samples) {
  const points = pointsOf(samples.samples, 'heapFree');
  const toMs = Date.parse(samples.to) || ctx.state.now;
  const size = device.diag?.heap?.size ?? Math.max(1024, ...points.map((point) => point.v));
  const kib = (bytes) => Math.round(bytes / 1024);
  const step = size > 64 * 1024 ? 16 * 1024 : size > 16 * 1024 ? 8 * 1024 : 2 * 1024;
  const ticks = [];
  for (let value = 0; value <= size; value += step) ticks.push(value);
  return lineChart(ctx, {
    key: `${device.thing}-heap`,
    title: 'Free memory, 24 h',
    unit: 'KiB of the system heap',
    points,
    fromMs: toMs - samples.hours * HOUR,
    toMs,
    yMin: 0,
    yMax: size,
    yTicks: ticks,
    refs: [{ v: size * LOW_HEAP_SHARE, label: 'Low' }],
    format: (value) => `${(value / 1024).toFixed(1)} KiB`,
    tickFormat: (value) => String(kib(value)),
    axisUnit: 'KiB',
    gapMs: Math.max(gapFor(samples.bucketSeconds), 11 * MINUTE),
    describe: `from the diagnostics report every 5 minutes, of ${fileSize(size)} in all`,
    emptyText: device.diag ? 'No readings in the last 24 hours.' : diagMissing(device),
  });
}

function heapBar(heap) {
  const words = heapWords(heap);
  return h(
    'div',
    { class: 'fact-stack' },
    h(
      'div',
      {
        class: `heap-bar is-${words.tone}`,
        role: 'img',
        'aria-label': `${words.text}, ${words.used}% in use. ${words.least}.`,
        vars: { '--used': `${words.used}%`, '--peak': `${words.leastUsed}%` },
      },
      h('span', { class: 'heap-used' }),
      h('span', { class: 'heap-peak' })
    ),
    h(
      'span',
      { class: 'heap-words' },
      words.tone === 'bad' ? [badge('bad', 'alert', 'Low now'), ' '] : null,
      words.text
    ),
    h(
      'span',
      { class: 'heap-words fact-note' },
      words.ranLow ? [badge('warn', 'alert', 'Ran low'), ' '] : null,
      words.least
    )
  );
}

function bootTable(device) {
  if (!device.diary) return h('p', { class: 'quiet' }, diaryMissing(device));
  const rows = diaryRows(device.diary);
  if (rows.length === 0) return h('p', { class: 'quiet' }, 'The diary is empty.');
  return h(
    'div',
    { class: 'event-table-wrap' },
    h(
      'table',
      { class: 'ui-table data-table boot-table' },
      h('caption', { class: 'sr-only' }, 'The last boots of this board, newest first'),
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { scope: 'col' }, 'Boot'),
          h('th', { scope: 'col' }, 'Firmware'),
          h('th', { scope: 'col' }, 'Why the boot before it ended'),
          h('th', { scope: 'col' }, 'How far it got')
        )
      ),
      h(
        'tbody',
        null,
        rows.map((row) =>
          h(
            'tr',
            { key: String(row.boot) },
            h('th', { scope: 'row' }, `#${row.boot}`, row.running ? h('span', { class: 'quiet' }, ' (running)') : null),
            h('td', null, mono(row.version)),
            h('td', null, row.bad ? [badge('warn', 'alert', 'Fault'), ' '] : null, row.before),
            h('td', null, row.running ? `${row.reached} so far` : row.reached)
          )
        )
      )
    ),
    h(
      'p',
      { class: 'ui-card-note card-note' },
      `${plural(device.diary.boots, 'boot')} in all since the diary began. Each line says why the boot before it ended, `,
      'from the chip’s own record of its reset.'
    )
  );
}

function btFacts(device) {
  const record = device.bt;
  if (!record) {
    return h(
      'p',
      { class: 'quiet' },
      'No update over Bluetooth recorded. Boards on 1.9.0 or later keep a record of the last one.'
    );
  }
  const bad = [
    'rolled_back',
    'not_installed',
    'trial_lost',
    'flash_error',
    'incompatible_board',
    'incompatible_layout',
  ].includes(record.result);
  return facts([
    ['Update', [mono(record.from), ' to ', mono(record.to)]],
    ['Result', bad ? badge('warn', 'alert', BT_WORDS[record.result]) : BT_WORDS[record.result]],
    ['Proof', PROOF_WORDS[record.proof]],
    ['Updates', plural(record.count, 'update', 'updates'), factNote('over Bluetooth on this board, in all')],
  ]);
}

function signalFact(device) {
  const quality = signalQuality(device.rssi);
  if (!quality) return h('span', { class: 'quiet' }, 'Not reported');
  return [
    signalBars(quality, !device.online),
    h(
      'span',
      null,
      `${quality.label} · ${signed(device.rssi)} dBm`,
      device.online ? null : h('span', { class: 'quiet' }, ' when last seen')
    ),
  ];
}

function boardCard(ctx, device) {
  const { state } = ctx;
  const page = diagnosticsPage(state);
  const now = state.now;
  const samples = page.samples.get(device.thing) ?? resource();
  const details = page.details.get(device.thing) ?? resource();
  const update = describeUpdate(device);
  const stuck = stuckWords(device.stuck);
  const uptime = uptimeNow(device, now);
  const certificates = details.value?.certificates ?? null;

  return h(
    'section',
    { key: device.thing, class: 'ui-card card diag-card', 'aria-labelledby': `diag-${device.thing}` },
    h(
      'header',
      { class: 'diag-head' },
      h(
        'div',
        { class: 'diag-who' },
        h('h2', { class: 'diag-name', id: `diag-${device.thing}` }, boardLabel(device)),
        boardName(device) === device.thing ? null : h('p', { class: 'diag-thing' }, boardThing(device)),
        h(
          'p',
          { class: 'diag-heartbeat' },
          device.lastSeen
            ? [
                'Last heartbeat ',
                h(
                  'time',
                  { datetime: device.lastSeen, title: exactTime(device.lastSeen), class: 'diag-age' },
                  heartbeatAge(device.lastSeen, now)
                ),
              ]
            : 'No heartbeat yet: it has not reported to the console.'
        )
      ),
      presence(device, now)
    ),
    h(
      'div',
      { class: 'diag-body' },
      h(
        'div',
        { class: 'diag-facts' },
        facts([
          [
            'Uptime',
            uptime === null
              ? h('span', { class: 'quiet' }, 'Not reported')
              : [duration(uptime), device.online ? null : h('span', { class: 'quiet' }, ' when last seen')],
          ],
          [
            'Firmware',
            device.fw
              ? [
                  mono(device.fw.version, 'fact-strong'),
                  device.fw.confirmed ? badge('good', 'check', 'Confirmed') : badge('warn', 'pulse', 'On trial'),
                ]
              : h('span', { class: 'quiet' }, 'Not reported'),
          ],
          [
            'Update',
            h(
              'div',
              { class: 'fact-stack' },
              statusLine(update),
              update.progress !== null ? meter(update.progress, `Download on ${boardName(device)}`) : null
            ),
          ],
          [
            'Stuck',
            stuck
              ? [stuck.tone === 'warn' ? badge('warn', 'alert', stuck.badge) : null, h('span', null, stuck.text)]
              : h('span', { class: 'quiet' }, 'Not reported: firmware before 1.7.0 has no such timer'),
          ],
          ['Signal', signalFact(device)],
          [
            'Wi-Fi',
            device.diag
              ? [
                  device.diag.channel ? `Channel ${device.diag.channel}` : 'Not associated',
                  h('span', { class: 'quiet' }, ' · MAC '),
                  device.diag.mac ? mono(device.diag.mac) : h('span', { class: 'quiet' }, 'not reported'),
                ]
              : factNote(diagMissing(device)),
          ],
          [
            'Memory',
            device.diag?.heap
              ? heapBar(device.diag.heap)
              : factNote(device.diag ? 'The heap is not reported by this build.' : diagMissing(device)),
          ],
          [
            'Certificates',
            certificates === null
              ? h('span', { class: 'quiet' }, details.error ? 'Could not be read' : 'Loading…')
              : certificates.length === 0
                ? h('span', { class: 'quiet' }, 'None attached: this board cannot connect')
                : h(
                    'span',
                    { class: 'cert-list' },
                    certificates.map((id) => h('span', { key: id }, icon('key', 'is-small'), mono(`${id}…`)))
                  ),
          ],
        ]),
        device.diag?.at
          ? h('p', { class: 'ui-card-note card-note' }, 'Diagnostics report ', when(device.diag.at, now), '.')
          : null
      ),
      h(
        'div',
        { class: 'diag-charts' },
        samples.value
          ? [
              rssiChart(ctx, device, samples.value),
              device.diag || samples.value.samples.some((sample) => sample.heapFree !== null)
                ? heapChart(ctx, device, samples.value)
                : h(
                    'div',
                    { class: 'chart-absent', key: 'heap' },
                    h('p', { class: 'chart-title' }, 'Free memory, 24 h'),
                    h('p', { class: 'quiet' }, diagMissing(device))
                  ),
            ]
          : samples.error
            ? failure('Could not load the readings.', samples.error)
            : loading('the readings')
      )
    ),
    h(
      'div',
      { class: 'diag-more' },
      h(
        'section',
        { class: 'diag-section', 'aria-label': 'Last boots' },
        h('h3', { class: 'section-label' }, 'Last boots'),
        bootTable(device)
      ),
      h(
        'section',
        { class: 'diag-section', 'aria-label': 'Bluetooth update record' },
        h('h3', { class: 'section-label' }, 'Last update over Bluetooth'),
        btFacts(device)
      )
    )
  );
}

function boardPicker(devices, chosen, now) {
  return h(
    'nav',
    { class: 'board-picker', key: 'picker', 'aria-label': 'Boards' },
    h(
      'ul',
      { class: 'picker-list' },
      devices.map((device) => {
        const quality = signalQuality(device.rssi);
        const heap = heapWords(device.diag?.heap ?? null);
        return h(
          'li',
          { key: device.thing },
          h(
            'a',
            {
              class: 'picker-link',
              href: routeHash({ view: 'diagnostics', thing: device.thing }),
              'aria-current': device.thing === chosen ? 'page' : null,
            },
            h('span', { class: 'mono picker-name', title: device.thing }, boardName(device)),
            h(
              'span',
              { class: `picker-state is-${device.online ? 'good' : 'idle'}` },
              icon(device.online ? 'online' : 'offline', 'is-small'),
              device.online
                ? 'Online'
                : device.lastSeen
                  ? `Offline, ${timeAgo(device.lastSeen, now)}`
                  : 'Never connected'
            ),
            h('span', { class: 'picker-fact' }, quality ? `${quality.label} · ${signed(device.rssi)} dBm` : '—'),
            h('span', { class: 'picker-fact' }, heap ? heap.text : '—')
          )
        );
      })
    )
  );
}

export function diagnosticsView(ctx) {
  const { state } = ctx;
  const devices = state.devices.value?.devices ?? null;
  const chosen = state.route.thing ?? null;
  const head = pageHead({
    title: 'Diagnostics',
    lede: 'How each board is doing, live: heartbeat, signal, memory and restarts.',
    how: {
      title: 'How diagnostics work',
      text: [
        'Each figure is what the board itself reported. The page refreshes every 10 seconds, and the charts every minute.',
      ],
    },
    tools: freshness(state.devices, ctx),
  });
  let body;
  if (devices === null) {
    body = pending(state.devices, 'the boards');
  } else if (devices.length === 0) {
    body = card({ key: 'none' }, empty(NO_BOARDS));
  } else {
    const shown = shownBoards(devices, chosen);
    body = [
      devices.length > CARDS_AT_ONCE ? boardPicker(devices, shown[0]?.thing ?? null, state.now) : null,
      shown.length === 0
        ? card(
            { key: 'gone' },
            empty({
              iconName: 'chip',
              title: 'No board with this name is registered.',
              text: 'Pick one of the boards above.',
              action: { href: '#/diagnostics', label: 'All boards' },
            })
          )
        : shown.map((device) => boardCard(ctx, device)),
    ];
  }
  return h('div', { class: 'page is-diagnostics' }, head, loadProblem(state.devices, 'the boards', ctx), body);
}

/** A thing name as the timeline's text can show it, "…5da0b9e5"; anything else as it is. */
function shortThing(text) {
  return isThing(text) ? `…${text.slice(-8)}` : text;
}
