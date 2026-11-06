/**
 * A member's SideStore source (docs/mobile-apps.md, "Updates on every phone"): how the iPhone app
 * reaches every iPhone of the team without TestFlight. SideStore, which each person installs once
 * and signs in with their own Apple ID, signs apps on the phone and keeps them up to date from
 * "sources": a JSON document at an address, in AltStore's format. Each member gets a source of their
 * own from the Apps page.
 *
 * SideStore fetches a source, and the IPAs it names, with no sign-in of any kind, so the address is
 * the credential: a capability URL,
 *
 *   <console>/api/sidestore/crs_<43 characters>/source.json
 *
 * the key 32 random bytes in base64url, as an API token is (lib/tokens.mjs). It is shown once, when it
 * is made; the state table keeps its SHA-256 and never the key, so the console cannot show it again,
 * only make a new one, which ends the old. A member can also turn it off. Every use asks Cognito
 * whether its owner is still an active member: someone removed from the console takes their source
 * with them at once. A key is used at most SOURCE_USES_PER_MINUTE times a minute.
 *
 * The source lists the iPhone app's published versions, newest first, each with its note (the first
 * paragraph of its entry in apps/ios/CHANGELOG.md, as published), its size and SHA-256, which
 * SideStore checks, and a downloadURL that is the console's own: .../crs_<key>/cranium-ios-<v>.ipa,
 * which answers 302 with a presigned S3 GET of that release's object, made at that moment and good for
 * five minutes. So the source never goes stale, and the IPA itself never has a public address.
 * appPermissions declares the usage descriptions the IPA's Info.plist has, which SideStore compares
 * with the app it downloaded; an unsigned IPA has no entitlements of its own.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SOURCE_PK = 'SRC';
export const SOURCE_PREFIX = 'crs_';
export const SOURCE_ID = /^[0-9a-f]{16}$/;
export const SOURCE_USES_PER_MINUTE = 30;
// A redirect is followed at once; the download it starts may take longer, which S3 allows.
export const SOURCE_LINK_SECONDS = 300;
export const SOURCE_FILE = 'source.json';
export const SOURCE_IDENTIFIER = 'com.craniumiot.cranium.source';

const SECRET_BYTES = 32;
const KEY = /^crs_([A-Za-z0-9_-]{43})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const IPA_FILE = /^cranium-ios-((?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,4}))\.ipa$/;
// The app's icon and colour, as in apps/ios/App/Assets.xcassets. The icon is the public repository's
// copy: the console has no address for it that stays the same from one deployment to the next.
export const ICON_URL =
  'https://raw.githubusercontent.com/ese5180/f26-t07-the-cranium/main/apps/ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png';
const TINT = '#B7410E';
const DESCRIPTION =
  'The Cranium console on your iPhone: the boards, firmware releases and deployments, the activity ' +
  'log, and firmware sent to a board over Bluetooth. Sign in with your console account.';

/** A new key, from the system's CSPRNG. */
export function newSourceKey() {
  return `${SOURCE_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`;
}

/** The key in a path segment, or null: only the one spelling of 32 bytes that encodes back to itself. */
export function sourceKeyOf(segment) {
  const match = typeof segment === 'string' ? KEY.exec(segment) : null;
  if (!match) return null;
  const bytes = Buffer.from(match[1], 'base64url');
  return bytes.length === SECRET_BYTES && bytes.toString('base64url') === match[1] ? segment : null;
}

/** The SHA-256 of a key, in lowercase hex: what the table keeps instead of the key. */
export function sourceDigest(key) {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Whether two digests are the same, compared in constant time. */
export function sameSourceDigest(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !DIGEST.test(a) || !DIGEST.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function sourceKeySk(digest) {
  if (!DIGEST.test(digest ?? '')) throw new TypeError('Not a digest');
  return `key#${digest}`;
}

export function sourceOwnerSk(sub) {
  if (typeof sub !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(sub)) throw new TypeError('Not a sub');
  return `owner#${sub}`;
}

/** The version an IPA's file name in a download address names, or null. */
export function versionOfIpaFile(segment) {
  const match = typeof segment === 'string' ? IPA_FILE.exec(segment) : null;
  return match ? match[1] : null;
}

/** The addresses of a key's source: the plain one, and the one that opens SideStore to add it. */
export function sourceLinks(consoleUrl, key) {
  const base = String(consoleUrl).replace(/\/+$/, '');
  const source = `${base}/api/sidestore/${key}/${SOURCE_FILE}`;
  return { url: source, add: `sidestore://source?url=${encodeURIComponent(source)}` };
}

/** An ISO time without its milliseconds, which SideStore's date reader does not take. */
function seconds(iso) {
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

/** A stored key as its owner sees it: never the key, never its digest. */
export function presentSource(item) {
  if (item === null || typeof item !== 'object' || !SOURCE_ID.test(item.id ?? '')) return null;
  return {
    id: item.id,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : null,
    lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : null,
  };
}

/**
 * The source document for one key: the iPhone releases (lib/apps.mjs iosReleaseFromItem), newest
 * first, each downloaded through this console with the same key.
 */
export function buildSource({ consoleUrl, key, releases }) {
  const links = sourceLinks(consoleUrl, key);
  const base = links.url.slice(0, -SOURCE_FILE.length);
  const listed = releases.filter((release) => release.publishedAt !== null);
  const source = {
    name: 'Cranium',
    identifier: SOURCE_IDENTIFIER,
    sourceURL: links.url,
    subtitle: "The team's iPhone app, from its console",
    description:
      "Your own source, from the console's Apps page. Keep its address to yourself: it downloads the app " +
      'without a sign-in. Make a new one there if it got out.',
    iconURL: ICON_URL,
    website: String(consoleUrl).replace(/\/+$/, ''),
    tintColor: TINT,
    apps: [],
    news: [],
  };
  if (listed.length === 0) return source;
  const [newest] = listed;
  // Every version's usage descriptions, the newest's words where they differ: SideStore checks the app it
  // downloads, of whichever version, against the one list of the app.
  const privacy = {};
  for (const release of [...listed].reverse()) Object.assign(privacy, release.privacy);
  source.apps.push({
    name: 'Cranium',
    bundleIdentifier: newest.bundleId,
    developerName: 'Cranium team',
    subtitle: 'The console on your iPhone',
    localizedDescription: DESCRIPTION,
    iconURL: ICON_URL,
    tintColor: TINT,
    category: 'utilities',
    versions: listed.map((release) => {
      const version = {
        version: release.version,
        buildVersion: release.buildVersion,
        date: seconds(release.publishedAt),
        localizedDescription: release.notes,
        downloadURL: `${base}${release.filename}`,
        size: release.size,
        sha256: release.sha256,
      };
      if (release.minOSVersion !== null) version.minOSVersion = release.minOSVersion;
      return version;
    }),
    appPermissions: {
      entitlements: [],
      privacy: Object.fromEntries(
        Object.keys(privacy)
          .sort()
          .map((name) => [name, privacy[name]])
      ),
    },
  });
  return source;
}
