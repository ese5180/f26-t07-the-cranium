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
