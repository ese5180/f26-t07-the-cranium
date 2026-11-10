// Tests for what an activity entry says changed (lib/audit.mjs change, docs/audit-diff.md): before and
// after, never a secret, and at most a few of them. The handlers' own are in their tests.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_CHANGES,
  MAX_CHANGES_CHARS,
  MAX_CHANGE_VALUE,
  auditDigest,
  auditItem,
  boardsValue,
  change,
  cleanChanges,
  entryFromItem,
} from '../src/lib/audit.mjs';

const BASE = {
  at: Date.parse('2026-11-09T12:00:00Z'),
  requestId: 'req-1',
  actor: { sub: 'abc', email: 'a@example.invalid' },
  action: 'group.update',
  target: 'grp-0a1b2c3d',
  outcome: 'ok',
  detail: {},
};

test('a change is kept only when it changed, as text or none', () => {
  const entry = { changes: [] };
  change(entry, 'name', 'Lab', 'Lab');
  change(entry, 'name', 'Lab', 'Demo');
  change(entry, 'boards', [], ['b', 'a']);
  change(entry, 'size', 3, 4);
  change(entry, 'enabled', true, false);
  change(entry, 'notes', 'old', '');
  assert.deepEqual(entry.changes, [
    { field: 'name', from: 'Lab', to: 'Demo' },
    { field: 'boards', from: null, to: 'b a' },
    { field: 'size', from: '3', to: '4' },
    { field: 'enabled', from: 'true', to: 'false' },
    { field: 'notes', from: 'old', to: null },
  ]);
  const many = Array.from({ length: 30 }, (_, index) => `cranium-${String(index).padStart(16, '0')}`);
  assert.equal(boardsValue(many), '30 boards');
  assert.equal(boardsValue([]), null);
});

test('a secret is never stored: its field or its value says so, and it is kept as hidden', () => {
  const secrets = [
    { field: 'keyHash', from: 'a'.repeat(64), to: 'b'.repeat(64) },
    { field: 'passphrase', from: null, to: 'hunter2hunter2' },
    { field: 'token', from: null, to: 'made' },
    { field: 'certificatePem', from: null, to: 'x' },
    { field: 'label', from: null, to: 'crn_abcdefghijklmnop' },
    { field: 'note', from: '-----BEGIN CERTIFICATE-----', to: null },
  ];
  const item = auditItem({ ...BASE, changes: secrets });
  assert.deepEqual(item.changes, [
    { field: 'keyHash', from: 'hidden', to: 'hidden', hidden: true },
    { field: 'passphrase', from: null, to: 'hidden', hidden: true },
    { field: 'token', from: null, to: 'hidden', hidden: true },
    { field: 'certificatePem', from: null, to: 'hidden', hidden: true },
    { field: 'label', from: null, to: 'hidden', hidden: true },
    { field: 'note', from: 'hidden', to: null, hidden: true },
  ]);
  const text = JSON.stringify(item);
  for (const secret of ['aaaa', 'hunter2', 'crn_', 'BEGIN', 'made']) assert.equal(text.includes(secret), false, secret);
});

test('an entry keeps at most a few changes of a few characters, and counts the rest', () => {
  const long = Array.from({ length: 30 }, (_, index) => ({ field: `field${index}`, from: null, to: 'v' }));
  const item = auditItem({ ...BASE, changes: long });
  assert.equal(item.changes.length, MAX_CHANGES);
  assert.equal(item.changesOmitted, 30 - MAX_CHANGES);

  const wide = Array.from({ length: 10 }, (_, index) => ({
    field: `f${index}`,
    from: 'x'.repeat(500),
    to: 'y'.repeat(500),
  }));
  const cut = auditItem({ ...BASE, changes: wide });
  for (const one of cut.changes) assert.equal(one.from.length, MAX_CHANGE_VALUE);
  const chars = cut.changes.reduce((sum, one) => sum + one.field.length + one.from.length + one.to.length, 0);
  assert.equal(chars <= MAX_CHANGES_CHARS, true);
  assert.equal(cut.changes.length + cut.changesOmitted, 10);
  assert.ok(JSON.stringify(cut).length < 4 * MAX_CHANGES_CHARS);

  // What is not a change is left out: a bad field name, an object, a line break.
  assert.deepEqual(
    cleanChanges([{ field: 'Bad name', from: 'a', to: 'b' }, null, 'x', { field: 'ok', from: 'a\nb', to: 'c' }]),
    {
      changes: [{ field: 'ok', from: 'ab', to: 'c' }],
      omitted: 0,
    }
  );
});

test('an entry without changes is stored as before, and read back without them', () => {
  const plain = auditItem(BASE);
  assert.equal('changes' in plain, false);
  assert.equal('changes' in auditItem({ ...BASE, changes: [] }), false);
  assert.equal('changes' in entryFromItem(plain), false);
  // So its digest is what it was before changes were recorded.
  assert.equal(auditDigest(plain), auditDigest(auditItem({ ...BASE, changes: [{ field: 'a', from: 'x', to: 'x' }] })));

  const stored = auditItem({ ...BASE, changes: [{ field: 'name', from: 'Lab', to: 'Demo' }] });
  assert.deepEqual(entryFromItem(stored).changes, [{ field: 'name', from: 'Lab', to: 'Demo' }]);
  // A stored secret that slipped in is hidden on the way out too.
  assert.deepEqual(entryFromItem({ ...stored, changes: [{ field: 'psk', from: 'a', to: 'b' }] }).changes, [
    { field: 'psk', from: 'hidden', to: 'hidden', hidden: true },
  ]);
});
