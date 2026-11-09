/**
 * The Database page's reads of DynamoDB (docs/database.md, handlers/db.mjs): the state, audit and events
 * tables, read only. Three calls, each on one of the three tables, named here as state, audit or events:
 *
 *   dbDescribe(table)  -> { items, bytes }   DescribeTable's ItemCount and TableSizeBytes, which DynamoDB
 *                                            brings up to date about every six hours
 *   dbRead({ table, op, pk, sk, newestFirst, where, limit, start })
 *                      -> { items: object[], next: { pk, sk } | null, read }
 *       op 'query': one partition (pk), with sk null, { equals }, { begins } or { between: [low, high] }
 *       op 'scan':  the table, one page from `start`
 *       `where` is lib/db.mjs planOf's list of conditions, made into a FilterExpression here; `limit` is
 *       DynamoDB's Limit, how many items are read (those the filter leaves out included); `read` is how
 *       many were. Items come back as plain values: a number set or a list as an array, binary as base64.
 *
 * Errors are thrown as aws.mjs throws them (name AwsError, code throttled or failed). No call writes.
 * createDbAws(env) reads AWS_REGION, STATE_TABLE, AUDIT_TABLE and EVENTS_TABLE; the tests pass `send`.
 */

// The SDK is loaded when the first call is made, in Lambda; the tests pass `send` and never load it.
const CONNECT_TIMEOUT_MS = 1000;
const IDLE_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 2;

const THROTTLING = new Set([
  'ThrottlingException',
  'Throttling',
  'ThrottledException',
  'TooManyRequestsException',
  'RequestLimitExceeded',
  'ProvisionedThroughputExceededException',
  'RequestThrottled',
  'RequestThrottledException',
]);

const nameOf = (cause) =>
  cause !== null && typeof cause === 'object' && typeof cause.name === 'string' ? cause.name : 'Error';

function failure(operation, cause) {
  const status = Number.isInteger(cause?.$metadata?.httpStatusCode) ? cause.$metadata.httpStatusCode : null;
  const error = new Error(`${operation}: ${nameOf(cause)}: ${String(cause?.message ?? cause).slice(0, 300)}`);
  error.name = 'AwsError';
  error.code =
    THROTTLING.has(nameOf(cause)) || status === 429 || cause?.$retryable?.throttling === true ? 'throttled' : 'failed';
  error.operation = operation;
  error.awsError = nameOf(cause);
  error.awsStatus = status;
  return error;
}

function required(env, name) {
  const value = env?.[name];
  if (typeof value !== 'string' || value === '') throw new Error(`Environment variable ${name} is missing`);
  return value;
}

/** A DynamoDB attribute value as a plain value. */
export function plain(attribute) {
  if (attribute === null || typeof attribute !== 'object') return null;
  if (typeof attribute.S === 'string') return attribute.S;
  if (typeof attribute.N === 'string') return Number(attribute.N);
  if (typeof attribute.BOOL === 'boolean') return attribute.BOOL;
  if (attribute.NULL === true) return null;
  if (Array.isArray(attribute.L)) return attribute.L.map(plain);
  if (attribute.M !== null && typeof attribute.M === 'object') return plainItem(attribute.M);
  if (Array.isArray(attribute.SS)) return [...attribute.SS];
  if (Array.isArray(attribute.NS)) return attribute.NS.map(Number);
  if (attribute.B !== undefined) return Buffer.from(attribute.B).toString('base64');
  if (Array.isArray(attribute.BS)) return attribute.BS.map((one) => Buffer.from(one).toString('base64'));
  return null;
}

export function plainItem(item) {
  return Object.fromEntries(Object.entries(item ?? {}).map(([name, value]) => [name, plain(value)]));
}

/**
 * The expressions of a read: { KeyConditionExpression?, FilterExpression?, names, values }. Every name
 * and value goes in as a placeholder, so nothing in a filter can change the expression.
 */
export function expressionsOf({ op, pk, sk, where }) {
  const names = {};
  const values = {};
  let count = 0;
  const name = (text) => {
    const found = Object.keys(names).find((key) => names[key] === text);
    if (found) return found;
    const key = `#n${Object.keys(names).length}`;
    names[key] = text;
    return key;
  };
  const value = (text) => {
    const key = `:v${count}`;
    count += 1;
    values[key] = { S: text };
    return key;
  };
  const condition = (one) => {
    if (one.any) return `(${one.any.map(condition).join(' OR ')})`;
    if (one.equals) return `${name(one.equals[0])} = ${value(one.equals[1])}`;
    if (one.contains) return `contains(${name(one.contains[0])}, ${value(one.contains[1])})`;
    if (one.begins) return `begins_with(${name(one.begins[0])}, ${value(one.begins[1])})`;
    if (one.between) return `${name(one.between[0])} BETWEEN ${value(one.between[1])} AND ${value(one.between[2])}`;
    throw new TypeError('Not a condition');
  };
  const out = {};
  if (op === 'query') {
    let key = `${name('pk')} = ${value(pk)}`;
    if (sk?.equals !== undefined) key += ` AND ${name('sk')} = ${value(sk.equals)}`;
    else if (sk?.begins !== undefined) key += ` AND begins_with(${name('sk')}, ${value(sk.begins)})`;
    else if (sk?.between !== undefined)
      key += ` AND ${name('sk')} BETWEEN ${value(sk.between[0])} AND ${value(sk.between[1])}`;
    out.KeyConditionExpression = key;
  }
  if (where.length > 0) out.FilterExpression = where.map(condition).join(' AND ');
  return { ...out, names, values };
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {object} [options]
 * @param {(operation: string, input: object) => Promise<object>} [options.send]  for the tests: the
 *        operation (DescribeTable, Query, Scan) and its input, answered as DynamoDB would
 */
export function createDbAws(env, { send } = {}) {
  const tables = {
    state: required(env, 'STATE_TABLE'),
    audit: required(env, 'AUDIT_TABLE'),
    events: required(env, 'EVENTS_TABLE'),
  };
  let client = null;
  let sdk = null;
  const call =
    send ??
    (async (operation, input) => {
      sdk ??= await import('@aws-sdk/client-dynamodb');
      client ??= new sdk.DynamoDBClient({
        region: env.AWS_REGION,
        maxAttempts: MAX_ATTEMPTS,
        requestHandler: {
          connectionTimeout: CONNECT_TIMEOUT_MS,
          socketTimeout: IDLE_TIMEOUT_MS,
          requestTimeout: CALL_TIMEOUT_MS,
          throwOnRequestTimeout: true,
        },
      });
      return client.send(new sdk[`${operation}Command`](input));
    });
  const tableName = (table) => {
    if (!Object.hasOwn(tables, table)) throw new TypeError('Not a table of the Database page');
    return tables[table];
  };

  return {
    async dbDescribe(table) {
      let out;
      try {
        out = await call('DescribeTable', { TableName: tableName(table) });
      } catch (cause) {
        if (cause instanceof TypeError) throw cause;
        throw failure('DescribeTable', cause);
      }
      const count = Number(out?.Table?.ItemCount);
      const bytes = Number(out?.Table?.TableSizeBytes);
      return {
        items: Number.isSafeInteger(count) && count >= 0 ? count : null,
        bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null,
      };
    },

    async dbRead({ table, op, pk = null, sk = null, newestFirst = true, where = [], limit, start = null }) {
      const { names, values, ...expressions } = expressionsOf({ op, pk, sk, where });
      const input = {
        TableName: tableName(table),
        ...expressions,
        Limit: limit,
      };
      // DynamoDB refuses an empty map of names or values.
      if (Object.keys(names).length > 0) input.ExpressionAttributeNames = names;
      if (Object.keys(values).length > 0) input.ExpressionAttributeValues = values;
      if (start !== null) input.ExclusiveStartKey = { pk: { S: start.pk }, sk: { S: start.sk } };
      if (op === 'query') input.ScanIndexForward = !newestFirst;
      const operation = op === 'query' ? 'Query' : 'Scan';
      let out;
      try {
        out = await call(operation, input);
      } catch (cause) {
        throw failure(operation, cause);
      }
      const last = out?.LastEvaluatedKey;
      return {
        items: (out?.Items ?? []).map(plainItem),
        next:
          last && typeof last.pk?.S === 'string' && typeof last.sk?.S === 'string'
            ? { pk: last.pk.S, sk: last.sk.S }
            : null,
        read: Number.isSafeInteger(out?.ScannedCount) ? out.ScannedCount : (out?.Items ?? []).length,
      };
    },
  };
}
