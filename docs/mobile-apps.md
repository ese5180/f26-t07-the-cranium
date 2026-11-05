# Phone apps: updating a board over Bluetooth

Two apps, one for iPhone (`apps/ios`, Swift; installed with a free Apple team, see
[`apps/ios/README.md`](../apps/ios/README.md)) and one for Android (`apps/android`, Kotlin). Both do
everything the console's website does, and one thing more: a release manager picks a firmware release
that is on AWS and sends it to a board over Bluetooth LE. Nothing else about the board changes for
that: MCUboot still checks the signature, the board asks for a press of Button 1 to install an image
that came over Bluetooth (an update over Wi-Fi needs no button from 1.7.2 on), and the new image
still runs on trial.

This file is the contract both apps follow. The board's side is in
[`firmware/README.md`](../firmware/README.md#firmware-update-over-bluetooth).

## What a person does

1. Sign in, with the console's own account. Only a release manager can download firmware.
2. Pick a release. The newest active one is chosen by default.
3. At the board, hold **Button 1** for 5 s and let go. LED1 flashes four times: Bluetooth is open
   for 3 minutes (2 before firmware 1.11.2).
4. In the app, pick the board, `Cranium-` and four hex digits.
5. Type the 6-digit passkey into the phone's pairing prompt. The app shows it, fetched from the
   cloud, when the board is online, with the board the console gave it for ("Board in the console:
   cranium-…"), so that a mix-up between two boards shows. Otherwise it is on the board's serial
   console, `[BT] passkey`.
6. The app sends the image: the one on the phone if it has it (see [Cache](#cache)), else one it
   downloads from AWS first. Right before it sends, whatever the image came from, it asks the console
   whether the release is still active and the image is still its own
   (`POST /api/firmware/{version}/bluetooth`). It sends nothing without a yes: not after a refusal, and
   not when the console cannot be reached, which it says. It takes a few minutes.
7. At the board, press **Button 1** within 2 minutes to install it. **Button 2** throws it away.
8. The board restarts and runs the new image on trial. It keeps it once it reaches AWS IoT.

## Configuration

The apps need six values from the deployed stack. They are not in git: the repository is public,
and they name the AWS account. `apps/configure.sh` writes them from `cloud/.deploy/outputs.json`
into `apps/config/cranium.json`, which git ignores, and each app reads that file at build time.

```json
{
  "consoleUrl": "https://console.example.com",
  "loginDomain": "https://login.example.com",
  "mobileClientId": "xxxxxxxxxxxxxxxxxxxxxxxxxx",
  "redirectUri": "cranium://signin",
  "region": "us-east-1",
  "userPoolId": "us-east-1_xxxxxxxxx"
}
```

`apps/config/cranium.example.json` has this shape with made-up values, for building without a stack.

Without `cloud/.deploy/outputs.json`, a signed-in person gets the same file from the console: **Download the
configuration** on the Apps page (`GET /api/apps/config`, [The Apps page](#the-apps-page)) saves `cranium.json`
for `apps/config/`.

## Signing in

The apps sign in on their own screen, as the console's website does: the e-mail address and the
password, then the code from the authenticator app in six boxes. This is Cognito's user pool API with
SRP (`USER_SRP_AUTH`), so the password stays on the phone and is used for the proof only:

| Step | Request |
| --- | --- |
| Start | `POST https://cognito-idp.{region}.amazonaws.com/`, `X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth`, `AuthFlow: USER_SRP_AUTH`, `ClientId: {mobileClientId}`, `USERNAME`, `SRP_A` |
| Proof | `RespondToAuthChallenge` with `PASSWORD_VERIFIER`: the SRP-6a signature over the pool name (after the `_` of `userPoolId`), the user, the secret block and a timestamp in the form Cognito asks, from the server's clock |
| Code | `RespondToAuthChallenge` with `SOFTWARE_TOKEN_MFA` and `SOFTWARE_TOKEN_MFA_CODE` |

Tokens from that sign-in carry `cranium/console`: the user pool's pre token generation trigger
(`cloud/api/src/signin-scope.mjs`) adds it, and takes out `aws.cognito.signin.user.admin`, for the
console's web client and the phone apps' client only. Any other step Cognito asks for (a new password, an
authenticator app to set up, a password reset) is not done on that screen: the app says so and opens the
managed login pages instead, as below. Each app checks its SRP against the website's with the same
fixed numbers in a unit test.

The managed login, for those steps and as "Use the AWS sign-in page": OAuth 2.0 authorization code with
PKCE (S256), with the mobile app client. That client is public (no secret), allows only the `code` flow, and the scopes
`openid` and `cranium/console`. Its only redirect URI is `cranium://signin`.

| Step | Request |
| --- | --- |
| Sign in | Open `{loginDomain}/oauth2/authorize?response_type=code&client_id={mobileClientId}&redirect_uri=cranium://signin&scope=openid+cranium/console&code_challenge={S256}&code_challenge_method=S256&state={random}` in the system's web authentication session (`ASWebAuthenticationSession` on iOS, a Custom Tab through AppAuth on Android) |
| Code for tokens | `POST {loginDomain}/oauth2/token`, form `grant_type=authorization_code`, `client_id`, `code`, `redirect_uri`, `code_verifier` |
| Refresh | `POST {loginDomain}/oauth2/token`, form `grant_type=refresh_token`, `client_id`, `refresh_token` |
| Sign out | Forget the tokens, and `POST {loginDomain}/oauth2/revoke` with `token={refresh_token}`, `client_id` |

Android adds `&prompt=login` to the sign-in: its Custom Tab shares the browser's cookies, and without
it a sign-out in the app would leave the managed login's own session behind, so that the next sign-in
went through, as the last person, without a password. The web console does the same. iOS opens an
ephemeral web authentication session, which keeps no cookies at all, and adds `&prompt=login` too, so
that a sign-in again for a change (below) always asks for the password and code.

The app client allows SRP and the managed login pages, and the refresh of its own tokens; never
`USER_PASSWORD_AUTH`, which would send the password.

Every API call sends `Authorization: Bearer {access_token}`. Tokens go in the Keychain on iOS and
in `EncryptedSharedPreferences` on Android, never in plain storage or logs.

The apps do everything the website does, so a token of the phone apps' client is good for every route of
the API, with one rule: **a change made from the phone needs a sign-in, with password and code, in the last
15 minutes.** That covers uploading, revoking, deploying, cancelling, and making or ending API tokens. A phone
whose sign-in is older gets `403 phone_sign_in_again`, and the app asks for the password and code again
before it retries. Reads never ask. The three calls a person makes while standing at a board for an update
over Bluetooth do not ask either: the image, the passkey and the check before a send, and nor does the record of a
command given at a board's serial console ([below](#changes-made-at-a-boards-serial-console)). A deployment made from
the phone goes into the activity log with `from: phone`. A sign-in on the phone is in the activity log too, once,
as "signed in on the phone app", when the API sees the first request of it: a refreshed token keeps its `auth_time`
and is the same sign-in. The Android app also reads the access token's
`auth_time`, the claim the console checks, and asks for the sign-in before it tries a change once that is
more than 14 minutes old, so that a change is not refused on its way and logged as such.

### Unlocking with Face ID (iPhone) or a fingerprint (Android)

After a full sign-in (password and code), an app offers to keep the session behind the phone's biometrics. With that
on, opening the app asks for **Face ID on the iPhone** (Touch ID on an iPhone with a Home button, which has no Face ID)
or **a fingerprint on Android** (`BIOMETRIC_STRONG`, which a fingerprint sensor is; face unlock on most Android phones
is not) instead of the password and code, for up to 30 days, the phone client's refresh token lifetime:

| | Without biometrics (as before) | With biometrics on |
| --- | --- | --- |
| Where the refresh token is | The Keychain or `EncryptedSharedPreferences`, as today | iOS: a Keychain item with `SecAccessControl` `.biometryCurrentSet`, `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`. Android: encrypted with an AES key in the Android Keystore that needs the user's biometric for every use (`setUserAuthenticationRequired`, `setInvalidatedByBiometricEnrollment`), opened through `BiometricPrompt` with that key's `CryptoObject` |
| How long a session lasts | The app forgets the refresh token 60 minutes after the sign-in | Up to 30 days; each time the app opens, or comes back after 5 minutes in the background, it asks for the biometric before it shows anything |
| A new fingerprint or face is enrolled, or the passcode is removed | — | The item can no longer be opened: the app forgets it and asks for the password and code |
| Sign-out | Forgets the tokens, revokes the refresh token | The same, and deletes the item and the key |

Nothing biometric reaches the console: the phone only decides whether to release the refresh token. So the
15-minute rule above still holds: **a change asks for the password and code**, however the app was unlocked, because
a refresh keeps the first sign-in's `auth_time`. Three failed biometric attempts, or Cancel, offer the password
and code. The setting is per phone and per person, and is in the Account screen, with the phone's own name for it
(Face ID, or Touch ID on the iPhones that have it; fingerprint on Android).

## The API

All under `{consoleUrl}`. Errors are JSON `{"error": {"code": "...", "message": "..."}}` with an
HTTP status; show the message.

| Call | Who | Answer |
| --- | --- | --- |
| `GET /api/me` | Anyone signed in | `{"email", "groups": [...], "canWrite": bool, "expiresAt", "console": {"version": "1.10.0", "commit"}}`. `canWrite` is true for a release manager. `console` is the console's own version and the commit it was built from, `null` each where the deployment does not say: show it under Help, About |
| `GET /api/apps` | Anyone signed in | The apps on the console's Apps page: `{"android": {"latest": "0.4.0", "releases": [...]}, "ios": {"version": "0.4.0", "notes"}, "console"}`. An app older than its platform's newest here says so, once a day at most: "A newer app is on the console's Apps page" ([The Apps page](#the-apps-page)) |
| `GET /api/firmware` | Anyone signed in | `{"releases": [{"version": "1.8.0+0", "size", "sha256", "status": "active" or "revoked", "uploadedAt", "notes", ...}], "slotSize"}`, newest first |
| `GET /api/firmware/{version}/image` | Release managers | The signed image itself, `application/octet-stream`. 403 for anyone else, 404 for a revoked or unknown version. Recorded in the activity log |
| `GET /api/pairing/{name}` | Release managers | `{"thing", "name", "passkey": "123456", "reportedAt"}` for the board advertising as `{name}`, while a phone is pairing with it. 404 when no online board has one yet. A passkey handed out, and a refused caller, are recorded in the activity log; a 404 is not, because the app asks again |
| `POST /api/firmware/{version}/bluetooth` | Release managers | Body `{"sha256": "<the image's SHA-256, lower-case hex>", "board": "Cranium-1A2B"}`, `board` optional. Ask right before every Bluetooth send. `{"version", "sha256", "status": "active"}` only for an active release whose image has that SHA-256; 409 `release_revoked` for a revoked one, 409 `sha256_mismatch` for another image, 404 `unknown_version`, 400 for a malformed body. Changes nothing. Every call, refusals included, is recorded in the activity log (`firmware.bluetooth_send`) |

`{version}` is the text from the list, `1.8.0+0`, URL-encoded. Only offer `active` releases.

### Changes made at a board's serial console

An app that drives a board's serial console over USB (the Android app does) puts each command that changed the
board in the activity log, as the website's Serial page does. The server never sees the command itself, so the app
says which one it was, once the board has answered it with `OK`:

| Call | Who | Answer |
| --- | --- | --- |
| `POST /api/serial/commands` | Release managers | Body `{"command": "WIFI", "device": "CRVIHAAN01", "version": "1.12.0+0"}`. `201 {"recorded": {"command", "device", "version"}}`. Recorded in the activity log (`serial.command`), with `from: phone` |

- **When.** Right after the board's final line for the command is `OK ...`, for these commands only: `INIT`,
  `SET_ID`, `RESET_CONFIG`, `FACTORY_RESET`, `WIFI`, `WIFI_SEC`, `CLEAR_WIFI`, `CLOUD`, `KEYGEN`, `MQTT_HOST`,
  `MQTT_RECONNECT`, `BUTTON`, `REBOOT`, `ENTER_BOOTLOADER`. Not after `ERR`, not for a command that only asks
  (`GET_ID`, `STATUS`, `NET`, `MQTT`, `HELP`), and not for what the app sends by itself (`ECHO|OFF`, the `GET_ID`
  after connecting). A command typed by hand counts the same as one from a form; compare the name in capitals.
- **What.** `command` is the command's name in capitals, as the firmware compares it. `device` and `version` are what
  the board answered to `GET_ID` (`OK <device ID>|<version>`): the device ID only if it is 1 to 32 letters or digits,
  the version only in the form `1.12.0+0`; leave either out otherwise, as for a board in factory mode. **Nothing
  else**: never the network's name, the password, the endpoint, a key or a certificate, and never the line as it was
  typed. The server refuses a body with any other field (`400 unexpected_field`), and that refusal is on record.
- **Who.** A release manager, as the server asks Cognito at that moment; a viewer gets `403 release_manager_required`.
  A phone needs no sign-in in the last 15 minutes for it, as for the calls at a board for Bluetooth: the change is
  made by then, and a refusal would only keep it off the record.
- **Limit.** At most 30 a minute per person. One more gets `429 rate_limited`, which is not retried and leaves no
  entry.
- **If it fails.** The command is done on the board whatever the answer. Say so next to the board's own `OK`: that it
  was done, and that it is not in the activity log, with the server's message. Do not send the command again, and do
  not queue the record for later: a record that arrives late would be dated late.

The website does the same (`cloud/web/src/site/assets/serial.js`, `recordCommand`). From firmware 1.12.0 the board
also reports the same commands to the cloud by itself, in its board log (`[CONSOLE] WIFI done on the serial console:
...`); the record says who did it.

Before sending an image, the app checks it: its SHA-256 and size must match the list, and its
first four bytes must be MCUboot's magic, `3d b8 f3 96`. The version in its header (bytes 20 to 27:
major, minor, little-endian 16-bit revision, little-endian 32-bit build number) must equal the
release's.

Then, right before the upload, it asks `POST /api/firmware/{version}/bluetooth` with that image's
SHA-256, whether the image was downloaded just now, kept on the phone, or checked earlier in the
session. It sends only if the answer is 200 and names the same version, the same SHA-256 and
`active`. Anything else, an answer that cannot be read and no answer at all included, means nothing
is sent. Offline, the app does not fall back on the image it holds: it says that the console could
not be reached and that nothing was sent. So a release revoked since the phone downloaded it is not
sent by these apps, and every send leaves an entry in the activity log.

What this cannot do: a board takes any image signed with the project's key that is newer than what it
runs, from whoever has its Bluetooth window open, with no way to ask the console. Revocation is
enforced by the console, by S3 and by these apps, not by the board. Someone at the board with a signed
image of a revoked release, and another way to upload it, can still install it on a board that runs
an older version. Revoking stops the image from being handed out and from being sent by the apps; a
board is out of its reach only once it runs a newer release, because a board never takes an older
version.

## Cache

The apps keep checked images on the phone, so that sending a release again needs no download. Each
is `firmware/<sha256>.bin`, named after its release's SHA-256, in app-private storage that is not
backed up: `filesDir` on Android (the app allows no backup), Application Support on iOS (excluded
from iCloud backup). When a release is chosen and the phone holds its file, the file goes through
the whole check above against the release in the list; it is sent, with no download, only if it
passes, and is deleted and downloaded again if not. A download is kept only after it passes, written
to a temporary file and renamed into place. At most 5 images stay, the least recently used going
first. Each time the list loads, the files of releases that are no longer active (revoked or gone)
are deleted, and an account that is not a release manager keeps none. Sign-out, the end of a
session, and "Clear downloaded firmware" delete them all, and a phone that is no longer signed in
sends nothing from the cache. The app says whether the image came from the phone or was downloaded,
and its size. An image sent from the phone makes no `GET /api/firmware/{version}/image`, so the
activity log has only its first download, but every send, from the cache or not, is preceded by
`POST /api/firmware/{version}/bluetooth`, which is recorded. An image in the cache is never sent on
its own strength: without the console's yes at that moment it stays on the phone.

## Bluetooth

| | |
| --- | --- |
| Advertised name | `Cranium-` and four upper-case hex digits, new for each window. Nothing else identifies the board |
| Advertising data | The SMP service UUID `8D53DC1D-1DB7-4CD3-868B-8A527460AA84` |
| SMP characteristic | `DA2E7828-FBCE-4E01-AE9E-261174997C48`: write without response, and notify |
| Pairing | LE Secure Connections only, passkey shown by the board and typed on the phone. No bond is kept, so every session pairs again. The phone's OS asks for the passkey when the app first touches the characteristic. The board drops a link that has not paired within 45 s |
| Idle link | The board drops an authenticated link with nothing on it for 120 s (30 s before firmware 1.11.2). While the person chooses a release and the image downloads, read the image state every 10 to 20 s |
| MTU | The board takes ATT packets up to 498 bytes and SMP packets up to 512 |
| Versions | The board's image state gives `1.8.0`, or `1.8.0.5` when the build number is not 0, never `1.8.0+5`. Compare major, minor, revision and build number, as the board does |

Ask for the passkey from the moment the phone connects until it has paired, every 3 s and for at
most 90 s: the board draws a new one for each attempt, and reports it about a second after the
attempt starts.

Scan for the service UUID, and show the names found. Use Nordic's nRF Connect Device Manager
library: [`iOSMcuManagerLibrary`](https://github.com/NordicSemiconductor/IOS-nRF-Connect-Device-Manager)
on iOS and [`mcumgr-ble`](https://github.com/NordicSemiconductor/Android-nRF-Connect-Device-Manager)
on Android.

What the board allows on an authenticated link:

| Command | |
| --- | --- |
| Image state read (`image list`) | Allowed. Slot 0 is what runs: its `version` decides what may be sent |
| Image upload, image 0 | Allowed, once per window, only for a version strictly newer than what runs |
| Image test, confirm, erase, reset, anything else | **Refused** |

So the apps upload only: no test, no confirm and no reset afterwards. Use the image manager's
upload directly. The libraries' "firmware upgrade" managers ask for parameters first and end with a
test or a reset, even in their upload-only mode, and the board refuses those, which the person would
see as a failure when nothing failed. Android's library also asks for parameters by itself when it
connects. The board refuses that too, and prints `[BT] refused a command: group 0, id 6, op 0`,
which is harmless.

An upload the board refuses at its first piece comes back as MCUmgr error 6 (bad state) or 11
(access denied): not newer than what runs, or an image already sent in this window.

Reading the image state has one effect besides: on a board whose new image is on trial with no Wi-Fi
in reach, a read on a paired link is part of what keeps that image (`proof: person` in the firmware's
README). That is by design, and it is why only a person at the board can open the window.

Offer only releases newer than the version in slot 0. When the upload finishes, tell the person to
press Button 1 on the board within 2 minutes, and disconnect. Afterwards the app can poll
`GET /api/devices/{thing}` (the `thing` from the pairing call) to show the board coming back on the
new version, but the board's own LEDs and console are the real answer.

## Errors to expect

| What happens | Why | What the app says |
| --- | --- | --- |
| No board found | Window not open, or closed after 3 minutes | Hold Button 1 for 5 s, then look again |
| Pairing fails | Wrong passkey. Three failures close the window | Open the window again, and use the new passkey |
| Upload refused at the start | Not newer than what runs, or already sent in this window | Pick a newer release, or open a new window |
| Disconnected during upload | Out of range, or the window closed | Open a new window and send it again: it starts over |
| The console does not clear the send | The release was revoked since, or the image is not the release's | Nothing was sent, in the console's words |
| The console cannot be reached at the send | No connection | Nothing was sent: the image on the phone is only sent once the console says the release is still active |
| 403 from the API | Not a release manager | Ask an administrator for the role |

## The Apps page

The console's Apps page (`#/apps`, in the masthead) is where the team gets the apps.

- **Android**: the newest release on the console with its note, size and SHA-256, a **Download** button, and on
  request a QR code for a phone to scan; how to install it ("Install unknown apps", open the APK, the first
  sign-in); the older releases, folded away.
- **iPhone**: the newest version published as an IPA (else its version and note from `apps/ios/CHANGELOG.md` as this
  deployment was built), with a download of the IPA; **On any iPhone, with SideStore**: the member's own source link
  ([Updates on every phone](#updates-on-every-phone)); and how to install it with a Mac instead: `git clone`,
  **Download the configuration** for `apps/config/`, `apps/ios/scripts/phone.sh`, Trust, Run, and
  `renew.sh --schedule`, which renews the 7-day profile and installs each newer app from `main` over the Mac's Wi-Fi,
  with no cable.
- **Build the Android app yourself**: `git clone`, the configuration, `./gradlew assembleDebug`.

**The download link and the QR code.** A download is a presigned S3 link, good for 15 minutes, made when somebody
asks for one and recorded as `app.download`. The QR code holds such a link, so that the phone that scans it downloads
the APK without signing in to the console: a phone that would first have to sign in to the website (password and code,
on a phone) is the step the QR code is there to save. That makes the code a key for 15 minutes to whoever sees it, so
it is drawn only when asked for, says until when it is good, is gone from the page after that, and goes on record with
`via: qr`. The APK holds nothing secret: the console's address and its public client IDs, and it signs nobody in by
itself. The code is drawn by the page from Project Nayuki's QR Code generator (MIT), vendored and pinned in
`cloud/web/src/site/assets/qrcode.js` with its licence beside it; nothing comes from a CDN. A presigned URL is about
1,500 characters, mostly the role's session token, so the code is a large one (version 28 or so, 129 modules), at the
lowest error correction, and 3 px a module where the page is wide enough: scan it from a computer's screen.

**Publishing the Android app.** `apps/android/build-release.sh` builds the signed APK and then runs
`apps/android/publish.sh` (`--no-publish` skips it), which takes an API token as `scripts/upload-to-console.sh` does
(`CRANIUM_TOKEN`, or `~/.cranium/console-token` with mode 600; its owner a release manager). The version is the one in
the APK's name, the `versionCode` `craniumVersionCode`, both checked against the APK with the SDK's `aapt2` where it is
installed, and the note the first paragraph of the version's entry in `apps/android/CHANGELOG.md`. An APK is bigger
than API Gateway takes, so it goes to S3 directly:

| Step | Request |
| --- | --- |
| A URL | `POST /api/t/apps/android/uploads`, body `{"version": "0.4.0", "versionCode": 4, "sha256": "<hex>", "size": 12027314, "notes": "..."}`. 201 `{"upload": {"method": "PUT", "url", "headers": {"content-length", "x-amz-checksum-sha256"}, "expiresAt"}}`: a presigned PUT, good for 15 minutes, for exactly that size and SHA-256 |
| The file | `PUT` to that URL with those headers: `curl --upload-file`. S3 refuses other bytes (400 `BadDigest`) and another size (403) |
| The check | `POST /api/t/apps/android/releases/0.4.0`, the same body without `version`. 201 `{"release"}` once S3's size and SHA-256 of what arrived are the ones described |
| A download | `GET /api/apps/android/0.4.0/download` (`?via=qr` for the QR code), any member: `{"download": {"url", "expiresAt", "filename", "size", "sha256"}}` |
| The configuration | `GET /api/apps/config`, any member: `apps/config/cranium.json` as above |

A version is published once and only upward, by its version and its `versionCode`. `publish.sh` exits 0 when it has
published the APK or the console has that version with the same bytes, 1 when it was refused (with the console's or
S3's words), 2 without a token. From a phone, a download and the configuration are reads; starting and finishing a
publish are changes, which need a sign-in in the last 15 minutes. More, with the bucket and the API role's three S3
actions: [`docs/aws-iot.md`](aws-iot.md#the-phone-apps-on-the-console).

## Updates on every phone

A new version reaches every phone that has the app, from anywhere and for free. A release is made by the workflow
`.github/workflows/release-apps.yml`, from a tag `android-v<version>` or `ios-v<version>` or from **Run workflow** on
GitHub's website ([`docs/ci.md`](ci.md#releasing-the-apps)), or from a release manager's computer with the same scripts.
Either way it ends on the console, and the phones take it from there.

**Android: in the app.** The app asks the console's `GET /api/apps` when it opens and once a day in the background
(WorkManager, on any network), and compares the highest `versionCode` published with its own. A newer one shows as
**Update available: <version> — <note>** above every page, and as a notification (channel "App updates", once per
version; Android 13 and later ask once whether the app may send notifications). A tap gets a download link
(`GET /api/apps/android/<version>/download?via=app`, on record as `app.download` with `via: app`), downloads the APK
into the app's cache, checks its size and SHA-256 against what the console said, and that Android reads it as this app
with that `versionCode` and the same signing key, and only then hands it to Android's installer. The first time,
Android asks to allow installs from Cranium ("Install unknown apps"): allow it, go back, and tap the banner again. A file
that fails a check is deleted and the banner says why. The background check uses the saved sign-in only when
fingerprint unlock is off and its token is still good; it never asks for anything and never signs anyone out, so on a
phone with fingerprint unlock the check happens when the app opens. The code is in
`apps/android/app/src/main/java/com/craniumiot/cranium/update/`.

**iPhone: SideStore.** [SideStore](https://sidestore.io) is a free, open-source app that signs apps on the iPhone with
the person's own Apple ID (a free account will do) and keeps them up to date from "sources". The release workflow builds
the app as an **unsigned IPA** (`apps/ios/scripts/build-ipa.sh`) and publishes it on the console
(`apps/ios/scripts/publish.sh`); each member has a source of their own that lists it. Once, for each member of the team:

1. Install SideStore on the iPhone with a computer, by
   [SideStore's own guide](https://docs.sidestore.io/docs/installation/prerequisites), and sign in to it with your own
   Apple ID. This is the one step that needs a computer.
2. On the console's Apps page, under iPhone, press **Make my SideStore link**. It is shown once: tap **Add to
   SideStore** on the iPhone, or scan the QR code with the iPhone's camera, or copy the address into SideStore's
   Sources. Keep it to yourself: it downloads the app without signing in.
3. In SideStore, open the Cranium source and install **Cranium**. Open it and sign in with your console account. Face ID
   works as it does in any app: the app's saved sign-in uses the keychain with biometry, which needs no entitlement.
4. SideStore renews the app on the iPhone every 7 days, over Wi-Fi, by itself, and shows each new version under
   Updates. If it has not refreshed for a week, open SideStore once.

A free Apple ID can have three apps signed at a time, SideStore itself among them, and ten new app IDs a week. The app
is signed with the person's team, so it keeps its own sign-in and settings from one update to the next, but not across
a change of Apple ID. Nothing in the app uses App Groups, iCloud or push notifications, which a free team cannot sign.

**How the source works.** The link is `<console>/api/sidestore/crs_<key>/source.json`: a capability URL, since
SideStore signs in to nothing. The key is 32 random bytes, shown once; the console keeps its SHA-256, never the key, so
it cannot show it again. **Make a new link** ends the old one at once, and **Turn it off** ends it. The source lists the
published iPhone versions, newest first, each with its note (the first paragraph of its entry in
`apps/ios/CHANGELOG.md`), its size and SHA-256, which SideStore checks, and a download address under the same key
that answers `302` with a presigned S3 link made at that moment, good for 5 minutes: the source never goes stale, and
the IPA has no public address. Every use asks Cognito whether the key's owner is still a member, so someone removed
from the console takes their source with them; a key is used at most 30 times a minute, and the route at most 2 a
second for everybody. A dead or guessed key gets the same `404` and leaves no entry in the activity log; a download
through a live one goes on record as `app.ios_download` in its owner's name, with `via: sidestore`. Reading the
source does not, since SideStore reads it every time it looks for updates.

**The owner's iPhone, from the Mac.** `apps/ios/scripts/renew.sh --schedule` keeps building the app from `main` and
installing it over the Mac's Wi-Fi with Xcode's free team, as before ([`apps/ios/README.md`](../apps/ios/README.md)).
It does not need the console, and it works with SideStore on other phones.

**Publishing the iPhone app by hand.** `apps/ios/scripts/build-ipa.sh --publish`, on a Mac with Xcode and
`apps/config/cranium.json`, does what the workflow does. The two calls are the Android app's, for an IPA:

| Step | Request |
| --- | --- |
| A URL | `POST /api/t/apps/ios/uploads`, body `{"version": "0.6.0", "buildVersion": "8", "sha256": "<hex>", "size": 15432100, "notes": "..."}`: a presigned PUT for exactly that size and SHA-256 |
| The file | `PUT` to that URL with those headers |
| The check | `POST /api/t/apps/ios/releases/0.6.0`, the same body without `version`. The size and SHA-256 must hold, and then the console reads `Payload/Cranium.app/Info.plist` out of the zip in S3: the bundle ID `com.craniumiot.cranium`, the version and the build described, and `cranium.json` this console's, with no example configuration (`422 ipa_mismatch`, or `ipa_unreadable` for a file that is not an IPA) |
| A download | `GET /api/apps/ios/0.6.0/download`, any member |
| The source link | `GET`, `POST /api/apps/sidestore` (a new one) and `POST /api/apps/sidestore/revoke`, a member's own, from the website only |

A version is published once and only upward, by its version and its build (`CURRENT_PROJECT_VERSION`,
`422 build_not_higher`).

## Building and shipping

See `apps/ios/README.md` and `apps/android/README.md`. The iPhone app reaches the team through SideStore (above), and
can still go to TestFlight with an App Store Connect API key kept in `~/.cranium`, never in git, for a paid team. The Android app is a signed APK, published on the
console's Apps page by `apps/android/build-release.sh` (above) for the team to download, and never attached to a
public release, because it holds the values in the configuration above.
