#include "pi_dl.h"

#include <string.h>

#define CHECKPOINT_BYTES ((uint32_t)CONFIG_APP_PI_OTA_CHECKPOINT_KB * 1024u)

static enum pi_err save_record(struct pi_record *record)
{
	pi_record_seal(record);
	return pi_sd_save(PI_SD_RECORD, PI_SD_TEMP, record, sizeof(*record));
}

enum pi_err pi_dl_load_record(struct pi_record *record)
{
	enum pi_err err = pi_sd_check();

	if (err != PI_OK) {
		return err;
	}

	err = pi_sd_load(PI_SD_RECORD, PI_SD_TEMP, record, sizeof(*record));
	if (err == PI_ERR_SD_IO || (err == PI_OK && !pi_record_valid(record))) {
		/* None, or not one to trust: as good as none. */
		memset(record, 0, sizeof(*record));
		return PI_OK;
	}

	return err;
}

static bool same_image(const struct pi_record *record, const struct pi_target *job)
{
	return record->size == job->size &&
	       memcmp(record->sha256, job->sha256, PI_SHA256_SIZE) == 0 &&
	       strcmp(record->version, job->version) == 0;
}

/* Start from nothing: an empty image file and a record of no bytes. */
static enum pi_err start_fresh(struct pi_dl *dl, const struct pi_target *job)
{
	uint32_t existing;
	uint64_t free_bytes;
	bool exists;
	enum pi_err err;

	err = pi_sd_size(PI_SD_IMAGE, &existing, &exists);
	if (err == PI_OK) {
		err = pi_sd_free(PI_SD_MOUNT, &free_bytes);
	}
	if (err != PI_OK) {
		return err;
	}

	/* The old image's room comes back when it is removed. */
	if (free_bytes + existing < (uint64_t)job->size + PI_DL_FREE_MARGIN) {
		return PI_ERR_SD_FULL;
	}

	err = pi_sd_remove(PI_SD_IMAGE);
	if (err == PI_OK) {
		err = pi_sd_open(&dl->image, PI_SD_IMAGE, true, true);
	}
	if (err != PI_OK) {
		return err;
	}

	dl->record.phase = PI_PHASE_DOWNLOADING;
	memcpy(dl->record.version, job->version, sizeof(dl->record.version));
	dl->record.size = job->size;
	memcpy(dl->record.sha256, job->sha256, PI_SHA256_SIZE);
	dl->record.done = 0;
	pi_sha256_init(&dl->record.hash);
	dl->hash = dl->record.hash;
	dl->received = 0;
	return PI_OK;
}

/* Go back to the last checkpoint: the file is cut there and the hash is the one saved with it. */
static enum pi_err back_to_checkpoint(struct pi_dl *dl)
{
	uint32_t on_card;
	bool exists;
	enum pi_err err;

	if (!dl->image.open) {
		err = pi_sd_open(&dl->image, PI_SD_IMAGE, true, false);
		if (err != PI_OK) {
			return err;
		}
	}

	err = pi_sd_size(PI_SD_IMAGE, &on_card, &exists);
	if (err != PI_OK) {
		return err;
	}

	if (!exists || on_card < dl->record.done) {
		/* Less on the card than the checkpoint vouches for: it is not the card it was. */
		return PI_ERR_SD_IO;
	}

	err = pi_sd_truncate(&dl->image, dl->record.done);
	if (err == PI_OK) {
		err = pi_sd_seek(&dl->image, dl->record.done);
	}
	if (err != PI_OK) {
		return err;
	}

	dl->hash = dl->record.hash;
	dl->received = dl->record.done;
	dl->since_checkpoint = 0;
	return PI_OK;
}

enum pi_err pi_dl_begin(struct pi_dl *dl, const struct pi_target *job, uint32_t *from,
			bool *complete)
{
	enum pi_err err;

	/* A file left open by a download that was stopped. */
	pi_dl_close(dl);
	memset(dl, 0, sizeof(*dl));
	*from = 0;
	*complete = false;

	err = pi_sd_mkdir(PI_SD_DIR);
	if (err == PI_OK) {
		err = pi_dl_load_record(&dl->record);
	}
	if (err != PI_OK) {
		return err;
	}

	err = PI_ERR_SD_IO;
	if (same_image(&dl->record, job) && dl->record.phase == PI_PHASE_DOWNLOADED) {
		uint32_t on_card;
		bool exists;

		err = pi_sd_size(PI_SD_IMAGE, &on_card, &exists);
		if (err != PI_OK) {
			return err;
		}
		if (exists && on_card == job->size) {
			*complete = true;
			*from = job->size;
			dl->received = job->size;
			memcpy(dl->record.job_id, job->id, sizeof(dl->record.job_id));
			return save_record(&dl->record);
		}
		err = PI_ERR_SD_IO;
	} else if (same_image(&dl->record, job) && dl->record.phase == PI_PHASE_DOWNLOADING) {
		err = back_to_checkpoint(dl);
		if (err == PI_ERR_SD_ABSENT) {
			return err;
		}
	}

	if (err != PI_OK) {
		pi_dl_close(dl);
		err = start_fresh(dl, job);
		if (err != PI_OK) {
			pi_dl_close(dl);
			return err;
		}
	}

	memcpy(dl->record.job_id, job->id, sizeof(dl->record.job_id));
	err = save_record(&dl->record);
	if (err != PI_OK) {
		pi_dl_close(dl);
		return err;
	}

	*from = dl->received;
	return PI_OK;
}

static enum pi_err checkpoint(struct pi_dl *dl)
{
	enum pi_err err = pi_sd_sync(&dl->image);

	if (err != PI_OK) {
		return err;
	}

	dl->record.done = dl->received;
	dl->record.hash = dl->hash;
	dl->since_checkpoint = 0;
	return save_record(&dl->record);
}

enum pi_err pi_dl_write(struct pi_dl *dl, const void *data, size_t len)
{
	enum pi_err err;

	if (!dl->image.open || dl->record.phase != PI_PHASE_DOWNLOADING) {
		return PI_ERR_SD_IO;
	}

	if (len > dl->record.size - dl->received) {
		return PI_ERR_SIZE_MISMATCH;
	}

	/* Checkpoints fall on whole multiples of their size, wherever the pieces end. */
	while (len > 0) {
		uint32_t to_checkpoint = CHECKPOINT_BYTES - dl->received % CHECKPOINT_BYTES;
		size_t take = len < to_checkpoint ? len : to_checkpoint;

		err = pi_sd_write(&dl->image, data, take);
		if (err != PI_OK) {
			return err;
		}

		pi_sha256_update(&dl->hash, data, take);
		dl->received += (uint32_t)take;
		dl->since_checkpoint += (uint32_t)take;
		data = (const uint8_t *)data + take;
		len -= take;

		if (dl->received % CHECKPOINT_BYTES == 0) {
			err = checkpoint(dl);
			if (err != PI_OK) {
				return err;
			}
		}
	}

	return PI_OK;
}

enum pi_err pi_dl_resume_point(struct pi_dl *dl, bool card_failed, uint32_t *from)
{
	enum pi_err err = PI_OK;

	if (card_failed || !dl->image.open) {
		pi_dl_close(dl);
		err = back_to_checkpoint(dl);
	}

	*from = dl->received;
	return err;
}

enum pi_err pi_dl_finish(struct pi_dl *dl)
{
	uint8_t digest[PI_SHA256_SIZE];
	uint8_t difference = 0;
	enum pi_err err;

	if (!dl->image.open || dl->record.phase != PI_PHASE_DOWNLOADING) {
		return PI_ERR_SD_IO;
	}

	if (dl->received != dl->record.size) {
		return PI_ERR_SIZE_MISMATCH;
	}

	pi_sha256_peek(&dl->hash, digest);
	for (size_t i = 0; i < sizeof(digest); i++) {
		difference |= digest[i] ^ dl->record.sha256[i];
	}

	if (difference != 0) {
		/* What is on the card is not the image. Nothing of it is worth keeping. */
		pi_dl_close(dl);
		(void)pi_sd_remove(PI_SD_IMAGE);
		dl->record.phase = PI_PHASE_NONE;
		dl->record.done = 0;
		pi_sha256_init(&dl->record.hash);
		(void)save_record(&dl->record);
		return PI_ERR_DIGEST_MISMATCH;
	}

	err = pi_sd_sync(&dl->image);
	if (err == PI_OK) {
		err = pi_sd_close(&dl->image);
	}
	if (err != PI_OK) {
		return err;
	}

	dl->record.phase = PI_PHASE_DOWNLOADED;
	dl->record.done = dl->received;
	dl->record.hash = dl->hash;
	return save_record(&dl->record);
}

void pi_dl_close(struct pi_dl *dl)
{
	(void)pi_sd_close(&dl->image);
}

enum pi_err pi_dl_reset(struct pi_dl *dl)
{
	enum pi_err err;

	pi_dl_close(dl);
	err = pi_sd_open(&dl->image, PI_SD_IMAGE, true, true);
	if (err == PI_OK) {
		err = pi_sd_truncate(&dl->image, 0);
	}
	if (err == PI_OK) {
		err = pi_sd_seek(&dl->image, 0);
	}
	if (err != PI_OK) {
		pi_dl_close(dl);
		return err;
	}

	dl->record.phase = PI_PHASE_DOWNLOADING;
	dl->record.done = 0;
	pi_sha256_init(&dl->record.hash);
	dl->hash = dl->record.hash;
	dl->received = 0;
	dl->since_checkpoint = 0;
	return save_record(&dl->record);
}

enum pi_err pi_dl_mark_installed(const uint8_t sha256[PI_SHA256_SIZE], const char *version)
{
	struct pi_record record;
	enum pi_err err = pi_dl_load_record(&record);

	if (err != PI_OK) {
		return err;
	}

	memcpy(record.installed_sha256, sha256, PI_SHA256_SIZE);
	memset(record.installed_version, 0, sizeof(record.installed_version));
	strncpy(record.installed_version, version, sizeof(record.installed_version) - 1);
	return save_record(&record);
}
