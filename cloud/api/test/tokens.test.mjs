// Tests for personal API tokens: made and ended on the website by their owner, used on
// /api/t/ in their owner's name, with that owner's standing asked of Cognito on every
// request. What is stored is a digest; what is logged is an id.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  MAX_ACTIVE_TOKENS, bearerToken, newToken, presentToken, sameDigest, tokenDigest, tokenFromItem, tokenStatus,
} from '../src/lib/tokens.mjs';
import { accessClaims, createTestConsole, fixture } from './fake-aws.mjs';

const BOARD = 'cranium-00000000000000aa';
const DAY = 24 * 60 * 60 * 1000;
const upload = () => ({ filename: 'zephyr.signed.bin', data: fixture('valid-1.2.3+4.signed.bin').toString('base64') });

function setup() {
  const console_ = createTestConsole();
  console_.fake.addThing(BOARD);
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  /** Make a token on the website, as `who`, and return the answer's body. */
  const make = async (who, body = { name: 'laptop' }) => {
    const response = await console_.call('POST', '/api/tokens', { as: who, body });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  };
  return { ...console_, manager, viewer, make };
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

test('a token is crn_ and 32 random bytes in base64url, and only that spelling of it counts', () => {
  const token = newToken();
  assert.match(token, /^crn_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newToken(), token);
  assert.equal(bearerToken(`Bearer ${token}`), token);
  assert.equal(tokenDigest(token), sha256(token));

  const body = token.slice(4);
  // The last character carries two bits that 32 bytes do not fill. B, C and D set them, so
  // they decode to bytes that encode back to another spelling.
  const last = 'BCD'.split('').map((c) => `crn_${body.slice(0, -1)}${c}`);
  for (const header of [
    token, `bearer ${token}`, `BEARER ${token}`, `Bearer  ${token}`, ` Bearer ${token}`, `Bearer ${token} `,
    `Bearer ${token}\n`, `Bearer ${token}=`, `Bearer ${token.slice(0, -1)}`, `Bearer ${token}A`,
    `Bearer crn-${body}`, `Bearer CRN_${body}`, `Bearer ${token},Bearer ${token}`, `Bearer crn_${body.replace(/./, '+')}`,
    `Basic ${token}`, 'Bearer ', '', null, undefined, 42, [`Bearer ${token}`],
  ]) {
    assert.equal(bearerToken(header), null, String(header).slice(0, 20));
  }
  for (const candidate of last) {
    assert.equal(Buffer.from(candidate.slice(4), 'base64url').length, 32);
    assert.equal(bearerToken(`Bearer ${candidate}`), null);
  }

  assert.equal(sameDigest(sha256('a'), sha256('a')), true);
  assert.equal(sameDigest(sha256('a'), sha256('b')), false);
  for (const odd of ['', 'x', sha256('a').toUpperCase(), null, 5]) assert.equal(sameDigest(odd, sha256('a')), false);
});

test('a stored item is a token only if every field is what this console writes', () => {
  const item = {
    pk: 'TOK', sk: sha256('x'), id: '0123456789abcdef', ownerSub: 'abc', name: 'laptop',
    createdAt: '2026-10-10T22:15:00.000Z', expiresAt: '2026-11-09T22:15:00.000Z', revokedAt: null,
  };
  const token = tokenFromItem(item);
  assert.equal(token.digest, item.sk);
  assert.deepEqual(presentToken(token, Date.parse('2026-10-11T00:00:00Z')), {
    id: '0123456789abcdef', name: 'laptop', createdAt: item.createdAt, expiresAt: item.expiresAt, revokedAt: null,
    status: 'active',
  });
  assert.equal(tokenStatus(token, Date.parse(item.expiresAt)), 'expired');
  assert.equal(tokenStatus({ ...token, revokedAt: item.createdAt }, 0), 'revoked');
  assert.equal(tokenStatus({ ...token, expiresAt: 'soon' }, 0), 'expired');
  for (const change of [{ sk: 'x' }, { id: 'XYZ' }, { ownerSub: '' }, { name: '' }, { name: 'a\nb' }, { name: 'x'.repeat(41) },
    { createdAt: 'yesterday' }, { expiresAt: 5 }, { revokedAt: 'now' }, { revokedAt: undefined }]) {
    assert.equal(tokenFromItem({ ...item, ...change }), null, JSON.stringify(change));
  }
  assert.equal(tokenFromItem(null), null);
});

test('any member makes a token on the website; it is shown once and only its digest is stored', async () => {
  const context = setup();
  const { fake, clock, viewer, manager, make, call } = context;

  const made = await make(viewer, { name: '  CI on my laptop  ', days: 7 });
  assert.deepEqual(Object.keys(made), ['token', 'id', 'name', 'createdAt', 'expiresAt']);
  assert.match(made.token, /^crn_[A-Za-z0-9_-]{43}$/);
  assert.match(made.id, /^[0-9a-f]{16}$/);
  assert.equal(made.name, 'CI on my laptop');
  assert.equal(made.createdAt, new Date(clock.ms).toISOString());
  assert.equal(made.expiresAt, new Date(clock.ms + 7 * DAY).toISOString());
  // Thirty days unless asked otherwise.
  const plain = await make(manager);
  assert.equal(Date.parse(plain.expiresAt) - Date.parse(plain.createdAt), 30 * DAY);

  // At rest: the digest as the key, and the token nowhere.
  assert.deepEqual([...fake.tokens.keys()].sort(), [sha256(made.token), sha256(plain.token)].sort());
  const stored = JSON.stringify([...fake.tokens.values()]);
  for (const secret of [made.token, plain.token, made.token.slice(4), plain.token.slice(4)]) {
    assert.equal(stored.includes(secret), false);
  }
  assert.deepEqual(fake.tokens.get(sha256(made.token)), {
    pk: 'TOK', sk: sha256(made.token), id: made.id, ownerSub: viewer.sub, name: 'CI on my laptop',
    createdAt: made.createdAt, expiresAt: made.expiresAt, revokedAt: null,
  });

  // The list is the caller's own, without the token or its digest, ever.
  const listed = await call('GET', '/api/tokens', { as: viewer });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, {
    tokens: [{ id: made.id, name: 'CI on my laptop', createdAt: made.createdAt, expiresAt: made.expiresAt, revokedAt: null, status: 'active' }],
    limit: 10,
    maxDays: 90,
  });
  const text = JSON.stringify((await call('GET', '/api/tokens', { as: manager })).body);
  for (const secret of [plain.token, sha256(plain.token), made.id]) assert.equal(text.includes(secret), false);

  // Both are on record, and the token is not.
  const entries = fake.auditLog();
  assert.deepEqual(entries.map((entry) => [entry.action, entry.outcome, entry.target, entry.actor.sub, entry.detail]), [
    ['token.create', 'ok', made.id, viewer.sub, { name: 'CI on my laptop', days: '7' }],
    ['token.create', 'ok', plain.id, manager.sub, { name: 'laptop', days: '30' }],
  ]);
  assert.equal(JSON.stringify(entries).includes(made.token.slice(4)), false);
});

test('a token\'s name and lifetime are checked, and a refusal goes on record', async () => {
  const { call, manager, fake } = setup();
  const cases = [
    [{}, 'invalid_token_name'], [{ name: '' }, 'invalid_token_name'], [{ name: '   ' }, 'invalid_token_name'],
    [{ name: 'x'.repeat(41) }, 'invalid_token_name'], [{ name: 'a\u0000b' }, 'invalid_token_name'], [{ name: 5 }, 'invalid_token_name'],
    [{ name: 'ok', days: 0 }, 'invalid_days'], [{ name: 'ok', days: 91 }, 'invalid_days'], [{ name: 'ok', days: 1.5 }, 'invalid_days'],
    [{ name: 'ok', days: '30' }, 'invalid_days'], [{ name: 'ok', days: null }, 'invalid_days'],
  ];
  for (const [body, code] of cases) {
    const response = await call('POST', '/api/tokens', { as: manager, body });
    assert.deepEqual([response.status, response.body.error.code], [400, code], JSON.stringify(body));
  }
  assert.equal(fake.tokens.size, 0);
  assert.equal(fake.auditLog().length, cases.length);
  assert.ok(fake.auditLog().every((entry) => entry.action === 'token.create' && entry.outcome === 'rejected'));
  // The longest name and the longest life are fine.
  assert.equal((await call('POST', '/api/tokens', { as: manager, body: { name: 'x'.repeat(40), days: 90 } })).status, 201);
  assert.equal((await call('POST', '/api/tokens', { as: manager, body: { name: 'y', days: 1 } })).status, 201);
});

test('only an active member of the console, asked of Cognito now, makes a token', async () => {
  const context = setup();
  const { call, fake, addUser } = context;
  const outsider = addUser('outsider', []);
  const demoted = addUser('demoted', [], { tokenGroups: ['viewers'] });
  const disabled = addUser('disabled', ['viewers'], { enabled: false });
  for (const [who, status, code] of [[outsider, 403, 'forbidden'], [demoted, 403, 'forbidden'],
    [disabled, 403, 'account_inactive'], [null, 401, 'unauthorized']]) {
    const response = await call('POST', '/api/tokens', { as: who ?? undefined, body: { name: 'x' } });
    assert.deepEqual([response.status, response.body.error.code], [status, code]);
  }
  assert.equal(fake.tokens.size, 0);
  assert.deepEqual(fake.auditLog().map((entry) => [entry.action, entry.outcome]),
    Array(4).fill(['token.create', 'denied']));
});

test('a request to /api/t/ is the request to /api/, made with the token in its owner\'s name', async () => {
  const context = setup();
  const { call, fake, manager, viewer, make } = context;
  const { token, id } = await make(manager);
  await call('POST', '/api/firmware', { as: manager, body: upload() });

  for (const path of ['/api/firmware', '/api/devices', `/api/devices/${BOARD}`, '/api/deployments', '/api/audit',
    '/api/firmware/1.2.3+4']) {
    const bySession = await call('GET', path, { as: viewer });
    const byToken = await call('GET', path.replace('/api/', '/api/t/'), { token });
    assert.equal(byToken.status, 200, path);
    assert.deepEqual(byToken.body, bySession.body, path);
  }
  const me = await call('GET', '/api/t/me', { token });
  assert.deepEqual(me.body, {
    sub: manager.sub, email: manager.email, groups: ['release-managers'], canWrite: true,
    expiresAt: Math.floor(Date.parse(fake.tokens.get(sha256(token)).expiresAt) / 1000),
  });

  const before = fake.auditLog().length;
  const created = await call('POST', '/api/t/deployments', { token, body: { version: '1.2.3+4', things: [BOARD] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const [entry] = fake.auditLog().slice(before);
  assert.deepEqual([entry.action, entry.outcome, entry.actor], ['deployment.create', 'ok', { sub: manager.sub, email: manager.email }]);
  assert.equal(entry.detail.token, id);
  // The token is the first detail, so that it is never the one cut off.
  assert.equal(Object.keys(entry.detail)[0], 'token');

  const cancelled = await call('POST', `/api/t/deployments/${created.body.deployment.id}/cancel`, { token, body: { force: true } });
  assert.equal(cancelled.status, 200);
  assert.equal(fake.auditLog().at(-1).detail.token, id);

  // Not found is not found, with a token as without.
  for (const path of ['/api/t/', '/api/t/nothing', '/api/t/firmware/1.2.3+4/extra']) {
    const response = await call('GET', path, { token });
    assert.deepEqual([response.status, response.body.error.code], [404, 'not_found'], path);
  }
});

test('a viewer\'s token reads and never writes, and the attempt goes on record', async () => {
  const { call, fake, viewer, make } = setup();
  const { token, id } = await make(viewer);
  assert.equal((await call('GET', '/api/t/firmware', { token })).status, 200);
  const before = fake.auditLog().length;
  for (const [path, body, action] of [['/api/t/firmware', upload(), 'firmware.upload'],
    ['/api/t/deployments', { version: '1.2.3+4', things: [BOARD] }, 'deployment.create'],
    ['/api/t/firmware/1.2.3+4/image', undefined, 'firmware.download']]) {
    const method = action === 'firmware.download' ? 'GET' : 'POST';
    const response = await call(method, path, { token, body });
    assert.deepEqual([response.status, response.body.error?.code], [403, 'release_manager_required'], path);
    const entry = fake.auditLog().at(-1);
    assert.deepEqual([entry.action, entry.outcome, entry.actor.sub, entry.detail.token, entry.detail.code],
      [action, 'denied', viewer.sub, id, 'release_manager_required']);
  }
  assert.equal(fake.auditLog().length, before + 3);
  assert.equal(fake.releases.size, 0);
});

test('demoting, disabling or removing the owner takes the token\'s power away at once', async () => {
  const context = setup();
  const { call, fake, manager, make } = context;
  const { token } = await make(manager);
  const write = () => call('POST', '/api/t/firmware', { token, body: upload() });
  const read = () => call('GET', '/api/t/firmware', { token });

  fake.user(manager.sub).setGroups(['viewers']);
  assert.deepEqual([(await write()).status, (await write()).body.error.code], [403, 'release_manager_required']);
  assert.equal((await read()).status, 200);
  assert.equal((await call('GET', '/api/t/me', { token })).body.canWrite, false);

  fake.user(manager.sub).setGroups([]);
  assert.deepEqual([(await read()).status, (await read()).body.error.code], [403, 'forbidden']);

  fake.user(manager.sub).setGroups(['release-managers']);
  assert.equal((await write()).status, 201);

  fake.user(manager.sub).disable();
  assert.deepEqual([(await read()).status, (await read()).body.error.code], [403, 'account_inactive']);
  fake.user(manager.sub).enable();
  assert.equal((await read()).status, 200);
  fake.user(manager.sub).remove();
  assert.deepEqual([(await read()).status, (await read()).body.error.code], [403, 'account_inactive']);
});

test('every use of a token asks Cognito, and no answer is no access', async () => {
  const { call, fake, manager, make } = setup();
  const { token } = await make(manager);
  const mark = fake.calls.length;
  await call('GET', '/api/t/devices', { token });
  await call('GET', '/api/t/devices', { token });
  assert.deepEqual(fake.methodsCalled().slice(mark).filter((name) => ['getToken', 'getUser', 'listUserGroups'].includes(name)),
    ['getToken', 'getUser', 'listUserGroups', 'getToken', 'getUser', 'listUserGroups']);

  // A session's read goes on through a Cognito outage; a token's does not.
  fake.failNext('getUser');
  const refused = await call('GET', '/api/t/devices', { token });
  assert.equal(refused.status, 500);
  fake.failNext('getToken', { code: 'throttled' });
  assert.equal((await call('GET', '/api/t/devices', { token })).status, 429);
});

test('a token stops working when it expires', async () => {
  const context = setup();
  const { call, fake, manager, make } = context;
  const { token, id } = await make(manager, { name: 'short', days: 1 });
  context.advance(DAY - 1000);
  assert.equal((await call('GET', '/api/t/devices', { token })).status, 200);
  context.advance(1000);
  const response = await call('GET', '/api/t/devices', { token });
  assert.deepEqual([response.status, response.body.error.code], [401, 'invalid_token']);
  const listed = await call('GET', '/api/tokens', { as: manager });
  assert.equal(listed.body.tokens[0].status, 'expired');

  // A write with it gets the same answer, and leaves no entry: an expired token names nobody
  // any more. The log line says which token it was, and that it had expired.
  const { logs } = context;
  const before = fake.auditLog().length;
  const mark = fake.calls.length;
  const write = await call('POST', '/api/t/firmware', { token, body: upload(), requestId: 'req-expired' });
  assert.deepEqual([write.status, write.body.error.code], [401, 'invalid_token']);
  assert.equal(fake.auditLog().length, before);
  // One lookup by digest, and nobody asked about its owner.
  assert.deepEqual(fake.methodsCalled().slice(mark), ['getToken']);
  const line = logs.find((entry) => entry.requestId === 'req-expired' && entry.event === undefined);
  assert.deepEqual([line.via, line.token, line.tokenState, line.sub, line.status, line.route],
    ['token', id, 'expired', null, 401, 'POST /api/firmware']);
});

test('a revoked token fills no activity log, however often it is used', async () => {
  const context = setup();
  const { call, fake, manager, make, logs } = context;
  const { token, id } = await make(manager, { name: 'leaked' });
  assert.equal((await call('POST', `/api/tokens/${id}/revoke`, { as: manager })).status, 200);
  const before = fake.auditLog().length;
  const writes = [['/api/t/firmware', upload()], ['/api/t/deployments', { version: '1.2.3+4', things: [BOARD] }],
    ['/api/t/firmware/1.2.3+4/revoke', { reason: 'x' }], ['/api/t/firmware/1.2.3+4/bluetooth', { sha256: 'a'.repeat(64) }]];
  for (let round = 0; round < 5; round += 1) {
    for (const [path, body] of writes) {
      const response = await call('POST', path, { token, body, requestId: `req-${round}-${path.length}` });
      assert.deepEqual([response.status, response.body.error.code], [401, 'invalid_token'], path);
    }
    const read = await call('GET', '/api/t/firmware/1.2.3+4/image', { token });
    assert.deepEqual([read.status, read.body.error.code], [401, 'invalid_token']);
  }
  assert.equal(fake.auditLog().length, before);
  // The same answer as for a token that never existed, and a log line for each request.
  const unknown = await call('POST', '/api/t/firmware', { token: newToken(), body: upload() });
  assert.deepEqual(unknown.body.error.message, (await call('POST', '/api/t/firmware', { token, body: upload() })).body.error.message);
  const refused = logs.filter((line) => line.via === 'token' && line.token === id);
  assert.equal(refused.length, 26);
  assert.ok(refused.every((line) => line.tokenState === 'revoked' && line.status === 401 && line.sub === null));
});

test('the owner revokes a token on the website, and it stops working at once', async () => {
  const context = setup();
  const { call, fake, manager, viewer, make, clock } = context;
  const { token, id } = await make(manager, { name: 'ci' });
  const other = await make(viewer);
  assert.equal((await call('GET', '/api/t/devices', { token })).status, 200);

  const before = fake.auditLog().length;
  const revoked = await call('POST', `/api/tokens/${id}/revoke`, { as: manager });
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.body.token, {
    id, name: 'ci', createdAt: revoked.body.token.createdAt, expiresAt: revoked.body.token.expiresAt,
    revokedAt: new Date(clock.ms).toISOString(), status: 'revoked',
  });
  assert.equal(fake.tokens.get(sha256(token)).revokedAt, new Date(clock.ms).toISOString());
  const response = await call('GET', '/api/t/devices', { token });
  assert.deepEqual([response.status, response.body.error.code], [401, 'invalid_token']);

  // Once only; only one's own; only an id.
  const again = await call('POST', `/api/tokens/${id}/revoke`, { as: manager });
  assert.deepEqual([again.status, again.body.error.code], [409, 'token_already_revoked']);
  const theirs = await call('POST', `/api/tokens/${other.id}/revoke`, { as: manager });
  assert.deepEqual([theirs.status, theirs.body.error.code], [404, 'unknown_token']);
  assert.equal(fake.tokens.get(sha256(other.token)).revokedAt, null);
  const odd = await call('POST', '/api/tokens/ZZZZ/revoke', { as: manager });
  assert.deepEqual([odd.status, odd.body.error.code], [400, 'invalid_token_id']);

  assert.deepEqual(fake.auditLog().slice(before).map((entry) => [entry.action, entry.outcome, entry.target, entry.detail.code ?? null]), [
    ['token.revoke', 'ok', id, null],
    ['token.revoke', 'rejected', id, 'token_already_revoked'],
    ['token.revoke', 'rejected', other.id, 'unknown_token'],
    ['token.revoke', 'rejected', '', 'invalid_token_id'],
  ]);
  assert.equal(fake.auditLog().slice(before)[0].detail.name, 'ci');
});

test('a token cannot manage tokens, or read a Bluetooth passkey', async () => {
  const { call, fake, manager, make } = setup();
  const { token, id } = await make(manager);
  const before = fake.auditLog().length;
  const cases = [
    ['GET', '/api/t/tokens', null],
    ['POST', '/api/t/tokens', 'token.create'],
    ['POST', `/api/t/tokens/${id}/revoke`, 'token.revoke'],
    ['GET', '/api/t/pairing/Cranium-0A1B', 'pairing.read'],
  ];
  for (const [method, path, action] of cases) {
    const response = await call(method, path, { token, body: method === 'POST' ? { name: 'more' } : undefined });
    assert.deepEqual([response.status, response.body.error.code], [403, 'token_not_allowed'], path);
    if (action !== null) {
      const entry = fake.auditLog().at(-1);
      assert.deepEqual([entry.action, entry.outcome, entry.actor.sub, entry.detail.token], [action, 'denied', manager.sub, id]);
    }
  }
  assert.equal(fake.auditLog().length, before + 3);
  assert.equal(fake.tokens.size, 1);
  assert.equal(fake.tokens.get(sha256(token)).revokedAt, null);
});

test('a session never reaches /api/t/, and a token never reaches the routes of a session', async () => {
  const { call, fake, manager, make } = setup();
  const { token } = await make(manager);
  const response = await call('GET', '/api/t/devices', { as: manager });
  assert.deepEqual([response.status, response.body.error.code], [401, 'invalid_token']);
  // The gateway's authorizer refuses this before the function; the function does too.
  const wrongWay = await call('GET', '/api/devices', { token });
  assert.deepEqual([wrongWay.status, wrongWay.body.error.code], [401, 'unauthorized']);
  const mark = fake.calls.length;
  for (const path of ['/api/t', '/api/T/devices', '/api/tt/devices']) {
    assert.equal((await call('GET', path, { token })).status, 401, path);
  }
  assert.deepEqual(fake.methodsCalled().slice(mark), []);
});

test('a token that names nobody gets one answer, asks nobody and leaves no entry', async () => {
  const { call, fake, manager, make, logs } = setup();
  const { token } = await make(manager);
  const before = fake.auditLog().length;
  const mark = fake.calls.length;
  const malformed = [undefined, '', token, `bearer ${token}`, `Bearer ${token.slice(0, -1)}`, `Bearer ${token}x`, 'Bearer crn_'];
  for (const authorization of malformed) {
    for (const [method, path] of [['GET', '/api/t/devices'], ['POST', '/api/t/firmware']]) {
      const response = await call(method, path, { authorization, body: method === 'POST' ? upload() : undefined });
      assert.deepEqual([response.status, response.body.error.code], [401, 'invalid_token'], String(authorization));
    }
  }
  // Well formed: one lookup by digest, and no further.
  assert.deepEqual(fake.methodsCalled().slice(mark), []);
  const unknown = newToken();
  const response = await call('POST', '/api/t/firmware', { token: unknown, body: upload() });
  assert.deepEqual([response.status, response.body.error.code], [401, 'invalid_token']);
  assert.deepEqual(fake.methodsCalled().slice(mark), ['getToken']);
  assert.deepEqual(fake.calls.at(-1).args, [sha256(unknown)]);
  assert.equal(fake.auditLog().length, before);
  assert.equal(fake.releases.size, 0);
  // The log knows that a token request was refused, not which token.
  const line = logs.at(-1);
  assert.deepEqual([line.via, line.token, line.sub, line.status, line.route], ['token', null, null, 401, 'POST /api/firmware']);
});

test('the log names a token by its id, never by the token or its digest', async () => {
  const { call, manager, make, logs } = setup();
  const { token, id } = await make(manager);
  logs.length = 0;
  await call('GET', '/api/t/devices', { token, requestId: 'req-t1' });
  await call('POST', '/api/t/firmware', { token, body: upload(), requestId: 'req-t2' });
  const requests = logs.filter((line) => line.event === undefined);
  assert.deepEqual(requests.map((line) => [line.requestId, line.sub, line.route, line.status, line.via, line.token]), [
    ['req-t1', manager.sub, 'GET /api/devices', 200, 'token', id],
    ['req-t2', manager.sub, 'POST /api/firmware', 201, 'token', id],
  ]);
  const text = JSON.stringify(logs);
  for (const hidden of [token, token.slice(4), sha256(token)]) assert.equal(text.includes(hidden), false);
});

test('a person has at most ten tokens that still work', async () => {
  const context = setup();
  const { call, manager, viewer, make, fake } = context;
  const made = [];
  for (let count = 0; count < MAX_ACTIVE_TOKENS; count += 1) made.push(await make(manager, { name: `t${count}`, days: count === 0 ? 1 : 30 }));
  const full = await call('POST', '/api/tokens', { as: manager, body: { name: 'one more' } });
  assert.deepEqual([full.status, full.body.error.code], [409, 'too_many_tokens']);
  // Somebody else's count is their own.
  await make(viewer);
  // A revoked token and an expired one do not count.
  assert.equal((await call('POST', `/api/tokens/${made[5].id}/revoke`, { as: manager })).status, 200);
  await make(manager, { name: 'in its place' });
  assert.equal((await call('POST', '/api/tokens', { as: manager, body: { name: 'x' } })).status, 409);
  context.advance(DAY);
  await make(manager, { name: 'after the first expired' });
  assert.equal((await call('POST', '/api/tokens', { as: manager, body: { name: 'x' } })).status, 409);
  const listed = (await call('GET', '/api/tokens', { as: manager })).body.tokens;
  assert.equal(listed.filter((token) => token.status === 'active').length, MAX_ACTIVE_TOKENS);
  assert.equal(listed.length, 12);
  assert.equal(fake.tokens.size, 13);
});

test('two tokens made at the same moment cannot take a person past ten', async () => {
  const context = setup();
  const { call, manager, make, fake } = context;
  for (let count = 0; count < MAX_ACTIVE_TOKENS - 1; count += 1) await make(manager, { name: `t${count}` });
  // Both requests count nine before either has stored its token.
  const original = fake.listTokens;
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  fake.listTokens = async (...args) => {
    reads += 1;
    const answer = await original(...args);
    if (reads <= 2) {
      if (reads === 2) release();
      await gate;
    }
    return answer;
  };
  const results = await Promise.all([1, 2].map((n) => call('POST', '/api/tokens', { as: manager, body: { name: `race ${n}` } })));
  fake.listTokens = original;
  const active = (await call('GET', '/api/tokens', { as: manager })).body.tokens.filter((token) => token.status === 'active');
  assert.ok(active.length <= MAX_ACTIVE_TOKENS, `${active.length} active`);
  for (const response of results.filter((item) => item.status !== 201)) {
    assert.deepEqual([response.status, response.body.error.code], [409, 'too_many_tokens']);
  }
  const withdrawn = fake.auditLog().filter((entry) => entry.detail.withdrawn === 'true');
  assert.equal(withdrawn.length, results.filter((item) => item.status === 409).length);
});

test('tokens are made and ended on the website: a phone app\'s session cannot', async () => {
  const { call, fake, manager, make, config } = setup();
  const { id } = await make(manager);
  const phone = accessClaims({ sub: manager.sub, groups: ['release-managers'], clientId: config.mobileClientId });
  // The phone's session is good for what the apps call.
  assert.equal((await call('GET', '/api/firmware', { claims: phone })).status, 200);
  const before = fake.auditLog().length;
  for (const [method, path, body] of [['GET', '/api/tokens'], ['POST', '/api/tokens', { name: 'from a phone' }],
    ['POST', `/api/tokens/${id}/revoke`, {}]]) {
    const response = await call(method, path, { claims: phone, body });
    assert.deepEqual([response.status, response.body.error.code], [403, 'phone_not_allowed'], path);
  }
  assert.equal(fake.tokens.size, 1);
  assert.equal([...fake.tokens.values()][0].revokedAt, null);
  // The two attempts to change something are on record, in the phone's owner's name.
  assert.deepEqual(fake.auditLog().slice(before).map((entry) => [entry.action, entry.outcome, entry.actor.sub, entry.detail.code]), [
    ['token.create', 'denied', manager.sub, 'phone_not_allowed'],
    ['token.revoke', 'denied', manager.sub, 'phone_not_allowed'],
  ]);
});
