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
 * of time. A route may leave out refusals of one kind (`unrecorded`, `unrecordedCodes`).
 *
 * Sign-ins. The first request of a sign-in that this instance of the function sees, read or
 * write, that gets past the live check of step 3 or 5, also leaves an entry `account.sign_in`:
 * who, on the website or in a phone app, and when they gave their password and code. A sign-in
 * is the token's sub, its auth_time and its client: a refreshed token keeps its auth_time, so a
 * phone that refreshes its session for days is one sign-in, and the website, which keeps no
 * refresh token, makes one each time a person signs in. An API token is no sign-in, and neither
 * is a request made up by cloud/smoke.sh or the test bench (SCRIPTED). Every instance makes the
 * same key for the same sign-in (lib/audit.mjs signInRequestId) and the put is conditional, so the
 * log holds one entry however many instances see it; each instance remembers the sign-ins it has
 * recorded, so that it puts at most once for each. It is written after the request's own work, waits for at most
 * SIGN_IN_WAIT_MS, and whatever happens to it, the request's answer stays what it was. No
 * address of the caller is recorded.
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
 * SideStore sources (handlers/sidestore.mjs). A GET under /api/sidestore/ is SideStore on an iPhone,
 * which signs in to nothing: the gateway lets it through with no authorizer, as for /api/t/, and the
 * key in the path is the credential. None of the steps above apply; the handler checks the key, counts
 * its use, and asks Cognito whether its owner is still a member. A dead key leaves no entry, only its
 * log line, which names the route and never the key.
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

import {
  RELEASE_MANAGERS,
  authenticate,
  claimedSub,
  createDirectory,
  requireFreshSignIn,
  requireMember,
} from './auth.mjs';
import { createAlertHandlers } from './handlers/alerts.mjs';
import { createAppHandlers } from './handlers/apps.mjs';
import { createAuditHandlers } from './handlers/audit.mjs';
import { createCommandHandlers } from './handlers/commands.mjs';
import { createCustomerHandlers } from './handlers/customers.mjs';
import { createDbHandlers } from './handlers/db.mjs';
import { createDeploymentHandlers } from './handlers/deployments.mjs';
import { createDeviceHandlers } from './handlers/devices.mjs';
import { createEventHandlers } from './handlers/events.mjs';
import { UPLOAD_BODY_LIMIT, createFirmwareHandlers } from './handlers/firmware.mjs';
import { createGoldenHandlers } from './handlers/golden.mjs';
import { createFleetHandlers } from './handlers/fleet.mjs';
import { createGroupHandlers } from './handlers/groups.mjs';
import { createLocationHandlers } from './handlers/location.mjs';
import { createMemfaultHandlers } from './handlers/memfault.mjs';
import { createMeHandlers } from './handlers/me.mjs';
import { createPairingHandlers } from './handlers/pairing.mjs';
import { createProvisionHandlers } from './handlers/provision.mjs';
import { createReportHandlers } from './handlers/reports.mjs';
import { createSetupHandlers } from './handlers/setup.mjs';
import { createRolloutHandlers } from './handlers/rollouts.mjs';
import { createScheduleHandlers } from './handlers/schedules.mjs';
import { createSerialHandlers } from './handlers/serial.mjs';
import { createSidestoreHandlers } from './handlers/sidestore.mjs';
import { createTeamHandlers } from './handlers/team.mjs';
import { createTimelineHandlers } from './handlers/timeline.mjs';
import { createTokenHandlers } from './handlers/tokens.mjs';
import { createUpdateHandlers } from './handlers/updates.mjs';
import {
  HttpError,
  SMALL_BODY_LIMIT,
  binary,
  errorCode,
  errorResponse,
  forbidden,
  json,
  notFound,
  readJsonObject,
} from './http.mjs';
import { REQUEST_ID, signInRequestId } from './lib/audit.mjs';
import { pace } from './lib/iot-pace.mjs';

const METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const MAX_PATH = 512;
// /api/t/<path> is /api/<path> with an API token.
const TOKEN_SEGMENT = 't';
// /api/sidestore/<key>/... is a member's SideStore source, with no sign-in (handlers/sidestore.mjs).
const SOURCE_SEGMENT = 'sidestore';

// The function has 20 s for a request (Timeout of ApiFn in infra/template.yaml). A
// request is given up after 16 s, and in any case 4 s before Lambda's own limit: the
// time it takes to write the entry in the activity log and the log line.
const REQUEST_BUDGET_MS = 16_000;
const RESERVE_MS = 4_000;

// How long a request waits for its sign-in to be recorded, and how many sign-ins an instance
// remembers having recorded before it starts again from none.
const SIGN_IN_WAIT_MS = 1_500;
const SIGN_INS_KEPT = 1024;
// The request ids of cloud/smoke.sh and the test bench, which invoke the function directly with
// claims they wrote themselves (docs/aws-iot.md, Known limits): such a request is no sign-in.
const SCRIPTED = /^(?:bench|smoke)-/;

/**
 * A route. `write` makes it a change that goes on record; `token: false` keeps it from
 * being used with an API token; `phone: false` would keep a session of the phone apps' client
 * off it, and no route does that now: the app does everything the website does. A change made
 * from the phone needs a sign-in in the last 15 minutes, except where `atTheBoard` says the
 * person is standing at a board (the image and passkey for Bluetooth, and the check before a send).
 */
function route(method, path, run, write = null, { token = true, phone = true, atTheBoard = false } = {}) {
  return Object.freeze({
    method,
    name: `${method} ${path}`,
    segments: path.split('/').slice(1),
    run,
    write,
    token,
    phone,
    atTheBoard,
  });
}

/** Whether a path is one of the token routes: /api/t/ and something after it. */
function isTokenPath(segments) {
  return segments !== null && segments.length >= 3 && segments[0] === 'api' && segments[1] === TOKEN_SEGMENT;
}

/** Whether a request is SideStore's: a GET of /api/sidestore/ and something after it. */
function isSourcePath(method, segments) {
  return (
    method === 'GET' &&
    segments !== null &&
    segments.length >= 3 &&
    segments[0] === 'api' &&
    segments[1] === SOURCE_SEGMENT
  );
}

function notForTokens() {
  return forbidden('token_not_allowed', 'An API token cannot be used for this. Sign in to the console instead.');
}

function notForPhones() {
  return forbidden(
    'phone_not_allowed',
    "The phone app's sign-in cannot be used for this. Sign in to the console instead."
  );
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
  const left =
    typeof invocation?.getRemainingTimeInMillis === 'function' ? Number(invocation.getRemainingTimeInMillis()) : NaN;
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
    adapter[name] = (...args) =>
      requests.getStore()?.expired === true ? Promise.reject(abandoned(name)) : aws[name](...args);
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
 * @param {object} [options.versions]  what versions.json says (lib/versions.mjs parseBundledVersions);
 *                                  left out, the file beside the code, as deployed
 * @param {object} [options.pacing]  options of lib/iot-pace.mjs pace (a clock and sleep for tests)
 * @returns {(event: object, invocation?: object) => Promise<object>} the Lambda handler
 */
export function createApp({
  aws,
  config,
  now = Date.now,
  randomHex = (count) => randomBytes(count).toString('hex'),
  log = (line) => console.log(JSON.stringify(line)),
  timers = { set: setTimeout, clear: clearTimeout },
  versions,
  pacing = {},
}) {
  if (aws === undefined || aws === null) throw new TypeError('createApp needs an AWS adapter');
  if (config === undefined || config === null) throw new TypeError('createApp needs a configuration');

  const clock = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : value;
  };
  // Which request the running code is working for: { expired }.
  const requests = new AsyncLocalStorage();
  // AWS IoT's job reads, paced and retried when throttled (lib/iot-pace.mjs).
  const context = { aws: guarded(pace(aws, { log, ...pacing }), requests), config, now: clock, randomHex, log };
  context.directory = createDirectory(context);

  const audit = createAuditHandlers(context);
  const devices = createDeviceHandlers(context);
  // Board types, groups and staged rollouts (docs/fleet.md). Deployments and the check before a
  // Bluetooth send ask the fleet for each board's type. Fleet health counts the update history's
  // updates, which are made after the deployments they read.
  let updates = null;
  let memfault = null;
  const fleet = createFleetHandlers(context, { devices, updates: () => updates, memfault: () => memfault });
  const deployments = createDeploymentHandlers(context, { devices, fleet });
  // The update history (handlers/updates.mjs): every update of every board, deployments and the
  // updates the boards reported themselves, over Bluetooth or by USB.
  updates = createUpdateHandlers(context, { devices, deployments });
  const events = createEventHandlers(context, { devices });
  // Each board's version timeline (handlers/timeline.mjs), made from the update history.
  const timeline = createTimelineHandlers(context, { devices, updates });
  const firmware = createFirmwareHandlers(context, { deployments, fleet });
  // Golden image promotion (console 2.27.5, firmware 1.22.0): a release's signed record, and its jobs.
  const golden = createGoldenHandlers(context, { devices, fleet });
  const groups = createGroupHandlers(context, { devices, fleet });
  const rollouts = createRolloutHandlers(context, { devices, deployments, fleet, audit, updates: () => updates });
  // Starts asked for later (console 2.20.0): made, edited and cancelled here, started by the schedule (tick.mjs).
  const schedules = createScheduleHandlers(context, { deployments, rollouts, audit });
  const me = createMeHandlers(context);
  const pairing = createPairingHandlers(context);
  // Provisioning through the console (docs/new-board-setup.md): a board registered by a release manager.
  const provision = createProvisionHandlers(context);
  // Board setup's Wi-Fi defaults, from the stack's secret (handlers/setup.mjs).
  const setup = createSetupHandlers(context);
  const serial = createSerialHandlers(context);
  const tokens = createTokenHandlers(context);
  // The map, commands and alerts (docs/fleet.md): positions on the boards, commands to them, e-mail alerts.
  const location = createLocationHandlers(context, { devices });
  const commands = createCommandHandlers(context, { devices, fleet });
  const alerts = createAlertHandlers(context);
  // What Memfault knows of the boards, read from its REST API on the server (docs/memfault.md).
  memfault = createMemfaultHandlers(context, { devices });
  // The phone apps on the Apps page (docs/mobile-apps.md): the Android app's releases, the iPhone app's
  // version, the apps' configuration, and the console's own version beside who is signed in.
  const apps = createAppHandlers(context, { versions });
  // The customer site's customers and their boards (docs/customer-site.md).
  const customers = createCustomerHandlers(context, { devices });
  // The team's accounts, for the Team page (docs/accounts.md): release managers only.
  const team = createTeamHandlers(context);
  // The weekly fleet report (docs/reports.md): made on demand from the records above, and kept.
  const reports = createReportHandlers(context, { devices, fleet, deployments, memfault: () => memfault });
  // Each member's SideStore source, which keeps the iPhone app on their iPhone up to date.
  const sidestore = createSidestoreHandlers(context, { apps, audit });
  // The Database page (docs/database.md): the three tables, read only, for release managers.
  const db = createDbHandlers(context);
  // Tokens from the console and from the phone apps are both tokens of this console; which
  // routes take the phone apps' is up to each route (`phone`).
  const clientIds = [config.userPoolClientId, config.mobileClientId];
  // Changes a member makes to what is their own: the live check asks for a member, not a release manager.
  const ownTokens = { maxBody: SMALL_BODY_LIMIT, member: true };
  // A person at a board with a phone, for an update over Bluetooth: no fresh sign-in asked for.
  const atBoard = { atTheBoard: true };
  // API tokens are made and ended on the website: a session of an hour from elsewhere does
  // not turn into a token of ninety days. Not with an API token, and, as on every route
  // without `phone`, not with a phone app's session.
  const websiteOnly = { token: false };
  // The customer site's accounts and who owns which board (docs/customer-site.md): for release
  // managers on the website, never from a phone app or with an API token.
  const customerAdmin = { token: false, phone: false };
  // Reading the team and the customers' list: release managers only, as above (each list asks Cognito
  // for a release manager now), from the website or from any of the apps; never with an API token.
  // Every change to them stays on the website (customerAdmin).
  const releaseManagerRead = { token: false };
  const customerChange = (action) => ({ action, maxBody: SMALL_BODY_LIMIT });
  // A member's SideStore link, like their API tokens: made and turned off on the website, by themselves.
  const websiteSession = { token: false, phone: false };
  // The Database page: a session of the website or of the apps, never an API token.
  const noTokens = { token: false };

  const routes = Object.freeze([
    route('GET', '/api/me', apps.withConsole(me.get)),
    // Each board with its position from Wi-Fi, if it has one (handlers/location.mjs).
    route('GET', '/api/devices', location.listed(devices.list)),
    route('GET', '/api/devices/{thing}', location.detailed(updates.withLastUpdate(devices.get))),
    // A new board, registered in AWS IoT from the certificate signing request it made (handlers/provision.mjs):
    // what tools/provision_device.py and scripts/new-board.sh do with a console token, so that setting up a
    // board needs no sign-in to the AWS account. Release managers, with a session on the website, an API
    // token, or the apps' sign-in, which the desktop app's Board setup uses: from the apps, after a sign-in in
    // the last 15 minutes, as any change from them. At most 20 an hour a person, and one over that leaves no entry.
    route('POST', '/api/devices/register', provision.register, {
      action: 'device.register',
      maxBody: SMALL_BODY_LIMIT,
      unrecordedCodes: ['rate_limited'],
    }),
    // The Wi-Fi network Board setup fills in by default (handlers/setup.mjs): a read for release managers only,
    // on record, never with an API token, never cached.
    route(
      'GET',
      '/api/setup/wifi-defaults',
      setup.wifiDefaults,
      { action: 'setup.wifi_defaults', maxBody: 0, read: true },
      { token: false }
    ),
    // What the boards did, and a board's readings: written by the recorder (recorder.mjs).
    route('GET', '/api/devices/{thing}/samples', events.samples),
    route('GET', '/api/devices/{thing}/timeline', timeline.board),
    route('GET', '/api/devices/{thing}/memfault', memfault.board),
    route('GET', '/api/memfault/fleet', memfault.fleet),
    route('GET', '/api/memfault/issues', memfault.issues),
    route('GET', '/api/memfault/issues/{id}', memfault.issue),
    route('GET', '/api/events', events.list),
    // What the boards printed on their serial consoles, from firmware 1.12.0 (lib/lines.mjs).
    route('GET', '/api/events/log', events.log),
    route('GET', '/api/firmware', firmware.list),
    route('POST', '/api/firmware', firmware.upload, { action: 'firmware.upload', maxBody: UPLOAD_BODY_LIMIT }),
    route('GET', '/api/firmware/{version}', firmware.get),
    // Reads, but each one is for release managers only and goes on record like a write:
    // the image a phone sends to a board over Bluetooth, and that board's passkey.
    route('GET', '/api/firmware/{version}/image', firmware.image, { action: 'firmware.download', maxBody: 0 }, atBoard),
    // A phone asks every few seconds until the board has a passkey, so an answer of "none yet" is
    // not recorded: only a passkey handed out, and a caller refused.
    route(
      'GET',
      '/api/pairing/{name}',
      pairing.get,
      { action: 'pairing.read', maxBody: 0, unrecorded: ['rejected'] },
      { token: false, atTheBoard: true }
    ),
    // What a phone asks right before every Bluetooth send, from whatever image it holds: is this
    // release, with this SHA-256, still active? It changes nothing, and goes on record like a
    // write, so that a send of an image the phone kept leaves a trace too.
    route(
      'POST',
      '/api/firmware/{version}/bluetooth',
      firmware.bluetooth,
      { action: 'firmware.bluetooth_send', maxBody: SMALL_BODY_LIMIT },
      atBoard
    ),
    route('POST', '/api/firmware/{version}/revoke', firmware.revoke, {
      action: 'firmware.revoke',
      maxBody: SMALL_BODY_LIMIT,
    }),
    // Golden image promotion (handlers/golden.mjs): a record signed offline for a release, and the job
    // that makes it the golden image on boards. Release managers only, on record, from the website only.
    route(
      'POST',
      '/api/firmware/{version}/golden',
      golden.uploadRecord,
      { action: 'firmware.golden_record', maxBody: SMALL_BODY_LIMIT },
      { token: false, phone: false }
    ),
    route('GET', '/api/golden/promotions', golden.list),
    route(
      'POST',
      '/api/golden/promotions',
      golden.promote,
      { action: 'golden.promote', maxBody: SMALL_BODY_LIMIT },
      { token: false, phone: false }
    ),
    // An update over the internet from the phone app too, and stopping one. From the phone a
    // deployment is to one board, and needs a sign-in in the last 15 minutes: see
    // deployments.create. Uploading and revoking stay on the website.
    route('GET', '/api/deployments', deployments.list),
    // Every update of every board, however it came: a deployment, over Bluetooth, by USB or another tool.
    route('GET', '/api/updates', updates.list),
    route('POST', '/api/deployments', deployments.create, { action: 'deployment.create', maxBody: SMALL_BODY_LIMIT }),
    route('GET', '/api/deployments/{id}', deployments.get),
    route('POST', '/api/deployments/{id}/cancel', deployments.cancel, {
      action: 'deployment.cancel',
      maxBody: SMALL_BODY_LIMIT,
    }),
    route('GET', '/api/audit', audit.list),
    // A person's own API tokens, from a signed-in session only: a token never makes or ends one.
    route('GET', '/api/tokens', tokens.list, null, websiteOnly),
    route('POST', '/api/tokens', tokens.create, { action: 'token.create', ...ownTokens }, websiteOnly),
    route('POST', '/api/tokens/{id}/revoke', tokens.revoke, { action: 'token.revoke', ...ownTokens }, websiteOnly),
    // Who changed a board at its serial console, posted by the page that drove it over USB. Like
    // the calls for Bluetooth, from a person at the board with a cable in hand, and after the
    // board has done it: a fresh sign-in asked of a phone would not undo the change, only keep it
    // off the record. A post over the limit leaves no entry (handlers/serial.mjs).
    route(
      'POST',
      '/api/serial/commands',
      serial.record,
      { action: 'serial.command', maxBody: SMALL_BODY_LIMIT, unrecordedCodes: ['rate_limited'] },
      atBoard
    ),
    // A board's name in the console (handlers/devices.mjs, lib/names.mjs): release managers, on record, and from a
    // phone with a sign-in in the last 15 minutes, as every change is.
    route('POST', '/api/devices/{thing}/label', devices.rename, { action: 'device.rename', maxBody: SMALL_BODY_LIMIT }),
    // A board's last 20 positions from Wi-Fi (handlers/location.mjs).
    route('GET', '/api/devices/{thing}/positions', location.positions),
    // A command to a board, now: identify (blink) or report (handlers/commands.mjs). Release managers
    // only. From a phone, identify is like the calls at a board, with no fresh sign-in asked for: it
    // blinks two LEDs and changes nothing. The handler asks one of report, which can be sent from
    // anywhere and costs a position estimate. A command over the limit leaves no entry.
    route(
      'POST',
      '/api/devices/{thing}/commands',
      commands.send,
      { action: 'board.command', maxBody: SMALL_BODY_LIMIT, unrecordedCodes: ['rate_limited'] },
      atBoard
    ),
    // E-mail alerts, on the Account page (handlers/alerts.mjs): a release manager's own address.
    route('GET', '/api/alerts', alerts.get),
    route('POST', '/api/alerts/subscribe', alerts.subscribe, { action: 'alert.subscribe', maxBody: SMALL_BODY_LIMIT }),
    route('POST', '/api/alerts/unsubscribe', alerts.unsubscribe, {
      action: 'alert.unsubscribe',
      maxBody: SMALL_BODY_LIMIT,
    }),
    // The alert rules (console 2.13.0): for release managers, on record with what changed.
    route('POST', '/api/alerts/rules', alerts.setRules, { action: 'alert.rules', maxBody: SMALL_BODY_LIMIT }),
    // The fleet (docs/fleet.md): board types and groups, staged rollouts, and how the fleet is doing.
    // Reads for every member; every change for release managers, on record, and from a phone only
    // with a sign-in in the last 15 minutes, as every change is.
    // The weekly fleet report (handlers/reports.mjs, docs/reports.md): every member reads it, and an export
    // goes on record as a read (`read`, `member`); only a release manager switches its Monday e-mail.
    route('GET', '/api/reports', reports.list),
    route('GET', '/api/reports/{week}', reports.get),
    route('GET', '/api/reports/{week}/export', reports.exportCsv, {
      action: 'report.export',
      maxBody: 0,
      read: true,
      member: true,
    }),
    route('POST', '/api/reports/settings', reports.setSettings, {
      action: 'report.settings',
      maxBody: SMALL_BODY_LIMIT,
    }),
    route('GET', '/api/fleet', fleet.overview),
    route('GET', '/api/fleet/health', fleet.health),
    route('GET', '/api/groups', groups.list),
    route('POST', '/api/groups', groups.create, { action: 'group.create', maxBody: SMALL_BODY_LIMIT }),
    route('POST', '/api/groups/{id}', groups.update, { action: 'group.update', maxBody: SMALL_BODY_LIMIT }),
    route('POST', '/api/groups/{id}/delete', groups.remove, { action: 'group.delete', maxBody: SMALL_BODY_LIMIT }),
    route('GET', '/api/rollouts', rollouts.list),
    route('POST', '/api/rollouts', rollouts.create, { action: 'rollout.create', maxBody: SMALL_BODY_LIMIT }),
    route('GET', '/api/rollouts/suggest', rollouts.suggest),
    route('GET', '/api/rollouts/{id}', rollouts.get),
    route('POST', '/api/rollouts/{id}/cancel', rollouts.cancel, {
      action: 'rollout.cancel',
      maxBody: SMALL_BODY_LIMIT,
    }),
    // Scheduled starts (console 2.20.0): a deployment, a staged rollout or a roll back to last good, started
    // later by the schedule with the same checks as by hand. Reads for every member; changes for release managers.
    route('GET', '/api/schedules', schedules.list),
    route('POST', '/api/schedules', schedules.create, { action: 'schedule.create', maxBody: SMALL_BODY_LIMIT }),
    route('POST', '/api/schedules/{id}', schedules.edit, { action: 'schedule.edit', maxBody: SMALL_BODY_LIMIT }),
    route('POST', '/api/schedules/{id}/cancel', schedules.cancel, {
      action: 'schedule.cancel',
      maxBody: SMALL_BODY_LIMIT,
    }),
    // "Update everything": for each board type its newest release, to every board of the type not on it.
    route('GET', '/api/fleet/update-everything', rollouts.everythingPlan),
    route('POST', '/api/fleet/update-everything', rollouts.everything, {
      action: 'fleet.update_everything',
      maxBody: SMALL_BODY_LIMIT,
    }),
    // "Roll back to last good" (console 2.14.0): each board of the fleet or of a group to its last good
    // version, one staged rollout per release, with the health gate on.
    route('GET', '/api/fleet/last-good', rollouts.lastGoodPlan),
    route('POST', '/api/fleet/last-good', rollouts.lastGood, {
      action: 'fleet.rollback_last_good',
      maxBody: SMALL_BODY_LIMIT,
    }),
    route('GET', '/api/groups/{id}/last-good', rollouts.lastGoodPlan),
    route('POST', '/api/groups/{id}/last-good', rollouts.lastGood, {
      action: 'fleet.rollback_last_good',
      maxBody: SMALL_BODY_LIMIT,
    }),
    // What a phone saw of a board over Bluetooth: how a board without Wi-Fi shows at all. Like the other
    // calls of a person at a board, no fresh sign-in; at most 60 a minute, and one over that leaves no entry.
    route(
      'POST',
      '/api/devices/{thing}/seen',
      fleet.seen,
      { action: 'device.seen', maxBody: SMALL_BODY_LIMIT, unrecordedCodes: ['rate_limited'] },
      atBoard
    ),
    // A release's note, changed after its upload: release managers, with a session or an API token
    // (scripts/release-notes.sh). Active and revoked releases alike (handlers/firmware.mjs).
    route('PUT', '/api/firmware/{version}/notes', firmware.notes, {
      action: 'firmware.notes',
      maxBody: SMALL_BODY_LIMIT,
    }),
    // The phone apps (handlers/apps.mjs). Reads for every member. Publishing an APK is two writes, for
    // release managers, with a session or an API token (apps/android/publish.sh): the URL to send it to
    // S3 with, then the check of what arrived. A download link is for every member, viewers too, and
    // goes on record; from a phone it is a read, with no fresh sign-in asked for.
    route('GET', '/api/apps', apps.list),
    route('GET', '/api/apps/config', apps.config),
    route('POST', '/api/apps/android/uploads', apps.startUpload, { action: 'app.upload', maxBody: SMALL_BODY_LIMIT }),
    route('POST', '/api/apps/android/releases/{version}', apps.publish, {
      action: 'app.publish',
      maxBody: SMALL_BODY_LIMIT,
    }),
    route('GET', '/api/apps/android/{version}/download', apps.download, {
      action: 'app.download',
      maxBody: 0,
      member: true,
      read: true,
    }),
    // The iPhone app's unsigned IPAs, the same way (apps/ios/scripts/publish.sh), for SideStore.
    route('POST', '/api/apps/ios/uploads', apps.startIosUpload, {
      action: 'app.ios_upload',
      maxBody: SMALL_BODY_LIMIT,
    }),
    route('POST', '/api/apps/ios/releases/{version}', apps.publishIos, {
      action: 'app.ios_publish',
      maxBody: SMALL_BODY_LIMIT,
    }),
    route('GET', '/api/apps/ios/{version}/download', apps.downloadIos, {
      action: 'app.ios_download',
      maxBody: 0,
      member: true,
      read: true,
    }),
    // A member's own SideStore source link (handlers/sidestore.mjs). What SideStore itself asks for is
    // under /api/sidestore/, with no sign-in, outside this table.
    route('GET', '/api/apps/sidestore', sidestore.get, null, websiteSession),
    route(
      'POST',
      '/api/apps/sidestore',
      sidestore.create,
      { action: 'app.source_create', ...ownTokens },
      websiteSession
    ),
    route(
      'POST',
      '/api/apps/sidestore/revoke',
      sidestore.revoke,
      { action: 'app.source_revoke', ...ownTokens },
      websiteSession
    ),
    // Customers of the customer site. The customer API itself is another function (customer/app.mjs).
    route('GET', '/api/customers', customers.list, null, releaseManagerRead),
    route('POST', '/api/customers', customers.create, customerChange('customer.create'), customerAdmin),
    route('POST', '/api/customers/{id}/resend', customers.resend, customerChange('customer.resend'), customerAdmin),
    route('POST', '/api/customers/{id}/boards', customers.assign, customerChange('customer.assign'), customerAdmin),
    route(
      'POST',
      '/api/customers/{id}/boards/{thing}/remove',
      customers.unassign,
      customerChange('customer.unassign'),
      customerAdmin
    ),
    route('POST', '/api/customers/{id}/disable', customers.disable, customerChange('customer.disable'), customerAdmin),
    route('POST', '/api/customers/{id}/enable', customers.enable, customerChange('customer.enable'), customerAdmin),
    route(
      'POST',
      '/api/customers/{id}/reset-password',
      customers.resetPassword,
      customerChange('customer.reset_password'),
      customerAdmin
    ),
    route('POST', '/api/customers/{id}/remove', customers.remove, customerChange('customer.remove'), customerAdmin),
    // The team's accounts (handlers/team.mjs, docs/accounts.md): for release managers on the website, as the
    // customers are; never from a phone app or with an API token.
    route('GET', '/api/team', team.list, null, releaseManagerRead),
    route('POST', '/api/team', team.invite, customerChange('account.invite'), customerAdmin),
    route('POST', '/api/team/{id}/resend', team.resend, customerChange('account.resend'), customerAdmin),
    route('POST', '/api/team/{id}/tier', team.tier, customerChange('account.tier'), customerAdmin),
    route('POST', '/api/team/{id}/disable', team.disable, customerChange('account.disable'), customerAdmin),
    route('POST', '/api/team/{id}/enable', team.enable, customerChange('account.enable'), customerAdmin),
    route('POST', '/api/team/{id}/reset', team.reset, customerChange('account.reset'), customerAdmin),
    route('POST', '/api/team/{id}/remove', team.remove, customerChange('account.remove'), customerAdmin),
    // The Database page (handlers/db.mjs): the console's DynamoDB tables, read only, never a secret field.
    // Release managers, asked of Cognito now, on the website or in the apps; never with an API token. An
    // export goes on record like a write, and needs no fresh sign-in from the apps: it changes nothing.
    route('GET', '/api/db/tables', db.tables, null, noTokens),
    route('GET', '/api/db/{table}', db.list, null, noTokens),
    route('GET', '/api/db/{table}/item', db.item, null, noTokens),
    route('GET', '/api/db/{table}/export', db.exportItems, { action: 'db.export', maxBody: 0, read: true }, noTokens),
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
    if (!request.viaToken) {
      await context.directory.requireLiveReader(caller, request.id);
      request.signIn = signInOf(caller, request.id);
    }
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
    const { action, maxBody, unrecorded = [], unrecordedCodes = [] } = found.route.write;
    // The handler fills these in as it learns what the request is about.
    // `changes` is what the request changed, before and after (lib/audit.mjs change()).
    const entry = { target: '', detail: {}, changes: [] };
    const actor = { sub: request.viaToken ? '' : claimedSub(event), email: '' };
    let result = null;
    let failure = null;
    try {
      result = await withinDeadline(
        request,
        async () => {
          const known = await identify(found, event, request);
          const { caller } = known;
          // A read that goes on record (`read`) is no change: it needs no fresh sign-in either.
          if (caller.clientId === config.mobileClientId && !found.route.atTheBoard && found.route.write.read !== true) {
            requireFreshSignIn(caller, clock());
          }
          actor.email = await liveWriter(found, request, known);
          if (!request.viaToken) request.signIn = signInOf(caller, request.id);
          return found.route.run({
            caller,
            actor: { sub: caller.sub, email: actor.email },
            params: found.params,
            query: queryOf(event),
            entry,
            json: () => readJsonObject(event, maxBody),
          });
        },
        'The server ran out of time. The change may have been made in part or in full: ' +
          'check the result before you repeat it.'
      );
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
    if (failure !== null && (unrecorded.includes(outcome) || unrecordedCodes.includes(errorCode(failure))))
      throw failure;
    const recorded = await audit.record({
      at: clock(),
      requestId: request.id,
      actor: { sub, email },
      action,
      target,
      outcome,
      detail,
      changes: [...entry.changes],
    });
    if (failure !== null) throw failure;
    if (!recorded) {
      throw new HttpError(
        500,
        'audit_failed',
        'The change was made, but it could not be written to ' +
          'the activity log. Check the result before you repeat it.'
      );
    }
    return result;
  }

  /**
   * The sign-in a session's token comes from: { sub, authTime, client }, or null if it does not
   * say, or if the request was made up by one of this project's own scripts (SCRIPTED).
   */
  function signInOf(caller, requestId) {
    if (SCRIPTED.test(requestId)) return null;
    if (!Number.isSafeInteger(caller.authTime) || caller.authTime <= 0) return null;
    if (caller.clientId === config.userPoolClientId)
      return { sub: caller.sub, authTime: caller.authTime, client: 'web' };
    if (caller.clientId === config.mobileClientId)
      return { sub: caller.sub, authTime: caller.authTime, client: 'phone' };
    return null;
  }

  // The sign-ins this instance has recorded, or is recording, as "<sub> <auth_time> <client>".
  const signInsSeen = new Set();

  /** Record a sign-in, once (see the top of this file). Never throws, and gives up after SIGN_IN_WAIT_MS. */
  async function noteSignIn(signIn, requestId) {
    const key = `${signIn.sub} ${signIn.authTime} ${signIn.client}`;
    if (signInsSeen.has(key)) return;
    const id = signInRequestId(signIn);
    if (id === null) return;
    if (signInsSeen.size >= SIGN_INS_KEPT) signInsSeen.clear();
    signInsSeen.add(key);
    let timer = null;
    const late = new Promise((resolve) => {
      timer = timers.set(() => resolve('late'), SIGN_IN_WAIT_MS);
    });
    const recording = (async () => {
      const email = context.directory.knownEmail(signIn.sub) || (await context.directory.emailOf(signIn.sub));
      return audit.recordOnce({
        at: signIn.authTime * 1000,
        requestId: id,
        actor: { sub: signIn.sub, email },
        action: 'account.sign_in',
        target: '',
        outcome: 'ok',
        detail: { client: signIn.client },
      });
    })().catch(() => 'failed');
    const result = await Promise.race([recording, late]).finally(() => timers.clear(timer));
    // Not on record, as far as this instance knows: the next request of this sign-in tries again.
    if (result !== 'stored' && result !== 'exists') {
      signInsSeen.delete(key);
      log({ level: 'warn', event: 'sign_in_unrecorded', requestId, sub: signIn.sub, why: result });
    }
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
    const viaSource = isSourcePath(method, segments);
    const found = viaSource ? null : findRoute(routes, method, viaToken ? ['api', ...segments.slice(2)] : segments);
    // `sub` is filled in once the caller is identified, which for an API token means a token
    // that is active, and `token` ({ id, status }) once an API token is found at all.
    const request = {
      id: requestId,
      sub: null,
      viaToken,
      token: null,
      budget: budgetOf(invocation),
      timedOut: false,
      signIn: null,
      // For SideStore's requests: the route's name and the key's id, once known (handlers/sidestore.mjs).
      routeName: null,
      source: null,
    };

    let response;
    try {
      let result;
      if (viaSource) {
        result = await withinDeadline(
          request,
          () => sidestore.serve({ segments, request }),
          'The server ran out of time. Try again in a moment.'
        );
      } else if (found !== null && found.route.write !== null) {
        result = await write(found, event, request);
      } else {
        result = await withinDeadline(
          request,
          () => read(found, event, request),
          'The server ran out of time. Try again in a moment.'
        );
      }
      if (result.response !== undefined) response = result.response;
      else if (result.file !== undefined) response = binary(result.status ?? 200, result.file.data, result.file.name);
      else response = json(result.status ?? 200, result.body);
    } catch (error) {
      const failed = errorResponse(error, requestId);
      if (failed.internal !== null) {
        log({ level: 'error', event: 'request_failed', requestId, error: failed.internal });
      }
      response = failed.response;
    }

    // A request that ran out of time has none left to spare.
    if (request.signIn !== null && !request.timedOut) await noteSignIn(request.signIn, requestId);

    const line = {
      requestId,
      sub: request.sub,
      method,
      route: viaSource
        ? (request.routeName ?? 'GET /api/sidestore/unmatched')
        : found === null
          ? 'unmatched'
          : found.route.name,
      status: response.statusCode,
      duration: clock() - started,
    };
    // Which token, by its id: never the token, never its digest. And whether it was revoked
    // or expired: such a request leaves no entry in the activity log, so this line is its trace.
    if (viaToken) Object.assign(line, { via: 'token', token: request.token?.id ?? null });
    if (viaToken && request.token !== null && request.token.status !== 'active') line.tokenState = request.token.status;
    // Which SideStore source, by its id: never the key. Null for a key that is not live.
    if (viaSource) Object.assign(line, { via: 'sidestore', source: request.source });
    log(line);
    return response;
  };
}
