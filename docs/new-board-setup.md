# Setting up a blank board

How to take an nRF7002 DK from nothing to a board that runs our firmware, has the golden image as its way back,
and shows up online in the console. It takes about 20 minutes. The iPhone and Android apps come after it, in
[The phone apps](#the-phone-apps). An nRF5340 DK, which has Bluetooth and no Wi-Fi, differs in places:
[An nRF5340 DK](#an-nrf5340-dk).

**Only for a blank board, or one you mean to wipe.** Step 3 erases the whole chip, including TF-M storage, where a
board keeps its ID, Wi-Fi network, private key and certificates. Never run it on a working board: to update one,
use the console or `scripts/firmware/ota.sh`.

## The quick way

One command takes a board from out of the box to online on the console, and checks each step as it goes. On
macOS or Linux, from the repository:

```sh
scripts/board/new-board.sh check     # what this computer still needs, and the command that gets each thing
scripts/board/new-board.sh           # set up the one board plugged in by USB
```

It finds the boards plugged in, and goes on only if there is exactly one, or `--serial-number <n>` names one.
It says which DK it is, from its debugger (an nRF7002 DK, or an nRF5340 DK with `--board nrf5340dk` where the
debugger doesn't say; [An nRF5340 DK](#an-nrf5340-dk) has what differs for it), and asks for the last 4 digits of
its serial number before it erases anything. Then:

| Step | What it does | By hand |
| --- | --- | --- |
| `build` | `scripts/firmware/build.sh --keep --no-upload`. It leaves `binaries/` as it was | [2](#2-build) |
| `flash` | `west flash --recover` on that board's probe: erases it, and writes the bootloader, TF-M with the application and the Bluetooth controller | [3](#3-flash-everything-erasing-the-chip) |
| `golden` | `tools/golden.py restore`, then you do the gesture, and it watches the bootloader's log for `sealed`. Not on an nRF5340 DK | [4](#4-put-the-golden-image-on-and-seal-it) |
| `release` | The newest release for the board's type, through serial recovery: the console's, with a console token, or else the newest in `binaries/`, or `--image <file>` | [6](#6-update-it-to-the-current-firmware), over USB |
| `provision` | `tools/provision_device.py`, with `--board nrf5340dk` for that board | [5](#5-provision-it) |
| `verify` | The board's serial console, and the console's view: online with that release (nRF7002 DK), or listed and advertising over Bluetooth once you hold Button 1 (nRF5340 DK) | [7](#7-check-it) |

The release goes on over USB before provisioning, where the steps by hand provision the golden image and update it
over the air: the same board at the end, sooner, and with no Button 1 to press.

- A step that fails stops it, says why, and says how to go on: `scripts/board/new-board.sh --from <step>`, or `--resume`
  for the step after the last one done. `--only <step>` runs one step.
- `--dry-run` prints every command, and runs none of them.
- `scripts/board/new-board.sh status` shows a board at any time: what its serial console says, and what the console
  shows of it. `scripts/board/new-board.sh list` lists the boards plugged in.
- It needs what [What you need](#what-you-need) lists, which `check` goes through, and a console token
  ([`scripts/README.md`](../scripts/README.md#otash-with-an-api-token)) for the newest release and for the console's
  view. An nRF5340 DK needs one for its passkey; while the console has no route for that, add `--no-register`, as
  `provision_device.py` says. The script runs the tools with the SDK toolchain's Python, which has their packages;
  without it, `python3 -m pip install -r tools/requirements.txt`.
- It never makes a signing key, and never prints the Wi-Fi network, a password, the AWS account, an endpoint or a
  bucket.
- On Windows, run it in WSL2, set up as in [On Windows, use WSL2](#on-windows-use-wsl2), with the board attached to
  WSL. There is no PowerShell version: outside WSL the Python tools stop at registering the board and at the Wi-Fi
  network, and no bash script runs, so a PowerShell script would break in the same places.

**It has not run on a board yet.** Its tests (`firmware/tests/hil/test_new_board.py`) run it against stand-ins for
nrfutil, west, AWS, the console and the board's tools. Each step runs the commands below. If one fails, do that step
by hand, then go on with `--from` the next one.

## From the console: Board setup

A board that has this project's bootloader can be set up from the console instead, with no tools installed: open
**Developer → Board setup** in Chrome or Edge on a computer, the Windows or Linux desktop app or the Android app, and plug the board
in by USB. It is for release managers; a viewer sees why not. It is the quick way's `golden`, `release`, `provision`
and `verify`, as one stepper:

| Step | What the page does |
| --- | --- |
| Connect | Opens the board's console port (the one ending in 3 on a Mac, the higher `ttyACM` on Linux) and asks `STATUS`: its type, firmware, state (`FACTORY` or set up), and so whether its bootloader is this project's, which it is if it started this project's signed firmware. If only the bootloader answers, the next steps put firmware on. If nothing answers, it says the board is blank or that this is the other port |
| Golden image | Fetches `binaries/golden/cranium-1.5.0-0.signed.bin` from the console (`/golden/<file>`), checks its SHA-256 and hash against `firmware/golden.json`, and sends it through serial recovery as `tools/golden.py restore` does. It gets the board into the bootloader with `ENTER_BOOTLOADER`; if that misses, it says to hold Button 1 through a reset and try again. Then it shows the seal gesture, asks for the board's other port (the log port), and watches the bootloader's `golden:` lines for `sealed`, as `tools/new_board.py watch-seal` does. Without the log port, you can say it sealed by what you saw |
| Newest firmware | The console's newest active release for the board's type and flash layout, checked against its SHA-256, the same way. Passed by itself if the board runs it already |
| Set up | `INIT` with the ID you give (or its chip's identifier), the Wi-Fi network you type, `KEYGEN`, then the console's `POST /api/devices/register` with the request the board made, and the certificate, Amazon Root CA 1 and the cloud settings back onto the board, as `tools/provision_device.py` does |
| Online | Waits up to 3 minutes for the console to see the board online |

Each step says what it is doing and why it stopped, in words; **Try again** starts that step again, and **Skip: done
already** passes it. The golden image goes on before the newest release, because putting it back replaces the running
image. An nRF5340 DK has no golden image and no Wi-Fi: the page skips those steps and does `INIT` only; its passkey is
still `tools/provision_device.py --board nrf5340dk`.

The network's name and passphrase go to the board over the cable only. They are read from their fields when they are
sent, the passphrase's field is emptied, and neither goes to the server or is kept by the page.

What it can't do:

- **A blank board.** A new or erased chip has no bootloader, so serial recovery can't reach it. It needs the debug
  probe once: `scripts/board/new-board.sh` (or `west flash --recover`, step 3), and then the page can do the rest. The
  desktop app doesn't do this either: the console holds signed application images, not the bootloader, TF-M and
  network core image a blank chip needs, which come from a build.
- **Phones and Safari.** Web Serial exists only in Chrome and Edge on a computer and in the desktop app. The Android
  app has Board setup from 0.8.8, with the board on the phone's USB cable (USB OTG): the app gives the page its USB
  serial port ([docs/mobile-apps.md](mobile-apps.md#the-serial-pages)). The iPhone can't open a USB serial port at
  all, so the iPhone app has no Board setup and no Serial console.

**It has not run on a board yet.** Its tests (`cloud/web/test/setup.test.mjs`) run it against a stand-in board that
speaks the console and serial recovery, and a stand-in for the console's API.

### The Wi-Fi defaults

The Set up step's network fields start filled in with the console's Wi-Fi defaults, so that nobody types the lab's
network for every board. Change them for a board that joins another network; the passphrase stays masked. They come
from `GET /api/setup/wifi-defaults`, for release managers only: a viewer never gets them, an API token can't read them,
the answer is never cached, and each read is on the activity log as "read the Wi-Fi defaults", without the values. The
page puts them straight into the fields and keeps them nowhere else.

They live in AWS only, in the stack's secret `<stack>/wifi-defaults` (output `WifiDefaultsArn`), as JSON
`{ "ssid": "...", "passphrase": "...", "security": "WPA2_PSK" }`. Only the console's API function may read it. To set
them, write `~/.cranium/wifi_secrets.h` with `python tools/cranium_secrets.py wifi` and run `cloud/deploy.sh`, which stores it
the way it stores the Memfault token; a deployment from GitHub Actions takes the repository secret
`WIFI_DEFAULTS_JSON` (that JSON) instead, when it is set. Neither prints it. A network the firmware would refuse is not
stored. Without one the fields start empty, and the page says so. The GitHub deploy role needs the updated
`cloud/infra/github-deploy.yaml` once, to store this secret.

### Time-outs

All in `setup.js` `TIMING` and `recovery.js`, in milliseconds:

| What | How long | Why |
| --- | --- | --- |
| `handshake` | 2 000, twice | `ECHO|OFF` before every command, which turns the echo off after a restart |
| `COMMAND_MS` | 3 000 | A command with no wait of its own: `GET_ID`, `THING` |
| `status` | 8 000 | `STATUS` |
| `listening` | 3 000 | A bootloader that listens already (Button 1, or no image) |
| `restart` | 15 000 | From `ENTER_BOOTLOADER` to the bootloader's window, as `tools/recover.py` |
| `swap` | 150 000 | The same before the golden image: a swap being resumed took 81 s on the bench |
| `REPLY_MS` | 8 000 | One SMP request; an upload sends again up to `MAX_LOST` (3) times |
| `GREETING_EVERY_MS` | 100 | The SMP echo that catches the half-second window |
| `comeBack` | 120 000 | From the bootloader's restart to the firmware answering `STATUS` |
| `init` | 15 000 | `INIT` erases settings and restarts |
| `wifi` | 6 000 | `WIFI_SEC`, `STREAM_START`, `CLOUD`: each writes to flash |
| `keygen` | 15 000 | `KEYGEN` makes the key in the secure partition |
| `chunk` | 8 000 | One `STREAM_CHUNK` |
| `store` | 60 000 | A certificate's last `STREAM_CHUNK`: the board stores it on its main thread, which a running board shares with its cloud connection |
| `online` | 180 000, every `poll` (5 000) | The console seeing the board online |
| `seal` | 240 000 | Watching the log port for the seal's result |

Limits the page keeps to: a console line of at most 384 bytes (`CONSOLE_LINE_MAX`), recovery lines of at most 128
bytes with their newline (MCUboot's `CONFIG_BOOT_MAX_LINE_INPUT_LEN`), requests of at most 1024 bytes, 384 bytes of
image a request (`CHUNK`), and Web Serial opened with an 8 KiB buffer (its default of 255 bytes is less than `KEYGEN`
prints at once).

**The port.** Choose the console port: the one ending in 3 on a Mac, the higher `ttyACM` on Linux, the other COM port
on Windows. The desktop app names the two. A port that prints lines but answers neither the console nor the bootloader
is the log port, and the page says so.

### The self-check

**Self-check, no board** at the top of the page runs every step against a board simulated in the page: the firmware's
console, which refuses a line too long or with a control character, and MCUboot's serial recovery, which drops a line
or a request too large. It connects, puts the golden image on (fetched from the console, as for a real board) and
seals it by hand, puts a made-up release on, sets the board up with a made-up network and certificate, and waits for
it online, then says which steps passed. It changes nothing on the console: its register route, releases and board
list are simulated, and it never reads the Wi-Fi defaults. The same run is a test: `node --test` in `cloud/web`.

## What you need

| Thing | Why | Where it comes from |
| --- | --- | --- |
| nRF7002 DK and a USB cable | The board, and its debug port | The kit |
| nRF Connect SDK v3.4.0 and `nrfutil` | Building and flashing | nRF Connect for VS Code, or `nrfutil sdk-manager install v3.4.0`. On Linux and Windows, read [Install the tools](#install-the-tools) first |
| SEGGER's J-Link software | `nrfutil` flashes through the board's J-Link | [SEGGER's downloads](https://www.segger.com/downloads/jlink/) |
| Git, the AWS CLI v2, and Python 3.10 or later with `pyserial` and `cbor2` | The repository, AWS IoT, and the tools that talk to the board | [Install the tools](#install-the-tools) |
| A console token of a release manager, `~/.cranium/console-token` | Registering the board through the console, and the newest release | The console: Developer > API tokens. See [Who needs what](#who-needs-what) |
| The golden image, `binaries/golden/cranium-1.5.0-0.signed.bin` | The bootloader only restores that exact file | In git. A rebuild won't match it |
| The Wi-Fi network, `~/.cranium/wifi_secrets.h` | The board's network | `python tools/cranium_secrets.py wifi`, on your own computer. A phone hotspot's name often has a curly apostrophe: copy the exact spelling. Only on macOS does the tool offer the spelling the computer knows |
| Only without a console token: an AWS sign-in with administrator rights, and `cloud/.deploy/outputs.json` | Registering the board with the AWS CLI | `aws login --profile cranium --region us-east-1`; the file is written by `cloud/deploy.sh` on a laptop (a deployment from GitHub Actions keeps none): copy it from the owner |
| Only to build releases: the signing key, `~/.cranium/mcuboot_signing_key.pem` | Every image a board runs must be signed with it | Its custodian: see [`secrets/README.md`](../secrets/README.md). Setting up a board does without it |

### Who needs what

| | A teammate setting up boards | The owner, or whoever builds releases |
| --- | --- | --- |
| Console token | A release manager's, in `~/.cranium/console-token` (mode 600) or `CRANIUM_TOKEN` | The same |
| The console's address | `--console https://<the console>` to `scripts/board/new-board.sh` or `provision_device.py`, or `CRANIUM_CONSOLE_URL`, unless `cloud/.deploy/outputs.json` or `apps/config/cranium.json` has it | From `cloud/.deploy/outputs.json` |
| AWS account | None | An administrator's sign-in, to deploy the cloud; provisioning takes it where there is no token |
| Signing key | None: the build makes the bootloader with the team's public key, `firmware/keys/fw_signing_pub.pem` in git, and signs its own application with a throwaway key, which that bootloader refuses. The board gets the golden image from git and the console's newest release, both signed by the key's custodian | `~/.cranium/mcuboot_signing_key.pem`, to build releases |
| Golden image | In git | In git |
| Wi-Fi network | `~/.cranium/wifi_secrets.h` on their own computer (`python tools/cranium_secrets.py wifi`) | The same |

So a teammate runs `scripts/board/new-board.sh check`, then `scripts/board/new-board.sh`, with nothing of the owner's
but a console token. `check` says FAIL for AWS and `outputs.json` only when there is no release manager's token.

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
| nRF Connect SDK v3.4.0 | nRF Connect for VS Code, or `nrfutil sdk-manager install v3.4.0`. It goes in `/opt/nordic/ncs` | First `nrfutil sdk-manager config install-dir set /opt/nordic/ncs`, a folder you own, then install. `scripts/firmware/build.sh` looks only there, and Linux's default is `~/ncs` | In WSL, as Linux |
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
| Git Bash | `west`, and the tools that only read | `scripts/firmware/build.sh` looks for the SDK in `/opt/nordic/ncs`, which Git Bash doesn't have. `provision_device.py` stops at registering the board: it hands the AWS CLI a temporary file that Windows keeps locked. `cranium_secrets.py wifi` refuses to run. A token file can't pass the scripts' mode 600 check. The scripts call `python3`, which Windows may not have |
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

The second must pass: it checks that the golden file, `firmware/golden.json` and the bootloader's settings agree.
The first is for whoever has the signing key; without one, build as in step 2 with `--without-key`.

## 2. Build

```sh
scripts/firmware/build.sh --keep
```

This builds the bootloader, which holds the golden image's pin, and the application at the version in
`firmware/app/VERSION`. Each image is signed with your key.

Without the signing key, `scripts/firmware/build.sh --keep --no-upload --without-key`: the bootloader takes the team's
public key from `firmware/keys/fw_signing_pub.pem`, and the application is signed with a throwaway key, which that
bootloader refuses. After step 3 the board waits in serial recovery, with no application, until step 4 puts the golden
image on. Every build checks that its bootloader takes exactly the team's public key, and a build without the key
leaves `binaries/` as it was.

It looks for the SDK in `/opt/nordic/ncs/v3.4.0`, where it goes on macOS. On Linux and in WSL, install it there
([Install the tools](#install-the-tools)), or point `NCS_DIR` at it: `NCS_DIR=~/ncs/v3.4.0 scripts/firmware/build.sh`.
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
python tools/provision_device.py                 # through the console with a console token, or AWS where signed in
python tools/provision_device.py --via console   # through the console, always
```

This uses the board's serial console. It:

1. Sets the board's ID with `INIT`. The default is its chip's 16-digit identifier, or pass `--id <name>`.
2. Sends the Wi-Fi network from `~/.cranium/wifi_secrets.h`, with echo off, so the password never shows.
3. Has the board make its own key pair. The private key never leaves the board.
4. Registers the board in AWS IoT as `cranium-<its identifier>`, with a certificate for that key: through the console
   (below) with a console token, or with the AWS CLI where this computer is signed in to AWS and has
   `cloud/.deploy/outputs.json`. `--via console` or `--via aws` chooses; by default it takes AWS when signed in, and
   the console otherwise.
5. Loads the certificate, Amazon's root certificate, the AWS IoT endpoint and the download address onto the board.

It finishes by waiting for the board to reach AWS IoT. If the board was registered before and has been wiped, add
`--new-identity`, which retires its old certificate. With more than one board plugged in, name the port with `--port`.

### Provisioning through the console

`POST /api/devices/register` on the console's API, with a release manager's session (the console's pages), or
`POST /api/t/devices/register` with a console token (`Authorization: Bearer crn_...`), as `provision_device.py` sends
it. Console 2.6.1 and later.

Request:

```json
{ "id": "<board identifier>", "csr": "<PEM certificate signing request>", "reregister": false }
```

- `id`: the board's identifier, 16 lowercase hex digits; its thing is `cranium-<id>`. Nothing else is taken.
- `csr`: what the board printed for `KEYGEN`: an ECDSA P-256 key's request, signed by that key with SHA-256, for
  `CN=cranium-<id>`. The board's private key never leaves it, and is never sent.
- `reregister`: `false` (or left out) refuses a board whose thing has a certificate already, with 409
  `already_registered`. `true` registers it again, as for a board that was wiped, and retires its old certificates.
- An nRF5340 DK, which never reaches AWS by itself, sends `{ "id": "<id>", "board": "nrf5340dk" }` and no `csr`.

Answer, 200:

```json
{ "thing": "cranium-<id>", "certificatePem": "...", "rootCa": "...", "endpoint": "...", "downloadPrefix": "..." }
```

`certificatePem` is the board's certificate, issued by AWS IoT for the request's key and checked to be for it;
`rootCa` is Amazon Root CA 1; `endpoint` the AWS IoT data endpoint; `downloadPrefix` the one address the board may
download firmware from. They go onto the board as the tool loads them: `STREAM_START ... CERT`, `... CA`, then
`CLOUD|<endpoint>|<downloadPrefix>`. An nRF5340 DK's answer is `{ "thing": "cranium-<id>" }`.

Errors have the API's usual shape, `{ "error": { "code", "message", "requestId" } }`: 400 `invalid_id`,
`invalid_csr`, `csr_mismatch` (the request is for another board), `invalid_reregister`, `invalid_board` or
`unexpected_field`; 403 for anyone but a release manager, and for the apps' sign-in (the desktop app's, and the phone apps') older than
15 minutes (`phone_sign_in_again`); 409 `already_registered` or
`board_mismatch` (the thing is another board type's); 429 `rate_limited` after 20 in an hour by one person; 502
`certificate_mismatch` if AWS IoT ever issued a certificate for another key, which is then retired and not handed out.

Each registration is on record in the activity log as `device.register`. The console's API role may do only this in
AWS IoT: create and update things named `cranium-*`, put them in the stack's device group, have a certificate issued
from a request, attach and detach certificates and the device policy, make old ones inactive and delete them, and read
the endpoint.

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
| The build stops about the signing key | To set up a board, you need none: `scripts/firmware/build.sh --keep --no-upload --without-key`, which `new-board.sh` runs for you. To build releases, get the team key; don't generate a new one, or no existing board will accept your images |
| `golden.py check` fails | Your golden file isn't the frozen one: `git checkout -- binaries/golden` |
| Provisioning says the board was registered before | It was wiped since. Run it again with `--new-identity`, which retires the old certificate |
| The gesture gives three slow blinks and `refused` | Neither copy is the pinned golden image. Run step 4's `restore` again |
| Provisioning can't find the network | Usually the hotspot isn't on, or its name differs by a character. Keep the phone on the hotspot screen, and check the name with `python tools/cranium_secrets.py wifi` |
| Provisioning fails at AWS | Your AWS sign-in has expired, or isn't an administrator's. Run `aws login` again, or provision through the console: `--via console` with a console token |
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

## An nRF5340 DK

The nRF5340 DK has no Wi-Fi chip. It runs a build with Bluetooth only, never reaches AWS by itself, and updates from a
phone or over USB: [`firmware/README.md`](../firmware/README.md#the-nrf5340-dk-bluetooth-only) has all of it. **Nobody
has set one up yet**: these steps come from the build and the host tests, not from a board. What differs from the steps
above:

| Step | On an nRF5340 DK |
| --- | --- |
| What you need | No Wi-Fi secrets and no golden image. A release manager's console token (`CRANIUM_TOKEN` or `~/.cranium/console-token`), which registers it through the console and gets its passkey; or the AWS sign-in and `cloud/.deploy/outputs.json` as above, with the token for its passkey |
| 1. Check the key | `python tools/keys.py check` only. There is no golden image for this board, so skip `golden.py check` |
| 2. Build | `scripts/firmware/build.sh --board nrf5340dk --keep --no-upload`. It builds in `build-nrf5340dk/` and leaves `binaries/cranium-nrf5340dk-<version>-0.signed.bin` |
| 3. Flash, erasing the chip | `west flash -d build-nrf5340dk --recover`, by the DK's USB port (J2). It writes the bootloader, TF-M with the application, and the Bluetooth controller on the network core, the one part that only USB can ever change. LED1 then flashes long every 2 seconds: factory mode |
| 4. Golden image | Skip it. This board's bootloader is built without one, and the nRF7002 DK's 1.5.0 is not for it. The gesture does nothing here |
| 5. Provision | `python tools/provision_device.py --board nrf5340dk`: `INIT`, a thing in AWS IoT with `board=nrf5340dk` and no certificate, and the board's own Bluetooth passkey, registered with the console before it is stored on the board. The console has no route for that yet: until it has, add `--no-register`, and the board shows a new passkey on its serial console for each pairing |
| 6. Update it | From a phone, over Bluetooth: hold Button 1 for 5 s, pair, send the release. The console never sends it a job. After the restart, once the new image has run 60 s, hold Button 1 again and pair: the phone reads the image list and the board keeps the image. Without that it goes back after 5 minutes |
| 7. Check it | `STATUS` says `board nrf5340dk`, `layout 1` and `bt passkey set`. The console shows it as Bluetooth only, with what a phone last saw of it, once a phone has updated it |

| What you see | What to do |
| --- | --- |
| `provision_device.py` says the board is a `nrf7002dk` | It runs the nRF7002 DK's firmware: build and flash the nRF5340 DK's, step 2 and 3 |
| `the console does not take a board's passkey yet` | As above: `--no-register` for now |
| LED4 stays lit after pairings, and `STATUS` says `bt passkey locked` | Three pairings failed on its passkey. `python tools/provision_device.py --board nrf5340dk --new-passkey` |
| A Bluetooth upload says `incompatible_board` | The release is an nRF7002 DK's. Send the nRF5340 DK's release |
| `WIFI`, `CLOUD` or `KEYGEN` says `not on this board` | As it should: this board has none of them |

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
scripts/firmware/build.sh --keep --no-upload
scripts/board/flash-netcore.sh --serial-number <probe>
```

It writes only the network core: the board's ID, Wi-Fi network, key, certificates and golden image stay.

One update over Bluetooth has gone through end to end with a board: 1.11.3 to 1.11.4, from an iPhone with
nRF Connect Device Manager ([test results](test-results.md#the-first-update-over-bluetooth-1113-to-1114)).
Our own apps haven't been used for one yet. More in
[`firmware/README.md`](../firmware/README.md#firmware-update-over-bluetooth) and each app's README.

More detail: [`firmware/README.md`](../firmware/README.md) for the firmware, the golden image and the serial console,
[`docs/aws-iot.md`](aws-iot.md) for the board's identity in AWS, and [`apps/ios/README.md`](../apps/ios/README.md) and
[`apps/android/README.md`](../apps/android/README.md) for the apps.
