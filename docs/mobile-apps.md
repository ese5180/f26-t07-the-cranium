# Phone apps: updating a board over Bluetooth

Two apps, one for iPhone (`apps/ios`, Swift; installed with a free Apple team, see
[`apps/ios/README.md`](../apps/ios/README.md)) and one for Android (`apps/android`, Kotlin). From version
0.6.0 each has two sides, as the customer website has ([docs/customer-site.md](customer-site.md)): a
customer's, who signs in to see their own boards ([Customers](#customers), below), and **admin mode** for the
team, which is everything the console's website does, and one thing more: a release manager picks a firmware
release that is on AWS and sends it to a board over Bluetooth LE. Nothing else about the board changes for
that: MCUboot still checks the signature, the board asks for a press of Button 1 to install an image
that came over Bluetooth (an update over Wi-Fi needs no button from 1.7.2 on), and the new image
still runs on trial.

From 0.8.0 the screens of both apps are the console's and the customer site's own pages, kept on the phone and
updated from the console without a reinstall, around a thin native shell: [The app shell](#the-app-shell). The 0.7
screens stay for that one version, as Classic app.

This file is the contract both apps follow. The board's side is in
[`firmware/README.md`](../firmware/README.md#firmware-update-over-bluetooth).

## The app shell

From 0.8.0 each app is a thin native shell around the console's and the customer site's own pages. What a person sees
is the website: the customer site, and the console as admin mode, with the same words, the same code and the same
API calls. The pages come from a copy kept on the phone, which the app brings up to date from the console by itself,
on any network. So a change to the website reaches every phone that has the app, with no reinstall, no cable and no
Mac; on an iPhone with a free Apple ID that is the only way an update can reach a phone that is away from the Mac.
What a page cannot do itself (keep the sign-in behind Face ID or a fingerprint, Bluetooth to a board, the clipboard
with an expiry, haptics, the share sheet, opening SideStore) the app does for it, through a small bridge.

| | Updates without a reinstall | Needs a new app |
| --- | --- | --- |
| What | Every screen, its words and its rules: the pages, the Bluetooth update flow, the sign-in pages | The native shell: the bridge and what it can do, the web view, the bundle store |
| How | The Deploy console workflow ([ci.md](ci.md#deploying-the-console-from-github-actions)), or `cloud/deploy.sh` on the owner's laptop, deploys the console; each app takes the new pages at its next start | iPhone: SideStore or `renew.sh` as before; Android: the app's own update, as before |
| When it needs one | | A bundle that needs a newer bridge than the app has is not taken; the app's settings and the page's foot say so |

### The parts

| Part | Where | What |
| --- | --- | --- |
| The bundle | `cloud/web/src/bundle.mjs`, served by the web function | The pages and files of both sites, with a manifest |
| The built-in copy | `cloud/web/build-bundle.mjs`, run by each app's build | The same bundle inside the app, for a first start and as the last resort. The app builds need Node.js |
| The shell, iPhone | `apps/ios/App/Shell/`, `CraniumKit/Sources/CraniumKit/Shell/` | A WKWebView on `cranium-app://bundle`, served by a WKURLSchemeHandler |
| The shell, Android | `apps/android/app/src/main/java/com/craniumiot/cranium/shell/` | A WebView on `https://appassets.androidplatform.net`, served through WebViewAssetLoader |
| The bridge's contract | `apps/shared/bridge.json` | Every method, its parameters and their ranges, the events, the errors, the policies. All three test suites read it |
| The page's side | `cloud/web/src/site/assets/bridge.js` | Finds the app, says hello, and gives the pages `cranium.bridge` |

The app opens the customer site at `/` of its origin, or the console at `/admin` when its configuration has no
customer pool, exactly as the customer site's own name serves them. A page knows it is in the app because the app's
transport is there (`window.webkit.messageHandlers.cranium` on the iPhone, `window.craniumNative` on Android); on the
website it is not, `bridge.js` is not even fetched, and nothing changes.

### Bundle delivery

The web function builds the bundle when it starts, from the very files it serves, so the two can never disagree:

| Request | Answer |
| --- | --- |
| `GET /app/manifest.json` | The manifest, revalidated on every request (`no-cache`) |
| `GET /app/files/<sha256>` | One file, by the SHA-256 of its bytes, cached for ever |

Both on the console's names and the customer site's first name, never the home page's; a route of their own in the
HTTP API (`GET /app/{proxy+}`, public like the pages, 10 a second and bursts of 40).

```json
{
  "format": 1,
  "id": "0d06031f7d2373cf",
  "bridge": 1,
  "console": { "version": "2.1.1", "commit": "<40 hex>" },
  "builtAt": "2026-11-05T12:00:00.000Z",
  "routes": {
    "/": { "file": "index.html", "policy": "customer" },
    "/admin": { "file": "admin/index.html", "policy": "console" }
  },
  "files": [{ "path": "assets/331b09bc765e/core.js", "size": 177738, "sha256": "<64 hex>" }]
}
```

- **What is in it.** The customer site's page as `index.html` and the console's as `admin/index.html`, each with the
  build ids written in and `{"app":true}` in its settings tag instead of the server's settings, and every file of both
  sites under `assets/<build id>/`, `versions.json` and `history.json` included where the deployment wrote them. The
  home page is not. Nothing of the stack is in it: in the app a page asks the app for its settings (`app.config`, from
  the app's own `cranium.json`), so the bundle is the same files every visitor of the websites gets.
- **Its id** is the first 16 hex digits of the SHA-256 of a text that states every fact the app acts on, one a line:
  `cranium-bundle 1`, `bridge 1`, each route (`route / index.html customer`), and each file
  (`file <path> <size> <sha256>`), in byte order (`canonicalText` in `bundle.mjs`). The console's version and the time
  are not in it: they change nothing the app serves.
- **What a manifest may say.** Format 1; at most four parts in a path, of lower-case letters, digits, `.`, `-` and `_`,
  none starting with a dot; only `.html`, `.css`, `.js`, `.json` and `.txt`; at most 300 files, 8 MiB each and 32 MiB in
  all; the two routes and no others, each to a file it lists; and the id that the rest works out to.
  `readManifest` in `bundle.mjs` and the two apps' readers follow the same rules, and their tests read the same sample,
  `apps/shared/bundle-sample.json`, with its broken manifests.

**On the phone** (`BundleStore` in each app), in app-private storage that is not backed up:

1. **At start** the app shows the current bundle if every file it names is there and matches its SHA-256, and it is not
   marked bad; else the previous one, checked the same way; else the copy built into the app. A path in a manifest is
   only a key: files are kept as `objects/<sha256>`, so no path from a server ever becomes a file name.
2. **A good bundle** is one whose pages started: each page tells the app (`app.ready`) once it has drawn its sign-in or
   its first page. One that has not after two starts is marked bad, never fetched again, and the one before it is shown.
3. **In the background**, when the app starts and when it comes back to the foreground (at most every 10 minutes), it
   fetches the manifest from the console's address built into it, over HTTPS (15 s at most). A manifest with the same
   id, or one that needs a newer bridge, changes nothing. Otherwise it fetches each file it does not have, four at a
   time, writes each to a temporary file, keeps it only if its size and SHA-256 are the manifest's, then writes the new
   manifest as `current.json` in one rename, the one before becoming `previous.json`, and deletes the files neither
   names. The page is told (`app.bundleReady`) and the new pages show at the next start (on the iPhone also at once,
   with Reload in the app's settings).

### The bridge

`apps/shared/bridge.json` is the contract. A request is `{"v": 1, "id", "method", "params"}`, an answer
`{"id", "ok": true, "result"}` or `{"id", "ok": false, "error": {"code", "message"}}`, an event `{"event", "data"}`.
Each shell checks every request against the contract before anything runs: a method that is not in it is
`unknown_method`, one whose feature this phone lacks `unavailable`, and a parameter that is missing, not listed, of
another type, out of its range or not of its pattern, `bad_request`. Only the main frame of the bundle's origin is heard
(iPhone: the frame's security origin; Android: the web message listener is offered to that origin alone). A page finds
out what it may use from the hello (`app.hello`: the bridge's version, the app's version and build, the bundle's id
and console version and whether it came from the console or with the app, `needsNewerApp`, and the features), never
from the kind of phone. `window.cranium.bridge` is the same object, for feature detection anywhere in the page.

| Feature | Methods | What |
| --- | --- | --- |
| (always) | `app.hello`, `app.config`, `app.ready`, `app.reload` | The hello, the public configuration, the bundle is good, show the newest bundle |
| `auth` | `auth.store`, `auth.session`, `auth.signOut` | The sign-in, below |
| `biometric` | `biometric.status`, `biometric.set` | Face ID, Touch ID or a fingerprint for a pool's sign-in |
| `ble` | `ble.state`, `ble.scan`, `ble.connect`, `ble.images`, `ble.upload`, `ble.cancel`, `ble.status`, `ble.disconnect`, `ble.watch` | Bluetooth to a board, below |
| `clipboard` | `clipboard.write` | With `expiresIn`: this phone only, gone after that time (the passkey, 2 minutes) |
| `haptics` | `haptics.play` | success, warning, error, selection, impact |
| `share` | `file.share` | A file (base64, a name, CSV, JSON, text or PDF) through the share sheet: save to Files, AirDrop, mail. For exports to come |
| `storage` | `storage.get`, `storage.set`, `storage.remove` | What the page means to keep across launches (the customer site's journal and choices), on the phone only: keys `cranium.` plus up to 200 printable characters, values up to 3,000,000 characters, 64 keys and 12 MB in all; one file per key, named by its SHA-256, not backed up (iPhone: Application Support, excluded from backup and file-protected; Android: `noBackupFilesDir`). The iPhone's web view keeps no data of its own, so its `localStorage` lasts only until the app closes |
| `open` | `app.open` | An `https:`, `sidestore:` or `otpauth:` address outside the app (on the iPhone, a `sidestore:` one only in the two forms of "Updating the iPhone app"); anything else `not_allowed` |
| `keepAwake` | `app.keepAwake` | The screen stays on during an update over Bluetooth |
| `settings` | `app.settings` | The shell's own settings: versions, Look for newer pages, Classic app (and Reload on the iPhone) |
| `appUpdate` (Android) | `update.check`, `update.install` | The APK's own updater, as before; its daily check and notification are unchanged |
| `usb` (Android, from 0.8.8) | `usb.open`, `usb.write`, `usb.close` | A board's USB serial port, for the Serial console and Board setup: [The serial pages](#the-serial-pages) |
| `camera` (phones with a camera, from 0.8.13) | `camera.scan` | Scan board: one QR code read with the camera, and the board's thing name if it is a board of this console: [Scan board](#scan-board) |

Events: `app.lifecycle`, `app.bundleReady`, `auth.locked`, `ble.boards`, `ble.link`, `ble.progress`, `ble.status`,
`usb.data`, `usb.closed`.

**Signing in, in the app.** The page signs in itself, with the console's own sign-in code (SRP, the code in six
boxes), with the phone apps' clients: `mobileClientId` for an admin, the customer pool's phone client for a customer.
So the API knows the session as a phone's, as before: `from: phone` in the activity log, and a change needs the
password and code of the last 15 minutes (`403 phone_sign_in_again`, after which the page asks for them in place).
When Cognito hands over the tokens, the page gives the refresh token to the app (`auth.store`) at once, instead of
revoking it as the website does, and keeps only the access token, in memory. The app keeps the refresh token exactly as
the classic app does: the same Keychain items and Keystore keys, behind Face ID or a fingerprint when that is on (the
app offers it after a sign-in), forgotten an hour after the sign-in when it is not. A page that loads, `/` or `/admin`,
asks the app for an access token (`auth.session`); the app refreshes it with Cognito when it has less than 2 minutes
left, behind the biometric where that is on. After 5 minutes in the background with the biometric on, the app locks
the sign-in again (`auth.locked`) and the page asks again. Signing out makes the app revoke and forget it. Because the
stores are the classic app's, the shell and the classic app share one sign-in per pool. A step the page's sign-in does
not do (a new password for an admin, an authenticator app to set up) opens the console's website in the browser.

**Bluetooth, in the app.** The console has a page for it, Bluetooth in its masthead, shown only to a release manager in
an app whose bridge offers `ble` (`assets/bluetooth.js`). It follows [What a person does](#what-a-person-does) step by
step and the classic apps' rules: only active releases newer than the board's slot 0; the passkey asked of the console
from the moment the phone connects, every 3 s for 90 s, pinned at the top of the page and on the clipboard for 2
minutes; the image checked (size, SHA-256, MCUboot's magic, the header's version and sizes) and checked again by the
app before the upload; `POST /api/firmware/{version}/bluetooth` right before every send, and nothing sent without its
yes; MCUmgr's upload only; then the board followed with the same `UpdateWatch`, ported to `assets/updatewatch.js` with
the same words and test cases, from its status characteristic on the link and after its restart (`ble.watch`), the
link, and the console. The page keeps no copy of an image ([Cache](#cache)): it downloads it for each send. Once the
board has reported, the send is in the console's update history (`GET /api/updates`), on the Overview and the board's
page, "over Bluetooth from" whose phone it was, as on the website: the pages are the website's.

### Security

- **No page from the network.** The web view shows the bundle's origin and nothing else. Every file of it is answered
  from the bundle on the phone; on Android a main-frame load of any other origin is stopped too. A link, a form, a
  script or a new window that would go anywhere else is cancelled, and an `https:`, `sidestore:` or `otpauth:` address
  is handed to the system instead (Safari or the browser, SideStore, an authenticator app). No frame of another origin
  loads. The iPhone's web view keeps no website data between runs; neither app's web view can be inspected in a release
  build, reads files, or allows mixed content.
- **A policy on every page.** The app sends each page the policy of its route (`apps/shared/bridge.json`, `policies`),
  built from its own configuration: scripts and styles from the bundle only; network to the console's API, the customer
  API, Cognito's user pool API and, from 0.8.1, the live API's WebSocket ([live.md](live.md#the-phone-apps)) only;
  images from the bundle, `data:` and, on the console, OpenStreetMap's tiles;
  no form, no frame, no plugin, no base; and on the customer site, Trusted Types, as on the website.
- **What a page gets from the app.** An access token, which the page on the website holds anyway; never a refresh
  token after the sign-in that made it. Bluetooth that can only upload, never test, confirm or reset, and only after
  the console's yes; the board still takes only images signed with the project's key. Addresses opened only by the rule
  above. Errors in a few words, never what went wrong inside.
- **The manifest is not signed.** It comes over HTTPS from the console's address built into the app, each file is
  checked against its SHA-256, and the id against everything the manifest says. Whoever could change what the web
  function serves could already change the console's pages in every team member's browser, with the same tokens; the
  bridge adds no secret to that and no power over a board that the board does not check itself. Signing the manifest,
  with a key kept off the deploying machine and its public half built into the apps, would make the apps trust less than
  the browsers do; it is not done in 0.8.0.
- **CORS, from any origin, without credentials.** In the app the pages call the API from `cranium-app://bundle`
  (iPhone) and `https://appassets.androidplatform.net` (Android). API Gateway refuses an origin that is not http(s) in
  its CORS configuration, so since console 2.2.0 it allows any origin (`*`), with `authorization`, `content-type` and
  `accept`, `GET`, `POST` and `PUT`, `date` exposed for the console's clock, no credentials, and a preflight cached for
  10 minutes. The preflight is answered by the web function, with a 204 and no body, for any path under `/api/`: the
  `$default` route brings it there instead of API Gateway answering it, and API Gateway adds its CORS headers to that
  answer (console 2.4.1; before, the web function answered 405, and every call of the apps' pages failed with "The
  console could not reach its server"). Nothing changes for a browser, whose pages are on the API's own origins. This
  is not a lock: every call carries its token in a header, never a cookie, so an origin gains nothing without a token
  of its own.

### The classic app

The 0.7 screens stay for this version, as **Classic app**: a switch in the app's settings (from the page's App button,
in the console's account box and on the customer site's Account page), a Home Screen quick action on the iPhone and a
launcher shortcut on Android; the way back is the line at the top of the classic app on the iPhone, and Use the new
app under More on Android. The app also starts in the
classic app by itself, with a line that says why, when no bundle can be shown (on Android also when the phone's WebView
is too old for the bridge). New apps start in the shell. The classic screens can be deleted in the version after the
shell has been used on the team's phones for a release: from then on the shell's fallback is its built-in bundle alone.

### Pages in every app

Every console page is in the iPhone, Android and desktop apps, which show the console's own pages.
[`apps/shared/pages.json`](../apps/shared/pages.json) lists them: each page with its section link, its script, and the
API routes it reads. It also lists the board cards a page script draws, such as **In Memfault** on a board's page, and
the addresses that open outside the app, such as a board's page in Memfault. Three tests read it next to the console's
own sources: `PagesParityTests` (iPhone), `PagesParityTest` (Android) and `pages.test.mjs` (desktop). Each test fails
when:

- a section in core.js is not in pages.json, or a page in pages.json is not in core.js;
- a page's link is not among the sections of views.js;
- a page's script is not in `site/assets/` (so not in the bundle) or app.js does not load it;
- a card's script does not draw the card, or views.js does not call it;
- an API route is not in `cloud/api/src/app.mjs` with its defaults. The defaults let the apps' sign-in in, as the
  website's is;
- the app's own rules do not keep the page in its web view, let it reach the console, or send the outside addresses
  to the system.

So when the console gets a new page, CI fails until pages.json lists it and every app passes these checks. The
Memfault page (`#/memfault`, an issue at `#/memfault/<id>`) and the In Memfault card came with console 2.6.0. They are
listed from apps 0.8.6 and desktop 0.1.3; the Memfault metrics card (console 2.11.0) from apps 0.8.9 and desktop
0.1.5. On a phone they are under the console's sections, as on a narrow browser. The serial pages are the one exclusion: [below](#the-serial-pages).

A page an app cannot have is marked in pages.json with `excluded`, the app (`ios`, `android`) and the reason. The
app's test then checks the opposite: that its shell refuses the page's address and that the web UI leaves the page
out in that app. Every other page must still be there, and the desktop app has every page.

### The serial pages

The Serial console (`#/serial`) and Board setup (`#/setup`) need a board's USB serial port.

- **iPhone (from 0.8.8): not in the app.** iOS gives an app no way to open a USB serial device, and WebKit has no Web
  Serial. Inside the iPhone app, views.js `serialPagesHidden` leaves both out of Developer, and app.js treats their
  addresses as no page. The shell's `ShellPolicy.navigation` also drops them (`excludedSections`). The classic
  screens' Serial console and Board setup explanations are gone too. pages.json excludes both on `ios`.
- **Android (from 0.8.8): both work, over USB OTG.** The app offers `usb` in its hello, and app.js makes it the
  page's `navigator.serial` (bridge.js `createBridgeSerial`), so serial.js, setup.js and recovery.js run as they
  are. `usb.open` opens the first SEGGER J-Link on the cable through usb-serial-for-android (the console's port,
  VCOM1, first, then VCOM0, which Board setup's seal watch asks for second), after Android's permission prompt.
  `usb.write` takes base64 of at most 12 KiB, and the page splits larger writes. What the board sends comes as
  `usb.data` as it arrives, with no pacing. A port that fails or comes off the cable sends `usb.closed`.
  This is enough for the whole flow:
  - console lines of up to 384 bytes;
  - `ENTER_BOOTLOADER` and the bootloader's half-second window, which needs one round trip of a few milliseconds
    on the bridge;
  - MCUboot's serial recovery, base64 lines of 128 bytes in requests of 1 KiB, and an image of about 900 KB,
    which at 115200 baud takes as long as on a computer.
  The classic screens' USB console (one command at a time) is unchanged. An Android app before 0.8.8 has no
  `usb`, so its pages leave both out, as on the iPhone. Tests: `ShellUsbTest` (a fake J-Link: ports,
  permission, a 384-byte line, the bootloader's answer, a 900 KB image, unplugging) and bridge.test.mjs
  (`createBridgeSerial` with recovery.js). None of this has run on a phone with a board yet.

### Scan board

Each board's label has a QR code that links to its page on the console, `https://<console>/#/devices/<thing>`
([docs/new-board-setup.md](new-board-setup.md#the-boards-label)). In the iPhone and Android apps (0.8.13 and later),
the Devices page has **Scan board**:

- **The camera only when it is tapped.** The app offers `camera` in its hello when the phone has a camera, and asks for
  it (the system's prompt, with the words in the iPhone's `NSCameraUsageDescription`; Android's `CAMERA` permission at
  run time) the first time the person taps Scan board, never before. The camera runs full screen until it reads one
  code or the person taps Cancel, and stops then.
- **The platform's reader, no service.** The iPhone uses AVFoundation's own QR reader (`App/Shell/BoardScanner.swift`).
  Android has no QR reader of its own, so the app uses CameraX for the picture and ZXing's core library (Apache 2.0,
  plain Java, on the phone) for the code (`shell/BoardScanner.kt`, `core/QrFrames.kt`). Nothing is sent anywhere.
- **Only this console's boards.** Before the page hears anything, the app checks the code (`BoardLink` in CraniumKit
  and in `core/BoardLink.kt`, with the same cases as labels.js `readBoardLink` on the website): the same scheme, host
  and port as the app's `consoleUrl`, no user, the root path, no query, and `#/devices/<thing>` with a thing name of
  `A-Z a-z 0-9 _ : -`, 128 at most. Anything else is refused with `not_allowed` and nothing opens; the page says
  "That code is not a board of this console, so the app did not open it." Cancel says nothing; a camera the person
  did not allow is `unavailable`, and the page says to allow it in Settings. The page then opens `#/devices/<thing>`
  itself, after checking the thing name again.
- **Not in the desktop app.** A computer doesn't scan its boards' labels: the desktop app doesn't offer `camera`
  (`src/lib/features.mjs`, `NOT_OFFERED`), so the Devices page has no Scan board there, as on the website. It prints
  labels like the website. No page is left out, so `apps/shared/pages.json` is unchanged.

Tests: `BoardLinkTests` (iPhone) and `BoardLinkTest`, `QrFramesTest` (Android: a drawn frame with a label's code, read
back and checked) for the link checks; app.test.mjs for the button, the page that opens and the refusal. Scanning a
real label with a phone's camera hasn't been tried yet.

### What only a phone can show

The unit tests check the contract, the bundle, the store, the policies and the pages' logic on both sides, and the
pages run in a stand-in for a browser with a stand-in for each app. What none of them can show: that WebKit treats
`cranium-app://bundle` as a secure context (the sign-in needs `crypto.subtle`), loads ES modules through the scheme
handler and honours its policy header; that Android's WebView honours the policy header and Trusted Types; that API
Gateway adds its CORS headers to its own 401s and to the web function's answer to a preflight; the pairing prompt during
`ble.connect` on each phone; the upload and the status after the restart; Face ID and the fingerprint through the
bridge; the share sheet, the file chooser and the quick actions; Scan board with a real camera and label.

## What a person does

1. Sign in, with the console's own account. Only a release manager can download firmware.
2. Pick a release. The newest active one is chosen by default.
3. At the board, hold **Button 1** for 5 s and let go. LED1 flashes four times: Bluetooth is open
   for 3 minutes (2 before firmware 1.11.2).
4. In the app, pick the board, `Cranium-` and four hex digits.
5. Enter the 6-digit passkey in the phone's pairing prompt. The app shows it, fetched from the
   cloud, when the board is online, with the board the console gave it for ("Board in the console:
   cranium-…"), so that a mix-up between two boards shows. From app 0.6.2 it is also on the clipboard
   as soon as it arrives, for 2 minutes (on the iPhone for this phone only; on Android marked sensitive),
   and the top of the screen says so: in the pairing box, tap the field, **Paste**, **Pair**. Otherwise it
   is on the board's serial console, `[BT] passkey`.
6. The app sends the image: the one on the phone if it has it (see [Cache](#cache)), else one it
   downloads from AWS first. Right before it sends, whatever the image came from, it asks the console
   whether the release is still active and the image is still its own
   (`POST /api/firmware/{version}/bluetooth`). It sends nothing without a yes: not after a refusal, and
   not when the console cannot be reached, which it says. It takes a few minutes.
7. At the board, press **Button 1** within 2 minutes to install it. **Button 2** throws it away.
   The app counts the board's 2 minutes down, from the end of the upload.
8. The board restarts and runs the new image on trial. It keeps it once it reaches AWS IoT.
9. The app shows each step as it happens, with its time, until the image is kept or undone
   ([Following the board after a send](#following-the-board-after-a-send)). From firmware 1.14.0 and app
   0.7.2 each step is the board's own word, from its [status characteristic](#the-status-characteristic)
   over Bluetooth, and the console's when the board is online:
   1. **Sent** the version: press Button 1 within 2 minutes (Button 2 throws it away), and the board's own
      countdown.
   2. **Button 1 pressed, accepted**: the board says so over Bluetooth before it restarts; with older
      firmware, from the board's disconnect from AWS IoT at the press, or else, said carefully, from the
      board closing the Bluetooth link ("The board closed the link: it is installing"). Button 2, the 2
      minutes running out, or the board refusing the image, with its reason, is said so, and the steps stop
      there.
   3. **Installing and restarting**: the board is restarting into the bootloader, or offline on the console.
   4. **Running** the version **on trial**: back with it, not yet kept. After the restart the app finds the
      board over Bluetooth again with no pairing, for the 2 minutes the board allows.
   5. **Kept** the version, or **Rolled back to** the old one, with the board's reason.

   Closed and opened again within 5 minutes, the flow shows the same steps. The board's page in the app
   says how its last update over Bluetooth went: "1.13.0+0 over Bluetooth at 12:14, kept". A board
   that is not on the console, one with no Wi-Fi for one, is followed over Bluetooth alone to the end,
   from firmware 1.14.0. With older firmware it gets one line instead: the app can't follow it from
   there; after it restarts, check its version over Bluetooth.

## Configuration

The apps need eleven values from the deployed stack. They are not in git: the repository is public,
and they name the AWS account. `apps/configure.sh` writes them from `cloud/.deploy/outputs.json`
into `apps/config/cranium.json`, which git ignores, and each app reads that file at build time.

```json
{
  "consoleUrl": "https://console.example.com",
  "customerApiUrl": "https://example.com",
  "customerClientId": "yyyyyyyyyyyyyyyyyyyyyyyyyy",
  "customerRegion": "us-east-1",
  "customerUserPoolId": "us-east-1_yyyyyyyyy",
  "liveUrl": "wss://zzzzzzzzzz.execute-api.us-east-1.amazonaws.com/live",
  "loginDomain": "https://login.example.com",
  "mobileClientId": "xxxxxxxxxxxxxxxxxxxxxxxxxx",
  "redirectUri": "cranium://signin",
  "region": "us-east-1",
  "userPoolId": "us-east-1_xxxxxxxxx"
}
```

The four `customer…` keys are the customer side's ([Customers](#customers)): the customer pool
(`CustomerUserPoolId`), the phone apps' client of it (`CustomerMobileClientId`, console 2.0.1), its Region,
and where the customer API is, which is the console's API under `/api/c/`: on the customer site's name
(`CustomerUrl`) once it has one, else on the console's. They come all four or none: a stack from before
console 2.0.1 gets a file without them (`configure.sh` says so), and an app built from it signs in team
accounts only, on the same one screen. Some of them without the
others, or one that does not look right, stops the build, naming the key and never its value.

`liveUrl` is the live API's WebSocket ([live.md](live.md#the-phone-apps)), the stack's `LiveUrl` from console 2.4.0;
apps from 0.8.1 give it to their pages and allow its origin in their policy, so that a board's change shows at once.
A stack from before 2.4.0 gets a file without it (`configure.sh` says so), and an app built from it polls. One that is
not exactly `wss://<API id>.execute-api.<region>.amazonaws.com/<stage>`, in the user pool's Region, stops the build.
The release workflow takes the configuration from the `CRANIUM_CONFIG_JSON` secret, so the secret needs the new key
too: run `apps/configure.sh` after deploying 2.4.0 or later, then set the secret from the file again.

`apps/config/cranium.example.json` has this shape with made-up values, for building without a stack.

Without `cloud/.deploy/outputs.json`, a signed-in person gets the same file from the console: **Download the
configuration** on the Apps page (`GET /api/apps/config`, [The Apps page](#the-apps-page)) saves `cranium.json`
for `apps/config/`.

## Signing in

**One sign-in screen for everybody** (apps 0.8.3, as the customer site since console 2.4.5): the e-mail address and
the password, then the code when the account asks for one. There is no choice of admin or customer. The screen asks
the team's pool first (`userPoolId`, `mobileClientId`), with the address in lower case, and only if that pool says the
address or the password is wrong, the customer pool (`customerUserPoolId`, `customerClientId`), the same way: one try
at each pool per submission, so each pool's throttling and lockout count every try and keep their words, and one
refusal for both, "The e-mail address or password is wrong.", whichever pool refused. A team account then gives its
code and lands in admin mode; a customer gives their code if they turned two-step sign-in on, or a new password at the
first sign-in, and lands on the customer side. **Forgot your password?** asks both pools for a code, one request each
(the team's pool hides unknown addresses, so its yes proves nothing), sends the code and the new password to the
team's pool first and then to the customer pool, and says the same either way. The logic is CraniumKit's `OneSignIn`
on the iPhone and `core/OneSignIn.kt` on Android, with unit tests; the shell's sign-in is the customer site's page,
which has the same rule.

Each pool's sign-in is the console website's: the e-mail address and the password, then the code from the
authenticator app in six boxes. This is Cognito's user pool API with SRP (`USER_SRP_AUTH`), so the password stays on
the phone and is used for the proof only:

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

## Customers

The customer side of the apps is the customer website ([docs/customer-site.md](customer-site.md)) in the shell's web
view: the same sections, the same words, the same API and the same customer accounts, from the pages in the bundle
(the iPhone: `cranium-app://bundle`; Android: `https://appassets.androidplatform.net`). The native customer screens
of 0.6 to 0.8.1 are no longer the way in. How the site's features work in a shell:

| Feature | In the app |
| --- | --- |
| Tabs, safe areas | The site's phone layout and tab bar (Overview, Sessions, Transitions, Library, Devices); the web view keeps clear of the top, the site draws to the bottom as on a phone browser |
| Import session | The file picker: iPhone, the web view's own; Android, `ACTION_GET_CONTENT` with the MIME types the `accept` list names (`.csv`, `.json`, `.bin`), any file when a name is unknown |
| Export, Back up, CSV | `file.share` through the share sheet (Save to Files, AirDrop, mail). A backup over about 3 MB passes the bridge's 4 MiB request limit and is refused |
| Explore demo, My journal, saved moments, range | Kept by the app (`storage.*`), so they last across launches on both phones; what an older app left in the page's `localStorage` is moved over once. An app without `storage` says "This app cannot keep the journal" |
| Connect device | The site's dialog, with Bluetooth through the bridge where the phone has it |
| Links | `https:` addresses open in the system browser (`app.open`) |
| Sign-in, account | As below; the refresh token goes to the app, never into the page |
| Live updates | The site's live connection (`liveUrl` in `app.config`), as in a browser |
| Back (Android) | The back button goes back through the site's routes before it leaves the app |

Overview, Devices and a board are read again every 30 seconds while they are on screen, and on a pull. A
board is only ever named by the id of its assignment (16 hex digits), as the API gives it, never by a thing
name; an id of any other shape is not asked for, and another customer's board answers 404 (`not_your_board`):
"There is no board of yours here."

**Signing in.** A customer signs in on the app's one sign-in screen ([Signing in](#signing-in)), which reaches
the customer pool, with the phone apps' client of it (`CustomerMobileUserPoolClient`), once the team's pool has
refused the address or the password, through the user pool API exactly as an admin does: `USER_SRP_AUTH`, `PASSWORD_VERIFIER`, and `SOFTWARE_TOKEN_MFA` in six boxes if the
customer turned two-step sign-in on. At the first sign-in Cognito asks for a new password
(`NEW_PASSWORD_REQUIRED`), which the screen asks for and sends (`RespondToAuthChallenge` with `NEW_PASSWORD`),
as the website's does; any other step says "Your account needs a new password first" and leads to **Forgot your
password?**: `ForgotPassword`, then `ConfirmForgotPassword` with the code Cognito e-mails and a new password of at
least 10 characters. The customer pool has no managed login pages, so there is no AWS sign-in page here: the
customer's tokens are refreshed with `InitiateAuth` `REFRESH_TOKEN_AUTH` and revoked at sign-out with
`RevokeToken`. The account's own calls (`GetUser`, `ChangePassword`, `AssociateSoftwareToken`,
`VerifySoftwareToken`, `SetUserMFAPreference`) carry the customer's access token, whose
`aws.cognito.signin.user.admin` scope they need, as the customer API's route does.

| | Customer | Admin |
| --- | --- | --- |
| Pool and client | `CustomerUserPool`, `CustomerMobileUserPoolClient` | `UserPool`, `MobileUserPoolClient` |
| Sign-in screen | The one screen, with "Forgot your password?" | The same screen (the team's pool is asked first); a step only the AWS sign-in page does goes there |
| Code | Only if the customer turned it on | Always |
| API | `GET {customerApiUrl}/api/c/...` only | `{consoleUrl}/api/...`, as before |
| Kept on iPhone | Keychain items of the service `com.craniumiot.cranium.customer`; Face ID's item under the same service, its setting `cranium.customer.biometric.settings` | `com.craniumiot.cranium.console`, `cranium.biometric.settings`, as before |
| Kept on Android | `cranium_customer_tokens` with the master key `cranium_customer_master_key`; the fingerprint key `cranium_customer_refresh_token_fingerprint_v1` | `cranium_tokens`, the default master key, `cranium_refresh_token_fingerprint_v1`, as before |

So the two sessions never share a key, as on the website: a customer's token is never sent to the console's
API, nor an admin's to the customer API (and each would be refused: the gateway's authorizers name each
other's pool and clients only), and signing one out leaves the other as it was. An app updated from 0.5 keeps
its admin's sign-in, under the names it had.

**Face ID and the fingerprint** work for whichever account is kept, by the rules above
([Unlocking](#unlocking-with-face-id-iphone-or-a-fingerprint-android)): without them the refresh token is
forgotten an hour after the sign-in; with them, up to 30 days, the customer phone client's refresh token
lifetime. Each side has its own lock, asked when that side is on screen. Offered once after a full sign-in, in
the customer's words ("instead of your password": a customer may have no code).

**Admin mode.** The team signs in on the same one screen (staff pool, phone client, password and code), and
the app opens admin mode: the whole app as it was. **Leave admin mode** (under More on the iPhone,
under More and Account on Android) goes back to the customer side, the admin still signed in. There, an admin
who is not also signed in as a customer sees the website's Overview as a customer sees it, with its mixes, and **Open admin mode** where a customer's boards would be, Mixes and Help; a customer side with an admin
signed in as well has **Admin mode** in its top bar and on Account. The app opens on the customer side when a
customer is signed in, else in admin mode when an admin is, else on the one sign-in. Sign out on the
customer side signs out both, as the website's does; Sign out in admin mode signs the admin out only.

**What a phone cannot do that the site can:** nothing, for a customer. From console 2.24.0 a release manager sees
the Team and Customers pages in every app (iPhone, Android, desktop, Mac); every change to them (inviting, a tier,
disabling, a reset, removing, giving or taking back a board) is still made on the console's website only, and the
apps show "Change on the website" in its place. Those write routes refuse an app's session (`phone_not_allowed`).

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
| `GET /api/updates` | Anyone signed in | From console 2.1.1: every update of every board, newest first, 25 a page (`?thing=`, `?limit=`, `?cursor=`): `{"updates": [{"id", "thing", "from", "to", "how": "deployment" or "bluetooth" or "usb_or_other", "deployment", "who": {"sub", "email", "name"}, "outcome": "kept" or "rolled_back" or "not_installed" or "pending", "startedAt", "endedAt", "status"}], "cursor"}` ([docs/aws-iot.md](aws-iot.md#update-history)). The Overview's Updates and a board's Updates read it, in the website's words: "over Bluetooth from Vihaan’s phone", "deployment <id>", "USB or another tool". An older console answers 404 `not_found`: the apps then go by the deployments, as before 0.7.3. `GET /api/devices/{thing}` has the board's newest as `lastUpdate` |

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

This is the classic apps' cache. The app shell's Bluetooth page (from 0.8.0) keeps no image: it downloads the image for
each send, checks it, and lets it go.

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
| Advertising data | The SMP service UUID `8D53DC1D-1DB7-4CD3-868B-8A527460AA84` in a window that takes an image; the status service UUID `9112B1B4-2A51-40F0-94D3-A76440F0E6CC` for 2 minutes after the restart that an update over Bluetooth asked for (from firmware 1.14.0) |
| SMP characteristic | `DA2E7828-FBCE-4E01-AE9E-261174997C48`: write without response, and notify |
| Status characteristic | `9112B1B5-2A51-40F0-94D3-A76440F0E6CC`, in the status service: read, and notify. **No pairing needed**: see [The status characteristic](#the-status-characteristic). From firmware 1.14.0 |
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
press Button 1 on the board within 2 minutes, keep the link, and follow the board (below).

### The status characteristic

From firmware 1.14.0 the board tells a phone how an update over Bluetooth stands, itself
(`firmware/app/src/bt/bt_status.h`): one characteristic, `9112B1B5-2A51-40F0-94D3-A76440F0E6CC`, read and notify,
in a service of its own, `9112B1B4-2A51-40F0-94D3-A76440F0E6CC`. A board of 1.13.x or older has neither, and the
apps follow it as 0.7.1 did.

**Who can read it.** Any phone that is connected, with no pairing and no encryption: the characteristic and its
notifications need none, because nothing in it is secret. Only versions, counts, seconds and states, all of which
the board's serial console says as well; never the passkey, a key, the board's name in the cloud or anything about
its network. The board is connectable only in a window that a person opened with Button 1, as before, and for 2
minutes after the restart that an update over Bluetooth asked for, into the new image on trial or back into the old
one. In those 2 minutes it advertises the status service (not SMP, so the apps' scan for boards to update leaves it
out), as `Cranium-` and four new hex digits, at a new private address. A link made then is for the status alone:
the board asks for no pairing, refuses one, and so SMP, which needs an authenticated link as before, stays shut.
Such a link stays while the image is on trial, 5 s more after the trial is over, and 6 minutes at most.

**When it changes.** Every change is notified at once to a phone that asked for notifications; what counts by
itself (the seconds left, the bytes received, the uptime) every 10 s, and the phone counts down in between. A
notification takes an ATT MTU of at least 67, which iPhones negotiate by themselves and the Android app asks for;
on a smaller one, read it (a long read). The board waits up to half a second for the last notification of a window
to go out before it closes the link or restarts.

**The payload.** 64 bytes, least significant byte first. A version is 8 bytes: major, minor, revision (2), build (4),
all zero for none. A phone that finds another number in byte 0 reads nothing else; a later firmware may add bytes
at the end, and new numbers in a field, which the apps take as unknown.

| Byte | Size | | Values |
| --- | --- | --- | --- |
| 0 | 1 | Format | 1 |
| 1 | 1 | Window | 0 closed, 1 open (advertising, or connected and not paired), 2 linked (paired), 3 an image waits for a button, 4 status only (after the restart) |
| 2 | 2 | Seconds left | of the window; of the offer while an image waits (the board's 2 minutes for Button 1); of the advertising after the restart |
| 4 | 1 | Image | 0 none, 1 receiving, 2 received (all of it, not looked at yet), 3 verified (offered), 4 refused |
| 5 | 1 | Refusal | 0 none, 1 older (not newer than what runs), 2 not image 0, 3 no image header, 4 too large, 5 bad sizes, 6 incompatible_board, 7 incompatible_layout, 8 malformed metadata, 9 swap pending, 10 cannot install (the record or the swap request could not be written) |
| 6 | 4 | Image bytes | so far while receiving, then the image's size |
| 10 | 8 | Image version | from its header, once the first piece is in |
| 18 | 1 | Result | 0 none, 1 installing (Button 1: the board restarts), 2 discarded (Button 2), 3 timed out (no button in the offer's 2 minutes, or the window's time ran out), 4 closed for another reason |
| 19 | 1 | Closed reason | the firmware's `enum bt_ota_closed` + 1, 0 while open: 1 time up, 2 pairing failed, 3 session limit, 4 no image to install, 5 Button 2, 6 trial over, 7 no controller |
| 20 | 8 | Running version | |
| 28 | 1 | Flags | bit 0: on trial; bits 1 to 3: the swap the bootloader has to do (0 none, 1 test, 2 permanent, 3 revert, 4 fail) |
| 29 | 1 | Last update: how | 0 none, 1 Bluetooth, 2 Wi-Fi (a cloud job this boot knows of) |
| 30 | 1 | Last update: outcome | 0 none, 1 pending, 2 kept, 3 rolled_back, 4 not_installed, 5 trial_lost, 6 superseded, 7 flash_error, 8 incompatible_board, 9 incompatible_layout, 10 failed |
| 31 | 1 | Last update: proof | 0 none, 1 cloud, 2 person |
| 32 | 8 | Last update: version | what it installed, or tried to |
| 40 | 8 | Last update: from | over Bluetooth only |
| 48 | 8 | Last update: hash | the first 8 bytes of the image's own SHA-256 (its `IMAGE_TLV_SHA256`, not the file's), over Bluetooth only |
| 56 | 2 | Last update: count | updates over Bluetooth on this board, this one included |
| 58 | 4 | Uptime | seconds |
| 62 | 2 | Reserved | 0 |

The signature is the bootloader's to check, at the restart: an image it does not take shows up after the restart as
the last update's outcome, `not_installed`, not as a refusal. `firmware/tests/host/test_bt_status.c` checks the
payload byte by byte; `build/bt_status_tests --print` gives its sample, which `BoardStatusTests.swift` and
`BoardStatusTest.kt` parse.

### Following the board after a send

What the board tells, and how (`firmware/app/src/bt/bt_ota.c`), each line of its console in its board log
(`GET /api/events/log`, tag `BT`) with the board's own time, and from firmware 1.14.0 its status:

| At the board | Status (1.14.0 on) | On the link | In the board log | On the console |
| --- | --- | --- | --- | --- |
| The image has arrived | Window 3, image verified, the offer's seconds | Stays up | `firmware 1.13.0+0 has arrived, …: press Button 1 to install it, Button 2 to erase it` | |
| Button 1 | Result installing, notified before the restart | Drops within about 2 s: the board restarts | `restarting into the bootloader: …`, which from 1.14.0 reaches the console first: the board sends what waits, then a report with `ota.state` `rebooting`, and restarts once AWS IoT has acknowledged it, 2 s at most. Before, it was lost with the restart | `ota.state` `rebooting`, then a `connection` event `disconnected` at the press, and `connected` when it is back |
| After the restart | Window 4 for 2 minutes, read with no pairing: running version, on trial, last update pending, then kept or rolled_back, with its proof | | `on trial: 1.13.0+0 from 1.12.0+0, pending, …`, then `update over Bluetooth: 1.13.0+0 from 1.12.0+0, succeeded, proof cloud, …` or another result: `rolled_back`, `not_installed`, `trial_lost`, `flash_error` | `fw` `{version, confirmed}` in `GET /api/devices/{thing}`, and the shadow's `bt` record |
| Button 2 | Result discarded, notified before the link goes | Dropped by the board at once | `closed: by Button 2` | The board stays online |
| No button for 2 minutes | Result timed out | Dropped by the board | `closed: no image to install` | The board stays online |
| An image it refuses | Image refused, with the reason; result closed | Dropped by the board | `refused the image: …` | The board stays online |

So the apps keep the link after the upload and read the image list every 3 s (the board allows it
while it waits for a button, and drops no link in that time), and from firmware 1.14.0 they read the status
characteristic and ask for its notifications on the same link, all through the flow. Once the link goes, they ask
the console every 3 s, two calls each time: the board log since the send (`?thing=…&tags=BT,bt_ota&from=…`, from
30 s before the send), and in turn the board's connections (`GET /api/events?kinds=connection`) and its report
(`GET /api/devices/{thing}`). A 429 doubles the wait, up to 30 s. They stop at the first end: kept, rolled back,
Button 2, the 2 minutes run out, or a refusal.

From firmware 1.14.0 they also look for the board over Bluetooth, at the same time: they scan for the status
service, connect to each board that advertises it, with no pairing, and read its status once. Only the board whose
last update over Bluetooth is the version sent, and the image sent (its hash), is followed: its status is read, and
each change notified, until its link goes; then they look again, for a board whose trial fails restarts once more
and advertises its status from the old image. They follow for 5 minutes after the link of the send went, and
10 minutes after the board last said it runs the new image on trial. A board with no Wi-Fi, which the console
cannot follow, is followed this way to the end. With older firmware (no status characteristic) the apps do what
0.7.1 did.

- **The board's word first.** A status that says installing, discarded, timed out or refused is Button 1,
  Button 2, the time or the refusal, at the moment the phone got it; after the restart, a status about this
  send that says on trial, kept or rolled back is that. The countdown is the board's: the seconds left of its
  offer, from the moment they were read.
- **Button 1**, without the board's word, is taken as accepted once the board left AWS IoT after the link
  dropped, or ran the new version since; before that, a drop more than 3 s before the end of the 2 minutes says,
  carefully, "The board closed the link: it is installing". A drop at the end of the 2 minutes is taken for the
  time running out, until the console says otherwise.
- **Kept**: the board's status, its `update over Bluetooth … succeeded` line, or a report from a boot after the
  send (its `lastSeen` less its `uptime`) of the new version, confirmed. **Rolled back**: a status or a line with
  another result, or such a report of another version.
- A board the console does not know (no passkey came from it) or had offline right after the send is
  followed over Bluetooth alone, from firmware 1.14.0; with older firmware it is not followed, and one line says
  so.

The steps are one pure function in each app, `UpdateWatch` (`CraniumKit/UpdateWatch.swift`,
`core/UpdateWatch.kt`), with the same words and the same test cases on both sides, and so is the status's
parser (`CraniumKit/BoardStatus.swift`, `core/BoardStatus.kt`). From 0.8.0 the pages have them too, for the app
shell's Bluetooth page: `cloud/web/src/site/assets/updatewatch.js`, with the same cases in
`cloud/web/test/updatewatch.test.mjs`.

## Offline mode

From firmware 1.19.0 and app 0.9.0. When a board has no Wi-Fi or no cloud, the phone talks to it directly over
Bluetooth: **More, Offline**. It needs no internet and no sign-in beyond the one the app already holds.

**At the board.** Run `BT_OFFLINE|NEW` once on its serial console (Board setup's command line). The board draws a
6-digit passkey and a name (`Cranium-3F9C`) with its own random source, keeps them in protected storage and shows the
passkey **once**, in that reply: write it down. It is never logged, never sent to the cloud and never shown again; running
the command again makes a new one. A board that has not run it still draws a new passkey for each attempt and shows it
on the console, as before. Then, whenever the phone should talk to it, hold Button 1 for 5 s: LED1 flashes four times and
Bluetooth is open for 3 minutes. The passkey is the board's own (`src/bt/bt_passkey.h` explains what that costs and the
three-failure lock).

**In the app.** Pick the board (the name above). The phone asks for the passkey; type it. The screen then shows the
firmware version, how long the board has been up, why it last restarted, Wi-Fi and cloud state, and the update state, and
refreshes every 3 seconds. When an update that a phone sent (Update over Bluetooth, or any MCUmgr client) has arrived and
waits, **Accept the update** asks to confirm the version and then installs it, as a press of the install button would.

**The service** (`firmware/app/src/policy/bt_offline_policy.h`): `9112B1B6-2A51-40F0-94D3-A76440F0E6CC` with two
characteristics, both needing an encrypted, authenticated link (LE Secure Connections with the passkey; a link that has
not paired is refused by the board's Bluetooth host and the phone's system pairs first).

| Characteristic | UUID ends | Access | Content |
|---|---|---|---|
| status | `...B7` | read | 20 bytes, format 1 |
| control | `...B8` | write | `[0x01, major, minor]`: accept the waiting update |

The status: byte 0 format (1); 1 Wi-Fi (0 none, 1 down, 2 up); 2 cloud (same); 3 update (0 none, 1 cloud offer, 2 cloud
busy, 3 on trial, 4 Bluetooth update waiting, 5 arriving); 4 why the board last restarted (`enum reset_kind`, 255 not
known); 6 to 13 the running version (major, minor, revision (2), build (4)); 14 to 17 uptime in seconds; 18 and 19 the
major and minor of the waiting update, 0 unless byte 3 is 4. The write carries the version the person saw: the board
refuses it (ATT "unlikely error") if nothing waits or another version does by now. Both apps' tests parse the payload
that `build/bt_offline_tests --print` makes.

**What is and is not new in the security model.** Nothing is bonded: the board keeps no bonds (`bt_ota.conf`), so a phone
pairs again each time a person opens a window with Button 1, and a window still needs a person at the board. What is new
is that an authenticated phone, not only a press of the install button, can start the install of an image that has
already arrived, been checked for board, layout and version, and is signed by the project's key (the bootloader checks
the signature at the restart). The image still runs on trial and reverts unless it is proved. Only an update waiting in
the window can be accepted; a cloud update that waits for a button is shown but not accepted from the phone.

**Not covered.** An iPhone and an Android phone have not been run against a board; the board has not been flashed with this
firmware. See the pull request for what was and was not tested.

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
`apps/android/publish.sh` (`--no-publish` skips it), which takes an API token as `scripts/firmware/upload-to-console.sh` does
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
| The configuration | `GET /api/apps/config`, any member: `apps/config/cranium.json` as above, with the four customer keys once the stack has the phone apps' client of the customer pool |

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

Whether SideStore works on iOS 26.4 and later is not certain: recent iOS releases have broken its refresh before, so
check [sidestore.io](https://sidestore.io) for your iOS version first. A free Apple ID can have three apps signed at a
time, SideStore itself among them, and ten new app IDs a week. The app
is signed with the person's team, so it keeps its own sign-in and settings from one update to the next, but not across
a change of Apple ID. Nothing in the app uses App Groups, iCloud or push notifications, which a free team cannot sign.

### Updating the iPhone app

From 0.8.12 the app finds its own update. When the pages start and whenever the app comes back (at most every 10
minutes), it asks the console's `GET /api/apps` with the console sign-in that is already open; it never asks for Face
ID for this, and a customer's sign-in has no Apps page, so a customer sees nothing. If the newest published iPhone
version is higher than the app's own (`CFBundleShortVersionString`, then the build, `CFBundleVersion`), a banner above
the page says **Cranium <new> is ready (this iPhone has <old>)**, and **Update** opens a sheet with two ways, always
both, SideStore first:

1. **Install with SideStore** (needs SideStore on the iPhone; no Mac, no cable). One tap asks the console for a fresh
   download link (`GET /api/apps/ios/<version>/download?via=app`, a presigned S3 link good for 15 minutes, on record as
   `app.ios_download` with `via: app`), checks that it is the version, size and SHA-256 that was offered, and opens
   `sidestore://install?url=<link>`. SideStore downloads the IPA, signs it with the person's Apple ID and installs it
   over the app, which keeps its sign-in and settings; the app closes when SideStore replaces it. This is the form
   SideStore's own URL handler takes for an IPA at an address (its hosts are `install` and `source`, each with a `url`
   query item); `install` is used rather than `source` because it needs no source link of the person's own and goes
   straight to that version. If nothing opens the link, SideStore is not on the iPhone: the sheet says so in plain
   words, says it needs a computer once to install it, and links to the console's Apps page, whose iPhone card has
   SideStore's guide and the person's own source link (above).
2. **Install from the Mac** (no SideStore needed). Connect the iPhone to the Mac that installed the app, with its cable
   or on the same Wi-Fi and unlocked, and run `apps/ios/scripts/renew.sh` in the repository: it builds the newest app
   from `main` and installs it, keeping what the app stored ([`apps/ios/README.md`](../apps/ios/README.md)). Or open
   the console's Apps page on the Mac and follow its iPhone steps.

What the app may hand to SideStore is fixed in `ShellPolicy` (CraniumKit), for the page's `app.open` and its links as
well as for the update: exactly `sidestore://source?url=<this console>/api/sidestore/crs_<key>/source.json` and
`sidestore://install?url=<IPA>`, the IPA either the console's presigned S3 link
(`https://<bucket>.s3.<region>.amazonaws.com/apps/ios/cranium-ios-<version>.ipa?…X-Amz-Signature=…`) or an IPA through
a member's source on this console. One `url` item and nothing else: no path, port, user or fragment, no other query
item. SideStore's other links (`pairing` and `certificate`, which send a pairing file or a signing certificate to an
address) and any other address are refused. The console's token goes only to the console; SideStore gets the short-lived
presigned link and no token. The code is `apps/ios/CraniumKit/Sources/CraniumKit/Shell/AppUpdate.swift`, `ShellModel`
and `App/Shell/AppUpdateView.swift`; the tests are `AppUpdateTests` and `ShellPolicyTests`.

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
| A download | `GET /api/apps/ios/0.6.0/download`, any member; `?via=app` from the iPhone app itself, for its own update |
| The source link | `GET`, `POST /api/apps/sidestore` (a new one) and `POST /api/apps/sidestore/revoke`, a member's own, from the website only |

A version is published once and only upward, by its version and its build (`CURRENT_PROJECT_VERSION`,
`422 build_not_higher`).

## Building and shipping

See `apps/ios/README.md` and `apps/android/README.md`. The iPhone app reaches the team through SideStore (above), and
can still go to TestFlight with an App Store Connect API key kept in `~/.cranium`, never in git, for a paid team. The
Android app is a signed APK, published on the console's Apps page by `apps/android/build-release.sh` (above) for the
team to download. The newest published build of each app is also in git, in `apps/dist/` with `SHA256SUMS`, byte for
byte what the console serves (`apps/fetch-builds.sh`; [`apps/README.md`](../apps/README.md)). Those builds hold the
configuration above: the console's address and its public client and pool IDs, which the console's own website serves
to every visitor, and no password, key or token. Local builds stay out of git.
