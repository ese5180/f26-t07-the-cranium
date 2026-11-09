// Tests for what the stack, the deploy role, cloud/deploy.sh and the deploy workflow promise of Board setup's
// Wi-Fi defaults (docs/new-board-setup.md, "The Wi-Fi defaults"): one secret the stack makes empty, read by the
// API alone, stored from ~/.cranium/wifi_secrets.h or the WIFI_DEFAULTS_JSON repository secret, never printed.
// Read as indented text, as in infra.test.mjs. The header read by deploy.sh is run here on made-up values.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const read = (name) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const template = read('infra/template.yaml');
const role = read('infra/github-deploy.yaml');
const deploy = read('deploy.sh');
const workflow = read('../.github/workflows/deploy-console.yml');

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

function statement(text, sid) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- Sid: ${sid}`);
  assert.notEqual(start, -1, `${sid} is missing`);
  const indent = lines[start].length - lines[start].trimStart().length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() !== '' && !line.trim().startsWith('#') && line.length - line.trimStart().length <= indent) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

test('the stack makes the secret empty, and only the API function may read it, by its ARN', () => {
  const secret = block(template, 'WifiDefaults');
  assert.ok(secret.includes('Type: AWS::SecretsManager::Secret'));
  assert.ok(secret.includes("Name: !Sub '${AWS::StackName}/wifi-defaults'"));
  assert.equal(/SecretString|GenerateSecretString/.test(secret), false);
  const reading = statement(block(template, 'ApiRole'), 'ReadWifiDefaults');
  assert.ok(reading.includes('Effect: Allow'));
  assert.ok(reading.includes('Action: secretsmanager:GetSecretValue\n'));
  assert.ok(reading.includes('Resource: !Ref WifiDefaults'));
  // The API's role, the API's environment and the output: nothing else names it.
  assert.equal(template.split('!Ref WifiDefaults\n').length - 1, 3);
  assert.ok(block(block(template, 'ApiFn'), 'Variables', 8).includes('WIFI_DEFAULTS_SECRET_ARN: !Ref WifiDefaults'));
  assert.ok(block(block(template, 'Outputs', 0), 'WifiDefaultsArn').includes('Value: !Ref WifiDefaults'));
  for (const name of ['MemfaultRole', 'EventsRole', 'WebRole', 'CustomerApiRole']) {
    const text = template.includes(`\n  ${name}:`) ? block(template, name) : '';
    assert.equal(text.includes('WifiDefaults'), false, name);
  }
});

test('the deploy role may store it and never read it', () => {
  assert.ok(role.includes('secret:${ConsoleStackName}/wifi-defaults-*'));
  assert.equal(role.includes('secretsmanager:GetSecretValue'), false);
});

test('deploy.sh stores it through store_secret_file, from the JSON file first, and never prints it', () => {
  assert.ok(deploy.includes('WIFI_SECRETS_FILE="$HOME/.cranium/wifi_secrets.h"'));
  assert.ok(deploy.includes('WIFI_DEFAULTS_FILE="$HOME/.cranium/wifi_defaults.json"'));
  assert.ok(deploy.includes('store_secret_file "$made/wifi_defaults.json" WifiDefaultsArn'));
  assert.ok(deploy.includes('  store_memfault_secrets\n  store_wifi_defaults\n'));
  assert.equal(/cat "\$from"|echo "\$\(|WifiDefaults=|set -x/.test(deploy), false);
  assert.ok(workflow.includes('WIFI_DEFAULTS_JSON: ${{ secrets.WIFI_DEFAULTS_JSON }}'));
  assert.ok(workflow.includes(`printf '%s' "$WIFI_DEFAULTS_JSON" > "$HOME/.cranium/wifi_defaults.json"`));
  assert.ok(workflow.includes('"$HOME/.cranium/wifi_defaults.json"\n'));
  assert.equal(/echo "\$WIFI_DEFAULTS_JSON"/.test(workflow), false);
});

/** deploy.sh's wifi_defaults_json, run on a file; { status, out, err }. */
function convert(name, text) {
  const folder = mkdtempSync(join(tmpdir(), 'cranium-wifi-'));
  try {
    const file = join(folder, name);
    writeFileSync(file, text, { mode: 0o600 });
    const start = deploy.indexOf('wifi_defaults_json() {');
    const end = deploy.indexOf('\n}\n', start) + 3;
    const result = spawnSync('bash', ['-c', `${deploy.slice(start, end)}\nwifi_defaults_json "$1"`, 'convert', file], {
      encoding: 'utf8',
    });
    return { status: result.status, out: result.stdout, err: result.stderr };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test('the header tools/secrets.py writes becomes the JSON the API reads, and a bad one says why, not what', () => {
  const header = (ssid, passphrase, security = 'WPA2_PSK') =>
    `#ifndef WIFI_SECRETS_H_\n#define WIFI_SECRETS_H_\n\n#define WIFI_SECRETS_SSID "${ssid}"\n` +
    `#define WIFI_SECRETS_PASSPHRASE "${passphrase}"\n#define WIFI_SECRETS_SECURITY ${security}\n\n#endif\n`;
  const good = convert('wifi_secrets.h', header('Fake\\"s net’', 'fake-pass\\\\word-1', 'WPA3_SAE'));
  assert.equal(good.status, 0, good.err);
  assert.deepEqual(JSON.parse(good.out), {
    ssid: 'Fake"s net’',
    passphrase: 'fake-pass\\word-1',
    security: 'WPA3_SAE',
  });
  const json = convert('wifi_defaults.json', JSON.stringify({ ssid: 'Fake', passphrase: 'fake-pass-2' }));
  assert.deepEqual(JSON.parse(json.out), { ssid: 'Fake', passphrase: 'fake-pass-2', security: 'WPA2_PSK' });
  const short = convert('wifi_secrets.h', header('Fake', 'tiny'));
  assert.equal(short.status, 1);
  assert.equal(short.out, '');
  assert.match(short.err, /passphrase must be 8 to 63 bytes/);
  assert.equal(short.err.includes('tiny'), false);
  const piped = convert('wifi_secrets.h', header('a|b', 'fake-pass-3'));
  assert.equal(piped.status, 1);
  assert.equal(convert('wifi_defaults.json', 'nope').status, 1);
  assert.equal(convert('wifi_secrets.h', header('Fake', 'fake-pass-4', 'WEP')).status, 1);
});
