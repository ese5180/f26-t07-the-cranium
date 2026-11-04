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
  assert.deepEqual(open.sort(), ['$default', 'GET /', 'GET /api/t/{proxy+}', 'GET /assets/{proxy+}', 'POST /api/t/{proxy+}',
    'PUT /api/t/{proxy+}']);

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
});

test('the console\'s client and the phone apps\' client sign in with SRP, never by sending the password', () => {
  const flows = (name) => [...block(block(template, name), 'ExplicitAuthFlows', 6).matchAll(/- (\S+)/g)].map((match) => match[1]);
  assert.deepEqual(flows('UserPoolClient'), ['ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_SRP_AUTH']);
  // The phone apps sign in on their own screen with SRP, and through the managed login pages
  // with PKCE for the steps that screen does not do.
  assert.deepEqual(flows('MobileUserPoolClient'), ['ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_SRP_AUTH']);
  assert.equal(template.includes('USER_PASSWORD_AUTH\n'), false);
  assert.equal(/^\s+- ALLOW_USER_PASSWORD_AUTH/m.test(template), false);
  const client = block(template, 'UserPoolClient');
  assert.ok(client.includes('PreventUserExistenceErrors: ENABLED'));
  assert.ok(client.includes('EnableTokenRevocation: true'));
});

test('the sign-in trigger: version 2, on the pool, named the way the function is named', () => {
  const pool = block(template, 'UserPool');
  // Access tokens can be changed from version 2 on, which needs the Essentials plan.
  assert.ok(pool.includes('UserPoolTier: ESSENTIALS'));
  const config = block(block(pool, 'LambdaConfig', 6), 'PreTokenGenerationConfig', 8);
  assert.ok(config.includes('LambdaVersion: V2_0'));
  const arn = /LambdaArn: !Sub '([^']+)'/.exec(config)[1];
  assert.equal(arn, 'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:${AWS::StackName}-signin-scope');
  // Only this trigger: no other step of the pool calls a function.
  assert.deepEqual([...block(pool, 'LambdaConfig', 6).matchAll(/^ {8}(\w+):/gm)].map((match) => match[1]),
    ['PreTokenGenerationConfig']);
  // By name, not with !GetAtt: the function is told the client, which belongs to the pool.
  assert.equal(/!(?:GetAtt|Ref) SignInScopeFn/.test(pool), false);

  const fn = block(template, 'SignInScopeFn');
  for (const line of ['Type: AWS::Lambda::Function', 'DependsOn: SignInScopeLogGroup', "FunctionName: !Sub '${AWS::StackName}-signin-scope'",
    'LogGroup: !Ref SignInScopeLogGroup', 'Runtime: nodejs22.x', '- arm64', 'Handler: signin-scope.handler',
    'Role: !GetAtt SignInScopeRole.Arn', 'Code: ../api/src', 'Timeout: 5', '${DeployedCommit} (${DeployedTree})']) {
    assert.ok(fn.includes(line), line);
  }
  // It is told the two clients whose tokens it changes, and nothing else.
  assert.deepEqual([...block(fn, 'Variables', 8).matchAll(/^ {10}(\w+): (.+)$/gm)].map((match) => [match[1], match[2]]),
    [['CONSOLE_CLIENT_ID', '!Ref UserPoolClient'], ['MOBILE_CLIENT_ID', '!Ref MobileUserPoolClient']]);
  const group = block(template, 'SignInScopeLogGroup');
  assert.ok(group.includes("LogGroupName: !Sub '/aws/lambda/${AWS::StackName}-signin-scope'"));
  assert.ok(group.includes('RetentionInDays: 90'));
  // The handler the template names is there.
  assert.ok(read('api/src/signin-scope.mjs').includes('export const handler'));
});

test('the sign-in trigger may write its log and nothing else, and only Cognito, for this pool, may call it', () => {
  const role = block(template, 'SignInScopeRole');
  assert.ok(role.includes('Service: lambda.amazonaws.com'));
  assert.deepEqual([...role.matchAll(/- Sid: (\w+)/g)].map((match) => match[1]), ['WriteOwnLog']);
  const own = statement(role, 'WriteOwnLog');
  assert.ok(own.includes('Resource: !GetAtt SignInScopeLogGroup.Arn'));
  assert.deepEqual([...role.matchAll(/^\s*- ([a-z0-9-]+:\w+)$/gm)].map((match) => match[1]),
    ['logs:CreateLogStream', 'logs:PutLogEvents']);
  assert.equal(/Action: \S+:\*|Resource: '\*'|ManagedPolicyArns/.test(role), false);

  const permissions = template.split(/\n(?= {2}\w+:\n)/)
    .filter((resource) => resource.includes('Type: AWS::Lambda::Permission') && resource.includes('SignInScopeFn'));
  assert.equal(permissions.length, 1);
  const permission = block(template, 'SignInScopePermission');
  for (const line of ['Action: lambda:InvokeFunction', 'FunctionName: !Ref SignInScopeFn', 'Principal: cognito-idp.amazonaws.com',
    'SourceAccount: !Ref AWS::AccountId', 'SourceArn: !GetAtt UserPool.Arn']) {
    assert.ok(permission.includes(line), line);
  }
});

test('the web function is told the user pool, for the console\'s own sign-in page', () => {
  const variables = block(block(template, 'WebFn'), 'Variables', 8);
  assert.ok(variables.includes('USER_POOL_ID: !Ref UserPool'));
  // It still may call no AWS API: its role writes its log, and that is all.
  assert.deepEqual([...block(template, 'WebRole').matchAll(/^\s*- ([a-z0-9-]+:\w+)$/gm)].map((match) => match[1]),
    ['logs:CreateLogStream', 'logs:PutLogEvents']);
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
  // The other two are the Android app's, on its APKs alone (apps-infra.test.mjs).
  const apks = ['CheckAndroidApks', 'ServeAndroidApks'].map((sid) => statement(role, sid));
  assert.equal((apks.reduce((rest, part) => rest.replace(part, ''), role).match(/s3:GetObject/g) ?? []).length, 1);
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

test('a phone keeps its session up to 30 days, for the biometric unlock; the website for an hour', () => {
  const lifetimes = (name) => {
    const client = block(template, name);
    const units = block(client, 'TokenValidityUnits', 6);
    return {
      access: [/AccessTokenValidity: (\d+)/.exec(client)[1], /AccessToken: (\w+)/.exec(units)[1]],
      refresh: [/RefreshTokenValidity: (\d+)/.exec(client)[1], /RefreshToken: (\w+)/.exec(units)[1]],
    };
  };
  // Access tokens stay an hour everywhere: what API Gateway accepts offline after a sign-out.
  assert.deepEqual(lifetimes('MobileUserPoolClient'), { access: ['60', 'minutes'], refresh: ['30', 'days'] });
  assert.deepEqual(lifetimes('UserPoolClient'), { access: ['60', 'minutes'], refresh: ['60', 'minutes'] });
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

test('the recorder is a function of its own: own log, own role, PutItem on the events table and the alerts alone', () => {
  const fn = block(template, 'EventsFn');
  for (const line of ['Type: AWS::Lambda::Function', 'DependsOn: EventsLogGroup', 'LogGroup: !Ref EventsLogGroup',
    'Runtime: nodejs22.x', '- arm64', 'Handler: events.handler', 'Role: !GetAtt EventsRole.Arn', 'Code: ../api/src',
    'EVENTS_TABLE: !Ref EventsTable', '${DeployedCommit} (${DeployedTree})']) {
    assert.ok(fn.includes(line), line);
  }
  // It is told the events table, and for the alerts their topic and the console's address, and nothing else.
  assert.deepEqual([...block(fn, 'Variables', 8).matchAll(/^ {10}(\w+):/gm)].map((match) => match[1]),
    ['EVENTS_TABLE', 'ALERT_TOPIC_ARN', 'CONSOLE_URL']);
  assert.ok(block(template, 'EventsLogGroup').includes('RetentionInDays: 90'));

  const role = block(template, 'EventsRole');
  assert.ok(role.includes('Service: lambda.amazonaws.com'));
  assert.deepEqual([...role.matchAll(/- Sid: (\w+)/g)].map((match) => match[1]),
    ['WriteOwnLog', 'RecordEvents', 'ReadAlerts', 'SendAlerts']);
  const record = statement(role, 'RecordEvents');
  assert.ok(record.includes('Action: dynamodb:PutItem\n'));
  assert.ok(record.includes('Resource: !GetAtt EventsTable.Arn'));
  // It reads the alerts' own partition, and nothing else of the table (map-infra.test.mjs).
  assert.deepEqual(role.match(/dynamodb:\w+/g), ['dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:LeadingKeys']);
  assert.ok(statement(role, 'WriteOwnLog').includes('Resource: !GetAtt EventsLogGroup.Arn'));
  assert.equal(/Resource: '\*'/.test(role), false);

  const retries = block(template, 'EventsFnInvokeConfig');
  assert.ok(retries.includes('FunctionName: !Ref EventsFn'));
  assert.ok(retries.includes('MaximumRetryAttempts: 1'));
  assert.ok(block(block(template, 'Outputs', 0), 'EventsFunctionName').includes('Value: !Ref EventsFn'));
});

test('three IoT rules feed the recorder: shadow documents, presence and board logs, only for things named like the boards', () => {
  const sql = (name) => block(template, name).split('Sql: >-\n')[1].split('\n').slice(0, 2).map((line) => line.trim()).join(' ');
  assert.equal(sql('ShadowEventsRule'),
    "SELECT *, topic(3) AS thing FROM '$aws/things/+/shadow/update/documents' WHERE startswith(topic(3), 'cranium-')");
  assert.equal(sql('PresenceEventsRule'), "SELECT * FROM '$aws/events/presence/+/+' WHERE startswith(topic(5), 'cranium-')");
  // The board's name from the topic and the time from AWS IoT, and no message that brings either of its own.
  assert.equal(sql('BoardLogRule'),
    "SELECT *, topic(2) AS thing, timestamp() AS received FROM 'cranium/+/events' " +
    "WHERE startswith(topic(2), 'cranium-') AND isUndefined(thing) AND isUndefined(received)");
  for (const name of ['ShadowEventsRule', 'PresenceEventsRule', 'BoardLogRule']) {
    const rule = block(template, name);
    assert.ok(rule.includes('Type: AWS::IoT::TopicRule'), name);
    assert.ok(rule.includes("AwsIotSqlVersion: '2016-03-23'"), name);
    assert.ok(rule.includes('RuleDisabled: false'), name);
    assert.ok(rule.includes('FunctionArn: !GetAtt EventsFn.Arn'), name);
    assert.equal(/RoleArn|Republish|S3:|DynamoDBv2/.test(rule), false, name);
  }
  // AWS IoT may invoke the recorder for exactly these three rules of this account (and EventBridge for
  // the check of the alerts: map-infra.test.mjs).
  const permissions = template.split(/\n(?= {2}\w+:\n)/)
    .filter((resource) => resource.includes('Type: AWS::Lambda::Permission') && resource.includes('FunctionName: !Ref EventsFn') &&
      resource.includes('Principal: iot.amazonaws.com'));
  assert.equal(permissions.length, 3);
  for (const [name, rule] of [['ShadowEventsPermission', 'ShadowEventsRule'], ['PresenceEventsPermission', 'PresenceEventsRule'],
    ['BoardLogPermission', 'BoardLogRule']]) {
    const permission = block(template, name);
    assert.ok(permission.includes('Principal: iot.amazonaws.com'), name);
    assert.ok(permission.includes('Action: lambda:InvokeFunction'), name);
    assert.ok(permission.includes('SourceAccount: !Ref AWS::AccountId'), name);
    assert.ok(permission.includes(`SourceArn: !GetAtt ${rule}.Arn`), name);
  }
});

test('a board may publish its log on its own events topic, and do nothing else there', () => {
  const policy = block(template, 'DevicePolicy');
  // The fixed name stays: it is part of the provisioning contract, and a new name would replace the policy.
  assert.ok(policy.includes('PolicyName: cranium-device'));
  const topic = "!Sub 'arn:${AWS::Partition}:iot:${AWS::Region}:${AWS::AccountId}:topic/cranium/${!iot:Connection.Thing.ThingName}/events'";
  const statements = policy.split(/\n {10}- Effect: /).slice(1);
  const publish = statements.find((text) => text.includes('Action: iot:Publish'));
  assert.ok(publish.includes(`- ${topic}`));
  // Only under Publish: a board neither subscribes to it nor receives on it. Its other topics of this
  // kind, location and commands, are checked in map-infra.test.mjs.
  assert.equal(policy.split('cranium/').length - 1, 4);
  assert.equal(policy.split('/events').length - 1, 1);
  for (const text of statements.filter((item) => !item.includes('Action: iot:Publish'))) {
    assert.equal(text.includes('/events'), false);
  }
  // Every resource of the policy is the connection's own thing.
  for (const resource of policy.match(/^\s+- !Sub '[^']+'$/gm)) assert.match(resource, /\$\{!iot:Connection\.Thing\.ThingName\}/);
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

// The fleet (docs/fleet.md): a release's note, the boards' attributes, and the schedule that moves
// staged rollouts on.

test('a release\'s note is changed with PUT, through a session route and a token route like POST\'s', () => {
  for (const [resource, key, auth] of [['ApiPutRoute', 'PUT /api/{proxy+}', 'JWT'], ['ApiTokenPutRoute', 'PUT /api/t/{proxy+}', 'NONE']]) {
    const route = block(template, resource);
    assert.ok(route.includes(`RouteKey: '${key}'`), resource);
    assert.ok(route.includes(`AuthorizationType: ${auth}`), resource);
    assert.ok(route.includes("Target: !Sub 'integrations/${ApiIntegration}'"), resource);
    assert.ok(block(block(template, 'Stage'), 'DependsOn', 4).includes(`- ${resource}`), resource);
  }
  assert.ok(block(template, 'ApiPutRoute').includes('AuthorizerId: !Ref Authorizer'));
  assert.ok(block(template, 'ApiPutRoute').includes('- cranium/console'));
  const settings = block(block(template, 'Stage'), 'RouteSettings', 6);
  const limits = (key) => {
    const part = settings.split(`'${key}':`)[1].split('\n').slice(1, 3).join('\n');
    return [Number(/ThrottlingBurstLimit: (\d+)/.exec(part)[1]), Number(/ThrottlingRateLimit: (\d+)/.exec(part)[1])];
  };
  assert.deepEqual(limits('PUT /api/{proxy+}'), limits('POST /api/{proxy+}'));
  assert.deepEqual(limits('PUT /api/t/{proxy+}'), limits('POST /api/t/{proxy+}'));
  assert.ok(read('api/src/app.mjs').includes("route('PUT', '/api/firmware/{version}/notes'"));
});

test('the API reads a board\'s attributes for its type, on the boards of this project only', () => {
  const boards = statement(block(template, 'ApiRole'), 'ReadBoards');
  assert.ok(boards.includes('- iot:DescribeThing'));
  assert.ok(boards.includes(':thing/cranium-*'));
});

test('staged rollouts move on every minute, in a function of their own that can start jobs and little else', () => {
  const fn = block(template, 'RolloutTickFn');
  for (const line of ['Type: AWS::Lambda::Function', 'DependsOn: RolloutTickLogGroup', 'LogGroup: !Ref RolloutTickLogGroup',
    'Runtime: nodejs22.x', 'Handler: rollouts-tick.handler', 'Role: !GetAtt RolloutTickRole.Arn', 'Code: ../api/src',
    '${DeployedCommit} (${DeployedTree})']) {
    assert.ok(fn.includes(line), line);
  }
  assert.ok(block(template, 'RolloutTickLogGroup').includes('RetentionInDays: 90'));
  const rule = block(template, 'RolloutTickRule');
  assert.ok(rule.includes('ScheduleExpression: rate(1 minute)'));
  assert.ok(rule.includes('Arn: !GetAtt RolloutTickFn.Arn'));
  const permission = block(template, 'RolloutTickPermission');
  assert.ok(permission.includes('Principal: events.amazonaws.com'));
  assert.ok(permission.includes('SourceArn: !GetAtt RolloutTickRule.Arn'));
  // Only EventBridge, for this rule, may invoke it.
  const invokers = template.split(/\n(?= {2}\w+:\n)/)
    .filter((resource) => resource.includes('Type: AWS::Lambda::Permission') && resource.includes('FunctionName: !Ref RolloutTickFn'));
  assert.equal(invokers.length, 1);

  const role = block(template, 'RolloutTickRole');
  assert.deepEqual([...role.matchAll(/- Sid: (\w+)/g)].map((match) => match[1]), ['WriteOwnLog', 'ReadReleasesAndFleet',
    'WriteRollouts', 'AppendAudit', 'StartAndReadDeployments', 'CancelAndReadJobs', 'ReadOneExecution', 'ReadBoards', 'ListBoards',
    'ListDeployments', 'PassPresignRoleToIot', 'ReadAlerts', 'WriteAlerts', 'SendAlerts', 'NeverChangeAuditEntries']);
  // Writes in the state table only to a rollout; reads only of releases and the fleet's records.
  const writes = statement(role, 'WriteRollouts');
  assert.ok(writes.includes('Action: dynamodb:UpdateItem'));
  assert.deepEqual([...writes.split('dynamodb:LeadingKeys:')[1].matchAll(/- (\w+)/g)].map((match) => match[1]), ['ROL']);
  const reads = statement(role, 'ReadReleasesAndFleet');
  assert.deepEqual([...reads.split('dynamodb:LeadingKeys:')[1].matchAll(/- (\w+)/g)].map((match) => match[1]),
    ['REL', 'ROL', 'GRP', 'SEEN']);
  assert.ok(statement(role, 'AppendAudit').includes('Action: dynamodb:PutItem'));
  // The events table only for the alerts' own part, and the alert topic only to publish to: the alert
  // of a rollout that stopped by itself.
  for (const sid of ['ReadAlerts', 'WriteAlerts']) {
    const alerts = statement(role, sid);
    assert.ok(alerts.includes('Resource: !GetAtt EventsTable.Arn'), sid);
    assert.deepEqual([...alerts.split('dynamodb:LeadingKeys:')[1].matchAll(/- (\w+)/g)].map((match) => match[1]), ['ALERTS'], sid);
  }
  assert.ok(statement(role, 'ReadAlerts').includes('Action: dynamodb:Query'));
  assert.ok(statement(role, 'WriteAlerts').includes('Action: dynamodb:PutItem'));
  const send = statement(role, 'SendAlerts');
  assert.ok(send.includes('Action: sns:Publish') && send.includes('Resource: !Ref AlertTopic'));
  assert.equal((role.match(/sns:/g) ?? []).length, 1);
  assert.equal((role.match(/EventsTable/g) ?? []).length, 2);
  assert.equal(/s3:|cognito-idp:|iotwireless:/.test(role), false);
  assert.ok(fn.includes('ALERT_TOPIC_ARN: !Ref AlertTopic') && fn.includes('CONSOLE_URL: '));
  assert.equal(/Action: \S+:\*/.test(role), false);
  assert.ok(statement(role, 'PassPresignRoleToIot').includes('iam:PassedToService: iot.amazonaws.com'));
  assert.ok(block(block(template, 'Outputs', 0), 'RolloutsFunctionName').includes('Value: !Ref RolloutTickFn'));
});
