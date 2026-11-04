// Tests for the AWS adapter of the phone apps' releases (src/aws-apps.mjs).
//
// As in aws.test.mjs and map-aws.test.mjs, the SDK is not installed here: the two packages the adapter
// imports are replaced, through a module loader hook, by stand-ins that record every command and hold
// the adapter to the SDK's input members (from the command sources of the AWS SDK for JavaScript v3,
// 3.1149.0). The URLs it signs are checked against an S3 that knows its credentials: the in-memory
// stand-in's (test/fake-apps.mjs), which verifies them with the same signing code. What these cannot
// show is that AWS answers as the replies assume; HeadObject's members are those of the S3 API
// reference (ContentLength, ChecksumSHA256, ChecksumType, VersionId).

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

import { createFakeAws } from './fake-aws.mjs';

const REFERENCE = {
  '@aws-sdk/client-dynamodb': {
    client: 'DynamoDBClient',
    commands: {
      GetItemCommand: {
        required: ['TableName', 'Key'],
        optional: ['AttributesToGet', 'ConsistentRead', 'ReturnConsumedCapacity', 'ProjectionExpression', 'ExpressionAttributeNames'],
      },
      QueryCommand: {
        required: ['TableName'],
        optional: [
          'IndexName', 'Select', 'AttributesToGet', 'Limit', 'ConsistentRead', 'KeyConditions', 'QueryFilter',
          'ConditionalOperator', 'ScanIndexForward', 'ExclusiveStartKey', 'ReturnConsumedCapacity', 'ProjectionExpression',
          'FilterExpression', 'KeyConditionExpression', 'ExpressionAttributeNames', 'ExpressionAttributeValues',
        ],
      },
      TransactWriteItemsCommand: {
        required: ['TransactItems'],
        optional: ['ReturnConsumedCapacity', 'ReturnItemCollectionMetrics', 'ClientRequestToken'],
      },
    },
  },
  '@aws-sdk/client-s3': {
    client: 'S3Client',
    commands: {
      HeadObjectCommand: {
        required: ['Bucket', 'Key'],
        optional: [
          'IfMatch', 'IfModifiedSince', 'IfNoneMatch', 'IfUnmodifiedSince', 'Range', 'ResponseCacheControl',
          'ResponseContentDisposition', 'ResponseContentEncoding', 'ResponseContentLanguage', 'ResponseContentType',
          'ResponseExpires', 'VersionId', 'SSECustomerAlgorithm', 'SSECustomerKey', 'SSECustomerKeyMD5', 'RequestPayer',
          'PartNumber', 'ExpectedBucketOwner', 'ChecksumMode',
        ],
      },
    },
  },
};

const hooks = `
const REFERENCE = ${JSON.stringify(REFERENCE)};
const PREFIX = 'apps-sdk-stand-in:';
export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(REFERENCE, specifier)) return { url: PREFIX + specifier, shortCircuit: true };
  if (specifier.startsWith('@aws-sdk/') || specifier.startsWith('@smithy/')) {
    // aws.mjs and aws-map.mjs, which fake-aws.mjs does not import, are not under test here.
    return { url: PREFIX + 'unused', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url === PREFIX + 'unused') return { format: 'module', source: 'export {};', shortCircuit: true };
  if (url.startsWith(PREFIX)) {
    const name = url.slice(PREFIX.length);
    const { client, commands } = REFERENCE[name];
    const lines = ['const hub = globalThis[Symbol.for("cranium.apps-sdk-stand-in")];'];
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

function serialized(value) {
  if (Array.isArray(value)) return value.map(serialized);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, serialized(entry)]));
  }
  return value;
}

globalThis[Symbol.for('cranium.apps-sdk-stand-in')] = {
  constructed(name, config) {
    sdk.clients.push({ package: name, config });
  },
  async send(name, command) {
    const commandName = command.constructor.name;
    const spec = REFERENCE[name].commands[commandName];
    assert.ok(spec, `${commandName} is not a command of ${name}`);
    const input = serialized(command.input);
    for (const member of Object.keys(input)) {
      assert.ok(spec.required.includes(member) || spec.optional.includes(member), `${commandName} has no input member "${member}"`);
    }
    for (const member of spec.required) assert.ok(Object.hasOwn(input, member), `${commandName} needs "${member}"`);
    const key = `${name.replace('@aws-sdk/client-', '')}:${commandName}`;
    sdk.sent.push({ key, input });
    const queue = sdk.replies.get(key) ?? [];
    assert.ok(queue.length > 0, `No reply prepared for ${key}`);
    const answer = queue.shift();
    return typeof answer === 'function' ? answer(input) : answer;
  },
};

function sdkError(name, status = 400, extra = {}) {
  const error = new Error(`${name} from the service`);
  error.name = name;
  error.$metadata = { httpStatusCode: status };
  return Object.assign(error, extra);
}
const fails = (name, status, extra) => () => { throw sdkError(name, status, extra); };

const { createAppsAws } = await import('../src/aws-apps.mjs');

const ENV = Object.freeze({
  AWS_REGION: 'us-east-1', STATE_TABLE: 'state-table', FIRMWARE_BUCKET: 'local-firmware',
  // What the in-memory S3 knows the stand-in's credentials as (test/fake-apps.mjs).
  AWS_ACCESS_KEY_ID: 'ASIAFAKEFAKEFAKEFAKE',
  AWS_SECRET_ACCESS_KEY: 'made-up-secret-for-the-stand-in-only',
  AWS_SESSION_TOKEN: 'made-up-session-token',
});
const SK = 'android#000.004.00000';
const ITEM = Object.freeze({
  pk: { S: 'APP' }, sk: { S: SK }, version: { S: '0.4.0' }, versionCode: { N: '4' }, size: { N: '12027314' },
  sha256: { S: 'a'.repeat(64) }, objectVersion: { S: 'v1' }, publishedBy: { M: { sub: { S: 'abc' }, email: { S: 'x' } } },
});

function fresh(env = ENV) {
  sdk.reset();
  return createAppsAws(env);
}

async function rejectsWith(promise, { code, operation }) {
  await assert.rejects(promise, (error) => {
    assert.deepEqual([error.name, error.code, error.operation], ['AwsError', code, operation]);
    assert.equal(Object.hasOwn(error, '$metadata'), false);
    return true;
  });
}

test('the adapter reads only what it needs, no client waits without a limit, and the stand-in has its methods', () => {
  sdk.clients.length = 0;
  const real = createAppsAws(ENV);
  for (const { config } of sdk.clients) {
    assert.equal(config.region, 'us-east-1');
    assert.equal(config.maxAttempts, 2);
    assert.deepEqual(config.requestHandler, { connectionTimeout: 1000, socketTimeout: 3000, requestTimeout: 4000, throwOnRequestTimeout: true });
  }
  for (const name of ['AWS_REGION', 'STATE_TABLE', 'FIRMWARE_BUCKET']) {
    assert.throws(() => createAppsAws({ ...ENV, [name]: '' }), new RegExp(name));
  }
  assert.deepEqual(Object.keys(real).sort(), [
    'getAppRelease', 'headAppObject', 'highestAppRelease', 'listAppReleases', 'presignAppDownload', 'presignAppUpload',
    'registerAppRelease',
  ]);
  const fake = createFakeAws();
  for (const method of Object.keys(real)) assert.equal(typeof fake[method], 'function', method);
});

test('releases are read from their partition, by platform, newest first, consistently, every page', async () => {
  const aws = fresh();
  sdk.reply('dynamodb:QueryCommand', { Items: [ITEM], LastEvaluatedKey: { pk: { S: 'APP' } } }, { Items: [] });
  const items = await aws.listAppReleases('android');
  assert.deepEqual(items.map((item) => [item.version, item.versionCode, item.publishedBy.sub]), [['0.4.0', 4, 'abc']]);
  const [first, second] = sdk.inputs('dynamodb:QueryCommand');
  assert.equal(first.KeyConditionExpression, '#pk = :pk AND begins_with(#sk, :platform)');
  assert.deepEqual(first.ExpressionAttributeValues, { ':pk': { S: 'APP' }, ':platform': { S: 'android#' } });
  assert.deepEqual([first.ScanIndexForward, first.ConsistentRead, first.TableName], [false, true, 'state-table']);
  assert.deepEqual(second.ExclusiveStartKey, { pk: { S: 'APP' } });
  await assert.rejects(aws.listAppReleases('ios'), TypeError);

  sdk.reply('dynamodb:GetItemCommand', { Item: ITEM }, {});
  assert.equal((await aws.getAppRelease(SK)).objectVersion, 'v1');
  assert.equal(await aws.getAppRelease(SK), null);
  assert.deepEqual(sdk.inputs('dynamodb:GetItemCommand')[0].Key, { pk: { S: 'APP' }, sk: { S: SK } });

  sdk.reply('dynamodb:GetItemCommand', { Item: { highest: { S: SK }, versionCode: { N: '4' } } }, {},
    fails('ProvisionedThroughputExceededException'));
  assert.deepEqual(await aws.highestAppRelease('android'), { sk: SK, versionCode: 4 });
  assert.equal(await aws.highestAppRelease('android'), null);
  assert.deepEqual(sdk.inputs('dynamodb:GetItemCommand').at(-1).Key, { pk: { S: 'META' }, sk: { S: 'APP#android' } });
  await rejectsWith(aws.highestAppRelease('android'), { code: 'throttled', operation: 'GetItem' });
});

test('a release is registered in one transaction with the pointer, which only moves up in both', async () => {
  const aws = fresh();
  const release = { version: '0.5.0', versionCode: 5, size: 10, sha256: 'b'.repeat(64), notes: '', objectVersion: 'v2' };
  const sk = 'android#000.005.00000';
  sdk.reply('dynamodb:TransactWriteItemsCommand', {});
  assert.deepEqual(await aws.registerAppRelease({ sk, versionCode: 5, release }), { ok: true });
  const [{ TransactItems: [put, pointer] }] = sdk.inputs('dynamodb:TransactWriteItemsCommand');
  assert.equal(put.Put.ConditionExpression, 'attribute_not_exists(#pk)');
  assert.deepEqual([put.Put.Item.pk, put.Put.Item.sk, put.Put.Item.versionCode], [{ S: 'APP' }, { S: sk }, { N: '5' }]);
  assert.deepEqual(pointer.Update.Key, { pk: { S: 'META' }, sk: { S: 'APP#android' } });
  assert.equal(pointer.Update.ConditionExpression, 'attribute_not_exists(#highest) OR (#highest < :sk AND #code < :code)');
  assert.deepEqual(pointer.Update.ExpressionAttributeValues, { ':sk': { S: sk }, ':code': { N: '5' } });

  const cancelled = (reasons) => fails('TransactionCanceledException', 400, { CancellationReasons: reasons });
  sdk.reply('dynamodb:TransactWriteItemsCommand',
    cancelled([{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }]),
    cancelled([{ Code: 'None' }, { Code: 'ConditionalCheckFailed', Item: { highest: { S: SK }, versionCode: { N: '7' } } }]),
    cancelled([{ Code: 'None' }, { Code: 'TransactionConflict' }]),
    fails('InternalServerError', 500));
  assert.deepEqual(await aws.registerAppRelease({ sk, versionCode: 5, release }), { ok: false, reason: 'exists' });
  assert.deepEqual(await aws.registerAppRelease({ sk, versionCode: 5, release }),
    { ok: false, reason: 'not_newer', highest: SK, versionCode: 7 });
  assert.deepEqual(await aws.registerAppRelease({ sk, versionCode: 5, release }), { ok: false, reason: 'conflict' });
  await rejectsWith(aws.registerAppRelease({ sk, versionCode: 5, release }), { code: 'failed', operation: 'TransactWriteItems' });
});

test('HeadObject asks for the checksum, and a missing object is null', async () => {
  const aws = fresh();
  sdk.reply('s3:HeadObjectCommand',
    { ContentLength: 12027314, ChecksumSHA256: 'q83vEjRWeJA=', ChecksumType: 'FULL_OBJECT', VersionId: 'Wx.y_z' },
    { ContentLength: 5, VersionId: 'null' },
    fails('NotFound', 404));
  assert.deepEqual(await aws.headAppObject('apps/android/cranium-android-0.4.0.apk'),
    { size: 12027314, sha256Base64: 'q83vEjRWeJA=', checksumType: 'FULL_OBJECT', versionId: 'Wx.y_z' });
  assert.deepEqual(sdk.inputs('s3:HeadObjectCommand')[0],
    { Bucket: 'local-firmware', Key: 'apps/android/cranium-android-0.4.0.apk', ChecksumMode: 'ENABLED' });
  // Stored while versioning was off, and with no checksum: what the handler refuses to publish.
  assert.deepEqual(await aws.headAppObject('k'), { size: 5, sha256Base64: null, checksumType: null, versionId: null });
  assert.equal(await aws.headAppObject('k'), null);
  sdk.reply('s3:HeadObjectCommand', fails('Forbidden', 403));
  await rejectsWith(aws.headAppObject('k'), { code: 'failed', operation: 'HeadObject' });
});

test('the URLs it signs are taken by an S3 that knows its credentials, with the headers they name', async () => {
  const aws = fresh();
  const fake = createFakeAws();
  const body = Buffer.from('an APK');
  const sha256Base64 = (await import('node:crypto')).createHash('sha256').update(body).digest('base64');
  const key = 'apps/android/cranium-android-0.4.0.apk';
  const upload = await aws.presignAppUpload({ key, size: body.length, sha256Base64, expiresIn: 900 });
  assert.deepEqual(upload.headers, { 'content-length': String(body.length), 'x-amz-checksum-sha256': sha256Base64 });
  assert.ok(upload.url.startsWith(`https://local-firmware.s3.us-east-1.amazonaws.com/${key}?`));
  assert.equal(new URL(upload.url).searchParams.get('X-Amz-Security-Token'), 'made-up-session-token');
  assert.ok(Math.abs(upload.expiresAt - (Date.now() + 900_000)) < 5000);
  // The stand-in's S3 judges by the real clock here, as AWS would.
  const real = createFakeAws({ now: Date.now });
  assert.equal(real.s3Request({ method: 'PUT', url: upload.url, headers: upload.headers, body }).status, 200);
  assert.equal(real.s3Request({ method: 'PUT', url: upload.url, headers: { ...upload.headers, 'content-length': '7' }, body }).status, 403);
  const [stored] = real.apkVersions(key);

  const link = await aws.presignAppDownload({ key, versionId: stored.versionId, filename: 'cranium-android-0.4.0.apk', expiresIn: 900 });
  const served = real.s3Request({ method: 'GET', url: link.url });
  assert.equal(served.status, 200);
  assert.ok(served.body.equals(body));
  assert.equal(served.headers['content-type'], 'application/vnd.android.package-archive');
  assert.equal(served.headers['content-disposition'], 'attachment; filename="cranium-android-0.4.0.apk"');
  // Tampered with, it is refused.
  assert.equal(real.s3Request({ method: 'GET', url: link.url.replace('versionId=', 'versionId=x') }).status, 403);
  assert.equal(fake.apkVersions(key).length, 0);

  // Without credentials in the environment nothing is signed.
  const bare = fresh({ AWS_REGION: 'us-east-1', STATE_TABLE: 's', FIRMWARE_BUCKET: 'local-firmware' });
  await rejectsWith(bare.presignAppUpload({ key, size: 1, sha256Base64, expiresIn: 900 }), { code: 'failed', operation: 'PresignPutObject' });
});
