/**
 * POST /api/devices/{thing}/commands: a command for one board, now (docs/fleet.md, "Commands").
 *
 *   body { "cmd": "identify", "seconds": 15 }   seconds: 1 to 60, 15 when left out
 *        { "cmd": "report" }
 *   ->   202 { "command": { id, cmd, seconds?, thing, sentAt, online } }
 *
 * The console publishes { id, cmd, seconds? } on cranium/<thing>/commands, QoS 1, and that is all
 * it does: the board answers on its own log, with a line of tag CMD such as
 * "identify for 15 s (3f9c2a1b7d4e6f80)", which the console shows when it arrives (kind "setting").
 * A board that is offline misses the command, as the contract means it to: these are for now,
 * and nothing is queued. `online` says whether the board was online by its last heartbeat.
 *
 * `id` is 16 hex digits from the server's CSPRNG, never the caller's. Release managers only, and
 * each command is on record as board.command with its name, id and length. At most 10 a minute per
 * person, counted from the activity log as for the serial console, so that it holds across every
 * instance of the function; a command over that is refused with 429 and leaves no entry.
 *
 * From a phone, "identify" needs no fresh sign-in, as at a board (app.mjs `atTheBoard`): it blinks
 * two LEDs for at most a minute, changes nothing and costs nothing, and it is what a person standing
 * at a bench of boards uses to tell which one is which. "report" does need one: it is used from
 * anywhere, and it makes the board send its Wi-Fi scan to AWS, which is a paid position estimate.
 * A Bluetooth-only board (nrf5340dk) never reaches AWS IoT and is refused (409).
 */

import { randomBytes } from 'node:crypto';

import { requireFreshSignIn } from '../auth.mjs';
import { HttpError, badRequest, conflict, field, notFound } from '../http.mjs';
import { requireThing } from '../lib/validate.mjs';

export const COMMANDS = Object.freeze(['identify', 'report']);
export const COMMANDS_PER_MINUTE = 10;
export const IDENTIFY_SECONDS = Object.freeze({ min: 1, max: 60, fallback: 15 });
const FIELDS = Object.freeze(['cmd', 'seconds']);
const MINUTE_MS = 60_000;
const COMMAND_ID = /^[0-9a-f]{16}$/;

/**
 * Whether a board has Bluetooth only, as the fleet knows its type (handlers/fleet.mjs): its own report,
 * else its thing's attribute. Without the fleet, by what the board list says of it.
 */
async function bluetoothOnly(thing, device, fleet) {
  if (typeof fleet?.boards === 'function') {
    const [known] = await fleet.boards({ only: [thing] });
    if (typeof known?.board?.bluetoothOnly === 'boolean') return known.board.bluetoothOnly;
  }
  return device?.board === 'nrf5340dk';
}

export function createCommandHandlers({ aws, config, now, randomHex }, { devices, fleet = null }) {
  /** How many commands this person has on record from the last minute. */
  async function recentCommands(sub) {
    const after = new Date(now() - MINUTE_MS).toISOString();
    const items = await aws.queryAudit({ before: null, after, limit: 1000 });
    return items.filter((item) => item?.action === 'board.command' && item?.actor?.sub === sub).length;
  }

  /** 16 hex digits for a command, from the CSPRNG. */
  function commandId() {
    const drawn = String(randomHex(8)).slice(0, 16);
    return COMMAND_ID.test(drawn) ? drawn : randomBytes(8).toString('hex');
  }

  return {
    async send({ caller, params, json, entry }) {
      const thing = requireThing(params.thing);
      entry.target = thing;
      const body = json();
      if (Object.keys(body).some((key) => !FIELDS.includes(key))) {
        throw badRequest('unexpected_field', 'A command has "cmd" and, for identify, "seconds": nothing else.');
      }
      const cmd = field(body, 'cmd');
      if (typeof cmd !== 'string' || !COMMANDS.includes(cmd)) {
        throw badRequest('invalid_command', `"cmd" must be one of: ${COMMANDS.join(', ')}.`);
      }
      entry.detail.cmd = cmd;
      const given = field(body, 'seconds');
      let seconds = null;
      if (cmd === 'identify') {
        seconds = given ?? IDENTIFY_SECONDS.fallback;
        if (!Number.isSafeInteger(seconds) || seconds < IDENTIFY_SECONDS.min || seconds > IDENTIFY_SECONDS.max) {
          throw badRequest('invalid_seconds', '"seconds" is how long the board blinks: a whole number from 1 to 60.');
        }
        entry.detail.seconds = seconds;
      } else if (given !== undefined) {
        throw badRequest('unexpected_field', 'Only identify takes "seconds".');
      }
      const fromPhone = caller?.clientId !== undefined && caller.clientId === config.mobileClientId;
      if (fromPhone) {
        entry.detail.from = 'phone';
        if (cmd !== 'identify') requireFreshSignIn(caller, now());
      }

      if (!(await devices.groupThings()).includes(thing)) {
        throw notFound('unknown_device', 'No board with that name is registered.');
      }
      const [device] = await devices.loadDevices([thing]);
      if (await bluetoothOnly(thing, device, fleet)) {
        throw conflict('bluetooth_only', 'This board has Bluetooth only and never connects to AWS IoT, so it cannot ' +
          'be sent a command. Use the phone app next to it.');
      }
      if (await recentCommands(caller.sub) >= COMMANDS_PER_MINUTE) {
        throw new HttpError(429, 'rate_limited', `At most ${COMMANDS_PER_MINUTE} commands a minute can be sent by one ` +
          'person. Wait a moment and send it again.');
      }

      const id = commandId();
      entry.detail.id = id;
      const payload = seconds === null ? { id, cmd } : { id, cmd, seconds };
      await aws.publishCommand({ thing, payload });
      const command = { ...payload, thing, sentAt: new Date(now()).toISOString(), online: device?.online === true };
      return { status: 202, body: { command } };
    },
  };
}
