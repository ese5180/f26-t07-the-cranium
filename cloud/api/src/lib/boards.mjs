/**
 * Board types (docs/fleet.md, Board types): what an image is for, and what a board is.
 *
 *   nrf7002dk   nRF7002 DK: Wi-Fi to AWS IoT and Bluetooth LE. Updated by AWS IoT Jobs or by a phone.
 *   nrf5340dk   nRF5340 DK: Bluetooth LE only. Updated by a phone or over USB, never by a job.
 *
 * The image. A signed image carries its type in a protected TLV, tag 0xA1, as ASCII (imgtool sign
 * --custom-tlv 0xa1 nrf5340dk, which puts it in the protected area). The protected area is covered
 * by the image's hash and signature (lib/mcuboot.mjs), so the type cannot be changed without the
 * key. The same tag anywhere else is never read: in the unprotected area anyone can add it to a
 * signed image without breaking the signature, and the validator refuses an image that has it
 * there; in the payload it is just bytes of the program. An image without the TLV is a nrf7002dk
 * image, as every release up to 1.12.0 is.
 *
 * The board. From firmware 1.13.0 the diagnostics report says what the board is
 * ("diag": { "board": "nrf7002dk", ... }). A board that never reaches AWS gets its type from its
 * thing's attribute `board`, set when it is provisioned (tools/provision_device.py --board).
 * Without either it is a nrf7002dk. A board can only write its own shadow: claiming another type
 * keeps releases from itself, and nothing from any other board.
 *
 * The flash layout (docs/fleet.md, Compatibility): a second protected TLV, tag 0xA2, a positive
 * whole number in ASCII. It goes up whenever the partitions change, so that an image never lands on
 * a board whose flash is divided differently. An image without it is for layout 1, and so is a
 * board that does not say otherwise: its diagnostics ("layout") from 1.13.0, else its thing's
 * attribute `layout`. A release goes only to boards of its type and its layout.
 */

export const BOARD_TLV = 0xa1;
export const LAYOUT_TLV = 0xa2;
export const DEFAULT_LAYOUT = 1;
// Far more than a product's partitions will ever be rearranged, and still a short word.
const MAX_LAYOUT = 9999;
export const BOARD_TYPES = Object.freeze(['nrf7002dk', 'nrf5340dk']);
export const DEFAULT_BOARD = 'nrf7002dk';
// No Wi-Fi chip: such a board never connects to AWS IoT by itself, and is never the target of a job.
export const BLUETOOTH_ONLY = Object.freeze(['nrf5340dk']);
export const BOARD_LABELS = Object.freeze({ nrf7002dk: 'nRF7002 DK', nrf5340dk: 'nRF5340 DK' });

// What a value of the TLV may look like at all: 1 to 16 lower-case letters and digits.
const TYPE_WORD = /^[a-z0-9]{1,16}$/;
// A layout: a positive whole number, without a leading zero.
const LAYOUT_WORD = /^[1-9]\d{0,3}$/;

export function isBoardType(value) {
  return typeof value === 'string' && BOARD_TYPES.includes(value);
}

export function isBluetoothOnly(type) {
  return BLUETOOTH_ONLY.includes(type);
}

/** A reason an image's board TLV was refused. `code` is stable and safe to show. */
export class BoardTlvError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BoardTlvError';
    this.code = code;
  }
}

/**
 * The board type an image is for, from the entries of its protected TLV area as the validator
 * found them ([{ type, data }], lib/mcuboot.mjs). Only the protected area is passed in.
 *
 * @throws {BoardTlvError} for a TLV given twice, one that is not a short ASCII word, or a type
 *                         this console does not know
 */
export function boardOfImage(protectedTlvs) {
  const found = (protectedTlvs ?? []).filter((entry) => entry.type === BOARD_TLV);
  if (found.length === 0) return DEFAULT_BOARD;
  if (found.length > 1) {
    throw new BoardTlvError('invalid_board_tlv', 'The image names its board type more than once.');
  }
  // imgtool writes the text as it was given; a build that adds the C string's NUL is read the same.
  const text = asText(found[0].data);
  if (!TYPE_WORD.test(text)) {
    throw new BoardTlvError('invalid_board_tlv',
      'The board type in the image (TLV 0xA1) is not 1 to 16 lower-case letters and digits.');
  }
  if (!isBoardType(text)) {
    throw new BoardTlvError('unknown_board', `The image is for a board of type "${text}", which this console ` +
      `does not know. It knows ${BOARD_TYPES.join(' and ')}.`);
  }
  return text;
}

/** The bytes of a TLV's value as text, without the NUL a build may add as for a C string. */
function asText(data) {
  let bytes = Buffer.from(data);
  if (bytes.length > 0 && bytes[bytes.length - 1] === 0) bytes = bytes.subarray(0, bytes.length - 1);
  return bytes.toString('latin1');
}

/**
 * The flash layout an image is for, from the entries of its protected TLV area: 1 when it names none.
 *
 * @throws {BoardTlvError} invalid_layout_tlv for a layout given twice or one that is not a positive
 *                         whole number in ASCII
 */
export function layoutOfImage(protectedTlvs) {
  const found = (protectedTlvs ?? []).filter((entry) => entry.type === LAYOUT_TLV);
  if (found.length === 0) return DEFAULT_LAYOUT;
  if (found.length > 1) throw new BoardTlvError('invalid_layout_tlv', 'The image names its flash layout more than once.');
  const text = asText(found[0].data);
  if (!LAYOUT_WORD.test(text)) {
    throw new BoardTlvError('invalid_layout_tlv',
      'The flash layout in the image (TLV 0xA2) is not a positive whole number in ASCII.');
  }
  return Number(text);
}

export function isLayout(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_LAYOUT;
}

/** A layout as a board or a thing gives it: a whole number, or its digits as text; null otherwise. */
function layoutValue(value) {
  if (isLayout(value)) return value;
  return typeof value === 'string' && LAYOUT_WORD.test(value) ? Number(value) : null;
}

/** An own property of a plain object, or undefined. */
function own(value, key) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)
    ? value[key]
    : undefined;
}

/** The type a board reports in its diagnostics (firmware 1.13.0 on), or null. */
export function boardFromShadow(shadow) {
  const board = own(own(own(own(shadow, 'state'), 'reported'), 'diag'), 'board');
  return isBoardType(board) ? board : null;
}

/** The type in a thing's attributes, as provisioning sets it, or null. */
export function boardFromAttributes(attributes) {
  const board = own(attributes, 'board');
  return isBoardType(board) ? board : null;
}

/** The layout a board reports in its diagnostics (firmware 1.13.0 on), or null. */
export function layoutFromShadow(shadow) {
  return layoutValue(own(own(own(own(shadow, 'state'), 'reported'), 'diag'), 'layout'));
}

/** The layout in a thing's attributes, or null. */
export function layoutFromAttributes(attributes) {
  return layoutValue(own(attributes, 'layout'));
}

/** What a board's flash is divided as, and from where that is known: its own report, its thing, or the default. */
export function resolveLayout({ shadow = null, attributes = null } = {}) {
  const said = layoutFromShadow(shadow);
  if (said !== null) return { layout: said, from: 'board' };
  const registered = layoutFromAttributes(attributes);
  if (registered !== null) return { layout: registered, from: 'thing' };
  return { layout: DEFAULT_LAYOUT, from: 'default' };
}

/** The layout of a release as stored. Every release from before layouts is for layout 1. */
export function releaseLayout(item) {
  return isLayout(item?.layout) ? item.layout : DEFAULT_LAYOUT;
}

/**
 * What a board is, and from where that is known: its own report first, then its thing, then the
 * default. `said` and `registered` are both kept, so that a board whose word and whose thing
 * disagree can be pointed out.
 */
export function resolveBoard({ shadow = null, attributes = null } = {}) {
  const said = boardFromShadow(shadow);
  const registered = boardFromAttributes(attributes);
  if (said !== null) return { type: said, from: 'board', said, registered };
  if (registered !== null) return { type: registered, from: 'thing', said, registered };
  return { type: DEFAULT_BOARD, from: 'default', said, registered };
}

/** The board type of a release as stored. Every release from before types is a nrf7002dk one. */
export function releaseBoard(item) {
  return isBoardType(item?.board) ? item.board : DEFAULT_BOARD;
}
