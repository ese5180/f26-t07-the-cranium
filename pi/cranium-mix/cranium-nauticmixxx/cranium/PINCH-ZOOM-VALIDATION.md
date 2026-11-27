# Cranium waveform touch controls — 2026-11-09

Only the central performance waveform template opts into `CraniumPinchZoom`.
The native viewer collects raw touch contacts before Qt turns them into mouse
drags. The input router recognizes both QWidget and native OpenGL QWindow
surfaces, combines fingers across the two central waveforms, and consumes
emulated mouse events so a pinch cannot also become a scratch.

- Fingers apart: one existing zoom step in (numeric level decreases).
- Fingers together: one existing step out (numeric level increases).
- Both decks remain synchronized; existing 1–10 bounds apply.
- One step per contact sequence; lift fingers before the next pinch.
- A 15% span change with a 12 logical-pixel minimum rejects finger jitter.
- One-finger scrubbing remains available while paused, after a 10-pixel drag.
- Central on-screen drags cannot scratch or pitch-bend a playing track.
- Starting playback during a paused scrub immediately releases that scrub.
- Lifting one finger after a pinch never turns the other finger into a scrub.
- Cancelling, hiding or replacing the waveform cancels its touch sequence.

The small lower left/right waveform overviews do not opt into this handler.
They retain click/drag seeking while playing. The Pi installer unlocks their
existing Needle Lock preference once, with a backup of the previous profile;
a later explicit user choice remains preserved on subsequent updates. No
hardware jog-wheel mappings or other audio preferences are changed.

Tests drive real QTouchEvents through the app event filter and observe zoom,
play, playposition, rate, scratch, wheel and grid controls. They cover both
pinch directions, one-step latching, bounds, jitter, cancellation, fingers on
separate deck widgets, paused scrubbing, a playback start during a scrub,
remaining-finger suppression and an actual small WOverview click while playing.
Profile tests check the one-time unlock, backup and preservation of unrelated
settings and later user choices.

Qt touch routing reference: https://doc.qt.io/qt-6/qtouchevent.html . Widget
screenshot capture omits native GL surfaces; compositor captures and a
native-window input check are used for the packaged-app review. The physical
screen's two-finger reporting and final feel still require an on-Pi trial.

## Final result

- Engine source: `ae70ce4eddc1be7e7034e7a85cade40b55317949`.
- Overlay/package source: `4e28bb1fc982cdc417d98e43b23904945c4c930e`.
- Final archive: `nauticmixxx-build/bundle-pinch-final/nauticmixxx-arm64-bookworm.tar.gz`.
- SHA-256: `e912304d3c58f3f21ae6b3ab999aa3c60d0006a0e22daf97d312254c793097d9`.
- ARM64 native regression suite: 188 passed, 10 optional fixtures/render checks skipped.
- Both profile-preservation/migration checks passed.
- Packaged native OpenGL-window touch checks passed at 800×480 and 1280×800:
  spread 5→4 once, inward 4→5 once, cross-deck pinch 5→4 once, while playing.
- Runtime checksum and exclusion of QA hooks/private Wayland libraries verified.
- Captures: `pinch-compositor-800x480.png` and `pinch-compositor-1280x800.png`.
  Input logs: `pinch-native-check-800x480.txt` and `pinch-native-check-1280x800.txt`.
- Card readback confirmed the previous USB metadata fix installed successfully.
  This new update is staged for the next Pi boot; actual screen input remains
  the next on-device test.
