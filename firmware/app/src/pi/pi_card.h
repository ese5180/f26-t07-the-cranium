/*
 * The SD card of a Raspberry Pi delta update, in raw sectors (docs/pi-delta-update.md, "The SD
 * card"). This keeps the state header, the two manifest slots, the list of changed blocks, the
 * staging block and the mirror of the Pi's image where pi_delta_fmt.h says, through a small set of
 * sector operations: Zephyr's disk access on a board (pi_card_disk.c), memory or a file on the
 * host.
 *
 * Raw sectors and no file system: a Pi image can be larger than FAT32's 4 GiB limit, a raw layout
 * takes no RAM for a file system, and a sector written is a sector on the card, which is what
 * surviving a power cut rests on.
 *
 * The update (pi_delta.c, its own thread) and the Pi's link (pi_dlink.c, its work queue) share one
 * card: every function here that touches it takes the lock the operations provide.
 */

#ifndef PI_CARD_H_
#define PI_CARD_H_

#include <stdbool.h>
#include <stdint.h>

#include "pi_delta_fmt.h"

struct pi_disk_ops {
	/* Read or write count sectors at lba. 0, or a negative errno. */
	int (*read)(void *ctx, uint64_t lba, uint8_t *buf, uint32_t count);
	int (*write)(void *ctx, uint64_t lba, const uint8_t *buf, uint32_t count);
	/* Starts the card if it needs it, and says how many sectors it has. */
	int (*open)(void *ctx, uint64_t *sectors);
	/* The card-detect switch: false when the slot is empty. NULL if there is none. */
	bool (*present)(void *ctx);
	/* Around every use of the card, from either side. NULL on the host. */
	void (*lock)(void *ctx);
	void (*unlock)(void *ctx);
};

struct pi_card {
	const struct pi_disk_ops *ops;
	void *ctx;
	bool open;
	uint64_t sectors;
	struct pi_card_layout layout;
	/* What the card says now: the last state saved or read. */
	struct pi_card_state st;
	/* Which copy holds it: the next save goes to the other one. */
	uint8_t copy;
	/* The headers of the current and the new slot, when the state names them. */
	struct pi_manifest cur;
	struct pi_manifest neu;
	/* For the state and the slot headers. */
	uint8_t sector[PI_SECTOR_SIZE];
	/* Goes up with each open: a copy of the card's sectors made under another count is stale. */
	uint32_t opens;
	/*
	 * From 1.20.2, the file area (pi_os.h): what its header says, and two things only RAM knows.
	 * Changed under the lock, by the update's thread and by the Pi's link.
	 */
	struct pi_card_file {
		uint32_t seq;
		uint32_t generation;
		uint32_t size;
		uint32_t done;
		uint64_t lba;
		/* The most of this generation the Pi has read (RAM only): offset and length. */
		uint32_t read;
		/* Which copy holds the header: the next save goes to the other one. */
		uint8_t copy;
		uint8_t state;
		uint8_t result;
		/* A job offers the file to the Pi now (RAM only): FILE_READ is refused otherwise. */
		bool offered;
		char reason[PI_OS_REASON_MAX + 1];
	} file;
	/*
	 * What the Pi last said about itself (OS_STATUS): kept here because the link and the reports
	 * share the card's lock. Not the card's: an open or a close leaves it as it is.
	 */
	struct pi_os_status {
		bool known;
		/* 'a', 'b', or 0 for not known. */
		uint8_t slot;
		uint8_t trial;
		/* The last result the Pi gave, in its status or with RESULT (enum pi_os_result). */
		uint8_t last;
		/* "" when it did not say, or said something that is not a version. */
		char version[PI_VERSION_MAX + 1];
	} os;
};

void pi_card_init(struct pi_card *card, const struct pi_disk_ops *ops, void *ctx);

/*
 * Open the card and read its state. A card with no good state header is an empty one, laid out for
 * default_max_blocks; nothing is written until the first save. PI_ERR_SD_ABSENT with no card,
 * PI_ERR_SD_IO if it cannot be read, PI_ERR_TOO_LARGE if it is too small for its own layout.
 */
enum pi_err pi_card_open(struct pi_card *card, uint32_t default_max_blocks);

/* Forget what was read, so that the next open reads the card again (a card taken out). */
void pi_card_close(struct pi_card *card);

/* Write st to the copy that does not hold the last good one, with the next sequence number. */
enum pi_err pi_card_save(struct pi_card *card);

/* A slot's header: write it, or read it (and check it) into card->cur or card->neu. */
enum pi_err pi_card_write_slot_header(struct pi_card *card, uint8_t slot,
				      const uint8_t raw[PI_MANIFEST_SIZE]);
enum pi_err pi_card_read_slot_raw(struct pi_card *card, uint8_t slot, uint8_t raw[PI_MANIFEST_SIZE]);

/* Sectors, locked, with errors as reasons: PI_ERR_SD_ABSENT when the slot is empty. */
enum pi_err pi_card_read(struct pi_card *card, uint64_t lba, uint8_t *buf, uint32_t count);
enum pi_err pi_card_write(struct pi_card *card, uint64_t lba, const uint8_t *buf, uint32_t count);

/* The first sector of block `block` of the mirror, for a manifest with that block size. */
uint64_t pi_card_block_lba(const struct pi_card *card, uint32_t block_size, uint32_t block);

/* The image fits on this card behind its layout, and below the file area while it holds a file. */
bool pi_card_fits(const struct pi_card *card, uint64_t image_size);

/* The first sector past the mirror's images: the current one and an update's, whichever is longer. */
uint64_t pi_card_mirror_end(const struct pi_card *card);

/*
 * The file's header (PI_FILE_HEADER_LBA), as a raw sector. Load reads the copy that counts and
 * checks it is the one card->file says (PI_ERR_SD_IO otherwise). Store writes raw, as changed, to the
 * other copy with the next sequence number and its CRC, and only then takes what it says into
 * card->file: a store that fails leaves the card, and card->file, as they were. A new generation or a
 * file that is not ready is no longer offered. Both lock the card.
 */
enum pi_err pi_card_file_load(struct pi_card *card, uint8_t raw[PI_SECTOR_SIZE]);
enum pi_err pi_card_file_store(struct pi_card *card, uint8_t raw[PI_SECTOR_SIZE]);

static inline void pi_card_lock(struct pi_card *card)
{
	if (card->ops->lock != NULL) {
		card->ops->lock(card->ctx);
	}
}

static inline void pi_card_unlock(struct pi_card *card)
{
	if (card->ops->unlock != NULL) {
		card->ops->unlock(card->ctx);
	}
}

#endif /* PI_CARD_H_ */
