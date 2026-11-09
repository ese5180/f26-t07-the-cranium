# iPhone app changes

One entry per version, newest first. The version is `MARKETING_VERSION` in `apps/ios/project.yml` (and
`CURRENT_PROJECT_VERSION` counts the versions); each is tagged `ios-v<version>` on its commit. The two phone apps keep the
same numbers for the same features. The first paragraph of an entry is what the console's Apps page shows.

## 0.8.10

Search and filters on the console's long lists in the app (console 2.12.0 and later): the activity log, the events and the board log are searched by the server, and the boards, releases, deployments, tokens, customers and Memfault issues as they are shown, each with filters that fold under a Filters button on a phone.

The pages are the console's, so nothing new is listed in apps/shared/pages.json. The four new refusal codes of a bad
filter (`invalid_search`, `invalid_level`, `invalid_actions`, `invalid_outcomes`) have their words here as in core.js,
which `ParityTests` checks. Nothing else in the app changed.

## 0.8.9

The console's Memfault pages in the app (console 2.11.0 and later): a board's page charts its Memfault heartbeat metrics over 24 hours or 7 days, and the Memfault page shows the fleet's reboots by reason, the software versions and each board's latest metrics.

The board card "Memfault metrics" is in apps/shared/pages.json, so `PagesParityTests` checks that the console draws it and that
its route takes the app's sign-in. Nothing else in the app changed.

## 0.8.8

The Serial console and Board setup are gone from the iPhone app: an iPhone cannot open a board's USB serial port, so neither page could work here. They are on a computer (Chrome, Edge or the desktop app) and in the Android app.

The console's pages leave both out of Developer inside the iPhone app (views.js `serialPagesHidden`), and the shell
drops their addresses (`ShellPolicy.excludedSections`). The classic screens' Serial console and Board setup
explanations (`SerialConsoleView`, `BoardSetupView`, CraniumKit `BoardSetupWords`) and their search entry are
gone. apps/shared/pages.json excludes both pages on `ios` with the reason, and `PagesParityTests` checks that
the shell refuses them; any other page missing still fails.

## 0.8.7

The console's Database page comes with the app, under Developer, for release managers: the console's tables, read only, with filters, each item's fields, and an export as CSV or JSON that goes to the share sheet.

The page is the console's own (2.10.0 and later); `PagesParityTests` checks it through `apps/shared/pages.json`. The
activity log reads the new `db.export` entries, and the five new refusals of the Database page, in the website's words
(`Words.swift`, checked by `ParityTests`).

## 0.8.6

The console's Memfault page comes with the app: the issue list, an issue's traces, backtraces and registers, and the In Memfault card on a board's page, with its reboots, events and issues. A test now fails if a console page is missing from the app.

The app shell shows the console's own pages, so the Memfault page comes with the console (2.6.0 and later) under the
console's sections. `PagesParityTests` reads `apps/shared/pages.json` with the console's sources and checks each
page: its section, its script in the bundle, its API routes open to the phone apps' sign-in, and the shell's rules for
the web view (docs/mobile-apps.md, "Pages in every app").

## 0.8.5

Staged rollouts as on the console from 2.8.0: after the canary, the boards update in stages, all of a stage at once. The Roll out form takes the number of stages, the batch size, the wait between stages and the failure limit, filled in from the console's suggestion with its reasons, and a rollout's page shows each stage as it goes.

The app shell shows the console's own pages, so the form and the stage view come with the console. The activity log's
words (CraniumKit `Words.refusalWords`) have the console's three new refusals: `invalid_stages`, `invalid_batch` and
`invalid_soakMinutes`.

## 0.8.4

More has Board setup, which says why it needs a computer: an iPhone cannot open a board's USB serial port. The desktop app or Chrome or Edge on a computer does it.

`BoardSetupView`, with the words of the console's setup.js (CraniumKit `BoardSetupWords`, held to them by a test). The
activity log reads `setup.wifi_defaults` and the two new refusals of the console's Wi-Fi defaults.

## 0.8.3

One sign-in for everybody, as on the website since console 2.4.5: the e-mail address and the password, then the code when the account asks for one. A team account opens admin mode, a customer their own pages; "Admin sign-in" and "Customer sign-in" are gone.

The classic screens' sign-in (`CustomerSignInScreen`) asks the team's pool first, with the phone apps' client, and only
if it says the address or the password is wrong, the customer pool (CraniumKit `OneSignIn`): one try at each pool, and
the same words whichever refused. A team account's code goes in the same six boxes; a step only the AWS sign-in page
does takes the team account there. "Forgot your password?" asks both pools, one request each. The admin overview's
"Customer sign-in" button and the console screen's way to it are gone. The shell's sign-in is the website's page, which
has the same rule.

## 0.8.2

The customer site's features work in the app as on the website: Explore demo, My journal, saved moments, imported
sessions and the date range are kept across launches, instead of being lost every time the app closed.

The shell's web view keeps no data on disk (`WKWebsiteDataStore.nonPersistent()`), so the page's `localStorage` lasted
only as long as the web view, and the page could not tell. The bridge has a new feature, `storage` (`storage.get`,
`storage.set`, `storage.remove`; `apps/shared/bridge.json`), with a store in Application Support (`Shell/PageStore.swift`:
keys `cranium.…`, 3 MB a value, 64 keys, 12 MB in all, excluded from backup, file-protected). The site keeps the journal
and its choices there, and moves over once what an older app left in the page's own storage. Help's answer on the
journal now says "kept on this device only".

## 0.8.1

Live updates in the app: a board that connects, restarts or takes an update shows it within about a second, as the
console and the customer site do in a browser since console 2.4.0, instead of on the next 30-second refresh.

The configuration has a new key, `liveUrl`, the live API's WebSocket (docs/live.md), which `apps/configure.sh` writes
from the stack's `LiveUrl` and the Apps page's **Download the configuration** hands out. The app gives it to its pages
in `app.config`, and its origin, `wss://<id>.execute-api.<region>.amazonaws.com`, goes into both pages' policy as
`{live}` (apps/shared/bridge.json): from the app's own configuration only, never from what the console says, and only
when it is exactly the live API's address in the user pool's Region; anything else stops the build's configuration
from loading, naming the key. A configuration without it, as before, builds an app whose pages poll. Nothing else
changed: the bridge is still version 1, so the console's bundle works with 0.8.0 and 0.8.1 alike.

## 0.8.0

The app's screens are now the console's and the customer site's own pages, kept on the iPhone and updated from the
console without a reinstall: a change to the website reaches the app at its next start, anywhere. Sign-in, Face ID
and the Bluetooth update stay native, behind a small bridge. The 0.7 screens are under Classic app, for this version.

The app is a shell: a WKWebView that shows `cranium-app://bundle` and nothing else, served by a WKURLSchemeHandler
from a copy of the pages on the phone, never from the network. The copy comes from the console's
`/app/manifest.json` (every file's path, size and SHA-256, and an id that hashes all of it) and `/app/files/<sha256>`;
each file is checked before it is kept, a new bundle is swapped in with one rename, the previous one is kept, and one
that has not started after two tries is dropped for the one before. The pages built into the app
(`scripts/copy-bundle.sh`, from `cloud/web/build-bundle.mjs`) are the last resort. Every page gets the
Content-Security-Policy of `apps/shared/bridge.json`; any other address goes to Safari, SideStore or an authenticator
app, or nowhere.

The bridge (`cranium.bridge` in the page, version 1, the contract in `apps/shared/bridge.json` checked by
`BridgeSpecTests`) takes only the methods and parameters listed there: the sign-in's tokens, which go into the same
Keychain items as before, so that the shell and the classic app share one sign-in, with the page given access tokens
only; Face ID; Bluetooth (scan, connect and pair, image list, upload only, the status characteristic and the board
after its restart); the clipboard with an expiry; haptics; the share sheet; opening SideStore and other apps; and the
shell's own settings, with Classic app. A Home Screen quick action opens the classic app too.

## 0.7.3

The Overview's Updates and a board's History and Updates now list every update, as the console has them: deployments,
and the updates the board reported itself, over Bluetooth or by USB or another tool, each with what it ran before, how
it came, when, and whether it was kept. A board updated over Bluetooth no longer shows its last deployment as its last
update. With an older console the app shows what it showed before.

The app reads `GET /api/updates` (console 2.1.1): the newest update for the Overview, and a board's first 25 for its
page and its Updates screen, which loads older ones on Load more. While a screen polls faster, they are read at most
every 15 s. A deployment's row opens the deployment, any other the board. A console that answers 404 `not_found` has no
such route: the rows come from the deployments again, as in 0.7.2, and the route is asked again only on a full refresh.
The words are the same on the website and in both apps.

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
