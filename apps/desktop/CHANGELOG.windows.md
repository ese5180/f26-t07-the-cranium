# The desktop app for Windows: changes

One entry per version, newest first; the version is `extraMetadata.version` in `electron-builder.windows.yml`, and each
released version is tagged `desktop-windows-v<version>` ([docs/versions.md](../../docs/versions.md)). The first
paragraph is what a release says.

## 0.1.1

When the page asks for a serial port, the app names a J-Link's two ports, the console port and the log port, and offers the console port first. Board setup can register a board from the app, and fills in the Wi-Fi network from the console's defaults.

`src/lib/serial-ports.mjs`: the higher-numbered of a J-Link's two ports is its console (VCOM1), by number, with
`defaultId` on it. The register route takes the app's sign-in from console 2.6.3. Not yet tried with a board on Windows.

## 0.1.0

The first Windows app: the console and the customer site in a window of their own, with their pages kept on the PC and brought up to date from the console, the USB console over a J-Link, and updates to a board over Bluetooth. An installer for x64, with a Start menu entry and a desktop shortcut if wanted, and a portable copy that runs without installing.

Electron 44.9.3; `Cranium-Setup-0.1.0.exe` (NSIS, per user, the folder may be changed, an uninstaller in Settings >
Apps) and `Cranium-0.1.0-portable.exe`. Neither is signed. Not yet tried on a Windows PC: CI builds both on
`windows-latest` with the example configuration.
