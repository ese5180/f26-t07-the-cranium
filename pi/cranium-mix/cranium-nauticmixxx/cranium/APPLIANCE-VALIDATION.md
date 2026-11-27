# Cranium embedded settings and normal/developer session — 2026-11-10

The user photo showed Cranium tiled beside Firefox and the desktop Waybar.
The original image config used `popup_during_fullscreen leave_fullscreen`;
our previous native preference UI exposed external help links. This update
removes that UI path from normal operation rather than relying on users to
avoid links.

## Native application

- MENU Controller Setup and Audio Setup open a child page inside the original
  main window. Black/white touch controls, live MIDI status, USB identity,
  enable/disable, device selection and stereo output pairs are embedded.
- System/Developer replaces All Preferences in the utility list. Desktop mode
  requires opening Developer Tools and holding the entry action for 2 seconds.
  A tap cannot enable it; advanced preferences are accessible only in this mode.
- Main window title/application branding is CRANIUM in appliance mode; the
  normal-mode menu bar is hidden and fullscreen restored if changed.
- HTTP/HTTPS/file/mail links cannot launch desktop applications in normal mode.
  File-browser shortcuts are also gated. Developer Mode explicitly permits them.
- No-output/startup audio failures do not open desktop setup dialogs in normal
  startup. The application remains available for embedded audio setup.
- Audio route changes and device refresh are blocked during any deck, sampler,
  preview or AutoDJ playback. Route validation checks channel limits, output
  clashes and API compatibility, retains advanced I/O, and restores the saved
  previous route after an open failure.
- Existing source licenses and upstream attribution remain. Internal filenames,
  profile paths, mappings and application ID stay compatible.

## Pi session

- Original Sway configuration is backed up as `cranium-desktop.conf`. Display
  modes, transforms and touch mapping are carried into the normal config.
- Normal Sway config has a black CRANIUM background, no desktop bar/start menu,
  `popup_during_fullscreen smart`, and a fullscreen application without borders.
- A user-service condition prevents automatic Waybar startup outside Developer
  Mode. Developer Mode starts the bar deliberately; returning stops it.
- Session guard moves unrelated windows to the scratchpad, keeping the Cranium
  window fullscreen and focused. Foreign apps are hidden rather than destroyed.
- Ctrl+Alt+D remains a deliberate developer recovery shortcut. Desktop mode is
  runtime-only and resets each boot. Working trial applications remain intact.
- Launcher retries normal-mode exits before showing branded recovery actions.
- Installer captures read-only USB/audio evidence in CNUPDATE/diag.json. This is
  installer-boot evidence, not proof of the later interactive session's state.

## Verification

- Native MIDI/RX3/USB + embedded UI and routing tests: 206 passed, 10 optional
  fixture/render skips; process exited normally.
- Five session/config tests pass, including preservation of hardware settings,
  older Sway scratchpad trees and isolation without destroying foreign windows.
- Both existing Pi profile-preservation tests pass.
- Source release checks and Windows identifier contract pass.
- Generated Sway config validates on ARM64 (headless renderer emits expected
  missing-DRM warnings but validation exits 0).
- Actual native app + generated shell checks pass at 800×480 and 1280×800:
  repeated embedded setup/back, same main window, fullscreen preserved,
  native menubar hidden, external link intercepted, tap-vs-hold developer entry,
  explicit return to normal mode and isolation of a foreign GUI window.
- Inspected actual startup-background capture: black with white CRANIUM only.
  Inspected embedded Controller and Audio captures at both target resolutions.
- QA artifacts and test-only drivers are retained in ../nauticmixxx-build/;
  no QA preload, fake controller or foreign window tool is shipped to the Pi.

Physical Pi startup, screen touch, FLX4 USB cable and audio hardware still need
an on-device trial. This update does not assert that a controller the OS cannot
see is now connected or identify the cause of that separate hardware failure.

## Final package and SD stage

- Expanded final release native suite: **258 passed**, 17 optional/fixture skips; exit 0.
- Complete ARM64 installer rehearsal passed, including profile, display/touch retention, saved developer config, service condition, artwork and diagnostics.
- Actual app/shell QA: 54 checks passed at each of 800×480 and 1280×800.
- Source overlay: `c8e2d8e7429f126169adf49a1f3d059e4e1ac97b`; engine: `2f7d1d73dfdfa4ae8604be9b449c3267bb62bd9e`.
- Archive SHA-256: `0ddb58b5b9a121d48e866ae3121fb584f3f7a1e3bd494309a437293826559a8d`.
- Archive: 113,343,082 bytes; unpacked app: 262330364 bytes.
- SD evidence: `../nauticmixxx-build/evidence/20261111T033341Z/`.
- FAT verification returned 0. Cold-remount readback verified archive, all eight
  installer/runtime/artwork files, armed one-time boot command, normal boot
  backup, unchanged display config and app selector. The card was safely ejected.
