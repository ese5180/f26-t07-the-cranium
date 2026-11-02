# Cranium for iPhone

A release manager signs in with the console's own account, picks a firmware release that is on
AWS, and sends it to an nRF7002 DK over Bluetooth LE with MCUmgr. The board still asks for a press
of Button 1 to install it. [`docs/mobile-apps.md`](../../docs/mobile-apps.md) is the contract this
app follows: sign-in, API calls, Bluetooth, what the board refuses, and what the app says when
something goes wrong.

**Nothing here has been compiled for iOS yet**, run on a phone, or tried against a board or the
real console. It was written on a Mac with only the Command Line Tools. The package below builds
and its tests pass there, and the app's sources type-check against the macOS SDK. Building for
iOS, signing, the upload, pairing and the transfer itself still have to be tried.

## What is where

| Path | What |
| --- | --- |
| `CraniumKit/` | Swift package with all the logic. `CraniumKit`: configuration, sign-in (PKCE, tokens in the Keychain), the console API, image checks, which releases to offer, the update flow. `CraniumBLE`: scanning, pairing, and MCUmgr through Nordic's [iOSMcuManagerLibrary](https://github.com/NordicSemiconductor/IOS-nRF-Connect-Device-Manager) 1.15.0 |
| `App/` | The SwiftUI app: sign in, release, board, passkey, upload, Button 1 |
| `project.yml` | The Xcode project, for [XcodeGen](https://github.com/yonaskolb/XcodeGen). The `.xcodeproj` is made from it and is not in git |
| `scripts/generate.sh` | Makes `Cranium.xcodeproj` |
| `scripts/testflight.sh` | Archives a Release build and uploads it to TestFlight |
| `scripts/check.sh` | Everything that can be checked without Xcode or a phone |
| `scripts/copy-config.sh` | Build phase: copies the configuration into the built app |

The app only lists the board's image slots and uploads to image 0. It never sends test, confirm,
erase or reset, which the board refuses. That is why it uses `ImageManager.upload` and not the
library's `FirmwareUpgradeManager`, whose upload-only mode still asks for parameters and resets.

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

## Check without Xcode

```sh
apps/ios/scripts/check.sh
```

It builds the package, runs its tests (77 of them, Swift Testing), type-checks the app's sources
against the macOS SDK, and checks the scripts and `Info.plist`. On a Mac with only the Command
Line Tools, plain `swift test` cannot find Swift Testing; the script passes the paths.
