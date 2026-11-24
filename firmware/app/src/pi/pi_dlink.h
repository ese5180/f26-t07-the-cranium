/*
 * Raspberry Pi delta updates, the board's end of the Pi's SPI link (docs/pi-delta-update.md,
 * "The SPI protocol"). The requests share the Pi's message link (pi_link.c, docs/pi-link.md): its
 * pins, its frames (pi_frame.h) and its SPI peripheral. The Pi asks; the board answers in the
 * transfer that follows. pi_rx_handle() takes every frame and names a delta request PI_RX_DELTA;
 * pi_dlink_answer() then writes what the board sends in the next transfer.
 *
 * One rule for every frame on the link: the board answers each frame in the next transfer. A delta
 * request gets its answer (the request's type with 0x80 set):
 *
 *   0x10 INFO      no payload           the card's state, the image, the last update's base
 *   0x11 MANIFEST  first u32, count u16 count block hashes (1 to 15), from block first
 *   0x12 CHANGED   first u32, count u16 count entries (1 to 120) of the list of changed blocks
 *   0x13 READ      block u32, offset u32, length u16
 *                                       length bytes (1 to 480) of a block of the mirror
 *
 * and everything else (DATA, POLL, a damaged frame, a type the board does not take, nothing) gets
 * the message link's STATUS. Every request only reads, so the Pi sends one again whenever its
 * answer did not come.
 *
 * An answer's session and ack are the message link's, as in STATUS (pi_frame.h): the session and
 * seq of the last DATA frame accepted. Its seq is the request's, so the Pi can tell its answer from
 * any other frame.
 *
 * A request the board cannot answer gets ERROR (0xff): a code, the state and the generation.
 * MANIFEST, CHANGED and READ are refused while the card is not ready (no image, or being updated),
 * so the Pi never takes a half-written mirror. Each answer carries the generation, which goes up
 * with every finished update: a Pi that sees it change starts again.
 *
 * Plain C over pi_card.h and pi_rx.h: the SPI peripheral, READY and the work queue are in
 * pi_link.c. Tested on the host (test_pi_delta.c) and driven by tools/pi_delta_sim.py through
 * pi_delta_harness.c.
 */

#ifndef PI_DLINK_H_
#define PI_DLINK_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pi_card.h"
#include "pi_frame.h"
#include "pi_rx.h"

#define PI_DLINK_VERSION 1

enum pi_dlink_type {
	PI_DLINK_INFO = 0x10,
	PI_DLINK_MANIFEST = 0x11,
	PI_DLINK_CHANGED = 0x12,
	PI_DLINK_READ = 0x13,
	/* The answers: the request's type | PI_DLINK_ANSWER. */
	PI_DLINK_ANSWER = 0x80,
	PI_DLINK_ERROR = 0xff,
};

enum pi_dlink_code {
	PI_DLINK_OK = 0,
	/*
	 * 1 was "the frame did not arrive whole", before the link was shared: a damaged frame is
	 * answered with STATUS now, as on the message link, and the Pi sends its request again.
	 */
	/* The payload is the wrong length, or a field is out of its range (a count of 0, too many). */
	PI_DLINK_BAD_REQUEST = 2,
	/* Not a delta request: pi_rx.c sends no other type here, so the Pi never sees it. */
	PI_DLINK_UNKNOWN_TYPE = 3,
	/* The card holds no image. */
	PI_DLINK_NO_IMAGE = 4,
	/* The mirror is being written: ask INFO until it says ready. */
	PI_DLINK_UPDATING = 5,
	/* A block, an offset or an index past the end. */
	PI_DLINK_OUT_OF_RANGE = 6,
	/* The card could not be read, or is not there. */
	PI_DLINK_CARD = 7,
	/* The list of changed blocks does not describe the image on the card. */
	PI_DLINK_NO_LIST = 8,
};

#define PI_DLINK_MANIFEST_MAX 15u
#define PI_DLINK_CHANGED_MAX  120u
#define PI_DLINK_READ_MAX     480u
/* The answers' fixed part, before the hashes, entries or bytes. */
#define PI_DLINK_ANSWER_HEAD  16u
#define PI_DLINK_INFO_SIZE    196u

/* INFO flags. */
#define PI_DLINK_INFO_LIST      0x01u
/* The next update's manifest is downloading; the mirror is still the image INFO describes. */
#define PI_DLINK_INFO_PREPARING 0x02u
/* The card could not be read, or is not there: the rest of INFO says nothing. */
#define PI_DLINK_INFO_NO_CARD   0x04u

struct pi_dlink {
	/* NULL until the card is given: answered as no card. */
	struct pi_card *card;
	/* The last sector read from the mirror, for the next READ: the Pi reads in order. */
	uint8_t cache[PI_SECTOR_SIZE];
	uint64_t cache_lba;
	uint32_t cache_generation;
	bool cache_valid;
	/* Counts, for STATUS|pi and the tests: requests answered, and refused with ERROR. */
	uint32_t answered;
	uint32_t errors;
};

/* card may be NULL: then every request is answered as with no card in the slot. */
void pi_dlink_init(struct pi_dlink *link, struct pi_card *card);

/*
 * What the board sends in the next transfer, at the start of tx, once pi_rx_handle() has taken
 * `frame` from this transfer with `result`: for PI_RX_DELTA the request's answer, read from the card
 * with it locked; for anything else, STATUS. Returns its length (at most PI_FRAME_SIZE); the SPI
 * peripheral clocks out 0xff after it. size must be at least PI_FRAME_SIZE.
 */
size_t pi_dlink_answer(struct pi_dlink *link, const struct pi_rx *rx, enum pi_rx_result result,
		       const struct pi_frame *frame, uint8_t *tx, size_t size);

#endif /* PI_DLINK_H_ */
