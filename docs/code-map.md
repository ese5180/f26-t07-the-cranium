# Code map for the 3.11 demo (what to point at)

Places are given by file and function name, which stay put as the code changes; search the file for the name. All paths are from the repository root.

## Memfault: from the board to Memfault's website
1. **Turned on:** `firmware/app/prj.conf`, the Memfault block (CONFIG_MEMFAULT=y, Memfault's own HTTP turned off, a RAM-backed coredump of 3968 B, and a custom reboot reason).
2. **Hooks on the board:** `firmware/app/src/mflt.c`
   - `memfault_reboot_reason_get()` gives the reboot reason, from `reset_cause.c` (`reset_cause_capture()`).
   - `memfault_metrics_heartbeat_collect_data()` sets the metrics: power_usb_present, supply_mv, stuck restarts, and `read_wifi_metrics()` (RSSI, channel).
   - Trace events in `mflt_note_update_end()`: update_succeeded, refused, rolled_back, digest_mismatch, incompatible, failed.
   - `send()` runs `mflt_link_poll()`, and `next_chunk()` pulls a chunk with `memfault_packetizer_get_chunk()`.
   - `publish_frame()` hands the chunk to the cloud.
   - Called from `main.c`: `mflt_on_tick()`, `mflt_on_net_up/down`, `mflt_on_cloud_up`.
3. **Flow control:** `firmware/app/src/mflt_link.c`: one chunk at a time; the next goes only after AWS acks (`mflt_link_answer()`).
4. **Over MQTT to AWS:** `firmware/app/src/cloud.c`, `cloud_memfault_publish()` publishes to the topic `cranium/<thing>/memfault` on the board's existing TLS connection to AWS IoT. There is no second connection.
5. **AWS IoT rule:** `cloud/infra/template.yaml` `MemfaultRule`: `SELECT encode(*,'base64') ... FROM 'cranium/+/memfault'` invokes the forwarder Lambda.
6. **Forwarder Lambda:** `cloud/api/src/forwarder.mjs` `createForwarder()` posts the chunk to Memfault's `/api/v0/chunks/<thing>` with the project key from Secrets Manager (it never reaches the board), then acks the board (`memfault_ack` command, `ackPayload()`).
7. **Memfault** decodes the chunks with the build's symbols, uploaded by `tools/memfault_upload.py` / `scripts/firmware/build.sh`.

## Coredump
- The fault handler (Memfault + Zephyr) saves the registers and stacks into the `MFLT_COREDUMP` no-init RAM region (set in prj.conf's Memfault block), which survives the reset; after the reboot it goes out as chunks as above.
- Fault demo in `mflt.c`: `fault_demo_assert`, `fault_demo_bad_write` (MPU), `fault_demo_undefined_instruction`, `fault_demo_recurse` (stack overflow), `fault_demo_hang` (watchdog), and the picker `fault_demo_make()`. One per boot, recorded in storage first.

## OTA with version info (board side): `firmware/app/src/ota.c`
1. The job arrives over AWS IoT Jobs (`cloud.c` `on_message()`, which queues job messages with `queue_job_message()`).
2. `on_job()` parses it (`ota_job.c` `ota_job_parse()`: the URL, SHA-256, size) and checks it with `ota_job_check()`. Only a **newer version** is taken (`version.c` `fw_version_compare()`), and only if it fits the slot.
3. `start_download()` runs `fota_download_start()` over HTTPS (a presigned S3 URL) into the secondary slot; `image_compat.c` checks the board type and flash layout in the header.
4. `install_download()`: the digest is checked, then `boot_request_upgrade_multi(.., BOOT_UPGRADE_TEST)` marks it **on trial**, then `sys_reboot()`.
5. MCUboot swaps the slots (A/B). In `ota_init()`, once the new image reaches AWS again, `boot_write_img_confirmed()` confirms it. If it never confirms, MCUboot puts the old image back on the next reset (rollback). `ota_outcome.c` decides which, and the result goes to the job and to Memfault.

## OTA (cloud side): `cloud/api/src`
- Upload: `lib/mcuboot.mjs` `validateImage()` checks the signature with our key, the version and the size; `parseVersion` / `compareVersions`.
- Deploy: `lib/jobs.mjs` creates the AWS IoT job (presigned URL lasting 600 s, `MAX_IN_FLIGHT` 5); `lib/fleet.mjs` decides which boards can take it (board type, layout, older version).
- Staged rollout (extra credit): `rollouts-tick.mjs` runs on a schedule: canary first, then the waves, and it stops itself if the canary fails.
