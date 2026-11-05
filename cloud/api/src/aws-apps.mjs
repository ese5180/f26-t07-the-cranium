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
 * Releases (state table, pk "APP", sk "android#MMM.mmm.ppppp" or "ios#MMM.mmm.ppppp"; lib/apps.mjs).
 * `platform` is "android" or "ios"; an iPhone release's versionCode is its build (CFBundleVersion).
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
 * APKs and IPAs (the firmware bucket, apps/android/ and apps/ios/; the bucket keeps every version of an object)
 *   headAppObject(key)               -> null when there is no such object, else
 *                                       { size, sha256Base64: string | null, checksumType: string | null,
 *                                         versionId: string | null }   HeadObject with ChecksumMode
 *   presignAppUpload({ key, size, sha256Base64, expiresIn })
 *                                    -> { url, headers, expiresAt }   a PUT that S3 takes only with
 *                                       these headers: content-length and x-amz-checksum-sha256
 *   presignAppDownload({ key, versionId, filename, expiresIn, contentType })
 *                                    -> { url, expiresAt }   a GET of that version of the object,
 *                                       served as an attachment named `filename`, as `contentType`
 *                                       (an APK's unless another is given)
 *   readAppObject({ key, versionId, start, end })
 *                                    -> Buffer   bytes start..end (inclusive) of that version: how
 *                                       an IPA's Info.plist is read without the whole file (lib/ipa.mjs)
 *   expiresAt is epoch milliseconds.
 *
 * SideStore sources (state table, pk "SRC"; lib/sidestore.mjs). A member's source link carries a key
 * whose SHA-256 is all that is stored: "key#<digest>" with id, ownerSub, createdAt, revokedAt (null
 * until revoked), and a count of its uses in one minute (window, uses, lastUsedAt); and "owner#<sub>",
 * which names the member's newest key: digest, id, createdAt, revokedAt. Nothing is deleted.
 *   getSourceOwner(sub)              -> object | null   consistent read
 *   getSourceKey(digest)             -> object | null   consistent read
 *   replaceSourceKey({ sub, key: { digest, id, createdAt }, previous, at })
 *                                    -> { ok: true } | { ok: false, reason: "conflict" }
 *                                       one transaction: the new key is stored, the member's item
 *                                       names it, and the key it named before (`previous`, its digest,
 *                                       or null if it had none that counts) is revoked at `at`
 *   revokeSourceKey({ sub, digest, at })
 *                                    -> { ok: true } | { ok: false, reason: "not_active" }
 *                                       the key and the member's item, both revoked, or neither
 *   useSourceKey({ digest, window, max, at })
 *                                    -> { ok: true, key } the key's item after one more use
 *                                     | { ok: false, reason: "unknown" | "revoked" | "limit" }
 *                                       counted per minute (`window`), at most `max` in one; `at`
 *                                       is an ISO time, the key's lastUsedAt
 */

import {
  DynamoDBClient, GetItemCommand, QueryCommand, TransactWriteItemsCommand, UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { APK_TYPE, APP_PK, APP_PLATFORMS } from './lib/apps.mjs';
import { presignUrl } from './lib/presign.mjs';
import { SOURCE_PK, sourceKeySk, sourceOwnerSk } from './lib/sidestore.mjs';

// As in aws.mjs: no call may hang, and a call is tried twice at most.
const CONNECT_TIMEOUT_MS = 1000;
const IDLE_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 2;
const MAX_PAGES = 40;
const PLATFORMS = APP_PLATFORMS;
// The most a ranged read of an IPA asks for: its list of files and the end record (lib/ipa.mjs).
const MAX_RANGE = 8 * 1024 * 1024 + 65_557;

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

    async presignAppDownload({ key, versionId, filename, expiresIn, contentType = APK_TYPE }) {
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
          'response-content-type': contentType,
        },
      });
      return { url: signed.url, expiresAt: signed.expiresAt };
    },

    async readAppObject({ key, versionId, start, end }) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > MAX_RANGE) {
        throw new TypeError('Not a range the console reads');
      }
      try {
        const out = await s3.send(new GetObjectCommand({
          Bucket: bucket, Key: key, VersionId: versionId, Range: `bytes=${start}-${end}`,
        }));
        return Buffer.from(await out.Body.transformToByteArray());
      } catch (cause) {
        throw failure('GetObject', cause);
      }
    },

    async getSourceOwner(sub) {
      try {
        const out = await dynamo.send(new GetItemCommand({
          TableName: stateTable, Key: { pk: { S: SOURCE_PK }, sk: { S: sourceOwnerSk(sub) } }, ConsistentRead: true,
        }));
        return out.Item === undefined ? null : fromItem(out.Item);
      } catch (cause) {
        throw failure('GetItem', cause);
      }
    },

    async getSourceKey(digest) {
      try {
        const out = await dynamo.send(new GetItemCommand({
          TableName: stateTable, Key: { pk: { S: SOURCE_PK }, sk: { S: sourceKeySk(digest) } }, ConsistentRead: true,
        }));
        return out.Item === undefined ? null : fromItem(out.Item);
      } catch (cause) {
        throw failure('GetItem', cause);
      }
    },

    async replaceSourceKey({ sub, key, previous, at }) {
      const items = [
        {
          Put: {
            TableName: stateTable,
            Item: toItem({
              pk: SOURCE_PK, sk: sourceKeySk(key.digest), id: key.id, ownerSub: sub, createdAt: key.createdAt,
              revokedAt: null, window: 0, uses: 0, lastUsedAt: null,
            }),
            ConditionExpression: 'attribute_not_exists(#pk)',
            ExpressionAttributeNames: { '#pk': 'pk' },
          },
        },
        {
          Put: {
            TableName: stateTable,
            Item: toItem({
              pk: SOURCE_PK, sk: sourceOwnerSk(sub), digest: key.digest, id: key.id, createdAt: key.createdAt, revokedAt: null,
            }),
            // Only over what the handler saw: the key it is replacing, or none that counts.
            ConditionExpression: previous === null
              ? 'attribute_not_exists(#pk) OR NOT attribute_type(#revokedAt, :null)'
              : '#digest = :previous AND attribute_type(#revokedAt, :null)',
            ExpressionAttributeNames: previous === null
              ? { '#pk': 'pk', '#revokedAt': 'revokedAt' }
              : { '#digest': 'digest', '#revokedAt': 'revokedAt' },
            ExpressionAttributeValues: previous === null
              ? { ':null': { S: 'NULL' } }
              : { ':previous': { S: previous }, ':null': { S: 'NULL' } },
          },
        },
      ];
      if (previous !== null) {
        items.push({
          Update: {
            TableName: stateTable,
            Key: { pk: { S: SOURCE_PK }, sk: { S: sourceKeySk(previous) } },
            UpdateExpression: 'SET #revokedAt = :at',
            ConditionExpression: '#owner = :owner AND attribute_type(#revokedAt, :null)',
            ExpressionAttributeNames: { '#owner': 'ownerSub', '#revokedAt': 'revokedAt' },
            ExpressionAttributeValues: { ':owner': { S: sub }, ':null': { S: 'NULL' }, ':at': { S: at } },
          },
        });
      }
      try {
        await dynamo.send(new TransactWriteItemsCommand({ TransactItems: items }));
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'TransactionCanceledException') return { ok: false, reason: 'conflict' };
        throw failure('TransactWriteItems', cause);
      }
    },

    async revokeSourceKey({ sub, digest, at }) {
      const values = { ':null': { S: 'NULL' }, ':at': { S: at } };
      try {
        await dynamo.send(new TransactWriteItemsCommand({
          TransactItems: [
            {
              Update: {
                TableName: stateTable,
                Key: { pk: { S: SOURCE_PK }, sk: { S: sourceOwnerSk(sub) } },
                UpdateExpression: 'SET #revokedAt = :at',
                ConditionExpression: '#digest = :digest AND attribute_type(#revokedAt, :null)',
                ExpressionAttributeNames: { '#digest': 'digest', '#revokedAt': 'revokedAt' },
                ExpressionAttributeValues: { ...values, ':digest': { S: digest } },
              },
            },
            {
              Update: {
                TableName: stateTable,
                Key: { pk: { S: SOURCE_PK }, sk: { S: sourceKeySk(digest) } },
                UpdateExpression: 'SET #revokedAt = :at',
                ConditionExpression: '#owner = :owner AND attribute_type(#revokedAt, :null)',
                ExpressionAttributeNames: { '#owner': 'ownerSub', '#revokedAt': 'revokedAt' },
                ExpressionAttributeValues: { ...values, ':owner': { S: sub } },
              },
            },
          ],
        }));
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'TransactionCanceledException') return { ok: false, reason: 'not_active' };
        throw failure('TransactWriteItems', cause);
      }
    },

    async useSourceKey({ digest, window, max, at }) {
      const key = { pk: { S: SOURCE_PK }, sk: { S: sourceKeySk(digest) } };
      const names = { '#pk': 'pk', '#revokedAt': 'revokedAt', '#window': 'window', '#uses': 'uses', '#last': 'lastUsedAt' };
      const values = { ':null': { S: 'NULL' }, ':w': { N: String(window) }, ':one': { N: '1' }, ':at': { S: at } };
      // One more use in this minute, or else the first of a new minute. Two requests that meet at the
      // turn of a minute may each find the other's change: then the first step is tried again.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const out = await dynamo.send(new UpdateItemCommand({
            TableName: stateTable,
            Key: key,
            UpdateExpression: 'SET #uses = #uses + :one, #last = :at',
            ConditionExpression: 'attribute_exists(#pk) AND attribute_type(#revokedAt, :null) AND #window = :w AND #uses < :max',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: { ...values, ':max': { N: String(max) } },
            ReturnValues: 'ALL_NEW',
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          }));
          return { ok: true, key: fromItem(out.Attributes) };
        } catch (cause) {
          if (nameOf(cause) !== 'ConditionalCheckFailedException') throw failure('UpdateItem', cause);
          const old = cause.Item === undefined || cause.Item === null ? null : fromItem(cause.Item);
          if (old === null || old.pk === undefined) return { ok: false, reason: 'unknown' };
          if (old.revokedAt !== null) return { ok: false, reason: 'revoked' };
          if (!(old.window < window)) return { ok: false, reason: 'limit' };
        }
        try {
          const out = await dynamo.send(new UpdateItemCommand({
            TableName: stateTable,
            Key: key,
            UpdateExpression: 'SET #window = :w, #uses = :one, #last = :at',
            ConditionExpression: 'attribute_exists(#pk) AND attribute_type(#revokedAt, :null) AND #window < :w',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }));
          return { ok: true, key: fromItem(out.Attributes) };
        } catch (cause) {
          if (nameOf(cause) !== 'ConditionalCheckFailedException') throw failure('UpdateItem', cause);
        }
      }
      return { ok: false, reason: 'limit' };
    },
  });
}
