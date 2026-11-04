/**
 * Lambda entry point of the console API (handler: index.handler).
 *
 * Everything is set up once per execution environment: the configuration is read and
 * checked, the AWS clients are created, and the handler keeps its short-lived caches
 * in memory between requests. A bad configuration fails here, before any request is
 * served.
 *
 * Lambda calls the handler with the event and with its context object. The handler
 * asks the context how much time is left, so that it can answer and record a request
 * before Lambda would stop the function (see app.mjs).
 *
 * The customer site's accounts and their boards (the Customers page) are one more adapter
 * beside the others, for the customer pool and the ownership records (customer/aws.mjs).
 */

import { createApp } from './app.mjs';
import { createAppsAws } from './aws-apps.mjs';
import { createMapAws } from './aws-map.mjs';
import { createAws } from './aws.mjs';
import { loadConfig } from './config.mjs';
import { createCustomerStore } from './customer/aws.mjs';
import { loadCustomerAdminConfig } from './customer/config.mjs';

const customers = loadCustomerAdminConfig(process.env);
const config = Object.freeze({ ...loadConfig(process.env), customers });

// The adapter: aws.mjs, the calls of the map, the commands and the alerts (aws-map.mjs), those of the
// phone apps' releases (aws-apps.mjs), and the customer site's (customer/aws.mjs).
export const handler = createApp({
  aws: {
    ...createAws(process.env), ...createMapAws(process.env), ...createAppsAws(process.env),
    ...(customers === null ? {} : createCustomerStore(process.env)),
  },
  config,
});
