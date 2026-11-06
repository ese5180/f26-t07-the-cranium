// Tests for board types (docs/fleet.md, Board types): what an image says it is for, read from its
// protected TLVs and from nowhere else, and what a board is: its own word, its thing, or the default.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOARD_TLV,
  BoardTlvError,
  boardFromAttributes,
  boardFromShadow,
  boardOfImage,
  releaseBoard,
  resolveBoard,
} from '../src/lib/boards.mjs';
import { ImageError, loadSigningKey, validateImage } from '../src/lib/mcuboot.mjs';
import { A, B, C, fleetConsole, report } from './fleet-world.mjs';
import { LOAD_ADDRESS, TLV_SEC_CNT, buildImage, imageKey } from './images.mjs';

const key = imageKey();
const signing = loadSigningKey(key.publicKey.export({ type: 'spki', format: 'pem' }));
const options = { maxSize: 0x10000, loadAddress: LOAD_ADDRESS };
const validate = (image) => validateImage(image, signing, options);
const boardOf = (image) => boardOfImage(validate(image).protectedTlvs);
const counter = Buffer.from([7, 0, 0, 0]);

test('an image with no board TLV is a nrf7002dk image, as every release up to 1.12.0', () => {
  assert.equal(boardOf(buildImage({ version: '1.12.0+0', key })), 'nrf7002dk');
  // A protected area with other entries only, as imgtool --security-counter makes it.
  const counted = buildImage({ version: '1.12.0+0', key, protectedTlvs: [[TLV_SEC_CNT, counter]] });
  assert.equal(validate(counted).protectedTlvs.length, 1);
  assert.equal(boardOf(counted), 'nrf7002dk');
});

test('the board type is read from the protected area, which the signature covers', () => {
  assert.equal(boardOf(buildImage({ version: '1.13.0+0', key, board: 'nrf5340dk' })), 'nrf5340dk');
  assert.equal(boardOf(buildImage({ version: '1.13.0+0', key, board: 'nrf7002dk' })), 'nrf7002dk');
  assert.equal(
    boardOf(buildImage({ version: '1.13.0+0', key, board: 'nrf5340dk', protectedTlvs: [[TLV_SEC_CNT, counter]] })),
    'nrf5340dk'
  );
  // A build that writes the value as a C string is read the same.
  assert.equal(
    boardOf(buildImage({ version: '1.13.0+0', key, protectedTlvs: [[BOARD_TLV, Buffer.from('nrf5340dk\0')]] })),
    'nrf5340dk'
  );

  // Changed after signing, the protected area no longer matches the signed hash.
  const image = buildImage({ version: '1.13.0+0', key, board: 'nrf7002dk' });
  const at = image.indexOf(Buffer.from('nrf7002dk'));
  Buffer.from('nrf5340dk').copy(image, at);
  assert.throws(
    () => validate(image),
    (error) => error instanceof ImageError && error.code === 'hash_mismatch'
  );
});

test('a board TLV outside the protected area is never read as the board type', () => {
  // After the signature, where anyone can add it to a signed image without breaking the
  // signature: such an image is refused outright, and so is a type in both places.
  const forged = buildImage({ version: '1.13.0+0', key, unprotectedTlvs: [[BOARD_TLV, 'nrf5340dk']] });
  assert.throws(
    () => validate(forged),
    (error) => error instanceof ImageError && error.code === 'unexpected_tlv'
  );
  const both = buildImage({
    version: '1.13.0+0',
    key,
    board: 'nrf7002dk',
    unprotectedTlvs: [[BOARD_TLV, 'nrf5340dk']],
  });
  assert.throws(
    () => validate(both),
    (error) => error instanceof ImageError && error.code === 'unexpected_tlv'
  );

  // In the program itself, bytes that look like the TLV are only bytes of the program.
  const entry = Buffer.concat([Buffer.from([BOARD_TLV, 0, 9, 0]), Buffer.from('nrf5340dk')]);
  const inPayload = buildImage({
    version: '1.13.0+0',
    key,
    payload: Buffer.concat([entry, Buffer.alloc(64, 0xa5), entry]),
  });
  assert.equal(boardOf(inPayload), 'nrf7002dk');
});

test('a board TLV that is not one short known word, or is given twice, is refused', () => {
  const refuses = (protectedTlvs, code) =>
    assert.throws(
      () => boardOf(buildImage({ version: '1.13.0+0', key, protectedTlvs })),
      (error) => error instanceof BoardTlvError && error.code === code,
      code
    );
  refuses([[BOARD_TLV, 'nrf9160dk']], 'unknown_board');
  refuses([[BOARD_TLV, 'NRF5340DK']], 'invalid_board_tlv');
  refuses([[BOARD_TLV, '']], 'invalid_board_tlv');
  refuses([[BOARD_TLV, Buffer.from([0xff, 0xfe])]], 'invalid_board_tlv');
  refuses(
    [
      [BOARD_TLV, 'nrf5340dk'],
      [BOARD_TLV, 'nrf5340dk'],
    ],
    'invalid_board_tlv'
  );
});

test('a release records its board type; a release from before types is a nrf7002dk one', async () => {
  const world = fleetConsole();
  const bt = await world.release('1.13.0+0', 'nrf5340dk');
  assert.equal(bt.board, 'nrf5340dk');
  assert.equal(world.entries('firmware.upload').at(-1).detail.board, 'nrf5340dk');
  const wifi = await world.release('1.13.1+0');
  assert.equal(wifi.board, 'nrf7002dk');
  const listed = (await world.call('GET', '/api/firmware')).body.releases;
  assert.deepEqual(
    listed.map((release) => [release.version, release.board]),
    [
      ['1.13.1+0', 'nrf7002dk'],
      ['1.13.0+0', 'nrf5340dk'],
    ]
  );
  assert.equal(
    (await world.call('GET', `/api/firmware/${encodeURIComponent('1.13.0+0')}`)).body.release.board,
    'nrf5340dk'
  );
  assert.equal(releaseBoard({}), 'nrf7002dk');
  assert.equal(releaseBoard({ board: 'esp32' }), 'nrf7002dk');

  // Refused uploads leave nothing behind.
  for (const [protectedTlvs, code] of [
    [[[BOARD_TLV, 'nrf9160dk']], 'unknown_board'],
    [[[BOARD_TLV, '??']], 'invalid_board_tlv'],
  ]) {
    const response = await world.call('POST', '/api/firmware', {
      filename: 'zephyr.signed.bin',
      data: world.image('2.0.0+0', null, { protectedTlvs }).toString('base64'),
    });
    assert.deepEqual([response.status, response.body.error.code], [422, code]);
  }
  assert.equal(world.fake.releases.size, 2);
});

test('a board is what it says it is, else what its thing says, else a nrf7002dk', () => {
  const shadow = (diag) => ({ state: { reported: { diag } } });
  assert.equal(boardFromShadow(shadow({ board: 'nrf5340dk' })), 'nrf5340dk');
  assert.equal(boardFromShadow(shadow({ board: 'nrf9160dk' })), null);
  assert.equal(boardFromShadow(null), null);
  assert.equal(boardFromAttributes({ board: 'nrf5340dk' }), 'nrf5340dk');
  assert.equal(boardFromAttributes({ board: 'other' }), null);
  assert.deepEqual(resolveBoard({ shadow: shadow({ board: 'nrf7002dk' }), attributes: { board: 'nrf5340dk' } }), {
    type: 'nrf7002dk',
    from: 'board',
    said: 'nrf7002dk',
    registered: 'nrf5340dk',
  });
  assert.equal(resolveBoard({ attributes: { board: 'nrf5340dk' } }).from, 'thing');
  assert.deepEqual(resolveBoard({}), { type: 'nrf7002dk', from: 'default', said: null, registered: null });
});

test("the fleet says each board's type and where it is known from; the thing is read at most once a minute", async () => {
  const world = fleetConsole();
  world.online(A, '1.13.0+0', { board: 'nrf7002dk', layout: 1 });
  world.online(B, '1.12.0+0');
  world.fake.addThing(C, { attributes: { board: 'nrf5340dk' } });
  const fleet = async () =>
    Object.fromEntries((await world.call('GET', '/api/fleet')).body.boards.map((board) => [board.thing, board]));
  const first = await fleet();
  assert.deepEqual([first[A].type, first[A].typeFrom, first[A].bluetoothOnly], ['nrf7002dk', 'board', false]);
  assert.deepEqual([first[B].type, first[B].typeFrom], ['nrf7002dk', 'default']);
  assert.deepEqual(
    [first[C].type, first[C].typeFrom, first[C].bluetoothOnly, first[C].version],
    ['nrf5340dk', 'thing', true, null]
  );
  // A board that says what it is and how its flash is laid out is not looked up; the others once a minute.
  const described = () =>
    world.fake.calls.filter((call) => call.method === 'describeThing').map((call) => call.args[0]);
  assert.deepEqual(described().sort(), [B, C]);
  world.advance(30_000);
  await fleet();
  assert.equal(described().length, 2);
  world.advance(31_000);
  world.fake.device(B).report(report('1.12.0+0'));
  await fleet();
  assert.equal(described().length, 4);

  // From 1.13.0 the board's word wins over its thing's.
  world.fake.device(C).report(report('1.13.0+0', { board: 'nrf7002dk' }));
  world.advance(10_000);
  const said = await fleet();
  assert.deepEqual([said[C].type, said[C].typeFrom, said[C].bluetoothOnly], ['nrf7002dk', 'board', false]);
});
