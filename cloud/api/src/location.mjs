/**
 * Lambda entry point of the location function (handler: location.handler), the function LocationFn.
 *
 * One AWS IoT rule invokes it, one message at a time (LocationRule, infra/template.yaml): what a board
 * on firmware 1.13.0 or later hears of the Wi-Fi around it. It reads and writes its own part of the
 * events table, asks AWS IoT Core Device Location for positions, and raises an alert when a board moves.
 */

import { createAlertStore, createLocationStore } from './aws-map.mjs';
import { createAlerter } from './alerts.mjs';
import { createLocator } from './locator.mjs';

export const handler = createLocator({
  store: createLocationStore(process.env),
  alerts: createAlerter({ store: createAlertStore(process.env), consoleUrl: process.env.CONSOLE_URL }),
});
