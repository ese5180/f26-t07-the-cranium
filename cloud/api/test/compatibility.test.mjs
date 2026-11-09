// Tests for compatibility (docs/fleet.md, Compatibility): the flash layout an image is built for, read
// from its protected TLV 0xA2 and from nowhere else; the layout a board has; and a release offered
// only to boards of its type and its layout, whether they are named, in a group, or in a plan.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOARD_TLV,
  BoardTlvError,
  LAYOUT_TLV,
  boardOfImage,
  layoutFromAttributes,
  layoutFromShadow,
  layoutOfImage,
  releaseLayout,
  resolveLayout,
} from '../src/lib/boards.mjs';
import { ImageError, loadSigningKey, validateImage } from '../src/lib/mcuboot.mjs';
import { A, B, C, D, fleetConsole, report } from './fleet-world.mjs';
import { LOAD_ADDRESS, buildImage, imageKey } from './images.mjs';

const key = imageKey();
const signing = loadSigningKey(key.publicKey.export({ type: 'spki', format: 'pem' }));
const tlvs = (image) => validateImage(image, signing, { maxSize: 0x10000, loadAddress: LOAD_ADDRESS }).protectedTlvs;
const layoutOf = (protectedTlvs) => layoutOfImage(tlvs(buildImage({ version: '1.13.0+0', key, protectedTlvs })));

test('an image without a layout TLV is for layout 1; the layout is read from the protected area only', () => {
  assert.equal(layoutOf([]), 1);
  assert.equal(layoutOf([[BOARD_TLV, 'nrf7002dk']]), 1);
  assert.equal(layoutOf([[LAYOUT_TLV, '2']]), 2);
  assert.equal(
    layoutOf([
      [BOARD_TLV, 'nrf5340dk'],
      [LAYOUT_TLV, '17'],
    ]),
    17
  );
  assert.equal(layoutOf([[LAYOUT_TLV, Buffer.from('3\0')]]), 3);
  // After the signature anyone could add one: such an image is refused, never read as layout 2.
  const forged = buildImage({ version: '1.13.0+0', key, unprotectedTlvs: [[LAYOUT_TLV, '2']] });
  assert.throws(
    () => tlvs(forged),
    (error) => error instanceof ImageError && error.code === 'unexpected_tlv'
  );
  // In the program, the same bytes are only bytes of the program.
  const bytes = Buffer.concat([Buffer.from([LAYOUT_TLV, 0, 1, 0]), Buffer.from('2')]);
  assert.equal(
    layoutOfImage(tlvs(buildImage({ version: '1.13.0+0', key, payload: Buffer.concat([bytes, Buffer.alloc(40, 1)]) }))),
    1
  );
});

test('a layout that is not one positive whole number, or is given twice, is refused', () => {
  for (const value of ['0', '02', '-1', '1.5', 'two', '', ' 2', '10000', Buffer.from([0xff])]) {
    assert.throws(
      () => layoutOf([[LAYOUT_TLV, value]]),
      (error) => error instanceof BoardTlvError && error.code === 'invalid_layout_tlv',
      JSON.stringify(String(value))
    );
  }
  assert.throws(
    () =>
      layoutOf([
        [LAYOUT_TLV, '1'],
        [LAYOUT_TLV, '1'],
      ]),
    (error) => error.code === 'invalid_layout_tlv'
  );
  // The board type is 1 to 16 lower-case letters and digits.
  for (const value of ['nrf_5340dk', 'a'.repeat(17)]) {
    assert.throws(
      () => boardOfImage(tlvs(buildImage({ version: '1.13.0+0', key, protectedTlvs: [[BOARD_TLV, value]] }))),
      (error) => error.code === 'invalid_board_tlv',
      value
    );
  }
});

test('a release records its layout, shows it, and a malformed one leaves nothing behind', async () => {
  const world = fleetConsole();
  const two = await world.release('1.13.0+0', 'nrf7002dk', { protectedTlvs: [[LAYOUT_TLV, '2']] });
  assert.deepEqual([two.board, two.layout], ['nrf7002dk', 2]);
  assert.equal(world.entries('firmware.upload').at(-1).detail.layout, '2');
  const one = await world.release('1.13.1+0');
  assert.equal(one.layout, 1);
  assert.deepEqual(
    (await world.call('GET', '/api/firmware')).body.releases.map((release) => [release.version, release.layout]),
    [
      ['1.13.1+0', 1],
      ['1.13.0+0', 2],
    ]
  );
  const bad = await world.call('POST', '/api/firmware', {
    filename: 'zephyr.signed.bin',
    data: world.image('1.14.0+0', null, { protectedTlvs: [[LAYOUT_TLV, '0']] }).toString('base64'),
  });
  assert.deepEqual([bad.status, bad.body.error.code], [422, 'invalid_layout_tlv']);
  assert.equal(world.fake.releases.size, 2);
  assert.equal(releaseLayout({}), 1);
  assert.equal(releaseLayout({ layout: 0 }), 1);
});

test("a board's layout is what it says, else what its thing says, else 1", async () => {
  const shadow = (diag) => ({ state: { reported: { diag } } });
  assert.equal(layoutFromShadow(shadow({ layout: 2 })), 2);
  assert.equal(layoutFromShadow(shadow({ layout: '3' })), 3);
  assert.equal(layoutFromShadow(shadow({ layout: 0 })), null);
  assert.equal(layoutFromAttributes({ layout: '2' }), 2);
  assert.equal(layoutFromAttributes({ layout: 'two' }), null);
  assert.deepEqual(resolveLayout({ shadow: shadow({ layout: 2 }), attributes: { layout: '3' } }), {
    layout: 2,
    from: 'board',
  });
  assert.deepEqual(resolveLayout({ attributes: { layout: '3' } }), { layout: 3, from: 'thing' });
  assert.deepEqual(resolveLayout({}), { layout: 1, from: 'default' });

  const world = fleetConsole();
  world.online(A, '1.13.0+0', { board: 'nrf7002dk', layout: 2 });
  world.online(B, '1.12.0+0', { attributes: { layout: '3' } });
  world.online(C, '1.12.0+0');
  const boards = Object.fromEntries(
    (await world.call('GET', '/api/fleet')).body.boards.map((board) => [board.thing, board])
  );
  assert.deepEqual([boards[A].layout, boards[A].layoutFrom], [2, 'board']);
  assert.deepEqual([boards[B].layout, boards[B].layoutFrom], [3, 'thing']);
  assert.deepEqual([boards[C].layout, boards[C].layoutFrom], [1, 'default']);
});

/** Boards of the nRF7002 DK on layouts 1 and 2, and a release for each layout. */
async function twoLayouts() {
  const world = fleetConsole();
  world.online(A, '1.12.0+0', { board: 'nrf7002dk', layout: 1 });
  world.online(B, '1.12.0+0', { board: 'nrf7002dk', layout: 2 });
  world.online(C, '1.12.0+0', { board: 'nrf7002dk', layout: 2 });
  await world.release('1.13.0+0', 'nrf7002dk', { protectedTlvs: [[LAYOUT_TLV, '1']] });
  await world.release('1.13.1+0', 'nrf7002dk', { protectedTlvs: [[LAYOUT_TLV, '2']] });
  return world;
}

test('a deployment and a rollout that name a board of another layout are refused, on record', async () => {
  const world = await twoLayouts();
  const deploy = await world.call('POST', '/api/deployments', { version: '1.13.1+0', things: [A, B] });
  assert.deepEqual(
    [deploy.status, deploy.body.error.code, deploy.body.error.details],
    [400, 'incompatible_layout', [{ thing: A, layout: 1 }]]
  );
  assert.match(deploy.body.error.message, /built for flash layout 2/);
  const rollout = await world.call('POST', '/api/rollouts', {
    version: '1.13.0+0',
    target: { kind: 'boards', things: [A, B] },
  });
  assert.deepEqual([rollout.status, rollout.body.error.code], [400, 'incompatible_layout']);
  assert.equal(world.fake.calls.filter((call) => call.method === 'createJob').length, 0);
  assert.deepEqual(
    [world.entries('deployment.create').at(-1).detail.code, world.entries('rollout.create').at(-1).detail.code],
    ['incompatible_layout', 'incompatible_layout']
  );
  // Of the right layout, it goes ahead.
  assert.equal((await world.call('POST', '/api/deployments', { version: '1.13.1+0', things: [B, C] })).status, 201);
});

test('a rollout to a group or a type leaves out the boards of another layout, and says so', async () => {
  const world = await twoLayouts();
  const { group } = (await world.call('POST', '/api/groups', { name: 'Bench', things: [A, B, C] })).body;
  const response = await world.call('POST', '/api/rollouts', {
    version: '1.13.1+0',
    target: { kind: 'group', group: group.id },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.deepEqual(response.body.rollout.things, [B, C]);
  assert.deepEqual(
    response.body.rollout.leftOut.map((entry) => [entry.thing, entry.reason, entry.text]),
    [[A, 'other_layout', 'Flash layout 1: this release is built for layout 2']]
  );
  assert.equal(response.body.rollout.layout, 2);

  // A board whose flash was laid out anew between the canary and its stage is left out of the stage.
  const [canary] = response.body.rollout.canary.things;
  const [other] = [B, C].filter((thing) => thing !== canary);
  world.finish(response.body.rollout.canary.job, canary, 'SUCCEEDED', '1.13.1+0');
  world.fake.device(other).report(report('1.12.0+0', { board: 'nrf7002dk', layout: 3 }));
  world.advance(10_000);
  assert.equal((await world.tick()).done, 1);
  const detail = (await world.call('GET', `/api/rollouts/${response.body.rollout.id}`)).body.rollout;
  assert.deepEqual(
    detail.stages[0].leftOut.map((entry) => [entry.thing, entry.reason]),
    [[other, 'other_layout']]
  );
});

test('"Update everything" leaves out boards of another layout, and refuses one named in the plan', async () => {
  const world = await twoLayouts();
  const { plan } = (await world.call('GET', '/api/fleet/update-everything')).body;
  const [wifi] = plan.types;
  assert.deepEqual([wifi.release.version, wifi.release.layout, wifi.things], ['1.13.1+0', 2, [B, C]]);
  assert.deepEqual(
    wifi.leftOut.map((entry) => [entry.thing, entry.reason]),
    [[A, 'other_layout']]
  );
  const named = await world.call('POST', '/api/fleet/update-everything', {
    types: [{ type: 'nrf7002dk', version: '1.13.1+0', things: [A, B] }],
  });
  assert.deepEqual(
    [named.status, named.body.error.code, named.body.error.details],
    [400, 'incompatible_layout', [{ thing: A, layout: 1 }]]
  );
});

test('a rollback leaves out the boards of another layout as well', async () => {
  const world = fleetConsole();
  world.online(A, '1.12.0+0', { board: 'nrf7002dk', layout: 1 });
  world.online(B, '1.12.0+0', { board: 'nrf7002dk', layout: 2 });
  await world.release('1.13.0+0', 'nrf7002dk', { protectedTlvs: [[LAYOUT_TLV, '1']] });
  await world.release('1.13.1+0', 'nrf7002dk', { protectedTlvs: [[LAYOUT_TLV, '1']] });
  const { group } = (await world.call('POST', '/api/groups', { name: 'Bench', things: [A, B] })).body;
  const { plan } = (await world.call('GET', `/api/groups/${group.id}/rollback`)).body;
  assert.deepEqual([plan.types[0].release.version, plan.types[0].things], ['1.13.0+0', [A]]);
  assert.deepEqual(
    plan.types[0].leftOut.map((entry) => [entry.thing, entry.reason]),
    [[B, 'other_layout']]
  );
  const named = await world.call('POST', `/api/groups/${group.id}/rollback`, {
    types: [{ type: 'nrf7002dk', version: '1.13.0+0', things: [B] }],
  });
  assert.deepEqual([named.status, named.body.error.code], [400, 'incompatible_layout']);
});

test('the check before a Bluetooth send refuses a release of another layout, by the board or by what it said', async () => {
  const world = fleetConsole();
  world.fake.addThing(D, { attributes: { board: 'nrf5340dk', layout: '2' } });
  await world.release('1.13.0+0', 'nrf5340dk');
  const { sha256 } = (await world.call('GET', `/api/firmware/${encodeURIComponent('1.13.0+0')}`)).body.release;
  const check = (body) =>
    world.call('POST', `/api/firmware/${encodeURIComponent('1.13.0+0')}/bluetooth`, { sha256, ...body });
  const byThing = await check({ thing: D });
  assert.deepEqual([byThing.status, byThing.body.error.code], [400, 'incompatible_layout']);
  const bySaying = await check({ type: 'nrf5340dk', layout: 2 });
  assert.deepEqual([bySaying.status, bySaying.body.error.code], [400, 'incompatible_layout']);
  assert.equal((await check({ type: 'nrf5340dk', layout: 1 })).status, 200);
  const bad = await check({ layout: '1' });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'invalid_layout']);
  const entries = world.entries('firmware.bluetooth_send');
  assert.deepEqual(
    entries.map((entry) => [entry.outcome, entry.detail.code ?? null]),
    [
      ['rejected', 'incompatible_layout'],
      ['rejected', 'incompatible_layout'],
      ['ok', null],
      ['rejected', 'invalid_layout'],
    ]
  );
  assert.equal(entries[1].detail.layout, '2');
});
