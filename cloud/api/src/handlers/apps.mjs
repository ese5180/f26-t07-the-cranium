/**
 * The phone apps on the console (docs/mobile-apps.md, "The Apps page").
 *
 *   GET  /api/apps                                the Android releases, newest first, and the iPhone
 *                                                 app's version and note; any member
 *   GET  /api/apps/config                         the apps' configuration, as apps/config/cranium.json;
 *                                                 any member
 *   POST /api/apps/android/uploads                a URL to PUT an APK to; release managers (app.upload)
 *   POST /api/apps/android/releases/{version}     the APK that arrived is checked and published; release
 *                                                 managers (app.publish)
 *   GET  /api/apps/android/{version}/download     a link to download it; any member (app.download)
 *
 * An APK is far bigger than API Gateway takes (10 MB), so it never passes through the API. A
 * publish is two calls with the file in between: the first hands out a presigned PUT for exactly
 * that size and that SHA-256, good for 15 minutes; the build sends the file straight to S3 with
 * it; the second asks S3 what arrived (HeadObject with its checksum) and registers the release
 * only if it is that size and that SHA-256. Both calls carry the same description of the APK:
 * { version, versionCode, sha256, size, notes }, the version in the address for the second.
 *
 * A version is accepted once and only upward, by its version and by its versionCode: both are
 * checked before a URL is handed out, and again, in one transaction, when the release is
 * registered (lib/apps.mjs).
 *
 * A download is a presigned GET of the very S3 version that was checked when it was published,
 * good for 15 minutes, with the APK's name as its Content-Disposition. Every link handed out goes
 * on record, with `via: qr` for the one the Apps page draws as a QR code for a phone to scan:
 * whoever holds the link in those 15 minutes can download the APK without signing in, which is
 * the point of it. The APK holds this console's address and its public client IDs, nothing
 * secret, and it signs nobody in by itself.
 *
 * withConsole wraps GET /api/me: the console's own version and commit, from the versions this
 * deployment was built with (lib/versions.mjs), go with who is signed in.
 */

import { HttpError, badRequest, conflict, field, notFound, unprocessable } from '../http.mjs';
import {
  ANDROID, APP_REDIRECT_URI, LINK_SECONDS, apkKey, apkName, appReleaseFromItem, appReleaseKey, checksumHex,
  compareAppVersions, objectVersionOf, parseAppVersion, requireApkDescription, requireAppVersion, versionOfAppKey,
} from '../lib/apps.mjs';
import { readBundledVersions } from '../lib/versions.mjs';

function iso(ms) {
  return new Date(ms).toISOString();
}

function versionExists(version) {
  return conflict('version_exists',
    `Android app ${version} is on the console already. A version is published once and never replaced.`);
}

function versionNotNewer(version, highest) {
  return unprocessable('version_not_newer', highest === null
    ? `Version ${version} is not newer than the Android app on the console.`
    : `Version ${version} is not newer than ${highest}, the newest Android app published. Versions only go up.`);
}

function codeNotHigher(code, highest) {
  return unprocessable('version_code_not_higher', `versionCode ${code} is not higher than ${highest}, the newest ` +
    'Android app\'s. Android installs an update only over a lower versionCode: raise craniumVersionCode.');
}

/** What the activity log keeps of an APK: never the note, which is on the release. */
function describe(entry, apk) {
  entry.target = apk.version;
  entry.detail.sha256 = apk.sha256;
  entry.detail.size = String(apk.size);
  entry.detail.versionCode = String(apk.versionCode);
}

export function createAppHandlers({ aws, config, now }, { versions } = {}) {
  const bundled = versions ?? readBundledVersions();

  /** Refuse a version that is taken, or that is not above the highest by version and by versionCode. */
  async function refuseTakenOrLower(apk) {
    const sk = appReleaseKey(apk.parts);
    const [taken, highest] = await Promise.all([aws.getAppRelease(sk), aws.highestAppRelease(ANDROID)]);
    if (taken !== null) throw versionExists(apk.version);
    if (highest !== null && !(highest.sk < sk)) throw versionNotNewer(apk.version, versionOfAppKey(highest.sk));
    if (highest !== null && !(highest.versionCode < apk.versionCode)) throw codeNotHigher(apk.versionCode, highest.versionCode);
    return sk;
  }

  return {
    async list() {
      const releases = (await aws.listAppReleases(ANDROID))
        .map(appReleaseFromItem)
        .filter((release) => release !== null)
        .sort((a, b) => compareAppVersions(parseAppVersion(b.version), parseAppVersion(a.version)));
      return {
        body: {
          android: { latest: releases[0]?.version ?? null, releases },
          // Built with Xcode from the repository, never uploaded: the newest entry of its changelog.
          ios: { version: bundled.ios?.version ?? null, notes: bundled.ios?.note ?? '' },
          console: bundled.console,
        },
      };
    },

    /** The six values of apps/config/cranium.json, from this stack, in that file's order. */
    config() {
      return {
        body: {
          consoleUrl: config.consoleUrl,
          loginDomain: `https://${config.loginDomain}`,
          mobileClientId: config.mobileClientId,
          redirectUri: APP_REDIRECT_URI,
          region: config.region,
          userPoolId: config.userPoolId,
        },
      };
    },

    async startUpload({ json, entry }) {
      const body = json();
      if (typeof field(body, 'version') === 'string') entry.target = field(body, 'version').slice(0, 32);
      const apk = requireApkDescription(body);
      describe(entry, apk);
      await refuseTakenOrLower(apk);
      const upload = await aws.presignAppUpload({
        key: apkKey(apk.version),
        size: apk.size,
        sha256Base64: Buffer.from(apk.sha256, 'hex').toString('base64'),
        expiresIn: LINK_SECONDS,
      });
      return {
        status: 201,
        body: {
          upload: { method: 'PUT', url: upload.url, headers: upload.headers, expiresAt: iso(upload.expiresAt) },
          version: apk.version,
          filename: apkName(apk.version),
        },
      };
    },

    async publish({ actor, params, json, entry }) {
      const parts = requireAppVersion(params.version);
      entry.target = parts.text;
      const apk = requireApkDescription(json(), parts);
      describe(entry, apk);
      const sk = await refuseTakenOrLower(apk);

      const object = await aws.headAppObject(apkKey(apk.version));
      if (object === null) {
        throw conflict('apk_missing', `No APK for ${apk.version} has arrived. Send it with the URL from ` +
          'POST /api/apps/android/uploads first: that URL is good for 15 minutes.');
      }
      if (object.size !== apk.size) {
        throw unprocessable('size_mismatch', `The APK that arrived for ${apk.version} is ${object.size} bytes, ` +
          `not ${apk.size}. Start the upload again.`);
      }
      // A multipart upload's checksum is one of its parts, not of the file: it never came through the console's URL.
      const arrived = object.checksumType === null || object.checksumType === 'FULL_OBJECT' ? checksumHex(object.sha256Base64) : null;
      if (arrived === null) {
        throw unprocessable('checksum_missing', `The APK that arrived for ${apk.version} has no SHA-256 of its own: ` +
          'it was not sent with the console\'s upload URL. Start the upload again.');
      }
      if (arrived !== apk.sha256) {
        throw unprocessable('sha256_mismatch', `The APK that arrived for ${apk.version} is not the one described: ` +
          'its SHA-256 is different. Start the upload again.');
      }
      if (object.versionId === null) {
        throw new HttpError(500, 'unversioned', 'The bucket gave the APK no version of its own, so the console ' +
          'cannot pin the download to it. Its versioning must be on (infra/template.yaml).');
      }

      const release = {
        platform: ANDROID,
        version: apk.version,
        versionCode: apk.versionCode,
        size: apk.size,
        sha256: apk.sha256,
        notes: apk.notes,
        objectVersion: object.versionId,
        publishedBy: { sub: actor.sub, email: actor.email },
        publishedAt: iso(now()),
      };
      const registered = await aws.registerAppRelease({ sk, versionCode: apk.versionCode, release });
      if (!registered.ok) {
        if (registered.reason === 'exists') throw versionExists(apk.version);
        if (registered.reason === 'not_newer') {
          // Published at the same moment by someone else: newer than this by version, or by versionCode.
          const versionIsNewer = registered.highest !== null && registered.highest < sk;
          throw versionIsNewer
            ? codeNotHigher(apk.versionCode, registered.versionCode)
            : versionNotNewer(apk.version, versionOfAppKey(registered.highest));
        }
        throw conflict('publish_conflict', 'Another release of the app was being published at the same moment. Try again.');
      }
      return { status: 201, body: { release: appReleaseFromItem({ ...release, sk }) } };
    },

    async download({ params, query, entry }) {
      const parts = requireAppVersion(params.version);
      entry.target = parts.text;
      const via = query.via ?? 'link';
      if (via !== 'link' && via !== 'qr') throw badRequest('invalid_via', '"via" is qr, or left out.');
      entry.detail.via = via;
      const item = await aws.getAppRelease(appReleaseKey(parts));
      const release = appReleaseFromItem(item);
      if (release === null) throw notFound('unknown_version', `There is no Android app ${parts.text} on the console.`);
      const objectVersion = objectVersionOf(item);
      if (objectVersion === null) {
        throw new HttpError(500, 'unversioned', `The record of ${parts.text} names no version of its APK.`);
      }
      entry.detail.sha256 = release.sha256;
      const link = await aws.presignAppDownload({
        key: apkKey(parts.text), versionId: objectVersion, filename: release.filename, expiresIn: LINK_SECONDS,
      });
      return {
        body: {
          download: {
            url: link.url,
            expiresAt: iso(link.expiresAt),
            version: release.version,
            filename: release.filename,
            size: release.size,
            sha256: release.sha256,
          },
        },
      };
    },

    /** GET /api/me with the console's own version and commit beside who is signed in. */
    withConsole(handler) {
      return async (request) => {
        const result = await handler(request);
        return { ...result, body: { ...result.body, console: bundled.console } };
      };
    },
  };
}
