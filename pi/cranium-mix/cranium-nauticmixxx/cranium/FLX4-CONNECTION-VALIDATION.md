# FLX4 connection and touch setup — 2026-11-10

The previous build already selected the RX3 FLX4 mapping automatically when the
backend enumerated the controller. Its first-controller timer queried a cached
PortMidi device table without reinitializing that backend, and it stopped
discovery as soon as any Controller object existed. This could miss a USB MIDI
device connected after application startup. It does not establish the cause
of this user's boot-with-controller-connected failure; cable, USB enumeration,
Pi power and live logs remain unverified.

The Linux timer now checks raw-MIDI node topology, including inode and ctime,
once a second and waits for one stable discovery tick after a change. It also
refreshes while no MIDI device is present. Before rebuilding the PortMidi
snapshot, streams and script engines are closed on the controller thread.
Controller QObjects remain alive until shutdown and are reused by name on
reconnect; fresh input/output wrappers receive current port indices. This
protects preference/learning page references and delayed Apply signals.
Other controller backends and the audio engine are not restarted. A failed
output-open attempt closes its input stream before retry or refresh.

MENU now begins with SYSTEM actions: CONTROLLER SETUP, AUDIO OUTPUT SETUP,
and ALL PREFERENCES. Setup opens the native settings on the appropriate page.
On small screens it occupies the full screen; pages scroll internally and
Apply/OK remain accessible. Controller Setup shows the detected hardware,
selected mapping and Enabled checkbox. Existing audio routing remains saved
and is not automatically replaced with a new output device.

## Validation

- Native engine source: 8dc5e22.
- Native MIDI + RX3/USB regression suite: 204 passed, 10 optional/fixture skips;
  process exit 0. Covers detach/reattach safety, output-open cleanup, and
  touchscreen setup commands as well as previous touch/USB behavior.
- Existing full FLX4 XML/input/output binding and browser-script checks pass.
- Pi profile preservation checks pass. Windows identifier contract passes.
- A test-only preloaded PortMidi backend advertises no device at app startup,
  then an FLX4 with paired input/output. The actual native app automatically
  loads the complete RX3 mapping, handles Play/Pause and sends corresponding
  LED output and keep-alive SysEx messages.
- While native Controller Setup stays open, the simulation removes the MIDI
  node, then reconnects with different input/output indices. The controller
  resumes working, without restarting the app or closing the preferences page.
- Actual 800×480 setup screenshot was inspected: device selected, RX3 mapping
  selected, Enabled ticked, Apply/OK visible.
- Simulation source, driver, event transcript and captures are retained under
  ../nauticmixxx-build/flx4-* and qa-flx4-hook.*. They are not in the Pi package.

The physical FLX4, its USB cable, real Pi USB power, real touch panel and sound
outputs have not been tested by the agent. The Pi is offline and the update
requires an SD transfer; preparation does not modify the running Pi.

## Packaged and staged result

- Expanded final native release suite: **256 passed**, 17 optional/fixture skips,
  process exit 0. Required staged build and source release checks passed.
- The same native-window connection/setup/reconnect checks also passed at
  1280×800; both setup screenshots were inspected.
- Package source overlay `c4c0ea102464fa8139a267b08ccd1f2c0cd8d051`, engine
  `8dc5e22ff1da146ff8e651f216d313109969be25`.
- Archive SHA-256:
  `7c3ecf653cbf035152ba0aece7ed9181296aaa9dd448a93cd52d961fba5b74f1`.
  113,311,154 archive bytes; 262,260,348 unpacked bytes.
- Full mapping XML and referenced scripts are included, simulation tools excluded;
  Qt/MIDI runtime files match the previously verified Pi package.
- Offline SD stage evidence: `<project-workspace>/nauticmixxx-build/evidence/20261111T024614Z`.
  Previous completed installer stage backed up before replacement. Display
  configuration and selected app were retained; normal boot command backed up.

FAT verification returned 0. Cold-remount readback confirmed the package,
installer helpers, armed boot command, normal boot backup, unchanged display
and selected app. The identified SD card was safely ejected.
