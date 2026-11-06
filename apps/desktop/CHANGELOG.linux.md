# The desktop app for Linux: changes

One entry per version, newest first; the version is `extraMetadata.version` in `electron-builder.linux.yml`, and each
released version is tagged `desktop-linux-v<version>` ([docs/versions.md](../../docs/versions.md)). The first
paragraph is what a release says.

## 0.1.0

The first Linux app: the console and the customer site in a window of their own, with their pages kept on the computer and brought up to date from the console, the USB console over a J-Link, and updates to a board over Bluetooth. An AppImage for any distribution, and a .deb and an .rpm that add the menu entry and the board's USB rule.

Electron 44.9.3, x64: `Cranium-0.1.0.AppImage`, `cranium_0.1.0_amd64.deb` and `cranium-0.1.0.x86_64.rpm`. The .deb
and the .rpm install the app in `/opt/Cranium`, the command `cranium`, the menu entry with its icon, the J-Link's
udev rule (`70-cranium-jlink.rules`, with `uaccess`) and, on Ubuntu 24.04, electron-builder's AppArmor profile for
the sandbox. Web Bluetooth is switched on for Linux. None is signed. Not yet tried on a Linux computer by a person:
CI builds all three on Ubuntu with the example configuration, and installs and removes the .deb.
