/*
 * The frames of the SPI link from the Raspberry Pi (docs/pi-link.md). The Pi is the SPI controller
 * and starts every transfer; each transfer is one frame each way, PI_FRAME_SIZE bytes long.
 *
 *   offset  size  field
 *        0     2  magic "CL"
 *        2     1  version, 1
 *        3     1  type (enum pi_frame_type)
 *        4     2  session: from the Pi, a number it picks at random when it starts, never 0;
 *                 from the board, the session of the last DATA frame it accepted, or 0 for none
 *        6     2  seq: from the Pi, the number of this DATA frame in its session
 *        8     2  ack: from the board, the seq of the last DATA frame it accepted
 *       10     2  length of the payload, at most PI_FRAME_PAYLOAD_MAX
 *       12     n  payload: for DATA, one message (a JSON line, without its line ending)
 *     12+n     4  CRC-32 (IEEE 802.3, as zlib's crc32) of everything before it
 *
 * Numbers are little-endian. The rest of the frame, after the CRC, is ignored.
 *
 * Plain C with no Zephyr calls: pi_link.c does the SPI and the pins.
 */

#ifndef PI_FRAME_H_
#define PI_FRAME_H_

#include <stddef.h>
#include <stdint.h>

#define PI_FRAME_SIZE        512
#define PI_FRAME_HEADER      12
#define PI_FRAME_CRC         4
#define PI_FRAME_PAYLOAD_MAX (PI_FRAME_SIZE - PI_FRAME_HEADER - PI_FRAME_CRC)
#define PI_FRAME_VERSION     1

enum pi_frame_type {
	/* Pi to board: a message. */
	PI_FRAME_DATA = 0x01,
	/* Pi to board: nothing, only to read the board's status. */
	PI_FRAME_POLL = 0x02,
	/* Board to Pi: what it has accepted. */
	PI_FRAME_STATUS = 0x81,
};

struct pi_frame {
	uint8_t type;
	uint16_t session;
	uint16_t seq;
	uint16_t ack;
	uint16_t length;
	/* Points into the buffer the frame was decoded from, or the payload to encode. */
	const uint8_t *payload;
};

enum pi_frame_result {
	PI_FRAME_OK,
	/* Nothing was clocked in: no bytes, or only 0x00 or 0xff. */
	PI_FRAME_NOTHING,
	PI_FRAME_BAD_MAGIC,
	PI_FRAME_BAD_VERSION,
	PI_FRAME_BAD_LENGTH,
	PI_FRAME_BAD_CRC,
};

uint32_t pi_crc32(const uint8_t *data, size_t length);

/*
 * Writes the frame at the start of buf. Returns the bytes written (header, payload and CRC), or 0 if
 * the payload is longer than PI_FRAME_PAYLOAD_MAX or buf is too small. The rest of buf is left as it is.
 */
size_t pi_frame_encode(uint8_t *buf, size_t size, const struct pi_frame *frame);

/* Reads a frame from the first `received` bytes of buf. */
enum pi_frame_result pi_frame_decode(const uint8_t *buf, size_t received, struct pi_frame *frame);

#endif /* PI_FRAME_H_ */
