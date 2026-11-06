// Tests for the pages' side of live updates (assets/live.js, docs/live.md): when the WebSocket is open, what
// it is opened with, what a message makes the page do, and how it comes back after a loss. A WebSocket and
// timers stand in for the browser's.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scriptAddress } from './page.mjs';

const { GATHER_MS, LIVE_PROTOCOL, PING_MS, RETRY_MS, createLive, readChange, readLiveUrl } = await import(
  scriptAddress('live.js')
);

const URL = 'wss://abc123def4.execute-api.us-east-1.amazonaws.com/live';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
const OTHER_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ5In0.c2lnbmF0dXJl';
const A = 'cranium-0123456789abcdef';

function world({ token = TOKEN } = {}) {
  const sockets = [];
  class FakeSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.sent = [];
      this.closedWith = null;
      sockets.push(this);
    }
    send(text) {
      this.sent.push(text);
    }
    close(code) {
      this.closedWith = code;
    }
    // The server's side.
    accept() {
      this.onopen?.({});
    }
    say(data) {
      this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
    drop() {
      this.onclose?.({ code: 1006 });
    }
  }
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(run, ms) {
      const id = nextId++;
      pending.set(id, { run, at: now + ms, every: 0 });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    setInterval(run, ms) {
      const id = nextId++;
      pending.set(id, { run, at: now + ms, every: ms });
      return id;
    },
    clearInterval(id) {
      pending.delete(id);
    },
  };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.every) timer.at += timer.every;
      else pending.delete(id);
      timer.run();
    }
    now = end;
  };
  const state = { token, visible: true };
  const changes = [];
  const statuses = [];
  const live = createLive({
    url: URL,
    accessToken: () => state.token,
    onChange: (change) => changes.push(change),
    onStatus: (status) => statuses.push(status),
    WebSocket: FakeSocket,
    timers,
    random: () => 0,
    visible: () => state.visible,
  });
  return { live, sockets, changes, statuses, state, advance, pending };
}

test('the address is a WebSocket address of a host and a stage, and a message is read for what it may say', () => {
  assert.equal(readLiveUrl(URL), URL);
  assert.equal(readLiveUrl('ws://127.0.0.1:8788/live'), 'ws://127.0.0.1:8788/live');
  for (const value of [
    'https://example.org/live',
    'wss://example.org',
    'wss://example.org/live?token=x',
    'wss://Ex ample/live',
    null,
    42,
  ]) {
    assert.equal(readLiveUrl(value), null, String(value));
  }
  assert.deepEqual(
    readChange(
      JSON.stringify({
        type: 'changed',
        things: [A, 'nope'],
        boards: ['0a1b2c3d4e5f6071', 'X'],
        what: ['board', 'Not A Kind'],
      })
    ),
    {
      things: [A],
      boards: ['0a1b2c3d4e5f6071'],
      what: ['board'],
    }
  );
  for (const data of [
    '',
    'not json',
    '{"type":"other"}',
    'null',
    JSON.stringify({ type: 'changed', things: 'x'.repeat(5000) }),
  ]) {
    const read = readChange(data);
    assert.ok(read === null || (read.things.length === 0 && read.what.length === 0), data.slice(0, 30));
  }
});

test('it connects with the token in the subprotocols, never in the address, and pings every five minutes', () => {
  const w = world();
  w.live.start();
  assert.equal(w.sockets.length, 1);
  assert.equal(w.sockets[0].url, URL);
  assert.deepEqual(w.sockets[0].protocols, [LIVE_PROTOCOL, TOKEN]);
  assert.equal(w.live.status(), 'connecting');
  w.sockets[0].accept();
  assert.equal(w.live.status(), 'live');
  assert.equal(w.live.isLive(), true);
  w.advance(PING_MS * 2);
  assert.deepEqual(w.sockets[0].sent, ['{"action":"ping"}', '{"action":"ping"}']);
  // Asked again with nothing changed, it keeps the one it has.
  w.live.sync();
  assert.equal(w.sockets.length, 1);
});

test('changes close together are told once, 300 ms after the first, and an empty message is no change', () => {
  const w = world();
  w.live.start();
  w.sockets[0].accept();
  w.sockets[0].say({ type: 'changed', things: [A], what: ['board'], at: 'x' });
  w.sockets[0].say({ type: 'changed', things: [], what: ['releases'], at: 'x' });
  w.sockets[0].say({ type: 'changed', things: [], what: [], at: 'x' });
  w.sockets[0].say('garbage');
  assert.deepEqual(w.changes, []);
  w.advance(GATHER_MS);
  assert.deepEqual(w.changes, [{ things: [A], boards: [], what: ['board', 'releases'], resync: false }]);
  w.sockets[0].say({ type: 'changed', boards: ['0a1b2c3d4e5f6071'], what: ['board'], at: 'x' });
  w.advance(GATHER_MS);
  assert.deepEqual(w.changes[1], { things: [], boards: ['0a1b2c3d4e5f6071'], what: ['board'], resync: false });
});

test('a lost connection is made again after a growing wait, and then the page reads everything once', () => {
  const w = world();
  w.live.start();
  w.sockets[0].accept();
  w.sockets[0].drop();
  assert.equal(w.live.status(), 'waiting');
  w.advance(RETRY_MS[0] - 1);
  assert.equal(w.sockets.length, 1);
  w.advance(1);
  assert.equal(w.sockets.length, 2);
  // Refused this time (no open), then again: the waits grow.
  w.sockets[1].drop();
  w.advance(RETRY_MS[1]);
  assert.equal(w.sockets.length, 3);
  w.sockets[2].accept();
  w.advance(GATHER_MS);
  assert.deepEqual(w.changes, [{ things: [], boards: [], what: [], resync: true }]);
  // Open again: the next loss starts from the first wait.
  w.sockets[2].drop();
  w.advance(RETRY_MS[0]);
  assert.equal(w.sockets.length, 4);
  // A connection that is never accepted is tried at most every minute.
  for (let i = 0; i < 10; i += 1) {
    const before = w.sockets.length;
    w.sockets.at(-1).drop();
    w.advance(RETRY_MS.at(-1));
    assert.equal(w.sockets.length, before + 1);
  }
});

test('no WebSocket while signed out or hidden; a new token makes a new connection', () => {
  const w = world({ token: null });
  w.live.start();
  assert.equal(w.sockets.length, 0);
  assert.equal(w.live.status(), 'off');
  w.state.token = TOKEN;
  w.live.sync();
  assert.equal(w.sockets.length, 1);
  w.sockets[0].accept();
  // Hidden: closed, and nothing is tried again until it is in view.
  w.state.visible = false;
  w.live.sync();
  assert.equal(w.sockets[0].closedWith, 1000);
  assert.equal(w.live.status(), 'off');
  w.advance(10 * 60_000);
  assert.equal(w.sockets.length, 1);
  w.state.visible = true;
  w.live.sync();
  assert.equal(w.sockets.length, 2);
  w.sockets[1].accept();
  w.advance(GATHER_MS);
  assert.deepEqual(w.changes, [], 'a page that comes back into view reads everything by itself');
  // The page renewed its token: the connection is made again with the new one.
  w.state.token = OTHER_TOKEN;
  w.live.sync();
  assert.equal(w.sockets[1].closedWith, 1000);
  assert.deepEqual(w.sockets[2].protocols, [LIVE_PROTOCOL, OTHER_TOKEN]);
  // Signed out: closed, and a close afterwards is not a loss to come back from.
  w.state.token = null;
  w.live.sync();
  assert.equal(w.sockets[2].closedWith, 1000);
  w.sockets[2].drop();
  w.advance(RETRY_MS.at(-1));
  assert.equal(w.sockets.length, 3);
  w.live.stop();
  assert.equal(w.pending.size, 0, 'no timer is left');
});

test('without an address, or a WebSocket, it never connects', () => {
  const none = createLive({ url: null, accessToken: () => TOKEN, onChange: () => {}, WebSocket: class {} });
  none.start();
  assert.equal(none.status(), 'off');
  const noSocket = createLive({ url: URL, accessToken: () => TOKEN, onChange: () => {}, WebSocket: null });
  noSocket.start();
  assert.equal(noSocket.status(), 'off');
});
