// Tests for a board's position from Wi-Fi: what a scan may hold (src/lib/position.mjs), what the
// location function does with it (src/locator.mjs), and how the API gives it back
// (src/handlers/location.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HISTORY_KEPT,
  SOLVE_FLOOR_MS,
  apSetHash,
  decide,
  distanceMetres,
  emptyLocation,
  estimateRequest,
  isFixedBssid,
  isMove,
  locationFromItem,
  metres,
  positionFromGeoJson,
  readScan,
  withAnswer,
} from '../src/lib/position.mjs';
import { createLocator } from '../src/locator.mjs';
import { createFakeAws, createTestConsole } from './fake-aws.mjs';

const THING = 'cranium-0123456789abcdef';
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const A = 'a4:2b:b0:12:34:56';
const B = 'f0:9f:c2:65:43:21';
const C = '00:1a:2b:3c:4d:5e';
const scan = (changes = {}) => ({
  aps: [
    { mac: A, rss: -51 },
    { mac: B, rss: -70 },
  ],
  boot: 42,
  t: 61_234,
  thing: THING,
  received: NOW - 300,
  ...changes,
});
const read = (changes) => readScan(scan(changes), { nowMs: NOW });
// A GeoJSON answer as AWS IoT Core Device Location documents it.
const geo = (lon, lat, accuracy = 40) =>
  JSON.stringify({
    coordinates: [lon, lat, 12.5],
    type: 'Point',
    properties: {
      horizontalAccuracy: accuracy,
      horizontalConfidenceLevel: 0.68,
      timestamp: '2026-11-04T12:00:00.123Z',
    },
  });
// Places near a campus, and one 1.3 km away.
const LEVINE = [-75.191, 39.9522];
const TOWNE = [-75.1904, 39.9518];
const PENNOVATION = [-75.2022, 39.9437];

// What a scan may hold.

test('a scan of 2 to 10 globally administered access points is read, in lower case, with a hash of the set', () => {
  const made = read();
  assert.equal(made.thing, THING);
  assert.equal(made.count, 2);
  assert.deepEqual(made.aps, [
    { mac: A, rss: -51 },
    { mac: B, rss: -70 },
  ]);
  assert.match(made.hash, /^[0-9a-f]{16}$/);
  assert.equal(made.receivedMs, NOW - 300);
  // The same set in another order or case is the same hash; another set or another board is not.
  assert.equal(
    read({
      aps: [
        { mac: B.toUpperCase(), rss: -60 },
        { mac: A, rss: -40 },
      ],
    }).hash,
    made.hash
  );
  assert.notEqual(
    read({
      aps: [
        { mac: A, rss: -51 },
        { mac: C, rss: -70 },
      ],
    }).hash,
    made.hash
  );
  assert.notEqual(apSetHash('cranium-fedcba9876543210', made.aps), made.hash);
  const ten = Array.from({ length: 10 }, (_, index) => ({
    mac: `00:11:22:33:44:${String(index).padStart(2, '0')}`,
    rss: -40 - index,
  }));
  assert.equal(read({ aps: ten }).count, 10);
});

test('only a unicast, globally administered BSSID says where a board is', () => {
  assert.equal(isFixedBssid(A), true);
  assert.equal(isFixedBssid('A4:2B:B0:12:34:56'), true);
  // The second-lowest bit of the first byte: locally administered (a phone's hotspot, a random address).
  for (const mac of ['02:5e:a1:00:00:01', 'a6:2b:b0:12:34:56', 'da:a1:19:00:00:01'])
    assert.equal(isFixedBssid(mac), false, mac);
  // The lowest bit: a group address, never an access point.
  assert.equal(isFixedBssid('01:00:5e:00:00:01'), false);
  assert.equal(isFixedBssid('00:00:00:00:00:00'), false);
  for (const mac of [
    'a42bb0123456',
    'a4-2b-b0-12-34-56',
    'a4:2b:b0:12:34',
    'a4:2b:b0:12:34:5g',
    ' a4:2b:b0:12:34:56',
    7,
  ]) {
    assert.equal(isFixedBssid(mac), false, String(mac));
  }
});

test('a scan that breaks the contract is refused whole, and says why', () => {
  const cases = [
    [
      {
        aps: [
          { mac: '02:5e:a1:00:00:01', rss: -50 },
          { mac: B, rss: -60 },
        ],
      },
      'not_global',
    ],
    [
      {
        aps: [
          { mac: 'a4-2b-b0-12-34-56', rss: -50 },
          { mac: B, rss: -60 },
        ],
      },
      'bad_mac',
    ],
    [
      {
        aps: [
          { mac: A, rss: -121 },
          { mac: B, rss: -60 },
        ],
      },
      'bad_rss',
    ],
    [
      {
        aps: [
          { mac: A, rss: 1 },
          { mac: B, rss: -60 },
        ],
      },
      'bad_rss',
    ],
    [
      {
        aps: [
          { mac: A, rss: -50.5 },
          { mac: B, rss: -60 },
        ],
      },
      'bad_rss',
    ],
    [
      {
        aps: [
          { mac: A, rss: '-50' },
          { mac: B, rss: -60 },
        ],
      },
      'bad_rss',
    ],
    [
      {
        aps: [
          { mac: A, rss: -50 },
          { mac: A.toUpperCase(), rss: -60 },
        ],
      },
      'repeated_mac',
    ],
    [
      {
        aps: [
          { mac: A, rss: -50, ssid: 'Lab' },
          { mac: B, rss: -60 },
        ],
      },
      'bad_access_point',
    ],
    [{ aps: [{ mac: A }, { mac: B, rss: -60 }] }, 'bad_access_point'],
    [
      {
        aps: Array.from({ length: 11 }, (_, i) => ({ mac: `00:11:22:33:44:${String(i).padStart(2, '0')}`, rss: -50 })),
      },
      'too_many',
    ],
    [{ aps: 'a4:2b:b0:12:34:56' }, 'no_access_points'],
    [{ boot: -1 }, 'bad_count'],
    [{ boot: 1.5 }, 'bad_count'],
    [{ t: '61234' }, 'bad_count'],
    [{ ssid: 'Lab 2.4' }, 'unexpected_field'],
    [{ thing: 'someone-else' }, 'not_a_board'],
  ];
  for (const [changes, why] of cases) assert.deepEqual(read(changes), { ignored: why }, JSON.stringify(changes));
  assert.deepEqual(readScan(null, { nowMs: NOW }), { ignored: 'not_an_object' });
  assert.deepEqual(readScan([], { nowMs: NOW }), { ignored: 'not_an_object' });
});

test('fewer than two access points is noted as too few, and the time of arrival must be believable', () => {
  assert.deepEqual(read({ aps: [{ mac: A, rss: -50 }] }), { thing: THING, tooFew: 1, receivedMs: NOW - 300 });
  assert.deepEqual(read({ aps: [] }), { thing: THING, tooFew: 0, receivedMs: NOW - 300 });
  for (const received of [NOW - 2 * 86_400_000, 'now', null, 1.5]) assert.equal(read({ received }).receivedMs, NOW);
});

test("the request to AWS is the Wi-Fi solver's, with BSSID and signal only", () => {
  assert.deepEqual(estimateRequest(read().aps), {
    WiFiAccessPoints: [
      { MacAddress: A, Rss: -51 },
      { MacAddress: B, Rss: -70 },
    ],
  });
});

test('the GeoJSON answer gives latitude, longitude and accuracy in metres', () => {
  assert.deepEqual(positionFromGeoJson(geo(13.376077, 52.51823, 303)), {
    lat: 52.51823,
    lon: 13.376077,
    accuracy: 303,
  });
  // Rounded to six places and whole metres, at least one.
  assert.deepEqual(positionFromGeoJson(geo(-75.19101234567, 39.95221234567, 0.2)), {
    lat: 39.952212,
    lon: -75.191012,
    accuracy: 1,
  });
  assert.deepEqual(positionFromGeoJson(JSON.parse(geo(1, 2, 3))), { lat: 2, lon: 1, accuracy: 3 });
  for (const bad of [
    '',
    '{',
    'null',
    JSON.stringify({ type: 'Polygon', coordinates: [1, 2] }),
    JSON.stringify({ type: 'Point', coordinates: [200, 2], properties: { horizontalAccuracy: 1 } }),
    JSON.stringify({ type: 'Point', coordinates: [1, 95], properties: { horizontalAccuracy: 1 } }),
    JSON.stringify({ type: 'Point', coordinates: [1, 2] }),
    JSON.stringify({ type: 'Point', coordinates: [1, 2], properties: { horizontalAccuracy: -4 } }),
    JSON.stringify({ type: 'Point', coordinates: ['1', 2], properties: { horizontalAccuracy: 4 } }),
  ]) {
    assert.equal(positionFromGeoJson(bad), null, bad);
  }
});

test('distances, and what counts as a move: over 1 km, and further than both uncertainties together', () => {
  const at = (lon, lat, accuracy = 40) => ({ lat, lon, accuracy });
  assert.ok(Math.abs(distanceMetres(at(...LEVINE), at(...PENNOVATION)) - 1343) < 5);
  assert.ok(distanceMetres(at(...LEVINE), at(...TOWNE)) < 100);
  assert.equal(isMove(at(...LEVINE), at(...PENNOVATION)), true);
  assert.equal(isMove(at(...LEVINE), at(...TOWNE)), false);
  // Two fixes 1.3 km apart that are each only good to 800 m are not a move.
  assert.equal(isMove(at(...LEVINE, 800), at(...PENNOVATION, 800)), false);
  assert.equal(isMove(null, at(...LEVINE)), false);
  assert.deepEqual([metres(40.4), metres(1343), metres(12_400)], ['40 m', '1.3 km', '12 km']);
});

test('at most one solve per board in 10 minutes, and none while it hears the same access points', () => {
  const first = read();
  const item = emptyLocation(THING);
  assert.deepEqual(decide(item, first, NOW), { act: 'solve' });
  const solved = withAnswer({ ...item, apHash: first.hash, seenAt: NOW - 1000, outcome: 'pending' }, first, {
    lat: 1,
    lon: 2,
    accuracy: 30,
  }).item;
  assert.deepEqual(decide(solved, first, NOW), { act: 'drop', why: 'too_soon' });
  assert.deepEqual(decide(solved, first, NOW - 1000 + SOLVE_FLOOR_MS), { act: 'confirm' });
  const other = read({
    aps: [
      { mac: A, rss: -51 },
      { mac: C, rss: -70 },
    ],
  });
  assert.deepEqual(decide(solved, other, NOW - 1000 + SOLVE_FLOOR_MS), { act: 'solve' });
  // A set AWS could not place is not asked about again; one whose solve failed or never finished is.
  const later = NOW + SOLVE_FLOOR_MS;
  assert.deepEqual(decide({ ...solved, outcome: 'unsolved' }, first, later), {
    act: 'drop',
    why: 'same_access_points',
  });
  assert.deepEqual(decide({ ...solved, outcome: 'failed' }, first, later), { act: 'solve' });
  assert.deepEqual(decide({ ...solved, outcome: 'pending' }, first, later), { act: 'solve' });
  assert.deepEqual(decide(solved, read({ aps: [] }), later), { act: 'too_few' });
});

test('the history keeps the 20 newest positions, newest first', () => {
  let item = emptyLocation(THING);
  for (let index = 0; index < 25; index += 1) {
    const at = read({ received: NOW - (25 - index) * 1000 });
    item = withAnswer(item, at, { lat: 39 + index / 1000, lon: -75, accuracy: 20 }).item;
  }
  assert.equal(item.history.length, HISTORY_KEPT);
  assert.equal(item.history[0].lat, 39.024);
  assert.equal(item.history.at(-1).lat, 39.005);
  assert.deepEqual(item.position, item.history[0]);
});

// The location function.

/** A location function on the stand-in, with a solver that answers by the access points it is given. */
function locator({ answer = () => ({ found: true, geoJson: geo(...LEVINE) }), raised = [] } = {}) {
  const clock = { ms: NOW };
  const fake = createFakeAws({ now: () => clock.ms });
  const solves = [];
  fake.setSolver((request) => {
    solves.push(request);
    return answer(request);
  });
  const logs = [];
  const handler = createLocator({
    store: fake.locationStore(),
    alerts: {
      raise: async (alert) => {
        raised.push(alert);
        return 1;
      },
    },
    now: () => clock.ms,
    randomHex: () => 'abcdef',
    log: (line) => logs.push(line),
  });
  return { fake, handler, solves, logs, clock, raised, item: () => fake.locationStore().getLocation(THING) };
}

test('a first scan is solved once, kept with its time, and makes a "located" event', async () => {
  const { fake, handler, solves, item } = locator();
  assert.deepEqual(await handler(scan()), { outcome: 'first' });
  assert.deepEqual(solves, [
    {
      WiFiAccessPoints: [
        { MacAddress: A, Rss: -51 },
        { MacAddress: B, Rss: -70 },
      ],
    },
  ]);
  const stored = await item();
  assert.deepEqual(stored.position, {
    lat: 39.9522,
    lon: -75.191,
    accuracy: 40,
    at: new Date(NOW - 300).toISOString(),
  });
  assert.equal(stored.history.length, 1);
  assert.deepEqual([stored.status, stored.outcome, stored.apCount, stored.rev], ['ok', 'ok', 2, 2]);
  const events = fake.eventItems(THING);
  assert.deepEqual(
    events.map((event) => [event.kind, event.what, event.level]),
    [['health', 'located', 'info']]
  );
  assert.equal(events[0].text, 'Position found from Wi-Fi, to within 40 m');
  assert.equal(events[0].sk, `E#${new Date(NOW - 300).toISOString()}#abcdef`);
});

test('no BSSID and no signal is kept anywhere: only their number and the hash of the set', async () => {
  const { fake, handler, logs } = locator();
  await handler(scan());
  const everything = JSON.stringify([fake.eventItems('LOC'), fake.eventItems(THING), logs]);
  for (const text of [A, B, A.replaceAll(':', ''), '-51', '-70']) assert.equal(everything.includes(text), false, text);
  assert.match(everything, /"apHash":"[0-9a-f]{16}"/);
});

test('the throttle: the same message twice, a second scan within 10 minutes, the same access points again', async () => {
  const { handler, solves, clock, item } = locator();
  await handler(scan());
  assert.deepEqual(await handler(scan()), { outcome: 'too_soon' });
  clock.ms += 5 * 60_000;
  assert.deepEqual(
    await handler(
      scan({
        received: clock.ms,
        aps: [
          { mac: C, rss: -40 },
          { mac: B, rss: -70 },
        ],
      })
    ),
    { outcome: 'too_soon' }
  );
  clock.ms += 6 * 60_000;
  // The same set after 11 minutes: the position still holds, and is not asked for again.
  assert.deepEqual(await handler(scan({ received: clock.ms })), { outcome: 'confirm' });
  assert.equal(solves.length, 1);
  const stored = await item();
  assert.equal(stored.checkedAt, new Date(clock.ms).toISOString());
  assert.equal(stored.history.length, 1);
  // Another set, 10 minutes later still: asked.
  clock.ms += SOLVE_FLOOR_MS;
  await handler(
    scan({
      received: clock.ms,
      aps: [
        { mac: C, rss: -40 },
        { mac: B, rss: -70 },
      ],
    })
  );
  assert.equal(solves.length, 2);
});

test('two copies at once solve once: the claim is a conditional write', async () => {
  const { handler, solves } = locator();
  const outcomes = await Promise.all([handler(scan()), handler(scan())]);
  assert.deepEqual(outcomes.map((outcome) => outcome.outcome).sort(), ['first', 'raced']);
  assert.equal(solves.length, 1);
});

test('a move of more than 1 km is an event and an alert; a few metres is neither', async () => {
  let place = LEVINE;
  const { fake, handler, clock, raised } = locator({ answer: () => ({ found: true, geoJson: geo(...place, 35) }) });
  await handler(scan());
  clock.ms += SOLVE_FLOOR_MS;
  place = TOWNE;
  assert.deepEqual(
    await handler(
      scan({
        received: clock.ms,
        aps: [
          { mac: C, rss: -40 },
          { mac: B, rss: -70 },
        ],
      })
    ),
    { outcome: 'solved' }
  );
  clock.ms += SOLVE_FLOOR_MS;
  place = PENNOVATION;
  assert.deepEqual(
    await handler(
      scan({
        received: clock.ms,
        aps: [
          { mac: A, rss: -40 },
          { mac: C, rss: -70 },
        ],
      })
    ),
    { outcome: 'moved' }
  );
  const moved = fake.eventItems(THING).filter((event) => event.what === 'moved');
  assert.equal(moved.length, 1);
  assert.equal(moved[0].level, 'warn');
  assert.match(moved[0].text, /^Moved 1\.\d km from where it was, to within 35 m$/);
  assert.deepEqual(
    raised.map((alert) => [alert.kind, alert.thing, alert.text]),
    [['moved', THING, moved[0].text]]
  );
  // No coordinate in the event or the alert.
  assert.doesNotMatch(JSON.stringify([moved, raised]), /39\.9|75\.1|75\.2/);
});

test('a scan AWS cannot place, too few access points, and a solve that fails are each noted, and nothing is retried at once', async () => {
  const unplaced = locator({ answer: () => ({ found: false }) });
  assert.deepEqual(await unplaced.handler(scan()), { outcome: 'unsolved' });
  assert.deepEqual(locationFromItem(await unplaced.item()), {
    status: 'unsolved',
    at: new Date(NOW - 300).toISOString(),
    apCount: 2,
    checkedAt: null,
  });
  assert.equal(unplaced.fake.eventItems(THING).length, 0);

  const few = locator();
  assert.deepEqual(await few.handler(scan({ aps: [{ mac: A, rss: -50 }] })), { outcome: 'too_few' });
  assert.deepEqual([(await few.item()).status, (await few.item()).apCount], ['too_few', 1]);
  assert.equal(few.solves.length, 0);

  const broken = locator({
    answer: () => {
      throw new Error('GetPositionEstimate: InternalServerException');
    },
  });
  assert.deepEqual(await broken.handler(scan()), { outcome: 'failed' });
  assert.equal((await broken.item()).status, 'failed');
  assert.equal(
    broken.logs.some((line) => line.event === 'solve_failed' && line.thing === THING),
    true
  );
  // After the floor, the same access points are asked about again.
  broken.clock.ms += SOLVE_FLOOR_MS;
  await broken.handler(scan({ received: broken.clock.ms }));
  assert.equal(broken.solves.length, 2);
});

test('a scan that breaks the contract is not solved and not stored, and the log says why without what', async () => {
  const { fake, handler, solves, logs } = locator();
  assert.deepEqual(
    await handler(
      scan({
        aps: [
          { mac: '02:5e:a1:00:00:01', rss: -50 },
          { mac: B, rss: -60 },
        ],
      })
    ),
    { outcome: 'ignored' }
  );
  assert.equal(solves.length, 0);
  assert.equal(fake.eventItems('LOC').length, 0);
  assert.deepEqual(logs, [{ level: 'warn', event: 'scan_ignored', reason: 'not_global' }]);
});

// What the API gives back.

test('the boards carry their position, and GET /api/devices/{thing}/positions the last 20', async () => {
  const console_ = createTestConsole({ startMs: NOW });
  const viewer = console_.addUser('viewer', ['viewers']);
  const other = 'cranium-fedcba9876543210';
  console_.fake.addThing(THING);
  console_.fake.addThing(other);
  console_.fake.setSolver(() => ({ found: true, geoJson: geo(...LEVINE, 25) }));
  await console_.fake.locate(THING, { aps: scan().aps, received: NOW });

  const list = await console_.call('GET', '/api/devices', { as: viewer });
  assert.equal(list.status, 200);
  const byThing = Object.fromEntries(list.body.devices.map((device) => [device.thing, device]));
  const at = new Date(NOW).toISOString();
  assert.deepEqual(byThing[THING].position, { lat: 39.9522, lon: -75.191, accuracy: 25, at });
  assert.deepEqual(byThing[THING].location, { status: 'ok', at, apCount: 2, checkedAt: at, bluetoothOnly: false });
  assert.deepEqual(byThing[other].position, null);
  assert.equal(byThing[other].location.status, 'none');

  const one = await console_.call('GET', `/api/devices/${THING}`, { as: viewer });
  assert.deepEqual(one.body.device.position, byThing[THING].position);

  const history = await console_.call('GET', `/api/devices/${THING}/positions`, { as: viewer });
  const { bluetoothOnly: _type, ...location } = byThing[THING].location;
  assert.deepEqual(history.body, { thing: THING, location, positions: [byThing[THING].position] });
  assert.equal(
    (await console_.call('GET', '/api/devices/cranium-1111111111111111/positions', { as: viewer })).status,
    404
  );
  assert.equal((await console_.call('GET', '/api/devices/nope/positions', { as: viewer })).status, 400);
});

test('positions that cannot be read leave the list of boards as it is, and say so in the log', async () => {
  const console_ = createTestConsole({ startMs: NOW });
  const viewer = console_.addUser('viewer', ['viewers']);
  console_.fake.addThing(THING);
  console_.fake.failNext('listLocations');
  const list = await console_.call('GET', '/api/devices', { as: viewer });
  assert.equal(list.status, 200);
  assert.deepEqual([list.body.devices[0].position, list.body.devices[0].location.status], [null, 'unknown']);
  assert.equal(
    console_.logs.some((line) => line.event === 'positions_unreadable'),
    true
  );
});
