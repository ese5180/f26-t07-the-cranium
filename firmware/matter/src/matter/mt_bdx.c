/*
 * See mt_bdx.h.
 */
#include "mt_bdx.h"

#include <string.h>

#define RANGE_DEFLEN      0x01u
#define RANGE_START       0x02u
#define RANGE_WIDE        0x10u

static uint64_t rd(const uint8_t *p, unsigned int n)
{
	uint64_t v = 0;

	for (unsigned int i = 0; i < n; i++) {
		v |= (uint64_t)p[i] << (8 * i);
	}
	return v;
}

bool mt_bdx_parse_init(const uint8_t *in, size_t len, struct mt_bdx_init *out)
{
	size_t n = 4;

	memset(out, 0, sizeof(*out));
	if (len < 6) {
		return false;
	}
	out->transfer_control = in[0];
	uint8_t range = in[1];
	unsigned int w = (range & RANGE_WIDE) ? 8 : 4;

	out->max_block_size = (uint16_t)rd(&in[2], 2);
	if (range & RANGE_START) {
		if (len < n + w) {
			return false;
		}
		out->start_offset = rd(&in[n], w);
		n += w;
	}
	if (range & RANGE_DEFLEN) {
		if (len < n + w) {
			return false;
		}
		out->max_length = rd(&in[n], w);
		n += w;
	}
	if (len < n + 2) {
		return false;
	}
	out->file_designator_len = (uint16_t)rd(&in[n], 2);
	n += 2;
	if (len - n < out->file_designator_len) {
		return false;
	}
	out->file_designator = &in[n];
	return out->max_block_size > 0;
}

size_t mt_bdx_receive_accept(uint8_t *out, uint16_t max_block_size, uint64_t length)
{
	bool wide = length > 0xFFFFFFFFull;

	out[0] = MT_BDX_RECEIVER_DRIVE; /* version 0 */
	out[1] = (uint8_t)(RANGE_DEFLEN | (wide ? RANGE_WIDE : 0));
	out[2] = (uint8_t)max_block_size;
	out[3] = (uint8_t)(max_block_size >> 8);
	for (unsigned int i = 0; i < (wide ? 8u : 4u); i++) {
		out[4 + i] = (uint8_t)(length >> (8 * i));
	}
	return wide ? 12 : 8;
}

bool mt_bdx_parse_counter(const uint8_t *in, size_t len, uint32_t *counter)
{
	if (len != 4) {
		return false;
	}
	*counter = (uint32_t)rd(in, 4);
	return true;
}

bool mt_bdx_parse_query_skip(const uint8_t *in, size_t len, uint32_t *counter, uint64_t *skip)
{
	if (len != 12) {
		return false;
	}
	*counter = (uint32_t)rd(in, 4);
	*skip = rd(&in[4], 8);
	return true;
}

size_t mt_bdx_block_header(uint8_t *out, uint32_t counter)
{
	for (int i = 0; i < 4; i++) {
		out[i] = (uint8_t)(counter >> (8 * i));
	}
	return 4;
}
