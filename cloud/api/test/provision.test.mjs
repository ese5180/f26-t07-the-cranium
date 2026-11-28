// Tests for POST /api/devices/register (src/handlers/provision.mjs): provisioning through the console. Who
// may register a board, what is checked of the board's request, what AWS IoT is asked, what the board gets
// back, a board registered before, the limit per person, and what goes on record.

import assert from 'node:assert/strict';
import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { REGISTRATIONS_PER_HOUR } from '../src/handlers/provision.mjs';
import { AMAZON_ROOT_CA1, MAX_CSR_CHARS, parseCsr } from '../src/lib/provision.mjs';
import { accessClaims, createTestConsole } from './fake-aws.mjs';
import { boardKey, makeCsr } from './fake-provision.mjs';

const ID = 'fe5b26c0c5b1dcd7';
const THING = `cranium-${ID}`;
const PATH = '/api/devices/register';
const TOKEN_PATH = '/api/t/devices/register';

function world() {
  const console_ = createTestConsole();
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  const entries = () => console_.fake.auditLog().filter((entry) => entry.action === 'device.register');
  return { ...console_, manager, viewer, entries };
}

const spkiOf = (key) => key.publicKey.export({ format: 'der', type: 'spki' });

test("a board's request gets a certificate for its own key, with the root CA, the endpoint and the download prefix", async () => {
  const { call, manager, fake, entries } = world();
  const { pem, key } = makeCsr({ commonName: THING });
  const answer = await call('POST', PATH, { as: manager, body: { id: ID, csr: pem, reregister: false } });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(Object.keys(answer.body), ['thing', 'certificatePem', 'rootCa', 'endpoint', 'downloadPrefix']);
  assert.equal(answer.body.thing, THING);
  assert.equal(answer.body.rootCa, AMAZON_ROOT_CA1);
  assert.equal(answer.body.endpoint, 'a1b2c3d4e5f6g7-ats.iot.us-east-1.amazonaws.com');
  assert.equal(answer.body.downloadPrefix, 'https://local-firmware.s3.us-east-1.amazonaws.com/firmware/');
  // The certificate is for the board's key: the private key never came here.
  const certificate = new X509Certificate(answer.body.certificatePem);
  assert.ok(certificate.publicKey.export({ format: 'der', type: 'spki' }).equals(spkiOf(key)));
  assert.equal(JSON.stringify(answer.body).includes('PRIVATE KEY'), false);

  // The thing in the group, the certificate active with the device policy and attached to it alone.
  assert.ok((await fake.listGroupThings()).includes(THING));
  const [arn] = await fake.listThingPrincipals(THING);
  const [id, held] = Object.entries(fake.certificates())[0];
  assert.ok(arn.endsWith(`:cert/${id}`));
  assert.deepEqual(held.things, [THING]);
  assert.deepEqual([held.status, held.policy], ['ACTIVE', 'cranium-device']);
  assert.deepEqual(
    fake.methodsCalled().filter((method) => !['queryAudit', 'putAudit', 'getUser', 'listUserGroups'].includes(method)),
    [
      'describeThing',
      'listThingPrincipals',
      'createThing',
      'addThingToGroup',
      'createCertificateFromCsr',
      'attachDevicePolicy',
      'attachThingPrincipal',
      'describeDataEndpoint',
      'listGroupThings',
      'listThingPrincipals',
    ]
  );

  const [entry] = entries();
  assert.deepEqual([entry.outcome, entry.target, entry.actor.sub], ['ok', THING, manager.sub]);
  assert.deepEqual(entry.detail, { board: 'nrf7002dk', created: 'true', certificate: id.slice(0, 16), retired: '0' });
});

test('the same route takes an API token, and its entry names the token', async () => {
  const { call, manager, fake, entries } = world();
  const made = await call('POST', '/api/tokens', { as: manager, body: { name: 'bench', days: 30 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const answer = await call('POST', TOKEN_PATH, {
    token: made.body.token,
    body: { id: ID, csr: makeCsr({ commonName: THING }).pem },
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(entries()[0].detail.token, made.body.id);
  assert.equal(Object.keys(fake.certificates()).length, 1);
});

test('a board registered before is refused unless it is registered again, which retires its old certificate', async () => {
  const { call, manager, fake, entries } = world();
  const first = await call('POST', PATH, { as: manager, body: { id: ID, csr: makeCsr({ commonName: THING }).pem } });
  assert.equal(first.status, 200);
  const [oldId] = Object.keys(fake.certificates());

  // Wiped, with a new key: refused without reregister, and nothing changes.
  const again = makeCsr({ commonName: THING });
  const refused = await call('POST', PATH, { as: manager, body: { id: ID, csr: again.pem } });
  assert.deepEqual([refused.status, refused.body.error.code], [409, 'already_registered']);
  assert.match(refused.body.error.message, /"reregister": true/);
  assert.deepEqual(Object.keys(fake.certificates()), [oldId]);

  const answer = await call('POST', PATH, { as: manager, body: { id: ID, csr: again.pem, reregister: true } });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const ids = Object.keys(fake.certificates());
  assert.equal(ids.length, 1);
  assert.notEqual(ids[0], oldId);
  assert.equal((await fake.listThingPrincipals(THING)).length, 1);
  assert.deepEqual(
    entries().map((entry) => [entry.outcome, entry.detail.code ?? '', entry.detail.retired ?? '']),
    [
      ['ok', '', '0'],
      ['rejected', 'already_registered', ''],
      ['ok', '', '1'],
    ]
  );
  assert.equal(entries()[2].detail.reregister, 'true');
});

test("a viewer may not register a board; the apps' sign-in may, the desktop app's, after a fresh sign-in", async () => {
  const { call, viewer, manager, fake, entries, clock } = world();
  const csr = makeCsr({ commonName: THING }).pem;
  const refused = await call('POST', PATH, { as: viewer, body: { id: ID, csr } });
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'release_manager_required']);
  const app = (ageSeconds) =>
    accessClaims({
      sub: manager.sub,
      groups: ['release-managers'],
      clientId: 'localmobile',
      authTime: Math.floor(clock.ms / 1000) - ageSeconds,
    });
  const stale = await call('POST', PATH, { claims: app(3600), body: { id: ID, csr } });
  assert.deepEqual([stale.status, stale.body.error.code], [403, 'phone_sign_in_again']);
  assert.deepEqual(Object.keys(fake.certificates()), []);
  const fresh = await call('POST', PATH, { claims: app(60), body: { id: ID, csr } });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(Object.keys(fake.certificates()).length, 1);
  assert.deepEqual(
    entries().map((entry) => [entry.outcome, entry.detail.code ?? null]),
    [
      ['denied', 'release_manager_required'],
      ['denied', 'phone_sign_in_again'],
      ['ok', null],
    ]
  );
});

test('only an identifier of 16 lowercase hex digits, and only a request of that board, signed by its own key', async () => {
  const { call, manager, fake } = world();
  const good = makeCsr({ commonName: THING }).pem;
  const cases = [
    [{ id: 'FE5B26C0C5B1DCD7', csr: good }, 'invalid_id'],
    [{ id: THING, csr: good }, 'invalid_id'],
    [{ id: `${ID}0`, csr: good }, 'invalid_id'],
    [{ id: '../../etc', csr: good }, 'invalid_id'],
    [{ csr: good }, 'invalid_id'],
    [{ id: ID }, 'invalid_csr'],
    [{ id: ID, csr: 'not a request' }, 'invalid_csr'],
    [{ id: ID, csr: good.replace('BEGIN CERTIFICATE REQUEST', 'BEGIN CERTIFICATE') }, 'invalid_csr'],
    [{ id: ID, csr: `${good}${'A'.repeat(MAX_CSR_CHARS)}` }, 'invalid_csr'],
    // Signed by another key than the one it names: whoever sent it does not hold the board's key.
    [{ id: ID, csr: makeCsr({ commonName: THING, signer: boardKey().privateKey }).pem }, 'invalid_csr'],
    // Another algorithm than ECDSA with SHA-256.
    [
      { id: ID, csr: makeCsr({ commonName: THING, algorithm: [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03] }).pem },
      'invalid_csr',
    ],
    [{ id: ID, csr: makeCsr({ commonName: 'cranium-0123456789abcdef' }).pem }, 'csr_mismatch'],
    [{ id: ID, csr: makeCsr({ commonName: null }).pem }, 'csr_mismatch'],
    [{ id: ID, csr: good, reregister: 'yes' }, 'invalid_reregister'],
    [{ id: ID, csr: good, board: 'esp32' }, 'invalid_board'],
    [{ id: ID, csr: good, thing: THING }, 'unexpected_field'],
    [{ id: ID, board: 'nrf5340dk', csr: good }, 'unexpected_field'],
  ];
  for (const [body, code] of cases) {
    const answer = await call('POST', PATH, { as: manager, body });
    assert.deepEqual([answer.status, answer.body.error?.code], [400, code], JSON.stringify(body).slice(0, 120));
  }
  assert.equal(fake.methodsCalled().includes('createThing'), false);
});

test('the request is read in one spelling, and a changed byte breaks its signature', () => {
  assert.equal(parseCsr(undefined), null);
  assert.equal(parseCsr(42), null);
  const { pem } = makeCsr({ commonName: THING });
  const parsed = parseCsr(pem);
  assert.equal(parsed.commonName, THING);
  // One spelling: CRLF line ends and a missing final newline give the same request.
  assert.equal(parseCsr(pem.replace(/\n/g, '\r\n').trimEnd()).pem, parsed.pem);
  // A flipped bit of the signed part breaks the signature.
  const der = Buffer.from(pem.split('\n').slice(1, -2).join(''), 'base64');
  der[40] ^= 1;
  const broken = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64')}\n-----END CERTIFICATE REQUEST-----\n`;
  assert.equal(parseCsr(broken), null);
});

test('a certificate AWS IoT issued for another key is never handed on, nor attached, and is retired', async () => {
  const { call, manager, fake } = world();
  fake.misissueNext();
  const answer = await call('POST', PATH, { as: manager, body: { id: ID, csr: makeCsr({ commonName: THING }).pem } });
  assert.deepEqual([answer.status, answer.body.error.code], [502, 'certificate_mismatch']);
  assert.deepEqual(Object.keys(fake.certificates()), []);
  assert.deepEqual(await fake.listThingPrincipals(THING), []);
  assert.equal(fake.methodsCalled().includes('attachDevicePolicy'), false);
});

test('an nRF5340 DK gets a thing of its type in the group and no certificate; another type is refused', async () => {
  const { call, manager, fake, entries } = world();
  const answer = await call('POST', PATH, { as: manager, body: { id: ID, board: 'nrf5340dk' } });
  assert.deepEqual([answer.status, answer.body], [200, { thing: THING }]);
  assert.deepEqual(await fake.describeThing(THING), { attributes: { board: 'nrf5340dk' } });
  assert.ok((await fake.listGroupThings()).includes(THING));
  assert.deepEqual(Object.keys(fake.certificates()), []);
  // Again: the same, and the thing is kept.
  assert.equal((await call('POST', PATH, { as: manager, body: { id: ID, board: 'nrf5340dk' } })).status, 200);
  assert.deepEqual(
    entries().map((entry) => entry.detail),
    [
      { board: 'nrf5340dk', created: 'true' },
      { board: 'nrf5340dk', created: 'false' },
    ]
  );
  // An nRF7002 DK's request for the thing of an nRF5340 DK.
  const wrong = await call('POST', PATH, { as: manager, body: { id: ID, csr: makeCsr({ commonName: THING }).pem } });
  assert.deepEqual([wrong.status, wrong.body.error.code], [409, 'board_mismatch']);
});

test(`at most ${REGISTRATIONS_PER_HOUR} an hour a person, and one over that leaves no entry`, async () => {
  const { call, manager, entries, advance } = world();
  for (let index = 0; index < REGISTRATIONS_PER_HOUR; index += 1) {
    const id = createHash('sha256').update(String(index)).digest('hex').slice(0, 16);
    const answer = await call('POST', PATH, { as: manager, body: { id, board: 'nrf5340dk' } });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
  }
  const over = await call('POST', PATH, { as: manager, body: { id: ID, board: 'nrf5340dk' } });
  assert.deepEqual([over.status, over.body.error.code], [429, 'rate_limited']);
  assert.equal(entries().length, REGISTRATIONS_PER_HOUR);
  advance(61 * 60_000);
  assert.equal((await call('POST', PATH, { as: manager, body: { id: ID, board: 'nrf5340dk' } })).status, 200);
});

test('the root CA handed out is firmware/certs/AmazonRootCA1.pem, Amazon Root CA 1', () => {
  const file = readFileSync(new URL('../../../firmware/certs/AmazonRootCA1.pem', import.meta.url), 'utf8');
  assert.equal(AMAZON_ROOT_CA1, file);
  const der = new X509Certificate(AMAZON_ROOT_CA1).raw;
  assert.equal(
    createHash('sha256').update(der).digest('hex'),
    '8ecde6884f3d87b1125ba31ac3fcb13d7016de7f57cc904fe1cb97c6ae98196e'
  );
});
