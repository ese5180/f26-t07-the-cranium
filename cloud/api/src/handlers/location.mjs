/**
 * Where the boards are: their positions from Wi-Fi (lib/position.mjs), on the list of boards and on
 * each board, and a board's last 20.
 *
 *   GET /api/devices and GET /api/devices/{thing}
 *     every Device also has
 *       position: { lat, lon, accuracy, at } | null     accuracy in metres, at when the scan was received
 *       location: { status, at, apCount, checkedAt, bluetoothOnly }
 *                 status: none (no scan yet), ok, too_few (fewer than 2 access points), unsolved (AWS could
 *                 not place the scan), failed (AWS could not be asked), unknown (the positions could not be
 *                 read); checkedAt: when the same access points were last heard again; bluetoothOnly: the
 *                 board is a nrf5340dk, which has no Wi-Fi and never has a position (its thing's attribute
 *                 `board`, read for a board that has never reported)
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

export function createLocationHandlers({ aws, now, log }, { devices }) {
  /** thing -> its item, for every board with one. */
  async function itemsByThing() {
    const items = await aws.listLocations();
    return new Map(items.filter((item) => typeof item?.sk === 'string').map((item) => [item.sk, item]));
  }

  // Thing attributes, read for a board that has never reported, for a minute.
  const attributes = new Map();
  const ATTRIBUTES_MS = 60_000;

  async function attributesOf(thing) {
    const cached = attributes.get(thing);
    if (cached !== undefined && now() - cached.at < ATTRIBUTES_MS) return cached.value;
    const value = (await aws.describeThing(thing))?.attributes ?? null;
    if (attributes.size >= 512) attributes.clear();
    attributes.set(thing, { value, at: now() });
    return value;
  }

  /**
   * thing -> true for a board with Bluetooth only (docs/fleet.md, "Board types"). Such a board never
   * reaches AWS IoT, so only a board that has never reported can be one, and its type is then its
   * thing's attribute `board`, as provisioning sets it (and as handlers/fleet.mjs reads it).
   */
  async function bluetoothOnly(listed) {
    const silent = listed.filter((device) => device.lastSeen === null && device.fw === null).map((device) => device.thing);
    if (typeof aws.describeThing !== 'function' || silent.length === 0) return new Map();
    const read = await Promise.allSettled(silent.map(attributesOf));
    return new Map(silent.map((thing, index) =>
      [thing, read[index].status === 'fulfilled' && read[index].value?.board === 'nrf5340dk']));
  }

  function placed(device, items, viaPhone) {
    const only = viaPhone.get(device.thing) === true;
    if (items === null) return { ...device, position: null, location: { ...UNKNOWN, bluetoothOnly: only } };
    const item = items.get(device.thing) ?? null;
    return { ...device, position: positionFromItem(item?.position), location: { ...locationFromItem(item), bluetoothOnly: only } };
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
        const [items, viaPhone] = await Promise.all([readItems(), bluetoothOnly(listed)]);
        return { ...result, body: { ...result.body, devices: listed.map((device) => placed(device, items, viaPhone)) } };
      };
    },

    /** A route that answers with { device }, the board with its position. */
    detailed(run) {
      return async (request) => {
        const result = await run(request);
        const device = result?.body?.device;
        if (device === null || typeof device !== 'object') return result;
        let items = null;
        const viaPhone = bluetoothOnly([device]);
        try {
          const item = await aws.getLocation(device.thing);
          items = new Map(item === null ? [] : [[device.thing, item]]);
        } catch (error) {
          log({ level: 'warn', event: 'positions_unreadable', thing: device.thing, error: describeError(error).message });
        }
        return { ...result, body: { ...result.body, device: placed(device, items, await viaPhone) } };
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
