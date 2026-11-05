# The customer site

The website customers sign in to, on the name the team bought for it, with an **admin mode** for the team that opens
the firmware console. Customers see their own boards and nothing else; admins hand out the accounts and the boards from
the console's new **Customers** page. It is part of the console's stack (`cloud/`), and nothing of it is live until the
stack is deployed with the site's name (below). Console version 2.0.0.

Below, `example.com` stands for the customer site's name: the domain the owner bought.

## What a visitor sees

| Address | Who | What |
| --- | --- | --- |
| `https://example.com/` | anybody | The home page: what Cranium is, what an account shows, how updates work, what is coming, where the project stands. Plain HTML, readable without JavaScript |
| `#/sign-in` | customers | E-mail and password; the code of an authenticator app, in six boxes, if the customer turned one on; a new password at the first sign-in |
| `#/forgot` | customers | A password reset with a code e-mailed by Cognito |
| `#/admin-sign-in` | the team | The staff account of the console: e-mail, password and code, always |
| `#/overview` | a customer | Four figures (online now, boards, firmware, last heard from), the boards, what they did in the last week, and what is coming for mixes |
| `#/overview` | an admin | Who is signed in, and **Open admin mode** |
| `#/devices`, `#/devices/<id>` | a customer | The boards as a table; one board's state, firmware, last report, update, Wi-Fi signal, uptime and the last 30 days of what it did |
| `#/mixes/<tab>` | signed in | Sessions, Transitions, Track library, Saved moments: **not built yet**, and the page says so |
| `#/account` | a customer | Their address, a password change, two-step sign-in on or off, sign out |
| `#/help` | anybody | Questions and answers about the board, its updates and the account |
| `https://example.com/admin` | the team | **Admin mode**: the firmware console itself, with a way back ("Leave admin mode") |
| `https://www.example.com/...` | anybody | Sent to `https://example.com/` (or `/admin`), so that there is one origin |

The pages follow the mockup the owner chose (a studio sidebar, a top bar with how the boards are, figures, the boards,
what happened, the mixes; at 390 px a bar of sections at the foot), in the console's own design: its colours for light
and dark, its type, its buttons, badges, cards, fields and six boxes, with one ink panel per page. At 390 px the sidebar
gives way to that bar. Every field has a label, every state has a word or an icon as well as a colour, and focus moves to
each page's heading.

### What is shown, and what is not built

The mockup is a DJ journal: sessions, transitions, a track library and saved moments, synced from the board. Cranium's
boards do not report what is played: that needs the Raspberry Pi to record what Mixxx plays and the board to pass it on,
and neither is built. So the site is built on what the boards do report, and the rest is a placeholder that says so:

| Mockup | Here |
| --- | --- |
| Overview: hero, four figures, the last set, On repeat, a moment to come back to | Hero, four figures from the boards (online, boards, firmware, last report), the boards, the last week of what they did, and a card on the mixes to come |
| Board offline / Connect device (Web Bluetooth) | How many boards are online. Connecting a board to the browser is **not built** |
| Sessions, Transitions, Track library, Saved moments | **Not built yet**: one page with the four tabs, each saying what it will hold and why it is empty. No made-up tracks |
| Import session, Export set, journal backup, the date range | **Not built** (there is nothing to import or export yet) |
| (not in the mockup) | Devices, a board's page, Account, Help, the sign-in pages, admin mode |

Also not built: a board's **location** (the fleet work's location by Wi-Fi, `docs/fleet.md`; the page says "Not reported"),
a **QR code** for setting up an authenticator app (the setup key is shown in groups of four, with a copy button and an
`otpauth://` link that opens the app on a phone), a **sign-up** page, a **support address** (Help says there is none yet),
and **updates started by a customer**: the mockup has none, so updates stay with admins, on the console.

## Accounts

Two Cognito user pools, kept apart on purpose:

| | Staff pool (`UserPool`) | Customer pool (`CustomerUserPool`) |
| --- | --- | --- |
| Who | The team: release managers and viewers | Customers |
| Made by | `cloud/users.sh add` | The console's Customers page (Cognito `AdminCreateUser`) |
| Self sign-up | Never | Off, behind `CustomerSelfSignUp` (default `false`); the site has no sign-up page |
| Sign-in name | E-mail | E-mail, case-insensitive |
| Password | 12 characters, all four kinds | At least 10 characters, nothing else asked |
| Code | Always (`MFA ON`) | If the customer turns it on (`OPTIONAL`), on the Account page |
| Recovery | An admin only (`users.sh reset-mfa`) | A code to the verified address ("Forgot your password?") |
| Temporary password | 3 days | 7 days |
| Plan | Essentials | Essentials |
| Clients | The console's and the phone apps' | `CustomerUserPoolClient`: SRP only, no OAuth, no managed login, `PreventUserExistenceErrors` on, token revocation on, access token 60 minutes, may write `name` only |

The customer site signs in on its own page with the console's own code, `createAuth` in
`cloud/web/src/site/assets/core.js`, which the site serves byte for byte, not a copy: SRP, so the password never leaves
the browser; the code in the same six boxes; the refresh token revoked at once, so that none is kept. Two small
additions made that possible: with no `loginOrigin` (no managed login pages) the refresh token is revoked through the user
pool API (`RevokeToken`) and a sign-out goes back home; and with `newPasswordHere` a first sign-in's new password is asked
for on the page. The console itself works as before.

A customer's token never opens the console's API, and a staff token never opens the customer API:

- **At the gateway.** The console's authorizer keeps the staff pool as issuer and the staff clients as audience.
  `GET /api/c/{proxy+}` has an authorizer of its own, issuer the customer pool, audience the customer site's client, and
  asks for the scope every access token of the user pool API carries (`aws.cognito.signin.user.admin`), so an ID token is
  refused. There is no `POST /api/c/`: a POST there meets the console's authorizer, which refuses a customer's token.
- **In the functions.** The console's API checks `client_id` against the staff clients, as before. The customer API
  checks `token_use`, `client_id` and `iss` again, and asks Cognito whether the account is on (kept for a minute).
- **By role.** The customer API is a function of its own (`CustomerApiFn`), whose role may query the ownership partition
  of the state table (`dynamodb:LeadingKeys` = `OWN`), query the events table, read the boards' shadows and look up a
  customer: no firmware, no deployments, no activity log, no staff pool, no writes.

## Admin mode

Admins are the staff pool's people, today's release managers (a viewer who signs in sees admin mode too, read only, as on
the console). On the customer site, **Admin sign-in** asks for the staff account's e-mail, password and code, always. A
signed-in admin sees **Admin mode** (in the sidebar, the top bar on a phone, and the admin overview), which opens the
console at `/admin` of the same name, signed in already. The console's account box then has **Leave admin mode**.

**Why the console is served under the customer site's name, not only on its own host:**

- **One sign-in, no token in an address.** A browser keeps `sessionStorage` per origin and per tab. On one origin the
  admin's session is in the tab when the console opens at `/admin`, under the console's own keys; on another host the
  console could only get it by a second sign-in, or by putting a token in an address, which this design never does.
- **CSP stays as strict.** Each page keeps its own policy: the customer site may talk to its own origin and to Cognito's
  user pool API (`https://cognito-idp.<Region>.amazonaws.com`, one origin for both pools because they are in the same
  Region), and requires Trusted Types; `/admin` keeps the console's policy unchanged. Neither page can be framed, and
  neither loads anything from another origin. Both are only this project's own scripts (`script-src 'self'`, no inline
  code, no CDN), so sharing an origin shares no trust that was not shared already.
- **No CORS to open.** Every request either page makes to the API is same-origin (`/api/...`, `/api/c/...` on the same
  name), and Cognito's user pool API already answers browsers from any origin. The API sends no CORS headers, as before.
- **The two sessions do not mix.** A customer's session is kept under keys of its own (`customer:cranium.session`), an
  admin's under the console's; each sign-out clears its own keys and tells the other tabs of its kind. A customer's token
  is never sent to the console's API by the site, and would be refused if it were.
- **Simple.** No second host to configure for admins: the console keeps its own name (`ConsoleDomainName`) as well, and
  the staff client gains one return address, `https://example.com/admin`, for the console's "Use the AWS sign-in page"
  and its sign-out.

What it costs: an XSS bug in the customer site could act with an admin's session in the same tab. The site writes
nothing but text into the page (views.js `render()`), forbids inline script, and requires Trusted Types, so that a
string cannot become markup or script even if a bug tried.

## Ownership

A board belongs to one customer at most. An admin gives a board from the Customers page; the item is
`pk = OWN, sk = <thing name>` in the state table, with the owner's `sub`, an **assignment id** (16 hex digits drawn
from the CSPRNG), an optional name the admin gives it (what the customer sees), and when and by whom. A customer reaches
a board only by that id, among the boards they own now: never by its thing name, which the customer API never sends.
Taking a board back removes the owner; giving it to someone else draws a new id, so a link an earlier owner kept leads
nowhere. Another customer's board answers as if it did not exist (404).

What a customer is sent of a board: its name, its own device name, online/offline/updating/restarting, the firmware
version and whether it is on trial, when it was last heard from, the update's step, progress and last result, the Wi-Fi
signal and uptime, and when it became theirs. Of its events: connected, disconnected, firmware reported/changed/kept,
an update waiting or downloading and how it ended, restarts and the Bluetooth window, as typed fields; never the
console's own text, a job id, an error string, a MAC address, memory figures or anything of AWS.

## Routes and rights

| Route | Who | On record |
| --- | --- | --- |
| `GET /api/c/me`, `/api/c/boards`, `/api/c/boards/{id}`, `/api/c/activity` | a customer, their own only | no |
| `GET /api/customers` | release managers, asked of Cognito now | no |
| `POST /api/customers` `{ email, name? }` | release managers | `customer.create` |
| `POST /api/customers/{id}/resend` | release managers | `customer.resend` |
| `POST /api/customers/{id}/boards` `{ thing, label? }` | release managers | `customer.assign` |
| `POST /api/customers/{id}/boards/{thing}/remove` | release managers | `customer.unassign` |
| `POST /api/customers/{id}/disable`, `.../enable` | release managers | `customer.disable`, `customer.enable` |

The Customers routes are for the website only: a phone app's session (`phone_not_allowed`) and an API token
(`token_not_allowed`) are refused. Every request to them leaves one entry in the activity log, refusals included, which
the console reads as sentences ("invited the customer ...", "gave CRVIHAAN01 to ..."). A customer's own reads are not
recorded. An invitation waits for the site to have an address: until `CustomerDomainName` is set the API refuses it
(`customer_site_has_no_address`), because the e-mail would name no site; boards can be given out before.

## Setting up the name

The customer site needs a certificate for the name and `www.`, a deployment with the name, and two DNS records. Nothing
changes until both parameters are set: with them empty there is no customer site, no invitation goes out, and every
other name answers as before.

1. **Request one certificate for both names**, in the stack's Region (`us-east-1` unless `AWS_REGION` says otherwise),
   and read the two records that prove you own them:

   ```sh
   aws acm request-certificate --domain-name example.com \
     --subject-alternative-names www.example.com --validation-method DNS
   aws acm describe-certificate --certificate-arn <arn> \
     --query 'Certificate.DomainValidationOptions[].ResourceRecord'
   ```

2. **Add both validation records** at the DNS provider as CNAMEs (at Cloudflare with the proxy off, "DNS only"), and
   keep them: the certificate renews through them. Wait until its status is `ISSUED`:

   ```sh
   aws acm describe-certificate --certificate-arn <arn> --query Certificate.Status
   ```

3. **Deploy with the name and the certificate.** Give the name without `www.`:

   ```sh
   cloud/deploy.sh CustomerDomainName=example.com CustomerCertificateArn=<arn>
   ```

   The outputs `CustomerDomainTarget` and `CustomerWwwDomainTarget` are the two DNS targets, and `CustomerUrl` the
   address:

   ```sh
   aws cloudformation describe-stacks --stack-name cranium-ota \
     --query "Stacks[0].Outputs[?starts_with(OutputKey, 'Customer')].[OutputKey, OutputValue]" --output text
   ```

4. **Point the names at the targets.** The bare name cannot have an ordinary CNAME, so it needs a provider that
   flattens one, or an ALIAS/ANAME record. Never an A record with addresses copied from the target: they change.
   - **Cloudflare:** a CNAME on `@` (the bare name) to `CustomerDomainTarget`, and a CNAME on `www` to
     `CustomerWwwDomainTarget`, both "DNS only". Cloudflare flattens the one on the bare name by itself. If the name
     redirects somewhere today (a parking page, a forwarding rule), remove that first.
   - **Another registrar:** on the bare name, an **ALIAS**, **ANAME** or "CNAME flattening" record to
     `CustomerDomainTarget`, whatever the registrar calls it; on `www`, a CNAME to `CustomerWwwDomainTarget`. If the
     registrar has no such record for the bare name, move the name's DNS to a provider that has one (Cloudflare's free
     plan, or Route 53, where it is an alias record to the API Gateway domain name), keeping the registration where it is.

5. **Check it.** The page should answer 200 with a policy that names Trusted Types, `www.` should answer 308, and admin
   mode should be the console:

   ```sh
   curl -sS -o /dev/null -D - https://example.com/ | grep -i -E '^(HTTP|content-security-policy)'
   curl -sS -o /dev/null -D - https://www.example.com/ | grep -i -E '^(HTTP|location)'
   curl -sS https://example.com/admin | grep -c 'Firmware console'
   ```

`Strict-Transport-Security` with `includeSubDomains` is sent on these pages too, for two years: once a browser has been
to the bare name, it refuses plain HTTP on every name under it, names added later included. The customer site shares the
page routes' request limit and the web function with the console and the home page (cloud/README.md, "The home page");
the customer API has a request limit of its own (`GET /api/c/{proxy+}`: 20 at once, 10 a second).

## The admins' accounts

The four admins (the owner, Adam, Christian and Demetrius) are staff pool accounts, made after the deployment as every
console account is. Their addresses are in the team table of the [root README](../README.md#31-team-formation) (3.1),
and are not repeated here:

```sh
cloud/users.sh add <the owner's e-mail> release-manager
cloud/users.sh add <Adam's e-mail> release-manager
cloud/users.sh add <Christian's e-mail> release-manager
cloud/users.sh add <Demetrius's e-mail> release-manager
```

Each gets the console's invitation, signs in once on the console (choosing a password and an authenticator app there),
and from then on can use **Admin sign-in** on the customer site. A person who already has a console account needs nothing
new.

## Inviting a customer

On the console (or in admin mode): **Customers**, **Invite a customer**, the address and, if you like, a name. Cognito
e-mails the invitation with a temporary password that works for 7 days and names the site. **Send the invitation again**
while it is unused. **Give a board** picks one of the boards nobody has, with an optional name the customer sees.
**Take back** and **Switch off** ask once more before they act. A customer switched off cannot sign in, and stops
reading within a minute. An account deleted from the pool by hand still shows ("Account gone") with its boards, so that
they can be taken back.

## Known limits

- **E-mail.** The customer pool sends with Cognito's own e-mail, which allows about 50 messages a day, from a Cognito
  address. Many customers at once need Amazon SES configured on the pool (not done here).
- **A token that was copied** goes on working at the gateway until it expires (60 minutes), as on the console; the
  customer API asks Cognito whether the account is on, at most a minute late. Turning two-step sign-in off needs no
  password again: whoever holds an open session can do it.
- **The masthead.** The console's Customers item means the account box takes a second row at 1440 px wide; below
  1280 px it did already.
- **The phone apps** do not have the Customers page. Their activity log reads the new entries in the website's words
  (Android `Audit.kt`, iOS `Words.swift`, held to it by `WebsiteListsTest`, `AuditParityTest` and `ParityTests`).
- **On a stack that exists, the customer pool is created with deletion protection on**, like the events table was; if
  that update failed and rolled back, CloudFormation could not delete the new pool, and it would have to be removed by
  hand. `cloud/teardown.sh` deletes it with the rest.
- **Not tried on AWS.** Everything above runs in the tests and the local preview (below); the gateway's authorizers, the
  certificate, the DNS and Cognito's e-mail are checked only by a deployment.

## Trying it without AWS

```sh
node cloud/dev/preview.mjs --customer --scenario customers
```

The real customer site and admin mode, the real customer API and console API, with stand-ins for both pools (SRP, the
code, a first sign-in's new password, a password reset) and the customer pool's authorizer. The scenario has Ada with two
boards, Ben with one, Cleo with an unused invitation, and a board nobody has; the preview prints the made-up passwords.
`cloud/dev/customer.test.mjs`, `cloud/web/test/customer.test.mjs` and `cloud/api/test/customers.test.mjs` are its tests.

## Where the code is

| | |
| --- | --- |
| `cloud/web/src/customer/` | The site: its page (with the home page), `customer.js`, `customer-core.js`, `customer-views.js`, `customer.css` |
| `cloud/web/src/customer-site.mjs` | How the web function loads it, with the console's three shared files, and its policy |
| `cloud/web/src/server.mjs` | `CUSTOMER_HOSTS`: the site, `/admin`, `www.` |
| `cloud/web/src/site/assets/customers.js` | The console's Customers page |
| `cloud/api/src/customer/` | The customer API (`app.mjs`, entry `customer.mjs`), what a customer is shown (`boards.mjs`), its adapters (`aws.mjs`) and settings |
| `cloud/api/src/handlers/customers.mjs` | The console's Customers routes |
| `cloud/infra/template.yaml` | `CustomerUserPool`, `CustomerUserPoolClient`, `CustomerAuthorizer`, `CustomerApiReadRoute`, `CustomerApiFn` and its role, `CustomerDomain`, `CustomerWwwDomain` |
