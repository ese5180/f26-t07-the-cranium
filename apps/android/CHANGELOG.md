# Android app changes

One entry per version, newest first. The version is `craniumVersionName` in `apps/android/gradle.properties` (and
`craniumVersionCode` counts the versions); each is tagged `android-v<version>` on its commit. The two phone apps keep the
same numbers for the same features. The first paragraph of an entry is what the console's Apps page shows.

## 0.8.8

The Serial console and Board setup work in the app with the board on the phone's USB cable (USB OTG): the console's commands, and setting a board up from its bootloader, the golden image and the newest release to online, as in Chrome on a computer.

The bridge has `usb` (`usb.open`, `usb.write`, `usb.close`, events `usb.data` and `usb.closed`; `shell/ShellUsb.kt`
on `shell/AndroidUsbPorts.kt`, usb-serial-for-android), which the page uses as its Web Serial (bridge.js
`createBridgeSerial`). The J-Link's console port opens first, then the other one; Android asks for permission the
first time. `ShellUsbTest` runs it against a fake J-Link: both ports, a refusal, a 384-byte console line, the
bootloader's answer after `ENTER_BOOTLOADER`, a 900 KB image in the page's 12 KiB writes, and a port that comes off
the cable. The classic screens' Board setup now says where it is (`BoardSetupText`). Not yet run on a phone with a
board.

## 0.8.7

The console's Database page comes with the app, under Developer, for release managers: the console's tables, read only, with filters, each item's fields, and an export as CSV or JSON that goes to the share sheet.

The page is the console's own (2.10.0 and later); `shell/PagesParityTest` checks it through `apps/shared/pages.json`.
The activity log reads the new `db.export` entries, and the five new refusals of the Database page, in the website's
words (`core/Audit.kt`, checked by `WebsiteListsTest`).

## 0.8.6

The console's Memfault page comes with the app: the issue list, an issue's traces, backtraces and registers, and the In Memfault card on a board's page, with its reboots, events and issues. A test now fails if a console page is missing from the app.

The app shell shows the console's own pages, so the Memfault page comes with the console (2.6.0 and later) under the
console's sections. `shell/PagesParityTest` reads `apps/shared/pages.json` with the console's sources and checks each
page: its section, its script in the bundle, its API routes open to the phone apps' sign-in, and the shell's rules for
the web view (docs/mobile-apps.md, "Pages in every app").

## 0.8.5

Staged rollouts as on the console from 2.8.0: after the canary, the boards update in stages, all of a stage at once. The Roll out form takes the number of stages, the batch size, the wait between stages and the failure limit, filled in from the console's suggestion with its reasons, and a rollout's page shows each stage as it goes.

The app shell shows the console's own pages, so the form and the stage view come with the console. The activity log's
words (`core/Audit.kt`) have the console's three new refusals, `invalid_stages`, `invalid_batch` and
`invalid_soakMinutes`, and the details `stages` and `stage` of a rollout's entries.

## 0.8.4

More has Board setup, which says why it needs a computer: the app's pages have no Web Serial, and its USB console sends one command at a time, too slow for the bootloader's half-second window. The desktop app or Chrome or Edge on a computer does it; the Serial console here still talks to a board that is set up.

`BoardSetupScreen`, with the words of the console's setup.js (`core/BoardSetupText`, held to them by a test). The
activity log reads `setup.wifi_defaults` and the two new refusals of the console's Wi-Fi defaults.

## 0.8.3

One sign-in for everybody, as on the website since console 2.4.5: the e-mail address and the password, then the code when the account asks for one. A team account opens admin mode, a customer their own pages; "Admin sign-in" and "Customer sign-in" are gone.

The customer side's sign-in (`CustomerSignInScreen`) asks the team's pool first, through the console's own session
(`ConsoleViewModel.teamSignIn`), and only if it says the address or the password is wrong, the customer pool
(`core/OneSignIn.kt`): one try at each pool, and the same words whichever refused. A team account's code goes in the
same boxes, and admin mode opens; a step only the AWS sign-in page does takes the team account there. "Forgot your
password?" asks both pools, one request each. The admin overview's "Customer sign-in" button is gone, and admin mode's
own sign-in has "Leave admin mode" in its place. The shell's sign-in is the website's page, which has the same rule.

## 0.8.2

The customer site's features work in the app as on the website: Import session opens the file picker, the back button
goes back through the site's pages, and Explore demo, My journal, saved moments and the date range are kept by the app.

Import session (and the console's firmware upload) could not pick a file: the chooser asked for the first entry of the
page's `accept` list (".json", ".bin") as the MIME type, which is no type. The picker is now `ACTION_GET_CONTENT` with
the MIME types those names stand for, and any file when a name is unknown (`shell/ShellFiles.kt`). The back button left
the app instead of going back through the site's routes; it now follows the web view's history first. The bridge has a
new feature, `storage` (`storage.get`, `storage.set`, `storage.remove`; `apps/shared/bridge.json`), with a store in
`noBackupFilesDir` (`shell/PageStore.kt`: keys `cranium.…`, 3 MB a value, 64 keys, 12 MB in all, never backed up). The
site keeps the journal there, and moves over once what an older app left in the page's own storage.

## 0.8.1

Live updates in the app: a board that connects, restarts or takes an update shows it within about a second, as the
console and the customer site do in a browser since console 2.4.0, instead of on the next 30-second refresh.

The configuration has a new key, `liveUrl`, the live API's WebSocket (docs/live.md), which `apps/configure.sh` writes
from the stack's `LiveUrl` and the Apps page's **Download the configuration** hands out. The build checks it and puts it
into `BuildConfig.LIVE_URL`; the app gives it to its pages in `app.config`, and its origin,
`wss://<id>.execute-api.<region>.amazonaws.com`, goes into both pages' policy as `{live}` (apps/shared/bridge.json):
from the app's own configuration only, never from what the console says, and only when it is exactly the live API's
address in the user pool's Region; anything else stops the build, naming the key. A configuration without it, as
before, builds an app whose pages poll. Nothing else changed: the bridge is still version 1, so the console's bundle
works with 0.8.0 and 0.8.1 alike.

## 0.8.0

The app is now a thin shell around the website's own pages, kept on the phone and updated from the console by itself,
on any network: what changes on the website reaches the app with no new APK. Bluetooth, the fingerprint and the saved
sign-in stay the app's own, behind a bridge the pages ask. The screens of 0.7 stay for this version: Classic app, in
the app's settings or on its icon.

The pages are a bundle (`/app/manifest.json`, every file with its size and SHA-256): the app serves the last one that
checked out from its own storage at `https://appassets.androidplatform.net` (WebViewAssetLoader), never from the
network, and in the background fetches a newer one, at most four files at a time, checks each, swaps it in with one
rename and keeps the one before. A bundle that has not started after two tries is set aside for good, and the copy
built into the APK (`cloud/web/build-bundle.mjs`, so the build needs Node.js) is the last resort. Each page gets a
Content-Security-Policy from the app; the web view goes nowhere but the bundle, and every other address opens outside.

The bridge (`apps/shared/bridge.json`, version 1) is a WebMessageListener for the bundle's origin only, and every
request is checked against the contract before anything runs. The page signs in itself and hands the refresh token
over: the app keeps it in the same store, behind the same fingerprint and under the same hour's rule as the classic
app, so both share one sign-in, and gives the page access tokens only. Bluetooth runs on the classic app's MCUmgr
upload, status client and status scan. The APK's own update banner, daily check and notification are as before.

## 0.7.3

The Overview's last update and a board's update history now show every update, not only deployments: over Bluetooth
(with whose phone sent it) and by USB or another tool too, each with the version it came from and whether it was kept,
rolled back or not installed. A board updated over Bluetooth no longer shows an older deployment as its last update.
Against an older console the app shows what it showed before.

The app reads `GET /api/updates` (console 2.1.1): the newest entry for the Overview, and `?thing=` for a board, its first
page. A deployment's row opens the deployment; any other opens the board. A board's page also takes `lastUpdate` from
`GET /api/devices/{thing}`, and reads the list again when that names a newer update. An older console answers 404
`not_found`: then the app goes by the deployments and the board's `executions`, as before, and asks again only when
the page is opened or pulled down. The words are the website's and the iPhone app's.

## 0.7.2

From firmware 1.14.0 the app reads the board's own status over Bluetooth during the whole flow: Button 1 from the board,
its countdown, and why it refused an image. After the restart it reconnects with no pairing while the board advertises
for 2 minutes, and shows on trial, kept or rolled back from the board itself, so a board without Wi-Fi is followed to
the end. Older firmware is followed as before.

The status characteristic (service `9112B1B4-2A51-40F0-94D3-A76440F0E6CC`, characteristic `…B5-…`) is read and
subscribed to by a second GATT client next to MCUmgr's, after pairing; a board without it changes nothing. After the
link goes, the app scans for that service, connects with no bond, reads, and keeps only a board whose last update over
Bluetooth is the version sent with the same image hash (the SHA-256 in the image's TLVs), then follows its
notifications, and scans again after each restart. It follows for 5 minutes after the drop, and 10 minutes after the
board last said it runs the new image on trial. The console is followed alongside, as before. `UpdateWatch` takes the
board's readings first, with the same cases as the iPhone app.

## 0.7.1

After a Bluetooth send, the app follows the board step by step, each with its time: sent, with the board's 2 minutes
counting down; Button 1 pressed and accepted, or Button 2, or the time running out; installing and restarting; running
on trial; and kept, or rolled back with the board's reason. Closed and opened again within 5 minutes, the flow shows
it, and the board's page says how its last update went.

The app keeps the Bluetooth link after the upload and reads the image list every 3 s. Once the board closes it, the
app asks the console every 3 s, for at most 5 minutes, for the board's log, its connections and its report, two calls
at a time and slower after a 429, and stops at the first end. A board that is not on the console gets one line saying
the app can't follow it. The steps are one pure function, with the same words and test cases in both apps.

## 0.7.0

New versions reach every phone: the app checks the console on start and once a day, says "Update available" in the
app and as a notification, and installs it after checking its size and SHA-256. Android asks once to allow installs
from the app.

The banner sits above every page of the console; tap it to download and install, or Later to hide it until the app
starts again. The APK is checked against the console's list and its download answer, and Android must read it as this
app with the promised version and signing key; a file that fails is deleted. On Android 13 and later the app asks once
whether it may send notifications. The daily check uses only a sign-in kept without fingerprint unlock, while its token
is still good, and never asks for anything; otherwise the check when the app opens covers it.

## 0.6.2

The passkey no longer hides behind the phone's pairing box. It goes on the clipboard as soon as the board gives it, for
this phone only and for 2 minutes, to paste into the box, and the top of the screen says it while pairing.

## 0.6.1

The Bluetooth update reads the account again when it is not known, and says when it could not check it rather than
saying that only a release manager can send firmware, so a release manager is never refused because one read failed.

## 0.6.0

Customers can sign in to see their own boards, as on the customer website: an overview, their devices and each board's
page, the mixes to come, their account with a password change and two-step sign-in, and help. The team signs in with
Admin sign-in, as before, into Admin mode, which is the whole app as it was, and can leave it again.

The customer side signs in to the customer pool with its own phone client, on the app's own screen: the password with
SRP, the code in six boxes if the customer turned it on, a new password at the first sign-in, and a reset with a code
sent by e-mail. Its session is kept apart from the admin's, in its own encrypted file, under its own keys, and unlocks
with a fingerprint by the same rules. A board is named only by the id of its assignment. Every word is the customer
site's, and the tests hold the two to each other.

Commit e05e272, 2026-11-05.

## 0.5.0

The board log under Events and on each board's page, the activity log in the website's sentences (who signed in, changes
made over USB, deployments by board name), each release's note, which release managers can edit, and the serial
console's changes to a board put in the activity log.

Events gains the Board log: each line to the second with its board, source, kind, warnings and lines lost, a source
filter, Hide and Show, the new kinds Settings and Other lines, and a tick for each line on its board's lane. A board's
page shows its latest lines. Search covers the board log.

The version commit, 2026-11-04.

## 0.4.0

Open the app with your fingerprint instead of the password and code, for up to 30 days.

Commit 1c95768, 2026-11-04.

## 0.3.0

A cleaner design, Search and Help, and the app's own sign-in with the code in six boxes.

Commit 60e621a, 2026-11-03.

## 0.2.0

Everything the website does, and the board's serial console over USB.

Commit 51231f8, 2026-11-03.

## 0.1.1

A checked release is kept on the phone, so sending it again needs no download.

Commit cdbfe49, 2026-11-02.

## 0.1.0

The first app: sign in, pick a release on AWS and send it to a board over Bluetooth.

Commit 5ac1dc2, 2026-11-02.
