/**
 * The AWS calls of the map, the commands and the alerts (docs/fleet.md): the second module that
 * imports the AWS SDK, beside aws.mjs, and held to the same rules. Handlers never see an SDK client,
 * command or exception; a failure they cannot act on is thrown as an Error with name "AwsError",
 * code "throttled" | "failed", operation, awsError and awsStatus, and test/fake-map.mjs implements
 * the same methods in memory (keep the two in step: test/map-aws.test.mjs compares them).
 *
 * createMapAws(env) is the API's part (index.mjs adds it to the adapter of aws.mjs). It reads
 * AWS_REGION, EVENTS_TABLE and ALERT_TOPIC_ARN.
 *
 *   publishCommand({ thing, payload })   -> undefined   iot-data Publish, QoS 1, to cranium/<thing>/commands;
 *                                                       payload is an object, sent as JSON
 *   listLocations()                      -> object[]    every item of the LOC partition (lib/position.mjs)
 *   getLocation(thing)                   -> object | null   that board's item of it
 *   listAlertSubscriptions()             -> [{ arn: string | null, endpoint, protocol }]   the topic's
 *                                                       subscriptions; arn null while one waits for its
 *                                                       confirmation
 *   subscribeAlerts(email)               -> { pending: boolean }   an e-mail subscription; SNS sends the
 *                                                       confirmation message
 *   unsubscribeAlerts(arn)               -> { ok: true } | { ok: false, reason: "not_found" }
 *   listSentAlerts({ limit })            -> object[]    the newest e-mails that went out (lib/alerts.mjs)
 *
 * createAlertStore(env) is the recorder's and the location function's part for the alerts. It reads
 * AWS_REGION, EVENTS_TABLE and ALERT_TOPIC_ARN.
 *
 *   getAlertItem(sk)                     -> object | null   an item of the ALERTS partition
 *   listAlertItems()                     -> object[]    the boards' and deployments' items (B#, D#)
 *   putAlertItem(item, rev)              -> { ok: true } | { ok: false, reason: "conflict" }   only if the
 *                                                       item stored has that rev (0: there is none)
 *   putSentAlert(item)                   -> undefined
 *   publishAlert({ subject, message })   -> undefined   SNS Publish to the topic
 *   listSentAlerts({ limit })            -> object[]    as createMapAws's, for the weekly report's e-mail
 *   getAlertRules()                      -> object | null   the alert rules' item of the state table (pk
 *                                        "ALR", sk "rules"), or null when there is none or the function
 *                                        is given no STATE_TABLE (the location function)
 *
 * createLocationStore(env) is the location function's own part. It reads AWS_REGION and EVENTS_TABLE.
 *
 *   getLocation(thing)                   -> object | null
 *   putLocation(item, rev)               -> { ok: true } | { ok: false, reason: "conflict" }
 *   putEvent(item)                       -> undefined   an event of the board (lib/events.mjs)
 *   solvePosition(request)               -> { found: true, geoJson: string } | { found: false }
 *                                           GetPositionEstimate with the request of lib/position.mjs
 *                                           estimateRequest; found is false when AWS could not place it (404)
 */

import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { IoTDataPlaneClient, PublishCommand as IotPublishCommand } from '@aws-sdk/client-iot-data-plane';
import { GetPositionEstimateCommand, IoTWirelessClient } from '@aws-sdk/client-iot-wireless';
import {
  ListSubscriptionsByTopicCommand,
  PublishCommand as SnsPublishCommand,
  SNSClient,
  SubscribeCommand,
  UnsubscribeCommand,
} from '@aws-sdk/client-sns';

import { ALERTS_PK, ALERT_RULES_PK, ALERT_RULES_SK } from './lib/alerts.mjs';
import { LOCATION_PK } from './lib/position.mjs';

// As in aws.mjs: no call may hang, and a call is tried twice at most.
const CONNECT_TIMEOUT_MS = 1000;
const IDLE_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 2;
const MAX_PAGES = 40;

const THROTTLING = new Set([
  'ThrottlingException',
  'Throttling',
  'ThrottledException',
  'TooManyRequestsException',
  'RequestLimitExceeded',
  'ProvisionedThroughputExceededException',
  'RequestThrottled',
  'RequestThrottledException',
  'SlowDown',
]);

function nameOf(cause) {
  return cause !== null && typeof cause === 'object' && typeof cause.name === 'string' ? cause.name : 'Error';
}

function statusOf(cause) {
  const status = cause?.$metadata?.httpStatusCode;
  return Number.isInteger(status) ? status : null;
}

function failure(operation, cause, code) {
  const error = new Error(`${operation}: ${nameOf(cause)}: ${String(cause?.message ?? cause).slice(0, 300)}`);
  error.name = 'AwsError';
  error.code =
    code ??
    (THROTTLING.has(nameOf(cause)) || statusOf(cause) === 429 || cause?.$retryable?.throttling === true
      ? 'throttled'
      : 'failed');
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

function required(env, name) {
  const value = env?.[name];
  if (typeof value !== 'string' || value === '') throw new Error(`Environment variable ${name} is missing`);
  return value;
}

// DynamoDB attribute values for plain data, as in aws.mjs.
function toAttribute(value) {
  if (value === null) return { NULL: true };
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'boolean') return { BOOL: value };
  if (typeof value === 'number' && Number.isFinite(value)) return { N: String(value) };
  if (Array.isArray(value)) return { L: value.map(toAttribute) };
  if (typeof value === 'object') return { M: toItem(value) };
  throw new TypeError(`A value of type ${typeof value} cannot be stored`);
}

function toItem(record) {
  const item = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) item[key] = toAttribute(value);
  }
  return item;
}

function fromAttribute(attribute) {
  if (attribute === null || typeof attribute !== 'object') return null;
  if (typeof attribute.S === 'string') return attribute.S;
  if (typeof attribute.N === 'string') return Number(attribute.N);
  if (typeof attribute.BOOL === 'boolean') return attribute.BOOL;
  if (attribute.M !== undefined && attribute.M !== null) return fromItem(attribute.M);
  if (Array.isArray(attribute.L)) return attribute.L.map(fromAttribute);
  return null;
}

function fromItem(item) {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, fromAttribute(value)]));
}

/** The table calls the three parts share: one partition, read by Query, written with a condition on rev. */
function tableOf(dynamo, table) {
  async function query(pk, { sk = null, prefix = null, limit = Infinity, newestFirst = false } = {}) {
    const names = { '#pk': 'pk' };
    const values = { ':pk': { S: pk } };
    let condition = '#pk = :pk';
    if (sk !== null) {
      names['#sk'] = 'sk';
      values[':sk'] = { S: sk };
      condition += ' AND #sk = :sk';
    } else if (prefix !== null) {
      names['#sk'] = 'sk';
      values[':prefix'] = { S: prefix };
      condition += ' AND begins_with(#sk, :prefix)';
    }
    const items = [];
    let start;
    for (let pages = 0; pages < MAX_PAGES; pages += 1) {
      const input = {
        TableName: table,
        KeyConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConsistentRead: true,
        ScanIndexForward: !newestFirst,
        ExclusiveStartKey: start,
      };
      if (Number.isFinite(limit)) input.Limit = limit - items.length;
      const out = await dynamo.send(new QueryCommand(input));
      for (const item of out.Items ?? []) items.push(fromItem(item));
      if (items.length >= limit) return items.slice(0, limit);
      if (out.LastEvaluatedKey === undefined || out.LastEvaluatedKey === null) return items;
      start = out.LastEvaluatedKey;
    }
    throw new Error(`more than ${MAX_PAGES} pages`);
  }

  return {
    async list(pk, options) {
      try {
        return await query(pk, options);
      } catch (cause) {
        throw failure('Query', cause);
      }
    },

    async get(pk, sk) {
      try {
        return (await query(pk, { sk }))[0] ?? null;
      } catch (cause) {
        throw failure('Query', cause);
      }
    },

    /** Store an item if the one there has this rev (0: none is there). */
    async putIf(item, rev) {
      const input = { TableName: table, Item: toItem(item), ExpressionAttributeNames: { '#pk': 'pk' } };
      if (rev === 0) {
        input.ConditionExpression = 'attribute_not_exists(#pk)';
      } else {
        input.ConditionExpression = '#rev = :rev';
        input.ExpressionAttributeNames = { '#rev': 'rev' };
        input.ExpressionAttributeValues = { ':rev': { N: String(rev) } };
      }
      try {
        await dynamo.send(new PutItemCommand(input));
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'ConditionalCheckFailedException') return { ok: false, reason: 'conflict' };
        throw failure('PutItem', cause);
      }
    },

    async put(item) {
      try {
        await dynamo.send(new PutItemCommand({ TableName: table, Item: toItem(item) }));
      } catch (cause) {
        throw failure('PutItem', cause);
      }
    },
  };
}

/** The topic a board's commands go to. The thing name is validated by the caller. */
export function commandTopic(thing) {
  return `cranium/${thing}/commands`;
}

/** @param {Record<string, string|undefined>} env  the Lambda environment */
export function createMapAws(env) {
  const region = required(env, 'AWS_REGION');
  const table = tableOf(new DynamoDBClient(clientSettings(region)), required(env, 'EVENTS_TABLE'));
  const topicArn = required(env, 'ALERT_TOPIC_ARN');
  const iotData = new IoTDataPlaneClient(clientSettings(region));
  const sns = new SNSClient(clientSettings(region));

  return Object.freeze({
    async publishCommand({ thing, payload }) {
      try {
        await iotData.send(
          new IotPublishCommand({
            topic: commandTopic(thing),
            qos: 1,
            payload: Buffer.from(JSON.stringify(payload), 'utf8'),
            contentType: 'application/json',
          })
        );
      } catch (cause) {
        throw failure('Publish', cause);
      }
    },

    listLocations() {
      return table.list(LOCATION_PK);
    },

    getLocation(thing) {
      return table.get(LOCATION_PK, thing);
    },

    async listAlertSubscriptions() {
      const all = [];
      let token;
      try {
        for (let pages = 0; pages < MAX_PAGES; pages += 1) {
          const out = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken: token }));
          for (const entry of out.Subscriptions ?? []) {
            if (typeof entry?.Endpoint !== 'string' || typeof entry?.Protocol !== 'string') continue;
            const arn =
              typeof entry.SubscriptionArn === 'string' && entry.SubscriptionArn.startsWith('arn:')
                ? entry.SubscriptionArn
                : null;
            all.push({ arn, endpoint: entry.Endpoint, protocol: entry.Protocol });
          }
          if (typeof out.NextToken !== 'string' || out.NextToken === '') return all;
          token = out.NextToken;
        }
      } catch (cause) {
        throw failure('ListSubscriptionsByTopic', cause);
      }
      throw failure('ListSubscriptionsByTopic', new Error(`more than ${MAX_PAGES} pages`), 'failed');
    },

    async subscribeAlerts(email) {
      try {
        const out = await sns.send(new SubscribeCommand({ TopicArn: topicArn, Protocol: 'email', Endpoint: email }));
        return { pending: !(typeof out.SubscriptionArn === 'string' && out.SubscriptionArn.startsWith('arn:')) };
      } catch (cause) {
        throw failure('Subscribe', cause);
      }
    },

    async unsubscribeAlerts(arn) {
      try {
        await sns.send(new UnsubscribeCommand({ SubscriptionArn: arn }));
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'NotFoundException' || nameOf(cause) === 'NotFound')
          return { ok: false, reason: 'not_found' };
        throw failure('Unsubscribe', cause);
      }
    },

    listSentAlerts({ limit }) {
      return table.list(ALERTS_PK, { prefix: 'S#', limit, newestFirst: true });
    },
  });
}

/** @param {Record<string, string|undefined>} env  the Lambda environment */
export function createAlertStore(env) {
  const region = required(env, 'AWS_REGION');
  const table = tableOf(new DynamoDBClient(clientSettings(region)), required(env, 'EVENTS_TABLE'));
  const topicArn = required(env, 'ALERT_TOPIC_ARN');
  const sns = new SNSClient(clientSettings(region));
  const state =
    typeof env.STATE_TABLE === 'string' && env.STATE_TABLE !== ''
      ? tableOf(new DynamoDBClient(clientSettings(region)), env.STATE_TABLE)
      : null;

  return Object.freeze({
    getAlertRules() {
      return state === null ? Promise.resolve(null) : state.get(ALERT_RULES_PK, ALERT_RULES_SK);
    },

    getAlertItem(sk) {
      return table.get(ALERTS_PK, sk);
    },

    async listAlertItems() {
      const [boards, deployments] = await Promise.all([
        table.list(ALERTS_PK, { prefix: 'B#' }),
        table.list(ALERTS_PK, { prefix: 'D#' }),
      ]);
      return [...boards, ...deployments];
    },

    putAlertItem(item, rev) {
      return table.putIf(item, rev);
    },

    putSentAlert(item) {
      return table.put(item);
    },

    async publishAlert({ subject, message }) {
      try {
        await sns.send(new SnsPublishCommand({ TopicArn: topicArn, Subject: subject, Message: message }));
      } catch (cause) {
        throw failure('Publish', cause);
      }
    },

    listSentAlerts({ limit }) {
      return table.list(ALERTS_PK, { prefix: 'S#', limit, newestFirst: true });
    },
  });
}

/** The answer of GetPositionEstimate as text: a blob, which the SDK hands over as bytes. */
async function payloadText(payload) {
  if (typeof payload === 'string') return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload).toString('utf8');
  if (typeof payload?.transformToString === 'function') return payload.transformToString();
  return '';
}

/** @param {Record<string, string|undefined>} env  the Lambda environment */
export function createLocationStore(env) {
  const region = required(env, 'AWS_REGION');
  const table = tableOf(new DynamoDBClient(clientSettings(region)), required(env, 'EVENTS_TABLE'));
  const wireless = new IoTWirelessClient(clientSettings(region));

  return Object.freeze({
    getLocation(thing) {
      return table.get(LOCATION_PK, thing);
    },

    putLocation(item, rev) {
      return table.putIf(item, rev);
    },

    putEvent(item) {
      return table.put(item);
    },

    async solvePosition(request) {
      let out;
      try {
        out = await wireless.send(new GetPositionEstimateCommand(request));
      } catch (cause) {
        // 404: AWS found no position for these access points.
        if (nameOf(cause) === 'ResourceNotFoundException' || statusOf(cause) === 404) return { found: false };
        throw failure('GetPositionEstimate', cause);
      }
      return { found: true, geoJson: await payloadText(out?.GeoJsonPayload) };
    },
  });
}
