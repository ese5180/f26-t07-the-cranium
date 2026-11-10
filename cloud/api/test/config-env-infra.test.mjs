// Every Lambda function whose handler loads config.mjs must be given every setting that config.mjs
// requires. A function missing one fails on start, every time, with nothing else broken to point at
// it: the rollout schedule did so twice (LOGIN_DOMAIN, then DEVICE_POLICY and
// FIRMWARE_DOWNLOAD_PREFIX), and staged rollouts stopped after their canary.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const api = join(here, '..');
const infra = join(api, '..', 'infra');
const template = readFileSync(join(infra, 'template.yaml'), 'utf8');
const config = readFileSync(join(api, 'src', 'config.mjs'), 'utf8');

/** The settings config.mjs cannot do without. AWS_REGION is set by Lambda itself. */
function requiredSettings() {
  const names = new Set([...config.matchAll(/\bread\(env, '([A-Z0-9_]+)'\)/g)].map((match) => match[1]));
  if (config.includes("'Environment variable SIGNING_PUBLIC_KEY_B64 is missing")) names.add('SIGNING_PUBLIC_KEY_B64');
  names.delete('AWS_REGION');
  return names;
}

/** Each function of the template: its handler module and the names of its environment. */
function functions() {
  const found = [];
  for (const match of template.matchAll(/\n {2}(\w+Fn):\n([\s\S]*?)(?=\n {2}\w+:\n|\nOutputs:)/g)) {
    const [, name, body] = match;
    const handler = /\n {6}Handler: ([\w-]+)\./.exec(body);
    const code = /\n {6}Code: (\S+)/.exec(body);
    if (!handler || !code) continue;
    const env = new Set([...body.matchAll(/\n {10}([A-Z0-9_]+):/g)].map((entry) => entry[1]));
    found.push({ name, file: join(infra, code[1], `${handler[1]}.mjs`), env });
  }
  return found;
}

test('every function that loads config.mjs is given every setting it requires', () => {
  const required = requiredSettings();
  assert.ok(required.has('LOGIN_DOMAIN') && required.has('DEVICE_POLICY'), [...required].join(' '));
  const loaders = functions().filter(
    ({ file }) => existsSync(file) && readFileSync(file, 'utf8').includes('loadConfig')
  );
  assert.ok(loaders.some(({ name }) => name === 'ApiFn') && loaders.some(({ name }) => name === 'RolloutTickFn'));
  for (const { name, env } of loaders) {
    const missing = [...required].filter((setting) => !env.has(setting));
    assert.deepEqual(missing, [], `${name} lacks ${missing.join(', ')}`);
  }
});
