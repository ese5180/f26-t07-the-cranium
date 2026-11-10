# The desktop app for Windows: changes

One entry per version, newest first; the version is `extraMetadata.version` in `electron-builder.windows.yml`, and each
released version is tagged `desktop-windows-v<version>` ([docs/versions.md](../../docs/versions.md)). The first
paragraph is what a release says.

## 0.1.13

The weekly fleet report from the console (2.19.0 and later): the Reports page, a printable page per week, its CSV, and the Monday e-mail for release managers.

Nothing of the app changed but its version: the pages are the console's, and the app loads them as before.

## 0.1.12

Customer actions on the customer site (console 2.18.0 and later): customers rename their boards and choose their e-mails, and the console's activity log shows what they did.

Nothing of the app changed but its version: the pages are the console's, and the app loads them as before.

## 0.1.11

Account management from the console (2.17.0 and later): the Team page, where release managers manage the team's accounts, and a customer's password reset and removal.

Nothing of the app changed but its version: the pages are the console's, and the app loads them as before.

## 0.1.10

Compare boards and a version timeline from the console (2.16.0 and later): every version a board ran on its page, and 2 to 4 boards side by side.

Nothing of the app changed but its version: the pages are the console's, and the app loads them as before.

## 0.1.9

Roll back to last good from the console (2.14.0 and later): on a group or the Fleet page, every board back to the last version it ran confirmed, after a preview, as staged rollouts with the health gate always on.

Nothing of the app changed but its version: the page is the console's, and the app loads it as before.

## 0.1.8

Boards' QR codes and labels from the console (2.13.4 and later): Show QR / Print label on a board's page, and the label after Board setup. The desktop app prints them like the website; it has no Scan board, as a computer doesn't scan its boards' labels.

The bridge's new feature `camera` (`camera.scan`, the phones' Scan board) is not offered here: it is in
`NOT_OFFERED` in src/lib/features.mjs with the reason, so `test/bridge.test.mjs` holds the app to the contract. No page
is left out, and nothing else in the app changed.

## 0.1.7

Alerts and safer rollouts in the app (console 2.13.0 and later): an Alerts page where release managers turn each alert rule on or off and set its threshold, a toast in the open app as soon as an alert goes out, and a Health gate on a staged rollout that holds the next stage until Memfault shows no new issue and no unexpected reboot.

The Alerts page (`#/alerts`) is in apps/shared/pages.json, so `test/pages.test.mjs` checks that the console has it
and that its route takes the app's sign-in. Nothing else in the app changed.

## 0.1.6

Search and filters on the console's long lists in the app (console 2.12.0 and later): the activity log, the events and the board log are searched by the server, and the boards, releases, deployments, tokens, customers and Memfault issues as they are shown, each with filters that fold under a Filters button on a phone.

The pages are the console's, so nothing new is listed in apps/shared/pages.json and nothing else in the app changed.

## 0.1.5

The console's Memfault pages in the app (console 2.11.0 and later): a board's page charts its Memfault heartbeat metrics over 24 hours or 7 days, and the Memfault page shows the fleet's reboots by reason, the software versions and each board's latest metrics.

The board card "Memfault metrics" is in apps/shared/pages.json, so `test/pages.test.mjs` checks that the console draws it and that
its route takes the app's sign-in. Nothing else in the app changed.

## 0.1.4

The console's Database page comes with the app, under Developer, for release managers: the console's tables, read only, with filters, each item's fields, and an export as CSV or JSON that is saved where you choose.

The page is the console's own (2.10.0 and later); `test/pages.test.mjs` checks it through `apps/shared/pages.json`, and
the export goes through the app's `file.share`.

## 0.1.3

The console's Memfault page comes with the app: the issue list, an issue's traces, backtraces and registers, and the In Memfault card on a board's page, with its reboots, events and issues. A test now fails if a console page is missing from the app.

The window shows the console's own pages, so the Memfault page comes with the console (2.6.0 and later).
`test/pages.test.mjs` reads `apps/shared/pages.json` with the console's sources and checks each page: its section,
its script in the bundle, its API routes open to the app's sign-in, and the window's rules (docs/mobile-apps.md,
"Pages in every app").

## 0.1.2

Staged rollouts as on the console from 2.8.0: after the canary, the boards update in stages, all of a stage at once, with the number of stages, the batch size, the wait between stages and the failure limit chosen in the Roll out form from the console's suggestion. A rollout's page shows each stage as it goes.

The window shows the console's own pages, so the form and the stage view come with the console; nothing in the app
itself changed but its version.

## 0.1.1

When the page asks for a serial port, the app names a J-Link's two ports, the console port and the log port, and offers the console port first. Board setup can register a board from the app, and fills in the Wi-Fi network from the console's defaults.

`src/lib/serial-ports.mjs`: the higher-numbered of a J-Link's two ports is its console (VCOM1), by number, with
`defaultId` on it. The register route takes the app's sign-in from console 2.6.3. Not yet tried with a board on Windows.

## 0.1.0

The first Windows app: the console and the customer site in a window of their own, with their pages kept on the PC and brought up to date from the console, the USB console over a J-Link, and updates to a board over Bluetooth. An installer for x64, with a Start menu entry and a desktop shortcut if wanted, and a portable copy that runs without installing.

Electron 44.9.3; `Cranium-Setup-0.1.0.exe` (NSIS, per user, the folder may be changed, an uninstaller in Settings >
Apps) and `Cranium-0.1.0-portable.exe`. Neither is signed. Not yet tried on a Windows PC: CI builds both on
`windows-latest` with the example configuration.
