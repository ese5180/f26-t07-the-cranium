/*
 * The SPI link from the Raspberry Pi (docs/pi-link.md): the board is the SPI peripheral on the
 * Arduino SPI pins (SPIS3: D13 SCK, D11 MOSI, D12 MISO, D10 CS) and raises READY (D9) while it is
 * ready for a transfer. Each message from the Pi is printed on the serial console as "[PI] <message>",
 * and STATUS|pi says how the link is doing. On the nRF7002 DK (CONFIG_APP_PI_LINK).
 *
 * It has no thread of its own: the SPI driver's callback hands each transfer to the system work
 * queue, which takes it and arms the peripheral again. RAM is short on this board, so the link keeps
 * little: one frame's worth of receive buffer, a STATUS frame, and the start of the last np and hb.
 *
 * With CONFIG_APP_PI_PLAYS (from 1.20.1) each np also goes to the cloud as a play, from the main loop
 * (pi_link_plays_on_tick()), and the last np is kept whole up to PI_LINK_NP_KEPT_MAX bytes for it.
 *
 * In a build with Raspberry Pi delta updates (CONFIG_APP_PI_DELTA), the same link also answers their
 * requests (pi_dlink.h, docs/pi-delta-update.md). Its work then runs on a queue of its own, since a
 * READ waits for the SD card, and its transmit buffer holds a whole frame.
 */

#ifndef PI_LINK_H_
#define PI_LINK_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* How much of the last np and hb is kept for STATUS|pi; the rest is left out. */
#define PI_LINK_KEPT_MAX 128
#if defined(CONFIG_APP_PI_PLAYS)
/* The last np is kept whole up to this, to go to the cloud as a play; a longer one is only printed. */
#define PI_LINK_NP_KEPT_MAX 255
#else
#define PI_LINK_NP_KEPT_MAX PI_LINK_KEPT_MAX
#endif

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
#if defined(CONFIG_APP_PI_DELTA)
	/* Requests of Pi delta updates: answered, and refused with ERROR. */
	uint32_t delta_answered;
	uint32_t delta_refused;
#endif
#if defined(CONFIG_APP_PI_PLAYS)
	/* np messages sent to the cloud as plays, replaced by a newer one or too long, and not sent. */
	uint32_t plays_sent;
	uint32_t plays_skipped;
	uint32_t plays_failed;
#endif
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

#if defined(CONFIG_APP_PI_PLAYS)
/*
 * From the main loop, once a second: the last np, if it has not gone yet, to the cloud as a play
 * (session_format_play()), while the cloud is connected and at most one every
 * CONFIG_APP_PI_PLAYS_INTERVAL_SECONDS. It uses about 300 bytes of the caller's stack.
 */
void pi_link_plays_on_tick(void);
#endif

#if defined(CONFIG_APP_PI_DELTA)
struct pi_card;

/*
 * Pi delta updates: the card the requests are answered from, once pi_card_init() has set it up.
 * Until then they are answered as with no card in the slot. Call once, from any thread.
 */
void pi_link_serve_card(struct pi_card *card);
#endif

#endif /* PI_LINK_H_ */
