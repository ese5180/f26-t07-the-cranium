/**
 * Lambda entry point of the recorder (handler: events.handler), the function EventsFn.
 *
 * Three AWS IoT rules invoke it, one message at a time (infra/template.yaml): a board's shadow
 * after each report, AWS IoT's word that a board connected or disconnected, and each line a board
 * prints on its console. It needs nothing but the events table, and its role may only put items
 * there.
 */

import { createEventStore } from './aws.mjs';
import { createRecorder } from './recorder.mjs';

export const handler = createRecorder({ store: createEventStore(process.env) });
