# Matter over Thread: the board as commissioner and border router

Issue #197. This is the plan, kept up to date as the work lands. It says what runs where, how it lives next to
the Wi-Fi and Bluetooth the board already uses, what it costs in memory, and what is left out to make room.

## What it is for

One board does three jobs at once:

1. **Thread border router.** The board starts and leads a Thread network on its 802.15.4 radio and joins it to
   the Wi-Fi network it is already on. Phones, laptops and the cloud on the Wi-Fi side can then reach Thread
   devices by IPv6, and Thread devices can reach them.
2. **Matter commissioner.** The board adds Matter-over-Thread devices by itself, with no phone and no hub: it
   finds a new device over Bluetooth LE, proves the setup code (PASE), checks the device's certificate, gives it
   an operational certificate and the Thread network's credentials, then talks to it over Thread (CASE).
3. **Firmware update over Matter.** Next to the two update paths the board has (the cloud over Wi-Fi, and a
   phone over Bluetooth), a Matter OTA path: a laptop or phone on the same Wi-Fi or Bluetooth can send the board
   a new image, and the board can hand images to the Thread devices it commissioned.

**The board that does all three is the nRF7002 DK**: it is the only one with Wi-Fi, so only it can be a border
router. The nRF5340 DK can run the same image as a Thread-only commissioner, which is useful for testing but
not the goal.

Nordic ships nothing for this. Its Matter support only builds the device side (a light, a lock), its Bluetooth
layer only advertises, and none of its samples is a commissioner or a border router. So the commissioner and
the router are this project's own code, not a Nordic sample adapted. The approach comes from a working
on-device commissioner built earlier on an nRF54L15 DK, which commissioned a retail Matter-over-Thread light
from start to finish while also leading the Thread network; its parts are ported here (see
[What is reused](#what-is-reused)).

## Our code, and the libraries it links

| Ours (`firmware/matter/`) | What it does |
| --- | --- |
| Bluetooth central for Matter (`ble_central`) | scans for a device by its discriminator, connects, finds the CHIPoBLE service, subscribes and writes: the transport Matter's commissioning runs over, which the SDK lacks |
| Commissioner (`controller_client`, `attestation`) | sets up the fabric, keys, certificate issuer and the commissioning sequence; checks the device's certificates (Matter test PAA only) |
| Thread leader and border router bring-up (`thread_srp`, `border_router`) | forms the network with a random dataset, becomes leader, runs the SRP server, joins Wi-Fi and makes it the border router's backbone |
| Commissioning rules (`policy/`) | setup-code checks, retry and back-off, reconnect versus re-commission; plain C with host tests |
| Shell commands, start-up, update hooks | `matter controller ...` commands; the order everything starts in |
| SDK patches (`sdk/patch_sdk.py`) | six small changes the SDK needs for a commissioner to build and to finish PASE |
| Build variant | its own Kconfig, sysbuild, flash layout and data model, not a Nordic sample's |

| Linked, open source | Why not ours |
| --- | --- |
| connectedhomeip, the Matter SDK (Apache 2.0) | Matter itself: message formats, PASE/CASE, certificates, the controller state machine. Writing the protocol again would take months and fail certification; the same code runs in every Matter controller, phones included. We use its controller library, which Nordic's build leaves out. |
| OpenThread (BSD) | Thread itself, the SRP server and the border-routing logic |
| Zephyr (Apache 2.0) with its OpenThread border-router glue, the nRF70 Wi-Fi driver, MCUboot | the OS, the IP stack, the Wi-Fi chip, the bootloader the board already uses |
| Nordic's radio firmware for the network core (`ipc_radio`), Oberon crypto | the radio drivers and the crypto the SDK provides |

## Which core runs what

The nRF5340 has two cores. On the nRF7002 DK the nRF7002 chip adds Wi-Fi.

| Where | Runs |
| --- | --- |
| nRF5340 network core | `ipc_radio`: the Bluetooth LE controller **and** the 802.15.4 radio driver together (multiprotocol, Nordic's MPSL shares the one radio). It replaces `hci_ipc`, which only does Bluetooth. |
| nRF5340 application core | Zephyr, OpenThread (full Thread device, leader, SRP and DNS-SD server), Zephyr's OpenThread border router with Wi-Fi as the backbone, the Matter stack with the controller library, the Bluetooth host as central (commissioning) and peripheral (updates), MCUboot. |
| nRF7002 (nRF7002 DK only) | Wi-Fi 2.4/5 GHz, station mode: the border router's backbone link. |

The nRF5340 DK has no Wi-Fi chip. On it the same image runs without a backbone: the board leads the Thread
network and commissions devices onto it, which is exactly what the nRF54L15 version did. Nothing outside the
Thread network can reach those devices.

## How it lives next to Wi-Fi and Bluetooth

* **One 2.4 GHz radio on the nRF5340, shared in time.** MPSL gives Bluetooth and 802.15.4 turns. Bluetooth is
  busy only while a device is being commissioned (a minute or two) or a phone is sending an update; the rest of
  the time Thread has the radio.
* **Wi-Fi and Thread are both 2.4 GHz.** The nRF7002 and the nRF5340 radio share the coexistence lines of the
  DK, and the Thread channel is picked away from the Wi-Fi channel (Thread 25 or 26 next to Wi-Fi 1 or 6; Thread
  15 next to Wi-Fi 11 is the worst case). Wi-Fi on 5 GHz avoids the question.
* **Bluetooth roles.** The existing update over Bluetooth is a peripheral (a phone connects to the board).
  Commissioning needs the board as a central (it connects to the new device). The controller runs both, with
  two links at most.

## The build: a separate variant, not the existing image

The image boards run today has about 1 KB of RAM free on the nRF7002 DK and 45 KB of flash. Matter, OpenThread
and the border router need several hundred KB of each, so they cannot be added to it. The Matter build is a
separate application, `firmware/matter/`, built for the same boards:

```sh
cp -c -R /opt/nordic/ncs/v3.4.0 ~/ncs-matter                     # a copy-on-write copy of the SDK (macOS)
python3 -I firmware/matter/sdk/patch_sdk.py ~/ncs-matter          # the six SDK changes, below
export ZEPHYR_BASE=~/ncs-matter/zephyr
west build -b nrf7002dk/nrf5340/cpuapp --sysbuild firmware/matter   # Wi-Fi backbone
west build -b nrf5340dk/nrf5340/cpuapp --sysbuild firmware/matter   # Thread only
```

Without the patched SDK the build stops at once and says so. `firmware/matter/VERSION` is a link to
`firmware/app/VERSION`, so both images carry the same version number.

### Using it

Over the serial console (the DK's first virtual COM port, 115200 baud), with the Matter shell:

```
wifi cred add -s "<network>" -k 1 -p "<password>"     # nRF7002 DK only, once; then restart
matter controller pairing code <node id> <manual code or MT:... QR payload>
matter controller invoke-cmd <node id> <endpoint> 6 2  # On/Off cluster, Toggle
```

At start-up the board forms a Thread network if it has none (random keys and PAN ID, channel
`CONFIG_CRANIUM_THREAD_CHANNEL`, 25 by default), becomes leader, turns the SRP server on and starts the
commissioner. On the nRF7002 DK it joins the stored Wi-Fi network, and the border router starts once Wi-Fi is
up; the log warns when the Thread channel overlaps the Wi-Fi channel and names one that does not. A setup code
is checked (length, check digit, passcode rules) before anything starts.

The data model in `src/default_zap` is the Matter code generator's root node, the smallest it makes; the
commissioner serves nothing from it yet (`src/empty_provider.cpp` answers every request).

It shares the signing key, MCUboot and the version number with the main firmware. A board runs one or the
other; switching between them is a flash over the debug port, because the flash layouts differ (below).

**Left out of the Matter variant**, to make room:

| Dropped | Why it can go | Comes back by |
| --- | --- | --- |
| TF-M (the secure partition) | 128 KB flash and 48 KB RAM; Nordic's own Matter builds for the nRF5340 run without it | flashing the main image |
| AWS IoT: MQTT, TLS, the cloud jobs and the HTTPS downloader, Memfault | the largest part of the main image; the border router keeps the board on Wi-Fi | flashing the main image, or a later version once memory allows |
| The serial console's provisioning commands, the golden image | the Matter shell takes the console | flashing the main image |
| Firmware update from the cloud | it rides on the AWS IoT jobs above | Matter OTA and Bluetooth stay |

**Kept:** MCUboot with the team's signature check and swap with revert. Firmware update over Bluetooth (SMP)
and over Matter are the next steps (see [Order of work](#order-of-work)): until then the variant is installed and
updated over the debug port.

The flash layout is this variant's own (`firmware/matter/boards/matter_partitions.dtsi`): MCUboot 32 KB, the
application 956 KB and settings 36 KB in internal flash, and the second image slot in the DK's external flash. It is not one
of the layouts in `firmware/app/flash_layouts.json`, so a board refuses to install a Matter image sent from the
console as an update, and the other way round: changing between the two is a debug-port flash.

### SDK changes

The commissioner needs six small changes to the SDK's Matter and Oberon crypto modules: three that let the
controller library build and plug the Bluetooth central in, and three fixes to the SPAKE2+ prover side (the
commissioner's side of PASE, which no Nordic sample uses). They are in `firmware/matter/sdk/patch_sdk.py`, which
is idempotent and checks every anchor. The build never changes the shared SDK in place: locally it patches a
copy-on-write clone of the SDK, and in CI the job's own SDK after it has been cached.

## Memory, per board

Estimates first; each is replaced by a real build's numbers as the parts land (CI reports them on every build
from the `Matter (nRF7002 DK)` and `Matter (nRF5340 DK)` jobs, against floors in `tools/memory_budgets.json`).

| Part | Flash (est.) | RAM (est.) |
| --- | --- | --- |
| Zephyr, MCUboot hooks, Bluetooth host (central + peripheral), SMP | 120 KB | 40 KB |
| OpenThread FTD, SRP and DNS-SD server | 170 KB | 45 KB |
| Border router (routing, mDNS, NAT64 off) | 60 KB | 30 KB |
| Matter stack with the controller library | 520 KB | 150 KB |
| Wi-Fi driver and supplicant (nRF7002 DK only) | 180 KB | 90 KB |
| **nRF7002 DK** | **about 1,050 of 956 KB** | **about 355 of 512 KB** |
| **nRF5340 DK** | **about 870 of 956 KB** | **about 265 of 512 KB** |

So the nRF5340 DK fits; the nRF7002 DK is over in flash by about 100 KB at first and needs trimming: the Wi-Fi
firmware patches move to external flash (about 70 KB), logs drop to errors, the Matter shell goes. If that is
not enough, code can run from external flash (QSPI XIP), which is the last resort.

## Order of work

1. This plan.
2. The variant builds: Thread leader and border router, multiprotocol network core, both boards. Real memory
   numbers, CI jobs and floors.
3. The commissioner: the controller library, the Bluetooth central, the Thread dataset handed to devices,
   commissioning by shell command (`matter controller pairing ...`) with the robustness rules below.
4. Matter OTA: the board as OTA requestor (it takes an image from an OTA provider on the network, into MCUboot's
   second slot) and, later, as OTA provider to its own devices.
5. Board tests by the owner.

## Lessons kept from the earlier commissioner

From the nRF54L15 work and from fixing commissioning in a production hub:

* Check a setup code fully before anything starts; a bad one must not leave the commissioner busy.
* Retry the Bluetooth scan, and become Thread leader again if that fails, with a bounded back-off that never
  gives up for good.
* After a restart, reconnect to devices quickly (about 10 s for mains-powered ones), not after a minute.
* A device already on the fabric is reconnected, never commissioned again: a commissioned device stops
  advertising, and a second commissioning only fails after its full timeout.
* OpenThread's heap must be the system heap, or the SRP server starts without a domain and refuses every
  registration. The Matter task needs a 16 KB stack once certificates are parsed.
* A device needs a factory reset after the commissioner's flash is erased, because the fabric is gone.

These rules are plain C in `firmware/matter/src/policy/` and have host tests.

## What is reused

From the nRF54L15 commissioner: the Bluetooth central for CHIPoBLE (scan by discriminator, connect, GATT
discovery, indications and writes), the controller set-up (storage, keystores, credentials issuer,
DeviceCommissioner and AutoCommissioner), the Thread leader with the SRP server, the attestation verifier for
development, the shell commands, and the SDK patches. Left behind: its demo, its fixed test device, and every
setup code, network name and key in it. This repository uses only the Matter test vendor (0xFFF1) and test
certificates, marked as such.

## What the owner tests on hardware

On the nRF7002 DK, with the Matter image flashed over the debug port, and a Matter-over-Thread device that can
be factory reset (a retail one, or a second DK running a Matter light with test certificates):

1. The board forms the Thread network, becomes leader, and joins Wi-Fi.
2. A laptop on the same Wi-Fi sees the border router (`_meshcop._udp`) and can ping a Thread device.
3. `matter controller pairing code <node> <setup code>` commissions the device; `matter controller invoke`
   turns it on and off.
4. After a restart the board reconnects to it without commissioning again.
5. An image sent from a Matter OTA provider on the laptop installs and is confirmed.
