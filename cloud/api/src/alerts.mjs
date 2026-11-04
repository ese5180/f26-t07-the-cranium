/**
 * The alerter: what reads and writes the state of the alerts and sends the e-mails (lib/alerts.mjs
 * says which alerts there are, how often they go and what they say).
 *
 * The recorder (recorder.mjs) hands it every presence message, the name each shadow document gives,
 * and the events it stored; the location function (locator.mjs) hands it a move; and an EventBridge
 * rule runs the recorder every 5 minutes for the check, which raises "offline" for a board that has
 * been disconnected for 15 minutes and sends what was folded once its hour is up.
 *
 * Every change to an item is conditional on the item as it was read (its `rev`), and is read and
 * worked out again when somebody else changed it first, so that two invocations at once never both
 * send the same e-mail. An item is written before its e-mail is sent: if the e-mail then cannot be
 * sent, its lines are put back, to go with the next e-mail or the next check. Nothing here ever
 * throws to its caller: an alert that cannot be handled is logged, and the event that made it is on
 * record all the same.
 *
 * Like app.mjs, nothing here imports the AWS SDK: the store is passed in (aws-map.mjs createAlertStore).
 */

import { describeError } from './http.mjs';
import {
  ALERTS_PK, alertOfEvent, applyPresence, boardKey, deploymentKey, dueOffline, emailOf, emptyBoard, emptyDeployment,
  flushDue, presenceOf, putBack, sentItem, takeAlert,
} from './lib/alerts.mjs';
import { readReported } from './lib/shadow.mjs';
import { isThing } from './lib/validate.mjs';

const ATTEMPTS = 3;
const NAMES_KEPT = 512;

/**
 * @param {object} options
 * @param {{ getAlertItem: (sk: string) => Promise<object|null>,
 *           listAlertItems: () => Promise<object[]>,
 *           putAlertItem: (item: object, rev: number) => Promise<{ ok: boolean }>,
 *           putSentAlert: (item: object) => Promise<void>,
 *           publishAlert: (mail: { subject: string, message: string }) => Promise<void> }} options.store
 * @param {string} options.consoleUrl   the console's address, for the links in the e-mails
 * @param {() => number|Date} [options.now]
 * @param {(line: object) => void} [options.log]
 */
export function createAlerter({ store, consoleUrl, now = Date.now, log = (line) => console.log(JSON.stringify(line)) }) {
  if (store === undefined || store === null) throw new TypeError('createAlerter needs a store');
  const clock = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : value;
  };
  // The names this instance knows the item of each board to hold, so that a shadow document costs a
  // read only the first time a board is heard of.
  const names = new Map();

  /**
   * Change one item: read it, work out the change, write it if nobody else wrote first. `change` gets
   * the item (or a new one) and returns { state, mails } or null for nothing to do. Returns the mails
   * with the item they belong to, to be sent.
   */
  async function update(sk, fresh, change) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const current = (await store.getAlertItem(sk)) ?? fresh();
      const result = change(current);
      if (result === null) return [];
      const rev = Number.isSafeInteger(current.rev) ? current.rev : 0;
      const next = { ...result.state, pk: ALERTS_PK, sk, rev: rev + 1 };
      if ((await store.putAlertItem(next, rev)).ok) return result.mails.map((mail) => ({ item: next, mail }));
    }
    log({ level: 'warn', event: 'alert_conflict', key: sk });
    return [];
  }

  function freshOf(key) {
    return key.startsWith('D#') ? () => emptyDeployment(key.slice(2)) : () => emptyBoard(key.slice(2));
  }

  /** Send what update() decided, and put back what could not be sent. */
  async function send(mails) {
    let sent = 0;
    for (const { item, mail } of mails) {
      const email = emailOf(item, mail, consoleUrl);
      try {
        await store.publishAlert(email);
      } catch (error) {
        log({ level: 'error', event: 'alert_unsent', key: item.sk, kind: mail.kind, error: describeError(error) });
        await update(item.sk, freshOf(item.sk), (current) => ({ state: putBack(current, mail), mails: [] }));
        continue;
      }
      sent += 1;
      log({ event: 'alert_sent', key: item.sk, kind: mail.kind, lines: mail.lines.length + mail.more });
      try {
        await store.putSentAlert(sentItem(item, mail, email.subject, clock()));
      } catch (error) {
        log({ level: 'warn', event: 'alert_unlisted', key: item.sk, error: describeError(error) });
      }
    }
    return sent;
  }

  /** Run a piece of work for an alert; a failure is logged and never passed on. */
  async function safely(what, work) {
    try {
      return await work();
    } catch (error) {
      log({ level: 'error', event: 'alert_failed', what, error: describeError(error) });
      return 0;
    }
  }

  /** Raise one alert: { kind, thing, deployment?, text, at }. Returns how many e-mails went out. */
  function raise(alert) {
    return safely(alert.kind, async () => {
      const sk = alert.kind === 'deployment' ? deploymentKey(alert.deployment) : boardKey(alert.thing);
      const mails = await update(sk, freshOf(sk), (current) => {
        const { state, mail } = takeAlert(current, alert, clock());
        return { state, mails: mail === null ? [] : [mail] };
      });
      return send(mails);
    });
  }

  /** A presence message: kept if it is newer, and "online" if the board is back after an "offline" alert. */
  function presence(message) {
    return safely('presence', async () => {
      const said = presenceOf(message, clock());
      if (said === null) return 0;
      const mails = await update(boardKey(said.thing), () => emptyBoard(said.thing), (current) => {
        const applied = applyPresence(current, said);
        if (applied === null) return null;
        if (applied.alert === null) return { state: applied.state, mails: [] };
        const { state, mail } = takeAlert(applied.state, applied.alert, clock());
        return { state, mails: mail === null ? [] : [mail] };
      });
      return send(mails);
    });
  }

  /** The name a board gave in a shadow document, kept for the e-mails when it is new. */
  function noteName(thing, name) {
    if (!isThing(thing) || typeof name !== 'string' || names.get(thing) === name) return Promise.resolve(0);
    return safely('name', async () => {
      await update(boardKey(thing), () => emptyBoard(thing), (current) =>
        (current.name === name ? null : { state: { ...current, name }, mails: [] }));
      if (names.size >= NAMES_KEPT) names.clear();
      names.set(thing, name);
      return 0;
    });
  }

  /**
   * What the recorder made of one message: its presence, its name, and the alerts of its events.
   * `message` is as the rule handed it over; `items` what the recorder stored.
   */
  async function afterRecord(message, items) {
    let sent = 0;
    if (message?.eventType !== undefined) sent += await presence(message);
    const current = message?.current?.state?.reported;
    if (current !== undefined && isThing(message.thing)) {
      const { name } = readReported(current);
      if (name !== null) await noteName(message.thing, name);
    }
    for (const item of items) {
      const alert = alertOfEvent(item);
      if (alert !== null) sent += await raise(alert);
    }
    return sent;
  }

  /** The scheduled check: "offline" where it is due, and what was folded once its hour is up. */
  function check() {
    return safely('check', async () => {
      const items = (await store.listAlertItems()).filter((item) =>
        typeof item?.sk === 'string' && (item.sk.startsWith('B#') || item.sk.startsWith('D#')));
      let sent = 0;
      for (const listed of items) {
        const nowMs = clock();
        const offline = listed.sk.startsWith('B#') ? dueOffline(listed, nowMs) : null;
        const due = flushDue(listed, nowMs);
        if (offline === null && due === null) continue;
        const mails = await update(listed.sk, freshOf(listed.sk), (current) => {
          const at = clock();
          const raised = current.sk.startsWith('B#') ? dueOffline(current, at) : null;
          let state = raised === null ? current : raised.state;
          const found = [];
          if (raised !== null) {
            const taken = takeAlert(state, raised.alert, at);
            state = taken.state;
            if (taken.mail !== null) found.push(taken.mail);
          }
          const flushed = flushDue(state, at);
          if (flushed !== null) {
            state = flushed.state;
            found.push(...flushed.mails);
          }
          return raised === null && flushed === null ? null : { state, mails: found };
        });
        sent += await send(mails);
      }
      return sent;
    });
  }

  return Object.freeze({ raise, presence, noteName, afterRecord, check });
}

/** True for what the EventBridge rule hands the recorder every 5 minutes. */
export function isScheduledCheck(message) {
  return message !== null && typeof message === 'object' && message.source === 'aws.events' &&
    message['detail-type'] === 'Scheduled Event';
}
