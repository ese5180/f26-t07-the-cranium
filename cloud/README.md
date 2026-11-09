# Cranium firmware console: cloud

The update server for the Cranium boards. The team uploads a signed firmware image in a
web console, sees its version, deploys it to boards and watches each board update. The
console only verifies signatures: it holds the public half of the signing key and can
never sign anything.

Today it updates the nRF boards. Updating the Raspberry Pi through the same console is
planned; [docs/raspberry-pi-ota.md](../docs/raspberry-pi-ota.md#decision) describes what
that needs here.

Console 2.1.0 is deployed (bcc5a19, `cloud/CHANGELOG.md`). The team's console is at
https://console.craniumiot.com. https://craniumiot.com is the customer site, whose Admin
sign-in opens the same console at https://craniumiot.com/admin, and
https://www.craniumiot.com sends the browser to the bare name. All four of the team are
release managers.

It is two CloudFormation stacks, deployed with the AWS CLI:

- `cranium-ota-bootstrap` (`infra/bootstrap.yaml`): the bucket that the Lambda code is
  uploaded to.
- `cranium-ota` (`infra/template.yaml`): everything else.
  - An HTTP API with two Lambda functions: one serves the console's pages (and the
    customer site's, and a public home page when one is configured, which it is not now),
    one is the console's API. A third, the recorder, has no route: three AWS IoT rules
    hand it every shadow report, every connection and, from firmware 1.12.0, every console
    line of a board, and it writes the boards' event log
    ([docs/aws-iot.md](../docs/aws-iot.md#the-event-log)).
  - A Cognito user pool for sign-in. Accounts are created by an administrator, and
    the console asks for a password and a code from an authenticator app at every
    sign-in, on its own sign-in page or on the AWS sign-in page. A small function, the
    sign-in trigger, gives the tokens of the console's own page the console's scope
    ([docs/aws-iot.md](../docs/aws-iot.md#sign-in)).
  - The customer site ([docs/customer-site.md](../docs/customer-site.md)): a second Cognito
    user pool for customers, apart from the staff pool, and a fourth function, the customer
    API, behind an authorizer of its own. Customers see their own boards; admins invite them
    and hand out boards on the console's Customers page, and use the console as the site's
    admin mode at `/admin`.
  - A bucket for firmware images. An image is written once and never overwritten.
  - Three DynamoDB tables: the releases, the audit log, and the boards' event log (events
    kept 90 days, readings 7), which the Events and Diagnostics pages read.
  - In AWS IoT: the thing group `cranium-devices`, the device policy `cranium-device`,
    and the role AWS IoT Jobs uses to sign short-lived download links.
  - For the fleet ([docs/fleet.md](../docs/fleet.md)): the staged rollouts' schedule, the
    location function and the e-mail alerts' topic.
  - From 2.1.0, the Memfault forwarder ([docs/memfault.md](../docs/memfault.md)): an AWS IoT
    rule and a function that post each chunk a board publishes to Memfault, with the project
    key from a Secrets Manager secret that only this function can read, and answer the board.

No file here holds an account ID, an endpoint, a secret or an e-mail address. What a
deployment produces is written to `cloud/.deploy/`, which git ignores.

## Before you start

- AWS CLI v2 with a signed-in profile, Node.js 22, `openssl` and `curl`.
- `export AWS_PROFILE=<profile>`. The Region comes from `AWS_REGION` and is `us-east-1`
  if that is not set. Every script here uses these two and can be run from any directory.
- The public half of the firmware signing key in `firmware/keys/fw_signing_pub.pem`.

## Open the console

```sh
scripts/open-console.sh
```

It signs in to AWS if the session has run out, deploys the console if it does not exist,
checks that it answers and opens it in the browser. With `--update` it first deploys the
code in this checkout. There is no server to keep running: the console is Lambda and API
Gateway, which answer whenever someone asks. This script defaults to the profile
`cranium`; `AWS_PROFILE` overrides that.

## A real address

The console answers on the address API Gateway assigned, and it can answer on a name of
your own as well. DNS for the name can be anywhere; these steps take a few minutes.

1. Request a certificate in this Region, and read the record that proves you own the name:

   ```sh
   aws acm request-certificate --domain-name console.example.com --validation-method DNS
   aws acm describe-certificate --certificate-arn <arn> \
     --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
   ```

2. Add that record at your DNS provider as a CNAME. At Cloudflare, set its proxy status
   to "DNS only". Wait until the certificate's status is `ISSUED`.
3. Deploy with the name and the certificate:

   ```sh
   cloud/deploy.sh ConsoleDomainName=console.example.com ConsoleCertificateArn=<arn>
   ```

   From then on the output `ConsoleUrl` is the new address, and later deployments keep it.
4. Add a CNAME from the name to the output `ConsoleDomainTarget`, again as "DNS only".

The address API Gateway assigned goes on working and stays a valid place to sign in.

### The home page

**Not deployed now.** craniumiot.com, which had the home page, is the customer site
(below), and the customer site uses the certificate the home page had. `HomeDomainName`
is empty, so no name gets the home page. The steps stay for another name.

The same stack can serve the public home page (`web/src/site/home.html`) on a name and on
`www.` in front of it, such as `example.com` and `www.example.com`. The web function looks
at the host name of each request: a name in its setting `HOME_HOSTS` gets the home page,
and every other name gets the console as before. Nothing about the home page goes into
Cognito, because it signs nobody in. With no name given there is no home page.

1. Request one certificate for both names, and read the two records that prove you own them:

   ```sh
   aws acm request-certificate --domain-name example.com \
     --subject-alternative-names www.example.com --validation-method DNS
   aws acm describe-certificate --certificate-arn <arn> \
     --query 'Certificate.DomainValidationOptions[].ResourceRecord'
   ```

2. Add both records as CNAMEs, as "DNS only" at Cloudflare, and keep them: the certificate
   renews through them. Wait until its status is `ISSUED`.
3. Deploy with the name and the certificate. Give the name without `www.`:

   ```sh
   cloud/deploy.sh HomeDomainName=example.com HomeCertificateArn=<arn>
   ```

   The outputs `HomeDomainTarget` and `HomeWwwDomainTarget` are the two DNS targets:

   ```sh
   aws cloudformation describe-stacks --stack-name cranium-ota \
     --query "Stacks[0].Outputs[?starts_with(OutputKey, 'Home')].[OutputKey, OutputValue]" --output text
   ```

4. If the name redirects somewhere today, remove that rule. Add a CNAME from the name to
   `HomeDomainTarget` and one from `www` to `HomeWwwDomainTarget`, both as "DNS only".
   Cloudflare accepts a CNAME on the bare name and answers it with the target's addresses.
5. Check it. The page should answer 200 and its policy should have no `script-src`:

   ```sh
   curl -sS -o /dev/null -D - https://example.com/
   ```

Three things to know before pointing a name here:

- `Strict-Transport-Security` with `includeSubDomains` is sent on this page as on the
  console, for two years. On the bare name that covers every name under it, so browsers
  that have been here refuse plain HTTP on all of them, on names added later as well.
- It is one API, so the paths of the API answer on these names too, behind the same token
  check. No page there calls them, and a token is good for nothing it was not good for
  already. The authorizer's 401 there has no security headers, as it has none anywhere.
- The two sites share the request limit of the page routes and the concurrency of the
  function. Heavy traffic on the home page can make console pages answer 429, and the other
  way round. Open console pages keep working, because they use the API routes.

### The customer site

A third name, `CustomerDomainName` with `CustomerCertificateArn`, serves the customer
website, with the console as admin mode at `/admin` of that name, and `www.` sending the
browser to the name itself. Both are empty by default, and nothing changes until they are
set. The deployed stack has them set, for craniumiot.com, with DNS-only CNAMEs at
Cloudflare. The certificate, the deployment and the DNS records (an ALIAS or a flattened CNAME on
the bare name) are in [docs/customer-site.md](../docs/customer-site.md#setting-up-the-name):

```sh
cloud/deploy.sh CustomerDomainName=example.com CustomerCertificateArn=<arn>
```

The customer pool and the customer API exist whether or not the name is set, so that
customers and boards can be prepared first; no invitation goes out until the site has an
address. `CustomerSelfSignUp` stays `false`: customers are invited from the Customers page.

## Deploy

```sh
cloud/deploy.sh
```

It runs the tests in `api/` and `web/`, creates or updates both stacks, writes the
stack outputs to `cloud/.deploy/outputs.json` (the board provisioning tool reads that
file) and prints the address of the console. A first deployment takes a few minutes.
Run it again after any change: it only changes what differs.

- The user pool and the three tables are created without deletion protection, so that a
  failed first deployment can clean up after itself. The same run switches the protection
  on once the stack exists.
- The stack switches on AWS IoT logging, which is one setting per account and Region.
  If it is already on, the script stops and says how to hand it over. AWS IoT logs to
  the group `AWSIotLogsV2`, which belongs to the account and not to the stack: the
  script creates it if it is missing and gives it a retention period of 90 days if it
  has none.
- The console accepts only images signed with the key in
  `firmware/keys/fw_signing_pub.pem`. Once the console is deployed, a run that finds
  another key in that file stops and shows both fingerprints. If the project's key was
  replaced on purpose, run `cloud/deploy.sh --replace-signing-key`.
- Sign-in names are not case sensitive. That is fixed when the user pool is created: a
  pool from an earlier version of this stack compares addresses exactly, and the script
  says so when it updates one. Users of such a pool type their address in lower case.
- Template parameters can be given as arguments, for example
  `cloud/deploy.sh IotLogLevel=DEBUG`. See `cloud/deploy.sh --help`.
- A deployment records what it was built from, in the stack outputs `DeployedCommit` and
  `DeployedTree`, in `cloud/.deploy/outputs.json` and in the description of both
  functions. `clean` means that the files that go into the stack match that commit;
  those are `api/src`, `web/src`, `infra/` and the signing public key, whatever else has
  changed in the checkout. A `dirty` deployment is allowed, the script lists the files,
  and the record says so. It does not say whether the commit was pushed.
- It also writes `web/src/site/assets/history.json` (`web/build-history.mjs`, ignored by
  git): the newest 300 commits with their dates, subjects and what they touched, for the
  console's History page, and what this deployment was built from. No authors and no
  message bodies. The page is for signed-in users. The file itself is served like every
  other file of the console, to anyone who asks for its address; the home page, where one
  is deployed, has no way to it. Because it holds the time of the deployment, every run changes the console's
  build id.

  ```sh
  aws cloudformation describe-stacks --stack-name cranium-ota \
    --query "Stacks[0].Outputs[?starts_with(OutputKey, 'Deployed')].[OutputKey, OutputValue]" --output text
  ```

## Add users

```sh
cloud/users.sh add <email> release-manager    # or: viewer
cloud/users.sh list
cloud/users.sh resend <email>                 # the invitation expired or got lost
cloud/users.sh reset-mfa <email>              # lost phone or password: both are new, same role
cloud/users.sh remove <email>
```

A release manager may upload and revoke firmware and create and cancel deployments. A
viewer may only look. `add` on an existing account changes its role. An address is
always stored in lower case, however it is typed.

Cognito sends the new user a temporary password that is valid for three days. At the
first sign-in the user chooses a password and registers an authenticator app, on the AWS
sign-in page, which the console's own page opens by itself for that. Nobody
can sign up, reset a password or change their address alone. A session lasts 60 minutes,
then the console asks for the password and the code again.

Each tab has a session of its own. Signing out ends the session of every open tab on the
same address, but not of one on the other address. Closing a tab does not end its session:
a tab that is restored can bring its token back until the token runs out. And it is the
console that asks for the password every time (`prompt=login`), not a rule of the user
pool: for an hour after the last password on the AWS sign-in page, Cognito's own login
cookie still works for somebody at that computer who writes the sign-in request by hand.
The console's own sign-in page leaves no such cookie. So lock the computer, and sign out.

`reset-mfa` is for a forgotten password, a lost phone or a new phone. It replaces the
account with one of the same role, so the user also gets a new temporary password.
Removing only the authenticator app would leave the password as the only factor until
the next sign-in, and whoever signed in first would register an app of their own. The
new account has a new account id, and earlier entries in the activity log keep the old
one. It refuses a disabled account, because the new one would be enabled.

The customer site's admins are these same accounts: a release manager signs in on the
customer site's one sign-in form, which tries this pool first, and lands in admin mode. All four of the team have
`release-manager`, the top role. Customers are not made here but on the console's Customers
page, in a pool of their own ([docs/customer-site.md](../docs/customer-site.md#accounts)).
One form for both since console 2.4.5; the two pools stay apart.

`remove` on an address that has no account fails and lists the accounts there are,
because the person may be listed under another address. An address can only be changed
by an administrator, with `aws cognito-idp admin-update-user-attributes`.

Whether a user may change something is asked of Cognito for every change. Removing a
user, or giving or taking away the release manager role, therefore counts at once.
Whether a user may read is asked once a minute, so removing or disabling an account
stops reading within a minute; "Sessions and removal" below has the details. What a
browser that is still signed in shows follows at the next sign-in: until then it shows
the controls of the old role.

## Check and watch

```sh
cloud/smoke.sh          # the console answers, the API refuses anonymous calls and
                        # accounts that do not exist, the sign-in page loads, the API
                        # function can reach its data
cloud/logs.sh api       # or: web, events, location, memfault, memfault-errors, signin,
                        # access, iot
```

| What you see | Where to look |
| --- | --- |
| The console says you are not signed in, or a request answers 401 | `logs.sh access`: `authorizerError` says why the token was refused |
| Somebody who was signed in gets a 403 for everything | The account was removed, disabled or left without a group: `users.sh list` |
| `live_check_failed` in `logs.sh api` | The API could not ask Cognito whether a reader is still active. Reads go on; see "Sessions and removal" |
| A request answers 500 | `logs.sh api`, with the `requestId` from the error message |
| A 500 with no line in the API log | `logs.sh access`: `integrationError` |
| A board does not come online | `logs.sh iot`: look for `Connect` entries with status `Failure`. The client ID must be the thing name, and the certificate must be attached to the thing |
| A board refuses or fails an update | the deployment page of the console, then the board's serial console |
| A page does not show changes at once (its Live mark does not show, docs/live.md) | `logs.sh live`: a `$connect` line with `refused` and why (`no_token`, `expired`, `account`, ...) or `failed`, and one line per batch of changes with how many pages were told. The page still refreshes every 30 s |
| A board's events are missing from the Events page | `logs.sh events`: one `recorded` line per report of a board, or `message_ignored` with why. No line at all: the AWS IoT rules did not invoke the recorder |
| A board's log is missing from the Events page | The board runs firmware 1.12.0 or later, and the device policy allows `cranium/<thing>/events` (else its serial console says `AWS IoT closed the connection right after an event`). `logs.sh events`: `recorded` with a `tag` per line, `line_withheld` for a line with a passkey or a password in it, `line_repeated` for one sent twice |
| A sign-in is not in the activity log | It is recorded by the first request of it that reaches the API function; `logs.sh api` shows `sign_in_unrecorded` with why when it could not be written, and the next request tries again |
| A revocation answers that it is not complete, or a release shows as not completely revoked | Revoke it again. The release is marked, so nothing new can start; blocking the image or cancelling a deployment did not go through, or a board is still at work that could not be stopped (see below). The answer says which |

Search the access log with text patterns, for example
`cloud/logs.sh access --filter-pattern '"invalid_token"'`. API Gateway cannot escape
its own error messages, so a line that carries one is not always valid JSON, and a
JSON pattern such as `{ $.status = "401" }` passes those lines over. The two messages,
`integrationError` and `authorizerError`, come last in a line; everything before them
can be relied on.

A connection that fails authentication (a certificate AWS IoT does not know, or an
inactive one) is logged as well: the stack switches on the event type
`Connection.AuthNError`, which is off by default. Such a connection needs no
credential, so anyone who knows the endpoint can add entries to that log. They cost a
little each and expire with the retention period of the log group `AWSIotLogsV2`
(90 days unless you chose another).

### Stop an update without the console

Reading and writing have a request limit each, shared by all users ("Request limits"
below). If the API answers 429 to everybody, or cannot be reached, an update can still
be stopped with the AWS CLI. The bucket name is `FirmwareBucketName` in
`cloud/.deploy/outputs.json`; the digest is shown with the release on the Firmware page,
and `aws iot list-jobs` lists the deployments.

```sh
# 1. Block the image: the bucket refuses every download of a tagged object at once.
aws s3api put-object-tagging --bucket <FirmwareBucketName> \
  --key firmware/<sha256 of the image>.bin --tagging 'TagSet=[{Key=revoked,Value=true}]'
# 2. Stop the boards that have started.
aws iot cancel-job --job-id <deployment id> --force --reason-code RELEASE_REVOKED
```

Then revoke the release in the console as soon as it answers again, so that it cannot
be deployed any more. These two commands leave no entry in the activity log.

### A board at work on a cancelled deployment

Cancelling a deployment without force leaves a board that had started alone, and the
deployment then counts as cancelled in AWS. What a second, forced cancellation does to
such a deployment, AWS does not document, and it is what the console sends when you
cancel with force or revoke the release afterwards. Measured in October 2026, AWS
accepts it and stops the board 5 to 15 seconds later. The console does not assume that:
it reads the board's state back, answers that the cancellation was refused or that the
revocation is not complete while a board is still at work, and shows the release as
such until no board is left. Asking again a few seconds later then completes it. A board in that state can no longer download a revoked image, and AWS ends its
part in the deployment 30 minutes after it started. To stop it at once:

```sh
aws iot cancel-job-execution --job-id <deployment id> --thing-name <board> --force
```

Then revoke the release again; it completes. The role of the API function may not
cancel a single board's part in a job, so the console cannot do this itself. What AWS
did with the second cancellation is in the API log (`cloud/logs.sh api`). For a
cancellation it is `cancel_refused` if AWS refused and `cancel_unconfirmed` if it
accepted and the board was still at work. For a revocation it is `cancel_unconfirmed`
in both cases, and its field `accepted` says which.

## An account record

```sh
cloud/trail.sh            # create or update the trail
cloud/trail.sh --status   # whether it is logging; changes nothing
```

The stack `cranium-trail` (`infra/trail.yaml`) is one multi-Region CloudTrail trail of
management events with log file validation, in a private bucket that only answers over
TLS. Nothing else deploys it, and `teardown.sh` leaves it alone: the record of what was
done to the console should outlive the console.

It records who changed a resource in AWS: a role, a function, a stack, a bucket policy,
a table's protection, a sign-in as root. AWS keeps those for 90 days anyway; the trail
keeps them for a year (`RetentionDays`) and makes a changed or removed log file
detectable with `aws cloudtrail validate-logs`. It records **management events only**, so
it does not see an S3 object being tagged or downloaded, an item changing in DynamoDB or
a Lambda function being invoked. It tells nobody either: there are no alarms.

What it costs, at the prices published for `us-east-1` in October 2026. An estimate, not
a measurement:

| What | Price | In this account |
| --- | --- | --- |
| The first copy of management events | Free | $0. `trail.sh` refuses to run next to another trail, because a further copy costs $2.00 per 100,000 events |
| S3 requests | $0.005 per 1,000 PUT | A file per Region every five minutes at most, and a digest per Region every hour. In 17 Regions that is at most about 160,000 PUT a month, or $0.80; a quiet account uses far less |
| S3 storage | $0.023 per GB-month | Tens of MB a month, kept for a year: under a cent |

To remove it, `aws cloudformation delete-stack --stack-name cranium-trail` stops the
trail and keeps the bucket with the log files. Empty and delete the bucket by hand when
they are no longer wanted.

One account setting belongs with this and is not in any stack, because CloudFormation
does not manage it here. It stops any future bucket from becoming public by mistake, and
changes nothing for the existing ones, which already have these settings:

```sh
aws s3control put-public-access-block --account-id <account id> --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

## Limits

What this console does not do, stated plainly.

### Request limits

| Route | Per second | Burst | Token |
| --- | --- | --- | --- |
| `GET /api/{proxy+}` | 10 | 20 | Yes |
| `POST /api/{proxy+}` | 5 | 10 | Yes |
| `GET /api/t/{proxy+}`: scripts with an API token | 5 | 10 | No: the function checks the API token |
| `POST /api/t/{proxy+}`: scripts with an API token | 2 | 5 | No: the function checks the API token |
| `GET /api/sidestore/{proxy+}`: SideStore on an iPhone | 2 | 5 | No: the function checks the key in the path, at most 30 uses a minute each |
| `GET /` and `GET /assets/{proxy+}`, each | 20 | 60 | No |
| `$default`: everything else | 10 | 20 | No |
| The live API's WebSocket (`LiveApi`, stage `live`): a page connecting, and its ping every 5 minutes | 10 | 20 | No: the live function checks the token a page connects with ([docs/live.md](../docs/live.md)) |

These limits are per route, for everybody together. An HTTP API has no limit per caller,
and AWS WAF cannot be attached to one. Separating reads from writes keeps heavy reading,
such as many open pages, from starving revoke and cancel. That is all it does:

- Anyone with a viewer's token can use up the write limit, since the 403 only comes from
  the function. Each such request also adds a refused entry to the activity log, at most
  about 432,000 a day, each naming the caller's account id.
- The page routes need no token, so anyone can make page loads and the return from
  sign-in answer 429. Open pages keep working, because they use the API routes.
- The routes for API tokens (`/api/t/`, see [docs/aws-iot.md](../docs/aws-iot.md#api-tokens))
  have no authorizer, so anyone can make scripts that use a token answer 429, and every such
  request runs the API function once, for a lookup by digest. A request whose token names
  nobody leaves no entry in the activity log. The console's own routes are not affected.
- AWS does not document whether a request that the authorizer refuses counts against its
  route, and it has not been measured here. Assume that it does, which would mean that
  blocking the API needs no account.
- Both API routes call one function, and this account's functions share a concurrency
  limit, 10 until the quota is raised. Slow writes and many reads can still get in each
  other's way there.
- The budget alert tells you about the bill of a flood. It stops nothing.

The way out when this happens is the AWS CLI: "Stop an update without the console". What
was weighed and not done: Cloudflare's proxy would terminate TLS and see every token and
firmware upload, and CloudFront with a WAF rule costs about $6 a month and can be bypassed,
because an HTTP API cannot restrict its callers to CloudFront.

### What the gateway answers itself

What no route claims goes to the web function, so a 404 or a 405 carries the same security
headers as a page. Only `GET` is answered, so `curl -I` shows a 405 with those headers; look
at a page's real answer with `curl -sS -o /dev/null -D -`. Each such request runs the function
and logs its path, cut to 200 characters. Some answers still come from API Gateway without
those headers, because an HTTP API cannot change them: the authorizer's 401 on `/api/`, a 429
when a request limit is reached, the 403 for a `Host` that no custom domain claims, and, by the
gateway's design, an answer it gives when it cannot reach a function. The API function's own
answers on `/api/` carry `strict-transport-security`, `cache-control` and `nosniff`, and so does
its 401 for a missing or invalid API token on `/api/t/`, which has no authorizer. They are JSON
that nothing renders, so they do not carry the page's content security policy.

### Sessions and removal

API Gateway checks a token offline: its signature, issuer, audience, expiry and scope. So
the API asks Cognito itself:

- **Writes** ask every time, whether the account is enabled, confirmed and a release
  manager. If Cognito cannot be asked, the write fails.
- **Reads** ask once a minute for each user, whether the account is enabled, confirmed and
  in one of the two groups. So a removed or disabled user reads for at most another minute
  rather than until the token expires. If Cognito cannot be asked, the read goes on, unless
  the last answer for that user was a refusal, the failure is logged as
  `live_check_failed`, and it does not ask again for half a minute.

That failure rule is a choice. The token is still one that the gateway verified and a read
changes nothing, while refusing would take the console away from everybody during a Cognito
outage, when a release manager may need to watch a deployment. An attacker cannot cheaply
cause such a failure: one user makes one check a minute in each running copy of the
function. What it leaves open: during an outage, a user removed just before it, on a copy
of the function that has no answer on record, reads until the token expires, at most 60
minutes.

**Signing out does not end a token.** "Sign out" clears this tab and the other open tabs
of the same address, and
`admin-user-global-sign-out` ends the refresh token, but a copy of the access token goes on
working until it expires, at most 60 minutes, for reading and for writing. Cognito cannot
be asked about this: the console revokes its own refresh token at sign-in, so every live
token already counts as revoked there. Shorter tokens were not chosen because the console
has no refresh, so each expiry would mean a password and a code. If a token may have been
stolen, run `cloud/users.sh reset-mfa` or `remove`: the old account is gone, so writing
stops at once and reading within a minute.

### The activity log

What it records, sign-ins and changes at a board's serial console among them, is in
[docs/aws-iot.md](../docs/aws-iot.md#what-the-activity-log-records).

What is enforced by IAM: the API function's role may put and query items in the table, and
is refused anything that deletes or updates them. What is enforced by code only: that a
put does not replace an entry. PutItem can overwrite an item with the same key, and no IAM
condition can require the "only if new" condition that the API sends. So code running in
that role could rewrite an entry, or add a false one.

To notice a rewrite, the function also logs a digest of each entry as it stores it, and its
role cannot change or delete a log line. An entry that no longer matches, or that is gone,
shows up here:

```sh
aws dynamodb query --table-name <AuditTableName> --key-condition-expression 'pk = :p' \
  --expression-attribute-values '{":p":{"S":"AUD"}}' > audit.json
aws logs filter-log-events --log-group-name /aws/lambda/cranium-ota-api \
  --filter-pattern '"audit_entry"' > digests.json
node cloud/api/verify-audit.mjs audit.json digests.json
```

It marks an entry as `CHANGED` if it does not match its digest, or if its request id has
several different digests: a request logs one, so a rewrite with a second line next to it does
not pass. An entry with no line is `UNLOGGED`, and counts as a finding, if it is younger than
the first line in the file: a forged entry looks like that. A line can take a moment to reach
the log, so look again at an entry stored in the last minutes before concluding anything.

The log group keeps its lines for 90 days, so an older entry can no longer be compared. An
AWS administrator can change both the table and the log, and such a change to an item is not
in the trail. Point-in-time recovery can bring back the table of the last 35 days.

`scripts/ota.sh` and the test bench invoke the API function directly with AWS credentials,
past API Gateway and sign-in, with made-up token claims in the name of an active release
manager. The function's own checks still run and it writes an ordinary entry under that
person's name. So such an entry does not show that the person signed in, or that they did it at
all. Its request id starts with `bench-`, which API Gateway never gives a request, and the
Activity page marks it "Script, no sign-in". This needs AWS rights to invoke the function,
which can do far more than this already, so it adds no power. It is a limit on what the log
can attribute.

Deletion protection on the tables guards against mistakes: whoever may delete a table may
also switch it off, and that is what `teardown.sh` does.

### The revocation tag

The API function's role can set the tag `revoked=true` on an image and cannot set any other
tags, so it cannot clear the mark that makes the bucket refuse to serve the image. An AWS
administrator can.

### The address API Gateway assigned

It stays open and stays a registered place to sign in, by decision, next to a name of your
own. It is the only way to sign in that does not depend on Cloudflare: if the DNS account,
the DNS records or the certificate fail, the team can still sign in and stop an update. The
price is two valid sign-in addresses, one of them under a suffix where any AWS customer can
get a name, so users cannot judge a link by the suffix alone. This should be looked at again
once something sits in front of the name, because this address would bypass it.

### The AWS IoT logging role

Its trust policy has no conditions, unlike the role that signs download links. It is the
policy AWS publishes for this role. AWS recommends the conditions for AWS IoT roles in
general, but does not list logging among the features they work with, and warns that a
service may not supply the keys. If AWS IoT logging does not, the log stops without an
error, including the entries for refused connections. To try it, in a quiet moment:

```sh
cloud/deploy.sh RestrictIotLoggingTrust=true
# Restart a board, then look for its Connect entry. Look again some hours later, in
# case AWS IoT was still using a session it had already assumed.
cloud/logs.sh iot --since 10m
# If the entries have stopped:
cloud/deploy.sh RestrictIotLoggingTrust=false
```

## Tear down

```sh
cloud/teardown.sh
```

After you have typed the stack name, it removes everything: the jobs, the boards'
things and certificates, both stacks, and also what the stack keeps on purpose when it
is deleted (the user pool with its accounts, the firmware bucket with every image, the
three tables, whose deletion protection it switches off first). It can be run again if it
stops halfway. Boards have to be provisioned again after a new deployment.

It leaves three things alone: the budget stack (`infra/budget.yaml`, a monthly cost alert
that is deployed on its own), the trail with its log files (`infra/trail.yaml`), and the
log group `AWSIotLogsV2`, which belongs to AWS IoT in this account and not to the stack.
Its entries expire with its retention period.

## The fleet

Board types, groups and staged rollouts ([docs/fleet.md](../docs/fleet.md); how the console does them is in
[docs/aws-iot.md](../docs/aws-iot.md#the-fleet-board-types-groups-and-staged-rollouts)). All of it is on the **Fleet**
page, and some of it on the others.

- **Compatibility.** A release shows what its image is built for, "For nRF7002 DK · layout 1": the board type and the
  flash layout, read from its signed TLVs (`0xA1`, `0xA2`), which the build sets from `CONFIG_APP_BOARD_TYPE` and
  `CONFIG_APP_IMAGE_LAYOUT`. An image without them is for the `nrf7002dk`, layout 1. One version is one image:
  versions are one sequence for all types, so a build for another type takes the next number. Provision a board
  without Wi-Fi with `tools/provision_device.py --board nrf5340dk` so that its thing says what it is; a board on
  1.13.0 or later says its type and layout itself. A board's page has its Compatibility; the New deployment dialog
  only offers a release to the boards of its type and layout, and the API refuses any other
  (`incompatible_board`, `incompatible_layout`). The Devices page marks a board without Wi-Fi as "Bluetooth only",
  with the version a phone last saw on it, and the Overview counts it apart from boards that never connected.
- **Groups.** Release managers make, rename, change and delete them on the Fleet page or the Devices page. A board
  can be in several. Every board is also in the group of its type.
- **Staged rollouts.** A deployment of more than one board from the website, a rollout to a group (its "Roll out"
  button), and each type of "Update everything" start with a canary, one board unless you ask for more. Its page
  (`#/rollouts/<id>`) shows the canary, then the waves once the canary has confirmed, what was left out and why, and
  why it stopped. The waves are started by `RolloutTickFn` within a minute of the canary's confirmation; a
  deployment to one board, and every deployment from the API (`POST /api/deployments`), is one job as before.
- **Update everything** reviews, by type, the newest release, the boards it goes to and the ones it leaves out, and
  starts one staged rollout per type.
- **Roll back** (on a group, when an older release of one of its types is active) reviews the release before the
  newest. A board refuses firmware that is not newer than what it runs, so it reaches only boards behind both
  releases, and the review marks the others "Would refuse it". A real roll-back is a rebuild of the old source under
  a newer version, released and rolled out like any other.
- **A release's note.** "Edit note" on any release, revoked ones too. Scripts set it with an API token:
  `curl -X PUT -H "Authorization: Bearer $CRANIUM_TOKEN" -H 'content-type: application/json'
  -d '{"notes":"…"}' "$CONSOLE/api/t/firmware/1.11.3%2B0/notes"`.

Limits: at most 50 groups of up to 100 boards each; a rollout takes at most 100 boards and a canary at most 5;
the first wave is 1 to 50 boards a minute; the abort threshold is 1 to 100% (default 20%); 60 sightings a minute
per person. The function that moves rollouts on logs to `/aws/lambda/<stack>-rollouts`.

## The map, commands and alerts

The rest of [docs/fleet.md](../docs/fleet.md); how the console does it is in
[docs/aws-iot.md](../docs/aws-iot.md#the-fleet-the-map-commands-and-alerts).

- **Map.** The **Map** page shows every board where the Wi-Fi it hears puts it, from firmware 1.13.0: a marker in
  the colour of its state, a shaded circle for how sure the position is, and a popup with its name, thing,
  firmware, whether it is online, when it was placed and how closely. Beside it, the same boards as a list, and the
  boards that are not on the map with why (Bluetooth only, no scan yet, too few access points, AWS could not place
  it). A board's page has a small map of its last 20 positions. The map's tiles come from OpenStreetMap: opening it
  fetches them from `tile.openstreetmap.org`, which learns the viewer's address and roughly where the boards are.
  Positions cost US$1.00 per 1,000 (the first 1,000 free in an account's first year); a board makes a few a day.
- **Identify** (a button on every board's row and page) makes the board blink LED1 and LED2 for 15 s; **Report now**
  (the menu on its page) makes it send its heartbeat, diagnostics and a Wi-Fi scan at once. Release managers only,
  at most 10 a minute each, on record as `board.command`. The board's answer shows on its page when its log brings
  it (tag `CMD`). An offline board misses the command; firmware before 1.13.0 does not hear it at all. From a script:
  `curl -X POST -H "Authorization: Bearer $CRANIUM_TOKEN" -H 'content-type: application/json' -d '{"cmd":"identify"}'
  "$CONSOLE/api/t/devices/<thing>/commands"`.
- **Alerts by e-mail.** On the **Account** page (the address in the masthead), a release manager asks for alerts at
  their own address and confirms the e-mail from AWS Notifications; "Stop the alerts" there, or the link in any
  alert, stops them. An alert for a board offline for more than 15 minutes and back, an update that failed or rolled
  back, a restart for being stuck, and a board that moved more than 1 km; at most one e-mail per board and kind an
  hour, with what happened in between in the next one. The page lists the e-mails sent lately. Removing someone from
  `release-managers` does not stop their alerts: unsubscribe them too (`aws sns list-subscriptions-by-topic
  --topic-arn <AlertTopicArn>`, the stack output of `cranium-ota`, then `aws sns unsubscribe --subscription-arn <arn>`).

The first deployment with these makes a new topic, a rule and a function, and changes the device policy in place
(a new version of `cranium-device`: see docs/aws-iot.md, "What a board may do"). The location function logs to
`/aws/lambda/<stack>-location` (`cloud/logs.sh location`), one line per scan, never what the scan held.

## Try it without AWS

```sh
node cloud/dev/preview.mjs --scenario waiting-for-button    # --help lists the scenarios
```

A local preview on `127.0.0.1`: the real console and the real API, with an in-memory
stand-in for AWS, an emulated sign-in with a made-up password and code that the preview
prints (the console's own page, with the real sign-in trigger deciding the token's scope),
and simulated boards. It talks to nothing outside this computer, shows no real data, and is
never deployed. Add `--live` to let the boards act and press their buttons from the
terminal, as firmware before 1.7.2 has them do, which is what these boards run. To see the
console as a viewer does, sign in with the viewer's address, or add `--viewer` for "Use the
AWS sign-in page". `--home` shows the public home page instead, served by the real web
function as one of its home page names. `--customer` shows the customer site, with the
console as admin mode at `/admin`; `--scenario customers` gives it customers and boards
([docs/customer-site.md](../docs/customer-site.md#trying-it-without-aws)).

While a scenario is built the boards that are on report every minute, and every report and
connection goes through the recorder's own code, so the Events and Diagnostics pages have a
history. `--scenario fleet` has two days of three boards with an event of every kind and a
board on firmware 1.10.0 with its diagnostics, and for the Fleet page two nRF5340 DKs that a phone has seen, a
release of each type, two groups and a staged rollout whose wave waits for a board that is offline. Its images
are built for the run and signed with a key the preview makes (`api/test/images.mjs`), so in that scenario a
fixture image is refused as signed with another key. The preview runs the rollouts' schedule every minute.
The same scenario puts boards on the Map page: the boards on 1.13.0 send scans of made-up access points of a campus
(addresses of the range kept for documentation), which a stand-in for AWS IoT Core Device Location places around
Penn's engineering buildings; one is carried 1.6 km to Pennovation Works, and one hears too few. Those boards answer
Identify and Report now in their log. The e-mail alerts are made as when deployed and listed on the Account page,
and the terminal prints each one; none is sent anywhere.

The stand-in refuses a forced cancellation of a deployment that is cancelled already
(see "A board at work on a cancelled deployment" above). `--repeated-cancel accepted`
and `--repeated-cancel ignored` show the console in the two other cases that AWS could
turn out to be.

## Layout

```
deploy.sh  users.sh  smoke.sh  logs.sh  teardown.sh  trail.sh
infra/bootstrap.yaml   the artifacts bucket
infra/template.yaml    the console: API, sign-in, storage, AWS IoT
infra/budget.yaml      cost alert, separate stack
infra/trail.yaml       record of what is done in the account, separate stack
api/                   the API function (src/) and its tests (test/); verify-audit.mjs,
                       which compares the activity log with its digests, and verify-image.mjs,
                       which makes the console's check on an image, are not deployed;
                       src/customer/ is the customer site's API, a function of its own
web/                   the function that serves the console, the home page and the customer
                       site (src/, src/customer/), and its tests (test/)
dev/                   local preview and its tests, never deployed
```

The tests need neither AWS nor any package: `node --test` in `cloud/api`, in `cloud/web`
and in `cloud/dev`. Those in `cloud/dev` run the console's own client against the real
API handler, so they notice when the two stop agreeing.
