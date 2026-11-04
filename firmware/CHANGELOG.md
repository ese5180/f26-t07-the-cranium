# Firmware changes

One entry per version, newest first. **The first paragraph of an entry is that release's note on the console's Firmware
page**: `scripts/upload-to-console.sh` (which `scripts/build.sh` runs after every build) sends it with the image, and
`scripts/release-notes.sh` sets it for releases already on the console. Keep that paragraph to what changed for someone
choosing a release, in at most 440 characters. Anything after it is detail for this file only.

A version without an entry here still gets a note: the subjects of the firmware commits since the previous version.

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
