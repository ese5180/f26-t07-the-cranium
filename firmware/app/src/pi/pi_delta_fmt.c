/*
 * Raspberry Pi delta updates, the formats: see pi_delta_fmt.h.
 */

#include "pi_delta_fmt.h"

#include <string.h>

#include "pi_frame.h"

static const char *const reasons[PI_ERR_COUNT] = {
	[PI_OK] = "ok",
	[PI_ERR_BAD_MANIFEST] = "bad_manifest",
	[PI_ERR_BAD_SIGNATURE] = "bad_signature",
	[PI_ERR_MANIFEST_MISMATCH] = "manifest_mismatch",
	[PI_ERR_TOO_LARGE] = "too_large",
	[PI_ERR_SD_ABSENT] = "sd_absent",
	[PI_ERR_SD_IO] = "sd_io",
	[PI_ERR_DOWNLOAD] = "download_failed",
	[PI_ERR_DIGEST_MISMATCH] = "digest_mismatch",
	[PI_ERR_SD_READBACK] = "sd_readback_mismatch",
	[PI_ERR_ABORTED] = "aborted",
};

const char *pi_err_reason(enum pi_err err)
{
	if ((unsigned int)err >= PI_ERR_COUNT) {
		return "unknown";
	}
	return reasons[err];
}

static const uint8_t manifest_magic[4] = { 'C', 'P', 'D', 'M' };

static bool power_of_two(uint32_t v)
{
	return v != 0 && (v & (v - 1)) == 0;
}

bool pi_version_valid(const char *version, size_t field_size)
{
	size_t length = 0;

	while (length < field_size && version[length] != '\0') {
		char c = version[length];

		if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
		      c == '.' || c == '_' || c == '+' || c == '-')) {
			return false;
		}
		length++;
	}
	if (length == 0 || length > PI_VERSION_MAX || length >= field_size) {
		return false;
	}
	for (size_t i = length; i < field_size; i++) {
		if (version[i] != '\0') {
			return false;
		}
	}
	return true;
}

uint64_t pi_manifest_table_size(const struct pi_manifest *m)
{
	return (uint64_t)m->block_count * PI_HASH_SIZE;
}

uint32_t pi_manifest_block_len(const struct pi_manifest *m, uint32_t block)
{
	uint64_t start = (uint64_t)block * m->block_size;

	if (block >= m->block_count || start >= m->image_size) {
		return 0;
	}
	if (m->image_size - start < m->block_size) {
		return (uint32_t)(m->image_size - start);
	}
	return m->block_size;
}

enum pi_err pi_manifest_decode(const uint8_t raw[PI_MANIFEST_SIZE], struct pi_manifest *m)
{
	uint64_t blocks;

	memset(m, 0, sizeof(*m));
	if (memcmp(raw, manifest_magic, sizeof(manifest_magic)) != 0 ||
	    pi_get16(raw + 4) != PI_MANIFEST_FORMAT || pi_get16(raw + 6) != PI_MANIFEST_SIZE) {
		return PI_ERR_BAD_MANIFEST;
	}

	m->block_size = pi_get32(raw + 8);
	m->block_count = pi_get32(raw + 12);
	m->image_size = pi_get64(raw + 16);
	m->table_offset = pi_get64(raw + 24);
	m->image_offset = pi_get64(raw + 32);
	memcpy(m->image_sha256, raw + 40, PI_HASH_SIZE);
	memcpy(m->table_sha256, raw + 72, PI_HASH_SIZE);
	memcpy(m->version, raw + 104, PI_VERSION_MAX + 1);
	m->flags = pi_get32(raw + 136);
	memcpy(m->sig, raw + PI_MANIFEST_SIGNED_SIZE, PI_SIG_SIZE);

	if (!power_of_two(m->block_size) || m->block_size < PI_BLOCK_SIZE_MIN ||
	    m->block_size > PI_BLOCK_SIZE_MAX) {
		return PI_ERR_BAD_MANIFEST;
	}
	/* Whole sectors, so that the card is written a sector at a time. At most 2^48 bytes. */
	if (m->image_size == 0 || m->image_size % PI_SECTOR_SIZE != 0 ||
	    m->image_size > (1ull << 48)) {
		return PI_ERR_BAD_MANIFEST;
	}
	blocks = (m->image_size + m->block_size - 1) / m->block_size;
	if (blocks != m->block_count) {
		return PI_ERR_BAD_MANIFEST;
	}
	if (m->table_offset != PI_MANIFEST_SIZE || m->image_offset % PI_IMAGE_ALIGN != 0 ||
	    m->image_offset < m->table_offset + pi_manifest_table_size(m) ||
	    m->image_offset > (1ull << 50)) {
		return PI_ERR_BAD_MANIFEST;
	}
	if (!pi_version_valid(m->version, sizeof(m->version)) || m->flags != 0) {
		return PI_ERR_BAD_MANIFEST;
	}
	for (size_t i = 140; i < PI_MANIFEST_SIGNED_SIZE; i++) {
		if (raw[i] != 0) {
			return PI_ERR_BAD_MANIFEST;
		}
	}
	return PI_OK;
}

void pi_manifest_encode(const struct pi_manifest *m, uint8_t raw[PI_MANIFEST_SIZE])
{
	memset(raw, 0, PI_MANIFEST_SIZE);
	memcpy(raw, manifest_magic, sizeof(manifest_magic));
	pi_put16(raw + 4, PI_MANIFEST_FORMAT);
	pi_put16(raw + 6, PI_MANIFEST_SIZE);
	pi_put32(raw + 8, m->block_size);
	pi_put32(raw + 12, m->block_count);
	pi_put64(raw + 16, m->image_size);
	pi_put64(raw + 24, m->table_offset);
	pi_put64(raw + 32, m->image_offset);
	memcpy(raw + 40, m->image_sha256, PI_HASH_SIZE);
	memcpy(raw + 72, m->table_sha256, PI_HASH_SIZE);
	memcpy(raw + 104, m->version, PI_VERSION_MAX + 1);
	pi_put32(raw + 136, m->flags);
	memcpy(raw + PI_MANIFEST_SIGNED_SIZE, m->sig, PI_SIG_SIZE);
}

static uint64_t round_up(uint64_t v, uint64_t to)
{
	return (v + to - 1) / to * to;
}

void pi_card_layout_for(uint32_t max_blocks, struct pi_card_layout *layout)
{
	uint64_t slot_sectors = round_up(1 + round_up((uint64_t)max_blocks * PI_HASH_SIZE,
						       PI_SECTOR_SIZE) / PI_SECTOR_SIZE,
					 PI_CARD_ALIGN);
	uint64_t list_sectors = round_up(round_up((uint64_t)max_blocks * 4u, PI_SECTOR_SIZE) /
						 PI_SECTOR_SIZE,
					 PI_CARD_ALIGN);
	uint64_t staging_sectors = PI_BLOCK_SIZE_MAX / PI_SECTOR_SIZE;

	layout->state_lba[0] = PI_CARD_BASE_LBA;
	layout->state_lba[1] = PI_CARD_BASE_LBA + 1;
	layout->slot_lba[0] = PI_CARD_BASE_LBA + PI_CARD_ALIGN;
	layout->slot_lba[1] = layout->slot_lba[0] + slot_sectors;
	layout->list_lba = layout->slot_lba[1] + slot_sectors;
	layout->staging_lba = layout->list_lba + list_sectors;
	layout->mirror_lba = round_up(layout->staging_lba + staging_sectors, PI_CARD_MIRROR_ALIGN);
}

static const uint8_t state_magic[4] = { 'C', 'P', 'D', 'S' };

void pi_card_state_encode(const struct pi_card_state *st, uint8_t raw[PI_SECTOR_SIZE])
{
	memset(raw, 0, PI_SECTOR_SIZE);
	memcpy(raw, state_magic, sizeof(state_magic));
	pi_put16(raw + 4, PI_STATE_FORMAT);
	pi_put32(raw + 8, st->seq);
	pi_put32(raw + 12, st->max_blocks);
	raw[16] = st->state;
	raw[17] = st->cur_slot;
	raw[18] = st->new_slot;
	raw[19] = st->phase;
	raw[20] = st->flags;
	pi_put32(raw + 24, st->generation);
	pi_put32(raw + 28, st->changed_count);
	pi_put32(raw + 32, st->next);
	memcpy(raw + 36, st->base_version, PI_VERSION_MAX + 1);
	memcpy(raw + 68, st->base_sha256, PI_HASH_SIZE);
	pi_put32(raw + PI_SECTOR_SIZE - 4, pi_crc32(raw, PI_SECTOR_SIZE - 4));
}

bool pi_card_state_decode(const uint8_t raw[PI_SECTOR_SIZE], struct pi_card_state *st)
{
	memset(st, 0, sizeof(*st));
	if (memcmp(raw, state_magic, sizeof(state_magic)) != 0 ||
	    pi_get16(raw + 4) != PI_STATE_FORMAT ||
	    pi_get32(raw + PI_SECTOR_SIZE - 4) != pi_crc32(raw, PI_SECTOR_SIZE - 4)) {
		return false;
	}
	st->seq = pi_get32(raw + 8);
	st->max_blocks = pi_get32(raw + 12);
	st->state = raw[16];
	st->cur_slot = raw[17];
	st->new_slot = raw[18];
	st->phase = raw[19];
	st->flags = raw[20];
	st->generation = pi_get32(raw + 24);
	st->changed_count = pi_get32(raw + 28);
	st->next = pi_get32(raw + 32);
	memcpy(st->base_version, raw + 36, PI_VERSION_MAX + 1);
	memcpy(st->base_sha256, raw + 68, PI_HASH_SIZE);

	if (st->max_blocks == 0 || st->max_blocks > (1u << 24) || st->state > PI_STATE_UPDATING ||
	    st->cur_slot > 1 || st->new_slot > 1 || st->phase > PI_PHASE_BLOCKS ||
	    (st->flags & ~(PI_FLAG_HAS_CUR | PI_FLAG_LIST_VALID | PI_FLAG_DIRTY)) != 0 ||
	    st->changed_count > st->max_blocks ||
	    st->base_version[PI_VERSION_MAX] != '\0') {
		return false;
	}
	/* What the states allow together. */
	if ((st->state == PI_STATE_READY && !(st->flags & PI_FLAG_HAS_CUR)) ||
	    (st->state == PI_STATE_UPDATING && st->phase == PI_PHASE_NONE) ||
	    (st->phase == PI_PHASE_BLOCKS && st->state != PI_STATE_UPDATING) ||
	    (st->state == PI_STATE_EMPTY && (st->flags & PI_FLAG_HAS_CUR)) ||
	    ((st->flags & PI_FLAG_HAS_CUR) && st->phase != PI_PHASE_NONE &&
	     st->new_slot == st->cur_slot)) {
		return false;
	}
	return true;
}
