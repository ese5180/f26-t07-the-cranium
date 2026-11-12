// What the firmware sends and what the console reads, checked against the firmware's own sources:
// a word the board can send is a word the console takes.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { alertOfEvent } from '../src/lib/alerts.mjs';
import { changesBetween } from '../src/lib/events.mjs';
import { KIND_OF_TAG, TAGS, recordsFromLine } from '../src/lib/lines.mjs';
import { BT_RESULTS, readReported } from '../src/lib/shadow.mjs';
import { BT_RESULTS as UPDATE_BT_RESULTS } from '../src/lib/updates.mjs';

const firmware = (path) => readFileSync(new URL(`../../../firmware/app/src/${path}`, import.meta.url), 'utf8');
const THING = 'cranium-0123456789abcdef';
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

/** The tags of cloud_events.c sources[]: every one the board may send. */
function firmwareTags() {
  const source = firmware('cloud/cloud_events.c');
  const table = /static const struct source sources\[\] = \{([\s\S]*?)\n\};/.exec(source)[1];
  return [...table.matchAll(/\{ "([A-Za-z_]+)", RULE_/g)].map((match) => match[1]);
}

/** The words of bt_ota_policy.c bt_ota_result_text(). */
function firmwareBtResults() {
  const source = firmware('policy/bt_ota_policy.c');
  const body = /const char \*bt_ota_result_text\([^)]*\)\n\{([\s\S]*?)\n\}/.exec(source)[1];
  return [...body.matchAll(/return "([a-z_]+)";/g)].map((match) => match[1]);
}

test('every tag the board may send its lines under is one the board log stores', () => {
  const tags = firmwareTags();
  assert.ok(tags.includes('location'), 'the firmware sends location lines');
  for (const tag of tags) {
    assert.ok(TAGS.includes(tag), `${tag} is stored`);
    assert.ok(Object.hasOwn(KIND_OF_TAG, tag), `${tag} has a kind`);
  }
});

test('a location line from the board is stored, as a line of the log', () => {
  const out = recordsFromLine(
    {
      thing: THING,
      received: NOW,
      t: 1000,
      up: 1000,
      seq: 7,
      boot: 3,
      tag: 'location',
      text: 'Location: 5 access points sent',
    },
    { nowMs: NOW }
  );
  assert.equal(out.ignored, undefined);
  assert.equal(out.items[0].kind, 'log');
  assert.equal(out.items[0].text, 'Location: 5 access points sent');
});

test('every Bluetooth result the board reports is one the shadow and the update history read', () => {
  const results = firmwareBtResults();
  assert.ok(results.includes('incompatible_board') && results.includes('incompatible_layout'));
  for (const result of results) {
    assert.ok(BT_RESULTS.includes(result), `shadow reads ${result}`);
    assert.ok(UPDATE_BT_RESULTS.includes(result), `update history reads ${result}`);
  }
});

test('an image for another board, refused over Bluetooth, is on record as a failed update and alerts', () => {
  const bt = { from: '1.19.2+0', to: '1.19.3+0', result: 'incompatible_board', proof: 'none', count: 4 };
  assert.deepEqual(readReported({ bt }).bt, { ...bt, from: '1.19.2+0', to: '1.19.3+0' });
  const changes = changesBetween({ bt: { ...bt, result: 'succeeded', count: 3 } }, { bt });
  const record = changes.find((change) => change.kind === 'bluetooth' && change.what === 'record');
  assert.ok(record, 'a record event');
  assert.equal(record.level, 'warn');
  assert.match(
    record.text,
    /^Bluetooth update from 1\.19\.2\+0 to 1\.19\.3\+0 was refused: the image is for another board$/
  );
  const item = {
    pk: THING,
    sk: `E#${new Date(NOW).toISOString()}#bluetooth`,
    kind: record.kind,
    what: record.what,
    text: record.text,
    ...record.fields,
  };
  assert.equal(alertOfEvent(item)?.kind, 'update');
});
