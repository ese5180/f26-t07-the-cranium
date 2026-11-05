# Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on GitHub Actions: it tests the code
and builds the firmware on every push to `main` and `feature/**` and on every pull request. Anyone with
write access can also start it by hand from the Actions tab. The repository is public, so the minutes
are free, anybody can read the logs, and anybody signed in to GitHub can download the artifacts.

**It has run.** The first run with every job passing was on commit be91c50, on 2026-11-01, for the push and
the pull request: the scan, the host tests, the Python tests, the cloud tests, and both firmware builds, on
Linux, in about six minutes. The run before it failed only the Python job, on 24 tests that skipped because
`console_sim_fault` was not built, which this job refuses. The job that checks a published release has not run,
because no firmware release has been published on GitHub (none as of 2026-11-05), and `scripts/github-release.sh` has
not been run for real. The phone apps' release workflow has run: [Releasing the apps](#releasing-the-apps).

**A cancelled run is usually not a failure.** Two things cancel jobs. A newer push to the same branch cancels the run
before it (`concurrency` in `ci.yml`), which is meant: the newer run checks the newer commit. And GitHub's macOS
runners are often short of capacity, so the iPhone app's job, the only one on macOS, can be cancelled with "The job was
not acquired by Runner of type hosted even after multiple attempts" while every other job passed, and the run then
shows as failed (6147aea's first attempt, on 2026-11-05). Re-run it from the run's page (Re-run jobs) or with
`gh run rerun <run id>`; nothing in the commit needs changing. The same can happen to the iPhone job of
`release-apps.yml`.

## What runs

| Job | Runs on | What it does | What a pass means |
| --- | --- | --- | --- |
| No private key in git | Each push to `main` or `feature/**`, each pull request, and by hand | `scripts/scan-tracked-files.sh` | No tracked file of this commit holds a PEM private key, and no `wifi_secrets.h` is tracked, in any case of its name. It looks at this commit, not at older ones |
| Host tests | The same | `make -C firmware/tests/host` with gcc, with the address and undefined-behaviour sanitizers on | The parsers, the console, the update code and the golden policy do what their tests say, on a fake of the hardware |
| Python tests | The same | `test_board.py`, `test_recover.py`, `test_golden.py`, `test_build_report.py`, `test_check_image.py`, `test_flash_layout.py`, `test_memfault_upload.py`, `test_provision.py`, `test_bt_only_check.py` | The tools do what their tests say, against stand-ins for a board and against the console's real code on a pseudo-terminal |
| Cloud tests | The same | `node --test` in `cloud/api`, `cloud/web` and `cloud/dev`, with Node 22 | The console's API and pages do what their tests say, with an in-memory stand-in for AWS |
| Firmware (default) | The same | `west build` of the default configuration, in Nordic's toolchain image for the SDK | The commit compiles, links and fits, with a job summary of its sizes and an artifact. See [The firmware jobs](#the-firmware-jobs) |
| Firmware (no Bluetooth) | The same | The same build with `-DSB_EXTRA_CONF_FILE=no_bt_sysbuild.conf` | A build without Bluetooth, which every build has from 1.9.0, still compiles and links. Nothing more |
| Firmware (nRF5340 DK) | The same | `west build` for `nrf5340dk/nrf5340/cpuapp/ns`, the board with Bluetooth only | It compiles, links without Wi-Fi, cloud or Memfault code, and fits, with the Bluetooth controller on the network core, and the image says board type `nrf5340dk` and flash layout `1` (TLVs `0xA1`, `0xA2`). A job summary of its sizes and an artifact, as for the default |
| Android app | Ubuntu, JDK 17 | `./gradlew testDebugUnitTest assembleDebug` in `apps/android`, with the example configuration | The app's unit tests pass and it builds. It cannot sign in: the real configuration is never in git |
| iPhone app | macOS, the runner's newest Xcode | `swift test` in `apps/ios/CraniumKit`, then the XcodeGen project built for iPhone without signing | The logic package's tests pass and the app compiles for iPhone. Nothing is signed or installed |
| Check the release's files | A release is published | `scripts/verify-github-release.sh` | See [The check on a release](#the-check-on-a-release) |

The last job is the only one that runs for a release, and it runs for nothing else: not for a release made for a phone
app's tag (`android-v…`, `ios-v…`), which has no files. The phone apps are released by a workflow of their own,
[`release-apps.yml`](#releasing-the-apps), which holds secrets; this one holds none.

The host tests and the Python tests need neither the SDK nor its toolchain. They need cJSON, Zephyr's
base64 code, imgtool and a few of the SDK's headers and sources, and
`firmware/tests/fetch-sdk-files.sh` fetches those files, at the commits that the manifest of SDK v3.4.0
names. So a test that holds the bench against MCUboot's source reads the same source as in a full SDK.

Tests that skip themselves:

| Test | Why | On Actions |
| --- | --- | --- |
| `test_golden.py`: `test_the_frozen_key_verifies_the_kept_image_if_there_is_one` | It needs `binaries/cranium-1.3.0-0.signed.bin`, which is not in git | Skipped. The Python job fails if any other test skips |
| `test_flash_layout.py`: `test_the_last_build_is_layout_1` | It needs a build in `build/`, and the Python job builds nothing (the firmware jobs check their own build's partitions) | Skipped |
| `cloud/web`: `the file on disk, where this checkout has one, holds what it may` | It needs `history.json`, which only a deployment writes | Skipped |

Without `firmware/tests/host/build/console_sim` and `console_sim_fault`, `test_board.py` skips most of
its tests. The Python job builds both first, so on Actions it does not.

## What this does not show

- **No hardware.** No job touches a board. A green run says nothing about whether an image boots,
  whether Wi-Fi joins, or whether an update and a revert work. `firmware/tests/hil/` and
  [`docs/test-results.md`](test-results.md) are where that is shown, and those are run by a person
  with a board.
- **No real key.** The images built on Actions are signed with a throwaway key, so no job shows
  anything about the image a board would get.
- **No AWS.** The cloud tests run against a stand-in, so what the deployed console does is not shown.
- **Not the same bytes.** A build on Actions and a build on a person's computer come from the same
  commit, but the paths and the key differ, so the images differ.
- **Not every key that gets pushed.** The scan runs only when the workflow does, and only on the commit
  at the tip. A key pushed to any other branch, with no pull request, starts no run, so nobody is told
  while it can be read. A key added in one commit and removed in the next passes, though it stays
  reachable by its commit id. An admin of the repository can turn on GitHub's secret scanning and push
  protection, which look at pushes to every branch. What those recognize is GitHub's list, not this
  script's.
- **Not every build.** Only the three configurations in the table are compiled. The build with the serial
  console off, `-Dapp_CONFIG_APP_CONSOLE=n`, is not, so a commit that breaks it still shows green.
- **The checks are advice for now.** Nothing stops a merge when one fails. See
  [Requiring these checks](#requiring-these-checks-on-main).

## Why the signing key stays out

The key in `~/.cranium/mcuboot_signing_key.pem` is trusted by every board. Whoever has it can make
firmware they will run. A repository secret would put it in reach of anyone with push access: a
secret can be read by any workflow in the repository, and a workflow is one more file in a commit,
which could print the key or send it anywhere. There is no way to take a key back once it has left,
and boards in the field hold its public half in a bootloader that an update does not change. See
[`secrets/README.md`](../secrets/README.md).

So the workflow names no secret. Each firmware job makes its own key with `imgtool keygen`, in
`$HOME/.cranium`, where `firmware/app/sysbuild.cmake` looks for one. It removes the key at the end of
the job, and it never puts it in the cache or the artifact. The bootloader in that build trusts the
throwaway key too, but only that bootloader, which nothing installs.

So the images from Actions **cannot be installed**. MCUboot refuses them because the signature is not
the project's, and so does the console when one is uploaded. They exist to show that the commit
builds and what size it is. The job fails if its image verifies against
`firmware/keys/fw_signing_pub.pem`, because then something would be badly wrong.

## The firmware jobs

They run in `ghcr.io/nrfconnect/sdk-nrf-toolchain:v3.4.0`, pinned by its digest.

- **User and home.** The image sets no user, so the job runs as root. The image sets `HOME=/opt`,
  and the runner sets `HOME=/github/home` over it, which is where the throwaway key and the SDK go.
- **The toolchain.** The runner replaces the image's entry point, so the toolchain is not on the `PATH`
  by itself. The image sets `BASH_ENV` to a script that puts it there, so it is there in a step that
  runs in bash and nowhere else. An action such as `actions/checkout` runs in Node and uses the
  image's own git, which is enough for it.
- **Git.** The runner creates the workspace as another user, so git would refuse it. Nordic's
  documentation for this image gives the answer: `git config --global --add safe.directory '*'`.
  Without it `tools/store_binary.py` could not read the commit.

The SDK's west workspace is restored from a cache whose key holds the SDK's version and the commit of
`sdk-nrf`. A stale cache cannot make the job pass falsely, for these reasons:

- There are no `restore-keys`, so only a cache for exactly this SDK is ever restored.
- `west update` runs every time, cached or not.
- `scripts/check-west-workspace.sh` then fails the job if `nrf` is not on the pinned commit, if a
  project is not on what its manifest says, if a tracked file in any of them has changed, or if git has
  been told not to look at one.
- The cache is saved before the build, and it holds only the SDK. The build goes to `build/` in a
  fresh checkout, with `--pristine=always`.
- After the build, the image has to verify against the key made in this job, and
  `tools/build_report.py` fails if what `binaries/` holds is not what this build made from this commit.

That covers a stale or damaged cache, and not a hostile one. Someone with write access can push to
`main` a workflow that saves anything under this key, when `main` has no such cache yet or after
deleting it. Every branch and pull request then restores `main`'s cache, and reverting the commit does
not clear it. The check cannot see all of that: it ignores files that git does not track, and
`west update` has already run git in those repositories, with their configuration and hooks, before the
check starts. These jobs hold no secret and a read-only token, so what this can cost is a false green
firmware job and a made-up artifact, and not the signing key. Raising `NCS_CACHE_GENERATION` is the way
back. A fork or a feature branch cannot do this, because what it saves is restored only for itself.

To start from an empty cache, raise `NCS_CACHE_GENERATION` in the workflow. To move to another SDK,
change `NCS_VERSION`, `NCS_COMMIT` and the image in the workflow, and the commits in
`firmware/tests/fetch-sdk-files.sh`. A test in `cloud/api/test/release.test.mjs` fails if they disagree
about the commit of `sdk-nrf`.

The default build and the nRF5340 DK's each write a table to the job summary, from
`tools/build_report.py`: the version and commit, flash and RAM of MCUboot, the application and TF-M,
and the length of the signed image. Each
size is shown against its limit. The limits come from the build itself: the region table in the
linker's map file, and `slot0_partition` in the devicetree. The used sizes are what the linker reports,
from the start of a region to the end of what is in it, so TF-M's flash looks nearly full, because its
veneers sit at a fixed place near the end. The job fails if anything is over its limit.

## Getting an image from Actions

Each default build uploads an artifact named
`firmware-<version>-<commit>-ci-key-not-installable`, which is kept for 30 days. It holds the image,
named so that nobody takes it for a release, with `latest.json`, the size table, and
`NOT-INSTALLABLE.txt`, which says what this section says. The nRF5340 DK's is
`firmware-nrf5340dk-<version>-<commit>-ci-key-not-installable`, with `latest-nrf5340dk.json`, named
as `binaries/` names that board type's files. On a pull request the commit is the merge
commit that GitHub made to test it.

Open a run in the Actions tab and go to Artifacts at the bottom of its summary, or:

```sh
gh run list --workflow CI --branch main --event push
gh run download <run id>
```

`--event push` matters. `--branch` goes by the name of the branch, so without it the list also has runs
for pull requests from forks whose own branch is called `main`, and a fork's run can upload anything
under a convincing name. Downloading an artifact from the Actions tab needs a GitHub account. Do not
try to install one: it is refused.

## How a real release is made

An image that a board will install is built and published by the person who holds the key, on their
own computer.

A GitHub Release today is the default build, with the serial console in it. `firmware/README.md`
describes a build with the console off (`-Dapp_CONFIG_APP_CONSOLE=n`), and the script below refuses
that build, because it refuses every `-D` setting. No job compiles it either. The product build that
would leave the console out does not exist yet: see
[`docs/aws-iot.md`](aws-iot.md#known-limits). A release without the console would need the script to
allow that one setting by name, and the workflow to build it.

1. Set the new version in `firmware/app/VERSION`, commit, and push. A release must be newer than every
   release uploaded before it.
2. Build it, with no changes and no `-D` settings. `--pristine=always` clears any that an earlier build
   left in this build folder, because CMake keeps them. It has to be written with the `=` here: west
   would take the next word for its value.

   ```sh
   west build -b nrf7002dk/nrf5340/cpuapp/ns --sysbuild --pristine=always firmware/app
   ```

3. Try the release first, which checks everything and writes nothing:

   ```sh
   scripts/github-release.sh 1.7.0 --dry-run
   ```

4. Publish it:

   ```sh
   scripts/github-release.sh 1.7.0
   ```

It takes the image from `binaries/`, and it refuses unless all of these hold:

- No tracked file has changed, and git has not been told to look away from one with `--skip-worktree`
  or `--assume-unchanged`. An untracked file does not matter.
- HEAD is on a branch of origin, as origin says now, and not as this checkout remembers. Origin has to
  be on github.com, and `gh` is told to use that repository, so `GH_REPO` or another remote cannot send
  the release somewhere else.
- The version is the one in `firmware/app/VERSION` and in the image's header.
- The signature verifies against `firmware/keys/fw_signing_pub.pem`, by the check the console makes on
  an upload (`cloud/api/verify-image.mjs` runs `cloud/api/src/lib/mcuboot.mjs`).
- `binaries/latest.json` describes this file and names this commit.
- The image is not a test image. `latest.json` records the `-D` settings of the build, with or without
  a type, and any setting is refused, which also refuses a build without Bluetooth: from 1.9.0 every
  release has it. The image is also searched for the log lines of a fault. `CONFIG_APP_TEST_FAULT_NO_CONFIRM`
  writes no log line of its own, so an image with that fault is only told apart by `latest.json`.
- It is not the golden image: neither its file's digest nor the digest MCUboot verifies is one that
  `firmware/golden.json` pins or that a file in `binaries/golden/` has. If `firmware/golden.json` is
  missing or does not hold those digests, that is a refusal too. The script takes nothing from that
  folder.
- No tag or release of this version exists.

It then uses `gh` to create the tag `v<version>` on this commit and a GitHub Release with the signed
image, `latest.json` and `SHA256SUMS`, and it prints the address. `gh` publishes after the last upload,
so a failed upload leaves no tag. A version with a build number has it in the tag: `v1.7.0+2`.

The record of `-D` settings is a record and not a lock. `tools/store_binary.py` reads it from the
entries that CMake marks as coming from the command line, so a setting that reached the build in another
way, such as an environment variable that the build reads, is not in it. Neither is a `-D` that the
build's own CMake code sets again, as it does with `BOARD`. The person who holds the key still has to
build what the commit says.

A release on GitHub installs nothing by itself. To install it, follow
[`binaries/README.md`](../binaries/README.md).

## Releasing the apps

[`.github/workflows/release-apps.yml`](../.github/workflows/release-apps.yml) releases the phone apps from anywhere: a
tag pushed from any clone, or **Run workflow** on GitHub's website, from any device. Both jobs end on the console,
and every phone takes the new version from there ([`docs/mobile-apps.md`](mobile-apps.md#updates-on-every-phone)).

| Job | Runs for | What it does |
| --- | --- | --- |
| Android app | A tag `android-v<version>`, or Run workflow with app `android` | Ubuntu, JDK 17: `apps/android/build-release.sh --no-publish` with the release key restored from the secrets, then `apps/android/publish.sh` with the API token |
| iPhone app | A tag `ios-v<version>`, or Run workflow with app `ios` | macOS, the runner's newest Xcode: `apps/ios/scripts/build-ipa.sh`, an unsigned IPA, then `apps/ios/scripts/publish.sh` |

Before anything is built, a job checks that the version in the app's files (`craniumVersionName`, `MARKETING_VERSION`)
is the one in the tag, that the tag names the commit being built (for Run workflow, whose `ref` may be the tag or a
branch whose newest commit it names), that the changelog has the version's entry, and that every secret it needs is
set; then that the keystore opens with its password. It runs only in this repository, never in a fork; one release of
each app at a time, and one under way is never cancelled; with a read-only token (`contents: read`), and its actions
pinned by commit as in `ci.yml`. The jobs run with `environment: release`, so the owner can put the secrets behind
that environment's rules (below). Nothing is uploaded as an artifact: an APK or an IPA holds the stack's console address
and client IDs, and anybody can read this repository's artifacts. The job summary says the version, size and
SHA-256 that were published. A last step, run whatever happened, removes the key, the passwords, the configuration
and the build from the runner.

**The secrets.** Four repository secrets, each a file the owner already has. Every value is masked in the log before
anything could print it: the keystore's passwords, and the configuration's console address, login domain, client ID
and pool ID, which name the AWS account. A job fails at once, naming the missing secret, when one is not set.

| Secret | Holds | From | Used by |
| --- | --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The Android release keystore, in base64 | `~/.cranium/android/cranium-release.jks` | Android: restored to a temporary `$HOME/.cranium/android/` |
| `ANDROID_KEYSTORE_PROPERTIES` | Its passwords and alias; the job points `storeFile` at the restored keystore | `~/.cranium/android/keystore.properties` | Android |
| `CRANIUM_CONFIG_JSON` | `apps/config/cranium.json`: what the apps are built with, and the console the job publishes to (its `consoleUrl`) | `apps/config/cranium.json` (from `apps/configure.sh`, or **Download the configuration** on the Apps page) | Both |
| `CRANIUM_CONSOLE_TOKEN` | A release manager's API token (`crn_…`), for `publish.sh` | `~/.cranium/console-token` | Both |

The owner sets them once, from a clone, with the GitHub CLI signed in as an admin of the repository. `gh secret set`
reads the value from standard input, so none of them is echoed or left in the shell's history:

```sh
REPO=ese5180/f26-t07-the-cranium
base64 -i ~/.cranium/android/cranium-release.jks | gh secret set ANDROID_KEYSTORE_BASE64 --repo "$REPO"
gh secret set ANDROID_KEYSTORE_PROPERTIES --repo "$REPO" < ~/.cranium/android/keystore.properties
gh secret set CRANIUM_CONFIG_JSON --repo "$REPO" < apps/config/cranium.json
gh secret set CRANIUM_CONSOLE_TOKEN --repo "$REPO" < ~/.cranium/console-token
gh secret list --repo "$REPO"
```

(`base64 -i` is macOS's; on Linux, `base64 -w 0 ~/.cranium/android/cranium-release.jks`.) An API token lasts at most
90 days: make one for the workflow alone on the console (Developer > API tokens, named "release workflow", 90 days),
keep it in a file of its own rather than reusing `~/.cranium/console-token` if you like, and set the secret again before
it runs out; a job with a dead token fails with the console's 401. After a new deployment of the stack under another
address, set `CRANIUM_CONFIG_JSON` again.

**Making a release.** As in [`docs/versions.md`](versions.md): bump the version, add the changelog entry, commit, then
tag that commit and push the tag, which starts the job:

```sh
git tag -a ios-v0.7.3 -m "<the first paragraph>"
git push origin main ios-v0.7.3
```

`apps/release.sh <version>` does all of it for both apps ([`apps/README.md`](../apps/README.md#release-a-new-version-team)).
From a phone or any browser: on GitHub, Releases > Draft a new release > Choose a tag, type `ios-v0.7.3`, **Create new
tag on publish**, target `main`, then Publish release. The tag starts the job; the release itself has no files and
needs none. To run a release again (after setting a secret, say): Actions > Release the apps > Run workflow, with the
app and the tag as `ref`. Publishing the same build twice is refused as other bytes under a published version, which
is harmless: the first one stands.

**What this risks, and how to narrow it.** Unlike the firmware key ([above](#why-the-signing-key-stays-out)), these
secrets are in Actions. Anyone with push access could write a workflow that reads them. The Android key can sign an APK
that installs over the team's app, though only someone who can publish on the console gets it onto the team's phones;
the token can do, for up to 90 days, whatever a release manager can with an API token, which includes deploying
firmware. The configuration names the AWS account and is no credential. To narrow it, the owner can make the
`release` environment (Settings > Environments) with **Deployment branches and tags** set to the tags `android-v*` and
`ios-v*` and the branch `main`, and a required reviewer if wanted, and set the four secrets there instead
(`gh secret set NAME --env release --repo "$REPO"`, then `gh secret delete NAME --repo "$REPO"`): a workflow on any
other branch then cannot read them. Revoke the token on the console whenever in doubt, and set a new one.

**It has run.** The owner set the four secrets, and on 2026-11-05 the tags released the apps from GitHub:

| Tag | Result |
| --- | --- |
| `ios-v0.7.0` | Passed |
| `android-v0.7.0` | Failed at "Build the signed APK", exit code 2 and no message. `build-release.sh` read the SDK's path from `apps/android/local.properties`, which exists only on a developer's machine; under `set -o pipefail` the failed read ended the script before it looked at `ANDROID_HOME`, which the runner sets. `publish.sh` had the same lookup for `aapt2`. Both now fall back when the file is missing (0e3545e) |
| `ios-v0.7.1`, `android-v0.7.1` | Passed |
| `ios-v0.7.2`, `android-v0.7.2` | Passed |

A tag made this way is only a tag: no GitHub Release is made, and none is needed.

## The check on a release

When a release is published, `release-assets` downloads its files with the workflow's own read-only
token and runs `scripts/verify-github-release.sh` in a checkout of the tag. It fails, with an error
annotation, if any of these is wrong:

- The release holds exactly the image, `latest.json` and `SHA256SUMS`.
- `SHA256SUMS` is right for both files.
- The signature verifies against `firmware/keys/fw_signing_pub.pem`, by the console's check.
- The version in the header, in `latest.json` and in `firmware/app/VERSION` is the one in the tag.
- `latest.json` names the commit that the tag is on, and its `command_line` is an empty list.
- It is not a test image or the golden image, by the same checks as above.

The signature shows who signed the image, and the job can show nothing more about how it was made. An
image carries no commit, and `latest.json` is not signed, so only `latest.json` says which commit the
image is of, and that no setting was given. Whoever can publish a release and holds a really signed
image of that version, a fault image for example, could pass this job with a `latest.json` written by
hand, unless the image has a fault's log lines in it.

The job can read the release and cannot change it, so a failure does not take the release down: a
person has to do that. It uses the public key of the tagged commit, so a tag on a commit that also
changed that key would pass. It runs once, when the release is published, so a file swapped later is
not noticed. It runs the workflow of the tagged commit, so a tag on a commit before this workflow has
no check at all.

## Requiring these checks on main

As it is, a failed check only shows as a red mark. The owner of the repository could make it block a
merge, with branch protection on `main`, or a ruleset, that requires these checks to pass. That setting
needs admin rights on the repository. Changing the workflow does not set it, and whoever is only a
writer cannot.

## Trying it without Actions

The commands of the test jobs work anywhere, from a clean clone:

```sh
firmware/tests/fetch-sdk-files.sh /tmp/sdk
python3 -m venv /tmp/venv
/tmp/venv/bin/pip install -r firmware/tests/requirements.txt
export ZEPHYR_BASE=/tmp/sdk/zephyr PATH=/tmp/venv/bin:$PATH
make -C firmware/tests/host
python3 firmware/tests/hil/test_board.py
python3 firmware/tests/hil/test_recover.py
python3 firmware/tests/hil/test_golden.py
python3 firmware/tests/hil/test_build_report.py
python3 firmware/tests/hil/test_check_image.py
python3 firmware/tests/hil/test_flash_layout.py
python3 firmware/tests/hil/test_memfault_upload.py
python3 firmware/tests/hil/test_provision.py
python3 firmware/tests/hil/test_bt_only_check.py
(cd cloud/api && node --test); (cd cloud/web && node --test); (cd cloud/dev && node --test)
```

On a Mac the sanitizers come from clang, and the compiler and the C library are not the ones Actions
has. `int64_t` is `long long` on a Mac and on the board and `long` on 64-bit Linux, for example. So a
pass on a Mac does not promise a pass on Actions.
