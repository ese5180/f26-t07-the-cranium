/**
 * Issues: the boards' crashes, faults and stuck restarts grouped by signature (lib/issues.mjs,
 * docs/own-observability.md). Our own, from the events table; Memfault's issues stay at /api/memfault.
 *
 *   GET /api/issues?days=<1-90>
 *     -> { issues: [Issue], from, to, boards, generatedAt }
 *        most recently seen first; the last 30 days unless `days` says otherwise
 *
 *   GET /api/issues/{id}?days=<1-90>
 *     -> { issue: Issue & { perBoard, timeline, timelineCut }, from, to, generatedAt }
 *
 * An Issue is { id, signature, type, title, count, boards, versions, firstSeen, lastSeen,
 * firstVersion, lastVersion, status, fixedIn, regressedIn, regressed }.
 *
 * Reads, for viewers and release managers alike, from the website, a phone app or an API token, as
 * the events they are made of; neither goes on record. Each board's restarts and firmware changes
 * are read with one Query of its key range; a board whose events cannot be read is left out and
 * counted in `unread`, so one board never fails the page.
 */

import { badRequest, describeError, field, notFound } from '../http.mjs';
import { EVENT_DAYS, eventFromItem, eventRange } from '../lib/events.mjs';
import { groupIssues, issueDetail, issueSummary, parseIssueId } from '../lib/issues.mjs';

const DAY_MS = 86_400_000;
export const DEFAULT_ISSUE_DAYS = 30;
// A board's restarts and firmware changes in the window: far more than a board makes.
const EVENTS_READ = 5_000;

const iso = (ms) => new Date(ms).toISOString();

function requireDays(value) {
  if (value === undefined) return DEFAULT_ISSUE_DAYS;
  const days = /^[1-9]\d{0,1}$/.test(value) ? Number(value) : NaN;
  if (!(days >= 1 && days <= EVENT_DAYS)) {
    throw badRequest('invalid_days', `"days" must be a whole number from 1 to ${EVENT_DAYS}.`);
  }
  return days;
}

export function createIssueHandlers({ aws, now, log }, { devices }) {
  async function issuesOf(query) {
    const days = requireDays(field(query, 'days'));
    const nowMs = now();
    const fromMs = nowMs - days * DAY_MS;
    const things = await devices.groupThings();
    const range = eventRange(fromMs, nowMs + 60_000);
    const [current, parts] = await Promise.all([
      devices.loadDevices(things),
      Promise.allSettled(
        things.map((thing) => aws.queryEvents({ thing, ...range, kinds: ['restart', 'firmware'], limit: EVENTS_READ }))
      ),
    ]);
    const nowSec = nowMs / 1000;
    let unread = 0;
    const boards = [];
    things.forEach((thing, index) => {
      const part = parts[index];
      if (part.status === 'rejected') {
        unread += 1;
        log({ level: 'warn', event: 'events_unreadable', thing, error: describeError(part.reason).message });
        return;
      }
      const events = part.value
        .filter((item) => !(Number.isFinite(item?.ttl) && item.ttl <= nowSec))
        .map(eventFromItem)
        .filter((event) => event !== null);
      boards.push({ thing, current: current[index]?.fw?.version ?? null, events });
    });
    return {
      issues: groupIssues(boards),
      window: { from: iso(fromMs), to: iso(nowMs), days, boards: things.length, unread, generatedAt: iso(nowMs) },
    };
  }

  return {
    async list({ query }) {
      const { issues, window } = await issuesOf(query);
      return { body: { issues: issues.map(issueSummary), ...window } };
    },

    async get({ params, query }) {
      const id = parseIssueId(params.id);
      if (id === null) throw badRequest('invalid_issue', 'An issue is named by 12 hex digits.');
      const { issues, window } = await issuesOf(query);
      const issue = issues.find((one) => one.id === id);
      if (!issue) throw notFound('unknown_issue', 'No issue with that id in this window.');
      return { body: { issue: issueDetail(issue), ...window } };
    },
  };
}
