/**
 * What Memfault knows of the boards, in the console (docs/memfault.md, "In the console"): the Memfault
 * page with its issues, an issue's page with its traces and backtraces, and the Memfault section of a
 * board's page with its reboots and their reasons, its trace events and its issues.
 *
 * Everything comes through the console's own API (cloud/api/src/handlers/memfault.mjs), which reads
 * Memfault's REST API on the server: the browser never talks to Memfault, so the page's policy is as
 * strict as before. Fetched when one of these pages is first opened (app.js).
 *
 * Every answer of the server is checked here, field by field, before it is drawn: a field of another
 * type is left out.
 */

import { isThing, plural } from './core.js';
import { badge, card, empty, h, loadProblem, loading, mono, notice, pageHead, pending, when } from './views.js';

// One read of the server per page a minute is plenty: the server keeps Memfault's answers a minute.
export const MEMFAULT_REFRESH_MS = 60_000;
// A week of a board's heartbeats and events.
export const BOARD_HOURS = 168;
const ISSUE_ID = /^[1-9]\d{0,15}$/;
const STATES = ['ok', 'not_configured', 'refused', 'limited', 'unreachable', 'failed'];

let tools = null;

function resource() {
  return { value: null, error: null, loadedAt: 0, loading: false };
}

/** app.js hands over what the pages need once: { state, api, load, draw }. */
export function connect(given) {
  tools = given;
  tools.state.memfault ??= { issues: resource(), issue: new Map(), boards: new Map() };
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
  };
}

// Loading.

export function issueHref(id) {
  return ISSUE_ID.test(String(id)) ? `#/memfault/${id}` : null;
}

async function request(path) {
  return tools.api.memfaultRequest(path);
}

export function memfaultResources(state) {
  return state.memfault ? [state.memfault.issues] : [];
}

export async function refreshMemfault() {
  const { state, load } = tools;
  await load(state.memfault.issues, async () => readIssues(await request('/api/memfault/issues')));
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
  if (memfault.state === 'ok') return null;
  return h('div', { class: 'page-notice', key: 'memfault-state' }, notice('warn', 'alert', memfault.message));
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
        { key: String(one.id), class: 'row' },
        h(
          'div',
          { class: 'row-main' },
          h('a', { href: issueHref(one.id) }, one.title),
          h(
            'p',
            { class: 'row-sub quiet' },
            `${plural(one.traces, 'trace', 'traces')} on ${plural(one.boards, 'board', 'boards')}`,
            one.lastVersion ? [' · last on ', mono(one.lastVersion)] : null,
            one.lastSeen ? [' · last ', when(one.lastSeen, now)] : null
          )
        )
      )
    )
  );
}

/** The Memfault page: the issues, newest first. */
export function memfaultView(ctx) {
  const { state } = ctx;
  const target = state.memfault?.issues ?? resource();
  const head = pageHead({
    title: 'Memfault',
    lede: 'Crashes and other traces the boards sent to Memfault, grouped into issues. Read from Memfault by the console.',
  });
  const data = target.value;
  if (!data)
    return h('div', { class: 'page' }, head, loadProblem(target, 'Memfault', ctx), pending(target, 'the issues'));
  return h(
    'div',
    { class: 'page' },
    head,
    loadProblem(target, 'Memfault', ctx),
    stateNotice(data.memfault),
    card(
      { key: 'issues', title: 'Issues' },
      data.issues.length === 0
        ? empty({
            iconName: 'check',
            title: data.memfault.state === 'ok' ? 'No issues.' : 'No issues to show.',
            text:
              data.memfault.state === 'ok'
                ? 'No board has sent a crash or a trace that Memfault made an issue of.'
                : null,
          })
        : issueRows(data.issues, state.now)
    )
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
          { class: 'data-table registers' },
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
      { class: 'quiet' },
      trace.thing
        ? h('a', { href: `#/devices/${trace.thing}`, class: 'mono' }, trace.thing)
        : mono(trace.serial ?? 'Unknown board'),
      trace.version ? [' on ', mono(trace.version)] : null,
      trace.capturedAt ? [' · ', when(trace.capturedAt, now)] : null
    ),
    trace.message ? h('p', null, trace.message) : null,
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
                  { key: `${one.at}-${index}`, class: 'row' },
                  reasonBadge(one.reason),
                  ' ',
                  when(one.at, ctx.state.now),
                  one.version ? h('span', { class: 'quiet' }, ' on ', mono(one.version)) : null
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
                    { key: `${one.at}-${index}`, class: 'row' },
                    mono(one.name),
                    one.detail ? h('span', { class: 'quiet' }, ' ', one.detail) : null,
                    ' ',
                    when(one.at, ctx.state.now)
                  )
                )
              ),
            ]
          : null,
        data.issues.length > 0
          ? [h('h3', { class: 'card-sub', key: 'issues-head' }, 'Issues'), issueRows(data.issues, ctx.state.now)]
          : null,
      ];
  return card({ key: 'memfault-data', title: 'In Memfault' }, body);
}
