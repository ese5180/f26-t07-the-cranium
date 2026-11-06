/**
 * Presigned S3 URLs, signed here with AWS Signature Version 4 in the query string
 * (docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html).
 *
 * The console hands out two kinds, both for the Android app's APK (handlers/apps.mjs): a PUT that
 * a release manager's build sends the file with, and a GET that a person downloads it with. The
 * SDK's presigner is not used: the Lambda runtime does not promise it, and this is the whole of
 * what the console needs, checked against AWS's own published example (test/presign.test.mjs).
 *
 * A header named in `headers` is signed: the request must send it with exactly that value, or
 * S3 refuses it (403 SignatureDoesNotMatch). That is how a PUT is held to one size and one
 * SHA-256: content-length and x-amz-checksum-sha256 are signed, and S3 also checks the bytes it
 * receives against that checksum (400 BadDigest). The payload itself is not signed
 * (UNSIGNED-PAYLOAD), as with every presigned URL.
 *
 * The credentials are those of the function's role, which Lambda gives it in its environment.
 * A URL is good until it expires or those credentials do, whichever is first.
 *
 * No dependencies: only node:crypto.
 */

import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const UNSIGNED = 'UNSIGNED-PAYLOAD';
// What S3 accepts for X-Amz-Expires: one second to seven days.
const MAX_EXPIRES = 7 * 24 * 3600;
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;

/** RFC 3986 percent-encoding, as SigV4 asks for: everything but A-Z a-z 0-9 - . _ ~ */
export function uriEncode(text) {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function hmac(key, text) {
  return createHmac('sha256', key).update(text, 'utf8').digest();
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 20130524T000000Z and 20130524, from epoch milliseconds. */
function stamps(ms) {
  const iso = new Date(ms).toISOString();
  const amzDate = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return { amzDate, date: amzDate.slice(0, 8) };
}

/**
 * The canonical query string: every name and value encoded, sorted by the encoded name.
 * `pairs` is [[name, value], ...] with no name twice.
 */
function canonicalQuery(pairs) {
  return pairs
    .map(([name, value]) => [uriEncode(name), uriEncode(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/**
 * A presigned URL.
 *
 * @param {object} request
 * @param {'GET'|'PUT'|'HEAD'} request.method
 * @param {string} request.host            where the request goes: <bucket>.s3.<region>.amazonaws.com
 * @param {string} [request.protocol]      'https' (the default); 'http' only for a stand-in on this computer
 * @param {string} [request.pathPrefix]    path before the key, '' for AWS; the stand-in's own prefix
 * @param {string} request.key             the S3 key, unencoded, with "/" between its parts
 * @param {string} request.region
 * @param {{accessKeyId: string, secretAccessKey: string, sessionToken?: string}} request.credentials
 * @param {number} request.at              epoch milliseconds: when it is signed
 * @param {number} request.expiresIn       seconds it stays good for
 * @param {Record<string, string>} [request.headers]  lower-case header name -> value, signed beside host
 * @param {Record<string, string>} [request.query]    more query parameters, signed as well
 * @returns {{ url: string, signedHeaders: string[], expiresAt: number }}
 */
export function presignUrl({
  method,
  host,
  protocol = 'https',
  pathPrefix = '',
  key,
  region,
  credentials,
  at,
  expiresIn,
  headers = {},
  query = {},
}) {
  if (!['GET', 'PUT', 'HEAD'].includes(method)) throw new TypeError('method must be GET, PUT or HEAD');
  if (typeof host !== 'string' || !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(host))
    throw new TypeError('host is not a host name');
  if (protocol !== 'https' && protocol !== 'http') throw new TypeError('protocol must be https or http');
  if (typeof key !== 'string' || key === '' || key.startsWith('/')) throw new TypeError('key must be an S3 key');
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_EXPIRES) {
    throw new TypeError('expiresIn must be 1 to 604800 seconds');
  }
  if (!Number.isFinite(at)) throw new TypeError('at must be epoch milliseconds');
  const { accessKeyId, secretAccessKey, sessionToken } = credentials ?? {};
  if (
    typeof accessKeyId !== 'string' ||
    accessKeyId === '' ||
    typeof secretAccessKey !== 'string' ||
    secretAccessKey === ''
  ) {
    throw new TypeError('credentials are missing');
  }
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || name === 'host' || typeof value !== 'string') {
      throw new TypeError(`header ${name} cannot be signed`);
    }
  }

  const { amzDate, date } = stamps(at);
  const scope = `${date}/${region}/${SERVICE}/aws4_request`;
  const signed = { host, ...headers };
  const signedHeaders = Object.keys(signed).sort();
  const pairs = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresIn)],
    ['X-Amz-SignedHeaders', signedHeaders.join(';')],
  ];
  if (typeof sessionToken === 'string' && sessionToken !== '') pairs.push(['X-Amz-Security-Token', sessionToken]);
  for (const [name, value] of Object.entries(query)) pairs.push([name, String(value)]);

  // S3 takes the path as it is, each part encoded once: a key's "/" stays a "/".
  const path = `${pathPrefix}/${key.split('/').map(uriEncode).join('/')}`;
  const queryText = canonicalQuery(pairs);
  const canonicalHeaders = signedHeaders.map((name) => `${name}:${String(signed[name]).trim()}\n`).join('');
  const canonicalRequest = [method, path, queryText, canonicalHeaders, signedHeaders.join(';'), UNSIGNED].join('\n');
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), SERVICE), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  return {
    url: `${protocol}://${host}${path}?${queryText}&X-Amz-Signature=${signature}`,
    signedHeaders,
    expiresAt: at + expiresIn * 1000,
  };
}
