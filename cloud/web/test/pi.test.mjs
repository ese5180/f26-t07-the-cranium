/**
 * Raspberry Pi images on the console (console 2.30.0): the Firmware page's part for boards wired to a Pi, its
 * deploy and cancel dialogs, a board's Pi, the words for progress and estimates, and what the client reads and
 * sends, the package's PUT to S3 included. The scripts are the very files the browser loads, drawing into the
 * stand-in document of page.mjs. The package header is one tools/pi_image.py of PR #279 made
 * (cloud/api/test/fixtures/pi-delta.json).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CORE, VIEWS, all, createDocument, one, textOf } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
globalThis.document = createDocument();

const FIXTURE = JSON.parse(readFileSync(new URL('../../api/test/fixtures/pi-delta.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-24T12:00:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const loaded = (value) => ({ value, error: null, loadedAt: NOW, loading: false });
const A = 'cranium-00000000000000aa';
const B = 'cranium-00000000000000bb';
const C = 'cranium-00000000000000cc';

function draw(node) {
  const box = document.createElement('div');
  views.render(box, node);
  return box;
}

const card = (changes = {}) => ({
  card: 'ready',
  version: '2026.11.10-1',
  generation: 1,
  step: 'idle',
  done: 0,
  total: 0,
  ...changes,
});

const image = (changes = {}) => ({
  kind: 'pi',
  version: '2026.11.24-1',
  status: 'active',
  size: 48128,
  imageSize: 44032,
  blockSize: 4096,
  blocks: 11,
  sha256: 'e'.repeat(64),
  notes: 'Mixxx 2.5.1',
  uploadedBy: { sub: 's', email: 'manager@example.invalid' },
  uploadedAt: at(60_000),
  verifiedAt: at(50_000),
  refusedReason: '',
  ...changes,
});

const row = (changes = {}) => ({
  thing: A,
  status: 'IN_PROGRESS',
  step: 'blocks',
  progress: 33,
  done: 1,
  total: 3,
  fetched: null,
  changed: null,
  bytes: null,
  piVersion: null,
  generation: null,
  reason: null,
  running: null,
  lastUpdatedAt: at(1000),
  ...changes,
});

const counts = (changes = {}) => ({
  queued: 0,
  inProgress: 0,
  succeeded: 0,
  failed: 0,
  rejected: 0,
  canceled: 0,
  timedOut: 0,
  removed: 0,
  ...changes,
});

function page({ canWrite = true, images = [image()], deployments = [], devices = [], app = null } = {}) {
  const calls = [];
  const box = draw(
    views.firmwareView({
      state: {
        now: NOW,
        me: { canWrite },
        app,
        route: { view: 'firmware' },
        upload: { stage: 'idle', over: false },
        firmware: loaded({ releases: [], fingerprint: 'd'.repeat(64), slotSize: 933888, goldenKey: false }),
        deployments: loaded([]),
        devices: loaded({ devices }),
        pi: loaded({ images, deployments, firstFirmware: '1.20.0', maxPackageSize: 5 * 1024 ** 3 }),
        piUpload: { stage: 'idle', file: null, header: null, notes: '', sent: 0, error: null, image: null },
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

// --- the page --------------------------------------------------------------------------------------

test('the Firmware page lists the Pi images, each marked as one, and a release manager deploys an active one', () => {
  const devices = [
    { thing: A, fw: { version: '1.20.0+0', confirmed: true }, pi: card() },
    {
      thing: B,
      fw: { version: '1.19.3+0', confirmed: true },
      pi: card({ card: 'empty', version: null, generation: 0 }),
    },
    { thing: C, fw: { version: '1.20.0+0', confirmed: true } },
  ];
  const { box, calls } = page({
    images: [
      image(),
      image({ version: '2026.11.20-1', status: 'uploading' }),
      image({
        version: '2026.11.19-1',
        status: 'refused',
        refusedReason: 'The header that arrived is not the one that was checked.',
      }),
    ],
    devices,
  });
  const words = textOf(box);
  assert.match(words, /Raspberry Pi images/);
  assert.match(words, /2 boards with a Pi, 1 of them able to take an image now/);
  const rows = all(box, 'li.pi-image');
  assert.equal(rows.length, 3);
  for (const item of rows) assert.match(textOf(item), /Pi image/);
  assert.match(textOf(rows[0]), /43 KiB image/);
  assert.match(textOf(rows[0]), /11 blocks of 4 KiB/);
  assert.match(textOf(rows[1]), /Not checked yet/);
  assert.match(textOf(rows[2]), /Refused/);
  one(rows[0], 'button', 'Deploy').dispatchEvent({ type: 'click' });
  assert.deepEqual(
    calls.filter(([name]) => name === 'openPiDeploy').map(([, item]) => item.version),
    ['2026.11.24-1']
  );
  // Nothing to deploy of an image that has not been checked, or was refused.
  for (const item of rows.slice(1))
    assert.equal(
      all(item, 'button').some((el) => textOf(el) === 'Deploy'),
      false
    );
  // The upload, on the website.
  assert.ok(all(box, 'input').some((el) => (el.getAttribute('accept') ?? '').includes('.cpd')));
  assert.ok(all(box, 'button').some((el) => textOf(el) === 'Upload and check'));
});

test('a viewer reads the Pi images and deploys nothing; in the apps the package goes from the website', () => {
  const viewer = page({ canWrite: false });
  assert.equal(
    all(viewer.box, 'button').some((el) => textOf(el) === 'Deploy'),
    false
  );
  const packageInput = (box) => all(box, 'input').some((el) => (el.getAttribute('accept') ?? '').includes('.cpd'));
  assert.equal(packageInput(viewer.box), false);

  const inApp = page({ app: { name: 'iPhone' } });
  assert.equal(packageInput(inApp.box), false);
  assert.match(textOf(inApp.box), /A Pi image package is sent from the console’s website/);
  assert.ok(all(inApp.box, 'button').some((el) => textOf(el).startsWith('Upload on the website')));
  // Deploying is the same in the apps.
  assert.ok(all(inApp.box, 'button').some((el) => textOf(el) === 'Deploy'));
});

test("a Pi deployment shows each board's progress, then its result, and a release manager can cancel it", () => {
  const devices = [{ thing: A, label: 'Bench', fw: { version: '1.20.0+0', confirmed: true }, pi: card() }];
  const deployments = [
    {
      id: 'pi-2026-11-24-1-20261124T110000Z-beef',
      version: '2026.11.24-1',
      status: 'IN_PROGRESS',
      createdAt: at(3_600_000),
      createdBy: { sub: 's', email: 'manager@example.invalid' },
      note: '',
      things: [A, B],
      counts: counts({ inProgress: 1, failed: 1 }),
      executions: [row(), row({ thing: B, status: 'FAILED', step: 'table', reason: 'sd_absent', progress: null })],
    },
    {
      id: 'pi-2026-11-10-1-20261110T110000Z-cafe',
      version: '2026.11.10-1',
      status: 'COMPLETED',
      createdAt: at(86_400_000),
      createdBy: null,
      note: '',
      things: [A],
      counts: counts({ succeeded: 1 }),
      executions: [row({ status: 'SUCCEEDED', step: null, fetched: 10, changed: 10, bytes: 41824 })],
    },
  ];
  const { box, calls } = page({ deployments, devices });
  const rows = all(box, 'li.pi-deployment');
  assert.equal(rows.length, 2);
  assert.equal(textOf(all(rows[0], 'span.pi-board-name')[0]), 'Bench');
  assert.match(textOf(rows[0]), /Bench ?Downloading changed blocks: 1 of 3 \(33 %\)/);
  assert.match(textOf(rows[0]), /Failed while downloading the block hashes: no SD card/);
  assert.equal(all(rows[0], 'div.meter').length, 1);
  assert.match(textOf(rows[1]), /Done: 10 of 10 changed blocks downloaded, 41 KiB/);
  one(rows[0], 'button', 'Cancel').dispatchEvent({ type: 'click' });
  assert.deepEqual(
    calls.filter(([name]) => name === 'openPiCancel').map(([, item]) => item.id),
    ['pi-2026-11-24-1-20261124T110000Z-beef']
  );
  assert.equal(
    all(rows[1], 'button').some((el) => textOf(el) === 'Cancel'),
    false,
    'nothing to cancel once over'
  );
});

function deployModel(changes = {}) {
  return {
    image: image(),
    boards: [
      { thing: A, name: 'CRANIUM01', label: null, fw: { version: '1.20.0+0', confirmed: true }, pi: card() },
      {
        thing: B,
        name: null,
        label: 'Bench',
        fw: { version: '1.19.3+0', confirmed: true },
        pi: card({ card: 'empty', version: null }),
      },
    ],
    chosen: new Set([A]),
    estimates: new Map([
      [
        A,
        {
          thing: A,
          from: '2026.11.10-1',
          fromSource: 'card',
          fromKnown: true,
          blocks: 11,
          changed: 3,
          bytes: 12128,
          imageBytes: 44032,
          runs: 3,
        },
      ],
    ]),
    estimateError: null,
    note: '',
    sending: false,
    error: null,
    close() {},
    signIn() {},
    toggle() {},
    setNote() {},
    submit() {},
    ...changes,
  };
}

test('the deploy dialog offers the boards with a Pi, with what each downloads, and turns away older firmware', () => {
  const box = draw(views.piDeployDialog(deployModel()));
  const words = textOf(box);
  assert.match(words, /Deploy the Pi image 2026\.11\.24-1/);
  assert.match(words, /CRANIUM01 · Card ready, 2026\.11\.10-1, generation 1/);
  assert.match(words, /3 of 11 blocks from 2026\.11\.10-1: 12 KiB, about 1 min at 10 KB\/s/);
  assert.match(words, /Needs firmware 1\.20\.0 or later built with --pi; runs 1\.19\.3\+0/);
  const boxes = all(box, 'input').filter((el) => el.getAttribute('type') === 'checkbox');
  assert.equal(boxes.length, 2);
  assert.ok(all(box, 'button').some((el) => textOf(el) === 'Deploy to 1 board'));

  const waiting = textOf(draw(views.piDeployDialog(deployModel({ estimates: null }))));
  assert.match(waiting, /Working out what it would download/);
  const none = textOf(draw(views.piDeployDialog(deployModel({ boards: [], chosen: new Set() }))));
  assert.match(none, /No board reports a Raspberry Pi/);
});

test('the cancel dialog says what is waiting and at work, and that the cards keep what they wrote', () => {
  const model = {
    deployment: {
      id: 'pi-x-20261124T110000Z-beef',
      version: '2026.11.24-1',
      executions: [row(), row({ thing: B, status: 'QUEUED' })],
    },
    force: false,
    sending: false,
    error: null,
    close() {},
    signIn() {},
    setForce() {},
    submit() {},
  };
  const words = textOf(draw(views.piCancelDialog(model)));
  assert.match(words, /1 board is waiting/);
  assert.match(words, /1 board is downloading/);
  assert.match(words, /Every card keeps what it wrote/);
  assert.match(words, /Withdraw the offer and stop boards at work/);
});

test("a board's Pi: its card, the image on it, and how far an update is", () => {
  assert.equal(textOf(draw(views.piFact(card({ generation: 3 })))), 'Card ready, 2026.11.10-1 (generation 3)');
  assert.equal(textOf(draw(views.piFact(card({ card: 'empty', version: null, generation: 0 })))), 'Card empty');
  assert.match(
    textOf(draw(views.piFact(card({ card: 'updating', version: '2026.11.24-1', done: 4, total: 9 })))),
    /Card updating, 2026\.11\.24-1 \(generation 1\) 4 of 9 blocks written/
  );
});

// --- the words and readers -------------------------------------------------------------------------

test('the header the real tool wrote is read in the browser before anything is sent', () => {
  const bytes = Uint8Array.from(Buffer.from(FIXTURE.new.header, 'hex'));
  assert.deepEqual(core.readPiHeader(bytes), {
    version: '2026.11.24-1+r2',
    blockSize: 4096,
    blocks: 11,
    imageSize: 44032,
    imageOffset: FIXTURE.new.imageOffset,
    packageSize: FIXTURE.new.size,
  });
  assert.throws(() => core.readPiHeader(new Uint8Array(100)), /too short/);
  const wrong = Uint8Array.from(bytes);
  wrong[0] = 0x58;
  assert.throws(() => core.readPiHeader(wrong), /not a Pi image package/);
});

test('which boards take a Pi image, and the words of a card, an estimate and progress', () => {
  assert.equal(core.takesPiImage({ fw: { version: '1.20.0+0' }, pi: card() }), true);
  assert.equal(core.takesPiImage({ fw: { version: '1.19.3+0' }, pi: card() }), false);
  assert.equal(core.takesPiImage({ fw: { version: '1.20.0+0' } }), false);
  assert.equal(
    core.piCardWords(card({ card: 'updating', done: 2, total: 5 })),
    'Card updating, 2026.11.10-1, generation 1, 2 of 5 blocks'
  );

  const estimate = { from: null, fromKnown: true, blocks: 65536, changed: 65536, bytes: 4 * 1024 ** 3 + 2 * 1024 ** 2 };
  assert.match(
    core.piEstimateWords(estimate),
    /^65,536 of 65536 blocks from an empty card: 4098\.00 MiB, about 5 days at 10 KB\/s$/
  );
  assert.equal(core.piEstimateWords({ ...estimate, changed: 0, bytes: 0 }), 'Already holds it: nothing to download');
  assert.match(
    core.piEstimateWords({ ...estimate, from: 'hand-1', fromKnown: false }),
    /never stored: every block at most/
  );

  assert.equal(core.piProgressWords(row({ status: 'QUEUED' })), 'Waiting for the board');
  assert.equal(core.piProgressWords(row({ step: 'compare', total: null })), 'Finding the changed blocks');
  assert.equal(core.piProgressWords(row({ status: 'SUCCEEDED', fetched: 0 })), 'Done: its card already held it');
  assert.equal(
    core.piProgressWords(row({ status: 'FAILED', step: 'blocks', reason: 'digest_mismatch' })),
    'Failed while downloading changed blocks: a block came wrong three times running'
  );
  assert.equal(
    core.piProgressWords(row({ status: 'REJECTED', step: null, reason: 'unsupported' })),
    'Failed: its firmware takes no Pi image'
  );
  assert.match(core.piProgressWords(row({ status: 'TIMED_OUT' })), /goes on from where it stopped/);

  assert.deepEqual(
    core.readPiCard({ card: 'ready', version: '2026.11.24-1', generation: 2, step: 'idle', done: 0, total: 0 }),
    {
      card: 'ready',
      version: '2026.11.24-1',
      generation: 2,
      step: 'idle',
      done: 0,
      total: 0,
    }
  );
  assert.equal(core.readPiCard({ card: '<b>' }), null);
  assert.equal(core.readPiCard({ card: 'ready', version: '../x' }).version, null);
});

test('the activity log tells the Pi images in words, under Firmware and Deployments', () => {
  assert.ok(core.activityActions('firmware').includes('firmware.pi_upload'));
  assert.ok(core.activityActions('firmware').includes('firmware.pi_verify'));
  assert.ok(core.activityActions('deployments').includes('deployment.pi_create'));
  assert.ok(core.activityActions('deployments').includes('deployment.pi_cancel'));
  for (const action of ['firmware.pi_upload', 'firmware.pi_verify', 'deployment.pi_create', 'deployment.pi_cancel']) {
    assert.ok(core.CHANGE_ACTIONS.includes(action), action);
  }
  for (const code of [
    'bad_manifest',
    'pi_too_large',
    'unknown_pi_image',
    'pi_not_uploaded',
    'pi_package_mismatch',
    'pi_image_refused',
    'pi_unsupported',
  ]) {
    assert.equal(typeof core.REFUSAL_WORDS[code], 'string', code);
  }
});

// --- the client ------------------------------------------------------------------------------------

/** A stand-in for the browser's XMLHttpRequest, answering each PUT with `status`. */
function fakeXhr(status, sent) {
  return class {
    constructor() {
      this.upload = {};
      this.headers = {};
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    send(body) {
      sent.push({ method: this.method, url: this.url, headers: this.headers, body });
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
      this.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 2 });
      this.status = status;
      queueMicrotask(() => this.onload());
    }
  };
}

function client(replies, { status = 200, sent = [] } = {}) {
  const calls = [];
  const api = core.createApi({
    auth: { accessToken: () => 'T' },
    crypto: globalThis.crypto,
    clock: core.createClock(),
    onUnauthorized() {},
    pause: async () => {},
    XMLHttpRequest: fakeXhr(status, sent),
    fetch: async (path, options) => {
      calls.push([options.method, path, options.body]);
      return new Response(JSON.stringify(replies.shift()), { status: 200 });
    },
  });
  return { api, calls };
}

test('the client describes a package by its header, sends it to S3 with progress, and checks it', async () => {
  const header = Uint8Array.from(Buffer.from(FIXTURE.new.header, 'hex'));
  const upload = {
    url: 'https://bucket.s3.example/firmware/pi-x.cpd?X-Amz-Signature=1',
    headers: { 'if-none-match': '*' },
    size: 48128,
  };
  const sent = [];
  const { api, calls } = client(
    [
      { image: { ...image(), status: 'uploading' }, upload },
      { image: image({ version: '2026.11.24-1+r2' }) },
      {
        version: '2026.11.24-1+r2',
        boards: [
          {
            thing: A,
            from: '2026.11.10-1',
            fromSource: 'card',
            fromKnown: true,
            blocks: 11,
            changed: 3,
            bytes: 12128,
            imageBytes: 44032,
            runs: 3,
          },
        ],
      },
      {
        deployment: {
          id: 'pi-2026-11-24-1-r2-20261124T120000Z-beef',
          version: '2026.11.24-1+r2',
          things: [A],
          counts: {},
          executions: [],
        },
      },
      {
        deployment: {
          id: 'pi-2026-11-24-1-r2-20261124T120000Z-beef',
          version: '2026.11.24-1+r2',
          status: 'CANCELED',
          things: [A],
          counts: {},
          executions: [],
        },
      },
    ],
    { sent }
  );
  const described = await api.describePiImage({ header, notes: 'Mixxx' });
  assert.deepEqual(calls[0], [
    'POST',
    '/api/pi-images',
    JSON.stringify({ header: FIXTURE.new.header, notes: 'Mixxx' }),
  ]);
  assert.equal(described.upload.url, upload.url);
  assert.deepEqual(described.upload.headers, { 'if-none-match': '*' });

  const progress = [];
  const file = { size: 48128 };
  await api.sendPiPackage(described.upload, file, (part) => progress.push(part));
  assert.deepEqual(progress, [0.5, 1]);
  assert.equal(sent[0].method, 'PUT');
  assert.equal(sent[0].url, upload.url);
  assert.deepEqual(sent[0].headers, { 'if-none-match': '*', 'content-type': 'application/octet-stream' });
  assert.equal(sent[0].body, file);
  // No token goes to S3: the URL is the permission.
  assert.equal(sent[0].headers.authorization, undefined);

  const checked = await api.verifyPiImage('2026.11.24-1+r2');
  assert.deepEqual(calls[1].slice(0, 2), ['POST', '/api/pi-images/2026.11.24-1%2Br2/verify']);
  assert.equal(checked.status, 'active');

  const estimates = await api.piEstimate('2026.11.24-1+r2');
  assert.deepEqual(calls[2].slice(0, 2), ['GET', '/api/pi-images/2026.11.24-1%2Br2/estimate']);
  assert.equal(estimates[0].changed, 3);

  const started = await api.deployPiImage({ version: '2026.11.24-1+r2', things: [A], note: '' });
  assert.deepEqual(calls[3], [
    'POST',
    '/api/pi-images/2026.11.24-1%2Br2/deploy',
    JSON.stringify({ things: [A], note: '' }),
  ]);
  assert.equal(started.id, 'pi-2026-11-24-1-r2-20261124T120000Z-beef');

  const cancelled = await api.cancelPiDeployment(started.id, true);
  assert.deepEqual(calls[4], ['POST', `/api/pi-deployments/${started.id}/cancel`, JSON.stringify({ force: true })]);
  assert.equal(cancelled.status, 'CANCELED');
});

test('a package that is in S3 already is no error, and one S3 refuses is', async () => {
  const upload = { url: 'https://bucket.s3.example/k', headers: {}, size: 1 };
  assert.deepEqual(await client([], { status: 412 }).api.sendPiPackage(upload, { size: 1 }), { already: true });
  await assert.rejects(client([], { status: 403 }).api.sendPiPackage(upload, { size: 1 }), /may have expired/);
  await assert.rejects(client([], { status: 500 }).api.sendPiPackage(upload, { size: 1 }), /S3 answered 500/);
});

test('the client reads only what the contract allows of the Pi images and their deployments', async () => {
  const { api } = client([
    {
      images: [image(), { version: '<script>' }, image({ status: 'weird' })],
      deployments: [
        {
          id: 'pi-2026-11-24-1-20261124T110000Z-beef',
          version: '2026.11.24-1',
          things: [A, 'nope'],
          counts: { inProgress: 1 },
          executions: [row(), { thing: 'x', status: 'IN_PROGRESS' }],
        },
        { id: 'cranium-1-2-3-b4-20261124T110000Z-beef' },
      ],
      firstFirmware: '1.20.0',
      maxPackageSize: 5 * 1024 ** 3,
    },
  ]);
  const listed = await api.piImages();
  assert.equal(listed.images.length, 2);
  assert.equal(listed.images[1].status, 'refused', 'a status it does not know is no active image');
  assert.equal(listed.deployments.length, 1);
  assert.deepEqual(listed.deployments[0].things, [A]);
  assert.equal(listed.deployments[0].executions.length, 1);
  assert.equal(core.piUnderWay(listed.deployments[0]), true);
  assert.equal(listed.maxPackageSize, 5 * 1024 ** 3);
});
