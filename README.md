# ESE5180: IoT Venture

## 3.1 Team Formation

**Team Number: T07**

**Team Name: Cranium**

| Team Member Name   | Email Address                  |
| ------------------ | ------------------------------ |
| Demetrius Bosket   | dbosket@engineering.upenn.edu  |
| Adam Shalabi       | adamshal@engineering.upenn.edu |
| Christian Durante  | cgd2@engineering.upenn.edu     |
| Vihaan Ravishankar | vihaan1@engineering.upenn.edu  |

**GitHub Repository URL: https://github.com/ese5180/f26-t07-the-cranium**

## 3.2 Concept Development

### 3.2.2 Product Name & Function

**Cranium** is a mounted attachment to beginner DJ controllers that removes the need for a laptop. This solution will be more familiar, cost-effective, and sustainable than directly upgrading these popular controllers to all-in-one DJ systems. The device will utilize BLE audio to challenge typical issues with wireless audio as well as a secondary board in a Raspberry Pi to develop more robust display support at our price and time range.

### 3.2.3 Target Market & Demographics

- **Who will be using your product?** New and intermediate FLX4 DJs.
- **Who will be purchasing your product?** FLX4 owners seeking standalone capability + their friends and family as gifts.
- **Where would you deploy your product?** U.S. first through online D2C, then globally.
- **How large is the target market?** ~$28M existing U.S. FLX4 market, growing by $7.1M annually.
- **How much do you expect to capture?** ~$1M/year by Year 3 (given 1% adoption at $200/unit).
- **How much might your device cost, roughly?** About $200 to the customer, well below Pioneer's standalone XDJ systems.
- **What competitors are already in the space?** Pioneer’s XDJ systems as the traditional standalone alternative, less desirable standalone systems from Numark and Denon, and DeckShark as an early-stage add-on startup.

### 3.2.4 Stakeholders

- Adam:  Customer perspectives of 3 exact target customers (intermediate level Pioneer FLX4 owners who play small/medium live events)
  - Already held interviews, obtained specific pricing perspectives and target DJ controllers.
- (via Chris) Subject Matter Expert: Garrett Treanor (Indiana University - Expertise in Digital Audio Processing, Research in Immersive/Spatial Audio)
- Competitor's (DeckShark) Community Discord - finding additional consumer perspectives and specific failure points of direct competitors.

### 3.2.5 System-Level Diagrams

- **Create a device block diagram that details the power architecture, microcontroller, & peripherals**
  ![Block diagram](<./pics/Block Diagram.png>)
- **Create a communication diagram**
  ![Communication diagram](<./pics/Communication Diagram.png>)

### 3.2.6 Security Requirements Specification

| Code   | Name                  | Definition                                                                                                                                                                                                                                                       |
| ------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC 01 | Firmware Verification | The system shall run only signed firmware images. Firmware images shall be protected from being modified or copied.                                                                                          |
| SEC 02 | Initialization        | The device shall implement secure boot functionality to prevent unauthorized firmware modifications.                                                                                                         |
| SEC 03 | BLE Audio             | The BLE connection shall implement authentication and authorization before allowing access to user’s other device(s).                                                                                        |
| SEC 04 | OTAFU                 | Updates shall be written to an inactive partition, and the device shall automatically roll back if the new image fails to boot. Updates shall start only when a release manager, signed in with a password and an authenticator code, deploys them, and not while audio is playing. |
| SEC 05 | Physical Security     | The enclosure shall be spill-resistant and include a lock slot, with no externally accessible debug headers. The unit shall mount securely to the controller without loading its ports.                      |

**Not met on the dev kit yet** (more in the [threat model](docs/aws-iot.md#threat-model)):

- **SEC 01:** the network core's image isn't signed, because it's flashed over the debug port. Images are stored unencrypted, so they can be copied, but they hold no secrets.
- **SEC 02:** nothing checks MCUboot itself, and the open debug port could replace it.
- **SEC 03:** there's no audio on the board yet, so nothing to protect.
- **SEC 04:** there's no audio check yet. Serial recovery has no trial or revert, and a golden image restore skips the version check on purpose.
- **SEC 05:** there's no enclosure yet, and the debug port stays open for development.

### 3.2.7 Hardware Requirements Specification

| Code  | Name                    | Definition                                                                                                                                                                        |
| ----- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HW 01 | Microcontroller         | The device shall be controlled by an nRF5340 microcontroller (nRF7002 DK) to manage I/O peripherals and communication with wireless modules.                                      |
| HW 02 | Operable Without Laptop | All playback functions, mixing, library browsing, and setup shall be fully operable using only the controller and built-in screen. No external computer is required at any point. |
| HW 03 | Deck Interface          | USB-C female port, 2 buttons, 2 USB-A female ports, and screen.                                                                                                                   |
| HW 04 | Wired Audio Outputs     | Dual XLR output, RCA output, and 3.5mm headphone jack.                                                                                                                            |
| HW 05 | Mechanical              | The unit shall mount on the FLX4 with zero mechanical load on the controller's USB and RCA ports.                                                                                 |

### 3.2.8 Software Requirements Specification

| Code   | Name                      | Definition                                                                                                                                                                                                                                 |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SRS 01 | Boot and Device Detection | The system shall boot within 30 seconds of power-on and shall recognize the controller within 5 seconds of connection. If the controller is disconnected, the system shall resume operation upon reconnection without requiring a restart. |
| SRS 02 | Audio Performance         | The system shall play audio with no more than 3 seconds of delay and no audio dropouts during a test with two decks and effects running.                                                                                                   |
| SRS 03 | MCU/PI Handshake          | The MCU shall exchange a heartbeat with the PI over UART and report battery life.                                                                                                                                                          |
| SRS 04 | Library Support           | The system shall support libraries prepared directly from a USB drive, keeping the user's playlists and saved track markers.                                                                                                               |
| SRS 05 | Data Integrity            | The MCU shall trigger a graceful shutdown, with no filesystem corruption, when the battery drops below 5%.                                                                                                                                 |

## 3.5 Wireless Demo & Secure Firmware Updates

### 3.5.5 Firmware Security Implementation

#### (3.5.1) Bootloading process

![Boot process](<./pics/Boot Process.png>)

On every reset, MCUboot checks the image's SHA-256 and ECDSA P-256 signature, and only boots it if both are valid. The image contains TF-M (secure world: crypto and encrypted storage) and our application (non-secure world). The network core runs the Bluetooth controller, which is flashed over the debug port and isn't updated over the air.

To update, a release manager deploys a signed image from our console, which creates an AWS IoT job. The application downloads the image into the secondary slot, checks it and resets. MCUboot verifies the signature, swaps the slots and starts the new image on trial. If it can't reconnect to AWS IoT, the next reset swaps the old image back. A release manager can also send the image from our phone app over Bluetooth: it lands in the same slot, a person presses Button 1 at the board to install it, and the same signature check and trial follow.

<!-- SIZES: all image sizes are in the first two rows below. Update them, their label and "pics/Boot Process.png" for each release. -->

| Question | Answer |
| --- | --- |
| How large is your bootloader? | MCUboot is 50,324 bytes of flash in a 64 KB partition, and uses 22,408 bytes of RAM (1.14.0 build). |
| How large is your existing application code? | The application is 745,168 of 794,474 bytes of flash and uses 404,284 of 405,504 bytes of RAM, with 4,032 more kept for Memfault's crash data. TF-M is 130,008 bytes of flash and uses 36,620 bytes of RAM. Signed together, they're 876,412 bytes in a 933,888-byte slot. The network core's Bluetooth controller is another 133,232 bytes (1.14.0 build, which the board runs). |
| Does the bootloader or application code handle the firmware image download? | The application. MCUboot has no network stack. |
| What wireless communication is used to download the images? | Wi-Fi (nRF7002). The job arrives over MQTT with mutual TLS, and the image comes over HTTPS from a signed S3 link. Bluetooth LE is the second way: our phone app uploads the image over a paired, authenticated link. |
| Why this method? | A signed image is about 860 KB. Wi-Fi reaches the server directly and downloads it in about a minute, with nobody at the board, so it's the main path. Bluetooth needs a phone next to the board and a press of Button 1, so it's for a board with no Wi-Fi in reach. |
| Where are the downloaded firmware images stored? | In the secondary slot on the DK's external flash (MX25R64, 8 MB), whichever way they came. The running image stays in internal flash until the swap. |

**Features that handle update failures**

| Failure | What happens |
| --- | --- |
| Invalid signature | MCUboot won't swap or boot it, so the board keeps its current firmware and reports the update as failed. The console also refuses it on upload. |
| Faulty code with a valid signature | The new image runs on trial and has 5 minutes to reach AWS IoT and confirm itself. A 120-second watchdog covers a hang. If it doesn't confirm, the next reset swaps the old image back. |
| Corrupted download | The application checks the SHA-256 against the job and erases the image on a mismatch. It retries with a fresh link, up to five attempts. |
| Older firmware | The console, the application and MCUboot each refuse a version that isn't newer. |
| Image for another board | From 1.13.0 every image names its board type and flash layout in its signed area. The console won't offer it to another board, and the board refuses it before installing. |
| Reset or power loss | During a download, the running image isn't touched. During a swap, MCUboot continues on the next boot. |
| No update can reach the board | [Serial recovery](#serial-recovery-extra-credit), below. A person can also hold Button 2 through a reset to restore a frozen [golden image](firmware/README.md#golden-image). |

#### FOTA implementation

| Requirement | How it's met |
| --- | --- |
| MCUboot support in Zephyr | `SB_CONFIG_BOOTLOADER_MCUBOOT=y` in [`firmware/app/sysbuild.conf`](firmware/app/sysbuild.conf), with settings in `firmware/app/sysbuild/mcuboot/`. |
| Firmware image in external flash | The secondary slot is on the MX25R64. |
| Signed images from our own keys | ECDSA P-256 over SHA-256, with a key from `tools/keys.py`. Boards hold only the public half. See [`secrets/README.md`](secrets/README.md). |
| FOTA over a wireless protocol | Wi-Fi, through AWS IoT jobs: [`ota.c`](firmware/app/src/ota/ota.c) and [`ota_job.c`](firmware/app/src/ota/ota_job.c). Bluetooth LE from the phone apps: [`bt_ota.c`](firmware/app/src/bt/bt_ota.c). |

#### Serial recovery (extra credit)

MCUboot also accepts a signed image over UART, as a backup when the network can't be used. Close any terminal on the board's second COM port, then run this from an nRF Connect SDK terminal:

```sh
python tools/recover.py --reset upload <image>  # restarts the board through the debug port
python tools/recover.py upload <image>          # after holding Button 1 and pressing RESET
```

MCUboot checks the signature at the restart and won't start an image that fails. This path has no version check or revert.

More detail: [test results](docs/test-results.md), [firmware](firmware/README.md), [cloud](docs/aws-iot.md), [phone apps](docs/mobile-apps.md), [binaries](binaries/README.md) and [Raspberry Pi updates](docs/raspberry-pi-ota.md).

## 3.6 Fleet Management

From firmware 1.14.0 the boards report to Memfault, in our project in nRF Cloud. The board opens no connection of its own for it: it sends Memfault's data over the AWS IoT connection it already has, on `cranium/<thing>/memfault`, and a function in AWS posts each piece to Memfault with the project key, which never leaves AWS, and acknowledges it so the board sends the next. Updates still come only from our console or the phone app. How it works: [docs/memfault.md](docs/memfault.md).

| Feature | What is built | Shown on a board |
| --- | --- | --- |
| OTA firmware updates with version info | Each signed image carries its version (now `1.15.0+0`), which the board reports to the console and to Memfault as its software version, with `nrf7002dk` as its hardware version. A restart for an update is marked `FirmwareUpdate`, and each update that ends sends an event (`update_succeeded`, `update_failed`, `update_rolled_back` and others). `scripts/firmware/build.sh` uploads each release and its symbols to Memfault | Yes, on 2026-11-09: three boards were updated over Wi-Fi from the console (1.14.6, the 1.14.7 fault build, then 1.15.0), and Memfault lists all three on software `1.15.0+0`, with its symbols uploaded. Earlier, on 2026-11-05, 1.14.0 went to a board over Bluetooth from our iPhone app |
| Core dump | After a crash the board keeps the registers, the stack that crashed and the other threads' stacks (3,968 bytes) in RAM that outlives a reset and a revert, and sends them once it's connected. A demonstration build (`CONFIG_APP_CRASH_DEMO`) crashes once, 60 s after it confirms itself | Yes, on 2026-11-09: the 1.14.7 fault build (below) crashed on three boards, and Memfault shows five issues, each with three core dumps (one per board) and their backtraces |
| Forward critical device information to Memfault | Why each boot ended (power-on, watchdog, crash, update, a restart for being stuck), and an hourly heartbeat: Wi-Fi signal, connected time and disconnects, AWS IoT reconnects, free heap, and update attempts, failures and refusals. "Send Memfault data now" on the console sends a heartbeat at once | Yes: every reboot, update event and core dump above reached Memfault through AWS IoT. The hourly heartbeat arrives too, but Memfault does not yet name its metrics, because it hasn't matched them to the build's symbols |
| MCU reboot reasons | Every boot sends why the one before ended: the hardware's reset cause (power-on, pin, watchdog, lockup, brownout, software) read once at start-up, the firmware's own (`FirmwareUpdate`, `FirmwareUpdateError`, `UserReset`, `FactoryReset`, and `StuckWifiSilent`, `StuckNoCloud`, `StuckUpdateStall` for a restart for being stuck), and a crash's (assert, hard fault, usage fault, watchdog) | Yes, on 2026-11-09: Memfault lists 42 reboots that week by reason (`FirmwareUpdate`, `PinReset`, `PowerOnReset`, `UserReset`, the five faults, `HardwareWatchdog`), 16 of them marked unexpected |
| Power status (stands in for battery state of charge) | The DK has no battery and runs from USB, so from 1.15.0 the hourly heartbeat sends `power_usb_present` (1 when the USB regulator sees VBUS) and `supply_mv` (the supply voltage from one SAADC sample) | Sent: the boards run 1.15.0, which puts both values in the hourly heartbeat. Not yet readable by name in Memfault (see the heartbeat above) |
| Zephyr default metrics | From 1.15.0 the Memfault SDK's Zephyr defaults: CPU use (`cpu_usage_pct`), the stack use of the idle thread and the system work queue, free heap and heap use, connected time and syncs, boot time. Left out for RAM or privacy: the TCP/IP counters, the SDK's Wi-Fi metrics (they send the access point's OUI) and CPU temperature (no sensor on this core) | Sent with 1.15.0 in the same heartbeat, with the same gap |
| Fault demonstration and one fix for the whole fleet | A test image (`CONFIG_APP_FAULT_DEMO`, 1.14.7+0) faults once per boot, only after it has confirmed itself, five different ways: a failed assert, a write to flash, an undefined instruction, a stack overflow and a hung main loop caught by a watchdog, so Memfault shows five issues with core dumps. Release 1.15.0, deployed to every board at once, has no faults and the two metrics above | Yes, on 2026-11-09: 1.14.7+0 went to the three boards, Memfault shows the five issues above, and 1.15.0 then went to every board |
| Extra credit: staged rollout and A/B | The console's staged rollouts send an update to a canary board first and to the rest in waves, and stop by themselves when the canary doesn't confirm or too many boards fail. Each board has A and B slots: MCUboot keeps the previous image and puts it back unless the new one confirms itself, and a crash's core dump outlives that revert, so Memfault shows why the new image was given up | Staged rollout, yes, on 2026-11-09: 1.14.6 went to a canary board first, which confirmed it, then to the other boards. Since then each stage also waits until its boards show no new Memfault issue or unexpected reboot (a health gate). A/B revert: built, not yet shown on a board |

The code: [`mflt.c`](firmware/app/src/mflt/mflt.c) and [`mflt_link.c`](firmware/app/src/mflt/mflt_link.c) on the board, and [`memfault.mjs`](cloud/api/src/memfault.mjs) with [`forwarder.mjs`](cloud/api/src/forwarder.mjs) in AWS.
