/**
 * What a board's page says of Memfault (docs/memfault.md): whether its chunks reach Memfault, and where
 * the board is in Memfault.
 *
 * Forwarding is on for a board when a project key is stored in AWS (the secret MemfaultProjectKey has a
 * value) and the board runs firmware 1.14.0 or later, the first that sends Memfault's data. The link needs
 * the organization's and the project's slugs, which are not secrets (MemfaultOrgSlug, MemfaultProjectSlug).
 */

import { parseVersion } from './mcuboot.mjs';

// The first firmware that sends Memfault's data over its MQTT connection.
export const MEMFAULT_FIRMWARE = Object.freeze({ major: 1, minor: 14, revision: 0 });
export const MEMFAULT_APP = 'https://app.memfault.com';
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Whether a version text ("1.14.0+0") is MEMFAULT_FIRMWARE or later. False for anything else. */
export function sendsMemfault(version) {
  const parts = typeof version === 'string' ? parseVersion(version) : null;
  if (parts === null) return false;
  for (const name of ['major', 'minor', 'revision']) {
    if (parts[name] !== MEMFAULT_FIRMWARE[name]) return parts[name] > MEMFAULT_FIRMWARE[name];
  }
  return true;
}

/** The board's address in Memfault, or null without both slugs. The thing name is Memfault's device serial. */
export function memfaultUrl(thing, { org, project }) {
  if (!SLUG.test(org ?? '') || !SLUG.test(project ?? '')) return null;
  return `${MEMFAULT_APP}/organizations/${org}/projects/${project}/devices/${encodeURIComponent(thing)}`;
}

/** What GET /api/devices/{thing} says of Memfault: { keyStored, firmware, url }. */
export function memfaultView(device, { keyStored, org, project }) {
  return {
    keyStored: keyStored === true,
    firmware: sendsMemfault(device?.fw?.version),
    url: memfaultUrl(device?.thing ?? '', { org, project }),
  };
}
