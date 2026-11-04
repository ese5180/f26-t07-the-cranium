/**
 * The versions this deployment was built with: versions.json beside the function's code, which
 * cloud/deploy.sh writes when it deploys (cloud/web/build-versions.mjs) from cloud/VERSION and
 * the four changelogs. Git ignores it, so a checkout that was never deployed has none, and then
 * every version here is null.
 *
 * The API needs three things of it: the console's own version and commit (GET /api/me), and the
 * iPhone app's newest version and note (GET /api/apps). The iPhone app is never uploaded to the
 * console, so its changelog is all the console knows of it.
 */

import { readFileSync } from 'node:fs';

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MAX_NOTE = 1000;
const UNSAFE = /[\p{C}\p{Zl}\p{Zp}]/gu;

const NONE = Object.freeze({
  console: Object.freeze({ version: null, commit: null }),
  ios: null,
  android: null,
});

function entryOf(value) {
  if (!VERSION.test(value?.version ?? '') || typeof value.note !== 'string') return null;
  return { version: value.version, note: value.note.replace(UNSAFE, ' ').slice(0, MAX_NOTE) };
}

/**
 * What the API keeps of versions.json: { console: { version, commit }, ios, android }, where ios
 * and android are the newest entry of that app's changelog, { version, note }, or null.
 */
export function parseBundledVersions(data) {
  if (data === null || typeof data !== 'object') return NONE;
  const own = data.console;
  const newest = (name) => {
    const entries = data.changelogs?.[name];
    return Array.isArray(entries) && entries.length > 0 ? entryOf(entries[0]) : null;
  };
  return Object.freeze({
    console: Object.freeze({
      version: VERSION.test(own?.version ?? '') ? own.version : null,
      commit: COMMIT.test(own?.commit ?? '') ? own.commit : null,
    }),
    ios: newest('ios'),
    android: newest('android'),
  });
}

/** versions.json beside the code, read once; NONE if it is not there or not readable. */
export function readBundledVersions(url = new URL('../versions.json', import.meta.url)) {
  let text;
  try {
    text = readFileSync(url, 'utf8');
  } catch {
    return NONE;
  }
  try {
    return parseBundledVersions(JSON.parse(text));
  } catch {
    return NONE;
  }
}
