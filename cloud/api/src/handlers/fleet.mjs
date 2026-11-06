/**
 * The fleet as a whole (docs/fleet.md): what each board is, which groups it is in, how the fleet
 * is doing, and what a phone saw of a board.
 *
 *   GET  /api/fleet
 *     -> { boards: [FleetBoard], groups: [Group], types: [TypeSummary], generatedAt }
 *   GET  /api/fleet/health
 *     -> { types: [{ type, label, bluetoothOnly, boards, newest, onNewest, share, versions, unknown }],
 *          updates: { days, succeeded, failed, rolledBack }, attention: [{ thing, name, type, reasons }],
 *          generatedAt }
 *        `updates` counts the updates that ended in the last `days`: those over the internet as the
 *        boards reported their jobs' ends, and those over Bluetooth or by USB or another tool from the
 *        update history (handlers/updates.mjs)
 *   POST /api/devices/{thing}/seen   body { "version": "1.13.0+0", "name": "Cranium-1A2B" }
 *     -> 201 { seen: { thing, version, at, name, by } }
 *
 * A FleetBoard is { thing, name, type, typeFrom, layout, layoutFrom, bluetoothOnly, online, lastSeen,
 * version, versionFrom, seen, groups }: its type and flash layout and where each is known from
 * ("board", "thing" or "default")
 * (lib/boards.mjs), what it runs as far as is known (`versionFrom` "board" for its own report,
 * "phone" for a Bluetooth-only board that a phone saw), and the ids of the named groups it is in.
 *
 * A board's type and layout. What the board says in its diagnostics wins, then its thing's
 * attributes `board` and `layout`, then nrf7002dk and 1. The attributes are read with DescribeThing,
 * at most once a minute per board, and only for a board that has not said both.
 *
 * A sighting. A phone that connects to a board over Bluetooth posts what it saw: that is how a
 * board without Wi-Fi shows on the console at all. Release managers, from the website, a phone or
 * a script; on record as device.seen. Like the other calls of a person at a board it needs no
 * fresh sign-in on the phone (app.mjs atTheBoard): it says what is, and changes no board. At most
 * SEEN_PER_MINUTE a minute per person, counted from the activity log as the serial console's
 * records are: one over that is refused with 429 and leaves no entry. The last sighting of each
 * board is kept (state table, pk SEEN), with when and by whom; never where.
 *
 * The guards that the other handlers ask for are here too: requireJobTargets (a deployment's
 * boards are of the release's type and can take a job) and requireBluetoothBoard (the board a
 * phone is about to send a release to is of its type).
 */

import { HttpError, badRequest, field, notFound } from '../http.mjs';
import { BOARD_TYPES, isBluetoothOnly, resolveBoard, resolveLayout } from '../lib/boards.mjs';
import { eventFromItem, eventRange } from '../lib/events.mjs';
import {
  HEALTH_DAYS,
  attentionReasons,
  boardLabel,
  releasesByType,
  updateResults,
  versionsByType,
} from '../lib/fleet.mjs';
import { MAX_IN_FLIGHT, mapLimit } from '../lib/jobs.mjs';
import { deviceFromShadow } from '../lib/shadow.mjs';
import { updateCounts } from '../lib/updates.mjs';
import { isThing, requireBluetoothName, requireThing, strictVersion } from '../lib/validate.mjs';
import { releaseFromItem } from './firmware.mjs';

const ATTRIBUTES_MS = 60_000;
const RECORDS_MS = 5_000;
const HEALTH_MS = 30_000;
export const SEEN_PER_MINUTE = 60;
export const SEEN_FIELDS = Object.freeze(['version', 'name']);
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function incompatible(boards, release) {
  const names = boards.map((board) => board.thing);
  return new HttpError(
    400,
    'incompatible_board',
    `Release ${release.version} is for the ${boardLabel(release.board)}. ` +
      `${names.length === 1 ? `${names[0]} is` : `${names.join(', ')} are`} ${
        boards.length === 1 ? `an ${boardLabel(boards[0].type)}` : 'of another type'
      }.`,
    boards.map((board) => ({ thing: board.thing, type: board.type }))
  );
}

function incompatibleLayout(boards, release) {
  const names = boards.map((board) => board.thing);
  return new HttpError(
    400,
    'incompatible_layout',
    `Release ${release.version} is built for flash layout ${release.layout}. ` +
      `${names.join(', ')} ${names.length === 1 ? `has layout ${boards[0].layout}` : 'have another layout'}: its flash is ` +
      'divided differently, and the board would refuse it.',
    boards.map((board) => ({ thing: board.thing, layout: board.layout }))
  );
}

function bluetoothOnly(boards) {
  const names = boards.map((board) => board.thing);
  return new HttpError(
    400,
    'bluetooth_only',
    `${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} no Wi-Fi ` +
      'and never reach AWS IoT: update it over Bluetooth from the phone app.',
    boards.map((board) => ({ thing: board.thing, type: board.type }))
  );
}

/** A group item as the API shows it, with only the boards that are still registered. */
export function groupFromItem(item, registered) {
  if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || item.deletedAt) return null;
  const things = (Array.isArray(item.things) ? item.things : []).filter(isThing).sort();
  return {
    id: item.id,
    name: typeof item.name === 'string' ? item.name : item.id,
    things: things.filter((thing) => registered.has(thing)),
    // Boards that were in it and have since been removed from the project.
    gone: things.filter((thing) => !registered.has(thing)).length,
    createdAt: item.createdAt ?? null,
    createdBy: item.createdBy ?? null,
    updatedAt: item.updatedAt ?? item.createdAt ?? null,
    updatedBy: item.updatedBy ?? item.createdBy ?? null,
  };
}

export function createFleetHandlers({ aws, config, now, log }, { devices, updates = () => null }) {
  const attributes = new Map(); // thing -> { value, at }
  let seenCache = null; // { byThing, at }
  let groupCache = null; // { items, at }
  let healthCache = null; // { body, at }

  async function attributesOf(thing) {
    const cached = attributes.get(thing);
    if (cached !== undefined && now() - cached.at < ATTRIBUTES_MS) return cached.value;
    let value = null;
    try {
      value = (await aws.describeThing(thing))?.attributes ?? null;
    } catch (error) {
      // Without its attribute a board is what it says, or a nrf7002dk: show it, and log why.
      log({ level: 'warn', event: 'thing_unreadable', thing, error: String(error?.message ?? error).slice(0, 200) });
      return cached?.value ?? null;
    }
    if (attributes.size >= 512) attributes.clear();
    attributes.set(thing, { value, at: now() });
    return value;
  }

  async function sightings() {
    if (seenCache !== null && now() - seenCache.at < RECORDS_MS) return seenCache.byThing;
    const byThing = new Map();
    for (const item of await aws.listFleetItems('SEEN')) {
      if (isThing(item?.thing) && strictVersion(item.version) !== null) {
        byThing.set(item.thing, {
          version: item.version,
          at: item.at,
          name: item.name ?? null,
          by: typeof item.by?.email === 'string' ? item.by.email : '',
        });
      }
    }
    seenCache = { byThing, at: now() };
    return byThing;
  }

  async function groupItems() {
    if (groupCache !== null && now() - groupCache.at < RECORDS_MS) return groupCache.items;
    const items = (await aws.listFleetItems('GRP')).filter((item) => !item?.deletedAt);
    groupCache = { items, at: now() };
    return items;
  }

  /** The named groups, with their registered boards only, by name. */
  async function groups(registered) {
    return (await groupItems())
      .map((item) => groupFromItem(item, registered))
      .filter((group) => group !== null)
      .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  }

  /**
   * Every registered board (or those in `only`), as [{ board, device }]: the FleetBoard and the
   * Device its shadow makes (lib/shadow.mjs), in thing order.
   */
  async function boards({ only = null } = {}) {
    const registered = await devices.groupThings();
    const things = only === null ? registered : registered.filter((thing) => only.includes(thing));
    const [shadows, seen, named] = await Promise.all([
      devices.loadShadows(things),
      sightings(),
      groups(new Set(registered)),
    ]);
    return mapLimit(things, MAX_IN_FLIGHT, async (thing, index) => {
      const shadow = shadows[index];
      const device = deviceFromShadow(thing, shadow, now());
      // DescribeThing only for a board that has not said what it is and how its flash is laid out.
      const said = resolveBoard({ shadow });
      const saidLayout = resolveLayout({ shadow });
      const attributes = said.from === 'board' && saidLayout.from === 'board' ? null : await attributesOf(thing);
      const known = said.from === 'board' ? said : resolveBoard({ shadow, attributes });
      const layout = saidLayout.from === 'board' ? saidLayout : resolveLayout({ shadow, attributes });
      const { type } = known;
      const sighting = seen.get(thing) ?? null;
      const viaPhone = isBluetoothOnly(type);
      const board = {
        thing,
        name: device.name,
        type,
        typeFrom: known.from,
        layout: layout.layout,
        layoutFrom: layout.from,
        bluetoothOnly: viaPhone,
        online: viaPhone ? false : device.online,
        lastSeen: device.lastSeen,
        version: viaPhone ? (sighting?.version ?? null) : (device.fw?.version ?? null),
        versionFrom: viaPhone ? (sighting === null ? null : 'phone') : device.fw === null ? null : 'board',
        seen: sighting,
        groups: named.filter((group) => group.things.includes(thing)).map((group) => group.id),
      };
      return { board, device };
    });
  }

  async function activeReleases() {
    return (await aws.listReleases())
      .map(releaseFromItem)
      .filter((release) => release !== null && release.status === 'active');
  }

  /** Per type: its boards, and its newest and previous active releases. */
  function typeSummaries(fleetBoards, byType) {
    return BOARD_TYPES.map((type) => ({
      type,
      label: boardLabel(type),
      bluetoothOnly: isBluetoothOnly(type),
      boards: fleetBoards.filter((board) => board.type === type).length,
      newest: byType[type]?.[0]?.version ?? null,
      previous: byType[type]?.[1]?.version ?? null,
    }));
  }

  /**
   * What the boards did with their updates in the last days: the ends of their jobs from the event log,
   * and their other updates, over Bluetooth and by USB or another tool, from the update history.
   */
  async function recentResults(fleetBoards) {
    const toMs = now();
    const sinceMs = toMs - HEALTH_DAYS * DAY_MS;
    const range = eventRange(sinceMs, toMs);
    const history = updates();
    const lists = await mapLimit(
      fleetBoards.filter((board) => !board.bluetoothOnly),
      MAX_IN_FLIGHT,
      async (board) => {
        let events = [];
        let records = [];
        try {
          const items = await aws.queryEvents({ thing: board.thing, ...range, kinds: ['update'], limit: 500 });
          events = items.map(eventFromItem).filter((event) => event !== null);
        } catch (error) {
          log({
            level: 'warn',
            event: 'events_unreadable',
            thing: board.thing,
            error: String(error?.message ?? error).slice(0, 200),
          });
        }
        try {
          records = history === null ? [] : await history.recordsOf(board.thing);
        } catch (error) {
          log({
            level: 'warn',
            event: 'updates_unreadable',
            thing: board.thing,
            error: String(error?.message ?? error).slice(0, 200),
          });
        }
        return { events, records };
      }
    );
    const jobs = updateResults(lists.flatMap((part) => part.events));
    const others = updateCounts(
      lists.flatMap((part) => part.records),
      { sinceMs }
    );
    return {
      succeeded: jobs.succeeded + others.succeeded,
      failed: jobs.failed + others.failed,
      rolledBack: jobs.rolledBack + others.rolledBack,
    };
  }

  /** Throws unless every one of `things` is of the release's type and layout and can be the target of a job. */
  async function requireJobTargets(things, release) {
    const known = (await boards({ only: things })).map(({ board }) => board);
    const others = known.filter((board) => board.type !== release.board);
    if (others.length > 0) throw incompatible(others, release);
    const laidOut = known.filter((board) => board.layout !== release.layout);
    if (laidOut.length > 0) throw incompatibleLayout(laidOut, release);
    const away = known.filter((board) => board.bluetoothOnly);
    if (away.length > 0) throw bluetoothOnly(away);
    return known;
  }

  /**
   * Throws unless the board a phone is about to send `release` to is of its type and layout. The
   * board is named by its thing name, or by the type and layout it told the phone; a check without
   * any of them has nothing to go by, and is let through as before board types.
   */
  async function requireBluetoothBoard({ thing = null, type = null, layout = null }, release) {
    if (thing !== null) {
      const [found] = await boards({ only: [thing] });
      if (found === undefined) throw notFound('unknown_device', `${thing} is not a registered board.`);
      if (found.board.type !== release.board) throw incompatible([found.board], release);
      if (found.board.layout !== release.layout) throw incompatibleLayout([found.board], release);
    }
    if (layout !== null && layout !== release.layout) {
      throw new HttpError(
        400,
        'incompatible_layout',
        `Release ${release.version} is built for flash layout ` +
          `${release.layout}, and the board says its layout is ${layout}. Do not send it.`,
        [{ thing, layout }]
      );
    }
    if (type !== null && type !== release.board) {
      throw new HttpError(
        400,
        'incompatible_board',
        `Release ${release.version} is for the ${boardLabel(release.board)}, ` +
          `and the board says it is an ${boardLabel(type)}. Do not send it.`,
        [{ thing, type }]
      );
    }
  }

  /** How many sightings this person has put on record in the last minute. */
  async function recentSightings(sub) {
    const after = new Date(now() - MINUTE_MS).toISOString();
    const items = await aws.queryAudit({ before: null, after, limit: 1000 });
    return items.filter((item) => item?.action === 'device.seen' && item?.actor?.sub === sub).length;
  }

  return {
    boards,
    groups,
    activeReleases,
    releasesByType: async () => releasesByType(await activeReleases()),
    requireJobTargets,
    requireBluetoothBoard,
    /** Groups were changed here: read them again next time. */
    forgetGroups() {
      groupCache = null;
      healthCache = null;
    },
    forgetSightings() {
      seenCache = null;
    },

    async overview() {
      const [loaded, releases] = await Promise.all([boards(), activeReleases()]);
      const fleetBoards = loaded.map(({ board }) => board);
      const registered = new Set(fleetBoards.map((board) => board.thing));
      return {
        body: {
          boards: fleetBoards,
          groups: await groups(registered),
          types: typeSummaries(fleetBoards, releasesByType(releases)),
          generatedAt: new Date(now()).toISOString(),
        },
      };
    },

    async health() {
      if (healthCache !== null && now() - healthCache.at < HEALTH_MS) return { body: healthCache.body };
      const [loaded, releases] = await Promise.all([boards(), activeReleases()]);
      const fleetBoards = loaded.map(({ board }) => board);
      const byType = releasesByType(releases);
      const newest = Object.fromEntries(BOARD_TYPES.map((type) => [type, byType[type]?.[0]?.version ?? null]));
      const attention = loaded
        .map(({ board, device }) => ({
          thing: board.thing,
          name: board.name,
          type: board.type,
          reasons: attentionReasons(board, device, now()),
        }))
        .filter((entry) => entry.reasons.length > 0);
      const body = {
        types: versionsByType(fleetBoards, newest, BOARD_TYPES),
        updates: { days: HEALTH_DAYS, ...(await recentResults(fleetBoards)) },
        attention,
        generatedAt: new Date(now()).toISOString(),
      };
      healthCache = { body, at: now() };
      return { body };
    },

    async seen({ caller, actor, params, json, entry }) {
      const thing = requireThing(params.thing);
      entry.target = thing;
      const body = json();
      const extra = Object.keys(body).filter((key) => !SEEN_FIELDS.includes(key));
      if (extra.length > 0)
        throw badRequest('unexpected_field', 'A sighting is "version" and "name", and nothing else.');
      const version = strictVersion(field(body, 'version'));
      if (version === null) {
        throw badRequest(
          'invalid_version',
          '"version" is the firmware the board told the phone it runs, like 1.13.0+0.'
        );
      }
      entry.detail.version = version.text;
      const name = requireBluetoothName(field(body, 'name'));
      if (name !== null) entry.detail.board = name;
      if (caller?.clientId !== undefined && caller.clientId === config.mobileClientId) entry.detail.from = 'phone';
      if (!(await devices.groupThings()).includes(thing)) {
        throw notFound('unknown_device', 'No board with that name is registered.');
      }
      if ((await recentSightings(caller.sub)) >= SEEN_PER_MINUTE) {
        throw new HttpError(
          429,
          'rate_limited',
          `At most ${SEEN_PER_MINUTE} sightings a minute are recorded for one person.`
        );
      }
      const at = new Date(now()).toISOString();
      await aws.putFleetItem({
        pk: 'SEEN',
        sk: thing,
        replace: true,
        item: { thing, version: version.text, at, name, by: { sub: actor.sub, email: actor.email }, rev: 0 },
      });
      seenCache = null;
      healthCache = null;
      return { status: 201, body: { seen: { thing, version: version.text, at, name, by: actor.email } } };
    },
  };
}
