# The SPI link from the Raspberry Pi to the board

The Pi runs Mixxx and the collector (`pi/`, step 1). The collector writes `np` (now playing) and `hb` (heartbeat)
messages to `~/.cranium/messages.jsonl`. `pi/cranium_link.py`, which `pi/bin/cranium-link` runs, sends each new
message to the nRF7002 DK over SPI. The board's side is `firmware/app/src/pi/`, built into its firmware: it prints
each message on its serial console as `[PI] {...}`, and `STATUS|pi` shows the link's state. Sending the messages on
to the website over Bluetooth comes in a later step.

| Runs on | What |
| --- | --- |
| The Pi | `pi/cranium_collect.py` (the collector) and `pi/cranium_link.py` (the sender) |
| The nRF7002 DK | `firmware/app/src/pi/`, in the board's firmware: the frames, the SPI peripheral, READY, `STATUS\|pi` |
| Your computer | Building and flashing the firmware, the serial monitor, and the bench test (`firmware/tests/hil/pi_link_bench.py`) |

## Setting up a bench, step by step

This works from macOS, Linux, or Windows in WSL2, as in [`new-board-setup.md`](new-board-setup.md#windows-linux-and-macos).
The Pi itself needs no GitHub access: you copy `pi/` to it from your clone.

### What you need

- A Raspberry Pi 4 or 5 with Raspberry Pi OS (trixie), set up as in [`pi/README.md`](../pi/README.md): the team's Mixxx
  fork, and the Cranium Metrics mapping loaded once in Mixxx.
- An nRF7002 DK and its USB cable, plugged into your computer.
- Six female-to-female jumper wires.
- On your computer: the repository, nRF Connect SDK v3.4.0 with `nrfutil`, and the team signing key at
  `~/.cranium/mcuboot_signing_key.pem` ([`new-board-setup.md`](new-board-setup.md#install-the-tools),
  [`secrets/README.md`](../secrets/README.md)).
- SSH into the Pi by key. The Pi takes no passwords: someone who can already log in adds your public key
  (`~/.ssh/id_ed25519.pub`) to the Pi's `~/.ssh/authorized_keys`. Check with `ssh <user>@<pi>`, and use your Pi's
  user and address everywhere below.

### 1. Wire the Pi to the DK

With both powered off:

| Signal | Raspberry Pi | nRF7002 DK |
| --- | --- | --- |
| SCLK | GPIO11, header pin 23 | D13 (P1.15) |
| MOSI (Pi to board) | GPIO10, header pin 19 | D11 (P1.13) |
| MISO (board to Pi) | GPIO9, header pin 21 | D12 (P1.14) |
| CS | GPIO8 (CE0), header pin 24 | D10 (P1.12) |
| READY (board to Pi) | GPIO25, header pin 22 | D9 (P1.11) |
| Ground | header pin 25, or any ground | GND |

Both sides use 3.3 V logic, so the wires go straight across, with no level shifter. The DK's D pins are on its
Arduino headers.

### 2. Turn SPI on in the Pi, once

```bash
ssh <user>@<pi> 'sudo sed -i "s/^#dtparam=spi=on/dtparam=spi=on/" /boot/firmware/config.txt && sudo reboot'
```

After the reboot, `ssh <user>@<pi> ls /dev/spidev0.0` must show the device. The Pi user must be in the `spi`, `gpio`
and `dialout` groups (`id` shows them); Raspberry Pi OS's first user is.

### 3. Build the firmware and flash the DK

In your clone, on this branch:

```bash
git fetch origin && git switch feature/pi-spi-link
scripts/firmware/build.sh --no-upload
```

`build.sh` signs the image with the team key, under the next unused version. On Linux and WSL, set
`NCS_DIR=~/ncs/v3.4.0` in front of it if the SDK is not in `/opt/nordic/ncs`.

It also leaves two things that must **not** be committed: the new version in `firmware/app/VERSION`, and the image in
`binaries/` (a folder git keeps, for releases only). Once you have flashed, put both back:

```bash
git restore firmware/app/VERSION
git status binaries        # then delete the new cranium-<version>-0.* files it lists
```

Then flash, from an [nRF Connect SDK terminal](new-board-setup.md#an-nrf-connect-sdk-terminal) in the repository
(`export ZEPHYR_BASE=/opt/nordic/ncs/v3.4.0/zephyr` first). Which command depends on the board:

- **A spare DK, or one with other firmware:** `west flash --recover`. This erases everything on it. The board then
  starts in factory mode and needs an ID: in the serial monitor (step 4), send `INIT|<id>`, letters and digits only,
  such as `CRBENCH02`. It restarts with that ID.
- **A team board that is already provisioned** (it has Wi-Fi and AWS): `west flash`, without `--recover`, and no
  `INIT`. Both would wipe the board's identity, which then takes a full provisioning again
  ([`new-board-setup.md`](new-board-setup.md)).

### 4. Open the board's console

The DK shows two serial ports. The board's console is the second one:

| | The console |
| --- | --- |
| macOS | `/dev/cu.usbmodem<probe>3`, the one ending in 3 (`ls /dev/cu.usbmodem*`) |
| Linux, WSL | The higher of the two `/dev/ttyACM*` |
| Windows | The `COM` port that `nrfutil device list` marks `vcom: 1` |

Any serial monitor works, at 115200 baud, 8N1, with Enter sending a carriage return. For example:

```bash
screen /dev/cu.usbmodem<probe>3 115200                      # macOS; quit with Ctrl-A then K
python3 -m serial.tools.miniterm /dev/ttyACM1 115200        # Linux, in an SDK terminal; quit with Ctrl-]
```

Type `STATUS|pi` and Enter. The first line should say `pi link        waiting for the Pi`. If it says
`factory mode, send INIT|<id> first`, do the `INIT` of step 3.

Only one program can have the port open at a time: close the monitor before running the bench (step 6).

### 5. Copy the Pi's files to the Pi

From your clone:

```bash
rsync -a pi/ <user>@<pi>:~/cranium/pi/
ssh <user>@<pi> '~/cranium/pi/bin/cranium-install && ~/cranium/pi/bin/cranium-link --status'
```

`--status` should print `Frame(type=0x81, ...)`: the board answered over SPI. `no status frame` means a wire or the
firmware; the bench below says which.

### 6. Run the bench test

From your clone, in an SDK terminal (it has `pyserial`), with the board's console closed:

```bash
python3 firmware/tests/hil/pi_link_bench.py run --pi <user>@<pi>
```

The bench finds the board's console by itself on macOS and Linux; on Windows add `--port COM<n>`. It does the SPI
transfers on the Pi over one SSH session, and reads what the board did from its console. All 9 steps should say
PASS:

| Step | What it shows |
| --- | --- |
| firmware | The board runs firmware with the link (`STATUS\|pi` answers) |
| ready | READY is high: the D9 to GPIO25 wire |
| status | The board answers a POLL: SCK, CS and MISO |
| deliver | A message is acknowledged and printed once: MOSI |
| utf8 | Text such as `Jaÿ‐Z` arrives as sent |
| repeat | A frame sent twice is printed once |
| corrupt | A frame with a bad CRC is dropped and counted |
| largest | The largest message, 496 bytes |
| burst | 100 messages in a row, all printed in order |

A failing step says which wire or part to look at. Results go to `pi-link-bench/results.jsonl`.

With the DK's USB plugged into the Pi instead, the bench runs on the Pi itself, without `--pi`, after copying
`firmware/tests/hil/` and `tools/board.py` there as well.

### 7. Send live data from Mixxx

On the Pi, start Mixxx from its desktop menu (`cranium-install` made the menu start it the right way), then in two
terminals on the Pi:

```bash
~/cranium/pi/bin/cranium-collect --heartbeat 2
```

```bash
~/cranium/pi/bin/cranium-link
```

In the board's console (step 4), a `[PI] {"t":"hb",...}` line arrives every 2 seconds, and a `[PI] {"t":"np",...}`
line when a new track becomes the main track. `STATUS|pi` shows:

```
pi link        up (last frame 0.4s ago)
pi messages    12
pi repeats     0
pi polls       12
pi bad frames  0 (crc 0)
pi last np     {"t":"np","ti":"Can I Live","ar":"Jaÿ‐Z","ge":"","bpm10":1520,"dur":250}
pi last hb     {"t":"hb","up":28,"mx":1,"pl":2,"bpm10":1520,...}
```

To stop: Ctrl-C in both terminals, then quit Mixxx.

### When something is wrong

| What you see | What to check |
| --- | --- |
| `build.sh`: nRF Connect SDK v3.4.0 was not found | `NCS_DIR`, as in step 3 |
| `build.sh`: the signing key was not found | `~/.cranium/mcuboot_signing_key.pem` |
| `STATUS\|pi`: unknown section | The board runs firmware without the link: flash this branch's build |
| `STATUS\|pi`: factory mode | `INIT\|<id>`, step 3, on a spare board only |
| `cranium-link --status`: no status frame | The wires, step 1, and `ls /dev/spidev0.0` on the Pi |
| bench: `ready` fails | The D9 to GPIO25 wire, and ground |
| bench: `status` fails, `ready` passes | SCK, CS or MISO |
| bench: `deliver` fails, `status` passes | MOSI |
| bench: the helper did not start | SPI on (step 2), and the Pi user in `spi` and `gpio` |
| The serial port can't be opened | Another program has it open; on Linux, you aren't in `dialout` yet |
| `mx` stays 0 in the `hb` lines | Mixxx side, not the link: see [`pi/README.md`](../pi/README.md) |

## How the link works

### Frames

Each transfer is 512 bytes each way. The Pi sends one frame, and the board answers with one frame at the same
time. Numbers are little-endian.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 2 | `CL` |
| 2 | 1 | version, 1 |
| 3 | 1 | type: `0x01` DATA and `0x02` POLL from the Pi, `0x81` STATUS from the board |
| 4 | 2 | session: from the Pi, a random number other than 0, picked each time it starts; from the board, the session of the last DATA frame it accepted (0 for none) |
| 6 | 2 | seq: the number of a DATA frame in its session |
| 8 | 2 | ack: from the board, the seq of the last DATA frame it accepted |
| 10 | 2 | payload length, at most 496 |
| 12 | n | payload: for DATA, one message, a JSON line without its line ending |
| 12+n | 4 | CRC-32 (zlib's) of everything before it |

The rest of the 512 bytes is ignored: the Pi pads its frames with zeros, and the board sends only its 16-byte
STATUS frame and then `0xff`.

The board prepares its STATUS frame before a transfer, so it acknowledges a DATA frame in the transfer that
follows. To send a message, the Pi:

1. waits for READY to be high (at most 0.5 s),
2. sends the DATA frame,
3. waits for READY again, and sends a POLL,
4. checks that the STATUS it got back names its session and seq; if not, it starts again from 1, up to 5 times.

The board delivers a message only once. A DATA frame with the same session and seq as the last one it accepted
is acknowledged again but not printed again. A frame with a bad CRC is counted and dropped. While the board is
not armed, between transfers or when it is not running, it sends `0xff`, and the Pi reads that as no answer.

While the board doesn't answer, `cranium-link` keeps the newest 500 messages and sends them in order once it
does.

### On the board

The link has no thread of its own: the SPI driver hands each transfer to the system work queue. RAM is short on
the nRF7002 DK, so it keeps one frame's receive buffer, its STATUS frame, and the first 128 bytes of the last `np`
and `hb`. To fit it, the heap is 2 KB smaller in builds with Bluetooth updates (`firmware/app/bt_ota.conf`).

The `[PI]` message lines go to the serial console only, not to the cloud's event feed: one line per message
would be too many there. `[PI] link up`, printed when frames start arriving after 30 s without any, does go
to the cloud.

The pins are set in `firmware/app/boards/nrf7002dk_nrf5340_cpuapp_ns.overlay` (SPIS3, and `pi-ready-gpios`), and are
free in `main`'s firmware. The Pi image updates on `feature/pi-ota` (draft PR #42) use the same pins with the board
as the SPI controller; when that work resumes, the two are to share this link.

## Tested

The link is tested on the hardware with the bench, step 6 above; it has no tests in CI.

On 2026-11-09 all 9 bench steps passed on an nRF7002 DK (firmware 1.15.0+1 from this branch) wired to a Pi 5, run
from a Windows PC with `--pi`: 100 messages in 5.5 s, nothing resent. That rate is the SSH session's, not the link's.
Not tested yet: the 2 KB smaller heap on a board that is on Wi-Fi and AWS IoT, where the heap is used most.
