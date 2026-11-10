# Console changes

The console is the website at console.craniumiot.com (and the customer site at craniumiot.com), its API and its AWS
stack: everything in `cloud/`. One entry per version, newest first; the version is in `cloud/VERSION`, and each version
is tagged `console-v<version>` on the commit it was built from. A small change or a fix is a patch (1.9.0 to 1.9.1), a
larger update the middle number, never the first; 2.0.0 should have been 1.11.0 (docs/versions.md). The first
paragraph of an entry is what the console shows under "What's new". Versions before 1.9.1 were given later, from the
history; each names its commit.

## 2.19.0

A weekly fleet report: a Reports page lists the last twelve weeks, Monday to Sunday in New York time, and each week opens as one printable page with the fleet health score and its trend, the boards online, offline and new, the firmware they ran, the week's deployments and staged rollouts with how they ended (health-gate stops and rollbacks counted apart), Memfault's new issues and unexpected reboots by reason, the boards' own restarts, the alerts sent and the activity log's top changes. Print it or save it as a PDF, or download its tables as CSV. A release manager can switch on a Monday e-mail of the summary through the alert topic.

handlers/reports.mjs and lib/reports.mjs are new: `GET /api/reports`, `GET /api/reports/{week}`, `GET
/api/reports/{week}/export?format=csv` (on record as `report.export`, any member) and `POST /api/reports/settings`
(`report.settings`, release managers; off by default, written only if unchanged meanwhile). A report is made on
demand from the records the console already keeps, kept in memory (5 minutes for the week under way, an hour for a
finished one), and stored in the state table (pk `RPT`) once its week has been over six hours. The daily health
snapshot now also counts the boards and their versions (`fleet`), the one new piece of data, so that a past week can
say what the fleet was. The schedule (RolloutTickFn) sends the Monday e-mail once a week from 08:00 New York time,
claimed by a conditional put; its role gains Query of the activity log, and GetItem, Query and PutItem on `RPT` only.
New refusal words: `invalid_week`, `unknown_week`, `invalid_report_format`, `invalid_report_settings`,
`report_settings_changed`, in core.js and the iOS and Android lists. docs/reports.md.

## 2.18.0

Customers can now change a little on the customer site and in the phone apps' customer mode: give each of their
boards a name of their own (Rename, on the board's page), choose which e-mails they want about their boards (a board
goes offline, an update is installed, a board restarts unexpectedly: each off until turned on, on the Account page),
and see clearly when an update waits at a board for them, with how to accept it there.

The customer API takes two writes, `POST /api/c/boards/{id}/label` and `POST /api/c/preferences`, and one more read,
`GET /api/c/preferences`, through a new route `POST /api/c/{proxy+}` behind the customer pool's authorizer, held below
the reads (burst 5, rate 2). Every write asks Cognito again whether the account is on, is held to 10 a minute and 60
an hour per customer, finds the board among the customer's own (another customer's is the same 404 as one that does
not exist), and leaves an entry in a new partition of the audit table (`CUS`), with `by: "customer"` and the
customer's sub, never their address. The console's activity log reads both partitions and says "A customer named
... on the customer site"; the Customers page shows the customer's label beside the admin's. The customer's name is
`customerLabel` on the ownership item; the thing name and the admin's label never change, and taking a board back
removes it. Preferences are `pk = PRF, sk = <sub>` in the state table.

An update that waits at a board (`awaiting_user`) is not accepted from the site: the firmware takes it from Button 1
only, and no cloud command or shadow field reaches it, so the site says how to accept it at the board. E-mails are
chosen and kept, and decided by `customer/notify.mjs`, but none is sent yet: the stack has no SES identity and the
alerts' SNS topic cannot address one customer; docs/customer-site.md, "Notifications", says what turning it on takes.

IAM: CustomerApiRole gains UpdateItem on OWN items, GetItem and UpdateItem on PRF items, PutItem and Query on the
audit table's CUS partition (with a Deny on changing them), and the function the setting `AUDIT_TABLE`. Refusal words
for the new codes in core.js and both apps. docs/customer-site.md, "Customer actions".

## 2.17.1

The customer site has an About page (`#/about`): what Cranium is, the problem it solves and who it is for, and the
team, four founders, with a photo or their initials until there is one. It is linked from the home page's top bar and
foot, the sign-in page, the studio's side panel and the foot of every page, and it opens signed out too, in the
browser and in the phone apps.

The photos are kept in `cloud/web/team-photos/` and written as `data:` addresses into
`customer/assets/customer-team-photos.js` by `node cloud/web/build-team-photos.mjs` (at most 60 KB each), so the
phone apps' bundle still holds only text files and neither the site's policy nor the apps' changed. The first photo
is 15 KB of WebP, about 20 KB in the bundle. No new routes or refusal words. docs/customer-site.md, "About".

## 2.17.0

Account management: a Team page for release managers lists everybody who signs in to the console, with their tier, whether they are enabled, invited or active, whether an authenticator app is set up, when they were added and when they last signed in, and lets a release manager invite, change the tier of, disable, enable, reset and remove an account. The Customers page shows each customer's authenticator too, and can reset a customer's password or remove the account. The console never sees or sets a password.

handlers/team.mjs and aws-team.mjs are new: `GET /api/team`, `POST /api/team` (invite), and `POST
/api/team/{id}/resend|tier|disable|enable|reset|remove`, release managers on the website only (no API token, no phone
session), each asked of Cognito at the moment. Nobody changes their own account (`own_account`), and a change that
would leave no enabled release manager is refused (`last_release_manager`). A reset replaces the account with the
same tier and a new invitation, because the staff pool requires an authenticator and has admin-only recovery
(docs/accounts.md). Customers gain `POST /api/customers/{id}/reset-password` (Cognito's admin reset, which e-mails a
code) and `/remove`, and the list says `enabled`, `confirmed` and `mfa`. New activity-log actions `account.invite`,
`account.resend`, `account.tier`, `account.disable`, `account.enable`, `account.reset`, `account.remove`,
`customer.reset_password` and `customer.remove`, each with what it changed before and after; new refusal words for
their codes. The API role gains `ManageTeam` on the staff pool and three actions on the customer pool, and nothing
that sets a password. docs/accounts.md.

## 2.16.1

The console always has a way back to the customer site. Opened on its own name (console.craniumiot.com), it now shows
"Customer site" in the account panel, next to Sign out, as admin mode of the customer site shows "Leave admin mode". The
web function passes the customer site's address; the page takes only an https origin.

## 2.16.0

Compare boards and a version timeline: each board's page shows every firmware version it ran, newest at the top, with when it started and ended, how it came (over the air, over Bluetooth, by USB, by a rollback, or before the history), whether it was confirmed or rolled back, and its unexpected restarts and issues while on it. Tick 2 to 4 boards on the Devices page (or Compare with… on a board's page) to set them side by side, with what differs marked.

`GET /api/devices/{thing}/timeline` is new (handlers/timeline.mjs, lib/board-timeline.mjs), for viewers and release
managers, paged (`limit` 1 to 50, default 20; `cursor`), refusing `invalid_limit`, `invalid_cursor`, `invalid_thing`
and `unknown_device`. It is made from the board's update history (the records lib/last-good.mjs reads), the version
its shadow reports, the releases (a release whose note begins `Rebuild of` arrives as a rollback) and the board's
warnings of the last 90 days: a restart with level warn is an unexpected restart, any other warning an issue; a version
that ended before events were kept has no counts. The Compare page (`#/compare?boards=a,b`, compare.js) reads only
routes the console had: the boards, each board's warnings of the last 7 days, Memfault's latest key metrics (the
metrics card's read) and the timelines in parallel columns. On a phone the boards stack, one card each. The Devices
page has a tick box on each board and a bar of what is ticked, which later bulk actions can use. No new refusal
words. docs/compare.md.

## 2.15.0

A fleet health score on the Overview: one number from 0 to 100 made of boards online, boards crash-free this week, updates that succeeded this week and boards on a good Wi-Fi signal, with a 30-day trend and how far it moved since last week. Each part says what it means and leads to its page.

lib/fleet-score.mjs is new: the four parts and their weights (online 0.35, crash-free 0.30, update success 0.20,
Wi-Fi signal 0.15, constants), and the score as the weighted mean of the parts that have something to count.
Crash-free counts the restarts at warning level in the events table and, through handlers/memfault.mjs `crashes`,
Memfault's unexpected reboots and the boards of issues it first saw this week. `GET /api/fleet/health` gains `score`
and takes `?days=` (1 to 31, 30 by default; else `400 invalid_range`), kept 30 seconds as before. The rollouts
schedule (tick.mjs) stores one snapshot a day in the state table (pk `HEALTH`, sk the UTC day) on the condition that
keeps the first; its role gains `PutItem` of that partition only and `Query` of the boards' partitions of the events
table. The Overview's card draws the trend with telemetry.js `lineChart` (new option `daily`); apps/shared/pages.json
lists it, so the apps' parity tests check it. The Database page lists the snapshots. docs/fleet-health.md.

## 2.14.0

Roll back to last good: one button on each group and on the Fleet page sends every board back to the last version it ran confirmed, from its update history, after a preview of each board from → to and of the boards left out and why. Boards going to the same release are one staged rollout, and the health gate is always on.

lib/last-good.mjs is new: a board's last good version is the newest version other than its own that an update brought
and it kept, or that an update started from (a board starts one only from confirmed firmware). A board takes only newer
firmware (the console's version rule, ota_job_check, MCUboot's downgrade prevention; no firmware changes), so, as the
group's Roll back said already, going back is a rebuild of the old source under a newer number: a release whose note
begins `Rebuild of <version>`. The target of a board is the newest active rebuild of its last good version newer than
what it runs, of its type and layout, or that version's own release where it is newer. Left out with why: `no_good`,
`good_revoked`, `no_rebuild`, `unreadable`, and the usual offline, never reported, Bluetooth only, another type or
layout, busy. `GET`/`POST /api/fleet/last-good` and `/api/groups/{id}/last-good`: one staged rollout per target
release (`purpose: last_good`), checked against the plan again (`409 plan_changed`), the gate 10 minutes unless asked
for longer and never off (`400 gate_required`), on record as `fleet.rollback_last_good`. New refusal words
`gate_required`, `invalid_targets`. docs/fleet.md "Roll back to last good", docs/mass-updates.md.

## 2.13.5

Board health for customers: on craniumiot.com and in the apps' customer mode, each board says how its week went in plain words ("Running normally", "Restarted unexpectedly twice this week", "Recovered from a problem on Tue 3 Nov", "Updated to 1.15.0 on ...", "Offline since ..."), with a dot in the board list and a strip of its restarts by day on the Overview and the board's page.

The customer Board gets `health`: `{ state, summary, unexpectedRestarts7d, lastIssueAt?, updatedTo?, restarts7d }`
(customer/health.mjs). It is derived from the events table the customer role already reads: restart events with the
boot diary's reset cause, and the firmware and update events, so the role and the template are unchanged and no
Memfault token is involved. A restart is expected (an update, a power cycle, the reset button) or unexpected (any
fault or watchdog cause in lib/events.mjs `BAD_CAUSES`, or a stuck restart); a software restart within 15 minutes of
an update is the update. The week's events are kept a minute per board in the function. No cause or fault name, stack
or thing name is in a Board. docs/customer-data.md "Board health", docs/customer-site.md "Board health".

## 2.13.4

QR codes and labels for boards: once Board setup sees a board online it shows the board's QR code and a label to print, and every board's page has Show QR / Print label. The code opens the board's page on this console; in the phone apps, Scan board on the Devices page reads it.

labels.js is new: the link (`<origin>/#/devices/<thing>`, the console's own origin, never an address written in), the
code (qrcode.js, the encoder the Apps page already vendors, in byte mode at M, version 10 at most), and the label, a
sticker of 62 x 29 mm with the code, the board's name and its thing name. Print label prints it alone on a page of that
size (app.css `@page board-label`); Print on paper puts the labels on the printer's paper. app.js fetches labels.js
when a board's page first shows its label, and setup.js shows it after the Online step. In the phone apps, the Devices
page has Scan board where the app offers the new bridge feature `camera` (`camera.scan` in apps/shared/bridge.json):
the app reads the code, checks it is a board of this console, and the page opens that board; anything else is refused.
No CDN, no new policy, and the API is unchanged. A sheet of labels for boards picked on the Devices page is not there
yet. docs/new-board-setup.md "The board's label", docs/mobile-apps.md "Scan board".

## 2.13.3

The iPhone app can ask for its own update link: `GET /api/apps/ios/<version>/download?via=app` goes on record as `app.ios_download` with `via: app`, as the Android app's does, for the app's one-tap update through SideStore (apps 0.8.12).

handlers/apps.mjs `downloadIos` reads `via` as `download` does (`link`, `qr` or `app`; anything else `400 invalid_via`).
The SideStore source was checked against the releases and is unchanged: it lists every published version newest first,
with its version, build, size, SHA-256 and date, from the release records at each read, so it follows each publish at
once. docs/mobile-apps.md, "Updating the iPhone app".

## 2.13.2

The rollout schedule (RolloutTickFn) starts again: it loads the console's settings like the API, and since 2.6.1 those
require `DEVICE_POLICY` and `FIRMWARE_DOWNLOAD_PREFIX`, which it was never given, so it failed on start and staged rollouts
did not go past their canary. A new test, `cloud/api/test/config-env-infra.test.mjs`, checks that every function that
loads the settings is given every one they require.

## 2.13.1

The activity log says what changed: an entry of a change opens to each field, what it was and what it is now. A secret is never shown, and an entry from before says that no details were recorded.

The API's handlers record `changes: [{ field, from, to }]` on the entries of releases uploaded, revoked and
re-noted, deployments, API tokens, e-mail alerts and alert rules, groups, rollouts (made, cancelled, advanced and stopped), "update
everything", group rollbacks and customers (lib/audit.mjs `change`). The Database page's denylist keeps secrets out
as `hidden`; an entry keeps at most 12 changes in 2,000 characters and counts the rest. The Activity page shows them
behind a "What changed" disclosure with "was" and "now", in both themes and on a phone (docs/audit-diff.md).

## 2.13.0

Safer staged rollouts and alert rules: a rollout's Health gate holds each next stage until Memfault shows no new issue and no unexpected reboot on the release for 10 minutes (on by default), and stops the rollout with the board and the issue when it does; the new Alerts page lets release managers turn on and tune alerts for a board offline, a new Memfault issue, a crash loop, a rollout that stopped by itself and low supply voltage; and each alert shows at once on every open page.

The gate (handlers/rollouts.mjs `healthGate`, lib/health.mjs, handlers/memfault.mjs `health`): after the canary and each
stage, the schedule waits `healthGate.minutes` (0 to 120) and then reads Memfault's processing log and issues through
the cached server-side reader; a trace of an issue or an unexpected reboot (lib/memfault-data.mjs reboot reasons from
0x8000) on the new version, on a board updated so far, stops the rollout with `health_failed` and the board, the issue's
id and title or the reboot's reason. A Memfault that cannot be read holds it, never passes it, and after 30 minutes stops
it with `health_unknown`. Both are self stops, so a "deployment" alert, whose e-mail now links to the rollout and the
issue. `POST /api/rollouts`, update-everything and rollback take `healthGate: { on, minutes }`; without it, none. The
suggestion has it on with a reason; the create forms have the choice; the rollout's page shows the gate and the stop.
The alert rules (lib/alerts.mjs `RULES`): one item in the state table (pk `ALR`), `POST /api/alerts/rules` for release
managers (audit `alert.rules`, refusals `invalid_rules`, `rules_changed`, `invalid_healthGate`), read by the recorder for
the offline minutes and by the schedule, which looks at Memfault at most every 5 minutes for new issues, crash loops and
low `supply_mv` (alerts.mjs `watch`). Repeats are held back an hour as before. A sent alert is a live change `alerts` for
the team (a new stream filter), and app.js shows it as a toast. RolloutTickFn may read the Memfault token and the `ALR`
partition; EventsFn the `ALR` partition. No phone push: what it would need is in docs/alerts.md.

## 2.12.0

Search and filters on every long list: the activity log, the events and the board log are searched by the server, a page at a time, and the boards, releases, deployments, API tokens, customers and Memfault issues as they are shown. A filtered list keeps its search and filters in its address, so it can be shared or bookmarked, and says how many are shown of how many.

One bar for all of them, `views.js filterBar` (docs/search-filters.md): a search box, the list's filters (under a
Filters button on a phone), "N of M shown", and Clear. The filters are in the address after a `?` (`core.js FILTERS`,
`readFilters`, `filtersHash`), replaced, never pushed. `GET /api/audit` takes `q`, `actions`, `outcomes`, `from` and
`to`: a Query of the log's key range with a filter that reads at most 1,000 entries a page and says how many it read
(`aws.mjs searchAudit`). `GET /api/events` and `/api/events/log` take `q` and `level` in the same Query of each
board's keys. Four new refusal codes: `invalid_search`, `invalid_level`, `invalid_actions`, `invalid_outcomes`. The
Events page's Console lane now asks the server for its range instead of reading the newest pages, and a board's page
links to its events and log.

## 2.11.0

Memfault's metrics in the console: a board's page charts its hourly heartbeat (power, Wi-Fi signal and channel, CPU, heap and stacks, the connection, stuck restarts, boot time and any other key) over 24 hours or 7 days, and the Memfault page shows the fleet's reboots by reason with the unexpected ones marked, the software versions on the boards, and each board's latest key metrics.

memfault-page.js `metricsSection` is a new card of a board's page ("Memfault metrics", listed in
apps/shared/pages.json): every key of `GET /api/devices/{thing}/memfault` as a chart, grouped, with names and units
for the firmware's and the SDK's keys (`METRICS`; percentages arrive in hundredths, times in ms) and the key itself
for any other. The charts are telemetry.js `lineChart`, now exported, so there is no new library and the page's policy
is unchanged. The Memfault page reads `GET /api/memfault/fleet` too (core.js `memfaultRequest` allows it) for three
more groups: reboots by reason with their share, versions with whether Memfault has their symbols, and a row per board
of its latest metrics. The API is unchanged. docs/memfault.md, "In the console".

## 2.10.1

The iPhone app no longer shows the Serial console or Board setup, which need a USB serial port an iPhone does not have. The Android app (0.8.8) has both, with the board on the phone's USB cable.

views.js `serialPagesHidden`: in a phone app with no `navigator.serial`, Developer leaves out both pages and leads to
History, and app.js treats `#/serial` and `#/setup` as no page. bridge.js `createBridgeSerial` makes the Android
app's `usb.*` (apps/shared/bridge.json) the page's `navigator.serial`, so serial.js, setup.js and recovery.js run
unchanged; app.js installs it when the app's hello has `usb`. setup.js no longer has the phone apps' "needs a
computer" screen; APP_WORDS keeps only the Android classic screens' words. apps/shared/pages.json gains `excluded`
(per app, with a reason), which the three parity tests check (docs/mobile-apps.md, "The serial pages").

## 2.10.0

A Database page under Developer, for release managers: the console's three DynamoDB tables (state, audit and events), read only. Each table with its rough item count and size, a page of items with filters (kind or partition, board, time range, text), an item's page with all its fields, and an export of the filtered items as CSV or JSON, up to 10,000 items, which goes in the activity log. Token digests, keys, passphrases, certificates and anything else credential-like read "hidden", for everybody.

Four routes, `GET /api/db/tables`, `/api/db/{table}`, `/api/db/{table}/item` and `/api/db/{table}/export`, refused to
viewers and to API tokens; the apps' sign-in reads them as the website's does (`handlers/db.mjs`, `lib/db.mjs`,
`aws-db.mjs`). A filter that names a partition is a Query of it; anything else is a Scan of one page with a Limit, never
a whole table for one view, and the page reads only when asked. The API role gains `dynamodb:DescribeTable` and
`dynamodb:Scan` on the three tables and nothing else (`BrowseDatabase`). A new activity log action, `db.export`, with
its table, format, filters and count. In an app with the share bridge the export goes to the share sheet or a save
dialog (docs/database.md). The page is drawn in 2.9.0's grouped look: the tables as one group of rows,
items as rows that open their page, an item's fields as label and value rows.

## 2.9.0

The console looks and works like an app, on a phone and in a browser: a tab bar of Overview, Devices, Map and Deployments with the rest under More, a large title that gives way to the top bar, grouped lists in place of cards and ink panels, and a sidebar on a wider screen. The Overview opens with the fleet at a glance and what needs attention; the Map fills the screen with the boards in a sheet over it; a dialog on a phone is a sheet.

The design and the principles behind it are in docs/console-design.md. The frame is new (index.html, app.css "The
frame", views.js navView, app.js showMore and watchTitle); the pages keep their markup and words, and are drawn under
the `console` class of the page's body, so that the customer site, which shares app.css, is as it was. Back on a page
goes back in the history when that is where it leads. New: the glance strip on the Overview (Online, Updating, Need
attention or Offline, Newest release), one icon per section, and a mark of each board's state at the start of its row. On a phone the Devices page opens with a strip (Online,
Offline, Bluetooth only, Updating) over one list of boards, the Map's legend is at the foot of its sheet, and the
choices in a dialog are rows of one group. 2.6.0's Memfault page and a board's Memfault cards are drawn the same
way: issues, reboots and events as rows, a trace's threads as rows of its group.

## 2.8.2

The Deployments page no longer fails with "AWS is limiting requests right now" when it loads many deployments at once. Reads of jobs are paced and tried again when AWS throttles them, and finished deployments are kept for ten minutes instead of being read on every load.

lib/iot-pace.mjs wraps the adapter in the API function and in the rollout schedule: DescribeJob, ListJobs,
ListJobExecutionsForJob, DescribeJobExecution and ListJobExecutionsForThing (each limited by AWS IoT to about 10
requests a second per account) run at most 4 at a time per function instance, each operation at most 8 a second after
a burst of 8, and two reads of the same job at the same moment are one call. A throttled read is tried up to 3 times
in all, after 100-200 ms and then 200-400 ms; only then is it `throttled`. In handlers/deployments.mjs a settled
summary is read again after 10 minutes (it was kept for ever), a running one after 2 s as before, and any summary
whose status is not the one ListJobs gives now. When a read is still throttled after its retries, the list shows that
deployment's last summary if it is under a minute old, and logs `summary_kept`; otherwise the request is a 429
`throttled` as before. Tests: test/iot-pace.test.mjs.

## 2.8.1

Board setup waits up to a minute for the last piece of each certificate. Found on a real board: a running nRF7002 DK
stores a certificate on its main thread, which it shares with its cloud connection, and after a new key that connection
keeps retrying with the old certificate, so the board's answer came after the 8 s the page gave every piece. The other
pieces keep their 8 s (`store` in `setup.js` timings, `docs/new-board-setup.md`).

## 2.8.0

Staged rollouts go in parallel after the canary: the rest of the boards follow in 1 to 10 stages, each updating all its boards at once, the next only once the one before has ended within its failure limit. Choose the number of stages, the batch size (percent or boards), the wait between stages and the limit; the console suggests a plan for the group, with its reasons.

handlers/rollouts.mjs, lib/stages.mjs. A rollout is a canary and then the stage "stages": each stage one AWS IoT job
on all its boards, `jobExecutionsRolloutConfig: { maximumPerMinute: 1000 }` (AWS IoT's most) with the abortConfig as
before. The schedule marks a stage done once its job has COMPLETED with its failures under `abortPercent`, and starts
the next `soakMinutes` after (also after the canary); a stage at the limit, a canary that fails, a release revoked or
a cancellation stops the rollout with its reason. Each start of a stage is a conditional write on the rollout (its
rev), and a cancellation that comes during a start cancels the new job. New body fields on `POST /api/rollouts`,
`/api/fleet/update-everything` and `/api/groups/{id}/rollback`: `stages` (1-10, default 1), `batch` (`{ unit:
"percent" | "count", sizes }`, for each stage but the last, which takes the rest) and `soakMinutes` (0-60, default 0);
`wave` is still accepted and has no effect. Refusals `invalid_stages`, `invalid_batch` and `invalid_soakMinutes`. The
stages are planned when the rollout is made (online boards first, those away in the last) and each stage's boards are
looked at again when it starts. `GET /api/rollouts/suggest?release=&group=` (viewers too): suggestPlan, one online
canary per board type with a clean update history, stages that grow (about 10 %, then three times as many, then the
rest; one stage for three boards or fewer), offline boards last, a soak time for larger groups, warnings for a group
mostly offline or a stage too small. The canary is chosen from the update history too. A rollout's detail has
`stages: [{ n, things, leftOut, job, startedAt, doneAt, state, counts, deployment }]`; the page shows a card per stage,
its counts and timing, and the steps Canary, Stage 1..N, Done. The Roll out dialog fills itself in from the
suggestion; New deployment, Update everything and the roll back take the stages and the soak time. The activity log
keeps `stages` with rollout.create and `stage` with rollout.advance. A rollout made before 2.8.0 still goes on in waves.
The phone and desktop apps show the console's own pages, so they have the same form and stage view; their refusal
words and log labels have the new ones.

## 2.6.3

Board setup fills in the Wi-Fi network from the console's defaults, which you may still change, and it has a self-check that runs every step against a simulated board, with no board plugged in. It is readier for a real board: a bigger serial buffer, lines held to the board's limits, the log port named when it is chosen by mistake. The desktop app names the console port.

The Wi-Fi defaults are the secret `<stack>/wifi-defaults` (JSON `{ ssid, passphrase, security }`), which the stack makes
empty and only the API function may read (`ReadWifiDefaults`, GetSecretValue on that one secret). `cloud/deploy.sh`
stores it from `~/.cranium/wifi_secrets.h`, as it stores the Memfault token (`store_secret_file`, now with a label), and
the deploy workflow from the repository secret `WIFI_DEFAULTS_JSON` when it is set; it is never printed. The deploy role
may store it (and the Memfault token, which it lacked) and never read it. `GET /api/setup/wifi-defaults`: release
managers only, never with an API token, never cached, on record as `setup.wifi_defaults` with whether any was given
and never which; 503 `wifi_defaults_unavailable`, 500 `wifi_defaults_invalid` for a stored network the firmware would
refuse. The page puts the values straight into the empty fields, keeps them nowhere, and the passphrase stays masked.
`POST /api/devices/register` now takes the apps' sign-in too, after a sign-in in the last 15 minutes, as any change from
the apps: the desktop app signs in with it, and its Board setup could not register a board before.

Against the firmware and MCUboot: the port opens with an 8 KiB buffer (Web Serial's default is 255 bytes, less than
KEYGEN's request); a console line over 384 bytes (CONSOLE_LINE_MAX) is refused before it is sent; recovery lines stay
within MCUboot's 128 bytes and requests within its 1024; firmware known to run is asked to restart into the bootloader
before any SMP greeting is sent to it; a port that prints but answers nothing is named as the log port. The time-outs
are constants (`TIMING`, `COMMAND_MS`), listed in docs/new-board-setup.md. **Self-check, no board** runs connect, the
golden image (sealed by hand), a release, setup and online against a simulated board and API; it reads only the
golden image from the console and changes nothing. In the Android and iPhone apps the page says why Board setup needs
a computer. Not yet run on a real board.

## 2.6.2

Developer has a new page, Board setup: plug a board in by USB and take it to online from the console, in Chrome or Edge on a computer or in the desktop app. It puts the golden image on and walks you through sealing it, puts the newest release on, and sets the board's ID, Wi-Fi network and certificate. A board with nothing on it still needs the debug probe once.

setup.js and recovery.js, fetched when the page opens. recovery.js speaks MCUboot's serial recovery as
tools/recover.py does (SMP, CBOR, base64 lines of 93 bytes behind 06 09 or 04 14; a test compares the bytes with
recover.py's) and the board's console as tools/board.py does (the echo off before every command). The steps: Connect
(STATUS: type, firmware, state, and whether a bootloader listens; nothing answering is a blank board or the other
port, and the page says the probe is needed); Golden image (`/golden/cranium-1.5.0-0.signed.bin`, checked against
firmware/golden.json, through ENTER_BOOTLOADER or Button 1, then the gesture, with the bootloader's `golden:` lines
watched on the log port, or confirmed by hand); Newest firmware (the newest active release for the board's type and
layout from `/api/firmware`, checked against its SHA-256); Set up (INIT, WIFI_SEC, KEYGEN, then
`POST /api/devices/register` with `{ id, csr, reregister }` once, the answer checked, the certificate and Amazon Root
CA 1 by STREAM_START and STREAM_CHUNK, then CLOUD); Online (`/api/devices/{thing}` until online). Each step can be
tried again or skipped; release managers only. The network's name and passphrase go to the board only: read from
their fields when sent, never in the page's state, never to the API. The web function serves the golden image at
`/golden/<file>` from `web/src/golden/`, a copy of binaries/golden/ that the tests hold to firmware/golden.json; the
Content-Security-Policy is unchanged. Set up uses the register route of 2.6.1.

## 2.6.1

A release manager can register a new board through the console, with a console token or from the website, so that setting up a board needs no sign-in to the AWS account.

`POST /api/devices/register` (and `/api/t/devices/register` with a token; handlers/provision.mjs): `{ id, csr,
reregister }` in, `{ thing, certificatePem, rootCa, endpoint, downloadPrefix }` out. The board's certificate signing
request must be an ECDSA P-256 key's, signed by that key, for CN=cranium-<id>; the board's private key never leaves
it. The console creates the thing in the stack's group, has AWS IoT issue a certificate for the request (checked to be
for that key before anything is attached), gives it the device policy and attaches it to the thing alone. A thing that
has a certificate already is refused unless `reregister` is true, which retires its old certificates, as
`provision_device.py` does. `{ id, board: "nrf5340dk" }` registers a Bluetooth-only board without a certificate.
Release managers only, never from a phone; on record as `device.register`; at most 20 an hour a person. The API role
gains only the IoT actions this takes, on `thing/cranium-*`, the device group and certificates
(aws-provision.mjs, template.yaml `RegisterBoards` to `IssueBoardCertificates`); the function is told the device
policy and the download prefix. `tools/provision_device.py` and `scripts/board/new-board.sh` use the route when there
is a console token and no AWS sign-in (docs/new-board-setup.md).
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
