/**
 * The customer API (CustomerApiFn): what the customer site reads about a customer's own boards.
 * docs/customer-site.md describes the site; this is its API, apart from the console's in every
 * way that counts:
 *
 *   - Its own function and role. The role may read the shadows of the boards, the events table,
 *     the ownership partition of the state table and the customer pool's users, and nothing else:
 *     no firmware, no deployments, no activity log, no staff accounts (infra/template.yaml).
 *   - Its own route, GET /api/c/{proxy+}, behind its own authorizer, whose issuer is the customer
 *     pool and whose audience is the customer site's client and the phone apps' client of the
 *     customer pool (docs/mobile-apps.md, "Customers"). The console's authorizer keeps the
 *     staff pool and the staff clients, so a customer's token is refused there, and a staff
 *     token here, by the gateway before any code runs. This function checks it all again.
 *   - Read only. A customer changes nothing through it: their password and their authenticator
 *     app are between them and Cognito, and an update is for an admin to send.
 *
 * Every request:
 *
 *   1. the token: an access token of the customer site's client or of the phone apps' client,
 *      issued by the customer pool                                                         (401)
 *   2. the account, asked of Cognito: enabled and confirmed. The answer is kept for a minute,
 *      so a disabled customer stops reading within a minute; when Cognito cannot be asked and
 *      there is no answer from the last minute, the request fails                          (403, 503)
 *   3. the route                                                                            (404)
 *   4. ownership: a board is found by its assignment id among the boards this customer owns
 *      now, never by its thing name. Another customer's board is as unknown as one that does
 *      not exist                                                                           (404)
 *
 * Routes:
 *
 *   GET /api/c/me                 -> { email, name, boards }
 *   GET /api/c/boards             -> { boards: [Board], generatedAt }      each with its health
 *   GET /api/c/boards/{id}        -> { board: Board, activity: [Event] }   the last 30 days
 *   GET /api/c/activity           -> { activity: [Event] }                 every board, the last 7 days
 *
 * Board and Event are customer/boards.mjs. Nothing here is written to the activity log: a
 * customer's reads change nothing, and the log is the console's record of what staff did.
 */

import { randomBytes } from 'node:crypto';

import { HttpError, describeError, errorResponse, forbidden, json, notFound } from '../http.mjs';
import { eventFromItem, eventRange } from '../lib/events.mjs';
import { deviceFromShadow, unknownDevice } from '../lib/shadow.mjs';
import { CUSTOMER_KINDS, REF, boardStatus, customerBoard, customerEvent } from './boards.mjs';
import { HEALTH_DAYS, HEALTH_EVENTS, HEALTH_KINDS, boardHealth } from './health.mjs';

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
  if (method !== 'GET' || segments === null || segments[0] !== 'api' || segments[1] !== 'c') return null;
  const rest = segments.slice(2);
  if (rest.length === 1 && rest[0] === 'me') return { name: 'me' };
  if (rest.length === 1 && rest[0] === 'boards') return { name: 'boards' };
  if (rest.length === 1 && rest[0] === 'activity') return { name: 'activity' };
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
  async function liveCustomer(sub, requestId) {
    let known = answers.get(sub);
    if (known === undefined || now() - known.at >= LIVE_CHECK_MS) {
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

  async function run(route, customer, sub) {
    switch (route.name) {
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
        const customer = await liveCustomer(sub, requestId);
        if (route === null) throw notFound('not_found', 'There is nothing at this address.');
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
