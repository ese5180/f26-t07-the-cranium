/**
 * Lambda entry point of the schedule that moves staged rollouts on (handler: rollouts-tick.handler),
 * the function RolloutTickFn. EventBridge invokes it every minute; the event says nothing it needs.
 * See tick.mjs. A rollout that stops by itself is an e-mail alert (alerts.mjs), through the alerts'
 * own part of the events table and the alert topic. It reads Memfault's REST API (aws-memfault-api.mjs)
 * for the health gate of the rollouts and the alert rules on Memfault's data, and the alert rules from
 * the state table. On Mondays it may send the weekly fleet report (docs/reports.md) to the same topic.
 */

import { createAlertStore } from './aws-map.mjs';
import { createAlerter } from './alerts.mjs';
import { createMemfaultReader } from './aws-memfault-api.mjs';
import { createAws } from './aws.mjs';
import { loadConfig } from './config.mjs';
import { createRolloutTick } from './tick.mjs';

const store = createAlertStore(process.env);
const tick = createRolloutTick({
  // The alerts that went out, for the weekly report's e-mail (handlers/reports.mjs).
  aws: {
    ...createAws(process.env),
    ...createMemfaultReader(process.env),
    listSentAlerts: (o) => store.listSentAlerts(o),
  },
  config: loadConfig(process.env),
  alerts: createAlerter({ store, consoleUrl: process.env.CONSOLE_URL }),
});

export const handler = () => tick();
