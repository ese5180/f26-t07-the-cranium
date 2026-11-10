// An in-memory stand-in for src/aws-map.mjs: the calls of the map, the commands and the alerts
// (docs/fleet.md), with the same inputs, outputs and failure modes. test/fake-aws.mjs adds it to its
// own stand-in, so that every test console and the preview have it; its items live in that stand-in's
// events table, as the real ones live in the events table.
//
// On top of the adapter methods it plays what the console does not:
//
//   fake.commands                    every command published, { thing, payload, at }
//   fake.onCommand(listener)         a board's side of its commands topic: (thing, payload) => void
//   fake.alertEmails                 every e-mail published to the alert topic, { subject, message, at }
//   fake.confirmSubscription(email)  the person follows the link in SNS's confirmation e-mail
//   fake.setSolver(solve)            what AWS IoT Core Device Location answers: (request) => answer of
//                                    solvePosition, or a function that throws
//   fake.placeAccessPoints(table)    or a solver that knows where access points are: { mac: { lat, lon } }
//   fake.locate(thing, scan)         a board publishes on cranium/<thing>/location, and the rule hands it to
//                                    the real location function (src/locator.mjs): what it decided
//   fake.enableAlerts(consoleUrl)    let the real alerter (src/alerts.mjs) follow what the recorder
//                                    records here, as EventsFn does; off unless asked for
//   fake.checkAlerts()               the scheduled check of the alerts, as the EventBridge rule runs it
//   fake.alertsSettled()             wait for what the alerter was given so far
//   fake.alertStore(), fake.locationStore()   the stand-ins for createAlertStore and createLocationStore
//
// This file is test and preview code. It is never packaged with the function.

import { createHash } from 'node:crypto';

import { createAlerter } from '../src/alerts.mjs';
import { ALERTS_PK } from '../src/lib/alerts.mjs';
import { LOCATION_PK } from '../src/lib/position.mjs';
import { createLocator } from '../src/locator.mjs';

const ACCOUNT = '000000000000';
const TOPIC = `arn:aws:sns:us-east-1:${ACCOUNT}:local-alerts`;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** The error src/aws-map.mjs throws for a failure a handler cannot act on. */
function awsError(operation, awsName, { code = 'failed', status = null } = {}) {
  const error = new Error(`${operation}: ${awsName}`);
  error.name = 'AwsError';
  error.code = code;
  error.operation = operation;
  error.awsError = awsName;
  error.awsStatus = status;
  return error;
}

/** A solver that knows where access points are: the mean of theirs, weighted by signal. */
function solverOf(table) {
  return (request) => {
    const known = (request.WiFiAccessPoints ?? [])
      .map((ap) => ({ ...table[ap.MacAddress.toLowerCase()], weight: 10 ** (ap.Rss / 20) }))
      .filter((ap) => Number.isFinite(ap.lat) && Number.isFinite(ap.lon));
    if (known.length < 2) return { found: false };
    const total = known.reduce((sum, ap) => sum + ap.weight, 0);
    const lat = known.reduce((sum, ap) => sum + ap.lat * ap.weight, 0) / total;
    const lon = known.reduce((sum, ap) => sum + ap.lon * ap.weight, 0) / total;
    const spread = Math.max(...known.map((ap) => Math.hypot((ap.lat - lat) * 111_320, (ap.lon - lon) * 85_000)));
    return {
      found: true,
      geoJson: JSON.stringify({
        coordinates: [lon, lat],
        type: 'Point',
        properties: { horizontalAccuracy: Math.max(12, Math.round(spread * 0.6)), horizontalConfidenceLevel: 0.68 },
      }),
    };
  };
}

/**
 * @param {object} table   the events table of test/fake-aws.mjs
 * @param {() => number} table.clock
 * @param {(item: object) => void} table.put           PutItem
 * @param {(pk: string, sk: string) => object | null} table.get
 * @param {(pk: string, prefix: string) => object[]} table.list   lowest sort key first
 */
export function createFakeMap({ clock, put, get, list, rules = () => null }) {
  const commands = [];
  const listeners = [];
  const alertEmails = [];
  const subscriptions = new Map(); // address in lower case -> { endpoint, arn }
  let subscriptionCount = 0;
  let solve = () => ({ found: false });
  // The alerts are off until enableAlerts(); then each message is handled by an alerter whose clock
  // stands at the moment the message was recorded, whenever its turn comes (a scenario moves the
  // clock on between its awaits).
  let consoleUrl = null;
  let pending = Promise.resolve();
  let draws = 0;

  /** PutItem with the condition aws-map.mjs sends: only over the item with this rev, or over none. */
  function putIf(item, rev) {
    const there = get(item.pk, item.sk);
    const ok = rev === 0 ? there === null : there !== null && there.rev === rev;
    if (!ok) return { ok: false, reason: 'conflict' };
    put(item);
    return { ok: true };
  }

  const alertStore = Object.freeze({
    async getAlertRules() {
      return copy(rules()) ?? null;
    },
    async getAlertItem(sk) {
      return copy(get(ALERTS_PK, sk));
    },
    async listAlertItems() {
      return [...list(ALERTS_PK, 'B#'), ...list(ALERTS_PK, 'D#')].map(copy);
    },
    async putAlertItem(item, rev) {
      return putIf(copy(item), rev);
    },
    async putSentAlert(item) {
      put(copy(item));
    },
    async publishAlert({ subject, message }) {
      if (typeof message !== 'string' || message === '')
        throw awsError('Publish', 'InvalidParameterException', { status: 400 });
      if (typeof subject !== 'string' || subject.length > 100 || /[^\x20-\x7e]/.test(subject)) {
        throw awsError('Publish', 'InvalidParameterException', { status: 400 });
      }
      alertEmails.push({ subject, message, at: clock() });
    },
    async listSentAlerts({ limit }) {
      return list(ALERTS_PK, 'S#').reverse().slice(0, limit).map(copy);
    },
  });

  const locationStore = Object.freeze({
    async getLocation(thing) {
      return copy(get(LOCATION_PK, thing));
    },
    async putLocation(item, rev) {
      return putIf(copy(item), rev);
    },
    async putEvent(item) {
      put(copy(item));
    },
    async solvePosition(request) {
      const answer = await solve(copy(request));
      return copy(answer);
    },
  });

  function alerterAt(at) {
    return consoleUrl === null ? null : createAlerter({ store: alertStore, consoleUrl, now: () => at, log: () => {} });
  }

  function locator() {
    return createLocator({
      store: locationStore,
      alerts: alerterAt(clock()),
      now: clock,
      randomHex: (count) => {
        draws += 1;
        return createHash('sha256')
          .update(`location ${draws}`)
          .digest('hex')
          .slice(0, 2 * count);
      },
      log: () => {},
    });
  }

  /** Run something of the alerter's after whatever it was given before, so that their order holds. */
  function queue(work) {
    pending = pending.then(work, work).catch(() => {});
    return pending;
  }

  const adapter = {
    async publishCommand({ thing, payload }) {
      const sent = { thing, payload: copy(payload), at: clock() };
      commands.push(sent);
      for (const listener of listeners) listener(thing, copy(payload));
    },

    async listLocations() {
      return list(LOCATION_PK, '').map(copy);
    },

    async getLocation(thing) {
      return copy(get(LOCATION_PK, thing));
    },

    async listAlertSubscriptions() {
      return [...subscriptions.values()].map((entry) => ({
        arn: entry.arn,
        endpoint: entry.endpoint,
        protocol: 'email',
      }));
    },

    async subscribeAlerts(email) {
      if (typeof email !== 'string' || !EMAIL.test(email))
        throw awsError('Subscribe', 'InvalidParameterException', { status: 400 });
      const known = subscriptions.get(email.toLowerCase());
      if (known?.arn) return { pending: false };
      subscriptions.set(email.toLowerCase(), { endpoint: email, arn: null });
      return { pending: true };
    },

    async unsubscribeAlerts(arn) {
      for (const [key, entry] of subscriptions) {
        if (entry.arn === arn) {
          subscriptions.delete(key);
          return { ok: true };
        }
      }
      return { ok: false, reason: 'not_found' };
    },

    async listSentAlerts({ limit }) {
      return list(ALERTS_PK, 'S#').reverse().slice(0, limit).map(copy);
    },
  };

  const helpers = {
    commands,
    alertEmails,

    onCommand(listener) {
      listeners.push(listener);
    },

    confirmSubscription(email) {
      const entry = subscriptions.get(String(email).toLowerCase());
      if (entry === undefined) throw new TypeError(`${email} has not subscribed`);
      subscriptionCount += 1;
      entry.arn = `${TOPIC}:${String(subscriptionCount).padStart(8, '0')}-0000-4000-8000-000000000000`;
    },

    setSolver(next) {
      solve = next;
    },

    placeAccessPoints(table) {
      solve = solverOf(Object.fromEntries(Object.entries(table).map(([mac, place]) => [mac.toLowerCase(), place])));
    },

    /** A scan as firmware 1.13.0 publishes it, handed to the location function as the rule would. */
    async locate(thing, { aps, boot = 1, t = 60_000, received = clock(), ...extra }) {
      await pending;
      return locator()({ aps, boot, t, ...extra, thing, received });
    },

    enableAlerts(url = 'https://console.preview.invalid/') {
      consoleUrl = url;
    },

    /** Called by test/fake-aws.mjs for what its recorder made of a message. */
    recorded(message, items) {
      const alerter = alerterAt(clock());
      if (alerter === null) return;
      const events = (items ?? []).filter((item) => typeof item?.sk === 'string' && item.sk.startsWith('E#'));
      queue(() => alerter.afterRecord(copy(message), copy(events)));
    },

    checkAlerts() {
      const alerter = alerterAt(clock());
      if (alerter === null) return Promise.resolve(0);
      let sent = 0;
      return queue(async () => {
        sent = await alerter.check();
      }).then(() => sent);
    },

    alertsSettled() {
      return pending;
    },

    alertStore() {
      return alertStore;
    },

    locationStore() {
      return locationStore;
    },
  };

  return { adapter, helpers };
}
