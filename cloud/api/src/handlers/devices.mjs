/**
 * Boards: GET /api/devices and GET /api/devices/{thing}, and a board's name in the console:
 *
 *   POST /api/devices/{thing}/label   body { label }   -> { thing, label }   device.rename, release managers
 *
 * `label` is 1 to 40 printable characters, trimmed, or null or "" to take the name away (lib/names.mjs).
 * Every Device in a reply carries its `label`, or null.
 *
 * The boards of this project are the members of one thing group. What a board says
 * about itself comes from its shadow and is display data only (lib/shadow.mjs).
 * Shadows are cached for a few seconds in this module's memory, because several views
 * and every poll of a running deployment read the same ones.
 *
 * A board's own page also says whether its Memfault data reaches Memfault (lib/memfault.mjs):
 * `memfault` beside `device`. Whether a project key is stored is asked of AWS at most every
 * MEMFAULT_KEY_CACHE_MS, and a question AWS does not answer says no for MEMFAULT_KEY_RETRY_MS.
 */

import { describeError, field, notFound } from '../http.mjs';
import { change } from '../lib/audit.mjs';
import { EXECUTION_STATUSES, isoTime } from '../lib/jobs.mjs';
import { memfaultView } from '../lib/memfault.mjs';
import { NAMES_PK, labelFromItem, requireBoardLabel } from '../lib/names.mjs';
import { deviceFromShadow, unknownDevice } from '../lib/shadow.mjs';
import { isThing, parseJobId, requireThing } from '../lib/validate.mjs';

const SHADOW_CACHE_MS = 5000;
const MAX_CACHED_SHADOWS = 512;
// AWS has been asked for all of a board's executions by the time this applies, so it only
// limits the size of the reply. The reply says how many were left out (olderExecutions).
const MAX_HISTORY = 50;

export const MEMFAULT_KEY_CACHE_MS = 5 * 60_000;
export const MEMFAULT_KEY_RETRY_MS = 60_000;

const CERTIFICATE_ARN = /^arn:[a-z0-9-]+:iot:[a-z0-9-]+:\d{12}:cert\/([0-9a-f]{64})$/;
const ANY_JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The first 16 hex digits of each certificate attached to a thing. */
function certificateIds(principals) {
  const ids = new Set();
  for (const principal of principals) {
    const match = typeof principal === 'string' ? CERTIFICATE_ARN.exec(principal) : null;
    if (match) ids.add(match[1].slice(0, 16));
  }
  return [...ids].sort();
}

/** All executions of a thing as ExecutionSummary records, newest first. */
function history(executions) {
  const rows = [];
  for (const execution of executions) {
    if (typeof execution.jobId !== 'string' || !ANY_JOB_ID.test(execution.jobId)) continue;
    if (!EXECUTION_STATUSES.includes(execution.status)) continue;
    const queuedAt = isoTime(execution.queuedAt) ?? isoTime(execution.lastUpdatedAt);
    if (queuedAt === null) continue;
    rows.push({
      deployment: execution.jobId,
      // Null for a job that some other tool created on this thing.
      version: parseJobId(execution.jobId)?.version ?? null,
      status: execution.status,
      queuedAt,
      startedAt: isoTime(execution.startedAt),
      lastUpdatedAt: isoTime(execution.lastUpdatedAt) ?? queuedAt,
    });
  }
  rows.sort((a, b) =>
    a.queuedAt < b.queuedAt ? 1 : a.queuedAt > b.queuedAt ? -1 : a.deployment < b.deployment ? 1 : -1
  );
  return rows;
}

export function createDeviceHandlers({ aws, config, now, log }) {
  const shadows = new Map();
  // The names given in the console, thing -> label, and when they were read: { labels, at }.
  let names = null;

  /** Every board's name given in the console. A partition that cannot be read names nobody; it never fails a list. */
  async function readLabels() {
    if (names !== null && now() - names.at < SHADOW_CACHE_MS) return names.labels;
    const labels = new Map();
    try {
      for (const item of await aws.listFleetItems(NAMES_PK)) {
        const label = labelFromItem(item);
        if (label !== null && isThing(item?.thing)) labels.set(item.thing, label);
      }
    } catch (error) {
      log({ level: 'warn', event: 'labels_unreadable', error: describeError(error).message });
      return labels;
    }
    names = { labels, at: now() };
    return labels;
  }

  /** The Devices with their names given in the console. */
  async function labelled(devices) {
    const labels = await readLabels();
    return devices.map((device) => ({ ...device, label: labels.get(device.thing) ?? null }));
  }
  // Whether a Memfault project key is stored, and until when that answer holds: { stored, until }.
  let memfaultKey = null;

  async function memfaultKeyStored() {
    if (memfaultKey !== null && now() < memfaultKey.until) return memfaultKey.stored;
    if (typeof aws.memfaultKeyStored !== 'function') return false;
    try {
      memfaultKey = { stored: (await aws.memfaultKeyStored()) === true, until: now() + MEMFAULT_KEY_CACHE_MS };
    } catch (error) {
      log({ level: 'warn', event: 'memfault_key_unknown', error: describeError(error).message });
      memfaultKey = { stored: false, until: now() + MEMFAULT_KEY_RETRY_MS };
    }
    return memfaultKey.stored;
  }

  async function readShadow(thing, maxAgeMs) {
    const cached = shadows.get(thing);
    if (cached !== undefined && now() - cached.at < maxAgeMs) return cached.shadow;
    const shadow = await aws.getShadow(thing);
    if (shadows.size >= MAX_CACHED_SHADOWS) shadows.clear();
    shadows.set(thing, { shadow, at: now() });
    return shadow;
  }

  /**
   * The Device for each of the given things, in the same order. A shadow that cannot
   * be read leaves its board looking as if it never reported; it never fails the rest.
   */
  async function loadDevices(things, maxAgeMs = SHADOW_CACHE_MS) {
    const settled = await Promise.allSettled(things.map((thing) => readShadow(thing, maxAgeMs)));
    return things.map((thing, index) => {
      const result = settled[index];
      if (result.status === 'rejected') {
        log({ level: 'warn', event: 'shadow_unreadable', thing, error: describeError(result.reason).message });
        return unknownDevice(thing);
      }
      return deviceFromShadow(thing, result.value, now());
    });
  }

  /** The names of the project's boards, each once, sorted. */
  async function groupThings() {
    return [...new Set((await aws.listGroupThings()).filter(isThing))].sort();
  }

  /**
   * The shadow documents of the given things, in the same order, from the same cache as
   * loadDevices: null for a board that never reported, or whose shadow cannot be read. For the
   * fleet (handlers/fleet.mjs), which reads the board type a board reports beside its Device.
   */
  async function loadShadows(things, maxAgeMs = SHADOW_CACHE_MS) {
    const settled = await Promise.allSettled(things.map((thing) => readShadow(thing, maxAgeMs)));
    return settled.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      log({
        level: 'warn',
        event: 'shadow_unreadable',
        thing: things[index],
        error: describeError(result.reason).message,
      });
      return null;
    });
  }

  return {
    loadDevices,
    groupThings,
    loadShadows,

    async list() {
      const devices = await labelled(await loadDevices(await groupThings()));
      return { body: { devices, generatedAt: new Date(now()).toISOString() } };
    },

    /** A board's name in the console, given or taken away: one item, replaced, and a change on record. */
    async rename({ actor, params, json, entry }) {
      const thing = requireThing(params.thing);
      entry.target = thing;
      const label = requireBoardLabel(field(json(), 'label') ?? null);
      if (!(await groupThings()).includes(thing)) {
        throw notFound('unknown_device', 'No board with that name is registered.');
      }
      const before = labelFromItem(await aws.getFleetItem({ pk: NAMES_PK, sk: thing }));
      const item = { thing, label, at: new Date(now()).toISOString(), by: { sub: actor.sub, email: actor.email } };
      await aws.putFleetItem({ pk: NAMES_PK, sk: thing, item, replace: true });
      names = null;
      if (label !== null) entry.detail.name = label;
      if (before !== null) entry.detail.renamedFrom = before;
      change(entry, 'name', before, label);
      return { body: { thing, label } };
    },

    async get({ params }) {
      const thing = requireThing(params.thing);
      if (!(await groupThings()).includes(thing)) {
        throw notFound('unknown_device', 'No board with that name is registered.');
      }
      const [[device], principals, executions, keyStored] = await Promise.all([
        loadDevices([thing]).then(labelled),
        aws.listThingPrincipals(thing),
        aws.listJobExecutionsForThing(thing),
        memfaultKeyStored(),
      ]);
      const rows = history(executions);
      return {
        body: {
          device,
          certificates: certificateIds(principals),
          executions: rows.slice(0, MAX_HISTORY),
          olderExecutions: Math.max(0, rows.length - MAX_HISTORY),
          memfault: memfaultView(device, { keyStored, ...(config?.memfault ?? {}) }),
        },
      };
    },
  };
}
