/**
 * Tests for the Events and Diagnostics pages (telemetry.js): how events become lanes and
 * online bands, what the filters leave, how readings become lines, what the pages say about
 * a board, and that the two pages draw, choose and refresh as they should. The script is the
 * very file the browser loads, drawing into the stand-in document of page.mjs.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE, TELEMETRY, VIEWS, all, createDocument, one, textOf, withText } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
const telemetry = await import(TELEMETRY);
globalThis.document = createDocument();

const NOW = Date.parse('2026-11-02T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const A = 'cranium-00000000000000aa';
const B = 'cranium-00000000000000bb';
const C = 'cranium-00000000000000cc';
const D = 'cranium-00000000000000dd';
const DEPLOYMENT = 'cranium-1-2-3-b5-20261102T110000Z-0a0a';

function board(thing, changes = {}) {
  return {
    thing,
    online: true,
    lastSeen: at(20_000),
    fw: { version: '1.10.0+0', confirmed: true },
    ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' },
    rssi: -52,
    uptime: 3600,
    stuck: { count: 0, reason: 'none' },
    diag: null,
    diary: null,
    bt: null,
    ...changes,
  };
}

let ids = 0;
function event(thing, msAgo, kind, what, text, extra = {}) {
  ids += 1;
  return { thing, at: at(msAgo), id: ids.toString(16).padStart(6, '0'), kind, what, level: 'info', text, ...extra };
}

const loaded = (value) => ({ value, error: null, loadedAt: NOW, loading: false });

/** The page's tools as app.js hands them over, with an API that answers from the test. */
function setup({
  devices = [board(A), board(B)],
  events = [],
  cursor = null,
  audit = [],
  route = { view: 'events' },
  samples = [],
  lines = null,
  linesCursor = null,
} = {}) {
  const state = { now: NOW, route, interval: 0, me: { canWrite: false }, devices: loaded({ devices }) };
  // No layout here: a wide plot, on which events minutes apart are still apart.
  telemetry.measurePlot(5000);
  const asked = [];
  const api = {
    async events(query) {
      asked.push(['events', query]);
      return query.cursor
        ? { events: [event(A, 5 * HOUR, 'firmware', 'changed', 'An older event')], cursor: null }
        : { events, cursor };
    },
    async audit(query) {
      asked.push(['audit', query]);
      return { entries: audit, next: null };
    },
    // An API from before the board log has no such route: the page goes on without it.
    async boardLog(query) {
      asked.push(['boardLog', query]);
      if (lines === null)
        throw Object.assign(new Error('There is nothing at this address.'), { status: 404, code: 'not_found' });
      return query.cursor
        ? { lines: [logLine(A, 9 * HOUR, 'app', 'Network is up', { id: '1.1' })], cursor: null }
        : { lines, cursor: linesCursor };
    },
    async devices() {
      asked.push(['devices']);
      return { devices };
    },
    async samples(thing, hours) {
      asked.push(['samples', thing, hours]);
      return { samples, hours, bucketSeconds: 0, from: at(DAY), to: at(0) };
    },
    async device(thing) {
      asked.push(['device', thing]);
      return {
        device: devices.find((item) => item.thing === thing),
        certificates: ['0123456789abcdef'],
        executions: [],
        olderExecutions: 0,
      };
    },
  };
  async function load(target, fetcher) {
    target.loading = true;
    try {
      target.value = await fetcher();
      target.error = null;
      target.loadedAt = NOW;
    } catch (error) {
      target.error = error;
    } finally {
      target.loading = false;
    }
  }
  const refreshed = [];
  const refresh = () => {
    refreshed.push(route.view);
    return route.view === 'events' ? telemetry.refreshEvents(true) : telemetry.refreshDiagnostics(true);
  };
  // As app.js: a filter goes into state.filters (and the address), and the page is read again.
  const setFilter = (view, name, value) => {
    state.filters ??= {};
    state.filters[view] = { ...state.filters[view], [name]: value };
    return refresh();
  };
  const clearFilters = (view) => {
    state.filters[view] = {};
    return refresh();
  };
  telemetry.connect({ state, api, load, draw: () => {}, clock: { now: () => NOW }, refresh, setFilter });
  const ctx = {
    state,
    actions: { refresh: () => {}, redraw: () => {}, copy: () => {}, setFilter, clearFilters, toggleFilters: () => {} },
  };
  return { state, api, asked, refreshed, ctx };
}

function drawn(node) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  views.render(root, node);
  return root;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Ranges and the time axis.

test('a preset ends now and moves with it; a range chosen by hand stays where it is', () => {
  const day = telemetry.rangeOf({ preset: '24h' }, NOW);
  assert.deepEqual([day.fromMs, day.toMs, day.live], [NOW - DAY, NOW, true]);
  assert.equal(telemetry.rangeWords(day), 'the last 24 hours, up to now');
  assert.deepEqual(
    telemetry.PRESETS.map((preset) => preset.label),
    ['1 h', '6 h', '24 h', '7 d', '30 d']
  );
  const fixed = telemetry.rangeOf({ fromMs: NOW - HOUR, toMs: NOW - MINUTE }, NOW + DAY);
  assert.deepEqual([fixed.fromMs, fixed.toMs, fixed.live], [NOW - HOUR, NOW - MINUTE, false]);
  assert.match(telemetry.rangeWords(fixed), / to /);
  assert.equal(telemetry.place(NOW - DAY / 2, NOW - DAY, NOW), 50);
  assert.equal(telemetry.place(NOW + HOUR, NOW - DAY, NOW), 100);
});

test('the axis has a few ticks on whole steps of local time, and names the day where one begins', () => {
  for (const [span, step] of [
    [HOUR, 10 * MINUTE],
    [DAY, 6 * HOUR],
    [7 * DAY, DAY],
    [30 * DAY, 7 * DAY],
  ]) {
    const ticks = telemetry.timeTicks(NOW - span, NOW, 7);
    assert.ok(ticks.length >= 3 && ticks.length <= 8, `${span}: ${ticks.length}`);
    for (const [index, tick] of ticks.entries()) {
      assert.ok(tick.ms >= NOW - span && tick.ms <= NOW);
      if (index > 0 && step < DAY) assert.equal(tick.ms - ticks[index - 1].ms, step);
      const date = new Date(tick.ms);
      if (step <= DAY) assert.equal(tick.newDay, date.getHours() === 0 && date.getMinutes() === 0);
    }
  }
});

test('a range typed by hand is checked before anything is asked for', () => {
  assert.match(telemetry.customRange('', '2026-11-01T10:00', NOW).error, /start and an end/);
  assert.match(telemetry.customRange('2026-11-01T10:00', '2026-11-01T09:00', NOW).error, /before the end/);
  assert.match(telemetry.customRange('2026-09-01T10:00', '2026-10-15T09:00', NOW).error, /31 days/);
  const chosen = telemetry.customRange('2026-11-01T10:00', '2026-11-01T11:30', NOW);
  assert.equal(chosen.toMs - chosen.fromMs, 90 * MINUTE);
  // An end in the future is now.
  assert.equal(telemetry.customRange(telemetry.localInput(NOW - HOUR), telemetry.localInput(NOW + DAY), NOW).toMs, NOW);
  assert.match(telemetry.localInput(NOW), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

// Lanes, bands and filters.

test('every board of the group has a lane, in the order of their names, and the console has the last', () => {
  const events = [event(B, MINUTE, 'firmware', 'changed', 'x'), event(D, MINUTE, 'restart', 'restarted', 'y')];
  const lanes = telemetry.lanesOf({ events, devices: [board(B), board(A)], consoleEvents: [] });
  assert.deepEqual(
    lanes.map((lane) => lane.id),
    [A, B, D, 'console']
  );
  assert.equal(lanes[0].events.length, 0);
  assert.equal(lanes[2].device, null, 'a board that is gone keeps its lane for its events');
  assert.deepEqual(
    telemetry.lanesOf({ events, devices: [board(A), board(B)], thing: B }).map((lane) => lane.id),
    [B]
  );
});

test('online bands follow connections, and the heartbeat where no connection says', () => {
  const span = { fromMs: NOW - HOUR, toMs: NOW };
  const presence = (msAgo, what) => event(A, msAgo, 'connection', what, what);
  const bands = (events, options = {}) =>
    telemetry
      .onlineBands(events, { ...span, ...options })
      .map((band) => [(band.fromMs - span.fromMs) / MINUTE, (band.toMs - span.fromMs) / MINUTE, band.inferred]);
  assert.deepEqual(bands([presence(50 * MINUTE, 'connected'), presence(40 * MINUTE, 'disconnected')]), [
    [10, 20, false],
  ]);
  // The first word is a disconnection: it was online until then.
  assert.deepEqual(bands([presence(45 * MINUTE, 'disconnected')]), [[0, 15, false]]);
  // AWS can say a thing twice.
  assert.deepEqual(
    bands([
      presence(50 * MINUTE, 'connected'),
      presence(49 * MINUTE, 'connected'),
      presence(40 * MINUTE, 'disconnected'),
      presence(39 * MINUTE, 'disconnected'),
    ]),
    [[10, 20, false]]
  );
  // Nothing in the range: what the heartbeat says now, for a range that ends now; nothing otherwise.
  assert.deepEqual(bands([], { live: true, device: board(A) }), [[0, 60, false]]);
  assert.deepEqual(bands([], { live: true, device: board(A, { online: false }) }), []);
  assert.deepEqual(bands([], { live: false, device: board(A) }), []);
  // Connected, then quiet without a word: until its heartbeat stopped counting.
  assert.deepEqual(
    bands([presence(50 * MINUTE, 'connected')], {
      live: true,
      device: board(A, { online: false, lastSeen: at(30 * MINUTE) }),
    }),
    [[10, 31.5, false]]
  );
  // Disconnected, and online now: since then, as far as is known.
  assert.deepEqual(bands([presence(50 * MINUTE, 'disconnected')], { live: true, device: board(A) }), [
    [0, 10, false],
    [10, 60, true],
  ]);
});

test('switched-off kinds are left out, and what is left is newest first', () => {
  const events = [
    event(A, 3 * MINUTE, 'update', 'step', 'old'),
    event(A, MINUTE, 'connection', 'connected', 'new'),
    event(A, 2 * MINUTE, 'health', 'memory', 'mid'),
  ];
  const lanes = [{ events }];
  assert.deepEqual(
    telemetry.shownEvents(lanes, new Set()).map((item) => item.text),
    ['new', 'mid', 'old']
  );
  assert.deepEqual(
    telemetry.shownEvents(lanes, new Set(['connection', 'update'])).map((item) => item.text),
    ['mid']
  );
});

test('events a few pixels apart are one spot with a count; zooming in or a wider plot pulls them apart', () => {
  const events = [
    event(A, 3 * MINUTE, 'update', 'step', 'old'),
    event(A, MINUTE, 'connection', 'connected', 'new'),
    event(A, 2 * MINUTE, 'health', 'memory', 'mid', { level: 'warn' }),
    event(A, 5 * HOUR, 'restart', 'boot', 'far'),
  ];
  const day = { fromMs: NOW - DAY, toMs: NOW };
  // A day on 390 px: the three minutes are one spot, newest first, standing for them by their warning.
  const narrow = telemetry.spotsOf(events, day, 358);
  assert.deepEqual(
    narrow.map((spot) => spot.events.map((item) => item.text)),
    [['new', 'mid', 'old'], ['far']]
  );
  assert.equal(narrow[0].lead.text, 'mid');
  assert.equal(narrow[0].at, events[1].at);
  assert.ok(narrow[0].x > 99 && narrow[0].x < 100);
  // Ten minutes on the same width (zoomed in): a minute is 36 px, so each stands alone (the far one is cut to the edge).
  assert.equal(telemetry.spotsOf(events, { fromMs: NOW - 10 * MINUTE, toMs: NOW }, 358).length, 4);
  assert.deepEqual(telemetry.spotsOf([], day), []);
});

test('every kind the API knows has a look, three hues by family and a shape of its own', () => {
  for (const kind of core.EVENT_KINDS)
    assert.ok(
      telemetry.KINDS.some((look) => look.id === kind),
      kind
    );
  assert.equal(new Set(telemetry.KINDS.map((look) => look.shape)).size, telemetry.KINDS.length);
  assert.deepEqual([...new Set(telemetry.KINDS.map((look) => look.tone))].sort(), ['a', 'b', 'c', 'quiet']);
  assert.equal(telemetry.kindOf('connection').tone, 'quiet');
  // Keys hold only what a selector can hold, and stay the same from one load to the next.
  const item = event(A, MINUTE, 'update', 'step', 'x');
  assert.match(telemetry.eventKey(item), /^[A-Za-z0-9_-]+$/);
  assert.equal(telemetry.eventKey(item), telemetry.eventKey({ ...item }));
  assert.match(
    telemetry.eventKey({ thing: null, at: item.at, id: 'Root=1-abc/def+=' }),
    /^console-\d+-Root_1_abc_def__$/
  );
});

test('an entry of the activity log is an event of the Console lane, a refusal a warning', () => {
  const entry = {
    at: at(MINUTE),
    actor: { sub: 'x', email: 'manager@example.invalid' },
    action: 'deployment.create',
    target: DEPLOYMENT,
    outcome: 'ok',
    detail: [],
    requestId: 'req-1',
  };
  const made = telemetry.consoleEvent(entry);
  assert.equal(made.kind, 'console');
  assert.equal(made.level, 'info');
  assert.match(made.text, /^manager@example\.invalid .*1\.2\.3\+5$/);
  assert.equal(made.href, `#/deployments/${DEPLOYMENT}`);
  const refused = telemetry.consoleEvent({ ...entry, outcome: 'rejected' });
  assert.equal(refused.level, 'warn');
  assert.match(refused.text, /\(refused\)$/);
});

// What a board reports, in words.

test('what a board reports is said in words: restarts, boots, memory and missing reports', () => {
  assert.equal(telemetry.causeWords(['watchdog']), 'the watchdog');
  assert.equal(telemetry.causeWords(['brownout', 'lockup']), 'a brownout and a CPU lockup');
  assert.equal(telemetry.causeWords(['pll', 'clock']), 'a clock fault');
  assert.equal(telemetry.causeWords([]), 'an unknown cause');
  assert.equal(telemetry.stageWords(4), 'Reached the cloud');
  assert.equal(telemetry.stageWords(9), 'Stage 9');

  const rows = telemetry.diaryRows({
    boots: 9,
    entries: [
      { version: '1.10.0+0', cause: '1', causes: ['pin'], stage: 4 },
      { version: '1.10.0+0', cause: '10', causes: ['watchdog'], stage: 3 },
    ],
  });
  assert.deepEqual(
    rows.map((row) => [row.boot, row.running, row.before, row.reached, row.bad]),
    [
      [9, true, 'the reset pin', 'Reached the cloud', false],
      [8, false, 'the watchdog', 'Got onto the network', true],
    ]
  );
  assert.deepEqual(telemetry.diaryRows(null), []);

  assert.equal(telemetry.stuckWords(null), null);
  assert.equal(telemetry.stuckWords({ count: 0, reason: 'none' }).tone, 'good');
  assert.equal(
    telemetry.stuckWords({ count: 2, reason: 'wifi_silent' }).text,
    'Restarted itself 2 times in a row for being stuck; the last time because the Wi-Fi chip stopped answering'
  );

  const heap = telemetry.heapWords({ free: 21312, least: 9840, size: 44240 });
  assert.deepEqual([heap.tone, heap.used, heap.leastUsed, heap.text], ['live', 52, 78, '21 KiB free of 43 KiB']);
  assert.equal(heap.least, 'At least 10 KiB has stayed free since it started (22%)');
  assert.equal(heap.ranLow, false);
  assert.equal(telemetry.heapWords({ free: 10000, least: 9000, size: 44240 }).tone, 'warn');
  assert.equal(telemetry.heapWords({ free: 6000, least: 6000, size: 44240 }).tone, 'bad');
  // Short earlier in this boot and fine now: the bar goes by now, the words say what happened.
  const earlier = telemetry.heapWords({ free: 20000, least: 6000, size: 44240 });
  assert.deepEqual([earlier.tone, earlier.ranLow], ['live', true]);
  assert.deepEqual(telemetry.stuckWords({ count: 1, reason: 'no_cloud' }), {
    tone: 'warn',
    badge: 'Once',
    text: 'Restarted itself once for being stuck, because no connection to the cloud for 15 minutes',
  });
  assert.equal(telemetry.heapWords(null), null);

  assert.equal(
    telemetry.diagMissing(board(A, { fw: { version: '1.9.0+0', confirmed: true } })),
    'Needs firmware 1.10.0 or later. This board runs 1.9.0+0.'
  );
  assert.equal(
    telemetry.diagMissing(board(A, { fw: null })),
    'Needs firmware 1.10.0 or later. This board has not said what it runs.'
  );
  assert.match(
    telemetry.diagMissing(board(A, { fw: { version: '1.10.1+0', confirmed: true } })),
    /^No diagnostics report yet/
  );
  assert.match(
    telemetry.diagMissing(board(A, { fw: { version: '2.0.0+0', confirmed: true } })),
    /^No diagnostics report yet/
  );
  assert.equal(
    telemetry.diaryMissing(board(A, { fw: { version: '1.7.3+9', confirmed: true } })),
    'Needs firmware 1.7.4 or later. This board runs 1.7.3+9.'
  );

  assert.equal(telemetry.heartbeatAge(at(20_000), NOW), '20 s ago');
  assert.equal(telemetry.heartbeatAge(at(119_000), NOW), '119 s ago');
  assert.equal(telemetry.heartbeatAge(at(3 * MINUTE), NOW), '3 min ago');
  assert.equal(telemetry.uptimeNow(board(A, { uptime: 100 }), NOW), 120);
  assert.equal(telemetry.uptimeNow(board(A, { uptime: 100, online: false }), NOW), 100);
  assert.equal(telemetry.uptimeNow(board(A, { uptime: null }), NOW), null);
});

// Readings.

test('a gap in the readings breaks the line, and the table has every hour', () => {
  const points = [0, 30, 60, 90, 700, 730].map((seconds) => ({
    ms: NOW - HOUR + seconds * 1000,
    v: -50 - seconds / 30,
  }));
  const runs = telemetry.lineRuns(points, telemetry.gapFor(0));
  assert.deepEqual(
    runs.map((run) => run.length),
    [4, 2]
  );
  assert.equal(telemetry.gapFor(0), 150_000);
  assert.equal(telemetry.gapFor(1008), 2_520_000);
  assert.deepEqual(telemetry.lineRuns([], 1), []);

  const samples = [
    { at: at(HOUR), rssi: -60, heapFree: null },
    { at: at(HOUR - 1000), rssi: null, heapFree: 100 },
  ];
  assert.deepEqual(telemetry.pointsOf(samples, 'rssi'), [{ ms: NOW - HOUR, v: -60 }]);
  assert.deepEqual(telemetry.pointsOf(samples, 'heapFree'), [{ ms: NOW - HOUR + 1000, v: 100 }]);

  const hours = telemetry.hourlyRows([
    { ms: Date.parse('2026-11-02T10:05:00Z'), v: -60 },
    { ms: Date.parse('2026-11-02T10:35:00Z'), v: -50 },
    { ms: Date.parse('2026-11-02T11:05:00Z'), v: -70 },
  ]);
  assert.deepEqual(
    hours.map((row) => [row.low, row.mean, row.high, row.count]),
    [
      [-70, -70, -70, 1],
      [-60, -55, -50, 2],
    ]
  );
});

// The Events page.

/** A line of a board's log, as the API's client reads it. */
function logLine(thing, msAgo, tag, text, extra = {}) {
  const kinds = {
    WIFI: 'health',
    net: 'health',
    BT: 'bluetooth',
    CONSOLE: 'setting',
    app: 'log',
    ota: 'update',
    STUCK: 'restart',
  };
  return {
    thing,
    at: at(msAgo),
    id: `42.${Math.round(msAgo / 1000)}`,
    kind: kinds[tag],
    tag,
    level: 'info',
    text,
    boot: 42,
    seq: Math.round(msAgo / 1000),
    dropped: null,
    ...extra,
  };
}

function eventsWorld() {
  return {
    devices: [board(A), board(B, { online: false, lastSeen: at(2 * HOUR) })],
    events: [
      event(A, 10 * MINUTE, 'update', 'result', 'Update to 1.2.3+5 failed: download_failed', {
        level: 'warn',
        result: 'failed',
        error: 'download_failed',
        job: DEPLOYMENT,
      }),
      event(A, 30 * MINUTE, 'update', 'step', 'Downloading 1.2.3+5', {
        job: DEPLOYMENT,
        state: 'downloading',
        progress: 0,
      }),
      event(B, 2 * HOUR, 'connection', 'disconnected', 'Disconnected from AWS IoT: the connection was lost'),
      event(A, 5 * HOUR, 'connection', 'connected', 'Connected to AWS IoT'),
      event(B, 6 * HOUR, 'restart', 'boot', 'Last boot ended by the watchdog; it had reached the cloud', {
        level: 'warn',
      }),
    ],
    audit: [
      {
        at: at(40 * MINUTE),
        actor: { sub: 's', email: 'manager@example.invalid' },
        action: 'deployment.create',
        target: DEPLOYMENT,
        outcome: 'ok',
        detail: [],
        requestId: 'req-1',
      },
    ],
  };
}

test('the Events page loads the last day of every board with the console beside it, and says when there is nothing', async () => {
  const world = setup({ events: [], devices: [board(A)] });
  assert.match(textOf(drawn(telemetry.eventsView(world.ctx))), /Loading events/);
  await telemetry.refreshEvents(true);
  const [kind, query] = world.asked.find(([name]) => name === 'events');
  assert.equal(kind, 'events');
  assert.deepEqual(query, { from: at(DAY), to: at(0), thing: null });
  assert.ok(world.asked.some(([name, asked]) => name === 'audit' && asked.limit === 100));
  const page = drawn(telemetry.eventsView(world.ctx));
  assert.match(textOf(page), /No events in this range\./);
  assert.equal(all(page, 'svg.tl-mark').length, 0);
  assert.match(textOf(one(page, 'text.tl-lane-name', A)), /No events/);
  assert.equal(telemetry.eventsInterval(world.state), telemetry.EVENTS_REFRESH_MS);
});

test('the timeline has a lane per board and the console, a marker per event and a band while online', async () => {
  const world = setup(eventsWorld());
  await telemetry.refreshEvents(true);
  const page = drawn(telemetry.eventsView(world.ctx));
  assert.deepEqual(
    all(page, 'text.tl-lane-name').map((lane) => lane.childNodes[0].textContent),
    [A, B, 'Console']
  );
  assert.equal(all(page, 'svg.tl-mark').length, 6);
  assert.equal(all(page, 'svg.tl-mark.is-warn').length, 2);
  // One marker is reached with Tab; the arrow keys move between the rest.
  assert.equal(all(page, 'svg.tl-mark').filter((mark) => mark.getAttribute('tabindex') === '0').length, 1);
  assert.ok(all(page, 'rect.tl-band').length >= 2);
  for (const mark of all(page, 'svg.tl-mark')) assert.match(mark.getAttribute('aria-label'), /: /);
  // The legend is the filter: one chip per kind, all on, with the counts of what is shown.
  const chips = all(page, 'button.chip');
  assert.deepEqual(
    chips.map((chip) => chip.children.slice(1).map((part) => part.textContent)),
    [
      ['Update', '2'],
      ['Firmware'],
      ['Restart', '1'],
      ['Wi-Fi and memory'],
      ['Bluetooth'],
      ['Console', '1'],
      ['Settings'],
      ['Other lines'],
      ['Connection', '2'],
    ]
  );
  assert.ok(chips.every((chip) => chip.getAttribute('aria-pressed') === 'true'));
  // The table lists the same events, newest first, under their day.
  const rows = all(page, 'tr.event-row');
  assert.equal(rows.length, 6);
  assert.match(textOf(rows[0]), /Update to 1\.2\.3\+5 failed: download_failed Warning Deployment/);
  assert.match(textOf(rows[2]), /^.*Console.*manager@example\.invalid/);
  assert.equal(all(page, 'tr.event-day').length >= 1, true);
  assert.match(textOf(one(page, 'p.event-count')), /6 events.*2 warnings/);
});

test('on a narrow plot, events close together are one marker with their number, which lists each with its time', async () => {
  const world = setup({
    devices: [board(A)],
    events: [
      event(A, 10 * MINUTE, 'update', 'result', 'Update failed: download_failed', { level: 'warn' }),
      event(A, 11 * MINUTE, 'update', 'step', 'Downloading 1.2.3+5'),
      event(A, 12 * MINUTE, 'connection', 'connected', 'Connected to AWS IoT'),
      event(A, 6 * HOUR, 'restart', 'boot', 'Last boot ended by the watchdog'),
    ],
  });
  telemetry.measurePlot(358);
  await telemetry.refreshEvents(true);
  let page = drawn(telemetry.eventsView(world.ctx));
  const marks = all(page, 'svg.tl-mark').filter((mark) => /^cranium-/.test(mark.getAttribute('aria-label')));
  assert.equal(marks.length, 2, 'three events in a few pixels are one marker, the fourth is another');
  const group = marks.find((mark) => /3 events/.test(mark.getAttribute('aria-label')));
  assert.match(group.getAttribute('aria-label'), /Includes a warning/);
  assert.equal(textOf(one(group, 'g.tl-count')), '3');
  assert.equal(group.getAttribute('tabindex'), '0');
  // Hovering lists every event of it, newest first, each with its time and its kind.
  group.dispatchEvent({ type: 'pointerenter' });
  page = drawn(telemetry.eventsView(world.ctx));
  const rows = all(one(page, 'div.timeline-tip'), 'li.tip-row');
  assert.equal(rows.length, 3);
  assert.match(textOf(rows[0]), /Update failed: download_failed.*Nov 2, 2026, \d+:50:00 [AP]M.*Update.*warning/);
  assert.match(textOf(rows[2]), /Connected to AWS IoT.*\d+:48:00 [AP]M.*Connection/);
  assert.match(textOf(one(page, 'div.timeline-tip')), /3 events close together/);
  // The keyboard gets there too: Enter picks the newest of them, and its row in the table.
  group.dispatchEvent({ type: 'pointerleave' });
  group.dispatchEvent({ type: 'keydown', key: 'Enter' });
  page = drawn(telemetry.eventsView(world.ctx));
  assert.match(textOf(one(page, 'tr.event-row.is-selected')), /download_failed/);
  assert.equal(all(page, 'svg.tl-mark.is-selected').length, 1);
  assert.equal(all(page, 'div.timeline-tip').length, 1, 'the readout stays for the marker that was picked');
  // The key says what each drawn mark means, and only the kinds that are drawn.
  assert.deepEqual(
    all(one(page, 'ul.tl-key'), 'li').map((item) => textOf(item)),
    ['Update', 'Restart', 'Connection', 'A number: that many events close together', 'Board online']
  );
  telemetry.measurePlot(5000);
});

test("the range last chosen is the next visit's, 6 h among them, and a browser that keeps nothing opens on 24 h", async () => {
  const kept = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, String(value)) },
  });
  try {
    let world = setup(eventsWorld());
    await telemetry.refreshEvents(true);
    let page = drawn(telemetry.eventsView(world.ctx));
    assert.deepEqual(
      all(one(page, 'div.segmented'), 'button')
        .slice(0, 4)
        .map((button) => textOf(button)),
      ['1 h', '6 h', '24 h', '7 d']
    );
    assert.equal(one(page, 'button.segmented-option', '24 h').getAttribute('aria-pressed'), 'true');
    one(page, 'button.segmented-option', '6 h').dispatchEvent({ type: 'click' });
    await settle();
    assert.equal(kept.get('cranium.events.range'), '6h');
    assert.equal(world.asked.filter(([name]) => name === 'events').at(-1)[1].from, at(6 * HOUR));
    // A new visit: a page of its own, which opens on what was chosen.
    world = setup(eventsWorld());
    await telemetry.refreshEvents(true);
    page = drawn(telemetry.eventsView(world.ctx));
    assert.equal(one(page, 'button.segmented-option', '6 h').getAttribute('aria-pressed'), 'true');
    assert.equal(world.asked.find(([name]) => name === 'events')[1].from, at(6 * HOUR));
    kept.set('cranium.events.range', 'nonsense');
    world = setup(eventsWorld());
    assert.equal(telemetry.rangeOf(world.state.eventLog?.range ?? { preset: '24h' }, NOW).preset.id, '24h');
  } finally {
    delete globalThis.localStorage;
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem() {
        throw new Error('blocked');
      },
    },
  });
  try {
    const world = setup(eventsWorld());
    await telemetry.refreshEvents(true);
    assert.equal(world.asked.find(([name]) => name === 'events')[1].from, at(DAY));
  } finally {
    delete globalThis.localStorage;
  }
});

test('picking a marker marks its row, picking a row marks its marker, and the tooltip names every event at that spot', async () => {
  const world = setup(eventsWorld());
  await telemetry.refreshEvents(true);
  let page = drawn(telemetry.eventsView(world.ctx));
  const mark = all(page, 'svg.tl-mark').find((el) => /download_failed/.test(el.getAttribute('aria-label')));
  mark.dispatchEvent({ type: 'click' });
  page = drawn(telemetry.eventsView(world.ctx));
  assert.match(textOf(one(page, 'tr.event-row.is-selected')), /download_failed/);
  assert.equal(all(page, 'svg.tl-mark.is-selected').length, 1);
  assert.match(textOf(one(page, 'div.timeline-tip')), /Update to 1\.2\.3\+5 failed: download_failed/);

  one(page, 'tr.event-row', 'Last boot ended').children[0].children[0].dispatchEvent({ type: 'click' });
  page = drawn(telemetry.eventsView(world.ctx));
  assert.match(textOf(one(page, 'tr.event-row.is-selected')), /Last boot ended/);
  assert.match(one(page, 'svg.tl-mark.is-selected').getAttribute('aria-label'), /watchdog/);
  // Picked again: let go.
  one(page, 'tr.event-row', 'Last boot ended').children[0].children[0].dispatchEvent({ type: 'click' });
  page = drawn(telemetry.eventsView(world.ctx));
  assert.equal(all(page, 'tr.event-row.is-selected').length, 0);
});

test('the arrow keys move along a lane and between lanes, and Escape lets go', async () => {
  const world = setup(eventsWorld());
  await telemetry.refreshEvents(true);
  let page = drawn(telemetry.eventsView(world.ctx));
  const reachable = () => all(page, 'svg.tl-mark').find((el) => el.getAttribute('tabindex') === '0');
  // The newest of the first lane, to begin with.
  assert.match(reachable().getAttribute('aria-label'), /download_failed/);
  reachable().dispatchEvent({ type: 'keydown', key: 'ArrowLeft' });
  page = drawn(telemetry.eventsView(world.ctx));
  assert.match(reachable().getAttribute('aria-label'), /Downloading/);
  reachable().dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
  page = drawn(telemetry.eventsView(world.ctx));
  assert.match(reachable().getAttribute('aria-label'), new RegExp(B));
  reachable().dispatchEvent({ type: 'keydown', key: 'Enter' });
  page = drawn(telemetry.eventsView(world.ctx));
  assert.equal(all(page, 'tr.event-row.is-selected').length, 1);
  reachable().dispatchEvent({ type: 'keydown', key: 'Escape' });
  page = drawn(telemetry.eventsView(world.ctx));
  assert.equal(all(page, 'tr.event-row.is-selected').length, 0);
});

test('presets, the board, the kinds and a drag across the timeline each ask again for what they show', async () => {
  const world = setup(eventsWorld());
  await telemetry.refreshEvents(true);
  const lastQuery = () => world.asked.filter(([name]) => name === 'events').at(-1)[1];
  let page = drawn(telemetry.eventsView(world.ctx));

  one(page, 'button.segmented-option', '7 d').dispatchEvent({ type: 'click' });
  await settle();
  assert.deepEqual([lastQuery().from, lastQuery().to], [at(7 * DAY), at(0)]);
  page = drawn(telemetry.eventsView(world.ctx));
  assert.equal(one(page, 'button.segmented-option', '7 d').getAttribute('aria-pressed'), 'true');

  const select = one(page, 'select', 'All boards');
  select.value = B;
  select.dispatchEvent({ type: 'change' });
  await settle();
  assert.equal(lastQuery().thing, B);

  page = drawn(telemetry.eventsView(world.ctx));
  one(page, 'button.chip', 'Update').dispatchEvent({ type: 'click' });
  await settle();
  assert.deepEqual(lastQuery().kinds, ['connection', 'firmware', 'restart', 'bluetooth', 'health']);
  // Connections are still read with their markers hidden: the online bands come from them.
  page = drawn(telemetry.eventsView(world.ctx));
  one(page, 'button.chip', 'Connection').dispatchEvent({ type: 'click' });
  await settle();
  assert.deepEqual(lastQuery().kinds, ['connection', 'firmware', 'restart', 'bluetooth', 'health']);
  page = drawn(telemetry.eventsView(world.ctx));
  assert.equal(
    all(page, 'svg.tl-mark').some((mark) => /AWS IoT/.test(mark.getAttribute('aria-label'))),
    false
  );
  assert.ok(all(page, 'rect.tl-band').length >= 1);
  one(page, 'button.chip', 'Console').dispatchEvent({ type: 'click' });
  const audits = world.asked.filter(([name]) => name === 'audit').length;
  await settle();
  assert.equal(
    world.asked.filter(([name]) => name === 'audit').length,
    audits,
    'the console lane is not read while it is off'
  );

  // Dragging from a tenth to three tenths of the width zooms in there; Zoom out goes back.
  page = drawn(telemetry.eventsView(world.ctx));
  const plot = one(page, 'div.timeline-plot');
  plot.getBoundingClientRect = () => ({ left: 0, width: 1000 });
  plot.setPointerCapture = () => {};
  plot.dispatchEvent({ type: 'pointerdown', button: 0, isPrimary: true, pointerId: 1, clientX: 100 });
  plot.dispatchEvent({ type: 'pointermove', pointerId: 1, clientX: 300 });
  plot.dispatchEvent({ type: 'pointerup', pointerId: 1, clientX: 300 });
  await settle();
  assert.deepEqual(
    [lastQuery().from, lastQuery().to],
    [new Date(NOW - 7 * DAY + 0.1 * 7 * DAY).toISOString(), new Date(NOW - 7 * DAY + 0.3 * 7 * DAY).toISOString()]
  );
  assert.equal(telemetry.eventsInterval(world.state), 0, 'a range in the past is not refreshed');
  page = drawn(telemetry.eventsView(world.ctx));
  one(page, 'button', 'Zoom out').dispatchEvent({ type: 'click' });
  await settle();
  assert.deepEqual([lastQuery().from, lastQuery().to], [at(7 * DAY), at(0)]);
});

test('a range typed by hand that is not one is said, and nothing is asked for', async () => {
  const world = setup(eventsWorld());
  await telemetry.refreshEvents(true);
  const before = world.asked.length;
  let page = drawn(telemetry.eventsView(world.ctx));
  one(page, 'button.segmented-option', 'Custom').dispatchEvent({ type: 'click' });
  page = drawn(telemetry.eventsView(world.ctx));
  const [from, to] = all(one(page, 'form.custom-range'), 'input');
  from.value = '2026-11-02T10:00';
  from.dispatchEvent({ type: 'input' });
  to.value = '2026-11-01T10:00';
  to.dispatchEvent({ type: 'input' });
  one(page, 'form.custom-range').dispatchEvent({ type: 'submit' });
  page = drawn(telemetry.eventsView(world.ctx));
  assert.match(textOf(one(page, 'p.custom-error')), /before the end/);
  assert.equal(world.asked.length, before);
});

test('more events of a long range are loaded by hand, and the page then holds still', async () => {
  const world = setup({ ...eventsWorld(), cursor: 'next-page' });
  await telemetry.refreshEvents(true);
  let page = drawn(telemetry.eventsView(world.ctx));
  assert.match(textOf(one(page, 'p.event-count')), /more in this range/);
  assert.ok(all(page, 'g.tl-unloaded').length === 1, 'where the loaded events begin is marked');
  one(page, 'button', 'Load 500 more').dispatchEvent({ type: 'click' });
  await settle();
  page = drawn(telemetry.eventsView(world.ctx));
  assert.equal(all(page, 'tr.event-row').length, 7);
  assert.equal(withText(page, 'button', 'Load 500 more').length, 0);
  assert.equal(telemetry.eventsHoldStill(world.state), true);
});

test('a failed load of the events says so, with a way to try again', async () => {
  const world = setup(eventsWorld());
  world.api.events = async () => {
    throw new core.ApiError(400, 'invalid_range', 'A range of events may be at most 31 days long.');
  };
  await telemetry.refreshEvents(true);
  const page = drawn(telemetry.eventsView(world.ctx));
  assert.match(textOf(page), /Could not load the events\. A range of events may be at most 31 days long\./);
  assert.ok(withText(page, 'button', 'Try again').length >= 1);
});

// The Diagnostics page.

function diagnosed(thing, changes = {}) {
  return board(thing, {
    stuck: { count: 2, reason: 'wifi_silent' },
    diag: { mac: 'f4:ce:36:12:34:56', channel: 6, heap: { free: 21312, least: 9840, size: 44240 }, at: at(4 * MINUTE) },
    diary: {
      boots: 9,
      entries: [
        { version: '1.10.0+0', cause: '1', causes: ['pin'], stage: 4 },
        { version: '1.10.0+0', cause: '10', causes: ['watchdog'], stage: 3 },
      ],
    },
    bt: { from: '1.5.0+0', to: '1.6.0+0', result: 'succeeded', proof: 'person', count: 3 },
    ...changes,
  });
}

const SAMPLES = Array.from({ length: 48 }, (_, index) => ({
  at: at(DAY - index * 30 * MINUTE),
  rssi: -60 + (index % 5),
  uptime: index * 1800,
  heapFree: 20000 + index * 10,
  heapLeast: 9000,
}));

test('the Diagnostics page has a card for each of a few boards, with what each reports and its charts', async () => {
  const old = board(B, { fw: { version: '1.9.0+0', confirmed: true }, online: false, lastSeen: at(3 * MINUTE) });
  const world = setup({ devices: [diagnosed(A), old], route: { view: 'diagnostics' }, samples: SAMPLES });
  assert.match(
    textOf(
      drawn(
        telemetry.diagnosticsView({
          ...world.ctx,
          state: { ...world.state, devices: { value: null, error: null, loading: true, loadedAt: 0 } },
        })
      )
    ),
    /Loading the boards/
  );
  await telemetry.refreshDiagnostics(true);
  assert.deepEqual(
    world.asked.filter(([name]) => name === 'samples').map(([, thing, hours]) => [thing, hours]),
    [
      [A, 24],
      [B, 24],
    ]
  );
  const page = drawn(telemetry.diagnosticsView(world.ctx));
  const [first, second] = all(page, 'section.diag-card');
  assert.equal(all(page, 'section.diag-card').length, 2);
  assert.equal(all(page, 'nav.board-picker').length, 0);

  const text = textOf(first);
  assert.match(text, /Last heartbeat 20 s ago/);
  assert.match(text, /Online/);
  assert.match(text, /Uptime 1 h/);
  assert.match(text, /1\.10\.0\+0 Confirmed/);
  assert.match(
    text,
    /2 in a row Restarted itself 2 times in a row for being stuck; the last time because the Wi-Fi chip stopped answering/
  );
  assert.match(text, /Excellent · −52 dBm/);
  assert.match(text, /Channel 6 · MAC f4:ce:36:12:34:56/);
  assert.match(text, /21 KiB free of 43 KiB/);
  assert.match(text, /0123456789abcdef…/);
  const boots = all(first, 'table.boot-table')[0].children[2].children.map((row) =>
    row.children.map((cell) => textOf(cell))
  );
  assert.deepEqual(boots, [
    ['#9 (running)', '1.10.0+0', 'the reset pin', 'Reached the cloud so far'],
    ['#8', '1.10.0+0', 'Fault the watchdog', 'Got onto the network'],
  ]);
  assert.match(text, /Kept by a person at the board/);
  assert.match(textOf(one(first, 'figure.chart', 'Wi-Fi signal')), /Now −58 dBm · lowest −60 dBm · highest −56 dBm/);
  assert.match(textOf(one(first, 'figure.chart', 'Free memory')), /Now 20\.0 KiB/);
  assert.equal(all(first, 'details.chart-table').length, 2);

  const quiet = textOf(second);
  assert.match(quiet, /Offline/);
  assert.match(quiet, /Last heartbeat 180 s ago|Last heartbeat 3 min ago/);
  assert.match(quiet, /Needs firmware 1\.10\.0 or later\. This board runs 1\.9\.0\+0\./);
  assert.match(quiet, /No boot diary yet/);
  assert.match(quiet, /No update over Bluetooth recorded/);
  assert.equal(telemetry.shownBoards([diagnosed(A), old], null).length, 2);
});

test('the heartbeat age counts up every second, and a chart reads out where the keyboard is', async () => {
  const world = setup({ devices: [diagnosed(A)], route: { view: 'diagnostics' }, samples: SAMPLES });
  await telemetry.refreshDiagnostics(true);
  world.state.now = NOW + 5000;
  let page = drawn(telemetry.diagnosticsView(world.ctx));
  assert.match(textOf(one(page, 'p.diag-heartbeat')), /25 s ago/);
  const plot = one(page, 'figure.chart', 'Wi-Fi signal').children[1].children[1];
  assert.equal(plot.getAttribute('tabindex'), '0');
  assert.match(plot.getAttribute('aria-label'), /^Wi-Fi signal, 24 h, from the heartbeat/);
  plot.dispatchEvent({ type: 'focus' });
  page = drawn(telemetry.diagnosticsView(world.ctx));
  assert.match(textOf(one(page, 'span.chart-tip')), /^−58 dBm\s*Good/);
  // The keyboard's reading is said to a screen reader too.
  assert.match(textOf(one(one(page, 'figure.chart', 'Wi-Fi signal'), 'span.sr-only')), /^−58 dBm at /);
  one(page, 'figure.chart', 'Wi-Fi signal').children[1].children[1].dispatchEvent({
    type: 'keydown',
    key: 'Home',
    preventDefault() {},
  });
  page = drawn(telemetry.diagnosticsView(world.ctx));
  assert.match(textOf(one(page, 'span.chart-tip')), /^−60 dBm\s*Good/);
});

test('with many boards there is a list to pick from and one card, and an unknown board is said to be unknown', async () => {
  const devices = [A, B, C, D].map((thing) => diagnosed(thing));
  const world = setup({ devices, route: { view: 'diagnostics', thing: C }, samples: [] });
  await telemetry.refreshDiagnostics(true);
  assert.deepEqual(
    world.asked.filter(([name]) => name === 'samples').map(([, thing]) => thing),
    [C]
  );
  let page = drawn(telemetry.diagnosticsView(world.ctx));
  assert.equal(all(page, 'section.diag-card').length, 1);
  const links = all(page, 'a.picker-link');
  assert.deepEqual(
    links.map((link) => link.getAttribute('href')),
    [A, B, C, D].map((thing) => `#/diagnostics/${thing}`)
  );
  assert.equal(links[2].getAttribute('aria-current'), 'page');
  assert.match(textOf(one(page, 'figure.chart', 'Wi-Fi signal')), /No readings in the last 24 hours\./);
  assert.equal(
    telemetry
      .shownBoards(devices, null)
      .map((device) => device.thing)
      .join(),
    A
  );

  world.state.route = { view: 'diagnostics', thing: 'cranium-00000000000000ee' };
  page = drawn(telemetry.diagnosticsView(world.ctx));
  assert.match(textOf(page), /No board with this name is registered\./);
});

// A board's own name: shown first, with its thing name second or in its tooltip.

test("a lane is labelled with the board's name and keeps its thing name, in the order of the thing names", () => {
  const events = [event(B, MINUTE, 'health', 'named', 'Reported its name CRVIHAAN01', { name: 'CRVIHAAN01' })];
  const lanes = telemetry.lanesOf({ events, devices: [board(B, { name: 'CRVIHAAN01' }), board(A)], consoleEvents: [] });
  assert.deepEqual(
    lanes.map((lane) => [lane.id, lane.thing, lane.label]),
    [
      [A, A, A],
      [B, B, 'CRVIHAAN01'],
      ['console', null, 'Console'],
    ]
  );
});

test('two boards that report the same name are told apart in the list to choose from', () => {
  const devices = [board(A, { name: 'CR01' }), board(B, { name: 'CR01' }), board(C, { name: 'CR02' }), board(D)];
  assert.deepEqual(
    telemetry.boardChoices([A, B, C, D], devices).map((choice) => choice.label),
    [`CR01 · ${A}`, `CR01 · ${B}`, 'CR02', D]
  );
});

test('the Events page calls a board by its name in its lane, its tooltip, its rows and the list to choose from', async () => {
  const world = setup({
    ...eventsWorld(),
    devices: [board(A, { name: 'CRVIHAAN01' }), board(B, { online: false, lastSeen: at(2 * HOUR) })],
  });
  await telemetry.refreshEvents(true);
  let page = drawn(telemetry.eventsView(world.ctx));

  // The lane: the name, then the thing name, quieter, then its state.
  const lane = one(page, 'text.tl-lane-name', 'CRVIHAAN01');
  assert.equal(lane.childNodes[0].textContent, 'CRVIHAAN01');
  assert.equal(textOf(one(lane, 'tspan.tl-lane-thing')), A);
  assert.equal(all(one(page, 'text.tl-lane-name', B), 'tspan.tl-lane-thing').length, 0);
  const mark = all(page, 'svg.tl-mark').find((el) => /download_failed/.test(el.getAttribute('aria-label')));
  assert.match(mark.getAttribute('aria-label'), /^CRVIHAAN01, /);

  // The table: the name, linked to the board, with the thing name as its tooltip.
  const row = one(page, 'tr.event-row', 'download_failed');
  const cell = one(one(row, 'td.event-board'), 'a');
  assert.equal(textOf(cell), 'CRVIHAAN01');
  assert.equal(cell.getAttribute('title'), A);
  assert.equal(cell.getAttribute('href'), `#/devices/${A}`);
  assert.equal(textOf(one(one(page, 'tr.event-row', 'connection was lost'), 'td.event-board')), B);

  // The list to choose a board from: the name, for the thing name it stands for.
  const options = all(one(page, 'select', 'All boards'), 'option');
  assert.deepEqual(
    options.map((option) => [option.value, textOf(option)]),
    [
      ['', 'All boards (2)'],
      [A, 'CRVIHAAN01'],
      [B, B],
    ]
  );
  assert.equal(options[1].getAttribute('title'), A);

  // The tooltip over a marker: the name and the thing name.
  mark.dispatchEvent({ type: 'click' });
  page = drawn(telemetry.eventsView(world.ctx));
  assert.equal(textOf(one(page, 'p.tip-head')), `CRVIHAAN01 ${A}`);
});

test('the board log lists every line with its board, source and kind, ticks the lanes, and keeps the events as they were', async () => {
  const lines = [
    logLine(A, 2 * MINUTE, 'WIFI', 'connected ip=10.0.0.7 rssi=-51'),
    logLine(B, 3 * MINUTE, 'CONSOLE', 'WIFI done on the serial console: save a WPA2 network and join it'),
    logLine(A, 4 * MINUTE, 'ota', 'WRN: Download stalled at 40%', { level: 'warn', dropped: 3 }),
  ];
  const world = setup({ ...eventsWorld(), devices: [board(A, { name: 'CRVIHAAN01' }), board(B)], lines });
  await telemetry.refreshEvents(true);
  const [, query] = world.asked.find(([name]) => name === 'boardLog');
  assert.deepEqual(query, { from: at(DAY), to: at(0), thing: null });
  const page = drawn(telemetry.eventsView(world.ctx));
  const card = one(page, 'section.log-card');
  const rows = all(card, 'tr.log-row');
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => textOf(one(row, 'td.event-kind'))),
    ['WIFI', 'CONSOLE', 'ota']
  );
  assert.equal(textOf(one(one(rows[0], 'td.event-board'), 'a')), 'CRVIHAAN01');
  assert.match(textOf(rows[2]), /WRN: Download stalled at 40% Warning 3 lines lost before this one/);
  assert.equal(rows[2].getAttribute('title'), 'Boot 42, line 240 of that boot');
  assert.match(textOf(one(card, 'p.event-count')), /3 lines.*1 warning/);
  // Ticks at the foot of each board's lane, out of the way of the keyboard and the screen reader.
  assert.equal(all(page, 'line.tl-log-tick').length, 3);
  assert.equal(all(page, 'line.tl-log-tick.is-warn').length, 1);
  assert.deepEqual(
    all(page, 'g.tl-log').map((group) => group.getAttribute('aria-hidden')),
    ['true', 'true']
  );
  // The markers and the table of events are what they were; the chips count lines with events.
  assert.equal(all(page, 'svg.tl-mark').length, 6);
  assert.equal(all(one(page, 'section.event-card'), 'tr.event-row').length, 6);
  const chip = (label) =>
    one(page, 'button.chip', label)
      .children.slice(1)
      .map((part) => part.textContent);
  assert.deepEqual(
    [chip('Settings'), chip('Update'), chip('Other lines')],
    [['Settings', '1'], ['Update', '3'], ['Other lines']]
  );
  assert.match(textOf(one(page, 'p.timeline-note')), /tick at the foot of a lane/);
});

test('the board log is narrowed by source, kind and board, can be hidden, and loads more by hand', async () => {
  const lines = [logLine(A, 2 * MINUTE, 'WIFI', 'connected ip=10.0.0.7 rssi=-51')];
  const world = setup({ ...eventsWorld(), lines, linesCursor: 'more-lines' });
  await telemetry.refreshEvents(true);
  const lastQuery = () => world.asked.filter(([name]) => name === 'boardLog').at(-1)[1];
  let page = drawn(telemetry.eventsView(world.ctx));
  const select = one(page, 'select', 'All sources');
  assert.deepEqual(
    all(select, 'option').map((option) => option.value),
    ['', ...core.LINE_TAGS]
  );
  select.value = 'net';
  select.dispatchEvent({ type: 'change' });
  await settle();
  assert.deepEqual(lastQuery().tags, ['net']);

  page = drawn(telemetry.eventsView(world.ctx));
  one(page, 'button.chip', 'Settings').dispatchEvent({ type: 'click' });
  await settle();
  assert.deepEqual(lastQuery().kinds, ['bluetooth', 'update', 'restart', 'health', 'log']);
  // The kinds of the board log are not asked of the events.
  assert.equal(world.asked.filter(([name]) => name === 'events').at(-1)[1].kinds, undefined);

  page = drawn(telemetry.eventsView(world.ctx));
  one(page, 'select', 'All boards').value = A;
  one(page, 'select', 'All boards').dispatchEvent({ type: 'change' });
  await settle();
  assert.equal(lastQuery().thing, A);

  page = drawn(telemetry.eventsView(world.ctx));
  assert.match(textOf(one(page, 'section.log-card')), /more in this range/);
  one(page, 'button', 'Load 500 more lines').dispatchEvent({ type: 'click' });
  await settle();
  page = drawn(telemetry.eventsView(world.ctx));
  assert.equal(all(page, 'tr.log-row').length, 2);
  assert.equal(world.asked.filter(([name]) => name === 'boardLog').at(-1)[1].cursor, 'more-lines');
  assert.equal(telemetry.eventsHoldStill(world.state), true, 'a page loaded by hand is not taken away');

  // Hidden: not asked for, no ticks, and a button to show it again.
  const asked = world.asked.filter(([name]) => name === 'boardLog').length;
  one(page, 'button', 'Hide the board log').dispatchEvent({ type: 'click' });
  await settle();
  page = drawn(telemetry.eventsView(world.ctx));
  assert.equal(world.asked.filter(([name]) => name === 'boardLog').length, asked);
  assert.equal(all(page, 'line.tl-log-tick').length, 0);
  assert.equal(all(page, 'tr.log-row').length, 0);
  assert.equal(one(page, 'button', 'Show the board log').getAttribute('aria-pressed'), 'false');
});

test('without the board log the Events page shows the events all the same, and says that the log could not be read', async () => {
  const world = setup(eventsWorld());
  await telemetry.refreshEvents(true);
  const page = drawn(telemetry.eventsView(world.ctx));
  assert.equal(all(page, 'svg.tl-mark').length, 6);
  assert.match(textOf(one(page, 'section.log-card')), /Could not load the board log/);
  // With no line in the range: why that may be.
  const quiet = setup({ ...eventsWorld(), lines: [] });
  await telemetry.refreshEvents(true);
  assert.match(textOf(one(drawn(telemetry.eventsView(quiet.ctx)), 'section.log-card')), /firmware 1\.12\.0 or later/);
});

test('the Console lane says who did what in the words of the activity log, boards by their names', () => {
  const entry = {
    at: at(MINUTE),
    actor: { sub: 's', email: 'manager@example.invalid' },
    action: 'deployment.create',
    target: DEPLOYMENT,
    outcome: 'ok',
    detail: [
      ['version', '1.2.3+5'],
      ['things', '1'],
      ['boards', A],
    ],
    requestId: 'req-9',
  };
  assert.equal(
    telemetry.consoleEvent(entry, [board(A, { name: 'CRVIHAAN01' })]).text,
    'manager@example.invalid deployed 1.2.3+5 to CRVIHAAN01'
  );
  const signIn = { ...entry, action: 'account.sign_in', target: '', detail: [['client', 'web']] };
  assert.equal(telemetry.consoleEvent(signIn).text, 'manager@example.invalid signed in on the website');
});

test('the Diagnostics page calls a board by its name, with its thing name under it and in the list to pick from', async () => {
  const named = diagnosed(A, {
    name: 'CRVIHAAN01',
    ota: { state: 'downloading', job: DEPLOYMENT, progress: 30, last: 'none', error: '' },
  });
  const world = setup({ devices: [named, diagnosed(B)], route: { view: 'diagnostics' }, samples: SAMPLES });
  await telemetry.refreshDiagnostics(true);
  let page = drawn(telemetry.diagnosticsView(world.ctx));
  const [first, second] = all(page, 'section.diag-card');
  assert.equal(textOf(one(first, 'h2.diag-name')), 'CRVIHAAN01');
  assert.equal(one(one(first, 'h2.diag-name'), 'a').getAttribute('href'), `#/devices/${A}`);
  assert.equal(textOf(one(first, 'p.diag-thing')), A);
  assert.equal(one(first, 'div.meter').getAttribute('aria-label'), 'Download on CRVIHAAN01');
  assert.equal(textOf(one(second, 'h2.diag-name')), B);
  assert.equal(all(second, 'p.diag-thing').length, 0);

  // With more boards than cards, the list to pick from has the name, and the thing name as its tooltip.
  const many = setup({
    devices: [named, diagnosed(B), diagnosed(C), diagnosed(D)],
    route: { view: 'diagnostics', thing: A },
    samples: [],
  });
  await telemetry.refreshDiagnostics(true);
  page = drawn(telemetry.diagnosticsView(many.ctx));
  const names = all(page, 'span.picker-name');
  assert.deepEqual(names.map(textOf), ['CRVIHAAN01', B, C, D]);
  assert.equal(names[0].getAttribute('title'), A);
});

test('with no boards at all, both pages say how to get one', async () => {
  const world = setup({ devices: [], route: { view: 'diagnostics' } });
  await telemetry.refreshDiagnostics(true);
  assert.match(textOf(drawn(telemetry.diagnosticsView(world.ctx))), /No boards are registered yet\./);
  const events = setup({ devices: [], events: [] });
  events.state.eventLog = undefined;
  await telemetry.refreshEvents(true);
  assert.match(textOf(drawn(telemetry.eventsView(events.ctx))), /No boards are registered yet\./);
});

// Search and filters (docs/search-filters.md).

test('the Events page takes its board, kinds, source, level, search and range from the address, and asks the server', async () => {
  const world = setup({ ...eventsWorld(), lines: [] });
  world.state.filters = { events: { board: A, hide: 'log', tag: 'WIFI', level: 'warn', q: ' wifi ', range: '7d' } };
  await telemetry.refreshEvents(true);
  const events = world.asked.find(([name]) => name === 'events')[1];
  assert.equal(events.thing, A);
  assert.equal(events.q, 'wifi');
  assert.equal(events.level, 'warn');
  assert.equal(Date.parse(events.to) - Date.parse(events.from), 7 * DAY);
  const log = world.asked.find(([name]) => name === 'boardLog')[1];
  assert.deepEqual([log.q, log.level, log.tags, log.kinds.includes('log')], ['wifi', 'warn', ['WIFI'], false]);
  // The Console lane has no warnings: with warnings only it is not read.
  assert.equal(
    world.asked.some(([name]) => name === 'audit'),
    false
  );

  // The bar: the search as typed, the board and the level, and the online bands left out while narrowed.
  const page = drawn(telemetry.eventsView(world.ctx));
  const bar = one(page, 'section.filter-bar');
  assert.equal(one(bar, 'input.filter-input').value, ' wifi ');
  assert.match(textOf(one(page, 'p.timeline-note')), /online bands are not drawn/);
  one(bar, 'button.filter-clear').dispatchEvent({ type: 'click' });
  await settle();
  assert.deepEqual(world.state.filters.events, {});
});

test('a search of the Events page is sent to the Console lane too, which the server reads as a range of the log', async () => {
  const world = setup(eventsWorld());
  world.state.filters = { events: { q: 'deploy' } };
  await telemetry.refreshEvents(true);
  const audit = world.asked.find(([name]) => name === 'audit')[1];
  assert.equal(audit.q, 'deploy');
  assert.equal(typeof audit.from, 'string');
  assert.equal(typeof audit.to, 'string');
});

test('choosing a preset, a board or a kind writes it to the address, through the app', async () => {
  const world = setup(eventsWorld());
  await telemetry.refreshEvents(true);
  let page = drawn(telemetry.eventsView(world.ctx));
  one(page, 'button.segmented-option', '7 d').dispatchEvent({ type: 'click' });
  await settle();
  assert.equal(world.state.filters.events.range, '7d');
  page = drawn(telemetry.eventsView(world.ctx));
  one(page, 'button.chip', 'Restart').dispatchEvent({ type: 'click' });
  await settle();
  assert.equal(world.state.filters.events.hide, 'restart');
  // A zoom is the page's own: the address's range does not take it back.
  telemetry.followFilters(world.state);
  assert.equal(world.state.eventLog.range.preset, '7d');
});
