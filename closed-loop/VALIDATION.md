# Professor-example alignment - 2026-11-15

The public app now follows the example's app/west/CMake/Kconfig/board-overlay
layout. The app generates its own selected profile header, and both Nordic
application/network images build with verified effective settings. The pinned
NCS manifest recursively resolves 74 projects under deps/ against the matching
installed SDK; a cold network fetch is not claimed. PPK2-only measure/hold,
including configuration without a Saleae, are implemented and host-tested.

All 26 host tests pass. Both standalone and full rig paths refuse absent or
unverified hardware before enabling power. No physical measurements or flash
were performed. Current public source/build fingerprints are recorded in
evidence/software-validation.json. Historical software-installation checks
below remain useful context; the live hardware requirement is still pending.

## Original virtual validation - 2026-11-12

## Confirmed

- NCS 3.4.0 compiles both baseline and optimized profiles, each with an
  nRF5340 application image and an IPC HCI Bluetooth network-core image.
  Source SHA-256: `dd4902ccf09c5ca347f7dd4f53f13e718b5a6d84f3b129ed817c3ab6fc65d26f`.
- Baseline application HEX SHA-256:
  `c56b6bfc5c3711b54ea44a4db06fc955279afa1ab73cb992a138221fe4fa641f`.
- Optimized application HEX SHA-256:
  `2003da602aae23724d174f06d68a65c8fdce1e54031696d38a5c0125a04451d9`.
- Both network-core HEX SHA-256:
  `b1945528af98dcc17eb1948ac729083ae7f12c2be346a06eeb7aa5e09e28d3ee`.
- The original 20 host tests passed at setup (the current expanded suite has 26).
  They compile and load the actual C protocol implementation; exercise
  a known CRC vector, Unicode/maximum-size payloads, corruption, truncation,
  uint32 wrap, stale/duplicate sequence rejection and 1,500 bounded random frames.
- Independent UART analysis is checked against generated 8N1 edges, incorrect
  bytes and late ACKs. Power validation rejects absent/nonfinite/zero samples,
  inadequate sample coverage, insufficient improvement and inconsistent pairs.
- Tests cover missing-hardware refusal without a flash, candidate rollback,
  power-off/serial cleanup, and preserving PPK2 sample framing across partial
  USB reads and refusing missing calibration metadata before power-on. These
  are software fixtures, not physical evidence.
- The real stdio MCP adapter initializes, lists seven bounded tools, rejects
  arbitrary commands/paths, blocks a no-rig experiment, and starts a persistent
  host-test job that exits successfully. Simulation cannot satisfy preflight.
- Actual Hapimatic 1.0.2094 native Mac binary verifies against the official
  release checksum. Its HTTP endpoint returns 200; access-token authentication
  succeeds and the daemon reports one online Mac machine. The coding agent was
  not started during this software setup.
- The coding agent's CLI is present and reports an existing sign-in.
  The cranium-bench adapter is registered. The CLI's MCP-add operation initially
  normalized away an existing node_repl argument list; that list was restored
  and all prior MCP entries and sandbox/approval settings compared unchanged.
  The repeatable installer appends only the new entry and avoids that serializer.
- Official Saleae Logic 2.4.49 is installed and its original macOS signature
  verifies. Its automation API lists only simulated devices. A one-second,
  two-channel, 4 MS/s simulated capture and raw CSV export succeed under
  `captures/installation-simulation-only/`, explicitly `hardware_passed:false`.
- Logic's embedded Python adds disposable bytecode caches inside its bundle
  on first launch. Setup removes only unarchived generated .pyc caches and
  then verifies the original signature; it neither re-signs nor skips checks.
- Nordic nrfutil's SDK-provided device plug-in successfully lists devices,
  returning an empty physical device list. No recover/erase/program operation
  was issued. Both sibling DJ application repositories remain unchanged.
- The actual experiment preflight saved a BLOCKED report and a README update
  for absent DK, physical Saleae, PPK2 and unverified wiring. It did not enable
  power or flash anything. The one-click launcher is designed to stop likewise.

## Still requires the physical rig

Real UART electrical timing and packet capture; real BLE notification delivery;
PPK2 rail preparation and known-load qualification; actual before/after current;
SWD flashing/reset on the selected board; and a complete AI-directed hardware
repair/checkoff run. No current reduction, physical pass, battery estimate,
live Pi journal integration or signed OTA/fleet feature is claimed by these
software checks. The deployed CRANIUM Pi and its SD card were not changed.

## Reproduce

Run `./bench test`, build each profile, then `Open Workbench.command` or
`Start AI Loop.command` after physical setup. Tests must pass independently of
any USB hardware. Real experiments must retain raw captures and manifests.

`setup.sh` restores pinned local software and adapter registration. Documentation
PDFs can be regenerated after installing requirements-docs.txt, using
`python tools/export-readme.py`; `python tools/export-kit.py` exports the
Git source plus checksum-verified application/network images, excluding local
state, device choices, credentials and experimental captures.
