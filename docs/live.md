# Live updates

From console 2.4.0 an open page hears of a change as it happens: a board that connects, disconnects,
restarts, takes or finishes an update; a release, a group or a rollout that changes; a board given to a
customer or taken back; a new entry in the activity log. The page then reads again what it shows, at once,
instead of on its next refresh. It used to wait up to 30 seconds when nothing was under way (the
[heartbeat](aws-iot.md#the-heartbeat)); now it is about a second after the table changed.

The polling stays as it was. Live updates only make a page sooner: a page whose WebSocket is down, or that
was never told where the live API is, simply polls.

## How it works

```
board report ─► IoT rule ─► recorder ─► events table ─┐
console write ─► API ─────► state, audit tables ──────┼─► streams (keys only) ─► LiveFn ─► WebSocket ─► page
                                                       │                                      │
                                                       └──────────── the page reads again through the API
```

- **A WebSocket API of its own** (`LiveApi` in `cloud/infra/template.yaml`), at the address API Gateway assigns
  it, stage `live`: a WebSocket API cannot share a custom domain name with the HTTP API. The stack output `LiveUrl`
  is its address, and the web function hands it to both sites' pages in their settings (`liveUrl`) and allows its
  origin, and nothing more, in their Content-Security-Policy (`connect-src`).
- **The tables' streams.** The state, audit and events tables each have a stream of keys only (`KEYS_ONLY`), so
  that no item's data passes through it. Three event source mappings hand the live function only what is a change
  (`cloud/api/src/lib/live.mjs` has the table):

  | Table | Keys | Told as |
  | --- | --- | --- |
  | events | pk the thing, sk `E#…`: an event of a board | `board` |
  | events | pk `UPD#<thing>`: a fact of its update history | `updates` |
  | state | pk `OWN`, sk the thing: who owns the board | `ownership` |
  | state | pk `REL`, `GRP`, `ROL`, `APP` | `releases`, `groups`, `rollouts`, `apps` |
  | audit | a new entry | `activity` |

  A board's readings every 30 s (`S#`), the lines of its console (`L#`, `K#`), the alerts' and the positions'
  parts, the tokens (`TOK`) and what DynamoDB lets expire never reach the function: the filters stop them, so they
  cost no invocation. A batch that fails is tried twice and given up after a minute.
- **One message, no data.** For each change the live function sends each open page that may hear of it
  `{ "type": "changed", "things" | "boards": [...], "what": [...], "at": "<ISO time>" }`, and nothing of a board:
  the page reads what it shows through the API, which decides what it may read, as before.
- **Who hears what.** The team (the console, at console.craniumiot.com and as the customer site's admin mode)
  hears every change, with the boards' thing names in `things`. A customer hears only of the boards they own now,
  and only `board`, `updates` and `ownership`, each board named by the id of its assignment (`boards`), as the
  customer site names it, never by its thing name. Every customer also hears that ownership changed somewhere, with
  no board named, so that a page whose board was taken away reads its list again.
- **What a page does.** The console reads its page again (`refreshNow`), unless a dialog or a file in hand would
  be in the way, and a board's page only for its own board's events; the customer site reads the Overview, Devices
  or the board's page. Changes 300 ms apart are told once. A message that comes while the page is reading makes
  it read once more when it is done. The console's "Live" mark (beside Refresh) shows while the WebSocket is open.

## Signing in to it

A browser cannot set a header on a WebSocket, and an address is no place for a token: it ends up in logs. So the
page opens it with two subprotocols, `cranium-live` and its access token:
`new WebSocket(liveUrl, ['cranium-live', accessToken])`. The token goes in the `Sec-WebSocket-Protocol` header.

A WebSocket API has no JWT authorizer, so the live function (`cloud/api/src/live-app.mjs`) checks the token itself
on `$connect` (`cloud/api/src/lib/jwt.mjs`): its RS256 signature against the pool's published keys (fetched from
`<issuer>/.well-known/jwks.json` and kept; a key id it does not know is fetched again at most every 5 minutes),
the issuer (the staff pool or the customer pool), that it is an access token, the app client (the console's or the
phone apps', the customer site's or the phone apps' of the customer pool), and its times. Then it asks Cognito,
as the API does: a member of the team must be enabled, confirmed and a viewer or a release manager; a customer
enabled and confirmed. Its answer names the subprotocol `cranium-live`, without which a browser drops the
connection. A refusal is 401 or 403; a check that could not be made is 500, and the page tries again later.

The connection is kept in `ConnectionsTable` with who it is (team or customer, and the sub) and until when: until
the token expires, two hours at most, which is as long as API Gateway keeps a WebSocket open anyway. A connection
past its time is closed at the next change, and the page connects again with its new token. A page also connects
again by itself when its token changes.

Personal API tokens (the Tokens page) do not open a WebSocket: they carry no claims to check here, and a script can
poll.

## The page's side

`cloud/web/src/site/assets/live.js`, shared by the console and the customer site. While the page is signed in and in
view it keeps the WebSocket; while it is hidden, or signed out, it closes it. After a loss it tries again after 1, 2,
5, 15, 30 and then every 60 seconds, each a little more at random, so that a team's pages do not all come back at
once, and when it is back it reads everything, since what changed meanwhile was not told. A ping,
`{"action":"ping"}`, every 5 minutes keeps API Gateway's 10-minute idle limit away; the function answers it with
nothing.

## The phone apps

The pages inside the apps ([mobile-apps.md](mobile-apps.md#the-app-shell)) have the same code, and use the live API
when the app gives them its address: `liveUrl` in `app.config`, from 0.8.1. The address comes from the app's own
configuration (`apps/config/cranium.json`, key `liveUrl`), which `apps/configure.sh` writes from the stack's `LiveUrl`
output and the Apps page's **Download the configuration** hands out (console 2.4.2). Each shell takes it only when it is
exactly `wss://<API id>.execute-api.<region>.amazonaws.com/<stage>` in the user pool's Region, and puts its origin into
both pages' policy (`{live}` in `apps/shared/bridge.json`, `policies`). It is never taken from what the console says,
such as the bundle's manifest: the pages' policy is the app's own, so that whoever could change what the web function
serves still could not widen where the pages may connect.

A page in the app connects from the bundle's origin (`cranium-app://bundle` on the iPhone,
`https://appassets.androidplatform.net` on Android). The live function does not look at the origin: the token in the
`Sec-WebSocket-Protocol` header is what counts, as in a browser. The app's pages send the phone apps' client's access
token, which the function accepts for the staff pool and, with the customer pool's phone client, for customers.

An app built from a configuration without `liveUrl` (written before console 2.4.0, or a 0.8.0 build) has pages that
poll, as before. The classic screens poll.

## Costs and limits

- **Cost.** API Gateway WebSockets cost per million messages and per million connection minutes; a page open all
  day is 1,440 connection minutes, and a change is one message per open page. For a team of four and a handful of
  customers this is cents a month. The streams cost nothing to read from Lambda, and the filters keep the readings
  every 30 s, which are most of what the events table gets, from invoking anything.
- **The fan-out reads every connection** (a Scan of `ConnectionsTable`) for each batch of changes. That is right for a
  few dozen open pages; at thousands it would want an index by audience or a fan-out of its own.
- **A token that was copied** opens a WebSocket until it expires, as it opens the API; a member removed from the
  console's groups, or a disabled account, cannot connect again, and an open connection ends with its token, at most
  an hour later. The messages say only that something changed.
- **Not shown in a test on AWS yet.** That API Gateway passes the subprotocol answer from the function on to the
  browser is what AWS documents for a Lambda proxy integration on `$connect`; that the Lambda runtime has the API
  Gateway management API's client (`@aws-sdk/client-apigatewaymanagementapi`) is what it documents for Node.js 22.
  Both are for the first deployment to confirm: the console's Live mark shows once a WebSocket is open, and
  `cloud/logs.sh live` has a line for each page that connects or is refused, and for each change told.

## Where the code is

| Part | File |
| --- | --- |
| The routes and the fan-out | `cloud/api/src/live-app.mjs`, entry `cloud/api/src/live.mjs` |
| What a change is, and who hears it | `cloud/api/src/lib/live.mjs` |
| The token check | `cloud/api/src/lib/jwt.mjs` |
| DynamoDB, the management API, Cognito | `cloud/api/src/aws-live.mjs` |
| The resources | `LiveApi`, `LiveFn`, `ConnectionsTable`, `Live*Stream` in `cloud/infra/template.yaml` |
| The page's side | `cloud/web/src/site/assets/live.js`; `app.js` and `customer.js` |
| Tests | `cloud/api/test/{jwt,live,aws-live,live-infra}.test.mjs`, `cloud/web/test/live.test.mjs`, and the live tests in `app.test.mjs`, `customer.test.mjs` and `server.test.mjs` |
