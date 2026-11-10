/*
 * Raspberry Pi image update (docs/pi-ota.md), from 1.20.0 with CONFIG_APP_PI_OTA.
 *
 * A Pi image comes as an AWS IoT job, as firmware does, with "op": "pi_image". ota.c decides when
 * one may start, since board firmware goes first, and hands it over here. This checks the job's
 * signed manifest, downloads the image over HTTPS onto the SD card, checks its size and SHA-256,
 * and sends it over SPI to the Pi's partition B (pi_xfer.h). It reports progress and the outcome on
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
#include "pi_image.h"

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
 * it over while a Pi image is under way and the firmware's own download is not.
 */
void pi_ota_on_download(enum app_download_event what, int value);

/*
 * From 1.20.0: the Pi part of a job that brings board firmware too ("fw_pi_update", docs/pi-ota.md,
 * "Both at once"). ota.c owns that job: it decides when each part goes, and it sends the job's final
 * status. This reports the Pi part's progress on the job (steps "downloading_pi" and "flashing_pi")
 * and its state in the shadow, and hands the outcome back through pi_ota_bundle_take_result().
 */
enum pi_ota_bundle_step {
	/* Onto the SD card only, before the board's firmware is installed. */
	PI_OTA_BUNDLE_STAGE,
	/* Onto the Pi, from the card, once the new firmware is confirmed. What the card lacks is
	 * downloaded first, so this also covers a card that lost the image in between.
	 */
	PI_OTA_BUNDLE_FLASH,
};

/*
 * The Pi part's checks, before anything of the job is downloaded: the signature over its manifest,
 * its size, and its minFirmware against the firmware the job brings, which is what will run when
 * the Pi gets its image. PI_ERR_ALREADY_INSTALLED when the Pi has that image already.
 */
enum pi_err pi_ota_bundle_check(const struct ota_job *job);

/* Start a step of the Pi part, or hand a step under way the fresh download URL it asked for. */
void pi_ota_bundle(const struct ota_job *job, enum pi_ota_bundle_step step);

/* A step of the Pi part has ended: true once, with PI_OK or why in *err. */
bool pi_ota_bundle_take_result(enum pi_err *err);

/* The version of the image that the Pi verified last, or "" if none is known. */
const char *pi_ota_installed_version(void);

#endif /* PI_OTA_H_ */
