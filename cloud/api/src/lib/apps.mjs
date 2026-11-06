/**
 * The phone apps on the console (docs/mobile-apps.md, "The Apps page"): the Android app's
 * releases and the iPhone app's, which a release manager's build publishes, and what the console
 * says of both apps.
 *
 * An Android release is one APK, stored once in the firmware bucket under
 * apps/android/cranium-android-<version>.apk, and a record in the state table under pk "APP",
 * sk "android#MMM.mmm.ppppp": the version padded, so that text order is version order. A pointer
 * (pk "META", sk "APP#android") remembers the highest version ever published and its versionCode.
 * A new release must be above both, so a version is accepted once and only upward, as firmware
 * is, and Android, which only installs an update with a higher versionCode, can always take the
 * newest over an older one.
 *
 * The bucket keeps every version of an object. The record names the S3 version that was checked
 * when the release was published, and a download is of that version alone, so whatever is put
 * under the same key afterwards is never handed out for it.
 *
 * An iPhone release is the same, for an unsigned IPA (docs/mobile-apps.md, "Updates on every
 * phone"): apps/ios/cranium-ios-<version>.ipa, sk "ios#MMM.mmm.ppppp", pointer "APP#ios", its build
 * (CFBundleVersion, which counts the versions as versionCode does on Android) in the place of the
 * versionCode. SideStore signs it on each iPhone with that person's own Apple ID (lib/sidestore.mjs).
 * It is never public: like an APK, it holds this console's address and its public client IDs.
 */

import { badRequest, field } from '../http.mjs';
import { MAX_NOTES, requireText } from './validate.mjs';

export const APP_PK = 'APP';
export const ANDROID = 'android';
export const IOS = 'ios';
export const APP_PLATFORMS = Object.freeze([ANDROID, IOS]);
// The iPhone app's bundle ID (apps/ios/project.yml, scripts/generate.sh), which an IPA must have.
export const IOS_BUNDLE_ID = 'com.craniumiot.cranium';
// How long an upload URL and a download link stay good: 15 minutes.
export const LINK_SECONDS = 900;
// The APK the build makes is about 12 MB. Far more than that is not this app.
export const MAX_APK_BYTES = 100 * 1024 * 1024;
// The highest versionCode Google Play accepts; Android itself takes any positive int.
export const MAX_VERSION_CODE = 2_100_000_000;
export const APK_TYPE = 'application/vnd.android.package-archive';
// An unsigned IPA is a zip of about 15 MB: the same limit as an APK.
export const MAX_IPA_BYTES = 100 * 1024 * 1024;
export const IPA_TYPE = 'application/octet-stream';
// What a phone app signs in back to (infra/template.yaml, MobileUserPoolClient).
export const APP_REDIRECT_URI = 'cranium://signin';

const APP_VERSION = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,4})$/;
const APP_SORT_KEY = /^(android|ios)#(\d{3})\.(\d{3})\.(\d{5})$/;
// CFBundleVersion as apps/ios/project.yml has it: CURRENT_PROJECT_VERSION, a whole number.
const BUILD_VERSION = /^[1-9]\d{0,9}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const OS_VERSION = /^\d{1,2}(?:\.\d{1,2}){0,2}$/;
const PRIVACY_KEY = /^NS[A-Za-z0-9]{1,80}UsageDescription$/;
const HEX64 = /^[0-9a-f]{64}$/;
const VERSION_ID = /^[A-Za-z0-9._+/=-]{1,1024}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** { major, minor, patch, text } for a version such as 0.4.0, or null. */
export function parseAppVersion(value) {
  const match = typeof value === 'string' ? APP_VERSION.exec(value) : null;
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text: value };
}

/** Negative, zero or positive, as a is below, equal to or above b. */
export function compareAppVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** The sort key of a release: Android's unless another platform is named. */
export function appReleaseKey(parts, platform = ANDROID) {
  if (!APP_PLATFORMS.includes(platform)) throw new TypeError(`No app platform ${platform}`);
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${platform}#${pad(parts.major, 3)}.${pad(parts.minor, 3)}.${pad(parts.patch, 5)}`;
}

/** The version a sort key stands for, or null. */
export function versionOfAppKey(sortKey) {
  const match = typeof sortKey === 'string' ? APP_SORT_KEY.exec(sortKey) : null;
  return match ? `${Number(match[2])}.${Number(match[3])}.${Number(match[4])}` : null;
}

/** The file name an APK is stored and downloaded as. */
export function apkName(version) {
  if (parseAppVersion(version) === null) throw new TypeError('Not an app version');
  return `cranium-android-${version}.apk`;
}

/** The S3 key of an APK. The API role may write and read objects named like this and nothing else there. */
export function apkKey(version) {
  return `apps/android/${apkName(version)}`;
}

/** The file name an IPA is stored and downloaded as. */
export function ipaName(version) {
  if (parseAppVersion(version) === null) throw new TypeError('Not an app version');
  return `cranium-ios-${version}.ipa`;
}

/** The S3 key of an IPA. The API role may write and read objects named like this, and APKs, and nothing else there. */
export function ipaKey(version) {
  return `apps/ios/${ipaName(version)}`;
}

/** A version named in a path or a body, or 400. */
export function requireAppVersion(value) {
  const parts = parseAppVersion(value);
  if (parts === null) {
    throw badRequest('invalid_version', "The app's version is three numbers with dots, such as 0.4.0.");
  }
  return parts;
}

export function requireVersionCode(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_VERSION_CODE) {
    throw badRequest(
      'invalid_version_code',
      `"versionCode" is the app's versionCode: a whole number from 1 to ${MAX_VERSION_CODE}.`
    );
  }
  return value;
}

export function requireApkSize(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_APK_BYTES) {
    throw badRequest('invalid_size', `"size" is the APK's size in bytes, at most ${MAX_APK_BYTES} (100 MB).`);
  }
  return value;
}

export function requireApkSha256(value) {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw badRequest('invalid_sha256', '"sha256" is the SHA-256 of the APK: 64 lower-case hex digits.');
  }
  return value;
}

/**
 * What a publish says of its APK, in both of its calls: { version, versionCode, sha256, size, notes }.
 * The version comes from the path where there is one, else from the body.
 */
export function requireApkDescription(body, pathVersion = null) {
  const parts = pathVersion ?? requireAppVersion(field(body, 'version'));
  if (pathVersion !== null && field(body, 'version') !== undefined && field(body, 'version') !== pathVersion.text) {
    throw badRequest('invalid_version', 'The version in the body is not the one in the address.');
  }
  return {
    parts,
    version: parts.text,
    versionCode: requireVersionCode(field(body, 'versionCode')),
    sha256: requireApkSha256(field(body, 'sha256')),
    size: requireApkSize(field(body, 'size')),
    notes: requireText(field(body, 'notes'), 'notes', { max: MAX_NOTES }),
  };
}

/** CFBundleVersion of an IPA, as the text it is in Info.plist and as a number, or 400. */
export function requireBuildVersion(value) {
  if (typeof value !== 'string' || !BUILD_VERSION.test(value) || Number(value) > MAX_VERSION_CODE) {
    throw badRequest(
      'invalid_build',
      '"buildVersion" is the app\'s CFBundleVersion (CURRENT_PROJECT_VERSION in ' +
        `apps/ios/project.yml): a whole number from 1 to ${MAX_VERSION_CODE}, as text.`
    );
  }
  return { text: value, number: Number(value) };
}

export function requireIpaSize(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_IPA_BYTES) {
    throw badRequest('invalid_size', `"size" is the IPA's size in bytes, at most ${MAX_IPA_BYTES} (100 MB).`);
  }
  return value;
}

/**
 * What a publish says of its IPA, in both of its calls: { version, buildVersion, sha256, size, notes }.
 * The version comes from the path where there is one, else from the body.
 */
export function requireIpaDescription(body, pathVersion = null) {
  const parts = pathVersion ?? requireAppVersion(field(body, 'version'));
  if (pathVersion !== null && field(body, 'version') !== undefined && field(body, 'version') !== pathVersion.text) {
    throw badRequest('invalid_version', 'The version in the body is not the one in the address.');
  }
  const build = requireBuildVersion(field(body, 'buildVersion'));
  return {
    parts,
    version: parts.text,
    buildVersion: build.text,
    build: build.number,
    sha256: requireApkSha256(field(body, 'sha256')),
    size: requireIpaSize(field(body, 'size')),
    notes: requireText(field(body, 'notes'), 'notes', { max: MAX_NOTES }),
  };
}

/** The usage descriptions an IPA's Info.plist gave, as stored: only keys and texts of the right form. */
function privacyOf(value) {
  const out = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const key of Object.keys(value).sort()) {
    if (PRIVACY_KEY.test(key) && typeof value[key] === 'string' && value[key].length <= 500) out[key] = value[key];
  }
  return out;
}

/** A stored item as an iPhone release, or null if it is not one. */
export function iosReleaseFromItem(item) {
  if (item === null || typeof item !== 'object') return null;
  const parts = parseAppVersion(item.version);
  if (parts === null || appReleaseKey(parts, IOS) !== item.sk) return null;
  if (!HEX64.test(item.sha256 ?? '') || !Number.isInteger(item.size) || item.size <= 0) return null;
  if (typeof item.buildVersion !== 'string' || !BUILD_VERSION.test(item.buildVersion)) return null;
  return {
    version: parts.text,
    buildVersion: item.buildVersion,
    size: item.size,
    sha256: item.sha256,
    notes: text(item.notes, MAX_NOTES),
    filename: ipaName(parts.text),
    bundleId: typeof item.bundleId === 'string' && BUNDLE_ID.test(item.bundleId) ? item.bundleId : IOS_BUNDLE_ID,
    minOSVersion:
      typeof item.minOSVersion === 'string' && OS_VERSION.test(item.minOSVersion) ? item.minOSVersion : null,
    privacy: privacyOf(item.privacy),
    publishedBy: { sub: text(item.publishedBy?.sub, 128), email: text(item.publishedBy?.email, 320) },
    publishedAt: ISO_TIME.test(item.publishedAt ?? '') ? item.publishedAt : null,
  };
}

/** S3's base64 checksum as hex, or null if it is not a SHA-256. */
export function checksumHex(base64) {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(base64)) return null;
  const bytes = Buffer.from(base64, 'base64');
  return bytes.length === 32 ? bytes.toString('hex') : null;
}

function text(value, max) {
  return typeof value === 'string' && value.length <= max ? value : '';
}

/** A stored item as an Android release, or null if it is not one. */
export function appReleaseFromItem(item) {
  if (item === null || typeof item !== 'object') return null;
  const parts = parseAppVersion(item.version);
  if (parts === null || appReleaseKey(parts) !== item.sk) return null;
  if (!HEX64.test(item.sha256 ?? '') || !Number.isInteger(item.size) || item.size <= 0) return null;
  if (!Number.isInteger(item.versionCode) || item.versionCode <= 0) return null;
  return {
    version: parts.text,
    versionCode: item.versionCode,
    size: item.size,
    sha256: item.sha256,
    notes: text(item.notes, MAX_NOTES),
    filename: apkName(parts.text),
    publishedBy: { sub: text(item.publishedBy?.sub, 128), email: text(item.publishedBy?.email, 320) },
    publishedAt: ISO_TIME.test(item.publishedAt ?? '') ? item.publishedAt : null,
  };
}

/** The S3 version of the object a stored release was checked against, or null. */
export function objectVersionOf(item) {
  return typeof item?.objectVersion === 'string' && VERSION_ID.test(item.objectVersion) ? item.objectVersion : null;
}
