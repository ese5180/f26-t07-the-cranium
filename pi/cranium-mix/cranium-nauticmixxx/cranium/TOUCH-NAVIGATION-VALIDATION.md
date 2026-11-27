# Cranium touch navigation — 2026-11-09

The performance screen now has persistent native SOURCE, BROWSE, TAG LIST,
PLAYLIST, SEARCH, MENU and INFO controls. The middle pad-mode strip is hidden
inside a separate parent; the controls and controller mappings remain intact.
The native buttons are moved into the toolbar, preserving their existing
callbacks, enabled states, encoder focus and MENU hold behavior.

Tapping an active navigation button again returns to performance. Tapping a
different navigation button opens that section. Search's keyboard hides when
returning to performance. INFO retains its existing information-panel action;
it is not a browser navigation button. No separate PERFORM button was added.
Hardware browser commands clear the touch action selection so their existing
navigation state can take over. No audio-routing or MIDI mapping changes.

The 800×480 and 1280×800 captures and GUI check logs live in the sibling
`nauticmixxx-build` directory as `touch-*.png` and `touch-check-*.txt`.
The test-only Qt driver is outside the shipped app and exercises actual
native button mouse events. It checks the visible toolbar, bounds of every
button, hidden pad strip, all six navigation toggles, USB source selection,
and Search keyboard visibility. Its USB is a disposable nine-track export
copy in the builder, not the original music USB.

Source validation, native tests, runtime archive verification and offline
profile-preservation checks are recorded with the final package. Physical
Pi touch interaction, playback and FLX4 audio still require an on-device test.

The SD update workflow verifies the completed previous installer, backs up
its staging directory on the Mac, verifies the new archive, then arms the
one-time offline installer. Normal boot arguments are restored before app
installation. The installer preserves the current profile and retains the
previous installed app in the Pi's backup directory.

## Final result

- Native engine: `ea85d0846cff8fb8ded3ca322f5cb8af91243919`.
- Overlay/package source: `961cf9b9dc66436c4ab0d4e8089e4f4f4eee8c64`.
- Source validation passed. ARM64 suite: 184 passed; 9 optional fixtures/render checks skipped.
- Packaged-app GUI checks: 40 passed at 800×480 and 40 at 1280×800;
  exact fullscreen capture dimensions and keyboard bounds verified.
- Separate installer profile-preservation check passed.
- Final archive: `nauticmixxx-build/bundle-touch-final/nauticmixxx-arm64-bookworm.tar.gz`.
- SHA-256: `a122e97acf1d4ac43ce21553cf21c0f30f88ebb7eaa9a426efbd7f87363033c9`.
- Archive verified to exclude test hooks and private Wayland libraries.
- Update staged on identified Pi SD on 2026-11-09. Previous completed SD
  staging backed up in `nauticmixxx-build/evidence/20261109T172709Z/`.
- The physical Pi applies the app update on its next boot; this report does
  not claim an on-device playback test of the new version.
