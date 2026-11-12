# Matter over Thread: the nRF7002 DK as commissioner and border router

Issue #197. One board, the nRF7002 DK, in one image:

1. **Thread border router.** It forms and leads a Thread network on its 802.15.4 radio and joins it to the
   Wi-Fi network it is on, so that phones, laptops and the cloud on Wi-Fi reach Thread devices by IPv6.
2. **Matter commissioner.** It adds Matter-over-Thread devices by itself, with no phone and no hub: it finds a
   new device over Bluetooth LE, proves the setup code (PASE), checks the device, gives it the fabric's
   credentials and the Thread network, and then talks to it over Thread (CASE).
3. **Firmware updates over Matter.** The board is a Matter OTA provider: it updates the Thread devices it
   commissioned. The board's own image keeps the update paths it has (MCUboot, over Bluetooth or the debug
   port), because it is the commissioner, not a device on someone else's fabric.

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
| ArmFailSafe, SetRegulatoryConfig, AddOrUpdateThreadNetwork, ConnectNetwork | built: the device joins the board's Thread network |
| Device attestation (Matter test PAA only) | not yet |
| The fabric's root certificate and NOC issuing, CSRRequest, AddTrustedRootCertificate, AddNOC | not yet |
| CASE over Thread, CommissioningComplete, storing the fabric and nodes | not yet |
| OnOff control, OTA provider for the devices | not yet |
| Tested on hardware | nothing yet |

Until CASE is in, a device commissioned this far joins the Thread network and leaves again when its fail-safe
timer ends, as the Matter specification wants for an unfinished commissioning.

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
| `src/policy/matter_policy.c` | setup-code checks, retry and back-off, reconnect versus commission, Thread channel next to Wi-Fi |
| `src/ot_leader.c`, `src/border_router.c`, `src/br/br_unused.c` | Thread leader and SRP server; Wi-Fi join; the border-router parts left out |
| `src/matter_shell.c` | `matter pair`, `matter status`, `matter cancel` |
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
| nRF7002 DK: border router + commissioner (this version) | 832,552 of 954,218 (121,666) | 325,144 of 458,752 (133,608) | 191,860 of 262,144 (70,284); RAM 7,528 free | 37,672 of 49,152 (11,480) |
| nRF5340 DK: commissioner, Thread only | 381,920 (572,298) | 162,976 (295,776) | the same | 32,408 (16,744) |

How the nRF7002 DK image got there, step by step:

| Step | Application flash used |
| --- | --- |
| With the Matter SDK's controller, Wi-Fi and the border router | did not link: about 1,425,000 needed |
| Without the Matter SDK; Wi-Fi, border router, OpenThread commissioner and border agent; nRF70 firmware in external flash | 907,972 |
| Border agent, OpenThread commissioner, TCP, IPv4, WPA3 out; buffers and the Wi-Fi heap sized down | 812,880 |
| The commissioner library up to the Thread join | 832,552 |

The library so far takes about 20 KB. The parts still to come (certificates and their DER signing form,
attestation, CASE, the fabric store, OTA provider) are estimated at 50 to 70 KB, which leaves the target of at
least 40 KB of flash and 8 KB of RAM free.

## Lessons kept from the earlier commissioner

* Check a setup code fully before anything starts; a bad one never leaves the commissioner busy.
* Retry with a growing delay that never gives up; becoming Thread leader is retried the same way.
* A device already on the fabric is reconnected, never commissioned again.
* OpenThread's heap is the system heap, or the SRP server starts without a domain and refuses every
  registration; the domain is checked at start-up as well.
* The prover's SPAKE2+ needs the two Oberon fixes; Bluetooth discovery ends with attr == NULL, which is not a
  match.

## What the owner tests on hardware

Flash the build over the debug port (`west flash` writes the application, MCUboot, the network core and the
nRF70 firmware into external flash). A Matter-over-Thread device that can be factory reset is needed: a retail
one, or a second DK running a Matter light with test certificates. Its 11-digit manual pairing code is enough.

1. Start-up: the log says `Thread up (role leader), SRP server on`. `matter status` says `Thread: leader`.
2. `wifi cred add -s "<network>" -k 1 -p "<password>"`, restart: the log says `Wi-Fi joined, channel N: border
   router backbone up`, and warns if the Thread channel overlaps.
3. A laptop on the same Wi-Fi gets a route to the Thread network's prefix from the board's router advertisement
   (`ip -6 route` or `netstat -rn`).
4. Factory-reset the device, then `matter pair <manual code>`. The log goes `BTP up`, `PASE session up`, then
   the commissioning steps, and ends with `the device is joining this board's Thread network`. A wrong code
   ends with `wrong setup code`.
5. While its fail-safe runs (120 s by default), the device appears on the board's Thread network, and the laptop
   can ping its Thread address.
