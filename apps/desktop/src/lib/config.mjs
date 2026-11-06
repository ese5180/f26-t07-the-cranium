/**
 * The app's public configuration: apps/config/cranium.json, the same file the phone apps are built with
 * (apps/configure.sh writes it from the deployed stack; git ignores it, as it names the stack). Without
 * it the app is built with apps/config/cranium.example.json and says so (example: true), like the phones.
 *
 * Checked here as the page checks it (cloud/web/src/site/assets/bridge.js readAppConfig), so a file that
 * the pages would refuse is refused before a window opens.
 */

const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const POOL = /^([a-z]{2}(?:-[a-z]+)+-\d{1,2})_[0-9A-Za-z]{1,64}$/;
const CLIENT = /^[A-Za-z0-9]{1,128}$/;
const LIVE_URL = /^wss:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?\/[A-Za-z0-9_-]{1,128}$/;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const trimmed = (url) => url.replace(/\/+$/, '');

/** The configuration, checked: { consoleUrl, region, userPoolId, mobileClientId, customer|null, liveUrl|null, example }. */
export function readConfig(text, { example = false } = {}) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConfigError('cranium.json is not JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('cranium.json is not an object');
  const { consoleUrl, region, userPoolId, mobileClientId } = value;
  if (typeof consoleUrl !== 'string' || !HTTPS.test(consoleUrl)) throw new ConfigError('consoleUrl is not an https address');
  if (typeof region !== 'string' || !REGION.test(region)) throw new ConfigError('region is not a Region');
  if (typeof userPoolId !== 'string' || POOL.exec(userPoolId)?.[1] !== region) {
    throw new ConfigError('userPoolId is not a pool of that Region');
  }
  if (typeof mobileClientId !== 'string' || !CLIENT.test(mobileClientId)) throw new ConfigError('mobileClientId is not a client');
  const { customerApiUrl, customerRegion, customerUserPoolId, customerClientId } = value;
  let customer = null;
  if (
    typeof customerApiUrl === 'string' &&
    HTTPS.test(customerApiUrl) &&
    customerRegion === region &&
    typeof customerUserPoolId === 'string' &&
    POOL.exec(customerUserPoolId)?.[1] === region &&
    typeof customerClientId === 'string' &&
    CLIENT.test(customerClientId)
  ) {
    customer = { apiUrl: trimmed(customerApiUrl), region, userPoolId: customerUserPoolId, clientId: customerClientId };
  }
  const liveUrl = typeof value.liveUrl === 'string' && LIVE_URL.test(value.liveUrl) ? value.liveUrl : null;
  return Object.freeze({
    consoleUrl: trimmed(consoleUrl),
    region,
    userPoolId,
    mobileClientId,
    customer: customer ? Object.freeze(customer) : null,
    liveUrl,
    example: example === true,
  });
}

/** app.config's answer, with the keys and nulls the phone apps give (bridge.json, app.config). */
export function configResult(config) {
  const { customer } = config;
  return {
    consoleUrl: config.consoleUrl,
    region: config.region,
    userPoolId: config.userPoolId,
    mobileClientId: config.mobileClientId,
    customerApiUrl: customer ? customer.apiUrl : null,
    customerRegion: customer ? customer.region : null,
    customerUserPoolId: customer ? customer.userPoolId : null,
    customerClientId: customer ? customer.clientId : null,
    example: config.example,
    ...(config.liveUrl ? { liveUrl: config.liveUrl } : {}),
  };
}

/** The pool's user pool and client, for refreshing and revoking: 'admin' or 'customer'. */
export function poolOf(config, pool) {
  if (pool === 'admin') return { region: config.region, userPoolId: config.userPoolId, clientId: config.mobileClientId };
  if (pool === 'customer' && config.customer) {
    const { region, userPoolId, clientId } = config.customer;
    return { region, userPoolId, clientId };
  }
  return null;
}
