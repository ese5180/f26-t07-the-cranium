# Alerts

What the console tells people about, how, and how a release manager tunes it (from console 2.12.0). The fleet's side of
it, and the other alerts, are in [`fleet.md`](fleet.md#alerts).

## The rules

The console's **Alerts** page (`#/alerts`) lists the rules. Every member reads them; a release manager turns each on or
off and changes its threshold, and every change is in the activity log as `alert.rules`, with what it changed. They hold
for everybody who gets alerts.

| Rule | Goes out when | Threshold (limits) | Default |
| --- | --- | --- | --- |
| A board is offline | a board has been disconnected from AWS IoT longer than the threshold, and again when it is back | minutes (5 to 1440) | on, 15 |
| A new Memfault issue | Memfault has an issue it did not have before; one alert per board with its traces, linking to the issue | none | on |
| A crash loop | one board restarts unexpectedly (Assert, a fault, a watchdog, a stuck restart) N times in M minutes | N (2 to 20), M (5 to 1440) | on, 3 in 30 |
| A staged rollout stopped by itself | its canary failed, a stage's failures reached the limit, or its health gate failed or could not read Memfault | none | on |
| Low supply voltage | a board's `supply_mv`, from its hourly Memfault heartbeat (firmware 1.15.0), is under the threshold | mV (1000 to 6000) | on, 3000 |

These always go and have no rule: an update that failed or was rolled back, a restart for being stuck, and a board that
moved by more than 1 km.

**Repeats are held back** as before: at most one e-mail per board and kind of alert an hour. What comes in between is
folded into the next e-mail, or sent by the 5-minute check once the hour is up. The Memfault rules also keep what they
alerted for (the issues seen, the last crash loop and the last low heartbeat of each board), so the same restart or
heartbeat is never alerted twice.

## How each is checked

- **Offline**: the recorder's check every 5 minutes (`AlertCheckRule`), as before, with the rule's minutes.
- **New issue, crash loop, low voltage**: the staged rollouts' schedule (`RolloutTickFn`, every minute) looks at
  Memfault at most every 5 minutes, through the same server-side reader and cache as the console's Memfault pages
  (`cloud/api/src/aws-memfault-api.mjs`, `handlers/memfault.mjs` `watch`): one read of the issues and the processing log
  of the last two hours (or the crash loop's window, if longer), and one read of an issue's traces for each new issue, at
  most 5. Its first look only learns which issues there are. A look Memfault does not answer raises nothing and is
  tried again at the next run.
- **Rollout stopped**: when the schedule stops a rollout for one of its own reasons (`handlers/rollouts.mjs`
  `SELF_STOPS`: `canary_failed`, `aborted`, `health_failed`, `health_unknown`). The e-mail links to the rollout's page,
  and for a failed health gate the line links to the Memfault issue.

The rules are one item in the state table (pk `ALR`, sk `rules`), read by the API, the recorder and the schedule, each
only that partition (`infra/template.yaml`). A rule that is missing or out of its limits there is its default.

## How alerts reach people

- **E-mail** (Amazon SNS, the topic `AlertTopic`): to each release manager who asked for it on the Account page and
  confirmed by e-mail.
- **Every open page** of the console, the phone apps and the desktop app: an alert e-mail that went out is a live change
  (`what: "alerts"`, [`live.md`](live.md)) for the team, and the page shows it as a toast, whatever page is open. The
  apps show the console's own pages, so they get it the same way while they are open.

**What is not built: a phone notification while the app is closed.** The apps' bridge (`apps/shared/bridge.json`) has no
notification call, and neither shell has a push path. Real background push would need:

- iPhone: Apple Push Notification service, which needs a paid Apple Developer Program membership (the app is signed
  with a free Apple ID and SideStore today) for an APNs key, the Push Notifications capability in the app, and the app
  registering its device token with the console;
- Android: Firebase Cloud Messaging, with a Firebase project, its `google-services.json` in the build, and the app
  sending its token to the console;
- the console: an SNS platform application for each (or a direct sender) with those credentials, a store of the
  devices' tokens per person, and the alerter publishing to them besides the e-mail topic;
- the bridge: a call to ask for permission and hand over the token, in `bridge.json` and both shells.

None of it is set up, so nothing paid was added: the e-mail is the alert when no page is open.

## The API

- `GET /api/alerts`: as before, and `alertRules` (each rule's `on` and thresholds), `ruleLimits` and `canChangeRules`.
- `POST /api/alerts/rules`, body `{ "rules": { "<rule>": { "on": true|false, "<threshold>": n } } }`, a rule or a field
  at a time: release managers only (403 `release_manager_required`), 400 `invalid_rules` for a rule or a value that is
  not one, 409 `rules_changed` if someone changed them at the same moment.

Tests: `cloud/api/test/alert-rules.test.mjs` (each rule firing and held back, the routes and their refusals, the live
message), `cloud/api/test/health-gate.test.mjs` (the rollouts' health gate), and the Alerts page in
`cloud/web/test/map.test.mjs`.
