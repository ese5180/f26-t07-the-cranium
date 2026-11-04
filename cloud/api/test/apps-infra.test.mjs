// What the template promises for the phone apps on the Apps page (docs/mobile-apps.md): the APKs in the
// firmware bucket under apps/android/, the API role's three S3 actions on them and nothing more, and the
// two values of the apps' configuration in the API's environment. Read as indented text, as in
// infra.test.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (name) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const template = read('infra/template.yaml');

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

const APKS = "Resource: !Sub '${FirmwareBucket.Arn}/apps/android/cranium-android-*.apk'";

test('the API role has one S3 action for each step of a publish and a download, on the APKs alone', () => {
  const role = block(template, 'ApiRole');
  for (const [sid, action] of [['SendAndroidApks', 's3:PutObject'], ['CheckAndroidApks', 's3:GetObject'],
    ['ServeAndroidApks', 's3:GetObjectVersion']]) {
    const part = statement(role, sid);
    assert.ok(part.includes('Effect: Allow'), sid);
    assert.ok(part.includes(`Action: ${action}\n`), sid);
    assert.ok(part.includes(APKS), sid);
    // One action, one resource, no wildcard of actions.
    assert.equal((part.match(/s3:/g) ?? []).length, 1, sid);
    assert.equal((part.match(/Resource:/g) ?? []).length, 1, sid);
  }
  // Nothing else in the role names apps/, and no statement reaches the whole bucket or lists or deletes in it.
  assert.equal((role.match(/\/apps\//g) ?? []).length, 3);
  assert.equal(role.includes("${FirmwareBucket.Arn}/*'"), false);
  assert.equal(/\n\s*Resource: !GetAtt FirmwareBucket\.Arn/.test(role), false);
  for (const action of ['s3:ListBucket', 's3:ListBucketVersions', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:*']) {
    assert.equal(role.includes(action), false, action);
  }
  // The firmware stays where it was: put and read under firmware/ only, by the statements of before.
  assert.ok(statement(role, 'StoreFirmware').includes("Resource: !Sub '${FirmwareBucket.Arn}/firmware/*'"));
  assert.ok(statement(role, 'ReadFirmware').includes("Resource: !Sub '${FirmwareBucket.Arn}/firmware/*'"));
});

test('the bucket keeps every version of an object, which a download names; boards take firmware/ only', () => {
  const bucket = block(template, 'FirmwareBucket');
  assert.ok(block(bucket, 'VersioningConfiguration', 6).includes('Status: Enabled'));
  assert.ok(bucket.includes('DeletionPolicy: RetainExceptOnCreate'));
  assert.ok(bucket.includes('BlockPublicPolicy: true'));
  // No rule that would expire an old version of an APK that a release still names.
  assert.equal(bucket.includes('LifecycleConfiguration'), false);
  // TLS only, for the APKs as for the firmware.
  assert.ok(statement(block(template, 'FirmwareBucketPolicy'), 'DenyRequestsWithoutTls').includes("- !Sub '${FirmwareBucket.Arn}/*'"));
  // What a board downloads from, and what AWS IoT presigns for it, stay under firmware/.
  assert.ok(block(template, 'FirmwareDownloadPrefix').includes('amazonaws.com/firmware/'));
  assert.ok(block(template, 'PresignRole').includes("Resource: !Sub '${FirmwareBucket.Arn}/firmware/*'"));
  assert.equal(block(template, 'PresignRole').includes('/apps/'), false);
});

test('the API is told the console\'s address and its login pages, as the other functions and the outputs say', () => {
  const variables = block(block(template, 'ApiFn'), 'Variables', 8);
  const consoleUrl = "CONSOLE_URL: !If [HasConsoleDomain, !Sub 'https://${ConsoleDomainName}/', !Sub '${Api.ApiEndpoint}/']";
  assert.ok(variables.includes(consoleUrl));
  assert.ok(variables.includes("LOGIN_DOMAIN: !Sub '${UserPoolDomain}.auth.${AWS::Region}.amazoncognito.com'"));
  assert.ok(block(template, 'ConsoleUrl').includes(consoleUrl.slice('CONSOLE_URL: '.length)));
  assert.ok(block(template, 'LoginDomain').includes("!Sub '${UserPoolDomain}.auth.${AWS::Region}.amazoncognito.com'"));
  // The web function's page config gives the website's own client the same login pages.
  assert.ok(block(block(template, 'WebFn'), 'Variables', 8).includes("LOGIN_DOMAIN: !Sub '${UserPoolDomain}.auth.${AWS::Region}.amazoncognito.com'"));
});

test('an APK never passes through API Gateway: its routes are the ones the API already has', () => {
  const app = read('api/src/app.mjs');
  for (const route of ["route('POST', '/api/apps/android/uploads'", "route('POST', '/api/apps/android/releases/{version}'",
    "route('GET', '/api/apps/android/{version}/download'", "route('GET', '/api/apps'", "route('GET', '/api/apps/config'"]) {
    assert.ok(app.includes(route), route);
  }
  // No new gateway route: GET and POST under /api/ and /api/t/ reach them.
  assert.equal(/RouteKey: '?[^'\n]*\/api\/apps/.test(template), false);
});
