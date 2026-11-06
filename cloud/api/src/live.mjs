/**
 * Lambda entry point of the live function (handler: live.handler, the function LiveFn, docs/live.md).
 *
 * The WebSocket API's routes and the streams of the events, state and audit tables invoke it
 * (infra/template.yaml). The same package as the console's API, with another entry point, another
 * role and only the settings it needs: the two user pools and their app clients, for the tokens
 * pages connect with; the connections table; the state table, for who owns which board; the three
 * tables' names, to tell their streams apart; and the address of the management API it sends with.
 */

import { createAccountCheck, createLiveStore, createSockets } from './aws-live.mjs';
import { createKeyRing, issuerOf } from './lib/jwt.mjs';
import { createLiveHandler } from './live-app.mjs';

function names(...values) {
  return values.filter((value) => typeof value === 'string' && value !== '');
}

function settings(env) {
  for (const name of ['USER_POOL_ID', 'USER_POOL_CLIENT_ID', 'EVENTS_TABLE', 'STATE_TABLE', 'AUDIT_TABLE']) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  const team = { issuer: issuerOf(env.USER_POOL_ID), clients: names(env.USER_POOL_CLIENT_ID, env.MOBILE_CLIENT_ID) };
  const customer = env.CUSTOMER_POOL_ID
    ? {
        issuer: issuerOf(env.CUSTOMER_POOL_ID),
        clients: names(env.CUSTOMER_CLIENT_ID, env.CUSTOMER_MOBILE_CLIENT_ID),
      }
    : null;
  return {
    pools: { team, customer },
    tables: { events: env.EVENTS_TABLE, state: env.STATE_TABLE, audit: env.AUDIT_TABLE },
  };
}

const { pools, tables } = settings(process.env);

export const handler = createLiveHandler({
  store: createLiveStore(process.env),
  sockets: createSockets(process.env),
  accounts: createAccountCheck(process.env),
  keyFor: createKeyRing({ issuers: names(pools.team.issuer, pools.customer?.issuer) }).keyFor,
  pools,
  tables,
});
