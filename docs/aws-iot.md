# Firmware updates through AWS IoT

How the Cranium boards, AWS IoT and the firmware console work together. Account-specific
values (account ID, endpoints, bucket and pool names) are never written here or anywhere
else in the repository: `cloud/deploy.sh` stores them in the ignored `cloud/.deploy/`.

```
                    signed image (HTTPS)                        HTTPS GET, signed link (10 min)
  release manager ─────────────────────▶ firmware console ──▶ S3 ◀──────────────────────────┐
        browser         sign-in: Cognito   API Gateway + Lambda                              │
                        password + TOTP          │ creates a job                             │
                                                 ▼                                           │
                                           AWS IoT Core ◀── MQTT, mutual TLS ──▶ nRF7002 DK ─┘
                                           jobs · shadows · thing registry          Wi-Fi
```

## What is deployed

Two CloudFormation stacks, `cranium-ota-bootstrap` and `cranium-ota`
(`cloud/infra/`), plus `cranium-budget` for the cost alert. `cloud/trail.sh` adds a separate
stack, `cranium-trail`, with a CloudTrail record of management events.

| Resource | Purpose |
| --- | --- |
| IoT thing group `cranium-devices` | The fleet. The console lists and deploys to its members only. |
| IoT policy `cranium-device` | What a board may do (below). Attached to each board's certificate. |
| IoT jobs `cranium-…` | One job per deployment. AWS IoT is the only record of a deployment. The hardware bench also creates `cranium-bench-…` jobs, which the console's deployment list leaves out and a revocation does not cancel. |
| S3 bucket | Firmware images, stored once under their SHA-256. Private, versioned, write-once. The bench also stores test images here, including damaged and wrongly signed ones. Boards refuse those. |
| IAM role for signing links | Lets AWS IoT Jobs (and nothing else) create a download link for an image. |
| DynamoDB tables | The list of releases, the audit log, and the boards' event log. The API's role may put and query audit entries, and nothing else; it may only query the event log. What that does and does not guarantee is under [Security decisions](#security-decisions). |
| IoT rules and the recorder | Two AWS IoT rules hand each shadow report and each connection to a small Lambda function that writes the boards' events: [The event log](#the-event-log). |
| Cognito user pool | Console accounts: created by an administrator, password plus authenticator app. A small Lambda function, the sign-in trigger, gives the console's own sign-in page its scope: [Sign-in](#sign-in). |
| HTTP API and two Lambda functions | The console and the public home page: one function serves the pages, one is the console's API. A third function, the recorder, has no route, and neither has the sign-in trigger, which only Cognito calls. |
| CloudWatch log groups | API access log, function logs, AWS IoT logs. |

## A board's identity

Each board is one *thing* named `cranium-<16 hex digits>`, derived from the nRF5340's
hardware ID, with one X.509 certificate of its own.

Setting up a blank board, from flashing to online, is in [`new-board-setup.md`](new-board-setup.md).

`python3 tools/provision_device.py` does the following over the board's serial console (firmware
1.3.0 or later, see [`firmware/README.md`](../firmware/README.md#serial-console)):

1. Sets the device ID of a board in factory mode (`INIT`), then sends the Wi-Fi network
   from `~/.cranium/wifi_secrets.h`. The board stores it in TF-M.
2. Asks the board to create a P-256 key pair. The private key is generated on the board
   and stays there; the board prints a certificate signing request.
3. Registers the board in AWS IoT:
   `create-thing`, `add-thing-to-thing-group`, `create-certificate-from-csr`,
   `attach-policy`, and `attach-thing-principal` with `EXCLUSIVE_THING`, so the
   certificate cannot be attached to a second thing.
4. Loads the certificate and Amazon Root CA 1 into the board (TF-M Protected Storage),
   and tells it the AWS IoT endpoint and the one URL prefix it may download from.

Nothing account-specific and no credential is compiled into the firmware, so the image
in S3 and in the board's external flash holds no secrets.

To retire a certificate (lost or stolen board):

```sh
aws iot update-certificate --certificate-id <id> --new-status INACTIVE
aws iot detach-thing-principal --thing-name <thing> --principal <certificate arn>
```

Provisioning the board again with `--new-identity` creates a new key pair and
certificate and retires the old one.

## What a board may do

The policy uses the thing name of the connecting client, so a certificate only works for
its own thing and its own topics. `T` stands for that thing name.

| Action | Resource |
| --- | --- |
| Connect | client ID `T`, and only while the certificate is attached to thing `T` |
| Publish | `$aws/things/T/shadow/update`, `$aws/things/T/jobs/$next/get`, `$aws/things/T/jobs/<job>/update` |
| Subscribe, receive | `$aws/things/T/jobs/notify-next`, `$aws/things/T/jobs/$next/get/*`, `$aws/things/T/jobs/<job>/update/*` |

A board cannot read or write another board's shadow or jobs, cannot publish to any other
topic, and has no last-will message.

## Shadow: what the console shows about a board

The board writes its state to its classic shadow when something changes and, as its heartbeat, every
30 seconds (`CONFIG_APP_SHADOW_INTERVAL_SECONDS`):

```json
{ "state": { "reported": {
    "fw":   { "version": "1.0.1+0", "confirmed": true },
    "ota":  { "state": "idle", "job": null, "progress": 0, "last": "succeeded", "error": "" },
    "wifi": { "rssi": -52 },
    "stuck": { "count": 0, "reason": "none" },
    "uptime": 1234 } } }
```

`stuck` is there from firmware 1.7.2 on: how many restarts in a row [the board's timers](../firmware/README.md#when-the-board-is-stuck)
have come to, and the last reason. The Diagnostics page shows it.

`ota.state` is `idle`, `awaiting_user`, `downloading`, `verifying`, `rebooting` or
`testing`. A build for firmware update over Bluetooth can also report `bluetooth`. Everything in a shadow
comes from the board, so the console validates each field before showing it and never bases a decision on it.

Beside the heartbeat a board sends reports of their own, each into the same shadow: its boot diary (`diary`,
from 1.7.4, when it reaches the cloud), the record of its last update over Bluetooth (`bt`, from 1.9.0, when it
connects), and its diagnostics (`diag`, from 1.10.0, when it reaches the cloud and every 5 minutes: the Wi-Fi
address and channel, and the free heap). [`firmware/README.md`](../firmware/README.md#boot-diary) gives their
shapes. The API reads each field by field (`cloud/api/src/lib/shadow.mjs`) and the Diagnostics page shows them.
From firmware 1.11.4 the diagnostics also carry the board's own name, `diag.id`: the device ID a person set at its serial
console (`INIT|<id>`, `SET_ID|<id>`, 1 to 32 letters and digits). The API passes a valid one on as `name` beside `thing`,
and the console shows it first wherever it shows a board. The thing name stays the board's identity in AWS IoT, in
every URL, deployment and log entry; older firmware sends no `id`, and the console then shows the thing name alone.
While a phone is pairing, the shadow also holds the pairing passkey (`btpair`); only the pairing route reads it.

### The heartbeat

This report is the heartbeat. There is no second message, and no last will: the device policy allows a board to
publish to its own shadow and jobs topics only, and a connection that announces any other topic is refused. AWS IoT
stamps the time at which it received `uptime`, and a board is online when that is less than 90 seconds ago
(`ONLINE_WINDOW_MS` in `cloud/api/src/lib/shadow.mjs`). A board that dies counts as offline in the API after 90
seconds. A page that is open can take about 125 seconds to show it: the API keeps a shadow for 5 seconds, and a page
with nothing under way asks every 30 seconds. A board on the golden image, which reports every 60 seconds, stays online
with one report that is late, and counts as offline from 90 seconds until its next report if one is lost.

A board that last said `rebooting` gets 240 seconds (`RESTART_WINDOW_MS`), because a real restart takes longer than
90 seconds: about 21 seconds to the reset, 81 for the swap, and the first report of the image about 113 seconds after
the last report. The page keeps saying Restarting and keeps asking every 3 seconds. So a board that dies in that state
says Restarting for up to 240 seconds. The API sends the
flag and the time, and the page shows them, as `Online, heartbeat 6 s ago` or `Offline, last heartbeat 3 min ago`,
without working out the flag again.

A heartbeat costs 2,880 messages a day per board.

Nothing else goes out with it, and nothing comes back: the board subscribes to its jobs topics only, so it gets no
`update/accepted` for it. It goes out from the main loop on the MQTT connection, which a download does not use: a
download has a thread and a TLS connection of its own. While a download runs, the same report also goes out at every
10% of it, and that starts the 30 seconds over. Jobs have their own messages, which do not depend on it.

## An update, message by message

An example job document:

```json
{ "op": "fw_update", "v": 1,
  "fw": { "version": "1.0.1+0", "size": 768066, "sha256": "<64 hex digits>",
          "url": "${aws:iot:s3-presigned-url-v2:https://s3.<region>.amazonaws.com/<bucket>/firmware/<sha256>.bin}" } }
```

AWS IoT replaces the placeholder with a signed link each time the board asks for the
document, so a link is never stored and is valid for 10 minutes only.

| Step | Board | Job execution | Shadow `ota.state` |
| --- | --- | --- | --- |
| Deployment created | gets `notify-next`, asks for `$next` | `QUEUED` | `idle` |
| A check failed: known format, strictly newer version, fits the slot, allowed URL prefix | reports the refusal | `REJECTED`, `reason` | `idle` |
| Document checked | announces the start at once, with the link that came with it, and waits for AWS IoT to accept | `IN_PROGRESS`, `step=downloading` | `downloading` |
| Download over HTTPS into the secondary slot | | | `downloading`, `progress` |
| SHA-256 and signed header checked | announces the installation, waits for AWS IoT to accept | `IN_PROGRESS`, `step=rebooting` | `verifying`, then `rebooting` |
| 20 seconds later | fetches the job once more; goes on only if it is still in progress | | `rebooting` |
| Reset: MCUboot verifies the signature and swaps | | | |
| New image running on trial | reconnects to AWS IoT, confirms itself | `SUCCEEDED`, `running` | `testing`, then `idle` |
| Not confirmed within 5 minutes, or the watchdog fires (120 seconds) | reset, MCUboot swaps back, old image reports | `FAILED`, `reason=rolled_back` | `idle` |

That is firmware from 1.7.2 on. Firmware before it, the golden image 1.5.0 among it, and a build with
`CONFIG_APP_OTA_REQUIRE_USER_CONSENT` wait for a button once the document has been checked: the execution stays `QUEUED`
and the shadow says `awaiting_user`. Button 2 declines (`REJECTED`, `reason=declined`). Button 1 asks for the document
again, for a fresh link, and goes on with the start as above.

An update that has not reached a board yet is withdrawn by cancelling its deployment, and on a board that
waits for a button so is one on offer. Because the board waits for AWS IoT to accept both
announcements, an update that is cancelled, or whose release is revoked, after the
button press is dropped before it is installed.

AWS IoT applies a forced cancellation a few seconds after it is requested (5 to 15
seconds, measured), and still accepts a board's announcements until then. That is why
the board waits 20 seconds after its second announcement and looks at the job once
more. Only then does it ask the bootloader for the swap, so a reset during the wait
installs nothing.

Failure reasons a board can report: `download_failed`, `digest_mismatch`,
`header_mismatch`, `flash_error`, `interrupted`, `rolled_back`, `not_installed`, `trial_lost`. The last
means that the board runs the update's version with nothing proving it and nothing to revert to: a
golden image restore cut off at its start can leave that, as can a serial upload of the same version.
Refusal reasons: `bad_document`, `unsupported`, `url_not_allowed`, `not_newer`,
`too_large`, `declined`.

### The download link

Measured on the deployed setup: the link has the form
`https://<bucket>.s3.<region>.amazonaws.com/firmware/<sha256>.bin?X-Amz-…`, is about
1,200 characters long (the board accepts up to 2,047 after the host name) and the whole
jobs message is about 1.6 kB (the board's buffer is 4 kB). The board only downloads from
the provisioned prefix `https://<bucket>.s3.<region>.amazonaws.com/firmware/`, over TLS
verified against Amazon Root CA 1, using a credential slot that holds no client key.

### Two TLS sessions at once

The MQTT connection stays up during a download, so that a cancellation still arrives. That
makes two TLS sessions on one Mbed TLS heap of 81,920 bytes. The second handshake first
failed with Mbed TLS error -141, which looked like a certificate problem. It was the heap
running out: the two sessions peaked at 86,192 bytes. Each session took 16 KB record buffers
in both directions. Setting `CONFIG_MBEDTLS_SSL_OUT_CONTENT_LEN=4096` brought the peak to
61,616 bytes. What comes in must still fit 16 KB, because neither S3 nor AWS IoT can be asked
to send shorter records.

## The console

The console is at https://console.craniumiot.com. The public home page, which signs nobody in, is at
https://craniumiot.com. Sign-in is through Cognito: accounts are created by an administrator, and every
account needs a password of at least 12 characters and a code from an authenticator app. A temporary
password works for 3 days. A session lasts 60 minutes. The console keeps no refresh token, so it then
asks for the password and the code again. *Viewers* can look; *release managers* can upload, deploy,
cancel and revoke. [`cloud/README.md`](../cloud/README.md#add-users) has the details.

### Sign-in

**What a person sees.** The console signs people in on a page of its own, in its own design. First
the e-mail address and the password. Then the code from the authenticator app, in six boxes: a typed
digit moves to the next box, Backspace in an empty box goes back and clears that one, the arrow keys
move, and a code that is pasted or filled in by the browser or phone, as `123456` or `123 456`, fills
all six from any box. The sixth digit sends the code by itself, once. A wrong code clears the boxes,
puts the cursor in the first one and says so. Each box is labelled for a screen reader ("Digit 1 of
6"), the six are one labelled group, and every message is announced. The page is the default whenever
the tab has no session: on opening the console, a minute before a session ends, after a sign-out and
when the API turns a token away. It asks in place, so the address stays and so does a firmware file
that was chosen and not yet sent.

**How it signs in.** The browser calls Cognito's user pool API directly
(`https://cognito-idp.<Region>.amazonaws.com/`, JSON with an `x-amz-target` header): `InitiateAuth`
with `USER_SRP_AUTH`, then `RespondToAuthChallenge` with `PASSWORD_VERIFIER`, then with
`SOFTWARE_TOKEN_MFA` and the code. SRP lets the browser prove that it knows the password without
sending it; Cognito keeps only a verifier. Cognito's variant of SRP-6a is written out in
`cloud/web/src/site/assets/core.js` with `BigInt` and WebCrypto, with no AWS SDK and no library, since
the page's content security policy allows no outside script. The details (the 3072-bit prime of RFC
3526 with g = 2, numbers hashed as Java writes them, k = H(N | g), u = H(A | B),
x = H(salt | H(pool | user | ":" | password)), a 16-byte HKDF key with the info "Caldera Derived Key",
the claim an HMAC over pool, user, secret block and a time written `Mon Nov 2 03:04:05 UTC 2026`)
were taken from Cognito's own JavaScript library (amazon-cognito-identity-js) and checked against
pycognito. The tests (`cloud/web/test/signin.test.mjs`) play Cognito's side of the exchange with a
server written apart from the console's code, with Node's crypto and Node's copy of the prime, and
check every step, including fixed values for the time format, the padding and HKDF. The app client
allows `USER_SRP_AUTH` and not `USER_PASSWORD_AUTH`, which would send the password.

The password is read from its field when the form is sent, and the field is emptied at once. It is
used to make the proof and is then dropped: it is not kept in the page's state, in storage or in a
log, and it is never sent. The fields have no `name`, and the policy's `form-action 'none'` keeps the
form from going anywhere. Cognito's session for the step of the code is kept in memory only. The
result is the same session as before: the access token and when it ends, in `sessionStorage` for the
tab, and the refresh token revoked at once at `/oauth2/revoke`. The page config carries the user pool
ID and the address of the user pool API, both public, and `connect-src` allows exactly that address
next to the login pages.

**The sign-in trigger.** A token made through the user pool API carries one scope,
`aws.cognito.signin.user.admin`, and not `cranium/console`, which every API route demands. A Cognito
pre token generation trigger, event version 2 (`SignInScopeFn`, `cloud/api/src/signin-scope.mjs`),
fixes that for the console's web client only, and only at the end of such a sign-in
(`TokenGeneration_Authentication`) or at a refresh (`TokenGeneration_RefreshTokens`): it adds
`cranium/console` and takes `aws.cognito.signin.user.admin` out, so the token cannot be used to read
or change the account through Cognito's user APIs. That is exactly what the managed login pages give
the same person. Their tokens, the phone apps' client and every other step pass through unchanged, and
the groups go back as they came. The function calls nothing; its role may only write its own log, and
only Cognito, for this user pool in this account, may invoke it. The pool names it by ARN, with a
fixed function name, because the function is told the client's ID and the client belongs to the pool.

**The AWS sign-in page stays.** Both steps offer "Use the AWS sign-in page", which is the managed login
flow as before (OAuth 2.0 code with PKCE, `prompt=login`). The console goes there by itself for what
its page does not do: a first sign-in that sets a new password, setting up an authenticator app, a
password that must be reset, any other challenge, and "Forgot your password?". This pool lets only an
administrator reset a password (`cloud/users.sh reset-mfa`), so the AWS page cannot do more for a
forgotten one than this page; whether it offers a reset at all with that setting has not been tried.

**In words.** A wrong password and an address that has no account get the same message, "The e-mail
address or password is wrong." Others: a wrong code, a sign-in that took too long (it starts again at
the password), too many tries, a lost connection. Cognito's own messages are never shown.

**What was weighed.** `USER_PASSWORD_AUTH` would have been a few lines, and sends the password to
Cognito in the request; SRP keeps it in the browser, at the price of writing Cognito's SRP by hand. The
scope is added for the console's client alone, because a trigger that added it for any client would
open the API to every client of the pool that can sign in through the API. The admin scope is taken
out, because the console never needs it and a token without it is worth less to a thief. The managed
login pages stay, for the steps above and as a way in if this page fails.

**What only a deployment shows.** All of this has run against the stand-in and in the local preview,
not against Cognito. Still to see with a real account: that Cognito accepts the claim; that the token
from the console's page carries `cranium/console`, not the admin scope, and still has the groups; that
the user pool API answers the browser across origins; that `/oauth2/revoke` revokes a refresh token
made this way; how Cognito answers repeated wrong codes; and that the managed login pages and the phone
apps sign in as before. While the trigger cannot be called nobody gets a token, by either page or app:
on the first deployment with it, for the moments between the update of the pool and the creation of the
function. `cloud/logs.sh signin` shows its invocations.

- **Upload.** The console accepts only an MCUboot image whose SHA-256 and ECDSA P-256
  signature verify against this project's public key, built for this product's flash
  layout, with a version higher than every release registered before. It holds the
  public key only: it can check a signature but never create one.
- **Deploy.** Pick a release and boards. A board with an unfinished update is not offered
  another one.
- **Cancel.** Withdraws the offer from boards that have not started. With *force*, boards
  that already started stop before installing.
- **Revoke.** Marks a release as bad: no new deployments, running deployments of it are
  cancelled, and its file is tagged so that S3 refuses every download, including links
  that were already issued.
- **Activity.** Every upload, deployment, cancellation and revocation that reaches the API
  function, with the person it names and whether it was allowed, and every API token made or
  revoked. A change made with an API token names the token's owner and the token's ID. Entries
  made by `scripts/ota.sh` with AWS credentials, or by the test bench, name the release manager they
  act for, not a signed-in session. Their request IDs start with `bench-`. Actions taken directly in
  AWS, such as the AWS CLI stop in `cloud/README.md`, the bench's own jobs or anything an
  administrator does, do not pass through the API and are not listed here.

### API tokens

A personal API token lets a script, such as `scripts/ota.sh` or an assistant that runs it for you,
use the console's API as you without signing in. Every member, viewer or release manager, makes and
revokes their own on the console, under **Developer > API tokens**, and sees only their own.

- **Making one.** Choose **New token**, give it a name (1 to 40 characters) and a lifetime of 1 to
  90 days (30 unless you choose). The token, `crn_` and 43 characters, is shown once, with a copy
  button. The console keeps only its SHA-256, so it cannot show it again. A person has at most 10
  tokens that still work.
- **Keeping it.** Treat it like a password. `scripts/ota.sh` reads it from `CRANIUM_TOKEN` or from
  `~/.cranium/console-token`, a file of your own with mode 600, and refuses any other file
  ([scripts/README.md](../scripts/README.md#otash-with-an-api-token)).
- **Using it.** A request to `/api/t/<path>` with `Authorization: Bearer crn_…` is the request to
  `/api/<path>`: `GET /api/t/firmware` lists releases, `POST /api/t/deployments` deploys, and
  `GET /api/t/me` says whose token it is and whether it may write. These two routes have no authorizer
  at the gateway; the API function looks the token up by its digest and refuses one that is unknown,
  revoked or expired with `401 invalid_token`.
- **What it may do.** What its owner may do at that moment. On every request the function asks
  Cognito whether the owner is active and in which groups, so a person who is demoted, disabled or
  removed takes the power of their tokens with them at once. A viewer's token only reads. A token
  cannot make or revoke tokens, and cannot read a board's Bluetooth passkey.
- **Revoking it.** **Revoke** next to the token, then confirm in the dialog. It is refused from the
  next request on. Revoking only marks the token; nothing is deleted.
- **On record.** Making and revoking a token are entries in the activity log (`token.create`,
  `token.revoke`), and a change made with a token carries the token's ID. A request whose token
  names nobody (missing, malformed, unknown, revoked or expired) leaves no entry, as a request the
  gateway's authorizer refuses leaves none: whoever holds a revoked or expired token cannot fill the
  log in its owner's name. The function log has a line for it all the same, with the token's ID and,
  for a revoked or expired one, `tokenState`. The function log names a token by its ID only; neither
  the token nor its digest is ever logged.

## The event log

The console's **Events** page shows what every board did, over time, and **Diagnostics** how each board is now.
Both read an event log that AWS IoT feeds as the boards report.

```
  board ── shadow report ──▶ AWS IoT ── rule: $aws/things/+/shadow/update/documents ──┐
        ── MQTT connect / disconnect ──▶ AWS IoT ── rule: $aws/events/presence/+/+ ───┤
                                                                                      ▼
            console API ◀── Query ── DynamoDB events table ◀── PutItem ── recorder (Lambda)
```

**How.** After each report AWS IoT publishes the board's shadow before and after it on
`$aws/things/<thing>/shadow/update/documents`, and when a client connects or disconnects it publishes a presence
message on `$aws/events/presence/<connected|disconnected>/<client id>`. A board's client ID is its thing name. Two
topic rules (`ShadowEventsRule`, `PresenceEventsRule` in `cloud/infra/template.yaml`) pass these on, for things named
`cranium-…` only, to the recorder (`EventsFn`, the API's code with the entry point `cloud/api/src/events.mjs`), which
AWS IoT invokes without waiting. The recorder compares the two shadows and writes one item for each change
(`cloud/api/src/lib/events.mjs`). Its role may write to its log group and put items in the events table, and nothing
else. A message that cannot be written is tried once more and dropped after an hour.

**What is recorded.** Each event has a kind, a short sentence and a few typed fields:

| Kind | Events |
| --- | --- |
| `connection` | Connected; disconnected, with AWS IoT's reason (`CONNECTION_LOST`, `MQTT_KEEP_ALIVE_TIMEOUT`, ...) |
| `firmware` | The version changed (and whether it is on trial); a version on trial was confirmed; the first version a board reported |
| `update` | Each step of an update, with its deployment and the progress at that step; how it ended (`succeeded`, `failed`, `rolled_back`, `declined`, `refused`, `cancelled`, with the board's error code) |
| `restart` | The uptime went down; the boot diary grew, with why the boot before ended (reset cause) and how far that one got; the board restarted itself for being stuck, with the timer that fired |
| `bluetooth` | The Bluetooth window opened or closed; the Bluetooth update record changed |
| `health` | The Wi-Fi channel changed; the free heap fell below 15% of the heap at least once (once per boot); the board reported its name (`diag.id`) for the first time, or a different one |

Failed, rolled back and refused updates, a restart by the watchdog, a brownout or a lockup, a restart for being stuck,
a Bluetooth update that did not stay, and memory that ran low are marked as warnings. Every report is also one
*sample*: the signal, the uptime and, from firmware 1.10.0, the free heap and its lowest since the board started. The
Diagnostics page draws the last 24 hours of them. The Events page adds the console's activity log as a lane of its
own, from `GET /api/audit`.

**Kept.** Items are keyed by board and time (`E#<time>#<random>` for an event, `S#<time>` for a sample). Events are
kept 90 days and samples 7: each item carries its expiry in `ttl`, and DynamoDB deletes it some time after that,
usually within a few days; the API leaves out what has expired meanwhile. Point-in-time recovery and deletion
protection are on, as for the other tables, and `cloud/teardown.sh` removes the table with the rest. The time of an
event is the one AWS IoT stamped on the message, to the second.

**Never stored.** The pairing passkey (`btpair`) is never read by the recorder. Of a presence message only the client
ID, the time, connected or disconnected and the reason are kept: never the IP address, the certificate's principal or
the session. No shadow is stored whole: only what the table above names, after the same field-by-field checks as the
console's own reads. The recorder's log names the board and the kinds it recorded, never what the board said.

**Read.** Two read routes, for viewers and release managers alike (also with an API token), which go on no record:

- `GET /api/events?from=<ISO>&to=<ISO>&thing=<name>&kinds=<a,b>&cursor=<cursor>` lists events newest first, at most
  500 a page and 31 days at a time, for one board or every board of the group.
- `GET /api/devices/<thing>/samples?hours=<1-168>` gives a board's samples oldest first, merged into at most 600
  points: the mean signal, the last uptime and the lowest heap of each stretch.

**Cost.** A board on 1.10.0 sends about 3,200 shadow reports a day (the heartbeat every 30 s, diagnostics every
5 minutes, and the rest), so each rule, each invocation of the recorder and each sample written comes to about
100,000 a month per board. At the prices AWS publishes for rules, Lambda and on-demand DynamoDB that is of the order of
10 to 20 US cents a month per board, and the table holds a few megabytes. The Events page asks every 15 seconds while
its range ends now, one query per board; the Diagnostics page asks for each board's last day of samples once a minute
while it is open. Check the bill once boards report through the rules.

**What has been checked, and what only a deployment can.** The rule SQL, the document and presence shapes and the
fact that AWS IoT publishes presence messages without being asked come from AWS's documentation and have been tested
only against the stand-in in `cloud/api/test/fake-aws.mjs`. After a deployment, `cloud/logs.sh events` should show one
`recorded` line per report of a board, and a `connection` event should appear on the Events page when a board
restarts.

## The Raspberry Pi (planned)

Only the nRF boards are updated today. The Raspberry Pi is to use the same thing
registry, device policy, jobs and bucket. It needs three additions:

- a job document of its own (`pi_update`);
- its own thing group and release list, so that the console never offers one board's
  image to the other;
- an upload that goes straight to S3, because a Pi bundle is hundreds of megabytes and the
  console's API takes at most 1.4 MB.

The design is in [raspberry-pi-ota.md](raspberry-pi-ota.md#decision).

## Operating it

```sh
aws login --profile cranium                     # browser sign-in, up to 12 hours
export AWS_PROFILE=cranium AWS_REGION=us-east-1

scripts/open-console.sh                         # sign in, deploy if needed, open the console
cloud/deploy.sh                                 # create or update the stacks
cloud/users.sh add <email> release-manager      # the person gets an invitation by e-mail
cloud/smoke.sh                                  # checks that do not need a sign-in

python3 tools/secrets.py wifi                   # once per machine, see secrets/README.md
python3 tools/provision_device.py               # once per board
```

A session can end sooner than that: one on 2026-11-01 ended after about 2 hours and 20 minutes. A long
bench run that needs AWS stops when it does.

Releasing an update:

1. Raise the version in `firmware/app/VERSION` and build. The build signs the image with
   the key in `~/.cranium/` and stores it in `binaries/`.
2. In the console, upload `binaries/latest.signed.bin`.
3. Deploy it. A board on 1.7.2 or newer installs it as soon as it sees it. A board on older firmware, the golden image
   among it, waits until someone presses Button 1 on it.

`scripts/ota.sh` does steps 2 and 3 for one board and follows the update to the end. With an
[API token](#api-tokens) it goes through API Gateway to `/api/t/`, as the token's owner, and needs no
AWS credentials. Without one, it invokes the API function directly, which bypasses API Gateway and
sign-in (see [Known limits](#known-limits)).

After a new signing key, run `cloud/deploy.sh --replace-signing-key`, so that the console
trusts its public half. `secrets/README.md` covers the rest.

`cloud/logs.sh api|web|events|signin|access|iot` follows the logs. `cloud/teardown.sh` removes the console and
what it stored. It leaves the budget stack, the `cranium-trail` stack with its log files, and the
log group `AWSIotLogsV2`.

## Security decisions

| Rule from the lectures | How it is met |
| --- | --- |
| Signed firmware; devices hold only the public key | MCUboot verifies ECDSA P-256 over SHA-256 on every boot and before every swap. The console repeats the check on upload. |
| Signing kept away from the online server | The console is verify-only. A break-in there cannot produce firmware that a board accepts. |
| Unique identity per device; keys generated on the device | One certificate per thing; the private key is generated in the board and never leaves it. |
| One key, one mission | Separate keys for firmware signing, device identity and storage encryption. The download connection uses a credential slot without the device key. |
| Keys isolated from application software | Partly met. Device credentials are in TF-M Protected Storage, encrypted with a key derived from the hardware unique key, and never in the image. TLS and signing run through PSA Crypto in the secure world. That is encryption at rest, not isolation: the TLS stack reads the device key into non-secure memory at each connection (see [Known limits](#known-limits)). |
| TLS everywhere, forward secrecy, authenticated encryption | MQTT with mutual TLS on port 8883 and HTTPS for the download. The firmware offers only ECDHE suites, so every session has forward secrecy. It sets no narrower list, so it also offers CCM and CBC suites next to AES-GCM, and the server chooses (see [Known limits](#known-limits)). The bucket refuses plain HTTP. |
| Least privilege | Met for the boards and the console. The device policy is limited to the board's own topics. The console's roles have no delete, publish, signing or certificate rights. Not met for the operator: deployment and the bench run as the AWS root user (see [Known limits](#known-limits)). |
| Secure update: safe failure, no rollback to old firmware | Partly met. Over the air: trial boot with automatic revert; version checks in the console and the application, and in MCUboot for a test or permanent swap; an update begins only when a release manager deploys it. A revert skips MCUboot's check, and code in the application can forge one. Serial recovery has no version check and no trial, and a golden image restore goes back to the frozen image on purpose (see [Known limits](#known-limits)). |
| No default or shared passwords, two-factor sign-in | Administrator-created accounts with a temporary password and a required authenticator code. |
| Log security-relevant actions, never secrets | An audit entry for every attempted change that reaches the API function. A request that API Gateway's token check refuses appears only in the access log. An entry that cannot be stored is lost, and if the change itself succeeded the caller gets `audit_failed`. IAM lets the API's role only put and query entries, so it cannot delete or update one. A put could still replace an entry with the same key, and IAM cannot forbid that: the code sends a condition on every put that refuses it. To notice a rewrite, the function logs a digest of each entry, which the role cannot change, and `cloud/api/verify-audit.mjs` compares the two for the 90 days the log keeps its lines. Access log without query strings; no tokens, links or request bodies in any log. An API token is stored as its SHA-256 only, and logged by its ID only. |
| Only the servers a device needs | The board talks to its AWS IoT endpoint and downloads from one bucket prefix. |

### Known limits

Stated plainly. What has been measured, and on which firmware, is in the
[test results](test-results.md), and so is
[whether the over-the-air regression on the final firmware has run](test-results.md#over-the-air-on-the-final-firmware).

- The board speaks TLS 1.2; TLS 1.3 is not enabled in this build.
- MCUboot's image encryption is off, so images are stored in the clear in external flash. S3
  encrypts them at rest, but anyone with a download link gets the plain image. An image contains
  no secrets, but it can be copied by someone who holds the board.
- The signing key is a file on the release builder's machine, and every build uses it, including
  test images with a fault built in. The disk is encrypted (FileVault), which protects a machine
  that is off, not a running one. Moving the key into AWS KMS
  (sign with `imgtool --vector-to-sign`, `aws kms sign`, `imgtool --fix-sig`) would mean
  no person holds it at all.
- From firmware 1.7.2 on nobody at the board agrees to an update. Whoever can deploy, which is a signed-in release
  manager, can install any signed image that is newer than what a board runs, on a board with nobody at it, and so can
  anyone with AWS rights to create a job. That was given up on purpose. The signature check, the version check, the trial
  and the revert all still hold, so what gets installed is still something this project signed, and an image that cannot
  reach the cloud still goes back. The frozen golden image 1.5.0 is older and still asks for Button 1.
- Downgrade protection is by version comparison in MCUboot, not by a hardware counter.
- A compromised application can get round that comparison. MCUboot makes it before a test or permanent
  swap, and skips it for a revert (`check_downgrade_prevention()` in `loader.c`). The application can
  write the primary slot's trailer, so it can forge a revert and swap in any older signed image it has
  put in the secondary slot. On a board with a golden image it has one in external flash, with no
  network needed. It cannot run unsigned code this way. This was read from source and not run.
- MCUboot does not check the image number in a serial recovery upload, and uses it as an index,
  so an upload could erase and write other flash areas, the bootloader's own among them.
  `CONFIG_BOOT_FLASH_AREA_HOOKS` and `image_number_guard.c` refuse every number but 0. A board keeps the
  hole until its bootloader is flashed over the debug port, since MCUboot is not updated over the air.
  On the frozen bootloader, bench test G14 sent numbers 1 and 3 and both were refused. It does not send
  the numbers that reach those other areas, so the hole itself comes from reading the source.
- Serial recovery has no version check. It writes straight into the primary slot, and the next
  boot checks the signature only, so any image ever signed with this key can be installed over
  a newer one, with no trial and no revert. No button is needed, because the bootloader also takes
  a command in the half second after a reset. Today this adds no power, because the debug port is
  open. Entry with `--reset`, with `--console` and with no valid image was tested on the board. Entry
  with Button 1 is not tested on hardware yet.
- The development kit's debug port is open. A product build would have to lock it (APPROTECT) and
  leave out the serial console (`-Dapp_CONFIG_APP_CONSOLE=n`). This repository has no such build yet.
- A product build should also narrow serial recovery. Dropping `CONFIG_BOOT_SERIAL_WAIT_FOR_DFU` means
  a board with a valid image needs Button 1. Button 1 and the no-valid-image state still take any
  image signed with this key. Building MCUboot without `CONFIG_MCUBOOT_SERIAL` removes the path. A
  version check is an open design: `boot_serial_uploaded_hook` runs after the old image has been
  overwritten, so the old version would have to be stored elsewhere, and a refusal at that point
  leaves no image. `CONFIG_BOOT_IMAGE_ACCESS_HOOKS` is off in this build. None of this is tested.
- MCUboot does not check the network core's image. It is flashed over the debug port. It has
  no radio stack and no keys.
- The board's device key is not isolated from the application. It is generated on the board and
  never leaves it, and TF-M stores it encrypted. But it is created as exportable and stored as
  an ordinary Protected Storage item, each TLS setup reads it into the non-secure heap, and that
  buffer is freed without being wiped. Code running in the non-secure application could read it
  and act as that board until its certificate is retired. It could not reach other boards or get
  unsigned firmware accepted. A real fix needs a non-exportable PSA key used as an opaque key, and
  this SDK's socket TLS layer shows no way to pass one.
- The firmware sets no cipher list. It offers the 16 non-PSK suites compiled in, all ECDHE: 4
  with GCM, 4 with CCM (2 of them CCM-8) and 8 with CBC (4 of them with HMAC-SHA1). The server
  chooses, and TLS's Finished check stops a network attacker from forcing a weaker choice. The
  handshake was not captured, so this document does not say which suite AWS picks.
- The audit log shows what reached the API function. A rewrite of an entry can be detected only
  while the log keeps its digest (90 days). Entries stored before the digest code was deployed have
  no digest and cannot be checked. The role could still add false entries and false lines: this
  detects changes to what was recorded, not lies told by the function. An AWS administrator can do
  anything to the table, and the CloudTrail record does not cover items in it.
- The CloudTrail record starts when `cloud/trail.sh` first runs, so it shows nothing older. It holds
  management events only, so it does not show a function being invoked or an image being stored.
- Deployment, `cloud/users.sh`, provisioning and the hardware bench run as the AWS account's root
  user. Root has MFA on and no access keys (confirmed from AWS on 2026-10-31). But a signed-in session
  lasts up to 12 hours and has full rights. The least-privilege row above covers the boards and the
  console's roles, not the operator. These jobs should move to an IAM user or to IAM Identity Center
  (SSO), with root kept for account-level tasks.
- An API token is a bearer secret: whoever holds a copy acts as its owner, with the owner's role at
  that moment, from anywhere, until it expires (at most 90 days) or is revoked. Only its owner can
  revoke it on the console. An administrator who has to stop one at once disables or removes the
  owner's account (`cloud/users.sh`), which ends all of that person's tokens on their next request. The
  token routes have no authorizer, so a request with a made-up token runs the API function for one
  lookup; their own request limits keep that from reaching the console's routes. Expired and revoked
  tokens stay in the state table, marked, because the API role may not delete. None of this has run on
  the deployed stack yet: it is tested against the in-memory stand-in and the local preview.
- Without an API token, `scripts/ota.sh` and `firmware/tests/hil/ota_bench.py` invoke the API function
  directly, with `aws lambda invoke` and hand-written token claims. This bypasses API Gateway and sign-in: no token
  check, no password, no authenticator code, no request limit and no line in the access log. The
  function trusts the claims, because it expects API Gateway to have checked them. It still asks
  Cognito whether the named person is an active release manager, runs its upload checks and writes
  an audit entry in that person's name. So an audit entry does not prove that the person signed in.
  The bench's request IDs start with `bench-`, but a caller could change that. Doing this takes AWS
  rights to invoke the function, which only an AWS administrator has. The update to 1.2.0 went this
  way.
- The hardware bench works on the production stack. Its `cranium-bench-…` jobs and the images it
  stores directly leave no audit entry.
- Sign-in can be blocked from outside. Cognito locks an account for a while after repeated wrong
  passwords, and the attempts need no credential. Sign-in names are e-mail addresses, so anyone who
  knows an address can keep that person from signing in. This comes from AWS's documentation and was
  not tested here. Recovery: add an account at another address with `cloud/users.sh`, or use the AWS
  CLI stop in `cloud/README.md`. During such a lock the console's own sign-in page says that the
  address or password is wrong, also for the right password, because Cognito answers both the same way.
- The time in the console's proof of the password comes from the computer's clock, unless the browser
  may read the time in Cognito's answer, which depends on Cognito's CORS headers. A clock that is far off
  may make Cognito refuse the proof, which then reads as a wrong password. The AWS sign-in page does not
  depend on that clock. Not tried.
- API Gateway checks a token offline, so signing out does not end a copy of the token: it works
  for reading and writing until it expires, at most 60 minutes. A removed or disabled user cannot
  write, and reads for at most another minute. During a Cognito outage such a user may read
  until the token expires.
- The signature is ECDSA P-256, by the team's decision. Ed25519 is the possible later upgrade, and
  it needs a bootloader reflash over the debug port. Post-quantum signatures are not available in
  this MCUboot.
- Not every answer carries the site's security headers. A request to `/api/` with no valid token is
  refused by API Gateway's authorizer, and its 401 has no `strict-transport-security`, `nosniff` or
  content security policy. An HTTP API cannot change that. The same goes for a 429 and for the other
  answers listed under
  [What the gateway answers itself](../cloud/README.md#what-the-gateway-answers-itself). These answers
  are not pages, and nothing renders them.
- The domain's DNS is at Cloudflare and every name is "DNS only", so Cloudflare answers for the names and
  carries none of the traffic. CAA allows only Amazon to issue a certificate, and none for a wildcard.
  Cloudflare's Universal SSL is off, because while it is on Cloudflare adds its own five certificate
  authorities to the answer. A null MX, SPF `-all`, DMARC `p=reject` and an empty DKIM key say that the
  domain sends no mail. DNSSEC is on: the `.com` registry holds the record and public resolvers validate.
  All of this was confirmed from public DNS on 2026-11-01. As a result, turning on Cloudflare's proxy for
  a name would break HTTPS on it until Universal SSL is back on.
- Plain HTTP does not redirect. Nothing in the stack listens on port 80: API Gateway takes HTTPS only,
  and the names are "DNS only" at Cloudflare, so nothing sits in front of it. A plain `curl` to
  `http://console.craniumiot.com/` failed to connect when this was tried on 2026-10-31, and the home
  page's names, which work the same way, were not tried. So someone who types `http://` gets a browser
  error, unless the browser tries HTTPS by itself or has been here before and remembers
  `Strict-Transport-Security`. On a first visit on a hostile network, an attacker could answer on port
  80 instead. The invitation mail links to the `https://` address.
- The home page's names are not a separate site. The stack maps them to the same API and stage as the
  console's name, so `/api/me` on the home host is the console's API, behind the same token check. With
  no token it gets the same 401 from the gateway, and `/api/t/` on the home host gets the API function's
  401 for a missing API token. The web function's 404 for that path, which
  `cloud/web/test/home.test.mjs` checks, is not what a `GET` there meets, because the API's route claims
  it first. No page on those names calls the API, and a token is good for nothing there that it was not
  good for already. This is from `cloud/infra/template.yaml`, and was not tried on the deployed home
  page.
- The event log is a view of what the boards reported, not a record anyone can rely on: a board writes
  its own shadow, a message that the rule or the recorder loses is a missing event with no error to say so
  (the rules have no error action), and AWS IoT can deliver a presence message twice or out of order. The
  Events page sorts by time and draws an online band from the connections, and from the heartbeat where no
  connection says. Who did what in the console is the activity log, whose guarantees are above.

## Threat model

What is worth protecting: the signing key, each board's device key, the Wi-Fi credentials, the
console accounts and the audit log. Firmware images hold no secrets.

| Who | What stops them | What is accepted |
| --- | --- | --- |
| Someone on the network path | TLS with verified certificates on every connection, and signed images. | They can block traffic. An update then waits or fails, and nothing is installed. |
| Someone on the internet, with no account | Sign-in with a password and an authenticator code. Uploads need a valid signature. | A flood can use up the API's shared request limit, because an HTTP API has no per-caller limit. Wrong passwords against a known address can keep that person from signing in. The AWS CLI stop still works in both cases, and an administrator can add an account at another address. |
| A stolen release-manager session | The console cannot sign. Boards verify with their own key and refuse older versions. | Until the token expires they can deploy existing releases, cancel and revoke, and from firmware 1.7.2 on a board installs a newer release with nobody at it. |
| A stolen session of a phone app | The apps do all the website does, but every change from a phone needs a sign-in, with password and code, in the last 15 minutes ([docs/mobile-apps.md](mobile-apps.md#signing-in)); an older one gets `403 phone_sign_in_again`, on record. | For 15 minutes after the person's last sign-in, whoever holds the unlocked phone can do what that person could. After that, until the token expires, they can read, download active images and read the passkey of a board that is pairing, each of which is in the activity log. |
| A stolen API token | The same, and the owner's role is asked of Cognito on every request. It cannot make tokens or read a Bluetooth passkey. Every change it makes carries its ID in the activity log. | What its owner may do, until it expires (at most 90 days) or the owner revokes it, or an administrator disables the owner. Unlike a session, it is not over within the hour. |
| A break-in at the API function | The same: the function cannot sign, and boards make the same checks. | Until the code is replaced it holds the API role, with no token limit. It can create jobs, cancel, revoke and add false audit entries. |
| Code running in the application on one board | MCUboot refuses unsigned firmware. Other boards are out of reach. The pin in the bootloader keeps any other image from being restored as the golden one. | That board's device key can be read. Retire its certificate. It can forge a revert to an older signed image, the golden image among them, and it can erase the golden copy (see [Known limits](#known-limits)). |
| Someone holding a development kit | Nothing yet: the debug port is open. | They can read or replace anything on that board, and Button 2 takes it back to the golden image and its known flaws. A product build would have to lock the port. This repository has no such build yet. |
| Someone with the signing key | Nothing on the boards, which would accept the image. Over the air it still takes a job, which takes a release manager or AWS rights, and the golden image 1.5.0 still waits for Button 1. With access to the UART, serial recovery takes the image with no button. | The key is a file on the builder's machine. Replacing it means reflashing boards and freezing a new golden image. The pin keeps the golden copy itself from being replaced with the key alone. |
| An AWS administrator | Nothing in the cloud. The CloudTrail record (`cloud/trail.sh`) and the audit digests show many changes afterwards. | They can change anything in the cloud, and can act in the console as any active release manager by invoking the API function. They cannot sign firmware without the key. Today this is the root user (see [Known limits](#known-limits)). |

## Cost

Everything is pay-per-use and, for four boards and four users, comes to well under one
US dollar a month: a board's one-minute report is about 45,000 messages a month, and the
console's functions and tables see a few thousand requests. The event log adds its own
share, of the order of 10 to 20 US cents a month per board: see [The event log](#the-event-log). The `cranium-budget` stack
sends an e-mail when the monthly cost passes its thresholds.
