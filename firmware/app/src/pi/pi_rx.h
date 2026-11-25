/*
 * What the board does with each frame from the Raspberry Pi, and what it answers: plain C, with no
 * Zephyr calls (pi_link.c does the SPI and the pins).
 *
 * The board answers each transfer with the STATUS frame it prepared before the transfer, so a
 * DATA frame is acknowledged in the transfer after it. The Pi sends a DATA frame, then a POLL,
 * and sends the DATA frame again until the STATUS names its session and seq. A DATA frame with
 * the session and seq of the last one accepted is acknowledged again but not delivered twice.
 *
 * In a build with Raspberry Pi delta updates (CONFIG_APP_PI_DELTA), the same link also takes their
 * requests (0x10 to 0x13), and from 1.20.2 those of Pi OS updates (0x20 to 0x23), which pi_dlink.c
 * answers: pi_dlink_answer() then writes the frame for the
 * next transfer, the request's answer or STATUS. Any other build counts them as unknown.
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
#if defined(CONFIG_APP_PI_DELTA)
	/* Requests of a Pi delta update. */
	uint32_t delta;
#endif
};

enum pi_rx_result {
	/* A new message: frame->payload holds it. */
	PI_RX_DELIVER,
	PI_RX_DUPLICATE,
	PI_RX_POLL,
	PI_RX_NOTHING,
	PI_RX_BAD,
#if defined(CONFIG_APP_PI_DELTA)
	/* A Pi delta or OS update's request (0x10 to 0x13, 0x20 to 0x23): pi_dlink_answer() answers it. */
	PI_RX_DELTA,
#endif
};

void pi_rx_init(struct pi_rx *rx);

/* Takes the `received` bytes of one transfer. */
enum pi_rx_result pi_rx_handle(struct pi_rx *rx, const uint8_t *buf, size_t received,
			       struct pi_frame *frame);

/* The STATUS frame for the next transfer, at the start of buf. Returns its length, or 0. */
size_t pi_rx_status(const struct pi_rx *rx, uint8_t *buf, size_t size);

/*
 * Makes a message from the Pi safe to print, in place: a control character (C0, DEL, or a C1 such
 * as U+009B, the 8-bit CSI) and each byte that is not part of valid UTF-8 become '?'. Valid UTF-8
 * text is left as it is.
 */
void pi_rx_clean_text(uint8_t *text, size_t length);

#endif /* PI_RX_H_ */
