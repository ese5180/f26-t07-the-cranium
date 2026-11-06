// The window's policy: what each page's Content-Security-Policy says, what the window shows, and what
// goes to the system.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { readContract } from '../src/lib/bridge.mjs';
import { readConfig } from '../src/lib/config.mjs';
import {
  ORIGIN,
  contentSecurityPolicy,
  headersFor,
  isBundle,
  mayOpenOutside,
  navigation,
  originOf,
  requestPath,
  startUrl,
} from '../src/lib/policy.mjs';

const contract = readContract(readFileSync(new URL('../../shared/bridge.json', import.meta.url), 'utf8'));
const config = readConfig(
  JSON.stringify({
    consoleUrl: 'https://console.example.com/',
    region: 'us-east-1',
    userPoolId: 'us-east-1_Example1',
    mobileClientId: 'exampleclient',
    customerApiUrl: 'https://customer.example.com',
    customerRegion: 'us-east-1',
    customerUserPoolId: 'us-east-1_Example2',
    customerClientId: 'examplecustomer',
  })
);

test("the bundle's origin is the iPhone app's, so the pages and the API's CORS treat both alike", () => {
  assert.equal(ORIGIN, JSON.parse(readFileSync(new URL('../../shared/bridge.json', import.meta.url), 'utf8')).origins.ios);
});

test("each route's policy is bridge.json's, with this configuration's origins in it", () => {
  assert.equal(
    contentSecurityPolicy(contract.policies, 'console', config),
    "default-src 'none'; script-src 'self' cranium-app://bundle; style-src 'self' cranium-app://bundle; " +
      "img-src 'self' cranium-app://bundle data: https://tile.openstreetmap.org; connect-src 'self' cranium-app://bundle " +
      'https://console.example.com https://customer.example.com https://cognito-idp.us-east-1.amazonaws.com; ' +
      "base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'"
  );
  const customer = contentSecurityPolicy(contract.policies, 'customer', config);
  assert.match(customer, /require-trusted-types-for 'script'; trusted-types 'none'$/);
  assert.equal(contentSecurityPolicy(contract.policies, 'other', config), null);
  // Without the customer pool, and so without its API, no empty word is left.
  const admins = readConfig(
    JSON.stringify({ consoleUrl: 'https://console.example.com', region: 'us-east-1', userPoolId: 'us-east-1_A', mobileClientId: 'c' })
  );
  assert.doesNotMatch(contentSecurityPolicy(contract.policies, 'console', admins), / {2}| ;/);
  // A template with {live} gets the live API's origin, where the configuration names one.
  const live = readConfig(JSON.stringify({ ...JSON.parse(JSON.stringify(admins)), liveUrl: 'wss://abcdefghij.execute-api.us-east-1.amazonaws.com/live' }));
  assert.equal(
    contentSecurityPolicy({ console: "connect-src 'self' {console} {live}" }, 'console', live),
    "connect-src 'self' https://console.example.com wss://abcdefghij.execute-api.us-east-1.amazonaws.com"
  );
  assert.equal(contentSecurityPolicy({ console: "connect-src 'self' {live}" }, 'console', admins), "connect-src 'self'");
});

test('the window shows the bundle only; https and otpauth go to the system; anything else nowhere', () => {
  assert.equal(navigation('cranium-app://bundle/admin', { mainFrame: true, newWindow: false }), 'allow');
  assert.equal(navigation('cranium-app://bundle/admin', { mainFrame: true, newWindow: true }), 'drop');
  assert.equal(navigation('cranium-app://bundle/', { mainFrame: false, newWindow: false }), 'drop');
  assert.equal(navigation('https://console.example.com/', { mainFrame: true, newWindow: false }), 'outside');
  assert.equal(navigation('https://console.example.com/', { mainFrame: true, newWindow: true }), 'outside');
  assert.equal(navigation('https://frame.example.com/', { mainFrame: false, newWindow: false }), 'drop');
  assert.equal(navigation('otpauth://totp/Cranium:a?secret=X', { mainFrame: true, newWindow: true }), 'outside');
  for (const url of [
    'http://console.example.com/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'sidestore://source',
    'https://user:pass@example.com/',
    'cranium-app://other/',
    'cranium-app://bundle:8080/',
    `https://example.com/${'x'.repeat(4100)}`,
  ]) {
    assert.equal(navigation(url, { mainFrame: true, newWindow: false }), 'drop', url);
    assert.equal(mayOpenOutside(url), false, url);
  }
  assert.equal(isBundle('cranium-app://bundle/assets/x.js'), true);
  assert.equal(isBundle('cranium-app://user@bundle/'), false);
  assert.equal(isBundle('not a url'), false);
});

test('the paths, the headers and where the window starts', () => {
  assert.equal(requestPath('cranium-app://bundle/admin?x=1#/boards'), '/admin');
  assert.equal(requestPath('cranium-app://bundle'), '/');
  assert.deepEqual(headersFor('text/javascript; charset=utf-8', null), {
    'content-type': 'text/javascript; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  assert.equal(headersFor('text/html; charset=utf-8', "default-src 'none'")['cache-control'], 'no-store');
  assert.equal(startUrl(config), 'cranium-app://bundle/');
  assert.equal(originOf('wss://live.example.com/live'), 'wss://live.example.com');
  assert.equal(originOf('http://example.com'), null);
});
