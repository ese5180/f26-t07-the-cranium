// Tests for what infra/template.yaml promises of live updates (docs/live.md): the WebSocket API and its
// routes, the tables' streams and what of them reaches the function, and that the live function's role is
// allowed exactly what it needs. Read as indented text, as in infra.test.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const template = readFileSync(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
const ARN = 'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}';

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
  const policies = role.slice(role.indexOf('Policies:'));
  return [...policies.matchAll(/^\s*(?:Action: |- )([a-z0-9-]+:[A-Za-z*]+)$/gm)].map((match) => match[1]);
}

test('the live API is a WebSocket API of its own, whose three routes go to the live function, which checks the token itself', () => {
  const api = block(template, 'LiveApi');
  assert.ok(api.includes('ProtocolType: WEBSOCKET'));
  assert.ok(api.includes('RouteSelectionExpression: $request.body.action'));
  const integration = block(template, 'LiveIntegration');
  assert.ok(integration.includes('ApiId: !Ref LiveApi'));
  assert.ok(integration.includes('IntegrationType: AWS_PROXY'));
  assert.ok(integration.includes('/functions/${LiveFn.Arn}/invocations'));
  const routes = template
    .split(/\n(?= {2}\w+:\n)/)
    .filter(
      (resource) => resource.includes('Type: AWS::ApiGatewayV2::Route') && resource.includes('ApiId: !Ref LiveApi\n')
    );
  assert.deepEqual(routes.map((route) => /RouteKey: (\S+)/.exec(route)[1]).sort(), [
    '$connect',
    '$default',
    '$disconnect',
  ]);
  for (const route of routes) {
    assert.ok(route.includes('AuthorizationType: NONE'));
    assert.ok(route.includes("Target: !Sub 'integrations/${LiveIntegration}'"));
  }
  const stage = block(template, 'LiveStage');
  for (const line of ['StageName: live', 'AutoDeploy: true', 'ThrottlingBurstLimit: 20', 'ThrottlingRateLimit: 10']) {
    assert.ok(stage.includes(line), line);
  }
  // Only this API may invoke the function through API Gateway.
  assert.ok(block(template, 'LiveFnPermission').includes(`SourceArn: !Sub '${ARN}:\${LiveApi}/*'`));
  // The web function tells both sites' pages where it is, and the stack says so too.
  assert.ok(block(template, 'WebFn').includes("LIVE_URL: !Sub '${LiveApi.ApiEndpoint}/${LiveStage}'"));
  assert.ok(block(template, 'LiveUrl').includes("Value: !Sub '${LiveApi.ApiEndpoint}/${LiveStage}'"));
});

test('the three tables keep their protection and gain a stream of keys only; the connections are a table of their own', () => {
  for (const name of ['StateTable', 'AuditTable', 'EventsTable']) {
    const table = block(template, name);
    assert.ok(table.includes('StreamSpecification:\n        StreamViewType: KEYS_ONLY'), name);
    assert.ok(table.includes('DeletionProtectionEnabled: !If [ProtectFromDeletion, true, false]'), name);
    assert.ok(table.includes('DeletionPolicy: RetainExceptOnCreate'), name);
  }
  const connections = block(template, 'ConnectionsTable');
  assert.ok(connections.includes('AttributeName: connectionId'));
  assert.ok(connections.includes('TimeToLiveSpecification:\n        AttributeName: ttl\n        Enabled: true'));
  assert.equal(connections.includes('StreamSpecification'), false);
});

test('of the streams, only what is a change reaches the function, and an old change is given up', () => {
  const filters = (name) =>
    [...block(template, name).matchAll(/- Pattern: '([^']+)'/g)].map((match) => JSON.parse(match[1]));
  const changed = ['INSERT', 'MODIFY'];
  assert.deepEqual(filters('LiveEventsStream'), [
    { eventName: changed, dynamodb: { Keys: { sk: { S: [{ prefix: 'E#' }] } } } },
    { eventName: changed, dynamodb: { Keys: { pk: { S: [{ prefix: 'UPD#' }] } } } },
  ]);
  assert.deepEqual(filters('LiveStateStream'), [
    { dynamodb: { Keys: { pk: { S: ['OWN', 'REL', 'GRP', 'ROL', 'APP'] } } } },
  ]);
  assert.deepEqual(filters('LiveAuditStream'), [{ eventName: ['INSERT'] }]);
  for (const [name, table] of [
    ['LiveEventsStream', 'EventsTable'],
    ['LiveStateStream', 'StateTable'],
    ['LiveAuditStream', 'AuditTable'],
  ]) {
    const mapping = block(template, name);
    for (const line of [
      'FunctionName: !Ref LiveFn',
      `EventSourceArn: !GetAtt ${table}.StreamArn`,
      'StartingPosition: LATEST',
      'MaximumRetryAttempts: 2',
      'MaximumRecordAgeInSeconds: 60',
    ]) {
      assert.ok(mapping.includes(line), `${name}: ${line}`);
    }
  }
});

test('the live function may keep connections, read ownership and the streams, tell its own pages, and ask Cognito, and nothing else', () => {
  const role = block(template, 'LiveRole');
  assert.deepEqual(allowed(role).sort(), [
    'cognito-idp:AdminGetUser',
    'cognito-idp:AdminListGroupsForUser',
    'dynamodb:DeleteItem',
    'dynamodb:DescribeStream',
    'dynamodb:GetRecords',
    'dynamodb:GetShardIterator',
    'dynamodb:ListStreams',
    'dynamodb:PutItem',
    'dynamodb:Query',
    'dynamodb:Scan',
    'execute-api:ManageConnections',
    'logs:CreateLogStream',
    'logs:PutLogEvents',
  ]);
  assert.ok(statement(role, 'KeepConnections').includes('Resource: !GetAtt ConnectionsTable.Arn'));
  const ownership = statement(role, 'ReadOwnership');
  assert.ok(ownership.includes('Resource: !GetAtt StateTable.Arn'));
  assert.ok(ownership.includes('dynamodb:LeadingKeys:\n                      - OWN\n'));
  const streams = statement(role, 'ReadStreams');
  for (const table of ['EventsTable', 'StateTable', 'AuditTable'])
    assert.ok(streams.includes(`- !GetAtt ${table}.StreamArn`));
  assert.equal(streams.includes("'*'"), false);
  const tell = statement(role, 'TellPages');
  assert.deepEqual(
    [...tell.matchAll(/- !Sub '([^']+)'/g)].map((match) => match[1]),
    [`${ARN}:\${LiveApi}/live/POST/@connections/*`, `${ARN}:\${LiveApi}/live/DELETE/@connections/*`]
  );
  assert.ok(
    statement(role, 'CheckAccounts').includes(
      '- !GetAtt UserPool.Arn\n                  - !GetAtt CustomerUserPool.Arn'
    )
  );
  assert.ok(statement(role, 'CheckTeamGroups').includes('Resource: !GetAtt UserPool.Arn'));

  const fn = block(template, 'LiveFn');
  for (const line of [
    'Handler: live.handler',
    'Role: !GetAtt LiveRole.Arn',
    'LogGroup: !Ref LiveLogGroup',
    'USER_POOL_CLIENT_ID: !Ref UserPoolClient',
    'MOBILE_CLIENT_ID: !Ref MobileUserPoolClient',
    'CUSTOMER_CLIENT_ID: !Ref CustomerUserPoolClient',
    'CUSTOMER_MOBILE_CLIENT_ID: !Ref CustomerMobileUserPoolClient',
    'CONNECTIONS_TABLE: !Ref ConnectionsTable',
    "LIVE_CALLBACK_URL: !Sub 'https://${LiveApi}.execute-api.${AWS::Region}.amazonaws.com/live'",
  ]) {
    assert.ok(fn.includes(line), line);
  }
  assert.ok(block(template, 'LiveLogGroup').includes('RetentionInDays: 90'));
});

test("the phone apps take the live API's address from their own configuration, which configure.sh and the Apps page write", () => {
  // The API hands it out with the rest of cranium.json (GET /api/apps/config).
  assert.ok(block(template, 'ApiFn').includes("LIVE_URL: !Sub '${LiveApi.ApiEndpoint}/${LiveStage}'"));
  const configure = readFileSync(new URL('../../../apps/configure.sh', import.meta.url), 'utf8');
  assert.ok(configure.includes('outputs.get("LiveUrl")'));
  assert.ok(configure.includes('config["liveUrl"] = live'));
  // Only the live API's address, in the stack's Region, ever reaches a page's policy.
  assert.ok(configure.includes(String.raw`wss://[a-z0-9]{10}\.execute-api\.`));
});
