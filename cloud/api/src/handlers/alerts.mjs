/**
 * Alerts by e-mail, on the Account page (docs/fleet.md, "Alerts"; lib/alerts.mjs says which).
 *
 *   GET  /api/alerts               -> { email, subscription, canSubscribe, subscribers, recent, rules,
 *                                       alertRules, ruleLimits }
 *        subscription: none | pending (SNS waits for the person to confirm) | confirmed, for the
 *        caller's own address; subscribers: how many addresses get the alerts, never which;
 *        recent: the newest e-mails that went out, at most 20: { at, kind, thing | deployment, subject, count }
 *   POST /api/alerts/subscribe     -> 202 { subscription }   SNS sends the confirmation to the address
 *   POST /api/alerts/unsubscribe   -> 200 { subscription: "none" }
 *   POST /api/alerts/rules         body { rules: { <rule>: { on?, <threshold>? } } }
 *                                  -> 200 { alertRules }                                   alert.rules
 *
 * The alert rules (console 2.13.0, lib/alerts.mjs RULES): which alerts go out, for everybody who gets
 * them, and at what thresholds. alertRules: { offline: { on, minutes }, issue: { on }, crashLoop: { on,
 * reboots, minutes }, rollout: { on }, voltage: { on, mv } }; ruleLimits: each threshold's [low, high].
 * Every member reads them; a release manager changes them, a rule or a field at a time, and each
 * change is on record as alert.rules with what it changed. The item is written only if nobody changed
 * it meanwhile (409 rules_changed). `rules` is what it was before 2.13.0: the offline minutes, the
 * hour between e-mails and the distance of a move.
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
import { change } from '../lib/audit.mjs';
import {
  ALERT_EVERY_MS,
  ALERT_RULES_PK,
  ALERT_RULES_SK,
  RULES,
  RULE_IDS,
  normalizeRules,
  sentFromItem,
} from '../lib/alerts.mjs';
import { MOVED_METRES } from '../lib/position.mjs';

export const SUBSCRIBES_PER_HOUR = 3;
const RECENT_ALERTS = 20;
const HOUR_MS = 3_600_000;

/** An e-mail address as SNS and Cognito may each spell it: the same whatever the case. */
function same(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a !== '' && a.toLowerCase() === b.toLowerCase();
}

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function badRules(message) {
  return badRequest('invalid_rules', message);
}

/** The changes a request asks for, each checked: { <rule>: { on?, <threshold>? } }. */
function requireRuleChanges(body) {
  const keys = Object.keys(body);
  if (keys.some((key) => key !== 'rules') || !isPlain(body.rules) || Object.keys(body.rules).length === 0) {
    throw badRules('This takes { rules: { <rule>: { on, ... } } }, with at least one rule.');
  }
  const changes = {};
  for (const [id, given] of Object.entries(body.rules)) {
    if (!RULE_IDS.includes(id)) throw badRules(`There is no alert rule "${id}". The rules: ${RULE_IDS.join(', ')}.`);
    if (!isPlain(given) || Object.keys(given).length === 0) throw badRules(`Rule "${id}" names nothing to change.`);
    const fields = RULES[id].fields;
    const change = {};
    for (const [name, value] of Object.entries(given)) {
      if (name === 'on') {
        if (typeof value !== 'boolean') throw badRules(`"${id}.on" is true or false.`);
        change.on = value;
      } else if (Object.hasOwn(fields, name)) {
        const [low, high] = fields[name];
        if (!Number.isInteger(value) || value < low || value > high) {
          throw badRules(`"${id}.${name}" is a whole number from ${low} to ${high}.`);
        }
        change[name] = value;
      } else {
        throw badRules(`Rule "${id}" has no "${name}".`);
      }
    }
    changes[id] = change;
  }
  return changes;
}

/** "offline on, minutes 20; voltage off": what a change did, for the activity log. */
function changeWords(changes) {
  return Object.entries(changes)
    .map(([id, change]) =>
      [
        id,
        ...Object.entries(change).map(([name, value]) => (name === 'on' ? (value ? 'on' : 'off') : `${name} ${value}`)),
      ].join(' ')
    )
    .join('; ')
    .slice(0, 200);
}

function noBody(json) {
  const body = json();
  if (Object.keys(body).length > 0)
    throw badRequest('unexpected_field', 'This takes no fields: the address is your own.');
}

export function createAlertHandlers({ aws, now, directory }) {
  const readRuleItem = () => aws.getFleetItem({ pk: ALERT_RULES_PK, sk: ALERT_RULES_SK });

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
    return items.filter(
      (item) => item?.action === 'alert.subscribe' && item?.outcome === 'ok' && item?.actor?.sub === sub
    ).length;
  }

  return {
    async get({ caller }) {
      const email = await directory.emailOf(caller.sub);
      const [mine, sent, ruleItem] = await Promise.all([
        subscriptionsOf(email),
        aws.listSentAlerts({ limit: RECENT_ALERTS }),
        readRuleItem(),
      ]);
      const alertRules = normalizeRules(ruleItem);
      return {
        body: {
          email,
          subscription: email === '' ? 'none' : mine.state,
          canSubscribe: caller.groups.includes(RELEASE_MANAGERS) && email !== '',
          subscribers: mine.subscribers,
          recent: sent.map(sentFromItem).filter((item) => item !== null),
          rules: {
            offlineMinutes: alertRules.offline.minutes,
            everyMinutes: ALERT_EVERY_MS / 60_000,
            movedMetres: MOVED_METRES,
          },
          alertRules,
          ruleLimits: Object.fromEntries(
            RULE_IDS.map((id) => [
              id,
              Object.fromEntries(Object.entries(RULES[id].fields).map(([name, [low, high]]) => [name, [low, high]])),
            ])
          ),
          canChangeRules: caller.groups.includes(RELEASE_MANAGERS),
        },
      };
    },

    async setRules({ actor, json, entry }) {
      entry.target = 'rules';
      const changes = requireRuleChanges(json());
      entry.detail.changes = changeWords(changes);
      const item = await readRuleItem();
      const current = normalizeRules(item);
      const next = Object.fromEntries(RULE_IDS.map((id) => [id, { ...current[id], ...(changes[id] ?? {}) }]));
      const at = new Date(now()).toISOString();
      const by = { sub: actor.sub, email: actor.email };
      const written =
        item === null
          ? await aws.putFleetItem({
              pk: ALERT_RULES_PK,
              sk: ALERT_RULES_SK,
              item: { rules: next, updatedAt: at, updatedBy: by, rev: 1 },
            })
          : await aws.updateFleetItem({
              pk: ALERT_RULES_PK,
              sk: ALERT_RULES_SK,
              rev: Number.isSafeInteger(item.rev) ? item.rev : 0,
              set: { rules: next, updatedAt: at, updatedBy: by },
            });
      if (!written.ok)
        throw conflict('rules_changed', 'Someone changed the alert rules at the same moment. Look again.');
      // Each setting of each rule, before and after (docs/audit-diff.md): "offline_minutes", "crashLoop_on".
      for (const id of RULE_IDS) {
        for (const name of Object.keys(next[id])) change(entry, `${id}_${name}`, current[id][name], next[id][name]);
      }
      return { body: { alertRules: normalizeRules({ rules: next }) } };
    },

    async subscribe({ actor, json, entry }) {
      noBody(json);
      const { email } = actor;
      if (email === '') throw conflict('no_email', 'Your account has no e-mail address to send alerts to.');
      entry.target = email;
      const mine = await subscriptionsOf(email);
      if (mine.state === 'confirmed') throw conflict('already_subscribed', 'Alerts already go to your address.');
      if ((await recentSubscribes(actor.sub)) >= SUBSCRIBES_PER_HOUR) {
        throw new HttpError(
          429,
          'rate_limited',
          `Each request sends an e-mail, so at most ${SUBSCRIBES_PER_HOUR} are ` +
            'taken an hour. Look for the e-mail from AWS Notifications, also among unwanted mail.'
        );
      }
      const made = await aws.subscribeAlerts(email);
      const subscription = made.pending ? 'pending' : 'confirmed';
      entry.detail.subscription = subscription;
      change(entry, 'alerts', mine.state, subscription);
      return { status: 202, body: { subscription } };
    },

    async unsubscribe({ actor, json, entry }) {
      noBody(json);
      const { email } = actor;
      entry.target = email;
      const mine = await subscriptionsOf(email);
      if (mine.state === 'pending') {
        throw conflict(
          'not_confirmed',
          'Your subscription waits for you to confirm it, so nothing is sent yet. ' +
            'If you leave the e-mail from AWS Notifications alone, its link lapses after two days and nothing ever is.'
        );
      }
      if (mine.confirmed === null) throw notFound('not_subscribed', 'Alerts do not go to your address.');
      const removed = await aws.unsubscribeAlerts(mine.confirmed.arn);
      if (!removed.ok) throw notFound('not_subscribed', 'Alerts do not go to your address.');
      change(entry, 'alerts', mine.state, 'none');
      return { body: { subscription: 'none' } };
    },
  };
}
