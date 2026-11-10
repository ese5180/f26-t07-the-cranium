/**
 * The Database page (docs/database.md): the console's three DynamoDB tables, read by release managers.
 * What this module decides, with no AWS in it:
 *
 *   - the tables and the kinds of item each holds (TABLES), and how a set of filters becomes a Query on a
 *     known key or a Scan of one page (planOf);
 *   - what is never shown, to anybody (hideSecrets, secretKey): token digests, keys, passphrases,
 *     passkeys, certificates and anything else credential-like is "hidden";
 *   - a page cursor (encodeCursor, decodeCursor), and the CSV and JSON of an export (toCsv, toJson).
 *
 * The keys of all three tables are pk (partition) and sk (sort), both text.
 */

import { badRequest } from '../http.mjs';
import { isThing, requireTime } from './validate.mjs';

export const HIDDEN = 'hidden';

// What each table holds, and how an item's kind is found: by its partition (`pk`), by the start of its
// sort key within a board's partition (`prefix`), or by the start of its partition (`pkPrefix`).
// `timed` kinds carry their time in the sort key, after the prefix, so a time range is a key range.
export const TABLES = Object.freeze({
  state: Object.freeze({
    label: 'State',
    about: 'Releases, API tokens, groups, staged rollouts, the phone apps, SideStore links and customers’ boards.',
    kinds: Object.freeze([
      { id: 'REL', label: 'Firmware releases', pk: 'REL' },
      { id: 'META', label: 'Pointers', pk: 'META' },
      { id: 'TOK', label: 'API tokens', pk: 'TOK' },
      { id: 'GRP', label: 'Groups', pk: 'GRP' },
      { id: 'ROL', label: 'Staged rollouts', pk: 'ROL' },
      { id: 'SCH', label: 'Scheduled starts', pk: 'SCH' },
      { id: 'SEEN', label: 'Seen over Bluetooth', pk: 'SEEN' },
      { id: 'HEALTH', label: 'Fleet health snapshots', pk: 'HEALTH' },
      { id: 'APP', label: 'Phone app releases', pk: 'APP' },
      { id: 'SRC', label: 'SideStore links', pk: 'SRC' },
      { id: 'OWN', label: 'Customers’ boards', pk: 'OWN' },
    ]),
  }),
  audit: Object.freeze({
    label: 'Audit',
    about: 'The activity log: one entry for each change, sign-in and recorded read.',
    kinds: Object.freeze([{ id: 'AUD', label: 'Entries', pk: 'AUD', timed: true, prefix: '' }]),
  }),
  events: Object.freeze({
    label: 'Events',
    about: 'What the boards did: events, readings, log lines, the update history, positions and alerts.',
    kinds: Object.freeze([
      { id: 'event', label: 'Events', prefix: 'E#', timed: true, board: true },
      { id: 'sample', label: 'Readings', prefix: 'S#', timed: true, board: true },
      { id: 'line', label: 'Log lines', prefix: 'L#', timed: true, board: true },
      { id: 'claim', label: 'Log line claims', prefix: 'K#', board: true },
      { id: 'update', label: 'Update history', pkPrefix: 'UPD#', board: true },
      { id: 'LOC', label: 'Positions', pk: 'LOC' },
      { id: 'ALERTS', label: 'Alerts', pk: 'ALERTS' },
    ]),
  }),
});
export const TABLE_NAMES = Object.freeze(Object.keys(TABLES));

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 100;
export const MAX_TEXT = 100;
export const MAX_KEY = 1024;
// An export: at most this many items, this much text, and this many reads of DynamoDB.
export const EXPORT_MAX_ITEMS = 10_000;
export const EXPORT_MAX_CHARS = 4_000_000;
export const EXPORT_MAX_READS = 60;
export const EXPORT_FORMATS = Object.freeze(['csv', 'json']);

const CONTROL = /[\p{C}\p{Zl}\p{Zp}]/u;
const CURSOR = /^[A-Za-z0-9_-]{1,1600}$/;

// Field names that hold a credential, or something as good as one: the denylist. A name is compared
// without case and without anything but letters and digits, anywhere in an item, at any depth. A field
// is hidden when its name is one of SECRET_NAMES, contains one of SECRET_PARTS, or ends in one of
// SECRET_ENDINGS (apiKey, projectKey, sourcePin). test/db.test.mjs goes through them.
export const SECRET_NAMES = Object.freeze(['pin', 'psk', 'key', 'ref', 'pem', 'csr', 'cert', 'sig', 'otp', 'mfa']);
export const SECRET_PARTS = Object.freeze([
  'hash',
  'digest',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'passkey',
  'token',
  'credential',
  'certificate',
  'private',
  'signature',
  'session',
]);
export const SECRET_ENDINGS = Object.freeze(['key', 'pin', 'pem', 'cert', 'csr', 'ref']);
// The keys of an item, which are shown (secretKey decides about them), and an id, which is no secret.
const SAFE_NAMES = Object.freeze(new Set(['pk', 'sk', 'id', 'tokenid', 'keyid']));
// Values that are a credential whatever their field is called.
const SECRET_VALUE =
  /^(?:crn_|crs_)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*(?:KEY|CERTIFICATE|REQUEST)-----|^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;

/** Whether a text is a credential whatever field holds it: an API token, a key or certificate, a JWT. */
export function secretValue(text) {
  return typeof text === 'string' && SECRET_VALUE.test(text);
}

/** Whether a field's name says that it holds a credential. */
export function secretName(name) {
  const plain = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (SAFE_NAMES.has(plain)) return false;
  return (
    SECRET_NAMES.includes(plain) ||
    SECRET_PARTS.some((part) => plain.includes(part)) ||
    SECRET_ENDINGS.some((ending) => plain.endsWith(ending))
  );
}

/**
 * Whether an item's own key is a credential's digest: an API token (pk TOK, its sk the SHA-256 of the
 * token) and a SideStore link's key (pk SRC, sk key#<SHA-256>). Such a key is never sent to the browser,
 * not even in a cursor.
 */
export function secretKey(table, key) {
  if (table !== 'state' || key === null || typeof key !== 'object') return false;
  if (key.pk === 'TOK') return true;
  return key.pk === 'SRC' && typeof key.sk === 'string' && key.sk.startsWith('key#');
}

function hideValue(value, depth) {
  if (typeof value === 'string') return SECRET_VALUE.test(value) ? HIDDEN : value;
  if (Array.isArray(value)) return depth > 20 ? HIDDEN : value.map((one) => hideValue(one, depth + 1));
  if (value !== null && typeof value === 'object') {
    if (depth > 20) return HIDDEN;
    const out = {};
    for (const [name, inner] of Object.entries(value)) {
      out[name] = secretName(name) ? HIDDEN : hideValue(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/** An item as anybody may see it: every secret field "hidden", and a secret key's sk too. */
export function hideSecrets(table, item) {
  const shown = hideValue(item, 0);
  if (secretKey(table, item)) shown.sk = HIDDEN;
  return shown;
}

/** The key of an item for a link to it, or null where that key is secret. */
export function keyOf(table, item) {
  if (typeof item?.pk !== 'string' || typeof item?.sk !== 'string' || secretKey(table, item)) return null;
  return { pk: item.pk, sk: item.sk };
}

// Cursors: the key to go on from, as base64url JSON. Never a secret key (handlers/db.mjs reads on past one).

export function encodeCursor(key) {
  if (key === null || key === undefined) return null;
  return Buffer.from(JSON.stringify({ pk: key.pk, sk: key.sk }), 'utf8').toString('base64url');
}

export function decodeCursor(value) {
  if (value === undefined) return null;
  const refuse = () => badRequest('invalid_cursor', '"cursor" is not one this console gave.');
  if (typeof value !== 'string' || !CURSOR.test(value)) throw refuse();
  let key;
  try {
    key = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw refuse();
  }
  if (key === null || typeof key !== 'object' || Array.isArray(key) || Object.keys(key).length !== 2) throw refuse();
  if (!isKeyText(key.pk) || !isKeyText(key.sk)) throw refuse();
  return { pk: key.pk, sk: key.sk };
}

function isKeyText(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_KEY && !CONTROL.test(value);
}

// Parameters.

export function requireTable(value) {
  if (typeof value !== 'string' || !TABLE_NAMES.includes(value)) {
    throw badRequest('unknown_table', `There is no such table. The tables are ${TABLE_NAMES.join(', ')}.`);
  }
  return value;
}

function bad(message) {
  return badRequest('invalid_filter', message);
}

/** One key's text from the query string: a partition or a sort key. */
export function requireKeyText(value, name) {
  if (!isKeyText(value)) {
    throw badRequest('invalid_key', `"${name}" must be 1 to ${MAX_KEY} characters of plain text.`);
  }
  return value;
}

/** The page size: 1 to 100, 50 when absent. */
export function requireDbPage(value) {
  if (value === undefined) return DEFAULT_PAGE;
  if (typeof value !== 'string' || !/^[1-9]\d{0,2}$/.test(value) || Number(value) > MAX_PAGE) {
    throw badRequest('invalid_limit', `"limit" must be a number from 1 to ${MAX_PAGE}.`);
  }
  return Number(value);
}

export function requireFormat(value) {
  if (!EXPORT_FORMATS.includes(value)) throw badRequest('invalid_format', '"format" must be csv or json.');
  return value;
}

/**
 * The filters of a list or an export, checked: { kind, partition, board, from, to, text }, each null
 * when absent. `from` and `to` are ISO times.
 */
export function readFilters(table, query) {
  const spec = TABLES[table];
  const filters = { kind: null, partition: null, board: null, from: null, to: null, text: null };
  if (query.kind !== undefined) {
    const kind = spec.kinds.find((one) => one.id === query.kind);
    if (!kind) throw bad(`"kind" must be one of ${spec.kinds.map((one) => one.id).join(', ')}.`);
    filters.kind = kind.id;
  }
  if (query.partition !== undefined) filters.partition = requireKeyText(query.partition, 'partition');
  if (query.board !== undefined) {
    if (!isThing(query.board)) throw bad('"board" must be a board’s name, like cranium-0123456789abcdef.');
    filters.board = query.board;
  }
  if (query.from !== undefined) filters.from = new Date(requireTime(query.from, 'from')).toISOString();
  if (query.to !== undefined) filters.to = new Date(requireTime(query.to, 'to')).toISOString();
  if (filters.from !== null && filters.to !== null && !(filters.from < filters.to)) {
    throw bad('"from" must be before "to".');
  }
  if (query.text !== undefined) {
    const text = typeof query.text === 'string' ? query.text.trim() : '';
    if (text === '' || text.length > MAX_TEXT || CONTROL.test(text)) {
      throw bad(`"text" must be 1 to ${MAX_TEXT} characters on one line.`);
    }
    filters.text = text;
  }
  return filters;
}

// The plan: a Query of one partition where a filter names one, a Scan of a page otherwise.

// The partitions whose sort key is a board's name: what a phone saw of it and its customer (state),
// its position (events).
const BOARD_KEYED = Object.freeze(['SEEN', 'OWN', 'LOC']);
// Below any ISO time; DynamoDB takes no empty text in a key condition.
const LOW = '0000';
const HIGH = '￿';

function range(prefix, filters) {
  return [`${prefix}${filters.from ?? LOW}`, `${prefix}${filters.to === null ? HIGH : `${filters.to}${HIGH}`}`];
}

/**
 * How to read a page for these filters:
 *   { op: 'query', pk, sk: null | { between: [low, high] } | { begins: prefix } | { equals: sk }, newestFirst, where }
 *   { op: 'scan', where }
 * `where` is a list of conditions on the items, all of which must hold (the adapter makes the
 * FilterExpression): { any: [...] } | { equals: [name, value] } | { contains: [name, value] }
 * | { begins: [name, value] } | { between: [name, low, high] }. A Query's conditions never name pk or sk.
 */
export function planOf(table, filters) {
  const spec = TABLES[table];
  const kind = filters.kind === null ? null : spec.kinds.find((one) => one.id === filters.kind);
  const timed = filters.from !== null || filters.to !== null;
  const where = [];
  // A time in a field of its own, where the key has none: what most items carry.
  const timeFields = () =>
    timed
      ? [
          {
            any: ['at', 'createdAt', 'updatedAt'].map((name) => ({
              between: [name, filters.from ?? '0000', filters.to === null ? HIGH : `${filters.to}${HIGH}`],
            })),
          },
        ]
      : [];

  if (table === 'audit') {
    if (filters.board !== null) where.push({ contains: ['target', filters.board] });
    return {
      op: 'query',
      pk: filters.partition ?? 'AUD',
      sk: timed ? { between: range('', filters) } : null,
      newestFirst: true,
      where,
    };
  }

  if (table === 'state') {
    const pk = filters.partition ?? kind?.pk ?? null;
    where.push(...timeFields());
    if (pk === null) {
      if (filters.board !== null) {
        where.push({
          any: [
            { equals: ['thing', filters.board] },
            { contains: ['things', filters.board] },
            { contains: ['sk', filters.board] },
          ],
        });
      }
      return { op: 'scan', where };
    }
    // A board's own item, where the sort key is the board's name (what a phone saw of it, its customer).
    if (filters.board !== null && BOARD_KEYED.includes(pk)) {
      return { op: 'query', pk, sk: { equals: filters.board }, newestFirst: true, where };
    }
    if (filters.board !== null) {
      where.push({ any: [{ equals: ['thing', filters.board] }, { contains: ['things', filters.board] }] });
    }
    return { op: 'query', pk, sk: null, newestFirst: true, where };
  }

  // The events table.
  if (kind?.pk !== undefined || filters.partition !== null) {
    const pk = filters.partition ?? kind.pk;
    if (kind?.prefix !== undefined) {
      if (kind.timed && timed)
        return { op: 'query', pk, sk: { between: range(kind.prefix, filters) }, newestFirst: true, where };
      where.push(...timeFields());
      return { op: 'query', pk, sk: { begins: kind.prefix }, newestFirst: true, where };
    }
    where.push(...timeFields());
    if (filters.board !== null && BOARD_KEYED.includes(pk)) {
      return { op: 'query', pk, sk: { equals: filters.board }, newestFirst: true, where };
    }
    if (filters.board !== null) where.push({ equals: ['thing', filters.board] });
    return { op: 'query', pk, sk: null, newestFirst: true, where };
  }
  if (filters.board !== null) {
    if (kind?.pkPrefix !== undefined) {
      where.push(...timeFields());
      return { op: 'query', pk: `${kind.pkPrefix}${filters.board}`, sk: null, newestFirst: true, where };
    }
    if (kind !== null) {
      if (kind.timed && timed) {
        return {
          op: 'query',
          pk: filters.board,
          sk: { between: range(kind.prefix, filters) },
          newestFirst: true,
          where,
        };
      }
      where.push(...timeFields());
      return { op: 'query', pk: filters.board, sk: { begins: kind.prefix }, newestFirst: true, where };
    }
    if (timed) {
      throw bad('For a time range of one board, choose a kind of item too: events, readings or log lines.');
    }
    return { op: 'query', pk: filters.board, sk: null, newestFirst: true, where };
  }
  // No partition: a Scan of one page, its filter on the key where the kind is in the key.
  if (kind?.pkPrefix !== undefined) where.push({ begins: ['pk', kind.pkPrefix] });
  else if (kind !== null && kind.timed && timed) where.push({ between: ['sk', ...range(kind.prefix, filters)] });
  else if (kind !== null) where.push({ begins: ['sk', kind.prefix] });
  if (timed && (kind === null || !kind.timed)) {
    const kinds = spec.kinds.filter((one) => one.timed && (kind === null || one === kind));
    where.push({
      any: [
        ...kinds.map((one) => ({ between: ['sk', ...range(one.prefix, filters)] })),
        ...timeFields().flatMap((one) => one.any),
      ],
    });
  }
  return { op: 'scan', where };
}

/** Whether an item, as it is shown, has the text in it: in any field's name or value, any case. */
export function matchesText(shown, text) {
  if (text === null) return true;
  return JSON.stringify(shown).toLowerCase().includes(text.toLowerCase());
}

/** A short account of the filters, for the activity log: never more than 200 characters. */
export function describeFilters(filters) {
  return Object.entries(filters)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ')
    .slice(0, 200);
}

// Exports.

function cell(value) {
  if (value === undefined) return '';
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  // A spreadsheet would run a cell that starts like a formula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV of items as they are shown: pk and sk first, then every other top-level field, by name. */
export function toCsv(items) {
  const names = new Set();
  for (const item of items) for (const name of Object.keys(item)) names.add(name);
  names.delete('pk');
  names.delete('sk');
  const columns = ['pk', 'sk', ...[...names].sort()];
  const lines = [columns.map(cell).join(',')];
  for (const item of items) lines.push(columns.map((name) => cell(item[name])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** JSON of items as they are shown: an array, one item to a line. */
export function toJson(items) {
  return items.length === 0 ? '[]\n' : `[\n${items.map((item) => JSON.stringify(item)).join(',\n')}\n]\n`;
}
