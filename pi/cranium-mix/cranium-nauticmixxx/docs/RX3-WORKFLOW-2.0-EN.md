# RX3 workflow implementation in NauticMixxx 2.0.0

This document describes the RX3 workflows included in the public 2.0.0 release.
UTILITY integrates the former TOOLS operations; see the [UTILITY guide](UTILITY-2.0-EN.md).
The user's working Hercules Inpulse 500 gestures are the baseline. The complete
14 Beat FX and six Sound Color FX remain explicitly deferred. Release FX are a
separate performance-pad feature included in this work.

## Shared operation without a mouse

Existing controller adapters retain their encoder, LOAD, VIEW and SHIFT gestures.
Hold SHIFT + BROWSER to open SHORTCUT, select TOOLS and press the encoder. In
TOOLS, turn to select an action, press to open a submenu or edit a value, turn to
adjust it and press to finish. BACK first leaves editing, then leaves the submenu.
The same native `[RX3Browser]` move/enter/back/tools controls serve every adapter.
Touch and mouse access remain available.

TOOLS provides Tag List, Playlist Bank, Track Filter, Related Key, playback
options, memory cues/loops for each deck, headphone preview, USB recording,
software mixer controls and MY SETTINGS. It retains the selected track or
playlist when opening a submenu. The four playlist-bank slots are assigned from
a selected playlist in the PLAYLIST hierarchy. OPEN recalls its ordered tracks;
a missing or changed playlist is reported instead of loading another list.

Future controller profiles must implement this common encoder contract before
adding dedicated shortcuts. A hardware knob can provide faster access to a
function, but is not a prerequisite for its native menu. A controller with no
suitable encoder needs an explicit alternate navigation design. Native tools
do not make the FLX6 browser-only preset a complete deck/mixer mapping.

Press-time state owns a held action: its deck, pad and SHIFT variant stay fixed
until release. Changing SHIFT must not send release to a different control.
Long presses consume their following release. A new shortcut must preserve the
normal performance gesture and provide visible state or feedback. Avoid nested
SHIFT combinations and gestures that interrupt ordinary transport or mixing.

## Performance pads and memory

| Mode | Native behavior |
| --- | --- |
| HOT CUE | Existing eight cues and saved hot loops |
| GATE CUE | Paused: hold to preview, release to return; PLAY commits playback. Playing: jump and continue after release |
| BEAT LOOP | 1/4, 1/2, 1, 2, 4, 8, 16, 32 beats |
| BEAT LOOP 2 | 3/4, 1, 3/2, 3, 5, 6, 7, 9 beats |
| SLIP LOOP | Existing held loop with background playhead |
| RELEASE FX | Per-deck hold, SHIFT latch, feedback and explicit cancellation |
| BEAT JUMP / LOOP MOVE | Existing signed jumps and loop movement |

Release FX expose `rx3_release_fx_1` through `_8`, their `_latch` variants,
`rx3_release_fx_active` and `rx3_release_fx_cancel`. They do not replace a Beat FX
or QuickEffect. The current software processing implements short/long braking
and backspin, loop-based Echo Out and Build Up, smoothed Mute and beat-shaped
Ducking. Short and long rate envelopes currently span one and four beats;
these and the audible processing still require calibration against RX3 hardware.
Echo Out currently repeats/fades a beat loop rather than modeling the RX3's
internal echo processor. Do not describe these algorithms as measured hardware
equivalents.

Memory Cues and Memory Loops are retained separately from the main cue and the
eight hot-cue slots. TOOLS exposes previous/next, store, delete and Active Loop.
Store accepts up to ten memories and avoids duplicates. One Active Loop per
track is armed when playback crosses its start in the forward direction. Seek
back before the loop to arm it again. Scratch, reverse and SLIP background motion
do not trigger it. Native controls are `rx3_memory_prev`, `_next`, `_store`,
`_delete`, `_active`, `_count` and `_index` on each `[ChannelN]`.

## Preview and track selection

Holding/dragging the browser PREVIEW waveform loads only PreviewDeck1, seeks to
the selected fraction and sends it to PFL with main-mix routing disabled.
Release, cancellation or a superseded asynchronous load cannot start a late
preview. TOOLS supplies PLAY, POSITION and STOP for encoder operation; leaving
that preview submenu stops it.

Tag List preserves selection order, avoids duplicate IDs and holds up to 100
tracks per connected USB session. Its playlist-save action appends a new native
DeviceSQL playlist. Reconnecting a different session does not reuse temporary
tags. Track Filter combines BPM tolerance, compatible/exact key, minimum rating
and color. Related Key uses the same exported metadata to select compatible
tracks. Missing required metadata rejects a candidate.

**MATCHING is still incomplete.** The existing ±6% BPM/compatible-key rule is a
NauticMixxx related-track heuristic. It does not read rekordbox's registered
matching pairs. A verified exported-pair format and fixture are still needed.

## USB writes

Explicit SAVE snapshots the loaded track's own source, even if the browser has
selected another USB. The dedicated ANLZ writer updates Hot Cues, Memory
Cues/Loops, Active Loop flags and beatgrids. It preserves unknown section bytes,
source association and supported extended PQT2 references. It refuses changed
fingerprints, unsupported references, cross-session IDs and escaping paths.
Unedited decoder-clamped cues and unedited grids retain their exported timing;
SAVE alone must not move cues or truncate boundary beats.

Playlist creation and session history use bounded DeviceSQL append operations.
History marks tracks after the existing played-track threshold and appends new
entries to the same session history instead of rebuilding earlier entries.
Existing track rows remain unchanged. USB writers retain named recovery copies,
use locks and atomic per-file replacement, and refresh the active session after
successful writes. Multi-file ANLZ/settings commits are not a filesystem-wide
transaction; physical interruption can require recovery from those copies.

MY SETTINGS LOAD validates all available settings files before applying any
values and requires both decks paused. SAVE rewrites supported fields in existing
rekordbox files, preserving unsupported fields and checksums. Missing settings
files must first be exported by rekordbox. SAVE runs on a worker, checks the
volume identity before each commit and refuses symbolic-link destinations.
A recovery rollback is attempted only on the same volume and the exact revision
written by this operation. Deck defaults on the device use DECK 1 values.

Auto Cue reads -36 through -78 dB or MEMORY. USB source opening scans for the
first qualifying sample within a one-second work budget. Very long silent
intros can exhaust that budget and use the existing cue/start fallback. SINGLE
is the default playback mode; CONTINUE advances the originating exported track
list independently for each deck and respects Auto Cue. Raw USB-folder lists do
not yet have the same continuation support. EJECT LOCK protects a playing deck;
UNLOCK permits the explicit eject operation.

## Recording and audio hardware

USB RECORDING selects the writable source's `PIONEER/REC` folder, requests WAV,
uses automatic 4 GB splits, offers a manual split, displays duration/free space
and opens the resulting folder. Start requires more than 1 GiB free, matching
the recorder's reserve. Removal or reserve exhaustion stops recording. macOS
checks the actual mounted filesystem with `statfs`; Windows/Linux use Qt storage
inspection. START, STOP and SPLIT have separate guarded native controls and
cannot accidentally toggle a stopped recorder back on.

Software controls include configured MIC 1/2 levels and activation, two-band
EQ (-12 to +12 dB) per microphone, an optional 80 Hz low-cut, ducking,
external deck inputs, AUX, MASTER, headphone mix/level/split and BOOTH gain.
Unavailable input/output routes are identified in the menu. Sound Hardware
routing must first be configured and saved for the actual interface. The
Inpulse 500's microphone/AUX hardware path and any USB capture switching still
require physical validation; direct hardware audio is not automatically part of
the software recording. A software menu cannot create a second microphone or
independent BOOTH output on an interface that lacks them. Microphone EQ uses
allocation-free software shelving curves with smoothed parameter changes, not a
measured analog RX3 model. MY SETTINGS loads MIC LOW CUT on both microphones;
SAVE uses MIC 1 for that shared device setting and preserves unsupported mixer
settings. RX3 NORMAL talkover offers a -10 dBFS detector and -24/-18/-12/-6 dB
attenuation. It detects either channel and polarity without stereo cancellation;
software attack/release still need RX3 calibration. The existing custom ducking
profile remains available. Advanced frequency-selective talkover is unfinished.

## Remaining integration and validation

- Link Export remains in the requested scope but is not implemented. USB Link
  Export uses a device/driver transport that the Inpulse 500 does not supply.
  Both same-computer and separate-computer rekordbox operation are required.
  Preparing on one computer and playing on another must also work offline with
  the USB export, without running rekordbox on the performance computer. See
  [the transport design](LINK-EXPORT-TRANSPORT-2.0-EN.md) for the remaining online
  integration. Importing an XML/PDB copy is not
  evidence of a working Link Export connection.
- Exported MATCHING pairs, advanced talkover processing and audio-routing
  setup through the encoder remain unfinished.
- Physical pad/LED/audio calibration, alternate controller performance-mode
  bridges, recorder interruption/recovery, rekordbox cue/grid/history/playlist
  round-trips are pending. Native MSVC compilation and Windows installer validation passed in the 2.0.0 publication CI.
- Tests against a real USB export read the original; writer tests use isolated
  copies. Software checks validate the macOS/Windows packages; they do not certify
  hardware RX3 equivalence.

## References

- [RX3 product and controls](https://www.pioneerdj.com/en/product/all-in-one-dj-systems/xdj-rx3/).
- [RX3 official rekordbox control diagram](https://downloads.support.alphatheta.com/software_info/all-in-one-dj-systems/XDJ-RX3/XDJ-RX3_HardwareDiagram_rekordbox_E1.pdf).
- [DeviceSQL format research](https://github.com/fragmede/rekordbox-pdb/blob/main/FORMAT.md).
- [ANLZ schema](https://github.com/Deep-Symmetry/crate-digger/blob/main/src/main/kaitai/rekordbox_anlz.ksy).
- [MY SETTINGS schema](https://github.com/dylanljones/pyrekordbox/blob/master/pyrekordbox/mysettings/structs.py).
- [Hercules Inpulse 500 manual](https://ts.hercules.com/download/sound/manuals/DJC_Inpulse500/DJControl_Inpulse_500_User_Manual_EN.pdf).
