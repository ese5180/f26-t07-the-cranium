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
  unknownType,
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
  assert.equal(boardOf(buildImage({ version: '1.13.0+0', key, board: 'nrf7002dk' })), 'nrf7002dk');
  assert.equal(
    boardOf(buildImage({ version: '1.13.0+0', key, board: 'nrf7002dk', protectedTlvs: [[TLV_SEC_CNT, counter]] })),
    'nrf7002dk'
  );
  // A build that writes the value as a C string is read the same.
  assert.equal(
    boardOf(buildImage({ version: '1.13.0+0', key, protectedTlvs: [[BOARD_TLV, Buffer.from('nrf7002dk\0')]] })),
    'nrf7002dk'
  );

  // Changed after signing, the protected area no longer matches the signed hash.
  const image = buildImage({ version: '1.13.0+0', key, board: 'nrf7002dk' });
  const at = image.indexOf(Buffer.from('nrf7002dk'));
  Buffer.from('unknownbd').copy(image, at);
  assert.throws(
    () => validate(image),
    (error) => error instanceof ImageError && error.code === 'hash_mismatch'
  );
});

test('a board TLV outside the protected area is never read as the board type', () => {
  // After the signature, where anyone can add it to a signed image without breaking the
  // signature: such an image is refused outright, and so is a type in both places.
  const forged = buildImage({ version: '1.13.0+0', key, unprotectedTlvs: [[BOARD_TLV, 'nrf7002dk']] });
  assert.throws(
    () => validate(forged),
    (error) => error instanceof ImageError && error.code === 'unexpected_tlv'
  );
  const both = buildImage({
    version: '1.13.0+0',
    key,
    board: 'nrf7002dk',
    unprotectedTlvs: [[BOARD_TLV, 'otherboard']],
  });
  assert.throws(
    () => validate(both),
    (error) => error instanceof ImageError && error.code === 'unexpected_tlv'
  );

  // In the program itself, bytes that look like the TLV are only bytes of the program.
  const entry = Buffer.concat([Buffer.from([BOARD_TLV, 0, 10, 0]), Buffer.from('otherboard')]);
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
  // The nRF5340 DK is not a type this console knows.
  refuses([[BOARD_TLV, 'nrf5340dk']], 'unknown_board');
  refuses([[BOARD_TLV, 'NRF7002DK']], 'invalid_board_tlv');
  refuses([[BOARD_TLV, '']], 'invalid_board_tlv');
  refuses([[BOARD_TLV, Buffer.from([0xff, 0xfe])]], 'invalid_board_tlv');
  refuses(
    [
      [BOARD_TLV, 'nrf7002dk'],
      [BOARD_TLV, 'nrf7002dk'],
    ],
    'invalid_board_tlv'
  );
});

test('a release records its board type; a release from before types is a nrf7002dk one', async () => {
  const world = fleetConsole();
  const typed = await world.release('1.13.0+0', 'nrf7002dk');
  assert.equal(typed.board, 'nrf7002dk');
  assert.equal(world.entries('firmware.upload').at(-1).detail.board, 'nrf7002dk');
  const untyped = await world.release('1.13.1+0');
  assert.equal(untyped.board, 'nrf7002dk');
  const listed = (await world.call('GET', '/api/firmware')).body.releases;
  assert.deepEqual(
    listed.map((release) => [release.version, release.board]),
    [
      ['1.13.1+0', 'nrf7002dk'],
      ['1.13.0+0', 'nrf7002dk'],
    ]
  );
  assert.equal(
    (await world.call('GET', `/api/firmware/${encodeURIComponent('1.13.0+0')}`)).body.release.board,
    'nrf7002dk'
  );
  assert.equal(releaseBoard({}), 'nrf7002dk');
  // A stored type this console does not know keeps its word, so that no board takes it for its own.
  assert.equal(releaseBoard({ board: 'esp32' }), 'esp32');
  assert.equal(releaseBoard({ board: 'nrf5340dk' }), 'nrf5340dk');
  // What is not a type word at all is from before types, or nothing the console wrote.
  for (const board of [null, 42, '', 'NRF7002DK', 'a'.repeat(17)]) assert.equal(releaseBoard({ board }), 'nrf7002dk');
  assert.equal(unknownType('nrf5340dk'), 'nrf5340dk');
  assert.equal(unknownType('nrf7002dk'), null);
  assert.equal(unknownType('nRF5340'), null);

  // Refused uploads leave nothing behind.
  for (const [protectedTlvs, code] of [
    [[[BOARD_TLV, 'nrf9160dk']], 'unknown_board'],
    // An image built for the nRF5340 DK: a type this console does not know.
    [[[BOARD_TLV, 'nrf5340dk']], 'unknown_board'],
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
  assert.equal(boardFromShadow(shadow({ board: 'nrf7002dk' })), 'nrf7002dk');
  assert.equal(boardFromShadow(shadow({ board: 'nrf9160dk' })), null);
  assert.equal(boardFromShadow(shadow({ board: 'nrf5340dk' })), null);
  assert.equal(boardFromShadow(null), null);
  assert.equal(boardFromAttributes({ board: 'nrf7002dk' }), 'nrf7002dk');
  assert.equal(boardFromAttributes({ board: 'other' }), null);
  assert.equal(boardFromAttributes({ board: 'nrf5340dk' }), null);
  assert.deepEqual(resolveBoard({ shadow: shadow({ board: 'nrf7002dk' }), attributes: { board: 'nrf7002dk' } }), {
    type: 'nrf7002dk',
    from: 'board',
    said: 'nrf7002dk',
    registered: 'nrf7002dk',
  });
  assert.equal(resolveBoard({ attributes: { board: 'nrf7002dk' } }).from, 'thing');
  // A type this console does not know, from the board or its thing, is kept: it matches no release.
  assert.deepEqual(resolveBoard({ attributes: { board: 'nrf5340dk' } }), {
    type: 'nrf5340dk',
    from: 'thing',
    said: null,
    registered: null,
  });
  assert.deepEqual(
    resolveBoard({ shadow: shadow({ board: 'nrf5340dk' }), attributes: { board: 'nrf7002dk' } }).type,
    'nrf7002dk'
  );
  assert.equal(resolveBoard({ shadow: shadow({ board: 'nrf5340dk' }) }).from, 'board');
  assert.deepEqual(resolveBoard({ attributes: { board: 'Not A Type' } }).type, 'nrf7002dk');
  assert.deepEqual(resolveBoard({}), { type: 'nrf7002dk', from: 'default', said: null, registered: null });
});

test("the fleet says each board's type and where it is known from; the thing is read at most once a minute", async () => {
  const world = fleetConsole();
  world.online(A, '1.13.0+0', { board: 'nrf7002dk', layout: 1 });
  world.online(B, '1.12.0+0');
  world.fake.addThing(C, { attributes: { board: 'nrf7002dk' } });
  const fleet = async () =>
    Object.fromEntries((await world.call('GET', '/api/fleet')).body.boards.map((board) => [board.thing, board]));
  const first = await fleet();
  assert.deepEqual([first[A].type, first[A].typeFrom], ['nrf7002dk', 'board']);
  assert.deepEqual([first[B].type, first[B].typeFrom], ['nrf7002dk', 'default']);
  assert.deepEqual([first[C].type, first[C].typeFrom, first[C].version], ['nrf7002dk', 'thing', null]);
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
  assert.deepEqual([said[C].type, said[C].typeFrom], ['nrf7002dk', 'board']);
});

test('a stored release or thing of a type this console does not know is offered to no nRF7002 DK', async () => {
  const world = fleetConsole();
  world.online(A, '1.0.0+0', { board: 'nrf7002dk', layout: 1 });
  // A thing registered when its type was still known (docs/versions.md, "On ice").
  world.fake.addThing(C, { attributes: { board: 'nrf5340dk' } });
  await world.release('1.13.0+0', 'nrf7002dk');
  // A release recorded then: an upload naming the type is refused now (unknown_board, above).
  await world.release('1.13.1+0', 'nrf7002dk');
  const stored = [...world.fake.releases.values()].find((item) => item.version === '1.13.1+0');
  stored.board = 'nrf5340dk';

  const old = (await world.call('GET', `/api/firmware/${encodeURIComponent('1.13.1+0')}`)).body.release;
  assert.equal(old.board, 'nrf5340dk');
  const deploy = await world.call('POST', '/api/deployments', { version: '1.13.1+0', things: [A] });
  assert.deepEqual([deploy.status, deploy.body.error.code], [400, 'incompatible_board']);
  const send = await world.call('POST', `/api/firmware/${encodeURIComponent('1.13.1+0')}/bluetooth`, {
    sha256: old.sha256,
    thing: A,
  });
  assert.deepEqual([send.status, send.body.error.code], [400, 'incompatible_board']);

  const fleet = (await world.call('GET', '/api/fleet')).body;
  const board = fleet.boards.find((item) => item.thing === C);
  assert.deepEqual([board.type, board.typeFrom], ['nrf5340dk', 'thing']);
  const toC = await world.call('POST', '/api/deployments', { version: '1.13.0+0', things: [C] });
  assert.deepEqual([toC.status, toC.body.error.code], [400, 'incompatible_board']);
  // Nothing went out.
  assert.equal(world.fake.jobs.size, 0);
});
