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
| IoT rules and the recorder | Three AWS IoT rules hand each shadow report, each connection and each line a board prints on its console to a small Lambda function that writes the boards' events: [The event log](#the-event-log). |
| Cognito user pool | Console accounts: created by an administrator, password plus authenticator app. A small Lambda function, the sign-in trigger, gives the console's own sign-in page its scope: [Sign-in](#sign-in). |
| Cognito customer pool | The customer site's accounts, apart from the staff pool: invited from the console's Customers page, password of 10 characters, an authenticator app if the customer wants one: [docs/customer-site.md](customer-site.md). |
| HTTP API and two Lambda functions | The console: one function serves the pages, one is the console's API. A third function, the recorder, has no route, and neither has the sign-in trigger, which only Cognito calls. The same page function serves the customer site, and a fifth function, the customer API, answers `GET /api/c/` behind the customer pool's own authorizer. The page function can also serve a public home page on a name of its own (`HomeDomainName`), which is not deployed now: craniumiot.com is the customer site. |
| Fleet functions | The staged rollouts' schedule, the location function and the e-mail alerts' topic: [The fleet](#the-fleet-board-types-groups-and-staged-rollouts). |
| Memfault forwarder | From console 2.1.0: `MemfaultRule` hands each chunk a board publishes on `cranium/<thing>/memfault` to `MemfaultFn`, which posts it to Memfault with the project key from Secrets Manager and answers the board: [`memfault.md`](memfault.md). |
| Live updates | From console 2.4.0: a WebSocket API, `LiveFn` and its connections table. The tables' streams (keys only) tell `LiveFn` what changed, and it tells each open page that may see it, which reads it again at once: [`live.md`](live.md). |
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
| Publish | `$aws/things/T/shadow/update`, `$aws/things/T/jobs/$next/get`, `$aws/things/T/jobs/<job>/update`, `cranium/T/events`, `cranium/T/location`, `cranium/T/memfault` |
| Subscribe, receive | `$aws/things/T/jobs/notify-next`, `$aws/things/T/jobs/$next/get/*`, `$aws/things/T/jobs/<job>/update/*`, `cranium/T/commands` |

A board cannot read or write another board's shadow or jobs, cannot publish to any other
topic, and has no last-will message. `cranium/T/events` is where firmware 1.12.0 and later publish the lines of
the board's console ([The board log](#the-board-log)): publish only, nobody subscribes to it but a rule, and the board
gets nothing back on it. From 1.13.0 ([The map, commands and alerts](#the-fleet-the-map-commands-and-alerts)):
`cranium/T/location`, publish only, what the board hears of the Wi-Fi around it, which only a rule reads; and
`cranium/T/commands`, subscribe (as a topic filter) and receive only, where the console's commands arrive. A board
can neither send itself a command nor hear another board's or anyone's scans. From 1.14.0 (console 2.1.0):
`cranium/T/memfault`, publish only, the Memfault SDK's chunks, which only the Memfault rule reads; the answers come
on `cranium/T/commands` ([`memfault.md`](memfault.md)).

The policy has a fixed name, `cranium-device`, because provisioning attaches it by name. Changing its document is an
update in place: CloudFormation's `AWS::IoT::Policy` says "Update requires: No interruption" for `PolicyDocument` and
"Replacement" only for `PolicyName`. AWS IoT keeps the policy, adds the new document as a version and makes it the
default, so every certificate it is attached to has the new topic at once, and no board has to be provisioned again.
AWS IoT keeps at most five versions of a policy; whether CloudFormation deletes the oldest by itself once there are five
is not stated on that page. This policy had never changed since it was created on 2026-10-10 (git history of
`cloud/infra/template.yaml`), so the `events` topic was its first change; the commands and location topics (console
1.10.0) and the memfault topic (2.1.0) changed it again. If a deployment fails on the version limit,
`aws iot list-policy-versions --policy-name cranium-device` shows them and `aws iot delete-policy-version` removes one
that is not the default.

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
publish to its own shadow, jobs and board-log topics only, and a connection that announces any other topic is refused. AWS IoT
stamps the time at which it received `uptime`, and a board is online when that is less than 90 seconds ago
(`ONLINE_WINDOW_MS` in `cloud/api/src/lib/shadow.mjs`). A board that dies counts as offline in the API after 90
seconds. A page that is open can take about 125 seconds to show it: the API keeps a shadow for 5 seconds, and a page
with nothing under way asks every 30 seconds. (What a board says it is doing, such as connecting, restarting or an
update's steps, reaches an open page within about a second from console 2.4.0: [live updates](live.md). A board that
just stops says nothing: it turns offline when its heartbeat is late, which no table records, and AWS IoT's word that
it disconnected, when that comes, is told like any event.) A board on the golden image, which reports every 60 seconds, stays online
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

The console is at https://console.craniumiot.com, and also at https://craniumiot.com/admin, as the customer site's
admin mode. https://craniumiot.com is the customer site (below), and https://www.craniumiot.com sends the browser
there; the public home page that was on that name is no longer deployed. Sign-in is through Cognito: accounts are created by an administrator, and every
account needs a password of at least 12 characters and a code from an authenticator app. A temporary
password works for 3 days. A session lasts 60 minutes. The console keeps no refresh token, so it then
asks for the password and the code again. *Viewers* can look; *release managers* can upload, deploy,
cancel and revoke. All four of the team are release managers. [`cloud/README.md`](../cloud/README.md#add-users) has the
details.

**The customer site** ([docs/customer-site.md](customer-site.md)) is a website for customers on a name of its own
(`CustomerDomainName`, craniumiot.com), with accounts in a second user pool. One sign-in for both pools, with roles, is
planned and not built. A customer sees their own boards, by an id of the
board's assignment, never by its thing name; a token of the customer pool opens only the customer API, and a staff token
only the console's, at the gateway and again in each function. Release managers invite customers and give them boards
on the console's Customers page, each change in the activity log. On that name the console is the site's **admin
mode**, at `/admin`: an admin signs in once, with the staff account's password and code, on the site's one sign-in form
(the staff pool is tried first, then the customer pool), and the console opens with that session.

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

**What a deployment has shown.** This page has been deployed since 22e9c37. On 2026-11-02 the owner signed in on it
with the password and the six-box code: Cognito accepted the exchange, so it takes the claim, and the console's API
accepted the token, which it does only with `cranium/console`. On 2026-11-04 the iPhone app signed in the same way
([`test-results.md`](test-results.md)). Not checked one by one yet: that the token lacks the admin scope and still has
the groups, that `/oauth2/revoke` revokes a refresh token made this way, and how Cognito answers repeated wrong codes. While the trigger cannot be called nobody gets a token, by either page or app:
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
  made by `scripts/firmware/ota.sh` with AWS credentials, or by the test bench, name the release manager they
  act for, not a signed-in session. Their request IDs start with `bench-`. Actions taken directly in
  AWS, such as the AWS CLI stop in `cloud/README.md`, the bench's own jobs or anything an
  administrator does, do not pass through the API and are not listed here. Every sign-in and every
  change made to a board at its serial console from the console are there too:
  [What the activity log records](#what-the-activity-log-records).

### What the activity log records

Each entry is one action, with who (the account's sub and its e-mail address at that moment), what, on what, and how
it ended (`ok`, `rejected`, `denied`, `error`). The Activity page puts each in a sentence, a board by the name it has
in the list of boards now: "vihaan@… deployed 1.12.0+0 to CRVIHAAN01", "… set the Wi-Fi network of CRVIHAAN01 over
USB", "… signed in on the phone app".

| Action | What it is | Details |
| --- | --- | --- |
| `firmware.upload` | An image uploaded, or refused | file, size, SHA-256 |
| `firmware.revoke` | A release revoked | reason, deployments cancelled |
| `deployment.create` | A deployment started | version, `things` (how many boards), `boards` (their thing names, up to eight), `from: phone` |
| `deployment.cancel` | A deployment cancelled | force |
| `firmware.download` | An image downloaded to a phone | |
| `pairing.read` | A board's Bluetooth passkey read by a phone | the board's thing name |
| `firmware.bluetooth_send` | The check right before a send over Bluetooth | SHA-256, the board's Bluetooth name |
| `token.create`, `token.revoke` | An API token made or ended | its name, its lifetime |
| `account.sign_in` | A sign-in with password and code | `client`: `web` or `phone` |
| `serial.command` | A command that changed a board at its serial console, sent over USB from the console | `command`, the board's device ID as the target, the firmware `version` it gave, `from: phone` |
| `firmware.notes` | A release's note changed after its upload ("changed the note of 1.11.3+0") | the new note, cut to 200 characters; the old note's length |
| `group.create`, `group.update`, `group.delete` | A group of boards made, renamed or changed, deleted | its name, `renamedFrom`, boards added and removed, their thing names |
| `rollout.create` | A staged rollout started | version, `kind` of target, `group`, boards, `canary` |
| `rollout.cancel` | A staged rollout cancelled | force, jobs cancelled |
| `fleet.update_everything` | "Update everything": one staged rollout per board type | the rollouts, the releases by type, how many boards |
| `group.rollback` | A group rolled back to the release before the newest (before 2.19.1; entries stay in the history) | the group, the rollouts |
| `rollout.advance`, `rollout.stop` | The console's own, by the schedule: the waves started after a canary confirmed, or a rollout stopped by itself | version, the waves' job, why it stopped. No person: the actor is empty |
| `device.seen` | A phone saw a board over Bluetooth and said so | the version it saw, the board's Bluetooth name, `from: phone` |
| `app.upload` | A URL handed out to send an Android APK to S3 with ([The phone apps](#the-phone-apps-on-the-console)) | the app's version as the target, SHA-256, size, `versionCode` |
| `app.publish` | An APK checked and published on the Apps page | the same |
| `app.download` | A download link to an APK handed out, to anyone signed in | `via`: `link`, or `qr` for the QR code a phone scans; SHA-256 |
| `customer.create`, `customer.resend` | A customer invited to the customer site, or their invitation sent again ([docs/customer-site.md](customer-site.md)) | the customer's account id as the target, `email` |
| `customer.assign`, `customer.unassign` | A board given to a customer, or taken back | the board's thing name as the target, `customer`, `email`, `label` |
| `customer.disable`, `customer.enable` | A customer's account switched off or on | the customer's account id as the target, `email` |

A refused request also carries the `code` it was refused with. A customer's own reads on the customer site are not
recorded.

**Sign-ins.** The API records a sign-in when it sees the first request of it: a sign-in is the token's `sub`, its
`auth_time` (when the person gave the password and code) and its client, `web` for the console's app client and
`phone` for the phone apps'. A refreshed token keeps its `auth_time`, so a phone that refreshes its session for days
is one sign-in; the website keeps no refresh token, so each sign-in there is one. A request with an API token is no
sign-in, and neither is one that `cloud/smoke.sh` or the bench makes up (request IDs `smoke-` and `bench-`). The
request has to get past the live check first, so an account that is disabled or in neither group is not recorded.
The entry is dated at `auth_time` and keyed by the sign-in itself (`<auth_time>#signin.<sub>.<client>.<auth_time>`),
so every instance of the API function makes the same key, and the conditional put that every entry gets lets the
first one in. Each instance remembers the sign-ins it has recorded, and puts once for each: a sign-in costs one put
per instance of the function that serves it, one or two in practice, of which one is stored and the rest refused. It
is written after the request's own work, waits at most 1.5 s, and never changes the request's answer; one that
could not be written is tried again by the next request. No address is recorded.

**What cannot be recorded here.** A failed sign-in never reaches the API: a wrong password or code is between the
browser or phone and Cognito, so it is not in the activity log. Cognito's own record of sign-in attempts, the user
activity log and its auth event history (`AdminListUserAuthEvents`), is part of threat protection and needs the Plus
tier; this pool is on Essentials, and a Lambda trigger on the sign-in path was ruled out. What Essentials does have is
CloudTrail: Cognito logs every call of the user pool API, `InitiateAuth` and `RespondToAuthChallenge` among them, and
the managed login pages' `login_POST` and `mfa_totp_POST`, as management events, a failed one with its `errorCode`
(`NotAuthorizedException` for a wrong password, `CodeMismatchException` for a wrong code) and the user's sub in
`additionalEventData`, never the user name. The `cranium-trail` stack keeps those (`cloud/trail.sh`), and CloudTrail's
event history shows the last 90 days of them without a trail. That is from AWS's documentation and has not been looked
at for this pool; the console does not read CloudTrail. Cognito's lockout after repeated wrong passwords happens all the
same (see [Known limits](#known-limits)). Not recorded either: signing out (the console only forgets its
tokens and revokes the refresh token at Cognito), a session that simply expires, what a person only reads (reads are
not logged, apart from the image and the passkey), what a person does at a serial console outside the console's own
Serial page (another terminal, `tools/provision_device.py`), and what a board is told by its buttons.

**Changes at a board's serial console.** The Serial page drives a board over USB from the browser, so the server sees
no command. Once the board has answered OK to one that changes it (`INIT`, `SET_ID`, `RESET_CONFIG`, `FACTORY_RESET`,
`WIFI`, `WIFI_SEC`, `CLEAR_WIFI`, `CLOUD`, `KEYGEN`, `MQTT_HOST`, `MQTT_RECONNECT`, `BUTTON`, `REBOOT`,
`ENTER_BOOTLOADER`), the page posts `POST /api/serial/commands` with the command's name, and the board's device ID
and firmware version as the board gave them (`GET_ID`). Never a value: the body may hold those three fields and
nothing else, so a client that sent a network name or a password would be refused, on record. Only a release manager
may post, as for every change; a phone app's session needs no fresh sign-in for it, as for the calls made at a board
for Bluetooth, because the change is already made and refusing the record would only keep it off the log. At most 30
a minute per person, counted from the activity log itself; one more gets `429 rate_limited` and, unlike every other
refusal, leaves no entry, since the limit is there to keep the log from filling up. If the post fails, the command
still counts as done, and the page says that the record did not get through. What is recorded is what the poster
says: a release manager's session could post a command that was never sent. From firmware 1.12.0 the board itself
reports the same commands in its log (`[CONSOLE] WIFI done on the serial console: …`), which is the board's word for
it.

### API tokens

A personal API token lets a script, such as `scripts/firmware/ota.sh` or an assistant that runs it for you,
use the console's API as you without signing in. Every member, viewer or release manager, makes and
revokes their own on the console, under **Developer > API tokens**, and sees only their own.

- **Making one.** Choose **New token**, give it a name (1 to 40 characters) and a lifetime of 1 to
  90 days (30 unless you choose). The token, `crn_` and 43 characters, is shown once, with a copy
  button. The console keeps only its SHA-256, so it cannot show it again. A person has at most 10
  tokens that still work.
- **Keeping it.** Treat it like a password. `scripts/firmware/ota.sh` reads it from `CRANIUM_TOKEN` or from
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
        ── console line (1.12.0) ──▶ AWS IoT ── rule: cranium/+/events ──────────────┤
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

Lines of a board's log ([below](#the-board-log)) have a kind too: one of these, or `setting` or `log`.

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
  500 a page and 31 days at a time, for one board or every board of the group. From console 2.12.0 it also takes
  `q=<text>` and `level=warn|info`, in the same Query ([search-filters.md](search-filters.md)).
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

### The board log

From firmware 1.12.0 a board also sends every line it prints on its serial console, one MQTT message each at QoS 0,
on `cranium/<thing>/events` (["Events to the console"](../firmware/README.md#events-to-the-console) in the firmware's
README): `{"t":61234,"seq":17,"boot":42,"up":61240,"tag":"WIFI","text":"connected ip=10.0.0.7 rssi=-51"}`. A third rule,
`BoardLogRule`, hands each to the recorder:

```sql
SELECT *, topic(2) AS thing, timestamp() AS received FROM 'cranium/+/events'
WHERE startswith(topic(2), 'cranium-') AND isUndefined(thing) AND isUndefined(received)
```

The board's name comes from the topic, which the device policy lets a board publish on for itself only, and the time
of arrival from AWS IoT. WHERE reads the message as it came, so a message that carries a `thing` or `received` of its
own is not passed on at all: a board cannot write into another board's log or choose when it arrived, whichever value
the SELECT would keep when two have one name (AWS does not say). The recorder takes a message as a line because it has
`received`, which only this rule adds, and reads nothing else of it as a shadow or a connection.

**Checked again, as if the board had checked nothing** (`cloud/api/src/lib/lines.mjs`): `t` and `up` whole numbers with
`t <= up`, `seq` from 1, `boot` and `dropped` whole numbers, the `tag` one of the 16 sources the firmware may send
(`BT`, `WIFI`, `STUCK`, `CONSOLE` and the application's log modules), the text a string of at most 1024 characters. The
text is then made printable ASCII (anything else becomes `?`), and a line with any of `passkey`, `passphrase`,
`password=`, `password:`, `psk=`, `secret`, `-----begin`, `private key` or `x-amz-` in it, in any case, is not stored
at all, nor is a debug line (`DBG: `): the firmware's own rule, again. The recorder logs such a line as
`line_withheld` with its board, tag and reason, never its text, so `cloud/logs.sh events` counts them. In what is left
a network name between quotes in a `WIFI` or `net` line becomes "the network", a URL becomes "a URL" and a host name
ending in `.amazonaws.com` becomes "AWS", and the text is cut to 160 characters, ending in `...`.

**Kinds.** Each line becomes an event of the kind its source is about, so that the kind filters on the Events page work
the same for events and lines:

| Source | Kind | Why |
| --- | --- | --- |
| `BT`, `bt_ota` | `bluetooth` | the Bluetooth window and the update over it |
| `ota` | `update` | an update over the air |
| `STUCK`, `stuck`, `boot_diary` | `restart` | why a board restarted, or is about to |
| `WIFI`, `net`, `health` | `health` | the Events page's "Wi-Fi and memory" |
| `CONSOLE`, `factory` | `setting` (new) | a setting of the board changed at its serial console, or erased by a factory reset: what a person did to the board, which the page can then show on its own |
| `app`, `cloud`, `identity`, `store`, `ui` | `log` (new) | the rest of what the board says |

`connection` stays AWS IoT's own word that a board connected or disconnected: the page draws when a board was online
from it, and a line of the board's must never count as one. A line that starts with `WRN: ` or `ERR: `, or a `STUCK`
line, is a warning.

**Dated and stored once.** A line happened `up - t` milliseconds before the board sent it, so it is dated at the time AWS
IoT got it less that. A line is one item, `L#<time>#<boot>.<seq>`, 90 days like an event, with its tag, `boot`, `seq` and
`dropped` (how many lines are missing before it). The first line of a boot can arrive twice, in two connections: the
second copy has another `up` and arrives at another time, so its date differs by how much longer one copy took on its
way, and a key with the time in it cannot catch it. So a line is first claimed: an item `K#<boot>.<seq>` with its date,
put only where none is, where the one there has the same date (Lambda handing over the same message again, which then
makes the same line key and replaces its own item), or where the one there is more than 10 s away, which is a board
counting its boots from 1 again after a factory reset. A copy within 10 s is the same line and is not stored again
(`line_repeated` in the log). Two puts per line.

**Read.** `GET /api/events/log?from=<ISO>&to=<ISO>&thing=<name>&kinds=<a,b>&tags=<A,b>&cursor=<cursor>` lists lines newest
first, with the same range, pages, limits, `q` and `level` as `GET /api/events`, for viewers and release managers alike:
`{ lines: [{ thing, at, id, kind, tag, level, text, boot, seq, dropped? }], cursor, from, to }`. `GET /api/events`
returns no lines, so what it returned before is unchanged. The Events page lists the lines in a **Board log** card
of their own, under the events, with their source, a filter by source, and a button to hide it; on the timeline each
line is a short tick at the foot of its board's lane, in the colour of its kind's family, so that the markers stay as
few as they were.

**Cost.** At most 5 lines a second per board, by the firmware's limit: 432,000 messages a day at the very most, which
would be of the order of 30 US dollars a month for one board flooding all day (messages, rule, Lambda, two puts).
A board that is well says far less: a few dozen lines when it starts and connects, and a few an hour after that. The
recorder has no limit of its own beyond the firmware's.

### Update history

From console 2.1.1 the Overview's Updates, the Deployments page (**Every update**), a board's page and both phone apps
list every update of every board, however it came: a deployment (an AWS IoT job, board by board), an update over
Bluetooth from a phone, or one by USB or another tool. Only a deployment is in AWS IoT Jobs; for the rest the board's
own reports are all there is, so the recorder keeps what they say of an update as **facts**
([`lib/updates.mjs`](../cloud/api/src/lib/updates.mjs)), in the events table, a partition per board, kept for good:

| Key (pk `UPD#<thing>`) | From | Says |
| --- | --- | --- |
| `V#<time>` | the shadow's `fw.version` changed | `from`, `to`, `confirmed`, and the `job` its report named |
| `C#<time>` | `fw.confirmed` became true | `version` |
| `B#<count>#<from>#<to>#<result>` | the shadow's `bt`, or a BT line ("update over Bluetooth: …", "last update over Bluetooth: …", "on trial: …") | `from`, `to`, `result`, `proof`, `count` (the board's own number for the update) |
| `A#<time>#<boot>.<seq>` | the BT line "firmware X has arrived" | `to` |
| `R#<job>#<result>` | the shadow's `ota.last` for a job | `job`, `result` |
| `M#backfill` | the backfill of this board is done | `facts`, `oldest` |

Each has `at`, when the board said it, and is put only where none is or where the one there is later
(`attribute_not_exists(sk) OR at > :at`): a retried message, the record a board says again on every boot, the shadow
and the log saying the same, or the backfill after the recorder, leave one fact at its first time. On read the API
folds a board's facts and its executions into one **record** per update: each execution is a deployment; each Bluetooth
count is an update over Bluetooth, with the first result that is not `pending`; a version change is that of one of them
when it is near it (the same versions within a day, or the job its report named or in the job's time), the end of
one that was not kept when it goes back to where that one came from (a rollback, within a day), and otherwise an update
of its own, by USB or another tool. Who sent an update over Bluetooth is whoever's phone made the check before the send
(`firmware.bluetooth_send` in the activity log, answered yes, for that version and that board or none named) in the
two hours before the board first said anything of it, and that check's time is when the update started.

```
GET /api/updates?thing=<name>&limit=<1-100, 25>&cursor=<cursor>
  -> { updates: [{ id, thing, from, to, how: deployment | bluetooth | usb_or_other, deployment, who: { sub, email, name },
                   outcome: kept | rolled_back | not_installed | pending, startedAt, endedAt, status }], cursor, generatedAt }
```

Newest first, for viewers and release managers, from the website, a phone app or an API token; `status` is a
deployment's execution status. `GET /api/devices/{thing}` has the board's newest as `lastUpdate`. The words are the same
everywhere: "over Bluetooth from Vihaan’s phone", "deployment <id>", "USB or another tool". The customer site lists no
updates (a customer sees their board's current update and its events), so the customer API has no such route.

**Backfill.** The first read that needs a board's list, after 2.1.1 is deployed, makes its facts once from what the
events table already holds of it: the shadow's firmware, update and Bluetooth events, kept 90 days, and its BT lines,
which exist from firmware 1.12.0 and are kept as long. So it goes back 90 days before the deploy (2026-08-07 for a
deploy on 2026-11-05), and in practice to a board's first events: for the board, the update to 1.11.4, the 1.12.0
deployment, and 1.13.0 and 1.14.0 over Bluetooth on 2026-11-05. The API may put facts only in the `UPD#` partitions (`BackfillUpdateHistory`
in ApiRole). If they cannot be put, the list is shown from them all the same and the backfill is tried again 10 minutes later.

## The fleet: board types, groups and staged rollouts

What [fleet.md](fleet.md) agrees for the firmware and the console, as the console does it. The map, the commands
and the alerts are in the same document and are described with them.

**Compatibility: board type and flash layout.** A release is for one board type, `nrf7002dk` (Wi-Fi, updated by
AWS IoT Jobs or a phone) or `nrf5340dk` (Bluetooth only, updated by a phone or over USB), and for one flash layout,
a positive whole number that goes up whenever the partitions change. The upload reads both from the image's
protected TLVs, which the image's hash and signature cover: `0xA1`, the type in ASCII (1 to 16 lower-case letters
and digits), and `0xA2`, the layout in ASCII (the build sets them from `CONFIG_APP_BOARD_TYPE` and
`CONFIG_APP_IMAGE_LAYOUT`). The same tags in the unprotected area are never read: anyone can add one there without
breaking the signature, and the console refuses such an image (`unexpected_tlv`). An image without them is a
`nrf7002dk` image for layout 1, as every release up to 1.12.0 is; a value that is not a known type or a positive
whole number is refused (`unknown_board`, `invalid_board_tlv`, `invalid_layout_tlv`). The release shows what it is
built for ("For nRF7002 DK · layout 1"). A board's type and layout are what it says in its diagnostics from 1.13.0
(`diag.board`, `diag.layout`), else its thing's attributes `board` and `layout` (`tools/provision_device.py
--board nrf5340dk`, read with `DescribeThing` at most once a minute per board, and only for a board that has not
said both), else `nrf7002dk` and 1. A board can only write its own shadow, so a board that lies about itself keeps
releases from itself and from nothing else, and the board checks an image's TLVs again before it installs it.

**One version is one image.** Versions are one sequence across all board types and layouts: a new release of any
type must be newer than every release ever registered, so `1.13.0` names exactly one file, and a build for another
type takes the next number (`1.13.0+0` for one, `1.13.0+1` or `1.13.1` for the other).

**The guard.** A deployment, a staged rollout that names its boards, "Update everything" (for the
boards their reviewed plan names), and the check before a Bluetooth send refuse a board of another type
(`400 incompatible_board`) or another flash layout (`400 incompatible_layout`), on record; a deployment refuses a
board without Wi-Fi as a job target (`400 bluetooth_only`). The check before a Bluetooth send takes the board's
thing name (`thing`), or the type and layout the board told the phone (`type`, `layout`); without any of them it has
nothing to check, as before types, so the phone apps send `thing`. A rollout to a group, a type or the fleet, and the
plan of "Update everything" leaves such boards out instead, each with why (`other_type`,
`other_layout`, `bluetooth_only`). "Update everything" takes the newest release of each type: a board of that type
on another layout is left out until a release is built for its layout.

**Groups** are stored in the state table (pk `GRP`), not as AWS IoT thing groups: a rollout has to check every
board's type and version anyway, so it names its boards one by one, and a thing group as a job's target (let alone
a continuous job, which takes every board that joins later, unchecked) would hand a release to boards of another
type. A group can be renamed, which a thing group cannot, and one conditional write changes its name and its boards
together. A board that joins a group later is taken by the next rollout to it; one under way does not take it, and
the Overview shows the board as behind until "Update everything" does. A deleted group is marked, never removed:
the API role may not delete from that table.

**Staged rollouts** (pk `ROL`). A rollout starts with a canary (one board unless asked for up to 5; online boards
first), as a job of its own. A board reports `SUCCEEDED` only from the new firmware, once that has started, reached
AWS IoT and confirmed itself (`ota.c`, `send_final_report`), so a canary that has succeeded has confirmed. AWS IoT
Jobs cannot make one job wait for another, so a function of its own, `RolloutTickFn`, runs every minute
(EventBridge `rate(1 minute)`): for each open rollout it reads the canary's job, and once every canary board has
succeeded it looks at the rest again (a board that got the release meanwhile, has another update open, or left the
project is left out then) and starts the waves as one job that AWS IoT paces and stops itself:

```json
"jobExecutionsRolloutConfig": { "maximumPerMinute": 50,
  "exponentialRate": { "baseRatePerMinute": 1, "incrementFactor": 2, "rateIncreaseCriteria": { "numberOfSucceededThings": 1 } } },
"abortConfig": { "criteriaList": [{ "failureType": "ALL", "action": "CANCEL", "thresholdPercentage": 20, "minNumberOfExecutedThings": 1 }] }
```

That is: one board a minute to start with (`wave`, up to 50), twice as many each time as many more have succeeded,
and once failures, rejections and timeouts reach 20% of the boards that have finished (`abortPercent`, from the
first board on), the job is cancelled: what has not started never does, and a board that has started finishes. A
canary that fails, a release revoked, a job cancelled on its deployment's page, or a job stopped by AWS: the
rollout is `stopped`, and says why; cancelled on its own page, `cancelled`. The change of stage is a conditional
write on the rollout, so two runs at the same moment start the waves once; a cancellation that comes while the
waves are being started is seen right after their job exists, which is then cancelled. The function's role can
read the releases and the fleet's records, write rollouts only, add to the activity log, and start, read and
cancel this console's jobs; it serves no request.

**"Update everything"** plans, for each board type, its newest active release to every board of that type that is
not on it, leaving out the Bluetooth-only boards, those offline for more than a day, those already current, those
on something newer and those busy with another update; it starts one staged rollout per type, after checking the
reviewed plan against the plan as it is then (`409 plan_changed`). Rolling back is "Roll back to last good" ([`fleet.md`](fleet.md)): a board takes only firmware newer than what it runs
(`ota_job.c`, `ota_job_check`: equal versions are refused too), so a real roll back is a rebuild of the old source under a
newer version (`Rebuild of <version>`), released and rolled out like any other. The group "Roll back" that planned the
release before the newest was removed in 2.19.1.

**What a phone saw** (`POST /api/devices/{thing}/seen`, pk `SEEN`): the version a phone read from a board over
Bluetooth, when, and who; the last one per board is kept. It is how a board without Wi-Fi shows on the console.
Release managers only, with no fresh sign-in asked of a phone (it changes no board), at most 60 a minute per person.

**Fleet health** (`GET /api/fleet/health`, the Overview): versions by board type and how many run the newest;
the last 7 days' update results: the ends of jobs as the boards reported them, and from console 2.1.1 the updates over
Bluetooth and by USB or another tool from the [update history](#update-history); and the boards that need
looking at: offline for more than an hour, restarted for being stuck, a last update that failed or rolled back,
memory down below 15% free, a Wi-Fi signal below −75 dBm, and a board without Wi-Fi no phone has seen. From console
2.15.0 it also has the fleet health score, its daily snapshots and its change since last week, and takes `?days=`
(1 to 31): [fleet-health.md](fleet-health.md).

**A release's note** (`PUT /api/firmware/{version}/notes`, body `{ "notes": "..." }`): the whole note, one line of
at most 500 characters, `""` for none, for active and revoked releases alike, by release managers with a session
or an API token. It is the one write of the API on `PUT`, through two gateway routes of its own (`PUT /api/{proxy+}`
with the authorizer, `PUT /api/t/{proxy+}` for tokens) with the limits of `POST`.

**Cost.** The schedule is 43,200 invocations a month of a 256 MB function that makes one query when nothing is
open: within Lambda's free tier, and of the order of a cent a month beyond it. A rollout adds a few calls a
minute while it is open. `DescribeThing` is asked at most once a minute per board without `diag.board`.

## The fleet: the map, commands and alerts

The other half of [fleet.md](fleet.md): where each board is, by the Wi-Fi it hears; commands to a board, now; and
e-mail alerts. The code is `cloud/api/src/locator.mjs` and `lib/position.mjs` (positions), `handlers/commands.mjs`,
`alerts.mjs` and `lib/alerts.mjs`, and `aws-map.mjs` (its AWS calls, kept apart from `aws.mjs`), and on the website
`map.js` and `account.js`.

### Commands

`POST /api/devices/{thing}/commands` with `{"cmd": "identify", "seconds": 15}` (1 to 60, 15 if left out) or
`{"cmd": "report"}` answers `202 {"command": {id, cmd, seconds?, thing, sentAt, online}}`. The API publishes
`{"id", "cmd", "seconds"?}` with the IoT data plane's `Publish`, QoS 1, to `cranium/<thing>/commands`; its role may
publish on `topic/cranium/cranium-*/commands` and on no other topic. `id` is 16 hex digits from the server's CSPRNG.
The board answers in its own log with tag `CMD`, which the recorder files as kind `setting`
(`identify for 15 s (3f9c2a1b7d4e6f80)`); the website looks for that line every 3 s for 45 s after it sent the
command and shows it on the board's page. A board that is offline misses the command, as the contract means:
`online: false` in the answer says so, and an offline board's Identify button is greyed out. A Bluetooth-only board
(`nrf5340dk`) is refused (`409 bluetooth_only`).

Release managers only, on record as `board.command` with the command, its length and its id. At most 10 a minute
per person, counted from the activity log as the serial console's records are; one over that is refused with 429
and leaves no entry. From a phone, `identify` needs no sign-in in the last 15 minutes, like the calls a person makes
at a board: it blinks two LEDs for at most a minute, changes nothing and costs nothing, and its use is a person at
a bench of boards finding which one is which; a fresh sign-in would add a password and a code to that and protect
nothing. `report` does need one: it is sent from anywhere, and makes the board send a scan that costs a position
estimate (the route is marked `atTheBoard` and the handler asks the fresh sign-in of `report`).

### Location by Wi-Fi

A board on 1.13.0 publishes, QoS 0, on `cranium/<thing>/location`, and `LocationRule` hands it to `LocationFn`:

```sql
SELECT *, topic(2) AS thing, timestamp() AS received FROM 'cranium/+/location'
WHERE startswith(topic(2), 'cranium-') AND isUndefined(thing) AND isUndefined(received)
```

As for the board log, a message that carries its own `thing` or `received` is not passed on. `LocationFn` is a
function of its own and not a part of the recorder: it is the one piece that spends money for a message and that
sends what a board heard out of AWS IoT, so its role alone may call `GetPositionEstimate`, and nothing that handles
the boards' other messages can; it is not retried (a second try of a paid estimate is worth less than the next
scan); and its log (`/aws/lambda/<stack>-location`) counts the estimates.

**What a scan may hold** is checked whole, and a scan that breaks any of it is not solved: exactly the fields `aps`,
`boot`, `t` (and the rule's two); 2 to 10 access points, each exactly `{mac, rss}`; `mac` six pairs of hex digits
with colons (either case, compared in lower case), unicast and globally administered (the two lowest bits of the
first byte clear: a randomised or hotspot address is refused, and so is a group address and all zeros), no BSSID
twice; `rss` a whole number from −120 to 0; `boot` and `t` whole numbers. Fewer than 2 is kept as "too few" (with
the count), so that the map can say why the board has no position.

**The estimate.** `GetPositionEstimate` of AWS IoT Wireless (API version 2020-11-22: `POST /position-estimate`), as its
API reference has it: the request is

```json
{ "WiFiAccessPoints": [ { "MacAddress": "a4:2b:b0:12:34:56", "Rss": -51 }, { "MacAddress": "f0:9f:c2:65:43:21", "Rss": -70 } ] }
```

`MacAddress` a string of 12 to 17 characters matching `([0-9A-Fa-f]{2}[:-]?){5}([0-9A-Fa-f]{2})`, `Rss` an integer
from −128 to 0 (dBm), both required; `Timestamp`, cellular, IP and GNSS data are not sent. The answer is the
`GeoJsonPayload`, a blob of GeoJSON:

```json
{ "coordinates": [13.376077, 52.51823, 80.1], "type": "Point",
  "properties": { "verticalAccuracy": 45, "verticalConfidenceLevel": 0.68, "horizontalAccuracy": 303,
                  "horizontalConfidenceLevel": 0.68, "timestamp": "2026-04-07T01:16:39.971767716Z" } }
```

longitude first, then latitude (WGS84); `horizontalAccuracy` in metres, at a 68% confidence by default. A 404
(`ResourceNotFoundException`) means AWS found no position for those access points ("unsolved"); 400 is a request it
does not accept, 403 a permission, 429 its limit (10 requests a second by default, adjustable), 500 its own fault
("failed", tried again with the next scan). The IAM action is `iotwireless:GetPositionEstimate`, which has no
resource type: IAM can only allow it on `*`. The API is in us-east-1, us-west-2, eu-west-1, eu-central-1,
ap-northeast-1, ap-southeast-2 and sa-east-1 (endpoints `api.iotwireless.<region>.amazonaws.com`); the function
calls it in its own Region, so a stack in any other Region has no positions. AWS says it may send the request to
the third-party provider of the solver it picks (HERE's Wi-Fi solver), which may be outside the Region (AWS Service
Terms): that is what leaves the board, BSSIDs and signals, and nothing else.

**Throttle.** At most one estimate per board in 10 minutes, and any write at most once in that time, so a board
that sends too often costs a read and nothing more; and none while the board hears the same set of access points as
the last estimate was asked about, unless that one failed or never finished (then "Still there" is noted instead).
The estimate is claimed first by a write conditional on the item as it was read, so two copies of a message solve
once.

**What is kept** (events table, pk `LOC`, sk the thing name): the position (`lat`, `lon` to six places, `accuracy` in
whole metres, `at` the time AWS IoT received the scan), the last 20, the status, the number of access points and a
64-bit hash of the board's thing name and the sorted BSSIDs, to tell a new set from the same one; never a BSSID or a
signal, in the table or the log. A board's first position is an event (`health`, `located`), and so is a move
(`health`, `moved`, a warning) of more than 1 km that is also further than the two positions' uncertainties together,
so that two fuzzy fixes do not make one; neither has a coordinate in its text. The API adds `position` and
`location` (`status`: `none`, `ok`, `too_few`, `unsolved`, `failed`, `unknown`; `apCount`; `checkedAt`;
`bluetoothOnly`, from the thing's attribute for a board that has never reported) to every board, and
`GET /api/devices/{thing}/positions` gives the last 20.

**The map.** The website's Map page and the map on a board's page are drawn with Leaflet 1.9.4, the files of its npm
package (integrity `sha512-nxS1ynzJ…FA74PA==`) as they are, served from the console's own assets with its licence
(`leaflet-license.txt`), and fetched only when a map is shown. The content security policy allows images from
`https://tile.openstreetmap.org` and nowhere else new. The tiles follow OpenStreetMap's tile usage policy: the exact
tile URL, the attribution on the map, the browser's cache as the tile server sets it, nothing fetched beyond the
view, and the console's origin as the tiles' Referer (`referrerPolicy: strict-origin-when-cross-origin` on the tiles;
the page sends no Referer anywhere else). A person who opens a map asks OpenStreetMap for the tiles around the boards:
OpenStreetMap learns that person's address and roughly where the boards are. Popups are built as elements by the
console's renderer, never as markup. In the dark scheme the tiles are darkened by a CSS filter.

### Alerts

An SNS topic (`AlertTopic`, output `AlertTopicArn`), whose policy refuses publishing and subscribing without TLS.
On the Account page a release manager asks for the alerts at their own address (`POST /api/alerts/subscribe`, on
record as `alert.subscribe`; at most 3 an hour, each sends an e-mail) and stops them (`POST /api/alerts/unsubscribe`,
`alert.unsubscribe`); `GET /api/alerts` says whether the caller's address gets them, how many addresses do (never
which), and the last 20 e-mails that went out. SNS sends the confirmation, and nothing goes to an address until its
link is followed. A subscription that waits for its confirmation has no ARN, so the console cannot remove it; its
link works for two days. The API's role may `sns:Subscribe` with `sns:Protocol` `email` only, `sns:ListSubscriptionsByTopic`
and `sns:Unsubscribe`, on that topic, and never publishes.

The recorder (EventsFn) and the location function make the alerts:

| Alert | From |
| --- | --- |
| Offline for more than 15 minutes, and back | AWS IoT's presence messages (the presence rule). Kept per board; a message counts only if it is newer than the one kept: by time when they are more than a minute apart, else by AWS's `versionNumber` (which a connection's connect and disconnect share), and within one connection the disconnect comes last. AWS says these messages may come out of order and twice. An EventBridge rule (`AlertCheckRule`, `rate(5 minutes)`) runs the recorder, which raises "offline" for a board disconnected for 15 minutes, and "back" when it connects after that |
| An update that failed or rolled back | A shadow report's update result `failed` or `rolled_back`, and a Bluetooth update record `rolled_back`, `trial_lost`, `not_installed` or `flash_error` |
| A deployment that stopped by itself | An event `{kind: "update", what: "stopped", job: <deployment>}`, keyed by the deployment. Nothing records one yet: see the note below |
| A restart for being stuck | The event `restart` / `stuck` |
| A move of more than 1 km | The location function |

At most one e-mail per board (or deployment) and kind an hour; an alert within the hour is folded (at most 20 and a
count of the rest) and goes with the next e-mail of its kind, or with the 5-minute check once the hour is up. Each
change to the alerts' state is a write conditional on what was read, so two invocations never both send; the state is
written before the e-mail is sent, and an e-mail that cannot be sent has its lines put back for the next. A failure of
the alerts never fails the recording of an event. The e-mail is plain ASCII text: the board's name (its device ID, or
its thing name), its thing name, the alerts with their times in UTC, a link to the board (or deployment) on the console
(`CONSOLE_URL`) and to the Events page; no secret, no network name, no BSSID and no coordinate. The state lives in the
events table, pk `ALERTS` (per board `B#<thing>`, per deployment `D#<id>`, and each e-mail sent `S#…`, kept 30 days).
The recorder's role may also query that partition and nothing else of the table (`dynamodb:LeadingKeys`), and publish
to the topic; the location function's may query `LOC` and `ALERTS`, put items under `LOC`, `ALERTS` and `cranium-*`,
call `GetPositionEstimate`, and publish to the topic.

A deployment that stops by itself is noticed by the staged rollouts' schedule (RolloutTickFn), not by the recorder:
when a canary does not confirm, or AWS IoT aborts the waves, it raises the "deployment" alert through `alerts.mjs` for
the job that failed (a revocation or a cancellation by a person is no alert). For that its role may also query and put
items under `ALERTS` only, and publish to the topic.

**Cost.** A board that sends a scan after each boot and every 6 hours, and on "Report now", makes about 4 to 6
estimates a day, fewer when it hears the same access points (those are not asked again): of the order of 150 a month,
US$0.15 a board at the published price of US$1.00 per 1,000 solved locations up to a million a month in us-east-1
(US$0.80 per 1,000 to 5 million, US$0.70 beyond), with 1,000 free in an account's first 12 months. The 10-minute floor
caps a board at 4,320 a month, US$4.32. The location function and the 5-minute check (8,640 runs of the recorder a
month) are within Lambda's free tier; SNS bills e-mail deliveries by its own price list.

## The phone apps on the console

The Apps page ([`docs/mobile-apps.md`](mobile-apps.md#the-apps-page)) hands out the Android app, and the iPhone app
through each member's SideStore source or a build from a Mac. Five routes of the API (`cloud/api/src/handlers/apps.mjs`), all under the gateway's existing `GET` and
`POST` routes, with a session or, as `/api/t/...`, an API token:

| Route | Who | On record | What |
| --- | --- | --- | --- |
| `GET /api/apps` | every member | no | The Android releases, newest first (version, `versionCode`, size, SHA-256, note, who published it, when), and the iPhone app's version and note from the changelog this deployment was built with |
| `GET /api/apps/config` | every member | no | The phone apps' configuration, exactly `apps/config/cranium.json`, from the stack's own values: `CONSOLE_URL` and `LOGIN_DOMAIN` (new environment of the API function), the region, the pool and the phone apps' client |
| `POST /api/apps/android/uploads` | release managers | `app.upload` | Body `{ version, versionCode, sha256, size, notes }`. A presigned `PUT` for `apps/android/cranium-android-<version>.apk`, good for 15 minutes, that signs `content-length` and `x-amz-checksum-sha256`: S3 takes exactly that size and those bytes |
| `POST /api/apps/android/releases/{version}` | release managers | `app.publish` | The same body without the version. `HeadObject` with `ChecksumMode: ENABLED`: the size, the full-object SHA-256 and the S3 version of what arrived. Registered only if they match |
| `GET /api/apps/android/{version}/download` | every member, viewers too (with an API token, release managers, as for every request on record) | `app.download` | A presigned `GET` of the S3 version that was checked, good for 15 minutes, served as `application/vnd.android.package-archive` with `Content-Disposition: attachment; filename="cranium-android-<version>.apk"`. `?via=qr` for the QR code |

An APK is about 12 MB, more than the 10 MB API Gateway takes, so it never passes through the API. A version is
accepted once and only upward, by its version and by its `versionCode`, which Android needs to be higher for an
update: both calls refuse a taken version (`409 version_exists`), a lower one (`422 version_not_newer`) and a
`versionCode` that is not higher (`422 version_code_not_higher`), and the release and the pointer to the highest
(state table, pk `APP` and `META`/`APP#android`) are written in one transaction. What arrived is refused if it is
missing (`409 apk_missing`), of another size (`422 size_mismatch`), of another SHA-256 (`422 sha256_mismatch`) or
without a SHA-256 of the whole file (`422 checksum_missing`, as after a multipart upload). From a phone, the download
and the configuration are reads; the two calls of a publish are changes and need a sign-in in the last 15 minutes.

**The bucket.** The APKs are in the firmware bucket, under `apps/android/`, rather than in a bucket of their own: it is
already private, TLS only, encrypted, versioned and kept when the stack is deleted, and a second bucket would need all
of that again, and teardown with it. Nothing a board uses reaches them: a board takes download URLs under `firmware/`
only, and AWS IoT presigns with a role that reads `firmware/*` alone. The bucket keeps every version of an object; a
release records the S3 version it was checked against and a download names it, so whatever is put under the same key
afterwards is never handed out for that release.

**The role.** Three statements, one action each, on `apps/android/cranium-android-*.apk` only: `s3:PutObject` (the
upload URL, which the role signs), `s3:GetObject` (the `HeadObject` of the check) and `s3:GetObjectVersion` (the
download link). No list, no delete, no tagging, nothing under `firmware/` this way. The URLs are signed in the
function (`cloud/api/src/lib/presign.mjs`, Signature Version 4 in the query string, checked against AWS's published
example) with the role's credentials from the environment; a URL is good until it expires or they do.

**The iPhone app** (`docs/mobile-apps.md`, [Updates on every phone](mobile-apps.md#updates-on-every-phone)). The same
three steps for an unsigned IPA, under `apps/ios/cranium-ios-<version>.ipa`, with three more statements of one action
each on those objects alone (`SendIphoneIpas`, `CheckIphoneIpas`, `ServeIphoneIpas`): `POST /api/apps/ios/uploads`
(`app.ios_upload`), `POST /api/apps/ios/releases/{version}` (`app.ios_publish`), which also reads the IPA's
`Info.plist` and `cranium.json` out of the zip with ranged `GetObject`s of the version that was checked, and
`GET /api/apps/ios/{version}/download` (`app.ios_download`). Releases are `APP`/`ios#MMM.mmm.ppppp`, the pointer
`META`/`APP#ios`, the build in the place of the `versionCode`. Each member's SideStore source key is `SRC`/`key#<SHA-256
of the key>` with its owner, and `SRC`/`owner#<sub>` names the member's newest; `GET /api/sidestore/{proxy+}` is the one
route that SideStore reads them through, with no authorizer, and counts each key's use with a conditional `UpdateItem`.

**The console's own version.** `GET /api/me` also says `console: { version, commit }`: the version in `cloud/VERSION`
and the commit this deployment was built from, from the `versions.json` that `cloud/deploy.sh` writes beside the
function's code ([`docs/versions.md`](versions.md)), `null` where it has none.

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

scripts/console/open-console.sh                         # sign in, deploy if needed, open the console
cloud/deploy.sh                                 # create or update the stacks (the owner's fallback)
cloud/users.sh add <email> release-manager      # the person gets an invitation by e-mail
cloud/smoke.sh                                  # checks that do not need a sign-in

python3 tools/cranium_secrets.py wifi           # once per machine, see secrets/README.md
python3 tools/provision_device.py               # once per board
```

Deploying is done from GitHub Actions now, with no AWS sign-in: Actions → Deploy console → Run workflow on `main`,
which anyone with write access can do, with no approval step ([docs/ci.md](ci.md#deploying-the-console-from-github-actions)). `cloud/deploy.sh` above is the
owner's fallback, and the way to give it parameters or `--replace-signing-key`.

A session can end sooner than that: one on 2026-11-01 ended after about 2 hours and 20 minutes. A long
bench run that needs AWS stops when it does.

Releasing an update:

1. Raise the version in `firmware/app/VERSION` and build. The build signs the image with
   the key in `~/.cranium/` and stores it in `binaries/`.
2. In the console, upload `binaries/latest.signed.bin`.
3. Deploy it. A board on 1.7.2 or newer installs it as soon as it sees it. A board on older firmware, the golden image
   among it, waits until someone presses Button 1 on it.

`scripts/firmware/ota.sh` does steps 2 and 3 for one board and follows the update to the end. With an
[API token](#api-tokens) it goes through API Gateway to `/api/t/`, as the token's owner, and needs no
AWS credentials. Without one, it invokes the API function directly, which bypasses API Gateway and
sign-in (see [Known limits](#known-limits)).

After a new signing key, run `cloud/deploy.sh --replace-signing-key`, so that the console
trusts its public half. `secrets/README.md` covers the rest.

`cloud/logs.sh api|web|events|location|memfault|memfault-errors|signin|access|iot` follows the logs. `cloud/teardown.sh` removes the console and
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
| Log security-relevant actions, never secrets | An audit entry for every attempted change that reaches the API function, for every sign-in, and for every change made to a board at its serial console from the console, by the command's name only. A board's own log never holds a passkey, a password or a key: the board leaves them out and the recorder checks again. A request that API Gateway's token check refuses appears only in the access log. An entry that cannot be stored is lost, and if the change itself succeeded the caller gets `audit_failed`. IAM lets the API's role only put and query entries, so it cannot delete or update one. A put could still replace an entry with the same key, and IAM cannot forbid that: the code sends a condition on every put that refuses it. To notice a rewrite, the function logs a digest of each entry, which the role cannot change, and `cloud/api/verify-audit.mjs` compares the two for the 90 days the log keeps its lines. Access log without query strings; no tokens, links or request bodies in any log. An API token is stored as its SHA-256 only, and logged by its ID only. |
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
- Without an API token, `scripts/firmware/ota.sh` and `firmware/tests/hil/ota_bench.py` invoke the API function
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
- The home page's names, when `HomeDomainName` is set (it is empty now), are not a separate site. The stack maps them to the same API and stage as the
  console's name, so `/api/me` on the home host is the console's API, behind the same token check. With
  no token it gets the same 401 from the gateway, and `/api/t/` on the home host gets the API function's
  401 for a missing API token. The web function's 404 for that path, which
  `cloud/web/test/home.test.mjs` checks, is not what a `GET` there meets, because the API's route claims
  it first. No page on those names calls the API, and a token is good for nothing there that it was not
  good for already. This is from `cloud/infra/template.yaml`, and was not tried while the home page was
  deployed. The customer site's names map to the same API too, on purpose (`/api/c/`, and the console at `/admin`).
- The event log is a view of what the boards reported, not a record anyone can rely on: a board writes
  its own shadow, a message that the rule or the recorder loses is a missing event with no error to say so
  (the rules have no error action), and AWS IoT can deliver a presence message twice or out of order. The
  Events page sorts by time and draws an online band from the connections, and from the heartbeat where no
  connection says. Who did what in the console is the activity log, whose guarantees are above. The board log
  is the board's word too, sent at QoS 0: a line lost on the way is gone, and only the next line's `dropped`
  says that lines were lost on the board itself.
- A `serial.command` entry is what a release manager's page said it did at a board's serial console, which the
  server cannot check. A failed sign-in is not in the activity log: only CloudTrail has it
  ([What the activity log records](#what-the-activity-log-records)).

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
share, of the order of 10 to 20 US cents a month per board, and the board log a little more for a board that is
well: see [The event log](#the-event-log) and [The board log](#the-board-log). The `cranium-budget` stack
sends an e-mail when the monthly cost passes its thresholds.
