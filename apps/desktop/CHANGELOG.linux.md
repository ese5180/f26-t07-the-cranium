# The desktop app for Linux: changes

One entry per version, newest first; the version is `extraMetadata.version` in `electron-builder.linux.yml`, and each
released version is tagged `desktop-linux-v<version>` ([docs/versions.md](../../docs/versions.md)). The first
paragraph is what a release says.

## 0.1.6

Alerts and safer rollouts in the app (console 2.12.0 and later): an Alerts page where release managers turn each alert rule on or off and set its threshold, a toast in the open app as soon as an alert goes out, and a Health gate on a staged rollout that holds the next stage until Memfault shows no new issue and no unexpected reboot.

The Alerts page (`#/alerts`) is in apps/shared/pages.json, so `test/pages.test.mjs` checks that the console has it
and that its route takes the app's sign-in. Nothing else in the app changed.

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
`defaultId` on it. The register route takes the app's sign-in from console 2.6.3. Not yet tried with a board on Linux.

## 0.1.0

The first Linux app: the console and the customer site in a window of their own, with their pages kept on the computer and brought up to date from the console, the USB console over a J-Link, and updates to a board over Bluetooth. An AppImage for any distribution, and a .deb and an .rpm that add the menu entry and the board's USB rule.

Electron 44.9.3, x64: `Cranium-0.1.0.AppImage`, `cranium_0.1.0_amd64.deb` and `cranium-0.1.0.x86_64.rpm`. The .deb
and the .rpm install the app in `/opt/Cranium`, the command `cranium`, the menu entry with its icon, the J-Link's
udev rule (`70-cranium-jlink.rules`, with `uaccess`) and, on Ubuntu 24.04, electron-builder's AppArmor profile for
the sandbox. Web Bluetooth is switched on for Linux. None is signed. Not yet tried on a Linux computer by a person:
CI builds all three on Ubuntu with the example configuration, and installs and removes the .deb.
