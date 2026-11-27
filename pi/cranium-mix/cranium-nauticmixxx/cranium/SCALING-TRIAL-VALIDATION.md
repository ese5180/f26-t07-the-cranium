# 800×480 trial — November 9, 2026

The UI keeps its 1280×800 reference canvas and uses the existing live
`WReferenceScaler` with `ReferenceFill=true`. The trial's minimum is 800×480;
the splash image is 600×200. Fonts/metrics use the limiting 0.60 scale and
flexible layouts fill the screen width. No feature/layout redesign was made.

The application and native tests compiled on ARM64 Debian Bookworm with Qt
6.4.2, Release, portable CPU optimization, three jobs and precompiled headers.
The final run passed **184 native tests**, with **9 optional fixture/render
tests skipped**. This includes the added 800×480 reference-fill regression.
Source/controller/XML/USB contract validation, the Linux package/profile
checks, Python/shell checks, and isolated-profile audio-copy preservation passed.

Two initial logo tests failed because the build helper omitted their skin
fixture path. Adding `NAUTIC_SKIN_DIR` resolved them; the final native run has
no failures. Package validation also required `desktop-file-utils` in the builder.

The actual bundled app opened fullscreen at 800×480 under headless Sway/Mesa.
The no-audio prompt in the hardware-free builder could initially appear behind
fullscreen. The startup message boxes now have the main window as their parent,
and the Pi profile suppresses the first-run menu hint. Working Pi audio settings
are copied into the isolated NauticMixxx profile during installation.

The temporary keyboard mapping used to drive the native RX3 browser was invalid:
these generic RX3 controls reject `setValueFromMidi` and are normally driven by
controller scripts. A separate test-only Qt startup driver exercised the actual
app's native widgets instead. That driver is outside the source app/package.
It selected the browser page, clicked SOURCE, selected the copied USB, opened
categories and SEARCH, clicked the on-screen H key, and returned to BROWSE.
The final app reported an **800×480 window** and the keyboard hidden after browse.
Captures were inspected: nine songs/one playlist were detected; H displayed
seven matching tracks and the integrated keyboard. Test data was a disposable
copy of the user's previous nine-track export, not the original music USB.

Final runtime archive:

- `nauticmixxx-build/bundle-pi-final/nauticmixxx-arm64-bookworm.tar.gz`
- SHA-256: `3ed87d5f3db4dd1aead62122208f78ec56ef9b4088635b7971426904b99aa159`
- Native engine: `5a3c860240bd765c9e7b37ea8240f053d93e3290`
- Overlay/package code: `11d353a7183eca6e53fdc02f85b4caf76cdca91e`
- About 113 MB compressed / 262 MB installed.

The archive preserves the Pi's native graphics/Wayland/C/C++ runtimes. Its
checksum and exclusion of all QA hooks/profiles were verified. The installer
adds an isolated `/opt/cranium/nauticmixxx` app and `~/.cranium-nauticmixxx`
profile, extends the existing chooser, and retains BiteDJ/original Mixxx.

Captures and logs are in the sibling `nauticmixxx-build` directory, including
`native-source-800x480.png`, `native-categories-800x480.png`,
`native-search-typed-800x480.png` and `native-search-closed-800x480.png`.
The reference version remains in Git history for 1280×800 comparison.

Physical Pi installation, touchscreen usability, FLX4 MIDI/audio, latency,
headphone cue and sustained playback still require the user's trial. This
report does not claim pixel-identical RX3 behavior or that the scaled touch
targets are already product-ready.
