# Roadmap: what is expected to happen

What has been done lately, what is being built now, and what is planned, in plain words. Nothing here has a date: an
item moves up this page when work on it starts, and out of it when it is done and described in its own document. The
versions in the files are in [`versions.md`](versions.md); what each change did is in the changelogs.

## Done recently

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

- **Search and filters on the list pages** of the console.
- **A rollout safety gate and alert rules:** a check of Memfault's data before a rollout goes on, and rules
  that send an alert.

## Planned next, in this order

**Fleet management**

1. One-click rollback of a board, or a group, to each board's last good version.
2. A fleet health score, with trends.
3. Board compare, and a version timeline for a board.
4. Scheduled deployments.
5. Weekly fleet reports.

**Setting up boards**

6. Bulk board setup: several boards in a row, without starting over.
7. QR labels for boards.
8. A hardware self-test step in setup.

**Customers**

9. Sessions and tracks sent from the board, so that Now playing and the play times are real. This replaces the customer
   site's demo and its import journal ([`customer-data.md`](customer-data.md)).
10. Customer actions: rename a board, accept an update, choose notifications.
11. Board health in plain words for customers.
12. Listening stats.

**Apps and the board**

13. An offline Bluetooth mode, with a passkey for each board.
14. Home-screen widgets and Live Activities.
15. Push notifications for board events.

**The team's tools**

16. Release notes written from the commits.
17. A view of what changed in an audit log entry.
18. Role management in the console.
19. A security audit across the web, the apps and the desktop app.
20. The native Mac app (the desktop app is for Windows and Linux).
21. An MCP connector for assistant tools, last.

## On hold

- **Raspberry Pi over-the-air updates** (firmware 1.16.0, draft pull request #42): waiting for a test on the
  hardware ([`raspberry-pi-ota.md`](raspberry-pi-ota.md)).
- **The Mixxx Zephyr port** (pull request #3), a side project.
