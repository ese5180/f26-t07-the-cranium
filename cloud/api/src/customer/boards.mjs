/**
 * What a customer is shown about a board they own, and nothing more (docs/customer-site.md).
 *
 * The console's Device (lib/shadow.mjs) is read from the shadow as everywhere, and then cut
 * down: no thing name, no certificate, no MAC address or Wi-Fi channel, no memory figures, no
 * boot diary, no job id, no error text a board wrote. A board is named to its owner by the id
 * of its assignment (`ref`, 16 hex digits drawn when it was assigned), never by its thing name,
 * so an address in the customer site says nothing about the fleet.
 *
 * The same for events (lib/events.mjs): of the kinds a customer can make sense of, the typed
 * fields only, never the text written for the console, which names AWS IoT and job steps.
 *
 * No AWS here and no clock: the caller passes both in.
 */

import { parseJobId } from '../lib/validate.mjs';

export const REF = /^[0-9a-f]{16}$/;
export const LABEL_LIMIT = 40;

/** What a board is doing, in one word: online, updating, restarting, offline or new (never reported). */
export function boardStatus(device) {
  if (device.lastSeen === null) return 'new';
  if (!device.online) return 'offline';
  const state = device.ota?.state ?? 'idle';
  if (state === 'rebooting') return 'restarting';
  if (state === 'downloading' || state === 'verifying' || state === 'testing') return 'updating';
  return 'online';
}

/**
 * A board as its owner sees it.
 *
 * @param {object} device     a Device from lib/shadow.mjs
 * @param {object} ownership  { ref, label, customerLabel, assignedAt } from the ownership partition
 * @param {object} [health]   customer/health.mjs boardHealth, else null
 */
export function customerBoard(device, ownership, health = null) {
  return {
    id: ownership.ref,
    // The owner's own name for it, else what the admin called it when it was assigned, else what
    // the board calls itself.
    name: ownership.customerLabel || ownership.label || device.name || null,
    // The owner's own name only (POST /api/c/boards/{id}/label), or null: what the rename starts from.
    label: ownership.customerLabel || null,
    boardName: device.name ?? null,
    status: boardStatus(device),
    online: device.online === true,
    lastSeen: device.lastSeen,
    firmware: device.fw === null ? null : { version: device.fw.version, confirmed: device.fw.confirmed },
    update:
      device.ota === null ? null : { state: device.ota.state, progress: device.ota.progress, last: device.ota.last },
    rssi: device.rssi,
    uptime: device.uptime,
    // Where it is: the fleet work's location by Wi-Fi (docs/fleet.md) is not built yet.
    location: null,
    since: ownership.assignedAt,
    // In plain words, from the restart events: never a cause, a fault name or a stack.
    health,
  };
}

// The kinds of event a customer is shown. Health (memory, Wi-Fi channel, names) is for the console.
export const CUSTOMER_KINDS = Object.freeze(['connection', 'firmware', 'update', 'restart', 'bluetooth']);
// Of an update's steps, only the first ones: the rest is said by its result and by the firmware event.
const SHOWN_STEPS = new Set(['awaiting_user', 'downloading']);
const FIELDS = Object.freeze(['version', 'from', 'to', 'confirmed', 'result', 'state', 'progress']);

/**
 * One event of the console's event log (lib/events.mjs eventFromItem) as its owner sees it,
 * or null for one they are not shown.
 */
export function customerEvent(event, ref) {
  if (event === null || !CUSTOMER_KINDS.includes(event.kind)) return null;
  if (event.kind === 'update' && event.what === 'step' && !SHOWN_STEPS.has(event.state)) return null;
  const shown = { at: event.at, board: ref, kind: event.kind, what: event.what };
  for (const name of FIELDS) {
    if (Object.hasOwn(event, name)) shown[name] = event[name];
  }
  // The version an update was for is in its job id, which the customer is not given.
  if (event.kind === 'update' && shown.version === undefined && typeof event.job === 'string') {
    const version = parseJobId(event.job)?.version;
    if (version) shown.version = version;
  }
  return shown;
}
