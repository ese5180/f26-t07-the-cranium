/**
 * The e-mails a customer can ask for about their own boards (docs/customer-site.md, "Notifications"),
 * and what decides which go to whom. They are off by default, chosen per customer on the site's
 * Account page (customer/app.mjs, /api/c/preferences), and kept in the state table (pk PRF).
 *
 *   offline             a board of theirs lost its connection to Cranium
 *   updated             a board of theirs runs new firmware that an update installed
 *   unexpectedRestart   a board of theirs restarted unexpectedly (customer/health.mjs restartCategory)
 *
 * SENDING IS OFF. Nothing here is wired to a sender in the deployed stack: CUSTOMER_EMAILS_ENABLED is
 * false, and createCustomerMailer then sends nothing and says so. The console's alerts go through an
 * SNS topic that only the team subscribes to, which cannot address one customer without putting their
 * address in a subscription, and the stack has no SES identity. What turning it on needs is in
 * docs/customer-site.md, "Notifications".
 *
 * An e-mail names a board by the customer's own name for it, else the admin's, else "your board": never
 * a thing name. A customer's address is asked of Cognito when an e-mail goes, used for the sending only,
 * and is in no log line, no URL and no stored item here.
 */

import { restartCategory } from './health.mjs';

export const CUSTOMER_EMAILS_ENABLED = false;
export const NOTIFICATION_KINDS = Object.freeze(['offline', 'updated', 'unexpectedRestart']);

/** A customer's choices, each off unless it was turned on. */
export function preferencesOf(stored) {
  return {
    offline: stored?.offline === true,
    updated: stored?.updated === true,
    unexpectedRestart: stored?.unexpectedRestart === true,
  };
}

/** Which notification an event of the console's event log (lib/events.mjs) is, or null. */
export function notificationOf(event) {
  if (event === null || typeof event !== 'object') return null;
  if (event.kind === 'connection' && event.what === 'disconnected') return 'offline';
  if (event.kind === 'firmware' && event.what === 'changed') return 'updated';
  if (restartCategory(event)?.unexpected === true) return 'unexpectedRestart';
  return null;
}

const SHOWN_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,5}/;

function boardNameOf(ownership) {
  return ownership.customerLabel || ownership.label || 'your board';
}

/** The subject and text of one e-mail, in the site's plain words. */
export function emailWords(kind, ownership, event) {
  const name = boardNameOf(ownership);
  const version = typeof event?.to === 'string' ? (SHOWN_VERSION.exec(event.to)?.[0] ?? null) : null;
  switch (kind) {
    case 'offline':
      return {
        subject: `${name} is offline`,
        text: `Cranium lost touch with ${name}. It reports again once it is on and on Wi-Fi.`,
      };
    case 'updated':
      return {
        subject: `${name} was updated`,
        text: version ? `${name} now runs firmware ${version}.` : `${name} installed an update.`,
      };
    case 'unexpectedRestart':
      return {
        subject: `${name} restarted unexpectedly`,
        text: `${name} restarted itself to recover from a problem. It is running again.`,
      };
    default:
      return null;
  }
}

/**
 * The e-mails some events call for: one per event whose board has an owner who asked for its kind.
 *
 * @param {object} options
 * @param {object[]} options.events       [{ thing, event }]: events as eventFromItem reads them, with their board
 * @param {object[]} options.ownership    listOwnership(): who owns which board
 * @param {(sub: string) => Promise<object|null>} options.preferencesOf  getPreferences
 * @returns {Promise<{ sub, ref, kind, subject, text }[]>}
 */
export async function planCustomerEmails({ events, ownership, preferencesOf: read }) {
  const owners = new Map(ownership.filter((item) => item.owner).map((item) => [item.thing, item]));
  const chosen = new Map();
  const plans = [];
  for (const { thing, event } of events) {
    const kind = notificationOf(event);
    const owned = owners.get(thing);
    if (kind === null || owned === undefined) continue;
    if (!chosen.has(owned.owner)) chosen.set(owned.owner, preferencesOf(await read(owned.owner)));
    if (!chosen.get(owned.owner)[kind]) continue;
    plans.push({ sub: owned.owner, ref: owned.ref, kind, ...emailWords(kind, owned, event) });
  }
  return plans;
}

/**
 * What sends the planned e-mails, once sending is turned on.
 *
 * @param {object} options
 * @param {boolean} [options.enabled]                       CUSTOMER_EMAILS_ENABLED unless a test says otherwise
 * @param {(sub: string) => Promise<object|null>} options.getCustomer  the customer pool (customer/aws.mjs)
 * @param {(mail: { to, subject, text }) => Promise<void>} [options.send]  the sender; none in the stack yet
 * @param {(line: object) => void} [options.log]
 */
export function createCustomerMailer({
  enabled = CUSTOMER_EMAILS_ENABLED,
  getCustomer,
  send = null,
  log = (line) => console.log(JSON.stringify(line)),
}) {
  return {
    enabled: enabled === true && typeof send === 'function',
    /** Send each planned e-mail to an account that is on. Never throws; logs counts and kinds, never an address. */
    async deliver(plans) {
      if (!(enabled === true && typeof send === 'function')) {
        if (plans.length > 0) log({ event: 'customer_emails_off', planned: plans.length });
        return { sent: 0, skipped: plans.length };
      }
      let sent = 0;
      let skipped = 0;
      for (const plan of plans) {
        try {
          const customer = await getCustomer(plan.sub);
          if (customer === null || customer.enabled !== true || customer.status !== 'CONFIRMED' || !customer.email) {
            skipped += 1;
            continue;
          }
          await send({ to: customer.email, subject: plan.subject, text: plan.text });
          sent += 1;
          log({ event: 'customer_email_sent', sub: plan.sub, board: plan.ref, kind: plan.kind });
        } catch (error) {
          skipped += 1;
          log({
            level: 'warn',
            event: 'customer_email_failed',
            sub: plan.sub,
            kind: plan.kind,
            // The name only: a sender's message can quote the address it was given.
            error: { name: typeof error?.name === 'string' ? error.name.slice(0, 64) : 'Error' },
          });
        }
      }
      return { sent, skipped };
    },
  };
}
