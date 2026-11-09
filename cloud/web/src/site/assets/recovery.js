/**
 * The board's two ways of talking on its console port, for the board setup page (setup.js):
 *
 * - the application's console (firmware/app/src/console_cmd.c, tools/board.py): one command a line,
 *   COMMAND|arg1|arg2, answered by lines that end with one final line, OK ... or ERR ...;
 * - MCUboot's serial recovery (tools/recover.py): SMP requests, CBOR in a packet with a CRC, sent as
 *   lines of base64 behind two start bytes. The bootloader listens for half a second after a reset.
 *
 * Both run over one open Web Serial port: createLink below reads every line once, and hands a line of
 * SMP to the request that waits for it, and any other line to the console's reader.
 *
 * The framing is recover.py's, byte for byte (test/setup.test.mjs compares the two). No dependencies.
 */

export const BAUD_RATE = 115200;
export const SEGGER_VENDOR_ID = 0x1366;

// SMP (recover.py).
export const OP_READ = 0;
export const OP_WRITE = 2;
export const GROUP_OS = 0;
export const GROUP_IMAGE = 1;
export const ID_OS_ECHO = 0;
export const ID_OS_RESET = 5;
export const ID_IMAGE_STATE = 0;
export const ID_IMAGE_UPLOAD = 1;
// A line holds 124 base64 characters, 93 bytes, between its two start bytes and the newline.
export const LINE_BYTES = 93;
// Bytes of the image in one upload request: the bootloader buffers eight lines while it writes to flash.
export const CHUNK = 384;
export const START_FIRST = [0x06, 0x09];
export const START_MORE = [0x04, 0x14];
export const REPLY_MS = 8000;
export const GREETING_EVERY_MS = 100;
export const MAX_LOST = 3;
// How long a board gets to reach the bootloader's window, as recover.py gives it.
export const ENTER_AFTER_RESTART_MS = 15000;
export const ENTER_ALREADY_LISTENING_MS = 3000;
export const ENTER_THROUGH_A_SWAP_MS = 150000;
// To the running application. It starts with a line ending, which finishes anything half-typed.
export const ENTER_BOOTLOADER = '\rENTER_BOOTLOADER\r';

// The application's console (board.py).
export const ECHO_OFF = 'ECHO|OFF';
export const ECHO_OFF_REPLY = 'OK echo off';
export const HANDSHAKE_MS = 2000;
const FINAL_LINE = /^(OK|ERR)( |$)/;
const TAGGED_LINE = /^\[[^\]]*\]/;
const KEY_VALUE = /^([A-Za-z][A-Za-z ]+?)\s{2,}(.*)$/;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const LINE_KEPT_MAX = 4096;

export class BoardError extends Error {
  constructor(message, code = 'board') {
    super(message);
    this.name = 'BoardError';
    this.code = code;
  }
}

// Checksums.

/** CRC-16/XMODEM, SMP's: polynomial 0x1021, starting at zero. */
export function crc16Xmodem(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  return crc;
}

/** CRC-16/CCITT-FALSE, which STREAM_START announces: polynomial 0x1021, starting at 0xFFFF. */
export function crc16CcittFalse(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  return crc;
}

// Base64, of bytes.

export function toBase64(bytes) {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

// CBOR: the little that SMP needs (RFC 8949). Whole numbers, byte and text strings, arrays, maps with
// text keys, true, false and null. Maps and arrays of indefinite length are read, as zcbor may send them.

function head(major, value) {
  if (value < 24) return [(major << 5) | value];
  if (value < 0x100) return [(major << 5) | 24, value];
  if (value < 0x10000) return [(major << 5) | 25, value >> 8, value & 0xff];
  if (value < 0x100000000)
    return [(major << 5) | 26, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  throw new BoardError('a number larger than CBOR is written here');
}

export function cborEncode(value) {
  const out = [];
  const put = (item) => {
    if (item === null) out.push(0xf6);
    else if (item === false) out.push(0xf4);
    else if (item === true) out.push(0xf5);
    else if (typeof item === 'number') {
      if (!Number.isInteger(item)) throw new BoardError('only whole numbers are written');
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
      throw new BoardError(`a ${typeof item} is not written`);
    }
  };
  put(value);
  return Uint8Array.from(out);
}

const BREAK = Symbol('break');

export function cborDecode(bytes) {
  let at = 0;
  const need = (count) => {
    if (at + count > bytes.length) throw new BoardError('the reply ends inside a value');
  };
  const argument = (info) => {
    if (info < 24) return info;
    const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (!size) throw new BoardError('the reply has a value this page does not read');
    need(size);
    let value = 0;
    for (let index = 0; index < size; index += 1) value = value * 256 + bytes[at + index];
    at += size;
    return value;
  };
  const item = (depth) => {
    if (depth > 16) throw new BoardError('the reply is nested too deep');
    need(1);
    const first = bytes[at];
    at += 1;
    if (first === 0xff) return BREAK;
    const major = first >> 5;
    const info = first & 0x1f;
    const indefinite = info === 31;
    if (major === 0) return argument(info);
    if (major === 1) return -1 - argument(info);
    if (major === 2 || major === 3) {
      const parts = [];
      if (indefinite) {
        for (let part = item(depth + 1); part !== BREAK; part = item(depth + 1))
          parts.push(typeof part === 'string' ? new TextEncoder().encode(part) : part);
      } else {
        const length = argument(info);
        need(length);
        parts.push(bytes.slice(at, at + length));
        at += length;
      }
      const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        joined.set(part, offset);
        offset += part.length;
      }
      return major === 3 ? new TextDecoder().decode(joined) : joined;
    }
    if (major === 4) {
      const list = [];
      if (indefinite) for (let entry = item(depth + 1); entry !== BREAK; entry = item(depth + 1)) list.push(entry);
      else for (let left = argument(info); left > 0; left -= 1) list.push(item(depth + 1));
      return list;
    }
    if (major === 5) {
      const map = {};
      const entry = () => {
        const key = item(depth + 1);
        if (key === BREAK) return false;
        const value = item(depth + 1);
        if (typeof key === 'string' || typeof key === 'number') map[String(key)] = value;
        return true;
      };
      if (indefinite) while (entry());
      else for (let left = argument(info); left > 0; left -= 1) entry();
      return map;
    }
    if (major === 6) {
      argument(info);
      return item(depth + 1);
    }
    if (info === 20) return false;
    if (info === 21) return true;
    if (info === 22 || info === 23) return null;
    throw new BoardError('the reply has a value this page does not read');
  };
  return item(0);
}

// SMP packets and their lines.

/** One request: the 8-byte header, the CBOR body and the CRC, as recover.py's Link.send makes it. */
export function smpPacket({ op, group, id, sequence, body }) {
  const payload = cborEncode(body);
  const packet = new Uint8Array(8 + payload.length + 2);
  packet[0] = op;
  packet[1] = 0;
  packet[2] = payload.length >> 8;
  packet[3] = payload.length & 0xff;
  packet[4] = group >> 8;
  packet[5] = group & 0xff;
  packet[6] = sequence & 0xff;
  packet[7] = id;
  packet.set(payload, 8);
  const crc = crc16Xmodem(packet.subarray(0, packet.length - 2));
  packet[packet.length - 2] = crc >> 8;
  packet[packet.length - 1] = crc & 0xff;
  return packet;
}

/** The lines of a packet: its length and itself, 93 bytes a line, each behind its start bytes. */
export function frameLines(packet) {
  const framed = new Uint8Array(packet.length + 2);
  framed[0] = packet.length >> 8;
  framed[1] = packet.length & 0xff;
  framed.set(packet, 2);
  const lines = [];
  for (let offset = 0; offset < framed.length; offset += LINE_BYTES) {
    const text = toBase64(framed.subarray(offset, offset + LINE_BYTES));
    const line = new Uint8Array(2 + text.length + 1);
    line.set(offset === 0 ? START_FIRST : START_MORE, 0);
    for (let index = 0; index < text.length; index += 1) line[2 + index] = text.charCodeAt(index);
    line[line.length - 1] = 0x0a;
    lines.push(line);
  }
  return lines;
}

export function isSmpLine(line) {
  return (
    line.length >= 2 &&
    ((line[0] === START_FIRST[0] && line[1] === START_FIRST[1]) ||
      (line[0] === START_MORE[0] && line[1] === START_MORE[1]))
  );
}

/**
 * Puts the lines of SMP back together. feed() takes one line (without its newline) and returns the
 * reply it completes, { op, group, id, sequence, body }, or null. A damaged one is dropped, as
 * recover.py drops it.
 */
export function createSmpReader() {
  let framed = null;
  return {
    feed(line) {
      const first = line[0] === START_FIRST[0] && line[1] === START_FIRST[1];
      if (first) framed = new Uint8Array(0);
      else if (framed === null) return null;
      let part;
      try {
        part = fromBase64(new TextDecoder().decode(line.subarray(2)).replace(/\r$/, ''));
      } catch {
        framed = null;
        return null;
      }
      const joined = new Uint8Array(framed.length + part.length);
      joined.set(framed);
      joined.set(part, framed.length);
      framed = joined;
      if (framed.length < 2) return null;
      const length = (framed[0] << 8) | framed[1];
      if (framed.length - 2 < length) return null;
      const packet = framed.subarray(2, 2 + length);
      framed = null;
      if (packet.length < 10 || crc16Xmodem(packet) !== 0) return null;
      try {
        return {
          op: packet[0],
          group: (packet[4] << 8) | packet[5],
          sequence: packet[6],
          id: packet[7],
          body: cborDecode(packet.subarray(8, packet.length - 2)),
        };
      } catch {
        return null;
      }
    },
  };
}

// MCUboot images (tools/golden.py parse_image, tools/check_image.py).

const MCUBOOT_MAGIC = 0x96f3b83d;
const TLV_INFO_MAGIC = 0x6907;
const TLV_PROTECTED_INFO_MAGIC = 0x6908;
const TLV_SHA256 = 0x10;
const TLV_KEY_HASH = 0x01;
const BOARD_TLV = 0xa1;
const LAYOUT_TLV = 0xa2;

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function tlvEntries(bytes, view, from, to) {
  const found = new Map();
  let offset = from;
  while (offset < to) {
    if (offset + 4 > to) throw new BoardError('the image is damaged: its metadata is cut short', 'image');
    const type = bytes[offset];
    const length = view.getUint16(offset + 2, true);
    offset += 4;
    if (offset + length > to) throw new BoardError('the image is damaged: its metadata is cut short', 'image');
    found.set(type, bytes.subarray(offset, offset + length));
    offset += length;
  }
  return found;
}

/**
 * What an MCUboot image says about itself: { version, size, hashTlv, keyHashTlv, board, layout, covered },
 * where `covered` is the part that hashTlv is the SHA-256 of. Throws a BoardError if it is not one.
 * The board type is from 1.13.0 on; an image without one is an nRF7002 DK's, of layout 1.
 */
export function parseImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 32)
    throw new BoardError('this is not a firmware image: too short', 'image');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MCUBOOT_MAGIC)
    throw new BoardError('this is not a firmware image: wrong magic', 'image');
  const headerSize = view.getUint16(8, true);
  const protectedSize = view.getUint16(10, true);
  const bodySize = view.getUint32(12, true);
  const version = `${bytes[20]}.${bytes[21]}.${view.getUint16(22, true)}+${view.getUint32(24, true)}`;
  const protectedAt = headerSize + bodySize;
  const tlvAt = protectedAt + protectedSize;
  let protectedTlvs = new Map();
  if (protectedSize) {
    if (bytes.length < protectedAt + 4 || view.getUint16(protectedAt, true) !== TLV_PROTECTED_INFO_MAGIC)
      throw new BoardError('the image is damaged: its protected metadata', 'image');
    protectedTlvs = tlvEntries(bytes, view, protectedAt + 4, tlvAt);
  }
  if (bytes.length < tlvAt + 4 || view.getUint16(tlvAt, true) !== TLV_INFO_MAGIC)
    throw new BoardError('the image is damaged: its metadata is missing', 'image');
  const end = tlvAt + view.getUint16(tlvAt + 2, true);
  if (bytes.length < end) throw new BoardError('the image is cut short', 'image');
  const tlvs = tlvEntries(bytes, view, tlvAt + 4, end);
  const digest = tlvs.get(TLV_SHA256);
  if (!digest) throw new BoardError('the image has no hash', 'image');
  const board = protectedTlvs.get(BOARD_TLV);
  const layout = protectedTlvs.get(LAYOUT_TLV);
  return {
    version,
    size: end,
    hashTlv: hex(digest),
    keyHashTlv: tlvs.has(TLV_KEY_HASH) ? hex(tlvs.get(TLV_KEY_HASH)) : null,
    board: board ? new TextDecoder().decode(board) : 'nrf7002dk',
    layout: layout ? Number(new TextDecoder().decode(layout)) || 1 : 1,
    covered: bytes.subarray(0, tlvAt),
  };
}

export async function sha256Hex(subtle, bytes) {
  return hex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
}

// The console's replies (board.py).

/** Lines of the form "thing name     cranium-1234", as STATUS prints them. */
export function keyValues(lines) {
  const result = {};
  for (const line of lines) {
    const match = KEY_VALUE.exec(line);
    if (match) result[match[1].trim()] = match[2].trim();
  }
  return result;
}

/**
 * One open port, read once. `port` is what navigator.serial hands out, opened already.
 *
 *   command(line, wait)   one console command, after the handshake that turns the echo off (a restart
 *                         turns it on, and a Wi-Fi command's echo would carry its password). Resolves to
 *                         { lines, final }; rejects with a BoardError if no final line comes.
 *   smp(op, group, id, body, wait)   one SMP request; resolves to the reply's body, or null.
 *   greet(ms)             SMP echo every 100 ms until the bootloader answers or the time is up.
 *   writeText(text)       bytes to the port as they are.
 *   onText(listener)      every line that is not SMP, as text.
 *   heardText             whether any such line came since it was last cleared.
 *   close()
 */
export function createLink(
  port,
  {
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    handshakeMs = HANDSHAKE_MS,
  } = {}
) {
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  const smpReader = createSmpReader();
  const textListeners = new Set();
  const waiters = [];
  let pending = new Uint8Array(0);
  let sequence = 0;
  let closed = false;
  let lost = null;
  const link = {
    heardText: false,
    writeText,
    command,
    smp,
    greet,
    drain,
    onText,
    close,
    get lost() {
      return lost;
    },
  };

  function deliver(line) {
    if (isSmpLine(line)) {
      const reply = smpReader.feed(line);
      if (reply) for (const waiter of waiters.splice(0)) waiter(reply);
      return;
    }
    const text = new TextDecoder().decode(line).replace(ANSI, '').trim();
    if (text) link.heardText = true;
    for (const listener of textListeners) listener(text);
  }

  const reading = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        const joined = new Uint8Array(pending.length + value.length);
        joined.set(pending);
        joined.set(value, pending.length);
        let start = 0;
        for (let at = 0; at < joined.length; at += 1) {
          if (joined[at] !== 0x0a) continue;
          deliver(
            joined.subarray(start, at).filter((byte, index, all) => !(byte === 0x0d && index === all.length - 1))
          );
          start = at + 1;
        }
        pending = joined.slice(start);
        if (pending.length > LINE_KEPT_MAX) pending = new Uint8Array(0);
      }
    } catch {
      // Unplugged, or closed by close().
    }
    if (!closed)
      lost = new BoardError('The connection to the board ended. The USB cable may have come out.', 'unplugged');
    for (const waiter of waiters.splice(0)) waiter(null);
  })();

  async function writeBytes(bytes) {
    if (closed || lost) throw lost ?? new BoardError('The port is closed.', 'closed');
    try {
      await writer.write(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  function writeText(text) {
    return writeBytes(new TextEncoder().encode(text));
  }

  function onText(listener) {
    textListeners.add(listener);
    return () => textListeners.delete(listener);
  }

  /** The text lines that come within `ms`, as they come, until `until` says stop. */
  function collect(ms, until) {
    return new Promise((resolve) => {
      const lines = [];
      let finished = false;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        stop();
        clearTimeout(timer);
        resolve(result);
      };
      const stop = onText((line) => {
        lines.push(line);
        const result = until(line, lines);
        if (result !== undefined) finish(result);
      });
      const timer = setTimeout(() => finish(null), ms);
    });
  }

  async function handshake() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const answer = collect(handshakeMs, (line) => {
        if (line === ECHO_OFF_REPLY) return 'ok';
        if (line.includes('command not found')) return 'shell';
        return undefined;
      });
      await writeText(`\r${ECHO_OFF}\r`);
      const result = await answer;
      if (result === 'ok') return;
      if (result === 'shell')
        throw new BoardError(
          'The board runs firmware from before the console. Put the newest firmware on it.',
          'shell'
        );
      if (lost) throw lost;
    }
    throw new BoardError('The board does not answer on this port.', 'silent');
  }

  async function command(line, wait = 3000) {
    await handshake();
    const name = line.split('|', 1)[0];
    const reply = collect(wait, (text, lines) => {
      if (FINAL_LINE.test(text)) {
        const body = lines
          .slice(0, -1)
          .filter((item) => item && !TAGGED_LINE.test(item) && item !== line && item !== ECHO_OFF_REPLY);
        return { lines: body, final: text };
      }
      return undefined;
    });
    await writeText(`${line}\r`);
    const result = await reply;
    if (!result)
      throw new BoardError(`The board did not finish ${name} within ${Math.round(wait / 1000)} s.`, 'timeout');
    return result;
  }

  async function smp(op, group, id, body, wait = REPLY_MS) {
    sequence = (sequence + 1) & 0xff;
    const asked = sequence;
    const answer = new Promise((resolve) => {
      const timer = setTimeout(() => {
        const at = waiters.indexOf(take);
        if (at >= 0) waiters.splice(at, 1);
        resolve(null);
      }, wait);
      function take(reply) {
        if (reply !== null && reply.sequence !== asked) {
          waiters.push(take);
          return;
        }
        clearTimeout(timer);
        resolve(reply?.body ?? null);
      }
      waiters.push(take);
    });
    for (const line of frameLines(smpPacket({ op, group, id, sequence: asked, body }))) await writeBytes(line);
    return answer;
  }

  /** Greet the bootloader until it answers. True if it did. */
  async function greet(ms) {
    const deadline = now() + ms;
    while (now() < deadline) {
      if (lost) throw lost;
      const reply = await smp(OP_WRITE, GROUP_OS, ID_OS_ECHO, { d: 'cranium' }, GREETING_EVERY_MS);
      if (reply !== null) {
        await drain();
        return true;
      }
    }
    return false;
  }

  /** Let the bootloader answer the greetings sent before the one it answered, and forget them. */
  async function drain() {
    await sleep(200);
  }

  async function close() {
    if (closed) return;
    closed = true;
    try {
      await reader.cancel();
    } catch {
      // Gone already.
    }
    await reading;
    try {
      reader.releaseLock();
    } catch {
      // Released already.
    }
    try {
      await writer.abort();
    } catch {
      // Gone already.
    }
    try {
      writer.releaseLock();
      await port.close();
    } catch {
      // Gone already.
    }
  }

  return link;
}

/**
 * Send an image through serial recovery, as recover.py upload does, with the bootloader listening
 * already. onProgress(sent, total). Resolves when the bootloader has all of it.
 */
export async function uploadImage(link, image, onProgress = () => {}) {
  let offset = 0;
  let lost = 0;
  while (offset < image.length) {
    const body = { off: offset, data: image.subarray(offset, offset + CHUNK), image: 0 };
    if (offset === 0) body.len = image.length;
    const reply = await link.smp(OP_WRITE, GROUP_IMAGE, ID_IMAGE_UPLOAD, body);
    if (reply === null) {
      lost += 1;
      if (lost > MAX_LOST) throw new BoardError(`The bootloader stopped answering at byte ${offset}.`, 'upload');
      await link.drain();
      continue;
    }
    lost = 0;
    if (typeof reply.rc === 'number' && reply.rc !== 0)
      throw new BoardError(`The bootloader refused the image with error ${reply.rc}.`, 'upload');
    if (!Number.isInteger(reply.off))
      throw new BoardError('The bootloader answered without saying how far it is.', 'upload');
    offset = reply.off;
    onProgress(offset, image.length);
  }
}
