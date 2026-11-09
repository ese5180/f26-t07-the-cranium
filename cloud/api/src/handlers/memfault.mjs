/**
 * What Memfault knows of the boards, in the console (docs/memfault.md, "In the console"): read from
 * Memfault's REST API on the server (aws-memfault-api.mjs memfaultGet) and never written to. Viewers and
 * release managers alike; nothing here changes anything, so nothing goes on record.
 *
 *   GET /api/memfault/fleet             the devices Memfault knows, its releases and whether their symbols
 *                                       are there, the reboots of the last week by reason, each board's
 *                                       latest heartbeat metrics, the trace events, and what Memfault could
 *                                       not process
 *   GET /api/memfault/issues            the issues: crashes and other traces grouped by kind
 *   GET /api/memfault/issues/{id}       one issue, with its traces: threads, backtraces, registers
 *   GET /api/devices/{thing}/memfault   one board: its reboots with their reasons, its heartbeat metrics
 *                                       over `hours` (1 to 168, 24 if not given), its trace events, its
 *                                       traces and the issues they belong to
 *
 * A board's device serial in Memfault is its thing name (lib/memfault-data.mjs).
 *
 * Every answer has `memfault: { state, message }`: state "ok", or why Memfault's data is not there, in
 * words a person can act on. Memfault being unreachable is no failure of the console's: the answer is
 * still 200, with whatever could be read. Only a board or an issue that is not there is a 404.
 *
 * Each read of Memfault is kept FRESH_MS (the same path and query answer from memory), and a read that
 * failed FAILED_MS, so that a page refreshing every half minute, or many people at once, do not each
 * send their own requests to Memfault. Reads already under way are shared.
 */

import { describeError, notFound } from '../http.mjs';
import {
  device as deviceOf,
  instant,
  issue as issueOf,
  logEntries,
  metricSeries,
  problemsOf,
  reboot as rebootOf,
  rebootsByReason,
  release as releaseOf,
  symbolsByVersion,
  trace as traceOf,
} from '../lib/memfault-data.mjs';
import { requireHours, requireIssueId, requireThing } from '../lib/validate.mjs';

export const FRESH_MS = 60_000;
export const FAILED_MS = 15_000;
const MAX_KEPT = 256;
// The fleet page looks a week back; the processing log takes 500 entries a page at most.
export const FLEET_HOURS = 168;
const LOG_PAGE = '500';
const LOG_PAGES = 4;
const LIST_PAGE = '100';
const SHOWN = Object.freeze({ reboots: 50, events: 50, traces: 20, recent: 20 });
const HOUR_MS = 3_600_000;
// The only cursor of the processing log: a time.
const CURSOR = /^[0-9T:.+Z-]{10,40}$/;

export const MEMFAULT_WORDS = Object.freeze({
  ok: '',
  not_configured:
    'The console has no Memfault token yet, so it cannot show what Memfault knows. ' +
    'Store one with cloud/deploy.sh, as docs/memfault.md says.',
  refused:
    "Memfault refused the console's token. It may have been revoked or replaced: store a new one " +
    '(docs/memfault.md).',
  limited: 'Memfault is limiting requests right now. This page tries again in a minute.',
  unreachable: 'Memfault could not be reached just now. Its data is safe there; this page tries again in a minute.',
  failed: 'The console could not read its Memfault token from AWS just now. Try again in a minute.',
});

const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

/** The code of a failure that is Memfault's (aws-memfault-api.mjs), or null for any other. */
function codeOf(error) {
  return error?.name === 'MemfaultError' && (error.code === 'not_found' || Object.hasOwn(MEMFAULT_WORDS, error.code))
    ? error.code
    : null;
}

/** The worst of the failures, for the one line a page shows. */
function stateOf(errors) {
  const order = ['not_configured', 'refused', 'failed', 'limited', 'unreachable'];
  const codes = errors.map(codeOf).filter((code) => code !== null);
  const state = order.find((code) => codes.includes(code)) ?? 'ok';
  return { state, message: MEMFAULT_WORDS[state] };
}

export function createMemfaultHandlers({ aws, now, log }, { devices }) {
  // path?query -> { until, answer: Promise }
  const kept = new Map();

  /** One read of Memfault, from memory while it is fresh. */
  function read(path, query = {}) {
    const key = `${path}?${JSON.stringify(query)}`;
    const known = kept.get(key);
    if (known !== undefined && now() < known.until) return known.answer;
    if (typeof aws.memfaultGet !== 'function') {
      const error = new Error('Memfault: not_configured');
      error.name = 'MemfaultError';
      error.code = 'not_configured';
      return Promise.reject(error);
    }
    const entry = { until: Number.POSITIVE_INFINITY, answer: null };
    entry.answer = aws.memfaultGet(path, query).then(
      (body) => {
        entry.until = now() + FRESH_MS;
        return body;
      },
      (error) => {
        // A failure that is Memfault's, or AWS's while reading the token, is kept a little while; a
        // request that ran out of time is not.
        entry.until = codeOf(error) !== null ? now() + FAILED_MS : 0;
        if (codeOf(error) !== null && codeOf(error) !== 'not_found' && codeOf(error) !== 'not_configured') {
          log({ level: 'warn', event: 'memfault_unavailable', path: path.split('/')[0], code: error.code });
        } else if (codeOf(error) === null) {
          log({
            level: 'warn',
            event: 'memfault_failed',
            path: path.split('/')[0],
            error: describeError(error).message,
          });
        }
        throw error;
      }
    );
    if (kept.size >= MAX_KEPT) {
      for (const [name, value] of kept) if (now() >= value.until) kept.delete(name);
      if (kept.size >= MAX_KEPT) kept.clear();
    }
    kept.set(key, entry);
    return entry.answer;
  }

  /** Each read, settled: [values], with null for one that failed, and the errors that are Memfault's. */
  async function readAll(reads) {
    const settled = await Promise.allSettled(reads);
    const errors = [];
    const values = settled.map((result) => {
      if (result.status === 'fulfilled') return result.value;
      // A not_found is an empty answer here; anything not Memfault's is the request's own failure.
      if (codeOf(result.reason) === null) throw result.reason;
      if (result.reason.code !== 'not_found') errors.push(result.reason);
      return null;
    });
    return { values, errors };
  }

  /**
   * The processing log of the last `hours`, of one board or all, newest first: each entry made into
   * what the boards sent (lib/memfault-data.mjs logEntries). Up to LOG_PAGES pages.
   */
  async function processingLog(hours, serial = null) {
    const end = now();
    const query = {
      start: iso(end - hours * HOUR_MS),
      end: iso(end),
      include_event_data: 'true',
      sort: '-created_date',
      'page[size]': LOG_PAGE,
    };
    if (serial !== null) query.device_serial = serial;
    const entries = [];
    let after = null;
    for (let page = 0; page < LOG_PAGES; page += 1) {
      const body = await read('processing-log', after === null ? query : { ...query, 'page[after]': after });
      for (const raw of Array.isArray(body?.data) ? body.data : []) entries.push(...logEntries(raw));
      const next = typeof body?.links?.next === 'string' ? body.links.next : null;
      const cursor = next === null ? null : new URLSearchParams(next.split('?')[1] ?? '').get('page[after]');
      if (cursor === null || !CURSOR.test(cursor) || cursor === after) break;
      after = cursor;
    }
    return entries;
  }

  function split(entries) {
    const of = (kind) => entries.filter((entry) => entry.kind === kind);
    // A heartbeat may come twice: once read, once as a SymbolFileMissing that holds it.
    const seen = new Set();
    const heartbeats = of('heartbeat').filter((beat) => {
      const key = `${beat.serial} ${beat.at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { reboots: of('reboot'), events: of('event'), heartbeats, problems: problemsOf(of('problem')) };
  }

  /** The issues, from the list, and the traces given, by signature. */
  function issuesFor(traces, issues) {
    const signatures = new Set(traces.map((one) => one.signature).filter(Boolean));
    return issues.filter((one) => one.signature !== null && signatures.has(one.signature));
  }

  const listOf = (body, map) => (Array.isArray(body?.data) ? body.data : []).map(map).filter((one) => one !== null);

  return {
    async fleet() {
      const things = new Set(await devices.groupThings());
      const { values, errors } = await readAll([
        read('devices', { per_page: LIST_PAGE }),
        read('releases', { per_page: LIST_PAGE }),
        read('software_types/app/software_versions', { per_page: LIST_PAGE }),
        processingLog(FLEET_HOURS),
      ]);
      const [deviceList, releaseList, versionList, entries] = values;
      const symbols = symbolsByVersion(versionList);
      const { reboots, events, heartbeats, problems } = split(entries ?? []);
      // Each board's newest value of each metric.
      const latest = new Map();
      for (const beat of [...heartbeats].sort((a, b) => (a.at < b.at ? 1 : -1))) {
        const key = beat.serial ?? '';
        const board = latest.get(key) ?? {
          serial: beat.serial,
          thing: beat.thing,
          at: beat.at,
          values: {},
          unnamed: 0,
        };
        if (beat.values === null) board.unnamed += 1;
        for (const [name, v] of Object.entries(beat.values ?? {})) board.values[name] ??= { v, at: beat.at };
        latest.set(key, board);
      }
      const boards = [...latest.values()].sort((a, b) => (a.serial < b.serial ? -1 : 1));
      const keys = [...new Set(boards.flatMap((board) => Object.keys(board.values)))].sort();
      const memfaultDevices = listOf(deviceList, deviceOf)
        .map((one) => ({ ...one, registered: one.thing !== null && things.has(one.thing) }))
        .sort((a, b) => (a.serial < b.serial ? -1 : 1));
      return {
        body: {
          memfault: stateOf(errors),
          hours: FLEET_HOURS,
          from: iso(now() - FLEET_HOURS * HOUR_MS),
          to: iso(now()),
          devices: memfaultDevices,
          releases: listOf(releaseList, (raw) => releaseOf(raw, symbols)),
          reboots: { byReason: rebootsByReason(reboots), recent: reboots.slice(0, SHOWN.recent) },
          metrics: { keys, boards },
          events: events.slice(0, SHOWN.events),
          problems,
          generatedAt: new Date(now()).toISOString(),
        },
      };
    },

    async issues() {
      const { values, errors } = await readAll([read('issues', { per_page: LIST_PAGE })]);
      const issues = listOf(values[0], issueOf).sort((a, b) => ((a.lastSeen ?? '') < (b.lastSeen ?? '') ? 1 : -1));
      return { body: { memfault: stateOf(errors), issues, generatedAt: new Date(now()).toISOString() } };
    },

    async issue({ params }) {
      const id = requireIssueId(params.id);
      const settled = await Promise.allSettled([read(`issues/${id}`), read('traces', { issue: id, per_page: '50' })]);
      const [found, traceList] = settled;
      if (found.status === 'rejected') {
        if (codeOf(found.reason) === 'not_found') throw notFound('not_found', 'Memfault has no issue with that id.');
        if (codeOf(found.reason) === null) throw found.reason;
        return {
          body: {
            memfault: stateOf([found.reason]),
            issue: null,
            traces: [],
            generatedAt: new Date(now()).toISOString(),
          },
        };
      }
      const raw = found.value?.data ?? found.value;
      const issue = issueOf(raw);
      if (issue === null) throw notFound('not_found', 'Memfault has no issue with that id.');
      const errors = [];
      let traces = [];
      if (traceList.status === 'fulfilled') {
        traces = listOf(traceList.value, traceOf);
      } else if (codeOf(traceList.reason) === null) {
        throw traceList.reason;
      } else if (traceList.reason.code !== 'not_found') {
        errors.push(traceList.reason);
      }
      // The list may hold other issues' traces if Memfault took no filter: only this issue's, by signature.
      if (issue.signature !== null) traces = traces.filter((one) => one.signature === issue.signature);
      const last = raw?.last_trace ? traceOf(raw.last_trace) : null;
      if (last !== null && !traces.some((one) => one.id !== null && one.id === last.id)) traces.unshift(last);
      traces.sort((a, b) => ((a.capturedAt ?? '') < (b.capturedAt ?? '') ? 1 : -1));
      const boards = [...new Set(traces.map((one) => one.serial).filter(Boolean))].sort();
      return {
        body: {
          memfault: stateOf(errors),
          issue,
          traces: traces.slice(0, SHOWN.traces),
          boards,
          generatedAt: new Date(now()).toISOString(),
        },
      };
    },

    async board({ params, query }) {
      const thing = requireThing(params.thing);
      const hours = requireHours(Object.hasOwn(query ?? {}, 'hours') ? query.hours : undefined);
      if (!(await devices.groupThings()).includes(thing)) {
        throw notFound('unknown_device', 'No board with that name is registered.');
      }
      const { values, errors } = await readAll([
        read(`devices/${thing}`),
        read(`devices/${thing}/reboots`, { per_page: '50' }),
        processingLog(hours, thing),
        read('traces', { device_serial: thing, per_page: '50' }),
        read('issues', { per_page: LIST_PAGE }),
      ]);
      const [detail, rebootList, entries, traceList, issueList] = values;
      const found = detail === null ? null : deviceOf(detail?.data ?? detail);
      const { events, heartbeats, problems } = split(entries ?? []);
      const traces = listOf(traceList, traceOf).filter((one) => one.serial === thing);
      const toMs = now();
      return {
        body: {
          memfault: stateOf(errors),
          thing,
          // Whether Memfault has heard from this board at all.
          known: found !== null,
          device: found,
          hours,
          from: iso(toMs - hours * HOUR_MS),
          to: iso(toMs),
          reboots: listOf(rebootList, rebootOf).slice(0, SHOWN.reboots),
          metrics: metricSeries(heartbeats),
          events: events.slice(0, SHOWN.events),
          traces: traces.slice(0, SHOWN.traces).map(({ threads: _threads, ...rest }) => rest),
          issues: issuesFor(traces, listOf(issueList, issueOf)),
          problems,
          generatedAt: instant(new Date(toMs).toISOString()),
        },
      };
    },
  };
}
