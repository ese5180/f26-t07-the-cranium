/**
 * Live updates (docs/live.md), for the console's page and the customer site's alike.
 *
 * While the page is signed in and in view, it keeps a WebSocket to the live API, opened with the
 * subprotocols "cranium-live" and its access token: the token goes in the Sec-WebSocket-Protocol
 * header, never in the address. When something the page may see changes, the live function sends a
 * short message, { type: "changed", things or boards, what, at }, with no data of a board (the console
 * hears thing names, a customer the refs the customer site knows its boards by), and the page reads
 * again what it shows, through the API, as on any refresh. Changes that come close together are told
 * once, 300 ms after the first. The page's own polling goes on as before: live updates only make it
 * sooner, and a page whose WebSocket is down simply polls.
 *
 * The WebSocket is closed while the page is hidden, and opened again when it comes back (the page reads
 * everything then by itself); also after it was lost, with a growing wait and some jitter and then a
 * refresh, as what changed meanwhile was not told; and when the access token changes
 * (the live function closes a connection whose token has expired). A ping every 5 minutes keeps API
 * Gateway's 10-minute idle limit away.
 *
 * No dependencies; the WebSocket, the timers and the clock are passed in, for the tests.
 */

export const LIVE_PROTOCOL = 'cranium-live';
export const PING_MS = 5 * 60_000;
export const GATHER_MS = 300;
// The waits before connecting again after a connection was lost, the last one repeated.
export const RETRY_MS = Object.freeze([1000, 2000, 5000, 15_000, 30_000, 60_000]);
const PING = '{"action":"ping"}';
const MAX_MESSAGE = 4096;
const URL_SHAPE = /^wss?:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?\/[A-Za-z0-9_-]{1,128}$/;
// What a subprotocol may hold, which a token is: the live function checks the rest.
const TOKEN_SHAPE = /^[A-Za-z0-9._-]{1,8192}$/;
const WHAT = /^[a-z]{1,20}$/;
const THING = /^cranium-[0-9a-f]{16}$/;
const REF = /^[0-9a-f]{16}$/;

/** The live API's address from a page's settings, or null when there is none or it is not one. */
export function readLiveUrl(value) {
  return typeof value === 'string' && URL_SHAPE.test(value) ? value : null;
}

/** A message from the live function, or null for anything else. */
export function readChange(data) {
  if (typeof data !== 'string' || data.length > MAX_MESSAGE) return null;
  let value;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || value.type !== 'changed') return null;
  const list = (items, shape) =>
    Array.isArray(items) ? items.filter((item) => typeof item === 'string' && shape.test(item)) : [];
  return { things: list(value.things, THING), boards: list(value.boards, REF), what: list(value.what, WHAT) };
}

/**
 * @param {object} options
 * @param {string|null} options.url             readLiveUrl's; null makes a client that never connects
 * @param {() => string|null} options.accessToken  the page's current access token, or null when signed out
 * @param {(change: { things: string[], boards: string[], what: string[], resync: boolean }) => void} options.onChange
 *        told what changed; `resync` when the page should read everything, having been away
 * @param {(status: 'off'|'connecting'|'live'|'waiting') => void} [options.onStatus]
 * @param {typeof WebSocket} [options.WebSocket]
 * @param {{ setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function }} [options.timers]
 * @param {() => number} [options.random]
 * @param {() => boolean} [options.visible]     whether the page is in view
 */
export function createLive({
  url,
  accessToken,
  onChange,
  onStatus = () => {},
  WebSocket: Socket = globalThis.WebSocket,
  timers = globalThis,
  random = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32,
  visible = () => globalThis.document?.visibilityState !== 'hidden',
}) {
  let running = false;
  let socket = null;
  let socketToken = null;
  let opened = false;
  // The connection was lost while it was wanted: what changed until it is back was not told.
  let lost = false;
  let retries = 0;
  let retryTimer = 0;
  let pingTimer = 0;
  let gatherTimer = 0;
  let gathered = null;
  let status = 'off';

  function say(next) {
    if (next === status) return;
    status = next;
    onStatus(next);
  }

  function deliver() {
    gatherTimer = 0;
    const change = gathered;
    gathered = null;
    if (change) {
      onChange({
        things: [...change.things],
        boards: [...change.boards],
        what: [...change.what],
        resync: change.resync,
      });
    }
  }

  function gather(change, resync = false) {
    gathered ??= { things: new Set(), boards: new Set(), what: new Set(), resync: false };
    for (const thing of change.things) gathered.things.add(thing);
    for (const board of change.boards) gathered.boards.add(board);
    for (const kind of change.what) gathered.what.add(kind);
    gathered.resync ||= resync;
    if (!gatherTimer) gatherTimer = timers.setTimeout(deliver, GATHER_MS);
  }

  function drop() {
    if (pingTimer) timers.clearInterval(pingTimer);
    pingTimer = 0;
    const old = socket;
    socket = null;
    socketToken = null;
    opened = false;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try {
        old.close(1000);
      } catch {
        // A socket that cannot be closed is one that is closed.
      }
    }
  }

  function wanted() {
    return (
      running && url !== null && typeof Socket === 'function' && visible() && TOKEN_SHAPE.test(accessToken() ?? '')
    );
  }

  function retryLater() {
    if (retryTimer || !wanted()) return;
    const base = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
    retries += 1;
    say('waiting');
    // Up to a quarter more, so that the pages of a whole team do not all come back at once.
    retryTimer = timers.setTimeout(
      () => {
        retryTimer = 0;
        sync();
      },
      Math.round(base * (1 + random() / 4))
    );
  }

  function open(token) {
    let next;
    try {
      next = new Socket(url, [LIVE_PROTOCOL, token]);
    } catch {
      retryLater();
      return;
    }
    socket = next;
    socketToken = token;
    say('connecting');
    next.onopen = () => {
      if (socket !== next) return;
      opened = true;
      retries = 0;
      say('live');
      pingTimer = timers.setInterval(() => {
        try {
          if (socket === next) next.send(PING);
        } catch {
          // The close that follows says the rest.
        }
      }, PING_MS);
      // Back after a lost connection: what changed meanwhile was not told. (A page that comes back into
      // view reads everything by itself.)
      if (lost) gather({ things: [], boards: [], what: [] }, true);
      lost = false;
    };
    next.onmessage = (event) => {
      if (socket !== next) return;
      const change = readChange(event?.data);
      if (change && change.what.length > 0) gather(change);
    };
    next.onclose = () => {
      if (socket !== next) return;
      if (opened) lost = true;
      drop();
      say('off');
      retryLater();
    };
    // An error is followed by a close, which says what to do.
    next.onerror = () => {};
  }

  /** Open, keep or close the WebSocket for how the page is now. Call it whenever that may have changed. */
  function sync() {
    if (!wanted()) {
      drop();
      if (retryTimer) timers.clearTimeout(retryTimer);
      retryTimer = 0;
      say('off');
      return;
    }
    const token = accessToken();
    if (socket && socketToken === token) return;
    // A new token: the connection is made again with it, before the old one's time is up.
    drop();
    if (retryTimer) return;
    open(token);
  }

  return Object.freeze({
    start() {
      running = true;
      sync();
    },
    stop() {
      running = false;
      sync();
      if (gatherTimer) timers.clearTimeout(gatherTimer);
      gatherTimer = 0;
      gathered = null;
    },
    sync,
    status: () => status,
    isLive: () => opened,
  });
}
