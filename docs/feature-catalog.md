# Cranium IoT platform: feature catalog

As of 2026-11-11. Every feature of the platform, kept up to date as features merge, as a reference for building other IoT devices.

## How to use this catalog

Cranium is a complete IoT fleet platform: firmware on Nordic nRF7002 DK and nRF5340 DK boards, a cloud console on AWS, phone and desktop apps, and a customer website. Every feature here can be lifted into a new IoT product.

- **Firmware** (`firmware/`): Zephyr / nRF Connect SDK app, MCUboot bootloader, AWS IoT over Wi-Fi, Bluetooth update and offline mode.
- **Cloud and console** (`cloud/`): AWS SAM stack (API, IoT jobs, device shadow, state table) and the team console at console.craniumiot.com.
- **Apps** (`apps/`): iPhone, Android, Electron desktop and native Mac apps, all hosting the same web bundle.
- **Customer site**: craniumiot.com, for the people who own the devices.

Each entry says what the feature does, how it works, where it lives in the repo and what to change to reuse it on another device. New features are added here as they merge; the last section logs each addition.

## Firmware features

The firmware is one Zephyr application (`firmware/app`) behind MCUboot, documented section by section in `firmware/README.md`. Versions and memory per release are in `firmware/CHANGELOG.md`.

| Feature | What it does | Since | Where | Reuse notes |
| --- | --- | --- | --- | --- |
| Cloud update (OTA) | Takes an AWS IoT job, downloads a signed image, checks it, swaps on restart, confirms or rolls back | 1.0 | `src/ota/ota.c` | Any MCUboot device with a network link; keep the job states and the rollback trial |
| Signed images | Every image is signed; the bootloader holds only the public key | 1.0 | `firmware/keys/`, `scripts/firmware/build.sh` | Keep the private key off CI; build and sign on a trusted machine |
| Update recovery | Interrupted, cancelled, stalled and refused updates each have a defined end state | 1.x | README "When an update fails" | The same table works for any OTA design |
| Stuck detection | Restarts a board whose Wi-Fi chip or update hangs, and reports why | 1.7.0 | `src/policy/stuck_policy.h` | Watch progress, not just liveness |
| Golden image | One sealed image in external flash that only the bootloader restores, from a button held at boot | 1.x | README "Golden image", `sysbuild/mcuboot/golden` | The last way back with no laptop, Wi-Fi or cloud |
| Serial recovery | MCUboot takes an image over UART | 1.x | README "Serial recovery" | Needs neither Wi-Fi nor a debugger |
| Factory mode | A board with no valid ID boots into setup, off the network | 1.x | README "Factory mode" | Clean provisioning path |
| Serial console | Line commands: `STATUS`, `WIFI`, `CLOUD`, `KEYGEN`, `REBOOT`, `FACTORY_RESET`, `BT_PASSKEY` and more | 1.x | `src/console_cmd.c` | One command table, help text built in |
| Boot diary | Last eight boots (version, cause, stage) kept in storage and sent to the shadow | 1.7.4 | README "Boot diary" | Explains a reset with no serial port |
| Events to the console | Every console line (`[BT]`, `[WIFI]`, `[CMD]`…) also goes to the cloud's activity log, with secrets filtered out | 1.12.0 | README "Events to the console" | A remote serial log for free |
| Board compatibility | Each image says which board and flash layout it is for; the board refuses others | 1.13.0 | README "Board type and compatibility" | Stops a wrong-board image before it flashes |
| Remote commands | A release manager sends a board commands from the console | 1.13.0 | README "Commands" | Signed, role-checked commands |
| Location by Wi-Fi | Reports the access points it hears, for a map position | 1.13.0 | README "Location by Wi-Fi" | No GPS needed |
| Memfault | Reboot reasons, coredumps, hourly metrics and update events over the board's own AWS link | 1.14.0 | `src/mflt/`, README "Memfault" | Crash reporting without a second cloud link |
| Bluetooth update | A phone or laptop uploads a signed image over BLE (SMP) in a window opened by Button 1; Button 2 closes it | 1.x | `src/bt/bt_ota.c`, README "Firmware update over Bluetooth" | Passkey pairing, no bonds kept, three failed pairings close the window |
| Board's own passkey | A 6-digit passkey kept in protected storage, for boards with no cloud | 1.x | `src/bt/bt_passkey.c` | Locks after 3 wrong tries |
| Offline mode | With no Wi-Fi or cloud, a paired phone reads the board's status and accepts a waiting update | 1.19.0 | `src/bt/bt_offline.c` | Own GATT service, authenticated link only |
| Listening sessions | Sends what is played to the cloud for the customer site | 1.18.0 | README "Sessions" | Product-specific telemetry over MQTT |
| LED and button language | Fixed patterns for every state on both DKs | 1.x | `docs/led-guide.md`, README "Buttons" | One table a customer can read |
| Memory budgets | Every build reports flash and RAM free per board; CI fails below the floors | — (#189) | `tools/memory_budget.py`, `tools/memory_budgets.json` | Catch growth before it reaches the board |
| nRF5340 DK support | The same app as a Bluetooth-only board | 1.x | README "The nRF5340 DK" | Shows how to port to a board with no Wi-Fi |

## Cloud and console features

The cloud is one AWS SAM stack (`cloud/infra/template.yaml`): an HTTP API, AWS IoT Core jobs and device shadows, and three DynamoDB tables. The console at console.craniumiot.com is a single-page app (`cloud/web/src/site`) that the apps also host. Each topic has its own doc in `docs/`.

| Feature | What it does | Since | Where | Reuse notes |
| --- | --- | --- | --- | --- |
| Devices and board pages | Every board as it last reported: version, Wi-Fi, cloud, update state, boot diary, diagnostics | 1.x | `devices`, `device` pages | Reads the device shadow; no polling of boards |
| Board names | A label first, the hardware ID second, everywhere | 2.25.14 | console 2.25.14 | People recognise names, not IDs |
| Firmware releases | Upload a signed image; the console checks the signature and registers the version once | 1.x | `firmware` page, `scripts/firmware/upload-to-console.sh` | A version number is burned once uploaded |
| Deployments and staged rollouts | Send a release to one board, a group or the fleet, in waves, with rollback to the last good | 1.x | `deployments`, `rollout`, `docs/mass-updates.md` | Built on AWS IoT jobs |
| Groups | Boards grouped by type and by hand; roll out or roll back per group | 1.x | Devices page | Groups by board type are automatic |
| Activity log and audit | Every action and every board event, with what changed field by field | 2.13.1 | `activity`, `events`, `docs/audit-diff.md` | 62 action types, readable words |
| Live updates | An open page hears of a board connecting, updating or failing as it happens | 2.4.0 | `docs/live.md` | WebSocket push, no refresh |
| Alerts | What the console tells people about and how a release manager tunes it | 2.13.0 | `alerts`, `docs/alerts.md` | Per-fleet thresholds |
| Fleet health score | One number 0 to 100 with its trend | 2.x | Overview, `docs/fleet-health.md` | Summarises the fleet at a glance |
| Search and filters | The same search and filter bar on every long list | 2.12.0 | `docs/search-filters.md` | One shared component |
| Compare two boards | Why one board behaves differently from another | 2.16.0 | `compare`, `docs/compare.md` | Side-by-side config and history |
| Weekly reports | One page per week: how the fleet did, what was sent, what changed | 2.19.0 | `reports`, `docs/reports.md` | Generated, not hand-written |
| Map | Boards placed by the Wi-Fi they hear | 2.x | `map` | Needs no GPS on the board |
| Memfault page | Crashes and metrics from Memfault inside the console | 2.x | `memfault`, `docs/memfault.md` | Nav label: Crashes |
| Diagnostics and serial console | Read a board's diagnostics; talk to it over USB from the browser | 2.x | `diagnostics`, `serial` | Web Serial in Chrome, native serial in apps |
| Board setup | First-time setup of an nRF7002 DK or nRF5340 DK over USB | 2.x | `setup`, `docs/new-board-setup.md` | Guided, step by step |
| Bluetooth update | Send a release to a board from a phone or laptop over BLE | 2.x | `bluetooth` | Passkey relayed through the console |
| Offline page | Read a board's status and accept an update with no network | 2.27.0 | `offline` | Opens from the sign-in screen; merging into Bluetooth (#202) |
| Accounts and roles | Release managers manage who signs in; only they see Team and Customers | 2.17.0 | `team`, `customers`, `docs/accounts.md` | Role checks on every write |
| API tokens | Scoped tokens, e.g. upload-only for build machines | 2.x | `tokens` | Least privilege for CI |
| Release notes and What's new | A tab per product and every version, from the CHANGELOGs | 2.25.5 | `history`, release notes | Built from the CHANGELOG's first paragraph |
| Versions | One version per product; the last number for small changes | 2.x | `docs/versions.md` | Never the first number |
| Database page | The console's own tables, read-only | 2.x | `database`, `docs/database.md` | For debugging |
| Design system | Tokens v2 and shared components (cards, tables, buttons, badges, meters, dialogs) | 2.25.17 | `app.css`, `docs/console-design.md` | `ui-*` names, light and dark |
| Deploy by tag | Pushing `console-v<version>` deploys the console through GitHub Actions | 2.x | `.github/workflows/deploy-console.yml` | No laptop deploys |

## Apps

Every app is a thin native shell around the same web bundle, so a console change reaches all of them at once and they look exactly like the website. Native code only adds what a browser can't do, through one bridge contract (`apps/shared/bridge.json`).

| App | Platform | Where | What the shell adds |
| --- | --- | --- | --- |
| iPhone | iOS, Swift, WKWebView | `apps/ios` | Bluetooth update and offline mode, Face ID sign-in, camera for QR, safe areas for the iPhone 17 Pro |
| Android | Kotlin, WebView | `apps/android` | Bluetooth, USB serial to the board, camera, app updates from CI |
| Desktop | Electron, Windows and Linux | `apps/desktop` | USB serial, keep-awake during long jobs, auto-update |
| Mac | macOS 13+, WKWebView | `apps/macos` | Native serial (IOKit, J-Link only), menus, file picker, radio sharing between windows |

Bridge features, each named in the contract and checked by tests: `auth`, `biometric`, `ble`, `bleOffline`, `usb`, `camera`, `clipboard`, `share`, `open`, `haptics`, `keepAwake`, `settings`, `storage`, `appUpdate`.

Shared behaviour worth reusing:

- **Built-in and downloaded bundle:** each app ships a copy of the web pages and also downloads the live ones. The built-in copy wins when it is newer, and an app falls back after two failed starts.
- **One look:** no native screens redraw a console page (`docs/mobile-apps.md`, `docs/desktop-app.md`, `docs/mac-app.md`).
- **Releases by tag:** pushing `ios-v<version>` or `android-v<version>` builds and publishes that app (`.github/workflows/release-apps.yml`). Apps 0.9.0 carry the Offline page.
- **Coming:** Matter support in the phone apps, so the phone can commission and update the board over Matter (#198).

## Customer website

craniumiot.com is where device owners sign in and see their own boards and nothing else. It is part of the console's stack from console 2.0.0, and the team reaches the console from it through admin mode (`docs/customer-site.md`).

| Feature | What it does | Reuse notes |
| --- | --- | --- |
| One sign-in form | E-mail and password, then an authenticator code; a team account always needs one | Cognito; password reset by e-mailed code |
| Admin mode | Team members open the console from the customer site | One domain for customers, one for the team |
| Customer accounts | Release managers hand out accounts and boards from the console's Customers page | A customer sees only their boards |
| My boards | Each board with a health dot, its week in a sentence, restarts by day, firmware and last report | Health in plain words, not raw metrics |
| Product pages | Mixes, Now playing, play times and Your listening, from the board's sessions | Swap in your own product's telemetry |
| Public front page | What the product is and how updates work, readable without JavaScript | Plain HTML |
| Shared design | The console's tokens, with the site's own dark sidebar | One design system, two products |

## Matter over Thread and Raspberry Pi updates

Both extensions run on the one nRF7002 DK. Matter is a fixed rule: commissioner, Thread border router and Matter updates all on this board, in our own compact code.

```text
                     Matter                       Thread
 +----------------+  <------>  +--------------------------------+  <------>  +----------------+
 | Phone app      |            | nRF7002 DK                     |            | Thread devices |
 | iPhone/Android |            | Matter commissioner (own code) |            | lights, sensors|
 | Matter control |            | Thread border router to Wi-Fi  |            +----------------+
 +----------------+            | Matter node the phone sets up  |
                               | OTA requestor and provider     |
                               | Writes the Pi's SD card        |
                               +--------------------------------+
                                               |  SPI
                                               v
                                    +----------------------+
                                    | Raspberry Pi         |
                                    | no Wi-Fi, SD updates |
                                    +----------------------+
```

The phone sets the board up over Bluetooth, then talks Matter to it over Wi-Fi or Thread, including firmware updates. The board brings Thread devices onto its own network and serves them updates.

| Feature | State | Where | Reuse notes |
| --- | --- | --- | --- |
| Thread leader and border router | Built, CI green, not yet on hardware | `firmware/matter/` (arrives with PR #198) | Zephyr's border-router code, adapted to this SDK |
| Our own Matter library | TLV, BTP, PASE, CASE, Interaction Model, attestation, certificates, all in C on PSA crypto | `firmware/matter/`, `docs/matter-thread.md` (arrive with PR #198) | Fits where the full Matter SDK was 1.4 MB too big |
| Commissioner | Pairs a Thread device over BLE, checks its certificate, issues its own, keeps it across restarts | PR #198 | Matter test credentials only for now |
| OTA provider | Sends updates to the devices it commissioned, over BDX | PR #198 | Images kept in external flash |
| Phone as Matter controller | In progress: the board as a Matter node the phone commissions and updates | PR #198 + an app PR | Apple Matter framework on iPhone |
| Memory | 94 KB flash and 110 KB RAM free on the nRF7002 DK | `tools/memory_budgets.json` | Wi-Fi chip firmware moved to external flash |
| Raspberry Pi updates | The board writes a signed Pi image to the Pi's SD card over SPI; the Pi never has Wi-Fi | PR #196, `docs/raspberry-pi-ota.md` | Board test waits on the microSD breakout |

## Engineering workflow

The way the platform is built is as reusable as the features: every change is small, tested, reviewed and released by a tag.

1. **One PR per task.** Its own branch, labels, milestone and project entry, and "Closes #N" for the task's issue on the pinned work list (#128).
2. **CI on every push** (`.github/workflows/ci.yml`): cloud and web tests, host tests for firmware logic, firmware builds for each board, the iPhone, Android, Mac and desktop apps, CodeQL, and a check that no private key is in git.
3. **Memory floors.** Each firmware build reports flash and RAM free per board; a build below its floor fails (`tools/memory_budgets.json`).
4. **Review before merge.** A reviewer posts one comment review ending "OK to merge"; nothing merges without it.
5. **Rebase-merge, delete the branch.** No merge commits, never force-push; a conflicting PR is copied onto a fresh branch instead.
6. **Release by tag.** `console-v<version>` deploys the console; `ios-v` and `android-v` release the apps. Firmware builds are signed on a trusted machine and uploaded to the console; people deploy them to boards.
7. **Hardware before merge.** Firmware merges only after it has run on a board.

Versions go up by the last number for almost everything, the middle number for something big, never the first (`docs/versions.md`). An uploaded firmware number is never reused.

## Catalog log

Each feature as it lands, newest first. Earlier features are in the sections above, from the repo's CHANGELOGs.

| Date | Feature | Version | PR |
| --- | --- | --- | --- |
| 2026-11-11 | Board log keeps location lines; refused Bluetooth and cloud updates for another board shown, warned and alerted | console 2.27.6 | #241 |
| 2026-11-11 | Customer site: a reassigned board's health, like its activity and sessions, covers only the new owner's time | console 2.27.5 | #227 |
| 2026-11-11 | Update over Bluetooth: Look for boards stays in reach after choosing a release | console 2.27.5 | #227 |
| 2026-11-11 | A Bluetooth passkey set at the serial console (`BT_PASSKEY`, `BT_OFFLINE\|NEW`) goes on record, never the passkey | console 2.27.5 | #227 |
| 2026-11-11 | Apps: the serial passkey commands in the activity log, and on record from the Android app's USB serial console | apps 0.9.1 | #227 |
| 2026-11-11 | Matter over Thread on the nRF7002 DK: own Matter library, commissioner, border router, OTA provider (not yet on hardware) | firmware 1.21.0 | #198, open |
| 2026-11-11 | Apps with the Offline page | apps 0.9.0 | tags `ios-v0.9.0`, `android-v0.9.0` |
| 2026-11-11 | Offline page: board status and updates over Bluetooth with no network | console 2.27.0, firmware 1.19.1 | #205 |
| 2026-11-11 | Shared components: one set of cards, tables, buttons, badges, dialogs | console 2.25.17 | #203 |
| 2026-11-11 | Design tokens v2 | console 2.25.16 | #194 |
| 2026-11-10 | Board names, label first | console 2.25.14 | #190 |
| 2026-11-10 | Firmware memory floors in CI | — | #189 |
| 2026-11-10 | iPhone 17 Pro screen fit | console 2.25.11 | #185 |
| 2026-11-10 | Release notes tab per product | console 2.25.5 | #162 |
