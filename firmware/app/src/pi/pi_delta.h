/*
 * Raspberry Pi delta update, the engine (docs/pi-delta-update.md, "The update"): brings the mirror
 * of the Pi's image on the SD card to a new image by downloading only the blocks that changed.
 *
 *   1. The manifest's header: fetched (512 bytes), its signature checked, and held against the job.
 *   2. Its table of block hashes: fetched into the slot the current image does not use, hashed on
 *      the way, and checked against the hash the header signs. Saved every few sectors, so a restart
 *      goes on from there.
 *   3. The two tables compared, a sector of each at a time: the list of changed blocks. From here
 *      the card says "updating", and the Pi takes nothing from it.
 *   4. Each changed block: unless the mirror already holds it (its hash matches), fetched with an
 *      HTTP range request (runs of neighbours together) into the staging block, hashed, and only
 *      if the hash matches copied into the mirror, read back and checked again. The state on the
 *      card moves past it.
 *   5. The new slot becomes the current one, the generation goes up, and the card says "ready".
 *
 * Every call starts from what the card says, so a call after a power cut, a lost connection or a
 * card taken out goes on where the last one stopped.
 *
 * Plain C: the network, the signature check and the card come in as operations, so that the whole
 * of it runs on the host (firmware/tests/host/test_pi_delta.c, and firmware/tests/host/
 * pi_delta_harness.c for tools/pi_delta_sim.py). pi_delta_ota.c runs it on a board.
 */

#ifndef PI_DELTA_H_
#define PI_DELTA_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pi_card.h"
#include "pi_delta_fmt.h"
#include "pi_sha256.h"

/* What a job names: the image it brings. The signed header has to say the same. */
struct pi_delta_job {
	char version[PI_VERSION_MAX + 1];
	uint8_t sha256[PI_HASH_SIZE];
};

/*
 * Takes the bytes of a range in order: 0 to go on, 1 when it has all it wanted (the fetch ends
 * there, with success), -1 to stop with the error it keeps.
 */
typedef int (*pi_sink_fn)(void *sink_ctx, const uint8_t *data, size_t len);

struct pi_fetch {
	/*
	 * Bytes offset to offset + len - 1 of the package, given to sink in order. Returns 0 once the
	 * sink returned 1 or took every byte, and anything else if the transfer failed or the sink
	 * stopped it.
	 */
	int (*get)(void *ctx, uint64_t offset, uint64_t len, pi_sink_fn sink, void *sink_ctx);
	void *ctx;
};

/* ECDSA P-256 with SHA-256 over msg, by the project's key. */
typedef bool (*pi_verify_fn)(const uint8_t *msg, size_t len, const uint8_t sig[PI_SIG_SIZE]);

enum pi_delta_step {
	PI_STEP_IDLE = 0,
	PI_STEP_MANIFEST,
	PI_STEP_TABLE,
	PI_STEP_COMPARE,
	PI_STEP_BLOCKS,
	PI_STEP_DONE,
};

struct pi_delta_config {
	/* The layout of a card that has none yet: the most blocks an image may have. */
	uint32_t default_max_blocks;
	/* The most neighbouring blocks in one range request. */
	uint32_t run_blocks;
	/* Times a block may come with the wrong hash, or read back wrong, before the job fails. */
	uint32_t block_attempts;
	/* Blocks found already in place between two saves of the state. */
	uint32_t skip_save_every;
	/* Sectors of the table between two saves of the state. */
	uint32_t table_save_every;
};

struct pi_delta_stats {
	/* Blocks this update looks at (the changed ones, or all of them), and how far it is. */
	uint32_t blocks_total;
	uint32_t blocks_done;
	/* In this call: blocks downloaded, blocks found already in place, bytes and range requests. */
	uint32_t blocks_fetched;
	uint32_t blocks_skipped;
	uint64_t bytes_fetched;
	uint32_t requests;
	/* The changed blocks of the update (the list), once compared. */
	uint32_t changed;
};

struct pi_delta_run_state {
	uint32_t first_k;
	uint32_t first_block;
	uint32_t count;
	uint32_t index;
	uint32_t in_block;
	uint32_t in_sector;
	uint64_t received;
	uint64_t wanted;
	enum pi_err err;
};

struct pi_delta {
	struct pi_card *card;
	const struct pi_delta_config *cfg;
	const struct pi_fetch *fetch;
	pi_verify_fn verify;
	/* Set by another thread when the job is withdrawn. */
	const volatile bool *stop;

	/* Read by other threads for reports; each field on its own. */
	volatile uint8_t step;
	struct pi_delta_stats stats;

	struct pi_manifest target;
	struct pi_delta_run_state run;
	struct pi_sha256 sha;
	/* A block the look-ahead found in place, or UINT32_MAX. */
	uint32_t known_good;
	/* The header, a sector on its way to the card, a sector being copied or checked. */
	uint8_t io[PI_SECTOR_SIZE];
	/* A sector of the list. */
	uint8_t list[PI_SECTOR_SIZE];
	uint64_t list_lba;
	/* A sector of a table. */
	uint8_t table[PI_SECTOR_SIZE];
	uint64_t table_lba;
};

void pi_delta_init(struct pi_delta *d, struct pi_card *card, const struct pi_delta_config *cfg,
		   const struct pi_fetch *fetch, pi_verify_fn verify, const volatile bool *stop);

/*
 * Bring the mirror to job's image, or go on doing so. PI_OK when the card says "ready" with that
 * image; *already is then true if it did before this call. PI_ERR_DOWNLOAD for a transfer that
 * failed, which the caller tries again (with a fresh URL); any other error ends the job.
 */
enum pi_err pi_delta_run(struct pi_delta *d, const struct pi_delta_job *job, bool *already);

/* A step's name in reports: "idle", "manifest", "table", "compare", "blocks" or "done". */
const char *pi_step_name(uint8_t step);

/*
 * The longest report pi_delta_report() writes, with its terminating zero: an updating card, a
 * version of PI_VERSION_MAX characters, the longest step and every number at 32 bits.
 */
#define PI_DELTA_REPORT_MAX                                                                        \
	(sizeof("{\"card\":\"updating\",\"version\":\"\",\"generation\":4294967295,"                 \
		"\"step\":\"manifest\",\"done\":4294967295,\"total\":4294967295}") +                   \
	 PI_VERSION_MAX)

/*
 * The card and the update, as a board reports them with its heartbeat (pi_delta_ota_report()):
 * {"card":"updating","version":"2026.11.24-1","generation":3,"step":"blocks","done":4,"total":10}.
 *
 * card is "empty", "ready", "updating" or "no_card". version is the image on the card, or the one
 * an update brings it to; "" for none, and for one that is not a valid version, so that nothing
 * read from a card can break the JSON. generation is 0 with no card. step is "idle" unless job is
 * true. done and total count the blocks of the update, done never more than total.
 *
 * The caller holds the card's lock (pi_card_lock()): the update's thread and the Pi's link change
 * the card's state under it. The step and the counts are read a word at a time, without it. The
 * length written, or -ENOSPC if len is too small.
 */
int pi_delta_report(const struct pi_delta *d, bool job, char *buf, size_t len);

#endif /* PI_DELTA_H_ */
