/**
 * Tests for the hardware self-test in Board setup (setup.js parseSelfTest, createSetupFlow runSelfTest, the
 * card, and the queue's optional step): the board's SELFTEST replies are parsed, and nothing but the
 * command is ever sent. The board is the page's own simulated one; no port is opened.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SETUP, VIEWS, createDocument, one, textOf } from './page.mjs';

const setup = await import(SETUP);
const views = await import(VIEWS);

globalThis.document = createDocument();

const REPLY = [
  'leds|visual|LED1, LED2, then both lit: look at the board',
  'buttons|pass|Button 1 up, Button 2 up',
  'wifi|pass|7 networks seen',
  'flash|pass|ID c22817, sector written, read, erased',
  'ram|pass|heap 5000 B free, 256 B allocated and checked',
];
const OK = 'OK 4 passed, 0 failed, 0 skipped, 1 visual';

test('a good SELFTEST reply gives one row per check and is ok', () => {
  const parsed = setup.parseSelfTest(REPLY, OK);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.supported, true);
  assert.equal(parsed.message, '');
  assert.deepEqual(
    parsed.checks.map((check) => [check.name, check.result]),
    [
      ['leds', 'visual'],
      ['buttons', 'pass'],
      ['wifi', 'pass'],
      ['flash', 'pass'],
      ['ram', 'pass'],
    ]
  );
  assert.equal(parsed.checks[3].detail, 'ID c22817, sector written, read, erased');
});

test('a failed check is not ok, even if the final line says OK', () => {
  const lines = [...REPLY.slice(0, 3), 'flash|fail|ID c22817, erase failed (-5)', REPLY[4]];
  const failed = setup.parseSelfTest(lines, 'ERR 1 failed, 3 passed, 0 skipped, 1 visual');
  assert.equal(failed.ok, false);
  assert.equal(failed.message, '1 failed, 3 passed, 0 skipped, 1 visual');
  assert.equal(failed.checks.find((check) => check.name === 'flash').result, 'fail');
  assert.equal(setup.parseSelfTest(lines, OK).ok, false);
});

test('a skipped check is shown and does not fail the test', () => {
  const lines = REPLY.map((line) => (line.startsWith('wifi') ? 'wifi|skip|no Wi-Fi interface' : line));
  const parsed = setup.parseSelfTest(lines, 'OK 3 passed, 0 failed, 1 skipped, 1 visual');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.checks[2].result, 'skip');
});

test('lines that are not checks are passed over, and a bad result word is not a check', () => {
  const parsed = setup.parseSelfTest(['', 'noise', 'wifi|maybe|x', 'a|b', ...REPLY], OK);
  assert.equal(parsed.checks.length, 5);
  assert.equal(parsed.ok, true);
});

test('firmware without the command, a refusal and an empty reply are told in words', () => {
  const old = setup.parseSelfTest([], 'ERR unknown command SELFTEST, type HELP');
  assert.equal(old.supported, false);
  assert.match(old.message, /1\.17\.0/);
  const busy = setup.parseSelfTest([], 'ERR update in progress');
  assert.equal(busy.ok, false);
  assert.equal(busy.message, 'update in progress');
  assert.equal(setup.parseSelfTest([], 'OK').ok, false);
  assert.equal(setup.parseSelfTest(undefined, undefined).message, 'The board gave no answer.');
});

test('a very long detail is not taken, so a reply cannot flood the page', () => {
  const parsed = setup.parseSelfTest([`ram|pass|${'x'.repeat(200)}`], 'OK');
  assert.equal(parsed.checks.length, 0);
});

const FAST = Object.freeze({
  handshake: 150,
  listening: 300,
  restart: 1500,
  swap: 1500,
  comeBack: 3000,
  status: 1000,
  init: 1000,
  selftest: 1000,
  selftestButton: 100,
  wifi: 1000,
  keygen: 1000,
  chunk: 1000,
  store: 1000,
  poll: 20,
  online: 400,
  seal: 1500,
});

function makeFlow() {
  const board = setup.simulatedBoard({ state: 'OPERATING' });
  const flow = setup.createSetupFlow({
    serial: { requestPort: async () => board.port },
    api: {},
    subtle: globalThis.crypto.subtle,
    timing: FAST,
  });
  return { board, flow };
}

test('the flow runs SELFTEST on a connected board and keeps the rows', async () => {
  const { board, flow } = makeFlow();
  await flow.connect();
  assert.equal(flow.selftest.state, 'idle');
  await flow.runSelfTest();
  assert.equal(flow.selftest.state, 'done');
  assert.equal(flow.selftest.ok, true);
  assert.equal(flow.selftest.checks.length, 5);
  assert.equal(flow.busy, false);
  assert.ok(board.lines.includes('SELFTEST'));
  // It is no step: the steps are as Connect left them.
  assert.equal(flow.steps.golden.status, 'todo');
  await flow.runSelfTest({ button: true });
  assert.match(flow.selftest.checks[1].detail, /pressed/);
  await flow.disconnect();
  assert.equal(flow.selftest.state, 'idle');
});

test('without a board the self-test fails in words instead of throwing', async () => {
  const { flow } = makeFlow();
  await flow.runSelfTest();
  assert.equal(flow.selftest.state, 'failed');
  assert.match(flow.selftest.problem, /Connect to a board/);
  assert.equal(flow.busy, false);
});

test('the card is offered after Connect, shows the table, and never a network name', async () => {
  const { flow } = makeFlow();
  const box = document.createElement('div');
  document.body.appendChild(box);
  const draw = () => views.render(box, setup.selfTestCard(flow) ?? views.h('div', {}));
  draw();
  assert.equal(textOf(box), '');
  await flow.connect();
  draw();
  assert.ok(textOf(box).includes('Hardware self-test'));
  assert.ok(textOf(box).includes('optional'));
  one(box, 'button', 'Run self-test');
  await flow.runSelfTest();
  draw();
  const text = textOf(box);
  for (const word of ['leds', 'Look at the board', '7 networks seen', 'flash', 'Pass'])
    assert.ok(text.includes(word), word);
  one(box, 'button', 'Run self-test again');
  await flow.disconnect();
});

function queueFlow({ selftest }) {
  const calls = [];
  const flow = {
    calls,
    steps: {},
    board: null,
    selftest: null,
    async disconnect() {
      flow.board = null;
      flow.steps = Object.fromEntries(
        ['connect', 'golden', 'firmware', 'setup', 'online'].map((key) => [key, { status: 'todo', error: null }])
      );
    },
    async connect() {
      flow.board = { thing: 'cranium-00000000000000a1' };
      flow.steps.connect = { status: 'done' };
    },
    skip(key) {
      flow.steps[key] = { status: 'skipped' };
    },
    async run(key) {
      flow.steps[key] = { status: 'done' };
    },
    async runSelfTest(options) {
      calls.push(['selftest', options]);
      flow.selftest = selftest;
    },
    async runSetup() {
      calls.push(['setup']);
      flow.steps.setup = { status: 'done' };
    },
  };
  return flow;
}

function queueOf(flow, settings) {
  return setup.createBulkQueue({
    flow,
    adapters: { names: async () => [], wifi: () => ({}), addToGroup: async () => {} },
    settings: { pattern: 'Lab{n}', start: 1, count: 1, group: null, newest: true, ...settings },
  });
}

test('the queue runs the self-test before setting a board up, only when asked, and stops it on a failed check', async () => {
  const good = queueFlow({ selftest: { state: 'done', ok: true, checks: [] } });
  const off = queueOf(good, { selftest: false });
  await off.prepare();
  await off.runNext();
  assert.equal(off.items[0].status, 'done');
  assert.deepEqual(
    good.calls.map((call) => call[0]),
    ['setup']
  );

  const on = queueOf(good, { selftest: true });
  good.calls.length = 0;
  await on.prepare();
  await on.runNext();
  assert.equal(on.items[0].status, 'done');
  assert.deepEqual(
    good.calls.map((call) => call[0]),
    ['selftest', 'setup']
  );

  const bad = queueFlow({
    selftest: {
      state: 'done',
      ok: false,
      checks: [
        { name: 'flash', result: 'fail' },
        { name: 'ram', result: 'pass' },
      ],
    },
  });
  const stopped = queueOf(bad, { selftest: true });
  await stopped.prepare();
  await stopped.runNext();
  assert.equal(stopped.items[0].status, 'failed');
  assert.equal(stopped.items[0].step, 'selftest');
  assert.equal(stopped.items[0].reason, 'flash failed');
  assert.deepEqual(
    bad.calls.map((call) => call[0]),
    ['selftest']
  );

  const unsupported = queueFlow({
    selftest: { state: 'failed', ok: false, checks: [], problem: 'This firmware has no self-test.' },
  });
  const old = queueOf(unsupported, { selftest: true });
  await old.prepare();
  await old.runNext();
  assert.equal(old.items[0].reason, 'This firmware has no self-test.');
});

test('views.js is the one the card was drawn with', () => {
  assert.equal(typeof views.h, 'function');
});
