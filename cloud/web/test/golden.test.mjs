/**
 * Golden image promotion on the console (console 2.27.7): the Make golden button on a release, its
 * dialog (the record first, then the boards), a board's golden image on its page, and what the client
 * reads and sends. The scripts are the very files the browser loads, drawing into the stand-in
 * document of page.mjs.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE, VIEWS, all, createDocument, one, textOf } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
globalThis.document = createDocument();

const NOW = Date.parse('2026-11-11T12:00:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const loaded = (value) => ({ value, error: null, loadedAt: NOW, loading: false });
const A = 'cranium-00000000000000aa';
const B = 'cranium-00000000000000bb';

function draw(node) {
  const box = document.createElement('div');
  views.render(box, node);
  return box;
}

const release = (changes = {}) => ({
  version: '1.19.3+0',
  size: 1000,
  sha256: 'a'.repeat(64),
  imageHash: 'b'.repeat(64),
  keyHash: '',
  payloadSize: 900,
  headerSize: 512,
  loadAddress: 196608,
  filename: 'zephyr.signed.bin',
  notes: '',
  uploadedBy: { sub: 's', email: 'manager@example.invalid' },
  uploadedAt: at(60_000),
  status: 'active',
  revoked: null,
  board: 'nrf7002dk',
  ...changes,
});

function page(canWrite, releases, goldenKey = true) {
  const calls = [];
  const box = draw(
    views.firmwareView({
      state: {
        now: NOW,
        me: { canWrite },
        route: { view: 'firmware' },
        upload: { stage: 'idle', over: false },
        firmware: loaded({ releases, fingerprint: 'd'.repeat(64), slotSize: 933888, goldenKey }),
        deployments: loaded([]),
        devices: loaded({ devices: [] }),
      },
      actions: new Proxy(
        {},
        {
          get:
            (target, name) =>
            (...args) =>
              calls.push([name, ...args]),
        }
      ),
    })
  );
  return { box, calls };
}

test('a release manager has Make golden on an active release of a board with Wi-Fi; a viewer has not', () => {
  const { box, calls } = page(true, [
    release(),
    release({ version: '1.19.1+0', status: 'revoked', revoked: { by: {}, at: at(1000), reason: 'bad' } }),
    release({ version: '1.19.0+0', board: 'nrf5340dk' }),
  ]);
  const rows = all(box, 'li.release');
  one(rows[0], 'button', 'Make golden').dispatchEvent({ type: 'click' });
  assert.deepEqual(
    calls.filter(([name]) => name === 'openGolden').map(([, item]) => item.version),
    ['1.19.3+0']
  );
  // Not on a revoked release, and not for a board without Wi-Fi: no job reaches one.
  for (const row of rows.slice(1)) {
    assert.equal(
      all(row, 'button').some((el) => textOf(el) === 'Make golden'),
      false
    );
  }
  assert.equal(
    all(page(false, [release()]).box, 'button').some((el) => textOf(el) === 'Make golden'),
    false
  );
});

test('a release with a record says so', () => {
  const { box } = page(true, [release({ golden: { counter: 2, uploadedBy: {}, uploadedAt: at(10) } })]);
  assert.match(textOf(one(box, 'li.release')), /Golden record, counter 2/);
});

function dialogModel(changes = {}) {
  const boards = [
    { thing: A, name: 'CRANIUM01', label: null, golden: { version: '1.5.0+0', counter: 0, state: 'none' } },
    { thing: B, name: null, label: 'Bench', golden: null },
  ];
  return {
    release: release(),
    boards,
    groups: [{ id: 'g1', name: 'Lab' }],
    scope: 'fleet',
    bytes: null,
    sending: false,
    error: null,
    close() {},
    signIn() {},
    setScope() {},
    setFile() {},
    targets: () => boards,
    submit() {},
    ...changes,
  };
}

test('the dialog asks for the record first, then the boards that run the release', () => {
  const first = draw(views.goldenDialog(dialogModel()));
  assert.match(textOf(first), /tools\/golden_promote\.py sign/);
  assert.ok(all(first, 'input').some((el) => el.getAttribute('type') === 'file'));
  const upload = all(first, 'button').find((el) => textOf(el) === 'Upload record');
  assert.ok(upload);
  assert.equal(upload.disabled === true || upload.getAttribute('disabled') !== null, true, 'no file chosen yet');

  const second = draw(
    views.goldenDialog(dialogModel({ release: release({ golden: { counter: 3, uploadedBy: {}, uploadedAt: at(5) } }) }))
  );
  const words = textOf(second);
  assert.match(words, /Counter 3/);
  assert.match(words, /only if it runs it and has confirmed it/);
  // Each board with its golden image now.
  assert.match(words, /CRANIUM01 golden now: 1\.5\.0\+0/);
  assert.match(words, /Bench golden now: not reported/);
  const options = all(second, 'option').map(textOf);
  assert.deepEqual(options, ['Every board that runs 1.19.3+0', 'Group: Lab', 'Board: CRANIUM01', 'Board: Bench']);
  assert.ok(all(second, 'button').some((el) => textOf(el) === 'Make golden on 2 boards'));

  const none = draw(
    views.goldenDialog(
      dialogModel({
        release: release({ golden: { counter: 3, uploadedBy: {}, uploadedAt: at(5) } }),
        targets: () => [],
      })
    )
  );
  assert.match(textOf(none), /No board here runs 1\.19\.3\+0 with golden image promotion yet: deploy it first/);
});

test("a board's golden image: the version, its counter, and a refusal in words", () => {
  const sealed = draw(views.goldenFact({ version: '1.19.3+0', counter: 1, state: 'sealed' }));
  assert.equal(textOf(sealed), '1.19.3+0 (counter 1)');
  const first = draw(views.goldenFact({ version: null, counter: 0, state: 'none' }));
  assert.equal(textOf(first), 'The one its bootloader was built with');
  const refused = draw(views.goldenFact({ version: '1.19.3+0', counter: 1, state: 'not_confirmed' }));
  assert.match(textOf(refused), /Last promotion refused: the release was still on trial/);
});

test('the client reads golden records and boards, and sends a record and a promotion', async () => {
  assert.deepEqual(core.readGolden({ version: '1.19.3+0', counter: 1, state: 'sealed' }), {
    version: '1.19.3+0',
    counter: 1,
    state: 'sealed',
  });
  assert.equal(core.readGolden({ version: '1.19.3+0', counter: 1, state: '<b>' }), null);
  assert.equal(core.readGolden({ version: '1.19.3+0', counter: -1, state: 'sealed' }), null);

  const calls = [];
  const replies = [
    { release: { version: '1.19.3+0', status: 'active', golden: { counter: 4, uploadedAt: at(1) } } },
    { promotion: { id: 'gold-1-19-3-b0-c4-20261111T120000Z-abcd', things: [A] } },
    {
      goldenKey: { present: true },
      promotions: [{ id: 'gold-1-19-3-b0-c4-20261111T120000Z-abcd', version: '1.19.3+0', counter: 4 }],
    },
  ];
  const api = core.createApi({
    auth: { accessToken: () => 'T' },
    crypto: globalThis.crypto,
    clock: core.createClock(),
    onUnauthorized() {},
    pause: async () => {},
    fetch: async (path, options) => {
      calls.push([options.method, path, options.body]);
      return new Response(JSON.stringify(replies.shift()), { status: 200 });
    },
  });
  const changed = await api.uploadGolden('1.19.3+0', new Uint8Array([1, 2, 3]));
  assert.deepEqual(calls[0], ['POST', '/api/firmware/1.19.3%2B0/golden', JSON.stringify({ record: 'AQID' })]);
  assert.equal(changed.golden.counter, 4);

  const started = await api.promoteGolden({ version: '1.19.3+0', things: [A], note: '' });
  assert.deepEqual(calls[1], [
    'POST',
    '/api/golden/promotions',
    JSON.stringify({ version: '1.19.3+0', things: [A], note: '' }),
  ]);
  assert.deepEqual(started.things, [A]);

  const listed = await api.goldenPromotions();
  assert.equal(listed.present, true);
  assert.equal(listed.promotions[0].counter, 4);
  assert.deepEqual(calls[2].slice(0, 2), ['GET', '/api/golden/promotions']);
});

test('the activity log tells a golden record and a promotion in words, under Deployments and Firmware', () => {
  assert.ok(core.activityActions('firmware').includes('firmware.golden_record'));
  assert.ok(core.activityActions('deployments').includes('golden.promote'));
  assert.ok(core.CHANGE_ACTIONS.includes('golden.promote'));
});

test('Make golden is offered only from 1.19.3 on, and only on a stack with the golden key', () => {
  const has = (box) => all(box, 'button').some((el) => textOf(el) === 'Make golden');
  assert.equal(has(page(true, [release()]).box), true);
  // No board can run an earlier release and take the job.
  assert.equal(has(page(true, [release({ version: '1.19.2+0' })]).box), false);
  assert.equal(has(page(true, [release({ version: '1.20.0+0' })]).box), true);
  // Without the key every upload would be refused.
  assert.equal(has(page(true, [release()], false).box), false);
  assert.equal(core.takesGolden('1.19.3+0'), true);
  assert.equal(core.takesGolden('1.19.2+9'), false);
  assert.equal(core.takesGolden('not a version'), false);
});

test('the client reads whether the stack has a golden key', async () => {
  const replies = [
    { releases: [], signingKey: { fingerprint: 'd'.repeat(64) }, slotSize: 933888, goldenKey: { present: true } },
    { releases: [], signingKey: { fingerprint: 'd'.repeat(64) }, slotSize: 933888 },
  ];
  const api = core.createApi({
    auth: { accessToken: () => 'T' },
    crypto: globalThis.crypto,
    clock: core.createClock(),
    onUnauthorized() {},
    pause: async () => {},
    fetch: async () => new Response(JSON.stringify(replies.shift()), { status: 200 }),
  });
  assert.equal((await api.firmware()).goldenKey, true);
  assert.equal((await api.firmware()).goldenKey, false);
});
