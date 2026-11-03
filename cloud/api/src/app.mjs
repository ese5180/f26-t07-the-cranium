/**
 * The console API as one function: an API Gateway HTTP API event (payload format 2.0)
 * goes in, a response comes out.
 *
 * Every request takes the same path:
 *
 *   1. identify the caller from the claims the gateway verified   (401)
 *      and, for a token of the phone apps' client, require a route
 *      that the phone apps use                                   (403)
 *   2. require membership of one of the console's groups         (403)
 *   3. for a read: ask Cognito whether the account is still active and a
 *      member, or go by an answer from the last minute            (403)
 *   4. find the route                                             (404)
 *   5. for a write: ask Cognito whether the caller is a release manager
 *      right now, whatever the token says                         (403)
 *   6. validate the path and the body, then act
 *
 * A request to a write route leaves exactly one entry in the activity log, whatever
 * its outcome, including the refusals in steps 1, 2 and 5 and a request that runs out
 * of time.
 *
 * Personal API tokens (handlers/tokens.mjs). A request to /api/t/<path> is the request to
 * /api/<path>, made with a token instead of a session: the gateway lets it through with no
 * authorizer, and steps 1 to 3 become
 *
 *   1. the token: exactly "Bearer crn_…", whose digest is stored, not revoked or expired (401)
 *   2. and 3. its owner, asked of Cognito now: active, and in one of the groups   (403)
 *
 * after which a write still needs a release manager, by that same answer. A token cannot
 * be used to manage tokens or to read a board's Bluetooth passkey (403). An entry made
 * with a token names the token's id. A token request that names nobody, because its token
 * is missing, malformed, unknown, revoked or expired, leaves no entry: it is what the
 * gateway's authorizer refuses for the other routes, which leaves none either. Whoever
 * holds a revoked or expired token could otherwise fill the activity log in its owner's
 * name. The log line of such a request names the token's id and its state.
 *
 * The phone apps (docs/mobile-apps.md). The gateway's authorizer takes the access tokens of
 * two app clients, the console's and the phone apps', and so does step 1. A phone app's
 * token is then good only for what the apps do: who is signed in, the releases and a
 * release's image, a board's passkey, the boards, and the check before a Bluetooth send.
 * Every other route is the console's alone and refuses it (403), so that a phone's session
 * cannot deploy, revoke, upload, make API tokens or read the activity log. A route says so
 * with `phone: true`.
 *
 * Time: Lambda stops the function 20 s after a request arrived, and what it stops
 * leaves no answer, no log line and no entry. A request is therefore given up earlier,
 * while there is time left to record it. Its work is not waited for any longer, and
 * from then on the adapter refuses the calls that work still makes, so that nothing
 * changes after the request was answered and recorded as failed.
 *
 * Nothing here imports the AWS SDK. The adapter is passed in, so the same code runs
 * against AWS in Lambda and against test/fake-aws.mjs in tests and in the local preview.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

import { RELEASE_MANAGERS, authenticate, claimedSub, createDirectory, requireMember } from './auth.mjs';
import { createAuditHandlers } from './handlers/audit.mjs';
import { createDeploymentHandlers } from './handlers/deployments.mjs';
import { createDeviceHandlers } from './handlers/devices.mjs';
import { createEventHandlers } from './handlers/events.mjs';
import { UPLOAD_BODY_LIMIT, createFirmwareHandlers } from './handlers/firmware.mjs';
import { createMeHandlers } from './handlers/me.mjs';
import { createPairingHandlers } from './handlers/pairing.mjs';
import { createTokenHandlers } from './handlers/tokens.mjs';
import {
  HttpError, SMALL_BODY_LIMIT, binary, errorCode, errorResponse, forbidden, json, notFound, readJsonObject,
} from './http.mjs';
import { REQUEST_ID } from './lib/audit.mjs';

const METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const MAX_PATH = 512;
// /api/t/<path> is /api/<path> with an API token.
const TOKEN_SEGMENT = 't';

// The function has 20 s for a request (Timeout of ApiFn in infra/template.yaml). A
// request is given up after 16 s, and in any case 4 s before Lambda's own limit: the
// time it takes to write the entry in the activity log and the log line.
const REQUEST_BUDGET_MS = 16_000;
const RESERVE_MS = 4_000;

/**
 * A route. `write` makes it a change that goes on record; `token: false` keeps it from
 * being used with an API token; `phone: true` lets a session of the phone apps' client use
 * it too. Without it a route takes a session of the console's own app client only.
 */
function route(method, path, run, write = null, { token = true, phone = false } = {}) {
  return Object.freeze({
    method, name: `${method} ${path}`, segments: path.split('/').slice(1), run, write, token, phone,
  });
}

/** Whether a path is one of the token routes: /api/t/ and something after it. */
function isTokenPath(segments) {
  return segments !== null && segments.length >= 3 && segments[0] === 'api' && segments[1] === TOKEN_SEGMENT;
}

function notForTokens() {
  return forbidden('token_not_allowed', 'An API token cannot be used for this. Sign in to the console instead.');
}

function notForPhones() {
  return forbidden('phone_not_allowed', 'The phone app\'s sign-in cannot be used for this. Sign in to the console instead.');
}

/**
 * The segments of the request path, each decoded once. Whether the gateway has
 * already decoded the path does not matter: every parameter is matched against a
 * strict grammar afterwards, and no valid value contains a "%" or a "/".
 */
function pathSegments(event) {
  const path = typeof event?.rawPath === 'string' ? event.rawPath : event?.requestContext?.http?.path;
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH) return null;
  const segments = [];
  for (const raw of path.slice(1).split('/')) {
    if (!raw.includes('%')) {
      segments.push(raw);
      continue;
    }
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  return segments;
}

function findRoute(routes, method, segments) {
  if (segments === null) return null;
  for (const candidate of routes) {
    if (candidate.method !== method || candidate.segments.length !== segments.length) continue;
    const params = {};
    let matches = true;
    for (let index = 0; index < segments.length && matches; index += 1) {
      const pattern = candidate.segments[index];
      if (!pattern.startsWith('{')) matches = pattern === segments[index];
      else if (segments[index] === '') matches = false;
      else params[pattern.slice(1, -1)] = segments[index];
    }
    if (matches) return { route: candidate, params };
  }
  return null;
}

/** The request method if it is one of the usual ones; anything else is logged as OTHER. */
function methodOf(event) {
  const method = event?.requestContext?.http?.method;
  return typeof method === 'string' && METHODS.includes(method) ? method : 'OTHER';
}

function queryOf(event) {
  const query = event?.queryStringParameters;
  return query !== null && typeof query === 'object' && !Array.isArray(query) ? query : {};
}

/** How a failed write is recorded in the activity log. */
function outcomeOf(error) {
  if (!(error instanceof HttpError)) return 'error';
  if (error.status === 401 || error.status === 403) return 'denied';
  return error.status < 500 ? 'rejected' : 'error';
}

/**
 * How long a request may take, in milliseconds. In Lambda the second argument of the
 * handler says how much time is left; without it (tests, the local preview) the
 * request gets the fixed budget.
 */
function budgetOf(invocation) {
  const left = typeof invocation?.getRemainingTimeInMillis === 'function'
    ? Number(invocation.getRemainingTimeInMillis())
    : NaN;
  return Number.isFinite(left) ? Math.min(REQUEST_BUDGET_MS, left - RESERVE_MS) : REQUEST_BUDGET_MS;
}

/** The failure a handler sees when it calls AWS for a request that was given up. */
function abandoned(operation) {
  const error = new Error(`${operation}: not sent, the request had run out of time`);
  error.name = 'AwsError';
  error.code = 'failed';
  error.operation = operation;
  return error;
}

/**
 * The adapter as the work of a request gets it. Each method is looked up when it is
 * called and passed on, unless the request that the call belongs to has run out of
 * time: then the call fails without reaching AWS. `requests` knows which request, if
 * any, the code that is running belongs to.
 */
function guarded(aws, requests) {
  const adapter = {};
  for (const name of Object.keys(aws)) {
    if (typeof aws[name] !== 'function') continue;
    adapter[name] = (...args) => (requests.getStore()?.expired === true
      ? Promise.reject(abandoned(name))
      : aws[name](...args));
  }
  return Object.freeze(adapter);
}

/**
 * @param {object} options
 * @param {object} options.aws      the AWS adapter (src/aws.mjs or test/fake-aws.mjs)
 * @param {object} options.config   the result of loadConfig (src/config.mjs)
 * @param {() => number|Date} [options.now]            the clock; epoch milliseconds
 * @param {(count: number) => string} [options.randomHex]  at least `count` lowercase hex
 *                                  characters from a CSPRNG
 * @param {(line: object) => void} [options.log]       receives each log line as an object
 * @param {{set: Function, clear: Function}} [options.timers]  setTimeout and clearTimeout,
 *                                  or stand-ins for them
 * @returns {(event: object, invocation?: object) => Promise<object>} the Lambda handler
 */
export function createApp({
  aws,
  config,
  now = Date.now,
  randomHex = (count) => randomBytes(count).toString('hex'),
  log = (line) => console.log(JSON.stringify(line)),
  timers = { set: setTimeout, clear: clearTimeout },
}) {
  if (aws === undefined || aws === null) throw new TypeError('createApp needs an AWS adapter');
  if (config === undefined || config === null) throw new TypeError('createApp needs a configuration');

  const clock = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : value;
  };
  // Which request the running code is working for: { expired }.
  const requests = new AsyncLocalStorage();
  const context = { aws: guarded(aws, requests), config, now: clock, randomHex, log };
  context.directory = createDirectory(context);

  const audit = createAuditHandlers(context);
  const devices = createDeviceHandlers(context);
  const deployments = createDeploymentHandlers(context, { devices });
  const events = createEventHandlers(context, { devices });
  const firmware = createFirmwareHandlers(context, { deployments });
  const me = createMeHandlers(context);
  const pairing = createPairingHandlers(context);
  const tokens = createTokenHandlers(context);
  // Tokens from the console and from the phone apps are both tokens of this console; which
  // routes take the phone apps' is up to each route (`phone`).
  const clientIds = [config.userPoolClientId, config.mobileClientId];
  // Changes a member makes to what is their own: the live check asks for a member, not a release manager.
  const ownTokens = { maxBody: SMALL_BODY_LIMIT, member: true };
  // What the phone apps call (docs/mobile-apps.md, "The API"), and nothing else.
  const phone = { phone: true };
  // A passkey is for a person with a phone at the board, never for a script with an API token.
  const phoneSessionOnly = { token: false, phone: true };
  // API tokens are made and ended on the website: a session of an hour from elsewhere does
  // not turn into a token of ninety days. Not with an API token, and, as on every route
  // without `phone`, not with a phone app's session.
  const websiteOnly = { token: false };

  const routes = Object.freeze([
    route('GET', '/api/me', me.get, null, phone),
    route('GET', '/api/devices', devices.list, null, phone),
    route('GET', '/api/devices/{thing}', devices.get, null, phone),
    // What the boards did, and a board's readings: written by the recorder (recorder.mjs).
    route('GET', '/api/devices/{thing}/samples', events.samples),
    route('GET', '/api/events', events.list),
    route('GET', '/api/firmware', firmware.list, null, phone),
    route('POST', '/api/firmware', firmware.upload, { action: 'firmware.upload', maxBody: UPLOAD_BODY_LIMIT }),
    route('GET', '/api/firmware/{version}', firmware.get, null, phone),
    // Reads, but each one is for release managers only and goes on record like a write:
    // the image a phone sends to a board over Bluetooth, and that board's passkey.
    route('GET', '/api/firmware/{version}/image', firmware.image, { action: 'firmware.download', maxBody: 0 }, phone),
    // A phone asks every few seconds until the board has a passkey, so an answer of "none yet" is
    // not recorded: only a passkey handed out, and a caller refused.
    route('GET', '/api/pairing/{name}', pairing.get, { action: 'pairing.read', maxBody: 0, unrecorded: ['rejected'] },
      phoneSessionOnly),
    // What a phone asks right before every Bluetooth send, from whatever image it holds: is this
    // release, with this SHA-256, still active? It changes nothing, and goes on record like a
    // write, so that a send of an image the phone kept leaves a trace too.
    route('POST', '/api/firmware/{version}/bluetooth', firmware.bluetooth,
      { action: 'firmware.bluetooth_send', maxBody: SMALL_BODY_LIMIT }, phone),
    route('POST', '/api/firmware/{version}/revoke', firmware.revoke,
      { action: 'firmware.revoke', maxBody: SMALL_BODY_LIMIT }),
    route('GET', '/api/deployments', deployments.list),
    route('POST', '/api/deployments', deployments.create,
      { action: 'deployment.create', maxBody: SMALL_BODY_LIMIT }),
    route('GET', '/api/deployments/{id}', deployments.get),
    route('POST', '/api/deployments/{id}/cancel', deployments.cancel,
      { action: 'deployment.cancel', maxBody: SMALL_BODY_LIMIT }),
    route('GET', '/api/audit', audit.list),
    // A person's own API tokens, from a signed-in session only: a token never makes or ends one.
    route('GET', '/api/tokens', tokens.list, null, websiteOnly),
    route('POST', '/api/tokens', tokens.create, { action: 'token.create', ...ownTokens }, websiteOnly),
    route('POST', '/api/tokens/{id}/revoke', tokens.revoke, { action: 'token.revoke', ...ownTokens }, websiteOnly),
  ]);

  /**
   * Who is calling, with the checks of steps 1 and 2: from the claims the gateway
   * verified, or from an API token and what Cognito says of its owner now. `email` is
   * known for a token's owner only; a session's is looked up by the live check that follows.
   * A session of any client but the console's own is refused where the route does not take
   * the phone apps', and so is one at an address with no route.
   */
  async function identify(found, event, request) {
    if (!request.viaToken) {
      const caller = authenticate(event, clientIds);
      request.sub = caller.sub;
      if (caller.clientId !== config.userPoolClientId && found?.route.phone !== true) throw notForPhones();
      requireMember(caller);
      return { caller, email: '' };
    }
    const known = await tokens.authenticate(event, request);
    requireMember(known.caller);
    return known;
  }

  /**
   * Do the work of a request, for no longer than `request.budget` milliseconds. When
   * the time is up, `request.timedOut` is set and the caller gets a failure at once.
   * The work is left behind: nothing waits for it, and the adapter refuses whatever it
   * still tries to send to AWS.
   */
  function withinDeadline(request, work, message) {
    const giveUp = () => {
      request.timedOut = true;
      log({ level: 'error', event: 'request_timed_out', requestId: request.id, budget: request.budget });
      return new HttpError(500, 'timeout', message);
    };
    // No time at all: the work is not even begun.
    if (!(request.budget > 0)) return Promise.reject(giveUp());
    const state = { expired: false };
    let timer = null;
    const late = new Promise((resolve, reject) => {
      timer = timers.set(() => {
        state.expired = true;
        reject(giveUp());
      }, request.budget);
    });
    return Promise.race([requests.run(state, work), late]).finally(() => timers.clear(timer));
  }

  async function read(found, event, request) {
    const { caller } = await identify(found, event, request);
    // A token's owner was asked about just now, without the minute's grace of a session.
    if (!request.viaToken) await context.directory.requireLiveReader(caller, request.id);
    if (found === null) throw notFound('not_found', 'There is nothing at this address.');
    if (request.viaToken && !found.route.token) throw notForTokens();
    return found.route.run({ caller, params: found.params, query: queryOf(event) });
  }

  /** Step 5 for a write: a release manager, or for a member's own things a member, now. */
  async function liveWriter(found, request, known) {
    if (!request.viaToken) {
      return found.route.write.member === true
        ? context.directory.requireLiveMember(known.caller)
        : context.directory.requireLiveWriter(known.caller);
    }
    if (!found.route.token) throw notForTokens();
    // The groups are Cognito's answer of a moment ago, for this request.
    if (!known.caller.groups.includes(RELEASE_MANAGERS)) {
      throw forbidden('release_manager_required', 'Only release managers can do this.');
    }
    return known.email;
  }

  async function write(found, event, request) {
    const { action, maxBody, unrecorded = [] } = found.route.write;
    // The handler fills these in as it learns what the request is about.
    const entry = { target: '', detail: {} };
    const actor = { sub: request.viaToken ? '' : claimedSub(event), email: '' };
    let result = null;
    let failure = null;
    try {
      result = await withinDeadline(request, async () => {
        const known = await identify(found, event, request);
        const { caller } = known;
        actor.email = await liveWriter(found, request, known);
        return found.route.run({
          caller,
          actor: { sub: caller.sub, email: actor.email },
          params: found.params,
          query: queryOf(event),
          entry,
          json: () => readJsonObject(event, maxBody),
        });
      }, 'The server ran out of time. The change may have been made in part or in full: ' +
        'check the result before you repeat it.');
    } catch (error) {
      failure = error;
    }

    // A token that named nobody, or nobody any more because it is revoked or expired: there
    // is nobody to put on record (see the top of this file). `sub` is only set for a token
    // that counts.
    if (failure !== null && request.viaToken && request.sub === null) throw failure;

    // What is known now is what goes on record. After a timeout the work that was left
    // behind may still write to these. The token comes first, so that it is never cut.
    const target = entry.target;
    const detail = request.token === null ? { ...entry.detail } : { token: request.token.id, ...entry.detail };
    const sub = request.viaToken ? request.sub : actor.sub;
    let email = actor.email;
    let outcome = 'ok';
    if (failure !== null) {
      outcome = outcomeOf(failure);
      detail.code = errorCode(failure);
      // A refusal before the live check has no address yet; look it up for the record.
      // Not after a timeout: there is no time left to wait for Cognito.
      if (email === '' && request.sub !== null) {
        email = request.timedOut
          ? context.directory.knownEmail(request.sub)
          : await context.directory.emailOf(request.sub);
      }
    }
    if (failure !== null && unrecorded.includes(outcome)) throw failure;
    const recorded = await audit.record({
      at: clock(), requestId: request.id, actor: { sub, email }, action, target, outcome, detail,
    });
    if (failure !== null) throw failure;
    if (!recorded) {
      throw new HttpError(500, 'audit_failed', 'The change was made, but it could not be written to ' +
        'the activity log. Check the result before you repeat it.');
    }
    return result;
  }

  /** The gateway's id for the request, or one made up here if there is no usable one. */
  function requestIdOf(event) {
    const given = event?.requestContext?.requestId;
    if (typeof given === 'string' && REQUEST_ID.test(given)) return given;
    const drawn = String(randomHex(16)).slice(0, 16);
    return /^[0-9a-f]{16}$/.test(drawn) ? drawn : randomBytes(8).toString('hex');
  }

  return async function handler(event, invocation) {
    const started = clock();
    const requestId = requestIdOf(event);
    const method = methodOf(event);
    const segments = pathSegments(event);
    const viaToken = isTokenPath(segments);
    const found = findRoute(routes, method, viaToken ? ['api', ...segments.slice(2)] : segments);
    // `sub` is filled in once the caller is identified, which for an API token means a token
    // that is active, and `token` ({ id, status }) once an API token is found at all.
    const request = {
      id: requestId, sub: null, viaToken, token: null, budget: budgetOf(invocation), timedOut: false,
    };

    let response;
    try {
      const result = found !== null && found.route.write !== null
        ? await write(found, event, request)
        : await withinDeadline(request, () => read(found, event, request),
          'The server ran out of time. Try again in a moment.');
      response = result.file !== undefined
        ? binary(result.status ?? 200, result.file.data, result.file.name)
        : json(result.status ?? 200, result.body);
    } catch (error) {
      const failed = errorResponse(error, requestId);
      if (failed.internal !== null) {
        log({ level: 'error', event: 'request_failed', requestId, error: failed.internal });
      }
      response = failed.response;
    }

    const line = {
      requestId,
      sub: request.sub,
      method,
      route: found === null ? 'unmatched' : found.route.name,
      status: response.statusCode,
      duration: clock() - started,
    };
    // Which token, by its id: never the token, never its digest. And whether it was revoked
    // or expired: such a request leaves no entry in the activity log, so this line is its trace.
    if (viaToken) Object.assign(line, { via: 'token', token: request.token?.id ?? null });
    if (viaToken && request.token !== null && request.token.status !== 'active') line.tokenState = request.token.status;
    log(line);
    return response;
  };
}
