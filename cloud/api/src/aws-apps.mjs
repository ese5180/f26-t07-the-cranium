/**
 * The AWS calls of the phone apps' releases (handlers/apps.mjs, docs/mobile-apps.md): the third
 * module that imports the AWS SDK, beside aws.mjs and aws-map.mjs, and held to the same rules.
 * Handlers never see an SDK client, command or exception; a failure they cannot act on is thrown
 * as an Error with name "AwsError", code "throttled" | "failed", operation, awsError and awsStatus.
 * test/fake-apps.mjs implements the same methods in memory (keep the two in step:
 * test/apps-aws.test.mjs runs both).
 *
 * createAppsAws(env) reads AWS_REGION, STATE_TABLE and FIRMWARE_BUCKET, and, each time it signs a
 * URL, the function's own credentials: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and
 * AWS_SESSION_TOKEN, which Lambda sets for its role.
 *
 * Releases (state table, pk "APP", sk "android#MMM.mmm.ppppp"; lib/apps.mjs)
 *   listAppReleases(platform)        -> object[]   that platform's items, highest sk first; consistent read
 *   getAppRelease(sk)                -> object | null   consistent read
 *   highestAppRelease(platform)      -> { sk, versionCode } | null   the highest ever published
 *   registerAppRelease({ sk, versionCode, release })
 *                                    -> { ok: true }
 *                                     | { ok: false, reason: "exists" }
 *                                     | { ok: false, reason: "not_newer", highest, versionCode }
 *                                       the highest sk and versionCode published, either of which
 *                                       this one is not above
 *                                     | { ok: false, reason: "conflict" }   a concurrent write
 *                                       one transaction: the release is stored and the pointer
 *                                       (pk "META", sk "APP#<platform>") moves up, or neither
 * APKs (the firmware bucket, apps/android/; the bucket keeps every version of an object)
 *   headAppObject(key)               -> null when there is no such object, else
 *                                       { size, sha256Base64: string | null, checksumType: string | null,
 *                                         versionId: string | null }   HeadObject with ChecksumMode
 *   presignAppUpload({ key, size, sha256Base64, expiresIn })
 *                                    -> { url, headers, expiresAt }   a PUT that S3 takes only with
 *                                       these headers: content-length and x-amz-checksum-sha256
 *   presignAppDownload({ key, versionId, filename, expiresIn })
 *                                    -> { url, expiresAt }   a GET of that version of the object,
 *                                       served as an attachment named `filename`, as an APK
 *   expiresAt is epoch milliseconds.
 */

import { DynamoDBClient, GetItemCommand, QueryCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { APK_TYPE, APP_PK } from './lib/apps.mjs';
import { presignUrl } from './lib/presign.mjs';

// As in aws.mjs: no call may hang, and a call is tried twice at most.
const CONNECT_TIMEOUT_MS = 1000;
const IDLE_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 2;
const MAX_PAGES = 40;
const PLATFORMS = Object.freeze(['android']);

const THROTTLING = new Set([
  'ThrottlingException', 'Throttling', 'ThrottledException', 'TooManyRequestsException', 'RequestLimitExceeded',
  'ProvisionedThroughputExceededException', 'RequestThrottled', 'RequestThrottledException', 'SlowDown',
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
  error.code = code ?? (THROTTLING.has(nameOf(cause)) || statusOf(cause) === 429 || cause?.$retryable?.throttling === true
    ? 'throttled' : 'failed');
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
  if (attribute === null || typeof attribute !== 'object') return undefined;
  if ('S' in attribute) return attribute.S;
  if ('N' in attribute) return Number(attribute.N);
  if ('BOOL' in attribute) return attribute.BOOL;
  if ('NULL' in attribute) return null;
  if ('L' in attribute) return (attribute.L ?? []).map(fromAttribute);
  if ('M' in attribute) return fromItem(attribute.M);
  return undefined;
}

function fromItem(item) {
  return Object.fromEntries(Object.entries(item ?? {}).map(([key, value]) => [key, fromAttribute(value)]));
}

function pointerKey(platform) {
  if (!PLATFORMS.includes(platform)) throw new TypeError(`No app platform ${platform}`);
  return { pk: { S: 'META' }, sk: { S: `APP#${platform}` } };
}

export function createAppsAws(env) {
  const region = required(env, 'AWS_REGION');
  const stateTable = required(env, 'STATE_TABLE');
  const bucket = required(env, 'FIRMWARE_BUCKET');
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const dynamo = new DynamoDBClient(clientSettings(region));
  const s3 = new S3Client(clientSettings(region));

  /** The role's credentials, as Lambda has them in the environment at this moment. */
  function credentials(operation) {
    const accessKeyId = env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
    if (typeof accessKeyId !== 'string' || accessKeyId === '' || typeof secretAccessKey !== 'string' || secretAccessKey === '') {
      throw failure(operation, new Error('the function has no credentials to sign with'), 'failed');
    }
    return { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN };
  }

  async function highest(platform) {
    const out = await dynamo.send(new GetItemCommand({
      TableName: stateTable, Key: pointerKey(platform), ConsistentRead: true,
    }));
    const sk = out.Item?.highest?.S;
    const code = Number(out.Item?.versionCode?.N);
    return typeof sk === 'string' ? { sk, versionCode: Number.isInteger(code) ? code : 0 } : null;
  }

  return Object.freeze({
    async listAppReleases(platform) {
      if (!PLATFORMS.includes(platform)) throw new TypeError(`No app platform ${platform}`);
      const items = [];
      let start;
      try {
        for (let pages = 0; pages < MAX_PAGES; pages += 1) {
          const out = await dynamo.send(new QueryCommand({
            TableName: stateTable,
            KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :platform)',
            ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
            ExpressionAttributeValues: { ':pk': { S: APP_PK }, ':platform': { S: `${platform}#` } },
            ScanIndexForward: false,
            ConsistentRead: true,
            ExclusiveStartKey: start,
          }));
          for (const item of out.Items ?? []) items.push(fromItem(item));
          if (out.LastEvaluatedKey === undefined || out.LastEvaluatedKey === null) return items;
          start = out.LastEvaluatedKey;
        }
      } catch (cause) {
        throw failure('Query', cause);
      }
      throw failure('Query', new Error(`more than ${MAX_PAGES} pages`), 'failed');
    },

    async getAppRelease(sk) {
      try {
        const out = await dynamo.send(new GetItemCommand({
          TableName: stateTable, Key: { pk: { S: APP_PK }, sk: { S: sk } }, ConsistentRead: true,
        }));
        return out.Item === undefined ? null : fromItem(out.Item);
      } catch (cause) {
        throw failure('GetItem', cause);
      }
    },

    async highestAppRelease(platform) {
      try {
        return await highest(platform);
      } catch (cause) {
        if (cause instanceof TypeError) throw cause;
        throw failure('GetItem', cause);
      }
    },

    async registerAppRelease({ sk, versionCode, release }) {
      const platform = sk.slice(0, sk.indexOf('#'));
      const key = pointerKey(platform);
      try {
        await dynamo.send(new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: stateTable,
                Item: toItem({ ...release, pk: APP_PK, sk }),
                ConditionExpression: 'attribute_not_exists(#pk)',
                ExpressionAttributeNames: { '#pk': 'pk' },
              },
            },
            {
              Update: {
                TableName: stateTable,
                Key: key,
                UpdateExpression: 'SET #highest = :sk, #code = :code',
                ConditionExpression: 'attribute_not_exists(#highest) OR (#highest < :sk AND #code < :code)',
                ExpressionAttributeNames: { '#highest': 'highest', '#code': 'versionCode' },
                ExpressionAttributeValues: { ':sk': { S: sk }, ':code': { N: String(versionCode) } },
                ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
              },
            },
          ],
        }));
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) !== 'TransactionCanceledException') throw failure('TransactWriteItems', cause);
        const reasons = Array.isArray(cause.CancellationReasons) ? cause.CancellationReasons : [];
        const [put, pointer] = reasons;
        if (put?.Code === 'ConditionalCheckFailed') return { ok: false, reason: 'exists' };
        if (pointer?.Code === 'ConditionalCheckFailed') {
          let top = typeof pointer.Item?.highest?.S === 'string'
            ? { sk: pointer.Item.highest.S, versionCode: Number(pointer.Item.versionCode?.N ?? 0) }
            : null;
          if (top === null) {
            try {
              top = await highest(platform);
            } catch {
              top = null;
            }
          }
          return { ok: false, reason: 'not_newer', highest: top?.sk ?? null, versionCode: top?.versionCode ?? null };
        }
        if (reasons.some((reason) => reason?.Code === 'TransactionConflict')) return { ok: false, reason: 'conflict' };
        const throttled = reasons.some((reason) =>
          reason?.Code === 'ThrottlingError' || reason?.Code === 'ProvisionedThroughputExceeded');
        throw failure('TransactWriteItems', cause, throttled ? 'throttled' : 'failed');
      }
    },

    async headAppObject(key) {
      let out;
      try {
        out = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }));
      } catch (cause) {
        // A HEAD has no body, so a missing object is a bare 404 (NotFound), or NoSuchKey.
        if (nameOf(cause) === 'NotFound' || nameOf(cause) === 'NoSuchKey' || statusOf(cause) === 404) return null;
        throw failure('HeadObject', cause);
      }
      return {
        size: Number.isSafeInteger(out.ContentLength) ? out.ContentLength : -1,
        sha256Base64: typeof out.ChecksumSHA256 === 'string' ? out.ChecksumSHA256 : null,
        checksumType: typeof out.ChecksumType === 'string' ? out.ChecksumType : null,
        // "null" is what S3 calls the version of an object stored while versioning was off.
        versionId: typeof out.VersionId === 'string' && out.VersionId !== '' && out.VersionId !== 'null' ? out.VersionId : null,
      };
    },

    async presignAppUpload({ key, size, sha256Base64, expiresIn }) {
      const headers = { 'content-length': String(size), 'x-amz-checksum-sha256': sha256Base64 };
      const signed = presignUrl({
        method: 'PUT', host, key, region, credentials: credentials('PresignPutObject'), at: Date.now(), expiresIn, headers,
      });
      return { url: signed.url, headers, expiresAt: signed.expiresAt };
    },

    async presignAppDownload({ key, versionId, filename, expiresIn }) {
      const signed = presignUrl({
        method: 'GET',
        host,
        key,
        region,
        credentials: credentials('PresignGetObject'),
        at: Date.now(),
        expiresIn,
        query: {
          versionId,
          'response-content-disposition': `attachment; filename="${filename}"`,
          'response-content-type': APK_TYPE,
        },
      });
      return { url: signed.url, expiresAt: signed.expiresAt };
    },
  });
}
