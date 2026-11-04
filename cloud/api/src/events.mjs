/**
 * Lambda entry point of the recorder (handler: events.handler), the function EventsFn.
 *
 * Three AWS IoT rules invoke it, one message at a time (infra/template.yaml): a board's shadow
 * after each report, AWS IoT's word that a board connected or disconnected, and each line a board
 * prints on its console; and an EventBridge rule every 5 minutes, for the alerts that are due. It needs
 * the events table, of which it may read only the alerts' own part, and the alert topic, to which it may
 * only publish.
 */

import { createAlertStore } from './aws-map.mjs';
import { createEventStore } from './aws.mjs';
import { createAlerter } from './alerts.mjs';
import { createRecorder } from './recorder.mjs';

export const handler = createRecorder({
  store: createEventStore(process.env),
  // E-mail alerts (alerts.mjs), and the check that an EventBridge rule runs every 5 minutes.
  alerts: createAlerter({ store: createAlertStore(process.env), consoleUrl: process.env.CONSOLE_URL }),
});
