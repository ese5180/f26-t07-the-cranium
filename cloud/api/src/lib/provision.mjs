/**
 * What provisioning through the console checks and hands out (handlers/provision.mjs).
 *
 * A board makes its own key pair, keeps the private key in TF-M, and prints a certificate signing
 * request (firmware/app/src/console_keys.c): ECDSA P-256, signed with SHA-256, subject CN=<thing>.
 * parseCsr() takes that request apart as far as the console needs to: the subject's common name,
 * the public key, and the request's own signature, which shows that whoever made it holds the
 * private key. Nothing else of it is used; AWS IoT reads it again when it issues the certificate.
 *
 * AMAZON_ROOT_CA1 is the root the boards trust for AWS IoT, the same bytes as
 * firmware/certs/AmazonRootCA1.pem (test/provision.test.mjs compares them).
 */

import { X509Certificate, createPublicKey, verify } from 'node:crypto';

export const AMAZON_ROOT_CA1 = `-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsF
ADA5MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6
b24gUm9vdCBDQSAxMB4XDTE1MDUyNjAwMDAwMFoXDTM4MDExNzAwMDAwMFowOTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJv
b3QgQ0EgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALJ4gHHKeNXj
ca9HgFB0fW7Y14h29Jlo91ghYPl0hAEvrAIthtOgQ3pOsqTQNroBvo3bSMgHFzZM
9O6II8c+6zf1tRn4SWiw3te5djgdYZ6k/oI2peVKVuRF4fn9tBb6dNqcmzU5L/qw
IFAGbHrQgLKm+a/sRxmPUDgH3KKHOVj4utWp+UhnMJbulHheb4mjUcAwhmahRWa6
VOujw5H5SNz/0egwLX0tdHA114gk957EWW67c4cX8jJGKLhD+rcdqsq08p8kDi1L
93FcXmn/6pUCyziKrlA4b9v7LWIbxcceVOF34GfID5yHI9Y/QCB/IIDEgEw+OyQm
jgSubJrIqg0CAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC
AYYwHQYDVR0OBBYEFIQYzIU07LwMlJQuCFmcx7IQTgoIMA0GCSqGSIb3DQEBCwUA
A4IBAQCY8jdaQZChGsV2USggNiMOruYou6r4lK5IpDB/G/wkjUu0yKGX9rbxenDI
U5PMCCjjmCXPI6T53iHTfIUJrU6adTrCC2qJeHZERxhlbI1Bjjt/msv0tadQ1wUs
N+gDS63pYaACbvXy8MWy7Vu33PqUXHeeE6V/Uq2V8viTO96LXFvKWlJbYK8U90vv
o/ufQJVtMVT8QtPHRh8jrdkPSHCa2XV4cdFyQzR1bldZwgJcJmApzyMZFo6IQ6XU
5MsI+yMRQ+hDKXJioaldXgjUkK642M4UwtBV8ob2xJNDd2ZhwLnoQdeXeGADbkpy
rqXRfboQnoZsG4q5WTP468SQvvG5
-----END CERTIFICATE-----
`;

// A request of a board is about 400 characters as PEM. Anything much larger is not one.
export const MAX_CSR_CHARS = 4096;
const CSR_PEM =
  /^-----BEGIN CERTIFICATE REQUEST-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n?-----END CERTIFICATE REQUEST-----\s*$/;
const CERT_PEM = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/;

// DER encodings of the object identifiers that matter here.
const OID_COMMON_NAME = Buffer.from([0x55, 0x04, 0x03]); // 2.5.4.3
const OID_ECDSA_SHA256 = Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]); // 1.2.840.10045.4.3.2

const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OID = 0x06;
const STRING_TAGS = new Set([0x0c, 0x13, 0x16]); // UTF8String, PrintableString, IA5String

class Malformed extends Error {}

/** One DER element at `offset`: { tag, at, start, end, next } (all of it from at, its content from start). */
function element(der, offset, limit = der.length) {
  if (offset + 2 > limit) throw new Malformed('short');
  const tag = der[offset];
  let length = der[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    if (bytes < 1 || bytes > 2 || start + bytes > limit) throw new Malformed('length');
    length = 0;
    for (let index = 0; index < bytes; index += 1) length = length * 256 + der[start + index];
    start += bytes;
  }
  const end = start + length;
  if (end > limit) throw new Malformed('overrun');
  return { tag, at: offset, start, end, next: end };
}

/** The elements inside a constructed one, in order. */
function children(der, parent) {
  const found = [];
  let offset = parent.start;
  while (offset < parent.end) {
    const child = element(der, offset, parent.end);
    found.push(child);
    offset = child.next;
  }
  return found;
}

function expect(item, tag) {
  if (item === undefined || item.tag !== tag) throw new Malformed(`tag ${tag}`);
  return item;
}

/** The common name in a Name, or null when it has none or more than one. */
function commonName(der, name) {
  const names = [];
  for (const set of children(der, expect(name, SEQUENCE))) {
    for (const pair of children(der, expect(set, SET))) {
      const [type, value] = children(der, expect(pair, SEQUENCE));
      expect(type, OID);
      if (!der.subarray(type.start, type.end).equals(OID_COMMON_NAME)) continue;
      if (value === undefined || !STRING_TAGS.has(value.tag)) throw new Malformed('common name');
      names.push(der.subarray(value.start, value.end).toString('utf8'));
    }
  }
  return names.length === 1 ? names[0] : null;
}

/**
 * A board's certificate signing request, checked. Returns { pem, commonName, publicKey } with the
 * request in one canonical spelling and its public key as DER (SubjectPublicKeyInfo), or null when
 * it is not a well-formed request of an ECDSA P-256 key, signed with SHA-256 by that key.
 */
export function parseCsr(text) {
  if (typeof text !== 'string' || text.length > MAX_CSR_CHARS) return null;
  const match = CSR_PEM.exec(text);
  if (!match) return null;
  const base64 = match[1].replace(/[\r\n]/g, '');
  const der = Buffer.from(base64, 'base64');
  if (der.length === 0 || der.toString('base64') !== base64) return null;
  try {
    const outer = expect(element(der, 0), SEQUENCE);
    if (outer.end !== der.length) return null;
    const [info, algorithm, signature, extra] = children(der, outer);
    if (extra !== undefined) return null;
    const [version, subject, keyInfo, attributes] = children(der, expect(info, SEQUENCE));
    expect(version, INTEGER);
    if (version.end - version.start !== 1 || der[version.start] !== 0) return null;
    if (attributes === undefined || attributes.tag !== 0xa0) return null;
    const name = commonName(der, subject);
    expect(keyInfo, SEQUENCE);
    const [algorithmId] = children(der, expect(algorithm, SEQUENCE));
    expect(algorithmId, OID);
    if (!der.subarray(algorithmId.start, algorithmId.end).equals(OID_ECDSA_SHA256)) return null;
    expect(signature, BIT_STRING);
    if (signature.end - signature.start < 2 || der[signature.start] !== 0) return null;

    const publicKey = der.subarray(keyInfo.at, keyInfo.end);
    const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
    const signed = der.subarray(info.at, info.end);
    const proof = der.subarray(signature.start + 1, signature.end);
    if (!verify('sha256', signed, key, proof)) return null;
    const lines = base64.match(/.{1,64}/g).join('\n');
    return {
      pem: `-----BEGIN CERTIFICATE REQUEST-----\n${lines}\n-----END CERTIFICATE REQUEST-----\n`,
      commonName: name,
      publicKey: key.export({ format: 'der', type: 'spki' }),
    };
  } catch {
    return null;
  }
}

/**
 * Whether AWS IoT's answer is one certificate, for the given public key (DER SubjectPublicKeyInfo).
 * Returns its PEM text, or null.
 */
export function certificateFor(pem, publicKey) {
  if (typeof pem !== 'string' || pem.length > 8192 || !CERT_PEM.test(pem)) return null;
  try {
    const certificate = new X509Certificate(pem);
    const issued = certificate.publicKey.export({ format: 'der', type: 'spki' });
    return issued.equals(publicKey) ? certificate.toString() : null;
  } catch {
    return null;
  }
}
