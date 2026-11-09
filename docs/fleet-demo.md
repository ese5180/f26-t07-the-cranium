# Fleet management demonstration (manual 3.11)

What to show, in order, for the 3.11 checkoff, and where each requirement is met. The design is in
[`memfault.md`](memfault.md) and [`fleet.md`](fleet.md); the README's "3.11 Fleet Management" section is the summary
the manual asks for. The TA agreed that Memfault in nRF Cloud may get its data through AWS, as it does here.

## Before

1. `scripts/fleet-check.sh`. It only reads, and says whether the console answers, whether the two demonstration
   releases are on the Firmware page (the crash demonstration `1.14.0+1` and `1.14.2`, the release that ends it),
   how the board is, and whether Memfault has the board and the releases.
2. Plug the board in. It joins Wi-Fi and the console shows it online within a minute, on `1.14.0+0`.
3. `aws login --profile cranium --region us-east-1` in the Terminal app, for the live
   logs: `cloud/logs.sh memfault` shows each chunk the board sends to Memfault.
4. Open Memfault (app.memfault.com, the project in nRF Cloud) on Devices, Issues and Software, and the console on the
   board's page.

## 1. OTA firmware updates with version information

On the console: Deployments, then a new deployment of `1.14.0+1` to the board (or a staged rollout with the board as
its canary, for the extra credit below). Show:

- the console: the job's progress, the board's version changing, the trial and the confirmation;
- Memfault, Devices, the board: software version `1.14.0+1`, hardware `nrf7002dk`; its timeline shows the reboot as
  `FirmwareUpdate` and an `update_succeeded` event once the board confirms the image.

## 2. A core dump

`1.14.0+1` is the crash demonstration (`CONFIG_APP_CRASH_DEMO`). About 60 s after it confirms itself it stops with
`k_oops()`, once: it keeps the version it crashed on, so it does not crash again. It restarts on the same image and
sends the coredump over its AWS IoT connection. Show:

- Memfault, Issues: a new issue with the backtrace into `crash_demo_on_tick()` in `src/mflt.c` (Memfault has the
  build's symbols), the registers and the threads' stacks;
- the board's timeline: the reboot as a kernel panic.

## 3. Critical device information forwarded to Memfault

On the board's page in the console: **Send Memfault data now**. A heartbeat goes at once instead of at the end of the
hour, and is in Memfault a few seconds later. Show in Memfault, the board's metrics: the Wi-Fi signal, connected time
and disconnects, AWS IoT reconnects, free heap, and update attempts, failures and refusals; and the reboot reasons
(power-on, watchdog, crash, update). `cloud/logs.sh memfault` shows each chunk forwarded and Memfault's 202.

## 4. Back to an ordinary release (and the extra credit)

Deploy `1.14.2` to the board. It is newer than `1.14.0+1`, so the board takes it, and Memfault shows the version change
again.

Extra credit, said with the screens above:

- **Staged rollout:** the console's staged rollouts send an update to a canary first, then the rest in waves, and stop
  by themselves when the canary does not confirm or too many boards fail ([`fleet.md`](fleet.md)).
- **A/B:** MCUboot keeps the previous image in the second slot and puts it back unless the new one confirms itself.
  A crash on trial is kept through that revert, so Memfault shows why B was given up (`FirmwareUpdateError`,
  `update_rolled_back`).

## If something goes wrong

- **The board is offline:** it is on the wrong Wi-Fi, or the network gives it no internet. A deployment waits for
  it; the update can also go over Bluetooth from the phone app (the board's page, Bluetooth).
- **No issue in Memfault after the crash:** the coredump goes once the board is connected again; Send Memfault data
  now pushes it. `cloud/logs.sh memfault` shows whether chunks arrive.
- **The board does not take a release:** it takes only a newer version than it runs. After `1.14.2` a new crash
  demonstration needs a build above it (`scripts/build.sh` picks the next version; docs/memfault.md).
