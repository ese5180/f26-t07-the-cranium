/**
 * Configuration of the customer site's two halves (docs/customer-site.md), read from the
 * environment once at cold start, like src/config.mjs.
 *
 * loadCustomerApiConfig: the customer API (CustomerApiFn). Every value is required, and a
 * missing or malformed one stops the function from starting.
 *
 * loadCustomerAdminConfig: what the console's API (ApiFn) needs for its Customers page. It
 * is null when CUSTOMER_POOL_ID is not set, which is only so in tests and in an older
 * deployment: the page then says that the customer site is not set up. CUSTOMER_SITE_URL is
 * empty until CustomerDomainName is set: invitations name the site, so none goes out before
 * it has an address.
 */

const PATTERNS = Object.freeze({
  AWS_REGION: /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/,
  STATE_TABLE: /^[A-Za-z0-9_.-]{3,255}$/,
  EVENTS_TABLE: /^[A-Za-z0-9_.-]{3,255}$/,
  CUSTOMER_POOL_ID: /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}_[0-9A-Za-z]{1,64}$/,
  CUSTOMER_CLIENT_ID: /^[\w+]{1,128}$/,
  // https://<host>/, as the stack writes it, or nothing.
  CUSTOMER_SITE_URL: /^(?:|https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\/)$/,
});

function read(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !PATTERNS[name].test(value)) {
    throw new Error(`Environment variable ${name} is missing or malformed`);
  }
  return value;
}

/** The issuer of the customer pool's tokens, as API Gateway's authorizer checks it. */
export function issuerOf(poolId) {
  return `https://cognito-idp.${poolId.split('_')[0]}.amazonaws.com/${poolId}`;
}

export function loadCustomerApiConfig(env = process.env) {
  const customerPoolId = read(env, 'CUSTOMER_POOL_ID');
  return Object.freeze({
    region: read(env, 'AWS_REGION'),
    stateTable: read(env, 'STATE_TABLE'),
    eventsTable: read(env, 'EVENTS_TABLE'),
    customerPoolId,
    customerClientId: read(env, 'CUSTOMER_CLIENT_ID'),
    issuer: issuerOf(customerPoolId),
  });
}

export function loadCustomerAdminConfig(env = process.env) {
  if (env.CUSTOMER_POOL_ID === undefined || env.CUSTOMER_POOL_ID === '') return null;
  return Object.freeze({
    customerPoolId: read(env, 'CUSTOMER_POOL_ID'),
    siteUrl: read({ CUSTOMER_SITE_URL: env.CUSTOMER_SITE_URL ?? '' }, 'CUSTOMER_SITE_URL'),
  });
}
