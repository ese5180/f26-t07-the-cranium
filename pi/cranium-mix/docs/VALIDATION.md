# Validation and current limits

## Source being handed off

- Overlay: e3a124f61d9d43d09565b3b2a89bc5994cd585ce.
- Engine: 0351701e897af7e9eca882bfa9a7dca7a99f00e0.
- Latest saved feature package: November 16, 2026, FLX4 Beat FX buttons.
- Historical app archive SHA-256: 5b80d0a8086691260a3fc548ae1b902ebf0ce7924f06c53065cee08a22c7e8de.

All tracked native source and overlay files are included. The original local
checkouts are preserved. SOURCE-PROVENANCE.json lists the small handoff changes;
no native audio/UI algorithm was changed to publish the repository. Git history
starts with this snapshot rather than importing original local author history.

## Historical native build

The saved ARM64 Debian Bookworm test XML reports 221 checks: 211 passed,
10 optional fixture checks skipped, zero failures/errors. The original XML
hash and build fingerprints are recorded in validation.json. The XML and local
logs remain private because they can contain local paths and test media data.
This native run was performed before the handoff, not rerun during publishing.

## Fresh handoff checks

The root tools/test.sh passed locally: 11 Python unit tests, all 16 controller
JavaScript suites, the Windows identifier/installer contract, FLX4 and other
controller preset checks, FX labels, Linux package fixture checks, and parsing
of 40 skin/controller/effect XML files. The full-source layout check no longer
requires original local Git tags or a separate BiteDJ source checkout. CI uses
the same host command; it does not connect to a Pi or measure audio performance.

## Physical work still pending

The final Beat FX button package's saved record says physical_pi_tested=false
and sd_staged=false. Do not equate that package with a confirmed running SD image.
This handoff did not modify a Pi, write an SD card, reflash firmware, or test
physical audio. Track-loading freezes/heat, sustained two-deck audio, final
controller effect sound and Color FX UX still need hardware validation.

Build and native-test scripts are included. A complete build of the new
monorepo layout has not been performed in this publishing step. The native
application files are the same ones used by the recorded successful build.

## Appliance startup update, November 20, 2026

The startup-only update passes the root host checks: **29 Python tests**, all
16 controller JavaScript suites, preset/FX/Windows contract/Linux package
checks, and all 40 XML parses. The new cases cover root/display/serial argument
preservation, pending-installer refusal, LightDM login preflight, failed boot
write rollback, exact startup restore, later-edit/corruption/symlink refusal,
helper checksum tampering, one-automounter selection, keyboard process identity,
bounded metric capture, CPU/iowait arithmetic and historical/current throttling.

No C++, skin, controller mapping or native audio code changes are needed. The
offline package reuses the exact saved app archive above and records the new
startup sources separately. Host checks do not execute LightDM/Sway on ARM64,
measure boot time or establish audio quality. The Pi is offline and hardware
startup, USB mounting, Developer Mode, cooling/load and playback checks remain
pending. No SD card was connected when this update was prepared.
