/**
 * The AWS calls of the live function (LiveFn, live-app.mjs, docs/live.md), held to the rules of aws.mjs:
 * no call waits without a limit, a call is tried twice at most, and a failure a caller cannot act on is
 * thrown as an Error with name "AwsError", code "throttled" | "failed", operation, awsError and awsStatus.
 * test/aws-live.test.mjs holds it to the SDK's input members.
 *
 * createLiveStore(env): the open connections, and who owns which board. It reads AWS_REGION,
 * CONNECTIONS_TABLE and STATE_TABLE.
 *
 *   putConnection({ connectionId, audience, sub, until })   the connection's item; DynamoDB deletes it
 *                                                           an hour after `until` if nothing else does
 *   deleteConnection(connectionId)
 *   listConnections()  -> [{ connectionId, audience, sub, until }]  every one, any order. A Scan: the
 *                         table holds one item per open page, a few dozen; at thousands, this is the
 *                         part to change (an index by audience, or a fan-out of its own)
 *   listOwners()       -> Map(thing -> { owner, ref })  the owned boards (state table, pk "OWN"), as
 *                         customer/aws.mjs reads them: the owner's sub and the ref the customer site
 *                         names the board by; consistent read
 *
 * createSockets(env): the connections themselves, through API Gateway's management API at
 * LIVE_CALLBACK_URL (https://<api id>.execute-api.<region>.amazonaws.com/<stage>).
 *
 *   send(connectionId, text) -> 'sent' | 'gone'   'gone' when API Gateway no longer has the connection
 *   close(connectionId)                           a connection that is already gone is no failure
 *
 * createAccountCheck(env): whether an account may connect now, asked of Cognito. It reads AWS_REGION,
 * USER_POOL_ID and, for customers, CUSTOMER_POOL_ID (without it no customer may connect).
 *
 *   teamMember(sub) -> boolean   enabled, confirmed, and a viewer or a release manager
 *   customer(sub)   -> boolean   enabled and confirmed
 */

import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import {
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { DeleteItemCommand, DynamoDBClient, PutItemCommand, QueryCommand, ScanCommand } from '@aws-sdk/client-dynamodb';

import { AUDIENCES, isConnectionId } from './lib/live.mjs';
import { isThing } from './lib/validate.mjs';

const CONNECT_TIMEOUT_MS = 1000;
const IDLE_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 2;
const MAX_PAGES = 40;
const GROUP_PAGE_SIZE = 60;
// How long DynamoDB keeps a connection's item after its time is up, when no $disconnect came.
const KEPT_AFTER_S = 3600;
const OWNERSHIP_PK = 'OWN';
const TEAM_GROUPS = Object.freeze(['release-managers', 'viewers']);

const CALLBACK_URL =
  /^https:\/\/[a-z0-9]{1,32}\.execute-api\.[a-z]{2}(?:-[a-z]+)+-\d{1,2}\.amazonaws\.com\/[A-Za-z0-9_-]{1,128}$/;
const POOL_ID = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}_[0-9A-Za-z]{1,64}$/;
const TABLE = /^[A-Za-z0-9_.-]{3,255}$/;
const SUB = /^[A-Za-z0-9_.:-]{1,128}$/;
const REF = /^[0-9a-f]{16}$/;

const THROTTLING = new Set([
  'ThrottlingException',
  'Throttling',
  'ThrottledException',
  'TooManyRequestsException',
  'RequestLimitExceeded',
  'LimitExceededException',
]);

function nameOf(cause) {
  return cause !== null && typeof cause === 'object' && typeof cause.name === 'string' ? cause.name : 'Error';
}

function statusOf(cause) {
  const status = cause?.$metadata?.httpStatusCode;
  return Number.isInteger(status) ? status : null;
}

function failure(operation, cause) {
  const error = new Error(`${operation}: ${nameOf(cause)}: ${String(cause?.message ?? cause).slice(0, 300)}`);
  error.name = 'AwsError';
  error.code =
    THROTTLING.has(nameOf(cause)) || statusOf(cause) === 429 || cause?.$retryable?.throttling === true
      ? 'throttled'
      : 'failed';
  error.operation = operation;
  error.awsError = nameOf(cause);
  error.awsStatus = statusOf(cause);
  return error;
}

function clientSettings(region) {
  return {
    region,
    maxAttempts: MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: IDLE_TIMEOUT_MS,
      requestTimeout: CALL_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  };
}

function required(env, name, pattern = null) {
  const value = env?.[name];
  if (typeof value !== 'string' || value === '' || (pattern !== null && !pattern.test(value))) {
    // The value itself is not put in the message: messages end up in logs.
    throw new Error(`Environment variable ${name} is missing or malformed`);
  }
  return value;
}

function text(attribute) {
  return typeof attribute?.S === 'string' ? attribute.S : null;
}

function number(attribute) {
  return typeof attribute?.N === 'string' && /^\d{1,12}$/.test(attribute.N) ? Number(attribute.N) : null;
}

function connectionOf(item) {
  const connectionId = text(item?.connectionId);
  const audience = text(item?.audience);
  const sub = text(item?.sub);
  const until = number(item?.until);
  if (!isConnectionId(connectionId) || !AUDIENCES.includes(audience) || sub === null || until === null) return null;
  return { connectionId, audience, sub, until };
}

/** @param {Record<string, string|undefined>} env  the Lambda environment */
export function createLiveStore(env) {
  const region = required(env, 'AWS_REGION');
  const connections = required(env, 'CONNECTIONS_TABLE', TABLE);
  const stateTable = required(env, 'STATE_TABLE', TABLE);
  const dynamo = new DynamoDBClient(clientSettings(region));

  return Object.freeze({
    async putConnection({ connectionId, audience, sub, until }) {
      if (
        !isConnectionId(connectionId) ||
        !AUDIENCES.includes(audience) ||
        !SUB.test(sub) ||
        !Number.isInteger(until)
      ) {
        throw new TypeError('a connection needs its id, audience, sub and time');
      }
      try {
        await dynamo.send(
          new PutItemCommand({
            TableName: connections,
            Item: {
              connectionId: { S: connectionId },
              audience: { S: audience },
              sub: { S: sub },
              until: { N: String(until) },
              ttl: { N: String(until + KEPT_AFTER_S) },
            },
          })
        );
      } catch (cause) {
        throw failure('PutItem', cause);
      }
    },

    async deleteConnection(connectionId) {
      if (!isConnectionId(connectionId)) return;
      try {
        await dynamo.send(
          new DeleteItemCommand({ TableName: connections, Key: { connectionId: { S: connectionId } } })
        );
      } catch (cause) {
        throw failure('DeleteItem', cause);
      }
    },

    async listConnections() {
      const all = [];
      let start;
      try {
        for (let pages = 0; pages < MAX_PAGES; pages += 1) {
          const out = await dynamo.send(new ScanCommand({ TableName: connections, ExclusiveStartKey: start }));
          for (const item of out.Items ?? []) {
            const connection = connectionOf(item);
            if (connection !== null) all.push(connection);
          }
          if (out.LastEvaluatedKey === undefined || out.LastEvaluatedKey === null) return all;
          start = out.LastEvaluatedKey;
        }
      } catch (cause) {
        throw failure('Scan', cause);
      }
      throw failure('Scan', new Error(`more than ${MAX_PAGES} pages`));
    },

    async listOwners() {
      const owners = new Map();
      let start;
      try {
        for (let pages = 0; pages < MAX_PAGES; pages += 1) {
          const out = await dynamo.send(
            new QueryCommand({
              TableName: stateTable,
              KeyConditionExpression: '#pk = :pk',
              ExpressionAttributeNames: { '#pk': 'pk' },
              ExpressionAttributeValues: { ':pk': { S: OWNERSHIP_PK } },
              ConsistentRead: true,
              ExclusiveStartKey: start,
            })
          );
          for (const item of out.Items ?? []) {
            const thing = text(item?.sk);
            const owner = text(item?.owner);
            const ref = text(item?.ref);
            if (isThing(thing) && owner !== null && owner !== '' && ref !== null && REF.test(ref)) {
              owners.set(thing, { owner, ref });
            }
          }
          if (out.LastEvaluatedKey === undefined || out.LastEvaluatedKey === null) return owners;
          start = out.LastEvaluatedKey;
        }
      } catch (cause) {
        throw failure('Query', cause);
      }
      throw failure('Query', new Error(`more than ${MAX_PAGES} pages`));
    },
  });
}

/** @param {Record<string, string|undefined>} env  the Lambda environment */
export function createSockets(env) {
  const region = required(env, 'AWS_REGION');
  const endpoint = required(env, 'LIVE_CALLBACK_URL', CALLBACK_URL);
  const api = new ApiGatewayManagementApiClient({ ...clientSettings(region), endpoint });

  return Object.freeze({
    async send(connectionId, message) {
      try {
        await api.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(message, 'utf8') }));
        return 'sent';
      } catch (cause) {
        if (nameOf(cause) === 'GoneException' || statusOf(cause) === 410) return 'gone';
        throw failure('PostToConnection', cause);
      }
    },

    async close(connectionId) {
      try {
        await api.send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
      } catch (cause) {
        if (nameOf(cause) === 'GoneException' || statusOf(cause) === 410) return;
        throw failure('DeleteConnection', cause);
      }
    },
  });
}

/** @param {Record<string, string|undefined>} env  the Lambda environment */
export function createAccountCheck(env) {
  const region = required(env, 'AWS_REGION');
  const teamPool = required(env, 'USER_POOL_ID', POOL_ID);
  const customerPool = env?.CUSTOMER_POOL_ID ? required(env, 'CUSTOMER_POOL_ID', POOL_ID) : null;
  const cognito = new CognitoIdentityProviderClient(clientSettings(region));

  async function active(pool, sub) {
    try {
      const out = await cognito.send(new AdminGetUserCommand({ UserPoolId: pool, Username: sub }));
      return out?.Enabled === true && out?.UserStatus === 'CONFIRMED';
    } catch (cause) {
      if (nameOf(cause) === 'UserNotFoundException') return false;
      throw failure('AdminGetUser', cause);
    }
  }

  async function groupsOf(sub) {
    const groups = [];
    let NextToken;
    try {
      for (let pages = 0; pages < MAX_PAGES; pages += 1) {
        const out = await cognito.send(
          new AdminListGroupsForUserCommand({ UserPoolId: teamPool, Username: sub, Limit: GROUP_PAGE_SIZE, NextToken })
        );
        for (const group of out?.Groups ?? []) if (typeof group?.GroupName === 'string') groups.push(group.GroupName);
        if (!out?.NextToken) return groups;
        NextToken = out.NextToken;
      }
    } catch (cause) {
      if (nameOf(cause) === 'UserNotFoundException') return [];
      throw failure('AdminListGroupsForUser', cause);
    }
    throw failure('AdminListGroupsForUser', new Error(`more than ${MAX_PAGES} pages`));
  }

  return Object.freeze({
    async teamMember(sub) {
      if (!SUB.test(String(sub ?? ''))) return false;
      if (!(await active(teamPool, sub))) return false;
      const groups = await groupsOf(sub);
      return TEAM_GROUPS.some((name) => groups.includes(name));
    },

    async customer(sub) {
      if (customerPool === null || !SUB.test(String(sub ?? ''))) return false;
      return active(customerPool, sub);
    },
  });
}
