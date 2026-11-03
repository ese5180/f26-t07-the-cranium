/**
 * Who is calling, and what they may do.
 *
 * API Gateway has already verified the access token's signature, issuer, audience,
 * expiry and scope, offline. This module checks what the gateway does not: that the
 * token is an access token of this console's app client, and which groups the caller
 * is in.
 *
 * The gateway does not pass cognito:groups on as an array. It flattens the claim into
 * one string such as "[release-managers viewers]". parseGroups is the only place that
 * reads it, and group names are compared whole, never as substrings.
 *
 * A token is valid for up to an hour, so it cannot prove that its owner is still
 * allowed to change things. Every write therefore asks Cognito at that moment whether
 * the user is enabled, confirmed and a release manager, and Cognito's answer is the
 * one that counts: a user who lost the role cannot write with the old token, and a
 * user who was given it can write without signing in again.
 *
 * Reads ask too, but a page polls every few seconds, so the answer is kept for a minute
 * per user. Removing or disabling an account therefore stops reading within a minute.
 * If Cognito cannot be asked, a read goes on, unless the last answer for this user was
 * a refusal, and the failure is logged. The token is still one the gateway verified and
 * nothing changes through a read, while refusing would take the console away from
 * everybody during a Cognito outage, just when a release manager may need to watch a
 * deployment. A write in the same situation fails.
 *
 * A personal API token (handlers/tokens.mjs) carries no claims at all: it names its owner,
 * and Cognito is asked on every request which groups that owner is in now. Its reads are
 * not let through on an old answer, and fail when Cognito cannot be asked.
 *
 * What neither check can see is whether a token was signed out. The gateway only looks at
 * the signature, and Cognito cannot be asked: the console revokes its own refresh token at
 * sign-in, so to Cognito every live token already counts as revoked. A token copied before
 * a sign-out works until it expires, for as long as its account exists. cloud/users.sh
 * reset-mfa and remove end that, because they end the account.
 */

import { describeError, forbidden, unauthorized } from './http.mjs';

export const VIEWERS = 'viewers';
export const RELEASE_MANAGERS = 'release-managers';
const CONSOLE_GROUPS = Object.freeze([RELEASE_MANAGERS, VIEWERS]);

// A Cognito sub is a UUID. Anything outside this set is not an identity of this pool.
const SUB = /^[A-Za-z0-9_.:-]{1,128}$/;

const EMAIL_CACHE_MS = 5 * 60 * 1000;
// How long a read goes by the last answer from Cognito, and how long it does not ask
// again after Cognito could not be asked, so that an outage delays few requests.
const READ_CHECK_MS = 60 * 1000;
const READ_RETRY_MS = 30 * 1000;

/**
 * The group names in a cognito:groups claim. Accepts a real array; otherwise strips
 * one leading "[" and one trailing "]" and splits on whitespace only.
 */
export function parseGroups(claim) {
  if (Array.isArray(claim)) {
    return claim.filter((name) => typeof name === 'string' && name !== '');
  }
  if (typeof claim !== 'string') return [];
  let text = claim;
  if (text.startsWith('[')) text = text.slice(1);
  if (text.endsWith(']')) text = text.slice(0, -1);
  return text.split(/\s+/).filter((name) => name !== '');
}

/** The claims the JWT authorizer attached to the request, or null. */
function claimsOf(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  return claims !== null && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
}

/** The sub the request's token names, if it has a usable one. Proves nothing. */
export function claimedSub(event) {
  const sub = claimsOf(event)?.sub;
  return typeof sub === 'string' && SUB.test(sub) ? sub : '';
}

/**
 * Identify the caller, or throw 401. Fails closed: anything missing or unexpected is
 * a refusal. `clientIds` is the app client, or the list of them, whose tokens count:
 * the console's and the phone apps'. `clientId` in the answer says which one the token
 * was made for, so that a route can take one of them only (app.mjs).
 */
export function authenticate(event, clientIds) {
  const claims = claimsOf(event);
  if (claims === null) throw unauthorized();
  const accepted = (Array.isArray(clientIds) ? clientIds : [clientIds])
    .filter((id) => typeof id === 'string' && id !== '');
  if (accepted.length === 0) throw unauthorized();
  if (claims.token_use !== 'access' || !accepted.includes(claims.client_id)) throw unauthorized();
  if (typeof claims.sub !== 'string' || !SUB.test(claims.sub)) throw unauthorized();

  const groups = parseGroups(claims['cognito:groups']);
  return {
    sub: claims.sub,
    // Only the two groups of this console matter; other names are not echoed.
    groups: CONSOLE_GROUPS.filter((name) => groups.includes(name)),
    expiresAt: numericClaim(claims.exp),
    clientId: claims.client_id,
  };
}

/** The gateway passes numeric claims on as strings. */
function numericClaim(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) return Number(value);
  return null;
}

/** An e-mail address as Cognito holds it, or '' if it is not fit to show or store. */
function displayEmail(value) {
  return typeof value === 'string' && value.length <= 320 && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value) ? value : '';
}

function noAccess() {
  return forbidden('forbidden', 'Your account has no access to this console. Ask a release manager to add you.');
}

function inactive() {
  return forbidden('account_inactive', 'Your account is disabled or not confirmed.');
}

/** Whether Cognito's answer describes an account that may sign in at all. */
function isActive(user) {
  return user !== null && user.enabled === true && user.status === 'CONFIRMED';
}

/** Every route is for members of the console's groups only. */
export function requireMember(caller) {
  if (caller.groups.length === 0) throw noAccess();
}

/**
 * The part of authorization that needs Cognito.
 *
 * @param {object} deps
 * @param {object} deps.aws    the AWS adapter (getUser, listUserGroups)
 * @param {() => number} deps.now
 */
export function createDirectory({ aws, now, log = () => {} }) {
  const emails = new Map();
  // sub -> { refusal: null | () => HttpError, at }. Kept apart from the addresses, which
  // may be older, and never used for a write.
  const readers = new Map();
  let unreachableAt = null;

  function remember(sub, email) {
    if (emails.size >= 256) emails.clear();
    emails.set(sub, { email, at: now() });
  }

  /** Cognito failed a moment ago: do not wait for it again yet. */
  function unreachable() {
    return unreachableAt !== null && now() - unreachableAt < READ_RETRY_MS;
  }

  /**
   * The caller's e-mail address for display. Cached for five minutes; an empty string
   * when Cognito cannot say. Never throws: the address is not needed for any decision.
   */
  async function emailOf(sub) {
    const cached = emails.get(sub);
    if (cached !== undefined && now() - cached.at < EMAIL_CACHE_MS) return cached.email;
    try {
      const user = await aws.getUser(sub);
      const email = user === null ? '' : displayEmail(user.email);
      remember(sub, email);
      return email;
    } catch {
      return '';
    }
  }

  /** The address if it was looked up in the last five minutes, else ''. Asks nobody. */
  function knownEmail(sub) {
    const cached = emails.get(sub);
    return cached !== undefined && now() - cached.at < EMAIL_CACHE_MS ? cached.email : '';
  }

  /** What Cognito says now about a reader: a refusal to throw, or null. */
  async function askAboutReader(sub) {
    const [user, groups] = await Promise.all([aws.getUser(sub), aws.listUserGroups(sub)]);
    if (user !== null) remember(sub, displayEmail(user.email));
    if (!isActive(user)) return inactive;
    const member = Array.isArray(groups) && [RELEASE_MANAGERS, VIEWERS].some((name) => groups.includes(name));
    return member ? null : noAccess;
  }

  /**
   * Refuse a read if the caller's account is gone, disabled or in neither group by now.
   * Throws 403. The failure rule is at the top of this file.
   *
   * @param {{sub: string}} caller
   * @param {string} requestId  for the log line if Cognito cannot be asked
   */
  async function requireLiveReader(caller, requestId) {
    let known = readers.get(caller.sub);
    const stale = known === undefined || now() - known.at >= READ_CHECK_MS;
    if (stale && !unreachable()) {
      try {
        const refusal = await askAboutReader(caller.sub);
        unreachableAt = null;
        if (readers.size >= 256) readers.clear();
        known = { refusal, at: now() };
        readers.set(caller.sub, known);
      } catch (error) {
        unreachableAt = now();
        log({ level: 'warn', event: 'live_check_failed', requestId, sub: caller.sub, error: describeError(error) });
      }
    }
    if (known !== undefined && known.refusal !== null) throw known.refusal();
  }

  /**
   * Ask Cognito, now, about an account: its e-mail address and which of the console's
   * groups it is in. Throws 403 for an account that is gone, disabled or not confirmed.
   * A failure to ask is thrown as it is: the request fails.
   */
  async function liveAccount(sub) {
    const [user, groups] = await Promise.all([aws.getUser(sub), aws.listUserGroups(sub)]);
    const email = user === null ? '' : displayEmail(user.email);
    if (user !== null) remember(sub, email);
    if (!isActive(user)) throw inactive();
    return { email, groups: Array.isArray(groups) ? CONSOLE_GROUPS.filter((name) => groups.includes(name)) : [] };
  }

  /**
   * Ask Cognito, now, whether this caller may change things: the account is enabled
   * and confirmed, and it is in the release-managers group. The groups in the token do
   * not decide this; they only choose the words of the refusal. Returns the user's
   * e-mail address, or throws 403. A failure to ask is a failure of the request.
   */
  async function requireLiveWriter(caller) {
    const { email, groups } = await liveAccount(caller.sub);
    if (!groups.includes(RELEASE_MANAGERS)) {
      throw forbidden('release_manager_required', caller.groups.includes(RELEASE_MANAGERS)
        ? 'You are no longer a release manager.'
        : 'Only release managers can do this.');
    }
    return email;
  }

  /**
   * The same, for a change that any member may make to what is their own (their API
   * tokens): the account is active and in one of the console's groups, now.
   */
  async function requireLiveMember(caller) {
    const { email, groups } = await liveAccount(caller.sub);
    if (groups.length === 0) throw noAccess();
    return email;
  }

  return {
    emailOf, knownEmail, unreachable, liveAccount, requireLiveReader, requireLiveWriter, requireLiveMember,
  };
}
