// Tests for the AWS adapter of the map, the commands and the alerts (src/aws-map.mjs).
//
// As in aws.test.mjs, the SDK is not installed here: the four packages the adapter imports are
// replaced, through a module loader hook, by stand-ins that record every command and hold the
// adapter to the SDK's input members (taken from the command sources of the AWS SDK for JavaScript
// v3, 3.1149.0). What these cannot show is that AWS behaves as the replies assume: the request and
// response of GetPositionEstimate are those of its API reference (iotwireless 2020-11-22).

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

import { createFakeAws } from './fake-aws.mjs';

const REFERENCE = {
  '@aws-sdk/client-dynamodb': {
    client: 'DynamoDBClient',
    commands: {
      PutItemCommand: {
        required: ['TableName', 'Item'],
        optional: [
          'Expected',
          'ReturnValues',
          'ReturnConsumedCapacity',
          'ReturnItemCollectionMetrics',
          'ConditionalOperator',
          'ConditionExpression',
          'ExpressionAttributeNames',
          'ExpressionAttributeValues',
          'ReturnValuesOnConditionCheckFailure',
        ],
      },
      QueryCommand: {
        required: ['TableName'],
        optional: [
          'IndexName',
          'Select',
          'AttributesToGet',
          'Limit',
          'ConsistentRead',
          'KeyConditions',
          'QueryFilter',
          'ConditionalOperator',
          'ScanIndexForward',
          'ExclusiveStartKey',
          'ReturnConsumedCapacity',
          'ProjectionExpression',
          'FilterExpression',
          'KeyConditionExpression',
          'ExpressionAttributeNames',
          'ExpressionAttributeValues',
        ],
      },
    },
  },
  '@aws-sdk/client-iot-data-plane': {
    client: 'IoTDataPlaneClient',
    commands: {
      PublishCommand: {
        required: ['topic'],
        optional: [
          'qos',
          'retain',
          'payload',
          'userProperties',
          'payloadFormatIndicator',
          'contentType',
          'responseTopic',
          'correlationData',
          'messageExpiry',
        ],
      },
    },
  },
  '@aws-sdk/client-iot-wireless': {
    client: 'IoTWirelessClient',
    commands: {
      GetPositionEstimateCommand: {
        required: [],
        optional: [
          'WiFiAccessPoints',
          'CellTowers',
          'Ip',
          'Gnss',
          'GnssMultiFrame',
          'Timestamp',
          'AdvancedConfiguration',
        ],
      },
    },
  },
  '@aws-sdk/client-sns': {
    client: 'SNSClient',
    commands: {
      ListSubscriptionsByTopicCommand: { required: ['TopicArn'], optional: ['NextToken'] },
      PublishCommand: {
        required: ['Message'],
        optional: [
          'TopicArn',
          'TargetArn',
          'PhoneNumber',
          'Subject',
          'MessageStructure',
          'MessageAttributes',
          'MessageDeduplicationId',
          'MessageGroupId',
        ],
      },
      SubscribeCommand: {
        required: ['TopicArn', 'Protocol'],
        optional: ['Endpoint', 'Attributes', 'ReturnSubscriptionArn'],
      },
      UnsubscribeCommand: { required: ['SubscriptionArn'], optional: [] },
    },
  },
};

const hooks = `
const REFERENCE = ${JSON.stringify(REFERENCE)};
const PREFIX = 'map-sdk-stand-in:';
export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(REFERENCE, specifier)) return { url: PREFIX + specifier, shortCircuit: true };
  if (specifier.startsWith('@aws-sdk/') || specifier.startsWith('@smithy/')) {
    throw new Error('The adapter may not import ' + specifier);
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith(PREFIX)) {
    const name = url.slice(PREFIX.length);
    const { client, commands } = REFERENCE[name];
    const lines = ['const hub = globalThis[Symbol.for("cranium.map-sdk-stand-in")];'];
    lines.push('export class ' + client + ' {');
    lines.push('  constructor(config) { hub.constructed(' + JSON.stringify(name) + ', config); }');
    lines.push('  send(command) { return hub.send(' + JSON.stringify(name) + ', command); }');
    lines.push('}');
    for (const command of Object.keys(commands)) {
      lines.push('export class ' + command + ' { constructor(input) { this.input = input; } }');
    }
    return { format: 'module', source: lines.join('\\n'), shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

const sdk = {
  clients: [],
  sent: [],
  replies: new Map(),
  reset() {
    this.sent.length = 0;
    this.replies.clear();
  },
  reply(key, ...answers) {
    const queue = this.replies.get(key) ?? [];
    queue.push(...answers);
    this.replies.set(key, queue);
  },
  inputs(key) {
    return this.sent.filter((entry) => entry.key === key).map((entry) => entry.input);
  },
};

/** Plain data without undefined members, as the SDK would serialize it. */
function serialized(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(serialized);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, serialized(entry)])
    );
  }
  return value;
}

globalThis[Symbol.for('cranium.map-sdk-stand-in')] = {
  constructed(name, config) {
    sdk.clients.push({ package: name, config });
  },
  async send(name, command) {
    const commandName = command.constructor.name;
    const spec = REFERENCE[name].commands[commandName];
    assert.ok(spec, `${commandName} is not a command of ${name}`);
    const input = serialized(command.input);
    for (const member of Object.keys(input)) {
      assert.ok(
        spec.required.includes(member) || spec.optional.includes(member),
        `${commandName} has no input member "${member}"`
      );
    }
    for (const member of spec.required) assert.ok(Object.hasOwn(input, member), `${commandName} needs "${member}"`);
    // Two packages have a PublishCommand: the key says which.
    const key = `${name.replace('@aws-sdk/client-', '')}:${commandName}`;
    sdk.sent.push({ key, input });
    const queue = sdk.replies.get(key) ?? [];
    assert.ok(queue.length > 0, `No reply prepared for ${key}`);
    const answer = queue.shift();
    return typeof answer === 'function' ? answer(input) : answer;
  },
};

function sdkError(name, status = 400) {
  const error = new Error(`${name} from the service`);
  error.name = name;
  error.$metadata = { httpStatusCode: status };
  return error;
}
const fails = (name, status) => () => {
  throw sdkError(name, status);
};

const { commandTopic, createAlertStore, createLocationStore, createMapAws } = await import('../src/aws-map.mjs');

const TOPIC = 'arn:aws:sns:us-east-1:000000000000:cranium-AlertTopic-ABC';
const ENV = Object.freeze({ AWS_REGION: 'us-east-1', EVENTS_TABLE: 'events-table', ALERT_TOPIC_ARN: TOPIC });
const THING = 'cranium-0123456789abcdef';

function fresh(make = createMapAws, env = ENV) {
  sdk.reset();
  return make(env);
}

async function rejectsWith(promise, { code, operation }) {
  await assert.rejects(promise, (error) => {
    assert.deepEqual([error.name, error.code, error.operation], ['AwsError', code, operation]);
    assert.equal(Object.hasOwn(error, '$metadata'), false);
    return true;
  });
}

test('each part reads only the environment it needs, and no client waits without a limit', () => {
  sdk.clients.length = 0;
  createMapAws(ENV);
  createAlertStore(ENV);
  createLocationStore({ AWS_REGION: 'us-east-1', EVENTS_TABLE: 'events-table' });
  for (const { config } of sdk.clients) {
    assert.equal(config.region, 'us-east-1');
    assert.equal(config.maxAttempts, 2);
    assert.deepEqual(config.requestHandler, {
      connectionTimeout: 1000,
      socketTimeout: 3000,
      requestTimeout: 4000,
      throwOnRequestTimeout: true,
    });
  }
  for (const name of Object.keys(ENV)) {
    assert.throws(() => createMapAws({ ...ENV, [name]: '' }), new RegExp(name));
    assert.throws(() => createAlertStore({ ...ENV, [name]: undefined }), new RegExp(name));
  }
  assert.throws(() => createLocationStore({ AWS_REGION: 'us-east-1' }), /EVENTS_TABLE/);
});

test('the adapter and the in-memory stand-in have the same methods', () => {
  const real = createMapAws(ENV);
  const fake = createFakeAws();
  assert.deepEqual(Object.keys(real).sort(), [
    'getLocation',
    'listAlertSubscriptions',
    'listLocations',
    'listSentAlerts',
    'publishCommand',
    'subscribeAlerts',
    'unsubscribeAlerts',
  ]);
  for (const method of Object.keys(real)) assert.equal(typeof fake[method], 'function', method);
  assert.deepEqual(Object.keys(createAlertStore(ENV)).sort(), Object.keys(fake.alertStore()).sort());
  assert.deepEqual(Object.keys(createLocationStore(ENV)).sort(), Object.keys(fake.locationStore()).sort());
});

test("a command is published with QoS 1 to the board's commands topic, as JSON", async () => {
  const aws = fresh();
  sdk.reply('iot-data-plane:PublishCommand', {});
  await aws.publishCommand({ thing: THING, payload: { id: '3f9c2a1b7d4e6f80', cmd: 'identify', seconds: 15 } });
  const [input] = sdk.inputs('iot-data-plane:PublishCommand');
  assert.equal(input.topic, `cranium/${THING}/commands`);
  assert.equal(commandTopic(THING), input.topic);
  assert.equal(input.qos, 1);
  assert.equal(input.contentType, 'application/json');
  assert.deepEqual(JSON.parse(Buffer.from(input.payload).toString('utf8')), {
    id: '3f9c2a1b7d4e6f80',
    cmd: 'identify',
    seconds: 15,
  });
  assert.equal(Object.hasOwn(input, 'retain'), false);
  sdk.reply('iot-data-plane:PublishCommand', fails('ThrottlingException', 429));
  await rejectsWith(aws.publishCommand({ thing: THING, payload: {} }), { code: 'throttled', operation: 'Publish' });
});

test('positions are read from their own partition, consistently, every page', async () => {
  const aws = fresh();
  sdk.reply(
    'dynamodb:QueryCommand',
    {
      Items: [{ pk: { S: 'LOC' }, sk: { S: THING }, rev: { N: '3' }, position: { M: { lat: { N: '39.95' } } } }],
      LastEvaluatedKey: { pk: { S: 'LOC' } },
    },
    { Items: [] }
  );
  const items = await aws.listLocations();
  assert.deepEqual(items, [{ pk: 'LOC', sk: THING, rev: 3, position: { lat: 39.95 } }]);
  const [first, second] = sdk.inputs('dynamodb:QueryCommand');
  assert.deepEqual(
    [first.KeyConditionExpression, first.ExpressionAttributeValues, first.ConsistentRead],
    ['#pk = :pk', { ':pk': { S: 'LOC' } }, true]
  );
  assert.deepEqual(second.ExclusiveStartKey, { pk: { S: 'LOC' } });

  sdk.reply('dynamodb:QueryCommand', { Items: [] });
  assert.equal(await aws.getLocation(THING), null);
  const [one] = sdk.inputs('dynamodb:QueryCommand').slice(-1);
  assert.equal(one.KeyConditionExpression, '#pk = :pk AND #sk = :sk');
  assert.deepEqual(one.ExpressionAttributeValues, { ':pk': { S: 'LOC' }, ':sk': { S: THING } });

  sdk.reply('dynamodb:QueryCommand', { Items: [] });
  await aws.listSentAlerts({ limit: 20 });
  const [sent] = sdk.inputs('dynamodb:QueryCommand').slice(-1);
  assert.deepEqual(
    [sent.KeyConditionExpression, sent.Limit, sent.ScanIndexForward],
    ['#pk = :pk AND begins_with(#sk, :prefix)', 20, false]
  );
  assert.deepEqual(sent.ExpressionAttributeValues, { ':pk': { S: 'ALERTS' }, ':prefix': { S: 'S#' } });
});

test('subscriptions: only e-mail, the confirmed ones by their ARN, the pending ones without', async () => {
  const aws = fresh();
  sdk.reply(
    'sns:ListSubscriptionsByTopicCommand',
    {
      Subscriptions: [{ SubscriptionArn: `${TOPIC}:1111`, Protocol: 'email', Endpoint: 'a@example.invalid' }],
      NextToken: 'next',
    },
    {
      Subscriptions: [
        { SubscriptionArn: 'PendingConfirmation', Protocol: 'email', Endpoint: 'b@example.invalid' },
        { Protocol: 'sqs' },
      ],
    }
  );
  assert.deepEqual(await aws.listAlertSubscriptions(), [
    { arn: `${TOPIC}:1111`, endpoint: 'a@example.invalid', protocol: 'email' },
    { arn: null, endpoint: 'b@example.invalid', protocol: 'email' },
  ]);
  assert.deepEqual(sdk.inputs('sns:ListSubscriptionsByTopicCommand'), [
    { TopicArn: TOPIC },
    { TopicArn: TOPIC, NextToken: 'next' },
  ]);

  sdk.reply('sns:SubscribeCommand', { SubscriptionArn: 'pending confirmation' }, { SubscriptionArn: `${TOPIC}:2222` });
  assert.deepEqual(await aws.subscribeAlerts('c@example.invalid'), { pending: true });
  assert.deepEqual(await aws.subscribeAlerts('a@example.invalid'), { pending: false });
  assert.deepEqual(sdk.inputs('sns:SubscribeCommand')[0], {
    TopicArn: TOPIC,
    Protocol: 'email',
    Endpoint: 'c@example.invalid',
  });

  sdk.reply('sns:UnsubscribeCommand', {}, fails('NotFoundException', 404), fails('AuthorizationErrorException', 403));
  assert.deepEqual(await aws.unsubscribeAlerts(`${TOPIC}:1111`), { ok: true });
  assert.deepEqual(sdk.inputs('sns:UnsubscribeCommand')[0], { SubscriptionArn: `${TOPIC}:1111` });
  assert.deepEqual(await aws.unsubscribeAlerts(`${TOPIC}:1111`), { ok: false, reason: 'not_found' });
  await rejectsWith(aws.unsubscribeAlerts(`${TOPIC}:1111`), { code: 'failed', operation: 'Unsubscribe' });
});

test('the alert store writes only over the item it read, and publishes plain text to the topic', async () => {
  const store = fresh(createAlertStore);
  sdk.reply('dynamodb:PutItemCommand', {}, fails('ConditionalCheckFailedException'), {});
  assert.deepEqual(await store.putAlertItem({ pk: 'ALERTS', sk: `B#${THING}`, rev: 1 }, 0), { ok: true });
  assert.deepEqual(await store.putAlertItem({ pk: 'ALERTS', sk: `B#${THING}`, rev: 2 }, 1), {
    ok: false,
    reason: 'conflict',
  });
  await store.putSentAlert({ pk: 'ALERTS', sk: 'S#x', kind: 'offline' });
  const [created, changed, sent] = sdk.inputs('dynamodb:PutItemCommand');
  assert.deepEqual(
    [created.ConditionExpression, created.ExpressionAttributeNames],
    ['attribute_not_exists(#pk)', { '#pk': 'pk' }]
  );
  assert.deepEqual(
    [changed.ConditionExpression, changed.ExpressionAttributeNames, changed.ExpressionAttributeValues],
    ['#rev = :rev', { '#rev': 'rev' }, { ':rev': { N: '1' } }]
  );
  assert.equal(Object.hasOwn(sent, 'ConditionExpression'), false);

  sdk.reply('dynamodb:QueryCommand', { Items: [{ pk: { S: 'ALERTS' }, sk: { S: `B#${THING}` } }] }, { Items: [] });
  assert.equal((await store.listAlertItems()).length, 1);
  assert.deepEqual(
    sdk.inputs('dynamodb:QueryCommand').map((input) => input.ExpressionAttributeValues[':prefix'].S),
    ['B#', 'D#']
  );

  sdk.reply('sns:PublishCommand', {});
  await store.publishAlert({ subject: 'Cranium: CRVIHAAN01 is offline', message: 'text' });
  assert.deepEqual(sdk.inputs('sns:PublishCommand'), [
    { TopicArn: TOPIC, Subject: 'Cranium: CRVIHAAN01 is offline', Message: 'text' },
  ]);
});

test('GetPositionEstimate gets the Wi-Fi access points and gives back its GeoJSON; a 404 is no position', async () => {
  const store = fresh(createLocationStore);
  const geoJson =
    '{"coordinates":[13.376077,52.51823,80.1],"type":"Point","properties":{"horizontalAccuracy":303,"horizontalConfidenceLevel":0.68}}';
  sdk.reply(
    'iot-wireless:GetPositionEstimateCommand',
    { GeoJsonPayload: new TextEncoder().encode(geoJson) },
    fails('ResourceNotFoundException', 404),
    fails('ThrottlingException', 429),
    fails('AccessDeniedException', 403)
  );
  const request = {
    WiFiAccessPoints: [
      { MacAddress: 'a4:2b:b0:12:34:56', Rss: -51 },
      { MacAddress: 'f0:9f:c2:65:43:21', Rss: -70 },
    ],
  };
  assert.deepEqual(await store.solvePosition(request), { found: true, geoJson });
  assert.deepEqual(sdk.inputs('iot-wireless:GetPositionEstimateCommand'), [request]);
  assert.deepEqual(await store.solvePosition(request), { found: false });
  await rejectsWith(store.solvePosition(request), { code: 'throttled', operation: 'GetPositionEstimate' });
  await rejectsWith(store.solvePosition(request), { code: 'failed', operation: 'GetPositionEstimate' });
});
