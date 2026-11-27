# Rekordbox drag-load and playlist corrections — 2026-11-09

The track table exports local file URLs while dragging. Deck drop targets
pass the filename to `Library::slotLoadLocationToPlayer`, which previously
opened it through the normal collection path. This bypassed the active USB
runtime catalog and lost the exported key, PQTZ grid and saved cues. A normal
browser/controller load already projected the right runtime TrackPointer.

The filename load handler now resolves catalogued USB audio paths back to the
active Rekordbox source and creates the same temporary session-bound track.
A failed or unavailable export in USB-only mode cannot silently fall back to
a plain audio-file load. Ordinary local-library paths retain their existing
load behavior. No audio-file tags or original export databases were changed.

Single taps on playlist rows and playlist folders now enter them. Encoder
movement still selects/previews; encoder ENTER still enters. The old extra
double-click connection is removed to avoid an additional enter action from
the double-click signal. A compact browser row lists the selected track's exported A–H
Hot Cues and Hot Loops before loading, without decoding the song or running
analysis. Tracks without exported Hot Cues say so. The performance key label
now reads KEY. The large pad menus remain hidden.

Validation uses a disposable copy of the user's updated export, not the live
music USB. Original export database hashes were checked unchanged afterward.

- 95 tracks: each retained its exported key and grid after actual audio decode.
- 71 tracks carried 180 Hot Cues/Hot Loops, all retained after projection.
- “(It Goes Like) Nanana - Edit”: Gm, 130 BPM, 502 grid beats, five saved cues.
- The original packaged app reproduced missing key/grid/cues when a native
  file-URL drop was delivered to its deck overview.
- The corrected packaged app accepted the same drop and displayed Gm,
  130 BPM, beat readout, grid ticks and saved cue markers.
- A single mouse/touch tap opened a real exported playlist with 47 tracks.
- The native regression suite and focused cue-formatting checks passed.

GUI checks use a test-only Qt driver outside the runtime bundle; the actual
compositor captures include the OpenGL waveform surfaces. Screenshots and
logs are in `nauticmixxx-build`, including `drag-after-compositor-800x480.png`,
`touch-browser-cues-800x480.png`, `usb-drag-check-*.txt`,
`usb-playlist-check-*.txt` and `export-projection-report.json`.

The offline SD update uses the repaired CNUPDATE short boot-directory name.
On-device installation, physical touchscreen operation and FLX4 audio remain
the next hardware test; the build-machine checks do not claim those results.

## Final candidate

- Engine source: `23c3bceffa260a114e3f33b2d30d77a3a5194c8a`.
- Overlay/package source: `dc8bdf3d6e5ed73a92f1155142107c3ef995028e`.
- Archive: `nauticmixxx-build/bundle-usb-final/nauticmixxx-arm64-bookworm.tar.gz`.
- SHA-256: `4633ae7cf4ad2a8feb037cf188c48110bd44ec37ad72904446ba2d1d425ac76e`.
- Native suite: 185 passed, 10 optional fixture/render checks skipped.
- Separate real-export decode check: passed on all 95 tracks, 95 keys/grids,
  and 180 hot cues across 71 tracks.
- Final packaged-app drag test passed for both deck overviews at 800×480.
- Playlist opening was checked with single taps at 800×480 and 1280×800.
- Archive checksum verified; no QA hooks or private Wayland libraries shipped.
- Update staged on the identified Pi SD card on 2026-11-09, using CNUPDATE.
  Previous install status was confirmed as installed. The new app is applied
  on the next Pi boot; physical playback of this version remains pending.
  Stage evidence: `nauticmixxx-build/evidence/20261109T182047Z/`.
