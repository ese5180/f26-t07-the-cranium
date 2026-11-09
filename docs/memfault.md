# Memfault: crashes, reboots and fleet metrics, over AWS IoT

Course manual 3.11, from firmware 1.14.0 and console 2.1.0. AWS IoT stays the board's only cloud connection, and the
console (or the phone app over Bluetooth) its only way to be updated: Memfault gets a copy of what the board knows about
itself, through AWS. The Memfault project is the team's, in nRF Cloud. Console 2.1.0 is deployed with the project key
in its secret, and the board runs 1.14.0: its first chunks reached Memfault on 2026-11-05. What has been shown and what
has not: [What has run](#what-has-run).

## How it works

```text
board (Memfault SDK 1.40.0)                       AWS                                    Memfault
  coredump, reboot reason, heartbeat,   MQTT     IoT rule MemfaultRule      HTTPS
  trace events -> chunks of <= 400 B  -------->  cranium/+/memfault  ---->  MemfaultFn  -------->  chunks API
                                       QoS 0     (binary, base64 to the     posts the chunk with
  waits for the answer, then the next  <-------  function)                  the project key from
                                       commands   memfault_ack, seq <n>     Secrets Manager
```

- **The board never talks to Memfault.** It has no HTTP client for it, opens no third TLS session (RAM is short) and
  carries no project key: the image could not leak one. The SDK's chunks go on the board's own AWS IoT connection.
- **One chunk at a time, in order.** `src/mflt/mflt_link.c` takes a chunk from the SDK's packetizer, publishes it on
  `cranium/<thing>/memfault` and waits for the cloud's answer, `{"id": "...", "cmd": "memfault_ack", "seq": <n>}` on
  the board's commands topic, before it takes the next. No answer in 20 s: the same chunk goes again after 30 s, and
  the wait doubles with every chunk that gets none, up to an hour; an answer sets it back and sends the next at once.
- **When.** Whenever the SDK has data and the board is connected: after it starts (the reboot, and a coredump if it
  crashed), after each hourly heartbeat, after a trace event, and at once on the console's Report or the `memfault`
  command. Never while an update downloads or installs, and never while Bluetooth is open.
- **The frame** is byte 1 (its version), the sequence number in 2 bytes, most significant first, and the chunk. The
  number starts at a random value at every boot, so an answer meant for the boot before is not taken for this one's.
- **The function** (`MemfaultFn`, `cloud/api/src/forwarder.mjs`) checks the frame, reads the project key (kept 5
  minutes), posts the chunk to `https://chunks-nrf.memfault.com/api/v0/chunks/<thing>` with `Memfault-Project-Key` and
  `Content-Type: application/octet-stream`, and answers:

  | Memfault says | The function | The board |
  | --- | --- | --- |
  | 2xx | answers, logs `chunk_forwarded` | takes the next chunk |
  | 401 or 403 | logs `chunk_failed`, reason `key_refused`, reads the key again next time, no answer | sends it again later |
  | another 4xx (not 408 or 429) | answers, logs `chunk_refused`: Memfault will never take it | takes the next chunk |
  | 408, 429, 5xx, no answer | logs `chunk_failed`, no answer | sends it again later |
  | (no project key stored) | logs `chunk_dropped`, reason `no_project_key`, no answer | keeps its data, backs off |

  Lambda never retries it (`MemfaultFnInvokeConfig`): the board does. `MemfaultChunksHost` is `chunks-nrf.memfault.com`
  by default, where the nRF Connect SDK's own Memfault port posts an nRF board and where a project made through nRF
  Cloud is served; deploy with `MemfaultChunksHost=chunks.memfault.com` for a project made on memfault.com.
- **The device ID** in Memfault is the AWS thing name (`cranium-<16 hex digits>`), set at boot
  (`CONFIG_MEMFAULT_NCS_DEVICE_ID_RUNTIME`). The software version is the one MCUboot and the shadow say, `1.14.0+0`;
  the software type `app`; the hardware version the board type, `nrf7002dk`.

## What is sent, and what is not

- **Reboots:** the reason of every boot. The hardware's (power-on, pin, watchdog, lockup, software, brownout) and this
  firmware's own, marked before it restarts the board: `FirmwareUpdate` (an update is handed to the bootloader, over the
  internet or Bluetooth), `FirmwareUpdateError` (a new image's trial ran out and the bootloader will revert it),
  `UserReset` (RESET on the serial console), `FactoryReset` (Button 2 held), `StuckWifiSilent`, `StuckNoCloud` and
  `StuckUpdateStall` (`src/stuck.c`). A crash is the SDK's own: HardFault, UsageFault, Assert, KernelPanic and so on.
- **Coredumps** of a crash: the CPU's registers, the stack that crashed (256 bytes), the kernel's state, the MPU, the
  interrupts, and as many other threads (128 bytes of each stack) as fit in 3,968 bytes. Not the data or bss of the
  application, so no Wi-Fi password, key or certificate, none of which is in the application's RAM anyway: they are in
  TF-M.
- **Heartbeat metrics, every hour:** the heap (`Heap_BytesFree`, `memory_pct_max`), the time connected to AWS IoT
  (`connectivity_connected_time`), the shadow reports that got out or not (`sync_successful`, `sync_failure`), the boot
  time, Wi-Fi (`wifi_connected_time_ms`, `wifi_disconnect_count`, `wifi_sta_rssi`, `wifi_primary_channel`),
  `mqtt_reconnect_count`, `ota_attempt_count`, `ota_failure_count`, `ota_refusal_count`, `stuck_restart_count` and
  `memfault_chunk_retry_count`.
- **Power status, from 1.15.0,** in place of a battery's state of charge: the DK has no battery and runs from USB.
  `power_usb_present` is 1 when the USB regulator sees VBUS (`USBREGSTATUS.VBUSDETECT`), and `supply_mv` is the
  supply VDD in mV, one SAADC sample against the internal reference (gain 1/6, 3.6 V full scale), not calibrated, so
  good to a few percent. Both are read when the heartbeat is taken (`src/mflt/mflt.c`), with the nrfx HAL and no driver,
  so they cost no RAM; the USB regulator and the SAADC are non-secure under TF-M.
- **Zephyr's default metrics, from 1.15.0.** `CONFIG_INIT_STACKS=y` turns on what the SDK's Zephyr port collects by
  default: CPU use (`cpu_usage_pct`, `TimerTaskCpuUsage`, `AllTasksCpuUsage`), the free stack of the timer thread
  (`TimerTaskFreeStack`) and the highest stack use of the idle thread and the system work queue
  (`memory_idle_pct_max`, `memory_sysworkq_pct_max`). With the heap, the connection and the boot time above, that is
  the default set. Left out: the TCP/IP counters (`net_bytes_*`, which need `CONFIG_NET_STATISTICS` and RAM for its
  counters), the SDK's Wi-Fi metrics (below), the CPU temperature (the application core has no TEMP peripheral) and
  NCS's per-thread stack metrics (`CONFIG_MEMFAULT_NCS_STACK_METRICS`, which needs the thread analyzer).
- **Trace events, one per update that ends:** `update_succeeded` (with the version), `update_failed`,
  `update_digest_mismatch`, `update_incompatible` (`incompatible_board` or `incompatible_layout`, with what the image
  said), `update_refused` (not newer, too large, a URL that is not allowed, a bad document) and `update_rolled_back`.
  The text is the job's own reason.
- **Never:** a network name, an access point's address or its OUI. The SDK's own Wi-Fi metrics are off
  (`CONFIG_MEMFAULT_METRICS_WIFI=n`) because they send the access point's OUI, which [`fleet.md`](fleet.md) does not let
  a board send anywhere; the four Wi-Fi metrics above are this firmware's, by the same names. No log lines go to
  Memfault (`CONFIG_MEMFAULT_LOGGING_ENABLE` is off): the console's Board log has them.

## On the board

| What | Where |
| --- | --- |
| SDK settings | `firmware/app/prj.conf` (Memfault block), `firmware/app/Kconfig` (version and hardware defaults), `firmware/app/config/` (the SDK's three configuration files and the reboot reasons) |
| Chunks over AWS IoT | `src/mflt/mflt_link.c` (no hardware, host-tested) and `src/mflt/mflt.c` (the SDK, the metrics, the reasons) |
| The topic | `cloud_memfault_publish()` in `src/cloud/cloud.c`; a frame of 403 bytes fits the 512-byte MQTT buffer with its topic, which the build checks |
| The commands | `memfault` and `memfault_ack` in `src/cloud/command.c` |
| The reset cause | `src/reset_cause.c` |
| The pinned RAM | `MFLT_REBOOT` and `MFLT_COREDUMP` in `boards/nrf7002dk_nrf5340_cpuapp_ns.overlay` |

- **The reset cause has one reader.** Zephyr's hwinfo reset cause keeps its bits until they are cleared. Up to 1.13.0
  the console read and cleared it as it started, and the SDK, which reads it later, would have found it empty, so
  every reboot would have looked like a power-on. Now `src/reset_cause.c` reads it as the kernel starts and clears it,
  once, and the console's STATS, the boot diary and Memfault (`CONFIG_MEMFAULT_REBOOT_REASON_GET_CUSTOM`) all take it
  from there. A build without the console clears it too, which nothing did before.
- **What survives a revert.** The coredump and the reboot reason are in RAM that nothing initialises, in two memory
  regions of their own at `0x2006f000` (64 bytes) and `0x2006f040` (3,968 bytes). They are at those addresses in every
  image from 1.14.0, so a crash of a new image on trial is still there when the bootloader has put 1.14.0 back, and
  that image sends it. The application's own RAM is 396 KiB, 4 KiB less than before, and its C library heap, which
  nothing uses, ends below the regions. MCUboot's RAM ends below `0x20006000`; its C library heap runs to `0x20070000`
  and writes an end marker into the last 8 bytes at every boot, which is why the last 64 bytes stay unused. The SDK
  checks what it finds there for its own magic number, so after a board ran an image from before 1.14.0 there is just
  nothing. This is RAM only: the flash layout (`CONFIG_APP_IMAGE_LAYOUT=1`), which `flash_layout.py` checks, is
  unchanged, and 1.14.0 goes over the air.
- **The fault handlers.** The SDK takes faults by wrapping Zephyr's handlers at link time, and the image is built with
  link-time optimisation, which can undo such a wrap. Checked in the ELF of the 1.14.0 build: the fault vectors call
  `__wrap_z_arm_fault`, `k_oops()` goes `z_arm_svc` to `z_do_kernel_oops` to `z_arm_fatal_error` to
  `__wrap_z_fatal_error` to `memfault_fault_handler`, as hardware faults do after `z_arm_fault`, NMI goes through
  `__wrap_z_arm_nmi`, and the kernel starts `main()` through `__wrap_main` (the boot time).
- **TF-M.** A fault in the secure domain, in TF-M, is handled by TF-M and gives no coredump: the board restarts, and
  Memfault sees the reboot with whatever reason the hardware gives. Only the non-secure application is covered.
- **No MCUmgr group.** The SDK adds an SMP group of its own whenever MCUmgr is on, which would read out the project key
  over Bluetooth and break "the image group and no other" (`bt_ota.conf`): it is off, and `src/bt/bt_ota.c` stops a build
  that has it.
- **The device policy.** AWS IoT closes the connection of a board that publishes where its policy does not allow. On a
  cloud that does not allow `cranium/<thing>/memfault` yet, a connection that ends within 5 s of a chunk, before any
  answer came, is counted, and after two the board sends no Memfault data until a restart, with a warning, so that it
  stays connected and updates go on. The trial of a new image is over before the first chunk goes.
- **RAM.** The jobs message is now read where it arrives, on the MQTT library's thread, straight into the one struct
  the update code reads (`cloud.h`; it moved there from `ota.c`), so the 4 KB copy of the message is gone; that thread
  has 512 bytes more stack for it. Thread names are 16 bytes (the SDK turns them on), and the SDK keeps 768 bytes of events
  and tracks 16 threads for a coredump. See [Flash and RAM](#flash-and-ram).

## In AWS

| Resource | What it is |
| --- | --- |
| `DevicePolicy` (`cranium-device`) | A board may publish on its own `cranium/<thing>/memfault`, and on no other board's; never subscribe or receive there |
| `MemfaultRule` | `SELECT encode(*, 'base64') AS frame, topic(2) AS thing, timestamp() AS received FROM 'cranium/+/memfault' WHERE startswith(topic(2), 'cranium-')`, to `MemfaultFn`; what it cannot hand over goes to `/aws/iot/<stack>-memfault-rule-errors` |
| `MemfaultFn` | `cloud/api/src/memfault.mjs`; its log is `/aws/lambda/<stack>-memfault`. Its role may read the one secret and publish on `cranium/cranium-*/commands`, nothing else |
| `MemfaultProjectKey` | The secret `<stack>/memfault-project-key`, made empty by the stack; `cloud/deploy.sh` fills it |
| Parameters | `MemfaultChunksHost`, `MemfaultOrgSlug`, `MemfaultProjectSlug` |
| Outputs | `MemfaultFunctionName`, `MemfaultProjectKeyArn` |

The console's API may only see whether the secret has a value (`secretsmanager:DescribeSecret`), never read it. A
board's page shows a Memfault card: forwarding on, off because no project key is stored, or that the board needs
firmware 1.14.0, with "Open in Memfault" when the slugs are set, and its menu has "Send Memfault data now", the
`memfault` command (release managers; from a phone, after a fresh sign-in, as Report). Follow the function with
`cloud/logs.sh memfault`, and the rule's errors with `cloud/logs.sh memfault-errors`. Neither log ever holds the key
or a chunk's bytes; the rule's error log would hold a chunk that AWS IoT could not deliver, which is board data and no
secret.

## In the console

From console 2.6.0 the console shows what Memfault knows, read on the server from Memfault's REST API
(`https://api.memfault.com/api/v0/organizations/<org>/projects/<project>/...`) with GETs only. The browser never
talks to Memfault, so the page's content security policy is as strict as before.

- **The Memfault page** (`#/memfault`): the issues, crashes and other traces grouped by kind, with how many traces on
  how many boards and the versions. An issue's page (`#/memfault/<id>`) shows each trace: the board, the version,
  and for a coredump each thread with its backtrace (function, file and line) and registers, the crashed one first.
  A backtrace needs the build's symbols in Memfault (below).
- **A board's page**, card "In Memfault": its reboots with their reasons (an unexpected one, such as `KernelPanic`
  or `HardwareWatchdog`, marked), its trace events such as `update_succeeded`, and the issues its traces belong to.
- **The routes**, for viewers and release managers, never on record: `GET /api/memfault/issues`,
  `GET /api/memfault/issues/{id}`, `GET /api/devices/{thing}/memfault?hours=1..168` (reboots, the heartbeat metrics
  of every key as series, events, traces, issues) and `GET /api/memfault/fleet` (devices tied to boards, releases
  and whether their symbols are there, reboots of the week by reason, each board's latest metrics, and what Memfault
  could not process, such as missing symbols). A board's device serial is its thing name.
- **Plain words when Memfault cannot be read**: no token stored, the token refused, Memfault limiting requests or
  unreachable. The answer is still 200; the page says which. Answers are kept a minute and failures 15 s, so the
  console never sends Memfault more than a few requests a minute.
- **The token** is the secret `<stack>/memfault-org-token` (output `MemfaultOrgTokenArn`), made empty by the stack;
  only the API function may read it (`secretsmanager:GetSecretValue` on that one secret). `cloud/deploy.sh` stores
  `~/.cranium/memfault_org_token` in it, by its digest and never printed, and the Deploy console workflow does the
  same from the repository secret `MEMFAULT_ORG_TOKEN` when it is set. Memfault's organization auth tokens have a
  project manager's rights and no read-only kind. For the console, a Memfault user with the **Viewer** role is
  safer: store `<that user's e-mail>:<their user API key>` in the file instead, and the console reads as that user,
  who can change nothing.

Not yet: metric charts on a board's page, and the fleet's metrics and reboot reasons on the Memfault page (the
fleet route already answers them).

## Symbols and releases

Memfault turns a coredump into a backtrace only with the symbols of the build that crashed, found by its GNU build
ID. `scripts/firmware/build.sh` runs `tools/memfault_upload.py` after each build, before the console upload:

```sh
memfault upload-mcu-symbols --software-type app --software-version 1.14.0+0 build/app/zephyr/zephyr.elf
memfault upload-ota-payload --hardware-version nrf7002dk --software-type app --software-version 1.14.0+0 \
  build/app/zephyr/zephyr.signed.bin
```

The symbols go with the software type and version as well (0f02652): memfault-cli 1.12 does not find the GNU build ID
in this ELF and refuses symbols with neither. The board reports the same version string. The second command puts the
version in Memfault's releases, as a record: boards are never updated from Memfault. 1.14.0's symbols and release are
there. A test
image, or one built with `--symbols-only`, gets its symbols and no release. Without `~/.cranium/memfault_org_token`,
the organization and project, or the `memfault` command, it says so in one line and does nothing; it never fails a
build. The token goes to the command in its environment, never on its command line, and is never printed.
`scripts/firmware/build.sh --no-upload` uploads nothing: run `python3 -I tools/memfault_upload.py --build build` while `build/`
still holds that image.

## Setting it up

What only the owner can do, in this order. All seven are done for the team's project; they are here for a new project
or a new machine. Never put the project key, the token or the slugs in the repository:

1. **A Memfault project.** Sign in to nRF Cloud and open Memfault from it (or sign up at memfault.com), and make a
   project. Its **project key** is under Project settings. Save it, and nothing else, in
   `~/.cranium/memfault_project_key`, mode 600.
2. **An organization auth token**, for the symbols: Memfault, Admin, Organization Auth Tokens, new token. Save it in
   `~/.cranium/memfault_org_token`, mode 600.
3. **The slugs**, from the address of the project in Memfault (`/organizations/<org>/projects/<project>`), in
   `~/.cranium/memfault.json`, which is not a secret: `{"org": "<org>", "project": "<project>"}`.
4. **The command:** `pip install memfault-cli`.
5. **The cloud first:** run the Deploy console workflow, with the project key as the repository secret
   `MEMFAULT_PROJECT_KEY` and the slugs as the repository variables `MEMFAULT_ORG_SLUG` and `MEMFAULT_PROJECT_SLUG`
   ([docs/ci.md](ci.md#deploying-the-console-from-github-actions)), or, on the owner's laptop,
   `AWS_PROFILE=cranium cloud/deploy.sh`, which reads the files above. Either way it stores the project key in the secret (by the file's
   SHA-256, so running it again adds no version, and it never prints the key), passes the slugs, and gives the device
   policy the memfault topic. Add `MemfaultChunksHost=chunks.memfault.com` if the project was not made through nRF
   Cloud. Every board needs that policy before it runs 1.14.0; without it the board stops sending after two tries and
   says so.
6. **Commit, then build:** `scripts/firmware/build.sh --version 1.14.0`. It uploads the image to the console, and the symbols and
   the release to Memfault.
7. **Deploy 1.14.0** on the console, as any release: over the air, through AWS IoT Jobs, or send it from the phone app
   over Bluetooth, as was done on 2026-11-05.

## Showing 3.11 on the board

The checkoff, step by step, with what to show on each screen: [`fleet-demo.md`](fleet-demo.md). Run
`scripts/fleet/fleet-check.sh` first; it only reads.

1. **Updates with version information.** Deploy a release with a staged rollout (below). In Memfault each board shows
   its software version, `1.14.0+0`, the reboot before it as `FirmwareUpdate`, and an `update_succeeded` trace event
   once it is confirmed. The release is under Software. The console shows the same job, as before. 1.14.0 is on the
   board already (sent over Bluetooth), and Memfault shows its software version. 1.13.0, which installed it, had no
   Memfault to mark its restart as `FirmwareUpdate`, so the next update, from 1.14.0, is the one to watch end to end.
2. **A coredump.** Build the demonstration, one build number above, with its own build directory, and give Memfault its
   symbols. It is a test image: it is never a GitHub release, and it gets no release in Memfault:

   ```sh
   KIND=crash-demo firmware/tests/hil/build_image.sh 1.14.0 1 build-bench/images/cranium-1.14.0-1.signed.bin \
     -Dapp_CONFIG_APP_CRASH_DEMO=y
   python3 -I tools/memfault_upload.py --build build-bench/build-crash-demo
   scripts/firmware/upload-to-console.sh build-bench/images/cranium-1.14.0-1.signed.bin "Crash demonstration: crashes once"
   ```

   Deploy it to one board. It goes through its trial and is confirmed, and 60 s later it stops with `k_oops()`, once:
   the version it crashed on is kept, so it does not crash again. It restarts, still on that image, and sends the
   coredump. Memfault shows an issue with the backtrace into `crash_demo_on_tick()` in `src/mflt/mflt.c`, and the reboot as
   a kernel panic. Then deploy 1.14.1 or later, an ordinary build, to put the board back.
3. **Critical information in Memfault's cloud.** The reboot reasons, the heartbeat metrics and the update events above.
   "Send Memfault data now" on the board's page (the `memfault` command) takes a heartbeat at once instead of at the
   end of the hour, and it is in Memfault a few seconds later; `cloud/logs.sh memfault` shows each chunk forwarded.
4. **Several issues, then one release that fixes them all: the fault demonstration.** Built from 1.15.0's sources
   with `CONFIG_APP_FAULT_DEMO=y`, as a test image above every board's version (1.14.0+0 and 1.14.3+0) and the 1.14.6 release, and below
   1.15.0, with its symbols for Memfault:

   ```sh
   KIND=fault-demo firmware/tests/hil/build_image.sh 1.14.7 0 build-bench/images/cranium-1.14.7-0.signed.bin \
     -Dapp_CONFIG_APP_FAULT_DEMO=y
   python3 -I tools/memfault_upload.py --build build-bench/build-fault-demo
   scripts/firmware/upload-to-console.sh build-bench/images/cranium-1.14.7-0.signed.bin "Fault demonstration: five faults, one per boot"
   ```

   Deploy it. Each board goes through its trial and confirms the image as usual; no fault comes before the
   confirmation, so MCUboot's trial is never in danger. Then at each boot, once the board has been connected for 60 s
   (`CONFIG_APP_CRASH_DEMO_AFTER_SECONDS`) and Memfault has taken the coredump of the fault before, it faults once,
   each time in a different way, in a function of its own in `src/mflt/mflt.c`, so that each is its own issue in Memfault:

   | Boot after the confirmation | Fault | Memfault shows |
   | --- | --- | --- |
   | 1 | `MEMFAULT_ASSERT` that fails, `fault_demo_assert()` | Assert |
   | 2 | A write to the image's own code in flash, which the MPU forbids, `fault_demo_bad_write()` | MemManage fault (hard fault) |
   | 3 | An undefined instruction (`udf`), `fault_demo_undefined_instruction()` | Usage fault |
   | 4 | Recursion on the main thread until the stack limit register stops it (`CONFIG_BUILTIN_STACK_GUARD`), `fault_demo_recurse()` | Stack overflow (usage fault) |
   | 5 | The main loop hangs; Memfault's software watchdog (15 s) stops it before the hardware watchdog (120 s) would, `fault_demo_hang()` | Software watchdog |

   Which comes next is kept in storage (`STORE_TEST_FAULT`, with the version) and moves on before each fault, so
   each happens once, also if a fault went wrong; after the fifth the board runs normally. Each coredump is kept in
   the RAM that outlives the reset and sent once the board is connected again, so about 1 to 2 minutes pass between
   two faults. The log lines start with `Test image:`, so it can never become a GitHub release, and it gets symbols
   and no release in Memfault. No fault reads secure memory: a fault in TF-M would give no coredump. Then deploy
   **1.15.0**, an ordinary build, to every board at once: it has no fault demonstration, and the issues stop. The
   crash demonstration (`CONFIG_APP_CRASH_DEMO`, step 2) uses the same code with one fault, `k_oops()`; the two cannot
   be on together.
5. **Extra credit: a staged rollout, and A and B.** The console's staged rollouts (console 1.10.0, `fleet.md`) send an
   update to a canary first and to the rest in waves, and stop by themselves when the canary does not confirm; in
   Memfault the versions of the fleet change wave by wave, each board's reboot says `FirmwareUpdate`, and a canary that
   failed its trial shows `FirmwareUpdateError` and `update_rolled_back`. The board runs A and B slots: MCUboot keeps
   the previous image in the second slot and puts it back unless the new one confirms itself, and the coredump and the
   reboot reason of a new image that crashed on trial outlive that revert, so Memfault sees why B was given up.

## What has run

- **Shown, on 2026-11-05** ([`test-results.md`](test-results.md#firmware-1140-over-bluetooth-and-the-first-data-in-memfault)):
  console 2.1.0 deployed with the project key stored; 1.14.0 sent to the board over Bluetooth from the iPhone app,
  confirmed and online; the board's first two chunks posted by the forwarder at 19:32:34 UTC, Memfault answering 202,
  and the board acknowledged; Memfault listing the board with hardware `nrf7002dk` and software `1.14.0+0`. So the
  rule's `encode(*, 'base64')` hands these binary messages over, the function reads the key, and the answers reach the
  board.
- **Not run on a board yet:** the fault demonstration and 1.15.0's power status and default metrics (built and
  host-tested only, 2026-11-09).
- **Not shown yet:** a coredump (it needs the crash demonstration above on the board), and so the coredump surviving a
  reset and a revert and MCUboot leaving the regions alone; the first hourly heartbeat's metrics and their values; a
  staged rollout watched in Memfault; and what Memfault's chunks API answers other than 202.
- A chunk that Memfault got and whose answer was lost goes twice. The SDK deletes a message once its last chunk is
  taken, so a board that restarts after that and before the answer loses that one message.
- A coredump that does not fit 3,968 bytes is cut short at the end: some threads that did not crash are left out.

## Flash and RAM

The application image of the nRF7002 DK, from `west build` of the same sources before and after Memfault, and the
1.14.0 release, which also has the Bluetooth status (`firmware/CHANGELOG.md`):

| | 1.13.0 sources | With Memfault | 1.14.0 release (da27f3a) |
| --- | --- | --- | --- |
| Flash (application, of 794,474 bytes) | 724,836 bytes (91.2 %) | 740,816 bytes (93.2 %): 15,980 more | 745,168 bytes (93.8 %) |
| Signed image (of a 933,888-byte slot) | 856,082 bytes | 872,061 bytes: 15,979 more | 876,412 bytes: 57,476 left |
| RAM, the application's region | 403,508 of 409,600 bytes: 6,092 free | 403,972 of 405,504 bytes: 1,532 free | 404,284 of 405,504 bytes: 1,220 free |
| RAM for Memfault's two regions | none | 4,032 of 4,096 bytes | 4,032 of 4,096 bytes |

1.15.0, with the power status and Zephyr's default metrics: flash 746,488 of 794,474 bytes (47,986 left), RAM 404,404
of 405,504 bytes (1,100 free), signed image 877,733 bytes. `CONFIG_INIT_STACKS` costs no RAM; that is 120 bytes more
than the 1.14.0 release used.

Memfault costs 4,560 bytes of RAM in all: the 4 KiB of its regions, and 464 bytes more in the application, after the
3,425 bytes that reading the jobs message where it arrives gave back (its 4,097-byte copy, less a copy of the download
URL prefix and 512 bytes more of the MQTT thread's stack). The Bluetooth status takes 312 bytes more. MCUboot, TF-M and
the network core's image are unchanged. The first two columns were measured with `west build` of a copy of
`firmware/`, the way `firmware/tests/hil/build_image.sh` builds, so that neither `firmware/app/VERSION` nor
`binaries/` changed; the third is the release build of `scripts/firmware/build.sh`.
