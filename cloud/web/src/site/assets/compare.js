/**
 * Boards side by side, and each board's versions over time (docs/compare.md): the Version timeline card of a
 * board's page, and the Compare page (#/compare?boards=a,b), which sets two to four boards next to each other
 * with their versions, uptime, last report, signal, unexpected restarts and issues of the last 7 days, their
 * latest key Memfault metrics, and their timelines in parallel columns. A row whose boards differ is marked,
 * in words as well as colour. On a phone the boards stack, one card each.
 *
 * Everything comes through routes the console already has, and one of its own: GET /api/devices/{thing}/timeline
 * (cloud/api/src/handlers/timeline.mjs), the boards (GET /api/devices), each board's warnings of the week
 * (GET /api/events) and what Memfault knows of it (memfault-page.js, GET /api/devices/{thing}/memfault).
 * Fetched when a board's page or the Compare page is first opened (app.js).
 */

import {
  COMPARE_MAX,
  compareThings,
  deploymentHref,
  duration,
  dateAndTime,
  exactTime,
  isThing,
  plural,
  signalQuality,
} from './core.js';
import { badge, button, card, empty, h, icon, loading, mono, pageHead } from './views.js';

// A board's timeline is read again at most once a minute; its pages beyond the first only when asked for.
export const TIMELINE_REFRESH_MS = 60_000;
export const TIMELINE_PAGE = 20;
const WEEK_MS = 7 * 86_400_000;

let tools = null;

function resource() {
  return { value: null, error: null, loadedAt: 0, loading: false };
}

/** app.js hands over what the pages need once: { state, api, load, draw, now, memfault }. */
export function connect(given) {
  tools = given;
  tools.state.timelines ??= new Map();
  tools.state.weekWarnings ??= new Map();
}

function entry(map, key) {
  if (!map.has(key)) map.set(key, resource());
  return map.get(key);
}

// Reading.

/** A board's timeline, its first page: again only after TIMELINE_REFRESH_MS, and not once more was asked for. */
export async function refreshTimeline(thing, full = false) {
  const { state, api, load, now } = tools;
  if (!isThing(thing)) return;
  const target = entry(state.timelines, thing);
  if (target.loadedAt !== 0 && (target.extended || (!full && now() - target.loadedAt < TIMELINE_REFRESH_MS))) return;
  target.extended = false;
  await load(target, () => api.timeline(thing, { limit: TIMELINE_PAGE }));
}

/** The next page of a board's timeline, after the ones shown. */
export async function moreTimeline(thing) {
  const { state, api, draw } = tools;
  const target = state.timelines.get(thing);
  if (!target?.value?.cursor || target.more) return;
  target.more = true;
  target.moreFailed = false;
  draw();
  try {
    const page = await api.timeline(thing, { limit: TIMELINE_PAGE, cursor: target.value.cursor });
    target.value = { ...target.value, versions: [...target.value.versions, ...page.versions], cursor: page.cursor };
    target.extended = true;
  } catch {
    target.moreFailed = true;
  } finally {
    target.more = false;
    draw();
  }
}

/** A board's unexpected restarts and other warnings of the last 7 days, from its events. */
export function countWeek(events, more = false) {
  let reboots = 0;
  let issues = 0;
  for (const event of events) {
    if (event.level !== 'warn' || event.kind === 'connection') continue;
    if (event.kind === 'restart') reboots += 1;
    else issues += 1;
  }
  return { reboots, issues, more };
}

async function refreshWeek(thing, full) {
  const { state, api, load, now } = tools;
  const target = entry(state.weekWarnings, thing);
  if (!full && target.loadedAt !== 0 && now() - target.loadedAt < TIMELINE_REFRESH_MS) return;
  const toMs = now();
  await load(target, async () => {
    const page = await api.events({
      from: new Date(toMs - WEEK_MS).toISOString(),
      to: new Date(toMs).toISOString(),
      thing,
      level: 'warn',
    });
    return countWeek(page.events, page.cursor !== null);
  });
}

/** What the Compare page shows of its boards: the list of boards, and for each its timeline, week and Memfault. */
export async function refreshCompare(things, full = false) {
  const { state, api, load } = tools;
  const memfault = await tools.memfault?.();
  await Promise.all([
    load(state.devices, api.devices),
    ...things.map((thing) => refreshTimeline(thing, full)),
    ...things.map((thing) => refreshWeek(thing, full)),
    ...things.map((thing) => memfault?.refreshBoard(thing, full)),
  ]);
}

// Words.

const ARRIVAL_WORDS = Object.freeze({
  ota: 'Over the air',
  bluetooth: 'Over Bluetooth from a phone',
  usb: 'By USB or another tool',
  rollback: 'By a rollback',
  setup: 'Before the history: by USB or at setup',
});

const STATUS_LOOKS = Object.freeze({
  confirmed: ['good', 'check-circle', 'Confirmed'],
  rolled_back: ['bad', 'undo', 'Rolled back'],
  trial: ['idle', 'clock', 'On trial'],
});

/** How a version came to the board, in words. */
export function arrivalWords(stay) {
  return ARRIVAL_WORDS[stay.arrived] ?? ARRIVAL_WORDS.usb;
}

/** When a version ran: "Nov 3, 2026, 2:02 PM to Nov 5, 2026, 9:10 AM (1 d 19 h)", "since …", or what is not known. */
export function spanWords(stay, nowMs) {
  const from = stay.startedAt ? dateAndTime(stay.startedAt) : null;
  const to = stay.endedAt ? dateAndTime(stay.endedAt) : null;
  const endMs = stay.endedAt ? Date.parse(stay.endedAt) : stay.current ? nowMs : null;
  const length = stay.startedAt && endMs !== null ? ` (${duration((endMs - Date.parse(stay.startedAt)) / 1000)})` : '';
  if (stay.current) return from ? `Since ${from}${length}` : 'Runs it now, since before the history';
  if (from && to) return `${from} to ${to}${length}`;
  if (to) return `Until ${to}`;
  if (from) return `From ${from}, until a version the history does not show`;
  return 'When is not known';
}

/** The unexpected restarts and issues while on a version, in words. */
export function countWords(stay) {
  if (stay.reboots === null || stay.issues === null) return 'Restarts and issues not known: before events were kept';
  return `${plural(stay.reboots, 'unexpected restart', 'unexpected restarts')} · ${plural(stay.issues, 'issue', 'issues')}`;
}

// Drawing.

function stayItem(stay, index, nowMs) {
  const [tone, iconName, label] = STATUS_LOOKS[stay.status] ?? STATUS_LOOKS.trial;
  const href = deploymentHref(stay.deployment);
  const troubled = (stay.reboots ?? 0) + (stay.issues ?? 0) > 0;
  return h(
    'li',
    {
      key: `${index}-${stay.version}`,
      class: `vtimeline-item is-${stay.status.replace('_', '-')}${stay.current ? ' is-current' : ''}`,
    },
    h('span', { class: 'vtimeline-mark', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'vtimeline-body' },
      h(
        'div',
        { class: 'vtimeline-head' },
        mono(stay.version, 'vtimeline-version'),
        badge(tone, iconName, label),
        stay.current ? h('span', { class: 'vtimeline-now' }, 'Runs now') : null
      ),
      h('p', { class: 'vtimeline-when' }, spanWords(stay, nowMs)),
      h(
        'p',
        { class: 'vtimeline-how' },
        arrivalWords(stay),
        // The link says where it leads; the deployment's id is its tooltip, not a 40-character line.
        href ? [', ', h('a', { href, title: stay.deployment }, 'in a deployment')] : null
      ),
      h(
        'p',
        { class: `vtimeline-counts${troubled ? ' is-troubled' : ''}` },
        troubled ? icon('alert', 'is-small') : null,
        countWords(stay)
      )
    )
  );
}

/** A board's versions as a vertical timeline, newest at the top, with Show older while there are more. */
export function timelineList(thing, ctx, { compact = false } = {}) {
  const target = ctx.state.timelines?.get(thing) ?? null;
  if (target === null || (!target.value && !target.error)) return loading('the versions');
  if (!target.value) return h('p', { class: 'quiet', key: 'failed' }, 'The versions could not be read.');
  const { versions, cursor } = target.value;
  if (versions.length === 0) {
    return h('p', { class: 'quiet', key: 'none' }, 'This board has not said which version it runs.');
  }
  return [
    h(
      'ol',
      { class: `vtimeline${compact ? ' is-compact' : ''}`, key: 'list', 'aria-label': 'Versions, newest first' },
      versions.map((stay, index) => stayItem(stay, index, ctx.state.now))
    ),
    cursor
      ? h(
          'p',
          { class: 'ui-button-row button-row', key: 'more' },
          button(
            'is-small',
            () => ctx.actions.moreTimeline(thing),
            target.more ? 'Loading…' : target.moreFailed ? 'Try again' : 'Show older versions'
          )
        )
      : null,
  ];
}

/** The Version timeline card of a board's page. */
export function timelineSection(thing, ctx) {
  return card(
    { key: 'version-timeline', title: 'Version timeline', className: 'version-timeline' },
    timelineList(thing, ctx),
    h(
      'p',
      { class: 'ui-card-note card-note', key: 'note' },
      'Every version this board ran, from its update history. Restarts and issues are its warnings while on each.'
    )
  );
}

const missingText = '—';

function latestMetric(data, key) {
  const series = data?.metrics?.series?.[key];
  return Array.isArray(series) && series.length > 0 ? series[series.length - 1].v : null;
}

/**
 * The rows of the Compare page: [{ id, label, cells: [{ text, key }], differs }], one cell per board in
 * order. `key` is what is compared; a row whose boards have more than one key differs. A time ago is not
 * compared: it differs between any two boards.
 */
export function compareRows(boards, { memfault = null } = {}) {
  const rows = [];
  const add = (id, label, cell, compared = true) => {
    const cells = boards.map(cell);
    const differs = compared && new Set(cells.map((one) => one.key ?? '')).size > 1;
    rows.push({ id, label, cells, differs });
  };
  add('version', 'Firmware', ({ device }) => {
    const fw = device?.fw ?? null;
    if (!fw) return { text: missingText, key: null };
    return { text: fw.confirmed ? fw.version : `${fw.version}, on trial`, key: `${fw.version}${fw.confirmed}` };
  });
  add('status', 'State', ({ device }) => {
    if (!device) return { text: 'Not registered', key: 'gone' };
    if (device.online) return { text: 'Online', key: 'online' };
    return device.lastSeen ? { text: 'Offline', key: 'offline' } : { text: 'Never connected', key: 'never' };
  });
  add(
    'seen',
    'Last report',
    ({ device }) => ({ text: device?.lastSeen ? exactTime(device.lastSeen) : missingText, key: null }),
    false
  );
  add(
    'uptime',
    'Uptime',
    ({ device }) => ({ text: Number.isFinite(device?.uptime) ? duration(device.uptime) : missingText, key: null }),
    false
  );
  add('rssi', 'Wi-Fi signal', ({ device }) => {
    if (!Number.isFinite(device?.rssi)) return { text: missingText, key: null };
    const quality = signalQuality(device.rssi);
    return { text: `${device.rssi} dBm${quality?.label ? `, ${quality.label}` : ''}`, key: quality?.label ?? null };
  });
  const week = (name) => (board) => {
    const counted = board.week;
    if (!counted) return { text: missingText, key: null };
    return { text: `${counted[name]}${counted.more ? '+' : ''}`, key: String(counted[name]) };
  };
  add('reboots', 'Unexpected restarts, 7 d', week('reboots'));
  add('issues', 'Issues, 7 d', week('issues'));
  if (memfault !== null) {
    const keys = memfault.FLEET_METRICS.filter((key) =>
      boards.some((board) => latestMetric(board.memfault, key) !== null)
    );
    for (const key of keys) {
      add(`metric-${key}`, memfault.metricOf(key).label, ({ memfault: data }) => {
        const value = latestMetric(data, key);
        if (value === null) return { text: missingText, key: null };
        const text = memfault.metricText(key, value);
        return { text, key: text };
      });
    }
  }
  return rows;
}

function boardHead(board) {
  const name = board.device?.name ?? null;
  return h(
    'header',
    { class: 'compare-board-head' },
    h('a', { class: 'compare-board-name', href: `#/devices/${board.thing}` }, name ?? mono(board.thing)),
    name ? h('span', { class: 'compare-board-thing mono' }, board.thing) : null
  );
}

function boardColumn(board, index, rows) {
  return h(
    'section',
    { key: board.thing, class: 'compare-board', 'aria-label': board.device?.name ?? board.thing },
    boardHead(board),
    h(
      'dl',
      { class: 'compare-facts' },
      rows.map((row) =>
        h(
          'div',
          { key: row.id, class: `compare-fact${row.differs ? ' is-different' : ''}` },
          h('dt', null, row.label),
          h(
            'dd',
            null,
            row.cells[index].text,
            row.differs ? [' ', h('span', { class: 'compare-differs' }, icon('swap', 'is-small'), 'differs')] : null
          )
        )
      )
    )
  );
}

/** The Compare page. */
export function compareView(ctx) {
  const { state } = ctx;
  const things = compareThings(state.filters?.compare);
  const head = pageHead({
    back: { href: '#/devices', label: 'Devices' },
    title: 'Compare boards',
    lede: 'Boards side by side: what differs between them is marked.',
  });
  if (things.length < 2) {
    return h(
      'div',
      { class: 'page is-compare' },
      head,
      card(
        { key: 'none' },
        empty({
          iconName: 'chip',
          title: `Pick 2 to ${COMPARE_MAX} boards to compare.`,
          text: 'Tick them on the Devices page, then Compare. A board’s page has Compare with… too.',
          action: { href: '#/devices', label: 'Devices' },
        })
      )
    );
  }
  const devices = state.devices?.value?.devices ?? null;
  if (devices === null) return h('div', { class: 'page is-compare' }, head, loading('the boards'));
  const boards = things.map((thing) => ({
    thing,
    device: devices.find((device) => device.thing === thing) ?? null,
    week: state.weekWarnings?.get(thing)?.value ?? null,
    memfault: state.memfault?.boards?.get(thing)?.value ?? null,
  }));
  const rows = compareRows(boards, { memfault: ctx.memfault ?? null });
  const differing = rows.filter((row) => row.differs).length;
  return h(
    'div',
    { class: 'page is-compare' },
    head,
    card(
      { key: 'facts', title: 'Side by side', className: 'compare-card' },
      h(
        'p',
        { class: 'ui-card-note card-note compare-summary', key: 'summary' },
        differing === 0
          ? 'These boards agree on everything compared.'
          : `${plural(differing, 'row differs', 'rows differ')}.`
      ),
      h(
        'div',
        { class: `compare-grid is-${boards.length}`, key: 'grid' },
        boards.map((board, index) => boardColumn(board, index, rows))
      )
    ),
    card(
      { key: 'timelines', title: 'Version timelines', className: 'compare-card' },
      h(
        'div',
        { class: `compare-grid is-${boards.length}`, key: 'grid' },
        boards.map((board) =>
          h(
            'section',
            {
              key: board.thing,
              class: 'compare-board',
              'aria-label': `Versions of ${board.device?.name ?? board.thing}`,
            },
            boardHead(board),
            timelineList(board.thing, ctx, { compact: true })
          )
        )
      )
    )
  );
}
