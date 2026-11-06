/**
 * Personal API tokens: GET /api/tokens, POST /api/tokens, POST /api/tokens/{id}/revoke,
 * and the check of a token that comes with a request to /api/t/.
 *
 * Every member of the console, viewer or release manager, may make tokens for themselves
 * on the website, and only there: these three routes take a signed-in session and never
 * a token. A token acts as its owner. It grants nothing of its own: on every request
 * Cognito is asked whether the owner is still active and which groups they are in now,
 * so a person who is demoted, disabled or removed takes the power of their tokens with
 * them at once. A viewer's token can only read, and a write still needs a release
 * manager, now.
 *
 * What a token looks like and what is stored of it is in lib/tokens.mjs. In short: the
 * table holds its SHA-256, never the token, and neither is ever logged or sent back.
 */

import { HttpError, conflict, describeError, field, notFound } from '../http.mjs';
import {
  MAX_ACTIVE_TOKENS,
  MAX_TOKEN_DAYS,
  TOKEN_ID,
  bearerToken,
  expiryAfter,
  newToken,
  presentToken,
  sameDigest,
  tokenDigest,
  tokenFromItem,
  tokenStatus,
} from '../lib/tokens.mjs';
import { requireTokenDays, requireTokenId, requireTokenName } from '../lib/validate.mjs';

/**
 * The one answer to a request whose token does not count: missing, malformed, unknown,
 * revoked or expired alike, so that the answer tells nobody which.
 */
function tokenRefused() {
  return new HttpError(
    401,
    'invalid_token',
    'This API token is not valid: it is unknown, revoked or ' +
      'expired, or it was not sent as "Authorization: Bearer crn_…". Make a new one on the console.'
  );
}

function tooMany() {
  return conflict(
    'too_many_tokens',
    `You have ${MAX_ACTIVE_TOKENS} API tokens that are still valid, ` +
      'which is as many as one person may have. Revoke one you no longer use first.'
  );
}

/** The Authorization header of a request, as the gateway passes it on (names in lower case). */
function authorizationOf(event) {
  const headers = event?.headers;
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return null;
  return Object.hasOwn(headers, 'authorization') ? headers.authorization : null;
}

const byNewest = (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1);

export function createTokenHandlers({ aws, now, randomHex, log, directory }) {
  /** A person's tokens as records, newest first. Items that are not tokens of theirs are left out. */
  async function ownTokens(sub) {
    return (await aws.listTokens(sub))
      .map(tokenFromItem)
      .filter((token) => token !== null && token.ownerSub === sub)
      .sort(byNewest);
  }

  function activeCount(tokens) {
    const at = now();
    return tokens.filter((token) => tokenStatus(token, at) === 'active').length;
  }

  /** A fresh id; ids are public handles, so the deterministic source of the tests will do. */
  function drawId() {
    const id = String(randomHex(8)).slice(0, 16);
    if (!TOKEN_ID.test(id)) throw new Error('No usable token id was drawn');
    return id;
  }

  return {
    /**
     * Who sent a request to /api/t/: the owner of its token, as Cognito describes them now.
     * Fills in `request.token` ({ id, status }) once the token is found, for the log line,
     * and `request.sub` once it is found to be active, so that a refusal from then on goes on
     * record in its owner's name. A revoked or expired token names nobody: a request with
     * one leaves no entry in the activity log, only its log line (app.mjs), so that whoever
     * holds such a token cannot fill the log in its owner's name.
     *
     * @returns {{ caller: object, email: string }}  caller as auth.authenticate describes one
     */
    async authenticate(event, request) {
      const token = bearerToken(authorizationOf(event));
      if (token === null) throw tokenRefused();
      const digest = tokenDigest(token);
      const record = tokenFromItem(await aws.getToken(digest));
      if (record === null || !sameDigest(record.digest, digest)) throw tokenRefused();

      const status = tokenStatus(record, now());
      request.token = { id: record.id, status };
      if (status !== 'active') throw tokenRefused();
      request.sub = record.ownerSub;

      const account = await directory.liveAccount(record.ownerSub);
      return {
        caller: {
          sub: record.ownerSub,
          groups: account.groups,
          expiresAt: Math.floor(Date.parse(record.expiresAt) / 1000),
          token: record.id,
        },
        email: account.email,
      };
    },

    async list({ caller }) {
      const at = now();
      const tokens = (await ownTokens(caller.sub)).map((token) => presentToken(token, at));
      return { body: { tokens, limit: MAX_ACTIVE_TOKENS, maxDays: MAX_TOKEN_DAYS } };
    },

    async create({ caller, json, entry }) {
      const body = json();
      const name = requireTokenName(field(body, 'name'));
      entry.detail.name = name;
      const days = requireTokenDays(field(body, 'days'));
      entry.detail.days = String(days);

      if (activeCount(await ownTokens(caller.sub)) >= MAX_ACTIVE_TOKENS) throw tooMany();

      const token = newToken();
      const digest = tokenDigest(token);
      const at = now();
      const record = {
        id: drawId(),
        ownerSub: caller.sub,
        name,
        createdAt: new Date(at).toISOString(),
        expiresAt: expiryAfter(at, days),
        revokedAt: null,
      };
      const stored = await aws.putToken({ sk: digest, token: record });
      // 256 random bits do not repeat; if they ever did, nothing is replaced.
      if (!stored.ok) throw new Error('A token with the same digest is stored already');
      entry.target = record.id;

      // Two requests at the same moment both find room for one more. Each looks again
      // once its own token is stored, and withdraws it if that made too many.
      let crowded = false;
      try {
        crowded = activeCount(await ownTokens(caller.sub)) > MAX_ACTIVE_TOKENS;
      } catch (error) {
        // The count was right a moment ago; this second look only narrows a race.
        log({ level: 'warn', event: 'token_recheck_failed', id: record.id, error: describeError(error).message });
      }
      if (crowded) {
        await aws.markTokenRevoked({ sk: digest, ownerSub: caller.sub, at: new Date(now()).toISOString() });
        entry.detail.withdrawn = 'true';
        throw tooMany();
      }

      return {
        status: 201,
        body: {
          token,
          id: record.id,
          name,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
        },
      };
    },

    async revoke({ caller, params, entry }) {
      const id = requireTokenId(params.id);
      entry.target = id;
      // Only the caller's own tokens are looked at, so another person's id is unknown here.
      const found = (await ownTokens(caller.sub)).find((token) => token.id === id);
      if (found === undefined) throw notFound('unknown_token', 'You have no API token with that id.');
      entry.detail.name = found.name;
      const already = () => conflict('token_already_revoked', `The token "${found.name}" is revoked already.`);
      if (found.revokedAt !== null) throw already();

      const at = new Date(now()).toISOString();
      const marked = await aws.markTokenRevoked({ sk: found.digest, ownerSub: caller.sub, at });
      if (!marked.ok) throw already();
      const token = tokenFromItem(marked.token) ?? { ...found, revokedAt: at };
      return { body: { token: presentToken(token, now()) } };
    },
  };
}
