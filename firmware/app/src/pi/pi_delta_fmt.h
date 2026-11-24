/*
 * Raspberry Pi delta updates: the formats (docs/pi-delta-update.md). The signed block manifest that
 * tools/pi_image.py builds, the state header on the SD card, where everything sits on the card, and
 * the reasons a board gives on a job.
 *
 * Plain C with no Zephyr calls: tested on the host (firmware/tests/host/test_pi_delta.c). Every
 * number is little-endian.
 *
 * The package (one object in the firmware bucket, fetched with HTTP range requests):
 *
 *   offset 0             the manifest header, PI_MANIFEST_SIZE bytes, signed
 *   offset table_offset  one SHA-256 per block, block_count x 32 bytes
 *   offset image_offset  the image, image_size bytes
 *
 * The manifest header:
 *
 *   offset  size  field
 *        0     4  magic "CPDM"
 *        4     2  format, 1
 *        6     2  header size, 512
 *        8     4  block size: a power of two, 4 KiB to 1 MiB
 *       12     4  block count: the image size divided by the block size, rounded up
 *       16     8  image size: a whole number of 512-byte sectors
 *       24     8  table offset, 512
 *       32     8  image offset: a multiple of 4096, at or after the end of the table
 *       40    32  SHA-256 of the whole image
 *       72    32  SHA-256 of the table
 *      104    32  version: 1 to 31 of A-Z a-z 0-9 . _ + -, padded with zeros
 *      136     4  flags, 0
 *      140   308  zeros
 *      448    64  ECDSA P-256 signature (r then s, 32 bytes each, big-endian) over bytes 0 to 447,
 *                 with SHA-256, by the firmware signing key
 *
 * A block's hash is the SHA-256 of its bytes alone; the last block is shorter when the image size
 * is not a whole number of blocks.
 */

#ifndef PI_DELTA_FMT_H_
#define PI_DELTA_FMT_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PI_SECTOR_SIZE 512u
#define PI_HASH_SIZE   32u
#define PI_SIG_SIZE    64u
/* A Pi image's version: 1 to 31 characters, and room for the terminating zero. */
#define PI_VERSION_MAX 31u

#define PI_MANIFEST_SIZE        512u
#define PI_MANIFEST_SIGNED_SIZE 448u
#define PI_MANIFEST_FORMAT      1u
#define PI_BLOCK_SIZE_MIN       4096u
#define PI_BLOCK_SIZE_MAX       (1024u * 1024u)
/* Where the image starts in the package: a multiple of this. */
#define PI_IMAGE_ALIGN 4096u

/* The reasons on a job, and what each function here returns. */
enum pi_err {
	PI_OK = 0,
	/* The manifest header is not one this firmware reads. */
	PI_ERR_BAD_MANIFEST,
	/* Its signature does not hold. */
	PI_ERR_BAD_SIGNATURE,
	/* The job and the signed header disagree, or the table is not the one the header signs. */
	PI_ERR_MANIFEST_MISMATCH,
	/* More blocks than the card's layout holds, or an image larger than the card. */
	PI_ERR_TOO_LARGE,
	PI_ERR_SD_ABSENT,
	PI_ERR_SD_IO,
	/* The download failed: the caller tries again, with a fresh URL. */
	PI_ERR_DOWNLOAD,
	/* A block from the server does not match its hash, again and again. */
	PI_ERR_DIGEST_MISMATCH,
	/* A block written to the card reads back different. */
	PI_ERR_SD_READBACK,
	/* The job was withdrawn. */
	PI_ERR_ABORTED,
	PI_ERR_COUNT,
};

const char *pi_err_reason(enum pi_err err);

struct pi_manifest {
	uint32_t block_size;
	uint32_t block_count;
	uint64_t image_size;
	uint64_t table_offset;
	uint64_t image_offset;
	uint8_t image_sha256[PI_HASH_SIZE];
	uint8_t table_sha256[PI_HASH_SIZE];
	char version[PI_VERSION_MAX + 1];
	uint32_t flags;
	uint8_t sig[PI_SIG_SIZE];
};

/*
 * Read a header and check everything but its signature: the magic, the format, the sizes and how
 * they fit together, and the version's characters. PI_ERR_BAD_MANIFEST if any is wrong.
 */
enum pi_err pi_manifest_decode(const uint8_t raw[PI_MANIFEST_SIZE], struct pi_manifest *m);

/* The opposite, for the tests and for the record on the card. Zeros where the format has them. */
void pi_manifest_encode(const struct pi_manifest *m, uint8_t raw[PI_MANIFEST_SIZE]);

/* Bytes of the table: block_count hashes. */
uint64_t pi_manifest_table_size(const struct pi_manifest *m);

/* Bytes of one block: block_size, or less for the last. */
uint32_t pi_manifest_block_len(const struct pi_manifest *m, uint32_t block);

/* 1 to 31 of A-Z a-z 0-9 . _ + -, then zeros to the end of the field. */
bool pi_version_valid(const char *version, size_t field_size);

/*
 * The SD card, in 512-byte sectors (logical block addresses). Nothing below PI_CARD_BASE_LBA is
 * touched: tools/pi_image.py puts a partition table there that marks the rest as taken, so a
 * computer does not offer to format the card. Each area starts on a 1 MiB boundary, the mirror on a
 * 4 MiB one.
 *
 *   state 0, state 1   two copies of the state header, one sector each
 *   slot 0, slot 1     a manifest each: its header sector, then its table
 *   list               the blocks that changed in the last update, u32 each, in order
 *   staging            one block, where a downloaded block waits until its hash is checked
 *   mirror             the Pi's image, block i at mirror_lba + i * block_size / 512
 *
 * How large the slots and the list are depends on max_blocks, which the state header keeps.
 */
#define PI_CARD_BASE_LBA   2048u
#define PI_CARD_ALIGN      2048u
#define PI_CARD_MIRROR_ALIGN 8192u

struct pi_card_layout {
	uint64_t state_lba[2];
	uint64_t slot_lba[2];
	uint64_t list_lba;
	uint64_t staging_lba;
	uint64_t mirror_lba;
};

void pi_card_layout_for(uint32_t max_blocks, struct pi_card_layout *layout);

/* The state header, one sector. */
enum pi_mirror_state {
	/* No image on the card. */
	PI_STATE_EMPTY = 0,
	/* The mirror holds the image the current slot describes: the Pi may read it. */
	PI_STATE_READY = 1,
	/* The mirror is being written: the Pi must not take anything from it. */
	PI_STATE_UPDATING = 2,
};

enum pi_card_phase {
	PI_PHASE_NONE = 0,
	/* The new slot's table is downloading. The mirror is untouched. */
	PI_PHASE_TABLE = 1,
	/* The mirror is being brought to the new slot's image. */
	PI_PHASE_BLOCKS = 2,
};

/* The current slot describes the image the last update made (the base of the list). */
#define PI_FLAG_HAS_CUR    0x01u
/* The list describes the base and the current image. */
#define PI_FLAG_LIST_VALID 0x02u
/*
 * An update was replaced by one for another image half-way: the mirror holds parts of both, so
 * every block is checked, not only the listed ones.
 */
#define PI_FLAG_DIRTY      0x04u

#define PI_STATE_MAGIC  0x53445043u /* "CPDS" */
#define PI_STATE_FORMAT 1u

struct pi_card_state {
	uint32_t seq;
	uint32_t max_blocks;
	uint8_t state;
	uint8_t cur_slot;
	uint8_t new_slot;
	uint8_t phase;
	uint8_t flags;
	/* Goes up by one with each finished update. */
	uint32_t generation;
	uint32_t changed_count;
	/* PI_PHASE_TABLE: bytes of the table on the card. PI_PHASE_BLOCKS: the next candidate. */
	uint32_t next;
	/* The image the list starts from: the one before the last update, or empty. */
	char base_version[PI_VERSION_MAX + 1];
	uint8_t base_sha256[PI_HASH_SIZE];
};

/*
 *   offset  size  field
 *        0     4  magic "CPDS"
 *        4     2  format, 1
 *        8     4  sequence: of the two copies, the good one with the higher number counts
 *       12     4  max_blocks
 *       16     1  state, 17 current slot, 18 new slot, 19 phase, 20 flags
 *       24     4  generation
 *       28     4  changed count
 *       32     4  next
 *       36    32  base version
 *       68    32  base image SHA-256
 *      508     4  CRC-32 of bytes 0 to 507
 */
void pi_card_state_encode(const struct pi_card_state *st, uint8_t raw[PI_SECTOR_SIZE]);
/* False if the sector is not a state header: magic, format, CRC, or a field out of range. */
bool pi_card_state_decode(const uint8_t raw[PI_SECTOR_SIZE], struct pi_card_state *st);

/* Little-endian helpers, shared with the link. */
static inline void pi_put16(uint8_t *at, uint16_t v)
{
	at[0] = (uint8_t)v;
	at[1] = (uint8_t)(v >> 8);
}

static inline void pi_put32(uint8_t *at, uint32_t v)
{
	for (int i = 0; i < 4; i++) {
		at[i] = (uint8_t)(v >> (8 * i));
	}
}

static inline void pi_put64(uint8_t *at, uint64_t v)
{
	for (int i = 0; i < 8; i++) {
		at[i] = (uint8_t)(v >> (8 * i));
	}
}

static inline uint16_t pi_get16(const uint8_t *at)
{
	return (uint16_t)(at[0] | (at[1] << 8));
}

static inline uint32_t pi_get32(const uint8_t *at)
{
	return (uint32_t)at[0] | ((uint32_t)at[1] << 8) | ((uint32_t)at[2] << 16) |
	       ((uint32_t)at[3] << 24);
}

static inline uint64_t pi_get64(const uint8_t *at)
{
	return (uint64_t)pi_get32(at) | ((uint64_t)pi_get32(at + 4) << 32);
}

#endif /* PI_DELTA_FMT_H_ */
