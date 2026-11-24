/*
 * Raspberry Pi delta update, the engine: see pi_delta.h.
 */

#include "pi_delta.h"

#include <string.h>

#define NO_LBA UINT64_MAX
#define HASHES_PER_SECTOR (PI_SECTOR_SIZE / PI_HASH_SIZE)
#define ENTRIES_PER_SECTOR (PI_SECTOR_SIZE / 4u)

void pi_delta_init(struct pi_delta *d, struct pi_card *card, const struct pi_delta_config *cfg,
		   const struct pi_fetch *fetch, pi_verify_fn verify, const volatile bool *stop)
{
	memset(d, 0, sizeof(*d));
	d->card = card;
	d->cfg = cfg;
	d->fetch = fetch;
	d->verify = verify;
	d->stop = stop;
	d->list_lba = NO_LBA;
	d->table_lba = NO_LBA;
	d->known_good = UINT32_MAX;
}

static bool stopped(const struct pi_delta *d)
{
	return d->stop != NULL && *d->stop;
}

/* Change the state and save it, as one step for the link, which reads the state under the lock. */
static enum pi_err save(struct pi_delta *d)
{
	return pi_card_save(d->card);
}

/* ------------------------------------------------------------------------------------------- */
/* Tables and the list on the card                                                              */

static uint64_t table_lba(const struct pi_delta *d, uint8_t slot, uint32_t block)
{
	return d->card->layout.slot_lba[slot] + 1 + ((uint64_t)block * PI_HASH_SIZE) / PI_SECTOR_SIZE;
}

/* The hash of `block` in slot's table, through a one-sector cache. */
static enum pi_err table_hash(struct pi_delta *d, uint8_t slot, uint32_t block,
			      const uint8_t **hash)
{
	uint64_t lba = table_lba(d, slot, block);

	if (lba != d->table_lba) {
		enum pi_err err = pi_card_read(d->card, lba, d->table, 1);

		if (err != PI_OK) {
			d->table_lba = NO_LBA;
			return err;
		}
		d->table_lba = lba;
	}
	*hash = d->table + (block % HASHES_PER_SECTOR) * PI_HASH_SIZE;
	return PI_OK;
}

/* Which block is candidate k: k itself when every block is checked, otherwise entry k of the list. */
static enum pi_err candidate(struct pi_delta *d, bool all, uint32_t k, uint32_t *block)
{
	uint64_t lba;

	if (all) {
		*block = k;
		return PI_OK;
	}
	lba = d->card->layout.list_lba + k / ENTRIES_PER_SECTOR;
	if (lba != d->list_lba) {
		enum pi_err err = pi_card_read(d->card, lba, d->list, 1);

		if (err != PI_OK) {
			d->list_lba = NO_LBA;
			return err;
		}
		d->list_lba = lba;
	}
	*block = pi_get32(d->list + (k % ENTRIES_PER_SECTOR) * 4u);
	return *block < d->target.block_count ? PI_OK : PI_ERR_SD_IO;
}

/* The SHA-256 of `len` bytes of the card from lba, a sector at a time through io. */
static enum pi_err hash_sectors(struct pi_delta *d, uint64_t lba, uint64_t len,
				uint8_t digest[PI_HASH_SIZE])
{
	pi_sha256_init(&d->sha);
	for (uint64_t done = 0; done < len; done += PI_SECTOR_SIZE) {
		uint64_t take = len - done < PI_SECTOR_SIZE ? len - done : PI_SECTOR_SIZE;
		enum pi_err err = pi_card_read(d->card, lba + done / PI_SECTOR_SIZE, d->io, 1);

		if (err != PI_OK) {
			return err;
		}
		pi_sha256_update(&d->sha, d->io, (size_t)take);
	}
	pi_sha256_final(&d->sha, digest);
	return PI_OK;
}

/* The mirror already holds the new image's block. */
static enum pi_err mirror_matches(struct pi_delta *d, uint32_t block, bool *match)
{
	uint8_t digest[PI_HASH_SIZE];
	const uint8_t *expected;
	enum pi_err err;

	err = hash_sectors(d, pi_card_block_lba(d->card, d->target.block_size, block),
			   pi_manifest_block_len(&d->target, block), digest);
	if (err == PI_OK) {
		err = table_hash(d, d->card->st.new_slot, block, &expected);
	}
	*match = err == PI_OK && memcmp(digest, expected, PI_HASH_SIZE) == 0;
	return err;
}

/* ------------------------------------------------------------------------------------------- */
/* Step 1: the header                                                                           */

static int header_sink(void *ctx, const uint8_t *data, size_t len)
{
	struct pi_delta *d = ctx;
	size_t take = PI_MANIFEST_SIZE - d->run.in_sector;

	if (take > len) {
		take = len;
	}
	memcpy(d->io + d->run.in_sector, data, take);
	d->run.in_sector += (uint32_t)take;
	d->stats.bytes_fetched += take;
	return d->run.in_sector == PI_MANIFEST_SIZE ? 1 : 0;
}

static enum pi_err fetch_header(struct pi_delta *d)
{
	int rc;

	memset(&d->run, 0, sizeof(d->run));
	d->stats.requests++;
	rc = d->fetch->get(d->fetch->ctx, 0, PI_MANIFEST_SIZE, header_sink, d);
	if (stopped(d)) {
		return PI_ERR_ABORTED;
	}
	return rc == 0 && d->run.in_sector == PI_MANIFEST_SIZE ? PI_OK : PI_ERR_DOWNLOAD;
}

/* ------------------------------------------------------------------------------------------- */
/* Step 2: the table                                                                            */

static int table_sink(void *ctx, const uint8_t *data, size_t len)
{
	struct pi_delta *d = ctx;
	struct pi_card *card = d->card;
	uint64_t table_size = pi_manifest_table_size(&d->target);

	while (len > 0) {
		size_t take = PI_SECTOR_SIZE - d->run.in_sector;
		uint64_t left = table_size - d->run.received;
		bool last;

		if (stopped(d)) {
			d->run.err = PI_ERR_ABORTED;
			return -1;
		}
		if (left == 0) {
			return 1;
		}
		if (take > len) {
			take = len;
		}
		if (take > left) {
			take = (size_t)left;
		}
		memcpy(d->io + d->run.in_sector, data, take);
		pi_sha256_update(&d->sha, data, take);
		d->run.in_sector += (uint32_t)take;
		d->run.received += take;
		d->stats.bytes_fetched += take;
		data += take;
		len -= take;

		last = d->run.received == table_size;
		if (d->run.in_sector == PI_SECTOR_SIZE || last) {
			uint64_t sector = (d->run.received - 1) / PI_SECTOR_SIZE;
			enum pi_err err;

			memset(d->io + d->run.in_sector, 0, PI_SECTOR_SIZE - d->run.in_sector);
			err = pi_card_write(card, card->layout.slot_lba[card->st.new_slot] + 1 + sector,
					    d->io, 1);
			if (err != PI_OK) {
				d->run.err = err;
				return -1;
			}
			d->run.in_sector = 0;
			if (!last && (sector + 1) % d->cfg->table_save_every == 0) {
				pi_card_lock(card);
				card->st.next = (uint32_t)d->run.received;
				err = save(d);
				pi_card_unlock(card);
				if (err != PI_OK) {
					d->run.err = err;
					return -1;
				}
			}
		}
	}
	return d->run.received == table_size ? 1 : 0;
}

static enum pi_err fetch_table(struct pi_delta *d)
{
	struct pi_card *card = d->card;
	uint64_t table_size = pi_manifest_table_size(&d->target);
	uint64_t stored = card->st.next;
	uint8_t digest[PI_HASH_SIZE];
	enum pi_err err;

	d->step = PI_STEP_TABLE;
	/* What a checkpoint saved is whole sectors of the table, and no more than all of it. */
	if (stored % PI_SECTOR_SIZE != 0 || stored > table_size) {
		stored = 0;
	}

	/* Hash what is on the card already, then fetch the rest. */
	memset(&d->run, 0, sizeof(d->run));
	pi_sha256_init(&d->sha);
	for (uint64_t done = 0; done < stored; done += PI_SECTOR_SIZE) {
		uint64_t take = stored - done < PI_SECTOR_SIZE ? stored - done : PI_SECTOR_SIZE;

		err = pi_card_read(card,
				   card->layout.slot_lba[card->st.new_slot] + 1 + done / PI_SECTOR_SIZE,
				   d->io, 1);
		if (err != PI_OK) {
			return err;
		}
		pi_sha256_update(&d->sha, d->io, (size_t)take);
	}
	d->run.received = stored;

	if (stored < table_size) {
		int rc;

		d->stats.requests++;
		rc = d->fetch->get(d->fetch->ctx, d->target.table_offset + stored, table_size - stored,
				   table_sink, d);
		if (d->run.err != PI_OK) {
			return d->run.err;
		}
		if (stopped(d)) {
			return PI_ERR_ABORTED;
		}
		if (rc != 0 || d->run.received != table_size) {
			/* Keep what arrived, as far as the last whole sector on the card. */
			pi_card_lock(card);
			card->st.next = (uint32_t)(d->run.received / PI_SECTOR_SIZE * PI_SECTOR_SIZE);
			err = save(d);
			pi_card_unlock(card);
			return err != PI_OK ? err : PI_ERR_DOWNLOAD;
		}
	}

	pi_sha256_final(&d->sha, digest);
	if (memcmp(digest, d->target.table_sha256, PI_HASH_SIZE) != 0) {
		/* Not the table the header signs: start it again next time. */
		pi_card_lock(card);
		card->st.next = 0;
		err = save(d);
		pi_card_unlock(card);
		return err != PI_OK ? err : PI_ERR_MANIFEST_MISMATCH;
	}

	/* All of it is on the card: a restart from here compares again without fetching. */
	if (card->st.next != (uint32_t)table_size) {
		pi_card_lock(card);
		card->st.next = (uint32_t)table_size;
		err = save(d);
		pi_card_unlock(card);
		if (err != PI_OK) {
			return err;
		}
	}
	return PI_OK;
}

/* ------------------------------------------------------------------------------------------- */
/* Step 3: the comparison                                                                       */

static enum pi_err list_flush(struct pi_delta *d, uint32_t count)
{
	uint32_t in_sector = count % ENTRIES_PER_SECTOR;
	uint64_t lba = d->card->layout.list_lba + (count - 1) / ENTRIES_PER_SECTOR;

	if (in_sector != 0) {
		memset(d->list + in_sector * 4u, 0xff, PI_SECTOR_SIZE - in_sector * 4u);
	}
	return pi_card_write(d->card, lba, d->list, 1);
}

static enum pi_err compare(struct pi_delta *d)
{
	struct pi_card *card = d->card;
	struct pi_card_state *st = &card->st;
	bool have_cur = (st->flags & PI_FLAG_HAS_CUR) != 0;
	bool all = !have_cur || card->cur.block_size != d->target.block_size;
	uint32_t count = 0;
	enum pi_err err;

	d->step = PI_STEP_COMPARE;
	d->list_lba = NO_LBA;
	d->table_lba = NO_LBA;

	for (uint32_t block = 0; block < d->target.block_count; block++) {
		uint32_t slot_index = block % HASHES_PER_SECTOR;
		bool changed = true;

		if (slot_index == 0 && !all) {
			/* The next sector of each table: the new one in io, the current one in table. */
			err = pi_card_read(card, table_lba(d, st->new_slot, block), d->io, 1);
			if (err == PI_OK && block < card->cur.block_count) {
				err = pi_card_read(card, table_lba(d, st->cur_slot, block), d->table, 1);
			}
			if (err != PI_OK) {
				return err;
			}
		}
		if (!all && block < card->cur.block_count) {
			changed = memcmp(d->io + slot_index * PI_HASH_SIZE,
					 d->table + slot_index * PI_HASH_SIZE, PI_HASH_SIZE) != 0;
		}
		if (!changed) {
			continue;
		}
		pi_put32(d->list + (count % ENTRIES_PER_SECTOR) * 4u, block);
		count++;
		if (count % ENTRIES_PER_SECTOR == 0) {
			err = list_flush(d, count);
			if (err != PI_OK) {
				return err;
			}
		}
		if (stopped(d)) {
			return PI_ERR_ABORTED;
		}
	}
	if (count % ENTRIES_PER_SECTOR != 0) {
		err = list_flush(d, count);
		if (err != PI_OK) {
			return err;
		}
	}
	d->table_lba = NO_LBA;
	d->list_lba = NO_LBA;
	d->stats.changed = count;

	/* From here the mirror changes: the Pi must not take it. */
	pi_card_lock(card);
	st->changed_count = count;
	st->state = PI_STATE_UPDATING;
	st->phase = PI_PHASE_BLOCKS;
	st->next = 0;
	if (have_cur) {
		memcpy(st->base_version, card->cur.version, sizeof(st->base_version));
		memcpy(st->base_sha256, card->cur.image_sha256, PI_HASH_SIZE);
	} else {
		memset(st->base_version, 0, sizeof(st->base_version));
		memset(st->base_sha256, 0, PI_HASH_SIZE);
	}
	err = save(d);
	pi_card_unlock(card);
	return err;
}

/* ------------------------------------------------------------------------------------------- */
/* Step 4: the blocks                                                                           */

/* The staging block, checked, into the mirror, then read back from the mirror and checked again. */
static enum pi_err copy_to_mirror(struct pi_delta *d, uint32_t block, const uint8_t *expected)
{
	struct pi_card *card = d->card;
	uint32_t len = pi_manifest_block_len(&d->target, block);
	uint64_t mirror = pi_card_block_lba(card, d->target.block_size, block);
	uint8_t digest[PI_HASH_SIZE];
	uint8_t want[PI_HASH_SIZE];
	enum pi_err err;

	/* hash_sectors() goes through io, and expected may point into the table's cache. */
	memcpy(want, expected, PI_HASH_SIZE);
	for (uint32_t s = 0; s < len / PI_SECTOR_SIZE; s++) {
		err = pi_card_read(card, card->layout.staging_lba + s, d->io, 1);
		if (err == PI_OK) {
			err = pi_card_write(card, mirror + s, d->io, 1);
		}
		if (err != PI_OK) {
			return err;
		}
	}
	err = hash_sectors(d, mirror, len, digest);
	if (err != PI_OK) {
		return err;
	}
	return memcmp(digest, want, PI_HASH_SIZE) == 0 ? PI_OK : PI_ERR_SD_READBACK;
}

static int block_sink(void *ctx, const uint8_t *data, size_t len)
{
	struct pi_delta *d = ctx;
	struct pi_card *card = d->card;
	struct pi_delta_run_state *run = &d->run;

	while (len > 0) {
		uint32_t block = run->first_block + run->index;
		uint32_t block_len = pi_manifest_block_len(&d->target, block);
		size_t take = PI_SECTOR_SIZE - run->in_sector;
		enum pi_err err;

		if (stopped(d)) {
			run->err = PI_ERR_ABORTED;
			return -1;
		}
		if (run->index == run->count) {
			return 1;
		}
		if (take > len) {
			take = len;
		}
		memcpy(d->io + run->in_sector, data, take);
		pi_sha256_update(&d->sha, data, take);
		run->in_sector += (uint32_t)take;
		run->in_block += (uint32_t)take;
		run->received += take;
		d->stats.bytes_fetched += take;
		data += take;
		len -= take;

		if (run->in_sector < PI_SECTOR_SIZE) {
			continue;
		}
		err = pi_card_write(card, card->layout.staging_lba + (run->in_block - 1) / PI_SECTOR_SIZE,
				    d->io, 1);
		if (err != PI_OK) {
			run->err = err;
			return -1;
		}
		run->in_sector = 0;

		if (run->in_block == block_len) {
			uint8_t digest[PI_HASH_SIZE];
			const uint8_t *expected;

			pi_sha256_final(&d->sha, digest);
			err = table_hash(d, card->st.new_slot, block, &expected);
			if (err == PI_OK && memcmp(digest, expected, PI_HASH_SIZE) != 0) {
				/* Not what the signed table says: the mirror is not touched. */
				err = PI_ERR_DIGEST_MISMATCH;
			}
			if (err == PI_OK) {
				err = copy_to_mirror(d, block, expected);
			}
			if (err == PI_OK) {
				pi_card_lock(card);
				card->st.next = run->first_k + run->index + 1;
				err = save(d);
				pi_card_unlock(card);
			}
			if (err != PI_OK) {
				run->err = err;
				return -1;
			}
			d->stats.blocks_fetched++;
			d->stats.blocks_done = card->st.next;
			run->index++;
			run->in_block = 0;
			pi_sha256_init(&d->sha);
		}
	}
	return run->index == run->count ? 1 : 0;
}

static enum pi_err fetch_run(struct pi_delta *d, uint32_t k, uint32_t block, uint32_t count)
{
	uint64_t offset = d->target.image_offset + (uint64_t)block * d->target.block_size;
	uint64_t len = (uint64_t)(count - 1) * d->target.block_size +
		       pi_manifest_block_len(&d->target, block + count - 1);
	int rc;

	memset(&d->run, 0, sizeof(d->run));
	d->run.first_k = k;
	d->run.first_block = block;
	d->run.count = count;
	d->run.wanted = len;
	pi_sha256_init(&d->sha);
	d->stats.requests++;
	rc = d->fetch->get(d->fetch->ctx, offset, len, block_sink, d);
	if (d->run.err != PI_OK) {
		return d->run.err;
	}
	if (stopped(d)) {
		return PI_ERR_ABORTED;
	}
	return rc == 0 && d->run.index == count ? PI_OK : PI_ERR_DOWNLOAD;
}

static enum pi_err save_next(struct pi_delta *d, uint32_t k)
{
	enum pi_err err;

	pi_card_lock(d->card);
	d->card->st.next = k;
	err = save(d);
	pi_card_unlock(d->card);
	return err;
}

static enum pi_err update_blocks(struct pi_delta *d)
{
	struct pi_card *card = d->card;
	struct pi_card_state *st = &card->st;
	bool all = (st->flags & PI_FLAG_DIRTY) || !(st->flags & PI_FLAG_HAS_CUR);
	uint32_t total = all ? d->target.block_count : st->changed_count;
	uint32_t k = st->next;
	uint32_t unsaved = 0;
	uint32_t attempts = 0;
	enum pi_err err;

	d->step = PI_STEP_BLOCKS;
	d->stats.blocks_total = total;
	d->stats.changed = st->changed_count;
	d->list_lba = NO_LBA;
	d->table_lba = NO_LBA;
	d->known_good = UINT32_MAX;

	while (k < total) {
		uint32_t block;
		uint32_t count = 1;
		bool match;

		d->stats.blocks_done = k;
		if (stopped(d)) {
			(void)save_next(d, k);
			return PI_ERR_ABORTED;
		}
		err = candidate(d, all, k, &block);
		if (err != PI_OK) {
			return err;
		}
		if (block == d->known_good) {
			match = true;
		} else {
			err = mirror_matches(d, block, &match);
			if (err != PI_OK) {
				return err;
			}
		}
		if (match) {
			d->stats.blocks_skipped++;
			k++;
			if (++unsaved >= d->cfg->skip_save_every) {
				err = save_next(d, k);
				if (err != PI_OK) {
					return err;
				}
				unsaved = 0;
			}
			continue;
		}

		/* A run of neighbours that are not in place either: one range request. */
		while (count < d->cfg->run_blocks && k + count < total) {
			uint32_t neighbour;
			bool in_place;

			err = candidate(d, all, k + count, &neighbour);
			if (err != PI_OK) {
				return err;
			}
			if (neighbour != block + count) {
				break;
			}
			err = mirror_matches(d, neighbour, &in_place);
			if (err != PI_OK) {
				return err;
			}
			if (in_place) {
				d->known_good = neighbour;
				break;
			}
			count++;
		}
		if (unsaved > 0) {
			/* So that a restart does not hash the blocks found in place again. */
			err = save_next(d, k);
			if (err != PI_OK) {
				return err;
			}
			unsaved = 0;
		}

		err = fetch_run(d, k, block, count);
		if (err == PI_ERR_DIGEST_MISMATCH || err == PI_ERR_SD_READBACK) {
			/* The blocks before it in the run are done; this one is tried again. */
			if (++attempts >= d->cfg->block_attempts) {
				return err;
			}
		} else if (err != PI_OK) {
			return err;
		} else {
			attempts = 0;
		}
		k = st->next;
	}
	d->stats.blocks_done = total;

	/* Step 5: the new image is the current one. */
	pi_card_lock(card);
	st->state = PI_STATE_READY;
	st->cur_slot = st->new_slot;
	st->phase = PI_PHASE_NONE;
	st->flags = PI_FLAG_HAS_CUR | PI_FLAG_LIST_VALID;
	st->generation++;
	st->next = 0;
	card->cur = d->target;
	err = save(d);
	pi_card_unlock(card);
	return err;
}

/* ------------------------------------------------------------------------------------------- */

static bool job_is(const struct pi_manifest *m, const struct pi_delta_job *job)
{
	return strncmp(m->version, job->version, sizeof(m->version)) == 0 &&
	       memcmp(m->image_sha256, job->sha256, PI_HASH_SIZE) == 0;
}

enum pi_err pi_delta_run(struct pi_delta *d, const struct pi_delta_job *job, bool *already)
{
	struct pi_card *card = d->card;
	struct pi_card_state *st = &card->st;
	bool resume = false;
	enum pi_err err;

	*already = false;
	memset(&d->stats, 0, sizeof(d->stats));
	d->step = PI_STEP_MANIFEST;
	d->list_lba = NO_LBA;
	d->table_lba = NO_LBA;

	err = pi_card_open(card, d->cfg->default_max_blocks);
	if (err != PI_OK) {
		return err;
	}
	if (st->state == PI_STATE_READY && job_is(&card->cur, job)) {
		*already = true;
		d->step = PI_STEP_DONE;
		return PI_OK;
	}

	/* 1. The header: fetched, read, its signature checked, and held against the job. */
	err = fetch_header(d);
	if (err != PI_OK) {
		return err;
	}
	err = pi_manifest_decode(d->io, &d->target);
	if (err != PI_OK) {
		return err;
	}
	if (d->verify == NULL || !d->verify(d->io, PI_MANIFEST_SIGNED_SIZE, d->target.sig)) {
		return PI_ERR_BAD_SIGNATURE;
	}
	if (!job_is(&d->target, job)) {
		return PI_ERR_MANIFEST_MISMATCH;
	}
	if (d->target.block_count > st->max_blocks || !pi_card_fits(card, d->target.image_size)) {
		return PI_ERR_TOO_LARGE;
	}

	/* The same update as the one the card is in the middle of: go on with it. */
	if (st->phase != PI_PHASE_NONE) {
		err = pi_card_read_slot_raw(card, st->new_slot, d->table);
		if (err != PI_OK) {
			return err;
		}
		resume = memcmp(d->table, d->io, PI_MANIFEST_SIZE) == 0;
	}
	if (!resume) {
		uint8_t slot = (st->flags & PI_FLAG_HAS_CUR) ? (uint8_t)(st->cur_slot ^ 1u) : 0u;

		/*
		 * The state first: from here a restart fetches the table again from its start, so the
		 * header written next never meets another update's table, list and progress.
		 */
		pi_card_lock(card);
		if (st->state == PI_STATE_UPDATING) {
			/* Half way to another image: what the mirror holds is a mix. */
			st->flags |= PI_FLAG_DIRTY;
		}
		st->new_slot = slot;
		st->phase = PI_PHASE_TABLE;
		st->next = 0;
		st->flags &= (uint8_t)~PI_FLAG_LIST_VALID;
		card->neu = d->target;
		err = save(d);
		pi_card_unlock(card);
		if (err == PI_OK) {
			err = pi_card_write_slot_header(card, slot, d->io);
		}
		if (err != PI_OK) {
			return err;
		}
	}
	card->neu = d->target;

	if (st->phase == PI_PHASE_TABLE) {
		err = fetch_table(d);
		if (err == PI_OK) {
			err = compare(d);
		}
		if (err != PI_OK) {
			return err;
		}
	}

	err = update_blocks(d);
	if (err == PI_OK) {
		d->step = PI_STEP_DONE;
	}
	return err;
}
