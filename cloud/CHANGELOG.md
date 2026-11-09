# Console changes

The console is the website at console.craniumiot.com (and the customer site at craniumiot.com), its API and its AWS
stack: everything in `cloud/`. One entry per version, newest first; the version is in `cloud/VERSION`, and each version
is tagged `console-v<version>` on the commit it was built from. A small change or a fix is a patch (1.9.0 to 1.9.1), a
larger update the middle number, never the first; 2.0.0 should have been 1.11.0 (docs/versions.md). The first
paragraph of an entry is what the console shows under "What's new". Versions before 1.9.1 were given later, from the
history; each names its commit.

## 2.6.0

The console shows what Memfault knows: a Memfault page with the boards' issues, each issue with its traces, backtraces and registers, and on each board's page its reboots with their reasons, its update events and its issues.

The API reads Memfault's REST API on the server, with GETs only, and the browser never talks to Memfault
(handlers/memfault.mjs, aws-memfault-api.mjs, lib/memfault-data.mjs). New read routes for viewers and release
managers: `GET /api/memfault/issues`, `GET /api/memfault/issues/{id}`, `GET /api/devices/{thing}/memfault` and
`GET /api/memfault/fleet` (devices, releases with their symbols, reboots by reason, the latest heartbeat metrics
of every key, and what Memfault could not process). Memfault's answers are kept a minute, a failure 15 s; when
Memfault cannot be read the answer is still 200 and says why in words. The token is a new secret,
`<stack>/memfault-org-token` (output MemfaultOrgTokenArn), which only the API function may read; deploy.sh
stores it from `~/.cranium/memfault_org_token`, the Deploy console workflow from the repository secret
`MEMFAULT_ORG_TOKEN`. Metric charts, and the fleet route's metrics and reboot reasons on the Memfault page,
come in a later version.

## 2.4.5

The customer site has one sign-in for everybody: the e-mail address and the password, then the code when the account asks for one. A team account lands in admin mode, a customer on their own pages; "Admin sign-in" and "Customer sign-in" are gone.

customer-core.js signInEither: the team's pool first (USER_SRP_AUTH with the console's client, the address in lower
case), and only if it says the address or the password is wrong, the customer pool, the same way. One submission tries
each pool once at most, and a refusal by both is the one "The e-mail address or password is wrong.", whichever pool
has the account. The team's code (TOTP), a customer's first new password and the throttling words are as before. An
admin who signs in goes to `/admin` with the console's own session keys; `#/admin-sign-in` is no page any more.
"Forgot your password?" asks both pools, one request each: the team's pool hides unknown names (it answers as if a
code went out), so a yes from it proves nothing; the new password is set at the team's pool if it takes the code, else
at the customer pool, and the page says the same either way. The console's own sign-in page stays team-only.

## 2.4.4

An admin on the customer site sees the customer's Overview itself, with its mixes, and admin mode where a customer sees their boards, instead of a card that only described it.

customer-views.js adminOverview: the Overview's own head, tools and mixes (from the demo or the admin's journal),
then the admin-mode panel. The card "What customers see" and the heading "Signed in as an admin." are gone from the
site; the phone apps' classic screens keep their own words, and the parity lists of CustomerText and the iPhone
tests no longer expect them on the site.

## 2.4.3

The customer site keeps the journal in the phone app, so that Explore demo, My journal, saved moments and imported sessions last across launches on the iPhone, and its Help answer on the journal says "kept on this device only" in a browser and in the app.

In the app, when it offers `storage.*` (phone apps from 0.8.2), the site reads and writes the journal and its choices there instead of in the page's `localStorage`, moves over once what an older app left in the page, and says "this app" where the website says "this browser". The website is as before.

## 2.4.2

The Apps page's Download the configuration has the live API's address too, so that phone apps built from it, from 0.8.1, show a board's change within about a second.

GET /api/apps/config has `liveUrl`, the stack's LiveUrl, before `loginDomain`, as apps/configure.sh writes it; the API
function has it as LIVE_URL, and takes nothing but wss://<API id>.execute-api.<region>.amazonaws.com/<stage> (an empty
or missing one leaves the key out). The apps put its origin into their pages' policy (apps/shared/bridge.json, `{live}`).

## 2.4.1

The phone apps reach the console again: every request of their pages failed with "The console could not reach its server", because the browser's check before each one was refused.

A page of another origin, as the apps' pages are (cranium-app://bundle, appassets.androidplatform.net), asks with
OPTIONS before each call with a token. The HTTP API's $default route brought that request to the web function, which
answers only GET and said 405; a preflight needs a 2xx, so the WebView stopped the call. The web function now answers
OPTIONS under /api/ on the console's and the customer site's names with a 204 and no body, and API Gateway adds its
CORS headers to it, as it did to the 405. Any other OPTIONS is still a 405. docs/mobile-apps.md says how CORS works now.

## 2.4.0

Live updates: an open page hears of a change as it happens, and shows it within about a second instead of on its next refresh. A board that connects, restarts or takes an update, a new release, a board given to a customer: the console, and the customer site for a customer's own boards, read it again at once. The console's Live mark shows while it is connected; the 30-second refresh stays for when it is not.

A WebSocket API of its own (LiveApi, stage live) and a function, LiveFn (api/src/live.mjs, live-app.mjs), with a table
of open connections. The state, audit and events tables each gain a stream of keys only, and three filtered event source
mappings hand LiveFn a board's events and update facts, ownership, releases, groups, rollouts, phone app builds and new
activity entries, never the readings every 30 s or the console's lines. LiveFn sends each page that may see it one
message with no data of a board: the team hears thing names, a customer only of the boards they own, by the id of the
assignment. A page connects with its access token in the Sec-WebSocket-Protocol header, never in the address; LiveFn
checks its signature against the pool's keys (api/src/lib/jwt.mjs), the client and the times, and asks Cognito whether
the account may, as the API does. The web function puts the address in both sites' settings (liveUrl) and allows its
origin in their policies. The pages' side is web/src/site/assets/live.js, fetched on demand; the apps' shells of 0.8.0
do not pass the address on yet, so their pages poll as before. cloud/logs.sh live follows the function's log.
docs/live.md says all of it.

## 2.3.0

The customer site looks like the mockup: a dark sidebar, Connect device and Export in the top bar, and pages of its own for Sessions, Transitions, the Track library and Saved moments. Explore them with a made-up demo, or import your own sessions (CSV or JSON) into a journal kept in your browser; keep a transition with a note, and export a backup or a spreadsheet.

The Overview leads with the mixes (the card "After the last track", time on the decks, sessions, tracks played and
overlaps, the last set with its shape on the two decks and its tracks, On repeat, a moment to come back to), then the
boards as before. A range of all time, 7 or 30 days, a search in a set and in the library, and a session's own page with
its transitions. Boards still do not send what is played: the demo says it is made up wherever it shows, and an empty
journal says why. The phone apps show the same pages from their bundle. customer-mixes.js works it out
(web/test/mixes.test.mjs); customer-mix-views.js draws it (docs/customer-site.md, "The mixes").

## 2.2.0

The phone apps from 0.8.0 show the console's own pages: the console serves them as a bundle at /app/manifest.json, each file with its SHA-256, and the apps keep it on the phone, so a console deploy updates every phone the next time its app opens. In the apps, the console gains a Bluetooth update page. The API takes calls from any origin, with no credentials: API Gateway refuses the iPhone app's cranium-app:// origin by name.

Fixes in the same version, which reach the apps too, as they show these pages: on the customer site, Devices and Account no
longer fall back to Overview for an admin without a customer account (each is a page of its own, pointing to admin mode),
and a test opens every link of the side panel and tab bar for a customer and an admin. The Events timeline has taller lanes,
groups events within a few pixels into one marker with their number, lists each event with its time on hover, tap or Tab,
has a 6 h range that this browser remembers, and a key of what the marks mean. The Deployments page leads with every
update, newest first and however it came, with sums that count them (the deployments' own figures are labelled as theirs),
and the Overview's Updates card says the same sums. An update names its person by the account's given name or name where
the user pool has one, else by the first part of the address without its trailing digits ("Vihaan", not "Vihaan1").

The phone apps' copy of the console and the customer site, for the app shell of 0.8.0: a manifest at /app/manifest.json with every file's path, size and SHA-256 and an id that hashes them, and each file at /app/files/<sha256>. The pages gain a bridge to the app, its sign-in kept by the app, and an update over Bluetooth; the API takes calls from the apps' two origins.

The bundle (web/src/bundle.mjs) is built by the web function when it starts, from the files it serves: the customer
site's page and the console's as admin mode, each with `{"app":true}` in its settings tag, and every file of both under
assets/<build id>/. It holds nothing of the stack. web/build-bundle.mjs writes the same bundle into a folder, for the
copy built into each app. A route of its own, GET /app/{proxy+}, public, 10 a second and bursts of 40.

The pages in the app (assets/bridge.js, fetched only there): the settings from the app, the API at the console's
address, the session in memory with the refresh token handed to the app (core.js createAuth's vault), Face ID or the
fingerprint, and a sign-in asked for again on 403 phone_sign_in_again. The console's Bluetooth page (assets/bluetooth.js),
for release managers in an app with Bluetooth, follows the board with UpdateWatch ported to assets/updatewatch.js, with
the apps' test cases. The HTTP API's CORS allows cranium-app://bundle and https://appassets.androidplatform.net, with no
credentials; nothing changes for a browser.

## 2.1.1

The update history has every update, not only deployments: those over Bluetooth from a phone, with whose phone sent them, and those by USB or another tool, each kept, rolled back, not installed or pending. The Overview's Updates, the Deployments page (Every update), a board's page and fleet health show them.

The recorder keeps what each board says of an update as facts in the events table (pk `UPD#<thing>`: the version it
reports changing and being confirmed, its Bluetooth record from the shadow and from the BT lines of firmware 1.12.0 on,
an image's arrival, the end of a job), each put once at its first time. `GET /api/updates` (newest first, 25 a page,
`?thing=`) folds a board's facts and its AWS IoT executions into one record per update: { thing, from, to, how:
deployment | bluetooth | usb_or_other, deployment, who, outcome: kept | rolled_back | not_installed | pending,
startedAt, endedAt, status }. Who sent an update over Bluetooth is whoever's phone made the check before the send for
that version and board, in the two hours before; who started a deployment is in its job. `GET /api/devices/{thing}` has
the board's newest as `lastUpdate`, and fleet health counts the updates over Bluetooth and by USB beside the jobs'.

The first read of a board's history makes its facts once from what the events table holds (90 days of the shadow's
events, and the BT lines), so 1.13.0 and 1.14.0 over Bluetooth on 2026-11-05 and the updates before them appear; the
API may put facts only in the `UPD#` partitions (ApiRole `BackfillUpdateHistory`). The customer site shows no update
history, so the customer API is unchanged. docs/aws-iot.md, "Update history".

## 2.1.0

Memfault for firmware 1.14.0, through AWS IoT: a board's coredumps, restarts and metrics go to Memfault, and its page links to it. The iPhone app for every iPhone of the team through SideStore: each member's own SideStore link on the Apps page, and iPhone builds published like APKs. The Android app can fetch its own updates.

Memfault, for firmware 1.14.0: the boards' coredumps, reboot reasons, metrics and update events reach Memfault through
AWS IoT, which stays their only cloud. A board's page says whether that is on, with a link to the board in Memfault,
and its menu has Send Memfault data now.

A new function, MemfaultFn, takes each chunk a board publishes on cranium/<thing>/memfault, posts it to Memfault's
chunks API with the project key from AWS Secrets Manager, and answers the board on its commands topic so that it sends
the next. Without a key it drops the chunk and does not answer, and the board keeps its data. cloud/deploy.sh stores
the key from ~/.cranium/memfault_project_key and takes the organization's and the project's slugs for the link
(docs/memfault.md). The device policy lets a board publish on its own memfault topic, and the commands API takes
"memfault". `cloud/logs.sh memfault` follows the function, and `cloud/logs.sh memfault-errors` what the rule could not
hand it.

The iPhone app on the console, for every iPhone of the team through SideStore: release managers publish an unsigned
IPA the same two-step way as an APK (a presigned PUT to S3, then a check), once per version and only upward by version
and build; the check reads the IPA's Info.plist out of the zip in S3 (bundle ID, version, build) and its cranium.json,
which must be this console's. Each member makes a SideStore source link of their own on the Apps page (Add to
SideStore, the address and a QR code), shown once and stored as its digest; a new one ends the old, and it can be
turned off. SideStore reads the source with no sign-in, and each download address answers 302 with a fresh presigned
S3 GET, so the IPA never has a public address. A route of its own, GET /api/sidestore/{proxy+}, has no authorizer and
the lowest limits; a key is used at most 30 times a minute, and its owner must still be a member. New actions
app.ios_upload, app.ios_publish, app.ios_download, app.source_create and app.source_revoke; the API role may put, read
and serve apps/ios/cranium-ios-*.ipa. The Android app may ask for its own update link (`via=app`).

Commit bcc5a19, 2026-11-05. Deployed, with the Memfault project key stored.

## 2.0.1

The phone apps can sign customers in: a client of the customer pool of their own, whose sign-in an app keeps behind
Face ID or a fingerprint for up to 30 days, and the customer API takes its tokens as it takes the customer site's.

`CustomerMobileUserPoolClient`: SRP only, no secret, no OAuth, refresh token 30 days, as the staff pool's phone client.
The customer authorizer's audience and the customer API both name it, the API's log says which client a request came
from, and the output `CustomerMobileClientId` goes into the apps' configuration (`apps/configure.sh`, and the Apps
page's Download the configuration). See [docs/mobile-apps.md](../docs/mobile-apps.md#customers).

Commit d5a9093, 2026-11-05.

## 2.0.0

A customer website on a name of its own: customers sign in to see their own boards (online, firmware, last report,
updates, what they did), and the team signs in once with Admin sign-in to open the console as admin mode at /admin. A
new Customers page invites customers and gives them boards, each change in the activity log.

A second Cognito pool for customers, apart from the staff pool, and a customer API with its own function, role and
authorizer, so that neither kind of token opens the other's API. The site's sign-in is the console's own (SRP, the code
in six boxes), which now also works without managed login pages and takes a first sign-in's new password. New
parameters `CustomerDomainName`, `CustomerCertificateArn` and `CustomerSelfSignUp`, all off by default; see
[docs/customer-site.md](../docs/customer-site.md). The local preview has `--customer` and `--scenario customers`.

Commit 552d4d9, 2026-11-05. By the rule above this should have been 1.11.0; the tag stays.

## 1.10.0

Fleet tools: board types, groups, staged rollouts with a canary that stop by themselves, Update everything, and the
right image only on a board of its type and flash layout. A map of the boards from Wi-Fi, Identify and Report now,
e-mail alerts, editable release notes, the Apps page to install the phone apps, and the console's version at the foot
of every page.

Fleet page: each board's type, health and groups, and deployments to a group, a type or the whole fleet. A release
says which board type and flash layout it is for, read from its signed image, and is never offered to another. The
staged rollouts' schedule sends an e-mail alert when a canary does not confirm or AWS IoT stops the waves.

The version commit, 2026-11-04.

## 1.9.1

Phone sessions can last 30 days behind Face ID or a fingerprint; without them, an hour as before. The website's own
sessions are unchanged.

Commit 7f34f56, 2026-11-04.

## 1.9.0

Each board's own log on the Events page (from firmware 1.12.0), who signed in, on the website or a phone, and the
settings changed at a board's serial console over USB, in the activity log, which now reads as sentences.

Commit 662e305, 2026-11-03.

## 1.8.0

The phone apps can sign in on their own screen, with the code in six boxes, as the website does.

Commit cbd6131, 2026-11-03.

## 1.7.1

The Events page's board filter shows All boards when the page first opens.

Commit b5d87ba, 2026-11-03.

## 1.7.0

Each board's own name (its device ID, from firmware 1.11.4) everywhere the console shows a board, with the AWS thing
name beside it.

Commit 65f425b, 2026-11-03.

## 1.6.0

The phone apps can do everything the website does; a change from a phone needs a sign-in in the last 15 minutes.

Commit 4c2b5ef, 2026-11-03.

## 1.5.1

The findings of the security review fixed, and each build uploaded to the console by itself.

Commits 9c0bd59 and 368b844, 2026-11-03.

## 1.5.0

The console's own sign-in page, with the code in six boxes.

Commit 22e9c37, 2026-11-02.

## 1.4.0

The Events page, with every event of every board on a timeline, and the Diagnostics page.

Commit eed1e50, 2026-11-02.

## 1.3.0

Personal API tokens, made and ended on the console's API tokens page.

Commit ea87270, 2026-11-02.

## 1.2.0

Phone apps can fetch a release and a board's Bluetooth passkey, and the console shows a board open for an update over
Bluetooth.

Commits 1895923 and 1925596, 2026-11-02.

## 1.1.1

The console says only what it knows about a board and an update, explains a lost trial, and why the newest release can
differ from what a board runs.

Commits a924e33 to 9ea3d88, 2026-11-01.

## 1.1.0

A redesigned console, tighter security, and the public home page.

Commit c116dba, 2026-10-31.

## 1.0.0

The first console: upload a signed release (its signature checked), deploy it to boards as an AWS IoT job, follow each
board, cancel and revoke, the activity log, and sign-in with an authenticator app.

Commits 42998d6 to a9f82ee, 2026-10-10 and 11.
