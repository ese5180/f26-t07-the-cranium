# Roadmap: what is expected to happen

What has been done lately, what is being built now, and what is planned, in plain words. Nothing here has a date: an
item moves up this page when work on it starts, and out of it when it is done and described in its own document. The
versions in the files are in [`versions.md`](versions.md); what each change did is in the changelogs.

## Done recently

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

- **One-click rollback** of a board, or a group, to each board's last good version.
- **Board health for customers**, in plain words.

## Planned next, in this order

1. A fleet health score, with trends.
2. Board compare, and a version timeline for a board.
3. Scheduled deployments.
4. A weekly fleet report.
5. Customer actions: rename a board, accept an update, choose notifications.
6. Role management in the console.
7. Bulk board setup: several boards in a row, without starting over.
8. Push notifications for board events, then home-screen widgets and Live Activities.
9. A hardware self-test step in setup.
10. An offline Bluetooth mode, with a passkey for each board.
11. Sessions and tracks sent from the board, so that Now playing and the play times are real. This replaces the customer
    site's demo and its import journal ([`customer-data.md`](customer-data.md)).
12. Listening stats.
13. A firmware build image on GitHub Packages.
14. A security audit across the web, the apps and the desktop app.
15. The native Mac app (the desktop app is for Windows and Linux).

## On hold

- **Raspberry Pi over-the-air updates** (firmware 1.16.0, draft pull request #42): waiting for a test on the
  hardware ([`raspberry-pi-ota.md`](raspberry-pi-ota.md)).
- **The Mixxx Zephyr port** (pull request #3), a side project.
