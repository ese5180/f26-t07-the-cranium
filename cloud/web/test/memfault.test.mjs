/**
 * Tests for Memfault on the website (docs/memfault.md): what the client keeps of the server's word on a board
 * (core.js), the Memfault card on a board's page and its link, and Send Memfault data now in the board's menu
 * (views.js). The scripts are the very files the browser loads, drawing into the stand-in document of page.mjs.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE, VIEWS, all, click, createDocument, one, textOf } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
globalThis.document = createDocument();

const NOW = Date.parse('2026-11-04T12:00:00Z');
const A = 'cranium-00000000000000aa';
const LINK = `https://app.memfault.com/organizations/cranium-team/projects/cranium-boards/devices/${A}`;
const NONE = Object.freeze({ status: 'none', at: null, apCount: null, checkedAt: null, bluetoothOnly: false });

function board(changes = {}) {
  return {
    thing: A,
    name: 'CRVIHAAN01',
    online: true,
    lastSeen: new Date(NOW - 20_000).toISOString(),
    fw: { version: '1.14.0+0', confirmed: true },
    ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' },
    rssi: -52,
    uptime: 3600,
    stuck: null,
    diag: null,
    diary: null,
    bt: null,
    position: null,
    location: NONE,
    ...changes,
  };
}

const loaded = (value) => ({ value, error: null, loadedAt: NOW, loading: false });

function page(memfault, { device = board(), canWrite = true } = {}) {
  const pressed = [];
  const state = {
    now: NOW,
    route: { view: 'device', thing: A },
    me: { canWrite, email: 'manager@example.invalid', sub: 'sub-1' },
    sessionLeft: 1800,
    interval: 0,
    devices: loaded({ devices: [device] }),
    deviceDetails: new Map(),
    positions: new Map(),
    commands: new Map(),
    deployments: loaded([]),
    firmware: loaded(null),
    alerts: { ...loaded(null), busy: false },
  };
  state.deviceDetails.set(A, loaded({ device, certificates: [], executions: [], olderExecutions: 0, memfault }));
  const actions = new Proxy(
    {},
    {
      get:
        (target, name) =>
        (...args) =>
          pressed.push([name, ...args.filter((arg) => arg === null || typeof arg !== 'object')]),
    }
  );
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  views.render(root, views.deviceView({ state, actions }));
  return { root, pressed };
}

const memfaultCard = (root) => all(root, 'section.card').find((card) => textOf(card).startsWith('Memfault')) ?? null;

test("the client keeps what the server says of Memfault, and only a link to Memfault's own pages", async () => {
  const detail = async (memfault) => {
    const api = core.createApi({
      auth: { accessToken: () => 'TOKEN' },
      crypto: globalThis.crypto,
      clock: core.createClock(),
      onUnauthorized: () => {},
      pause: async () => {},
      fetch: async () =>
        Response.json({ device: { thing: A }, certificates: [], executions: [], olderExecutions: 0, memfault }),
    });
    return (await api.device(A)).memfault;
  };
  assert.deepEqual(await detail({ keyStored: true, firmware: true, url: LINK }), {
    keyStored: true,
    firmware: true,
    url: LINK,
  });
  assert.deepEqual(await detail({ keyStored: 'yes', firmware: 1, url: null }), {
    keyStored: false,
    firmware: false,
    url: null,
  });
  for (const url of [
    'https://evil.example/organizations/a/projects/b/devices/x',
    'javascript:alert(1)',
    `http://app.memfault.com/organizations/a/projects/b/devices/${A}`,
    `${LINK}/../../x`,
  ]) {
    assert.equal((await detail({ keyStored: true, firmware: true, url })).url, null, url);
  }
  // A server from before Memfault says nothing of it.
  assert.equal(await detail(undefined), null);
});

test("a board's page says whether forwarding is on, and why not", () => {
  const said = (memfault, options) => textOf(memfaultCard(page(memfault, options).root));
  assert.match(said({ keyStored: true, firmware: true, url: null }), /Memfault: forwarding on\./);
  assert.match(
    said({ keyStored: false, firmware: true, url: null }),
    /Memfault: not connected\. The board keeps its data until Memfault is connected\. Details No project key is stored in AWS/
  );
  // No key says so first: it is the same for every board.
  assert.match(said({ keyStored: false, firmware: false, url: null }), /No project key is stored/);
  assert.match(said({ keyStored: true, firmware: false, url: null }), /Memfault: needs firmware 1\.14\.0\./);
  // Nothing from a server that says nothing of it, and nothing for a board that never reaches AWS IoT.
  assert.equal(memfaultCard(page(null).root), null);
  assert.equal(
    memfaultCard(
      page(
        { keyStored: true, firmware: true, url: null },
        { device: board({ location: { ...NONE, bluetoothOnly: true } }) }
      ).root
    ),
    null
  );
});

test('the link to the board in Memfault is there when the server gives one, and opens apart from the console', () => {
  const card = memfaultCard(page({ keyStored: true, firmware: true, url: LINK }).root);
  const link = one(card, 'a', 'Open in Memfault');
  assert.equal(link.getAttribute('href'), LINK);
  assert.equal(link.getAttribute('rel'), 'noreferrer');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(all(memfaultCard(page({ keyStored: true, firmware: true, url: null }).root), 'a').length, 0);
});

test("Send Memfault data now is in the board's menu, beside Report now, for release managers", () => {
  const { root, pressed } = page({ keyStored: true, firmware: true, url: null });
  const menu = one(root, 'details.menu');
  const items = all(menu, 'button.menu-item').map((item) => textOf(item));
  assert.equal(items.length, 2);
  assert.ok(items[0].startsWith('Report now'), items[0]);
  assert.ok(items[1].startsWith('Send Memfault data now'), items[1]);
  click(one(menu, 'button.menu-item', 'Send Memfault data now'));
  assert.deepEqual(pressed, [['memfaultNow', A]]);
  // An offline board would miss it.
  const offline = page({ keyStored: true, firmware: true, url: null }, { device: board({ online: false }) });
  assert.equal(one(one(offline.root, 'details.menu'), 'button.menu-item', 'Send Memfault data now').disabled, true);
  // Viewers have no menu at all.
  assert.equal(
    all(page({ keyStored: true, firmware: true, url: null }, { canWrite: false }).root, 'details.menu').length,
    0
  );
});

test('the command and what the activity log says of it', () => {
  assert.deepEqual(core.COMMANDS, ['identify', 'report', 'memfault']);
  assert.equal(core.COMMAND_WORDS.memfault, 'asked {} to send its Memfault data now');
});
