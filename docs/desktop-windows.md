# The desktop app on Windows

What is Windows' own about the desktop app; the rest is in [docs/desktop-app.md](desktop-app.md). Windows 10 or 11, x64.

## The files

| File | What |
| --- | --- |
| `Cranium-Setup-<version>.exe` | The installer, for the person installing it (no administrator needed). It shows each step, lets you choose the folder, adds Cranium to the Start menu, asks whether to put a shortcut on the desktop, and puts an uninstaller in Settings > Apps |
| `Cranium-<version>-portable.exe` | The same app in one file that runs without installing: from a USB stick, or where installing is not allowed. Each start unpacks it first, so it opens more slowly |

Neither is signed: there is no code-signing certificate, which costs money every year. So Windows warns before it
opens either file the first time. The warning names no publisher; the files are the ones the release built, as
`apps/dist/SHA256SUMS` lists them.

## Installing from the file

1. **Check the file**, if you like. In PowerShell: `Get-FileHash .\Cranium-Setup-<version>.exe` gives the SHA-256,
   which must be the one `apps/dist/SHA256SUMS` lists for it.
2. **Open `Cranium-Setup-<version>.exe`.** Windows SmartScreen says *Windows protected your PC*. Click
   **More info**, then **Run anyway**. Windows asks only this once for this file.
3. **The installer.** Choose the folder, or keep the one it offers (`%LOCALAPPDATA%\Programs\Cranium`), then
   **Install**. It asks whether to put a shortcut on the desktop: **Yes** or **No**.
4. **Open Cranium** from the Start menu. The first time, Windows Defender Firewall may ask about network access:
   the app only reaches the console, Cognito and the map's tiles over HTTPS.
5. **Sign in** as on the website. Pages that need the console's newest version arrive by themselves, with every file
   checked ([docs/desktop-app.md](desktop-app.md#the-bundle)).

**The portable copy:** open `Cranium-<version>-portable.exe`, with the same **More info**, **Run anyway**.

**Removing it:** Settings > Apps > Installed apps > Cranium > **Uninstall**. The desktop shortcut and the Start menu
entry go with it. The sign-in and the pages kept stay in `%APPDATA%\Cranium`; delete that folder too to remove
everything.

A silent install, for a lab's computers: `Cranium-Setup-<version>.exe /S`. It makes no desktop shortcut;
`"%LOCALAPPDATA%\Programs\Cranium\Uninstall Cranium.exe" /S` removes it.

## The USB console and Bluetooth

- **USB.** The board's J-Link appears as a serial port (COM) once SEGGER's J-Link software is installed, which
  installs its driver (the same one `nrfutil` uses). The console's USB page then finds it; with more than one J-Link
  the app asks which one.
- **Bluetooth.** It needs Windows 10 version 1709 or later and a Bluetooth 4.0 (LE) adapter; most laptops have one.
  When the app pairs with a board, Windows asks the app, and the app shows a box for the passkey. Type the six digits
  the console shows at the top of its Bluetooth page. Windows keeps the pairing, under Settings > Bluetooth & devices.
- **Signing in.** The refresh token is sealed with Windows' DPAPI, for this Windows user only, and kept an hour, as
  [docs/desktop-app.md](desktop-app.md#signing-in) says. Windows Hello is not used: Electron cannot reach it.

## Building it

On Windows, with Node.js 22 or newer:

```sh
cd apps/desktop
npm ci
npm run dist -- windows       # or --example for the example configuration
```

That makes `dist/Cranium-Setup-<version>.exe` and `dist/Cranium-<version>-portable.exe`, and `dist/win-unpacked/`
with `Cranium.exe` itself. The settings are
[`electron-builder.windows.yml`](../apps/desktop/electron-builder.windows.yml), over the base file:

- the version, in `extraMetadata.version`, with its entry in
  [`CHANGELOG.windows.md`](../apps/desktop/CHANGELOG.windows.md);
- the icon, from `resources/icon.png`;
- the installer's desktop shortcut question and its removal, in
  [`resources/installer.nsh`](../apps/desktop/resources/installer.nsh).

**In CI**, the [Desktop app for Windows](../.github/workflows/desktop-windows.yml) workflow runs on every push that
touches the app, on `windows-latest`:

- it runs the tests and starts the app once from the checkout;
- it builds both files with the example configuration;
- it checks that the program is `Cranium.exe` and says so in its details;
- it installs it silently, finds it and its Start menu entry, and uninstalls it;
- it keeps both files and their `SHA256SUMS` as the run's artifact `cranium-desktop-windows-<version>-example`, for
  14 days.

Those builds sign nobody in. A release is a tag `desktop-windows-v<version>`
([docs/desktop-app.md](desktop-app.md#releases)).

arm64 is not built: one installer for both would be twice the size, over the 100 MB GitHub takes in git, and a second
installer needs a second build. Windows 11 on Arm runs the x64 one.

## What has been tried, and what has not

CI builds, installs and uninstalls the installer on Windows Server, and the app draws its first page there. Not
tried yet:

- the installer by hand, with its desktop shortcut question;
- SmartScreen's warning on a PC;
- signing in;
- the USB console over a J-Link;
- Bluetooth to a board, with the passkey box.
