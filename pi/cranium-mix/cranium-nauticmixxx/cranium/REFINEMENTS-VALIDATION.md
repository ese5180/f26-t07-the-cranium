# Search, settings feedback and transition refinements — 2026-11-10

Native source: aa29d2c.

Search explicitly selects the track-results page when leaving MENU/Utility;
opening Search resets its keyboard, query and track filter together. The same
entry path works from performance, SOURCE and browser menus, preserving the
selected USB or choosing the first ready USB. No-source behavior still shows
sources rather than leaving a keyboard over an unrelated page. Track-table
focus also tolerates a model that has not yet been assigned during startup.

Controller checking finishes after 3 seconds with a connected, disabled, or
not-detected result. Controller status polling no longer rebuilds an unchanged
combo box every 700 ms. Customer-facing status text omits Pi references and
uses generic built-in audio names where applicable.

REFRESH DEVICES launches a separate Python/PortAudio probe using QProcess.
It never closes, reinitializes, or reopens the live SoundManager's streams.
Navigation remains responsive, repeated refresh is disabled while busy, and
progress plus a footer message are visible. Success, error, missing helper and
12-second timeout all return to a usable UI; failure leaves current routing
unchanged. Currently configured endpoints omitted by a busy driver's probe
remain labelled as the current setup. Selecting a newly discovered endpoint
can refresh the engine's device table only when the user saves, with playback
stopped. Existing SoundManager driver close/reopen behavior is preserved.

Both Save and Refresh are blocked during playback. Save shows its busy message
before the existing driver operation; unlike the detached Refresh scan, applying
hardware routing can still block briefly in an OS driver. Routing errors restore
the previous configuration. An unassigned master returns immediately without
closing the current output.

Audio Setup now has touch Play/Pause for decks 1 and 2, disabled until a track
is loaded. These operate the actual deck play controls without a MIDI device.
The performance skin layout is unchanged.

Appliance-mode GL wrappers, native window containers, waveform backing and
page stacks use black backgrounds. The container color is assigned before it
is shown, preventing Qt's default light backing from appearing between frames.
No navigation animation, timer delay or screenshot overlay is added.

## Checks

- Native MIDI/RX3/USB/default-audio and completion suite: 216 passed, 11 optional
  hardware/fixture skips; exit 0. Includes Menu-to-track view regression,
  finished controller-check status, async refresh heartbeat/navigation, touch
  transport, output-pair preservation and black backing before a renderer frame.
- Final staged ARM release suite: 266 passed, 18 optional hardware/fixture skips;
  exit 0. The packaged production audio probe also exits successfully in the
  isolated ARM VM (no physical sound devices available).
- Existing source release validation and Windows identifier contract pass.
- Two independent-probe identifier tests, five session-shell tests and both
  profile-preservation tests pass.
- Actual native app at 800×480 and 1280×800 loaded the disposable Rekordbox USB
  fixture, opened MENU then SEARCH repeatedly, entered 'nanana' and returned
  the real matching song. The settings table was hidden and keyboard/results
  visible; leaving Search hid the keyboard.
  Each size completed 44 GUI checks, including fullscreen preservation.
- Actual touch Play/Pause changed the loaded deck's play state, and refresh
  was disabled while that track played.
- A deliberately slow probe proved System/Audio navigation still responds
  while progress is visible. Deliberate failed and hung probes produced final
  messages and re-enabled controls, including the real 12-second watchdog.
- Native compositor frames sampled at 0/16/48 ms around seven navigation changes
  at 800×480 contain no 16×16 bright background blocks. Captures retained under
  ../nauticmixxx-build/transition-*.png; visual timing on the actual Pi still
  requires a physical check.
- Test-only slow/failing/hung helpers and GUI drivers are not shipped.

## Offline SD update

- Package overlay: ab9fba53ff9d6a91e08c5cebc1000c58962aa013.
- Native engine: aa29d2c56b1410c4ccb48380abe174c39a2588c8.
- Archive: 113,357,670 bytes compressed; 262,364,027 bytes unpacked.
- Archive SHA-256:
  `55a4ec1922807f2cf6b292576c6515abf41662b784e2379ed31c6a43f93b11aa`.
- Staged on the inspected external Pi boot volume, UUID
  `<original-verified-SD-UUID>`. Prior update preserved in evidence.
- FAT filesystem check exited 0. After remount, independently verified the
  archive, all eight installer sidecars, packaged production audio probe,
  normal boot backup and next-boot installer command. Test helpers excluded.
- Display configuration and app selection are unchanged. The card was safely
  ejected. Installation and one automatic reboot occur on the next Pi boot;
  this is not a claim that the running Pi was updated remotely.
- Machine-readable staging and readback reports:
  `../nauticmixxx-build/evidence/20261111T043531Z/`.

Boot console suppression and boot-time optimization are deferred, as requested.
FLX4 cable detection and audible output have not been physically tested by the
agent; the controller investigation remains deferred until new cables are ready.
