# Raspberry Pi delta updates through the board

From firmware 1.20.0, a board wired to a Raspberry Pi keeps a copy of the Pi's image on an SD card,
and brings it up to date by downloading only the blocks that changed. The Pi takes the changed blocks
from the board over SPI. A new image therefore costs minutes of transfer instead of hours for
gigabytes. This page covers the board's side: the design, the formats, the SPI protocol the Pi's side
has to implement, the job, and what has not run on hardware yet. **The Pi's side is separate work, by
the Pi's owner; this page is its contract.**

**The Pi has no network.** It has no Wi-Fi, no AWS IoT thing and no certificate, and it never talks to
the console. Everything reaches it through the nRF7002 DK, which downloads onto its own SD card.

**In short:**

- The image is cut into blocks of 64 KiB (`tools/pi_image.py package`). A signed **manifest** holds
  one SHA-256 per block.
- A job (`"op": "pi_delta"`) names the package. The board fetches the manifest, checks its
  signature, compares its block hashes with the ones it already holds, and downloads **only the
  blocks that differ**, with HTTP range requests.
- Each block is checked against its hash **before it is written** to the copy of the image (the
  "mirror"). A power cut, a lost connection or a card taken out costs at most one block; the update
  goes on from where it stopped.
- While the mirror is being written, the card says **updating**, and the board refuses the Pi
  anything from it. When it is done, the card says **ready** and keeps the list of changed blocks.
- The Pi, as SPI controller, asks the board **INFO**, **MANIFEST** (block hashes), **CHANGED** (the
  list) and **READ** (bytes of a block), and takes only what differs from its own image.
- The requests share the Pi's message link (PR #58) as one link: its SPI peripheral (SPIS3 on D10 to
  D13), READY on D9, its 512-byte frames with a CRC-32, and its rule that the board answers each frame
  in the next transfer. A build without this is #58's.
- A build with this has no Bluetooth (the RAM), and is built with `scripts/firmware/build.sh --pi`.
- **None of this has run on hardware** ([Untested on hardware](#untested-on-hardware)).

This replaces the firmware side of PR #196, where the board sent the whole image to the Pi, with
the board as SPI controller.

## Contents

- [The parts](#the-parts)
- [Block size](#block-size)
- [The package](#the-package)
- [Signing](#signing)
- [The job](#the-job)
- [The SD card](#the-sd-card)
- [The update](#the-update)
- [Downloads](#downloads)
- [Wiring](#wiring)
- [The SPI protocol](#the-spi-protocol)
- [What the Pi does](#what-the-pi-does)
- [Sharing the message link](#sharing-the-message-link)
- [Memory](#memory)
- [Tests](#tests)
- [What the console needs](#what-the-console-needs)
- [Hardware test plan](#hardware-test-plan)
- [Untested on hardware](#untested-on-hardware)

## The parts

All in `firmware/app/src/pi/`, built only with `CONFIG_APP_PI_DELTA`, except the message link's own
files (`pi_link.c`, `pi_rx.c`, `pi_frame.c`), which every build with `CONFIG_APP_PI_LINK` has.

| File | What it does | Tested on the host |
| --- | --- | --- |
| `pi_delta_fmt.c` | The manifest header, the card's state header, the card's layout, the reasons | `test_pi_delta.c` |
| `pi_card.c` | The card in raw sectors: the two copies of the state, the slots, the list, the mirror | `test_pi_delta.c`, a card in memory |
| `pi_delta.c` | The update: manifest, comparison, blocks, resume | `test_pi_delta.c`, and `test_pi_delta.py` through `pi_delta_harness.c` |
| `pi_dlink.c` | The delta requests' answers, and STATUS for anything else | `test_pi_delta.c`, and `tools/pi_delta_sim.py` through the harness |
| `pi_http.c` | Range requests and the head of their answers | `test_pi_delta.c` |
| `pi_sha256.c` | SHA-256 in plain C | Every test above |
| `pi_frame.c` | The frames of the Pi's link, #58's file unchanged | Every link test |
| `pi_rx.c` | #58's receiver: sorts each frame by type, DATA and POLL as the message link, delta requests to `pi_dlink.c` | `test_pi_rx.c` (with and without delta updates), `test_pi_delta.c`, the harness |
| `pi_link.c` | #58's link: SPIS3, READY, the work queue. With delta updates, a queue of its own and room for a whole frame | Built only |
| `pi_card_disk.c` | The card through Zephyr's disk access, the card-detect pin, the lock | Built only |
| `pi_delta_ota.c` | The job, the thread, the TLS connection, PSA's signature check, the reports | Built only |
| `src/ota/ota_job.c`, `ota.c` | The `pi_delta` document, and handing such jobs over | `test_pi_delta.c` |
| `tools/pi_image.py` | Builds, signs and checks a package; writes a card | `test_pi_delta.py` |

## Block size

64 KiB by default (`tools/pi_image.py package --block-size`, any power of two from 4 KiB to 1 MiB).
Smaller blocks waste less on a change of a few bytes; larger blocks make a smaller manifest and fewer
range requests. Per GiB of image:

| Block size | Blocks per GiB | Manifest per GiB | A 4 KiB change downloads | Range requests for 100 scattered changes |
| --- | --- | --- | --- | --- |
| 4 KiB | 262,144 | 8 MiB | 4 KiB | 100 |
| 16 KiB | 65,536 | 2 MiB | 16 KiB | 100 |
| **64 KiB** | **16,384** | **512 KiB** | **64 KiB** | **100** |
| 256 KiB | 4,096 | 128 KiB | 256 KiB | 100 |
| 1 MiB | 1,024 | 32 KiB | 1 MiB | 100 |

At 64 KiB the manifest is 1/2,048 of the image (2 MiB for 4 GiB), which the board downloads every
update, and a request's own cost (about 2 KB of request and headers on a kept-alive connection) is
3 % of a block. Neighbouring changed blocks go in one request (up to 16, `CONFIG_APP_PI_DELTA_RUN_BLOCKS`).

**For the Pi's owner:** a delta is only small if the new image keeps the old one's layout. An image
rebuilt from nothing places files differently, and most blocks change. Make a new image by changing
the old one in place (mount it, update packages, unmount), and fill free space with zeros.

## The package

One object in the firmware bucket, `firmware/pi-<version>-<sha256>.cpd` (a `+` in the version is
written `~`), that `tools/pi_image.py package` writes:

| Offset | Size | What |
| --- | --- | --- |
| 0 | 512 | The manifest header, signed |
| 512 | 32 × blocks | The table: the SHA-256 of each block, in order |
| a multiple of 4096 | the image's size | The image |

The header (little-endian):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | Magic `CPDM` |
| 4 | 2 | Format, 1 |
| 6 | 2 | Header size, 512 |
| 8 | 4 | Block size: a power of two, 4 KiB to 1 MiB |
| 12 | 4 | Block count: the image size divided by the block size, rounded up |
| 16 | 8 | Image size: a whole number of 512-byte sectors (a disk image always is) |
| 24 | 8 | Table offset, 512 |
| 32 | 8 | Image offset: a multiple of 4096, at or after the end of the table |
| 40 | 32 | SHA-256 of the whole image |
| 72 | 32 | SHA-256 of the table |
| 104 | 32 | Version: 1 to 31 of `A-Z a-z 0-9 . _ + -`, padded with zeros |
| 136 | 4 | Flags, 0 |
| 140 | 308 | Zeros |
| 448 | 64 | ECDSA P-256 signature over bytes 0 to 447, with SHA-256: r then s, 32 bytes each, big-endian |

A block's hash is the SHA-256 of its bytes alone. The last block is shorter when the image is not a
whole number of blocks. One object, not two: one presigned URL fits the job document in the board's
4 KB MQTT buffer, and the table can never belong to another image.

## Signing

The firmware signing key signs the header (`~/.cranium/mcuboot_signing_key.pem`, the same key and the
same reasoning as #196). Its public half, `firmware/keys/fw_signing_pub.pem`, is in the firmware as
`src/pi/pi_key.h`, and `test_pi_delta.py` fails if the two differ. The board checks the signature with
PSA before it fetches anything else. The header signs the table's hash, and the table signs every
block, so a board checks every byte it writes against the key. MCUboot signs a hash of an image, never
a 448-byte header that starts `CPDM`, so a signature from one use cannot pass in the other.

```sh
tools/pi_image.py package pi.img --version 2026.11.24-1 --previous pi-2026.11.10-1.img.cpd
tools/pi_image.py verify pi.img.cpd
```

`package` writes `pi.img.cpd` and `pi.img.cpd.json` (the record for the console: version, size,
digest, block size, the header in hex, the object key), says how much a board holding the previous
package downloads, and prints the commands to upload and deploy it. It runs none of them.

## The job

```json
{ "op": "pi_delta", "v": 1,
  "pi": { "version": "2026.11.24-1",
          "sha256": "<64 hex: SHA-256 of the whole image>",
          "url": "${aws:iot:s3-presigned-url-v2:https://s3.<region>.amazonaws.com/<bucket>/firmware/pi-2026.11.24-1-<sha256>.cpd}" } }
```

| Field | Rule |
| --- | --- |
| `version` | As in the header. The signed header has to say the same, or the job fails with `manifest_mismatch`. |
| `sha256` | The image's digest, lowercase hex. The same rule. |
| `url` | Must start with the board's provisioned download prefix, as for firmware. The package lives under `firmware/`, so the presign role and the prefix need no change. |

- **Job ID:** `pi-<version>-<time>-<4 hex>` (`tools/pi_image.py`). The board does not read it.
- **Time limit:** an update can take hours. Create the job with an in-progress timeout long enough
  for the whole image at the slowest link (`--timeout-config inProgressTimeoutInMinutes=...`).
- **Presigned URL:** each range is a new request on the same URL, and the URL expires
  (`expiresInSec`, at most an hour). On a 403, or any failed range, the board asks for the job again
  and gets a fresh URL ([Downloads](#downloads)).
- A board built without Pi updates answers `"op": "pi_delta"` as `unsupported`, as it always has an
  `op` it does not know. A Pi build answers #196's `pi_image` the same way.

**On the job:**

- `IN_PROGRESS` at the start, then every 30 s, with `step` (`manifest`, `table`, `compare`,
  `blocks`) and `progress`, `done`, `total` (blocks).
- `SUCCEEDED` with `pi_version`, `generation`, `fetched` (blocks downloaded), `changed`, `bytes`
  and `running` (the board's firmware). A board that already has the image says so at once.
- `FAILED` with `reason` and the `step` it was in:

| Reason | Meaning |
| --- | --- |
| `bad_manifest` | The header is not one this firmware reads |
| `bad_signature` | Its signature does not hold |
| `manifest_mismatch` | The job and the signed header disagree, or the table is not the one the header signs |
| `too_large` | More blocks than the card's layout holds, or larger than the card |
| `sd_absent`, `sd_io` | No card, or a card that fails |
| `download_failed` | `CONFIG_APP_PI_DELTA_DOWNLOAD_ATTEMPTS` (10) attempts in a row with nothing new |
| `digest_mismatch` | A block came from the server wrong three times running |
| `sd_readback_mismatch` | A block written to the card read back wrong three times running |

A job withdrawn while it runs stops at its next piece, with nothing reported. The card keeps its
progress, and a job for the same image later goes on from there.

## The SD card

Raw sectors, no file system: a Pi image can be larger than FAT32's 4 GiB file limit, a raw layout
takes no RAM for a file system, and what is written is where it says. Any SD card in SPI mode (SDHC
or SDXC) large enough for the layout and the image. In 512-byte sectors:

| Where | What |
| --- | --- |
| 0 to 2047 | Not touched by the board. `tools/pi_image.py card` puts a partition table there that marks the rest as taken (type `0xDA`), so a computer does not offer to format the card. |
| 2048, 2049 | Two copies of the state header |
| 4096 | Slot 0: a manifest header, then its table |
| after slot 0 | Slot 1, the same |
| after slot 1 | The list: the blocks the last update changed, u32 each, in order |
| after the list | Staging: one block, where a downloaded block waits until its hash is checked |
| on a 4 MiB boundary | The mirror: block *i* at the mirror's first sector + *i* × block size / 512 |

Each area starts on a 1 MiB boundary. The slots and the list hold `max_blocks` entries
(`CONFIG_APP_PI_DELTA_MAX_BLOCKS`, 262,144: 16 GiB of 64 KiB blocks), which the state header keeps,
so a card keeps its layout across firmware. With the default the mirror starts at 20 MiB.

**The state header** (one sector, little-endian; of the two copies, the one with a good CRC and the
higher sequence number counts; each save goes to the other copy, so a save cut by a power cut leaves
the one before):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | Magic `CPDS` |
| 4 | 2 | Format, 1 |
| 8 | 4 | Sequence number |
| 12 | 4 | `max_blocks` |
| 16 | 1 | State: 0 empty, 1 ready, 2 updating |
| 17 | 1 | Current slot: the manifest the mirror holds (when ready) |
| 18 | 1 | New slot: the manifest of the update under way |
| 19 | 1 | Phase: 0 none, 1 table (the new manifest downloading; the mirror untouched), 2 blocks |
| 20 | 1 | Flags: 1 the current slot is valid, 2 the list is valid, 4 the mirror holds parts of two images |
| 24 | 4 | Generation: goes up by one with each finished update |
| 28 | 4 | Changed count: entries in the list |
| 32 | 4 | Next: bytes of the table on the card (phase 1), or the next block to look at (phase 2) |
| 36 | 32 | Base version: the image the list starts from |
| 68 | 32 | Base image SHA-256 |
| 508 | 4 | CRC-32 (zlib's) of bytes 0 to 507 |

**A card for a board that starts with an image.** `tools/pi_image.py card pi.img.cpd --out card.img`
writes what the card of a board holding that image looks like (ready, generation 1). Write it to the
card's whole device from a computer, so that the first update over the air is a delta and not the
whole image. A blank card works too: the first job then downloads every block that is not already
zeros on it.

## The update

`pi_delta.c`, on its own thread (`pi_delta_ota.c`). Every call starts from what the card says.

1. **The header.** The first 512 bytes of the package: read, its signature checked, held against the
   job, and against the card's size. If the card is ready with this image already, nothing more.
2. **The table.** Into the slot the current image does not use, hashed on the way, and saved every
   64 sectors. At the end its hash has to be the one the header signs. Meanwhile the card stays
   ready: the Pi may still read the current image (INFO says "preparing").
3. **The comparison.** The two tables, a sector of each at a time, never all in RAM: every block
   whose hash differs, or that is past the old image's end, goes into the list. The base (the image
   the list starts from) is recorded, and **the card says updating**. From here the Pi gets nothing
   from the mirror.
4. **The blocks.** For each listed block, in order:
   - if the mirror already holds the new block (its hash matches), it is skipped;
   - otherwise it is downloaded, with neighbours that are not in place either, in one range;
   - the bytes go to the staging block and into a SHA-256; only if that matches the table is the
     block copied into the mirror; the mirror is then read back and hashed once more;
   - the state moves past it.
5. **Done.** The new slot becomes the current one, the generation goes up, the list is valid, and
   **the card says ready**.

**What breaks, and what happens:**

| What | What happens |
| --- | --- |
| Power cut, anywhere | The state's other copy is good. The next call goes on: the block in flight is checked in the mirror and downloaded again if it is not right. At most one block is downloaded twice (the test cuts the power at each of 215 writes in turn). |
| Connection lost, or URL expired | `download_failed` for this call; the board asks for the job again for a fresh URL, waits 10 s × attempts, and goes on. |
| A block arrives wrong | Not written to the mirror. Downloaded again; three times running fails the job, and the card stays "updating". |
| A block reads back wrong | Written again from a new download; three times running fails the job. |
| The card is taken out | `sd_absent` (the card-detect switch) or `sd_io`. The card keeps its state; a job for the same image goes on from it. |
| A job for another image half way through an update | The mirror holds parts of both. The card marks it, and every block is checked against the new image, not only the listed ones (the cost is a read of the whole mirror). The list for the Pi still goes from the last image the card was ready with. |
| The same job again after it finished | `SUCCEEDED` at once, with nothing downloaded. |

## Downloads

The firmware's own downloader (`fota_download`, NCS's `downloader`) keeps offsets and file sizes in
`size_t`, 32 bits on this chip, so it cannot ask for a range past 4 GiB. The update has its own small
client instead (`pi_delta_ota.c`, with `pi_http.c`): one TLS connection to the bucket, with the
download security tag and the host name checked as the firmware's downloads do, kept alive from range
to range, `Range: bytes=first-last` with 64-bit numbers, and the answer checked to be exactly that
range (`206`, `Content-Range`, `Content-Length`). A `403` (expired URL) or any other answer ends the
call, and the main loop asks for the job again. A range that the update stops early closes the
connection, so the next one starts clean.

**Estimates (not measured).** The one measured number: firmware downloads at roughly 10 KB/s
([test-results.md](test-results.md)).

| | At 10 KB/s | At 50 KB/s |
| --- | --- | --- |
| The manifest of a 4 GiB image (2 MiB) | about 3.5 min | about 42 s |
| 50 MB of changed blocks | about 1.4 h | about 17 min |
| The whole 4 GiB image (the old way) | about 5 days | about 1 day |

## Wiring

**The Pi's link:** the pins of the message link (PR #58), tested on hardware with a Pi 5. 3.3 V on
both sides, wires straight across.

| Signal | nRF7002 DK | Raspberry Pi |
| --- | --- | --- |
| SCLK | D13 (P1.15) | GPIO11, header pin 23 |
| MOSI (Pi to board) | D11 (P1.13) | GPIO10, header pin 19 |
| MISO (board to Pi) | D12 (P1.14) | GPIO9, header pin 21 |
| CS | D10 (P1.12) | GPIO8 (CE0), header pin 24 |
| READY (board to Pi) | D9 (P1.11) | GPIO25, header pin 22 |
| Ground | GND | Any ground |

**The SD card:** its own bus, SPIM2, on the analog header, as #196 had it (SparkFun's microSD
breakout, 3.3 V only).

| Signal | nRF pin | DK header | Breakout |
| --- | --- | --- | --- |
| SCK | P0.04 | A0 | SCK |
| MOSI | P0.05 | A1 | DI |
| MISO | P0.06 | A2 | DO |
| CS | P0.07 | A3 | CS |
| Card detect | P1.05 | D3 | CD |
| 3.3 V, ground | VDD, GND | 3.3V, GND | VCC, GND |

The Pi's link is in the board's overlay (`boards/nrf7002dk_nrf5340_cpuapp_ns.overlay`, #58's), which
every build has. The SD card is in `boards/pi_delta.overlay`, which only a Pi build has. It starts at 400 kHz and then
runs at 8 MHz (`spi-max-frequency`). Card detect is read as closed to ground with a card in; if the
breakout reads the other way, change `cd-gpios`.

## The SPI protocol

**This is the contract for the Pi's side.** `tools/pi_delta_sim.py` is its executable version, and the
tests run it against the board's real C code, taken through the same two calls the board's link makes.

**One link.** The delta requests share the Pi's message link ([`docs/pi-link.md`](pi-link.md), PR #58):
its SPI peripheral (SPIS3), its pins, its READY pin and its 512-byte frames. `pi_link.c` takes every
transfer and `pi_rx.c` sorts each frame by type: DATA (`0x01`) and POLL (`0x02`) as the message link
always has them, the delta requests (`0x10` to `0x13`) to `pi_dlink.c`, and any other type as one the
board does not take. A build without `--pi` counts the delta requests as such too.

**Transfers.** The Pi is the controller: SPI mode 0, MSB first, 8-bit words, CE0 low for the whole
transfer. Every transfer is **512 bytes each way**. Numbers are little-endian.

**One rule for every answer: the board answers each frame in the next transfer.** In transfer *n* the
Pi sends frame *n* and receives the answer to frame *n − 1*.

| Frame from the Pi | What the board sends in the next transfer |
| --- | --- |
| A delta request (`0x10` to `0x13`) | Its answer (`0x90` to `0x93`), or ERROR (`0xff`) |
| DATA, POLL | STATUS (`0x81`), as on the message link |
| A damaged frame (CRC, magic, version, length), a type the board does not take, nothing (all `0x00` or `0xff`) | STATUS |

So **POLL's answer is always STATUS**: a POLL does not bring the last answer again. To take the answer
to a request, the Pi sends its next request, or a POLL when it has none, in the next transfer. If that
answer is not the one to its request (damaged, STATUS, another seq), the Pi sends the request again:
every delta request only reads, so sending one again is always safe.

**READY** (board to Pi, GPIO25) works as on the message link: high while the board is armed with its
next answer; after each transfer the board takes it low at once, takes the frame, prepares the answer
and raises it again. The Pi waits for READY before every transfer. A READ waits for the SD card, which
the update may be writing, so READY can stay low for longer than the 0.5 s that `cranium-link` waits:
a delta client should wait longer (the stand-in assumes nothing about it). While the board is not armed
it clocks out `0xff`, and after its answer the rest of the 512 bytes is `0xff` too, as after STATUS.

**Frames** are #58's, unchanged (`pi_frame.h`):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 2 | `CL` |
| 2 | 1 | Version, 1 |
| 3 | 1 | Type |
| 4 | 2 | Session: from the Pi, a number it picks, not 0. From the board, in STATUS and in delta answers alike, the session of the last DATA frame it accepted (0 for none) |
| 6 | 2 | Seq: from the Pi, the frame's number. From the board, in a delta answer, the request's seq; 0 in STATUS |
| 8 | 2 | Ack: from the board, in STATUS and in delta answers alike, the seq of the last DATA frame it accepted |
| 10 | 2 | Payload length, at most 496 |
| 12 | n | Payload |
| 12 + n | 4 | CRC-32 (zlib's) of everything before it |

A delta answer carries the message link's session and ack, as STATUS would, so a sender of messages
that read one would learn nothing new from it. **The Pi matches an answer to its request by type and
seq:** the answer's type is the request's with `0x80` set (or ERROR, whose payload names the request's
type), and its seq is the request's. A delta client never uses seq 0, which STATUS carries.

**Requests (Pi to board) and answers (board to Pi).** An answer's type is the request's with `0x80`
set; a refusal is `ERROR` (`0xff`).

| Request | Type | Payload | Answer payload |
| --- | --- | --- | --- |
| POLL (#58's) | `0x02` | none | STATUS (`0x81`), the message link's: no payload |
| INFO | `0x10` | none | `0x90`: 196 bytes, below |
| MANIFEST | `0x11` | first block u32, count u16 (1 to 15), 0 u16 | `0x91`: generation u32, first u32, count u16, 0 u16, 0 u32, then *count* hashes of 32 bytes |
| CHANGED | `0x12` | first index u32, count u16 (1 to 120), 0 u16 | `0x92`: generation u32, total u32, first u32, count u16, 0 u16, then *count* block numbers u32 |
| READ | `0x13` | block u32, offset u32 (in the block), length u16 (1 to 480), 0 u16 | `0x93`: generation u32, block u32, offset u32, length u16, 0 u16, then *length* bytes |

MANIFEST and CHANGED give fewer than asked at the end (count in the answer). READ gives exactly what
was asked, or a refusal. The board serves a READ from the sector it read last when it can: reading a
block in order costs about one card sector per transfer.

**INFO** (196 bytes):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 2 | Protocol version, 1 |
| 2 | 1 | State: 0 empty, 1 ready, 2 updating |
| 3 | 1 | Flags: 1 the list is valid, 2 the next update's manifest is downloading (the mirror is still this image), 4 no card |
| 4 | 4 | Generation |
| 8 | 4 | Block size |
| 12 | 4 | Block count |
| 16 | 8 | Image size |
| 24 | 32 | Image SHA-256 |
| 56 | 32 | Table SHA-256: the SHA-256 of all of MANIFEST's hashes in order |
| 88 | 32 | Version, padded with zeros |
| 120 | 4 | Changed count (with flag 1) |
| 124 | 32 | Base version: what the list goes from; empty if the card started empty |
| 156 | 32 | Base image SHA-256 |
| 188 | 4 | Blocks done (state 2) |
| 192 | 4 | Blocks to do (state 2) |

When ready, the image fields describe the mirror. While updating, they describe the image being
written, with the progress. Until the board has read its card after starting, INFO says no card.

**ERROR** payload: code u8, state u8, 0 u16, generation u32, the request's type u8, 0 × 3.

| Code | Name | What the Pi does |
| --- | --- | --- |
| 1 | `bad_frame` | Not sent any more: on the shared link a damaged frame gets STATUS. Send the request again. |
| 2 | `bad_request` | Wrong payload length, a count out of range, a reserved field not 0 |
| 3 | `unknown_type` | Not sent: a type that is not a delta request goes to the message link, which answers STATUS |
| 4 | `no_image` | The card is empty |
| 5 | `updating` | The mirror is being written. Ask INFO every few seconds until it says ready. |
| 6 | `out_of_range` | A block, an offset or an index past the end |
| 7 | `card` | The card cannot be read or is not there |
| 8 | `no_list` | The list does not describe this image (a new manifest is downloading). Use MANIFEST. |

**The generation.** Every answer carries it. If it changes while the Pi is taking an image, the image
changed under it: start again from INFO.

**Retries.** An answer whose CRC fails, STATUS where an answer was due, or an answer with another seq
or type: send the request again (the stand-in tries 5 times). An answer lost because the next
transfer's request was damaged costs that request and the next one.

### What the Pi's side needs for the shared link

`pi/` is the Pi's owner's; nothing in it changes here. What a delta receiver on the Pi, and the
programs beside it, need:

1. **One process at a time on the spidev, or a lock.** An answer comes in the transfer after its
   request, so a transfer by another process in between takes it: that process gets the answer, and
   the requester gets something else. `cranium-link` (`pi/cranium_link.py`) sends each message as
   DATA and then a POLL, and takes no lock today. Either the delta receiver and `cranium-link` take
   one lock (for example `flock` on one file under `/run/lock`) around each request and the transfer
   that brings its answer (for `cranium-link`, each DATA and its POLL), or one process does both, or
   `cranium-link` stops while an image is taken.
2. **Ignoring answers that are not its own.** The delta receiver takes only the answer whose type and
   seq are its request's, and sends the request again on anything else. `cranium-link` already does
   its part: `Link.transfer()` returns no frame for anything that is not STATUS and counts it as a bad
   reply, and `send()` sends the DATA again (up to 5 times a round), which the board acknowledges
   without delivering twice. So a delta answer that reaches it costs it a transfer and nothing more
   (`test_the_pis_sender_beside_delta_requests` in `firmware/tests/hil/test_pi_delta.py` runs
   `cranium_link.py` itself against the board's code).
3. **`cranium-link --status` is a single POLL**, so it reads the answer to the frame before it. After
   a delta request whose answer nobody took (a receiver stopped half way), that is a delta answer,
   and `--status` reports no status frame. The POLL after it always gets STATUS: a health check that
   uses `--status` (as `docs/pi-tryboot.md` on `feature/tryboot` does) should try it twice before it
   calls the board away. A receiver that ends each request with the transfer that takes its answer,
   as the stand-in does, leaves STATUS next.
4. **A longer wait for READY** on delta requests than `cranium-link`'s 0.5 s (see READY above).

## What the Pi does

1. **INFO.** State 1 (ready) is needed. With state 2, wait and ask again.
2. **MANIFEST** for all blocks (15 per request), and check that the SHA-256 of all of them in order
   is INFO's table SHA-256. These are the hashes every block it takes is checked against.
3. **Which blocks:**
   - If the list is valid and the base version and base SHA-256 are the Pi's own image: **CHANGED**,
     120 per request. That is the fast path, after each update the Pi takes.
   - Otherwise (the Pi missed an update, or has some other image): compare MANIFEST's hashes with
     the SHA-256 of each block of its own image, and take the ones that differ.
4. **READ** each of those blocks, 480 bytes per request. Pipelined, a 64 KiB block is 137 transfers.
   Check each block's SHA-256 against MANIFEST's before using it.
5. Assemble the new image (its own, with the new blocks, cut or extended to INFO's image size) on
   its inactive partition, and check the whole image's SHA-256 against INFO's.
6. Then switch to it, as the Pi's own A/B scheme does. That part is the Pi's.

**Speed, estimated.** At 8 MHz a transfer takes 0.5 ms; with READY latency and a card read, about
1 to 2 ms. 480 bytes per transfer: about 240 to 480 KB/s, so 50 MB of changed blocks in 2 to 4 min.
None of it measured.

**A warning for the Pi's side.** Linux's `spidev` is a controller, which is what this needs (#58's
`pi/cranium_link.py` already drives it). The board is the target; nothing on the Pi needs SPI target
mode.

## Sharing the message link

PR #58 brings the message link: the Pi sends its `np` and `hb` messages to the board over SPI. This work
runs on top of it, as one link:

- **One SPI driver, #58's `pi_link.c`.** It takes every transfer; `pi_rx.c` sorts each frame by type
  and hands the delta requests to `pi_dlink.c`. This page's first version (PR #276) had a driver of
  its own (`pi_dlink_spis.c`), its own `&spi3` and READY pin in `boards/pi_delta.overlay`, and
  Kconfig selects of its own: all gone. `APP_PI_DELTA` depends on `APP_PI_LINK`, and
  `boards/pi_delta.overlay` holds only the SD card.
- **A build without `--pi` is #58's**, byte for byte in behaviour: the same 16-byte STATUS buffer,
  the system work queue, and the delta types counted as unknown (`pi_rx_tests`). Its memory is #58's
  to the byte ([Memory](#memory)).
- **A `--pi` build** grows the transmit buffer to a whole frame (a delta answer is up to 512 bytes),
  arms each answer with its own length so that `0xff` follows it as it follows STATUS, and runs the
  link's work on a queue of its own (`APP_PI_DELTA_LINK_STACK_SIZE`, 2048 bytes, and
  `APP_PI_DELTA_LINK_PRIORITY`, 5), since a READ waits for the SD card. That queue also prints the
  Pi's messages, as the system work queue did. `STATUS|pi` gains a line, `pi delta  <n> answered,
  <n> refused`. The link answers delta requests as with no card until the update's side has set the
  card up at start.
- **What changed from #276's own link:** POLL's answer is STATUS, not the last answer again; a
  damaged frame gets STATUS, not ERROR `bad_frame`; a delta answer's session and ack are the
  message link's, and its seq is the request's (it echoed the request's session and seq before).
  The frames, the pins, the requests and their payloads are as they were.
- **Nothing on the Pi's side is written here.** `pi/` is the Pi's owner's; what it needs is in
  [What the Pi's side needs for the shared link](#what-the-pis-side-needs-for-the-shared-link).

## Memory

From local builds of this branch (`scripts/firmware/build.sh --keep --no-upload --without-key`, with
and without `--pi`), read with `tools/memory_budget.py`.

| Build | App flash free (of 794,474) | App RAM free (of 405,504) | MCUboot flash free | TF-M flash / RAM free |
| --- | --- | --- | --- | --- |
| Default (Bluetooth, the message link, no delta updates), this branch | 33,226 | 1,860 | 12,484 | 552 / 12,532 |
| Default, #58 alone, for comparison | 33,226 | 1,860 | 12,484 | 552 / 12,532 |
| `--pi` (the message link with delta updates, no Bluetooth), this branch | 98,474 | 18,960 | 12,484 | 552 / 12,532 |
| `--pi` with a link of its own (#276), for comparison | 100,210 | 19,808 | 12,484 | 552 / 12,532 |
| No Bluetooth, 1.18.0, for comparison (`tools/memory_budgets.json`) | 128,410 | 36,104 | 15,212 | 552 / 12,532 |

**The default build pays nothing:** 33,226 bytes of flash and 1,860 of RAM free, #58's own figures to the
byte. Everything of this is behind `CONFIG_APP_PI_DELTA`, and the job record's Pi fields are only in a Pi
build.

**A Pi build** takes about 17 KiB of the RAM that turning Bluetooth off frees, roughly:

| Item | Size |
| --- | --- |
| The update's thread stack (it runs TLS) | 5 KiB |
| The job's URL (host and path) | 2.3 KiB |
| The update's buffers (three sectors, the target manifest, a SHA-256) | about 2 KiB |
| The link's work queue stack (it also prints the Pi's messages) | 2 KiB |
| The link: a frame each way and a cached sector | 1.5 KiB |
| The card: two manifest headers and a sector | about 1 KiB |
| The HTTP buffer | 1 KiB |
| The message link's own: the start of the last `np` and `hb`, its counts | about 0.3 KiB |
| The SD host, disk access and SPI peripheral drivers | the rest |

That leaves 18,960 bytes free, 848 fewer than with a link of its own: the larger queue stack (512) and
the message link's own state. `tools/memory_budgets.json` holds the `Pi delta updates` configuration's
floors (18 KiB of RAM and 96 KiB of flash for the application), and `.github/workflows/ci.yml` builds it
when CI runs again. None of the stacks has been measured on a board
([Hardware test plan](#hardware-test-plan), step 9).

## Tests

| Where | What | Count |
| --- | --- | --- |
| `make -C firmware/tests/host`: `pi_delta_tests` | The formats and every refusal; the card's two state copies, a save cut in half, a card too small; the first image onto an empty card; deltas, larger and smaller images; a bad signature, a changed header, a job that names another image, a table that is not the signed one, too many blocks (the card untouched); a block from the server wrong once and always (never written); a card that writes wrong; **the power cut at each of 215 writes of an update in turn**, each resuming to the new image with at most one block downloaded twice; lost connections in the blocks and in the table; the card pulled out and put back; a withdrawn job; another image half way; every link request, the malformed ones, a READ while updating, a cached sector after an update; **the shared link, a mixed sequence as `pi_link.c` takes it** (DATA, delta requests, POLL, a repeated DATA, unknown types, a bad CRC, nothing, a refusal, no card yet), each frame answered in the next transfer with its answer or STATUS; the job document; the HTTP head | 1009 checks |
| `make -C firmware/tests/host`: `pi_rx_tests`, `pi_rx_delta_tests` | The message link's receiver (`pi_rx.c`) built as every other build has it, where `0x10` to `0x13` are unknown types, and as a Pi build has it, where they are delta requests; DATA, repeats, POLL, a bad CRC and nothing the same in both | 32 checks each |
| `make -C firmware/tests/host`: `ota_pi_tests` | `ota.c` in a Pi build, against a fake of the Pi side: a Pi job goes to it, again for a fresh URL; a firmware job named while it runs, or no job at all, withdraws it; a Pi job waits while a firmware update runs; a bad Pi document is refused | 511 checks (21 of them new) |
| `firmware/tests/hil/test_pi_delta.py` | `tools/pi_image.py` (the package, its checks, the comparison, the records, the built-in key, the card's layout); the board's C code on the host with real ECDSA (tinycrypt, MCUboot's own) against packages the tool signed; `tools/pi_delta_sim.py` as the Pi taking only the changed blocks and ending with the new image's SHA-256: from the list, by comparison two versions behind, from an empty card, with power cuts, a lost connection, a wrong block, a noisy wire, 64 KiB blocks, and malformed requests; messages between the requests on the same link, each delivered once, on a clean and a noisy wire; and `pi/cranium_link.py` itself beside delta requests (a delta answer costs it a transfer; `--status` right after an untaken delta answer finds none, the next one finds STATUS) | 19 tests |

**CI is off** (GitHub Actions is paused for billing). All of the above was run locally.

## What the console needs

For a paired PR later; nothing of it is in this one.

1. **Upload a Pi package:** take the `.cpd` and its `.cpd.json`, check the header's signature
   against the project key (as the board does), and put the package at
   `firmware/pi-<version>-<sha256>.cpd`. Keep the record (version, size, digest, block size, blocks).
2. **Deploy:** a job with the document in [The job](#the-job), ID `pi-...`, a presigned URL
   (`expiresInSec` up to 3600; the board refreshes it), and an in-progress timeout of hours.
3. **Which boards:** only boards running a Pi build. A Pi build has no Bluetooth, so the console
   should also never send a Pi build to a board without a Pi. Neither is marked yet: a Pi build's
   image could carry a TLV for it (as #196 proposed with `0xa3`), and the board could report its card
   in the shadow (`pi_delta_ota_report()` already writes the JSON: card state, version, generation,
   step, progress).
4. **Show progress:** the job's `step`, `progress`, `done`, `total`, and the final `fetched`,
   `changed`, `bytes`, `reason` ([The job](#the-job)).
5. **Estimate before deploying:** what `tools/pi_image.py diff` computes (changed blocks and bytes
   against the package the boards hold).
6. The apps (iPhone, Android, desktop) show the same pages, as for every console change.

## Hardware test plan

In this order, each only after the one before passes:

1. **Build and flash** `scripts/firmware/build.sh --pi` onto an nRF7002 DK (the owner flashes). Check
   the boot log: `Pi image card: ...` and no link error.
2. **The card:** a blank SDHC card in the breakout; the log says "no image" and generation 0. Take it
   out and put it back; check card detect's polarity.
3. **Seed a card:** `tools/pi_image.py card` with a small test image (a few MB), written with `dd`.
   The log says ready, generation 1.
4. **The Pi's link, INFO:** wire the Pi as in [Wiring](#wiring). First `cranium-link --status` and a
   message, as in `docs/pi-link.md`: the message link must work as before. Then, with `cranium-link`
   stopped, send INFO from the Pi with a few lines of `spidev` (or the Pi's owner's first code), and
   a POLL to take its answer. Expect state 1 and the version, and `STATUS|pi` on the board's console
   to count it under `pi delta`.
5. **READ a whole small image** from the Pi and compare its SHA-256. Then time 10 MB of READs.
6. **A delta job:** a second image with a few blocks changed, uploaded to the bucket by hand and
   deployed to the one board, with a long timeout. Watch `IN_PROGRESS` reports; expect `fetched`
   equal to the changed blocks. Then the Pi takes CHANGED and READs, and checks the digest.
7. **Faults:** cut the board's power in the middle of the blocks, then let the job go on; switch
   Wi-Fi off for a few minutes; let the URL expire (a job with `expiresInSec` of 300 and a slow
   link). Each must end `SUCCEEDED` with the right image. Take the card out in the middle: that job
   ends `FAILED` with `sd_absent`, and the same image deployed again goes on from the card.
8. **Size:** an image over 4 GiB on a 16 GB card, a delta of a few blocks past the 4 GiB mark.
9. **Measure** the stack of `pi_delta` and `pi_link` with the thread analyser, and the heap during a
   TLS range download, on Wi-Fi with AWS IoT connected.

## Untested on hardware

None of this has run on a board, a card or a Pi:

- The SD card through Zephyr's SD host on SPIM2: its start at 400 kHz, 8 MHz, sizes over 32 GB, and
  taking it out and in again (`DISK_IOCTL_CTRL_DEINIT` then `INIT`).
- The shared link with 512-byte answers: READY's timing while a READ waits for the card, the link's
  own work queue under load, and messages and delta requests on one link from the Pi.
- The TLS client: S3's answers to range requests, keep-alive between them, a range past 4 GiB, an
  expired URL's 403, and the heap and stack it takes beside AWS IoT.
- PSA's ECDSA check with the built-in key (the host tests check the same bytes with MCUboot's
  tinycrypt).
- The job's reports, a restart in the middle of a job, and a withdrawn job, on AWS IoT.
- Every speed figure on this page.

Report what cannot be run as not run, never as passed.
