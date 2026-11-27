# Historical two-repository development notes

These notes describe the original November 8-16 local development layout.
Current partner instructions are in [the root README](../../README.md).
Statements below about unpublished/unbuilt status are historical.

# Cranium development on NauticMixxx

**November 9 update:** the first ARM64 Bookworm app has now been compiled for
the 800×480 scaling trial. Native checks passed (184 passed; 9 optional fixture
checks skipped). The trial uses the existing reference-fill scaler and a
reduced splash image, with an isolated offline Pi installer and three-app
chooser. See `PI-TRIAL.md` and the current validation entry below. Earlier setup
sections describe the source-preparation baseline from November 8.

This is an editable local fork, not a locked binary or a skin-only experiment.
The overlay is pinned to NauticMixxx 2.0.0, commit
`c73631bafbc7150587cf9de0c32437531d295103`, on `cranium/pi4-adaptation`.
The remote `upstream` retains the original project. No GitHub publication or
installation on the Pi has been performed in this setup step.

## What is ready

The sibling `../cranium-nauticmixxx-engine` is the full persistent C++ source.
It starts at Mixxx 2.5.6 commit `3ebac449e7e5fe2a0186596657696e87ce8b0e56`,
with all 44 NauticMixxx patches applied and Linux icon resources prepared.
The native baseline is committed and tagged `cranium/nautic-2.0.0-base`.
Every browser, keyboard, decoder, mixer, recording and controller component
is editable in source. There is no dependency on a closed customization API.

Source preparation and upstream release validation passed, including the
USB-only source contract, XML, JavaScript and FLX4 preset/browser checks.
The Linux package/profile fixture check also passes. Native compilation and
native test execution are a later step; no NauticMixxx Pi performance or
screen-fit result is claimed here.

## Where to edit

| Change | Persistent source location |
| --- | --- |
| Overall layout, colors, touch controls | `skins/XDJ_RX3_Mixxx/*.xml` and `style.qss` in this repo |
| Startup art and product icon | `branding/`, skin launch-image declarations, and prepared engine resources |
| Source/category/search behavior | Engine `src/widget/wrx3browser.h`, `rx3browsernavigation.h`, `wrx3browserutility.h` |
| Native keyboard geometry/search UI | Engine `src/widget/wrx3browser.h` and related RX3 widgets |
| USB session/import/write behavior | Engine `src/library/rekordbox/`, `src/util/rx3usbstorage.h` |
| Per-deck key shift | Engine `src/engine/controls/keycontrol.cpp`; controls already include `pitch_adjust` |
| Recording tools and mixer capture | Engine `src/widget/wrx3browsertools.h`, `src/recording/`, `src/engine/sidechain/` |
| FLX4 buttons, encoder and LEDs | `controllers/Pioneer_DDJ_FLX4_RX3/` in this repo |

Layout/controller scripts can generally be redeployed as resources and tested
after restarting. C++ changes require compiling the native app again.

## Keep native changes reproducible

Edit the persistent engine, commit its native edits, then run from this repo:

```sh
python3 cranium/export-engine-patch.py
```

Commit the resulting `cranium/patches/0099-cranium-native.patch` here. It contains
the aggregate native diff from our baseline; it is replayed on fresh source
preparation after the original 44 patches. The build command uses the edited
engine directly and never downloads or resets it. Do not make permanent feature
edits inside a temporary build directory.

For a new machine or a new empty engine folder, install Pillow in a project
Python environment, then run:

```sh
python3 cranium/prepare-engine.py ../cranium-nauticmixxx-engine
```

This checks the upstream commits and patch count, applies/commits the baseline,
prepares icons, and applies any saved Cranium native patch. Running it on an
already prepared engine preserves existing edits. It refuses an unexpected
unprepared source tree instead of resetting it. Source setup on the Mac used
Pillow 12.0.0 in `../nauticmixxx-build/.venv`, not the system Python environment.

## Build the edited app later

Use ARM64 Debian Bookworm, as for the working BiteDJ build. The current Lima
builder can be reused after mounting these two additional source directories.
It now also mounts the project directory at `/workspace`, including both
NauticMixxx source repositories.
Reuse the dependency list in `../cranium-bitedj/cranium/build-dependencies.txt`
and add `python3-pil`, `fonts-open-sans` and `desktop-file-utils`. Do not blindly run the upstream
dependency installer on Bookworm: its Qt compatibility package spelling differs
from Bookworm's `qt6-5compat-dev`.

Inside that Linux builder, set paths appropriate to its mounts:

```sh
export CRANIUM_NAUTIC_ENGINE_SOURCE=/workspace/cranium-nauticmixxx-engine
export CRANIUM_NAUTIC_BUILD_ROOT=/artifacts/nautic-build
bash /workspace/cranium-nauticmixxx/cranium/build-editable.sh
```

The script builds the persistent engine, runs targeted native tests and stages
the overlay, controller mappings and an isolated-profile launcher. This recipe
is prepared but has not been executed for this fork. The staged result is not
a universal Linux installer. Pi deployment must preserve native Mesa, Wayland,
GPU drivers and the C runtime; the working BiteDJ correction establishes why.
Use a separate `/opt/cranium/nauticmixxx` installation and
`NAUTICMIXXX_PROFILE=/home/pi/.cranium-nauticmixxx` when packaging the trial.

For a Cranium fork, seed `[NauticUpdates] CheckOnStartup 0` and
`AutomaticallyDownload 0` in its own profile. Future updates should be reviewed
source merges, not replacement by upstream release binaries.

## Screen adaptation and RX3 target

The upstream skin declares a 1280×800 reference/minimum. The current DSI screen
is 800×480. Lowering the minimum or uniformly shrinking the design will not by
itself make fonts, hit targets and the native browser usable. Preserve the RX3
source → category → list workflow while reflowing it for the smaller screen.
Touch navigation must work without requiring hardware buttons the FLX4 lacks.

Start with SOURCE/BROWSE/SEARCH/BACK, two-deck load actions and a full-height
track list. Then adapt performance controls and add prominent record state,
per-deck ±semitone/reset controls, and Cranium startup/visual identity.
Key shift changes musical pitch independently of tempo; key lock/master tempo
is a different control. Existing recording/audio controls can be surfaced in a
clear touch UI, with visible recording status and explicit stop behavior.

NauticMixxx's own workflow guide identifies remaining gaps: Link Export,
registered MATCHING pairs, full RX3 effect catalogs and hardware calibration.
Matching RX3 operation is the product target, not a verified current capability.
Pi CPU/audio latency, FLX4 routing, writable recording storage and physical touch
tests remain real engineering constraints. Access to editable source is ready.

NauticMixxx's adaptation/skin is GPL v3; the Mixxx engine is GPL v2-or-later.
Keep licenses and attribution and include corresponding modified source when
sharing builds under their GPL terms. Cranium branding can replace the visible
product identity while preserving those notices. See `LICENSE.md` and
`THIRD_PARTY_NOTICES.md` for the component inventory.
