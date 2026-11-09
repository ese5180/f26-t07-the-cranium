/**
 * The health gate of a staged rollout (docs/fleet.md, "The health gate"), without AWS and without
 * Memfault: which boards it looks at, and what Memfault's answers say about them.
 *
 * Once the canary or a stage has confirmed the update, and the gate's minutes have passed, the next
 * stage starts only if no board the rollout has updated so far shows, on the new version and after
 * its own part of the rollout started:
 *
 *   - a trace of a Memfault issue (a crash or a trace event Memfault grouped), or
 *   - an unexpected reboot: one whose reason is not an expected one (lib/memfault-data.mjs
 *     rebootReason: an Assert, a fault, a watchdog, a stuck restart, ...).
 *
 * If Memfault cannot be read, the gate waits, at most GATE_WAIT_MS after its minutes were up; then
 * the rollout stops and says so. It never passes without an answer.
 *
 * Every function here is plain.
 */

export const GATE_WAIT_MS = 30 * 60_000;
// The issues looked at more closely in one check, newest first: each costs a read of its traces.
export const GATE_ISSUES_READ = 5;

/** Why Memfault could not be read, as a stop of the gate says it (handlers/memfault.mjs codes). */
export const UNREAD_WORDS = Object.freeze({
  not_configured: 'the console has no Memfault token',
  refused: "Memfault refused the console's token",
  failed: 'the Memfault token could not be read from AWS',
  limited: 'Memfault was limiting requests',
  unreachable: 'Memfault could not be reached',
});

/** Two versions the same, whether or not one says "+0" (Memfault keeps what the board reports). */
export function sameVersion(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bare = (value) => value.replace(/\+0$/, '');
  return bare(a) === bare(b);
}

/**
 * The boards a gate looks at after part `index` of a rollout (-1 for the canary, else a stage): the
 * canary's since the rollout was created, and each stage's up to `index` since it started.
 * [{ thing, since }] with `since` in ms, each board once (its earliest).
 */
export function gateBoards(item, index) {
  const found = new Map();
  const add = (things, at) => {
    const since = Date.parse(at ?? '');
    if (!Number.isFinite(since)) return;
    for (const thing of Array.isArray(things) ? things : []) {
      if (typeof thing !== 'string') continue;
      if (!found.has(thing) || found.get(thing) > since) found.set(thing, since);
    }
  };
  add(item.canary?.things, item.createdAt);
  const stages = Array.isArray(item.stages) ? item.stages : [];
  for (let at = 0; at <= index && at < stages.length; at += 1) add(stages[at]?.things, stages[at]?.startedAt);
  return [...found].map(([thing, since]) => ({ thing, since })).sort((a, b) => (a.thing < b.thing ? -1 : 1));
}

/** The issues worth reading the traces of: seen since `sinceMs` on the version (or on no known one). */
export function candidateIssues(issues, version, sinceMs) {
  return issues
    .filter((issue) => {
      const last = Date.parse(issue.lastSeen ?? '');
      if (!Number.isFinite(last) || last < sinceMs) return false;
      if (issue.lastVersion === null && issue.firstVersion === null) return true;
      return sameVersion(issue.lastVersion, version) || sameVersion(issue.firstVersion, version);
    })
    .sort((a, b) => ((a.lastSeen ?? '') < (b.lastSeen ?? '') ? 1 : -1))
    .slice(0, GATE_ISSUES_READ);
}

/**
 * What the gate makes of Memfault's answers: the first problem, or null for none.
 *
 * @param {object} input
 * @param {string} input.version                    the release
 * @param {{ thing: string, since: number }[]} input.boards
 * @param {object[]} input.reboots                  reboot entries (lib/memfault-data.mjs logEntries)
 * @param {{ issue: object, traces: object[] }[]} input.issues   candidate issues with their traces
 * @returns {null | { kind: 'issue', thing, at, issue: { id, title } } | { kind: 'reboot', thing, at, reason }}
 */
export function judgeHealth({ version, boards, reboots, issues }) {
  const since = new Map(boards.map((board) => [board.thing, board.since]));
  const after = (thing, at) => since.has(thing) && Date.parse(at ?? '') >= since.get(thing);
  for (const { issue, traces } of issues) {
    const trace = traces
      .filter((one) => one.thing !== null && after(one.thing, one.capturedAt ?? one.receivedAt))
      .filter((one) => one.version === null || sameVersion(one.version, version))
      .sort((a, b) => ((a.capturedAt ?? '') < (b.capturedAt ?? '') ? -1 : 1))[0];
    if (trace !== undefined) {
      return {
        kind: 'issue',
        thing: trace.thing,
        at: trace.capturedAt ?? trace.receivedAt,
        issue: { id: issue.id, title: issue.title },
      };
    }
  }
  const reboot = reboots
    .filter((one) => one.thing !== null && !one.reason.expected && after(one.thing, one.at))
    .filter((one) => sameVersion(one.version, version))
    .sort((a, b) => (a.at < b.at ? -1 : 1))[0];
  if (reboot !== undefined) return { kind: 'reboot', thing: reboot.thing, at: reboot.at, reason: reboot.reason.name };
  return null;
}

/** The words of a failed gate, for the rollout's stop and its alert. `where` names the part. */
export function healthWords(problem, where) {
  if (problem.kind === 'issue') {
    return (
      `${where}the health gate failed: ${problem.thing} has a new Memfault issue on this version, ` +
      `#${problem.issue.id} "${problem.issue.title}"`
    );
  }
  return `${where}the health gate failed: ${problem.thing} restarted unexpectedly on this version (${problem.reason})`;
}
