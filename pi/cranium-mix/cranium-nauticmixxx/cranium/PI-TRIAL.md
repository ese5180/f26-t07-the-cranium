# CRANIUM 800×480 Pi build

This trial uses the 1280×800 reference layout with a persistent touch toolbar.
The built-in live widget scaler fits the native 800×480 screen and fills the
viewport; metrics/fonts use the limiting 0.60 factor and flexible widths fill
the remaining width. The middle pad-mode/Hot Cue strip is hidden; controller
pad functions remain available. SOURCE, BROWSE, TAG LIST, PLAYLIST, SEARCH,
MENU and INFO stay at the top. Tap an active navigation button again to return
to performance; a different navigation button switches sections. There is no
separate PERFORM button. Search's keyboard hides on return to performance.
Startup artwork is reduced to fit the display. Touch/text usability
and physical Pi audio still need testing.

This package also includes appliance startup revision 1: quieter boot, one USB
automounter, desktop keyboard only in Developer Mode, and a short low-priority
performance capture after login. Early boot can be black until graphics starts.
No measured speed/audio improvement is claimed before hardware testing. The
app, audio buffers, CPU governor, kernel and display overlays are preserved.

## First boot

Insert the safely ejected SD in the powered-off Pi, connect the display, FLX4
computer/data USB port and power. Allow several minutes and one automatic
reboot for the offline installation. Cranium is selected after a successful
install. Its separate profile is `~/.cranium-nauticmixxx`; working audio settings
are copied if available, and the FLX4 RX3 preset is selected for known FLX4 ports.

Normal startup shows the CRANIUM background and application without a desktop
bar. MENU opens embedded Controller, Audio and System settings. Desktop tools
are available through MENU → SYSTEM / DEVELOPER → DEVELOPER TOOLS; hold the
entry button for two seconds. Developer Mode resets on the next boot. Use
RETURN TO CRANIUM MODE to restore the normal interface. A USB keyboard recovery
shortcut, Ctrl+Alt+D, is retained. The original desktop config is saved as
`~/.config/sway/cranium-desktop.conf`; working BiteDJ and Mixxx apps remain
available for developer testing. Startup logs remain at
`~/.local/state/cranium/nauticmixxx.log` and installer results at `CNUPDATE/`.

## First checks

1. Confirm the entire performance view fits, with no desktop title bar.
2. Insert the music USB and open SOURCE/BROWSE. For the FLX4 preset, BROWSE press
   opens/enters, encoder turn selects, SHIFT+BROWSE goes BACK, SHIFT+LOAD1 opens
   SOURCE, and LOAD1/LOAD2 load the selected track into each deck.
3. Check playlist/key categories, SEARCH and its built-in keyboard. Tap SEARCH
   again to return to performance and hide the keyboard; verify BROWSE and
   SOURCE also open and close with the same button.
4. Check touch hit targets and text, each deck, audio/headphone cue, and playback
   before judging whether this simple scaled version is usable.

Dragging a track from the USB browser onto either deck now keeps the same
Rekordbox grid, key and saved cues as loading with the controller. A single
tap enters a playlist or playlist folder. The selected browser row has a
compact HOT CUES summary with exported A–H positions, including saved loops;
tracks with no exported Hot Cues are identified explicitly. The performance
key is labelled KEY in each deck's left information rail.

Pinch the large central performance waveforms to zoom: fingers apart zooms
in; fingers together zooms out, in any orientation. Zoom follows finger
separation continuously, so a longer pinch covers several levels without
lifting. Far-out levels use coarser 10/8/6 steps; close-up levels retain
single-step precision. Both decks follow together. Central touch/mouse drags cannot
move a playing track; one-finger scrubbing remains available while paused.
The small lower left/right overview waveforms remain clickable and draggable
during playback. This update unlocks their Needle Lock preference once and
backs up the previous profile; later manual preference changes are preserved.

If FLX4 audio or mapping is not selected, open Sound Hardware/Controllers in
Preferences and choose the FLX4 and `Pioneer DDJ-FLX4 - NauticMixxx RX3 browser`.

Use Developer Tools to access the desktop and trial apps. Normal boot always
opens CRANIUM; the old boot app-selector text file does not override kiosk mode.
To recover a text login, create an empty `cranium-console-enabled` file on the
boot volume, then boot with a keyboard. Startup backups and the exact restore
command are recorded in `CNUPDATE/install-result.json`.

This package preserves the Pi's native graphics/Wayland/C/C++ runtime; there
is no need to repeat the original BiteDJ library-move correction. No OS reflash
or internet connection is needed. Source remains editable in the CRANIUM
Mix monorepo on the Mac; putting the SD in the Mac does not update
it unless the package staging/install workflow is run.

## DDJ-FLX4 and audio setup

Tap MENU → CONTROLLER SETUP. The embedded page distinguishes USB hardware
visibility from MIDI detection and mapping activation. Detected FLX4 MIDI ports
use the Cranium mapping automatically. Enable/disable controls stay in the same
window; there are no desktop help links or native preference dialogs here.
If the USB status reports no FLX4, check the computer/phone USB-C port and a
known working A-to-C **data** cable. Power alone does not confirm USB data.

MENU → AUDIO OUTPUT SETUP selects devices and stereo channel pairs for master
and headphones. For FLX4 use master 1–2 and headphones 3–4. Save and refresh are
disabled during playback; failed setup attempts restore the previous routing.
Existing inputs and advanced outputs are preserved and overlapping routes are
rejected. Unavailable devices are reported on the page.

During installation, read-only USB/audio evidence is written to `CNUPDATE/diag.json`
so a later SD transfer can distinguish USB enumeration, MIDI exposure and device
permissions. This update does not establish the cause of a physical controller
connection failure or claim that an unknown cable carries data.

## Settings refinements

In normal performance mode, turn the FLX4's browse encoder clockwise to zoom
both central waveforms in one level per notch, or counterclockwise to zoom out.
Pressing it still opens the browser, and turning it inside the browser still
selects entries. INFO, shortcut and explicit grid-edit modes retain their
existing encoder actions. Pinch gestures remain available.

The FLX4 BEAT FX channel switch now assigns unit 1 exclusively to deck 1,
deck 2, or the master bus for 1&2. The CH SELECT readout shows 1, 2 or MASTER
from the real routing controls. Changing the switch preserves the chosen
effect, wet level and FX on/off state. The update refreshes both saved FLX4
scripts with backups so existing profiles receive the changes.

FX SELECT now advances through the eight Beat FX shown in the on-screen list;
SHIFT+FX SELECT moves backward, with wraparound. Every click is a new action,
and hardware follows the actual loaded effect even after a touchscreen choice.
ON/OFF operates that displayed effect and its processing chain. BEAT left/right
step its timing/parameter. The selected audio target and wet level are preserved
when changing effects. The physical CFX knobs remain separate per-deck Quick
Effect controls; their presets have not been changed by this update.

MENU → AUDIO OUTPUT SETUP now includes Play/Pause buttons for both loaded decks,
so audio can be tested without a controller. Select master/headphone routing,
save while stopped, then start a loaded deck. Stop it again before changing
routing. This does not change the performance page layout.

Refresh Devices runs an independent scan with a visible progress bar and a
finished, failed or timed-out message. You can navigate while it checks. Your
live output is not closed by Refresh. Save and Refresh remain disabled while
a track plays. Check Connection ends with a result after a short check.

SEARCH switches completely away from MENU to its track results and keyboard.
Native waveform and page backing is black during performance/browser changes.
