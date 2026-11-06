/**
 * Live updates (docs/live.md): what the live function makes of the tables' streams, and who is told.
 *
 * A page that is open keeps a WebSocket to the live API. When something it shows changes in a table,
 * the live function sends it one short message, `{ type: "changed", things, what, at }`, and the page
 * reads again what it shows, through the API, as it would on its next refresh. The message carries no
 * data of a board: what a page may read stays the API's to decide, as before.
 *
 * What counts as a change, by table and key (the streams carry the keys only, KEYS_ONLY):
 *
 *   events  pk <thing>, sk "E#..."      an event of that board: it connected, disconnected, restarted,
 *                                        took or finished an update, ...  what "board"
 *           pk "UPD#<thing>"            a fact of its update history       what "updates"
 *           (its samples "S#", the lines of its console "L#" and "K#", and the alerts' and positions'
 *           own parts are not changes: the stream filter keeps them away from the function)
 *   state   pk "OWN", sk <thing>        who owns the board                 what "ownership"
 *           pk "REL"                    a release                          what "releases"
 *           pk "GRP" / "ROL"            groups / staged rollouts           what "groups" / "rollouts"
 *           pk "APP"                    a phone app build                  what "apps"
 *   audit   any new entry               the activity log                   what "activity"
 *
 * Who hears what: the team (the console, and its pages in the apps) hears every change, with the
 * boards' thing names in `things`. A customer hears only of the boards they own now, and only "board",
 * "updates" and "ownership", with each board named as the customer site names it, by the `ref` of its
 * assignment, in `boards`: never a thing name, which the customer site never shows (customer/boards.mjs).
 * And every customer hears that ownership changed somewhere, with no board named, so that a page whose
 * board was taken away reads its list again.
 *
 * No AWS here, and no clock: the caller passes the time.
 */

import { isThing } from './validate.mjs';

export const PROTOCOL = 'cranium-live';
// API Gateway ends a WebSocket after two hours, whatever happens on it.
export const MAX_CONNECTION_S = 2 * 3600;
export const AUDIENCES = Object.freeze(['team', 'customer']);
export const WHAT = Object.freeze([
  'board',
  'updates',
  'ownership',
  'releases',
  'groups',
  'rollouts',
  'apps',
  'activity',
]);
export const CUSTOMER_WHAT = Object.freeze(['board', 'updates', 'ownership']);
// The most board names one message carries. More than that, and the page reads everything anyway.
export const MAX_THINGS = 50;

const STATE_WHAT = Object.freeze({ OWN: 'ownership', REL: 'releases', GRP: 'groups', ROL: 'rollouts', APP: 'apps' });
const UPDATE_PARTITION = 'UPD#';
const EVENT_PREFIX = 'E#';
const CONNECTION_ID = /^[A-Za-z0-9=_+/-]{1,128}$/;
// How the customer site names a board: the ref of its assignment (customer/boards.mjs).
const REF = /^[0-9a-f]{16}$/;

/**
 * The access token a page connected with, from its Sec-WebSocket-Protocol header: the two
 * subprotocols "cranium-live, <token>", in that order. Null for anything else.
 */
export function tokenFromProtocols(value) {
  if (typeof value !== 'string' || value.length > 9000) return null;
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== 2 || parts[0] !== PROTOCOL || parts[1] === '') return null;
  return parts[1];
}

/** A header of an API Gateway WebSocket event, whatever case the client wrote its name in. */
export function headerOf(event, name) {
  const headers = event?.headers;
  if (headers === null || typeof headers !== 'object') return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return null;
}

export function isConnectionId(value) {
  return typeof value === 'string' && CONNECTION_ID.test(value);
}

/** The table a stream record came from, by the name in its eventSourceARN. */
function tableOf(record) {
  const arn = typeof record?.eventSourceARN === 'string' ? record.eventSourceARN : '';
  return /:table\/([A-Za-z0-9_.-]{3,255})\/stream\//.exec(arn)?.[1] ?? null;
}

function keyOf(record, name) {
  const value = record?.dynamodb?.Keys?.[name]?.S;
  return typeof value === 'string' ? value : null;
}

/**
 * What a batch of stream records changed: the boards it names and the kinds of change. Records of
 * other tables, deletions of the events table (they are DynamoDB letting items expire) and keys
 * that are not what the table holds are left out.
 *
 * @param {object[]} records          the Records of a DynamoDB stream event
 * @param {{ events: string, state: string, audit: string }} tables  the tables' names
 * @returns {{ things: string[], what: string[] }}
 */
export function changesOf(records, tables) {
  const things = new Set();
  const what = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    const table = tableOf(record);
    const event = record?.eventName;
    if (!['INSERT', 'MODIFY', 'REMOVE'].includes(event)) continue;
    const pk = keyOf(record, 'pk');
    const sk = keyOf(record, 'sk');
    if (pk === null) continue;
    if (table === tables.events) {
      if (event === 'REMOVE') continue;
      if (isThing(pk) && sk !== null && sk.startsWith(EVENT_PREFIX)) {
        things.add(pk);
        what.add('board');
      } else if (pk.startsWith(UPDATE_PARTITION) && isThing(pk.slice(UPDATE_PARTITION.length))) {
        things.add(pk.slice(UPDATE_PARTITION.length));
        what.add('updates');
      }
    } else if (table === tables.state) {
      if (!Object.hasOwn(STATE_WHAT, pk)) continue;
      what.add(STATE_WHAT[pk]);
      if (pk === 'OWN' && isThing(sk)) things.add(sk);
    } else if (table === tables.audit) {
      if (event === 'INSERT') what.add('activity');
    }
  }
  return { things: [...things].sort(), what: WHAT.filter((kind) => what.has(kind)) };
}

/**
 * The message for one connection, or null when nothing it may hear of changed.
 *
 * @param {{ audience: string, sub: string }} connection
 * @param {{ things: string[], what: string[] }} change  changesOf's
 * @param {Map<string, { owner: string, ref: string }>|null} owners  of each owned board, now, its owner
 *        (a customer's sub) and the ref of its assignment; needed for a customer's connection only
 * @param {number} atMs
 */
export function messageFor(connection, change, owners, atMs) {
  const at = new Date(atMs).toISOString();
  if (change.what.length === 0) return null;
  if (connection.audience === 'team') {
    return { type: 'changed', things: change.things.slice(0, MAX_THINGS), what: change.what, at };
  }
  if (connection.audience !== 'customer') return null;
  const own = change.things
    .map((thing) => owners?.get(thing))
    .filter((owned) => owned?.owner === connection.sub && REF.test(owned.ref ?? ''))
    .map((owned) => owned.ref);
  const what = change.what.filter((kind) => CUSTOMER_WHAT.includes(kind));
  // A board of theirs changed, or ownership did somewhere: a board may have been taken from them.
  if (own.length === 0 && !what.includes('ownership')) return null;
  const heard = own.length === 0 ? ['ownership'] : what;
  return { type: 'changed', boards: own.slice(0, MAX_THINGS), what: heard, at };
}

/** How long a connection may stay, in epoch seconds: until its token expires, two hours at most. */
export function connectionUntil(expiresAt, nowS) {
  return Math.min(expiresAt, nowS + MAX_CONNECTION_S);
}
