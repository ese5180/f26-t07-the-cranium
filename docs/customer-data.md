# What the customer sees, and what the board must send

Everything the customer site (craniumiot.com) and the phone apps' customer mode show a customer, page by page:
where each item comes from today, and what the board has to send so that it all comes from the board. The music
data takes this path: Mixxx on the Raspberry Pi, then the board (over its UART link to the Pi), then AWS, then the
customer's pages.

"Board, already" means the board sends it today. The customer API is `cloud/api/src/customer/` (routes in `app.mjs`,
fields in `boards.mjs`); the pages are `cloud/web/src/customer/assets/`; the mixes are worked out in `customer-mixes.js`.

## Overview

| Shown | Comes from today | The board must send |
| --- | --- | --- |
| Boards online out of the total | Board, already (online state) | — |
| Each board's status, firmware, last seen | Board, already | — |
| Firmware versions across their boards | Board, already | — |
| Recent activity: online/offline, updates, restarts, Bluetooth | Board, already (events) | — |
| Latest session, and a moment to revisit | **Demo data, or a file the customer imports** | **Sessions and tracks** (see Mixes) |
| Hours on the decks, sessions, plays, unique tracks, overlaps | **Worked out from demo or imported sessions** | Worked out from the sessions the board sends |

## Devices, and each device's page

| Shown | Comes from today | The board must send |
| --- | --- | --- |
| Status: online, offline, updating, restarting | Board, already | — |
| Wi-Fi signal (RSSI) | Board, already | — |
| Uptime | Board, already | — |
| Firmware version, and whether it is confirmed | Board, already | — |
| An update in progress, its percentage and result | Board, already | — |
| Last seen | Board, already (when AWS last heard from it) | — |
| Activity for the last 30 days | Board, already (events) | — |
| Health: a dot, a sentence and the week's restarts by day (also on the Overview) | Board, already (restart events with the boot diary's reset cause, firmware and update events) | — |
| The board's own name (`boardName`) | Board, already | — |
| The name shown (`name`) | **The label an admin gave it when assigning it** | Keep the admin's label, or have the board send a name |
| Owned since (`since`) | **The assignment record** | Not board data: it is when the board became theirs |
| Location | **Always empty** | **Remove it**, or have the board send a Wi-Fi-based location |

## Mixes: none of it comes from the board today

Today the mixes come from a made-up demo, or from session files the customer imports, kept only in their browser.

### What the board must send for each session

| Field | Example | Notes |
| --- | --- | --- |
| `id` | from the board | Unique per board |
| `startedAt` | 2026-11-09T21:04:00Z | The real date and time the set started |
| `endedAt` | 2026-11-09T23:10:00Z | **New:** not shown today |
| `title` | "Friday set" | Optional; else "A session" |
| `board` | the board's id | Which board played it |

### And for each track played

| Field | Example | Notes |
| --- | --- | --- |
| `title` | "Strobe" | |
| `artist` | "deadmau5" | |
| `deck` | A or B | |
| `start`, `end` | 312, 618 | Seconds from the start of the set |
| `playedAt` | 2026-11-09T21:09:12Z | **New:** the real time the song started. The page could work it out from `startedAt + start`, but the board sends it |
| `bpm` | 128 | From Mixxx |
| `key` | "8A" | From Mixxx |

### What the Mixes pages show, all worked out from those fields

| Page | Shows |
| --- | --- |
| Sessions | Each set: date, time, title, number of tracks, time on the decks |
| A session | Every track in order: the time it played, title, artist, deck, start to end, BPM, key |
| Transitions | Each track to the next: the two tracks, BPM to BPM, the overlap in seconds |
| Library | Every track: plays, time in all, its latest BPM and key, when it last played |
| Moments | Transitions the customer saved, with their own note |
| Ranges | All time, the last 7 days, the last 30 days |

## Not from the board, and why

| Shown | Comes from | Decision |
| --- | --- | --- |
| Account: name, email, password, authenticator app | The customer's sign-in account | Stays: the customer's own account, not board data |
| Moments, with the customer's notes | The customer saves them | Their own input: keep them on our servers per customer, not in the browser |
| Help, sign-in, forgot password | Static text | Stays |

## To take out once the board sends sessions

1. The demo journal: the made-up sessions, and the banners that say they are a demo.
2. Import and export of session files, and the journal kept in the browser: Import session, Export backup, the sample
   file. A CSV export of the customer's own board data may stay, as a download.
3. Each session's `source` (demo or imported).
4. Location, unless the board sends it.
5. The words that say boards do not send sessions yet, on the Mixes and Help pages.

## Board health

Each Board has a `health` object (`cloud/api/src/customer/health.mjs`):
`{ state: 'ok' | 'attention' | 'offline', summary, unexpectedRestarts7d, lastIssueAt?, updatedTo?, restarts7d }`.
It is worked out from the events table, which the customer API's role already reads, and not from Memfault, whose
token the customer function is not given. Each restart is only **expected** (an update, a power cycle, the reset
button, a restart the board was asked for) or **unexpected** (a brownout, a watchdog, a lockup or another fault, or a
restart the board made itself for being stuck). The sentences are "Running normally", "Restarted unexpectedly twice
this week", "Recovered from a problem on Tue 3 Nov", "Updated to 1.15.0 on Thu 5 Nov", "Installing an update",
"Offline since Sat 7 Nov" and "Not heard from yet"; the pages say the dates again in the reader's own time. A fault's
name, a reset cause, a coredump, a stack or a thing name is never in it. A restart that came from a fault but that the
board reports only as a software reset counts as expected: the events cannot tell the two apart, and Memfault, which
can, is for the console.

## Worth sending as well (not shown today)

- **Now playing:** the track on each deck as it plays, for a live view.
- The crossfader and volume through a transition, for a fuller transition view.
- Each track's length, and the play count from Mixxx's own library.

## For live updates in the site and the apps

The minimum: the session and track fields above, sent as each track starts, and the device fields the board already
sends. Today a live message (`{ type: "changed", boards, what, at }`, `docs/live.md`) only tells a page to read again; a
track that starts would be one more `what`.

## Never shown to a customer

The thing name, the certificate, the MAC address, the Wi-Fi channel, memory figures, the boot diary, reset causes and
fault names, coredumps and traces, job ids, error text a board wrote, deployments, and the audit log (`cloud/api/src/customer/boards.mjs`).
