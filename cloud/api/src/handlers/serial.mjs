/**
 * POST /api/serial/commands: who changed a board at its serial console, for the activity log.
 *
 * The console's Serial page (cloud/web/src/site/assets/serial.js), and later the phone apps,
 * drive a board over USB from the person's own device: the command goes over the cable and the
 * server never sees it. After the board has answered OK to a command that changes it, the page
 * posts which command it was, and the board's own device ID and firmware version as the board
 * gave them over the cable (GET_ID). The entry says who did it; the board's log (lib/lines.mjs)
 * says, from firmware 1.12.0, that it was done.
 *
 *   body { "command": "WIFI", "device": "CRVIHAAN01", "version": "1.12.0+0" }
 *        `device` and `version` may be left out: a board in factory mode has no ID yet
 *   ->   201 { "recorded": { command, device, version } }
 *
 * Never a value: no network name, password, endpoint, key or certificate. The body may hold
 * these three fields and nothing else, so that a page that sent more is refused rather than
 * recorded. What is recorded is what the poster says, which the server cannot check: it is a
 * statement of a release manager's session, as an entry of every other route is.
 *
 * At most 30 a minute per person, counted from the activity log itself, so that it holds
 * across every instance of the function. A post over that is refused with 429 and, unlike the
 * route's other refusals, leaves no entry: the limit is there to keep the log from filling up.
 */

import { HttpError, badRequest, field } from '../http.mjs';
import { BOARD_NAME } from '../lib/shadow.mjs';
import { strictVersion } from '../lib/validate.mjs';

// What changes a board at its serial console and answers OK before it does: console_cmd.c's
// commands_that_change_the_board, the two that erase it (INIT, FACTORY_RESET), the two
// that restart it, one of them into the bootloader that takes an image over the cable, and the
// two that set the board's own Bluetooth passkey (BT_PASSKEY, BT_OFFLINE|NEW).
export const SERIAL_COMMANDS = Object.freeze([
  'INIT',
  'SET_ID',
  'RESET_CONFIG',
  'FACTORY_RESET',
  'WIFI',
  'WIFI_SEC',
  'CLEAR_WIFI',
  'CLOUD',
  'KEYGEN',
  'MQTT_HOST',
  'MQTT_RECONNECT',
  'BUTTON',
  'REBOOT',
  'ENTER_BOOTLOADER',
  'BT_PASSKEY',
  'BT_OFFLINE',
]);
export const SERIAL_FIELDS = Object.freeze(['command', 'device', 'version']);
export const SERIAL_PER_MINUTE = 30;
const MINUTE_MS = 60_000;

export function createSerialHandlers({ aws, config, now }) {
  /** How many of this person's records the activity log holds from the last minute. */
  async function recentRecords(sub) {
    const after = new Date(now() - MINUTE_MS).toISOString();
    const items = await aws.queryAudit({ before: null, after, limit: 1000 });
    return items.filter((item) => item?.action === 'serial.command' && item?.actor?.sub === sub).length;
  }

  return {
    async record({ caller, json, entry }) {
      const body = json();
      const extra = Object.keys(body).filter((key) => !SERIAL_FIELDS.includes(key));
      if (extra.length > 0) {
        throw badRequest(
          'unexpected_field',
          'Only "command", "device" and "version" are recorded: ' + 'never what was typed after the command.'
        );
      }
      const command = field(body, 'command');
      if (typeof command !== 'string' || !SERIAL_COMMANDS.includes(command)) {
        throw badRequest('invalid_command', `"command" must be one of: ${SERIAL_COMMANDS.join(', ')}.`);
      }
      entry.detail.command = command;
      const device = field(body, 'device') ?? null;
      if (device !== null && (typeof device !== 'string' || !BOARD_NAME.test(device))) {
        throw badRequest('invalid_device', '"device" is the board\'s device ID: 1 to 32 letters or digits.');
      }
      const version = field(body, 'version') ?? null;
      const parsed = version === null ? null : strictVersion(version);
      if (version !== null && parsed === null) {
        throw badRequest('invalid_version', '"version" is the firmware version the board gave, like 1.12.0+0.');
      }
      entry.target = device ?? '';
      if (parsed !== null) entry.detail.version = parsed.text;
      if (caller?.clientId !== undefined && caller.clientId === config.mobileClientId) entry.detail.from = 'phone';

      if ((await recentRecords(caller.sub)) >= SERIAL_PER_MINUTE) {
        throw new HttpError(
          429,
          'rate_limited',
          `At most ${SERIAL_PER_MINUTE} serial console commands a minute are ` +
            'recorded for one person. The command was done on the board all the same.'
        );
      }
      return { status: 201, body: { recorded: { command, device, version: parsed?.text ?? null } } };
    },
  };
}
