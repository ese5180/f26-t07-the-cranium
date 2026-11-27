# Beat FX / Bank / X-PAD audit — 2026-10-10

## Correction status

The findings below describe the pre-fix source and workflows-1 application.
The requested repairs are now implemented in development source and native
patch 0038: safe FILTER load, audible REVERB send/decay, exact ECHO/TREMOLO
fractions, held bank replacement and shared encoder controls. Audio checks also
caught and corrected effect activation not reaching the engine, ECHO's delayed
read-head advancement and a dry-signal buffer-bound error. Master/Manual/AUTO
source timing now feeds the audio processor. SOURCE → TOOLS → BEAT FX provides
controller access without introducing new gestures.

Final validation passed 145 of 149 native checks, with four optional external
checks skipped, including all 26 effect/encoder checks; 14 controller suites,
the Windows installer contract and public-source audit passed. See
[validation](../TEST_REPORT.md) and [controls](BEAT-FX-CONTROLS-EN.md). The user-authorized
`2.0.0-beat-fx-fixes-1` macOS candidate includes the repairs; the older
workflows-1 app remains unchanged.

## Scope and evidence

The user reported Filter muting on bank recall, unavailable Echo/Tremolo beat
cells, inaudible Reverb and inability to replace occupied bank registrations.
The screenshots show Filter's continuous rail and Echo's dimmed 1/16 and 4 cells.
This audit traces current native source, built-in manifests/DSP, controller
bindings and the isolated test candidate profile. It does not change the running
application or certify RX3 acoustic equivalence.

The existing native `Rx3BeatFxTest.*` run passed **16/16** checks. Evidence:
`build/test-candidate/macos/validation/beat-fx-audit-2026-10-10/`.
These checks exercise widgets, parameters, labels, persistence and cancellation;
they do not render audio through the effect signal path. A passing test therefore
does not establish that an effect is audible or beat timing matches the DSP.

The complete fourteen Beat FX and six Sound Color FX remain deferred by the
user. Repairs to the existing eight processors are separate from that expansion.

## 1. Filter recall can attenuate almost all audible content — high priority

`WRx3BeatFx::useBank()` loads the saved effect with defaults and immediately
enables both its slot and Effect Unit 1. `EffectSlot::loadEffectInner()` retains
and forcibly applies the previous metaknob when AdoptMetaknobValue is enabled.
That setting is enabled in the RX3 profile.

At meta = 0, Filter's LinkedLeft LPF becomes 13 Hz, despite the manifest's dry
LPF default of 22050 Hz. Its HPF stays at 13 Hz. The resulting low-pass is almost
inaudible for ordinary music. The X-PAD writes LPF directly; it does not change
the meta value. Moving the pad can reopen the cutoff. Releasing it disables the
whole unit, restoring dry audio. Loading another processor and recalling Filter
again reapplies the retained meta and can close the cutoff again. This source
path explains the reported sequence without stopping deck transport.

A retained meta above the midpoint can also leave a high HPF while the pad moves
only LPF, creating conflicting passbands. Simply fixing the displayed LPF value
or globally disabling metaknob adoption is insufficient. The latter would also
change established controller/Color FX behavior.

Sources: `dev/src/widget/wrx3beatfx.h:347`,
`dev/src/effects/effectslot.cpp:364`,
`dev/src/effects/effectknobparameterslot.cpp:153`,
`dev/src/effects/backends/builtin/filtereffect.cpp:35`.

## 2. Reverb activation does not establish an audible send — high priority

The contextual pad binds `bandwidth`, the input low-pass parameter. Reverb's
`send_amount` defaults to zero and is linked to the metaknob. With a retained
zero metaknob, pressing/sliding the pad changes bandwidth and enabled flags,
but still feeds no signal into the reverb. This is an identified failure path;
this audit did not capture the user's exact audio buffer at the moment of failure.

Reverb needs an explicit send/intensity policy and a meaningful contextual
parameter. Decay, bandwidth, damping, send and chain mix should have deliberate,
visible roles. A lit activation state alone is not proof of processing.

Sources: `dev/src/widget/wrx3beatfx.h:379`,
`dev/src/effects/backends/builtin/reverbeffect.cpp:55`.

## 3. Echo cells are explicitly disabled by present DSP constraints

The pad draws eight fixed labels. Echo's manifest permits delay_time = 0..2;
the DSP enforces a minimum of 1/8 beat and normally rounds to quarter beats.
The widget therefore disables 1/16 and 4. The dimming is intentional in current
code, rather than a broken click target.

Enabling 1/16 and 4 in the widget alone would misrepresent processing. Supporting
them requires changing the delay contract, rounding and effective ranges, and
verifying the delay buffer capacity. The existing buffer is three seconds: four
beats already require four seconds at 60 BPM. Echo's send is also meta-linked
and can inherit zero just like Reverb.

Sources: `dev/src/widget/wrx3beatfx.h:451`,
`dev/src/effects/backends/builtin/echoeffect.cpp:44`,
`dev/src/effects/backends/builtin/echoeffect.cpp:134`,
`dev/src/effects/backends/builtin/echoeffect.h:14`.

## 4. Tremolo has rate limits plus an independent depth problem

Tremolo stores cycles per beat, so a 1/16-beat period requires rate = 16.
Its manifest permits only 0.25..8, explaining the disabled 1/16 cell. The 3/4
cell needs rate = 4/3, while the default quantization reduces rates to powers
of two; the widget explicitly rejects this cell when that setting is on.

The pad changes rate, while depth is meta-linked and can become zero. The
inspected candidate's saved Tremolo state has meta = 0 and depth = 0. Its gain
formula at depth zero is constant unity: changing rate cannot make it audible.
Flanger has a similar risk because its internal mix parameter is meta-linked.
Phaser also has linked depth, though its minimum depth is 0.5 rather than zero.
Pitch Shift already initializes a zero range on pad touch, which illustrates
that per-effect preparation is necessary and currently inconsistent.

Sources: `dev/src/widget/wrx3beatfx.h:470`,
`dev/src/effects/backends/builtin/tremoloeffect.cpp:25`,
`dev/src/effects/backends/builtin/tremoloeffect.cpp:152`,
`dev/src/effects/backends/builtin/flangereffect.cpp:85`.

## 5. Occupied slots have no direct edit operation

A short press on a supported occupied slot recalls and enables it. Only empty
or unsupported slots open the chooser. There is no long-press edit, context
menu or shared controller command to replace an occupied registration directly.

The existing reassignment path is: press the delete icon, press the occupied
slot, press the now-empty slot, choose the replacement. This clears the saved
registration without unloading the playing processor. The upper-right selector
can change the loaded processor, but does not update any bank registration.
Selection, registration, activation and replacement need separate operations and
clear feedback. A direct edit must not trigger a second recall on release.

Sources: `dev/src/widget/wrx3beatfx.h:316`,
`dev/src/widget/wrx3beatfx.h:347`,
`dev/src/widget/weffectselector.cpp:92`.

## Additional integration gaps

- **Tempo in the audio engine:** the readout uses RX3Display/master_bpm, but
  EngineMixer::applyMainEffects supplies only gain in GroupFeatureState. For
  MASTER-routed effects, Echo can interpret the value as seconds, and Tremolo
  as Hz, while the display reports beats and tempo-derived milliseconds. Deck
  routing supplies deck features and does not necessarily have this mismatch.
  The candidate profile routes Unit 1 to Channel 1; this additional defect is
  conditional on MASTER routing, not asserted as the cause of the screenshots.
- **Other displayed fractions:** Phaser rounds periods to half beats. A 3/4
  target is enabled by the widget but can process as one beat. Triplet states
  change effective timing without changing the cell labels. UI capability and
  readout calculations should use the same effective-time contract as DSP.
- **Complete controls:** the current sidebar exposes an effect selector and a
  MASTER routing toggle, not the complete CH SELECT, ON/OFF, LEVEL/DEPTH,
  TIME, BEAT and BPM AUTO/TAP/MANUAL operations. Existing native routing controls
  are available beneath it, but their RX3/common-menu presentation is incomplete.
- **Two quantization settings:** SHORTCUT QUANTIZE (EFFECT) schedules activation;
  each processor's quantize/triplet parameters alter its time/rate. They are
  different settings and currently lack a complete common operation/display.
- **Controller operation:** the native bank/pad does not expose a complete
  shared select/register/edit/press/move/release contract. TOOLS has no Beat FX
  submenu. The Inpulse 500 COLOR knob retains its existing Color FX ownership
  and otherwise may write the unit superknob; it does not directly implement
  this contextual X-PAD workflow. Its legacy effect-state check reads slot
  enabled flags, while releasing X-PAD disables the unit but leaves the slot
  enabled. This can produce state disagreement and must be handled without
  disrupting the user's working gestures.
- **Effect identity and calibration:** these eight Mixxx processors remain
  software alternatives. Static LPF Filter is not the RX3's beat-modulated
  Filter, and Tremolo is not automatically an equivalent TRANS processor.
  Tail handling after release, reset on activation, waveform/depth and timing
  require signal tests and eventual RX3 comparison. Four bank slots are
  favorites for one selected processor, not four simultaneous processors.

Sources: `dev/src/engine/enginemixer.cpp:837`,
`dev/src/widget/wrx3beatfx.h:490`,
`dev/src/effects/backends/builtin/phasereffect.cpp:137`,
`dev/src/effects/rx3effectquantize.h:12`,
`dev/nautic/skins/XDJ_RX3_Mixxx/beffect.xml:14`,
`dev/nautic/controllers/Hercules_DJControl_Inpulse_500_RX3/Hercules-DJControl-Inpulse-500-RX3-script.js:1428`
and `:2035`.

## Recommended implementation order and acceptance checks

1. Introduce one native Beat FX state/control layer with independent selection,
   registration, activation, amount and contextual pad position. Ensure safe,
   effect-specific initialization, leaving other skins and Color FX unaffected.
2. Correct Filter initialization and conflicting passbands; give Reverb/Echo an
   audible controlled send and Tremolo/Flanger a controlled depth/mix. Test each
   switch sequence with retained meta values 0, 0.5 and 1, as well as custom presets.
3. Share effective beat/time calculations between DSP and UI; supply actual
   tempo/phase for MASTER routing. Test Echo impulse spacing and Tremolo envelope
   periods at multiple BPMs, sample rates, routes and quantization/triplet states.
4. Add visible ON/OFF, intensity, time/beat and route operations plus direct bank
   replacement. Verify cancellation, persistence and no accidental activation.
5. Add a common Beat FX menu/encoder contract for current/future controllers.
   Provide dedicated shortcuts where natural; preserve ordinary Inpulse 500
   performance and Color gestures. Check long-press release consumption and
   captured press-time ownership.
6. Add rendered-audio regression tests, not only widget assertions. Verify Filter
   dry return/no unintended silence, Reverb wet energy/tail, Echo delay/send,
   Tremolo modulation/depth, smooth switching, cancel/hide and missing tempo.
   Extending Echo/Tremolo ranges needs DSP and buffer validation before enabling
   new cells; do not silently map unsupported fractions to different timings.

The fourteen-Beat-FX/six-Color-FX expansion stays deferred. This audit does not
change its priority or represent pending proprietary effects with renamed
Mixxx processors. No new application candidate was generated.

## Product reference

The official product page describes four favorite-bank registrations, X-PAD
control, fourteen Beat FX and six Sound Color FX:
https://www.pioneerdj.com/en/product/all-in-one-dj-systems/xdj-rx3/
