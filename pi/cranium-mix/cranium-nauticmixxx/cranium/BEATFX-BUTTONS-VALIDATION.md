# FLX4 Beat FX buttons — 2026-11-16

The legacy FLX4 mapping selected a hidden focus slot (including invalid slot 0)
and left next_effect/prev_effect held high. The RX3 screen represents only slot 1
and filters its effect list separately from generic Mixxx effect cycling.

The native panel now supplies relative next/previous controls that use the same
eight supported manifests as the on-screen selector. Selection follows the
actual currently loaded effect, wraps, and never lands on an unsupported/empty
entry. Channel routing, wet level and latched activation are preserved. Selecting
a new effect cancels momentary X-PAD activation without latching it on.
ON/OFF toggles the displayed slot and its chain together. Empty slots cannot
be spuriously enabled. BEAT left/right step the current X-PAD timing/parameter
rather than selecting hidden slots. MIDI actions pulse and release each time.
The FLX4 LED reflects both slot and chain enabled state. Stock Mixxx retains
its generic multi-slot mapping and now properly releases selection triggers.

Validation: 211 targeted native tests passed, 10 optional fixture checks skipped.
Includes 27 Beat FX tests, actual Qt selector updates, cycling/wrapping through
all eight effects, touch-to-controller selection synchronization, actual effect
slot/chain activation and channel/wet preservation. JS tests cover repeated
press/release, native slot 1 regardless of focus, reverse selection, timing,
LEDs, fallback mapping, prior channel-selector and knob zoom. Pi installer and
profile-preservation tests pass. Linux staged-package checks pass. No physical
Pi/controller audio test is claimed; next deployment requires its SD card.

Native commit: 0351701. Replayable aggregate patch exported to
cranium/patches/0099-cranium-native.patch.

Color FX inspection: each FLX4 CFX knob is a 14-bit control for its own deck's
QuickEffectRack1 super1 (B6 17/37 for channel 1; B6 18/38 for channel 2). It is
independent of Effect Unit 1 and the Beat FX channel switch. The audible result
depends on that deck's loaded Quick Effect preset and enabled state. No Color FX
preset, profile or audio behavior was changed in this fix; a coherent on-screen
Color FX selection workflow still needs a separate design and physical test.
