// Tests for board names given in the console (handlers/devices.mjs rename, lib/names.mjs): a release manager gives
// a board a name or takes it away, on record; every Device in a reply carries it; a viewer may not.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { labelFromItem, requireBoardLabel } from '../src/lib/names.mjs';
import { A, B, D, fleetConsole } from './fleet-world.mjs';

function withBoards() {
  const world = fleetConsole();
  world.online(A);
  world.online(B);
  return world;
}

test('a board is named, renamed and its name taken away, each change on record, and the lists say it', async () => {
  const world = withBoards();
  const named = await world.call('POST', `/api/devices/${A}/label`, { label: '  Demo deck 1 ' });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.deepEqual(named.body, { thing: A, label: 'Demo deck 1' });

  // Every member reads it, in the list and on the board's own page; a board with none has null.
  const listed = await world.call('GET', '/api/devices', undefined, world.viewer);
  const labels = new Map(listed.body.devices.map((device) => [device.thing, device.label]));
  assert.equal(labels.get(A), 'Demo deck 1');
  assert.equal(labels.get(B), null);
  assert.ok(listed.body.devices.every((device) => Object.hasOwn(device, 'label')));
  const own = await world.call('GET', `/api/devices/${A}`, undefined, world.viewer);
  assert.equal(own.body.device.label, 'Demo deck 1');

  assert.equal((await world.call('POST', `/api/devices/${A}/label`, { label: 'Bench · left' })).status, 200);
  assert.equal((await world.call('GET', `/api/devices/${A}`)).body.device.label, 'Bench · left');
  // Null or "" takes it away: the item stays, with no name, as the role may not delete there.
  const cleared = await world.call('POST', `/api/devices/${A}/label`, { label: '' });
  assert.deepEqual(cleared.body, { thing: A, label: null });
  assert.equal((await world.call('GET', `/api/devices/${A}`)).body.device.label, null);
  assert.equal((await world.call('POST', `/api/devices/${A}/label`, { label: null })).status, 200);

  const records = world.fake.auditLog().filter((entry) => entry.action === 'device.rename');
  assert.deepEqual(
    records.map((entry) => [entry.target, entry.outcome, entry.detail.name ?? null, entry.detail.renamedFrom ?? null]),
    [
      [A, 'ok', 'Demo deck 1', null],
      [A, 'ok', 'Bench · left', 'Demo deck 1'],
      [A, 'ok', null, 'Bench · left'],
      [A, 'ok', null, null],
    ]
  );
  // Each says what the name was and what it is now.
  assert.deepEqual(records[1].changes, [{ field: 'name', from: 'Demo deck 1', to: 'Bench · left' }]);
  assert.deepEqual(records[2].changes, [{ field: 'name', from: 'Bench · left', to: null }]);
  assert.deepEqual(records[3].changes ?? [], []);
});

test('a name is one line of 1 to 40 printable characters, of a registered board, given by a release manager', async () => {
  const world = withBoards();
  for (const body of [
    { label: 'x'.repeat(41) },
    { label: 'two\nlines' },
    { label: 'tab\there' },
    { label: 'Demo‮1' },
    { label: 42 },
    { label: ['Demo'] },
  ]) {
    const response = await world.call('POST', `/api/devices/${A}/label`, body);
    assert.deepEqual([response.status, response.body.error.code], [400, 'invalid_label'], JSON.stringify(body));
  }
  assert.equal((await world.call('POST', `/api/devices/${A}/label`, { label: 'x'.repeat(40) })).status, 200);
  const unknown = await world.call('POST', `/api/devices/${D}/label`, { label: 'Ghost' });
  assert.deepEqual([unknown.status, unknown.body.error.code], [404, 'unknown_device']);
  assert.equal((await world.call('POST', '/api/devices/not-a-board/label', { label: 'X' })).status, 400);
  const viewer = await world.call('POST', `/api/devices/${B}/label`, { label: 'Mine' }, world.viewer);
  assert.deepEqual([viewer.status, viewer.body.error.code], [403, 'release_manager_required']);
  assert.equal((await world.call('GET', `/api/devices/${B}`)).body.device.label, null);
  // Every attempt is on record, the refused ones too.
  assert.equal(world.fake.auditLog().filter((entry) => entry.action === 'device.rename').length, 10);
});

test('the rules of a name, and a stored item that is not one', () => {
  assert.equal(requireBoardLabel(' Demo '), 'Demo');
  assert.equal(requireBoardLabel(''), null);
  assert.equal(requireBoardLabel('   '), null);
  assert.equal(requireBoardLabel(null), null);
  assert.equal(requireBoardLabel('Café rack 2'), 'Café rack 2');
  assert.equal(requireBoardLabel('😀'.repeat(40)), '😀'.repeat(40), 'characters are counted, not code units');
  assert.throws(() => requireBoardLabel('a\u0000b'), /printable/);
  assert.equal(labelFromItem({ label: 'Demo' }), 'Demo');
  assert.equal(labelFromItem({ label: ' Demo' }), null);
  assert.equal(labelFromItem({ label: null }), null);
  assert.equal(labelFromItem(null), null);
});
