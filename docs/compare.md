# Compare boards and the version timeline

From console 2.16.0. Two views for the question "why does this board behave differently from that one?": every
firmware version each board ran, and two to four boards side by side.

## The version timeline

A board's page has a **Version timeline** card: every version the board ran, newest at the top, as a vertical
timeline. For each version:

- **when** it started and ended, and how long that was; the version it runs now says "Runs now";
- **how it arrived**: over the air (a deployment, with a link to it), over Bluetooth from a phone, by USB or another
  tool, by a rollback, or before the history (by USB or at setup);
- **confirmed**, **rolled back** or **on trial**;
- the **unexpected restarts** and **issues** the board reported while on it.

**Show older versions** reads the next page.

### Where it comes from

`GET /api/devices/{thing}/timeline` (`cloud/api/src/handlers/timeline.mjs`, `lib/board-timeline.mjs`) makes it from:

| Source | What it gives |
| --- | --- |
| The board's update history (`handlers/updates.mjs`, the records `lib/last-good.mjs` reads too) | each update, how it came, kept, rolled back, not installed or pending |
| The board's shadow | the version it runs now, and whether it is confirmed |
| The releases | a release whose note begins `Rebuild of <version>` is a roll back to last good, so a version it brought arrived by rollback |
| The events table, the last 90 days, level `warn` | the counts |

The rules:

- An update kept or still on trial starts the version it brought, at the update's start.
- An update that rolled back is a short stay on the version it brought (rolled back), and the version it came from
  starts again, arrived by rollback.
- An update that was not installed changes nothing.
- The version the first update started from arrived before the history. A board starts an update only from firmware
  it has confirmed, so that version is confirmed, and so is a version on trial that a later update started from.
- A version the board runs that no update shows arriving came by USB or another tool, when is not known.

The counts: a restart event with level warn (a bad reset cause, or a restart for being stuck) is an **unexpected
restart**; any other warning (an update that failed, low memory, a Bluetooth update that went wrong, ...) is an
**issue**. Connection events are not counted. Events are kept 90 days, so a version that ended before then has no
counts ("not known"), and one that began before then is counted from then on (`countedFrom`).

### The API

```
GET /api/devices/{thing}/timeline?limit=<1-50>&cursor=<cursor>
  -> { thing, current, versions: [Stay], cursor, countedFrom, generatedAt }

Stay: { version, startedAt, endedAt, current, arrived, deployment, status, reboots, issues, countedFrom }
  arrived  ota | bluetooth | usb | rollback | setup
  status   confirmed | rolled_back | trial
```

Newest first, 20 a page unless `limit` says otherwise. A read for viewers and release managers alike, from the
website, a phone app or an API token; it goes on no record. It refuses `invalid_limit`, `invalid_cursor`,
`invalid_thing` (400) and `unknown_device` (404). A list of releases or warnings that cannot be read does not fail it:
without the releases a rebuild arrives as `ota`, and without the warnings the counts are `null`.

## Compare

`#/compare?boards=a,b` sets 2 to 4 boards side by side (`cloud/web/src/site/assets/compare.js`). Reach it:

- from the **Devices** page: tick the boards (each board has a tick box; the bar above the list says how many are
  ticked and has **Compare** and **Clear**);
- from a board's page: **Compare with…** ticks that board and opens the Devices page to pick the others.

For each board:

| Row | From | Compared |
| --- | --- | --- |
| Firmware, and whether it is on trial | the boards (`GET /api/devices`) | yes |
| State: online, offline, never connected | the boards | yes |
| Last report, uptime | the boards | no: they differ between any two boards |
| Wi-Fi signal in dBm, with its quality | the boards | by quality (Excellent, Good, Fair, Weak) |
| Unexpected restarts and issues of the last 7 days | each board's warnings (`GET /api/events?level=warn`) | yes |
| The latest key Memfault metrics (supply voltage, signal, CPU, heap, ...) | the metrics card's read (`GET /api/devices/{thing}/memfault`) | yes |

A row whose boards differ is marked on every board, with a wash and the word "differs", never colour alone. Below,
the boards' version timelines stand in parallel columns. From 48 rem wide the boards are columns; on a phone they
stack, one card each. Dark mode is the console's tokens.

The page has no route of its own: it reads the timeline route and those the console already had. The tick boxes of
the Devices page read nothing and change nothing; they are there for what will be done to many boards at once later.

## In the apps

The Compare page is in `apps/shared/pages.json`, so the iPhone, Android and desktop apps' parity tests check that each
app keeps it in its window and that its route takes the apps' sign-in. The Version timeline card is listed there as a
card of a board's page. There are no new refusal words.

## Tests

- `cloud/api/test/board-timeline.test.mjs`: order, arrival, confirmed against rolled back, rebuilds, counts, paging,
  validation and who may read it.
- `cloud/web/test/compare.test.mjs`: the address, the client, the timeline card, the Compare page and what differs,
  the Devices page's tick boxes and bar, Compare with…, and the layout on a phone.
