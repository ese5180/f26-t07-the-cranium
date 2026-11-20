# Appliance startup, revision 1

This update keeps the existing ARM64 Bookworm system and native CRANIUM app.
It is an incremental startup cleanup, not a new OS image or a Chromium app.
Development, rebuilds, USB music, MIDI and the existing audio configuration remain
available. No packages are uninstalled and no kernel, firmware, audio buffer,
CPU governor, swap, network or security-update policy is changed.

## Changes

- Retain Sway's minimal fullscreen session and the black/white CRANIUM background.
- Quiet ordinary kernel/systemd messages, hide the Linux logo/cursor and disable
  the firmware rainbow splash. Preserve root, storage, display overlays, touch
  calibration and serial recovery arguments. Kernel console text goes to tty3.
- Skip tty1's automatic text login unless `cranium-console-enabled` exists on
  the boot volume. The installer first verifies that LightDM independently
  starts the pi/Sway graphical session. It refuses another login arrangement.
- Run one USB automounter: udiskie, with devmon as a missing-command fallback.
  Previously both ran together. USB browsing still needs a physical hot-plug test.
- Start the external desktop keyboard only in Developer Mode. CRANIUM's native
  search keyboard remains part of the app. Stop the desktop keyboard on return.
- Enforce fullscreen on window events immediately, with a ten-second idle
  recovery check instead of reading the compositor tree every second.
- Record a short performance trace after boot, then exit the collector.

The early screen can remain black until graphics starts; this is not an
initramfs/Plymouth logo from the instant power is connected. Firmware errors,
recovery consoles and installation output are not promised invisible. There is
no measured boot-time, RAM or audio improvement yet. The current image already
requests the performance CPU governor; heat and track-loading stalls still need
diagnosis on the actual device.

## Build the offline update

Run the root host checks, commit the sources, then combine an existing verified
ARM64 Bookworm app bundle with the current startup helpers:

```sh
python3 tools/prepare-pi-update.py /path/to/existing-bundle /path/to/new-update
```

This preserves the existing native app archive and manifest byte for byte. It
does not compile native changes. Rebuild/package the app first if you changed
C++, skins, mappings or other app resources. The new `startup-manifest.json`
records the source commit and every helper/artwork checksum. Installation and
SD staging validate it. Reports and SD evidence belong under ignored `build/`
or outside this repository, never in public source control.

Use the guarded SD staging workflow in [PI-DEPLOYMENT.md](PI-DEPLOYMENT.md).
No card is modified while preparing the bundle. The first boot installs offline
and reboots; assess normal startup on the following boot. Installation output
is intentionally retained for troubleshooting.

## Performance evidence

Thirty seconds after the graphical session starts, a low-priority process
samples for 120 seconds at ten-second intervals, saves one report, and exits.
It does not continuously monitor the device. Latest automatic report:

```text
/home/pi/.local/state/cranium/startup-performance.json
```

It records whole-machine CPU busy/iowait, native app CPU/RSS, available RAM/swap,
major faults, swap traffic counters, CPU/memory/I/O pressure, temperature,
frequency/governor, current and historical throttle flags, free root storage,
and systemd boot timing. Unknown/unavailable sensors are explicit. The first
mapped CRANIUM window is timed separately from application launch; neither is
proof that audio is ready. Reports contain no track titles, playlists, music,
network addresses or USB serial numbers. Keep device reports private.

For a later playback test, enter Developer Tools, open its app chooser using
the CRANIUM menu icon, and choose PERFORMANCE. A developer terminal samples
for two minutes at five-second intervals while you operate the decks. Manual
report: `~/.local/state/cranium/performance.json`. A simultaneous capture is
refused. The equivalent terminal command is:

```sh
cranium-performance --seconds 120 --interval 5 --show
```

To disable automatic diagnostics, put an empty `cranium-no-diagnostics` file
on the SD boot volume. The manual command still works. Diagnostics don't reset
audio, benchmark the USB by writing to it, count engine underruns, or establish
audible quality. Audio dropouts still need a real two-deck playback check.

## Developer access and recovery

MENU → SYSTEM / DEVELOPER → hold DEVELOPER TOOLS for two seconds. Ctrl+Alt+D
also enters Developer Mode with a physical keyboard. The bar, desktop keyboard,
terminal and trial apps are available there. Return using RETURN TO CRANIUM
MODE; normal mode also returns on reboot.

Before startup files change, the installer saves a checksum-protected startup
snapshot inside the per-update backup printed in `CNUPDATE/install-result.json`:

```sh
sudo cranium-appliance restore /home/pi/cranium-nauticmixxx-backups/EXACT-BACKUP
```

Stop playback before restoring/rebooting. This restores the preceding boot
arguments/config, Sway config, startup helpers/artwork and service overrides;
it removes startup files that did not previously exist. It preserves the app
and audio profile. The old app has its separate `previous-app` backup. Restore
checks all hashes first and refuses to overwrite a later manual edit/update.

If graphics won't start, power down and return the SD to the Mac. Copy
`cmdline.before.txt` from `CNUPDATE` over boot-volume `cmdline.txt` to undo the
new kernel arguments; create empty `cranium-console-enabled` on that volume to
restore tty1 login next boot. Do not copy an armed `systemd.run` command line.
Display overlays remain unchanged except for the appended, labelled
`disable_splash=1` block. Keep the saved pre-update files for diagnosis.

## Hardware acceptance checks

1. Time power-on → first usable performance screen on two normal boots. Ignore
   the one-time install/reboot when judging startup time.
2. Check 800 × 480 orientation/touch, SEARCH keyboard, fullscreen menus, Developer
   Mode entry/return, and clean recovery after one application restart.
3. Insert/remove each music USB, browse playlists and load both decks. Confirm
   mounted USBs appear and are not mounted twice. Safely eject before removal.
4. Confirm FLX4 controls and the deliberately selected audio output, cueing and
   recording. Play two analyzed tracks, use zoom/effects, then load another
   track during playback. Listen for dropouts and record any loading stall.
5. Compare reports with perceived stalls. Separate low RAM/swapping, I/O waits,
   CPU saturation and undervoltage/thermal throttling before tuning anything.

Official references: [Raspberry Pi boot configuration](https://www.raspberrypi.com/documentation/computers/config_txt.html),
[kernel boot arguments](https://www.kernel.org/doc/html/latest/admin-guide/kernel-parameters.html),
[systemd boot timing](https://www.freedesktop.org/software/systemd/man/252/systemd-analyze.html).
