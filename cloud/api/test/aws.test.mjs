// Tests for the AWS adapter (src/aws.mjs).
//
// The AWS SDK is not installed where these tests run: the Lambda runtime provides it.
// So that the adapter can be executed anyway, the five SDK packages it imports are
// replaced here, through a module loader hook, by stand-ins that record every command
// and answer with replies the test prepared. The stand-ins also hold the adapter to the
// SDK's reference: REFERENCE below lists, for every command the adapter may send, the
// input members of the AWS SDK for JavaScript v3 (taken from the command sources of
// version 3.1149.0). A command that is not listed, a member that does not exist, or a
// missing required member fails the test.
//
// What these tests cannot show is that AWS behaves as the replies assume. That is what
// the first deployment's smoke test is for.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { test } from 'node:test';

import { accessClaims, apiEvent, createFakeAws, fakeEnv } from './fake-aws.mjs';
import { PROVISION_COMMANDS } from './provision-sdk.mjs';

const REFERENCE = {
  '@aws-sdk/client-cognito-identity-provider': {
    client: 'CognitoIdentityProviderClient',
    commands: {
      AdminGetUserCommand: {
        required: ['UserPoolId', 'Username'],
        optional: [],
      },
      AdminListGroupsForUserCommand: {
        required: ['Username', 'UserPoolId'],
        optional: ['Limit', 'NextToken'],
      },
      // The customer pool's (src/customer/aws.mjs).
      AdminCreateUserCommand: {
        required: ['UserPoolId', 'Username'],
        optional: [
          'UserAttributes',
          'ValidationData',
          'TemporaryPassword',
          'ForceAliasCreation',
          'MessageAction',
          'DesiredDeliveryMediums',
          'ClientMetadata',
        ],
      },
      AdminDisableUserCommand: {
        required: ['UserPoolId', 'Username'],
        optional: [],
      },
      AdminEnableUserCommand: {
        required: ['UserPoolId', 'Username'],
        optional: [],
      },
      ListUsersCommand: {
        required: ['UserPoolId'],
        optional: ['AttributesToGet', 'Limit', 'PaginationToken', 'Filter'],
      },
      // The Team page's (src/aws-team.mjs), and a customer's reset and removal (src/customer/aws.mjs).
      AdminAddUserToGroupCommand: {
        required: ['UserPoolId', 'Username', 'GroupName'],
        optional: [],
      },
      AdminRemoveUserFromGroupCommand: {
        required: ['UserPoolId', 'Username', 'GroupName'],
        optional: [],
      },
      AdminUserGlobalSignOutCommand: {
        required: ['UserPoolId', 'Username'],
        optional: [],
      },
      AdminDeleteUserCommand: {
        required: ['UserPoolId', 'Username'],
        optional: [],
      },
      AdminResetUserPasswordCommand: {
        required: ['UserPoolId', 'Username'],
        optional: ['ClientMetadata'],
      },
    },
  },
  '@aws-sdk/client-dynamodb': {
    client: 'DynamoDBClient',
    commands: {
      GetItemCommand: {
        required: ['TableName', 'Key'],
        optional: [
          'AttributesToGet',
          'ConsistentRead',
          'ReturnConsumedCapacity',
          'ProjectionExpression',
          'ExpressionAttributeNames',
        ],
      },
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
      TransactWriteItemsCommand: {
        required: ['TransactItems'],
        optional: ['ReturnConsumedCapacity', 'ReturnItemCollectionMetrics', 'ClientRequestToken'],
      },
      UpdateItemCommand: {
        required: ['TableName', 'Key'],
        optional: [
          'AttributeUpdates',
          'Expected',
          'ConditionalOperator',
          'ReturnValues',
          'ReturnConsumedCapacity',
          'ReturnItemCollectionMetrics',
          'UpdateExpression',
          'ConditionExpression',
          'ExpressionAttributeNames',
          'ExpressionAttributeValues',
          'ReturnValuesOnConditionCheckFailure',
        ],
      },
    },
  },
  '@aws-sdk/client-iot': {
    client: 'IoTClient',
    commands: {
      CancelJobCommand: {
        required: ['jobId'],
        optional: ['reasonCode', 'comment', 'force'],
      },
      CreateJobCommand: {
        required: ['jobId', 'targets'],
        optional: [
          'documentSource',
          'document',
          'description',
          'presignedUrlConfig',
          'targetSelection',
          'jobExecutionsRolloutConfig',
          'abortConfig',
          'timeoutConfig',
          'tags',
          'namespaceId',
          'jobTemplateArn',
          'jobExecutionsRetryConfig',
          'documentParameters',
          'schedulingConfig',
          'destinationPackageVersions',
        ],
      },
      DescribeJobCommand: {
        required: ['jobId'],
        optional: ['beforeSubstitution'],
      },
      DescribeJobExecutionCommand: {
        required: ['jobId', 'thingName'],
        optional: ['executionNumber'],
      },
      // A board's attributes, for its type (handlers/fleet.mjs).
      DescribeThingCommand: {
        required: ['thingName'],
        optional: [],
      },
      ListJobExecutionsForJobCommand: {
        required: ['jobId'],
        optional: ['status', 'maxResults', 'nextToken'],
      },
      ListJobExecutionsForThingCommand: {
        required: ['thingName'],
        optional: ['status', 'namespaceId', 'maxResults', 'nextToken', 'jobId'],
      },
      ListJobsCommand: {
        required: [],
        optional: [
          'status',
          'targetSelection',
          'maxResults',
          'nextToken',
          'thingGroupName',
          'thingGroupId',
          'namespaceId',
        ],
      },
      ListThingPrincipalsCommand: {
        required: ['thingName'],
        optional: ['nextToken', 'maxResults'],
      },
      ListThingsInThingGroupCommand: {
        required: ['thingGroupName'],
        optional: ['recursive', 'nextToken', 'maxResults'],
      },
    },
  },
  '@aws-sdk/client-iot-data-plane': {
    client: 'IoTDataPlaneClient',
    commands: {
      GetThingShadowCommand: {
        required: ['thingName'],
        optional: ['shadowName'],
      },
      // src/aws-map.mjs: a command to a board (map-aws.test.mjs tests it).
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
  '@aws-sdk/client-s3': {
    client: 'S3Client',
    commands: {
      PutObjectCommand: {
        required: ['Bucket', 'Key'],
        optional: [
          'ACL',
          'Body',
          'CacheControl',
          'ContentDisposition',
          'ContentEncoding',
          'ContentLanguage',
          'ContentLength',
          'ContentMD5',
          'ContentType',
          'ChecksumAlgorithm',
          'ChecksumCRC32',
          'ChecksumCRC32C',
          'ChecksumCRC64NVME',
          'ChecksumSHA1',
          'ChecksumSHA256',
          'ChecksumSHA512',
          'ChecksumMD5',
          'ChecksumXXHASH64',
          'ChecksumXXHASH3',
          'ChecksumXXHASH128',
          'Expires',
          'IfMatch',
          'IfNoneMatch',
          'GrantFullControl',
          'GrantRead',
          'GrantReadACP',
          'GrantWriteACP',
          'WriteOffsetBytes',
          'Metadata',
          'ServerSideEncryption',
          'StorageClass',
          'WebsiteRedirectLocation',
          'SSECustomerAlgorithm',
          'SSECustomerKey',
          'SSECustomerKeyMD5',
          'SSEKMSKeyId',
          'SSEKMSEncryptionContext',
          'BucketKeyEnabled',
          'RequestPayer',
          'Tagging',
          'ObjectLockMode',
          'ObjectLockRetainUntilDate',
          'ObjectLockLegalHoldStatus',
          'ObjectLockEventHold',
          'ObjectLockEventHoldDurationDays',
          'ObjectLockEventHoldDurationYears',
          'ExpectedBucketOwner',
        ],
      },
      PutObjectTaggingCommand: {
        required: ['Bucket', 'Key'],
        optional: ['VersionId', 'ContentMD5', 'ChecksumAlgorithm', 'Tagging', 'ExpectedBucketOwner', 'RequestPayer'],
      },
      GetObjectCommand: {
        required: ['Bucket', 'Key'],
        optional: [
          'IfMatch',
          'IfModifiedSince',
          'IfNoneMatch',
          'IfUnmodifiedSince',
          'Range',
          'ResponseCacheControl',
          'ResponseContentDisposition',
          'ResponseContentEncoding',
          'ResponseContentLanguage',
          'ResponseContentType',
          'ResponseExpires',
          'VersionId',
          'SSECustomerAlgorithm',
          'SSECustomerKey',
          'SSECustomerKeyMD5',
          'RequestPayer',
          'PartNumber',
          'ExpectedBucketOwner',
          'ChecksumMode',
        ],
      },
      // The check of an APK that arrived (src/aws-apps.mjs, which index.mjs loads too; apps-aws.test.mjs).
      HeadObjectCommand: {
        required: ['Bucket', 'Key'],
        optional: [
          'IfMatch',
          'IfModifiedSince',
          'IfNoneMatch',
          'IfUnmodifiedSince',
          'Range',
          'ResponseCacheControl',
          'ResponseContentDisposition',
          'ResponseContentEncoding',
          'ResponseContentLanguage',
          'ResponseContentType',
          'ResponseExpires',
          'VersionId',
          'SSECustomerAlgorithm',
          'SSECustomerKey',
          'SSECustomerKeyMD5',
          'RequestPayer',
          'PartNumber',
          'ExpectedBucketOwner',
          'ChecksumMode',
        ],
      },
    },
  },
};

// The two packages only src/aws-map.mjs imports, which the entry points load too. They are stand-ins
// here so that the entry points can be loaded; map-aws.test.mjs holds that adapter to them.
const MAP_PACKAGES = {
  '@aws-sdk/client-sns': {
    client: 'SNSClient',
    commands: {
      ListSubscriptionsByTopicCommand: { required: ['TopicArn'], optional: ['NextToken'] },
      PublishCommand: { required: ['Message'], optional: ['TopicArn', 'Subject'] },
      SubscribeCommand: {
        required: ['TopicArn', 'Protocol'],
        optional: ['Endpoint', 'Attributes', 'ReturnSubscriptionArn'],
      },
      UnsubscribeCommand: { required: ['SubscriptionArn'], optional: [] },
    },
  },
  '@aws-sdk/client-iot-wireless': {
    client: 'IoTWirelessClient',
    commands: { GetPositionEstimateCommand: { required: [], optional: ['WiFiAccessPoints'] } },
  },
  // And the one only src/aws-memfault.mjs imports, whose API part index.mjs loads (aws-memfault.test.mjs).
  '@aws-sdk/client-secrets-manager': {
    client: 'SecretsManagerClient',
    commands: {
      GetSecretValueCommand: { required: ['SecretId'], optional: ['VersionId', 'VersionStage'] },
      DescribeSecretCommand: { required: ['SecretId'], optional: [] },
    },
  },
};

// The commands only src/aws-provision.mjs sends, which index.mjs loads too (provision-aws.test.mjs).
Object.assign(REFERENCE['@aws-sdk/client-iot'].commands, PROVISION_COMMANDS);

const hooks = `
const REFERENCE = ${JSON.stringify({ ...REFERENCE, ...MAP_PACKAGES })};
const PREFIX = 'sdk-stand-in:';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@aws-sdk/client-s3/package.json') {
    return { url: PREFIX + 'version', importAttributes: context.importAttributes, shortCircuit: true };
  }
  if (Object.hasOwn(REFERENCE, specifier)) {
    return { url: PREFIX + specifier, shortCircuit: true };
  }
  if (specifier.startsWith('@aws-sdk/') || specifier.startsWith('@smithy/')) {
    throw new Error('The adapter may not import ' + specifier);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === PREFIX + 'version') {
    return { format: 'json', source: '{"version":"3.0.0-stand-in"}', shortCircuit: true };
  }
  if (url.startsWith(PREFIX)) {
    const name = url.slice(PREFIX.length);
    const { client, commands } = REFERENCE[name];
    const lines = ['const hub = globalThis[Symbol.for("cranium.sdk-stand-in")];'];
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

/** Plain data without undefined members, as the SDK would serialize it. */
function serialized(value) {
  if (value instanceof Uint8Array || value instanceof Date) return value;
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

const sdk = {
  clients: [],
  sent: [],
  replies: new Map(),

  reset() {
    this.sent.length = 0;
    this.replies.clear();
  },

  /** Prepare the answers to the next calls of a command: values, or functions of the input. */
  reply(command, ...answers) {
    const queue = this.replies.get(command) ?? [];
    queue.push(...answers);
    this.replies.set(command, queue);
  },

  inputs(command) {
    return this.sent.filter((entry) => entry.command === command).map((entry) => entry.input);
  },
};

globalThis[Symbol.for('cranium.sdk-stand-in')] = {
  constructed(name, config) {
    sdk.clients.push({ package: name, config });
  },
  async send(name, command) {
    const commandName = command.constructor.name;
    const spec = (REFERENCE[name] ?? MAP_PACKAGES[name]).commands[commandName];
    assert.ok(spec, `${commandName} is not a command of ${name} in the reference`);
    const input = serialized(command.input);
    for (const member of Object.keys(input)) {
      assert.ok(
        spec.required.includes(member) || spec.optional.includes(member),
        `${commandName} has no input member "${member}"`
      );
    }
    for (const member of spec.required) {
      assert.ok(Object.hasOwn(input, member), `${commandName} needs "${member}"`);
    }
    sdk.sent.push({ package: name, command: commandName, input });
    const queue = sdk.replies.get(commandName) ?? [];
    assert.ok(queue.length > 0, `No reply prepared for ${commandName}`);
    const answer = queue.shift();
    return typeof answer === 'function' ? answer(input) : answer;
  },
};

/** An exception as the SDK throws it. */
function sdkError(name, { status = 400, message = `${name} from the service`, ...extra } = {}) {
  const error = new Error(message);
  error.name = name;
  error.$fault = status >= 500 ? 'server' : 'client';
  error.$metadata = { httpStatusCode: status, requestId: 'SDK-REQUEST-ID', attempts: 1 };
  Object.assign(error, extra);
  return error;
}

const fails = (name, options) => () => {
  throw sdkError(name, options);
};

const ENV = Object.freeze({
  AWS_REGION: 'eu-west-1',
  STATE_TABLE: 'state-table',
  AUDIT_TABLE: 'audit-table',
  EVENTS_TABLE: 'events-table',
  FIRMWARE_BUCKET: 'firmware-bucket',
  THING_GROUP: 'cranium-devices',
  PRESIGN_ROLE_ARN: 'arn:aws:iam::000000000000:role/presign-role',
  USER_POOL_ID: 'eu-west-1_Pool',
});

const THING = 'cranium-00000000000000aa';
const THING_ARN = `arn:aws:iot:eu-west-1:000000000000:thing/${THING}`;
const JOB = 'cranium-1-2-3-b4-20261010T221500Z-9f3a';
const T0 = Date.UTC(2026, 9, 10, 22, 15, 0);

// The adapter logs the SDK version when it is loaded. It reads the version from the
// SDK's package.json; Node 22 before 22.12 announces that kind of import as
// experimental, which says nothing about the code under test.
const startup = [];
const realLog = console.log;
const realWarning = process.emitWarning;
console.log = (line) => startup.push(line);
process.emitWarning = (warning, ...rest) => {
  if (!String(warning).includes('Importing JSON modules')) realWarning.call(process, warning, ...rest);
};
const { createAws, createEventStore } = await import('../src/aws.mjs');
console.log = realLog;
process.emitWarning = realWarning;

function adapter(env = ENV) {
  sdk.reset();
  return createAws(env);
}

/** Expect a rejection with the adapter's own error, never the SDK's. */
async function rejectsWith(promise, { code, operation, awsError }) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'AwsError');
    assert.equal(Object.getPrototypeOf(error), Error.prototype);
    assert.equal(error.code, code);
    assert.equal(error.operation, operation);
    if (awsError !== undefined) assert.equal(error.awsError, awsError);
    assert.equal(error.cause, undefined);
    assert.equal(Object.hasOwn(error, '$metadata'), false);
    return true;
  });
}

test('the SDK version is logged once when the module is loaded', () => {
  assert.equal(startup.length, 1);
  const line = JSON.parse(startup[0]);
  assert.deepEqual(Object.keys(line), ['event', 'sdkVersion', 'node']);
  assert.equal(line.event, 'cold_start');
  assert.equal(line.sdkVersion, '3.0.0-stand-in');
  assert.equal(line.node, process.version);
});

test("one client per service is created for the function's region", () => {
  sdk.clients.length = 0;
  createAws(ENV);
  assert.deepEqual(sdk.clients.map((client) => client.package).sort(), Object.keys(REFERENCE).sort());
  for (const client of sdk.clients) assert.equal(client.config.region, 'eu-west-1');

  for (const name of Object.keys(ENV)) {
    assert.throws(() => createAws({ ...ENV, [name]: undefined }), new RegExp(name));
    assert.throws(() => createAws({ ...ENV, [name]: '' }), new RegExp(name));
  }
  assert.throws(() => createAws({ ...ENV, PRESIGN_ROLE_ARN: 'presign-role' }), /PRESIGN_ROLE_ARN/);
  assert.throws(() => createAws(undefined), /AWS_REGION/);
  assert.equal(Object.isFrozen(createAws(ENV)), true);
});

test('no client waits for AWS without a limit', () => {
  sdk.clients.length = 0;
  createAws(ENV);
  assert.equal(sdk.clients.length, 5);
  for (const { config } of sdk.clients) {
    assert.deepEqual(Object.keys(config).sort(), ['maxAttempts', 'region', 'requestHandler']);
    assert.equal(config.maxAttempts, 2);
    // The options of the SDK's HTTP handler for Node.js, given as a plain object (SDK
    // 3.521 and later), so that the adapter imports nothing but the five clients.
    assert.deepEqual(config.requestHandler, {
      connectionTimeout: 1000,
      socketTimeout: 3000,
      requestTimeout: 4000,
      throwOnRequestTimeout: true,
    });
    // A call that gets no answer at all is over, both attempts, well inside the 16 s
    // that a request has.
    const { connectionTimeout, requestTimeout } = config.requestHandler;
    assert.ok(config.maxAttempts * (connectionTimeout + requestTimeout) <= 10_000);
  }
  // Every client has settings of its own: the SDK keeps the object it is given.
  assert.equal(new Set(sdk.clients.map((client) => client.config)).size, 5);
  assert.equal(new Set(sdk.clients.map((client) => client.config.requestHandler)).size, 5);
});

test('the adapter and the in-memory fake have the same methods', () => {
  const real = createAws(ENV);
  const fake = createFakeAws();
  const methods = Object.keys(real).sort();
  assert.deepEqual(
    methods,
    [
      'cancelJob',
      'createJob',
      'describeJob',
      'describeJobExecution',
      'getFirmwareObject',
      'getRelease',
      'headFirmwareObject',
      'getShadow',
      'getToken',
      'getUser',
      'highestReleaseKey',
      'listGroupThings',
      'listJobExecutionsForJob',
      'listJobExecutionsForThing',
      'listJobs',
      'listReleases',
      'listThingPrincipals',
      'listTokens',
      'listUserGroups',
      'markReleaseRevoked',
      'markRevocationEnforced',
      'markTokenRevoked',
      'putAudit',
      'putFirmwareObject',
      'putToken',
      'queryAudit',
      'queryEvents',
      'querySamples',
      'registerRelease',
      'searchAudit',
      'presignFirmwareUpload',
      'tagFirmwareRevoked',
      // The fleet (docs/fleet.md).
      'describeThing',
      'getFleetItem',
      'listFleetItems',
      'putFleetItem',
      'setReleaseNotes',
      'updateFleetItem',
      // The update history (lib/updates.mjs): a board's facts, read, and put by the backfill.
      'putUpdateFact',
      'queryUpdateFacts',
    ].sort()
  );
  for (const method of methods) {
    assert.equal(typeof real[method], 'function');
    assert.equal(typeof fake[method], 'function', `the fake lacks ${method}`);
  }
});

test('listGroupThings reads every page of the group', async () => {
  const aws = adapter();
  sdk.reply(
    'ListThingsInThingGroupCommand',
    { things: ['cranium-00000000000000bb', THING], nextToken: 'page-2' },
    { things: ['cranium-00000000000000cc'], nextToken: 'page-3' },
    { things: [] }
  );
  assert.deepEqual(await aws.listGroupThings(), ['cranium-00000000000000bb', THING, 'cranium-00000000000000cc']);
  assert.deepEqual(sdk.inputs('ListThingsInThingGroupCommand'), [
    { thingGroupName: 'cranium-devices', maxResults: 250 },
    { thingGroupName: 'cranium-devices', maxResults: 250, nextToken: 'page-2' },
    { thingGroupName: 'cranium-devices', maxResults: 250, nextToken: 'page-3' },
  ]);
  assert.equal(sdk.sent[0].package, '@aws-sdk/client-iot');

  sdk.reset();
  sdk.reply('ListThingsInThingGroupCommand', {});
  assert.deepEqual(await aws.listGroupThings(), []);
});

test('a list that never ends is given up on', async () => {
  const aws = adapter();
  let pages = 0;
  const endless = () => {
    pages += 1;
    return { things: [`thing-${pages}`], nextToken: `page-${pages + 1}` };
  };
  sdk.reply('ListThingsInThingGroupCommand', ...Array.from({ length: 60 }, () => endless));
  await rejectsWith(aws.listGroupThings(), { code: 'failed', operation: 'ListThingsInThingGroup' });
  assert.equal(pages, 40);
});

test('failures are reported as plain errors, throttling marked as such', async () => {
  const aws = adapter();
  sdk.reply('ListThingsInThingGroupCommand', fails('ResourceNotFoundException', { status: 404 }));
  await rejectsWith(aws.listGroupThings(), {
    code: 'failed',
    operation: 'ListThingsInThingGroup',
    awsError: 'ResourceNotFoundException',
  });

  sdk.reply('ListThingsInThingGroupCommand', fails('InternalFailureException', { status: 500 }));
  await assert.rejects(aws.listGroupThings(), (error) => {
    assert.equal(error.code, 'failed');
    assert.equal(error.awsStatus, 500);
    assert.match(error.message, /^ListThingsInThingGroup: InternalFailureException: /);
    return true;
  });

  // The ways AWS says "slow down": by name (IoT answers 400), by status, by the SDK's mark.
  const slow = [
    ['ThrottlingException', { status: 400 }],
    ['TooManyRequestsException', { status: 400 }],
    ['ProvisionedThroughputExceededException', { status: 400 }],
    ['RequestLimitExceeded', { status: 400 }],
    ['SlowDown', { status: 503 }],
    ['SomethingElse', { status: 429 }],
    ['SomethingElse', { status: 400, $retryable: { throttling: true } }],
  ];
  for (const [name, options] of slow) {
    sdk.reply('ListJobsCommand', fails(name, options));
    await rejectsWith(aws.listJobs(), { code: 'throttled', operation: 'ListJobs', awsError: name });
  }
  // A quota is not a rate limit.
  sdk.reply('ListJobsCommand', fails('LimitExceededException', { status: 410 }));
  await rejectsWith(aws.listJobs(), { code: 'failed', operation: 'ListJobs' });

  // Things that are not SDK exceptions at all.
  for (const thrown of [new TypeError('fetch failed'), 'a string', null, undefined, { odd: true }]) {
    sdk.reply('ListJobsCommand', () => {
      throw thrown;
    });
    await rejectsWith(aws.listJobs(), { code: 'failed', operation: 'ListJobs' });
  }
});

test('listThingPrincipals returns the ARNs, or nothing for an unknown thing', async () => {
  const aws = adapter();
  sdk.reply(
    'ListThingPrincipalsCommand',
    { principals: ['arn:aws:iot:eu-west-1:000000000000:cert/aa'], nextToken: 'next' },
    { principals: ['arn:aws:iot:eu-west-1:000000000000:cert/bb'] }
  );
  assert.deepEqual(await aws.listThingPrincipals(THING), [
    'arn:aws:iot:eu-west-1:000000000000:cert/aa',
    'arn:aws:iot:eu-west-1:000000000000:cert/bb',
  ]);
  assert.deepEqual(sdk.inputs('ListThingPrincipalsCommand'), [
    { thingName: THING, maxResults: 250 },
    { thingName: THING, maxResults: 250, nextToken: 'next' },
  ]);

  sdk.reply('ListThingPrincipalsCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.deepEqual(await aws.listThingPrincipals(THING), []);
  sdk.reply('ListThingPrincipalsCommand', fails('UnauthorizedException', { status: 401 }));
  await rejectsWith(aws.listThingPrincipals(THING), { code: 'failed', operation: 'ListThingPrincipals' });
});

test('getShadow parses the payload bytes and maps 404 to no shadow', async () => {
  const aws = adapter();
  const document = {
    state: { reported: { fw: { version: '1.0.0+3', confirmed: true }, uptime: 12, note: 'grüße' } },
    metadata: { reported: { uptime: { timestamp: 1790000000 } } },
    version: 7,
    timestamp: 1790000001,
  };
  // The SDK hands the payload over as a Uint8Array.
  sdk.reply('GetThingShadowCommand', { payload: new TextEncoder().encode(JSON.stringify(document)) });
  assert.deepEqual(await aws.getShadow(THING), document);
  // The classic shadow: no shadow name. The data plane client, not the control plane.
  assert.deepEqual(sdk.inputs('GetThingShadowCommand'), [{ thingName: THING }]);
  assert.equal(sdk.sent[0].package, '@aws-sdk/client-iot-data-plane');

  sdk.reply('GetThingShadowCommand', { payload: Buffer.from(JSON.stringify(document)) });
  assert.deepEqual(await aws.getShadow(THING), document);

  sdk.reply('GetThingShadowCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.equal(await aws.getShadow(THING), null);
  sdk.reply('GetThingShadowCommand', fails('UnknownError', { status: 404 }));
  assert.equal(await aws.getShadow(THING), null);

  for (const [name, status, code] of [
    ['ThrottlingException', 429, 'throttled'],
    ['InternalFailureException', 500, 'failed'],
    ['UnauthorizedException', 401, 'failed'],
    ['ServiceUnavailableException', 503, 'failed'],
  ]) {
    sdk.reply('GetThingShadowCommand', fails(name, { status }));
    await rejectsWith(aws.getShadow(THING), { code, operation: 'GetThingShadow', awsError: name });
  }
  for (const payload of [new TextEncoder().encode('{not json'), new Uint8Array(), undefined]) {
    sdk.reply('GetThingShadowCommand', { payload });
    await rejectsWith(aws.getShadow(THING), { code: 'failed', operation: 'GetThingShadow' });
  }
});

test('listJobs returns plain summaries with times in milliseconds', async () => {
  const aws = adapter();
  sdk.reply(
    'ListJobsCommand',
    {
      jobs: [
        {
          jobArn: `arn:aws:iot:eu-west-1:000000000000:job/${JOB}`,
          jobId: JOB,
          targetSelection: 'SNAPSHOT',
          status: 'IN_PROGRESS',
          createdAt: new Date(T0),
          lastUpdatedAt: new Date(T0 + 1500),
          isConcurrent: false,
        },
      ],
      nextToken: 'more',
    },
    {
      jobs: [
        {
          jobId: 'factory-test-7',
          status: 'COMPLETED',
          createdAt: new Date(T0 - 5000),
          lastUpdatedAt: new Date(T0 - 1000),
          completedAt: new Date(T0 - 1000),
        },
        { status: 'CANCELED' },
      ],
    }
  );
  assert.deepEqual(await aws.listJobs(), [
    { jobId: JOB, status: 'IN_PROGRESS', createdAt: T0, lastUpdatedAt: T0 + 1500, completedAt: null },
    {
      jobId: 'factory-test-7',
      status: 'COMPLETED',
      createdAt: T0 - 5000,
      lastUpdatedAt: T0 - 1000,
      completedAt: T0 - 1000,
    },
  ]);
  assert.deepEqual(sdk.inputs('ListJobsCommand'), [{ maxResults: 250 }, { maxResults: 250, nextToken: 'more' }]);
});

test('describeJob reduces a job to what the console needs', async () => {
  const aws = adapter();
  sdk.reply('DescribeJobCommand', {
    documentSource: undefined,
    job: {
      jobArn: `arn:aws:iot:eu-west-1:000000000000:job/${JOB}`,
      jobId: JOB,
      targetSelection: 'SNAPSHOT',
      status: 'CANCELED',
      forceCanceled: true,
      reasonCode: 'CONSOLE_CANCEL',
      comment: 'who',
      targets: [
        THING_ARN,
        'arn:aws:iot:eu-west-1:000000000000:thinggroup/some-group',
        'arn:aws:iot:eu-west-1:000000000000:thing/cranium-00000000000000bb',
      ],
      description: '{"by":"x","sub":"y","note":""}',
      presignedUrlConfig: { roleArn: ENV.PRESIGN_ROLE_ARN, expiresInSec: 600 },
      createdAt: new Date(T0),
      lastUpdatedAt: new Date(T0 + 9000),
      jobProcessDetails: {
        numberOfCanceledThings: 1,
        numberOfSucceededThings: 2,
        numberOfFailedThings: 3,
        numberOfRejectedThings: 4,
        numberOfQueuedThings: 5,
        numberOfInProgressThings: 6,
        numberOfRemovedThings: 7,
        numberOfTimedOutThings: 8,
      },
      timeoutConfig: { inProgressTimeoutInMinutes: 30 },
    },
  });
  assert.deepEqual(await aws.describeJob(JOB), {
    jobId: JOB,
    status: 'CANCELED',
    description: '{"by":"x","sub":"y","note":""}',
    things: [THING, 'cranium-00000000000000bb'],
    createdAt: T0,
    lastUpdatedAt: T0 + 9000,
    completedAt: null,
    forceCanceled: true,
    reasonCode: 'CONSOLE_CANCEL',
    counts: { queued: 5, inProgress: 6, succeeded: 2, failed: 3, rejected: 4, canceled: 1, timedOut: 8, removed: 7 },
  });
  assert.deepEqual(sdk.inputs('DescribeJobCommand'), [{ jobId: JOB }]);

  // A job that has just been created: no counts yet, nothing optional.
  sdk.reply('DescribeJobCommand', { job: { jobId: JOB, status: 'IN_PROGRESS', createdAt: new Date(T0) } });
  assert.deepEqual(await aws.describeJob(JOB), {
    jobId: JOB,
    status: 'IN_PROGRESS',
    description: '',
    things: [],
    createdAt: T0,
    lastUpdatedAt: null,
    completedAt: null,
    forceCanceled: false,
    reasonCode: null,
    counts: { queued: 0, inProgress: 0, succeeded: 0, failed: 0, rejected: 0, canceled: 0, timedOut: 0, removed: 0 },
  });

  sdk.reply('DescribeJobCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.equal(await aws.describeJob(JOB), null);
  sdk.reply('DescribeJobCommand', {});
  assert.equal(await aws.describeJob(JOB), null);
  sdk.reply('DescribeJobCommand', fails('ThrottlingException'));
  await rejectsWith(aws.describeJob(JOB), { code: 'throttled', operation: 'DescribeJob' });
});

test('executions of a job are listed by thing name', async () => {
  const aws = adapter();
  sdk.reply(
    'ListJobExecutionsForJobCommand',
    {
      executionSummaries: [
        {
          thingArn: THING_ARN,
          jobExecutionSummary: {
            status: 'IN_PROGRESS',
            queuedAt: new Date(T0),
            startedAt: new Date(T0 + 2000),
            lastUpdatedAt: new Date(T0 + 3000),
            executionNumber: 1,
            retryAttempt: 0,
          },
        },
      ],
      nextToken: 'next',
    },
    {
      executionSummaries: [
        {
          thingArn: 'arn:aws:iot:eu-west-1:000000000000:thing/cranium-00000000000000bb',
          jobExecutionSummary: {
            status: 'QUEUED',
            queuedAt: new Date(T0),
            lastUpdatedAt: new Date(T0),
            executionNumber: 1,
          },
        },
        { jobExecutionSummary: { status: 'QUEUED' } },
      ],
    }
  );
  assert.deepEqual(await aws.listJobExecutionsForJob(JOB), [
    {
      thing: THING,
      status: 'IN_PROGRESS',
      queuedAt: T0,
      startedAt: T0 + 2000,
      lastUpdatedAt: T0 + 3000,
      executionNumber: 1,
    },
    {
      thing: 'cranium-00000000000000bb',
      status: 'QUEUED',
      queuedAt: T0,
      startedAt: null,
      lastUpdatedAt: T0,
      executionNumber: 1,
    },
  ]);
  assert.deepEqual(sdk.inputs('ListJobExecutionsForJobCommand'), [
    { jobId: JOB, maxResults: 250 },
    { jobId: JOB, maxResults: 250, nextToken: 'next' },
  ]);

  sdk.reply('ListJobExecutionsForJobCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.deepEqual(await aws.listJobExecutionsForJob(JOB), []);
  sdk.reply('ListJobExecutionsForJobCommand', fails('ServiceUnavailableException', { status: 503 }));
  await rejectsWith(aws.listJobExecutionsForJob(JOB), { code: 'failed', operation: 'ListJobExecutionsForJob' });
});

test('describeJobExecution finds what the board wrote in statusDetails.detailsMap', async () => {
  const aws = adapter();
  sdk.reply('DescribeJobExecutionCommand', {
    execution: {
      jobId: JOB,
      status: 'IN_PROGRESS',
      forceCanceled: false,
      statusDetails: { detailsMap: { step: 'downloading', odd: 5, running: '1.0.0+3' } },
      thingArn: THING_ARN,
      queuedAt: new Date(T0),
      startedAt: new Date(T0 + 2000),
      lastUpdatedAt: new Date(T0 + 3000),
      executionNumber: 1,
      versionNumber: 3,
      approximateSecondsBeforeTimedOut: 1741,
    },
  });
  assert.deepEqual(await aws.describeJobExecution(JOB, THING), {
    thing: THING,
    status: 'IN_PROGRESS',
    queuedAt: T0,
    startedAt: T0 + 2000,
    lastUpdatedAt: T0 + 3000,
    executionNumber: 1,
    statusDetails: { step: 'downloading', running: '1.0.0+3' },
    secondsLeft: 1741,
    forceCanceled: false,
  });
  assert.deepEqual(sdk.inputs('DescribeJobExecutionCommand'), [{ jobId: JOB, thingName: THING }]);

  // Finished: no time left to report. Queued: no details at all.
  sdk.reply('DescribeJobExecutionCommand', {
    execution: {
      jobId: JOB,
      status: 'CANCELED',
      forceCanceled: true,
      queuedAt: new Date(T0),
      lastUpdatedAt: new Date(T0 + 1),
    },
  });
  assert.deepEqual(await aws.describeJobExecution(JOB, THING), {
    thing: THING,
    status: 'CANCELED',
    queuedAt: T0,
    startedAt: null,
    lastUpdatedAt: T0 + 1,
    executionNumber: null,
    statusDetails: {},
    secondsLeft: null,
    forceCanceled: true,
  });

  sdk.reply('DescribeJobExecutionCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.equal(await aws.describeJobExecution(JOB, THING), null);
  sdk.reply('DescribeJobExecutionCommand', {});
  assert.equal(await aws.describeJobExecution(JOB, THING), null);
  sdk.reply('DescribeJobExecutionCommand', fails('ThrottlingException'));
  await rejectsWith(aws.describeJobExecution(JOB, THING), { code: 'throttled', operation: 'DescribeJobExecution' });
});

test('executions of a thing are listed by job id', async () => {
  const aws = adapter();
  sdk.reply(
    'ListJobExecutionsForThingCommand',
    {
      executionSummaries: [
        {
          jobId: JOB,
          jobExecutionSummary: {
            status: 'QUEUED',
            queuedAt: new Date(T0),
            lastUpdatedAt: new Date(T0),
            executionNumber: 4,
          },
        },
      ],
      nextToken: 'next',
    },
    {
      executionSummaries: [
        {
          jobId: 'factory-test-7',
          jobExecutionSummary: {
            status: 'SUCCEEDED',
            queuedAt: new Date(T0 - 9),
            startedAt: new Date(T0 - 8),
            lastUpdatedAt: new Date(T0 - 7),
            executionNumber: 1,
          },
        },
        { jobExecutionSummary: { status: 'QUEUED' } },
      ],
    }
  );
  assert.deepEqual(await aws.listJobExecutionsForThing(THING), [
    { jobId: JOB, status: 'QUEUED', queuedAt: T0, startedAt: null, lastUpdatedAt: T0, executionNumber: 4 },
    {
      jobId: 'factory-test-7',
      status: 'SUCCEEDED',
      queuedAt: T0 - 9,
      startedAt: T0 - 8,
      lastUpdatedAt: T0 - 7,
      executionNumber: 1,
    },
  ]);
  assert.deepEqual(sdk.inputs('ListJobExecutionsForThingCommand'), [
    { thingName: THING, maxResults: 250 },
    { thingName: THING, maxResults: 250, nextToken: 'next' },
  ]);

  sdk.reply('ListJobExecutionsForThingCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.deepEqual(await aws.listJobExecutionsForThing(THING), []);
});

test('createJob makes a snapshot job on thing ARNs with a presigned URL role', async () => {
  const aws = adapter();
  const input = {
    jobId: JOB,
    things: [THING, 'cranium-00000000000000bb'],
    document: '{"op":"fw_update"}',
    description: '{"by":"x","sub":"y","note":""}',
    urlExpiresInSec: 600,
    inProgressTimeoutMinutes: 30,
  };
  sdk.reply('CreateJobCommand', { jobArn: `arn:aws:iot:eu-west-1:000000000000:job/${JOB}`, jobId: JOB });
  assert.deepEqual(await aws.createJob(input), { ok: true });
  assert.deepEqual(sdk.inputs('CreateJobCommand'), [
    {
      jobId: JOB,
      targets: [THING_ARN, 'arn:aws:iot:eu-west-1:000000000000:thing/cranium-00000000000000bb'],
      targetSelection: 'SNAPSHOT',
      document: '{"op":"fw_update"}',
      description: '{"by":"x","sub":"y","note":""}',
      presignedUrlConfig: { roleArn: 'arn:aws:iam::000000000000:role/presign-role', expiresInSec: 600 },
      timeoutConfig: { inProgressTimeoutInMinutes: 30 },
    },
  ]);

  sdk.reply('CreateJobCommand', fails('ResourceAlreadyExistsException', { status: 409 }));
  assert.deepEqual(await aws.createJob(input), { ok: false, reason: 'exists' });
  sdk.reply('CreateJobCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.deepEqual(await aws.createJob(input), { ok: false, reason: 'target_not_found' });
  for (const [name, code] of [
    ['InvalidRequestException', 'failed'],
    ['LimitExceededException', 'failed'],
    ['ThrottlingException', 'throttled'],
    ['ServiceUnavailableException', 'failed'],
    ['AccessDeniedException', 'failed'],
  ]) {
    sdk.reply('CreateJobCommand', fails(name));
    await rejectsWith(aws.createJob(input), { code, operation: 'CreateJob', awsError: name });
  }

  // The partition and the account of the targets are those of the presign role.
  const elsewhere = adapter({
    ...ENV,
    AWS_REGION: 'us-gov-west-1',
    PRESIGN_ROLE_ARN: 'arn:aws-us-gov:iam::999999999999:role/path/presign',
  });
  sdk.reply('CreateJobCommand', {});
  await elsewhere.createJob(input);
  assert.equal(
    sdk.inputs('CreateJobCommand')[0].targets[0],
    `arn:aws-us-gov:iot:us-gov-west-1:999999999999:thing/${THING}`
  );
});

test('cancelJob passes the force flag, the reason code and the comment', async () => {
  const aws = adapter();
  sdk.reply('CancelJobCommand', { jobId: JOB }, { jobId: JOB });
  assert.deepEqual(await aws.cancelJob({ jobId: JOB, force: true, reasonCode: 'RELEASE_REVOKED', comment: 'who' }), {
    ok: true,
  });
  assert.deepEqual(await aws.cancelJob({ jobId: JOB, force: false, reasonCode: 'CONSOLE_CANCEL', comment: 'who' }), {
    ok: true,
  });
  assert.deepEqual(sdk.inputs('CancelJobCommand'), [
    { jobId: JOB, force: true, reasonCode: 'RELEASE_REVOKED', comment: 'who' },
    { jobId: JOB, force: false, reasonCode: 'CONSOLE_CANCEL', comment: 'who' },
  ]);
  // Anything but true is not forced.
  sdk.reply('CancelJobCommand', {});
  await aws.cancelJob({ jobId: JOB, force: 'yes', reasonCode: 'CONSOLE_CANCEL', comment: 'who' });
  assert.equal(sdk.inputs('CancelJobCommand')[2].force, false);

  const request = { jobId: JOB, force: true, reasonCode: 'CONSOLE_CANCEL', comment: 'who' };
  sdk.reply('CancelJobCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.deepEqual(await aws.cancelJob(request), { ok: false, reason: 'not_found' });
  sdk.reply('CancelJobCommand', fails('InvalidRequestException', { message: 'Job is in a terminal state' }));
  assert.deepEqual(await aws.cancelJob(request), {
    ok: false,
    reason: 'refused',
    detail: 'Job is in a terminal state',
  });
  sdk.reply('CancelJobCommand', fails('ThrottlingException'));
  await rejectsWith(aws.cancelJob(request), { code: 'throttled', operation: 'CancelJob' });
  sdk.reply('CancelJobCommand', fails('LimitExceededException', { status: 410 }));
  await rejectsWith(aws.cancelJob(request), { code: 'failed', operation: 'CancelJob' });
});

test('putFirmwareObject writes once, with the SHA-256 for S3 to check', async () => {
  const aws = adapter();
  const body = Buffer.from('firmware image bytes');
  const sha256Base64 = createHash('sha256').update(body).digest('base64');
  const key = `firmware/${'ab'.repeat(32)}.bin`;

  sdk.reply('PutObjectCommand', { ETag: '"etag"', VersionId: 'v1', ChecksumSHA256: sha256Base64 });
  assert.deepEqual(await aws.putFirmwareObject({ key, body, sha256Base64 }), { stored: true });
  assert.deepEqual(sdk.inputs('PutObjectCommand'), [
    {
      Bucket: 'firmware-bucket',
      Key: key,
      Body: body,
      ContentType: 'application/octet-stream',
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: sha256Base64,
      IfNoneMatch: '*',
    },
  ]);
  assert.equal(sdk.sent[0].package, '@aws-sdk/client-s3');

  // 412: the key is taken. Recognized by status or by name.
  sdk.reply('PutObjectCommand', fails('PreconditionFailed', { status: 412 }));
  assert.deepEqual(await aws.putFirmwareObject({ key, body, sha256Base64 }), { stored: false, reason: 'exists' });
  sdk.reply('PutObjectCommand', fails('UnknownError', { status: 412 }));
  assert.deepEqual(await aws.putFirmwareObject({ key, body, sha256Base64 }), { stored: false, reason: 'exists' });
  sdk.reply('PutObjectCommand', fails('PreconditionFailed', { status: undefined }));
  assert.deepEqual(await aws.putFirmwareObject({ key, body, sha256Base64 }), { stored: false, reason: 'exists' });

  // 409: a concurrent write to the same key. Tried again, a limited number of times.
  sdk.reset();
  sdk.reply(
    'PutObjectCommand',
    fails('ConditionalRequestConflict', { status: 409 }),
    fails('ConditionalRequestConflict', { status: 409 }),
    fails('PreconditionFailed', { status: 412 })
  );
  assert.deepEqual(await aws.putFirmwareObject({ key, body, sha256Base64 }), { stored: false, reason: 'exists' });
  assert.equal(sdk.inputs('PutObjectCommand').length, 3);
  sdk.reset();
  sdk.reply(
    'PutObjectCommand',
    ...Array.from({ length: 5 }, () => fails('ConditionalRequestConflict', { status: 409 }))
  );
  await rejectsWith(aws.putFirmwareObject({ key, body, sha256Base64 }), {
    code: 'failed',
    operation: 'PutObject',
    awsError: 'ConditionalRequestConflict',
  });
  assert.equal(sdk.inputs('PutObjectCommand').length, 3);

  // Refused by the bucket policy, a wrong digest, throttling.
  sdk.reset();
  for (const [name, status, code] of [
    ['AccessDenied', 403, 'failed'],
    ['BadDigest', 400, 'failed'],
    ['SlowDown', 503, 'throttled'],
  ]) {
    sdk.reply('PutObjectCommand', fails(name, { status }));
    await rejectsWith(aws.putFirmwareObject({ key, body, sha256Base64 }), {
      code,
      operation: 'PutObject',
      awsError: name,
    });
  }
});

test('tagFirmwareRevoked sets the tag the bucket policy looks for', async () => {
  const aws = adapter();
  const key = `firmware/${'ab'.repeat(32)}.bin`;
  sdk.reply('PutObjectTaggingCommand', { VersionId: 'v1' });
  assert.deepEqual(await aws.tagFirmwareRevoked(key), { ok: true });
  assert.deepEqual(sdk.inputs('PutObjectTaggingCommand'), [
    {
      Bucket: 'firmware-bucket',
      Key: key,
      ChecksumAlgorithm: 'SHA256',
      Tagging: { TagSet: [{ Key: 'revoked', Value: 'true' }] },
    },
  ]);

  sdk.reply('PutObjectTaggingCommand', fails('NoSuchKey', { status: 404 }));
  assert.deepEqual(await aws.tagFirmwareRevoked(key), { ok: false, reason: 'not_found' });
  sdk.reply('PutObjectTaggingCommand', fails('AccessDenied', { status: 403 }));
  await rejectsWith(aws.tagFirmwareRevoked(key), { code: 'failed', operation: 'PutObjectTagging' });
});

test('getFirmwareObject reads an image, and a missing or revoked one is null', async () => {
  const aws = adapter();
  const key = `firmware/${'cd'.repeat(32)}.bin`;
  sdk.reply('GetObjectCommand', { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } });
  assert.deepEqual(await aws.getFirmwareObject(key), Buffer.from([1, 2, 3]));
  assert.deepEqual(sdk.inputs('GetObjectCommand'), [{ Bucket: 'firmware-bucket', Key: key }]);

  sdk.reply('GetObjectCommand', fails('NoSuchKey', { status: 404 }));
  assert.equal(await aws.getFirmwareObject(key), null);
  // The bucket policy's answer for a revoked image.
  sdk.reply('GetObjectCommand', fails('AccessDenied', { status: 403 }));
  assert.equal(await aws.getFirmwareObject(key), null);
  sdk.reply('GetObjectCommand', fails('InternalError', { status: 500 }));
  await rejectsWith(aws.getFirmwareObject(key), { code: 'failed', operation: 'GetObject' });
});

const RELEASE = Object.freeze({
  version: '1.2.3+4',
  size: 1264,
  sha256: 'ab'.repeat(32),
  filename: 'zephyr.signed.bin',
  notes: '',
  uploadedBy: { sub: 'who', email: 'address' },
  uploadedAt: '2026-10-10T22:15:00.000Z',
  status: 'active',
  revoked: null,
});
const SK = '001.002.00003.0000000004';
const RELEASE_ITEM = Object.freeze({
  pk: { S: 'REL' },
  sk: { S: SK },
  version: { S: '1.2.3+4' },
  size: { N: '1264' },
  sha256: { S: 'ab'.repeat(32) },
  filename: { S: 'zephyr.signed.bin' },
  notes: { S: '' },
  uploadedBy: { M: { sub: { S: 'who' }, email: { S: 'address' } } },
  uploadedAt: { S: '2026-10-10T22:15:00.000Z' },
  status: { S: 'active' },
  revoked: { NULL: true },
});

test('getRelease reads one item consistently and turns it into plain data', async () => {
  const aws = adapter();
  sdk.reply('GetItemCommand', { Item: RELEASE_ITEM });
  assert.deepEqual(await aws.getRelease(SK), { ...RELEASE, pk: 'REL', sk: SK });
  assert.deepEqual(sdk.inputs('GetItemCommand'), [
    {
      TableName: 'state-table',
      Key: { pk: { S: 'REL' }, sk: { S: SK } },
      ConsistentRead: true,
    },
  ]);
  assert.equal(sdk.sent[0].package, '@aws-sdk/client-dynamodb');

  sdk.reply('GetItemCommand', {});
  assert.equal(await aws.getRelease(SK), null);
  sdk.reply('GetItemCommand', fails('ProvisionedThroughputExceededException'));
  await rejectsWith(aws.getRelease(SK), { code: 'throttled', operation: 'GetItem' });

  // Every attribute type the module stores, and the ones it never does.
  sdk.reply('GetItemCommand', {
    Item: {
      text: { S: 'x' },
      number: { N: '-12.5' },
      yes: { BOOL: true },
      no: { BOOL: false },
      nothing: { NULL: true },
      list: { L: [{ S: 'a' }, { N: '2' }, { M: { deep: { BOOL: true } } }] },
      map: { M: { inner: { M: { n: { N: '0' } } } } },
      set: { SS: ['a', 'b'] },
      bytes: { B: new Uint8Array([1]) },
    },
  });
  assert.deepEqual(await aws.getRelease(SK), {
    text: 'x',
    number: -12.5,
    yes: true,
    no: false,
    nothing: null,
    list: ['a', 2, { deep: true }],
    map: { inner: { n: 0 } },
    set: null,
    bytes: null,
  });
});

test('highestReleaseKey reads the pointer item consistently', async () => {
  const aws = adapter();
  sdk.reply('GetItemCommand', { Item: { pk: { S: 'META' }, sk: { S: 'HIGHEST' }, highest: { S: SK } } });
  assert.equal(await aws.highestReleaseKey(), SK);
  assert.deepEqual(sdk.inputs('GetItemCommand'), [
    {
      TableName: 'state-table',
      Key: { pk: { S: 'META' }, sk: { S: 'HIGHEST' } },
      ConsistentRead: true,
    },
  ]);

  // Before the first release there is no pointer.
  sdk.reply('GetItemCommand', {});
  assert.equal(await aws.highestReleaseKey(), null);
  sdk.reply('GetItemCommand', fails('ProvisionedThroughputExceededException'));
  await rejectsWith(aws.highestReleaseKey(), { code: 'throttled', operation: 'GetItem' });
});

test('listReleases queries the release partition, highest version first, every page', async () => {
  const aws = adapter();
  sdk.reply(
    'QueryCommand',
    { Items: [RELEASE_ITEM], LastEvaluatedKey: { pk: { S: 'REL' }, sk: { S: SK } } },
    { Items: [{ ...RELEASE_ITEM, sk: { S: '001.000.00000.0000000000' } }] }
  );
  const releases = await aws.listReleases();
  assert.deepEqual(
    releases.map((release) => release.sk),
    [SK, '001.000.00000.0000000000']
  );
  assert.deepEqual(sdk.inputs('QueryCommand'), [
    {
      TableName: 'state-table',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': { S: 'REL' } },
      ScanIndexForward: false,
      ConsistentRead: true,
    },
    {
      TableName: 'state-table',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': { S: 'REL' } },
      ScanIndexForward: false,
      ConsistentRead: true,
      ExclusiveStartKey: { pk: { S: 'REL' }, sk: { S: SK } },
    },
  ]);
  sdk.reply('QueryCommand', {});
  assert.deepEqual(await aws.listReleases(), []);
  sdk.reply('QueryCommand', fails('InternalServerError', { status: 500 }));
  await rejectsWith(aws.listReleases(), { code: 'failed', operation: 'Query' });
});

test('registerRelease stores the release and advances the pointer in one transaction', async () => {
  const aws = adapter();
  sdk.reply('TransactWriteItemsCommand', {});
  assert.deepEqual(
    await aws.registerRelease({ sk: SK, release: { ...RELEASE, pk: 'ignored', sk: 'ignored', skipped: undefined } }),
    { ok: true }
  );
  assert.deepEqual(sdk.inputs('TransactWriteItemsCommand'), [
    {
      TransactItems: [
        {
          Put: {
            TableName: 'state-table',
            Item: RELEASE_ITEM,
            ConditionExpression: 'attribute_not_exists(#pk)',
            ExpressionAttributeNames: { '#pk': 'pk' },
          },
        },
        {
          Update: {
            TableName: 'state-table',
            Key: { pk: { S: 'META' }, sk: { S: 'HIGHEST' } },
            UpdateExpression: 'SET #highest = :sk',
            ConditionExpression: 'attribute_not_exists(#highest) OR #highest < :sk',
            ExpressionAttributeNames: { '#highest': 'highest' },
            ExpressionAttributeValues: { ':sk': { S: SK } },
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          },
        },
      ],
    },
  ]);
});

test('registerRelease tells an existing version from one that is not newer', async () => {
  const aws = adapter();
  const cancelled = (...reasons) => fails('TransactionCanceledException', { CancellationReasons: reasons });
  const request = { sk: SK, release: RELEASE };
  const none = { Code: 'None' };
  const failed = { Code: 'ConditionalCheckFailed', Message: 'The conditional request failed' };
  const pointer = { pk: { S: 'META' }, sk: { S: 'HIGHEST' }, highest: { S: '002.000.00000.0000000000' } };

  // The release item exists, whatever the pointer says.
  sdk.reply('TransactWriteItemsCommand', cancelled(failed, none));
  assert.deepEqual(await aws.registerRelease(request), { ok: false, reason: 'exists' });
  sdk.reply('TransactWriteItemsCommand', cancelled(failed, { ...failed, Item: pointer }));
  assert.deepEqual(await aws.registerRelease(request), { ok: false, reason: 'exists' });

  // Only the pointer refuses: not newer, and the old pointer value says than what.
  sdk.reply('TransactWriteItemsCommand', cancelled(none, { ...failed, Item: pointer }));
  assert.deepEqual(await aws.registerRelease(request), {
    ok: false,
    reason: 'not_newer',
    highest: '002.000.00000.0000000000',
  });
  assert.equal(sdk.inputs('GetItemCommand').length, 0);

  // If the reason carries no item, the pointer is read.
  sdk.reply('TransactWriteItemsCommand', cancelled(none, failed));
  sdk.reply('GetItemCommand', { Item: pointer });
  assert.deepEqual(await aws.registerRelease(request), {
    ok: false,
    reason: 'not_newer',
    highest: '002.000.00000.0000000000',
  });
  assert.deepEqual(sdk.inputs('GetItemCommand'), [
    {
      TableName: 'state-table',
      Key: { pk: { S: 'META' }, sk: { S: 'HIGHEST' } },
      ConsistentRead: true,
    },
  ]);
  sdk.reply('TransactWriteItemsCommand', cancelled(none, failed));
  sdk.reply('GetItemCommand', fails('InternalServerError', { status: 500 }));
  assert.deepEqual(await aws.registerRelease(request), { ok: false, reason: 'not_newer', highest: null });

  // A concurrent transaction on the same items.
  sdk.reply('TransactWriteItemsCommand', cancelled(none, { Code: 'TransactionConflict' }));
  assert.deepEqual(await aws.registerRelease(request), { ok: false, reason: 'conflict' });

  // Anything else is a failure.
  sdk.reply('TransactWriteItemsCommand', cancelled({ Code: 'ThrottlingError' }, none));
  await rejectsWith(aws.registerRelease(request), { code: 'throttled', operation: 'TransactWriteItems' });
  sdk.reply('TransactWriteItemsCommand', cancelled({ Code: 'ValidationError' }, none));
  await rejectsWith(aws.registerRelease(request), { code: 'failed', operation: 'TransactWriteItems' });
  sdk.reply('TransactWriteItemsCommand', fails('TransactionCanceledException'));
  await rejectsWith(aws.registerRelease(request), { code: 'failed', operation: 'TransactWriteItems' });
  sdk.reply('TransactWriteItemsCommand', fails('AccessDeniedException'));
  await rejectsWith(aws.registerRelease(request), { code: 'failed', operation: 'TransactWriteItems' });

  // Only plain data can be stored.
  for (const value of [NaN, Infinity, () => {}, Symbol('x'), 10n]) {
    await assert.rejects(aws.registerRelease({ sk: SK, release: { ...RELEASE, size: value } }), TypeError);
  }
});

test('markReleaseRevoked changes an active release and nothing else', async () => {
  const aws = adapter();
  const revoked = { by: { sub: 'who', email: 'address' }, at: '2026-10-11T08:00:00.000Z', reason: 'bad build' };
  const revokedItem = {
    ...RELEASE_ITEM,
    status: { S: 'revoked' },
    revoked: {
      M: {
        by: { M: { sub: { S: 'who' }, email: { S: 'address' } } },
        at: { S: '2026-10-11T08:00:00.000Z' },
        reason: { S: 'bad build' },
      },
    },
  };
  sdk.reply('UpdateItemCommand', { Attributes: revokedItem });
  assert.deepEqual(await aws.markReleaseRevoked({ sk: SK, revoked }), {
    ok: true,
    release: { ...RELEASE, pk: 'REL', sk: SK, status: 'revoked', revoked },
  });
  assert.deepEqual(sdk.inputs('UpdateItemCommand'), [
    {
      TableName: 'state-table',
      Key: { pk: { S: 'REL' }, sk: { S: SK } },
      UpdateExpression: 'SET #status = :revoked, #revoked = :info',
      ConditionExpression: '#status = :active',
      ExpressionAttributeNames: { '#status': 'status', '#revoked': 'revoked' },
      ExpressionAttributeValues: {
        ':active': { S: 'active' },
        ':revoked': { S: 'revoked' },
        ':info': revokedItem.revoked,
      },
      ReturnValues: 'ALL_NEW',
    },
  ]);

  sdk.reply('UpdateItemCommand', fails('ConditionalCheckFailedException'));
  assert.deepEqual(await aws.markReleaseRevoked({ sk: SK, revoked }), { ok: false, reason: 'not_active' });
  sdk.reply('UpdateItemCommand', fails('ThrottlingException'));
  await rejectsWith(aws.markReleaseRevoked({ sk: SK, revoked }), { code: 'throttled', operation: 'UpdateItem' });
});

test('markRevocationEnforced records once when a revocation was completed', async () => {
  const aws = adapter();
  const at = '2026-10-11T08:00:02.500Z';
  const revoked = { by: { sub: 'who', email: 'address' }, at: '2026-10-11T08:00:00.000Z', reason: 'bad build' };
  const enforcedItem = {
    ...RELEASE_ITEM,
    status: { S: 'revoked' },
    revoked: {
      M: {
        by: { M: { sub: { S: 'who' }, email: { S: 'address' } } },
        at: { S: revoked.at },
        reason: { S: 'bad build' },
        enforcedAt: { S: at },
      },
    },
  };
  sdk.reply('UpdateItemCommand', { Attributes: enforcedItem });
  assert.deepEqual(await aws.markRevocationEnforced({ sk: SK, at }), {
    ok: true,
    release: { ...RELEASE, pk: 'REL', sk: SK, status: 'revoked', revoked: { ...revoked, enforcedAt: at } },
  });
  assert.deepEqual(sdk.inputs('UpdateItemCommand'), [
    {
      TableName: 'state-table',
      Key: { pk: { S: 'REL' }, sk: { S: SK } },
      // One member of the map that the revocation wrote; the rest of it is not touched.
      UpdateExpression: 'SET #revoked.#enforcedAt = :at',
      ConditionExpression: '#status = :revoked AND attribute_not_exists(#revoked.#enforcedAt)',
      ExpressionAttributeNames: { '#status': 'status', '#revoked': 'revoked', '#enforcedAt': 'enforcedAt' },
      ExpressionAttributeValues: { ':revoked': { S: 'revoked' }, ':at': { S: at } },
      ReturnValues: 'ALL_NEW',
    },
  ]);

  // Not revoked, no such release, or on record already.
  sdk.reply('UpdateItemCommand', fails('ConditionalCheckFailedException'));
  assert.deepEqual(await aws.markRevocationEnforced({ sk: SK, at }), { ok: false, reason: 'not_pending' });
  // A record whose "revoked" is not a map cannot take the member.
  sdk.reply('UpdateItemCommand', fails('ValidationException'));
  await rejectsWith(aws.markRevocationEnforced({ sk: SK, at }), {
    code: 'failed',
    operation: 'UpdateItem',
    awsError: 'ValidationException',
  });
  sdk.reply('UpdateItemCommand', fails('ThrottlingException'));
  await rejectsWith(aws.markRevocationEnforced({ sk: SK, at }), { code: 'throttled', operation: 'UpdateItem' });
});

test('putAudit appends and never overwrites', async () => {
  const aws = adapter();
  const item = {
    sk: '2026-10-10T22:15:00.000Z#request-1',
    at: '2026-10-10T22:15:00.000Z',
    requestId: 'request-1',
    actor: { sub: 'who', email: '' },
    action: 'firmware.upload',
    target: '1.2.3+4',
    outcome: 'ok',
    detail: { size: '1264' },
  };
  sdk.reply('PutItemCommand', {});
  assert.deepEqual(await aws.putAudit(item), { ok: true });
  assert.deepEqual(sdk.inputs('PutItemCommand'), [
    {
      TableName: 'audit-table',
      Item: {
        pk: { S: 'AUD' },
        sk: { S: '2026-10-10T22:15:00.000Z#request-1' },
        at: { S: '2026-10-10T22:15:00.000Z' },
        requestId: { S: 'request-1' },
        actor: { M: { sub: { S: 'who' }, email: { S: '' } } },
        action: { S: 'firmware.upload' },
        target: { S: '1.2.3+4' },
        outcome: { S: 'ok' },
        detail: { M: { size: { S: '1264' } } },
      },
      ConditionExpression: 'attribute_not_exists(#pk)',
      ExpressionAttributeNames: { '#pk': 'pk' },
    },
  ]);

  sdk.reply('PutItemCommand', fails('ConditionalCheckFailedException'));
  assert.deepEqual(await aws.putAudit(item), { ok: false, reason: 'exists' });
  sdk.reply('PutItemCommand', fails('RequestLimitExceeded'));
  await rejectsWith(aws.putAudit(item), { code: 'throttled', operation: 'PutItem' });
  sdk.reply('PutItemCommand', fails('ResourceNotFoundException'));
  await rejectsWith(aws.putAudit(item), { code: 'failed', operation: 'PutItem' });
});

const DIGEST = 'ab'.repeat(32);
const TOKEN_RECORD = Object.freeze({
  id: '0123456789abcdef',
  ownerSub: 'who',
  name: 'laptop',
  createdAt: '2026-10-10T22:15:00.000Z',
  expiresAt: '2026-11-09T22:15:00.000Z',
  revokedAt: null,
});
const TOKEN_ITEM = Object.freeze({
  pk: { S: 'TOK' },
  sk: { S: DIGEST },
  id: { S: '0123456789abcdef' },
  ownerSub: { S: 'who' },
  name: { S: 'laptop' },
  createdAt: { S: '2026-10-10T22:15:00.000Z' },
  expiresAt: { S: '2026-11-09T22:15:00.000Z' },
  revokedAt: { NULL: true },
});

test('getToken reads one token item by its digest, consistently', async () => {
  const aws = adapter();
  sdk.reply('GetItemCommand', { Item: TOKEN_ITEM });
  assert.deepEqual(await aws.getToken(DIGEST), { ...TOKEN_RECORD, pk: 'TOK', sk: DIGEST });
  assert.deepEqual(sdk.inputs('GetItemCommand'), [
    {
      TableName: 'state-table',
      Key: { pk: { S: 'TOK' }, sk: { S: DIGEST } },
      ConsistentRead: true,
    },
  ]);
  sdk.reply('GetItemCommand', {});
  assert.equal(await aws.getToken(DIGEST), null);
  sdk.reply('GetItemCommand', fails('ThrottlingException'));
  await rejectsWith(aws.getToken(DIGEST), { code: 'throttled', operation: 'GetItem' });
});

test("listTokens asks DynamoDB for one person's tokens only, every page", async () => {
  const aws = adapter();
  sdk.reply(
    'QueryCommand',
    { Items: [TOKEN_ITEM], LastEvaluatedKey: { pk: { S: 'TOK' }, sk: { S: DIGEST } } },
    { Items: [] }
  );
  assert.deepEqual(await aws.listTokens('who'), [{ ...TOKEN_RECORD, pk: 'TOK', sk: DIGEST }]);
  const first = {
    TableName: 'state-table',
    KeyConditionExpression: '#pk = :pk',
    FilterExpression: '#owner = :owner',
    ExpressionAttributeNames: { '#pk': 'pk', '#owner': 'ownerSub' },
    ExpressionAttributeValues: { ':pk': { S: 'TOK' }, ':owner': { S: 'who' } },
    ConsistentRead: true,
  };
  assert.deepEqual(sdk.inputs('QueryCommand'), [
    first,
    { ...first, ExclusiveStartKey: { pk: { S: 'TOK' }, sk: { S: DIGEST } } },
  ]);
  sdk.reply('QueryCommand', fails('InternalServerError', { status: 500 }));
  await rejectsWith(aws.listTokens('who'), { code: 'failed', operation: 'Query' });
  // A list that never ends is given up on.
  sdk.reset();
  for (let page = 0; page < 40; page += 1)
    sdk.reply('QueryCommand', { Items: [], LastEvaluatedKey: { pk: { S: 'TOK' } } });
  await rejectsWith(aws.listTokens('who'), { code: 'failed', operation: 'Query' });
});

test('putToken stores a token record under its digest and never replaces one', async () => {
  const aws = adapter();
  sdk.reply('PutItemCommand', {});
  assert.deepEqual(await aws.putToken({ sk: DIGEST, token: { ...TOKEN_RECORD, pk: 'ignored', sk: 'ignored' } }), {
    ok: true,
  });
  assert.deepEqual(sdk.inputs('PutItemCommand'), [
    {
      TableName: 'state-table',
      Item: TOKEN_ITEM,
      ConditionExpression: 'attribute_not_exists(#pk)',
      ExpressionAttributeNames: { '#pk': 'pk' },
    },
  ]);
  sdk.reply('PutItemCommand', fails('ConditionalCheckFailedException'));
  assert.deepEqual(await aws.putToken({ sk: DIGEST, token: TOKEN_RECORD }), { ok: false, reason: 'exists' });
  sdk.reply('PutItemCommand', fails('ThrottlingException'));
  await rejectsWith(aws.putToken({ sk: DIGEST, token: TOKEN_RECORD }), { code: 'throttled', operation: 'PutItem' });
});

test("markTokenRevoked sets the time once, on the owner's token only", async () => {
  const aws = adapter();
  const at = '2026-10-12T08:00:00.000Z';
  sdk.reply('UpdateItemCommand', { Attributes: { ...TOKEN_ITEM, revokedAt: { S: at } } });
  assert.deepEqual(await aws.markTokenRevoked({ sk: DIGEST, ownerSub: 'who', at }), {
    ok: true,
    token: { ...TOKEN_RECORD, pk: 'TOK', sk: DIGEST, revokedAt: at },
  });
  assert.deepEqual(sdk.inputs('UpdateItemCommand'), [
    {
      TableName: 'state-table',
      Key: { pk: { S: 'TOK' }, sk: { S: DIGEST } },
      UpdateExpression: 'SET #revokedAt = :at',
      ConditionExpression: '#owner = :owner AND attribute_type(#revokedAt, :null)',
      ExpressionAttributeNames: { '#owner': 'ownerSub', '#revokedAt': 'revokedAt' },
      ExpressionAttributeValues: { ':owner': { S: 'who' }, ':null': { S: 'NULL' }, ':at': { S: at } },
      ReturnValues: 'ALL_NEW',
    },
  ]);
  sdk.reply('UpdateItemCommand', fails('ConditionalCheckFailedException'));
  assert.deepEqual(await aws.markTokenRevoked({ sk: DIGEST, ownerSub: 'who', at }), {
    ok: false,
    reason: 'not_active',
  });
  sdk.reply('UpdateItemCommand', fails('ThrottlingException'));
  await rejectsWith(aws.markTokenRevoked({ sk: DIGEST, ownerSub: 'who', at }), {
    code: 'throttled',
    operation: 'UpdateItem',
  });
});

test('queryAudit reads newest first, below a cursor, never more than asked', async () => {
  const aws = adapter();
  const entry = (n) => ({ pk: { S: 'AUD' }, sk: { S: `2026-10-10T22:15:0${n}.000Z#r${n}` }, outcome: { S: 'ok' } });

  sdk.reply('QueryCommand', { Items: [entry(9), entry(8), entry(7)] });
  assert.deepEqual(
    (await aws.queryAudit({ before: null, limit: 3 })).map((item) => item.sk),
    ['2026-10-10T22:15:09.000Z#r9', '2026-10-10T22:15:08.000Z#r8', '2026-10-10T22:15:07.000Z#r7']
  );
  assert.deepEqual(sdk.inputs('QueryCommand'), [
    {
      TableName: 'audit-table',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': { S: 'AUD' } },
      ScanIndexForward: false,
      ConsistentRead: true,
      Limit: 3,
    },
  ]);

  // Below a cursor; a short page with more to come is continued for the rest only.
  sdk.reset();
  sdk.reply(
    'QueryCommand',
    { Items: [entry(6), entry(5)], LastEvaluatedKey: { pk: { S: 'AUD' }, sk: entry(5).sk } },
    { Items: [entry(4), entry(3), entry(2)] }
  );
  const page = await aws.queryAudit({ before: '2026-10-10T22:15:07.000Z#r7', limit: 4 });
  assert.deepEqual(
    page.map((item) => item.sk.slice(-2)),
    ['r6', 'r5', 'r4', 'r3']
  );
  assert.deepEqual(sdk.inputs('QueryCommand'), [
    {
      TableName: 'audit-table',
      KeyConditionExpression: '#pk = :pk AND #sk < :before',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': { S: 'AUD' }, ':before': { S: '2026-10-10T22:15:07.000Z#r7' } },
      ScanIndexForward: false,
      ConsistentRead: true,
      Limit: 4,
    },
    {
      TableName: 'audit-table',
      KeyConditionExpression: '#pk = :pk AND #sk < :before',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': { S: 'AUD' }, ':before': { S: '2026-10-10T22:15:07.000Z#r7' } },
      ScanIndexForward: false,
      ConsistentRead: true,
      Limit: 2,
      ExclusiveStartKey: { pk: { S: 'AUD' }, sk: entry(5).sk },
    },
  ]);

  sdk.reply('QueryCommand', { Items: [] });
  assert.deepEqual(await aws.queryAudit({ before: undefined, limit: 50 }), []);
  sdk.reply('QueryCommand', fails('ThrottlingException'));
  await rejectsWith(aws.queryAudit({ before: null, limit: 5 }), { code: 'throttled', operation: 'Query' });
});

test('queryAudit reads what is newer than a time, and between two keys without either end', async () => {
  const aws = adapter();
  const entry = (n) => ({ pk: { S: 'AUD' }, sk: { S: `2026-10-10T22:15:0${n}.000Z#r${n}` }, outcome: { S: 'ok' } });
  sdk.reply('QueryCommand', { Items: [entry(9), entry(8)] });
  assert.equal((await aws.queryAudit({ before: null, after: '2026-10-10T22:15:07.000Z', limit: 1000 })).length, 2);
  assert.deepEqual(sdk.inputs('QueryCommand'), [
    {
      TableName: 'audit-table',
      KeyConditionExpression: '#pk = :pk AND #sk > :after',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': { S: 'AUD' }, ':after': { S: '2026-10-10T22:15:07.000Z' } },
      ScanIndexForward: false,
      ConsistentRead: true,
      Limit: 1000,
    },
  ]);

  sdk.reset();
  sdk.reply('QueryCommand', { Items: [entry(8), entry(7), entry(6), entry(5)] });
  const between = await aws.queryAudit({ before: entry(8).sk.S, after: entry(5).sk.S, limit: 10 });
  assert.deepEqual(
    between.map((item) => item.sk.slice(-2)),
    ['r7', 'r6']
  );
  assert.equal(sdk.inputs('QueryCommand')[0].KeyConditionExpression, '#pk = :pk AND #sk BETWEEN :after AND :before');
});

test('queryEvents reads one board between two keys, newest first, every page, never more than asked', async () => {
  const aws = adapter();
  const event = (n) => ({
    pk: { S: THING },
    sk: { S: `E#2026-10-10T22:15:0${n}.000Z#00000${n}` },
    kind: { S: 'firmware' },
  });
  const low = 'E#2026-10-10T00:00:00.000Z';
  const high = 'E#2026-10-11T00:00:00.000Z#~';
  sdk.reply(
    'QueryCommand',
    { Items: [event(9), event(8)], LastEvaluatedKey: { pk: { S: THING }, sk: event(8).sk } },
    { Items: [event(7), event(6)] }
  );
  assert.deepEqual(
    (await aws.queryEvents({ thing: THING, low, high, kinds: null, limit: 3 })).map((item) => item.sk.slice(-1)),
    ['9', '8', '7']
  );
  const base = {
    TableName: 'events-table',
    KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :low AND :high',
    ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
    ExpressionAttributeValues: { ':pk': { S: THING }, ':low': { S: low }, ':high': { S: high } },
    ScanIndexForward: false,
  };
  assert.deepEqual(sdk.inputs('QueryCommand'), [
    { ...base, Limit: 3 },
    { ...base, Limit: 1, ExclusiveStartKey: { pk: { S: THING }, sk: event(8).sk } },
  ]);

  // With kinds, DynamoDB filters, and its Limit would count what it read: there is none.
  sdk.reset();
  sdk.reply(
    'QueryCommand',
    { Items: [event(5)], LastEvaluatedKey: { pk: { S: THING }, sk: event(1).sk } },
    { Items: [] }
  );
  assert.equal(
    (await aws.queryEvents({ thing: THING, low, high, kinds: ['firmware', 'update'], limit: 10 })).length,
    1
  );
  const [filtered, next] = sdk.inputs('QueryCommand');
  assert.equal(filtered.FilterExpression, '#kind IN (:k0, :k1)');
  assert.deepEqual(filtered.ExpressionAttributeNames, { '#pk': 'pk', '#sk': 'sk', '#kind': 'kind' });
  assert.deepEqual(filtered.ExpressionAttributeValues[':k1'], { S: 'update' });
  assert.equal(Object.hasOwn(filtered, 'Limit'), false);
  assert.deepEqual(next.ExclusiveStartKey, { pk: { S: THING }, sk: event(1).sk });

  await assert.rejects(aws.queryEvents({ thing: THING, low, high, kinds: [], limit: 1 }), TypeError);
  await assert.rejects(aws.queryEvents({ thing: THING, low, high, tags: [], limit: 1 }), TypeError);

  // The board log narrows by source as well, both filters at once.
  sdk.reset();
  sdk.reply('QueryCommand', { Items: [] });
  await aws.queryEvents({ thing: THING, low, high, kinds: ['health'], tags: ['WIFI', 'net'], limit: 10 });
  const [both] = sdk.inputs('QueryCommand');
  assert.equal(both.FilterExpression, '#kind IN (:k0) AND #tag IN (:t0, :t1)');
  assert.deepEqual(both.ExpressionAttributeNames, { '#pk': 'pk', '#sk': 'sk', '#kind': 'kind', '#tag': 'tag' });
  assert.deepEqual(
    [both.ExpressionAttributeValues[':t0'], both.ExpressionAttributeValues[':t1']],
    [{ S: 'WIFI' }, { S: 'net' }]
  );

  sdk.reply('QueryCommand', fails('ThrottlingException'));
  await rejectsWith(aws.queryEvents({ thing: THING, low, high, kinds: null, limit: 5 }), {
    code: 'throttled',
    operation: 'Query',
  });
});

test("a board's facts of the update history are read whole and consistently, and put on a condition", async () => {
  const aws = adapter();
  const fact = (sk) => ({
    pk: { S: `UPD#${THING}` },
    sk: { S: sk },
    fact: { S: 'confirmed' },
    at: { N: '1793985600000' },
  });
  sdk.reply(
    'QueryCommand',
    { Items: [fact('C#1')], LastEvaluatedKey: { pk: { S: `UPD#${THING}` }, sk: { S: 'C#1' } } },
    { Items: [fact('C#2')] }
  );
  assert.deepEqual(
    (await aws.queryUpdateFacts(THING)).map((item) => [item.pk, item.sk, item.at]),
    [
      [`UPD#${THING}`, 'C#1', 1793985600000],
      [`UPD#${THING}`, 'C#2', 1793985600000],
    ]
  );
  const [first, second] = sdk.inputs('QueryCommand');
  assert.deepEqual(first, {
    TableName: 'events-table',
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': 'pk' },
    ExpressionAttributeValues: { ':pk': { S: `UPD#${THING}` } },
    ConsistentRead: true,
  });
  assert.deepEqual(second.ExclusiveStartKey, { pk: { S: `UPD#${THING}` }, sk: { S: 'C#1' } });
  sdk.reply('QueryCommand', fails('ThrottlingException'));
  await rejectsWith(aws.queryUpdateFacts(THING), { code: 'throttled', operation: 'Query' });

  sdk.reset();
  sdk.reply('PutItemCommand', {}, fails('ConditionalCheckFailedException'));
  const item = { pk: `UPD#${THING}`, sk: 'M#backfill', fact: 'backfill', at: 1793985600000, facts: 3, oldest: null };
  assert.deepEqual(await aws.putUpdateFact(item), { ok: true });
  assert.deepEqual(await aws.putUpdateFact(item), { ok: false, reason: 'kept' });
  const [put] = sdk.inputs('PutItemCommand');
  assert.equal(put.TableName, 'events-table');
  assert.equal(put.ConditionExpression, 'attribute_not_exists(#sk) OR #at > :at');
  assert.deepEqual(put.Item.oldest, { NULL: true });
  // Never into a board's own partition of events.
  await assert.rejects(aws.putUpdateFact({ ...item, pk: THING }), TypeError);
});

test('querySamples reads one board between two keys, oldest first, every page', async () => {
  const aws = adapter();
  const sample = (n) => ({ pk: { S: THING }, sk: { S: `S#2026-10-10T22:15:0${n}.000Z` }, rssi: { N: '-50' } });
  sdk.reply(
    'QueryCommand',
    { Items: [sample(1)], LastEvaluatedKey: { pk: { S: THING }, sk: sample(1).sk } },
    { Items: [sample(2)] }
  );
  const items = await aws.querySamples({
    thing: THING,
    low: 'S#2026-10-10T00:00:00.000Z',
    high: 'S#2026-10-11T00:00:00.000Z~',
  });
  assert.deepEqual(items, [
    { pk: THING, sk: 'S#2026-10-10T22:15:01.000Z', rssi: -50 },
    { pk: THING, sk: 'S#2026-10-10T22:15:02.000Z', rssi: -50 },
  ]);
  const [first] = sdk.inputs('QueryCommand');
  assert.equal(first.ScanIndexForward, true);
  assert.equal(Object.hasOwn(first, 'Limit'), false);
  assert.equal(first.TableName, 'events-table');
  sdk.reply('QueryCommand', fails('InternalServerError', { status: 500 }));
  await rejectsWith(aws.querySamples({ thing: THING, low: 'S#', high: 'S#~' }), { code: 'failed', operation: 'Query' });
});

test("the recorder's adapter has one client, one table and one operation: PutItem", async () => {
  const env = { AWS_REGION: 'eu-west-1', EVENTS_TABLE: 'events-table' };
  sdk.reset();
  sdk.clients.length = 0;
  const store = createEventStore(env);
  assert.deepEqual(
    sdk.clients.map((client) => client.package),
    ['@aws-sdk/client-dynamodb']
  );
  assert.deepEqual(Object.keys(sdk.clients[0].config).sort(), ['maxAttempts', 'region', 'requestHandler']);
  assert.equal(Object.isFrozen(store), true);
  assert.deepEqual(Object.keys(store), ['putUpdateFact', 'putEvent', 'claimLine']);
  // It needs nothing but these two: not the other tables, the bucket or the pool.
  for (const name of Object.keys(env)) assert.throws(() => createEventStore({ ...env, [name]: '' }), new RegExp(name));

  sdk.reply('PutItemCommand', {});
  await store.putEvent({
    pk: THING,
    sk: 'E#2026-10-10T22:15:00.000Z#abcdef',
    kind: 'firmware',
    confirmed: true,
    progress: 40,
  });
  assert.deepEqual(sdk.inputs('PutItemCommand'), [
    {
      TableName: 'events-table',
      Item: {
        pk: { S: THING },
        sk: { S: 'E#2026-10-10T22:15:00.000Z#abcdef' },
        kind: { S: 'firmware' },
        confirmed: { BOOL: true },
        progress: { N: '40' },
      },
    },
  ]);
  sdk.reply('PutItemCommand', fails('ProvisionedThroughputExceededException'));
  await rejectsWith(store.putEvent({ pk: THING, sk: 'S#x' }), { code: 'throttled', operation: 'PutItem' });

  // A fact of the update history (lib/updates.mjs): a PutItem on a condition that keeps the first time it was said.
  sdk.reset();
  sdk.reply('PutItemCommand', {}, fails('ConditionalCheckFailedException'), fails('ThrottlingException'));
  const fact = {
    pk: `UPD#${THING}`,
    sk: 'C#2026-11-05T17:20:00.000Z',
    fact: 'confirmed',
    at: 1793985600000,
    version: '1.13.0+0',
  };
  assert.deepEqual(await store.putUpdateFact(fact), { ok: true });
  assert.deepEqual(sdk.inputs('PutItemCommand')[0], {
    TableName: 'events-table',
    Item: {
      pk: { S: `UPD#${THING}` },
      sk: { S: 'C#2026-11-05T17:20:00.000Z' },
      fact: { S: 'confirmed' },
      at: { N: '1793985600000' },
      version: { S: '1.13.0+0' },
    },
    ConditionExpression: 'attribute_not_exists(#sk) OR #at > :at',
    ExpressionAttributeNames: { '#sk': 'sk', '#at': 'at' },
    ExpressionAttributeValues: { ':at': { N: '1793985600000' } },
  });
  assert.deepEqual(await store.putUpdateFact(fact), { ok: false, reason: 'kept' });
  await rejectsWith(store.putUpdateFact(fact), { code: 'throttled', operation: 'PutItem' });
  // Only into a partition of facts, and only with its time.
  await assert.rejects(store.putUpdateFact({ ...fact, pk: THING }), TypeError);
  await assert.rejects(store.putUpdateFact({ ...fact, at: '1793985600000' }), TypeError);

  // The claim of a line of a board's log: a PutItem too, on a condition, and nothing else.
  sdk.reset();
  sdk.reply('PutItemCommand', {}, fails('ConditionalCheckFailedException'), fails('ThrottlingException'));
  const claim = { pk: THING, sk: 'K#42.17', at: 1793534400123, ttl: 1801310400 };
  assert.deepEqual(await store.claimLine(claim), { ok: true });
  assert.deepEqual(sdk.inputs('PutItemCommand')[0], {
    TableName: 'events-table',
    Item: { pk: { S: THING }, sk: { S: 'K#42.17' }, at: { N: '1793534400123' }, ttl: { N: '1801310400' } },
    ConditionExpression: 'attribute_not_exists(#sk) OR #at = :at OR #at < :low OR #at > :high',
    ExpressionAttributeNames: { '#sk': 'sk', '#at': 'at' },
    ExpressionAttributeValues: {
      ':at': { N: '1793534400123' },
      ':low': { N: '1793534390123' },
      ':high': { N: '1793534410123' },
    },
  });
  assert.deepEqual(await store.claimLine(claim), { ok: false, reason: 'same_line' });
  await rejectsWith(store.claimLine(claim), { code: 'throttled', operation: 'PutItem' });

  // Its twin in the stand-in has the same methods.
  assert.deepEqual(Object.keys(createFakeAws().eventStore()), Object.keys(store));
});

test("the recorder's entry point records a board's report through its adapter", async () => {
  Object.assign(process.env, {
    AWS_REGION: 'eu-west-1',
    EVENTS_TABLE: 'events-table',
    ALERT_TOPIC_ARN: 'arn:aws:sns:eu-west-1:000000000000:alerts',
  });
  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(JSON.parse(line));
  try {
    const { handler } = await import('../src/events.mjs');
    sdk.reset();
    sdk.reply('PutItemCommand', {}, {});
    const result = await handler({
      previous: { state: { reported: { uptime: 900 } } },
      current: { state: { reported: { uptime: 3, wifi: { rssi: -60 } } } },
      timestamp: Math.floor(Date.now() / 1000),
      thing: THING,
    });
    assert.deepEqual(result, { recorded: 2 });
  } finally {
    console.log = realLog;
  }
  assert.deepEqual(
    sdk.inputs('PutItemCommand').map((input) => [input.TableName, input.Item.sk.S.slice(0, 2)]),
    [
      ['events-table', 'E#'],
      ['events-table', 'S#'],
    ]
  );
  assert.deepEqual(
    lines.map((line) => line.event),
    ['recorded']
  );
});

test('getUser asks the pool by sub and reports enabled, status and address', async () => {
  const aws = adapter();
  const sub = '11111111-2222-4333-8444-555555555555';
  sdk.reply('AdminGetUserCommand', {
    Username: sub,
    UserAttributes: [
      { Name: 'sub', Value: sub },
      { Name: 'email_verified', Value: 'true' },
      { Name: 'email', Value: 'address' },
    ],
    Enabled: true,
    UserStatus: 'CONFIRMED',
    UserCreateDate: new Date(T0),
    UserMFASettingList: ['SOFTWARE_TOKEN_MFA'],
  });
  assert.deepEqual(await aws.getUser(sub), { enabled: true, status: 'CONFIRMED', email: 'address', name: '' });
  assert.deepEqual(sdk.inputs('AdminGetUserCommand'), [{ UserPoolId: 'eu-west-1_Pool', Username: sub }]);
  assert.equal(sdk.sent[0].package, '@aws-sdk/client-cognito-identity-provider');

  sdk.reply('AdminGetUserCommand', { Username: sub, Enabled: false, UserStatus: 'FORCE_CHANGE_PASSWORD' });
  assert.deepEqual(await aws.getUser(sub), { enabled: false, status: 'FORCE_CHANGE_PASSWORD', email: '', name: '' });
  // Only a literal true counts as enabled.
  sdk.reply('AdminGetUserCommand', { Username: sub, UserStatus: 'CONFIRMED' });
  assert.deepEqual(await aws.getUser(sub), { enabled: false, status: 'CONFIRMED', email: '', name: '' });
  // The name an account has: its given name, else its name, the first word of it.
  sdk.reply('AdminGetUserCommand', {
    Username: sub,
    Enabled: true,
    UserStatus: 'CONFIRMED',
    UserAttributes: [
      { Name: 'email', Value: 'vihaan1@x.invalid' },
      { Name: 'name', Value: 'V. Ravishankar' },
      { Name: 'given_name', Value: 'vihaan' },
    ],
  });
  assert.equal((await aws.getUser(sub)).name, 'Vihaan');
  sdk.reply('AdminGetUserCommand', {
    Username: sub,
    Enabled: true,
    UserStatus: 'CONFIRMED',
    UserAttributes: [{ Name: 'name', Value: 'Ada Lovelace' }],
  });
  assert.equal((await aws.getUser(sub)).name, 'Ada');

  sdk.reply('AdminGetUserCommand', fails('UserNotFoundException'));
  assert.equal(await aws.getUser(sub), null);
  sdk.reply('AdminGetUserCommand', fails('TooManyRequestsException'));
  await rejectsWith(aws.getUser(sub), { code: 'throttled', operation: 'AdminGetUser' });
  // A missing pool or missing permission is a failure, never "no such user".
  for (const name of ['ResourceNotFoundException', 'NotAuthorizedException', 'InternalErrorException']) {
    sdk.reply('AdminGetUserCommand', fails(name));
    await rejectsWith(aws.getUser(sub), { code: 'failed', operation: 'AdminGetUser', awsError: name });
  }
});

test("listUserGroups reads every page of the user's groups", async () => {
  const aws = adapter();
  const sub = '11111111-2222-4333-8444-555555555555';
  sdk.reply(
    'AdminListGroupsForUserCommand',
    { Groups: [{ GroupName: 'viewers', UserPoolId: 'eu-west-1_Pool' }], NextToken: 'more' },
    { Groups: [{ GroupName: 'release-managers' }, { Description: 'no name' }] }
  );
  assert.deepEqual(await aws.listUserGroups(sub), ['viewers', 'release-managers']);
  assert.deepEqual(sdk.inputs('AdminListGroupsForUserCommand'), [
    { UserPoolId: 'eu-west-1_Pool', Username: sub, Limit: 60 },
    { UserPoolId: 'eu-west-1_Pool', Username: sub, Limit: 60, NextToken: 'more' },
  ]);

  sdk.reply('AdminListGroupsForUserCommand', {});
  assert.deepEqual(await aws.listUserGroups(sub), []);
  sdk.reply('AdminListGroupsForUserCommand', fails('UserNotFoundException'));
  assert.deepEqual(await aws.listUserGroups(sub), []);
  sdk.reply('AdminListGroupsForUserCommand', fails('InternalErrorException', { status: 500 }));
  await rejectsWith(aws.listUserGroups(sub), { code: 'failed', operation: 'AdminListGroupsForUser' });
});

test('results never contain SDK objects', async () => {
  const aws = adapter();
  sdk.reply('ListJobsCommand', {
    jobs: [{ jobId: JOB, status: 'IN_PROGRESS', createdAt: new Date(T0) }],
    $metadata: { httpStatusCode: 200 },
  });
  sdk.reply('DescribeJobCommand', {
    job: { jobId: JOB, status: 'IN_PROGRESS', createdAt: new Date(T0), targets: [THING_ARN] },
    $metadata: {},
  });
  sdk.reply('ListJobExecutionsForJobCommand', {
    executionSummaries: [{ thingArn: THING_ARN, jobExecutionSummary: { status: 'QUEUED', queuedAt: new Date(T0) } }],
  });
  sdk.reply('DescribeJobExecutionCommand', {
    execution: { status: 'QUEUED', queuedAt: new Date(T0), statusDetails: { detailsMap: {} } },
  });
  sdk.reply('ListJobExecutionsForThingCommand', {
    executionSummaries: [{ jobId: JOB, jobExecutionSummary: { status: 'QUEUED', queuedAt: new Date(T0) } }],
  });
  sdk.reply('GetItemCommand', { Item: RELEASE_ITEM, $metadata: {} });
  const results = [
    await aws.listJobs(),
    await aws.describeJob(JOB),
    await aws.listJobExecutionsForJob(JOB),
    await aws.describeJobExecution(JOB, THING),
    await aws.listJobExecutionsForThing(THING),
    await aws.getRelease(SK),
  ];
  const plain = (value) => {
    if (value === null || typeof value !== 'object') return typeof value !== 'function';
    if (Array.isArray(value)) return value.every(plain);
    return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(plain);
  };
  for (const result of results) {
    assert.ok(plain(result), JSON.stringify(result));
    // It survives JSON unchanged: no dates, no undefined, no classes.
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.equal(JSON.stringify(result).includes('$metadata'), false);
  }
});

test('the fake answers in the same shapes as the adapter', async () => {
  const aws = adapter();
  const fake = createFakeAws({ now: () => T0 });
  fake.addThing(THING, { certificates: ['ab'.repeat(32)] });
  const keys = (value) => Object.keys(value).sort();
  const job = {
    jobId: JOB,
    things: [THING],
    document: '{}',
    description: 'x',
    urlExpiresInSec: 600,
    inProgressTimeoutMinutes: 30,
  };

  sdk.reply('CreateJobCommand', {}, fails('ResourceAlreadyExistsException'), fails('ResourceNotFoundException'));
  assert.deepEqual(await fake.createJob(job), await aws.createJob(job));
  assert.deepEqual(await fake.createJob(job), await aws.createJob(job));
  assert.deepEqual(
    await fake.createJob({ ...job, jobId: 'another', things: ['cranium-00000000000000ff'] }),
    await aws.createJob(job)
  );

  const summary = { status: 'QUEUED', queuedAt: new Date(T0), lastUpdatedAt: new Date(T0), executionNumber: 1 };
  sdk.reply('ListJobsCommand', {
    jobs: [{ jobId: JOB, status: 'IN_PROGRESS', createdAt: new Date(T0), lastUpdatedAt: new Date(T0) }],
  });
  assert.deepEqual(await fake.listJobs(), await aws.listJobs());
  sdk.reply(
    'DescribeJobCommand',
    {
      job: {
        jobId: JOB,
        status: 'IN_PROGRESS',
        description: 'x',
        targets: [THING_ARN],
        createdAt: new Date(T0),
        lastUpdatedAt: new Date(T0),
        jobProcessDetails: { numberOfQueuedThings: 1 },
      },
    },
    fails('ResourceNotFoundException')
  );
  assert.deepEqual(await fake.describeJob(JOB), await aws.describeJob(JOB));
  assert.deepEqual(await fake.describeJob('unknown'), await aws.describeJob('unknown'));
  sdk.reply('ListJobExecutionsForJobCommand', {
    executionSummaries: [{ thingArn: THING_ARN, jobExecutionSummary: summary }],
  });
  assert.deepEqual(await fake.listJobExecutionsForJob(JOB), await aws.listJobExecutionsForJob(JOB));
  sdk.reply(
    'DescribeJobExecutionCommand',
    { execution: { ...summary, forceCanceled: false, statusDetails: { detailsMap: {} } } },
    fails('ResourceNotFoundException')
  );
  assert.deepEqual(await fake.describeJobExecution(JOB, THING), await aws.describeJobExecution(JOB, THING));
  assert.deepEqual(await fake.describeJobExecution('unknown', THING), await aws.describeJobExecution('unknown', THING));
  sdk.reply('ListJobExecutionsForThingCommand', { executionSummaries: [{ jobId: JOB, jobExecutionSummary: summary }] });
  assert.deepEqual(await fake.listJobExecutionsForThing(THING), await aws.listJobExecutionsForThing(THING));
  sdk.reply('ListThingPrincipalsCommand', {
    principals: [`arn:aws:iot:us-east-1:000000000000:cert/${'ab'.repeat(32)}`],
  });
  assert.deepEqual(await fake.listThingPrincipals(THING), await aws.listThingPrincipals(THING));
  sdk.reply('ListThingsInThingGroupCommand', { things: [THING] });
  assert.deepEqual(await fake.listGroupThings(), await aws.listGroupThings());
  sdk.reply('GetThingShadowCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.deepEqual(await fake.getShadow(THING), await aws.getShadow(THING));

  const cancel = { jobId: JOB, force: true, reasonCode: 'CONSOLE_CANCEL', comment: 'who' };
  sdk.reply('CancelJobCommand', {}, fails('InvalidRequestException'), fails('ResourceNotFoundException'));
  assert.deepEqual(await fake.cancelJob(cancel), await aws.cancelJob(cancel));
  assert.deepEqual(keys(await fake.cancelJob(cancel)), keys(await aws.cancelJob(cancel)));
  assert.deepEqual(await fake.cancelJob({ ...cancel, jobId: 'unknown' }), await aws.cancelJob(cancel));

  const body = Buffer.from('image');
  const put = { key: 'firmware/x.bin', body, sha256Base64: createHash('sha256').update(body).digest('base64') };
  sdk.reply('PutObjectCommand', {}, fails('PreconditionFailed', { status: 412 }));
  assert.deepEqual(await fake.putFirmwareObject(put), await aws.putFirmwareObject(put));
  assert.deepEqual(await fake.putFirmwareObject(put), await aws.putFirmwareObject(put));
  sdk.reply('PutObjectTaggingCommand', {}, fails('NoSuchKey', { status: 404 }));
  assert.deepEqual(await fake.tagFirmwareRevoked(put.key), await aws.tagFirmwareRevoked(put.key));
  assert.deepEqual(
    await fake.tagFirmwareRevoked('firmware/none.bin'),
    await aws.tagFirmwareRevoked('firmware/none.bin')
  );

  const pointer = { pk: { S: 'META' }, sk: { S: 'HIGHEST' }, highest: { S: SK } };
  sdk.reply(
    'TransactWriteItemsCommand',
    {},
    fails('TransactionCanceledException', {
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'ConditionalCheckFailed' }],
    }),
    fails('TransactionCanceledException', {
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed', Item: pointer }],
    })
  );
  assert.deepEqual(
    await fake.registerRelease({ sk: SK, release: RELEASE }),
    await aws.registerRelease({ sk: SK, release: RELEASE })
  );
  assert.deepEqual(
    await fake.registerRelease({ sk: SK, release: RELEASE }),
    await aws.registerRelease({ sk: SK, release: RELEASE })
  );
  const older = { sk: '001.000.00000.0000000000', release: { ...RELEASE, version: '1.0.0+0' } };
  assert.deepEqual(await fake.registerRelease(older), await aws.registerRelease(older));
  sdk.reply('GetItemCommand', { Item: RELEASE_ITEM }, {});
  assert.deepEqual(await fake.getRelease(SK), await aws.getRelease(SK));
  assert.deepEqual(await fake.getRelease('none'), await aws.getRelease('none'));
  sdk.reply('QueryCommand', { Items: [RELEASE_ITEM] });
  assert.deepEqual(await fake.listReleases(), await aws.listReleases());

  const revoked = { by: { sub: 'who', email: 'address' }, at: '2026-10-11T08:00:00.000Z', reason: 'bad build' };
  sdk.reply(
    'UpdateItemCommand',
    {
      Attributes: {
        ...RELEASE_ITEM,
        status: { S: 'revoked' },
        revoked: {
          M: {
            by: { M: { sub: { S: 'who' }, email: { S: 'address' } } },
            at: { S: revoked.at },
            reason: { S: revoked.reason },
          },
        },
      },
    },
    fails('ConditionalCheckFailedException')
  );
  assert.deepEqual(
    await fake.markReleaseRevoked({ sk: SK, revoked }),
    await aws.markReleaseRevoked({ sk: SK, revoked })
  );
  assert.deepEqual(
    await fake.markReleaseRevoked({ sk: SK, revoked }),
    await aws.markReleaseRevoked({ sk: SK, revoked })
  );

  const at = '2026-10-11T08:00:02.500Z';
  sdk.reply(
    'UpdateItemCommand',
    {
      Attributes: {
        ...RELEASE_ITEM,
        status: { S: 'revoked' },
        revoked: {
          M: {
            by: { M: { sub: { S: 'who' }, email: { S: 'address' } } },
            at: { S: revoked.at },
            reason: { S: revoked.reason },
            enforcedAt: { S: at },
          },
        },
      },
    },
    fails('ConditionalCheckFailedException'),
    fails('ConditionalCheckFailedException')
  );
  assert.deepEqual(await fake.markRevocationEnforced({ sk: SK, at }), await aws.markRevocationEnforced({ sk: SK, at }));
  assert.deepEqual(await fake.markRevocationEnforced({ sk: SK, at }), await aws.markRevocationEnforced({ sk: SK, at }));
  assert.deepEqual(
    await fake.markRevocationEnforced({ sk: 'none', at }),
    await aws.markRevocationEnforced({ sk: 'none', at })
  );

  const item = {
    sk: '2026-10-10T22:15:00.000Z#r1',
    action: 'firmware.upload',
    outcome: 'ok',
    actor: { sub: 'who', email: '' },
  };
  sdk.reply('PutItemCommand', {}, fails('ConditionalCheckFailedException'));
  assert.deepEqual(await fake.putAudit(item), await aws.putAudit(item));
  assert.deepEqual(await fake.putAudit(item), await aws.putAudit(item));
  sdk.reply('QueryCommand', {
    Items: [
      {
        pk: { S: 'AUD' },
        sk: { S: item.sk },
        action: { S: item.action },
        outcome: { S: 'ok' },
        actor: { M: { sub: { S: 'who' }, email: { S: '' } } },
      },
    ],
  });
  assert.deepEqual(await fake.queryAudit({ before: null, limit: 5 }), await aws.queryAudit({ before: null, limit: 5 }));

  const stored = {
    pk: THING,
    sk: 'E#2026-10-10T22:15:00.000Z#abcdef',
    kind: 'firmware',
    what: 'changed',
    ttl: 1800000000,
  };
  await fake.eventStore().putEvent(stored);
  await fake.eventStore().putEvent({ pk: THING, sk: 'S#2026-10-10T22:15:00.000Z', rssi: -50 });
  sdk.reply(
    'QueryCommand',
    {
      Items: [
        {
          pk: { S: THING },
          sk: { S: stored.sk },
          kind: { S: 'firmware' },
          what: { S: 'changed' },
          ttl: { N: '1800000000' },
        },
      ],
    },
    { Items: [{ pk: { S: THING }, sk: { S: 'S#2026-10-10T22:15:00.000Z' }, rssi: { N: '-50' } }] }
  );
  const range = { thing: THING, low: 'E#2026-10-10', high: 'E#2026-10-11', kinds: null, limit: 5 };
  assert.deepEqual(await fake.queryEvents(range), await aws.queryEvents(range));
  const samples = { thing: THING, low: 'S#2026-10-10', high: 'S#2026-10-11' };
  assert.deepEqual(await fake.querySamples(samples), await aws.querySamples(samples));

  fake.addUser({ sub: 'who', email: 'address', groups: ['viewers'] });
  sdk.reply(
    'AdminGetUserCommand',
    { Enabled: true, UserStatus: 'CONFIRMED', UserAttributes: [{ Name: 'email', Value: 'address' }] },
    fails('UserNotFoundException')
  );
  assert.deepEqual(await fake.getUser('who'), await aws.getUser('who'));
  assert.deepEqual(await fake.getUser('nobody'), await aws.getUser('nobody'));
  sdk.reply('AdminListGroupsForUserCommand', { Groups: [{ GroupName: 'viewers' }] }, fails('UserNotFoundException'));
  assert.deepEqual(await fake.listUserGroups('who'), await aws.listUserGroups('who'));
  assert.deepEqual(await fake.listUserGroups('nobody'), await aws.listUserGroups('nobody'));

  // The fake fails the way the adapter does.
  fake.failNext('listJobs', { code: 'throttled' });
  await rejectsWith(fake.listJobs(), { code: 'throttled', operation: 'listJobs' });
});

test("the Lambda entry point serves a viewer's reads through the adapter", async () => {
  // index.mjs reads the environment when it is loaded, as it does at a cold start.
  Object.assign(process.env, fakeEnv());
  const lines = [];
  console.log = (line) => lines.push(JSON.parse(line));
  let responses;
  try {
    const { handler } = await import('../src/index.mjs');
    assert.equal(typeof handler, 'function');
    sdk.reset();
    sdk.reply('ListThingsInThingGroupCommand', { things: [THING] });
    sdk.reply('GetThingShadowCommand', fails('ResourceNotFoundException', { status: 404 }));
    // The names given in the console (src/lib/names.mjs), the positions of the boards (src/aws-map.mjs), what the
    // board that never reported is, and the activity log's two partitions: the console's and the customers'.
    sdk.reply('QueryCommand', { Items: [] }, { Items: [] }, { Items: [] }, { Items: [] }, { Items: [] });
    sdk.reply('DescribeThingCommand', { attributes: {} });
    sdk.reply('ListJobsCommand', { jobs: [] });
    sdk.reply('AdminGetUserCommand', {
      Enabled: true,
      UserStatus: 'CONFIRMED',
      UserAttributes: [{ Name: 'email', Value: 'viewer@example.org' }],
    });
    sdk.reply('AdminListGroupsForUserCommand', { Groups: [{ GroupName: 'viewers' }] });
    const claims = accessClaims({ sub: '11111111-2222-4333-8444-555555555555', groups: ['viewers'] });
    responses = [];
    for (const path of ['/api/devices', '/api/firmware', '/api/deployments', '/api/audit']) {
      responses.push(await handler(apiEvent('GET', path, { claims })));
    }
  } finally {
    console.log = realLog;
  }
  assert.deepEqual(
    responses.map((response) => response.statusCode),
    [200, 200, 200, 200]
  );
  assert.deepEqual(JSON.parse(responses[0].body).devices, [
    {
      thing: THING,
      name: null,
      online: false,
      lastSeen: null,
      fw: null,
      ota: null,
      rssi: null,
      uptime: null,
      stuck: null,
      diag: null,
      diary: null,
      bt: null,
      label: null,
      position: null,
      location: { status: 'none', at: null, apCount: null, checkedAt: null, bluetoothOnly: false },
    },
  ]);
  assert.deepEqual(JSON.parse(responses[1].body).releases, []);
  assert.deepEqual(JSON.parse(responses[2].body), { deployments: [] });
  assert.deepEqual(JSON.parse(responses[3].body), { entries: [], next: null });

  // What a viewer's reads ask of AWS: nothing that writes, and Cognito once for all four.
  assert.deepEqual(
    sdk.sent.map((entry) => entry.command),
    [
      'AdminGetUserCommand',
      'AdminListGroupsForUserCommand',
      'ListThingsInThingGroupCommand',
      'GetThingShadowCommand',
      'QueryCommand',
      'QueryCommand',
      'DescribeThingCommand',
      'QueryCommand',
      'ListJobsCommand',
      'QueryCommand',
      'QueryCommand',
    ]
  );
  // The first is the boards' names given in the console (pk NAME of the state table).
  assert.deepEqual(
    sdk.inputs('QueryCommand').map((input) => input.TableName),
    ['local-state', 'local-events', 'local-state', 'local-audit', 'local-audit']
  );
  assert.equal(sdk.inputs('QueryCommand')[0].ExpressionAttributeValues[':pk'].S, 'NAME');
  assert.deepEqual(
    sdk
      .inputs('QueryCommand')
      .slice(3)
      .map((input) => input.ExpressionAttributeValues[':pk'].S),
    ['AUD', 'CUS']
  );
  assert.deepEqual(sdk.inputs('ListThingsInThingGroupCommand')[0].thingGroupName, 'cranium-devices');
  assert.deepEqual(
    lines.map((line) => [line.route, line.status]),
    [
      ['GET /api/devices', 200],
      ['GET /api/firmware', 200],
      ['GET /api/deployments', 200],
      ['GET /api/audit', 200],
    ]
  );
});

// The fleet: a thing's attributes, the records of groups, rollouts and sightings, a release's note,
// and a job's pacing and stop (docs/fleet.md).

test("describeThing reads a thing's attributes, and nothing for an unknown thing", async () => {
  const aws = adapter();
  sdk.reply(
    'DescribeThingCommand',
    { thingName: THING, attributes: { board: 'nrf5340dk', other: 7 } },
    fails('ResourceNotFoundException', { status: 404 }),
    fails('ThrottlingException')
  );
  assert.deepEqual(await aws.describeThing(THING), { attributes: { board: 'nrf5340dk' } });
  assert.deepEqual(sdk.inputs('DescribeThingCommand'), [{ thingName: THING }]);
  assert.equal(await aws.describeThing(THING), null);
  await rejectsWith(aws.describeThing(THING), { code: 'throttled', operation: 'DescribeThing' });
});

test("createJob passes a wave's pacing and its stop on to AWS as they are", async () => {
  const aws = adapter();
  const rollout = {
    maximumPerMinute: 50,
    exponentialRate: { baseRatePerMinute: 1, incrementFactor: 2, rateIncreaseCriteria: { numberOfSucceededThings: 1 } },
  };
  const abort = {
    criteriaList: [{ failureType: 'ALL', action: 'CANCEL', thresholdPercentage: 20, minNumberOfExecutedThings: 1 }],
  };
  sdk.reply('CreateJobCommand', {});
  await aws.createJob({
    jobId: JOB,
    things: [THING],
    document: '{}',
    description: '{}',
    urlExpiresInSec: 600,
    inProgressTimeoutMinutes: 30,
    rollout,
    abort,
  });
  const [input] = sdk.inputs('CreateJobCommand');
  assert.deepEqual(input.jobExecutionsRolloutConfig, rollout);
  assert.deepEqual(input.abortConfig, abort);
});

test("the fleet's records stay in their three partitions, written once or only if unchanged", async () => {
  const aws = adapter();
  for (const call of [
    () => aws.getFleetItem({ pk: 'REL', sk: SK }),
    () => aws.listFleetItems('TOK'),
    () => aws.putFleetItem({ pk: 'META', sk: 'HIGHEST', item: {} }),
    () => aws.updateFleetItem({ pk: 'AUD', sk: 'x', rev: 0, set: {} }),
  ]) {
    await assert.rejects(call(), TypeError);
  }
  assert.equal(sdk.sent.length, 0);

  sdk.reply(
    'GetItemCommand',
    { Item: { pk: { S: 'GRP' }, sk: { S: 'grp-0a0b0c0d' }, name: { S: 'Bench' }, rev: { N: '2' } } },
    {}
  );
  assert.deepEqual(await aws.getFleetItem({ pk: 'GRP', sk: 'grp-0a0b0c0d' }), {
    pk: 'GRP',
    sk: 'grp-0a0b0c0d',
    name: 'Bench',
    rev: 2,
  });
  assert.equal(await aws.getFleetItem({ pk: 'GRP', sk: 'grp-0a0b0c0d' }), null);
  assert.deepEqual(sdk.inputs('GetItemCommand')[0], {
    TableName: 'state-table',
    Key: { pk: { S: 'GRP' }, sk: { S: 'grp-0a0b0c0d' } },
    ConsistentRead: true,
  });

  sdk.reply(
    'QueryCommand',
    { Items: [{ pk: { S: 'ROL' }, sk: { S: 'rol-2' } }], LastEvaluatedKey: { pk: { S: 'ROL' } } },
    { Items: [{ pk: { S: 'ROL' }, sk: { S: 'rol-1' } }] }
  );
  assert.deepEqual(
    (await aws.listFleetItems('ROL')).map((item) => item.sk),
    ['rol-2', 'rol-1']
  );
  assert.equal(sdk.inputs('QueryCommand')[0].ScanIndexForward, false);
  assert.equal(sdk.inputs('QueryCommand')[0].ConsistentRead, true);

  sdk.reply('PutItemCommand', {}, fails('ConditionalCheckFailedException'), {});
  assert.deepEqual(await aws.putFleetItem({ pk: 'GRP', sk: 'grp-1', item: { name: 'A', pk: 'x' } }), { ok: true });
  assert.deepEqual(await aws.putFleetItem({ pk: 'GRP', sk: 'grp-1', item: { name: 'A' } }), {
    ok: false,
    reason: 'exists',
  });
  assert.deepEqual(await aws.putFleetItem({ pk: 'SEEN', sk: THING, item: { version: '1.0.0+0' }, replace: true }), {
    ok: true,
  });
  const puts = sdk.inputs('PutItemCommand');
  assert.deepEqual(puts[0], {
    TableName: 'state-table',
    Item: { name: { S: 'A' }, pk: { S: 'GRP' }, sk: { S: 'grp-1' } },
    ConditionExpression: 'attribute_not_exists(#pk)',
    ExpressionAttributeNames: { '#pk': 'pk' },
  });
  // A sighting replaces the one before it: the last one is what is kept.
  assert.equal(puts[2].ConditionExpression, undefined);

  sdk.reply(
    'UpdateItemCommand',
    { Attributes: { pk: { S: 'GRP' }, sk: { S: 'grp-1' }, name: { S: 'B' }, rev: { N: '4' } } },
    fails('ConditionalCheckFailedException')
  );
  assert.deepEqual(await aws.updateFleetItem({ pk: 'GRP', sk: 'grp-1', rev: 3, set: { name: 'B' } }), {
    ok: true,
    item: { pk: 'GRP', sk: 'grp-1', name: 'B', rev: 4 },
  });
  assert.deepEqual(await aws.updateFleetItem({ pk: 'GRP', sk: 'grp-1', rev: 3, set: { name: 'B' } }), {
    ok: false,
    reason: 'changed',
  });
  assert.deepEqual(sdk.inputs('UpdateItemCommand')[0], {
    TableName: 'state-table',
    Key: { pk: { S: 'GRP' }, sk: { S: 'grp-1' } },
    UpdateExpression: 'SET #f0 = :v0, #rev = :next',
    ConditionExpression: '#rev = :rev',
    ExpressionAttributeNames: { '#rev': 'rev', '#f0': 'name' },
    ExpressionAttributeValues: { ':rev': { N: '3' }, ':next': { N: '4' }, ':v0': { S: 'B' } },
    ReturnValues: 'ALL_NEW',
  });
  await assert.rejects(aws.updateFleetItem({ pk: 'GRP', sk: 'grp-1', rev: 3, set: { rev: 9 } }), TypeError);
});

test('setReleaseNotes changes the note of a registered release and nothing else', async () => {
  const aws = adapter();
  sdk.reply(
    'UpdateItemCommand',
    { Attributes: { ...RELEASE_ITEM, notes: { S: 'Faster reconnects' } } },
    fails('ConditionalCheckFailedException')
  );
  assert.deepEqual(await aws.setReleaseNotes({ sk: SK, notes: 'Faster reconnects' }), {
    ok: true,
    release: { ...RELEASE, pk: 'REL', sk: SK, notes: 'Faster reconnects' },
  });
  assert.deepEqual(sdk.inputs('UpdateItemCommand'), [
    {
      TableName: 'state-table',
      Key: { pk: { S: 'REL' }, sk: { S: SK } },
      UpdateExpression: 'SET #notes = :notes',
      ConditionExpression: 'attribute_exists(#pk)',
      ExpressionAttributeNames: { '#notes': 'notes', '#pk': 'pk' },
      ExpressionAttributeValues: { ':notes': { S: 'Faster reconnects' } },
      ReturnValues: 'ALL_NEW',
    },
  ]);
  assert.deepEqual(await aws.setReleaseNotes({ sk: SK, notes: '' }), { ok: false, reason: 'not_found' });
});

// The customer site's adapters (src/customer/aws.mjs), held to the same reference.

const { createBoardReader, createCustomerActionLog, createCustomerStore } = await import('../src/customer/aws.mjs');
const { createFakeCustomers } = await import('./fake-customers.mjs');
const CUSTOMER_ENV = Object.freeze({ ...ENV, CUSTOMER_POOL_ID: 'eu-west-1_Customers' });
const CUSTOMER_SUB = '7ec17d2e-9ee4-4734-8901-33c8fec73372';
const cognitoUser = (status = 'CONFIRMED', enabled = true) => ({
  Username: CUSTOMER_SUB,
  Enabled: enabled,
  UserStatus: status,
  UserCreateDate: new Date(T0),
  Attributes: [
    { Name: 'sub', Value: CUSTOMER_SUB },
    { Name: 'email', Value: 'ada@example.invalid' },
    { Name: 'name', Value: 'Ada' },
  ],
});

test('the customer store invites, lists and switches customers in the customer pool, and in no other', async () => {
  sdk.reset();
  const store = createCustomerStore(CUSTOMER_ENV);
  const customer = {
    sub: CUSTOMER_SUB,
    email: 'ada@example.invalid',
    name: 'Ada',
    enabled: true,
    status: 'CONFIRMED',
    createdAt: T0,
    mfa: null,
  };

  sdk.reply(
    'ListUsersCommand',
    { Users: [cognitoUser()], PaginationToken: 'next' },
    { Users: [cognitoUser('FORCE_CHANGE_PASSWORD')] }
  );
  assert.deepEqual(await store.listCustomers(), [customer, { ...customer, status: 'FORCE_CHANGE_PASSWORD' }]);
  assert.deepEqual(
    sdk.inputs('ListUsersCommand').map((input) => input.PaginationToken),
    [undefined, 'next']
  );

  sdk.reply(
    'AdminGetUserCommand',
    { ...cognitoUser(), UserAttributes: cognitoUser().Attributes },
    fails('UserNotFoundException')
  );
  assert.deepEqual(await store.getCustomer(CUSTOMER_SUB), { ...customer, mfa: false });
  assert.equal(await store.getCustomer('nobody'), null);

  sdk.reply('AdminCreateUserCommand', { User: cognitoUser('FORCE_CHANGE_PASSWORD') }, fails('UsernameExistsException'));
  assert.deepEqual(await store.inviteCustomer({ email: 'ada@example.invalid', name: 'Ada' }), {
    ok: true,
    customer: { ...customer, status: 'FORCE_CHANGE_PASSWORD', mfa: false },
  });
  assert.deepEqual(await store.inviteCustomer({ email: 'ada@example.invalid', name: '' }), {
    ok: false,
    reason: 'exists',
  });
  const [invited, unnamed] = sdk.inputs('AdminCreateUserCommand');
  assert.deepEqual(invited, {
    UserPoolId: 'eu-west-1_Customers',
    Username: 'ada@example.invalid',
    DesiredDeliveryMediums: ['EMAIL'],
    UserAttributes: [
      { Name: 'email', Value: 'ada@example.invalid' },
      { Name: 'email_verified', Value: 'true' },
      { Name: 'name', Value: 'Ada' },
    ],
  });
  assert.equal(unnamed.UserAttributes.length, 2);
  // Cognito makes the temporary password: none is ever sent from here.
  assert.equal(Object.hasOwn(invited, 'TemporaryPassword'), false);

  sdk.reply('AdminCreateUserCommand', {}, fails('UnsupportedUserStateException'), fails('UserNotFoundException'));
  assert.deepEqual(await store.resendInvitation('ada@example.invalid'), { ok: true });
  assert.deepEqual(await store.resendInvitation('ada@example.invalid'), { ok: false, reason: 'not_invited' });
  assert.deepEqual(await store.resendInvitation('nobody@example.invalid'), { ok: false, reason: 'not_found' });
  assert.equal(sdk.inputs('AdminCreateUserCommand')[2].MessageAction, 'RESEND');

  sdk.reply('AdminDisableUserCommand', {}, fails('UserNotFoundException'));
  sdk.reply('AdminEnableUserCommand', {});
  assert.deepEqual(await store.setCustomerEnabled(CUSTOMER_SUB, false), { ok: true });
  assert.deepEqual(await store.setCustomerEnabled('nobody', false), { ok: false, reason: 'not_found' });
  assert.deepEqual(await store.setCustomerEnabled(CUSTOMER_SUB, true), { ok: true });

  // Every call names the customer pool.
  for (const entry of sdk.sent) assert.equal(entry.input.UserPoolId, 'eu-west-1_Customers', entry.command);
  sdk.reply('ListUsersCommand', fails('ThrottlingException', { status: 400 }));
  await rejectsWith(store.listCustomers(), { code: 'throttled', operation: 'ListUsers' });
});

test("a customer's password is reset by Cognito's admin reset, and an account removed is signed out first", async () => {
  sdk.reset();
  const store = createCustomerStore(CUSTOMER_ENV);
  sdk.reply('AdminGetUserCommand', {
    ...cognitoUser(),
    UserAttributes: cognitoUser().Attributes,
    UserMFASettingList: ['SOFTWARE_TOKEN_MFA'],
  });
  assert.equal((await store.getCustomer(CUSTOMER_SUB)).mfa, true);
  sdk.reply('AdminResetUserPasswordCommand', {}, fails('NotAuthorizedException'), fails('UserNotFoundException'));
  assert.deepEqual(await store.resetCustomerPassword(CUSTOMER_SUB), { ok: true });
  assert.deepEqual(await store.resetCustomerPassword(CUSTOMER_SUB), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(await store.resetCustomerPassword('nobody'), { ok: false, reason: 'not_found' });
  assert.deepEqual(sdk.inputs('AdminResetUserPasswordCommand')[0], {
    UserPoolId: 'eu-west-1_Customers',
    Username: CUSTOMER_SUB,
  });
  sdk.reply(
    'AdminUserGlobalSignOutCommand',
    {},
    fails('InternalErrorException', { status: 500 }),
    fails('UserNotFoundException')
  );
  sdk.reply('AdminDeleteUserCommand', {}, {});
  assert.deepEqual(await store.deleteCustomer(CUSTOMER_SUB), { ok: true });
  // A sign-out that fails does not keep the account.
  assert.deepEqual(await store.deleteCustomer(CUSTOMER_SUB), { ok: true });
  assert.deepEqual(await store.deleteCustomer('nobody'), { ok: false, reason: 'not_found' });
  assert.deepEqual(sdk.sent.map((entry) => entry.command).slice(-5), [
    'AdminUserGlobalSignOutCommand',
    'AdminDeleteUserCommand',
    'AdminUserGlobalSignOutCommand',
    'AdminDeleteUserCommand',
    'AdminUserGlobalSignOutCommand',
  ]);
  for (const entry of sdk.sent) {
    assert.equal(entry.input.UserPoolId, 'eu-west-1_Customers', entry.command);
    assert.equal(/Password/.test(Object.keys(entry.input).join(' ')), false, entry.command);
  }
});

// The Team page's adapter (src/aws-team.mjs), held to the same reference.

const { createTeamStore } = await import('../src/aws-team.mjs');
const TEAM_SUB = '22222222-3333-4444-8555-666666666666';
const teamUser = (status = 'CONFIRMED') => ({
  Username: TEAM_SUB,
  Enabled: true,
  UserStatus: status,
  UserCreateDate: new Date(T0),
  Attributes: [
    { Name: 'sub', Value: TEAM_SUB },
    { Name: 'email', Value: 'rm@example.invalid' },
  ],
});

test('the team store lists, invites, regroups, switches and deletes accounts in the staff pool only, never with a password', async () => {
  sdk.reset();
  const store = createTeamStore(ENV);
  const member = {
    sub: TEAM_SUB,
    email: 'rm@example.invalid',
    name: '',
    enabled: true,
    status: 'CONFIRMED',
    createdAt: T0,
    mfa: null,
  };
  sdk.reply(
    'ListUsersCommand',
    { Users: [teamUser()], PaginationToken: 'p2' },
    { Users: [teamUser('FORCE_CHANGE_PASSWORD')] }
  );
  assert.deepEqual(await store.listTeam(), [member, { ...member, status: 'FORCE_CHANGE_PASSWORD' }]);

  sdk.reply(
    'AdminGetUserCommand',
    { ...teamUser(), UserAttributes: teamUser().Attributes, UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] },
    { ...teamUser(), UserAttributes: teamUser().Attributes },
    fails('UserNotFoundException')
  );
  assert.deepEqual(await store.getTeamMember(TEAM_SUB), { ...member, mfa: true });
  assert.equal((await store.getTeamMember(TEAM_SUB)).mfa, false);
  assert.equal(await store.getTeamMember('nobody'), null);

  sdk.reply('AdminCreateUserCommand', { User: teamUser('FORCE_CHANGE_PASSWORD') }, fails('UsernameExistsException'));
  assert.deepEqual(await store.inviteTeamMember({ email: 'rm@example.invalid' }), {
    ok: true,
    member: { ...member, status: 'FORCE_CHANGE_PASSWORD', mfa: false },
  });
  assert.deepEqual(await store.inviteTeamMember({ email: 'rm@example.invalid' }), { ok: false, reason: 'exists' });
  const invited = sdk.inputs('AdminCreateUserCommand')[0];
  assert.deepEqual(invited.DesiredDeliveryMediums, ['EMAIL']);
  assert.equal(Object.hasOwn(invited, 'TemporaryPassword'), false);

  sdk.reply('AdminCreateUserCommand', {}, fails('UnsupportedUserStateException'));
  assert.deepEqual(await store.resendTeamInvitation('rm@example.invalid'), { ok: true });
  assert.deepEqual(await store.resendTeamInvitation('rm@example.invalid'), { ok: false, reason: 'not_invited' });

  sdk.reply('AdminAddUserToGroupCommand', {}, fails('UserNotFoundException'));
  sdk.reply('AdminRemoveUserFromGroupCommand', {});
  assert.deepEqual(await store.addTeamMemberToGroup(TEAM_SUB, 'release-managers'), { ok: true });
  assert.deepEqual(await store.addTeamMemberToGroup('nobody', 'viewers'), { ok: false, reason: 'not_found' });
  assert.deepEqual(await store.removeTeamMemberFromGroup(TEAM_SUB, 'viewers'), { ok: true });
  assert.deepEqual(sdk.inputs('AdminAddUserToGroupCommand')[0], {
    UserPoolId: 'eu-west-1_Pool',
    Username: TEAM_SUB,
    GroupName: 'release-managers',
  });

  sdk.reply('AdminDisableUserCommand', {});
  sdk.reply('AdminEnableUserCommand', fails('TooManyRequestsException'));
  assert.deepEqual(await store.setTeamMemberEnabled(TEAM_SUB, false), { ok: true });
  await rejectsWith(store.setTeamMemberEnabled(TEAM_SUB, true), { code: 'throttled', operation: 'AdminEnableUser' });

  sdk.reply('AdminUserGlobalSignOutCommand', {}, fails('UserNotFoundException'));
  sdk.reply('AdminDeleteUserCommand', {});
  assert.deepEqual(await store.deleteTeamMember(TEAM_SUB), { ok: true });
  assert.deepEqual(await store.deleteTeamMember('nobody'), { ok: false, reason: 'not_found' });

  for (const entry of sdk.sent) {
    assert.equal(entry.input.UserPoolId, 'eu-west-1_Pool', entry.command);
    assert.equal(/Password/.test(Object.keys(entry.input).join(' ')), false, entry.command);
  }
  assert.equal(
    sdk.sent.some((entry) => /SetUserPassword|ResetUserPassword|SetUserMFA/.test(entry.command)),
    false
  );
});

test('who owns which board: one owner, conditional writes, and the fake agrees with the store', async () => {
  sdk.reset();
  const store = createCustomerStore(CUSTOMER_ENV);
  const fake = createFakeCustomers({ now: () => T0 });
  const at = new Date(T0).toISOString();
  const assignment = { thing: THING, owner: CUSTOMER_SUB, ref: '0123456789abcdef', label: 'Deck', at, by: 'admin' };

  sdk.reply('PutItemCommand', {}, fails('ConditionalCheckFailedException'));
  assert.deepEqual(await store.assignBoard(assignment), await fake.assignBoard(assignment));
  assert.deepEqual(
    await store.assignBoard({ ...assignment, owner: 'someone else' }),
    await fake.assignBoard({ ...assignment, owner: 'someone else' })
  );
  const put = sdk.inputs('PutItemCommand')[0];
  assert.equal(put.TableName, 'state-table');
  assert.deepEqual(put.Item.pk, { S: 'OWN' });
  assert.deepEqual(put.Item.sk, { S: THING });
  assert.equal(put.ConditionExpression, 'attribute_not_exists(#sk) OR attribute_not_exists(#owner)');

  sdk.reply('QueryCommand', {
    Items: [
      {
        pk: { S: 'OWN' },
        sk: { S: THING },
        owner: { S: CUSTOMER_SUB },
        ref: { S: '0123456789abcdef' },
        label: { S: 'Deck' },
        assignedAt: { S: at },
        assignedBy: { S: 'admin' },
      },
      // Given back: no owner, so not listed.
      { pk: { S: 'OWN' }, sk: { S: 'cranium-00000000000000bb' }, unassignedAt: { S: at } },
    ],
  });
  assert.deepEqual(await store.listOwnership(), await fake.listOwnership());
  const query = sdk.inputs('QueryCommand')[0];
  assert.deepEqual(
    [query.KeyConditionExpression, query.ExpressionAttributeValues, query.ConsistentRead],
    ['#pk = :pk', { ':pk': { S: 'OWN' } }, true]
  );

  sdk.reply('UpdateItemCommand', fails('ConditionalCheckFailedException'), {});
  assert.deepEqual(
    await store.unassignBoard({ thing: THING, owner: 'someone else', at }),
    await fake.unassignBoard({ thing: THING, owner: 'someone else', at })
  );
  assert.deepEqual(
    await store.unassignBoard({ thing: THING, owner: CUSTOMER_SUB, at }),
    await fake.unassignBoard({ thing: THING, owner: CUSTOMER_SUB, at })
  );
  const update = sdk.inputs('UpdateItemCommand')[1];
  assert.equal(update.ConditionExpression, '#owner = :owner');
  assert.match(update.UpdateExpression, /^REMOVE #owner, #ref, #label/);
  // The API's role has no DeleteItem on the state table, and the store never asks for one.
  assert.equal(
    sdk.sent.some((entry) => /Delete/.test(entry.command)),
    false
  );
});

test("a customer's own name for a board and their e-mails: conditional on the owner and the id, and the fake agrees", async () => {
  sdk.reset();
  const store = createCustomerStore(CUSTOMER_ENV);
  const fake = createFakeCustomers({ now: () => T0 });
  const at = new Date(T0).toISOString();
  const ref = '0123456789abcdef';
  await fake.assignBoard({ thing: THING, owner: CUSTOMER_SUB, ref, label: 'Deck', at, by: 'admin' });

  sdk.reply('UpdateItemCommand', {}, fails('ConditionalCheckFailedException'), {});
  const named = { thing: THING, owner: CUSTOMER_SUB, ref, label: 'Kitchen', at };
  assert.deepEqual(await store.setCustomerLabel(named), await fake.setCustomerLabel(named));
  const other = { ...named, ref: 'fedcba9876543210' };
  assert.deepEqual(await store.setCustomerLabel(other), await fake.setCustomerLabel(other));
  assert.deepEqual(await store.setCustomerLabel({ ...named, label: '' }), { ok: true });
  const [set, , cleared] = sdk.inputs('UpdateItemCommand');
  assert.equal(set.TableName, 'state-table');
  assert.deepEqual(set.Key, { pk: { S: 'OWN' }, sk: { S: THING } });
  assert.equal(set.ConditionExpression, '#owner = :owner AND #ref = :ref');
  assert.equal(set.UpdateExpression, 'SET #customerLabel = :label, #labelledAt = :at');
  assert.deepEqual(set.ExpressionAttributeValues[':label'], { S: 'Kitchen' });
  assert.equal(cleared.UpdateExpression, 'REMOVE #customerLabel SET #labelledAt = :at');
  // Never the owner, the id, the admin's label or the thing name.
  for (const update of [set, cleared]) {
    assert.doesNotMatch(update.UpdateExpression, /#owner =|#ref =|#label\b|#sk/);
  }

  sdk.reply('GetItemCommand', {}, { Item: { pk: { S: 'PRF' }, sk: { S: CUSTOMER_SUB }, offline: { BOOL: true } } });
  assert.equal(await store.getPreferences(CUSTOMER_SUB), null);
  assert.deepEqual(await store.getPreferences(CUSTOMER_SUB), {
    offline: true,
    updated: false,
    unexpectedRestart: false,
    updatedAt: null,
  });
  assert.deepEqual(sdk.inputs('GetItemCommand')[0].Key, { pk: { S: 'PRF' }, sk: { S: CUSTOMER_SUB } });
  sdk.reply('UpdateItemCommand', {});
  const choice = { offline: true, updated: false, unexpectedRestart: true };
  assert.deepEqual(
    await store.setPreferences(CUSTOMER_SUB, choice, at),
    await fake.setPreferences(CUSTOMER_SUB, choice, at)
  );
  const prefs = sdk.inputs('UpdateItemCommand').at(-1);
  assert.deepEqual(prefs.Key, { pk: { S: 'PRF' }, sk: { S: CUSTOMER_SUB } });
  assert.deepEqual(prefs.ExpressionAttributeValues[':restart'], { BOOL: true });
  assert.equal(
    sdk.sent.some((entry) => /Delete|PutItem/.test(entry.command)),
    false
  );
});

test("the customer API's record of what customers did: their partition only, never over an entry", async () => {
  sdk.reset();
  assert.throws(() => createCustomerActionLog({ AWS_REGION: 'eu-west-1' }), /AUDIT_TABLE/);
  const log = createCustomerActionLog({ AWS_REGION: 'eu-west-1', AUDIT_TABLE: 'audit-table' });
  assert.deepEqual(Object.keys(log).sort(), ['putCustomerAction', 'recentCustomerActions']);
  sdk.reply('PutItemCommand', {}, fails('ConditionalCheckFailedException'));
  const item = { sk: '2026-11-09T12:00:00.000Z#r1', action: 'customer_action.rename', by: 'customer' };
  assert.deepEqual(await log.putCustomerAction(item), { ok: true });
  assert.deepEqual(await log.putCustomerAction(item), { ok: false, reason: 'exists' });
  const put = sdk.inputs('PutItemCommand')[0];
  assert.equal(put.TableName, 'audit-table');
  assert.deepEqual(put.Item.pk, { S: 'CUS' });
  assert.equal(put.ConditionExpression, 'attribute_not_exists(#pk)');

  sdk.reply(
    'QueryCommand',
    { Items: [{ sk: { S: '2026-11-09T12:00:00.000Z#r1' } }], LastEvaluatedKey: { pk: { S: 'CUS' }, sk: { S: 'x' } } },
    { Items: [{ sk: { S: '2026-11-09T12:00:01.000Z#r2' } }] }
  );
  assert.deepEqual(await log.recentCustomerActions({ sub: CUSTOMER_SUB, since: '2026-11-09T11:00:00.000Z' }), [
    '2026-11-09T12:00:00.000Z#r1',
    '2026-11-09T12:00:01.000Z#r2',
  ]);
  const query = sdk.inputs('QueryCommand')[0];
  assert.equal(query.KeyConditionExpression, '#pk = :pk AND #sk >= :since');
  assert.deepEqual(query.ExpressionAttributeValues[':pk'], { S: 'CUS' });
  assert.deepEqual(query.ExpressionAttributeValues[':sub'], { S: CUSTOMER_SUB });
  assert.equal(query.FilterExpression, '#actor.#sub = :sub');
});

test("the customer API's board reader reads a shadow and a board's events, and nothing else", async () => {
  sdk.reset();
  const reader = createBoardReader({ AWS_REGION: 'eu-west-1', EVENTS_TABLE: 'events-table' });
  assert.deepEqual(Object.keys(reader).sort(), ['getShadow', 'queryEvents']);
  sdk.reply(
    'GetThingShadowCommand',
    { payload: new TextEncoder().encode('{"state":{"reported":{"uptime":5}}}') },
    fails('ResourceNotFoundException', { status: 404 })
  );
  assert.deepEqual(await reader.getShadow(THING), { state: { reported: { uptime: 5 } } });
  assert.equal(await reader.getShadow(THING), null);
  sdk.reply('QueryCommand', {
    Items: [{ pk: { S: THING }, sk: { S: 'E#2026-10-10T22:15:00.000Z#abcdef' }, kind: { S: 'connection' } }],
  });
  const events = await reader.queryEvents({
    thing: THING,
    low: 'E#2026-10-10',
    high: 'E#2026-10-11',
    kinds: ['connection'],
    limit: 5,
  });
  assert.deepEqual(events, [{ pk: THING, sk: 'E#2026-10-10T22:15:00.000Z#abcdef', kind: 'connection' }]);
  assert.equal(sdk.inputs('QueryCommand')[0].TableName, 'events-table');
  // Its own entry point needs only its own settings.
  assert.throws(() => createCustomerStore({ AWS_REGION: 'eu-west-1', STATE_TABLE: 'state-table' }), /CUSTOMER_POOL_ID/);
});

test("the customer API's Lambda entry point starts with its own settings, and turns away a request with no token", async () => {
  Object.assign(process.env, {
    AWS_REGION: 'eu-west-1',
    STATE_TABLE: 'state-table',
    EVENTS_TABLE: 'events-table',
    AUDIT_TABLE: 'audit-table',
    CUSTOMER_POOL_ID: 'eu-west-1_Customers',
    CUSTOMER_CLIENT_ID: 'customerclient',
    CUSTOMER_MOBILE_CLIENT_ID: 'customerphone',
  });
  const lines = [];
  console.log = (line) => lines.push(JSON.parse(line));
  let response;
  try {
    const { handler } = await import('../src/customer.mjs');
    sdk.reset();
    const { customerEvent } = await import('./fake-customers.mjs');
    response = await handler(customerEvent('/api/c/boards'));
  } finally {
    console.log = realLog;
  }
  assert.equal(response.statusCode, 401);
  assert.deepEqual(sdk.sent, [], 'nothing is asked of AWS for a request with no token');
  assert.deepEqual(
    lines.map((line) => [line.api, line.route, line.status]),
    [['customer', 'boards', 401]]
  );
});

// Searching the long lists (docs/search-filters.md).

test('searchAudit is a Query of the key range with a filter, whose Limit is the budget left, and says where it stopped', async () => {
  const aws = adapter();
  const entry = (n) => ({ pk: { S: 'AUD' }, sk: { S: `2026-10-10T22:15:0${n}.000Z#r${n}` }, outcome: { S: 'ok' } });
  const low = '2026-10-10T00:00:00.000Z';
  const high = '2026-10-11T00:00:00.000Z#~';
  sdk.reply(
    'QueryCommand',
    { Items: [entry(9)], ScannedCount: 3, LastEvaluatedKey: { pk: { S: 'AUD' }, sk: entry(7).sk } },
    { Items: [entry(5)], ScannedCount: 2, LastEvaluatedKey: { pk: { S: 'AUD' }, sk: entry(5).sk } }
  );
  const found = await aws.searchAudit({
    low,
    high,
    before: null,
    actions: ['token.create', 'token.revoke'],
    outcomes: ['ok'],
    text: 'ada',
    limit: 10,
    budget: 5,
  });
  assert.deepEqual(
    found.items.map((item) => item.sk.slice(-2)),
    ['r9', 'r5']
  );
  assert.equal(found.read, 5);
  assert.equal(found.next, entry(5).sk.S);
  const [first, second] = sdk.inputs('QueryCommand');
  assert.equal(first.KeyConditionExpression, '#pk = :pk AND #sk BETWEEN :low AND :high');
  assert.equal(first.ScanIndexForward, false);
  assert.equal(first.Limit, 5);
  assert.equal(second.Limit, 2);
  assert.deepEqual(second.ExclusiveStartKey, { pk: { S: 'AUD' }, sk: entry(7).sk });
  assert.equal(
    first.FilterExpression,
    '#action IN (:a0, :a1) AND #outcome IN (:o0) AND (' +
      'contains(#f_target, :q0) OR contains(#f_target, :q1) OR contains(#f_target, :q2) OR ' +
      'contains(#f_actor.#f_email, :q0) OR contains(#f_actor.#f_email, :q1) OR contains(#f_actor.#f_email, :q2) OR ' +
      'contains(#f_requestId, :q0) OR contains(#f_requestId, :q1) OR contains(#f_requestId, :q2))'
  );
  assert.deepEqual(first.ExpressionAttributeValues[':q1'], { S: 'ADA' });
  assert.deepEqual(first.ExpressionAttributeValues[':low'], { S: low });
  assert.equal('Scan' in first, false);

  // Enough found: it stops there, with no `next` of its own; the entry the cursor names is left out.
  sdk.reset();
  sdk.reply('QueryCommand', {
    Items: [entry(8), entry(7), entry(6)],
    ScannedCount: 3,
    LastEvaluatedKey: { pk: { S: 'AUD' }, sk: entry(6).sk },
  });
  const more = await aws.searchAudit({ low, high: entry(8).sk.S, before: entry(8).sk.S, limit: 1, budget: 100 });
  assert.deepEqual(
    more.items.map((item) => item.sk.slice(-2)),
    ['r7', 'r6']
  );
  assert.equal(more.next, null);
  assert.equal('FilterExpression' in sdk.inputs('QueryCommand')[0], false);

  sdk.reply('QueryCommand', fails('ThrottlingException'));
  await rejectsWith(aws.searchAudit({ low, high, limit: 1, budget: 1 }), { code: 'throttled', operation: 'Query' });
  await assert.rejects(aws.searchAudit({ low, high, limit: 1, budget: 0 }), TypeError);
});

test('queryEvents finds search text in the text, what and tag, and a level, in its FilterExpression', async () => {
  const aws = adapter();
  sdk.reply('QueryCommand', { Items: [] }, { Items: [] });
  await aws.queryEvents({ thing: THING, low: 'L#a', high: 'L#b', text: 'wifi', level: 'warn', limit: 5 });
  await aws.queryEvents({ thing: THING, low: 'L#a', high: 'L#b', level: 'info', limit: 5 });
  const [search, info] = sdk.inputs('QueryCommand');
  assert.equal(
    search.FilterExpression,
    '#level = :warn AND (contains(#f_text, :q0) OR contains(#f_text, :q1) OR contains(#f_text, :q2) OR ' +
      'contains(#f_what, :q0) OR contains(#f_what, :q1) OR contains(#f_what, :q2) OR ' +
      'contains(#f_tag, :q0) OR contains(#f_tag, :q1) OR contains(#f_tag, :q2))'
  );
  assert.deepEqual(
    [':q0', ':q1', ':q2'].map((name) => search.ExpressionAttributeValues[name].S),
    ['wifi', 'WIFI', 'Wifi']
  );
  assert.equal(search.KeyConditionExpression, '#pk = :pk AND #sk BETWEEN :low AND :high');
  assert.equal('Limit' in search, false);
  assert.equal(info.FilterExpression, '(attribute_not_exists(#level) OR #level <> :warn)');
});

test('the customer store write slot is one conditional ADD that counts only below the limit', async () => {
  sdk.reset();
  const store = createCustomerStore(CUSTOMER_ENV);
  sdk.reply('UpdateItemCommand', {}, fails('ConditionalCheckFailedException'));
  assert.deepEqual(await store.takeWriteSlot({ sub: CUSTOMER_SUB, bucket: 'm1', limit: 10, ttl: 99 }), { ok: true });
  assert.deepEqual(await store.takeWriteSlot({ sub: CUSTOMER_SUB, bucket: 'm1', limit: 10, ttl: 99 }), {
    ok: false,
    reason: 'limit',
  });
  const update = sdk.inputs('UpdateItemCommand')[0];
  assert.deepEqual(update.Key, { pk: { S: 'PRF' }, sk: { S: `LIM#${CUSTOMER_SUB}#m1` } });
  assert.match(update.UpdateExpression, /^ADD #n :one/);
  assert.equal(update.ConditionExpression, 'attribute_not_exists(#n) OR #n < :limit');
  assert.deepEqual(update.ExpressionAttributeValues[':limit'], { N: '10' });
});
