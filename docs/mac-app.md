# The Mac app

A native SwiftUI app for macOS 13 or later (`apps/macos`, version 0.1.0, changelog in `apps/macos/CHANGELOG.md`). It is not a web view: it has its own windows, sidebar, tables and menus. It shares the logic of the iPhone app, not the screens: CraniumKit and CraniumBLE (`apps/ios/CraniumKit`) and the iPhone app's models (`AppModel`, `CustomerModel`, `BluetoothModel`, `WebSignIn`, `DemoData`, `Theme`), compiled in by path from `apps/ios/App`.

## Build and run

```
brew install xcodegen
apps/macos/scripts/generate.sh --ad-hoc      # or without --ad-hoc to sign with your team
open apps/macos/Cranium.xcodeproj
```

The Xcode project is made from `apps/macos/project.yml` and is not in git; run the script after a pull. The configuration (`apps/config/`, the same generated file the iPhone app reads) is copied into the built app by a build step, never into the source tree. From the command line:

```
xcodebuild -project apps/macos/Cranium.xcodeproj -scheme Cranium -destination 'platform=macOS' build
xcodebuild -project apps/macos/Cranium.xcodeproj -scheme Cranium -destination 'platform=macOS' test
```

CraniumKit has its own tests (`swift test` in `apps/ios/CraniumKit`).

### Touch ID

Signed with a team (`CRANIUM_TEAM_ID`, or `~/.cranium/apple-team-id`), the data protection keychain holds Touch ID to the saved sign-in itself. With `--ad-hoc` ("Sign to Run Locally") the app asks for Touch ID before it reads the sign-in. Nothing is notarized or installed system-wide.

## What it shows

Team side (sidebar groups Console, In the room, More):

- Overview, Boards (search, filter, a board's page with events, log, boots, charts and slots; a board can open in its own window), Firmware (upload, release, deploy, revoke), Deployments, Events, Activity.
- Bluetooth update (over BluetoothModel, not for a viewer) and a read-only Serial console.
- Search, API tokens (not for a viewer), History, Help (from `apps/shared/help.json`).
- Scheduled deployments and the Weekly report: the console's own pages in a web view (`WebPages.swift`), as the iPhone app shows its web pages. The page signs in itself and nothing is kept on disk; only the console's own host loads in it, other addresses open in the browser.
- Settings: Touch ID, how soon it locks again, lock on sleep, account, about.

Customer side: sign-in, forgot password, Your boards (and a board), Activity, Your listening (the customer site's page in a web view), Account (password, two-step sign-in), Help.

Menus have Command-1 to Command-9 for the first nine sections, Command-R to refresh and Lock Now.

## Left out

- **Board setup over serial.** Web Serial exists only in Chromium, so the console's setup page cannot run in the Mac app's web view, and no native serial setup stack is built. Setup stays in the Electron desktop app or a Chromium browser. The Serial console section only reads lines from a board.
- Team account management (users, roles, two-step) is a pointer to the web console.
- Scheduled deployments, the weekly report and Your listening are web views, not native screens; the web views were not exercised against the live site in CI.
- No code signing with a shared identity, notarization or release packaging.
- Not part of the `apps/shared` and `apps/desktop` parity checks, which cover the web-bundle shells.
- The look has not been reviewed yet.

## CI

The `Mac app` job in `.github/workflows/ci.yml` makes the project with XcodeGen and runs the unit tests unsigned. It is not a required check.
