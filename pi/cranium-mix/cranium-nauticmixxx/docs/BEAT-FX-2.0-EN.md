# Beat FX Bank and X-PAD

In PERFORMANCE, touch BEAT FX to replace the pad-status strip with the Bank and
X-PAD. STATUS restores the pad strip. Changing this view alone neither starts
nor stops an effect; the upper-right effect selector, channel routing and BPM
remain available.

## Four favorites

Touch any empty Bank slot to open its own effect chooser, including when another
favorite or processor is already selected. Choose Echo, Reverb, Flanger, Phaser,
Filter, Pitch Shift, Tremolo or Glitch; only installed members of this performance
subset appear. FX names are uppercase in the Bank, its chooser and the upper-right
RX3 selector, with slightly larger fonts. The upper-right RX3 selector uses the same list. Other skins keep
their normal effect lists. Utility/EQ processors such as Loudness Contour are
excluded; this list uses the real Mixxx processor names.

The registration stores its stable backend/effect identifier in the profile and
is saved immediately. Cancelling keeps the slot unchanged. Choosing a different
processor loads it disabled; registering the currently selected processor preserves
its parameters and activation. Touch an occupied slot to recall and enable that
effect. Touch the delete icon, then the chosen slot, to clear a registration.
The current FX remains visually selected even when activation is off. Releasing
the X-PAD changes activation only; the selection changes with the loaded processor.
Selected Bank slots and beat/pitch cells have a one-pixel white outline.
Beat/pitch cells and their enclosing border remain neutral gray/white while pressed;
cyan touch feedback is reserved for the continuous rail.
Deleting does not unload or stop the current effect. Empty slots show a black, blank rectangle that still opens the chooser on touch.
An old utility favorite also shows a blank rectangle; touching it opens the
curated chooser to repair just that slot. Its saved identifier stays intact until an explicit selection or deletion.
A favorite whose processor is unavailable remains registered until explicitly deleted.

## Right-hand panel

The supplied reference is normalized to the existing 184-pixel sidebar width.
The BEAT FX title spans the entire gray bezel; effect, MASTER and readout fields
share uniform ten-pixel side insets. Effect names are centered and uppercase.
MASTER uses cyan only when its actual routing control is selected. Fixed BPM,
millisecond, beat and QUANTIZE rows avoid vertical drift as values change; msec
and BEAT suffixes are smaller than their values. STATUS/BEAT FX uses a thin outer
frame and an explicit selected-state style. The panel retains the real processor,
route, BPM and time values rather than copying sample values from the reference.

## X-PAD

The X-PAD changes presentation with the selected processor:

- Beat-time parameters show eight cells: 1/16, 1/8, 1/4, 1/2, 3/4, 1, 2 and 4.
  Touching or sliding across cells sets that exact supported processor value.
  Values outside the processor's effective range are dimmed and cannot activate
  or change the effect. Echo currently supports 1/8 through 2 beats; its 1/16 and
  4 cells are unavailable. Native triplet/quantization switches remain in effect.
- Reverb, Flanger and other continuous controls use a tapered rail and open end
  arrows. Gray/cyan ends fade to darker gray in the center. Holding it illuminates the
  rail, arrows and subtle end glow in cyan; release restores gray.
- Pitch Shift shows negative/positive semitone cells (-12, -7, -5, 0, +5, +7, +12).
  Targets account for the native range knob. A zero range becomes one octave
  only when a pitch cell is touched; simply selecting or displaying the effect
  leaves its parameters unchanged.
- With no selected effect the neutral gray rail remains visible and disabled. Its parent page hides it
  in STATUS, BROWSE, SOURCE and full-page overlays.

The same momentary highlight follows mouse and touch. Switching processors
while holding the pad cancels that touch before binding the new parameter.

Touch or click and hold the horizontal pad to enable the selected Beat FX.
Slide horizontally to adjust its contextual parameter, and release to turn the
unit off, including when it was already on before the touch. A cancelled touch,
lost mouse grab or hiding a held pad also ends its momentary activation.

The Bank and X-PAD address Effect Unit 1, Effect 1, matching the upper-right
selector. They do not write deck transport, beat loops, QuickEffect controls
(Sound Color FX) or another effect unit. Existing engine activation quantization
continues to honor SHORTCUT QUANTIZE (EFFECT) and the routed playing deck.

| Available processor | X-PAD parameter | Presentation |
| --- | --- | --- |
| Echo | Delay time | Beat cells |
| Reverb | Bandwidth (its input low-pass control) | Continuous gradient |
| Phaser | LFO period | Beat cells |
| Flanger | LFO speed/period | Continuous gradient |
| Filter | Low-pass cutoff | Continuous gradient |
| Pitch Shift | Pitch | Semitone cells |
| Tremolo | Cycle rate | Beat cells |
| Glitch | Delay time | Beat cells |

The right-hand time/parameter readout follows the actual selected control.
Beat-based times use BPM and the built-in processor's rounding/triplet behavior
(including reciprocal Tremolo rate); without detected tempo they show seconds;
non-time parameters display their name and value instead of a fabricated delay.
Controller edits to the parameter are reflected in the X-PAD.

## Implementation scope and references

This implements the Bank/X-PAD workflow with the processors already supplied by
NauticMixxx/Mixxx. It does not add or claim all 14 proprietary RX3 processors.
For example, the existing Mixxx Filter exposes a cutoff control, not an RX3
Filter LFO. Missing RX3 algorithms such as Spiral or Helix are not represented
by placeholder names.

The four-favorite Bank and horizontal X-PAD workflow are described on the
[official XDJ-RX3 product page](https://www.pioneerdj.com/en/product/all-in-one-dj-systems/xdj-rx3/).
Momentary touch behavior and effect-specific control guidance also follow the
RX3 reference supplied by the user on October 9, 2026. Native automated checks
cover registration/persistence, deletion, contextual processor parameters,
mouse/touch sliding and cancellation, readouts, unchanged loops/QuickEffects,
and effect-state preservation across STATUS/BEAT FX transitions.
