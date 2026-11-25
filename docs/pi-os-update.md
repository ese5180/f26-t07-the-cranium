# Raspberry Pi OS updates with A/B slots and tryboot: the board's side

From firmware 1.20.2, a board wired to a Raspberry Pi can carry an update of the Pi's own system, as
Demetrius's tryboot design has it (`docs/pi-tryboot.md` and `pi/cranium_ota.py`, on the
`feature/tryboot` branch). The board downloads one update file onto its SD card, checks it, and offers it
to the Pi over the Pi's message link; the Pi applies it into its spare slot, boots it once on trial, and
tells the board how it went. This page is **the board's side and the contract for the Pi's
`cranium-update fetch`** (phase 2 of `docs/pi-tryboot.md`). The Pi's side is Demetrius's; nothing under
`pi/` changes here.

It sits next to the delta updates of [`docs/pi-delta-update.md`](pi-delta-update.md) (firmware 1.20.0, PR
#279) on the same plumbing: the same Pi build (`scripts/firmware/build.sh --pi`), SD card, update thread,
range downloader with resume and retries, SPI link and frames, and heartbeat report.

**None of this has run on hardware** ([Untested on hardware](#untested-on-hardware)).

## Contents

- [In short](#in-short)
- [What phase 2 asks, and where it is](#what-phase-2-asks-and-where-it-is)
- [The job](#the-job)
- [The SD card](#the-sd-card)
- [The download](#the-download)
- [The link: four requests](#the-link-four-requests)
- [What `cranium-update fetch` does](#what-cranium-update-fetch-does)
- [How a job ends](#how-a-job-ends)
- [The heartbeat](#the-heartbeat)
- [Memory](#memory)
- [Tests](#tests)
- [Questions for the Pi's side](#questions-for-the-pis-side)
- [Untested on hardware](#untested-on-hardware)

## In short

- A job `{"op":"pi_os","v":1,"pi":{"version","from","size","sha256","url"}}` names one update file:
  the tar that `cranium_ota.py make` writes (manifest.json, manifest.sig, boot.delta, root.delta).
  `from` is the Pi version it updates from, or `null` for a full image. The board never looks inside it.
- The board downloads it whole into the **file area** at the end of its SD card, with HTTP range
  requests that go on after a lost connection or a power cut, reads it back from the card, and checks its
  size and SHA-256. Only then does it **offer** it to the Pi.
- The Pi asks **FILE_INFO** (`0x20`) and reads it with **FILE_READ** (`0x21`), 480 bytes at a time, on the
  same link and frames as the message link and the delta requests. It says what it did with **RESULT**
  (`0x22`: applied, confirmed, rolled back, refused, with a reason) and what it runs with **OS_STATUS**
  (`0x23`: `cranium-update status`).
- The job reports the download's progress, then "offered", "fetched" (bytes the Pi has read), "applied",
  and ends **SUCCEEDED** when the Pi confirms the new slot (or says it runs that version, off trial), or
  **FAILED** when it refuses the file or rolls it back, with its reason.
- The heartbeat's `pi` object gains `os`: what the Pi runs (version, slot, last result) and the file
  (state, the Pi's result for it, progress).
- A build without `--pi` is unchanged to the byte: everything here is behind `CONFIG_APP_PI_DELTA`.

## What phase 2 asks, and where it is

`docs/pi-tryboot.md`, "What the nRF side needs (phase 2)", against this PR:

| Phase 2 asks | Here |
| --- | --- |
| nRF 1. **Storing the update** (a few MB; external flash, or the SD card of #196) | The SD card of #279 (`pi_card.c`), in a new **file area** at its end, with a header of two copies in sectors no earlier layout uses ([The SD card](#the-sd-card)). Files up to 4 GiB − 1. External flash was not used: the card already holds the delta mirror, and a file of any size fits it |
| nRF 2. **Getting it from the cloud**: a job with URL, size, SHA-256; HTTPS with resume; check the SHA-256 before offering it | `"op":"pi_os"` ([The job](#the-job)); #279's TLS range client and retries ([The download](#the-download)); the SHA-256 of the file **as read back from the card**, before it is offered |
| nRF 3. **Answering the Pi**: the manifest, and chunks from storage, at most about 490 bytes a frame | FILE_INFO (version, from, size, SHA-256, generation) and FILE_READ (480 bytes a frame, the frame's CRC over them), answered in the next transfer like every request on the link ([The link](#the-link-four-requests)). The manifest itself is the first member of the tar: the Pi reads it with FILE_READ |
| nRF 4. **Reporting** the Pi's version and each update's result (shadow and job status) | RESULT and OS_STATUS frames; the job's IN_PROGRESS, SUCCEEDED and FAILED reports ([How a job ends](#how-a-job-ends)); `os` in the heartbeat's `pi` ([The heartbeat](#the-heartbeat)) |
| nRF 5. **Agreeing with #196** (the Pi is the SPI controller) | As #279: the board is the SPI target on #58's link; the Pi drives every transfer |
| Pi 1. `cranium-update fetch`: ask, read the manifest first, decline what is not for this Pi, pull in chunks into `/data/cranium-ota/` with resume, run `apply` | Not here (`pi/` is Demetrius's). What it must do, step by step: [What `cranium-update fetch` does](#what-cranium-update-fetch-does). `tools/pi_os_sim.py` is a stand-in that does all of it against the board's real code |
| Pi 2. Frame types: "what update do you have", "bytes from offset X with a CRC", "here is the result" | FILE_INFO, FILE_READ, RESULT, byte by byte below |
| Pi 3. The Pi telling the nRF what it runs, at start and after each update; `np`/`hb` unchanged | OS_STATUS. `np` and `hb` are untouched |
| Cloud 1, 2: keep every release's images, make a delta from each version in use, pick the delta by the Pi's reported version | Not here: a console PR. The Pi's version is in the shadow (`reported.pi.os.version`) for it |

## The job

```json
{ "op": "pi_os", "v": 1,
  "pi": { "version": "1.1.0", "from": "1.0.0", "size": 4194304,
          "sha256": "<64 hex: SHA-256 of the whole file>",
          "url": "${aws:iot:s3-presigned-url-v2:https://s3.<region>.amazonaws.com/<bucket>/firmware/pi-os-1.1.0-<sha256>.update}" } }
```

| Field | Rule |
| --- | --- |
| `version` | 1 to 31 of `A-Z a-z 0-9 . _ + -`, as `cranium_ota.py` versions (`1.1.0`) are |
| `from` | The same, or `null` for a full image. It must be there |
| `size` | 1 to 4,294,967,295 bytes: the file's |
| `sha256` | The file's, lowercase hex |
| `url` | Under the board's provisioned download prefix, as for firmware and `pi_delta` |

- Any other build answers `"op":"pi_os"` as `unsupported`, as it does any `op` it does not know.
- **One Pi job at a time**, of either kind: AWS IoT names the job in progress first, so another job named
  while one runs means it was withdrawn (as for `pi_delta`).
- **In-progress timeout:** the job waits for the Pi, which reads the file at its own pace and restarts
  twice (into the trial, and back if it fails). Give it hours, as for `pi_delta`.
- **The board does not judge the file.** It checks size and SHA-256 only; whether it is for this Pi (the
  version it runs, newer, the signature) is the Pi's to say, with RESULT "refused".

## The SD card

#279's layout is unchanged; the file area is new and takes nothing #279 uses. In 512-byte sectors:

| Where | What | New? |
| --- | --- | --- |
| 0 to 2047 | Not touched by the board (`tools/pi_image.py card` puts a partition table there) | |
| 2048, 2049 | Two copies of the delta state header (`CPDS`) | |
| **2050, 2051** | **Two copies of the file header (`CPOF`)** | **1.20.2** |
| 4096 onward | The delta slots, list, staging and mirror, as #279 lays them out | |
| **at the end of the card** | **The file, from a 1 MiB boundary, never below the end of the mirror's images** | **1.20.2** |

**Compatibility with cards #279 laid out:** sectors 2050 and 2051 sit between the state header and slot
0, which #279 never writes (`tools/pi_image.py card` leaves zeros there), so such a card simply has no file
until a `pi_os` job writes one. A header whose CRC fails, or that places its file where it cannot be
(inside the layout or the mirror's images, past the card's end), counts as no file. The two kinds keep out
of each other's way: a file is placed past the mirror's current image and any update in progress, and a
delta image that would reach the file is refused with `too_large` while the card holds a file.

**The file header** (one sector, little-endian; the good copy with the higher sequence counts, and each
save goes to the other, so a save cut by a power cut leaves the one before):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | Magic `CPOF` |
| 4 | 2 | Format, 1 |
| 8 | 4 | Sequence |
| 12 | 1 | State: 0 none, 1 downloading (or being checked), 2 ready (whole, its SHA-256 the job's) |
| 13 | 1 | The Pi's result for this generation: 0 none, 1 applied, 2 confirmed, 3 rolled back, 4 refused |
| 16 | 4 | Generation: one up each time a job takes the file area |
| 20 | 4 | Size in bytes |
| 24 | 4 | Bytes on the card: whole sectors, until the last |
| 28 | 4 | The job that took it: CRC-32 of its ID |
| 32 | 8 | The file's first sector |
| 40 | 32 | SHA-256 of the file |
| 72 | 32 | Version, padded with zeros |
| 104 | 32 | The version it updates from; zeros for a full image |
| 136 | 32 | The Pi's reason for its result, printable ASCII, padded with zeros |
| 508 | 4 | CRC-32 (zlib's) of bytes 0 to 507 |

**The generation** identifies an offer. A new file starts the next one; so does another job for the same
file (redeployed after a refusal, say), which offers it anew with no result. The same job named again
(after a restart, or for a fresh URL) keeps it. The Pi keys everything it remembers on the generation.

## The download

`pi_os.c`, on #279's update thread, through #279's TLS client (`pi_delta_ota.c`). Every call starts from
what the card says.

1. **Take the file area.** The file the card holds already, if it is the job's (size, SHA-256, version,
   from); otherwise a new one, placed at the end of the card, saved as "downloading" with nothing counted.
   The header is saved before any of the file is written.
2. **Download** the rest in one range, from the first byte the card does not hold. A sector at a time
   onto the card (the last padded with zeros); the header counts them every 64 sectors (32 KiB) and when
   the transfer ends, for whatever reason. A sector is always written before a save counts it.
3. **Check:** read the whole file back from the card and hash it. The job's SHA-256: the header says
   "ready". Not: nothing on the card counts any more, and it is downloaded once more; wrong twice, the job
   fails with `digest_mismatch`.

| What breaks | What happens |
| --- | --- |
| Power cut, at any write | The next call goes on from the last save: at most 64 sectors come again. The card never says "ready" for bytes that are not the file (the test cuts the power at each of 58 writes in turn, from a blank card and from one that holds another file) |
| Connection lost, URL expired, server short | `download_failed` for this call: what reached the card is saved, the board asks for the job again (a fresh URL), waits 10 s × attempts, and goes on. 10 attempts in a row with nothing new fail the job, as for `pi_delta` |
| The file comes wrong, or the card stores it wrong | Found when it is read back; downloaded once more; twice fails the job (`digest_mismatch`). Never offered |
| No room past the mirror's image | `too_large`; the card is not written |
| Card taken out | `sd_absent` (or `sd_io`); a job for the same file later goes on from the card |
| Withdrawn | Stops at the next piece, nothing reported; the card keeps its progress |

## The link: four requests

**The same link and rules as #279** ([The SPI protocol](pi-delta-update.md#the-spi-protocol)): the Pi is
the SPI controller, every transfer is 512 bytes each way, frames are #58's (`CL`, version 1, type, session,
seq, ack, length, payload, CRC-32 of everything before it), and **the board answers each frame in the next
transfer**. A request's answer has its type with `0x80` set and its seq; a refusal is ERROR (`0xff`), whose
payload names the request's type. Anything else (DATA, POLL, a damaged frame, nothing) gets the message
link's STATUS, so POLL's answer is always STATUS. An answer carries the message link's session and ack.
Numbers are little-endian. **Every request is safe to send again**: FILE_INFO and FILE_READ only read;
RESULT and OS_STATUS store the same thing twice.

| Request (Pi to board) | Type | Payload | Answer (board to Pi) |
| --- | --- | --- | --- |
| FILE_INFO | `0x20` | none | `0xa0`, 116 bytes, below |
| FILE_READ | `0x21` | offset u32, length u16 (1 to 480), 0 u16: 8 bytes | `0xa1`: generation u32, offset u32, length u16, 0 u16, size u32, then *length* bytes |
| RESULT | `0x22` | code u8, *n* u8 (0 to 64), 0 u16, generation u32, version 32 bytes (zero-padded), then *n* bytes of reason: 40 + *n* bytes | `0xa2`, 8 bytes: generation u32, state u8, kept u8 (1 if the board kept it), 0 u16 |
| OS_STATUS | `0x23` | slot u8, default slot u8, trial u8 (0 or 1), last u8, version 32 bytes, last version 32 bytes: 68 bytes | `0xa3`, 8 bytes: generation u32, state u8, 1 u8, 0 u16 |

**FILE_INFO** (116 bytes):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 2 | Protocol version, 1 |
| 2 | 1 | State: 0 no file, 1 downloading (or being checked), **2 offered**, 3 held (whole, but no job offers it now) |
| 3 | 1 | Flags: 1 a full image (no version it updates from), 4 no card (the rest says nothing) |
| 4 | 4 | Generation |
| 8 | 4 | Size in bytes |
| 12 | 4 | Bytes on the board's card so far (state 1) |
| 16 | 1 | The result the board holds for this generation (RESULT's codes; 0 none) |
| 17 | 3 | 0 |
| 20 | 32 | SHA-256 of the file |
| 52 | 32 | Version, zero-padded |
| 84 | 32 | The version it updates from, zero-padded; zeros for a full image |

**Only state 2 may be read.** A file is offered while a job waits for the Pi, and only then: one whose job
ended, was withdrawn, or has not come back after the board restarted is held (state 3), and FILE_READ is
refused. Until the board has read its card after starting, FILE_INFO says no card.

**RESULT codes:** 1 applied (written into the spare slot; the Pi restarts into it on trial), 2 confirmed,
3 rolled back, 4 refused (not installed: not for this Pi, not newer, bad signature, or anything else
`apply` refused). The board **keeps** a RESULT (with the file's header, on the card, so a restart loses
nothing) when it names the generation the card holds, ready, and that file's version; it answers any
other well-formed one with kept 0 (a result for a file the board no longer holds). The reason is the Pi's
text: the board keeps its first 32 bytes up to any zero, and makes anything but printable ASCII, and `"`
and `\`, into `?`. Send it in ASCII.

**OS_STATUS:** slot and default slot are `'a'`, `'b'`, or 0 for not known; *last* is the last result in
the Pi's `state.json` (0 none, 2 confirmed, 3 rolled back); the versions are zero-padded. A version that is
not 1 to 31 of `A-Z a-z 0-9 . _ + -` is kept as not known. The board keeps the last one in RAM: a board
that restarts knows nothing until the Pi sends it again, so send it at the start of every run.

**ERROR** (12 bytes, as #279's): code u8, the file's state u8 (FILE_INFO's), 0 u16, the file's generation
u32, the request's type u8, 0 × 3.

| Code | For the file requests | What the Pi does |
| --- | --- | --- |
| 2 `bad_request` | A payload of the wrong length, a reserved field not 0, a length of 0 or over 480, a RESULT code or OS_STATUS field out of range, a reason over 64 bytes | Fix the request: it will never be taken |
| 4 `no_image` | FILE_READ with no file offered (none, or held) | Ask FILE_INFO again later |
| 5 `updating` | FILE_READ while the file is downloading or being checked | Ask FILE_INFO again later |
| 6 `out_of_range` | FILE_READ past the file's end | A bug on the Pi's side |
| 7 `card` | No card, the card could not be read or written, or (just after the board starts) the link not yet set up | Send it again later |

**Retries.** As #279's: an answer whose CRC fails, STATUS where an answer was due, or an answer with
another seq or type, and the request goes again (the stand-ins try 5 times). Use seq 1 to 65535, never 0,
which STATUS carries. **READY** may stay low longer than `cranium-link`'s 0.5 s while a FILE_READ waits for
the SD card: wait longer for these requests. And as for #279's requests ([What the Pi's side needs for the
shared link](pi-delta-update.md#what-the-pis-side-needs-for-the-shared-link)): one process at a time on
the spidev (a lock around each request and the transfer that brings its answer), and a `--status` health
check that tries twice.

**Speed, estimated:** a FILE_READ every transfer, pipelined, 480 bytes per transfer: about 240 to 480 KB/s
at 8 MHz, so a 5 MB delta in 10 to 20 s. A full image of several GB would take hours. Not measured.

## What `cranium-update fetch` does

One run, at boot after `cranium-update-confirm` and then every minute or so (it costs two transfers when
nothing is offered). `tools/pi_os_sim.py` does every step against the board's code. In
`/data/cranium-ota/` it keeps a small state: the generations it has handled and with what result, a result
not yet answered, and the partial file.

1. **A result not yet answered** (the Pi restarted before the board's answer came): send that RESULT first.
2. **OS_STATUS**, with `cranium-update status`: slot, default, trial, `last.result`, version, `last.version`.
3. **FILE_INFO.** Nothing to do unless state is 2 (offered). A generation it has handled already: stop
   (its result went with it).
4. **Not for this Pi, before reading any of it:** `from` set and not the version it runs, or `version`
   not newer than it (`version_key`, as `apply` compares): RESULT refused, with the reason. Stop.
5. **Read** with FILE_READ from where its partial file (`<sha256>.part`) ends, 480 bytes at a time,
   pipelined: each transfer carries the next FILE_READ and brings the last one's answer; the last answer
   comes with a POLL. **Every answer's generation must be FILE_INFO's**; if it changes, or FILE_READ is
   refused with `no_image` or `updating`, the offer changed: drop the partial file and start again from 3.
   Write each piece at its offset; fsync now and then.
6. **The whole file's SHA-256** must be FILE_INFO's. If not: delete it and start again (a few times at most).
7. **`apply`** it (`apply_update(..., reboot=False)`): the signature, the manifest against the running slot,
   the new slot written and checked. If it raises `UpdateError`: RESULT refused, with its message. Stop.
8. **RESULT applied**, then `reboot '0 tryboot'`. Keep the generation with the pending update in
   `state.json` (or beside it), so that the next step knows which one it was.
9. **After the trial** (`confirm` has run at boot): RESULT confirmed, or rolled back with the reason (the
   health check that failed), for that generation and version. Then OS_STATUS again.

A RESULT goes again until its `0xa2` answer comes; *kept* 0 means the board no longer holds that file, and
there is nothing more to tell it.

## How a job ends

The job's reports (`statusDetails`, every value a string), from `pi_delta_ota.c` with the details built in
`pi_os.c`:

| When | Status | Details |
| --- | --- | --- |
| The job starts | IN_PROGRESS | `step: download` |
| Every 30 s while downloading or checking | IN_PROGRESS | `step` (`download`, `verify`), `progress` (%), `done`, `total` (bytes) |
| Checked, offered | IN_PROGRESS | `step: offered`, `generation`, `read: 0`, `total` |
| The Pi reads it (at once, then at most every 30 s) | IN_PROGRESS | `step: fetched`, `generation`, `read` (bytes the Pi has read, the furthest), `total` |
| RESULT applied | IN_PROGRESS | `step: applied`, ... |
| RESULT confirmed, or OS_STATUS says it runs the job's version off trial | SUCCEEDED | `pi_version`, `generation`, `bytes` (downloaded by this board in this run), `read`, `running` |
| RESULT refused or rolled back | FAILED | `reason` (`refused`, `rolled_back`), `pi_reason` (the Pi's, cleaned), `step: result`, `running` |
| The download fails | FAILED | `reason` (`download_failed`, `digest_mismatch`, `too_large`, `sd_absent`, `sd_io`), `step`, `running` |

- **A Pi that already runs the version** (its last OS_STATUS says so, off trial) ends the job SUCCEEDED at
  once, with nothing downloaded.
- **A restart of the board** while the Pi is on trial: the job comes back in progress, its file is still
  on the card under the same generation, and it is offered again. A RESULT the Pi sent meanwhile is on the
  card already; one it sends later is taken; and if the Pi's next OS_STATUS shows it runs the version, the
  job succeeds.
- **The card taken out** while the file is offered: the Pi gets nothing; put back, the file is offered
  again if the card still holds it, or taken again (downloaded) if not.
- **The file stays on the card** after the job, held: the Pi is offered nothing without a job.

## The heartbeat

A Pi build's `pi` object ([The card in the shadow](pi-delta-update.md#the-card-in-the-shadow)) ends with
`os`:

```json
"pi": { "card": "ready", "version": "2026.11.24-1", "generation": 3, "step": "idle", "done": 10, "total": 10,
        "os": { "version": "1.1.0", "slot": "b", "last": "confirmed",
                "file": "ready", "result": "none", "done": 4194304, "size": 4194304 } }
```

| Key | Value |
| --- | --- |
| `version`, `slot`, `last` | The Pi's last OS_STATUS: what it runs, `a`/`b`, and the last result in its state (`none`, `confirmed`, `rolled_back`). `""`, `""`, `none` before it has sent one since the board started |
| `file` | `none`, `downloading` (or being checked), `ready` (offered to the Pi now), `held` (whole, no job offers it) |
| `result` | What the Pi said it did with that file: `none`, `applied`, `confirmed`, `rolled_back`, `refused` |
| `done`, `size` | Bytes of the file on the card, and its size; 0 and 0 with no file |

**Size.** At its longest the `pi` object is 305 bytes (`PI_DELTA_REPORT_MAX` is 306 with the terminating
zero, from 143): the heartbeat's buffer is 711 bytes in a Pi build (on the main loop's stack, of 6 KiB),
and the shadow document 736 bytes (`CLOUD_REPORTED_MAX` 713). `main.c`'s `BUILD_ASSERT` checks the longest
heartbeat fits the document; `test_app.c` and `test_pi_os.c` check the longest is exactly that.

## Memory

From local builds of this branch (`scripts/firmware/build.sh --keep --no-upload --without-key`, with and
without `--pi`), read with `tools/memory_budget.py`.

| Build | App flash free (of 794,474) | App RAM free (of 405,504) | MCUboot flash free | TF-M flash / RAM free |
| --- | --- | --- | --- | --- |
| Default (Bluetooth, the message link, no Pi updates), this branch | 33,226 | 1,860 | 12,484 | 552 / 12,532 |
| Default, #279, for comparison | 33,226 | 1,860 | 12,484 | 552 / 12,532 |
| `--pi` (delta and OS updates, no Bluetooth), this branch | 92,090 | 18,448 | 12,484 | 552 / 12,532 |
| `--pi`, #279 (delta updates only), for comparison | 98,370 | 18,880 | 12,484 | 552 / 12,532 |

**The default build pays nothing:** its figures are #279's to the byte. Everything here is behind
`CONFIG_APP_PI_DELTA`; the job record's `pi_from` is only in a Pi build.

**A Pi build pays about 6.3 KB of flash and 432 bytes of RAM.** The flash, from the two builds' symbols
(LTO moves code between functions, so roughly): the download, its read-back check and the placement
(about 1 KB, in the update's thread), the four requests (about 760 bytes, in the link's work), the job's
offer and its watch for the Pi's result (about 780), the file header's format, open, load and store
(about 1.3 KB), the job document and the heartbeat's `os` (about 700), and the reports' text. Trimmed back:
one progress report for both kinds of job, and two log lines the job's reports carry (176 bytes). The RAM:
the shadow document's 160 more bytes for `os`, the job record's `from` in its two copies (64), the card's
file state and the Pi's status (108), the job's own state, and the engine (48 bytes, packed from 80).

**Floors:** the Pi build's flash floor goes from 98,304 to **91,648** (13 steps of 512) in
`tools/memory_budgets.json`, as this needs about 6.3 KB and the build had 66 bytes above the old floor.
**Lowering a floor is the owner's call**: this PR proposes it and says why. The RAM floor (18,432) holds,
16 bytes above it. The default build's floors are unchanged.

## Tests

| Where | What | Count |
| --- | --- | --- |
| `make -C firmware/tests/host`: `pi_os_tests` | The file header (every field, every refusal, a reason with `"`, `\`, controls and UTF-8 cleaned); the download onto a blank card, the same job again (nothing downloaded), another job for the same file (offered anew), another file, a full image, a whole number of sectors; **the power cut at each of 58 writes in turn**, from a blank card and from one holding another file, each resuming in one call with at most a save's worth again and never "ready" with the wrong bytes; a lost connection, a short server, a withdrawn job (half way, and before it starts), the card pulled and put back, a card that cannot be written, no card; a wrong SHA-256 (twice, then refused, nothing kept), a byte wrong from the server once, a bit stored wrong once; next to #279's mirror (placed past it, the mirror and its state untouched, a delta image that would reach the file refused), a file too large, a header that points into the mirror, a torn newer copy, a failed save leaving RAM as it was, garbage where the header goes; **every file request**: before the link has a card, a card not read yet, no file, downloading, held, offered, the whole file in 480-byte pieces, nine malformed or out-of-range FILE_READs, malformed RESULTs, a RESULT for another generation or version, kept ones (on the card after a reopen), a long and dirty reason, a card that cannot be written, malformed OS_STATUS, a version that is not one, a new file where the old one was with the link's cache full (the card open all along), a full image's flag, the card taken out and put back, a header that cannot be read, a message between requests; what a job decides from each result and status; each report's JSON; the heartbeat's `os` in each state, at its longest exactly `PI_DELTA_REPORT_MAX`; the job document (14 bad ones); the delta update's progress report, which now shares the same function | 742 checks |
| `pi_delta_tests`, `app_pi_tests`, `pi_rx_tests`, `pi_rx_delta_tests`, `host_tests` | #279's, with `os` in every card report and the longest heartbeat; `0x20` to `0x23` taken in a Pi build and unknown in any other; `"op":"pi_os"` unsupported in a build without Pi updates | 1041, 13,964, 45, 45, 482 checks |
| `firmware/tests/hil/test_pi_os.py` | The board's C code on the host (`pi_delta_harness os-update` and `serve --offer`) and `tools/pi_os_sim.py` as the Pi, with update files laid out as `cranium_ota.py make` writes them and signed with Ed25519: an update end to end (status, offer, read, signature, applied, trial, confirmed, status; the board keeps the result across a restart); nothing without a job; the Pi cut off half way and going on; refused before reading (wrong `from`; not newer); a bad signature; rolled back; a full image; a noisy wire with messages between the requests; a result sent again after a Pi restart; eight malformed requests; the download with a lost connection and a power cut; a wrong SHA-256 never offered; a delta image and an OS file on one card, each taken by its own stand-in | 15 tests |
| `firmware/tests/hil/test_pi_delta.py` | #279's, unchanged | 19 tests |

All host suites: 45, green. CI is off (GitHub Actions is paused); all of it was run locally.

## Questions for the Pi's side

1. **The generation across the trial.** Step 8 asks `fetch` to keep FILE_INFO's generation with the
   pending update, so that the RESULT after the trial names it. Is `state.json`'s `pending` the place, or a
   file of `fetch`'s own?
2. **`apply` without its reboot.** `fetch` sends RESULT applied before the restart, so it needs
   `apply_update(reboot=False)` and then the reboot itself. Is that how you want it, or should `apply`
   send it?
3. **Refused versus not for me.** The board fails the job on any refusal. A Pi that is simply on another
   version (the cloud picked the wrong delta) fails it too, with the reason. Fine, or should "not for me"
   be a code of its own, for the console to send the right file?
4. **Health check and the link.** The trial's health check is `cranium-link --status`; `fetch` and
   `cranium-link` must not both drive the spidev at once (a lock, as in #279's notes). Which lock file?
5. **Reason text.** The board keeps 32 bytes of ASCII. Enough for `UpdateError` messages, or should the
   board keep more?

## Untested on hardware

None of this has run on a board, a card or a Pi:

- The file area on a real SD card through Zephyr's SD host: placement at the card's end, single-sector
  writes, the read-back check's time for a few MB.
- The download over TLS from S3 with range requests (the same client as #279, which has not run either).
- The four requests on the shared link with a real Pi, READY's timing while FILE_READ waits for the card,
  and the speed estimate above.
- The job's reports on AWS IoT, a restart of the board while the Pi is on trial, and the heartbeat's
  longer `pi` with the console.
- The stacks: the update thread's (5 KiB, TLS) and the link queue's (2 KiB) with these requests.

**It needs Demetrius's `cranium-update fetch` (phase 2) to talk to it.**

Report what cannot be run as not run, never as passed.
