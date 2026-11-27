# FLX4 Beat FX channel selector — 2026-11-16

The FLX4 selector flags 94/10 and 95/11 are combined after a 5 ms quiet period,
using Pioneer's published MIDI message table. A single active flag assigns
Effect Unit 1 to the corresponding deck; both active flags assign the master
bus. Old master/deck routes are disabled before the new route is enabled.
Startup waits for both flags, all-off transitional snapshots retain the last
valid route, and repeated snapshots avoid redundant audio-routing writes.
The effect selection, wet level, slot enable and playback controls are preserved.
Pending selector timers are cancelled on controller shutdown.

The skin's CH SELECT area now derives its label from real effect routing:
channel 1 -> 1, channel 2 -> 2, master -> MASTER. The existing master toggle is
retained in the master view. New channel labels use the same typography.
The installer updates the saved main FLX4 script with a backup, alongside the
previous encoder-helper migration, without resetting the audio profile.

Passed checks: both MIDI message orders; every selector position and transitions;
startup partial snapshots; all-off transition; repeated snapshots; level and
on/off control preservation; actual XML label visibility for all three routes;
XML parsing; JS syntax; previous browser/encoder tests; FLX4 MIDI preset;
four Pi profile migration/preservation tests; flattened controller references.
No physical audio-routing or screen rendering result on the Pi is claimed.

Prepared package (includes the encoder-zoom update):
../nauticmixxx-build/bundle-flx4-fx-selector/
Archive SHA-256: 88b30853d856acfafce9b8c5e0e09746ba1a3f5b0ee7de21a7e6618b2b7a9992
Archive bytes: 113,361,315.
Reproducible packaging: ../nauticmixxx-build/package-flx4-fx-selector.py.
Only the main FLX4 script, beffect.xml, style.qss and build provenance change
inside the previous zoom package. All other file hashes, including the native
ARM64 application and its libraries, are preserved and verified.
SD staging/install remains pending; the card is in the running Pi.

MIDI reference:
https://www.pioneerdj.com/-/media/pioneerdj/software-info/controller/ddj-flx4/ddj-flx4_midi_message_list_e1.pdf
