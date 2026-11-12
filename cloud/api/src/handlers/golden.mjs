/**
 * Golden image promotion (console 2.27.5, firmware 1.22.0; firmware/README.md "Golden image").
 *
 *   POST /api/firmware/{version}/golden   { "record": "<base64 of the 130-byte record>" }
 *        A release manager uploads the promotion record that tools/golden_promote.py signed offline
 *        for this release. It is kept only if its signature is good with the golden PUBLIC key of
 *        the stack, it names this release's image (hash TLV, size, version), the release is active,
 *        and its counter is above every other release's: boards only take a counter above the last
 *        one they took. Once per release. On record as firmware.golden_record.
 *
 *   POST /api/golden/promotions   { "version": "1.19.2+0", "things": [...], "note": "..." }
 *        Makes that release the golden image on those boards: one AWS IoT job with the record
 *        (lib/golden.mjs). The console picks the boards of a group or the fleet. Each board's
 *        bootloader checks the record again and seals the image only if the board runs it and has
 *        confirmed it. On record as golden.promote.
 *
 *   GET  /api/golden/promotions
 *        The latest promotions with their counts, and whether the stack has a golden key.
 *
 * Each board's golden image is in its own report: Device.golden (lib/golden.mjs readGolden).
 */

import { conflict, field, notFound, unprocessable } from '../http.mjs';
import { change } from '../lib/audit.mjs';
import {
  RecordError,
  buildGoldenDocument,
  buildGoldenJobId,
  mismatch,
  parseGoldenJobId,
  parseRecord,
  signatureOk,
} from '../lib/golden.mjs';
import {
  IN_PROGRESS_TIMEOUT_MIN,
  MAX_IN_FLIGHT,
  URL_EXPIRES_SEC,
  buildJobDescription,
  countExecutions,
  isActiveExecution,
  isoTime,
  mapLimit,
  parseJobDescription,
} from '../lib/jobs.mjs';
import { MAX_NOTE, requireBase64, requireText, requireThings, requireVersion } from '../lib/validate.mjs';
import { releaseFromItem, releaseKey } from './firmware.mjs';

const LIST_LIMIT = 10;
const MAX_BOARDS_NAMED = 200;

function noKey() {
  return conflict(
    'golden_key_missing',
    'This console has no golden public key yet: deploy it with firmware/keys/golden_promote_pub.pem in place.'
  );
}

export function createGoldenHandlers({ aws, config, now, randomHex }, { devices, fleet = null }) {
  async function findRelease(version) {
    const release = releaseFromItem(await aws.getRelease(releaseKey(version.parts)));
    if (release === null || release.version !== version.text) {
      throw notFound('unknown_version', `There is no release ${version.text}.`);
    }
    return release;
  }

  /** The highest counter of any release's record, or 0. */
  async function highestCounter() {
    let highest = 0;
    for (const item of await aws.listReleases()) {
      const counter = releaseFromItem(item)?.golden?.counter ?? 0;
      if (counter > highest) highest = counter;
    }
    return highest;
  }

  /** Boards with a job they have not finished: a promotion waits for an idle board. */
  async function busyOf(things) {
    const listed = await mapLimit(things, MAX_IN_FLIGHT, (thing) => aws.listJobExecutionsForThing(thing));
    return things.filter((thing, index) => listed[index].some((execution) => isActiveExecution(execution.status)));
  }

  async function summaryOf(jobId) {
    const parsed = parseGoldenJobId(jobId);
    const job = parsed === null ? null : await aws.describeJob(jobId);
    if (job === null) return null;
    const executions = await aws.listJobExecutionsForJob(jobId);
    const { createdBy, note } = parseJobDescription(job.description);
    return {
      id: parsed.id,
      version: parsed.version,
      counter: parsed.counter,
      status: job.status,
      createdAt: isoTime(job.createdAt),
      createdBy,
      note,
      things: [...(job.things ?? [])].sort(),
      counts: countExecutions(executions),
    };
  }

  return {
    async uploadRecord({ actor, params, json, entry }) {
      // A "+" in a path may arrive as a space (handlers/firmware.mjs, versionInPath).
      const version = requireVersion(
        typeof params.version === 'string' ? params.version.replaceAll(' ', '+') : params.version
      );
      entry.target = version.text;
      if (config.goldenKey === null) throw noKey();
      const bytes = requireBase64(field(json(), 'record'), 'record');

      let record;
      try {
        record = parseRecord(bytes);
      } catch (error) {
        if (error instanceof RecordError) throw unprocessable('invalid_record', error.message);
        throw error;
      }
      entry.detail.counter = String(record.counter);
      if (!signatureOk(record, config.goldenKey)) {
        throw unprocessable(
          'bad_signature',
          "The record's signature does not verify with this console's golden key. Sign it with the golden key " +
            'that matches firmware/keys/golden_promote_pub.pem.'
        );
      }

      const release = await findRelease(version);
      if (release.status !== 'active') {
        throw conflict('release_revoked', `Release ${version.text} is revoked and cannot become golden.`);
      }
      const wrong = mismatch(record, release);
      if (wrong !== null) throw unprocessable('record_mismatch', wrong);
      if (release.golden !== undefined) {
        throw conflict('golden_record_exists', `Release ${version.text} has a promotion record already.`);
      }
      const highest = await highestCounter();
      if (record.counter <= highest) {
        throw conflict(
          'counter_not_higher',
          `The record's counter is ${record.counter}, and a release has ${highest} already: sign it again with a ` +
            'higher one, or boards that took that one refuse it.'
        );
      }

      const stored = await aws.setReleaseGolden({
        sk: releaseKey(version.parts),
        golden: {
          record: bytes.toString('base64'),
          counter: record.counter,
          uploadedBy: { sub: actor.sub, email: actor.email },
          uploadedAt: new Date(now()).toISOString(),
        },
      });
      if (!stored.ok) {
        throw conflict(
          'golden_record_exists',
          `Release ${version.text} has a promotion record already, or is revoked.`
        );
      }
      change(entry, 'golden', null, `counter ${record.counter}`);
      return { status: 201, body: { release: releaseFromItem(stored.release) } };
    },

    async promote({ actor, json, entry }) {
      const body = json();
      const version = requireVersion(field(body, 'version'));
      entry.target = version.text;
      entry.detail.version = version.text;
      const things = requireThings(field(body, 'things'));
      entry.detail.things = String(things.length);
      const named = things.join(' ');
      if (named.length <= MAX_BOARDS_NAMED) entry.detail.boards = named;
      const note = requireText(field(body, 'note'), 'note', { max: MAX_NOTE });
      if (config.goldenKey === null) throw noKey();

      const item = await aws.getRelease(releaseKey(version.parts));
      const release = releaseFromItem(item);
      if (release === null || release.version !== version.text) {
        throw notFound('unknown_version', `There is no release ${version.text}.`);
      }
      if (release.status !== 'active') {
        throw conflict('release_revoked', `Release ${version.text} is revoked and cannot become golden.`);
      }
      if (release.golden === undefined) {
        throw conflict('no_golden_record', `Release ${version.text} has no promotion record: upload one first.`);
      }
      const bytes = Buffer.from(item.golden.record, 'base64');
      // Checked on upload; once more, as what goes to the boards.
      const record = parseRecord(bytes);
      if (!signatureOk(record, config.goldenKey) || mismatch(record, release) !== null) {
        throw conflict('golden_record_invalid', `The promotion record of ${version.text} no longer verifies.`);
      }
      entry.detail.counter = String(record.counter);

      const members = new Set(await devices.groupThings());
      const strangers = things.filter((thing) => !members.has(thing));
      if (strangers.length > 0) {
        throw unprocessable('unknown_device', `Not registered boards: ${strangers.join(', ')}.`);
      }
      // Of the release's board type, and able to take a job at all (docs/fleet.md, Board types).
      if (fleet !== null) await fleet.requireJobTargets(things, release);
      const busy = await busyOf(things);
      if (busy.length > 0) {
        throw conflict('device_busy', `These boards are busy with another job: ${busy.join(', ')}.`, { busy });
      }

      const description = buildJobDescription({ email: actor.email, sub: actor.sub, note });
      const document = buildGoldenDocument(bytes);
      let id = null;
      for (let attempt = 0; attempt < 3 && id === null; attempt += 1) {
        const candidate = buildGoldenJobId(release.version, record.counter, now(), String(randomHex(4)).slice(0, 4));
        const created = await aws.createJob({
          jobId: candidate,
          things,
          document,
          description,
          urlExpiresInSec: URL_EXPIRES_SEC,
          inProgressTimeoutMinutes: IN_PROGRESS_TIMEOUT_MIN,
        });
        if (created.ok) id = candidate;
        else if (created.reason === 'target_not_found') {
          throw unprocessable('unknown_device', 'One of the chosen boards is no longer registered.');
        } else if (created.reason !== 'exists') {
          throw new Error(`The job could not be created: ${String(created.reason)}`);
        }
      }
      if (id === null) throw new Error('No free job id after three attempts');
      entry.target = id;
      change(entry, 'promotion', null, id);
      return { status: 201, body: { promotion: await summaryOf(id) } };
    },

    async list() {
      const jobs = (await aws.listJobs())
        .filter((job) => parseGoldenJobId(job.jobId) !== null)
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .slice(0, LIST_LIMIT);
      const promotions = (await mapLimit(jobs, MAX_IN_FLIGHT, (job) => summaryOf(job.jobId))).filter(
        (summary) => summary !== null
      );
      return {
        body: {
          promotions,
          goldenKey: { present: config.goldenKey !== null, fingerprint: config.goldenKeyFingerprint },
        },
      };
    },
  };
}
