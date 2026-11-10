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
| Latest session, and a moment to revisit | **The board's sessions once it has sent one (console 2.23.0), else demo data or a file the customer imports** | **Sessions and tracks** (see Mixes) |
| Hours on the decks, sessions, plays, unique tracks, overlaps | **Worked out from the board's sessions, else from demo or imported ones** | Worked out from the sessions the board sends |
| Now playing | **The board's now playing message (console 2.23.0)** | A now playing message (see below) |

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
| The name shown (`name`) | **The customer's own name for it (`label`), else the label an admin gave it** | Not board data: the customer names it on the site |
| Owned since (`since`) | **The assignment record** | Not board data: it is when the board became theirs |
| Location | **Always empty** | **Remove it**, or have the board send a Wi-Fi-based location |

## Mixes: from the board once it sends sessions (console 2.23.0)

The mixes come from the sessions the board sends, as soon as it has sent one (`GET /api/c/sessions`, see "The messages"
below). Until then they come from a made-up demo, or from session files the customer imports, kept only in their
browser, and the page says which.

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

## The messages (firmware 1.18.0 and console 2.23.0)

A board publishes on `cranium/<thing>/session`, publish only, the same way as `events`, `location` and `memfault`: the
device policy lets a board publish on its own thing's topic and nowhere else. The rule `BoardSessionRule` takes the
thing name from the topic and the time from AWS IoT, and drops any message that brings `thing`, `received` or
`channel` of its own. The recorder (`cloud/api/src/lib/sessions.mjs`) holds the rest to this contract. Every message
is JSON of at most 6144 bytes with `"v": 1`; a field that is not listed, a value out of range or a text with a
control character drops the whole message (logged by reason, never by content). Times are ISO 8601 UTC with a `Z`
(`2026-11-09T21:04:00Z`) between 2024-01-01 and a day ahead. Texts are 1 to 120 characters (an artist may be empty).

A session, sent when it starts, as each track starts, and when it ends; the same `id` and `startedAt` every time:

```json
{ "v": 1, "type": "session", "id": "a1", "startedAt": "2026-11-09T21:04:00Z", "endedAt": "2026-11-09T23:10:00Z",
  "title": "Friday set",
  "tracks": [ { "title": "Strobe", "artist": "deadmau5", "playedAt": "2026-11-09T21:09:12Z", "durationS": 600 } ] }
```

`id` is 1 to 40 of `A-Z a-z 0-9 _ -`, unique per board. `endedAt` (optional) is at or after `startedAt` and at most 24
hours later. `title` and `tracks` are optional; at most 20 tracks a message, each played between the start and the end
(or 24 hours after the start while it has no end), `durationS` a whole number of 1 to 14400. The board sends only the
tracks that are new; tracks are kept by `playedAt` and session, so a track sent twice is stored once.

What is on the decks now, replaced by each message:

```json
{ "v": 1, "type": "now", "playing": true, "title": "Strobe", "artist": "deadmau5",
  "playedAt": "2026-11-09T21:09:12Z", "durationS": 600 }
{ "v": 1, "type": "now", "playing": false }
```

With `durationS`, the site shows it until the track has ended; without, for 15 minutes after the message. `session`
(optional) names the session id it belongs to.

Stored in the events table under `pk = SES#<thing>`: `S#<startedAt>#<id>` a session, `T#<playedAt>#<id>` a track,
`NOW` the now playing (kept a day; sessions and tracks 400 days). The customer API serves them for the caller's own
boards only, as sessions in the site's shape (`source: "board"`, a hashed id, no deck, BPM or key yet) and the now
playing, and the site uses them when there are any.

## What a customer can change (console 2.18.0)

These were worth adding; they exist now ([customer-site.md](customer-site.md#customer-actions)). None of them is board
data, and none changes the board itself.

| Action | Where | Kept as |
| --- | --- | --- |
| Rename a board: their own name, at most 40 characters | A board's page, "Rename" | `customerLabel` on the ownership item; the thing name and the admin's label stay |
| E-mails: a board goes offline, an update is installed, a board restarts unexpectedly; each off by default | Account page | The `PRF` item of the state table, per customer. Chosen and kept; not sent yet |
| An update waiting at a board (`awaiting_user`) | A board's page: how to accept it | Nothing: the board takes the answer from Button 1 only, so the site explains it rather than sending it |

Each change is on record in the audit table's `CUS` partition, shown in the console's activity log as done by a
customer, never with their address.

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
