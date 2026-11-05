# iPhone app changes

One entry per version, newest first. The version is `MARKETING_VERSION` in `apps/ios/project.yml` (and
`CURRENT_PROJECT_VERSION` counts the versions); each is tagged `ios-v<version>` on its commit. The two phone apps keep the
same numbers for the same features. The first paragraph of an entry is what the console's Apps page shows.

## 0.7.2

With firmware 1.14.0 or later the app hears the board itself over Bluetooth through the whole update: Button 1 or 2 as
the board took it, its own 2-minute countdown, and why it refused an image. After the restart it finds the board again
with no pairing, in the 2 minutes the board allows, and shows it on trial, then kept or rolled back, from the board
itself. A board without Wi-Fi is followed to the end. Older firmware: as before.

The board's status characteristic (9112B1B5-2A51-40F0-94D3-A76440F0E6CC, read and notify, no pairing) is read on the
link of the send, and each status that says something new is a fact for UpdateWatch. Once the link has gone, the app
scans for the board's status service, reads each board that advertises it once, follows only the one whose last update
over Bluetooth is this version and this image (the image's own hash, from its TLVs), and looks again after each
restart. It follows for 5 minutes after the link went, and 10 minutes after the board last said it is on trial; the
console is followed as before alongside. The parser and the new steps have the same words and test cases in both apps.

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

New versions reach every iPhone through SideStore, free, from each member's own source on the console's Apps page;
Help, About says where updates come from.

The release workflow builds the app as an unsigned IPA (`apps/ios/scripts/build-ipa.sh`), which SideStore signs on the
iPhone with the person's own Apple ID, and publishes it on the console (`apps/ios/scripts/publish.sh`).

## 0.6.2

The passkey no longer hides behind the phone's pairing box. It goes on the clipboard as soon as the board gives it, for
this phone only and for 2 minutes, to paste into the box, and the top of the screen says it while pairing.

## 0.6.1

A release manager is no longer taken for a viewer. When one read of the account failed, for example just after Face ID
while the sign-in was renewed, the app kept no role for the rest of the session: Update over Bluetooth refused, and
Continue stayed grey. It now tries again, checks the account before a Bluetooth update and on coming back, and says when
it could not check.

## 0.6.0

Customers can sign in to see their own boards, as on the customer website: an overview, their devices and each board's
page, the mixes to come, their account with a password change and two-step sign-in, and help. The team signs in with
Admin sign-in, as before, into Admin mode, which is the whole app as it was, and can leave it again.

The customer side signs in to the customer pool with its own phone client, on the app's own screen: the password with
SRP, the code in six boxes if the customer turned it on, a new password at the first sign-in, and a reset with a code
sent by e-mail. Its session is kept apart from the admin's, in Keychain items of its own, and opens with Face ID by the
same rules. A board is named only by the id of its assignment. Every word is the customer site's, and the tests hold
the two to each other.

Commit ee4e200, 2026-11-05.

## 0.5.2

Plain words for the console's newer refusals: the fleet's (a release for another board type or flash layout, groups,
staged rollouts), the e-mail alerts' and commands', and the Apps page's.

2026-11-04.

## 0.5.1

A fix: the Events screen compiles with the newest Xcode, which refuses a closure that uses a value declared after it.

2026-11-04.

## 0.5.0

The board log under Events and on each board's page, the activity log in the website's sentences (who signed in, changes
made over USB, deployments by board name), and each release's note, which release managers can edit.

Commits 657bd8c and the version commit, 2026-11-04.

## 0.4.0

Open the app with Face ID (Touch ID on an iPhone with a Home button) instead of the password and code, for up to 30 days.

Commit a244efa, 2026-11-04.

## 0.3.0

A cleaner design, Search and Help, and the app's own sign-in with the code in six boxes.

Commits 5bd2eca and 19226de, 2026-11-03.

## 0.2.0

Everything the website does, in the console's colours.

Commit e218cd9, 2026-11-03.

## 0.1.1

A checked release is kept on the phone, so sending it again needs no download.

Commit cdbfe49, 2026-11-02.

## 0.1.0

The first app: sign in, pick a release on AWS and send it to a board over Bluetooth.

Commit 5ac1dc2, 2026-11-02.
