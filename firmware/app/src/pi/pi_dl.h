/*
 * The download of a Raspberry Pi image onto the SD card: what is written where, what is hashed,
 * when a checkpoint is saved, and where a download continues after it was cut off
 * (docs/pi-ota.md, "Download and resume").
 *
 * The bytes go to PI_SD_IMAGE as they arrive and into a SHA-256 over the whole file. Every
 * CONFIG_APP_PI_OTA_CHECKPOINT_KB the file is synced and PI_SD_RECORD saved: how many bytes are good
 * and the state of the hash after them. A download that fails goes on from the last byte written,
 * with the hash still in memory; one that the card failed, or a restart, goes back to the last
 * checkpoint and asks the server for the rest (an HTTP range). The digest is compared at the end,
 * against the one in the job, whose signature was checked before anything was downloaded.
 *
 * Network-free and hardware-free: the caller feeds it what the HTTP client delivers. Tested on the
 * host with a fake HTTP server and an in-memory file system (test_pi_ota.c).
 */

#ifndef PI_DL_H_
#define PI_DL_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ota_job.h"
#include "pi_image.h"
#include "pi_sd.h"
#include "pi_sha256.h"

#ifndef CONFIG_APP_PI_OTA_CHECKPOINT_KB
#define CONFIG_APP_PI_OTA_CHECKPOINT_KB 1024
#endif

/* Kept free on the card beyond the image, for the record and the file system's own needs. */
#define PI_DL_FREE_MARGIN (64u * 1024u)

struct pi_dl {
	struct pi_record record;
	struct pi_sd_file image;
	/* Over the received bytes. */
	struct pi_sha256 hash;
	uint32_t received;
	uint32_t since_checkpoint;
};

/*
 * Read the record on the card into *record. A card without one, or with a damaged one, gives an
 * empty record and PI_OK. Errors are those of the card.
 */
enum pi_err pi_dl_load_record(struct pi_record *record);

/*
 * Start the download of the image in job, or go on with it. *from is where the HTTP download
 * starts. *complete is true if the whole image is already on the card and was found good: then
 * there is nothing to download.
 */
enum pi_err pi_dl_begin(struct pi_dl *dl, const struct pi_target *job, uint32_t *from,
			bool *complete);

/* The next bytes of the download, in order. */
enum pi_err pi_dl_write(struct pi_dl *dl, const void *data, size_t len);

/*
 * After an attempt that failed: where the next one starts. With card_failed, a write may be
 * half done, so it goes back to the last checkpoint; otherwise it goes on where it stopped.
 */
enum pi_err pi_dl_resume_point(struct pi_dl *dl, bool card_failed, uint32_t *from);

/*
 * The server says the download is complete: check its size and digest, and record the image as
 * downloaded. On a digest that does not match, the image and its record are removed, so that the
 * next attempt starts from nothing.
 */
enum pi_err pi_dl_finish(struct pi_dl *dl);

/* Stop for now: the file is closed and the last checkpoint stays, to go on from later. */
void pi_dl_close(struct pi_dl *dl);

/* Start the same image again from its first byte: what is on the card goes. */
enum pi_err pi_dl_reset(struct pi_dl *dl);

/* The Pi has verified the image: remember it, so that the same image is not sent again. */
enum pi_err pi_dl_mark_installed(const uint8_t sha256[PI_SHA256_SIZE], const char *version);

#endif /* PI_DL_H_ */
