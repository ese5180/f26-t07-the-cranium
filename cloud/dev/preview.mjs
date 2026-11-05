/**
 * Local preview of the firmware console.
 *
 * It serves the real web console (web/src/server.mjs) and the real API
 * (api/src/app.mjs) on a loopback address, with the API wired to the in-memory
 * stand-in for AWS that the tests use (api/test/fake-aws.mjs). Nothing here talks to
 * AWS, and nothing here is packaged or deployed: it is a development tool for looking
 * at the console and trying its flows.
 *
 *   node cloud/dev/preview.mjs [--scenario <name>] [--viewer] [--live] [--port <number>]
 *                              [--repeated-cancel <refused|accepted|ignored>] [--home] [--customer]
 *
 * What stands in for the parts that are AWS in production:
 *
 *   API Gateway    The routes of the HTTP API and its JWT authorizer. A request to
 *                  /api/ needs the access token that the sign-in below issued, and
 *                  reaches the API function as the event the gateway would build. A
 *                  request to /api/t/ goes to the function with no authorizer, as
 *                  deployed: it carries a personal API token, made on the console's API
 *                  tokens page, which the function checks. What no route claims goes to
 *                  the web function, as it does when deployed.
 *   Cognito        Two parts, served on the next port, so that they are another origin
 *                  as in production. The user pool API that the console's own sign-in
 *                  page talks to: InitiateAuth with SRP and the step of the code, played
 *                  by web/test/cognito.mjs, with the real sign-in trigger
 *                  (api/src/signin-scope.mjs) deciding the scopes of the token. It knows
 *                  the two local users, by address, with the password and the code that
 *                  the preview prints. And the four addresses of the managed login that
 *                  the console uses for "Use the AWS sign-in page": /oauth2/authorize,
 *                  /oauth2/token, /oauth2/revoke and /logout. That has no page and no
 *                  password: "authorize" signs in the local release manager (--viewer: the
 *                  local viewer) at once. The console's own sign-in code runs unchanged
 *                  both ways: SRP, the code, state, PKCE, token request, revocation.
 *   AWS IoT, S3,   api/test/fake-aws.mjs, which starts empty. AWS does not document
 *   DynamoDB       what a forced cancellation does to a deployment that was cancelled
 *                  before, without force, and still has a board at work. The stand-in
 *                  refuses it; --repeated-cancel makes it accept the call and stop
 *                  the board ("accepted"), or accept it and change nothing
 *                  ("ignored"), so that the console can be seen in all three cases.
 *   The boards     A model of what the firmware does (firmware/app/src/ota.c): it
 *                  writes its shadow and answers its job through the device helpers
 *                  of the stand-in. Its download fails once the image is revoked, as
 *                  it does when the bucket refuses a revoked image.
 *
 * The preview starts empty, or in the state a scenario built (--scenario <name>). A
 * scenario gets there the way a team would: boards are registered as the provisioning
 * tool registers them, and every upload, deployment and revocation is a request to
 * the real API handler. The firmware images are the fixtures of the API tests, and
 * the configured signing key is the fixture key they are signed with.
 *
 * Boards stay where the scenario left them and only keep reporting that they are
 * alive. With --live they act like boards: they pick up a new offer, notice a
 * cancellation, carry a started update through, and take their two buttons from the
 * terminal.
 *
 * While a scenario's time goes by, a board that is on reports a heartbeat every minute, and
 * one with a diagnostics report sends it every 5 minutes. Everything a board reports, and
 * each connection and disconnection, goes through the recorder of the Events page as the
 * AWS IoT rules would hand it over (api/test/fake-aws.mjs), so that the Events and
 * Diagnostics pages have a history to show. The "fleet" scenario has one of each kind, and its
 * board on firmware 1.12.0 also sends lines of its board log (AWS IoT's third rule), a sign-in
 * of the release manager and a change made at that board's serial console are in its activity log.
 * It also has the Android app's last two versions on the Apps page, published as a build publishes
 * them: the presigned URLs the API hands out for an APK point at a stand-in for S3 on the console's own
 * address (/local-s3/, api/test/fake-apps.mjs), which checks them as S3 does. In every scenario the
 * console's version and the changelogs are this checkout's (web/build-versions.mjs), served as
 * versions.json where the site has none, as cloud/deploy.sh would write it.
 * A sign-in on the preview's own page is recorded as one, as it is when deployed.
 *
 * The fleet scenario also puts boards on the Map page: the boards on 1.13.0 send what they hear of the
 * Wi-Fi, and a stand-in for AWS IoT Core Device Location that knows where the access points of a campus
 * are (made-up addresses, of the range kept for documentation) places them; one is carried 1.6 km to a
 * demo, and one hears too few. The boards on 1.13.0 answer the console's commands in their log. The
 * e-mail alerts are made as when deployed, and listed on the Account page; none is sent anywhere.
 *
 * The fleet scenario also has two nRF5340 DKs, which have no Wi-Fi and are only ever seen by a phone,
 * groups of boards, and a staged rollout whose canary has confirmed and whose waves are under way.
 * Its images are made by api/test/images.mjs for either board type and signed with a key made for
 * the run, which that scenario's console trusts in place of the fixtures' key: the fixtures' own
 * key is gone, and an image for the nRF5340 DK has to be signed. The schedule that moves staged
 * rollouts on (api/src/tick.mjs) runs every minute, as EventBridge runs it when deployed.
 *
 * The page is the one that is deployed. Nothing in web/ knows about the preview. With
 * --home the requests carry a host name that is on the web function's list of home page
 * names, so that the public home page is served by the same routing as when deployed. With
 * --customer they carry the customer site's name instead (docs/customer-site.md): the site at
 * /, the console as admin mode at /admin, the customer API behind a stand-in for the customer
 * pool's authorizer, and a stand-in for the customer pool beside the staff pool's
 * (web/test/customer-cognito.mjs). The "customers" scenario gives it customers and boards.
 *
 * No dependencies.
 */

import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIPv4 } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createApp } from '../api/src/app.mjs';
import { loadConfig } from '../api/src/config.mjs';
import { createRolloutTick } from '../api/src/tick.mjs';
import { createCustomerApp } from '../api/src/customer/app.mjs';
import { issuerOf } from '../api/src/customer/config.mjs';
import { compareVersions, parseVersion } from '../api/src/lib/mcuboot.mjs';
import { withConsoleScope } from '../api/src/signin-scope.mjs';
import { parseBundledVersions } from '../api/src/lib/versions.mjs';
import { accessClaims, createFakeAws, fakeEnv, fixture } from '../api/test/fake-aws.mjs';
import {
  CUSTOMER_CLIENT_ID, CUSTOMER_POOL_ID, createFakeCustomers, customerClaims,
} from '../api/test/fake-customers.mjs';
import { buildImage, imageKey, keyEnv } from '../api/test/images.mjs';
import { buildVersions } from '../web/build-versions.mjs';
import { createWebHandler } from '../web/src/server.mjs';
import { createCognito } from '../web/test/cognito.mjs';
import { createCustomerCognito } from '../web/test/customer-cognito.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;

// As deployed (infra/template.yaml): the scopes of the app client, the scope the API
// route demands, and how long an access token is valid. Cognito keeps an
// authorization code for five minutes.
const CLIENT_SCOPES = Object.freeze(['openid', 'cranium/console']);
const API_SCOPE = 'cranium/console';
const TOKEN_SECONDS = 3600;
const CODE_SECONDS = 300;

const WEB_ROOT = 'GET /';
const WEB_ASSETS = 'GET /assets/{proxy+}';
const WEB_DEFAULT = '$default';
const API_READ = 'GET /api/{proxy+}';
const API_WRITE = 'POST /api/{proxy+}';
// API tokens: no authorizer; the function checks the token (api/src/handlers/tokens.mjs).
const API_TOKEN_READ = 'GET /api/t/{proxy+}';
const API_TOKEN_WRITE = 'POST /api/t/{proxy+}';
// A release's note is replaced with PUT, through a route of each kind (infra/template.yaml).
const API_PUT = 'PUT /api/{proxy+}';
const API_TOKEN_PUT = 'PUT /api/t/{proxy+}';
// The customer API: its own function, behind the authorizer of the customer pool (docs/customer-site.md).
const API_CUSTOMER_READ = 'GET /api/c/{proxy+}';
// How often the schedule moves staged rollouts on, as deployed.
const ROLLOUT_TICK_MS = 60_000;
// The key the fleet scenario's images are signed with (see the top of this file).
const FLEET_KEY = imageKey();

// What the requests of --home are addressed to. A reserved domain: it can never exist.
const HOME_HOST = 'home.preview.invalid';
// And those of --customer: the customer site, with the console as admin mode under /admin.
const CUSTOMER_HOST = 'customer.preview.invalid';

// The largest request an HTTP API accepts, and far more than a sign-in form needs.
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_FORM_BYTES = 16 * 1024;
// What S3 takes in one PUT is far more; the Android app's APK is about 12 MB (cloud/api/src/lib/apps.mjs).
const MAX_APK_BYTES = 100 * 1024 * 1024;

// API Gateway hands a body to the function as text when its content type is a text
// type, and base64 encoded otherwise. The API reads both.
const TEXT_BODY = /^(?:text\/|application\/(?:json|xml|javascript)\b|application\/[\w.-]+\+(?:json|xml)\b)/i;
const FORM_BODY = /^application\/x-www-form-urlencoded\b/i;

// PKCE (RFC 7636): an S256 challenge is 43 characters, a verifier 43 to 128.
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

// What the console's own sign-in page takes in the preview, for both local users. Made up
// for the preview, printed when it starts, and good nowhere else.
export const PREVIEW_PASSWORD = 'preview-password';
export const PREVIEW_CODE = '123456';
// The customers' of the "customers" scenario: the password of the two who have signed in before,
// and the temporary one in the third's invitation, which works once.
export const PREVIEW_CUSTOMER_PASSWORD = 'preview-customer';
export const PREVIEW_TEMPORARY_PASSWORD = 'preview-temporary';
// Cognito's user pool API: one address, the operation in a header.
const IDP_JSON = 'application/x-amz-json-1.1';
const IDP_TARGET = /^AWSCognitoIdentityProviderService\.(\w+)$/;
// What a token made through the user pool API carries before the sign-in trigger.
const USER_POOL_API_SCOPES = Object.freeze(['aws.cognito.signin.user.admin']);

// The firmware's heartbeat comes every 30 s, and a board counts as online for 90 s after one
// (240 s if it says that it is restarting).
const HEARTBEAT_MS = 30_000;
// A board left to itself (--live): ten percent of the download every two seconds,
// and twelve seconds for the restart into the new firmware.
const LIVE_TICK_MS = 1000;
// While a scenario's time goes by: a heartbeat a minute, a diagnostics report every five.
const PASSING_HEARTBEAT_MS = 60_000;
// How often the alerts are checked, as EventBridge runs the check when deployed (AlertCheckRule).
const ALERT_CHECK_MS = 5 * 60_000;
const DIAG_MS = 5 * 60_000;
const LIVE_SECONDS_PER_STEP = 2;
const LIVE_RESTART_SECONDS = 12;

// What the stand-in can do with a forced cancellation of a deployment that is
// cancelled already (api/test/fake-aws.mjs). The first is what it does by default.
const REPEATED_CANCEL = Object.freeze(['refused', 'accepted', 'ignored']);

// A reserved domain that can never receive mail. The addresses exist only here.
const MAIL_DOMAIN = 'preview.invalid';

const USERS = Object.freeze({
  manager: Object.freeze({
    sub: '00000000-0000-4000-8000-000000000001',
    email: `manager@${MAIL_DOMAIN}`,
    groups: Object.freeze(['release-managers']),
    role: 'release manager',
  }),
  viewer: Object.freeze({
    sub: '00000000-0000-4000-8000-000000000002',
    email: `viewer@${MAIL_DOMAIN}`,
    groups: Object.freeze(['viewers']),
    role: 'viewer',
  }),
});

/** Something wrong with how the preview was started. The message is for the terminal. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * The preview has no real sign-in: whoever can reach it is a release manager. It
 * therefore listens on a loopback address and refuses any other.
 */
function requireLoopback(host) {
  if (typeof host !== 'string' || !isIPv4(host) || !host.startsWith('127.')) {
    throw new UsageError(`The preview only listens on a loopback address (127.x.x.x), not on "${host}": ` +
      'it has no real sign-in and must not be reachable from another computer.');
  }
}

/**
 * The preview's clock: the system clock, set back while a scenario is built, so that
 * what the scenario did lies in the hours before the preview started.
 */
function createClock(system) {
  let offset = 0;
  let latest = -Infinity;
  return {
    now: () => system() + offset,
    /**
     * Jump to `at` (epoch milliseconds, not in the future). The first jump goes back
     * to where the scenario begins; from there on time only moves forward.
     */
    moveTo(at) {
      if (at < latest) throw new RangeError('A scenario may only move forward in time');
      latest = at;
      offset = Math.min(0, at - system());
    },
    present() {
      offset = 0;
    },
  };
}

// Requests and responses.

/** The request target as path and query string, exactly as they were sent. */
function splitTarget(target) {
  const mark = target.indexOf('?');
  return mark === -1 ? [target, ''] : [target.slice(0, mark), target.slice(mark + 1)];
}

/** The whole request body, or null if it is larger than `limit` bytes. */
async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(response, status, headers, body = '') {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  response.writeHead(status, { ...headers, 'content-length': bytes.length });
  response.end(bytes);
}

/** An answer of the gateway itself, in the form API Gateway gives its own answers. */
function sendGateway(response, status, message, headers = {}) {
  send(response, status, { 'content-type': 'application/json', ...headers }, JSON.stringify({ message }));
}

/** Send what a function returned, as API Gateway does. */
function sendResult(response, result) {
  const encoding = result.isBase64Encoded === true ? 'base64' : 'utf8';
  send(response, result.statusCode, result.headers ?? {}, Buffer.from(String(result.body ?? ''), encoding));
}

/**
 * The event API Gateway builds for a function (payload format 2.0), without the parts
 * that neither function reads, such as the account and the time.
 */
function gatewayEvent({ routeKey, method, path, query, headers, host, body = null, claims = null }) {
  const event = {
    version: '2.0',
    routeKey,
    rawPath: path,
    rawQueryString: query,
    headers,
    requestContext: {
      domainName: host,
      http: {
        method, path, protocol: 'HTTP/1.1', sourceIp: DEFAULT_HOST, userAgent: headers['user-agent'] ?? '',
      },
      // An id of the kind API Gateway gives each request.
      requestId: randomBytes(11).toString('base64'),
      routeKey,
      stage: '$default',
    },
    isBase64Encoded: false,
  };
  if (query !== '') {
    // One value per name; a name given twice has its values joined by a comma.
    const parameters = new Map();
    for (const [name, value] of new URLSearchParams(query)) {
      parameters.set(name, parameters.has(name) ? `${parameters.get(name)},${value}` : value);
    }
    event.queryStringParameters = Object.fromEntries(parameters);
  }
  if (claims !== null) event.requestContext.authorizer = { jwt: { claims, scopes: [API_SCOPE] } };
  if (body !== null && body.length > 0) {
    const text = TEXT_BODY.test(headers['content-type'] ?? '');
    event.body = body.toString(text ? 'utf8' : 'base64');
    event.isBase64Encoded = !text;
  }
  return event;
}

// Sign-in: the part of Cognito's managed login that the console uses.

/**
 * @param {object} options
 * @param {string} options.clientId        the app client the console signs in with
 * @param {string} options.userPoolId      the user pool, for the user pool API and its SRP
 * @param {object} options.user            whom the managed login signs in
 * @param {() => string} options.host      host and port this stand-in is addressed by
 * @param {() => string} options.consoleOrigin  the origin that may read the replies
 * @param {() => string} options.redirectUri    the registered callback and sign-out address
 * @param {() => number} options.now       the clock, epoch milliseconds
 * @param {object} [options.customerPool]  the customer pool's user pool API (web/test/customer-cognito.mjs):
 *                                         Cognito answers both pools at one address, told apart by the
 *                                         client, or by the access token of a customer's own call
 */
function createSignIn({ clientId, userPoolId, user, host, consoleOrigin, redirectUri, now, customerPool = null }) {
  const codes = new Map();          // code -> { challenge, scopes, expiresAt }
  const sessions = new Map();       // access token -> { scopes, expiresAt, user }
  const refreshTokens = new Set();

  const seconds = () => Math.floor(now() / 1000);
  const secret = () => randomBytes(32).toString('base64url');
  const sealed = Object.freeze({
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  });

  function forget() {
    for (const [code, grant] of codes) if (grant.expiresAt <= seconds()) codes.delete(code);
    for (const [token, session] of sessions) if (session.expiresAt <= seconds()) sessions.delete(token);
  }

  function page(response, status, text) {
    send(response, status, { ...sealed, 'content-type': 'text/plain; charset=utf-8' }, `${text}\n`);
  }

  function redirect(response, location) {
    send(response, 302, { ...sealed, location });
  }

  /**
   * An answer to the console's script, which runs on another origin and may read it:
   * like Cognito, the stand-in names the console's origin as the one that is allowed.
   */
  function reply(response, status, body) {
    send(response, status, {
      ...sealed,
      'content-type': 'application/json;charset=UTF-8',
      'access-control-allow-origin': consoleOrigin(),
      vary: 'origin',
    }, body === null ? '' : JSON.stringify(body));
  }

  function authorize(response, query) {
    const ask = new URLSearchParams(query);
    // An unknown client or return address gets an error page, as with Cognito: the
    // browser is never sent to an address that was not registered.
    if (ask.get('client_id') !== clientId || ask.get('redirect_uri') !== redirectUri()) {
      page(response, 400, 'This sign-in request does not name the console of this preview.');
      return;
    }
    const state = ask.get('state');
    const back = (fields) => redirect(response, `${redirectUri()}?${new URLSearchParams(fields)}`);
    const refuse = (error) => back(state === null ? { error } : { error, state });

    if (ask.get('response_type') !== 'code') {
      refuse('unsupported_response_type');
      return;
    }
    const scopes = (ask.get('scope') ?? '').split(' ').filter((scope) => scope !== '');
    if (scopes.length === 0 || scopes.some((scope) => !CLIENT_SCOPES.includes(scope))) {
      refuse('invalid_scope');
      return;
    }
    // Stricter than Cognito, which also takes a request without them: the console
    // must always send a state and an S256 challenge.
    const challenge = ask.get('code_challenge') ?? '';
    if (!state || ask.get('code_challenge_method') !== 'S256' || !CHALLENGE.test(challenge)) {
      refuse('invalid_request');
      return;
    }

    // No sign-in page: the one user of the preview is signed in at once.
    forget();
    const code = secret();
    codes.set(code, { challenge, scopes, expiresAt: seconds() + CODE_SECONDS });
    back({ code, state });
  }

  function token(response, form) {
    if (form.get('grant_type') !== 'authorization_code') {
      reply(response, 400, { error: 'unsupported_grant_type' });
      return;
    }
    if (form.get('client_id') !== clientId) {
      reply(response, 400, { error: 'invalid_client' });
      return;
    }
    const code = form.get('code') ?? '';
    const grant = codes.get(code);
    // A code is good for one attempt, whatever comes of it.
    codes.delete(code);
    const verifier = form.get('code_verifier') ?? '';
    const proven = grant !== undefined && VERIFIER.test(verifier) &&
      createHash('sha256').update(verifier).digest('base64url') === grant.challenge;
    if (!proven || grant.expiresAt <= seconds() || form.get('redirect_uri') !== redirectUri()) {
      reply(response, 400, { error: 'invalid_grant' });
      return;
    }

    forget();
    const accessToken = secret();
    const refreshToken = secret();
    // When the person signed in, as the token's auth_time says: what the activity log records a sign-in by.
    sessions.set(accessToken, { scopes: grant.scopes, expiresAt: seconds() + TOKEN_SECONDS, user, authTime: seconds() });
    refreshTokens.add(refreshToken);
    // Cognito answers with these five. The console wants only the access token.
    reply(response, 200, {
      id_token: secret(),
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: TOKEN_SECONDS,
      token_type: 'Bearer',
    });
  }

  function revoke(response, form) {
    if (form.get('client_id') !== clientId) {
      reply(response, 400, { error: 'invalid_client' });
      return;
    }
    // The access token stays good at the gateway, as in production: a JWT authorizer
    // checks signature and expiry and never asks Cognito about revocation.
    refreshTokens.delete(form.get('token') ?? '');
    reply(response, 200, null);
  }

  function signOut(response, query) {
    const ask = new URLSearchParams(query);
    if (ask.get('client_id') !== clientId || ask.get('logout_uri') !== redirectUri()) {
      page(response, 400, 'This sign-out request does not name the console of this preview.');
      return;
    }
    redirect(response, redirectUri());
  }

  // The user pool API, for the console's own sign-in page.

  /**
   * A token made at the end of a sign-in through the user pool API. Its scopes are what
   * Cognito would give it after the real sign-in trigger has had its say.
   */
  function issue(person) {
    const event = withConsoleScope({
      version: '2',
      triggerSource: 'TokenGeneration_Authentication',
      region: userPoolId.split('_')[0],
      userPoolId,
      userName: person.userId,
      callerContext: { awsSdkVersion: 'aws-sdk-unknown-unknown', clientId },
      request: {
        userAttributes: { sub: person.userId, email: person.email, email_verified: 'true' },
        groupConfiguration: { groupsToOverride: [...person.groups], iamRolesToOverride: [], preferredRole: null },
        scopes: [...USER_POOL_API_SCOPES],
      },
      response: { claimsAndScopeOverrideDetails: null },
    }, clientId);
    const change = event.response.claimsAndScopeOverrideDetails?.accessTokenGeneration ?? {};
    const scopes = [...new Set([
      ...USER_POOL_API_SCOPES.filter((scope) => !(change.scopesToSuppress ?? []).includes(scope)),
      ...(change.scopesToAdd ?? []),
    ])];
    forget();
    const accessToken = secret();
    const refreshToken = secret();
    sessions.set(accessToken, { scopes, expiresAt: seconds() + TOKEN_SECONDS, user: person.local, authTime: seconds() });
    refreshTokens.add(refreshToken);
    return { AccessToken: accessToken, ExpiresIn: TOKEN_SECONDS, RefreshToken: refreshToken, IdToken: secret() };
  }

  const userPool = createCognito({
    userPoolId,
    clientId,
    users: Object.values(USERS).map((local) => ({
      email: local.email, userId: local.sub, password: PREVIEW_PASSWORD, code: PREVIEW_CODE, groups: local.groups, local,
    })),
    now,
    issue,
  });

  /** CORS, as Cognito's user pool API allows the console's page to call it. */
  const crossOrigin = () => ({ 'access-control-allow-origin': consoleOrigin(), vary: 'origin' });

  function preflight(response) {
    send(response, 204, {
      ...sealed,
      ...crossOrigin(),
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type, x-amz-target, x-amz-user-agent',
      'access-control-max-age': '600',
    });
  }

  async function userPoolApi(request, response) {
    const target = IDP_TARGET.exec(String(request.headers['x-amz-target'] ?? ''));
    const body = request.headers['content-type'] === IDP_JSON ? await readBody(request, MAX_FORM_BYTES) : null;
    let call = null;
    try {
      call = target && body !== null ? JSON.parse(body.toString('utf8')) : null;
    } catch {
      call = null;
    }
    const operation = target?.[1];
    const ofCustomer = customerPool !== null && call !== null && typeof call === 'object' &&
      (call.ClientId === CUSTOMER_CLIENT_ID || (call.ClientId === undefined && typeof call.AccessToken === 'string'));
    let reply;
    if (call === null || typeof call !== 'object') {
      reply = { status: 400, body: { __type: 'SerializationException', message: 'Unreadable request.' } };
    } else if (ofCustomer) {
      reply = customerPool.answer(operation, call);
    } else if (operation === 'RevokeToken' && call.ClientId === clientId) {
      // The admin sign-in of the customer site revokes its refresh token through this API.
      refreshTokens.delete(String(call.Token ?? ''));
      reply = { status: 200, body: {} };
    } else {
      reply = userPool.answer(operation, call);
    }
    const { status, body: answer } = reply;
    // Its own clock in the Date header, as Cognito's answers carry Cognito's.
    send(response, status, {
      ...sealed, ...crossOrigin(), 'content-type': IDP_JSON, date: new Date(now()).toUTCString(),
    }, JSON.stringify(answer));
  }

  return {
    async handle(request, response) {
      // Only requests addressed to this origin: a page elsewhere that points a host
      // name of its own at the loopback address is turned away.
      if (request.headers.host !== host()) {
        page(response, 403, 'Forbidden');
        return;
      }
      const [path, query] = splitTarget(request.url ?? '');
      const { method } = request;
      if (method === 'OPTIONS' && path === '/') {
        preflight(response);
      } else if (method === 'POST' && path === '/') {
        await userPoolApi(request, response);
      } else if (method === 'GET' && path === '/oauth2/authorize') {
        authorize(response, query);
      } else if (method === 'GET' && path === '/logout') {
        signOut(response, query);
      } else if (method === 'POST' && (path === '/oauth2/token' || path === '/oauth2/revoke')) {
        const body = FORM_BODY.test(request.headers['content-type'] ?? '')
          ? await readBody(request, MAX_FORM_BYTES)
          : null;
        if (body === null) {
          reply(response, 400, { error: 'invalid_request' });
          return;
        }
        const form = new URLSearchParams(body.toString('utf8'));
        if (path === '/oauth2/token') token(response, form);
        else revoke(response, form);
      } else {
        page(response, 404, 'Not found');
      }
    },

    /** The session an access token stands for, or null if it is unknown or has expired. */
    session(accessToken) {
      const session = sessions.get(accessToken);
      return session !== undefined && session.expiresAt > seconds() ? session : null;
    },

    /** How many refresh tokens were handed out and not revoked. The console leaves none. */
    refreshTokensLeft: () => refreshTokens.size,
  };
}

// Boards.

/** A name that looks like a real one and is the same on every run. */
function previewId(what, length) {
  return createHash('sha256').update(`cranium preview ${what}`).digest('hex').slice(0, length);
}

/**
 * A board, as far as the console can tell one from the outside. It does what firmware
 * before 1.7.2 does, which is what these boards run (firmware/app/src/ota.c with
 * CONFIG_APP_OTA_REQUIRE_USER_CONSENT on): it reports its state to its shadow on every
 * change, keeps an offered update queued until Button 1 is pressed, and asks AWS IoT
 * before it downloads and again before it installs.
 *
 * @param {object} fake      the stand-in for AWS; its device helpers are the board's side
 * @param {string} thing     the thing name
 * @param {string} version   the firmware the board was flashed with
 * @param {(text: string) => void} say   told what the board does, for the terminal
 */
function createBoard(fake, thing, version, say) {
  const board = {
    thing, version, powered: false, state: 'idle', job: null, target: null, progress: 0,
    last: 'none', error: '', rssi: -52,
    // What later firmware reports beside the heartbeat (firmware/README.md); none by default.
    stuck: null, diag: null, diary: null, bt: null,
    // How the signal and the heap move while time goes by: (board, at) => void, or null.
    wander: null,
  };
  let lastDiag = -Infinity;
  let secondsInState = 0;
  // The object the offered image is stored under, from the job document.
  let imageKey = null;

  /** True if the bucket would refuse the image now: its release was revoked. */
  function imageRefused() {
    return fake.objects.get(imageKey)?.tags.revoked === 'true';
  }

  /** The whole reported document, as the firmware sends it every time. */
  function report(extra) {
    fake.device(thing).report({
      fw: { version: board.version, confirmed: true },
      // AWS IoT deletes a key whose value is null, so an idle board has no ota.job.
      ota: {
        state: board.state, job: board.job, progress: board.progress, last: board.last, error: board.error,
      },
      wifi: { rssi: board.rssi },
      ...(board.stuck === null ? {} : { stuck: board.stuck }),
      ...extra,
    });
  }

  /** What the firmware sends on reaching the cloud, after its heartbeat. */
  function reportOnConnecting() {
    if (board.diag !== null) report({ diag: board.diag });
    if (board.diary !== null) report({ diary: board.diary });
    if (board.bt !== null) report({ bt: board.bt });
  }

  function enter(state) {
    board.state = state;
    secondsInState = 0;
  }

  /** Back to idle, remembering how the last update ended. */
  function settle(last, error) {
    enter('idle');
    board.job = null;
    board.target = null;
    board.progress = 0;
    board.last = last;
    board.error = error;
    report();
  }

  /** Send a job update. True if AWS IoT accepted it. */
  function update(status, details) {
    return fake.execution(board.job, thing).update(status, details).accepted;
  }

  /**
   * Ask AWS IoT for the next job, as the firmware does when it connects and whenever
   * it is told that its list of jobs changed.
   */
  function lookForJob() {
    if (!board.powered) return;
    const next = fake.device(thing).nextJob();
    if (board.job !== null && next?.jobId !== board.job) {
      // The job is no longer listed: it was cancelled, or it timed out.
      say(`${thing}: the update to ${board.target} was withdrawn`);
      settle('cancelled', '');
    }
    if (board.state !== 'idle' || next === null || next.status !== 'QUEUED') return;

    const offered = next.document?.fw?.version;
    board.job = next.jobId;
    if (next.document?.op !== 'fw_update' || parseVersion(offered) === null) {
      update('REJECTED', { reason: 'bad_document', running: board.version });
      settle('refused', 'bad_document');
    } else if (compareVersions(parseVersion(offered), parseVersion(board.version)) <= 0) {
      say(`${thing}: refused ${offered}, which is not newer than what it runs`);
      update('REJECTED', { reason: 'not_newer', running: board.version });
      settle('refused', 'not_newer');
    } else {
      // Nothing is sent to the job: the execution stays queued while the board waits.
      board.target = offered;
      imageKey = `firmware/${next.document.fw.sha256}.bin`;
      enter('awaiting_user');
      report();
      say(`${thing}: offered ${offered}, waiting for Button 1`);
    }
  }

  /** The update cannot go on: tell AWS IoT why, and go back to idle. */
  function fail(reason) {
    // If the job was cancelled meanwhile nobody takes this answer.
    update('FAILED', { reason, running: board.version });
    say(`${thing}: the update to ${board.target} failed (${reason})`);
    settle('failed', reason);
  }

  /** The download is complete: ask AWS IoT whether to go on, then restart. */
  function install() {
    enter('verifying');
    report();
    if (!update('IN_PROGRESS', { step: 'rebooting' })) {
      settle('cancelled', '');
      return false;
    }
    enter('rebooting');
    report();
    board.powered = false;
    fake.device(thing).disconnect('CONNECTION_LOST');
    say(`${thing}: downloaded and checked ${board.target}, restarting`);
    return true;
  }

  return Object.assign(board, {
    lookForJob,

    /** Power up and connect. `uptime`: seconds since the board started. */
    /** A line the board prints on its serial console, which firmware 1.12.0 and later also sends to the cloud. */
    log(tag, text, options = {}) {
      if (board.powered) fake.device(thing).log(tag, text, options);
    },

    connect(uptime = 6) {
      board.powered = true;
      fake.device(thing).connect();
      report({ uptime });
      reportOnConnecting();
      lookForJob();
    },

    /** Lose power or the network, for the reason AWS IoT would give. The shadow keeps what was reported last. */
    disconnect(reason = 'CONNECTION_LOST') {
      if (board.powered) fake.device(thing).disconnect(reason);
      board.powered = false;
    },

    /**
     * Restart by itself and come back: a new line in the boot diary with why (a Zephyr reset
     * cause in hex: 10 is the watchdog, 2 a restart by the software), and the count of
     * restarts for being stuck if that was why.
     */
    restart({ cause = '10', stuck = null } = {}) {
      board.disconnect();
      if (stuck !== null) board.stuck = stuck;
      if (board.diary !== null) {
        board.diary = { boots: board.diary.boots + 1, log: [...board.diary.log, `${board.version}/${cause}/4`].slice(-8) };
      }
      if (board.diag?.heap) board.diag = { ...board.diag, heap: { ...board.diag.heap, least: board.diag.heap.free } };
      board.connect(5);
    },

    /** A person opens the Bluetooth window for a phone, and later it closes, with the record of what came of it. */
    openBluetooth() {
      enter('bluetooth');
      report();
    },
    closeBluetooth(record = null) {
      enter('idle');
      if (record !== null) board.bt = record;
      report(record === null ? undefined : { bt: record });
    },

    /** A moment of a board that is on, while a scenario's time goes by: its heartbeat, and now and then its diagnostics. */
    passTime(at) {
      if (!board.powered) return;
      board.wander?.(board, at);
      const due = board.diag !== null && at - lastDiag >= DIAG_MS;
      if (due) lastDiag = at;
      report(due ? { diag: board.diag } : undefined);
    },

    /**
     * Flashed over USB or serial, and back on the network: it runs something else, and
     * no job knows about it.
     */
    flash(flashed, uptime = 6) {
      board.version = flashed;
      board.last = 'none';
      board.error = '';
      report({ uptime });
    },

    /** The report a board sends when nothing has changed: its heartbeat. */
    heartbeat() {
      if (board.powered) report();
    },

    /** Button 1: install the update on offer. False if there is nothing to install. */
    pressButton1() {
      if (!board.powered || board.state !== 'awaiting_user') return false;
      // The firmware fetches the job again for a fresh download address, and
      // downloads only once AWS IoT has accepted that it starts.
      lookForJob();
      if (board.state !== 'awaiting_user') return false;
      if (!update('IN_PROGRESS', { step: 'downloading' })) {
        settle('cancelled', '');
        return false;
      }
      enter('downloading');
      report();
      say(`${thing}: Button 1 pressed, downloading ${board.target}`);
      return true;
    },

    /** Button 2: decline the update on offer. */
    pressButton2() {
      if (!board.powered || board.state !== 'awaiting_user') return false;
      update('REJECTED', { reason: 'declined', running: board.version });
      say(`${thing}: Button 2 pressed, ${board.target} declined`);
      settle('declined', '');
      return true;
    },

    /**
     * Go on downloading up to `percent`, reporting every ten percent. The bucket
     * refuses an image whose release was revoked, also in the middle of a download.
     */
    download(percent) {
      while (board.state === 'downloading' && board.progress < Math.min(percent, 100)) {
        if (imageRefused()) {
          fail('download_failed');
          return;
        }
        board.progress += 10;
        report();
      }
    },

    /** Check the finished download and restart into it. False if there is none. */
    install() {
      return board.state === 'downloading' && board.progress === 100 && install();
    },

    /**
     * Back from the restart. `kept` is false when the new firmware started but could
     * not reach AWS IoT, so that the bootloader put the previous firmware back.
     */
    comeBack({ kept, uptime = 6 }) {
      if (board.state !== 'rebooting') return;
      board.powered = true;
      fake.device(thing).connect();
      if (kept) board.version = board.target;
      // If the job was cancelled meanwhile nobody takes this answer; the board runs
      // what it runs all the same.
      update(kept ? 'SUCCEEDED' : 'FAILED',
        kept ? { running: board.version } : { reason: 'rolled_back', running: board.version });
      say(kept
        ? `${thing}: runs ${board.version} and has confirmed it`
        : `${thing}: the bootloader put ${board.version} back`);
      enter('idle');
      board.job = null;
      board.target = null;
      board.progress = 0;
      board.last = kept ? 'succeeded' : 'rolled_back';
      board.error = kept ? '' : 'not confirmed';
      report({ uptime });
    },

    /** One second in the life of a board that is left to itself (--live). */
    tick() {
      secondsInState += 1;
      if (!board.powered) {
        if (board.state === 'rebooting' && secondsInState >= LIVE_RESTART_SECONDS) {
          board.comeBack({ kept: true });
        }
        return;
      }
      lookForJob();
      if (board.state === 'downloading' && secondsInState % LIVE_SECONDS_PER_STEP === 0) {
        board.download(board.progress + 10);
        if (board.progress === 100) install();
      }
    },
  });
}

/**
 * A line typed in the terminal while the boards are live: "1" or "2" presses that
 * button on the board that is waiting. With several waiting, the end of a board's
 * name says which one, as in "1 3f2a". Returns what to print, or null.
 */
function pressButton(boards, line) {
  const [button, suffix = ''] = line.trim().split(/\s+/);
  if (button === '') return null;
  if (button !== '1' && button !== '2') {
    return `"${button}" is not a button: a board has Button 1 and Button 2.`;
  }
  const waiting = boards.filter((board) => board.powered && board.state === 'awaiting_user');
  if (waiting.length === 0) {
    return 'No board is waiting for a button. Start a deployment in the console first.';
  }
  const chosen = waiting.filter((board) => board.thing.endsWith(suffix));
  if (chosen.length !== 1) {
    return `Which board? Add the end of its name: ${waiting.map((board) => board.thing).join(', ')}.`;
  }
  if (button === '1') chosen[0].pressButton1();
  else chosen[0].pressButton2();
  return null;
}

// Scenarios.

const SECONDS_IN = Object.freeze({ d: 86400, h: 3600, m: 60, s: 1 });

/** "2h50m" in milliseconds. */
function duration(text) {
  if (!/^(?:\d+[dhms])+$/.test(text)) throw new TypeError(`Not a length of time: ${text}`);
  let seconds = 0;
  for (const [, count, unit] of text.matchAll(/(\d+)([dhms])/g)) seconds += Number(count) * SECONDS_IN[unit];
  return seconds * 1000;
}

/**
 * What a scenario is built with: the clock, the provisioning of boards, and the
 * release manager's requests to the real API. A request that does not end the way
 * the scenario expects stops the preview from starting.
 */
function createStage({ fake, clock, boards, callApi, tick, say, customers = null }) {
  const begun = clock.now();
  // Up to when the boards that are on have reported while the scenario's time went by.
  let passed = null;
  // When the release manager of the scenario signed in, in epoch seconds, once they have.
  let signedInAt = null;

  /** Let the time go by up to `to`: every board that is on reports as it would meanwhile. */
  function passTo(to) {
    if (passed !== null) {
      for (let at = passed + PASSING_HEARTBEAT_MS; at < to; at += PASSING_HEARTBEAT_MS) {
        clock.moveTo(at);
        for (const board of boards) board.passTime(at);
      }
    }
    clock.moveTo(to);
    passed = to;
  }

  async function request(method, path, body, expected) {
    const result = await callApi({
      method,
      path,
      user: USERS.manager,
      authTime: signedInAt,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(body), 'utf8'),
    });
    const answer = JSON.parse(result.body);
    const outcome = result.statusCode === 200 || result.statusCode === 201 ? 'ok' : answer.error?.code;
    if (outcome !== expected) {
      throw new Error(`The scenario could not be built: ${method} ${path} answered ` +
        `${result.statusCode} ${outcome}, not ${expected}`);
    }
    return answer;
  }

  // A build always produces zephyr.signed.bin, whatever the fixture is called.
  const image = (file, notes) =>
    ({ filename: 'zephyr.signed.bin', notes, data: fixture(file).toString('base64') });

  return {
    /** Go to the moment that lay this long before the preview started, e.g. "2h50m". */
    ago(text) {
      passTo(begun - duration(text));
    },

    /** Let the time go by up to when the preview started. */
    catchUp() {
      if (passed !== null && passed < begun) passTo(begun);
    },

    /** The release manager signs in on the website now: their next request puts the sign-in on record. */
    signIn() {
      signedInAt = Math.floor(clock.now() / 1000);
    },

    /** What the Serial page posts once a board has answered OK to a command that changed it. */
    async serialCommand(command, board) {
      await request('POST', '/api/serial/commands', { command, device: board.diag?.id, version: board.version }, 'ok');
    },

    /**
     * What tools/provision_device.py does: a thing in the group, with its certificate, and for a
     * board without Wi-Fi (--board nrf5340dk) the attribute that says so.
     */
    provision(number, version, { type = null } = {}) {
      const thing = `cranium-${previewId(`board ${number}`, 16)}`;
      fake.addThing(thing, {
        certificates: [previewId(`certificate ${number}`, 64)], attributes: type === null ? {} : { board: type },
      });
      const board = createBoard(fake, thing, version, say);
      boards.push(board);
      return board;
    },

    async upload(file, notes) {
      await request('POST', '/api/firmware', image(file, notes), 'ok');
    },

    /**
     * What apps/android/publish.sh does (docs/mobile-apps.md): a URL for the APK, the APK to S3 with it,
     * then the check that publishes it. The APK is made up: its bytes say what it stands for.
     */
    async publishApp(version, versionCode, notes) {
      const bytes = Buffer.from(`PK\u0003\u0004 A stand-in for cranium-android-${version}.apk, made by the preview.\n`);
      const described = { versionCode, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, notes };
      const { upload } = await request('POST', '/api/apps/android/uploads', { version, ...described }, 'ok');
      const sent = fake.s3Request({ method: 'PUT', url: upload.url, headers: upload.headers, body: bytes });
      if (sent.status !== 200) throw new Error(`The scenario could not be built: S3 answered ${sent.status} for ${version}`);
      await request('POST', `/api/apps/android/releases/${version}`, described, 'ok');
    },

    /** An image made for the scenario (api/test/images.mjs), for a board type, signed with its key. */
    async uploadBuilt(version, board, notes) {
      const data = buildImage({ version, key: FLEET_KEY, board, fill: Number.parseInt(previewId(version, 2), 16) });
      await request('POST', '/api/firmware', { filename: 'zephyr.signed.bin', notes, data: data.toString('base64') }, 'ok');
    },

    /** What a phone app posts once it has connected to a board over Bluetooth. */
    async seen(board, version, name) {
      await request('POST', `/api/devices/${board.thing}/seen`, { version, name }, 'ok');
    },

    async group(name, members) {
      return (await request('POST', '/api/groups', { name, things: members.map((board) => board.thing) }, 'ok')).group;
    },

    async rollout(version, target, note) {
      return (await request('POST', '/api/rollouts', { version, target, note }, 'ok')).rollout;
    },

    /** The schedule's minute: open staged rollouts move on if they are due to. */
    async tick() {
      await tick();
    },

    /** An upload that the server has to refuse with the given code. */
    async refusedUpload(file, code) {
      await request('POST', '/api/firmware', image(file, ''), code);
    },

    async deploy(version, targets, note) {
      const things = targets.map((board) => board.thing);
      return (await request('POST', '/api/deployments', { version, things, note }, 'ok')).deployment.id;
    },

    async cancel(id, force = false) {
      await request('POST', `/api/deployments/${id}/cancel`, { force }, 'ok');
    },

    /** A job made directly in AWS IoT, which ended before anyone looked: the console had no part in it. */
    async outsideJob(name, board, status, details) {
      const jobId = `cranium-bench-${name}`;
      await fake.createJob({
        jobId, things: [board.thing], document: '{}', description: '{}', urlExpiresInSec: 600, inProgressTimeoutMinutes: 30,
      });
      fake.execution(jobId, board.thing).update(status, { running: board.version, ...details });
    },

    /** A job made directly in AWS IoT that offers a board a version: the console has no part in it. */
    async outsideOffer(name, board, version) {
      await fake.createJob({
        jobId: `cranium-bench-${name}`,
        things: [board.thing],
        document: JSON.stringify({ op: 'fw_update', fw: { version, sha256: '0'.repeat(64) } }),
        description: '{}',
        urlExpiresInSec: 600,
        inProgressTimeoutMinutes: 30,
      });
    },

    async revoke(version, reason) {
      await request('POST', `/api/firmware/${version}/revoke`, { reason }, 'ok');
    },

    // The map and the alerts (docs/fleet.md).

    /** Where AWS IoT Core Device Location, in the stand-in, finds each access point: { mac: { lat, lon } }. */
    placeAccessPoints(table) {
      fake.placeAccessPoints(table);
    },

    /** A board on 1.13.0 publishes what it hears of the Wi-Fi, and the location function places it. */
    async locate(board, aps) {
      board.aps = aps;
      return fake.locate(board.thing, { aps, boot: 1, t: 61_000 });
    },

    /** A release manager asks for the e-mail alerts and follows the link that AWS Notifications sends. */
    async subscribeAlerts(user = USERS.manager) {
      await fake.subscribeAlerts(user.email);
      fake.confirmSubscription(user.email);
    },

    /** The check of the alerts that EventBridge runs every 5 minutes when deployed. */
    async checkAlerts() {
      await fake.alertsSettled();
      return fake.checkAlerts();
    },

    // The customer site (docs/customer-site.md): what the console's Customers page sends, and what a
    // customer does with the invitation.

    /** Invite a customer, as the Customers page does: the account waits for its first sign-in. */
    async invite(email, name = '') {
      return (await request('POST', '/api/customers', name ? { email, name } : { email }, 'ok')).customer;
    },

    async assign(customer, board, label = '') {
      await request('POST', `/api/customers/${customer.id}/boards`, label ? { thing: board.thing, label } : { thing: board.thing }, 'ok');
    },

    /** The temporary password the invitation's e-mail would have carried. */
    invitationPassword(customer, password = PREVIEW_TEMPORARY_PASSWORD) {
      customers.pool.addCredentials({ sub: customer.id, password, code: PREVIEW_CODE });
    },

    /** The customer's first sign-in, as if it were done: their own password from then on. */
    signedInOnce(customer, password = PREVIEW_CUSTOMER_PASSWORD) {
      customers.store.confirm(customer.id);
      customers.pool.addCredentials({ sub: customer.id, password, code: PREVIEW_CODE });
    },
  };
}

/** One board, flashed with 1.2.3+4 three hours ago, and a newer release ready for it. */
async function oneBoard(stage) {
  stage.ago('3h');
  const board = stage.provision(1, '1.2.3+4');
  board.connect();
  stage.ago('2h50m');
  await stage.upload('valid-1.2.3+4.signed.bin', 'The build the boards were flashed with over USB.');
  stage.ago('25m');
  await stage.upload('valid-1.2.3+5.signed.bin', 'Reconnects faster after the Wi-Fi drops out.');
  return board;
}

/** The release is deployed, and the board has seen the offer. */
async function offered(stage) {
  const board = await oneBoard(stage);
  stage.ago('6m');
  await stage.deploy('1.2.3+5', [board], 'First update over the air.');
  stage.ago('5m55s');
  board.lookForJob();
  return board;
}

/** Button 1 was pressed, the download went through, and the board restarted. */
async function restarted(stage) {
  const board = await offered(stage);
  stage.ago('5m');
  board.pressButton1();
  stage.ago('4m30s');
  board.download(100);
  board.install();
  return board;
}

/**
 * One board with a past, as a real one has: an update it declined, one that was cancelled
 * before it started and one it installed, jobs made directly in AWS IoT, and then 1.3.0+0
 * over USB, which is newer than every release and is not one of them.
 */
async function flashedOverUsb(stage) {
  const board = await oneBoard(stage);
  stage.ago('24m');
  await stage.deploy('1.2.3+5', [board], 'Declined on the board.');
  stage.ago('23m');
  board.lookForJob();
  board.pressButton2();
  stage.ago('21m');
  const cancelled = await stage.deploy('1.2.3+5', [board], 'Cancelled before the board started.');
  stage.ago('20m');
  await stage.cancel(cancelled);
  stage.ago('19m');
  await stage.outsideJob('20261010T100000-0a0a', board, 'FAILED', { reason: 'download_failed' });
  stage.ago('18m');
  await stage.outsideJob('20261010T101000-0b0b', board, 'SUCCEEDED', {});
  stage.ago('15m');
  await stage.deploy('1.2.3+5', [board], 'Installed.');
  stage.ago('14m50s');
  board.lookForJob();
  stage.ago('14m');
  board.pressButton1();
  stage.ago('13m30s');
  board.download(100);
  board.install();
  stage.ago('11m');
  board.comeBack({ kept: true });
  stage.ago('6m');
  board.flash('1.3.0+0');
  return board;
}

/** A deterministic wobble, -1 to 1, so that a scenario's readings look alive and are the same on every run. */
function wobble(at, periodMs, phase = 0) {
  return Math.sin((at / periodMs) * 2 * Math.PI + phase);
}

/**
 * Three boards over two days, for the Events and Diagnostics pages: every kind of event, a
 * board with diagnostics and a name of its own (its device ID, from firmware 1.11.4), one on
 * firmware too old for either that went offline, and an update through the console. And for the
 * Fleet page: two nRF5340 DKs that only a phone sees, a release for each board type, two groups,
 * and a staged rollout to one of them whose canary has confirmed and whose wave waits for a board
 * that is offline.
 */
async function fleet(stage) {
  stage.ago('2d');
  const first = stage.provision(1, '1.12.0+0');
  Object.assign(first, {
    stuck: { count: 0, reason: 'none' },
    // The name set at its serial console (SET_ID), and a locally administered address: no real
    // network card has it.
    diag: { id: 'CRVIHAAN01', mac: '02:5e:a1:00:00:01', channel: 6, heap: { free: 21312, least: 9840, size: 44240 } },
    diary: { boots: 41, log: ['1.9.0+0/8/4', '1.9.0+0/1/4', '1.12.0+0/2/4', '1.12.0+0/1/4'] },
    wander(board, at) {
      board.rssi = Math.round(-58 + 6 * wobble(at, 5 * 3_600_000) + 2 * wobble(at, 17 * 60_000, 1));
      const { heap } = board.diag;
      const free = Math.round(21000 + 1800 * wobble(at, 2 * 3_600_000, 2));
      board.diag = { ...board.diag, heap: { ...heap, free, least: Math.min(heap.least, free) } };
    },
  });
  const second = stage.provision(2, '1.9.0+0');
  Object.assign(second, {
    stuck: { count: 0, reason: 'none' },
    diary: { boots: 17, log: ['1.8.0+0/8/4', '1.9.0+0/2/4'] },
    bt: { from: '1.8.0+0', to: '1.9.0+0', result: 'succeeded', proof: 'person', count: 1 },
    wander(board, at) {
      board.rssi = Math.round(-71 + 4 * wobble(at, 3 * 3_600_000, 0.5) + 2 * wobble(at, 11 * 60_000));
    },
  });
  const third = stage.provision(3, '1.2.3+4');
  third.wander = (board, at) => {
    board.rssi = Math.round(-49 + 3 * wobble(at, 7 * 3_600_000, 3));
  };
  // Two nRF5340 DKs: no Wi-Fi, so they never connect; provisioned with --board nrf5340dk.
  const fourth = stage.provision(4, '1.12.0+3', { type: 'nrf5340dk' });
  const fifth = stage.provision(5, '1.12.0+3', { type: 'nrf5340dk' });
  for (const board of [first, second, third]) board.connect(40);
  // Firmware 1.12.0 sends what it printed while it was coming up, once it is connected.
  first.log('app', 'Network is up', { waitedMs: 12_000, boot: 40, seq: 1 });
  first.log('WIFI', 'connected ip=10.0.0.7 rssi=-55', { waitedMs: 11_000 });
  first.log('cloud', 'Connecting to AWS IoT as cranium-' + first.thing.slice(8), { waitedMs: 9_000 });
  first.log('app', 'Connected to AWS IoT', { waitedMs: 5_000 });
  stage.ago('1d23h');
  stage.signIn();
  await stage.uploadBuilt('1.2.3+4', null, 'The build the boards were flashed with over USB.');

  // The watchdog: the connection drops, and the board is back 20 s later.
  stage.ago('1d6h');
  first.disconnect('MQTT_KEEP_ALIVE_TIMEOUT');
  stage.ago('1d5h59m40s');
  first.restart({ cause: '10' });
  first.log('app', 'Network is up', { waitedMs: 10_000, boot: 41, seq: 1 });
  first.log('WIFI', 'connected ip=10.0.0.7 rssi=-58', { waitedMs: 9_000 });
  first.log('app', 'Connected to AWS IoT', { waitedMs: 4_000, dropped: 2 });
  stage.ago('1d1h');
  second.disconnect('MQTT_KEEP_ALIVE_TIMEOUT');
  stage.ago('22h');
  second.restart({ cause: '2', stuck: { count: 1, reason: 'wifi_silent' } });
  stage.ago('20h');
  first.diag = { ...first.diag, heap: { ...first.diag.heap, free: 7400, least: 6100 } };
  // A new network for the first board, set at its serial console from the Serial page.
  stage.ago('9h2m');
  stage.signIn();
  first.log('CONSOLE', 'WIFI done on the serial console: save a WPA2 network and join it');
  await stage.serialCommand('WIFI', first);
  first.log('WIFI', 'disconnected');
  stage.ago('9h');
  first.diag = { ...first.diag, channel: 11 };
  first.log('net', 'ERR: Leaving "Lab 2.4": its security mode (2) is not allowed', { waitedMs: 30_000 });
  first.log('WIFI', 'connected ip=10.0.0.9 rssi=-61', { waitedMs: 3_000 });
  // A line that the cloud never stores: the board says it, the recorder withholds it.
  first.log('BT', 'passkey 123456');
  stage.ago('5h');
  second.openBluetooth();
  stage.ago('4h56m');
  second.closeBluetooth({ from: '1.9.0+0', to: '1.9.1+0', result: 'not_installed', proof: 'none', count: 2 });

  stage.ago('3h');
  await stage.uploadBuilt('1.2.3+5', null, 'Reconnects faster after the Wi-Fi drops out.');
  stage.ago('2h50m');
  await stage.deploy('1.2.3+5', [third], 'The oldest board first.');
  stage.ago('2h49m');
  third.lookForJob();
  stage.ago('2h40m');
  third.pressButton1();
  stage.ago('2h39m');
  third.download(100);
  third.install();
  stage.ago('2h37m');
  third.comeBack({ kept: true });

  // A release for each board type, and what a phone saw of the two boards without Wi-Fi.
  stage.ago('2h20m');
  await stage.uploadBuilt('1.13.0+0', 'nrf7002dk', 'Reconnects to AWS IoT within seconds of the Wi-Fi coming back.');
  stage.ago('2h15m');
  await stage.uploadBuilt('1.13.0+1', 'nrf5340dk', 'The first build for the nRF5340 DK: Bluetooth only, updated from the phone app.');
  stage.ago('2h10m');
  await stage.seen(fourth, '1.13.0+1', 'Cranium-4D21');
  stage.ago('1h50m');
  await stage.seen(fifth, '1.12.0+3', 'Cranium-9B07');
  stage.ago('1h40m');
  await stage.group('Lab bench', [first, fourth]);
  const demo = await stage.group('Demo', [second, third, fifth]);
  stage.ago('1h');
  second.disconnect('CONNECTION_LOST');

  // A staged rollout to the Demo group: its canary takes it and confirms it, and the schedule
  // then starts the wave, which waits for the board that is offline. The nRF5340 DK is left out.
  stage.ago('50m');
  await stage.rollout('1.13.0+0', { kind: 'group', group: demo.id }, 'Demo boards first.');
  stage.ago('49m');
  third.lookForJob();
  stage.ago('48m');
  third.pressButton1();
  stage.ago('47m');
  third.download(100);
  third.install();
  stage.ago('45m');
  third.comeBack({ kept: true });
  stage.ago('44m');
  await stage.tick();

  await campusMap(stage, third);
  await androidReleases(stage);
  return [first, second, third];
}

/**
 * The fleet, and the customer site on top of it: two customers who have signed in before, one
 * whose invitation is still unused, three boards given out, and the rest that nobody has.
 */
async function customerSite(stage) {
  const [first, second, third] = await fleet(stage);
  stage.ago('1m50s');
  stage.signIn();
  const ada = await stage.invite(`ada@${MAIL_DOMAIN}`, 'Ada');
  const ben = await stage.invite(`ben@${MAIL_DOMAIN}`);
  const cleo = await stage.invite(`cleo@${MAIL_DOMAIN}`, 'Cleo');
  stage.ago('1m40s');
  await stage.assign(ada, first, 'Living room deck');
  await stage.assign(ada, second);
  await stage.assign(ben, third, 'Studio');
  stage.ago('1m30s');
  stage.signedInOnce(ada);
  stage.signedInOnce(ben);
  stage.invitationPassword(cleo);
}

/**
 * The Android app on the Apps page (docs/mobile-apps.md): its last two versions, published as a release
 * manager's build publishes them, with their notes from apps/android/CHANGELOG.md.
 */
async function androidReleases(stage) {
  const notes = new Map((versionsOfRepository()?.changelogs.android ?? []).map((entry) => [entry.version, entry.note.slice(0, 500)]));
  stage.ago('4m');
  await stage.publishApp('0.3.0', 3, notes.get('0.3.0') ?? '');
  stage.ago('2m');
  await stage.publishApp('0.4.0', 4, notes.get('0.4.0') ?? '');
}

const REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));

/**
 * What cloud/deploy.sh would write as versions.json, from this checkout's cloud/VERSION and changelogs
 * (web/build-versions.mjs), or null if they cannot be read.
 */
function versionsOfRepository() {
  try {
    return buildVersions({ repo: REPOSITORY });
  } catch {
    return null;
  }
}

// The map (docs/fleet.md). Access points of a campus, at addresses of the range that RFC 7042 keeps
// for documentation (00-00-5E-EF-10-00 to -FF: unicast and globally administered, and never a real
// access point's), placed around Penn's engineering buildings and at Pennovation Works, 1.6 km away.
const CAMPUS = Object.freeze({
  levine: [39.95222, -75.19072],
  towne: [39.95184, -75.19028],
  singh: [39.95262, -75.18888],
  pennovation: [39.94063, -75.20178],
});
const CAMPUS_APS = Object.freeze(Object.fromEntries(Object.entries(CAMPUS).flatMap(([, [lat, lon]], building) =>
  [[0, 0], [0.00018, -0.00022], [-0.00014, 0.00025]].map(([dLat, dLon], index) =>
    [`00:00:5e:ef:10:${(building * 16 + index).toString(16).padStart(2, '0')}`, { lat: lat + dLat, lon: lon + dLon }]))));

/** What a board hears in a building: its three access points, strongest first. */
function heard(building, rss = [-48, -61, -70]) {
  const at = Object.keys(CAMPUS).indexOf(building) * 16;
  return rss.map((value, index) => ({ mac: `00:00:5e:ef:10:${(at + index).toString(16).padStart(2, '0')}`, rss: value }));
}

/**
 * Boards around a campus, for the Map page: the board that took 1.13.0 in the rollout above places
 * itself, and of three more on 1.13.0 two do too, one of which is carried to a demo at Pennovation
 * Works (a move of more than 1 km, and an alert), and one hears too few access points. The release
 * manager gets the e-mail alerts, so the Account page has them.
 */
async function campusMap(stage, third) {
  stage.placeAccessPoints(CAMPUS_APS);
  await stage.subscribeAlerts();
  stage.ago('43m');
  const bench = stage.provision(6, '1.13.0+0');
  const demo = stage.provision(7, '1.13.0+0');
  const basement = stage.provision(8, '1.13.0+0');
  bench.rssi = -55;
  demo.rssi = -63;
  basement.rssi = -78;
  for (const board of [bench, demo, basement]) board.connect(30);
  stage.ago('42m');
  await stage.locate(third, heard('towne'));
  await stage.locate(bench, heard('levine'));
  stage.ago('41m');
  await stage.locate(demo, heard('singh'));
  stage.ago('40m');
  await stage.locate(basement, heard('levine', [-88]));
  await stage.checkAlerts();
  stage.ago('30m');
  await stage.locate(bench, heard('levine', [-52, -58, -74]).slice(0, 2).concat(heard('towne', [-80]).slice(0, 1)));
  await stage.checkAlerts();
  stage.ago('15m');
  await stage.locate(demo, heard('pennovation', [-45, -57, -69]));
  await stage.checkAlerts();
  stage.ago('5m');
  await stage.locate(third, heard('towne', [-50, -60, -71]));
  await stage.checkAlerts();
}

/**
 * A board's side of cranium/<thing>/commands (docs/fleet.md, "Commands"): from 1.13.0 a board that is
 * online answers in its log, with tag CMD; an older one does not subscribe, and an offline one misses it.
 */
function answerCommand(fake, board, payload, say) {
  if (!board?.powered || compareVersions(parseVersion(board.version), parseVersion('1.13.0+0')) < 0) return;
  if (payload.cmd === 'identify') {
    const seconds = Number.isInteger(payload.seconds) && payload.seconds >= 1 && payload.seconds <= 60 ? payload.seconds : 15;
    board.log('CMD', `identify for ${seconds} s (${payload.id})`);
    say(`${board.thing}: blinks LED1 and LED2 for ${seconds} s`);
  } else if (payload.cmd === 'report') {
    board.heartbeat();
    board.log('CMD', `report: heartbeat, diagnostics and a location scan (${payload.id})`);
    if (board.aps) fake.locate(board.thing, { aps: board.aps, boot: 1, t: 61_000 }).catch(() => {});
    say(`${board.thing}: reports at once`);
  } else if (payload.cmd === 'memfault' && compareVersions(parseVersion(board.version), parseVersion('1.14.0+0')) >= 0) {
    // From 1.14.0 (docs/memfault.md): a Memfault heartbeat now, and its chunks to the forwarder. The preview
    // has no forwarder, so only the answer shows.
    board.log('CMD', `memfault: heartbeat taken, sending its data (${payload.id})`);
    say(`${board.thing}: sends its Memfault data`);
  } else {
    board.log('CMD', `ignored: unknown command (${payload.id})`);
  }
}

export const SCENARIOS = Object.freeze({
  empty: {
    summary: 'Nothing is registered yet: every page shows its empty state.',
    async build() {},
  },
  'one-board-idle': {
    summary: 'One board is online and idle on 1.2.3+4; release 1.2.3+5 is ready to deploy.',
    build: oneBoard,
  },
  'waiting-for-button': {
    summary: 'The board has been offered 1.2.3+5 and waits for its Button 1.',
    build: offered,
  },
  downloading: {
    summary: 'Button 1 was pressed; the board has downloaded 40% of 1.2.3+5.',
    async build(stage) {
      const board = await offered(stage);
      stage.ago('40s');
      board.pressButton1();
      stage.ago('20s');
      board.download(40);
    },
  },
  'lost-during-download': {
    summary: 'Button 1 was pressed and the download reached 40%; then the board went offline.',
    async build(stage) {
      const board = await offered(stage);
      stage.ago('5m');
      board.pressButton1();
      stage.ago('4m30s');
      board.download(40);
      board.disconnect();
    },
  },
  'outside-job': {
    summary: 'The board is downloading 1.2.3+5 from a job made directly in AWS IoT: no deployment of this console.',
    async build(stage) {
      const board = await oneBoard(stage);
      stage.ago('2m');
      await stage.outsideOffer('20261010T100000-0a0a', board, '1.2.3+5');
      board.lookForJob();
      board.pressButton1();
      stage.ago('40s');
      board.download(40);
    },
  },
  'rolled-back': {
    summary: 'The board installed 1.2.3+5, could not reconnect, and is back on 1.2.3+4.',
    async build(stage) {
      const board = await restarted(stage);
      stage.ago('2m');
      board.comeBack({ kept: false, uptime: 9 });
    },
  },
  succeeded: {
    summary: 'The board installed 1.2.3+5 and confirmed it.',
    async build(stage) {
      const board = await restarted(stage);
      stage.ago('3m40s');
      board.comeBack({ kept: true, uptime: 8 });
    },
  },
  'gone-offline': {
    summary: 'The board installed 1.2.3+5 and confirmed it, and has been offline since.',
    async build(stage) {
      const board = await restarted(stage);
      stage.ago('3m40s');
      board.comeBack({ kept: true, uptime: 8 });
      board.disconnect();
    },
  },
  'flashed-over-usb': {
    summary: 'After some deployments the board was flashed over USB with 1.3.0+0, which is not a registered release.',
    build: flashedOverUsb,
  },
  'flashed-then-offline': {
    summary: 'The same, and the board has been offline since it reported 1.3.0+0.',
    async build(stage) {
      const board = await flashedOverUsb(stage);
      board.disconnect();
    },
  },
  fleet: {
    summary: 'Five boards over two days, two of them nRF5340 DKs: every kind of event, diagnostics, groups and a ' +
      'staged rollout. For the Events, Diagnostics and Fleet pages.',
    build: fleet,
    // Its images are built and signed with a key of the run (api/test/images.mjs), which this console trusts.
    env: keyEnv(FLEET_KEY),
  },
  customers: {
    summary: 'The fleet, with customers: Ada has two boards, Ben one, Cleo an unused invitation, and the rest nobody has.',
    build: customerSite,
    env: keyEnv(FLEET_KEY),
  },
  revoked: {
    summary: 'Three boards and a longer history: 2.0.0+0 was revoked while it was being rolled out.',
    async build(stage) {
      stage.ago('2d3h');
      const first = stage.provision(1, '1.2.3+4');
      const second = stage.provision(2, '1.2.3+4');
      second.rssi = -71;
      first.connect();
      second.connect();
      stage.ago('1d2h');
      await stage.upload('valid-1.2.3+4.signed.bin', 'The build the boards were flashed with over USB.');

      // Someone picks the wrong file, then the right one, and rolls it out. One
      // board installs it; on the other, Button 2 is pressed.
      stage.ago('5h');
      await stage.refusedUpload('signed-with-other-key.signed.bin', 'wrong_key');
      stage.ago('4h58m');
      await stage.upload('valid-1.2.3+5.signed.bin', 'Reconnects faster after the Wi-Fi drops out.');
      stage.ago('4h50m');
      await stage.deploy('1.2.3+5', [first, second], 'First update over the air.');
      stage.ago('4h49m');
      first.lookForJob();
      second.lookForJob();
      stage.ago('4h47m');
      first.pressButton1();
      second.pressButton2();
      stage.ago('4h46m');
      first.download(100);
      first.install();
      stage.ago('4h45m');
      first.comeBack({ kept: true });

      // The next release turns out to be faulty while both boards are being updated.
      stage.ago('40m');
      await stage.upload('valid-padded-signature.signed.bin', 'New pad layout.');
      stage.ago('36m');
      await stage.deploy('2.0.0+0', [first, second], 'Roll out 2.0.0 to both boards.');
      stage.ago('35m30s');
      first.lookForJob();
      second.lookForJob();
      stage.ago('34m');
      second.pressButton1();
      stage.ago('33m30s');
      second.download(30);
      stage.ago('33m');
      await stage.revoke('2.0.0+0', 'Pads stop responding after a few minutes of use.');
      stage.ago('32m55s');
      first.lookForJob();
      second.lookForJob();

      // One board has been switched off since. A third is registered and has never
      // been powered up.
      stage.ago('30m');
      second.heartbeat();
      second.disconnect();
      stage.ago('20m');
      stage.provision(3, '1.2.3+4');
    },
  },
});

// The preview itself.

/**
 * Start listening, then build the scenario.
 *
 * @param {object} [options]
 * @param {string} [options.scenario]   a name from SCENARIOS
 * @param {boolean} [options.viewer]    sign in as the local viewer, not the release manager
 * @param {boolean} [options.live]      let the boards act by themselves
 * @param {boolean} [options.home]      serve the public home page instead of the console
 * @param {boolean} [options.customer]  serve the customer site, with the console as admin mode at /admin
 * @param {string} [options.repeatedCancel]  what the stand-in does with a forced
 *                                      cancellation of a deployment that is cancelled
 *                                      already: "refused", "accepted" or "ignored"
 * @param {string} [options.host]       a loopback address
 * @param {number} [options.port]       the console's port; sign-in is served on the next
 *                                      one. 0 takes two free ports
 * @param {(line: object) => void} [options.log]   receives the log lines of both functions
 * @param {(text: string) => void} [options.say]   told what the boards do
 * @param {() => number} [options.now]  the clock, epoch milliseconds
 */
export async function createPreview({
  scenario = 'empty', viewer = false, live = false, home = false, customer = false, repeatedCancel = 'refused',
  host = DEFAULT_HOST, port = DEFAULT_PORT, log = () => {}, say = () => {}, now = Date.now,
} = {}) {
  requireLoopback(host);
  if (!Object.hasOwn(SCENARIOS, scenario)) {
    throw new UsageError(
      `There is no scenario "${scenario}". Choose from: ${Object.keys(SCENARIOS).join(', ')}.`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65534) {
    throw new UsageError('The port must be a number from 0 to 65534.');
  }
  if (!REPEATED_CANCEL.includes(repeatedCancel)) {
    throw new UsageError(`--repeated-cancel takes one of: ${REPEATED_CANCEL.join(', ')}.`);
  }

  const user = viewer ? USERS.viewer : USERS.manager;
  const clock = createClock(now);
  const fake = createFakeAws({ now: clock.now, repeatedCancel });
  // The e-mail alerts are made as EventsFn makes them (api/src/alerts.mjs); none is sent anywhere.
  fake.enableAlerts('https://console.preview.invalid/');
  let consoleHost = null;
  // The customer site's half (docs/customer-site.md): the customer pool and who owns which board,
  // beside the console's. Its address is the preview's own.
  const customers = createFakeCustomers({ now: clock.now });
  // A scenario may sign its images with a key of its own, which its console then trusts.
  const config = Object.freeze({
    ...loadConfig(fakeEnv(SCENARIOS[scenario].env ?? {})),
    customers: Object.freeze({
      customerPoolId: CUSTOMER_POOL_ID,
      get siteUrl() {
        return consoleHost === null ? '' : `http://${consoleHost}/`;
      },
    }),
  });
  // The versions the deployment would be built with: the console's own and the iPhone app's (versions.json).
  const versions = versionsOfRepository();
  const app = createApp({
    aws: { ...fake, ...customers },
    config,
    now: clock.now,
    log: (line) => log({ function: 'api', ...line }),
    versions: parseBundledVersions(versions),
  });
  const customerApp = createCustomerApp({
    aws: { getShadow: fake.getShadow, queryEvents: fake.queryEvents, ...customers },
    config: Object.freeze({
      region: 'us-east-1', stateTable: 'local-state', eventsTable: 'local-events', customerPoolId: CUSTOMER_POOL_ID,
      customerClientId: CUSTOMER_CLIENT_ID, issuer: issuerOf(CUSTOMER_POOL_ID),
    }),
    now: clock.now,
    log: (line) => log({ function: 'customer-api', ...line }),
  });
  const customerPool = createCustomerCognito({
    userPoolId: CUSTOMER_POOL_ID, clientId: CUSTOMER_CLIENT_ID, directory: customers.directory(), now,
  });
  // The schedule that moves staged rollouts on (api/src/tick.mjs): every minute, and when a scenario says.
  const tick = createRolloutTick({ aws: fake, config, now: clock.now, log: (line) => log({ function: 'rollouts', ...line }) });
  for (const { sub, email, groups } of Object.values(USERS)) {
    fake.addUser({ sub, email, groups: [...groups] });
  }

  const boards = [];
  const timers = [];
  let loginHost = null;
  let web = null;
  let terminal = null;
  // Silent while the scenario is built; afterwards the terminal hears what boards do.
  let narrate = () => {};

  const signIn = createSignIn({
    clientId: config.userPoolClientId,
    userPoolId: config.userPoolId,
    user,
    host: () => loginHost,
    consoleOrigin: () => `http://${consoleHost}`,
    // As the customer site's admin mode, the console is at /admin, and the sign-in pages return there.
    redirectUri: () => (customer ? `http://${consoleHost}/admin` : `http://${consoleHost}/`),
    now,
    customerPool,
  });

  /** Hand a request to the API function, as the gateway does once its authorizer is satisfied. */
  function callApi({ method, path, query = '', headers = {}, body = null, user: caller, expiresAt, authTime = null }) {
    const claims = accessClaims({
      sub: caller.sub,
      groups: caller.groups,
      clientId: config.userPoolClientId,
      exp: expiresAt ?? Math.floor(now() / 1000) + TOKEN_SECONDS,
      authTime,
    });
    return app(gatewayEvent({
      routeKey: { GET: API_READ, PUT: API_PUT }[method] ?? API_WRITE, method, path, query, headers, host: consoleHost, body, claims,
    }));
  }

  /** The console's origin: what API Gateway is in production. */
  async function gateway(request, response) {
    if (request.headers.host !== consoleHost) {
      sendGateway(response, 403, 'Forbidden');
      return;
    }
    if (web === null) {
      sendGateway(response, 503, 'Service Unavailable');
      return;
    }
    const [path, query] = splitTarget(request.url ?? '');
    const { method, headers } = request;

    // S3, for the Android app's APKs (api/test/fake-apps.mjs): the presigned URLs the API hands out for an
    // upload and a download point here, and the stand-in checks them as S3 would.
    if (path.startsWith('/local-s3/')) {
      const body = await readBody(request, MAX_APK_BYTES);
      if (body === null) {
        sendGateway(response, 413, 'Request Entity Too Large', { connection: 'close' });
        return;
      }
      const answer = fake.s3Request({ method, url: `http://${consoleHost}${request.url}`, headers, body });
      send(response, answer.status, answer.headers, answer.body);
      return;
    }

    // The routes of the HTTP API. As deployed, {proxy+} also matches nothing at all
    // after the slash: /api/ reaches the authorizer, /api does not. The API takes only
    // these two methods, and what no route claims goes to the web function. The most
    // specific route wins, so /api/t/ is the routes for API tokens.
    let routeKey = WEB_DEFAULT;
    if (method === 'GET' && path === '/') routeKey = WEB_ROOT;
    else if (method === 'GET' && path.startsWith('/assets/')) routeKey = WEB_ASSETS;
    else if (method === 'GET' && path.startsWith('/api/c/')) routeKey = API_CUSTOMER_READ;
    else if (method === 'GET' && path.startsWith('/api/t/')) routeKey = API_TOKEN_READ;
    else if (method === 'POST' && path.startsWith('/api/t/')) routeKey = API_TOKEN_WRITE;
    else if (method === 'PUT' && path.startsWith('/api/t/')) routeKey = API_TOKEN_PUT;
    else if (method === 'GET' && path.startsWith('/api/')) routeKey = API_READ;
    else if (method === 'POST' && path.startsWith('/api/')) routeKey = API_WRITE;
    else if (method === 'PUT' && path.startsWith('/api/')) routeKey = API_PUT;

    if (routeKey === API_CUSTOMER_READ) {
      // The customer pool's authorizer: an access token that the customer pool issued, and nothing
      // else. A staff token is unknown to it, as a token of another issuer is to API Gateway.
      const held = customerPool.session(String(headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
      if (held === null) {
        sendGateway(response, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
        return;
      }
      const event = gatewayEvent({ routeKey, method, path, query, headers, host: consoleHost, claims: customerClaims({ sub: held.sub }) });
      sendResult(response, await customerApp(event));
    } else if (routeKey === API_TOKEN_READ || routeKey === API_TOKEN_WRITE || routeKey === API_TOKEN_PUT) {
      // No authorizer: the request goes to the function as it came, token and all.
      const body = await readBody(request, MAX_REQUEST_BYTES);
      if (body === null) {
        sendGateway(response, 413, 'Request Entity Too Large', { connection: 'close' });
        return;
      }
      sendResult(response, await app(gatewayEvent({ routeKey, method, path, query, headers, host: consoleHost, body })));
    } else if (routeKey !== API_READ && routeKey !== API_WRITE && routeKey !== API_PUT) {
      const named = customer ? CUSTOMER_HOST : home ? HOME_HOST : consoleHost;
      const event = gatewayEvent({ routeKey, method, path, query, headers, host: named });
      const result = await web(event);
      // versions.json, which cloud/deploy.sh writes into the site when it deploys: where this checkout has
      // none, the one it would write.
      if (result.statusCode === 404 && !home && versions !== null && /^\/assets\/[0-9a-f]{12}\/versions\.json$/.test(path)) {
        send(response, 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(versions));
        return;
      }
      sendResult(response, result);
    } else {
      // The JWT authorizer: a valid token that carries the scope of the route. The
      // token may come with or without the word Bearer.
      const session = signIn.session(String(headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
      if (session === null) {
        sendGateway(response, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
        return;
      }
      if (!session.scopes.includes(API_SCOPE)) {
        sendGateway(response, 403, 'Forbidden');
        return;
      }
      const body = await readBody(request, MAX_REQUEST_BYTES);
      if (body === null) {
        sendGateway(response, 413, 'Request Entity Too Large', { connection: 'close' });
        return;
      }
      // Whoever signed in: on the console's own page, either local user.
      sendResult(response,
        await callApi({
          method, path, query, headers, body, user: session.user, expiresAt: session.expiresAt, authTime: session.authTime,
        }));
    }
  }

  /** Answer a request, or say what API Gateway says when a function fails. */
  const serve = (handle) => (request, response) => {
    handle(request, response).catch((error) => {
      log({ level: 'error', event: 'preview_failed', error: String(error?.stack ?? error) });
      if (response.headersSent) response.destroy();
      else sendGateway(response, 500, 'Internal Server Error');
    });
  };

  function listen(server, onPort) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host, port: onPort, exclusive: true }, () => {
        server.off('error', reject);
        // Whatever was asked for: nothing is served from an address other than this one.
        const bound = server.address();
        if (bound.address === host) resolve(bound.port);
        else reject(new Error(`Listening on ${bound.address}, not on ${host}`));
      });
    });
  }

  const consoleServer = createServer(serve(gateway));
  const loginServer = createServer(serve(signIn.handle));

  async function stop() {
    for (const timer of timers) clearInterval(timer);
    terminal?.close();
    for (const server of [consoleServer, loginServer]) {
      if (!server.listening) continue;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  try {
    consoleHost = `${host}:${await listen(consoleServer, port)}`;
    // Where the API's presigned URLs for the APKs point: the local S3 above.
    fake.setS3Endpoint(`http://${consoleHost}/local-s3`);
    loginHost = `${host}:${await listen(loginServer, port === 0 ? 0 : port + 1)}`;
    const stage = createStage({
      fake, clock, boards, callApi, tick, say: (text) => narrate(text), customers: { store: customers, pool: customerPool },
    });
    await SCENARIOS[scenario].build(stage);
    stage.catchUp();
  } catch (error) {
    await stop();
    if (error?.code !== 'EADDRINUSE') throw error;
    throw new UsageError(`Port ${port} or ${port + 1} on ${host} is in use. Choose another with --port.`);
  }
  clock.present();
  for (const board of boards) board.heartbeat();
  narrate = say;

  // From here on requests are answered.
  web = createWebHandler({
    clientId: config.userPoolClientId,
    loginOrigin: `http://${loginHost}`,
    scope: CLIENT_SCOPES.join(' '),
    userPoolId: config.userPoolId,
    // The stand-in for the user pool API answers on the login origin.
    idpOrigin: `http://${loginHost}`,
    redirectUri: `http://${consoleHost}/`,
    homeHosts: home ? [HOME_HOST] : [],
    customer: { hosts: [CUSTOMER_HOST], userPoolId: CUSTOMER_POOL_ID, clientId: CUSTOMER_CLIENT_ID },
    log: (line) => log({ function: 'web', ...line }),
  });

  let beats = 0;
  timers.push(setInterval(() => {
    beats += 1;
    // Every tenth heartbeat is 5 minutes on: the diagnostics report of the boards that send one.
    for (const board of boards) {
      if (beats % 10 === 0) board.passTime(clock.now());
      else board.heartbeat();
    }
    // The stand-ins keep every call for tests to look at. Nobody looks here.
    fake.calls.length = 0;
    customers.calls.length = 0;
    customerPool.calls.length = 0;
  }, HEARTBEAT_MS));
  timers.push(setInterval(() => {
    tick().catch((error) => log({ level: 'error', event: 'rollouts_not_advanced', error: String(error?.stack ?? error) }));
  }, ROLLOUT_TICK_MS));
  if (live) {
    timers.push(setInterval(() => {
      for (const board of boards) board.tick();
    }, LIVE_TICK_MS));
  }
  // The boards answer the console's commands, and the alerts are checked every 5 minutes, as when deployed.
  fake.onCommand((thing, payload) => answerCommand(fake, boards.find((board) => board.thing === thing), payload, narrate));
  let mailed = fake.alertEmails.length;
  timers.push(setInterval(() => {
    fake.checkAlerts().then(() => {
      for (const mail of fake.alertEmails.slice(mailed)) say(`e-mail alert (not sent): ${mail.subject}`);
      mailed = fake.alertEmails.length;
    }, () => {});
  }, ALERT_CHECK_MS));

  return {
    consoleUrl: `http://${consoleHost}/`,
    loginOrigin: `http://${loginHost}`,
    scenario,
    user,
    live,
    home,
    customer,
    fake,
    customers,
    customerPool,
    boards,
    signIn,
    stop,

    /** Take the boards' buttons from the lines of a stream, such as the terminal. */
    takeButtons(input, print) {
      terminal = createInterface({ input });
      terminal.on('line', (line) => {
        const answer = pressButton(boards, line);
        if (answer !== null) print(answer);
      });
    },
  };
}

// The command line.

const USAGE = `Usage: node cloud/dev/preview.mjs [options]

  --scenario <name>   start in the state this scenario builds (default: empty)
  --viewer            the AWS sign-in page signs in the viewer instead of the release
                      manager (the console's own page signs in whoever's address is typed)
  --live              let the boards act by themselves; type 1 or 2 to press a button
  --home              serve the public home page instead of the console
  --customer          serve the customer site, with the console as admin mode at /admin
                      (try it with --scenario customers)
  --port <number>     port of the console (default ${DEFAULT_PORT}); sign-in uses the next one
  --host <address>    a loopback address (default ${DEFAULT_HOST}); any other is refused
  --repeated-cancel <how>
                      what the stand-in for AWS does when a deployment that was cancelled
                      without force is cancelled again with force while a board is at
                      work, which AWS does not document: refused (default), accepted
                      (the board is stopped) or ignored (accepted, and nothing changes)
  --verbose           print the log lines of the two functions
  --help              show this text

Scenarios:
${Object.entries(SCENARIOS).map(([name, { summary }]) => `  ${name.padEnd(20)}${summary}`).join('\n')}
`;

/** The options the preview was started with. Throws a UsageError for anything else. */
export function parseArguments(argv) {
  const options = {
    scenario: 'empty', viewer: false, live: false, home: false, customer: false, verbose: false, help: false,
    host: DEFAULT_HOST, port: DEFAULT_PORT, repeatedCancel: REPEATED_CANCEL[0],
  };
  // "--port=8000" is "--port 8000".
  const words = argv.flatMap((word) => {
    const mark = /^--[a-z][a-z-]*=/.test(word) ? word.indexOf('=') : -1;
    return mark === -1 ? [word] : [word.slice(0, mark), word.slice(mark + 1)];
  });
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const value = () => {
      index += 1;
      if (index >= words.length) throw new UsageError(`${word} needs a value.`);
      return words[index];
    };
    if (word === '--scenario') {
      options.scenario = value();
    } else if (word === '--host') {
      options.host = value();
    } else if (word === '--repeated-cancel') {
      options.repeatedCancel = value();
    } else if (word === '--port') {
      const text = value();
      if (!/^\d{1,5}$/.test(text)) throw new UsageError('The port must be a number.');
      options.port = Number(text);
    } else if (word === '--viewer') {
      options.viewer = true;
    } else if (word === '--live') {
      options.live = true;
    } else if (word === '--home') {
      options.home = true;
    } else if (word === '--customer') {
      options.customer = true;
    } else if (word === '--verbose') {
      options.verbose = true;
    } else if (word === '--help' || word === '-h') {
      options.help = true;
    } else {
      throw new UsageError(`Unknown option: ${word}`);
    }
  }
  return options;
}

function banner({ consoleUrl, loginOrigin, user, scenario, live, home, customer }) {
  if (customer) {
    return `
  Cranium customer site: LOCAL PREVIEW

    Customer site  ${consoleUrl}
    Admin mode     ${consoleUrl}admin  (the console, signed in with the admin sign-in)
    Sign-in        emulated at ${loginOrigin}
                   customers of the "customers" scenario: ada@${MAIL_DOMAIN}, ben@${MAIL_DOMAIN},
                   password ${PREVIEW_CUSTOMER_PASSWORD}; cleo@${MAIL_DOMAIN} has the invitation's
                   password ${PREVIEW_TEMPORARY_PASSWORD} and chooses her own
                   admins on "Admin sign-in": ${USERS.manager.email} or ${USERS.viewer.email},
                   password ${PREVIEW_PASSWORD}, code ${PREVIEW_CODE}
    Scenario       ${scenario}
                   ${SCENARIOS[scenario].summary}

  The pages are served by the real web function, as the host name ${CUSTOMER_HOST}, and the
  customer API is the real one, behind a stand-in for the customer pool's authorizer.

  Stop with Ctrl+C.
`;
  }
  if (home) {
    return `
  Cranium home page: LOCAL PREVIEW

    Home page   ${consoleUrl}

  The page is served by the real web function, as the host name ${HOME_HOST}. Its
  links go to the real addresses of the console and the repository.

  Stop with Ctrl+C.
`;
  }
  const boards = live
    ? 'live: type 1 or 2 and Enter to press that button on a waiting board'
    : 'stay where the scenario left them (--live lets them act)';
  return `
  Cranium firmware console: LOCAL PREVIEW

  This is not the deployed console, and it is not connected to AWS. The API runs in
  this process against an in-memory stand-in, sign-in is emulated with a made-up password
  and code, and the boards are simulated. Everything shown was built by the scenario or
  done in this session, and is gone when the preview stops.

    Console     ${consoleUrl}
    Sign-in     emulated at ${loginOrigin}
                on the console's page: ${USERS.manager.email} (${USERS.manager.role})
                or ${USERS.viewer.email} (${USERS.viewer.role}),
                password ${PREVIEW_PASSWORD}, code ${PREVIEW_CODE}
                "Use the AWS sign-in page": ${user.email} (${user.role}), at once
    Scenario    ${scenario}
                ${SCENARIOS[scenario].summary}
    Boards      ${boards}
    Firmware    accepts the images in cloud/api/test/fixtures that are signed with
                test_signing_pub.pem, for example valid-1.2.3+5.signed.bin

  Stop with Ctrl+C.
`;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(USAGE);
      return;
    }
    const print = (text) => console.log(`  ${text}`);
    const preview = await createPreview({
      ...options,
      log: (line) => {
        if (options.verbose || line.level === 'error') console.log(JSON.stringify(line));
      },
      say: print,
    });
    console.log(banner(preview));
    if (options.live) preview.takeButtons(process.stdin, print);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => preview.stop().then(() => process.exit(0)));
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  }
}

// Started as a program, not imported. The path is compared resolved: Node gives the
// module its real location, also when it was started through a symbolic link.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
