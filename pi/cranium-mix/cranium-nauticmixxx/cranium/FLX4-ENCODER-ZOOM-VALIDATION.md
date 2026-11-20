# FLX4 performance encoder zoom — 2026-11-16

Implemented in the persistent overlay's FLX4 encoder helper. On the native
performance page, clockwise CC notches decrease both decks' waveform_zoom by
one; counterclockwise increases by one. Values clamp to 1..10, matching the
native renderer. The browser press/release callbacks and native engine are
unchanged. Browser turns, INFO, shortcut and explicit GRID editing retain
priority. Stock Mixxx fallback behavior remains unchanged. Central zoom does
not write play, seek, rate or pitch controls.

Checks passed: FLX4 browser mapping (native and stock), zero events, both bounds,
far-out single steps, shared deck values, INFO/shortcut/GRID priority, existing
click navigation; four-controller shortcut/transport suite; FLX4 MIDI preset;
30 flattened script references; JS syntax; three Pi profile/installer tests.
The installer now refreshes only the FLX4 encoder helper in existing isolated
profiles with a backup, preserving audio/configuration and other mappings.

Offline package: ../nauticmixxx-build/bundle-flx4-encoder-zoom/
Archive SHA-256: 7e4aa09adaea0f6bf60d06b9be4fce21332f50df64517d33cc59b3c80e3f0463
Archive size: 113,359,398 bytes.

The package derives from the previous refinements ARM64 release. Only its
FLX4 helper and build provenance JSON differ; every other file's SHA-256,
including the native executable and libraries, was verified unchanged.
Packaging procedure: ../nauticmixxx-build/package-flx4-zoom.py.

No Pi/SD changes made: the Pi is offline and its SD is in the running device.
Physical knob direction/detent testing awaits installation on the Pi. No fix
for track-loading freezes or thermal diagnosis is claimed by this update.
