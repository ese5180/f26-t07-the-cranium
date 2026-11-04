/**
 * Lambda entry point of the schedule that moves staged rollouts on (handler: rollouts-tick.handler),
 * the function RolloutTickFn. EventBridge invokes it every minute; the event says nothing it needs.
 * See tick.mjs. A rollout that stops by itself is an e-mail alert (alerts.mjs), through the alerts'
 * own part of the events table and the alert topic.
 */

import { createAlertStore } from './aws-map.mjs';
import { createAlerter } from './alerts.mjs';
import { createAws } from './aws.mjs';
import { loadConfig } from './config.mjs';
import { createRolloutTick } from './tick.mjs';

const tick = createRolloutTick({
  aws: createAws(process.env),
  config: loadConfig(process.env),
  alerts: createAlerter({ store: createAlertStore(process.env), consoleUrl: process.env.CONSOLE_URL }),
});

export const handler = () => tick();
