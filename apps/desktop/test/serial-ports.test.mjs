// Tests for the serial port chooser's list (src/lib/serial-ports.mjs): a J-Link's console port first and named,
// its log port named, anything else after them as it came.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { orderPorts } from '../src/lib/serial-ports.mjs';

const jlink = (portId, portName, serialNumber = '001050700001') => ({
  portId,
  portName,
  displayName: 'J-Link',
  vendorId: '1366',
  productId: '1051',
  serialNumber,
});

test('on Linux the higher ttyACM of a J-Link is its console port, and comes first', () => {
  const ordered = orderPorts([jlink('a', 'ttyACM0'), jlink('b', 'ttyACM1')]);
  assert.deepEqual(
    ordered.map(({ portId, role }) => [portId, role]),
    [
      ['b', 'console'],
      ['a', 'log'],
    ]
  );
  assert.equal(ordered[0].label, 'J-Link (ttyACM1): the console port');
  assert.equal(ordered[1].label, 'J-Link (ttyACM0): the log port');
});

test('on Windows the higher COM port, by number not by text', () => {
  const ordered = orderPorts([jlink('a', 'COM10'), jlink('b', 'COM9')]);
  assert.deepEqual(
    ordered.map(({ portId, role }) => [portId, role]),
    [
      ['a', 'console'],
      ['b', 'log'],
    ]
  );
});

test('two J-Links each get their own pair; other ports and unclear ones are named as they are, after them', () => {
  const other = { portId: 'x', portName: 'ttyUSB0', displayName: 'USB serial', vendorId: '0403' };
  const ordered = orderPorts([
    other,
    jlink('a', 'ttyACM0', '1'),
    jlink('b', 'ttyACM1', '1'),
    jlink('c', 'ttyACM2', '2'),
    jlink('d', 'ttyACM3', '2'),
  ]);
  assert.deepEqual(
    ordered.map(({ portId }) => portId),
    ['b', 'd', 'a', 'c', 'x']
  );
  assert.equal(ordered.at(-1).label, 'USB serial (ttyUSB0)');
  // A J-Link with one port, or names with no number, is not guessed at.
  assert.deepEqual(
    orderPorts([jlink('a', 'ttyACM0'), jlink('b', 'odd', '9'), jlink('c', 'odder', '9')]).map(({ role }) => role),
    [null, null, null]
  );
  assert.deepEqual(orderPorts(null), []);
});

test('main.mjs asks with this list, the console port as the default', () => {
  const main = readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.ok(main.includes('const ordered = orderPorts(ports);'));
  assert.ok(main.includes('defaultId: 0,'));
  assert.ok(main.includes('ordered[response].portId'));
});
