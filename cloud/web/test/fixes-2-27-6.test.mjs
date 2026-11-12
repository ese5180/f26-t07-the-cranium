// What a board sends and the console shows, the local days of the Activity filter, and the order of
// versions on the Memfault page (console 2.27.6).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CORE, MEMFAULT, scriptAddress } from './page.mjs';

const core = await import(CORE);
const memfault = await import(MEMFAULT);
const watch = await import(scriptAddress('updatewatch.js', { 'core.js': CORE }));

const firmware = (path) => readFileSync(new URL(`../../../firmware/app/src/${path}`, import.meta.url), 'utf8');

test('the board log takes every tag the firmware sends its lines under, location among them', () => {
  const table = /static const struct source sources\[\] = \{([\s\S]*?)\n\};/.exec(firmware('cloud/cloud_events.c'))[1];
  const tags = [...table.matchAll(/\{ "([A-Za-z_]+)", RULE_/g)].map((match) => match[1]);
  assert.ok(tags.includes('location'));
  for (const tag of tags) assert.ok(core.LINE_TAGS.includes(tag), tag);
});

test('a cloud update the board refused for another board or flash layout is said in words', () => {
  for (const [reason, title] of [
    ['incompatible_board', 'The image is for another board'],
    ['incompatible_layout', 'The image is for another flash layout'],
  ]) {
    const description = core.describeExecution({
      thing: 'cranium-0123456789abcdef',
      phase: 'failed',
      status: 'FAILED',
      progress: null,
      reason,
      detail: null,
      ranAtEnd: null,
      reported: null,
      online: true,
      queuedAt: '2026-11-11T12:00:00.000Z',
      startedAt: null,
      lastUpdatedAt: '2026-11-11T12:00:00.000Z',
      secondsLeft: null,
    });
    assert.equal(description.code, null, reason);
    assert.equal(description.title, title);
    assert.match(description.text, /It kept running the firmware it had\./);
    assert.equal(
      description.steps.findIndex((step) => step.state === 'failed'),
      3
    );
  }
});

test("a board's record of a refused Bluetooth image reads as refused, not as a rollback", () => {
  const bt = { from: '1.19.2+0', to: '1.19.3+0', result: 'incompatible_board', proof: 'none', count: 1 };
  assert.equal(
    watch.summary(null, bt, () => ''),
    '1.19.3+0 over Bluetooth, refused: the image is for another board'
  );
  assert.equal(
    watch.summary(null, { ...bt, result: 'incompatible_layout' }, () => ''),
    '1.19.3+0 over Bluetooth, refused: the image is for another flash layout'
  );
  assert.equal(
    watch.summary(null, { ...bt, result: 'rolled_back' }, () => ''),
    '1.19.3+0 over Bluetooth, rolled back to 1.19.2+0'
  );
});

test('the local days of a filter run from midnight to midnight, also on a day of 23 or 25 hours', () => {
  const zone = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    // The clocks went back on 2026-11-01: that day has 25 hours.
    assert.deepEqual(core.localDayBounds('2026-11-01'), {
      fromMs: Date.parse('2026-11-01T04:00:00.000Z'),
      toMs: Date.parse('2026-11-02T04:59:59.999Z'),
    });
    // And forward on 2026-03-08: 23 hours.
    assert.deepEqual(core.localDayBounds('2026-03-08'), {
      fromMs: Date.parse('2026-03-08T05:00:00.000Z'),
      toMs: Date.parse('2026-03-09T03:59:59.999Z'),
    });
    assert.deepEqual(core.localDayBounds('2026-11-11'), {
      fromMs: Date.parse('2026-11-11T05:00:00.000Z'),
      toMs: Date.parse('2026-11-12T04:59:59.999Z'),
    });
    assert.equal(core.localDayBounds('2026-02-30'), null);
    assert.equal(core.localDayBounds(''), null);
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test('the Memfault page lists versions with as many boards newest first: 1.10 above 1.9', () => {
  const fleet = {
    devices: [{ software: '1.9.0+0' }, { software: '1.10.0+0' }, { software: '1.2.0+0' }, { software: null }],
    releases: [],
  };
  assert.deepEqual(
    memfault.versionsOf(fleet).map((item) => item.version),
    ['1.10.0+0', '1.9.0+0', '1.2.0+0', 'Not known']
  );
});
