// Tests for groups of boards (handlers/groups.mjs): made, renamed, changed and deleted by release
// managers, each change on record; a board in several; every board in its type's group as well.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { A, B, C, D, fleetConsole } from './fleet-world.mjs';

async function withBoards() {
  const world = fleetConsole();
  world.online(A);
  world.online(B);
  world.bluetoothOnly(C);
  return world;
}

test('a group is made, renamed, changed and deleted, each change on record', async () => {
  const world = await withBoards();
  const made = await world.call('POST', '/api/groups', { name: '  Lab bench ', things: [B, A] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const { group } = made.body;
  assert.match(group.id, /^grp-[0-9a-f]{8}$/);
  assert.deepEqual([group.name, group.things, group.gone, group.createdBy.email], ['Lab bench', [A, B], 0, world.manager.email]);

  const renamed = await world.call('POST', `/api/groups/${group.id}`, { name: 'Demo' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.group.name, 'Demo');
  const changed = await world.call('POST', `/api/groups/${group.id}`, { things: [A, C] });
  assert.deepEqual(changed.body.group.things, [A, C]);

  const listed = await world.call('GET', '/api/groups', undefined, world.viewer);
  assert.deepEqual(listed.body.groups.map((item) => [item.name, item.things]), [['Demo', [A, C]]]);
  // Every board is in the group of its type as well, which is not stored.
  assert.deepEqual(listed.body.types.map((type) => [type.type, type.things]), [['nrf7002dk', [A, B]], ['nrf5340dk', [C]]]);

  const deleted = await world.call('POST', `/api/groups/${group.id}/delete`, {});
  assert.equal(deleted.status, 200);
  assert.equal(typeof deleted.body.group.deletedAt, 'string');
  assert.deepEqual((await world.call('GET', '/api/groups')).body.groups, []);
  // Never removed from the table: marked, with who and when.
  const [stored] = world.fake.fleetItems.values();
  assert.deepEqual([stored.deletedBy.email, stored.name], [world.manager.email, 'Demo']);
  assert.equal((await world.call('POST', `/api/groups/${group.id}`, { name: 'Again' })).status, 404);

  const records = world.fake.auditLog().filter((entry) => entry.action.startsWith('group.'));
  assert.deepEqual(records.map((entry) => [entry.action, entry.target, entry.outcome]), [
    ['group.create', group.id, 'ok'], ['group.update', group.id, 'ok'], ['group.update', group.id, 'ok'],
    ['group.delete', group.id, 'ok'], ['group.update', group.id, 'rejected'],
  ]);
  assert.deepEqual(records[0].detail, { name: 'Lab bench', things: '2', boards: `${A} ${B}` });
  assert.deepEqual(records[1].detail, { name: 'Demo', renamedFrom: 'Lab bench' });
  assert.deepEqual(records[2].detail, { name: 'Demo', added: '1', removed: '1', things: '2', boards: `${A} ${C}` });
});

test('a board can be in several groups, and its chips say which', async () => {
  const world = await withBoards();
  const one = (await world.call('POST', '/api/groups', { name: 'Bench', things: [A] })).body.group;
  const two = (await world.call('POST', '/api/groups', { name: 'Demo', things: [A, B] })).body.group;
  const boards = Object.fromEntries((await world.call('GET', '/api/fleet')).body.boards.map((board) => [board.thing, board.groups]));
  assert.deepEqual(boards[A].sort(), [one.id, two.id].sort());
  assert.deepEqual(boards[B], [two.id]);
  assert.deepEqual(boards[C], []);
});

test('names are unique whatever their case; boards must be registered; a viewer may not', async () => {
  const world = await withBoards();
  assert.equal((await world.call('POST', '/api/groups', { name: 'Bench', things: [] })).status, 201);
  const taken = await world.call('POST', '/api/groups', { name: 'bench' });
  assert.deepEqual([taken.status, taken.body.error.code], [409, 'name_taken']);
  const stranger = await world.call('POST', '/api/groups', { name: 'Other', things: [D] });
  assert.deepEqual([stranger.status, stranger.body.error.code], [422, 'unknown_device']);
  for (const body of [{}, { name: '' }, { name: 'x'.repeat(41) }, { name: 'two\nlines' }, { name: 'Ok', things: [A, A] },
    { name: 'Ok', things: 'all' }]) {
    const response = await world.call('POST', '/api/groups', body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const viewer = await world.call('POST', '/api/groups', { name: 'Mine' }, world.viewer);
  assert.deepEqual([viewer.status, viewer.body.error.code], [403, 'release_manager_required']);
  assert.equal((await world.call('POST', '/api/groups/not-a-group', { name: 'X' })).status, 400);
  assert.equal((await world.call('POST', '/api/groups/grp-00000000', { name: 'X' })).status, 404);
  const nothing = (await world.call('GET', '/api/groups')).body.groups[0];
  assert.deepEqual([(await world.call('POST', `/api/groups/${nothing.id}`, {})).body.error.code], ['nothing_to_change']);
  assert.equal(world.fake.auditLog().filter((entry) => entry.action === 'group.create' && entry.outcome !== 'ok').length, 9);
});

test('a change made in the meantime by someone else is not overwritten', async () => {
  const world = await withBoards();
  const { group } = (await world.call('POST', '/api/groups', { name: 'Bench', things: [A] })).body;
  // Someone else's change lands between this request's read and its write.
  const original = world.fake.updateFleetItem;
  world.fake.updateFleetItem = async (input) => {
    world.fake.updateFleetItem = original;
    await original({ pk: 'GRP', sk: group.id, rev: input.rev, set: { name: 'Theirs' } });
    return original(input);
  };
  const response = await world.call('POST', `/api/groups/${group.id}`, { name: 'Mine' });
  assert.deepEqual([response.status, response.body.error.code], [409, 'group_changed']);
  assert.equal((await world.call('GET', '/api/groups')).body.groups[0].name, 'Theirs');
});

test('a board removed from the project drops out of its groups, and is counted as gone', async () => {
  const world = await withBoards();
  const { group } = (await world.call('POST', '/api/groups', { name: 'Bench', things: [A, B] })).body;
  world.fake.removeThing(B);
  world.advance(10_000);
  const [listed] = (await world.call('GET', '/api/groups')).body.groups;
  assert.deepEqual([listed.id, listed.things, listed.gone], [group.id, [A], 1]);
});
