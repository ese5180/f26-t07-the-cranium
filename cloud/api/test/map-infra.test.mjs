// Tests for what infra/template.yaml promises of the map, the commands and the alerts (docs/fleet.md):
// the device policy's two topics, the location rule and function, the alert topic and its check, and
// that each role is allowed exactly what it needs. Read as indented text, as in infra.test.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (name) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const template = read('infra/template.yaml');
const ARN = 'arn:${AWS::Partition}:iot:${AWS::Region}:${AWS::AccountId}';
const OWN = '${!iot:Connection.Thing.ThingName}';

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

/** Every action a role's policies allow, as written: not the trust policy's. */
function allowed(role) {
  const policies = role.includes('Policies:') ? role.slice(role.indexOf('Policies:')) : role;
  return [...policies.matchAll(/^\s*(?:Action: |- )([a-z0-9-]+:[A-Za-z*]+)$/gm)].map((match) => match[1]);
}

const resources = template.split(/\n(?= {2}\w+:\n)/);

test('a board publishes its scans on its own location topic, and only receives on its own commands topic', () => {
  const policy = block(template, 'DevicePolicy');
  const statements = policy.split(/\n {10}- Effect: /).slice(1);
  const of = (action) => statements.find((text) => text.includes(`Action: ${action}\n`));
  assert.ok(of('iot:Publish').includes(`- !Sub '${ARN}:topic/cranium/${OWN}/location'`));
  // A topic filter to subscribe to, and the topic to receive on: the board's own, exactly.
  assert.ok(of('iot:Subscribe').includes(`- !Sub '${ARN}:topicfilter/cranium/${OWN}/commands'`));
  assert.ok(of('iot:Receive').includes(`- !Sub '${ARN}:topic/cranium/${OWN}/commands'`));
  // Never the other way round: a board cannot send itself a command or listen to scans.
  assert.equal(of('iot:Publish').includes('/commands'), false);
  for (const action of ['iot:Subscribe', 'iot:Receive']) assert.equal(of(action).includes('/location'), false, action);
  assert.equal(policy.includes('cranium/+') || policy.includes('cranium/#') || /cranium\/\*/.test(policy), false);
});

test('the location rule hands scans to the location function, and no message that names its own board or time', () => {
  const rule = block(template, 'LocationRule');
  const sql = rule
    .split('Sql: >-\n')[1]
    .split('\n')
    .slice(0, 2)
    .map((line) => line.trim())
    .join(' ');
  assert.equal(
    sql,
    "SELECT *, topic(2) AS thing, timestamp() AS received FROM 'cranium/+/location' " +
      "WHERE startswith(topic(2), 'cranium-') AND isUndefined(thing) AND isUndefined(received)"
  );
  for (const line of [
    'Type: AWS::IoT::TopicRule',
    "AwsIotSqlVersion: '2016-03-23'",
    'RuleDisabled: false',
    'FunctionArn: !GetAtt LocationFn.Arn',
  ])
    assert.ok(rule.includes(line), line);
  assert.equal(/RoleArn|Republish|S3:|DynamoDBv2/.test(rule), false);
  const permission = block(template, 'LocationPermission');
  for (const line of [
    'FunctionName: !Ref LocationFn',
    'Principal: iot.amazonaws.com',
    'SourceAccount: !Ref AWS::AccountId',
    'SourceArn: !GetAtt LocationRule.Arn',
  ])
    assert.ok(permission.includes(line), line);
  // Exactly one way into the location function.
  assert.equal(
    resources.filter(
      (text) => text.includes('Type: AWS::Lambda::Permission') && text.includes('FunctionName: !Ref LocationFn')
    ).length,
    1
  );
});

test('the location function has its own log and role, is not retried, and is told only what it uses', () => {
  const fn = block(template, 'LocationFn');
  for (const line of [
    'Handler: location.handler',
    'Role: !GetAtt LocationRole.Arn',
    'Code: ../api/src',
    'Runtime: nodejs22.x',
    'LogGroup: !Ref LocationLogGroup',
    'DependsOn: LocationLogGroup',
  ])
    assert.ok(fn.includes(line), line);
  assert.deepEqual(
    [...block(fn, 'Variables', 8).matchAll(/^ {10}(\w+):/gm)].map((match) => match[1]),
    ['EVENTS_TABLE', 'ALERT_TOPIC_ARN', 'CONSOLE_URL']
  );
  assert.ok(block(template, 'LocationLogGroup').includes('RetentionInDays: 90'));
  const retries = block(template, 'LocationFnInvokeConfig');
  assert.ok(retries.includes('FunctionName: !Ref LocationFn'));
  assert.ok(retries.includes('MaximumRetryAttempts: 0'));
  assert.ok(block(block(template, 'Outputs', 0), 'LocationFunctionName').includes('Value: !Ref LocationFn'));
});

test("the location role: its log, its two partitions, a board's events, position estimates and the alert topic", () => {
  const role = block(template, 'LocationRole');
  assert.deepEqual(
    [...role.matchAll(/- Sid: (\w+)/g)].map((match) => match[1]),
    ['WriteOwnLog', 'ReadPositionsAndAlerts', 'RecordPositions', 'EstimatePositions', 'SendAlerts']
  );
  assert.deepEqual(allowed(role), [
    'logs:CreateLogStream',
    'logs:PutLogEvents',
    'dynamodb:Query',
    'dynamodb:PutItem',
    'iotwireless:GetPositionEstimate',
    'sns:Publish',
  ]);
  const query = statement(role, 'ReadPositionsAndAlerts');
  assert.ok(query.includes('Resource: !GetAtt EventsTable.Arn'));
  assert.match(query, /ForAllValues:StringEquals:\n\s+dynamodb:LeadingKeys:\n\s+- LOC\n\s+- ALERTS\n?/);
  const put = statement(role, 'RecordPositions');
  assert.match(put, /ForAllValues:StringLike:\n\s+dynamodb:LeadingKeys:\n\s+- LOC\n\s+- ALERTS\n\s+- cranium-\*/);
  // GetPositionEstimate has no resource type in IAM: '*' is the only resource it can have, and the
  // one statement with it allows nothing else.
  const estimate = statement(role, 'EstimatePositions');
  assert.ok(estimate.includes("Resource: '*'"));
  assert.equal((role.match(/Resource: '\*'/g) ?? []).length, 1);
  assert.ok(statement(role, 'SendAlerts').includes('Resource: !Ref AlertTopic'));
  // No other role may estimate positions.
  for (const name of ['ApiRole', 'EventsRole', 'WebRole', 'SignInScopeRole', 'PresignRole']) {
    assert.equal(block(template, name).includes('iotwireless'), false, name);
  }
});

test("the API may publish to the boards' commands topics and on no other topic", () => {
  const role = block(template, 'ApiRole');
  const publish = statement(role, 'CommandBoards');
  assert.ok(publish.includes('Action: iot:Publish\n'));
  assert.ok(publish.includes(`Resource: !Sub '${ARN}:topic/cranium/cranium-*/commands'`));
  assert.equal((role.match(/iot:Publish/g) ?? []).length, 1);
  assert.equal(block(template, 'ApiFn').includes('ALERT_TOPIC_ARN: !Ref AlertTopic'), true);
});

test('the API may subscribe e-mail addresses to the alert topic, list and remove subscriptions, and never publish', () => {
  const role = block(template, 'ApiRole');
  const subscribe = statement(role, 'SubscribeToAlerts');
  assert.ok(subscribe.includes('Action: sns:Subscribe\n'));
  assert.ok(subscribe.includes('Resource: !Ref AlertTopic'));
  assert.match(subscribe, /StringEquals:\n\s+sns:Protocol: email/);
  const manage = statement(role, 'ListAndRemoveAlertSubscriptions');
  assert.deepEqual(allowed(manage), ['sns:ListSubscriptionsByTopic', 'sns:Unsubscribe']);
  assert.ok(manage.includes('Resource: !Ref AlertTopic'));
  assert.deepEqual(
    allowed(role).filter((action) => action.startsWith('sns:')),
    ['sns:Subscribe', 'sns:ListSubscriptionsByTopic', 'sns:Unsubscribe']
  );
});

test("the recorder reads only the alerts' partition, publishes to the alert topic, and is run every 5 minutes", () => {
  const role = block(template, 'EventsRole');
  const query = statement(role, 'ReadAlerts');
  assert.ok(query.includes('Action: dynamodb:Query\n'));
  assert.match(query, /ForAllValues:StringEquals:\n\s+dynamodb:LeadingKeys:\n\s+- ALERTS\n?/);
  assert.equal(query.includes('LOC'), false);
  assert.deepEqual(allowed(statement(role, 'SendAlerts')), ['sns:Publish']);
  assert.ok(statement(role, 'SendAlerts').includes('Resource: !Ref AlertTopic'));
  assert.deepEqual(allowed(role), [
    'logs:CreateLogStream',
    'logs:PutLogEvents',
    'dynamodb:PutItem',
    'dynamodb:Query',
    'sns:Publish',
    'dynamodb:Query',
  ]);

  const check = block(template, 'AlertCheckRule');
  for (const line of [
    'Type: AWS::Events::Rule',
    'ScheduleExpression: rate(5 minutes)',
    'State: ENABLED',
    'Arn: !GetAtt EventsFn.Arn',
  ])
    assert.ok(check.includes(line), line);
  assert.equal(check.includes('Input'), false, 'the recorder tells the check by the shape EventBridge gives it');
  const permission = block(template, 'AlertCheckPermission');
  for (const line of [
    'FunctionName: !Ref EventsFn',
    'Principal: events.amazonaws.com',
    'SourceArn: !GetAtt AlertCheckRule.Arn',
  ]) {
    assert.ok(permission.includes(line), line);
  }
  const fn = block(template, 'EventsFn');
  assert.ok(fn.includes('ALERT_TOPIC_ARN: !Ref AlertTopic'));
  assert.ok(
    fn.includes("CONSOLE_URL: !If [HasConsoleDomain, !Sub 'https://${ConsoleDomainName}/', !Sub '${Api.ApiEndpoint}/']")
  );
});

test('the alert topic answers only over TLS, and its ARN is an output', () => {
  assert.ok(block(template, 'AlertTopic').includes('Type: AWS::SNS::Topic'));
  const policy = block(template, 'AlertTopicPolicy');
  assert.ok(policy.includes('- !Ref AlertTopic'));
  assert.match(policy, /Effect: Deny\n\s+Principal: '\*'/);
  assert.match(policy, /aws:SecureTransport: 'false'/);
  assert.equal(/Effect: Allow/.test(policy), false);
  assert.ok(block(block(template, 'Outputs', 0), 'AlertTopicArn').includes('Value: !Ref AlertTopic'));
});
