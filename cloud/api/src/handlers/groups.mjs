/**
 * Groups of boards (docs/fleet.md, Groups and rollouts): names a release manager gives to sets of
 * boards, such as "lab bench" or "demo". A board can be in several. Every board is also in the
 * group of its board type, which is not stored: it is the type (handlers/fleet.mjs).
 *
 *   GET  /api/groups               -> { groups: [Group], types: [{ type, label, things }] }
 *   POST /api/groups               body { name, things? }      -> 201 { group }   group.create
 *   POST /api/groups/{id}          body { name?, things? }     -> { group }       group.update
 *   POST /api/groups/{id}/delete   body {}                     -> { group }       group.delete
 *
 * A Group is { id, name, things, gone, createdAt, createdBy, updatedAt, updatedBy }: `things` are
 * the boards in it that are still registered, `gone` how many were removed from the project since.
 *
 * Where groups live. In the state table (pk GRP), not as AWS IoT thing groups:
 *
 *  - A rollout only ever takes boards of the release's type that are not on it already, and never
 *    a board that updates over Bluetooth only. A thing group as the target of a job would offer
 *    the job to every member, whatever its type; a continuous job would offer it to every board
 *    that joins the group later, unchecked. So a rollout names its boards one by one in any case,
 *    and a group only has to say which boards those are.
 *  - A group can be renamed. A thing group's name is its identity in AWS IoT and cannot change.
 *  - A write here is one conditional item: the name, the boards and who changed them, together.
 *    AWS IoT would take one call per board added or removed, with nothing to hold them together.
 *  - The API role already reads and writes this table and needs nothing new to do so; for thing
 *    groups it would need to create, change and delete them.
 *
 * What that means for a board that joins a group later: it is in the group from then on, and a
 * rollout started after that takes it. One that is under way does not, as a snapshot job would
 * not; the Overview shows the board as behind, and "Update everything" picks it up.
 *
 * A group is never deleted from the table: the role may not delete there. It is marked deleted,
 * with when and by whom, and from then on is not shown or used. A change is made only if nobody
 * changed the group in the meantime (its rev); otherwise 409 group_changed, and the page reads it
 * again. Names are unique, ignoring case, among the groups that are not deleted.
 */

import { HttpError, badRequest, conflict, field, notFound, unprocessable } from '../http.mjs';
import { BOARD_TYPES } from '../lib/boards.mjs';
import {
  MAX_GROUPS, MAX_GROUP_BOARDS, boardLabel, requireGroupId, requireGroupName,
} from '../lib/fleet.mjs';
import { isThing } from '../lib/validate.mjs';
import { groupFromItem } from './fleet.mjs';

// The longest value of an audit detail (lib/audit.mjs): eight thing names and the blanks between them.
const MAX_BOARDS_NAMED = 200;

function groupChanged() {
  return conflict('group_changed', 'Someone changed this group a moment ago. Look at it again and repeat the change.');
}

function unknownGroup() {
  return notFound('unknown_group', 'There is no group with that id.');
}

/** 0 to MAX_GROUP_BOARDS board names, none twice, sorted; undefined when absent and allowed. */
function requireMembers(value, { optional }) {
  if (value === undefined && optional) return undefined;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_GROUP_BOARDS || !value.every(isThing)) {
    throw badRequest('invalid_things', `A group holds up to ${MAX_GROUP_BOARDS} boards, named "cranium-" and 16 hex digits.`);
  }
  if (new Set(value).size !== value.length) throw badRequest('invalid_things', 'A board is listed twice.');
  return [...value].sort();
}

function named(entry, things) {
  entry.detail.things = String(things.length);
  const names = things.join(' ');
  if (names.length <= MAX_BOARDS_NAMED && names !== '') entry.detail.boards = names;
}

export function createGroupHandlers({ aws, now, randomHex }, { devices, fleet }) {
  /** The live group items, and the one with this id (or undefined). */
  async function liveItems() {
    return (await aws.listFleetItems('GRP')).filter((item) => !item?.deletedAt);
  }

  async function requireRegistered(things) {
    const registered = await devices.groupThings();
    const strangers = things.filter((thing) => !registered.includes(thing));
    if (strangers.length > 0) {
      throw unprocessable('unknown_device', strangers.length === 1
        ? `${strangers[0]} is not a registered board.`
        : `These are not registered boards: ${strangers.join(', ')}.`);
    }
    return new Set(registered);
  }

  function requireFreeName(items, name, except = null) {
    const taken = items.find((item) => item.id !== except && String(item.name).toLowerCase() === name.toLowerCase());
    if (taken !== undefined) throw conflict('name_taken', `There is already a group called "${taken.name}".`);
  }

  async function existing(id) {
    const item = await aws.getFleetItem({ pk: 'GRP', sk: id });
    if (item === null || item.deletedAt) throw unknownGroup();
    return item;
  }

  return {
    async list() {
      const registered = new Set(await devices.groupThings());
      const loaded = await fleet.boards();
      return {
        body: {
          groups: await fleet.groups(registered),
          types: BOARD_TYPES.map((type) => ({
            type,
            label: boardLabel(type),
            things: loaded.filter(({ board }) => board.type === type).map(({ board }) => board.thing),
          })),
        },
      };
    },

    async create({ actor, json, entry }) {
      const body = json();
      const name = requireGroupName(field(body, 'name'));
      entry.target = name;
      entry.detail.name = name;
      const things = requireMembers(field(body, 'things'), { optional: false });
      named(entry, things);
      const registered = await requireRegistered(things);
      const items = await liveItems();
      if (items.length >= MAX_GROUPS) {
        throw unprocessable('too_many_groups', `There can be at most ${MAX_GROUPS} groups. Delete one first.`);
      }
      requireFreeName(items, name);

      const at = new Date(now()).toISOString();
      const by = { sub: actor.sub, email: actor.email };
      let item = null;
      for (let attempt = 0; attempt < 3 && item === null; attempt += 1) {
        const id = `grp-${String(randomHex(8)).slice(0, 8)}`;
        const candidate = {
          id, name, things, createdAt: at, createdBy: by, updatedAt: at, updatedBy: by, deletedAt: null, deletedBy: null, rev: 0,
        };
        if ((await aws.putFleetItem({ pk: 'GRP', sk: id, item: candidate })).ok) item = candidate;
      }
      if (item === null) throw new HttpError(500, 'internal_error', 'No free group id after three attempts.');
      entry.target = item.id;
      fleet.forgetGroups();
      return { status: 201, body: { group: groupFromItem(item, registered) } };
    },

    async update({ actor, params, json, entry }) {
      const id = requireGroupId(params.id);
      entry.target = id;
      const body = json();
      const name = field(body, 'name') === undefined ? undefined : requireGroupName(field(body, 'name'));
      const things = requireMembers(field(body, 'things'), { optional: true });
      if (name === undefined && things === undefined) {
        throw badRequest('nothing_to_change', 'Give the group a new "name", its "things", or both.');
      }
      const item = await existing(id);
      entry.detail.name = name ?? item.name;
      const registered = await requireRegistered(things ?? []);
      const set = { updatedAt: new Date(now()).toISOString(), updatedBy: { sub: actor.sub, email: actor.email } };
      if (name !== undefined && name !== item.name) {
        requireFreeName(await liveItems(), name, id);
        set.name = name;
        entry.detail.renamedFrom = item.name;
      }
      if (things !== undefined) {
        const before = new Set(item.things ?? []);
        set.things = things;
        entry.detail.added = String(things.filter((thing) => !before.has(thing)).length);
        entry.detail.removed = String([...before].filter((thing) => !things.includes(thing)).length);
        named(entry, things);
      }
      const changed = await aws.updateFleetItem({ pk: 'GRP', sk: id, rev: item.rev, set });
      if (!changed.ok) throw groupChanged();
      fleet.forgetGroups();
      const all = new Set([...registered, ...await devices.groupThings()]);
      return { body: { group: groupFromItem(changed.item, all) } };
    },

    async remove({ actor, params, entry }) {
      const id = requireGroupId(params.id);
      entry.target = id;
      const item = await existing(id);
      entry.detail.name = item.name;
      const at = new Date(now()).toISOString();
      const changed = await aws.updateFleetItem({
        pk: 'GRP', sk: id, rev: item.rev, set: { deletedAt: at, deletedBy: { sub: actor.sub, email: actor.email } },
      });
      if (!changed.ok) throw groupChanged();
      fleet.forgetGroups();
      const registered = new Set(await devices.groupThings());
      return { body: { group: { ...groupFromItem({ ...changed.item, deletedAt: null }, registered), deletedAt: at } } };
    },
  };
}
