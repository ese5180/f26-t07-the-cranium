# Code map for the 3.11 demo (what to point at)

Line numbers are from the 1.14.7 / 1.15.0 firmware (PR #23); they shift a little as the code changes. All paths are from the repository root.

## Memfault: from the board to Memfault's website
1. **Turned on:** `firmware/app/prj.conf` lines 83-121 (CONFIG_MEMFAULT=y, Memfault's own HTTP turned off, a RAM-backed coredump of 3968 B, and a custom reboot reason).
2. **Hooks on the board:** `firmware/app/src/mflt.c`
   - `memfault_reboot_reason_get()` :96 gives the reboot reason, from `reset_cause.c` (`reset_cause_capture()` :16).
   - `memfault_metrics_heartbeat_collect_data()` :194 sets the metrics: power_usb_present, supply_mv, stuck restarts, and `read_wifi_metrics()` :205 (RSSI, channel).
   - Trace events :583-600: update_succeeded, refused, rolled_back, digest_mismatch, incompatible, failed.
   - `send()` :237 runs `mflt_link_poll()`, and `next_chunk()` :70 pulls a chunk with `memfault_packetizer_get_chunk()`.
   - `publish_frame()` :64 hands the chunk to the cloud.
   - Called from `main.c`: `mflt_on_tick()` :356, `mflt_on_net_up/down` :457/463, `mflt_on_cloud_up` :494.
3. **Flow control:** `firmware/app/src/mflt_link.c`: one chunk at a time; the next goes only after AWS acks (`mflt_link_answer()` :87).
4. **Over MQTT to AWS:** `firmware/app/src/cloud.c`, `cloud_memfault_publish()` :682 publishes to the topic `cranium/<thing>/memfault` on the board's existing TLS connection to AWS IoT. There is no second connection.
5. **AWS IoT rule:** `cloud/infra/template.yaml` `MemfaultRule` (~line 2191): `SELECT encode(*,'base64') ... FROM 'cranium/+/memfault'` invokes the forwarder Lambda.
6. **Forwarder Lambda:** `cloud/api/src/forwarder.mjs` `createForwarder()` :89 posts the chunk to Memfault's `/api/v0/chunks/<thing>` with the project key from Secrets Manager (it never reaches the board), then acks the board (`memfault_ack` command, `ackPayload()` :67).
7. **Memfault** decodes the chunks with the build's symbols, uploaded by `tools/memfault_upload.py` / `scripts/firmware/build.sh`.

## Coredump
- The fault handler (Memfault + Zephyr) saves the registers and stacks into the `MFLT_COREDUMP` no-init RAM region (prj.conf :95-104), which survives the reset; after the reboot it goes out as chunks as above.
- Fault demo in `mflt.c`: `fault_demo_assert` :309, `fault_demo_bad_write` :316 (MPU), `fault_demo_undefined_instruction` :324, `fault_demo_recurse` :330 (stack overflow), `fault_demo_hang` :342 (watchdog), and the picker `fault_demo_make()` :351. One per boot, recorded in storage first.

## OTA with version info (board side): `firmware/app/src/ota.c`
1. The job arrives over AWS IoT Jobs (`cloud.c` `on_message()` :280, which queues job messages :260).
2. `on_job()` :712 parses it (`ota_job.c` `ota_job_parse()` :277: the URL, SHA-256, size) and checks it with `ota_job_check()` :333. Only a **newer version** is taken (`version.c` `fw_version_compare()` :102), and only if it fits the slot.
3. `start_download()` :364 runs `fota_download_start()` over HTTPS (a presigned S3 URL) into the secondary slot; `image_compat.c` checks the board type and flash layout in the header.
4. `install_download()` :584: the digest is checked, then `boot_request_upgrade_multi(.., BOOT_UPGRADE_TEST)` :614 marks it **on trial**, then `sys_reboot` :626.
5. MCUboot swaps the slots (A/B). In `ota_init()` :818, once the new image reaches AWS again, `boot_write_img_confirmed()` :910/928 confirms it. If it never confirms, MCUboot puts the old image back on the next reset (rollback). `ota_outcome.c` decides which, and the result goes to the job and to Memfault.

## OTA (cloud side): `cloud/api/src`
- Upload: `lib/mcuboot.mjs` `validateImage()` :172 checks the signature with our key, the version and the size; `parseVersion` / `compareVersions` :76/:93.
- Deploy: `lib/jobs.mjs` creates the AWS IoT job (presigned URL lasting 600 s, `MAX_IN_FLIGHT` 5); `lib/fleet.mjs` decides which boards can take it (board type, layout, older version).
- Staged rollout (extra credit): `rollouts-tick.mjs` runs on a schedule: canary first, then the waves, and it stops itself if the canary fails.
