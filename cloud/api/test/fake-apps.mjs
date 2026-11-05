// An in-memory stand-in for src/aws-apps.mjs: the phone apps' releases and the SideStore sources
// (docs/mobile-apps.md), with the same inputs, outputs and failure modes. test/fake-aws.mjs adds it to its own stand-in, so
// that every test console and the preview have it.
//
// It also plays S3 for the APKs and IPAs, as far as the console depends on it. The URLs it hands out are
// real presigned URLs (src/lib/presign.mjs), signed with made-up credentials, and S3's side of
// them is played by s3Request: it checks the signature, with the headers that came, the time,
// and on a PUT the bytes against x-amz-checksum-sha256, and keeps every version of an object, as
// the firmware bucket does.
//
//   fake.s3Request({ method, url, headers, body })  -> { status, headers, body }   S3 answering a
//                                       request made with one of those URLs (body a Buffer)
//   fake.setS3Endpoint(base)            where the URLs point: by default the bucket's address at
//                                       AWS; the preview and the script's test give a local one,
//                                       such as http://127.0.0.1:8787/local-s3
//   fake.storeApk(key, body, { checksum })   an object put some other way: with checksum false it
//                                       has none of its own, as after a multipart upload
//   fake.apkVersions(key)               the versions of an object, oldest first: { versionId, size, sha256 }
//                                       (an IPA's too: storeApk and apkVersions take any key)
//   fake.appItems                       the records, sk -> item
//   fake.sourceItems                    the SideStore keys and members' items, sk -> item
//
// This file is test and preview code. It is never packaged with the function.

import { createHash } from 'node:crypto';

import { APK_TYPE, APP_PK, APP_PLATFORMS } from '../src/lib/apps.mjs';
import { presignUrl } from '../src/lib/presign.mjs';
import { SOURCE_PK, sourceKeySk, sourceOwnerSk } from '../src/lib/sidestore.mjs';

const CREDENTIALS = Object.freeze({
  accessKeyId: 'ASIAFAKEFAKEFAKEFAKE',
  secretAccessKey: 'made-up-secret-for-the-stand-in-only',
  sessionToken: 'made-up-session-token',
});
const PLATFORMS = APP_PLATFORMS;

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest();
}

/** Epoch milliseconds from 20130524T000000Z, or NaN. */
function fromAmzDate(text) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(text ?? '');
  return match ? Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]) : NaN;
}

function s3Error(status, code) {
  return { status, headers: { 'content-type': 'application/xml' }, body: Buffer.from(`<Error><Code>${code}</Code></Error>`) };
}

/**
 * @param {object} options
 * @param {() => number} options.clock   epoch milliseconds
 * @param {string} [options.bucket]
 * @param {string} [options.region]
 */
export function createFakeApps({ clock, bucket = 'local-firmware', region = 'us-east-1' }) {
  const items = new Map();      // sk -> item
  const sources = new Map();    // sk -> item, pk SRC
  const pointers = new Map();   // platform -> { sk, versionCode }
  const objects = new Map();    // key -> [{ versionId, body, sha256Base64 | null }], oldest first
  let endpoint = { protocol: 'https', host: `${bucket}.s3.${region}.amazonaws.com`, pathPrefix: '' };
  let versionsDrawn = 0;

  function store(key, body, sha256Base64) {
    versionsDrawn += 1;
    const versionId = createHash('sha256').update(`${key} ${versionsDrawn}`).digest('base64url').slice(0, 32);
    const list = objects.get(key) ?? [];
    list.push({ versionId, body: Buffer.from(body), sha256Base64 });
    objects.set(key, list);
    return versionId;
  }

  function sign(method, key, extra) {
    return presignUrl({ method, ...endpoint, key, region, credentials: CREDENTIALS, at: clock(), ...extra });
  }

  /** What S3 does with a request made with a presigned URL. */
  function s3Request({ method, url, headers = {}, body = Buffer.alloc(0) }) {
    let address;
    try {
      address = new URL(url);
    } catch {
      return s3Error(400, 'InvalidURI');
    }
    const prefix = `${endpoint.pathPrefix}/`;
    if (address.host !== endpoint.host || !address.pathname.startsWith(prefix)) return s3Error(404, 'NoSuchBucket');
    const key = address.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
    const params = new URLSearchParams(address.search);
    const at = fromAmzDate(params.get('X-Amz-Date'));
    const expiresIn = Number(params.get('X-Amz-Expires'));
    const named = (params.get('X-Amz-SignedHeaders') ?? '').split(';').filter((name) => name !== 'host');
    const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
    if (named.some((name) => lower[name] === undefined)) return s3Error(403, 'SignatureDoesNotMatch');
    const query = {};
    for (const [name, value] of params) if (!name.startsWith('X-Amz-')) query[name] = value;
    let expected;
    try {
      expected = sign(method, key, {
        at, expiresIn, headers: Object.fromEntries(named.map((name) => [name, lower[name]])), query,
      }).url;
    } catch {
      return s3Error(403, 'AuthorizationQueryParametersError');
    }
    if (new URL(expected).searchParams.get('X-Amz-Signature') !== params.get('X-Amz-Signature')) {
      return s3Error(403, 'SignatureDoesNotMatch');
    }
    if (clock() > at + expiresIn * 1000) return s3Error(403, 'AccessDenied');

    if (method === 'PUT') {
      if (lower['content-length'] !== undefined && Number(lower['content-length']) !== body.length) {
        return s3Error(400, 'IncompleteBody');
      }
      const given = lower['x-amz-checksum-sha256'];
      if (given !== undefined && given !== sha256(body).toString('base64')) return s3Error(400, 'BadDigest');
      const versionId = store(key, body, given ?? null);
      return { status: 200, headers: { 'x-amz-version-id': versionId }, body: Buffer.alloc(0) };
    }
    if (method === 'GET') {
      const list = objects.get(key) ?? [];
      const wanted = query.versionId;
      const found = wanted === undefined ? list.at(-1) : list.find((version) => version.versionId === wanted);
      if (found === undefined) return s3Error(404, wanted === undefined ? 'NoSuchKey' : 'NoSuchVersion');
      return {
        status: 200,
        headers: {
          'content-type': query['response-content-type'] ?? 'binary/octet-stream',
          'content-disposition': query['response-content-disposition'] ?? '',
          'content-length': String(found.body.length),
          'x-amz-version-id': found.versionId,
        },
        body: found.body,
      };
    }
    return s3Error(405, 'MethodNotAllowed');
  }

  function platformOf(name) {
    if (!PLATFORMS.includes(name)) throw new TypeError(`No app platform ${name}`);
    return name;
  }

  const adapter = {
    async listAppReleases(platform) {
      platformOf(platform);
      return [...items.keys()].filter((sk) => sk.startsWith(`${platform}#`)).sort().reverse()
        .map((sk) => copy(items.get(sk)));
    },

    async getAppRelease(sk) {
      return items.has(sk) ? copy(items.get(sk)) : null;
    },

    async highestAppRelease(platform) {
      const top = pointers.get(platformOf(platform));
      return top === undefined ? null : { ...top };
    },

    async registerAppRelease({ sk, versionCode, release }) {
      const platform = platformOf(sk.slice(0, sk.indexOf('#')));
      if (items.has(sk)) return { ok: false, reason: 'exists' };
      const top = pointers.get(platform);
      if (top !== undefined && !(top.sk < sk && top.versionCode < versionCode)) {
        return { ok: false, reason: 'not_newer', highest: top.sk, versionCode: top.versionCode };
      }
      items.set(sk, copy({ ...release, pk: APP_PK, sk }));
      pointers.set(platform, { sk, versionCode });
      return { ok: true };
    },

    async headAppObject(key) {
      const current = (objects.get(key) ?? []).at(-1);
      if (current === undefined) return null;
      return {
        size: current.body.length,
        sha256Base64: current.sha256Base64,
        checksumType: current.sha256Base64 === null ? null : 'FULL_OBJECT',
        versionId: current.versionId,
      };
    },

    async presignAppUpload({ key, size, sha256Base64, expiresIn }) {
      const headers = { 'content-length': String(size), 'x-amz-checksum-sha256': sha256Base64 };
      const signed = sign('PUT', key, { expiresIn, headers });
      return { url: signed.url, headers, expiresAt: signed.expiresAt };
    },

    async presignAppDownload({ key, versionId, filename, expiresIn, contentType = APK_TYPE }) {
      const signed = sign('GET', key, {
        expiresIn,
        query: {
          versionId, 'response-content-disposition': `attachment; filename="${filename}"`, 'response-content-type': contentType,
        },
      });
      return { url: signed.url, expiresAt: signed.expiresAt };
    },

    async readAppObject({ key, versionId, start, end }) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
        throw new TypeError('Not a range the console reads');
      }
      const found = (objects.get(key) ?? []).find((version) => version.versionId === versionId);
      if (found === undefined) {
        const error = new Error('GetObject: NoSuchVersion');
        error.name = 'AwsError';
        error.code = 'failed';
        error.operation = 'GetObject';
        throw error;
      }
      // As S3 does: a range past the end is cut at the end.
      return Buffer.from(found.body.subarray(start, Math.min(end + 1, found.body.length)));
    },

    async getSourceOwner(sub) {
      const item = sources.get(sourceOwnerSk(sub));
      return item === undefined ? null : copy(item);
    },

    async getSourceKey(digest) {
      const item = sources.get(sourceKeySk(digest));
      return item === undefined ? null : copy(item);
    },

    async replaceSourceKey({ sub, key, previous, at }) {
      const newSk = sourceKeySk(key.digest);
      const ownerSk = sourceOwnerSk(sub);
      const owner = sources.get(ownerSk);
      if (sources.has(newSk)) return { ok: false, reason: 'conflict' };
      if (previous === null && owner !== undefined && owner.revokedAt === null) return { ok: false, reason: 'conflict' };
      if (previous !== null && (owner?.digest !== previous || owner.revokedAt !== null)) return { ok: false, reason: 'conflict' };
      const old = previous === null ? null : sources.get(sourceKeySk(previous));
      if (previous !== null && (old === undefined || old.ownerSub !== sub || old.revokedAt !== null)) {
        return { ok: false, reason: 'conflict' };
      }
      sources.set(newSk, {
        pk: SOURCE_PK, sk: newSk, id: key.id, ownerSub: sub, createdAt: key.createdAt,
        revokedAt: null, window: 0, uses: 0, lastUsedAt: null,
      });
      sources.set(ownerSk, { pk: SOURCE_PK, sk: ownerSk, digest: key.digest, id: key.id, createdAt: key.createdAt, revokedAt: null });
      if (old) old.revokedAt = at;
      return { ok: true };
    },

    async revokeSourceKey({ sub, digest, at }) {
      const owner = sources.get(sourceOwnerSk(sub));
      const item = sources.get(sourceKeySk(digest));
      if (owner?.digest !== digest || owner.revokedAt !== null || item?.ownerSub !== sub || item.revokedAt !== null) {
        return { ok: false, reason: 'not_active' };
      }
      owner.revokedAt = at;
      item.revokedAt = at;
      return { ok: true };
    },

    async useSourceKey({ digest, window, max, at }) {
      const item = sources.get(sourceKeySk(digest));
      if (item === undefined) return { ok: false, reason: 'unknown' };
      if (item.revokedAt !== null) return { ok: false, reason: 'revoked' };
      if (item.window === window) {
        if (!(item.uses < max)) return { ok: false, reason: 'limit' };
        item.uses += 1;
      } else if (item.window < window) {
        item.window = window;
        item.uses = 1;
      } else {
        return { ok: false, reason: 'limit' };
      }
      item.lastUsedAt = at;
      return { ok: true, key: copy(item) };
    },
  };

  const helpers = {
    appItems: items,
    sourceItems: sources,
    s3Request,
    setS3Endpoint(base) {
      const address = new URL(base);
      endpoint = {
        protocol: address.protocol.replace(':', ''), host: address.host, pathPrefix: address.pathname.replace(/\/$/, ''),
      };
    },
    storeApk(key, body, { checksum = true } = {}) {
      return store(key, body, checksum ? sha256(body).toString('base64') : null);
    },
    apkVersions(key) {
      return (objects.get(key) ?? []).map((version) => ({
        versionId: version.versionId, size: version.body.length, sha256: sha256(version.body).toString('hex'),
      }));
    },
  };

  return { adapter, helpers };
}
