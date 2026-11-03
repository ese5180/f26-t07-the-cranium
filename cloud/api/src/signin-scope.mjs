/**
 * Lambda entry point of the sign-in trigger (handler: signin-scope.handler), the function
 * SignInScopeFn: Cognito's pre token generation trigger, event version 2 (V2_0).
 *
 * The console's own sign-in page, and the phone apps' own sign-in screen, sign in through
 * Cognito's user pool API (USER_SRP_AUTH), not through the managed login pages: that is how
 * they ask for the code in six boxes. An access token made that way carries one scope,
 * aws.cognito.signin.user.admin, which lets its holder read and change their own account
 * through Cognito's user APIs, and not cranium/console, which every API route demands. For
 * the console's web client and the phone apps' client, and only for a token made at the end
 * of such a sign-in or by a refresh, this adds cranium/console and takes the other scope out.
 * That is the access the same person gets through the managed login pages, which already ask
 * for cranium/console and never for the other scope.
 *
 * Everything else passes through as it came: the managed login pages
 * (TokenGeneration_HostedAuth), any other client, and any other step. The groups are handed
 * back as Cognito sent them, which its documentation gives as the way to keep them. Cognito
 * calls this for every token of the pool, so it never throws and calls nothing: on anything
 * it does not expect, it changes nothing.
 *
 * The function is told the two clients' IDs (CONSOLE_CLIENT_ID, MOBILE_CLIENT_ID) and nothing
 * else. Its role may only write its own log.
 */

export const CONSOLE_SCOPE = 'cranium/console';
export const ADMIN_SCOPE = 'aws.cognito.signin.user.admin';
// The end of a sign-in through the user pool API, and a refresh.
const SOURCES = new Set(['TokenGeneration_Authentication', 'TokenGeneration_RefreshTokens']);

const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

/** The groups as Cognito sent them, in the form of an answer. */
function sameGroups(configuration) {
  if (configuration === null || typeof configuration !== 'object' || Array.isArray(configuration)) return null;
  return {
    groupsToOverride: strings(configuration.groupsToOverride),
    iamRolesToOverride: strings(configuration.iamRolesToOverride),
    preferredRole: typeof configuration.preferredRole === 'string' ? configuration.preferredRole : null,
  };
}

/** The client IDs given, as a list of the non-empty strings among them. */
function served(clientIds) {
  return (Array.isArray(clientIds) ? clientIds : [clientIds])
    .filter((id) => typeof id === 'string' && id !== '');
}

/**
 * The event with Cognito's answer in it: the scopes changed for the console's clients, or
 * the event as it came.
 *
 * @param {object} event                      a pre token generation event, version 2
 * @param {string | string[]} clientIds       the console's web client and the phone apps'
 *                                            client; no token of another changes
 */
export function withConsoleScope(event, clientIds) {
  const clients = served(clientIds);
  if (clients.length === 0) return event;
  if (event === null || typeof event !== 'object') return event;
  if (!clients.includes(event.callerContext?.clientId) || !SOURCES.has(event.triggerSource)) return event;

  // An event without the list of scopes still gets the scope and loses the other.
  const scopes = Array.isArray(event.request?.scopes) ? event.request.scopes : null;
  const add = scopes !== null && scopes.includes(CONSOLE_SCOPE) ? [] : [CONSOLE_SCOPE];
  const suppress = scopes === null || scopes.includes(ADMIN_SCOPE) ? [ADMIN_SCOPE] : [];
  if (add.length === 0 && suppress.length === 0) return event;

  const accessTokenGeneration = {};
  if (add.length > 0) accessTokenGeneration.scopesToAdd = add;
  if (suppress.length > 0) accessTokenGeneration.scopesToSuppress = suppress;
  const details = { accessTokenGeneration };
  const groups = sameGroups(event.request?.groupConfiguration);
  if (groups !== null) details.groupOverrideDetails = groups;

  const response = event.response !== null && typeof event.response === 'object' ? event.response : {};
  return { ...event, response: { ...response, claimsAndScopeOverrideDetails: details } };
}

/** The Lambda handler for the clients given (an ID, or a list of them). */
export function createScopeTrigger(clientIds) {
  return async (event) => withConsoleScope(event, clientIds);
}

export const handler = createScopeTrigger([process.env.CONSOLE_CLIENT_ID, process.env.MOBILE_CLIENT_ID]);
