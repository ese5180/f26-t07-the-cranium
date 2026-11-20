# Emergency playback and precise synchronization — NauticMixxx 2.0

A playing USB deck enters EMERGENCY LOOP when its removable-source session is
revoked or the decoder reports an unexpected read failure. The mount watcher
invalidates the shared session before discovery finishes, so both decks from the
same USB react together. A deck on another source keeps running normally.

The engine keeps recent post-scaler stereo PCM in a preallocated ring (12.3 MB
per USB deck, sized for eight seconds at 192 kHz). The audio callback performs no
allocation, source decoding or filesystem I/O for emergency playback. It repeats
four beats at the last effective BPM when that much history exists, otherwise
two beats, one beat or the available audio. Without valid tempo it uses up to one
second. A short crossfade limits discontinuities at entry and wrap. A paused deck
shows the unavailable-source warning and remains silent; it does not start audio.

Transport, seeks and SYNC cannot change the emergency audio or frozen position.
Titles, unavailable waveforms and key information are hidden; bar counts become
`--.- Bars`. Affected overviews show red `EMERGENCY LOOP` and the performance page
shows `Cannot play track. Some player functions limited.`. Time, source identity
and the shared footer remain present. Loading a valid track clears the state;
LOAD LOCK permits this recovery load. Reconnecting the USB alone does not clear
it. Normal track end does not count as source loss; small decoder end corrections
are tolerated. Existing rating writes publish the new database fingerprint before
resuming discovery, avoiding invalidation caused by our own atomic update.

## Exported BPM and SYNC

PQTZ stores positions rounded to milliseconds, plus tempo in hundredths of BPM.
At 122.00 BPM its intervals alternate approximately 491 and 492 ms. Interpreting
each rounded interval as a new tempo caused local BPM and SYNC to fluctuate.
When every exported tempo matches and every timestamp agrees with the constant
grid within 1.1 ms, use that precise tempo and the first beat anchor, adjusted for
decoder timing. Genuine tempo changes and irregular grids retain their original
positions. PDB browse metadata is not used to force an incompatible ANLZ grid.

Short SYNC on FLX4/DDJ-400 now enables persistent SYNC; a second press disables it.
Hercules and supported Pioneer/Roland RX3 SYNC paths explicitly request beat-phase
alignment when enabling synchronization, independently of Quantize. SHIFT and
long-press functions retain their existing actions. A missing or wrong beatgrid
still needs correction: exact tempo agreement alone cannot fix bad analysis.

## SHORTCUT presentation

The black panel leaves a clear margin above the live SOURCE/BROWSE footer. Its
layout cannot expand its window over that footer. The USB card shows the assigned
USB slot, actual device label and grouped color/settings row. Separators are inset
from both edges. WAVEFORM COLOR uses #202020 and MY SETTINGS uses #191919; selected
buttons remain #007CE0. MY SETTINGS LOAD is disabled while either deck plays.

## Primary reference and validation boundary

The [Pioneer DJ XDJ-RX3 instruction manual](https://www.bhphotovideo.com/lit_files/775212.pdf)
describes emergency Beat Loop, limited DJ operation and cancellation by loading
another track (page 68), and Beat Sync tempo/phase alignment (page 73). Its emergency
example concerns failure to start the next track; the mid-track USB-loss trigger
here implements the behavior requested from the supplied reference photograph.

Native tests cover shared-session loss, independent USB sources, audible cached
loops, paused loss, source-read failure notification, command blocking, new-load
recovery, normal WAV end, constant and changing PQTZ grids, pitched-master sync
with Quantize on/off, and per-deck presentation. Offscreen renders and pixel checks
cover the footer and USB card. Physical USB removal, controller timing and native
Windows runtime validation remain pending. No new candidate is packaged without
explicit approval. Test evidence is recorded in TEST_REPORT.md.
