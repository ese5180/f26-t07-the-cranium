// Tests for what the CloudFormation templates promise. There is no YAML parser in this
// project and no package may be added, so these read the templates as indented text: a
// resource is its line and everything indented below it. They catch a promise being
// dropped by an edit. Whether AWS accepts the templates is for validate-template and a
// deployment to say.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (name) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const template = read('infra/template.yaml');
const trail = read('infra/trail.yaml');
const teardown = read('teardown.sh');

/** The line that says `key:` at this indentation, with everything indented below it. */
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

/** The statements of a policy document, each as text, found by Sid. */
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

test('reads and writes have a request limit each, and neither is weaker than the old route', () => {
  assert.equal(template.includes('ANY /api/'), false);
  for (const [resource, key] of [['ApiReadRoute', 'GET /api/{proxy+}'], ['ApiWriteRoute', 'POST /api/{proxy+}']]) {
    const route = block(template, resource);
    assert.ok(route.includes(`RouteKey: '${key}'`), resource);
    assert.ok(route.includes('AuthorizationType: JWT'), resource);
    assert.ok(route.includes('AuthorizerId: !Ref Authorizer'), resource);
    assert.ok(route.includes('- cranium/console'), resource);
    assert.ok(route.includes('integrations/${ApiIntegration}'), resource);
  }
  // Only the page itself, its files, what no route claims and the routes whose function
  // checks an API token itself are open, whatever a route is called.
  const open = template.split(/\n(?= {2}\w+:\n)/)
    .filter((resource) => resource.includes('Type: AWS::ApiGatewayV2::Route') && resource.includes('AuthorizationType: NONE'))
    .map((resource) => /RouteKey: '?([^'\n]+)'?/.exec(resource)[1]);
  assert.deepEqual(open.sort(), ['$default', 'GET /', 'GET /api/t/{proxy+}', 'GET /assets/{proxy+}', 'POST /api/t/{proxy+}']);

  const stage = block(template, 'Stage');
  for (const name of ['ApiReadRoute', 'ApiWriteRoute']) assert.ok(block(stage, 'DependsOn', 4).includes(`- ${name}`));
  const settings = block(stage, 'RouteSettings', 6);
  const limits = (key) => {
    const part = settings.split(`'${key}':`)[1].split('\n').slice(1, 3).join('\n');
    // A missing number counts as zero and would throttle every request.
    return [Number(/ThrottlingBurstLimit: (\d+)/.exec(part)[1]), Number(/ThrottlingRateLimit: (\d+)/.exec(part)[1])];
  };
  assert.deepEqual(limits('GET /api/{proxy+}'), [20, 10]);
  assert.deepEqual(limits('POST /api/{proxy+}'), [10, 5]);
});

test('API tokens have two routes of their own, to the API function, with limits below the session routes', () => {
  for (const [resource, key] of [['ApiTokenReadRoute', 'GET /api/t/{proxy+}'], ['ApiTokenWriteRoute', 'POST /api/t/{proxy+}']]) {
    const route = block(template, resource);
    assert.ok(route.includes(`RouteKey: '${key}'`), resource);
    // The function checks the token: the gateway's authorizer only knows Cognito's.
    assert.ok(route.includes('AuthorizationType: NONE'), resource);
    assert.equal(route.includes('AuthorizerId'), false, resource);
    // To the API function, never to the web function.
    assert.ok(route.includes("Target: !Sub 'integrations/${ApiIntegration}'"), resource);
    assert.ok(block(block(template, 'Stage'), 'DependsOn', 4).includes(`- ${resource}`), resource);
  }
  const settings = block(block(template, 'Stage'), 'RouteSettings', 6);
  const limits = (key) => {
    const part = settings.split(`'${key}':`)[1].split('\n').slice(1, 3).join('\n');
    return [Number(/ThrottlingBurstLimit: (\d+)/.exec(part)[1]), Number(/ThrottlingRateLimit: (\d+)/.exec(part)[1])];
  };
  assert.deepEqual(limits('GET /api/t/{proxy+}'), [10, 5]);
  assert.deepEqual(limits('POST /api/t/{proxy+}'), [5, 2]);
  // The function knows the prefix the routes name.
  const app = read('api/src/app.mjs');
  assert.ok(app.includes("const TOKEN_SEGMENT = 't';"));
});

test('the API role reads, adds and updates in the state table, and never deletes from it', () => {
  const role = block(template, 'ApiRole');
  const state = statement(role, 'ReadAndWriteReleasesAndTokens');
  // GetItem looks a token up, Query lists a person's tokens, UpdateItem revokes one.
  assert.deepEqual([...state.matchAll(/- (dynamodb:\w+)/g)].map((match) => match[1]),
    ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem']);
  assert.ok(state.includes('Resource: !GetAtt StateTable.Arn'));
  // Nothing else in the role names that table, and the only DynamoDB actions the role is
  // allowed are these and the audit table's two: no delete, no scan, no wildcard.
  assert.equal((role.match(/StateTable\.Arn/g) ?? []).length, 1);
  const denied = statement(role, 'NeverChangeAuditEntries');
  const allowed = role.replace(denied, '').match(/^\s*(?:Action: |- )dynamodb:\S+$/gm).map((line) => line.trim());
  assert.deepEqual(allowed, ['- dynamodb:GetItem', '- dynamodb:Query', '- dynamodb:PutItem', '- dynamodb:UpdateItem',
    '- dynamodb:PutItem', '- dynamodb:Query', 'Action: dynamodb:Query']);
});

test('a user cannot change their own e-mail address', () => {
  const client = block(template, 'UserPoolClient');
  const allowed = [...block(client, 'WriteAttributes', 6).matchAll(/- (\S+)/g)].map((match) => match[1]);
  assert.deepEqual(allowed, ['name']);
  // Left as it is on purpose: managed login may need it, which only a test can show.
  assert.ok(client.includes('ALLOW_USER_SRP_AUTH'));
});

test('the tables are protected from deletion once the stack exists, not while it is created', () => {
  assert.ok(template.includes('ProtectFromDeletion: !Equals [!Ref UserPoolDeletionProtection, ACTIVE]'));
  assert.ok(block(block(template, 'Parameters', 0), 'UserPoolDeletionProtection').includes('Default: INACTIVE'));
  for (const table of ['StateTable', 'AuditTable', 'EventsTable']) {
    assert.ok(block(template, table).includes('DeletionProtectionEnabled: !If [ProtectFromDeletion, true, false]'), table);
    assert.ok(block(template, table).includes('DeletionPolicy: RetainExceptOnCreate'), table);
  }
});

test('the API role can set the revoked tag and cannot clear it', () => {
  const role = block(template, 'ApiRole');
  const store = statement(role, 'StoreFirmware');
  assert.ok(store.includes('Action: s3:PutObject'));
  assert.equal(store.includes('PutObjectTagging'), false);

  const mark = statement(role, 'MarkFirmwareRevoked');
  assert.ok(mark.includes('Action: s3:PutObjectTagging'));
  assert.ok(mark.includes("s3:RequestObjectTag/revoked: 'true'"));
  assert.ok(block(mark, 'ForAllValues:StringEquals', 18).includes('- revoked'));

  assert.equal((role.match(/s3:PutObjectTagging/g) ?? []).length, 1);
  for (const action of ['s3:DeleteObjectTagging', 's3:PutObjectVersionTagging', 's3:DeleteObject']) {
    assert.equal(role.includes(`${action}\n`), false, action);
  }
});

test('the API role reads images for the phone apps, and the bucket still refuses a revoked one', () => {
  const role = block(template, 'ApiRole');
  const read = statement(role, 'ReadFirmware');
  assert.ok(read.includes('Action: s3:GetObject\n'));
  assert.ok(read.includes("Resource: !Sub '${FirmwareBucket.Arn}/firmware/*'"));
  assert.equal((role.match(/s3:GetObject/g) ?? []).length, 1);
  assert.ok(block(template, 'FirmwareBucketPolicy').includes('Sid: DenyDownloadingRevokedFirmware'));
});

test('the phone apps have their own client, which only signs in back into the app', () => {
  const client = block(template, 'MobileUserPoolClient');
  assert.ok(client.includes('GenerateSecret: false'));
  assert.ok(client.includes('- code\n'));
  assert.ok(client.includes('- cranium/console'));
  assert.ok(client.includes('CallbackURLs:\n        - cranium://signin'));
  assert.equal(client.includes('implicit'), false);
  assert.ok(block(template, 'MobileManagedLoginBranding').includes('ClientId: !Ref MobileUserPoolClient'));
  assert.ok(template.includes('Audience:\n          - !Ref UserPoolClient\n          - !Ref MobileUserPoolClient'));
  assert.ok(template.includes('MOBILE_CLIENT_ID: !Ref MobileUserPoolClient'));
});

test('the API role may only add to and read the audit table', () => {
  const role = block(template, 'ApiRole');
  const allowed = statement(role, 'AppendAndReadAudit');
  assert.deepEqual([...allowed.matchAll(/- (dynamodb:\w+)/g)].map((match) => match[1]), ['dynamodb:PutItem', 'dynamodb:Query']);
  assert.ok(allowed.includes('Resource: !GetAtt AuditTable.Arn'));

  const denied = statement(role, 'NeverChangeAuditEntries');
  assert.ok(denied.includes('Effect: Deny'));
  assert.ok(denied.includes('Resource: !GetAtt AuditTable.Arn'));
  for (const action of ['BatchWriteItem', 'DeleteItem', 'UpdateItem', 'DeleteTable', 'PartiQLUpdate', 'PartiQLDelete']) {
    assert.ok(denied.includes(`dynamodb:${action}`), action);
  }
  // Nothing else in the role names that table.
  assert.equal((role.match(/!GetAtt AuditTable\.Arn/g) ?? []).length, 2);
});

test('the IoT logging role keeps its published trust policy unless asked', () => {
  const parameter = block(block(template, 'Parameters', 0), 'RestrictIotLoggingTrust');
  assert.ok(parameter.includes("Default: 'false'"));
  const trust = block(block(template, 'IotLoggingRole'), 'AssumeRolePolicyDocument', 6);
  assert.ok(trust.includes('Condition: !If'));
  assert.ok(trust.includes('- RestrictedIotLoggingTrust'));
  assert.ok(trust.includes('aws:SourceAccount: !Ref AWS::AccountId'));
  assert.ok(trust.includes('- !Ref AWS::NoValue'));
});

test('a deployment says which commit it came from, where it can be looked up', () => {
  const parameters = block(template, 'Parameters', 0);
  assert.ok(block(parameters, 'DeployedCommit').includes("'^(unknown|[0-9a-f]{40})$'"));
  assert.ok(block(parameters, 'DeployedTree').includes('[clean, dirty, unknown]'));
  const outputs = block(template, 'Outputs', 0);
  assert.ok(block(outputs, 'DeployedCommit').includes('Value: !Ref DeployedCommit'));
  assert.ok(block(outputs, 'DeployedTree').includes('Value: !Ref DeployedTree'));
  // A resource has to change, or CloudFormation may not apply the new outputs.
  for (const fn of ['WebFn', 'ApiFn']) {
    assert.ok(block(template, fn).includes('${DeployedCommit} (${DeployedTree})'), fn);
  }
});

test('the address API Gateway assigned stays a place to sign in, by decision', () => {
  assert.equal(template.includes('DisableExecuteApiEndpoint'), false);
  const client = block(template, 'UserPoolClient');
  assert.ok(block(client, 'CallbackURLs', 6).includes("!Sub '${Api.ApiEndpoint}/'"));
  assert.ok(block(client, 'LogoutURLs', 6).includes("!Sub '${Api.ApiEndpoint}/'"));
});

test('the trail records management events in every Region, and nothing that costs extra', () => {
  const resource = block(trail, 'Trail');
  for (const line of ['IsLogging: true', 'IsMultiRegionTrail: true', 'IncludeGlobalServiceEvents: true',
    'EnableLogFileValidation: true', 'IncludeManagementEvents: true', 'S3BucketName: !Ref TrailBucket',
    'DependsOn: TrailBucketPolicy']) {
    assert.ok(resource.includes(line), line);
  }
  // Data events, Insights, a KMS key and CloudWatch delivery are all billed.
  for (const paid of ['DataResources', 'AdvancedEventSelectors', 'InsightSelectors', 'KMSKeyId', 'CloudWatchLogsLogGroupArn']) {
    assert.equal(trail.includes(`${paid}:`), false, paid);
  }
});

test('the trail bucket is private, answers only over TLS and does not grow for ever', () => {
  const bucket = block(trail, 'TrailBucket');
  for (const line of ['BlockPublicAcls: true', 'BlockPublicPolicy: true', 'IgnorePublicAcls: true',
    'RestrictPublicBuckets: true', 'ObjectOwnership: BucketOwnerEnforced', 'Status: Enabled',
    'ExpirationInDays: !Ref RetentionDays', 'NoncurrentDays: 30']) {
    assert.ok(bucket.includes(line), line);
  }
  // No name: it could be taken first in another account. No lock that outlives the course.
  assert.doesNotMatch(bucket, /^\s+BucketName:/m);
  assert.equal(bucket.includes('ObjectLock'), false);

  const policy = block(trail, 'TrailBucketPolicy');
  const tls = statement(policy, 'DenyRequestsWithoutTls');
  assert.ok(tls.includes('Effect: Deny'));
  assert.ok(tls.includes("aws:SecureTransport: 'false'"));
  // CloudTrail may write for this trail only, and only below its own folder.
  for (const sid of ['AWSCloudTrailAclCheck', 'AWSCloudTrailWrite']) {
    assert.ok(statement(policy, sid).includes(':trail/cranium-trail'), sid);
    assert.ok(statement(policy, sid).includes('Service: cloudtrail.amazonaws.com'), sid);
  }
  assert.ok(statement(policy, 'AWSCloudTrailWrite').includes('/AWSLogs/${AWS::AccountId}/*'));
  assert.ok(block(trail, 'Trail').includes('TrailName: cranium-trail'));
});

test('teardown leaves the trail and its log files alone', () => {
  for (const word of ['cranium-trail', 'delete-trail', 'stop-logging']) {
    assert.equal(teardown.includes(word), false, word);
  }
});

test('the events table is on demand, recoverable, protected, and lets DynamoDB expire items by their ttl', () => {
  const table = block(template, 'EventsTable');
  for (const line of ['Type: AWS::DynamoDB::Table', 'BillingMode: PAY_PER_REQUEST', 'DeletionPolicy: RetainExceptOnCreate',
    'PointInTimeRecoveryEnabled: true', 'DeletionProtectionEnabled: !If [ProtectFromDeletion, true, false]']) {
    assert.ok(table.includes(line), line);
  }
  assert.ok(block(table, 'TimeToLiveSpecification', 6).includes('AttributeName: ttl\n        Enabled: true'));
  assert.match(table, /AttributeName: pk\n {10}KeyType: HASH\n {8}- AttributeName: sk\n {10}KeyType: RANGE/);
  // teardown.sh removes it like the other two, after the stack, with its protection off.
  assert.ok(teardown.includes('delete_table "events table" "$EVENTS_TABLE"'));
  assert.ok(teardown.includes('EVENTS_TABLE="$(resolve "$STACK" EventsTableName)"'));
  assert.ok(block(block(template, 'Outputs', 0), 'EventsTableName').includes('Value: !Ref EventsTable'));
});

test('the recorder is a function of its own: own log, own role, and nothing but PutItem on the events table', () => {
  const fn = block(template, 'EventsFn');
  for (const line of ['Type: AWS::Lambda::Function', 'DependsOn: EventsLogGroup', 'LogGroup: !Ref EventsLogGroup',
    'Runtime: nodejs22.x', '- arm64', 'Handler: events.handler', 'Role: !GetAtt EventsRole.Arn', 'Code: ../api/src',
    'EVENTS_TABLE: !Ref EventsTable', '${DeployedCommit} (${DeployedTree})']) {
    assert.ok(fn.includes(line), line);
  }
  // It is told the events table and nothing else.
  assert.deepEqual([...block(fn, 'Variables', 8).matchAll(/^ {10}(\w+):/gm)].map((match) => match[1]), ['EVENTS_TABLE']);
  assert.ok(block(template, 'EventsLogGroup').includes('RetentionInDays: 90'));

  const role = block(template, 'EventsRole');
  assert.ok(role.includes('Service: lambda.amazonaws.com'));
  assert.deepEqual([...role.matchAll(/- Sid: (\w+)/g)].map((match) => match[1]), ['WriteOwnLog', 'RecordEvents']);
  const record = statement(role, 'RecordEvents');
  assert.ok(record.includes('Action: dynamodb:PutItem\n'));
  assert.ok(record.includes('Resource: !GetAtt EventsTable.Arn'));
  assert.deepEqual(role.match(/dynamodb:\w+/g), ['dynamodb:PutItem']);
  assert.ok(statement(role, 'WriteOwnLog').includes('Resource: !GetAtt EventsLogGroup.Arn'));
  assert.equal(/Resource: '\*'/.test(role), false);

  const retries = block(template, 'EventsFnInvokeConfig');
  assert.ok(retries.includes('FunctionName: !Ref EventsFn'));
  assert.ok(retries.includes('MaximumRetryAttempts: 1'));
  assert.ok(block(block(template, 'Outputs', 0), 'EventsFunctionName').includes('Value: !Ref EventsFn'));
});

test('two IoT rules feed the recorder: shadow documents and presence, only for things named like the boards', () => {
  const sql = (name) => block(template, name).split('Sql: >-\n')[1].split('\n').slice(0, 2).map((line) => line.trim()).join(' ');
  assert.equal(sql('ShadowEventsRule'),
    "SELECT *, topic(3) AS thing FROM '$aws/things/+/shadow/update/documents' WHERE startswith(topic(3), 'cranium-')");
  assert.equal(sql('PresenceEventsRule'), "SELECT * FROM '$aws/events/presence/+/+' WHERE startswith(topic(5), 'cranium-')");
  for (const name of ['ShadowEventsRule', 'PresenceEventsRule']) {
    const rule = block(template, name);
    assert.ok(rule.includes('Type: AWS::IoT::TopicRule'), name);
    assert.ok(rule.includes("AwsIotSqlVersion: '2016-03-23'"), name);
    assert.ok(rule.includes('RuleDisabled: false'), name);
    assert.ok(rule.includes('FunctionArn: !GetAtt EventsFn.Arn'), name);
    assert.equal(/RoleArn|Republish|S3:|DynamoDBv2/.test(rule), false, name);
  }
  // AWS IoT may invoke the recorder for exactly these two rules of this account.
  const permissions = template.split(/\n(?= {2}\w+:\n)/)
    .filter((resource) => resource.includes('Type: AWS::Lambda::Permission') && resource.includes('FunctionName: !Ref EventsFn'));
  assert.equal(permissions.length, 2);
  for (const [name, rule] of [['ShadowEventsPermission', 'ShadowEventsRule'], ['PresenceEventsPermission', 'PresenceEventsRule']]) {
    const permission = block(template, name);
    assert.ok(permission.includes('Principal: iot.amazonaws.com'), name);
    assert.ok(permission.includes('Action: lambda:InvokeFunction'), name);
    assert.ok(permission.includes('SourceAccount: !Ref AWS::AccountId'), name);
    assert.ok(permission.includes(`SourceArn: !GetAtt ${rule}.Arn`), name);
  }
  // The boards' own policy is unchanged: they publish nowhere new.
  assert.equal(block(template, 'DevicePolicy').includes('events'), false);
});

test('the API reads the events table and nothing more: Query, on that table alone', () => {
  const role = block(template, 'ApiRole');
  const read = statement(role, 'ReadEvents');
  assert.ok(read.includes('Action: dynamodb:Query\n'));
  assert.ok(read.includes('Resource: !GetAtt EventsTable.Arn'));
  assert.equal((role.match(/EventsTable\.Arn/g) ?? []).length, 1);
  assert.ok(block(template, 'ApiFn').includes('EVENTS_TABLE: !Ref EventsTable'));
  assert.equal(block(template, 'WebRole').includes('EventsTable'), false);
});
