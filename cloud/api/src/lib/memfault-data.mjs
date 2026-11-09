/**
 * What Memfault's REST API answers, made into what the console shows (docs/memfault.md, "In the
 * console"). Pure functions: no I/O. Each takes Memfault's JSON as it comes and keeps only fields of the
 * expected types, so that an answer of another shape shows less, never something wrong.
 *
 * A board's device serial in Memfault is its AWS IoT thing name (src/mflt.c sets it at boot with
 * memfault_ncs_device_id_set), so `thing` is the serial when that is a thing name, and null for a device
 * that is not one of ours.
 *
 * The shapes, as Memfault answered them in November 2026:
 *   devices                     { data: [{ device_serial, hardware_version: { name }, cohort: { name, slug },
 *                                 first_seen, last_seen, last_seen_software_version: { version,
 *                                 software_type: { name } } }], paging }
 *   devices/<serial>/reboots    { data: [{ time, reason: <number>, type, mcu_reason_register,
 *                                 software_version: { version } }] }
 *   issues, issues/<id>         Issue: { id, title, status, trace_count, device_count, first_seen, last_seen,
 *                                 first_release, last_release, signature, last_trace }
 *   traces                      Trace: { id, title, reason, captured_date, received_date, device: {
 *                                 device_serial }, release: { version }, signature, entries: { threads: [{
 *                                 tid, crashed, current, state, registers, stacktrace: [{ index, function,
 *                                 file, lineno, address }] }] } }
 *   processing-log              { data: [{ created_date, device_serial, software_version, event_type, level,
 *                                 source, event_data: { received_event: { captured_date, event_info } } }],
 *                                 links: { next } }: the reboots, trace events and heartbeats a board sent
 *   releases                    { data: [{ version, created_date }] }
 *   software_types/app/software_versions  { data: [{ version, created_date, symbol_file }] }
 */

import { isThing } from './validate.mjs';

// The reboot reasons of the Memfault SDK (components/include/memfault/core/reboot_reason_types.h), and
// this firmware's own (firmware/app/config/memfault_reboot_reason_user_config.def): the expected ones
// from 0x1001, the unexpected from 0xA001, in the order the file defines them.
const REBOOT_REASONS = new Map([
  [0x0000, 'Unknown'],
  [0x0001, 'UserShutdown'],
  [0x0002, 'UserReset'],
  [0x0003, 'FirmwareUpdate'],
  [0x0004, 'LowPower'],
  [0x0005, 'DebuggerHalted'],
  [0x0006, 'ButtonReset'],
  [0x0007, 'PowerOnReset'],
  [0x0008, 'SoftwareReset'],
  [0x0009, 'DeepSleep'],
  [0x000a, 'PinReset'],
  [0x000b, 'SelfTest'],
  [0x1001, 'FactoryReset'],
  [0x8000, 'UnknownError'],
  [0x8001, 'Assert'],
  [0x8002, 'WatchdogDeprecated'],
  [0x8003, 'BrownOutReset'],
  [0x8004, 'Nmi'],
  [0x8005, 'HardwareWatchdog'],
  [0x8006, 'SoftwareWatchdog'],
  [0x8007, 'ClockFailure'],
  [0x8008, 'KernelPanic'],
  [0x8009, 'FirmwareUpdateError'],
  [0x800a, 'OutOfMemory'],
  [0x800b, 'StackOverflow'],
  [0x800c, 'TaskWatchdog'],
  [0x9100, 'BusFault'],
  [0x9200, 'MemFault'],
  [0x9300, 'UsageFault'],
  [0x9400, 'HardFault'],
  [0x9401, 'Lockup'],
  [0x9402, 'SecurityViolation'],
  [0x9403, 'ParityError'],
  [0x9404, 'Temperature'],
  [0x9405, 'Hardware'],
  [0xa001, 'StuckWifiSilent'],
  [0xa002, 'StuckNoCloud'],
  [0xa003, 'StuckUpdateStall'],
]);

// This firmware's trace reasons (firmware/app/config/memfault_trace_reason_user_config.def), from 1: the
// SDK numbers a user's reasons after its own Unknown.
const TRACE_REASONS = [
  'update_succeeded',
  'update_failed',
  'update_digest_mismatch',
  'update_incompatible',
  'update_refused',
  'update_rolled_back',
];

const LIMIT = Object.freeze({ text: 200, long: 2000, frames: 64, threads: 32, registers: 64, metrics: 128 });
const METRIC_KEY = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
const VERSION = /^[0-9A-Za-z.+_-]{1,64}$/;

function text(value, max = LIMIT.text) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

/** An ISO time, as the console's other answers give it; null for anything else. */
export function instant(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function version(value) {
  const raw = typeof value === 'string' ? value : typeof value?.version === 'string' ? value.version : null;
  return raw !== null && VERSION.test(raw) ? raw : null;
}

function serialOf(value) {
  const serial = typeof value === 'string' ? value : value?.device_serial;
  return typeof serial === 'string' && /^[-a-zA-Z0-9_]{1,128}$/.test(serial) ? serial : null;
}

/** A reboot reason by its number: { code, name, expected }. Unknown numbers keep their number. */
export function rebootReason(code) {
  if (!Number.isInteger(code) || code < 0 || code > 0xffff) return { code: null, name: 'Unknown', expected: false };
  const name = REBOOT_REASONS.get(code) ?? `0x${code.toString(16).padStart(4, '0')}`;
  // The SDK's expected reasons are below 0x8000; its custom expected ones are 0x1000 to 0x10ff.
  return { code, name, expected: code < 0x8000 };
}

/** A trace event's reason: this firmware's name for a user reason, else the SDK's number. */
export function traceReason(code, isUser) {
  if (!Number.isInteger(code)) return 'unknown';
  if (isUser === true) return TRACE_REASONS[code - 1] ?? `user_reason_${code}`;
  return `reason_${code}`;
}

/** One device of Memfault's list or detail. */
export function device(raw) {
  const value = record(raw);
  const serial = serialOf(value);
  if (serial === null) return null;
  const software = record(value.last_seen_software_version);
  return {
    serial,
    thing: isThing(serial) ? serial : null,
    hardware: text(record(value.hardware_version).name, 64),
    software: version(software),
    softwareType: text(record(software.software_type).name, 64),
    cohort: text(record(value.cohort).name, 64),
    firstSeen: instant(value.first_seen),
    lastSeen: instant(value.last_seen),
  };
}

/** A reboot of devices/<serial>/reboots, newest first as Memfault gives them. */
export function reboot(raw) {
  const value = record(raw);
  const at = instant(value.time);
  if (at === null) return null;
  return {
    at,
    reason: rebootReason(value.reason),
    version: version(value.software_version),
    register: Number.isInteger(value.mcu_reason_register) ? value.mcu_reason_register : null,
  };
}

function frame(raw, index) {
  const value = record(raw);
  return {
    index: Number.isInteger(value.index) ? value.index : index,
    function: text(value.function, 200),
    file: text(value.file, 300),
    line: Number.isInteger(value.lineno) ? value.lineno : null,
    address: Number.isInteger(value.address) ? `0x${value.address.toString(16).padStart(8, '0')}` : null,
  };
}

/** A register as { name, value }, whether Memfault gives an object, a pair or "name: value". */
function register(raw) {
  if (typeof raw === 'string') {
    const match = /^\s*([A-Za-z0-9_]{1,16})\s*[:=]\s*(\S{1,40})\s*$/.exec(raw);
    return match ? { name: match[1], value: match[2] } : { name: null, value: raw.slice(0, 40) };
  }
  if (Array.isArray(raw) && raw.length === 2) return register({ name: raw[0], value: raw[1] });
  const value = record(raw);
  const name = text(value.name ?? value.register, 16);
  const content = value.value;
  const shown =
    Number.isInteger(content) && content >= 0
      ? `0x${content.toString(16).padStart(8, '0')}`
      : typeof content === 'string'
        ? content.slice(0, 40)
        : null;
  return name === null && shown === null ? null : { name, value: shown };
}

function thread(raw, index) {
  const value = record(raw);
  return {
    id: Number.isInteger(value.tid) ? value.tid : index,
    name: text(value.name, 64),
    crashed: value.crashed === true,
    current: value.current === true,
    state: text(value.state, 32),
    frames: list(value.stacktrace).slice(0, LIMIT.frames).map(frame),
    registers: list(value.registers)
      .slice(0, LIMIT.registers)
      .map(register)
      .filter((one) => one !== null),
  };
}

/** A trace: a coredump or trace event Memfault grouped into an issue, with its threads and backtrace. */
export function trace(raw) {
  const value = record(raw);
  const serial = serialOf(value.device);
  // The crashed thread first, then the one that was running, then the rest as Memfault lists them.
  const threads = list(record(value.entries).threads)
    .slice(0, LIMIT.threads)
    .map(thread)
    .sort((a, b) => Number(b.crashed) - Number(a.crashed) || Number(b.current) - Number(a.current));
  return {
    id: Number.isInteger(value.id) ? value.id : null,
    title: text(value.title),
    reason: text(value.reason, 64),
    message: text(value.message, LIMIT.long),
    capturedAt: instant(value.captured_date),
    receivedAt: instant(value.received_date),
    serial,
    thing: serial !== null && isThing(serial) ? serial : null,
    version: version(value.release),
    signature: text(value.signature, 128),
    threads,
  };
}

/** An issue: a kind of crash or trace event, with how often and on how many boards. */
export function issue(raw) {
  const value = record(raw);
  if (!Number.isInteger(value.id) || value.id < 0) return null;
  return {
    id: value.id,
    title: text(value.title) ?? 'Untitled issue',
    status: text(value.status, 32),
    traces: count(value.trace_count) ?? 0,
    boards: count(value.device_count) ?? 0,
    firstSeen: instant(value.first_seen),
    lastSeen: instant(value.last_seen),
    firstVersion: version(value.first_release),
    lastVersion: version(value.last_release),
    signature: text(value.signature, 128),
    // The traces of each day of the last weeks, oldest first, as Memfault counts them.
    counts: list(value.counts)
      .filter((one) => Number.isInteger(one) && one >= 0)
      .slice(-90),
  };
}

/** A release in Memfault's list, with whether its symbols are there (from the software versions). */
export function release(raw, symbols) {
  const value = record(raw);
  const name = version(value.version);
  if (name === null) return null;
  return {
    version: name,
    createdAt: instant(value.created_date),
    symbols: symbols.has(name) ? symbols.get(name) : null,
  };
}

/** The software versions Memfault has, as version -> whether their symbols were uploaded. */
export function symbolsByVersion(raw) {
  const found = new Map();
  for (const one of list(record(raw).data)) {
    const name = version(one?.version);
    if (name !== null) found.set(name, one?.symbol_file !== null && typeof one?.symbol_file === 'object');
  }
  return found;
}

/**
 * The metrics of a heartbeat as { key: number }. Memfault names them when it has the build's symbols;
 * without them it keeps them as a list in the build's order, which no one but the build can name: then
 * null, and `unnamed` says how many there were.
 */
function metricsOf(info) {
  const raw = info?.metrics;
  if (Array.isArray(raw)) return { values: null, unnamed: raw.filter((one) => one !== null).length };
  const values = {};
  let kept = 0;
  for (const [key, value] of Object.entries(record(raw))) {
    if (kept >= LIMIT.metrics || !METRIC_KEY.test(key)) continue;
    const number = typeof value === 'number' ? value : typeof value?.value === 'number' ? value.value : null;
    if (number === null || !Number.isFinite(number)) continue;
    values[key] = number;
    kept += 1;
  }
  return { values, unnamed: 0 };
}

/**
 * One entry of the processing log as what a board sent: { kind: 'reboot' | 'trace' | 'heartbeat' |
 * 'problem', at, serial, thing, version, ... }, or null for anything else. A heartbeat or trace event that
 * Memfault could not read for want of symbols arrives as SymbolFileMissing with the event in it: it is
 * the heartbeat (or event) and, apart, a problem naming the build.
 */
export function logEntries(raw) {
  const value = record(raw);
  const serial = serialOf(value.device_serial);
  const data = record(value.event_data);
  const received = record(data.received_event);
  const info = record(received.event_info);
  const at = instant(received.captured_date) ?? instant(value.created_date);
  const base = {
    at,
    serial,
    thing: serial !== null && isThing(serial) ? serial : null,
    version: version(value.software_version) ?? version(record(data.software_version).version),
  };
  if (at === null) return [];
  const out = [];
  const type = text(value.event_type, 64) ?? '';
  if (type === 'ReceivedDataRebootEvent' || (type.endsWith('RebootEvent') && 'reason' in info)) {
    out.push({ kind: 'reboot', ...base, reason: rebootReason(info.reason), crashed: info.coredump_saved === true });
  } else if ('metrics' in info) {
    out.push({ kind: 'heartbeat', ...base, ...metricsOf(info) });
  } else if ('reason' in info && (type.endsWith('TraceEvent') || 'is_user_reason' in info)) {
    out.push({
      kind: 'event',
      ...base,
      name: traceReason(info.reason, info.is_user_reason),
      detail: text(info.reason_log, 200),
    });
  }
  if (type === 'SymbolFileMissing' || value.level === 'error') {
    const builds = list(data.missing_symbol_files)
      .map((one) => text(record(one).build_id, 64))
      .filter(Boolean);
    const build = text(data.build_id, 64);
    out.push({
      kind: 'problem',
      ...base,
      type: type || 'ProcessingError',
      builds: [...new Set([...(build ? [build] : []), ...builds])],
    });
  }
  return out;
}

/**
 * Heartbeats as series: { keys: [...sorted], series: { key: [{ at, v }] oldest first }, unnamed }.
 * Every key that any heartbeat has is kept, whatever the firmware calls it: 1.15.0's power status and
 * Zephyr's own metrics show up as they come.
 */
export function metricSeries(heartbeats) {
  const series = {};
  let unnamed = 0;
  const ordered = [...heartbeats].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const beat of ordered) {
    if (beat.values === null) {
      unnamed += 1;
      continue;
    }
    for (const [key, v] of Object.entries(beat.values)) {
      series[key] ??= [];
      series[key].push({ at: beat.at, v });
    }
  }
  return { keys: Object.keys(series).sort(), series, unnamed };
}

/** Reboots counted by reason, most first: [{ reason, count, boards: [serial] }]. */
export function rebootsByReason(reboots) {
  const found = new Map();
  for (const one of reboots) {
    const key = one.reason.name;
    const entry = found.get(key) ?? { reason: one.reason, count: 0, boards: new Set() };
    entry.count += 1;
    if (one.serial) entry.boards.add(one.serial);
    found.set(key, entry);
  }
  return [...found.values()]
    .map((entry) => ({ reason: entry.reason, count: entry.count, boards: [...entry.boards].sort() }))
    .sort((a, b) => b.count - a.count || (a.reason.name < b.reason.name ? -1 : 1));
}

/** The problems of Memfault's processing, one per kind and build, newest first. */
export function problemsOf(entries) {
  const found = new Map();
  for (const one of entries) {
    const key = `${one.type} ${one.builds.join(',')} ${one.version ?? ''}`;
    const known = found.get(key);
    if (known === undefined) found.set(key, { ...one, count: 1, boards: one.serial ? [one.serial] : [] });
    else {
      known.count += 1;
      if (one.serial && !known.boards.includes(one.serial)) known.boards.push(one.serial);
      if (one.at > known.at) known.at = one.at;
    }
  }
  return [...found.values()]
    .map(({ kind: _kind, serial: _serial, thing: _thing, ...rest }) => ({ ...rest, boards: rest.boards.sort() }))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}
