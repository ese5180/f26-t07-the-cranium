# Cranium for Android

The firmware console on a phone. It does everything the website does, in the website's own
colours and words, by calling the console's API on AWS directly, and adds what only a phone can do:
updates over Bluetooth, and the board's serial console over a USB cable. It follows
[`docs/mobile-apps.md`](../../docs/mobile-apps.md); the board's side is in
[`firmware/README.md`](../../firmware/README.md#firmware-update-over-bluetooth).

## What is in it

The bottom bar has the website's sections, with the rest under More. Every screen is a Material 3
list: short section headers, standard rows, details one tap further, one primary action (the
button at the bottom right), the rest in the top bar's menu, and anything that destroys only on a
detail screen.

| Section | What it does |
| --- | --- |
| Overview | Updates in progress, or how the last one ended; boards online; the newest release; boards on unregistered firmware; the last five entries of the activity log |
| Boards | Every board, name first and thing name second, online or not, with its signal. A board's page has a header (name, thing, online, firmware), the update card only while an update is under way, and sub-pages: Firmware and slots (the flash map), Diagnostics (heartbeat to the second, uptime, signal, Wi-Fi, MAC, memory, stuck restarts, certificates, the last boots), Charts (signal and free memory over 24 h), Bluetooth, and Update history |
| Firmware | Every release, active and revoked. A release's page deploys it; send over Bluetooth, copy the SHA-256 and revoke are in its menu. Upload a signed `.bin` from the phone's files: the header and size are checked on the phone, then the server verifies the signature |
| Events | The boards' events with the console's activity as its own lane: ranges, a custom range, drag to zoom, a board filter, kinds on and off, online bands, and the list by day |
| More | Deployments (a deployment's boards step by step; offer again; cancel in its menu), Activity (the log by day; an entry's page), Update over Bluetooth, Serial console, API tokens, History, Help, Account |

When what a page shows is out of date (the last read failed, or it is much older than the page's
schedule), a clock shows in the top bar; tap it to read again, or pull the list down.

A viewer sees all of it and changes nothing; the serial console and Bluetooth are for release
managers, as on the website.

## Sign-in

The app has its own sign-in, as the website does: e-mail and password, then the six-digit code of
the authenticator app, in six boxes that fill from the keyboard, a paste or the code autofill, and
send themselves at the sixth digit. It is Cognito's SRP sign-in (`core/Srp.kt`,
`core/CognitoSignIn.kt`): the password goes into the proof and nowhere else; it is never sent,
kept or logged. Any other step Cognito asks for (a new password, setting up the authenticator)
opens the AWS sign-in page instead, with one line saying why; "Use the AWS sign-in page" does the
same at any time.

Tokens are kept as before, encrypted on the phone. They are renewed with `REFRESH_TOKEN_AUTH`,
whichever way the session began: the console's scope is added to renewed tokens too, and the time
of the sign-in stays the same.

A change from the phone (upload, revoke, deploy, cancel, make or revoke a token) needs a sign-in in
the last 15 minutes. The app reads the sign-in's time from the access token and asks for the
password and code first when it is older than 14 minutes, on the same screen with the e-mail
fixed; if the console still answers `403 phone_sign_in_again`, it asks and makes the change once
more. What was entered stays.

## Search and Help

Search, in every top-level screen's top bar, finds boards, releases, deployments, the events in
the loaded range, the activity log, the app's own screens and actions, and Help, grouped by kind
with the match in bold. Matching ignores case and accents and matches the start of words
(`core/Search.kt`). The last 10 searches are kept until sign-out.

Help is `apps/shared/help.json`, shared with the iPhone app and copied into the APK at build time.
It is under More, and the (?) in a screen's top bar opens its topic. The app writes no help text
of its own.

## The serial console over USB

The DK's J-Link (SEGGER, vendor 0x1366) shows two virtual COM ports; the application's console is
the second, VCOM1, at 115200 8N1. Connect the J-Link USB port to the phone with a USB OTG cable or
adapter, open More, Serial console, and allow the app to use the device when Android asks. The page
has the website's commands by group (Identity, Wi-Fi, MQTT, Status, Maintenance), a free command
line, and the transcript. If the board does not answer within 2 s, the page says so and offers the
other port. The Wi-Fi password is masked in the transcript, never kept in the history, held only in
its field until it is sent, and the bytes sent are overwritten afterwards; the board is told to stop
echoing before any line that holds one. Commands that erase the board need their name typed.

It uses [usb-serial-for-android](https://github.com/mik3y/usb-serial-for-android) 3.11.0 (MIT
licence), from JitPack, the only thing taken from there (`settings.gradle.kts`).

## Updates over Bluetooth

From a release on the Firmware page, or More, Update over Bluetooth: pick the release, open the
board's window (hold Button 1 for 5 s), pick `Cranium-` and four hex digits, type the passkey the app
shows, and the app sends the image with MCUmgr. It only uploads: no test, confirm, erase or reset,
which the board refuses. A person installs it by pressing Button 1 at the board.

Each connection still shows `[BT] refused a command: group 0, id 6, op 0` on the board's console.
That is mcumgr-ble asking for the board's SMP buffer sizes as it connects; it does no harm.

A checked image is kept in the app's private storage, `filesDir/firmware/<sha256>.bin`, checked
again in full before each use; at most 5, only for active releases, and sign-out deletes them all
("Clear downloaded firmware" too). Whatever the image came from, the app asks the console right
before every upload whether the release is still active and the image still its own, and sends
nothing without that yes, offline included (`core/SendCheck.kt`).

## What it needs

- JDK 17 and the Android SDK command-line tools. On a Mac, without sudo:

  ```sh
  brew install openjdk@17
  brew install --cask android-commandlinetools
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  SDK=/opt/homebrew/share/android-commandlinetools
  yes | sdkmanager --sdk_root=$SDK --licenses
  sdkmanager --sdk_root=$SDK "platform-tools" "platforms;android-37.0" "build-tools;36.0.0"
  echo "sdk.dir=$SDK" > apps/android/local.properties
  ```

- The configuration: `apps/configure.sh` writes `apps/config/cranium.json` from the deployed stack;
  the build reads the console URL, the login domain, the client ID, the region and the user pool
  from it. Without it the build uses `apps/config/cranium.example.json`, says so, and the app cannot
  sign in.
- `apps/shared/help.json`, the help, if there is one; without it the Help screen says so.

## Build

Debug, with the unit tests and lint:

```sh
cd apps/android
./gradlew --console=plain testDebugUnitTest assembleDebug lintDebug
```

The APK is `app/build/outputs/apk/debug/app-debug.apk`.

Release, signed:

```sh
apps/android/build-release.sh
```

It writes `apps/dist/cranium-android-<version>.apk` and checks it with `apksigner verify`. The
signing key is `~/.cranium/android/cranium-release.jks`, with its passwords in
`~/.cranium/android/keystore.properties`; the script makes both the first time. Back them up:
a phone only takes an update signed with the same key. The app's version is `craniumVersionName`
in `gradle.properties`, and has nothing to do with the firmware's.

Gradle is held to 1.5 GB and two workers (`gradle.properties`). Run `./gradlew --stop` when done.

## Install on a phone

- Over USB, with USB debugging on: `adb install -r apps/dist/cranium-android-<version>.apk`.
- Or share the APK privately with the team (a direct message, a drive folder only the team can
  open). The phone has to allow installing apps from wherever it was opened.

Android 8.0 (API 26) or later, with Bluetooth LE. The serial console needs a phone that can be a
USB host.

## Do not publish the APK

The APK holds the console URL, the login domain, the client ID and the user pool of the account it
was built for. Never attach it to a public GitHub release and never commit it: git ignores `*.apk`
and `apps/dist/` for that reason. The same goes for `apps/config/cranium.json` and the keystore.

## How it is built

- `core/`: everything that needs no phone, with JVM tests: reading every answer of the API field by
  field (`ApiModels.kt`), the website's words for updates, deployments, the activity log, events and
  diagnostics (`Updates.kt`, `Audit.kt`, `Telemetry.kt`, `Text.kt`), the serial console's rules and
  session (`Serial.kt`), the fresh sign-in rule (`FreshSignIn.kt`), the sign-in (`Srp.kt`,
  `CognitoSignIn.kt`), search and help (`Search.kt`, `Help.kt`), image checks and the firmware cache.
- `auth/`: the session on the phone (`TokenStore.kt`), Cognito over HTTPS (`CognitoHttp.kt`), and
  renewing and ending it (`AuthManager.kt`).
- `api/ApiClient.kt`: every route, with the access token, a refresh on 401, and the website's retries.
- `ui/`: Compose with Material 3, themed with the console's colour tokens for light and dark
  (`Theme.kt`) and its own icons (`Glyphs.kt`). `Screen.kt` is the frame of every screen and its
  rows. Pages are read when they open and again on the
  website's schedule, and nothing is read while the app is in the background.
- `ble/` and `usb/`: Bluetooth with Nordic's mcumgr-ble, USB serial with usb-serial-for-android.

## What is tested

`./gradlew testDebugUnitTest` runs JVM tests (292 of them) of the parts that need no phone: decoding
every answer, the wording of every update state, deployment, log entry, event and diagnostic against
the website's, the serial console's rules, masking and session on virtual time, the fresh sign-in
rule, URLs, the MCUboot header, the checks on an image, the check before a Bluetooth send, the
firmware cache, search, and reading the help file (`apps/shared/help.json` itself too, when it is
there).

The sign-in's arithmetic is checked against the website's own code: `app/src/test/resources/srp/make-vectors.mjs`
runs the website's SRP in Node with a fixed secret, salt, B, user, password and time and writes
`vectors.json`; `SrpTest` gets the same A, u, k, x, S, key and signature from them. The steps of the
sign-in, renewing and ending a session run against a fake Cognito (`CognitoSignInTest`).

Sign-in against the real Cognito, the API calls, Bluetooth and the USB serial console take a phone,
a deployed stack and a board, and have not been tried yet.
