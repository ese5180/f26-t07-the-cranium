/**
 * Where the boards are: their positions from Wi-Fi (lib/position.mjs), on the list of boards and on
 * each board, and a board's last 20.
 *
 *   GET /api/devices and GET /api/devices/{thing}
 *     every Device also has
 *       position: { lat, lon, accuracy, at } | null     accuracy in metres, at when the scan was received
 *       location: { status, at, apCount, checkedAt }
 *                 status: none (no scan yet), ok, too_few (fewer than 2 access points), unsolved (AWS could
 *                 not place the scan), failed (AWS could not be asked), unknown (the positions could not be
 *                 read); checkedAt: when the same access points were last heard again
 *
 *   GET /api/devices/{thing}/positions
 *     -> { thing, location, positions: [{ lat, lon, accuracy, at }] }   newest first, at most 20
 *
 * Reads, for viewers and release managers alike. What the location function stores is read back
 * through the same checks as everything else in the table. A failure to read the positions never
 * fails the list of boards: their positions are then left out (null), and the log says why.
 */

import { describeError, notFound } from '../http.mjs';
import { historyFromItem, locationFromItem, positionFromItem } from '../lib/position.mjs';
import { requireThing } from '../lib/validate.mjs';

const UNKNOWN = Object.freeze({ status: 'unknown', at: null, apCount: null, checkedAt: null });

export function createLocationHandlers({ aws, log }, { devices }) {
  /** thing -> its item, for every board with one. */
  async function itemsByThing() {
    const items = await aws.listLocations();
    return new Map(items.filter((item) => typeof item?.sk === 'string').map((item) => [item.sk, item]));
  }

  function placed(device, items) {
    if (items === null) return { ...device, position: null, location: { ...UNKNOWN } };
    const item = items.get(device.thing) ?? null;
    return {
      ...device,
      position: positionFromItem(item?.position),
      location: locationFromItem(item),
    };
  }

  async function readItems() {
    try {
      return await itemsByThing();
    } catch (error) {
      log({ level: 'warn', event: 'positions_unreadable', error: describeError(error).message });
      return null;
    }
  }

  return {
    /** A route that answers with { devices }, its boards with their positions. */
    listed(run) {
      return async (request) => {
        const result = await run(request);
        const listed = result?.body?.devices;
        if (!Array.isArray(listed)) return result;
        const items = await readItems();
        return {
          ...result,
          body: { ...result.body, devices: listed.map((device) => placed(device, items)) },
        };
      };
    },

    /** A route that answers with { device }, the board with its position. */
    detailed(run) {
      return async (request) => {
        const result = await run(request);
        const device = result?.body?.device;
        if (device === null || typeof device !== 'object') return result;
        let items = null;
        try {
          const item = await aws.getLocation(device.thing);
          items = new Map(item === null ? [] : [[device.thing, item]]);
        } catch (error) {
          log({
            level: 'warn',
            event: 'positions_unreadable',
            thing: device.thing,
            error: describeError(error).message,
          });
        }
        return { ...result, body: { ...result.body, device: placed(device, items) } };
      };
    },

    async positions({ params }) {
      const thing = requireThing(params.thing);
      if (!(await devices.groupThings()).includes(thing)) {
        throw notFound('unknown_device', 'No board with that name is registered.');
      }
      const item = await aws.getLocation(thing);
      return { body: { thing, location: locationFromItem(item), positions: historyFromItem(item) } };
    },
  };
}
