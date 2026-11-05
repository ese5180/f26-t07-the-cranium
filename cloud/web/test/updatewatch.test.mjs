/**
 * The steps after a Bluetooth send, and the board's status over Bluetooth (assets/updatewatch.js): the
 * phone apps' UpdateWatchTests and BoardStatusTests (CraniumKit, and the Android app's UpdateWatchTest and
 * BoardStatusTest), case for case and word for word, so that the app shell's pages say what the classic
 * apps say.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { CORE, scriptAddress } from './page.mjs';

const watch = await import(scriptAddress('updatewatch.js', { 'core.js': CORE }));
const { WORDS } = watch;

const THING = 'cranium-0123456789abcdef';
const SENT = Date.parse('2026-11-05T12:13:00.000Z');
const t = (seconds) => SENT + seconds * 1000;
const iso = (seconds) => new Date(t(seconds)).toISOString();

const line = (seconds, text, { tag = 'BT', seq = 1 } = {}) =>
  ({ thing: THING, at: iso(seconds), id: `7.${seq}`, kind: 'bluetooth', tag, text, boot: 7, seq });
const connection = (seconds, what) => ({ thing: THING, at: iso(seconds), kind: 'connection', what });

/** A board that reported at `seen` s after the send, up for `uptime` s, running `version`. */
const device = ({ seen, uptime, version, confirmed, online = true, bt = null }) =>
  ({ thing: THING, online, lastSeen: iso(seen), fw: { version, confirmed }, uptime, bt });

function facts({ thing = THING, onConsole = true, dropped = null } = {}) {
  return watch.facts({ version: '1.13.0+0', from: '1.12.0+0', sentAt: SENT, thing, onConsole, linkDroppedAt: dropped === null ? null : t(dropped) });
}

const states = (line) => line.rows.map((row) => row.state);
const titles = (line) => line.rows.map((row) => row.title);

test('waiting for a button counts down', () => {
  const line = watch.timeline(facts());
  assert.deepEqual(titles(line), ['Sent 1.13.0+0', 'Button 1 pressed, accepted', 'Installing and restarting',
    'Running 1.13.0+0 on trial', 'Kept 1.13.0+0']);
  assert.equal(line.rows[0].detail, 'Press Button 1 on the board within 2 minutes to install it (Button 2 throws it away).');
  assert.equal(line.rows[0].at, SENT);
  assert.deepEqual(states(line), ['done', 'current', 'waiting', 'waiting', 'waiting']);
  assert.equal(line.waitingForButton, true);
  assert.equal(line.deadline, t(120));
  assert.equal(line.finished, false);
  assert.equal(line.outcome, null);
  assert.equal(line.note, null);
  assert.equal(watch.countdown(102), '1:42 left');
  assert.equal(watch.countdown(120), '2:00 left');
  assert.equal(watch.countdown(9), '0:09 left');
  assert.equal(watch.countdown(0), 'The 2 minutes are up.');
});

test('kept', () => {
  // The real one: offline at the press, back 15 s later on the new version, kept when it reached AWS IoT.
  const f = facts({ dropped: 47 });
  f.events = [connection(45, 'disconnected'), connection(60, 'connected')];
  const watching = watch.timeline(f);
  assert.deepEqual(states(watching), ['done', 'done', 'done', 'waiting', 'waiting']);
  assert.equal(watching.rows[1].at, t(45));
  assert.equal(watching.rows[1].detail, null);
  assert.equal(watching.rows[2].at, t(45));
  assert.equal(watching.finished || watching.waitingForButton, false);

  f.lines = [line(52, 'on trial: 1.13.0+0 from 1.12.0+0, pending, proof none, update 3 of this board', { seq: 1 })];
  const trial = watch.timeline(f);
  assert.deepEqual(states(trial), ['done', 'done', 'done', 'current', 'waiting']);
  assert.equal(trial.rows[3].detail, 'Back online with the new version, not yet kept.');
  assert.equal(trial.rows[3].at, t(52));

  f.lines.push(line(61, 'update over Bluetooth: 1.13.0+0 from 1.12.0+0, succeeded, proof cloud, update 3 of this board', { seq: 9 }));
  const kept = watch.timeline(f);
  assert.deepEqual(states(kept), ['done', 'done', 'done', 'done', 'done']);
  assert.equal(kept.rows[4].title, 'Kept 1.13.0+0');
  assert.equal(kept.rows[4].detail, 'It reached AWS IoT, so the board keeps it.');
  assert.equal(kept.rows[4].at, t(61));
  assert.equal(kept.outcome, 'kept');
  assert.equal(kept.tentative, false);
  assert.equal(kept.finished, true);
  assert.equal(kept.note, null);
  assert.equal(kept.acceptedAt, t(45));
  assert.deepEqual(watch.followedRecord(f, kept),
    { thing: THING, version: '1.13.0+0', at: t(45), outcome: 'kept', tentative: false, rolledBackTo: null });
});

test('kept from the board\'s report alone', () => {
  // No lines (firmware before 1.12.0, or lost from a full queue): the board's report says it.
  const f = facts({ dropped: 47 });
  f.device = device({ seen: 70, uptime: 12, version: '1.13.0+0', confirmed: false });
  const trial = watch.timeline(f);
  assert.deepEqual(states(trial), ['done', 'done', 'done', 'current', 'waiting']);
  assert.equal(trial.rows[3].at, t(58));
  f.device = device({
    seen: 75, uptime: 17, version: '1.13.0+0', confirmed: true,
    bt: { from: '1.12.0+0', to: '1.13.0+0', result: 'succeeded', proof: 'cloud', count: 3 },
  });
  const kept = watch.timeline(f);
  assert.equal(kept.outcome, 'kept');
  assert.equal(kept.finished, true);
  assert.equal(kept.rows[4].detail, 'It reached AWS IoT, so the board keeps it.');
  // A report from before the send says nothing about it.
  f.device = device({ seen: -20, uptime: 4000, version: '1.12.0+0', confirmed: true });
  assert.equal(watch.timeline(f).outcome, null);
});

test('rolled back', () => {
  const f = facts({ dropped: 40 });
  f.events = [connection(38, 'disconnected'), connection(400, 'connected')];
  f.lines = [line(52, 'on trial: 1.13.0+0 from 1.12.0+0, pending, proof none, update 3 of this board', { seq: 1 }),
    line(395, 'update over Bluetooth: 1.13.0+0 from 1.12.0+0, rolled_back, proof none, update 3 of this board', { seq: 2 })];
  const line1 = watch.timeline(f);
  assert.deepEqual(states(line1), ['done', 'done', 'done', 'done', 'failed']);
  assert.equal(line1.rows[4].title, 'Rolled back to 1.12.0+0');
  assert.equal(line1.rows[4].detail, 'The new image was not kept: the bootloader put the old one back.');
  assert.equal(line1.rows[4].at, t(395));
  assert.equal(line1.outcome, 'rolled_back');
  assert.equal(line1.finished, true);
  assert.equal(line1.rolledBackTo, '1.12.0+0');

  // Not installed at all: it never ran on trial.
  f.lines = [line(60, 'update over Bluetooth: 1.13.0+0 from 1.12.0+0, not_installed, proof none, update 3 of this board')];
  const notInstalled = watch.timeline(f);
  assert.deepEqual(states(notInstalled), ['done', 'done', 'done', 'waiting', 'failed']);
  assert.equal(notInstalled.rows[4].detail, 'The bootloader did not install the new image.');

  // Only the board's report: back after the send, on the old version.
  f.lines = [];
  f.events = [connection(38, 'disconnected')];
  f.device = device({ seen: 90, uptime: 20, version: '1.12.0+0', confirmed: true });
  const back = watch.timeline(f);
  assert.equal(back.outcome, 'rolled_back');
  assert.equal(back.rows[4].title, 'Rolled back to 1.12.0+0');
  assert.equal(back.rows[4].detail, 'Back on the old version.');
  assert.equal(back.rows[4].at, t(70));
});

test('Button 2', () => {
  const f = facts({ dropped: 31 });
  const linkOnly = watch.timeline(f);
  assert.deepEqual(states(linkOnly), ['done', 'likely', 'waiting', 'waiting', 'waiting']);
  assert.equal(linkOnly.rows[1].detail, 'The board closed the link: it is installing.');
  assert.equal(linkOnly.rows[1].at, t(31));
  assert.equal(linkOnly.finished, false);

  f.lines = [line(30, 'closed: by Button 2')];
  const declined = watch.timeline(f);
  assert.deepEqual(titles(declined), ['Sent 1.13.0+0', 'Button 2 pressed: the image was thrown away']);
  assert.deepEqual(states(declined), ['done', 'failed']);
  assert.equal(declined.rows[1].at, t(30));
  assert.equal(declined.outcome, 'declined');
  assert.equal(declined.finished, true);
  assert.equal(declined.tentative, false);
  assert.equal(watch.followedRecord(f, declined).at, SENT);
});

test('the window ran out', () => {
  const f = facts({ dropped: 121 });
  f.lines = [line(120, 'closed: no image to install')];
  const expired = watch.timeline(f);
  assert.deepEqual(titles(expired), ['Sent 1.13.0+0', 'The 2 minutes ran out: the image was thrown away']);
  assert.equal(expired.outcome, 'expired');
  assert.equal(expired.finished, true);
  assert.equal(expired.tentative, false);

  // The link closing at the end of the 2 minutes, before the console has said so: most likely that.
  f.lines = [];
  const likely = watch.timeline(f);
  assert.deepEqual(titles(likely), ['Sent 1.13.0+0', 'The 2 minutes ran out']);
  assert.equal(likely.rows[1].state, 'likely');
  assert.equal(likely.rows[1].detail, 'The board closed the link at the end of its 2 minutes: it has most likely thrown the image away.');
  assert.equal(likely.outcome, 'expired');
  assert.equal(likely.tentative, true);
  assert.equal(likely.finished, false);
  // And Button 1 after all, if the board then goes offline: the console's word wins.
  f.events = [connection(118, 'disconnected')];
  assert.equal(watch.timeline(f).rows[1].title, 'Button 1 pressed, accepted');
  assert.equal(watch.timeline(f).outcome, null);
});

test('an offline board', () => {
  const line1 = watch.timeline(facts({ onConsole: false, dropped: 40 }));
  assert.deepEqual(states(line1), ['done', 'likely', 'waiting', 'waiting', 'waiting']);
  assert.equal(line1.rows[1].detail, 'The board closed the link: it is installing.');
  assert.equal(line1.note, 'The board is not on the console, so the app can\'t follow it from here. After it restarts, check its version over Bluetooth.');
  assert.equal(line1.finished, true);
  assert.equal(line1.outcome, null);
  // While the link is up the link is what is followed: nothing to say yet.
  assert.equal(watch.timeline(facts({ onConsole: false })).note, null);
});

test('a link drop with no cloud', () => {
  const line1 = watch.timeline(facts({ thing: null, onConsole: null, dropped: 40 }));
  assert.deepEqual(states(line1), ['done', 'likely', 'waiting', 'waiting', 'waiting']);
  assert.equal(line1.note, WORDS.cannotFollow);
  assert.equal(line1.finished, true);
  assert.equal(watch.followedRecord(facts({ thing: null }), line1), null);
  // At the end of the 2 minutes, with nothing to ask: most likely thrown away, and said so.
  const late = watch.timeline(facts({ thing: null, onConsole: null, dropped: 119 }));
  assert.equal(late.outcome, 'expired');
  assert.equal(late.tentative, true);
  assert.equal(late.finished, true);
  assert.equal(late.note, WORDS.cannotFollow);
});

test('five minutes without an end', () => {
  const f = facts({ dropped: 40 });
  f.events = [connection(39, 'disconnected')];
  f.consoleFailed = true;
  const failing = watch.timeline(f);
  assert.deepEqual(states(failing), ['done', 'done', 'current', 'waiting', 'waiting']);
  assert.equal(failing.rows[2].detail, 'The board is offline on the console while it installs.');
  assert.equal(failing.note, 'The console could not be reached just now. The app keeps asking.');
  assert.equal(failing.finished, false);
  f.gaveUp = true;
  const gaveUp = watch.timeline(f);
  assert.equal(gaveUp.note, '5 minutes have passed, so the app has stopped following it. The board\'s page shows how it ends.');
  assert.equal(gaveUp.finished, true);
});

test('only this send counts', () => {
  const f = facts({ dropped: 40 });
  f.lines = [
    // An earlier window, and another version.
    line(-200, 'closed: by Button 2'),
    line(60, 'update over Bluetooth: 1.12.0+0 from 1.11.0+0, succeeded, proof cloud, update 2 of this board'),
    // Not a line of the Bluetooth update, though it says the words.
    line(61, 'update over Bluetooth: 1.13.0+0 from 1.12.0+0, succeeded, proof cloud, update 3 of this board', { tag: 'CMD' }),
  ];
  f.events = [connection(-100, 'disconnected'), { thing: THING, at: iso(45), kind: 'bluetooth', what: 'closed' }];
  const line1 = watch.timeline(f);
  assert.equal(line1.outcome, null);
  assert.deepEqual(states(line1), ['done', 'likely', 'waiting', 'waiting', 'waiting']);
  // The record of the board's restart into the bootloader, if it ever gets out before the restart, is Button 1.
  f.lines = [line(44, 'restarting into the bootloader: 1.13.0+0 from 1.12.0+0, pending, proof none, update 3 of this board')];
  const restarting = watch.timeline(f);
  assert.equal(restarting.rows[1].state, 'done');
  assert.equal(restarting.rows[1].at, t(44));
});

test('the board\'s page', () => {
  const time = () => '12:14';
  const kept = { thing: THING, version: '1.13.0+0', at: t(45), outcome: 'kept', tentative: false, rolledBackTo: null };
  assert.equal(watch.summary(kept, null, time), '1.13.0+0 over Bluetooth at 12:14, kept');
  const back = { ...kept, outcome: 'rolled_back', rolledBackTo: '1.12.0+0' };
  assert.equal(watch.summary(back, null, time), '1.13.0+0 over Bluetooth at 12:14, rolled back to 1.12.0+0');
  assert.equal(watch.summary({ ...kept, at: t(0), outcome: 'declined' }, null, time), '1.13.0+0 over Bluetooth at 12:14, thrown away with Button 2');
  assert.equal(watch.summary({ ...kept, at: t(0), outcome: 'expired' }, null, time),
    '1.13.0+0 over Bluetooth at 12:14, not installed: the 2 minutes ran out');
  // Not followed to the end here: the board's own record finishes the sentence.
  const open = { ...kept, outcome: null };
  const record = { from: '1.12.0+0', to: '1.13.0+0', result: 'succeeded', proof: 'cloud', count: 3 };
  assert.equal(watch.summary(open, null, time), '1.13.0+0 over Bluetooth at 12:14, not followed to the end');
  assert.equal(watch.summary(open, record, time), '1.13.0+0 over Bluetooth at 12:14, kept');
  // Only the board's record: no time, which it does not keep.
  assert.equal(watch.summary(null, record, time), '1.13.0+0 over Bluetooth, kept');
  const lost = { from: '1.12.0+0', to: '1.13.0+0', result: 'rolled_back', proof: 'none', count: 0 };
  assert.equal(watch.summary(null, lost, time), '1.13.0+0 over Bluetooth, rolled back to 1.12.0+0');
  assert.equal(watch.summary(null, null, time), null);
});

test('polling backs off on a 429', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(watch.nextPoll), [3000, 6000, 12000, 24000, 30000, 30000]);
});

// The board's own status over Bluetooth (firmware 1.14.0 on).

const HASH = 'deadbeef01020304';

/** A status as parseStatus gives it, with what a case changes. */
function status(fields) {
  return {
    window: 'closed', secondsLeft: 0, image: 'none', refusal: 'none', imageBytes: 0, imageVersion: null, result: 'none',
    closedReason: 0, running: '1.12.0+0', onTrial: false, swap: 'none', lastVia: 'none', lastOutcome: 'none',
    lastProof: 'none', lastTarget: null, lastFrom: null, lastHash: null, lastCount: 0, uptime: 0, ...fields,
  };
}

/** What the board says on the link of the send: an image on offer, by default. */
function onLink(seconds, { window = 'offer', left = 100, image = 'verified', result = 'none', refusal = 'none' } = {}) {
  const installing = result === 'installing';
  return {
    status: status({
      window, secondsLeft: left, image, refusal, imageBytes: 872000, imageVersion: '1.13.0+0', result, running: '1.12.0+0',
      lastVia: 'bluetooth', lastOutcome: installing ? 'pending' : 'kept', lastProof: installing ? 'none' : 'cloud',
      lastTarget: installing ? '1.13.0+0' : '1.12.0+0', lastFrom: installing ? '1.12.0+0' : '1.11.4+0',
      lastHash: installing ? HASH : '0102030405060708', lastCount: installing ? 3 : 2, uptime: 4000,
    }),
    at: t(seconds),
    afterRestart: false,
  };
}

/** What the board says after its restart, to a phone that reads it with no pairing. */
function afterRestart(seconds, { running = '1.13.0+0', onTrial = true, outcome = 'pending', proof = 'none', target = '1.13.0+0', hash = HASH } = {}) {
  return {
    status: status({
      window: 'status', secondsLeft: 100, running, onTrial, swap: onTrial ? 'revert' : 'none', lastVia: 'bluetooth',
      lastOutcome: outcome, lastProof: proof, lastTarget: target, lastFrom: '1.12.0+0', lastHash: hash, lastCount: 3, uptime: 20,
    }),
    at: t(seconds),
    afterRestart: true,
  };
}

function told({ dropped = null, thing = THING, onConsole = true } = {}, ...readings) {
  const f = facts({ thing, onConsole, dropped });
  f.readings = readings;
  f.sentHash = HASH;
  return f;
}

test('the board counts its two minutes down', () => {
  const line1 = watch.timeline(told({}, onLink(5, { left: 100 })));
  assert.equal(line1.deadline, t(105));
  assert.equal(line1.waitingForButton, true);
  assert.deepEqual(states(line1), ['done', 'current', 'waiting', 'waiting', 'waiting']);
  // A board without the characteristic: the phone's own count, as before.
  assert.equal(watch.timeline(facts()).deadline, t(120));
});

test('Button 1 from the board', () => {
  const f = told({}, onLink(5), onLink(30, { result: 'installing' }));
  const pressed = watch.timeline(f);
  assert.deepEqual(states(pressed), ['done', 'done', 'current', 'waiting', 'waiting']);
  assert.equal(pressed.rows[1].title, 'Button 1 pressed, accepted');
  assert.equal(pressed.rows[1].detail, 'The board said so over Bluetooth, and is restarting to install it.');
  assert.equal(pressed.rows[1].at, t(30));
  assert.equal(pressed.rows[2].detail, 'The board is restarting into the bootloader, which checks the image and swaps it in.');
  assert.equal(pressed.rows[2].at, t(30));
  assert.equal(pressed.waitingForButton, false);
  assert.equal(pressed.acceptedAt, t(30));
  assert.equal(pressed.finished, false);

  // The link goes, and the console has it offline: its word for the time it went.
  f.linkDroppedAt = t(31);
  f.events = [connection(31, 'disconnected')];
  const offline = watch.timeline(f);
  assert.equal(offline.rows[1].at, t(30));
  assert.equal(offline.rows[2].detail, 'The board is offline on the console while it installs.');
  assert.equal(offline.rows[2].at, t(31));
  assert.equal(watch.followedRecord(f, offline).at, t(30));
});

test('kept from the board after its restart', () => {
  const f = told({ dropped: 31 }, onLink(5), onLink(30, { result: 'installing' }), afterRestart(140));
  const trial = watch.timeline(f);
  assert.deepEqual(states(trial), ['done', 'done', 'done', 'current', 'waiting']);
  assert.equal(trial.rows[3].detail, 'The board says so over Bluetooth: not yet kept.');
  assert.equal(trial.rows[3].at, t(140));
  assert.equal(trial.finished, false);
  assert.equal(trial.note, null);
  assert.equal(watch.followUntil(f), t(740));

  f.readings.push(afterRestart(150, { onTrial: false, outcome: 'kept', proof: 'cloud' }));
  const kept = watch.timeline(f);
  assert.deepEqual(states(kept), ['done', 'done', 'done', 'done', 'done']);
  assert.equal(kept.rows[4].title, 'Kept 1.13.0+0');
  assert.equal(kept.rows[4].detail, 'It reached AWS IoT, so the board keeps it.');
  assert.equal(kept.rows[4].at, t(150));
  assert.equal(kept.rows[3].at, t(140));
  assert.equal(kept.outcome, 'kept');
  assert.equal(kept.finished, true);
  assert.equal(kept.tentative, false);
});

test('rolled back from the board', () => {
  // On trial, and 5 minutes later back on the old image, which says so.
  const f = told({ dropped: 31 }, onLink(30, { result: 'installing' }), afterRestart(140),
    afterRestart(500, { running: '1.12.0+0', onTrial: false, outcome: 'rolledBack' }));
  const line1 = watch.timeline(f);
  assert.deepEqual(states(line1), ['done', 'done', 'done', 'done', 'failed']);
  assert.equal(line1.rows[4].title, 'Rolled back to 1.12.0+0');
  assert.equal(line1.rows[4].detail, 'The new image was not kept: the bootloader put the old one back.');
  assert.equal(line1.rows[4].at, t(500));
  assert.equal(line1.outcome, 'rolled_back');
  assert.equal(line1.rolledBackTo, '1.12.0+0');
  assert.equal(line1.finished, true);

  // The bootloader did not take it, a bad signature for one: it never ran on trial.
  const notInstalled = watch.timeline(told({ dropped: 31 }, onLink(30, { result: 'installing' }),
    afterRestart(130, { running: '1.12.0+0', onTrial: false, outcome: 'notInstalled' })));
  assert.deepEqual(states(notInstalled), ['done', 'done', 'done', 'waiting', 'failed']);
  assert.equal(notInstalled.rows[4].detail, 'The bootloader did not install the new image.');
});

test('Button 2 and the time, from the board', () => {
  const discarded = watch.timeline(told({}, onLink(5), onLink(30, { window: 'closed', result: 'discarded' })));
  assert.deepEqual(titles(discarded), ['Sent 1.13.0+0', 'Button 2 pressed: the image was thrown away']);
  assert.equal(discarded.rows[1].detail, 'The board said so over Bluetooth.');
  assert.equal(discarded.rows[1].at, t(30));
  assert.equal(discarded.outcome, 'declined');
  assert.equal(discarded.finished, true);

  const expired = watch.timeline(told({ dropped: 121 }, onLink(5), onLink(120, { window: 'closed', left: 0, result: 'timedOut' })));
  assert.deepEqual(titles(expired), ['Sent 1.13.0+0', 'The 2 minutes ran out: the image was thrown away']);
  assert.equal(expired.rows[1].state, 'failed');
  assert.equal(expired.rows[1].detail, 'The board said so over Bluetooth.');
  assert.equal(expired.outcome, 'expired');
  assert.equal(expired.tentative, false);
  assert.equal(expired.finished, true);
});

test('a refusal from the board says why', () => {
  const line1 = watch.timeline(told({}, onLink(3, { window: 'closed', image: 'refused', result: 'closed', refusal: 'incompatibleLayout' })));
  assert.deepEqual(titles(line1), ['Sent 1.13.0+0', 'The board did not take the image']);
  assert.equal(line1.rows[1].detail, 'It is for another flash layout.');
  assert.equal(line1.outcome, 'refused');
  assert.equal(line1.finished, true);
});

test('only this send\'s status counts after the restart', () => {
  // Another board's, or another image of the same version: nothing.
  const other = told({ dropped: 31 }, onLink(30, { result: 'installing' }), afterRestart(140, { hash: '0000000000000001' }));
  assert.deepEqual(states(watch.timeline(other)), ['done', 'done', 'current', 'waiting', 'waiting']);
  const otherVersion = told({ dropped: 31 }, onLink(30, { result: 'installing' }),
    afterRestart(140, { onTrial: false, outcome: 'kept', target: '1.12.0+0' }));
  assert.equal(watch.timeline(otherVersion).outcome, null);
  // An image the app could not read the hash of: the version alone.
  const noHash = told({ dropped: 31 }, onLink(30, { result: 'installing' }), afterRestart(140, { onTrial: false, outcome: 'kept' }));
  noHash.sentHash = null;
  assert.equal(watch.timeline(noHash).outcome, 'kept');
});

test('a board with no console is followed over Bluetooth', () => {
  // A board with no Wi-Fi, which the console does not know: before 1.14.0 the app could not follow it.
  const f = told({ dropped: 31, thing: null, onConsole: null }, onLink(30, { result: 'installing' }));
  const looking = watch.timeline(f);
  assert.equal(looking.note, 'Looking for the board over Bluetooth: for 2 minutes after its restart, a phone can read how it went with no pairing.');
  assert.equal(looking.finished, false);

  f.readings.push(afterRestart(140));
  assert.equal(watch.timeline(f).note, null);

  // A person proved it at the board.
  f.readings.push(afterRestart(260, { onTrial: false, outcome: 'kept', proof: 'person' }));
  const kept = watch.timeline(f);
  assert.equal(kept.outcome, 'kept');
  assert.equal(kept.finished, true);
  assert.equal(kept.rows[4].detail, 'A person at the board proved it.');
  assert.equal(watch.followedRecord(f, kept), null);

  // Not seen again.
  const lost = told({ dropped: 31, thing: null, onConsole: null }, onLink(30, { result: 'installing' }));
  lost.gaveUp = true;
  const gaveUp = watch.timeline(lost);
  assert.equal(gaveUp.note, 'The board was not seen over Bluetooth again, so the app has stopped looking for it. Its version shows when Button 1 opens its window again.');
  assert.equal(gaveUp.finished, true);
});

test('how long the board is followed', () => {
  assert.equal(watch.followUntil(facts()), null);
  assert.equal(watch.followUntil(facts({ dropped: 31 })), t(331));
  // A status from before the restart, or of another send, does not stretch it.
  assert.equal(watch.followUntil(told({ dropped: 31 }, onLink(30, { result: 'installing' }))), t(331));
  assert.equal(watch.followUntil(told({ dropped: 31 }, afterRestart(140, { target: '1.12.0+0' }))), t(331));
  assert.equal(watch.followUntil(told({ dropped: 31 }, afterRestart(140), afterRestart(200))), t(800));
});

// The status characteristic's payload: firmware/tests/host/test_bt_status.c makes this same one
// (`build/bt_status_tests --print`), and BoardStatusTests.swift and BoardStatusTest.kt read it too.

/** An offer of 1.14.1+0 on a board that runs 1.14.0+0 on trial, after an update over Bluetooth before. */
const SAMPLE = '010302010300384e0d00010e0100000000000000010e00000000000007010100010e000000000000010d020007000000deadbeef010203040300040302010000';
const bytes = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

test('the firmware\'s sample', () => {
  const read = watch.parseStatus(bytes(SAMPLE));
  assert.equal(read.window, 'offer');
  assert.equal(read.secondsLeft, 258);
  assert.equal(read.image, 'verified');
  assert.equal(read.refusal, 'none');
  assert.equal(read.imageBytes, 0x000d4e38);
  assert.equal(read.imageVersion, '1.14.1+0');
  assert.equal(read.result, 'none');
  assert.equal(read.closedReason, 0);
  assert.equal(read.running, '1.14.0+0');
  assert.equal(read.onTrial, true);
  assert.equal(read.swap, 'revert');
  assert.equal(read.lastVia, 'bluetooth');
  assert.equal(read.lastOutcome, 'pending');
  assert.equal(read.lastProof, 'none');
  assert.equal(read.lastTarget, '1.14.0+0');
  assert.equal(read.lastFrom, '1.13.2+7');
  assert.equal(read.lastHash, 'deadbeef01020304');
  assert.equal(read.lastCount, 3);
  assert.equal(read.uptime, 0x01020304);
  // As the app sends it, in base64.
  assert.deepEqual(watch.statusFromBase64(Buffer.from(SAMPLE, 'hex').toString('base64')), read);
});

test('what cannot be read', () => {
  // Too short, as a read on a link of the default MTU would be if it were not a long read.
  assert.equal(watch.parseStatus(bytes(SAMPLE.slice(0, 40))), null);
  // Another format.
  assert.equal(watch.parseStatus(bytes(`02${SAMPLE.slice(2)}`)), null);
  assert.equal(watch.parseStatus(new Uint8Array(0)), null);
  assert.equal(watch.statusFromBase64('not base64!'), null);
  // Longer is fine: a later firmware may add to the end.
  assert.notEqual(watch.parseStatus(bytes(`${SAMPLE}ffff`)), null);
});

test('nothing to say', () => {
  const raw = new Uint8Array(64);
  raw[0] = 1;
  raw[20] = 1;
  raw[21] = 14;
  const read = watch.parseStatus(raw);
  assert.equal(read.window, 'closed');
  assert.equal(read.image, 'none');
  assert.equal(read.imageVersion, null);
  assert.equal(read.lastTarget, null);
  assert.equal(read.lastFrom, null);
  assert.equal(read.lastHash, null);
  assert.equal(read.running, '1.14.0+0');
  assert.equal(read.onTrial, false);
  assert.equal(read.swap, 'none');
  assert.equal(read.lastVia, 'none');
});

test('numbers from a later firmware', () => {
  const raw = bytes(SAMPLE);
  raw[1] = 9;
  raw[5] = 42;
  raw[30] = 99;
  const read = watch.parseStatus(raw);
  assert.equal(read.window, 'unknown');
  assert.equal(read.refusal, 'unknown');
  assert.equal(read.lastOutcome, 'unknown');
  assert.equal(watch.outcomeIsEnd(read.lastOutcome), false);
});

test('what counts as news', () => {
  const read = watch.parseStatus(bytes(SAMPLE));
  const raw = bytes(SAMPLE);
  raw[2] = 1; // seconds left
  raw[7] = 0x50; // bytes
  raw[58] = 9; // uptime
  const counted = watch.parseStatus(raw);
  assert.equal(watch.isNews(counted, read), false);
  raw[18] = 1; // installing
  const installing = watch.parseStatus(raw);
  assert.equal(watch.isNews(installing, read), true);
  assert.equal(installing.result, 'installing');
  assert.equal(watch.isNews(read, null), true);
});

test('words for each refusal and outcome', () => {
  assert.equal(watch.refusalWords('older'), 'It is not newer than what the board runs.');
  assert.equal(watch.refusalWords('incompatibleBoard'), 'It is for another kind of board.');
  assert.equal(watch.refusalWords('incompatibleLayout'), 'It is for another flash layout.');
  assert.equal(watch.refusalWords('unknown'), 'The board did not say why.');
  assert.equal(watch.outcomeWord('kept'), 'succeeded');
  assert.equal(watch.outcomeWord('rolledBack'), 'rolled_back');
  assert.equal(watch.outcomeWord('notInstalled'), 'not_installed');
  assert.equal(watch.outcomeIsEnd('pending'), false);
  assert.equal(watch.outcomeIsEnd('kept'), true);
  assert.equal(watch.proofWord('cloud'), 'cloud');
  assert.equal(watch.proofWord('unknown'), 'none');
});

test('the UUIDs are the firmware\'s', () => {
  assert.equal(watch.STATUS_SERVICE, '9112B1B4-2A51-40F0-94D3-A76440F0E6CC');
  assert.equal(watch.STATUS_CHARACTERISTIC, '9112B1B5-2A51-40F0-94D3-A76440F0E6CC');
});

test('the image\'s own hash, which the board keeps: from the TLV area, not the SHA-256 of the file', () => {
  const file = new Uint8Array(32 + 16);
  file.set([0x3d, 0xb8, 0xf3, 0x96], 0);
  file[8] = 32; // header size
  file[12] = 16; // image size
  const digest = Array.from({ length: 32 }, (_, index) => index + 0xa0);
  const tlv = [0x07, 0x69, 0x00, 0x00, 0x01, 0x00, 0x04, 0x00, 1, 2, 3, 4, 0x10, 0x00, 0x20, 0x00, ...digest];
  tlv[2] = tlv.length;
  const whole = new Uint8Array([...file, ...tlv]);
  const hex = digest.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  assert.equal(watch.imageHash(whole), hex);
  assert.equal(watch.imageHashPrefix(whole), hex.slice(0, 16));
  assert.notEqual(hex, createHash('sha256').update(whole).digest('hex'));
  // No TLV area where the header says.
  assert.equal(watch.imageHash(whole.subarray(0, 60)), null);
  const wrong = whole.slice();
  wrong[48] = 0x08;
  assert.equal(watch.imageHash(wrong), null);
});
