# The Mac app

A macOS 13 or later app (`apps/macos`, version 0.2.0, changelog in `apps/macos/CHANGELOG.md`) that shows the console's own pages and the customer site's, not redrawn screens. It hosts the same web bundle the iPhone and desktop apps do (`cloud/web/build-bundle.mjs`) in a WKWebView, kept on the Mac and refreshed from the console with every file checked, exactly as the iPhone app does (`BundleStore`, `ShellPolicy`, the bridge, all in CraniumKit). The page that opens first (the customer site, or the console for a build without customers) and the admin or customer switch are the pages' own, so they behave as in the iPhone and desktop apps.

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
- The bridge offers auth, biometric, clipboard, open, settings, storage, share (a save panel) and Bluetooth (the firmware update, `ShellRadio` from the iPhone app, compiled in as it is). It reports its platform as `ios` because the pages treat WebKit without Web Serial that way.
- Menus: View has Back, Forward, Reload (Command-R, also fetches the newest kept bundle) and Look for Newer Pages; a Debug build adds Developer Tools. Console has Lock Now and App Settings.

## Left out

- **Serial console and Board setup.** WebKit has no Web Serial, so these two pages are left out here as in the iPhone app (the web UI hides them and the shell refuses their addresses). They stay in the Electron desktop app or a Chromium browser.
- The camera, haptics and keep-awake bridge features, which a Mac has no use for.
- No code signing with a shared identity, notarization or release packaging.
- Not part of the `apps/shared` and `apps/desktop` parity checks, which cover the web-bundle shells.

## Trying it without a screen

A Debug build run with `CRANIUM_MAC_SMOKE=<file.png>` takes a picture of the page after a few seconds (`CRANIUM_MAC_SMOKE_MS`) and quits, as the desktop app's `CRANIUM_DESKTOP_SMOKE` does. The app is sandboxed: if the path is out of its reach, the picture is in its container's `tmp/cranium-smoke.png`.

## CI

The `Mac app` job in `.github/workflows/ci.yml` makes the project with XcodeGen, builds the bundle and runs the unit tests unsigned. It is not a required check.
