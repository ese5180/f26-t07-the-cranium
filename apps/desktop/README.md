# The Cranium desktop app: Windows and Linux

The console and the customer site in a window of their own, on a Windows PC or a Linux computer: the console's own
pages, kept on the computer and brought up to date from the console by themselves, as the phone apps keep them
([docs/desktop-app.md](../../docs/desktop-app.md)). From the app, a release manager can also use the board's USB console
(Web Serial) and update a board over Bluetooth, with no browser. The Mac has a native app of its own, not this one.

This folder is the part that is the same on both systems, written with [Electron](https://www.electronjs.org/) 44.9.3.
Each system's installer is its own part: `electron-builder.windows.yml` and `electron-builder.linux.yml`, with their
notes in [docs/desktop-windows.md](../../docs/desktop-windows.md) and [docs/desktop-linux.md](../../docs/desktop-linux.md).

## Trying it from a checkout

Node.js 22 or newer, then:

```sh
cd apps/desktop
npm ci          # Electron and electron-builder, at the versions in package-lock.json
npm start       # makes build/ (scripts/prepare.mjs), then opens the app
npm test        # the core's tests, with no Electron
```

`npm start` builds the app with `apps/config/cranium.json` when it is there (`apps/configure.sh` writes it from the
deployed stack, or **Download the configuration** on the console's Apps page), and with the example configuration
otherwise, which shows the pages but signs nobody in. The pages built into the app come from this checkout
(`cloud/web/build-bundle.mjs`); at its first start the app also takes the console's newest pages, checking every file.

From a checkout only (never in a built app):

| Variable | What it does |
| --- | --- |
| `CRANIUM_DESKTOP_PAGE=admin` | Opens the console first, as a build without the customer pool does |
| `CRANIUM_DESKTOP_SMOKE=<file.png>` | Takes a picture of the window a few seconds after the page loaded (`CRANIUM_DESKTOP_SMOKE_MS`, 6000 by default), says the page's address and title, and quits |

The page's warnings and errors print in the terminal, and the View menu has the developer tools.

## Building an installer

`npm run dist -- windows` or `npm run dist -- linux` (the system it runs on, when none is named) makes `build/` and runs
electron-builder with that system's file over [`electron-builder.base.yml`](electron-builder.base.yml), into `dist/`.
`--example` builds with the example configuration even where the real one is there. A checkout without a system's
file says so: it comes with that system's packaging.

CI builds each system's installers with the example configuration only: this repository is public, and a configured
build names the stack. For a build that signs in, build it after `apps/configure.sh`.

## What is where

| File | What |
| --- | --- |
| `src/main.mjs` | The app: the `cranium-app://bundle` scheme, the window and what it may load, permissions, the serial port and Bluetooth choosers, the bridge's handlers |
| `src/preload.cjs` | The only thing the page gets: the bridge's transport (the iPhone app's), and the window's Web Bluetooth for the main process |
| `src/lib/` | Everything that needs no Electron, each with its tests in `test/`: the manifest and the bundle store, the page policy, the bridge's contract checks, the sign-in keeper, CBOR and MCUmgr's SMP, Bluetooth, the configuration, the check for a newer build |
| `src/platform/` | `default.mjs`, what each system's own module (`win32.mjs`, `linux.mjs`, with its packaging) may change: switches, window options, the menu |
| `src/prompt/` | The passkey box, for pairing a board on Windows and Linux |
| `scripts/` | `prepare.mjs` (makes `build/`), `dist.mjs` (one system's installers) |

`build/`, `dist/` and `node_modules/` are made here and never kept in git.
