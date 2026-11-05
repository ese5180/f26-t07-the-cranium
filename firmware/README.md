# Firmware

Zephyr / nRF Connect SDK **v3.4.0** project for the nRF7002 DK
(`nrf7002dk/nrf5340/cpuapp/ns`), and for the nRF5340 DK (`nrf5340dk/nrf5340/cpuapp/ns`), which has Bluetooth and
no Wi-Fi: see [The nRF5340 DK (Bluetooth only)](#the-nrf5340-dk-bluetooth-only). One `west build` produces three images:

| Image | Runs on | Role |
| --- | --- | --- |
| `mcuboot` | application core, secure | Bootloader. Verifies the ECDSA P-256 signature of the application image on every boot, installs updates from the secondary slot in external flash, and puts the previous image back if a new one is not confirmed. |
| `app` | application core | Trusted Firmware-M in the secure domain plus the non-secure application. This is the security domain of the product. |
| `hci_ipc` | network core | The Bluetooth LE controller, for [firmware update over Bluetooth](#firmware-update-over-bluetooth), in every build from 1.9.0. Flashed over the debug port only. |
| `netcore_blinky` | network core | Only in a build with `no_bt_sysbuild.conf`, and in every build before 1.9.0: blinks LED2 once a second. No radio stack, no console, no keys. |

`app/` started as a copy of Nordic's `samples/net/aws_iot` from nRF Connect SDK v3.4.0;
files derived from it keep Nordic's copyright notice and licence identifier.

## Build

1. Install nRF Connect SDK v3.4.0 and its toolchain (nRF Connect for VS Code or
   `nrfutil sdk-manager install v3.4.0`). On Windows and Linux, see
   [`docs/new-board-setup.md`](../docs/new-board-setup.md#windows-linux-and-macos).
2. Create the firmware signing key with `python tools/keys.py generate`, or put the
   team key at `~/.cranium/mcuboot_signing_key.pem`
   (see [`secrets/README.md`](../secrets/README.md)). The build stops with an
   explanation if it is missing.
3. To make an image to install, run `scripts/build.sh` from any terminal. It takes the next unused version and leaves
   the signed image in `binaries/`. To build and flash by hand, from an nRF Connect SDK terminal:

   ```sh
   west build -b nrf7002dk/nrf5340/cpuapp/ns --sysbuild firmware/app
   west flash
   ```

   Use `west flash --recover` the first time a board is programmed with this project.
   It erases both cores, including anything stored by earlier firmware.

   The signed application image, the file the firmware console in the cloud takes, is
   `build/app/zephyr/zephyr.signed.bin`.
4. Provision the board (device ID, Wi-Fi network, device identity, cloud settings) with
   `python tools/provision_device.py`. For a blank board, follow [`docs/new-board-setup.md`](../docs/new-board-setup.md),
   which covers every step, including the golden image. [`docs/aws-iot.md`](../docs/aws-iot.md) lists
   what it needs and what it does.

Zephyr cannot build from a path that contains spaces. If your checkout is under such
a path, build through a symbolic link that has none.

## Layout

```
app/                     application-core image and the sysbuild configuration
  boards/                Kconfig and devicetree for the nRF7002 DK, and for the nRF5340 DK
  prj_bt_only.conf       the nRF5340 DK's configuration in place of prj.conf: no Wi-Fi, no cloud
  Kconfig.bt_only        the board type, the flash layout, and a board with Bluetooth only
  bt_only_check.py       after the link of such a board's image: nothing of the cloud is in it
  src/                   the application: Wi-Fi, AWS IoT, updates, the serial console
  no_bt_sysbuild.conf    a build without firmware update over Bluetooth, which is on from 1.9.0
  bt_ota_sysbuild.conf   the old switch that turned it on; it now changes nothing
  bt_ota.conf            what Bluetooth adds to the application
  sysbuild/hci_ipc.conf  what it sets for the Bluetooth controller on the network core
  sysbuild/mcuboot/      bootloader configuration
    golden/              the golden image's code, a module of the bootloader
  VERSION                firmware version; also the version written into the signed image
netcore/                 network-core image
certs/AmazonRootCA1.pem  root CA that tools/provision_device.py loads onto each board
keys/fw_signing_pub.pem  public half of the signing key
golden.json              the frozen golden image, firmware 1.5.0, written by tools/golden.py
tests/host/              host tests of the job parser, the version code, the console, Bluetooth updates,
                         and from 1.13.0 the console's commands and location by Wi-Fi
tests/hil/               hardware test benches, and tests of the tools that talk to a board
tests/fetch-sdk-files.sh the files of the SDK that those tests read, for running them without it
```

The host tests need no board. Run them from an nRF Connect SDK terminal, which
provides the cJSON and base64 source they use: `make -C firmware/tests/host`. `make -C
firmware/tests/host mutants` then shows that the tests of [the timers](#when-the-board-is-stuck)
notice when those are wrong. Then
`python3 firmware/tests/hil/test_board.py`, `python3 firmware/tests/hil/test_recover.py` and
`python3 firmware/tests/hil/test_golden.py` test the tools, the first of them against the
console's real code on a pseudo-terminal. The host tests compile the console's C files as they are, on a fake UART and a fake network
stack (`test_console.c`, `test_console_output.c`, `test_app.c`). What those fakes do is the
limit of what they show: what the real driver and the real Wi-Fi stack do is for
`tests/hil/console_bench.py` to find out.

Neither kind of test needs a full SDK. `firmware/tests/fetch-sdk-files.sh` fetches the few files of
it that they read, and [`docs/ci.md`](../docs/ci.md) shows how they run that way, as they do on
GitHub Actions.

## Memory map

Internal flash (1 MiB) and the 8 MiB external SPI flash:

| Region | Start | Size | Contents |
| --- | --- | --- | --- |
| `boot_partition` | `0x00000` | 64 KiB | MCUboot |
| `slot0_partition` | `0x10000` | 912 KiB | running image: TF-M (128 KiB) + application (784 KiB) |
| `tfm_storage_partition` | `0xf4000` | 48 KiB | TF-M internal trusted storage, NV counters, protected storage |
| `slot1_partition` (external flash) | `0x0` | 912 KiB | downloaded image waiting to be installed, then the previous image kept for revert |
| `golden_partition` (external flash, bootloader only) | `0x700000` | 912 KiB | the [golden image](#golden-image): the plain signed file, with no trailer |

RAM of the application core (512 KiB): TF-M has the first 48 KiB, and the non-secure application the next 396 KiB
from 1.14.0 (400 KiB before). Then come 64 bytes for Memfault's reboot reason (`MFLT_REBOOT`, `0x2006f000`), 3,968
for its coredump (`MFLT_COREDUMP`, `0x2006f040`), 64 left unused, and the 64 KiB the two cores share, from
`0x20070000`. See [Memfault](#memfault).

## Serial console

The board is set up and debugged from a plain serial monitor, one command per line, on the
J-Link's second virtual COM port (`uart0`, 115200 baud). No host application is needed.
`tools/board.py` talks to it for the other tools. The console is a development and
provisioning feature: a release build turns it off with `-Dapp_CONFIG_APP_CONSOLE=n`, and
then no serial command exists at all, `BUTTON` included. Log messages then go nowhere. Such
an image keeps a log backend that throws them away (`src/log_discard.c`), because Zephyr's log
thread halts the board if there is none, with no output and before the watchdog is armed. The
link fails if an image ever has none. A GitHub Release is not such a build yet: it has the console
in it, as [`docs/ci.md`](../docs/ci.md#how-a-real-release-is-made) says.

Commands look like `COMMAND|arg1|arg2`. Command names and keywords can be in any case, and
what a person chooses stays exactly as typed: [the table below](#what-the-case-of-a-word-means) says
which is which. CR, LF and CRLF each end a line. Blank lines and leading whitespace are
ignored, backspace and DEL work, and typed characters are echoed unless `ECHO|OFF` was
sent. The last argument can contain `|`. A line over 384 bytes is discarded whole, and so is
one that lost bytes on the way in or holds a control character: it gets one `ERR`, and the
next line runs as usual. Whatever is sent while the board boots is thrown away.

Every command ends with one final line, `OK [details]` or `ERR <reason>`, and any other
lines of its reply come before that. Lines that start with a `[TAG]` are not replies: logs
such as `[ota] Image verified` or `[ota] WRN: ...`, and events such as
`[WIFI] connected ip=192.168.1.42 rssi=-51`. A boot starts with a status box whose lines
all start with `[BOOT]`.

| Command | | What it does |
| --- | --- | --- |
| `HELP` or `?` | * | a table of the commands, grouped, with the firmware version: see below |
| `INIT\|<id>` | * | first-time setup: erase everything, store the ID, restart (see below) |
| `GET_ID` | * | `OK <id>\|<firmware version>`, with an empty ID if there is none |
| `THING` | * | `OK <thing name>`: the board's name in AWS IoT, from its SoC |
| `ECHO\|<ON or OFF>` | * | send typed characters back, or not; on again after a restart |
| `REBOOT` | * | restart |
| `ENTER_BOOTLOADER` | * | restart, for `tools/recover.py --console` to catch the bootloader |
| `SET_ID\|<id>` | | change the ID and keep everything else |
| `RESET_CONFIG` | | clear the cloud settings only; keep the ID, Wi-Fi, certificates and key |
| `FACTORY_RESET` | | erase everything, also the ID, and restart in factory mode |
| `WIFI\|<ssid>\|<password>` | | save a WPA2 network and start joining it |
| `WIFI_SEC\|<ssid>\|<WPA2_PSK or WPA2_PSK_SHA256 or WPA3_SAE>\|<password>` | | the same, with the security mode named |
| `CLEAR_WIFI` | | erase the network and disconnect |
| `NET` | | connection state, SSID, IP, RSSI and MAC |
| `CLOUD\|<endpoint>\|<download-url-prefix>` | | save where the board connects and downloads from; `CLOUD\|` clears them |
| `KEYGEN` or `KEYGEN\|REPLACE` | | create the device key inside TF-M and print a signing request, never the key |
| `MQTT` | | the MQTT connection: its state, server, port, client ID, counts since boot, last error, and topics: see [MQTT](#mqtt) |
| `MQTT_HOST\|<endpoint>` | | change the AWS IoT endpoint only, keep the download prefix, and reconnect if there is a connection |
| `MQTT_RECONNECT` | | drop the MQTT connection and connect again now, with the back-off from the start |
| `STATS` | | a box with state, ID, firmware, Wi-Fi, uptime, free heap and last reset reason |
| `STATUS` or `STATUS\|<section>` | | the configuration: `device`, `wifi`, `cloud`, `certs` or `update`. `device` also has `stuck count` (see [When the board is stuck](#when-the-board-is-stuck)), and `cloud` has `mqtt`, the state that `MQTT` starts with |
| `STREAM_START\|<total_bytes>\|<chunk_count>\|<crc16_hex>\|<CA or CERT>` | | start loading a certificate, at most 1800 bytes of DER |
| `STREAM_CHUNK\|<index>\|<base64>` | | the next piece of it |
| `STREAM_STATUS`, `STREAM_CANCEL` | | how far it is; give up on it |
| `BUTTON\|<1 or 2>` | | a short press of a button, by the path of the real one, for a test bench |
| `TEST_WIFI_DEAD` | | only in a test image built with `APP_TEST_FAULT_WIFI_DEAD`, and every other image answers `ERR unknown command`: stops the Wi-Fi chip's power, once, until a restart. Refused during an update or a trial, and on an image with no trailer |

Only the commands marked * work in factory mode. `HELP` comes from the same table as the commands
themselves, and within 80 columns. A row that is too long for its column goes on under it, and a line
breaks after a blank or a `|`. Its lines start with the mark, a blank or a `+`, so nothing in it can be
taken for a final line or a `[TAG]`:

```text
Cranium console, firmware 1.7.1+0
Send COMMAND|arg|arg, one per line. Names and keywords work in any case;
IDs, network names, passwords, URLs and data stay exactly as typed.
* also works in factory mode. The rest needs INIT first.
  COMMAND           ARGUMENTS                WHAT IT DOES
+-- Device --------------------------------------------------------------------+
* HELP or ?                                  list the commands
* INIT              <id>                     first-time setup: erase everything,
                                             store the id, restart
* GET_ID                                     reply with <id>|<firmware version>
* THING                                      reply with the AWS IoT thing name
* ECHO              <ON or OFF>              send typed characters back, or not
* REBOOT                                     restart
* ENTER_BOOTLOADER                           restart; catch the bootloader with
                                             tools/recover.py --console
  SET_ID            <id>                     change the id, keep everything else
  RESET_CONFIG                               clear the cloud settings only; keep
                                             id, wifi, certificates, key
  FACTORY_RESET                              erase everything, also the id, and
                                             restart in factory mode
+-- Wi-Fi ---------------------------------------------------------------------+
  WIFI              <ssid>|<password>        save a WPA2 network and join it
  WIFI_SEC          <ssid>|<WPA2_PSK or      the same, with the security mode
                    WPA2_PSK_SHA256 or       named
                    WPA3_SAE>|<password>
  CLEAR_WIFI                                 erase the network and disconnect
  NET                                        show connection state, ssid, ip,
                                             rssi and mac
+-- Cloud ---------------------------------------------------------------------+
  CLOUD             <endpoint>|              save the AWS IoT endpoint and the
                    <download-url-prefix>    download prefix; empty clears
  KEYGEN            [REPLACE]                create the device key, print a
                                             signing request
  MQTT                                       show the MQTT connection: state,
                                             server, counts, topics
  MQTT_HOST         <endpoint>               change only the AWS IoT endpoint,
                                             and reconnect to it
  MQTT_RECONNECT                             drop the MQTT connection and
                                             connect again now
+-- Status --------------------------------------------------------------------+
  STATS                                      show state, id, firmware, wifi,
                                             uptime, memory, last reset
  STATUS            [<device or wifi or      print the configuration, or one
                    cloud or certs or        section of it
                    update>]
+-- Loading a certificate -----------------------------------------------------+
  STREAM_START      <total_bytes>|           start loading a certificate
                    <chunk_count>|
                    <crc16_hex>|<CA or
                    CERT>
  STREAM_CHUNK      <index>|<base64>         the next piece of it
  STREAM_STATUS                              show how far it is
  STREAM_CANCEL                              give up on it
+-- Test bench ----------------------------------------------------------------+
  BUTTON            <1 or 2>                 act as if the button was pressed
+------------------------------------------------------------------------------+
OK
```

### What the case of a word means

A word from the console's own table can be in any case. What a person chooses stays exactly as typed:

| Command | Any case | Exactly as typed |
| --- | --- | --- |
| The name of every command | `HELP`, `help`, `Help`, and `?` | |
| `ECHO` | `ON`, `OFF` | |
| `STATUS` | `device`, `wifi`, `cloud`, `certs`, `update` | |
| `WIFI` | | the SSID, the password |
| `WIFI_SEC` | `WPA2_PSK`, `WPA2_PSK_SHA256`, `WPA3_SAE` | the SSID, the password |
| `INIT`, `SET_ID` | | the ID |
| `CLOUD` | | the endpoint, the download prefix, also its `https://` |
| `MQTT_HOST` | | the endpoint |
| `KEYGEN` | `REPLACE` | |
| `STREAM_START` | `CA`, `CERT`, and the letters of the CRC, which is a number | |
| `STREAM_CHUNK` | | the base64 |
| `BUTTON` | it takes `1` or `2`, which have no case | |

The refusals do not depend on the case either: `factory_reset` is refused during an update as
`FACTORY_RESET` is, and a word that is not on the list stays wrong in any case. The console page in
`cloud/web` goes by the same rules: `init` and `factory_reset` need their forms there however they are
typed, and `echo|on` is refused like `ECHO|ON`.

The rules that apply to values:

* The ID is 1-32 letters or digits. It is a name for people, and it is not the cloud
  identity: the AWS IoT thing name stays `cranium-<SoC id>`, which is the certificate's
  subject and the MQTT client ID, and `SET_ID` cannot change it.
* An SSID is 1-32 bytes, and a password 8-63 characters. Anything else gets an `ERR`, and
  nothing is ever cut short. An SSID with a `|` in it is not supported.
* An empty password would mean an open network, and open networks are not allowed:
  `ERR open networks are not allowed`.
* Passwords and keys never appear in replies or logs, only as `set` or `unset`, and the
  line buffer is wiped after every command. An unknown command is shown only as far as its
  first `|` or blank. What is typed comes back while echo is on, which is why the tools turn
  it off. Nothing can read a stored secret back out.
* A stream's chunks must arrive in order, and a wrong index aborts it, also one that is no
  number. Nothing is stored
  before its CRC-16/CCITT-FALSE has been checked, and it is given up on after 30 quiet
  seconds.
* While an update is in progress or a new image is on trial, whatever could lose the
  trial's record or take the board off the network is refused with
  `ERR update in progress`: `FACTORY_RESET`, `RESET_CONFIG`, `INIT`, `SET_ID`, `CLEAR_WIFI`,
  and also `WIFI`, `WIFI_SEC`, `CLOUD`, `MQTT_HOST`, `MQTT_RECONNECT`, `KEYGEN` and
  `STREAM_START`. `MQTT` and the other commands that only read work as ever. Creating a key takes
  seconds, and an update can begin meanwhile: the old key is only given up afterwards, on the
  main loop, if none has.

Joining a network does not block anything. `WIFI` replies as soon as the network is saved,
and the result follows as `[WIFI] connected ip=... rssi=...` or
`[WIFI] failed reason=...`, for example `wrong password` or `network not found`. The board
tries again every 30 seconds, and joins the stored network at every boot. It counts as
connected once it has an IPv4 address, which is what the cloud is reached over: an IPv6
address, which can arrive seconds earlier on a network that offers one, is not enough.

A board that restarts itself for being stuck says why first, `[STUCK] restarting
reason=wifi_silent count=1`, and its next boot logs what its record holds, `[stuck] WRN: Restarted
earlier for being stuck: reason=wifi_silent count=1`. The reason is `wifi_silent`, `no_cloud` or
`update_stall`. [When the board is stuck](#when-the-board-is-stuck) says what they mean. The count
stops at 4, which then means 4 or more, and the record is not written from there on. So from a count
of 4 the boot line gives the last reason that was written, which can differ from the line before the
restart. The same goes for a restart whose write failed.

The console runs as a low-priority task. It reads and changes what the main loop owns by
having the main loop do it (`console_port_on_main()`), so everything there still happens
one event at a time. What cannot harm an update it does itself: reading atomics, the device
ID and the credential stores, asking the Wi-Fi stack for its status, and creating a key in
TF-M. Output goes through one ring buffer, whole lines only, and is sent by interrupt. The
console task waits for room, so a reply is never lost. Other threads do not, so a log line
that does not fit is dropped and counted (`[CONSOLE] WRN: 3 lines dropped`). The watchdog
stays with the main loop, which keeps running whatever the console does.

### MQTT

`MQTT` says how the connection to AWS IoT stands, from what `src/cloud.c` has counted since the
board started. Nothing in it is secret: the endpoint is in `STATUS` as well. On a board that has been
connected for a minute:

```text
state          connected
endpoint       example-ats.iot.us-east-1.amazonaws.com
port           8883
client id      cranium-fe5b26c0c5b1dcd7
keep alive     120 s
tls sec tag    201
connected for  65 s
attempts       3
connects       2
disconnects    1
errors         1
last error     -11 (connect), 35 s ago
published      42
received       7
last publish   5 s ago
last receive   1 s ago
subscribed     $aws/things/cranium-fe5b26c0c5b1dcd7/jobs/notify-next
subscribed     $aws/things/cranium-fe5b26c0c5b1dcd7/jobs/$next/get/accepted
subscribed     $aws/things/cranium-fe5b26c0c5b1dcd7/jobs/$next/get/rejected
subscribed     $aws/things/cranium-fe5b26c0c5b1dcd7/jobs/+/update/accepted
subscribed     $aws/things/cranium-fe5b26c0c5b1dcd7/jobs/+/update/rejected
subscribed     cranium/cranium-fe5b26c0c5b1dcd7/commands
OK
```

* `state` is `connected`, `connecting` (an attempt is running, for at most 30 s), `waiting to retry in
  N s` (30 s after a failure, doubling up to 300 s), `no network` or `no cloud settings`. `waiting to
  retry` with no time is the second before the main loop schedules the next attempt. `STATUS|cloud`
  has the same words as `mqtt`. `connected for` is there only while it is connected.
* Only the endpoint can be changed while the board runs. The port and the keep-alive are built in
  (`CONFIG_MQTT_HELPER_PORT`, `CONFIG_MQTT_KEEPALIVE`), because the AWS IoT library takes nothing else
  at run time. The client ID is the thing name, and cannot be changed: the board's policy in AWS IoT
  allows no other. The root CA, the certificate and the key are under the TLS sec tag 201, and
  `STATUS|certs` says which are there.
* `attempts`, `connects`, `disconnects` and `errors` count since the boot. A connection counts once the
  broker has acknowledged every subscription.
* `last error` is a number, where it came from, and when. `(connect)` is what the attempt returned:
  -11 is no answer within 30 s, other negative numbers are errnos (-116 timed out, -111 refused, -118 no
  route to the host), and 2 or 3 is a host name that DNS does not know or did not answer for.
  `(library)` is the library closing a connection: 5 is the broker's "not authorized", which a
  certificate that AWS IoT does not know, or a policy that does not fit, gets. 1 to 4 are the other
  refusals of MQTT's CONNACK, and 0 a message too large for the board's buffer.
* `published` counts what the library took to send, `received` what arrived on a subscription.
* The topics are the jobs topics that the board subscribes to at every connection, and from 1.13.0
  [its commands topic](#commands), last, unless the board has [given up on it](#the-device-policy-for-commands-and-location)
  until a restart. The library adds no shadow topic of its own: the board only publishes to its shadow
  and never subscribes to it. From 1.12.0 it also publishes [its events](#events-to-the-console) to
  `cranium/<thing name>/events`, and from 1.13.0 [its location](#location-by-wi-fi) to
  `cranium/<thing name>/location`, which are not listed: nothing comes back on them.

`MQTT_HOST|<endpoint>` changes the endpoint and keeps the download prefix, which `CLOUD` would ask
for again. The endpoint has to be a host name, as for `CLOUD`: at most 127 letters, digits, dots and
hyphens. It is stored at once, and a connection or an attempt that is there is replaced, so that the
board reconnects to the new one right away (`OK mqtt server set to <endpoint>, reconnecting`).
Otherwise the next attempt uses it, 3 seconds later if there is a network. Without cloud settings
there is no prefix to keep, and it says to use `CLOUD`.

`MQTT_RECONNECT` drops the connection and connects again now, with the back-off from the start. An
attempt that is running is let finish first: if it comes up, it is closed at once and made again.
Without a network or cloud settings it says so and does nothing. Both are refused during an update
or a trial, like `CLOUD`, and the main loop ignores a request that an update overtook on its way.

The serial console page in `cloud/web` has an MQTT panel for the three: Check MQTT shows this reply
as a list, Set server checks the host name on the page and sends `MQTT_HOST` only once it has been
confirmed there, and Reconnect sends `MQTT_RECONNECT`.

## Factory mode

A board boots into factory mode if its init-complete flag is missing or its stored ID is
not valid. The event loop, the watchdog and LED1 keep running, the board stays off the
network, and everything but the commands marked * above replies
`ERR factory mode, send INIT|<id> first`.

`INIT|<id>` checks the ID before touching anything, erases all persistent settings, writes
the ID, reads it back, writes the flag last, and restarts. If a step fails, the reply names
it and the board stays up. A power cut anywhere before the flag leaves the board in factory
mode. The same goes for a power cut during a factory reset: its first write marks the flag
as being erased. That mark stays if an erase fails, by `FACTORY_RESET` or by Button 2, so the
board comes back in factory mode with whatever is left, and `INIT` erases again.

A board that was provisioned by firmware from before this flag (it has cloud settings, a
private key and a certificate, but no flag) does not end up in factory mode, because an
update on trial could then never confirm itself. It gets the 16 hexadecimal digits of its
SoC's identifier as its ID, logs `[CONSOLE] migrated: ...` and boots normally. A provisioned
board whose flag or ID cannot be read, because storage failed, runs normally too, and writes
nothing: one failed read must not take it off the network.

## Tools

| Tool | What it is for |
| --- | --- |
| `tools/board.py` | Talking to the console, for the tools below. It can also read the status of, and press a button on, firmware from before the console, which has a Zephyr shell there, so that an update from it can be followed. |
| `tools/provision_device.py` | Provision a board, unattended if the Wi-Fi secrets file is unlocked. A board in factory mode gets `INIT` first, with `--id` or else its SoC's identifier. |
| `tools/recover.py` | Install an image through the bootloader's serial recovery. MCUboot listens for half a second after every reset, and it is not updated over the air, so there is no other way in: `--console` sends `ENTER_BOOTLOADER` and catches that half second, with no debugger. |
| `tests/hil/ota_bench.py` | Hardware tests of firmware updates, and with `chip-dead` and `chip-dead-cloud` of [what restarts a stuck board](#when-the-board-is-stuck). With no serial port and no probe it follows the board through the job and the shadow alone, as [Tests with no cable](#tests-with-no-cable) says. Its waits, and those of `console_bench.py`, stop about 190 s after the driver starts saying that the Wi-Fi chip has stopped answering, if its lines keep coming and the board has not restarted. That says that the bench stopped waiting, and the result gives the stuck count and the update state: correct firmware can take longer than that. No network name and nothing that names the AWS account goes into their `results.jsonl`. |
| `tests/hil/console_bench.py` | Hardware tests of this console. `console_bench.py plan` shows what it would do, and which steps erase the board. It runs nothing until told to with `run --no-erase` or `run --erase`. It checks first that it could provision the board again, does so after erasing it, and keeps a note of whatever is not undone yet, so that `console_bench.py restore` can put it right after an interrupted run. |
| `tools/golden.py` | Freeze the [golden image](#golden-image), record what qualified it, check that the manifest, the bootloader's configuration and the file agree, and send it through serial recovery. |
| `tests/hil/golden_bench.py` | Hardware tests of the golden image, with no Wi-Fi but for G15 and G16. `golden_bench.py plan` lists them and touches nothing, and `golden_bench.py images` builds the fault images they upload. |
| `tests/hil/build_image.sh` | Build a signed test image from a scratch copy, for example with `-Dapp_CONFIG_APP_TEST_FAULT_INIT_POWER_LOSS=y`, the image that loses power in the middle of `INIT`. |
| `tests/hil/fault_check.py` | Check built images, reading files only: those a release could come from have none of `APP_TEST_FAULT_WIFI_DEAD` in their configuration or their bytes, the fault image has all of it, and all of them have the same network event queue. |
| `tests/host/mutate_join.py` | The same for the order of a join in `src/join_policy.c`, with `tests/host/mutate_stuck.py` as its engine. |
| `tests/host/mutate_net.py` | The same for the lines of `src/net.c` that tell that policy what the stack has said. |
| `tests/host/mutate_stuck.py` | Change the policy in `src/stuck_policy.c` in small ways, one at a time, and check that its tests notice each one. It needs a C compiler and no board, and touches no file in the tree. |

## What the LEDs show

* **LED1** is driven by the application core and shows its state:
  * a long flash (half a second) every two seconds: factory mode, waiting for `INIT`
  * a short flash every two seconds: set up, but not provisioned yet
  * slow blink: joining Wi-Fi
  * medium blink: connecting to AWS IoT
  * LED1 and LED2 taking turns, a quarter of a second each: connected, nothing to do. Before 1.8.0,
    LED1 was steady here
  * fast blink: an update is waiting for a button press, which only firmware before 1.7.2 and a build
    with `CONFIG_APP_OTA_REQUIRE_USER_CONSENT` do
  * double flash: downloading or checking an update
  * triple flash: a new image is running on trial
* **LED2**, from 1.8.0, is driven by the application too. It lights only when connected, taking turns
  with LED1, and is dark in every other state. Before 1.8.0 the application handed it to the network
  core, which blinks it once a second whatever the application is doing. The network core still runs
  that blink, but it no longer has the pin, so it doesn't show.
* In a build for [firmware update over Bluetooth](#firmware-update-over-bluetooth), LED1 also shows
  four short flashes while Bluetooth is open.
* From 1.13.0, the console's [identify command](#commands) blinks **LED1 and LED2 together** at 5 Hz,
  a tenth of a second on and a tenth off, for as long as it asks (15 s unless it says otherwise), and
  nothing else does that. Then they show the board's state again, as it is by then.
* LED1 and LED2 are the only LEDs wired to the nRF5340. No firmware here can change the board's
  other LEDs.

## Buttons

* From firmware 1.7.2 on, no button has anything to do with an update over the air: one that a
  release manager deploys starts as soon as the board sees it, and a press does nothing to it. Firmware
  before that, the golden image 1.5.0 among it, and a build with `CONFIG_APP_OTA_REQUIRE_USER_CONSENT`
  wait: there **Button 1** installs an update that is on offer, and **Button 2** declines it.
* Holding **Button 2** for five seconds and releasing it erases everything provisioned
  onto the board (device ID, Wi-Fi network, cloud settings, device key and certificates)
  and restarts it in factory mode, like `FACTORY_RESET`. It does nothing while an update
  is offered or under way.
* In a build for [firmware update over Bluetooth](#firmware-update-over-bluetooth), holding
  **Button 1** for five seconds and letting go opens Bluetooth for three minutes, unless the build has
  offers and an update is on offer. Then it is what it always was. `BUTTON|1` on the console opens nothing.
* A button that was already down when the application started does nothing when it is let
  go: only a press that was seen counts. So holding Button 2 through a boot, for the
  [golden image](#golden-image) for example, can never turn into that factory reset.

## When an update fails

The measurements named in this table are from the older shell firmware, but for the golden image's:
[the test results](../docs/test-results.md) say which firmware each came from.

| Failure | What happens |
| --- | --- |
| Invalid signature, or signed with another key | MCUboot verifies every image with this project's public key before swapping and on every boot. An image that fails is never started; the board keeps running the current firmware and reports the update as failed (`not_installed`). The server also refuses to accept such a file. |
| Older firmware (rollback) | The console refuses a release that is not newer than every earlier one. The application refuses a job that is not newer than what it runs. MCUboot compares versions before a test or permanent swap, which is what an update asks for, and refuses a lower one. A revert skips that comparison, so code running in the application could forge a revert to an older signed image: see [What this does not protect against](#what-this-does-not-protect-against-1). That comes from reading MCUboot's source and has not been run. The bench tested the application's check. No run reached MCUboot's check, because the application refuses first. Serial recovery has no version check: see below. A golden image restore has none either, on purpose. |
| Corrupted or incomplete download | The application compares the SHA-256 of what is in the secondary slot with the digest in the job and checks that the signed header carries the announced version. On a mismatch the image is erased and nothing is installed. A failed download is retried with a fresh link, up to five attempts in all. |
| Reset or power loss during the download | The running image is not touched. After the restart the board reports the job as `interrupted`. Measured with a reset through the reset pin, not with a power cut. |
| An update that stops moving | From firmware 1.7.0, 10 minutes with no progress restart the board, with nothing installed: see [When the board is stuck](#when-the-board-is-stuck). The cloud then gets `interrupted`, as above. This has only run on a host. |
| Faulty code with a valid signature | The new image runs on trial. It must join Wi-Fi and reach AWS IoT within 5 minutes to confirm itself; a 120-second hardware watchdog covers a hang. Without the confirmation the next reset makes MCUboot swap the previous image back, and the board reports the rollback. |
| Power loss during the swap | MCUboot's swap-using-move continues the swap on the next boot. Measured with a reset through the reset pin, not with a power cut. |
| Update cancelled | The board asks AWS IoT before the download and again before installing. A cancelled job is dropped. A cancel during the download leaves the partial image in the secondary slot, where no swap is requested and the next download overwrites it. A cancel after the download erases the image. |
| No update can reach the board, or no valid image is left | Serial recovery, below. |
| A bad image, and a person at the board with nothing else | The golden image. The person holds Button 2 through a reset ([the gesture](#the-gesture)). MCUboot checks the copy in external flash for a good signature and for the digest pinned in the bootloader, and copies it to the primary slot. It needs no laptop, Wi-Fi or cloud. Measured on firmware 1.5.0 with the debug port holding the button: restored in 62 to 64 s, gesture included. A person did it from power-off too, in G5e. A damaged copy, or any other signed image, is refused. Nothing starts it by itself, so a bad image on an unattended board stays bad. |

## When the board is stuck

The Wi-Fi chip hung once on firmware 1.5.0. The driver logged `hal_rpu_ready_wait` and `Timeout waiting
to get free cmd buff from RPU` about every 2 s, scans failed, and the firmware said `[WIFI] failed
reason=no answer` every 30 s. The console kept answering and the main loop kept feeding the watchdog,
so nothing restarted the board, and a restart by hand cleared it. Its cause is not known.

From firmware 1.7.0 the board restarts itself for that, and for two things like it. **The frozen 1.5.0
does not have any of this, and neither does 1.6.0.** A board on the golden image that hangs this way
stays that way until somebody restarts it: `REBOOT` on the console, the reset button or the power.

| Timer | Limit | What it counts |
| --- | --- | --- |
| `wifi_silent` | 120 s | With the link down and a network stored, the time since the Wi-Fi stack last reported the result of a join, of any kind. `network not found` only comes after a scan that finished, so a missing hotspot starts this over every time and never restarts the board. A refused request is no answer, and neither is the console's `no answer`, which is what no result looks like. |
| `no_cloud` | 15 minutes | Link-up time with no cloud connection. It adds up over short drops of the link, so that a link that flaps cannot hold it off. It starts over with a connection to the cloud, when somebody stores a network or cloud settings, and when the link has been gone for 5 minutes without a break, since what comes back then is a new link. This is for a chip that hangs while associated, where no disconnect event may ever come, and for what wedges on this side: a TLS heap that ran out, a connect that does not return. A hotspot with no internet and an outage of AWS look the same from here. A restart does not help with those, which is what the back-off is for. |
| `update_stall` | 600 s | An update in `RETRY_WAIT`, `REFRESHING`, `STARTING`, `DOWNLOADING`, `COMMITTING` or `REBOOTING` that has not moved. Moving is any event from the downloader, a download starting, the image being found good, or the cloud agreeing to install it. So a slow download goes on as long as it keeps moving, and an update with the network gone for over 10 minutes now fails, where it used to wait. A downloader that reports errors counts as moving too, but its attempts are limited, so that has an end as well. |

**Silence is not proof of a hung chip, in either direction.** The Wi-Fi stack reports a result for a network
that is not found, for a four-way handshake that fails, for a disconnect during a join and for a join that
completes. An access point that can be seen and refuses the join mostly gets none: a wrong WPA3 password, which
fails before any handshake, a hotspot that is full or filters addresses, or one at the edge of range. The
console then says `no answer`, and a healthy chip gets restarted at 120 s and then at the pace of the back-off.
The board was offline anyway, so nothing is lost but time, and the count stays until something answers, so a
real hang after that also starts from the back-off. Counting a finished scan as an answer as well would spare
such a board. It has not been done.

The other way round, the supplicant gives up on a stored connect by itself after about 31 s, with a result that
takes only the supplicant and not the chip. `net_tick()` asks again at 30 s and starts that clock over, as long
as asking takes under about 2 s. A hung chip that makes it take longer could keep `wifi_silent` from firing. No
such result came in the hang that was seen, where the console only said `no answer`. All of this comes from
reading the supplicant's source and has not been run on a board.

`update_stall` restarts and does not cancel, because `fota_download_cancel()` can spin on a downloader
that is wedged. Nothing has been asked of the bootloader in those states. Of a cloud update, only
`install_download()` asks for a swap, and it restarts in the same call. The only other code that asks is
`install_image()` in a Bluetooth build, which runs with a Bluetooth window open, and that holds every timer.
So nothing gets installed. If the cloud has the job in progress, the board closes it as `interrupted` after
the restart, and one that is still queued starts again, or is offered again where a build has offers. `OTA_VERIFYING` is not in the list because it
starts and ends within one event of the main loop, so no timer ever sees it.

**What stands in the way.** No timer restarts a board in factory mode, with no network stored, or that
is not provisioned, which here means cloud settings, a device key and a certificate. None does while
an image is on trial, because the trial's own deadline ends that, or while a Bluetooth window is open,
which keeps Bluetooth usable on a board whose Wi-Fi is dead. `wifi_silent` and `no_cloud` also stand
aside unless the update state is idle or, in a build that has offers, an offer is waiting, since every other update state has a
limit of its own. A timer that stood aside starts from nothing, so no restart comes the moment something
ends. The one exception is `no_cloud` past its limit under the back-off, with a link that drops for less
than 5 minutes: that link has had its time, and the restart comes when it returns. Using the console holds
nothing off. A test bench polls it, which would hold a restart
off for as long as the bench waits for one, and a restart in the middle of a stream only means that the
stream is sent again.

**The back-off, for `wifi_silent` and `no_cloud`.** A count of restarts in a row and the last reason stay
in TF-M storage (`STORE_STUCK`), and the next restart needs this much uptime first:

| Count | Least uptime |
| --- | --- |
| 0 | none: the timer alone |
| 1 | 5 minutes |
| 2 | 30 minutes |
| 3 | 2 hours |
| 4 or more | 6 hours |

So a dead chip restarts after about 2 minutes, 5 minutes, 30 minutes and 2 hours, and then about four
times a day. The count clears after 30 minutes of uptime in which the stack has answered or the cloud
has connected, as long as no timer is past its limit at that moment. Without that last part, a chip
that hangs soon after each boot, or a hotspot with no internet, would have its count cleared by the very
wait that was to slow it down. A factory reset erases it.

The count is not written once it has reached 4, so a chip that hangs soon after each boot writes the record
four times and then leaves the flash alone. That limit holds only for such a chip. One that hangs more than
about 30 minutes after each boot, say while associated at 20 minutes, has its count cleared each time, so it
never backs off. It restarts about every 30 to 40 minutes, with one write and one erase of the record each
time, which is 70 to 90 operations a day on TF-M's 8 KB storage for as long as that fault lasts. That is
counted from the policy and not measured.

A record that is missing, unreadable or makes no sense counts as 0, so it can never hold a restart off. `update_stall` does not use the count: it only records its reason. It needs a job under way. A job
that the cloud agreed to start ends at the next restart, as `interrupted`. One that it never agreed to is still queued and starts
again by itself, so this comes round every 10 minutes for as long as the cloud goes on listing that job and not
agreeing. That is the cloud's fault and not the board's, and it has not been seen. Resets by the watchdog are not
counted. Firmware older than 1.7.0 leaves the record alone, also in a factory reset, and does not read it.

**How it restarts.** On the main loop and nowhere else, never inside a network management callback or a
console command. It prints the `[STUCK]` line, writes the record, flushes the log and does a cold
`sys_reboot()`, which is how the trial ends as well. The record's write failing does not stop that.
Nothing else is touched first, because it may be what is stuck.

**A chip that does not come up.** The main loop no longer waits for the Wi-Fi stack at boot. Until the
supplicant is ready, conn_mgr's thread holds two locks and waits for it with no limit, and a call that takes
one of those locks would stop the main thread with it. There would be no tick, no `[STUCK]` line and no
back-off, only a watchdog reset every 120 s. So `net_init()` and `net_connect()` ask for the interface in the
way that takes neither lock, and `net_connect()` leaves the join until `NET_EVENT_SUPPLICANT_READY` has been
seen. On a healthy chip the join then starts at that moment, and nothing is said on the console. On a chip that
does not get there, the console says `no answer` or `request refused` every 30 s and `wifi_silent` restarts it.
This has only run on a host, against a fake of those locks: nothing has run with a chip that does not come up,
and `chip-dead` does not cover it, because the driver powers the chip up at init.

**The order of a join.** The chip has hung twice with the same shape: a connect request within a second or so of
the link changing. On 1.5.0 it was `WIFI` within a second of `[WIFI] connected`, and on 1.7.0 `WIFI` within a
second of the disconnect of `CLEAR_WIFI`, where the chip stopped answering 10 s later and `wifi_silent` restarted
the board at its limit, after which the chip answered. From firmware 1.7.1 a join that is asked for goes in order.
The decisions are in `src/join_policy.c`, and `net_tick()` holds a join from the main loop's tick, so nothing
waits for it:

1. Nothing goes to the stack within 5 s of the last change of the link, of the last request to disconnect or to
   connect, or of the result of a join, good or bad. So the right password waits 5 s after the wrong one has failed.
2. If the board is associated, as far as the stack has said, or its link is up, it is then asked to disconnect, once.
   So it is if a join is under way, one that was asked for less than 31 s ago with no result yet, because the
   supplicant's connect request starts with `remove_network all`. Then the join waits for the stack to report that,
   for up to 10 s. The request itself normally takes up to 5 s of the main loop, as it always has in `CLEAR_WIFI`: that
   wait is inside hostap. On a supplicant that has stalled it can take up to 35 s: 15 s for its answer to `disconnect`,
   the 5 s, and 15 s for its answer to `remove_network all`.
3. A disconnect that has not been reported by then counts as done: the board says `[WIFI] disconnected`, and
   `wifi_silent` starts from there. If the stack reports it later, that changes nothing.
4. Then the 5 s of the first step again, before the connect request.
5. A later request replaces one that is held, and does not start the wait over. A join reads what is stored when it
   starts, so it uses the network stored last. If the network is erased in the meantime no join comes, and nothing
   is said. Each new change does start the wait over, up to 30 s from when the request was first held
   (`JOIN_HOLD_LIMIT_MS`), because a stack that reports a failed join every few seconds must not keep the right
   password from ever being tried.

A board that has been quiet joins at once, as the join at boot does, if no join is under way. The `[WIFI]` line still
comes after the `OK`. A join that is held is no answer: `wifi_silent` goes on counting while it is held, and a
disconnect that the stack reports is no answer either. So the most a hold adds to `wifi_silent` is the time in which
the link still counts as up: 5 s of quiet time and the 10 s limit, which is 15 s. If the request itself takes its 35 s,
the restart comes about 160 s after the `WIFI` command: 5 s, the 35 s, and the 120 s of `wifi_silent`.

Only a `WIFI` command takes a link that is up down, and `WIFI` is refused during an update. `net_tick()` does not. Its
retry every 30 s starts over a join that has reported nothing without asking it to leave, as it always has, and it
takes an association that has found no address in 30 s down first. A retry that is held when the link comes up, or gets
an association, by the supplicant's own reconnect, goes away.

**This has not been shown to fix the hang.** Its cause is not known. This takes away the timing that both hangs had,
and a run on a board has to show the rest: it has run only on a host, against a fake network stack.

**What it does not do.** It does not use `SUPPLICANT_EVENT_SCAN_FAILED`: `src/stuck_policy.h` says why. The driver's
recovery stays as it was, and its settings too.

**What has been tested.** The decisions are in `src/stuck_policy.c` and `src/join_policy.c`, with no Zephyr in
them. `test_stuck_policy.c` and `test_join_policy.c` test each one, and `tests/host/mutate_stuck.py` and
`mutate_join.py` make small changes to them and check that those tests notice.
`test_app.c` runs the real `main.c`, `net.c` and `stuck.c` on a fake network stack. **None of this has run on a
board.** Neither has a wrong WPA3 password, which is the first thing to try for a refused join. For the rest there
is the scenario below, which takes the hotspot and AWS, and drops the board off the network once:

```sh
firmware/tests/hil/build_image.sh 1.6.9 0 build-bench/images/wifi-dead.bin \
  -Dapp_CONFIG_APP_TEST_FAULT_WIFI_DEAD=y -Dapp_CONFIG_NRF_WIFI_RPU_RECOVERY=n
python3 firmware/tests/hil/ota_bench.py update build-bench/images/wifi-dead.bin --via direct
python3 firmware/tests/hil/ota_bench.py chip-dead build-bench/images/wifi-dead.bin
```

The scenario first looks for a run of `update` that confirmed exactly this file through a real trial, because
an image from serial recovery has no trailer, cannot revert, and would show nothing by not reverting. Without
one it ends as `NOT_RUN`, and the command refuses an image with no trailer as well. Then it sends
`TEST_WIFI_DEAD` once and nothing more until the board has restarted. It has to see the `[STUCK]` line, at the
timer's limit from the line that marks its start, a line from the driver before it, one boot, a software reset,
the same reason and count at the next boot, a join with an address, the cloud, no swap in the bootloader's log,
and the shadow saying `confirmed`. The driver's line is what shows that the command stopped the chip at all: a
hotspot that lost its internet for as long as the timer takes would look the same without it.
Since the board is on the cloud when the chip stops, `no_cloud` is the timer to expect, about 16 minutes after the
command. `wifi_silent` passes as well, if the stack does see the link go.

`TEST_WIFI_DEAD` drives BUCKEN (P0.12) low and leaves IOVDD on, so the I/O rail stays powered and nothing is
clocked into an unpowered chip. This is not the state of the incident, in two ways. The driver's wake check
appears to have passed then, with only the command queue staying empty, and with BUCKEN low it should fail with
`RPU is not ready`. And the driver never does this itself: `rpu_pwroff()` takes IOVDD low first and then BUCKEN,
and `rpu_pwron()` raises BUCKEN first, so it never has IOVDD on with BUCKEN off. The chip's datasheet is not in
this tree, so nothing here says what the chip makes of that: read it before the first run. The image has to be
built with the driver's recovery off, or the driver powers the chip up again and hides the timer, and the build
stops if it is not. Leaving the recovery out would also take the network event queue from 16 entries to 5, because
the driver's Kconfig sets 16 only along with it, so `prj.conf` names the size for every image. A restart clears
the fault, because the driver powers the chip up at init.
`tests/hil/fault_check.py` checks a built image for all of this, with the fault image as its positive control.

### Tests with no cable

The board can stay off USB. With no console found, or with `--cloud-only`, `scripts/ota.sh` and
`tests/hil/ota_bench.py` use no serial port and no probe, only AWS credentials. They follow the board through the job
execution and the device shadow: firmware version, confirmed, update state, last result, heartbeat age, and from
1.7.2 on the stuck count and reason. Where firmware before 1.7.2 asks for Button 1, the bench says so, waits three
minutes for a person, and then fails, and cancels the job so that a later press installs nothing.

| Command with no cable | What it rests on |
| --- | --- |
| `update`, `older`, `corrupt`, `bad-signature`, `faulty`, `cancel-stop` | The job's status and reason, and the shadow. Each says in its result that it had no console and no bootloader log, and each line of `results.jsonl` has the `mode` it ran in. So `faulty` shows that the board reports a rollback and runs the old image, and not that a log said `Swap type: revert`, and `cancel-stop` takes an uptime that went back for a restart. |
| `chip-dead-cloud` | The same, as below. It needs no flag. |
| `reset-download`, `reset-swap`, `chip-dead`, `recovery` | Nothing: they end as `NOT_APPLICABLE`, with the reason. They take the reset pin through the probe, the bootloader's log on the second serial port, a console command, or UART. So do the steps of `console_bench.py`, and all of `golden_bench.py`, whose gesture is held from the probe or by a person, and whose checks read the bootloader's log. |

An image for `chip-dead-cloud` stops the chip by itself, so that nothing has to be sent to it:

```sh
KIND=wifi-dead-auto firmware/tests/hil/build_image.sh 1.7.90 0 build-bench/images/wifi-dead-auto.bin \
  -Dapp_CONFIG_APP_TEST_FAULT_WIFI_DEAD=y -Dapp_CONFIG_APP_TEST_WIFI_DEAD_AFTER_SECONDS=300 \
  -Dapp_CONFIG_NRF_WIFI_RPU_RECOVERY=n
python3 firmware/tests/hil/ota_bench.py chip-dead-cloud build-bench/images/wifi-dead-auto.bin --via direct
```

It fires 300 s after the image was confirmed, counted while the cloud is connected and no update is under way, and once
per install: the version it fired on goes into storage first, and a board that cannot write that does not fire at all,
so that it cannot go round in a loop of these. It does not fire on an image with no trailer, on which no revert could
show. The next install of the image has another version, and fires again. The bench installs the image through a real
trial, and the shadow then has to show heartbeats that stop, a restart within `no_cloud`'s or `wifi_silent`'s limit (the
uptime starts again), the board back with the same image confirmed, a reason of `no_cloud` or `wifi_silent` with a count of
at least 1, and no second time for as long again. A reason of `none` means that the watchdog or a crash did it, and that
fails. What this cannot show from the cloud is the driver's line and the bootloader's log, so a hotspot that lost its internet
at that moment would look much the same, which `chip-dead` tells apart. It has run only against a stand-in for AWS.

## Signature

Images are signed with ECDSA P-256 over SHA-256, with a key generated for this project by
`tools/keys.py`. The boards hold only the public half, and
[`secrets/README.md`](../secrets/README.md) covers the private key. ECDSA P-256 stays by the team's
decision. Ed25519 is the possible later upgrade, and it needs a bootloader reflash. Post-quantum
signatures are not available in this MCUboot.

## Serial recovery

MCUboot can take an image over UART. This is the way back when an image cannot reach the
network, and it needs neither Wi-Fi nor a debugger. It uses `uart0`, the board's second
virtual COM port, so close any terminal on that port first. Run `tools/recover.py` from an
nRF Connect SDK terminal, which provides pyserial and cbor2.

Get the board into the bootloader in one of these ways:

| Way | What to do |
| --- | --- |
| Button | Hold Button 1, press RESET, release Button 1, then run `python tools/recover.py upload <image>`. |
| Debug port | `python tools/recover.py --reset upload <image>` restarts the board and catches the half second after a reset in which the bootloader listens for a command. If the restart goes past that half second, the tool restarts the board again, up to three times. Name your own debug probe with `--serial-number <probe>` (`nrfutil device list` shows it): the tool's default is the probe of this project's bench, and it fails on any other. |
| Running application | `python tools/recover.py --console upload <image>` sends `ENTER_BOOTLOADER` to the application, which restarts. This needs firmware 1.3.0 or later with the serial console built in, which a build with `-Dapp_CONFIG_APP_CONSOLE=n` does not have. It cannot restart the board again: if it misses the half second it stops with an error, and you run it again. |
| No valid image left | Nothing. The bootloader stays by itself. |

Tested on the board: `--reset`, `--console` and no valid image. `--reset` is the one with numbers,
under [Getting into the bootloader](../docs/test-results.md#getting-into-the-bootloader-on-firmware-150). `--console` listed
the images on firmware 1.3.0 and 1.5.0, and uploaded an image on 1.3.0. Button 1 is not tested on
hardware yet.

```sh
python tools/recover.py --reset list                               # show the image the bootloader holds
python tools/recover.py --reset upload binaries/latest.signed.bin  # write it and restart
python tools/recover.py reset                                      # restart a board that is already in the bootloader
```

The tool finds the port by itself; `--port` overrides that. MCUboot takes whatever it is sent and
writes it straight into the primary slot, the one target it accepts. At the restart it checks the
signature and starts nothing that fails. It then stays and waits for a good image.

This path has limits. It has no version check, so any image ever signed with this key can be
installed over a newer one. The image does not run on trial and there is no revert. On a
development kit this adds no power, because the debug port is open. A product build has to narrow
it or turn serial recovery off: [`docs/aws-iot.md`](../docs/aws-iot.md#known-limits) says how.

## Boot diary

From firmware 1.7.4 the board keeps its last eight boots in storage and sends them to the device shadow as `diary`, so that
a reset can be explained with no serial port. Each entry is `version/cause/stage`:

- **cause** is why the boot before it ended, in hex, as Zephyr's `RESET_` bits: `1` reset pin, `2` software, `4` brownout,
  `8` power-on, `10` watchdog, `20` debugger, `100` CPU lockup.
- **stage** is how far that boot got: `1` reached `main`, `2` the update manager started, `3` network up, `4` cloud up.

An image that fails on trial and is swapped back shows up here, if it reached `main`. If it did not, its entry is missing,
and that says something too. It writes to storage up to four times each boot. A factory reset erases it.

## Diagnostics

From firmware 1.10.0 the board also sends a `diag` report to its device shadow, when it reaches the cloud and every five
minutes after (`CONFIG_APP_DIAG_INTERVAL_SECONDS`), apart from the heartbeat so that the heartbeat stays short:

```json
{"diag": {"id": "CRVIHAAN01", "mac": "f4:ce:36:12:34:56", "channel": 6, "heap": {"free": 21312, "least": 9840, "size": 44240}, "board": "nrf7002dk", "layout": 1}}
```

`id`, from 1.11.4, is the board's own device ID, set with `INIT` or `SET_ID`, which the console shows as the board's name; it
is sent again as soon as it changes, and left out when there is none. The thing name stays the board's AWS identity. `mac` is the Wi-Fi address, for networks that admit devices by address. `channel` is the Wi-Fi channel, 0 when not
associated. `heap` is the system heap in bytes: free now, the least it has been since the board started, and its size.
`board` and `layout`, from 1.13.0, are the [board type and flash layout](#board-type-and-compatibility). Nothing in it is secret, and nothing names the network. The
console's diagnostics page shows it.

## Events to the console

From firmware 1.12.0 the board tells the console in the cloud what it tells its serial console. Each line
that `console_event()` prints (`[BT]`, `[WIFI]`, `[STUCK]`, `[CONSOLE]`, and from 1.13.0 `[CMD]`, the
answers to [commands](#commands)), and each log line of the application's own modules (`[app]`, `[ota]`,
`[net]`, `[cloud]`, `[stuck]`, from 1.13.0 `[location]`, and the rest), also goes to AWS IoT as one MQTT
message, at QoS 0, on

```text
cranium/<thing name>/events
```

The line on the serial console stays exactly as it was. `src/cloud_events.c` does this, with
`CONFIG_APP_CLOUD_EVENTS`, which is on wherever the console is: a build without the console sends none.

```json
{"t":61234,"seq":17,"boot":42,"up":61240,"tag":"WIFI","text":"connected ip=10.0.0.7 rssi=-51"}
```

- `t` is the board's uptime in milliseconds when it printed the line, and `seq` counts the events of this
  boot from 1.
- `boot` is the [boot diary](#boot-diary)'s count of boots, so that `boot` and then `seq` order events
  across restarts. It starts at 1 again after a factory reset.
- `up` is the uptime when the message was sent. A line that waited while the board was offline happened
  `up - t` milliseconds before the cloud got it.
- `dropped`, only when it is not 0, is how many lines are missing right before this one, for a full ring or
  for the rate limit. `seq` skips over them, so each `seq` is the one before it, plus 1, plus `dropped`.
- `tag` is the console's tag without its brackets, and `text` what follows it: at most 160 characters of
  printable ASCII, anything else as `?`, and a longer line cut to end in `...`. A log line keeps its `WRN: `
  or `ERR: `.

The serial console's own commands that change the board are events too, when they worked, though not lines
on the serial console, where their reply is: `SET_ID`, `RESET_CONFIG`, `WIFI`, `WIFI_SEC`, `CLEAR_WIFI`,
`CLOUD`, `KEYGEN`, `MQTT_HOST`, `MQTT_RECONNECT` and `BUTTON`, as `[CONSOLE] WIFI done on the serial console:
save a WPA2 network and join it`: the name and what it does, never what was typed after the name. So is a
certificate loaded there: `the device certificate loaded on the serial console (1200 bytes)`. `INIT`,
`REBOOT`, `ENTER_BOOTLOADER` and `FACTORY_RESET` restart the board first; a restart shows as the next boot's
events, with a new `boot`.

### What is never sent

`src/cloud_events.c` decides when a line comes in, with one rule for each source, and
`tests/host/test_cloud_events.c` has a line for every `console_event()` call in the firmware, and for every log
line that prints a value from outside, with what becomes of it.

- Only the sources it lists go: `console_event()`'s five tags (`BT`, `WIFI`, `STUCK`, `CONSOLE` and, from
  1.13.0, `CMD`) and this application's log modules, `location` among them from 1.13.0. Nothing from Zephyr
  or the SDK, whose Wi-Fi supplicant, MQTT library and downloader are where network names, host names and
  URLs get printed. No debug line (`DBG: `). A `[CMD]` line has only fixed words in it and a command's id,
  and only an id of 16 hexadecimal digits; a `[location]` line has counts, never an access point's address
  or name. Every rule below holds for both, as for any source.
- The Bluetooth passkey: `[BT] passkey 012345` never goes, nor does any `[BT]` or `[bt_ota]` line with the
  word in it. A release manager's phone gets the passkey from the shadow, for 150 s, as
  [firmware update over Bluetooth](#firmware-update-over-bluetooth) says.
- A line with any of `passkey`, `passphrase`, `password=`, `password:`, `psk=`, `secret`, `-----BEGIN`,
  `PRIVATE KEY` or `X-Amz-` in it, in any case, from any source. No line of this firmware has one: this is for
  the line that someone adds. `[WIFI] failed reason=wrong password` does go.
- A network's name becomes `the network`. In `[net]` and `[WIFI]` lines that is whatever stands from the first
  double quote to the last, as in `[net] ERR: Leaving "<ssid>": its security mode (2) is not allowed`, since
  a name can have quotes in it. In every line, the stored network's name becomes it wherever it stands as a
  name of its own: a network called `net` leaves `network not found` alone.
- A URL, from `scheme://` to the next blank or quote, becomes `a URL`. The firmware never prints the download
  URL or the endpoint with a query, and `X-Amz-` above catches a signed URL that lost its scheme.
- Certificates and keys are never printed on the console, so no event can hold one, and `-----BEGIN` and
  `PRIVATE KEY` above would stop it.

### Offline, the limit and the order

Lines wait in RAM, the last 32 of them, and go out oldest first, with their own `t` and `seq`, once the board
is connected: from the main loop only, 8 at a time, and the rest after whatever else the main loop has to
do. When the ring is full the oldest goes, and the one after it says how many did. From 1.14.0 that is the oldest
line that is not about an update (tags `BT`, `bt_ota` and `ota`), unless every line is: the lines of an update
across a restart are what a person follows it by. Right before a restart that a person asked for at the board,
everything that waits goes at once (`cloud_events_flush()`): see [What happens](#what-happens). At most 5 lines a second get
into the ring, after a first 20 at once, online or not, so that a failure that prints in a loop cannot flood
MQTT, the ring or the bill: 432,000 messages a day at the very most. The next line that gets in says how many
did not. What waits is lost when the board restarts.

Lines come from every thread: the console task, the log thread, Bluetooth's callbacks. They go into the ring
under a spinlock and never wait, and they wake the main loop once, until it has run. The ring and what goes
with it take about 7 KB of RAM. The longest message there can be (`CLOUD_EVENTS_JSON_MAX`, every number at its
largest and a text of 160 quotes) is 455 bytes, which with its 39-byte topic and the MQTT header fits the
512-byte buffer (`CONFIG_MQTT_HELPER_RX_TX_BUFFER_SIZE`), as the shadow report does: `src/cloud.c` asserts
it at build time.

### The device policy

AWS IoT closes the connection of a board that publishes where its policy does not allow, so the device policy
(`cranium-device` in `cloud/infra/template.yaml`) has to allow `iot:Publish` on
`topic/cranium/${iot:Connection.Thing.ThingName}/events` before a board runs 1.12.0. In case it does not:
until AWS IoT has taken an event in a boot, a connection sends its first event no sooner than 5 s after it
came up, so that an update's messages go first, and the rest only once the connection has lived 5 s with it.
After two connections that ended sooner than that, events stay off until the next restart, with
`[cloud_events] WRN: AWS IoT closed the connection right after an event, 2 times: ...` on the serial console;
updates and the shadow go on as before. That first event goes back to the front of the ring each time, so a
connection that ended for another reason can bring it twice, with the same `boot` and `seq`.

### Changes reach the shadow at once

From 1.12.0 the heartbeat, the shadow report every 30 s, also goes as soon as something it carries changes:
the firmware version, `confirmed`, the update's state, job, progress, last result and error, the stuck count
and reason, and whether Wi-Fi is up. Never sooner than 2 s after the last report (`REPORT_FLOOR_MS` in
`src/main.c`), so that a state that flaps sends one report every 2 s at most, and the last change goes when
the 2 s are up. The signal strength and the uptime change all the time, and do not count. Offline, nothing is
said: the first report of the next connection says how it stands.

## Board type and compatibility

From firmware 1.13.0 every image says what it is compatible with: the kind of board and the flash layout it is built
for. The board says the same of itself, refuses an image for another, and the console offers a release only to the
boards it fits. [`docs/fleet.md`](../docs/fleet.md), under Board types and Compatibility, has the types and what the
console and the apps do with them. This board is `nrf7002dk`, flash layout `1`.

| Protected TLV | Value, in ASCII, with no NUL | From | An image without it |
| --- | --- | --- | --- |
| `0xa1` | the board type, 1 to 16 lower-case letters and digits: `nrf7002dk` | `CONFIG_APP_BOARD_TYPE` | `nrf7002dk` |
| `0xa2` | the flash layout, a positive whole number with no leading zero: `1` | `CONFIG_APP_IMAGE_LAYOUT` | `1` |

- **In the image.** Protected means inside the area that the image's SHA-256 covers, which the signature signs, so
  neither can be changed without the key. `firmware/app/Kconfig` sets both, through MCUboot's
  `CONFIG_MCUBOOT_EXTRA_IMGTOOL_ARGS="--custom-tlv 0xa1 nrf7002dk --custom-tlv 0xa2 1"`, which the build's signing
  step (`nrf/cmake/sysbuild/image_signing.cmake` in the SDK) hands to `imgtool sign`. imgtool puts every
  `--custom-tlv` in the protected area and takes tags from 0x00a0 to 0xfffe that are none of its own; MCUboot leaves
  0x00a0 to 0x00ff to vendors and skips a TLV it does not know, so the bootloader on every board takes these images
  as it took the ones before. The image grows by 22 bytes. Every image before 1.13.0 has neither, and is for
  `nrf7002dk`, layout `1`.
- **In the configuration.** Both values follow from the board and cannot be set: an assignment in a `.conf` file has
  no effect on a symbol with no prompt, so each board's type and layout number are defaults in `firmware/app/Kconfig`,
  next to each other (`CRANIUM_NRF7002DK_LAYOUT`). `firmware/app/CMakeLists.txt` stops a build for a board with no
  type or no layout, and one whose imgtool arguments would not carry them.
- **The layout number moves with the partitions.** `firmware/app/flash_layout.py`, which `firmware/app/sysbuild.cmake`
  runs after every build and before the image is kept in `binaries/`, describes the partitions as the application and
  the bootloader were built with them, from their final devicetrees (`zephyr.dts`): one line for each partition, with
  its flash device, the partitions it is inside, its offset and its size, and one for the chosen code partition.
  Comments, the order of nodes and properties that place nothing change no line. The SHA-256 of the sorted lines has
  to be the one `firmware/app/flash_layouts.json` holds for this board type and layout number, or the build stops and
  prints what changed. So a change of partitions, the golden area's among them, needs a new number: add it to
  `flash_layouts.json` with the lines and SHA-256 that `flash_layout.py show` prints, and make it the board's
  default in `Kconfig`. A layout that has shipped is never changed. With Partition Manager on, the build stops,
  since the devicetree would not hold the partitions.
- **On the board.** The [diagnostics report](#diagnostics) says `"board": "nrf7002dk"` and `"layout": 1`.
- **The board refuses an image for another board or flash layout, before it marks it to test.** `src/image_compat.c`
  reads the image in the secondary slot, strictly and within bounds: the header's sizes, added in 64 bits, must place
  the protected area and the unprotected TLV area's info header inside the slot; the protected area's info header
  must have its magic (0x6908) and the size the image header gives; its entries must fill it exactly; each of
  `0xa1` and `0xa2` may come once, with a value as above. A TLV outside the protected area is never read, so an `0xa1`
  there counts for nothing. Whether the SHA-256 and the signature hold is the bootloader's check, which it makes
  before any swap. A missing `0xa1` is `nrf7002dk` and a missing `0xa2` is `1`.
  - **Over the internet**, once the download's digest is verified and again right before the bootloader is asked for
    the trial swap: an image for another board type or layout is erased, never marked, and the job fails with reason
    `incompatible_board` or `incompatible_layout`, with `[ota] ERR: Update <job> failed: incompatible_board (image is
    for nrf5340dk)`. A protected area that is not well formed fails as `header_mismatch`.
  - **Over Bluetooth**, three times. As the upload comes in, MCUmgr's upload check hook
    (`CONFIG_MCUMGR_GRP_IMG_UPLOAD_CHECK_HOOK`) passes each piece's bytes of the protected area through the same
    reader, and refuses the piece that completes it, before it is written, with an SMP error that the phone's tool
    shows: `[BT] refused an upload: it is for nrf5340dk, and this board is nrf7002dk`. Once it has all arrived, the
    slot is read again before it is offered, and again before Button 1 marks it: refused there, it is erased, the
    window closes, and the record says `incompatible_board` or `incompatible_layout`. No SMP command can mark an image
    in any case: the image state write, which is what test and confirm are, is refused with `EACCESSDENIED` to every
    phone and tool, so only Button 1 can, after these checks.
- `tools/check_image.py` (`scripts/check-image.sh`) shows the type and the layout, and refuses an image from 1.13.0
  without them, one whose protected TLV area is malformed or not under the image's SHA-256, one with them outside that
  area, one of a type the console does not know, and one of a layout that `flash_layouts.json` does not have for its
  type. `--board <image>` and `--layout <image>` print each alone. `scripts/build.sh` reads both back from the image
  it built, stops if they are not this build's, and writes them into `binaries/latest.json` and the image's own
  record as `"board"` and `"layout"`. A plain `west build` leaves them out of those records: `tools/store_binary.py`
  does not write them yet.
- **Tests.** `tests/host/test_image_compat.c` reads good, legacy and incompatible images, every kind of broken or cut
  TLV area, and 100,000 mutated ones, from a slot in memory whose reads must stay inside it, and the protected area
  in pieces of every size. `tests/host/test_ota_bt.c` and `tests/host/test_bt_ota.c` check both refusals, the upload
  in pieces of many sizes among them. `tests/hil/test_flash_layout.py` checks the layout check, and
  `tests/hil/test_check_image.py` signs an image with the SDK's imgtool where it can and reads both TLVs back.

## Commands

From firmware 1.13.0 a release manager can send a board two commands from the console, which publishes them on

```text
cranium/<thing name>/commands
```

at QoS 1, where the board subscribes at every connection, with the jobs topics. A board that is offline misses
them: they are for now. [`docs/fleet.md`](../docs/fleet.md), under Commands, has the contract.

```json
{"id": "3f9c2a1b7d4e6f80", "cmd": "identify", "seconds": 15}
{"id": "a01b2c3d4e5f6789", "cmd": "report"}
```

- **identify** blinks LED1 and LED2 together at 5 Hz for `seconds`, then shows the state again, as it is by then:
  see [What the LEDs show](#what-the-leds-show). Another identify starts the time again.
- **report** sends the heartbeat and the diagnostics report at once, and asks for a
  [location scan](#location-by-wi-fi), which that section's rules can hold: the 10-minute floor, an update, the
  Bluetooth window. From 1.14.0 it also sends what [Memfault](#memfault) data is waiting.
- **memfault**, from 1.14.0, takes a heartbeat of Memfault's metrics now, instead of at the end of the hour, and
  sends it with whatever else is waiting: `[CMD] memfault: heartbeat taken, sending (<id>)`.
- **memfault_ack**, `{"id": ..., "cmd": "memfault_ack", "seq": 4711}`, is not for people: the cloud's answer for one
  Memfault chunk ([Memfault](#memfault)). It goes past the one command that waits, and is never answered.

`src/command.c` reads a message strictly, on the MQTT library's thread, into a struct of 20 bytes, and hands it to
the main loop, which carries it out. A message is one JSON object, of at most 256 bytes, with `id`, `cmd` and, for
identify, `seconds`, each at most once and nothing else; strings without escapes or control characters; values that
are strings, numbers, `true`, `false` or `null`, and nothing nested. `id` is 16 hexadecimal digits. `cmd` is
`identify`, `report`, `memfault` or `memfault_ack`, as written. `seconds` is a whole number from 1 to 60; anything
else, or none, is 15. `seq`, for memfault_ack only, is a whole number from 0 to 65535. One command waits for the main
loop at a time.

The board answers each one on its [events topic](#events-to-the-console) with the tag `CMD`, which the console files
as kind `setting`, and prints the same line on the serial console:

```text
[CMD] identify for 15 s (3f9c2a1b7d4e6f80)
[CMD] report: heartbeat, diagnostics and a location scan (a01b2c3d4e5f6789)
[CMD] report: heartbeat and diagnostics, no location scan: an update is under way (a01b2c3d4e5f6789)
[CMD] ignored: unknown cmd (3f9c2a1b7d4e6f80)
[CMD] ignored: not a command
```

An ignored one says why: `too long`, `not a command` (not JSON of that kind), `unknown member`, `repeated member`,
`no id`, `no cmd`, `unknown cmd`, `no seq`, or `the board is busy` (another was still waiting). The id is in the answer only
when the message was well formed and its id good, and nothing else of the message ever is. A build without the
serial console sends no events, and so no answers, and still carries out the commands.

## Location by Wi-Fi

From firmware 1.13.0 the board tells the console what Wi-Fi access points it hears, on

```text
cranium/<thing name>/location
```

at QoS 0, and the console asks AWS IoT Core Device Location for a position, for its map.
[`docs/fleet.md`](../docs/fleet.md), under Location by Wi-Fi, has what the console does with it.
`src/location.c` does this, with `CONFIG_APP_LOCATION`, which is on wherever there is Wi-Fi.

```json
{"aps": [{"mac": "a4:2b:b0:12:34:56", "rss": -51}, {"mac": "f0:9f:c2:65:43:21", "rss": -70}], "boot": 42, "t": 61234}
```

- **What is sent:** the 10 strongest access points at most, strongest first, each once with its strongest signal, by
  its address (BSSID) and its signal in dBm. Never a network's name: the board does not even keep one. Only
  globally administered addresses (the second-lowest bit of the first byte clear) count, since a phone's hotspot and
  other randomised addresses move with whoever carries them; nor a group address, nor one with no signal. With fewer
  than 2 left, nothing is sent. `boot` is the [boot diary](#boot-diary)'s count of boots, and `t` the uptime in
  milliseconds when the scan ended. The longest message is 441 bytes, which with its 41-byte topic fits the
  512-byte MQTT buffer: `src/cloud.c` asserts it.
- **When:** once a boot, when a connection has lasted 60 s; then 6 hours after the last scan began; and when the
  console's [report command](#commands) asks, at once. Never sooner than 10 minutes after the last scan began, for
  any of these. Never while an update is under way (any update state but idle: on offer, downloading, checking,
  installing, on trial, or over Bluetooth), while the Bluetooth window is open, or while the board is not connected:
  a scan that was due waits for those to end. A scan whose result could not be sent, because the connection went,
  leaves the boot's first one still to do, after the 10 minutes.
- **How:** an active scan of the 2.4 GHz band, with the driver's own dwell times, through Zephyr's
  `NET_REQUEST_WIFI_SCAN`. The results come one by one, and only the best 10 are kept, in 71 bytes. The nRF70's
  firmware also leaves out locally administered addresses itself (`CONFIG_WIFI_NRF70_SKIP_LOCAL_ADMIN_MAC`, in this
  board's configuration), so that fewer results crowd the network management queue. If the Wi-Fi stack refuses
  the scan (it does while it scans for itself), the board tries again a minute later. A scan whose end never
  comes is ended after 40 s; the driver ends its own after 30.
- **What a scan does to the link.** The association stays: the driver sends the scan to the nRF70's firmware and
  changes nothing of the connection, and no Wi-Fi event comes of it for `src/net.c`. The chip has one radio, so it
  leaves its access point's channel for a short dwell on each channel it scans and comes back: Nordic gives about
  50 ms on each active 2.4 GHz channel and 130 ms on a passive one, about a second for the band. What it does about
  frames during a dwell is in the chip's firmware, which is not in the SDK's source: a station normally tells its
  access point that it is asleep, and the access point keeps them. MQTT's keep-alive is 120 s and TCP retries for
  far longer than a second, so the connection to AWS IoT sees a delay at most. The driver does one scan at a time,
  the board's or the supplicant's: while the board's runs, the driver refuses the supplicant's own scan for a lost
  network, and the supplicant tries again. Not tested on a board yet.

### The device policy for commands and location

The device policy (`cranium-device` in `cloud/infra/template.yaml`) has to allow, before a board runs 1.13.0,
`iot:Subscribe` on `topicfilter/cranium/${iot:Connection.Thing.ThingName}/commands`, `iot:Receive` on
`topic/cranium/${iot:Connection.Thing.ThingName}/commands`, and `iot:Publish` on
`topic/cranium/${iot:Connection.Thing.ThingName}/location`. On a cloud whose policy does not yet:

- **Commands.** The commands topic is in the same SUBSCRIBE as the jobs topics. AWS IoT answers a subscription its
  policy does not allow with a SUBACK that refuses that one topic, and the connection stays: the board cannot see
  that refusal, since the AWS IoT library passes on nothing of a SUBACK's codes, so it connects as before, updates as
  before, and gets no commands. In case AWS IoT closes the connection instead: `aws_iot_connect()` waits up to 30 s
  for the SUBACK and gives up with -11. After two of those, with no refusal of the CONNECT before them, the board
  connects without the commands topic until a restart, and says so on the serial console and in its events:
  `[cloud] WRN: AWS IoT ended the connection while it subscribed, 2 times: no commands until a restart. Its device
  policy must allow cranium/<thing>/commands`. With the back-off (30 s, then 60 s), that costs about three minutes of
  a boot before the board is connected, inside the 5 minutes an image on trial has to reach the cloud. A connection that
  had the subscription acknowledged starts the count again.
- **Location.** AWS IoT closes the connection of a board that publishes where its policy does not allow. A
  connection that ends within 5 s of a location is counted, as for [events](#the-device-policy), and after two of
  those the board makes no scan until a restart, with `[location] WRN: AWS IoT closed the connection right after a
  location, 2 times: ...`. The first is a minute into the boot's first connection and the second 6 hours later, so
  such a cloud costs a board two reconnections a boot. Updates and the shadow go on as before, and no scan, and so
  no location, is ever made during an update.

### Tests of commands and location

`tests/host/test_command.c` reads every kind of message that is not a command, cut at every length, and 200,000
random and mutated ones, under the address and undefined-behaviour sanitizers, and checks what each command does and
answers. `tests/host/test_location.c` checks what is kept against a plain reference for 20,000 random scans, the
JSON and its longest, and every rule of when, on a fake of the Wi-Fi stack; built twice, the second time for the
Bluetooth window. `tests/host/test_ui.c` runs identify on the timers, and `tests/host/test_cloud.c` the topics and
the guard. What a real scan does to a real link is for a board.

## Memfault

From firmware 1.14.0 the board keeps what Memfault needs, with Memfault's SDK, and sends it over its own AWS IoT
connection: why every boot ended, a coredump of a crash, an hourly heartbeat of metrics, and an event for each
update that ends. It never talks to Memfault itself and carries no project key: a function in AWS posts each chunk
to Memfault and answers on the commands topic. [`docs/memfault.md`](../docs/memfault.md) has how it works, what is
sent, what the owner sets up, and the crash demonstration (`CONFIG_APP_CRASH_DEMO`).

```text
cranium/<thing name>/memfault     the board publishes, QoS 0: 1, a 16-bit sequence number, one chunk
cranium/<thing name>/commands     the cloud answers {"id": ..., "cmd": "memfault_ack", "seq": <n>}
```

- `src/mflt_link.c` sends one chunk of at most 400 bytes at a time and waits 20 s for its answer, then sends it again
  after 30 s, doubling to an hour; an answer sends the next one at once. Not during a download or an installation,
  and not while Bluetooth is open.
- `src/mflt.c` gives the SDK the thing name as its device ID, the reset cause from `src/reset_cause.c`, the reboot
  reasons this firmware knows (an update, a trial that ran out, the stuck timers, a factory reset, RESET), its
  metrics and the update events.
- The coredump (3,968 bytes) and the reboot reason are in two RAM regions of their own, `MFLT_COREDUMP` and
  `MFLT_REBOOT` in `boards/nrf7002dk_nrf5340_cpuapp_ns.overlay`, at the same address in every image from 1.14.0, so
  they outlive a revert to another such image. A fault in the secure domain (TF-M) leaves no coredump.

### The device policy for Memfault

The device policy has to allow `iot:Publish` on `topic/cranium/${iot:Connection.Thing.ThingName}/memfault` before a
board runs 1.14.0. On a cloud whose policy does not, AWS IoT closes the connection after a chunk. A connection that
ends within 5 s of one, before any answer came, is counted, and after two of those the board sends no Memfault data
until a restart: `[memfault_link] WRN: AWS IoT closed the connection right after a Memfault chunk, 2 times: no
Memfault data until a restart. Its device policy must allow cranium/<thing>/memfault`. Updates go on as before, and
the trial is over before the first chunk goes.

### Tests of Memfault

`tests/host/test_mflt_link.c` sends chunks through the real `src/mflt_link.c` against a fake packetizer and a fake
connection: in order, each after its answer, the same one again without one, the waits, the sizes, the sequence
number's wrap and the device policy's guard. `tests/host/test_reset_cause.c` reads the cause once and clears it once,
and checks what each set of bits comes down to. `tests/host/test_command.c` is built a second time with Memfault for
the two commands, and `tests/host/test_cloud.c` checks the topic and the jobs message read where it arrives. On the
board, on 2026-11-05, 1.14.0's first two chunks reached Memfault and were acknowledged
([`docs/test-results.md`](../docs/test-results.md#firmware-1140-over-bluetooth-and-the-first-data-in-memfault)). What
the SDK does on a crash, and the hourly heartbeat, have not been seen on a board yet.

## Firmware update over Bluetooth

An image can be uploaded from a phone over Bluetooth LE, for a board that has no Wi-Fi in reach or
for a person standing next to it. The phone apps in `apps/` take the release from the console and send
it: see [`docs/mobile-apps.md`](../docs/mobile-apps.md). From 1.9.0 every build has it. The network
core needs one debug-port flash to have the controller, after which every update can go either way.

**It has worked on the air three times.** On 2026-11-03 a board went from 1.11.3 to 1.11.4 from an iPhone with
nRF Connect Device Manager ("Upload only"): paired with the passkey relayed through the console, 844,762
bytes in 57 s, Button 1, a 91 s swap, and the image confirmed itself on reaching AWS IoT (proof cloud).
See [`docs/test-results.md`](../docs/test-results.md#the-first-update-over-bluetooth-1113-to-1114). On
2026-11-05 our own iPhone app sent 1.13.0 (app 0.6.2, the passkey pasted from the clipboard) and then 1.14.0, each
confirmed with proof cloud; after 1.14.0's restart the board advertised its status for 2 minutes
([`docs/test-results.md`](../docs/test-results.md#firmware-1140-over-bluetooth-and-the-first-data-in-memfault)). Not
recorded yet: the Android app sending one, an update with no Wi-Fi (proof person), and the failure cases below.

`sysbuild.conf` sets `SB_CONFIG_APP_BT_OTA`, which applies `bt_ota.conf` to the application, and
`SB_CONFIG_NETCORE_HCI_IPC`, which puts Zephyr's `hci_ipc` with the SoftDevice Controller on the
network core in place of the blinky. A build without it:

```sh
west build -b nrf7002dk/nrf5340/cpuapp/ns --sysbuild firmware/app -- -DSB_EXTRA_CONF_FILE=no_bt_sysbuild.conf
```

It needs the console, which is the one way to see a passkey on a board that is offline, so the build
stops if it is combined with `-Dapp_CONFIG_APP_CONSOLE=n`. The bootloader and TF-M come out the same
either way. These are from the 1.7.0 build; 1.9.0's application is 708,676 bytes of flash and 394,668
bytes of RAM, and its signed image 839,898 bytes:

| Image | Off | On | What it has |
| --- | --- | --- | --- |
| Application, flash | 629,204 | 706,436 | of 794,474 bytes |
| Application, RAM | 359,384 | 393,940 | of 409,600 bytes |
| Network core, flash | 19,024 | 133,232 | of 256 KiB |
| Network core, RAM | 4,240 | 35,168 | of 64 KiB |
| MCUboot, flash | 50,324 | 50,324 | the same file |
| TF-M, flash | 130,008 | 130,008 | the same, but for the build time in its banner |

When the option was added, with it off the application's `.config` and `zephyr.bin` stayed the same as
before, byte for byte. Only the sysbuild `.config` had one more line, `# SB_CONFIG_APP_BT_OTA is not set`.

The TLS buffers and everything else that Wi-Fi uses are the same with it on. The system heap is 4,096
bytes larger, because Bluetooth takes from it at the first press and Wi-Fi should not notice. What it
adds takes the RAM that nothing was using.

`tools/store_binary.py` keeps every build in `binaries/` and writes `"bluetooth": true` or `false` into
`latest.json`. A board whose network core still has the blinky takes such an image over Wi-Fi as
before: its Button 1 hold then says that the controller is missing. `src/bt_ota.c` stops the build if one of the options the security rests on changes:
the characteristic's permission, LE Secure Connections only, no bonds, a passkey drawn by the host, the
image group as the only group, and Bluetooth as the only transport.

### What happens

1. Hold **Button 1** for five seconds and let go. Only a real press counts. `BUTTON|1` on the console
   does not, and neither does anything from the cloud. Bluetooth has not even been started until
   this first press. LED1 shows four short flashes, and the console says `[BT] open for 180 s`.
2. The board advertises as `Cranium-` and four hexadecimal digits, drawn anew for each window, and on
   the console as `[BT] advertising as Cranium-1A2B`. Its address is a resolvable private one that
   changes every 15 minutes (`CONFIG_BT_PRIVACY`), with a key drawn at each start that is never handed
   to anyone. Two windows within those 15 minutes do show the same address. Nothing that identifies the
   board in the cloud goes on the air.
3. A phone connects, and has to pair: LE Secure Connections with MITM protection and a 16-byte key,
   and nothing else. The board prints `[BT] passkey 123456`, and the person types that on the phone. A
   new one is drawn for each attempt. Three failed attempts close the window. No bond is kept, so a
   phone that pairs today has no way back in tomorrow.

   A board that is online also puts the passkey, with the name it advertises, into its device shadow
   (`{"btpair": {"name": "Cranium-1A2B", "passkey": "123456"}}`), and takes it out again once the
   attempt is over or the window closes. The console hands it only to a release manager, records each
   time it does, and not after 150 s, so the phone apps can show it to the person holding the phone.
   Nothing more goes on the air than before. An offline board has only the console.
4. The phone uploads a signed image to the secondary slot. The first piece has to show an image
   header with a version strictly newer than what runs, for image 0, no longer than what stops short
   of the trailer. Anything else is refused there, before anything is written. While this goes on,
   the board is in the update state `bluetooth`: no cloud update starts, a job waits, and whatever an
   update refuses on the console and by Button 2 is refused.
5. When it has all arrived, the board says what it got, `[BT] firmware 1.6.0+0 has arrived, hash ...:
   press Button 1 to install it, Button 2 to erase it`, and LED1 blinks fast. If nobody presses
   either within two minutes, it is erased, and so is a whole image in a window that closes for any
   other reason. A reset during those two minutes leaves it where it is. That is no different from the
   previous image, which stays in the slot after any update: without a swap request the bootloader
   ignores it, and the only way to one is to upload the image again and press Button 1.
6. Button 1 writes the record, asks the bootloader for a **trial** swap, and restarts: the same call
   as a cloud update, in the same order. MCUboot checks the signature and the version, as it always
   does. An image it does not like is not installed. From 1.14.0 the board first tells the phone (the
   [status](#the-status-a-phone-can-read) says `installing`, and it waits up to half a second for that to go
   out), then sends the console what waits, `restarting into the bootloader: …` among it, and a report with
   the update's state as `rebooting`, and restarts once AWS IoT has acknowledged that report (its PUBACK),
   or after 2 s without one, or at once when offline (`app_restart()` in `src/main.c`). Before 1.14.0 that
   line never left the board. Button 2 and the 2 minutes running out send their line the usual way, and
   tell the phone before its link goes.
7. The image runs on trial. See [The trial](#the-trial).

Button 2 closes the window at any point, and advertising stops at the end of the window or when a
phone connects. A phone that does not finish pairing is dropped after 45 s, and an authenticated link
on which nothing happens after 120 s (30 s up to 1.11.1, which was too short for a person working through a
phone app). A link that keeps busy can outlast the window, because an upload
takes a while, up to 15 minutes in all, plus the two minutes of the offer if the image got there in
time. The window does not open again by itself after that, and it will not open again while the last
phone has not gone, so that a new window always takes a new pairing.

From 1.11.3 the board no longer asks the phone for other connection timing, 5 s after it connects, and keeps the
phone's own. That request, landing while the phone pairs and starts encryption, is the likeliest cause of the first
test's drop on reason 0x22. From 1.11.2 the console also says what the link negotiated, `[BT] link: interval 30.00 ms, latency 0, timeout
4000 ms`, `[BT] link: PHY 2M out, 2M in` and `[BT] link: packets up to 251 bytes out, 251 in`; why a security level
was not accepted; and why a link ended, in words: `reason 0x22 (a link-layer exchange got no answer within 40 s)`.

### The status a phone can read

From 1.14.0 the board has a second GATT service, of its own, with one characteristic that says how an update over
Bluetooth stands: the window and its seconds, the image that is arriving or waiting and its version, a refusal and
its reason, how the window ended (installing, discarded, timed out, closed), the version that runs, on trial or
not, the swap the bootloader has to do, and the last update's version, how it came and how it ended, as the record
has it. Read and notify, 64 bytes; the layout is in [`docs/mobile-apps.md`](../docs/mobile-apps.md#the-status-characteristic)
and `src/bt_status.h`.

It needs **no pairing**, because nothing in it is secret: never the passkey or a key, nothing that names the board
or its network. It writes nothing. Everything else is as it was: pairing as before for SMP, whose characteristic
needs an authenticated link, with the image group only, and the same build-time guards in `src/bt_ota.c`. In a
window, the board still asks a phone to pair as soon as it connects.

**After the restart** that an update over Bluetooth asked for, into the new image on trial or back into the old one
(not after a cloud job came in between, and not at a normal boot), the board starts Bluetooth once it has reached the
cloud, or 30 s after the boot, and advertises the status service for 2 minutes, as `Cranium-` and four new hex
digits, so that the phone that sent the image can come back and see how it went. The console says so: `[BT] status
advertised for 120 s after the update over Bluetooth: …`. A link made then is for the status alone: the board asks
for no pairing and refuses one, so no SMP command gets through. It stays while the image is on trial, 5 s after the
trial is over, and 6 minutes at most. Holding Button 1 opens a window as before, which lets such a phone go; it
cannot pair in that window. Wi-Fi and TLS have taken their share of the heap by the time Bluetooth starts, in the
order a person's Button 1 has always found them in.

### What a phone can do

| Command | |
| --- | --- |
| Read the status (from 1.14.0) | Allowed on any link, with no pairing. It carries no secret, and writes nothing |
| `image list` | Allowed on an authenticated link. It is the last step of a proof |
| `image upload` | Allowed on an authenticated link, in a window that takes uploads, until one has arrived |
| `image test`, `image confirm` | **Refused** |
| `image erase` | **Refused** |
| Anything else | Not built in: there is only the image group. No reset, no shell, no files |

All of this is a hook in front of every command, which goes by the policy in `src/bt_ota_policy.c`.
The characteristic also has MCUmgr's own permission for an authenticated link, and
`CONFIG_MCUMGR_GRP_IMG_ALLOW_CONFIRM_NON_ACTIVE_SLOT` is off, which is what would otherwise make an
update permanent, with no revert, from a single command.

MCUmgr's erase takes a slot number from the phone, and on trial the secondary slot holds the image to
go back to. That is why it does not exist here. For the same reason nothing can be uploaded on trial.

This means that Device Manager's **Firmware Upgrade** fails at its last step, when it asks for a
test. The image has arrived by then, and the board offers it. Use **Image Upload** instead.

### What a board with nobody there can be made to do

Nothing that lasts:

- It does not advertise, and its host does not even run, until someone has held the button. The
  cloud, the console, a restart and a stuck button cannot change that: a press only counts when it is
  let go, and one that was already down at boot does not count at all. From 1.14.0 the one exception is
  the restart that a person's Button 1 asked for at the end of an update over Bluetooth: after it the
  board advertises its status for 2 minutes, which any phone may read, and nothing else.
- With the window open and nobody there, an attacker within range needs a passkey that only comes out
  on the serial port. Three wrong tries close it, and it closes by itself anyway.
- Nothing installs without a second press, and nothing a phone sends can ask for a swap.
- An image on trial with nobody there reverts, unless it reaches the cloud by itself.
- A window will not open while a cloud update is under way, or on offer in a build that has offers, or on a board in factory mode
  or not provisioned yet.

It will not open either while the record of a cloud update is waiting. `ota_init()` works out what
became of a job from the running version, so a Bluetooth update in between would have it report
`rolled_back` for an update that went fine. On a board that stays out of Wi-Fi's reach with such a
record, that means no Bluetooth update until it has been online once.

### The trial

An image installed over Bluetooth is not confirmed on boot. Over Wi-Fi the rule is that it must join
Wi-Fi and authenticate to AWS IoT within five minutes, because then it can receive a further update,
and so is safe to keep. On a board with no Wi-Fi in reach that rule would revert every image, so
there it has to be replaced by something that means the same.

**The rule: an image is kept when it can be shown to be able to receive a further update, by whichever
path there is, and no such proof means it reverts.** Either of these:

1. **It reaches the cloud.** The same as any image, and nobody has to do anything. The record says
   `proof: cloud`.
2. **A person proves it over Bluetooth, and only with no Wi-Fi.** That is, the Wi-Fi stack says the
   board is not associated with an access point. On the running image, a person holds Button 1, pairs
   a phone with a new passkey, and reads the image list over that link. That takes the button, the
   console, the controller, an authenticated link, MCUmgr and the external flash, which is the whole
   way a further update would come in. It is also needed that:
   - the image has run for at least 60 s (`CONFIG_APP_BT_OTA_TRIAL_MIN_SECONDS`), with its main loop
     feeding the watchdog, so that it does not fall over soon after starting
   - the board is still provisioned, so that the image can read what TF-M keeps for it
   - the Wi-Fi stack has reported the result of a join attempt, `network not found` being a fine
     result, so that the driver, its firmware and the supplicant all run
   - the link is the one the list was read on

   The record says `proof: person`.

The deadline is the same five minutes, and with neither proof by then the board restarts and the
bootloader goes back. A hang or a crash goes back sooner. The phone has no part in this beyond the
above: it cannot confirm anything. An image that a cloud job installed can only be proved by the
cloud, as before, and so can one on trial with no record of how it got there.

**With Wi-Fi there, a person has no say.** Associated counts, with or without an address, and so does a
Wi-Fi stack that cannot say. An image that has the network and cannot get to the cloud, or cannot even
get an address on it, is exactly what the trial is there to catch, so it reverts.

What this gives up, knowingly: a person can keep an image whose TLS, device key or cloud connection
is broken, because none of that can be tried with no network. Such an image stays, and only another
Bluetooth update can move it. `proof: person` in the record is the way to see which boards that could
be. An image with a broken Bluetooth stack can still be kept by the cloud, and then only the cloud can
move it. A person can also get a bad signed image kept on purpose, but a person at the board could do
much the same with serial recovery.

### The record

There is no job to carry an update like this, so one record of the last one stays in TF-M storage
(`STORE_BT_OTA_RECORD`, 36 bytes), through firmware updates, until a factory reset on an image with this
option. It goes on the console at every boot, and into the device shadow whenever the board connects:

```json
{"bt":{"from":"1.5.0+0","to":"1.6.0+0","result":"succeeded","proof":"person","count":3}}
```

`result` is `pending`, `succeeded`, `rolled_back`, `not_installed`, `trial_lost`, `superseded` (a
cloud job has installed something else since), `flash_error`, or from 1.13.0 `incompatible_board` or
`incompatible_layout` (the image was for another board type or flash layout, and was refused before it
was marked: see [Board type and compatibility](#board-type-and-compatibility)). It is a report of its own, sent
again at every connection, so that it cannot make the regular report too long for its buffer and so
that nothing depends on it arriving.

`not_installed` only says that the image never got as far as `ota_init()`. The bootloader may have
refused it, but it may also have started, and crashed or lost power before that point, and then been
reverted, which is a `rolled_back` by any other name. Only code in the new image could tell, and a cloud
update reports the same.

The console shows the record on its Diagnostics page, and each change of it on its Events page. A board
with its window open reads "Open for an update over Bluetooth" there.

An image built without this option leaves the record where it is and does not look at it, also when
it is factory reset. An image on trial with no knowledge of Bluetooth can only be proved by the cloud.

### Wi-Fi and Bluetooth on this board

Both radios are on 2.4 GHz, and the DK has what it takes to arbitrate between them: the nRF7002's
Packet Traffic Arbiter, wired to the nRF5340 (`nrf_radio_coex`, P0.24, P0.28, P0.29, P0.30), and a
switch on P1.10 between a separate antenna for Bluetooth and a shared one.

**The arbiter is not turned on.** Turning it on means `CONFIG_NRF70_SR_COEX` in the application and
`CONFIG_MPSL_CX` on both cores, which changes how the Wi-Fi driver starts and adds calls after each
join, and Nordic's own samples carry notes about Bluetooth link timeouts when Wi-Fi is granted the
radio, and about a crash, with coexistence on. All of that would be new, and untested here, in the
path the cloud updates depend on. What is lost is performance, not safety: without it the two radios
can collide, and each retries. During a Bluetooth session there is no download to collide with, since
no cloud update can run, only a keep-alive. And a board with no Wi-Fi in reach, which is what this is
for, is not transmitting much. If a person finds that uploads fail or MQTT drops during a session, the
arbiter is the first thing to try.

P1.10 is driven low when Bluetooth starts, for the separate antenna. Nothing else in this project
drives it, and Nordic's documentation describes that as the setting for separate antennas. Nobody has
measured how far apart two antennas this close really are.

### What this does not protect against

- A person at the board with the passkey, who can install any newer image ever signed with this key.
  It is the same person that serial recovery and the debug port already let in.
- Someone who reads the serial port from afar, say on a logged bench, and has a phone in range during
  a window that a person opened. The passkey is only good for one attempt.
- A denial of service during a window: an attacker can fail pairings and close it. A person presses
  again.
- A leaked signing key: the bootloader's check is what decides what runs.
- A compromised application, which can write the secondary slot anyway.
- A controller that stops answering once Bluetooth has been started. The Bluetooth host treats that as
  fatal, so the application halts and the watchdog restarts it, in up to two minutes. Before the first
  press of a boot it cannot happen, because no command goes to the controller. After that it can, even
  with the window closed, because a new private address is set every 15 minutes until the next restart:
  one command, and nothing on the air. A cloud update that was running is then interrupted, as by any
  restart.

### Before relying on it

Stack sizes and the heap have not been measured, because that takes a board with Bluetooth running.
Callbacks of the Bluetooth threads hand everything to the main loop, so that printing does not run on
those stacks, but pairing and the upload still do. On the first bring-up, build with

```sh
-Dapp_CONFIG_THREAD_ANALYZER=y -Dapp_CONFIG_THREAD_ANALYZER_USE_LOG=y -Dapp_CONFIG_THREAD_ANALYZER_AUTO=y \
  -Dapp_CONFIG_THREAD_ANALYZER_AUTO_INTERVAL=10 -Dapp_CONFIG_THREAD_NAME=y
```

and go through a pairing, a whole upload and a proof. Look at:

- The Bluetooth receive thread (2,048 bytes, `CONFIG_BT_RX_STACK_SIZE`), its long work queue (1,800,
  where the keys are worked out through TF-M), its transmit thread (688), the MCUmgr work queue (4,608,
  `CONFIG_MCUMGR_TRANSPORT_WORKQUEUE_STACK_SIZE`, which runs down to the flash driver), and the IPC work
  queue (1,024). Under a quarter free on any of them means raising it.
- `Free heap` in `STATS` before the first press, after it, after an upload, and during a cloud update
  with a window having been open before. It should not be lower than on a build without the option,
  which takes the same `STATS` line. The IPC takes its queues from this heap at the first press.
- TF-M's crypto during a pairing with TLS sessions open: `pairing failed` or a TLS handshake failing
  at that moment would point at its memory (`CONFIG_TFM_CRYPTO_ENGINE_BUF_SIZE`, the same as without
  this option).

The network core's stacks are `hci_ipc`'s own, and nobody here has seen them run on this board either.

### Testing it

Host tests, with no board: `make -C firmware/tests/host` runs `test_bt_ota_policy.c`, every decision;
`test_bt_ota.c`, `src/bt_ota.c` against a fake of the Bluetooth host, MCUmgr and the bootloader that only
reaches what has registered itself for that event; and `test_ota_bt.c`, what the option adds to `ota.c`.
The rest of `ota.c` is compiled there but not exercised: a cloud update stays with `tests/hil/ota_bench.py`.
It also runs the console's, the main loop's and the buttons' tests a second time with the option on.
`test_golden.py` checks that `tools/store_binary.py` keeps such a build out of `binaries/`.

Everything else takes a person, with [nRF Connect Device Manager](https://www.nordicsemi.com/Products/Development-tools/nRF-Connect-Device-Manager)
on a phone, a serial monitor on the console, and the debug port. **Only the first install, with Wi-Fi up,
has been run** ([`docs/test-results.md`](../docs/test-results.md#the-first-update-over-bluetooth-1113-to-1114));
the rest has not.

**Set up.** Build image A, what runs to begin with, and for each install below an image newer than
what runs by then, with the switch. `KIND` keeps their build directories apart:

```sh
KIND=bta firmware/tests/hil/build_image.sh 1.5.1 0 build-bench/images/bt-a.bin -DSB_EXTRA_CONF_FILE=bt_ota_sysbuild.conf
KIND=btb firmware/tests/hil/build_image.sh 1.5.2 0 build-bench/images/bt-b.bin -DSB_EXTRA_CONF_FILE=bt_ota_sysbuild.conf
KIND=hang firmware/tests/hil/build_image.sh 1.5.9 0 build-bench/images/bt-hang.bin -DSB_EXTRA_CONF_FILE=bt_ota_sysbuild.conf \
  -Dapp_CONFIG_APP_TEST_FAULT_HANG=y
```

Then flash the network core and image A, both over the debug port. **Do not leave out `--options`:** the default
erases everything, TF-M storage and provisioning included.

```sh
nrfutil device program --serial-number <probe> --core Network \
  --firmware build-bench/build-bta/hci_ipc/zephyr/zephyr.hex \
  --options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ
nrfutil device program --serial-number <probe> \
  --firmware build-bench/build-bta/app/zephyr/zephyr.signed.hex \
  --options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ
nrfutil device reset --serial-number <probe> --reset-kind RESET_PIN
```

The bootloader stays as it is. Copy the other images to the phone.

**What counts as passing:**

| | Do this | It passes if |
| --- | --- | --- |
| 1 | Scan with the phone before pressing anything | The board is not there |
| 2 | Send `BUTTON\|1` on the console, and press Button 1 briefly | Still not there, and LED1 does not change |
| 3 | Hold Button 1 for 5 s, and let go. Do nothing for 3 minutes | Four flashes, `[BT] open for 180 s`, seen on the phone. Then `[BT] closed`, and gone from the phone |
| 4 | Open it, connect, and type a wrong passkey, three times | `[BT] closed: too many failed pairings` |
| 5 | Open it, connect, and try to upload without pairing, by declining the prompt | Nothing is written |
| 6 | Open it, pair with the passkey from the console, and look at the phone's bond list | Paired for this link, and no bond afterwards |
| 7 | On that link, **Images > Test** and **Confirm**, and **Erase** | Each one refused, `[BT] refused a command` on the console |
| 8 | **Image Upload** of image A, the one that runs | `[BT] refused an upload: it is not newer than what runs` |
| 9 | **Image Upload** of `bt-b.bin` | `[BT] upload started`, then `has arrived`, and LED1 blinks fast. Write down how long it took |
| 10 | Press Button 2 | Slot erased, and `image list` in a next window shows nothing in slot 1 |
| 11 | Upload `bt-b.bin` again, and press Button 1, with Wi-Fi available | Restarts, runs 1.5.2 with a triple flash, reaches AWS IoT, and is confirmed by itself. Record on the console and in the shadow: `succeeded`, `cloud` |
| 12 | Turn off the access point (`CLEAR_WIFI` is not it: the board must stay provisioned). Upload and install a newer image, then do nothing | After 5 minutes it reverts. `rolled_back` on the console |
| 13 | The same, but within 5 minutes hold Button 1, pair, and **Images > Read** | Before 60 s: `[BT] trial: this image has not run for long enough yet`. After that, once `[WIFI] failed reason=network not found` has been seen: `succeeded`, `person`, and it stays after a reset |
| 14 | The same on a board with Wi-Fi up and AWS IoT out of reach, and again on an access point that gives no DHCP lease | `[BT] trial: there is Wi-Fi, so it has to reach the cloud`, and it reverts |
| 15 | Install `bt-hang.bin` | The watchdog fires, and the bootloader goes back. `rolled_back` |
| 16 | Upload a newer image signed with another key, using `imgtool` | It has arrived, and then the bootloader refuses it: `not_installed` |
| 17 | Open a window during a cloud update, and the other way round: a job created during a window | Refused, and the job starts after the window closes |
| 18 | A full **cloud** update with the same image, with Bluetooth not touched | As `tests/hil/ota_bench.py` shows it, no slower |
| 19 | An upload with MQTT up, with a download of something else going on nearby | MQTT stays up. If not, see [Wi-Fi and Bluetooth](#wi-fi-and-bluetooth-on-this-board) |

For 19 the phone's upload time should be compared with one with Wi-Fi off. Do the measurements under
[Before relying on it](#before-relying-on-it) in the same session.

**Going back.** The application is back on a normal image by any way that takes an older one: the
golden image's gesture, or serial recovery, since a cloud update only takes a newer one. The network
core only by the debug port, from a normal build:

```sh
nrfutil device program --serial-number <probe> --core Network \
  --firmware build/netcore_blinky/zephyr/zephyr.hex \
  --options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ
nrfutil device reset --serial-number <probe> --reset-kind RESET_PIN
```

Mixed states should do no harm, and have not been tried. An image with this option on a blinky
network core waits two seconds at the first press, says `the network core does not run the Bluetooth
controller`, and goes on, and does everything else as usual. An image without it on the `hci_ipc`
network core, the golden image for one, never starts the host, so the radio stays off and LED2 stays
dark.

## The nRF5340 DK (Bluetooth only)

The nRF5340 DK is the board type `nrf5340dk` of [`docs/fleet.md`](../docs/fleet.md). It is the nRF7002 DK's SoC
with no nRF7002 next to it: no Wi-Fi, so no AWS IoT, no jobs, no shadow, no events and no location. It updates over
Bluetooth from a phone, or over USB, and it never reaches the cloud by itself: a phone that updates it tells the
console what it saw. The bootloader, TF-M, the signing key, the slot size and the load address are the nRF7002 DK's,
so the console's checks of an image hold for both.

**None of this has run on a board.** It builds, its host tests pass, and the image is checked, as below. What a person
has to try first is under [Not run on a board yet](#not-run-on-a-board-yet).

| | nRF7002 DK | nRF5340 DK |
| --- | --- | --- |
| Main loop | `src/main.c` | `src/bt_only_main.c` |
| Update manager | `src/ota.c`: jobs, downloads, the trial | `src/bt_only_ota.c`: the trial only |
| Wi-Fi, AWS IoT, shadow, heartbeat, jobs, events, commands, location | yes | none of it is in the image: the build fails if it is |
| Passkey for Bluetooth | a new one for each attempt, on the console and in the shadow | [its own](#the-boards-own-passkey), from provisioning; a new one each time only without it |
| Keeping an image installed over Bluetooth | it reaches the cloud, or with no Wi-Fi a person proves it | a person proves it |
| The board's status for the phone | the shadow | [a status characteristic](#what-a-phone-reads) |
| Stuck timers | `wifi_silent`, `no_cloud`, `update_stall` | none: each watches Wi-Fi, the cloud or a cloud update |
| Golden image | 1.5.0, frozen | none frozen: MCUboot has it off |
| LEDs | LED1, LED2 | [LED1 to LED4](#leds-and-buttons) |
| Console commands | all | no Wi-Fi, cloud or certificate commands; `BT_PASSKEY` |
| Board type and layout, TLVs 0xA1 and 0xA2 | `nrf7002dk`, `1` | `nrf5340dk`, `1`: the same partitions, numbered per board type |

`CONFIG_APP_BT_ONLY` is what makes the difference, and nothing in the nRF7002 DK's build changes with it. `sysbuild.cmake`
gives this board `prj_bt_only.conf` in place of `prj.conf`, which is about Wi-Fi and the cloud, and
`boards/nrf5340dk_nrf5340_cpuapp_ns.conf` after it. `Kconfig.sysbuild` leaves the nRF70 driver out for it. What the code
every board shares asks of Wi-Fi and the cloud, `src/bt_only_stubs.c` answers with "there is none". The shadow, the
jobs, the events, the console's commands and the location have no function in this image at all, so code that used them
would not link, and after the link
`bt_only_check.py` looks at the symbol table and the bytes of the image for anything of the cloud: the heartbeat's
JSON, `$aws/things/`, MQTT, AWS IoT, the downloader, Wi-Fi, the network stack, cJSON. It found nothing.

### Build

```sh
scripts/build.sh --board nrf5340dk                    # a release, with the next version, uploaded
scripts/build.sh --board nrf5340dk --keep --no-upload # a try at the version in firmware/app/VERSION
```

or by hand, from an nRF Connect SDK terminal:

```sh
west build -b nrf5340dk/nrf5340/cpuapp/ns --sysbuild firmware/app -d build-nrf5340dk
```

`scripts/build.sh --board nrf5340dk` builds in `build-nrf5340dk/`, and leaves
`binaries/cranium-nrf5340dk-<version>-0.signed.bin`, with `binaries/latest-nrf5340dk.signed.bin` and its `.json`, whose
record says `"board": "nrf5340dk"`. The nRF7002 DK's names, `build/` and `latest.signed.bin` stay what they were.
Versions are one sequence across board types, so one version names one image ([`docs/fleet.md`](../docs/fleet.md)): it
takes the next version above every image in `binaries/`, of either type, and an nRF5340 DK's release needs a number of
its own.

The image carries what it is compatible with, as under [Board type and compatibility](#board-type-and-compatibility):
`0xa1` = `nrf5340dk` and `0xa2` = `1`. Layouts are numbered per board type, and this board's partitions are the nRF7002
DK's, so its first layout is `1`, and `flash_layouts.json` holds its lines, which hash to the same SHA-256 as the nRF7002
DK's layout 1. Its type and layout are defaults in `firmware/app/Kconfig`, next to the nRF7002 DK's
(`CRANIUM_NRF5340DK_LAYOUT`), with the imgtool arguments: a `.conf` cannot set them. `scripts/build.sh` reads both back
from the image, and `flash_layout.py` checks the partitions, as for the nRF7002 DK.

A build of the 1.13.0 source (`firmware/app/VERSION` still says 1.12.0), with the console and Bluetooth, in bytes:

| Image | Used | Of |
| --- | --- | --- |
| Application, flash | 195,000 | 794,474 |
| Application, RAM | 108,336 | 409,600 |
| TF-M, flash | 80,852 | 130,560 |
| TF-M, RAM | 29,836 | 49,152 |
| MCUboot, flash | 43,520 | 65,536 |
| Network core (`hci_ipc`), flash | 133,232 | 262,144 |
| Network core, RAM | 35,168 | 65,536 |
| Signed image | 326,244 | 933,888 |

The application has no link-time optimisation here, which the nRF7002 DK needs to fit, and most of its RAM is the heap
that `bt_ota.conf` sizes for an nRF7002 DK's Wi-Fi and TLS. MCUboot is 6,804 bytes smaller than the nRF7002 DK's,
because it has no golden image.

### Flash it the first time, over USB

The board has no image of ours, and its network core needs the Bluetooth controller, which only the debug port can put
there. Plug the DK in by its USB port (J2, the debug port), close any serial terminal on it, and from an nRF Connect SDK
terminal:

```sh
west flash -d build-nrf5340dk --recover
```

That erases both cores, TF-M storage included, and writes MCUboot, TF-M with the application, and `hci_ipc` on the
network core. The board starts in factory mode: LED1 flashes long every 2 seconds. From then on the application updates
over Bluetooth, or through serial recovery (`tools/recover.py`, as on the nRF7002 DK). The network core only ever
changes over the debug port, from a build of this board:

```sh
nrfutil device program --serial-number <probe> --core Network \
  --firmware build-nrf5340dk/hci_ipc/zephyr/zephyr.hex \
  --options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ
```

**The serial ports.** The console is on `uart0` (P0.20, P0.22), the pins it has on the nRF7002 DK. Nordic's documentation
says that an nRF5340 DK v2.0.0 has two virtual COM ports, the first for the network core's pins (P1.00, P1.01) and the
second for the application's `uart0`; a v1.0.0 has three, with the console the last. `tools/board.py` takes the last
port, so it finds the console either way. MCUboot logs on `uart1`, P1.00 and P1.01, which this firmware does not hand to
the network core: the first port. TF-M logs on P0.25 and P0.26, which are on no virtual COM port of this DK.

### Provision it

```sh
python tools/provision_device.py --board nrf5340dk
```

1. In factory mode, `INIT` with its SoC's identifier, or `--id <name>`. The board restarts.
2. It checks that the board says `board nrf5340dk` in `STATUS`, and stops if not.
3. AWS IoT: a thing `cranium-<SoC id>` with the attribute `board=nrf5340dk`, in the device group, so that the console
   lists it as Bluetooth only. No key and no certificate: it never connects.
4. [The board's own passkey](#the-boards-own-passkey): six digits drawn at random and four hex digits for its name,
   registered with the console first (`PUT /api/devices/{thing}/bluetooth-pairing`), then sent with `BT_PASSKEY`, with the
   console's echo off. The tool never prints the passkey. A board that has one keeps it; `--new-passkey` gives it a new
   one.

It needs the AWS CLI signed in, `cloud/.deploy/outputs.json` and a console token (`CRANIUM_TOKEN` or
`~/.cranium/console-token`). **The console has no such route yet**, and the tool stops at step 4 with nothing sent to the
board. Until it has, `--no-register` provisions the board with no passkey of its own: each pairing then shows a new
passkey on its serial console, as on an offline nRF7002 DK.

### The board's own passkey

On an nRF7002 DK the phone gets the passkey from the shadow, for 150 s. This board has no shadow, and nobody need be at
its serial port, so it keeps one 6-digit passkey, which provisioning draws and the console keeps for the phone:

- It is in TF-M's protected storage, encrypted with a key derived from the hardware unique key, as the other secrets of a
  board are. It is read out for a window, and wiped from memory when the window closes. Nothing shows it: `STATUS|bluetooth`
  says `set`, the console says `pairing with the board's own passkey, which the console has`, and a factory reset or
  `BT_PASSKEY|CLEAR` erases it.
- The board advertises as `Cranium-` and the four hex digits stored with it, in every window, so that the phone knows
  which board it has found, and asks the console's pairing route for that name, before it pairs.
- The Bluetooth host is handed it for LE Secure Connections pairing with MITM protection (`CONFIG_BT_APP_PASSKEY`, only
  with `CONFIG_APP_BT_STATIC_PASSKEY`: `bt_ota.c` stops the build otherwise). Everything else is as on the nRF7002 DK: a
  window only from a held Button 1, three failed pairings close it, no bond is kept.
- A pairing that fails on the passkey (`BT_SECURITY_ERR_AUTH_FAIL`) is counted, in storage, across windows and restarts.
  After 3 (`CONFIG_APP_BT_PASSKEY_FAILURE_BUDGET`) the passkey is locked: the board goes back to a new passkey for each
  attempt, on the console, and advertises a new name each window, until `provision_device.py --board nrf5340dk
  --new-passkey` stores a new one. LED4 lights when that happens.

**What it costs, against a new passkey for each attempt.** A passkey that does not change can be learnt. Passkey entry
commits to it one bit at a time and reveals each round's nonces as it goes, so whoever records one whole pairing, with a
sniffer in range during a window, can work out all 20 bits afterwards: a fresh passkey is worthless by then, this one is
good for the next window. A guess that fails gives away the bit it failed on and every bit it got right before that, two on
average: with a fresh passkey that is worth nothing, and three guesses pair with a chance of 0.0003%; with this one the bits
add up, which is why failures are counted for good, and why 3 lock it: an attacker who guesses from the start pairs before
the lock with a chance of 0.02%, against 2% with a budget of 6. And the console holds a copy, so whoever can read the
console's pairing route can pair with any of these boards while a person has a window open on it.

What does not change: no window without a person holding Button 1 for 5 s, and it closes after 3 minutes; nothing but a
newer image signed with this project's key, for this board type and layout, can be uploaded; nothing installs without a
second press; the image runs on trial and reverts unless a person proves it. A passkey that got out lets someone in
range during a window upload a signed newer image, which a person still has to choose to install, or read the board's
status. Store a new one whenever that may have happened. `src/bt_passkey.h` has all of this, and the arithmetic.

### Update it from a phone

1. At the board, hold **Button 1** for 5 s and let go. LED1 flashes four times: Bluetooth is open for 3 minutes.
2. The phone finds `Cranium-3F9C`, asks the console for its passkey (`GET /api/pairing/Cranium-3F9C`), and pairs with it.
   LED3 lights while it is connected, and LED1 double-flashes once it is paired.
3. The phone reads [the status characteristic](#what-a-phone-reads) and tells the console it saw the board.
4. It uploads the image, as **Image Upload** in nRF Connect Device Manager does, not Firmware Upgrade, whose test command the
   board refuses. LED3 blinks fast while it arrives. As the image's protected TLVs go past, the upload hook refuses an image
   for another board type or flash layout, whatever tool sent it (`refused an upload: it is for nrf7002dk, and this board
   is nrf5340dk`), as [Board type and compatibility](#board-type-and-compatibility) says; an nRF7002 DK image from before
   1.13.0, which says nothing and so is an nRF7002 DK's, at its first piece. LED4 lights.
5. When it has arrived LED1 blinks fast: **Button 1** installs it, **Button 2** erases it. The board restarts, and the
   bootloader swaps it in, about a minute and a half with every LED dark.
6. The new image runs on trial, LED1 flashing three times. **To keep it**, once it has run 60 s, hold Button 1 again, pair,
   and have the phone read the image list (`image list` in SMP). The board confirms it: `succeeded, proof person`. There is
   no Wi-Fi stack to have answered and no cloud to wait for, so that is all a proof takes here. With nobody doing that, the
   trial's deadline restarts it at 5 minutes, unconfirmed, and the bootloader puts the old image back: `rolled_back` at the
   next boot, and LED4.

Without our apps, nRF Connect Device Manager does the same, with the passkey from the console or, with none stored, from
the serial console. An image on trial with no record of how it got there, which only a failed write can leave, cannot be
proved by anyone here, and reverts.

### What a phone reads

After it has paired, a phone reads one GATT characteristic, read-only and only over an authenticated link with a window
open (`src/bt_status.h`):

```text
service         c7a1e000-5f2d-4b9a-9e43-6f1d2c8b3a50
characteristic  c7a1e001-5f2d-4b9a-9e43-6f1d2c8b3a50
```

```json
{"thing":"cranium-fe5b26c0c5b1dcd7","id":"CRVIHAAN01","board":"nrf5340dk","layout":1,
 "fw":{"version":"1.12.0+0","confirmed":true},
 "bt":{"from":"1.11.0+0","to":"1.12.0+0","result":"succeeded","proof":"person","count":3},
 "diary":{"boots":42,"log":["1.11.0+0/1/2","1.12.0+0/2/2"]}}
```

`thing` is the board's AWS IoT name, `id` its device ID, `board` and `layout` what images it takes, `fw` what it runs and
whether that is confirmed, `bt` the [record](#the-record) of the last update over Bluetooth and `diary` the
[boot diary](#boot-diary), in the shapes the shadow has them. It is at most 512 bytes, so a phone reads it with a long
read. The phone checks that `thing` is the board it asked the console about, and sends this to the console as it is, as
`POST /api/devices/{thing}/seen` in [`docs/fleet.md`](../docs/fleet.md). SMP's own commands did not suffice: `image list`
gives the slots but no device ID, board type or diary, and the OS group, which could carry those in its `info`, is not in
this firmware, which has the image group and nothing else. `image list` is still what proves an image on trial.

On an nRF7002 DK this characteristic is off (`CONFIG_APP_BT_STATUS`), because the shadow says all of it.

### LEDs and buttons

| LED | Shows |
| --- | --- |
| LED1, LED2 | What `ui.c` shows on an nRF7002 DK, where the state exists here: a long flash every 2 s, factory mode; a short flash every 2 s, set up but no passkey of its own, so a phone cannot pair without the serial console; LED1 and LED2 taking turns, ready; four flashes, Bluetooth open; double flash, a phone paired; fast blink, an image has arrived; triple flash, on trial |
| LED3 | The phone: on while one is connected, blinking fast while an image arrives |
| LED4 | Trouble: on for 30 s after a failed pairing, a refused command or upload, an image that cannot be installed, a controller that did not start, a locked passkey, or, at boot, an update that did not stay |

The buttons are the nRF7002 DK's: **Button 1** held 5 s opens Bluetooth, and in a window installs what has arrived;
**Button 2** closes a window or erases what has arrived, and held 5 s is a factory reset, which erases the passkey too.
Button 3 and Button 4 do nothing. `src/bt_only.h` has the LEDs, and `src/bt_only_leds.c` drives LED3 and LED4.

### The console

The same console, on the same pins. The Wi-Fi, cloud and certificate commands (`WIFI`, `WIFI_SEC`, `CLEAR_WIFI`, `NET`,
`CLOUD`, `KEYGEN`, `MQTT`, `MQTT_HOST`, `MQTT_RECONNECT`, `RESET_CONFIG`, `STREAM_*`) are still in its table and each
says `ERR not on this board: an nrf5340dk has Bluetooth only, no Wi-Fi and no cloud`, in factory mode too, and before it
could look at what was typed after the name. HELP leaves them out. `STATUS` has the sections `device`, `bluetooth` and
`update`; `device` says `board nrf5340dk` and `layout 1`, as it says `nrf7002dk` and `1` on the other board, and
`bluetooth` has `bt passkey` (`set`, `unset`, `locked`, `unreadable`), `bt failures 0 of 3`, `bt name` and `bt window`.
The status box says `Board nrf5340dk, Bluetooth only` where the nRF7002 DK's says what its Wi-Fi is doing.

| Command | |
| --- | --- |
| `BT_PASSKEY\|<6 digits>\|<4 hex digits>` | store the board's own passkey and the name it advertises, with no failures; refused while a window is open or an update is under way, and for a pattern such as `123456` or `000000` |
| `BT_PASSKEY\|CLEAR` | erase them: each pairing then shows a new passkey here |

### Not run on a board yet

Everything above has run only as a build and as host tests. On the first bring-up, with a serial monitor on the console,
the debug port, and nRF Connect Device Manager:

- That the board boots at all: TF-M, the QSPI flash from the non-secure side, the network core's controller, and the LEDs
  on P0.28 to P0.31.
- Which virtual COM port is which, on this DK's revision.
- Protected storage: `BT_PASSKEY`, a restart, `STATUS|bluetooth` still `set`, and a factory reset that clears it.
- That a phone pairs with the stored passkey, with a wrong one fails and counts, and that three lock it.
- An upload, a refused one for an nRF7002 DK image, the install, the swap from QSPI, the trial, and a proof by a person;
  and the revert with nobody there.
- Reading the status characteristic with a phone, and that it refuses before pairing.
- The stack sizes and the heap, as under [Before relying on it](#before-relying-on-it).

## Golden image

The golden image is one image a person can always go back to, at the board, with no laptop,
no Wi-Fi and no cloud. It is sealed in external flash, and only the bootloader can restore it,
only under a physical gesture, and only if it is the one image pinned by a digest compiled into
the bootloader. There is no cloud, job, console, serial or automatic way to start this.

`CONFIG_CRANIUM_GOLDEN` stays off in the bootloader's `prj.conf` until an image has been frozen, and
is on now: firmware 1.5.0 is the frozen image. With it off nothing of this is built into the bootloader. The one
trace is `golden_partition` in its devicetree, which adds one 16-byte entry to its flash map. With it
on, the bootloader is 50,324 bytes of its 64 KiB in the 1.5.0, 1.6.0 and 1.7.0 builds, against 47,452 with it off.
Both counts include the check on serial recovery's image number, described under
[Who can change it](#who-can-change-it), which is built in either way.

### The gesture

**Only on a board whose bootloader was built with `CONFIG_CRANIUM_GOLDEN=y`. On any other board this
can wipe it.** Its bootloader does not wait for the button, so the application starts with the button
down. Unless the application has the button fix in `ui.c`, letting go then counts as a long press,
which is the factory reset under [Buttons](#buttons). Firmware 1.3.0 and older do not have that fix.

1. Press and hold RESET.
2. Press and hold Button 2.
3. Let go of RESET.
4. Keep holding for 5 s, until LED1 blinks fast.
5. Let go of Button 2 within the next 5 s.

LED1 then stays on while flash is being written. From power-off, hold Button 2 and power on.
RESET goes first because holding Button 2 while the application runs, and letting go, is the
factory reset.

| What the button does | What happens |
| --- | --- |
| Not down when the bootloader reads it | A normal boot. This costs about 100 µs: setting up the pin, one reading of it, and letting it go again |
| Let go before 5 s | A normal boot, nothing written |
| Let go between 5 s and 10 s | The gesture fires |
| Still down at 10 s | LED1 goes off: cancelled. The bootloader waits for the release, so that the application does not start with the button down |
| Still down at 60 s | The bootloader logs it and boots anyway, so that a stuck button cannot brick the board |

A release has to last 100 ms to count, and its time is when the button came up.

### What the bootloader then does

It checks the primary slot and the golden copy before it erases anything. To pass, an area's
bytes must have a good signature (the same check as any image, with the key inside the
bootloader), and their digest must equal the pin.

| Primary slot passes | Golden copy passes | What it does |
| --- | --- | --- |
| no | yes | **Restore**: erase the primary slot, its trailer first and its image header next, then the secondary slot, copy the golden image across, and restart |
| yes | no | **Seal**: erase the golden partition, copy the running image into it, and restart |
| yes | yes | Nothing: one slow blink, and it boots |
| no | no | **Refuse**: three slow blinks, nothing written, and the boot goes on, which ends in serial recovery if no image is valid |

The code cannot start an image, because it has no access to what the bootloader boots. After
writing anything it restarts, so the bootloader's own check on every boot decides whether the
result runs. A restore that is interrupted leaves no valid image and serial recovery, and a repeat
of the gesture finishes the job.

The header goes right after the trailer so that this is true almost at once. Between the two, for the
time of one sector erase (about 86 ms, worked out from how long the whole slot takes), the old image
still boots with no trailer. An image that was on trial loses its revert that way. If it is the target
of an update, the application reports that update as failed with `trial_lost` and not as a success.
Repeat the gesture to finish the restore.

After a restore by the gesture TF-M storage is untouched, so identity, Wi-Fi settings and
certificates remain. There is no trailer and nothing in the secondary slot. `tools/golden.py restore`
goes through serial recovery instead, which writes the primary slot only: there is no trailer either,
but the secondary slot stays as it was, and an image waiting there for a swap would still get it.

### Who can change it

- Only the bootloader writes `golden_partition` in normal use, and only with the bytes of a primary
  slot that passed. The partition is declared in the bootloader's overlay only.
- Serial recovery cannot reach it. An upload names an image number, and MCUboot uses that number with
  no bounds check to look up a flash area in a table, so what lies past the end of the table used to
  pick the target: `golden_partition`, TF-M storage or the bootloader's own partition, with nothing
  locked yet. `golden/src/image_number_guard.c` refuses every number but 0. It is built in with
  `CONFIG_BOOT_FLASH_AREA_HOOKS`, with or without the golden image. A bootloader without it, which is
  every board flashed before this was added, still has the hole. Only a debug-port flash closes it.
- The non-secure application owns the SPI bus of the external flash, so it can erase or damage the
  copy. That loses the way back, and the loss is only noticed at the next gesture, but nothing it
  writes there can be restored, because anything but the pinned image is refused.
- The pin is in the bootloader's write-protected flash, so replacing the image takes a reviewed
  commit and a debug-port flash of the bootloader. Over the air there is no way, and a leaked signing
  key cannot change it.
- The downgrade check does not apply to a restore, which is not a swap, so it is the pin and the
  gesture that close rollback at will. After a restore the version floor is the golden image's,
  and a signed release older than the one that was running becomes acceptable again: revoke a bad
  release on the console.

### Freezing an image

These are the steps as they were done for firmware 1.5.0 on 2026-11-01: the version went in at commit
907d8cd, the image was built from that commit, and the pin went in at commit f9685e9.
`golden_bench.py run G0 G1 G2 G3 G4` did steps 4 to 8 on the board, with the debug port holding the
button.

1. Set a new version in `app/VERSION`, commit, and build from a clean tree, with
   `west build --pristine`. The image lands in `binaries/`. `tools/golden.py freeze` refuses an image
   built with uncommitted changes, a tree with uncommitted changes, an image from before the latest
   commit (`--older-commit` is the way round that) and an image built with `-D` settings, which stay
   in a build directory until it is removed.
2. `python tools/golden.py freeze binaries/cranium-<version>-<build>.signed.bin`. This verifies the
   signature with `keys/fw_signing_pub.pem`, copies the file to `binaries/golden/`, writes
   `golden.json`, and sets the three lines in `app/sysbuild/mcuboot/prj.conf`. Commit those two
   files. From here on the copy in `binaries/golden/` is the golden image, and no other: the next step
   builds the same commit again, which writes a new `binaries/cranium-<version>-<build>.signed.bin` with
   another digest, because TF-M and Zephyr put the build time in their boot banners. For 1.5.0 that
   file came out at 759,060 bytes, and the frozen one is 759,058.
3. Rebuild, and check that the build used the pin with
   `python tools/golden.py check --config build/mcuboot/zephyr/.config`.
4. Save the bootloader that is on the board now: `golden_bench.py run G0` reads it back through
   the debug port, into `binaries/golden/mcuboot-before-golden.hex`.
5. `python tools/golden.py restore --reset --serial-number <probe>` puts the image in the primary slot,
   in about 4 minutes, through the bootloader that is still on the board (G2).
6. Flash the bootloader only. This is the command the bench uses (G3), and its options are what keeps
   TF-M storage and provisioning:

   ```sh
   nrfutil device program --serial-number <probe> --firmware build/mcuboot/zephyr/zephyr.hex \
     --options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ
   nrfutil device reset --serial-number <probe> --reset-kind RESET_PIN
   ```

7. `python tools/recover.py --reset --serial-number <probe> list` shows a hash equal to `hash_tlv` in
   `golden.json`.
8. Do the gesture. The bootloader's log, on the board's first virtual COM port, says `sealed`.
   Do it again, and it says `nothing to do` (G4).
9. When the image has passed the bench on this bootloader, and its over-the-air regression, record
   that: `python tools/golden.py qualify "<the bench run>"`, and commit `golden.json`. The regression
   needs this bootloader, so it comes after the freeze. `golden.py check --qualified` insists on it.
   A run that qualifies has `"rehearsal": false` in `results.jsonl`, with the image's and the
   bootloader's SHA-256, and no `PARTIAL`: `qualify` takes your word for that, and does not read the file.
   This step has not been done for 1.5.0: see [Tests](#tests).

The image file is not in git, because the repository is public. Keep a copy with whoever holds
the signing key.

Any release that changes a stored record has to re-pin: `store_read` needs an exact record size, so
an older image could not read it. Rotating the signing key means a debug-port flash already, so
freeze again in the same session. Do not turn on `CONFIG_MCUBOOT_HW_DOWNGRADE_PREVENTION` without
freezing again, or the counter refuses the golden image.

### Restoring a board

| What you see | What to do |
| --- | --- |
| The image is bad, the golden copy is good | The gesture. It says `restored`, and the board runs the golden image |
| Three slow blinks and `refused`: neither copy is the pinned image | `python tools/golden.py restore --reset --serial-number <probe>` to put the image back, then the gesture, which says `sealed` |
| A restore was interrupted, and the board sits in serial recovery | The gesture again |
| No gesture is possible, or the bootloader has no golden image | `python tools/golden.py restore --reset --serial-number <probe>` |

After `tools/golden.py restore` the secondary slot is as it was, and a gesture does not change that,
because the primary slot then passes and there is nothing to restore. `python tools/recover.py --reset
list` shows whether it holds an image. An image there only runs if a swap was asked for, and serial
recovery never asks for one. With Button 2 stuck down, the bootloader only listens after its 60 s: pass
`--wait 150` to `recover.py`.

### Going back to the old bootloader

The debug port on the DK is open, and the old bootloader has the same key, so the running image
stays valid and what is left in the golden partition is ignored:

```sh
nrfutil device program --serial-number <probe> \
  --firmware binaries/golden/mcuboot-before-golden.hex \
  --options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ
nrfutil device reset --serial-number <probe> --reset-kind RESET_PIN
```

**Do not leave out `--options`:** the default erases everything, TF-M storage and provisioning
included.

**After this, do not do the gesture on this board.** The warning under [The gesture](#the-gesture) applies
to it again. Going back also brings back the hole in serial recovery's image number.

### What this does not protect against

- An unattended board: with a bad image and nobody there, it stays bad. This is the cost of refusing
  every automatic trigger.
- A dead external flash, which loses the golden copy, and which stops the bootloader from booting
  anything, as it does without this feature. Only the debug port helps then.
- A person with hardware access, who can go back to the pinned image and its known flaws. Serial
  recovery still installs any image ever signed with this key, and the debug port is open. A product
  build should drop serial recovery, lock the port and keep the gesture.
- A compromised application, which can erase the copy, and which can read the device's keys. A
  restore removes the application, but does not revoke what it read: retire that board's certificate.
- A compromised application that wants an older image. It can write the primary slot's trailer, and a
  revert skips the downgrade check (`check_downgrade_prevention()` runs for the swap types test and
  permanent). So it can ask for a swap back to an older image in the secondary slot, and the golden
  copy gives it a validly signed older image on a flash chip it controls, with no network needed. It
  still cannot run anything unsigned this way. This was read from MCUboot's source and has not been
  run. The same is true of any older signed image it can get hold of.
- A leaked signing key: the pin limits this path only. Over the air and serial recovery would take the
  attacker's images.
- A golden image that is too old for the cloud. It runs, and cannot update itself: a serial upload moves
  it forward.
- Anything that holds P1.09 low. It is also Arduino pin D7, so a shield that does this delays every boot
  by 60 s, and could fire the gesture if it lets go at the wrong moment.

### Tests

`make -C firmware/tests/host` tests every timing of the gesture, the table above, the order of a
restore's erase, the image number check and the button fix. `python3 firmware/tests/hil/test_golden.py`
tests what the tool refuses and how the bench drives the debug port, and runs the whole bench on a
stand-in for the board. `python3 firmware/tests/hil/golden_bench.py` runs the rest on a board, with no
Wi-Fi but for G15 and G16: see `golden_bench.py plan`. It takes the serial ports and the debug probe, so
it cannot run on a board that stays off USB. By default it needs nobody. It holds the button
from the debug port, by driving P1.09 low once the bootloader has configured the pin, and the bootloader
has no test code for this.

What these tests showed on the frozen 1.5.0 and its bootloader is in the
[test results](../docs/test-results.md#the-golden-image-on-firmware-150), test by test.

G14 is the test of the image number check. It sends the first chunk of an upload for image numbers 1
and 3, which a bootloader without the check maps to the primary and the secondary slot, and each has
to be refused. Then the board must still run the image, and the gesture must find nothing to do. It
does not send the numbers that would reach the bootloader's own partition, TF-M storage or the golden
copy, and it stops on a bootloader without the check, so this bench has never run the hole itself. On
the frozen bootloader both numbers got error 3.

G15 and G16 do the gesture during a real update: G15 while a new image runs on trial, G16 in the middle
of the swap. In both, the board has to end up on the golden image with no revert and no resumed swap,
and the update must not report success. They need Wi-Fi and AWS, and G15 also `--trial-image`. Both
passed on the frozen image. Whether the rest of the over-the-air regression has run is in the
[test results](../docs/test-results.md#over-the-air-on-the-final-firmware).

That stand-in has limits, and a test it cannot finish ends as `PARTIAL`, not `PASS`, with the part that
did not run in its line of `results.jsonl`. It cannot hold the button down into the application, because
every stage of the boot configures the pin again, so G5c leaves out the check in `ui.c` and G5f reaches
it from the input driver on. And it is not a hand. A reading of the pin before the breakpoint would not
be seen on the bench, though with a hand it would stop the gesture: `test_golden.py` checks the source
for one, and only a person can check the rest.

**What needs a person.** A person did G5a to G5e on the frozen image, power cuts included, and all five
passed. What is left is G11, whose power cuts need somebody to pull the cable, and which ends with a seal
by that person:

```sh
python3 firmware/tests/hil/golden_bench.py run G11 --gesture person --power-cuts
```

G4 by a person needs a golden copy that is not sealed yet, because it waits for the board to say it is
sealing. On a board that is already sealed it fails, and that says nothing about the board.

Add `--out <folder>` to choose where the logs and `results.jsonl` go: by default that is
`build-hil-golden/`.

`python tools/golden.py qualify` has not been used, because that needs that run and the over-the-air
regression. `qualifying_bench_run` in `golden.json` is empty until then, and
`golden.py check --qualified` refuses.
