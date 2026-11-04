// Presigned S3 URLs (src/lib/presign.mjs), held to AWS's own published example of Signature Version 4
// in the query string, and to what the Apps page's two kinds of URL need from it.

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';

import { presignUrl, uriEncode } from '../src/lib/presign.mjs';

// The example of "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)" in the
// Amazon S3 API reference: its credentials, its time, its object, and the signature it gives.
const EXAMPLE = Object.freeze({
  method: 'GET',
  host: 'examplebucket.s3.amazonaws.com',
  key: 'test.txt',
  region: 'us-east-1',
  credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  at: Date.UTC(2013, 4, 24, 0, 0, 0),
  expiresIn: 86400,
});

test('the URL of AWS\'s published example, to the character', () => {
  const { url, signedHeaders, expiresAt } = presignUrl(EXAMPLE);
  assert.equal(url, 'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
    '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z' +
    '&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
    '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.deepEqual(signedHeaders, ['host']);
  assert.equal(expiresAt, EXAMPLE.at + 86400 * 1000);
});

/** The signature worked out step by step as the reference describes it, for a URL that signs headers. */
function referenceSignature({ method, host, path, query, headers, secret, region, amzDate }) {
  const names = Object.keys(headers).sort();
  const canonical = [method, path, query, names.map((name) => `${name}:${headers[name]}\n`).join(''), names.join(';'),
    'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${amzDate.slice(0, 8)}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  let key = Buffer.from(`AWS4${secret}`);
  for (const part of [amzDate.slice(0, 8), region, 's3', 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
  return createHmac('sha256', key).update(toSign).digest('hex');
}

test('an upload URL signs the size and the SHA-256, and the session token goes in the query', () => {
  const checksum = createHash('sha256').update('apk').digest('base64');
  const { url, signedHeaders } = presignUrl({
    ...EXAMPLE,
    method: 'PUT',
    host: 'cranium-firmwarebucket-1.s3.us-east-1.amazonaws.com',
    key: 'apps/android/cranium-android-0.4.0.apk',
    credentials: { ...EXAMPLE.credentials, sessionToken: 'IQoJb3JpZ2lu/+=token' },
    expiresIn: 900,
    headers: { 'content-length': '12027314', 'x-amz-checksum-sha256': checksum },
  });
  assert.deepEqual(signedHeaders, ['content-length', 'host', 'x-amz-checksum-sha256']);
  const address = new URL(url);
  assert.equal(address.pathname, '/apps/android/cranium-android-0.4.0.apk');
  assert.equal(address.searchParams.get('X-Amz-Security-Token'), 'IQoJb3JpZ2lu/+=token');
  assert.equal(address.searchParams.get('X-Amz-SignedHeaders'), 'content-length;host;x-amz-checksum-sha256');
  // The token's "/", "+" and "=" are encoded in the URL.
  assert.match(url, /X-Amz-Security-Token=IQoJb3JpZ2lu%2F%2B%3Dtoken&/);
  const query = url.slice(url.indexOf('?') + 1, url.indexOf('&X-Amz-Signature='));
  assert.equal(address.searchParams.get('X-Amz-Signature'), referenceSignature({
    method: 'PUT', host: address.host, path: address.pathname, query, secret: EXAMPLE.credentials.secretAccessKey,
    region: 'us-east-1', amzDate: '20130524T000000Z',
    headers: { 'content-length': '12027314', host: address.host, 'x-amz-checksum-sha256': checksum },
  }));
});

test('a download URL names the version and how the file is to be served, all of it signed', () => {
  const { url } = presignUrl({
    ...EXAMPLE,
    query: {
      versionId: 'Ab.c_d-1', 'response-content-disposition': 'attachment; filename="cranium-android-0.4.0.apk"',
      'response-content-type': 'application/vnd.android.package-archive',
    },
  });
  const address = new URL(url);
  assert.equal(address.searchParams.get('response-content-disposition'), 'attachment; filename="cranium-android-0.4.0.apk"');
  // Sorted by name, as SigV4 asks: upper case before lower.
  const names = [...address.searchParams.keys()];
  assert.deepEqual(names.slice(0, -1), [...names.slice(0, -1)].sort());
  assert.equal(names.at(-1), 'X-Amz-Signature');
  assert.match(url, /response-content-disposition=attachment%3B%20filename%3D%22cranium-android-0\.4\.0\.apk%22/);
  // Change anything signed, and the signature changes with it.
  const other = presignUrl({ ...EXAMPLE, query: { versionId: 'Ab.c_d-2' } }).url;
  assert.notEqual(new URL(other).searchParams.get('X-Amz-Signature'), address.searchParams.get('X-Amz-Signature'));
});

test('what cannot be signed is refused, and encoding follows RFC 3986', () => {
  assert.throws(() => presignUrl({ ...EXAMPLE, method: 'DELETE' }), TypeError);
  assert.throws(() => presignUrl({ ...EXAMPLE, expiresIn: 0 }), TypeError);
  assert.throws(() => presignUrl({ ...EXAMPLE, expiresIn: 7 * 24 * 3600 + 1 }), TypeError);
  assert.throws(() => presignUrl({ ...EXAMPLE, credentials: {} }), /credentials/);
  assert.throws(() => presignUrl({ ...EXAMPLE, headers: { Host: 'x' } }), TypeError);
  assert.throws(() => presignUrl({ ...EXAMPLE, key: '/leading' }), TypeError);
  assert.equal(uriEncode("a b!'()*~._-/"), 'a%20b%21%27%28%29%2A~._-%2F');
});
