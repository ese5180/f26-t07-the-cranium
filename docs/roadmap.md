# Roadmap: what is expected to happen

What has been done lately, what is being built now, and what is planned, in plain words. Nothing here has a date: an
item moves up this page when work on it starts, and out of it when it is done and described in its own document. The
versions in the files are in [`versions.md`](versions.md); what each change did is in the changelogs.

## Done recently

- **A firmware build image on GitHub Packages** (pull request #93): the NCS 3.4.0 toolchain and SDK in one image, built
  by `firmware-image.yml`; the firmware jobs move to it once it is published ([`ci.md`](ci.md)).
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

## In progress

- **A hardware self-test step in setup** (firmware 1.17.0, console 2.23.0, draft pull request #92): built, waiting for a
  test on a board.
- **The native Mac app** (pull request #94): builds and passes its tests, waiting for a review of its look.
- **Offline Bluetooth mode** (firmware 1.19.0, apps 0.9.0, draft pull request): the phone apps read a board's status and
  accept a waiting update over Bluetooth with the board's own passkey, no cloud ([`mobile-apps.md`](mobile-apps.md#offline-mode)).
  Built for both boards, unit-tested, not yet run on a board or a phone.

## Planned next, in this order

1. Push notifications for board events, then home-screen widgets and Live Activities (needs the Apple and Firebase
   keys).
2. An offline Bluetooth mode, with a passkey for each board.
3. Sessions and tracks sent from the board, so that Now playing and the play times are real. This replaces the customer
   site's demo and its import journal ([`customer-data.md`](customer-data.md)).

## On hold

- **Raspberry Pi over-the-air updates** (firmware 1.16.0, draft pull request #42): waiting for a test on the
  hardware ([`raspberry-pi-ota.md`](raspberry-pi-ota.md)).
- **Customer e-mails (SES)**: the choices are kept, but nothing is sent until an SES identity exists
  ([`customer-site.md`](customer-site.md)).
- **Remote update approval** from the site or the apps.
- **The Mixxx Zephyr port** (pull request #3), a side project.
