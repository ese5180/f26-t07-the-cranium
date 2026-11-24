/*
 * Fakes for the Raspberry Pi delta update's host tests (test_pi_delta.c, pi_delta_harness.c): an
 * SD card in memory that can lose power, be pulled out or fail, and an HTTP server that hands out
 * ranges of a package in pieces of any size, and can drop the connection or send wrong bytes.
 */

#ifndef PI_DELTA_FAKES_H_
#define PI_DELTA_FAKES_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pi_card.h"
#include "pi_delta.h"

struct fake_disk {
	uint8_t *data;
	uint64_t sectors;
	/* Writes allowed before the power goes: the next one is torn, and then nothing works. -1: no limit. */
	long writes_left;
	bool dead;
	bool absent;
	/* Fail every read, or every write, with an I/O error while set. */
	bool fail_reads;
	bool fail_writes;
	/* The card is pulled out after this many more writes (-1: never). */
	long pull_after;
	/* Writes to sectors in [flip_from, flip_to) store one bit wrong, flip_times times. */
	uint64_t flip_from;
	uint64_t flip_to;
	int flip_times;
	uint64_t reads;
	uint64_t writes;
};

extern const struct pi_disk_ops fake_disk_ops;

void fake_disk_create(struct fake_disk *disk, uint64_t sectors);
void fake_disk_free(struct fake_disk *disk);
/* The power comes back: the card works again, with what was written. */
void fake_disk_power_on(struct fake_disk *disk);

struct fake_server {
	const uint8_t *package;
	uint64_t size;
	/* Pieces of 1 to max_piece bytes, of pseudo-random size. */
	uint32_t max_piece;
	uint32_t seed;
	/* The connection drops after this many bytes in all (-1: never), once. */
	long long drop_after;
	/* Bytes in [corrupt_from, corrupt_to) go out with a bit flipped, corrupt_times times. */
	uint64_t corrupt_from;
	uint64_t corrupt_to;
	int corrupt_times;
	/* After this many bytes in all (-1: never), *stop_flag is set, as a withdrawn job sets it. */
	long long stop_after;
	volatile bool *stop_flag;
	/* What went out. */
	uint64_t sent;
	uint32_t requests;
	/* Every request, as offset and length, for the tests that look at which blocks came. */
	uint64_t log_offset[4096];
	uint64_t log_len[4096];
};

int fake_server_get(void *ctx, uint64_t offset, uint64_t len, pi_sink_fn sink, void *sink_ctx);

/* A signature only the fakes make: SHA-256 of the message, then 32 bytes of 0xa5. */
bool fake_verify(const uint8_t *msg, size_t len, const uint8_t sig[PI_SIG_SIZE]);
void fake_sign(const uint8_t *msg, size_t len, uint8_t sig[PI_SIG_SIZE]);

/*
 * The package tools/pi_image.py builds, for an image in memory: header, table, image. *size is its
 * length; the caller frees it. The header is signed with fake_sign().
 */
uint8_t *fake_package(const uint8_t *image, uint64_t image_size, uint32_t block_size,
		      const char *version, uint64_t *size, struct pi_manifest *m);

#endif /* PI_DELTA_FAKES_H_ */
