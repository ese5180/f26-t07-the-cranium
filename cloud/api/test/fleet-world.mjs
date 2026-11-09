// A console for the tests of the fleet (docs/fleet.md): the real handlers on the fake, trusting a
// key of the run so that images of either board type can be built and uploaded, and the schedule
// that moves staged rollouts on (src/tick.mjs), run when a test says so.
//
// This file is test code only; it has no tests of its own.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createRolloutTick } from '../src/tick.mjs';
import { createTestConsole } from './fake-aws.mjs';
import { buildImage, imageKey, keyEnv } from './images.mjs';

export const A = 'cranium-00000000000000aa';
export const B = 'cranium-00000000000000bb';
export const C = 'cranium-00000000000000cc';
export const D = 'cranium-00000000000000dd';
export const E = 'cranium-00000000000000ee';

const key = imageKey();

/** What a board on 1.13.0 reports: its version, and from its diagnostics its type. */
export function report(
  version,
  { board = null, layout = null, ota = 'idle', last = 'none', rssi = -55, uptime = 600, heap = null } = {}
) {
  return {
    fw: { version, confirmed: true },
    ota: { state: ota, progress: 0, last, error: '' },
    wifi: { rssi },
    uptime,
    ...(board === null && layout === null && heap === null
      ? {}
      : {
          diag: {
            mac: '02:00:00:00:00:01',
            channel: 6,
            ...(board === null ? {} : { board }),
            ...(layout === null ? {} : { layout }),
            ...(heap === null ? {} : { heap }),
          },
        }),
  };
}

export function fleetConsole(options = {}) {
  const console_ = createTestConsole({ ...options, env: { ...keyEnv(key), ...(options.env ?? {}) } });
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  const logs = [];
  const raised = [];
  const known = new Set();
  let draws = 0;
  const tick = createRolloutTick({
    aws: console_.fake,
    config: console_.config,
    now: () => console_.clock.ms,
    log: (line) => logs.push(line),
    // The alerter (src/alerts.mjs, tested in alerts.test.mjs), as far as the schedule sees it.
    alerts: {
      raise: async (alert) => {
        raised.push(alert);
        return 1;
      },
    },
    // Draws of its own, apart from the API's, and the same on every run.
    randomHex: (count) => {
      draws += 1;
      return createHash('sha256')
        .update(`tick ${draws}`)
        .digest('hex')
        .slice(0, 2 * count);
    },
  });
  // A query string on the path is handed over as the gateway would: decoded, apart from the path.
  const call = (method, path, body, as = manager) => {
    const [bare, search] = path.split('?');
    const query = search === undefined ? undefined : Object.fromEntries(new URLSearchParams(search));
    return console_.call(method, bare, { as, body, query });
  };

  return {
    ...console_,
    manager,
    viewer,
    call,
    tick,
    tickLogs: logs,
    /** The alerts the schedule raised, in order. */
    raised,
    image: (version, board = null, extra = {}) => buildImage({ version, key, board, ...extra }),
    /** Upload a built image and return the release. */
    async release(version, board = null, extra = {}) {
      const response = await call('POST', '/api/firmware', {
        filename: 'zephyr.signed.bin',
        data: buildImage({ version, key, board, ...extra }).toString('base64'),
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return response.body.release;
    },
    /** A nrf7002dk board on `version`, online. */
    online(thing, version = '1.0.0+0', extra = {}) {
      if (!known.has(thing)) console_.fake.addThing(thing, { attributes: extra.attributes ?? {} });
      known.add(thing);
      console_.fake.device(thing).report(report(version, extra));
    },
    /** A board without Wi-Fi: provisioned with the attribute, and never reporting. */
    bluetoothOnly(thing) {
      console_.fake.addThing(thing, { attributes: { board: 'nrf5340dk' } });
    },
    /** What a board does with a job: take it, and end it as `status`. */
    finish(job, thing, status = 'SUCCEEDED', version = null) {
      const execution = console_.fake.execution(job, thing);
      assert.equal(execution.update('IN_PROGRESS', { step: 'downloading' }).accepted, true, `${thing} took ${job}`);
      const details =
        status === 'SUCCEEDED' ? { running: version ?? '0.0.0+0' } : { reason: 'rolled_back', running: '1.0.0+0' };
      assert.equal(execution.update(status, details).accepted, true);
    },
    entries: (action) => console_.fake.auditLog().filter((entry) => entry.action === action),
  };
}
