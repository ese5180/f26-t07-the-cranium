# Proportional multi-touch zoom — 2026-11-09

The earlier implementation latched its first threshold crossing for an entire
contact sequence. The replacement follows the ratio of the initial/current
2D finger separation throughout a gesture, including deliberate reversal.
The same calculation is used at every finger angle.

Qt delivers the two native OpenGL waveform windows separately. Input changes
are coalesced over 12 ms before measuring span, and Stationary snapshots do
not overwrite a contact's latest moving position. This avoids interpreting
half of a rotation/translation frame as a pinch. Final release coordinates
are retained for the coalesced final frame, so a quick gesture is not lost.

The far-out pinch levels are 10, 8 and 6. Close up, the original 1–6 integer
levels remain available. Boundary hysteresis and a small initial movement
guard suppress jitter. Wheel zoom retains its previous one-level steps.
Both decks remain synchronized, and external controller/wheel changes rebase
an active pinch instead of being undone by it.

All changes remain confined to the central performance waveforms. The existing
playing-track drag protection, paused scrubbing, no-scrub-after-pinch behavior,
small overview seeking, USB metadata and CRANIUM branding are retained.

Regression sequences cover all eight 45-degree orientations, sustained and
reversed pinches, coarse far-out steps, quick release-only motion, clamping,
cancellation, cross-window packet order, stale Stationary snapshots, pure
rotation and translation, playback controls and small overview interaction.
Packaged-app checks use real native OpenGL windows and ControlProxy signals.
The actual touchscreen feel still requires an on-Pi trial.

## Recorded result

- Native engine: `e878880471c4cca6564a5492c2f553ae9f63752f`.
- Packaged overlay: `1e81108b677b1e22ca7caabdcf0f69c3e8840b69`.
- Required ARM64 build suite: 190 passed, 10 optional/fixture skips; exit 0.
- Expanded release native suite: 242 passed, 17 optional/fixture skips; exit 0.
- Source release validation completed on macOS with Node 24; native suite ran
  separately on ARM64. Debian's Node 18 lacked automatic mixed-module detection.
- An exploratory five-test-only run passed its assertions but crashed at process
  teardown. Both complete native suite runs exited normally; packaged-app checks
  below passed. The subset teardown issue is not claimed as resolved.
- Actual packaged native GL window checks: all PASS at 800×480 and 1280×800,
  including held/reversed pinches, vertical input, split-window rotation,
  cross-window scale changes and 10→8→6→4 coarse/fine progression.
- Packaged native compositor captures are retained in the build artifact folder.
- Archive SHA-256:
  `a610cde53383ca17d5d2d0351e00a2220074044ddea437eb502e541d0a349c8d`.
  Archive is 113,297,657 bytes; unpacked files total 262,240,700 bytes.
- The existing SD installer stage was backed up, then replaced in place. FAT
  verification returned 0; cold-remount readback verified archive, helpers,
  normal boot backup, armed one-time command and unchanged display/app settings.
  Evidence: `../nauticmixxx-build/evidence/20261109T195744Z/`.

This is staged for the next Pi boot, not remotely installed into a running Pi.
No real touchscreen or audio hardware was used during automated validation.
