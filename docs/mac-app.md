# The Mac app

A macOS 13 or later app (`apps/macos`, version 0.3.0, changelog in `apps/macos/CHANGELOG.md`) that shows the console's own pages and the customer site's, not redrawn screens. It hosts the same web bundle the iPhone and desktop apps do (`cloud/web/build-bundle.mjs`) in a WKWebView, kept on the Mac and refreshed from the console with every file checked, exactly as the iPhone app does (`BundleStore`, `ShellPolicy`, the bridge, all in CraniumKit). The page that opens first (the customer site, or the console for a build without customers) and the admin or customer switch are the pages' own, so they behave as in the iPhone and desktop apps.

## Build and run

```
brew install xcodegen
apps/macos/scripts/generate.sh --ad-hoc      # or without --ad-hoc to sign with your team
open apps/macos/Cranium.xcodeproj
```

The Xcode project is made from `apps/macos/project.yml` and is not in git; run the script after a pull. The configuration (`apps/config/`, the same generated file the iPhone app reads) and the web bundle (built from `cloud/web/src`, which needs Node.js 18 or newer) are copied into the built app by build steps, never into the source tree. From the command line:

```
xcodebuild -project apps/macos/Cranium.xcodeproj -scheme Cranium -destination 'platform=macOS' build
xcodebuild -project apps/macos/Cranium.xcodeproj -scheme Cranium -destination 'platform=macOS' test
```

CraniumKit has its own tests (`swift test` in `apps/ios/CraniumKit`).

### Touch ID

Signed with a team (`CRANIUM_TEAM_ID`, or `~/.cranium/apple-team-id`), the data protection keychain holds Touch ID to the saved sign-in itself. With `--ad-hoc` ("Sign to Run Locally") the app asks for Touch ID before it reads the sign-in. Nothing is notarized or installed system-wide.

## What it is

- The window is the console's pages. Only the bundle's own address (`cranium-app://bundle`) loads in it; every file comes from the bundle on the Mac, never from the network. An `https` link opens in the browser, anything else is dropped, and a page cannot open a second web view. Only the main frame of that address can reach the bridge.
- The sign-in is the pages' own (password and code on the page); the app keeps the tokens in the Keychain through the bridge and gives the page access tokens only. With Touch ID on, the saved sign-in is behind it, and after the Mac was away for the chosen time (or sleeps, or its screen locks) a lock screen asks for it again.
- The bridge offers auth, biometric, clipboard, open, settings, keepAwake, storage, share (a save panel), usb and Bluetooth (the firmware update, `ShellRadio` from the iPhone app, compiled in as it is).
- The board's USB serial port: `usb.open`, `usb.write` and `usb.close` and the `usb.data` and `usb.closed` events of `apps/shared/bridge.json`, as the Android app has them (see "Serial console and Board setup"). The app says `usb` in its hello, so the pages make it their Web Serial and show the Serial console and Board setup. It reports its platform as `macos` (the pages accept it from console 2.25.0; an older page takes the iPhone's `ios` from the transport, as before).
- Menus: the app menu has Settings (Command-,). View has Back, Forward, Reload (Command-R, also fetches the newest kept bundle) and Look for Newer Pages; a Debug build adds Developer Tools. Go has the console's sections, Command-1 to Command-9 (Overview, Devices, Map, Diagnostics, Events, Firmware, Deployments, Serial Console, Board Setup) and the rest without a key; they change the page's hash route, or load the console if the customer site is showing. Console has Open Board in New Window (on a board's page: a window of its own with its own web view, sharing the app's sign-ins, Touch ID lock, bundle store, serial bridge and Bluetooth radio (one window holds the radio from its first scan or connect until its link ends, it lets go, its page leaves or its window closes; the others get a busy error and none of its events): Lock Now and Sign Out apply to every window, one Touch ID prompt serves them all, and only the app's own model updates the bundle, whichever window is built first; closing a window lets go of its ports, keep-awake and radio; Settings opens on the window in front). The menus act on the window in front, Lock Now and Sign Out (both sign-ins, then the page shows signed out). Help has Cranium Help (Command-?), the customer site's Help page. There is no Show Sidebar: the pages draw their own navigation.
- Files: an `<input type=file>` in the page (the Firmware page's image, the Pi image) opens the Mac's open panel, for the bundle's own main frame only.
- Staying awake: `app.keepAwake` (the Bluetooth update) holds an IOKit power assertion that keeps the display awake, as the desktop app's powerSaveBlocker does; it is held only while a page asks, and released when it asks to stop or the page is left. An open serial port does not keep the Mac awake.

## Serial console and Board setup

WebKit has no Web Serial, so the app gives the pages one through the bridge, the way the Android app does with its USB bridge (`bridge.js` `createBridgeSerial` turns `usb.*` into `navigator.serial`). The code is in `apps/macos/Cranium/Serial`.

- **Choosing the board.** The first `usb.open` of a run shows a sheet that lists the SEGGER J-Links (USB vendor 0x1366, as Android and the page's own Web Serial filter do) by product name and serial number; no other serial device or port is offered. After that the next free port of the same board opens, the console's port (the last of the device's `/dev/cu.*` ports, sorted) first, then the other. A new page (reload) closes the window's ports, and an open still waiting for the sheet is dropped, so nothing opens for a page that is gone. A port is the window's that opened it; it is busy in the others.
- **The port.** Opened with POSIX termios at the baud the page asks (115200 for the console), raw 8N1, no flow control, DTR raised, exclusive (`TIOCEXCL`). Reads reach the page in order as `usb.data` (base64, up to 4 KiB each). Writes (up to 12 KiB per call) are written whole and in order; a board that takes nothing for 5 seconds fails the write.
- **Unplug.** A read that ends or fails, or a device path that vanishes (checked twice a second), closes the port and sends `usb.closed` with `unplugged` (`failed` for another read error); `usb.close` sends nothing.
- **Sandbox.** The `com.apple.security.device.serial` entitlement, nothing more of the Mac (no USB entitlement, no files beyond the save panel).
- **Tests.** `Tests/SerialTests.swift` covers the port listing parse, grouping and ordering, the chunking, raw bytes, long writes, close and unplug against a pseudo-terminal pair (`openpty`), and the bridge calls end to end on ptys. No real device is opened.

What the Mac app still lacks next to the Android and desktop apps:

- No separate Mac-side serial recovery or flashing: the page runs both (`serial.js`, `setup.js`, `recovery.js`) over these bytes, so Board setup behaves as in the desktop app, but it has not yet been run against a board from this app (see the pull request).
- No unplug notification from the I/O Registry; the path check above finds a removed board within half a second.
- No `appUpdate` (the Android APK updater) and no camera or haptics, which a Mac has no use for.
- No code signing with a shared identity, notarization or release packaging; the desktop app's auto-update and installers have no Mac counterpart.
- Not part of the `apps/shared` and `apps/desktop` parity checks, which cover the web-bundle shells. `apps/shared/bridge.json`'s `usb.open` now names the Mac app and the J-Link-only rule.

## Trying it without a screen

A Debug build run with `CRANIUM_MAC_SMOKE=<file.png>` takes a picture of the page after a few seconds (`CRANIUM_MAC_SMOKE_MS`) and quits, as the desktop app's `CRANIUM_DESKTOP_SMOKE` does. The app is sandboxed: if the path is out of its reach, the picture is in its container's `tmp/cranium-smoke.png`.

## CI

The `Mac app` job in `.github/workflows/ci.yml` makes the project with XcodeGen, builds the bundle and runs the unit tests unsigned. It is not a required check.
