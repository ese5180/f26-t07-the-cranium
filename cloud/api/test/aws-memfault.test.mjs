// Tests for the AWS adapter of Memfault's part (src/aws-memfault.mjs, docs/memfault.md): the forwarder's
// store and the API's question whether a project key is stored.
//
// As in map-aws.test.mjs, the SDK is not installed here: the two packages the adapter imports are replaced,
// through a module loader hook, by stand-ins that record every command and hold the adapter to the SDK's
// input members (taken from the command sources of the AWS SDK for JavaScript v3, 3.1149.0). The post to
// Memfault goes through a fetch that the test passes in. What these cannot show is that AWS and Memfault
// behave as the replies assume: the shapes are those of the Secrets Manager API reference and of
// Memfault's chunks API (POST /api/v0/chunks/<device serial>, 202 Accepted).

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

import { createFakeAws } from './fake-aws.mjs';

const REFERENCE = {
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
  '@aws-sdk/client-secrets-manager': {
    client: 'SecretsManagerClient',
    commands: {
      GetSecretValueCommand: { required: ['SecretId'], optional: ['VersionId', 'VersionStage'] },
      DescribeSecretCommand: { required: ['SecretId'], optional: [] },
    },
  },
};

const hooks = `
const REFERENCE = ${JSON.stringify(REFERENCE)};
const PREFIX = 'memfault-sdk-stand-in:';
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
    const lines = ['const hub = globalThis[Symbol.for("cranium.memfault-sdk-stand-in")];'];
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

globalThis[Symbol.for('cranium.memfault-sdk-stand-in')] = {
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

const { POST_TIMEOUT_MS, createMemfaultStatus, createMemfaultStore } = await import('../src/aws-memfault.mjs');

const SECRET = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:cranium-ota/memfault-project-key-AbCdEf';
const ENV = Object.freeze({
  AWS_REGION: 'us-east-1',
  MEMFAULT_KEY_SECRET_ARN: SECRET,
  MEMFAULT_CHUNKS_HOST: 'chunks-nrf.memfault.com',
});
const THING = 'cranium-0123456789abcdef';
const KEY = 'AbCdEf0123456789AbCdEf0123456789';

/** A fetch that records what it was asked and answers with `status`, or throws what `fail` gives. */
function fakeFetch({ status = 202, fail = null } = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, options });
    if (fail !== null) throw fail;
    return new Response('{"ok":"body that is never read into a log"}', { status });
  };
  return { fetch, requests };
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
  createMemfaultStore(ENV, { fetch: fakeFetch().fetch });
  createMemfaultStatus({ AWS_REGION: 'us-east-1', MEMFAULT_KEY_SECRET_ARN: SECRET });
  assert.deepEqual(sdk.clients.map((client) => client.package).sort(), [
    '@aws-sdk/client-iot-data-plane',
    '@aws-sdk/client-secrets-manager',
    '@aws-sdk/client-secrets-manager',
  ]);
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
    assert.throws(() => createMemfaultStore({ ...ENV, [name]: '' }), new RegExp(name));
    assert.throws(() => createMemfaultStore({ ...ENV, [name]: undefined }), new RegExp(name));
  }
  // Only the two hosts of Memfault's chunks API, and only a secret's ARN.
  for (const host of ['example.org', 'chunks.memfault.com.example.org', 'http://chunks.memfault.com']) {
    assert.throws(() => createMemfaultStore({ ...ENV, MEMFAULT_CHUNKS_HOST: host }), /MEMFAULT_CHUNKS_HOST/);
  }
  assert.throws(
    () => createMemfaultStore({ ...ENV, MEMFAULT_KEY_SECRET_ARN: 'cranium-ota/memfault-project-key' }),
    /MEMFAULT_KEY_SECRET_ARN/
  );
  assert.throws(
    () => createMemfaultStatus({ AWS_REGION: 'us-east-1', MEMFAULT_KEY_SECRET_ARN: 'not an arn' }),
    /MEMFAULT_KEY_SECRET_ARN/
  );
  assert.doesNotThrow(() =>
    createMemfaultStore({ ...ENV, MEMFAULT_CHUNKS_HOST: 'chunks.memfault.com' }, { fetch: fakeFetch().fetch })
  );
});

test("the key is the secret's value, and an empty secret is no key", async () => {
  sdk.reset();
  const store = createMemfaultStore(ENV, { fetch: fakeFetch().fetch });
  sdk.reply(
    'secrets-manager:GetSecretValueCommand',
    { SecretString: `${KEY}\n`, ARN: SECRET },
    fails('ResourceNotFoundException'),
    { SecretBinary: new Uint8Array([1]) },
    { SecretString: '' }
  );
  assert.equal(await store.readProjectKey(), `${KEY}\n`);
  // The secret as the stack makes it has no version yet: Secrets Manager says it cannot find the value.
  assert.equal(await store.readProjectKey(), null);
  assert.equal(await store.readProjectKey(), null);
  assert.equal(await store.readProjectKey(), null);
  assert.deepEqual(
    sdk.inputs('secrets-manager:GetSecretValueCommand').map((input) => input.SecretId),
    Array(4).fill(SECRET)
  );
  sdk.reply(
    'secrets-manager:GetSecretValueCommand',
    fails('AccessDeniedException', 400),
    fails('ThrottlingException', 400)
  );
  await rejectsWith(store.readProjectKey(), { code: 'failed', operation: 'GetSecretValue' });
  await rejectsWith(store.readProjectKey(), { code: 'throttled', operation: 'GetSecretValue' });
});

test("a chunk is posted as it is to the board's place in Memfault's chunks API, with the key in its header", async () => {
  const { fetch, requests } = fakeFetch({ status: 202 });
  const store = createMemfaultStore(ENV, { fetch });
  const chunk = Buffer.from([0x08, 0x02, 0xa7, 0x02, 0x01]);
  assert.deepEqual(await store.postChunk({ thing: THING, chunk, key: KEY }), { status: 202 });
  const [{ url, options }] = requests;
  assert.equal(url, `https://chunks-nrf.memfault.com/api/v0/chunks/${THING}`);
  assert.equal(options.method, 'POST');
  assert.deepEqual(options.headers, { 'Memfault-Project-Key': KEY, 'Content-Type': 'application/octet-stream' });
  assert.equal(options.body, chunk);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(POST_TIMEOUT_MS, 5000);

  const other = fakeFetch({ status: 503 });
  const elsewhere = createMemfaultStore(
    { ...ENV, MEMFAULT_CHUNKS_HOST: 'chunks.memfault.com' },
    { fetch: other.fetch }
  );
  assert.deepEqual(await elsewhere.postChunk({ thing: THING, chunk, key: KEY }), { status: 503 });
  assert.equal(other.requests[0].url, `https://chunks.memfault.com/api/v0/chunks/${THING}`);
  // Never to a path that is not a board's.
  await assert.rejects(store.postChunk({ thing: '../projects', chunk, key: KEY }), TypeError);
  assert.equal(requests.length, 1);
});

test('a post that does not get through says how, and never the key', async () => {
  for (const [cause, code] of [
    [Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }), 'timeout'],
    [new TypeError('fetch failed'), 'network'],
  ]) {
    const store = createMemfaultStore(ENV, { fetch: fakeFetch({ fail: cause }).fetch });
    await assert.rejects(store.postChunk({ thing: THING, chunk: Buffer.from([1]), key: KEY }), (error) => {
      assert.deepEqual([error.name, error.code], ['ChunkPostError', code]);
      assert.equal(error.message.includes(KEY), false);
      return true;
    });
  }
});

test("the answer is published with QoS 1 to the board's commands topic, as JSON", async () => {
  sdk.reset();
  const store = createMemfaultStore(ENV, { fetch: fakeFetch().fetch });
  sdk.reply('iot-data-plane:PublishCommand', {});
  await store.publishAck({ thing: THING, payload: { id: '3f9c2a1b7d4e6f80', cmd: 'memfault_ack', seq: 12 } });
  const [input] = sdk.inputs('iot-data-plane:PublishCommand');
  assert.equal(input.topic, `cranium/${THING}/commands`);
  assert.equal(input.qos, 1);
  assert.equal(input.contentType, 'application/json');
  assert.equal(Buffer.from(input.payload).toString('utf8'), '{"id":"3f9c2a1b7d4e6f80","cmd":"memfault_ack","seq":12}');
  sdk.reply('iot-data-plane:PublishCommand', fails('ThrottlingException', 429));
  await rejectsWith(store.publishAck({ thing: THING, payload: {} }), { code: 'throttled', operation: 'Publish' });
  await assert.rejects(store.publishAck({ thing: 'cranium-+', payload: {} }), TypeError);
});

test("the API asks the secret's metadata whether a key is stored, and never its value", async () => {
  sdk.reset();
  const status = createMemfaultStatus({ AWS_REGION: 'us-east-1', MEMFAULT_KEY_SECRET_ARN: SECRET });
  assert.deepEqual(Object.keys(status), ['memfaultKeyStored']);
  sdk.reply(
    'secrets-manager:DescribeSecretCommand',
    { ARN: SECRET, Name: 'cranium-ota/memfault-project-key' },
    { VersionIdsToStages: {} },
    { VersionIdsToStages: { 'aaaa-1': ['AWSPREVIOUS'], 'bbbb-2': ['AWSCURRENT'] } },
    { VersionIdsToStages: { 'aaaa-1': ['AWSPENDING'] } }
  );
  assert.deepEqual(
    [
      await status.memfaultKeyStored(),
      await status.memfaultKeyStored(),
      await status.memfaultKeyStored(),
      await status.memfaultKeyStored(),
    ],
    [false, false, true, false]
  );
  assert.deepEqual(
    sdk.inputs('secrets-manager:DescribeSecretCommand').map((input) => input.SecretId),
    Array(4).fill(SECRET)
  );
  assert.equal(sdk.inputs('secrets-manager:GetSecretValueCommand').length, 0);
  sdk.reply('secrets-manager:DescribeSecretCommand', fails('AccessDeniedException'));
  await rejectsWith(status.memfaultKeyStored(), { code: 'failed', operation: 'DescribeSecret' });

  // A stack from before Memfault tells the function no secret: no key, and no call.
  const before = createMemfaultStatus({ AWS_REGION: 'us-east-1' });
  assert.equal(await before.memfaultKeyStored(), false);
  assert.equal(sdk.inputs('secrets-manager:DescribeSecretCommand').length, 5);
});

test("the in-memory stand-in has the API's part, and says no key until one is stored", async () => {
  const fake = createFakeAws();
  for (const method of Object.keys(
    createMemfaultStatus({ AWS_REGION: 'us-east-1', MEMFAULT_KEY_SECRET_ARN: SECRET })
  )) {
    assert.equal(typeof fake[method], 'function', method);
  }
  assert.equal(await fake.memfaultKeyStored(), false);
  fake.storeMemfaultKey();
  assert.equal(await fake.memfaultKeyStored(), true);
  fake.storeMemfaultKey(false);
  assert.equal(await fake.memfaultKeyStored(), false);
});
