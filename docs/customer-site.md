# The customer site

The website customers sign in to, on the name the team bought for it, with an **admin mode** for the team that opens
the firmware console. Customers see their own boards and nothing else; admins hand out the accounts and the boards from
the console's new **Customers** page. It is part of the console's stack (`cloud/`), from console 2.0.0.

**It is live at https://craniumiot.com**, first deployed with console 2.1.0 (bcc5a19): the customer sign-in, and an admin
sign-in that leads to admin mode, the console at https://craniumiot.com/admin. From console 2.4.5
the two are one form ([Signing in](#signing-in)). https://www.craniumiot.com sends the
browser to the bare name. The team's console also stays on its own name, https://console.craniumiot.com. The public home
page that used to be on craniumiot.com is no longer deployed (`HomeDomainName` is empty), and the customer site uses
the certificate it had, which covers both names. DNS is at Cloudflare, with "DNS only" CNAMEs.

Below, `example.com` stands for the customer site's name, so that the steps fit any name.

## What a visitor sees

| Address | Who | What |
| --- | --- | --- |
| `https://example.com/` | anybody | The site's own front page: what Cranium is, what an account shows, how updates work, what is coming, where the project stands. Plain HTML, readable without JavaScript |
| `#/sign-in` | everybody | One form: e-mail and password; then the code of an authenticator app, in six boxes, when the account asks for one (a team account always); a new password at a customer's first sign-in. A team account lands in admin mode at `/admin` |
| `#/forgot` | everybody | A password reset with a code e-mailed by Cognito |
| `#/overview` | a customer | The mixes as the mockup has them (the card "After the last track", four figures, the last set with its shape and tracks, On repeat, a moment to come back to), then the boards: four figures, the boards with each one's health and week of restarts, and what they did in the last week |
| `#/overview` | an admin | Who is signed in, and **Open admin mode** |
| `#/devices`, `#/devices/<id>` | a customer | The boards as a table, each with a health dot; one board's health this week (a sentence and its restarts by day), state, firmware, last report, update, Wi-Fi signal, uptime and the last 30 days of what it did |
| `#/mixes/<tab>` | signed in | Sessions, Transitions, Track library, Saved moments, of the demo or of the customer's own journal (below) |
| `#/sessions/<id>` | signed in | One session: its shape on the two decks, every track, its transitions, Export set, and Remove for one of the journal |
| `#/account` | a customer | Their address, a password change, two-step sign-in on or off, sign out |
| `#/help` | anybody | Questions and answers about the board, its updates and the account |
| `#/about` | anybody | What Cranium is, the problem it solves and who it is for, and the team ([About](#about), below) |
| `https://example.com/admin` | the team | **Admin mode**: the firmware console itself, with a way back ("Leave admin mode") |
| `https://www.example.com/...` | anybody | Sent to `https://example.com/` (or `/admin`), so that there is one origin |

The pages follow the mockup the owner chose, in the console's colours for light and dark: a dark sidebar of the
workspace (Overview, Sessions, Transitions, Track library, Saved moments with how many are kept) and of the boards
(Devices, Account, Help, About), with "Your deck, a little more connected" and Connect your board at its foot; a top bar with
how many boards are online, Export, and **Connect device**; each page's title with the range (all time, 7 or 30 days)
and **Import session**; and the switch between **Explore demo** and **My journal**. At 390 px the sidebar gives way to
a bar of five sections at the foot (Overview, Sessions, Transitions, Library, Devices), and Account is in the top bar.
About and Help are also in the foot of every page, the home page's top bar and foot, and the sign-in page.
Every field has a label, every state has a word or an icon as well as a colour, and focus moves to each page's heading.

### About

`#/about` (`aboutView` in `customer-views.js`) says what Cranium is, the problem and who it is for, from the
README's concept (3.2), and shows the team: four founders, each with a photo or, until there is one, their initials
in a circle in the site's accent colours. It is public: signed out it opens on its own with Sign in, as Help does,
including in the phone apps, where it is linked from the sign-in page; signed in it is in the studio's frame.

The photos are not image files on the site: the phone apps' bundle holds only text files, and every app already
installed refuses a bundle with any other kind. They are kept in `cloud/web/team-photos/` and written as `data:`
addresses into `customer/assets/customer-team-photos.js` by `node cloud/web/build-team-photos.mjs`. Both the site's
policy and the apps' allow `data:` images, so nothing in either policy changed. The tests check that the module is
what the script writes from the folder, and that each photo is at most 60 KB.

To put a real photo in place of a placeholder:

1. Make it square, about 320 by 320, and at most 60 KB: for example
   `cwebp -q 78 -resize 320 320 -metadata none photo.png -o demetrius-bosket.webp`.
2. Name it for the person, as the first one is: `vihaan-ravishankar.webp`, `demetrius-bosket.webp`,
   `adam-shalabi.webp`, `christian-durante.webp` (`.jpg` or `.png` work too), and put it in `cloud/web/team-photos/`.
3. Run `node cloud/web/build-team-photos.mjs`, and commit the photo with `customer-team-photos.js`.

The photo's alt text is the person's name. Nothing else about a person is on the page.

### The mixes: the demo, and the customer's own journal

The mockup is a DJ journal: sessions, transitions, a track library and saved moments, synced from the board. Cranium's
boards do not report what is played yet: that needs the Raspberry Pi to record what Mixxx plays and the board to pass it
on, and neither is built. So the mixes come from two places (`customer-mixes.js`, its pages in `customer-mix-views.js`):

- **Explore demo**: three made-up sessions of made-up tracks, dated from today so that the ranges show something. Every
  page that shows them says so ("Made-up sessions, to show what this will be"), and each card has a Demo tag.
- **My journal**: the sessions the customer imports, kept under their e-mail address in their browser's `localStorage`, or in the phone app
  (`storage.*`, [docs/mobile-apps.md](mobile-apps.md)), never on Cranium's servers. A file is a CSV of tracks, one line each (`session, started, title, artist, deck, start,
  end, bpm, key`; only `started` and `title` are needed, times in seconds or m:ss from the start of the set), or a JSON
  file of this site (`"format": "cranium-mixes", "version": 1`). At most 1 MB, 200 sessions of 400 tracks; every field is
  checked and cut to size, and a session imported again replaces itself. The journal is empty until a file is imported,
  and says why. In the phone app the page's storage may not last: the journal is then kept while the page is open.

What each page works out, the same for both:

| Page | What |
| --- | --- |
| Overview | Time on the decks (two decks at once counted once), sessions, tracks played and how many different, overlaps; the last set; the four most played tracks; the longest overlap of the last set, to keep |
| Sessions, one session | Each set's shape on decks A and B, its tracks in the order they started with deck, BPM, key and when, a search, Export set (CSV) |
| Transitions | Each pair of tracks in start order, their BPMs, how long both played (when both tracks' times are known), and a bookmark to keep it |
| Track library | Every track, the most played first, with its plays, BPM and time on the decks, and a search |
| Saved moments | The pairs kept, each with the customer's own note (500 characters), to edit or forget |

Export (the top bar) backs the journal up as JSON, which Import brings back, or writes every track as a CSV, where a
cell that starts like a formula starts with a quote instead. In the app, a file goes to the phone's share sheet.
**Connect device** says what is built (the board's reports and its updates) and what is not (the Pi and the board passing
on what is played), how many boards are online, and offers Import and a sample file instead. Nothing rates a blend: an
overlap is only how long two tracks played at once.

Also not built: a board's **location** (the fleet work's location by Wi-Fi, `docs/fleet.md`; the page says "Not reported"),
a **QR code** for setting up an authenticator app (the setup key is shown in groups of four, with a copy button and an
`otpauth://` link that opens the app on a phone), a **sign-up** page, a **support address** (Help says there is none yet),
**updates started by a customer** (the mockup has none, so updates stay with admins, on the console), and **Web
Bluetooth** from the site to a board (the firmware sends no tracks to pass on yet).

## Accounts

Two Cognito user pools, kept apart on purpose, behind one sign-in form (below).

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
| Clients | The console's and the phone apps' | `CustomerUserPoolClient`: SRP only, no OAuth, no managed login, `PreventUserExistenceErrors` on, token revocation on, access token 60 minutes, may write `name` only. `CustomerMobileUserPoolClient` (console 2.0.1), the phone apps' ([docs/mobile-apps.md](mobile-apps.md#customers)): the same, with a refresh token of 30 days that an app keeps only behind Face ID or a fingerprint |

The customer site signs in on its own page with the console's own code, `createAuth` in
`cloud/web/src/site/assets/core.js`, which the site serves byte for byte, not a copy: SRP, so the password never leaves
the browser; the code in the same six boxes; the refresh token revoked at once, so that none is kept. Two small
additions made that possible: with no `loginOrigin` (no managed login pages) the refresh token is revoked through the user
pool API (`RevokeToken`) and a sign-out goes back home; and with `newPasswordHere` a first sign-in's new password is asked
for on the page. The console itself works as before.

### Signing in

One form for everybody (console 2.4.5, `signInEither` in `customer-core.js`). The e-mail address and the password go to
the staff pool first, with USER_SRP_AUTH and the console's client, the address in lower case (the staff pool's names
are case-sensitive, and `users.sh` keeps them lower case). Only if that pool says the address or the password is
wrong do they go to the customer pool, the same way. So:

- **One try at each pool, at most**, per submission: each pool's own throttling and lockout count every try, and their
  words ("Too many tries. Wait a minute.") are shown as before. A throttled staff pool stops there.
- **One refusal for both**: "The e-mail address or password is wrong.", whichever pool refused. Both pools have
  `PreventUserExistenceErrors` on, so neither says whether it has the address, and the page never says which pool has
  the account.
- **After the password, the account's own steps**: a staff account's code, always; a customer's code if they turned
  two-step sign-in on, and their new password at the first sign-in. A staff account that needs a step only the
  console's sign-in does is sent there.
- **Where it lands**: a staff account goes to admin mode, the console at `/admin`, with the session under the console's
  own keys, as the admin sign-in of before did; a customer to the page they asked for, or the Overview. An admin whose
  session is already in the tab opens `/admin` directly, as before.

**Forgot your password?** is one form too. It asks both pools for a code, one request each: the staff pool hides
addresses it does not have and answers as if a code went out, so its yes proves nothing and the customer pool is always
asked as well. The code and the new password go to the staff pool first; if it takes them the reset is done there,
otherwise they go to the customer pool. The page says the same either way: "If <address> has an account, a code is on
its way to it." The staff pool's recovery is admin-only (`users.sh reset-mfa`), so in practice the e-mailed code is a
customer's.

The console's own sign-in page, on its own name, stays staff-only: only staff accounts exist there.

A customer's token never opens the console's API, and a staff token never opens the customer API:

- **At the gateway.** The console's authorizer keeps the staff pool as issuer and the staff clients as audience.
  `GET /api/c/{proxy+}` has an authorizer of its own, issuer the customer pool, audience the customer site's client and
  the phone apps' client of the customer pool, and
  asks for the scope every access token of the user pool API carries (`aws.cognito.signin.user.admin`), so an ID token is
  refused. There is no `POST /api/c/`: a POST there meets the console's authorizer, which refuses a customer's token.
- **In the functions.** The console's API checks `client_id` against the staff clients, as before. The customer API
  checks `token_use`, `client_id` and `iss` again, and asks Cognito whether the account is on (kept for a minute).
- **By role.** The customer API is a function of its own (`CustomerApiFn`), whose role may query the ownership partition
  of the state table (`dynamodb:LeadingKeys` = `OWN`), query the events table, read the boards' shadows and look up a
  customer: no firmware, no deployments, no activity log, no staff pool, no writes.

## Admin mode

Admins are the staff pool's people. All four of the team are release managers, the console's top role (a viewer who
signs in would see admin mode too, read only, as on the console). On the customer site an admin signs in on the one
form, with the staff account's e-mail, password and code, and lands in admin mode. On the site itself a signed-in admin
sees **Admin mode** (in the sidebar, the top bar on a phone, and the admin overview), which opens the
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

## Board health

Every board a customer sees has a health line in plain words, a dot (green for running normally, amber for attention,
an empty ring for offline) and a strip of the last seven days with its restarts by day, the unexpected ones in amber.
The Overview shows the line and the strip under each board, the Devices table the dot and the line, and a board's page
a "This week" card. The customer API works it out (`cloud/api/src/customer/health.mjs`) from the restart, firmware and
update events of the last 7 days, which its role already reads; it reads them at most once a minute per board, while
offline comes from the shadow at every request. Restarts are only expected or unexpected: no fault name, reset cause,
coredump or stack reaches a customer ([customer-data.md](customer-data.md#board-health)). The phone apps' customer mode
loads the same site, so it shows the same.

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
other name answers as before. For craniumiot.com this is done: the certificate is the one the old home page had, and
the two records are at Cloudflare.

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
page routes' request limit and the web function with the console (cloud/README.md, "Request limits"); the customer API
has a request limit of its own (`GET /api/c/{proxy+}`: 20 at once, 10 a second).

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
and from then on can sign in on the customer site's one form too. A person who already has a console account needs
nothing new.

## Inviting a customer

On the console (or in admin mode): **Customers**, **Invite a customer**, the address and, if you like, a name. Cognito
e-mails the invitation with a temporary password that works for 7 days and names the site. **Send the invitation again**
while it is unused. **Give a board** picks one of the boards nobody has, with an optional name the customer sees.
**Take back** and **Switch off** ask once more before they act. A customer switched off cannot sign in, and stops
reading within a minute. An account deleted from the pool by hand still shows ("Account gone") with its boards, so that
they can be taken back.

## Live updates

From console 2.4.0 the site keeps a WebSocket to the live API while a customer is signed in and the page is in view,
and reads the Overview, Devices or a board's page again as soon as one of their boards changes, or which boards are
theirs does ([live.md](live.md)). A customer hears only of their own boards, named by the id of each assignment, never
by a thing name. The 30-second refresh stays, for when the WebSocket is down.

## Known limits

- **E-mail.** The customer pool sends with Cognito's own e-mail, which allows about 50 messages a day, from a Cognito
  address. Many customers at once need Amazon SES configured on the pool (not done here).
- **A token that was copied** goes on working at the gateway until it expires (60 minutes), as on the console; the
  customer API asks Cognito whether the account is on, at most a minute late. Turning two-step sign-in off needs no
  password again: whoever holds an open session can do it.
- **The masthead.** The console's Customers item means the account box takes a second row at 1440 px wide; below
  1280 px it did already.
- **The phone apps** (from 0.6.0) have the customer side: a customer signs in on the app and sees the same pages in the
  same words, and an admin opens admin mode there ([docs/mobile-apps.md](mobile-apps.md#customers)). They do not have
  the Customers page: inviting customers and giving them boards stays on the website. Their activity log reads the
  new entries in the website's words (Android `Audit.kt`, iOS `Words.swift`, held to it by `WebsiteListsTest`,
  `AuditParityTest` and `ParityTests`), and their customer screens read the site's own (`CustomerWordsTest`,
  `CustomerWordsTests`).
- **On a stack that exists, the customer pool is created with deletion protection on**, like the events table was; if
  that update failed and rolled back, CloudFormation could not delete the new pool, and it would have to be removed by
  hand. `cloud/teardown.sh` deletes it with the rest.
- **What the deployment has shown.** The site answers on craniumiot.com with the certificate and the DNS above, and
  `www.` sends the browser to it. Everything else above runs in the tests and the local preview (below); no result of a
  customer's sign-in, an invitation e-mail or the gateway's refusals on AWS is recorded in
  [`test-results.md`](test-results.md) yet.

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
| `cloud/web/src/customer/` | The site: its page (with the home page), `customer.js`, `customer-core.js`, `customer-views.js`, `customer.css`, and the About page's photos in `customer-team-photos.js` |
| `cloud/web/team-photos/`, `cloud/web/build-team-photos.mjs` | The team's photos, and the script that writes them into `customer-team-photos.js` |
| `cloud/web/src/customer-site.mjs` | How the web function loads it, with the console's three shared files, and its policy |
| `cloud/web/src/server.mjs` | `CUSTOMER_HOSTS`: the site, `/admin`, `www.` |
| `cloud/web/src/site/assets/customers.js` | The console's Customers page |
| `cloud/api/src/customer/` | The customer API (`app.mjs`, entry `customer.mjs`), what a customer is shown (`boards.mjs`), its adapters (`aws.mjs`) and settings |
| `cloud/api/src/handlers/customers.mjs` | The console's Customers routes |
| `cloud/infra/template.yaml` | `CustomerUserPool`, `CustomerUserPoolClient`, `CustomerMobileUserPoolClient`, `CustomerAuthorizer`, `CustomerApiReadRoute`, `CustomerApiFn` and its role, `CustomerDomain`, `CustomerWwwDomain` |
| `apps/ios`, `apps/android` | The phone apps' customer side (docs/mobile-apps.md, "Customers"): iOS `CustomerAPI.swift`, `CustomerAccount.swift`, `CustomerWords.swift`, `CustomerSignIn.swift` in CraniumKit and the screens in `App/Views/Customer*.swift`; Android `core/Customer*.kt`, `ui/CustomerViewModel.kt`, `ui/CustomerScreens.kt` |
