# CRANIUM Mix partner checkout

Read README.md first. Both source folders are included in this one repository;
do not clone over them, reset them, or run the legacy prepare/patch-export tools.
Edit the actual C++ engine and overlay directly. Preserve upstream licenses.
Never use near or far as identifiers in shared C++ code.

Run bash tools/test.sh after changes. C++ changes also require the ARM64
Bookworm build/native tests. Keep known physical Pi behavior distinct from
software checks and the historical native-test evidence.

Keep user profiles, music, SD images, device identifiers, credentials and build
outputs out of Git. Do not flash, erase, reformat or stage an SD card unless the
user explicitly requests deployment to an identified target.
