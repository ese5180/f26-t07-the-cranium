# Console changes

The console is the website at console.craniumiot.com, its API and its AWS stack: everything in `cloud/`. One entry per
version, newest first; the version is in `cloud/VERSION`, and each version is tagged `console-v<version>` on the commit
it was built from. A small change or a fix is a patch (1.9.0 to 1.9.1), something new a minor version. The first
paragraph of an entry is what the console shows under "What's new". Versions before 1.9.1 were given later, from the
history; each names its commit.

## 1.10.0

Fleet tools: board types, groups, staged rollouts with a canary that stop by themselves, Update everything, and the
right image only on a board of its type and flash layout. A map of the boards from Wi-Fi, Identify and Report now,
e-mail alerts, editable release notes, the Apps page to install the phone apps, and the console's version at the foot
of every page.

Fleet page: each board's type, health and groups, and deployments to a group, a type or the whole fleet. A release
says which board type and flash layout it is for, read from its signed image, and is never offered to another. The
staged rollouts' schedule sends an e-mail alert when a canary does not confirm or AWS IoT stops the waves.

The version commit, 2026-11-04.

## 1.9.1

Phone sessions can last 30 days behind Face ID or a fingerprint; without them, an hour as before. The website's own
sessions are unchanged.

Commit 7f34f56, 2026-11-04.

## 1.9.0

Each board's own log on the Events page (from firmware 1.12.0), who signed in, on the website or a phone, and the
settings changed at a board's serial console over USB, in the activity log, which now reads as sentences.

Commit 662e305, 2026-11-03.

## 1.8.0

The phone apps can sign in on their own screen, with the code in six boxes, as the website does.

Commit cbd6131, 2026-11-03.

## 1.7.1

The Events page's board filter shows All boards when the page first opens.

Commit b5d87ba, 2026-11-03.

## 1.7.0

Each board's own name (its device ID, from firmware 1.11.4) everywhere the console shows a board, with the AWS thing
name beside it.

Commit 65f425b, 2026-11-03.

## 1.6.0

The phone apps can do everything the website does; a change from a phone needs a sign-in in the last 15 minutes.

Commit 4c2b5ef, 2026-11-03.

## 1.5.1

The findings of the security review fixed, and each build uploaded to the console by itself.

Commits 9c0bd59 and 368b844, 2026-11-03.

## 1.5.0

The console's own sign-in page, with the code in six boxes.

Commit 22e9c37, 2026-11-02.

## 1.4.0

The Events page, with every event of every board on a timeline, and the Diagnostics page.

Commit eed1e50, 2026-11-02.

## 1.3.0

Personal API tokens, made and ended on the console's API tokens page.

Commit ea87270, 2026-11-02.

## 1.2.0

Phone apps can fetch a release and a board's Bluetooth passkey, and the console shows a board open for an update over
Bluetooth.

Commits 1895923 and 1925596, 2026-11-02.

## 1.1.1

The console says only what it knows about a board and an update, explains a lost trial, and why the newest release can
differ from what a board runs.

Commits a924e33 to 9ea3d88, 2026-11-01.

## 1.1.0

A redesigned console, tighter security, and the public home page.

Commit c116dba, 2026-10-31.

## 1.0.0

The first console: upload a signed release (its signature checked), deploy it to boards as an AWS IoT job, follow each
board, cancel and revoke, the activity log, and sign-in with an authenticator app.

Commits 42998d6 to a9f82ee, 2026-10-10 and 11.
