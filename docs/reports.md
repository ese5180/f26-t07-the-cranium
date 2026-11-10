# The weekly fleet report

From console 2.18.0. One page per week: how the fleet did, what was sent to it, and what changed. It is made when
someone asks for it, from records the console already keeps.

## The week

A week runs from **Monday 00:00 to the next Monday 00:00 in America/New_York**, the team's time zone, whatever the
reader's clock says. A week with a change of the clocks is 167 or 169 hours long. A week is named by its Monday:
`2026-11-02`. The daily health snapshots are named by their UTC day (`docs/fleet-health.md`), and a week holds the
snapshots of its seven days by those names.

The API serves this week and the 52 weeks before it. The Reports page lists the last twelve.

## What a report holds

| Section | Made from |
| --- | --- |
| Fleet health score: each day's score, the last, the lowest, and the change since the week before | the daily `HEALTH` snapshots (`lib/fleet-score.mjs`) |
| Boards: in all, online, offline, Bluetooth only, new | the week's last snapshot; for the week under way, the boards now. New boards were registered through the console that week (`device.register`), or appear in the week's last snapshot and not in the one before the week |
| Firmware versions and how many boards ran each | the same snapshot |
| Deployments started that week, with their outcome (succeeded, some failed, failed, cancelled, under way) | AWS IoT Jobs (`handlers/deployments.mjs between`) |
| Staged rollouts started or ended that week: done, stopped, cancelled, under way. Health-gate stops and rollbacks (`rollback`, `last_good`) are counted separately | the `ROL` records |
| Updates over the air as the boards reported them: kept, failed, rolled back | the boards' update events |
| Memfault: issues first seen that week, unexpected reboots by reason | Memfault's REST API (`handlers/memfault.mjs week`) |
| The boards' own unexpected restarts, by reset cause or "stuck" | the boards' restart events at warning level |
| Alerts sent, by kind | the alerts' records, which are kept 30 days: an older week says "not known" |
| Changes: how many of each action, by how many people, and the newest | the activity log, without the reads it also records (sign-ins, downloads, exports, sightings, the schedule's steps) |

**The one new piece of data.** Before 2.18.0 no record said how many boards there were on a past day, or which
firmware they ran. The daily snapshot now also stores `fleet`: the counts, the versions and the board names
(`lib/fleet-score.mjs fleetCounts`). Weeks from before that show "not counted" for the boards and versions.

## On the console

- **Reports** (`#/reports`, in the nav for every member): the weeks, newest first, each with its last health score.
  The week under way says "so far".
- **A week** (`#/reports/2026-11-02`): the sections above, in the grouped style. It works on a phone and in dark
  mode, and the apps show it as the console's own page (`apps/shared/pages.json`).
  - **Print or save as PDF** opens the print dialog. The print stylesheet (`app.css`, `@media print`) prints the
    report alone, on white, without the bars and buttons, keeping each section on one page where it fits.
  - **Download CSV** saves the main tables in one file, `cranium-report-<week>.csv`. Each row is
    `section,item,value,detail,at`. A cell that would start a spreadsheet formula is quoted. In an app the file goes
    to its share sheet. Each download goes on record as `report.export`.

## The Monday e-mail

A release manager switches it on or off on the Reports page. It is off by default. While it is on, the schedule
(`RolloutTickFn`, `tick.mjs`) sends the summary of the week that just ended once, on Monday from 08:00 New York time,
to the existing alert topic. Everybody who gets the alerts receives it, with a link to the week's page. The send is
claimed by a conditional put (`RPT` / `mail#<week>`), so two runs never both send it. A send that fails is logged
and does not hold up the rollouts. The setting is like the alert rules: one item (`RPT` / `settings`), changed only
if nobody changed it meanwhile (`409 report_settings_changed`), and on record as `report.settings` with its value
before and after.

## API

| Route | Who | |
| --- | --- | --- |
| `GET /api/reports` | members | the weeks, the setting, whether the caller may change it |
| `GET /api/reports/{week}` | members | `{ report }`; `400 invalid_week`, `404 unknown_week` |
| `GET /api/reports/{week}/export?format=csv` | members | `{ name, type, content, rows }`, on record as `report.export`; `400 invalid_report_format` |
| `POST /api/reports/settings` `{ "email": true }` | release managers | `{ settings }`, on record as `report.settings`; `400 invalid_report_settings` |

## Kept

A report is kept in memory for 5 minutes while its week is under way, and for an hour once the week has ended. Six
hours after its week ends it is stored in the state table (`RPT` / `week#<monday>`), on the condition that keeps
the first. After that it is read from the table, so a past week reads the same for every reader and on every day.

## Permissions

The API function already reads and writes the state table and reads the activity log. The schedule's role,
`RolloutTickRole`, gains two statements:

- `WeeklyReports`: `GetItem`, `Query` and `PutItem` on the state table, for `RPT` only.
- `ReadAuditForReports`: `Query` on the activity log.

The schedule also lists the alerts sent (`ALERTS`), which it could already read.
