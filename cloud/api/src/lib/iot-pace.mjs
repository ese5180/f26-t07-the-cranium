/**
 * Pacing of the AWS IoT job reads that a page or the rollout tick makes many of.
 *
 * AWS IoT allows about 10 requests a second, per account, for each of DescribeJob,
 * ListJobs, ListJobExecutionsForJob, DescribeJobExecution and ListJobExecutionsForThing,
 * and answers anything beyond with ThrottlingException. A page that reads every
 * deployment, or a function instance that starts cold, can ask for more than that at
 * once. pace(aws) returns the same adapter with these reads
 *
 *   - limited to IN_FLIGHT at a time, all of them together, in this function instance;
 *   - started no faster than PER_SECOND a second for each operation, after a burst of BURST;
 *   - tried again, up to ATTEMPTS times in all, when AWS throttles one, after a wait that
 *     grows each time and is drawn at random (so that instances do not retry in step);
 *     the last refusal is thrown as it came (code "throttled");
 *   - shared while in flight: two reads of the same job at the same moment are one call
 *     (never across a createJob or cancelJob).
 *
 * Every other method passes through unchanged. What a read returns is not kept here:
 * the deployments' handlers keep their own short-lived summaries (handlers/deployments.mjs).
 * The waits together stay well inside the request's budget (app.mjs).
 */

export const IN_FLIGHT = 4;
export const PER_SECOND = 8;
export const BURST = 8;
export const ATTEMPTS = 3;
// The first retry waits 100 to 200 ms, the second 200 to 400 ms.
export const BACKOFF_MS = 200;

const PACED = Object.freeze([
  ['listJobs', 'ListJobs'],
  ['describeJob', 'DescribeJob'],
  ['listJobExecutionsForJob', 'ListJobExecutionsForJob'],
  ['describeJobExecution', 'DescribeJobExecution'],
  ['listJobExecutionsForThing', 'ListJobExecutionsForThing'],
]);

function realSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {object} aws  the adapter (aws.mjs or test/fake-aws.mjs)
 * @param {object} [options]
 * @param {() => number} [options.clock]  a monotonic clock in ms (performance.now)
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.random]  in [0, 1)
 * @param {(line: object) => void} [options.log]
 */
export function pace(aws, options = {}) {
  const {
    clock = () => performance.now(),
    sleep = realSleep,
    random = Math.random,
    log = () => {},
    inFlight = IN_FLIGHT,
    perSecond = PER_SECOND,
    burst = BURST,
    attempts = ATTEMPTS,
  } = options;

  let running = 0;
  const waiting = []; // resolvers of reads waiting for a free slot
  const buckets = new Map(); // operation -> { tokens, at }
  const shared = new Map(); // "method key" -> the promise of the read in flight

  async function slot() {
    if (running < inFlight) {
      running += 1;
      return;
    }
    // The slot is handed over by release(), so running stays as it is.
    await new Promise((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next === undefined) running -= 1;
    else next();
  }

  /** Wait until the operation may start one more request. */
  async function token(operation) {
    for (;;) {
      const at = clock();
      const bucket = buckets.get(operation) ?? { tokens: burst, at };
      bucket.tokens = Math.min(burst, bucket.tokens + ((at - bucket.at) * perSecond) / 1000);
      bucket.at = at;
      buckets.set(operation, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - bucket.tokens) * 1000) / perSecond));
    }
  }

  async function once(operation, call) {
    await slot();
    try {
      await token(operation);
      return await call();
    } finally {
      release();
    }
  }

  async function withRetries(operation, call) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await once(operation, call);
      } catch (error) {
        if (error?.code !== 'throttled' || attempt >= attempts) throw error;
        const ceiling = BACKOFF_MS * 2 ** (attempt - 1);
        const wait = Math.round(ceiling / 2 + (random() * ceiling) / 2);
        log({ level: 'info', event: 'aws_throttled_retry', operation, attempt, waitMs: wait });
        await sleep(wait);
      }
    }
  }

  // Every method looks its target up when called, as app.mjs guarded() does.
  const adapter = {};
  for (const name of Object.keys(aws)) {
    if (typeof aws[name] === 'function') adapter[name] = (...args) => aws[name](...args);
  }
  // A read that starts after a job was created or cancelled must not share one from before.
  for (const method of ['createJob', 'cancelJob']) {
    if (typeof aws[method] !== 'function') continue;
    adapter[method] = (...args) => {
      shared.clear();
      return aws[method](...args);
    };
  }
  for (const [method, operation] of PACED) {
    if (typeof aws[method] !== 'function') continue;
    adapter[method] = (...args) => {
      const key = `${method} ${JSON.stringify(args)}`;
      const pending = shared.get(key);
      if (pending !== undefined) return pending;
      const promise = withRetries(operation, () => aws[method](...args)).finally(() => shared.delete(key));
      shared.set(key, promise);
      return promise;
    };
  }
  return Object.freeze(adapter);
}
