# Our own Memfault

What Memfault does for the boards today, built into our own firmware, cloud and console, so that the
platform does it on its own. Memfault stays connected until ours covers each part (issue #236). This page is
the design for every row of the gap table in #236 and the order the stages land in. Stage 1, **Issues**, is
built (console 2.30.3), and stage 2, **Vitals** (console 2.31.0); the rest is the plan.

Everything here lives in the stack we already run (`cloud/infra/template.yaml`): the events table, the state
table and the firmware bucket, all pay-per-request, and the API function. No new service, and nothing a board
sends goes anywhere but our AWS account.

## Where things are kept

| Store | Today | Used for |
| --- | --- | --- |
| Events table (`EventsTable`, pk thing, sk `E#`/`S#`/`L#`/`K#`, TTL) | events 90 days, samples 7 days, log lines 90 days | occurrences, vitals samples, metrics, timeline |
| State table (`StateTable`) | releases, groups, rollouts, settings | issue state (a fix marked by hand), cohorts, sampling rules, alert targets |
| Firmware bucket | signed images | symbol files (ELF) per release, coredump chunks, recordings |
| Audit table | who did what | every change a person makes to the above |

New sort keys in existing tables, not new tables: each table is already pay-per-request with a TTL where it
needs one, and the Database page, the backups and the permissions follow it without changes.

## The gap table, row by row

### Reboot reasons

- **Data**: already sent. The boot diary (`diary` in the shadow, last 8 boots: version, reset cause, stage)
  becomes `restart` events (`lib/events.mjs`, what `boot`, `restarted`, `stuck`).
- **Build**: reboot reasons per board and for the fleet over time, by version. A read over the events table,
  like the Issues route; a chart on the Issues page (stage 4).
- **Firmware later**: the Zephyr fatal reason (`K_ERR_*`) with the reset cause, as `reason` on the boot event.

### Coredumps with symbolication

- **Firmware later** (stage 3): on a fault, Zephyr's coredump backend writes to a flash partition; after the
  reboot the board sends it in chunks of at most 4 KiB on `cranium/<thing>/coredump`
  (`{ id, seq, total, data }`, base64), the fault registers (`pc`, `lr`, `sp`, `xpsr`, `cfsr`, `hfsr`,
  `mmfar`, `bfar`) in the first chunk, then erases the partition once the cloud acknowledges. RAM: the chunks are
  read from flash one at a time, so no buffer beyond one chunk (`tools/memory_budgets.json` floors apply; the
  nRF7002 DK has little RAM left).
- **Cloud**: a rule writes chunks to the firmware bucket under `coredumps/<thing>/<id>/<seq>`; when the last
  arrives, the recorder writes a `restart` event (what `fault`, `reason`, `pc`, `frame` once decoded) and an
  item `C#<id>` in the events table pointing at the chunks. Decoding runs in a separate function with the
  release's ELF (below): `addr2line` over the stack for each thread, the line that crashed.
- **Retention**: 90 days, by a bucket lifecycle rule on `coredumps/`.
- **Cost**: a coredump is 10 to 40 KiB; at one crash per board per day for 100 boards, under 120 MB a month.

### Symbol files per release

- **Build** (stage 3): the release upload (`POST /api/firmware`) takes the ELF beside the signed image and keeps
  it at `symbols/<version>.elf` in the firmware bucket. `tools/memfault_upload.py` keeps sending it to Memfault
  until ours is trusted. Kept as long as the release.

### Issues: crashes grouped and deduplicated (stage 1, built)

- **Data**: the `restart` events the boards already send. An occurrence is a restart that says something went
  wrong: stuck (`what: stuck`, its reason), a reset with a bad cause (watchdog, brownout, lockup, security,
  parity, clock, hardware, temperature), or a fault (stage 3). A restart by the reset pin, by software or by a
  loss of power is not one. The same restart reported twice (`restarted`, then `boot` when the diary arrives)
  counts once, because only the second carries the cause.
- **Signature**: `<type>:<detail>[@<where>]`, where `where` is the function the fault was in (`frame`), or the
  program counter with the version (`pc/version`) when no function is known: an address only means something
  in its own build, a function's name holds across builds. Version is otherwise not part of the signature, so
  the same crash in a newer version is the same issue and can be seen to come back. The issue id is the first
  12 hex digits of the signature's SHA-256.
- **Version**: the one the board ran just before the occurrence (its last firmware event before it, else the
  version on the event, else what it runs now). A `boot` event within 15 minutes of a `restarted` without a cause
  (the diary came in a later report, the usual case) takes that restart's version: the diary's version is the
  boot after the crash, which is the older image when a trial image crashed and MCUboot swapped it back.
- **Regression**: an issue is fixed in a newer version that ran without it on the boards that had it (a version
  on a board that never had it fixes nothing), and regressed when it happens again in a version after that fix. Stage 3 adds a fix marked by hand (`ISSUE#<id>` in the state
  table: `{ status, fixedIn, by, at }`, on record in the activity log), which then wins over the computed one.
- **API**: `GET /api/issues?days=1-90` and `GET /api/issues/{id}` (`cloud/api/src/handlers/issues.mjs`), reads
  for every member, from the website, an app or an API token, like the events. Made on each read from each
  board's restart and firmware events in the window: one Query per board, at most 5 at once (`MAX_IN_FLIGHT`).
  A board whose events cannot be read is counted in `unread`. The newest 5,000 events per board are read.
- **Console**: the Issues page (`#/issues`, `issues-page.js`) under Crashes in the navigation (Monitoring), a tab
  beside Memfault's issues on the Crashes page (`views.js` `crashTabs`): stat tiles, status (Open, Fixed in,
  Regressed in), search and a status filter; an issue's page with stat tiles, its boards in a shared table that
  stacks on a phone, and its timeline. Memfault's own issues stay on the Crashes page. The pages read the last
  30 days (the API's default) every 5 minutes.
- **Cost**: reads only. The kinds are a filter, so each Query reads (and is billed for) every event of the
  board in the window, not only restarts and firmware changes. At 25 boards in 30 days, one page load reads a
  few MB at most, every 5 minutes while the page is open: well inside the free tier at the team's use. When the fleet grows past a few hundred
  boards, stage 4 keeps a summary item per issue (`ISS#<id>`, updated by the recorder) instead of reading every
  board.

### Heartbeat and custom metrics

- **Firmware later** (stage 4): an hourly heartbeat on `cranium/<thing>/metrics`: `{ t, boot, m: { name: value } }`
  with at most 32 integer metrics (heap least, Wi-Fi reconnects, MQTT drops, update bytes, uptime, CPU idle,
  battery or supply mV). Names are fixed in the firmware; the cloud keeps a list of known names and drops others.
- **Cloud**: one item per heartbeat, `M#<ISO time>` in the events table, TTL 30 days. Charts per board and fleet
  on Diagnostics with the existing `lineChart` (`telemetry.js`).
- **Cost**: 24 writes per board per day: 100 boards, about 72,000 writes a month, cents.

### Device vitals

- **Built** (stage 2, below): crash-free boards, connected time and the share on the newest release, per board,
  per version and fleet-wide. **Later** (stage 4): crash-free hours, stable sessions (boots that reached the cloud and
  lasted an hour), and supply voltage from the heartbeat metrics; the Fleet health score takes them as inputs instead
  of its own counts.

### Logs with crashes, periodic log upload

- **Firmware later** (stage 3): a ring buffer of the last 2 KiB of log lines in no-init RAM, kept across a warm
  reboot, sent after a fault as ordinary board-log lines (`cranium/<thing>/events`, tag `crashlog`), and on
  demand with a `logs` command. Same rules as today's lines: printable, cut to 160 characters, never a secret.
- **Cloud**: `crashlog` in `lib/lines.mjs` TAGS (kind `restart`), shown on the occurrence's page next to the
  fault, and on the board's log.

### Device timeline

- **Build** (stage 4): one timeline per board: reboots, issues, log lines, metrics points and updates, from the
  events table and the update history, in the board's page (today's Events and version timeline merged).

### OTA: releases, cohorts, staged rollouts, abort

- **Today**: releases, groups, staged rollouts with waves and a health gate, roll back to last good.
- **Build** (stage 5): an Abort on a running rollout (cancels the jobs left, marks it aborted, on record);
  release cohorts (`COHORT#alpha|beta|ga` in the state table: a group per cohort, a release promoted from one to
  the next); stop a rollout automatically when an issue's rate on the new version passes a limit (the crash
  rate by version below). Delta updates need MCUboot and firmware work and come last.

### Alerts and integrations

- **Today**: e-mail alerts through SNS, with rules (`lib/alerts.mjs`).
- **Build** (stage 5): a new issue, a regression and a crash rate over a limit become alert kinds; targets beyond
  e-mail: a webhook (HTTPS POST of `{ kind, issue, board, version, at }`) and Slack (an incoming webhook), each
  URL kept in Secrets Manager, never in the table, and set by a release manager on record.

### Fleet sampling and data limits

- **Build** (stage 5): per board, a rate limit on log lines, metrics and coredumps (`SAMPLING` in the state
  table: share of boards that send logs, the most coredumps a day per board), sent to boards in the shadow's
  desired state. The recorder already drops what a board sends too fast; this makes the limits a setting.

### Custom data recordings

- **Firmware later** (stage 6): a named blob (a capture, a trace) of at most 64 KiB, sent in chunks like a
  coredump on `cranium/<thing>/recording`.
- **Cloud**: kept in the firmware bucket under `recordings/<thing>/<name>/<id>`, 30 days; listed on the board's
  page with a download for release managers, on record.

### Device search by attributes

- **Build** (stage 4): the attributes a board reports (type, version, cohort, name, last issue) as filters of the
  Devices page, and saved views in the state table per member.

### Crash rate by version

- **Built** (stage 2, below): crashes per 1,000 hours online by version, on the Vitals page. **Later** (stage 5): the
  rollout gate stops a rollout when the new version's rate passes a limit.

### Metrics and vitals (stage 2, built)

- **Data**: only what the boards already send; nothing new is stored. From each board's events (90 days): AWS IoT's
  connected and disconnected events, the restarts (`restarted`, `stuck`, the diary's `boot`), the firmware changes and
  `health` `memory`. From its samples (7 days, one per report every 30 s): the Wi-Fi signal, the free heap and its
  lowest since boot, and the uptime.
- **Counting** (`cloud/api/src/lib/vitals.mjs`): connected time is the share of the known time between a connect and
  the next disconnect. Before a board's first connection event in the window it is online if that event is a
  disconnect; if it is a connect, offline when the board's last connection event before the window was a disconnect
  (read with one more Query, connection kind, limit 1, only then and only for a window under 90 days), else unknown
  (the board may not have existed yet). With none, online all window if online now, else unknown. Unknown time
  counts neither way. Time goes to the version the board runs: the diary's `boot` after an update's restart is
  counted on the version the restart ran, but does not move the time back to it. A restart reported twice (`restarted` without a cause, or
  `stuck`, then the diary's `boot` within 15 minutes) counts once; a diary with several new boots counts each. A crash
  is what the Issues count (`occurrenceOf`). A drop is a disconnect the board did not ask for (not
  `CLIENT_INITIATED_DISCONNECT`). Each is counted by UTC day and by the version the board ran (`withVersions`), which
  makes the cohorts by version: boards, crash-free boards, connected time, crashes per 1,000 hours online (none under an
  hour online).
- **Fleet vitals**: over the boards with Wi-Fi that were seen in the window (some time known or an event), so a board
  in a drawer all window does not count against the fleet. Crash-free boards: those with no crash. Connected: online
  hours of known hours. Newest release: boards on the newest active release of their type (`fleet.releasesByType`), of
  those with a known version whose type has one, Bluetooth-only boards included (their version is a phone's sighting).
- **API**: `GET /api/vitals?days=1-90` (7 if not given) and `GET /api/vitals/{thing}?days=1-90`
  (`cloud/api/src/handlers/vitals.mjs`), reads for every member, never a customer. One Query per board of its
  connection, restart, firmware and health events, the newest 5,000 at most (a board with more is `cut` and its window
  starts at the oldest read), and the one before the window where its first is a connect, at most 5 boards at once
  (`MAX_IN_FLIGHT`); a board that cannot be read is counted in `unread`. Days are UTC days. Samples are read for one board's page only: about 2,900 a day each, too many to read for a fleet on
  each view.
- **Console**: the Vitals page (`#/vitals`, `vitals-page.js`) under Monitoring, after Crashes: 7, 30 or 90 days, stat
  tiles (crash-free boards, connected, on the newest release, restarts, drops, memory ran low), daily charts with the
  console's own `lineChart`, a table of the boards and one of the versions. A board's vitals (`#/vitals/<thing>`): its
  tiles, charts of connected time and restarts by day and of the signal and least free heap of the last 7 days, a table
  of its days and its versions. The pages read every 5 minutes.
- **Cost**: reads only, as the Issues: one Query per board per view, of its events in the window.
- **Gaps that need firmware** (stage 4's heartbeat): the board's own Wi-Fi reconnects and failed MQTT connects (AWS
  IoT sees only the connections that succeed), time to connect, CPU load and stack high-water marks, supply voltage and
  temperature, update download speed, and a fault's reason and address (stage 3). Cloud only, also later: heap and
  signal kept longer than 7 days, as a daily summary the recorder writes, and the fleet's signal and memory from it.

## Stages

| Stage | What | Products |
| --- | --- | --- |
| 1 | Issues from today's events: grouping, regressions, API, Issues page | console 2.30.3 |
| 2 | Metrics and vitals from today's events and samples: fleet vitals, a board's days, cohorts and crash rate by version | console 2.31.0 |
| 3 | Coredumps to our cloud, symbol files per release, crash log ring buffer, fix marked by hand | firmware, console |
| 4 | Heartbeat metrics, crash-free hours and sessions, one timeline, attribute search, reboot reasons over time | firmware, console |
| 5 | Rollout abort and cohorts, alerts to webhooks and Slack, sampling settings, the rollout gate on crash rate | console |
| 6 | Custom recordings; Memfault disconnected once each row is covered | firmware, console |

Each stage is its own release per product; every console change also lands in the apps, which host the same
web bundle (`apps/shared/pages.json` lists the pages).
