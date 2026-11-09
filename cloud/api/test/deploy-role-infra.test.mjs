// Tests for the role that GitHub Actions deploys the console with (infra/github-deploy.yaml) and the
// workflow that assumes it (.github/workflows/deploy-console.yml). Read as indented text, like
// infra.test.mjs: they catch a promise being dropped by an edit. Whether AWS accepts the template is for
// a deployment to say.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (name) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const role = read('infra/github-deploy.yaml');
const template = read('infra/template.yaml');
const deploy = read('deploy.sh');
const workflow = read('../.github/workflows/deploy-console.yml');

/** Lines that are not comments. */
const code = (text) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

/** The statements of the permission policies (not the trust policy), each as text, split at "- Sid:". */
function statements(text) {
  return code(text.slice(text.indexOf('\n  StackPolicy:\n')))
    .split(/\n(?= {10}- Sid: )/)
    .slice(1)
    .map((part) => part.split(/\n(?= {2}\w+:\n)/)[0]);
}

/** The actions a statement allows: a single "Action: x" or the list below "Action:". */
function actions(statement) {
  const single = /\n\s+Action: (.+)/.exec(statement);
  if (single) return [single[1].trim()];
  const lines = statement.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'Action:');
  assert.notEqual(start, -1, `no Action in ${statement.split('\n')[0]}`);
  const found = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+- (.+)$/.exec(line);
    if (!item) break;
    found.push(item[1].trim());
  }
  return found;
}

test('only main and console-v* tags of this repository may assume the role', () => {
  const trust = code(role).split('AssumeRolePolicyDocument:')[1].split('ManagedPolicyArns:')[0];
  assert.equal(trust.match(/- Sid: /g).length, 1);
  assert.ok(trust.includes('Effect: Allow'));
  assert.ok(trust.includes('Action: sts:AssumeRoleWithWebIdentity\n'));
  assert.ok(
    trust.includes('StringEquals:\n                token.actions.githubusercontent.com:aud: sts.amazonaws.com\n')
  );
  // The branch main and the console-v* tags, with the repository named either way GitHub
  // names it (owner/name, or the immutable owner@id/name@id), and nothing broader.
  const subjects = trust.split('token.actions.githubusercontent.com:sub:\n')[1];
  assert.ok(trust.includes('StringLike:\n                token.actions.githubusercontent.com:sub:\n'));
  assert.deepEqual(
    [...subjects.matchAll(/- !Sub '([^']+)'/g)].map((match) => match[1]),
    [
      'repo:${GitHubRepository}:ref:refs/heads/main',
      'repo:${GitHubRepository}:ref:refs/tags/console-v*',
      '${GitHubSubjectPrefix}:ref:refs/heads/main',
      '${GitHubSubjectPrefix}:ref:refs/tags/console-v*',
    ]
  );
  assert.ok(
    /GitHubSubjectPrefix:\n\s+Type: String\n\s+Default: 'repo:ese5180@\d+\/f26-t07-the-cranium@\d+'\n/.test(role)
  );
  assert.equal(trust.match(/:sub/g).length, 1);
  assert.equal(/environment|pull_request|refs\/heads\/\*/.test(trust), false);
  assert.ok(/GitHubRepository:\n\s+Type: String\n\s+Default: ese5180\/f26-t07-the-cranium\n/.test(role));
  assert.ok(role.includes('Url: https://token.actions.githubusercontent.com'));
});

test('no statement allows every action, a whole service, or billing and organizations', () => {
  const all = statements(role);
  assert.ok(all.length >= 15, `found ${all.length} statements`);
  for (const statement of all) {
    const name = statement.split('\n')[0].trim();
    assert.ok(statement.includes('Effect: Allow'), name);
    for (const action of actions(statement)) {
      assert.notEqual(action.replace(/'/g, ''), '*', name);
      assert.ok(/^[a-z0-9-]+:[A-Za-z0-9]+$/.test(action), `${name}: ${action}`);
      assert.equal(
        /^(aws-portal|billing|budgets|ce|cur|organizations|account|payments|purchase-orders|tax|sts|cloudtrail):/.test(
          action
        ),
        false,
        `${name}: ${action}`
      );
    }
  }
  assert.equal(/Action: '?\*'?\s*$/m.test(role), false);
  assert.equal(/- '?\*'?\s*$/m.test(code(role)), false);
  assert.equal(code(role).includes('NotAction'), false);
});

test("IAM is limited to the console stack's roles, which never include the deploy role", () => {
  for (const statement of statements(role)) {
    if (!actions(statement).some((action) => action.startsWith('iam:'))) continue;
    assert.ok(
      statement.includes("Resource: !Sub 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${ConsoleStackName}-*'"),
      statement.split('\n')[0]
    );
    assert.equal(actions(statement).includes('iam:AttachRolePolicy'), false);
  }
  const passRole = statements(role).find((statement) => actions(statement).includes('iam:PassRole'));
  assert.ok(passRole.includes('iam:PassedToService:'));
  assert.equal(/RoleName: cranium-ota-/.test(role), false);
  assert.ok(role.includes('RoleName: cranium-github-deploy'));
  assert.ok(/ConsoleStackName:\n\s+Type: String\n\s+Default: cranium-ota\n/.test(role));
  assert.ok(deploy.includes('STACK=cranium-ota\n'));
  assert.ok(deploy.includes('BOOTSTRAP_STACK=cranium-ota-bootstrap\n'));
});

test('CloudFormation is limited to the two stacks of deploy.sh', () => {
  const stacks = statements(role).find((statement) => statement.includes('Sid: ConsoleStacks'));
  const resources = stacks.match(/stack\/[^']+/g);
  assert.deepEqual(resources, ['stack/${ConsoleStackName}/*', 'stack/${ConsoleStackName}-bootstrap/*']);
});

test('the IoT names in the role are the ones template.yaml gives', () => {
  assert.ok(template.includes('ThingGroupName: cranium-devices\n'));
  assert.ok(template.includes('PolicyName: cranium-device\n'));
  assert.ok(role.includes(':thinggroup/cranium-devices'));
  assert.ok(role.includes(':policy/cranium-device'));
});

test('the role can store the Memfault project key and not read it back', () => {
  assert.equal(role.includes('secretsmanager:GetSecretValue'), false);
  assert.equal(/dynamodb:(GetItem|PutItem|Query|Scan)/.test(role), false);
});

test('the workflow assumes the role over OIDC, with no stored AWS key', () => {
  assert.equal(workflow.includes('environment:'), false);
  assert.ok(workflow.includes('      id-token: write\n'));
  assert.ok(/\npermissions:\n {2}contents: read\n/.test(workflow));
  assert.ok(/aws-actions\/configure-aws-credentials@[0-9a-f]{40} # v\d/.test(workflow));
  assert.ok(workflow.includes('role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}'));
  assert.ok(workflow.includes('aws-region: ${{ vars.AWS_REGION }}'));
  assert.equal(/aws-access-key-id|aws-secret-access-key/.test(workflow), false);
  assert.ok(workflow.includes("      - 'console-v*'\n"));
  assert.ok(workflow.includes('run: cloud/deploy.sh\n'));
  // Every action is pinned by commit.
  for (const [, ref] of workflow.matchAll(/uses: [^@\s]+@(\S+)/g)) {
    assert.ok(/^[0-9a-f]{40}$/.test(ref), ref);
  }
});
