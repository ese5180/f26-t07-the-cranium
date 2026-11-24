/*
 * The SD card of a Raspberry Pi delta update: see pi_card.h.
 */

#include "pi_card.h"

#include <string.h>

void pi_card_init(struct pi_card *card, const struct pi_disk_ops *ops, void *ctx)
{
	memset(card, 0, sizeof(*card));
	card->ops = ops;
	card->ctx = ctx;
}

static bool card_present(struct pi_card *card)
{
	return card->ops->present == NULL || card->ops->present(card->ctx);
}

static enum pi_err io_result(struct pi_card *card, int err)
{
	if (err == 0) {
		return PI_OK;
	}
	return card_present(card) ? PI_ERR_SD_IO : PI_ERR_SD_ABSENT;
}

enum pi_err pi_card_read(struct pi_card *card, uint64_t lba, uint8_t *buf, uint32_t count)
{
	int err;

	if (!card->open || count == 0 || lba + count > card->sectors) {
		return card->open ? PI_ERR_SD_IO : io_result(card, -1);
	}
	pi_card_lock(card);
	err = card->ops->read(card->ctx, lba, buf, count);
	pi_card_unlock(card);
	return io_result(card, err);
}

enum pi_err pi_card_write(struct pi_card *card, uint64_t lba, const uint8_t *buf, uint32_t count)
{
	int err;

	if (!card->open || count == 0 || lba + count > card->sectors) {
		return card->open ? PI_ERR_SD_IO : io_result(card, -1);
	}
	pi_card_lock(card);
	err = card->ops->write(card->ctx, lba, buf, count);
	pi_card_unlock(card);
	return io_result(card, err);
}

/* a is later than b, across a wrap of the counter. */
static bool later(uint32_t a, uint32_t b)
{
	return (int32_t)(a - b) > 0;
}

enum pi_err pi_card_read_slot_raw(struct pi_card *card, uint8_t slot, uint8_t raw[PI_MANIFEST_SIZE])
{
	return pi_card_read(card, card->layout.slot_lba[slot & 1], raw, 1);
}

enum pi_err pi_card_write_slot_header(struct pi_card *card, uint8_t slot,
				      const uint8_t raw[PI_MANIFEST_SIZE])
{
	return pi_card_write(card, card->layout.slot_lba[slot & 1], raw, 1);
}

static bool read_header(struct pi_card *card, uint8_t slot, struct pi_manifest *m)
{
	return pi_card_read_slot_raw(card, slot, card->sector) == PI_OK &&
	       pi_manifest_decode(card->sector, m) == PI_OK && m->block_count <= card->st.max_blocks;
}

enum pi_err pi_card_open(struct pi_card *card, uint32_t default_max_blocks)
{
	struct pi_card_state copies[2];
	bool good[2];
	uint64_t sectors = 0;
	enum pi_err result = PI_OK;
	int err;

	card->open = false;
	if (!card_present(card)) {
		return PI_ERR_SD_ABSENT;
	}

	pi_card_lock(card);
	err = card->ops->open(card->ctx, &sectors);
	if (err != 0) {
		result = io_result(card, err);
		goto out;
	}
	card->sectors = sectors;
	if (sectors < (uint64_t)PI_CARD_BASE_LBA + 2) {
		result = PI_ERR_TOO_LARGE;
		goto out;
	}
	/* Open now, for the reads below; closed again if anything fails. */
	card->open = true;

	for (int i = 0; i < 2; i++) {
		enum pi_err read = pi_card_read(card, PI_CARD_BASE_LBA + (uint64_t)i, card->sector, 1);

		if (read != PI_OK) {
			result = read;
			goto out;
		}
		good[i] = pi_card_state_decode(card->sector, &copies[i]);
	}

	if (good[0] && (!good[1] || later(copies[0].seq, copies[1].seq) ||
			copies[0].seq == copies[1].seq)) {
		card->st = copies[0];
		card->copy = 0;
	} else if (good[1]) {
		card->st = copies[1];
		card->copy = 1;
	} else {
		/* A new card, or one this layout does not know: empty, and nothing written yet. */
		memset(&card->st, 0, sizeof(card->st));
		card->st.max_blocks = default_max_blocks;
		card->st.state = PI_STATE_EMPTY;
		card->copy = 1;
	}

	pi_card_layout_for(card->st.max_blocks, &card->layout);
	if (card->layout.mirror_lba >= sectors) {
		result = PI_ERR_TOO_LARGE;
		goto out;
	}

	/*
	 * A slot that the state names but that does not read back as a manifest: the mirror cannot be
	 * trusted without it, so the card counts as empty; an update in progress starts again.
	 */
	if ((card->st.flags & PI_FLAG_HAS_CUR) && !read_header(card, card->st.cur_slot, &card->cur)) {
		card->st.flags = 0;
		card->st.state = PI_STATE_EMPTY;
		card->st.phase = PI_PHASE_NONE;
	}
	if (card->st.phase != PI_PHASE_NONE && !read_header(card, card->st.new_slot, &card->neu)) {
		card->st.phase = PI_PHASE_NONE;
		card->st.next = 0;
		if (card->st.state == PI_STATE_UPDATING) {
			/* Half written, and what to: no longer known. Nothing on it counts. */
			card->st.state = PI_STATE_EMPTY;
			card->st.flags = 0;
		}
	}

out:
	if (result != PI_OK) {
		card->open = false;
	}
	pi_card_unlock(card);
	return result;
}

void pi_card_close(struct pi_card *card)
{
	pi_card_lock(card);
	card->open = false;
	pi_card_unlock(card);
}

enum pi_err pi_card_save(struct pi_card *card)
{
	uint8_t other = card->copy ^ 1u;
	enum pi_err err;

	pi_card_lock(card);
	card->st.seq++;
	pi_card_state_encode(&card->st, card->sector);
	err = pi_card_write(card, card->layout.state_lba[other], card->sector, 1);
	if (err == PI_OK) {
		card->copy = other;
	}
	pi_card_unlock(card);
	return err;
}

uint64_t pi_card_block_lba(const struct pi_card *card, uint32_t block_size, uint32_t block)
{
	return card->layout.mirror_lba + (uint64_t)block * (block_size / PI_SECTOR_SIZE);
}

bool pi_card_fits(const struct pi_card *card, uint64_t image_size)
{
	return card->layout.mirror_lba + image_size / PI_SECTOR_SIZE <= card->sectors;
}
