// What provisioning through the console needs of a test (src/handlers/provision.mjs): a board's certificate
// signing request, made as the firmware makes it (ECDSA P-256, SHA-256, CN=<thing>), and a certificate as
// AWS IoT issues one for such a request, signed by a stand-in CA. Both are DER built by hand: Node can read
// certificates but makes neither. test/fake-aws.mjs issues its certificates with issueCertificate.
//
// This file is test and preview code. It is never packaged with the function.

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';

const OID_COMMON_NAME = [0x55, 0x04, 0x03];
const OID_ECDSA_SHA256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];

function length(count) {
  if (count < 0x80) return [count];
  if (count < 0x100) return [0x81, count];
  return [0x82, count >> 8, count & 0xff];
}

/** One DER element: its tag, then its content (Buffers or byte arrays). */
export function der(tag, ...parts) {
  const content = Buffer.concat(parts.map((part) => Buffer.from(part)));
  return Buffer.concat([Buffer.from([tag, ...length(content.length)]), content]);
}

const sequence = (...parts) => der(0x30, ...parts);

/** A Name with one common name, or an empty one. */
export function nameOf(commonName) {
  if (commonName === null) return sequence();
  return sequence(der(0x31, sequence(der(0x06, OID_COMMON_NAME), der(0x0c, Buffer.from(commonName, 'utf8')))));
}

function signatureAlgorithm() {
  return sequence(der(0x06, OID_ECDSA_SHA256));
}

function pem(label, bytes) {
  const lines = bytes
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

/** A key pair as a board makes one: ECDSA P-256. */
export function boardKey() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

/**
 * A certificate signing request as a board prints it. `signer` signs it in place of the key it names
 * (a request whose sender does not hold the key), and `commonName` may be null for none.
 */
export function makeCsr({ commonName, key = boardKey(), signer = key.privateKey, algorithm = OID_ECDSA_SHA256 }) {
  const spki = key.publicKey.export({ format: 'der', type: 'spki' });
  const info = sequence(der(0x02, [0]), nameOf(commonName), spki, der(0xa0));
  const signature = sign('sha256', info, signer);
  const request = sequence(info, sequence(der(0x06, algorithm)), der(0x03, [0], signature));
  return { pem: pem('CERTIFICATE REQUEST', request), key };
}

// The stand-in for AWS IoT's CA, one for the whole run.
const authority = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

function utcTime(ms) {
  const text = new Date(ms).toISOString().replace(/[-:T]/g, '').slice(2, 14);
  return der(0x17, Buffer.from(`${text}Z`, 'ascii'));
}

/** A certificate for a public key (DER SubjectPublicKeyInfo), as AWS IoT issues one: PEM text. */
export function issueCertificate(publicKey, { serial = 1, at = Date.UTC(2026, 9, 1) } = {}) {
  const tbs = sequence(
    der(0xa0, der(0x02, [2])),
    der(0x02, [0x01, (serial >> 16) & 0xff, (serial >> 8) & 0xff, serial & 0xff]),
    signatureAlgorithm(),
    nameOf('Stand-in for AWS IoT'),
    sequence(utcTime(at), utcTime(at + 30 * 365 * 86_400_000)),
    nameOf('AWS IoT Certificate'),
    publicKey
  );
  const signature = sign(
    'sha256',
    tbs,
    createPrivateKey(authority.privateKey.export({ format: 'pem', type: 'pkcs8' }))
  );
  return pem('CERTIFICATE', sequence(tbs, signatureAlgorithm(), der(0x03, [0], signature)));
}
