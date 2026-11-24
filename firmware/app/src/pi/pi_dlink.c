/*
 * Raspberry Pi delta updates, the board's end of the Pi's SPI link: see pi_dlink.h.
 */

#include "pi_dlink.h"

#include <string.h>

void pi_dlink_init(struct pi_dlink *link, struct pi_card *card)
{
	memset(link, 0, sizeof(*link));
	link->card = card;
}

/* The answer's header and CRC around a payload already in place at tx + PI_FRAME_HEADER. */
static void seal(uint8_t *tx, uint8_t type, const struct pi_frame *request, uint16_t length)
{
	uint32_t crc;

	tx[0] = 'C';
	tx[1] = 'L';
	tx[2] = PI_FRAME_VERSION;
	tx[3] = type;
	pi_put16(tx + 4, request != NULL ? request->session : 0);
	pi_put16(tx + 6, 0);
	pi_put16(tx + 8, request != NULL ? request->seq : 0);
	pi_put16(tx + 10, length);
	crc = pi_crc32(tx, PI_FRAME_HEADER + (size_t)length);
	pi_put32(tx + PI_FRAME_HEADER + length, crc);
}

static uint8_t *payload_of(uint8_t *tx)
{
	return tx + PI_FRAME_HEADER;
}

static void answer_error(struct pi_dlink *link, uint8_t *tx, const struct pi_frame *request,
			 uint8_t code)
{
	uint8_t *p = payload_of(tx);
	const struct pi_card_state *st = &link->card->st;

	link->errors++;
	memset(p, 0, 12);
	p[0] = code;
	p[1] = link->card->open ? st->state : PI_STATE_EMPTY;
	pi_put32(p + 4, link->card->open ? st->generation : 0);
	p[8] = request != NULL ? request->type : 0;
	seal(tx, PI_DLINK_ERROR, request, 12);
}

/* The mirror may be read: a card that is open and ready. Otherwise the code to refuse with. */
static uint8_t readable(const struct pi_dlink *link)
{
	const struct pi_card *card = link->card;

	if (!card->open) {
		return PI_DLINK_CARD;
	}
	if (card->st.state == PI_STATE_UPDATING) {
		return PI_DLINK_UPDATING;
	}
	if (card->st.state != PI_STATE_READY) {
		return PI_DLINK_NO_IMAGE;
	}
	return PI_DLINK_OK;
}

static uint8_t info(struct pi_dlink *link, uint8_t *p)
{
	const struct pi_card *card = link->card;
	const struct pi_card_state *st = &card->st;
	const struct pi_manifest *m = NULL;
	uint8_t flags = 0;

	memset(p, 0, PI_DLINK_INFO_SIZE);
	pi_put16(p, PI_DLINK_VERSION);
	if (!card->open) {
		p[3] = PI_DLINK_INFO_NO_CARD;
		return PI_DLINK_OK;
	}
	p[2] = st->state;
	pi_put32(p + 4, st->generation);
	if (st->state == PI_STATE_READY) {
		m = &card->cur;
		if (st->flags & PI_FLAG_LIST_VALID) {
			flags |= PI_DLINK_INFO_LIST;
			pi_put32(p + 120, st->changed_count);
		}
		if (st->phase == PI_PHASE_TABLE) {
			flags |= PI_DLINK_INFO_PREPARING;
		}
	} else if (st->state == PI_STATE_UPDATING) {
		bool all = (st->flags & PI_FLAG_DIRTY) || !(st->flags & PI_FLAG_HAS_CUR);

		m = &card->neu;
		if (st->phase == PI_PHASE_BLOCKS) {
			pi_put32(p + 188, st->next);
			pi_put32(p + 192, all ? card->neu.block_count : st->changed_count);
		}
	} else if (st->phase == PI_PHASE_TABLE) {
		flags |= PI_DLINK_INFO_PREPARING;
	}
	p[3] = flags;
	if (m != NULL) {
		pi_put32(p + 8, m->block_size);
		pi_put32(p + 12, m->block_count);
		pi_put64(p + 16, m->image_size);
		memcpy(p + 24, m->image_sha256, PI_HASH_SIZE);
		memcpy(p + 56, m->table_sha256, PI_HASH_SIZE);
		memcpy(p + 88, m->version, PI_VERSION_MAX + 1);
	}
	if (st->state != PI_STATE_EMPTY) {
		memcpy(p + 124, st->base_version, PI_VERSION_MAX + 1);
		memcpy(p + 156, st->base_sha256, PI_HASH_SIZE);
	}
	return PI_DLINK_OK;
}

static uint8_t manifest(struct pi_dlink *link, const uint8_t *req, uint8_t *p, uint16_t *length)
{
	struct pi_card *card = link->card;
	uint32_t first = pi_get32(req);
	uint32_t count = pi_get16(req + 4);
	uint8_t code = readable(link);
	uint64_t lba = UINT64_MAX;
	/* The mirror's cache holds the sector: it is a mirror sector no longer. */
	uint8_t *sector = link->cache;

	if (code != PI_DLINK_OK) {
		return code;
	}
	if (first >= card->cur.block_count) {
		return PI_DLINK_OUT_OF_RANGE;
	}
	if (count > card->cur.block_count - first) {
		count = card->cur.block_count - first;
	}
	memset(p, 0, PI_DLINK_ANSWER_HEAD);
	pi_put32(p, card->st.generation);
	pi_put32(p + 4, first);
	pi_put16(p + 8, (uint16_t)count);
	for (uint32_t i = 0; i < count; i++) {
		uint64_t at = (uint64_t)(first + i) * PI_HASH_SIZE;
		uint64_t want = card->layout.slot_lba[card->st.cur_slot] + 1 + at / PI_SECTOR_SIZE;

		if (want != lba) {
			link->cache_valid = false;
			if (pi_card_read(card, want, sector, 1) != PI_OK) {
				return PI_DLINK_CARD;
			}
			lba = want;
		}
		memcpy(p + PI_DLINK_ANSWER_HEAD + i * PI_HASH_SIZE, sector + at % PI_SECTOR_SIZE,
		       PI_HASH_SIZE);
	}
	*length = (uint16_t)(PI_DLINK_ANSWER_HEAD + count * PI_HASH_SIZE);
	return PI_DLINK_OK;
}

static uint8_t changed(struct pi_dlink *link, const uint8_t *req, uint8_t *p, uint16_t *length)
{
	struct pi_card *card = link->card;
	uint32_t first = pi_get32(req);
	uint32_t count = pi_get16(req + 4);
	uint32_t total;
	uint8_t code = readable(link);
	uint64_t lba = UINT64_MAX;
	/* The mirror's cache holds the sector: it is a mirror sector no longer. */
	uint8_t *sector = link->cache;

	if (code != PI_DLINK_OK) {
		return code;
	}
	if (!(card->st.flags & PI_FLAG_LIST_VALID)) {
		return PI_DLINK_NO_LIST;
	}
	total = card->st.changed_count;
	if (first > total || (first == total && total != 0)) {
		return PI_DLINK_OUT_OF_RANGE;
	}
	if (count > total - first) {
		count = total - first;
	}
	memset(p, 0, PI_DLINK_ANSWER_HEAD);
	pi_put32(p, card->st.generation);
	pi_put32(p + 4, total);
	pi_put32(p + 8, first);
	pi_put16(p + 12, (uint16_t)count);
	for (uint32_t i = 0; i < count; i++) {
		uint64_t at = (uint64_t)(first + i) * 4u;
		uint64_t want = card->layout.list_lba + at / PI_SECTOR_SIZE;

		if (want != lba) {
			link->cache_valid = false;
			if (pi_card_read(card, want, sector, 1) != PI_OK) {
				return PI_DLINK_CARD;
			}
			lba = want;
		}
		memcpy(p + PI_DLINK_ANSWER_HEAD + i * 4u, sector + at % PI_SECTOR_SIZE, 4);
	}
	*length = (uint16_t)(PI_DLINK_ANSWER_HEAD + count * 4u);
	return PI_DLINK_OK;
}

static uint8_t read_mirror(struct pi_dlink *link, const uint8_t *req, uint8_t *p, uint16_t *length)
{
	struct pi_card *card = link->card;
	uint32_t block = pi_get32(req);
	uint32_t offset = pi_get32(req + 4);
	uint32_t count = pi_get16(req + 8);
	uint8_t code = readable(link);
	uint64_t start;
	uint32_t done = 0;

	if (code != PI_DLINK_OK) {
		return code;
	}
	if (count == 0 || count > PI_DLINK_READ_MAX) {
		return PI_DLINK_BAD_REQUEST;
	}
	if (block >= card->cur.block_count ||
	    (uint64_t)offset + count > pi_manifest_block_len(&card->cur, block)) {
		return PI_DLINK_OUT_OF_RANGE;
	}
	if (!link->cache_valid || link->cache_generation != card->st.generation) {
		link->cache_valid = false;
	}

	memset(p, 0, PI_DLINK_ANSWER_HEAD);
	pi_put32(p, card->st.generation);
	pi_put32(p + 4, block);
	pi_put32(p + 8, offset);
	pi_put16(p + 12, (uint16_t)count);
	start = (uint64_t)pi_card_block_lba(card, card->cur.block_size, block) * PI_SECTOR_SIZE + offset;
	while (done < count) {
		uint64_t at = start + done;
		uint64_t lba = at / PI_SECTOR_SIZE;
		uint32_t in = (uint32_t)(at % PI_SECTOR_SIZE);
		uint32_t take = PI_SECTOR_SIZE - in;

		if (!link->cache_valid || link->cache_lba != lba) {
			link->cache_valid = false;
			if (pi_card_read(card, lba, link->cache, 1) != PI_OK) {
				return PI_DLINK_CARD;
			}
			link->cache_lba = lba;
			link->cache_generation = card->st.generation;
			link->cache_valid = true;
		}
		if (take > count - done) {
			take = count - done;
		}
		memcpy(p + PI_DLINK_ANSWER_HEAD + done, link->cache + in, take);
		done += take;
	}
	*length = (uint16_t)(PI_DLINK_ANSWER_HEAD + count);
	return PI_DLINK_OK;
}

bool pi_dlink_handle(struct pi_dlink *link, const uint8_t *rx, size_t rx_len, uint8_t *tx)
{
	struct pi_frame request;
	enum pi_frame_result decoded = pi_frame_decode(rx, rx_len, &request);
	uint8_t *p = payload_of(tx);
	uint16_t length = 0;
	uint8_t code;

	if (decoded == PI_FRAME_NOTHING) {
		return false;
	}
	if (decoded == PI_FRAME_OK && request.type == PI_FRAME_POLL) {
		link->polls++;
		return false;
	}
	memset(tx, 0xff, PI_FRAME_SIZE);
	if (decoded != PI_FRAME_OK) {
		link->bad_frames++;
		answer_error(link, tx, NULL, PI_DLINK_BAD_FRAME);
		return true;
	}

	pi_card_lock(link->card);
	switch (request.type) {
	case PI_DLINK_INFO:
		code = request.length == 0 ? info(link, p) : PI_DLINK_BAD_REQUEST;
		length = PI_DLINK_INFO_SIZE;
		break;
	case PI_DLINK_MANIFEST:
		code = request.length != 8 || pi_get16(request.payload + 6) != 0 ||
				       pi_get16(request.payload + 4) == 0 ||
				       pi_get16(request.payload + 4) > PI_DLINK_MANIFEST_MAX
			       ? PI_DLINK_BAD_REQUEST
			       : manifest(link, request.payload, p, &length);
		break;
	case PI_DLINK_CHANGED:
		code = request.length != 8 || pi_get16(request.payload + 6) != 0 ||
				       pi_get16(request.payload + 4) == 0 ||
				       pi_get16(request.payload + 4) > PI_DLINK_CHANGED_MAX
			       ? PI_DLINK_BAD_REQUEST
			       : changed(link, request.payload, p, &length);
		break;
	case PI_DLINK_READ:
		code = request.length != 12 || pi_get16(request.payload + 10) != 0
			       ? PI_DLINK_BAD_REQUEST
			       : read_mirror(link, request.payload, p, &length);
		break;
	default:
		code = PI_DLINK_UNKNOWN_TYPE;
		break;
	}

	if (code == PI_DLINK_OK) {
		link->answered++;
		seal(tx, (uint8_t)(request.type | PI_DLINK_ANSWER), &request, length);
	} else {
		memset(tx, 0xff, PI_FRAME_SIZE);
		answer_error(link, tx, &request, code);
	}
	pi_card_unlock(link->card);
	return true;
}
