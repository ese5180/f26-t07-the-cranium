/**
 * Alerts by e-mail (docs/fleet.md, "Alerts"): which events make one, how often one may go out, and
 * what it says. The part that reads, writes and sends is alerts.mjs.
 *
 * An alert, for one board (or one deployment) and one kind:
 *
 *   offline     the board has been disconnected from AWS IoT for the offline rule's minutes, 15 unless a
 *               release manager changed it (the scheduled check finds it)
 *   online      it is connected again, after an "offline" alert
 *   update      an update over the internet failed or rolled back; an update over Bluetooth
 *               rolled back, lost its trial, or could not be installed or written
 *   stuck       the board restarted itself for being stuck
 *   moved       its position from Wi-Fi moved by more than 1 km (lib/position.mjs isMove)
 *   deployment  a deployment stopped by itself: an event item of kind "update", what "stopped", with
 *               the deployment in `job`, wherever it is recorded from (alertOfEvent); a staged rollout
 *               that stopped by itself, its health gate too (handlers/rollouts.mjs)
 *   issue       Memfault has a new issue, and the board is one of those with its traces
 *   crashloop   the board restarted unexpectedly (Memfault's reboot reasons) N times in M minutes
 *   voltage     the board's supply voltage, from its Memfault heartbeat, is under the rule's threshold
 *
 * The rules (console 2.12.0): which of these go out and at what thresholds, one item in the state
 * table (pk "ALR", sk "rules") that release managers change on the console's Alerts page, each change
 * on record as alert.rules. RULES says each rule's fields, limits and defaults; normalizeRules reads
 * the item, whatever it holds. A kind whose rule is off is never raised. "update", "stuck" and
 * "moved" have no rule and always go; "online" follows "offline". The schedule of the staged
 * rollouts (tick.mjs) reads Memfault for "issue", "crashloop" and "voltage" every WATCH_EVERY_MS
 * (alerts.mjs watch); what it has seen is kept in pk "ALERTS", sk "W#memfault".
 *
 * Presence is AWS IoT's own word that a board connected or disconnected (the presence rule), which is
 * what the Events page draws when a board was online from. AWS says its lifecycle messages may come
 * out of order and twice; a message counts only if it is newer than the one kept: by time when the
 * two are more than a minute apart, else by AWS's version number of the connection (the connect and
 * the disconnect of one connection share it), and within one connection a disconnect comes last.
 *
 * At most one e-mail per board and kind per hour. An alert within the hour after the last e-mail of
 * its kind is folded: kept, at most 20 of them and a count of any more, and sent with the next e-mail
 * of that kind, or by the scheduled check once the hour is up, whichever comes first.
 *
 * The text is plain, names the board by its name (its device ID) and its thing name, and links to the
 * console. It is made from what the event log says, which holds no secret: never a passkey, a network
 * name, a BSSID or a coordinate.
 *
 * Items, in the events table, one partition for all of them, which is all the recorder may read:
 *
 *   pk = "ALERTS", sk = "B#<thing>"              a board: its name, presence and what each kind last sent
 *   pk = "ALERTS", sk = "D#<deployment>"          a deployment, for "deployment"
 *   pk = "ALERTS", sk = "S#<ISO time>#<key>#<kind>"   an e-mail that went out, kept 30 days, for the console
 *
 * No AWS here, and no clock: the caller passes the time.
 */

import { BOARD_NAME } from './shadow.mjs';
import { isThing, parseJobId } from './validate.mjs';

export const ALERTS_PK = 'ALERTS';
// The rules' item, in the state table.
export const ALERT_RULES_PK = 'ALR';
export const ALERT_RULES_SK = 'rules';
export const ALERT_KINDS = Object.freeze([
  'offline',
  'online',
  'update',
  'deployment',
  'stuck',
  'moved',
  'issue',
  'crashloop',
  'voltage',
]);
export const OFFLINE_AFTER_MS = 15 * 60_000;
export const ALERT_EVERY_MS = 60 * 60_000;
export const FOLDED_KEPT = 20;
export const SENT_DAYS = 30;
export const WATCH_KEY = 'W#memfault';
export const WATCH_EVERY_MS = 5 * 60_000;
// Heartbeats come every hour: the voltage looks this far back at least.
export const VOLTAGE_WINDOW_MINUTES = 120;
// What the watch keeps: the issue ids it has seen, and the boards it last alerted for.
const ISSUES_KEPT = 500;
const BOARDS_KEPT = 200;
// The new issues looked at in one check: each costs a read of its traces.
export const NEW_ISSUES_READ = 5;

/**
 * The alert rules: for each, whether it is on and its thresholds, with their limits and defaults.
 * `fields` maps a threshold to [low, high, default].
 */
export const RULES = Object.freeze({
  offline: { on: true, fields: { minutes: [5, 1440, 15] } },
  issue: { on: true, fields: {} },
  crashLoop: { on: true, fields: { reboots: [2, 20, 3], minutes: [5, 1440, 30] } },
  rollout: { on: true, fields: {} },
  voltage: { on: true, fields: { mv: [1000, 6000, 3000] } },
});
export const RULE_IDS = Object.freeze(Object.keys(RULES));
// The rule each kind of alert goes by; the kinds not here always go.
const RULE_OF_KIND = Object.freeze({
  offline: 'offline',
  online: 'offline',
  deployment: 'rollout',
  issue: 'issue',
  crashloop: 'crashLoop',
  voltage: 'voltage',
});

/** The rules as they hold by default. */
export function defaultRules() {
  return Object.fromEntries(
    RULE_IDS.map((id) => [
      id,
      {
        on: RULES[id].on,
        ...Object.fromEntries(Object.entries(RULES[id].fields).map(([name, [, , fallback]]) => [name, fallback])),
      },
    ])
  );
}

/** The rules of a stored item, each field checked; what is missing or wrong is its default. */
export function normalizeRules(item) {
  const rules = defaultRules();
  const stored = isPlain(item?.rules) ? item.rules : {};
  for (const id of RULE_IDS) {
    const given = isPlain(stored[id]) ? stored[id] : {};
    if (typeof given.on === 'boolean') rules[id].on = given.on;
    for (const [name, [low, high]] of Object.entries(RULES[id].fields)) {
      const value = given[name];
      if (Number.isInteger(value) && value >= low && value <= high) rules[id][name] = value;
    }
  }
  return rules;
}

/** Whether an alert of `kind` goes out under `rules`. */
export function ruleAllows(rules, kind) {
  const id = RULE_OF_KIND[kind];
  return id === undefined || rules?.[id]?.on !== false;
}

// Two presence messages further apart than this are ordered by their times alone.
export const PRESENCE_SLACK_MS = 60_000;

const DEPLOYMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REASON = /^[A-Z][A-Z_]{0,47}$/;
const PRINTABLE = /^[\x20-\x7e]{1,200}$/;
const SENT_KEY = /^S#(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#([A-Za-z0-9_-]{1,64})#([a-z]+)$/;
const BAD_BLUETOOTH = new Set(['rolled_back', 'not_installed', 'trial_lost', 'flash_error']);
const BAD_RESULTS = new Set(['failed', 'rolled_back']);
const SUBJECT_MAX = 100;
// A page of the console a line of an e-mail links to.
const LINK = /^#\/(?:memfault|rollouts|devices|deployments)\/[A-Za-z0-9_-]{1,64}$/;

const DISCONNECT_WORDS = Object.freeze({
  CLIENT_INITIATED_DISCONNECT: 'the board closed the connection',
  CONNECTION_LOST: 'the connection was lost',
  MQTT_KEEP_ALIVE_TIMEOUT: 'the board stopped answering',
  DUPLICATE_CLIENTID: 'another connection used its name',
  SERVER_INITIATED_DISCONNECT: 'AWS IoT closed the connection',
  THROTTLED: 'it sent more than AWS IoT accepts',
});

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = (ms) => new Date(ms).toISOString();

export const boardKey = (thing) => `B#${thing}`;
export const deploymentKey = (id) => `D#${id}`;

/** "16 min", "2 h 5 min", "3 d 4 h". */
export function spell(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** "2026-11-04 14:02 UTC": a time as the e-mail gives it, the same for every reader. */
export function utc(ms) {
  return `${iso(ms).slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The alert an event of the log makes, or null: { kind, thing, deployment?, version?, text, at }.
 * `item` is an event item as the recorder or the location function stores it (lib/events.mjs).
 */
export function alertOfEvent(item) {
  if (!isPlain(item) || !isThing(item.pk) || typeof item.text !== 'string' || !PRINTABLE.test(item.text)) return null;
  const at = Date.parse(String(item.sk ?? '').slice(2, 26));
  const base = { thing: item.pk, text: item.text, at: Number.isFinite(at) ? at : null };
  if (item.kind === 'update' && item.what === 'result' && BAD_RESULTS.has(item.result))
    return { kind: 'update', ...base };
  if (item.kind === 'bluetooth' && item.what === 'record' && BAD_BLUETOOTH.has(item.result))
    return { kind: 'update', ...base };
  if (item.kind === 'restart' && item.what === 'stuck') return { kind: 'stuck', ...base };
  if (item.kind === 'health' && item.what === 'moved') return { kind: 'moved', ...base };
  if (
    item.kind === 'update' &&
    item.what === 'stopped' &&
    typeof item.job === 'string' &&
    DEPLOYMENT_ID.test(item.job)
  ) {
    return { kind: 'deployment', ...base, deployment: item.job, version: parseJobId(item.job)?.version ?? null };
  }
  return null;
}

/** What a presence message says, or null: { thing, state: 'online' | 'offline', at, version, reason }. */
export function presenceOf(message, nowMs) {
  if (!isPlain(message) || !isThing(message.clientId)) return null;
  const state = { connected: 'online', disconnected: 'offline' }[message.eventType];
  if (state === undefined) return null;
  const stamp = message.timestamp;
  const at =
    Number.isFinite(stamp) && stamp > nowMs - 86_400_000 && stamp < nowMs + 300_000 ? Math.floor(stamp) : nowMs;
  const version =
    Number.isSafeInteger(message.versionNumber) && message.versionNumber >= 0 ? message.versionNumber : null;
  const reason =
    state === 'offline' && typeof message.disconnectReason === 'string' && REASON.test(message.disconnectReason)
      ? message.disconnectReason
      : null;
  return { thing: message.clientId, state, at, version, reason };
}

/** True if a presence message is newer than the one kept (see the top of this file). */
export function isNewerPresence(kept, incoming) {
  if (!isPlain(kept)) return true;
  if (Math.abs(incoming.at - kept.at) > PRESENCE_SLACK_MS) return incoming.at > kept.at;
  if (incoming.version !== null && kept.version !== null && incoming.version !== kept.version) {
    return incoming.version > kept.version;
  }
  if (incoming.state !== kept.state) return incoming.state === 'offline' || incoming.at > kept.at;
  return false;
}

/** A board's item as it is before anything about it is known. */
export function emptyBoard(thing) {
  return {
    pk: ALERTS_PK,
    sk: boardKey(thing),
    thing,
    name: null,
    presence: null,
    offlineAlerted: false,
    kinds: {},
    rev: 0,
  };
}

export function emptyDeployment(id) {
  return {
    pk: ALERTS_PK,
    sk: deploymentKey(id),
    deployment: id,
    version: parseJobId(id)?.version ?? null,
    kinds: {},
    rev: 0,
  };
}

/**
 * A board's item after a presence message: { state, alert } with `alert` the "online" one when the
 * board comes back after an "offline" alert went out, or null when the message changes nothing.
 */
export function applyPresence(board, presence) {
  if (!isNewerPresence(board.presence, presence)) return null;
  const next = {
    ...board,
    presence: { state: presence.state, at: presence.at, version: presence.version, reason: presence.reason },
  };
  let alert = null;
  if (presence.state === 'online' && board.offlineAlerted) {
    const since = board.presence?.state === 'offline' ? board.presence.at : null;
    alert = {
      kind: 'online',
      thing: board.thing,
      at: presence.at,
      text:
        since === null
          ? 'Connected to AWS IoT again'
          : `Connected to AWS IoT again, after ${spell(presence.at - since)} offline`,
    };
    next.offlineAlerted = false;
  }
  return { state: next, alert };
}

/**
 * The "offline" alert that is due for a board, with its item once it is raised, or null. `afterMs` is
 * the offline rule's time.
 */
export function dueOffline(board, nowMs, afterMs = OFFLINE_AFTER_MS) {
  const presence = board.presence;
  if (presence?.state !== 'offline' || board.offlineAlerted || nowMs - presence.at < afterMs) return null;
  const why = presence.reason
    ? `: ${DISCONNECT_WORDS[presence.reason] ?? `AWS IoT gave the reason ${presence.reason}`}`
    : '';
  return {
    state: { ...board, offlineAlerted: true },
    alert: {
      kind: 'offline',
      thing: board.thing,
      at: nowMs,
      text: `Offline since ${utc(presence.at)}, for ${spell(nowMs - presence.at)} now${why}`,
    },
  };
}

function slotOf(item, kind) {
  const slot = item.kinds?.[kind];
  return {
    sentAt: Number.isFinite(slot?.sentAt) ? slot.sentAt : null,
    folded: Array.isArray(slot?.folded) ? slot.folded : [],
    more: Number.isSafeInteger(slot?.more) ? slot.more : 0,
  };
}

/**
 * An alert taken into an item: { state, mail } with `mail` = { kind, lines, more, before } to send now,
 * or null when it is folded into the next one. `before` is when the kind last sent, for putting the
 * lines back if the e-mail cannot be sent.
 */
export function takeAlert(item, alert, nowMs) {
  const slot = slotOf(item, alert.kind);
  const line = { at: Number.isFinite(alert.at) ? alert.at : nowMs, text: alert.text };
  if (typeof alert.link === 'string' && LINK.test(alert.link)) line.link = alert.link;
  const kinds = { ...item.kinds };
  if (slot.sentAt === null || nowMs - slot.sentAt >= ALERT_EVERY_MS) {
    kinds[alert.kind] = { sentAt: nowMs, folded: [], more: 0 };
    return {
      state: { ...item, kinds },
      mail: { kind: alert.kind, lines: [...slot.folded, line], more: slot.more, before: slot.sentAt },
    };
  }
  let folded = [...slot.folded, line];
  let { more } = slot;
  if (folded.length > FOLDED_KEPT) {
    more += folded.length - FOLDED_KEPT;
    folded = folded.slice(-FOLDED_KEPT);
  }
  kinds[alert.kind] = { sentAt: slot.sentAt, folded, more };
  return { state: { ...item, kinds }, mail: null };
}

/** The folded alerts whose hour is up, as e-mails to send now, and the item without them; null if none. */
export function flushDue(item, nowMs) {
  const kinds = { ...item.kinds };
  const mails = [];
  for (const kind of ALERT_KINDS) {
    const slot = slotOf(item, kind);
    if (slot.folded.length === 0 && slot.more === 0) continue;
    if (slot.sentAt !== null && nowMs - slot.sentAt < ALERT_EVERY_MS) continue;
    kinds[kind] = { sentAt: nowMs, folded: [], more: 0 };
    mails.push({ kind, lines: slot.folded, more: slot.more, before: slot.sentAt });
  }
  return mails.length === 0 ? null : { state: { ...item, kinds }, mails };
}

/** An item with the lines of an e-mail that could not be sent put back, to go out with the next one. */
export function putBack(item, mail) {
  const slot = slotOf(item, mail.kind);
  const kinds = { ...item.kinds };
  let folded = [...mail.lines, ...slot.folded];
  let more = slot.more + mail.more;
  if (folded.length > FOLDED_KEPT) {
    more += folded.length - FOLDED_KEPT;
    folded = folded.slice(-FOLDED_KEPT);
  }
  kinds[mail.kind] = { sentAt: mail.before, folded, more };
  return { ...item, kinds };
}

const SUBJECTS = Object.freeze({
  offline: (name) => `${name} is offline`,
  online: (name) => `${name} is back online`,
  update: (name) => `An update did not go through on ${name}`,
  stuck: (name) => `${name} restarted itself for being stuck`,
  moved: (name) => `${name} has moved`,
  deployment: (name) => `The deployment of ${name} stopped by itself`,
  issue: (name) => `A new Memfault issue on ${name}`,
  crashloop: (name) => `${name} keeps restarting`,
  voltage: (name) => `${name} has a low supply voltage`,
});

const LEADS = Object.freeze({
  offline: 'This board has been disconnected from AWS IoT for longer than the offline alert rule allows.',
  online: 'This board is connected to AWS IoT again.',
  update: 'An update of this board failed or was rolled back.',
  stuck: 'This board restarted itself because it was stuck.',
  moved: "This board's position, worked out from the Wi-Fi it hears, moved by more than 1 km.",
  deployment:
    'This deployment stopped by itself: too many of its boards failed or rolled back, or the health gate of its ' +
    'staged rollout found a problem.',
  issue: 'Memfault grouped a crash or a trace event of this board into an issue it had not had before.',
  crashloop: 'This board restarted unexpectedly (a crash, an assert, a fault or a watchdog) again and again.',
  voltage: "This board's supply voltage, from its Memfault heartbeat, is under the alert rule's threshold.",
});

/** The one name an e-mail calls a board or a deployment by. Only names that are plain letters and digits. */
function nameIn(item) {
  if (typeof item.deployment === 'string') return item.version ?? item.deployment;
  return typeof item.name === 'string' && BOARD_NAME.test(item.name) ? item.name : item.thing;
}

/**
 * The e-mail for a mail of takeAlert or flushDue: { subject, message }, plain text, ASCII only.
 * `consoleUrl` is the console's address with its slash, such as https://console.example.com/.
 */
export function emailOf(item, mail, consoleUrl) {
  const name = nameIn(item);
  const count = mail.lines.length + mail.more;
  const subject = `Cranium: ${SUBJECTS[mail.kind](name)}${count > 1 ? ` (${count} alerts)` : ''}`.slice(0, SUBJECT_MAX);
  const who =
    typeof item.deployment === 'string'
      ? `Deployment ${item.deployment}`
      : `${name === item.thing ? item.thing : `${name} (AWS IoT thing ${item.thing})`}`;
  const base = typeof consoleUrl === 'string' && /^https:\/\/[^\s]+\/$/.test(consoleUrl) ? consoleUrl : null;
  const lines = mail.lines
    .flatMap((line) => [
      `${utc(line.at)}  ${line.text}`,
      base !== null && typeof line.link === 'string' && LINK.test(line.link) ? `    ${base}${line.link}` : null,
    ])
    .filter((line) => line !== null);
  const link =
    typeof item.deployment === 'string'
      ? typeof item.rollout === 'string' && DEPLOYMENT_ID.test(item.rollout)
        ? `#/rollouts/${item.rollout}`
        : `#/deployments/${item.deployment}`
      : `#/devices/${item.thing}`;
  const parts = [
    who,
    '',
    LEADS[mail.kind],
    '',
    ...lines,
    mail.more > 0 ? `... and ${mail.more} more of these, left out.` : null,
    '',
    base === null ? null : `Open it on the console: ${base}${link}`,
    base === null ? null : `What the boards did: ${base}#/events`,
    base === null ? null : '',
    'The console sends at most one e-mail an hour about the same board and the same kind of alert. ' +
      'What happens in between comes with the next one.',
    'You get these e-mails because you asked for alerts on the Cranium console. To stop them, use the ' +
      'unsubscribe link below, or Account on the console.',
  ].filter((part) => part !== null);
  return { subject: subject.replace(/[^\x20-\x7e]/g, '?'), message: parts.join('\n').replace(/[^\x20-\x7e\n]/g, '?') };
}

/** The item that says an e-mail went out, for the console's Account page. */
export function sentItem(item, mail, subject, nowMs) {
  const key = typeof item.deployment === 'string' ? item.deployment : item.thing;
  return {
    pk: ALERTS_PK,
    sk: `S#${iso(nowMs)}#${key}#${mail.kind}`,
    kind: mail.kind,
    subject,
    count: mail.lines.length + mail.more,
    ttl: Math.floor(nowMs / 1000) + SENT_DAYS * 86_400,
  };
}

/** An e-mail that went out, as the API returns it, or null: { at, kind, thing | deployment, subject, count }. */
export function sentFromItem(item) {
  const key = isPlain(item) && typeof item.sk === 'string' ? SENT_KEY.exec(item.sk) : null;
  if (key === null || !ALERT_KINDS.includes(key[3]) || key[3] !== item.kind) return null;
  if (typeof item.subject !== 'string' || !PRINTABLE.test(item.subject)) return null;
  const count = Number.isSafeInteger(item.count) && item.count >= 1 ? item.count : 1;
  const sent = { at: key[1], kind: key[3], subject: item.subject, count };
  if (key[3] === 'deployment') sent.deployment = key[2];
  else if (isThing(key[2])) sent.thing = key[2];
  else return null;
  return sent;
}

/** What the watch has seen, before its first look. */
export function emptyWatch() {
  return { pk: ALERTS_PK, sk: WATCH_KEY, checkedAt: null, issues: [], loops: {}, lows: {}, rev: 0 };
}

function keepNewest(map, kept) {
  const entries = Object.entries(isPlain(map) ? map : {}).filter(([, at]) => typeof at === 'string');
  return Object.fromEntries(entries.sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, kept));
}

/**
 * What the rules make of a look at Memfault (handlers/memfault.mjs watch): { state, alerts, newIssues }.
 * `state` is the watch item after it; `alerts` the "crashloop" and "voltage" alerts to raise; `newIssues`
 * the issues it had not seen, whose boards are to be found before their "issue" alerts go
 * ([{ id, title }], at most NEW_ISSUES_READ). The first look only learns the issues there are.
 */
export function watchFindings(watch, facts, rules, nowMs) {
  const known = new Set(Array.isArray(watch.issues) ? watch.issues : []);
  const first = !Number.isFinite(watch.checkedAt);
  const fresh = facts.issues.filter((issue) => !known.has(issue.id));
  const newIssues =
    first || !rules.issue.on
      ? []
      : fresh.slice(0, NEW_ISSUES_READ).map((issue) => ({ id: issue.id, title: issue.title }));
  const alerts = [];
  const loops = keepNewest(watch.loops, BOARDS_KEPT);
  const lows = keepNewest(watch.lows, BOARDS_KEPT);
  if (rules.crashLoop.on) {
    const since = nowMs - rules.crashLoop.minutes * 60_000;
    const byThing = new Map();
    for (const reboot of facts.reboots) {
      if (!isThing(reboot.thing) || reboot.reason?.expected !== false || !(Date.parse(reboot.at) >= since)) continue;
      if (!byThing.has(reboot.thing)) byThing.set(reboot.thing, []);
      byThing.get(reboot.thing).push(reboot);
    }
    for (const [thing, reboots] of [...byThing].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (reboots.length < rules.crashLoop.reboots) continue;
      const last = reboots.sort((a, b) => (a.at < b.at ? 1 : -1))[0];
      if (typeof loops[thing] === 'string' && loops[thing] >= last.at) continue;
      loops[thing] = last.at;
      alerts.push({
        kind: 'crashloop',
        thing,
        at: Date.parse(last.at),
        text:
          `${reboots.length} unexpected restarts in ${rules.crashLoop.minutes} min, the last ${last.reason.name}` +
          `${last.version ? ` on ${last.version}` : ''}`,
      });
    }
  }
  if (rules.voltage.on) {
    const latest = new Map();
    for (const beat of facts.heartbeats) {
      const mv = beat.values?.supply_mv;
      if (!isThing(beat.thing) || !Number.isFinite(mv)) continue;
      if (!latest.has(beat.thing) || latest.get(beat.thing).at < beat.at) latest.set(beat.thing, { at: beat.at, mv });
    }
    for (const [thing, { at, mv }] of [...latest].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (mv >= rules.voltage.mv) continue;
      if (typeof lows[thing] === 'string' && lows[thing] >= at) continue;
      lows[thing] = at;
      alerts.push({
        kind: 'voltage',
        thing,
        at: Date.parse(at),
        text: `Supply ${Math.round(mv)} mV in the heartbeat of ${utc(Date.parse(at))}, under ${rules.voltage.mv} mV`,
      });
    }
  }
  const issues = [...known, ...fresh.map((issue) => issue.id)].slice(-ISSUES_KEPT);
  return { state: { ...watch, checkedAt: nowMs, issues, loops, lows }, alerts, newIssues };
}
