/**
 * Lambda entry point of the customer API (handler: customer.handler, the function CustomerApiFn).
 *
 * The same package as the console's API, with another entry point, another role and only the
 * settings it needs: the customer pool and its client, the state table (for who owns which
 * board) and the events table. See customer/app.mjs.
 */

import { createCustomerApp } from './customer/app.mjs';
import { createBoardReader, createCustomerStore } from './customer/aws.mjs';
import { loadCustomerApiConfig } from './customer/config.mjs';

const config = loadCustomerApiConfig(process.env);

export const handler = createCustomerApp({
  aws: { ...createBoardReader(process.env), ...createCustomerStore(process.env) },
  config,
});
