/**
 * The phone apps on the console (docs/mobile-apps.md, "The Apps page").
 *
 *   GET  /api/apps                                the Android releases, newest first, and the iPhone
 *                                                 app's version and note; any member
 *   GET  /api/apps/config                         the apps' configuration, as apps/config/cranium.json
 *                                                 (apps/configure.sh); any member
 *   POST /api/apps/android/uploads                a URL to PUT an APK to; release managers (app.upload)
 *   POST /api/apps/android/releases/{version}     the APK that arrived is checked and published; release
 *                                                 managers (app.publish)
 *   GET  /api/apps/android/{version}/download     a link to download it; any member (app.download)
 *   POST /api/apps/ios/uploads                    a URL to PUT an IPA to; release managers (app.ios_upload)
 *   POST /api/apps/ios/releases/{version}         the IPA that arrived is checked and published; release
 *                                                 managers (app.ios_publish)
 *   GET  /api/apps/ios/{version}/download         a link to download it; any member (app.ios_download)
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
 * An iPhone app is published the same way, as an unsigned IPA (apps/ios/scripts/build-ipa.sh), described
 * as { version, buildVersion, sha256, size, notes }: its build (CFBundleVersion) in the place of the
 * versionCode. Once the size and SHA-256 hold, the console reads the IPA's Info.plist out of the zip in
 * S3 (lib/ipa.mjs): the bundle ID must be the app's, the version and build the ones described, and the
 * app's configuration this console's, with the example configuration nowhere in it. What SideStore
 * needs to know of it goes on the release: the oldest iOS it runs on, and the usage descriptions it
 * declares (lib/sidestore.mjs, handlers/sidestore.mjs).
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
  ANDROID,
  APP_REDIRECT_URI,
  IOS,
  IOS_BUNDLE_ID,
  IPA_TYPE,
  LINK_SECONDS,
  apkKey,
  apkName,
  appReleaseFromItem,
  appReleaseKey,
  checksumHex,
  compareAppVersions,
  iosReleaseFromItem,
  ipaKey,
  objectVersionOf,
  parseAppVersion,
  requireApkDescription,
  requireAppVersion,
  requireIpaDescription,
  versionOfAppKey,
} from '../lib/apps.mjs';
import { IpaError, readIpa } from '../lib/ipa.mjs';
import { readBundledVersions } from '../lib/versions.mjs';

// The words for each platform, in a refusal.
const NAMES = Object.freeze({ [ANDROID]: 'Android app', [IOS]: 'iPhone app' });
const FILES = Object.freeze({ [ANDROID]: 'APK', [IOS]: 'IPA' });
// How a download link may have been asked for: by a person on the Apps page, as a QR code there, or by the
// Android app itself, for its own update (docs/mobile-apps.md, "Updates on every phone").
const VIA = Object.freeze(['link', 'qr', 'app']);

function iso(ms) {
  return new Date(ms).toISOString();
}

function versionExists(version, platform = ANDROID) {
  return conflict(
    'version_exists',
    `${NAMES[platform]} ${version} is on the console already. A version is published once and never replaced.`
  );
}

function versionNotNewer(version, highest, platform = ANDROID) {
  return unprocessable(
    'version_not_newer',
    highest === null
      ? `Version ${version} is not newer than the ${NAMES[platform]} on the console.`
      : `Version ${version} is not newer than ${highest}, the newest ${NAMES[platform]} published. Versions only go up.`
  );
}

function buildNotHigher(build, highest) {
  return unprocessable(
    'build_not_higher',
    `Build ${build} is not higher than ${highest}, the newest iPhone app's. ` +
      'SideStore takes an update by its version and build: raise CURRENT_PROJECT_VERSION in apps/ios/project.yml.'
  );
}

function ipaMismatch(version, what) {
  return unprocessable(
    'ipa_mismatch',
    `The IPA that arrived for ${version} ${what} Build it again with ` + 'apps/ios/scripts/build-ipa.sh.'
  );
}

function codeNotHigher(code, highest) {
  return unprocessable(
    'version_code_not_higher',
    `versionCode ${code} is not higher than ${highest}, the newest ` +
      "Android app's. Android installs an update only over a lower versionCode: raise craniumVersionCode."
  );
}

/** What the activity log keeps of an APK: never the note, which is on the release. */
function describe(entry, apk) {
  entry.target = apk.version;
  entry.detail.sha256 = apk.sha256;
  entry.detail.size = String(apk.size);
  entry.detail.versionCode = String(apk.versionCode);
}

/** And of an IPA. */
function describeIpa(entry, ipa) {
  entry.target = ipa.version;
  entry.detail.sha256 = ipa.sha256;
  entry.detail.size = String(ipa.size);
  entry.detail.build = ipa.buildVersion;
}

function byNewest(a, b) {
  return compareAppVersions(parseAppVersion(b.version), parseAppVersion(a.version));
}

export function createAppHandlers({ aws, config, now }, { versions } = {}) {
  const bundled = versions ?? readBundledVersions();

  /** Refuse a version that is taken, or that is not above the highest by version and by versionCode. */
  async function refuseTakenOrLower(apk) {
    const sk = appReleaseKey(apk.parts);
    const [taken, highest] = await Promise.all([aws.getAppRelease(sk), aws.highestAppRelease(ANDROID)]);
    if (taken !== null) throw versionExists(apk.version);
    if (highest !== null && !(highest.sk < sk)) throw versionNotNewer(apk.version, versionOfAppKey(highest.sk));
    if (highest !== null && !(highest.versionCode < apk.versionCode))
      throw codeNotHigher(apk.versionCode, highest.versionCode);
    return sk;
  }

  /** The same for an IPA, by version and by build. */
  async function refuseTakenOrLowerIpa(ipa) {
    const sk = appReleaseKey(ipa.parts, IOS);
    const [taken, highest] = await Promise.all([aws.getAppRelease(sk), aws.highestAppRelease(IOS)]);
    if (taken !== null) throw versionExists(ipa.version, IOS);
    if (highest !== null && !(highest.sk < sk)) throw versionNotNewer(ipa.version, versionOfAppKey(highest.sk), IOS);
    if (highest !== null && !(highest.versionCode < ipa.build)) throw buildNotHigher(ipa.build, highest.versionCode);
    return sk;
  }

  /** What arrived in S3 for a release, if it is exactly the file described: { versionId }, or a refusal. */
  async function checkArrived(key, described, platform) {
    const file = FILES[platform];
    const object = await aws.headAppObject(key);
    if (object === null) {
      throw platform === IOS
        ? conflict(
            'ipa_missing',
            `No IPA for ${described.version} has arrived. Send it with the URL from ` +
              'POST /api/apps/ios/uploads first: that URL is good for 15 minutes.'
          )
        : conflict(
            'apk_missing',
            `No APK for ${described.version} has arrived. Send it with the URL from ` +
              'POST /api/apps/android/uploads first: that URL is good for 15 minutes.'
          );
    }
    if (object.size !== described.size) {
      throw unprocessable(
        'size_mismatch',
        `The ${file} that arrived for ${described.version} is ${object.size} bytes, ` +
          `not ${described.size}. Start the upload again.`
      );
    }
    // A multipart upload's checksum is one of its parts, not of the file: it never came through the console's URL.
    const arrived =
      object.checksumType === null || object.checksumType === 'FULL_OBJECT' ? checksumHex(object.sha256Base64) : null;
    if (arrived === null) {
      throw unprocessable(
        'checksum_missing',
        `The ${file} that arrived for ${described.version} has no SHA-256 of its own: ` +
          "it was not sent with the console's upload URL. Start the upload again."
      );
    }
    if (arrived !== described.sha256) {
      throw unprocessable(
        'sha256_mismatch',
        `The ${file} that arrived for ${described.version} is not the one described: ` +
          'its SHA-256 is different. Start the upload again.'
      );
    }
    if (object.versionId === null) {
      throw new HttpError(
        500,
        'unversioned',
        `The bucket gave the ${file} no version of its own, so the console ` +
          'cannot pin the download to it. Its versioning must be on (infra/template.yaml).'
      );
    }
    return object;
  }

  /** The IPA's own Info.plist and configuration, held to what was described and to this console. */
  async function checkIpa(ipa, object) {
    let read;
    try {
      read = await readIpa({
        size: object.size,
        read: (start, end) => aws.readAppObject({ key: ipaKey(ipa.version), versionId: object.versionId, start, end }),
      });
    } catch (error) {
      if (error instanceof IpaError) {
        throw unprocessable(
          'ipa_unreadable',
          `The IPA that arrived for ${ipa.version} cannot be read as an iPhone app: ` +
            `${error.message} Build it with apps/ios/scripts/build-ipa.sh.`
        );
      }
      throw error;
    }
    if (read.bundleId !== IOS_BUNDLE_ID) {
      throw ipaMismatch(ipa.version, `is the app ${String(read.bundleId).slice(0, 80)}, not ${IOS_BUNDLE_ID}.`);
    }
    if (read.version !== ipa.version) {
      throw ipaMismatch(ipa.version, `says it is version ${String(read.version).slice(0, 32)} in its Info.plist.`);
    }
    if (read.build !== ipa.buildVersion) {
      throw ipaMismatch(ipa.version, `is build ${String(read.build).slice(0, 32)}, not ${ipa.buildVersion}.`);
    }
    if (read.exampleConfig || read.config === null) {
      throw ipaMismatch(ipa.version, 'has the example configuration, or none, and could not sign in.');
    }
    if (
      (read.config.consoleUrl ?? '').replace(/\/+$/, '') !== config.consoleUrl ||
      read.config.mobileClientId !== config.mobileClientId
    ) {
      throw ipaMismatch(ipa.version, "is configured for another console: its cranium.json is not this console's.");
    }
    return read;
  }

  async function iosReleases() {
    return (await aws.listAppReleases(IOS))
      .map(iosReleaseFromItem)
      .filter((release) => release !== null)
      .sort(byNewest);
  }

  /**
   * A presigned GET of an iPhone release, for the website (any member, on record) and for a SideStore
   * source's download address (handlers/sidestore.mjs): { url, expiresAt, release }, or 404.
   */
  async function iosLink(version, expiresIn = LINK_SECONDS) {
    const parts = requireAppVersion(version);
    const item = await aws.getAppRelease(appReleaseKey(parts, IOS));
    const release = iosReleaseFromItem(item);
    if (release === null) throw notFound('unknown_version', `There is no iPhone app ${parts.text} on the console.`);
    const objectVersion = objectVersionOf(item);
    if (objectVersion === null) {
      throw new HttpError(500, 'unversioned', `The record of ${parts.text} names no version of its IPA.`);
    }
    const link = await aws.presignAppDownload({
      key: ipaKey(parts.text),
      versionId: objectVersion,
      filename: release.filename,
      expiresIn,
      contentType: IPA_TYPE,
    });
    return { url: link.url, expiresAt: link.expiresAt, release };
  }

  return {
    iosReleases,

    async list() {
      const [android, ios] = await Promise.all([
        aws.listAppReleases(ANDROID).then((items) =>
          items
            .map(appReleaseFromItem)
            .filter((release) => release !== null)
            .sort(byNewest)
        ),
        iosReleases(),
      ]);
      return {
        body: {
          android: { latest: android[0]?.version ?? null, releases: android },
          // The newest entry of its changelog, as this deployment was built with it, and the IPAs a release
          // manager's build published, which SideStore installs (handlers/sidestore.mjs).
          ios: {
            version: bundled.ios?.version ?? null,
            notes: bundled.ios?.note ?? '',
            latest: ios[0]?.version ?? null,
            releases: ios.map(({ privacy: _, ...release }) => release),
          },
          console: bundled.console,
        },
      };
    },

    /**
     * The values of apps/config/cranium.json, from this stack, in that file's order: six, the four
     * of the apps' customer side once the stack has the phone apps' client of the customer pool, and
     * liveUrl once it has the live API (docs/live.md). The customer API is this API under /api/c/, on
     * the customer site's name once it has one.
     */
    config() {
      const customers = config.customers?.mobileClientId ? config.customers : null;
      return {
        body: {
          consoleUrl: config.consoleUrl,
          ...(customers === null
            ? {}
            : {
                customerApiUrl: customers.siteUrl === '' ? config.consoleUrl : customers.siteUrl.replace(/\/$/, ''),
                customerClientId: customers.mobileClientId,
                customerRegion: config.region,
                customerUserPoolId: customers.customerPoolId,
              }),
          ...(config.liveUrl ? { liveUrl: config.liveUrl } : {}),
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

      const object = await checkArrived(apkKey(apk.version), apk, ANDROID);

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
        throw conflict(
          'publish_conflict',
          'Another release of the app was being published at the same moment. Try again.'
        );
      }
      return { status: 201, body: { release: appReleaseFromItem({ ...release, sk }) } };
    },

    async startIosUpload({ json, entry }) {
      const body = json();
      if (typeof field(body, 'version') === 'string') entry.target = field(body, 'version').slice(0, 32);
      const ipa = requireIpaDescription(body);
      describeIpa(entry, ipa);
      await refuseTakenOrLowerIpa(ipa);
      const upload = await aws.presignAppUpload({
        key: ipaKey(ipa.version),
        size: ipa.size,
        sha256Base64: Buffer.from(ipa.sha256, 'hex').toString('base64'),
        expiresIn: LINK_SECONDS,
      });
      return {
        status: 201,
        body: {
          upload: { method: 'PUT', url: upload.url, headers: upload.headers, expiresAt: iso(upload.expiresAt) },
          version: ipa.version,
          filename: ipaKey(ipa.version).slice('apps/ios/'.length),
        },
      };
    },

    async publishIos({ actor, params, json, entry }) {
      const parts = requireAppVersion(params.version);
      entry.target = parts.text;
      const ipa = requireIpaDescription(json(), parts);
      describeIpa(entry, ipa);
      const sk = await refuseTakenOrLowerIpa(ipa);
      const object = await checkArrived(ipaKey(ipa.version), ipa, IOS);
      const read = await checkIpa(ipa, object);

      const release = {
        platform: IOS,
        version: ipa.version,
        buildVersion: ipa.buildVersion,
        // The pointer's versionCode is the build (aws-apps.mjs).
        versionCode: ipa.build,
        size: ipa.size,
        sha256: ipa.sha256,
        notes: ipa.notes,
        bundleId: read.bundleId,
        minOSVersion: read.minOS,
        privacy: read.privacy,
        objectVersion: object.versionId,
        publishedBy: { sub: actor.sub, email: actor.email },
        publishedAt: iso(now()),
      };
      const registered = await aws.registerAppRelease({ sk, versionCode: ipa.build, release });
      if (!registered.ok) {
        if (registered.reason === 'exists') throw versionExists(ipa.version, IOS);
        if (registered.reason === 'not_newer') {
          const versionIsNewer = registered.highest !== null && registered.highest < sk;
          throw versionIsNewer
            ? buildNotHigher(ipa.build, registered.versionCode)
            : versionNotNewer(ipa.version, versionOfAppKey(registered.highest), IOS);
        }
        throw conflict(
          'publish_conflict',
          'Another release of the app was being published at the same moment. Try again.'
        );
      }
      const { privacy: _, ...shown } = iosReleaseFromItem({ ...release, sk });
      return { status: 201, body: { release: shown } };
    },

    iosLink,

    // `via=app`: the iPhone app asked for it itself, for its own update through SideStore (docs/mobile-apps.md,
    // "Updating the iPhone app").
    async downloadIos({ params, query, entry }) {
      entry.target = typeof params.version === 'string' ? params.version.slice(0, 32) : '';
      const via = query.via ?? 'link';
      if (!VIA.includes(via)) throw badRequest('invalid_via', '"via" is qr or app, or left out.');
      entry.detail.via = via;
      const link = await iosLink(params.version);
      entry.detail.sha256 = link.release.sha256;
      return {
        body: {
          download: {
            url: link.url,
            expiresAt: iso(link.expiresAt),
            version: link.release.version,
            filename: link.release.filename,
            size: link.release.size,
            sha256: link.release.sha256,
          },
        },
      };
    },

    async download({ params, query, entry }) {
      const parts = requireAppVersion(params.version);
      entry.target = parts.text;
      const via = query.via ?? 'link';
      if (!VIA.includes(via)) throw badRequest('invalid_via', '"via" is qr or app, or left out.');
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
        key: apkKey(parts.text),
        versionId: objectVersion,
        filename: release.filename,
        expiresIn: LINK_SECONDS,
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
