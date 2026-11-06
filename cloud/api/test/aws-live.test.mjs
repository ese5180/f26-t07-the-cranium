// Tests for the AWS adapter of the live function (src/aws-live.mjs, docs/live.md): the connections, who
// owns which board, the sockets, and the account check.
//
// As in aws-memfault.test.mjs, the SDK is not installed here: the three packages the adapter imports are
// replaced, through a module loader hook, by stand-ins that record every command and hold the adapter to
// the SDK's input members (taken from the command sources of the AWS SDK for JavaScript v3, 3.1149.0). What
// these cannot show is that AWS behaves as the replies assume: the shapes are those of the API references
// of the API Gateway management API, Cognito and DynamoDB.

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

const REFERENCE = {
  '@aws-sdk/client-apigatewaymanagementapi': {
    client: 'ApiGatewayManagementApiClient',
    commands: {
      PostToConnectionCommand: { required: ['Data', 'ConnectionId'], optional: [] },
      DeleteConnectionCommand: { required: ['ConnectionId'], optional: [] },
    },
  },
  '@aws-sdk/client-cognito-identity-provider': {
    client: 'CognitoIdentityProviderClient',
    commands: {
      AdminGetUserCommand: { required: ['UserPoolId', 'Username'], optional: [] },
      AdminListGroupsForUserCommand: { required: ['Username', 'UserPoolId'], optional: ['Limit', 'NextToken'] },
    },
  },
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
      DeleteItemCommand: {
        required: ['TableName', 'Key'],
        optional: [
          'Expected',
          'ConditionalOperator',
          'ReturnValues',
          'ReturnConsumedCapacity',
          'ReturnItemCollectionMetrics',
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
      ScanCommand: {
        required: ['TableName'],
        optional: [
          'IndexName',
          'AttributesToGet',
          'Limit',
          'Select',
          'ScanFilter',
          'ConditionalOperator',
          'ExclusiveStartKey',
          'ReturnConsumedCapacity',
          'TotalSegments',
          'Segment',
          'ProjectionExpression',
          'FilterExpression',
          'ExpressionAttributeNames',
          'ExpressionAttributeValues',
          'ConsistentRead',
        ],
      },
    },
  },
};

const hooks = `
const REFERENCE = ${JSON.stringify(REFERENCE)};
const PREFIX = 'live-sdk-stand-in:';
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
    const lines = ['const hub = globalThis[Symbol.for("cranium.live-sdk-stand-in")];'];
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

globalThis[Symbol.for('cranium.live-sdk-stand-in')] = {
  constructed(name, config) {
    sdk.clients.push({ package: name, config });
  },
  async send(name, command) {
    const commandName = command.constructor.name;
    const spec = REFERENCE[name].commands[commandName];
    assert.ok(spec, `${commandName} is not a command of ${name}`);
    const input = Object.fromEntries(Object.entries(command.input).filter(([, value]) => value !== undefined));
    for (const member of Object.keys(input)) {
      assert.ok(
        spec.required.includes(member) || spec.optional.includes(member),
        `${commandName} has no input member "${member}"`
      );
    }
    for (const member of spec.required) assert.ok(Object.hasOwn(input, member), `${commandName} needs "${member}"`);
    const key = `${name.replace('@aws-sdk/client-', '')}:${commandName.replace(/Command$/, '')}`;
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

const { createAccountCheck, createLiveStore, createSockets } = await import('../src/aws-live.mjs');

const ENV = Object.freeze({
  AWS_REGION: 'us-east-1',
  CONNECTIONS_TABLE: 'cranium-ota-ConnectionsTable-1',
  STATE_TABLE: 'cranium-ota-StateTable-1',
  LIVE_CALLBACK_URL: 'https://abc123def4.execute-api.us-east-1.amazonaws.com/live',
  USER_POOL_ID: 'us-east-1_Team12345',
  CUSTOMER_POOL_ID: 'us-east-1_Cust12345',
});
const A = 'cranium-0123456789abcdef';
const B = 'cranium-fedcba9876543210';
const SUB = 'aaaaaaaa-0000-0000-0000-000000000001';

async function rejectsWith(promise, { code, operation }) {
  await assert.rejects(promise, (error) => {
    assert.deepEqual([error.name, error.code, error.operation], ['AwsError', code, operation]);
    return true;
  });
}

test('each part reads only the environment it needs, and no client waits without a limit', () => {
  sdk.clients.length = 0;
  createLiveStore(ENV);
  createSockets(ENV);
  createAccountCheck(ENV);
  assert.deepEqual(sdk.clients.map((client) => client.package).sort(), [
    '@aws-sdk/client-apigatewaymanagementapi',
    '@aws-sdk/client-cognito-identity-provider',
    '@aws-sdk/client-dynamodb',
  ]);
  for (const { config } of sdk.clients) {
    assert.equal(config.region, 'us-east-1');
    assert.equal(config.maxAttempts, 2);
    assert.equal(config.requestHandler.requestTimeout, 4000);
    assert.equal(config.requestHandler.throwOnRequestTimeout, true);
  }
  assert.equal(
    sdk.clients.find((client) => client.package.endsWith('apigatewaymanagementapi')).config.endpoint,
    ENV.LIVE_CALLBACK_URL
  );
  for (const [make, names] of [
    [createLiveStore, ['AWS_REGION', 'CONNECTIONS_TABLE', 'STATE_TABLE']],
    [createSockets, ['AWS_REGION', 'LIVE_CALLBACK_URL']],
    [createAccountCheck, ['AWS_REGION', 'USER_POOL_ID']],
  ]) {
    for (const name of names) assert.throws(() => make({ ...ENV, [name]: '' }), new RegExp(name));
  }
  // Only API Gateway's own address for its management API.
  for (const url of [
    'https://example.org/live',
    'http://abc123def4.execute-api.us-east-1.amazonaws.com/live',
    'wss://abc123def4.execute-api.us-east-1.amazonaws.com/live',
  ]) {
    assert.throws(() => createSockets({ ...ENV, LIVE_CALLBACK_URL: url }), /LIVE_CALLBACK_URL/);
  }
});

test('a connection is put with its time and the time DynamoDB lets it go, deleted by its id, and every one is read', async () => {
  sdk.reset();
  const store = createLiveStore(ENV);
  sdk.reply('dynamodb:PutItem', {});
  await store.putConnection({ connectionId: 'abc=', audience: 'team', sub: SUB, until: 1_800_000_000 });
  assert.deepEqual(sdk.inputs('dynamodb:PutItem'), [
    {
      TableName: ENV.CONNECTIONS_TABLE,
      Item: {
        connectionId: { S: 'abc=' },
        audience: { S: 'team' },
        sub: { S: SUB },
        until: { N: '1800000000' },
        ttl: { N: '1800003600' },
      },
    },
  ]);
  await assert.rejects(store.putConnection({ connectionId: 'abc', audience: 'admin', sub: SUB, until: 1 }), TypeError);

  sdk.reply('dynamodb:DeleteItem', {});
  await store.deleteConnection('abc=');
  assert.deepEqual(sdk.inputs('dynamodb:DeleteItem'), [
    { TableName: ENV.CONNECTIONS_TABLE, Key: { connectionId: { S: 'abc=' } } },
  ]);

  const item = (id, audience = 'team') => ({
    connectionId: { S: id },
    audience: { S: audience },
    sub: { S: SUB },
    until: { N: '1800000000' },
    ttl: { N: '1800003600' },
  });
  sdk.reply(
    'dynamodb:Scan',
    { Items: [item('one'), { connectionId: { S: 'broken' } }], LastEvaluatedKey: { connectionId: { S: 'one' } } },
    { Items: [item('two', 'customer'), item('three', 'admin')] }
  );
  assert.deepEqual(await store.listConnections(), [
    { connectionId: 'one', audience: 'team', sub: SUB, until: 1_800_000_000 },
    { connectionId: 'two', audience: 'customer', sub: SUB, until: 1_800_000_000 },
  ]);
  assert.deepEqual(sdk.inputs('dynamodb:Scan'), [
    { TableName: ENV.CONNECTIONS_TABLE },
    { TableName: ENV.CONNECTIONS_TABLE, ExclusiveStartKey: { connectionId: { S: 'one' } } },
  ]);
  sdk.reply('dynamodb:Scan', fails('ProvisionedThroughputExceededException'));
  await rejectsWith(store.listConnections(), { code: 'failed', operation: 'Scan' });
  sdk.reply('dynamodb:Scan', fails('ThrottlingException'));
  await rejectsWith(store.listConnections(), { code: 'throttled', operation: 'Scan' });
});

test('the owners are the owned boards of the state table, read consistently; a board nobody owns has none', async () => {
  sdk.reset();
  const store = createLiveStore(ENV);
  sdk.reply('dynamodb:Query', {
    Items: [
      { pk: { S: 'OWN' }, sk: { S: A }, owner: { S: SUB }, ref: { S: '0a1b2c3d4e5f6071' } },
      {
        pk: { S: 'OWN' },
        sk: { S: B },
        ref: { S: '1111222233334444' },
        unassignedAt: { S: '2026-11-01T00:00:00.000Z' },
      },
      { pk: { S: 'OWN' }, sk: { S: 'not-a-board' }, owner: { S: SUB }, ref: { S: '2222333344445555' } },
      { pk: { S: 'OWN' }, sk: { S: 'cranium-1111222233334444' }, owner: { S: SUB }, ref: { S: 'no ref' } },
    ],
  });
  assert.deepEqual([...(await store.listOwners())], [[A, { owner: SUB, ref: '0a1b2c3d4e5f6071' }]]);
  assert.deepEqual(sdk.inputs('dynamodb:Query'), [
    {
      TableName: ENV.STATE_TABLE,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': { S: 'OWN' } },
      ConsistentRead: true,
    },
  ]);
});

test('a message is posted to its connection; one that is gone says so, and closing one that is gone is no failure', async () => {
  sdk.reset();
  const sockets = createSockets(ENV);
  sdk.reply(
    'apigatewaymanagementapi:PostToConnection',
    {},
    fails('GoneException', 410),
    fails('ForbiddenException', 403)
  );
  assert.equal(await sockets.send('abc=', '{"type":"changed"}'), 'sent');
  assert.equal(await sockets.send('abc=', '{}'), 'gone');
  await rejectsWith(sockets.send('abc=', '{}'), { code: 'failed', operation: 'PostToConnection' });
  const [first] = sdk.inputs('apigatewaymanagementapi:PostToConnection');
  assert.equal(first.ConnectionId, 'abc=');
  assert.equal(Buffer.from(first.Data).toString('utf8'), '{"type":"changed"}');
  sdk.reply(
    'apigatewaymanagementapi:DeleteConnection',
    {},
    fails('GoneException', 410),
    fails('LimitExceededException', 429)
  );
  await sockets.close('abc=');
  await sockets.close('abc=');
  await rejectsWith(sockets.close('abc='), { code: 'throttled', operation: 'DeleteConnection' });
});

test('a member of the team may connect while enabled, confirmed and in a group of the console; a customer while enabled and confirmed', async () => {
  sdk.reset();
  const accounts = createAccountCheck(ENV);
  const user = (Enabled, UserStatus) => ({ Enabled, UserStatus });
  sdk.reply('cognito-identity-provider:AdminGetUser', user(true, 'CONFIRMED'));
  sdk.reply(
    'cognito-identity-provider:AdminListGroupsForUser',
    { Groups: [{ GroupName: 'other' }], NextToken: 'next' },
    { Groups: [{ GroupName: 'viewers' }] }
  );
  assert.equal(await accounts.teamMember(SUB), true);
  assert.deepEqual(sdk.inputs('cognito-identity-provider:AdminListGroupsForUser'), [
    { UserPoolId: ENV.USER_POOL_ID, Username: SUB, Limit: 60 },
    { UserPoolId: ENV.USER_POOL_ID, Username: SUB, Limit: 60, NextToken: 'next' },
  ]);
  sdk.reply('cognito-identity-provider:AdminGetUser', user(true, 'CONFIRMED'));
  sdk.reply('cognito-identity-provider:AdminListGroupsForUser', { Groups: [] });
  assert.equal(await accounts.teamMember(SUB), false, 'in no group of the console');
  sdk.reply('cognito-identity-provider:AdminGetUser', user(false, 'CONFIRMED'));
  assert.equal(await accounts.teamMember(SUB), false, 'disabled: the groups are not asked');
  sdk.reply('cognito-identity-provider:AdminGetUser', fails('UserNotFoundException'));
  assert.equal(await accounts.teamMember(SUB), false);
  sdk.reply('cognito-identity-provider:AdminGetUser', fails('InternalErrorException', 500));
  await rejectsWith(accounts.teamMember(SUB), { code: 'failed', operation: 'AdminGetUser' });

  sdk.reply('cognito-identity-provider:AdminGetUser', user(true, 'CONFIRMED'), user(true, 'FORCE_CHANGE_PASSWORD'));
  assert.equal(await accounts.customer(SUB), true);
  assert.equal(await accounts.customer(SUB), false);
  assert.deepEqual(
    sdk
      .inputs('cognito-identity-provider:AdminGetUser')
      .slice(-2)
      .map((input) => input.UserPoolId),
    [ENV.CUSTOMER_POOL_ID, ENV.CUSTOMER_POOL_ID]
  );
  assert.equal(await accounts.teamMember('has spaces'), false);
  // Without a customer pool, no customer.
  assert.equal(await createAccountCheck({ ...ENV, CUSTOMER_POOL_ID: '' }).customer(SUB), false);
});
