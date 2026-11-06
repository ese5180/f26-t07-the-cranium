/**
 * SideStore sources for the iPhone app (lib/sidestore.mjs, docs/mobile-apps.md "Updates on every phone").
 *
 * A member's own source link, made and turned off on the website (a session, never an API token, as
 * for API tokens; every member, viewers too, since every member may download the app):
 *
 *   GET  /api/apps/sidestore           { source: { id, createdAt, lastUsedAt } | null }
 *   POST /api/apps/sidestore           a new link, shown this once: { source, url, add }, where `add` is
 *                                      the sidestore:// link that adds it; the member's link of before
 *                                      stops working at the same moment (app.source_create)
 *   POST /api/apps/sidestore/revoke    the member's link stops working (app.source_revoke)
 *
 * And what SideStore asks for, with no sign-in at all (the gateway route GET /api/sidestore/{proxy+}
 * has no authorizer: infra/template.yaml). The key in the address is the credential:
 *
 *   GET /api/sidestore/<key>/source.json              the source (lib/sidestore.mjs buildSource)
 *   GET /api/sidestore/<key>/cranium-ios-<v>.ipa      302 to a presigned S3 GET of that release,
 *                                                     made now and good for 5 minutes
 *
 * Each use of a key counts against SOURCE_USES_PER_MINUTE, and Cognito is asked whether its owner is
 * still an active member of the console. A key that is malformed, unknown or turned off, and one whose
 * owner is no longer a member, all get the same 404, which names nothing. Those requests leave no entry
 * in the activity log, as a request with a dead API token leaves none (app.mjs): whoever holds a dead
 * link could otherwise fill the log in someone's name. A download through a live key goes on record as
 * app.ios_download in its owner's name, with `via: sidestore` and the key's id; reading the source does
 * not, as SideStore reads it every time it looks for updates.
 */

import { HttpError, conflict, notFound, redirect } from '../http.mjs';
import {
  SOURCE_FILE,
  SOURCE_LINK_SECONDS,
  SOURCE_USES_PER_MINUTE,
  buildSource,
  newSourceKey,
  presentSource,
  sourceDigest,
  sourceKeyOf,
  sourceLinks,
  versionOfIpaFile,
} from '../lib/sidestore.mjs';

const MINUTE_MS = 60_000;
const ID = /^[0-9a-f]{16}$/;

function unknownSource() {
  return notFound(
    'unknown_source',
    'There is no SideStore source at this address: it was turned off or replaced, ' +
      "or its owner is no longer a member. Make a new one on the console's Apps page."
  );
}

function noSource() {
  return notFound('no_source', 'You have no SideStore link that works. Make one on the Apps page.');
}

function iso(ms) {
  return new Date(ms).toISOString();
}

export function createSidestoreHandlers({ aws, config, now, randomHex, directory }, { apps, audit }) {
  /** A fresh id; ids are public handles, so the deterministic source of the tests will do. */
  function drawId() {
    const id = String(randomHex(8)).slice(0, 16);
    if (!ID.test(id)) throw new Error('No usable source id was drawn');
    return id;
  }

  /** The member's link that works, as stored: the item that names it, or null. */
  async function activeOwner(sub) {
    const owner = await aws.getSourceOwner(sub);
    return owner !== null && owner.revokedAt === null && typeof owner.digest === 'string' ? owner : null;
  }

  /** The owner of a live key: their sub and e-mail address, as Cognito says now. A former member's key is unknown. */
  async function liveOwner(sub) {
    try {
      const account = await directory.liveAccount(sub);
      if (account.groups.length === 0) throw unknownSource();
      return account;
    } catch (error) {
      if (error instanceof HttpError && error.status === 403) throw unknownSource();
      throw error;
    }
  }

  async function source({ key }) {
    const releases = await apps.iosReleases();
    return { body: buildSource({ consoleUrl: config.consoleUrl, key, releases }) };
  }

  async function download({ version, used, owner, request }) {
    const entry = { target: version, detail: { via: 'sidestore', source: used.id } };
    let link = null;
    let failure = null;
    try {
      link = await apps.iosLink(version, SOURCE_LINK_SECONDS);
      entry.detail.sha256 = link.release.sha256;
    } catch (error) {
      failure = error;
    }
    const outcome =
      failure === null ? 'ok' : failure instanceof HttpError && failure.status < 500 ? 'rejected' : 'error';
    if (failure !== null) entry.detail.code = failure instanceof HttpError ? failure.code : 'internal_error';
    const recorded = await audit.record({
      at: now(),
      requestId: request.id,
      actor: { sub: used.ownerSub, email: owner.email },
      action: 'app.ios_download',
      target: entry.target,
      outcome,
      detail: entry.detail,
    });
    if (failure !== null) throw failure;
    if (!recorded) {
      throw new HttpError(
        500,
        'audit_failed',
        'The download could not be written to the activity log, so it was not ' + 'handed out. Try again in a moment.'
      );
    }
    return { response: redirect(link.url) };
  }

  return {
    async get({ caller }) {
      const owner = await activeOwner(caller.sub);
      if (owner === null) return { body: { source: null, perMinute: SOURCE_USES_PER_MINUTE } };
      const key = await aws.getSourceKey(owner.digest);
      return {
        body: {
          source: presentSource({ ...owner, lastUsedAt: key?.lastUsedAt ?? null }),
          perMinute: SOURCE_USES_PER_MINUTE,
        },
      };
    },

    async create({ caller, entry }) {
      const previous = await activeOwner(caller.sub);
      const key = newSourceKey();
      const at = iso(now());
      const record = { digest: sourceDigest(key), id: drawId(), createdAt: at };
      entry.target = record.id;
      if (previous !== null) entry.detail.replaced = previous.id;
      const stored = await aws.replaceSourceKey({
        sub: caller.sub,
        key: record,
        previous: previous?.digest ?? null,
        at,
      });
      if (!stored.ok) {
        throw conflict(
          'source_conflict',
          'Your SideStore link was being changed at the same moment elsewhere. Try again.'
        );
      }
      const links = sourceLinks(config.consoleUrl, key);
      return {
        status: 201,
        body: { source: presentSource({ ...record, lastUsedAt: null }), url: links.url, add: links.add },
      };
    },

    async revoke({ caller, entry }) {
      const owner = await activeOwner(caller.sub);
      if (owner === null) throw noSource();
      entry.target = owner.id;
      const done = await aws.revokeSourceKey({ sub: caller.sub, digest: owner.digest, at: iso(now()) });
      if (!done.ok) throw noSource();
      return { body: { source: null } };
    },

    /**
     * A request under /api/sidestore/, from SideStore: `segments` is its path, ["api", "sidestore", key,
     * file]. Returns { name, response } (the route's name for the log line, which never holds the key) or
     * { name, body }; `request.sub` and `request.source` are set once the key is found to be live.
     */
    async serve({ segments, request }) {
      const [, , segment, file, ...rest] = segments;
      const version = versionOfIpaFile(file);
      const name =
        file === SOURCE_FILE
          ? 'GET /api/sidestore/{key}/source.json'
          : version !== null
            ? 'GET /api/sidestore/{key}/{ipa}'
            : 'GET /api/sidestore/unmatched';
      request.routeName = name;
      if (rest.length > 0 || (file !== SOURCE_FILE && version === null)) {
        throw notFound('not_found', 'There is nothing at this address.');
      }
      const key = sourceKeyOf(segment);
      if (key === null) throw unknownSource();
      const at = now();
      const used = await aws.useSourceKey({
        digest: sourceDigest(key),
        window: Math.floor(at / MINUTE_MS),
        max: SOURCE_USES_PER_MINUTE,
        at: iso(at),
      });
      if (!used.ok) {
        if (used.reason === 'limit') {
          throw new HttpError(
            429,
            'rate_limited',
            `A SideStore source is read at most ${SOURCE_USES_PER_MINUTE} times a ` + 'minute. Try again in a minute.'
          );
        }
        throw unknownSource();
      }
      request.source = typeof used.key?.id === 'string' ? used.key.id : null;
      if (typeof used.key?.ownerSub !== 'string') throw unknownSource();
      const owner = await liveOwner(used.key.ownerSub);
      request.sub = used.key.ownerSub;
      if (version === null) return source({ key });
      return download({ version, used: used.key, owner, request });
    },
  };
}
