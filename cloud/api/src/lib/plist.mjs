/**
 * Property lists, as far as the console reads one: the Info.plist inside an iPhone app's IPA
 * (lib/ipa.mjs). Xcode writes it in the binary format ("bplist00") for a device build; a plist
 * written by hand or by another tool may be XML. Both are read here into plain values:
 *
 *   dict -> object (with no prototype), array -> array, string -> string, integer -> number (or
 *   BigInt past 2^53), real -> number, true/false -> boolean, date -> Date, data -> Buffer,
 *   uid (binary only) -> { uid: number }
 *
 * A plist comes from a file a release manager uploaded, so the reader expects the worst of it: it
 * is bounded in size, in the number of objects and in depth, refuses a binary object that refers
 * to itself (directly or through others), and throws a PlistError for anything it cannot read.
 */

const MAX_BYTES = 1024 * 1024;
const MAX_OBJECTS = 100_000;
const MAX_DEPTH = 32;
const BINARY_MAGIC = 'bplist00';
// Seconds from 1970-01-01 to 2001-01-01, the epoch of a binary plist's dates.
const APPLE_EPOCH_S = 978_307_200;

export class PlistError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlistError';
  }
}

function broken(message) {
  throw new PlistError(message);
}

/** A plist, binary or XML, as plain values. */
export function parsePlist(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buffer.length === 0) broken('empty');
  if (buffer.length > MAX_BYTES) broken('too large');
  if (buffer.subarray(0, 8).toString('latin1') === BINARY_MAGIC) return parseBinary(buffer);
  return parseXml(buffer.toString('utf8'));
}

// --- Binary ---------------------------------------------------------------------------------------

function readUInt(buffer, offset, size) {
  if (offset < 0 || offset + size > buffer.length) broken('out of bounds');
  let value = 0n;
  for (let index = 0; index < size; index += 1) value = (value << 8n) | BigInt(buffer[offset + index]);
  return value;
}

function asNumber(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) broken('number out of range');
  return Number(value);
}

function parseBinary(buffer) {
  if (buffer.length < 8 + 32) broken('truncated');
  const trailer = buffer.length - 32;
  const offsetSize = buffer[trailer + 6];
  const refSize = buffer[trailer + 7];
  const count = asNumber(readUInt(buffer, trailer + 8, 8));
  const top = asNumber(readUInt(buffer, trailer + 16, 8));
  const tableAt = asNumber(readUInt(buffer, trailer + 24, 8));
  if (![1, 2, 4, 8].includes(offsetSize) || ![1, 2, 4, 8].includes(refSize)) broken('bad trailer');
  if (count < 1 || count > MAX_OBJECTS || top >= count) broken('bad object count');
  if (tableAt < 8 || tableAt + count * offsetSize > trailer) broken('bad offset table');

  const offsets = [];
  for (let index = 0; index < count; index += 1) {
    const offset = asNumber(readUInt(buffer, tableAt + index * offsetSize, offsetSize));
    if (offset < 8 || offset >= tableAt) broken('bad object offset');
    offsets.push(offset);
  }

  const ref = (at) => {
    const value = asNumber(readUInt(buffer, at, refSize));
    if (value >= count) broken('bad reference');
    return value;
  };

  /** The length of a data, string, array, set or dict object, and where its contents start. */
  const lengthOf = (at, nibble) => {
    if (nibble !== 0x0f) return { length: nibble, start: at + 1 };
    const marker = buffer[at + 1];
    if (marker === undefined || marker >> 4 !== 0x1) broken('bad length');
    const size = 1 << (marker & 0x0f);
    if (size > 8) broken('bad length');
    return { length: asNumber(readUInt(buffer, at + 2, size)), start: at + 2 + size };
  };

  const within = (start, bytes) => {
    if (start + bytes > tableAt) broken('object past its end');
  };

  const visiting = new Set();
  // Objects may be shared, so a small file could stand for a great many values: count them all.
  let values = 0;

  const object = (index, depth) => {
    if (depth > MAX_DEPTH) broken('too deep');
    if (visiting.has(index)) broken('an object refers to itself');
    values += 1;
    if (values > MAX_OBJECTS) broken('too many objects');
    const at = offsets[index];
    const marker = buffer[at];
    const type = marker >> 4;
    const nibble = marker & 0x0f;
    switch (type) {
      case 0x0:
        if (marker === 0x00) return null;
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        return broken('unknown marker');
      case 0x1: {
        const size = 1 << nibble;
        if (size > 8) broken('integer too wide');
        within(at + 1, size);
        let value = readUInt(buffer, at + 1, size);
        // An 8-byte integer is signed; shorter ones are not.
        if (size === 8 && value >= 1n << 63n) value -= 1n << 64n;
        return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(value)
          : value;
      }
      case 0x2: {
        const size = 1 << nibble;
        within(at + 1, size);
        if (size === 4) return buffer.readFloatBE(at + 1);
        if (size === 8) return buffer.readDoubleBE(at + 1);
        return broken('bad real');
      }
      case 0x3:
        if (marker !== 0x33) broken('bad date');
        within(at + 1, 8);
        return new Date((buffer.readDoubleBE(at + 1) + APPLE_EPOCH_S) * 1000);
      case 0x4: {
        const { length, start } = lengthOf(at, nibble);
        within(start, length);
        return Buffer.from(buffer.subarray(start, start + length));
      }
      case 0x5: {
        const { length, start } = lengthOf(at, nibble);
        within(start, length);
        return buffer.subarray(start, start + length).toString('latin1');
      }
      case 0x6: {
        const { length, start } = lengthOf(at, nibble);
        within(start, length * 2);
        const units = Buffer.from(buffer.subarray(start, start + length * 2));
        units.swap16();
        return units.toString('utf16le');
      }
      case 0x8: {
        within(at + 1, nibble + 1);
        return { uid: asNumber(readUInt(buffer, at + 1, nibble + 1)) };
      }
      case 0xa:
      case 0xc: {
        const { length, start } = lengthOf(at, nibble);
        within(start, length * refSize);
        visiting.add(index);
        const items = [];
        for (let item = 0; item < length; item += 1) items.push(object(ref(start + item * refSize), depth + 1));
        visiting.delete(index);
        return items;
      }
      case 0xd: {
        const { length, start } = lengthOf(at, nibble);
        within(start, length * 2 * refSize);
        visiting.add(index);
        const dict = Object.create(null);
        for (let item = 0; item < length; item += 1) {
          const key = object(ref(start + item * refSize), depth + 1);
          if (typeof key !== 'string') broken('a dict key is not a string');
          dict[key] = object(ref(start + (length + item) * refSize), depth + 1);
        }
        visiting.delete(index);
        return dict;
      }
      default:
        return broken('unknown marker');
    }
  };

  return object(top, 0);
}

// --- XML ------------------------------------------------------------------------------------------

const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });

function unescape(text) {
  return text.replace(/&([^&;\s]{1,10});|&/g, (whole, name) => {
    if (name === undefined) broken('a bare & in the text');
    if (/^#x[0-9a-fA-F]{1,6}$|^#\d{1,7}$/.test(name)) {
      const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      if (!(code >= 0 && code <= 0x10ffff)) broken('bad character reference');
      return String.fromCodePoint(code);
    }
    if (!Object.hasOwn(ENTITIES, name)) broken('unknown entity');
    return ENTITIES[name];
  });
}

function parseXml(source) {
  let at = 0;
  let objects = 0;

  const skipSpace = () => {
    while (at < source.length && /\s/.test(source[at])) at += 1;
  };

  /** Skip the prolog, comments and the doctype before the next element. */
  const skipMisc = () => {
    for (;;) {
      skipSpace();
      if (source.startsWith('<?', at)) {
        const end = source.indexOf('?>', at);
        if (end === -1) broken('unclosed declaration');
        at = end + 2;
      } else if (source.startsWith('<!--', at)) {
        const end = source.indexOf('-->', at);
        if (end === -1) broken('unclosed comment');
        at = end + 3;
      } else if (source.startsWith('<!DOCTYPE', at)) {
        const end = source.indexOf('>', at);
        if (end === -1) broken('unclosed doctype');
        at = end + 1;
      } else {
        return;
      }
    }
  };

  /** The next tag: { name, closing, empty }. */
  const tag = () => {
    skipMisc();
    if (source[at] !== '<') broken('expected a tag');
    const end = source.indexOf('>', at);
    if (end === -1) broken('unclosed tag');
    const inside = source.slice(at + 1, end).trim();
    at = end + 1;
    const closing = inside.startsWith('/');
    const empty = inside.endsWith('/');
    const name = inside.replace(/^\//, '').replace(/\/$/, '').trim().split(/\s+/)[0];
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) broken('bad tag');
    return { name, closing, empty };
  };

  const textUntil = (name) => {
    const end = source.indexOf(`</${name}>`, at);
    if (end === -1) broken(`unclosed ${name}`);
    const raw = source.slice(at, end);
    if (raw.includes('<')) broken(`markup inside ${name}`);
    at = end + name.length + 3;
    return unescape(raw);
  };

  const value = (open, depth) => {
    if (depth > MAX_DEPTH) broken('too deep');
    objects += 1;
    if (objects > MAX_OBJECTS) broken('too many objects');
    if (open.closing) broken(`unexpected </${open.name}>`);
    switch (open.name) {
      case 'true':
      case 'false':
        if (!open.empty) {
          const next = tag();
          if (!next.closing || next.name !== open.name) broken(`bad ${open.name}`);
        }
        return open.name === 'true';
      case 'string':
        return open.empty ? '' : textUntil('string');
      case 'integer': {
        const text = open.empty ? '' : textUntil('integer').trim();
        if (!/^[+-]?\d{1,19}$/.test(text)) broken('bad integer');
        const big = BigInt(text);
        return big <= BigInt(Number.MAX_SAFE_INTEGER) && big >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(big) : big;
      }
      case 'real': {
        const number = Number((open.empty ? '' : textUntil('real')).trim());
        if (!Number.isFinite(number)) broken('bad real');
        return number;
      }
      case 'date': {
        const time = Date.parse(open.empty ? '' : textUntil('date').trim());
        if (!Number.isFinite(time)) broken('bad date');
        return new Date(time);
      }
      case 'data':
        return Buffer.from((open.empty ? '' : textUntil('data')).replace(/\s+/g, ''), 'base64');
      case 'array': {
        const items = [];
        if (open.empty) return items;
        for (;;) {
          const next = tag();
          if (next.closing && next.name === 'array') return items;
          items.push(value(next, depth + 1));
        }
      }
      case 'dict': {
        const dict = Object.create(null);
        if (open.empty) return dict;
        for (;;) {
          const next = tag();
          if (next.closing && next.name === 'dict') return dict;
          if (next.name !== 'key' || next.closing) broken('a dict holds a key before each value');
          const key = next.empty ? '' : textUntil('key');
          dict[key] = value(tag(), depth + 1);
        }
      }
      default:
        return broken(`unknown element ${open.name}`);
    }
  };

  const root = tag();
  if (root.name !== 'plist' || root.closing || root.empty) broken('not a plist');
  const result = value(tag(), 0);
  const end = tag();
  if (!end.closing || end.name !== 'plist') broken('more than one value in the plist');
  skipMisc();
  if (at !== source.length) broken('text after the plist');
  return result;
}
