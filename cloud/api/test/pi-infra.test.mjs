// Tests for what infra/template.yaml allows a board for Raspberry Pi images, from 1.20.0 (docs/pi-ota.md):
// the list of its own pending jobs, asked for on jobs/get and answered on jobs/get/accepted, and nothing
// wider. A Pi image downloads from where firmware does, so the role that signs its URL is unchanged. Read as
// indented text, as in infra.test.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const template = readFileSync(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
const ARN = 'arn:${AWS::Partition}:iot:${AWS::Region}:${AWS::AccountId}';
const JOBS = '$aws/things/${!iot:Connection.Thing.ThingName}/jobs';

function block(text, key, indent = 2) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${' '.repeat(indent)}${key}:`));
  assert.notEqual(start, -1, `${key} is missing`);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

const policy = block(template, 'DevicePolicy');
const statements = policy.split(/\n {10}- Effect: /).slice(1);
const of = (action) => statements.find((text) => text.includes(`Action: ${action}\n`));
const resources = (action) => [...of(action).matchAll(/- !Sub '([^']+)'/g)].map((match) => match[1]);

test('a board may ask for the list of its own pending jobs, and get the answer', () => {
  assert.ok(resources('iot:Publish').includes(`${ARN}:topic/${JOBS}/get`));
  assert.ok(resources('iot:Subscribe').includes(`${ARN}:topicfilter/${JOBS}/get/accepted`));
  assert.ok(resources('iot:Receive').includes(`${ARN}:topic/${JOBS}/get/accepted`));
});

test('and nothing wider: no other thing, no wildcard, no rejected answer it never subscribes to', () => {
  for (const action of ['iot:Publish', 'iot:Subscribe', 'iot:Receive']) {
    const list = resources(action).filter((arn) => /\/jobs\/get(\/|$)/.test(arn));
    assert.equal(list.length, 1, action);
    assert.equal(list[0].includes('*') || list[0].includes('+') || list[0].includes('#'), false, action);
    assert.ok(list[0].includes('${!iot:Connection.Thing.ThingName}'), action);
  }
  // The firmware's own topics are as they were: $next/get and the updates.
  assert.ok(resources('iot:Publish').includes(`${ARN}:topic/${JOBS}/$next/get`));
  assert.ok(resources('iot:Subscribe').includes(`${ARN}:topicfilter/${JOBS}/$next/get/*`));
  assert.equal(policy.includes('jobs/*/get'), false);
});
