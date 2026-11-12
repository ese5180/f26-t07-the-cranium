/**
 * Scheduled starts and maintenance windows (console 2.20.0, docs/mass-updates.md): the rules, without AWS.
 *
 * A time is asked for as a person reads a clock: a local date and time ("2026-11-10T02:00") and the
 * IANA time zone it is in ("America/New_York"). zonedToUtc turns that into one instant. A local time
 * that a change to summer time skips (02:30 on the morning the clocks go forward) is taken as the same
 * time after the change (03:30); one that happens twice (01:30 on the morning they go back) as the
 * first of the two.
 *
 * A maintenance window is { days, start, end, timeZone }: the days of the week it opens on (0 Sunday to
 * 6 Saturday, in its time zone), and from when to when, "HH:MM" each. An end at or before the start is
 * on the next day ("22:00" to "02:00"), and belongs to the day the window opened. insideWindow compares
 * the wall clock in the window's time zone, so the window keeps its local hours across a change to or
 * from summer time; the hour a change skips is simply not part of it that day.
 */

import { badRequest } from '../http.mjs';

export const SCHEDULE_ID = /^sch-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
export const SCHEDULE_KINDS = Object.freeze(['deployment', 'rollout', 'last_good']);
export const SCHEDULE_STATUSES = Object.freeze(['scheduled', 'starting', 'started', 'failed', 'cancelled']);
// How far ahead a start may be scheduled, and how soon at the earliest: the next run of the schedule
// that starts it is up to a minute away, so "now" is no time to ask for.
export const MAX_AHEAD_MS = 30 * 86_400_000;
export const MIN_AHEAD_MS = 60_000;
// At most this many open schedules (not yet started or ended) at once.
export const MAX_OPEN_SCHEDULES = 50;
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ZONE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
const WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const DAY_NAMES = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

const formats = new Map();

function formatOf(timeZone) {
  let format = formats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formats.set(timeZone, format);
  }
  return format;
}

/** Whether `value` is an IANA time zone this runtime knows. */
export function isTimeZone(value) {
  if (typeof value !== 'string' || !ZONE.test(value)) return false;
  try {
    formatOf(value);
    return true;
  } catch {
    return false;
  }
}

export function requireTimeZone(value, name = 'timeZone') {
  if (!isTimeZone(value)) {
    throw badRequest(`invalid_${name}`, `"${name}" is a time zone such as "America/New_York" or "UTC".`);
  }
  return value;
}

/** The wall clock at instant `ms` in `timeZone`: { year, month, day, hour, minute, second, weekday }. */
export function wallClock(ms, timeZone) {
  const parts = {};
  for (const part of formatOf(timeZone).formatToParts(new Date(ms))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

/** How far `timeZone` is ahead of UTC at instant `ms`, in milliseconds. */
function offsetAt(ms, timeZone) {
  const clock = wallClock(ms, timeZone);
  const local = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  return local - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant of local time `local` ("YYYY-MM-DDTHH:MM") in `timeZone`, in epoch milliseconds, or null
 * if `local` is no date and time. Skipped times move on by the change; repeated ones take the first.
 */
export function zonedToUtc(local, timeZone) {
  const match = typeof local === 'string' ? LOCAL_TIME.exec(local) : null;
  if (match === null) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const back = new Date(guess);
  if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day || hour > 23 || minute > 59) return null;
  const first = offsetAt(guess, timeZone);
  const at = guess - first;
  const second = offsetAt(at, timeZone);
  if (second === first) {
    // Of a time that happens twice, the earlier: read with the offset of a few hours before, if that
    // reads the same. Not always an hour earlier: Lord Howe Island goes back by half an hour.
    const before = offsetAt(at - 3 * 3_600_000, timeZone);
    if (before === first) return at;
    const earlier = guess - before;
    const clock = wallClock(earlier, timeZone);
    if (earlier < at && clock.hour === hour && clock.minute === minute && clock.day === day) return earlier;
    return at;
  }
  const other = guess - second;
  if (offsetAt(other, timeZone) === second) return other;
  // Skipped by the change: the same time after it, read with the offset from before the change.
  return guess - Math.min(first, second);
}

/** Local time and zone, checked: { local, timeZone, dueMs }. */
export function requireLocalTime(local, timeZone) {
  const zone = requireTimeZone(timeZone);
  const dueMs = zonedToUtc(local, zone);
  if (dueMs === null) throw badRequest('invalid_at', '"at" is a local date and time, such as "2026-11-10T02:00".');
  return { local, timeZone: zone, dueMs };
}

/** A start time that may be scheduled now: at least a minute ahead and at most 30 days. */
export function requireAhead(dueMs, nowMs) {
  if (dueMs < nowMs + MIN_AHEAD_MS) {
    throw badRequest('schedule_in_past', 'Choose a time at least a minute from now.');
  }
  if (dueMs > nowMs + MAX_AHEAD_MS) {
    throw badRequest('schedule_too_far', 'Choose a time within the next 30 days.');
  }
  return dueMs;
}

const minutesOf = (clock) => {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours * 60 + minutes;
};

/**
 * A group's maintenance window as a request gives it: null (none), or { days, start, end, timeZone }
 * with 1 to 7 days, none twice. Returns it as it is stored: days sorted.
 */
export function requireWindow(value) {
  if (value === null) return null;
  const invalid = () =>
    badRequest(
      'invalid_window',
      'A maintenance window is { days: [0-6], start: "HH:MM", end: "HH:MM", timeZone } or null for none.'
    );
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const { days, start, end, timeZone } = value;
  if (
    !Array.isArray(days) ||
    days.length < 1 ||
    days.length > 7 ||
    !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) ||
    new Set(days).size !== days.length
  ) {
    throw invalid();
  }
  if (typeof start !== 'string' || !CLOCK.test(start) || typeof end !== 'string' || !CLOCK.test(end)) throw invalid();
  if (start === end) throw badRequest('invalid_window', 'A maintenance window ends at another time than it starts.');
  return { days: [...days].sort((a, b) => a - b), start, end, timeZone: requireTimeZone(timeZone) };
}

/** A stored window as it is read back: the window, or null if it is none or not one. */
export function windowFromItem(value) {
  try {
    return value === undefined || value === null ? null : requireWindow(value);
  } catch {
    return null;
  }
}

/** Whether instant `ms` is inside `window` (none: always). */
export function insideWindow(window, ms) {
  if (window === null || window === undefined) return true;
  const clock = wallClock(ms, window.timeZone);
  const minute = clock.hour * 60 + clock.minute;
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  if (start < end) return window.days.includes(clock.weekday) && minute >= start && minute < end;
  // Over midnight: the evening of a day it opens on, or the small hours after one.
  return (
    (window.days.includes(clock.weekday) && minute >= start) ||
    (window.days.includes((clock.weekday + 6) % 7) && minute < end)
  );
}

/** A window in words, for the activity log and the pages: "weekdays 01:00–05:00 America/New_York". */
export function windowWords(window) {
  if (window === null || window === undefined) return null;
  const days = window.days.join(',');
  let which;
  if (days === '0,1,2,3,4,5,6') which = 'every day';
  else if (days === '1,2,3,4,5') which = 'weekdays';
  else if (days === '0,6') which = 'weekends';
  else which = window.days.map((day) => DAY_NAMES[day].slice(0, 3)).join(' ');
  return `${which} ${window.start}–${window.end} ${window.timeZone}`;
}

/** A schedule's id: sch-<yyyymmddThhmmssZ>-<6 hex>, in time order. */
export function scheduleId(nowMs, hex) {
  const stamp = new Date(nowMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const id = `sch-${stamp}-${hex}`;
  if (!SCHEDULE_ID.test(id)) throw new TypeError('The time or the hex does not make a schedule id');
  return id;
}

export function requireScheduleId(value) {
  if (typeof value !== 'string' || !SCHEDULE_ID.test(value)) {
    throw badRequest('invalid_schedule', 'That is not the id of a scheduled start.');
  }
  return value;
}

/** Whether a schedule has not started or ended yet: it can be edited or cancelled. */
export const isOpenSchedule = (item) => item?.status === 'scheduled';
