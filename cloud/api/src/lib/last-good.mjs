/**
 * "Roll back to last good" (docs/fleet.md, Roll back to last good), without AWS: each board's last
 * good version, the release that takes it there, and the boards grouped by that release.
 *
 * A board's last good version is the newest version, other than the one it runs, that it ran
 * confirmed, from its update history (lib/updates.mjs records, newest first):
 *
 *   - the version an update brought that the board kept: it started, reached AWS IoT and confirmed
 *     itself (outcome "kept"), so it ran confirmed;
 *   - the version an update started from: a board starts an update only from firmware it has
 *     confirmed (firmware/app/src/ota/ota.c), so it ran that one confirmed too.
 *
 * An update that rolled back, was not installed or is pending says nothing good of the version it
 * brought. Memfault is not asked here: reading its issues and reboots per board and per version is
 * not cheap, and the rollback runs with the health gate on, which asks it of every board it updates.
 *
 * How a board takes an older version. It does not: the console registers only versions newer than
 * every earlier one (handlers/firmware.mjs), the application refuses a job that is not newer than
 * what it runs (ota_job.c, ota_job_check: equal is refused too), and MCUboot refuses a lower version
 * on a test swap (CONFIG_MCUBOOT_DOWNGRADE_PREVENTION). So, as for the group roll back, a real roll
 * back is a rebuild of the old source under a newer version, released like any other. A release
 * says it is one where its note begins "Rebuild of 1.13.0" (rebuildOf). For a board whose last
 * good version is older than what it runs, the target is the newest active release that is a
 * rebuild of that version and newer than what the board runs; for one whose last good version is
 * newer (a board taken back by hand), that version's own release.
 *
 * Every function here is plain.
 */

import { LEFT_OUT, boardLabel, selectTargets, versionOrder } from './fleet.mjs';
import { parseVersion } from './mcuboot.mjs';

// A note that begins "Rebuild of 1.13.0" or "Rebuild of v1.13.0+0", in any case (a note is one line).
const REBUILD_LINE = /^\s*rebuild of v?(\d{1,3}\.\d{1,3}\.\d{1,5}(?:\+\d{1,10})?)(?!\d|\.\d|\+)/i;

// Why a board is left out of a roll back to last good, before any release is looked at.
export const LAST_GOOD_LEFT_OUT = Object.freeze({
  no_good: 'No version it ran confirmed before the one it runs',
  good_revoked: 'Its last good version was revoked',
  no_rebuild: 'No release rebuilds its last good version under a newer number',
  unreadable: 'Its update history could not be read',
});

/** The version a release's note says it rebuilds ("Rebuild of 1.13.0"), or null. */
export function rebuildOf(notes) {
  if (typeof notes !== 'string') return null;
  const found = REBUILD_LINE.exec(notes);
  if (found === null) return null;
  return parseVersion(found[1]) === null ? null : found[1];
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && versionOrder(a, b) === 0;

/**
 * A board's last good version from its update records (newest first): { version, at, how } with
 * `how` "kept" (an update to it was kept) or "ran_before" (an update started from it), or null.
 */
export function lastGoodVersion({ current, records }) {
  if (typeof current !== 'string') return null;
  const seen = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.outcome === 'kept' && typeof record.to === 'string') {
      seen.push({ version: record.to, at: record.endedAt ?? record.startedAt ?? 0, how: 'kept' });
    }
    if (typeof record?.from === 'string') {
      seen.push({ version: record.from, at: record.startedAt ?? record.endedAt ?? 0, how: 'ran_before' });
    }
  }
  // Newest first; at the same time, an update kept says more than one started.
  seen.sort((a, b) => b.at - a.at || (a.how === 'kept' ? -1 : 1));
  const found = seen.find((entry) => parseVersion(entry.version) !== null && !same(entry.version, current));
  if (found === undefined) return null;
  return { version: found.version, at: found.at, how: found.how };
}

/**
 * The release that takes a board from `current` to `good`: { release } or { reason, text }.
 * `releases` are all of them, revoked ones too.
 */
export function releaseFor({ board, good, releases }) {
  const own = releases.find((release) => same(release.version, good));
  if (own && own.status !== 'active') {
    return { reason: 'good_revoked', text: `Its last good version, ${good}, was revoked` };
  }
  if (own && versionOrder(good, board.version) > 0) return { release: own };
  const rebuilds = releases
    .filter(
      (release) =>
        release.status === 'active' &&
        same(rebuildOf(release.notes), good) &&
        versionOrder(release.version, board.version) > 0
    )
    .sort((a, b) => versionOrder(b.version, a.version));
  if (rebuilds.length === 0) {
    return {
      reason: 'no_rebuild',
      text:
        `Its last good version is ${good}, older than ${board.version}: a board takes only newer firmware, ` +
        `and no active release says "Rebuild of ${good}" in its note`,
    };
  }
  // Of its own type and layout if there is one; otherwise the newest, which the board is left out of.
  const fits = rebuilds.find(
    (release) => release.board === board.type && (release.layout ?? 1) === (board.layout ?? 1)
  );
  return { release: fits ?? rebuilds[0] };
}

/**
 * The plan of a roll back to last good. `boards` are the fleet's boards in scope, `histories` thing
 * -> records (newest first; a board missing could not be read), `releases` all of them, `busy`
 * thing -> its open deployment.
 *
 * { targets: [{ release, label, boards: [{ thing, from, to, how }], things, leftOut }], leftOut }
 * with one target per release, newest first; `leftOut` (each { thing, reason, text, from, to }) the
 * boards with no release to go to, and each target's those its release would not reach.
 */
export function planLastGood({ boards, histories, releases, busy = new Map(), nowMs }) {
  const leftOut = [];
  const byRelease = new Map();
  const out = (board, reason, text, to = null) =>
    leftOut.push({
      thing: board.thing,
      reason,
      text: text ?? LAST_GOOD_LEFT_OUT[reason] ?? LEFT_OUT[reason],
      from: board.version,
      to,
    });
  for (const board of [...boards].sort((a, b) => (a.thing < b.thing ? -1 : 1))) {
    if (board.bluetoothOnly) {
      out(board, 'bluetooth_only');
      continue;
    }
    if (!histories.has(board.thing)) {
      out(board, 'unreadable');
      continue;
    }
    const good = lastGoodVersion({ current: board.version, records: histories.get(board.thing) });
    if (good === null) {
      out(
        board,
        'no_good',
        board.version === null ? 'Has never said which version it runs' : LAST_GOOD_LEFT_OUT.no_good
      );
      continue;
    }
    const found = releaseFor({ board, good: good.version, releases });
    if (!found.release) {
      out(board, found.reason, found.text, good.version);
      continue;
    }
    const key = found.release.version;
    if (!byRelease.has(key)) byRelease.set(key, { release: found.release, boards: [] });
    byRelease.get(key).boards.push({ board, to: good.version, how: good.how });
  }
  const targets = [];
  for (const { release, boards: members } of [...byRelease.values()].sort((a, b) =>
    versionOrder(b.release.version, a.release.version)
  )) {
    const chosen = selectTargets({
      release,
      candidates: members.map((entry) => entry.board),
      busy,
      nowMs,
      leaveOutAway: true,
    });
    const toOf = new Map(members.map((entry) => [entry.board.thing, entry]));
    targets.push({
      release,
      label: boardLabel(release.board),
      rebuildOf: rebuildOf(release.notes),
      boards: members.map(({ board, to, how }) => ({ thing: board.thing, from: board.version, to, how })),
      things: chosen.things,
      leftOut: chosen.leftOut.map((entry) => ({
        ...entry,
        from: toOf.get(entry.thing)?.board.version ?? null,
        to: toOf.get(entry.thing)?.to ?? null,
      })),
    });
  }
  return { targets, leftOut };
}
