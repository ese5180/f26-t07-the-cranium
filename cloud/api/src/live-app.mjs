/**
 * The live function (LiveFn, docs/live.md): the WebSocket API's three routes, and the tables'
 * streams, in one handler.
 *
 *   $connect     a page opens a WebSocket with the subprotocols "cranium-live, <access token>". The
 *                token is checked (lib/jwt.mjs), then its account, asked of Cognito: a member of the
 *                team must be enabled, confirmed and a viewer or a release manager, a customer enabled
 *                and confirmed. The connection is kept, with who it is and until when: until the token
 *                expires, two hours at most. The answer names the subprotocol "cranium-live", without
 *                which a browser drops the connection. A refusal is 401 or 403; a check that could not
 *                be made is 500, and the page tries again later.
 *   $disconnect  the connection is forgotten.
 *   $default     a page's { "action": "ping" }, which keeps API Gateway's 10-minute idle limit away.
 *                Nothing is answered, and nothing else a page sends does anything.
 *   a stream     records of the events, state and audit tables (lib/live.mjs says which): each open
 *                connection that may hear of the change is sent one message. A connection past its
 *                time is closed and forgotten, and one that API Gateway no longer has is forgotten.
 *
 * A message that cannot be sent never fails the batch: the page still has its polling. Only a batch
 * whose connections cannot be read fails, and is tried again for a minute at most (LiveStreams in
 * infra/template.yaml).
 *
 * Like app.mjs, nothing here imports the AWS SDK: the store, the sockets and the account check are
 * passed in (aws-live.mjs).
 */

import { describeError } from './http.mjs';
import { verifyAccessToken } from './lib/jwt.mjs';
import {
  PROTOCOL,
  changesOf,
  connectionUntil,
  headerOf,
  isConnectionId,
  messageFor,
  tokenFromProtocols,
} from './lib/live.mjs';

const SENDS_AT_ONCE = 8;

/** Run a task for every item, a few at a time. */
async function each(items, task) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(SENDS_AT_ONCE, queue.length) }, async () => {
    while (queue.length > 0) await task(queue.shift());
  });
  await Promise.all(workers);
}

/**
 * @param {object} options
 * @param {object} options.store     putConnection, deleteConnection, listConnections, listOwners (aws-live.mjs)
 * @param {object} options.sockets   send(connectionId, text) -> 'sent' | 'gone', close(connectionId)
 * @param {object} options.accounts  teamMember(sub) -> boolean, customer(sub) -> boolean: whether the
 *                                   account may connect now; they throw when Cognito cannot be asked
 * @param {(issuer: string, kid: string) => Promise<object|null>} options.keyFor  lib/jwt.mjs createKeyRing's
 * @param {{ team: { issuer: string, clients: string[] }, customer: { issuer: string, clients: string[] } | null }} options.pools
 * @param {{ events: string, state: string, audit: string }} options.tables
 * @param {() => number} [options.now]
 * @param {(line: object) => void} [options.log]
 */
export function createLiveHandler({
  store,
  sockets,
  accounts,
  keyFor,
  pools,
  tables,
  now = Date.now,
  log = (line) => console.log(JSON.stringify(line)),
}) {
  for (const [name, value] of Object.entries({ store, sockets, accounts, keyFor, pools, tables })) {
    if (value === undefined || value === null) throw new TypeError(`createLiveHandler needs ${name}`);
  }
  const clients = { [pools.team.issuer]: pools.team.clients };
  if (pools.customer) clients[pools.customer.issuer] = pools.customer.clients;
  const audienceOf = (issuer) => (issuer === pools.team.issuer ? 'team' : 'customer');

  const answer = (statusCode, headers) => (headers ? { statusCode, headers } : { statusCode });

  async function connect(event, connectionId) {
    const token = tokenFromProtocols(headerOf(event, 'sec-websocket-protocol'));
    if (token === null) {
      log({ route: '$connect', outcome: 'refused', reason: 'no_token' });
      return answer(401);
    }
    const nowS = Math.floor(now() / 1000);
    let checked;
    try {
      checked = await verifyAccessToken(token, { clients, keyFor, nowS });
    } catch (error) {
      log({ route: '$connect', outcome: 'failed', step: 'keys', error: describeError(error) });
      return answer(500);
    }
    if (!checked.ok) {
      log({ route: '$connect', outcome: 'refused', reason: checked.reason });
      return answer(401);
    }
    const audience = audienceOf(checked.issuer);
    let allowed;
    try {
      allowed = audience === 'team' ? await accounts.teamMember(checked.sub) : await accounts.customer(checked.sub);
    } catch (error) {
      log({ route: '$connect', outcome: 'failed', step: 'account', audience, error: describeError(error) });
      return answer(500);
    }
    if (!allowed) {
      log({ route: '$connect', outcome: 'refused', reason: 'account', audience });
      return answer(403);
    }
    const until = connectionUntil(checked.expiresAt, nowS);
    try {
      await store.putConnection({ connectionId, audience, sub: checked.sub, until });
    } catch (error) {
      log({ route: '$connect', outcome: 'failed', step: 'store', audience, error: describeError(error) });
      return answer(500);
    }
    log({ route: '$connect', outcome: 'connected', audience, until });
    return answer(200, { 'Sec-WebSocket-Protocol': PROTOCOL });
  }

  async function fanOut(records) {
    const change = changesOf(records, tables);
    if (change.what.length === 0) return { sent: 0, closed: 0 };
    const connections = await store.listConnections();
    if (connections.length === 0) return { sent: 0, closed: 0 };
    const owners = connections.some((connection) => connection.audience === 'customer')
      ? await store.listOwners()
      : null;
    const atMs = now();
    const nowS = Math.floor(atMs / 1000);
    let sent = 0;
    let closed = 0;
    let failed = 0;
    await each(connections, async (connection) => {
      const { connectionId } = connection;
      try {
        if (!(connection.until > nowS)) {
          // The token it connected with has expired: the page connects again with a new one.
          await sockets.close(connectionId);
          await store.deleteConnection(connectionId);
          closed += 1;
          return;
        }
        const message = messageFor(connection, change, owners, atMs);
        if (message === null) return;
        if ((await sockets.send(connectionId, JSON.stringify(message))) === 'gone') {
          await store.deleteConnection(connectionId);
          closed += 1;
        } else {
          sent += 1;
        }
      } catch (error) {
        failed += 1;
        log({ stream: true, outcome: 'send_failed', error: describeError(error) });
      }
    });
    log({
      stream: true,
      things: change.things.length,
      what: change.what,
      connections: connections.length,
      sent,
      closed,
      failed,
    });
    return { sent, closed };
  }

  return async function liveHandler(event) {
    if (Array.isArray(event?.Records)) return fanOut(event.Records);
    const route = event?.requestContext?.routeKey;
    const connectionId = event?.requestContext?.connectionId;
    if (!isConnectionId(connectionId)) return answer(400);
    if (route === '$connect') return connect(event, connectionId);
    if (route === '$disconnect') {
      await store.deleteConnection(connectionId);
      return answer(200);
    }
    // $default, and so every message a page sends: a ping, or nothing this function acts on.
    return answer(200);
  };
}
