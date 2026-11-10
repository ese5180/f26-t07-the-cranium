# Raspberry Pi image updates through the board

From firmware 1.20.0, a board wired to a Raspberry Pi can update the Pi. An AWS IoT job brings a signed
image. The board downloads it over HTTPS onto a microSD card, checks it, and sends it over SPI to the Pi's
partition B. This page covers the board's side: the design, the wiring, the SPI protocol that the Pi's
side has to implement, the limits, and what has not run on hardware yet. The Pi's side is separate work.

**In short:**

- The image travels the way firmware does: a job, a presigned HTTPS URL, and status on the job and in
  the shadow.
- It has to fit three checks: its size, a SHA-256 over all of it, and an ECDSA signature over a manifest.
  The project's firmware signing key signs that manifest.
- It goes to the SD card first, and from there to the Pi, in frames that each carry a CRC-32.
- The SD card and the Pi share one SPI bus, each with its own chip select. A READY line from the Pi paces
  the transfer.
- Board firmware always goes first. A Pi image waits while a firmware job is pending, and while new
  firmware is on trial.
- A build for a board wired to a Pi has no Bluetooth, because the two do not fit in RAM together
  ([Memory](#memory)). It is built with `scripts/firmware/build.sh --pi`.
- **Before any such board runs 1.20.0, deploy console 2.26.0.** Its device policy lets a board ask for its
  list of pending jobs ([Cloud](#cloud)).
- Nothing on this page has run on hardware ([Untested on hardware](#untested-on-hardware)).

## Contents

- [The parts](#the-parts)
- [Wiring](#wiring)
- [The job](#the-job)
- [Signing](#signing)
- [Order: firmware first](#order-firmware-first)
- [Download and resume](#download-and-resume)
- [The SD card](#the-sd-card)
- [The SPI protocol](#the-spi-protocol)
- [Reports](#reports)
- [Speed](#speed)
- [Memory](#memory)
- [Cloud](#cloud)
- [Tests](#tests)
- [Untested on hardware](#untested-on-hardware)

## The parts

| File | What it does | Tested on the host |
| --- | --- | --- |
| `src/ota/ota_job.c` | Parses the `pi_image` document and the list of pending jobs | `test_pi_ota.c` |
| `src/ota/ota.c` | Puts firmware before a Pi image, and passes a Pi job to `pi_ota.c` | `test_ota_bt.c` (`ota_pi_tests`) |
| `src/pi/pi_image.c` | The manifest, the checks on a job, the error reasons, the record kept on the card, and CRC-32 | `test_pi_ota.c` |
| `src/pi/pi_sha256.c` | SHA-256 whose state can be saved, for resume | `test_pi_ota.c` |
| `src/pi/pi_sd.c` | Files on the SD card through Zephyr's file system API: errors, retries, time limits, and releasing the bus | `test_pi_ota.c`, against an in-memory file system |
| `src/pi/pi_dl.c` | The download onto the card: hashing, checkpoints and resume | `test_pi_ota.c`, with a fake HTTP server |
| `src/pi/pi_link.c` | The board's end of the SPI protocol | `test_pi_link.py`, against `tools/pi_link_sim.py` |
| `src/pi/pi_ota.c` | Glue: the devices, the custom DFU target, the thread, and the reports | Built only |
| `boards/pi_ota_bus.dtsi`, `boards/pi_ota.overlay` | The bus, its two devices and the two pins | Built for both boards |
| `pi_ota.conf`, `pi_ota_sysbuild.conf` | The build for a board wired to a Pi | Built |
| `tools/pi_image.py` | Signs an image and prints the commands to deploy it | `test_pi_image.py` |

## Wiring

There is one SPI bus. The SD card and the Pi share SCK, MOSI and MISO, and each has its own chip select.
The board is the controller, on SPIM3, with EasyDMA. The pins are the same on the nRF7002 DK and the
nRF5340 DK, all on the Arduino header.

| Signal | nRF pin | DK header | SparkFun microSD breakout | Raspberry Pi |
| --- | --- | --- | --- | --- |
| SCK | P1.15 | D13 | SCK | SCLK (GPIO 11) |
| MOSI | P1.13 | D11 | DI | MOSI (GPIO 10) |
| MISO | P1.14 | D12 | DO | MISO (GPIO 9) |
| SD card chip select | P1.11 | D9 | CS | – |
| Pi chip select | P1.12 | D10 | – | CE0 (GPIO 8) |
| READY, Pi to board | P1.04 | D2 | – | Any GPIO, push-pull output |
| Card detect | P1.05 | D3 | CD | – |
| 3.3 V | VDD | 3.3V | VCC | – |
| Ground | GND | GND | GND | GND |

**The SD module.** The pins CD, DO, GND, SCK, VCC, DI and CS make it SparkFun's microSD transflash
breakout (BOB-00544 class). It is the card in SPI mode with no logic on the board, and it runs at 3.3 V
only. The DK's I/O runs at 3.0 V by default, which works with it. Card detect is a switch.
`pi_ota_bus.dtsi` treats it as closed to ground when a card is in (active low, with the internal
pull-up). If yours reads the other way, change `cd-gpios`.

**Why these pins.**

- Serial instances, which SPIM, TWIM and UARTE share:
  - SERIAL0 is the console (uart0).
  - SERIAL1 is TF-M's UART (uart1, `CONFIG_TFM_SECURE_UART1`).
  - SERIAL4 is the external flash on the nRF7002 DK.
  - That leaves SERIAL3, which is the Arduino SPI on the nRF7002 DK.
- Pins already taken on the nRF7002 DK:
  - The Wi-Fi chip: P0.12 to P0.18, P0.23, P0.24, P0.28 to P0.31, and P1.10. P1.10 is D8, which is why
    READY is not on D8.
  - The LEDs and buttons: P1.06 to P1.09.
- On the nRF5340 DK:
  - Its own Arduino SPI, spi4, uses the same pins. Its overlay turns spi4 off.
  - Its buttons and LEDs are on port 0.

**The bus stays off outside a Pi build.** `pi_ota_bus.dtsi` describes the bus with
`status = "disabled"`, and `pi_ota.overlay` turns it on. `sysbuild.cmake` adds that overlay only for a
Pi build, so the default build does not spend RAM on a driver that nothing uses.

**On a shared bus:**

- An SD card in SPI mode may keep driving DO (MISO) after its chip select goes high, until it sees
  clocks. Before every frame to the Pi, the board clocks 16 bits with both chip selects high, and it does
  the same after every operation on the card (`release_bus()` in `pi_ota.c`).
- **The Pi's SPI peripheral must tri-state MISO whenever its CE is high.** Otherwise it fights the card.
- Zephyr's `spi_config` for each device sets its own frequency and chip select on every transaction.
  The SD card starts at 400 kHz and then runs at 8 MHz. The Pi link runs at 8 MHz, which is SPIM3's
  limit. Lower either one in `pi_ota_bus.dtsi` (`spi-max-frequency`).

**Wiring advice:**

- Keep the wires short: under 10 cm at 8 MHz, or slow the bus down.
- Join the grounds.
- Do not power the Pi from the DK.

## The job

The document comes from `tools/pi_image.py` or from `buildPiJobDocument()` in `cloud/api/src/lib/jobs.mjs`:

```json
{ "op": "pi_image", "v": 1,
  "pi": { "version": "2026.11.06-1", "size": 104857600, "sha256": "<64 hex>",
          "sig": "<128 hex>", "url": "${aws:iot:s3-presigned-url-v2:https://s3.<region>.amazonaws.com/<bucket>/firmware/pi-<sha256>.img}",
          "minFirmware": "1.20.0" } }
```

| Field | Rule |
| --- | --- |
| `version` | 1 to 31 letters, digits or `. _ + -`. It is the Pi image's own version. |
| `size` | 1 byte to 4 GiB − 1 bytes. A board also refuses anything above `CONFIG_APP_PI_OTA_MAX_SIZE_MB` (2048), and anything larger than the free space on the card. |
| `sha256`, `sig` | Lowercase hex. `sig` is ECDSA P-256 `r‖s` over the manifest. |
| `url` | Must start with the board's provisioned download prefix, as for firmware. The image lives under `firmware/`, so the presign role and the prefix need no change. |
| `minFirmware` | Optional. It is signed with the rest. A board running older firmware refuses the job with `firmware_too_old`. |

The job ID starts with `pi-`. That prefix is how a board tells a Pi image from firmware in its list of
pending jobs, which carries no documents.

A board built without Pi updates (the default) refuses a Pi job as `unsupported`, which is what it has
always answered to a document it does not know.

## Signing

The signature covers this text, which the board builds from the job's fields (`pi_manifest_text()`) and
which `tools/pi_image.py` builds the same way:

```
cranium-pi-image-v1
version=<version>
size=<decimal>
sha256=<64 lowercase hex>
min_firmware=<major.minor.revision+build, or none>
```

The key is the firmware signing key, `~/.cranium/mcuboot_signing_key.pem`. Its public half,
`firmware/keys/fw_signing_pub.pem`, is built into the board as `src/pi/pi_key.h`, and `test_pi_image.py`
fails if the two ever differ. The board checks the signature with PSA (`psa_verify_message`, ECDSA with
SHA-256) before it downloads anything. It refuses a job whose signature does not hold, with
`bad_signature`.

**Why the same key:**

- It is the key the project already guards. A second key would be a second secret to keep, and nobody
  who can sign firmware is less trusted than someone signing a Pi image.
- The first line of the manifest keeps the two uses apart. MCUboot signs a hash of an image header, never
  text that starts `cranium-pi-image-v1`, so a signature from one use cannot pass in the other.
- The manifest is signed, not the image. A board checks the signature before it downloads, and checks
  the SHA-256 once the download ends.

## Order: firmware first

AWS IoT hands out pending jobs oldest first, whatever they are. The board puts them in its own order
(`ota.c`):

1. **Only one is pending.** It runs.
2. **The next job named is a Pi image, and the board is idle.** The board asks for its list of pending
   jobs (`$aws/things/<thing>/jobs/get`).
   - If the list holds a job whose ID does not start with `pi-`, that firmware job goes first. The board
     marks it `IN_PROGRESS`, with `"step":"before_pi_image"`, and asks for the next job. AWS IoT now names
     the firmware job, because it lists jobs in progress before queued ones. The board then runs it as
     usual: download, install, MCUboot swap, restart, confirm.
   - The Pi image's job stays `QUEUED` throughout, and nothing is reported on it. The shadow says
     `pi.state = "waiting_for_firmware"`.
3. **A Pi image is named while firmware is under way, or on trial and not yet confirmed.** It waits,
   `QUEUED`.
4. **After the confirmation.** The board reports the firmware job, then asks for the next job again.
   This time the list holds no firmware, so the Pi image starts.
5. **The firmware update fails or rolls back.** The Pi image still runs, on the firmware the board ended
   up on, unless its `minFirmware` is newer. Then it is refused with `firmware_too_old`.
6. **A Pi image left in progress by a restart.** It carries on, with no list in between, from the last
   checkpoint on the card.
7. **The list cannot be asked for.** This happens when the cloud's device policy is older than 2.26.0, and
   the board's guard has dropped the list topic along with the commands topic (`cloud.h`). The board then
   takes jobs in the cloud's order.

**One gap:** a restart in the moment between marking the firmware job `IN_PROGRESS` and starting it.
The board then finds the job in progress with no record of it, and closes it as `interrupted`, as it
always has for an update cut off by a restart. Deploy again.

## Download and resume

The download goes through the firmware's own downloader, `fota_download`: the same HTTPS connection and
the same events, which reach `pi_ota.c` through `ota.c`. The image itself goes to a custom DFU target
(`dfu_target_custom_*()` in `pi_ota.c`), which writes it to the SD card.

1. **Before the download**, the thread mounts the card and reads the record in `/SD:/PIOTA/RECORD.BIN`
   (`pi_dl_begin()`):
   - The same image is already all on the card and good: it goes straight to the Pi.
   - The same image is partly there: it goes on from the last checkpoint.
   - Otherwise the board checks that the card has room for the image plus 64 KiB, and starts an empty
     `/SD:/PIOTA/IMAGE.BIN`.
2. **During the download.** Each piece goes onto the card where it arrives, and into the SHA-256. Every
   `CONFIG_APP_PI_OTA_CHECKPOINT_KB` (1 MiB) the file is synced and the record saved: how many bytes are
   good, and the hash's state after them. The record is written to `RECORD.TMP` first and renamed over
   the old one, and a load takes the temporary copy if a reset came between the two.
3. **After a lost connection.** The board asks for the job again, for a fresh URL, and goes on from the
   last byte written (an HTTP range). The hash is still in memory.
4. **After a failed write to the card, or a restart.** The download goes back to the last checkpoint:
   the file is cut there and the saved hash is taken up.
5. **At the end.** The size and the digest are compared with the job's. On a mismatch the image and its
   record are deleted and the job fails with `digest_mismatch`, so the next attempt starts from nothing.
6. **Attempts.** An attempt that got bytes onto the card resets the count. After
   `CONFIG_APP_PI_OTA_DOWNLOAD_ATTEMPTS` (10) attempts in a row with nothing new, the job fails with
   `download_failed`.

## The SD card

The card is a `zephyr,sdhc-spi-slot` with a `zephyr,sdmmc-disk` child named `SD`, mounted with FatFS at
`/SD:`. Format it FAT32 on a computer: the board does not format it, and it reads 8.3 names only. FAT32
holds files up to 4 GiB − 1, which matches the size limit. Cards over 32 GB come as exFAT and have to be
reformatted as FAT32.

`pi_sd.c` provides:

- create, write, read at an offset, seek, truncate and sync
- the size of a file and the free space (`fs_statvfs`)
- an atomic save of a small file

Every error maps to a reason:

| Reason | When |
| --- | --- |
| `sd_absent` | The card-detect switch says there is no card |
| `sd_full` | FatFS wrote less than asked, or returned `-ENOSPC` |
| `sd_timeout` | An operation took longer than `CONFIG_APP_PI_SD_TIMEOUT_MS` (5 s) |
| `sd_io` | Anything else |

A read or a write that fails is tried once more from the same position.

## The SPI protocol

This is the contract for the Pi's end. The board is the SPI controller, mode 0, MSB first, 8-bit words,
at up to 8 MHz. Every multi-byte value is little-endian. A frame is one transaction, with the Pi's chip
select low throughout.

**Frame, board to Pi:**

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | Magic `CPI1` (`0x31495043`) |
| 4 | 1 | Type: BEGIN 1, DATA 2, VERIFY 3, ABORT 4, POLL 5 |
| 5 | 1 | Flags, 0 |
| 6 | 2 | Reserved, 0 |
| 8 | 4 | Sequence number |
| 12 | 4 | Payload length N |
| 16 | N | Payload |
| 16+N | 4 | CRC-32 (IEEE 802.3, the same as `zlib.crc32`) of bytes 0 to 16+N−1 |

**Payloads:**

| Type | Sequence | Payload |
| --- | --- | --- |
| BEGIN | 0 | 80 bytes: protocol version u16 (1); target partition u8 (2, partition B); 0 u8; chunk size u32; image size u64; SHA-256 of the image, 32 bytes; image version, 32 bytes of ASCII padded with zeros |
| DATA | Chunk index, from 0 | Offset u32 (= index × chunk size), then the chunk. Every chunk is full except the last. |
| VERIFY | Number of chunks | Image size u64, then the SHA-256, 32 bytes |
| ABORT | Any | Reason u16 (a status code below), then 0 u16 |
| POLL | That of the frame it asks about | None. The frame is 20 bytes, and while it goes out the Pi clocks out its status. |

**Status, Pi to board,** 20 bytes, clocked out during a POLL:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | Magic `CPR1` (`0x31525043`) |
| 4 | 1 | ACK 0, NAK 1, BUSY 2 |
| 5 | 1 | Code: OK 0, BAD_CRC 1, BAD_SEQ 2, BAD_STATE 3, BAD_TARGET 4, BAD_VERSION 5, NO_SPACE 6, WRITE_ERROR 7, HASH_MISMATCH 8, ABORTED 9 |
| 6 | 2 | Reserved, 0 |
| 8 | 4 | The sequence number of the frame it answers |
| 12 | 4 | `next_seq`: the DATA sequence number it expects next |
| 16 | 4 | CRC-32 of bytes 0 to 15 |

**READY (flow control).** READY is a push-pull output on the Pi, high when the Pi is ready.

1. Before BEGIN, the board waits for READY to be high, for up to `CONFIG_APP_PI_LINK_BEGIN_TIMEOUT_MS`
   (60 s). If it never rises, the job fails with `pi_not_ready`.
2. After **every** transaction, the Pi takes READY low, then raises it when it is ready for the next
   transaction. The board waits for that rising edge. After a frame, "ready" means the status is loaded
   for the POLL. After a POLL, it means the Pi is ready for the next frame.
3. The waits are 2 s after an ordinary frame, 60 s after BEGIN (the Pi prepares partition B), and 10 min
   after VERIFY (the Pi hashes all of partition B).

**One exchange** is the frame, the wait for READY, the POLL, and the wait for READY again. The board
then reads the status.

**What the board does with an answer:**

| Answer | The board |
| --- | --- |
| ACK for this sequence number | Goes on |
| NAK BAD_CRC, no READY, a damaged status, or an ACK for another frame | Sends the same frame again, up to `CONFIG_APP_PI_LINK_ATTEMPTS` (5) times. **The Pi must ACK a frame it has already applied, and not apply it twice.** |
| BUSY | POLLs again after the next READY, up to 100 times |
| NAK BAD_SEQ with a lower `next_seq` | Goes back to that chunk, which it reads from the card again |
| NAK BAD_SEQ with a higher `next_seq` | Aborts |
| Any other NAK | The end. The job fails with `pi_rejected`, or `pi_verify_failed` for HASH_MISMATCH, with the code in the log. |
| BEGIN's ACK with `next_seq` > 0 | Starts at that chunk. The Pi already has the ones before, from an earlier try with the same image. A Pi may always answer 0. |

**The sequence:**

1. BEGIN.
2. DATA 0 to n−1.
3. The board checks its own SHA-256 of what it read back from the card. If that does not match, it
   sends ABORT with HASH_MISMATCH and the job fails with `sd_readback_mismatch`.
4. VERIFY: the Pi hashes partition B and compares that with the image's SHA-256. Its ACK means
   partition B holds the image.

What the Pi does next, such as marking B to boot or switching to it, is the Pi's side.

**ABORT** goes out when the job is withdrawn, when the card fails, or when the board gives up. After it,
the Pi drops what it has.

**Chunks** are `CONFIG_APP_PI_OTA_CHUNK_KB` (4 KiB) long, and at most 32 KiB.

**What the Pi's end checks:** `tools/pi_link_sim.py` is the executable version of this contract. It
checks every frame and its CRC, the order and the offsets, the BEGIN's fields, and the final hash. Use it
as the reference when building the Pi's end.

**A warning for the Pi's end.** On a Raspberry Pi running Linux, SPI in peripheral (target) mode is not
what the stock `spidev` driver offers. Check that the Pi model and kernel in use can act as an SPI target
with DMA before relying on 8 MHz.

## Reports

**On the job,** as firmware reports:

- `IN_PROGRESS` with `step` (`downloading` or `sending`) and `progress` in percent. It is sent at the
  start, at each new step, and every 30 s.
- `SUCCEEDED` with `pi_version` and the board's `running` firmware.
- `REJECTED` (for a queued job) or `FAILED` (for one in progress), with a `reason`:

| Reason | Meaning |
| --- | --- |
| `bad_signature` | The manifest's signature does not hold |
| `too_large` | Over the size limit |
| `already_installed` | The Pi already has this image |
| `firmware_too_old` | Below `minFirmware` |
| `sd_absent`, `sd_io`, `sd_full`, `sd_timeout` | The card |
| `download_failed` | Too many attempts with nothing new |
| `size_mismatch`, `digest_mismatch` | Not the announced image |
| `sd_readback_mismatch` | The card changed it |
| `pi_not_ready`, `pi_timeout` | The Pi did not answer |
| `pi_rejected` | The Pi refused it |
| `pi_verify_failed` | The Pi's hash differs |
| `link_io` | The SPI driver failed |
| `aborted` | Withdrawn |

**In the shadow,** under `pi`:

- `state`: `idle`, `waiting_for_firmware`, `downloading` or `sending`
- `job`, and `progress` in percent
- `last` and `error`: the last outcome and its reason
- `installed`: the version the Pi verified last

## Speed

These are estimates; none of these figures has been measured. One number is measured: a firmware image
over the same downloader and TLS took 62 to 86 s for about 800 KB, roughly 10 KB/s
([test-results.md](test-results.md)).

**Download onto the card.** The network bounds this, not the card. An SD card in SPI mode at 4 to 8 MHz,
through FatFS, writes about 100 to 400 KB/s.

| Image | At 10 KB/s (as firmware downloads now) | At 50 KB/s |
| --- | --- | --- |
| 100 MB | about 2.8 h | about 35 min |
| 1 GB | about 28 h | about 5.8 h |

**Card to Pi, on the shared bus.** Each 4 KiB chunk is first read from the card and then sent to the Pi.
At 8 MHz:

- The card read takes about 6 to 10 ms.
- The frame takes about 4 ms.
- The two READY waits take about 2 to 10 ms, depending on the Pi's latency.

That gives about 170 to 340 KB/s. At 4 MHz it is roughly 105 to 185 KB/s.

| Image | At 8 MHz | At 4 MHz |
| --- | --- | --- |
| 100 MB | about 5 to 10 min | about 9 to 16 min |
| 1 GB | about 50 to 100 min | about 1.6 to 2.7 h |

Two separate buses could overlap the card read with the send, and would take about half the time. Larger
chunks (16 to 32 KiB) cut the handshakes, but they need RAM that this board does not have
([Memory](#memory)).

**It works for 1 GB, slowly.** Checkpoints every MiB mean a lost connection or a restart loses at most
1 MiB. AWS IoT's in-progress timeout has to be longer than all of this, so create a Pi job with a long
one ([Cloud](#cloud)). The board does not stall a firmware job meanwhile. It cannot run one either,
because firmware waits until the Pi job ends.

## Memory

Figures are from local builds of this branch.

| Build | Flash | RAM |
| --- | --- | --- |
| Default (Bluetooth, no Pi) | 745,624 of 794,474 bytes | 404,500 of 405,504 bytes: about 1 KiB free |
| `pi_ota_sysbuild.conf` (Pi, no Bluetooth) | 691,896 of 794,474 bytes | 378,600 of 405,504 bytes: about 26 KiB free |
| nRF5340 DK (no Pi: it has no cloud) | 196,296 of 794,474 bytes | 107,048 of 409,600 bytes |

The Pi update takes about 9 KiB of RAM:

| Item | Size |
| --- | --- |
| The chunk buffer | 4 KiB |
| The thread's stack | 2 KiB |
| FatFS | about 1.2 KiB |
| The download's state | about 0.5 KiB |
| The SD host | about 0.4 KiB |
| The rest | small |

The downloader is the firmware's own, so it takes no second downloader thread, buffer or TLS session.
The default build has about 1 KiB free, so it cannot hold this as well. That is why a Pi build turns
Bluetooth off, and why `sysbuild.cmake` refuses a build with both.

Giving a Pi board Bluetooth back means finding about 9 KiB elsewhere, for example in the heaps that
Wi-Fi and TLS were tuned with. That should not be done without measurements on a board. The default build
grew by 216 bytes, for the Pi fields of the two job records that it keeps in order to refuse a Pi job.

## Cloud

**Device policy.** Console 2.26.0 adds three permissions, each on the board's own topic only:

- publish `$aws/things/<thing>/jobs/get`
- subscribe `jobs/get/accepted`
- receive `jobs/get/accepted`

`cloud/api/test/pi-infra.test.mjs` holds the policy to that. **Deploy console 2.26.0
(`cloud/deploy.sh`) before any board runs a 1.20.0 Pi build.** A Pi build subscribes to the list's
topic, and an older policy would end its connection until the guard gives up on commands too. A default
1.20.0 build does not use the topic, and does not need the policy.

**Signing and uploading an image.** Run:

```sh
tools/pi_image.py sign pi-2026.11.06-1.img --version 2026.11.06-1 [--min-firmware 1.20.0]
```

It writes `pi-2026.11.06-1.img.pi.json`, and prints the commands below. It runs none of them.

```sh
aws s3 cp pi-2026.11.06-1.img s3://<bucket>/firmware/pi-<sha256>.img --profile cranium
aws iot create-job --profile cranium --job-id <pi-...> --targets <thing ARN> \
  --document '<the printed document>' \
  --presigned-url-config roleArn=<PresignRole ARN>,expiresInSec=600 \
  --timeout-config inProgressTimeoutInMinutes=2880
```

`tools/pi_image.py verify <record>` checks a record against the public key. The job document and the job
ID can also come from `buildPiJobDocument()` and `buildPiJobId()` in `cloud/api/src/lib/jobs.mjs`, which
`jobs.test.mjs` tests.

**A console page for Pi images is a follow-up.** It would need:

1. An upload of the image and its `.pi.json` record, with the signature checked against
   `fw_signing_pub.pem`, as the Firmware page checks images.
2. A list of Pi images.
3. A deploy dialog that builds the document and the ID with the functions above, with an in-progress
   timeout sized to the image (above), and only to boards built with `--pi`.
4. The shadow's `pi` object on the board's page.

**Fleet.** A Pi build carries the board type `nrf7002dk` like any other, so the console offers it to
every nRF7002 DK. Deploy it only to boards wired to a Pi, or they lose Bluetooth.

## Tests

| Where | What it covers | Checks |
| --- | --- | --- |
| `make -C firmware/tests/host`: `pi_ota_tests` | SHA-256 (FIPS vectors, saved and taken up again), CRC-32, the document and its refusals, the list of jobs, the manifest against the golden text, every check on a job, the record, the card's layer with faults, and the download with a fake server | 389 |
| `make -C firmware/tests/host`: `ota_pi_tests` | `ota.c` with `CONFIG_APP_PI_OTA`, re-running the no-consent tests plus the order cases below | 553 |
| `make -C firmware/tests/host`: `ota_bt_no_consent_tests` | A board without Pi updates refuses a Pi job as `unsupported` | Part of its total |
| `firmware/tests/hil/test_pi_link.py` | `pi_link.c` against `tools/pi_link_sim.py`, and the simulator's own checks | 13 tests |
| `firmware/tests/hil/test_pi_image.py` | The tool's manifest is the board's, a signature holds and breaks, the built-in key, and the record and the document | 6 tests |
| `cloud/api`: `node --test` | `buildPiJobDocument`, `buildPiJobId`, and the device policy | 5 tests |

The download tests cover:

- start to end
- a resume after lost connections
- a card that fails, then back to the checkpoint
- a restart, then resuming from the checkpoint
- a damaged record, and a card with less than its checkpoint
- a wrong digest or size
- no room
- no card, or one pulled in the middle
- a stopped download taken up by a new job
- a reset to nothing

The order tests in `ota_pi_tests` cover:

- firmware first, then the Pi image, through a restart onto the new firmware on trial and its confirmation
- a Pi image alone
- firmware alone
- a Pi image while firmware is on trial
- a Pi image after a rollback
- `minFirmware` refusing it
- a cloud with no list
- a Pi image left in progress by a restart
- a withdrawn Pi job

The link tests cover:

- sizes and chunk sizes from 1 byte to 70 KB
- damaged frames and statuses
- no READY
- a busy Pi
- a Pi that lost chunks
- a Pi that already has part of the image
- a refusal at BEGIN or DATA
- a failed VERIFY
- a Pi that never answers
- a card that changed the image
- a withdrawn job

## Untested on hardware

None of this has run on a board, a card or a Pi. All of the following are untested:

- The SD card on SPIM3 through Zephyr's SD host:
  - its initialisation at 400 kHz and its run at 8 MHz
  - FatFS on a real card
  - the free space on a real card
  - the time limits against a slow card
- The shared bus:
  - whether the release clocks are enough for a given card
  - whether a given Pi tri-states MISO
  - the READY edges and their latency
  - EasyDMA transfers of 4 KiB frames
- The card-detect polarity of the actual breakout.
- The custom DFU target in `fota_download`:
  - identifying a Pi image by expectation
  - the resume with an HTTP range from the target's offset
  - the events through `ota.c`
- PSA's ECDSA check with the built-in key.
- The jobs list and its topic on AWS IoT:
  - marking a firmware job `IN_PROGRESS` to put it first
  - the policy, which is not deployed yet
- The shadow's `pi` object.
- Every speed figure above.
- RAM and stack: the thread's 2 KiB stack has not been measured. Measure it with the thread analyser,
  as in `firmware/README.md`, on the first bring-up.

Report anything that cannot be run as not run. Do not report it as passed.
