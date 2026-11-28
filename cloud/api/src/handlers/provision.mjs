/**
 * POST /api/devices/register: provisioning through the console (docs/new-board-setup.md, "Provisioning
 * through the console"). With a session (the console's Developer pages) or an API token (/api/t/devices/register:
 * tools/provision_device.py, scripts/board/new-board.sh).
 *
 *   body   { "id": "<16 hex>", "csr": "-----BEGIN CERTIFICATE REQUEST-----...", "reregister": false }
 *          { "id": "<16 hex>", "board": "nrf5340dk" }     a board with Bluetooth only: no request, no certificate
 *   200    { thing, certificatePem, rootCa, endpoint, downloadPrefix }
 *   200    { thing }                                       for an nrf5340dk
 *
 * What tools/provision_device.py otherwise does with an AWS administrator's sign-in, so that whoever sets up a
 * board needs no access to the AWS account. `id` is the board's identifier, the 16 hex digits of its SoC that
 * its thing is named after: the thing is "cranium-<id>", and no other name is taken.
 *
 * An nRF7002 DK sends the certificate signing request it made itself (KEYGEN): its private key never leaves it,
 * and never passes through here. The request must be an ECDSA P-256 key's, signed by that key (which shows
 * whoever sent it holds the key), for CN=cranium-<id>, as the firmware makes it (lib/provision.mjs). Then, as the
 * tool does: the thing, in the project's thing group; a certificate AWS IoT issues for the request, active, with
 * the device policy, attached to that thing alone (EXCLUSIVE_THING). The certificate is checked to be for the
 * request's key before it is attached to anything. The answer is what the board needs: its certificate, Amazon
 * Root CA 1, the AWS IoT endpoint and the one prefix it may download firmware from.
 *
 * Registered before: a thing that has a certificate already is refused (409 already_registered) unless
 * `reregister` is true, as for a board that was wiped. Then its earlier certificates are retired (detached, made
 * inactive, deleted), so that a board has one identity: what provision_device.py and --new-identity do.
 *
 * An nRF5340 DK never reaches AWS by itself: a thing with the attribute board=nrf5340dk in the group, and no
 * certificate (docs/fleet.md). A thing whose attribute names another board type is refused (409).
 *
 * Release managers only, never from a phone, on record as device.register with the board type, whether the
 * thing is new, the certificate's first 16 hex digits and how many were retired. At most REGISTRATIONS_PER_HOUR
 * a person, counted from the activity log as for commands, so that it holds across every instance of the
 * function; one over that is refused with 429 and leaves no entry.
 */

import { HttpError, badRequest, conflict, field } from '../http.mjs';
import { AMAZON_ROOT_CA1, certificateFor, parseCsr } from '../lib/provision.mjs';
import { requireBoolean, requireThing } from '../lib/validate.mjs';

export const REGISTRATIONS_PER_HOUR = 20;
export const BOARD_TYPES = Object.freeze(['nrf7002dk', 'nrf5340dk']);
const DEFAULT_BOARD = 'nrf7002dk';
const FIELDS = Object.freeze(['id', 'csr', 'reregister', 'board']);
const BOARD_ID = /^[0-9a-f]{16}$/;
const HOUR_MS = 60 * 60_000;
const CERTIFICATE_ARN = /^arn:[a-z0-9-]+:iot:[a-z0-9-]+:\d{12}:cert\/([0-9a-f]{64})$/;

export function createProvisionHandlers({ aws, config, now }) {
  // The account's AWS IoT endpoint: the same for the life of the account, so asked once per instance.
  let endpoint = null;

  async function dataEndpoint() {
    if (endpoint === null) endpoint = await aws.describeDataEndpoint();
    return endpoint;
  }

  /** How many registrations this person has on record from the last hour. */
  async function recentRegistrations(sub) {
    const after = new Date(now() - HOUR_MS).toISOString();
    const items = await aws.queryAudit({ before: null, after, limit: 1000 });
    return items.filter((item) => item?.action === 'device.register' && item?.actor?.sub === sub).length;
  }

  /** The request, checked as far as it can be without AWS: { thing, board, csr, reregister }. */
  function readBody(body, entry) {
    if (Object.keys(body).some((key) => !FIELDS.includes(key))) {
      throw badRequest('unexpected_field', 'A registration has "id", "csr" and "reregister": nothing else.');
    }
    const id = field(body, 'id');
    if (typeof id !== 'string' || !BOARD_ID.test(id)) {
      throw badRequest('invalid_id', '"id" is the board\'s identifier: 16 lowercase hexadecimal digits.');
    }
    const thing = requireThing(`cranium-${id}`);
    entry.target = thing;
    const board = field(body, 'board') ?? DEFAULT_BOARD;
    if (typeof board !== 'string' || !BOARD_TYPES.includes(board)) {
      throw badRequest('invalid_board', `"board" must be one of: ${BOARD_TYPES.join(', ')}.`);
    }
    entry.detail.board = board;
    const reregister = requireBoolean(field(body, 'reregister'), 'reregister', false);
    const given = field(body, 'csr');
    if (board !== DEFAULT_BOARD) {
      if (given !== undefined) throw badRequest('unexpected_field', `An ${board} has no certificate: send no "csr".`);
      return { thing, board, csr: null, reregister };
    }
    const csr = parseCsr(given);
    if (csr === null) {
      throw badRequest(
        'invalid_csr',
        '"csr" must be the certificate signing request the board printed: PEM, an ECDSA P-256 key, ' +
          'signed with SHA-256 by that key.'
      );
    }
    if (csr.commonName !== thing) {
      throw badRequest('csr_mismatch', `The request is for another board: its CN is not ${thing}.`);
    }
    return { thing, board, csr, reregister };
  }

  async function refuseOtherType(thing, board) {
    const known = await aws.describeThing(thing);
    const said = known?.attributes?.board;
    // A thing with no type is an nRF7002 DK's (docs/fleet.md).
    if (known !== null && (said ?? DEFAULT_BOARD) !== board) {
      throw conflict('board_mismatch', `${thing} is registered as an ${said ?? DEFAULT_BOARD}, not an ${board}.`);
    }
  }

  async function registerBluetoothOnly(thing, board, entry) {
    const attributes = { board };
    const { created } = await aws.createThing({ thing, attributes });
    if (!created) await aws.updateThingAttributes({ thing, attributes });
    await aws.addThingToGroup(thing);
    entry.detail.created = created;
    return { status: 200, body: { thing } };
  }

  async function registerWithCertificate(thing, csr, reregister, entry) {
    const previous = (await aws.listThingPrincipals(thing)).filter((arn) => CERTIFICATE_ARN.test(arn));
    if (previous.length > 0 && !reregister) {
      throw conflict(
        'already_registered',
        `${thing} has a certificate already. If the board was wiped, register it again with "reregister": true, ` +
          'which retires its old certificate.'
      );
    }
    const { created } = await aws.createThing({ thing, attributes: null });
    entry.detail.created = created;
    await aws.addThingToGroup(thing);

    const issued = await aws.createCertificateFromCsr(csr.pem);
    const pem = certificateFor(issued.pem, csr.publicKey);
    if (pem === null) {
      await aws.retireCertificate({ thing: null, arn: issued.arn });
      throw new HttpError(502, 'certificate_mismatch', "AWS IoT did not issue a certificate for the board's key.");
    }
    entry.detail.certificate = issued.id.slice(0, 16);
    await aws.attachDevicePolicy(issued.arn);
    await aws.attachThingPrincipal({ thing, arn: issued.arn });

    // A board has one identity: the certificates of earlier registrations stop working.
    let retired = 0;
    for (const arn of previous) {
      if (arn === issued.arn) continue;
      await aws.retireCertificate({ thing, arn });
      retired += 1;
    }
    entry.detail.retired = retired;

    return {
      status: 200,
      body: {
        thing,
        certificatePem: pem,
        rootCa: AMAZON_ROOT_CA1,
        endpoint: await dataEndpoint(),
        downloadPrefix: config.firmwareDownloadPrefix,
      },
    };
  }

  return {
    async register({ caller, json, entry }) {
      const { thing, board, csr, reregister } = readBody(json(), entry);
      if (reregister) entry.detail.reregister = true;
      if ((await recentRegistrations(caller.sub)) >= REGISTRATIONS_PER_HOUR) {
        throw new HttpError(
          429,
          'rate_limited',
          `At most ${REGISTRATIONS_PER_HOUR} boards an hour can be registered by one person. ` +
            'Wait a while and run it again: it does only what is still missing.'
        );
      }
      await refuseOtherType(thing, board);
      return csr === null
        ? registerBluetoothOnly(thing, board, entry)
        : registerWithCertificate(thing, csr, reregister, entry);
    },
  };
}
