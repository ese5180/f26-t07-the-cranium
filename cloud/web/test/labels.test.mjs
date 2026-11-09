/**
 * A board's QR code and label (labels.js): the link it holds, the encoder's output against known vectors,
 * the sticker and its print, the label after Board setup's Online step (setup.js), and the button on a
 * board's page (views.js).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { LABELS, QR, SETUP, VIEWS, all, click, controls, createDocument, one, textOf } from './page.mjs';

const labels = await import(LABELS);
const setup = await import(SETUP);
const views = await import(VIEWS);
const { QrCode } = await import(QR);

globalThis.document = createDocument();

const ORIGIN = 'https://console.example.test';
const THING = 'cranium-fe5b26c0c5b1dcd7';

const rows = (qr) => {
  const lines = [];
  for (let y = 0; y < qr.size; y += 1) {
    let row = '';
    for (let x = 0; x < qr.size; x += 1) row += qr.getModule(x, y) ? '1' : '0';
    lines.push(row);
  }
  return lines.join('\n');
};
const digest = (qr) => createHash('sha256').update(rows(qr)).digest('hex');

/** The error correction level and mask of a symbol, read back from its format bits beside the top left finder. */
function format(qr) {
  let bits = 0;
  for (let i = 0; i <= 5; i += 1) bits |= (qr.getModule(8, i) ? 1 : 0) << i;
  bits |= (qr.getModule(8, 7) ? 1 : 0) << 6;
  bits |= (qr.getModule(8, 8) ? 1 : 0) << 7;
  bits |= (qr.getModule(7, 8) ? 1 : 0) << 8;
  for (let i = 9; i < 15; i += 1) bits |= (qr.getModule(14 - i, 8) ? 1 : 0) << i;
  const data = (bits ^ 0x5412) >>> 10;
  // ISO/IEC 18004 table 12: L 01, M 00, Q 11, H 10.
  return { level: ['M', 'L', 'H', 'Q'][data >>> 3], mask: data & 7 };
}

test('the link is the board page on the console’s own origin, and nothing else makes one', () => {
  assert.equal(labels.boardLink(ORIGIN, THING), `${ORIGIN}/#/devices/${THING}`);
  assert.equal(labels.boardLink(`${ORIGIN}/`, THING), `${ORIGIN}/#/devices/${THING}`);
  assert.equal(labels.boardLink('http://127.0.0.1:8080', 'b1'), 'http://127.0.0.1:8080/#/devices/b1');
  for (const origin of [
    'http://console.example.test',
    'cranium-app://bundle',
    'https://user@console.example.test',
    'https://console.example.test/admin',
    'https://console.example.test/?x=1',
    '',
    null,
  ]) {
    assert.equal(labels.boardLink(origin, THING), null, String(origin));
  }
  for (const thing of ['', 'a/b', 'a b', 'x'.repeat(129), '%2F', null]) {
    assert.equal(labels.boardLink(ORIGIN, thing), null, String(thing));
  }
});

test('a scanned link opens only a board page of this console', () => {
  assert.equal(labels.readBoardLink(`${ORIGIN}/#/devices/${THING}`, ORIGIN), THING);
  assert.equal(labels.readBoardLink(`${ORIGIN}#/devices/${THING}`, ORIGIN), THING);
  assert.equal(labels.readBoardLink(`HTTPS://CONSOLE.example.test/#/devices/${THING}`, ORIGIN), THING);
  for (const text of [
    `https://evil.example.test/#/devices/${THING}`,
    `https://console.example.test.evil.test/#/devices/${THING}`,
    `https://console.example.test:444/#/devices/${THING}`,
    `http://console.example.test/#/devices/${THING}`,
    `https://user:pw@console.example.test/#/devices/${THING}`,
    `${ORIGIN}/admin#/devices/${THING}`,
    `${ORIGIN}/?next=x#/devices/${THING}`,
    `${ORIGIN}/#/devices/${THING}/more`,
    `${ORIGIN}/#/devices/`,
    `${ORIGIN}/#/deployments/${THING}`,
    `${ORIGIN}/#/devices/a%2Fb`,
    'not a link',
  ]) {
    assert.equal(labels.readBoardLink(text, ORIGIN), null, text);
  }
});

test('the encoder against known vectors: byte mode at M, the C version’s modules, version 10 at most', () => {
  // The C version of the same commit of the library makes this symbol of "Hello, world!" at M (apps.test.mjs).
  const hello = labels.encode('Hello, world!');
  assert.equal(hello.size, 21);
  assert.equal(digest(hello), '60e12c4292e429687bcfde01ea5bbfeb22f28963c13cac92d48e3cbfe60cb21a');
  assert.deepEqual(format(hello).level, 'M');

  // Two boards' links, and the longest thing name there is: symbols that macOS's own QR reader (CoreImage's
  // CIDetector) decoded back to these very texts when they were taken down.
  for (const [text, version, mask, sha] of [
    [`${ORIGIN}/#/devices/${THING}`, 5, 2, '6c638566733fd91c81d074c3f11a2d03031aeab8af0bcd2315aa3c7be04295a6'],
    [
      `${ORIGIN}/#/devices/${'x'.repeat(128)}`,
      9,
      0,
      'f938909f1c6441b57aff05bd9d33855b94a81ad5dcbf1f14cf8f29104b91c61c',
    ],
  ]) {
    const qr = labels.encode(text);
    assert.equal(qr.version, version, text);
    assert.equal(qr.size, 17 + 4 * version);
    assert.deepEqual(format(qr), { level: 'M', mask });
    assert.equal(digest(qr), sha, text);
  }

  // Byte mode at M is never raised to Q, even where Q would fit the same version, as encodeText would.
  assert.equal(format(labels.encode('a'.repeat(44))).level, 'M');
  assert.equal(format(QrCode.encodeText('a'.repeat(44), QrCode.Ecc.MEDIUM)).level, 'Q');

  // Version 10 at M holds 213 bytes in byte mode, and no more.
  assert.equal(labels.encode('a'.repeat(213)).version, 10);
  assert.throws(() => labels.encode('a'.repeat(214)), /too long/i);
  // UTF-8 bytes, not characters.
  assert.equal(labels.encode('é'.repeat(106)).version, 10);
  assert.throws(() => labels.encode('é'.repeat(107)), /too long/i);
});

test('the path draws exactly the dark modules, inside a quiet zone of four', () => {
  const qr = labels.encode(`${ORIGIN}/#/devices/${THING}`);
  const drawn = new Set();
  for (const [, x, y, run] of labels.qrPath(qr).matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    for (let step = 0; step < Number(run); step += 1) drawn.add(`${Number(x) + step - 4},${Number(y) - 4}`);
  }
  let dark = 0;
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.getModule(x, y)) dark += 1;
      assert.equal(drawn.has(`${x},${y}`), qr.getModule(x, y), `${x},${y}`);
    }
  }
  assert.equal(drawn.size, dark);
});

test('a label has the code, the name and the thing name; a sticker prints alone at 62 x 29 mm', () => {
  const label = labels.labelOf({ thing: THING, name: 'CRLAB01' }, ORIGIN);
  assert.equal(label.link, `${ORIGIN}/#/devices/${THING}`);
  assert.equal(label.name, 'CRLAB01');
  assert.equal(label.code.size, 37 + 8);
  assert.equal(labels.labelOf({ thing: THING }, ORIGIN).name, null);
  assert.equal(labels.labelOf({ thing: THING }, 'cranium-app://bundle'), null);

  const box = document.createElement('div');
  views.render(box, labels.labelPanel([label]));
  const sticker = one(box, 'figure.board-label');
  assert.equal(textOf(one(sticker, 'strong.board-label-name')), 'CRLAB01');
  assert.equal(textOf(one(sticker, 'span.board-label-thing')), THING);
  const svg = one(sticker, 'svg.qr-code');
  assert.equal(svg.getAttribute('viewBox'), '0 0 45 45');
  assert.equal(one(svg, 'path.qr-ink').getAttribute('d'), label.code.path);
  assert.match(textOf(box), new RegExp(`The code opens ${ORIGIN}/#/devices/${THING} on this console`));
  assert.deepEqual(controls(box), ['Print label', 'Print on paper']);

  // Printing: the classes that hide the rest of the console, gone once the dialog closes.
  const classes = new Set();
  const listeners = new Map();
  let printed = 0;
  const win = {
    document: { body: { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } } },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
    print: () => {
      printed += 1;
      assert.deepEqual([...classes].sort(), ['is-label-sticker', 'is-printing-labels']);
    },
  };
  assert.equal(labels.printLabels('sticker', win), true);
  assert.equal(printed, 1);
  listeners.get('afterprint')();
  assert.deepEqual([...classes], []);
  labels.printLabels('paper', { ...win, print: () => assert.ok(classes.has('is-label-paper')) });

  // Several boards: one sticker each, printed as labels or as a sheet on paper.
  const box2 = document.createElement('div');
  views.render(box2, labels.labelPanel([label, labels.labelOf({ thing: 'b2' }, ORIGIN)]));
  assert.equal(all(box2, 'figure.board-label').length, 2);
  assert.deepEqual(controls(box2), ['Print labels', 'Print on paper']);

  // The stylesheet's sticker is the size the script says.
  const css = readFileSync(new URL('../src/site/assets/app.css', import.meta.url), 'utf8');
  assert.match(css, /@page board-label \{\s*size: 62mm 29mm;/);
  assert.match(css, /\.board-label \{[^}]*width: 62mm;[^}]*height: 29mm;/);
  assert.deepEqual(labels.LABEL_MM, { width: 62, height: 29 });
  assert.match(css, /body\.is-label-sticker \.board-label \{\s*page: board-label;/);
});

test('Board setup shows the board’s QR code and label once the console sees it online', () => {
  const steps = Object.fromEntries(
    ['connect', 'golden', 'firmware', 'setup', 'online'].map((key) => [key, { status: 'done', note: null }])
  );
  const flow = { steps, online: { thing: THING, name: 'CRLAB01' } };
  const ctx = { state: { origin: ORIGIN } };
  const box = document.createElement('div');
  views.render(box, setup.onlineLabel(flow, ctx));
  assert.equal(textOf(one(box, 'h2')), 'Its QR code and label');
  assert.equal(textOf(one(box, 'span.board-label-thing')), THING);
  assert.equal(textOf(one(box, 'strong.board-label-name')), 'CRLAB01');
  assert.equal(
    one(box, 'path.qr-ink').getAttribute('d'),
    labels.labelOf({ thing: THING, name: 'CRLAB01' }, ORIGIN).code.path
  );
  // Not before the Online step is done, and never with an origin that is not a console's.
  assert.equal(setup.onlineLabel({ steps: { ...steps, online: { status: 'running' } }, online: null }, ctx), null);
  assert.equal(setup.onlineLabel({ steps: { ...steps, online: { status: 'skipped' } }, online: null }, ctx), null);
  assert.equal(setup.onlineLabel(flow, { state: { origin: 'cranium-app://bundle' } }), null);
});

test('a board’s page has Show QR / Print label, and shows the label while it is asked for', () => {
  const device = { thing: THING, name: 'CRLAB01', online: true };
  const toggled = [];
  const state = {
    route: { view: 'device', thing: THING },
    origin: ORIGIN,
    now: Date.now(),
    me: { canWrite: false },
    devices: { value: { devices: [device] }, error: null, loadedAt: Date.now() },
    deviceDetails: new Map([
      [
        THING,
        {
          value: { device, certificates: [], executions: [], olderExecutions: false, memfault: null },
          error: null,
          loadedAt: Date.now(),
        },
      ],
    ]),
    firmware: { value: [], error: null, loadedAt: Date.now() },
    deployments: { value: [], error: null, loadedAt: Date.now() },
    deploymentDetails: new Map(),
    boardUpdates: new Map(),
    commands: new Map(),
    positions: new Map(),
    labelShown: null,
  };
  const ctx = { state, actions: { toggleLabel: (thing) => toggled.push(thing) }, labels };
  const box = document.createElement('div');
  views.render(box, views.deviceView(ctx));
  const showing = one(box, 'button', 'Show QR / Print label');
  assert.equal(showing.getAttribute('aria-expanded'), 'false');
  assert.equal(all(box, 'figure.board-label').length, 0);
  click(showing);
  assert.deepEqual(toggled, [THING]);

  state.labelShown = THING;
  views.render(box, views.deviceView(ctx));
  assert.equal(one(box, 'button', 'Hide QR').getAttribute('aria-expanded'), 'true');
  assert.equal(textOf(one(box, 'span.board-label-thing')), THING);
  click(one(one(box, 'section.label-panel'), 'button', 'Hide'));
  assert.deepEqual(toggled, [THING, THING]);

  // Another board's label is not this page's.
  state.labelShown = 'cranium-0000000000000000';
  views.render(box, views.deviceView(ctx));
  assert.equal(all(box, 'figure.board-label').length, 0);
});
