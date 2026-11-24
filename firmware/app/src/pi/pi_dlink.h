/*
 * Raspberry Pi delta updates, the board's end of the Pi's SPI link (docs/pi-delta-update.md,
 * "The SPI protocol"). The Pi is the SPI controller and the board the target, on the pins and with
 * the frames of the Pi's message link (pi_frame.h, PR #58): 512-byte transfers, a 12-byte header,
 * a CRC-32. The Pi asks; the board answers in the transfer that follows.
 *
 * Requests (Pi to board), and what the board answers with (the request's type with 0x80 set):
 *
 *   0x10 INFO      no payload           the card's state, the image, the last update's base
 *   0x11 MANIFEST  first u32, count u16 count block hashes (1 to 15), from block first
 *   0x12 CHANGED   first u32, count u16 count entries (1 to 120) of the list of changed blocks
 *   0x13 READ      block u32, offset u32, length u16
 *                                       length bytes (1 to 480) of a block of the mirror
 *   0x02 POLL      no payload           (the message link's) nothing new: the last answer again
 *
 * Any request the board cannot answer gets ERROR (0xff): a code, the state and the generation.
 * MANIFEST, CHANGED and READ are refused while the card is not ready (no image, or being updated),
 * so the Pi never takes a half-written mirror. Each answer carries the generation, which goes up
 * with every finished update: a Pi that sees it change starts again.
 *
 * Plain C over pi_card.h: the SPI target and the READY pin are in pi_dlink_spis.c. Tested on the
 * host (test_pi_delta.c) and driven by tools/pi_delta_sim.py through pi_delta_harness.c.
 */

#ifndef PI_DLINK_H_
#define PI_DLINK_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pi_card.h"
#include "pi_frame.h"

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
	/* The frame did not arrive whole: magic, version, length or CRC. Send it again. */
	PI_DLINK_BAD_FRAME = 1,
	/* The payload is the wrong length, or a field is out of its range (a count of 0, too many). */
	PI_DLINK_BAD_REQUEST = 2,
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
	struct pi_card *card;
	/* The last sector read from the mirror, for the next READ: the Pi reads in order. */
	uint8_t cache[PI_SECTOR_SIZE];
	uint64_t cache_lba;
	uint32_t cache_generation;
	bool cache_valid;
	/* Counts, for STATUS and the tests. */
	uint32_t answered;
	uint32_t errors;
	uint32_t bad_frames;
	uint32_t polls;
};

void pi_dlink_init(struct pi_dlink *link, struct pi_card *card);

/*
 * One transfer: rx is what the Pi clocked in. Writes the answer for the next transfer into tx
 * (PI_FRAME_SIZE bytes, padded with 0xff) and returns true; or returns false and leaves tx as it
 * is, for a POLL or a transfer with nothing in it, so the last answer goes out again.
 */
bool pi_dlink_handle(struct pi_dlink *link, const uint8_t *rx, size_t rx_len, uint8_t *tx);

#endif /* PI_DLINK_H_ */
