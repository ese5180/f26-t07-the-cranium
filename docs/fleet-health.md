# Fleet health score

One number from 0 to 100 on the console's Overview that says how the fleet is doing, with its trend over the last
30 days and the four parts it is made of. Each part leads to the page that explains it. From console 2.15.0.

Code: `cloud/api/src/lib/fleet-score.mjs` (the sums), `cloud/api/src/handlers/fleet.mjs` (`health`, `snapshot`),
`cloud/api/src/handlers/memfault.mjs` (`crashes`), `cloud/api/src/tick.mjs` (the daily snapshot) and
`cloud/web/src/site/assets/fleet.js` (`healthScoreCard`).

## The parts

A board without Wi-Fi (Bluetooth only) is in none of them: it never connects to AWS IoT and has no events.

| Part | Weight | What it counts | Links to |
| --- | --- | --- | --- |
| Online | 0.35 | Boards with Wi-Fi that are connected now, of the registered boards with Wi-Fi. | Devices, filtered to offline |
| Crash-free | 0.30 | Boards with no unexpected restart and no new Memfault issue in the last 7 days, of the registered boards with Wi-Fi. | Memfault |
| Update success | 0.20 | Updates over the air that ended confirmed, of those that ended in the last 7 days. | Deployments |
| Wi-Fi signal | 0.15 | Boards online whose signal is -75 dBm or better, of the boards online that report one. | Diagnostics |

The weights are constants (`SCORE_WEIGHTS`) and add up to 1. Being reachable matters most, then not crashing, then
updates landing; a weak signal is more a warning than a failure.

- **Unexpected restart**, from the events table: a `restart` event at warning level, that is a restart whose boot
  diary gives a bad cause (brownout, watchdog, lockup and the rest of `BAD_CAUSES` in `lib/events.mjs`) or a restart
  for being stuck.
- **From Memfault**, read with the console's token as the Memfault pages read it: a reboot whose reason is not one
  of the expected ones (below 0x8000), and a trace of an issue that Memfault first saw in the window (the traces of
  at most 10 such issues are read). When Memfault cannot be read, or the console has no token, the part counts the
  events table alone and the card says so.
- **An update** is counted from the ends of the boards' jobs as they reported them (`succeeded` against `failed`,
  `refused` and `rolled_back`). Updates over Bluetooth or by USB are on the health card beside it, not in the score.
- **The signal** is the RSSI in each board's shadow now; a board that is offline is not counted.

## The score

The weighted mean of the parts that have something to count, times 100, rounded:

```
score = round(100 × Σ wᵢ·vᵢ / Σ wᵢ)   over the parts i whose value vᵢ is known
```

A part with nothing to count (no boards with Wi-Fi, no update that ended in the window, no board online that reports
a signal) is left out, and the others keep their weights among themselves. With no part to count the score is none,
shown as a dash. For example, three boards with Wi-Fi of which two are online, one restarted on a watchdog, three of
four updates confirmed and one of the two online boards on a weak signal:
round(100 × (0.35·⅔ + 0.30·⅔ + 0.20·¾ + 0.15·½)) = 66.

On the card the number is green from 80, amber from 50, red below.

## The trend

The rollouts schedule (`RolloutTickFn`, every minute) stores one snapshot a day: on its first run of each UTC day it
works the score out and puts it in the state table as `pk HEALTH`, `sk <YYYY-MM-DD>`, with `{ day, at, score,
parts }`. The put has the condition that keeps the first item, so a second run that day, or two at once, changes
nothing; a run that has already stored the day's snapshot remembers it and does not ask again. A snapshot that
cannot be made is logged (`health_snapshot_failed`) and tried on the next run, and never holds up the rollouts.

What the schedule's role may do for it, and no more (`cloud/infra/template.yaml`, `RolloutTickRole`): `GetItem` and
`Query` of the `HEALTH` partition (with the others it already read), `PutItem` of the `HEALTH` partition only
(`WriteHealthSnapshots`), and `Query` of the boards' own partitions of the events table, `cranium-*`
(`ReadBoardEvents`).

The card draws the snapshots of the last 30 days with the console's chart (`lineChart` in telemetry.js, as on the
Diagnostics page), with the score now as the last point, and a table of the days under it. "↑ 5 since last week" is
the score now less the snapshot of 7 days ago (or the nearest before it, up to 10 days back); with none, the card
says so.

## The API

`GET /api/fleet/health?days=30`, for every member, viewers too. `days` is 1 to 31 (30 when not given); anything
else is `400 invalid_range`. The answer is what it was before (versions by type, the week's updates, the boards that
need attention) and `score`:

```json
{
  "value": 72,
  "days": 7,
  "parts": [
    { "id": "online", "label": "Online", "meaning": "...", "href": "#/devices?status=offline",
      "weight": 0.35, "counted": 2, "of": 3, "value": 0.6667 }
  ],
  "memfault": { "state": "ok", "message": "" },
  "historyDays": 30,
  "history": [{ "day": "2026-11-02", "score": 67, "parts": { "online": 1, "crashFree": 1, "updates": null, "signal": 1 } }],
  "change": 5
}
```

The live parts are worked out on read and kept 30 seconds with the rest of the answer, as are the stored snapshots;
`days` only chooses how many of them are given. The page draws its links from its own list, never from the answer.

## Tests

`cloud/api/test/fleet-health.test.mjs`: each part's maths (an empty fleet, all offline, mixed), the weights, the
history and the week's change, the score through the API with the boards' events and a fake Memfault, the snapshot
(once a day, idempotent, a failure that leaves the rollouts alone) and who may read it. `cloud/api/test/infra.test.mjs`
checks the role. `cloud/web/test/fleet.test.mjs`: the Overview card.
