/**
 * A stand-in for Cognito's user pool API, as far as the console's own sign-in page uses
 * it: InitiateAuth with USER_SRP_AUTH, then RespondToAuthChallenge with PASSWORD_VERIFIER
 * and SOFTWARE_TOKEN_MFA. It plays the server's half of SRP, so that the tests can show
 * that what the browser sends is what Cognito would accept.
 *
 * It is written apart from the console's code (core.js) on purpose, so that the two do
 * not share a mistake. The prime comes from node:crypto's RFC 3526 group 15, the hashes,
 * the HMAC and the HKDF from node:crypto, and a number is turned into bytes the way Java
 * does it (BigInteger.toByteArray), which is what Cognito hashes: the browser writes hex
 * strings instead. The server's side of the exchange, as in RFC 5054 and Cognito:
 *
 *   v = g^x,   B = k*v + g^b,   u = H(A | B),   S = (A * v^u)^b,
 *   key = HKDF(S, salt = u, "Caldera Derived Key", 16 bytes),
 *   claim = HMAC(key, poolName | userId | secret block | timestamp), base64.
 *
 * Like a pool with PreventUserExistenceErrors, it answers an unknown address with a
 * challenge as usual and refuses the claim in the same words as a wrong password.
 *
 * The cloud/dev preview uses it too, behind HTTP. Nothing here is a test.
 */

import { createHash, createHmac, getDiffieHellman, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const N = BigInt(`0x${getDiffieHellman('modp15').getPrime('hex')}`);
export const g = 2n;
const INFO = 'Caldera Derived Key';
// How long the step of the code waits (AuthSessionValidity in infra/template.yaml), and
// how many wrong codes it takes.
const SESSION_MS = 15 * 60 * 1000;
const CODE_TRIES = 3;
// How far the time in a claim may be from the server's.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const TIMESTAMP =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12]\d|3[01]) (\d\d:\d\d:\d\d) UTC (\d{4})$/;

/** A number of 0 or more as Java's BigInteger.toByteArray() writes it: bitLength / 8 + 1 bytes. */
export function javaBytes(value) {
  const bits = value === 0n ? 0 : value.toString(2).length;
  const bytes = Buffer.alloc(Math.floor(bits / 8) + 1);
  let rest = value;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
}

const H = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const numberOf = (bytes) => BigInt(`0x${bytes.toString('hex') || '0'}`);

/** base^exponent mod modulus, left to right over the bits of the exponent. */
export function powMod(base, exponent, modulus) {
  let result = 1n;
  const reduced = base % modulus;
  for (const bit of exponent.toString(2)) {
    result = (result * result) % modulus;
    if (bit === '1') result = (result * reduced) % modulus;
  }
  return result;
}

export const k = numberOf(H(javaBytes(N), javaBytes(g)));

/** x: what the verifier is made of. Cognito keeps only v = g^x. */
export function passwordNumber({ userPoolId, userId, password, salt }) {
  const poolName = userPoolId.split('_')[1];
  return numberOf(H(javaBytes(salt), H(Buffer.from(`${poolName}${userId}:${password}`, 'utf8'))));
}

/** The claim Cognito expects, from its own side of the exchange. */
export function expectedClaim({ userPoolId, userId, verifier, A, b, B, secretBlock, timestamp }) {
  const u = numberOf(H(javaBytes(A), javaBytes(B)));
  const S = powMod((A * powMod(verifier, u, N)) % N, b, N);
  const key = Buffer.from(hkdfSync('sha256', javaBytes(S), javaBytes(u), INFO, 16));
  const poolName = userPoolId.split('_')[1];
  return createHmac('sha256', key)
    .update(
      Buffer.concat([
        Buffer.from(poolName, 'utf8'),
        Buffer.from(userId, 'utf8'),
        Buffer.from(secretBlock, 'base64'),
        Buffer.from(timestamp, 'utf8'),
      ])
    )
    .digest('base64');
}

/** The instant a claim's timestamp names, or NaN if it is not written as Cognito writes it. */
export function timestampAt(text) {
  const match = TIMESTAMP.exec(text);
  if (!match) return Number.NaN;
  const [, weekday, month, day, time, year] = match;
  const at = Date.parse(`${month} ${day}, ${year} ${time} UTC`);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[new Date(at).getUTCDay()] === weekday ? at : Number.NaN;
}

const MESSAGES = {
  NotAuthorizedException: 'Incorrect username or password.',
  CodeMismatchException: 'Invalid code received for user',
  InvalidParameterException: 'Invalid parameter.',
  ResourceNotFoundException: 'User pool client does not exist.',
};

/**
 * @param {object} options
 * @param {string} options.userPoolId
 * @param {string} options.clientId      the only app client it answers
 * @param {object[]} options.users        { email, userId, password, code, groups?, next?, salt? }:
 *                                        `next` is the challenge after the password,
 *                                        SOFTWARE_TOKEN_MFA unless it says otherwise
 * @param {() => number} [options.now]
 * @param {(user: object) => object} [options.issue]  the tokens of a sign-in that worked:
 *                                        { AccessToken, ExpiresIn, RefreshToken, IdToken }
 * @param {(operation: string, body: object) => string|null} [options.fail]  an error to
 *                                        answer with instead, by name
 */
export function createCognito({ userPoolId, clientId, users = [], now = Date.now, issue, fail = () => null }) {
  const calls = [];
  const accounts = new Map();
  for (const user of users) {
    const salt = user.salt ?? numberOf(randomBytes(16));
    const x = passwordNumber({ userPoolId, userId: user.userId, password: user.password, salt });
    accounts.set(user.email.toLowerCase(), { user, salt, verifier: powMod(g, x, N) });
  }
  // Secret block -> the server's half of an exchange; session -> the step of the code.
  const exchanges = new Map();
  const sessions = new Map();
  let issued = 0;

  const refuse = (name, message = MESSAGES[name] ?? name) => ({ status: 400, body: { __type: name, message } });
  const ok = (body) => ({ status: 200, body });
  const token = () => randomBytes(24).toString('base64url');

  function initiate(body) {
    if (body.AuthFlow !== 'USER_SRP_AUTH') {
      return refuse('InvalidParameterException', `${String(body.AuthFlow)} flow not enabled for this client`);
    }
    const { USERNAME: username, SRP_A: srpA } = body.AuthParameters ?? {};
    if (typeof username !== 'string' || typeof srpA !== 'string' || !/^[0-9a-f]+$/i.test(srpA)) {
      return refuse('InvalidParameterException');
    }
    const A = BigInt(`0x${srpA}`);
    if (A % N === 0n) return refuse('NotAuthorizedException');
    const account = accounts.get(username.toLowerCase()) ?? null;
    // An address nobody has gets a challenge that nothing can answer.
    const salt = account?.salt ?? numberOf(randomBytes(16));
    const verifier = account?.verifier ?? powMod(g, numberOf(randomBytes(32)), N);
    const userId = account?.user.userId ?? randomBytes(16).toString('hex');
    const b = numberOf(randomBytes(32));
    const B = (k * verifier + powMod(g, b, N)) % N;
    const secretBlock = randomBytes(96).toString('base64');
    exchanges.set(secretBlock, { account, userId, verifier, A, b, B });
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
    // An exchange is good for one answer.
    exchanges.delete(answer.PASSWORD_CLAIM_SECRET_BLOCK);
    if (!exchange) return refuse('NotAuthorizedException', 'Invalid session for the user.');
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

    const { user } = exchange.account;
    const session = token();
    sessions.set(session, { user, expiresAt: now() + SESSION_MS, tries: 0, step: user.next ?? 'SOFTWARE_TOKEN_MFA' });
    return ok({ ChallengeName: user.next ?? 'SOFTWARE_TOKEN_MFA', Session: session, ChallengeParameters: {} });
  }

  function verifyCode(body) {
    const session = sessions.get(body.Session);
    if (!session || session.step !== 'SOFTWARE_TOKEN_MFA' || session.expiresAt <= now()) {
      sessions.delete(body.Session);
      return refuse('NotAuthorizedException', 'Invalid session for the user, session is expired.');
    }
    const answer = body.ChallengeResponses ?? {};
    if (answer.USERNAME !== session.user.userId) return refuse('NotAuthorizedException');
    if (answer.SOFTWARE_TOKEN_MFA_CODE !== session.user.code) {
      session.tries += 1;
      if (session.tries >= CODE_TRIES) sessions.delete(body.Session);
      return refuse('CodeMismatchException');
    }
    sessions.delete(body.Session);
    issued += 1;
    const tokens = issue?.(session.user) ?? {
      AccessToken: `SRP-ACCESS-${issued}`,
      ExpiresIn: 3600,
      RefreshToken: `SRP-REFRESH-${issued}`,
      IdToken: `SRP-ID-${issued}`,
    };
    return ok({ AuthenticationResult: { TokenType: 'Bearer', ...tokens }, ChallengeParameters: {} });
  }

  /** One call: { status, body }, as Cognito answers it. */
  function answer(operation, body) {
    calls.push({ operation, body });
    const scripted = fail(operation, body);
    if (scripted) return refuse(scripted);
    if (body?.ClientId !== clientId) return refuse('ResourceNotFoundException');
    if (operation === 'InitiateAuth') return initiate(body);
    if (operation === 'RespondToAuthChallenge' && body.ChallengeName === 'PASSWORD_VERIFIER')
      return verifyPassword(body);
    if (operation === 'RespondToAuthChallenge' && body.ChallengeName === 'SOFTWARE_TOKEN_MFA') return verifyCode(body);
    return refuse('InvalidParameterException');
  }

  return {
    calls,
    answer,
    /** The call as a browser makes it, to `${origin}/`, answered as fetch would be. */
    async fetch(origin, url, init = {}) {
      const target = /^AWSCognitoIdentityProviderService\.(\w+)$/.exec(init.headers?.['x-amz-target'] ?? '');
      if (
        url !== `${origin}/` ||
        init.method !== 'POST' ||
        !target ||
        init.headers?.['content-type'] !== 'application/x-amz-json-1.1'
      ) {
        return new Response(JSON.stringify({ __type: 'UnknownOperationException' }), { status: 400 });
      }
      const { status, body } = answer(target[1], JSON.parse(init.body));
      const headers = { 'content-type': 'application/x-amz-json-1.1' };
      if (status !== 200) headers['x-amzn-errortype'] = `${body.__type}:http://internal.amazon.com/coral/`;
      return new Response(JSON.stringify(body), { status, headers });
    },
    /** How many steps of the code wait for one. */
    sessionsOpen: () => sessions.size,
  };
}
