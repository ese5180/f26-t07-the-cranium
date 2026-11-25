/*
 * Host tests of the Raspberry Pi message link's receiver (src/pi/pi_rx.c, docs/pi-link.md): what it
 * does with each frame, and the STATUS frame it answers with. Built twice: as every build without
 * Pi delta updates has it (pi_rx_tests), where their requests (0x10 to 0x13, and from 1.20.2 the Pi OS
 * update's 0x20 to 0x23) are of a type the board
 * does not take, and with CONFIG_APP_PI_DELTA (pi_rx_delta_tests), where they go to pi_dlink.c and
 * DATA, POLL and the rest stay as they were.
 */

#include <stdio.h>
#include <string.h>

#include "pi_frame.h"
#include "pi_rx.h"

static int failures;
static int checks;

#define CHECK(condition)                                                                     \
	do {                                                                                 \
		checks++;                                                                    \
		if (!(condition)) {                                                          \
			failures++;                                                          \
			printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);         \
		}                                                                            \
	} while (0)

static enum pi_rx_result take(struct pi_rx *rx, uint8_t type, uint16_t session, uint16_t seq,
			      const char *payload)
{
	uint8_t buf[PI_FRAME_SIZE];
	struct pi_frame frame = {
		.type = type,
		.session = session,
		.seq = seq,
		.length = (uint16_t)strlen(payload),
		.payload = (const uint8_t *)payload,
	};

	memset(buf, 0, sizeof(buf));
	CHECK(pi_frame_encode(buf, sizeof(buf), &frame) > 0);
	return pi_rx_handle(rx, buf, sizeof(buf), &frame);
}

/* STATUS, as the board arms it: 16 bytes, naming that session and seq. */
static bool status_names(const struct pi_rx *rx, uint16_t session, uint16_t ack)
{
	uint8_t buf[PI_FRAME_HEADER + PI_FRAME_CRC];
	struct pi_frame f;

	return pi_rx_status(rx, buf, sizeof(buf)) == sizeof(buf) &&
	       pi_frame_decode(buf, sizeof(buf), &f) == PI_FRAME_OK && f.type == PI_FRAME_STATUS &&
	       f.session == session && f.ack == ack && f.seq == 0 && f.length == 0;
}

int main(void)
{
	struct pi_rx rx;
	uint8_t buf[PI_FRAME_SIZE];
	struct pi_frame frame;

	pi_rx_init(&rx);
	CHECK(status_names(&rx, 0, 0));

	/* DATA is delivered once; the same session and seq again is a repeat. */
	CHECK(take(&rx, PI_FRAME_DATA, 0x1111, 5, "{\"t\":\"np\"}") == PI_RX_DELIVER);
	CHECK(status_names(&rx, 0x1111, 5));
	CHECK(take(&rx, PI_FRAME_DATA, 0x1111, 5, "{\"t\":\"np\"}") == PI_RX_DUPLICATE);
	CHECK(take(&rx, PI_FRAME_DATA, 0x1111, 6, "{}") == PI_RX_DELIVER);
	CHECK(take(&rx, PI_FRAME_DATA, 0, 7, "{}") == PI_RX_BAD);
	CHECK(take(&rx, PI_FRAME_POLL, 0x1111, 0, "") == PI_RX_POLL);
	CHECK(status_names(&rx, 0x1111, 6));

	/* The requests of Pi delta updates, and the types next to them. */
	for (unsigned int type = 0x0f; type <= 0x14; type++) {
		enum pi_rx_result result = take(&rx, (uint8_t)type, 0x2222, 9, "");
#if defined(CONFIG_APP_PI_DELTA)
		bool delta = type >= PI_FRAME_DELTA_FIRST && type <= PI_FRAME_DELTA_LAST;

		CHECK(result == (delta ? PI_RX_DELTA : PI_RX_BAD));
#else
		CHECK(result == PI_RX_BAD);
#endif
	}
#if defined(CONFIG_APP_PI_DELTA)
	CHECK(rx.unknown == 2 && rx.delta == 4 && rx.bad == 3);
#else
	CHECK(rx.unknown == 6 && rx.bad == 7);
#endif
	/* From 1.20.2, the requests of Pi OS updates, and the types next to them. */
	for (unsigned int type = 0x1f; type <= 0x24; type++) {
		enum pi_rx_result result = take(&rx, (uint8_t)type, 0x2222, 9, "");
#if defined(CONFIG_APP_PI_DELTA)
		bool os = type >= PI_FRAME_OS_FIRST && type <= PI_FRAME_OS_LAST;

		CHECK(result == (os ? PI_RX_DELTA : PI_RX_BAD));
#else
		CHECK(result == PI_RX_BAD);
#endif
	}
#if defined(CONFIG_APP_PI_DELTA)
	CHECK(rx.unknown == 4 && rx.delta == 8 && rx.bad == 5);
#else
	CHECK(rx.unknown == 12 && rx.bad == 13);
#endif
	/* None of them is a message: STATUS still names the last DATA. */
	CHECK(status_names(&rx, 0x1111, 6) && rx.delivered == 2 && rx.duplicates == 1);

	/* A bad CRC, and nothing clocked in. */
	memset(buf, 0, sizeof(buf));
	frame = (struct pi_frame){ .type = PI_FRAME_POLL, .session = 1 };
	CHECK(pi_frame_encode(buf, sizeof(buf), &frame) > 0);
	buf[PI_FRAME_HEADER] ^= 0x20;
	CHECK(pi_rx_handle(&rx, buf, sizeof(buf), &frame) == PI_RX_BAD && rx.bad_crc == 1);
	memset(buf, 0xff, sizeof(buf));
	CHECK(pi_rx_handle(&rx, buf, sizeof(buf), &frame) == PI_RX_NOTHING);
	CHECK(pi_rx_handle(&rx, buf, 0, &frame) == PI_RX_NOTHING && rx.nothing == 2);
	CHECK(rx.polls == 1);

#if defined(CONFIG_APP_PI_DELTA)
	printf("pi_rx_delta_tests: %d checks, %d failures\n", checks, failures);
#else
	printf("pi_rx_tests: %d checks, %d failures\n", checks, failures);
#endif
	return failures == 0 ? 0 : 1;
}
