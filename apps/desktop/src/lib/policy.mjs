/**
 * What the app's window may show and do (apps/shared/bridge.json "policies" and "navigation";
 * docs/desktop-app.md, "Security"): the same rules as the phone apps' ShellPolicy, on the iPhone's origin.
 *
 * Pure, so that the tests go through every case.
 */

export const SCHEME = 'cranium-app';
export const HOST = 'bundle';
export const ORIGIN = `${SCHEME}://${HOST}`;
// What may be handed to the system: the browser, and an authenticator app. A desktop has no SideStore.
export const OUTSIDE_SCHEMES = Object.freeze(['https:', 'otpauth:']);
export const MAX_OUTSIDE_URL = 4096;

function parse(url) {
  if (url instanceof URL) return url;
  try {
    return new URL(String(url));
  } catch {
    return null;
  }
}

/** `scheme://host[:port]` of an https or wss address; null for anything else. */
export function originOf(url) {
  const parsed = parse(url);
  if (!parsed || !['https:', 'wss:'].includes(parsed.protocol) || parsed.hostname === '') return null;
  return `${parsed.protocol}//${parsed.host.toLowerCase()}`;
}

/** Whether an address is of the bundle's origin: cranium-app://bundle, no port, no user. */
export function isBundle(url) {
  const parsed = parse(url);
  return (
    parsed !== null &&
    parsed.protocol === `${SCHEME}:` &&
    parsed.hostname === HOST &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

/** Whether app.open and the window may hand an address to the system. */
export function mayOpenOutside(url) {
  const text = String(url);
  if (text.length > MAX_OUTSIDE_URL) return false;
  const parsed = parse(text);
  if (!parsed || !OUTSIDE_SCHEMES.includes(parsed.protocol)) return false;
  if (parsed.protocol === 'https:' && (parsed.hostname === '' || parsed.username !== '' || parsed.password !== '')) {
    return false;
  }
  return true;
}

/**
 * What becomes of a navigation: 'allow' (in the window: the bundle's origin, in the main frame, not a new
 * window), 'outside' (cancelled here, handed to the system) or 'drop'. A frame of another document is
 * never loaded.
 */
export function navigation(url, { mainFrame, newWindow }) {
  if (!newWindow && mainFrame && isBundle(url)) return 'allow';
  if (!mainFrame && !newWindow) return 'drop';
  return mayOpenOutside(url) ? 'outside' : 'drop';
}

/** The Cognito user pool API of each Region in the configuration, once each. */
function idpOrigins(config) {
  const regions = [config.region, config.customer?.region].filter(Boolean);
  return [...new Set(regions.map((region) => `https://cognito-idp.${region}.amazonaws.com`))];
}

/**
 * The Content-Security-Policy of a page of the bundle, for its route's policy, from bridge.json's
 * templates; null for a policy that is not one, and such a page is not served. {live}, where a template
 * has it, is the live API's origin when the configuration names one.
 */
export function contentSecurityPolicy(templates, policy, config) {
  const template = Object.hasOwn(templates, policy) ? templates[policy] : null;
  if (typeof template !== 'string') return null;
  const console = originOf(config.consoleUrl) ?? '';
  const customer = config.customer ? originOf(config.customer.apiUrl) : null;
  const live = config.liveUrl ? originOf(config.liveUrl) : null;
  const text = template
    .replaceAll('{self}', ORIGIN)
    .replaceAll('{console}', console)
    .replaceAll('{customer}', customer && customer !== console ? customer : '')
    .replaceAll('{idp}', idpOrigins(config).join(' '))
    .replaceAll('{live}', live ?? '');
  // A value left out leaves two spaces, and a directive must not end in one.
  return text
    .split(';')
    .map((directive) => directive.split(' ').filter(Boolean).join(' '))
    .join('; ');
}

/** The path of a request to the bundle, as sent: only ever a key. */
export function requestPath(url) {
  const parsed = parse(url);
  if (!parsed) return null;
  return parsed.pathname === '' ? '/' : parsed.pathname;
}

/** The headers of a file of the bundle: its type, no sniffing, and for a page its policy and no store. */
export function headersFor(type, csp) {
  const headers = {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': csp ? 'no-store' : 'public, max-age=31536000, immutable',
  };
  if (csp) headers['content-security-policy'] = csp;
  return headers;
}

/** Where the window starts: the customer site, or the console when this build has no customer pool. */
export function startUrl(config) {
  return config.customer ? `${ORIGIN}/` : `${ORIGIN}/admin`;
}
