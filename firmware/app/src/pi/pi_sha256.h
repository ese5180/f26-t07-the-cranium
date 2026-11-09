/*
 * SHA-256 (FIPS 180-4) in plain C, for the Raspberry Pi image (docs/pi-ota.md).
 *
 * The firmware path hashes through PSA. This one is its own because a download of a Pi image is
 * resumed: the state of the hash after the last checkpoint is saved on the SD card with the image,
 * and PSA has no way to export a hash operation. At a checkpoint the state is a whole number of
 * blocks, so struct pi_sha256 is all there is to save. Speed is no concern: a Cortex-M33 at 64 MHz
 * hashes far faster than the SD card and the network deliver.
 *
 * No hardware dependency: tested on the host (firmware/tests/host/test_pi_ota.c).
 */

#ifndef PI_SHA256_H_
#define PI_SHA256_H_

#include <stddef.h>
#include <stdint.h>

#define PI_SHA256_SIZE 32

struct pi_sha256 {
	uint32_t state[8];
	/* Bytes hashed so far. */
	uint64_t length;
	uint8_t block[64];
	/* Bytes of block in use: 0 at every multiple of 64. */
	uint32_t used;
};

void pi_sha256_init(struct pi_sha256 *ctx);
void pi_sha256_update(struct pi_sha256 *ctx, const void *data, size_t len);
/* Leaves ctx unusable until pi_sha256_init(). */
void pi_sha256_final(struct pi_sha256 *ctx, uint8_t digest[PI_SHA256_SIZE]);

/* The digest of what has been hashed so far, without ending ctx. */
void pi_sha256_peek(const struct pi_sha256 *ctx, uint8_t digest[PI_SHA256_SIZE]);

#endif /* PI_SHA256_H_ */
