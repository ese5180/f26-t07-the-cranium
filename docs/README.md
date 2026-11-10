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
| [`code-map.md`](code-map.md) | Where in the code to point for the 3.11 demo, by file and function |
| [`fleet-demo.md`](fleet-demo.md) | What to show, in order, for the 3.11 fleet-management checkoff |

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
| [`versions.md`](versions.md) | Versions of the firmware, console and apps, and the rule for raising them |
