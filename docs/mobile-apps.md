# Phone apps: updating a board over Bluetooth

Two apps, one for iPhone (`apps/ios`, Swift, shipped through TestFlight) and one for Android
(`apps/android`, Kotlin). Both do the same thing: a release manager signs in, picks a firmware
release that is on AWS, and sends it to a board over Bluetooth LE. Nothing else about the board
changes: MCUboot still checks the signature, the board still asks for a button press to install,
and the new image still runs on trial.

This file is the contract both apps follow. The board's side is in
[`firmware/README.md`](../firmware/README.md#firmware-update-over-bluetooth).

## What a person does

1. Sign in, with the console's own account. Only a release manager can download firmware.
2. Pick a release. The newest active one is chosen by default.
3. At the board, hold **Button 1** for 5 s and let go. LED1 flashes four times: Bluetooth is open
   for 3 minutes (2 before firmware 1.11.2).
4. In the app, pick the board, `Cranium-` and four hex digits.
5. Type the 6-digit passkey into the phone's pairing prompt. The app shows it, fetched from the
   cloud, when the board is online. Otherwise it is on the board's serial console, `[BT] passkey`.
6. The app sends the image: the one on the phone if it has it (see [Cache](#cache)), else one it
   downloads from AWS first. It takes a few minutes.
7. At the board, press **Button 1** within 2 minutes to install it. **Button 2** throws it away.
8. The board restarts and runs the new image on trial. It keeps it once it reaches AWS IoT.

## Configuration

The apps need four values from the deployed stack. They are not in git: the repository is public,
and they name the AWS account. `apps/configure.sh` writes them from `cloud/.deploy/outputs.json`
into `apps/config/cranium.json`, which git ignores, and each app reads that file at build time.

```json
{
  "consoleUrl": "https://console.example.com",
  "loginDomain": "https://login.example.com",
  "mobileClientId": "xxxxxxxxxxxxxxxxxxxxxxxxxx",
  "redirectUri": "cranium://signin"
}
```

`apps/config/cranium.example.json` has this shape with made-up values, for building without a stack.

## Signing in

OAuth 2.0 authorization code with PKCE (S256), against Cognito's managed login, with the mobile
app client. That client is public (no secret), allows only the `code` flow, and the scopes
`openid` and `cranium/console`. Its only redirect URI is `cranium://signin`.

| Step | Request |
| --- | --- |
| Sign in | Open `{loginDomain}/oauth2/authorize?response_type=code&client_id={mobileClientId}&redirect_uri=cranium://signin&scope=openid+cranium/console&code_challenge={S256}&code_challenge_method=S256&state={random}` in the system's web authentication session (`ASWebAuthenticationSession` on iOS, a Custom Tab through AppAuth on Android) |
| Code for tokens | `POST {loginDomain}/oauth2/token`, form `grant_type=authorization_code`, `client_id`, `code`, `redirect_uri`, `code_verifier` |
| Refresh | `POST {loginDomain}/oauth2/token`, form `grant_type=refresh_token`, `client_id`, `refresh_token` |
| Sign out | Forget the tokens, and `POST {loginDomain}/oauth2/revoke` with `token={refresh_token}`, `client_id` |

Every API call sends `Authorization: Bearer {access_token}`. Tokens go in the Keychain on iOS and
in `EncryptedSharedPreferences` on Android, never in plain storage or logs.

## The API

All under `{consoleUrl}`. Errors are JSON `{"error": {"code": "...", "message": "..."}}` with an
HTTP status; show the message.

| Call | Who | Answer |
| --- | --- | --- |
| `GET /api/me` | Anyone signed in | `{"email", "groups": [...], "canWrite": bool, "expiresAt"}`. `canWrite` is true for a release manager |
| `GET /api/firmware` | Anyone signed in | `{"releases": [{"version": "1.8.0+0", "size", "sha256", "status": "active" or "revoked", "uploadedAt", "notes", ...}], "slotSize"}`, newest first |
| `GET /api/firmware/{version}/image` | Release managers | The signed image itself, `application/octet-stream`. 403 for anyone else, 404 for a revoked or unknown version. Recorded in the activity log |
| `GET /api/pairing/{name}` | Release managers | `{"thing", "name", "passkey": "123456", "reportedAt"}` for the board advertising as `{name}`, while a phone is pairing with it. 404 when no online board has one yet. A passkey handed out, and a refused caller, are recorded in the activity log; a 404 is not, because the app asks again |

`{version}` is the text from the list, `1.8.0+0`, URL-encoded. Only offer `active` releases.

Before sending an image, the app checks it: its SHA-256 and size must match the list, and its
first four bytes must be MCUboot's magic, `3d b8 f3 96`. The version in its header (bytes 20 to 27:
major, minor, little-endian 16-bit revision, little-endian 32-bit build number) must equal the
release's.

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
activity log has only its first download.

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
| 403 from the API | Not a release manager | Ask an administrator for the role |

## Building and shipping

See `apps/ios/README.md` and `apps/android/README.md`. The iPhone app goes to TestFlight with an
App Store Connect API key kept in `~/.cranium`, never in git. The Android app is a signed APK,
shared with the team directly and not attached to a public release, because it holds the values
in the configuration above.
