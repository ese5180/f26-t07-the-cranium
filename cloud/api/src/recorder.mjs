/**
 * The recorder (EventsFn): it turns what AWS IoT rules hand it into events and samples in the
 * events table. lib/events.mjs says what is recorded and why; this is the part that writes.
 *
 * A message from a rule comes from a board, or from AWS IoT about a board, and is never
 * trusted: a message that is not one of the two kinds, or not about a board of this project's
 * naming, is dropped with a line in the log that names neither its content nor its sender.
 * A write that fails is thrown, so that Lambda tries the message again (EventInvokeConfig in
 * infra/template.yaml limits how often and for how long).
 *
 * Like app.mjs, nothing here imports the AWS SDK: the store is passed in.
 */

import { randomBytes } from 'node:crypto';

import { describeError } from './http.mjs';
import { recordsOf } from './lib/events.mjs';

/**
 * @param {object} options
 * @param {{ putEvent: (item: object) => Promise<void> }} options.store  aws.mjs createEventStore
 * @param {() => number|Date} [options.now]
 * @param {(count: number) => string} [options.randomHex]
 * @param {(line: object) => void} [options.log]
 * @returns {(message: object) => Promise<{ recorded: number }>} the Lambda handler
 */
export function createRecorder({
  store,
  now = Date.now,
  randomHex = (count) => randomBytes(count).toString('hex'),
  log = (line) => console.log(JSON.stringify(line)),
}) {
  if (store === undefined || store === null) throw new TypeError('createRecorder needs a store');
  const clock = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : value;
  };

  return async function handler(message) {
    const made = recordsOf(message, { nowMs: clock(), randomHex });
    if (made.ignored !== undefined) {
      log({ level: 'warn', event: 'message_ignored', reason: made.ignored });
      return { recorded: 0 };
    }
    const events = made.items.filter((item) => item.sk.startsWith('E#'));
    try {
      // A few items at most, in order: the events of one report keep theirs.
      for (const item of made.items) await store.putEvent(item);
    } catch (error) {
      log({ level: 'error', event: 'record_failed', thing: made.thing, error: describeError(error) });
      throw error;
    }
    log({
      event: 'recorded', thing: made.thing, kinds: events.map((item) => item.kind),
      samples: made.items.length - events.length,
    });
    return { recorded: made.items.length };
  };
}
