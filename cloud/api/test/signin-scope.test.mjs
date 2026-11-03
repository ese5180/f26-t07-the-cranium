// Tests for the sign-in trigger (src/signin-scope.mjs): Cognito's pre token generation
// trigger, event version 2. It may give cranium/console, and take away
// aws.cognito.signin.user.admin, only for the console's web client and the phone apps' client
// at the end of a sign-in through the user pool API or a refresh, and must leave everything
// else as it came.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ADMIN_SCOPE, CONSOLE_SCOPE, createScopeTrigger, withConsoleScope } from '../src/signin-scope.mjs';

const WEB = 'webclient0example';
const MOBILE = 'mobileclient0example';
const GROUPS = { groupsToOverride: ['release-managers'], iamRolesToOverride: [], preferredRole: null };

/** An event as Cognito sends it (the documentation's example, with this pool's values). */
function event({ source = 'TokenGeneration_Authentication', client = WEB, scopes = [ADMIN_SCOPE], groups = GROUPS } = {}) {
  const request = {
    userAttributes: { sub: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d', 'cognito:user_status': 'CONFIRMED' },
    groupConfiguration: groups,
  };
  if (scopes !== undefined) request.scopes = scopes;
  return {
    version: '2',
    triggerSource: source,
    region: 'xx-test-1',
    userPoolId: 'xx-test-1_Pool0Tests',
    userName: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
    callerContext: { awsSdkVersion: 'aws-sdk-unknown-unknown', clientId: client },
    request,
    response: { claimsAndScopeOverrideDetails: null },
  };
}

const handler = createScopeTrigger([WEB, MOBILE]);

test('a sign-in through the user pool API gets the console\'s scope and loses the admin scope, on the web and the phone', async () => {
  for (const [client, source] of [[WEB, 'TokenGeneration_Authentication'], [WEB, 'TokenGeneration_RefreshTokens'],
    [MOBILE, 'TokenGeneration_Authentication'], [MOBILE, 'TokenGeneration_RefreshTokens']]) {
    const given = event({ client, source });
    const before = structuredClone(given);
    const answer = await handler(given);
    assert.deepEqual(answer.response.claimsAndScopeOverrideDetails, {
      accessTokenGeneration: { scopesToAdd: [CONSOLE_SCOPE], scopesToSuppress: [ADMIN_SCOPE] },
      // Handed back as they came: Cognito's documented way to keep the groups.
      groupOverrideDetails: GROUPS,
    }, `${client} ${source}`);
    // Nothing else of the event changes, and the event that came in is left alone.
    assert.deepEqual({ ...answer, response: before.response }, before);
    assert.deepEqual(given, before);
  }
  assert.equal(CONSOLE_SCOPE, 'cranium/console');
  assert.equal(ADMIN_SCOPE, 'aws.cognito.signin.user.admin');
});

test('every other token passes through untouched', async () => {
  const untouched = [
    // The managed login pages: their tokens already carry the scope they asked for.
    event({ source: 'TokenGeneration_HostedAuth', scopes: ['openid', CONSOLE_SCOPE] }),
    event({ source: 'TokenGeneration_HostedAuth', scopes: [ADMIN_SCOPE, 'openid'] }),
    // The phone apps' client through the managed login pages, and a refresh of such a token.
    event({ client: MOBILE, source: 'TokenGeneration_HostedAuth', scopes: ['openid', CONSOLE_SCOPE] }),
    event({ client: MOBILE, source: 'TokenGeneration_RefreshTokens', scopes: ['openid', CONSOLE_SCOPE] }),
    // Any other client, or none.
    event({ client: 'someoneelse' }),
    event({ client: null }),
    // Steps this trigger has nothing to do with.
    event({ source: 'TokenGeneration_NewPasswordChallenge' }),
    event({ source: 'TokenGeneration_AuthenticateDevice' }),
    event({ source: 'TokenGeneration_ClientCredentials' }),
    event({ source: 'PreSignUp_SignUp' }),
    event({ source: null }),
    // A refresh of a token from the managed login, which has the scope and not the other.
    event({ source: 'TokenGeneration_RefreshTokens', scopes: ['openid', CONSOLE_SCOPE] }),
  ];
  for (const given of untouched) {
    const before = structuredClone(given);
    assert.deepEqual(await handler(given), before, `${given.triggerSource} for ${given.callerContext.clientId}`);
  }
});

test('only what is missing is added, and only what is there is taken away', async () => {
  const half = await handler(event({ scopes: [ADMIN_SCOPE, CONSOLE_SCOPE] }));
  assert.deepEqual(half.response.claimsAndScopeOverrideDetails.accessTokenGeneration, { scopesToSuppress: [ADMIN_SCOPE] });
  const other = await handler(event({ scopes: ['openid'] }));
  assert.deepEqual(other.response.claimsAndScopeOverrideDetails.accessTokenGeneration, { scopesToAdd: [CONSOLE_SCOPE] });
  // Without the list of scopes, both: the token gets the scope and cannot keep the other.
  const unknown = await handler(event({ scopes: undefined }));
  assert.deepEqual(unknown.response.claimsAndScopeOverrideDetails.accessTokenGeneration,
    { scopesToAdd: [CONSOLE_SCOPE], scopesToSuppress: [ADMIN_SCOPE] });
  // No other scope is ever named.
  for (const answer of [half, other, unknown]) {
    const change = answer.response.claimsAndScopeOverrideDetails.accessTokenGeneration;
    assert.deepEqual([...change.scopesToAdd ?? [], ...change.scopesToSuppress ?? []]
      .filter((scope) => scope !== CONSOLE_SCOPE && scope !== ADMIN_SCOPE), []);
    assert.equal('idTokenGeneration' in answer.response.claimsAndScopeOverrideDetails, false);
  }
});

test('the groups go back in the form of an answer, and an odd group setting is not passed on as it is', async () => {
  const odd = await handler(event({
    groups: { groupsToOverride: ['viewers', 7], iamRolesToOverride: null, preferredRole: ['arn:example'] },
  }));
  assert.deepEqual(odd.response.claimsAndScopeOverrideDetails.groupOverrideDetails,
    { groupsToOverride: ['viewers'], iamRolesToOverride: [], preferredRole: null });
  const none = await handler(event({ groups: [] }));
  assert.equal('groupOverrideDetails' in none.response.claimsAndScopeOverrideDetails, false);
  const missing = await handler(event({ groups: null }));
  assert.equal('groupOverrideDetails' in missing.response.claimsAndScopeOverrideDetails, false);
});

test('a trigger that does not know the client changes nothing; it never throws', async () => {
  for (const id of [undefined, '', null, 5, [], [undefined, ''], [null, 5]]) {
    const given = event();
    assert.deepEqual(await createScopeTrigger(id)(given), event(), String(id));
  }
  // Told only one of the two clients, it changes the tokens of that one only.
  assert.deepEqual(await createScopeTrigger(WEB)(event({ client: MOBILE })), event({ client: MOBILE }));
  assert.deepEqual(await createScopeTrigger([undefined, MOBILE])(event()), event());
  for (const odd of [null, undefined, 'text', 7, [], {}, { callerContext: null }, { triggerSource: 'TokenGeneration_Authentication' }]) {
    assert.deepEqual(await handler(odd), odd);
  }
  // A response Cognito sent as a list, as in its documentation's example, gets an object.
  const listed = await handler({ ...event(), response: { claimsAndScopeOverrideDetails: [] } });
  assert.equal(Array.isArray(listed.response.claimsAndScopeOverrideDetails), false);
  assert.deepEqual(withConsoleScope({ ...event(), response: undefined }, WEB).response.claimsAndScopeOverrideDetails
    .accessTokenGeneration.scopesToAdd, [CONSOLE_SCOPE]);
});

test('the deployed handler is told both clients by its environment, and needs nothing else', async () => {
  const saved = { web: process.env.CONSOLE_CLIENT_ID, mobile: process.env.MOBILE_CLIENT_ID };
  process.env.CONSOLE_CLIENT_ID = WEB;
  process.env.MOBILE_CLIENT_ID = MOBILE;
  try {
    const { handler: deployed } = await import('../src/signin-scope.mjs?deployed');
    for (const client of [WEB, MOBILE]) {
      const answer = await deployed(event({ client }));
      assert.deepEqual(answer.response.claimsAndScopeOverrideDetails.accessTokenGeneration.scopesToAdd, [CONSOLE_SCOPE]);
    }
    assert.deepEqual(await deployed(event({ client: 'someoneelse' })), event({ client: 'someoneelse' }));
  } finally {
    for (const [name, value] of [['CONSOLE_CLIENT_ID', saved.web], ['MOBILE_CLIENT_ID', saved.mobile]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  // It imports nothing: no AWS SDK, no other module of the API.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/signin-scope.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /console\.|fetch\(|require\(/);
});
