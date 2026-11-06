// Tests for what infra/template.yaml promises of Memfault (docs/memfault.md): a board publishes its chunks on
// its own topic and on nothing else of the kind, one rule hands them to the forwarder and logs what it cannot
// hand over, the project key lives in a secret that the stack makes empty, and each role is allowed exactly
// what it needs. Read as indented text, as in infra.test.mjs.

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

test('a board publishes its chunks on its own memfault topic, and never subscribes or listens there', () => {
  const policy = block(template, 'DevicePolicy');
  const statements = policy.split(/\n {10}- Effect: /).slice(1);
  const of = (action) => statements.find((text) => text.includes(`Action: ${action}\n`));
  assert.ok(of('iot:Publish').includes(`- !Sub '${ARN}:topic/cranium/${OWN}/memfault'`));
  assert.equal(policy.split('/memfault').length - 1, 1);
  for (const action of ['iot:Subscribe', 'iot:Receive', 'iot:Connect'])
    assert.equal(of(action).includes('/memfault'), false, action);
  // The answers come on the commands topic the board already has: nothing new to subscribe to.
  assert.ok(of('iot:Subscribe').includes(`topicfilter/cranium/${OWN}/commands'`));
  assert.equal(/cranium\/\+|cranium\/#|cranium\/\*/.test(policy), false);
});

test('the rule hands every chunk to the forwarder, as base64, with the board from the topic, and logs what it cannot', () => {
  const rule = block(template, 'MemfaultRule');
  const sql = rule
    .split('Sql: >-\n')[1]
    .split('\n')
    .slice(0, 2)
    .map((line) => line.trim())
    .join(' ');
  assert.equal(
    sql,
    "SELECT encode(*, 'base64') AS frame, topic(2) AS thing, timestamp() AS received FROM 'cranium/+/memfault' " +
      "WHERE startswith(topic(2), 'cranium-')"
  );
  for (const line of [
    'Type: AWS::IoT::TopicRule',
    "AwsIotSqlVersion: '2016-03-23'",
    'RuleDisabled: false',
    'FunctionArn: !GetAtt MemfaultFn.Arn',
  ])
    assert.ok(rule.includes(line), line);
  assert.equal(/Republish|S3:|DynamoDBv2/.test(rule), false);
  const error = block(rule, 'ErrorAction', 8);
  assert.ok(error.includes('CloudwatchLogs:'));
  assert.ok(error.includes('LogGroupName: !Ref MemfaultRuleErrorLogGroup'));
  assert.ok(error.includes('RoleArn: !GetAtt MemfaultRuleErrorRole.Arn'));
  assert.ok(block(template, 'MemfaultRuleErrorLogGroup').includes('RetentionInDays: 90'));

  const permission = block(template, 'MemfaultPermission');
  for (const line of [
    'FunctionName: !Ref MemfaultFn',
    'Principal: iot.amazonaws.com',
    'SourceAccount: !Ref AWS::AccountId',
    'SourceArn: !GetAtt MemfaultRule.Arn',
    'Action: lambda:InvokeFunction',
  ])
    assert.ok(permission.includes(line), line);
  // Exactly one way into the forwarder.
  assert.equal(
    resources.filter(
      (text) => text.includes('Type: AWS::Lambda::Permission') && text.includes('FunctionName: !Ref MemfaultFn')
    ).length,
    1
  );
  // And only one rule reads the memfault topics.
  assert.equal(template.split("FROM 'cranium/+/memfault'").length - 1, 1);
});

test("the rule's error log may be written by AWS IoT for this account's rules, and nothing else", () => {
  const role = block(template, 'MemfaultRuleErrorRole');
  assert.ok(role.includes('Service: iot.amazonaws.com'));
  assert.match(role, /aws:SourceAccount: !Ref AWS::AccountId/);
  assert.ok(role.includes(`aws:SourceArn: !Sub '${ARN}:rule/*'`));
  assert.deepEqual(allowed(role), ['logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents']);
  assert.ok(statement(role, 'WriteRuleErrors').includes('Resource: !GetAtt MemfaultRuleErrorLogGroup.Arn'));
  assert.equal(/Resource: '\*'/.test(role), false);
});

test('the project key is a secret the stack makes empty, and no key is ever in the template', () => {
  const secret = block(template, 'MemfaultProjectKey');
  assert.ok(secret.includes('Type: AWS::SecretsManager::Secret'));
  assert.ok(secret.includes("Name: !Sub '${AWS::StackName}/memfault-project-key'"));
  assert.equal(/SecretString|GenerateSecretString/.test(secret), false);
  // Its ARN is an output, for cloud/deploy.sh; the key itself is neither a parameter nor an output.
  assert.ok(block(block(template, 'Outputs', 0), 'MemfaultProjectKeyArn').includes('Value: !Ref MemfaultProjectKey'));
  assert.equal(/^ {2}MemfaultProjectKey\w*:\n {4}Type: String/m.test(template), false);
  assert.equal(/SecretString/.test(template), false);
});

test('the forwarder has its own log and role, is not retried, and is told the secret and the host only', () => {
  const fn = block(template, 'MemfaultFn');
  for (const line of [
    'Type: AWS::Lambda::Function',
    'Handler: memfault.handler',
    'Role: !GetAtt MemfaultRole.Arn',
    'Code: ../api/src',
    'Runtime: nodejs22.x',
    '- arm64',
    'LogGroup: !Ref MemfaultLogGroup',
    'DependsOn: MemfaultLogGroup',
    'Timeout: 15',
    '${DeployedCommit} (${DeployedTree})',
  ])
    assert.ok(fn.includes(line), line);
  assert.deepEqual(
    [...block(fn, 'Variables', 8).matchAll(/^ {10}(\w+):/gm)].map((match) => match[1]),
    ['MEMFAULT_KEY_SECRET_ARN', 'MEMFAULT_CHUNKS_HOST']
  );
  assert.ok(fn.includes('MEMFAULT_KEY_SECRET_ARN: !Ref MemfaultProjectKey'));
  assert.ok(fn.includes('MEMFAULT_CHUNKS_HOST: !Ref MemfaultChunksHost'));
  assert.ok(block(template, 'MemfaultLogGroup').includes('RetentionInDays: 90'));
  const retries = block(template, 'MemfaultFnInvokeConfig');
  assert.ok(retries.includes('FunctionName: !Ref MemfaultFn'));
  assert.ok(retries.includes('MaximumRetryAttempts: 0'));
  assert.ok(retries.includes('MaximumEventAgeInSeconds: 60'));
  assert.ok(block(block(template, 'Outputs', 0), 'MemfaultFunctionName').includes('Value: !Ref MemfaultFn'));
});

test("the forwarder's role: its log, the key, and the boards' commands topics, and nothing else", () => {
  const role = block(template, 'MemfaultRole');
  assert.ok(role.includes('Service: lambda.amazonaws.com'));
  assert.deepEqual(
    [...role.matchAll(/- Sid: (\w+)/g)].map((match) => match[1]),
    ['WriteOwnLog', 'ReadProjectKey', 'AnswerBoards']
  );
  assert.deepEqual(allowed(role), [
    'logs:CreateLogStream',
    'logs:PutLogEvents',
    'secretsmanager:GetSecretValue',
    'iot:Publish',
  ]);
  assert.ok(statement(role, 'WriteOwnLog').includes('Resource: !GetAtt MemfaultLogGroup.Arn'));
  assert.ok(statement(role, 'ReadProjectKey').includes('Resource: !Ref MemfaultProjectKey'));
  assert.ok(statement(role, 'AnswerBoards').includes(`Resource: !Sub '${ARN}:topic/cranium/cranium-*/commands'`));
  assert.equal(/Resource: '\*'/.test(role), false);
});

test('no other role may read the key; the API may only see whether there is one', () => {
  for (const name of [
    'ApiRole',
    'EventsRole',
    'WebRole',
    'LocationRole',
    'SignInScopeRole',
    'PresignRole',
    'RolloutTickRole',
  ]) {
    assert.equal(block(template, name).includes('secretsmanager:GetSecretValue'), false, name);
  }
  assert.equal(template.split('secretsmanager:GetSecretValue').length - 1, 1);
  const api = block(template, 'ApiRole');
  const see = statement(api, 'SeeMemfaultKey');
  assert.ok(see.includes('Action: secretsmanager:DescribeSecret\n'));
  assert.ok(see.includes('Resource: !Ref MemfaultProjectKey'));
  assert.deepEqual(
    allowed(api).filter((action) => action.startsWith('secretsmanager:')),
    ['secretsmanager:DescribeSecret']
  );
  const variables = block(block(template, 'ApiFn'), 'Variables', 8);
  for (const line of [
    'MEMFAULT_KEY_SECRET_ARN: !Ref MemfaultProjectKey',
    'MEMFAULT_ORG_SLUG: !Ref MemfaultOrgSlug',
    'MEMFAULT_PROJECT_SLUG: !Ref MemfaultProjectSlug',
  ])
    assert.ok(variables.includes(line), line);
});

test("the parameters: two hosts of Memfault's chunks API, nRF Cloud's first, and slugs that are no secret", () => {
  const parameters = block(template, 'Parameters', 0);
  const host = block(parameters, 'MemfaultChunksHost');
  assert.ok(host.includes('Default: chunks-nrf.memfault.com'));
  assert.ok(host.includes('AllowedValues: [chunks-nrf.memfault.com, chunks.memfault.com]'));
  for (const name of ['MemfaultOrgSlug', 'MemfaultProjectSlug']) {
    const slug = block(parameters, name);
    assert.ok(slug.includes("Default: ''"), name);
    assert.ok(slug.includes("AllowedPattern: '^$|^[a-z0-9][a-z0-9-]{0,62}$'"), name);
    assert.equal(slug.includes('NoEcho'), false, name);
  }
});

test('deploy.sh stores the key from its file, by its digest, and never prints it or makes it a parameter', () => {
  const deploy = read('deploy.sh');
  assert.ok(deploy.includes('MEMFAULT_KEY_FILE="$HOME/.cranium/memfault_project_key"'));
  assert.ok(deploy.includes('--secret-string "file://$MEMFAULT_KEY_FILE"'));
  assert.ok(deploy.includes('--client-request-token "$token"'));
  assert.equal(/cat "\$MEMFAULT_KEY_FILE"|\$\(cat|echo "\$\(<|MemfaultProjectKey=/.test(deploy), false);
  assert.ok(deploy.includes('MemfaultChunksHost=*'));
});
