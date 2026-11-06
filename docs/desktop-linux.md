# The desktop app on Linux

What is Linux's own about the desktop app; the rest is in [docs/desktop-app.md](desktop-app.md). x64, with a desktop
(X11 or Wayland), and BlueZ for Bluetooth.

## The files

| File | For | What it installs |
| --- | --- | --- |
| `cranium_<version>_amd64.deb` | Debian, Ubuntu, Mint, Pop!_OS | The app in `/opt/Cranium`, the command `cranium`, the menu entry with its icon, the J-Link's udev rule, and on Ubuntu 24.04 an AppArmor profile for the sandbox |
| `cranium-<version>.x86_64.rpm` | Fedora, openSUSE, RHEL | The same as the .deb |
| `Cranium-<version>.AppImage` | Any distribution | Nothing: one file that runs as it is. No menu entry, no udev rule |

None is signed; check them against `apps/dist/SHA256SUMS` with `sha256sum -c` if you like.

## Installing from the file

**The .deb** (the one to choose on Ubuntu):

```sh
sudo apt install ./cranium_<version>_amd64.deb
```

Then open **Cranium** from the applications menu, or run `cranium`. `sudo apt remove cranium` removes it. The sign-in
and the pages kept stay in `~/.config/Cranium`; delete that folder too to remove everything.

**The .rpm:** `sudo dnf install ./cranium-<version>.x86_64.rpm` (on openSUSE, `sudo zypper install`). Remove it with
`sudo dnf remove cranium`.

**The AppImage:**

```sh
chmod +x Cranium-<version>.AppImage
./Cranium-<version>.AppImage
```

It needs FUSE 2: on Ubuntu 22.04 and later, `sudo apt install libfuse2t64` (`libfuse2` before 24.04). It adds
nothing to the menu by itself. For the USB console, give yourself the serial port as below.

## The sandbox

Every page of the app runs in Chromium's sandbox, which needs one of two things from Linux:

- **User namespaces.** Most distributions allow them.
- **The setuid helper `chrome-sandbox`.** It must belong to root with mode 4755.

| | |
| --- | --- |
| **The .deb and the .rpm** | Their install script, electron-builder's own, makes `chrome-sandbox` setuid where user namespaces do not work. On Ubuntu 24.04 and later, where AppArmor allows user namespaces only to profiled programs, it installs and loads an AppArmor profile for `/opt/Cranium/cranium` (`/etc/apparmor.d/cranium`). Nothing to do |
| **The AppImage** | Its `chrome-sandbox` cannot be setuid, so it relies on user namespaces. On Ubuntu 23.10 and later AppArmor refuses those to an AppImage, and the app stops with *The SUID sandbox helper binary was found, but is not configured correctly*. Use the .deb there. Do not start it with `--no-sandbox`: that turns the protection off for every page |
| **From a checkout** (`npm start`) | Once: `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox` |

## The USB console

The console's USB page opens the board's J-Link serial port through Web Serial. On Linux, a serial port belongs to root
and the `dialout` group, so a person needs one of these:

- **The .deb or the .rpm** install `/usr/lib/udev/rules.d/70-cranium-jlink.rules`. It gives SEGGER's devices (USB
  vendor 1366) to whoever is logged in at the computer (`uaccess`), and reloads udev, so a J-Link already plugged in
  works at once. Nothing to do.
- **With the AppImage**, either install the rule yourself:

  ```sh
  sudo curl -o /etc/udev/rules.d/70-cranium-jlink.rules https://raw.githubusercontent.com/ese5180/f26-t07-the-cranium/main/apps/desktop/resources/linux/70-cranium-jlink.rules
  sudo udevadm control --reload-rules && sudo udevadm trigger
  ```

  or join the `dialout` group (Fedora: also `dialout`; Arch: `uucp`):
  `sudo usermod -aG dialout "$USER"`, then log out and in again.

SEGGER's own J-Link software installs a udev rule of its own too, which does the same.

## Bluetooth

Chromium has Web Bluetooth on Linux, through BlueZ (5.41 or later), but only when asked. So the Linux part of the app
(`src/platform/linux.mjs`) switches it on before Electron starts: `--enable-features=WebBluetooth` and
`--enable-experimental-web-platform-features`. Windows needs neither, and has neither.

When the app pairs with a board, BlueZ asks the app, and the app shows a box for the passkey. Type the six digits the
console shows at the top of its Bluetooth page. BlueZ keeps the pairing (`bluetoothctl devices Paired`).

**Signing in.** The refresh token is sealed with the desktop's keyring through Electron's `safeStorage`: GNOME Keyring
or KWallet, through the Secret Service. Without a keyring (a bare window manager), the app keeps it in memory only,
so each start asks to sign in again ([docs/desktop-app.md](desktop-app.md#signing-in)).

## Building it

On Linux, with Node.js 22 or newer, and `rpm` for the .rpm (Ubuntu: `sudo apt install rpm`):

```sh
cd apps/desktop
npm ci
npm run dist -- linux         # or --example for the example configuration
```

That makes the three files in `dist/`, and `dist/linux-unpacked/` with `cranium` itself. The settings are in
[`electron-builder.linux.yml`](../apps/desktop/electron-builder.linux.yml), over the base file:

- the version, with its entry in [`CHANGELOG.linux.md`](../apps/desktop/CHANGELOG.linux.md);
- the menu entry;
- the packages' names;
- the udev rule ([`resources/linux/70-cranium-jlink.rules`](../apps/desktop/resources/linux/70-cranium-jlink.rules));
- the packages' install script ([`resources/linux/after-install.tpl`](../apps/desktop/resources/linux/after-install.tpl)).

The install script is electron-builder's own, word for word, with the udev step after it. `test/linux.test.mjs` fails
when an upgrade of electron-builder changes its template, so the copy is brought up to date.

**In CI**, the [Desktop app for Linux](../.github/workflows/desktop-linux.yml) workflow runs on every push that touches
the app, on Ubuntu 24.04:

- it runs the tests and starts the app once from the checkout, under a virtual display;
- it builds the three files with the example configuration;
- it looks into them: the package names, the udev rule in both packages, the menu entry named Cranium with its icon;
- it installs the .deb, finds the command, the rule and the menu entry, and starts the installed app under its
  sandbox for 25 seconds;
- it removes the .deb and checks the rule went with it;
- it keeps the three files and their `SHA256SUMS` as the run's artifact `cranium-desktop-linux-<version>-example`, for
  14 days.

Those builds sign nobody in. A release is a tag `desktop-linux-v<version>`
([docs/desktop-app.md](desktop-app.md#releases)).

arm64 is not built: a Raspberry Pi or an Arm laptop would want it, but nothing here could try it.

## What has been tried, and what has not

CI builds the three files on Ubuntu 24.04 and looks into each. It installs the .deb, starts the installed app under its
sandbox, and removes it.

Not tried yet:

- the AppImage started, and the .rpm installed;
- a desktop session with a person at it;
- signing in;
- the USB console over a J-Link, with the udev rule;
- Bluetooth through BlueZ, with the passkey box.
