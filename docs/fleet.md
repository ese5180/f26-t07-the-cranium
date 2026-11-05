# Fleet: board types, groups, rollouts, the map, commands and alerts

What the firmware (from 1.13.0) and the console agree on, so that a fleet of boards of more than one kind can be
updated, found and watched together. Each part says who does what. The board's side is built in firmware 1.13.0
(Memfault in 1.14.0), and the console's in console 1.10.0 (Memfault in 2.1.0); what the phone apps do not have yet
is said where it comes up. [`test-results.md`](test-results.md) says what has run on a board.

## Board types

| Type | Board | Network | How it updates |
| --- | --- | --- | --- |
| `nrf7002dk` | nRF7002 DK (nRF5340 with the nRF7002 Wi-Fi companion) | Wi-Fi to AWS IoT, Bluetooth LE | Over the internet (AWS IoT Jobs), or over Bluetooth from a phone |
| `nrf5340dk` | nRF5340 DK | Bluetooth LE only: no Wi-Fi chip | Over Bluetooth from a phone, or over USB. It never reaches AWS by itself |

- **The image says what it is for.** Every signed image carries a protected TLV (inside the signed area, so it cannot be
  changed without the key), tag `0xA1`, whose value is the board type in ASCII, for example `nrf7002dk`. An image
  without it is a `nrf7002dk` image: every release up to 1.12.0.
- **The board says what it is.** From 1.13.0 the diagnostics report carries `"board": "nrf7002dk"`. A board that never
  connects (a `nrf5340dk`) gets its type from its thing's attribute `board`, set when it is provisioned
  (`tools/provision_device.py --board nrf5340dk`). Without either, a board is `nrf7002dk`.
- **The console refuses a mismatch.** A release is for one type. A deployment, a Bluetooth send or a group rollout never
  offers a release to a board of another type, and the API refuses it (`400 incompatible_board`).
- A `nrf5340dk` is never a target of an AWS IoT job. The console lists it as "Bluetooth only", with its last version
  as a phone last saw it.

## Compatibility: the right image on the right board

Every image carries what it is compatible with, in its protected (signed) TLV area, and each step that can put an
image on a board checks it. The board's own check is the last word.

| Protected TLV | Value (ASCII) | Meaning | A legacy image without it |
| --- | --- | --- | --- |
| `0xA1` | `nrf7002dk`, `nrf5340dk` (1–16 lowercase letters and digits) | The board type it is built for | `nrf7002dk` |
| `0xA2` | `1`, `2`, … (a positive integer) | The flash layout it is built for: partitions, slot sizes, the golden area. It goes up whenever the partitions change, so an image never lands on a board whose flash is divided differently | `1` |

- **The build** sets both: `CONFIG_APP_BOARD_TYPE` and `CONFIG_APP_IMAGE_LAYOUT` (per board, in the board's conf). The
  build stops if the image does not carry the values the board's configuration says.
- **The board** reports both in its diagnostics (`"board"`, `"layout"`) and, before it installs anything, reads the
  new image's protected TLVs: over the internet after the download is verified, and over Bluetooth after an upload,
  before it marks the image to test. A different board type or layout is refused: the image is never marked, MCUboot
  never swaps, the update ends `failed` with reason `incompatible_board` or `incompatible_layout`, and a `CMD`/`ota`
  line says why. A Bluetooth upload of such an image is refused the same way, whatever tool sent it.
- **The console** reads both on upload, shows them on the release, and never offers a release to a board of another
  type or layout (`400 incompatible_board`, `400 incompatible_layout`), whether the board is named, in a group, or
  part of Update everything.
- **The phone apps** check the same before a Bluetooth send, from the image they hold and the board's reported type and
  layout, and send `thing` with the console's pre-send check so that the console checks too.
- **One version is one image.** Versions are one sequence across all board types, so `1.13.0` names exactly one file;
  a build for another type takes the next number.

## Groups and rollouts

- **Groups** are names a release manager gives to sets of boards ("lab bench", "demo"). A board can be in several. Every
  board is also in the group of its type.
- **A deployment targets** some boards, a group, a type, or the whole fleet. It only ever takes the boards of the
  release's type, and leaves out those already on that version.
- **Staged rollout.** A deployment of more than one board starts with a canary: the first board (or the number asked
  for). The rest follow in waves only once the canary has confirmed the update. It stops by itself, cancelling what has
  not started, when the share of failed or rolled-back boards reaches the abort threshold (default 20%, at least one
  board). AWS IoT Jobs' rollout and abort configuration does the waves and the abort where it can.
- **Update everything.** One action: for each board type, its newest active release goes to every board of that type
  that is not on it, each type as its own staged deployment. The review step lists, by type, the release and the
  boards, and what is left out (offline long, Bluetooth only, already current).

## Commands: `cranium/<thing>/commands`

The console publishes, QoS 1; the board subscribes. The device policy allows the board to subscribe to and receive its
own topic only. A board that is offline misses the command: that is meant, these are for now.

```json
{"id": "3f9c2a1b7d4e6f80", "cmd": "identify", "seconds": 15}
{"id": "a01b2c3d4e5f6789", "cmd": "report"}
```

| `cmd` | What the board does |
| --- | --- |
| `identify` | Blinks LED1 and LED2 together, fast (about 5 Hz), for `seconds` (1 to 60, else 15), then goes back to what it showed |
| `report` | Sends the heartbeat, the diagnostics report and a location scan at once (the location's own 10-minute floor still holds), and from 1.14.0 what Memfault data waits |
| `memfault` | From 1.14.0: takes a heartbeat of Memfault's metrics now and sends it, with whatever else waits ([`memfault.md`](memfault.md)) |

`id` is 16 hexadecimal characters. The board answers on its events topic with tag `CMD`, for example
`identify for 15 s (3f9c2a1b7d4e6f80)`, which the console files as kind `setting`. Anything else is ignored with a
`CMD` line saying so. Only release managers can send a command; each one is in the activity log (`board.command`).

The cloud also publishes `{"id": ..., "cmd": "memfault_ack", "seq": <n>}` there, from 1.14.0: the answer for one
Memfault chunk, which the board never answers.

## Memfault: `cranium/<thing>/memfault`

From firmware 1.14.0 the board publishes, QoS 0, binary, the Memfault SDK's chunks: its reboot reasons, a coredump
of a crash, an hourly heartbeat of metrics and an event per update. A function in AWS posts each one to Memfault with
the project key, which only it can read, and answers on the commands topic. The device policy allows the board to
publish on its own topic only. What leaves the board: no network name, no access point's address and no OUI;
the coredump holds the registers and the tops of the stacks, not the application's data. [`memfault.md`](memfault.md)
has the rest.

## Location by Wi-Fi: `cranium/<thing>/location`

The board publishes, QoS 0, what it hears of the Wi-Fi around it; AWS IoT Core Device Location turns that into a
position. Only `nrf7002dk` boards can do this.

```json
{"aps": [{"mac": "a4:2b:b0:12:34:56", "rss": -51}, {"mac": "f0:9f:c2:65:43:21", "rss": -70}], "boot": 42, "t": 61234}
```

- **What is sent:** 2 to 10 access points, strongest first, as BSSID and signal. Never a network name. Only globally
  administered BSSIDs (the second-lowest bit of the first byte clear): a phone's hotspot and other randomised addresses
  move, and say nothing about where the board is. Fewer than 2 left: nothing is sent.
- **When:** once after the first connection of a boot (after 60 s), every 6 hours, and on the `report` command; never
  more often than every 10 minutes.
- **The console** asks AWS IoT Core Device Location (`iotwireless:GetPositionEstimate`) for a position, at most once per
  board per 10 minutes, and not again while the set of access points has not changed. It keeps the position (latitude,
  longitude, accuracy in metres, when) and the last 20 of them, and not the access points.
- **The map** (the console's Map page; the phone apps have none yet) shows each board at its position, with its name, state and
  how sure the position is. The tiles are OpenStreetMap's, with its attribution.
- What leaves the board: the BSSIDs of nearby access points and their signal, to AWS, and from AWS to the location
  solver it uses. That is the price of a position from Wi-Fi.

## Alerts

E-mail through Amazon SNS, to the release managers who ask for it on the console (each address confirms by e-mail
first). An alert for:

- a board offline for more than 15 minutes, and back again
- an update that failed or rolled back, and a deployment that stopped by itself
- a restart for being stuck
- a board whose position moved by more than 1 km

At most one e-mail per board and kind per hour; the rest go into the next one.

## Bluetooth-only boards and the phone

A phone that connects to a board over Bluetooth tells the console what it saw: the board, its version, and when
(`POST /api/devices/{thing}/seen`). That is how a `nrf5340dk` shows on the console at all. Planned for the apps, and
not in them yet: sending that sighting, and "Update all nearby", every board in Bluetooth range that is behind its
type's newest release, one after another.
