/**
 * GET /api/pairing/{name}: the passkey of the board that advertises as {name} over
 * Bluetooth, for a release manager's phone app (docs/mobile-apps.md).
 *
 * A board only has a window open after a person held its Button 1 for five seconds, and
 * only reports a passkey while a phone is pairing with it. The passkey is also on the
 * board's serial console, which is the only way to see it on a board that is offline. The
 * route is for release managers only, and every call goes into the activity log.
 *
 * The name is drawn anew for each window and says nothing about which board it is, so
 * every board of the project is looked at. Shadows are read fresh: a passkey changes with
 * every attempt.
 */

import { badRequest, describeError, notFound } from '../http.mjs';
import { PAIRING_NAME, pairingFromShadow } from '../lib/shadow.mjs';
import { isThing } from '../lib/validate.mjs';

export function createPairingHandlers({ aws, now, log }) {
  return {
    async get({ params, entry }) {
      const name = params.name;
      if (typeof name !== 'string' || !PAIRING_NAME.test(name)) {
        throw badRequest('invalid_name', 'A board advertises as Cranium- and four hexadecimal digits.');
      }
      entry.target = name;

      const things = [...new Set((await aws.listGroupThings()).filter(isThing))].sort();
      const settled = await Promise.allSettled(things.map((thing) => aws.getShadow(thing)));
      const found = [];
      things.forEach((thing, index) => {
        const result = settled[index];
        if (result.status === 'rejected') {
          log({ level: 'warn', event: 'shadow_unreadable', thing, error: describeError(result.reason).message });
          return;
        }
        const pairing = pairingFromShadow(result.value, now());
        if (pairing !== null && pairing.name === name) found.push({ thing, ...pairing });
      });

      // Two boards with the same four digits at once: the newest report is the one pairing now.
      found.sort((a, b) => (a.reportedAt < b.reportedAt ? 1 : -1));
      if (found.length === 0) {
        throw notFound('no_pairing', `No board online is pairing as ${name} right now. ` +
          'Its passkey is on its serial console.');
      }
      entry.detail.thing = found[0].thing;
      return { body: found[0] };
    },
  };
}
