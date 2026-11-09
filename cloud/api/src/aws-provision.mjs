/**
 * The AWS calls of provisioning through the console (handlers/provision.mjs, docs/new-board-setup.md):
 * one more module that imports the AWS SDK, beside aws.mjs, and held to the same rules. Handlers never
 * see an SDK client, command or exception; a failure they cannot act on is thrown as an Error with name
 * "AwsError", code "throttled" | "failed", operation, awsError and awsStatus. test/fake-provision.mjs
 * implements the same methods in memory (keep the two in step).
 *
 * createProvisionAws(env) reads AWS_REGION, THING_GROUP and DEVICE_POLICY. Thing names are validated by
 * the caller. These are what tools/provision_device.py does with the AWS CLI, and nothing more:
 *
 *   createThing({ thing, attributes })   -> { created: boolean }   false: the thing was there already,
 *                                           and is left as it is (attributes: { name: value } or null)
 *   updateThingAttributes({ thing, attributes }) -> undefined   merged into the thing's attributes
 *   addThingToGroup(thing)               -> undefined   into the project's thing group
 *   createCertificateFromCsr(csr)        -> { arn, id, pem }   an active certificate issued by AWS IoT for
 *                                           the request (PEM text)
 *   attachDevicePolicy(arn)              -> undefined   the device policy, to that certificate
 *   attachThingPrincipal({ thing, arn }) -> undefined   EXCLUSIVE_THING: AWS IoT then refuses to attach the
 *                                           certificate to any other thing
 *   retireCertificate({ thing, arn })    -> undefined   detached from the thing (when one is given) and from
 *                                           the policy, made INACTIVE, then deleted where AWS lets it
 *   describeDataEndpoint()               -> string      the account's AWS IoT data endpoint (iot:Data-ATS)
 */

import {
  AddThingToThingGroupCommand,
  AttachPolicyCommand,
  AttachThingPrincipalCommand,
  CreateCertificateFromCsrCommand,
  CreateThingCommand,
  DeleteCertificateCommand,
  DescribeEndpointCommand,
  DetachPolicyCommand,
  DetachThingPrincipalCommand,
  IoTClient,
  UpdateCertificateCommand,
  UpdateThingCommand,
} from '@aws-sdk/client-iot';

// As in aws.mjs: no call may hang, and a call is tried twice at most. The helpers are this module's own,
// as in aws-map.mjs, so that it imports one package of the SDK and nothing else.
const CONNECT_TIMEOUT_MS = 1000;
const IDLE_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 2;
const THROTTLING = new Set(['ThrottlingException', 'Throttling', 'TooManyRequestsException', 'RequestLimitExceeded']);

const CERTIFICATE_ARN = /^arn:[a-z0-9-]+:iot:[a-z0-9-]+:\d{12}:cert\/([0-9a-f]{64})$/;
const ENDPOINT = /^[a-z0-9]{10,20}-ats\.iot\.[a-z]{2}(?:-[a-z]+)+-\d{1,2}\.amazonaws\.com$/;

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

function required(env, name) {
  const value = env?.[name];
  if (typeof value !== 'string' || value === '') throw new Error(`Environment variable ${name} is missing`);
  return value;
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

/** @param {Record<string, string|undefined>} env  the Lambda environment */
export function createProvisionAws(env) {
  const region = required(env, 'AWS_REGION');
  const thingGroup = required(env, 'THING_GROUP');
  const policy = required(env, 'DEVICE_POLICY');
  const iot = new IoTClient(clientSettings(region));

  async function send(operation, command, allow = []) {
    try {
      return await iot.send(command);
    } catch (cause) {
      if (allow.includes(nameOf(cause))) return null;
      throw failure(operation, cause);
    }
  }

  return Object.freeze({
    async createThing({ thing, attributes = null }) {
      const input = { thingName: thing };
      if (attributes !== null) input.attributePayload = { attributes, merge: true };
      const out = await send('CreateThing', new CreateThingCommand(input), ['ResourceAlreadyExistsException']);
      return { created: out !== null };
    },

    async updateThingAttributes({ thing, attributes }) {
      await send(
        'UpdateThing',
        new UpdateThingCommand({ thingName: thing, attributePayload: { attributes, merge: true } })
      );
    },

    async addThingToGroup(thing) {
      await send(
        'AddThingToThingGroup',
        new AddThingToThingGroupCommand({ thingName: thing, thingGroupName: thingGroup })
      );
    },

    async createCertificateFromCsr(csr) {
      const out = await send(
        'CreateCertificateFromCsr',
        new CreateCertificateFromCsrCommand({ certificateSigningRequest: csr, setAsActive: true })
      );
      const match = CERTIFICATE_ARN.exec(out?.certificateArn ?? '');
      if (!match || typeof out.certificatePem !== 'string') {
        throw failure('CreateCertificateFromCsr', new Error('the answer has no certificate'), 'failed');
      }
      return { arn: out.certificateArn, id: match[1], pem: out.certificatePem };
    },

    async attachDevicePolicy(arn) {
      await send('AttachPolicy', new AttachPolicyCommand({ policyName: policy, target: arn }));
    },

    async attachThingPrincipal({ thing, arn }) {
      await send(
        'AttachThingPrincipal',
        new AttachThingPrincipalCommand({ thingName: thing, principal: arn, thingPrincipalType: 'EXCLUSIVE_THING' })
      );
    },

    async retireCertificate({ thing, arn }) {
      const match = CERTIFICATE_ARN.exec(arn);
      if (!match) throw new TypeError('not a certificate ARN');
      if (thing !== null) {
        await send('DetachThingPrincipal', new DetachThingPrincipalCommand({ thingName: thing, principal: arn }), [
          'ResourceNotFoundException',
        ]);
      }
      await send('DetachPolicy', new DetachPolicyCommand({ policyName: policy, target: arn }), [
        'ResourceNotFoundException',
        'InvalidRequestException',
      ]);
      await send('UpdateCertificate', new UpdateCertificateCommand({ certificateId: match[1], newStatus: 'INACTIVE' }));
      // A certificate still attached somewhere stays, inactive, as provision_device.py leaves it.
      await send('DeleteCertificate', new DeleteCertificateCommand({ certificateId: match[1] }), [
        'DeleteConflictException',
      ]);
    },

    async describeDataEndpoint() {
      const out = await send('DescribeEndpoint', new DescribeEndpointCommand({ endpointType: 'iot:Data-ATS' }));
      const address = out?.endpointAddress;
      if (typeof address !== 'string' || !ENDPOINT.test(address)) {
        throw failure('DescribeEndpoint', new Error('the answer is not an AWS IoT data endpoint'), 'failed');
      }
      return address;
    },
  });
}
