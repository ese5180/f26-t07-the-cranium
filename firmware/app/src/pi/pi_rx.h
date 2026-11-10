/*
 * What the board does with each frame from the Raspberry Pi, and what it answers: plain C, with no
 * Zephyr calls (pi_link.c does the SPI and the pins).
 *
 * The board answers each transfer with the STATUS frame it prepared before the transfer, so a
 * DATA frame is acknowledged in the transfer after it. The Pi sends a DATA frame, then a POLL,
 * and sends the DATA frame again until the STATUS names its session and seq. A DATA frame with
 * the session and seq of the last one accepted is acknowledged again but not delivered twice.
 */

#ifndef PI_RX_H_
#define PI_RX_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pi_frame.h"

struct pi_rx {
	bool accepted_any;
	uint16_t session;
	uint16_t seq;
	/* Counts since boot. */
	uint32_t delivered;
	uint32_t duplicates;
	uint32_t polls;
	uint32_t nothing;
	uint32_t bad;
	/* Frames whose CRC did not match: also counted in bad. */
	uint32_t bad_crc;
	/* Frames of a type the board does not take: also counted in bad. */
	uint32_t unknown;
};

enum pi_rx_result {
	/* A new message: frame->payload holds it. */
	PI_RX_DELIVER,
	PI_RX_DUPLICATE,
	PI_RX_POLL,
	PI_RX_NOTHING,
	PI_RX_BAD,
};

void pi_rx_init(struct pi_rx *rx);

/* Takes the `received` bytes of one transfer. */
enum pi_rx_result pi_rx_handle(struct pi_rx *rx, const uint8_t *buf, size_t received,
			       struct pi_frame *frame);

/* The STATUS frame for the next transfer, at the start of buf. Returns its length, or 0. */
size_t pi_rx_status(const struct pi_rx *rx, uint8_t *buf, size_t size);

#endif /* PI_RX_H_ */
