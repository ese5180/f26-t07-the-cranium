# Cranium for iPhone

The web console on a phone: every page of the website, in its colours and its words, talking
directly to the console's API on AWS. A release manager can upload a signed image, revoke a release,
deploy a release over the internet to one or more boards, cancel a deployment, make and revoke API
tokens, and send a release to an nRF7002 DK over Bluetooth LE; a viewer sees everything, read-only,
as on the website. [`docs/mobile-apps.md`](../../docs/mobile-apps.md) is the contract this app
follows: sign-in, the API, Bluetooth, what the board refuses, and what the app says when something
goes wrong.

It compiles for iPhone (`scripts/phone.sh --check`) and runs in the Simulator with made-up data
(below). It has not yet been run against the real console, on a phone, or with a board.

## What is where

| Tab | What | The website's |
| --- | --- | --- |
| Overview | Updates in progress, board by board; the fleet online; firmware in the fleet; the newest release; the boards; recent activity; an unfinished revocation, said on top | Overview |
| Boards | Every board as it last reported; a board's page: heartbeat ticking every second, uptime, firmware, update, signal, flash slots, stuck restarts, Wi-Fi channel and MAC, memory, certificates, the last boots decoded, the last update over Bluetooth, its update history, and charts of signal and free memory. Live every 10 s | Devices, Diagnostics |
| Firmware | Every release on AWS, active and revoked; upload a signed `.bin` from Files (its MCUboot header checked here first); a release's page: details, deploy over the internet, send over Bluetooth, revoke or finish revoking | Firmware |
| Events | What the boards did: range presets or a custom range, board and kind filters, a timeline with a lane per board and the console's, online bands, and the list. Live every 15 s while the range ends now | Events |
| More | Deployments (list; a deployment with each board's steps, live; cancel; new deployment), Activity, Update over Bluetooth, API tokens, History, Serial console (an iPhone has no USB serial: it says so), Account | Deployments, Activity, Developer |

A board is shown by its device ID (`CRVIHAAN01`, from firmware 1.11.4) with its thing name under it,
or by its thing name until it has reported one. Every call uses the thing name.

A change from the phone needs a sign-in in the last 15 minutes. When the console answers
`403 phone_sign_in_again`, the form says so and offers to sign in again (the managed login, with
`prompt=login`); after the sign-in the change runs once more with what was entered. If another
account signs in, nothing is changed in its name.

| Path | What |
| --- | --- |
| `CraniumKit/` | Swift package with all the logic. `CraniumKit`: configuration, sign-in (PKCE, tokens in the Keychain), every route of the console API, the console's wording (`Words.swift`, `Telemetry.swift`, `OverviewWords.swift`, from the website's `core.js` and `telemetry.js`), the upload's checks, the fresh sign-in rule, image checks, the firmware cache, the update flow. `CraniumBLE`: scanning, pairing, and MCUmgr through Nordic's [iOSMcuManagerLibrary](https://github.com/NordicSemiconductor/IOS-nRF-Connect-Device-Manager) 1.15.0 |
| `App/` | The SwiftUI app. `Theme.swift` names the console's colours; `Views/` has the screens |
| `App/Assets.xcassets/Console/` | The console's colour tokens, light and dark, made from `cloud/web/src/site/assets/app.css` by `scripts/colors.sh` |
| `project.yml` | The Xcode project, for [XcodeGen](https://github.com/yonaskolb/XcodeGen). The `.xcodeproj` is made from it and is not in git |
| `scripts/generate.sh` | Makes `Cranium.xcodeproj` |
| `scripts/phone.sh` | Puts the app on your own iPhone with a free Personal Team; `--check` compiles it for iPhone without signing |
| `scripts/renew.sh` | Builds main and installs it on the iPhone again before a free team's 7 days end; `--schedule` checks every hour |
| `scripts/testflight.sh` | Archives a Release build and uploads it to TestFlight |
| `scripts/check.sh` | Everything that can be checked without a phone |
| `scripts/colors.sh` | Makes the colour sets from the website's stylesheet again |
| `scripts/copy-config.sh` | Build phase: copies the configuration into the built app |

For Bluetooth, the app only lists the board's image slots and uploads to image 0. It never sends
test, confirm, erase or reset, which the board refuses. That is why it uses `ImageManager.upload`
and not the library's `FirmwareUpgradeManager`, whose upload-only mode still asks for parameters and
resets.

## The Simulator, with made-up data

A Debug build started with the launch argument `-CraniumDemo` signs nobody in and makes no network
request: every answer comes from `App/DemoData.swift`. `-CraniumTab 0` to `4` opens a tab, and
`-CraniumRoute board`, `deployment`, `release`, `deployments`, `activity`, `tokens`, `history`,
`serial` or `account` a screen on it. A Release build has none of this.

```sh
xcodebuild -project apps/ios/Cranium.xcodeproj -scheme Cranium -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -derivedDataPath apps/ios/build/sim CODE_SIGNING_ALLOWED=NO -jobs 4 build
xcrun simctl install booted apps/ios/build/sim/Build/Products/Debug-iphonesimulator/Cranium.app
xcrun simctl launch booted com.craniumiot.cranium -CraniumDemo -CraniumTab 1 -CraniumRoute board
```

## Firmware on the phone

A checked image is kept in Application Support, `firmware/<sha256>.bin`, excluded from iCloud
backup, so that sending the same release again needs no download. It is checked again in full
before each use. At most 5 are kept, only for active releases, and sign-out deletes them all; so
does "Clear downloaded firmware" on the Account screen (More, Account). The app says whether the image came from the
phone or was downloaded, and its size. The rules are in
[`docs/mobile-apps.md`](../../docs/mobile-apps.md#cache), and the code in `FirmwareCache.swift`
and `FirmwareCachePolicy.swift`.

Whatever the image came from, the app asks the console right before every upload whether the
release is still active and the image still its own, and sends nothing without that yes, offline
included (`SendCheck.swift`).

## What you need

- A Mac with a current Xcode (16 or later; App Store Connect only takes builds from recent
  versions), selected with `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
- `brew install xcodegen`.
- The configuration: `apps/configure.sh` writes `apps/config/cranium.json` from the deployed stack.
  It names the AWS account, so it is not in git, and the build copies it into the app, never into
  the source tree. Without it a Debug build uses `cranium.example.json`: an orange banner says so,
  and sign-in cannot work. A Release build stops.
- An Apple Developer Program membership.
- The app record in App Store Connect, with bundle ID `com.craniumiot.cranium`. Register the
  bundle ID first, at developer.apple.com under Certificates, Identifiers & Profiles, or let
  Xcode register it the first time it signs the app.
- For TestFlight, an App Store Connect API key with the App Manager role (Users and Access,
  Integrations). Keep it outside the repository:

  ```
  ~/.cranium/appstoreconnect/AuthKey_<KEYID>.p8     the key, downloaded once; chmod 600
  ~/.cranium/appstoreconnect/key.json               {"keyId": "<KEYID>", "issuerId": "<issuer UUID>", "teamId": "<team ID>"}
  ```

## Run it on a phone

```sh
apps/configure.sh
apps/ios/scripts/generate.sh
open apps/ios/Cranium.xcodeproj
```

In Xcode, pick your team under Signing & Capabilities if `generate.sh` did not find one in
`key.json`. Plug in the iPhone, turn on Developer Mode on it (Settings, Privacy & Security), pick
it as the destination, and press Run. Bluetooth does not work in the Simulator.

Run `generate.sh` again after a pull or after changing `project.yml`. It replaces the project.

### Keep it opening, with a free team

An app signed by a free Personal Team stops opening 7 days after Xcode made its profile. After the
first Run from Xcode, the Mac can renew it by itself, by cable or over Wi-Fi:

```sh
apps/ios/scripts/renew.sh --schedule    # every hour; renews when 36 hours or less are left
apps/ios/scripts/renew.sh --status      # when the app stops opening; whether the iPhone is in reach
apps/ios/scripts/renew.sh               # renew now
```

It builds the newest commit on `main` in a copy of its own (`~/Library/Caches/cranium-renew`), so
work in progress is never installed, and keeps what the app stored. When the profile has 36 hours or
less left it is moved to `~/.cranium/old-profiles` so that Xcode asks Apple for a new one; if Apple
gives back the same one, it tries again just after that one ends. Over Wi-Fi, the iPhone has to be on
the Mac's network, unlocked at least once since it restarted, and ticked "Connect via network" in
Xcode, Window, Devices and Simulators; the Mac has to be awake, and Xcode signed in to the Apple ID.
A failure shows a notification on the Mac; the log is `~/Library/Logs/cranium-renew.log`.
`--unschedule` stops it.

## Ship it to TestFlight

```sh
apps/ios/scripts/testflight.sh
```

It checks for Xcode, the configuration and the key, makes the project afresh, archives, signs and
uploads. The version is `MARKETING_VERSION` in `project.yml`. The build number is the UTC time,
like `20261102.153045`, or `BUILD_NUMBER=...`. After a few minutes of processing, the build shows
in App Store Connect under TestFlight. Add testers there: internal testers can install it at once,
external ones only after Apple's beta review.

The app declares that it uses no encryption beyond the system's (`ITSAppUsesNonExemptEncryption`
is false), so App Store Connect does not ask about export compliance.

## Check without a phone

```sh
apps/ios/scripts/check.sh
apps/ios/scripts/phone.sh --check
```

`check.sh` builds the package, runs its tests (164 of them, Swift Testing: 155 in CraniumKitTests,
9 in CraniumBLETests; the firmware cache's on real files in a temporary folder), type-checks the
app's sources against the macOS SDK, and checks the scripts and `Info.plist`. On a Mac with only
the Command Line Tools, plain `swift test` cannot find Swift Testing; the script passes the paths.
`phone.sh --check` compiles the app for iPhone, without signing.
