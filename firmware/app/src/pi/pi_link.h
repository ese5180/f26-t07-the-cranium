/*
 * The SPI link from the Raspberry Pi (docs/pi-link.md): the board is the SPI peripheral on the
 * Arduino SPI pins (SPIS3: D13 SCK, D11 MOSI, D12 MISO, D10 CS) and raises READY (D9) while it is
 * ready for a transfer. Each message from the Pi is printed on the serial console as "[PI] <message>",
 * and STATUS|pi says how the link is doing. On the nRF7002 DK (CONFIG_APP_PI_LINK).
 *
 * It has no thread of its own: the SPI driver's callback hands each transfer to the system work
 * queue, which takes it and arms the peripheral again. RAM is short on this board, so the link keeps
 * little: one frame's worth of receive buffer, a STATUS frame, and the start of the last np and hb.
 */

#ifndef PI_LINK_H_
#define PI_LINK_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* How much of the last np and hb is kept for STATUS|pi; the rest is left out. */
#define PI_LINK_KEPT_MAX 128

struct pi_link_view {
	/* The SPI peripheral and READY are set up, and the link is armed or about to be. */
	bool running;
	/* The last error setting up or arming the SPI peripheral, or 0. */
	int error;
	/* Milliseconds since the last frame that was not garbage, or -1 if none yet. */
	int64_t since_frame_ms;
	uint32_t delivered;
	uint32_t duplicates;
	uint32_t polls;
	uint32_t bad;
	uint32_t bad_crc;
};

enum pi_link_kind {
	PI_LINK_NP,
	PI_LINK_HB,
};

/* Sets up the pins and arms the link. Call once, after console_start(). */
void pi_link_start(void);

/* The link's counts, from any thread. */
void pi_link_get_view(struct pi_link_view *view);

/* The start of the last message of that kind, as text, or "" if none yet. From any thread. */
void pi_link_get_last(enum pi_link_kind kind, char *buf, size_t size);

#endif /* PI_LINK_H_ */
