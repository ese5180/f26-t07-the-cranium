# Roadmap: what is expected to happen

What has been done lately, what is being built now, what is planned and what is on hold, in plain words. Items have no
dates: an item moves up this page when work on it starts, and out of it when it is done and described in its own document. The
versions in the files are in [`versions.md`](versions.md); what each change did is in the changelogs.

## Done recently

Newest first. The ordered work list is the pinned issue #128.

- **Our own Issues under Crashes** (#298, console 2.30.3, apps 0.9.4, desktop 0.1.18; not deployed yet): stage 1 of our
  own Memfault. The boards' crashes, faults and stuck restarts grouped by what went wrong, with the boards and versions
  they hit and whether one came back after a fix ([`own-observability.md`](own-observability.md)).
- **A time limit for a canary** (console 2.30.1, apps 0.9.3, desktop 0.1.17; not deployed yet): a canary that has not
  confirmed within 6 minutes (3 to 30, chosen per rollout) halts the rest, unless it is visibly still downloading or
  restarting, and a deployment of several boards from the API goes to a canary first ([`fleet.md`](fleet.md)).
- **Golden image promotion over the air** (firmware 1.19.3, console 2.27.7): the golden image in external flash can be
  replaced with a record signed by an offline key, from Make golden on the Firmware page. It needs 1.19.3's bootloader,
  which takes one flash through the debug port. **Not tried on a board yet**; the golden image in external flash is still
  1.5.0 ([`../firmware/README.md`](../firmware/README.md), "Golden image").
- **A new console layout** (console 2.28.0): navigation in groups, a floating tab bar shaped for the iPhone 17 Pro's
  corners, Fleet folded into Devices and Deployments, and Memfault named Crashes ([`console-design.md`](console-design.md)).
- **Readable counts on the Events timeline** (console 2.27.7): no two numbers overlap, also on a phone.
- **Console fixes** (console 2.27.4 to 2.27.6): a customer sees a board's activity, sessions and health only from when it
  became theirs; Look for boards stays in reach; a Bluetooth passkey set at the serial console goes on record; Wi-Fi location
  lines are kept; a refused update for another board is shown, warned and alerted.
- **Firmware 1.19.1 and 1.19.2** (offline mode on top of listening sessions; the board's own passkey is read at every start,
  a Bluetooth window closes when its time is up, Memfault's metric names match the SDK's). Not yet tried on a board.
- **Offline Bluetooth mode** (console 2.27.0, apps 0.9.0, Mac app 0.4.0): the console's Offline page, in the iPhone, Android and
  Mac apps, reads a board's status and accepts a waiting update over Bluetooth with the board's own passkey, no cloud
  ([`mobile-apps.md`](mobile-apps.md#offline-mode)). Apps 0.9.1 put the serial passkey commands on record.
- **Desktop app 0.1.15** for Windows and Linux: the Bluetooth reader refuses malformed answers. The installers kept in
  `apps/dist/` are the 0.1.0 ones of 2026-11-09 and are stale; the newer versions are built by the release job
  ([`desktop-app.md`](desktop-app.md#releases)).
- **The closed-loop bench** (pull requests #261 and #263): a host-side bench with a Bluetooth telemetry app, a logic analyser
  and a power profiler, MCP tools and 29 host tests that run in CI, and the Hapimatic demo runbook ([`../closed-loop/README.md`](../closed-loop/README.md),
  [`hapimatic-demo.md`](hapimatic-demo.md)). Not yet run on hardware.
- **Documentation**: the feature catalog ([`feature-catalog.md`](feature-catalog.md)), and README sections 3.7 (Closing the
  Loop) and 3.8 (Concept Refinement).
- **A firmware build image on GitHub Packages** (pull request #93): the NCS 3.4.0 toolchain and SDK in one image, built
  by `firmware-image.yml`; the firmware jobs move to it once it is published ([`ci.md`](ci.md)).

## In progress

Draft pull requests.

- **Our own Vitals under Monitoring** (#304, console 2.31.0, apps 0.9.5, desktop 0.1.19): stage 2 of our own
  Memfault. Crash-free boards, connected time and the newest release by day, board and version, from what the boards
  already send ([`own-observability.md`](own-observability.md)).
- **A redesign of the customer site** (#257).
- **Board setup and the Bluetooth update on a real board, in the Mac and desktop apps** (#220).
- **Raspberry Pi updates through the board** (#196): the nRF7002 DK hands an update to the Pi over SPI. A teammate's Pi link
  over SPI (#58) is open for review.
- **Adam's CRANIUM Mix app import** (#272) is under review and not on main.

## Planned next, in this order

1. Console fixes from the third bug hunt (console 2.28.3).
2. Board setup detection for both boards (console 2.28.4).
3. More page redesign on top of 2.28.0's, which closed #116 to #121 (console 2.28.5).
4. Our own Memfault, stage 3: coredumps, symbol files and a crash log, which need firmware with a hardware test.
5. Push notifications for board events, then home-screen widgets and Live Activities (needs the Apple and Firebase keys).
6. Sessions and tracks sent from the board, so that Now playing and the play times are real, replacing the customer site's
   demo and its import journal ([`customer-data.md`](customer-data.md)).

These console versions are plans; the numbers may change when branches merge.

## On hold

- **Firmware RAM and flash headroom** (#244), parked: the nRF7002 DK's RAM is nearly full (932 bytes free in 1.19.3).
- **Matter over Thread** (#240), low priority: it waits for a test on hardware and for two teammates' review.
- **Customer e-mails (SES)**: the choices are kept, but nothing is sent until an SES identity exists
  ([`customer-site.md`](customer-site.md)).
- **Remote update approval** from the site or the apps.
- **The Mixxx Zephyr port**, a side project, archived.

## Done earlier

- **Listening stats** (console 2.22.0, apps 0.8.20): a "Your listening" tab on the customer site and in the apps'
  customer mode ([`customer-site.md`](customer-site.md)).
- **Security hardening** (console 2.21.1): the live connection rechecks the account, customers' own names are clamped,
  and the customer change limit is atomic.
- **Bulk board setup** (console 2.21.0): several boards in a row from Board setup, with a shared group, name pattern and
  Wi-Fi, each marked done or failed, and the QR labels printed together ([`new-board-setup.md`](new-board-setup.md)).
- **"Roll back to last good" as the one way back** (console 2.20.1): the group "Roll back" button is removed
  ([`fleet.md`](fleet.md)).
- **Scheduled deployments and maintenance windows** (console 2.20.0, apps 0.8.19, desktop app 0.1.14)
  ([`mass-updates.md`](mass-updates.md), [`fleet.md`](fleet.md)).
- **A weekly fleet report** (console 2.19.0, apps 0.8.18, desktop app 0.1.13) ([`reports.md`](reports.md)).
- **Customer actions** (console 2.18.0, apps 0.8.17, desktop app 0.1.12): rename a board, choose notifications, see a
  waiting update ([`customer-site.md`](customer-site.md)), and Adam's photo on the About page (2.18.1).
- **Search and filters** on the long lists (console 2.12.0): kept in the page's address ([`search-filters.md`](search-filters.md)).
- **A rollout health gate and alert rules** (console 2.13.0): a rollout waits on Memfault's data, and rules send alerts
  ([`alerts.md`](alerts.md), [`fleet.md`](fleet.md)).
- **A view of what an activity entry changed**, before and after (console 2.13.1) ([`audit-diff.md`](audit-diff.md)).
- **The rollout schedule fix** (console 2.13.2): the schedule gets all the settings it needs, with a test for that.
- **The iPhone app updates itself through SideStore** (console 2.13.3, apps 0.8.12) ([`mobile-apps.md`](mobile-apps.md)).
- **QR codes and labels for boards**, and Scan board in the phone apps (console 2.13.4, apps 0.8.13, desktop app 0.1.8)
  ([`new-board-setup.md`](new-board-setup.md)).
- **Release notes from the commits** (`scripts/release/notes.sh`, and `--notes` in `github-release.sh`).
- **Console deploys by tag:** pushing `console-v<version>` deploys it from GitHub Actions; the laptop is the fallback
  ([`ci.md`](ci.md)).
- **Staged rollouts with parallel stages** (console 2.8.0): a canary, then 1 to 10 stages that each update all their
  boards at once, with a soak time and a failure limit, and a suggested plan in the Roll out dialog
  ([`fleet.md`](fleet.md)).
- **Board setup from the console** (console 2.6.1 to 2.8.1): a board on USB is registered and brought online from the
  Developer section, with the Wi-Fi defaults kept in AWS. It works in Chrome and Edge, in the desktop app and, from
  0.8.8, in the Android app over USB. The iPhone cannot open a USB serial port, so its app has neither Board setup nor
  the Serial console ([`new-board-setup.md`](new-board-setup.md)).
- **Memfault in the console** (console 2.6.0 and 2.11.0): issues, crash backtraces, reboot reasons, a board's heartbeat
  metrics charted over 24 hours or 7 days, and the fleet's reboots, software versions and latest metrics
  ([`memfault.md`](memfault.md)). Firmware 1.15.0 adds the power status and Zephyr's default metrics.
- **A Database page** for release managers (console 2.10.0): the console's tables, read only, with export
  ([`database.md`](database.md)).
- **A new look for the console** (console 2.9.0): an app's frame, grouped lists, phone first
  ([`console-design.md`](console-design.md)).
- **The apps and the desktop app** show all of these pages (apps 0.8.9, desktop app 0.1.5); the Windows and Linux
  desktop app is released ([`desktop-app.md`](desktop-app.md), [`mobile-apps.md`](mobile-apps.md)).
- **One sign-in form** for the team and for customers (console 2.4.5, apps 0.8.3).
- **Every release image kept in git**, and the console deployed from GitHub Actions ([`ci.md`](ci.md)).
- **A native Mac app** (Mac app 0.3.0): the console's own pages, with the Serial console, Board setup, Bluetooth updates
  and the Mac's menus ([`mac-app.md`](mac-app.md)).
