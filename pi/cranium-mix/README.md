# CRANIUM Mix

The current editable CRANIUM DJ application for **Raspberry Pi 4, ARM64 Debian
Bookworm, an 800 x 480 DSI touchscreen, and Pioneer DDJ-FLX4**.

This handoff contains the **full modified C++ engine**, skin, controller mappings,
startup branding, settings UI, Pi installer and build tooling. One clone gets
both source trees; there are no Git submodules or missing private repositories.

Prepared November 20, 2026 from the latest saved feature build, November 16.

This is the touchscreen application variant, kept separately from the existing
Pi telemetry scripts and the team's Mixxx 2.7.0-alpha fork. It targets Bookworm
and does not replace their Trixie setup or claim telemetry compatibility yet.
The exact original commits and build fingerprints are in
[SOURCE-PROVENANCE.json](SOURCE-PROVENANCE.json) and
[the validation record](docs/VALIDATION.md).

## What is included

- CRANIUM startup branding and fullscreen appliance session, with developer access.
- Reversible quiet startup, one USB automounter, a desktop keyboard only in
  Developer Mode, and bounded performance diagnostics. See
  [startup/update notes](docs/APPLIANCE-STARTUP.md); Pi verification is pending.
- The adapted 800 x 480 performance layout and persistent SOURCE, BROWSE,
  TAG LIST, PLAYLIST, SEARCH, MENU and INFO navigation.
- Rekordbox USB browsing, playlist touch navigation, and imported grids/key/cues
  preserved when loading tracks by drag-and-drop.
- Search keyboard state fixes, embedded controller/audio settings, asynchronous
  device checks, and touch Play/Pause controls in Audio Setup.
- Proportional two-finger waveform zoom in any orientation. Dragging the central
  playing waveform is blocked; lower overview waveforms remain adjustable.
- FLX4 performance-mode encoder zoom, with browser click/navigation preserved.
- Beat FX routing: 1 -> deck 1, 2 -> deck 2, 1&2 -> MASTER.
- Latest Beat FX SELECT cycling through eight supported effects, SHIFT reverse,
  ON/OFF slot/chain control, LED feedback and BEAT timing controls.

The latest Beat FX button build passed 211 targeted native tests, with 10
optional fixture checks skipped. Its final physical Pi/FLX4 audio check was
still pending in the saved build record. Earlier UI behavior has been exercised
on the project's Pi; this does not establish smooth performance on a 1 GB Pi.
Track-loading stalls/heat remain unresolved, and Color FX still needs a separate
selection workflow and audio validation. RX3 parity is a goal, not a completed claim.

## Start here

```sh
git clone https://github.com/ese5180/f26-t07-the-cranium.git
cd f26-t07-the-cranium/pi/cranium-mix
bash tools/test.sh
```

Host checks need **Python 3.12+ and Node.js 22+**. They work without a controller,
Pi, Nordic SDK or connected SD card. They do not compile the native audio engine.

| What you want to change | Edit here |
| --- | --- |
| Layout, touch buttons, colors | `cranium-nauticmixxx/skins/XDJ_RX3_Mixxx/` |
| FLX4 buttons, encoder and LEDs | `cranium-nauticmixxx/controllers/Pioneer_DDJ_FLX4_RX3/` |
| Browser/search/settings | `cranium-nauticmixxx-engine/src/widget/wrx3browser*.h` |
| Waveform touch/zoom | `cranium-nauticmixxx-engine/src/waveform/` and `src/widget/` |
| Audio, effects, playback | `cranium-nauticmixxx-engine/src/engine/`, `src/effects/` |
| Startup, kiosk and Pi installation | `cranium-nauticmixxx/cranium/pi/` |
| Packaging and isolated app launcher | `cranium-nauticmixxx/packaging/linux/` |

Work on a branch, run the checks, and commit your edits in this repository.
Both folders are ordinary directories in the same Git checkout. **Do not run
the legacy `prepare-engine.py` or `export-engine-patch.py`.** The complete patched
engine is already here; the original 0099 patch is retained as historical evidence.

The stock top-level engine README and upstream platform guides describe Mixxx
or NauticMixxx, not a separately verified CRANIUM Mac/Windows release. Mac users
can edit and run host checks locally, then build the Pi app in ARM64 Linux.

## Build for the Pi

Use **64-bit ARM Debian 12 Bookworm**, either on a Pi with enough build resources
or an ARM64 Linux builder/VM. Our current Pi package uses that OS/architecture.
Do not substitute a Trixie/Ubuntu build and assume its libraries match Bookworm.

```sh
bash tools/install-build-deps.sh
bash tools/build-pi.sh
```

The build defaults to one compiler job and disables precompiled headers.
Build output is ignored under `build/pi/`; set `CRANIUM_NAUTIC_BUILD_ROOT` to
use a different output location outside both source folders. Source edits are
preserved. The build compiles the engine, runs targeted native tests, stages
the resources, and validates the Linux package.

Test the resulting app **inside a graphical session**:

```sh
./build/pi/stage/bin/nauticmixxx
```

Use an isolated profile for experiments, for example
`NAUTICMIXXX_PROFILE="$HOME/.cranium-partner-test"`. Keep the known working
profile and music library separate from development tests.

The staged app still uses distribution libraries. To create an offline Pi
bundle on the same ARM64 Bookworm builder:

```sh
python3 cranium-nauticmixxx/cranium/bundle-pi.py \
  build/pi/stage build/pi-offline \
  --engine cranium-nauticmixxx-engine
```

The bundle contains the app payload and manifest. Use `tools/prepare-pi-update.py`
to add the startup helpers and their checksums, as described in
[Pi deployment notes](docs/PI-DEPLOYMENT.md). **This repository is source, not a
flashable SD image or a ready-made Mac/Windows download.**

## Integrating your changes

The application uses a dedicated `~/.cranium-nauticmixxx` profile on our Pi.
Do not commit profiles, music, databases, SD images, signing keys or credentials.
Resource-only changes need redeployment/restart; C++ changes need a rebuild.

The Nordic telemetry firmware and CRANIUM Companion website are separate
components. Merge their integration deliberately; this application snapshot
does not include a teammate's independent firmware changes.

## Attribution and licenses

CRANIUM Mix modifies **NauticMixxx 2.0** and **Mixxx 2.5.6**. Preserve the original
licenses, notices and third-party component terms:

- [NauticMixxx license](cranium-nauticmixxx/LICENSE.md)
- [NauticMixxx third-party notices](cranium-nauticmixxx/THIRD_PARTY_NOTICES.md)
- [Mixxx license](cranium-nauticmixxx-engine/LICENSE)
- [Original NauticMixxx README](cranium-nauticmixxx/UPSTREAM-README.md)

The NauticMixxx components use GPL v3; Mixxx retains GPL v2-or-later terms.
Bundled third-party components retain their individual notices. This is an
independent project, not an official Pioneer DJ/AlphaTheta product.
