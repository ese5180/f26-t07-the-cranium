/**
 * What the schedule runs every minute (rollouts-tick.mjs, infra/template.yaml RolloutTickFn): the
 * staged rollouts are moved on (handlers/rollouts.mjs advance). The same handlers as the API's, on
 * the same adapter, with no request around them: nothing here is reachable from the internet, and
 * whatever invokes it can only make the rollouts take the step they are due to take anyway.
 *
 * What it changes goes on record as the console's (rollout.advance, rollout.stop), with no person.
 * A rollout that stops by itself (its canary failed, or AWS IoT aborted its waves) is also an e-mail
 * alert of kind "deployment", when it is given the alerter (alerts.mjs).
 *
 * From console 2.13.0 it also reads Memfault, through the same cached reads as the console's Memfault
 * pages (handlers/memfault.mjs): for the health gate of each staged rollout, and, at most every 5
 * minutes, for the alert rules "issue", "crashloop" and "voltage" (alerts.mjs watch). Neither changes
 * what a run returns.
 *
 * From console 2.15.0 it also stores the fleet health score's snapshot of the day (docs/fleet-health.md,
 * handlers/fleet.mjs snapshot): on the first run of each UTC day, once, on the condition that keeps the first.
 * A snapshot that cannot be made is logged and tried again on the next run; it never holds up the rollouts.
 *
 * From console 2.19.0 it first starts the scheduled starts that are due (handlers/schedules.mjs startDue):
 * a deployment, a staged rollout or a roll back to last good, through the same handlers as a start by
 * hand, each claimed by a conditional write so that it starts once. A roll back to last good reads the
 * boards' update histories for its plan, read only.
 */

import { randomBytes } from 'node:crypto';

import { createDirectory } from './auth.mjs';
import { createAuditHandlers } from './handlers/audit.mjs';
import { createDeploymentHandlers } from './handlers/deployments.mjs';
import { createDeviceHandlers } from './handlers/devices.mjs';
import { createFleetHandlers } from './handlers/fleet.mjs';
import { createMemfaultHandlers } from './handlers/memfault.mjs';
import { createRolloutHandlers, runRolloutTick } from './handlers/rollouts.mjs';
import { createScheduleHandlers } from './handlers/schedules.mjs';
import { createUpdateHandlers } from './handlers/updates.mjs';
import { pace } from './lib/iot-pace.mjs';

/**
 * @param {object} options
 * @param {object} options.aws      the AWS adapter (src/aws.mjs or test/fake-aws.mjs)
 * @param {object} options.config   the result of loadConfig (src/config.mjs)
 * @param {{ raise: (alert: object) => Promise<number>, watch?: (source: object) => Promise<number> }}
 *        [options.alerts]  the alerter (alerts.mjs)
 * @returns {() => Promise<object>} one run: { checked, advanced, stopped, done, failed }
 */
export function createRolloutTick({
  aws,
  config,
  alerts = null,
  now = Date.now,
  randomHex = (count) => randomBytes(count).toString('hex'),
  log = (line) => console.log(JSON.stringify(line)),
  pacing = {},
}) {
  const alert = alerts === null ? null : (raised) => alerts.raise(raised);
  // AWS IoT's job reads, paced and retried when throttled (lib/iot-pace.mjs).
  const context = { aws: pace(aws, { log, ...pacing }), config, now, randomHex, log, alert };
  const devices = createDeviceHandlers(context);
  const memfault = createMemfaultHandlers(context, { devices });
  const fleet = createFleetHandlers(context, { devices, memfault: () => memfault });
  const deployments = createDeploymentHandlers(context, { devices, fleet });
  const audit = createAuditHandlers(context);
  // The boards' update histories, for a scheduled roll back to last good: read only. Who started or sent
  // each update is not needed for a plan, so the user pool and the activity log are not asked, and a
  // backfill is not put (the API's reads do that); the role may read the history and no more.
  const history = createUpdateHandlers(
    {
      ...context,
      aws: {
        ...context.aws,
        getUser: async () => null,
        queryAudit: async () => [],
        putUpdateFact: async () => ({ ok: true }),
      },
    },
    { devices, deployments }
  );
  const rollouts = createRolloutHandlers(context, {
    devices,
    deployments,
    fleet,
    audit,
    updates: () => history,
    memfault: () => memfault,
  });
  // A scheduled start runs as its creator: Cognito is asked first whether they still may (auth.mjs).
  const directory = createDirectory({ aws: context.aws, now, log });
  const schedules = createScheduleHandlers(context, { deployments, rollouts, audit, directory });
  return async () => {
    // Scheduled starts that are due, before the rollouts move on (handlers/schedules.mjs).
    try {
      const started = await schedules.startDue();
      if (started.due > 0) log({ event: 'schedules_due', ...started });
    } catch (error) {
      log({ level: 'error', event: 'schedules_not_read', error: String(error?.message ?? error).slice(0, 200) });
    }
    const outcome = await runRolloutTick(rollouts, log);
    if (typeof alerts?.watch === 'function') await alerts.watch(memfault);
    try {
      await fleet.snapshot();
    } catch (error) {
      log({ level: 'warn', event: 'health_snapshot_failed', error: String(error?.message ?? error).slice(0, 200) });
    }
    return outcome;
  };
}
