// Tests for the AWS adapter of provisioning through the console (src/aws-provision.mjs).
//
// As in aws.test.mjs, the SDK is not installed here: the one package the adapter imports is replaced,
// through a module loader hook, by a stand-in that records every command and holds the adapter to the
// SDK's input members (test/provision-sdk.mjs). What these cannot show is that AWS behaves as the replies
// assume.

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

import { createFakeAws } from './fake-aws.mjs';
import { PROVISION_COMMANDS } from './provision-sdk.mjs';

const hooks = `
const COMMANDS = ${JSON.stringify(Object.keys(PROVISION_COMMANDS))};
const PREFIX = 'provision-sdk-stand-in:';
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@aws-sdk/client-iot') return { url: PREFIX + specifier, shortCircuit: true };
  if (specifier.startsWith('@aws-sdk/') || specifier.startsWith('@smithy/')) {
    throw new Error('The adapter may not import ' + specifier);
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith(PREFIX)) {
    const lines = ['const hub = globalThis[Symbol.for("cranium.provision-sdk-stand-in")];'];
    lines.push('export class IoTClient {');
    lines.push('  constructor(config) { hub.constructed(config); }');
    lines.push('  send(command) { return hub.send(command); }');
    lines.push('}');
    for (const command of COMMANDS) {
      lines.push('export class ' + command + ' { constructor(input) { this.input = input; } }');
    }
    return { format: 'module', source: lines.join('\\n'), shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

const sdk = { clients: [], sent: [], replies: new Map() };
globalThis[Symbol.for('cranium.provision-sdk-stand-in')] = {
  constructed(config) {
    sdk.clients.push(config);
  },
  async send(command) {
    const name = command.constructor.name;
    const spec = PROVISION_COMMANDS[name];
    assert.ok(spec, `${name} is not a command the adapter may send`);
    const input = JSON.parse(JSON.stringify(command.input));
    for (const member of Object.keys(input)) {
      assert.ok(spec.required.includes(member) || spec.optional.includes(member), `${name} has no "${member}"`);
    }
    for (const member of spec.required) assert.ok(Object.hasOwn(input, member), `${name} needs "${member}"`);
    sdk.sent.push({ name, input });
    const queue = sdk.replies.get(name) ?? [];
    assert.ok(queue.length > 0, `No reply prepared for ${name}`);
    const answer = queue.shift();
    return typeof answer === 'function' ? answer(input) : answer;
  },
};

function reply(name, ...answers) {
  sdk.replies.set(name, [...(sdk.replies.get(name) ?? []), ...answers]);
}

function fails(name, status = 400) {
  return () => {
    const error = new Error(`${name} from the service`);
    error.name = name;
    error.$metadata = { httpStatusCode: status };
    throw error;
  };
}

const { createProvisionAws } = await import('../src/aws-provision.mjs');

const ENV = Object.freeze({ AWS_REGION: 'us-east-1', THING_GROUP: 'cranium-devices', DEVICE_POLICY: 'cranium-device' });
const THING = 'cranium-fe5b26c0c5b1dcd7';
const ID = 'a'.repeat(64);
const ARN = `arn:aws:iot:us-east-1:000000000000:cert/${ID}`;

function fresh() {
  sdk.sent.length = 0;
  sdk.replies.clear();
  return createProvisionAws(ENV);
}

test('it reads only its environment, its client waits for nothing without a limit, and the stand-in has its methods', () => {
  sdk.clients.length = 0;
  const real = createProvisionAws(ENV);
  assert.deepEqual(sdk.clients[0].requestHandler, {
    connectionTimeout: 1000,
    socketTimeout: 3000,
    requestTimeout: 4000,
    throwOnRequestTimeout: true,
  });
  for (const name of Object.keys(ENV))
    assert.throws(() => createProvisionAws({ ...ENV, [name]: '' }), new RegExp(name));
  const fake = createFakeAws();
  for (const method of Object.keys(real)) assert.equal(typeof fake[method], 'function', method);
});

test('a thing, new or there already, with its attributes merged, into the group', async () => {
  const aws = fresh();
  reply('CreateThingCommand', { thingName: THING }, fails('ResourceAlreadyExistsException', 409));
  assert.deepEqual(await aws.createThing({ thing: THING, attributes: { board: 'nrf5340dk' } }), { created: true });
  assert.deepEqual(await aws.createThing({ thing: THING, attributes: null }), { created: false });
  reply('UpdateThingCommand', {});
  await aws.updateThingAttributes({ thing: THING, attributes: { board: 'nrf5340dk' } });
  reply('AddThingToThingGroupCommand', {});
  await aws.addThingToGroup(THING);
  assert.deepEqual(sdk.sent, [
    {
      name: 'CreateThingCommand',
      input: { thingName: THING, attributePayload: { attributes: { board: 'nrf5340dk' }, merge: true } },
    },
    { name: 'CreateThingCommand', input: { thingName: THING } },
    {
      name: 'UpdateThingCommand',
      input: { thingName: THING, attributePayload: { attributes: { board: 'nrf5340dk' }, merge: true } },
    },
    { name: 'AddThingToThingGroupCommand', input: { thingName: THING, thingGroupName: 'cranium-devices' } },
  ]);
});

test('a certificate from the request, active, with the device policy, attached to the thing alone', async () => {
  const aws = fresh();
  reply('CreateCertificateFromCsrCommand', { certificateArn: ARN, certificateId: ID, certificatePem: 'PEM' });
  assert.deepEqual(await aws.createCertificateFromCsr('CSR'), { arn: ARN, id: ID, pem: 'PEM' });
  reply('AttachPolicyCommand', {});
  await aws.attachDevicePolicy(ARN);
  reply('AttachThingPrincipalCommand', {});
  await aws.attachThingPrincipal({ thing: THING, arn: ARN });
  assert.deepEqual(
    sdk.sent.map((sent) => sent.input),
    [
      { certificateSigningRequest: 'CSR', setAsActive: true },
      { policyName: 'cranium-device', target: ARN },
      { thingName: THING, principal: ARN, thingPrincipalType: 'EXCLUSIVE_THING' },
    ]
  );
  // An answer without a certificate is a failure.
  reply('CreateCertificateFromCsrCommand', { certificateArn: 'nonsense' });
  await assert.rejects(aws.createCertificateFromCsr('CSR'), {
    name: 'AwsError',
    operation: 'CreateCertificateFromCsr',
  });
});

test('a certificate is retired as provision_device.py retires one, and a failure is an AwsError', async () => {
  const aws = fresh();
  reply('DetachThingPrincipalCommand', {});
  reply('DetachPolicyCommand', fails('ResourceNotFoundException', 404));
  reply('UpdateCertificateCommand', {});
  reply('DeleteCertificateCommand', fails('DeleteConflictException', 409));
  await aws.retireCertificate({ thing: THING, arn: ARN });
  assert.deepEqual(
    sdk.sent.map((sent) => [sent.name, sent.input]),
    [
      ['DetachThingPrincipalCommand', { thingName: THING, principal: ARN }],
      ['DetachPolicyCommand', { policyName: 'cranium-device', target: ARN }],
      ['UpdateCertificateCommand', { certificateId: ID, newStatus: 'INACTIVE' }],
      ['DeleteCertificateCommand', { certificateId: ID }],
    ]
  );
  await assert.rejects(aws.retireCertificate({ thing: THING, arn: 'arn:aws:iam::000000000000:role/x' }), TypeError);
  reply('UpdateCertificateCommand', fails('ThrottlingException', 429));
  reply('DetachPolicyCommand', {});
  await assert.rejects(aws.retireCertificate({ thing: null, arn: ARN }), {
    name: 'AwsError',
    code: 'throttled',
    operation: 'UpdateCertificate',
  });
});

test('the data endpoint is the ATS one, and nothing else is taken', async () => {
  const aws = fresh();
  reply('DescribeEndpointCommand', { endpointAddress: 'a1b2c3d4e5f6g7-ats.iot.us-east-1.amazonaws.com' });
  assert.equal(await aws.describeDataEndpoint(), 'a1b2c3d4e5f6g7-ats.iot.us-east-1.amazonaws.com');
  assert.deepEqual(sdk.sent[0].input, { endpointType: 'iot:Data-ATS' });
  reply('DescribeEndpointCommand', { endpointAddress: 'evil.example.com' });
  await assert.rejects(aws.describeDataEndpoint(), { name: 'AwsError', operation: 'DescribeEndpoint' });
});
