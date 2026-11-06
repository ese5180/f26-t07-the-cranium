/**
 * Whether there is a newer build of the desktop app (docs/desktop-app.md, "Updates"). The pages update
 * themselves from the console (store.mjs); the app around them changes seldom, and is not signed, so it
 * does not replace itself: it says that a newer one is out, and opens its download in the browser.
 *
 * The newest builds are in apps/dist/ in git, with latest.json naming each (apps/fetch-builds.sh), as the
 * phone apps' are. A desktop build is listed under "desktop-<platform>": desktop-windows or desktop-linux,
 * { file, version, sha256, size } (the Mac has a native app of its own). Without an entry for this platform there is nothing to
 * say. The file is fetched by the browser, from the same folder, never by the app.
 */

export const LATEST_URL = 'https://raw.githubusercontent.com/ese5180/f26-t07-the-cranium/main/apps/dist/latest.json';
export const DOWNLOAD_BASE = 'https://github.com/ese5180/f26-t07-the-cranium/raw/main/apps/dist/';
export const CHECK_EVERY_MS = 24 * 3600 * 1000;
const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/;
// The installers' names, as apps/write-dist-index.py and scripts/installers.mjs know them.
const FILE =
  /^(?:Cranium-Setup-\d+\.\d+\.\d+(?:-arm64)?\.exe|Cranium-\d+\.\d+\.\d+-portable\.exe|Cranium-\d+\.\d+\.\d+(?:-arm64)?\.AppImage|cranium_\d+\.\d+\.\d+_(?:amd64|arm64)\.deb|cranium-\d+\.\d+\.\d+\.(?:x86_64|aarch64)\.rpm)$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The platform's word in latest.json, from Node's: windows or linux; null for any other. */
export function platformWord(platform) {
  return { win32: 'windows', linux: 'linux' }[platform] ?? null;
}

export function compareVersions(a, b) {
  const left = VERSION.exec(a)?.slice(1).map(Number);
  const right = VERSION.exec(b)?.slice(1).map(Number);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/**
 * The newer build for this platform in latest.json's text, or null: { version, file, sha256, size, url }.
 * Anything that does not read as one is no news.
 */
export function newerBuild(text, { platform, version }) {
  const word = platformWord(platform);
  if (!word) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const entry = value?.[`desktop-${word}`];
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.version !== 'string' || compareVersions(entry.version, version) !== 1) return null;
  if (typeof entry.file !== 'string' || !FILE.test(entry.file)) return null;
  if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) return null;
  if (!Number.isInteger(entry.size) || entry.size <= 0) return null;
  return {
    version: entry.version,
    file: entry.file,
    sha256: entry.sha256,
    size: entry.size,
    url: `${DOWNLOAD_BASE}${encodeURIComponent(entry.file)}`,
  };
}

/** Ask once: the newer build, or null (also when GitHub cannot be reached). */
export async function checkForNewerBuild({ fetch: fetchIt = globalThis.fetch, platform, version, url = LATEST_URL }) {
  try {
    const response = await fetchIt(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
    if (!response.ok) return null;
    const text = await response.text();
    return text.length > 64 * 1024 ? null : newerBuild(text, { platform, version });
  } catch {
    return null;
  }
}
