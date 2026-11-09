/*
 * What an image is compatible with: see image_compat.h. Nothing here reads flash or keeps state of
 * its own, so the cloud update, the Bluetooth upload and the tests share it.
 */

#include "image_compat.h"

#include <errno.h>
#include <string.h>

static uint16_t u16_at(const uint8_t *data)
{
	return (uint16_t)(data[0] | (data[1] << 8));
}

static uint32_t u32_at(const uint8_t *data)
{
	return (uint32_t)data[0] | ((uint32_t)data[1] << 8) | ((uint32_t)data[2] << 16) |
	       ((uint32_t)data[3] << 24);
}

int image_compat_parse_header(const uint8_t *data, size_t len, struct image_compat_header *out)
{
	if (data == NULL || len < IMAGE_COMPAT_HEADER_SIZE ||
	    u32_at(data) != IMAGE_COMPAT_IMAGE_MAGIC) {
		return -EINVAL;
	}

	out->header_size = u16_at(data + 8);
	out->protected_size = u16_at(data + 10);
	out->image_size = u32_at(data + 12);

	return out->header_size < IMAGE_COMPAT_HEADER_SIZE ? -EINVAL : 0;
}

void image_compat_begin(struct image_compat_reader *reader, uint16_t protected_size)
{
	memset(reader, 0, sizeof(*reader));
	reader->total = protected_size;
	/* Less than its own info header is no area at all. */
	reader->bad = protected_size > 0 && protected_size < 4;
}

static bool board_value_ok(const uint8_t *value, size_t length)
{
	if (length == 0 || length > IMAGE_COMPAT_BOARD_MAX) {
		return false;
	}

	for (size_t i = 0; i < length; i++) {
		if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'z'))) {
			return false;
		}
	}
	return true;
}

static bool layout_value(const uint8_t *value, size_t length, uint32_t *layout)
{
	uint32_t number = 0;

	if (length == 0 || length > IMAGE_COMPAT_LAYOUT_DIGITS || value[0] == '0') {
		return false;
	}

	for (size_t i = 0; i < length; i++) {
		if (value[i] < '0' || value[i] > '9') {
			return false;
		}
		number = number * 10 + (uint32_t)(value[i] - '0');
	}

	*layout = number;
	return true;
}

/* An entry's value is all there: one of ours is checked and kept, any other is passed over. */
static void end_entry(struct image_compat_reader *r)
{
	/* Longer than was kept of it: too long for either, and never read past what was kept. */
	if ((r->type == IMAGE_COMPAT_TLV_BOARD || r->type == IMAGE_COMPAT_TLV_LAYOUT) &&
	    r->value_length > sizeof(r->value)) {
		r->bad = true;
		return;
	}

	if (r->type == IMAGE_COMPAT_TLV_BOARD) {
		if (r->seen_board || !board_value_ok(r->value, r->value_length)) {
			r->bad = true;
			return;
		}
		memcpy(r->found.board, r->value, r->value_length);
		r->found.board[r->value_length] = '\0';
		r->seen_board = true;
	} else if (r->type == IMAGE_COMPAT_TLV_LAYOUT) {
		if (r->seen_layout ||
		    r->value_length > IMAGE_COMPAT_LAYOUT_DIGITS ||
		    !layout_value(r->value, r->value_length, &r->found.layout)) {
			r->bad = true;
			return;
		}
		r->seen_layout = true;
	}

	r->in_value = false;
	r->head_used = 0;
}

static void take_byte(struct image_compat_reader *r, uint8_t byte)
{
	if (r->at >= r->total) {
		r->bad = true;
		return;
	}

	/* The area's info header: its magic, and its size, which must be the image header's. */
	if (r->at < 4) {
		r->head[r->at++] = byte;
		if (r->at == 4 &&
		    (u16_at(r->head) != IMAGE_COMPAT_PROT_MAGIC || u16_at(r->head + 2) != r->total)) {
			r->bad = true;
		}
		return;
	}

	r->at++;

	if (!r->in_value) {
		r->head[r->head_used++] = byte;
		if (r->head_used < 4) {
			return;
		}

		r->type = u16_at(r->head);
		r->left = u16_at(r->head + 2);
		r->value_length = 0;
		r->in_value = true;

		/* An entry that would reach past the area. */
		if (r->left > r->total - r->at) {
			r->bad = true;
			return;
		}

		if (r->left == 0) {
			end_entry(r);
		}
		return;
	}

	if ((r->type == IMAGE_COMPAT_TLV_BOARD || r->type == IMAGE_COMPAT_TLV_LAYOUT) &&
	    r->value_length < sizeof(r->value)) {
		r->value[r->value_length] = byte;
	}
	/* Counted on past what is kept, so that a value too long is seen to be. */
	if (r->value_length < UINT16_MAX) {
		r->value_length++;
	}

	if (--r->left == 0) {
		end_entry(r);
	}
}

void image_compat_feed(struct image_compat_reader *reader, const uint8_t *data, size_t len)
{
	for (size_t i = 0; i < len && !reader->bad; i++) {
		take_byte(reader, data[i]);
	}
}

bool image_compat_complete(const struct image_compat_reader *reader)
{
	return reader->bad || reader->at == reader->total;
}

enum image_compat_verdict image_compat_finish(const struct image_compat_reader *reader,
					      const char *board, uint32_t layout,
					      struct image_compat *found)
{
	memset(found, 0, sizeof(*found));

	if (reader->bad || reader->at != reader->total || reader->in_value || reader->head_used != 0) {
		return IMAGE_COMPAT_MALFORMED;
	}

	strcpy(found->board, reader->seen_board ? reader->found.board : IMAGE_COMPAT_LEGACY_BOARD);
	found->layout = reader->seen_layout ? reader->found.layout : IMAGE_COMPAT_LEGACY_LAYOUT;

	if (strcmp(found->board, board) != 0) {
		return IMAGE_COMPAT_OTHER_BOARD;
	}

	return found->layout == layout ? IMAGE_COMPAT_OK : IMAGE_COMPAT_OTHER_LAYOUT;
}

const char *image_compat_reason(enum image_compat_verdict verdict)
{
	switch (verdict) {
	case IMAGE_COMPAT_OK:
		return "none";
	case IMAGE_COMPAT_OTHER_BOARD:
		return "incompatible_board";
	case IMAGE_COMPAT_OTHER_LAYOUT:
		return "incompatible_layout";
	case IMAGE_COMPAT_MALFORMED:
		return "header_mismatch";
	default:
		return "flash_error";
	}
}
