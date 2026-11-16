# docs

One line for each document here. The course manual's own sections are in the [root README](../README.md);
the firmware is described in [`firmware/README.md`](../firmware/README.md) and the scripts in
[`scripts/README.md`](../scripts/README.md).

## Firmware updates and the cloud

| Document | What it covers |
| --- | --- |
| [`aws-iot.md`](aws-iot.md) | Firmware updates through AWS IoT: the console, jobs, API tokens and the threat model |
| [`mass-updates.md`](mass-updates.md) | Updating many boards at once |
| [`fleet.md`](fleet.md) | Board types, groups, rollouts, the map, commands and alerts |
| [`fleet-health.md`](fleet-health.md) | The fleet health score on the Overview: its parts, weights, daily snapshots and API |
| [`compare.md`](compare.md) | Compare 2 to 4 boards side by side, and each board's version timeline |
| [`reports.md`](reports.md) | The weekly fleet report: a printable page per week, its CSV, and the Monday e-mail |
| [`accounts.md`](accounts.md) | The Team page: the team's accounts, tiers and states; customers' password resets and removal |
| [`alerts.md`](alerts.md) | The alert rules, how each is checked, how alerts reach people, and what phone push would need |
| [`console-design.md`](console-design.md) | The console's look: phone first, grouped lists, and the principles behind it |
| [`live.md`](live.md) | Live updates: how an open page hears of a change as it happens |
| [`database.md`](database.md) | The Database page: the console's DynamoDB tables, read only, for release managers |
| [`search-filters.md`](search-filters.md) | Search and filters on the console's long lists, kept in the page's address |
| [`audit-diff.md`](audit-diff.md) | What each activity entry changed, before and after, and what is never recorded |
| [`memfault.md`](memfault.md) | Memfault: crashes, reboots and fleet metrics, sent over the AWS IoT connection |
| [`raspberry-pi-ota.md`](raspberry-pi-ota.md) | The Raspberry Pi's operating system and its over-the-air updates |

## Boards

| Document | What it covers |
| --- | --- |
| [`new-board-setup.md`](new-board-setup.md) | Setting up a blank board, with the script or by hand |
| [`led-guide.md`](led-guide.md) | What every LED pattern on the nRF7002 DK and the nRF5340 DK means, and what to do about it |
| [`code-map.md`](code-map.md) | Where in the code to point for the 3.11 demo, by file and function |
| [`fleet-demo.md`](fleet-demo.md) | What to show, in order, for the 3.11 fleet-management checkoff |

## Closed-loop bench

[`closed-loop/`](../closed-loop/README.md) is Adam's hardware-in-the-loop bench for manual section 3.7, brought in from
[adamshal/cranium-closed-loop](https://github.com/adamshal/cranium-closed-loop) with its history. It follows the
course's [Hapimatic example](https://github.com/ese5180/hapimatic-test-v1) and is separate from `firmware/`:

- **Its own Zephyr app** (`closed-loop/app`, `nrf7002dk/nrf5340/cpuapp`): the nRF5340 takes track events over UART0 with
  CRC and sequence checks and forwards them over Bluetooth (Nordic UART Service). Same NCS v3.4.0 commit as `firmware/`.
- **A Python workbench** (`./bench`): builds a baseline and a low-power profile, flashes, checks UART timing on a Saleae
  and current on a PPK2 against `requirements.json`, and saves the evidence. A small MCP server gives a coding agent
  seven fixed tools to run that loop through Hapimatic.
- **CI**: the job "Closed-loop bench" runs its 26 host tests ([ci.md](ci.md)). No board, analyzer or PPK2 is used.
- **Not yet on hardware**: no flash, UART timing, Bluetooth delivery or before/after current has been measured.
  Flashing the bench app replaces the product firmware and its bootloader on that DK: use a spare DK, or set the
  board up again afterwards ([new-board-setup.md](new-board-setup.md)).

Run the host tests with `cd closed-loop && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt &&
./bench test`; the full bench (`./setup.sh`, then `PHYSICAL-SETUP.md`) is set up for Apple Silicon macOS. MIT, with
Adam's `LICENSE` and `NOTICE.md`; Hapimatic (AGPL-3.0) is downloaded by `setup.sh`, never committed.

## Customers and apps

| Document | What it covers |
| --- | --- |
| [`customer-site.md`](customer-site.md) | The customer site |
| [`customer-data.md`](customer-data.md) | What the customer sees, page by page, and what the board must send |
| [`mobile-apps.md`](mobile-apps.md) | The phone apps: updating a board over Bluetooth |
| [`desktop-app.md`](desktop-app.md) | The desktop app for Windows and Linux |
| [`desktop-windows.md`](desktop-windows.md) | The desktop app on Windows |
| [`desktop-linux.md`](desktop-linux.md) | The desktop app on Linux |

## The project

| Document | What it covers |
| --- | --- |
| [`ci.md`](ci.md) | Continuous integration: what runs, what it proves and what it does not |
| [`test-results.md`](test-results.md) | Test results |
| [`roadmap.md`](roadmap.md) | What was done lately, what is in progress, what is planned next, and what is on hold |
| [`feature-catalog.md`](feature-catalog.md) | Every feature of the platform in one place, with where it lives and how to reuse it on another IoT device; updated as features merge |
| [`versions.md`](versions.md) | Versions of the firmware, console and apps, and the rule for raising them |
