# Search and filters

From console 2.12.0 every list of the console that can grow long has the same bar above it: a search box, the
filters that suit that list, how many rows are shown of how many, and Clear. The website, the phone apps and the
desktop app show the same pages, so they all have it.

## Where, and how

| Page | Searches | Filters | Where it filters |
| --- | --- | --- | --- |
| Activity (`#/activity`) | person, target (version, board, file, token), request id | kind (firmware, deployments and rollouts, boards, sign-ins and tokens, phone apps, customers, database exports), outcome, from and to (days) | the server: `GET /api/audit` |
| Events (`#/events`) | what happened, and every line of the board log (its text and source) | board, warnings only; the kind chips, the source of the board log and the range presets are in the address too | the server: `GET /api/events`, `GET /api/events/log`, and the Console lane through `GET /api/audit` |
| A board's page | | "Events and log" opens `#/events?board=<thing>` | |
| Devices (`#/devices`) | name, thing name, version, type, groups | state (online, offline, Bluetooth only, updating), firmware version | the page |
| Firmware (`#/firmware`) | version, note, file, who uploaded it, why it was revoked, board type | active or revoked | the page |
| Deployments (`#/deployments`) | version, id, note, who made it, its boards by name or thing | under way or ended | the page |
| API tokens (`#/tokens`) | name, id | active, expired, revoked | the page |
| Customers (`#/customers`) | e-mail, name, their boards and labels | invited, active, disabled, gone | the page |
| Memfault (`#/memfault`) | issue title, number, version | the version it was last seen on | the page |

Left as they are, because they stay short or already have their own: the Fleet page's groups and rollouts (a few of
each), the Apps page (a handful of releases), the update history (its own board filter and pages), and the Database
page, whose filters came first ([database.md](database.md)).

A short list is filtered as it is drawn, every word of the search in any field, in any case
(`core.js matchesSearch`). The activity log and the events can hold far more than a page, so the server filters them,
a page at a time.

## The address

The filters are in the page's address after a `?`, so a filtered list can be bookmarked, shared or sent:
`#/events?q=wifi&board=cranium-0123456789abcdef&level=warn`, `#/activity?kind=people&outcome=denied`,
`#/devices?status=offline`. `core.js FILTERS` lists each page's names and how each value is checked; a value that is
not one of them is dropped, as if absent (`readFilters`). A change replaces the address (`history.replaceState`), so
Back leaves the page rather than undoing a filter. Opening the page without a `?` shows it unfiltered. On the Events
page a range chosen by zooming or with Custom… is the page's own and is not written into the address.

## The bar

`views.js filterBar` with `filterSelect` and `filterDay`, in the grouped style ([console-design.md](console-design.md)):
the search box, rounded, first; the filters beside it from 700 px wide, and under a **Filters** button on a phone, with
the number that are set; then "N of M shown" (for the activity log, "N of M entries read match"), and Clear while
anything narrows the list. Colours are tokens, so it follows the dark theme. The search on the server's lists is sent
400 ms after the typing stops.

## The API

All of these are part of a DynamoDB Query on the list's key, a page at a time: never a Scan.

- `GET /api/audit` takes `q` (1 to 100 characters, one line), `actions` (a comma list of the log's actions),
  `outcomes` (ok, rejected, denied, error), and `from`, `to` (ISO times). With any of them the handler Queries the
  log's partition between the two times (both kept) with a FilterExpression, and reads at most 1,000 entries a page
  (`SEARCH_BUDGET`): it answers `{ entries, next, read }`, `read` being how many it read. When it stops for the budget
  with less than a page found, `next` goes on from where it stopped. Without any, the answer is what it always was.
  Each entry that recorded what it changed carries `changes`, shown as a diff on any page of the log, searched or
  not (docs/audit-diff.md).
- `GET /api/events` and `GET /api/events/log` take `q` and `level` (`warn` or `info`) beside their board, kinds,
  sources and range, in the same Query of each board's range of keys, with the same pages and cursors.
- `q` is found in the target, the e-mail and the request id of an entry, and in the text, what and source of an event
  or a line. DynamoDB's `contains` tells capitals from small letters, so the search looks for the text as written,
  all small, all capitals and with a capital first letter (`validate.mjs searchSpellings`).
- A bad value is refused with 400: `invalid_search`, `invalid_level`, `invalid_actions`, `invalid_outcomes`,
  `invalid_time`, `invalid_range`. Each has its words in core.js `REFUSAL_WORDS` and in the phone apps' lists.

Tests: `cloud/api/test/search-filters.test.mjs` and the `searchAudit` and `queryEvents` cases of `aws.test.mjs`;
`cloud/web/test/search-filters.test.mjs`, and the filter cases of `app.test.mjs` and `telemetry.test.mjs`.
