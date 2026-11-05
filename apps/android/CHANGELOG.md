# Android app changes

One entry per version, newest first. The version is `craniumVersionName` in `apps/android/gradle.properties` (and
`craniumVersionCode` counts the versions); each is tagged `android-v<version>` on its commit. The two phone apps keep the
same numbers for the same features. The first paragraph of an entry is what the console's Apps page shows.

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

Not released yet: branch feature/customer-apps, 2026-11-05.

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
