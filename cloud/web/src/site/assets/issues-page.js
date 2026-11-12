/**
 * Our own issues, in the console (docs/own-observability.md, stage 1): the boards' crashes, faults and stuck
 * restarts, grouped by signature from the events they already send, with counts, the boards and versions
 * they hit, and whether one came back after a fix; and an issue's page with its boards and its timeline.
 * Memfault's own issues stay on the Memfault page (memfault-page.js); this page sits beside it.
 *
 * Everything comes through the console's own API (cloud/api/src/handlers/issues.mjs). Every answer of the
 * server is checked here, field by field, before it is drawn: a field of another type is left out.
 * Fetched when one of these pages is first opened (app.js).
 */

import { OWN_ISSUE, boardName, isThing, plural } from './core.js';
import {
  badge,
  boardLabel,
  card,
  empty,
  filterBar,
  filterSelect,
  filtered,
  h,
  icon,
  loadProblem,
  mono,
  notice,
  pageHead,
  pending,
  stats,
  when,
  whenAt,
} from './views.js';

// The events are written as the boards report; a minute between reads is plenty.
export const ISSUES_REFRESH_MS = 60_000;
// Every day the events table keeps (cloud/api/src/lib/events.mjs EVENT_DAYS).
export const ISSUE_DAYS = 90;
const TYPES = ['stuck', 'reset', 'fault'];
const STATUSES = ['open', 'regressed', 'fixed'];
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,5}\+\d{1,10}$/;

let tools = null;

function resource() {
  return { value: null, error: null, loadedAt: 0, loading: false };
}

/** app.js hands over what the pages need once: { state, api, load, draw, now }. */
export function connect(given) {
  tools = given;
  tools.state.ownIssues ??= { list: resource(), issue: new Map() };
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
const version = (value) => (typeof value === 'string' && VERSION.test(value) ? value : null);
const versions = (value) => list(value).map(version).filter(Boolean);

function instant(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/** An issue as the list and the page both have it, or null. */
export function readOwnIssue(raw) {
  const value = object(raw);
  if (typeof value.id !== 'string' || !OWN_ISSUE.test(value.id)) return null;
  return {
    id: value.id,
    signature: text(value.signature, 160) ?? '',
    type: TYPES.includes(value.type) ? value.type : 'reset',
    title: text(value.title, 200) ?? 'Untitled issue',
    count: whole(value.count) ?? 0,
    boards: whole(value.boards) ?? 0,
    versions: versions(value.versions),
    firstSeen: instant(value.firstSeen),
    lastSeen: instant(value.lastSeen),
    firstVersion: version(value.firstVersion),
    lastVersion: version(value.lastVersion),
    status: STATUSES.includes(value.status) ? value.status : 'open',
    fixedIn: version(value.fixedIn),
    regressedIn: version(value.regressedIn),
    regressed: value.regressed === true,
  };
}

function readWindow(value) {
  return {
    from: instant(value.from),
    to: instant(value.to),
    days: whole(value.days),
    boards: whole(value.boards) ?? 0,
    unread: whole(value.unread) ?? 0,
  };
}

export function readOwnIssues(raw) {
  const value = object(raw);
  return {
    issues: list(value.issues)
      .map(readOwnIssue)
      .filter((issue) => issue !== null),
    ...readWindow(value),
  };
}

export function readOwnIssueDetail(raw) {
  const value = object(raw);
  const issue = readOwnIssue(value.issue);
  const detail = object(value.issue);
  return {
    issue,
    perBoard: list(detail.perBoard)
      .map((one) => object(one))
      .filter((one) => isThing(one.thing))
      .map((one) => ({
        thing: one.thing,
        count: whole(one.count) ?? 0,
        firstSeen: instant(one.firstSeen),
        lastSeen: instant(one.lastSeen),
        versions: versions(one.versions),
      })),
    timeline: list(detail.timeline)
      .map((one) => object(one))
      .filter((one) => isThing(one.thing) && instant(one.at))
      .map((one) => ({ at: one.at, thing: one.thing, version: version(one.version), text: text(one.text, 200) })),
    timelineCut: detail.timelineCut === true,
    ...readWindow(value),
  };
}

// Loading.

export function ownIssueHref(id) {
  return typeof id === 'string' && OWN_ISSUE.test(id) ? `#/issues/${id}` : null;
}

export function issuesResources(state) {
  return state.ownIssues ? [state.ownIssues.list] : [];
}

export async function refreshIssues() {
  const { state, load, api } = tools;
  await load(state.ownIssues.list, async () =>
    readOwnIssues(await api.issuesRequest(`/api/issues?days=${ISSUE_DAYS}`))
  );
}

export function ownIssueResources(state) {
  return state.ownIssues && OWN_ISSUE.test(state.route.id ?? '') ? [entry(state.ownIssues.issue, state.route.id)] : [];
}

export async function refreshOwnIssue() {
  const { state, load, api } = tools;
  const { id } = state.route;
  if (!OWN_ISSUE.test(id ?? '')) return;
  await load(entry(state.ownIssues.issue, id), async () =>
    readOwnIssueDetail(await api.issuesRequest(`/api/issues/${id}?days=${ISSUE_DAYS}`))
  );
}

// Drawing.

const STATUS_LOOK = {
  open: ['bad', 'alert', 'Open'],
  regressed: ['bad', 'restart', 'Regressed'],
  fixed: ['good', 'check', 'Fixed'],
};

/** Open, Regressed or Fixed in a version: the words say which version where there is one. */
export function statusBadge(issue) {
  const [tone, iconName, label] = STATUS_LOOK[issue.status];
  if (issue.status === 'fixed' && issue.fixedIn) return badge(tone, iconName, `Fixed in ${issue.fixedIn}`);
  if (issue.status === 'regressed' && issue.regressedIn) {
    return badge(
      tone,
      iconName,
      `${label} in ${issue.regressedIn}`,
      `Fixed in ${issue.fixedIn}, back in ${issue.regressedIn}`
    );
  }
  return badge(tone, iconName, label);
}

/** A board from the console's list when it is there, for its name; else its thing name. */
function boardOf(ctx, thing) {
  const known = list(ctx.state.devices?.value?.devices).find((board) => board?.thing === thing);
  return known ?? { thing };
}

function issueRows(issues, now) {
  return h(
    'ul',
    { class: 'rows', key: 'issues' },
    issues.map((one) =>
      h(
        'li',
        { key: one.id, class: 'row issue-row own-issue-row' },
        h(
          'div',
          { class: 'row-main' },
          h('a', { href: ownIssueHref(one.id), class: 'row-title cover-link' }, one.title),
          h(
            'span',
            { class: 'row-note dotted' },
            h(
              'span',
              { key: 'count' },
              `${plural(one.count, 'time', 'times')} on ${plural(one.boards, 'board', 'boards')}`
            ),
            one.lastVersion ? h('span', { key: 'version' }, 'last on ', mono(one.lastVersion)) : null,
            one.lastSeen ? h('span', { key: 'seen' }, 'last ', when(one.lastSeen, now)) : null
          )
        ),
        statusBadge(one),
        h('span', { class: 'row-chevron' }, icon('arrow-right'))
      )
    )
  );
}

function issuesFiltered(ctx, issues) {
  const shown = filtered(ctx, 'issues', issues, {
    words: (issue) => [issue.title, issue.id, issue.signature, ...issue.versions],
    keep: (issue, filters) => !filters.status || issue.status === filters.status,
  });
  return [
    filterBar(ctx, 'issues', {
      label: 'issues',
      placeholder: 'Search by title, version or signature',
      shown: shown.length,
      total: issues.length,
      controls: [
        filterSelect(ctx, 'issues', {
          name: 'status',
          label: 'Status',
          all: 'Any status',
          options: [
            ['open', 'Open'],
            ['regressed', 'Regressed'],
            ['fixed', 'Fixed'],
          ],
        }),
      ],
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

function unreadNotice(data) {
  if (!data.unread) return null;
  return h(
    'div',
    { class: 'page-notice', key: 'unread' },
    notice(
      'warn',
      'alert',
      `The events of ${plural(data.unread, 'board', 'boards')} could not be read; the counts leave them out.`
    )
  );
}

const HOW = {
  title: 'How issues are made',
  text: [
    'Each restart a board reports that says something went wrong is counted: the watchdog, a brownout, a lockup, a restart for being stuck. A restart by the reset pin, by an update or by a loss of power is not.',
    'Restarts with the same reason, and later the same place in the code, are one issue. An issue is fixed in a newer version that ran without it, and regressed when it comes back in a version after that.',
    `The console makes them from the events of the last ${ISSUE_DAYS} days. Memfault's issues stay on the Memfault page.`,
  ],
};

/** The Issues page: our own issues, most recently seen first. */
export function issuesView(ctx) {
  const { state } = ctx;
  const target = state.ownIssues?.list ?? resource();
  const head = pageHead({
    title: 'Issues',
    back: { href: '#/memfault', label: 'Memfault' },
    lede: 'Crashes, faults and stuck restarts from the boards, grouped by what went wrong.',
    how: HOW,
  });
  const data = target.value;
  if (!data)
    return h('div', { class: 'page' }, head, loadProblem(target, 'the issues', ctx), pending(target, 'the issues'));
  const regressed = data.issues.filter((issue) => issue.status === 'regressed').length;
  const open = data.issues.filter((issue) => issue.status !== 'fixed').length;
  return h(
    'div',
    { class: 'page' },
    head,
    loadProblem(target, 'the issues', ctx),
    unreadNotice(data),
    card(
      { key: 'summary' },
      stats([
        ['Issues', String(data.issues.length), `in ${data.days ?? ISSUE_DAYS} days`],
        ['Not fixed', String(open)],
        ['Regressed', String(regressed)],
        ['Boards', String(data.boards)],
      ])
    ),
    card(
      { key: 'issues', title: 'Issues' },
      data.issues.length === 0
        ? empty({
            iconName: 'check',
            title: 'No issues.',
            text: `No board reported a crash, a fault or a stuck restart in the last ${data.days ?? ISSUE_DAYS} days.`,
          })
        : issuesFiltered(ctx, data.issues)
    )
  );
}

/** An issue's page: what it is, the boards it hit, and each time it happened. */
export function ownIssueView(ctx) {
  const { state } = ctx;
  const id = state.route.id;
  const target = state.ownIssues ? entry(state.ownIssues.issue, id) : resource();
  const back = { href: '#/issues', label: 'Issues' };
  const data = target.value;
  if (!data || !data.issue) {
    return h(
      'div',
      { class: 'page' },
      pageHead({ title: 'Issue', back }),
      loadProblem(target, 'this issue', ctx),
      pending(target, 'the issue')
    );
  }
  const { issue } = data;
  const now = state.now;
  return h(
    'div',
    { class: 'page' },
    pageHead({
      eyebrow: 'Issue',
      title: issue.title,
      back,
      lede:
        `${plural(issue.count, 'time', 'times')} on ${plural(issue.boards, 'board', 'boards')}` +
        (issue.firstVersion ? `, first on ${issue.firstVersion}` : '') +
        (issue.lastVersion && issue.lastVersion !== issue.firstVersion ? `, last on ${issue.lastVersion}` : ''),
      meta: [statusBadge(issue), h('span', { key: 'sig', class: 'mono own-issue-sig' }, issue.signature)],
    }),
    loadProblem(target, 'this issue', ctx),
    unreadNotice(data),
    issue.status === 'regressed'
      ? h(
          'div',
          { class: 'page-notice', key: 'regressed' },
          notice('bad', 'restart', `Fixed in ${issue.fixedIn}, and back in ${issue.regressedIn}.`)
        )
      : null,
    card(
      { key: 'facts' },
      stats([
        ['First seen', whenAt(issue.firstSeen, now) ?? '-'],
        ['Last seen', whenAt(issue.lastSeen, now) ?? '-'],
        ['Versions', issue.versions.length ? issue.versions.map((one, at) => [at ? ', ' : null, mono(one)]) : '-'],
      ])
    ),
    card(
      { key: 'boards', title: 'Boards' },
      h(
        'ul',
        { class: 'rows', key: 'boards' },
        data.perBoard.map((one) =>
          h(
            'li',
            { key: one.thing, class: 'row own-issue-board' },
            h(
              'div',
              { class: 'row-main' },
              boardLabel(boardOf(ctx, one.thing), 'row-title'),
              h(
                'span',
                { class: 'row-note dotted' },
                h('span', { key: 'count' }, plural(one.count, 'time', 'times')),
                one.versions.length ? h('span', { key: 'versions' }, 'on ', one.versions.join(', ')) : null,
                one.lastSeen ? h('span', { key: 'seen' }, 'last ', when(one.lastSeen, now)) : null
              )
            )
          )
        )
      )
    ),
    card(
      { key: 'timeline', title: 'Timeline' },
      h(
        'ol',
        { class: 'rows own-issue-timeline', key: 'timeline' },
        data.timeline.map((one, index) =>
          h(
            'li',
            { key: `${one.at}-${index}`, class: 'row' },
            h(
              'div',
              { class: 'row-main' },
              h('span', { class: 'row-title' }, one.text ?? 'Restarted'),
              h(
                'span',
                { class: 'row-note dotted' },
                h('span', { key: 'when' }, whenAt(one.at, now)),
                h('span', { key: 'board' }, boardName(boardOf(ctx, one.thing), { short: true })),
                one.version ? h('span', { key: 'version' }, 'on ', mono(one.version)) : null
              )
            )
          )
        )
      ),
      data.timelineCut ? h('p', { class: 'quiet', key: 'cut' }, 'The newest 200 are shown.') : null
    )
  );
}
