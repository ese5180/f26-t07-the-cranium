/*
 * SHA-256 (FIPS 180-4) in plain C, for Raspberry Pi delta updates (docs/pi-delta-update.md).
 *
 * The board's firmware path hashes through PSA, which goes through TF-M on every call. A Pi update
 * hashes every block it downloads, reads back from the SD card or compares, in pieces of one card
 * sector, so this one runs in the application with no secure call per piece, and it builds on the
 * host for the tests. A Cortex-M33 hashes far faster than the card and the network deliver.
 *
 * No hardware dependency: tested on the host (firmware/tests/host/test_pi_delta.c).
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

#endif /* PI_SHA256_H_ */
