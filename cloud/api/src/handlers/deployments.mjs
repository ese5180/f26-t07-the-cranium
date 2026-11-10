/**
 * Deployments: list, create, watch and cancel.
 *
 * AWS IoT Jobs is the only store. A deployment is a snapshot job on a chosen set of
 * boards; nothing about it is copied anywhere else, so what the console shows cannot
 * drift from what AWS holds. Results are cached for a moment in this module's memory
 * to keep polling browsers within the request limits of AWS IoT.
 *
 * What a board reports decides one thing here, and only about itself: its board type
 * (lib/boards.mjs), which a release has to match (400 incompatible_board), and which keeps a
 * board that updates over Bluetooth only from being made the target of a job at all (400
 * bluetooth_only). Whether a release may be deployed is decided by its record; whether a
 * board is free is decided by its executions in AWS IoT Jobs. The shadow otherwise only adds
 * the live step and progress to the picture.
 *
 * A staged rollout (handlers/rollouts.mjs) is made of deployments too: its canary and its
 * waves are each a job started by launch() below, the same way as one made here.
 *
 * Cancelling is asked of AWS and then read back. AWS applies a cancellation a few
 * seconds after it accepted it, and a job that was cancelled without force keeps the
 * boards that had started. So nothing here says that a deployment is over because the
 * job is cancelled: that is read from its executions.
 *
 * From console 2.25.0 a deployment brings board firmware, a Raspberry Pi image (handlers/pi-images.mjs),
 * or both: POST /api/deployments takes `version`, `pi` (the Pi image's version), or both. With both, a
 * board downloads the two, installs its firmware, and sends the Pi its image once that firmware is
 * confirmed (docs/pi-ota.md, "Both at once"). A Pi image goes only to boards that report a "pi"
 * object in their shadow, which only a build for a board wired to a Pi does (400 no_pi). Its time
 * limit in AWS IoT is reckoned from its size (lib/jobs.mjs piTimeoutMinutes). Each execution says
 * where its Pi part is (`pi`: { state, progress, version }) beside the firmware's phase.
 *
 * A deployment, of either kind, can be paced (`waves`: { perMinute, abortPercent }): AWS IoT then
 * offers it to `perMinute` boards a minute, more as they succeed, and stops it by itself once failures
 * reach `abortPercent` of the boards that have finished (lib/fleet.mjs rolloutConfigs).
 */

import { HttpError, badRequest, conflict, describeError, field, notFound, unprocessable } from '../http.mjs';
import { boardsValue, change } from '../lib/audit.mjs';
import { rolloutConfigs } from '../lib/fleet.mjs';
import {
  EXECUTION_STATUSES,
  IN_PROGRESS_TIMEOUT_MIN,
  MAX_IN_FLIGHT,
  URL_EXPIRES_SEC,
  buildBundleJobDocument,
  buildJobDescription,
  buildJobDocument,
  buildJobId,
  buildPiJobDocument,
  buildPiJobId,
  countExecutions,
  executionDetails,
  isActiveExecution,
  isSettled,
  isoTime,
  mapLimit,
  piTimeoutMinutes,
  summarizeJob,
} from '../lib/jobs.mjs';
import { unknownDevice } from '../lib/shadow.mjs';
import { deriveTimeline } from '../lib/timeline.mjs';
import {
  MAX_NOTE,
  isThing,
  parseDeploymentId,
  requireBoolean,
  requireJobId,
  requirePiVersion,
  requireText,
  requireThings,
  requireVersion,
  strictVersion,
} from '../lib/validate.mjs';
import { releaseFromItem, releaseKey } from './firmware.mjs';

const CACHE_MS = 2000;
// A deployment that is over (lib/jobs.mjs isSettled) does not change any more: its summary is
// read again after this long all the same, so nothing a page shows is kept for ever.
const SETTLED_MS = 10 * 60_000;
// When AWS throttles a read even after its retries (lib/iot-pace.mjs), the list shows the last
// summary it had of a deployment, if it is no older than this, rather than nothing at all.
const STALE_MS = 60_000;
const LIST_LIMIT = 25;
const MAX_CACHED = 1000;
const ANY_JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
// The longest value of an audit detail (lib/audit.mjs): eight thing names and the blanks between them.
const MAX_BOARDS_NAMED = 200;
// The states of a job in which AWS rolls out nothing more.
const OVER = Object.freeze(['COMPLETED', 'CANCELED', 'DELETION_IN_PROGRESS']);
// AWS stops the boards of a job a few seconds after it accepted a forced cancellation
// (5 to 15 s were measured). For this long after one, a board that is still listed as
// waiting or at work is taken to be on its way out. After that it was not stopped.
const STOPPING_MS = 120_000;

function unknownDeployment() {
  return notFound('unknown_deployment', 'There is no deployment with that id.');
}

function alreadyFinished() {
  return conflict('already_finished', 'This deployment has already finished; there is nothing left to cancel.');
}

/** "1 board is" or "3 boards are". */
function boardsAre(count) {
  return count === 1 ? '1 board is' : `${count} boards are`;
}

const running = (executions) => executions.filter((execution) => execution.status === 'IN_PROGRESS').length;

/**
 * A cancellation of a deployment that is cancelled already and still has `executions`
 * open, where there is nothing to send to AWS. Says why they are open:
 *
 * @param {object[]} executions  the executions that are queued or in progress
 * @param {boolean} forced       the deployment was cancelled with force
 * @param {boolean} stopping     and AWS accepted that so recently that it is still at it
 */
function alreadyCancelled(executions, { forced, stopping }) {
  const atWork = running(executions);
  let rest;
  if (stopping) {
    rest = `AWS takes a few seconds to stop its boards: ${boardsAre(executions.length)} still listed as unfinished.`;
  } else if (atWork === 0) {
    rest = `AWS takes a few seconds to withdraw the offer: ${boardsAre(executions.length)} still listed as waiting.`;
  } else if (forced) {
    rest = `${boardsAre(atWork)} still at work on it all the same. Cancel with force to try again.`;
  } else {
    rest =
      `${boardsAre(atWork)} still at work on it, because a cancellation without force leaves boards ` +
      'that had started alone. Cancel with force to stop them.';
  }
  return conflict('already_cancelled', `This deployment is already cancelled${forced ? ' with force' : ''}. ${rest}`);
}

/** AWS refused a cancellation, and the deployment is not over: `executions` are still open. */
function cancelRefused(executions) {
  const atWork = running(executions);
  if (atWork > 0) {
    return conflict(
      'cancel_refused',
      'AWS did not accept the cancellation, and ' +
        `${boardsAre(atWork)} still at work on this deployment. A board that is not stopped carries ` +
        `on until it finishes or its ${IN_PROGRESS_TIMEOUT_MIN} minutes are over.`
    );
  }
  return conflict(
    'cancel_refused',
    executions.length > 0
      ? `AWS did not accept the cancellation, and ${boardsAre(executions.length)} still offered this ` +
          'update. Try again in a moment.'
      : 'AWS did not accept the cancellation, and the deployment is still open. Try again in a moment.'
  );
}

function deviceBusy(busy, withdrawn = false) {
  const names = [...new Set(busy.map((item) => item.thing))];
  if (withdrawn) {
    const who = names.length === 1 ? `${names[0]} was` : `${names.length} boards were`;
    return conflict(
      'device_busy',
      `${who} given another update at the same moment, so this deployment ` +
        'was withdrawn. Wait for the other update or cancel it first.',
      busy
    );
  }
  const who = names.length === 1 ? `${names[0]} still has` : `${names.length} boards still have`;
  return conflict('device_busy', `${who} an update that is not finished. Wait for it or cancel it first.`, busy);
}

/** True if deployment `a` was created before `b`. Both are summaries; ids break a tie. */
function createdBefore(a, b) {
  return a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);
}

/** True if two lists name the same boards, in whatever order. */
function sameThings(a, b) {
  const others = new Set(b);
  return a.length === others.size && a.every((thing) => others.has(thing));
}

function put(cache, key, value) {
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(key, value);
}

// The ends of an update that a board reports itself, and writes what it ran into the job.
const REPORTED_ENDS = Object.freeze(['SUCCEEDED', 'FAILED', 'REJECTED']);

/**
 * What an execution says about the firmware on its board. These are two different things,
 * so they are two fields, and only ever one of them holds a value:
 *
 *   ranAtEnd   What the job holds: the version the board said it ran when it finished the
 *              update. History, which stays true whatever the board runs later. Null if
 *              the job holds none, or could not be read: never the board's report of today.
 *   reported   For an execution the board did not finish (open, cancelled, timed out,
 *              removed): what is known of the board at this moment, which is what it told
 *              the job or else its shadow. It says nothing about the time the update ended.
 */
function firmwareOf(row, device) {
  return REPORTED_ENDS.includes(row.status)
    ? { ranAtEnd: row.details.running, reported: null }
    : { ranAtEnd: null, reported: row.details.running ?? device.fw?.version ?? null };
}

/**
 * Where the Pi part of a deployment is on one board, or null for a deployment without one:
 * { state, progress, version }. `state` is one of
 *
 *   waiting       the board has not got to it: queued, or downloading its firmware first
 *   downloading   onto the board's SD card
 *   on_card       on the card, checked, while the board installs its new firmware and runs it on trial
 *   flashing      on its way to the Pi, over SPI
 *   flashed       the Pi verified it
 *   failed        the Pi part failed (the board's firmware, if the deployment brought one, stayed)
 *   not_flashed   it never went to the Pi: the deployment ended before, or its firmware did not stay
 */
export function piPartOf(summary, row, device) {
  if (!summary.parts.includes('pi')) return null;
  const { details } = row;
  const piOnly = !summary.parts.includes('nrf');
  const live = device?.pi?.job === summary.id ? device.pi : null;
  const version = details.piVersion ?? summary.pi?.version ?? null;
  const shown = (state, progress = null) => ({ state, progress, version });
  switch (row.status) {
    case 'QUEUED':
      return shown('waiting');
    case 'IN_PROGRESS': {
      const step = details.step;
      if (step === 'flashing_pi' || step === 'sending')
        return shown('flashing', details.progress ?? live?.progress ?? null);
      if (step === 'downloading_pi' || (piOnly && step !== 'rebooting')) {
        return shown('downloading', details.progress ?? live?.progress ?? null);
      }
      if (step === 'rebooting') return shown('on_card');
      return shown('waiting');
    }
    case 'SUCCEEDED':
      return shown('flashed', 100);
    case 'FAILED':
      if (piOnly) return shown('failed');
      return shown(details.piOutcome === 'failed' ? 'failed' : 'not_flashed');
    default:
      return shown('not_flashed');
  }
}

/** The execution of a board that a new job names: queued since the job was created. */
function queuedRow(thing, createdAt) {
  return {
    thing,
    status: 'QUEUED',
    queuedAt: createdAt,
    startedAt: null,
    lastUpdatedAt: createdAt,
    details: executionDetails(null),
    secondsLeft: null,
  };
}

export function createDeploymentHandlers(
  { aws, config, now, randomHex, log },
  { devices, fleet = null, piImages = () => null }
) {
  let listing = null; // { jobs, at }: the result of ListJobs
  const summaries = new Map(); // id -> { summary, settled, at }
  const details = new Map(); // id -> { detail, at }
  const closed = new Map(); // "id/thing" -> a described execution that has ended

  function forget(id) {
    listing = null;
    summaries.delete(id);
    details.delete(id);
  }

  function warn(event, fields, error) {
    log({ level: 'warn', event, ...fields, error: describeError(error).message });
  }

  function rememberSummary(id, summary) {
    put(summaries, id, { summary, settled: isSettled(summary), at: now() });
  }

  /**
   * The summary of one deployment for the list, or null if the job is not one. `listed`, the
   * job as ListJobs gave it, if at hand: a summary whose status is not the one listed is read again.
   */
  async function summaryOf(id, listed = null) {
    const cached = summaries.get(id);
    if (cached !== undefined) {
      const age = now() - cached.at;
      const current = listed === null || listed.status === cached.summary.status;
      if (current && age < (cached.settled ? SETTLED_MS : CACHE_MS)) return cached.summary;
    }
    let job;
    try {
      job = await aws.describeJob(id);
    } catch (error) {
      if (error?.code !== 'throttled' || cached === undefined || now() - cached.at >= STALE_MS) throw error;
      warn('summary_kept', { deployment: id }, error);
      return cached.summary;
    }
    const summary = summarizeJob(job);
    if (summary === null) summaries.delete(id);
    else rememberSummary(id, summary);
    return summary;
  }

  /**
   * One execution with what the board wrote into it. An execution that has ended does
   * not change any more and is described only once.
   */
  async function describeExecution(id, listed) {
    const key = `${id}/${listed.thing}`;
    const cached = closed.get(key);
    const unchanged =
      cached !== undefined && cached.status === listed.status && cached.lastUpdatedAt === listed.lastUpdatedAt;
    if (unchanged) return cached.row;

    let described = null;
    try {
      described = await aws.describeJobExecution(id, listed.thing);
    } catch (error) {
      // The list entry still says where the board is; the details follow on the next poll.
      warn('execution_unreadable', { deployment: id, thing: listed.thing }, error);
    }
    const complete = described !== null && EXECUTION_STATUSES.includes(described.status);
    const source = complete ? described : listed;
    const row = {
      thing: listed.thing,
      status: source.status,
      queuedAt: source.queuedAt ?? listed.queuedAt ?? null,
      startedAt: source.startedAt ?? listed.startedAt ?? null,
      lastUpdatedAt: source.lastUpdatedAt ?? listed.lastUpdatedAt ?? null,
      details: executionDetails(complete ? described.statusDetails : null),
      secondsLeft:
        complete && Number.isInteger(described.secondsLeft) && described.secondsLeft >= 0
          ? described.secondsLeft
          : null,
    };
    if (complete && !isActiveExecution(row.status)) {
      put(closed, key, { status: listed.status, lastUpdatedAt: listed.lastUpdatedAt, row });
    }
    return row;
  }

  /** An Execution as the API returns it. */
  function present(summary, row, device) {
    const pi = piPartOf(summary, row, device);
    const { phase, progress } = deriveTimeline({
      status: row.status,
      reason: row.details.reason,
      step: row.details.step,
      jobId: summary.id,
      device,
      progress: row.details.progress,
      piOnly: !summary.parts.includes('nrf'),
    });
    const queuedAt = isoTime(row.queuedAt) ?? isoTime(row.lastUpdatedAt) ?? summary.createdAt;
    return {
      thing: row.thing,
      status: row.status,
      phase,
      progress,
      reason: row.details.reason,
      detail: row.details.detail,
      ...firmwareOf(row, device),
      // From 2.25.0: the Pi image's part, for a deployment that brings one (piPartOf).
      ...(pi === null ? {} : { pi }),
      online: device.online,
      queuedAt,
      startedAt: isoTime(row.startedAt),
      lastUpdatedAt: isoTime(row.lastUpdatedAt) ?? queuedAt,
      secondsLeft: row.status === 'IN_PROGRESS' ? row.secondsLeft : null,
    };
  }

  /** The DeploymentDetail for an id, or null if there is no such deployment. */
  async function detailOf(id, { fresh = false } = {}) {
    const cached = details.get(id);
    if (!fresh && cached !== undefined && now() - cached.at < CACHE_MS) return cached.detail;

    const job = await aws.describeJob(id);
    const summary = summarizeJob(job);
    if (summary === null) {
      forget(id);
      return null;
    }
    const listed = (await aws.listJobExecutionsForJob(id)).filter(
      (execution) => isThing(execution.thing) && EXECUTION_STATUSES.includes(execution.status)
    );
    const rows = await mapLimit(listed, MAX_IN_FLIGHT, (execution) => describeExecution(id, execution));
    const byThing = new Map(rows.map((row) => [row.thing, row]));

    const things = [...new Set([...summary.things, ...byThing.keys()])].sort();
    const boards = await devices.loadDevices(things, CACHE_MS);
    const executions = [];
    things.forEach((thing, index) => {
      let row = byThing.get(thing);
      if (row === undefined) {
        // AWS creates the executions shortly after the job. Until it has, a board the
        // job names is queued by definition; for a job that is over there is nothing.
        if (summary.status !== 'IN_PROGRESS') return;
        row = queuedRow(thing, job.createdAt ?? null);
      }
      executions.push(present(summary, row, boards[index]));
    });

    const detail = { ...summary, counts: countExecutions(executions), executions };
    put(details, id, { detail, at: now() });
    rememberSummary(id, summary);
    return detail;
  }

  /** The jobs AWS lists that are deployments of this console. */
  async function listedJobs({ fresh = false } = {}) {
    if (!fresh && listing !== null && now() - listing.at < CACHE_MS) return listing.jobs;
    const jobs = (await aws.listJobs()).filter((job) => parseDeploymentId(job.jobId) !== null);
    listing = { jobs, at: now() };
    return jobs;
  }

  /**
   * The executions of a job that have not ended: boards still waiting or at work. Read
   * from the executions themselves; the counts AWS keeps with a job lag behind them.
   */
  async function openExecutions(id) {
    return (await aws.listJobExecutionsForJob(id)).filter((execution) => isActiveExecution(execution.status));
  }

  /**
   * True if AWS accepted a forced cancellation of this job a moment ago, so that it is
   * still stopping the job's boards. `job` is a job as the adapter describes it.
   */
  function beingStopped(job) {
    return (
      job !== null &&
      job.status === 'CANCELED' &&
      job.forceCanceled === true &&
      Number.isFinite(job.lastUpdatedAt) &&
      now() - job.lastUpdatedAt < STOPPING_MS
    );
  }

  /**
   * The unfinished updates on these boards, as [{ thing, deployment }], leaving out the
   * deployment `except`. Decided by what AWS holds, never by what a board reports:
   *
   *   - every execution of a board that is queued or in progress, whichever tool
   *     created its job, and
   *   - every deployment of this console that is not over and names the board but has
   *     no execution for it yet. AWS creates the executions of a job shortly after the
   *     job; until then the board is queued by definition, and a check of the
   *     executions alone would miss a deployment made a moment ago.
   */
  async function unfinishedOn(things, except = null) {
    const listed = await mapLimit(things, MAX_IN_FLIGHT, (thing) => aws.listJobExecutionsForThing(thing));
    const busy = [];
    const rolledOut = new Set(); // "job thing" for every execution that exists
    things.forEach((thing, index) => {
      for (const execution of listed[index]) {
        if (typeof execution.jobId !== 'string' || !ANY_JOB_ID.test(execution.jobId)) continue;
        rolledOut.add(`${execution.jobId} ${thing}`);
        if (execution.jobId !== except && isActiveExecution(execution.status)) {
          busy.push({ thing, deployment: execution.jobId });
        }
      }
    });
    const open = (await listedJobs({ fresh: true })).filter(
      (job) => job.jobId !== except && (job.status === 'IN_PROGRESS' || job.status === 'SCHEDULED')
    );
    const summaries = await mapLimit(open, MAX_IN_FLIGHT, (job) => summaryOf(job.jobId, job));
    for (const summary of summaries) {
      if (summary === null) continue;
      for (const thing of things) {
        if (summary.things.includes(thing) && !rolledOut.has(`${summary.id} ${thing}`)) {
          busy.push({ thing, deployment: summary.id });
        }
      }
    }
    return busy.sort((a, b) =>
      a.thing === b.thing ? (a.deployment < b.deployment ? -1 : 1) : a.thing < b.thing ? -1 : 1
    );
  }

  /**
   * Of the unfinished updates on these boards, those that the deployment `id`, which
   * was created a moment ago, has to give way to.
   *
   * Two requests for the same board at the same moment both find it free, and each
   * creates its job before it can see the other's. Each therefore looks again once its
   * job exists, and of two deployments the one AWS created later gives way: it was
   * created when the other existed, so it is the one that is sure to see both. A job
   * of another tool does not look out for this console, so a deployment always gives
   * way to it.
   */
  async function rivalsOf(id, things) {
    const others = await unfinishedOn(things, id);
    if (others.length === 0) return [];
    const own = await summaryOf(id);
    const first = new Map(); // deployment -> whether it comes before this one
    for (const deployment of new Set(others.map((item) => item.deployment))) {
      if (parseDeploymentId(deployment) === null || own === null) {
        first.set(deployment, true);
      } else {
        const other = await summaryOf(deployment);
        // Gone in the meantime: nothing to give way to.
        first.set(deployment, other !== null && createdBefore(other, own));
      }
    }
    return others.filter((item) => first.get(item.deployment));
  }

  /**
   * Cancel, with force, every deployment of a version that is not over. Used when a
   * release is revoked. One job that cannot be cancelled does not stop the others.
   *
   * Returns { cancelled, failed }: the deployments this call cancelled, and those
   * with a board that could not be confirmed as stopped.
   *
   * AWS documents what a forced cancellation does to a job that is in progress: its
   * boards are stopped, a few seconds later, and a board looks at its job once more
   * before it installs. So a job that was in progress counts as cancelled when AWS
   * accepted the call.
   *
   * AWS does not document what a second cancellation does to a job that is cancelled
   * already and still has a board waiting or at work. Measured in October 2026, it
   * accepts a forced one and stops the board 5 to 15 seconds later; it could also
   * refuse it, or accept it and change nothing. For such a job, and whenever AWS
   * refuses, only the executions say whether the boards were stopped, so they are
   * read again after the call. A job
   * with a board that is still open then counts as failed, never as cancelled. That
   * also holds for a job that someone cancelled with force a few seconds ago and
   * that AWS is still stopping: it cannot be told apart, and asking again later
   * settles it.
   */
  async function cancelUnfinished(version, comment) {
    const jobs = (await listedJobs({ fresh: true }))
      .filter((job) => parseDeploymentId(job.jobId)?.version === version)
      .sort((a, b) => (a.jobId < b.jobId ? -1 : 1));
    return cancelJobs(jobs, 'RELEASE_REVOKED', comment);
  }

  /**
   * The same for a Raspberry Pi image that is revoked (handlers/pi-images.mjs): every deployment that
   * is not over and brings it, alone or with firmware. Its version is in the job's description.
   */
  async function cancelUnfinishedPi(piVersion, comment) {
    const open = (await listedJobs({ fresh: true })).filter(
      (job) =>
        parseDeploymentId(job.jobId)?.withPi === true && !['COMPLETED', 'DELETION_IN_PROGRESS'].includes(job.status)
    );
    const summaries = await mapLimit(open, MAX_IN_FLIGHT, (job) => summaryOf(job.jobId, job));
    const jobs = open
      .filter((job, index) => summaries[index]?.pi?.version === piVersion)
      .sort((a, b) => (a.jobId < b.jobId ? -1 : 1));
    return cancelJobs(jobs, 'PI_IMAGE_REVOKED', comment);
  }

  async function cancelJobs(jobs, reasonCode, comment) {
    const cancelled = [];
    const failed = [];
    await mapLimit(jobs, MAX_IN_FLIGHT, async (job) => {
      try {
        if (job.status === 'COMPLETED' || job.status === 'DELETION_IN_PROGRESS') return;
        const cancelledBefore = job.status === 'CANCELED';
        if (cancelledBefore && (await openExecutions(job.jobId)).length === 0) return;

        const result = await aws.cancelJob({
          jobId: job.jobId,
          force: true,
          reasonCode,
          comment,
        });
        forget(job.jobId);
        if (!result.ok && result.reason === 'not_found') return;
        if (result.ok && !cancelledBefore) {
          cancelled.push(job.jobId);
          return;
        }
        const [after, left] = await Promise.all([aws.describeJob(job.jobId), openExecutions(job.jobId)]);
        if ((after === null || OVER.includes(after.status)) && left.length === 0) {
          if (result.ok) cancelled.push(job.jobId);
          return;
        }
        failed.push(job.jobId);
        log({
          level: 'error',
          event: 'cancel_unconfirmed',
          deployment: job.jobId,
          accepted: result.ok,
          open: left.length,
          atWork: running(left),
        });
      } catch (error) {
        failed.push(job.jobId);
        log({ level: 'error', event: 'cancel_failed', deployment: job.jobId, error: describeError(error) });
      }
    });
    listing = null;
    return { cancelled: cancelled.sort(), failed: failed.sort() };
  }

  /**
   * Create the job of a deployment on boards that were checked already: free, registered and of
   * the release's type. Returns { id, detail }. `rollout` and `abort` are the pacing and the
   * stop of a wave of a staged rollout (lib/fleet.mjs rolloutConfigs), null for a deployment
   * made here. `onCreated` hears the id as soon as the job exists, before the checks that may
   * withdraw it again.
   */
  async function launch({
    release = null,
    piImage = null,
    things,
    description,
    actorSub,
    rollout = null,
    abort = null,
    onCreated = () => {},
  }) {
    if (release === null && piImage === null) throw new TypeError('A deployment brings firmware, a Pi image or both');
    const parts = release === null ? null : strictVersion(release.version).parts;
    const sortKey = parts === null ? null : releaseKey(parts);
    const where = { region: config.region, bucket: config.firmwareBucket };
    const pi =
      piImage === null
        ? null
        : {
            version: piImage.version,
            size: piImage.size,
            sha256: piImage.sha256,
            sig: piImage.sig,
            ...(piImage.minFirmware === null ? {} : { minFirmware: piImage.minFirmware }),
          };
    let document;
    if (release === null) {
      document = buildPiJobDocument({ ...pi, ...where });
    } else if (pi === null) {
      document = buildJobDocument({ version: release.version, size: release.size, sha256: release.sha256, ...where });
    } else {
      document = buildBundleJobDocument({
        version: release.version,
        size: release.size,
        sha256: release.sha256,
        pi,
        ...where,
      });
    }
    const newId = (suffix) =>
      release === null
        ? buildPiJobId(piImage.version, now(), suffix)
        : buildJobId(parts, now(), suffix, { withPi: pi !== null });
    // A Pi image takes hours where firmware takes minutes (docs/pi-ota.md, "Speed").
    const timeout = pi === null ? IN_PROGRESS_TIMEOUT_MIN : piTimeoutMinutes(pi.size);

    let id = null;
    for (let attempt = 0; attempt < 3 && id === null; attempt += 1) {
      const candidate = newId(String(randomHex(4)).slice(0, 4));
      const created = await aws.createJob({
        jobId: candidate,
        things,
        document,
        description,
        urlExpiresInSec: URL_EXPIRES_SEC,
        inProgressTimeoutMinutes: timeout,
        // A wave of a staged rollout: AWS IoT paces it and stops it by itself (lib/fleet.mjs).
        ...(rollout === null ? {} : { rollout }),
        ...(abort === null ? {} : { abort }),
      });
      if (created.ok) {
        id = candidate;
      } else if (created.reason === 'target_not_found') {
        throw unprocessable('unknown_device', 'One of the chosen boards is no longer registered.');
      } else if (created.reason !== 'exists') {
        throw new Error(`The job could not be created: ${String(created.reason)}`);
      } else {
        // The id is taken. Either by another job, and another id is drawn; or by
        // this very request: a call whose answer got lost is sent again, and the
        // second attempt then finds the job that the first one made.
        const taken = await aws.describeJob(candidate);
        if (taken !== null && taken.description === description && sameThings(taken.things ?? [], things)) {
          id = candidate;
        }
      }
    }
    if (id === null) throw new Error('No free job id after three attempts');
    onCreated(id);
    forget(id);

    // The release may have been revoked while this request was running. Revoking
    // cancels the deployments it can see; this one may have appeared too late for that.
    let current = release;
    if (release !== null) {
      try {
        current = releaseFromItem(await aws.getRelease(sortKey));
      } catch (error) {
        // It was active a moment ago, and the bucket refuses a revoked image anyway.
        warn('release_recheck_failed', { deployment: id }, error);
      }
    }
    if (release !== null && (current === null || current.status !== 'active')) {
      await aws.cancelJob({ jobId: id, force: true, reasonCode: 'RELEASE_REVOKED', comment: actorSub });
      forget(id);
      throw conflict(
        'release_revoked',
        `Release ${release.version} was revoked just now; the deployment was cancelled.`
      );
    }
    // The same for a Pi image.
    let currentPi = piImage;
    if (piImage !== null && piImages() !== null) {
      try {
        currentPi = await piImages().find(piImage.version);
      } catch (error) {
        warn('pi_image_recheck_failed', { deployment: id }, error);
      }
    }
    if (piImage !== null && (currentPi === null || currentPi.status !== 'active')) {
      await aws.cancelJob({ jobId: id, force: true, reasonCode: 'PI_IMAGE_REVOKED', comment: actorSub });
      forget(id);
      throw conflict(
        'release_revoked',
        `Pi image ${piImage.version} was revoked just now; the deployment was cancelled.`
      );
    }

    // Another deployment to one of these boards may have been created in the same
    // moment: neither request could see the other's job when it checked. Look again
    // now that this job exists, and withdraw it if it is the one to give way.
    let rivals = [];
    try {
      rivals = await rivalsOf(id, things);
    } catch (error) {
      // The boards were free a moment ago; this second look only narrows a race.
      warn('busy_recheck_failed', { deployment: id }, error);
    }
    // The lists were read for a decision; the next reader gets fresh ones.
    forget(id);
    if (rivals.length > 0) {
      await aws.cancelJob({ jobId: id, force: true, reasonCode: 'DEVICE_BUSY', comment: actorSub });
      forget(id);
      throw deviceBusy(rivals, true);
    }

    // The job exists from here on, so the answer is 201 even if it cannot be read
    // back right now: then it is described from what was just sent to AWS.
    let detail = null;
    try {
      detail = await detailOf(id, { fresh: true });
    } catch (error) {
      warn('deployment_unreadable', { deployment: id }, error);
    }
    if (detail === null) {
      const createdAt = now();
      const summary = summarizeJob({
        jobId: id,
        status: 'IN_PROGRESS',
        description,
        things,
        createdAt,
        lastUpdatedAt: createdAt,
        completedAt: null,
        counts: {},
      });
      const executions = things.map((thing) => present(summary, queuedRow(thing, createdAt), unknownDevice(thing)));
      // Read back from what was sent: the Pi image is in the description, not yet in a summary of AWS's.
      detail = { ...summary, counts: countExecutions(executions), executions };
    }
    return { id, detail };
  }

  /** A Pi image that may still be deployed now, or null: for each stage of a staged rollout. */
  async function piImageNow(version) {
    if (piImages() === null) return null;
    const image = await piImages().find(version);
    return image !== null && image.status === 'active' ? image : null;
  }

  /**
   * Throws unless every board can take a Pi image: it reports a "pi" object (a build with Pi updates,
   * for a board wired to a Pi, lib/shadow.mjs) and does not update over Bluetooth only.
   */
  async function requirePiTargets(things) {
    const loaded = await devices.loadDevices(things, CACHE_MS);
    const without = things.filter((thing, index) => loaded[index]?.pi === undefined || loaded[index]?.pi === null);
    if (without.length > 0) {
      throw new HttpError(
        400,
        'no_pi',
        `${without.length === 1 ? `${without[0]} does` : `These boards do`} not report a Raspberry Pi: ` +
          `${without.length === 1 ? 'it runs' : 'they run'} no build with Pi updates (scripts/firmware/build.sh --pi), ` +
          'or no Pi is wired.',
        without.map((thing) => ({ thing }))
      );
    }
  }

  /**
   * What a request asks to deploy, by its form only: { version, piVersion }, either null but not both.
   * `version` is the board firmware's (as requireVersion gives it), `pi` the Pi image's version.
   */
  function parseParts(body) {
    const versionValue = field(body, 'version');
    const piValue = field(body, 'pi');
    if (versionValue === undefined && piValue === undefined) {
      throw badRequest('invalid_version', 'Choose board firmware ("version"), a Raspberry Pi image ("pi"), or both.');
    }
    return {
      version: versionValue === undefined ? null : requireVersion(versionValue),
      piVersion: piValue === undefined ? null : requirePiVersion(piValue),
    };
  }

  /** The release and the Pi image that parsed parts name: { release, piImage }, each deployable now. */
  async function loadParts({ version, piVersion }, entry = null) {
    let release = null;
    if (version !== null) {
      if (entry) {
        entry.target = version.text;
        entry.detail.version = version.text;
      }
      release = releaseFromItem(await aws.getRelease(releaseKey(version.parts)));
      if (release === null || release.version !== version.text) {
        throw notFound('unknown_version', `There is no release ${version.text}.`);
      }
      if (release.status !== 'active') {
        throw conflict('release_revoked', `Release ${version.text} is revoked and cannot be deployed.`);
      }
    }
    let piImage = null;
    if (piVersion !== null) {
      if (entry) {
        entry.detail.pi = piVersion;
        if (release === null) entry.target = piVersion;
      }
      if (piImages() === null) throw notFound('unknown_version', `There is no Pi image ${piVersion}.`);
      piImage = await piImages().requireActive(piVersion);
    }
    return { release, piImage };
  }

  /** Both: for a scheduled start and a staged rollout, which check a request the same way. */
  async function requireParts(body, entry = null) {
    return loadParts(parseParts(body), entry);
  }

  /** `waves` of a request: null, or the pacing and stop of AWS IoT (lib/fleet.mjs rolloutConfigs). */
  function requireWaves(body) {
    const waves = field(body, 'waves');
    if (waves === undefined || waves === null) return null;
    const perMinute = field(waves, 'perMinute');
    const abortPercent = field(waves, 'abortPercent');
    if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 100) {
      throw badRequest('invalid_wave', 'waves.perMinute is a whole number of boards a minute, 1 to 100.');
    }
    if (!Number.isInteger(abortPercent) || abortPercent < 1 || abortPercent > 100) {
      throw badRequest('invalid_wave', 'waves.abortPercent is a whole percentage, 1 to 100.');
    }
    return { perMinute, abortPercent };
  }

  return {
    cancelUnfinished,
    cancelUnfinishedPi,
    requireParts,
    requirePiTargets,
    piImageNow,
    // For staged rollouts (handlers/rollouts.mjs).
    launch,
    unfinishedOn,
    summary: (id) => summaryOf(id),
    detail: (id) => detailOf(id, { fresh: true }),

    /** The summaries of the deployments started from `sinceMs` and before `untilMs`, for the weekly report. */
    async between({ sinceMs, untilMs }) {
      const jobs = (await listedJobs()).filter((job) => {
        const ms = Number(job.createdAt);
        return Number.isFinite(ms) && ms >= sinceMs && ms < untilMs;
      });
      const loaded = await mapLimit(jobs, MAX_IN_FLIGHT, (job) => summaryOf(job.jobId, job));
      return loaded.filter((summary) => summary !== null);
    },

    async list() {
      const newest = [...(await listedJobs())]
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || (a.jobId < b.jobId ? 1 : -1))
        .slice(0, LIST_LIMIT);
      const loaded = await mapLimit(newest, MAX_IN_FLIGHT, (job) => summaryOf(job.jobId, job));
      return { body: { deployments: loaded.filter((summary) => summary !== null) } };
    },

    async get({ params }) {
      const job = requireJobId(params.id);
      const detail = await detailOf(job.id);
      if (detail === null) throw unknownDeployment();
      return { body: { deployment: detail } };
    },

    async create({ caller, actor, json, entry }) {
      const body = json();
      const parsed = parseParts(body);
      if (parsed.version !== null) {
        entry.target = parsed.version.text;
        entry.detail.version = parsed.version.text;
      } else {
        entry.target = parsed.piVersion;
      }
      const waves = requireWaves(body);
      const things = requireThings(field(body, 'things'));
      entry.detail.things = String(things.length);
      // Which boards, by thing name, as far as a detail holds them: eight, of the 25 a deployment may have.
      const named = things.join(' ');
      if (named.length <= MAX_BOARDS_NAMED) entry.detail.boards = named;
      const note = requireText(field(body, 'note'), 'note', { max: MAX_NOTE });
      // From the phone app: on record as such. Its recent sign-in is checked by the router.
      if (caller?.clientId !== undefined && caller.clientId === config.mobileClientId) entry.detail.from = 'phone';
      const { release, piImage } = await loadParts(parsed, entry);

      const members = new Set(await devices.groupThings());
      const strangers = things.filter((thing) => !members.has(thing));
      if (strangers.length > 0) {
        throw unprocessable(
          'unknown_device',
          strangers.length === 1
            ? `${strangers[0]} is not a registered board.`
            : `These are not registered boards: ${strangers.join(', ')}.`
        );
      }

      // Of the release's board type, and able to take a job at all (docs/fleet.md, Board types).
      if (fleet !== null && release !== null) await fleet.requireJobTargets(things, release);
      // A Pi image: only to boards that report a Pi.
      if (piImage !== null) await requirePiTargets(things);

      const busy = await unfinishedOn(things);
      if (busy.length > 0) throw deviceBusy(busy);

      const description = buildJobDescription({
        email: actor.email,
        sub: actor.sub,
        note,
        pi: piImage === null ? null : { version: piImage.version, sha256: piImage.sha256 },
      });
      const paced = waves === null ? {} : rolloutConfigs({ wave: waves.perMinute, abortPercent: waves.abortPercent });
      const { detail } = await launch({
        release,
        piImage,
        things,
        description,
        actorSub: actor.sub,
        ...paced,
        onCreated: (id) => {
          entry.target = id;
          change(entry, 'deployment', null, id);
        },
      });
      if (release !== null) change(entry, 'version', null, release.version);
      if (piImage !== null) change(entry, 'pi', null, piImage.version);
      if (waves !== null) entry.detail.waves = `${waves.perMinute}/min, stop at ${waves.abortPercent}%`;
      change(entry, 'boards', null, boardsValue(things));
      return { status: 201, body: { deployment: detail } };
    },

    async cancel({ actor, params, json, entry }) {
      const job = requireJobId(params.id);
      entry.target = job.id;
      const force = requireBoolean(field(json(), 'force'), 'force', false);
      entry.detail.force = String(force);

      const described = await aws.describeJob(job.id);
      const summary = summarizeJob(described);
      if (summary === null) throw unknownDeployment();
      if (summary.status === 'COMPLETED' || summary.status === 'DELETION_IN_PROGRESS') throw alreadyFinished();
      if (summary.status === 'CANCELED') {
        // Whether anything is left of a cancelled deployment is read from its
        // executions. What can be left: boards that AWS has yet to take the offer
        // from or to stop, which it does a few seconds after a cancellation, and
        // boards that had started when the deployment was cancelled without force.
        // Only for the last is there something to ask of AWS, and only with force.
        const open = await openExecutions(job.id);
        if (open.length === 0) throw alreadyFinished();
        const stopping = beingStopped(described);
        if (stopping || running(open) === 0 || !force) {
          throw alreadyCancelled(open, { forced: described.forceCanceled === true, stopping });
        }
      }

      const result = await aws.cancelJob({
        jobId: job.id,
        force,
        reasonCode: 'CONSOLE_CANCEL',
        comment: actor.sub,
      });
      forget(job.id);
      if (result.ok) change(entry, 'status', summary.status, force ? 'CANCELED (force)' : 'CANCELED');
      if (!result.ok) {
        if (result.reason === 'not_found') throw unknownDeployment();
        warn('cancel_refused', { deployment: job.id }, new Error(String(result.detail ?? '')));
        // AWS has the last word. What it left behind is said as it is: a refusal only
        // means that there was nothing to cancel if the job is over and no board is
        // waiting or at work.
        const [after, left] = await Promise.all([aws.describeJob(job.id), openExecutions(job.id)]);
        if (after === null) throw unknownDeployment();
        if (OVER.includes(after.status) && left.length === 0) throw alreadyFinished();
        // Somebody else cancelled it with force in this very moment.
        if (summary.status !== 'CANCELED' && beingStopped(after)) {
          throw alreadyCancelled(left, { forced: true, stopping: true });
        }
        throw cancelRefused(left);
      }

      // Cancelling is eventually consistent: answer with what AWS says after the call.
      let detail;
      try {
        detail = await detailOf(job.id, { fresh: true });
      } catch (error) {
        // The request fails, but the log entry says that the job was cancelled.
        entry.detail.cancelled = 'true';
        throw error;
      }
      if (detail === null) throw unknownDeployment();
      if (summary.status === 'CANCELED' && detail.counts.inProgress > 0) {
        // AWS accepted a second cancellation, which is where it documents nothing, and
        // the board is still listed as at work. It may be stopped in a few seconds or
        // not at all; the answer shows it as it is, and the log keeps the case.
        log({
          level: 'warn',
          event: 'cancel_unconfirmed',
          deployment: job.id,
          accepted: true,
          atWork: detail.counts.inProgress,
        });
      }
      return { body: { deployment: detail } };
    },
  };
}
