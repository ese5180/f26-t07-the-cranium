/*
 * Golden image promotion, the application's part (from 1.19.3): a job carries a promotion record,
 * this hands it to the bootloader through external flash and restarts when the board is idle, and
 * after the restart reports what the bootloader made of it. The bootloader does the checks that
 * count: firmware/README.md, "Golden image".
 *
 * Only with CONFIG_APP_GOLDEN_PROMOTE. All functions run on the main loop.
 */

#ifndef GOLDEN_PROMOTE_H_
#define GOLDEN_PROMOTE_H_

#include <stdbool.h>
#include <stddef.h>

#include "ota_job.h"

/* Reads the external flash once, for the report. */
void golden_promote_init(void);

/* A golden_promote job from the cloud, on an idle board. It answers the job itself. */
void golden_promote_on_job(const struct ota_job *job);

/* Once a second: restarts for the bootloader once a record is handed over and the board is idle. */
void golden_promote_on_tick(bool idle);

/* True while a record waits for the restart: no other job may start. */
bool golden_promote_busy(void);

/*
 * The shadow's "golden" object: {"version":"1.19.2+0","counter":1,"state":"sealed"}. version is null
 * before the first promotion on a board. state is "none", "pending" or the bootloader's last answer.
 */
int golden_promote_report(char *buf, size_t len);

#endif /* GOLDEN_PROMOTE_H_ */
