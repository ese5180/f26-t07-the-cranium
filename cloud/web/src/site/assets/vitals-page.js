/**
 * Our own vitals, in the console (docs/own-observability.md, stage 2): how the boards are doing over time,
 * from the events they already send. The fleet's page has the vitals Memfault shows (crash-free boards,
 * connected time, the share on the newest release), a chart a day, a row a board and a row a version; a
 * board's page has its days, with its Wi-Fi signal, lowest free heap and longest uptime from the last 7 days
 * of samples. Memfault's own metrics stay on a board's page (memfault-page.js).
 *
 * Everything comes through the console's own API (cloud/api/src/handlers/vitals.mjs). Every answer of the
 * server is checked here, field by field, before it is drawn: a field of another type is left out. The charts
 * are the console's own line charts (telemetry.js lineChart). Fetched when one of these pages is first opened
 * (app.js).
 */

import { boardName, deviceHref, isThing, plural } from './core.js';
import { badge, card, empty, h, loadProblem, mono, notice, pageHead, pending, thingId } from './views.js';
import { lineChart } from './telemetry.js';

// Each read Queries every board's events in the window, so the pages read as often as the Issues page.
export const VITALS_REFRESH_MS = 5 * 60_000;
// The windows a person can choose; the API's own default is the first (DEFAULT_VITALS_DAYS).
export const VITALS_RANGES = Object.freeze([7, 30, 90]);
export const DEFAULT_RANGE = 7;
// How long samples are kept (cloud/api/src/lib/events.mjs SAMPLE_DAYS): the signal and memory charts' window.
export const SAMPLE_DAYS = 7;
const DAY_MS = 86_400_000;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,5}\+\d{1,10}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

let tools = null;

function resource() {
  return { value: null, error: null, loadedAt: 0, loading: false };
}

/** app.js hands over what the pages need once: { state, api, load, draw, now }. */
export function connect(given) {
  tools = given;
  tools.state.ownVitals ??= { days: DEFAULT_RANGE, fleet: new Map(), board: new Map() };
}

function entry(map, key) {
  if (!map.has(key)) map.set(key, resource());
  return map.get(key);
}

// Reading the server's answers.

const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
const whole = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const number = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const fraction = (value) => (typeof value === 'number' && value >= 0 && value <= 1 ? value : null);
const version = (value) => (typeof value === 'string' && VERSION.test(value) ? value : null);
const flag = (value) => (typeof value === 'boolean' ? value : null);
const rssi = (value) => (Number.isInteger(value) && value >= -127 && value <= 0 ? value : null);
const text = (value, max = 64) => (typeof value === 'string' ? value.slice(0, max) : null);
const instant = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);

/** The counts every tally has: a board's, a day's, a version's. */
function counts(value) {
  return {
    knownHours: number(value.knownHours) ?? 0,
    onlineHours: number(value.onlineHours) ?? 0,
    connectivity: fraction(value.connectivity),
    restarts: whole(value.restarts) ?? 0,
    unexpected: whole(value.unexpected) ?? 0,
    drops: whole(value.drops) ?? 0,
    lowMemory: whole(value.lowMemory) ?? 0,
    restartsPerDay: number(value.restartsPerDay),
  };
}

function part(value) {
  const one = object(value);
  return { boards: whole(one.boards) ?? 0, of: whole(one.of) ?? 0, share: fraction(one.share) };
}

function readBoardRow(raw) {
  const value = object(raw);
  if (!isThing(value.thing)) return null;
  return {
    thing: value.thing,
    name: text(value.name),
    type: text(value.type, 32),
    online: value.online === true,
    version: version(value.version),
    newest: value.newest === true,
    rssi: rssi(value.rssi),
    unread: value.unread === true,
    cut: value.cut === true,
    active: value.active === true,
    crashFree: flag(value.crashFree),
    ...counts(value),
  };
}

function readCohort(raw) {
  const value = object(raw);
  return {
    version: version(value.version),
    boards: whole(value.boards) ?? 0,
    crashFreeBoards: whole(value.crashFreeBoards) ?? 0,
    crashFree: fraction(value.crashFree),
    perThousandHours: number(value.perThousandHours),
    ...counts(value),
  };
}

function readDay(raw) {
  const value = object(raw);
  if (typeof value.day !== 'string' || !DAY.test(value.day)) return null;
  return {
    day: value.day,
    boards: whole(value.boards),
    crashFreeBoards: whole(value.crashFreeBoards),
    crashFree: fraction(value.crashFree),
    active: value.active === true,
    samples: whole(value.samples) ?? 0,
    rssiMean: rssi(value.rssiMean),
    rssiLow: rssi(value.rssiLow),
    heapLeast: whole(value.heapLeast),
    uptimeMax: whole(value.uptimeMax),
    ...counts(value),
  };
}

function readWindow(value) {
  return {
    from: instant(value.from),
    to: instant(value.to),
    days: whole(value.days),
  };
}

/** The fleet's vitals, or what of them is sound. */
export function readVitals(raw) {
  const value = object(raw);
  const vitals = object(value.vitals);
  return {
    vitals: {
      boards: whole(vitals.boards) ?? 0,
      active: whole(vitals.active) ?? 0,
      unread: whole(vitals.unread) ?? 0,
      crashFree: part(vitals.crashFree),
      connectivity: {
        onlineHours: number(object(vitals.connectivity).onlineHours) ?? 0,
        knownHours: number(object(vitals.connectivity).knownHours) ?? 0,
        share: fraction(object(vitals.connectivity).share),
      },
      newest: part(vitals.newest),
      restarts: whole(vitals.restarts) ?? 0,
      unexpected: whole(vitals.unexpected) ?? 0,
      drops: whole(vitals.drops) ?? 0,
      lowMemory: whole(vitals.lowMemory) ?? 0,
      restartsPerDay: number(vitals.restartsPerDay),
    },
    daily: list(value.daily).map(readDay).filter(Boolean),
    perBoard: list(value.perBoard).map(readBoardRow).filter(Boolean),
    versions: list(value.versions).map(readCohort),
    ...readWindow(value),
  };
}

/** One board's vitals, or what of them is sound. */
export function readBoardVitals(raw) {
  const value = object(raw);
  const vitals = object(value.vitals);
  return {
    board: readBoardRow(value.board),
    vitals: { active: vitals.active === true, crashFree: flag(vitals.crashFree), ...counts(vitals) },
    daily: list(value.daily).map(readDay).filter(Boolean),
    versions: list(value.versions).map(readCohort),
    samplesFrom: instant(value.samplesFrom),
    samplesUnread: value.samplesUnread === true,
    cut: value.cut === true,
    ...readWindow(value),
  };
}

// Loading.

export function vitalsHref(thing) {
  return isThing(thing) ? `#/vitals/${thing}` : null;
}

function daysChosen(state) {
  const days = state.ownVitals?.days;
  return VITALS_RANGES.includes(days) ? days : DEFAULT_RANGE;
}

export function vitalsResources(state) {
  return state.ownVitals ? [entry(state.ownVitals.fleet, daysChosen(state))] : [];
}

export async function refreshVitals() {
  const { state, load, api } = tools;
  const days = daysChosen(state);
  await load(entry(state.ownVitals.fleet, days), async () =>
    readVitals(await api.vitalsRequest(`/api/vitals?days=${days}`))
  );
}

export function boardVitalsResources(state) {
  const { thing } = state.route;
  return state.ownVitals && isThing(thing) ? [entry(state.ownVitals.board, `${thing}|${daysChosen(state)}`)] : [];
}

export async function refreshBoardVitals() {
  const { state, load, api } = tools;
  const { thing } = state.route;
  if (!isThing(thing)) return;
  const days = daysChosen(state);
  await load(entry(state.ownVitals.board, `${thing}|${days}`), async () =>
    readBoardVitals(await api.vitalsRequest(`/api/vitals/${thing}?days=${days}`))
  );
}

// Drawing.

/** A share as a person reads it: "97%", or "99.9%" and "0.4%" where a whole number would hide a gap; "-" for none. */
export function percent(share, { digits = 0 } = {}) {
  if (share === null || share === undefined) return '-';
  const value = share * 100;
  if (digits === 0 && value > 99 && value < 100) return `${Math.floor(value * 10) / 10}%`;
  if (digits === 0 && value > 0 && value < 1) return value < 0.1 ? '<0.1%' : `${Math.floor(value * 10) / 10}%`;
  return `${value.toFixed(digits).replace(/\.0+$/, '')}%`;
}

function kib(bytes) {
  return bytes === null ? '-' : `${(bytes / 1024).toFixed(1)} KiB`;
}

function hoursWords(seconds) {
  if (seconds === null) return '-';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < (2 * DAY_MS) / 1000) return `${Math.round(seconds / 360) / 10} h`;
  return `${Math.round(seconds / 8640) / 10} days`;
}

function signedDbm(value) {
  return value === null ? '-' : `${value} dBm`;
}

/** The range switch: 7, 30 or 90 days, read again when it changes. */
function rangeTools(ctx, refresh) {
  const days = daysChosen(ctx.state);
  return h(
    'div',
    { class: 'segmented metric-range vitals-range', role: 'group', 'aria-label': 'Days shown', key: 'range' },
    VITALS_RANGES.map((one) =>
      h(
        'button',
        {
          key: String(one),
          type: 'button',
          class: 'segmented-option',
          'aria-pressed': one === days ? 'true' : 'false',
          title: `Show the last ${one} days`,
          onClick: () => {
            if (!tools || one === days) return;
            tools.state.ownVitals.days = one;
            tools.draw();
            refresh();
          },
        },
        `${one} days`
      )
    )
  );
}

/** Stat tiles (the shared `ui-stats is-tiles`): a figure with its label, a tile each. */
function tiles(rows) {
  return h(
    'dl',
    { class: 'ui-stats is-tiles vitals-tiles', key: 'tiles' },
    rows.map(([label, value, note]) =>
      h(
        'div',
        { key: label, class: 'ui-stat' },
        h('dt', { class: 'ui-stat-label' }, label),
        h('dd', { class: 'ui-stat-value' }, value),
        note ? h('dd', { class: 'ui-stat-note' }, note) : null
      )
    )
  );
}

/** A board from the console's list when it is there, for its name; else the row's. */
function boardOf(ctx, row) {
  const known = list(ctx.state.devices?.value?.devices).find((board) => board?.thing === row.thing);
  return known ?? { thing: row.thing, name: row.name };
}

/** A board as the shared `ui-board` names one, linking to its vitals. */
function boardCell(board) {
  const named = boardName(board) !== board.thing;
  return h(
    'a',
    { class: 'ui-board', href: vitalsHref(board.thing), title: board.thing },
    h('span', { class: 'ui-board-label' }, named ? boardName(board) : thingId(board.thing)),
    named ? h('span', { class: 'ui-board-id' }, board.thing) : null
  );
}

/** A shared table (`ui-table`), a card per row on a phone (`is-stacked`). */
function table(key, label, heads, rows) {
  return h(
    'div',
    { class: 'ui-table-wrap', key, tabindex: '0', role: 'region', 'aria-label': label },
    h(
      'table',
      { class: `ui-table is-stacked vitals-table vitals-${key}` },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          heads.map(([words, num]) => h('th', { key: words, scope: 'col', class: num ? 'is-num' : null }, words))
        )
      ),
      h('tbody', null, rows)
    )
  );
}

function cell(label, value, num = true) {
  return h('td', { key: label, class: num ? 'is-num' : null, 'data-label': label }, value);
}

/** The x axis of a day's chart: from the first day's start to the last day's end; a point at each day's noon. */
function daySpan(daily) {
  if (daily.length === 0) return null;
  return {
    fromMs: Date.parse(`${daily[0].day}T00:00:00Z`),
    toMs: Date.parse(`${daily[daily.length - 1].day}T00:00:00Z`) + DAY_MS,
  };
}

const noon = (day) => Date.parse(`${day}T12:00:00Z`);

/** A scale from 0 that fits whole counts: at least 4, in steps of a round size. */
export function countScale(values) {
  const highest = Math.max(4, ...values);
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((one) => highest / one <= 4) ?? 1000;
  const yMax = Math.ceil(highest / step) * step;
  const yTicks = [];
  for (let value = 0; value <= yMax; value += step) yTicks.push(value);
  return { yMin: 0, yMax, yTicks };
}

function shareChart(ctx, { key, title, daily, field, describe, emptyText }) {
  const span = daySpan(daily);
  const points = daily
    .filter((one) => one[field] !== null)
    .map((one) => ({ ms: noon(one.day), v: Math.round(one[field] * 1000) / 10 }));
  return lineChart(ctx, {
    key,
    title,
    unit: 'percent',
    axisUnit: '%',
    points,
    fromMs: span?.fromMs ?? 0,
    toMs: span?.toMs ?? DAY_MS,
    yMin: 0,
    yMax: 100,
    yTicks: [0, 25, 50, 75, 100],
    format: (value) => `${value}%`,
    tickFormat: (value) => String(value),
    gapMs: 1.5 * DAY_MS,
    describe,
    emptyText,
    daily: true,
  });
}

function countChart(ctx, { key, title, daily, field, unit, describe, emptyText, keep = () => true }) {
  const span = daySpan(daily);
  const points = daily.filter(keep).map((one) => ({ ms: noon(one.day), v: one[field] }));
  return lineChart(ctx, {
    key,
    title,
    unit,
    axisUnit: '',
    points,
    fromMs: span?.fromMs ?? 0,
    toMs: span?.toMs ?? DAY_MS,
    ...countScale(points.map((point) => point.v)),
    format: (value) => String(value),
    tickFormat: (value) => String(value),
    gapMs: 1.5 * DAY_MS,
    describe,
    emptyText,
    daily: true,
  });
}

function unreadNotice(count) {
  if (!count) return null;
  return h(
    'div',
    { class: 'page-notice', key: 'unread' },
    notice(
      'warn',
      'alert',
      `The events of ${plural(count, 'board', 'boards')} could not be read; the vitals leave them out.`
    )
  );
}

const VERSIONS_NOTE =
  'Crashes are restarts our Issues count; per 1,000 hours online, and none for a version with under an hour online.';

const HOW = {
  title: 'How vitals are made',
  text: [
    'From the events the boards already send: AWS IoT’s word that a board connected or disconnected, its restarts and why, its updates, and memory that ran low. Nothing new is asked of a board.',
    'A board counts once it was seen in the days shown. Crash-free means no restart that our Issues count: the watchdog, a brownout, a lockup, a restart for being stuck. Connected is the share of the time we know about: a board that disconnected before the days shown counts as offline until it connects, and time before a board’s first connection is otherwise not known. A drop is a disconnect the board did not ask for. Days are UTC days.',
    'The newest release is the newest active one of each board type; its share is of every board whose version is known, seen in these days or not. A board’s own page adds its Wi-Fi signal, lowest free heap and longest uptime from the last 7 days, which is as long as those readings are kept.',
  ],
};

function boardsTable(ctx, rows) {
  return table(
    'boards',
    'Vitals of each board',
    [
      ['Board'],
      ['Version'],
      ['Crash-free'],
      ['Connected', true],
      ['Restarts', true],
      ['Drops', true],
      ['Signal now', true],
    ],
    rows.map((row) =>
      h(
        'tr',
        { key: row.thing, class: 'vitals-board' },
        h('th', { scope: 'row' }, boardCell(boardOf(ctx, row))),
        h(
          'td',
          { 'data-label': 'Version' },
          row.version ? mono(row.version) : '-',
          row.newest ? [' ', badge('good', 'check', 'Newest')] : null
        ),
        h(
          'td',
          { 'data-label': 'Crash-free' },
          row.unread
            ? h('span', { class: 'quiet' }, 'Not read')
            : !row.active
              ? h('span', { class: 'quiet' }, 'Not seen')
              : row.crashFree
                ? badge('good', 'check', 'Crash-free')
                : badge('bad', 'alert', plural(row.unexpected, 'crash', 'crashes'))
        ),
        cell('Connected', row.active ? percent(row.connectivity) : '-'),
        cell('Restarts', row.active ? String(row.restarts) : '-'),
        cell('Drops', row.active ? String(row.drops) : '-'),
        cell('Signal now', signedDbm(row.rssi))
      )
    )
  );
}

function versionsTable(cohorts) {
  return table(
    'versions',
    'Vitals of each version',
    [
      ['Version'],
      ['Boards', true],
      ['Crash-free', true],
      ['Connected', true],
      ['Crashes', true],
      ['Per 1,000 h', true],
    ],
    cohorts.map((one, index) =>
      h(
        'tr',
        { key: one.version ?? `unknown-${index}` },
        h('th', { scope: 'row' }, one.version ? mono(one.version) : 'Unknown'),
        cell('Boards', String(one.boards)),
        cell('Crash-free', `${one.crashFreeBoards} of ${one.boards}`),
        cell('Connected', percent(one.connectivity)),
        cell('Crashes', String(one.unexpected)),
        cell('Per 1,000 h', one.perThousandHours === null ? '-' : String(one.perThousandHours))
      )
    )
  );
}

/** The Vitals page: the fleet's vitals, by day, by board and by version. */
export function vitalsView(ctx) {
  const { state } = ctx;
  const days = daysChosen(state);
  const target = state.ownVitals ? entry(state.ownVitals.fleet, days) : resource();
  const head = [
    pageHead({
      title: 'Vitals',
      lede: 'Crash-free boards, connected time and the newest release, from what the boards already send.',
      how: HOW,
      tools: rangeTools(ctx, refreshVitals),
    }),
  ];
  const data = target.value;
  if (!data)
    return h('div', { class: 'page' }, head, loadProblem(target, 'the vitals', ctx), pending(target, 'the vitals'));
  const { vitals } = data;
  const seen = vitals.active;
  return h(
    'div',
    { class: 'page' },
    head,
    loadProblem(target, 'the vitals', ctx),
    unreadNotice(vitals.unread),
    tiles([
      [
        'Crash-free boards',
        percent(vitals.crashFree.share),
        `${vitals.crashFree.boards} of ${plural(vitals.crashFree.of, 'board', 'boards')} in ${days} days`,
      ],
      ['Connected', percent(vitals.connectivity.share), `${Math.round(vitals.connectivity.onlineHours)} h online`],
      [
        'On the newest release',
        percent(vitals.newest.share),
        `${vitals.newest.boards} of ${plural(vitals.newest.of, 'board', 'boards')} with a known version`,
      ],
      [
        'Restarts',
        String(vitals.restarts),
        vitals.unexpected ? `${plural(vitals.unexpected, 'crash', 'crashes')}` : 'no crashes',
      ],
      ['Connection drops', String(vitals.drops)],
      ['Memory ran low', String(vitals.lowMemory), plural(vitals.lowMemory, 'time', 'times')],
    ]),
    seen === 0
      ? card(
          { key: 'none', title: 'Vitals' },
          empty({
            iconName: 'pulse',
            title: 'No board was seen.',
            text: `No board with Wi-Fi connected or reported in the last ${days} days.`,
          })
        )
      : card(
          { key: 'trends', title: 'By day' },
          h(
            'div',
            { class: 'diag-charts vitals-charts' },
            shareChart(ctx, {
              key: `vitals-crashfree-${days}`,
              title: 'Crash-free boards',
              daily: data.daily,
              field: 'crashFree',
              describe: 'the share of the boards seen each day with no crash',
              emptyText: 'No board was seen.',
            }),
            shareChart(ctx, {
              key: `vitals-connected-${days}`,
              title: 'Connected',
              daily: data.daily,
              field: 'connectivity',
              describe: 'the share of the known time the boards were connected each day',
              emptyText: 'No connected time is known.',
            }),
            countChart(ctx, {
              key: `vitals-restarts-${days}`,
              title: 'Restarts',
              daily: data.daily,
              field: 'restarts',
              unit: 'restarts a day, of every board',
              keep: (one) => (one.boards ?? 0) > 0,
              describe: 'the restarts of every board each day',
              emptyText: 'No board was seen.',
            })
          )
        ),
    card(
      { key: 'boards', title: 'Boards' },
      data.perBoard.length ? boardsTable(ctx, data.perBoard) : h('p', { class: 'quiet' }, 'No boards.')
    ),
    data.versions.length
      ? card(
          { key: 'versions', title: 'Versions' },
          versionsTable(data.versions),
          h('p', { class: 'ui-card-note card-note' }, VERSIONS_NOTE)
        )
      : null
  );
}

function boardNotes(data, days) {
  const notes = [];
  if (data.cut) {
    notes.push(
      notice(
        'warn',
        'alert',
        `This board sent too many events to read all ${days} days; the vitals start at the oldest read.`
      )
    );
  }
  if (data.samplesUnread) notes.push(notice('warn', 'alert', 'The signal and memory readings could not be read.'));
  return notes.length ? h('div', { class: 'page-notice', key: 'notes' }, notes) : null;
}

function daysTable(daily) {
  return table(
    'days',
    'Vitals of each day',
    [
      ['Day (UTC)'],
      ['Connected', true],
      ['Restarts', true],
      ['Crashes', true],
      ['Drops', true],
      ['Signal', true],
      ['Least free heap', true],
      ['Longest up', true],
    ],
    [...daily].reverse().map((one) =>
      h(
        'tr',
        { key: one.day },
        h(
          'th',
          { scope: 'row' },
          new Date(`${one.day}T12:00:00Z`).toLocaleDateString(undefined, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            timeZone: 'UTC',
          })
        ),
        cell('Connected', one.active ? percent(one.connectivity) : '-'),
        cell('Restarts', String(one.restarts)),
        cell('Crashes', String(one.unexpected)),
        cell('Drops', String(one.drops)),
        cell('Signal', one.rssiMean === null ? '-' : `${one.rssiMean} (low ${one.rssiLow}) dBm`),
        cell('Least free heap', kib(one.heapLeast)),
        cell('Longest up', hoursWords(one.uptimeMax))
      )
    )
  );
}

/** A board's vitals: its tiles, its days in charts and a table, and its versions. */
export function boardVitalsView(ctx) {
  const { state } = ctx;
  const { thing } = state.route;
  const days = daysChosen(state);
  const target = state.ownVitals ? entry(state.ownVitals.board, `${thing}|${days}`) : resource();
  const back = { href: '#/vitals', label: 'Vitals' };
  const data = target.value;
  const named = boardName(boardOf(ctx, { thing, name: data?.board?.name ?? null }));
  const head = [
    pageHead({
      eyebrow: 'Vitals',
      title: named,
      back,
      lede: 'Connected time, restarts and drops by day, with a week of signal and memory.',
      meta: [
        h('a', { key: 'board', href: deviceHref(thing) }, 'Board'),
        h('a', { key: 'diag', href: `#/diagnostics/${thing}` }, 'Diagnostics'),
      ],
      tools: rangeTools(ctx, refreshBoardVitals),
    }),
  ];
  if (!data || !data.board) {
    return h('div', { class: 'page' }, head, loadProblem(target, 'these vitals', ctx), pending(target, 'the vitals'));
  }
  const { vitals } = data;
  const samplesFromMs = Date.parse(data.samplesFrom ?? '') || 0;
  const sampled = data.daily.filter((one) => Date.parse(`${one.day}T00:00:00Z`) + DAY_MS > samplesFromMs);
  return h(
    'div',
    { class: 'page' },
    head,
    loadProblem(target, 'these vitals', ctx),
    boardNotes(data, days),
    tiles([
      [
        'Crash-free',
        vitals.crashFree === null ? '-' : vitals.crashFree ? 'Yes' : 'No',
        vitals.unexpected ? plural(vitals.unexpected, 'crash', 'crashes') : null,
      ],
      ['Connected', percent(vitals.connectivity), `${Math.round(vitals.onlineHours)} h online`],
      ['Restarts', String(vitals.restarts), vitals.restartsPerDay === null ? null : `${vitals.restartsPerDay} a day`],
      ['Connection drops', String(vitals.drops)],
      ['Memory ran low', String(vitals.lowMemory), plural(vitals.lowMemory, 'time', 'times')],
      ['Version', data.board.version ? mono(data.board.version) : '-', data.board.newest ? 'the newest' : null],
    ]),
    card(
      { key: 'trends', title: 'By day' },
      h(
        'div',
        { class: 'diag-charts vitals-charts' },
        shareChart(ctx, {
          key: `vitals-${thing}-connected-${days}`,
          title: 'Connected',
          daily: data.daily,
          field: 'connectivity',
          describe: 'the share of the known time this board was connected each day',
          emptyText: 'No connected time is known.',
        }),
        countChart(ctx, {
          key: `vitals-${thing}-restarts-${days}`,
          title: 'Restarts',
          daily: data.daily,
          field: 'restarts',
          unit: 'restarts a day',
          keep: (one) => one.active,
          describe: 'the restarts of this board each day',
          emptyText: 'Nothing is known of these days.',
        }),
        lineChart(ctx, {
          key: `vitals-${thing}-rssi-${days}`,
          title: `Wi-Fi signal, ${SAMPLE_DAYS} days`,
          unit: 'dBm, the mean of each day (0 is the strongest)',
          axisUnit: 'dBm',
          points: sampled.filter((one) => one.rssiMean !== null).map((one) => ({ ms: noon(one.day), v: one.rssiMean })),
          ...(daySpan(sampled) ?? { fromMs: 0, toMs: DAY_MS }),
          yMin: -100,
          yMax: -30,
          yTicks: [-90, -75, -60, -45],
          refs: [
            { v: -67, label: 'Good' },
            { v: -75, label: 'Fair' },
          ],
          format: (value) => `${value} dBm`,
          tickFormat: (value) => String(value),
          gapMs: 1.5 * DAY_MS,
          describe: 'the mean of the readings each day',
          emptyText: `No readings in the last ${SAMPLE_DAYS} days.`,
          daily: true,
        }),
        countChart(ctx, {
          key: `vitals-${thing}-heap-${days}`,
          title: `Least free heap, ${SAMPLE_DAYS} days`,
          daily: sampled.map((one) => ({
            ...one,
            heapKib: one.heapLeast === null ? null : Math.round(one.heapLeast / 1024),
          })),
          field: 'heapKib',
          unit: 'KiB, the lowest the free heap got each day',
          keep: (one) => one.heapLeast !== null,
          describe: 'the lowest free heap each day, from firmware 1.10.0',
          emptyText: `No memory readings in the last ${SAMPLE_DAYS} days.`,
        })
      )
    ),
    card({ key: 'days', title: 'Days' }, daysTable(data.daily)),
    data.versions.length
      ? card(
          { key: 'versions', title: 'Versions' },
          versionsTable(data.versions),
          h('p', { class: 'ui-card-note card-note' }, VERSIONS_NOTE)
        )
      : null
  );
}
