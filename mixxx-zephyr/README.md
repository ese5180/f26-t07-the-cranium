# Mixxx Zephyr

A two-deck DJ player for the Pioneer DDJ-FLX4 that runs on a microcontroller
under Zephyr, ported from [Mixxx](https://github.com/mixxxdj/mixxx). It is a
side project next to the main design, in which a Raspberry Pi runs Mixxx itself
([`docs/raspberry-pi-ota.md`](https://github.com/ese5180/f26-t07-the-cranium/blob/feature/ota-console/docs/raspberry-pi-ota.md)
on the `feature/ota-console` branch).

**Status: builds and passes its host tests; not yet run on hardware.**

## Why a port and not a recompile

Mixxx is C++, but 1,163 of its 1,985 source files include Qt, a desktop
framework with no Zephyr version, and it needs Linux, OpenGL and hundreds of
megabytes of RAM. Compiling Mixxx's engine with the Zephyr toolchain stops at
the first `#include <QObject>`. So this directory rewrites, without Qt, the
parts of Mixxx a two-deck player needs, keeping Mixxx's behaviour and numbers.
Where a piece of Mixxx is plain C++ it is ported line for line, and the tests
compile the original next to the port and compare them.

| Here | From Mixxx (`main` at `2f4234b`, 2026-10-24) | How |
| --- | --- | --- |
| `xfader.cpp` | `src/engine/enginexfader.cpp` | Line for line; the tests check it bit for bit against the original |
| `scratch.cpp` | `src/util/alphabetafilter.h`, `src/util/rotary.cpp`, `scratchEnable/Tick/Disable` in `src/controllers/scripting/legacy/controllerscriptinterfacelegacy.cpp` | Same filters and constants; the alpha-beta filter is checked against the original |
| `control_behavior.cpp` | `src/control/controlbehavior.cpp` | Same tapers for faders, gains and the filter knob |
| `eq.cpp` | `src/effects/backends/builtin/threebandbiquadeqeffect.cpp` ("Biquad Equalizer") | Same frequencies, Qs and gains |
| `filter_effect.cpp` | `src/effects/backends/builtin/filtereffect.cpp`, LinkedLeft/Right in `src/effects/effectknobparameterslot.cpp` | Same corners, Q clamping and knob linking |
| `biquad.cpp` | `src/engine/filters/enginefilterbiquad1.cpp` (fidlib `PkBq`, `HsBq`, `LpBq`, `HpBq`) | The same RBJ cookbook designs, without fidlib |
| `deck.cpp` | `EngineBuffer`, `CueControl`, `LoopingControl`, `RateControl` | The subset the FLX4 uses: see below |
| `mixer.cpp` | `src/engine/enginemixer.cpp` | Channel faders, crossfader, pre-fader cue, `headMix`, main and headphone gain |
| `caching_reader.cpp` | `src/engine/cachingreader/` | Same idea: the audio thread never waits for storage |
| `midi.cpp`, `tools/gen_mapping.py` | `src/controllers/midi/`, `res/controllers/Pioneer-DDJ-FLX4.midi.xml` and `-script.js` | The XML is turned into C++ tables at build time; the script functions the deck needs are built in |

## What the deck does

From the FLX4: play/pause, CUE (Mixxx cue mode: set, return and stop, preview
while held), 8 hotcues per deck (set, jump, preview while held, clear), manual
loops (in, out, reloop, reloop-and-stop), the tempo slider with Mixxx's 8 %
default and the FLX4's 6/10/16/25 % range button, jog-wheel nudge and
scratching, trim, three-band EQ, the CFX filter knob, channel faders,
crossfader, cue (PFL) buttons, the headphone mix knob, track browsing and the
LOAD buttons. LEDs follow play, cue, hotcue, PFL and track-loaded states.

The generated mapping covers 99 of the mapping's 281 inputs and 46 of its 112
LED outputs. Left out, and listed at the top of the generated file: beat FX,
sampler, stems, key shift, beatjump, sync, quantize, beatloops (no beat grid),
the CUE/LOOP CALL buttons, loop adjust, slip mode and waveform zoom.

Not in this port: keylock (pitch-independent tempo), beat detection and sync,
effects other than EQ and filter, compressed formats (only uncompressed WAV is
decoded: 8/16/24/32-bit integer or 32-bit float, mono or stereo, 8 to 192 kHz),
waveform display, recording, the Mixxx library database and rekordbox USB
import.

## Hardware: nRF7002 DK

The nRF5340 application core (Cortex-M33, 128 MHz, 1 MiB flash, 512 KiB RAM)
runs it. Everything else goes on the Arduino header
([`app/boards/nrf7002dk_nrf5340_cpuapp.overlay`](app/boards/nrf7002dk_nrf5340_cpuapp.overlay)):

| Pin | Use |
| --- | --- |
| D0 / D1 | MIDI in / out, UART1 at 31250 baud (DIN MIDI through an opto-coupler) |
| D4, D5, D6, D7 | I2S bit clock, word clock, data, master clock to a DAC such as a PCM5102A board |
| D10–D13 | SD card on SPI3 (FAT, tracks in `/MUSIC`) |

The DDJ-FLX4 is a USB device and the nRF5340 has no USB host, so the
controller's MIDI must reach the board as DIN MIDI, for example through a
USB-host-to-DIN-MIDI adapter. The I2S output is one stereo pair: main mix by
default, or the headphone mix, or Mixxx's split cue (cue left, main right) via
`CONFIG_MZ_OUTPUT_*`.

Measured from the build (`nrf7002dk/nrf5340/cpuapp`, Zephyr 4.4.2, `-Os`):

| | Used | Of |
| --- | --- | --- |
| Application image (slot 0) | 111,968 B | 470,890 B (23.8 %) |
| MCUboot | 30,800 B | 64 KiB (47 %) |
| RAM | 240,520 B | 448 KiB (52 %); 192 KiB of it is the track cache |

## Over-the-air updates

The board's flash keeps Zephyr's nRF5340 layout: MCUboot 64 KiB, the running
image (slot 0) and the update (slot 1) 464 KiB each, and 32 KiB of settings,
with the 8 MiB external flash still free. The build (`sysbuild.conf`) signs the
image for MCUboot with ECDSA P-256. After an update MCUboot runs the new image
once on trial; `main.cpp` confirms it only after the SD card has mounted and
audio has played for `CONFIG_MZ_CONFIRM_AFTER_MS` (10 s) without a late block.
Otherwise the next reset goes back to the previous image. The hardware
watchdog (4 s) is fed only while audio blocks keep arriving, so an image that
hangs on trial is reset and replaced by the previous one. Getting the update
into slot 1 (over Wi-Fi from the AWS IoT console, as the course firmware does,
or over a serial link) is not part of this directory yet.

The build signs with MCUboot's public development key unless you pass your own:
`west build ... -- -DSB_CONFIG_BOOT_SIGNATURE_KEY_FILE=\"/path/to/key.pem\"`.

## Build and test

Host tests (any C++17 compiler; AddressSanitizer and UBSan are on):

```sh
cmake -S mixxx-zephyr/tests -B build/mz-tests && cmake --build build/mz-tests
build/mz-tests/mz_tests            # 48 tests
```

Hear it on a computer: render a crossfade between two WAV files.

```sh
cmake -S mixxx-zephyr/host -B build/mz-host && cmake --build build/mz-host
build/mz-host/mz_render deck1.wav deck2.wav mix.wav 20
```

Firmware (a Zephyr workspace with `hal_nordic`, `mcuboot` and `fatfs`, and the
MCUboot `imgtool` requirements installed):

```sh
west build -b nrf7002dk/nrf5340/cpuapp --sysbuild mixxx-zephyr/app
west flash
```

Flashing replaces the course firmware on the board.

## Layout

```
engine/    the player, plain C++17: no Qt, no Zephyr, no heap on the audio path
mappings/  Pioneer-DDJ-FLX4.midi.xml, unchanged from Mixxx
tools/     gen_mapping.py: Mixxx mapping XML to C++ tables
tests/     host tests; mixxx_reference/ holds original Mixxx files they compare against
host/      mz_render, the engine on a computer
app/       the Zephyr application: I2S, SD card, MIDI UART, MCUboot
```

The engine runs on three threads that only exchange messages through lock-free
queues: the audio thread renders 256-frame blocks (5.3 ms at 48 kHz) into I2S,
the MIDI thread turns controller messages into control events, and `main`
reads tracks from the SD card into each deck's cache. The per-sample loops use
single-precision floats and a 32.32 fixed-point play position, because the
Cortex-M33 FPU has no double precision.

## Licence

Mixxx is GPL-2.0-or-later, and so is everything in this directory
([COPYING](COPYING)). Firmware built from it may only be distributed with its
source code. The FLX4 mapping and the Mixxx files in `tests/mixxx_reference/`
(all but two small stand-in headers) are copied from Mixxx unchanged.

## Next steps

- Run it on a board: I2S timing, SD-card throughput with two decks, CPU load.
- A board with a USB host so the FLX4 plugs in directly (Zephyr's USB host
  support would need a MIDI class), or the STM32H747I-DISCO (USB host, 32 MiB
  SDRAM, SD slot, audio codec).
- MP3 decoding (for example minimp3) and keylock (SoundTouch).
- Receive updates into slot 1 over Wi-Fi from the AWS IoT console.
