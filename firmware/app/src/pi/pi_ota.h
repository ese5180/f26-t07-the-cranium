/*
 * Raspberry Pi image update (docs/pi-ota.md), from 1.15.0 with CONFIG_APP_PI_OTA.
 *
 * A Pi image comes as an AWS IoT job, as firmware does, with "op": "pi_image". ota.c decides when
 * one may start, since board firmware goes first, and hands it over here. This checks the job's
 * signed manifest, downloads the image over HTTPS onto the SD card, checks its size and SHA-256,
 * and sends it over SPI to the Pi's partition B (pi_link.h). It reports progress and the outcome on
 * the job, and its state in the shadow under "pi".
 *
 * Every function here runs on the main loop. The download and the transfer run on their own
 * threads, and what they find comes back through pi_ota_on_tick().
 */

#ifndef PI_OTA_H_
#define PI_OTA_H_

#include <stdbool.h>

#include "app_events.h"
#include "ota_job.h"

int pi_ota_init(void);

/* A Pi image job that may go now: a new one, the same one with a fresh URL, or one to resume. */
void pi_ota_on_job(const struct ota_job *job);

/* A Pi image job is being worked on. */
bool pi_ota_busy(void);
/* That job is this one. */
bool pi_ota_owns(const char *job_id);

/* The cloud no longer lists the job: stop, and tell the Pi to drop what it got. */
void pi_ota_withdrawn(void);

/* A Pi image waits for a board firmware update to finish (shadow: "waiting_for_firmware"). */
void pi_ota_set_waiting(bool waiting);

/* Once a second. */
void pi_ota_on_tick(void);

/*
 * An event of the downloader, which a Pi image shares with firmware (fota_download): ota.c hands
 * it over while a Pi image is under way and no firmware update is.
 */
void pi_ota_on_download(enum app_download_event what, int value);

#endif /* PI_OTA_H_ */
