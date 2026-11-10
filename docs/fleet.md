# Fleet: board types, groups, rollouts, the map, commands and alerts

What the firmware (from 1.13.0) and the console agree on, so that a fleet of boards of more than one kind can be
updated, found and watched together. Each part says who does what. The board's side is built in firmware 1.13.0
(Memfault in 1.14.0), and the console's in console 1.10.0 (Memfault in 2.1.0); what the phone apps do not have yet
is said where it comes up. [`test-results.md`](test-results.md) says what has run on a board.

## Board types

| Type | Board | Network | How it updates |
| --- | --- | --- | --- |
| `nrf7002dk` | nRF7002 DK (nRF5340 with the nRF7002 Wi-Fi companion) | Wi-Fi to AWS IoT, Bluetooth LE | Over the internet (AWS IoT Jobs), or over Bluetooth from a phone |
| `nrf5340dk` | nRF5340 DK | Bluetooth LE only: no Wi-Fi chip | Over Bluetooth from a phone, or over USB. It never reaches AWS by itself |

- **The image says what it is for.** Every signed image carries a protected TLV (inside the signed area, so it cannot be
  changed without the key), tag `0xA1`, whose value is the board type in ASCII, for example `nrf7002dk`. An image
  without it is a `nrf7002dk` image: every release up to 1.12.0.
- **The board says what it is.** From 1.13.0 the diagnostics report carries `"board": "nrf7002dk"`. A board that never
  connects (a `nrf5340dk`) gets its type from its thing's attribute `board`, set when it is provisioned
  (`tools/provision_device.py --board nrf5340dk`). Without either, a board is `nrf7002dk`.
- **The console refuses a mismatch.** A release is for one type. A deployment, a Bluetooth send or a group rollout never
  offers a release to a board of another type, and the API refuses it (`400 incompatible_board`).
- A `nrf5340dk` is never a target of an AWS IoT job. The console lists it as "Bluetooth only", with its last version
  as a phone last saw it.

## Compatibility: the right image on the right board

Every image carries what it is compatible with, in its protected (signed) TLV area, and each step that can put an
image on a board checks it. The board's own check is the last word.

| Protected TLV | Value (ASCII) | Meaning | A legacy image without it |
| --- | --- | --- | --- |
| `0xA1` | `nrf7002dk`, `nrf5340dk` (1–16 lowercase letters and digits) | The board type it is built for | `nrf7002dk` |
| `0xA2` | `1`, `2`, … (a positive integer) | The flash layout it is built for: partitions, slot sizes, the golden area. It goes up whenever the partitions change, so an image never lands on a board whose flash is divided differently | `1` |

- **The build** sets both: `CONFIG_APP_BOARD_TYPE` and `CONFIG_APP_IMAGE_LAYOUT` (per board, in the board's conf). The
  build stops if the image does not carry the values the board's configuration says.
- **The board** reports both in its diagnostics (`"board"`, `"layout"`) and, before it installs anything, reads the
  new image's protected TLVs: over the internet after the download is verified, and over Bluetooth after an upload,
  before it marks the image to test. A different board type or layout is refused: the image is never marked, MCUboot
  never swaps, the update ends `failed` with reason `incompatible_board` or `incompatible_layout`, and a `CMD`/`ota`
  line says why. A Bluetooth upload of such an image is refused the same way, whatever tool sent it.
- **The console** reads both on upload, shows them on the release, and never offers a release to a board of another
  type or layout (`400 incompatible_board`, `400 incompatible_layout`), whether the board is named, in a group, or
  part of Update everything.
- **The phone apps** check the same before a Bluetooth send, from the image they hold and the board's reported type and
  layout, and send `thing` with the console's pre-send check so that the console checks too.
- **One version is one image.** Versions are one sequence across all board types, so `1.13.0` names exactly one file;
  a build for another type takes the next number.

## Groups and rollouts

- **Groups** are names a release manager gives to sets of boards ("lab bench", "demo"). A board can be in several. Every
  board is also in the group of its type.
- **A deployment targets** some boards, a group, a type, or the whole fleet. It only ever takes the boards of the
  release's type, and leaves out those already on that version.
- **Staged rollout.** A deployment of more than one board starts with a canary: the first board (or the number asked
  for), online and with a clean update history first. The rest follow only once the canary has confirmed the update,
  in 1 to 10 **stages** (from console 2.8.0). Each stage is one AWS IoT job on all its boards at once, offered as fast as
  AWS IoT allows (1000 boards a minute), so its boards update side by side rather than one after another.
  - **Gating.** The next stage starts only once the job of the one before has completed with its failures under the
    limit, and after the **soak time** (0 to 60 minutes, default 0), which also follows the canary. The schedule that
    moves rollouts on looks every minute.
  - **The health gate** (from console 2.13.0). After the canary and after each stage has ended, the next stage also
    waits the gate's minutes (0 to 120, default 10), then asks Memfault, through the console's cached reads of its REST
    API, whether any board the rollout has updated so far shows, on the new version and since its own part started,
    a trace of a Memfault issue or an unexpected reboot (an Assert, a fault, a watchdog, a stuck restart: Memfault's
    reboot reasons from 0x8000). None: the gate passes, on record as `rollout.advance` with `gate passed`, and the
    stage starts once the soak time is over too. One: the rollout stops, code `health_failed`, naming the board, and
    the issue's number and title with a link to it on the Memfault page, or the reboot's reason. If Memfault cannot
    be read (no token, refused, limited, unreachable), the gate waits, never passes, and after 30 minutes stops the
    rollout with `health_unknown` and says why. Both stops raise the "rollout stopped by itself" alert
    ([alerts.md](alerts.md)). The create form has **Health gate** on, 10 minutes, by default; a request that gives no
    `healthGate` (a script, or a client from before 2.13.0) has none. The gate holds back the next stage: after the
    last stage there is none, and the rollout is done when its job is.
  - **Stops.** A canary that does not confirm, a stage whose failed, rejected or timed-out boards reach the failure
    limit (default 20%, from the first finished board; AWS IoT's abort configuration stops what has not started), the
    health gate, a release revoked, or a cancellation: the rollout stops and says why. Each change of stage is a conditional write on
    the rollout, so two runs of the schedule never start a stage twice.
  - **Choices.** The create form (Roll out to a group; New deployment for boards picked by hand; Update everything and
    a group's roll back) takes the canary size, the number of stages, the batch size of each stage but the last (a
    percent or a count of the boards after the canary; the last stage takes the rest; empty stages are left out), the
    soak time, the failure limit and the health gate. The server checks every one (`lib/stages.mjs`).
  - **Suggestions.** `GET /api/rollouts/suggest?release=<version>&group=<id>` (viewers and release managers; the fleet
    without `group`) says what the console would do, each choice with a one-line reason: one online board per board
    type as the canary, preferring a clean update history; stages that grow (about 10%, then three times as many, then
    the rest), one stage for a group of three boards or fewer; boards that are offline in the last stage; a soak time
    for larger groups; the health gate on, 10 minutes; and a warning when most of the group is offline or a stage is
    too small to tell anything. The
    Roll out dialog fills itself in from it, and the person can change anything.
  - **Progress.** A rollout's page shows each stage: its boards and each board's state, how many are done, in progress,
    failed and waiting, when it started and ended, or when it is due. A rollout started before 2.8.0 still goes on in
    waves, paced by AWS IoT, to its end.
- **Every update.** The console's update history (`GET /api/updates`, from console 2.1.1;
  [aws-iot.md](aws-iot.md#update-history)) has each board's updates however they came: a deployment board by board, an
  update over Bluetooth from a phone with whose phone it was, and one by USB or another tool, each kept, rolled back,
  not installed or pending. A board that never reaches AWS IoT has no reports to make one from.
- **Update everything.** One action: for each board type, its newest active release goes to every board of that type
  that is not on it, each type as its own staged deployment. The review step lists, by type, the release and the
  boards, and what is left out (offline long, Bluetooth only, already current).
- **Roll back** (a group's, before 2.14.0 and still there). The release before the newest of each type in the group.
  A board takes only firmware newer than what it runs, so it reaches only boards behind both releases; the review marks
  the others "Would refuse it".
- **Roll back to last good** (from console 2.14.0). One button on each group (Fleet, Groups) and one on the Fleet page
  for every board: each board goes back to its own last good version.
  - **Last good.** The newest version, other than the one it runs, that the board ran confirmed, from its update history
    (`GET /api/updates`): a version an update brought and the board kept (it started, reached AWS IoT and confirmed
    itself), or a version an update started from (a board starts an update only from firmware it has confirmed). An
    update that rolled back, was not installed or is still pending says nothing good of its version. Memfault is not
    asked per board and per version, which would be many reads; the roll back itself runs with the health gate on,
    which asks Memfault of every board it updates.
  - **How a board takes an older version.** It does not, and this changes no firmware. The console registers only
    versions newer than every earlier one, the application refuses a job that is not newer than what it runs
    (`ota_job.c`, `ota_job_check`, equal refused too), and MCUboot refuses a lower version on a test swap
    (`CONFIG_MCUBOOT_DOWNGRADE_PREVENTION`). So, as the group's Roll back already said, a real roll back is a rebuild of
    the old source under a newer version. A release says it is one when its note begins `Rebuild of <version>`
    (`Rebuild of 1.13.0`; set at upload or with Edit note). A board whose last good version is older than what it runs
    goes to the newest active rebuild of that version that is newer than what it runs, of its type and layout; one
    whose last good version is newer (taken back by hand) goes to that release itself.
  - **The preview** (`GET /api/fleet/last-good`, `GET /api/groups/{id}/last-good`) lists, by target release, each
    board from → to and the canary, and the boards left out with why: no known good version (`no_good`), its last good
    version revoked (`good_revoked`), no rebuild of it yet (`no_rebuild`), its history unreadable (`unreadable`),
    Bluetooth only, offline for more than a day, never reported, another board type or layout, or busy.
  - **The start** (`POST` to the same address, `{ targets: [{ version, things }], ... }`, release managers) is checked
    against the plan as it is then (`409 plan_changed`) and starts one staged rollout per target release (`purpose`
    `last_good`), each with a canary, the stages chosen and the **health gate always on** (10 minutes unless asked for
    longer; asked off it is `400 gate_required`). On record as `fleet.rollback_last_good`, with the group or the fleet,
    the versions and the rollouts started.
- **Maintenance windows** (from console 2.17.0). A group may have one, in its Edit dialog: the days it opens on, from
  and to (`HH:MM`; a "to" at or before "from" is the next morning) and a time zone (IANA, such as
  `America/New_York`; the browser's by default). `POST /api/groups/{id}` with `window: { days, start, end, timeZone }`
  sets it, `window: null` takes it away; `400 invalid_window` for anything else, and `group.update` records it before
  and after in words ("weekdays 01:00–05:00 America/New_York"). The window is read on the wall clock of its own zone,
  so it keeps its local hours across the change to and from summer time; the hour a change skips is simply not in it
  that day, and the hour that happens twice is in it twice. A staged rollout to the group starts **no stage** outside
  the window: the stage that is due waits, the rollout says "Waiting for the window" (`waiting: "window"` in
  `GET /api/rollouts`), and it starts on the first run of the schedule inside the window. The canary of a rollout
  started by hand is not held back: whoever pressed the button chose the moment.
- **Scheduled starts** (from console 2.17.0). A deployment, a staged rollout or a roll back to last good can be started
  later: "Schedule for later" in the New deployment, Roll out and Roll back to last good dialogs asks for a date and
  time and a time zone (the browser's by default). The start is stored in the state table (pk `SCH`) and started by
  the schedule that moves the rollouts on (`RolloutTickFn`, every minute), with the **same handlers and checks** as a
  start by hand: the release still active, the version rules, the board types and layouts, busy boards, and the
  health gate. A schedule for a group with a window waits for the window ("Waiting for the window"). Of two runs at the
  same moment only one starts it: the schedule is claimed from `scheduled` to `starting` by a conditional write first.
  It then runs as the person who scheduled it, and is `started` with what it started, or `failed` with why (a busy
  board, a revoked release, nothing left to update). A start cut off between its claim and its end is never started
  again: after 10 minutes it is `failed` with `start_lost`, for a person to look at.
  - `GET /api/schedules` (every member), `POST /api/schedules` `{ kind, at, timeZone, request }` (`kind` `deployment`,
    `rollout` or `last_good`; `at` a local `YYYY-MM-DDTHH:MM`, at least a minute and at most 30 days ahead),
    `POST /api/schedules/{id}` `{ at?, timeZone?, request? }` to change it and `POST /api/schedules/{id}/cancel`,
    both only while it is `scheduled` (`409 schedule_over` after). A local time a change to summer time skips is taken
    as the same time after the change; one that happens twice as the first. A roll back to last good is planned again
    when it starts, for the boards that were ticked.
  - On record: `schedule.create`, `schedule.edit` and `schedule.cancel` with what changed before and after (when,
    release, target, boards, note, status), and `schedule.start` as the console's, with who scheduled it, what the start
    noted and the outcome.
  - The Deployments page lists them under **Scheduled**: what, when, by whom, waiting for the window, and what it started
    or why not; a release manager can change the time or cancel one that has not started.
  - The person who scheduled it is not asked again whether they are still a release manager when it starts: cancel the
    schedules of someone who leaves the team.

What is planned for the fleet: [`roadmap.md`](roadmap.md). Updating a whole fleet at once, and how Memfault could choose the boards while AWS still delivers: [`mass-updates.md`](mass-updates.md).

## Commands: `cranium/<thing>/commands`

The console publishes, QoS 1; the board subscribes. The device policy allows the board to subscribe to and receive its
own topic only. A board that is offline misses the command: that is meant, these are for now.

```json
{"id": "3f9c2a1b7d4e6f80", "cmd": "identify", "seconds": 15}
{"id": "a01b2c3d4e5f6789", "cmd": "report"}
```

| `cmd` | What the board does |
| --- | --- |
| `identify` | Blinks LED1 and LED2 together, fast (about 5 Hz), for `seconds` (1 to 60, else 15), then goes back to what it showed |
| `report` | Sends the heartbeat, the diagnostics report and a location scan at once (the location's own 10-minute floor still holds), and from 1.14.0 what Memfault data waits |
| `memfault` | From 1.14.0: takes a heartbeat of Memfault's metrics now and sends it, with whatever else waits ([`memfault.md`](memfault.md)) |

`id` is 16 hexadecimal characters. The board answers on its events topic with tag `CMD`, for example
`identify for 15 s (3f9c2a1b7d4e6f80)`, which the console files as kind `setting`. Anything else is ignored with a
`CMD` line saying so. Only release managers can send a command; each one is in the activity log (`board.command`).

The cloud also publishes `{"id": ..., "cmd": "memfault_ack", "seq": <n>}` there, from 1.14.0: the answer for one
Memfault chunk, which the board never answers.

## Memfault: `cranium/<thing>/memfault`

From firmware 1.14.0 the board publishes, QoS 0, binary, the Memfault SDK's chunks: its reboot reasons, a coredump
of a crash, an hourly heartbeat of metrics and an event per update. A function in AWS posts each one to Memfault with
the project key, which only it can read, and answers on the commands topic. The device policy allows the board to
publish on its own topic only. What leaves the board: no network name, no access point's address and no OUI;
the coredump holds the registers and the tops of the stacks, not the application's data. [`memfault.md`](memfault.md)
has the rest.

## Location by Wi-Fi: `cranium/<thing>/location`

The board publishes, QoS 0, what it hears of the Wi-Fi around it; AWS IoT Core Device Location turns that into a
position. Only `nrf7002dk` boards can do this.

```json
{"aps": [{"mac": "a4:2b:b0:12:34:56", "rss": -51}, {"mac": "f0:9f:c2:65:43:21", "rss": -70}], "boot": 42, "t": 61234}
```

- **What is sent:** 2 to 10 access points, strongest first, as BSSID and signal. Never a network name. Only globally
  administered BSSIDs (the second-lowest bit of the first byte clear): a phone's hotspot and other randomised addresses
  move, and say nothing about where the board is. Fewer than 2 left: nothing is sent.
- **When:** once after the first connection of a boot (after 60 s), every 6 hours, and on the `report` command; never
  more often than every 10 minutes.
- **The console** asks AWS IoT Core Device Location (`iotwireless:GetPositionEstimate`) for a position, at most once per
  board per 10 minutes, and not again while the set of access points has not changed. It keeps the position (latitude,
  longitude, accuracy in metres, when) and the last 20 of them, and not the access points.
- **The map** (the console's Map page; the phone apps have none yet) shows each board at its position, with its name, state and
  how sure the position is. The tiles are OpenStreetMap's, with its attribution.
- What leaves the board: the BSSIDs of nearby access points and their signal, to AWS, and from AWS to the location
  solver it uses. That is the price of a position from Wi-Fi.

## Alerts

E-mail through Amazon SNS, to the release managers who ask for it on the console (each address confirms by e-mail
first), and from console 2.13.0 a toast on every open page of the console and of the apps. An alert for:

- a board offline for more than 15 minutes (a rule), and back again
- a new Memfault issue, a crash loop, and low supply voltage (rules, from Memfault's data)
- a staged rollout or deployment that stopped by itself, its health gate too (a rule)
- an update that failed or rolled back
- a restart for being stuck
- a board whose position moved by more than 1 km

Release managers turn each rule on or off and set its threshold on the Alerts page. At most one e-mail per board and
kind per hour; the rest go into the next one. The rules, how each is checked, and what a phone notification would
need: [`alerts.md`](alerts.md).

## Bluetooth-only boards and the phone

A phone that connects to a board over Bluetooth tells the console what it saw: the board, its version, and when
(`POST /api/devices/{thing}/seen`). That is how a `nrf5340dk` shows on the console at all. Planned for the apps, and
not in them yet: sending that sighting, and "Update all nearby", every board in Bluetooth range that is behind its
type's newest release, one after another.
