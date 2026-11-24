/*
 * Raspberry Pi delta updates on a board (docs/pi-delta-update.md), from 1.20.0 with
 * CONFIG_APP_PI_DELTA: a "pi_delta" job brings the mirror of the Pi's image on the SD card to a new
 * image, downloading only the blocks that changed (pi_delta.c), and the Pi takes them over SPI
 * (pi_dlink.c) whenever it asks. ota.c hands such jobs here; this answers them.
 *
 * Every function here runs on the main loop. The update runs on its own thread, and its outcome
 * comes back through pi_delta_ota_on_tick().
 */

#ifndef PI_DELTA_OTA_H_
#define PI_DELTA_OTA_H_

#include <stdbool.h>
#include <stddef.h>

#include "ota_job.h"

/* The card, the link to the Pi and the update's thread. 0, or a negative errno. */
int pi_delta_ota_init(void);

/*
 * A pi_delta job named by the cloud: a new one, the one under way with a fresh URL, or one left in
 * progress by a restart, which goes on from what the card says.
 */
void pi_delta_ota_on_job(const struct ota_job *job);

/* A job is being worked on, or waits for a fresh URL. */
bool pi_delta_ota_busy(void);

/* The cloud no longer lists the job: stop, with nothing reported. The card keeps its progress. */
void pi_delta_ota_withdrawn(void);

/* Once a second. */
void pi_delta_ota_on_tick(void);

/*
 * The card and the job, for STATUS: {"card":"ready","version":"2026.11.24-1","generation":3,
 * "step":"blocks","done":4,"total":10}. The length written, or a negative errno.
 */
int pi_delta_ota_report(char *buf, size_t len);

#endif /* PI_DELTA_OTA_H_ */
