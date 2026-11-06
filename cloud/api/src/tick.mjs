/**
 * What the schedule runs every minute (rollouts-tick.mjs, infra/template.yaml RolloutTickFn): the
 * staged rollouts are moved on (handlers/rollouts.mjs advance). The same handlers as the API's, on
 * the same adapter, with no request around them: nothing here is reachable from the internet, and
 * whatever invokes it can only make the rollouts take the step they are due to take anyway.
 *
 * What it changes goes on record as the console's (rollout.advance, rollout.stop), with no person.
 * A rollout that stops by itself (its canary failed, or AWS IoT aborted its waves) is also an e-mail
 * alert of kind "deployment", when it is given the alerter (alerts.mjs).
 */

import { randomBytes } from 'node:crypto';

import { createAuditHandlers } from './handlers/audit.mjs';
import { createDeploymentHandlers } from './handlers/deployments.mjs';
import { createDeviceHandlers } from './handlers/devices.mjs';
import { createFleetHandlers } from './handlers/fleet.mjs';
import { createRolloutHandlers, runRolloutTick } from './handlers/rollouts.mjs';

/**
 * @param {object} options
 * @param {object} options.aws      the AWS adapter (src/aws.mjs or test/fake-aws.mjs)
 * @param {object} options.config   the result of loadConfig (src/config.mjs)
 * @param {{ raise: (alert: object) => Promise<number> }} [options.alerts]  the alerter (alerts.mjs)
 * @returns {() => Promise<object>} one run: { checked, advanced, stopped, done, failed }
 */
export function createRolloutTick({
  aws,
  config,
  alerts = null,
  now = Date.now,
  randomHex = (count) => randomBytes(count).toString('hex'),
  log = (line) => console.log(JSON.stringify(line)),
}) {
  const alert = alerts === null ? null : (raised) => alerts.raise(raised);
  const context = { aws, config, now, randomHex, log, alert };
  const devices = createDeviceHandlers(context);
  const fleet = createFleetHandlers(context, { devices });
  const deployments = createDeploymentHandlers(context, { devices, fleet });
  const audit = createAuditHandlers(context);
  const rollouts = createRolloutHandlers(context, { devices, deployments, fleet, audit });
  return () => runRolloutTick(rollouts, log);
}
