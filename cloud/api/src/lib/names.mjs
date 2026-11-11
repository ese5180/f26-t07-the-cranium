/**
 * Board names given in the console (docs/fleet.md, Board names): what a release manager calls a board, such as
 * "Demo deck 1". It leads wherever the console shows the board, before the board's own name (the device ID it
 * reports, lib/shadow.mjs) and its thing name, which stays its identity.
 *
 * Where they live. In the state table, one item per board: pk NAME, sk the thing name, { thing, label, at, by }.
 * The API role already reads and writes that table, so it needs nothing new: no shadow update (the board would be
 * sent a desired state it does not know) and no thing attribute (that would take iot:UpdateThing). The role may not
 * delete there, so taking a name away stores `label: null`.
 *
 * The customer site's name for a board is the customer's own (customer_action.rename) and is kept apart: one does
 * not change the other.
 */

import { badRequest } from '../http.mjs';

export const NAMES_PK = 'NAME';
export const MAX_BOARD_LABEL = 40;

// Control and format characters, unassigned ones and line or paragraph breaks: a name is one printable line.
const UNPRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/u;

/** A name as given: trimmed, 1 to 40 printable characters, or null (none, or "") to take it away. */
export function requireBoardLabel(value) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw badRequest('invalid_label', 'A board\'s name is text: give "label" as a string, or null to take it away.');
  }
  const label = value.trim();
  if (label === '') return null;
  if ([...label].length > MAX_BOARD_LABEL || UNPRINTABLE.test(label)) {
    throw badRequest('invalid_label', `A board's name is one line of 1 to ${MAX_BOARD_LABEL} printable characters.`);
  }
  return label;
}

/** The name in a stored item, or null for none or for anything that is not a valid name. */
export function labelFromItem(item) {
  const label = item?.label;
  if (typeof label !== 'string') return null;
  try {
    return requireBoardLabel(label) === label ? label : null;
  } catch {
    return null;
  }
}
