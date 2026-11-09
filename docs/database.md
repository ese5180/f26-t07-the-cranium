# The Database page

The console keeps its data in three DynamoDB tables (`cloud/infra/template.yaml`): **state** (releases, API tokens,
groups, staged rollouts, the phone apps' releases, SideStore links, customers' boards), **audit** (the activity log) and
**events** (what the boards did: events, readings, log lines, the update history, positions and alerts). The Database
page, under **Developer → Database** from console 2.9.0, lets a release manager look into them. It is read only: nothing
on it changes an item.

## Who may use it

Release managers only, asked of Cognito at each request, as the Customers page does. A viewer sees a page that says so
and nothing is read for them; the API refuses a viewer with `release_manager_required`, an API token with
`token_not_allowed`, and a customer's sign-in is no sign-in of the console at all. The phone and desktop apps show the
page as the website does (`apps/shared/pages.json`), with the same sign-in rules.

## What is never shown

A field that holds a credential, or something as good as one, reads `hidden`, for everybody, release managers
included, in the list, on an item's page and in an export. `cloud/api/src/lib/db.mjs` decides, with a denylist that a
test goes through (`cloud/api/test/db.test.mjs`):

- a field, at any depth, whose name (without case or punctuation) is `pin`, `psk`, `key`, `ref`, `pem`, `csr`, `cert`,
  `sig`, `otp` or `mfa`; contains `hash`, `digest`, `secret`, `password`, `passwd`, `passphrase`, `passkey`, `token`,
  `credential`, `certificate`, `private`, `signature` or `session`; or ends in `key`, `pin`, `pem`, `cert`, `csr` or
  `ref`. `id`, `tokenId` and `keyId` are ids, and shown.
- a value that is a credential whatever its field is called: an API token (`crn_…`), a SideStore key (`crs_…`), a PEM
  block, a JWT.
- an item's own key where it is a credential's digest: an API token's (`pk` TOK, its `sk` the token's SHA-256) and a
  SideStore link's (`pk` SRC, `sk` `key#<SHA-256>`). Such an item has no page of its own (its fields show in the list
  instead), and its key is never in a page cursor: a page that would end on one reads on past it.

The text filter looks in what is shown, so a hidden value cannot be found by searching for it.

## Pages, filters and what they cost

Each table is a tab with DynamoDB's own count of its items and its size. Those come from `DescribeTable`, which
DynamoDB brings up to date about every six hours: they are rough, and the page says so.

The filters are a kind of item (or an exact partition), a board, a time range and text. How they are read:

| Filter | Read |
| --- | --- |
| A kind or a partition (state: REL, TOK, GRP, …; events: positions, alerts) | a Query of that partition |
| A board, on the events table | a Query of the board's partition (`<thing>`, or `UPD#<thing>` for the update history) |
| A time range, on the audit table or on events, readings or log lines of a board | a key range of that Query |
| A board, on the state table | a Query of SEEN or OWN by the board, or a filter on `thing` and `things` |
| Nothing that names a partition | a Scan of one page, with a Limit |
| Text | looked for in the page that was read, after the read |

A page is at most 100 items read (50 by default). **Load more** reads the next page from where the last one stopped.
The page reads when it is opened, when a filter is applied and when Refresh is pressed, never by a timer, so no view of
it scans a whole table. A time range of a board in the events table needs a kind of item (events, readings or log
lines), whose time is in the key; elsewhere a time range is a filter on the item's `at`, `createdAt` or `updatedAt`.

## Export

**CSV** or **JSON** of the items of the current filters, as they are shown (hidden fields hidden), up to **10,000
items**. It also stops after 60 reads of DynamoDB, 9 seconds, or about 4 MB of text, and then says which. CSV has `pk`
and `sk` first, then every other top-level field by name; a list or a map is its JSON, and a cell that would start a
spreadsheet formula starts with `'`.

Every export goes in the activity log as **db.export**: who, the table, the format, the filters, the number of items,
and what stopped it early if anything. A refused export is there too.

On the website the file is downloaded. In an app with the bridge's `file.share` (apps/shared/bridge.json), the
iPhone and Android apps hand it to the share sheet (Save to Files, AirDrop, mail) and the desktop app to a save dialog.
An app without it shows the export buttons off and says to export from the website.

## The API

| Route | Answer |
| --- | --- |
| `GET /api/db/tables` | `{ approximate: true, exportLimit, tables: [{ name, label, about, items, bytes, kinds }] }` |
| `GET /api/db/{table}?kind=&partition=&board=&from=&to=&text=&limit=&cursor=` | `{ table, reading, partition, rows: [{ key, item }], read, cursor, stopped }` |
| `GET /api/db/{table}/item?pk=&sk=` | `{ table, key, item }`, or 404 `unknown_item` |
| `GET /api/db/{table}/export?format=csv\|json&<filters>` | `{ name, type, content, count, capped }`, on record as `db.export` |

`table` is `state`, `audit` or `events`. Parameters are checked before anything is read: `unknown_table`,
`invalid_filter`, `invalid_key`, `invalid_format`, `invalid_time`, `invalid_limit`, `invalid_cursor`.

## Permissions

The API function's role had Query on the three tables and GetItem on the state table. The page adds one statement,
`BrowseDatabase`: `dynamodb:DescribeTable` and `dynamodb:Scan` on the three tables, and nothing else. An item's page is a
Query of its exact key, so no GetItem is added. The role's Deny of every change to the audit table stays. The infra
tests (`cloud/api/test/infra.test.mjs`) hold the role to this.

## Code

- `cloud/api/src/handlers/db.mjs`: the four routes.
- `cloud/api/src/lib/db.mjs`: the tables and their kinds, the plan of a read, the denylist, cursors, CSV and JSON.
- `cloud/api/src/aws-db.mjs`: DescribeTable, Query and Scan, every name and value a placeholder.
- `cloud/web/src/site/assets/db-page.js`: the page.
- Tests: `cloud/api/test/db.test.mjs`, `cloud/web/test/db.test.mjs`, `cloud/api/test/infra.test.mjs`, and the apps'
  page parity tests.
