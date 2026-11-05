# iPhone app changes

One entry per version, newest first. The version is `MARKETING_VERSION` in `apps/ios/project.yml` (and
`CURRENT_PROJECT_VERSION` counts the versions); each is tagged `ios-v<version>` on its commit. The two phone apps keep the
same numbers for the same features. The first paragraph of an entry is what the console's Apps page shows.

## 0.6.0

Customers can sign in to see their own boards, as on the customer website: an overview, their devices and each board's
page, the mixes to come, their account with a password change and two-step sign-in, and help. The team signs in with
Admin sign-in, as before, into Admin mode, which is the whole app as it was, and can leave it again.

The customer side signs in to the customer pool with its own phone client, on the app's own screen: the password with
SRP, the code in six boxes if the customer turned it on, a new password at the first sign-in, and a reset with a code
sent by e-mail. Its session is kept apart from the admin's, in Keychain items of its own, and opens with Face ID by the
same rules. A board is named only by the id of its assignment. Every word is the customer site's, and the tests hold
the two to each other.

Not released yet: branch feature/customer-apps, 2026-11-05.

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
