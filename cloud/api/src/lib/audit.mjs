/**
 * The activity log.
 *
 * Every request that tries to change something leaves exactly one entry, whatever
 * happened to it: who asked (the token's sub, with the e-mail address as it was at
 * that moment), what they asked for, and how it ended.
 *
 * What protects an entry, and how far. The function's role may put and query items in
 * the table, and is refused anything that deletes or updates: IAM enforces that. Putting
 * an item with the key of an existing one would replace it, and IAM cannot require the
 * condition that prevents this: aws.mjs sends it on every put, so the code enforces that.
 * To notice it if code in this role, or an administrator, ever rewrote an entry, the
 * function also logs a digest of each entry when it is stored. The role cannot change or
 * delete a log line. cloud/api/verify-audit.mjs compares the two, for as long as the log
 * group keeps its lines (90 days). The role could still add false lines and false
 * entries: this detects changes to what was recorded, not lies told by the function.
 *
 * Item: pk = "AUD", sk = "<ISO time>#<request id>". Newest first is descending sk.
 * A page cursor is the last sk of the page, base64url encoded.
 *
 * A sign-in (account.sign_in) is the one entry that no request asked for. Its key is made from
 * the sign-in itself, so that every instance of the function that sees it makes the same one:
 * the time is the token's auth_time, and the "request id" is signin.<sub>.<client>.<auth_time>,
 * where client is web or phone. It is put with the same condition as every entry, so the first
 * instance stores it and the others are refused.
 */

import { createHash } from 'node:crypto';

export const ACTIONS = Object.freeze([
  'firmware.upload', 'firmware.revoke', 'deployment.create', 'deployment.cancel',
  // A phone app's calls for an update over Bluetooth (docs/mobile-apps.md): the image, the
  // board's passkey, and the check right before every send, which goes on record even when
  // the image came from the phone and needed no download.
  'firmware.download', 'pairing.read', 'firmware.bluetooth_send',
  // A person's own API tokens, made and ended on the website (handlers/tokens.mjs).
  'token.create', 'token.revoke',
  // A sign-in with password and code, on the website or in a phone app, recorded once, by the
  // first request of it that the API sees (app.mjs). Its request id is made up, not a request's.
  'account.sign_in',
  // A command that changed a board at its serial console, posted by the page that sent it over
  // USB (handlers/serial.mjs): the command's name only, never what was typed after it.
  'serial.command',
  // A command sent to a board (handlers/commands.mjs), and a release manager's own e-mail alerts
  // (handlers/alerts.mjs): docs/fleet.md.
  'board.command', 'alert.subscribe', 'alert.unsubscribe',
  // The fleet (docs/fleet.md): groups of boards, staged rollouts and the two that start several at
  // once, what a phone saw of a board (handlers/groups.mjs, rollouts.mjs, fleet.mjs), and a
  // release's note changed after its upload (handlers/firmware.mjs). rollout.advance and
  // rollout.stop are the console's own, made by the schedule that moves rollouts on (tick.mjs).
  'group.create', 'group.update', 'group.delete', 'rollout.create', 'rollout.cancel', 'rollout.advance', 'rollout.stop',
  'fleet.update_everything', 'group.rollback', 'device.seen', 'firmware.notes',
  // The phone apps (handlers/apps.mjs): the URL an APK is sent to S3 with, the release published once
  // what arrived is checked, and each download link handed out, for a person or a QR code.
  'app.upload', 'app.publish', 'app.download',
  // The customer site's accounts and their boards, from the console's Customers page
  // (handlers/customers.mjs). A customer's own reads are not recorded.
  'customer.create', 'customer.resend', 'customer.assign', 'customer.unassign', 'customer.disable', 'customer.enable',
]);
export const OUTCOMES = Object.freeze(['ok', 'rejected', 'denied', 'error']);

export const REQUEST_ID = /^[A-Za-z0-9+/=_.:-]{1,128}$/;
const SORT_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#[A-Za-z0-9+/=_.:-]{1,128}$/;
const DETAIL_KEY = /^[a-z][A-Za-z0-9_]{0,23}$/;
const UNSAFE = /[\p{C}\p{Zl}\p{Zp}]/gu;

const MAX_DETAILS = 8;
const MAX_VALUE = 200;
const MAX_CURSOR = 400;

/** One line of text, at most `max` characters, whatever was passed in. */
function line(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(UNSAFE, '').slice(0, max);
}

function cleanDetail(detail) {
  const clean = {};
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return clean;
  for (const [key, value] of Object.entries(detail)) {
    if (Object.keys(clean).length === MAX_DETAILS) break;
    if (!DETAIL_KEY.test(key)) continue;
    if (typeof value === 'string') clean[key] = line(value, MAX_VALUE);
    else if (typeof value === 'number' || typeof value === 'boolean') clean[key] = String(value);
  }
  return clean;
}

/** The request id of the entry for one sign-in, or null if the parts cannot make one. */
export function signInRequestId({ sub, client, authTime }) {
  const id = `signin.${sub}.${client}.${authTime}`;
  return Number.isSafeInteger(authTime) && authTime > 0 && REQUEST_ID.test(id) ? id : null;
}

/**
 * Build the item to store for one request.
 *
 * @param {object} entry
 * @param {number} entry.at           epoch milliseconds
 * @param {string} entry.requestId
 * @param {{sub: string, email: string}} entry.actor
 * @param {string} entry.action       one of ACTIONS
 * @param {string} entry.target       version, deployment id, file name or token id
 * @param {string} entry.outcome      one of OUTCOMES
 * @param {object} entry.detail       short keys with short values
 */
export function auditItem({ at, requestId, actor, action, target, outcome, detail }) {
  if (!ACTIONS.includes(action)) throw new TypeError(`Unknown audit action ${String(action)}`);
  if (!OUTCOMES.includes(outcome)) throw new TypeError(`Unknown audit outcome ${String(outcome)}`);
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new TypeError('Unusable request id');
  const time = new Date(at).toISOString();
  return {
    sk: `${time}#${requestId}`,
    at: time,
    requestId,
    actor: { sub: line(actor?.sub, 128), email: line(actor?.email, 320) },
    action,
    target: line(target, 128),
    outcome,
    detail: cleanDetail(detail),
  };
}

/** The value with the keys of every object in sorted order, so that JSON text is canonical. */
function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys(value[key])]));
}

/**
 * The SHA-256 of an entry as stored, in hex. The partition key is left out: every entry
 * has the same one, and the item auditItem builds does not carry it yet. Attribute order
 * does not matter, because DynamoDB does not keep it.
 */
export function auditDigest(item) {
  const { pk: _partition, ...entry } = item;
  return createHash('sha256').update(JSON.stringify(sortedKeys(entry)), 'utf8').digest('hex');
}

/** Turn a stored item into an AuditEntry, or null if it is not one. */
export function entryFromItem(item) {
  if (item === null || typeof item !== 'object') return null;
  if (typeof item.sk !== 'string' || !SORT_KEY.test(item.sk)) return null;
  if (!ACTIONS.includes(item.action) || !OUTCOMES.includes(item.outcome)) return null;
  const separator = item.sk.indexOf('#');
  return {
    at: item.sk.slice(0, separator),
    actor: { sub: line(item.actor?.sub, 128), email: line(item.actor?.email, 320) },
    action: item.action,
    target: line(item.target, 128),
    outcome: item.outcome,
    detail: cleanDetail(item.detail),
    requestId: item.sk.slice(separator + 1),
  };
}

export function encodeCursor(sortKey) {
  return Buffer.from(sortKey, 'utf8').toString('base64url');
}

/** The sort key inside a cursor, or null if the text is not a cursor this API made. */
export function decodeCursor(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_CURSOR) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) return null;
  const sortKey = bytes.toString('utf8');
  return SORT_KEY.test(sortKey) ? sortKey : null;
}
