# scripts

The scripts are grouped by what they are for:

| Folder | Scripts | For |
| --- | --- | --- |
| `firmware/` | `build.sh`, `ota.sh`, `upload-to-console.sh`, `check-image.sh` | Building a release, putting it on the console, installing it on a board |
| `board/` | `new-board.sh`, `flash-netcore.sh` | Setting up a new board, and its one USB step |
| `fleet/` | `fleet-check.sh` | Checking that a fleet-management (3.11) demonstration is ready; it only reads |
| `release/` | `github-release.sh`, `verify-github-release.sh`, `notes.sh`, `release-lib.sh` | Publishing a GitHub Release and checking one (`release-lib.sh` is shared by both) |
| `console/` | `open-console.sh` | Signing in to AWS and opening the console |
| `ci/` | `scan-tracked-files.sh`, `check-west-workspace.sh` | Checks CI runs; they also run by hand |

Each script finds the repository from its own place, so it runs from any folder.

## The ones you run

| Script | What it does |
| --- | --- |
| `new-board.sh` | Sets up a new board, from out of the box to online on the console: checks this computer (`check`), finds the one board plugged in, asks for its serial number's last 4 digits, then builds, flashes, puts on the golden image and the newest release, provisions and checks it. `--dry-run` runs nothing, `--from <step>` goes on where it stopped, and `status` shows a board. [`docs/new-board-setup.md`](../docs/new-board-setup.md#the-quick-way) |
| `build.sh` | Builds the firmware with the next unused version, leaves the signed image in `binaries/`, and uploads it to the console's Firmware page (`--no-upload` not to). It never deploys |
| `upload-to-console.sh` | Uploads one signed image to the console with your API token; `build.sh` runs it after each build |
| `check-image.sh` | Checks an image before it goes anywhere: the console's own checks, its build record, its commit on main, and CI |
| `flash-netcore.sh` | The one USB step: puts the Bluetooth controller on a board's network core |
| `ota.sh` | Installs an image from `binaries/` on the board over the air, and follows it to the end. With an API token it needs no AWS credentials; with no USB, it follows through the cloud |
| `open-console.sh` | Signs in to AWS and opens the console |
| `github-release.sh` | Publishes a signed image as a GitHub Release, for whoever holds the signing key; `--notes` adds the firmware commits since the last `v*` tag |
| `notes.sh` | `notes.sh <from> <to> console\|firmware\|apps\|all` writes Markdown release notes from the commits between two refs, grouped by area (cloud/, firmware/, apps/, other), with the CHANGELOG versions in the range, without merge commits or the revisions in `.git-blame-ignore-revs`. It only reads git. Its test is `scripts/tests/notes-test.sh` |

A normal update is:

```sh
scripts/firmware/build.sh    # makes binaries/cranium-<version>-0.signed.bin and uploads it to the console
scripts/firmware/ota.sh      # installs the newest one; or deploy it from the console's Firmware page
```

For the upload, keep an API token in `~/.cranium/console-token` with mode 600 (see below). An upload-only
token is enough. Without one, `build.sh` says so and leaves the image in `binaries/`.

`build.sh --help` lists its options. Run them from a normal terminal: they load the nRF Connect SDK toolchain themselves.

### `ota.sh` with an API token

A release manager can let `ota.sh`, or an assistant that runs it for them, update the board without AWS
credentials:

1. On the console, open **Developer > API tokens**, choose **New token**, give it a name and a lifetime (1 to
   90 days), and copy the token. It starts with `crn_` and is shown only once.
2. Keep it where `ota.sh` looks, readable by you alone:

   ```sh
   mkdir -p ~/.cranium && (umask 077 && pbpaste > ~/.cranium/console-token)   # mode 600
   ```

   `CRANIUM_TOKEN=crn_…` works instead, and is used first.
3. Run `scripts/firmware/ota.sh` as usual. It finds the console in `cloud/.deploy/outputs.json` (or
   `CRANIUM_CONSOLE_URL`), uploads and deploys through `/api/t/` with curl, and follows the board through the
   console. `--thing <name>` picks the board when there are several.

The script refuses a token file that is a link, someone else's, or not mode 600, and it never prints the
token. The token acts as you, with the role you have when it is used: a viewer's token cannot install
anything. Revoke it on the same page when it is no longer needed. `scripts/firmware/ota.sh --aws` uses AWS
credentials instead, as before. More in [`docs/aws-iot.md`](../docs/aws-iot.md#api-tokens).

## Used by CI and the other scripts

| Script | What it does |
| --- | --- |
| `scan-tracked-files.sh` | Fails if a tracked file holds a private key or Wi-Fi secrets |
| `check-west-workspace.sh` | Checks CI's cached SDK against the pinned version |
| `verify-github-release.sh` | Checks a published release's files |
| `release-lib.sh` | Checks shared by the two release scripts |

Setting up a blank board is `scripts/board/new-board.sh`, and by hand [`docs/new-board-setup.md`](../docs/new-board-setup.md).

## Where things go

| Folder | What's in it | In git? |
| --- | --- | --- |
| `binaries/` | Every build's signed image, and `latest.*` pointing at the newest | No, only its README |
| `binaries/golden/` | The frozen golden image. Irreplaceable: see `binaries/README.md` | No |
| `build/` | The last build's working files, and `last-build.log` | No |
| `build-bench/` | Test images and their builds | No |
| `build-hil/` | Test bench logs and results | No |
| `ota-demo/` | Demo images and the checkoff study guide, on this Mac only | No |

## Every script in the repository

Listed here only; each stays where it is. Paths are from the repository root.

### `scripts/`

| Script | What it does |
| --- | --- |
| `scripts/board/new-board.sh` | Sets up a new board from out of the box to online (above); runs `tools/new_board.py` for the parts bash does badly |
| `scripts/board/flash-netcore.sh` | Puts the Bluetooth controller on a board's network core, over USB |
| `scripts/firmware/build.sh` | Builds the firmware with the next unused version and uploads it to the console |
| `scripts/firmware/upload-to-console.sh` | Uploads one signed image to the console with an API token |
| `scripts/firmware/check-image.sh` | Checks an image before it goes anywhere; runs `tools/check_image.py` |
| `scripts/firmware/ota.sh` | Installs an image on a board over the air and follows it |
| `scripts/fleet/fleet-check.sh` | Checks that a fleet-management (3.11) demonstration is ready; only reads |
| `scripts/release/github-release.sh` | Publishes a signed image as a GitHub Release |
| `scripts/release/verify-github-release.sh` | Checks a published release's files |
| `scripts/release/release-lib.sh` | Checks shared by the two release scripts |
| `scripts/console/open-console.sh` | Signs in to AWS and opens the console |
| `scripts/ci/scan-tracked-files.sh` | Fails if a tracked file holds a private key or Wi-Fi secrets |
| `scripts/ci/check-west-workspace.sh` | Checks CI's cached SDK against the pinned version |

### `tools/` (Python)

| Script | What it does |
| --- | --- |
| `tools/board.py` | Talks to a board's serial console; used by `provision_device.py` and the test benches |
| `tools/build_report.py` | What a build came to, each size against its limit; run by the firmware CI job |
| `tools/check_image.py` | Checks a signed image before upload; run as `scripts/firmware/check-image.sh` |
| `tools/golden.py` | Freezes the golden image, checks that everything agrees on it, and puts it back |
| `tools/keys.py` | Manages the firmware signing key |
| `tools/local.py` | Where this machine keeps the project's secrets (`~/.cranium`) |
| `tools/memfault_upload.py` | Gives Memfault a build's symbols and its signed image as a release |
| `tools/new_board.py` | What `scripts/board/new-board.sh` needs that bash does badly; each command also works alone |
| `tools/provision_device.py` | Provisions a board: device ID, Wi-Fi, identity and cloud settings |
| `tools/recover.py` | Installs an image through the bootloader's serial recovery |
| `tools/cranium_secrets.py` | Creates and locks the local Wi-Fi secrets file |
| `tools/store_binary.py` | Keeps the latest build's signed image in `binaries/`; run by every `west build` |

### `firmware/`

| Script | What it does |
| --- | --- |
| `firmware/app/flash_layout.py` | A build's flash layout, and the check that its number is right; run by every build |
| `firmware/app/bt_only_check.py` | Checks that a Bluetooth-only image has nothing of the cloud in it; run by the build |
| `firmware/tests/fetch-sdk-files.sh` | Fetches the few SDK files the host and Python tests read |
| `firmware/tests/host/mutate_join.py`, `mutate_net.py`, `mutate_stuck.py` | Mutation checks: do the host tests notice when the policy is wrong? |
| `firmware/tests/hil/run_sharded.py` | Runs one test file's tests in several processes; used by CI for `test_board.py` |
| `firmware/tests/hil/build_image.sh` | Builds a signed test image from a scratch copy of the sources (zsh) |
| `firmware/tests/hil/ota_bench.py` | Hardware tests of firmware updates: a real board and the deployed cloud |
| `firmware/tests/hil/golden_bench.py` | Hardware tests of the golden image |
| `firmware/tests/hil/console_bench.py` | Hardware checks of the serial console |
| `firmware/tests/hil/fault_check.py` | Tells whether the fault that stops the Wi-Fi chip is in a built image |
| `firmware/tests/hil/test_*.py` | The Python tests CI runs (`docs/ci.md`) |

### `cloud/`

| Script | What it does |
| --- | --- |
| `cloud/deploy.sh` | Deploys the console, or updates it; safe to run again |
| `cloud/smoke.sh` | Checks a deployed console from the outside; changes nothing |
| `cloud/logs.sh` | Follows one of the console's logs; read only |
| `cloud/users.sh` | Manages the people who may sign in to the console |
| `cloud/trail.sh` | Keeps a record of what is done in the AWS account, in a stack of its own |
| `cloud/teardown.sh` | Removes the console and everything it stored; cannot be undone |
| `cloud/api/verify-image.mjs` | Checks a firmware image with the console's own upload check |
| `cloud/api/verify-audit.mjs` | Compares the activity log with the digests in the function log; read only |
| `cloud/web/build-bundle.mjs` | Writes the phone apps' web bundle into a folder |
| `cloud/web/build-history.mjs` | Writes what the console's History page shows; run by `cloud/deploy.sh` |
| `cloud/web/build-versions.mjs` | Writes `versions.json`: the console's version and the changelogs' first paragraphs |
| `cloud/dev/preview.mjs` | Local preview of the console |

### `apps/`

| Script | What it does |
| --- | --- |
| `apps/release.sh` | Releases a new version of the phone apps in one command |
| `apps/configure.sh` | Writes `apps/config/cranium.json`, which the apps read at build time, from the deployed console |
| `apps/install.sh` | Puts the app on a phone from this checkout |
| `apps/fetch-builds.sh` | Puts the newest published phone builds into `apps/dist/` |
| `apps/fetch-desktop-builds.sh` | Puts a released desktop build into `apps/dist/` |
| `apps/join-build.sh` | Puts back together an installer that `apps/dist/` keeps in parts |
| `apps/write-dist-index.py` | Writes `apps/dist/SHA256SUMS` and `latest.json` |
| `apps/android/build-release.sh` | Builds a signed release APK |
| `apps/android/publish.sh` | Publishes the Android app on the console's Apps page |
| `apps/ios/scripts/build-ipa.sh` | Builds the iPhone app as an unsigned IPA, for SideStore |
| `apps/ios/scripts/publish.sh` | Publishes the iPhone app on the console, for SideStore |
| `apps/ios/scripts/testflight.sh` | Builds the iPhone app and uploads it to TestFlight |
| `apps/ios/scripts/phone.sh` | Puts the app on your own iPhone with a free Apple ID |
| `apps/ios/scripts/renew.sh` | Keeps the app on your iPhone opening and up to date |
| `apps/ios/scripts/check.sh` | Checks what can be checked on a Mac without a phone |
| `apps/ios/scripts/generate.sh` | Makes the Xcode project from `project.yml` with XcodeGen |
| `apps/ios/scripts/colors.sh` | Makes the app's colours from the web console's |
| `apps/ios/scripts/copy-bundle.sh`, `copy-config.sh`, `stamp-commit.sh` | Xcode build phases: the web bundle, the configuration, the commit |
| `apps/desktop/scripts/prepare.mjs` | Makes `apps/desktop/build/`, what the desktop app is built and started with |
| `apps/desktop/scripts/dist.mjs` | Builds one platform's installers |
| `apps/desktop/scripts/installers.mjs` | The installers a release of one platform publishes |
| `apps/desktop/scripts/version-of.mjs` | The version a platform's build has |
| `apps/desktop/scripts/mask-config.mjs` | For the release job: checks the app configuration and masks its values |
| `apps/desktop/scripts/ci-setup-linux.sh` | The tools the Linux packages need on an Ubuntu runner |
