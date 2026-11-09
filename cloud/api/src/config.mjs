/**
 * Configuration of the console API, read from the environment once at cold start.
 *
 * Every value is set by the CloudFormation stack (AWS_REGION by Lambda itself). A
 * missing or malformed value stops the function from starting, which is the safe
 * outcome: nothing here has a default that could quietly weaken a check.
 *
 * The only key material is the firmware signing PUBLIC key. The console verifies
 * signatures with it and can never produce one.
 */

import { loadSigningKey } from './lib/mcuboot.mjs';

const PATTERNS = Object.freeze({
  AWS_REGION: /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/,
  STATE_TABLE: /^[A-Za-z0-9_.-]{3,255}$/,
  AUDIT_TABLE: /^[A-Za-z0-9_.-]{3,255}$/,
  EVENTS_TABLE: /^[A-Za-z0-9_.-]{3,255}$/,
  FIRMWARE_BUCKET: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
  THING_GROUP: /^[A-Za-z0-9:_-]{1,128}$/,
  PRESIGN_ROLE_ARN: /^arn:[a-z0-9-]+:iam::\d{12}:role\/[\w+=,.@/-]{1,576}$/,
  USER_POOL_ID: /^[\w-]+_[0-9A-Za-z]+$/,
  USER_POOL_CLIENT_ID: /^[\w+]{1,128}$/,
  MOBILE_CLIENT_ID: /^[\w+]{1,128}$/,
  SIGNING_PUBLIC_KEY_B64: /^[A-Za-z0-9+/]+={0,2}$/,
  SLOT_SIZE: /^[1-9]\d{0,9}$/,
  LOAD_ADDRESS: /^(?:0|[1-9]\d{0,9})$/,
  ALERT_TOPIC_ARN: /^arn:aws[a-z-]*:sns:[a-z]{2}(?:-[a-z]+)+-\d{1,2}:\d{12}:[A-Za-z0-9_-]{1,256}$/,
  // The console's address, as the stack's output ConsoleUrl has it, and the host of its login pages: what
  // the phone apps are configured with (GET /api/apps/config, apps/config/cranium.json).
  CONSOLE_URL: /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?\/?$/,
  LOGIN_DOMAIN: /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/,
  // Provisioning through the console (handlers/provision.mjs): the device policy a board's certificate gets,
  // and the one prefix a board may download firmware from, as the stack's outputs DevicePolicyName and
  // FirmwareDownloadPrefix have them.
  DEVICE_POLICY: /^[\w+=.@-]{1,128}$/,
  FIRMWARE_DOWNLOAD_PREFIX:
    /^https:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\.s3\.[a-z]{2}(?:-[a-z]+)+-\d{1,2}\.amazonaws\.com\/firmware\/$/,
});

// Memfault (docs/memfault.md), for a board's page: the slugs of the link to a board in Memfault. Each may
// be empty, and a stack from before them has neither: then there is no link. Neither is a secret.
const MEMFAULT_SLUG = /^(?:|[a-z0-9][a-z0-9-]{0,62})$/;
// The live API's WebSocket (docs/live.md), for the phone apps' configuration (handlers/apps.mjs): the
// stack's LiveUrl output, wss://<API id>.execute-api.<region>.amazonaws.com/<stage>. A stack from before
// console 2.4.0 has none. The apps put its origin into their pages' policy, so nothing else is taken.
const LIVE_URL =
  /^(?:|wss:\/\/[a-z0-9]{10}\.execute-api\.[a-z]{2}(?:-[a-z]+)+-\d{1,2}\.amazonaws\.com\/[A-Za-z0-9_-]{1,128})$/;

/** A value that may be missing or empty, which is then ''. A value that is there must match. */
function optional(env, name, pattern) {
  const value = env[name];
  if (value === undefined) return '';
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Environment variable ${name} is malformed`);
  }
  return value;
}

function read(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !PATTERNS[name].test(value)) {
    // The value itself is not put in the message: messages end up in logs.
    throw new Error(`Environment variable ${name} is missing or malformed`);
  }
  return value;
}

/** PEM text for a DER SubjectPublicKeyInfo given as base64. */
function publicKeyPem(base64) {
  const der = Buffer.from(base64, 'base64');
  if (der.length === 0 || der.toString('base64') !== base64) {
    throw new Error('Environment variable SIGNING_PUBLIC_KEY_B64 is missing or malformed');
  }
  const lines = base64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`;
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns the frozen configuration the handlers use
 */
export function loadConfig(env = process.env) {
  const signingKey = loadSigningKey(publicKeyPem(read(env, 'SIGNING_PUBLIC_KEY_B64')));
  const slotSize = Number(read(env, 'SLOT_SIZE'));
  const loadAddress = Number(read(env, 'LOAD_ADDRESS'));
  if (slotSize > 0xffffffff || loadAddress > 0xffffffff) {
    throw new Error('SLOT_SIZE and LOAD_ADDRESS must fit 32 bits');
  }
  return Object.freeze({
    region: read(env, 'AWS_REGION'),
    stateTable: read(env, 'STATE_TABLE'),
    auditTable: read(env, 'AUDIT_TABLE'),
    // The events and readings of the boards, written by the recorder (recorder.mjs).
    eventsTable: read(env, 'EVENTS_TABLE'),
    firmwareBucket: read(env, 'FIRMWARE_BUCKET'),
    thingGroup: read(env, 'THING_GROUP'),
    presignRoleArn: read(env, 'PRESIGN_ROLE_ARN'),
    userPoolId: read(env, 'USER_POOL_ID'),
    userPoolClientId: read(env, 'USER_POOL_CLIENT_ID'),
    // The phone apps' client (docs/mobile-apps.md). A token from either is accepted.
    mobileClientId: read(env, 'MOBILE_CLIENT_ID'),
    // { key, keyHash }: the public key and the SHA-256 of its DER encoding.
    signingKey,
    signingKeyFingerprint: signingKey.keyHash.toString('hex'),
    slotSize,
    loadAddress,
    // Where the e-mail alerts go (docs/fleet.md). aws-map.mjs subscribes to it; nothing here publishes.
    alertTopicArn: read(env, 'ALERT_TOPIC_ARN'),
    // For the phone apps' configuration (handlers/apps.mjs). Public, as the client IDs are.
    // Without the slash at the end, as apps/configure.sh writes it.
    consoleUrl: read(env, 'CONSOLE_URL').replace(/\/$/, ''),
    loginDomain: read(env, 'LOGIN_DOMAIN'),
    // What a board is given when it is registered through the console (handlers/provision.mjs).
    devicePolicy: read(env, 'DEVICE_POLICY'),
    firmwareDownloadPrefix: read(env, 'FIRMWARE_DOWNLOAD_PREFIX'),
    // '' without live updates.
    liveUrl: optional(env, 'LIVE_URL', LIVE_URL),
    // The link to a board in Memfault, when both are set (lib/memfault.mjs).
    memfault: Object.freeze({
      org: optional(env, 'MEMFAULT_ORG_SLUG', MEMFAULT_SLUG),
      project: optional(env, 'MEMFAULT_PROJECT_SLUG', MEMFAULT_SLUG),
    }),
  });
}
