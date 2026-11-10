#include "pi_xfer.h"

#include <errno.h>
#include <string.h>

/* How many times in a row the Pi may answer BUSY to the same frame. */
#define BUSY_POLLS_MAX 100

/*
 * The status the Pi clocks out during a POLL, 20 bytes, little-endian:
 *
 *   0   4  magic "CPR1"
 *   4   1  status: ACK 0, NAK 1, BUSY 2
 *   5   1  code (enum pi_xfer_code), 0 with an ACK
 *   6   2  reserved, 0
 *   8   4  the sequence number of the frame it answers
 *   12  4  next_seq: the DATA sequence number it expects next
 *   16  4  CRC-32 of bytes 0 to 15
 */
struct status {
	uint8_t status;
	uint8_t code;
	uint32_t seq;
	uint32_t next_seq;
};

static void put32(uint8_t *at, uint32_t value)
{
	at[0] = (uint8_t)value;
	at[1] = (uint8_t)(value >> 8);
	at[2] = (uint8_t)(value >> 16);
	at[3] = (uint8_t)(value >> 24);
}

static uint32_t get32(const uint8_t *at)
{
	return (uint32_t)at[0] | ((uint32_t)at[1] << 8) | ((uint32_t)at[2] << 16) |
	       ((uint32_t)at[3] << 24);
}

size_t pi_xfer_frame(uint8_t *buf, enum pi_xfer_type type, uint32_t seq, uint32_t payload_len)
{
	size_t crc_at = PI_XFER_HEADER_SIZE + payload_len;

	put32(buf, PI_XFER_MAGIC);
	buf[4] = (uint8_t)type;
	buf[5] = 0;
	buf[6] = 0;
	buf[7] = 0;
	put32(buf + 8, seq);
	put32(buf + 12, payload_len);
	put32(buf + crc_at, pi_image_crc32(0, buf, crc_at));
	return crc_at + PI_XFER_CRC_SIZE;
}

static bool parse_status(const uint8_t *rx, struct status *out)
{
	if (get32(rx) != PI_XFER_STATUS_MAGIC || get32(rx + 16) != pi_image_crc32(0, rx, 16) ||
	    rx[4] > PI_XFER_BUSY) {
		return false;
	}

	out->status = rx[4];
	out->code = rx[5];
	out->seq = get32(rx + 8);
	out->next_seq = get32(rx + 12);
	return true;
}

struct session {
	const struct pi_xfer_transport *transport;
	const struct pi_xfer_options *options;
	struct pi_xfer_result *result;
};

/*
 * One transaction, then the rising edge of READY that says the Pi has dealt with it. -ETIMEDOUT if
 * that does not come, -EIO if the transfer failed.
 */
static int transact(struct session *s, const uint8_t *tx, uint8_t *rx, size_t len, int timeout_ms)
{
	if (s->transport->transfer(s->transport->ctx, tx, rx, len) != 0) {
		return -EIO;
	}

	return s->transport->wait_ready(s->transport->ctx, timeout_ms);
}

/* Read the Pi's answer to the frame just sent. */
static int poll_status(struct session *s, uint32_t seq, struct status *status)
{
	uint8_t tx[PI_XFER_STATUS_SIZE];
	uint8_t rx[PI_XFER_STATUS_SIZE];
	int err;

	memset(tx, 0, sizeof(tx));
	(void)pi_xfer_frame(tx, PI_XFER_POLL, seq, 0);
	memset(rx, 0, sizeof(rx));

	err = transact(s, tx, rx, sizeof(tx), s->options->ready_timeout_ms);
	if (err != 0) {
		return err;
	}

	return parse_status(rx, status) ? 0 : -EBADMSG;
}

/*
 * Send a frame of len bytes and wait for its answer: 0 on an ACK (with *status filled in), or a
 * pi_err. A NAK for BAD_SEQ comes back as 0 too, with status->status NAK, for the caller to
 * decide. Anything that sending it again may cure is sent again.
 */
static enum pi_err exchange(struct session *s, const uint8_t *frame, size_t len, uint32_t seq,
			    int timeout_ms, struct status *status)
{
	enum pi_err last = PI_ERR_PI_TIMEOUT;

	for (int attempt = 0; attempt < s->options->attempts; attempt++) {
		int busy = 0;
		int err;

		if (attempt > 0) {
			s->result->resends++;
		}

		err = transact(s, frame, NULL, len, timeout_ms);
		if (err == -EIO) {
			last = PI_ERR_LINK_IO;
			continue;
		}
		if (err != 0) {
			last = PI_ERR_PI_TIMEOUT;
			continue;
		}

		for (;;) {
			err = poll_status(s, seq, status);
			if (err != 0 || status->status != PI_XFER_BUSY || ++busy > BUSY_POLLS_MAX) {
				break;
			}
		}

		if (err == -EIO) {
			last = PI_ERR_LINK_IO;
			continue;
		}
		if (err != 0 || status->status == PI_XFER_BUSY) {
			/* No answer, a damaged one, or busy for too long: send it again. */
			last = PI_ERR_PI_TIMEOUT;
			continue;
		}

		if (status->status == PI_XFER_ACK && status->seq == seq) {
			return PI_OK;
		}

		if (status->status == PI_XFER_ACK) {
			/* An answer to some other frame: this one may not have arrived. */
			last = PI_ERR_PI_TIMEOUT;
			continue;
		}

		/* A NAK. */
		if (status->code == PI_XFER_BAD_CRC) {
			last = PI_ERR_PI_TIMEOUT;
			continue;
		}
		if (status->code == PI_XFER_BAD_SEQ) {
			return PI_OK;
		}

		s->result->pi_code = status->code;
		return status->code == PI_XFER_HASH_MISMATCH ? PI_ERR_PI_VERIFY
							      : PI_ERR_PI_REJECTED;
	}

	return last;
}

/* Tell the Pi to drop what it has of this image. Its answer changes nothing. */
static void send_abort(struct session *s, uint8_t *buf, uint32_t seq, uint16_t reason)
{
	struct status status;
	size_t len;

	buf[PI_XFER_HEADER_SIZE] = (uint8_t)reason;
	buf[PI_XFER_HEADER_SIZE + 1] = (uint8_t)(reason >> 8);
	buf[PI_XFER_HEADER_SIZE + 2] = 0;
	buf[PI_XFER_HEADER_SIZE + 3] = 0;
	len = pi_xfer_frame(buf, PI_XFER_ABORT, seq, 4);
	(void)exchange(s, buf, len, seq, s->options->ready_timeout_ms, &status);
}

static bool aborted(const struct pi_xfer_options *options)
{
	return options->abort != NULL && *options->abort;
}

void pi_xfer_send(const struct pi_xfer_transport *transport, const struct pi_xfer_source *source,
		  const struct pi_xfer_image *image, const struct pi_xfer_options *options,
		  struct pi_xfer_result *result)
{
	struct session s = { .transport = transport, .options = options, .result = result };
	uint32_t chunk = options->chunk_size;
	uint32_t chunks;
	uint8_t *buf = options->buf;
	uint8_t *payload = buf + PI_XFER_HEADER_SIZE;
	struct pi_sha256 readback;
	bool readback_valid;
	struct status status;
	uint32_t seq;
	size_t len;
	enum pi_err err;

	memset(result, 0, sizeof(*result));

	if (chunk == 0 || options->buf_size < (size_t)chunk + PI_XFER_FRAME_OVERHEAD ||
	    options->buf_size < PI_XFER_HEADER_SIZE + PI_XFER_BEGIN_SIZE + PI_XFER_CRC_SIZE ||
	    options->attempts < 1) {
		result->err = PI_ERR_LINK_IO;
		return;
	}

	chunks = image->size / chunk + (image->size % chunk != 0 ? 1 : 0);

	/* The Pi says it is there and idle by holding READY high. */
	if (!transport->ready(transport->ctx) &&
	    transport->wait_ready(transport->ctx, options->begin_timeout_ms) != 0) {
		result->err = PI_ERR_PI_NOT_READY;
		return;
	}

	/* BEGIN: what is coming, and where it goes. */
	memset(payload, 0, PI_XFER_BEGIN_SIZE);
	payload[0] = (uint8_t)PI_XFER_PROTOCOL;
	payload[1] = (uint8_t)(PI_XFER_PROTOCOL >> 8);
	payload[2] = PI_XFER_PARTITION_B;
	put32(payload + 4, chunk);
	put32(payload + 8, image->size);
	put32(payload + 12, 0);
	memcpy(payload + 16, image->sha256, PI_SHA256_SIZE);
	strncpy((char *)payload + 48, image->version, 31);
	len = pi_xfer_frame(buf, PI_XFER_BEGIN, 0, PI_XFER_BEGIN_SIZE);

	err = exchange(&s, buf, len, 0, options->begin_timeout_ms, &status);
	if (err == PI_OK && status.status != PI_XFER_ACK) {
		err = PI_ERR_PI_REJECTED;
		result->pi_code = status.code;
	}
	if (err != PI_OK) {
		result->err = err;
		return;
	}

	/* The Pi may already have the first chunks of this image: it says where to start. */
	seq = status.next_seq <= chunks ? status.next_seq : 0;
	result->started_at = seq;
	readback_valid = (seq == 0);
	pi_sha256_init(&readback);

	while (seq < chunks) {
		uint32_t offset = seq * chunk;
		uint32_t size = (image->size - offset < chunk) ? image->size - offset : chunk;

		if (aborted(options)) {
			send_abort(&s, buf, seq, PI_XFER_ABORTED);
			result->err = PI_ERR_ABORTED;
			return;
		}

		/* The bus is the SD card's for the read, then the Pi's for the frame. */
		put32(payload, offset);
		err = source->read(source->ctx, offset, payload + PI_XFER_DATA_PREFIX, size);
		if (err != PI_OK) {
			send_abort(&s, buf, seq, PI_XFER_ABORTED);
			result->err = err;
			return;
		}

		if (readback_valid) {
			pi_sha256_update(&readback, payload + PI_XFER_DATA_PREFIX, size);
		}

		len = pi_xfer_frame(buf, PI_XFER_DATA, seq, PI_XFER_DATA_PREFIX + size);
		err = exchange(&s, buf, len, seq, options->ready_timeout_ms, &status);
		if (err != PI_OK) {
			if (err != PI_ERR_PI_REJECTED && err != PI_ERR_PI_VERIFY) {
				send_abort(&s, buf, seq, PI_XFER_ABORTED);
			}
			result->err = err;
			return;
		}

		if (status.status == PI_XFER_NAK) {
			/* BAD_SEQ: the Pi wants another chunk. Only one it has had, or this one. */
			if (status.next_seq > seq) {
				send_abort(&s, buf, seq, PI_XFER_BAD_SEQ);
				result->err = PI_ERR_PI_REJECTED;
				result->pi_code = PI_XFER_BAD_SEQ;
				return;
			}
			seq = status.next_seq;
			readback_valid = false;
			result->resends++;
			continue;
		}

		seq++;
		if (options->progress != NULL) {
			options->progress(options->progress_ctx,
					  seq == chunks ? image->size : seq * chunk, image->size);
		}
	}

	/* What came off the card is what was downloaded and checked, or the Pi gets nothing more. */
	if (readback_valid) {
		uint8_t digest[PI_SHA256_SIZE];

		pi_sha256_final(&readback, digest);
		if (memcmp(digest, image->sha256, PI_SHA256_SIZE) != 0) {
			send_abort(&s, buf, chunks, PI_XFER_HASH_MISMATCH);
			result->err = PI_ERR_SD_READBACK;
			return;
		}
	}

	/* VERIFY: the Pi hashes partition B and checks it against the whole image's digest. */
	put32(payload, image->size);
	put32(payload + 4, 0);
	memcpy(payload + 8, image->sha256, PI_SHA256_SIZE);
	len = pi_xfer_frame(buf, PI_XFER_VERIFY, chunks, 8 + PI_SHA256_SIZE);
	err = exchange(&s, buf, len, chunks, options->verify_timeout_ms, &status);
	if (err == PI_OK && status.status != PI_XFER_ACK) {
		err = PI_ERR_PI_VERIFY;
		result->pi_code = status.code;
	}

	result->err = err;
}
