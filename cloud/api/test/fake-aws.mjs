// An in-memory stand-in for src/aws.mjs.
//
// It implements the adapter interface documented at the top of src/aws.mjs with the
// same inputs, outputs and failure modes, and keeps to the rules of the AWS services
// behind it where the console depends on them: write-once objects, conditional and
// transactional table writes, job and execution state, the limits AWS puts on ids,
// descriptions and comments. It starts empty. Nothing in it is a sample record: what
// it holds is what a test or a preview session put there.
//
// On top of the adapter methods it has helpers that play the parts the console does
// not: the provisioning tool (addThing), the user administrator (addUser, user) and
// the boards (device, execution):
//
//   const fake = createFakeAws({ now });
//   fake.addThing('cranium-0123456789abcdef', { certificates: ['<64 hex>'] });
//   fake.addUser({ sub, email, groups: ['release-managers'] });
//   fake.device(thing).report({ fw: { version: '1.0.0+3', confirmed: true }, uptime: 60, ... });
//   fake.device(thing).connect();  fake.device(thing).disconnect('CONNECTION_LOST');
//   fake.device(thing).nextJob();                    // { jobId, status, document } or null
//   fake.execution(jobId, thing).update('IN_PROGRESS', { step: 'downloading' });   // { accepted: true }
//
// A board that follows the device contract goes: report ota.state "awaiting_user" with
// ota.job; update IN_PROGRESS step=downloading; report "downloading" with progress;
// report "verifying"; update IN_PROGRESS step=rebooting; report "rebooting", then
// "testing" with the new fw.version; update SUCCEEDED running=<version>; report "idle".
// Every report is also a heartbeat: a board is online for 90 s after one, or 240 s after one
// that says "rebooting".
//
// The two AWS IoT rules and the recorder behind them (src/recorder.mjs) are played here too:
// every report goes through the recorder's own logic (src/lib/events.mjs) as the shadow
// document AWS IoT would publish, and so do connect() and disconnect() as presence messages.
// What they make lands in the stand-in's events table, where queryEvents and querySamples
// read it. fake.eventStore() is the stand-in for the recorder's adapter (createEventStore).
// The third rule, a board's log (src/lib/lines.mjs), is played by fake.device(thing).log(tag, text),
// which publishes one line on cranium/<thing>/events as firmware 1.12.0 does.
//
// Time comes from the `now` function passed in (the system clock by default). Jobs
// behave as in AWS IoT: an execution in progress times out after the job's timeout, a
// snapshot job completes when all its executions have ended, and a cancelled job stays
// cancelled. AWS creates the executions of a job a moment after the job and cancels
// them a moment after a cancellation; the stand-in does both at once unless it is given
// a delay. fake.calls lists every adapter call; fake.failNext makes one fail.
//
// One thing AWS does not document: what CancelJob with force does to a job that was
// cancelled before, without force, and still has a board at work. Measured on AWS IoT
// in October 2026, the call is accepted and the board is stopped 5 to 15 seconds
// later, as for a job in progress. Because that is not documented, the stand-in can do
// each of the three things AWS could do (the `repeatedCancel` option): refuse the call,
// which is the worst case and what it does unless told otherwise, accept it and stop
// the board, or accept it and leave the board alone. The console has to tell the
// truth in all three cases.
//
// The fleet (docs/fleet.md). A thing may carry attributes (addThing(thing, { attributes })), which
// describeThing reads, as provisioning sets `board`. The fleet's records live in three partitions
// of the stand-in's state table (GRP, ROL, SEEN). A job may be paced and stopped as AWS IoT does
// with jobExecutionsRolloutConfig and abortConfig: its boards are offered a few a minute, more as
// they succeed (or, with maximumPerMinute alone, that many a minute from the start), and the job
// is cancelled by itself once the share of failures reaches the
// threshold. How AWS counts its minutes is not documented to the second: here the first boards
// are offered when the job is created and the next at each whole minute after, judged by the
// successes there are when the stand-in next looks. A job stopped that way has no reason code.
//
// The map, the commands and the alerts (src/aws-map.mjs) are test/fake-map.mjs, merged in here: its
// adapter methods and its helpers (commands, locate, enableAlerts, ...) are this stand-in's too.
//
// Also exported: fixture and fakeEnv (the fixture images and a configuration that
// accepts them), accessClaims and apiEvent (a request as API Gateway delivers it),
// manualTimers (timers that a test fires by hand), and createTestConsole (the real
// handlers on a fake, as the tests use them).
//
// This file is test and preview code. It is never packaged with the function.

import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createApp } from '../src/app.mjs';
import { memfaultError } from '../src/aws-memfault-api.mjs';
import { loadConfig } from '../src/config.mjs';
import { recordsOf } from '../src/lib/events.mjs';
import { SAME_LINE_MS, isLineMessage, recordsFromLine } from '../src/lib/lines.mjs';
import { parseCsr } from '../src/lib/provision.mjs';
import { FACT_PARTITION, factPartition, factsFromItems } from '../src/lib/updates.mjs';
import { holdsSearch } from '../src/lib/validate.mjs';
import { parseBundledVersions } from '../src/lib/versions.mjs';
import { createFakeApps } from './fake-apps.mjs';
import { createFakeDb } from './fake-db.mjs';
import { createFakeMap } from './fake-map.mjs';
import { boardKey, issueCertificate } from './fake-provision.mjs';

const THING_NAME = /^[a-zA-Z0-9:_-]{1,128}$/;
const JOB_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const NO_CONTROL = /^[^\p{C}]+$/u;
const REASON_CODE = /^[\p{Lu}\p{Nd}_]+$/u;
const DETAIL_KEY = /^[a-zA-Z0-9:_-]{1,128}$/;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'REJECTED', 'REMOVED', 'CANCELED']);
const DEVICE_STATUSES = new Set(['IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'REJECTED']);
const REPEATED_CANCEL = Object.freeze(['refused', 'accepted', 'ignored']);
const FLEET_PKS = Object.freeze(['GRP', 'ROL', 'SEEN', 'ALR', 'HEALTH', 'RPT', 'SCH', 'NAME', 'PIIMG']);
const FAILURE_TYPES = Object.freeze({
  FAILED: ['FAILED'],
  REJECTED: ['REJECTED'],
  TIMED_OUT: ['TIMED_OUT'],
  ALL: ['FAILED', 'REJECTED', 'TIMED_OUT'],
});
const EXECUTED = new Set(['SUCCEEDED', 'FAILED', 'REJECTED', 'TIMED_OUT']);
const ACCOUNT = '000000000000';
const REGION = 'us-east-1';

/** The error src/aws.mjs throws for a failure a handler cannot act on. */
export function awsError(operation, awsName, { code = 'failed', status = null } = {}) {
  const error = new Error(`${operation}: ${awsName}`);
  error.name = 'AwsError';
  error.code = code;
  error.operation = operation;
  error.awsError = awsName;
  error.awsStatus = status;
  return error;
}

function invalid(operation, why) {
  const error = awsError(operation, 'InvalidRequestException', { status: 400 });
  error.message = `${operation}: InvalidRequestException: ${why}`;
  return error;
}

/** A deep copy of plain data, as it would come back from a service. */
function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Refuse what the real adapter cannot store in a table. */
function assertStorable(value, path = 'item') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} is not a finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertStorable(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) assertStorable(entry, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} cannot be stored`);
}

/** Merge a shadow update into a document the way AWS IoT does: null deletes a key. */
function mergeReported(state, metadata, update, stamp) {
  for (const [key, value] of Object.entries(update)) {
    if (value === null) {
      delete state[key];
      delete metadata[key];
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      if (typeof state[key] !== 'object' || state[key] === null || Array.isArray(state[key])) {
        state[key] = {};
        metadata[key] = {};
      }
      mergeReported(state[key], metadata[key], value, stamp);
    } else {
      state[key] = copy(value);
      metadata[key] = Array.isArray(value) ? value.map(() => ({ timestamp: stamp })) : { timestamp: stamp };
    }
  }
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now]           the clock, epoch milliseconds
 * @param {number} [options.rolloutDelayMs]      how long after a job is created its
 *                                               executions appear (AWS creates them
 *                                               shortly after the job, not with it)
 * @param {number} [options.cancelDelayMs]       how long after a job is cancelled its
 *                                               executions change (AWS cancels them a
 *                                               few seconds after it accepted the call;
 *                                               until then a board's updates still pass)
 * @param {string} [options.repeatedCancel]      what a forced cancellation does to a job
 *                                               that is cancelled already and has a board
 *                                               at work: "refused", "accepted" (the board
 *                                               is stopped) or "ignored" (the call
 *                                               succeeds and changes nothing)
 */
/** An account of the staff pool as src/aws-team.mjs describes one. */
function teamMember(sub, user) {
  return {
    sub,
    email: user.email,
    name: user.name ?? '',
    enabled: user.enabled,
    status: user.status,
    createdAt: Number.isFinite(user.createdAt) ? user.createdAt : null,
    mfa: user.mfa === true,
  };
}

export function createFakeAws({
  now = Date.now,
  rolloutDelayMs = 0,
  cancelDelayMs = 0,
  repeatedCancel = 'refused',
} = {}) {
  if (!REPEATED_CANCEL.includes(repeatedCancel)) {
    throw new TypeError(`repeatedCancel must be one of: ${REPEATED_CANCEL.join(', ')}`);
  }
  const things = new Map(); // name -> { inGroup, principals, attributes }
  const fleetItems = new Map(); // "pk sk" -> item: the fleet's partitions of the state table
  const shadows = new Map(); // name -> shadow document
  const booted = new Map(); // name -> when the board's uptime started, in ms
  const jobs = new Map(); // jobId -> job
  const objects = new Map(); // key -> { body, contentType, sha256Base64, tags }
  const releases = new Map(); // sk -> item
  const auditItems = new Map(); // sk -> item
  // What customers did on the customer site (pk CUS of the audit table): sk -> item.
  const customerItems = new Map();
  const writeSlots = new Map(); // "sub#bucket" -> writes counted
  const auditPart = (partition) => {
    if (partition === 'AUD') return auditItems;
    if (partition === 'CUS') return customerItems;
    throw new TypeError('partition must be AUD or CUS');
  };
  const tokens = new Map(); // sk (the digest of a token) -> item
  const eventItems = new Map(); // thing -> Map(sk -> item): the events table
  const lineCounters = new Map(); // thing -> { boot, seq }: the board log's numbers
  const users = new Map(); // sub -> { email, enabled, status, groups, createdAt, mfa }
  const teamMail = []; // { email, kind }: what Cognito would have e-mailed to the team, in order
  let invited = 0;
  const faults = new Map(); // method -> [error | () => error]
  const calls = [];
  let highest; // the pointer item's value
  let eventDraws = 0;

  const clock = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : value;
  };

  function newExecution(at) {
    return {
      status: 'QUEUED',
      queuedAt: at,
      startedAt: null,
      lastUpdatedAt: at,
      executionNumber: 1,
      versionNumber: 1,
      statusDetails: {},
      forceCanceled: false,
    };
  }

  /**
   * Carry out a cancellation on one execution: a queued one always, one in progress
   * only if the cancellation was forced. `at` is when it takes effect.
   */
  function cancelExecution(execution, force, at) {
    if (execution.status !== 'QUEUED' && !(force && execution.status === 'IN_PROGRESS')) return;
    execution.forceCanceled = execution.status === 'IN_PROGRESS';
    execution.status = 'CANCELED';
    execution.lastUpdatedAt = at;
    execution.versionNumber += 1;
  }

  /**
   * Offer a paced job to the boards that are due by now (jobExecutionsRolloutConfig): `base` at
   * the start, and at each whole minute after as many as the rate then is. The rate grows by the
   * factor each time as many more boards as the criterion says have succeeded, up to the maximum.
   */
  function pace(job, at) {
    const plan = job.rollout;
    const minutes = Math.floor((at - job.rolloutAt) / 60_000);
    while (job.paced.minute < minutes && job.paced.offered < job.things.length && job.status === 'IN_PROGRESS') {
      job.paced.minute += 1;
      const succeeded = [...job.executions.values()].filter((execution) => execution.status === 'SUCCEEDED').length;
      const step = plan.exponentialRate?.rateIncreaseCriteria.numberOfSucceededThings ?? Infinity;
      while (succeeded - job.paced.counted >= step) {
        job.paced.counted += step;
        job.paced.rate = Math.min(
          plan.maximumPerMinute,
          Math.max(job.paced.rate + 1, Math.floor(job.paced.rate * plan.exponentialRate.incrementFactor))
        );
      }
      const when = job.rolloutAt + job.paced.minute * 60_000;
      for (const thing of job.things.slice(job.paced.offered, job.paced.offered + job.paced.rate)) {
        job.executions.set(thing, newExecution(when));
      }
      job.paced.offered = Math.min(job.things.length, job.paced.offered + job.paced.rate);
    }
  }

  /** Cancel a job by its abortConfig once its failures reach the threshold: what has not started stops. */
  function abortIfDue(job, at) {
    if (job.abort === null || job.status !== 'IN_PROGRESS') return;
    const executions = [...job.executions.values()];
    const executed = executions.filter((execution) => EXECUTED.has(execution.status)).length;
    for (const criterion of job.abort.criteriaList) {
      const failed = executions.filter((execution) =>
        FAILURE_TYPES[criterion.failureType].includes(execution.status)
      ).length;
      if (
        executed >= criterion.minNumberOfExecutedThings &&
        executed > 0 &&
        (100 * failed) / executed >= criterion.thresholdPercentage
      ) {
        job.status = 'CANCELED';
        job.lastUpdatedAt = at;
        job.aborted = true;
        for (const execution of executions) cancelExecution(execution, false, at);
        return;
      }
    }
  }

  /** Bring a job up to the current time: roll out, cancel, time out, complete. */
  function settle(job) {
    const at = clock();
    if (!job.rolledOut && at >= job.rolloutAt) {
      job.rolledOut = true;
      if (job.status === 'IN_PROGRESS' && job.rollout === null) {
        for (const thing of job.things) job.executions.set(thing, newExecution(job.rolloutAt));
      } else if (job.status === 'IN_PROGRESS') {
        const first = job.rollout.exponentialRate?.baseRatePerMinute ?? job.rollout.maximumPerMinute;
        job.paced = { minute: 0, rate: first, counted: 0, offered: Math.min(first, job.things.length) };
        for (const thing of job.things.slice(0, first)) job.executions.set(thing, newExecution(job.rolloutAt));
      }
    }
    if (job.rolledOut && job.paced !== null) pace(job, at);
    // Cancellations that were accepted earlier and are due by now, oldest first.
    while (job.cancellations.length > 0 && at >= job.cancellations[0].at) {
      const due = job.cancellations.shift();
      for (const execution of job.executions.values()) cancelExecution(execution, due.force, due.at);
    }
    for (const execution of job.executions.values()) {
      if (execution.status === 'IN_PROGRESS' && at - execution.startedAt >= job.timeoutMs) {
        execution.status = 'TIMED_OUT';
        execution.lastUpdatedAt = execution.startedAt + job.timeoutMs;
        execution.versionNumber += 1;
      }
    }
    abortIfDue(job, at);
    const allOffered = job.rollout === null || (job.paced !== null && job.paced.offered >= job.things.length);
    if (
      job.status === 'IN_PROGRESS' &&
      job.rolledOut &&
      allOffered &&
      [...job.executions.values()].every((execution) => TERMINAL.has(execution.status))
    ) {
      job.status = 'COMPLETED';
      job.completedAt = Math.max(job.createdAt, ...[...job.executions.values()].map((e) => e.lastUpdatedAt));
      job.lastUpdatedAt = job.completedAt;
    }
    return job;
  }

  function countsOf(job) {
    const counts = {
      queued: 0,
      inProgress: 0,
      succeeded: 0,
      failed: 0,
      rejected: 0,
      canceled: 0,
      timedOut: 0,
      removed: 0,
    };
    const names = {
      QUEUED: 'queued',
      IN_PROGRESS: 'inProgress',
      SUCCEEDED: 'succeeded',
      FAILED: 'failed',
      REJECTED: 'rejected',
      CANCELED: 'canceled',
      TIMED_OUT: 'timedOut',
      REMOVED: 'removed',
    };
    for (const execution of job.executions.values()) counts[names[execution.status]] += 1;
    return counts;
  }

  function summaryOf(execution) {
    return {
      status: execution.status,
      queuedAt: execution.queuedAt,
      startedAt: execution.startedAt,
      lastUpdatedAt: execution.lastUpdatedAt,
      executionNumber: execution.executionNumber,
    };
  }

  function checkThingName(operation, thing) {
    if (typeof thing !== 'string' || !THING_NAME.test(thing)) throw invalid(operation, 'thing name');
  }

  function checkJobId(operation, jobId) {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw invalid(operation, 'job id');
  }

  /** Store an item of the events table as PutItem does: an item with the same key is replaced. */
  function putEventItem(item) {
    assertStorable(item, 'item');
    if (typeof item.pk !== 'string' || item.pk === '' || typeof item.sk !== 'string' || item.sk === '') {
      throw new TypeError('pk and sk are required');
    }
    if (!eventItems.has(item.pk)) eventItems.set(item.pk, new Map());
    eventItems.get(item.pk).set(item.sk, copy(item));
  }

  /** The claim of a line, as the conditional PutItem of createEventStore makes it. */
  function claimLineItem(claim) {
    assertStorable(claim, 'claim');
    const there = eventItems.get(claim.pk)?.get(claim.sk);
    if (there !== undefined && there.at !== claim.at && Math.abs(there.at - claim.at) <= SAME_LINE_MS) {
      return { ok: false, reason: 'same_line' };
    }
    putEventItem(claim);
    return { ok: true };
  }

  /**
   * A fact of the update history, as the conditional PutItem of src/aws.mjs putUpdateFact makes it:
   * stored unless one as early or earlier has its key.
   */
  function putFactItem(item) {
    assertStorable(item, 'item');
    if (typeof item.pk !== 'string' || !item.pk.startsWith(FACT_PARTITION) || !Number.isSafeInteger(item.at)) {
      throw new TypeError('a fact of the update history has a pk "UPD#<thing>" and an `at` in ms');
    }
    const there = eventItems.get(item.pk)?.get(item.sk);
    if (there !== undefined && !(there.at > item.at)) return { ok: false, reason: 'kept' };
    putEventItem(item);
    return { ok: true };
  }

  /** What the rules and the recorder make of a message: repeatable random digits, the stand-in's clock. */
  function record(message) {
    if (isLineMessage(message)) {
      const made = recordsFromLine(message, { nowMs: clock() });
      if (made.items === undefined) return made;
      if (!claimLineItem(made.claim).ok) return { ...made, items: [], repeated: true };
      for (const item of made.items) putEventItem(item);
      for (const fact of factsFromItems(made.items)) putFactItem(fact);
      return made;
    }
    const made = recordsOf(message, {
      nowMs: clock(),
      randomHex: (count) => {
        eventDraws += 1;
        return createHash('sha256')
          .update(`event ${eventDraws}`)
          .digest('hex')
          .slice(0, 2 * count);
      },
    });
    for (const fact of factsFromItems(made.items ?? [])) putFactItem(fact);
    for (const item of made.items ?? []) putEventItem(item);
    // What the recorder then tells the alerter, if the alerts are on (test/fake-map.mjs).
    if (made.items !== undefined) map.helpers.recorded(message, made.items);
    return made;
  }

  /** A board's part of the events table between two sort keys, lowest first. */
  function eventPart(thing, low, high) {
    if (typeof thing !== 'string' || typeof low !== 'string' || typeof high !== 'string') {
      throw new TypeError('thing, low and high are required');
    }
    const part = eventItems.get(thing) ?? new Map();
    return [...part.keys()]
      .filter((sk) => sk >= low && sk <= high)
      .sort()
      .map((sk) => part.get(sk));
  }

  const adapter = {
    async listGroupThings() {
      return [...things]
        .filter(([, thing]) => thing.inGroup)
        .map(([name]) => name)
        .reverse();
    },

    async listThingPrincipals(thing) {
      checkThingName('ListThingPrincipals', thing);
      return things.has(thing) ? [...things.get(thing).principals] : [];
    },

    async getShadow(thing) {
      checkThingName('GetThingShadow', thing);
      return shadows.has(thing) ? copy(shadows.get(thing)) : null;
    },

    async listJobs() {
      return [...jobs.values()].map(settle).map((job) => ({
        jobId: job.jobId,
        status: job.status,
        createdAt: job.createdAt,
        lastUpdatedAt: job.lastUpdatedAt,
        completedAt: job.completedAt,
      }));
    },

    async describeJob(jobId) {
      checkJobId('DescribeJob', jobId);
      if (!jobs.has(jobId)) return null;
      const job = settle(jobs.get(jobId));
      return {
        jobId: job.jobId,
        status: job.status,
        description: job.description,
        things: [...job.things],
        createdAt: job.createdAt,
        lastUpdatedAt: job.lastUpdatedAt,
        completedAt: job.completedAt,
        forceCanceled: job.forceCanceled,
        reasonCode: job.reasonCode,
        counts: countsOf(job),
      };
    },

    async listJobExecutionsForJob(jobId) {
      checkJobId('ListJobExecutionsForJob', jobId);
      if (!jobs.has(jobId)) return [];
      const job = settle(jobs.get(jobId));
      return [...job.executions].map(([thing, execution]) => ({ thing, ...summaryOf(execution) }));
    },

    async describeJobExecution(jobId, thing) {
      checkJobId('DescribeJobExecution', jobId);
      checkThingName('DescribeJobExecution', thing);
      const job = jobs.has(jobId) ? settle(jobs.get(jobId)) : null;
      const execution = job?.executions.get(thing);
      if (execution === undefined) return null;
      const left =
        execution.status === 'IN_PROGRESS'
          ? Math.max(0, Math.ceil((execution.startedAt + job.timeoutMs - clock()) / 1000))
          : null;
      return {
        thing,
        ...summaryOf(execution),
        statusDetails: { ...execution.statusDetails },
        secondsLeft: left,
        forceCanceled: execution.forceCanceled,
      };
    },

    async listJobExecutionsForThing(thing) {
      checkThingName('ListJobExecutionsForThing', thing);
      if (!things.has(thing)) return [];
      const found = [];
      for (const job of jobs.values()) {
        const execution = settle(job).executions.get(thing);
        if (execution !== undefined) found.push({ jobId: job.jobId, ...summaryOf(execution) });
      }
      return found;
    },

    async createJob({
      jobId,
      things: targets,
      document,
      description,
      urlExpiresInSec,
      inProgressTimeoutMinutes,
      rollout = null,
      abort = null,
    }) {
      checkJobId('CreateJob', jobId);
      checkRollout(rollout);
      checkAbort(abort);
      if (!Array.isArray(targets) || targets.length === 0) throw invalid('CreateJob', 'targets');
      targets.forEach((thing) => checkThingName('CreateJob', thing));
      if (typeof document !== 'string' || document.length > 32768) throw invalid('CreateJob', 'document');
      try {
        JSON.parse(document);
      } catch {
        throw invalid('CreateJob', 'document is not JSON');
      }
      if (typeof description !== 'string' || description.length > 2028 || !NO_CONTROL.test(description)) {
        throw invalid('CreateJob', 'description');
      }
      if (!Number.isInteger(urlExpiresInSec) || urlExpiresInSec < 60 || urlExpiresInSec > 3600) {
        throw invalid('CreateJob', 'presignedUrlConfig.expiresInSec');
      }
      if (
        !Number.isInteger(inProgressTimeoutMinutes) ||
        inProgressTimeoutMinutes < 1 ||
        inProgressTimeoutMinutes > 10080
      ) {
        throw invalid('CreateJob', 'timeoutConfig.inProgressTimeoutInMinutes');
      }
      if (jobs.has(jobId)) return { ok: false, reason: 'exists' };
      if (targets.some((thing) => !things.has(thing))) return { ok: false, reason: 'target_not_found' };
      const at = clock();
      jobs.set(
        jobId,
        settle({
          jobId,
          status: 'IN_PROGRESS',
          description,
          document,
          things: [...targets],
          createdAt: at,
          lastUpdatedAt: at,
          completedAt: null,
          forceCanceled: false,
          reasonCode: null,
          comment: null,
          urlExpiresInSec,
          timeoutMs: inProgressTimeoutMinutes * 60_000,
          executions: new Map(),
          rolloutAt: at + rolloutDelayMs,
          rolledOut: false,
          cancellations: [],
          rollout: copy(rollout) ?? null,
          abort: copy(abort) ?? null,
          paced: null,
          aborted: false,
        })
      );
      return { ok: true };
    },

    async cancelJob({ jobId, force, reasonCode, comment }) {
      checkJobId('CancelJob', jobId);
      if (typeof force !== 'boolean') throw invalid('CancelJob', 'force');
      if (typeof reasonCode !== 'string' || reasonCode.length > 128 || !REASON_CODE.test(reasonCode)) {
        throw invalid('CancelJob', 'reasonCode');
      }
      if (typeof comment !== 'string' || comment.length > 2028 || !NO_CONTROL.test(comment)) {
        throw invalid('CancelJob', 'comment');
      }
      if (!jobs.has(jobId)) return { ok: false, reason: 'not_found' };
      const job = settle(jobs.get(jobId));
      if (job.status === 'COMPLETED' || job.status === 'DELETION_IN_PROGRESS') {
        return { ok: false, reason: 'refused', detail: `job is ${job.status}` };
      }
      if (job.status === 'CANCELED') {
        // Cancelled already: there is nothing more to do, unless a board is still at
        // work and force is asked for. What AWS does then is not documented.
        const running = [...job.executions.values()].some((execution) => execution.status === 'IN_PROGRESS');
        if (!(force && running) || repeatedCancel === 'refused') {
          return { ok: false, reason: 'refused', detail: 'job is CANCELED' };
        }
        if (repeatedCancel === 'ignored') return { ok: true };
      }
      // The job is cancelled at once; its executions follow, at once or after the delay.
      const at = clock();
      job.status = 'CANCELED';
      job.forceCanceled = job.forceCanceled || force;
      job.reasonCode = reasonCode;
      job.comment = comment;
      job.lastUpdatedAt = at;
      job.cancellations.push({ at: at + cancelDelayMs, force });
      settle(job);
      return { ok: true };
    },

    async putFirmwareObject({ key, body, sha256Base64 }) {
      if (typeof key !== 'string' || key === '') throw invalid('PutObject', 'key');
      if (!(body instanceof Uint8Array)) throw invalid('PutObject', 'body');
      // S3 compares what it received with the digest the caller announced.
      if (createHash('sha256').update(body).digest('base64') !== sha256Base64) {
        throw awsError('PutObject', 'BadDigest', { status: 400 });
      }
      if (objects.has(key)) return { stored: false, reason: 'exists' };
      objects.set(key, {
        body: Buffer.from(body),
        contentType: 'application/octet-stream',
        sha256Base64,
        tags: {},
      });
      return { stored: true };
    },

    async getFirmwareObject(key) {
      if (typeof key !== 'string' || key === '') throw invalid('GetObject', 'key');
      const object = objects.get(key);
      // The bucket policy refuses a revoked object, as it refuses a missing one.
      if (object === undefined || object.tags.revoked === 'true') return null;
      return Buffer.from(object.body);
    },

    // A Raspberry Pi image's upload (handlers/pi-images.mjs): the URL names what it was signed for,
    // and a test puts the object with fake.objects.set(key, { body }) as the browser would.
    async presignFirmwareUpload({ key, size, sha256Base64, expiresIn }) {
      return {
        url: `https://bucket.example.invalid/${key}?size=${size}&expires=${expiresIn}`,
        headers: { 'if-none-match': '*', 'x-amz-checksum-sha256': sha256Base64 },
        size,
        expiresAt: new Date(clock() + expiresIn * 1000).toISOString(),
      };
    },

    async headFirmwareObject(key) {
      const object = objects.get(key);
      if (object === undefined) return null;
      return {
        size: object.body.length,
        sha256Base64: object.sha256Base64 ?? createHash('sha256').update(object.body).digest('base64'),
      };
    },

    async tagFirmwareRevoked(key) {
      if (!objects.has(key)) return { ok: false, reason: 'not_found' };
      // PutObjectTagging replaces the whole tag set.
      objects.get(key).tags = { revoked: 'true' };
      return { ok: true };
    },

    async getRelease(sk) {
      return releases.has(sk) ? copy(releases.get(sk)) : null;
    },

    async listReleases() {
      return [...releases.keys()]
        .sort()
        .reverse()
        .map((sk) => copy(releases.get(sk)));
    },

    async highestReleaseKey() {
      return highest ?? null;
    },

    async registerRelease({ sk, release }) {
      if (typeof sk !== 'string' || sk === '') throw new TypeError('sk is required');
      assertStorable(release, 'release');
      // Both conditions of the transaction; either one cancels both writes.
      if (releases.has(sk)) return { ok: false, reason: 'exists' };
      if (highest !== undefined && !(highest < sk)) return { ok: false, reason: 'not_newer', highest };
      releases.set(sk, { ...copy(release), pk: 'REL', sk });
      highest = sk;
      return { ok: true };
    },

    async markReleaseRevoked({ sk, revoked }) {
      assertStorable(revoked, 'revoked');
      const item = releases.get(sk);
      if (item === undefined || item.status !== 'active') return { ok: false, reason: 'not_active' };
      item.status = 'revoked';
      item.revoked = copy(revoked);
      return { ok: true, release: copy(item) };
    },

    async markRevocationEnforced({ sk, at }) {
      if (typeof at !== 'string' || at === '') throw new TypeError('at is required');
      const item = releases.get(sk);
      if (item === undefined || item.status !== 'revoked') return { ok: false, reason: 'not_pending' };
      // DynamoDB can only set a member of a map that is there.
      if (item.revoked === null || typeof item.revoked !== 'object' || Array.isArray(item.revoked)) {
        throw awsError('UpdateItem', 'ValidationException', { status: 400 });
      }
      if (Object.hasOwn(item.revoked, 'enforcedAt')) return { ok: false, reason: 'not_pending' };
      item.revoked.enforcedAt = at;
      return { ok: true, release: copy(item) };
    },

    async setReleaseNotes({ sk, notes }) {
      if (typeof notes !== 'string') throw new TypeError('notes must be text');
      const item = releases.get(sk);
      if (item === undefined) return { ok: false, reason: 'not_found' };
      item.notes = notes;
      return { ok: true, release: copy(item) };
    },

    async getToken(sk) {
      if (typeof sk !== 'string' || sk === '') throw new TypeError('sk is required');
      return tokens.has(sk) ? copy(tokens.get(sk)) : null;
    },

    async listTokens(ownerSub) {
      if (typeof ownerSub !== 'string' || ownerSub === '') throw new TypeError('ownerSub is required');
      return [...tokens.values()].filter((item) => item.ownerSub === ownerSub).map(copy);
    },

    async putToken({ sk, token }) {
      if (typeof sk !== 'string' || sk === '') throw new TypeError('sk is required');
      assertStorable(token, 'token');
      if (tokens.has(sk)) return { ok: false, reason: 'exists' };
      tokens.set(sk, { ...copy(token), pk: 'TOK', sk });
      return { ok: true };
    },

    async markTokenRevoked({ sk, ownerSub, at }) {
      if (typeof at !== 'string' || at === '') throw new TypeError('at is required');
      const item = tokens.get(sk);
      // Both conditions of the update: the owner's token, and not revoked before.
      if (item === undefined || item.ownerSub !== ownerSub || item.revokedAt !== null) {
        return { ok: false, reason: 'not_active' };
      }
      item.revokedAt = at;
      return { ok: true, token: copy(item) };
    },

    async putAudit(item) {
      assertStorable(item, 'item');
      if (typeof item.sk !== 'string' || item.sk === '') throw new TypeError('sk is required');
      if (auditItems.has(item.sk)) return { ok: false, reason: 'exists' };
      auditItems.set(item.sk, { ...copy(item), pk: 'AUD' });
      return { ok: true };
    },

    // The customer API's (customer/aws.mjs createCustomerActionLog): the partition CUS only.
    async putCustomerAction(item) {
      assertStorable(item, 'item');
      if (typeof item.sk !== 'string' || item.sk === '') throw new TypeError('sk is required');
      if (customerItems.has(item.sk)) return { ok: false, reason: 'exists' };
      customerItems.set(item.sk, { ...copy(item), pk: 'CUS' });
      return { ok: true };
    },

    async recentCustomerActions({ sub, since }) {
      return [...customerItems.values()]
        .filter((item) => item.actor?.sub === sub && item.sk >= since)
        .map((item) => item.sk);
    },

    // customer/aws.mjs takeWriteSlot: a counter that goes up only while it is below the limit.
    async takeWriteSlot({ sub, bucket, limit }) {
      const key = `${sub}#${bucket}`;
      const n = writeSlots.get(key) ?? 0;
      if (n >= limit) return { ok: false, reason: 'limit' };
      writeSlots.set(key, n + 1);
      return { ok: true };
    },

    async queryAudit({ before, after = null, limit, partition = 'AUD' }) {
      if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
      const part = auditPart(partition);
      return [...part.keys()]
        .sort()
        .reverse()
        .filter((sk) => before === null || before === undefined || sk < before)
        .filter((sk) => after === null || after === undefined || sk > after)
        .slice(0, limit)
        .map((sk) => copy(part.get(sk)));
    },

    // As aws.mjs: a Query between two keys, filtered, that stops after `budget` items read.
    async searchAudit({
      low,
      high,
      before = null,
      actions = null,
      outcomes = null,
      text = null,
      limit,
      budget,
      partition = 'AUD',
    }) {
      if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(budget) || budget < 1) {
        throw new TypeError('limit and budget must be positive integers');
      }
      const part = auditPart(partition);
      const keys = [...part.keys()]
        .sort()
        .reverse()
        .filter((sk) => sk >= low && sk <= high);
      const items = [];
      let read = 0;
      for (const sk of keys) {
        read += 1;
        const item = part.get(sk);
        const matches =
          sk !== before &&
          (actions === null || actions.includes(item.action)) &&
          (outcomes === null || outcomes.includes(item.outcome)) &&
          (text === null || [item.target, item.actor?.email, item.requestId].some((value) => holdsSearch(value, text)));
        if (matches) items.push(copy(item));
        if (items.length > limit) return { items, read, next: null };
        if (read >= budget) return { items, read, next: read < keys.length ? sk : null };
      }
      return { items, read, next: null };
    },

    async queryEvents({ thing, low, high, kinds = null, tags = null, text = null, level = null, limit }) {
      if (kinds !== null && (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > 16)) {
        throw new TypeError('kinds must be null or a list of 1 to 16 kinds');
      }
      if (tags !== null && (!Array.isArray(tags) || tags.length === 0 || tags.length > 16)) {
        throw new TypeError('tags must be null or a list of 1 to 16 tags');
      }
      if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
      return eventPart(thing, low, high)
        .reverse()
        .filter((item) => kinds === null || kinds.includes(item.kind))
        .filter((item) => tags === null || tags.includes(item.tag))
        .filter((item) => level === null || (level === 'warn') === (item.level === 'warn'))
        .filter((item) => text === null || [item.text, item.what, item.tag].some((value) => holdsSearch(value, text)))
        .slice(0, limit)
        .map(copy);
    },

    async querySamples({ thing, low, high }) {
      return eventPart(thing, low, high).map(copy);
    },

    async queryUpdateFacts(thing) {
      checkThingName('Query', thing);
      const part = eventItems.get(factPartition(thing)) ?? new Map();
      return [...part.keys()].sort().map((sk) => copy(part.get(sk)));
    },

    async putUpdateFact(item) {
      return putFactItem(item);
    },

    async getUser(sub) {
      const user = users.get(sub);
      return user === undefined
        ? null
        : { enabled: user.enabled, status: user.status, email: user.email, name: user.name ?? '' };
    },

    async listUserGroups(sub) {
      const user = users.get(sub);
      return user === undefined ? [] : [...user.groups];
    },

    // The team's accounts (src/aws-team.mjs), for the Team page. A password is never here: Cognito's own.

    async listTeam() {
      return [...users.entries()].map(([sub, user]) => ({ ...teamMember(sub, user), mfa: null }));
    },

    async getTeamMember(sub) {
      const user = users.get(sub);
      return user === undefined ? null : teamMember(sub, user);
    },

    async inviteTeamMember({ email }) {
      const lower = String(email).toLowerCase();
      if ([...users.values()].some((user) => user.email === lower)) return { ok: false, reason: 'exists' };
      invited += 1;
      const sub = `00000000-0000-4000-9000-${String(invited).padStart(12, '0')}`;
      users.set(sub, {
        email: lower,
        enabled: true,
        status: 'FORCE_CHANGE_PASSWORD',
        groups: new Set(),
        createdAt: clock(),
        mfa: false,
      });
      teamMail.push({ email: lower, kind: 'invitation' });
      return { ok: true, member: teamMember(sub, users.get(sub)) };
    },

    async resendTeamInvitation(email) {
      const found = [...users.values()].find((user) => user.email === String(email).toLowerCase());
      if (found === undefined) return { ok: false, reason: 'not_found' };
      if (found.status !== 'FORCE_CHANGE_PASSWORD') return { ok: false, reason: 'not_invited' };
      teamMail.push({ email: found.email, kind: 'invitation again' });
      return { ok: true };
    },

    async addTeamMemberToGroup(sub, group) {
      const user = users.get(sub);
      if (user === undefined) return { ok: false, reason: 'not_found' };
      user.groups.add(group);
      return { ok: true };
    },

    async removeTeamMemberFromGroup(sub, group) {
      const user = users.get(sub);
      if (user === undefined) return { ok: false, reason: 'not_found' };
      user.groups.delete(group);
      return { ok: true };
    },

    async setTeamMemberEnabled(sub, enabled) {
      const user = users.get(sub);
      if (user === undefined) return { ok: false, reason: 'not_found' };
      user.enabled = enabled === true;
      return { ok: true };
    },

    async deleteTeamMember(sub) {
      if (!users.has(sub)) return { ok: false, reason: 'not_found' };
      users.delete(sub);
      return { ok: true };
    },

    // The fleet.

    async describeThing(thing) {
      checkThingName('DescribeThing', thing);
      return things.has(thing) ? { attributes: { ...things.get(thing).attributes } } : null;
    },

    async getFleetItem({ pk, sk }) {
      checkFleetKey(pk, sk);
      return fleetItems.has(`${pk} ${sk}`) ? copy(fleetItems.get(`${pk} ${sk}`)) : null;
    },

    async listFleetItems(pk, { limit = Infinity } = {}) {
      checkFleetKey(pk, 'x');
      return [...fleetItems.values()]
        .filter((item) => item.pk === pk)
        .sort((a, b) => (a.sk < b.sk ? 1 : -1))
        .slice(0, limit)
        .map(copy);
    },

    async putFleetItem({ pk, sk, item, replace = false }) {
      checkFleetKey(pk, sk);
      assertStorable(item, 'item');
      if (!replace && fleetItems.has(`${pk} ${sk}`)) return { ok: false, reason: 'exists' };
      fleetItems.set(`${pk} ${sk}`, { ...copy(item), pk, sk });
      return { ok: true };
    },

    async updateFleetItem({ pk, sk, rev, set }) {
      checkFleetKey(pk, sk);
      assertStorable(set, 'set');
      if (!Number.isInteger(rev)) throw new TypeError('rev must be an integer');
      for (const field of Object.keys(set)) {
        if (['pk', 'sk', 'rev'].includes(field)) throw new TypeError(`${field} cannot be set`);
      }
      const item = fleetItems.get(`${pk} ${sk}`);
      if (item === undefined || item.rev !== rev) return { ok: false, reason: 'changed' };
      Object.assign(item, copy(set), { rev: rev + 1 });
      return { ok: true, item: copy(item) };
    },
  };

  function checkFleetKey(pk, sk) {
    if (!FLEET_PKS.includes(pk)) throw new TypeError(`${String(pk)} is not a partition of the fleet`);
    if (typeof sk !== 'string' || sk === '') throw new TypeError('sk is required');
  }

  /** jobExecutionsRolloutConfig within the limits AWS IoT documents. */
  function checkRollout(rollout) {
    if (rollout === null) return;
    const rate = rollout?.exponentialRate;
    const criteria = rate?.rateIncreaseCriteria;
    const whole = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
    // A fixed rate: maximumPerMinute alone, as a stage of a rollout asks for.
    if (rate === undefined) {
      if (!whole(rollout?.maximumPerMinute, 1, 1000)) throw invalid('CreateJob', 'jobExecutionsRolloutConfig');
      return;
    }
    if (
      !whole(rollout.maximumPerMinute, 1, 1000) ||
      !whole(rate?.baseRatePerMinute, 1, 1000) ||
      !(rate.incrementFactor >= 1.1 && rate.incrementFactor <= 5) ||
      !whole(criteria?.numberOfSucceededThings, 1, 2 ** 31) ||
      rate.baseRatePerMinute > rollout.maximumPerMinute
    ) {
      throw invalid('CreateJob', 'jobExecutionsRolloutConfig');
    }
  }

  /** abortConfig within the limits AWS IoT documents. */
  function checkAbort(abort) {
    if (abort === null) return;
    const list = abort?.criteriaList;
    const fine =
      Array.isArray(list) &&
      list.length >= 1 &&
      list.every(
        (criterion) =>
          Object.hasOwn(FAILURE_TYPES, criterion.failureType) &&
          criterion.action === 'CANCEL' &&
          typeof criterion.thresholdPercentage === 'number' &&
          criterion.thresholdPercentage > 0 &&
          criterion.thresholdPercentage <= 100 &&
          Number.isInteger(criterion.minNumberOfExecutedThings) &&
          criterion.minNumberOfExecutedThings >= 1
      );
    if (!fine) throw invalid('CreateJob', 'abortConfig');
  }

  // The map, the commands and the alerts (docs/fleet.md, src/aws-map.mjs): test/fake-map.mjs, whose
  // items live in this events table, as the real ones do.
  const map = createFakeMap({
    clock,
    put: putEventItem,
    get: (pk, sk) => eventItems.get(pk)?.get(sk) ?? null,
    list: (pk, prefix) => eventPart(pk, prefix, `${prefix}\uffff`),
    // The alert rules, in the state table as the real ones are.
    rules: () => fleetItems.get('ALR rules') ?? null,
  });
  Object.assign(adapter, map.adapter);
  // The phone apps' releases and their APKs (docs/mobile-apps.md, src/aws-apps.mjs): test/fake-apps.mjs.
  const apps = createFakeApps({ clock });
  Object.assign(adapter, apps.adapter);
  // The Database page's reads (src/aws-db.mjs): test/fake-db.mjs, over the items kept here.
  const db = createFakeDb({
    stored: (table) => {
      if (table === 'audit') return [...auditItems.values(), ...customerItems.values()];
      if (table === 'events') return [...eventItems.values()].flatMap((part) => [...part.values()]);
      return [...releases.values(), ...tokens.values(), ...fleetItems.values()];
    },
  });
  Object.assign(adapter, db.adapter);
  // Whether a Memfault project key is stored (docs/memfault.md, src/aws-memfault.mjs createMemfaultStatus):
  // no, until fake.storeMemfaultKey() plays cloud/deploy.sh storing one.
  let memfaultKey = false;
  // Reads of Memfault's REST API (src/aws-memfault-api.mjs memfaultGet): not configured, as a stack with no
  // token, until fake.useMemfault() hands over a reader, such as the real one pointed at a fake Memfault
  // (test/fake-memfault.mjs).
  let memfaultReader = null;
  // Board setup's Wi-Fi defaults (src/aws-wifi-defaults.mjs): none stored, until fake.storeWifiDefaults()
  // plays cloud/deploy.sh storing some. A string, as Secrets Manager holds it.
  let wifiDefaults = null;
  Object.assign(adapter, {
    async wifiDefaults() {
      return wifiDefaults;
    },
  });
  Object.assign(adapter, {
    async memfaultKeyStored() {
      return memfaultKey;
    },
    async memfaultGet(path, query) {
      if (memfaultReader === null) throw memfaultError('not_configured');
      return memfaultReader.memfaultGet(path, query);
    },
  });

  // Provisioning through the console (src/aws-provision.mjs): things, certificates issued for a board's
  // request, the device policy on them. A certificate is { status, pem, policy, things }; one attached to a
  // thing EXCLUSIVE_THING cannot be attached to another, as AWS IoT has it. fake.misissueNext() makes the
  // next certificate be for another key, as the console must never hand on.
  const certificates = new Map(); // id -> certificate
  let misissue = false;
  const certificateId = (arn) => {
    const match = /:cert\/([0-9a-f]{64})$/.exec(String(arn));
    if (!match || !certificates.has(match[1])) {
      throw awsError('certificate', 'ResourceNotFoundException', { status: 404 });
    }
    return match[1];
  };
  Object.assign(adapter, {
    async createThing({ thing, attributes = null }) {
      checkThingName('CreateThing', thing);
      if (things.has(thing)) return { created: false };
      things.set(thing, { inGroup: false, principals: [], attributes: { ...(attributes ?? {}) } });
      return { created: true };
    },

    async updateThingAttributes({ thing, attributes }) {
      checkThingName('UpdateThing', thing);
      if (!things.has(thing)) throw awsError('UpdateThing', 'ResourceNotFoundException', { status: 404 });
      Object.assign(things.get(thing).attributes, attributes);
    },

    async addThingToGroup(thing) {
      checkThingName('AddThingToThingGroup', thing);
      if (!things.has(thing)) throw awsError('AddThingToThingGroup', 'ResourceNotFoundException', { status: 404 });
      things.get(thing).inGroup = true;
    },

    async createCertificateFromCsr(csr) {
      const request = parseCsr(csr);
      if (request === null) throw invalid('CreateCertificateFromCsr', 'certificate signing request');
      const id = createHash('sha256').update(`certificate ${certificates.size} ${csr}`).digest('hex');
      const key = misissue ? boardKey().publicKey.export({ format: 'der', type: 'spki' }) : request.publicKey;
      misissue = false;
      const pem = issueCertificate(key, { serial: certificates.size + 1, at: clock() });
      certificates.set(id, { status: 'ACTIVE', pem, policy: null, things: new Set() });
      return { arn: `arn:aws:iot:${REGION}:${ACCOUNT}:cert/${id}`, id, pem };
    },

    async attachDevicePolicy(arn) {
      certificates.get(certificateId(arn)).policy = 'cranium-device';
    },

    async attachThingPrincipal({ thing, arn }) {
      checkThingName('AttachThingPrincipal', thing);
      const certificate = certificates.get(certificateId(arn));
      if (!things.has(thing)) throw awsError('AttachThingPrincipal', 'ResourceNotFoundException', { status: 404 });
      if (certificate.things.size > 0 && !certificate.things.has(thing)) {
        throw invalid('AttachThingPrincipal', 'the certificate is attached to another thing exclusively');
      }
      certificate.things.add(thing);
      const principals = things.get(thing).principals;
      if (!principals.includes(arn)) principals.push(arn);
    },

    async retireCertificate({ thing, arn }) {
      const match = /:cert\/([0-9a-f]{64})$/.exec(String(arn));
      if (!match) throw new TypeError('not a certificate ARN');
      if (thing !== null && things.has(thing)) {
        things.get(thing).principals = things.get(thing).principals.filter((principal) => principal !== arn);
      }
      // One of addThing's, which this stand-in did not issue: only taken off the thing.
      if (!certificates.has(match[1])) return;
      const certificate = certificates.get(match[1]);
      if (thing !== null) certificate.things.delete(thing);
      certificate.policy = null;
      certificate.status = 'INACTIVE';
      if (certificate.things.size === 0) certificates.delete(match[1]);
    },

    async describeDataEndpoint() {
      return `a1b2c3d4e5f6g7-ats.iot.${REGION}.amazonaws.com`;
    },
  });

  const fake = {};
  for (const [method, run] of Object.entries(adapter)) {
    fake[method] = async (...args) => {
      calls.push({ method, args: args.map((arg) => (arg instanceof Uint8Array ? `<${arg.length} bytes>` : arg)) });
      const queued = faults.get(method);
      if (queued !== undefined && queued.length > 0) {
        const fault = queued.shift();
        throw typeof fault === 'function' ? fault() : fault;
      }
      return run(...args);
    };
  }

  Object.assign(fake, {
    /** Every adapter call so far, in order: { method, args }. */
    calls,

    /** The names of the adapter methods called so far, in order. */
    methodsCalled() {
      return calls.map((call) => call.method);
    },

    /** Make the next `times` calls of an adapter method throw, as the real adapter would. */
    failNext(method, { times = 1, code = 'failed', awsName = 'InternalFailureException' } = {}) {
      if (!Object.hasOwn(adapter, method)) throw new TypeError(`No adapter method ${method}`);
      const queued = faults.get(method) ?? [];
      for (let count = 0; count < times; count += 1) queued.push(() => awsError(method, awsName, { code }));
      faults.set(method, queued);
    },

    /** Store Board setup's Wi-Fi defaults, as text (JSON), or null for none. */
    storeWifiDefaults(text) {
      wifiDefaults = text;
    },

    /** A reader of Memfault's REST API for memfaultGet, or null for none. */
    useMemfault(reader) {
      memfaultReader = reader;
    },

    /** The certificates AWS IoT holds, by id: { status, pem, policy, things: [names] }. */
    certificates() {
      return Object.fromEntries(
        [...certificates].map(([id, certificate]) => [id, { ...certificate, things: [...certificate.things] }])
      );
    },

    /** Make the next certificate AWS IoT issues be for another key than the request's. */
    misissueNext() {
      misissue = true;
    },

    /** What cloud/deploy.sh does with ~/.cranium/memfault_project_key: store a key in the secret, or none. */
    storeMemfaultKey(stored = true) {
      memfaultKey = stored === true;
    },

    /** What the provisioning tool does: register a board and attach its certificate. */
    addThing(thing, { certificates = [], inGroup = true, attributes = {} } = {}) {
      if (typeof thing !== 'string' || !THING_NAME.test(thing)) throw new TypeError('Not a thing name');
      things.set(thing, {
        inGroup,
        principals: certificates.map((id) => `arn:aws:iot:${REGION}:${ACCOUNT}:cert/${id}`),
        attributes: { ...attributes },
      });
    },

    /** What `aws iot update-thing --attribute-payload` does to a thing's attributes. */
    setThingAttributes(thing, attributes) {
      if (!things.has(thing)) throw new TypeError(`No thing ${thing}`);
      things.get(thing).attributes = { ...attributes };
    },

    removeThing(thing) {
      things.delete(thing);
      shadows.delete(thing);
      booted.delete(thing);
    },

    /** The board's side of its shadow. */
    device(thing) {
      if (!things.has(thing)) throw new TypeError(`No thing ${thing}`);
      return {
        /**
         * Publish to shadow/update: merges into state.reported and stamps the metadata.
         * Like the firmware, every publish carries the uptime; unless one is given it is
         * the time since the board's first report, or since the uptime it gave last.
         */
        report(reported) {
          const at = clock();
          const stamp = Math.floor(at / 1000);
          if (Number.isFinite(reported.uptime)) booted.set(thing, at - reported.uptime * 1000);
          else if (!booted.has(thing)) booted.set(thing, at);
          const update =
            reported.uptime === undefined
              ? { ...reported, uptime: Math.floor((at - booted.get(thing)) / 1000) }
              : reported;

          let shadow = shadows.get(thing);
          const wellFormed =
            shadow !== null &&
            typeof shadow === 'object' &&
            typeof shadow.state?.reported === 'object' &&
            shadow.state.reported !== null &&
            typeof shadow.metadata?.reported === 'object' &&
            shadow.metadata.reported !== null;
          if (!wellFormed)
            shadow = { state: { reported: {} }, metadata: { reported: {} }, version: 0, timestamp: stamp };
          const previous = copy({ state: shadow.state, metadata: shadow.metadata, version: shadow.version });
          mergeReported(shadow.state.reported, shadow.metadata.reported, update, stamp);
          shadow.version = (Number.isInteger(shadow.version) ? shadow.version : 0) + 1;
          shadow.timestamp = stamp;
          shadows.set(thing, shadow);
          // What AWS IoT publishes on $aws/things/<thing>/shadow/update/documents, as the rule
          // selects it.
          record({
            previous: wellFormed ? previous : undefined,
            current: copy({ state: shadow.state, metadata: shadow.metadata, version: shadow.version }),
            timestamp: stamp,
            thing,
          });
        },
        /** The board connects to AWS IoT: the presence message of the second rule. */
        connect() {
          record({ clientId: thing, timestamp: clock(), eventType: 'connected' });
        },
        /** The connection ends, for the reason AWS IoT gives (disconnectReason). */
        disconnect(reason = 'CONNECTION_LOST') {
          record({
            clientId: thing,
            timestamp: clock(),
            eventType: 'disconnected',
            disconnectReason: reason,
            clientInitiatedDisconnect: reason === 'CLIENT_INITIATED_DISCONNECT',
          });
        },
        /**
         * The board prints a line that goes to the console in the cloud (firmware 1.12.0): one
         * message on cranium/<thing>/events, as the board log's rule selects it. The line was
         * printed `waitedMs` before it was sent; `seq` and `boot` count as the board does unless
         * given. Returns what the recorder made of it.
         */
        log(tag, text, { waitedMs = 0, seq, boot, dropped, received = clock() } = {}) {
          // A board heard of for the first time here has been up a minute, or as long as the line waited.
          if (!booted.has(thing)) booted.set(thing, clock() - Math.max(60_000, waitedMs));
          const up = Math.max(0, clock() - booted.get(thing));
          const counter = lineCounters.get(thing) ?? { boot: 1, seq: 0 };
          counter.seq = seq ?? counter.seq + 1;
          if (boot !== undefined) counter.boot = boot;
          lineCounters.set(thing, counter);
          const message = {
            t: Math.max(0, up - waitedMs),
            seq: counter.seq,
            boot: counter.boot,
            up,
            tag,
            text,
            thing,
            received,
          };
          if (dropped !== undefined) message.dropped = dropped;
          return record(message);
        },
        /** Put any document in place of the shadow, to see how the console copes. */
        setRaw(document) {
          shadows.set(thing, copy(document));
        },
        clear() {
          shadows.delete(thing);
        },
        get() {
          return copy(shadows.get(thing) ?? null);
        },
        /**
         * What the board gets when it asks AWS IoT for its next job: the execution in
         * progress, or else the one queued longest, as { jobId, status, document }; null
         * if there is none. AWS would put a download URL where the document names one.
         */
        nextJob() {
          const pending = [];
          for (const job of jobs.values()) {
            const execution = settle(job).executions.get(thing);
            if (execution !== undefined && !TERMINAL.has(execution.status)) pending.push({ job, execution });
          }
          pending.sort(
            (a, b) =>
              (a.execution.status === 'IN_PROGRESS' ? 0 : 1) - (b.execution.status === 'IN_PROGRESS' ? 0 : 1) ||
              a.execution.queuedAt - b.execution.queuedAt
          );
          if (pending.length === 0) return null;
          const [{ job, execution }] = pending;
          return { jobId: job.jobId, status: execution.status, document: JSON.parse(job.document) };
        },
      };
    },

    /** The board's side of one job execution. */
    execution(jobId, thing) {
      return {
        get() {
          const job = jobs.has(jobId) ? settle(jobs.get(jobId)) : null;
          const execution = job?.executions.get(thing);
          return execution === undefined ? null : copy(execution);
        },
        /**
         * UpdateJobExecution as the board sends it over MQTT. Returns { accepted: true }
         * or { accepted: false, code } with the code AWS IoT answers on update/rejected.
         * A board may only continue once its update was accepted.
         */
        update(status, details) {
          if (!DEVICE_STATUSES.has(status)) return { accepted: false, code: 'InvalidRequest' };
          if (details !== undefined) {
            const entries = details === null || typeof details !== 'object' ? null : Object.entries(details);
            const valid =
              entries !== null &&
              entries.length <= 10 &&
              entries.every(
                ([key, value]) =>
                  DETAIL_KEY.test(key) &&
                  typeof value === 'string' &&
                  value.length >= 1 &&
                  value.length <= 1024 &&
                  NO_CONTROL.test(value)
              );
            if (!valid) return { accepted: false, code: 'InvalidRequest' };
          }
          const job = jobs.has(jobId) ? settle(jobs.get(jobId)) : null;
          const execution = job?.executions.get(thing);
          if (execution === undefined) return { accepted: false, code: 'ResourceNotFound' };
          if (TERMINAL.has(execution.status)) return { accepted: false, code: 'InvalidStateTransition' };
          const at = clock();
          if (status === 'IN_PROGRESS' && execution.startedAt === null) execution.startedAt = at;
          execution.status = status;
          execution.lastUpdatedAt = at;
          execution.versionNumber += 1;
          if (details !== undefined) execution.statusDetails = { ...details };
          settle(job);
          return { accepted: true };
        },
      };
    },

    /** What the user administrator does: create a user and put it in groups. */
    addUser({ sub, email, groups = [], enabled = true, status = 'CONFIRMED', mfa = status === 'CONFIRMED' }) {
      if (typeof sub !== 'string' || sub === '') throw new TypeError('sub is required');
      users.set(sub, { email, enabled, status, groups: new Set(groups), createdAt: clock(), mfa });
    },

    /** What Cognito would have e-mailed to the team: invitations, never a password here. */
    teamMail,

    /** Whether an account is in the pool now. */
    hasUser(sub) {
      return users.has(sub);
    },

    /** What the user pool holds as an account's name (getUser's `name`: the first word of its given name or name). */
    nameUser(sub, name) {
      const user = users.get(sub);
      if (user === undefined) throw new TypeError(`No user ${sub}`);
      user.name = name;
    },

    user(sub) {
      const user = users.get(sub);
      if (user === undefined) throw new TypeError(`No user ${sub}`);
      return {
        setGroups(groups) {
          user.groups = new Set(groups);
        },
        disable() {
          user.enabled = false;
        },
        enable() {
          user.enabled = true;
        },
        setStatus(status) {
          user.status = status;
        },
        groups() {
          return [...user.groups].sort();
        },
        state() {
          return { enabled: user.enabled, status: user.status, mfa: user.mfa };
        },
        remove() {
          users.delete(sub);
        },
      };
    },

    /** The stand-in for the recorder's adapter (src/aws.mjs createEventStore). */
    eventStore() {
      return Object.freeze({
        async putUpdateFact(item) {
          calls.push({ method: 'putUpdateFact', args: [item] });
          return putFactItem(item);
        },
        async putEvent(item) {
          calls.push({ method: 'putEvent', args: [item] });
          putEventItem(item);
        },
        async claimLine(claim) {
          calls.push({ method: 'claimLine', args: [claim] });
          return claimLineItem(claim);
        },
      });
    },

    /** Hand a message to the recorder as one of the two rules would: what it made, or why it was dropped. */
    deliver(message) {
      return record(message);
    },

    /** A board's facts of the update history (src/lib/updates.mjs), lowest sort key first. */
    updateFacts(thing) {
      const part = eventItems.get(factPartition(thing)) ?? new Map();
      return [...part.keys()].sort().map((sk) => copy(part.get(sk)));
    },

    /** Put an item in the events table as it is, as an older recorder left it there (the backfill's tests). */
    putEventItem(item) {
      putEventItem(item);
    },

    /** A board's items in the events table, lowest sort key first. */
    eventItems(thing) {
      return [...(eventItems.get(thing) ?? new Map()).keys()].sort().map((sk) => copy(eventItems.get(thing).get(sk)));
    },

    /** What is stored, for assertions. */
    objects,
    releases,
    jobs,
    tokens,
    fleetItems,
    auditLog() {
      return [...auditItems.keys()].sort().map((sk) => copy(auditItems.get(sk)));
    },
    /** What customers did, as the customer API stored it (pk CUS), oldest first. */
    customerActionLog() {
      return [...customerItems.keys()].sort().map((sk) => copy(customerItems.get(sk)));
    },
    highestRegistered() {
      return highest ?? null;
    },
  });

  Object.assign(fake, map.helpers);
  Object.assign(fake, apps.helpers);
  Object.assign(fake, db.helpers);

  return fake;
}

/** A file from test/fixtures. */
export function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
}

/**
 * An environment for loadConfig (src/config.mjs) that goes with the fake: local names,
 * the layout of the fixture images, and the public key the fixtures are signed for.
 */
export function fakeEnv(overrides = {}) {
  const der = createPublicKey(fixture('test_signing_pub.pem')).export({ type: 'spki', format: 'der' });
  return {
    AWS_REGION: REGION,
    STATE_TABLE: 'local-state',
    AUDIT_TABLE: 'local-audit',
    EVENTS_TABLE: 'local-events',
    FIRMWARE_BUCKET: 'local-firmware',
    THING_GROUP: 'cranium-devices',
    PRESIGN_ROLE_ARN: `arn:aws:iam::${ACCOUNT}:role/local-presign`,
    USER_POOL_ID: `${REGION}_local`,
    USER_POOL_CLIENT_ID: 'localclient',
    MOBILE_CLIENT_ID: 'localmobile',
    SIGNING_PUBLIC_KEY_B64: der.toString('base64'),
    SLOT_SIZE: '933888',
    LOAD_ADDRESS: '196608',
    // Where the e-mail alerts go (src/aws-map.mjs): read by the adapter, not by loadConfig.
    ALERT_TOPIC_ARN: `arn:aws:sns:${REGION}:${ACCOUNT}:local-alerts`,
    // The console's address and its login pages, for the phone apps' configuration (GET /api/apps/config).
    CONSOLE_URL: 'https://console.example.invalid',
    LOGIN_DOMAIN: `local.auth.${REGION}.amazoncognito.com`,
    // What provisioning through the console gives a board (src/handlers/provision.mjs).
    DEVICE_POLICY: 'cranium-device',
    FIRMWARE_DOWNLOAD_PREFIX: `https://local-firmware.s3.${REGION}.amazonaws.com/firmware/`,
    ...overrides,
  };
}

/**
 * The claims of an access token as API Gateway hands them to the function: every value
 * a string, and the groups flattened into one bracketed string.
 */
export function accessClaims({ sub, groups = [], clientId = 'localclient', exp = 4102444800, authTime = null }) {
  const claims = {
    sub,
    token_use: 'access',
    client_id: clientId,
    scope: 'openid cranium/console',
    username: sub,
    exp: String(exp),
  };
  if (authTime !== null) claims.auth_time = String(authTime);
  if (groups !== null) claims['cognito:groups'] = `[${groups.join(' ')}]`;
  return claims;
}

let requestCount = 0;

/**
 * An API Gateway HTTP API event in payload format 2.0. Like the gateway, it gives
 * every request its own id unless one is passed in. A path under /api/t/ is one of the
 * routes for API tokens, which have no authorizer: `headers` carries the token.
 */
export function apiEvent(method, path, { claims, body, query, requestId, base64 = false, headers = {} } = {}) {
  if (requestId === undefined) {
    requestCount += 1;
    requestId = `local-${String(requestCount).padStart(6, '0')}`;
  }
  let routeKey = `${method} /api/{proxy+}`;
  if (typeof path === 'string' && path.startsWith('/api/t/')) routeKey = `${method} /api/t/{proxy+}`;
  // SideStore's requests, with no authorizer either (src/handlers/sidestore.mjs).
  if (typeof path === 'string' && method === 'GET' && path.startsWith('/api/sidestore/'))
    routeKey = 'GET /api/sidestore/{proxy+}';
  const event = {
    version: '2.0',
    routeKey,
    rawPath: path,
    rawQueryString: query === undefined ? '' : new URLSearchParams(query).toString(),
    // The gateway hands header names on in lower case.
    headers: {
      'content-type': 'application/json',
      ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
    },
    requestContext: {
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId,
      routeKey,
      stage: '$default',
    },
    isBase64Encoded: false,
  };
  if (claims !== undefined) event.requestContext.authorizer = { jwt: { claims, scopes: ['cranium/console'] } };
  if (query !== undefined) event.queryStringParameters = { ...query };
  if (body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    event.body = base64 ? Buffer.from(text, 'utf8').toString('base64') : text;
    event.isBase64Encoded = base64;
  }
  return event;
}

/**
 * Stand-ins for setTimeout and clearTimeout that fire when a test says so. The handler
 * sets one timer per request, for the time the request may take.
 *
 *   const timers = manualTimers();
 *   const console_ = createTestConsole({ timers });
 *   ...                         // a request that waits for something
 *   timers.expire();            // its time is up
 */
export function manualTimers() {
  const pending = new Map(); // id -> { run, ms }
  let last = 0;
  return {
    set(run, ms) {
      last += 1;
      pending.set(last, { run, ms });
      return last;
    },
    clear(id) {
      pending.delete(id);
    },
    /** The delays of the timers that are set and have neither fired nor been cleared. */
    waiting() {
      return [...pending.values()].map((timer) => timer.ms);
    },
    /** Fire every timer that is waiting. */
    expire() {
      for (const [id, timer] of [...pending]) {
        pending.delete(id);
        timer.run();
      }
    },
  };
}

// A reserved domain that can never receive mail.
const MAIL_DOMAIN = 'example.invalid';

/**
 * The real handlers wired to a fake adapter, with a clock the caller moves by hand.
 * Used by the tests; everything it holds was put there by the test.
 *
 *   const console_ = createTestConsole();
 *   const manager = console_.addUser('manager', ['release-managers']);
 *   const { status, body } = await console_.call('GET', '/api/firmware', { as: manager });
 */
export function createTestConsole({
  rolloutDelayMs = 0,
  cancelDelayMs = 0,
  repeatedCancel,
  timers,
  env = {},
  startMs = Date.UTC(2026, 9, 10, 22, 15, 0),
  versions,
  pacing,
} = {}) {
  const clock = { ms: startMs };
  const now = () => clock.ms;
  const fake = createFakeAws({ now, rolloutDelayMs, cancelDelayMs, repeatedCancel });
  const config = loadConfig(fakeEnv(env));
  const logs = [];
  let draws = 0;
  const app = createApp({
    aws: fake,
    config,
    now,
    timers,
    // What versions.json would hold (src/lib/versions.mjs). Left out, none: a test does not depend on
    // whether this checkout was ever deployed.
    versions: versions ?? parseBundledVersions(null),
    // How AWS IoT's job reads are paced (src/lib/iot-pace.mjs): a test may give it a clock and sleep.
    pacing,
    log: (line) => logs.push(line),
    // Repeatable, so that ids in a test are the same on every run.
    randomHex: (count) => {
      draws += 1;
      return createHash('sha256')
        .update(`draw ${draws}`)
        .digest('hex')
        .repeat(4)
        .slice(0, 2 * count);
    },
  });
  let people = 0;

  return {
    fake,
    app,
    config,
    clock,
    logs,

    /** Move the clock forward. */
    advance(ms) {
      clock.ms += ms;
    },

    /** Create a user in the fake pool and return it with the claims of its token. */
    addUser(name, groups, { tokenGroups = groups, enabled = true, status = 'CONFIRMED' } = {}) {
      people += 1;
      const sub = `00000000-0000-4000-8000-${String(people).padStart(12, '0')}`;
      const email = `${name}@${MAIL_DOMAIN}`;
      fake.addUser({ sub, email, groups, enabled, status });
      return { sub, email, claims: accessClaims({ sub, groups: tokenGroups, clientId: config.userPoolClientId }) };
    },

    /**
     * Send one request through the handler. `as` is a user from addUser; `token` is an
     * API token, sent as "Bearer <token>" (`authorization` sends that header as given);
     * `invocation` is what Lambda passes as the second argument, if the test has a use for it.
     */
    async call(method, path, { as, claims, body, query, requestId, base64, invocation, token, authorization } = {}) {
      const headers = {};
      if (token !== undefined) headers.authorization = `Bearer ${token}`;
      if (authorization !== undefined) headers.authorization = authorization;
      const event = apiEvent(method, path, {
        claims: claims ?? as?.claims,
        body,
        query,
        requestId,
        base64,
        headers,
      });
      const response = await app(event, invocation);
      // A firmware image comes back as base64 bytes, a redirect with no body; everything else is JSON.
      let decoded;
      if (response.isBase64Encoded === true) decoded = Buffer.from(response.body, 'base64');
      else decoded = response.body === '' ? null : JSON.parse(response.body);
      return { status: response.statusCode, headers: response.headers, body: decoded };
    },
  };
}
