/**
 * The parts of the console that do not touch the page: the grammar of versions, board
 * names and deployment ids, the sign-in flow, the API client, and the words used for
 * what a board is doing during an update.
 *
 * Whatever arrives from the API is reduced to known shapes on the way in. Text that a
 * board reported is additionally cut down to printable ASCII, because nothing a board
 * says can be trusted. The views only see the reduced form and only ever write it to
 * the page as text.
 *
 * Nothing in this file reads the document, so the unit tests load it as it is.
 * No dependencies.
 */

// Grammar. The same patterns the API enforces; a value that does not match is never
// put into a request path or a link.

const VERSION = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,4})\+(0|[1-9]\d{0,9})$/;
const THING = /^cranium-[0-9a-f]{16}$/;
// device_id_valid() in firmware/app/src/device.c: 1 to 32 letters and digits.
const BOARD_NAME = /^[A-Za-z0-9]{1,32}$/;
const DEPLOYMENT = /^cranium-(\d{1,3})-(\d{1,3})-(\d{1,5})-b(\d{1,10})-\d{8}T\d{6}Z-[0-9a-f]{4}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

/** Parse "major.minor.revision+build"; null for anything else. */
export function parseVersion(text) {
  const match = typeof text === 'string' ? VERSION.exec(text) : null;
  if (!match) return null;
  const version = {
    major: Number(match[1]),
    minor: Number(match[2]),
    revision: Number(match[3]),
    build: Number(match[4]),
  };
  const { major, minor, revision, build } = version;
  if (major > 0xff || minor > 0xff || revision > 0xffff || build > 0xffffffff) return null;
  return version;
}

export function formatVersion({ major, minor, revision, build }) {
  return `${major}.${minor}.${revision}+${build}`;
}

/** Negative, zero or positive as a is older than, equal to or newer than b. */
export function compareVersions(a, b) {
  for (const field of ['major', 'minor', 'revision', 'build']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  return 0;
}

export function isVersion(text) {
  return parseVersion(text) !== null;
}

export function isThing(text) {
  return typeof text === 'string' && THING.test(text);
}

export function isDeploymentId(text) {
  return typeof text === 'string' && DEPLOYMENT.test(text);
}

// Boards by name. A board's thing name (cranium-…) is its identity in AWS IoT: it is in every
// address, request and record, and never changes. Its own name is the device ID a person gave
// it at its serial console, which firmware from 1.11.4 reports with its diagnostics, and it is
// what people know the board by. Wherever a board is shown, the name comes first and the thing
// name second; a board that has not reported a name is shown by its thing name, as before. The
// choice is made here and nowhere else. Like everything a board says, a name is only ever text.

export function isBoardName(text) {
  return typeof text === 'string' && BOARD_NAME.test(text);
}

/** A name given in the console: one line of 1 to 40 printable characters, with no space at either end. */
export function isBoardLabel(text) {
  return (
    typeof text === 'string' &&
    text === text.trim() &&
    [...text].length >= 1 &&
    [...text].length <= MAX_BOARD_LABEL &&
    !UNPRINTABLE.test(text)
  );
}

export const MAX_BOARD_LABEL = 40;

/**
 * What to call a board ({ thing, label, name }): the name given in the console, else its own name, else its thing
 * name.
 * `short` cuts a thing name to its start, for a tab's title or a sentence that is read out;
 * `full` adds the thing name to a name, for a tooltip or a line that has to say both.
 */
export function boardName(board, { short = false, full = false } = {}) {
  const thing = typeof board?.thing === 'string' ? board.thing : '';
  if (isBoardLabel(board?.label)) return full && thing ? `${board.label} · ${thing}` : board.label;
  if (isBoardName(board?.name)) return full && thing ? `${board.name} · ${thing}` : board.name;
  return short && thing.length > 12 ? `${thing.slice(0, 12)}…` : thing;
}

/**
 * The board with a thing name in a list of boards, for a view that has only the thing name:
 * the board as listed, or one that has no name if the list does not have it (yet).
 */
export function boardOf(thing, devices) {
  return (devices ?? []).find((device) => device.thing === thing) ?? { thing, name: null };
}

/** The firmware version a deployment installs, recovered from its id. */
export function versionOfDeployment(id) {
  const match = typeof id === 'string' ? DEPLOYMENT.exec(id) : null;
  if (!match) return null;
  const version = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}+${Number(match[4])}`;
  return isVersion(version) ? version : null;
}

// Routes. The console has exactly these; anything else in the address bar is ignored.

const SECTIONS = [
  'overview',
  'devices',
  'diagnostics',
  'events',
  'firmware',
  'deployments',
  'activity',
  'serial',
  // Board setup over USB (setup.js).
  'setup',
  'history',
  // Every version of every product, a tab each (release-notes.js): #/release-notes/<product>.
  'release-notes',
  'tokens',
  // Board types, groups and staged rollouts (fleet.js).
  'fleet',
  // The map of the boards, and the Account page with its e-mail alerts (map.js, account.js).
  'map',
  'account',
  // The alert rules and the alerts that went out (account.js).
  'alerts',
  // The phone apps: where to get them, and how to put them on a phone (apps.js).
  'apps',
  'customers',
  // The team's accounts, for release managers (team.js, docs/accounts.md).
  'team',
  // An update over Bluetooth, in the phone app only (bluetooth.js).
  'bluetooth',
  // Offline mode: a board's status over Bluetooth, in the apps that offer bleOffline (offline.js).
  'offline',
  // What Memfault knows of the boards: its issues, and an issue's traces (memfault-page.js).
  'memfault',
  // Our own issues: the boards' crashes, faults and stuck restarts, grouped by signature (issues-page.js),
  // under Memfault in the sections (docs/own-observability.md).
  'issues',
  // The console's DynamoDB tables, read only, for release managers, under Developer (db-page.js).
  'database',
  // Two to four boards side by side, with their version timelines (compare.js): #/compare?boards=a,b.
  'compare',
  // The weekly fleet report: the weeks, and a week's page (reports.js, docs/reports.md).
  'reports',
];
// The Release notes page's tabs, in their order (release-notes.js).
export const RELEASE_PRODUCTS = Object.freeze(['console', 'firmware', 'iphone', 'android', 'desktop', 'mac']);
// The tables of the Database page (cloud/api/src/lib/db.mjs TABLES).
const DB_TABLES = ['state', 'audit', 'events'];
// One of our own issues (cloud/api/src/lib/issues.mjs): 12 hex digits of its signature's SHA-256.
export const OWN_ISSUE = /^[0-9a-f]{12}$/;
// A staged rollout's id (cloud/api/src/lib/fleet.mjs): rol-<yyyymmddThhmmssZ>-<6 hex>.
const ROLLOUT = /^rol-\d{8}T\d{6}Z-[0-9a-f]{6}$/;

export function isRolloutId(value) {
  return typeof value === 'string' && ROLLOUT.test(value);
}

export function rolloutHref(id) {
  return isRolloutId(id) ? `#/rollouts/${id}` : null;
}

/** A week of the weekly report (docs/reports.md): named by its Monday, "2026-11-02". */
export function isReportWeek(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value && new Date(ms).getUTCDay() === 1;
}
// A page's address, and after a ? the filters of its list (docs/search-filters.md): #/events?board=…&q=wifi.
const ROUTE = /^#\/([a-z]+(?:-[a-z]+)?)(?:\/([A-Za-z0-9-]+))?(?:\?([A-Za-z0-9=&%._~+,:*!'()-]{0,800}))?$/;

/**
 * Turn a location hash into a route, or null if it is not one of the console's. A page with filters
 * (FILTERS) carries them as `query`: the names and values of the hash's query, unchecked yet (readFilters).
 */
export function parseRoute(hash) {
  const match = typeof hash === 'string' ? ROUTE.exec(hash) : null;
  if (!match) return null;
  const route = routeOf(match[1], match[2]);
  if (route !== null && match[3] !== undefined && Object.hasOwn(FILTERS, route.view) && route.thing === undefined) {
    route.query = queryOf(match[3]);
  }
  return route;
}

function routeOf(section, item) {
  if (item === undefined) return SECTIONS.includes(section) ? { view: section } : null;
  if (section === 'devices' && isThing(item)) return { view: 'device', thing: item };
  if (section === 'deployments' && isDeploymentId(item)) return { view: 'deployment', id: item };
  // One board's diagnostics, when there are too many boards for a card each.
  if (section === 'diagnostics' && isThing(item)) return { view: 'diagnostics', thing: item };
  // One staged rollout: its canary, its waves, and why it stopped (fleet.js).
  if (section === 'rollouts' && isRolloutId(item)) return { view: 'rollout', id: item };
  // One Memfault issue: its traces and backtraces (memfault-page.js).
  if (section === 'memfault' && /^[1-9]\d{0,15}$/.test(item)) return { view: 'issue', id: item };
  // One of our own issues: its boards and its timeline (issues-page.js).
  if (section === 'issues' && OWN_ISSUE.test(item)) return { view: 'own-issue', id: item };
  // One table of the Database page (db-page.js).
  if (section === 'database' && DB_TABLES.includes(item)) return { view: 'database', table: item };
  // One week's report (reports.js).
  if (section === 'reports' && isReportWeek(item)) return { view: 'report', week: item };
  // One product's tab of the Release notes.
  if (section === 'release-notes' && RELEASE_PRODUCTS.includes(item)) return { view: 'release-notes', product: item };
  return null;
}

/** The canonical hash for a route. Built from checked values only. */
export function routeHash(route) {
  if (route?.view === 'device' && isThing(route.thing)) return `#/devices/${route.thing}`;
  if (route?.view === 'deployment' && isDeploymentId(route.id)) return `#/deployments/${route.id}`;
  if (route?.view === 'diagnostics' && isThing(route.thing)) return `#/diagnostics/${route.thing}`;
  if (route?.view === 'rollout' && isRolloutId(route.id)) return `#/rollouts/${route.id}`;
  if (route?.view === 'issue' && /^[1-9]\d{0,15}$/.test(route.id ?? '')) return `#/memfault/${route.id}`;
  if (route?.view === 'own-issue' && OWN_ISSUE.test(route.id ?? '')) return `#/issues/${route.id}`;
  if (route?.view === 'database' && DB_TABLES.includes(route.table)) return `#/database/${route.table}`;
  if (route?.view === 'report' && isReportWeek(route.week)) return `#/reports/${route.week}`;
  if (route?.view === 'release-notes' && RELEASE_PRODUCTS.includes(route.product)) {
    return `#/release-notes/${route.product}`;
  }
  if (SECTIONS.includes(route?.view)) return `#/${route.view}`;
  return '#/overview';
}

/** Link to a board or a deployment, or null if the name is not a valid one. */
export function deviceHref(thing) {
  return isThing(thing) ? `#/devices/${thing}` : null;
}

export function deploymentHref(id) {
  return isDeploymentId(id) ? `#/deployments/${id}` : null;
}

// Search and filters (docs/search-filters.md). A list that can grow long has a search box and the filters that
// suit it, kept in the page's address after a ?, so that a filtered list can be shared or bookmarked. Each
// page's filters are checked here, by name: a value that is not one of the page's is left out, as if absent.

const MAX_SEARCH = 100;
const UNPRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/u;

/** The names and values after the ? of a hash: the first of each name, short and printable only. */
function queryOf(text) {
  const out = {};
  let params;
  try {
    params = new URLSearchParams(text);
  } catch {
    return out;
  }
  for (const [name, value] of params) {
    if (!/^[a-z]{1,12}$/.test(name) || Object.hasOwn(out, name)) continue;
    if (value.length <= 200 && !UNPRINTABLE.test(value)) out[name] = value;
  }
  return out;
}

/** Search text as the API takes it (q): trimmed, one line, at most 100 characters; '' for none. */
export function cleanSearch(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(UNPRINTABLE, ' ').trim();
  return text.slice(0, MAX_SEARCH).trim();
}

/**
 * Whether a row's words hold every word of the search, in any case: the search of a short list, made here.
 * `fields` are the row's texts; anything that is not text is passed over.
 */
export function matchesSearch(fields, search) {
  const words = cleanSearch(search).toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields
    .filter((field) => typeof field === 'string' || typeof field === 'number')
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

const oneOf = (values) => (value) => (values.includes(value) ? value : '');
// A list, comma separated, each one of `values` and none twice, written in their order.
const someOf = (values) => (value) => {
  const parts = value.split(',');
  if (parts.length === 0 || new Set(parts).size !== parts.length || parts.some((part) => !values.includes(part))) {
    return '';
  }
  return values.filter((item) => parts.includes(item)).join(',');
};
const searchText = (value) => cleanSearch(value);
const boardFilter = (value) => (isThing(value) ? value : '');
// A day, as an <input type="date"> writes it: 2026-11-09.
const dayFilter = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : '';
};
// A firmware version as it is written, or the start of one: 1.14 or 1.14.0+3.
// The boards of the Compare page: 1 to COMPARE_MAX board names, comma separated, none twice, in the order given.
export const COMPARE_MAX = 4;
function compareBoards(value) {
  const parts = value.split(',');
  if (parts.length > COMPARE_MAX || new Set(parts).size !== parts.length || !parts.every(isThing)) return '';
  return parts.join(',');
}

/** The address of the Compare page for these boards, or null if they are not 2 to COMPARE_MAX board names. */
export function compareHref(things) {
  if (!Array.isArray(things) || things.length < 2) return null;
  const boards = compareBoards(things.join(','));
  return boards === '' ? null : `#/compare?boards=${boards}`;
}

/** The boards the Compare page's address names, in its order: [] for none. */
export function compareThings(filters) {
  const boards = typeof filters?.boards === 'string' ? compareBoards(filters.boards) : '';
  return boards === '' ? [] : boards.split(',');
}
const versionFilter = (value) => (/^\d{1,3}(?:\.\d{1,5}){0,2}(?:\+\d{1,10})?$/.test(value) ? value : '');

/**
 * The kinds of the activity log, for its filter: each action of the log (AUDIT_ACTIONS) is in one, by the
 * start of its name. The API is asked for a kind's actions (GET /api/audit?actions=).
 */
export const ACTIVITY_KINDS = Object.freeze([
  { id: 'firmware', label: 'Firmware', starts: ['firmware.', 'pairing.'] },
  {
    id: 'deployments',
    label: 'Deployments and rollouts',
    starts: ['deployment.', 'rollout.', 'group.', 'fleet.', 'schedule.'],
  },
  { id: 'boards', label: 'Boards', starts: ['board.', 'serial.', 'device.', 'setup.'] },
  { id: 'people', label: 'Sign-ins, tokens and alerts', starts: ['account.', 'token.', 'alert.'] },
  { id: 'apps', label: 'Phone apps', starts: ['app.'] },
  { id: 'customers', label: 'Customers', starts: ['customer.', 'customer_action.'] },
  { id: 'database', label: 'Database exports', starts: ['db.'] },
  { id: 'reports', label: 'Weekly reports', starts: ['report.'] },
]);
export const ACTIVITY_OUTCOMES = Object.freeze(['ok', 'rejected', 'denied', 'error']);

/** The actions of a kind of the activity log, as the API names them; [] for no kind. */
export function activityActions(kind) {
  const found = ACTIVITY_KINDS.find((entry) => entry.id === kind);
  if (!found) return [];
  return Object.keys(AUDIT_ACTIONS).filter((action) => found.starts.some((start) => action.startsWith(start)));
}

// What the Events page can hide: the kinds of its events and of the board log, and the Console lane. Read when
// a filter is checked, since the lists are made further down.
const eventHidden = (value) => someOf([...new Set(['console', ...EVENT_KINDS, ...LINE_KINDS])])(value);

/** The filters of each page that has them: name -> how a value from the address is checked ('' for none). */
export const FILTERS = Object.freeze({
  devices: { q: searchText, status: oneOf(['online', 'offline', 'bluetooth', 'updating']), version: versionFilter },
  firmware: { q: searchText, status: oneOf(['active', 'revoked']) },
  deployments: { q: searchText, status: oneOf(['underway', 'ended']) },
  activity: {
    q: searchText,
    kind: oneOf(ACTIVITY_KINDS.map((kind) => kind.id)),
    outcome: oneOf(ACTIVITY_OUTCOMES),
    from: dayFilter,
    to: dayFilter,
  },
  events: {
    q: searchText,
    board: boardFilter,
    level: oneOf(['warn']),
    hide: eventHidden,
    tag: (value) => (LINE_TAGS.includes(value) ? value : ''),
    range: oneOf(['1h', '6h', '24h', '7d', '30d']),
  },
  tokens: { q: searchText, status: oneOf(['active', 'expired', 'revoked']) },
  customers: { q: searchText, status: oneOf(['invited', 'active', 'reset', 'disabled', 'gone']) },
  team: {
    q: searchText,
    tier: oneOf(['release-manager', 'viewer', 'none']),
    status: oneOf(['confirmed', 'pending', 'reset', 'disabled']),
  },
  memfault: { q: searchText, version: versionFilter },
  issues: { q: searchText, status: oneOf(['open', 'regressed', 'fixed']) },
  // Not a filter of a list: the boards of the Compare page, as many as it takes (compare.js).
  compare: { boards: compareBoards },
});

/** A page's filters from the address's query: every name of the page, '' where absent or not valid. */
export function readFilters(view, query = {}) {
  const spec = FILTERS[view] ?? {};
  const out = {};
  for (const [name, check] of Object.entries(spec)) {
    const value = typeof query?.[name] === 'string' ? query[name] : '';
    out[name] = value === '' ? '' : check(value);
  }
  return out;
}

/** How many of a page's filters are set, the search left out: for the Filters button's count. */
export function filtersSet(filters) {
  return Object.entries(filters ?? {}).filter(([name, value]) => name !== 'q' && value !== '').length;
}

/** Whether anything narrows the list: the search or any filter. */
export function filtering(filters) {
  return Object.values(filters ?? {}).some((value) => value !== '');
}

/** The hash of a page with its filters: routeHash, then ? and the set ones in the page's order, if any. */
export function filtersHash(route, filters) {
  const base = routeHash(route);
  const checked = readFilters(route?.view, filters);
  const set = Object.entries(checked).filter(([, value]) => value !== '');
  // Commas stay as they are: hide=log,console reads better than its escaped form, and means the same.
  return set.length === 0 ? base : `${base}?${new URLSearchParams(set).toString().replace(/%2C/g, ',')}`;
}

// Numbers and times as people read them.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// From this age on a time is told by its date, not by how long ago it was.
const DATED_FROM = 14 * DAY;

/** "3 min ago". Empty if there is no time. */
export function timeAgo(iso, nowMs) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const elapsed = nowMs - then;
  if (elapsed < 5 * SECOND) return 'just now';
  if (elapsed < MINUTE) return `${Math.floor(elapsed / SECOND)} s ago`;
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  if (elapsed < DATED_FROM) return `${Math.floor(elapsed / DAY)} d ago`;
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** True for a time that timeAgo() tells by its date. */
export function toldByDate(iso, nowMs) {
  const then = Date.parse(iso);
  return !Number.isNaN(then) && nowMs - then >= DATED_FROM;
}

/** The full local date and time, for a tooltip. */
export function exactTime(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  return new Date(then).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

/**
 * The time of day to write next to a relative time where the exact moment matters. A
 * tooltip cannot be reached with a keyboard or on a touch screen. Another day's time
 * says the day as well.
 */
export function clockTime(iso, nowMs) {
  const then = new Date(Date.parse(iso));
  if (Number.isNaN(then.getTime())) return '';
  const time = { hour: 'numeric', minute: '2-digit' };
  return then.toDateString() === new Date(nowMs).toDateString()
    ? then.toLocaleTimeString(undefined, time)
    : then.toLocaleString(undefined, { day: 'numeric', month: 'short', ...time });
}

/** The date and the time of day, for a time so old that "ago" says nothing. */
export function dateAndTime(iso) {
  const then = new Date(Date.parse(iso));
  if (Number.isNaN(then.getTime())) return '';
  return then.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The time of day alone, for an entry under a heading that already names its day. */
export function timeOfDay(iso) {
  const then = new Date(Date.parse(iso));
  if (Number.isNaN(then.getTime())) return '';
  return then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * The first and the last millisecond of a local day ("2026-11-01"), on this computer's clock: { fromMs,
 * toMs }, or null for no such day. A day on which the clocks change has 23 or 25 hours, not 24.
 */
export function localDayBounds(day) {
  const match = typeof day === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (match === null) return null;
  const [year, month, date] = match.slice(1).map(Number);
  const start = new Date(year, month - 1, date);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== date) return null;
  return { fromMs: start.getTime(), toMs: new Date(year, month - 1, date + 1).getTime() - 1 };
}

/** "Today", "Yesterday" or a date: the heading a log entry is filed under. */
export function dayLabel(iso, nowMs) {
  const then = new Date(Date.parse(iso));
  if (Number.isNaN(then.getTime())) return 'Undated';
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(new Date(nowMs)) - startOfDay(then)) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return then.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** A length of time: "42 s", "5 min", "2 h 14 min", "3 d 4 h". */
export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** A size in the binary units the flash layout is described in. */
export function fileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function exactBytes(bytes) {
  return Number.isFinite(bytes) ? `${bytes.toLocaleString('en-US')} bytes` : '';
}

/** Wi-Fi signal strength in words and as a number of bars out of four. */
export function signalQuality(rssi) {
  if (!Number.isFinite(rssi)) return null;
  if (rssi >= -55) return { bars: 4, label: 'Excellent' };
  if (rssi >= -67) return { bars: 3, label: 'Good' };
  if (rssi >= -75) return { bars: 2, label: 'Fair' };
  return { bars: 1, label: 'Weak' };
}

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

// Firmware images, as far as the browser looks at them.

const IMAGE_MAGIC = 0x96f3b83d;
const IMAGE_HEADER_SIZE = 32;

/**
 * Read the fixed MCUboot image header (all fields little endian): magic at 0, header
 * size at 8, payload size at 12, version at 20. This is a preview, so that a wrong
 * file is noticed before it is sent. The signature is checked by the server.
 */
export function readImageHeader(data) {
  const view = ArrayBuffer.isView(data)
    ? new DataView(data.buffer, data.byteOffset, data.byteLength)
    : new DataView(data);
  if (view.byteLength < IMAGE_HEADER_SIZE) {
    return { ok: false, message: 'The file is too small to be a firmware image.' };
  }
  if (view.getUint32(0, true) !== IMAGE_MAGIC) {
    return {
      ok: false,
      message: 'This is not an MCUboot image. Choose the *.signed.bin file from the build.',
    };
  }
  return {
    ok: true,
    headerSize: view.getUint16(8, true),
    payloadSize: view.getUint32(12, true),
    version: formatVersion({
      major: view.getUint8(20),
      minor: view.getUint8(21),
      revision: view.getUint16(22, true),
      build: view.getUint32(24, true),
    }),
  };
}

function hexOf(bytes) {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
}

/** SHA-256 of a file, as lowercase hex. */
export async function sha256Hex(data, subtle = globalThis.crypto.subtle) {
  return hexOf(new Uint8Array(await subtle.digest('SHA-256', data)));
}

/** Standard base64 with padding: the form the upload endpoint requires. */
export function toBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Free text as the API takes it: on one line, without control characters. A line break
 * or another control character becomes a space. Characters that cannot be seen, such
 * as the zero-width ones that come along with pasted text, are left out: the API
 * refuses a text that holds one.
 */
export function singleLine(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\p{C}/gu, '')
    .trim();
}

/** The name recorded for an upload: the file's name in the characters the API accepts. */
export function recordedFilename(name) {
  const cleaned = String(name ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(-64);
  return cleaned || 'image.signed.bin';
}

/**
 * What can be said about a chosen file before it is uploaded. `blocked` is set when the
 * file cannot be firmware for the board. `doomed` is set when the server is certain to
 * refuse it because of what is registered already, which only ever grows: the way on
 * is then another file. Everything else is left for the server to decide.
 */
export function reviewImage({ header, size, digest }, firmware) {
  const notes = [];
  if (!header.ok) return { blocked: true, notes: [{ tone: 'bad', text: header.message }] };

  const slot = firmware?.slotSize ?? null;
  let blocked = false;
  if (slot !== null && size > slot) {
    blocked = true;
    notes.push({ tone: 'bad', text: `Too large: the board’s slot holds ${exactBytes(slot)}.` });
  } else if (slot !== null) {
    notes.push({ tone: 'good', text: `Fits the board’s ${fileSize(slot)} slot.` });
  }

  if (header.version === '0.0.0+0') {
    notes.push({ tone: 'warn', text: 'Version 0.0.0+0 is never accepted. Give the build a version first.' });
    return { blocked, doomed: true, notes };
  }
  // Nothing is said about other releases until the list of them has arrived.
  if (!firmware) return { blocked, notes };

  const version = parseVersion(header.version);
  const same = firmware.releases.find((release) => release.sha256 === digest);
  const taken = firmware.releases.find((release) => release.version === header.version);
  const highest = firmware.releases.reduce((top, release) => {
    const parsed = parseVersion(release.version);
    return parsed && (!top || compareVersions(parsed, top) > 0) ? parsed : top;
  }, null);

  const top = highest ? formatVersion(highest) : '';
  const doomed = Boolean(same || taken || (highest && compareVersions(version, highest) <= 0));
  if (same) {
    notes.push({ tone: 'warn', text: `This exact file is already registered as ${same.version}.` });
  } else if (taken) {
    notes.push({
      tone: 'warn',
      text: `${taken.version} is already registered with different contents. A version can be used once.`,
    });
  } else if (highest && compareVersions(version, highest) <= 0) {
    notes.push({
      tone: 'warn',
      text: `Not newer than ${top}, the highest version registered so far. The server will refuse it.`,
    });
  } else if (highest) {
    notes.push({ tone: 'good', text: `Newer than every registered release (highest so far: ${top}).` });
  } else {
    notes.push({ tone: 'good', text: 'This will be the first release.' });
  }
  return { blocked, doomed, notes };
}

// Reading API replies. Every reply is rebuilt field by field; a reply whose outline is
// wrong is an error, a single odd value becomes null or a harmless default.

/** A failed request. `message` is the server's own wording whenever it sent one. */
export class ApiError extends Error {
  constructor(status, code, message, { requestId = null, details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

function unreadable() {
  return new ApiError(0, 'bad_response', 'The server sent a reply the console could not read.');
}

function unreachable() {
  return new ApiError(0, 'network', 'The server could not be reached. Check the connection.');
}

function tooSlow() {
  return new ApiError(0, 'timeout', 'The server did not answer in time.');
}

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw unreadable();
  return value;
}

function list(value) {
  if (!Array.isArray(value)) throw unreadable();
  return value;
}

function text(value, limit = 200) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function optionalText(value, limit = 200) {
  return typeof value === 'string' && value !== '' ? value.slice(0, limit) : null;
}

/** Text that originates on a board: printable ASCII only, and short. */
function boardText(value, limit = 96) {
  return typeof value === 'string' ? value.replace(/[^\x20-\x7e]/g, '?').slice(0, limit) : '';
}

function whole(value, least, most) {
  return Number.isInteger(value) && value >= least && value <= most ? value : null;
}

function instant(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function versionOrNull(value) {
  return isVersion(value) ? value : null;
}

/** The strings in a list, each cut to a sensible length; anything else in it is left out. */
function texts(value, limit = 64) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string').map((item) => item.slice(0, limit));
}

function person(value) {
  if (value === null || typeof value !== 'object') return null;
  return { sub: text(value.sub, 64), email: text(value.email, 254) };
}

// What a board reports beside its heartbeat (cloud/api/src/lib/shadow.mjs). Each is null
// when the board has not sent it, or when what arrived is not what the firmware sends.

const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;
const HEX = /^[0-9a-f]{1,8}$/;
const WORD = /^[a-z][a-z_]{0,31}$/;
const RESET_NAMES = [
  'pin',
  'software',
  'brownout',
  'power_on',
  'watchdog',
  'debugger',
  'security',
  'wake',
  'lockup',
  'parity',
  'pll',
  'clock',
  'hardware',
  'user',
  'temperature',
  'unknown',
];
export const BT_RESULTS = [
  'pending',
  'succeeded',
  'rolled_back',
  'not_installed',
  'trial_lost',
  'superseded',
  'flash_error',
];

function anObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStuck(value) {
  if (!anObject(value)) return null;
  const count = whole(value.count, 0, 2 ** 32);
  return count === null || typeof value.reason !== 'string' || !WORD.test(value.reason)
    ? null
    : { count, reason: value.reason };
}

function readDiag(value) {
  if (!anObject(value)) return null;
  const heap = anObject(value.heap)
    ? {
        free: whole(value.heap.free, 0, 2 ** 31),
        least: whole(value.heap.least, 0, 2 ** 31),
        size: whole(value.heap.size, 1, 2 ** 31),
      }
    : null;
  const usable =
    heap &&
    heap.free !== null &&
    heap.least !== null &&
    heap.size !== null &&
    heap.free <= heap.size &&
    heap.least <= heap.size;
  return {
    mac: typeof value.mac === 'string' && MAC.test(value.mac) ? value.mac : null,
    channel: whole(value.channel, 0, 233),
    heap: usable ? heap : null,
    at: instant(value.at),
  };
}

function readDiary(value) {
  if (!anObject(value) || !Array.isArray(value.entries)) return null;
  const boots = whole(value.boots, 0, 2 ** 32);
  if (boots === null) return null;
  const entries = value.entries
    .slice(0, 16)
    .filter(anObject)
    .map((entry) => ({
      version: versionOrNull(entry.version),
      cause: typeof entry.cause === 'string' && HEX.test(entry.cause) ? entry.cause : null,
      causes: texts(entry.causes, 16).filter((name) => RESET_NAMES.includes(name)),
      stage: whole(entry.stage, 0, 255),
    }))
    .filter((entry) => entry.version !== null && entry.cause !== null && entry.stage !== null);
  return { boots, entries };
}

function readBt(value) {
  if (!anObject(value)) return null;
  const from = versionOrNull(value.from);
  const to = versionOrNull(value.to);
  if (from === null || to === null || !BT_RESULTS.includes(value.result)) return null;
  return {
    from,
    to,
    result: value.result,
    proof: ['cloud', 'person'].includes(value.proof) ? value.proof : 'none',
    count: whole(value.count, 0, 2 ** 32) ?? 0,
  };
}

function readDevice(raw) {
  const item = record(raw);
  const fw =
    item.fw && typeof item.fw === 'object' && isVersion(item.fw.version)
      ? { version: item.fw.version, confirmed: item.fw.confirmed === true }
      : null;
  const ota =
    item.ota && typeof item.ota === 'object'
      ? {
          state: boardText(item.ota.state, 24) || 'idle',
          job: isDeploymentId(item.ota.job) ? item.ota.job : null,
          progress: whole(item.ota.progress, 0, 100) ?? 0,
          last: boardText(item.ota.last, 24) || 'none',
          error: boardText(item.ota.error, 64),
        }
      : null;
  return {
    thing: text(item.thing, 64),
    // From firmware 1.11.4. Shown beside the thing name, never in its place.
    name: isBoardName(item.name) ? item.name : null,
    // The name a release manager gave it in the console (cloud/api/src/lib/names.mjs). It leads where it is set.
    label: isBoardLabel(item.label) ? item.label : null,
    online: item.online === true,
    lastSeen: instant(item.lastSeen),
    fw,
    ota,
    rssi: whole(item.rssi, -127, 0),
    uptime: whole(item.uptime, 0, 2 ** 32),
    stuck: readStuck(item.stuck),
    diag: readDiag(item.diag),
    diary: readDiary(item.diary),
    bt: readBt(item.bt),
    // Where it is, from the Wi-Fi it hears (docs/fleet.md), and why it is not on the map if it is not.
    position: readPosition(item.position),
    location: readLocation(item.location),
  };
}

function readDevices(body) {
  const reply = record(body);
  return {
    devices: list(reply.devices)
      .map(readDevice)
      .filter((device) => device.thing !== ''),
    generatedAt: instant(reply.generatedAt),
  };
}

function readExecutionSummary(raw) {
  const item = record(raw);
  return {
    deployment: text(item.deployment, 64),
    version: versionOrNull(item.version),
    status: text(item.status, 24),
    queuedAt: instant(item.queuedAt),
    startedAt: instant(item.startedAt),
    lastUpdatedAt: instant(item.lastUpdatedAt),
  };
}

// A board's address in Memfault, as the server builds it from the organization's and the project's slugs.
const MEMFAULT_DEVICE_URL =
  /^https:\/\/app\.memfault\.com\/organizations\/[a-z0-9][a-z0-9-]{0,62}\/projects\/[a-z0-9][a-z0-9-]{0,62}\/devices\/cranium-[0-9a-f]{16}$/;

/**
 * What the server says of Memfault for a board (docs/memfault.md): whether a project key is stored in AWS,
 * whether the board's firmware sends Memfault's data (1.14.0 or later), and its page in Memfault, if the
 * console knows the slugs. Null from a server that says nothing of it.
 */
function readMemfault(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    keyStored: raw.keyStored === true,
    firmware: raw.firmware === true,
    url: typeof raw.url === 'string' && MEMFAULT_DEVICE_URL.test(raw.url) ? raw.url : null,
  };
}

function readDeviceDetail(body) {
  const reply = record(body);
  return {
    device: readDevice(reply.device),
    certificates: texts(list(reply.certificates)).map((id) => boardText(id)),
    executions: list(reply.executions).map(readExecutionSummary),
    // How many older updates the server left out of `executions`.
    olderExecutions: whole(reply.olderExecutions, 0, 2 ** 32) ?? 0,
    memfault: readMemfault(reply.memfault),
    // Its newest update however it came (GET /api/updates), from console 2.1.1; a server before it leaves it out.
    ...(Object.hasOwn(reply, 'lastUpdate')
      ? { lastUpdate: reply.lastUpdate ? readUpdate(reply.lastUpdate) : null }
      : {}),
  };
}

// The update history (GET /api/updates, docs/aws-iot.md "Update history"): every update of every board,
// a deployment's on each of its boards and those the boards reported themselves.

export const UPDATE_HOWS = Object.freeze(['deployment', 'bluetooth', 'usb_or_other']);
export const UPDATE_OUTCOMES = Object.freeze(['kept', 'rolled_back', 'not_installed', 'pending']);

/** One update as the server describes it. A way or an outcome this console does not know reads as the vaguest. */
export function readUpdate(raw) {
  const item = record(raw);
  const who =
    item.who && typeof item.who === 'object'
      ? { sub: text(item.who.sub, 128), email: text(item.who.email, 320), name: boardText(item.who.name, 32) }
      : null;
  return {
    id: text(item.id, 200),
    thing: isThing(item.thing) ? item.thing : '',
    from: versionOrNull(item.from),
    to: versionOrNull(item.to),
    how: UPDATE_HOWS.includes(item.how) ? item.how : 'usb_or_other',
    deployment: optionalText(item.deployment, 64),
    who,
    outcome: UPDATE_OUTCOMES.includes(item.outcome) ? item.outcome : 'pending',
    startedAt: instant(item.startedAt),
    endedAt: instant(item.endedAt),
    status: optionalText(item.status, 24),
  };
}

// A board's version timeline (GET /api/devices/{thing}/timeline, docs/compare.md): every version it ran,
// newest first, with how it came, whether it stayed, and its unexpected restarts and issues.

export const TIMELINE_ARRIVALS = Object.freeze(['ota', 'bluetooth', 'usb', 'rollback', 'setup']);
export const TIMELINE_STATUSES = Object.freeze(['confirmed', 'rolled_back', 'trial']);

/** One version's stay on a board. An arrival or a status this console does not know reads as the vaguest. */
export function readStay(raw) {
  const item = record(raw);
  return {
    version: versionOrNull(item.version),
    startedAt: instant(item.startedAt),
    endedAt: instant(item.endedAt),
    current: item.current === true,
    arrived: TIMELINE_ARRIVALS.includes(item.arrived) ? item.arrived : 'usb',
    deployment: isDeploymentId(item.deployment) ? item.deployment : null,
    status: TIMELINE_STATUSES.includes(item.status) ? item.status : 'trial',
    reboots: whole(item.reboots, 0, 1_000_000),
    issues: whole(item.issues, 0, 1_000_000),
    countedFrom: instant(item.countedFrom),
  };
}

function readTimeline(body) {
  const reply = record(body);
  return {
    thing: isThing(reply.thing) ? reply.thing : '',
    current: versionOrNull(reply.current),
    versions: list(reply.versions)
      .map(readStay)
      .filter((stay) => stay.version !== null),
    cursor: typeof reply.cursor === 'string' && CURSOR.test(reply.cursor) ? reply.cursor : null,
    countedFrom: instant(reply.countedFrom),
    generatedAt: instant(reply.generatedAt),
  };
}

function readUpdates(body) {
  const reply = record(body);
  return {
    updates: list(reply.updates)
      .map(readUpdate)
      .filter((update) => update.id !== '' && update.thing !== ''),
    cursor: typeof reply.cursor === 'string' && CURSOR.test(reply.cursor) ? reply.cursor : null,
    generatedAt: instant(reply.generatedAt),
  };
}

/**
 * How an update came, in the words of every client of this console (the phone apps have the same):
 * "over Bluetooth from Vihaan’s phone", "deployment <id>", "USB or another tool".
 */
export function updateHow(update) {
  if (update.how === 'bluetooth') {
    return update.who?.name ? `over Bluetooth from ${update.who.name}’s phone` : 'over Bluetooth from a phone';
  }
  if (update.how === 'deployment') return update.deployment ? `deployment ${update.deployment}` : 'deployment';
  return 'USB or another tool';
}

const UPDATE_OUTCOME_WORDS = Object.freeze({
  kept: { tone: 'good', icon: 'check-circle', label: 'Kept' },
  rolled_back: { tone: 'bad', icon: 'undo', label: 'Rolled back' },
  not_installed: { tone: 'warn', icon: 'minus-circle', label: 'Not installed' },
  pending: { tone: 'idle', icon: 'clock', label: 'Pending' },
});

/**
 * What a list of updates adds up to: { total, how: { deployment, bluetooth, usb_or_other },
 * outcome: { kept, rolled_back, not_installed, pending } }. The same sums the Deployments page and the Overview say.
 */
export function updateTotals(updates) {
  const totals = {
    total: updates.length,
    how: Object.fromEntries(UPDATE_HOWS.map((how) => [how, 0])),
    outcome: Object.fromEntries(UPDATE_OUTCOMES.map((outcome) => [outcome, 0])),
  };
  for (const update of updates) {
    totals.how[update.how] += 1;
    totals.outcome[update.outcome] += 1;
  }
  return totals;
}

/** The sums as a sentence: "12 updates: 9 by deployment, 2 over Bluetooth, 1 by USB or another tool; 10 kept, 1 rolled back." */
export function updateSummary(updates, cut = false) {
  const { total, how, outcome } = updateTotals(updates);
  if (total === 0) return 'No update has been reported yet.';
  const ways = [
    [how.deployment, 'by deployment'],
    [how.bluetooth, 'over Bluetooth'],
    [how.usb_or_other, 'by USB or another tool'],
  ]
    .filter(([count]) => count > 0)
    .map(([count, words]) => `${count} ${words}`);
  const ends = [
    [outcome.kept, 'kept'],
    [outcome.rolled_back, 'rolled back'],
    [outcome.not_installed, 'not installed'],
    [outcome.pending, 'pending'],
  ]
    .filter(([count]) => count > 0)
    .map(([count, words]) => `${count} ${words}`);
  return `${cut ? 'The newest ' : ''}${total} ${total === 1 ? 'update' : 'updates'}: ${ways.join(', ')}; ${ends.join(', ')}.`;
}

/** How an update ended, as a badge says it: { tone, icon, label }. */
export function describeOutcome(update) {
  return { ...(UPDATE_OUTCOME_WORDS[update.outcome] ?? UPDATE_OUTCOME_WORDS.pending) };
}

/** The time an update is told by: when it ended, or while it has not, when it started. */
export function updateTime(update) {
  return update.endedAt ?? update.startedAt;
}

function readRelease(raw) {
  const item = record(raw);
  let revoked = null;
  if (item.revoked && typeof item.revoked === 'object') {
    revoked = {
      by: person(item.revoked.by),
      at: instant(item.revoked.at),
      reason: text(item.revoked.reason, 200),
    };
    // When the server finished what follows the mark: the image refused, the open
    // deployments cancelled. Null until then. A server that does not record it leaves
    // the field out, and so does this.
    if (Object.hasOwn(item.revoked, 'enforcedAt')) revoked.enforcedAt = instant(item.revoked.enforcedAt);
  }
  return {
    version: text(item.version, 32),
    size: whole(item.size, 0, 2 ** 32),
    sha256: text(item.sha256, 64),
    imageHash: text(item.imageHash, 64),
    keyHash: text(item.keyHash, 64),
    payloadSize: whole(item.payloadSize, 0, 2 ** 32),
    headerSize: whole(item.headerSize, 0, 0xffff),
    loadAddress: whole(item.loadAddress, 0, 2 ** 32),
    filename: text(item.filename, 64),
    notes: text(item.notes, 500),
    uploadedBy: person(item.uploadedBy),
    uploadedAt: instant(item.uploadedAt),
    status: item.status === 'active' ? 'active' : 'revoked',
    revoked,
    // The board type the image is for (docs/fleet.md), where the server says: as with enforcedAt,
    // a server that does not leave it out here too.
    ...(Object.hasOwn(item, 'board') ? { board: BOARD_TYPES.includes(item.board) ? item.board : 'nrf7002dk' } : {}),
    // And the flash layout it is built for, the same way.
    ...(Object.hasOwn(item, 'layout') ? { layout: whole(item.layout, 1, 9999) ?? 1 } : {}),
  };
}

// Board types (cloud/api/src/lib/boards.mjs): what an image is for, and what a board is.
export const BOARD_TYPES = Object.freeze(['nrf7002dk', 'nrf5340dk']);
export const BOARD_LABELS = Object.freeze({ nrf7002dk: 'nRF7002 DK', nrf5340dk: 'nRF5340 DK' });
// No Wi-Fi: a release for these goes to a board from the phone app, never by a deployment.
export const BLUETOOTH_ONLY_TYPES = Object.freeze(['nrf5340dk']);

/**
 * The boards a release can be offered to by a deployment: those of its type and its flash layout
 * that can take a job. `types` is thing -> { type, layout, bluetoothOnly } from the fleet, or null
 * while it is not known, when every board is offered and the server decides (400 incompatible_board,
 * 400 incompatible_layout).
 */
export function offeredBoards(devices, types, release) {
  if (!types || !release) return devices;
  const board = release.board ?? 'nrf7002dk';
  const layout = release.layout ?? 1;
  return devices.filter((device) => {
    const known = types.get(device.thing);
    return !known || (known.type === board && (known.layout ?? 1) === layout && !known.bluetoothOnly);
  });
}

/**
 * What a release is compatible with, in words: "For nRF7002 DK · layout 1". Empty for a release from a
 * server that does not say.
 */
export function compatibilityWords(release) {
  if (!release?.board) return '';
  return `For ${boardTypeLabel(release.board)} · layout ${release.layout ?? 1}`;
}

/** "nRF5340 DK" for nrf5340dk; the type itself for one this console does not know. */
export function boardTypeLabel(type) {
  return BOARD_LABELS[type] ?? String(type ?? '');
}

function readFirmware(body) {
  const reply = record(body);
  return {
    releases: list(reply.releases).map(readRelease),
    fingerprint: text(reply.signingKey?.fingerprint, 64),
    slotSize: whole(reply.slotSize, 1, 2 ** 32),
  };
}

const COUNTS = ['queued', 'inProgress', 'succeeded', 'failed', 'rejected', 'canceled', 'timedOut', 'removed'];

function readDeploymentSummary(raw) {
  const item = record(raw);
  const counts = {};
  for (const name of COUNTS) counts[name] = whole(item.counts?.[name], 0, 1000) ?? 0;
  return {
    id: text(item.id, 64),
    version: versionOrNull(item.version),
    status: text(item.status, 32),
    createdAt: instant(item.createdAt),
    completedAt: instant(item.completedAt),
    createdBy: person(item.createdBy),
    note: text(item.note, 200),
    things: texts(item.things),
    counts,
  };
}

function readExecution(raw) {
  const item = record(raw);
  return {
    thing: text(item.thing, 64),
    status: text(item.status, 24),
    phase: text(item.phase, 32),
    progress: whole(item.progress, 0, 100),
    reason: boardText(item.reason, 48) || null,
    detail: boardText(item.detail, 96) || null,
    // What the job recorded when the board finished the update: history. See firmwareOf in
    // the API. Never the same thing as `reported`, the board's latest word, which an
    // execution that the board did not finish has instead.
    ranAtEnd: versionOrNull(item.ranAtEnd),
    reported: versionOrNull(item.reported),
    online: item.online === true,
    queuedAt: instant(item.queuedAt),
    startedAt: instant(item.startedAt),
    lastUpdatedAt: instant(item.lastUpdatedAt),
    secondsLeft: whole(item.secondsLeft, 0, 10 ** 7),
  };
}

function readDeployment(raw) {
  const executions = list(raw.executions)
    .map(readExecution)
    .filter((execution) => execution.thing !== '');
  return { ...readDeploymentSummary(raw), executions };
}

function readDeployments(body) {
  const deployments = list(record(body).deployments).map(readDeploymentSummary);
  return deployments.filter((deployment) => deployment.id !== '');
}

function readAuditEntry(raw) {
  const item = record(raw);
  const detail = [];
  if (item.detail && typeof item.detail === 'object' && !Array.isArray(item.detail)) {
    for (const [key, value] of Object.entries(item.detail).slice(0, 8)) {
      if (typeof value === 'string' || typeof value === 'number') {
        // As long as the API stores a value: a reason is kept whole.
        detail.push([text(key, 24), text(String(value), 200)]);
      }
    }
  }
  return {
    at: instant(item.at),
    actor: person(item.actor),
    action: text(item.action, 48),
    target: text(item.target, 96),
    outcome: text(item.outcome, 24),
    detail,
    requestId: text(item.requestId, 64),
    // An entry of what a customer did on the customer site (cloud/api/src/lib/audit.mjs).
    ...(item.by === 'customer' && String(item.action).startsWith('customer_action.') ? { by: 'customer' } : {}),
    // What changed, before and after: only on an entry that recorded it (docs/audit-diff.md).
    ...readChanges(item),
  };
}

/** An entry's changes as the API keeps them: at most 12 of a field and two values, each text or null. */
function readChanges(item) {
  if (!Array.isArray(item.changes)) return {};
  const changes = item.changes
    .slice(0, 12)
    .map(record)
    .filter((change) => typeof change.field === 'string' && change.field !== '')
    .map((change) => ({
      field: text(change.field, 32),
      from: typeof change.from === 'string' ? text(change.from, 200) : null,
      to: typeof change.to === 'string' ? text(change.to, 200) : null,
      ...(change.hidden === true ? { hidden: true } : {}),
    }));
  const omitted = Number.isSafeInteger(item.changesOmitted) && item.changesOmitted > 0 ? item.changesOmitted : 0;
  return omitted > 0 ? { changes, changesOmitted: omitted } : { changes };
}

function readAudit(body) {
  const reply = record(body);
  const read = Number.isInteger(reply.read) && reply.read >= 0 ? reply.read : null;
  return {
    entries: list(reply.entries).map(readAuditEntry),
    next: typeof reply.next === 'string' && CURSOR.test(reply.next) ? reply.next : null,
    // A search's: how many entries the server read for this page, matching or not.
    ...(read === null ? {} : { read }),
  };
}

// The event log of the boards (cloud/api/src/handlers/events.mjs).

export const EVENT_KINDS = Object.freeze(['connection', 'firmware', 'update', 'restart', 'bluetooth', 'health']);
const EVENT_ID = /^[0-9a-f]{6}$/;
const UPDATE_STATES = ['idle', 'awaiting_user', 'downloading', 'verifying', 'rebooting', 'testing', 'bluetooth'];
// The typed fields an event may carry, each with how it is read.
const EVENT_FIELDS = {
  version: versionOrNull,
  from: versionOrNull,
  to: versionOrNull,
  confirmed: (value) => (typeof value === 'boolean' ? value : null),
  job: (value) => (isDeploymentId(value) ? value : null),
  state: (value) => (UPDATE_STATES.includes(value) ? value : null),
  progress: (value) => whole(value, 0, 100),
  result: (value) => (typeof value === 'string' && WORD.test(value) ? value : null),
  error: (value) => boardText(value, 64) || null,
  upFor: (value) => whole(value, 0, 2 ** 32),
  cause: (value) => (typeof value === 'string' && HEX.test(value) ? value : null),
  stage: (value) => whole(value, 0, 255),
  boots: (value) => whole(value, 0, 2 ** 32),
  newBoots: (value) => whole(value, 1, 2 ** 32),
  count: (value) => whole(value, 0, 2 ** 32),
  reason: (value) => (typeof value === 'string' && /^[A-Za-z][A-Za-z_]{0,47}$/.test(value) ? value : null),
  proof: (value) => (typeof value === 'string' && WORD.test(value) ? value : null),
  channel: (value) => whole(value, 1, 233),
  before: (value) => whole(value, 1, 233),
  heapLeast: (value) => whole(value, 0, 2 ** 31),
  heapSize: (value) => whole(value, 1, 2 ** 31),
  name: (value) => (isBoardName(value) ? value : null),
  nameBefore: (value) => (isBoardName(value) ? value : null),
};

/** One event, or null for one that cannot be shown: no board, no time or no kind the console knows. */
function readEvent(raw) {
  if (!anObject(raw) || !isThing(raw.thing) || instant(raw.at) === null || !EVENT_KINDS.includes(raw.kind)) return null;
  const event = {
    thing: raw.thing,
    at: raw.at,
    id: typeof raw.id === 'string' && EVENT_ID.test(raw.id) ? raw.id : '000000',
    kind: raw.kind,
    what: boardText(raw.what, 24),
    level: raw.level === 'warn' ? 'warn' : 'info',
    text: boardText(raw.text, 200),
  };
  for (const [name, read] of Object.entries(EVENT_FIELDS)) {
    const value = Object.hasOwn(raw, name) ? read(raw[name]) : null;
    if (value !== null) event[name] = value;
  }
  return event;
}

function readEvents(body) {
  const reply = record(body);
  return {
    events: list(reply.events)
      .map(readEvent)
      .filter((event) => event !== null),
    cursor: typeof reply.cursor === 'string' && CURSOR.test(reply.cursor) ? reply.cursor : null,
    from: instant(reply.from),
    to: instant(reply.to),
  };
}

// The boards' own log, line by line, from firmware 1.12.0 (cloud/api/src/lib/lines.mjs). Each line
// has a kind, as an event does, and the source it came from on the board's console, its tag.

export const LINE_KINDS = Object.freeze(['bluetooth', 'update', 'restart', 'health', 'setting', 'log']);
export const LINE_TAGS = Object.freeze([
  'BT',
  'WIFI',
  'STUCK',
  'CONSOLE',
  // A board's answer to a command from the console (identify, report), from firmware 1.13.0.
  'CMD',
  'app',
  'boot_diary',
  'bt_ota',
  'cloud',
  'factory',
  'health',
  'identity',
  'location',
  'net',
  'ota',
  'store',
  'stuck',
  'ui',
]);
const LINE_ID = /^(0|[1-9]\d{0,9})\.([1-9]\d{0,9})$/;

/** One line of a board's log, or null for one that cannot be shown. */
function readLine(raw) {
  if (
    !anObject(raw) ||
    !isThing(raw.thing) ||
    instant(raw.at) === null ||
    !LINE_KINDS.includes(raw.kind) ||
    !LINE_TAGS.includes(raw.tag) ||
    typeof raw.id !== 'string' ||
    !LINE_ID.test(raw.id)
  ) {
    return null;
  }
  return {
    thing: raw.thing,
    at: raw.at,
    id: raw.id,
    kind: raw.kind,
    tag: raw.tag,
    level: raw.level === 'warn' ? 'warn' : 'info',
    text: boardText(raw.text, 160),
    boot: whole(raw.boot, 0, 2 ** 32 - 1),
    seq: whole(raw.seq, 1, 2 ** 32 - 1),
    dropped: whole(raw.dropped, 1, 2 ** 32 - 1),
  };
}

function readLines(body) {
  const reply = record(body);
  return {
    lines: list(reply.lines)
      .map(readLine)
      .filter((line) => line !== null),
    cursor: typeof reply.cursor === 'string' && CURSOR.test(reply.cursor) ? reply.cursor : null,
    from: instant(reply.from),
    to: instant(reply.to),
  };
}

function readSamples(body) {
  const reply = record(body);
  return {
    samples: list(reply.samples)
      .filter(anObject)
      .map((sample) => ({
        at: instant(sample.at),
        rssi: whole(sample.rssi, -127, 0),
        uptime: whole(sample.uptime, 0, 2 ** 32),
        heapFree: whole(sample.heapFree, 0, 2 ** 31),
        heapLeast: whole(sample.heapLeast, 0, 2 ** 31),
      }))
      .filter((sample) => sample.at !== null),
    hours: whole(reply.hours, 1, 168) ?? 24,
    bucketSeconds: whole(reply.bucketSeconds, 0, 86400) ?? 0,
    from: instant(reply.from),
    to: instant(reply.to),
  };
}

function readMe(body) {
  const reply = record(body);
  return {
    sub: text(reply.sub, 64),
    email: text(reply.email, 254),
    groups: texts(reply.groups),
    canWrite: reply.canWrite === true,
    // The console's own version and the commit it was built from (cloud/VERSION, docs/versions.md), or null.
    console: {
      version: /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(reply.console?.version ?? '') ? reply.console.version : null,
      commit: /^[0-9a-f]{40}$/.test(reply.console?.commit ?? '') ? reply.console.commit : null,
    },
  };
}

// Personal API tokens (cloud/api/src/handlers/tokens.mjs). The page shows a token once,
// in the answer that made it; the list never holds one.

const TOKEN = /^crn_[A-Za-z0-9_-]{43}$/;
const TOKEN_ID = /^[0-9a-f]{16}$/;
const TOKEN_STATES = ['active', 'expired', 'revoked'];
export const TOKEN_NAME_LIMIT = 40;
export const TOKEN_DAYS = Object.freeze({ least: 1, most: 90, usual: 30 });

export function isTokenId(value) {
  return typeof value === 'string' && TOKEN_ID.test(value);
}

function readToken(raw) {
  const item = record(raw);
  return {
    id: isTokenId(item.id) ? item.id : '',
    name: text(item.name, TOKEN_NAME_LIMIT),
    createdAt: instant(item.createdAt),
    expiresAt: instant(item.expiresAt),
    revokedAt: instant(item.revokedAt),
    // The server's word, for its own clock. Anything else is taken for the end of it.
    status: TOKEN_STATES.includes(item.status) ? item.status : 'expired',
  };
}

function readTokens(body) {
  const reply = record(body);
  return {
    tokens: list(reply.tokens)
      .map(readToken)
      .filter((token) => token.id !== ''),
    limit: whole(reply.limit, 1, 1000) ?? 10,
    maxDays: whole(reply.maxDays, 1, 3650) ?? TOKEN_DAYS.most,
  };
}

/** The answer to making a token: the token itself, once, and what it is called. */
function readNewToken(body) {
  const reply = record(body);
  if (typeof reply.token !== 'string' || !TOKEN.test(reply.token) || !isTokenId(reply.id)) throw unreadable();
  return {
    token: reply.token,
    id: reply.id,
    name: text(reply.name, TOKEN_NAME_LIMIT),
    createdAt: instant(reply.createdAt),
    expiresAt: instant(reply.expiresAt),
  };
}

/**
 * Whether a number of days is one the server takes for a token's life: a whole number
 * from 1 to 90. The field gives text; anything else is null.
 */
export function tokenDays(value) {
  const textValue = String(value ?? '').trim();
  if (!/^\d{1,3}$/.test(textValue)) return null;
  const days = Number(textValue);
  return days >= TOKEN_DAYS.least && days <= TOKEN_DAYS.most ? days : null;
}

/** Boards the server named when it refused a deployment because they are busy. */
export function busyBoards(error) {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return [];
  return error.details
    .filter((entry) => entry && isThing(entry.thing))
    .map(({ thing, deployment }) => ({ thing, deployment: isDeploymentId(deployment) ? deployment : null }));
}

// What a failed request means for what happens next.

/**
 * True for a refusal: the server understood the request and said no (a 4xx reply), so
 * nothing was changed. After any other failure the change may have been made.
 */
export function isRefusal(error) {
  return error.status >= 400 && error.status < 500;
}

/**
 * Whether the page has to be read again after a change failed. A refusal changed
 * nothing, but a conflict (409) says that what the page shows is out of date; after a
 * failure that is not a refusal the change may have gone through.
 */
export function staleAfter(error) {
  return !isRefusal(error) || error.status === 409;
}

/**
 * Whether sending the same file once more could end differently. A refusal of the
 * image cannot; being throttled, or meeting another upload at the same moment, can.
 */
export function canRetryUpload(error) {
  return !isRefusal(error) || error.status === 429 || error.code === 'upload_conflict';
}

/**
 * What the server checks before it stores an image, in the order it does so
 * (cloud/api/src/lib/mcuboot.mjs and handlers/firmware.mjs). It answers 201 only when
 * all of them passed, and otherwise names the first that did not, by its code.
 */
export const IMAGE_CHECKS = Object.freeze([
  {
    name: 'Image format',
    passed: 'It is an MCUboot image, and it fits the board’s update slot.',
    codes: ['not_an_image', 'too_small', 'too_large', 'bad_magic', 'bad_header', 'truncated'],
  },
  {
    name: 'Flash layout',
    passed: 'It was built for this product’s flash layout.',
    codes: ['unsupported_flags', 'wrong_target'],
  },
  {
    name: 'Signature area',
    passed: 'Its signature area is well formed, with nothing after it.',
    codes: ['malformed_tlv', 'unexpected_tlv', 'trailing_data', 'unsigned'],
  },
  {
    name: 'Image hash',
    passed: 'The image matches its own SHA-256 hash, so the file is not damaged.',
    codes: ['hash_mismatch'],
  },
  { name: 'Signing key', passed: 'It is signed with this project’s key.', codes: ['wrong_key'] },
  {
    name: 'Signature',
    passed: 'Its ECDSA P-256 signature is valid.',
    codes: ['bad_signature', 'bad_signature_encoding'],
  },
  {
    name: 'Version',
    passed: 'Its version is newer than every release before it.',
    passedFirst: 'Its version has a number, and no release came before it.',
    codes: ['version_zero', 'version_exists', 'version_not_newer'],
  },
]);

/** The name of the check that an image failed, from the code of the server's refusal. Null if it names none. */
export function failedCheck(code) {
  return IMAGE_CHECKS.find((check) => check.codes.includes(code))?.name ?? null;
}

/** A message as a sentence: some of the server's come without their full stop. */
export function sentence(message) {
  const words = String(message ?? '').trim();
  return words === '' || /[.!?…]$/.test(words) ? words : `${words}.`;
}

// What the signature check says when an image is laid out differently from what it
// expects: true, but in terms of the file format. A person who signed with the wrong
// kind of key has to be told what to change.
const SIGNED_WRONGLY =
  'This image is not signed the way this project requires: an ECDSA P-256 ' +
  'signature, with a hash of the public key. Sign it with the project’s imgtool settings.';
const PLAIN_WORDS = {
  unexpected_tlv: SIGNED_WRONGLY,
  malformed_tlv: 'The signature area of this image cannot be read. Build and sign it again.',
  bad_signature_encoding: 'The signature in this image cannot be read. Build and sign it again.',
};

/** What to say about a failed request: the server's wording, unless it is written in jargon. */
export function plainMessage(error) {
  return entryOf(PLAIN_WORDS, error.code) ?? error.message;
}

/**
 * What to say once a deployment has been cancelled. `withdrawn`: it was cancelled before,
 * so that stopping the boards is all this did. What a cancellation does to a board takes
 * effect later, so it is told as what was asked for, not as what has happened.
 */
export function cancelNotice({ force, withdrawn, started }) {
  if (withdrawn) return 'Stop requested. Boards that had started have been asked to stop.';
  if (force) {
    return started > 0
      ? 'Cancelled. Boards that had started have been asked to stop.'
      : 'Cancelled. Boards that had not started are no longer offered this update.';
  }
  return started > 0
    ? `Cancelled. ${plural(started, 'board that had started carries', 'boards that had started carry')} on.`
    : 'Cancelled. Boards that had not started are no longer offered this update.';
}

// Revoking. Marking a release revoked is the first of three steps. Refusing its image
// and cancelling its deployments follow, and the server records when they are done. A
// request that fails or is cut off in between leaves a release that reads "revoked"
// with work outstanding; revoking it again completes that work.

/**
 * Where the revocation of a release stands; null for a release that is not revoked:
 * 'complete' with the server's record of completion, 'incomplete' without it, and
 * 'unknown' for a server that keeps no such record.
 */
export function revocationState(release) {
  if (release.status === 'active') return null;
  const mark = release.revoked;
  if (mark?.enforcedAt) return 'complete';
  return mark && Object.hasOwn(mark, 'enforcedAt') ? 'incomplete' : 'unknown';
}

/**
 * True for the reply to a revocation that found the release revoked already. The
 * server goes through the steps after the mark before it answers so; the reply
 * therefore says that the image is refused and that no deployment of the release is
 * open, which is what was asked for.
 */
export function revocationInPlace(error) {
  return error instanceof ApiError && error.status === 409 && error.code === 'already_revoked';
}

/**
 * That boards report a release that was just revoked. What an offline board runs is only
 * what it last reported, and may no longer be so.
 *
 * @param {{thing: string, name: string|null, online: boolean}[]} boards
 */
export function stillRunning(boards) {
  const heard = boards.filter((board) => board.online).length;
  const quiet = boards.length - heard;
  const who =
    boards.length === 1
      ? `${boardName(boards[0])} ${heard === 1 ? 'still runs it' : 'last reported running it'}`
      : [
          heard > 0 ? plural(heard, 'board still runs it', 'boards still run it') : null,
          quiet > 0 ? `${plural(quiet, 'board')} last reported running it` : null,
        ]
          .filter(Boolean)
          .join(' and ');
  return `${who}; to replace it there, upload a newer version and deploy that.`;
}

/**
 * What to say once a revocation has gone through.
 *
 * @param {string} version
 * @param {object} result
 * @param {string[]|null} result.cancelled  the deployments it cancelled; null when the
 *                                          server only said that all is in place
 * @param {boolean} result.again            the release was revoked before this request
 * @param {{thing: string, online: boolean}[]} [result.running]  the boards that report it
 */
export function revocationNotice(version, { cancelled, again, running = [] }) {
  const still = running.length > 0 ? ` ${stillRunning(running)}` : '';
  if (cancelled === null) {
    return `${
      again
        ? `The revocation of ${version} is in place: its image is refused and no deployment of it is open.`
        : `${version} was revoked already, and that revocation is in place.`
    }${still}`;
  }
  const lead = again ? `The revocation of ${version} is in place.` : `Revoked ${version}.`;
  if (cancelled.length === 0) return `${lead} No deployment of it was still open.${still}`;
  const stopped = plural(cancelled.length, 'unfinished deployment was', 'unfinished deployments were');
  return `${lead} ${stopped} cancelled.${still}`;
}

function errorFrom(status, payload) {
  const error = payload?.error;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message !== '') {
    return new ApiError(status, text(error.code, 64) || 'error', text(error.message, 400), {
      requestId: optionalText(error.requestId, 64),
      details: Array.isArray(error.details) ? error.details.slice(0, 25) : null,
    });
  }
  // API Gateway answers some requests itself, as { "message": "..." }.
  if (typeof payload?.message === 'string' && payload.message !== '') {
    return new ApiError(status, 'gateway', `${text(payload.message, 200)} (HTTP ${status}).`);
  }
  return new ApiError(status, 'http', `The server answered with HTTP ${status}.`);
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// Time. Relative times compare a server timestamp with "now", so a wrong clock on this
// computer would make a board look offline or a session look expired. The Date header
// of API replies is used to notice a clock that is off by more than a few seconds.

const CLOCK_TOLERANCE_MS = 5000;

export function createClock(read = () => Date.now()) {
  let offset = 0;
  return {
    now: () => read() + offset,
    observe(dateHeader) {
      const server = Date.parse(dateHeader ?? '');
      if (Number.isNaN(server)) return;
      const difference = server - read();
      offset = Math.abs(difference) > CLOCK_TOLERANCE_MS ? difference : 0;
    },
  };
}

// The proof of a password that Cognito asks for: SRP, as Cognito does it.
//
// On the console's own sign-in page the password never leaves the browser. Cognito's
// USER_SRP_AUTH is SRP-6a (RFC 5054) with choices of its own, which are those of its
// JavaScript library (amazon-cognito-identity-js, AuthenticationHelper.js) and of the
// independent pycognito; both were read for this, and the tests check every step against
// a server written apart from this code:
//
// - N is the 3072-bit prime of RFC 3526 (group 15), and g = 2.
// - A number is hashed as its shortest big-endian bytes with room for a sign, the way
//   Java writes a BigInteger: a 00 byte in front when the top bit is set. It is not
//   padded to the length of N, as RFC 5054 would have it.
// - k = H(N | g), u = H(A | B), x = H(salt | H(poolName | userId | ":" | password)), where
//   poolName is the part of the pool ID after the underscore and userId is the
//   USER_ID_FOR_SRP that Cognito sends back, not the address that was typed.
// - S = (B - k * g^x) ^ (a + u * x) mod N.
// - The key is the first 16 bytes of HKDF-SHA-256 (RFC 5869) with S as the input, u as
//   the salt and "Caldera Derived Key" as the info.
// - The claim is HMAC-SHA-256 under that key of poolName | userId | the bytes of
//   SECRET_BLOCK | the time, written as "Mon Nov 2 03:04:05 UTC 2026": English names, the
//   day without a leading zero, hours, minutes and seconds in UTC with two digits each.
//
// a is 128 random bytes from the CSPRNG and lives for one sign-in, in memory.

const SRP_N = BigInt(
  `0x${[
    'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1',
    '29024E088A67CC74020BBEA63B139B22514A08798E3404DD',
    'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245',
    'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED',
    'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D',
    'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F',
    '83655D23DCA3AD961C62F356208552BB9ED529077096966D',
    '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B',
    'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9',
    'DE2BCBF6955817183995497CEA956AE515D2261898FA0510',
    '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64',
    'ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7',
    'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B',
    'F12FFA06D98A0864D87602733EC86A64521F2B18177B200C',
    'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31',
    '43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF',
  ].join('')}`
);
const SRP_G = 2n;
const SRP_INFO = 'Caldera Derived Key';
const SRP_KEY_BYTES = 16;
const SRP_SECRET_BYTES = 128;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// What Cognito sends in its challenge, checked before it is used.
const SRP_NUMBER = /^[0-9a-fA-F]{1,1024}$/;
const SRP_BLOCK = /^[A-Za-z0-9+/]{1,8192}={0,2}$/;
const SRP_USER = /^[^\s:]{1,128}$/;

/** The prime and the generator, for the tests. */
export const SRP_GROUP = Object.freeze({ N: SRP_N, g: SRP_G });

/** A whole number as Cognito hashes it, in hex: its shortest bytes with room for a sign. */
export function srpHex(value) {
  if (typeof value !== 'bigint' || value < 0n) throw new RangeError('Only a whole number of 0 or more');
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  else if (/^[89a-f]/.test(hex)) hex = `00${hex}`;
  return hex;
}

function bytesOfHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesOfBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function joined(...parts) {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

const utf8 = (text) => new TextEncoder().encode(text);
const numberOf = (bytes) => BigInt(`0x${hexOf(bytes) || '0'}`);

/** base^exponent mod modulus, for whole numbers; the base may be negative. */
export function modPow(base, exponent, modulus) {
  let result = 1n;
  let square = ((base % modulus) + modulus) % modulus;
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    if (rest & 1n) result = (result * square) % modulus;
    square = (square * square) % modulus;
  }
  return result;
}

/** The time as Cognito wants it in a PASSWORD_VERIFIER answer. */
export function cognitoTimestamp(ms) {
  const at = new Date(ms);
  const two = (value) => String(value).padStart(2, '0');
  return (
    `${WEEKDAYS[at.getUTCDay()]} ${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()} ` +
    `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} UTC ${at.getUTCFullYear()}`
  );
}

async function sha256(subtle, bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

/** H of numbers written one after the other, as a number. */
async function hashOfNumbers(subtle, ...values) {
  return numberOf(await sha256(subtle, joined(...values.map((value) => bytesOfHex(srpHex(value))))));
}

/** The first 16 bytes of HKDF-SHA-256 (RFC 5869). */
export async function srpKey(subtle, input, salt, info = utf8(SRP_INFO)) {
  const key = await subtle.importKey('raw', input, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, SRP_KEY_BYTES * 8));
}

/**
 * The browser's half of an SRP exchange: a secret a and the A that goes to Cognito.
 *
 * @param {object} crypto  getRandomValues
 */
export function startSrp(crypto) {
  const a = numberOf(crypto.getRandomValues(new Uint8Array(SRP_SECRET_BYTES)));
  const A = modPow(SRP_G, a, SRP_N);
  // Only a broken random source gets here.
  if (a === 0n || A % SRP_N === 0n) throw new Error('No usable random number for the sign-in.');
  return { a, A };
}

/**
 * The PASSWORD_CLAIM_SIGNATURE for Cognito's PASSWORD_VERIFIER challenge: proof that this
 * browser knows the password, made without sending it. Throws if what Cognito sent
 * cannot be used.
 *
 * @param {object} options
 * @param {object} options.subtle      WebCrypto
 * @param {string} options.userPoolId  such as "us-east-1_AbC123"
 * @param {string} options.userId      USER_ID_FOR_SRP
 * @param {string} options.password
 * @param {bigint} options.a           from startSrp
 * @param {bigint} options.A
 * @param {string} options.srpB        SRP_B, hex
 * @param {string} options.salt        SALT, hex
 * @param {string} options.secretBlock SECRET_BLOCK, base64
 * @param {string} options.timestamp   from cognitoTimestamp
 */
export async function srpClaim({ subtle, userPoolId, userId, password, a, A, srpB, salt, secretBlock, timestamp }) {
  if (!SRP_NUMBER.test(srpB) || !SRP_NUMBER.test(salt) || !SRP_BLOCK.test(secretBlock) || !SRP_USER.test(userId)) {
    throw new Error('Cognito sent a challenge that cannot be used.');
  }
  const B = BigInt(`0x${srpB}`);
  if (B % SRP_N === 0n) throw new Error('Cognito sent a challenge that cannot be used.');
  const u = await hashOfNumbers(subtle, A, B);
  if (u === 0n) throw new Error('Cognito sent a challenge that cannot be used.');
  const k = await hashOfNumbers(subtle, SRP_N, SRP_G);
  const poolName = userPoolId.slice(userPoolId.indexOf('_') + 1);
  const inner = await sha256(subtle, utf8(`${poolName}${userId}:${password}`));
  const x = numberOf(await sha256(subtle, joined(bytesOfHex(srpHex(BigInt(`0x${salt}`))), inner)));
  const S = modPow(B - k * modPow(SRP_G, x, SRP_N), a + u * x, SRP_N);
  const key = await srpKey(subtle, bytesOfHex(srpHex(S)), bytesOfHex(srpHex(u)));
  const hmac = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = joined(utf8(poolName), utf8(userId), bytesOfBase64(secretBlock), utf8(timestamp));
  return toBase64(new Uint8Array(await subtle.sign('HMAC', hmac, message)));
}

// The six boxes of an authenticator code. What a key, a typed digit, a paste or the
// browser filling in the code does to them; the page draws the result.

export const CODE_LENGTH = 6;

/** Whether every box holds a digit. */
export function codeComplete(digits) {
  return digits.length === CODE_LENGTH && digits.every((digit) => /^\d$/.test(digit));
}

/**
 * `text` arrived in box `index`: typed, pasted or filled in by the browser. Only digits
 * count. A whole code goes into all six boxes, wherever it arrived, with or without a
 * space in the middle; fewer digits go into this box and the ones after it. Text without
 * a digit changes nothing, and an emptied box is empty.
 *
 * @returns {{digits: string[], focus: number}}  the boxes, and the box to go to
 */
export function enterCode(digits, index, text) {
  const next = [...digits];
  const given = String(text ?? '');
  const typed = given.replace(/\D/g, '');
  if (typed === '') {
    if (given === '') next[index] = '';
    return { digits: next, focus: index };
  }
  if (typed.length >= CODE_LENGTH) {
    return { digits: [...typed.slice(0, CODE_LENGTH)], focus: CODE_LENGTH - 1 };
  }
  let at = index;
  for (const digit of typed) {
    if (at >= CODE_LENGTH) break;
    next[at] = digit;
    at += 1;
  }
  return { digits: next, focus: Math.min(at, CODE_LENGTH - 1) };
}

/**
 * A key pressed in box `index`, or null for a key the boxes leave to the browser.
 * Backspace empties the box, or, in an empty box, the one before it, and goes there.
 */
export function keyInCode(digits, index, key) {
  const next = [...digits];
  switch (key) {
    case 'Backspace':
      if (next[index] !== '' || index === 0) {
        next[index] = '';
        return { digits: next, focus: index };
      }
      next[index - 1] = '';
      return { digits: next, focus: index - 1 };
    case 'Delete':
      next[index] = '';
      return { digits: next, focus: index };
    case 'ArrowLeft':
      return { digits: next, focus: Math.max(0, index - 1) };
    case 'ArrowRight':
      return { digits: next, focus: Math.min(CODE_LENGTH - 1, index + 1) };
    case 'Home':
      return { digits: next, focus: 0 };
    case 'End':
      return { digits: next, focus: CODE_LENGTH - 1 };
    default:
      return null;
  }
}

// What went wrong with a sign-in on the console's own page, in words. Never Cognito's
// own message: the same words whether the account exists or not.

export const SIGN_IN_WORDS = Object.freeze({
  'wrong-password': 'The e-mail address or password is wrong.',
  'wrong-code': 'That code is not right. Try the next one from your authenticator app.',
  expired: 'The sign-in took too long, so it starts again. Enter your password once more.',
  'too-many': 'Too many tries. Wait a minute.',
  network: 'The sign-in service could not be reached. Check the connection and try again.',
  failed: 'Signing in did not work. Try again, or use the AWS sign-in page.',
  missing: 'Enter your e-mail address and your password.',
  'short-code': 'Type all six digits of the code.',
  // A new password chosen on the page itself (the customer site, docs/customer-site.md).
  'weak-password': 'That password is not accepted. Choose one of at least 10 characters.',
  'missing-new': 'Choose a new password and type it twice.',
});

/** What Cognito's error answer is called, such as NotAuthorizedException; '' if it does not say. */
export function cognitoErrorName(reply, header = null) {
  const raw = typeof reply?.__type === 'string' ? reply.__type : String(header ?? '');
  const name = raw.split('#').pop().split(':')[0];
  return /^[A-Za-z]{1,64}$/.test(name) ? name : '';
}

/**
 * What an error of Cognito's means for a sign-in at `step` ('password' or 'code'): one of
 * SIGN_IN_WORDS, or 'elsewhere' for what only the AWS sign-in page can do. After the
 * password, NotAuthorizedException is Cognito ending the sign-in: its session is over.
 */
export function signInProblem(name, step) {
  switch (name) {
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      return step === 'code' || step === 'new-password' ? 'expired' : 'wrong-password';
    case 'InvalidPasswordException':
      return step === 'new-password' ? 'weak-password' : 'failed';
    case 'CodeMismatchException':
      return step === 'code' ? 'wrong-code' : 'failed';
    case 'ExpiredCodeException':
      return 'expired';
    case 'TooManyRequestsException':
    case 'LimitExceededException':
    case 'TooManyFailedAttemptsException':
      return 'too-many';
    case 'PasswordResetRequiredException':
      return 'elsewhere';
    default:
      return 'failed';
  }
}

// Sign-in. There are two ways, and both end with the same session in the tab.
//
// The console's own page asks for the e-mail address, the password and the code, and
// talks to Cognito's user pool API (USER_SRP_AUTH, then the code). The password stays in
// the browser (above). Cognito's session for the step of the code is kept in memory only.
//
// The AWS sign-in page is OAuth 2.0 authorization code with PKCE against the managed
// login pages. One sign-in keeps its state and its PKCE verifier in sessionStorage until
// the login page sends the browser back; both are used once.
//
// After either, the only thing kept is the access token and when it ends. The refresh
// token that comes with it is not wanted: it is never stored and is revoked straight away.

const FLOW_KEY = 'cranium.signin';
const SESSION_KEY = 'cranium.session';
const SIGNED_OUT_KEY = 'cranium.signedout';
const RANDOM_BYTES = 32;
const RENEW_BEFORE_S = 60;
const LOGIN_TIMEOUT_MS = 15000;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const OAUTH_ERROR = /^[a-z_]{1,40}$/;
// The Region, an underscore, and letters and digits.
const USER_POOL_ID = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}_[0-9A-Za-z]{1,64}$/;
// Cognito's user pool API: one address, the operation in a header.
const IDP_JSON = 'application/x-amz-json-1.1';
const IDP_TARGET = 'AWSCognitoIdentityProviderService.';
const CHALLENGE_NAME = /^[A-Z_]{1,40}$/;
const CODE = /^\d{6}$/;

/** The sign-in settings the server put in the page. Null if they are unusable. */
// As live.js reads it: wss://<host>/<stage>, or ws:// for the local preview.
const LIVE_URL = /^wss?:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?\/[A-Za-z0-9_-]{1,128}$/;

export function readConfig(json) {
  const value = parseJson(json ?? '');
  if (value === null || typeof value !== 'object') return null;
  const config = {};
  for (const field of ['clientId', 'loginOrigin', 'scope', 'redirectUri', 'userPoolId', 'idpOrigin']) {
    if (typeof value[field] !== 'string' || value[field] === '') return null;
    config[field] = value[field];
  }
  const origin = /^https?:\/\/[^/?#\s]+$/;
  const address = /^https?:\/\/[^?#\s]+$/;
  // Served as admin mode of the customer site (docs/customer-site.md): the site is at the root.
  if (value.customerSite === '/') config.customerSite = '/';
  // Opened on the console's own name: the customer site's address, an https origin and nothing more.
  else if (typeof value.customerSite === 'string' && /^https:\/\/[a-z0-9.-]+\/$/.test(value.customerSite))
    config.customerSite = value.customerSite;
  // The live API's WebSocket (live.js, docs/live.md). Without it, or with something else, the console polls.
  if (typeof value.liveUrl === 'string' && LIVE_URL.test(value.liveUrl)) config.liveUrl = value.liveUrl;
  return origin.test(config.loginOrigin) &&
    origin.test(config.idpOrigin) &&
    address.test(config.redirectUri) &&
    USER_POOL_ID.test(config.userPoolId)
    ? config
    : null;
}

function form(fields) {
  return new URLSearchParams(fields).toString();
}

/**
 * One call of Cognito's user pool API at `idpOrigin`: { reply, date }, { error } with the name of
 * Cognito's error, or { problem: 'network' | 'failed' }. Never throws. The sign-in below uses it,
 * and so does the customer site's account page, for the calls a signed-in person makes about
 * their own account.
 */
export async function cognitoCall(fetch, idpOrigin, operation, body) {
  let response;
  try {
    response = await fetch(`${idpOrigin}/`, {
      method: 'POST',
      headers: { 'content-type': IDP_JSON, 'x-amz-target': `${IDP_TARGET}${operation}` },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
  } catch {
    return { problem: 'network' };
  }
  let reply;
  try {
    reply = parseJson(await response.text());
  } catch {
    return { problem: 'network' };
  }
  if (!response.ok) return { error: cognitoErrorName(reply, response.headers.get('x-amzn-errortype')) };
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return { problem: 'failed' };
  return { reply, date: response.headers.get('date') };
}

/**
 * The pieces of the browser the flow uses are passed in, so that the tests can stand
 * in for them: storage (sessionStorage), location, history, fetch and crypto.
 *
 * The session is timed with this computer's own clock from start to end (`now`), so a
 * clock that is wrong changes nothing: the token's lifetime is a length of time. The
 * time in the proof of the password goes by Cognito's clock where its answer says it.
 *
 * The customer site (docs/customer-site.md) signs in with this same code. Its configuration
 * has no `loginOrigin`, because it uses no managed login pages: the refresh token is then
 * revoked through the user pool API, and a sign-out goes back to `redirectUri`. With
 * `newPasswordHere`, a first sign-in's new password is asked for on the page itself
 * (step 'new-password', then sendNewPassword) instead of being left to those pages.
 *
 * In the phone app (bridge.js, docs/mobile-apps.md "The app shell") a `vault` keeps the sign-in: the
 * refresh token goes to it as soon as Cognito hands it over, instead of being revoked, and the page
 * keeps only the access token, in memory. A page that loads asks the vault for an access token
 * (resume), and so does a session about to end (renew); signing out makes the vault forget it.
 */
export function createAuth({
  config,
  storage,
  location,
  history,
  fetch,
  crypto,
  now = () => Date.now(),
  tellOtherTabs = () => {},
  newPasswordHere = false,
  vault = null,
}) {
  const seconds = () => Math.floor(now() / 1000);

  function randomToken() {
    return toBase64Url(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)));
  }

  // When this page load completed a sign-in, in seconds; kept in memory only.
  let signedInAt = null;

  function readSession() {
    const session = parseJson(storage.getItem(SESSION_KEY) ?? '');
    if (session === null || typeof session !== 'object') return null;
    if (typeof session.accessToken !== 'string' || session.accessToken === '') return null;
    if (!Number.isFinite(session.expiresAt)) return null;
    return session;
  }

  function secondsLeft() {
    const session = readSession();
    return session ? session.expiresAt - seconds() : 0;
  }

  /** Start a sign-in. `route` is where to return to; only a route of the console is kept. */
  async function signIn(route) {
    const state = randomToken();
    const verifier = randomToken();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    storage.removeItem(SESSION_KEY);
    storage.removeItem(SIGNED_OUT_KEY);
    storage.setItem(FLOW_KEY, JSON.stringify({ state, verifier, route: routeHash(parseRoute(route)) }));
    location.assign(
      `${config.loginOrigin}/oauth2/authorize?${form({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: config.scope,
        state,
        code_challenge: toBase64Url(new Uint8Array(digest)),
        code_challenge_method: 'S256',
        // Every sign-in asks for the password and the code, also while the login page's own
        // cookie is still valid: a closed tab, or one left open, does not sign in by itself.
        prompt: 'login',
      })}`
    );
  }

  /** Take the pending sign-in out of storage. It can be used for one reply only. */
  function takeFlow() {
    const flow = parseJson(storage.getItem(FLOW_KEY) ?? '');
    storage.removeItem(FLOW_KEY);
    if (flow === null || typeof flow !== 'object') return null;
    if (typeof flow.state !== 'string' || flow.state === '' || typeof flow.verifier !== 'string') return null;
    return flow;
  }

  async function revoke(refreshToken) {
    // No managed login pages: the user pool API revokes it (RevokeToken).
    if (!config.loginOrigin) {
      const answer = await askCognito('RevokeToken', { Token: refreshToken, ClientId: config.clientId });
      if (answer.reply) return 'revoked';
      return answer.error !== undefined ? 'refused' : 'failed';
    }
    const url = `${config.loginOrigin}/oauth2/revoke`;
    const request = {
      method: 'POST',
      headers: FORM,
      body: form({ token: refreshToken, client_id: config.clientId }),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      keepalive: true,
    };
    try {
      const response = await fetch(url, request);
      return response.ok ? 'revoked' : 'refused';
    } catch {
      // Either the request never left, or it did and the reply may not be read from
      // this origin. Sending it again without asking to read the reply tells which.
      try {
        await fetch(url, { ...request, mode: 'no-cors' });
        return 'sent';
      } catch {
        return 'failed';
      }
    }
  }

  let revocation = Promise.resolve('none');

  async function redeem(code, verifier) {
    let response;
    try {
      response = await fetch(`${config.loginOrigin}/oauth2/token`, {
        method: 'POST',
        headers: FORM,
        body: form({
          grant_type: 'authorization_code',
          client_id: config.clientId,
          code,
          redirect_uri: config.redirectUri,
          code_verifier: verifier,
        }),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      });
    } catch {
      throw new Error('The sign-in service could not be reached.');
    }
    let reply;
    try {
      reply = parseJson(await response.text());
    } catch {
      throw new Error('The sign-in service could not be reached.');
    }
    if (!response.ok) {
      const reason = OAUTH_ERROR.test(reply?.error ?? '') ? ` (${reply.error})` : '';
      throw new Error(`The sign-in service refused to issue a token${reason}.`);
    }
    if (!usable(reply?.access_token, reply?.expires_in, reply?.token_type)) {
      throw new Error('The sign-in service sent a reply the console could not read.');
    }
    keep(reply.access_token, reply.expires_in, reply.refresh_token, reply.id_token);
  }

  function usable(accessToken, expiresIn, tokenType) {
    return (
      typeof accessToken === 'string' &&
      accessToken !== '' &&
      Number.isFinite(expiresIn) &&
      expiresIn > 0 &&
      String(tokenType).toLowerCase() === 'bearer'
    );
  }

  /** The session of a sign-in that worked, either way. */
  function keep(accessToken, expiresIn, refreshToken, idToken = null) {
    // The refresh token goes nowhere but back to the service that issued it, or to the app's vault.
    if (typeof refreshToken === 'string' && refreshToken !== '') {
      revocation = vault
        ? vault.store({ refreshToken, accessToken, idToken, expiresIn }).then(
            () => 'kept',
            () => 'not-kept'
          )
        : revoke(refreshToken);
    }
    signedInAt = seconds();
    storage.removeItem(SIGNED_OUT_KEY);
    storage.setItem(
      SESSION_KEY,
      JSON.stringify({
        accessToken,
        expiresAt: signedInAt + Math.floor(expiresIn),
      })
    );
  }

  // Sign-in on the console's own page.

  // The step that waits for the code: Cognito's session for it, and whom it is for.
  let challenge = null;

  /** One call of Cognito's user pool API: { reply, date }, { error } or { problem }. */
  function askCognito(operation, body) {
    return cognitoCall(fetch, config.idpOrigin, operation, body);
  }

  /** Where a refusal leaves the sign-in. */
  function refused(answer, step) {
    if (answer.problem) return { step, problem: answer.problem };
    const problem = signInProblem(answer.error, step);
    if (problem === 'elsewhere') return { step: 'elsewhere', challenge: 'PASSWORD_RESET_REQUIRED' };
    if (problem === 'expired') {
      challenge = null;
      return { step: 'password', problem };
    }
    return { step, problem };
  }

  /** What follows an answer: the code, a token, or a step for the AWS sign-in page. */
  function following(reply, step, userId) {
    const result = reply.AuthenticationResult;
    if (result && typeof result === 'object') {
      if (!usable(result.AccessToken, result.ExpiresIn, result.TokenType)) return { step, problem: 'failed' };
      challenge = null;
      keep(result.AccessToken, result.ExpiresIn, result.RefreshToken, result.IdToken);
      return { step: 'done' };
    }
    const name =
      typeof reply.ChallengeName === 'string' && CHALLENGE_NAME.test(reply.ChallengeName) ? reply.ChallengeName : '';
    if (name === 'SOFTWARE_TOKEN_MFA' && typeof reply.Session === 'string' && reply.Session !== '') {
      challenge = { session: reply.Session, userId };
      return { step: 'code' };
    }
    if (
      name === 'NEW_PASSWORD_REQUIRED' &&
      newPasswordHere &&
      typeof reply.Session === 'string' &&
      reply.Session !== ''
    ) {
      challenge = { session: reply.Session, userId, newPassword: true };
      return { step: 'new-password' };
    }
    challenge = null;
    // A new password, an authenticator app to set up, or anything else this page does not do.
    return name === '' ? { step, problem: 'failed' } : { step: 'elsewhere', challenge: name };
  }

  /**
   * Sign in with an e-mail address and a password: Cognito's USER_SRP_AUTH. The password
   * is used for the proof and nothing else; it is not kept and not sent.
   *
   * @returns {Promise<{step: 'code'} | {step: 'done'} | {step: 'elsewhere', challenge: string} |
   *   {step: 'password', problem: string}>}
   */
  async function passwordSignIn(email, password) {
    challenge = null;
    const username = String(email ?? '')
      .trim()
      .toLowerCase();
    if (username === '' || typeof password !== 'string' || password === '') {
      return { step: 'password', problem: 'missing' };
    }
    const { a, A } = startSrp(crypto);
    const started = await askCognito('InitiateAuth', {
      AuthFlow: 'USER_SRP_AUTH',
      ClientId: config.clientId,
      AuthParameters: { USERNAME: username, SRP_A: A.toString(16) },
    });
    if (!started.reply) return refused(started, 'password');
    const { reply } = started;
    if (reply.ChallengeName !== 'PASSWORD_VERIFIER') return following(reply, 'password', null);

    const parameters = reply.ChallengeParameters ?? {};
    const userId = parameters.USER_ID_FOR_SRP;
    // Cognito's clock, where its answer may be read, or else this computer's.
    const cognitoNow = Date.parse(started.date ?? '');
    const timestamp = cognitoTimestamp(Number.isNaN(cognitoNow) ? now() : cognitoNow);
    let signature;
    try {
      signature = await srpClaim({
        subtle: crypto.subtle,
        userPoolId: config.userPoolId,
        userId: String(userId),
        password,
        a,
        A,
        srpB: String(parameters.SRP_B),
        salt: String(parameters.SALT),
        secretBlock: String(parameters.SECRET_BLOCK),
        timestamp,
      });
    } catch {
      return { step: 'password', problem: 'failed' };
    }
    const verified = await askCognito('RespondToAuthChallenge', {
      ChallengeName: 'PASSWORD_VERIFIER',
      ClientId: config.clientId,
      ChallengeResponses: {
        USERNAME: userId,
        PASSWORD_CLAIM_SECRET_BLOCK: parameters.SECRET_BLOCK,
        TIMESTAMP: timestamp,
        PASSWORD_CLAIM_SIGNATURE: signature,
      },
      ...(typeof reply.Session === 'string' && reply.Session !== '' ? { Session: reply.Session } : {}),
    });
    if (!verified.reply) return refused(verified, 'password');
    return following(verified.reply, 'password', userId);
  }

  /**
   * The code from the authenticator app, for the sign-in that asked for it. A wrong code
   * leaves that sign-in waiting for another; a sign-in that Cognito has ended starts again.
   *
   * @returns {Promise<{step: 'done'} | {step: 'elsewhere', challenge: string} |
   *   {step: 'code', problem: string} | {step: 'password', problem: string}>}
   */
  async function sendCode(code) {
    if (challenge === null || challenge.newPassword) return { step: 'password', problem: 'expired' };
    if (!CODE.test(code)) return { step: 'code', problem: 'wrong-code' };
    const { session, userId } = challenge;
    const answered = await askCognito('RespondToAuthChallenge', {
      ChallengeName: 'SOFTWARE_TOKEN_MFA',
      ClientId: config.clientId,
      Session: session,
      ChallengeResponses: { USERNAME: userId, SOFTWARE_TOKEN_MFA_CODE: code },
    });
    if (!answered.reply) return refused(answered, 'code');
    return following(answered.reply, 'code', userId);
  }

  /**
   * The new password of a first sign-in, for the sign-in that asked for it (newPasswordHere).
   * What follows is the code, if the account has an authenticator app, or the session.
   *
   * @returns {Promise<{step: 'done'} | {step: 'code'} | {step: 'elsewhere', challenge: string} |
   *   {step: 'new-password', problem: string} | {step: 'password', problem: string}>}
   */
  async function sendNewPassword(password) {
    if (challenge === null || !challenge.newPassword) return { step: 'password', problem: 'expired' };
    if (typeof password !== 'string' || password === '') return { step: 'new-password', problem: 'missing-new' };
    const { session, userId } = challenge;
    const answered = await askCognito('RespondToAuthChallenge', {
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      ClientId: config.clientId,
      Session: session,
      ChallengeResponses: { USERNAME: userId, NEW_PASSWORD: password },
    });
    if (!answered.reply) return refused(answered, 'new-password');
    return following(answered.reply, 'new-password', userId);
  }

  /**
   * Work out where the browser stands when the page loads: back from the login page,
   * already signed in, just signed out, or in need of signing in, which the console's own
   * page then asks for. The address stays as it is, so that the console opens there after.
   *
   * @returns {Promise<{status: 'signed-in', route: string|null} | {status: 'sign-in'} |
   *   {status: 'signed-out', reason: string, message?: string}>}
   */
  /** An access token from the vault into this page's session: signed-in, signed-out, or why not. */
  async function fromVault() {
    let answer;
    try {
      answer = await vault.session();
    } catch (error) {
      return ['cancelled', 'locked', 'network'].includes(error?.code) ? error.code : 'failed';
    }
    if (answer?.signedIn !== true || !usable(answer.accessToken, answer.expiresIn, 'Bearer')) return 'signed-out';
    storage.setItem(
      SESSION_KEY,
      JSON.stringify({ accessToken: answer.accessToken, expiresAt: seconds() + Math.floor(answer.expiresIn) })
    );
    return 'signed-in';
  }

  async function resume() {
    if (vault) {
      if (readSession() && secondsLeft() > RENEW_BEFORE_S) return { status: 'signed-in', route: null };
      storage.removeItem(SESSION_KEY);
      const kept = await fromVault();
      if (kept === 'signed-in') return { status: 'signed-in', route: null };
      // Face ID cancelled or failed, or no network: the sign-in page, which says so; nothing is forgotten.
      return kept === 'signed-out' ? { status: 'sign-in' } : { status: 'sign-in', reason: kept };
    }
    const query = new URLSearchParams(location.search);
    const code = query.get('code');
    const state = query.get('state');
    const failure = query.get('error');

    // Before anything else is requested: the code must not stay in the address bar,
    // in the history or in a Referer header.
    if (location.search !== '') {
      history.replaceState(null, '', location.pathname + location.hash);
    }

    if (code !== null || failure !== null) {
      const flow = takeFlow();
      if (!flow || state !== flow.state) {
        // Not the answer to a sign-in started in this tab. The code is dropped unused.
        return readSession() && secondsLeft() > RENEW_BEFORE_S
          ? { status: 'signed-in', route: null }
          : { status: 'signed-out', reason: 'unknown-reply' };
      }
      if (failure !== null) {
        const message = OAUTH_ERROR.test(failure) ? failure : '';
        return { status: 'signed-out', reason: 'login-error', message };
      }
      try {
        await redeem(code, flow.verifier);
      } catch (error) {
        return { status: 'signed-out', reason: 'no-token', message: error.message };
      }
      return { status: 'signed-in', route: routeHash(parseRoute(flow.route)) };
    }

    if (storage.getItem(SIGNED_OUT_KEY) !== null) {
      storage.removeItem(SIGNED_OUT_KEY);
      return { status: 'signed-out', reason: 'signed-out' };
    }
    if (readSession() && secondsLeft() > RENEW_BEFORE_S) {
      return { status: 'signed-in', route: null };
    }
    storage.removeItem(SESSION_KEY);
    return { status: 'sign-in' };
  }

  /** Forget everything of this session in this tab. A reload then finds it signed out. */
  function forgetSession() {
    challenge = null;
    storage.clear();
    storage.setItem(SIGNED_OUT_KEY, '1');
  }

  /** Forget the session here and in the tabs next to this one, then end it at the login pages too. */
  function signOut() {
    forgetSession();
    tellOtherTabs();
    // In the app: the vault forgets the refresh token and revokes it, then back to the site's own page.
    if (vault) {
      vault
        .signOut()
        .catch(() => {})
        .finally(() => location.assign(config.redirectUri));
      return;
    }
    // No managed login pages, so nothing to end there: back to the site's own page.
    if (!config.loginOrigin) {
      location.assign(config.redirectUri);
      return;
    }
    location.assign(
      `${config.loginOrigin}/logout?${form({
        client_id: config.clientId,
        logout_uri: config.redirectUri,
      })}`
    );
  }

  return {
    resume,
    /** Leave for the AWS sign-in page. */
    signIn,
    passwordSignIn,
    sendCode,
    sendNewPassword,
    /** Drop a sign-in on the console's own page that waits for its code. */
    cancelPasswordSignIn() {
      challenge = null;
    },
    signOut,
    /** Another tab was signed out: the same here, without going to the login pages. */
    signedOutElsewhere: forgetSession,
    /** The server has turned the token down, so it is worth nothing any more. */
    tokenRefused() {
      storage.removeItem(SESSION_KEY);
    },
    secondsLeft,
    /** The access token, or null once it has expired. */
    accessToken() {
      const session = readSession();
      return session && session.expiresAt > seconds() ? session.accessToken : null;
    },
    /** True when the token is about to expire and sign-in should start again. */
    needsRenewal: () => secondsLeft() <= RENEW_BEFORE_S,
    /** True if this page load completed a sign-in less than `window` seconds ago. */
    signedInWithin: (window) => signedInAt !== null && seconds() - signedInAt < window,
    /**
     * How the revocation of the unwanted refresh token went: revoked, sent, refused, failed or none; in the
     * app, kept or not-kept by the vault.
     */
    revocation: () => revocation,
    /** In the app: a new access token from the vault, without asking for the password. True if it gave one. */
    async renew() {
      return vault !== null && (await fromVault()) === 'signed-in';
    },
    /** Whether the sign-in is kept by the app (bridge.js). */
    inApp: vault !== null,
  };
}

// What tabs of the same address say to each other. Only ever this one fixed word: no
// token, no address, nothing about who was signed in.
export const SESSION_CHANNEL = 'cranium.session';
export const SIGNED_OUT_SIGNAL = 'signed-out';

// The API client.

const MAX_TRIES = 3;
const RETRY_GET = new Set([429, 502, 503, 504]);
const RETRY_POST = new Set([429]);
const BACKOFF_MS = 400;
const REQUEST_TIMEOUT_MS = 25000;
const UPLOAD_TIMEOUT_MS = 60000;

function backoff(attempt, crypto) {
  // Jitter between half and one and a half times the step, which doubles each try.
  const unit = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  return BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + unit);
}

/**
 * @param {object} options
 * @param {object} options.auth            from createAuth
 * @param {Function} options.fetch
 * @param {Function} [options.XMLHttpRequest]  used for the firmware upload only, because
 *                                             it reports how much has been sent
 * @param {object} options.crypto
 * @param {object} options.clock
 * @param {Function} options.onUnauthorized    called when the API refuses the token
 * @param {Function} [options.pause]           waits the given milliseconds
 */
export function createApi({
  auth,
  fetch,
  XMLHttpRequest,
  crypto,
  clock,
  onUnauthorized,
  base = '',
  onSignInAgain = () => {},
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  function unauthorized() {
    onUnauthorized();
    return new ApiError(401, 'unauthorized', 'Your session has ended. Sign in again to continue.');
  }

  async function request(method, path, body, { once = false } = {}) {
    const retry = once ? new Set() : method === 'GET' ? RETRY_GET : RETRY_POST;
    for (let attempt = 1; ; attempt += 1) {
      const token = auth.accessToken();
      if (token === null) throw unauthorized();

      const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      let response;
      try {
        response = await fetch(`${base}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: 'no-store',
          credentials: 'omit',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw error?.name === 'TimeoutError' ? tooSlow() : unreachable();
      }
      clock.observe(response.headers.get('date'));

      if (response.status === 401) throw unauthorized();
      if (retry.has(response.status) && attempt < MAX_TRIES) {
        await pause(backoff(attempt, crypto));
        continue;
      }
      let text;
      try {
        text = await response.text();
      } catch {
        throw new ApiError(0, 'network', 'The connection to the server broke off. Check the connection.');
      }
      const payload = parseJson(text);
      if (!response.ok) throw signInAgain(errorFrom(response.status, payload));
      if (payload === null) throw unreadable();
      return payload;
    }
  }

  /** A change from the phone needs a sign-in in the last 15 minutes (docs/mobile-apps.md): the page asks for one. */
  function signInAgain(error) {
    if (error.status === 403 && error.code === 'phone_sign_in_again') onSignInAgain(error);
    return error;
  }

  /**
   * A signed firmware image, as bytes, for the Bluetooth page of the app (bluetooth.js) and Board setup
   * (setup.js). Read again on a gateway's hiccup, as any read is; checked by the caller against the release.
   */
  async function image(version) {
    return bytesAt(`/api/firmware/${encodeURIComponent(checked(isVersion, version))}/image`);
  }

  /**
   * The frozen golden image (firmware/golden.json), which the web function serves beside the page to
   * anyone, as git does: no token goes with it. Checked by the caller against its SHA-256.
   */
  async function golden(file) {
    const name = checked(
      (text) => typeof text === 'string' && /^cranium-\d{1,3}\.\d{1,3}\.\d{1,5}-\d{1,10}\.signed\.bin$/.test(text),
      file
    );
    return bytesAt(`/golden/${name}`, { token: false });
  }

  async function bytesAt(path, { token: withToken = true } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      const token = withToken ? auth.accessToken() : null;
      if (withToken && token === null) throw unauthorized();
      let response;
      try {
        response = await fetch(`${base}${path}`, {
          method: 'GET',
          headers: withToken
            ? { authorization: `Bearer ${token}`, accept: 'application/octet-stream' }
            : { accept: 'application/octet-stream' },
          cache: 'no-store',
          credentials: 'omit',
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
      } catch (error) {
        throw error?.name === 'TimeoutError' ? tooSlow() : unreachable();
      }
      clock.observe(response.headers.get('date'));
      if (response.status === 401) throw unauthorized();
      if (RETRY_GET.has(response.status) && attempt < MAX_TRIES) {
        await pause(backoff(attempt, crypto));
        continue;
      }
      if (!response.ok) {
        let payload = null;
        try {
          payload = parseJson(await response.text());
        } catch {
          payload = null;
        }
        throw errorFrom(response.status, payload);
      }
      try {
        return new Uint8Array(await response.arrayBuffer());
      } catch {
        throw new ApiError(0, 'network', 'The connection to the server broke off. Check the connection.');
      }
    }
  }

  /** One attempt at sending a firmware image, with progress. */
  function send(token, body, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${base}/api/firmware`);
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      xhr.setRequestHeader('authorization', `Bearer ${token}`);
      xhr.setRequestHeader('accept', 'application/json');
      xhr.setRequestHeader('content-type', 'application/json');
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || event.total <= 0) return;
        onProgress({ stage: 'sending', sent: event.loaded / event.total });
      };
      xhr.upload.onload = () => onProgress({ stage: 'checking', sent: 1 });
      xhr.onload = () =>
        resolve({
          status: xhr.status,
          text: xhr.responseText,
          date: xhr.getResponseHeader('date'),
        });
      xhr.onerror = () => reject(unreachable());
      xhr.ontimeout = () => reject(tooSlow());
      xhr.send(body);
    });
  }

  async function upload({ filename, notes, data }, onProgress = () => {}) {
    const fields = { filename, data };
    if (notes) fields.notes = notes;
    const body = JSON.stringify(fields);
    for (let attempt = 1; ; attempt += 1) {
      const token = auth.accessToken();
      if (token === null) throw unauthorized();
      onProgress({ stage: 'sending', sent: 0 });
      const reply = await send(token, body, onProgress);
      clock.observe(reply.date);
      if (reply.status === 401) throw unauthorized();
      if (RETRY_POST.has(reply.status) && attempt < MAX_TRIES) {
        await pause(backoff(attempt, crypto));
        continue;
      }
      const payload = parseJson(reply.text);
      if (reply.status < 200 || reply.status > 299) throw errorFrom(reply.status, payload);
      return readRelease(record(payload).release);
    }
  }

  function checked(test, value) {
    if (!test(value)) throw new ApiError(0, 'bad_request', 'That name is not valid.');
    return value;
  }

  /** The search and level of a read of a long list, as its query: only what is set. */
  function searchQuery(q, level) {
    const query = {};
    if (q !== null && q !== '') query.q = checked((text) => cleanSearch(text) === text && text !== '', q);
    if (level !== null) query.level = checked((value) => value === 'warn' || value === 'info', level);
    return query;
  }

  const get = (path) => request('GET', path);
  const post = (path, body) => request('POST', path, body);

  return {
    me: async () => readMe(await get('/api/me')),
    devices: async () => readDevices(await get('/api/devices')),
    device: async (thing) => readDeviceDetail(await get(`/api/devices/${checked(isThing, thing)}`)),
    firmware: async () => readFirmware(await get('/api/firmware')),
    deployments: async () => readDeployments(await get('/api/deployments')),
    /** Every update of every board (or of one), newest first, a page at a time: { updates, cursor, generatedAt }. */
    async updates({ thing = null, limit = null, cursor = null } = {}) {
      const query = {};
      if (thing !== null) query.thing = checked(isThing, thing);
      if (limit !== null)
        query.limit = String(checked((count) => Number.isInteger(count) && count >= 1 && count <= 100, limit));
      if (cursor !== null) query.cursor = checked((text) => CURSOR.test(text), cursor);
      const asked = form(query);
      return readUpdates(await get(asked === '' ? '/api/updates' : `/api/updates?${asked}`));
    },
    /** A board's version timeline, newest first, a page at a time: { thing, current, versions, cursor }. */
    async timeline(thing, { limit = null, cursor = null } = {}) {
      const query = {};
      if (limit !== null)
        query.limit = String(checked((count) => Number.isInteger(count) && count >= 1 && count <= 50, limit));
      if (cursor !== null) query.cursor = checked((text) => CURSOR.test(text), cursor);
      const asked = form(query);
      const path = `/api/devices/${checked(isThing, thing)}/timeline`;
      return readTimeline(await get(asked === '' ? path : `${path}?${asked}`));
    },
    deployment: async (id) =>
      readDeployment(record(record(await get(`/api/deployments/${checked(isDeploymentId, id)}`)).deployment)),
    /** The boards' events between two times (ISO), newest first, a page at a time. */
    async events({ from, to, thing = null, kinds = null, cursor = null, q = null, level = null }) {
      const query = { from: checked(instant, from), to: checked(instant, to) };
      if (thing !== null) query.thing = checked(isThing, thing);
      Object.assign(query, searchQuery(q, level));
      if (kinds !== null)
        query.kinds = kinds.map((kind) => checked((name) => EVENT_KINDS.includes(name), kind)).join(',');
      if (cursor !== null) query.cursor = checked((text) => CURSOR.test(text), cursor);
      return readEvents(await get(`/api/events?${form(query)}`));
    },
    /** The boards' own log between two times (ISO), newest first, a page at a time. */
    async boardLog({ from, to, thing = null, kinds = null, tags = null, cursor = null, q = null, level = null }) {
      const query = { from: checked(instant, from), to: checked(instant, to) };
      if (thing !== null) query.thing = checked(isThing, thing);
      Object.assign(query, searchQuery(q, level));
      if (kinds !== null)
        query.kinds = kinds.map((kind) => checked((name) => LINE_KINDS.includes(name), kind)).join(',');
      if (tags !== null) query.tags = tags.map((tag) => checked((name) => LINE_TAGS.includes(name), tag)).join(',');
      if (cursor !== null) query.cursor = checked((text) => CURSOR.test(text), cursor);
      return readLines(await get(`/api/events/log?${form(query)}`));
    },
    /** A board's readings of the last `hours` hours, oldest first. */
    async samples(thing, hours = 24) {
      const query = { hours: String(checked((value) => whole(value, 1, 168) !== null, hours)) };
      return readSamples(await get(`/api/devices/${checked(isThing, thing)}/samples?${form(query)}`));
    },
    /**
     * A page of the activity log, newest first. With a search, actions, outcomes or a range (ISO times) the
     * server reads a bounded page of the log and says how many it read: { entries, next, read }.
     */
    async audit({ limit = 50, before = null, q = null, actions = null, outcomes = null, from = null, to = null } = {}) {
      const query = { limit: String(limit) };
      if (before !== null) query.before = checked((cursor) => CURSOR.test(cursor), before);
      Object.assign(query, searchQuery(q, null));
      if (actions !== null)
        query.actions = actions
          .map((name) => checked((action) => Object.hasOwn(AUDIT_ACTIONS, action), name))
          .join(',');
      if (outcomes !== null)
        query.outcomes = outcomes
          .map((name) => checked((outcome) => ACTIVITY_OUTCOMES.includes(outcome), name))
          .join(',');
      if (from !== null) query.from = checked(instant, from);
      if (to !== null) query.to = checked(instant, to);
      return readAudit(await get(`/api/audit?${form(query)}`));
    },
    upload,
    async revoke(version, reason) {
      const reply = record(await post(`/api/firmware/${checked(isVersion, version)}/revoke`, { reason }));
      return {
        release: readRelease(reply.release),
        cancelled: Array.isArray(reply.cancelled) ? reply.cancelled.filter(isDeploymentId) : [],
      };
    },
    async deploy({ version, things, note }) {
      const body = {
        version: checked(isVersion, version),
        things: things.map((thing) => checked(isThing, thing)),
      };
      if (note) body.note = note;
      return readDeployment(record(record(await post('/api/deployments', body)).deployment));
    },
    async cancel(id, force) {
      const path = `/api/deployments/${checked(isDeploymentId, id)}/cancel`;
      return readDeployment(record(record(await post(path, { force: force === true })).deployment));
    },
    /**
     * Put on record a command the board answered OK to at its serial console: its name, and the
     * board's device ID and firmware as it gave them. Never a value. Tried once: a refusal for
     * too many is not one to wait out, and the board has done it either way.
     */
    async recordSerialCommand({ command, device = null, version = null }) {
      const body = { command: checked((name) => /^[A-Z][A-Z_]{1,31}$/.test(name), command) };
      if (device !== null) body.device = checked(isBoardName, device);
      if (version !== null) body.version = checked(isVersion, version);
      return record(await request('POST', '/api/serial/commands', body, { once: true })).recorded ?? null;
    },
    /** A release's note, changed after its upload: the whole note, '' for none. */
    async setNotes(version, notes) {
      const path = `/api/firmware/${encodeURIComponent(checked(isVersion, version))}/notes`;
      return readRelease(record(await request('PUT', path, { notes })).release);
    },
    /**
     * The fleet's requests (fleet.js reads its own answers): board types, groups and staged
     * rollouts, and nothing else of the API.
     */
    async fleetRequest(method, path, body) {
      const allowed =
        (method === 'GET' || method === 'POST') &&
        typeof path === 'string' &&
        /^\/api\/(?:fleet|groups|rollouts)(?:\/[A-Za-z0-9-]+){0,2}(?:\?[A-Za-z0-9=&%._-]*)?$/.test(path);
      if (!allowed) throw new ApiError(0, 'bad_request', 'That is not a request of the fleet.');
      return record(await request(method, path, body));
    },
    /**
     * The Apps page's reads (apps.js reads its own answers): the apps, their configuration, and a link
     * to download an Android release, which the console puts on record. Tried once: a link is for now.
     */
    // Our own issues (issues-page.js): reads only, of the list and of one issue, over a number of days.
    async issuesRequest(path) {
      const read = typeof path === 'string' && /^\/api\/issues(?:\/[0-9a-f]{12})?(?:\?days=[1-9]\d?)?$/.test(path);
      if (!read) throw new ApiError(0, 'bad_request', 'That is not a request of the Issues pages.');
      return record(await request('GET', path));
    },
    // What Memfault knows (memfault-page.js): reads only, of these four routes: the fleet, the issues, an
    // issue and a board.
    async memfaultRequest(path) {
      const read =
        typeof path === 'string' &&
        (/^\/api\/memfault\/(?:fleet|issues(?:\/[1-9]\d{0,15})?)$/.test(path) ||
          /^\/api\/devices\/cranium-[0-9a-f]{16}\/memfault(?:\?hours=[1-9]\d{0,2})?$/.test(path));
      if (!read) throw new ApiError(0, 'bad_request', 'That is not a request of the Memfault pages.');
      return record(await request('GET', path));
    },
    /**
     * The Database page's reads (db-page.js reads its own answers): the tables, a page of a table, an item,
     * and an export, which the console puts on record. An export is tried once: it is on record each time.
     */
    async dbRequest(path, { once = false } = {}) {
      const read =
        typeof path === 'string' &&
        /^\/api\/db\/(?:tables|(?:state|audit|events)(?:\/item|\/export)?(?:\?[A-Za-z0-9=&%._~*!'()-]*)?)$/.test(path);
      if (!read) throw new ApiError(0, 'bad_request', 'That is not a request of the Database page.');
      return record(await request('GET', path, undefined, { once }));
    },
    async appsRequest(method, path) {
      const read =
        method === 'GET' &&
        typeof path === 'string' &&
        (/^\/api\/apps(?:\/config|\/sidestore|\/android\/\d{1,3}\.\d{1,3}\.\d{1,5}\/download(?:\?via=qr)?)?$/.test(
          path
        ) ||
          /^\/api\/apps\/ios\/\d{1,3}\.\d{1,3}\.\d{1,5}\/download$/.test(path));
      // A member's own SideStore link: made, or turned off. Tried once: a new link ends the one before.
      const change = method === 'POST' && (path === '/api/apps/sidestore' || path === '/api/apps/sidestore/revoke');
      if (!read && !change) throw new ApiError(0, 'bad_request', 'That is not a request of the Apps page.');
      if (change) return record(await request(method, path, {}, { once: true }));
      return record(await request(method, path, undefined, { once: path.includes('/download') }));
    },
    // An update over Bluetooth from the app (bluetooth.js, docs/mobile-apps.md "The API"): the image, the
    // passkey of a board that is pairing, and the console's yes right before every send.
    image,
    // Board setup (setup.js): the golden image, and a board's certificate for the request it made itself.
    golden,
    /**
     * Register a board by its own signing request: { id, csr, reregister } -> { thing, certificatePem,
     * rootCa, endpoint, downloadPrefix }, read by setup.js. Tried once: a second try would make a second
     * certificate.
     */
    async registerDevice({ id, csr, reregister = false }) {
      const body = {
        id: checked((text) => typeof text === 'string' && /^[0-9A-Za-z]{1,32}$/.test(text), id),
        csr: checked(
          (text) =>
            typeof text === 'string' && text.length < 4096 && text.startsWith('-----BEGIN CERTIFICATE REQUEST-----'),
          csr
        ),
        reregister: reregister === true,
      };
      return record(await request('POST', '/api/devices/register', body, { once: true }));
    },
    /**
     * Board setup's Wi-Fi defaults, for release managers: { ssid, passphrase, security }, or null when the
     * console has none. setup.js puts them into the form's fields and keeps them nowhere else.
     */
    async wifiDefaults() {
      const reply = record(await request('GET', '/api/setup/wifi-defaults', undefined, { once: true }));
      const wifi = reply?.wifi;
      if (!wifi || typeof wifi !== 'object') return null;
      const { ssid, passphrase, security } = wifi;
      return typeof ssid === 'string' && typeof passphrase === 'string' && typeof security === 'string'
        ? { ssid, passphrase, security }
        : null;
    },
    async pairing(name) {
      const path = `/api/pairing/${encodeURIComponent(checked(isBluetoothName, name))}`;
      const reply = record(await request('GET', path, undefined, { once: true }));
      const passkey = typeof reply.passkey === 'string' && /^\d{6}$/.test(reply.passkey) ? reply.passkey : null;
      return passkey === null
        ? null
        : { passkey, thing: isThing(reply.thing) ? reply.thing : null, reportedAt: instant(reply.reportedAt) };
    },
    async clearSend(version, { sha256, board = null }) {
      const body = { sha256: checked((value) => /^[0-9a-f]{64}$/.test(value), sha256) };
      if (board !== null) body.board = checked(isBluetoothName, board);
      const path = `/api/firmware/${encodeURIComponent(checked(isVersion, version))}/bluetooth`;
      const reply = record(await request('POST', path, body, { once: true }));
      return { version: text(reply.version, 32), sha256: text(reply.sha256, 64), status: text(reply.status, 16) };
    },
    tokens: async () => readTokens(await get('/api/tokens')),
    createToken: async ({ name, days }) => readNewToken(await post('/api/tokens', { name, days })),
    async revokeToken(id) {
      return readToken(record(await post(`/api/tokens/${checked(isTokenId, id)}/revoke`, {})).token);
    },
    // The map, commands and alerts (docs/fleet.md): a board's last positions, a command to a board,
    // and the caller's own e-mail alerts.
    positions: async (thing) => readPositions(await get(`/api/devices/${checked(isThing, thing)}/positions`)),
    /** identify (for `seconds`), report or memfault, now. Tried once: a command is for now, and a refusal says why. */
    async command(thing, cmd, seconds = null) {
      const body = { cmd: checked((name) => COMMANDS.includes(name), cmd) };
      if (seconds !== null) body.seconds = checked((value) => whole(value, 1, 60) !== null, seconds);
      return readCommand(
        record(await request('POST', `/api/devices/${checked(isThing, thing)}/commands`, body, { once: true })).command
      );
    },
    /** A board's name in the console, given (1 to 40 printable characters) or taken away (null): the name now. */
    renameBoard: async (thing, label) => {
      const given = label === null ? null : checked(isBoardLabel, String(label).trim());
      const reply = record(
        await request('POST', `/api/devices/${checked(isThing, thing)}/label`, { label: given }, { once: true })
      );
      return isBoardLabel(reply.label) ? reply.label : null;
    },
    alerts: async () => readAlerts(await get('/api/alerts')),
    subscribeAlerts: async () =>
      text(record(await request('POST', '/api/alerts/subscribe', {}, { once: true })).subscription, 16),
    unsubscribeAlerts: async () => text(record(await post('/api/alerts/unsubscribe', {})).subscription, 16),
    /** Change alert rules: { <rule>: { on?, <threshold>? } }. The rules as they are after it. */
    setAlertRules: async (rules) => readAlertRules(record(await post('/api/alerts/rules', { rules })).alertRules),
    // The customer site's customers (docs/customer-site.md). customers.js reads the replies.
    customers: async () => record(await get('/api/customers')),
    inviteCustomer: async ({ email, name }) => record(await post('/api/customers', name ? { email, name } : { email })),
    resendInvitation: async (id) => record(await post(`/api/customers/${checked(isCustomerId, id)}/resend`, {})),
    assignBoard: async (id, { thing, label }) =>
      record(
        await post(
          `/api/customers/${checked(isCustomerId, id)}/boards`,
          label ? { thing: checked(isThing, thing), label } : { thing: checked(isThing, thing) }
        )
      ),
    unassignBoard: async (id, thing) =>
      record(await post(`/api/customers/${checked(isCustomerId, id)}/boards/${checked(isThing, thing)}/remove`, {})),
    setCustomerEnabled: async (id, enabled) =>
      record(await post(`/api/customers/${checked(isCustomerId, id)}/${enabled ? 'enable' : 'disable'}`, {})),
    // Cognito's admin reset: it e-mails the customer a code. No password goes either way.
    resetCustomerPassword: async (id) =>
      record(await post(`/api/customers/${checked(isCustomerId, id)}/reset-password`, {})),
    removeCustomer: async (id) => record(await post(`/api/customers/${checked(isCustomerId, id)}/remove`, {})),
    // The team's accounts (docs/accounts.md). team.js reads the replies. No password goes either way.
    team: async () => record(await get('/api/team')),
    inviteTeamMember: async ({ email, tier }) =>
      record(await post('/api/team', { email, tier: checked(isTier, tier) })),
    resendTeamInvitation: async (id) => record(await post(`/api/team/${checked(isAccountId, id)}/resend`, {})),
    setTeamTier: async (id, tier) =>
      record(await post(`/api/team/${checked(isAccountId, id)}/tier`, { tier: checked(isTier, tier) })),
    setTeamEnabled: async (id, enabled) =>
      record(await post(`/api/team/${checked(isAccountId, id)}/${enabled ? 'enable' : 'disable'}`, {})),
    resetTeamMember: async (id) => record(await post(`/api/team/${checked(isAccountId, id)}/reset`, {})),
    removeTeamMember: async (id) => record(await post(`/api/team/${checked(isAccountId, id)}/remove`, {})),
    // The weekly fleet report (docs/reports.md). reports.js reads the replies.
    reports: async () => record(await get('/api/reports')),
    report: async (week) => record(await get(`/api/reports/${checked(isReportWeek, week)}`)),
    /** A week as CSV, on record: tried once, since each try is on record. */
    reportExport: async (week) =>
      record(
        await request('GET', `/api/reports/${checked(isReportWeek, week)}/export?format=csv`, undefined, { once: true })
      ),
    setReportEmail: async (email) =>
      record(await post('/api/reports/settings', { email: checked((on) => typeof on === 'boolean', email) })),
  };
}

// The name a board advertises over Bluetooth while its window is open: Cranium- and four hex digits.
const BLUETOOTH_NAME = /^Cranium-[0-9A-F]{4}$/;

export function isBluetoothName(value) {
  return typeof value === 'string' && BLUETOOTH_NAME.test(value);
}

// A customer of the customer site: the sub of their account in the customer pool.
const CUSTOMER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCustomerId(value) {
  return typeof value === 'string' && CUSTOMER_ID.test(value);
}

/** An account of the team: the sub of a person's account in the staff pool, a UUID like a customer's. */
export function isAccountId(value) {
  return typeof value === 'string' && CUSTOMER_ID.test(value);
}

// What a person of the team may do (cloud/api/src/handlers/team.mjs TIERS).
export const TIERS = Object.freeze(['release-manager', 'viewer']);
export function isTier(value) {
  return TIERS.includes(value);
}

// How often to ask again. A deployment is polled every 3 s while a board is installing
// or is online and may move at any moment: it starts by itself, or someone stands at it
// to press its button. It is polled every 10 s while the only boards left are offline, and not at
// all once nothing is in flight.

export const POLL_INSTALLING_MS = 3000;
export const POLL_WAITING_MS = 10000;

/** The polling interval for a set of execution statuses; 0 means do not poll. */
export function pollInterval(statuses) {
  let waiting = false;
  for (const status of statuses) {
    if (status === 'IN_PROGRESS') return POLL_INSTALLING_MS;
    if (status === 'QUEUED') waiting = true;
  }
  return waiting ? POLL_WAITING_MS : 0;
}

/** The status an execution counts as for pollInterval: an online board that waits is watched closely. */
export function executionActivity(execution) {
  return execution.status === 'QUEUED' && execution.online ? 'IN_PROGRESS' : execution.status;
}

/**
 * The status a deployment summary amounts to, for pollInterval. `devices` is the board
 * list, where it has been read: the summary itself does not say which boards are online.
 */
export function summaryActivity(deployment, devices = []) {
  if (deployment.counts.inProgress > 0) return 'IN_PROGRESS';
  if (deployment.counts.queued === 0) return null;
  const online = devices.some((device) => device.online && deployment.things.includes(device.thing));
  return online ? 'IN_PROGRESS' : 'QUEUED';
}

/** The same for a board, judged by what it last reported. An offline board is not waited on. */
export function deviceActivity(device) {
  if (!device.online || !device.ota || device.ota.state === 'idle') return null;
  return 'IN_PROGRESS';
}

// A board that a forced cancellation found restarting cannot be stopped, and comes back
// on the new firmware or the old one a while later. AWS says nothing more about it, so
// for this long what the board itself reports is still followed.
const SETTLING_MS = 5 * MINUTE;

/**
 * True while a cancelled update may still change what a board runs: it had started,
 * and the board's last report still names this deployment.
 */
export function stillSettling(execution, board, deploymentId, nowMs) {
  if (execution.status !== 'CANCELED' || !execution.startedAt) return false;
  if (!board?.ota || board.ota.job !== deploymentId || board.ota.state === 'idle') return false;
  const since = Date.parse(execution.lastUpdatedAt);
  return !Number.isNaN(since) && nowMs - since < SETTLING_MS;
}

/**
 * True for a board that said that it is restarting and has not been written off yet. It
 * is off for that moment, whatever its connection still counts as.
 */
export function isRestarting(device) {
  return device.online && device.ota?.state === 'rebooting';
}

export function isUnfinished(status) {
  return status === 'QUEUED' || status === 'IN_PROGRESS';
}

/**
 * True while a board that a cancellation found restarting or on trial is still reporting
 * this deployment. AWS has written it off, and the board has not finished. It goes on
 * counting for as long as stillSettling() follows such a board.
 */
export function stillFinishing(deployment, devices, nowMs) {
  if (deployment.status !== 'CANCELED') return false;
  return (devices ?? []).some((device) => {
    if (device.ota?.job !== deployment.id) return false;
    if (device.ota.state !== 'rebooting' && device.ota.state !== 'testing') return false;
    if (device.online) return true;
    const since = Date.parse(device.lastSeen);
    return !Number.isNaN(since) && nowMs - since < SETTLING_MS;
  });
}

/**
 * Whether a deployment still has a board waiting or at work. The status of the job
 * does not say: a deployment cancelled without force keeps the boards that had started.
 */
export function isUnderWay(deployment) {
  return deployment.status === 'IN_PROGRESS' || deployment.counts.inProgress + deployment.counts.queued > 0;
}

// The decisions of the console's timers: when to read a page again and when to leave
// for the sign-in page. They are kept here so that they can be tested without a page.

export const RETRY_AFTER_ERROR_MS = 15000;
// From here on a page that holds unsent work says that the session is about to end.
export const SESSION_WARNING_S = 300;

/**
 * What the refresh timer does for a page that asks to be read every `interval` ms
 * (0 for never). `every` is how often the page is in fact read, which is what it tells
 * the user; `wait` is how long to wait now, 0 for not at all. A page that could not be
 * loaded is not asked for more often than every 15 s, and nothing is asked for while
 * the tab is in the background.
 */
export function refreshPlan({ interval, failed, visible }) {
  if (!(interval > 0)) return { every: 0, wait: 0 };
  const every = failed ? Math.max(interval, RETRY_AFTER_ERROR_MS) : interval;
  return { every, wait: visible ? every : 0 };
}

/** True while a chosen file is in hand: being read, waiting to be sent, on its way or refused. */
export function uploadInHand(stage) {
  return stage !== 'idle' && stage !== 'done';
}

/**
 * Whether to leave for the sign-in page now, shortly before the token ends. Not while
 * the tab is in the background or a message fills the page, and not while leaving would
 * throw work away: an open dialog, a chosen file, an upload on its way. If the token
 * then runs out, the next request says so.
 */
export function shouldRenew({ needsRenewal, visible, gate, dialogOpen, uploadStage }) {
  if (!needsRenewal || !visible || gate) return false;
  return !dialogOpen && !uploadInHand(uploadStage);
}

/**
 * What follows when the API refuses the token: as a rule 'sign-in' again; 'refused'
 * when the token is fresh, because signing in again would only repeat the refusal;
 * 'stay' when the page already shows a message about signing in, or when leaving would
 * throw work away (`holding`: an open dialog, a chosen file). The request that failed
 * then says so where the work is. `gate` is the message that fills the page, if any;
 * one that only says "loading" does not count.
 */
export function afterUnauthorized({ gate, fresh, holding = false }) {
  if ((gate && !gate.waiting) || holding) return 'stay';
  return fresh ? 'refused' : 'sign-in';
}

// Choosing boards for a deployment.

/** True if a board reports that it runs this version or a newer one: it will refuse the offer. */
export function alreadyRuns(device, version) {
  const target = parseVersion(version);
  const runs = device.fw ? parseVersion(device.fw.version) : null;
  return target !== null && runs !== null && compareVersions(runs, target) >= 0;
}

// The first firmware that starts an update by itself. Older images, the frozen golden image
// among them, wait for Button 1. What a board reports (awaiting_user) says whether it waits
// now: this is only for what has not happened yet, as in the words before a deployment.
export const FIRST_WITH_NO_BUTTON = '1.7.2';
const NO_BUTTON_FROM = Object.freeze({ major: 1, minor: 7, revision: 2, build: 0 });

/** True if a board reports firmware that holds an update until Button 1 is pressed. */
export function asksForButton(device) {
  const runs = device.fw ? parseVersion(device.fw.version) : null;
  return runs !== null && compareVersions(runs, NO_BUTTON_FROM) < 0;
}

/**
 * True for a version that is not in the list of releases: it reached the board some other
 * way than a deployment of a release from this list. Nothing is said while the list has
 * not been read, or while it is empty and there is nothing to be registered among.
 */
export function isUnregistered(version, releases) {
  return (
    Boolean(version) &&
    Array.isArray(releases) &&
    releases.length > 0 &&
    !releases.some((release) => release.version === version)
  );
}

/**
 * The board to tick without being asked: the only one that has no unfinished update,
 * unless it would refuse the release anyway. Null when there is a choice to make.
 * `busy` holds the names of the boards that are not free.
 */
export function onlyChoice(devices, busy, version) {
  const free = devices.filter((device) => !busy.has(device.thing));
  if (free.length !== 1 || alreadyRuns(free[0], version)) return null;
  return free[0].thing;
}

// Words. What a board is doing, said the way one would say it to a teammate. Each
// description also names a tone (act, wait, live, good, warn, bad, idle) and an icon,
// so that no state is told apart by colour alone. "act" is the one state in which an
// update waits for a person.

// In a heading and in the name of a step, "Button 1" is held together by a no-break
// space: a line that ends on "Button" reads as if the number belonged to what follows.
const BUTTON_1 = 'Button\u00a01';

// The steps of an update, in order. `name` is what a step is called once it is done
// and while it is still ahead. Where that name would claim more than is true, `doing`
// is what the step is called while the board is at it, and `failed` what it is called
// when the update stopped there.
export const STEPS = [
  { name: 'Offered' },
  // Nothing here says that a person agreed: firmware from 1.7.2 on takes a job by itself, once
  // it has checked it. `doing` is only used while a board reports that it waits for its button.
  { name: 'Accepted by the board', doing: `Waiting for ${BUTTON_1}`, failed: 'Not accepted' },
  { name: 'Downloading', failed: 'Download failed' },
  // What the board checks here is the digest and the version. The signature is the
  // bootloader's to check, at the restart: this step must not read as that.
  { name: 'Download checked', doing: 'Checking the download', failed: 'Check failed' },
  { name: 'Restarting', failed: 'Did not start' },
  { name: 'On trial', failed: 'Rolled back' },
  { name: 'Confirmed' },
];
const ACCEPTED = 1;
const DOWNLOADED = 2;
const VERIFIED = 3;
const RESTARTED = 4;
const TESTED = 5;

// Told in the past: every one of these is about an update that is over, however long ago.
const REFUSALS = {
  not_newer: 'the board already ran this version or a newer one',
  too_large: 'the image was larger than the board’s update slot',
  bad_document: 'the board could not read the update instructions',
  unsupported: 'the board did not support this kind of update',
  url_not_allowed: 'the download address was not one the board accepts',
};

// `at` is the step that failed, where the board says enough to tell.
const FAILURES = {
  download_failed: {
    at: 2,
    title: 'The download failed',
    text: 'The board could not download the image.',
  },
  digest_mismatch: {
    at: 3,
    title: 'The download was damaged',
    text: 'What the board downloaded did not match the SHA-256 digest of the release, so the board ' + 'discarded it.',
  },
  header_mismatch: {
    at: 3,
    title: 'Not the announced version',
    text:
      'The image the board downloaded does not carry the version that was announced, so the board ' + 'discarded it.',
  },
  // From firmware 1.16.0 the board reads which board and flash layout an image is for, once it has it.
  incompatible_board: {
    at: 3,
    title: 'The image is for another board',
    text: 'The image the board downloaded is built for another kind of board, so the board discarded it.',
  },
  incompatible_layout: {
    at: 3,
    title: 'The image is for another flash layout',
    text: 'The image the board downloaded is built for another flash layout, so the board discarded it.',
  },
  flash_error: {
    at: null,
    title: 'The board could not store the update',
    text: 'Writing to the board’s flash memory failed.',
  },
  interrupted: {
    at: null,
    title: 'Interrupted',
    text: 'The board restarted before the update was complete.',
  },
  not_installed: {
    at: 4,
    title: 'Not installed',
    text:
      'The board restarted, but the bootloader did not start the new image. It turns away an image ' +
      'with a wrong signature or an older version.',
  },
  trial_lost: {
    at: 5,
    title: 'Its trial was cut short',
    text:
      'The board runs this image with nothing left to bring the old one back, because a restore of the ' +
      'golden image was interrupted right after it began. The image has proved nothing. Repeat the gesture ' +
      'at the board to finish the restore.',
    // This one did not keep the firmware it had.
    replaced: true,
  },
};

/**
 * Look a word up in one of the tables here. The word may come from a board, so names
 * that every object has, such as "constructor", must not count as entries.
 */
function entryOf(table, name) {
  return typeof name === 'string' && Object.hasOwn(table, name) ? table[name] : undefined;
}

/**
 * `failed` is the step at which the update went wrong, `stopped` the step the board had
 * reached when it was told to stop or went quiet: nothing went wrong there, and nothing
 * after it took place. `refusal` calls the failed step what it was when nobody turned
 * the update down by hand. `unknown` says that nothing can be told about the steps after
 * the ones that are done. `lastSeen` says that `stopped` is only where the board was when
 * it was last heard of, and `word` then says so instead of the word for a stop.
 */
function steps(
  done,
  {
    current = null,
    failed = null,
    stopped = null,
    ended = false,
    refusal = null,
    unknown = false,
    lastSeen = false,
  } = {}
) {
  return STEPS.map((step, index) => {
    let state = unknown ? 'unknown' : 'upcoming';
    if (index < done) state = 'done';
    else if (index === failed) state = 'failed';
    else if (index === stopped) state = 'stopped';
    else if (index === current) state = 'current';
    else if (ended) state = 'skipped';
    let label = step.name;
    if (state === 'current' || state === 'stopped') label = step.doing ?? step.name;
    else if (state === 'failed') label = refusal ?? step.failed ?? step.name;
    return lastSeen && state === 'stopped' ? { label, state, word: 'last seen here' } : { label, state };
  });
}

const mayHaveInstalled = (entry) => entry.status === 'SUCCEEDED' || entry.status === 'IN_PROGRESS';

/** The other deployment that put this version on a board, from the board's own list of updates. */
function otherInstall(history, deployment, version) {
  const other = (history ?? []).find(
    (entry) =>
      entry.deployment !== deployment &&
      (entry.version ?? versionOfDeployment(entry.deployment)) === version &&
      mayHaveInstalled(entry)
  );
  return other?.deployment ?? null;
}

/** True if a job that this console did not start, whose version it cannot know, may have put a version on a board. */
function outsideInstall(history) {
  return history.some((entry) => !(entry.version ?? versionOfDeployment(entry.deployment)) && mayHaveInstalled(entry));
}

/**
 * What became of a board after an update ended, where it reports something else than it
 * did then. How it got there is not on record, so that is not said.
 */
function movedSince(board, ranAtEnd) {
  const now = board?.fw?.version;
  if (!now || !ranAtEnd || now === ranAtEnd) return '';
  return board.online ? ` It has since moved to ${now}.` : ` When last seen, it had moved to ${now}.`;
}

function firstSentence(text) {
  const end = text.indexOf('. ');
  return end === -1 ? text : text.slice(0, end + 1);
}

function description(tone, icon, title, text, timeline, extra = {}) {
  return {
    tone,
    icon,
    title,
    text,
    brief: firstSentence(text),
    steps: timeline,
    progress: null,
    code: null,
    next: null,
    retry: false,
    ...extra,
  };
}

const STILL_OPEN = ' The update stays open until the board reports back or the time limit ends.';
const TRIAL_RULE =
  'It is kept once the board has reconnected to AWS IoT; if it cannot, the bootloader puts the previous firmware back.';

/**
 * Describe one board's part in a deployment.
 *
 * @param {object} execution
 * @param {object} [known]
 * @param {object|null} [known.board]       the board as the board list has it, where that was read
 * @param {string|null} [known.deployment]  the id of the deployment
 * @param {string|null} [known.version]     the version the deployment installs
 * @param {Array|null} [known.history]      the board's own list of updates; null while it has
 *   not been read. A cancelled execution's `reported` is what the board reports now, so
 *   this is what tells whether another deployment is what put a version there.
 * @param {boolean} [known.historyCut]      that list leaves older updates out, so what it
 *   does not hold says nothing.
 * @param {boolean} [known.unread]          the board list has not been read yet, so that
 *   `board` being null does not mean that the board has nothing to say.
 * @returns {{tone: string, icon: string, title: string, text: string, brief: string,
 *   steps: Array, progress: number|null, code: string|null, next: string|null,
 *   retry: boolean}} `brief` is the first sentence of `text`; `progress` is the download
 *   in percent while the board reports it; `code` is the board's own reason when the
 *   console has no words for it; `next` is what to do about an update that ended short;
 *   `retry` says that offering the same release again makes sense. For a cancelled update
 *   `installed` says that it went through all the same, `installedBy` names the other
 *   deployment that installed this version, and `unsure` that this cannot be told yet.
 */
export function describeExecution(
  execution,
  { board = null, deployment = null, version = null, history = null, historyCut = false, unread = false } = {}
) {
  const { phase, reason, ranAtEnd, reported, online, progress, startedAt } = execution;
  // An update that the board saw through to its end: `ranAtEnd` is what the board said then,
  // kept with the job. It stays as it was however long ago that was, so it is told in the
  // past. Where the job holds none, or could not be read, no version is named at all.
  const ranThen = ranAtEnd ? ` The board was running ${ranAtEnd} at the time.` : '';
  const kept = ranAtEnd
    ? ` It kept running the firmware it had, ${ranAtEnd}.`
    : ' It kept running the firmware it had.';
  const since = movedSince(board, ranAtEnd);
  // An update the board could not see through (cancelled, timed out): `reported` is the
  // board's own latest report. An offline board's is old news, and says so.
  let reports = '';
  if (reported)
    reports = online
      ? ` The board reports that it runs ${reported}.`
      : ` When last seen, the board reported ${reported}.`;
  // Offering this release again only makes sense if the board would not refuse it: the rule
  // of the deployment dialog. While the board list has not been read it cannot be told.
  const mayRetry = !unread && !(board && alreadyRuns(board, version));
  const again = (next = 'To try again, start a new deployment.') => (mayRetry ? { next, retry: true } : {});
  const target = version ?? 'an update';
  // A step of an update under way. A board that has gone offline can only say where it was
  // when it was last heard of, so that is what is said, and it is not drawn as moving.
  const underWay = (iconName, at, { title, text, extra }, { was, quiet }) =>
    online
      ? description('live', iconName, title, text, steps(at, { current: at }), extra)
      : description(
          'idle',
          iconName,
          `Was ${was} when last seen`,
          quiet,
          steps(at, { stopped: at, unknown: true, lastSeen: true })
        );

  switch (phase) {
    case 'waiting_for_device':
      // A board the list knows and has never heard from: nothing to wait for by itself.
      if (!online && board && !board.lastSeen) {
        return description(
          'wait',
          'minus-circle',
          'Never connected',
          'Power it up and check that it was provisioned; it will see this update when it first connects.',
          steps(0, { current: 0 })
        );
      }
      if (!online) {
        return description(
          'wait',
          'offline',
          'Board offline',
          'The board is offline; it will see this update when it reconnects.',
          steps(0, { current: 0 })
        );
      }
      return description(
        'wait',
        'clock',
        'Not picked up yet',
        'The board is online but has not picked up the offer yet. That normally takes a few seconds.',
        steps(0, { current: 0 })
      );
    case 'waiting_for_button':
      // The one moment in an update when everything waits for a person, on a board that
      // reports that it does: said as an instruction, in a tone of its own.
      return description(
        'act',
        'press',
        `Press ${BUTTON_1} on the board`,
        `The board has the offer and waits for someone to press ${BUTTON_1}. LED1 blinks quickly ` +
          'while the offer is open; Button 2 declines it.',
        steps(1, { current: 1 })
      );
    case 'starting':
      // The board has taken the job on, and AWS has not said yet that it agrees.
      return underWay(
        'download',
        2,
        {
          title: 'Starting',
          text:
            'The board has told AWS IoT that it starts this update, and downloads the image as soon ' +
            'as AWS IoT agrees. The firmware it runs is not touched yet.',
        },
        {
          was: `starting ${target}`,
          quiet: `The board went offline as it started this update.${STILL_OPEN}`,
        }
      );
    case 'downloading':
      return underWay(
        'download',
        2,
        {
          title: progress === null ? 'Downloading' : `Downloading ${progress}%`,
          text:
            'The board is downloading the image into its spare flash slot. The firmware it runs is ' +
            'not touched yet.',
          extra: { progress, said: 'Downloading' },
        },
        {
          was: `downloading ${target}`,
          quiet: `The board went offline ${progress === null ? 'during the download' : `with the download at ${progress}%`}.${STILL_OPEN}`,
        }
      );
    case 'verifying':
      return underWay(
        'shield',
        3,
        {
          title: 'Checking the download',
          text:
            'The board is checking the size, the SHA-256 digest and the version in the signed header ' +
            'before it installs anything.',
        },
        {
          was: `checking the download of ${target}`,
          quiet: `The board went offline while it was checking the download.${STILL_OPEN}`,
        }
      );
    case 'rebooting':
      return underWay(
        'restart',
        4,
        {
          title: 'Restarting',
          text: 'The board is restarting. The bootloader checks the signature before it starts the new firmware.',
        },
        {
          was: `restarting into ${target}`,
          quiet: `The board went offline while it was restarting.${STILL_OPEN}`,
        }
      );
    case 'testing':
      return underWay(
        'pulse',
        5,
        {
          title: 'On trial',
          text: `The new firmware is running on trial. ${TRIAL_RULE}`,
        },
        {
          was: `on trial with ${target}`,
          quiet: `The board went offline with the new firmware on trial. ${TRIAL_RULE}`,
        }
      );
    case 'succeeded': {
      // That it went through stays true. That the board runs it is for the board to say today.
      const holds = Boolean(ranAtEnd) && board?.online === true && board.fw?.version === ranAtEnd && board.fw.confirmed;
      let told = 'The board confirmed the new firmware.';
      if (holds) told = `The board runs ${ranAtEnd} and has confirmed it.`;
      else if (ranAtEnd) told = `The board confirmed ${ranAtEnd} when this update ended.${since}`;
      return description('good', 'check-circle', 'Installed and confirmed', told, steps(STEPS.length));
    }
    case 'rolled_back':
      return description(
        'bad',
        'undo',
        'Rolled back',
        'The bootloader put the previous firmware back. The new firmware started but did not ' +
          `reconnect to AWS IoT, so it was never confirmed.${ranAtEnd ? ` That left the board on ${ranAtEnd}.` : ''}${since}`,
        steps(5, { failed: 5, ended: true }),
        // Old news once the board runs this version or a newer one.
        mayRetry ? { next: 'Fix the build, then upload a newer version and deploy that.' } : {}
      );
    case 'declined':
      return description(
        'warn',
        'minus-circle',
        'Declined on the board',
        `Someone pressed Button 2 on the board to decline this update. Nothing was installed.${ranThen}${since}`,
        steps(1, { failed: 1, ended: true }),
        again()
      );
    case 'refused': {
      // No reason on record: the job holds none, or could not be read. So whether a person
      // pressed Button 2 or the board refused is not known either.
      if (!reason) {
        return description(
          'warn',
          'ban',
          'Refused or declined',
          `This update was turned down on the board before anything was installed.${ranThen}${since}`,
          steps(1, { failed: 1, ended: true }),
          again()
        );
      }
      const why = entryOf(REFUSALS, reason);
      const said = why ? `Refused: ${why}.` : 'The board refused this update before installing anything.';
      // Offered again, a board that already runs this version gives the same answer.
      const way =
        reason === 'not_newer'
          ? { next: 'To put something else on it, upload a newer version and deploy that.' }
          : again('Deal with that first, then start a new deployment.');
      return description(
        'warn',
        'ban',
        'Refused by the board',
        `${said}${ranThen}${since}`,
        steps(1, { failed: 1, ended: true, refusal: 'Refused' }),
        { code: why ? null : reason, ...way }
      );
    }
    case 'failed': {
      const failure = entryOf(FAILURES, reason);
      if (failure) {
        return description(
          'bad',
          'x-circle',
          failure.title,
          `${failure.text}${failure.replaced ? '' : kept}${since}`,
          steps(
            failure.at ?? DOWNLOADED,
            failure.at === null ? { stopped: DOWNLOADED, ended: true } : { failed: failure.at, ended: true }
          ),
          again()
        );
      }
      // A refusal reported once the update was under way arrives as a failure.
      const why = entryOf(REFUSALS, reason);
      const said = why ? `The board stopped: ${why}.` : 'The board reported that the update failed.';
      // With no reason on record, where it stopped is not on record either.
      return description(
        'bad',
        'x-circle',
        'Failed',
        `${said}${kept}${since}`,
        steps(DOWNLOADED, reason ? { stopped: DOWNLOADED, ended: true } : { unknown: true }),
        { code: why ? null : reason, ...again() }
      );
    }
    case 'cancelled': {
      // What the board runs now, against what this deployment offered. `reported` is what it
      // says today, which can be long after this deployment ended. How it got there, and
      // when, is not on record: a deployment, a USB cable or a serial port, before or after.
      const [now, offered] = [reported, version].map((text) => (text ? parseVersion(text) : null));
      const movedOn = Boolean(now && offered) && compareVersions(now, offered) > 0;
      const runsIt = Boolean(reported) && reported === version;
      if (!startedAt) {
        // The offer was made, and withdrawn before the board acted on it. If the board runs
        // this version or a newer one all the same, this deployment is not what put it there,
        // and offering this one again would only be refused.
        if (runsIt || movedOn) {
          const installedBy = runsIt ? otherInstall(history, deployment, version) : null;
          return description(
            'idle',
            'stop',
            'Cancelled',
            `Cancelled before the board started, so this deployment installed nothing.${reports}`,
            steps(ACCEPTED, { ended: true }),
            installedBy ? { installedBy } : {}
          );
        }
        return description(
          'idle',
          'stop',
          'Cancelled',
          `Cancelled before the board started. Nothing was installed.${reports}`,
          steps(ACCEPTED, { ended: true }),
          again()
        );
      }
      // It stopped when it was told to, and a later deployment is what installed the version.
      const installedBy = runsIt ? otherInstall(history, deployment, version) : null;
      if (installedBy) {
        return description(
          'idle',
          'stop',
          'Cancelled',
          `Cancelled after the board had started, and it stopped there. Another deployment installed ${reported}.`,
          steps(DOWNLOADED, { stopped: DOWNLOADED, ended: true }),
          { installedBy }
        );
      }
      // A newer version came later. Whether this update had finished before that is not on
      // record: a board that AWS has cancelled can no longer report. Nothing is claimed, and
      // this version is not offered again, because the board would refuse it.
      if (movedOn) {
        return description(
          'idle',
          'stop',
          'Cancelled',
          `Cancelled after the board had started.${reports} This page cannot tell how this update ended.`,
          steps(DOWNLOADED, { unknown: true }),
          { unsure: true }
        );
      }
      // A board that was past its last look at AWS when the cancellation came ends up on the
      // new firmware all the same, and AWS has no more to say about it. So does one flashed
      // with this version by other means, so this takes the board's own word that its last
      // update went through, and a whole list of updates with no other job that can have done it.
      const wentThrough =
        runsIt &&
        board?.fw?.confirmed &&
        board.ota?.last === 'succeeded' &&
        Array.isArray(history) &&
        !historyCut &&
        !outsideInstall(history);
      if (wentThrough) {
        return description(
          'warn',
          'alert',
          'Installed despite the cancellation',
          'This deployment was cancelled, but the board had gone too far to be stopped. ' +
            `${online ? 'It now runs' : 'When last seen, it ran'} ${reported}.`,
          steps(STEPS.length),
          { next: 'To replace it, upload a newer version and deploy that.', installed: true }
        );
      }
      const reached = board?.ota && board.ota.job === deployment ? board.ota.state : null;
      if (reached === 'rebooting' || reached === 'testing') {
        const at = reached === 'rebooting' ? RESTARTED : TESTED;
        if (!online) {
          return description(
            'idle',
            'restart',
            `Was ${reached === 'rebooting' ? `restarting into ${target}` : `on trial with ${target}`} when last seen`,
            'This deployment was cancelled, but the board was already restarting into the new firmware, and it ' +
              'has gone offline since. What it ends up running will show here.',
            steps(at, { stopped: at, unknown: true, lastSeen: true })
          );
        }
        return description(
          'live',
          'restart',
          'Finishing despite the cancellation',
          'This deployment was cancelled, but the board was already restarting into the new firmware ' +
            'and cannot be stopped. What it ends up running will show here.',
          steps(at, { current: at, ended: true })
        );
      }
      // The board runs this version, and nothing says how it got there: nothing is claimed.
      if (runsIt) {
        return description(
          'idle',
          'stop',
          'Cancelled',
          `Cancelled after the board had started. ${online ? 'The board now runs' : 'When last seen, the board ran'} ${reported}; ` +
            'how it got there is not on record.',
          steps(DOWNLOADED, { unknown: true }),
          { unsure: true }
        );
      }
      // The board list decides between "it stopped" and "it is restarting and cannot be
      // stopped". Until it has been read, neither is said.
      if (unread) {
        return description(
          'idle',
          'stop',
          'Cancelled',
          'Cancelled after the board had started. What the board did next is still being read.',
          steps(DOWNLOADED, { unknown: true }),
          { unsure: true }
        );
      }
      return description(
        'idle',
        'stop',
        'Cancelled',
        'Cancelled after the board had started. A board asks AWS before it installs, so it stops ' +
          `there and keeps the firmware it had.${reports}`,
        steps(reached === 'verifying' ? VERIFIED : DOWNLOADED, {
          stopped: reached === 'verifying' ? VERIFIED : DOWNLOADED,
          ended: true,
        }),
        again()
      );
    }
    case 'timed_out':
      return description(
        'bad',
        'hourglass',
        'Timed out',
        `The board started but did not report a result before the time limit.${reports}`,
        steps(DOWNLOADED, { stopped: DOWNLOADED, ended: true }),
        again('Check that the board is powered and online, then start a new deployment.')
      );
    case 'removed':
      return description(
        'idle',
        'minus',
        'Removed',
        'This board was taken out of the deployment.',
        steps(0, { ended: true })
      );
    default:
      return description(
        'idle',
        'minus',
        'Unknown state',
        'The server reported a state this console does not know.',
        steps(0),
        { code: phase || null }
      );
  }
}

/** The words for an execution status alone, where no phase is known (a board's history). */
export function describeStatus(status) {
  switch (status) {
    case 'QUEUED':
      return { tone: 'wait', icon: 'clock', label: 'Waiting' };
    case 'IN_PROGRESS':
      return { tone: 'live', icon: 'restart', label: 'Updating' };
    case 'SUCCEEDED':
      return { tone: 'good', icon: 'check-circle', label: 'Installed' };
    case 'FAILED':
      return { tone: 'bad', icon: 'x-circle', label: 'Failed' };
    case 'TIMED_OUT':
      return { tone: 'bad', icon: 'hourglass', label: 'Timed out' };
    case 'REJECTED':
      return { tone: 'warn', icon: 'ban', label: 'Refused or declined' };
    case 'REMOVED':
      return { tone: 'idle', icon: 'minus', label: 'Removed' };
    case 'CANCELED':
      return { tone: 'idle', icon: 'stop', label: 'Cancelled' };
    default:
      return { tone: 'idle', icon: 'minus', label: 'Unknown' };
  }
}

// What the status alone cannot tell apart, and the board's last report can.
const OWN_WORDS = {
  FAILED: { rolled_back: { tone: 'bad', icon: 'undo', label: 'Rolled back' } },
  REJECTED: {
    declined: { tone: 'warn', icon: 'minus-circle', label: 'Declined on the board' },
    refused: { tone: 'warn', icon: 'ban', label: 'Refused by the board' },
  },
};

/**
 * The words for an entry of a board's history. `last` is how the board says its newest
 * update ended, for that entry; the others only have their status.
 */
export function describeHistory(status, last = null) {
  return entryOf(entryOf(OWN_WORDS, status) ?? {}, last) ?? describeStatus(status);
}

// `quiet` marks what is an absence of news, so that it is drawn as less than news.
const LAST_UPDATE = {
  none: { tone: 'idle', icon: 'minus', title: 'No update in progress', quiet: true },
  succeeded: { tone: 'good', icon: 'check-circle', title: 'Last update succeeded' },
  failed: { tone: 'bad', icon: 'x-circle', title: 'Last update failed' },
  rolled_back: { tone: 'bad', icon: 'undo', title: 'Last update was rolled back' },
  declined: { tone: 'warn', icon: 'minus-circle', title: 'Last update was declined on the board' },
  refused: { tone: 'warn', icon: 'ban', title: 'Last update was refused by the board' },
  cancelled: { tone: 'idle', icon: 'stop', title: 'Last update was cancelled' },
};

/**
 * Describe what a board last said about updates. `deployment` is the update it is
 * working on, if any. An offline board's words are old news, and say so.
 */
export function describeUpdate(device) {
  const { ota, online } = device;
  const settled = { text: '', progress: null, deployment: null };
  if (!ota) return { tone: 'idle', icon: 'minus', title: 'Nothing reported', quiet: true, ...settled };

  const version = versionOfDeployment(ota.job);
  const target = version ?? 'an update';
  // `was` is how the state reads for a board that has gone offline since, where the
  // title itself does not make a sentence after "Was".
  const live = (tone, icon, title, text, { progress = null, was = null } = {}) => ({
    tone: online ? tone : 'idle',
    icon,
    title: online ? title : `Was ${was ?? title.charAt(0).toLowerCase() + title.slice(1)} when last seen`,
    text: online ? text : '',
    progress: online ? progress : null,
    deployment: ota.job,
  });

  switch (ota.state) {
    case 'idle': {
      const last = entryOf(LAST_UPDATE, ota.last) ?? LAST_UPDATE.none;
      // The board's error is a reason code; say it in words where there are words for it.
      const refusal = entryOf(REFUSALS, ota.error);
      const why = entryOf(FAILURES, ota.error)?.title ?? (refusal ? `Because ${refusal}.` : '');
      const text = ota.last === 'failed' || ota.last === 'refused' ? why : '';
      const told = last === LAST_UPDATE.none && !online ? { title: 'No update in progress when last seen' } : null;
      return { ...last, ...told, ...settled, text };
    }
    case 'awaiting_user':
      return live(
        'act',
        'press',
        `Press ${BUTTON_1} on the board`,
        `${version ?? 'An update'} is on offer. Button 1 on the board installs it, Button 2 declines.`,
        { was: `waiting for ${BUTTON_1}` }
      );
    case 'downloading':
      return live('live', 'download', `Downloading ${target}`, '', { progress: ota.progress });
    case 'verifying':
      return live('live', 'shield', `Checking the download of ${target}`, '');
    case 'rebooting':
      return live('live', 'restart', `Restarting into ${target}`, '');
    case 'testing':
      return live('live', 'pulse', `On trial: ${target}`, 'It is kept once the board has reconnected.', {
        was: `on trial with ${target}`,
      });
    case 'bluetooth':
      return live(
        'live',
        'download',
        'Open for an update over Bluetooth',
        'A person at the board opened Bluetooth for a phone. Updates from here wait until it closes.',
        { was: 'open for an update over Bluetooth' }
      );
    default:
      return live('live', 'restart', 'Updating', '');
  }
}

/**
 * Where the boards of a deployment that went through stand today. That it went through is
 * on record for good; that they still run it is for them to say.
 *
 *   'current'   every one of them is online, on this version, and has confirmed it
 *   'unheard'   nothing speaks against it, but not all of them can say so
 *   'moved'     `moved` holds the ones that report another version
 */
export function installStanding(deployment, devices) {
  const boards = (devices ?? []).filter((device) => deployment.things.includes(device.thing));
  const moved =
    deployment.version === null ? [] : boards.filter((device) => device.fw && device.fw.version !== deployment.version);
  if (moved.length > 0) return { state: 'moved', boards, moved };
  const current =
    boards.length > 0 &&
    boards.length === deployment.things.length &&
    boards.every((device) => device.online && device.fw?.version === deployment.version && device.fw.confirmed);
  return { state: current ? 'current' : 'unheard', boards, moved };
}

/**
 * The badge for a deployment as a whole. `said` is the sentence for one that is over and
 * has something to tell, good or bad, on a page that would otherwise only say that nothing
 * is going on. `devices` is the board list, where it has been read: without it, what a
 * deployment installed is only told as something that happened.
 */
export function describeDeployment(deployment, devices = null) {
  const { status, counts, things } = deployment;
  const total = things.length || COUNTS.reduce((sum, name) => sum + counts[name], 0);
  switch (status) {
    case 'IN_PROGRESS':
      return counts.inProgress > 0
        ? { tone: 'live', icon: 'restart', label: 'Updating' }
        : { tone: 'wait', icon: 'clock', label: 'Waiting for boards' };
    case 'COMPLETED':
      if (total > 0 && counts.succeeded === total) {
        const what = deployment.version ?? 'The update';
        const verb = installStanding(deployment, devices).state === 'current' ? 'is' : 'was';
        return {
          tone: 'good',
          icon: 'check-circle',
          label: 'Succeeded',
          said: `${what} ${verb} installed and confirmed${total === 1 ? '' : ` on ${total} boards`}.`,
        };
      }
      if (counts.succeeded > 0) {
        return {
          tone: 'warn',
          icon: 'alert',
          label: 'Partly succeeded',
          said: 'The last deployment partly succeeded.',
        };
      }
      if (counts.failed + counts.timedOut > 0) {
        return { tone: 'bad', icon: 'x-circle', label: 'Failed', said: 'The last deployment failed.' };
      }
      return { tone: 'idle', icon: 'minus-circle', label: 'Not installed' };
    case 'CANCELED':
      // Cancelling leaves boards that had started alone: the badge does not hide them.
      if (counts.inProgress > 0) {
        return {
          tone: 'live',
          icon: 'restart',
          label: `Cancelled, ${plural(counts.inProgress, 'board')} still working`,
        };
      }
      if (counts.succeeded > 0) {
        return {
          tone: 'warn',
          icon: 'alert',
          label: `Cancelled, ${plural(counts.succeeded, 'board')} finished`,
          said: `The last deployment was cancelled, but ${plural(counts.succeeded, 'board')} finished it.`,
        };
      }
      return { tone: 'idle', icon: 'stop', label: 'Cancelled' };
    case 'SCHEDULED':
      return { tone: 'wait', icon: 'clock', label: 'Scheduled' };
    case 'DELETION_IN_PROGRESS':
      return { tone: 'idle', icon: 'minus', label: 'Being deleted' };
    default:
      return { tone: 'idle', icon: 'minus', label: 'Unknown' };
  }
}

const COUNT_WORDS = [
  ['succeeded', 'succeeded', 'good', 'check-circle'],
  ['inProgress', 'updating', 'live', 'restart'],
  ['queued', 'waiting', 'wait', 'clock'],
  ['failed', 'failed', 'bad', 'x-circle'],
  ['timedOut', 'timed out', 'bad', 'hourglass'],
  ['rejected', 'refused or declined', 'warn', 'ban'],
  ['canceled', 'cancelled', 'idle', 'stop'],
  ['removed', 'removed', 'idle', 'minus'],
];

/**
 * The non-zero board counts of a deployment, in a fixed order, with their words.
 * `atButton` of the waiting boards are waiting for a person, which is told apart where
 * the board list says so.
 */
export function describeCounts(counts, atButton = 0) {
  const pressing = Math.min(atButton, counts.queued);
  const lines = COUNT_WORDS.filter(
    ([name]) => counts[name] > 0 && !(name === 'queued' && counts.queued === pressing)
  ).map(([name, label, tone, icon]) => ({
    name,
    count: name === 'queued' ? counts.queued - pressing : counts[name],
    label,
    tone,
    icon,
  }));
  if (pressing > 0) {
    lines.unshift({
      name: 'atButton',
      count: pressing,
      label: `waiting for ${BUTTON_1}`,
      tone: 'act',
      icon: 'press',
    });
  }
  return lines;
}

/**
 * What to say to a screen reader about the boards in a list, compared with what they
 * were when `before` was made. Only a change of state is news, not every percent.
 * Returns the new record and the sentences. The first look at a board says nothing.
 */
export function boardChanges(before, devices) {
  const seen = new Map();
  const said = [];
  for (const device of devices) {
    const { title } = describeUpdate(device);
    seen.set(device.thing, title);
    if (before.has(device.thing) && before.get(device.thing) !== title) {
      said.push(`${boardName(device, { short: true })}: ${title}.`);
    }
  }
  return { seen, said };
}

// People. An account is its id (the token's sub); the e-mail address is what it showed
// at the time and can be changed by its owner. Wherever a person is named, the id is
// within reach.

/** The start of an account id: enough to tell a handful of accounts apart at a glance. */
export function shortAccount(sub) {
  const id = typeof sub === 'string' ? sub : '';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** What to call a person: the address, or failing that the start of the account id. */
export function nameOf(person) {
  if (person?.email) return person.email;
  return person?.sub ? `account ${shortAccount(person.sub)}` : 'an unknown account';
}

// What each action of the activity log is called. `done` and `tried` read on into the entry's
// label: a version, a board, a token. Where `{}` stands in them the label goes there, and the
// words after it follow it. `doneAlone` and `triedAlone` are the whole sentence for an entry that
// has no label, as a request refused before it named anything. A deployment is named by the
// version it installs, and the boards it went to follow the sentence (auditBoards).
const AUDIT_ACTIONS = {
  'firmware.upload': {
    done: 'uploaded firmware',
    tried: 'tried to upload',
    triedAlone: 'tried to upload a file',
    icon: 'upload',
  },
  'firmware.revoke': {
    done: 'revoked firmware',
    tried: 'tried to revoke firmware',
    triedAlone: 'tried to revoke a release',
    icon: 'ban',
  },
  'deployment.create': {
    done: 'deployed',
    doneAlone: 'started a deployment',
    tried: 'tried to deploy',
    triedAlone: 'tried to start a deployment',
    icon: 'send',
  },
  'deployment.cancel': {
    done: 'cancelled the deployment of',
    tried: 'tried to cancel the deployment of',
    triedAlone: 'tried to cancel a deployment',
    icon: 'stop',
  },
  // From the phone apps, for an update over Bluetooth.
  'firmware.download': {
    done: 'downloaded {} to a phone',
    doneAlone: 'downloaded firmware to a phone',
    tried: 'tried to download',
    triedAlone: 'tried to download firmware',
    icon: 'download',
  },
  'pairing.read': {
    done: 'read the Bluetooth passkey of',
    tried: 'tried to read the Bluetooth passkey of',
    triedAlone: 'tried to read a Bluetooth passkey',
    icon: 'shield',
  },
  // The check a phone makes right before it sends a release to a board over Bluetooth. The
  // console cleared it; whether the board took it, only the board knows.
  'firmware.bluetooth_send': {
    done: 'was cleared to send {} over Bluetooth',
    doneAlone: 'was cleared to send firmware over Bluetooth',
    tried: 'tried to send {} over Bluetooth',
    triedAlone: 'tried to send firmware over Bluetooth',
    icon: 'chip',
  },
  // A person's own API tokens, named by their id; the token itself is never recorded.
  'token.create': {
    done: 'made API token',
    tried: 'tried to make API token',
    triedAlone: 'tried to make an API token',
    icon: 'key',
  },
  'token.revoke': {
    done: 'revoked API token',
    tried: 'tried to revoke API token',
    triedAlone: 'tried to revoke an API token',
    icon: 'key',
  },
  // A sign-in with password and code, on the website or the phone app (SIGNED_IN_ON).
  'account.sign_in': {
    done: 'signed in',
    tried: 'tried to sign in',
    triedAlone: 'tried to sign in',
    icon: 'user',
  },
  // A command that changed a board at its serial console, over USB from this console's Serial page
  // or a phone app, named by the board's device ID (SERIAL_WORDS).
  'serial.command': {
    done: 'ran a command on {} over USB',
    doneAlone: 'ran a command on a board over USB',
    tried: 'tried to put on record a command on {} over USB',
    triedAlone: 'tried to put on record a command run over USB',
    icon: 'chip',
  },
  // A command sent to a board over the internet (COMMAND_WORDS), and a person's own e-mail alerts.
  'board.command': {
    done: 'sent a command to',
    tried: 'tried to send a command to',
    triedAlone: 'tried to send a command to a board',
    icon: 'locate',
  },
  'alert.subscribe': {
    done: 'asked for e-mail alerts at',
    tried: 'tried to ask for e-mail alerts at',
    triedAlone: 'tried to ask for e-mail alerts',
    icon: 'bell',
  },
  'alert.unsubscribe': {
    done: 'stopped the e-mail alerts to',
    tried: 'tried to stop the e-mail alerts to',
    triedAlone: 'tried to stop e-mail alerts',
    icon: 'bell',
  },
  // The alert rules, for everybody who gets the alerts (cloud/api/src/handlers/alerts.mjs).
  'alert.rules': {
    done: 'changed the alert rules',
    doneAlone: 'changed the alert rules',
    tried: 'tried to change the alert rules',
    triedAlone: 'tried to change the alert rules',
    icon: 'bell',
  },
  // The fleet (docs/fleet.md): groups, staged rollouts, a phone's sighting, a release's note.
  'group.create': {
    done: 'made the group',
    tried: 'tried to make the group',
    triedAlone: 'tried to make a group',
    icon: 'list',
  },
  'group.update': {
    done: 'changed the group',
    tried: 'tried to change the group',
    triedAlone: 'tried to change a group',
    icon: 'list',
  },
  'group.delete': {
    done: 'deleted the group',
    tried: 'tried to delete the group',
    triedAlone: 'tried to delete a group',
    icon: 'list',
  },
  'group.rollback': {
    done: 'rolled back the group',
    tried: 'tried to roll back the group',
    triedAlone: 'tried to roll back a group',
    icon: 'restart',
  },
  'rollout.create': {
    done: 'started a staged rollout of',
    doneAlone: 'started a staged rollout',
    tried: 'tried to start a staged rollout of',
    triedAlone: 'tried to start a staged rollout',
    icon: 'send',
  },
  'rollout.cancel': {
    done: 'cancelled the staged rollout',
    tried: 'tried to cancel the staged rollout',
    triedAlone: 'tried to cancel a staged rollout',
    icon: 'stop',
  },
  // The console's own, when a canary has confirmed or a rollout stopped (cloud/api/src/tick.mjs).
  'rollout.advance': {
    done: 'went on with the staged rollout',
    tried: 'could not go on with the staged rollout',
    triedAlone: 'could not go on with a staged rollout',
    icon: 'send',
  },
  'rollout.stop': {
    done: 'stopped the staged rollout',
    tried: 'could not stop the staged rollout',
    triedAlone: 'could not stop a staged rollout',
    icon: 'stop',
  },
  'fleet.update_everything': {
    done: 'started updating everything',
    doneAlone: 'started updating everything',
    tried: 'tried to update everything',
    triedAlone: 'tried to update everything',
    icon: 'send',
  },
  // Each board of a group or the fleet back to its last good version (console 2.14.0).
  'fleet.rollback_last_good': {
    done: 'rolled back {} to last good firmware',
    doneAlone: 'rolled back to last good firmware',
    tried: 'tried to roll back {} to last good firmware',
    triedAlone: 'tried to roll back to last good firmware',
    icon: 'restart',
  },
  // Scheduled starts (console 2.20.0): made, changed and cancelled by a person; carried out by the console.
  'schedule.create': {
    done: 'scheduled the start',
    doneAlone: 'scheduled a start',
    tried: 'tried to schedule the start',
    triedAlone: 'tried to schedule a start',
    icon: 'clock',
  },
  'schedule.edit': {
    done: 'changed the scheduled start',
    tried: 'tried to change the scheduled start',
    triedAlone: 'tried to change a scheduled start',
    icon: 'clock',
  },
  'schedule.cancel': {
    done: 'cancelled the scheduled start',
    tried: 'tried to cancel the scheduled start',
    triedAlone: 'tried to cancel a scheduled start',
    icon: 'stop',
  },
  'schedule.start': {
    done: 'carried out the scheduled start',
    doneAlone: 'carried out a scheduled start',
    tried: 'could not carry out the scheduled start',
    triedAlone: 'could not carry out a scheduled start',
    icon: 'send',
  },
  'device.seen': {
    done: 'saw {} over Bluetooth',
    doneAlone: 'saw a board over Bluetooth',
    tried: 'tried to say a phone saw {}',
    triedAlone: 'tried to say a phone saw a board',
    icon: 'chip',
  },
  'firmware.notes': {
    done: 'changed the note of',
    tried: 'tried to change the note of',
    triedAlone: 'tried to change the note of a release',
    icon: 'file',
  },
  // The phone apps (the Apps page): the URL a build sends an APK to S3 with, the APK published once the
  // console has checked what arrived, and a download link handed out, for a person or a phone's QR code.
  'app.upload': {
    done: 'started publishing the Android app',
    tried: 'tried to start publishing the Android app',
    triedAlone: 'tried to start publishing the Android app',
    icon: 'upload',
  },
  'app.publish': {
    done: 'published the Android app',
    tried: 'tried to publish the Android app',
    triedAlone: 'tried to publish the Android app',
    icon: 'package',
  },
  'app.download': {
    done: 'downloaded the Android app',
    tried: 'tried to download the Android app',
    triedAlone: 'tried to download the Android app',
    icon: 'download',
  },
  // The iPhone app's unsigned IPAs, the same three steps, a download also through a member's SideStore
  // source, and that source's link, made and turned off by its owner (named by its id, never the key).
  'app.ios_upload': {
    done: 'started publishing the iPhone app',
    tried: 'tried to start publishing the iPhone app',
    triedAlone: 'tried to start publishing the iPhone app',
    icon: 'upload',
  },
  'app.ios_publish': {
    done: 'published the iPhone app',
    tried: 'tried to publish the iPhone app',
    triedAlone: 'tried to publish the iPhone app',
    icon: 'package',
  },
  'app.ios_download': {
    done: 'downloaded the iPhone app',
    tried: 'tried to download the iPhone app',
    triedAlone: 'tried to download the iPhone app',
    icon: 'download',
  },
  'app.source_create': {
    done: 'made SideStore link',
    doneAlone: 'made a SideStore link',
    tried: 'tried to make SideStore link',
    triedAlone: 'tried to make a SideStore link',
    icon: 'key',
  },
  'app.source_revoke': {
    done: 'turned off SideStore link',
    doneAlone: 'turned off a SideStore link',
    tried: 'tried to turn off SideStore link',
    triedAlone: 'tried to turn off a SideStore link',
    icon: 'key',
  },
  // The customer site's accounts, from the Customers page (docs/customer-site.md): a customer by
  // their e-mail address, a board by its name with the customer's address after it (CUSTOMER_BOARD).
  'customer.create': {
    done: 'invited the customer',
    tried: 'tried to invite the customer',
    triedAlone: 'tried to invite a customer',
    icon: 'user',
  },
  'customer.resend': {
    done: 'sent the invitation again to',
    doneAlone: 'sent an invitation again',
    tried: 'tried to send the invitation again to',
    triedAlone: 'tried to send an invitation again',
    icon: 'send',
  },
  // "a customer" is the customer's address where the entry has it.
  'customer.assign': {
    done: 'gave {} to a customer',
    tried: 'tried to give {} to a customer',
    triedAlone: 'tried to give a board to a customer',
    icon: 'chip',
  },
  'customer.unassign': {
    done: 'took {} back from a customer',
    tried: 'tried to take {} back from a customer',
    triedAlone: 'tried to take a board back from a customer',
    icon: 'undo',
  },
  'customer.disable': {
    done: 'switched off the customer account of',
    tried: 'tried to switch off the customer account of',
    triedAlone: 'tried to switch off a customer account',
    icon: 'ban',
  },
  'customer.enable': {
    done: 'switched on the customer account of',
    tried: 'tried to switch on the customer account of',
    triedAlone: 'tried to switch on a customer account',
    icon: 'check',
  },
  'customer.reset_password': {
    done: 'reset the password of the customer',
    tried: 'tried to reset the password of the customer',
    triedAlone: 'tried to reset a customer’s password',
    icon: 'key',
  },
  'customer.remove': {
    done: 'removed the customer',
    tried: 'tried to remove the customer',
    triedAlone: 'tried to remove a customer',
    icon: 'x',
  },
  // What a customer did on the customer site (docs/customer-site.md, "Customer actions"): "A customer" did it.
  'customer_action.rename': {
    done: 'named {} on the customer site',
    tried: 'tried to name {} on the customer site',
    triedAlone: 'tried to name a board on the customer site',
    icon: 'chip',
  },
  'customer_action.notifications': {
    done: 'chose their e-mails on the customer site',
    tried: 'tried to choose their e-mails on the customer site',
    triedAlone: 'tried to choose their e-mails on the customer site',
    icon: 'send',
  },
  // The team's accounts, from the Team page (docs/accounts.md): a person by their address where the entry has it.
  'account.invite': {
    done: 'invited',
    doneAlone: 'invited a person to the team',
    tried: 'tried to invite',
    triedAlone: 'tried to invite a person to the team',
    icon: 'user',
  },
  'account.resend': {
    done: 'sent the team invitation again to',
    doneAlone: 'sent a team invitation again',
    tried: 'tried to send the team invitation again to',
    triedAlone: 'tried to send a team invitation again',
    icon: 'send',
  },
  'account.tier': {
    done: 'changed the tier of',
    tried: 'tried to change the tier of',
    triedAlone: 'tried to change a tier',
    icon: 'shield',
  },
  'account.disable': {
    done: 'disabled the account of',
    tried: 'tried to disable the account of',
    triedAlone: 'tried to disable an account',
    icon: 'ban',
  },
  'account.enable': {
    done: 'enabled the account of',
    tried: 'tried to enable the account of',
    triedAlone: 'tried to enable an account',
    icon: 'check',
  },
  'account.reset': {
    done: 'reset the password and authenticator of',
    tried: 'tried to reset the password and authenticator of',
    triedAlone: 'tried to reset an account',
    icon: 'key',
  },
  'account.remove': {
    done: 'removed the account of',
    tried: 'tried to remove the account of',
    triedAlone: 'tried to remove an account',
    icon: 'x',
  },
  // A board's name given in the console, or taken away (cloud/api/src/lib/names.mjs).
  'device.rename': {
    done: 'renamed',
    doneAlone: 'renamed a board',
    tried: 'tried to rename',
    triedAlone: 'tried to rename a board',
    icon: 'chip',
  },
  'device.register': {
    done: 'registered',
    doneAlone: 'registered a board',
    tried: 'tried to register',
    triedAlone: 'tried to register a board',
    icon: 'chip',
  },
  // Board setup's Wi-Fi defaults, handed to a release manager: whether any, never which.
  'setup.wifi_defaults': {
    done: 'read the Wi-Fi defaults',
    tried: 'tried to read the Wi-Fi defaults',
    triedAlone: 'tried to read the Wi-Fi defaults',
    icon: 'lock',
  },
  // An export of the Database page, by its table: which filters and how many items are its facts.
  'db.export': {
    done: 'exported the {} table',
    doneAlone: 'exported from the database',
    tried: 'tried to export the {} table',
    triedAlone: 'tried to export from the database',
    icon: 'download',
  },
  // The weekly fleet report (docs/reports.md): a week as CSV, by its Monday, and its Monday e-mail.
  'report.export': {
    done: 'downloaded the weekly report of',
    doneAlone: 'downloaded a weekly report',
    tried: 'tried to download the weekly report of',
    triedAlone: 'tried to download a weekly report',
    icon: 'download',
  },
  'report.settings': {
    done: 'changed the Monday e-mail of the weekly report',
    doneAlone: 'changed the Monday e-mail of the weekly report',
    tried: 'tried to change the Monday e-mail of the weekly report',
    triedAlone: 'tried to change the Monday e-mail of the weekly report',
    icon: 'bell',
  },
};

// What the schedule that moves staged rollouts on did is the console's own: no person asked for it.
const CONSOLE_ACTIONS = Object.freeze(['rollout.advance', 'rollout.stop']);

/** Who did what an entry says: a person, for what the schedule did the console, or a customer on the customer site. */
export function actorOf(entry) {
  if (entry?.by === 'customer') return 'A customer';
  return CONSOLE_ACTIONS.includes(entry?.action) && !entry.actor?.sub ? 'The console' : nameOf(entry?.actor);
}

// The two customer actions whose target is a board, and whose sentence ends with the customer.
const CUSTOMER_BOARD = new Set(['customer.assign', 'customer.unassign']);

const SIGNED_IN_ON = { web: 'signed in on the website', phone: 'signed in on the phone app' };

// What a command sent to a board asked of it (cloud/api/src/handlers/commands.mjs), with the board where {} stands.
export const COMMAND_WORDS = {
  identify: 'asked {} to blink its lights',
  report: 'asked {} to report now',
  memfault: 'asked {} to send its Memfault data now',
};

// What a command at a board's serial console did (cloud/api/src/handlers/serial.mjs), with the
// board where {} stands. What was typed after the command is never recorded, so never said.
export const SERIAL_WORDS = {
  INIT: 'set up {} from factory mode over USB',
  SET_ID: 'changed the device ID of {} over USB',
  RESET_CONFIG: 'cleared the cloud settings of {} over USB',
  FACTORY_RESET: 'erased {} back to factory mode over USB',
  WIFI: 'set the Wi-Fi network of {} over USB',
  WIFI_SEC: 'set the Wi-Fi network and its security mode of {} over USB',
  CLEAR_WIFI: 'erased the Wi-Fi network of {} over USB',
  CLOUD: 'set the AWS IoT endpoint and download address of {} over USB',
  KEYGEN: 'made a new device key on {} over USB',
  MQTT_HOST: 'set the AWS IoT endpoint of {} over USB',
  MQTT_RECONNECT: 'reconnected {} to AWS IoT over USB',
  BUTTON: 'pressed a button of {} over USB',
  REBOOT: 'restarted {} over USB',
  ENTER_BOOTLOADER: 'restarted {} into its bootloader over USB',
  BT_PASSKEY: 'set or erased the Bluetooth passkey of {} over USB',
  BT_OFFLINE: 'made a new Bluetooth passkey for {} over USB',
};

// What scripts/firmware/ota.sh without an API token, and the test bench, call their requests. They
// invoke the API function directly, with AWS credentials and without API Gateway or a
// sign-in, in a person's name. API Gateway makes up the id of every request that comes
// through it, so nobody can put this on a request from a browser, or from a script that
// uses an API token: such a change carries the token's id instead.
const SCRIPTED_REQUEST = 'bench-';

const AUDIT_OUTCOMES = {
  rejected: { tone: 'warn', icon: 'ban', label: 'Refused' },
  denied: { tone: 'bad', icon: 'lock', label: 'Not allowed' },
  error: { tone: 'bad', icon: 'alert', label: 'Server error' },
};

// Why the server refused a request or failed at it, in words, for a log line that only has
// the code. Every code the API can record is here: a test goes through its source for them.
export const REFUSAL_WORDS = {
  account_inactive: 'The account is not active',
  already_cancelled: 'That deployment was already cancelled',
  already_finished: 'That deployment had already finished',
  already_revoked: 'That release was already revoked',
  already_subscribed: 'Alerts already go to that address',
  audit_failed: 'The change could not be written to this log',
  bad_header: 'The image header cannot be read',
  bad_signing_key: 'The server’s signing key cannot be read',
  cancel_refused: 'AWS IoT would not cancel it',
  forbidden: 'This account may not do that',
  internal_error: 'Something went wrong on the server',
  invalid_body: 'The request could not be read',
  invalid_deployment: 'Not a valid deployment ID',
  invalid_filename: 'The file name has characters the server does not accept, or is too long',
  invalid_json: 'The request could not be read',
  invalid_seconds: 'A board blinks for 1 to 60 seconds',
  invalid_thing: 'Not a valid board name',
  invalid_things: 'The list of boards is not valid',
  invalid_version: 'Not a valid version number',
  no_email: 'The account has no e-mail address',
  not_confirmed: 'The subscription waits for its e-mail to be confirmed',
  not_found: 'There is nothing at that address',
  not_subscribed: 'Alerts do not go to that address',
  payload_too_large: 'The request was too large',
  release_manager_required: 'Only a release manager can do this',
  revoke_incomplete: 'The revocation did not finish',
  throttled: 'AWS asked the server to slow down',
  timeout: 'The server ran out of time',
  unauthorized: 'The sign-in was not accepted',
  unknown_deployment: 'There is no such deployment',
  unknown_device: 'A board is not registered',
  unknown_issue: 'No such issue in this window',
  invalid_issue: 'Not a valid issue id',
  unknown_version: 'There is no such release',
  image_unavailable: 'The image could not be read; it may have been revoked',
  image_mismatch: 'The stored image is not the one that was verified',
  invalid_name: 'Not the name of a board over Bluetooth',
  invalid_board: 'Not the name of a board over Bluetooth',
  invalid_sha256: 'Not a valid SHA-256',
  sha256_mismatch: 'The phone’s image is not the release’s',
  no_pairing: 'No board online was pairing under that name',
  unsupported_flags: 'Uses image options this project does not',
  upload_conflict: 'Another upload was under way at that moment',
  wrong_key: 'Signed with a different key than this project’s',
  bad_signature: 'The signature is not valid',
  unsigned: 'Not signed',
  hash_mismatch: 'The file is damaged',
  bad_magic: 'Not an MCUboot image',
  not_an_image: 'Not an MCUboot image',
  too_small: 'Too small to be a firmware image',
  too_large: 'Too large for the board’s slot',
  truncated: 'Shorter than its header says',
  wrong_target: 'Not built for this product’s flash layout',
  trailing_data: 'Has data after the signature',
  unexpected_tlv: 'Not signed the way this project requires',
  malformed_tlv: 'The signature area cannot be read',
  bad_signature_encoding: 'The signature cannot be read',
  version_exists: 'That version is already registered',
  version_not_newer: 'Not newer than the highest version registered',
  version_zero: 'Version 0.0.0+0 is never accepted',
  device_busy: 'A board had an unfinished update',
  release_revoked: 'The release is revoked',
  invalid_token: 'The API token was not valid, or had been revoked or had expired',
  token_not_allowed: 'An API token cannot be used for that',
  phone_not_allowed: 'The phone app’s sign-in cannot be used for that',
  phone_sign_in_again: 'A change from the phone needs a sign-in in the last 15 minutes',
  too_many_tokens: 'That person already had as many API tokens as one may have',
  invalid_token_name: 'The token’s name was empty, too long or not one line',
  invalid_days: 'The token’s lifetime was not a whole number of days from 1 to 90',
  invalid_token_id: 'Not a valid token ID',
  unknown_token: 'That person has no API token with that ID',
  token_already_revoked: 'That API token was already revoked',
  invalid_time: 'A time was not written the way the server reads times',
  invalid_range: 'The time range was empty, backwards or longer than 31 days',
  invalid_kinds: 'The list of kinds of event was not valid',
  invalid_hours: 'The number of hours was not a whole number from 1 to 168',
  invalid_tags: 'The list of sources of the board log was not valid',
  // Search and filters of the long lists (docs/search-filters.md).
  invalid_search: 'The search was empty, longer than 100 characters or not one line',
  invalid_level: 'The level was neither info nor warn',
  invalid_actions: 'The list of kinds of activity was not valid',
  invalid_outcomes: 'The list of outcomes was not valid',
  invalid_command: 'Not a command that changes a board at its serial console',
  invalid_device: 'Not a board’s device ID',
  unexpected_field: 'The request held more than the command, the device ID and the version',
  rate_limited: 'More serial console commands in a minute than are recorded for one person',
  // The fleet (docs/fleet.md): board types, groups, staged rollouts, sightings and notes.
  incompatible_board: 'The release is for another type of board',
  incompatible_layout: 'The release is built for another flash layout',
  invalid_layout_tlv: 'The flash layout in the image was not a positive whole number',
  invalid_layout: 'The flash layout was not a whole number from 1',
  bluetooth_only: 'The board has no Wi-Fi and updates over Bluetooth from a phone',
  invalid_type: 'Not a board type this console knows',
  unknown_board: 'The image is for a board type this console does not know',
  invalid_board_tlv: 'The board type in the image was not one short word',
  invalid_notes: 'The note was not one line of up to 500 characters',
  unknown_group: 'There is no such group',
  invalid_group: 'Not the id of a group',
  name_taken: 'Another group already has that name',
  too_many_groups: 'There can be at most 50 groups',
  group_changed: 'Someone changed the group at the same moment',
  nothing_to_change: 'The request named nothing to change',
  unknown_rollout: 'There is no such staged rollout',
  invalid_rollout: 'Not the id of a staged rollout',
  invalid_target: 'Not a target of a rollout: boards, a group, a type or the fleet',
  invalid_types: 'The list of board types and their releases was not valid',
  invalid_canary: 'The canary was not a whole number from 1 to 5',
  invalid_wave: 'The first wave was not a whole number from 1 to 50 boards',
  invalid_abortPercent: 'The share of failures to stop at was not a whole number from 1 to 100',
  invalid_stages: 'The number of stages was not a whole number from 1 to 10',
  invalid_batch: 'The batch sizes were not a percent or a count for each stage but the last',
  invalid_soakMinutes: 'The soak time was not a whole number of minutes from 0 to 60',
  nothing_to_deploy: 'No board would take the release',
  too_many_boards: 'A rollout takes at most 100 boards',
  plan_changed: 'The plan had changed since it was shown',
  no_older_release: 'There is no older release of that type to go back to',
  gate_required: 'A roll back to last good runs with the health gate on',
  invalid_targets: 'The releases asked for were not a list of versions, each with its boards',
  rollout_changed: 'The rollout moved on while it was being cancelled',
  rollout_unrecorded: 'The rollout could not be recorded, so its canary was withdrawn',
  partly_started: 'Only some of the rollouts could be started',
  invalid_healthGate: 'The health gate was not on or off with 0 to 120 minutes',
  // Scheduled starts and maintenance windows (cloud/api/src/handlers/schedules.mjs, groups.mjs).
  invalid_kind: 'Not something that can be scheduled: a deployment, a staged rollout or a roll back to last good',
  invalid_at: 'The time was not a local date and time',
  invalid_timeZone: 'Not a time zone',
  invalid_request: 'What to start was not given',
  invalid_schedule: 'Not the id of a scheduled start',
  unknown_schedule: 'There is no such scheduled start',
  schedule_in_past: 'The time was less than a minute from now, or past',
  schedule_too_far: 'The time was more than 30 days ahead',
  schedule_over: 'The scheduled start has begun, ended or was cancelled',
  schedule_changed: 'Someone changed the scheduled start at the same moment',
  too_many_schedules: 'There can be at most 50 scheduled starts',
  invalid_window: 'The maintenance window was not days, a start and an end, and a time zone',
  creator_not_allowed: 'Whoever scheduled it is no longer an enabled release manager, so it did not start',
  // The alert rules (cloud/api/src/handlers/alerts.mjs).
  invalid_rules: 'The alert rules asked for were not rules, or not within their limits',
  rules_changed: 'Someone changed the alert rules at the same moment',
  // The phone apps (cloud/api/src/handlers/apps.mjs): publishing the Android app, and its download links.
  version_code_not_higher: 'Its versionCode is not higher than the newest Android app’s',
  apk_missing: 'No APK had arrived in S3 for that version',
  // The iPhone app's IPAs, and a member's SideStore link (cloud/api/src/handlers/apps.mjs, sidestore.mjs).
  ipa_missing: 'No IPA had arrived in S3 for that version',
  ipa_unreadable: 'The IPA that arrived could not be read as an iPhone app',
  ipa_mismatch: 'The IPA was not the app, the version, the build or the configuration it was published as',
  build_not_higher: 'Its build is not higher than the newest iPhone app’s',
  invalid_build: 'The build was not a whole number',
  unknown_source: 'There was no SideStore link at that address',
  no_source: 'There was no SideStore link to turn off',
  source_conflict: 'The SideStore link was being changed at the same moment',
  size_mismatch: 'The APK that arrived was of another size',
  checksum_missing: 'The APK that arrived had no SHA-256 of its own',
  publish_conflict: 'Another release of the app was being published at the same moment',
  invalid_via: 'Not a way to hand out a link: a QR code, or none',
  invalid_version_code: 'The versionCode was not a whole number',
  invalid_size: 'The size was not a whole number of bytes, up to 100 MB',
  unversioned: 'The bucket kept no version of the APK',
  // The customer site's customers (cloud/api/src/handlers/customers.mjs) and its own API.
  customers_not_set_up: 'This deployment has no customer pool',
  customer_site_has_no_address: 'The customer site has no address yet, so an invitation would lead nowhere',
  invalid_customer: 'Not a valid customer ID',
  invalid_email: 'Not an e-mail address',
  unknown_customer: 'There is no customer with that ID',
  customer_exists: 'There is a customer with that address already',
  customer_not_invited: 'That customer has signed in already, so there was no invitation to send again',
  customer_not_signed_in: 'That customer had not chosen a password yet, so there was none to reset',
  customer_disabled: 'That customer was switched off',
  // The team's accounts (cloud/api/src/handlers/team.mjs).
  invalid_account: 'Not a valid account ID',
  invalid_tier: 'Not a tier: viewer or release manager',
  unknown_account: 'There is no account with that ID',
  account_exists: 'There is an account with that address already',
  account_not_invited: 'That person has signed in already, so there was no invitation to send again',
  account_not_signed_in: 'That person had not signed in yet, so there was nothing to reset',
  account_disabled: 'That account was disabled',
  account_has_no_tier: 'That account had no tier',
  own_account: 'Nobody can demote, disable, reset or remove their own account',
  last_release_manager: 'It would have left no enabled release manager',
  already_assigned: 'That board was that customer’s already',
  board_taken: 'That board belongs to another customer',
  not_assigned: 'That board was not that customer’s',
  not_your_board: 'That customer has no such board',
  // A customer's own changes on the customer site (cloud/api/src/customer/app.mjs).
  invalid_label: 'Not a name a board can have',
  label_too_long: 'A board’s name is at most 40 characters',
  unknown_field: 'The request had a field that cannot be changed there',
  invalid_choice: 'An e-mail can only be turned on or off',
  nothing_chosen: 'No e-mail was turned on or off',
  too_many_changes: 'Too many changes in a short time',
  unavailable: 'The account could not be checked just then',
  invalid_id: 'Not a board’s identifier of 16 hex digits',
  invalid_csr: 'Not a certificate signing request a board makes',
  csr_mismatch: 'The signing request is for another board',
  already_registered: 'That board has a certificate already',
  board_mismatch: 'That board is registered as another type',
  certificate_mismatch: 'AWS IoT issued a certificate for another key',
  // Board setup's Wi-Fi defaults (cloud/api/src/handlers/setup.mjs).
  wifi_defaults_unavailable: 'The console could not read its Wi-Fi defaults just then',
  wifi_defaults_invalid: 'The stored Wi-Fi defaults break the firmware’s rules',
  // The Database page (cloud/api/src/handlers/db.mjs).
  unknown_table: 'There is no such table',
  invalid_filter: 'A filter of the Database page was not valid',
  invalid_key: 'An item’s key was empty, too long or not plain text',
  invalid_format: 'An export is CSV or JSON',
  // The weekly fleet report (docs/reports.md).
  invalid_week: 'Not a week: a week is named by its Monday',
  unknown_week: 'There is no report of that week',
  invalid_report_format: 'A weekly report is downloaded as CSV',
  invalid_report_settings: 'The Monday e-mail is on or off, and nothing else',
  report_settings_changed: 'Someone changed the Monday e-mail at the same moment',
  unknown_item: 'There is no item with that key',
};

/** What a cancellation asked for, in the words of the dialog it is asked for in. */
function forceAsked(value) {
  if (value === 'true') return 'withdraw the offer and stop boards that had started';
  return value === 'false' ? 'withdraw the offer' : value;
}

/** Set when a request failed after AWS had cancelled the job: the entry says so all the same. */
function cancelledAnyway(value) {
  if (value === 'true') return 'all the same';
  return value === 'false' ? 'no' : value;
}

// The steps of a revocation after the mark, as the API names the ones it could not complete.
const REVOCATION_STEPS = {
  tag: 'refusing the image',
  cancel: 'cancelling the deployments',
  record: 'recording that it is done',
};

function stepsLeft(value) {
  return value
    .split(' ')
    .filter(Boolean)
    .map((step) => entryOf(REVOCATION_STEPS, step) ?? step)
    .join(', ');
}

// What the API records with an entry, in the words of the console and in the order in
// which a line reads best. A label reads on into its value, like "Size 1,264 bytes";
// `sentence` marks a value in free words, which a colon sets off from its label. `code`
// marks a value that is an identifier and is set in the monospace face.
const AUDIT_DETAILS = {
  code: { label: 'Refused with', code: true },
  incomplete: { label: 'Left undone', say: stepsLeft, sentence: true },
  filename: { label: 'File', code: true },
  version: { label: 'Version', code: true },
  things: { label: 'Boards' },
  force: { label: 'Asked to', say: forceAsked },
  reason: { label: 'Reason', sentence: true },
  cancelled: { label: 'Cancelled', say: cancelledAnyway },
  size: { label: 'Size', say: (value) => exactBytes(Number(value)) || value },
  sha256: { label: 'SHA-256', code: true },
  // A change made with an API token, by the token's id. Entries from before November 2026 also
  // say when a token had been revoked or had expired; such a request leaves no entry now.
  token: { label: 'With API token', code: true },
  tokenState: { label: 'The token had', say: (value) => (value === 'revoked' ? 'been revoked' : value) },
  // The board a phone named when it asked to send over Bluetooth.
  board: { label: 'To board', code: true },
  // The board whose Bluetooth passkey was read, by its thing name. The page shows its own name.
  thing: { label: 'Board', code: true },
  // The boards of a deployment of more than two, by thing name; up to two, the sentence names them.
  boards: { label: 'To' },
  // A command at a board's serial console, by its name, and where a change came from.
  command: { label: 'Command', code: true },
  from: { label: 'From', say: (value) => (value === 'phone' ? 'the phone app' : value) },
  client: { label: 'On', say: (value) => ({ web: 'the website', phone: 'the phone app' })[value] ?? value },
  name: { label: 'Named', sentence: true },
  // A command sent to a board, and an e-mail subscription (docs/fleet.md).
  cmd: { label: 'Command', code: true },
  seconds: { label: 'For', say: (value) => (/^\d+$/.test(value) ? `${value} s` : value) },
  id: { label: 'Command id', code: true },
  subscription: { label: 'Now', say: (value) => (value === 'pending' ? 'waiting for the address to confirm' : value) },
  days: { label: 'Valid for', say: (value) => (/^\d+$/.test(value) ? plural(Number(value), 'day') : value) },
  withdrawn: { label: 'Withdrawn', say: (value) => (value === 'true' ? 'at once, to stay within the limit' : value) },
  // The fleet.
  kind: {
    label: 'To',
    say: (value) =>
      ({ boards: 'boards named one by one', group: 'a group', type: 'a board type', fleet: 'the whole fleet' })[
        value
      ] ?? value,
  },
  canary: { label: 'Canary', code: true },
  stages: { label: 'Stages' },
  stage: { label: 'Stage' },
  rollouts: { label: 'Rollouts', code: true },
  versions: { label: 'Releases' },
  group: { label: 'Group' },
  job: { label: 'Deployment', code: true },
  renamedFrom: { label: 'Was called', sentence: true },
  added: { label: 'Boards added' },
  removed: { label: 'Boards removed' },
  notes: { label: 'New note', sentence: true },
  oldLength: { label: 'Old note', say: (value) => (value === '0' ? 'none' : `${value} characters`) },
  type: { label: 'Board type', say: boardTypeLabel },
  layout: { label: 'Flash layout' },
  // The phone apps: an APK's versionCode, and where a download link went.
  versionCode: { label: 'versionCode', code: true },
  via: {
    label: 'As',
    say: (value) =>
      ({
        link: 'a link',
        qr: 'a QR code for a phone',
        app: 'an update in the app',
        sidestore: 'SideStore, on an iPhone',
      })[value] ?? value,
  },
  // An IPA's build, the SideStore link a download came through, and the link a new one replaced.
  build: { label: 'Build', code: true },
  source: { label: 'SideStore link', code: true },
  replaced: { label: 'Replaced', code: true },
  // A customer of the customer site: their address, their account id, and what a board was called for them.
  email: { label: 'E-mail' },
  customer: { label: 'Customer', code: true },
  label: { label: 'Called', sentence: true },
  // An export of the Database page: its file, its filters, how many items, and what stopped it early.
  format: { label: 'As', say: (value) => String(value).toUpperCase() },
  filters: { label: 'Filters', code: true },
  items: { label: 'Items' },
  capped: {
    label: 'Stopped early at',
    say: (value) =>
      ({
        items: 'the cap of items',
        size: 'the size of one answer',
        reads: 'the reads allowed',
        time: 'the time allowed',
      })[value] ?? value,
  },
};

function auditFact(entry, key, value) {
  const known = entryOf(AUDIT_DETAILS, key);
  if (!known) return { key, label: key, value, code: false, phrase: false, words: null };
  let { label } = known;
  // A revocation counts the deployments it cancelled; a failure that is not a refusal
  // did not refuse anything.
  if (key === 'cancelled' && entry.action === 'firmware.revoke') label = 'Deployments cancelled';
  if (key === 'code' && entry.outcome === 'error') label = 'Failed with';
  // The firmware a board ran when a command was given at its serial console.
  if (key === 'version' && entry.action === 'serial.command') label = 'Running';
  return {
    key,
    label,
    value: known.say ? known.say(value) : value,
    code: known.code === true,
    phrase: known.sentence !== true,
    // A refusal is said in words where there are words for it, with its code after them.
    words: key === 'code' ? (entryOf(REFUSAL_WORDS, value) ?? null) : null,
  };
}

/**
 * One line of the activity log: what was done, to what, and how it ended if not well.
 * `verb` comes before the label and `tail` after it; `label` is what to call the target. A
 * deployment is called by its version; its id goes to `facts`, which are the details of the entry
 * in words. `boards` are the thing names of the boards a deployment went to, as far as the entry
 * names them, and `boardCount` how many there were; auditBoards puts them into words. `byName`
 * says that the label is a board's own name, its device ID, which the page may find in its list.
 */
/**
 * The actions of the activity log that change something, and from console 2.13.1 say what: before and
 * after (docs/audit-diff.md). An entry of one of them from before then has no `changes`.
 */
export const CHANGE_ACTIONS = Object.freeze([
  'firmware.upload',
  'firmware.revoke',
  'firmware.notes',
  'deployment.create',
  'deployment.cancel',
  'token.create',
  'token.revoke',
  'alert.subscribe',
  'alert.unsubscribe',
  'alert.rules',
  'group.create',
  'group.update',
  'group.delete',
  'rollout.create',
  'rollout.cancel',
  'rollout.advance',
  'rollout.stop',
  'fleet.update_everything',
  'group.rollback',
  'fleet.rollback_last_good',
  'schedule.create',
  'schedule.edit',
  'schedule.cancel',
  'schedule.start',
  'customer.create',
  'customer.assign',
  'customer.unassign',
  'customer.disable',
  'customer.enable',
  'customer.reset_password',
  'customer.remove',
  'customer_action.rename',
  'customer_action.notifications',
  'account.invite',
  'account.tier',
  'account.disable',
  'account.enable',
  'account.reset',
  'account.remove',
  'report.settings',
]);

// What each field of a change is called on the page; another is shown by its own name.
const CHANGE_FIELDS = Object.freeze({
  status: 'Status',
  notes: 'Release note',
  reason: 'Reason',
  name: 'Name',
  boards: 'Boards',
  phase: 'Stage',
  rollout: 'Rollout',
  version: 'Release',
  plan: 'Plan',
  expires: 'Expires',
  token: 'Token',
  owner: 'Owner',
  label: 'Label',
  account: 'Account',
  email: 'E-mail address',
  alerts: 'E-mail alerts',
  deployment: 'Deployment',
  tier: 'Tier',
  authenticator: 'Authenticator app',
  report_email: 'Monday e-mail of the weekly report',
  time: 'When',
  window: 'Maintenance window',
});

/** A field's name in words: "keyHash" is "Key hash". */
function changeLabel(field) {
  if (Object.hasOwn(CHANGE_FIELDS, field)) return CHANGE_FIELDS[field];
  const words = String(field)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const changeText = (value) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * What an entry changed, for its diff: { rows: [{ field, label, from, to, hidden }], omitted, none }, each
 * value text or null for none. `none` is an entry of a change that recorded nothing of it, from before
 * changes were recorded. null for an entry that changed nothing, or did not succeed and says nothing.
 */
export function describeChanges(entry) {
  const recorded = Array.isArray(entry?.changes) ? entry.changes : null;
  const rows = (recorded ?? [])
    .filter((item) => item !== null && typeof item === 'object' && typeof item.field === 'string')
    .map((item) => ({
      field: item.field,
      label: changeLabel(item.field),
      from: changeText(item.from),
      to: changeText(item.to),
      hidden: item.hidden === true,
    }));
  const omitted = Number.isSafeInteger(entry?.changesOmitted) && entry.changesOmitted > 0 ? entry.changesOmitted : 0;
  if (rows.length > 0 || omitted > 0) return { rows, omitted, none: false };
  if (recorded === null && entry?.outcome === 'ok' && CHANGE_ACTIONS.includes(entry?.action)) {
    return { rows: [], omitted: 0, none: true };
  }
  return null;
}

export function describeAudit(entry) {
  const action = entryOf(AUDIT_ACTIONS, entry.action);
  const ok = entry.outcome === 'ok';
  const other = { tone: 'idle', icon: 'minus', label: entry.outcome || 'Unknown' };
  const deployment = isDeploymentId(entry.target) ? entry.target : null;
  const details = new Map(entry.detail ?? []);
  // A staged rollout is told by its release, and a group by its name; the entry keeps their ids.
  let label = deployment ? (versionOfDeployment(deployment) ?? deployment) : (entry.target ?? '');
  if (isRolloutId(entry.target) && isVersion(details.get('version'))) label = details.get('version');
  else if (/^group\.(?:create|update|delete)$/.test(entry.action) && details.get('name')) label = details.get('name');
  else if (entry.action === 'group.rollback' && details.get('group')) label = details.get('group');
  else if (entry.action === 'fleet.rollback_last_good') label = details.get('group') || 'the fleet';
  // A customer is told by their address, where the entry has it, not by the id of their account.
  // And a person of the team by theirs (account.*).
  const customerEmail = /^(?:customer|account)\./.test(String(entry.action ?? '')) ? (details.get('email') ?? '') : '';
  const byAddress = customerEmail !== '' && !CUSTOMER_BOARD.has(entry.action);
  if (byAddress) label = customerEmail;
  // A revocation that completed what an earlier request had begun.
  const resumed = entry.action === 'firmware.revoke' && ok && details.get('resumed') === 'true';
  let words = entry.action || 'did something';
  if (resumed) words = 'finished revoking firmware';
  else if (entry.action === 'account.sign_in' && ok)
    words = entryOf(SIGNED_IN_ON, details.get('client')) ?? action.done;
  else if (entry.action === 'serial.command' && ok)
    words = entryOf(SERIAL_WORDS, details.get('command')) ?? action.done;
  else if (entry.action === 'board.command' && ok) words = entryOf(COMMAND_WORDS, details.get('cmd')) ?? action.done;
  else if (action && ok) words = label ? action.done : (action.doneAlone ?? action.done);
  else if (action) words = label ? action.tried : action.triedAlone;

  let verb = words;
  let tail = '';
  const slot = words.indexOf('{}');
  if (slot >= 0 && label) {
    verb = words.slice(0, slot).trimEnd();
    tail = words.slice(slot + 2).trimStart();
  } else if (slot >= 0) {
    verb = words.replace('{}', 'a board');
  }
  if (!label) verb = verb.replace(/ of$/, '');
  // "gave CRVIHAAN01 to <the customer's address>": the board, then whose it is now.
  if (CUSTOMER_BOARD.has(entry.action) && customerEmail) tail = tail.replace(/a customer$/, customerEmail);

  // The boards of a deployment: by name where the entry has them, else how many.
  const boards = entry.action === 'deployment.create' ? (details.get('boards') ?? '').split(' ').filter(isThing) : [];
  const counted =
    entry.action === 'deployment.create' && /^[1-9]\d{0,3}$/.test(details.get('things') ?? '')
      ? Number(details.get('things'))
      : 0;
  const boardCount = Math.max(counted, boards.length);

  // What the sentence says already is not said again as a fact.
  const said = new Set();
  if (entry.action === 'account.sign_in') said.add('client');
  if (customerEmail !== '' && (byAddress || label)) said.add('email');
  if (entry.action === 'deployment.create' && boardCount > 0) said.add('things');
  if (boards.length <= 2) said.add('boards');
  const order = [...Object.keys(AUDIT_DETAILS), ...details.keys()];
  const facts = [];
  for (const key of new Set(order)) {
    if (!details.has(key) || said.has(key)) continue;
    // Said by the sentence already: the version of a deployment, and that a revocation was finished.
    if ((key === 'version' && details.get(key) === label) || (key === 'resumed' && resumed)) continue;
    // And the name of the file that an upload is told by, and of the group a change is told by.
    if (['filename', 'name', 'group'].includes(key) && details.get(key) === label) continue;
    facts.push(auditFact(entry, key, details.get(key)));
  }
  if (deployment) {
    facts.push({ key: 'target', label: 'Deployment', value: deployment, code: true, phrase: true, words: null });
  }

  return {
    icon: action?.icon ?? 'list',
    verb,
    label,
    tail,
    outcome: ok ? null : (entryOf(AUDIT_OUTCOMES, entry.outcome) ?? other),
    href: deploymentHref(entry.target) ?? rolloutHref(entry.target) ?? (isVersion(entry.target) ? '#/firmware' : null),
    facts,
    scripted: String(entry.requestId ?? '').startsWith(SCRIPTED_REQUEST),
    boards,
    boardCount,
    byName: entry.action === 'serial.command' && isBoardName(label),
    // A board given to a customer or taken back, by its thing name: the page shows its own name.
    ...(CUSTOMER_BOARD.has(entry.action) && isThing(label) ? { thing: label } : {}),
  };
}

/**
 * Where a deployment went, in words, each board by what it is called in `devices`: "to
 * CRVIHAAN01", "to CRVIHAAN01 and cranium-0123…", "to 3 boards"; '' when the entry does not say.
 */
export function auditBoards(description, devices = []) {
  const { boards, boardCount } = description;
  if (boards.length > 0 && boards.length <= 2) {
    return `to ${boards.map((thing) => boardName(boardOf(thing, devices))).join(' and ')}`;
  }
  return boardCount > 0 ? `to ${plural(boardCount, 'board')}` : '';
}

/** A whole line of the activity log in words, for where it is plain text: "a@b deployed 1.12.0+0 to CRVIHAAN01". */
export function auditSentence(entry, devices = []) {
  const description = describeAudit(entry);
  return [actorOf(entry), description.verb, description.label, description.tail, auditBoards(description, devices)]
    .filter(Boolean)
    .join(' ');
}

// The map, commands and alerts (docs/fleet.md). Where each board is, from the Wi-Fi it hears
// (cloud/api/src/lib/position.mjs), why a board is not on the map, the commands a release manager
// can send a board and how its answer is found in its log, and a person's own e-mail alerts.

// memfault from firmware 1.14.0 (docs/memfault.md): its Memfault data now, through AWS IoT.
export const COMMANDS = Object.freeze(['identify', 'report', 'memfault']);
export const IDENTIFY_SECONDS = 15;
// How long the page looks in the board's log for its answer to a command.
export const COMMAND_ANSWER_MS = 45_000;
const LOCATION_STATUSES = ['none', 'ok', 'too_few', 'unsolved', 'failed', 'unknown'];
const COMMAND_ID = /^[0-9a-f]{16}$/;

/** A position, or null: { lat, lon, accuracy (m), at }. */
function readPosition(raw) {
  if (!anObject(raw)) return null;
  const { lat, lon } = raw;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const accuracy = whole(raw.accuracy, 1, 1e7);
  const at = instant(raw.at);
  return accuracy === null || at === null ? null : { lat, lon, accuracy, at };
}

/** What the server knows of a board's location: { status, at, apCount, checkedAt, bluetoothOnly }. */
function readLocation(raw) {
  const item = anObject(raw) ? raw : {};
  return {
    status: LOCATION_STATUSES.includes(item.status) ? item.status : 'none',
    at: instant(item.at),
    apCount: whole(item.apCount, 0, 10),
    checkedAt: instant(item.checkedAt),
    bluetoothOnly: item.bluetoothOnly === true,
  };
}

function readPositions(body) {
  const reply = record(body);
  return {
    thing: text(reply.thing, 64),
    location: readLocation(reply.location),
    positions: list(reply.positions)
      .map(readPosition)
      .filter((position) => position !== null)
      .slice(0, 20),
  };
}

function readCommand(raw) {
  const item = record(raw);
  if (typeof item.id !== 'string' || !COMMAND_ID.test(item.id) || !COMMANDS.includes(item.cmd)) throw unreadable();
  return {
    id: item.id,
    cmd: item.cmd,
    seconds: whole(item.seconds, 1, 60),
    thing: text(item.thing, 64),
    sentAt: instant(item.sentAt),
    online: item.online === true,
  };
}

function readSentAlert(raw) {
  if (!anObject(raw) || instant(raw.at) === null) return null;
  return {
    at: raw.at,
    kind: text(raw.kind, 16),
    thing: isThing(raw.thing) ? raw.thing : null,
    deployment: isDeploymentId(raw.deployment) ? raw.deployment : null,
    subject: boardText(raw.subject, 100),
    count: whole(raw.count, 1, 1000) ?? 1,
  };
}

function readAlerts(body) {
  const reply = record(body);
  const rules = anObject(reply.rules) ? reply.rules : {};
  return {
    email: text(reply.email, 254),
    subscription: ['none', 'pending', 'confirmed'].includes(reply.subscription) ? reply.subscription : 'none',
    canSubscribe: reply.canSubscribe === true,
    subscribers: whole(reply.subscribers, 0, 10_000) ?? 0,
    recent: list(reply.recent)
      .map(readSentAlert)
      .filter((item) => item !== null),
    rules: {
      offlineMinutes: whole(rules.offlineMinutes, 1, 1440) ?? 15,
      everyMinutes: whole(rules.everyMinutes, 1, 1440) ?? 60,
      movedMetres: whole(rules.movedMetres, 1, 1e6) ?? 1000,
    },
    alertRules: readAlertRules(reply.alertRules),
    ruleLimits: readRuleLimits(reply.ruleLimits),
    canChangeRules: reply.canChangeRules === true,
  };
}

// The alert rules (cloud/api/src/lib/alerts.mjs RULES): each with whether it is on and its thresholds, and
// the limits of each threshold. What the server does not say is its default.
export const ALERT_RULES = Object.freeze({
  offline: { on: true, fields: { minutes: [5, 1440, 15] } },
  issue: { on: true, fields: {} },
  crashLoop: { on: true, fields: { reboots: [2, 20, 3], minutes: [5, 1440, 30] } },
  rollout: { on: true, fields: {} },
  voltage: { on: true, fields: { mv: [1000, 6000, 3000] } },
});

/** The alert rules of an answer: { offline: { on, minutes }, ... }, each field within its limits. */
export function readAlertRules(raw) {
  const given = anObject(raw) ? raw : {};
  return Object.fromEntries(
    Object.entries(ALERT_RULES).map(([id, rule]) => {
      const one = anObject(given[id]) ? given[id] : {};
      const fields = Object.fromEntries(
        Object.entries(rule.fields).map(([name, [low, high, fallback]]) => [
          name,
          whole(one[name], low, high) ?? fallback,
        ])
      );
      return [id, { on: typeof one.on === 'boolean' ? one.on : rule.on, ...fields }];
    })
  );
}

function readRuleLimits(raw) {
  const given = anObject(raw) ? raw : {};
  return Object.fromEntries(
    Object.entries(ALERT_RULES).map(([id, rule]) => [
      id,
      Object.fromEntries(
        Object.entries(rule.fields).map(([name, [low, high]]) => {
          const raw = anObject(given[id]) ? given[id][name] : null;
          const pair = Array.isArray(raw) ? raw : [];
          const from = whole(pair[0], low, high) ?? low;
          const to = whole(pair[1], from, high) ?? high;
          return [name, [from, to]];
        })
      ),
    ])
  );
}

/** "40 m", "1.3 km". */
export function distanceWords(metres) {
  if (!Number.isFinite(metres)) return '';
  if (metres < 1000) return `${Math.round(metres)} m`;
  return metres < 10_000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres / 1000)} km`;
}

/**
 * Why a board has no place on the map, or null if it has one: { code, title, text }. A board with
 * Bluetooth only has no Wi-Fi to place it by; a board on older firmware never sends a scan.
 */
export function unplacedReason(device) {
  if (device?.position) return null;
  const location = device?.location ?? { status: 'none' };
  if (location.bluetoothOnly) {
    return { code: 'bluetooth', title: 'Bluetooth only', text: 'An nRF5340 DK has no Wi-Fi, so nothing places it.' };
  }
  switch (location.status) {
    case 'too_few':
      return {
        code: 'too_few',
        title: 'Too few access points',
        text:
          `It heard ${location.apCount === 1 ? 'one' : location.apCount === 0 ? 'none' : 'too few'} it could use; ` +
          'two are needed. Hotspots and other moving networks do not count.',
      };
    case 'unsolved':
      return { code: 'unsolved', title: 'Not found', text: 'AWS could not place the access points it heard.' };
    case 'failed':
      return {
        code: 'failed',
        title: 'Not placed yet',
        text: 'AWS could not be asked; it tries again with the next scan.',
      };
    case 'unknown':
      return { code: 'unknown', title: 'Not read', text: 'The positions could not be read just now.' };
    default:
      return {
        code: 'no_scan',
        title: 'No scan yet',
        text: 'Boards send what they hear of the Wi-Fi from firmware 1.13.0, a minute after they connect.',
      };
  }
}

/** The colour a board's marker takes: as its state reads on the Devices page. */
export function markerTone(device) {
  if (device?.location?.bluetoothOnly) return 'idle';
  if (deviceActivity(device) !== null) return 'act';
  if (device?.ota?.last === 'failed' || device?.ota?.last === 'rolled_back') return 'warn';
  return device?.online ? 'good' : 'idle';
}

/** Whether the console can send a board a command at all: it connects to AWS IoT, and has reported. */
export function canCommand(device) {
  return Boolean(device) && !device.location?.bluetoothOnly && (device.lastSeen !== null || device.online);
}

/** The board's answer to a command, from its log (tag CMD, with the command's id in it), or null. */
export function commandAnswer(lines, id) {
  if (!COMMAND_ID.test(String(id ?? ''))) return null;
  const line = (lines ?? []).find((item) => item.tag === 'CMD' && item.text.includes(`(${id})`));
  return line ? { text: line.text, at: line.at, ignored: line.text.startsWith('ignored') } : null;
}

/** The positions of a board, newest first, each with how far it moved from the one before it. */
export function positionSteps(positions) {
  const radians = Math.PI / 180;
  return (positions ?? []).map((position, index, all) => {
    const before = all[index + 1];
    if (!before) return { ...position, moved: null };
    const dLat = (position.lat - before.lat) * radians;
    const dLon = (position.lon - before.lon) * radians;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(before.lat * radians) * Math.cos(position.lat * radians) * Math.sin(dLon / 2) ** 2;
    return { ...position, moved: 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h))) };
  });
}

export const ALERT_KIND_WORDS = Object.freeze({
  offline: 'Offline',
  online: 'Back online',
  update: 'Update failed',
  stuck: 'Restarted, stuck',
  moved: 'Moved',
  deployment: 'Deployment stopped',
  issue: 'New Memfault issue',
  crashloop: 'Crash loop',
  voltage: 'Low supply voltage',
});
