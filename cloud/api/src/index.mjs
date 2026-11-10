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
import { createDbAws } from './aws-db.mjs';
import { createMapAws } from './aws-map.mjs';
import { createMemfaultReader } from './aws-memfault-api.mjs';
import { createMemfaultStatus } from './aws-memfault.mjs';
import { createProvisionAws } from './aws-provision.mjs';
import { createTeamStore } from './aws-team.mjs';
import { createWifiDefaultsReader } from './aws-wifi-defaults.mjs';
import { createAws } from './aws.mjs';
import { loadConfig } from './config.mjs';
import { createCustomerStore } from './customer/aws.mjs';
import { loadCustomerAdminConfig } from './customer/config.mjs';

const customers = loadCustomerAdminConfig(process.env);
const config = Object.freeze({ ...loadConfig(process.env), customers });

// The adapter: aws.mjs, the calls of the map, the commands and the alerts (aws-map.mjs), those of the
// phone apps' releases (aws-apps.mjs), the customer site's (customer/aws.mjs), whether a Memfault
// project key is stored (aws-memfault.mjs), the reads of Memfault's REST API (aws-memfault-api.mjs),
// and the calls of provisioning (aws-provision.mjs).
export const handler = createApp({
  aws: {
    ...createAws(process.env),
    ...createMapAws(process.env),
    ...createAppsAws(process.env),
    ...createMemfaultStatus(process.env),
    ...createMemfaultReader(process.env),
    // Provisioning through the console: things, certificates from a board's request, the device policy.
    ...createProvisionAws(process.env),
    // Board setup's Wi-Fi defaults: the one secret of them, read by this function alone.
    ...createWifiDefaultsReader(process.env),
    // The Database page: DescribeTable, Query and Scan of the three tables, read only (aws-db.mjs).
    ...createDbAws(process.env),
    // The Team page: the staff pool's accounts, their tiers and states (aws-team.mjs). Never a password.
    ...createTeamStore(process.env),
    ...(customers === null ? {} : createCustomerStore(process.env)),
  },
  config,
});
