/**
 * The mixes of the customer site (docs/customer-site.md, "Mixes"): sessions, the transitions between
 * their tracks, the track library and saved moments, worked out from sessions.
 *
 * A session is what one set played: when it started, and for each track its name, its artist, the
 * deck it played on and when it started and stopped, in seconds from the start of the set. Boards do
 * not send sessions yet, so they come from two places only:
 *
 *   - the demo, made up here and said to be made up wherever it shows (`demoJournal`);
 *   - the customer's own journal: session files they import, kept in their browser (customer.js).
 *
 * Everything here is pure: no page, no storage, no clock but the `now` it is given. What a file
 * brings in is checked field by field and cut to size, and nothing of it is ever markup: the views
 * set it as text.
 */

export const MIX_FORMAT = 'cranium-mixes';
export const MIX_FORMAT_VERSION = 1;

/** The ranges a page can show, as [value, label]. */
export const RANGES = Object.freeze([['all', 'All time'], ['7', 'Last 7 days'], ['30', 'Last 30 days']]);
const RANGE_DAYS = { 7: 7, 30: 30 };
const DAY_MS = 86400000;

// How much a journal holds, so that a file cannot fill the browser's storage or the page.
export const LIMITS = Object.freeze({
  bytes: 1_000_000, sessions: 200, tracks: 400, moments: 500, text: 120, note: 500, key: 4, seconds: 86400,
});
const CSV_COLUMNS = ['session', 'started', 'title', 'artist', 'deck', 'start', 'end', 'bpm', 'key'];

// Text: trimmed, without control characters, at most `max` characters.
function text(value, max = LIMITS.text) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function seconds(value) {
  if (typeof value === 'string' && /^\d{1,3}:\d{2}(?::\d{2})?$/.test(value.trim())) {
    return value.trim().split(':').reduce((total, part) => total * 60 + Number(part), 0);
  }
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= LIMITS.seconds ? Math.round(number * 10) / 10 : null;
}

function bpmOf(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 40 && number <= 250 ? Math.round(number * 10) / 10 : null;
}

function isoOf(value) {
  const time = typeof value === 'string' || typeof value === 'number' ? Date.parse(String(value)) : NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** A short, stable id for what identifies a session: the same file imported twice is one session. */
export function sessionId(startedAt, title) {
  let hash = 0x811c9dc5;
  for (const char of `${startedAt}\u0000${title}`) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `s${hash.toString(16).padStart(8, '0')}`;
}

/**
 * A session as this site keeps it, from anything: a field that does not hold what it should is left
 * out, a track without a name is dropped, and a session without a start time or a track is null.
 */
export function cleanSession(raw, source = 'journal') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const startedAt = isoOf(raw.startedAt);
  const title = text(raw.title) || 'A session';
  if (startedAt === null || !Array.isArray(raw.tracks)) return null;
  const tracks = [];
  for (const item of raw.tracks.slice(0, LIMITS.tracks)) {
    if (item === null || typeof item !== 'object') continue;
    const name = text(item.title);
    if (name === '') continue;
    const start = seconds(item.start);
    let end = seconds(item.end);
    if (start === null || (end !== null && end <= start)) end = null;
    const deck = typeof item.deck === 'string' && /^[ab]$/i.test(item.deck.trim()) ? item.deck.trim().toUpperCase() : null;
    tracks.push({
      title: name, artist: text(item.artist), deck, start, end, bpm: bpmOf(item.bpm), key: text(item.key, LIMITS.key) || null,
    });
  }
  if (tracks.length === 0) return null;
  return { id: sessionId(startedAt, title), title, startedAt, source, tracks };
}

function cleanMoment(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const from = text(raw.from?.title);
  const to = text(raw.to?.title);
  const id = text(raw.id, 40);
  if (!from || !to || !/^[a-z0-9:_-]{1,40}$/i.test(id)) return null;
  return {
    id,
    from: { title: from, artist: text(raw.from?.artist) },
    to: { title: to, artist: text(raw.to?.artist) },
    session: text(raw.session),
    overlap: seconds(raw.overlap),
    note: text(raw.note, LIMITS.note),
    savedAt: isoOf(raw.savedAt) ?? new Date(0).toISOString(),
    demo: raw.demo === true,
  };
}

/** A journal as kept in the browser or in a backup: its sessions newest first, and its moments. */
export function cleanJournal(raw) {
  const sessions = new Map();
  for (const item of Array.isArray(raw?.sessions) ? raw.sessions : []) {
    const session = cleanSession(item, 'journal');
    if (session) sessions.set(session.id, session);
  }
  const moments = new Map();
  for (const item of Array.isArray(raw?.moments) ? raw.moments : []) {
    const moment = cleanMoment(item);
    if (moment) moments.set(moment.id, moment);
  }
  return {
    sessions: newestFirst([...sessions.values()]).slice(0, LIMITS.sessions),
    moments: [...moments.values()].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1)).slice(0, LIMITS.moments),
  };
}

export const emptyJournal = () => ({ sessions: [], moments: [] });

function newestFirst(sessions) {
  return [...sessions].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

// Reading a file.

/** One CSV line into its cells: commas, and quotes around a cell that holds one, as RFC 4180 has it. */
function csvRows(source) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((cells) => cells.some((value) => value.trim() !== ''));
}

function fromCsv(source) {
  const [header, ...rows] = csvRows(source);
  const columns = (header ?? []).map((name) => name.trim().toLowerCase());
  for (const required of ['started', 'title']) {
    if (!columns.includes(required)) throw new ImportProblem(`The file has no "${required}" column. Its first line names the columns: ${CSV_COLUMNS.join(', ')}.`);
  }
  const sessions = new Map();
  for (const cells of rows) {
    const value = (name) => cells[columns.indexOf(name)] ?? '';
    const started = value('started');
    const title = value('session') || 'A session';
    const key = `${started}\u0000${title}`;
    if (!sessions.has(key)) sessions.set(key, { title, startedAt: started, tracks: [] });
    sessions.get(key).tracks.push({
      title: value('title'), artist: value('artist'), deck: value('deck'), start: value('start'), end: value('end'),
      bpm: value('bpm'), key: value('key'),
    });
  }
  return { sessions: [...sessions.values()], moments: [] };
}

export class ImportProblem extends Error {}

/**
 * What a file brings: its sessions and moments, cleaned. A file of this site (JSON, a backup or one
 * session) or a CSV of tracks, one line each. Throws ImportProblem with words for the person.
 */
export function readImport(source, name = '') {
  if (typeof source !== 'string' || source.trim() === '') throw new ImportProblem('The file is empty.');
  if (source.length > LIMITS.bytes) throw new ImportProblem('The file is larger than 1 MB. Import fewer sessions at a time.');
  let raw;
  const looksJson = /^\s*[[{]/.test(source) || /\.json$/i.test(name);
  if (looksJson) {
    try {
      raw = JSON.parse(source);
    } catch {
      throw new ImportProblem('The file is not JSON this site can read.');
    }
    if (raw?.format !== MIX_FORMAT) throw new ImportProblem(`The file is not a Cranium session file: it has no "format": "${MIX_FORMAT}".`);
    if (raw.version !== MIX_FORMAT_VERSION) throw new ImportProblem(`The file is version ${String(raw.version).slice(0, 10)} of the format; this site reads version ${MIX_FORMAT_VERSION}.`);
    if (raw.session && !raw.sessions) raw = { ...raw, sessions: [raw.session] };
  } else {
    raw = fromCsv(source);
  }
  const offered = Array.isArray(raw.sessions) ? raw.sessions.length : 0;
  const journal = cleanJournal(raw);
  if (journal.sessions.length === 0 && journal.moments.length === 0) {
    throw new ImportProblem('No session in the file has a start time and a track with a name.');
  }
  return { ...journal, skipped: Math.max(0, offered - journal.sessions.length) };
}

/** The journal with what was imported added: a session already there is replaced by the file's. */
export function mergeJournal(journal, imported) {
  return cleanJournal({
    sessions: [...imported.sessions, ...journal.sessions.filter((session) => !imported.sessions.some((other) => other.id === session.id))],
    moments: [...imported.moments, ...journal.moments.filter((moment) => !imported.moments.some((other) => other.id === moment.id))],
  });
}

// Writing a file.

export function journalFile(journal, now) {
  return JSON.stringify({
    format: MIX_FORMAT, version: MIX_FORMAT_VERSION, exportedAt: new Date(now).toISOString(),
    sessions: journal.sessions.map(({ source, id, ...session }) => session),
    moments: journal.moments,
  }, null, 2);
}

// A cell that a spreadsheet would read as a formula starts with a quote instead.
function csvCell(value) {
  let cell = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function sessionsCsv(sessions) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const session of sessions) {
    for (const track of session.tracks) {
      lines.push([session.title, session.startedAt, track.title, track.artist, track.deck, track.start, track.end, track.bpm, track.key]
        .map(csvCell).join(','));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** A file name for a download: the site's name, what it is, and the day. */
export function fileName(what, now, extension) {
  const day = new Date(now).toISOString().slice(0, 10);
  const slug = text(what).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'mixes';
  return `cranium-${slug}-${day}.${extension}`;
}

// The demo: made up, and dated from today, so that the ranges have something to show.

const DEMO_TRACKS = [
  ['Copper Light', 'Hollis Vane', 122, '8A'],
  ['Low Tide Radio', 'Marigold Hours', 124, '8A'],
  ['Paper Planets', 'Oda Pell', 124, '9A'],
  ['Night Bus Home', 'Tamsin Rowe', 126, '9A'],
  ['Slow Orbit', 'Kettle & Wren', 126, '10A'],
  ['Glass Garden', 'Ilse Moreau', 128, '10A'],
  ['Second Wind', 'Fenn Hale', 125, '11A'],
  ['Morning Static', 'Harbour Club', 123, '7A'],
  ['Amber Line', 'Noor Calder', 121, '7A'],
];

// [days ago, hour, title, [[track, seconds on the deck, seconds with the next one], ...]]
const DEMO_SESSIONS = [
  [1, 21, 'Saturday, no plan', [[0, 300, 39], [1, 330, 48], [2, 360, 27], [3, 300, 42], [4, 330, 54], [5, 300, 30], [6, 290, 36], [7, 300, 0]]],
  [4, 23, 'One more before midnight', [[8, 290, 24], [0, 300, 39], [1, 320, 48], [2, 300, 30], [6, 310, 36], [7, 300, 0]]],
  [9, 20, 'Finding the groove', [[7, 300, 30], [0, 290, 36], [3, 300, 42], [4, 280, 30], [1, 300, 45], [5, 290, 0]]],
];

export function demoJournal(now) {
  const sessions = DEMO_SESSIONS.map(([daysAgo, hour, title, plays]) => {
    const day = new Date(now - daysAgo * DAY_MS);
    day.setHours(hour, 0, 0, 0);
    let start = 0;
    const tracks = plays.map(([index, length, overlap], position) => {
      const [name, artist, bpm, key] = DEMO_TRACKS[index];
      const track = { title: name, artist, deck: position % 2 === 0 ? 'A' : 'B', start, end: start + length, bpm, key };
      start = start + length - overlap;
      return track;
    });
    const startedAt = day.toISOString();
    return { id: sessionId(startedAt, title), title, startedAt, source: 'demo', tracks };
  });
  return { sessions, moments: [] };
}

// Working things out.

export function inRange(sessions, range, now) {
  const days = RANGE_DAYS[range];
  if (!days) return sessions;
  const from = now - days * DAY_MS;
  return sessions.filter((session) => Date.parse(session.startedAt) >= from);
}

/** The seconds a session had music on a deck: two decks playing at once count once. */
export function deckSeconds(session) {
  const spans = session.tracks.filter((track) => track.start !== null && track.end !== null)
    .map((track) => [track.start, track.end]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let current = null;
  for (const [start, end] of spans) {
    if (current && start <= current[1]) current[1] = Math.max(current[1], end);
    else {
      if (current) total += current[1] - current[0];
      current = [start, end];
    }
  }
  if (current) total += current[1] - current[0];
  return total;
}

/** How long the set ran, from its first track's start to its last one's end. */
export function elapsedSeconds(session) {
  const known = session.tracks.filter((track) => track.start !== null);
  if (known.length === 0) return 0;
  const first = Math.min(...known.map((track) => track.start));
  const last = Math.max(...known.map((track) => track.end ?? track.start));
  return last - first;
}

const trackKey = (track) => `${track.title.toLowerCase()}\u0000${track.artist.toLowerCase()}`;

/**
 * From one track to the next, in the order they started. The overlap is how long both played;
 * it is known only when both tracks' times are.
 */
export function transitionsOf(sessions) {
  const pairs = [];
  for (const session of sessions) {
    const order = session.tracks.map((track, index) => ({ track, index }))
      .sort((a, b) => (a.track.start ?? Infinity) - (b.track.start ?? Infinity) || a.index - b.index);
    for (let position = 1; position < order.length; position += 1) {
      const from = order[position - 1].track;
      const to = order[position].track;
      const known = [from.start, from.end, to.start, to.end].every((value) => value !== null);
      const overlap = known ? Math.max(0, Math.min(from.end, to.end) - Math.max(from.start, to.start)) : null;
      pairs.push({ id: `${session.id}:${position}`, session, from, to, overlap });
    }
  }
  return pairs;
}

export function figures(sessions) {
  const plays = sessions.reduce((sum, session) => sum + session.tracks.length, 0);
  const unique = new Set(sessions.flatMap((session) => session.tracks.map(trackKey))).size;
  return {
    seconds: sessions.reduce((sum, session) => sum + deckSeconds(session), 0),
    sessions: sessions.length,
    plays,
    unique,
    overlaps: transitionsOf(sessions).filter((pair) => pair.overlap > 0).length,
  };
}

/** Every track across the sessions, the most played first: how often, and for how long in all. */
export function libraryOf(sessions) {
  const tracks = new Map();
  for (const session of sessions) {
    for (const track of session.tracks) {
      const key = trackKey(track);
      const entry = tracks.get(key) ?? { title: track.title, artist: track.artist, plays: 0, seconds: 0, bpm: null, key: null, last: '' };
      entry.plays += 1;
      if (track.start !== null && track.end !== null) entry.seconds += track.end - track.start;
      if (session.startedAt >= entry.last) {
        entry.last = session.startedAt;
        entry.bpm = track.bpm ?? entry.bpm;
        entry.key = track.key ?? entry.key;
      }
      tracks.set(key, entry);
    }
  }
  return [...tracks.values()].sort((a, b) => b.plays - a.plays || b.seconds - a.seconds || a.title.localeCompare(b.title));
}

/** The pair of the newest session that played together the longest: one to come back to. */
export function momentToRevisit(sessions) {
  const [last] = newestFirst(sessions);
  if (!last) return null;
  return transitionsOf([last]).filter((pair) => pair.overlap > 0).sort((a, b) => b.overlap - a.overlap)[0] ?? null;
}

export function latest(sessions) {
  return newestFirst(sessions)[0] ?? null;
}

export function matches(track, query) {
  const words = text(query).toLowerCase();
  if (words === '') return true;
  return `${track.title} ${track.artist}`.toLowerCase().includes(words);
}

/** A saved moment of a transition, with the note the person wrote. */
export function momentOf(pair, note, now) {
  return cleanMoment({
    id: pair.id,
    from: pair.from,
    to: pair.to,
    session: pair.session.title,
    overlap: pair.overlap,
    note,
    savedAt: new Date(now).toISOString(),
    demo: pair.session.source === 'demo',
  });
}

export function withMoment(journal, moment) {
  return cleanJournal({ sessions: journal.sessions, moments: [moment, ...journal.moments.filter((other) => other.id !== moment.id)] });
}

export function withoutMoment(journal, id) {
  return { ...journal, moments: journal.moments.filter((moment) => moment.id !== id) };
}

export function withoutSession(journal, id) {
  return { ...journal, sessions: journal.sessions.filter((session) => session.id !== id) };
}

// Words.

/** "37:54", or "1:02:05" past an hour. */
export function clock(total) {
  if (!Number.isFinite(total) || total < 0) return '—';
  const whole = Math.round(total);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** "1h 34m", "37m", or "45s". */
export function onDecks(total) {
  if (!Number.isFinite(total) || total <= 0) return '0m';
  if (total < 60) return `${Math.round(total)}s`;
  const minutes = Math.round(total / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

/** The first letters of a track's name, for its square. */
export function trackInitials(title) {
  const letters = text(title).replace(/[^\p{L}\p{N} ]/gu, '').trim();
  return (letters.slice(0, 2) || '♪').toUpperCase();
}

/** One of four shades for a track's square, the same for the same track wherever it shows. */
export function trackShade(track) {
  let sum = 0;
  for (const char of trackKey(track)) sum = (sum + char.codePointAt(0)) % 997;
  return sum % 4;
}

export function sessionDay(iso) {
  const then = new Date(Date.parse(iso));
  return Number.isNaN(then.getTime()) ? '' : then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A file to start from: one session in the format the site reads, made up like the demo. */
export function sampleFile(now) {
  const [session] = demoJournal(now).sessions;
  return JSON.stringify({
    format: MIX_FORMAT, version: MIX_FORMAT_VERSION,
    session: { title: 'My first session', startedAt: session.startedAt, tracks: session.tracks },
  }, null, 2);
}
