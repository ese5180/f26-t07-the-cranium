/*
 * The board's end of the link to the Raspberry Pi: a framed protocol over SPI, the board as the
 * controller, that sends an image to the Pi's partition B (docs/pi-ota.md, "The SPI protocol",
 * which is the contract for the Pi's end).
 *
 * Frames, little-endian, each one SPI transaction with the Pi's chip select low:
 *
 *   0   4  magic "CPI1"
 *   4   1  type: BEGIN 1, DATA 2, VERIFY 3, ABORT 4, POLL 5
 *   5   1  flags, 0
 *   6   2  reserved, 0
 *   8   4  sequence number
 *   12  4  payload length N
 *   16  N  payload
 *   16+N 4 CRC-32 (IEEE, as zlib.crc32) of bytes 0 to 16+N-1
 *
 * After every transaction the Pi takes READY low and raises it again when it is ready for the next
 * one; the board waits for that rising edge. After a frame the next transaction is a POLL, during
 * which the Pi clocks out its status (struct in pi_xfer.c, 20 bytes): ACK, NAK with a code, or BUSY.
 * A frame that was not answered, or answered with a bad CRC, is sent again with the same sequence
 * number, and the Pi has to ACK a repeated frame without applying it twice.
 *
 * Shared bus: the SD card is on the same SPI bus, with its own chip select. This module never
 * touches the card: it asks the source for each chunk, then sends it, one after the other.
 *
 * No hardware dependency: the transport and the source are functions. Tested on the host against
 * tools/pi_xfer_sim.py, a simulator of the Pi's end (firmware/tests/hil/test_pi_xfer.py).
 */

#ifndef PI_XFER_H_
#define PI_XFER_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pi_image.h"
#include "pi_sha256.h"

#define PI_XFER_MAGIC        0x31495043u /* "CPI1" */
#define PI_XFER_STATUS_MAGIC 0x31525043u /* "CPR1" */
#define PI_XFER_PROTOCOL     1
/* The partition a BEGIN names: the Pi's B. */
#define PI_XFER_PARTITION_B  2

#define PI_XFER_HEADER_SIZE 16
#define PI_XFER_CRC_SIZE    4
/* A DATA payload: the offset of its bytes in the image, then the bytes. */
#define PI_XFER_DATA_PREFIX 4
#define PI_XFER_STATUS_SIZE 20
#define PI_XFER_BEGIN_SIZE  80

/* The room a buffer needs around a chunk. */
#define PI_XFER_FRAME_OVERHEAD (PI_XFER_HEADER_SIZE + PI_XFER_DATA_PREFIX + PI_XFER_CRC_SIZE)

enum pi_xfer_type {
	PI_XFER_BEGIN = 1,
	PI_XFER_DATA = 2,
	PI_XFER_VERIFY = 3,
	PI_XFER_ABORT = 4,
	PI_XFER_POLL = 5,
};

enum pi_xfer_status {
	PI_XFER_ACK = 0,
	PI_XFER_NAK = 1,
	PI_XFER_BUSY = 2,
};

/* What a NAK says. The Pi's end defines no others. */
enum pi_xfer_code {
	PI_XFER_OK = 0,
	/* Sent again: the frame arrived damaged. */
	PI_XFER_BAD_CRC = 1,
	/* Not the sequence number the Pi expects: its next_seq says which it does. */
	PI_XFER_BAD_SEQ = 2,
	/* Fatal from here on. */
	PI_XFER_BAD_STATE = 3,
	PI_XFER_BAD_TARGET = 4,
	PI_XFER_BAD_VERSION = 5,
	PI_XFER_NO_SPACE = 6,
	PI_XFER_WRITE_ERROR = 7,
	PI_XFER_HASH_MISMATCH = 8,
	PI_XFER_ABORTED = 9,
};

struct pi_xfer_transport {
	void *ctx;
	/*
	 * One transaction with the Pi selected: len bytes out of tx, and as many into rx unless rx is
	 * NULL. Before it starts, forget any rising edge of READY seen so far.
	 */
	int (*transfer)(void *ctx, const uint8_t *tx, uint8_t *rx, size_t len);
	/* Wait for a rising edge of READY since the last transfer: 0, or -ETIMEDOUT. */
	int (*wait_ready)(void *ctx, int timeout_ms);
	/* READY as it is now. */
	bool (*ready)(void *ctx);
};

struct pi_xfer_source {
	void *ctx;
	/* Exactly len bytes of the image from offset. */
	enum pi_err (*read)(void *ctx, uint32_t offset, uint8_t *buf, size_t len);
};

struct pi_xfer_image {
	uint32_t size;
	uint8_t sha256[PI_SHA256_SIZE];
	char version[OTA_PI_VERSION_MAX + 1];
};

struct pi_xfer_options {
	/* Bytes of image per DATA frame. The buffer must hold this plus PI_XFER_FRAME_OVERHEAD. */
	uint32_t chunk_size;
	uint8_t *buf;
	size_t buf_size;
	/* Sends of one frame before giving up. */
	int attempts;
	/* For READY after an ordinary transaction, after BEGIN (the Pi prepares partition B) and
	 * after VERIFY (the Pi hashes it all).
	 */
	int ready_timeout_ms;
	int begin_timeout_ms;
	int verify_timeout_ms;
	/* Set from another thread to stop: the Pi gets an ABORT. May be NULL. */
	const volatile bool *abort;
	/* Bytes of image the Pi has, after each ACK of a DATA frame. May be NULL. */
	void (*progress)(void *ctx, uint32_t sent, uint32_t total);
	void *progress_ctx;
};

struct pi_xfer_result {
	enum pi_err err;
	/* The code of the NAK that ended it, if one did. */
	uint8_t pi_code;
	/* Frames sent again. */
	uint32_t resends;
	/* Where the Pi asked to start (a BEGIN's next_seq), in chunks. */
	uint32_t started_at;
};

/* Build a frame in buf, around the payload already at buf + PI_XFER_HEADER_SIZE. Returns its length. */
size_t pi_xfer_frame(uint8_t *buf, enum pi_xfer_type type, uint32_t seq, uint32_t payload_len);

/* Send the image to the Pi. */
void pi_xfer_send(const struct pi_xfer_transport *transport, const struct pi_xfer_source *source,
		  const struct pi_xfer_image *image, const struct pi_xfer_options *options,
		  struct pi_xfer_result *result);

#endif /* PI_XFER_H_ */
