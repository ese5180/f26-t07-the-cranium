/**
 * The bridge between the window's pages and the app (apps/shared/bridge.json, docs/desktop-app.md "The
 * bridge"): every request checked against the contract before anything is done, as both phone apps do.
 *
 *   a method not in the contract                    unknown_method
 *   one whose feature this app does not offer       unavailable
 *   a parameter missing, unknown, of another type,
 *   out of its range or not of its pattern          bad_request
 *
 * The contract is read from bridge.json itself (the copy packaged with the app), so a method that is
 * not there does not exist here either. test/bridge.test.mjs checks that the app handles exactly the
 * methods of the features it offers.
 */

export const ERRORS = Object.freeze([
  'bad_request',
  'unknown_method',
  'unavailable',
  'not_allowed',
  'cancelled',
  'locked',
  'signed_out',
  'busy',
  'network',
  'failed',
]);
const MAX_ID = 2147483647;

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = ERRORS.includes(code) ? code : 'failed';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The contract, from bridge.json's text: { version, maxRequestBytes, features, methods, events, policies }. */
export function readContract(text) {
  const value = JSON.parse(text);
  if (!isRecord(value) || !Number.isInteger(value.bridge) || !isRecord(value.methods)) {
    throw new Error('bridge.json is not the contract');
  }
  return Object.freeze({
    version: value.bridge,
    maxRequestBytes: value.envelope?.maxRequestBytes ?? 4194304,
    features: Object.freeze([...value.features]),
    methods: value.methods,
    events: Object.freeze(Object.keys(value.events ?? {})),
    policies: Object.freeze({ console: value.policies?.console, customer: value.policies?.customer }),
  });
}

/** One parameter against its spec; the reason it does not fit, or null. */
function misfit(name, value, spec) {
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') return `${name} is not text`;
      if (Number.isInteger(spec.max) && value.length > spec.max) return `${name} is too long`;
      if (typeof spec.pattern === 'string' && !new RegExp(spec.pattern).test(value)) return `${name} is not of its form`;
      return null;
    case 'integer':
      if (!Number.isInteger(value)) return `${name} is not a whole number`;
      if (Number.isInteger(spec.min) && value < spec.min) return `${name} is too small`;
      if (Number.isInteger(spec.max) && value > spec.max) return `${name} is too large`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${name} is not true or false`;
    case 'enum':
      return Array.isArray(spec.values) && spec.values.includes(value) ? null : `${name} is not one of its values`;
    default:
      return `${name} is of a type this app does not know`;
  }
}

/** The request's params, checked against the method's spec; throws bad_request. */
export function checkParams(spec, params) {
  if (!isRecord(params)) throw new BridgeError('bad_request', 'params is not an object');
  const known = isRecord(spec.params) ? spec.params : {};
  for (const name of Object.keys(params)) {
    if (!Object.hasOwn(known, name)) throw new BridgeError('bad_request', `${name} is not a parameter of this method`);
  }
  for (const [name, paramSpec] of Object.entries(known)) {
    if (!Object.hasOwn(params, name)) {
      if (paramSpec.optional === true) continue;
      throw new BridgeError('bad_request', `${name} is missing`);
    }
    const reason = misfit(name, params[name], paramSpec);
    if (reason) throw new BridgeError('bad_request', reason);
  }
  return params;
}

/**
 * The dispatcher: handlers by method, the features they give, and one function that takes a request's
 * text and gives the answer's text.
 *
 * @param {ReturnType<typeof readContract>} contract
 * @param {Record<string, (params: object) => Promise<object>|object>} handlers
 * @param {string[]} features  the features this app offers: each must be the contract's
 */
export function createDispatcher(contract, handlers, features) {
  const offered = new Set(features.filter((feature) => contract.features.includes(feature)));
  for (const method of Object.keys(handlers)) {
    if (!Object.hasOwn(contract.methods, method)) throw new Error(`${method} is not in the contract`);
  }

  /** The methods this app answers: every method of an offered feature, and the ones of no feature. */
  function answered() {
    return Object.entries(contract.methods)
      .filter(([, spec]) => spec.feature === null || offered.has(spec.feature))
      .map(([name]) => name)
      .sort();
  }

  async function handle(text) {
    if (typeof text !== 'string' || text.length > contract.maxRequestBytes) return null;
    let request;
    try {
      request = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isRecord(request) || !Number.isInteger(request.id) || request.id < 1 || request.id > MAX_ID) return null;
    const { id } = request;
    const fail = (error) =>
      JSON.stringify({
        id,
        ok: false,
        error: {
          code: error instanceof BridgeError ? error.code : 'failed',
          message: error instanceof BridgeError ? error.message : 'The app could not do that.',
        },
      });
    try {
      if (request.v !== contract.version || typeof request.method !== 'string') {
        throw new BridgeError('bad_request', 'Not a request of this bridge.');
      }
      const spec = Object.hasOwn(contract.methods, request.method) ? contract.methods[request.method] : null;
      if (!spec) throw new BridgeError('unknown_method', `No method ${request.method.slice(0, 40)} in this bridge.`);
      if (spec.feature !== null && !offered.has(spec.feature)) {
        throw new BridgeError('unavailable', 'This app does not do that.');
      }
      const handler = handlers[request.method];
      if (!handler) throw new BridgeError('unavailable', 'This app does not do that.');
      const params = checkParams(spec, request.params ?? {});
      const result = await handler(params);
      return JSON.stringify({ id, ok: true, result: isRecord(result) ? result : {} });
    } catch (error) {
      return fail(error);
    }
  }

  return Object.freeze({ handle, answered, features: () => [...offered].sort() });
}

/** An event for the page, in the contract's envelope. */
export function eventText(contract, name, data) {
  if (!contract.events.includes(name)) throw new Error(`${name} is not an event of the contract`);
  return JSON.stringify({ event: name, data: isRecord(data) ? data : {} });
}
