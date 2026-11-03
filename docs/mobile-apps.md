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

Android adds `&prompt=login` to the sign-in: its Custom Tab shares the browser's cookies, and without
it a sign-out in the app would leave the managed login's own session behind, so that the next sign-in
went through, as the last person, without a password. The web console does the same. iOS opens an
ephemeral web authentication session, which keeps no cookies at all.

The app client allows no sign-in through the user pool API (no SRP, no password flow): only the
managed login pages above, and the refresh of its own tokens.

Every API call sends `Authorization: Bearer {access_token}`. Tokens go in the Keychain on iOS and
in `EncryptedSharedPreferences` on Android, never in plain storage or logs.

A token of the phone apps' client is good for the calls below and a few reads (`GET /api/firmware/{version}`,
`GET /api/devices`, `GET /api/devices/{thing}`), nothing else. Every other route of the API takes the
console's own sign-in only and answers a phone's token with `403 phone_not_allowed`: a phone cannot
deploy, revoke, upload, make API tokens or read the activity log, whoever is signed in on it.

## The API

All under `{consoleUrl}`. Errors are JSON `{"error": {"code": "...", "message": "..."}}` with an
HTTP status; show the message.

| Call | Who | Answer |
| --- | --- | --- |
| `GET /api/me` | Anyone signed in | `{"email", "groups": [...], "canWrite": bool, "expiresAt"}`. `canWrite` is true for a release manager |
| `GET /api/firmware` | Anyone signed in | `{"releases": [{"version": "1.8.0+0", "size", "sha256", "status": "active" or "revoked", "uploadedAt", "notes", ...}], "slotSize"}`, newest first |
| `GET /api/firmware/{version}/image` | Release managers | The signed image itself, `application/octet-stream`. 403 for anyone else, 404 for a revoked or unknown version. Recorded in the activity log |
| `GET /api/pairing/{name}` | Release managers | `{"thing", "name", "passkey": "123456", "reportedAt"}` for the board advertising as `{name}`, while a phone is pairing with it. 404 when no online board has one yet. A passkey handed out, and a refused caller, are recorded in the activity log; a 404 is not, because the app asks again |
| `POST /api/firmware/{version}/bluetooth` | Release managers | Body `{"sha256": "<the image's SHA-256, lower-case hex>", "board": "Cranium-1A2B"}`, `board` optional. Ask right before every Bluetooth send. `{"version", "sha256", "status": "active"}` only for an active release whose image has that SHA-256; 409 `release_revoked` for a revoked one, 409 `sha256_mismatch` for another image, 404 `unknown_version`, 400 for a malformed body. Changes nothing. Every call, refusals included, is recorded in the activity log (`firmware.bluetooth_send`) |

`{version}` is the text from the list, `1.8.0+0`, URL-encoded. Only offer `active` releases.

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

## Building and shipping

See `apps/ios/README.md` and `apps/android/README.md`. The iPhone app goes to TestFlight with an
App Store Connect API key kept in `~/.cranium`, never in git. The Android app is a signed APK,
shared with the team directly and not attached to a public release, because it holds the values
in the configuration above.
