/**
 * The console API's reader of Memfault's REST API (docs/memfault.md, "In the console"): what Memfault
 * knows of the boards, read on the server and handed to the console through our own API. The browser
 * never talks to Memfault, and nothing here ever writes to it: every request is a GET.
 *
 * createMemfaultReader(env, { fetch, readSecret }) reads AWS_REGION, MEMFAULT_TOKEN_SECRET_ARN,
 * MEMFAULT_ORG_SLUG and MEMFAULT_PROJECT_SLUG. Without the secret's ARN or either slug it calls nothing,
 * and every read says the reader is not configured.
 *
 *   memfaultGet(path, query) -> object   GET https://api.memfault.com/api/v0/organizations/<org>/projects/
 *                                        <project>/<path>?<query>, the answer's JSON. `path` is built by
 *                                        the handlers from checked values; `query` maps names to a string
 *                                        or a list of strings. A failure is thrown as MemfaultError.
 *
 * The credential is the organization auth token in the secret MemfaultOrgToken, which only the API
 * function may read. It is sent as HTTP Basic auth with an empty user name and the token as the password,
 * as Memfault's API takes it. A secret of the form "<e-mail>:<user API key>", the key of a Memfault user,
 * is sent as that user and password instead: a user with the Viewer role can read and never change
 * anything (docs/memfault.md recommends it). The value is read at most every TOKEN_CACHE_MS, and again at
 * once after Memfault refused it. It is never logged, never put in an error and never returned.
 *
 * MemfaultError has `code`:
 *   not_configured   no secret, no value in it, or no slugs
 *   refused          Memfault answered 401 or 403: the token is wrong, revoked, or may not read this
 *   not_found        Memfault answered 404
 *   limited          Memfault answered 429
 *   unreachable      no answer within GET_TIMEOUT_MS, a network failure, a 5xx, or an answer that is not
 *                    JSON
 *   failed           Secrets Manager could not be asked
 */

export const MEMFAULT_API = 'https://api.memfault.com';
// Several reads go out at once for one page; the API function has 16 s for a request.
export const GET_TIMEOUT_MS = 6000;
export const TOKEN_CACHE_MS = 5 * 60_000;
// An answer of Memfault's is a few kilobytes; a processing log page of 500 entries less than a megabyte.
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

const SECRET_ARN =
  /^arn:aws[a-z-]*:secretsmanager:[a-z]{2}(?:-[a-z]+)+-\d{1,2}:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
// A path below the project: words and checked values, never a dot segment, a query or a fragment.
const PATH = /^[a-z][a-z_-]{1,40}(?:\/[A-Za-z0-9][A-Za-z0-9_.+-]{0,127})*$/;
const QUERY_NAME = /^[a-z_]{1,32}(?:\[[a-z]{1,16}\])?$/;
const QUERY_VALUE = /^[A-Za-z0-9_.:+-]{1,128}$/;
// Whatever the token is, it is one line of printable text without a space.
const TOKEN = /^[\x21-\x7e]{8,512}$/;

/** A failure of a read of Memfault. Names neither the token nor the address. */
export function memfaultError(code, detail = '') {
  const error = new Error(`Memfault: ${code}${detail ? `: ${detail}` : ''}`);
  error.name = 'MemfaultError';
  error.code = code;
  return error;
}

function nameOf(cause) {
  return cause !== null && typeof cause === 'object' && typeof cause.name === 'string' ? cause.name : 'Error';
}

/** The Basic credentials for a token: an organization auth token as the password of no user. */
export function basicAuth(token) {
  const pair = token.includes(':') ? token : `:${token}`;
  return `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
}

/** The query string, from checked names and values; a list repeats its name. */
export function queryString(query = {}) {
  const parts = [];
  for (const [name, value] of Object.entries(query)) {
    if (!QUERY_NAME.test(name)) throw new TypeError(`Not a query name for Memfault: ${name}`);
    for (const one of Array.isArray(value) ? value : [value]) {
      if (typeof one !== 'string' || !QUERY_VALUE.test(one)) throw new TypeError(`Not a query value for ${name}`);
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(one)}`);
    }
  }
  return parts.join('&');
}

/** The secret's value through Secrets Manager, loaded only in Lambda: the tests pass readSecret. */
function secretsManagerReader(region, arn) {
  let client = null;
  let sdk = null;
  return async () => {
    sdk ??= await import('@aws-sdk/client-secrets-manager');
    client ??= new sdk.SecretsManagerClient({
      region,
      maxAttempts: 2,
      requestHandler: {
        connectionTimeout: 1000,
        socketTimeout: 3000,
        requestTimeout: 4000,
        throwOnRequestTimeout: true,
      },
    });
    try {
      const out = await client.send(new sdk.GetSecretValueCommand({ SecretId: arn }));
      return typeof out?.SecretString === 'string' ? out.SecretString : null;
    } catch (cause) {
      // The secret as the stack makes it: no version yet, so no value.
      if (nameOf(cause) === 'ResourceNotFoundException') return null;
      throw memfaultError('failed', `GetSecretValue: ${nameOf(cause)}`);
    }
  };
}

/**
 * @param {Record<string, string|undefined>} env  the API function's environment
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch]
 * @param {() => Promise<string|null>} [options.readSecret]  the token's secret value, or null
 * @param {() => number} [options.now]
 */
export function createMemfaultReader(
  env,
  { fetch: fetchJson = globalThis.fetch, readSecret = null, now = Date.now } = {}
) {
  const arn = env?.MEMFAULT_TOKEN_SECRET_ARN ?? '';
  const org = env?.MEMFAULT_ORG_SLUG ?? '';
  const project = env?.MEMFAULT_PROJECT_SLUG ?? '';
  if (arn !== '' && !SECRET_ARN.test(arn)) {
    throw new Error('Environment variable MEMFAULT_TOKEN_SECRET_ARN is malformed');
  }
  const configured = arn !== '' && SLUG.test(org) && SLUG.test(project);
  const secret = readSecret ?? (configured ? secretsManagerReader(env?.AWS_REGION, arn) : null);
  const base = `${MEMFAULT_API}/api/v0/organizations/${org}/projects/${project}/`;
  // { token, until }: the secret's value, and until when it is taken without asking again.
  let held = null;

  async function token() {
    if (held !== null && now() < held.until) return held.token;
    const value = (await secret())?.trim() ?? '';
    held = { token: TOKEN.test(value) ? value : null, until: now() + TOKEN_CACHE_MS };
    return held.token;
  }

  return Object.freeze({
    async memfaultGet(path, query = {}) {
      if (typeof path !== 'string' || !PATH.test(path) || path.split('/').some((part) => /^\.+$/.test(part))) {
        throw new TypeError('memfaultGet needs a path of the project');
      }
      const search = queryString(query);
      if (!configured) throw memfaultError('not_configured');
      const credential = await token();
      if (credential === null) throw memfaultError('not_configured');
      let response;
      try {
        response = await fetchJson(`${base}${path}${search ? `?${search}` : ''}`, {
          method: 'GET',
          headers: { Authorization: basicAuth(credential), Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(GET_TIMEOUT_MS),
        });
      } catch (cause) {
        throw memfaultError('unreachable', nameOf(cause));
      }
      const { status } = response;
      if (status === 401 || status === 403) {
        // Read the secret again next time: it may have been replaced.
        held = null;
        await response.arrayBuffer().catch(() => {});
        throw memfaultError('refused', String(status));
      }
      if (status === 404 || status === 429 || status < 200 || status > 299) {
        await response.arrayBuffer().catch(() => {});
        if (status === 404) throw memfaultError('not_found');
        if (status === 429) throw memfaultError('limited');
        throw memfaultError('unreachable', String(status));
      }
      let text;
      try {
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > MAX_ANSWER_BYTES) throw new Error('too large');
        text = Buffer.from(bytes).toString('utf8');
      } catch (cause) {
        throw memfaultError('unreachable', nameOf(cause));
      }
      try {
        const body = JSON.parse(text);
        if (body === null || typeof body !== 'object') throw new Error('not an object');
        return body;
      } catch {
        throw memfaultError('unreachable', 'not JSON');
      }
    },
  });
}
