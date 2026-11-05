# Setting up a blank board

How to take an nRF7002 DK from nothing to a board that runs our firmware, has the golden image as its way back,
and shows up online in the console. It takes about 20 minutes. The iPhone and Android apps come after it, in
[The phone apps](#the-phone-apps).

**Only for a blank board, or one you mean to wipe.** Step 3 erases the whole chip, including TF-M storage, where a
board keeps its ID, Wi-Fi network, private key and certificates. Never run it on a working board: to update one,
use the console or `scripts/ota.sh`.

## What you need

| Thing | Why | Where it comes from |
| --- | --- | --- |
| nRF7002 DK and a USB cable | The board, and its debug port | The kit |
| nRF Connect SDK v3.4.0 and `nrfutil` | Building and flashing | nRF Connect for VS Code, or `nrfutil sdk-manager install v3.4.0`. On Linux and Windows, read [Install the tools](#install-the-tools) first |
| SEGGER's J-Link software | `nrfutil` flashes through the board's J-Link | [SEGGER's downloads](https://www.segger.com/downloads/jlink/) |
| Git, the AWS CLI v2, and Python 3.10 or later with `pyserial` and `cbor2` | The repository, AWS IoT, and the tools that talk to the board | [Install the tools](#install-the-tools) |
| The signing key, `~/.cranium/mcuboot_signing_key.pem` | Every image must be signed with it, or the bootloader won't run it | Whoever holds the team key: see [`secrets/README.md`](../secrets/README.md). `python tools/keys.py check` confirms you have the right one |
| The golden image, `binaries/golden/cranium-1.5.0-0.signed.bin` | The bootloader only restores that exact file | Copy it from whoever holds the signing key. It isn't in git, and a rebuild won't match it |
| The Wi-Fi network, `~/.cranium/wifi_secrets.h` | The board's network | `python tools/secrets.py wifi`. A phone hotspot's name often has a curly apostrophe: copy the exact spelling. Only on macOS does the tool offer the spelling the computer knows |
| An AWS sign-in with administrator rights | Registering the board in AWS IoT | `aws login --profile cranium --region us-east-1` |
| `cloud/.deploy/outputs.json` | The AWS IoT endpoint, and where firmware downloads from | Written by `cloud/deploy.sh`. Copy it from whoever deployed |

Run the Python tools from an [nRF Connect SDK terminal](#an-nrf-connect-sdk-terminal), which has `pyserial` and
`cbor2`. Where `python` isn't found, type `python3`. Close any serial terminal on the board first: only one program can
use a port at a time.

Find your debug probe's serial number with `nrfutil device list`. The commands below call it `<probe>`. The tools have a
default, which is our bench's probe, and it fails on any other.

## Windows, Linux and macOS

We have only run all of this on macOS. The Windows and Linux lines follow the tools' own documentation, and haven't
been run end to end by us yet.

### Install the tools

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Shell | Terminal | Any terminal with bash | WSL2 with Ubuntu: see [On Windows, use WSL2](#on-windows-use-wsl2). Everything below then runs in it, as on Linux |
| Git | `xcode-select --install`, or Homebrew's `git` | Your distribution's `git` | In WSL, Ubuntu's `git` |
| `nrfutil` | Nordic's [nRF Util](https://www.nordicsemi.com/Products/Development-tools/nRF-Util), then `nrfutil install device sdk-manager` | The same | In WSL, the Linux one |
| nRF Connect SDK v3.4.0 | nRF Connect for VS Code, or `nrfutil sdk-manager install v3.4.0`. It goes in `/opt/nordic/ncs` | First `nrfutil sdk-manager config install-dir set /opt/nordic/ncs`, a folder you own, then install. `scripts/build.sh` looks only there, and Linux's default is `~/ncs` | In WSL, as Linux |
| J-Link | SEGGER's J-Link Software and Documentation Pack | SEGGER's `.deb` or `.rpm`; Nordic's [nrf-udev](https://github.com/NordicSemiconductor/nrf-udev) rules, which also keep ModemManager off the board's ports; and `sudo usermod -aG dialout $USER` (and `plugdev`, where your distribution's rules use it), then sign out and in | SEGGER's pack for Windows, which has the USB driver. In WSL, the Linux pack and rules as well |
| AWS CLI v2 | AWS's installer. `aws login` needs a recent version | AWS's installer for Linux | In WSL, the Linux one. If no browser opens, `aws login --remote` |
| Python 3.10 or later, with `pyserial` and `cbor2` | The nRF Connect SDK terminal's Python has them, and `cryptography`, which `keys.py` needs | The same. Otherwise `pip install pyserial cbor2 cryptography`, in a virtual environment | In WSL, as Linux |

The scripts look for `nrfutil` at `~/.nrfutil/bin/nrfutil`. If yours is elsewhere,
`export NRFUTIL="$(command -v nrfutil)"`. `tools/recover.py` and `golden.py restore --reset` run the `nrfutil` on your `PATH`.

### On Windows, use WSL2

Run everything in WSL2, Windows' own Linux, and hand the board's USB to it with
[usbipd-win](https://github.com/dorssel/usbipd-win). The other two shells each break somewhere:

| Shell | What works | What breaks |
| --- | --- | --- |
| **WSL2, with usbipd-win** | Everything, as on Linux | Setting up USB once, and attaching the board each time it is plugged in. While WSL has the board, Windows programs can't use it |
| Git Bash | `west`, and the tools that only read | `scripts/build.sh` looks for the SDK in `/opt/nordic/ncs`, which Git Bash doesn't have. `provision_device.py` stops at registering the board: it hands the AWS CLI a temporary file that Windows keeps locked. `secrets.py wifi` refuses to run. A token file can't pass the scripts' mode 600 check. The scripts call `python3`, which Windows may not have |
| nRF Connect terminal (cmd or PowerShell) | `west build`, `west flash`, and the tools that only read | No bash script runs at all, and the Python tools break as under Git Bash |

Once, in PowerShell as administrator:

```powershell
wsl --install                                          # Ubuntu; restart when it asks
winget install --interactive --exact dorssel.usbipd-win
```

Then, with the board plugged in, in PowerShell (`bind` as administrator, once per board):

```powershell
usbipd list                                            # the J-Link's BUSID, such as 2-3
usbipd bind --busid <busid>
usbipd attach --wsl --busid <busid> --auto-attach      # leave it running
```

In WSL, `ls /dev/ttyACM*` then shows the board's two ports. Set WSL up as Linux, in the table above. Keep the repository
and `~/.cranium` in WSL's own home, not under `/mnt/c`: there, builds are slow and `chmod` doesn't hold. Microsoft's
[USB in WSL](https://learn.microsoft.com/windows/wsl/connect-usb) has more.

### An nRF Connect SDK terminal

`west` and the Python tools need the SDK's toolchain on the `PATH`. The scripts load it by themselves.

| | How |
| --- | --- |
| macOS | nRF Connect for VS Code's terminal, or `nrfutil sdk-manager toolchain launch --ncs-version v3.4.0 --shell` |
| Linux, WSL | `nrfutil sdk-manager toolchain launch --ncs-version v3.4.0 --shell` |
| Windows, outside WSL | nRF Connect for VS Code's terminal, or `nrfutil sdk-manager toolchain launch --ncs-version v3.4.0 --terminal` |

`launch` doesn't set `ZEPHYR_BASE`, and `west flash` run from the repository needs it to find the SDK:
`export ZEPHYR_BASE=/opt/nordic/ncs/v3.4.0/zephyr`.

### Serial ports

The board's J-Link shows two serial ports. The first, VCOM0, carries TF-M's log. The second, VCOM1, is the
application's console, and the tools use it. They take the last of the J-Link's ports by themselves; `--port` names it
instead, for `provision_device.py`, `recover.py` and `golden.py restore`.

| | The two ports | The console |
| --- | --- | --- |
| macOS | `/dev/cu.usbmodem<probe>1` and `/dev/cu.usbmodem<probe>3` | The one ending in 3 |
| Linux, WSL | `/dev/ttyACM0` and `/dev/ttyACM1`, or higher numbers if another device came first | The higher of the two. `ls -l /dev/serial/by-id/` names both after the probe |
| Windows, outside WSL | Two `COM` ports, "JLink CDC UART Port" in Device Manager | Name it with `--port`: the tools sort names as text, so `COM10` comes before `COM9` |

The wrong port doesn't answer. `python tools/provision_device.py --status --port <port>` shows the board's state on the
right one.

### Your secrets folder

`~/.cranium` holds the signing key, the Wi-Fi network, an API token, and the apps' keys. Keep the folder mode 700 and
each file in it mode 600. The tools set that when they write a file, and the scripts refuse a token file that others
can read.

| | Where | Notes |
| --- | --- | --- |
| macOS, Linux | `~/.cranium` | |
| WSL | `~/.cranium`, in WSL's own home | Not the Windows one. Copy the files in, then `chmod 700 ~/.cranium` and `chmod 600` each file |
| Windows, outside WSL | `%USERPROFILE%\.cranium` | The firmware build finds it through `HOME`: set `HOME` to `%USERPROFILE%` (Git Bash does already). There is no mode 600, so use `CRANIUM_TOKEN` in place of a token file, and write `wifi_secrets.h` by hand from `secrets/wifi_secrets.h.example` |

### Line endings

The repository has no `.gitattributes`. Git for Windows turns line endings into CRLF on checkout by default, and bash
then fails on the scripts with `$'\r': command not found`. Clone without that:

```sh
git clone -c core.autocrlf=false https://github.com/ese5180/f26-t07-the-cranium.git
```

Git on macOS, on Linux and in WSL changes nothing. `README.md` and `apps/android/gradlew.bat` are stored with CRLF
already; leave them. Zephyr can't build from a path with spaces, so keep the clone's path free of them.

## 1. Check the key and the golden image

```sh
python tools/keys.py check
python tools/golden.py check
```

Both must pass. The second checks that the golden file, `firmware/golden.json` and the bootloader's settings agree.

## 2. Build

```sh
scripts/build.sh --keep
```

This builds the bootloader, which holds the golden image's pin, and the application at the version in
`firmware/app/VERSION`. Each image is signed with your key.

It looks for the SDK in `/opt/nordic/ncs/v3.4.0`, where it goes on macOS. On Linux and in WSL, install it there
([Install the tools](#install-the-tools)), or point `NCS_DIR` at it: `NCS_DIR=~/ncs/v3.4.0 scripts/build.sh`.
Otherwise it stops with `nRF Connect SDK v3.4.0 was not found`.

## 3. Flash everything, erasing the chip

From an [nRF Connect SDK terminal](#an-nrf-connect-sdk-terminal), in the repository:

```sh
west flash --recover
```

This erases both cores and writes the bootloader, TF-M with the application, and the network core's Bluetooth controller
(from 1.9.0; earlier builds put a blinky there). The board then
starts in **factory mode**: LED1 flashes long every 2 seconds, and its boot log says `State FACTORY`. That's expected.

## 4. Put the golden image on, and seal it

The golden copy goes into external flash, where the rescue button restores it from. First put 1.5.0 into the running slot,
which takes about 4 minutes:

```sh
python tools/golden.py restore --reset --serial-number <probe>
```

If it picks the wrong port, add `--port <port>`: see [Serial ports](#serial-ports).

Then seal it with the gesture:

1. Press and hold RESET.
2. Press and hold Button 2.
3. Let go of RESET.
4. Keep holding Button 2 for 5 seconds, until LED1 blinks fast.
5. Let go within the next 5 seconds.

LED1 stays on while it copies, for about 45 seconds. The boot log says `sealed`, and the board runs 1.5.0. Do the gesture
again: it should do nothing, with one slow blink. That shows the copy is good.

**Only do this gesture on a board flashed with this bootloader.** On an older one, holding Button 2 while the application
starts is a factory reset.

## 5. Provision it

```sh
python tools/provision_device.py
```

This uses the board's serial console. It:

1. Sets the board's ID with `INIT`. The default is its chip's 16-digit identifier, or pass `--id <name>`.
2. Sends the Wi-Fi network from `~/.cranium/wifi_secrets.h`, with echo off, so the password never shows.
3. Has the board make its own key pair. The private key never leaves the board.
4. Registers the board in AWS IoT as `cranium-<its identifier>`, with a certificate for that key.
5. Loads the certificate, Amazon's root certificate, the AWS IoT endpoint and the download address onto the board.

It finishes by waiting for the board to reach AWS IoT. If the board was registered before and has been wiped, add
`--new-identity`, which retires its old certificate. With more than one board plugged in, name the port with `--port`.

## 6. Update it to the current firmware

Open the console at https://console.craniumiot.com. The board should be online, running 1.5.0. On **Firmware**, deploy the
newest release. **Golden 1.5.0 waits for Button 1, so press it once** when the page asks. From 1.7.2 on, updates start by
themselves.

## 7. Check it

| Check | How | Expect |
| --- | --- | --- |
| Online | Console, Overview | Online, with a recent heartbeat |
| Firmware | Overview, or `STATUS` on the serial console | The release you deployed, confirmed |
| Provisioned | `python tools/provision_device.py --status` | State `OPERATING`; ID, Wi-Fi and certificates set |
| Bootloader | `python tools/recover.py --reset list` | The running image in slot 0. Then `python tools/recover.py reset` boots it again |

## If something goes wrong

| What you see | What to do |
| --- | --- |
| The build stops about the signing key | You don't have `~/.cranium/mcuboot_signing_key.pem`. Get the team key; don't generate a new one, or no existing board will accept your images |
| `golden.py check` fails | Your golden file isn't the frozen one. Copy `binaries/golden/` from the key holder |
| The gesture gives three slow blinks and `refused` | Neither copy is the pinned golden image. Run step 4's `restore` again |
| Provisioning can't find the network | Usually the hotspot isn't on, or its name differs by a character. Keep the phone on the hotspot screen, and check the name with `python tools/secrets.py wifi` |
| Provisioning fails at AWS | Your AWS sign-in has expired, or isn't an administrator's. Run `aws login` again |
| The board is offline afterwards | Usually the hotspot: give it a few minutes. `python tools/provision_device.py --wifi` sends the network again |
| You need to start over | `west flash --recover` and begin at step 3. Provisioning again needs `--new-identity` |
| A script says `$'\r': command not found` | The checkout has CRLF line endings. Clone again as in [Line endings](#line-endings) |
| `build.sh` says the SDK was not found | On Linux or in WSL, the SDK is in `~/ncs` by default: set `NCS_DIR=~/ncs/v3.4.0`, or see [Install the tools](#install-the-tools) |
| `Permission denied` on `/dev/ttyACM1` | You aren't in `dialout` yet. Add yourself, then sign out and in |
| `no J-Link virtual COM port found` in WSL | The board isn't attached to WSL: `usbipd attach`, as in [On Windows, use WSL2](#on-windows-use-wsl2) |
| `the board on <port> does not answer` | It's restarting, or that's the log port. Try the other one with `--port` |

## Don't

- Don't run `west flash --recover`, `nrfutil device recover` or a full erase on a working board. They wipe its identity.
- Don't flash with `nrfutil device program` without `--options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE`. Its
  default erases TF-M storage.
- Don't hold Button 2 for 5 seconds while the board is running. That's a factory reset.
- Don't commit anything from `~/.cranium`, `cloud/.deploy` or `apps/config/cranium.json`, and don't publish an app
  built with it. They name the AWS account.

## The phone apps

The iPhone app and the Android app do what the console's website does, and also update a board over Bluetooth.
[`docs/mobile-apps.md`](mobile-apps.md) says what they do and how. You need the board only for Bluetooth.

**The short way:** [`apps/README.md`](../apps/README.md). The newest builds are in git, in `apps/dist/`, and one command
puts the app on a phone: `apps/install.sh android` or `apps/install.sh iphone` (macOS, Linux), or
`apps\install.ps1` (Windows, Android). `apps/install.sh check` says what this computer is missing.

**Start on the console's Apps page** (Apps, in the masthead, once you can sign in): it has the team's Android app to
download, with a QR code for the phone to scan, the iPhone app's version, and the configuration to download for a build
of your own. What follows is the same, with the details.

### An account

Each person needs a console account. An administrator makes it, signed in to AWS as for step 5 (`cloud/users.sh` is a
bash script: on Windows, run it in WSL):

```sh
AWS_PROFILE=cranium cloud/users.sh add <email> release-manager    # or: viewer
```

| Role | Can |
| --- | --- |
| `viewer` | See everything. Change nothing |
| `release-manager` | Also upload, revoke and deploy firmware, and cancel deployments. In the apps, the serial console and updates over Bluetooth |

Cognito e-mails the person a temporary password, good for 3 days; `cloud/users.sh resend <email>` sends a new one. The
first sign-in sets a new password, of at least 12 characters, and an authenticator app. The apps don't do those steps
on their own screen: they send them to the AWS sign-in page. After that, a sign-in is the e-mail address, the password,
then the six-digit code. A lost phone or password: `cloud/users.sh reset-mfa <email>`. A change made from a phone
needs a sign-in in the last 15 minutes, and the app asks again when it is older.

### The configuration

Both apps read `apps/config/cranium.json` when they are built. `apps/configure.sh` writes it from
`cloud/.deploy/outputs.json`, which comes from whoever deployed:

```sh
apps/configure.sh
```

It names the AWS account, so git ignores it. Without `outputs.json`, sign in to the console and use **Download the
configuration** on its Apps page, and put `cranium.json` in `apps/config/`. Without it, a build uses
`apps/config/cranium.example.json`, whose values are made up, and can't sign in: an iPhone Debug build shows an orange
banner, an iPhone Release build stops, and the Android build warns. On Windows, run `configure.sh` in WSL, or in Git
Bash if `python3` works there, use the Apps page, or copy `cranium.json` from a teammate.

### iPhone

**It takes a Mac.** Building and installing an iPhone app needs Xcode, and Xcode runs only on macOS. There is no route
from Windows or Linux. Without a Mac of your own:

- borrow one, and use your own Apple ID on it, or
- have a teammate with a Mac install it on your iPhone with their own free team. It counts as one of their 3 devices,
  and they renew it every 7 days, with your iPhone on their cable or their Wi-Fi.

Once, on the Mac and the iPhone:

1. Xcode 16 or later, from the App Store, selected with
   `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`. Then `brew install xcodegen`.
2. Your Apple ID in Xcode: Xcode > Settings > Accounts > + > Apple ID. That makes a free Personal Team.
3. On the iPhone: Settings > Privacy & Security > Developer Mode, on. It restarts.

Then:

```sh
apps/configure.sh
apps/ios/scripts/phone.sh
```

`phone.sh` checks Xcode and the configuration, keeps your team's ID in `~/.cranium/apple-team-id`, makes the project
and opens it in Xcode. Then:

1. Plug the iPhone into the Mac, and tap Trust on it.
2. At the top of Xcode, choose the iPhone.
3. Under the Cranium target's Signing & Capabilities, the team should be your Personal Team.
4. Press Run. The first time, on the iPhone: Settings > General > VPN & Device Management > your Apple ID > Trust. Then
   open the app, and allow Bluetooth when it asks.

**Every 7 days.** An app from a free team stops opening 7 days after Xcode made its profile. Press Run again, or let
the Mac renew it:

```sh
apps/ios/scripts/renew.sh --schedule      # every hour; renews when 36 hours or less are left
apps/ios/scripts/renew.sh --status        # when it stops opening, and whether the iPhone is in reach
apps/ios/scripts/renew.sh --unschedule    # stop
```

To renew over Wi-Fi, tick "Connect via network" for the iPhone in Xcode > Window > Devices and Simulators. The iPhone
must be on the Mac's network and unlocked once since it restarted, and the Mac awake.

**A second person.** A bundle ID belongs to one team. If Xcode says `com.craniumiot.cranium` is taken, put another, such
as `com.<yourname>.cranium`, in `~/.cranium/apple-bundle-id`, and run `phone.sh` again.

TestFlight needs the paid Apple Developer Program: `apps/ios/scripts/testflight.sh`, in
[`apps/ios/README.md`](../apps/ios/README.md).

### Android

Android 8.0 or later, with Bluetooth LE. It works from Windows, Linux or macOS, in one of two ways.

**A. The team's signed APK.** Download it from the console's Apps page: on the phone, signed in to the console, tap
**Download**; or on the computer press **Show a QR code for a phone** and scan it with the phone's camera, which
downloads it without signing in, for 15 minutes. Whoever holds the release key, in `~/.cranium/android`, builds it with
`apps/android/build-release.sh`, which writes `apps/dist/cranium-android-<version>.apk` and publishes it there with an
API token. Only that person: on a computer without the key, the script makes a new one, and its APKs can't update the
team's. It is never put in a public release.

On the phone, open the APK from Files or the browser, and allow "Install unknown apps" for that app when Android asks.
Or, with USB debugging on (Settings > About phone, tap Build number seven times, then Developer options):

```sh
adb install -r cranium-android-<version>.apk
```

**B. Build it yourself.** As above, only macOS has been run.

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| JDK 17 | `brew install openjdk@17` | Your distribution's, such as `openjdk-17-jdk` | Any JDK 17. Set `JAVA_HOME` |
| Android SDK | Android Studio (`~/Library/Android/sdk`), or the command-line tools as in [`apps/android/README.md`](../apps/android/README.md) | Android Studio (`~/Android/Sdk`), or Google's command-line tools | Android Studio (`%LOCALAPPDATA%\Android\Sdk`), or Google's command-line tools |
| `adb` | The SDK's `platform-tools` | The same. If `adb devices` says `no permissions`, your distribution's Android udev rules (`android-sdk-platform-tools-common` on Debian and Ubuntu) | The same. Some phones need their maker's USB driver |

The SDK needs `platform-tools`, `platforms;android-37.0` and `build-tools;36.0.0`. Tell the build where it is with
`ANDROID_HOME`, or with `sdk.dir` in `apps/android/local.properties`, which Android Studio writes when it opens
`apps/android`. Then:

```sh
apps/configure.sh
cd apps/android
./gradlew assembleDebug                      # Windows, in cmd or PowerShell: gradlew.bat assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
./gradlew --stop
```

A debug build is signed with your computer's own debug key, not the team's. Android won't put it over the team's APK,
or over another computer's debug build, and `adb install` fails. Uninstall first, which deletes the app's sign-in and
the firmware it kept: `adb uninstall com.craniumiot.cranium`. Going back to the team's APK takes the same.

**First use.** Android asks for Nearby devices the first time the app looks for a board; Android 11 and older ask for
location, which a Bluetooth scan needs there. The serial console (More, Serial console) needs a phone that can be a USB
host, and a USB OTG cable or adapter from the phone to the board's debug USB port, the one the computer uses. Android
asks to let the app use the board. An iPhone has no USB serial console.

### With the board

Updating a board over Bluetooth, as a release manager:

1. At the board, hold **Button 1** for 5 s and let go. LED1 flashes four times: Bluetooth is open for 3 minutes (2
   before firmware 1.11.2).
2. In the app, pick the release, then the board: `Cranium-` and four hex digits.
3. Type the 6-digit passkey the app shows into the phone's pairing prompt. A board that is offline has it only on its
   serial console, `[BT] passkey`.
4. When the app has sent it, press **Button 1** on the board within 2 minutes to install it. **Button 2** throws it
   away.

This needs firmware 1.9.0 or later, and the Bluetooth controller (`hci_ipc`) on the board's network core. Step 3 puts
the controller there, so a board set up with this document has it. A board first flashed before 1.9.0 still has a
blinky there, and the controller can't go over the air. Holding Button 1 then says
`the network core does not run the Bluetooth controller` on the serial console. Put it on once, over USB, on the debug
port (J2), with any serial terminal closed:

```sh
scripts/build.sh --keep --no-upload
scripts/flash-netcore.sh --serial-number <probe>
```

It writes only the network core: the board's ID, Wi-Fi network, key, certificates and golden image stay.

One update over Bluetooth has gone through end to end with a board: 1.11.3 to 1.11.4, from an iPhone with
nRF Connect Device Manager ([test results](test-results.md#the-first-update-over-bluetooth-1113-to-1114)).
Our own apps haven't been used for one yet. More in
[`firmware/README.md`](../firmware/README.md#firmware-update-over-bluetooth) and each app's README.

More detail: [`firmware/README.md`](../firmware/README.md) for the firmware, the golden image and the serial console,
[`docs/aws-iot.md`](aws-iot.md) for the board's identity in AWS, and [`apps/ios/README.md`](../apps/ios/README.md) and
[`apps/android/README.md`](../apps/android/README.md) for the apps.
