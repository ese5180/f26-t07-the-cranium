# Cranium for Android

The firmware console on a phone. It does everything the website does, in the website's own
colours and words, by calling the console's API on AWS directly, and adds what only a phone can do:
updates over Bluetooth, and the board's serial console over a USB cable. It follows
[`docs/mobile-apps.md`](../../docs/mobile-apps.md); the board's side is in
[`firmware/README.md`](../../firmware/README.md#firmware-update-over-bluetooth).

From 0.6.0 it has two sides, as the customer website has (`docs/customer-site.md`): the **customer
side**, where a customer signs in to see their own boards, and **Admin mode**, the firmware console
below, for the team.

## The new app (0.8.0)

From 0.8.0 the app is a thin native shell around the website's own pages: the customer site at `/` and
the console at `/admin`, as the customer site's address serves them (docs/mobile-apps.md, "The app
shell"). What it shows comes from the console, so **a change to the website reaches the app with no new
APK**, on any network; only the shell itself needs an install, and that is the self-update below.

- **The pages.** A bundle of the website's files, each checked against its SHA-256, kept in the app's
  own storage (no backup) and served to a web view at `https://appassets.androidplatform.net` through
  WebViewAssetLoader, never from the network. In the background the app fetches the console's
  `/app/manifest.json` and the files that changed, at most four at a time, and swaps the new bundle in
  with one rename, keeping the one before; it shows after **Reload** or at the next start. A bundle that
  has not started after two tries is set aside for good, and the copy built into the APK is the last
  resort (`shell/BundleStore.kt`).
- **The bridge.** The pages ask the app for what only it can do, through `craniumNative`, a
  WebMessageListener offered to the bundle's origin only: the saved sign-in (the page signs in itself
  and hands the refresh token over; it gets access tokens only), fingerprint unlock, Bluetooth (scan,
  pair, the image list and the upload, the status characteristic, the board after its restart), the
  clipboard, haptics, sharing a file, opening an address outside, keeping the screen on, the shell's
  settings and the APK update. `apps/shared/bridge.json` is the contract, and every request is checked
  against it before anything runs (`shell/Bridge.kt`).
- **What the web view may do.** Each page gets its Content-Security-Policy from the app. The web view
  shows the bundle's origin and nothing else; a link anywhere else opens in the browser (`https:`) or in
  the app that takes it (`otpauth:`, an authenticator), and anything else goes nowhere; file and content
  access, mixed content and windows are off.
- **The classic app.** The native screens of 0.7 stay for this version, sharing the same sign-in:
  **Classic app** in the shell's settings (from the page's App settings), or the launcher shortcut of
  that name (a long press on the icon); **Use the new app** under More, or on the customer side's
  Account, or the shortcut **New app**, goes back. A phone whose Android System WebView is too old for
  the shell gets the classic app, with a line saying so.

## The customer side

The customer website's pages on a phone, in its words (`core/CustomerText.kt`, held to
`cloud/web/src/customer/assets/` by `CustomerWordsTest`), with its sections in the bottom bar:

| Section | What it shows |
| --- | --- |
| Overview | Online now, boards, firmware, last heard from; the boards; the last week of what they did; the mixes to come. With only an admin signed in: who, and Open admin mode |
| Devices | Every board on the account, as it last reported. A board's page: its state, firmware (on trial or not), last report, update in plain words, Wi-Fi signal, uptime, location ("Not reported") and since when it is the customer's, and the last 30 days of what it did |
| Mixes | Sessions, Transitions, Track library, Saved moments: each says "Not built yet", and why |
| Account | The address and name, a password change, two-step sign-in on or off (the setup key in groups of four, Copy the key, and an `otpauth://` link that opens an authenticator app), fingerprint unlock, Sign out |
| Help | The website's questions and answers |

It reads the customer API (`GET /api/c/me`, `/api/c/boards`, `/api/c/boards/{id}`, `/api/c/activity`,
`core/Customer.kt`) with the customer's own token, every 30 s on Overview and Devices, and names a board
only by the id of its assignment. A customer signs in to the customer pool with its phone client, on
the app's own screen (SRP, the code in six boxes if they turned it on, a new password at the first
sign-in), and resets a forgotten password with a code from the e-mail. Their session is kept apart from
the admin's: its own encrypted file, its own master key and its own fingerprint key (`core/SessionKeys.kt`).

There is one sign-in screen for everybody (`core/OneSignIn.kt`): the team's pool first, through the
console's own session, then the customer pool. A team account opens Admin mode: the whole app as it was, with
**Leave admin mode** under More and Account, which goes back to the customer side and keeps the admin
signed in. The customer side's Sign out ends both sessions, as the website's does; Admin mode's ends the
admin's only. The app opens on the customer side when a customer is signed in, else in Admin mode when
an admin is, else at the one sign-in. A build whose configuration has no customer pool signs in team
accounts only, on the same screen.

## Admin mode

The bottom bar has the website's sections, with the rest under More. Every screen is a Material 3
list: short section headers, standard rows, details one tap further, one primary action (the
button at the bottom right), the rest in the top bar's menu, and anything that destroys only on a
detail screen.

| Section | What it does |
| --- | --- |
| Overview | Updates in progress, or how the last one ended (from console 2.1.1 any update, over Bluetooth and by USB too); boards online; the newest release; boards on unregistered firmware; the last five entries of the activity log |
| Boards | Every board, name first and thing name second, online or not, with its signal. A board's page has a header (name, thing, online, firmware), the update card only while an update is under way, and sub-pages: Firmware and slots (the flash map), Diagnostics (heartbeat to the second, uptime, signal, Wi-Fi, MAC, memory, stuck restarts, certificates, the last boots), Charts (signal and free memory over 24 h), Bluetooth, and Update history (`GET /api/updates`, console 2.1.1: deployments, updates over Bluetooth and by USB or another tool, each kept, rolled back, not installed or pending; from an older console its deployments); then its latest lines (its newest 5 of the last 24 h) and All lines |
| Firmware | Every release, active and revoked, with its note in two lines. A release's page has the whole note under What changed and deploys it; send over Bluetooth, copy the SHA-256, Edit note (release managers; a change, so the fresh sign-in rule holds) and revoke are in its menu. Upload a signed `.bin` from the phone's files: the header and size are checked on the phone, then the server verifies the signature |
| Events | The boards' events with the console's activity as its own lane: ranges, a custom range, drag to zoom, a board filter, kinds on and off (Settings and Other lines among them), online bands, and the list by day. Then the Board log (`GET /api/events/log`, firmware 1.12.0 and later): each line to the second with its board, source, kind, a warning badge and the lines lost before it; a Source filter, Hide and Show, 500 lines a page; each line is also a tick at the foot of its board's lane, which TalkBack does not read |
| More | Deployments (a deployment's boards step by step; offer again; cancel in its menu), Activity (the log by day, in the website's sentences: sign-ins, the commands given at a board's serial console, deployments by board name, downloads to a phone and Bluetooth sends; an entry's page), Update over Bluetooth, Serial console, API tokens, History, Help, Account |

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

## Unlocking with a fingerprint

After a full sign-in (password and code, on the app's screen or the AWS page), the app offers once:
"Use your fingerprint to open Cranium?" It is also a switch under More, Account. It is offered only
when `BiometricManager.canAuthenticate(BIOMETRIC_STRONG)` succeeds, which on nearly every phone means
the fingerprint sensor; the device PIN is never a way in, the app's own sign-in is.

With it on:

- The refresh token is encrypted with an AES-256-GCM key in the Android Keystore (StrongBox if the
  phone has one, otherwise the TEE) that needs a strong biometric for every single use and is
  invalidated when a fingerprint is added or all are removed (`auth/KeystoreVault.kt`). Only the
  ciphertext and its IV are stored, in `EncryptedSharedPreferences`; no session is kept in the clear.
- When the app starts, and when it comes back after 5 minutes or more in the background, nothing of
  the console is shown until the fingerprint opens the token; the app then refreshes as usual.
- The lock screen is `FLAG_SECURE`. While the console shows, recents has no thumbnail of it
  (Android 13 and later without blocking screenshots, older versions with `FLAG_SECURE`).
- Cancel or "Sign in with password" goes to the sign-in; too many attempts says so and offers it. A
  new fingerprint, a missing key or a ciphertext that does not open turns it off, with one line why.
- A new full sign-in is kept behind the fingerprint with one more touch; a fresh sign-in for a
  change leaves the kept one as it is. Changes still need the password and code in the last 15
  minutes: the fingerprint only releases the token, and a refresh keeps the first sign-in's time.

With it off, the app forgets the refresh token an hour after the sign-in, so a 30-day token is
never kept without the fingerprint. Sign-out deletes the key and the ciphertext. The rules are in
`core/Fingerprint.kt`, with their tests.

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

For a release manager, a command that changes the board (the 14 of `SerialRules.RECORDED`, the
website's list) goes on record in the activity log once the board answered OK:
`POST /api/serial/commands` with the command's name and the board's device ID and firmware version
as it gave them (`GET_ID`), and nothing else, never a network, password, endpoint or certificate.
It is tried once and needs no fresh sign-in. Under the board's answer the page says "In the activity
log." or "Done on the board, but not in the activity log." with why.

It uses [usb-serial-for-android](https://github.com/mik3y/usb-serial-for-android) 3.11.0 (MIT
licence), from JitPack, the only thing taken from there (`settings.gradle.kts`).

## Updates over Bluetooth

From a release on the Firmware page, or More, Update over Bluetooth: pick the release, open the
board's window (hold Button 1 for 5 s), pick `Cranium-` and four hex digits, enter the passkey the app
shows (from 0.6.2 it is also on the clipboard for 2 minutes, marked sensitive: tap the field, Paste,
Pair), and the app sends the image with MCUmgr. It only uploads: no test, confirm, erase or reset,
which the board refuses. A person installs it by pressing Button 1 at the board. From 0.7.1 the app
then follows the board step by step until the image is kept or rolled back, and from 0.7.2, with
firmware 1.14.0 or later, it reads the board's own status over Bluetooth through the restart
([`docs/mobile-apps.md`](../../docs/mobile-apps.md#following-the-board-after-a-send)).

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
  from it, and for the customer side the customer API's address, the customer pool, its phone client
  and its Region (all four or none). Without it the build uses `apps/config/cranium.example.json`,
  says so, and the app cannot sign in.
- `apps/shared/help.json`, the help, if there is one; without it the Help screen says so.
- Node.js 20 or later on the `PATH` (or `CRANIUM_NODE=/path/to/node`), from 0.8.0: the build makes the
  web bundle it carries with `cloud/web/build-bundle.mjs`, from `cloud/web/src` in this checkout, and stops
  with a line saying so without it.

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

- From the console's **Apps** page on the phone: Download, open the file, allow installs from the
  browser. [`apps/README.md`](../README.md) has this and the other ways.
- Over USB or Wireless debugging: `apps/install.sh android` (Windows: `apps\install.ps1`), which checks
  the APK in `apps/dist/` against `SHA256SUMS` first; or by hand,
  `adb install -r apps/dist/cranium-android-<version>.apk`.

From 0.7.0 the app updates itself: it checks the console when it opens and once a day, and installs a
newer version, after checking its size, SHA-256 and signing key, with a tap
([`docs/mobile-apps.md`](../../docs/mobile-apps.md#updates-on-every-phone)). From 0.8.0 that is only for
the shell: the pages update by themselves, with no install (above).

Android 8.0 (API 26) or later, with Bluetooth LE. The serial console needs a phone that can be a
USB host.

## What the APK holds

The APK holds the console URL, the login domain, the client ID and the user pool of the account it
was built for: no password, key or token, and nothing the console's own website does not serve to
every visitor. Git ignores `*.apk` and `apps/dist/` for local builds; only the newest published build is
committed there, on purpose, by `apps/fetch-builds.sh`, byte for byte what the console serves. Never
commit `apps/config/cranium.json`, the keystore or its passwords.

## How it is built

- `core/`: everything that needs no phone, with JVM tests: reading every answer of the API field by
  field (`ApiModels.kt`), the website's words for updates, deployments, the activity log, events and
  diagnostics (`Updates.kt`, `Audit.kt`, `Telemetry.kt`, `Text.kt`), the serial console's rules and
  session (`Serial.kt`), the fresh sign-in rule (`FreshSignIn.kt`), the sign-in (`Srp.kt`,
  `CognitoSignIn.kt`), fingerprint unlock (`Fingerprint.kt`), search and help (`Search.kt`,
  `Help.kt`), image checks and the firmware cache. The customer side's: the customer API and what a
  board is doing in words (`Customer.kt`), the account at Cognito (`CustomerAccount.kt`), every word of
  its screens (`CustomerText.kt`) and where each session is kept (`SessionKeys.kt`).
- `auth/`: the session on the phone (`TokenStore.kt`), Cognito over HTTPS (`CognitoHttp.kt`),
  renewing and ending it (`AuthManager.kt`, one for each side, with `AuthSettings`), and the
  fingerprint's key (`KeystoreVault.kt`).
- `api/ApiClient.kt`: every route, with the access token, a refresh on 401, and the website's retries.
  `api/CustomerHttp.kt`: the customer API's GET.
- `ui/CustomerViewModel.kt` and `ui/CustomerScreens.kt`: the customer side, and which side is in front
  (`CraniumRoot`); `ui/ConsoleViewModel.kt` and the rest: Admin mode.
- `ui/`: Compose with Material 3, themed with the console's colour tokens for light and dark
  (`Theme.kt`) and its own icons (`Glyphs.kt`). `Screen.kt` is the frame of every screen and its
  rows. Pages are read when they open and again on the
  website's schedule, and nothing is read while the app is in the background.
- `ble/` and `usb/`: Bluetooth with Nordic's mcumgr-ble, USB serial with usb-serial-for-android.
- `shell/` (0.8.0): the new app. With JVM tests: the bundle's manifest (`BundleManifest.kt`), the store
  and its launch and update rules (`BundleStore.kt`), the bridge's contract, envelope and checks
  (`Bridge.kt`), the policies and where an address may go (`ShellPolicy.kt`), what the bundle's origin
  answers (`ShellServe.kt`) and the handlers' own checks (`ShellChecks.kt`). On the phone: the web view
  (`ShellWeb.kt`), the handlers (`ShellViewModel.kt`, `ShellAuth.kt` over `auth/`, `ShellBle.kt` over
  `ble/`) and its screen (`ShellScreen.kt`). The built-in bundle is made at build time by the Gradle task
  `buildWebBundle`, which runs `cloud/web/build-bundle.mjs` with Node.js (`CRANIUM_NODE` names another
  node) into `assets/web/`.

## What is tested

`./gradlew testDebugUnitTest` runs JVM tests (453 `@Test` methods) of the parts that need no phone: decoding
every answer, the wording of every update state, deployment, log entry, event and diagnostic against
the website's, the serial console's rules, masking and session on virtual time, the fresh sign-in
rule, URLs, the MCUboot header, the checks on an image, the check before a Bluetooth send, the
firmware cache, search, reading the help file (`apps/shared/help.json` itself too, when it is
there), and fingerprint unlock: its rules, and every answer of the key and the prompt, with a
software key standing in for the Keystore's (`FingerprintTest`).

The activity log's sentences are the website's own examples from `cloud/web/test/core.test.mjs`,
one for one (`AuditParityTest`), and `WebsiteListsTest` reads `core.js`, `serial.js` and the API's
`serial.mjs` and `lines.mjs` in this checkout, so that the refusal words, the words of the serial
commands, sign-ins and actions, the recorded commands and the board log's sources and kinds cannot
drift from them. The note, serial record and board log requests run against a fake console on
localhost (`ApiClientTest`), and the record a serial command leaves against a fake cable
(`SerialRecordTest`).

The sign-in's arithmetic is checked against the website's own code: `app/src/test/resources/srp/make-vectors.mjs`
runs the website's SRP in Node with a fixed secret, salt, B, user, password and time and writes
`vectors.json`; `SrpTest` gets the same A, u, k, x, S, key and signature from them. The steps of the
sign-in, renewing and ending a session run against a fake Cognito (`CognitoSignInTest`), and so does
a customer's first sign-in with its new password.

The customer side: the customer API's answers read as the customer site reads them, the assignment id
as the only way to a board, the customer's token sent only to `/api/c/`, a 401 tried once more
(`CustomerApiTest`); the account calls (`CustomerAccountTest`); the two sessions under names of their
own, each refreshed and revoked with its own client, one signed out and the other as it was
(`CustomerSessionTest`); and `CustomerWordsTest`, which reads the customer site's sources in this
checkout: ACCOUNT_WORDS and SIGN_IN_WORDS are the website's, every word of the customer screens is
found there (but for the few the phone has of its own), and a board's words are those of the
website's tests.

The new app's shell (`shell/`, 41 of them): the manifest against `apps/shared/bundle-sample.json`, which the
website's and the iPhone app's tests read too (it reads, its id is its canonical text's, every broken one is
refused); the store's launch, update, fallback and clean-up rules on a fake console; the bridge's table
against `apps/shared/bridge.json`, method for method and parameter for parameter, and every refusal of a
request before its handler runs; the policies and where each kind of address goes; and the bundle built
into this very build, read by the app's reader (`BuiltInBundleTest`).

Sign-in against the real Cognito, the API calls, the fingerprint prompt and the Keystore key,
Bluetooth, the self-update and the USB serial console take a phone, a deployed stack and a board; so do
the new app's web view, its bridge from a real page, the API's CORS for its origin and the CSP it sends.
The stack is deployed (console 2.1.0, with the customer pool), and the release workflow builds and
publishes the app; no result of the app on an Android phone is recorded in
[`docs/test-results.md`](../../docs/test-results.md) yet.
