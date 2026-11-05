/**
 * The AWS calls of Memfault's part of the console (docs/memfault.md), held to the rules of aws.mjs:
 * no call waits without a limit, a call is tried twice at most, and a failure a caller cannot act on
 * is thrown as an Error with name "AwsError", code "throttled" | "failed", operation, awsError and
 * awsStatus. test/aws-memfault.test.mjs holds it to the SDK's input members.
 *
 * createMemfaultStore(env, { fetch }) is the forwarder's (MemfaultFn, forwarder.mjs). It reads AWS_REGION,
 * MEMFAULT_KEY_SECRET_ARN and MEMFAULT_CHUNKS_HOST.
 *
 *   readProjectKey()                -> string | null   the secret's value; null while it has none (the stack
 *                                                      makes it empty, and an empty secret has no version)
 *   postChunk({ thing, chunk, key }) -> { status }     POST to https://<host>/api/v0/chunks/<thing>; what
 *                                                      Memfault answers is not read beyond its status. A post
 *                                                      that does not get through, or takes longer than
 *                                                      POST_TIMEOUT_MS, throws ChunkPostError
 *   publishAck({ thing, payload })  -> undefined       iot-data Publish, QoS 1, to cranium/<thing>/commands
 *
 * createMemfaultStatus(env) is the API's (index.mjs adds it to the adapter of aws.mjs). It reads AWS_REGION
 * and MEMFAULT_KEY_SECRET_ARN; without that variable it says no key is stored and calls nothing.
 *
 *   memfaultKeyStored()             -> boolean         whether the secret has a current version, from its
 *                                                      metadata (DescribeSecret), never from its value
 */

import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import {
  DescribeSecretCommand, GetSecretValueCommand, SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

const CONNECT_TIMEOUT_MS = 1000;
const IDLE_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 2;
// Memfault answers a chunk in well under a second. The function has 15 s (MemfaultFn).
export const POST_TIMEOUT_MS = 5000;

const HOSTS = Object.freeze(['chunks-nrf.memfault.com', 'chunks.memfault.com']);
const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z]{2}(?:-[a-z]+)+-\d{1,2}:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/;
const THING = /^cranium-[0-9a-f]{16}$/;

/** The topic a board's commands, and so its answers, go to, as aws-map.mjs names it. */
function commandTopic(thing) {
  return `cranium/${thing}/commands`;
}

const THROTTLING = new Set([
  'ThrottlingException', 'Throttling', 'ThrottledException', 'TooManyRequestsException', 'RequestLimitExceeded',
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
  error.code = THROTTLING.has(nameOf(cause)) || statusOf(cause) === 429 || cause?.$retryable?.throttling === true
    ? 'throttled' : 'failed';
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

/** A post to Memfault that got no answer: the network, or the time limit. Names neither the key nor the chunk. */
function postFailure(cause) {
  const error = new Error(`POST chunks: ${nameOf(cause)}`);
  error.name = 'ChunkPostError';
  error.code = nameOf(cause) === 'TimeoutError' ? 'timeout' : 'network';
  return error;
}

/** @param {Record<string, string|undefined>} env  the Lambda environment */
export function createMemfaultStore(env, { fetch: fetchChunk = globalThis.fetch } = {}) {
  const region = required(env, 'AWS_REGION');
  const secretArn = required(env, 'MEMFAULT_KEY_SECRET_ARN', SECRET_ARN);
  const host = required(env, 'MEMFAULT_CHUNKS_HOST');
  if (!HOSTS.includes(host)) throw new Error('Environment variable MEMFAULT_CHUNKS_HOST is missing or malformed');
  const secrets = new SecretsManagerClient(clientSettings(region));
  const iotData = new IoTDataPlaneClient(clientSettings(region));

  return Object.freeze({
    async readProjectKey() {
      try {
        const out = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
        return typeof out?.SecretString === 'string' && out.SecretString !== '' ? out.SecretString : null;
      } catch (cause) {
        // The secret as the stack makes it: no version yet, so no value.
        if (nameOf(cause) === 'ResourceNotFoundException') return null;
        throw failure('GetSecretValue', cause);
      }
    },

    async postChunk({ thing, chunk, key }) {
      if (!THING.test(thing)) throw new TypeError('postChunk needs a board\'s name');
      let response;
      try {
        response = await fetchChunk(`https://${host}/api/v0/chunks/${thing}`, {
          method: 'POST',
          headers: { 'Memfault-Project-Key': key, 'Content-Type': 'application/octet-stream' },
          body: chunk,
          signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
      } catch (cause) {
        throw postFailure(cause);
      }
      // Read to the end, so that the connection can be used again, and thrown away.
      await response.arrayBuffer().catch(() => {});
      return { status: response.status };
    },

    async publishAck({ thing, payload }) {
      if (!THING.test(thing)) throw new TypeError('publishAck needs a board\'s name');
      try {
        await iotData.send(new PublishCommand({
          topic: commandTopic(thing),
          qos: 1,
          payload: Buffer.from(JSON.stringify(payload), 'utf8'),
          contentType: 'application/json',
        }));
      } catch (cause) {
        throw failure('Publish', cause);
      }
    },
  });
}

/** @param {Record<string, string|undefined>} env  the API function's environment */
export function createMemfaultStatus(env) {
  const region = required(env, 'AWS_REGION');
  const secretArn = env?.MEMFAULT_KEY_SECRET_ARN;
  if (secretArn === undefined || secretArn === '') {
    return Object.freeze({ async memfaultKeyStored() { return false; } });
  }
  if (!SECRET_ARN.test(secretArn)) throw new Error('Environment variable MEMFAULT_KEY_SECRET_ARN is missing or malformed');
  const secrets = new SecretsManagerClient(clientSettings(region));

  return Object.freeze({
    async memfaultKeyStored() {
      try {
        const out = await secrets.send(new DescribeSecretCommand({ SecretId: secretArn }));
        const stages = out?.VersionIdsToStages;
        if (stages === null || typeof stages !== 'object') return false;
        return Object.values(stages).some((labels) => Array.isArray(labels) && labels.includes('AWSCURRENT'));
      } catch (cause) {
        throw failure('DescribeSecret', cause);
      }
    },
  });
}
