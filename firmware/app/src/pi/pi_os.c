/*
 * Raspberry Pi OS updates with A/B slots and tryboot, the board's side: see pi_os.h.
 *
 * The file's header on the card is changed as a raw sector (pi_card_file_load() and _store()), so
 * that no decoded copy of it sits on the thread's stack while TLS runs below it: take() and verify(),
 * which hold a decoded header and a SHA-256 state, are kept out of line, so their frames are gone
 * before the download starts. Three moments change it, each saved before what it allows:
 *
 *   take       a new file: "downloading", the next generation, nothing on the card yet; or the same
 *              file for another job: the next generation, no result
 *   progress   every cfg->save_every sectors, and when a transfer ends: the bytes on the card
 *   checked    "ready", once the bytes read back from the card hash to the job's SHA-256; or, if
 *              they do not, nothing on the card, and the download again
 *
 * A sector is always written before a save counts it, so a power cut at any write costs at most
 * cfg->save_every sectors, and never leaves the card claiming bytes it does not hold.
 */

#include "pi_os.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

#include "pi_sha256.h"

void pi_os_init(struct pi_os *os, struct pi_card *card, const struct pi_os_config *cfg,
		const struct pi_fetch *fetch, uint8_t *io, const volatile bool *stop)
{
	memset(os, 0, sizeof(*os));
	os->card = card;
	os->cfg = cfg;
	os->fetch = fetch;
	os->io = io;
	os->stop = stop;
}

static bool stopped(const struct pi_os *os)
{
	return os->stop != NULL && *os->stop;
}

static const char *const steps[] = { "idle", "download", "verify", "ready" };

const char *pi_os_step_name(uint8_t step)
{
	return step < sizeof(steps) / sizeof(steps[0]) ? steps[step] : "idle";
}

/* Where a file of size bytes goes: at the end of the card, on a 1 MiB boundary, past the mirror. */
static enum pi_err place(const struct pi_card *card, uint32_t size, uint64_t *lba)
{
	uint64_t sectors = ((uint64_t)size + PI_SECTOR_SIZE - 1) / PI_SECTOR_SIZE;
	uint64_t floor = (pi_card_mirror_end(card) + PI_CARD_ALIGN - 1) / PI_CARD_ALIGN * PI_CARD_ALIGN;

	if (sectors > card->sectors) {
		return PI_ERR_TOO_LARGE;
	}
	*lba = (card->sectors - sectors) / PI_CARD_ALIGN * PI_CARD_ALIGN;
	return *lba >= floor ? PI_OK : PI_ERR_TOO_LARGE;
}

static bool same_file(const struct pi_file_header *h, const struct pi_os_job *job)
{
	return h->size == job->size && memcmp(h->sha256, job->sha256, PI_HASH_SIZE) == 0 &&
	       memcmp(h->version, job->version, PI_VERSION_MAX + 1) == 0 &&
	       memcmp(h->from, job->from, PI_VERSION_MAX + 1) == 0;
}

/*
 * The file area for this job: the file it holds already (offered anew, under the next generation,
 * if another job took it), or a new one, placed, "downloading", with nothing counted on the card.
 */
__attribute__((noinline)) static enum pi_err take(struct pi_os *os, const struct pi_os_job *job)
{
	struct pi_card *card = os->card;
	struct pi_file_header h;
	enum pi_err err;

	if (card->file.state != PI_FILE_NONE) {
		err = pi_card_file_load(card, os->io);
		if (err != PI_OK) {
			return err;
		}
		(void)pi_file_header_decode(os->io, &h);
		if (same_file(&h, job)) {
			if (h.job == job->tag) {
				/* This job's, after a restart or a fresh URL: as it is. */
				return PI_OK;
			}
			h.job = job->tag;
			h.generation = card->file.generation + 1;
			h.result = PI_OS_NONE;
			memset(h.reason, 0, sizeof(h.reason));
			pi_file_header_encode(&h, os->io);
			return pi_card_file_store(card, os->io);
		}
	}

	memset(&h, 0, sizeof(h));
	err = place(card, job->size, &h.lba);
	if (err != PI_OK) {
		return err;
	}
	h.state = PI_FILE_DOWNLOADING;
	h.generation = card->file.generation + 1;
	h.size = job->size;
	h.job = job->tag;
	memcpy(h.sha256, job->sha256, PI_HASH_SIZE);
	memcpy(h.version, job->version, PI_VERSION_MAX + 1);
	memcpy(h.from, job->from, PI_VERSION_MAX + 1);
	pi_file_header_encode(&h, os->io);
	return pi_card_file_store(card, os->io);
}

/* The bytes on the card into the header. io is free: no partial sector is kept past a save. */
static enum pi_err save_done(struct pi_os *os)
{
	struct pi_card *card = os->card;
	enum pi_err err;

	pi_card_lock(card);
	err = pi_card_file_load(card, os->io);
	if (err == PI_OK) {
		pi_put32(os->io + PI_FILE_AT_DONE, os->done);
		err = pi_card_file_store(card, os->io);
	}
	pi_card_unlock(card);
	os->unsaved = 0;
	return err;
}

/* The download's bytes, in order: a sector at a time onto the card, the last one padded. */
static int sink(void *ctx, const uint8_t *data, size_t len)
{
	struct pi_os *os = ctx;
	struct pi_card *card = os->card;

	while (len > 0) {
		uint32_t left;
		size_t take;
		enum pi_err err;

		if (stopped(os)) {
			os->err = (uint8_t)PI_ERR_ABORTED;
			return -1;
		}
		if (os->done >= os->size) {
			/* More than was asked for. */
			os->err = (uint8_t)PI_ERR_DOWNLOAD;
			return -1;
		}
		left = os->size - os->done - os->fill;
		take = PI_SECTOR_SIZE - os->fill;
		take = take < len ? take : len;
		take = take < left ? take : left;
		memcpy(os->io + os->fill, data, take);
		os->fill += (uint16_t)take;
		os->bytes_fetched += take;
		data += take;
		len -= take;

		if (os->fill == PI_SECTOR_SIZE || os->done + os->fill == os->size) {
			memset(os->io + os->fill, 0, PI_SECTOR_SIZE - os->fill);
			err = pi_card_write(card, card->file.lba + os->done / PI_SECTOR_SIZE, os->io, 1);
			if (err != PI_OK) {
				os->err = (uint8_t)err;
				return -1;
			}
			os->done += os->fill;
			os->fill = 0;
			if (++os->unsaved >= os->cfg->save_every || os->done == os->size) {
				err = save_done(os);
				if (err != PI_OK) {
					os->err = (uint8_t)err;
					return -1;
				}
			}
		}
	}
	return os->done == os->size ? 1 : 0;
}

/* The rest of the file, in one range from the first byte the card does not hold. */
static enum pi_err download(struct pi_os *os)
{
	struct pi_card *card = os->card;
	int rc;

	/* card->file.lba and .size hold still while the download runs: only this thread takes a file. */
	os->size = card->file.size;
	os->done = card->file.done;
	os->fill = 0;
	os->unsaved = 0;
	os->err = (uint8_t)PI_OK;
	if (stopped(os)) {
		return PI_ERR_ABORTED;
	}
	rc = os->fetch->get(os->fetch->ctx, os->done, (uint64_t)(os->size - os->done), sink, os);
	if (os->unsaved > 0 && os->err != PI_ERR_SD_IO && os->err != PI_ERR_SD_ABSENT) {
		/* What reached the card counts, whatever stopped the transfer: the next call goes on. */
		enum pi_err saved = save_done(os);

		if (saved != PI_OK && os->err == PI_OK) {
			os->err = (uint8_t)saved;
		}
	}
	if (os->err != PI_OK) {
		return (enum pi_err)os->err;
	}
	if (rc != 0) {
		return stopped(os) ? PI_ERR_ABORTED : PI_ERR_DOWNLOAD;
	}
	return os->done == os->size ? PI_OK : PI_ERR_DOWNLOAD;
}

/*
 * The file as the card holds it, hashed: "ready" if that is the job's SHA-256. If not, nothing on
 * the card counts any more, and PI_ERR_DIGEST_MISMATCH.
 */
__attribute__((noinline)) static enum pi_err verify(struct pi_os *os,
						   const uint8_t want[PI_HASH_SIZE])
{
	struct pi_card *card = os->card;
	struct pi_sha256 sha;
	uint8_t digest[PI_HASH_SIZE];
	uint64_t lba = card->file.lba;
	uint64_t size = card->file.size;
	bool match;
	enum pi_err err;

	os->done = 0;
	pi_sha256_init(&sha);
	for (uint64_t at = 0; at < size; at += PI_SECTOR_SIZE) {
		uint64_t n = size - at < PI_SECTOR_SIZE ? size - at : PI_SECTOR_SIZE;

		if (stopped(os)) {
			return PI_ERR_ABORTED;
		}
		err = pi_card_read(card, lba + at / PI_SECTOR_SIZE, os->io, 1);
		if (err != PI_OK) {
			return err;
		}
		pi_sha256_update(&sha, os->io, (size_t)n);
		os->done = (uint32_t)(at + n);
	}
	pi_sha256_final(&sha, digest);
	match = memcmp(digest, want, PI_HASH_SIZE) == 0;

	pi_card_lock(card);
	err = pi_card_file_load(card, os->io);
	if (err == PI_OK) {
		if (match) {
			os->io[PI_FILE_AT_STATE] = PI_FILE_READY;
		} else {
			pi_put32(os->io + PI_FILE_AT_DONE, 0);
		}
		err = pi_card_file_store(card, os->io);
	}
	pi_card_unlock(card);
	if (err != PI_OK) {
		return err;
	}
	return match ? PI_OK : PI_ERR_DIGEST_MISMATCH;
}

enum pi_err pi_os_run(struct pi_os *os, const struct pi_os_job *job)
{
	struct pi_card *card = os->card;
	uint32_t wrong = 0;
	enum pi_err err;

	os->step = PI_OS_STEP_DOWNLOAD;
	os->done = 0;
	os->size = job->size;

	err = pi_card_open(card, os->cfg->default_max_blocks);
	if (err != PI_OK) {
		return err;
	}
	err = take(os, job);
	if (err != PI_OK) {
		return err;
	}
	os->generation = card->file.generation;
	while (card->file.state == PI_FILE_DOWNLOADING) {
		if (card->file.done < card->file.size) {
			os->step = PI_OS_STEP_DOWNLOAD;
			err = download(os);
			if (err != PI_OK) {
				return err;
			}
		}
		os->step = PI_OS_STEP_VERIFY;
		err = verify(os, job->sha256);
		if (err == PI_ERR_DIGEST_MISMATCH && ++wrong < os->cfg->attempts) {
			continue;
		}
		if (err != PI_OK) {
			return err;
		}
	}
	os->done = card->file.size;
	os->step = PI_OS_STEP_READY;
	return PI_OK;
}

/* ------------------------------------------------------------------------------------------- */
/* The job, once the file is offered                                                            */

bool pi_os_pi_runs(const struct pi_card *card, const char *version)
{
	return card->os.known && !card->os.trial && card->os.version[0] != '\0' &&
	       strncmp(card->os.version, version, PI_VERSION_MAX + 1) == 0;
}

enum pi_os_watch pi_os_watch(const struct pi_card *card, const struct pi_os_job *job,
			     uint32_t generation)
{
	const struct pi_card_file *f = &card->file;

	if (pi_os_pi_runs(card, job->version)) {
		return PI_OS_SUCCEEDED;
	}
	if (!card->open) {
		return PI_OS_WAIT_CARD;
	}
	if (f->generation != generation || f->state != PI_FILE_READY) {
		return PI_OS_LOST;
	}
	switch (f->result) {
	case PI_OS_CONFIRMED:
		return PI_OS_SUCCEEDED;
	case PI_OS_ROLLED_BACK:
	case PI_OS_REFUSED:
		return PI_OS_FAILED;
	case PI_OS_APPLIED:
		return PI_OS_ON_TRIAL;
	default:
		return f->read > 0 ? PI_OS_FETCHED : PI_OS_OFFERED;
	}
}

static const char *const watches[] = {
	[PI_OS_WAIT_CARD] = "offered", [PI_OS_LOST] = "offered", [PI_OS_OFFERED] = "offered",
	[PI_OS_FETCHED] = "fetched",   [PI_OS_ON_TRIAL] = "applied", [PI_OS_SUCCEEDED] = "result",
	[PI_OS_FAILED] = "result",
};

const char *pi_os_watch_name(uint8_t watch)
{
	return watch < sizeof(watches) / sizeof(watches[0]) ? watches[watch] : "offered";
}

static int written(int n, size_t len)
{
	return n < 0 || (size_t)n >= len ? -ENOSPC : n;
}

int pi_os_details_progress(char *buf, size_t len, const char *step, uint32_t done, uint32_t total)
{
	done = done < total ? done : total;
	return written(snprintf(buf, len,
				"\"step\":\"%s\",\"progress\":\"%u\",\"done\":\"%u\",\"total\":\"%u\"",
				step, total == 0 ? 0u : (unsigned int)(100ull * done / total),
				(unsigned int)done, (unsigned int)total),
		       len);
}

int pi_os_details_offer(char *buf, size_t len, uint8_t watch, uint32_t generation, uint32_t read,
			uint32_t total)
{
	return written(snprintf(buf, len,
				"\"step\":\"%s\",\"generation\":\"%u\",\"read\":\"%u\",\"total\":\"%u\"",
				pi_os_watch_name(watch), (unsigned int)generation,
				(unsigned int)(read < total ? read : total), (unsigned int)total),
		       len);
}

int pi_os_details_succeeded(char *buf, size_t len, const char *version, uint32_t generation,
			    uint64_t bytes, uint32_t read, const char *running)
{
	return written(snprintf(buf, len,
				"\"pi_version\":\"%s\",\"generation\":\"%u\",\"bytes\":\"%llu\","
				"\"read\":\"%u\",\"running\":\"%s\"",
				version, (unsigned int)generation, (unsigned long long)bytes,
				(unsigned int)read, running),
		       len);
}

int pi_os_details_failed(char *buf, size_t len, uint8_t result, const char *reason,
			 const char *running)
{
	char clean[PI_OS_REASON_MAX + 1];

	/* card->file.reason is clean already; this keeps the JSON whole whatever it is given. */
	strncpy(clean, reason, sizeof(clean) - 1);
	clean[sizeof(clean) - 1] = '\0';
	pi_os_clean_text(clean, sizeof(clean));
	return written(snprintf(buf, len,
				"\"reason\":\"%s\",\"pi_reason\":\"%s\",\"step\":\"result\",\"running\":\"%s\"",
				pi_os_result_name(result), clean, running),
		       len);
}
