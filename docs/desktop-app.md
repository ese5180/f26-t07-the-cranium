# The desktop app: Windows and Linux

The Cranium desktop app shows the console and the customer site in a window of its own, on a Windows PC or a Linux
computer. It is the phone apps' model ([docs/mobile-apps.md, "The app shell"](mobile-apps.md#the-app-shell)) on
Chromium, through Electron:

- **The pages.** They are the console's and the customer site's own, from a copy kept on the computer and brought up
  to date from the console by the app itself.
- **The bridge.** It gives the pages the sign-in, the clipboard, saving a file, the system browser and Bluetooth.
- **The USB console.** It works as it does in Chrome, through Web Serial.

The Mac has a native app of its own, which is not this one.

The code is in [`apps/desktop/`](../apps/desktop/README.md). The part in this page is the same on both systems; each
system's installer and its notes are their own: [Windows](desktop-windows.md) and [Linux](desktop-linux.md).

## The bundle

The app serves the bundle that the web function builds ([Bundle delivery](mobile-apps.md#bundle-delivery)): the same
manifest, the same rules, and the same files the phones get.

| | |
| --- | --- |
| Where | `<userData>/bundle/`: `objects/<sha256>`, `current.json`, `previous.json`, `state.json`. `<userData>` is `%APPDATA%\Cranium` on Windows and `~/.config/Cranium` on Linux |
| At start | The current bundle, if every file it names is there with its size and SHA-256 and it is not marked bad. Else the previous one, checked the same way. Else the copy built into the app (`resources/bundle/`, made by `cloud/web/build-bundle.mjs` when the app is built) |
| Good or bad | A bundle is good once its pages say `app.ready`. One that has not said it after two starts is marked bad, never shown or fetched again |
| Updates | At start, and when the window comes back to the front at most every 10 minutes. The app fetches `<console>/app/manifest.json` (15 s), reads it as `bundle.mjs` does, and fetches each file it does not have, four at a time. It keeps a file only with its manifest's size and SHA-256, then makes the manifest current in one rename; the old one becomes the previous. The pages are told (`app.bundleReady`), and **Reload the pages** (File menu, or Settings) shows them |
| Too new | A manifest that needs a newer bridge is not taken. Settings says the app needs an update |

`src/lib/manifest.mjs` is a copy of `bundle.mjs`'s reader, because the app is packaged from `apps/desktop/` alone.
Its tests read `apps/shared/bundle-sample.json`, as the phone apps' tests do, and compare it with `bundle.mjs` on
every broken manifest.

## The window

The window shows `cranium-app://bundle`, the iPhone app's origin, served from the bundle by a privileged scheme of the
app's own. A path is only a key into the manifest: no path from a server ever becomes a file name.

- **One origin.** The window shows the bundle's origin and nothing else. A link, a redirect, a form or a script that
  would take the main frame anywhere else is cancelled. An `https:` or `otpauth:` address goes to the system browser or
  an authenticator app instead. A new window is never opened, and a frame of another origin never loads (`src/lib/policy.mjs`).
- **A policy on every page.** Each page gets the policy of its route, `bridge.json`'s `policies`, with this build's
  console, customer API and Cognito in it, and the live API's where a template has `{live}`.
- **Only those origins.** The app's own filter lets the pages' requests reach only the console, the customer API,
  Cognito, the live API and the map's tiles.
- **Sandboxed.** Every renderer is sandboxed, with context isolation and no Node.js, and no webview may attach.
- **No developer tools** in a built app.
- **Permissions.** The bundle's pages get the clipboard, notifications and serial ports, and nothing else.
- **Kept between runs.** The window's storage lasts, in a partition of its own. The customer site keeps the person's
  journal of mixes in it.

## The bridge

The contract is [`apps/shared/bridge.json`](../apps/shared/bridge.json), read by the app itself. Every request is
checked against it before anything runs, as both phone apps check it.

The transport is the iPhone app's:

- **Page to app.** The page sends with `window.webkit.messageHandlers.cranium.postMessage(text)`.
- **App to page.** Answers and events come as `cranium-native` events.

So the console's pages ([`bridge.js`](../cloud/web/src/site/assets/bridge.js)) work in this app as they are. The
preload offers only that, and only on the bundle's origin. The app hears only the window's main frame, on that origin.

`app.hello` says `platform: "windows"` or `"linux"`; the pages call it "The app" in their foot.

| Feature | Here | How |
| --- | --- | --- |
| `auth` | Yes | Below |
| `clipboard` | Yes | With `expiresIn`, cleared after that time if it still holds the text |
| `share` | Yes | `file.share` asks where to save the file |
| `open` | Yes | `https:` and `otpauth:` only; `sidestore:` is `not_allowed` on a computer |
| `keepAwake` | Yes | The display stays on, as during an update over Bluetooth |
| `settings` | Yes | Versions; Look for newer pages; Reload the pages; and, when one is out, Download the new app |
| `ble` | Yes | Below |
| `biometric` | No | Electron reaches neither Windows Hello nor a Linux fingerprint reader |
| `haptics`, `appUpdate` | No | No motor, and the app does not replace itself (Updates, below) |

`src/lib/features.mjs` lists the methods; a test holds them to the contract.

## Signing in

The page signs in with its own sign-in code and the phone apps' clients, so the API knows the session as a phone's
([Signing in](mobile-apps.md#signing-in)). It hands the refresh token to the app (`auth.store`) and keeps only an
access token in memory.

`src/lib/vault.mjs` keeps the sign-in by the phone apps' rules for a sign-in without a biometric:

- **Checked first.** The token must be of that pool's client.
- **Encrypted by the system.** The refresh token is encrypted with DPAPI on Windows, or the Secret Service or KWallet
  on Linux, through Electron's `safeStorage`. It is stored in `<userData>/sign-in-<pool>.bin`. Where Linux has no
  keyring the token is kept in memory only, and a restart signs out.
- **Forgotten after an hour.** The refresh token is dropped an hour after the sign-in.
- **Refreshed.** With Cognito, when the access token has less than 2 minutes left.
- **Signing out** revokes the refresh token.

## Bluetooth

The console's Bluetooth page shows in this app as in the phone apps: the bridge offers `ble`. Web Bluetooth has no scan
of its own, so `src/lib/ble.mjs` makes one out of its chooser:

- **Scanning.** `ble.scan` asks for a device with the SMP service, from the window's preload. It needs a person's
  gesture there, which the app gives it, as a click would.
- **The list.** Electron hands the app the devices it finds (`select-bluetooth-device`), and the app passes them to the
  page as `ble.boards`, with no signal strength.
- **Connecting.** `ble.connect` picks one. The page stops its scan just before it connects, so a stopped scan keeps its
  chooser for 8 seconds.
- **Pairing.** Asking for the SMP characteristic's notifications makes the computer pair: the board's SMP needs an
  authenticated link. Windows and Linux ask the app, which shows a box for the passkey the console shows. Electron
  calls that box only on those two systems.
- **The protocol.** MCUmgr's SMP is the app's own (`src/lib/smp.mjs`, with `src/lib/cbor.mjs`). It does the image list
  and the upload only: never a test, a confirm or a reset, as the phone apps.
- **Packet size.** The app finds the largest packet the link carries once per link: it asks for the image list with
  padding the board ignores, at 495, 244, 182 and 100 bytes. Then it sends each chunk once the board has the one
  before.
- **The image.** It is checked again before it goes: its SHA-256, its size, and MCUboot's magic.
- **After the restart.** `ble.watch` asks again, for boards with the status service. It reads each one's status without
  pairing and follows the one whose last update over Bluetooth is the version sent, by the pages' own rule
  (`isAboutThisSend`, held to `updatewatch.js` by a test).

## The USB console

The console's USB page uses Web Serial, as in Chrome. When the page asks for a port, the app picks the only port
there is, or asks which one when there are several. A J-Link's two ports are named: the higher-numbered is the console
port, offered first, and the other the log port (`src/lib/serial-ports.mjs`). Only the bundle's origin may use a serial port. Each system's
notes say what it needs: on Linux, the permission to open the port.

**Board setup** (Developer, [docs/new-board-setup.md](new-board-setup.md#from-the-console-board-setup)) works here
as in Chrome, the register route and the Wi-Fi defaults included (console 2.6.3 takes the app's sign-in for them). It
asks for a port twice when it seals the golden image: the console port, then the log port. The app
does not flash a blank board through the debug probe: the console has no bootloader, TF-M or network core image to
give it, only signed application images, so a blank board still needs `scripts/board/new-board.sh` once.

## Updates

**The pages** update themselves, from the console, as above.

**The app around them** changes seldom, and is not signed. It does not replace itself; it says when a newer one is out:

- **Where builds are listed.** The newest builds are kept in `apps/dist/` in git, as the phone apps' are, listed in
  `apps/dist/latest.json` under `desktop-windows` and `desktop-linux`.
- **The check.** At start and once a day the app reads that file from GitHub (`src/lib/updates.mjs`). When it lists a
  newer version for this system, Settings offers **Download the new app**, which opens the file in the browser.
- **Before any build is listed**, there is nothing to say.

## Releases

A release of one system is a tag. The installers end in `apps/dist/` in git, next to the phone apps' builds:

1. **Make the version.** Bump `extraMetadata.version` in `apps/desktop/electron-builder.<system>.yml`, and add the
   version's entry at the top of `apps/desktop/CHANGELOG.<system>.md` ([docs/versions.md](versions.md)).
2. **Tag and push.** Commit, then tag that commit `desktop-windows-v<version>` or `desktop-linux-v<version>`, and push
   the tag. Or press Run workflow under Actions > Release the apps, with app `desktop-windows` or `desktop-linux` and
   the tag as `ref`.
3. **The release job runs.** The Desktop app job of
   [`release-apps.yml`](../.github/workflows/release-apps.yml) runs on that system:
   - it checks the version against the tag, the commit and the changelog;
   - it restores the configuration from the `CRANIUM_CONFIG_JSON` secret, masking every value, then runs
     `npm ci`, `npm test` and `npm run dist -- <system>`;
   - it refuses a build with the example configuration;
   - it keeps the installers (`scripts/installers.mjs` names them) and their `SHA256SUMS` as the run's artifact
     `cranium-desktop-<system>-<version>`, for 7 days.

   The console has no place for desktop builds yet, so the artifact is where the job leaves them. Like the phone
   builds in `apps/dist/`, they hold the console's address and client IDs.
4. **Into apps/dist.** Within those 7 days, from a checkout of `main`, run
   `apps/fetch-desktop-builds.sh <system> <version>`. It:
   - downloads the artifact with the GitHub CLI and checks every file against its `SHA256SUMS` and its name;
   - puts the installers in `apps/dist/` in place of the older ones of that system;
   - writes `SHA256SUMS` and `latest.json` again for every build there (`apps/write-dist-index.py`, which
     `apps/fetch-builds.sh` uses too);
   - prints the `git add -f` and `git commit` lines. `apps/dist/` stays ignored for anything else.

GitHub refuses a file over 100 MB in git. An Electron installer is about 80 to 110 MB (each system's page gives the
sizes of its own). So the fetch script keeps any file over 100 MiB in parts of 90 MiB, `<installer>.part01`,
`.part02`, ..., with the whole file's SHA-256 in `<installer>.sha256`, all listed in `SHA256SUMS` and the parts in
`latest.json`. `apps/join-build.sh <installer> [folder]` joins them, checks the SHA-256 and keeps the file only if it
matches (an AppImage made executable). `--allow-large` puts the whole file in instead, for a repository that keeps
such files in Git LFS.

## What has been tried, and what has not

Tried, from a checkout on a Mac with `npm start`. A Mac is not a target of this app, but the core runs there the same:

- The app started from its built-in pages, then took the live console's bundle (console 2.4.2), checking every file,
  and started from it the next time.
- Both pages said `app.ready` and were marked good.
- The customer site's and the console's sign-in pages drew, with no errors from the page.
- Nobody was signed in.

The core's tests (`npm test`) run with no Electron, in CI on Ubuntu.

Not tried yet:

- **Signing in** in the app.
- **Bluetooth** to a board on either system: the scan through the chooser, pairing with the passkey box, MCUmgr over
  Web Bluetooth (the packet sizes, the board's answers split over notifications), and the watch after the restart.
- **Web Serial** to a J-Link on either system.
- **The installers** on Windows and Linux, which each system's page covers.
