/**
 * The little CBOR (RFC 8949) that MCUmgr speaks: unsigned and negative integers, byte and text strings,
 * arrays, maps with text keys, true, false and null, and floats on the way in. Zephyr's zcbor may send
 * maps and arrays of indefinite length; both are read.
 *
 * No dependencies.
 */

export class CborError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CborError';
  }
}

function head(major, value) {
  if (value < 24) return [(major << 5) | value];
  if (value < 0x100) return [(major << 5) | 24, value];
  if (value < 0x10000) return [(major << 5) | 25, value >> 8, value & 0xff];
  if (value < 0x100000000) {
    return [(major << 5) | 26, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  }
  throw new CborError('a number larger than this encoder takes');
}

/** The bytes of a value: a Uint8Array. */
export function encode(value) {
  const out = [];
  const put = (item) => {
    if (item === null || item === undefined) out.push(0xf6);
    else if (item === false) out.push(0xf4);
    else if (item === true) out.push(0xf5);
    else if (typeof item === 'number') {
      if (!Number.isInteger(item)) throw new CborError('only whole numbers are encoded');
      out.push(...(item >= 0 ? head(0, item) : head(1, -1 - item)));
    } else if (typeof item === 'string') {
      const bytes = new TextEncoder().encode(item);
      out.push(...head(3, bytes.length));
      for (const byte of bytes) out.push(byte);
    } else if (item instanceof Uint8Array) {
      out.push(...head(2, item.length));
      for (const byte of item) out.push(byte);
    } else if (Array.isArray(item)) {
      out.push(...head(4, item.length));
      item.forEach(put);
    } else if (typeof item === 'object') {
      const entries = Object.entries(item);
      out.push(...head(5, entries.length));
      for (const [key, entry] of entries) {
        put(key);
        put(entry);
      }
    } else {
      throw new CborError(`a ${typeof item} is not encoded`);
    }
  };
  put(value);
  return Uint8Array.from(out);
}

const BREAK = Symbol('break');

/** The value at the start of the bytes, and where it ends: { value, end }. */
export function decode(bytes, start = 0) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let at = start;
  const need = (count) => {
    if (at + count > b.length) throw new CborError('the bytes end inside a value');
  };
  const argument = (info) => {
    if (info < 24) return info;
    const sizes = { 24: 1, 25: 2, 26: 4, 27: 8 };
    const size = sizes[info];
    if (!size) throw new CborError('an argument this decoder does not take');
    need(size);
    let value = 0;
    for (let index = 0; index < size; index += 1) value = value * 256 + b[at + index];
    at += size;
    if (!Number.isSafeInteger(value)) throw new CborError('a number too large');
    return value;
  };
  const float = (info) => {
    const view = new DataView(b.buffer, b.byteOffset);
    if (info === 25) {
      need(2);
      const half = view.getUint16(at);
      at += 2;
      const exponent = (half >> 10) & 0x1f;
      const fraction = half & 0x3ff;
      const sign = half & 0x8000 ? -1 : 1;
      if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
      if (exponent === 31) return fraction ? NaN : sign * Infinity;
      return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
    }
    if (info === 26) {
      need(4);
      const value = view.getFloat32(at);
      at += 4;
      return value;
    }
    need(8);
    const value = view.getFloat64(at);
    at += 8;
    return value;
  };
  const item = (depth) => {
    if (depth > 16) throw new CborError('nested too deep');
    need(1);
    const first = b[at];
    at += 1;
    const major = first >> 5;
    const info = first & 0x1f;
    if (first === 0xff) return BREAK;
    const indefinite = info === 31;
    switch (major) {
      case 0:
        return argument(info);
      case 1:
        return -1 - argument(info);
      case 2:
      case 3: {
        let chunks = [];
        if (indefinite) {
          for (;;) {
            // Each chunk is a definite string of the same kind (RFC 8949, 3.2.3).
            if (at < b.length && b[at] !== 0xff && (b[at] >> 5 !== major || (b[at] & 0x1f) === 31)) {
              throw new CborError('a chunk of another kind inside a string');
            }
            const part = item(depth + 1);
            if (part === BREAK) break;
            chunks.push(major === 3 ? new TextEncoder().encode(part) : part);
          }
        } else {
          const length = argument(info);
          need(length);
          chunks = [b.slice(at, at + length)];
          at += length;
        }
        const joined = Uint8Array.from(chunks.flatMap((chunk) => [...chunk]));
        return major === 3 ? new TextDecoder('utf-8', { fatal: true }).decode(joined) : joined;
      }
      case 4: {
        const list = [];
        if (indefinite) {
          for (;;) {
            const entry = item(depth + 1);
            if (entry === BREAK) break;
            list.push(entry);
          }
        } else {
          const length = argument(info);
          for (let index = 0; index < length; index += 1) list.push(value(depth + 1));
        }
        return list;
      }
      case 5: {
        const map = {};
        const entry = () => {
          const key = item(depth + 1);
          if (key === BREAK) {
            if (!indefinite) throw new CborError('a break inside a map of known length');
            return false;
          }
          const entryValue = item(depth + 1);
          if (entryValue === BREAK) throw new CborError('a map ends between a key and its value');
          // An own property even for "__proto__", which an assignment would take as the map's prototype.
          if (typeof key === 'string' || typeof key === 'number') {
            Object.defineProperty(map, String(key), { value: entryValue, enumerable: true, writable: true, configurable: true });
          }
          return true;
        };
        if (indefinite) {
          while (entry());
        } else {
          const length = argument(info);
          for (let index = 0; index < length; index += 1) entry();
        }
        return map;
      }
      case 6:
        argument(info);
        return value(depth + 1);
      default:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        if (info >= 25 && info <= 27) return float(info);
        throw new CborError('a simple value this decoder does not take');
    }
  };
  // An item where a break may not stand: anywhere but inside something of indefinite length.
  const value = (depth) => {
    const found = item(depth);
    if (found === BREAK) throw new CborError('a break with nothing to end');
    return found;
  };
  const top = value(0);
  return { value: top, end: at };
}
