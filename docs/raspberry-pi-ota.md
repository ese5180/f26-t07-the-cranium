# Raspberry Pi: operating system and over-the-air updates

The Raspberry Pi runs the DJ software and the screen; the nRF board handles the rest.
This page lists the ways to run Linux on the Pi so that it can be updated over the air
(OTA) as safely as the nRF board, and recommends one. **Status: open.** The choice depends
on two facts not settled yet (see [Open questions](#open-questions)).

## The problem

Raspberry Pi OS (Debian-based) runs the software today, but its normal update path is
`apt upgrade`: many files replaced in place on the running system. If power or
Wi-Fi drops halfway, the Pi can be left unbootable with no copy to fall back to. That
fails the bar the nRF board already meets with MCUboot: a new image is checked before it
runs, and a bad one is rolled back.

Debian itself is not the obstacle. What is missing is an *image-based* update with two
copies of the system, which every option below adds in some form.

## Requirements

Taken from the README's requirement tables and manual section 3.5.6. The manual asks for
FOTA on the nRF board only; applying 3.5.6 to the Pi is our own choice.

| ID | Requirement | Source |
| --- | --- | --- |
| P1 | Runs the DJ software with two decks and effects, and drives the built-in screen. | SRS 02, HW 02 |
| P2 | Talks to the nRF board over UART (heartbeat, battery level). | SRS 03 |
| P3 | Ready to use within 30 s of power-on. | SRS 01 |
| P4 | A shutdown on low battery leaves no filesystem corruption. | SRS 05 |
| P5 | Installs an update only if it is signed with our key. | 3.5.6, invalid signature |
| P6 | Returns to the previous version by itself if a signed update fails to boot or start. | 3.5.6, faulty code with a valid signature |
| P7 | A corrupted or interrupted download leaves the running system untouched. | 3.5.6, corrupted download |
| P8 | Keeps the music library and settings across updates. | SRS 04 |
| P9 | Updated over Wi-Fi, ideally from the same console as the nRF board. | [aws-iot.md](aws-iot.md) |

## How an A/B update works

Options 1 to 5 all follow the same pattern (Figure 1).

```
  SD card
  ┌────────┬──────────────┬──────────────┬─────────────────────┐
  │ boot   │ system A     │ system B     │ data                │
  │        │ (running)    │ (spare)      │ library, settings   │
  └────────┴──────────────┴──────────────┴─────────────────────┘

  1. Download the update, check its signature, write it to B.   A is never touched.
  2. Reboot into B once, on trial.
  3. A health check (DJ software up, UART heartbeat answered) marks B good.
     No boot, or no "good" within the time limit: the next boot goes back to A.
```

*Figure 1: two copies of the system plus a data partition that updates never overwrite.*

Step 1 covers P5 and P7; steps 2 and 3 cover P6; the data partition covers P8. A
system partition that is mounted read-only also helps P4, since a sudden power cut can
then only affect the data partition.

## Options

### 1. Raspberry Pi OS + Mender

Set up one Pi with the software, then `mender-convert` turns its disk image into an A/B
image with the Mender client. Updates are signed Mender artifacts; the client rolls back
if the new system does not come up.

**Pros**
- The software installs and runs exactly as it does now (P1, P2 with no new work).
- Full-system A/B updates with automatic rollback (P6, P7).
- Little new tooling: start from a Pi already set up by hand.
- Server is either self-hosted (open source, free) or hosted by Mender.
- Can also send small application-only updates.

**Cons**
- A second update server next to AWS IoT: two consoles, two device identities (P9).
- Signing has to be switched on and the public key installed on the Pi (P5).
- Debian images are large, so each full update is a large download.
- Hosted Mender is paid: Starter plan from $29/month for up to 50 devices (pricing page).
- A hand-configured Pi is hard to reproduce exactly on four MVP devices.
- Root filesystem stays read-write by default (P4).
- Raspberry Pi 5 is supported through Mender's Yocto layer; support in `mender-convert`
  is not confirmed (`[TBD: check if the Pi is a 5]`).

### 2. Yocto + RAUC

Build a custom Linux with Yocto (lecture L02), using the `meta-raspberrypi` layer and
RAUC (Robust Auto-Update Controller) for A/B updates. `meta-rauc-community` has a
Raspberry Pi example.

**Pros**
- A minimal image built from source files in the repository; every device gets the same
  image. This is the usual approach for commercial Linux products.
- RAUC refuses unsigned bundles; signing is not optional (P5).
- A read-only system partition is one image feature (`read-only-rootfs`) (P4).
- RAUC has no server of its own, so the existing AWS IoT stack can drive it (P9): an AWS
  IoT job tells the Pi to fetch a signed bundle from S3, and a job handler in the AWS IoT
  Device Client runs `rauc install`. One console updates both boards.
- Only what we include is on the device, so there is less to attack than on full Debian.
- Covered in lecture L02, which makes it easy to justify in the report.

**Cons**
- Steepest learning curve of the six.
- The DJ software needs a Yocto recipe. Easy if a layer already has one; hard for a large
  Qt application with many dependencies (`[TBD: does one exist]`).
- Builds need a Linux host with at least 140 GB free disk (Yocto Quick Build, 5.3 and
  6.0 docs). The laptop used for nRF builds had 20 GB free on 2026-10-25, so this means a
  Linux PC or a cloud build machine. First build takes hours.
- The console and the job handler on the Pi need new work (job document for the Pi,
  device group, health check that calls `rauc status mark-good`).
- Every change to the software means rebuilding the image: slow while the app is still
  changing.

### 3. Buildroot + RAUC or SWUpdate

Same idea as option 2 with Buildroot (also in lecture L02). Both RAUC and SWUpdate are
Buildroot packages.

**Pros**
- Simpler than Yocto (one configuration menu and Makefiles); faster builds.
- Very small images: small downloads, fast boot (P3).
- Same signed, AWS-driven update path as option 2 (P5, P9). With SWUpdate, signing is a
  build option that must be switched on.
- A read-only system partition is one configuration setting (P4).

**Cons**
- Far fewer ready-made packages than Yocto; anything missing we package ourselves.
- No package manager; many configuration changes need a full clean rebuild.
- A desktop-style audio and graphics application is harder to build here than in Yocto.
- Also needs a Linux build host.

### 4. balenaOS + balenaCloud

balena maintains and updates the operating system; our software runs in a Docker
container managed from balenaCloud.

**Pros**
- The container can be Debian-based, so the software installs with `apt` as today (P1).
- An app update is a new container; only changed layers are downloaded.
- Host OS updates roll back on their own if the new OS does not boot or its health
  check fails.
- Dashboard, remote shell and logs included.
- Fast development loop: push from a laptop.
- Free for the first 10 devices (balena pricing page), enough for four MVP devices.

**Cons**
- Devices are managed from balenaCloud, not our AWS console (P9).
- The container needs extra setup to reach the screen, audio and the UART to the nRF
  board (P1, P2).
- We do not hold a signing key; trust rests on balena's servers (P5 not met as written).
- The OS rollback health check looks at balena's own services, not our app; an app
  release that starts but misbehaves is not rolled back by it (P6 partly).
- openBalena (self-hosted) has fewer features than balenaCloud.
- Containers add some storage and memory overhead.

### 5. Ubuntu Core + snaps

An operating system made only of signed, read-only snaps. Every update is transactional
and reverts if it fails. Ubuntu Core 24 supports the Raspberry Pi 4 and 5 (Canonical).

**Pros**
- Atomic updates and automatic revert for the OS and for apps (P6, P7).
- Read-only base, sandboxed apps, every snap signed (P4, P5).
- Canonical provides OS security updates for years.

**Cons**
- The software has to be packaged as a snap; `snapcraft` takes time to learn.
- The sandbox must be explicitly opened for the screen, audio and serial port (P1, P2).
- Updates go through the Snap Store; a private store costs money, and none of it uses
  our AWS stack (P9). Snaps are signed by the store, not with our own key.
- Smaller community for Pi-specific embedded problems.

### 6. Raspberry Pi OS + AWS IoT Greengrass or AWS IoT jobs (application only)

Keep Raspberry Pi OS as it is and update only the DJ software, through AWS IoT
Greengrass components or plain AWS IoT jobs.

**Pros**
- Reuses the AWS stack directly; one console for both boards (P9).
- The software runs exactly as now (P1, P2).
- Least new work of the six.

**Cons**
- Updates the application only; the OS and kernel cannot be updated safely or rolled
  back (P6, P7 for the OS).
- OS updates stay the unsafe `apt` kind.
- Root filesystem stays read-write (P4).
- Standard Greengrass runs on Java: 96 MB RAM for Greengrass alone, 512 MB recommended
  for the device (AWS docs). The C-based Greengrass nucleus lite needs about 5 MB.
- Weakest answer to the security part of the assignment.

## Comparison

| | Software as today | Signed with our key | OS rollback | Our AWS console | Read-only system | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| 1. Pi OS + Mender | Yes | Yes, once enabled | Yes | No | No | Low |
| 2. Yocto + RAUC | Needs a recipe | Yes, required | Yes | Yes | Yes | High |
| 3. Buildroot + RAUC/SWUpdate | Needs a package | Yes (SWUpdate: once enabled) | Yes | Yes | Yes | Medium–high |
| 4. balenaOS | Yes, in a container | No | Yes | No | Yes (host OS) | Low–medium |
| 5. Ubuntu Core | Needs a snap | Store-signed | Yes | No | Yes | Medium |
| 6. Pi OS + Greengrass/jobs | Yes | App only | No | Yes | No | Low |

*Table 1: how each option meets the requirements above.*

## Recommendation

Table 1 shows only options 2 and 3 meet every requirement, and option 2 is the more
practical of the two for a large audio and graphics application.

- **If the DJ software builds under Yocto without much effort: option 2 (Yocto + RAUC).**
  It meets P1 to P9, reuses the AWS IoT console and signing approach built for the nRF
  board, and gives the clearest security story.
- **If it does not: option 1 (Raspberry Pi OS + Mender)**, with Mender artifact signing
  switched on. It gives safe full-system updates without rebuilding the software, at the
  cost of a second server.
- Option 4 is a reasonable alternative to option 1 if the team is comfortable with
  containers.

## Open questions

- Which DJ software runs on the Pi, and is there an existing Yocto recipe or Buildroot
  package for it? `[TBD: team]`
- Which Pi model (4 or 5)? It decides whether `mender-convert` is usable. `[TBD: team]`
- Boot-to-ready time on each candidate image, measured against P3. `[TBD: measure]`
- Which Linux machine builds the images (option 2 or 3). `[TBD: team]`

## Test plan

On the chosen option, repeat the failure tests used for the nRF board:

1. Update signed with a different key: refused, system unchanged.
2. Update signed with our key whose DJ software does not start: rolled back after the
   health-check time limit.
3. Download cut off halfway, and a bundle with one byte changed: refused, system
   unchanged.
4. Power removed during an update: Pi boots the previous version.
5. Library and settings present after a successful update and after a rollback.

## Sources

Checked on 2026-10-25.

- Yocto Project Quick Build, disk requirement:
  <https://docs.yoctoproject.org/brief-yoctoprojectqs/index.html>
- Mender plans and pricing: <https://mender.io/plans/pricing>
- Mender on Raspberry Pi 5 (Yocto): <https://hub.mender.io/t/raspberry-pi-5-wip/6689>
- RAUC examples: <https://rauc.readthedocs.io/en/stable/examples.html>
- balena pricing: <https://balena.io/pricing>
- balenaOS rollbacks: <https://docs.balena.io/reference/os/updates/rollbacks>
- Ubuntu Core supported platforms: <https://ubuntu.com/core/docs/supported-platforms>
- Greengrass nucleus requirements:
  <https://docs.aws.amazon.com/greengrass/v2/developerguide/setting-up.html>
- Greengrass nucleus lite:
  <https://docs.aws.amazon.com/greengrass/v2/developerguide/greengrass-nucleus-lite-component.html>
- AWS IoT jobs for over-the-air updates:
  <https://aws.amazon.com/blogs/iot/using-device-jobs-for-over-the-air-updates>
