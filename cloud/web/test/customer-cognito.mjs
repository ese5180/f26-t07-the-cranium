/**
 * A stand-in for Cognito's user pool API as the customer site uses it, for the customer pool
 * (docs/customer-site.md): sign-in with USER_SRP_AUTH, the first sign-in's new password
 * (NEW_PASSWORD_REQUIRED), the code of an authenticator app if the customer turned one on, the
 * revocation of a refresh token, and what a signed-in customer does with their own access token:
 * GetUser, ChangePassword, AssociateSoftwareToken, VerifySoftwareToken, SetUserMFAPreference. And
 * the reset of a forgotten password, ForgotPassword and ConfirmForgotPassword, which answer alike
 * for an address with an account and one without, as a pool with PreventUserExistenceErrors does.
 *
 * The server's half of SRP is cognito.mjs's, which is written apart from core.js. An account's
 * state (enabled, invited or confirmed) is the directory's (test/fake-customers.mjs in the preview),
 * so that the customer API and this stand-in agree on it; what only Cognito knows, the password, the
 * authenticator and the tokens, is kept here.
 *
 * Codes are fixed, as in cognito.mjs: an authenticator's code is the account's `code`, and a reset's
 * is `resetCode`. Nothing here is a test.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

import { N, expectedClaim, g, k, passwordNumber, powMod, timestampAt } from './cognito.mjs';

const SESSION_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const PASSWORD_MIN = 10;
const SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const numberOf = (bytes) => BigInt(`0x${bytes.toString('hex') || '0'}`);

/**
 * @param {object} options
 * @param {string} options.userPoolId
 * @param {string} options.clientId
 * @param {object} options.directory   find(email) and bySub(sub) -> { sub, email, name, enabled, status }
 *                                     | null, and confirm(sub): the account set its own password
 * @param {() => number} [options.now]
 * @param {(sub: string) => object} [options.issue]  the tokens of a sign-in that worked
 * @param {string} [options.resetCode]  the code a password reset e-mails
 */
export function createCustomerCognito({
  userPoolId,
  clientId,
  directory,
  now = Date.now,
  issue,
  resetCode = '135790',
}) {
  const calls = [];
  const credentials = new Map(); // sub -> { salt, verifier, code, authenticator, pendingCode }
  const exchanges = new Map(); // secret block -> the server's half of an exchange
  const sessions = new Map(); // Cognito's session -> the step it waits for
  const tokens = new Map(); // access token -> { sub, expiresAt }
  const refreshTokens = new Set();
  const resets = new Map(); // email -> code
  let issued = 0;

  const refuse = (name, message = name) => ({ status: 400, body: { __type: name, message } });
  const ok = (body) => ({ status: 200, body });
  const token = () => randomBytes(24).toString('base64url');

  function setPassword(sub, password) {
    const salt = numberOf(randomBytes(16));
    const x = passwordNumber({ userPoolId, userId: sub, password, salt });
    const known = credentials.get(sub) ?? { authenticator: false, code: null, fixedCode: null };
    credentials.set(sub, { ...known, salt, verifier: powMod(g, x, N) });
  }

  function tokensFor(sub) {
    issued += 1;
    const made = issue?.(sub) ?? { AccessToken: token(), ExpiresIn: 3600, RefreshToken: token(), IdToken: token() };
    tokens.set(made.AccessToken, { sub, expiresAt: now() + made.ExpiresIn * 1000 });
    refreshTokens.add(made.RefreshToken);
    return ok({ AuthenticationResult: { TokenType: 'Bearer', ...made }, ChallengeParameters: {} });
  }

  function challenge(name, sub) {
    const session = token();
    sessions.set(session, { name, sub, expiresAt: now() + SESSION_MS });
    return ok({
      ChallengeName: name,
      Session: session,
      ChallengeParameters: name === 'NEW_PASSWORD_REQUIRED' ? { requiredAttributes: '[]' } : {},
    });
  }

  function initiate(body) {
    if (body.AuthFlow !== 'USER_SRP_AUTH') return refuse('InvalidParameterException');
    const { USERNAME: username, SRP_A: srpA } = body.AuthParameters ?? {};
    if (typeof username !== 'string' || typeof srpA !== 'string' || !/^[0-9a-f]+$/i.test(srpA))
      return refuse('InvalidParameterException');
    const A = BigInt(`0x${srpA}`);
    if (A % N === 0n) return refuse('NotAuthorizedException');
    const account = directory.find(username.toLowerCase());
    const known = account ? credentials.get(account.sub) : undefined;
    const salt = known?.salt ?? numberOf(randomBytes(16));
    const verifier = known?.verifier ?? powMod(g, numberOf(randomBytes(32)), N);
    const userId = account?.sub ?? randomBytes(16).toString('hex');
    const b = numberOf(randomBytes(32));
    const B = (k * verifier + powMod(g, b, N)) % N;
    const secretBlock = randomBytes(96).toString('base64');
    exchanges.set(secretBlock, { account: known ? account : null, userId, verifier, A, b, B });
    return ok({
      ChallengeName: 'PASSWORD_VERIFIER',
      ChallengeParameters: {
        SALT: salt.toString(16),
        SECRET_BLOCK: secretBlock,
        SRP_B: B.toString(16),
        USERNAME: userId,
        USER_ID_FOR_SRP: userId,
      },
    });
  }

  function verifyPassword(body) {
    const answer = body.ChallengeResponses ?? {};
    const exchange = exchanges.get(answer.PASSWORD_CLAIM_SECRET_BLOCK);
    exchanges.delete(answer.PASSWORD_CLAIM_SECRET_BLOCK);
    if (!exchange) return refuse('NotAuthorizedException');
    const at = timestampAt(String(answer.TIMESTAMP));
    if (Number.isNaN(at) || Math.abs(at - now()) > CLOCK_SKEW_MS) return refuse('NotAuthorizedException');
    const expected = expectedClaim({
      userPoolId,
      userId: exchange.userId,
      verifier: exchange.verifier,
      A: exchange.A,
      b: exchange.b,
      B: exchange.B,
      secretBlock: answer.PASSWORD_CLAIM_SECRET_BLOCK,
      timestamp: answer.TIMESTAMP,
    });
    const given = Buffer.from(String(answer.PASSWORD_CLAIM_SIGNATURE), 'utf8');
    const right = given.length === expected.length && timingSafeEqual(given, Buffer.from(expected, 'utf8'));
    if (!exchange.account || answer.USERNAME !== exchange.userId || !right) return refuse('NotAuthorizedException');
    // Checked after the password, as Cognito does: a wrong password reads the same either way.
    const account = directory.find(exchange.account.email);
    if (!account || !account.enabled) return refuse('NotAuthorizedException', 'User is disabled.');
    if (account.status === 'FORCE_CHANGE_PASSWORD') return challenge('NEW_PASSWORD_REQUIRED', account.sub);
    if (credentials.get(account.sub)?.authenticator) return challenge('SOFTWARE_TOKEN_MFA', account.sub);
    return tokensFor(account.sub);
  }

  function step(body, name) {
    const session = sessions.get(body.Session);
    if (!session || session.name !== name || session.expiresAt <= now()) {
      sessions.delete(body.Session);
      return { refusal: refuse('NotAuthorizedException', 'Invalid session for the user.') };
    }
    if ((body.ChallengeResponses ?? {}).USERNAME !== session.sub) return { refusal: refuse('NotAuthorizedException') };
    return { session };
  }

  function newPassword(body) {
    const { session, refusal } = step(body, 'NEW_PASSWORD_REQUIRED');
    if (refusal) return refusal;
    const password = body.ChallengeResponses.NEW_PASSWORD;
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) return refuse('InvalidPasswordException');
    sessions.delete(body.Session);
    setPassword(session.sub, password);
    directory.confirm(session.sub);
    return tokensFor(session.sub);
  }

  function verifyCode(body) {
    const { session, refusal } = step(body, 'SOFTWARE_TOKEN_MFA');
    if (refusal) return refusal;
    if (body.ChallengeResponses.SOFTWARE_TOKEN_MFA_CODE !== credentials.get(session.sub)?.code)
      return refuse('CodeMismatchException');
    sessions.delete(body.Session);
    return tokensFor(session.sub);
  }

  /** The customer an access token stands for, or a refusal. */
  function holder(body) {
    const held = tokens.get(body.AccessToken);
    if (!held || held.expiresAt <= now()) return { refusal: refuse('NotAuthorizedException', 'Invalid Access Token') };
    return { sub: held.sub };
  }

  const withToken = {
    GetUser(body) {
      const { sub, refusal } = holder(body);
      if (refusal) return refusal;
      const account = directory.bySub(sub);
      return ok({
        Username: sub,
        UserAttributes: [
          { Name: 'sub', Value: sub },
          { Name: 'email', Value: account?.email ?? '' },
          { Name: 'name', Value: account?.name ?? '' },
        ],
        UserMFASettingList: credentials.get(sub)?.authenticator ? ['SOFTWARE_TOKEN_MFA'] : [],
      });
    },
    ChangePassword(body) {
      const { sub, refusal } = holder(body);
      if (refusal) return refusal;
      const known = credentials.get(sub);
      const x = passwordNumber({ userPoolId, userId: sub, password: String(body.PreviousPassword), salt: known.salt });
      if (powMod(g, x, N) !== known.verifier)
        return refuse('NotAuthorizedException', 'Incorrect username or password.');
      if (typeof body.ProposedPassword !== 'string' || body.ProposedPassword.length < PASSWORD_MIN)
        return refuse('InvalidPasswordException');
      setPassword(sub, body.ProposedPassword);
      return ok({});
    },
    AssociateSoftwareToken(body) {
      const { sub, refusal } = holder(body);
      if (refusal) return refusal;
      const secret = [...randomBytes(32)].map((byte) => SECRET_ALPHABET[byte % 32]).join('');
      return ok({ SecretCode: secret });
    },
    VerifySoftwareToken(body) {
      const { sub, refusal } = holder(body);
      if (refusal) return refusal;
      const known = credentials.get(sub);
      if (body.UserCode !== known.fixedCode) return refuse('EnableSoftwareTokenMFAException', 'Code mismatch');
      known.code = known.fixedCode;
      return ok({ Status: 'SUCCESS' });
    },
    SetUserMFAPreference(body) {
      const { sub, refusal } = holder(body);
      if (refusal) return refusal;
      const known = credentials.get(sub);
      const enabled = body.SoftwareTokenMfaSettings?.Enabled === true;
      if (enabled && known.code === null)
        return refuse('InvalidParameterException', 'User has not verified software token mfa');
      known.authenticator = enabled;
      return ok({});
    },
  };

  function forgot(body) {
    const email = String(body.Username ?? '').toLowerCase();
    const account = directory.find(email);
    if (account && account.status === 'FORCE_CHANGE_PASSWORD') {
      return refuse('NotAuthorizedException', 'User password cannot be reset in the current state.');
    }
    if (account) resets.set(email, resetCode);
    // The same answer whether or not the address has an account.
    return ok({ CodeDeliveryDetails: { Destination: 'a***@e***', DeliveryMedium: 'EMAIL', AttributeName: 'email' } });
  }

  function confirmForgot(body) {
    const email = String(body.Username ?? '').toLowerCase();
    const account = directory.find(email);
    if (!account || resets.get(email) !== body.ConfirmationCode) return refuse('CodeMismatchException');
    if (typeof body.Password !== 'string' || body.Password.length < PASSWORD_MIN)
      return refuse('InvalidPasswordException');
    resets.delete(email);
    setPassword(account.sub, body.Password);
    return ok({});
  }

  function answer(operation, body) {
    calls.push({ operation, body });
    if (Object.hasOwn(withToken, operation)) return withToken[operation](body);
    if (body?.ClientId !== clientId) return refuse('ResourceNotFoundException', 'User pool client does not exist.');
    switch (operation) {
      case 'InitiateAuth':
        return initiate(body);
      case 'RespondToAuthChallenge':
        if (body.ChallengeName === 'PASSWORD_VERIFIER') return verifyPassword(body);
        if (body.ChallengeName === 'NEW_PASSWORD_REQUIRED') return newPassword(body);
        if (body.ChallengeName === 'SOFTWARE_TOKEN_MFA') return verifyCode(body);
        return refuse('InvalidParameterException');
      case 'RevokeToken':
        refreshTokens.delete(body.Token);
        return ok({});
      case 'ForgotPassword':
        return forgot(body);
      case 'ConfirmForgotPassword':
        return confirmForgot(body);
      default:
        return refuse('InvalidParameterException');
    }
  }

  return {
    calls,
    answer,
    /**
     * The password, and the code its authenticator will show, of an account of the directory. With
     * `authenticator`, sign-in asks for the code already.
     */
    addCredentials({ sub, password, code = '123456', authenticator = false }) {
      setPassword(sub, password);
      Object.assign(credentials.get(sub), { fixedCode: code, code: authenticator ? code : null, authenticator });
    },
    /** The customer an access token stands for, or null: what the customer authorizer checks. */
    session(accessToken) {
      const held = tokens.get(accessToken);
      return held && held.expiresAt > now() ? held : null;
    },
    refreshTokensLeft: () => refreshTokens.size,
    authenticatorOn: (sub) => credentials.get(sub)?.authenticator === true,
    /** The call as a browser makes it, to `${origin}/`, answered as fetch would be. */
    async fetch(origin, url, init = {}) {
      const target = /^AWSCognitoIdentityProviderService\.(\w+)$/.exec(init.headers?.['x-amz-target'] ?? '');
      if (url !== `${origin}/` || init.method !== 'POST' || !target) {
        return new Response(JSON.stringify({ __type: 'UnknownOperationException' }), { status: 400 });
      }
      const { status, body } = answer(target[1], JSON.parse(init.body));
      const headers = { 'content-type': 'application/x-amz-json-1.1' };
      if (status !== 200) headers['x-amzn-errortype'] = `${body.__type}:http://internal.amazon.com/coral/`;
      return new Response(JSON.stringify(body), { status, headers });
    },
  };
}
