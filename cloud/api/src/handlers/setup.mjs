/**
 * GET /api/setup/wifi-defaults: the Wi-Fi network Board setup fills in by default (docs/new-board-setup.md,
 * "The Wi-Fi defaults"), from the stack's secret `<stack>/wifi-defaults` (aws-wifi-defaults.mjs).
 *
 *   ->   200 { "wifi": { "ssid": "...", "passphrase": "...", "security": "WPA2_PSK" } }
 *        200 { "wifi": null }   none is stored
 *
 * Release managers only, as a read that goes on record (setup.wifi_defaults), with a session: never with an
 * API token. The entry says whether a network was handed out, never which. The answer is never cached
 * (http.mjs: Cache-Control no-store on every answer). Nothing of the value goes to the log: a failure to read
 * it logs the AWS error's name only.
 *
 * What is stored is checked by the firmware's own rules (console_cmd.c WIFI_SEC): a name of 1 to 32 bytes with
 * no control character and no "|", a passphrase of 8 to 63 bytes with no control character, and one of the
 * three securities. A value that breaks them is refused with 500 wifi_defaults_invalid, so that the page never
 * fills in what the board would refuse.
 */

import { HttpError } from '../http.mjs';

export const SECURITIES = Object.freeze(['WPA2_PSK', 'WPA2_PSK_SHA256', 'WPA3_SAE']);
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const bytes = (text) => Buffer.byteLength(text, 'utf8');

/** The stored text as { ssid, passphrase, security }, or null when it breaks the firmware's rules. */
export function parseWifiDefaults(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { ssid, passphrase } = value;
  const security = value.security ?? SECURITIES[0];
  if (typeof ssid !== 'string' || bytes(ssid) < 1 || bytes(ssid) > 32 || CONTROL.test(ssid) || ssid.includes('|'))
    return null;
  if (typeof passphrase !== 'string' || bytes(passphrase) < 8 || bytes(passphrase) > 63 || CONTROL.test(passphrase))
    return null;
  if (typeof security !== 'string' || !SECURITIES.includes(security)) return null;
  return { ssid, passphrase, security };
}

export function createSetupHandlers({ aws, log }) {
  async function wifiDefaults({ entry }) {
    let text;
    try {
      text = await aws.wifiDefaults();
    } catch (error) {
      log({
        level: 'error',
        event: 'wifi_defaults_unreadable',
        error: error?.name === 'WifiDefaultsError' ? error.message : 'Error',
      });
      throw new HttpError(
        503,
        'wifi_defaults_unavailable',
        'The console could not read its Wi-Fi defaults just now. Type the network in, or try again in a minute.'
      );
    }
    if (text === null || text === undefined || String(text).trim() === '') {
      entry.detail.stored = false;
      return { status: 200, body: { wifi: null } };
    }
    const wifi = parseWifiDefaults(String(text));
    if (wifi === null) {
      throw new HttpError(
        500,
        'wifi_defaults_invalid',
        'The Wi-Fi defaults stored in the console break the firmware’s rules. Store them again with cloud/deploy.sh.'
      );
    }
    entry.detail.stored = true;
    return { status: 200, body: { wifi } };
  }

  return { wifiDefaults };
}
