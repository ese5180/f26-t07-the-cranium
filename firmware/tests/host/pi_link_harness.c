/*
 * The board's end of the SPI protocol to the Raspberry Pi (src/pi/pi_link.c), on the host, with its
 * SPI bus and READY line on stdin and stdout, for firmware/tests/hil/test_pi_link.py, which plays
 * the Pi with tools/pi_link_sim.py.
 *
 *   pi_link_harness <image file> <chunk bytes> [--corrupt-at OFFSET] [--abort-at SEQ]
 *                   [--attempts N] [--reset-at SEQ]
 *
 * The image is what the SD card would hold. --corrupt-at flips a bit of it as it is read, as a
 * card that went bad after the download would; the digest stays the right one. --abort-at sets the
 * flag that a withdrawn job sets, when that chunk is about to be read. --reset-at stops the board
 * dead when that chunk is about to be read, as a restart would: no ABORT, nothing more on the bus.
 *
 * Messages, little-endian. To the Pi: 'X', u32 length, the bytes the board clocks out, u8 1 if it
 * reads what comes back. From the Pi: those bytes if asked for, then u8 1 if READY rose after the
 * transaction. 'W' asks for READY without a transaction: u8 1 if it rose. 'L': u8 READY's level.
 * At the end, 'E' and the result: i32 pi_err, u8 code of the NAK, u32 resends, u32 started_at.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "pi_link.h"
#include "pi_sha256.h"

static uint8_t *image;
static uint32_t image_size;
static long corrupt_at = -1;
static long abort_at = -1;
static long reset_at = -1;
static uint32_t chunk_size;
static volatile bool abort_flag;
static int pending_edge = -1;

static void put(const void *data, size_t len)
{
	if (fwrite(data, 1, len, stdout) != len) {
		exit(3);
	}
}

static void put32(uint32_t value)
{
	uint8_t bytes[4] = { (uint8_t)value, (uint8_t)(value >> 8), (uint8_t)(value >> 16),
			     (uint8_t)(value >> 24) };

	put(bytes, sizeof(bytes));
}

static void get(void *data, size_t len)
{
	if (fread(data, 1, len, stdin) != len) {
		exit(4);
	}
}

static uint8_t get8(void)
{
	uint8_t value;

	get(&value, 1);
	return value;
}

static int transfer(void *ctx, const uint8_t *tx, uint8_t *rx, size_t len)
{
	uint8_t want = rx != NULL;

	(void)ctx;
	put("X", 1);
	put32((uint32_t)len);
	put(tx, len);
	put(&want, 1);
	fflush(stdout);
	if (rx != NULL) {
		get(rx, len);
	}
	pending_edge = get8();
	return 0;
}

static int wait_ready(void *ctx, int timeout_ms)
{
	int edge = pending_edge;

	(void)ctx;
	(void)timeout_ms;
	pending_edge = -1;
	if (edge < 0) {
		put("W", 1);
		fflush(stdout);
		edge = get8();
	}
	return edge == 1 ? 0 : -ETIMEDOUT;
}

static bool ready(void *ctx)
{
	(void)ctx;
	put("L", 1);
	fflush(stdout);
	return get8() == 1;
}

/* The board restarts: the end message says so, and nothing else reaches the Pi. */
static void reset_now(void)
{
	static const uint8_t no_code;

	put("E", 1);
	put32((uint32_t)PI_ERR_ABORTED);
	put(&no_code, 1);
	put32(0);
	put32(0);
	fflush(stdout);
	fprintf(stderr, "reset\n");
	exit(0);
}

static enum pi_err source_read(void *ctx, uint32_t offset, uint8_t *buf, size_t len)
{
	(void)ctx;
	if (reset_at >= 0 && offset / chunk_size == (uint32_t)reset_at) {
		reset_now();
	}
	if (abort_at >= 0 && offset / chunk_size == (uint32_t)abort_at) {
		abort_flag = true;
	}
	if ((uint64_t)offset + len > image_size) {
		return PI_ERR_SD_IO;
	}
	memcpy(buf, image + offset, len);
	if (corrupt_at >= (long)offset && corrupt_at < (long)(offset + len)) {
		buf[corrupt_at - offset] ^= 0x01;
	}
	return PI_OK;
}

int main(int argc, char **argv)
{
	struct pi_link_transport transport = {
		.transfer = transfer, .wait_ready = wait_ready, .ready = ready
	};
	struct pi_link_source source = { .read = source_read };
	struct pi_link_image info;
	struct pi_link_options options = {
		.ready_timeout_ms = 100,
		.begin_timeout_ms = 100,
		.verify_timeout_ms = 100,
		.attempts = 5,
		.abort = &abort_flag,
	};
	struct pi_link_result result;
	struct pi_sha256 hash;
	FILE *file;
	long size;

	if (argc < 3) {
		fprintf(stderr, "usage: %s <image> <chunk> [options]\n", argv[0]);
		return 2;
	}

	for (int i = 3; i + 1 < argc; i += 2) {
		if (strcmp(argv[i], "--corrupt-at") == 0) {
			corrupt_at = atol(argv[i + 1]);
		} else if (strcmp(argv[i], "--abort-at") == 0) {
			abort_at = atol(argv[i + 1]);
		} else if (strcmp(argv[i], "--attempts") == 0) {
			options.attempts = atoi(argv[i + 1]);
		} else if (strcmp(argv[i], "--reset-at") == 0) {
			reset_at = atol(argv[i + 1]);
		} else {
			return 2;
		}
	}

	file = fopen(argv[1], "rb");
	if (file == NULL || fseek(file, 0, SEEK_END) != 0 || (size = ftell(file)) <= 0) {
		return 2;
	}
	rewind(file);
	image_size = (uint32_t)size;
	image = malloc(image_size);
	if (fread(image, 1, image_size, file) != image_size) {
		return 2;
	}
	fclose(file);

	memset(&info, 0, sizeof(info));
	info.size = image_size;
	pi_sha256_init(&hash);
	pi_sha256_update(&hash, image, image_size);
	pi_sha256_final(&hash, info.sha256);
	strcpy(info.version, "2026.11.06-1");

	chunk_size = (uint32_t)atol(argv[2]);
	options.chunk_size = chunk_size;
	options.buf_size = chunk_size + PI_LINK_FRAME_OVERHEAD;
	if (options.buf_size < PI_LINK_HEADER_SIZE + PI_LINK_BEGIN_SIZE + PI_LINK_CRC_SIZE) {
		options.buf_size = PI_LINK_HEADER_SIZE + PI_LINK_BEGIN_SIZE + PI_LINK_CRC_SIZE;
	}
	options.buf = malloc(options.buf_size);

	pi_link_send(&transport, &source, &info, &options, &result);

	put("E", 1);
	put32((uint32_t)result.err);
	put(&result.pi_code, 1);
	put32(result.resends);
	put32(result.started_at);
	fflush(stdout);
	fprintf(stderr, "%s\n", pi_err_reason(result.err));
	free(options.buf);
	free(image);
	return 0;
}
