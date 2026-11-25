/*
 * Raspberry Pi OS updates with A/B slots and tryboot (docs/pi-os-update.md; the Pi's side is
 * docs/pi-tryboot.md, on the Pi's owner's branch): the board's side, from 1.20.2.
 *
 * A "pi_os" job names one update file that `cranium_ota.py make` built: a tar of a signed manifest
 * and two deltas, usually a few MB. The board downloads it whole into the file area at the end of
 * its SD card (pi_delta_fmt.h), resuming after a power cut or a lost connection, reads it back and
 * checks its SHA-256, and only then offers it to the Pi. The Pi takes it over its link (pi_dlink.c:
 * FILE_INFO and FILE_READ), applies it into its spare slot, boots it once on trial, and says how it
 * went (RESULT); it also says what it runs (OS_STATUS). The job ends with the Pi's result.
 *
 * Next to the delta updates of pi_delta.c, on the same card, link, thread and downloader. Plain C:
 * the network and the card come in as operations, so that all of it runs on the host
 * (firmware/tests/host/test_pi_os.c, pi_delta_harness.c). pi_delta_ota.c runs it on a board.
 */

#ifndef PI_OS_H_
#define PI_OS_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pi_card.h"
#include "pi_delta.h"
#include "pi_delta_fmt.h"

/* What a job names. */
struct pi_os_job {
	char version[PI_VERSION_MAX + 1];
	/* The version the file updates from, zeros after it; all zeros for a full image. */
	char from[PI_VERSION_MAX + 1];
	uint8_t sha256[PI_HASH_SIZE];
	uint32_t size;
	/* CRC-32 of the job's ID: another job for a file the card holds offers it anew. */
	uint32_t tag;
};

enum pi_os_step {
	PI_OS_STEP_IDLE = 0,
	PI_OS_STEP_DOWNLOAD,
	PI_OS_STEP_VERIFY,
	PI_OS_STEP_READY,
};

struct pi_os_config {
	/* The layout of a card that has none yet (as pi_delta_config's). */
	uint32_t default_max_blocks;
	/* Sectors written between two saves of the header: what a power cut costs, at most. */
	uint32_t save_every;
	/* Whole downloads that read back with the wrong SHA-256 before the job fails. */
	uint32_t attempts;
};

struct pi_os {
	struct pi_card *card;
	const struct pi_os_config *cfg;
	const struct pi_fetch *fetch;
	/* Set by another thread when the job is withdrawn. */
	const volatile bool *stop;
	/*
	 * One sector, lent by the caller. pi_delta_ota.c lends the delta update's: the two run on one
	 * thread, one at a time.
	 */
	uint8_t *io;

	/* Read by other threads for reports, each on its own. */
	/* Bytes on the card (downloading), or read back and hashed (checking). */
	volatile uint32_t done;
	/* Bytes downloaded, over every call since the caller last set it to 0 (pi_delta_ota.c: the job). */
	uint64_t bytes_fetched;
	uint32_t size;
	/* The generation the file is offered under, once ready. */
	uint32_t generation;

	/* The download, as its sink goes: bytes of a sector held, sectors since a save. */
	uint16_t fill;
	uint16_t unsaved;
	volatile uint8_t step;
	/* enum pi_err, as the sink stopped. */
	uint8_t err;
};

void pi_os_init(struct pi_os *os, struct pi_card *card, const struct pi_os_config *cfg,
		const struct pi_fetch *fetch, uint8_t *io, const volatile bool *stop);

/*
 * Bring the job's file onto the card, or go on doing so, and check it. PI_OK when the card holds it
 * whole with the job's SHA-256 (os->generation is then the one it is offered under).
 * PI_ERR_DOWNLOAD for a transfer that failed, which the caller tries again (with a fresh URL);
 * PI_ERR_DIGEST_MISMATCH when it read back wrong cfg->attempts times; PI_ERR_TOO_LARGE when it does
 * not fit past the mirror; any card error. Every call starts from what the card says.
 */
enum pi_err pi_os_run(struct pi_os *os, const struct pi_os_job *job);

/* "idle", "download", "verify", "ready". */
const char *pi_os_step_name(uint8_t step);

/* Where a job stands once its file is offered (pi_os_watch()). */
enum pi_os_watch {
	/* No card now: wait for it. */
	PI_OS_WAIT_CARD = 0,
	/* The card no longer holds the file the job offered: take it again (pi_os_run()). */
	PI_OS_LOST,
	PI_OS_OFFERED,
	/* The Pi has read some of it. */
	PI_OS_FETCHED,
	/* The Pi wrote it into its spare slot and is starting it on trial ("applied"). */
	PI_OS_ON_TRIAL,
	PI_OS_SUCCEEDED,
	PI_OS_FAILED,
};

/* The Pi said, in its last status, that it runs this version and not on trial. */
bool pi_os_pi_runs(const struct pi_card *card, const char *version);

/*
 * Under the card's lock: where a job that offered `generation` of its file stands. Succeeded when
 * the Pi confirmed it, or says it runs the job's version off trial (a result lost to a restart);
 * failed when it refused it or rolled it back.
 */
enum pi_os_watch pi_os_watch(const struct pi_card *card, const struct pi_os_job *job,
			     uint32_t generation);

/* "offered", "fetched", "applied", and so on: the step a job's report names. */
const char *pi_os_watch_name(uint8_t watch);

/*
 * The statusDetails of the job's reports, without their braces. The length written, or -ENOSPC.
 *
 *   downloading or checking: "step":"download","progress":"42","done":"<bytes>","total":"<size>",
 *                            and a delta update's the same, with its step's name and blocks
 *   offered:                 "step":"offered","generation":"7","read":"0","total":"<size>"
 *   at the end, succeeded:   "pi_version":"1.1.0","generation":"7","bytes":"<downloaded>",
 *                            "read":"<size>","running":"<firmware>"
 *   at the end, failed:      "reason":"refused","pi_reason":"<the Pi's>","step":"result",
 *                            "running":"<firmware>"
 */
int pi_os_details_progress(char *buf, size_t len, const char *step, uint32_t done, uint32_t total);
int pi_os_details_offer(char *buf, size_t len, uint8_t watch, uint32_t generation, uint32_t read,
			uint32_t total);
int pi_os_details_succeeded(char *buf, size_t len, const char *version, uint32_t generation,
			    uint64_t bytes, uint32_t read, const char *running);
int pi_os_details_failed(char *buf, size_t len, uint8_t result, const char *reason,
			 const char *running);

#endif /* PI_OS_H_ */
