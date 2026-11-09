# firmware/app/src

The application's sources. Every folder here is on the include path (`firmware/app/CMakeLists.txt`, and
`firmware/tests/host/Makefile` for the host tests), so an `#include` names only the header.

| Folder | What is in it |
| --- | --- |
| `.` | The main loop (`main.c`), the serial console (`console*.c`), Wi-Fi (`net.c`), and the shared core: device ID, identity, storage, LEDs and buttons, health, diagnostics, reset cause, boot diary, factory reset |
| `bt/` | Firmware update over Bluetooth, its status characteristic and the static passkey |
| `bt_only/` | The main loop and update manager of a board with Bluetooth only (the nRF5340 DK) |
| `cloud/` | AWS IoT: the connection, jobs and shadow (`cloud.c`), commands, events and location |
| `ota/` | Firmware update over the air: the job, the download, the outcome after a restart, image compatibility and versions |
| `mflt/` | Memfault: its hooks, and its chunks over AWS IoT |
| `policy/` | Decisions kept apart from the hardware, so the host tests can run them: when to join Wi-Fi, when a board is stuck, what an update over Bluetooth may do, which passkey is allowed |

The console, `net.c`, `device.c` and `identity.c` stay at the top because the cloud tests read their
limits and command table from these paths (`cloud/web/test/serial.test.mjs`, `cloud/api/test/release.test.mjs`).
