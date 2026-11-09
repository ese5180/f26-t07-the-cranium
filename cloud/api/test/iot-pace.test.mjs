// AWS IoT's job reads are paced, retried when throttled and kept for a while (src/lib/iot-pace.mjs,
// src/handlers/deployments.mjs): the Deployments page must not be refused by AWS's ~10 requests a
// second for DescribeJob.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ATTEMPTS, BACKOFF_MS, BURST, IN_FLIGHT, PER_SECOND, pace } from '../src/lib/iot-pace.mjs';
import { createFakeAws, createTestConsole, fixture } from './fake-aws.mjs';

const BOARD_A = 'cranium-00000000000000a1';
const BOARD_B = 'cranium-00000000000000b2';
const BOARD = BOARD_A;

/** A clock that only the stand-in sleep moves, and the waits it was asked for. */
function virtualTime() {
  const time = { ms: 0, waits: [] };
  return {
    time,
    clock: () => time.ms,
    sleep: async (ms) => {
      time.waits.push(ms);
      time.ms += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function jobId(n) {
  return `cranium-1-2-3-b4-20261011T${String(Math.floor(n / 60)).padStart(2, '0')}${String(n % 60).padStart(2, '0')}00Z-${String(n).padStart(4, '0')}`;
}

async function fakeWithJobs(count) {
  const fake = createFakeAws({ now: () => Date.UTC(2026, 9, 11, 12) });
  fake.addThing(BOARD);
  const ids = [];
  for (let n = 0; n < count; n += 1) {
    ids.push(jobId(n));
    await fake.createJob({
      jobId: jobId(n),
      things: [BOARD],
      document: '{}',
      description: '{}',
      urlExpiresInSec: 600,
      inProgressTimeoutMinutes: 30,
    });
  }
  return { fake, ids };
}

/** Count how many describeJob calls the fake has at once. */
function watchInFlight(fake) {
  const seen = { now: 0, most: 0, calls: 0 };
  const original = fake.describeJob;
  fake.describeJob = async (id) => {
    seen.calls += 1;
    seen.now += 1;
    seen.most = Math.max(seen.most, seen.now);
    await new Promise((resolve) => setImmediate(resolve));
    try {
      return await original(id);
    } finally {
      seen.now -= 1;
    }
  };
  return seen;
}

test(`a burst of 50 job reads has at most ${IN_FLIGHT} in flight and keeps to ${PER_SECOND} a second`, async () => {
  const { fake, ids } = await fakeWithJobs(50);
  const seen = watchInFlight(fake);
  const { time, clock, sleep } = virtualTime();
  const aws = pace(fake, { clock, sleep });

  const described = await Promise.all(ids.map((id) => aws.describeJob(id)));

  assert.deepEqual(
    described.map((job) => job.jobId),
    ids
  );
  assert.equal(seen.calls, 50);
  assert.equal(seen.most, IN_FLIGHT);
  // After the first burst, one more every 1/PER_SECOND of a second.
  assert.ok(time.ms >= ((50 - BURST - 1) * 1000) / PER_SECOND, `${time.ms} ms for 50 reads`);
});

test('the other job reads share the same limit, and other calls pass straight through', async () => {
  const { fake, ids } = await fakeWithJobs(12);
  const { clock, sleep } = virtualTime();
  const aws = pace(fake, { clock, sleep });
  let now = 0;
  let most = 0;
  for (const method of ['listJobExecutionsForJob', 'describeJobExecution']) {
    const original = fake[method];
    fake[method] = async (...args) => {
      now += 1;
      most = Math.max(most, now);
      await new Promise((resolve) => setImmediate(resolve));
      try {
        return await original(...args);
      } finally {
        now -= 1;
      }
    };
  }
  await Promise.all(ids.flatMap((id) => [aws.listJobExecutionsForJob(id), aws.describeJobExecution(id, BOARD)]));
  assert.equal(most, IN_FLIGHT);
  assert.deepEqual(await aws.listGroupThings(), await fake.listGroupThings());
});

test('two reads of the same job at the same moment are one call', async () => {
  const { fake, ids } = await fakeWithJobs(1);
  const seen = watchInFlight(fake);
  const aws = pace(fake, virtualTime());
  const [a, b] = await Promise.all([aws.describeJob(ids[0]), aws.describeJob(ids[0])]);
  assert.deepEqual(a, b);
  assert.equal(seen.calls, 1);
  // Once it is answered, the next read asks again.
  await aws.describeJob(ids[0]);
  assert.equal(seen.calls, 2);
});

test('a throttled read is tried again after a jittered wait, and succeeds', async () => {
  const { fake, ids } = await fakeWithJobs(1);
  const { time, clock, sleep } = virtualTime();
  const logs = [];
  const aws = pace(fake, { clock, sleep, random: () => 0.5, log: (line) => logs.push(line) });
  fake.failNext('describeJob', { times: ATTEMPTS - 1, code: 'throttled', awsName: 'ThrottlingException' });
  fake.calls.length = 0;

  const job = await aws.describeJob(ids[0]);

  assert.equal(job.jobId, ids[0]);
  assert.equal(fake.methodsCalled().filter((name) => name === 'describeJob').length, ATTEMPTS);
  // Each wait between half and all of a ceiling that doubles: 150 ms, then 300 ms.
  assert.deepEqual(time.waits, [0.75 * BACKOFF_MS, 1.5 * BACKOFF_MS]);
  assert.deepEqual(
    logs.map((line) => [line.event, line.operation, line.attempt]),
    [
      ['aws_throttled_retry', 'DescribeJob', 1],
      ['aws_throttled_retry', 'DescribeJob', 2],
    ]
  );
});

test(`a read throttled ${ATTEMPTS} times is reported as throttled; any other failure at once`, async () => {
  const { fake, ids } = await fakeWithJobs(1);
  const aws = pace(fake, virtualTime());
  fake.failNext('describeJob', { times: ATTEMPTS, code: 'throttled', awsName: 'ThrottlingException' });
  fake.calls.length = 0;
  await assert.rejects(aws.describeJob(ids[0]), { name: 'AwsError', code: 'throttled' });
  assert.equal(fake.methodsCalled().filter((name) => name === 'describeJob').length, ATTEMPTS);

  fake.failNext('describeJob');
  fake.calls.length = 0;
  await assert.rejects(aws.describeJob(ids[0]), { code: 'failed' });
  assert.equal(fake.methodsCalled().filter((name) => name === 'describeJob').length, 1);
});

// Through the API, as the Deployments page reads it.

async function deployments() {
  const { time, clock, sleep } = virtualTime();
  const context = createTestConsole({ pacing: { clock, sleep } });
  const manager = context.addUser('manager', ['release-managers']);
  const viewer = context.addUser('viewer', ['viewers']);
  for (const thing of [BOARD_A, BOARD_B]) context.fake.addThing(thing);
  const uploaded = await context.call('POST', '/api/firmware', {
    as: manager,
    body: { filename: 'zephyr.signed.bin', data: fixture('valid-1.2.3+4.signed.bin').toString('base64') },
  });
  assert.equal(uploaded.status, 201);
  const deploy = async (thing) => {
    const response = await context.call('POST', '/api/deployments', {
      as: manager,
      body: { version: '1.2.3+4', things: [thing] },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.deployment.id;
  };
  const list = () => context.call('GET', '/api/deployments', { as: viewer });
  const described = () =>
    context.fake.calls
      .filter((call) => call.method === 'describeJob')
      .map((call) => call.args[0])
      .sort();
  return { ...context, viewer, time, deploy, list, described };
}

test('the list reads a job again only when its summary is old or ListJobs says its status changed', async () => {
  const context = await deployments();
  const { fake } = context;
  const done = await context.deploy(BOARD_A);
  fake.execution(done, BOARD_A).update('SUCCEEDED', { running: '1.2.3+4' });
  const running = await context.deploy(BOARD_B);

  context.advance(2500);
  fake.calls.length = 0;
  assert.equal((await context.list()).status, 200);
  assert.deepEqual(context.described(), [done, running].sort());

  // A cache hit: within two seconds, nothing is described again.
  fake.calls.length = 0;
  context.advance(1000);
  await context.list();
  assert.deepEqual(context.described(), []);

  // The running job is read again a few seconds later, and as soon as ListJobs says it ended.
  context.advance(2500);
  fake.calls.length = 0;
  await context.list();
  assert.deepEqual(context.described(), [running]);
  // The board page reads the job a moment later, which keeps its summary young; then the board
  // finishes. Once ListJobs is asked again it says COMPLETED, and the young summary is not used.
  context.advance(1900);
  assert.equal((await context.call('GET', `/api/deployments/${running}`, { as: context.viewer })).status, 200);
  fake.execution(running, BOARD_B).update('SUCCEEDED', { running: '1.2.3+4' });
  context.advance(200);
  fake.calls.length = 0;
  const after = await context.list();
  assert.deepEqual(context.described(), [running]);
  assert.equal(after.body.deployments.find((entry) => entry.id === running).status, 'COMPLETED');
});

test('a finished job is kept for ten minutes, then read again: never for ever', async () => {
  const context = await deployments();
  const { fake } = context;
  const done = await context.deploy(BOARD_A);
  fake.execution(done, BOARD_A).update('SUCCEEDED', { running: '1.2.3+4' });
  context.advance(2500);
  await context.list();

  for (const step of [60_000, 4 * 60_000, 4 * 60_000]) {
    context.advance(step);
    fake.calls.length = 0;
    await context.list();
    assert.deepEqual(context.described(), [], `after ${step} ms more`);
  }
  context.advance(60_000 + 1);
  fake.calls.length = 0;
  await context.list();
  assert.deepEqual(context.described(), [done]);
});

test('throttled past its retries: the last summary if it is recent, else a 429 that says throttled', async () => {
  const context = await deployments();
  const { fake } = context;
  const running = await context.deploy(BOARD_A);
  context.advance(2500);
  const first = await context.list();
  assert.equal(first.status, 200);

  // A few seconds later AWS refuses every attempt: the summary of a moment ago is shown.
  context.advance(5000);
  fake.failNext('describeJob', { times: ATTEMPTS, code: 'throttled', awsName: 'ThrottlingException' });
  fake.calls.length = 0;
  const kept = await context.list();
  assert.equal(kept.status, 200);
  assert.deepEqual(kept.body, first.body);
  assert.equal(context.described().length, ATTEMPTS);
  assert.ok(context.logs.some((line) => line.event === 'summary_kept' && line.deployment === running));

  // Throttled once: retried and answered, nobody sees it.
  context.advance(5000);
  fake.failNext('describeJob', { code: 'throttled', awsName: 'ThrottlingException' });
  assert.equal((await context.list()).status, 200);

  // A summary older than a minute is not shown in place of an answer.
  context.advance(61_000);
  fake.failNext('describeJob', { times: ATTEMPTS, code: 'throttled', awsName: 'ThrottlingException' });
  const refused = await context.list();
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error.code, 'throttled');
});
