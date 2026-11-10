/**
 * The customer API (CustomerApiFn): what the customer site reads about a customer's own boards, and
 * the few things a customer may change. docs/customer-site.md describes the site; this is its API,
 * apart from the console's in every way that counts:
 *
 *   - Its own function and role. The role may read the shadows of the boards, the events table,
 *     the ownership partition of the state table and the customer pool's users; it may update an
 *     ownership item and a customer's preferences item, and put and read entries of the customers'
 *     partition of the audit table. Nothing else: no firmware, no deployments, no console entries,
 *     no staff accounts (infra/template.yaml).
 *   - Its own routes, GET and POST /api/c/{proxy+}, behind its own authorizer, whose issuer is the
 *     customer pool and whose audience is the customer site's client and the phone apps' client of
 *     the customer pool (docs/mobile-apps.md, "Customers"). The console's authorizer keeps the
 *     staff pool and the staff clients, so a customer's token is refused there, and a staff
 *     token here, by the gateway before any code runs. This function checks it all again.
 *   - Mostly read only. A customer may give a board of theirs a name of their own and choose which
 *     e-mails they want; their password and their authenticator app are between them and Cognito,
 *     and an update is for an admin to send. An update that waits at a board for a person (the
 *     step awaiting_user) cannot be accepted from here: the firmware takes that from Button 1 only,
 *     and no command or shadow field of the cloud reaches it (docs/customer-site.md, "Customer actions").
 *
 * Every request:
 *
 *   1. the token: an access token of the customer site's client or of the phone apps' client,
 *      issued by the customer pool                                                         (401)
 *   2. the account, asked of Cognito: enabled and confirmed. For a read the answer is kept for a
 *      minute, so a disabled customer stops reading within a minute; a write always asks again.
 *      When Cognito cannot be asked and there is no answer to use, the request fails      (403, 503)
 *   3. the route                                                                            (404)
 *   4. a write only: at most WRITES_PER_MINUTE a minute and WRITES_PER_HOUR an hour per customer,
 *      counted from their entries in the customers' partition of the audit table, so that it holds
 *      across every instance of the function; one over is refused and leaves no entry   (429)
 *   5. ownership: a board is found by its assignment id among the boards this customer owns
 *      now, never by its thing name. Another customer's board is as unknown as one that does
 *      not exist                                                                           (404)
 *
 * Routes:
 *
 *   GET  /api/c/me                  -> { email, name, boards }
 *   GET  /api/c/boards              -> { boards: [Board], generatedAt }      each with its health
 *   GET  /api/c/boards/{id}         -> { board: Board, activity: [Event] }   the last 30 days
 *   GET  /api/c/activity            -> { activity: [Event] }                 every board, the last 7 days
 *   GET  /api/c/sessions            -> { sessions, nowPlaying, generatedAt } what their boards played (customer/sessions.mjs)
 *   GET  /api/c/preferences         -> Preferences
 *   POST /api/c/boards/{id}/label   { label }  -> { board: Board }           customer_action.rename
 *        the customer's own name for the board, 1 to LABEL_LIMIT characters; "" takes it away
 *   POST /api/c/preferences         { offline?, updated?, unexpectedRestart? } -> Preferences
 *                                                                             customer_action.notifications
 *
 * Preferences: { notifications: { offline, updated, unexpectedRestart }, emails: "on" | "off" }, each
 * false until the customer turns it on; `emails` says whether Cranium sends them yet (customer/notify.mjs).
 *
 * Board and Event are customer/boards.mjs. A read changes nothing and leaves no entry. Every write that
 * passes steps 1 to 4 leaves exactly one entry, whatever happened to it, in the audit table's partition
 * CUS (lib/audit.mjs), with `by: "customer"` and the customer's sub, never their e-mail address: the
 * console's activity log shows it as done by a customer. Its digest is logged here, as the console does.
 */

import { randomBytes } from 'node:crypto';

import {
  HttpError,
  badRequest,
  describeError,
  errorResponse,
  field,
  forbidden,
  json,
  notFound,
  readJsonObject,
} from '../http.mjs';
import { auditDigest, auditItem } from '../lib/audit.mjs';
import { eventFromItem, eventRange } from '../lib/events.mjs';
import { deviceFromShadow, unknownDevice } from '../lib/shadow.mjs';
import { CUSTOMER_KINDS, LABEL_LIMIT, REF, boardStatus, customerBoard, customerEvent } from './boards.mjs';
import { boardSessions } from './sessions.mjs';
import { HEALTH_DAYS, HEALTH_EVENTS, HEALTH_KINDS, boardHealth } from './health.mjs';
import { CUSTOMER_EMAILS_ENABLED, NOTIFICATION_KINDS, preferencesOf } from './notify.mjs';

const SUB = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_PATH = 256;
const LIVE_CHECK_MS = 60_000;
const KEPT_ANSWERS = 512;
const DAY_MS = 86_400_000;
const BOARD_DAYS = 30;
const OVERVIEW_DAYS = 7;
const BOARD_EVENTS = 50;
const OVERVIEW_EVENTS = 20;
// The function has 10 s (CustomerApiFn in infra/template.yaml); a request is given up before.
const REQUEST_BUDGET_MS = 8_000;
// A board's events for its health are kept this long: a restart shows within a minute.
const HEALTH_CACHE_MS = 60_000;
const KEPT_HEALTH = 512;
// What a customer may change, and how often (step 4).
export const WRITES_PER_MINUTE = 10;
export const WRITES_PER_HOUR = 60;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
// A write's body is a few fields: anything longer is not one.
const WRITE_BODY_LIMIT = 1024;
// The letters a board's name may have: what the site shows (customer-core.js), with no control,
// format or invisible character, and no space at either end.
const LABEL_TEXT = /^[\x20-\x7e\u00a0-\u024f]+$/u;
const WRITES = Object.freeze({ rename: 'customer_action.rename', preferences: 'customer_action.notifications' });

const unauthorized = () => new HttpError(401, 'unauthorized', 'Sign in to see your boards.');
const unknownBoard = () => notFound('not_your_board', 'There is no board of yours at this address.');

function claimsOf(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  return claims !== null && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
}

/** The clients whose access tokens this API takes: the customer site's, and the phone apps'. */
function clientsOf(config) {
  return [config.customerClientId, config.customerMobileClientId].filter((id) => typeof id === 'string' && id !== '');
}

/**
 * The customer the token names, and which client it is of ('site' or 'phone'), or throw 401.
 * Fails closed: anything unexpected is a refusal.
 */
export function authenticateCustomer(event, config) {
  const claims = claimsOf(event);
  if (claims === null) throw unauthorized();
  if (
    claims.token_use !== 'access' ||
    typeof claims.client_id !== 'string' ||
    !clientsOf(config).includes(claims.client_id)
  ) {
    throw unauthorized();
  }
  // The gateway checked the issuer; a token of another pool must not get this far even if it did not.
  if (claims.iss !== undefined && claims.iss !== config.issuer) throw unauthorized();
  if (typeof claims.sub !== 'string' || !SUB.test(claims.sub)) throw unauthorized();
  return { sub: claims.sub, client: claims.client_id === config.customerClientId ? 'site' : 'phone' };
}

function pathSegments(event) {
  const path = typeof event?.rawPath === 'string' ? event.rawPath : event?.requestContext?.http?.path;
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH) return null;
  return path.slice(1).split('/');
}

function routeOf(method, segments) {
  if (segments === null || segments[0] !== 'api' || segments[1] !== 'c') return null;
  const rest = segments.slice(2);
  if (method === 'POST') {
    if (rest.length === 3 && rest[0] === 'boards' && rest[1] !== '' && rest[2] === 'label') {
      return { name: 'rename', id: rest[1], write: true };
    }
    if (rest.length === 1 && rest[0] === 'preferences') return { name: 'preferences', write: true };
    return null;
  }
  if (method !== 'GET') return null;
  if (rest.length === 1 && rest[0] === 'preferences') return { name: 'preferences.read' };
  if (rest.length === 1 && rest[0] === 'me') return { name: 'me' };
  if (rest.length === 1 && rest[0] === 'boards') return { name: 'boards' };
  if (rest.length === 1 && rest[0] === 'activity') return { name: 'activity' };
  if (rest.length === 1 && rest[0] === 'sessions') return { name: 'sessions' };
  if (rest.length === 2 && rest[0] === 'boards' && rest[1] !== '') return { name: 'board', id: rest[1] };
  return null;
}

/**
 * @param {object} options
 * @param {object} options.aws     getCustomer and listOwnership (customer/aws.mjs createCustomerStore),
 *                                 getShadow and queryEvents (createBoardReader), or test/fake-customers.mjs
 * @param {object} options.config  loadCustomerApiConfig (customer/config.mjs)
 * @param {() => number} [options.now]
 * @param {(line: object) => void} [options.log]
 */
export function createCustomerApp({
  aws,
  config,
  now = Date.now,
  log = (line) => console.log(JSON.stringify(line)),
  timers = { set: setTimeout, clear: clearTimeout },
}) {
  if (!aws || !config) throw new TypeError('createCustomerApp needs an adapter and a configuration');
  // sub -> { refusal: boolean, email, name, at }
  const answers = new Map();
  // thing -> { at, events }: the restart, firmware and update events of the last HEALTH_DAYS days
  const healthEvents = new Map();

  /** Step 2: the account, as Cognito says it is now or said it was in the last minute. */
  async function liveCustomer(sub, requestId, { fresh = false } = {}) {
    let known = answers.get(sub);
    if (fresh || known === undefined || now() - known.at >= LIVE_CHECK_MS) {
      try {
        const customer = await aws.getCustomer(sub);
        const active = customer !== null && customer.enabled === true && customer.status === 'CONFIRMED';
        known = { refusal: !active, email: customer?.email ?? '', name: customer?.name ?? '', at: now() };
        if (answers.size >= KEPT_ANSWERS) answers.clear();
        answers.set(sub, known);
      } catch (error) {
        log({ level: 'warn', event: 'live_check_failed', requestId, sub, error: describeError(error) });
        throw new HttpError(503, 'unavailable', 'Your account could not be checked just now. Try again in a minute.');
      }
    }
    if (known.refusal)
      throw forbidden('account_inactive', 'This account is switched off. Ask Cranium to turn it back on.');
    return known;
  }

  /** The boards this customer owns now, each with its Device. */
  async function ownedBoards(sub) {
    const mine = (await aws.listOwnership())
      .filter((item) => item.owner === sub && REF.test(item.ref))
      .sort((a, b) => ((a.assignedAt ?? '') < (b.assignedAt ?? '') ? -1 : 1));
    const settled = await Promise.allSettled(mine.map((item) => aws.getShadow(item.thing)));
    return mine.map((item, index) => {
      const result = settled[index];
      const device =
        result.status === 'fulfilled' ? deviceFromShadow(item.thing, result.value, now()) : unknownDevice(item.thing);
      if (result.status === 'rejected') {
        log({ level: 'warn', event: 'shadow_unreadable', error: describeError(result.reason).message });
      }
      return { ownership: item, device };
    });
  }

  /** A board's health (customer/health.mjs), from its events of the week, read at most once a minute. */
  async function healthOf({ ownership, device }) {
    let kept = healthEvents.get(ownership.thing);
    if (kept === undefined || now() - kept.at >= HEALTH_CACHE_MS) {
      const range = eventRange(now() - HEALTH_DAYS * DAY_MS, now());
      const nowSec = now() / 1000;
      const items = await aws.queryEvents({
        thing: ownership.thing,
        low: range.low,
        high: range.high,
        kinds: [...HEALTH_KINDS],
        limit: HEALTH_EVENTS,
      });
      kept = {
        at: now(),
        events: items
          .filter((item) => !(Number.isFinite(item?.ttl) && item.ttl <= nowSec))
          .map(eventFromItem)
          .filter((event) => event !== null),
      };
      if (healthEvents.size >= KEPT_HEALTH) healthEvents.clear();
      healthEvents.set(ownership.thing, kept);
    }
    return boardHealth({ status: boardStatus(device), lastSeen: device.lastSeen, events: kept.events, nowMs: now() });
  }

  /** Each owned board as its owner sees it, with its health; a board whose events cannot be read has none. */
  async function shownBoards(owned) {
    const healths = await Promise.allSettled(owned.map(healthOf));
    return owned.map(({ device, ownership }, index) => {
      const result = healths[index];
      if (result.status === 'rejected') {
        log({ level: 'warn', event: 'health_unreadable', error: describeError(result.reason).message });
      }
      return customerBoard(device, ownership, result.status === 'fulfilled' ? result.value : null);
    });
  }

  /** The events of some owned boards, newest first, as the customer sees them. */
  async function activityOf(owned, days, limit) {
    const range = eventRange(now() - days * DAY_MS, now());
    const nowSec = now() / 1000;
    const parts = await Promise.all(
      owned.map(({ ownership }) =>
        aws
          .queryEvents({
            thing: ownership.thing,
            low: range.low,
            high: range.high,
            kinds: [...CUSTOMER_KINDS],
            limit,
          })
          .then((items) =>
            items
              .filter((item) => !(Number.isFinite(item?.ttl) && item.ttl <= nowSec))
              .map((item) => customerEvent(eventFromItem(item), ownership.ref))
          )
      )
    );
    return parts
      .flat()
      .filter((event) => event !== null)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, limit);
  }

  /** A customer's choices of e-mails, as the API answers them. */
  async function preferencesReply(sub) {
    return {
      notifications: preferencesOf(await aws.getPreferences(sub)),
      emails: CUSTOMER_EMAILS_ENABLED ? 'on' : 'off',
    };
  }

  /** Step 4: refused with 429 when this customer changed too much lately. */
  async function withinWriteLimits(sub, requestId) {
    let recent;
    try {
      // The hour and the minute up to now: an entry exactly an hour (or a minute) old has left them.
      recent = await aws.recentCustomerActions({ sub, since: new Date(now() - HOUR_MS + 1).toISOString() });
    } catch (error) {
      log({ level: 'warn', event: 'write_count_failed', requestId, sub, error: describeError(error) });
      throw new HttpError(503, 'unavailable', 'That could not be saved just now. Try again in a minute.');
    }
    const minuteAgo = new Date(now() - MINUTE_MS + 1).toISOString();
    if (recent.length >= WRITES_PER_HOUR || recent.filter((key) => key >= minuteAgo).length >= WRITES_PER_MINUTE) {
      throw new HttpError(429, 'too_many_changes', 'That is a lot of changes at once. Wait a minute, then try again.');
    }
    // The count above is read before the write, so requests in flight together all see the same number. The
    // slots make the limit hold: one conditional ADD each on a counter per clock hour and minute, which only
    // counts while it is below the limit.
    const nowMs = now();
    const nowSec = Math.floor(nowMs / 1000);
    const slots = [
      { bucket: `h${Math.floor(nowMs / HOUR_MS)}`, limit: WRITES_PER_HOUR, ttl: nowSec + 2 * 3600 },
      { bucket: `m${Math.floor(nowMs / MINUTE_MS)}`, limit: WRITES_PER_MINUTE, ttl: nowSec + 600 },
    ];
    for (const slot of slots) {
      let result;
      try {
        result = await aws.takeWriteSlot({ sub, ...slot });
      } catch (error) {
        log({ level: 'warn', event: 'write_count_failed', requestId, sub, error: describeError(error) });
        throw new HttpError(503, 'unavailable', 'That could not be saved just now. Try again in a minute.');
      }
      if (!result.ok) {
        throw new HttpError(
          429,
          'too_many_changes',
          'That is a lot of changes at once. Wait a minute, then try again.'
        );
      }
    }
  }

  /** The customer's own name for a board, checked: '' takes it away. */
  function requireLabel(value) {
    if (typeof value !== 'string') throw badRequest('invalid_label', 'Give the board a name, or leave it empty.');
    const label = value.trim();
    if ([...label].length > LABEL_LIMIT) {
      throw badRequest('label_too_long', `A board's name is at most ${LABEL_LIMIT} characters.`);
    }
    if (label !== '' && !LABEL_TEXT.test(label)) {
      throw badRequest('invalid_label', 'Use letters, numbers, spaces and punctuation only.');
    }
    return label;
  }

  async function rename(route, sub, body, entry) {
    const label = requireLabel(field(body, 'label'));
    for (const name of Object.keys(body)) {
      if (name !== 'label') throw badRequest('unknown_field', "Only the board's name can be changed here.");
    }
    entry.detail.label = label;
    if (!REF.test(route.id)) throw unknownBoard();
    entry.detail.board = route.id;
    const found = (await ownedBoards(sub)).find(({ ownership }) => ownership.ref === route.id);
    if (found === undefined) throw unknownBoard();
    entry.target = found.ownership.thing;
    const before = found.ownership.customerLabel || null;
    const done = await aws.setCustomerLabel({
      thing: found.ownership.thing,
      owner: sub,
      ref: found.ownership.ref,
      label,
      at: new Date(now()).toISOString(),
    });
    // Taken back or given to someone else since it was read: no longer theirs.
    if (!done.ok) throw unknownBoard();
    entry.changes.push({ field: 'label', from: before, to: label || null });
    const ownership = { ...found.ownership, customerLabel: label };
    const [board] = await shownBoards([{ ownership, device: found.device }]);
    return { board };
  }

  async function choose(sub, body, entry) {
    const given = {};
    for (const name of Object.keys(body)) {
      if (!NOTIFICATION_KINDS.includes(name)) {
        throw badRequest('unknown_field', 'Only offline, updated and unexpectedRestart can be chosen.');
      }
      if (typeof body[name] !== 'boolean') throw badRequest('invalid_choice', `"${name}" must be true or false.`);
      given[name] = body[name];
    }
    if (Object.keys(given).length === 0)
      throw badRequest('nothing_chosen', 'Choose at least one e-mail to turn on or off.');
    const before = preferencesOf(await aws.getPreferences(sub));
    const after = { ...before, ...given };
    for (const name of NOTIFICATION_KINDS) {
      entry.detail[name] = after[name];
      if (before[name] !== after[name]) {
        entry.changes.push({ field: name, from: before[name] ? 'on' : 'off', to: after[name] ? 'on' : 'off' });
      }
    }
    await aws.setPreferences(sub, after, new Date(now()).toISOString());
    return preferencesReply(sub);
  }

  /** Store the entry of one write. Never throws: a write that could not be recorded is logged. */
  async function recordAction(entry) {
    try {
      const item = { ...auditItem(entry), by: 'customer' };
      const stored = await aws.putCustomerAction(item);
      if (!stored.ok) throw new Error('an entry with this time and request id exists');
      log({
        event: 'audit_entry',
        requestId: item.requestId,
        sub: item.actor.sub,
        action: item.action,
        outcome: item.outcome,
        digest: auditDigest(item),
      });
    } catch (error) {
      log({
        level: 'error',
        event: 'audit_write_failed',
        requestId: entry.requestId,
        action: entry.action,
        outcome: entry.outcome,
        error: describeError(error),
      });
    }
  }

  /** Steps 4 and 5 of a write, and its entry. */
  async function write(route, sub, event, requestId) {
    await withinWriteLimits(sub, requestId);
    const entry = {
      at: now(),
      requestId,
      actor: { sub, email: '' },
      action: WRITES[route.name],
      target: '',
      outcome: 'error',
      detail: {},
      changes: [],
    };
    try {
      const body = readJsonObject(event, WRITE_BODY_LIMIT);
      const result = route.name === 'rename' ? await rename(route, sub, body, entry) : await choose(sub, body, entry);
      entry.outcome = 'ok';
      return result;
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) {
        entry.outcome = error.status === 404 ? 'denied' : 'rejected';
        entry.detail.code = error.code;
      }
      throw error;
    } finally {
      await recordAction(entry);
    }
  }

  async function run(route, customer, sub) {
    switch (route.name) {
      case 'preferences.read':
        return preferencesReply(sub);
      case 'me': {
        const owned = (await aws.listOwnership()).filter((item) => item.owner === sub);
        return { email: customer.email, name: customer.name, boards: owned.length };
      }
      case 'boards': {
        const owned = await ownedBoards(sub);
        return {
          boards: await shownBoards(owned),
          generatedAt: new Date(now()).toISOString(),
        };
      }
      case 'activity':
        return { activity: await activityOf(await ownedBoards(sub), OVERVIEW_DAYS, OVERVIEW_EVENTS) };
      case 'sessions': {
        // Ownership first, as for every read: only the boards this customer owns now are read.
        const mine = (await aws.listOwnership()).filter((item) => item.owner === sub && REF.test(item.ref));
        return {
          ...(await boardSessions({ aws, boards: mine, nowMs: now(), log })),
          generatedAt: new Date(now()).toISOString(),
        };
      }
      case 'board': {
        if (!REF.test(route.id)) throw unknownBoard();
        const found = (await ownedBoards(sub)).find(({ ownership }) => ownership.ref === route.id);
        if (found === undefined) throw unknownBoard();
        const [board] = await shownBoards([found]);
        return {
          board,
          activity: await activityOf([found], BOARD_DAYS, BOARD_EVENTS),
        };
      }
      default:
        throw notFound('not_found', 'There is nothing at this address.');
    }
  }

  function requestIdOf(event) {
    const given = event?.requestContext?.requestId;
    return typeof given === 'string' && /^[A-Za-z0-9+/=_.:-]{1,128}$/.test(given)
      ? given
      : randomBytes(8).toString('hex');
  }

  /** The work of a request, given up after REQUEST_BUDGET_MS with a 503 instead of no answer at all. */
  function withinBudget(work) {
    let timer = null;
    const late = new Promise((_, reject) => {
      timer = timers.set(
        () => reject(new HttpError(503, 'timeout', 'That took too long. Try again in a moment.')),
        REQUEST_BUDGET_MS
      );
    });
    return Promise.race([work(), late]).finally(() => timers.clear(timer));
  }

  return async function customerHandler(event) {
    const started = now();
    const requestId = requestIdOf(event);
    const method = typeof event?.requestContext?.http?.method === 'string' ? event.requestContext.http.method : 'OTHER';
    const route = routeOf(method, pathSegments(event));
    let sub = null;
    let client;
    let response;
    try {
      const body = await withinBudget(async () => {
        ({ sub, client } = authenticateCustomer(event, config));
        // A write asks Cognito again, whatever it said a moment ago.
        const customer = await liveCustomer(sub, requestId, { fresh: route?.write === true });
        if (route === null) throw notFound('not_found', 'There is nothing at this address.');
        if (route.write === true) return write(route, sub, event, requestId);
        return run(route, customer, sub);
      });
      response = json(200, body);
    } catch (error) {
      const failed = errorResponse(error, requestId);
      if (failed.internal !== null) log({ level: 'error', event: 'request_failed', requestId, error: failed.internal });
      response = failed.response;
    }
    log({
      api: 'customer',
      requestId,
      sub,
      client,
      method,
      route: route === null ? 'unmatched' : route.name,
      status: response.statusCode,
      duration: now() - started,
    });
    return response;
  };
}
