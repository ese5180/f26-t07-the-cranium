/*
 * What the board does with each frame from the Raspberry Pi: see pi_rx.h.
 */

#include "pi_rx.h"

#include <string.h>

void pi_rx_init(struct pi_rx *rx)
{
	memset(rx, 0, sizeof(*rx));
}

enum pi_rx_result pi_rx_handle(struct pi_rx *rx, const uint8_t *buf, size_t received,
			       struct pi_frame *frame)
{
	enum pi_frame_result result = pi_frame_decode(buf, received, frame);

	if (result == PI_FRAME_NOTHING) {
		rx->nothing++;
		return PI_RX_NOTHING;
	}
	if (result != PI_FRAME_OK) {
		rx->bad++;
		if (result == PI_FRAME_BAD_CRC) {
			rx->bad_crc++;
		}
		return PI_RX_BAD;
	}

#if defined(CONFIG_APP_PI_DELTA)
	if ((frame->type >= PI_FRAME_DELTA_FIRST && frame->type <= PI_FRAME_DELTA_LAST) ||
	    (frame->type >= PI_FRAME_OS_FIRST && frame->type <= PI_FRAME_OS_LAST)) {
		rx->delta++;
		return PI_RX_DELTA;
	}
#endif

	switch (frame->type) {
	case PI_FRAME_POLL:
		rx->polls++;
		return PI_RX_POLL;
	case PI_FRAME_DATA:
		if (frame->session == 0) {
			rx->bad++;
			return PI_RX_BAD;
		}
		if (rx->accepted_any && frame->session == rx->session && frame->seq == rx->seq) {
			rx->duplicates++;
			return PI_RX_DUPLICATE;
		}
		rx->accepted_any = true;
		rx->session = frame->session;
		rx->seq = frame->seq;
		rx->delivered++;
		return PI_RX_DELIVER;
	default:
		rx->bad++;
		rx->unknown++;
		return PI_RX_BAD;
	}
}

size_t pi_rx_status(const struct pi_rx *rx, uint8_t *buf, size_t size)
{
	struct pi_frame status = {
		.type = PI_FRAME_STATUS,
		.session = rx->accepted_any ? rx->session : 0,
		.ack = rx->accepted_any ? rx->seq : 0,
	};

	return pi_frame_encode(buf, size, &status);
}

/* How many bytes the UTF-8 sequence at text[0] has (1 to 4), or 0 if it is not valid. */
static size_t utf8_length(const uint8_t *text, size_t left)
{
	uint8_t b = text[0];
	size_t n;
	uint8_t low = 0x80;
	uint8_t high = 0xbf;

	if (b < 0x80) {
		return 1;
	} else if (b >= 0xc2 && b <= 0xdf) {
		n = 2;
	} else if (b >= 0xe0 && b <= 0xef) {
		n = 3;
		/* No overlong forms, and no surrogates (U+D800 to U+DFFF). */
		low = b == 0xe0 ? 0xa0 : 0x80;
		high = b == 0xed ? 0x9f : 0xbf;
	} else if (b >= 0xf0 && b <= 0xf4) {
		n = 4;
		/* No overlong forms, and nothing above U+10FFFF. */
		low = b == 0xf0 ? 0x90 : 0x80;
		high = b == 0xf4 ? 0x8f : 0xbf;
	} else {
		return 0;
	}
	if (left < n || text[1] < low || text[1] > high) {
		return 0;
	}
	for (size_t i = 2; i < n; i++) {
		if (text[i] < 0x80 || text[i] > 0xbf) {
			return 0;
		}
	}
	return n;
}

void pi_rx_clean_text(uint8_t *text, size_t length)
{
	size_t i = 0;

	while (i < length) {
		size_t n = utf8_length(&text[i], length - i);
		/* U+0080 to U+009F, the C1 controls, are C2 80 to C2 9F. */
		bool control = n == 0 || (n == 1 && (text[i] < 0x20 || text[i] == 0x7f)) ||
			       (n == 2 && text[i] == 0xc2 && text[i + 1] < 0xa0);

		if (control) {
			n = n == 0 ? 1 : n;
			memset(&text[i], '?', n);
		}
		i += n;
	}
}
