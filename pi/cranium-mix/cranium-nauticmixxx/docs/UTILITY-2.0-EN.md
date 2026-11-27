# UTILITY — NauticMixxx 2.0 development

UTILITY is the shared settings and operation menu. Press MENU in SOURCE/BROWSE
to open it; holding MENU also opens it and releasing does not reopen anything.
Press MENU in the main table to close it and restore the previous browser view.
Inside an operation panel, MENU returns to the main UTILITY table. PERFORMANCE
retains its countdown/progress rail without navigation buttons.

The previous controller TOOLS gesture and `[RX3Browser],tools` command now open
UTILITY directly. SHORTCUT's button is labeled UTILITY. Existing controller
bindings are unchanged. The common `utility`, `move`, `enter` and `back`
controls work across compatible controllers. A USB is required only for
operations that use its catalog or storage.

## Groups and operations

| Group | Contents |
| --- | --- |
| DECK | Load/needle locks, quantize, hot-cue auto load, Auto Cue level, Slip flashing, play mode; playback options, memory cues/loops for each deck, SHORTCUT/My Settings |
| MIXER | EQ/isolator, channel fader curve, headphone split/stereo; actual master/headphone/booth levels, microphone EQ/low-cut/talkover, AUX and external deck input controls |
| EFFECTS | Existing Beat FX selection, level/depth, routing, BPM, X-PAD and four banks |
| BROWSER | Tag List/tag track, Playlist Bank, Track Filter, Related Key and selected-track headphone preview |
| RECORDING | Guarded USB recording start/stop/split, elapsed time and storage status |
| DISPLAY | Waveform position LEFT/CENTER and divisions TIME SCALE/PHRASE |
| GENERAL | Installed interface languages and application version |

The two-column table uses BROWSER's black/#262626 alternating rows, bold
category headers and a continuous #777777 column divider. Blue marks selection.
Current values appear on the right; OPEN › identifies an operation panel.
Categories are not selectable options. BACK remains encoder-selectable after
the final option. Returning from an operation preserves its selected table row
and USB/track/playlist context.

## Editing and return behavior

Turn to select, press to choose a setting, turn to preview and press again to
apply. BACK while editing cancels without changing the owner. BACK outside
editing closes the table. Touch a setting and choose a value to apply.
Arrow/Enter/Escape keys use the same table navigation contract.

Operation panels retain their established turn/press/hold controls. Audio and
Beat FX adjustments act live while turning, then press ends editing; BACK
ends editing before returning to UTILITY. X-PAD ownership is released when
leaving or hiding its panel. Track/catalog actions use the USB and selection
captured when UTILITY opens. A missing source or audio path gives an explicit
message rather than applying an unavailable operation.

Values refresh from actual setting owners. Different deck values or custom
controls show MIXED / CUSTOM. Supported settings share SHORTCUT's apply path
and persistence. They do not write USB settings automatically; use explicit
MY SETTINGS SAVE. SOURCE → MY SETTINGS MENU remains a separate USB panel.
LANGUAGE requires restart; all new profiles still default to English.

## Software scope

Hardware-only and unimplemented RX3 placeholder rows have been removed:
LCD/jog brightness, touch calibration, jog image, automatic standby, screen
saver, standalone mixer mode, independent output attenuators and microphone
routing switches, hot-cue color and On Air display switches. These capabilities
are not claimed to be implemented. Supported software controls remain visible;
if the active skin lacks an owner, the setting reports UNAVAILABLE.

PLAY MODE currently supports CONTINUE/SINGLE. TOUCH/RELEASE mode selection,
REPEAT/ALL REPEAT, independent microphone output routing, Link Export and
complete RX3 Beat/Sound Color FX catalogs retain their previously documented
limits. Existing vinyl stop-time and jog controls remain in SHORTCUT.
PHRASE divisions without imported phrase data fall back to time-scale marks.

These changes are included in the delivered 2.0.0-utility-2 macOS test candidate.
Close the previous app and double-click ABRIR-PRUEBA.command in that candidate
folder. It uses a separate English profile. Native tests and Qt renders do not
replace physical controller/audio checks.
