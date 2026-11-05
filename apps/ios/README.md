# Cranium for iPhone

The web console on a phone: every page of the website, in its colours and its words, talking
directly to the console's API on AWS. A release manager can upload a signed image, revoke a release,
deploy a release over the internet to one or more boards, cancel a deployment, make and revoke API
tokens, and send a release to an nRF7002 DK over Bluetooth LE and follow the board through the
update (from 0.7.2 with the board's own status over Bluetooth); a viewer sees everything, read-only,
as on the website. [`docs/mobile-apps.md`](../../docs/mobile-apps.md) is the contract this app
follows: sign-in, the API, Bluetooth, what the board refuses, and what the app says when something
goes wrong.

It compiles for iPhone (`scripts/phone.sh --check`) and runs in the Simulator with made-up data
(below). On the owner's iPhone it has signed in to the real console (2026-11-04), and on 2026-11-05 it sent
firmware 1.13.0 and then 1.14.0 to the board over Bluetooth, each confirmed
([`docs/test-results.md`](../../docs/test-results.md)). The newest version is 0.7.3; installing it on a phone is in
[`apps/README.md`](../README.md).

From 0.6.0 that console is **admin mode**, and the app has a customer side too, as the customer
website has ([`docs/customer-site.md`](../../docs/customer-site.md)).

## The customer side

The customer website on a phone, in its words (`CraniumKit/Sources/CraniumKit/CustomerWords.swift`,
held to `cloud/web/src/customer/assets/` by `CustomerWordsTests`): tabs Overview, Devices, Mixes,
Account and Help (`App/Views/CustomerRoot.swift`, `CustomerScreens.swift`, `CustomerAccountView.swift`).
A customer signs in on the app's own screen to the customer pool (`CustomerSignIn.swift`, with
`PasswordSignIn`: SRP, the code if they turned it on, a new password at the first sign-in, and
"Forgot your password?"), and reads the customer API with their own token (`CustomerAPI.swift`); a
board is named by its assignment id only. Their account's calls go to Cognito with that token
(`CustomerAccount.swift`). Their session is in Keychain items of its own (`CustomerStorage`), with
its own Face ID item and setting, apart from the admin's. **Admin sign-in** is the sign-in below and
opens admin mode, the console as before; **Leave admin mode** is under More. See
[`docs/mobile-apps.md`](../../docs/mobile-apps.md#customers).

## What is where

The screens are iOS's own grouped lists, on the console's paper, with the console's colours kept for
states. Each has at most one prominent action; the rest are in its menu (…), destructive ones last
and confirmed. Explanations are in Help, behind the (?) button.

| Tab | What | The website's |
| --- | --- | --- |
| Overview | Updates in progress, one row per board with its download; boards online; the newest release; the last few changes | Overview |
| Boards | Every board; a board's page: name, thing name, online, firmware; the update while there is one; firmware and flash slots, diagnostics (heartbeat and uptime ticking, signal, Wi-Fi, memory, stuck restarts), Bluetooth, history. The last boots, certificates, all updates, and the signal and memory charts are a tap away. Live every 10 s | Devices, Diagnostics |
| Firmware | Every release on AWS, active and revoked; Upload (+) checks the file's MCUboot header first; a release's page: Deploy, and in its menu Send over Bluetooth and Revoke | Firmware |
| Search | From iOS 26, the system's search button: boards, releases, deployments, events, activity, the app's screens and actions, and Help, grouped, with the match in bold. Recent searches are kept on the phone (10 at most) until sign-out. Before iOS 26 the search field is on More | — |
| More | Events (a tab of its own before iOS 26), Deployments, Activity, Update over Bluetooth, API tokens, History, Serial console, Help, Account | Events, Deployments, Activity, Developer |

Help is `apps/shared/help.json`, which the build puts in the app and the Android app can read too.
Every topic names the files of the repository its facts come from; a test checks that they exist.
Search's matching and ranking are in `CraniumKit/Sources/CraniumKit/Search.swift`.

A board is shown by its device ID (`CRVIHAAN01`, from firmware 1.11.4) with its thing name under it,
or by its thing name until it has reported one. Every call uses the thing name.

A change from the phone needs a sign-in in the last 15 minutes. When the console answers
`403 phone_sign_in_again`, the form says so and offers to sign in again (the managed login, with
`prompt=login`); after the sign-in the change runs once more with what was entered. If another
account signs in, nothing is changed in its name.

| Path | What |
| --- | --- |
| `CraniumKit/` | Swift package with all the logic. `CraniumKit`: configuration, sign-in (PKCE, tokens in the Keychain, Face ID: `BiometricLock.swift`, `Biometrics.swift`), every route of the console API, the console's wording (`Words.swift`, `Telemetry.swift`, `OverviewWords.swift`, from the website's `core.js` and `telemetry.js`), the upload's checks, the fresh sign-in rule, image checks, the firmware cache, the update flow. `CraniumBLE`: scanning, pairing, and MCUmgr through Nordic's [iOSMcuManagerLibrary](https://github.com/NordicSemiconductor/IOS-nRF-Connect-Device-Manager) 1.15.0 |
| `App/` | The SwiftUI app. `Theme.swift` names the console's colours; `Views/` has the screens |
| `App/Assets.xcassets/Console/` | The console's colour tokens, light and dark, made from `cloud/web/src/site/assets/app.css` by `scripts/colors.sh` |
| `project.yml` | The Xcode project, for [XcodeGen](https://github.com/yonaskolb/XcodeGen). The `.xcodeproj` is made from it and is not in git |
| `scripts/generate.sh` | Makes `Cranium.xcodeproj` |
| `scripts/phone.sh` | Puts the app on your own iPhone with a free Personal Team; `--check` compiles it for iPhone without signing |
| `scripts/renew.sh` | Builds main and installs it on the iPhone over Wi-Fi: again before a free team's 7 days end, and whenever main has a newer app; `--schedule` checks every hour (`--if-due`) |
| `scripts/build-ipa.sh` | Builds the unsigned IPA for SideStore, `apps/dist/cranium-ios-<version>.ipa`; `--publish` also publishes it |
| `scripts/publish.sh` | Publishes an IPA on the console's Apps page with an API token, where every member's SideStore source lists it |
| `scripts/testflight.sh` | Archives a Release build and uploads it to TestFlight (paid Apple Developer Program only) |
| `scripts/check.sh` | Everything that can be checked without a phone |
| `scripts/colors.sh` | Makes the colour sets from the website's stylesheet again |
| `scripts/stamp-commit.sh` | Build phase: writes the commit the app was built from into it, for Help, About |
| `scripts/copy-config.sh` | Build phase: copies the configuration into the built app |

For Bluetooth, the app only lists the board's image slots and uploads to image 0. It never sends
test, confirm, erase or reset, which the board refuses. That is why it uses `ImageManager.upload`
and not the library's `FirmwareUpgradeManager`, whose upload-only mode still asks for parameters and
resets.

## The Simulator, with made-up data

A Debug build started with the launch argument `-CraniumDemo` signs nobody in and makes no network
request: every answer comes from `App/DemoData.swift`. `-CraniumTab 0` to `4` opens a tab, and
`-CraniumRoute board`, `deployment`, `release`, `deployments`, `activity`, `tokens`, `history`,
`serial`, `account`, `help`, `help-topic`, `upload`, `events` or `board-log` (Events at one board's log) a screen on it,
`-CraniumScroll lines` scrolls a board's page to its latest lines, and `-CraniumSearch <text>` a search. A Release
build has none of this.

```sh
xcodebuild -project apps/ios/Cranium.xcodeproj -scheme Cranium -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -derivedDataPath apps/ios/build/sim CODE_SIGNING_ALLOWED=NO -jobs 4 build
xcrun simctl install booted apps/ios/build/sim/Build/Products/Debug-iphonesimulator/Cranium.app
xcrun simctl launch booted com.craniumiot.cranium -CraniumDemo -CraniumTab 1 -CraniumRoute board
```

Face ID, with nothing asked: `-CraniumBiometric lock` opens on the lock screen, `offer` shows "Use Face ID
to open Cranium?", `on` has it on (`-CraniumTab 4 -CraniumRoute account` for the switch), and `relock`
keeps the lock on screen after 5 minutes away. `-CraniumBiometry touchID` says Touch ID. To try the
real Keychain item and Face ID in the Simulator, enrol a face, run with `-CraniumBiometricCheck YES`,
and answer each prompt with a face; the console log lines start with `[faceid-check]` and never hold
the token:

```sh
xcrun simctl spawn booted notifyutil -s com.apple.BiometricKit.enrollmentChanged 1
xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit.enrollmentChanged
xcrun simctl launch --console-pty booted com.craniumiot.cranium -CraniumDemo -CraniumBiometricCheck YES
xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit_Sim.pearl.match     # or .nomatch
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
- The configuration: `apps/configure.sh` writes `apps/config/cranium.json` from the deployed stack,
  with the customer side's four keys once the stack has them (console 2.0.1; without them the app
  signs in admins only, and says so).
  It names the AWS account, so it is not in git, and the build copies it into the app, never into
  the source tree. Without it a Debug build uses `cranium.example.json`: an orange banner says so,
  and sign-in cannot work. A Release build stops.
- An Apple ID. A free one is enough for your own iPhone (Xcode's Personal Team) and for SideStore.
- For TestFlight only: an Apple Developer Program membership, and the app record in App Store
  Connect, with bundle ID `com.craniumiot.cranium`. Register the bundle ID first, at
  developer.apple.com under Certificates, Identifiers & Profiles, or let Xcode register it the first
  time it signs the app.
- For TestFlight only, an App Store Connect API key with the App Manager role (Users and Access,
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

### Keep it opening and up to date, with a free team, without a cable

An app signed by a free Personal Team stops opening 7 days after Xcode made its profile, and
TestFlight needs the paid Apple Developer Program. After the first Run from Xcode, the Mac does both
by itself, over Wi-Fi (or by cable):

```sh
apps/ios/scripts/renew.sh --schedule    # every hour: renews when 36 hours or less are left, and
                                        # installs a newer app when main has one
apps/ios/scripts/renew.sh --status      # when the app stops opening, what it was built from, whether the iPhone is in reach
apps/ios/scripts/renew.sh               # build and install now
```

It builds the newest commit on `main` on GitHub (fetched over HTTPS) in a copy of its own
(`~/Library/Caches/cranium-renew`), so work in progress is never installed, and keeps what the app
stored. A newer app is one whose `apps/ios` or `apps/shared` changed since the installed build, or a
new `apps/config/cranium.json`: it reaches the iPhone within the hour, whenever the iPhone is on the
Mac's Wi-Fi, and the Mac shows a notification saying the version. Away from that Wi-Fi the installed
app keeps working; it updates when it is back. The build waits its turn behind other heavy jobs
when `~/cranium-work/heavy.sh` is there. When the profile has 36 hours or
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

`check.sh` builds the package, runs its tests (Swift Testing: 319 `@Test` functions, 310 in
CraniumKitTests and 9 in CraniumBLETests; the firmware cache's on real files in a temporary folder), type-checks the
app's sources against the macOS SDK, and checks the scripts and `Info.plist`. On a Mac with only
the Command Line Tools, plain `swift test` cannot find Swift Testing; the script passes the paths.
`phone.sh --check` compiles the app for iPhone, without signing.
