# Firmware changes

One entry per version, newest first. **The first paragraph of an entry is that release's note on the console's Firmware
page**: `scripts/upload-to-console.sh` (which `scripts/build.sh` runs after every build) sends it with the image, and
`scripts/release-notes.sh` sets it for releases already on the console. Keep that paragraph to what changed for someone
choosing a release, in at most 440 characters. Anything after it is detail for this file only.

A version without an entry here still gets a note: the subjects of the firmware commits since the previous version.

## 1.14.1

The same firmware as 1.14.0, released after the crash demonstration (1.14.0+1) to put a board back on an ordinary build. No change in what the board does.

Built from the 1.14.0 sources with no -D settings. It exists so that the 3.11 demonstration can end on a release that
is newer than the crash demonstration's 1.14.0+1, as a board only takes a newer image (docs/memfault.md, "Showing 3.11
on the board").

## 1.14.0

The board reports to Memfault over its own AWS IoT connection: why it restarted, a coredump after a crash, an hourly
heartbeat, and each update's result. Over Bluetooth it now tells the phone how an update stands, with no pairing, also
for 2 minutes after the restart, and Button 1's line reaches the console before the board restarts. Needs the
console's device policy for the memfault topic first, and goes over the air as before.

The heartbeat carries Wi-Fi, connection, memory and update counts. All of Memfault's data goes over the board's own AWS
IoT connection, and AWS passes it on, so nothing else goes on the network.

Memfault SDK 1.40.0 with no HTTP client and no project key in the image: chunks of at most 400 bytes on
`cranium/<thing>/memfault`, one at a time, each answered by `memfault_ack` on the commands topic before the next goes,
again after 20 s without an answer and then backing off to an hour (src/mflt_link.c). The coredump (3,968 bytes) and the
reboot reason sit in two RAM regions at the same address in every image from this one, so they outlive a revert. The
reset cause has one reader now, src/reset_cause.c, so Memfault sees the real one. A `memfault` command takes a heartbeat
and sends it at once. The jobs message is read where it arrives, which saves its 4 KB copy. Flash 740,816 of 794,474 bytes;
RAM 403,972 of 405,504, and 4,032 for Memfault's regions: 1.5 KB free, from 6.1 KB (docs/memfault.md), before the
Bluetooth status below.

Bluetooth status: a GATT service of its own (9112B1B4-2A51-40F0-94D3-A76440F0E6CC) with one characteristic, read and
notify, 64 bytes of format 1 (src/bt_status.h, docs/mobile-apps.md): the window and its seconds, the image, a
refusal's reason, how the window ended, the running version, the trial and the swap, and the last update's version,
path, outcome, proof, hash and count. No pairing for it, and it carries no secret; SMP needs the authenticated link as
before, with the image group only and the same guards. Notified at once on a change, every 10 s for what counts by
itself. After the restart that an update over Bluetooth asked for, Bluetooth starts once the cloud is up or 30 s after
the boot, and the board advertises the status service for 2 minutes; such a link never pairs, and stays for the trial,
6 minutes at most.

Button 1 tells the phone (installing), then cloud_events_flush() sends what waits and the report goes with ota.state
rebooting, at QoS 1 with its own message ID, and the board restarts on that PUBACK or after 2 s (app_restart(),
cloud_shadow_report_acked()). Button 2 and the time running out tell the phone before its link goes. A full event ring
lets go of a line that is not about an update first (tags BT, bt_ota, ota). With all of it: flash 745,168 of 794,474
bytes, RAM 404,284 of 405,504 (1,220 free, 312 used by the status), signed image 876,412 bytes; the ring stays at 32
lines. Host tests: 30 programs, 0 failures.

Commit da27f3a. On the board from 2026-11-05, sent over Bluetooth from the iPhone app: confirmed, its status advertised
for 2 minutes after the restart, and its first Memfault chunks taken by Memfault (docs/test-results.md). Not yet seen:
a coredump, the hourly heartbeat in Memfault, and Button 1's line reaching the console before a restart, which needs an
update sent to a board that already runs 1.14.0.

## 1.13.0

The image now says which board and flash layout it is for, and the board refuses one for another board or layout,
over the internet or Bluetooth. From the console, Identify blinks both LEDs fast so you can find the board, and Report
now sends its status at once. The board also sends the Wi-Fi access points it hears, never network names, for the
console's map. Needs the console's device policy for the commands and location topics first.

Board type and flash layout in protected TLVs 0xa1 and 0xa2, and in the diagnostics report; an incompatible image fails
as `incompatible_board` or `incompatible_layout` before it is marked, and the build stops if the partitions change
without a new layout number. Commands on `cranium/<thing>/commands`, answered as `[CMD]` events; location on
`cranium/<thing>/location`, a 2.4 GHz scan once a boot, every 6 hours and on Report, never within 10 minutes of the last
or during an update. RAM estimated at about 0.9 KB above 1.12.0 before it was built.

Commit 8e96b39; signed image 856,081 bytes. On the board from 2026-11-05, sent over Bluetooth from the iPhone app
0.6.2, and confirmed on reaching AWS IoT (docs/test-results.md).

## 1.12.0

Every line the board prints from its own code now also goes to the console's Board log, never a passkey or a secret, with
network names and links replaced. Lines wait in memory while offline. A change in what the heartbeat carries (version,
update step, stuck restarts, Wi-Fi) is reported at once instead of at the next 30 s heartbeat. Needs the console's device
policy from 662e305 or later.

Commit 792ad07. RAM 393.2 KB of 400 KB.

## 1.11.4

The board now tells the console its own device ID, the name given with INIT or SET_ID, so the console shows it as the
board's name. It goes out in the diagnostics report as soon as it changes, and every five minutes.

Commit 2f207f0.

## 1.11.3

Bluetooth updates hold: the board no longer asks the phone for other connection timing while it pairs, which dropped an
iPhone's link (reason 0x22). The phone's timing is kept. This is the version the first Bluetooth update installed from.

Commit e755b70.

## 1.11.2

More time for a person over Bluetooth: a paired but quiet link lasts 120 s instead of 30, and the Bluetooth window 180 s
instead of 120. The serial console also explains the link: its timing, PHY and packet sizes, and why it ended.

Commit 81f8c6b.

## 1.11.1

The same code as 1.11.0 under a newer number, so that there was a version to send to a board over Bluetooth for the
first time.

Commit 5f977b0.

## 1.11.0

MQTT on the serial console: MQTT shows how the connection to AWS IoT stands, with its server, counters and topics;
MQTT_HOST changes the server; MQTT_RECONNECT reconnects.

Commit e668cbc.

## 1.10.0

A diagnostics report for the console's Diagnostics page: the board's Wi-Fi address, its Wi-Fi channel, and its memory
now, at its lowest and in all, when it reaches the cloud and every five minutes.

Commit dabd892.

## 1.9.0

Updates over Bluetooth from a phone, in every build, with the Bluetooth controller on the network core (flashed once over
USB). Hold Button 1 for 5 s to open Bluetooth. While a phone pairs, the board shows its passkey on the console.

Commit 41f9a30.

## 1.8.0

LED1 and LED2 take turns, a quarter of a second each, while the board is online. In every other state LED1 shows what it
did before, and LED2 is dark.

Commit 9165dff.

## 1.7.6

The same code as 1.7.4 under a newer number: the image for the over-the-air demo.

## 1.7.5

The same code as 1.7.4 under a newer number: the practice run for the over-the-air demo.

## 1.7.4

A boot diary: the board keeps its last eight boots, why each one ended and how far it got, and sends them to the console,
so that an update that fails away from a computer can explain itself.

Commit ad8f009.

## 1.7.3

The 1.7.2 code under a newer number (no firmware commit lies between 1.7.2 and 1.7.4): an update starts when it is
deployed, with no press of Button 1.

## 1.7.2

An update starts as soon as it is deployed, with no press of Button 1. The signature check, the version check, the trial
and the way back all stay. A board shows as restarting, not offline, through the install.

Commit 955b792.

## 1.7.1

HELP on the serial console prints a table by section. The board's report to the console is a heartbeat every 30 s, and a
board counts as offline after 90 s. Joining Wi-Fi waits for the link to settle first.

Commit cd37a99.

## 1.7.0

The board restarts itself when it is stuck: Wi-Fi silent for 2 minutes while offline, 15 minutes of Wi-Fi with no cloud,
or 10 minutes of an update that does not move. The first release with these timers.

Commit 9f8af1e.

## 1.6.0

The first release after the golden image: the same code as 1.5.0 under a newer number.

Commit 59a1b95.

## 1.5.0

The golden image: the one the bootloader always keeps a way back to. Frozen; never uploaded as a release.

Commit 907d8cd.

## 1.3.0

Updates over the air work on the board (the TLS heap no longer runs out during a download), and a serial console.

Commit f853126.

## 1.2.0

Every build keeps its signed image in binaries/, with scripts to update a board over the air and to open the console.
The older firmware with the Zephyr shell.

Commit 6da20e9.

## 1.1.6

A test image of the older firmware with the Zephyr shell, uploaded by the hardware test bench to measure updates over
the air.

## 1.0.3

The first release meant for a board over the air, after 1.0.1 and 1.0.2 tried the update server.

Commit daeab58.

## 1.0.2

The same firmware as 1.0.1 under a newer number, to check the upload, deployment and cancellation path. Revoked.

## 1.0.1

The first release on the update server: the same firmware as 1.0.0 under a newer number. Revoked.

## 1.0.0

The first firmware: MCUboot checks an ECDSA P-256 signature on every boot and swaps with revert; TF-M and the application
on the nRF5340's application core. Flashed over the debug port only.

Commit 48f28c3.
