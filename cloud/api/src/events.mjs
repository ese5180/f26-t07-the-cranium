/**
 * Lambda entry point of the recorder (handler: events.handler), the function EventsFn.
 *
 * Two AWS IoT rules invoke it, one message at a time (infra/template.yaml). It needs nothing
 * but the events table, and its role may only put items there.
 */

import { createEventStore } from './aws.mjs';
import { createRecorder } from './recorder.mjs';

export const handler = createRecorder({ store: createEventStore(process.env) });
