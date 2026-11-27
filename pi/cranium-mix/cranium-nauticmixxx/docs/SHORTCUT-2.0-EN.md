# NauticMixxx 2.0 SHORTCUT and deck selection

## Controller gestures

| Action | PERFORMANCE | BROWSE | SHORTCUT |
| --- | --- | --- | --- |
| Normal LOAD 1 / 2 | Select that deck only | Load the selected track normally | Loading is blocked |
| BROWSER short press | Open BROWSE; leave GRID if active | Enter the focused browser item | Enter/leave editing; activate focused LOAD, SAVE, UTILITY or CLOSE |
| BROWSER two-second hold | Toggle GRID | BACK | No action |
| SHIFT + BROWSER two-second hold | Open SHORTCUT | Open SHORTCUT | Close SHORTCUT |
| BROWSER turn | Normal browser navigation; move selected grid in GRID | Normal browser navigation | Move row focus or change the edited option |

Touch the deck's title above its overview or its information card on the right of the main waveform to select it. Other deck controls do not change the selected deck. MASTER remains independent.

SHORTCUT uses the BROWSE page as its base, hiding native performance waveform surfaces and retaining the compact BROWSE footer. The one-pixel white outline identifies the encoder row; blue (#007CE0) identifies the applied option. Changes apply immediately and persist. Turn BROWSER to move from UTILITY to CLOSE, then short-press BROWSER to return to the underlying page. Touch CLOSE and SHIFT + BROWSER hold also close SHORTCUT. Moving the encoder while holding it cancels the long-press gesture.

UTILITY opens the grouped settings and operations table without a USB device. In its menus,
turn past the last action to select BACK, then short-press BROWSER to return.
SOURCE displays USB devices only; the BROWSE header provides MENU
to open UTILITY for touch access.

## Settings

- TIME chooses elapsed or remaining time. AUTO CUE chooses first sound or track beginning on load. LOAD LOCK prevents replacing a playing deck.
- QUANTIZE BEAT VALUE selects 1/8, 1/4, 1/2 or 1 beat. HOT CUE AUTO LOAD selects ON, SETTING (the track's rekordbox auto-load flag), or OFF. OFF suppresses recall of existing cues; new manual cues stay usable.
- JOG RESPONSE adjusts scratch sensitivity and pitch bend in five levels. These affect scratch input and playing-deck nudging, respectively.
- PLAYBACK SETTINGS exposes master tempo and 6%, 10%, 16% or WIDE range separately for each deck.
- VINYL SPEED ADJUST enables gradual stopping with the controller's normal PLAY button; STOP TIME chooses one of five deceleration levels. Decks 3 and 4 retain their original transport behavior.
- WAVEFORM COLOR selects BLUE, RGB or 3BAND renderers. EQ/ISO changes the equalizer response while preserving knob positions. HEADPHONES selects stereo or mono split.
- CROSSFADER CURVE and CHANNEL FADER CURVE offer three responses. QUANTIZE (EFFECT) delays effect activation until the next routed deck beat. Scheduling uses the UI timer and is not sample-accurate; stopped or invalid beat sources activate immediately.
- NEEDLE LOCK blocks overview seeking while the deck plays. SLIP FLASHING controls eligible controller-button flashing, defaults to ON and persists locally.

## MY SETTINGS from a rekordbox USB

Select the connected USB in SOURCE. MY SETTINGS MENU opens its own right-side SOURCE panel with LOAD, BACKGROUND COLOR and WAVEFORM COLOR. SHORTCUT remains a separate screen and retains its LOAD/SAVE controls. Pause both decks, then touch LOAD or press the encoder on LOAD. The loader reads the standard files under `PIONEER`: `MYSETTING.DAT`, `MYSETTING2.DAT`, `DJMMYSETTING.DAT`, and `DEVSETTING.DAT` when present. It verifies headers, lengths, setting codes and CRC before applying anything. LOAD never writes to the USB. BACKGROUND COLOR stores a Nautic-specific accent in `PIONEER/NAUTIC_BACKGROUND_COLOR.json`; it does not alter Pioneer DAT or PDB files. The accent identifies the USB icon and browser device label. WAVEFORM COLOR selects BLUE/RGB/3BAND using the same renderer settings as SHORTCUT. See [SOURCE navigation](SOURCE-MY-SETTINGS-2.0-EN.md).

Supported exports include elapsed/remaining time, auto cue, quantize enable/value, hot-cue recall, needle lock, master tempo/range, waveform color/divisions, channel/crossfader curves, headphones and effect quantization. Hardware-only settings such as LCD brightness, LEDs, mixer attenuation, language and controller vinyl mode are reported as unsupported. EJECT/NEEDLE LOCK are not interpreted as LOAD LOCK. The panel's LOAD LOCK is a local NauticMixxx setting.

The result names applied and unsupported settings. Use DETAILS to read the complete result on a touch display. Missing, corrupt or unsupported files do not silently substitute a NauticMixxx profile for a rekordbox export. Local SHORTCUT choices are saved in the app profile, not on the device.

## Countdown and track time

Touch the top REMAIN rail to replace the main waveforms with the countdown editor. Select a PRESET or HISTORY duration, or enter up to six digits as HHMMSS (for example, 012000 sets 01:20:00). Hours are limited to 99 and minute/second fields to 59. The minute adjustment buttons replace the duration and stop the current countdown. START begins or resumes it; STOP pauses it, CLR clears it, and REMAIN returns to the waveform view. Closing the editor or opening BROWSE/SHORTCUT does not stop a running timer. Its white progress line shrinks from the right toward the left. The timer uses monotonic wall time independently of audio playback. The six most recently started durations and last chosen duration persist; a new application session starts with the saved duration stopped.

A short touch on an individual deck's time display toggles only that deck between TIME and REMAIN. Holding it for one second toggles only that deck's AUTO CUE without toggling TIME/REMAIN. These choices persist. SHORTCUT TIME and AUTO CUE change both decks at once. AUTO CUE affects where the next loaded track starts, so changing it does not seek a playing track.

In TIME, the played overview and its axis stay bright while the remaining side darkens. In REMAIN, the played side darkens and the remaining side stays bright. The complete horizontal playing-address bar alternates between its normal white/gray state and dark gray while the deck is playing near the end. The default warning begins below 30 seconds; below 15 seconds the blink rate doubles. The overview follows the local Waveform EndOfTrackWarningTime setting, including zero to disable it, without requiring new playposition events. Seeking updates both regions immediately.

## SLIP

SLIP is armed until toggled off or a track is loaded/ejected. While playing, Vinyl pause and scratching, loops, held Hot Cues and reverse keep an independent background playhead advancing at the deck's normal tempo. Releasing the action resumes at that position without switching SLIP off. Hot Cue returns on pad release or after four beats; reverse returns on release or after eight beats. The limits follow track beats and tempo, with cancellation in the next audio callback after the deadline. A normal pause outside Vinyl mode remains a pause.

The Hercules mode labelled SLIP LOOP now sends held loops instead of Slicer. Its eight durations are 1/16, 1/8, 1/4, 1/2, 1, 2, 1/3 and 3/4 beats. The on-screen pads use the same action. Releasing the pad (or leaving the page) returns to the background and restores the prior SLIP state; this works while SLIP is off. Overlapping Hercules pads return to the previously held duration until the last pad is released.

An active action flashes the SLIP button, uses a yellow audible cursor and shows the advancing white background cursor in the overview. The deck badge displays SLIP. SLIP FLASHING controls the Hercules PLAY and assigned Hot Cue warning lamps while armed; empty slots retain their neutral color. Turning that option off does not suppress the active SLIP-button indication. Controller LED behavior still requires verification on the physical unit.

## Test candidate

Use the separate test app and its bundled test profile. Validate SHIFT + BROWSER input, LOAD behavior, scratch/nudge response, headphone routing and fader curves on the intended hardware before using v2.0 in a live set.
