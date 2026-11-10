/**
 * Tests for the bulk setup queue (setup.js createBulkQueue and its helpers): ordering, retry, skip, the name
 * pattern, name collisions and the group call. The board flow is a stand-in; no port is ever opened.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SETUP } from './page.mjs';

const { BULK_MAX, addThingToGroup, checkPattern, createBulkQueue, nextFreeName } = await import(SETUP);

/** A flow whose boards come from a script: each connect takes the next entry { thing, fail: {step, error} }. */
function fakeFlow(boards) {
  const calls = [];
  const flow = {
    calls,
    steps: {},
    board: null,
    async disconnect() {
      calls.push('disconnect');
      flow.board = null;
      flow.steps = Object.fromEntries(
        ['connect', 'golden', 'firmware', 'setup', 'online'].map((key) => [key, { status: 'todo', error: null }])
      );
    },
    async connect() {
      const board = boards.shift();
      flow.script = board;
      calls.push('connect');
      flow.board = { thing: board.thing };
      flow.steps.connect =
        board.fail?.step === 'connect' ? { status: 'failed', error: board.fail.error } : { status: 'done' };
    },
    skip(key) {
      calls.push(`skip ${key}`);
      flow.steps[key] = { status: 'skipped' };
    },
    async run(key) {
      calls.push(key);
      flow.steps[key] =
        flow.script.fail?.step === key ? { status: 'failed', error: flow.script.fail.error } : { status: 'done' };
    },
    async runSetup(values) {
      calls.push(`setup ${values.id}`);
      flow.steps.setup =
        flow.script.fail?.step === 'setup' ? { status: 'failed', error: flow.script.fail.error } : { status: 'done' };
    },
  };
  return flow;
}

const THINGS = ['cranium-00000000000000a1', 'cranium-00000000000000a2', 'cranium-00000000000000a3'];

function make({ boards, names = [], count = 3, group = 'g1', newest = true, addToGroup } = {}) {
  const flow = fakeFlow(boards);
  const added = [];
  const queue = createBulkQueue({
    flow,
    adapters: {
      names: async () => names,
      addToGroup: addToGroup ?? (async (id, thing) => void added.push([id, thing])),
      wifi: () => ({ ssid: 'net', security: 'WPA2_PSK', passphrase: 'password1' }),
    },
    settings: { pattern: 'Studio{n}', start: 1, count, group, newest },
  });
  return { flow, queue, added };
}

test('a name pattern needs one {n}, letters and digits, and a name that fits', () => {
  assert.equal(checkPattern('Studio{n}', 1, 5), null);
  assert.match(checkPattern('Studio', 1, 5), /\{n\}/);
  assert.match(checkPattern('{n}{n}', 1, 5), /\{n\}/);
  assert.match(checkPattern('Studio-{n}', 1, 5), /letters and digits/);
  assert.match(checkPattern('Studio{n}', -1, 5), /Start/);
  assert.match(checkPattern('Studio{n}', 1, BULK_MAX + 1), /boards/);
  assert.notEqual(checkPattern(`${'a'.repeat(31)}{n}`, 1, 20), null);
});

test('names are numbered in order and skip the ones the console has, whatever their case', async () => {
  assert.deepEqual(nextFreeName('Lab{n}', 3, new Set(['lab3', 'lab4'])), { n: 5, name: 'Lab5' });
  const { queue } = make({ boards: [], names: ['studio2', 'Other'] });
  await queue.prepare();
  assert.deepEqual(
    queue.items.map((item) => item.label),
    ['Studio1', 'Studio3', 'Studio4']
  );
});

test('an invalid pattern makes no queue', async () => {
  const flow = fakeFlow([]);
  const queue = createBulkQueue({
    flow,
    adapters: { names: async () => [], addToGroup: async () => {}, wifi: () => ({}) },
    settings: { pattern: 'x', start: 1, count: 2, group: null, newest: true },
  });
  await assert.rejects(queue.prepare(), /\{n\}/);
  assert.equal(queue.started, false);
});

test('boards go through the flow in order and are added to the group', async () => {
  const { queue, flow, added } = make({ boards: THINGS.map((thing) => ({ thing })) });
  await queue.prepare();
  await queue.runNext();
  await queue.runNext();
  assert.deepEqual(
    queue.items.map((item) => item.status),
    ['done', 'done', 'queued']
  );
  assert.deepEqual(added, [
    ['g1', THINGS[0]],
    ['g1', THINGS[1]],
  ]);
  assert.deepEqual(flow.calls.slice(0, 9), [
    'disconnect',
    'connect',
    'skip golden',
    'firmware',
    'setup Studio1',
    'online',
    'disconnect',
    'disconnect',
    'connect',
  ]);
  assert.deepEqual(queue.summary(), { done: 2, failed: 0, skipped: 0, queued: 1 });
});

test('the newest firmware is left out when not asked for, and no group means no group call', async () => {
  const { queue, flow, added } = make({ boards: [{ thing: THINGS[0] }], newest: false, group: null, count: 1 });
  await queue.prepare();
  await queue.runNext();
  assert.ok(flow.calls.includes('skip firmware'));
  assert.deepEqual(added, []);
  assert.equal(queue.items[0].status, 'done');
});

test('a failure says the step and the reason, and the next board is still the next in line', async () => {
  const { queue } = make({
    boards: [{ thing: THINGS[0], fail: { step: 'setup', error: 'The board refused WIFI_SEC.' } }, { thing: THINGS[1] }],
  });
  await queue.prepare();
  await queue.runNext();
  assert.equal(queue.items[0].status, 'failed');
  assert.equal(queue.items[0].step, 'setup');
  assert.equal(queue.items[0].reason, 'The board refused WIFI_SEC.');
  assert.equal(queue.current().label, 'Studio2');
  await queue.runNext();
  assert.equal(queue.items[1].status, 'done');
  assert.deepEqual(queue.summary(), { done: 1, failed: 1, skipped: 0, queued: 1 });
});

test('retry puts a failed board back in its place, with the same name', async () => {
  const { queue, flow } = make({
    boards: [{ thing: THINGS[0], fail: { step: 'connect', error: 'No port was chosen.' } }, { thing: THINGS[0] }],
    count: 2,
  });
  await queue.prepare();
  await queue.runNext();
  assert.equal(queue.items[0].step, 'connect');
  queue.retry(2);
  assert.equal(queue.items[1].status, 'queued', 'only a failed board can be retried');
  queue.retry(1);
  assert.equal(queue.current().label, 'Studio1');
  await queue.runNext();
  assert.equal(queue.items[0].status, 'done');
  assert.ok(flow.calls.includes('setup Studio1'));
});

test('skip passes a queued or failed board over, never a done one', async () => {
  const { queue } = make({ boards: [{ thing: THINGS[0] }, { thing: THINGS[1] }] });
  await queue.prepare();
  queue.skip(1);
  assert.equal(queue.items[0].status, 'skipped');
  assert.equal(queue.current().label, 'Studio2');
  await queue.runNext();
  queue.skip(2);
  assert.equal(queue.items[1].status, 'done');
  assert.deepEqual(queue.summary(), { done: 1, failed: 0, skipped: 1, queued: 1 });
});

test('a failed group call fails the board at the group step, and a retry only redoes the group', async () => {
  let tries = 0;
  const { queue, flow } = make({
    boards: [{ thing: THINGS[0] }],
    count: 1,
    addToGroup: async () => {
      tries += 1;
      if (tries === 1) throw new Error('The console refused.');
    },
  });
  await queue.prepare();
  await queue.runNext();
  assert.equal(queue.items[0].status, 'failed');
  assert.equal(queue.items[0].step, 'group');
  const connects = flow.calls.filter((call) => call === 'connect').length;
  queue.retry(1);
  await queue.runNext();
  assert.equal(queue.items[0].status, 'done');
  assert.equal(flow.calls.filter((call) => call === 'connect').length, connects, 'the board was not set up again');
});

test('a name another board takes meanwhile gives way to the next free one, and no name is used twice', async () => {
  const names = [];
  const flow = fakeFlow([{ thing: THINGS[0] }, { thing: THINGS[1] }]);
  const queue = createBulkQueue({
    flow,
    adapters: { names: async () => names, addToGroup: async () => {}, wifi: () => ({}) },
    settings: { pattern: 'Studio{n}', start: 1, count: 2, group: null, newest: true },
  });
  await queue.prepare();
  names.push('Studio1');
  await queue.runNext();
  assert.equal(queue.items[0].label, 'Studio3', 'Studio2 is reserved for the second board');
  await queue.runNext();
  assert.deepEqual(
    queue.items.map((item) => item.label),
    ['Studio3', 'Studio2']
  );
  assert.ok(flow.calls.includes('setup Studio3') && flow.calls.includes('setup Studio2'));
});

test('a board is added to a group with the boards it has, through the groups route', async () => {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push([method, path, body]);
    if (method === 'GET') return { groups: [{ id: 'g1', name: 'Studio', things: [THINGS[1]] }] };
    return {};
  };
  await addThingToGroup(request, 'g1', THINGS[0]);
  assert.deepEqual(calls[1], ['POST', '/api/groups/g1', { things: [THINGS[1], THINGS[0]] }]);
  calls.length = 0;
  await addThingToGroup(request, 'g1', THINGS[1]);
  assert.equal(calls.length, 1, 'a board that is in already is not sent again');
});

test('a group changed at the same moment is read again and tried again; other errors are said', async () => {
  let posts = 0;
  const moved = async (method) => {
    if (method === 'GET') return { groups: [{ id: 'g1', things: [] }] };
    posts += 1;
    if (posts < 3) throw Object.assign(new Error('moved'), { code: 'group_changed', status: 409 });
    return {};
  };
  await addThingToGroup(moved, 'g1', THINGS[0]);
  assert.equal(posts, 3);
  const forbidden = async (method) => {
    if (method === 'GET') return { groups: [{ id: 'g1', things: [] }] };
    throw Object.assign(new Error('no'), { status: 403 });
  };
  await assert.rejects(addThingToGroup(forbidden, 'g1', THINGS[0]), /release manager/);
  await assert.rejects(
    addThingToGroup(async () => ({ groups: [] }), 'g1', THINGS[0]),
    /not on the console/
  );
});
