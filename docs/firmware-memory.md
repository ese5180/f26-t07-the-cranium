# Firmware memory on the nRF7002 DK

Where the application core's RAM and flash go, what each board reports about it, and how to size a stack
or a heap. The floors that every firmware build must keep free are in `tools/memory_budgets.json`
(docs/ci.md, "Memory headroom").

## What a board reports

From 1.19.3, with every diagnostics report (when it reaches the cloud, then every
`CONFIG_APP_DIAG_INTERVAL_SECONDS`), a board sends two more reports into its shadow
(`src/stack_watch.h`, format in `src/policy/stack_policy.h`):

- `"stacks"`: for each thread, and for the interrupt stack as `isr`, the most of its stack it has ever
  used since the board started, in bytes, and `max_pct`, the highest share of any of them. It is read from
  the fill that `CONFIG_INIT_STACKS` puts in every stack, so it costs no RAM. When the threads do not fit
  one report they go in several, which the shadow merges.
- `"heaps"`: `[size, peak]` of every heap the kernel knows (the system heap, the nRF70 driver's control and
  data heaps and the network buffer pools), in bytes, in the order they were set up.

A thread past 80 % of its stack is also a warning in the log: `Stack of <name>: <used> of <size> bytes used
(<n>%)`. An overflow is still stopped as before, by the stack limit register and the MPU guard
(`CONFIG_HW_STACK_PROTECTION`), and Memfault gets its coredump.

The diagnostics report already had the system heap (`"heap"`: free now, least free, size).

## Sizing a stack or a heap

Size it from the peak boards report, after a day that included a cloud update, a Bluetooth update, a Wi-Fi
scan for location and a reconnection, and keep at least 25 % of it unused. Never make one smaller from a
reading of a board that has not done those things.

## Stacks (1.19.3)

| Thread | Stack (bytes) | Set by |
| --- | ---: | --- |
| main | 6144 | `CONFIG_MAIN_STACK_SIZE` (board file) |
| console | 6144 | `CONFIG_APP_CONSOLE_STACK_SIZE` (key generation runs on it) |
| Wi-Fi connectivity work queue | 6144 | nRF70 driver |
| wpa_supplicant | 5800 | supplicant |
| MCUmgr (Bluetooth update) | 4608 | `CONFIG_MCUMGR_TRANSPORT_WORKQUEUE_STACK_SIZE` |
| MQTT helper | 4608 | `CONFIG_MQTT_HELPER_STACK_SIZE` |
| network management | 4600 | network stack |
| supplicant interface work queue | 4400 | supplicant |
| firmware download | 4096 | `CONFIG_DOWNLOADER_STACK_SIZE` |
| network TX | 4096 | network stack |
| system work queue | 4096 | `CONFIG_SYSTEM_WORKQUEUE_STACK_SIZE` |
| cloud connection | 4096 | `CONNECT_STACK`, src/cloud/cloud.c |
| interrupts | 2048 | `CONFIG_ISR_STACK_SIZE` |
| Bluetooth RX | 2048 | `CONFIG_BT_RX_STACK_SIZE` |
| network RX | 2048 | `CONFIG_NET_RX_STACK_SIZE` |
| logging | 2048 | logging |
| nRF70 interrupt and bottom half | 2048 each | nRF70 driver |
| Bluetooth long work queue | 1800 | Bluetooth host |
| others (input, IPC, connection manager, idle) | 320 to 1200 | Zephyr |

The most each has used is what the boards' `"stacks"` reports will say; none had been measured on a board
before 1.19.3.

## Heaps and the largest buffers (1.19.3)

| What | Bytes |
| --- | ---: |
| Mbed TLS heap (two TLS sessions: MQTT and the download) | 81,920 |
| nRF70 data heap | 59,856 |
| system heap | 44,240 |
| nRF70 control heap | 20,000 |
| firmware download: its thread and host and file names | 6,968 |
| cloud events waiting to be sent | 6,144 |
| network buffer pools, RX and TX | 4,096 each |
| MQTT payload buffer | 4,096 |
| serial console output | 4,096 |
| firmware download buffer | 4,096 |
| Memfault coredump (kept across a reset, outside the application's RAM) | 3,968 |

## Changes in 1.19.3

Free in the application image of the default build, in bytes, measured from the builds (more is better):

| Build | Flash free | RAM free |
| --- | ---: | ---: |
| main before (1.19.2 sources) | 40,506 | 1,004 |
| with the stack and heap reports and the topic buffers | 39,354 | 1,476 |
| and IPv6 off | 64,658 | 4,628 |
| 1.19.3 (golden image promotion) with all of it | 62,330 | 4,556 |

| Change | RAM | Flash | Behaviour |
| --- | ---: | ---: | --- |
| IPv6 off (`CONFIG_NET_IPV6=n`, board file) | +3,152 | +25,304 | Unchanged: the board goes online on its IPv4 address (src/net.c), a job's URL may not hold an IPv6 address (src/ota/ota_job.c), and AWS IoT and S3 are reached over IPv4. |
| Jobs and events topic buffers as long as their topics (src/cloud/cloud.c) | +508 | | Unchanged: the same topics, which the host tests check fill their buffers exactly. |
| Stack and heap reports (src/stack_watch.c) | -36 | -1,152 | New: two reports in the shadow and a warning in the log; nothing else changes. |

## Not done, and why

- **The nRF70 firmware patches in external flash** (`SB_CONFIG_WIFI_PATCHES_EXT_FLASH_STORE`, 87.5 KB of
  flash). The patches become a separate image that has to be written into external flash by the debugger
  or by a second MCUboot image, which needs a new partition, so a new flash layout that every board in the
  field refuses, and a bootloader that a board cannot get over the air. A board updated over the air would
  find no patches and lose Wi-Fi until it reverted.
- **No floating point in printf** (`CONFIG_CBPRINTF_FP_SUPPORT=n`, about 3 KB of flash). The supplicant
  reports the link speed with `%.1f` and Zephyr reads it back with `%f`, and cJSON prints numbers with
  `%g`.
- **Shorter asserts** (`CONFIG_ASSERT_NO_MSG_INFO` and the like). The checks would stay, but a failed one
  would say less on the serial console.
- **Smaller stacks and heaps now.** Nothing had measured them on a board; the reports above are there so
  that the next release can.
- **Dictionary logging** for the application's logs. The console and the apps read the log lines as text.
