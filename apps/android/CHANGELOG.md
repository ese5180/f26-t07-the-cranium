# Android app changes

One entry per version, newest first. The version is `craniumVersionName` in `apps/android/gradle.properties` (and
`craniumVersionCode` counts the versions); each is tagged `android-v<version>` on its commit. The two phone apps keep the
same numbers for the same features. The first paragraph of an entry is what the console's Apps page shows.

## 0.8.23

The activity log names the console's Raspberry Pi image entries (an upload begun and finished, a revocation) as the website does, and a deployment that brings a Pi image with board firmware links like any other. The Firmware and Deployments pages, which the app shows from the console's bundle, list Pi images and deploy them, alone or with firmware (console 2.26.0).

## 0.8.22

Shorter words in customer mode, the same as the customer site's: the Overview's line under its title, and the line under each Mixes tab (Sessions, Track library, Your listening, Saved moments), each now one short sentence. The activity log's note on an entry sent by a script is two short sentences; which scripts those are is now in the console's Activity page, under "How the activity log works". A board that never reported says "Has not reported to the console yet." instead of naming AWS IoT.

## 0.8.21

The Help answer about sessions and tracks now says that a board sends its sessions once its firmware supports it (1.18.0, not yet released), and that until then the site shows the demo or the imported journal.

## 0.8.20

Your listening in customer mode (console 2.22.0 and later): a new page under Mixes with the week on the decks, sessions per day, the top tracks and artists, the longest session and the busiest hour.

The page is the customer site's own, loaded as before; the app adds the tab's words to its Mixes list, checked against the site by the parity tests.

## 0.8.19

Scheduled starts and maintenance windows on the Deployments and Fleet pages (console 2.20.0 and later): a deployment, a staged rollout or a roll back to last good can be scheduled for later, a group can have a maintenance window, and the activity log reads all of it.

The pages are the console's own; the app adds the words for the new activity (`schedule.create`, `schedule.edit`,
`schedule.cancel`, `schedule.start`) and the new refusals (`schedule_over`, `invalid_window`, `creator_not_allowed`
and the others), checked
against core.js by the parity tests.

## 0.8.18

The weekly fleet report (console 2.19.0 and later): a Reports page of the last twelve weeks, each a page of how the fleet did, what was sent to it and what changed, to share as CSV. The activity log reads its new entries.

The pages are the console's own; the app has the Reports page and a week's page in its list of pages
(apps/shared/pages.json), and the activity log's words for `report.export` and `report.settings` and their refusals,
checked against the console by the parity tests.

## 0.8.17

Customer actions (console 2.18.0 and later): in customer mode a customer renames their boards, chooses which e-mails they want about them, and sees how to accept an update that waits at a board. The activity log reads what customers did.

The pages are the customer site's own, loaded as before; the app has the activity log's words for the two new actions
(said as done by "A customer") and their refusals, checked against the console by the parity tests.

## 0.8.16

Account management (console 2.17.0 and later): release managers see and manage the team's accounts on the new Team page, and reset a customer's password or remove a customer on the Customers page. The activity log reads the new entries.

The pages are the console's own; the app has the Team page in its list of pages (apps/shared/pages.json), and the
activity log's words for the nine new actions and their refusals, checked against the console by the parity tests.

## 0.8.15

Compare boards and a version timeline (console 2.16.0 and later): a board's page shows every version it ran, how each came and whether it stayed; tick 2 to 4 boards on the Devices page to compare them side by side, with what differs marked.

The pages are the console's own; the app has the new Compare page in its list of pages (apps/shared/pages.json),
checked against the console by the parity tests. No new words.

## 0.8.14

Roll back to last good on the Fleet page (console 2.14.0 and later): each board goes back to the last version it ran confirmed, after a preview of every board from → to and of the boards left out and why, as one staged rollout per release with the health gate always on. The activity log reads it too.

The page is the console's own; the app adds the words for the new activity (`fleet.rollback_last_good`) and the new
refusals (`gate_required`, `invalid_targets`), checked against core.js by the parity tests.

## 0.8.13

Scan board: the Devices page reads a board's QR code with the camera and opens that board's page (console 2.13.4 and later, which prints the codes on the boards' labels). The camera is used only when you tap Scan board, and a code that isn't a board of your console is refused.

CameraX for the picture and ZXing's core (Apache 2.0, on the phone, no service) for the code (shell/BoardScanner.kt, core/QrFrames.kt), and the `CAMERA` permission in the manifest, asked for at run time. The link is checked by `BoardLink` (`BoardLinkTest`): the console's
own scheme, host and port, the root path, no query, and `#/devices/<thing>`. The bridge has a new feature, `camera`,
offered on a phone with a camera, with `camera.scan`.

## 0.8.12

The same numbers as the iPhone app's 0.8.12, which updates itself from the phone through SideStore. Nothing in the Android app changed: it already updates itself from the console.

## 0.8.11

Alerts and safer rollouts in the app (console 2.13.0 and later): an Alerts page where release managers turn each alert rule on or off and set its threshold, a toast in the open app as soon as an alert goes out, and a Health gate on a staged rollout that holds the next stage until Memfault shows no new issue and no unexpected reboot.

The Alerts page (`#/alerts`) is in apps/shared/pages.json, so `PagesParityTest` checks that the console has it and that
its route takes the app's sign-in. The activity log's words gain `alert.rules` and the refusals `invalid_healthGate`,
`invalid_rules` and `rules_changed`, the same as the console's. A notification while the app is closed would need
Apple's and Google's push services, which are not set up (docs/alerts.md).

## 0.8.10

Search and filters on the console's long lists in the app (console 2.12.0 and later): the activity log, the events and the board log are searched by the server, and the boards, releases, deployments, tokens, customers and Memfault issues as they are shown, each with filters that fold under a Filters button on a phone.

The pages are the console's, so nothing new is listed in apps/shared/pages.json. The four new refusal codes of a bad
filter (`invalid_search`, `invalid_level`, `invalid_actions`, `invalid_outcomes`) have their words here as in core.js,
which `WebsiteListsTest` checks. Nothing else in the app changed.

## 0.8.9

The console's Memfault pages in the app (console 2.11.0 and later): a board's page charts its Memfault heartbeat metrics over 24 hours or 7 days, and the Memfault page shows the fleet's reboots by reason, the software versions and each board's latest metrics.

The board card "Memfault metrics" is in apps/shared/pages.json, so `PagesParityTest` checks that the console draws it and that
its route takes the app's sign-in. Nothing else in the app changed.

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
