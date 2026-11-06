/**
 * The parts of the customer site (docs/customer-site.md) that do not touch the page: its
 * settings, its routes, the client of the customer API, a customer's own account at Cognito,
 * and the words for what a board is doing.
 *
 * Signing in is the console's own code (core.js createAuth: SRP, the code in six boxes, the
 * revocation of the refresh token), not a copy of it. The customer site gives it the customer
 * pool's settings and a storage of its own, so that a customer's session and an admin's never
 * share a key, even in one tab.
 *
 * What arrives from the API is reduced to known shapes on the way in, as in core.js, and the
 * views only ever write it to the page as text. Nothing here reads the document.
 * No dependencies but core.js.
 */

import { ApiError, cognitoCall, parseVersion, plural, signalQuality, timeAgo } from './core.js';

// Settings.

const USER_POOL_ID = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}_[0-9A-Za-z]{1,64}$/;
const CLIENT_ID = /^[\w+]{1,128}$/;
const ORIGIN = /^https?:\/\/[^/?#\s]+$/;
const HOME = /^https?:\/\/[^/?#\s]+\/$/;

function pool(value) {
  if (value === null || typeof value !== 'object') return null;
  const { clientId, userPoolId } = value;
  return typeof clientId === 'string' &&
    CLIENT_ID.test(clientId) &&
    typeof userPoolId === 'string' &&
    USER_POOL_ID.test(userPoolId)
    ? { clientId, userPoolId }
    : null;
}

/** The settings the server put in the page, or null if they are unusable. */
export function readSiteConfig(json) {
  let value;
  try {
    value = JSON.parse(json ?? '');
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const customer = pool(value.customer);
  const admin = pool(value.admin);
  const { idpOrigin, home, adminPath } = value;
  if (!customer || !admin || typeof idpOrigin !== 'string' || !ORIGIN.test(idpOrigin)) return null;
  if (typeof home !== 'string' || !HOME.test(home) || adminPath !== '/admin') return null;
  return { customer, admin, idpOrigin, home, adminPath };
}

/**
 * What createAuth (core.js) is given for one of the two sign-ins. No managed login pages: the
 * refresh token is revoked through the user pool API, and a sign-out comes back home.
 */
export function authConfig(site, which) {
  const { clientId, userPoolId } = site[which];
  return { clientId, userPoolId, idpOrigin: site.idpOrigin, redirectUri: site.home, scope: '', loginOrigin: '' };
}

// Storage. createAuth keeps three keys; a customer's are kept under a prefix of their own, so
// that the admin's session (the console's own keys, which the console under /admin reads) and a
// customer's never meet. Clearing clears these three, and nothing else in the tab.

export const CUSTOMER_PREFIX = 'customer:';
const AUTH_KEYS = Object.freeze(['cranium.signin', 'cranium.session', 'cranium.signedout']);

export function namespaced(storage, prefix) {
  return {
    getItem: (key) => storage.getItem(`${prefix}${key}`),
    setItem: (key, value) => storage.setItem(`${prefix}${key}`, value),
    removeItem: (key) => storage.removeItem(`${prefix}${key}`),
    clear: () => {
      for (const key of AUTH_KEYS) storage.removeItem(`${prefix}${key}`);
    },
  };
}

// What the tabs of the site say to each other: only that a session of one kind ended.
export const CUSTOMER_CHANNEL = 'cranium.customer.session';

// Routes. The site has exactly these; anything else in the address bar is the home page.

export const MIX_TABS = Object.freeze(['sessions', 'transitions', 'library', 'moments']);

// The mixes' words that the phone apps' Classic screens share (CustomerText.kt, CustomerWords.swift).
export const MIXES_EYEBROW = 'Your mixes, remembered';
export const MIXES_TITLE = 'Find your next great mix.';
export const MIXES_LEDE = 'A home for the tracks, the transitions and the happy accidents of every set.';
export const NOT_BUILT = 'Not built yet';
export const WHY_EMPTY =
  'Why it is empty: your board does not send what you play. That needs the Raspberry Pi to record the tracks Mixxx ' +
  'plays and the board to pass them on, and neither is built yet. Nothing here is made up in the meantime.';
export const MIXES_NOTE =
  'When it is built, only what you played is kept: track names and times, never the music itself.';
export const TEASER_TITLE = 'Good mixes happen. Great ones get remembered.';
export const TEASER_EYEBROW = 'After the last track';
export const TEASER_TEXT =
  'Your sessions, your transitions and the tracks you keep coming back to will live here, once your board ' +
  'can tell this site what you played. That part is not built yet.';
export const TEASER_MORE = 'What is coming';
// The Overview's part about the boards, and the foot of every page.
export const BOARDS_EYEBROW = 'Your boards, at a glance';
export const BOARDS_LEDE = 'How your Cranium is doing, and what it did lately.';
export const WELCOME = 'Welcome back.';
export const FOOT_NOTE = 'Your music stays on your deck: this site only shows how your boards are.';

const VIEWS = Object.freeze(['sign-in', 'forgot', 'admin-sign-in', 'overview', 'devices', 'mixes', 'account', 'help']);
// What anybody may open, signed in or not.
export const PUBLIC_VIEWS = Object.freeze(['landing', 'sign-in', 'forgot', 'admin-sign-in', 'help']);
const ROUTE = /^#\/([a-z-]+)(?:\/([a-z0-9]+))?$/;
export const BOARD_ID = /^[0-9a-f]{16}$/;
// A session of the mixes (customer-mixes.js sessionId).
export const SESSION_ID = /^s[0-9a-f]{8}$/;

export function parseRoute(hash) {
  if (hash === '' || hash === '#' || hash === '#/') return { view: 'landing' };
  const match = typeof hash === 'string' ? ROUTE.exec(hash) : null;
  if (!match) return null;
  const [, view, item] = match;
  if (item === undefined) return VIEWS.includes(view) ? { view } : null;
  if (view === 'devices' && BOARD_ID.test(item)) return { view: 'device', id: item };
  if (view === 'mixes' && MIX_TABS.includes(item)) return { view: 'mixes', tab: item };
  if (view === 'sessions' && SESSION_ID.test(item)) return { view: 'session', id: item };
  return null;
}

export function routeHash(route) {
  if (route?.view === 'device' && BOARD_ID.test(route.id ?? '')) return `#/devices/${route.id}`;
  if (route?.view === 'mixes' && MIX_TABS.includes(route.tab)) return `#/mixes/${route.tab}`;
  if (route?.view === 'session' && SESSION_ID.test(route.id ?? '')) return `#/sessions/${route.id}`;
  if (route?.view === 'landing') return '#/';
  return VIEWS.includes(route?.view) ? `#/${route.view}` : '#/';
}

// The customer API (cloud/api/src/customer/app.mjs), read into known shapes.

const VERSION = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,4})\+(0|[1-9]\d{0,9})$/;
const STATUSES = Object.freeze(['online', 'updating', 'restarting', 'offline', 'new']);
const UPDATE_STATES = Object.freeze([
  'idle',
  'awaiting_user',
  'downloading',
  'verifying',
  'rebooting',
  'testing',
  'bluetooth',
]);
const RESULTS = Object.freeze(['none', 'succeeded', 'failed', 'rolled_back', 'declined', 'refused', 'cancelled']);
const KINDS = Object.freeze(['connection', 'firmware', 'update', 'restart', 'bluetooth']);
const WHAT = /^[a-z][a-z_]{0,23}$/;
const WORD = /^[a-z][a-z_]{0,31}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const NAME = /^[A-Za-z0-9]{1,32}$/;

const instant = (value) => (typeof value === 'string' && TIME.test(value) ? value : null);
const version = (value) => (typeof value === 'string' && VERSION.test(value) ? value : null);
const whole = (value, least, most) => (Number.isInteger(value) && value >= least && value <= most ? value : null);
// What an admin called a board: one line of their text, cut to its printable part.
const label = (value) => (typeof value === 'string' ? value.replace(/[^\x20-\x7e -ɏ]/g, '').slice(0, 40) : '');

function unreadable() {
  return new ApiError(0, 'unreadable', 'The server sent a reply this page could not read.');
}

/** A board, or null if it is not one. */
export function readBoard(raw) {
  if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || !BOARD_ID.test(raw.id)) return null;
  if (!STATUSES.includes(raw.status)) return null;
  const firmware =
    raw.firmware && version(raw.firmware.version)
      ? { version: raw.firmware.version, confirmed: raw.firmware.confirmed === true }
      : null;
  const update =
    raw.update && UPDATE_STATES.includes(raw.update.state)
      ? {
          state: raw.update.state,
          progress: whole(raw.update.progress, 0, 100) ?? 0,
          last: RESULTS.includes(raw.update.last) ? raw.update.last : 'none',
        }
      : null;
  return {
    id: raw.id,
    name: label(raw.name) || null,
    boardName: typeof raw.boardName === 'string' && NAME.test(raw.boardName) ? raw.boardName : null,
    status: raw.status,
    online: raw.online === true,
    lastSeen: instant(raw.lastSeen),
    firmware,
    update,
    rssi: whole(raw.rssi, -127, 0),
    uptime: whole(raw.uptime, 0, 2 ** 32),
    // Not reported by any board yet (docs/fleet.md, location by Wi-Fi).
    location: null,
    since: instant(raw.since),
  };
}

/** One event of a board, or null if it is not one. */
export function readEvent(raw) {
  if (raw === null || typeof raw !== 'object' || !instant(raw.at) || !KINDS.includes(raw.kind)) return null;
  if (
    typeof raw.what !== 'string' ||
    !WHAT.test(raw.what) ||
    typeof raw.board !== 'string' ||
    !BOARD_ID.test(raw.board)
  )
    return null;
  const event = { at: raw.at, board: raw.board, kind: raw.kind, what: raw.what };
  for (const field of ['version', 'from', 'to']) if (version(raw[field])) event[field] = raw[field];
  if (typeof raw.confirmed === 'boolean') event.confirmed = raw.confirmed;
  if (typeof raw.result === 'string' && WORD.test(raw.result)) event.result = raw.result;
  if (UPDATE_STATES.includes(raw.state)) event.state = raw.state;
  if (whole(raw.progress, 0, 100) !== null) event.progress = raw.progress;
  return event;
}

const list = (value, read) => (Array.isArray(value) ? value.map(read).filter((item) => item !== null) : null);

/**
 * @param {object} options
 * @param {object} options.auth            the customer's createAuth
 * @param {Function} options.fetch
 * @param {Function} options.onUnauthorized called when the API turns the session away
 * @param {string} [options.base]          where the customer API is: the page's own origin on the website,
 *                                         the customer API's address in the app (bridge.js)
 */
export function createCustomerApi({ auth, fetch, onUnauthorized, base = '' }) {
  async function get(path) {
    const token = auth.accessToken();
    if (token === null) {
      onUnauthorized();
      throw new ApiError(401, 'unauthorized', 'Your session has ended. Sign in again.');
    }
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        cache: 'no-store',
        credentials: 'omit',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new ApiError(0, 'network', 'Cranium could not be reached. Check the connection.');
    }
    if (response.status === 401) {
      auth.tokenRefused();
      onUnauthorized();
      throw new ApiError(401, 'unauthorized', 'Your session has ended. Sign in again.');
    }
    let payload = null;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      throw unreadable();
    }
    if (!response.ok) {
      const error = payload?.error ?? {};
      const message = typeof error.message === 'string' ? error.message.replace(/[^\x20-\x7e]/g, '').slice(0, 300) : '';
      const code = typeof error.code === 'string' && WORD.test(error.code) ? error.code : 'http';
      throw new ApiError(response.status, code, message || 'Something went wrong.');
    }
    if (payload === null || typeof payload !== 'object') throw unreadable();
    return payload;
  }

  return {
    async me() {
      const body = await get('/api/c/me');
      return {
        email: typeof body.email === 'string' ? body.email.slice(0, 320) : '',
        name: typeof body.name === 'string' ? label(body.name) : '',
        boards: whole(body.boards, 0, 10000) ?? 0,
      };
    },
    async boards() {
      const boards = list((await get('/api/c/boards')).boards, readBoard);
      if (boards === null) throw unreadable();
      return boards;
    },
    async board(id) {
      if (!BOARD_ID.test(id)) throw new ApiError(404, 'not_your_board', 'There is no board of yours at this address.');
      const body = await get(`/api/c/boards/${id}`);
      const board = readBoard(body.board);
      const activity = list(body.activity, readEvent);
      if (board === null || activity === null) throw unreadable();
      return { board, activity };
    },
    async activity() {
      const activity = list((await get('/api/c/activity')).activity, readEvent);
      if (activity === null) throw unreadable();
      return activity;
    },
  };
}

// A customer's own account at Cognito: the calls a signed-in person makes with their own access
// token, and the reset of a forgotten password, which needs none. Cognito's answer is the one
// that counts; the words below never repeat Cognito's own message.

export const PASSWORD_MIN = 10;

export const ACCOUNT_WORDS = Object.freeze({
  'wrong-password': 'The current password is not right.',
  'weak-password': 'That password is not accepted. Choose one of at least 10 characters.',
  'too-short': 'A password needs at least 10 characters.',
  mismatch: 'The two new passwords are not the same.',
  'missing-email': 'Type the e-mail address you sign in with.',
  'wrong-code': 'That code is not right. Check it and try again.',
  'expired-code': 'That code has expired. Ask for a new one.',
  'short-code': 'Type all six digits of the code.',
  'too-many': 'Too many tries. Wait a few minutes, then try again.',
  'not-yet': 'This account still has the temporary password from its invitation. Sign in with that one first.',
  network: 'The sign-in service could not be reached. Check the connection and try again.',
  'session-ended': 'Your session has ended. Sign in again, then try once more.',
  failed: 'That did not work. Try again in a moment.',
});

/** What an error of Cognito's means here: one of ACCOUNT_WORDS. */
export function accountProblem(name, step = '') {
  switch (name) {
    case 'NotAuthorizedException':
      if (step === 'change') return 'wrong-password';
      if (step === 'forgot') return 'not-yet';
      return 'session-ended';
    case 'InvalidPasswordException':
      return 'weak-password';
    case 'CodeMismatchException':
    case 'EnableSoftwareTokenMFAException':
      return 'wrong-code';
    case 'ExpiredCodeException':
      return 'expired-code';
    case 'LimitExceededException':
    case 'TooManyRequestsException':
    case 'TooManyFailedAttemptsException':
      return 'too-many';
    default:
      return 'failed';
  }
}

/** A new password as it was typed twice: null if it will do, else one of ACCOUNT_WORDS. */
export function passwordProblem(password, again) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) return 'too-short';
  if (password !== again) return 'mismatch';
  return null;
}

const SECRET = /^[A-Z2-7]{16,128}$/;

/** The secret of an authenticator app in groups of four, as people copy it by hand. */
export function groupSecret(secret) {
  return SECRET.test(secret ?? '') ? secret.match(/.{1,4}/g).join(' ') : '';
}

/** The address that opens an authenticator app on this phone with the account filled in. */
export function otpauthUri(secret, email) {
  if (!SECRET.test(secret ?? '')) return null;
  const account = encodeURIComponent(`Cranium:${String(email ?? '').slice(0, 254)}`);
  return `otpauth://totp/${account}?secret=${secret}&issuer=Cranium`;
}

/**
 * @param {object} options
 * @param {Function} options.fetch
 * @param {object} options.site         readSiteConfig
 * @param {() => string|null} options.accessToken  the customer's, or null
 */
export function createAccount({ fetch, site, accessToken }) {
  const ask = (operation, body) => cognitoCall(fetch, site.idpOrigin, operation, body);
  const failed = (answer, step) => ({ ok: false, problem: answer.problem ?? accountProblem(answer.error, step) });

  async function withToken(operation, body, step) {
    const token = accessToken();
    if (token === null) return { ok: false, problem: 'session-ended' };
    const answer = await ask(operation, { AccessToken: token, ...body });
    return answer.reply ? { ok: true, reply: answer.reply } : failed(answer, step);
  }

  return {
    /** { ok, email, name, authenticator }: authenticator is whether sign-in asks for a code. */
    async profile() {
      const answer = await withToken('GetUser', {}, 'profile');
      if (!answer.ok) return answer;
      const attributes = Array.isArray(answer.reply.UserAttributes) ? answer.reply.UserAttributes : [];
      const value = (name) => {
        const found = attributes.find((item) => item?.Name === name)?.Value;
        return typeof found === 'string' ? found : '';
      };
      const methods = Array.isArray(answer.reply.UserMFASettingList) ? answer.reply.UserMFASettingList : [];
      return {
        ok: true,
        email: value('email').slice(0, 320),
        name: label(value('name')),
        authenticator: methods.includes('SOFTWARE_TOKEN_MFA'),
      };
    },

    async changePassword(current, next) {
      if (typeof current !== 'string' || current === '') return { ok: false, problem: 'wrong-password' };
      const answer = await withToken('ChangePassword', { PreviousPassword: current, ProposedPassword: next }, 'change');
      return answer.ok ? { ok: true } : answer;
    },

    /** The secret of a new authenticator: { ok, secret }. */
    async startAuthenticator() {
      const answer = await withToken('AssociateSoftwareToken', {}, 'authenticator');
      if (!answer.ok) return answer;
      const secret = answer.reply.SecretCode;
      return SECRET.test(secret ?? '') ? { ok: true, secret } : { ok: false, problem: 'failed' };
    },

    /** The first code from the new authenticator: once it is right, sign-in asks for a code. */
    async confirmAuthenticator(code) {
      if (!/^\d{6}$/.test(code ?? '')) return { ok: false, problem: 'short-code' };
      const verified = await withToken(
        'VerifySoftwareToken',
        { UserCode: code, FriendlyDeviceName: 'Cranium' },
        'authenticator'
      );
      if (!verified.ok) return verified;
      if (verified.reply.Status !== 'SUCCESS') return { ok: false, problem: 'wrong-code' };
      const set = await withToken(
        'SetUserMFAPreference',
        {
          SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
        },
        'authenticator'
      );
      return set.ok ? { ok: true } : set;
    },

    async stopAuthenticator() {
      const answer = await withToken(
        'SetUserMFAPreference',
        {
          SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
        },
        'authenticator'
      );
      return answer.ok ? { ok: true } : answer;
    },

    /**
     * Ask for the code of a password reset. Cognito sends it to the address, and answers alike
     * whether or not the address has an account: the page says the same either way.
     */
    async forgotPassword(email) {
      const username = String(email ?? '')
        .trim()
        .toLowerCase();
      if (username === '') return { ok: false, problem: 'missing-email' };
      const answer = await ask('ForgotPassword', { ClientId: site.customer.clientId, Username: username });
      return answer.reply ? { ok: true } : failed(answer, 'forgot');
    },

    async confirmForgotPassword(email, code, password) {
      if (!/^\d{6}$/.test(code ?? '')) return { ok: false, problem: 'short-code' };
      const answer = await ask('ConfirmForgotPassword', {
        ClientId: site.customer.clientId,
        Username: String(email ?? '')
          .trim()
          .toLowerCase(),
        ConfirmationCode: code,
        Password: password,
      });
      return answer.reply ? { ok: true } : failed(answer, 'reset');
    },
  };
}

// Words: what a board is doing, as its owner reads it.

/** "1.11.2", or "1.11.2, build 3" when the build is not 0. */
export function shortVersion(text) {
  const parts = parseVersion(text ?? '');
  if (!parts) return '';
  const base = `${parts.major}.${parts.minor}.${parts.revision}`;
  return parts.build === 0 ? base : `${base}, build ${parts.build}`;
}

export function boardTitle(board) {
  return board?.name ?? 'Your Cranium';
}

const STATUS_WORDS = Object.freeze({
  online: { tone: 'good', icon: 'online', label: 'Online' },
  updating: { tone: 'live', icon: 'download', label: 'Updating' },
  restarting: { tone: 'live', icon: 'restart', label: 'Restarting' },
  offline: { tone: 'idle', icon: 'offline', label: 'Offline' },
  new: { tone: 'idle', icon: 'clock', label: 'Not heard from yet' },
});

/** { tone, icon, label, text } for a board's state. */
export function statusWords(board, nowMs) {
  const words = STATUS_WORDS[board.status] ?? STATUS_WORDS.offline;
  const seen = board.lastSeen ? timeAgo(board.lastSeen, nowMs) : '';
  const text =
    {
      online: 'Connected, and reporting every 30 seconds.',
      updating: 'Installing an update that Cranium sent.',
      restarting: 'Restarting to finish an update. This takes a few minutes.',
      offline: seen
        ? `Last heard from ${seen}. It reports again once it is on and on Wi-Fi.`
        : 'Not heard from lately.',
      new: 'It has not reported yet. Switch it on and connect it to Wi-Fi.',
    }[board.status] ?? '';
  return { ...words, text };
}

/** What a board's update says, in a sentence, or null when there is nothing to say. */
export function updateWords(board) {
  const update = board.update;
  if (update === null) return null;
  switch (update.state) {
    case 'awaiting_user':
      return 'An update is waiting at the board: press Button 1 on it to install the update.';
    case 'downloading':
      return `Downloading an update: ${update.progress}% so far.`;
    case 'verifying':
      return 'Checking the update it has downloaded.';
    case 'rebooting':
      return 'Restarting into the new firmware.';
    case 'testing':
      return 'Trying the new firmware. If it cannot reach Cranium within 5 minutes, it goes back to the firmware it had.';
    case 'bluetooth':
      return 'Its Bluetooth window is open, for an update from a phone.';
    default:
      return (
        {
          succeeded: 'The last update finished.',
          failed: 'The last update did not finish, and the board kept the firmware it had.',
          rolled_back: 'The last update did not stick, so the board went back to the firmware it had before.',
          declined: 'The last update was declined at the board.',
          refused: 'The board turned the last update down.',
          cancelled: 'The last update was called off before it was installed.',
          none: 'No update has run on it yet.',
        }[update.last] ?? null
      );
  }
}

/** Wi-Fi signal in a word, or ''. */
export function signalWords(rssi) {
  return signalQuality(rssi)?.label ?? '';
}

/** How the boards stand, for the overview's figures. */
export function summarize(boards) {
  const versions = [...new Set(boards.map((board) => board.firmware?.version).filter(Boolean))];
  const seen = boards
    .map((board) => board.lastSeen)
    .filter(Boolean)
    .sort();
  return {
    total: boards.length,
    online: boards.filter((board) => board.online).length,
    busy: boards.filter((board) => board.status === 'updating' || board.status === 'restarting').length,
    versions,
    lastSeen: seen.length > 0 ? seen[seen.length - 1] : null,
  };
}

/** "2 of 3 online", "All 2 online", "1 board, offline". */
export function onlineWords(summary) {
  if (summary.total === 0) return 'No boards yet';
  if (summary.online === summary.total) return summary.total === 1 ? 'Online' : `All ${summary.total} online`;
  if (summary.online === 0) return summary.total === 1 ? 'Offline' : `All ${summary.total} offline`;
  return `${summary.online} of ${summary.total} online`;
}

const RESULT_EVENT = Object.freeze({
  succeeded: ['check-circle', (v) => (v ? `Update to ${v} finished` : 'An update finished')],
  failed: ['x-circle', () => 'An update did not finish; the board kept its firmware'],
  rolled_back: ['undo', () => 'An update did not stick; the board went back to its firmware'],
  declined: ['minus-circle', () => 'An update was declined at the board'],
  refused: ['minus-circle', () => 'The board turned an update down'],
  cancelled: ['stop', () => 'An update was called off'],
});

/** One event in words: { icon, text }. */
export function eventWords(event) {
  const v = event.version ? shortVersion(event.version) : '';
  switch (`${event.kind} ${event.what}`) {
    case 'connection connected':
      return { icon: 'online', text: 'Came online' };
    case 'connection disconnected':
      return { icon: 'offline', text: 'Went offline' };
    case 'firmware reported':
      return { icon: 'chip', text: v ? `Running firmware ${v}` : 'Reported its firmware' };
    case 'firmware changed':
      return {
        icon: 'package',
        text:
          `${event.from ? `Firmware went from ${shortVersion(event.from)} to ${v}` : `Firmware is now ${v}`}` +
          `${event.confirmed === false ? ', on trial' : ''}`,
      };
    case 'firmware confirmed':
      return {
        icon: 'check',
        text: v ? `Kept firmware ${v} after its trial` : 'Kept its new firmware after its trial',
      };
    case 'update step':
      return event.state === 'awaiting_user'
        ? { icon: 'press', text: v ? `Update to ${v} waits for Button 1` : 'An update waits for Button 1' }
        : { icon: 'download', text: v ? `Started downloading ${v}` : 'Started downloading an update' };
    case 'update result': {
      const [iconName, say] = RESULT_EVENT[event.result] ?? ['minus', () => 'An update ended'];
      return { icon: iconName, text: say(v) };
    }
    case 'restart stuck':
      return { icon: 'restart', text: 'Restarted itself to recover' };
    case 'restart restarted':
    case 'restart boot':
      return { icon: 'restart', text: 'Restarted' };
    case 'bluetooth opened':
      return { icon: 'shield', text: 'Opened its Bluetooth window for a phone' };
    case 'bluetooth closed':
      return { icon: 'shield', text: 'Closed its Bluetooth window' };
    case 'bluetooth record':
      return event.result === 'succeeded' && event.to
        ? { icon: 'check-circle', text: `Updated to ${shortVersion(event.to)} over Bluetooth` }
        : { icon: 'minus-circle', text: 'An update over Bluetooth did not go through' };
    default:
      return { icon: 'minus', text: 'Something changed' };
  }
}

/** Two letters for a person, from their name or their address. */
export function initials(name, email) {
  const source = String(name || email || '').trim();
  if (source === '') return '?';
  const words = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

export { plural };
