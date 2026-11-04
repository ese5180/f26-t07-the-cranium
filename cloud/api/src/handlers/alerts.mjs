/**
 * Alerts by e-mail, on the Account page (docs/fleet.md, "Alerts"; lib/alerts.mjs says which).
 *
 *   GET  /api/alerts               -> { email, subscription, canSubscribe, subscribers, recent, rules }
 *        subscription: none | pending (SNS waits for the person to confirm) | confirmed, for the
 *        caller's own address; subscribers: how many addresses get the alerts, never which;
 *        recent: the newest e-mails that went out, at most 20: { at, kind, thing | deployment, subject, count }
 *   POST /api/alerts/subscribe     -> 202 { subscription }   SNS sends the confirmation to the address
 *   POST /api/alerts/unsubscribe   -> 200 { subscription: "none" }
 *
 * A release manager subscribes their own address and nobody else's: the one Cognito has for the
 * account, asked of Cognito by the live check of the request (app.mjs step 5). Each is on record as
 * alert.subscribe or alert.unsubscribe. A subscription waiting for its confirmation cannot be removed
 * here, because SNS gives it no ARN until it is confirmed; its link works for two days, and nothing is
 * ever sent to an address that did not confirm. At most 3 requests to subscribe per person an hour,
 * since each one sends an e-mail.
 */

import { RELEASE_MANAGERS } from '../auth.mjs';
import { HttpError, badRequest, conflict, notFound } from '../http.mjs';
import { ALERT_EVERY_MS, OFFLINE_AFTER_MS, sentFromItem } from '../lib/alerts.mjs';
import { MOVED_METRES } from '../lib/position.mjs';

export const SUBSCRIBES_PER_HOUR = 3;
const RECENT_ALERTS = 20;
const HOUR_MS = 3_600_000;

/** An e-mail address as SNS and Cognito may each spell it: the same whatever the case. */
function same(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a !== '' && a.toLowerCase() === b.toLowerCase();
}

function noBody(json) {
  const body = json();
  if (Object.keys(body).length > 0) throw badRequest('unexpected_field', 'This takes no fields: the address is your own.');
}

export function createAlertHandlers({ aws, now, directory }) {
  async function subscriptionsOf(email) {
    const all = await aws.listAlertSubscriptions();
    const mine = all.filter((entry) => entry.protocol === 'email' && same(entry.endpoint, email));
    const confirmed = mine.find((entry) => entry.arn !== null) ?? null;
    return {
      state: confirmed !== null ? 'confirmed' : mine.length > 0 ? 'pending' : 'none',
      confirmed,
      subscribers: all.filter((entry) => entry.protocol === 'email' && entry.arn !== null).length,
    };
  }

  async function recentSubscribes(sub) {
    const after = new Date(now() - HOUR_MS).toISOString();
    const items = await aws.queryAudit({ before: null, after, limit: 1000 });
    return items.filter((item) => item?.action === 'alert.subscribe' && item?.outcome === 'ok' && item?.actor?.sub === sub).length;
  }

  return {
    async get({ caller }) {
      const email = await directory.emailOf(caller.sub);
      const [mine, sent] = await Promise.all([subscriptionsOf(email), aws.listSentAlerts({ limit: RECENT_ALERTS })]);
      return {
        body: {
          email,
          subscription: email === '' ? 'none' : mine.state,
          canSubscribe: caller.groups.includes(RELEASE_MANAGERS) && email !== '',
          subscribers: mine.subscribers,
          recent: sent.map(sentFromItem).filter((item) => item !== null),
          rules: { offlineMinutes: OFFLINE_AFTER_MS / 60_000, everyMinutes: ALERT_EVERY_MS / 60_000, movedMetres: MOVED_METRES },
        },
      };
    },

    async subscribe({ actor, json, entry }) {
      noBody(json);
      const { email } = actor;
      if (email === '') throw conflict('no_email', 'Your account has no e-mail address to send alerts to.');
      entry.target = email;
      const mine = await subscriptionsOf(email);
      if (mine.state === 'confirmed') throw conflict('already_subscribed', 'Alerts already go to your address.');
      if (await recentSubscribes(actor.sub) >= SUBSCRIBES_PER_HOUR) {
        throw new HttpError(429, 'rate_limited', `Each request sends an e-mail, so at most ${SUBSCRIBES_PER_HOUR} are ` +
          'taken an hour. Look for the e-mail from AWS Notifications, also among unwanted mail.');
      }
      const made = await aws.subscribeAlerts(email);
      const subscription = made.pending ? 'pending' : 'confirmed';
      entry.detail.subscription = subscription;
      return { status: 202, body: { subscription } };
    },

    async unsubscribe({ actor, json, entry }) {
      noBody(json);
      const { email } = actor;
      entry.target = email;
      const mine = await subscriptionsOf(email);
      if (mine.state === 'pending') {
        throw conflict('not_confirmed', 'Your subscription waits for you to confirm it, so nothing is sent yet. ' +
          'If you leave the e-mail from AWS Notifications alone, its link lapses after two days and nothing ever is.');
      }
      if (mine.confirmed === null) throw notFound('not_subscribed', 'Alerts do not go to your address.');
      const removed = await aws.unsubscribeAlerts(mine.confirmed.arn);
      if (!removed.ok) throw notFound('not_subscribed', 'Alerts do not go to your address.');
      return { body: { subscription: 'none' } };
    },
  };
}
