/**
 * The activity log: GET /api/audit, and the one place that writes entries.
 *
 * Entries are written by the request pipeline in app.mjs, one per request that tried
 * to change something. They are read newest first, a page at a time; the cursor of a
 * page is opaque to the browser and checked when it comes back.
 *
 *   GET /api/audit?limit=<n>&before=<cursor>
 *     -> { entries, next }  newest first
 *   GET /api/audit?...&q=<text>&actions=<a,b>&outcomes=<a,b>&from=<ISO>&to=<ISO>
 *     -> { entries, next, read }  the entries that match, newest first: a Query of the log's key
 *        between from and to, filtered (aws.mjs searchAudit), that reads at most SEARCH_BUDGET entries
 *        a page. `read` is how many it read; `next` continues where it stopped, also when it stopped
 *        for the budget with fewer than a page found. `q` is looked for in the target, the e-mail
 *        address and the request id.
 *
 * Both read the console's partition (AUD) and what customers did on the customer site (CUS, written by
 * the customer API, lib/audit.mjs), merged newest first: an entry of a customer carries `by: "customer"`.
 * A search for actions of one partition only reads that one.
 */

import { badRequest, describeError, field } from '../http.mjs';
import {
  ACTIONS,
  AUDIT_PK,
  CUSTOMER_ACTIONS,
  CUSTOMER_ACTIONS_PK,
  OUTCOMES,
  auditDigest,
  auditItem,
  decodeCursor,
  encodeCursor,
  entryFromItem,
} from '../lib/audit.mjs';
import {
  requireActions,
  requireAuditRange,
  requireOutcomes,
  requirePageSize,
  requireSearch,
} from '../lib/validate.mjs';

// How many entries one page of a search reads at most, matching or not.
export const SEARCH_BUDGET = 1000;
// Above every sort key of the log ("<ISO time>#<request id>"), and below every one.
const TOP = '~';
const BOTTOM = '0';

const newestFirst = (a, b) => (a.sk < b.sk ? 1 : a.sk > b.sk ? -1 : 0);

/** The partitions that can hold an entry of these actions (null: any action). */
function partitionsFor(actions) {
  if (actions === null) return [AUDIT_PK, CUSTOMER_ACTIONS_PK];
  const parts = [];
  if (actions.some((action) => !CUSTOMER_ACTIONS.includes(action))) parts.push(AUDIT_PK);
  if (actions.some((action) => CUSTOMER_ACTIONS.includes(action))) parts.push(CUSTOMER_ACTIONS_PK);
  return parts;
}

export function createAuditHandlers({ aws, log }) {
  /** A page of the entries that match: a Query between the two times, below the cursor, of a bounded read. */
  async function search({ before, limit, actions, outcomes, text, fromMs, toMs }) {
    const low = fromMs === null ? BOTTOM : new Date(fromMs).toISOString();
    let high = toMs === null ? TOP : `${new Date(toMs).toISOString()}#${TOP}`;
    if (before !== null && before < high) high = before;
    if (low > high) return { entries: [], next: null, read: 0 };
    const results = await Promise.all(
      partitionsFor(actions).map((partition) =>
        aws.searchAudit({ low, high, before, actions, outcomes, text, limit, budget: SEARCH_BUDGET, partition })
      )
    );
    // Each partition is known down to a key: the one past its page, or where its budget ran out. Of
    // the entries found, only those at or above the highest of these keys are certain to be in order.
    let frontier = null;
    for (const found of results) {
      let known = null;
      if (found.items.length > limit && typeof found.items[found.items.length - 1]?.sk === 'string') {
        known = found.items[found.items.length - 1].sk;
      } else if (typeof found.next === 'string') known = found.next;
      if (known !== null && (frontier === null || known > frontier)) frontier = known;
    }
    const merged = results
      .flatMap((found) => found.items)
      .filter((item) => typeof item?.sk === 'string' && (frontier === null || item.sk >= frontier))
      .sort(newestFirst);
    const page = merged.slice(0, limit);
    const last = page[page.length - 1];
    let next = null;
    if (merged.length > limit && typeof last?.sk === 'string') next = encodeCursor(last.sk);
    else if (frontier !== null) next = encodeCursor(frontier);
    return {
      entries: page.map(entryFromItem).filter((entry) => entry !== null),
      next,
      read: results.reduce((sum, found) => sum + found.read, 0),
    };
  }

  return {
    /**
     * Store the entry for one request. Returns false if it could not be stored; the
     * failure is logged here. Never throws. A stored entry leaves a digest in the log,
     * which carries no address, file name or board name: see lib/audit.mjs.
     */
    async record(entry) {
      try {
        // The key is the time and the request id, and entries are never overwritten.
        // A key that is taken means this entry is not in the log.
        const item = auditItem(entry);
        const stored = await aws.putAudit(item);
        if (stored.ok) {
          log({
            event: 'audit_entry',
            requestId: item.requestId,
            sub: item.actor.sub,
            action: item.action,
            outcome: item.outcome,
            digest: auditDigest(item),
          });
          return true;
        }
        log({
          level: 'error',
          event: 'audit_write_failed',
          requestId: entry.requestId,
          action: entry.action,
          outcome: entry.outcome,
          error: { message: 'an entry with this time and request id exists' },
        });
        return false;
      } catch (error) {
        log({
          level: 'error',
          event: 'audit_write_failed',
          requestId: entry.requestId,
          action: entry.action,
          outcome: entry.outcome,
          error: describeError(error),
        });
        return false;
      }
    },

    /**
     * Store an entry that more than one instance of the function may make, with the same key:
     * a sign-in. "stored", "exists" when another instance stored it first, or "failed", which
     * is logged here. Never throws.
     */
    async recordOnce(entry) {
      try {
        const item = auditItem(entry);
        const stored = await aws.putAudit(item);
        if (!stored.ok) return 'exists';
        log({
          event: 'audit_entry',
          requestId: item.requestId,
          sub: item.actor.sub,
          action: item.action,
          outcome: item.outcome,
          digest: auditDigest(item),
        });
        return 'stored';
      } catch (error) {
        log({
          level: 'error',
          event: 'audit_write_failed',
          requestId: entry.requestId,
          action: entry.action,
          outcome: entry.outcome,
          error: describeError(error),
        });
        return 'failed';
      }
    },

    async list({ query }) {
      const limit = requirePageSize(field(query, 'limit'));
      const cursor = field(query, 'before');
      let before = null;
      if (cursor !== undefined) {
        before = decodeCursor(cursor);
        if (before === null) throw badRequest('invalid_cursor', '"before" is not a cursor from this log.');
      }
      const actions = requireActions(field(query, 'actions'), ACTIONS);
      const outcomes = requireOutcomes(field(query, 'outcomes'), OUTCOMES);
      const text = requireSearch(field(query, 'q'));
      const { fromMs, toMs } = requireAuditRange(field(query, 'from'), field(query, 'to'));
      if (actions !== null || outcomes !== null || text !== null || fromMs !== null || toMs !== null) {
        return { body: await search({ before, limit, actions, outcomes, text, fromMs, toMs }) };
      }
      // One more than the page, to know whether another page follows: of each partition, then of both.
      const parts = await Promise.all(
        [AUDIT_PK, CUSTOMER_ACTIONS_PK].map((partition) => aws.queryAudit({ before, limit: limit + 1, partition }))
      );
      const items = parts
        .flat()
        .sort(newestFirst)
        .slice(0, limit + 1);
      const page = items.slice(0, limit);
      const last = page[page.length - 1];
      return {
        body: {
          entries: page.map(entryFromItem).filter((entry) => entry !== null),
          next: items.length > limit && typeof last?.sk === 'string' ? encodeCursor(last.sk) : null,
        },
      };
    },
  };
}
