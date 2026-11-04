/*
 * The secondary slot's image against this board: see image_compat_check_slot() in image_compat.h.
 *
 * Bounded at every step: the header's sizes are added in 64 bits and checked against the slot
 * before anything past the header is read, the protected area goes through the reader a few bytes
 * at a time, and the unprotected TLV area's info header has to follow it, inside the slot. Only the
 * protected area, which the image's SHA-256 covers, is read for what the image is for. That the
 * SHA-256 and the signature hold is the bootloader's check, which it makes before it swaps.
 */

#include "image_compat.h"

#include <errno.h>
#include <string.h>
#include <sys/types.h>

#include <zephyr/storage/flash_map.h>
#include <zephyr/sys/util.h>

/* What is read of the protected area at a time. */
#define READ_PIECE 32

static enum image_compat_verdict check_area(const struct flash_area *area,
					    struct image_compat *found)
{
	uint8_t data[MAX(IMAGE_COMPAT_HEADER_SIZE, READ_PIECE)];
	struct image_compat_header header;
	struct image_compat_reader reader;
	uint64_t protected_at;
	uint64_t tlv_at;

	if (area->fa_size < IMAGE_COMPAT_HEADER_SIZE ||
	    flash_area_read(area, 0, data, IMAGE_COMPAT_HEADER_SIZE) != 0) {
		return IMAGE_COMPAT_UNREADABLE;
	}

	if (image_compat_parse_header(data, IMAGE_COMPAT_HEADER_SIZE, &header) != 0) {
		return IMAGE_COMPAT_MALFORMED;
	}

	protected_at = (uint64_t)header.header_size + header.image_size;
	tlv_at = protected_at + header.protected_size;
	if (tlv_at + 4 > area->fa_size) {
		return IMAGE_COMPAT_MALFORMED;
	}

	image_compat_begin(&reader, header.protected_size);
	for (uint64_t at = protected_at; at < tlv_at && !image_compat_complete(&reader);) {
		size_t length = (size_t)MIN((uint64_t)READ_PIECE, tlv_at - at);

		if (flash_area_read(area, (off_t)at, data, length) != 0) {
			return IMAGE_COMPAT_UNREADABLE;
		}
		image_compat_feed(&reader, data, length);
		at += length;
	}

	/* The unprotected area follows, as the bootloader finds it, and it ends inside the slot. */
	if (flash_area_read(area, (off_t)tlv_at, data, 4) != 0) {
		return IMAGE_COMPAT_UNREADABLE;
	}
	if ((uint16_t)(data[0] | (data[1] << 8)) != IMAGE_COMPAT_TLV_MAGIC ||
	    (uint16_t)(data[2] | (data[3] << 8)) < 4 ||
	    tlv_at + (uint16_t)(data[2] | (data[3] << 8)) > area->fa_size) {
		return IMAGE_COMPAT_MALFORMED;
	}

	return image_compat_finish(&reader, CONFIG_APP_BOARD_TYPE, CONFIG_APP_IMAGE_LAYOUT, found);
}

enum image_compat_verdict image_compat_check_slot(uint8_t area_id, struct image_compat *found)
{
	const struct flash_area *area;
	enum image_compat_verdict verdict;

	memset(found, 0, sizeof(*found));

	if (flash_area_open(area_id, &area) != 0) {
		return IMAGE_COMPAT_UNREADABLE;
	}

	verdict = check_area(area, found);
	flash_area_close(area);
	return verdict;
}
