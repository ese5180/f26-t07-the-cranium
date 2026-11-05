/**
 * Lambda entry point of the Memfault forwarder (handler: memfault.handler), the function MemfaultFn.
 *
 * One AWS IoT rule invokes it, one message at a time (MemfaultRule, infra/template.yaml): a frame that a
 * board on firmware 1.14.0 or later published on cranium/<thing>/memfault, with one Memfault chunk in it.
 * It reads the project key from AWS Secrets Manager, posts the chunk to Memfault, and answers the board
 * on its commands topic (forwarder.mjs says when, and when not).
 */

import { createMemfaultStore } from './aws-memfault.mjs';
import { createForwarder } from './forwarder.mjs';

export const handler = createForwarder({ store: createMemfaultStore(process.env) });
