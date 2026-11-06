// The bridge: the methods this app answers are exactly the contract's for the features it offers, and a
// request is checked against the contract before anything is done, as both phone apps check it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { BridgeError, checkParams, createDispatcher, eventText, readContract } from '../src/lib/bridge.mjs';
import { FEATURES, METHODS, NOT_OFFERED, platformWord } from '../src/lib/features.mjs';

const text = readFileSync(new URL('../../shared/bridge.json', import.meta.url), 'utf8');
const contract = readContract(text);
const raw = JSON.parse(text);

test("the methods are exactly the contract's of the features offered, and every feature is either offered or not", () => {
  const expected = Object.entries(raw.methods)
    .filter(([, spec]) => spec.feature === null || FEATURES.includes(spec.feature))
    .map(([name]) => name)
    .sort();
  assert.deepEqual([...METHODS].sort(), expected);
  assert.deepEqual([...FEATURES, ...NOT_OFFERED].sort(), [...raw.features].sort());
  const handlers = Object.fromEntries(METHODS.map((method) => [method, () => ({})]));
  assert.deepEqual(createDispatcher(contract, handlers, [...FEATURES]).answered(), expected);
  assert.equal(platformWord('win32'), 'windows');
  assert.equal(platformWord('linux'), 'linux');
});

test("the page's bridge (bridge.js) finds this app's transport, the iPhone app's", async () => {
  const { findTransport } = await import('../../../cloud/web/src/site/assets/bridge.js');
  const sent = [];
  const win = { webkit: { messageHandlers: { cranium: { postMessage: (message) => sent.push(message) } } }, addEventListener() {} };
  const transport = findTransport(win);
  assert.equal(transport.platform, 'ios');
  transport.send('hello');
  assert.deepEqual(sent, ['hello']);
});

async function ask(dispatcher, request) {
  const answer = await dispatcher.handle(typeof request === 'string' ? request : JSON.stringify(request));
  return answer === null ? null : JSON.parse(answer);
}

test('a request is checked against the contract before anything is done', async () => {
  const done = [];
  const handlers = Object.fromEntries(
    METHODS.map((method) => [
      method,
      (params) => {
        done.push(method);
        return { echo: params };
      },
    ])
  );
  const dispatcher = createDispatcher(contract, handlers, [...FEATURES]);
  const fails = async (request, code) => {
    const answer = await ask(dispatcher, request);
    assert.equal(answer.ok, false, JSON.stringify(request));
    assert.equal(answer.error.code, code, JSON.stringify(request));
  };

  assert.deepEqual(await ask(dispatcher, { v: 1, id: 7, method: 'app.hello', params: {} }), { id: 7, ok: true, result: { echo: {} } });
  await fails({ v: 1, id: 1, method: 'nothing.here', params: {} }, 'unknown_method');
  await fails({ v: 1, id: 1, method: 'haptics.play', params: { kind: 'success' } }, 'unavailable');
  await fails({ v: 1, id: 1, method: 'biometric.status', params: { pool: 'admin' } }, 'unavailable');
  await fails({ v: 1, id: 1, method: 'update.check', params: {} }, 'unavailable');
  await fails({ v: 2, id: 1, method: 'app.hello', params: {} }, 'bad_request');
  await fails({ v: 1, id: 1, method: 'auth.session', params: {} }, 'bad_request');
  await fails({ v: 1, id: 1, method: 'auth.session', params: { pool: 'root' } }, 'bad_request');
  await fails({ v: 1, id: 1, method: 'auth.session', params: { pool: 'admin', extra: 1 } }, 'bad_request');
  await fails({ v: 1, id: 1, method: 'app.keepAwake', params: { on: 'yes' } }, 'bad_request');
  await fails({ v: 1, id: 1, method: 'clipboard.write', params: { text: 'x'.repeat(1025) } }, 'bad_request');
  await fails({ v: 1, id: 1, method: 'clipboard.write', params: { text: 'x', expiresIn: 601 } }, 'bad_request');
  await fails({ v: 1, id: 1, method: 'clipboard.write', params: { text: 'x', expiresIn: 1.5 } }, 'bad_request');
  await fails({ v: 1, id: 1, method: 'ble.connect', params: { id: 'a/b' } }, 'bad_request');
  await fails({ v: 1, id: 1, method: 'file.share', params: { name: '../x.csv', type: 'text/csv', data: '' } }, 'bad_request');
  await fails({ v: 1, id: 1, method: 'app.hello', params: [] }, 'bad_request');
  assert.deepEqual(done, ['app.hello']);
  // Not even an answer for what is no request: there is no id to answer.
  assert.equal(await ask(dispatcher, '{'), null);
  assert.equal(await ask(dispatcher, { v: 1, id: 0, method: 'app.hello', params: {} }), null);
  assert.equal(await ask(dispatcher, 'x'.repeat(contract.maxRequestBytes + 1)), null);
});

test("a handler's own refusal keeps its code; anything else is failed, in words of the app's", async () => {
  const dispatcher = createDispatcher(
    contract,
    {
      'app.open': () => {
        throw new BridgeError('not_allowed', 'No.');
      },
      'app.reload': () => {
        throw new Error('a secret inside');
      },
    },
    [...FEATURES]
  );
  assert.deepEqual((await ask(dispatcher, { v: 1, id: 2, method: 'app.open', params: { url: 'x' } })).error, { code: 'not_allowed', message: 'No.' });
  assert.deepEqual((await ask(dispatcher, { v: 1, id: 3, method: 'app.reload', params: {} })).error, {
    code: 'failed',
    message: 'The app could not do that.',
  });
});

test("parameters by the contract's types, and events by its names", () => {
  const spec = raw.methods['ble.watch'];
  assert.deepEqual(checkParams(spec, { on: false }), { on: false });
  assert.deepEqual(checkParams(spec, { on: true, version: '1.14.0+0', hash: '0123456789abcdef' }).hash, '0123456789abcdef');
  assert.throws(() => checkParams(spec, { on: true, version: '1.14' }), BridgeError);
  assert.equal(eventText(contract, 'ble.progress', { sent: 1, total: 2 }), '{"event":"ble.progress","data":{"sent":1,"total":2}}');
  assert.throws(() => eventText(contract, 'made.up', {}));
  assert.throws(() => createDispatcher(contract, { 'made.up': () => ({}) }, []));
});
