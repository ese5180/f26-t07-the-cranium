# Matter over Thread: the nRF7002 DK as commissioner and border router

Issue #197. One board, the nRF7002 DK, in one image:

1. **Thread border router.** It forms and leads a Thread network on its 802.15.4 radio and joins it to the
   Wi-Fi network it is on, so that phones, laptops and the cloud on Wi-Fi reach Thread devices by IPv6.
2. **Matter commissioner.** It adds Matter-over-Thread devices by itself, with no phone and no hub: it finds a
   new device over Bluetooth LE, proves the setup code (PASE), checks the device, gives it the fabric's
   credentials and the Thread network, and then talks to it over Thread (CASE).
3. **Firmware updates over Matter, both ways.** A phone adds the board to its own Matter fabric (over Bluetooth,
   with the board's test onboarding code) and then sends the board its own firmware: the board is an OTA
   requestor, the phone app the OTA provider, the image goes over BDX on Wi-Fi into MCUboot's second slot. And
   the board is itself an OTA provider for the Thread devices it commissioned.

Nordic ships nothing for (1) on Zephyr or for (2) at all, and the Matter SDK's own commissioner does not fit next
to Wi-Fi and the border router in the nRF5340's 1 MB of flash (it needed about 1.4 MB). So the commissioner is
this project's own compact library, and the border router's platform code is built and adapted here.

## What is done, and what is not yet

| Part | State |
| --- | --- |
| Thread leader with SRP and DNS-SD server | built, on both DKs |
| Border router on Wi-Fi (routing, SRP advertising proxy, mDNS) | built, on the nRF7002 DK; nRF70 firmware in external flash |
| Bluetooth central for commissioning, BTP | built |
| PASE (SPAKE2+ prover through PSA) and its session | built |
| ArmFailSafe, SetRegulatoryConfig | built |
| Device attestation: DAC and PAI chained to the built-in Matter test PAAs, the AttestationResponse signature and nonce | built, host-tested with the Matter SDK's test certificates |
| The fabric: root CA and the board's own NOC (keys as persistent PSA keys), CSRRequest, AddTrustedRootCertificate, AddNOC | built; certificate conversion host-tested byte for byte against the Matter SDK's vectors |
| AddOrUpdateThreadNetwork, ConnectNetwork | built |
| CASE (Sigma1 to Sigma3) over Thread with MRP, CommissioningComplete | built; destination ID, compressed fabric ID and IPK host-tested against the specification's vectors |
| Fabric and nodes kept in settings; sessions reopened after a restart (10 s, then growing delays) | built |
| OnOff from the shell (`matter onoff`) | built |
| OTA provider: CASE as responder, QueryImage, BDX download, ApplyUpdate, NotifyUpdateApplied; image store; AnnounceOTAProvider | built |
| The board as a device a phone adds: CHIPoBLE advertising, BTP as peripheral, PASE as verifier, the device's Interaction Model server (Descriptor, Access Control, Basic Information, General Commissioning, Network Commissioning for Wi-Fi, Operational Credentials with the test DAC/PAI/CD, OTA Requestor), CASE as responder on the phone's fabric with its ICAC, DNS-SD on Wi-Fi | built; the commissioning commands host-tested in the order a phone sends them |
| The board's own update from the phone: AnnounceOTAProvider, QueryImage, BDX download into MCUboot's second slot, ApplyUpdate, restart, confirm, NotifyUpdateApplied | built |
| Tested on hardware | nothing yet |

Not checked yet in attestation: validity dates (the board has no trusted clock), the certification
declaration's signature, revocation. A device with production credentials needs its PAA added
(`src/matter/mt_test_paa.c` holds the trusted ones).

## Our code, and what it links

| Ours (`firmware/matter/`) | What it does |
| --- | --- |
| `src/matter/mt_tlv.c` | Matter TLV, read and write |
| `src/matter/mt_btp.c` | BTP: handshake, segmenting and reassembly, acknowledgements |
| `src/matter/mt_msg.c` | message and protocol headers, the AES-CCM nonce, the message counter window, status reports |
| `src/matter/mt_im.c` | Interaction Model client: InvokeRequest, ReadRequest, InvokeResponse, StatusResponse |
| `src/matter/mt_pase_msg.c` | PASE message bodies |
| `src/matter/mt_crypto.c` | PSA crypto: SHA-256, HKDF, AES-CCM, PBKDF2 and the SPAKE2+ prover |
| `src/matter/mt_ble.c` | Bluetooth central: scan by discriminator, connect, CHIPoBLE characteristics, indications, writes |
| `src/matter/mt_commission.c` | the commissioning sequence and the PASE session |
| `src/matter/mt_der.c`, `mt_cert.c` | ASN.1 DER; Matter certificates from TLV to X.509 and back, issuing RCAC and NOCs |
| `src/matter/mt_attest.c`, `mt_test_paa.c` | X.509 parsing, device attestation, CSR checks; the Matter test PAAs |
| `src/matter/mt_fabric.c` | the fabric: PSA keys, certificates, IPK, compressed fabric ID, node list in settings |
| `src/matter/mt_case_msg.c`, `mt_controller.c` | CASE both ways; SRP lookup, MRP over UDP, commands to devices, reconnecting |
| `src/matter/mt_server.c`, `mt_bdx.c`, `mt_ota.c`, `mt_ota_store.c` | the OTA provider: CASE responder, OTA commands, BDX, the image store |
| `src/policy/matter_policy.c` | setup-code checks, retry and back-off, reconnect versus commission, Thread channel next to Wi-Fi |
| `src/ot_leader.c`, `src/border_router.c`, `src/br/br_unused.c` | Thread leader and SRP server; Wi-Fi join; the border-router parts left out |
| `src/matter_shell.c` | `matter pair`, `status`, `cancel`, `nodes`, `onoff`, `forget`, `ota ...` |
| `tools/matter_ota_upload.py` | stores an OTA image on the board over its serial console |
| `sdk/patch_sdk.py` | six small changes to the SDK (below) |

| Linked | Why |
| --- | --- |
| OpenThread (BSD) | Thread itself, SRP, the border-routing logic |
| Zephyr's OpenThread border router: its glue and its platform code (infra interface, UDP and mDNS sockets), Apache 2.0 | the link between OpenThread and Zephyr's IP stack. This SDK does not build it; `firmware/matter/CMakeLists.txt` does, patched for this SDK's older OpenThread |
| Zephyr, its Bluetooth host, the nRF70 Wi-Fi driver and WPA supplicant, MCUboot | the OS, the radios, the bootloader |
| PSA crypto with Oberon | all cryptography: nothing of Matter's crypto is written here |
| `ipc_radio` on the network core | the Bluetooth controller and the 802.15.4 driver together |

No connectedhomeip and no mbedTLS X.509 are in the image. The approach to the Bluetooth central and the Thread
leader comes from an earlier commissioner built on an nRF54L15, which commissioned a retail Matter light end to
end; that one used the Matter SDK's controller, which is what does not fit here.

## Which core runs what

| Where | Runs |
| --- | --- |
| nRF5340 network core | `ipc_radio`: Bluetooth LE controller and 802.15.4 radio together (MPSL shares the one radio) |
| nRF5340 application core | Zephyr, OpenThread (leader, SRP), the border router, the Wi-Fi supplicant, the Bluetooth host as central and peripheral, the commissioner library, MCUboot |
| nRF7002 | Wi-Fi station: the border router's backbone. Its firmware is read from the DK's external flash at start-up |

The nRF5340 DK has no Wi-Fi: on it the same image is commissioner and Thread leader with no backbone.

## How it lives next to Wi-Fi and Bluetooth

* Bluetooth and 802.15.4 share the nRF5340's radio in time (MPSL). Bluetooth is busy only while a device is
  commissioned.
* Wi-Fi and Thread are both 2.4 GHz. The Thread channel (`CONFIG_CRANIUM_THREAD_CHANNEL`, 25 by default) is used
  when the board forms a network; when Wi-Fi comes up, the log warns if the two overlap and names a Thread
  channel that does not (`mp_pick_thread_channel()`). Wi-Fi on 5 GHz avoids the question.

## The build

A separate application from the main image, `firmware/matter/`, with the same version number
(`firmware/matter/VERSION` is a link to `firmware/app/VERSION`):

```sh
cp -c -R /opt/nordic/ncs/v3.4.0 ~/ncs-matter                    # a copy-on-write copy of the SDK (macOS)
python3 -I firmware/matter/sdk/patch_sdk.py ~/ncs-matter         # never on a shared SDK install
export ZEPHYR_BASE=~/ncs-matter/zephyr
west build -b nrf7002dk/nrf5340/cpuapp --sysbuild firmware/matter  # commissioner and border router
west build -b nrf5340dk/nrf5340/cpuapp --sysbuild firmware/matter  # commissioner, Thread only
```

**Left out of this image**, compared with the main one: TF-M, AWS IoT and the cloud updates, Memfault, the
serial console's provisioning commands and the golden image. Within Wi-Fi and Thread: IPv4 and NAT64, TCP,
WPA3 (WPA2 joins a WPA2/WPA3 network), OpenThread's border agent and its own Thread commissioner, TREL and DHCPv6
prefix delegation. Logs are warnings and errors except this project's own.

**Flash layout** (`boards/matter_partitions.dtsi`, `boards/nrf70_patch_partitions.dtsi`): MCUboot 48 KB, the
application 940 KB, settings 36 KB in internal flash; in the external flash the second application slot, the
nRF70 firmware (128 KB, MCUboot's second image) and a slot for updating it. It is not a layout the main image's
updates accept, so switching between the two images is a debug-port flash.

### SDK changes

Six, in `sdk/patch_sdk.py`, idempotent and checked: two in the Oberon SPAKE2+ driver so that the prover can send
its confirmation before checking the device's (the order PASE uses, which no Nordic build exercises), and four
that let Zephyr's border router glue and platform code build against this SDK's OpenThread, which is older than
the one they were written for. CI patches its own copy of the SDK after restoring it from the cache.

## Memory, per board

From real builds (bytes; free in brackets). CI builds both on every push (`Matter (nRF7002 DK)`,
`Matter (nRF5340 DK)`) against floors in `tools/memory_budgets.json`.

| Build | Application flash | Application RAM | Network core | MCUboot flash |
| --- | --- | --- | --- | --- |
| nRF7002 DK: border router, commissioner, OTA provider, and the board as a device (light, subscriptions, OTA requestor, self test) | 888,448 of 954,218 (65,770) | 369,728 of 458,752 (89,024) | 191,860 of 262,144 (70,284); RAM 7,528 free | 37,688 of 49,152 (11,464) |
| nRF5340 DK: the same without Wi-Fi | 438,168 (516,050) | 206,600 (252,152) | the same | 32,424 (16,728) |

How the nRF7002 DK image got there:

| Step | Application flash used |
| --- | --- |
| With the Matter SDK's controller, Wi-Fi and the border router | did not link: about 1,425,000 needed |
| Without the Matter SDK; nRF70 firmware in external flash | 907,972 |
| Border agent, OpenThread commissioner, TCP, IPv4, WPA3 out; buffers and the Wi-Fi heap sized down | 812,880 |
| Commissioner up to the Thread join | 832,552 |
| Attestation, certificates, fabric store (persistent PSA keys) | 842,452 |
| CASE, MRP, CommissioningComplete, reconnecting, OnOff | 851,316 |
| OTA provider (CASE responder, BDX, image store) | 859,828 |
| The board as a device: peripheral, PASE verifier, device clusters, OTA requestor | 883,580 |
| The light on endpoint 1, subscriptions, `matter selftest` | 888,448 |

The target was at least 40 KB of flash and 8 KB of RAM free; there are 64 KB and 87 KB.

## Lessons kept from the earlier commissioner

* Check a setup code fully before anything starts; a bad one never leaves the commissioner busy.
* Retry with a growing delay that never gives up; becoming Thread leader is retried the same way.
* A device already on the fabric is reconnected, never commissioned again.
* OpenThread's heap is the system heap, or the SRP server starts without a domain and refuses every
  registration; the domain is checked at start-up as well.
* The prover's SPAKE2+ needs the two Oberon fixes; Bluetooth discovery ends with attr == NULL, which is not a
  match.

## Firmware updates over Matter

**The board's own firmware, from the phone.** The board carries the Matter SDK's published TEST device
credentials (vendor 0xFFF1, product 0x8000; DAC, PAI and certification declaration generated into the build from
the SDK, no key in this repository), passcode 20202021 and discriminator 3840: QR `MT:Y.K9042C00KA0648G00`, manual
code `34970112332`, printed at start-up and by `matter device`. A phone app with Matter support adds the board over
Bluetooth (the app has to accept test credentials), gives it the Wi-Fi network, and from then on reaches it over
Wi-Fi. To update it, the app acts as OTA provider with a signed MCUboot image of this variant and announces itself
(AnnounceOTAProvider); the board asks QueryImage, downloads the image over BDX into MCUboot's second slot, asks
ApplyUpdate, restarts into the new image as a test and confirms it once it runs. NotifyUpdateApplied is sent when
the board can reach the phone again. Only images of this variant (same flash layout) can be installed this way.

**The board's devices, from the board.** The board is the OTA provider for the devices it commissioned:

1. Store the image on the board: `python3 tools/matter_ota_upload.py --port <serial port> --vid <vendor> --pid
   <product> --version <number> --name <file name> <image.ota>` (an image the device's maker built for Matter
   OTA, with a newer software version than the device runs).
2. `matter ota announce <node>` tells the device (AnnounceOTAProvider). It opens CASE to the board, asks
   QueryImage, downloads the image over BDX, asks ApplyUpdate, restarts into it and reports NotifyUpdateApplied.

## Test it: does Matter work on this board?

One command, with the Matter image on the board and its USB cable in this computer:

    pip install pyserial bleak zeroconf     # bleak and zeroconf are optional: without them those rows are skipped
    python3 tools/matter_check.py --port /dev/tty.usbmodemXXXXXXXX

It prints one row per check and a verdict at the end (`VERDICT: PASS` or `VERDICT: FAIL`). A row whose tool is
missing says SKIP, never FAIL.

| Row | What it checks |
| --- | --- |
| shell | the Matter image answers on the serial port |
| selftest | `matter selftest` on the board: TLV, SHA-256, the CASE destination ID and fabric IDs, SPAKE2+ both ways, ECDH and AES-CCM, the test certificates, the onboarding codes, Thread leader, SRP server, flash areas; each against the Matter specification's or SDK's known answers |
| thread | `matter status`: Thread up as leader (or router) and the SRP server running |
| onboarding codes | the board prints the SDK's test codes `MT:Y.K9042C00KA0648G00` and `34970112332`, decoded and check-digit checked |
| bluetooth advert | the board advertises as commissionable (discriminator 3840), seen from this computer with bleak |
| wifi | the board is on Wi-Fi; `--wifi` joins it from `MATTER_WIFI_SSID` and `MATTER_WIFI_PASSWORD` (never printed) |
| mdns | `_matter._tcp` from this computer once the board is commissioned (`dns-sd -B` on macOS, else zeroconf). `_matterc._udp` is not used: the board is commissioned over Bluetooth |
| chip-tool ... | with `chip-tool` on the PATH and the Wi-Fi variables set: commission over Bluetooth and Wi-Fi, read Basic Information, toggle the light (LED 2), restart the board and read again, and with `chip-ota-provider-app` and `--ota-image` announce an update |

The same run as a test: `MATTER_PORT=/dev/tty.usbmodemXXXXXXXX python3 firmware/tests/hil/test_matter_check.py`
(CI runs the rest of that file and skips the board).

### With an iPhone, in Apple Home

The board uses Matter test credentials (vendor 0xFFF1, product 0x8000), which Apple Home accepts with a warning.

1. Home app, +, Add Accessory, and scan the QR code for `MT:Y.K9042C00KA0648G00` (any QR generator makes it
   from that text) or choose More options and type `3497-011-2332`.
2. Home says it is an uncertified accessory: Add Anyway. It asks for a Wi-Fi network for the board and adds it.
3. The board shows up as a light. Toggling it in Home turns LED 2 on and off.
4. Restart the board (`matter reboot` or the reset button): it comes back in Home after a few seconds and still
   toggles.

The iPhone 17 Pro has a Thread radio, but Home does not need it here: Home reaches the board over Wi-Fi, and the
board leads its own Thread network for the devices it commissions.

## What the owner tests on hardware: the phone adds the board and updates it

Needs the phone app's Matter support (the paired app pull request). On the nRF7002 DK, freshly flashed:

1. The log prints `add this board in the app: QR MT:Y.K9042C00KA0648G00, code 34970112332` and
   `commissionable over Bluetooth for 15 minutes`.
2. In the app, add the board with that code: the log shows `a phone connected`, `PASE session up with the phone`,
   `on the phone's fabric ...`, `the phone (node ...) opened a session`, `commissioned by the phone`, and
   `advertised on Wi-Fi as ..._matter._tcp`.
3. In the app, send a newer signed image of this variant: `the phone offers version ...`, `downloading ...`,
   `new image ... in place: restarting into it`, and after the restart `new image confirmed`.

## What the owner tests on hardware: the board commissions a device

Flash the build over the debug port (`west flash` writes the application, MCUboot, the network core and the
nRF70 firmware into external flash). A Matter-over-Thread device that can be factory reset and uses Matter test
credentials (vendor 0xFFF1 or 0xFFF2), for example a second DK running the SDK's Matter light bulb sample. Its
11-digit manual pairing code is enough.

1. Start-up: the log says `Thread up (role leader), SRP server on`; the first time, `new fabric ...`.
2. `wifi cred add -s "<network>" -k 1 -p "<password>"`, restart: `Wi-Fi joined, channel N: border router
   backbone up`.
3. A laptop on the same Wi-Fi gets a route to the Thread network's prefix (`ip -6 route` or `netstat -rn`).
4. Factory-reset the device, `matter pair <manual code>`: `BTP up`, `PASE session up`, `attestation passed`,
   `NOC issued: node ...`, `CASE session up`, `node ... commissioned`. `matter nodes` lists it.
5. `matter onoff <node> toggle`: the light toggles, `done`.
6. Restart the board: after about 10 s, `node ... is back`; `matter onoff` works without pairing again.
7. With a newer image of the light stored (above), `matter ota announce <node>`: `QueryImage ... update
   offered`, `sending ...`, `image sent`, `applies version ...`, and after the light restarts, `runs the new
   version`.
