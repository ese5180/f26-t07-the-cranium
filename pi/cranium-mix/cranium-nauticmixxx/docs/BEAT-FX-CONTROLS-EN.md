# Beat FX controls — NauticMixxx 2.0 development

These controls use the eight available Mixxx performance effects. RX3-specific
Spiral, Helix, Roll, Slip Roll and the complete Sound Color FX catalog remain
outside this correction.

## Touch controls

- Tap an occupied bank to recall and activate its effect.
- Hold a bank for 650 ms to replace its registration. Releasing the long press
  does not recall the previous effect. Registering the current effect preserves
  its parameters and activation.
- Press and move the X-PAD to apply its parameter; release to end the momentary
  effect. Changing effects or hiding the performance panel releases a held pad.
- FILTER starts with its low-pass and high-pass open. REVERB uses decay on the
  X-PAD and starts with its signal send enabled.
- ECHO, PHASER and TREMOLO support exact X-PAD beat fractions, including 1/16,
  3/4 and 4. Exact timing overrides the processor's legacy rounding/triplet
  switches for those cells. ECHO supports up to six seconds, including four
  beats at 40 BPM; cells exceeding the buffer are unavailable.

## Encoder controls

Open SHORTCUT → TOOLS → BEAT FX with the existing browser controls.
TOOLS is available even without a connected USB. On Inpulse 500, hold
SHIFT + BROWSER for two seconds to open SHORTCUT, turn to TOOLS and
short-press BROWSER; select BEAT FX the same way. The BROWSE header also
provides MENU to open TOOLS. SOURCE lists music devices only.
Turn to select a row, press to edit, turn to change, and press again to finish.
BACK finishes editing before returning one menu level. Outside editing,
turn past the final action to highlight the BACK button and short-press
BROWSER to return. Existing back gestures remain available.

- EFFECT selects a processor with activation off when changing processors.
- ON / OFF controls activation. LEVEL / DEPTH adjusts the unit mix separately
  from the X-PAD parameter.
- BPM MODE selects AUTO or MANUAL / TAP. MANUAL BPM covers 40–300 BPM; TAP BPM
  accepts two consecutive presses 200–1500 ms apart.
- CH SELECT chooses MASTER, DECK 1, DECK 2, MIC 1, MIC 2 or AUX. Audible external
  sources require configured inputs on the audio interface.
- Press X-PAD to hold, turn to move its position, and press or BACK to release.
  Each encoder tick selects the next available beat/pitch cell; continuous
  effects move in 2.5% steps. The row shows the actual parameter value. Closing
  the menu releases it too.
- BANK recalls a registered effect. STORE SELECTED EFFECT replaces that bank;
  CLEAR removes its registration. Empty banks explain the STORE action.

AUTO uses the routed deck's tempo, or the displayed master deck for master
processing. MANUAL supplies its tempo and phase to Beat FX unit 1's audio
processor. MIC/AUX sources without beat metadata use the displayed AUTO
tempo with a running phase clock. No established Inpulse 500 gesture is reassigned.

## Common mapping controls

All are in `[RX3BeatFx]`: `select` (1-based curated manifest order),
`bank_recall`, `bank_store`, `bank_clear` (1–4 commands), `amount` (0–1),
`xpad_position` (0–1), `xpad_hold` (0/1), `bpm_mode` (0=AUTO, 1=MANUAL),
`bpm_manual` (40–300), and the displayed `bpm`. Pulse selection/bank commands
back to zero before issuing the same command again. Availability depends on
loading the RX3 skin; future adapters can use these controls without adding
another hardware-specific effect engine.

The delivered `2.0.0-source-settings-2` candidate includes the preceding Beat FX
corrections, SOURCE navigation, dedicated MY SETTINGS and encoder-selectable BACK.
Automated DSP checks do not certify physical controller feel or calibration
against an RX3.
