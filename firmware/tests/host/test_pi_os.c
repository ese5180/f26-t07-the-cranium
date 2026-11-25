/*
 * Host tests of Raspberry Pi OS updates (firmware 1.20.2, docs/pi-os-update.md): the file area's
 * header (src/pi/pi_delta_fmt.c) and its place on the card (pi_card.c), the download into it
 * (pi_os.c), the Pi's requests for it (pi_dlink.c, behind the message link's pi_rx.c), what a job
 * decides and reports from what the Pi says (pi_os.c), the "os" part of the heartbeat's card report
 * (pi_delta.c) and the "pi_os" job document (src/ota/ota_job.c).
 *
 * The card is in memory and can lose power at any write, be pulled out or fail; the server hands out
 * the file in pieces of any size and can drop the connection or send wrong bytes (pi_delta_fakes.c).
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "ota_job.h"
#include "pi_card.h"
#include "pi_delta.h"
#include "pi_delta_fakes.h"
#include "pi_delta_fmt.h"
#include "pi_dlink.h"
#include "pi_frame.h"
#include "pi_os.h"
#include "pi_rx.h"
#include "pi_sha256.h"

static int failures;
static int checks;

#define CHECK(condition)                                                                     \
	do {                                                                                 \
		checks++;                                                                    \
		if (!(condition)) {                                                          \
			failures++;                                                          \
			printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);         \
		}                                                                            \
	} while (0)

#define MAX_BLOCKS 256u
#define BS         4096u
/* A file of 20 sectors and a piece: the last sector is padded. */
#define SIZE       (20u * PI_SECTOR_SIZE + 100u)

static const struct pi_os_config os_config = {
	.default_max_blocks = MAX_BLOCKS,
	.save_every = 4,
	.attempts = 2,
};

static const struct pi_delta_config delta_config = {
	.default_max_blocks = MAX_BLOCKS,
	.run_blocks = 4,
	.block_attempts = 3,
	.skip_save_every = 8,
	.table_save_every = 1,
};

static struct pi_card_layout layout;
/* The layout, 1 MiB for a mirror of a few blocks, and 3 MiB for the file area. */
static uint64_t card_sectors;

/* ------------------------------------------------------------------------------------------- */

static uint32_t seed_state;

static uint8_t *make_file(uint32_t seed, uint32_t size)
{
	uint8_t *file = malloc(size);

	seed_state = seed;
	for (uint32_t i = 0; i < size; i++) {
		seed_state = seed_state * 1664525u + 1013904223u;
		file[i] = (uint8_t)(seed_state >> 24);
	}
	return file;
}

static void sha_of(const uint8_t *data, uint64_t len, uint8_t out[PI_HASH_SIZE])
{
	struct pi_sha256 sha;

	pi_sha256_init(&sha);
	pi_sha256_update(&sha, data, (size_t)len);
	pi_sha256_final(&sha, out);
}

struct world {
	struct fake_disk disk;
	struct fake_server server;
	struct pi_card card;
	struct pi_os os;
	struct pi_fetch fetch;
	volatile bool stop;
	uint8_t io[PI_SECTOR_SIZE];
	const uint8_t *file;
	struct pi_os_job job;
};

static void world_create(struct world *w)
{
	memset(w, 0, sizeof(*w));
	fake_disk_create(&w->disk, card_sectors);
}

/* The server now hands out this file, and the job names it. */
static void offer_file(struct world *w, const uint8_t *file, uint32_t size, const char *version,
		       const char *from, uint32_t tag)
{
	memset(&w->server, 0, sizeof(w->server));
	w->server.package = file;
	w->server.size = size;
	w->server.max_piece = 700;
	w->server.seed = 3;
	w->server.drop_after = -1;
	w->server.stop_after = -1;
	w->server.stop_flag = &w->stop;
	w->file = file;
	memset(&w->job, 0, sizeof(w->job));
	strncpy(w->job.version, version, PI_VERSION_MAX);
	strncpy(w->job.from, from, PI_VERSION_MAX);
	sha_of(file, size, w->job.sha256);
	w->job.size = size;
	w->job.tag = tag;
}

/* One call, as after a restart: everything in RAM is new, the card is what it was. */
static enum pi_err run(struct world *w)
{
	pi_card_init(&w->card, &fake_disk_ops, &w->disk);
	w->fetch.get = fake_server_get;
	w->fetch.ctx = &w->server;
	pi_os_init(&w->os, &w->card, &os_config, &w->fetch, w->io, &w->stop);
	return pi_os_run(&w->os, &w->job);
}

/* The card holds the job's file where its header says. */
static bool file_on_card(const struct world *w)
{
	const uint8_t *at = w->disk.data + w->card.file.lba * PI_SECTOR_SIZE;

	return w->card.file.size == w->job.size &&
	       memcmp(at, w->file, w->job.size) == 0;
}

/* What a fresh open of the card says about its file. */
static struct pi_card_file file_after_open(struct world *w)
{
	struct pi_card card;

	pi_card_init(&card, &fake_disk_ops, &w->disk);
	(void)pi_card_open(&card, MAX_BLOCKS);
	return card.file;
}

/* The file the card says is ready hashes to what its header says. */
static bool ready_file_is_whole(struct world *w)
{
	struct pi_card card;
	struct pi_file_header h;
	uint8_t raw[PI_SECTOR_SIZE];
	uint8_t digest[PI_HASH_SIZE];

	pi_card_init(&card, &fake_disk_ops, &w->disk);
	if (pi_card_open(&card, MAX_BLOCKS) != PI_OK || card.file.state != PI_FILE_READY) {
		return true;
	}
	if (pi_card_file_load(&card, raw) != PI_OK || !pi_file_header_decode(raw, &h)) {
		return false;
	}
	sha_of(w->disk.data + h.lba * PI_SECTOR_SIZE, h.size, digest);
	return memcmp(digest, h.sha256, PI_HASH_SIZE) == 0;
}

/* ------------------------------------------------------------------------------------------- */

static void test_file_format(void)
{
	struct pi_file_header h;
	struct pi_file_header back;
	uint8_t raw[PI_SECTOR_SIZE];
	char text[16];

	memset(&h, 0, sizeof(h));
	h.seq = 7;
	h.state = PI_FILE_READY;
	h.result = PI_OS_ROLLED_BACK;
	h.generation = 0x01020304;
	h.size = 1000;
	h.done = 1000;
	h.job = 0xdeadbeef;
	h.lba = 0x123456789ull;
	memset(h.sha256, 0xab, sizeof(h.sha256));
	strcpy(h.version, "1.1.0");
	strcpy(h.from, "1.0.0");
	strcpy(h.reason, "health check failed");
	pi_file_header_encode(&h, raw);
	CHECK(memcmp(raw, "CPOF", 4) == 0 && pi_get16(raw + 4) == 1);
	CHECK(pi_get32(raw + 508) == pi_crc32(raw, 508));
	CHECK(pi_file_header_decode(raw, &back));
	CHECK(back.seq == 7 && back.state == PI_FILE_READY && back.result == PI_OS_ROLLED_BACK);
	CHECK(back.generation == 0x01020304 && back.size == 1000 && back.done == 1000);
	CHECK(back.job == 0xdeadbeef && back.lba == 0x123456789ull && back.sha256[31] == 0xab);
	CHECK(strcmp(back.version, "1.1.0") == 0 && strcmp(back.from, "1.0.0") == 0);
	CHECK(strcmp(back.reason, "health check failed") == 0);
	CHECK(pi_get32(raw + PI_FILE_AT_DONE) == 1000 && raw[PI_FILE_AT_STATE] == PI_FILE_READY);

	/* A full image: no version it updates from. */
	memset(h.from, 0, sizeof(h.from));
	pi_file_header_encode(&h, raw);
	CHECK(pi_file_header_decode(raw, &back) && back.from[0] == '\0');

	/* Each field out of its range, resealed so that only the field is wrong. */
	struct {
		size_t at;
		uint8_t value;
	} bad[] = {
		{ 0, 'X' },                     /* magic */
		{ 4, 2 },                       /* format */
		{ PI_FILE_AT_STATE, 3 },        /* state */
		{ PI_FILE_AT_RESULT, 5 },       /* result */
		{ PI_FILE_AT_VERSION, 0 },      /* no version */
		{ PI_FILE_AT_VERSION + 1, ' ' }, /* not a version's character */
		{ PI_FILE_AT_FROM, '/' },       /* nor here */
	};
	for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
		pi_file_header_encode(&h, raw);
		raw[bad[i].at] = bad[i].value;
		pi_file_header_seal(raw);
		CHECK(!pi_file_header_decode(raw, &back));
	}
	/* Sizes and counts that do not go together. */
	pi_file_header_encode(&h, raw);
	pi_put32(raw + PI_FILE_AT_SIZE, 0);
	pi_put32(raw + PI_FILE_AT_DONE, 0);
	pi_file_header_seal(raw);
	CHECK(!pi_file_header_decode(raw, &back));
	h.state = PI_FILE_DOWNLOADING;
	h.done = 1001;
	pi_file_header_encode(&h, raw);
	CHECK(!pi_file_header_decode(raw, &back));
	h.done = 700;
	pi_file_header_encode(&h, raw);
	CHECK(!pi_file_header_decode(raw, &back));
	h.done = 512;
	pi_file_header_encode(&h, raw);
	CHECK(pi_file_header_decode(raw, &back));
	h.state = PI_FILE_READY;
	pi_file_header_encode(&h, raw);
	CHECK(!pi_file_header_decode(raw, &back));
	/* A CRC that does not match. */
	h.done = 1000;
	pi_file_header_encode(&h, raw);
	raw[200] ^= 1;
	CHECK(!pi_file_header_decode(raw, &back));
	/* A reason with what JSON cannot take, as from a card written elsewhere: cleaned. */
	pi_file_header_encode(&h, raw);
	memset(raw + PI_FILE_AT_REASON, 0, PI_OS_REASON_MAX);
	memcpy(raw + PI_FILE_AT_REASON, "a\"b\\c\nd\xc3\xa9", 9);
	pi_file_header_seal(raw);
	CHECK(pi_file_header_decode(raw, &back) && strcmp(back.reason, "a?b?c?d??") == 0);

	strcpy(text, "ok \x01\x7f~");
	pi_os_clean_text(text, sizeof(text));
	CHECK(strcmp(text, "ok ??~") == 0);
	CHECK(strcmp(pi_os_result_name(PI_OS_NONE), "none") == 0);
	CHECK(strcmp(pi_os_result_name(PI_OS_APPLIED), "applied") == 0);
	CHECK(strcmp(pi_os_result_name(PI_OS_CONFIRMED), "confirmed") == 0);
	CHECK(strcmp(pi_os_result_name(PI_OS_ROLLED_BACK), "rolled_back") == 0);
	CHECK(strcmp(pi_os_result_name(PI_OS_REFUSED), "refused") == 0);
	CHECK(strcmp(pi_os_result_name(9), "unknown") == 0);
	CHECK(strcmp(pi_os_step_name(PI_OS_STEP_VERIFY), "verify") == 0);
	CHECK(strcmp(pi_os_step_name(99), "idle") == 0);
}

/* ------------------------------------------------------------------------------------------- */

static void test_download(void)
{
	struct world w;
	uint8_t *v1 = make_file(1, SIZE);
	uint8_t *v2 = make_file(2, SIZE);
	uint8_t *exact = make_file(3, 8 * PI_SECTOR_SIZE);
	uint64_t want_lba;
	uint8_t zeros[2 * PI_SECTOR_SIZE] = { 0 };

	world_create(&w);
	offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 11);
	CHECK(run(&w) == PI_OK);
	CHECK(w.card.file.state == PI_FILE_READY && w.card.file.generation == 1);
	CHECK(w.card.file.done == SIZE && w.card.file.size == SIZE && !w.card.file.offered);
	CHECK(file_on_card(&w));
	/* At the end of the card, on a 1 MiB boundary, past the mirror. */
	want_lba = (card_sectors - (SIZE + 511) / 512) / 2048 * 2048;
	CHECK(w.card.file.lba == want_lba && want_lba >= layout.mirror_lba);
	/* The last sector is padded with zeros. */
	CHECK(w.disk.data[want_lba * 512 + SIZE] == 0 &&
	      w.disk.data[want_lba * 512 + 21 * 512 - 1] == 0);
	/* One range, the whole file; the state of the delta updates never written. */
	CHECK(w.server.requests == 1 && w.os.bytes_fetched == SIZE);
	CHECK(w.server.log_offset[0] == 0 && w.server.log_len[0] == SIZE);
	CHECK(memcmp(w.disk.data + PI_CARD_BASE_LBA * 512, zeros, sizeof(zeros)) == 0);
	CHECK(w.card.st.state == PI_STATE_EMPTY);
	CHECK(w.os.step == PI_OS_STEP_READY && w.os.generation == 1 && w.os.done == SIZE);

	/* The same job again, as after a restart: nothing downloaded, the same generation. */
	CHECK(run(&w) == PI_OK);
	CHECK(w.server.requests == 1 && w.card.file.generation == 1 && w.os.generation == 1);

	/* Another job for the same file: offered anew under the next generation, nothing downloaded. */
	w.job.tag = 12;
	CHECK(run(&w) == PI_OK);
	CHECK(w.server.requests == 1 && w.card.file.generation == 2 && file_on_card(&w));

	/* Another file: downloaded, under the next generation, where the last one was. */
	offer_file(&w, v2, SIZE, "1.2.0", "1.1.0", 13);
	CHECK(run(&w) == PI_OK);
	CHECK(w.server.requests == 1 && w.card.file.generation == 3 && file_on_card(&w));
	CHECK(w.card.file.lba == want_lba);

	/* A full image, a whole number of sectors. */
	offer_file(&w, exact, 8 * PI_SECTOR_SIZE, "2.0.0", "", 14);
	CHECK(run(&w) == PI_OK);
	CHECK(w.card.file.generation == 4 && file_on_card(&w));
	CHECK(w.card.file.lba == (card_sectors - 8) / 2048 * 2048);

	/* What a fresh open reads is what was saved. */
	{
		struct pi_card_file f = file_after_open(&w);

		CHECK(f.state == PI_FILE_READY && f.generation == 4 && f.size == 8 * PI_SECTOR_SIZE);
		CHECK(f.lba == w.card.file.lba && !f.offered && f.read == 0);
	}

	/* A job for the same version but another file (a delta now, not a full image): downloaded. */
	offer_file(&w, v1, SIZE, "2.0.0", "1.9.0", 14);
	CHECK(run(&w) == PI_OK && w.server.requests == 1 && w.card.file.generation == 5);

	fake_disk_free(&w.disk);
	free(v1);
	free(v2);
	free(exact);
}

/*
 * The power goes at each write in turn, half way through it, from the first file onto a blank card
 * and from a second file onto a card that holds the first: the next call goes on, and ends with the
 * file whole. At no time does the card say a file is ready whose bytes are not that file.
 */
static void test_power_cut_everywhere(void)
{
	uint8_t *v1 = make_file(21, SIZE);
	uint8_t *v2 = make_file(22, SIZE);
	struct world w;
	uint64_t writes_first;
	uint64_t writes_second;
	int cuts = 0;
	int ok = 0;

	world_create(&w);
	offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 1);
	CHECK(run(&w) == PI_OK);
	writes_first = w.disk.writes;
	offer_file(&w, v2, SIZE, "1.2.0", "1.1.0", 2);
	CHECK(run(&w) == PI_OK);
	writes_second = w.disk.writes - writes_first;
	fake_disk_free(&w.disk);
	/* 21 sectors, a save every 4 and at the end, the header at the start and once checked. */
	CHECK(writes_first == 21 + 6 + 2);

	for (int second = 0; second < 2; second++) {
		uint64_t total = second ? writes_second : writes_first;

		for (uint64_t cut = 0; cut < total; cut++) {
			uint64_t fetched = 0;
			enum pi_err err;
			int calls = 0;

			world_create(&w);
			if (second) {
				offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 1);
				CHECK(run(&w) == PI_OK);
				offer_file(&w, v2, SIZE, "1.2.0", "1.1.0", 2);
			} else {
				offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 1);
			}
			w.disk.writes_left = (long)cut;
			err = run(&w);
			fetched += w.os.bytes_fetched;
			cuts += err != PI_OK;
			CHECK(err == PI_ERR_SD_IO || err == PI_ERR_SD_ABSENT);
			fake_disk_power_on(&w.disk);
			CHECK(ready_file_is_whole(&w));
			do {
				err = run(&w);
				fetched += w.os.bytes_fetched;
				calls++;
			} while (err != PI_OK && calls < 3);
			CHECK(err == PI_OK && calls == 1);
			CHECK(file_on_card(&w) && w.card.file.state == PI_FILE_READY);
			CHECK(w.card.file.generation == (second ? 2u : 1u));
			/* At most the sectors since the last save come twice, and a piece of one. */
			CHECK(fetched <= SIZE + (os_config.save_every + 1) * PI_SECTOR_SIZE);
			ok += err == PI_OK && file_on_card(&w);
			fake_disk_free(&w.disk);
		}
	}
	CHECK(cuts == (int)(writes_first + writes_second));
	CHECK(ok == cuts);
	printf("     power cut at each of %d writes, each resumed\n", cuts);
	free(v1);
	free(v2);
}

static void test_interruptions(void)
{
	uint8_t *v1 = make_file(31, SIZE);
	struct world w;
	uint64_t fetched;

	/* The connection drops half way: what reached the card counts, and the next call goes on. */
	world_create(&w);
	offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 1);
	w.server.drop_after = SIZE / 2;
	CHECK(run(&w) == PI_ERR_DOWNLOAD);
	CHECK(w.card.file.state == PI_FILE_DOWNLOADING && w.card.file.done == 10 * PI_SECTOR_SIZE);
	CHECK(file_after_open(&w).done == 10 * PI_SECTOR_SIZE);
	fetched = w.os.bytes_fetched;
	/* The next call, as the board makes it: the same engine, its count going on over the job. */
	CHECK(pi_os_run(&w.os, &w.job) == PI_OK && file_on_card(&w));
	CHECK(w.server.log_offset[1] == 10 * PI_SECTOR_SIZE && w.server.log_len[1] == SIZE - 10 * 512);
	CHECK(w.os.bytes_fetched == fetched + (SIZE - 10 * 512));
	CHECK(w.os.bytes_fetched < SIZE + PI_SECTOR_SIZE);
	fake_disk_free(&w.disk);

	/* A server whose file is shorter than the job says: the range is refused, and nothing is done. */
	world_create(&w);
	offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 1);
	w.server.size = SIZE - 1;
	CHECK(run(&w) == PI_ERR_DOWNLOAD && w.card.file.state == PI_FILE_DOWNLOADING);
	w.server.size = SIZE;
	CHECK(run(&w) == PI_OK && file_on_card(&w));
	fake_disk_free(&w.disk);

	/* Withdrawn half way: it stops, and keeps what it has. */
	world_create(&w);
	offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 1);
	w.server.stop_after = 6 * PI_SECTOR_SIZE;
	CHECK(run(&w) == PI_ERR_ABORTED);
	CHECK(w.card.file.state == PI_FILE_DOWNLOADING && w.card.file.done >= 4 * PI_SECTOR_SIZE);
	w.stop = false;
	w.server.stop_after = -1;
	CHECK(run(&w) == PI_OK && file_on_card(&w));
	/* Withdrawn before it starts. */
	w.stop = true;
	offer_file(&w, v1, SIZE, "1.3.0", "1.0.0", 2);
	w.stop = true;
	CHECK(run(&w) == PI_ERR_ABORTED && w.server.requests == 0);
	w.stop = false;
	fake_disk_free(&w.disk);

	/* The card pulled out half way, then put back. */
	world_create(&w);
	offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 1);
	w.disk.pull_after = 8;
	CHECK(run(&w) == PI_ERR_SD_ABSENT);
	w.disk.absent = false;
	CHECK(run(&w) == PI_OK && file_on_card(&w));
	/* A card that cannot be written. */
	offer_file(&w, v1, SIZE, "1.4.0", "1.0.0", 2);
	w.disk.fail_writes = true;
	CHECK(run(&w) == PI_ERR_SD_IO);
	w.disk.fail_writes = false;
	/* No card at all. */
	w.disk.absent = true;
	CHECK(run(&w) == PI_ERR_SD_ABSENT);
	w.disk.absent = false;
	fake_disk_free(&w.disk);
	free(v1);
}

static void test_digest(void)
{
	uint8_t *v1 = make_file(41, SIZE);
	struct world w;

	/* The job's SHA-256 is not the file's: downloaded twice, then refused, and nothing kept. */
	world_create(&w);
	offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 1);
	w.job.sha256[0] ^= 1;
	CHECK(run(&w) == PI_ERR_DIGEST_MISMATCH);
	CHECK(w.server.requests == 2 && w.os.bytes_fetched == 2 * SIZE);
	CHECK(w.card.file.state == PI_FILE_DOWNLOADING && w.card.file.done == 0);
	CHECK(file_after_open(&w).state == PI_FILE_DOWNLOADING && file_after_open(&w).done == 0);

	/* The right one now: from its start. */
	w.job.sha256[0] ^= 1;
	CHECK(run(&w) == PI_OK && file_on_card(&w) && w.server.requests == 3);
	fake_disk_free(&w.disk);

	/* A byte wrong from the server once: the check finds it, and the second download is right. */
	world_create(&w);
	offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 1);
	w.server.corrupt_from = 3000;
	w.server.corrupt_to = 3001;
	w.server.corrupt_times = 1;
	CHECK(run(&w) == PI_OK && file_on_card(&w) && w.server.requests == 2);
	fake_disk_free(&w.disk);

	/* A card that stores a bit wrong once: the same. */
	world_create(&w);
	offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 1);
	w.disk.flip_from = (card_sectors - 21) / 2048 * 2048 + 5;
	w.disk.flip_to = w.disk.flip_from + 1;
	w.disk.flip_times = 1;
	CHECK(run(&w) == PI_OK && file_on_card(&w) && w.server.requests == 2);
	fake_disk_free(&w.disk);
	free(v1);
}

/* ------------------------------------------------------------------------------------------- */

/* A delta update's image on the card (pi_delta.c), as a board of #279 leaves it. */
static enum pi_err delta_update(struct world *w, uint8_t *image, uint64_t size, uint32_t block_size,
				struct fake_server *server, uint8_t **package);

static void install_image(struct world *w, uint8_t *image, uint64_t size, struct fake_server *server,
			  uint8_t **package)
{
	CHECK(delta_update(w, image, size, BS, server, package) == PI_OK);
}

/* A delta update's image onto the card (pi_delta.c), as a "pi_delta" job brings it. */
static enum pi_err delta_update(struct world *w, uint8_t *image, uint64_t size, uint32_t block_size,
				struct fake_server *server, uint8_t **package)
{
	struct pi_delta delta;
	struct pi_delta_job job;
	struct pi_manifest m;
	struct pi_fetch fetch = { .get = fake_server_get, .ctx = server };
	uint64_t package_size;
	bool already;

	*package = fake_package(image, size, block_size, "img1", &package_size, &m);
	memset(server, 0, sizeof(*server));
	server->package = *package;
	server->size = package_size;
	server->max_piece = 1500;
	server->drop_after = -1;
	server->stop_after = -1;
	memset(&job, 0, sizeof(job));
	strcpy(job.version, "img1");
	memcpy(job.sha256, m.image_sha256, PI_HASH_SIZE);
	pi_card_init(&w->card, &fake_disk_ops, &w->disk);
	pi_delta_init(&delta, &w->card, &delta_config, &fetch, fake_verify, NULL);
	return pi_delta_run(&delta, &job, &already);
}

/*
 * A delta update whose image reaches a file the card holds, which no job offers (its job ended):
 * the file gives way, and the image goes onto the card whole.
 */
static void test_delta_takes_a_held_files_room(void)
{
	uint8_t *v1 = make_file(81, SIZE);
	/* 3.5 MiB in 16 KiB blocks: past the file, 3 MiB into the 4 MiB after the layout. */
	uint64_t image_size = 224ull * 16384;
	uint8_t *image = make_file(82, (uint32_t)image_size);
	struct fake_server server;
	uint8_t *package = NULL;
	struct world w;

	world_create(&w);
	offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 1);
	CHECK(run(&w) == PI_OK && w.card.file.lba == layout.mirror_lba + 3 * 2048);
	CHECK(delta_update(&w, image, image_size, 16384, &server, &package) == PI_OK);
	CHECK(w.card.st.state == PI_STATE_READY && w.card.file.state == PI_FILE_NONE);
	CHECK(memcmp(w.disk.data + layout.mirror_lba * 512, image, (size_t)image_size) == 0);
	CHECK(file_after_open(&w).state == PI_FILE_NONE && file_after_open(&w).generation == 1);
	/* The next OS job finds no room past this image for its file. */
	CHECK(run(&w) == PI_ERR_TOO_LARGE);
	fake_disk_free(&w.disk);
	free(package);
	free(image);
	free(v1);
}

static void test_placement(void)
{
	uint8_t *v1 = make_file(51, SIZE);
	struct fake_server image_server;
	uint8_t *package = NULL;
	uint64_t image_size = 40 * BS;
	uint8_t *image = make_file(52, (uint32_t)image_size);
	struct world w;
	struct pi_card_state before;
	uint8_t raw[PI_SECTOR_SIZE];
	uint64_t writes;

	/* A card that holds a delta update's image: the file goes past it, and leaves it as it was. */
	world_create(&w);
	install_image(&w, image, image_size, &image_server, &package);
	CHECK(w.card.st.state == PI_STATE_READY);
	before = w.card.st;
	CHECK(pi_card_mirror_end(&w.card) == layout.mirror_lba + image_size / 512);
	offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 1);
	CHECK(run(&w) == PI_OK && file_on_card(&w));
	CHECK(w.card.file.lba >= pi_card_mirror_end(&w.card) && w.card.file.lba % 2048 == 0);
	CHECK(memcmp(w.disk.data + layout.mirror_lba * 512, image, (size_t)image_size) == 0);
	CHECK(w.card.st.seq == before.seq && w.card.st.state == PI_STATE_READY &&
	      w.card.st.generation == before.generation);
	CHECK(strcmp(w.card.cur.version, "img1") == 0);

	/* A delta image may not reach the file; one that ends at it may. */
	CHECK(pi_card_fits(&w.card, (w.card.file.lba - layout.mirror_lba) * 512));
	CHECK(!pi_card_fits(&w.card, (w.card.file.lba - layout.mirror_lba + 1) * 512));
	w.card.file.state = PI_FILE_NONE;
	CHECK(pi_card_fits(&w.card, (w.card.file.lba - layout.mirror_lba + 1) * 512));
	w.card.file.state = PI_FILE_READY;
	{
		uint64_t past = (w.card.file.lba - layout.mirror_lba + 1) * 512;
		uint64_t writes_before = w.disk.writes;

		/* While a job offers the file, it stays, and the image does not fit. */
		w.card.file.offered = true;
		CHECK(pi_card_make_room(&w.card, past, raw) == PI_ERR_TOO_LARGE && w.disk.writes == writes_before);
		CHECK(w.card.file.state == PI_FILE_READY);
		w.card.file.offered = false;
		/* Larger than the card even without it: it stays too. */
		CHECK(pi_card_make_room(&w.card, (card_sectors - layout.mirror_lba + 1) * 512, raw) ==
		      PI_ERR_TOO_LARGE);
		CHECK(w.card.file.state == PI_FILE_READY && w.disk.writes == writes_before);
		/* One that fits below it: nothing changes. */
		CHECK(pi_card_make_room(&w.card, 512, raw) == PI_OK && w.disk.writes == writes_before);
		/* Held, and in the way: it gives way, on the card too, and its generation goes on. */
		CHECK(pi_card_make_room(&w.card, past, raw) == PI_OK);
		CHECK(w.card.file.state == PI_FILE_NONE && pi_card_fits(&w.card, past));
		CHECK(file_after_open(&w).state == PI_FILE_NONE && file_after_open(&w).generation == 1);
		/* The mirror's image is as it was; the file comes back with the next job, a generation on. */
		CHECK(memcmp(w.disk.data + layout.mirror_lba * 512, image, (size_t)image_size) == 0);
		offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 1);
		CHECK(run(&w) == PI_OK && file_on_card(&w) && w.card.file.generation == 2);
	}

	/* A file that does not fit between the mirror's image and the card's end: refused, nothing written. */
	writes = w.disk.writes;
	offer_file(&w, v1, SIZE, "1.2.0", "1.1.0", 2);
	w.job.size = (uint32_t)((card_sectors - layout.mirror_lba) * 512 - image_size + 1);
	CHECK(run(&w) == PI_ERR_TOO_LARGE && w.disk.writes == writes);
	CHECK(file_after_open(&w).state == PI_FILE_READY && file_after_open(&w).generation == 2);
	/* Nor one larger than the card. */
	w.job.size = UINT32_MAX;
	CHECK(run(&w) == PI_ERR_TOO_LARGE && w.disk.writes == writes);

	/* A header that says the file sits near the top of 64 bits, where its end wraps around: no file. */
	CHECK(pi_card_file_load(&w.card, raw) == PI_OK);
	pi_put64(raw + PI_FILE_AT_LBA, UINT64_MAX - 5);
	CHECK(pi_card_file_store(&w.card, raw) == PI_OK);
	CHECK(file_after_open(&w).state == PI_FILE_NONE && file_after_open(&w).generation == 2);
	/* One that says it sits inside the mirror's image: no file either. */
	CHECK(pi_card_file_load(&w.card, raw) == PI_OK);
	pi_put64(raw + PI_FILE_AT_LBA, layout.mirror_lba + 8);
	CHECK(pi_card_file_store(&w.card, raw) == PI_OK);
	CHECK(file_after_open(&w).state == PI_FILE_NONE && file_after_open(&w).generation == 2);
	/* The next file goes on from that generation. */
	offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 1);
	CHECK(run(&w) == PI_OK && w.card.file.generation == 3);

	/* Of the two copies, the newer good one counts: a torn newer one leaves the older. */
	w.card.file.offered = true;
	CHECK(pi_card_file_load(&w.card, raw) == PI_OK);
	raw[PI_FILE_AT_RESULT] = PI_OS_APPLIED;
	CHECK(pi_card_file_store(&w.card, raw) == PI_OK && w.card.file.result == PI_OS_APPLIED);
	CHECK(w.card.file.offered);
	memset(w.disk.data + (PI_FILE_HEADER_LBA + w.card.file.copy) * 512 + 100, 0x5a, 16);
	CHECK(file_after_open(&w).result == PI_OS_NONE && file_after_open(&w).state == PI_FILE_READY);
	/* A store that fails leaves RAM as it was. */
	w.disk.fail_writes = true;
	CHECK(pi_card_file_load(&w.card, raw) == PI_ERR_SD_IO);
	pi_card_init(&w.card, &fake_disk_ops, &w.disk);
	w.disk.fail_writes = false;
	CHECK(pi_card_open(&w.card, MAX_BLOCKS) == PI_OK && pi_card_file_load(&w.card, raw) == PI_OK);
	raw[PI_FILE_AT_RESULT] = PI_OS_REFUSED;
	w.disk.fail_writes = true;
	CHECK(pi_card_file_store(&w.card, raw) == PI_ERR_SD_IO && w.card.file.result == PI_OS_NONE);
	w.disk.fail_writes = false;

	/* A card the delta updates laid out, with garbage where the file's header goes: no file. */
	memset(w.disk.data + PI_FILE_HEADER_LBA * 512, 0xff, 2 * 512);
	CHECK(file_after_open(&w).state == PI_FILE_NONE);
	{
		struct pi_card card;

		pi_card_init(&card, &fake_disk_ops, &w.disk);
		CHECK(pi_card_open(&card, MAX_BLOCKS) == PI_OK && card.st.state == PI_STATE_READY);
	}

	fake_disk_free(&w.disk);
	free(package);
	free(image);
	free(v1);
}

/* ------------------------------------------------------------------------------------------- */
/* The link                                                                                     */

static uint16_t request_seq;
static struct pi_rx link_rx;

/*
 * One request through the message link's receiver and the delta link's answers, as pi_link.c takes
 * a transfer: the answer is what the board clocks out in the next one. True if it is the request's
 * answer or ERROR for it, with the message link's session and ack.
 */
static bool ask(struct pi_dlink *link, uint8_t type, const uint8_t *payload, uint16_t length,
		struct pi_frame *answer, uint8_t *tx)
{
	uint8_t rx[PI_FRAME_SIZE];
	struct pi_frame frame = {
		.type = type,
		.session = 0x4242,
		.seq = ++request_seq,
		.length = length,
		.payload = payload,
	};
	struct pi_frame in;
	enum pi_rx_result result;
	size_t n;

	memset(rx, 0, sizeof(rx));
	if (pi_frame_encode(rx, sizeof(rx), &frame) == 0) {
		return false;
	}
	result = pi_rx_handle(&link_rx, rx, sizeof(rx), &in);
	memset(tx, 0xff, PI_FRAME_SIZE);
	n = pi_dlink_answer(link, &link_rx, result, &in, tx, PI_FRAME_SIZE);
	return result == PI_RX_DELTA && pi_frame_decode(tx, PI_FRAME_SIZE, answer) == PI_FRAME_OK &&
	       n == PI_FRAME_HEADER + (size_t)answer->length + PI_FRAME_CRC &&
	       answer->seq == request_seq &&
	       answer->session == (link_rx.accepted_any ? link_rx.session : 0) &&
	       answer->ack == (link_rx.accepted_any ? link_rx.seq : 0) &&
	       (answer->type == (type | PI_DLINK_ANSWER) ||
		(answer->type == PI_DLINK_ERROR && answer->length == 12 && answer->payload[8] == type));
}

static uint8_t error_code(const struct pi_frame *answer)
{
	return answer->type == PI_DLINK_ERROR ? answer->payload[0] : 0;
}

static void read_args(uint8_t *p, uint32_t offset, uint16_t length)
{
	memset(p, 0, 8);
	pi_put32(p, offset);
	pi_put16(p + 4, length);
}

static uint16_t result_args(uint8_t *p, uint8_t code, uint32_t generation, const char *version,
			    const char *reason, size_t reason_len)
{
	memset(p, 0, PI_DLINK_RESULT_HEAD + PI_DLINK_REASON_MAX + 8);
	p[0] = code;
	p[1] = (uint8_t)reason_len;
	pi_put32(p + 4, generation);
	strncpy((char *)p + 8, version, PI_VERSION_MAX);
	memcpy(p + PI_DLINK_RESULT_HEAD, reason, reason_len);
	return (uint16_t)(PI_DLINK_RESULT_HEAD + reason_len);
}

static void status_args(uint8_t *p, uint8_t slot, uint8_t def, uint8_t trial, uint8_t last,
			const char *version)
{
	memset(p, 0, PI_DLINK_OS_STATUS_SIZE + 4);
	p[0] = slot;
	p[1] = def;
	p[2] = trial;
	p[3] = last;
	memcpy(p + 4, version, strlen(version));
	memcpy(p + 36, "1.0.0", 5);
}

/* The whole file through FILE_READ, 480 bytes at a time, as the Pi takes it. */
static bool read_whole(struct pi_dlink *link, const uint8_t *file, uint32_t size, uint32_t generation)
{
	uint8_t tx[PI_FRAME_SIZE];
	uint8_t args[8];
	struct pi_frame a;

	for (uint32_t at = 0; at < size; at += PI_DLINK_READ_MAX) {
		uint16_t n = (uint16_t)(size - at < PI_DLINK_READ_MAX ? size - at : PI_DLINK_READ_MAX);

		read_args(args, at, n);
		if (!ask(link, PI_DLINK_FILE_READ, args, 8, &a, tx) || a.type != 0xa1 ||
		    a.length != PI_DLINK_ANSWER_HEAD + n || pi_get32(a.payload) != generation ||
		    pi_get32(a.payload + 4) != at || pi_get16(a.payload + 8) != n ||
		    pi_get16(a.payload + 10) != 0 || pi_get32(a.payload + 12) != size ||
		    memcmp(a.payload + PI_DLINK_ANSWER_HEAD, file + at, n) != 0) {
			return false;
		}
	}
	return true;
}

static void test_link(void)
{
	uint8_t *v1 = make_file(61, SIZE);
	uint8_t *v2 = make_file(62, SIZE);
	struct world w;
	struct pi_dlink link;
	struct pi_frame a;
	uint8_t tx[PI_FRAME_SIZE];
	uint8_t args[PI_DLINK_RESULT_HEAD + PI_DLINK_REASON_MAX + 8];
	uint16_t n;
	uint32_t answered;

	world_create(&w);
	pi_rx_init(&link_rx);

	/* Before the card is given to the link, at the board's start. */
	pi_dlink_init(&link, NULL);
	CHECK(ask(&link, PI_DLINK_FILE_INFO, NULL, 0, &a, tx) && a.type == 0xa0);
	CHECK(a.length == PI_DLINK_FILE_INFO_SIZE && a.payload[3] == PI_DLINK_INFO_NO_CARD);
	read_args(args, 0, 16);
	CHECK(ask(&link, PI_DLINK_FILE_READ, args, 8, &a, tx) && error_code(&a) == PI_DLINK_CARD);
	CHECK(a.payload[1] == PI_DLINK_FILE_NONE && pi_get32(a.payload + 4) == 0);
	n = result_args(args, PI_OS_APPLIED, 1, "1.1.0", "", 0);
	CHECK(ask(&link, PI_DLINK_RESULT, args, n, &a, tx) && error_code(&a) == PI_DLINK_CARD);
	status_args(args, 'a', 'a', 0, PI_OS_NONE, "1.0.0");
	CHECK(ask(&link, PI_DLINK_OS_STATUS, args, PI_DLINK_OS_STATUS_SIZE, &a, tx) &&
	      error_code(&a) == PI_DLINK_CARD);

	/* A card, not read yet: no card, but the Pi's status is taken. */
	pi_card_init(&w.card, &fake_disk_ops, &w.disk);
	pi_dlink_init(&link, &w.card);
	CHECK(ask(&link, PI_DLINK_FILE_INFO, NULL, 0, &a, tx) && a.payload[3] == PI_DLINK_INFO_NO_CARD);
	CHECK(ask(&link, PI_DLINK_OS_STATUS, args, PI_DLINK_OS_STATUS_SIZE, &a, tx) && a.type == 0xa3);
	CHECK(a.length == PI_DLINK_ACK_SIZE && a.payload[5] == 1 && a.payload[4] == PI_DLINK_FILE_NONE);
	CHECK(w.card.os.known && w.card.os.slot == 'a' && strcmp(w.card.os.version, "1.0.0") == 0);
	n = result_args(args, PI_OS_APPLIED, 1, "1.1.0", "", 0);
	CHECK(ask(&link, PI_DLINK_RESULT, args, n, &a, tx) && error_code(&a) == PI_DLINK_CARD);

	/* An open card with no file. */
	CHECK(pi_card_open(&w.card, MAX_BLOCKS) == PI_OK);
	CHECK(ask(&link, PI_DLINK_FILE_INFO, NULL, 0, &a, tx) && pi_get16(a.payload) == PI_DLINK_VERSION);
	CHECK(a.payload[2] == PI_DLINK_FILE_NONE && a.payload[3] == 0 && pi_get32(a.payload + 4) == 0);
	read_args(args, 0, 16);
	CHECK(ask(&link, PI_DLINK_FILE_READ, args, 8, &a, tx) && error_code(&a) == PI_DLINK_NO_IMAGE);
	n = result_args(args, PI_OS_APPLIED, 0, "1.1.0", "", 0);
	CHECK(ask(&link, PI_DLINK_RESULT, args, n, &a, tx) && a.type == 0xa2 && a.payload[5] == 0);

	/* Half downloaded: FILE_INFO says so, and FILE_READ is refused. */
	offer_file(&w, v1, SIZE, "1.1.0", "1.0.0", 1);
	w.fetch.get = fake_server_get;
	w.fetch.ctx = &w.server;
	pi_os_init(&w.os, &w.card, &os_config, &w.fetch, w.io, &w.stop);
	w.server.drop_after = 9 * PI_SECTOR_SIZE + 10;
	CHECK(pi_os_run(&w.os, &w.job) == PI_ERR_DOWNLOAD);
	CHECK(ask(&link, PI_DLINK_FILE_INFO, NULL, 0, &a, tx));
	CHECK(a.payload[2] == PI_DLINK_FILE_DOWNLOADING && pi_get32(a.payload + 4) == 1);
	CHECK(pi_get32(a.payload + 8) == SIZE && pi_get32(a.payload + 12) == 9 * PI_SECTOR_SIZE);
	read_args(args, 0, 16);
	CHECK(ask(&link, PI_DLINK_FILE_READ, args, 8, &a, tx) && error_code(&a) == PI_DLINK_UPDATING);
	CHECK(a.payload[1] == PI_DLINK_FILE_DOWNLOADING && pi_get32(a.payload + 4) == 1);
	n = result_args(args, PI_OS_APPLIED, 1, "1.1.0", "", 0);
	CHECK(ask(&link, PI_DLINK_RESULT, args, n, &a, tx) && a.type == 0xa2 && a.payload[5] == 0);
	CHECK(w.card.file.result == PI_OS_NONE);

	/* Whole, but no job offers it: held. */
	CHECK(pi_os_run(&w.os, &w.job) == PI_OK);
	CHECK(ask(&link, PI_DLINK_FILE_INFO, NULL, 0, &a, tx) && a.payload[2] == PI_DLINK_FILE_HELD);
	CHECK(a.payload[3] == 0 && pi_get32(a.payload + 12) == SIZE && a.payload[16] == PI_OS_NONE);
	CHECK(memcmp(a.payload + 20, w.job.sha256, PI_HASH_SIZE) == 0);
	CHECK(strcmp((const char *)a.payload + 52, "1.1.0") == 0);
	CHECK(strcmp((const char *)a.payload + 84, "1.0.0") == 0);
	read_args(args, 0, 16);
	CHECK(ask(&link, PI_DLINK_FILE_READ, args, 8, &a, tx) && error_code(&a) == PI_DLINK_NO_IMAGE);
	CHECK(a.payload[1] == PI_DLINK_FILE_HELD);

	/* Offered: the whole file, 480 bytes at a time. */
	w.card.file.offered = true;
	CHECK(ask(&link, PI_DLINK_FILE_INFO, NULL, 0, &a, tx) && a.payload[2] == PI_DLINK_FILE_OFFERED);
	answered = link.answered;
	CHECK(read_whole(&link, v1, SIZE, 1));
	CHECK(link.answered == answered + (SIZE + 479) / 480 && w.card.file.read == SIZE);

	/* Malformed and out of range: refused, with the file's state and generation. */
	{
		struct {
			uint32_t offset;
			uint16_t length;
			uint16_t reserved;
			uint16_t payload;
			uint8_t code;
		} bad[] = {
			{ 0, 0, 0, 8, PI_DLINK_BAD_REQUEST },
			{ 0, 481, 0, 8, PI_DLINK_BAD_REQUEST },
			{ 0, 16, 1, 8, PI_DLINK_BAD_REQUEST },
			{ 0, 16, 0, 7, PI_DLINK_BAD_REQUEST },
			{ 0, 16, 0, 9, PI_DLINK_BAD_REQUEST },
			{ SIZE, 1, 0, 8, PI_DLINK_OUT_OF_RANGE },
			{ SIZE - 10, 11, 0, 8, PI_DLINK_OUT_OF_RANGE },
			{ UINT32_MAX, 480, 0, 8, PI_DLINK_OUT_OF_RANGE },
			{ UINT32_MAX - 100, 200, 0, 8, PI_DLINK_OUT_OF_RANGE },
		};
		for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
			memset(args, 0, sizeof(args));
			pi_put32(args, bad[i].offset);
			pi_put16(args + 4, bad[i].length);
			pi_put16(args + 6, bad[i].reserved);
			CHECK(ask(&link, PI_DLINK_FILE_READ, args, bad[i].payload, &a, tx));
			CHECK(error_code(&a) == bad[i].code && a.payload[1] == PI_DLINK_FILE_OFFERED &&
			      pi_get32(a.payload + 4) == 1);
		}
		CHECK(ask(&link, PI_DLINK_FILE_INFO, args, 1, &a, tx) &&
		      error_code(&a) == PI_DLINK_BAD_REQUEST);
	}
	/* The last byte alone, and one in the middle. */
	read_args(args, SIZE - 1, 1);
	CHECK(ask(&link, PI_DLINK_FILE_READ, args, 8, &a, tx) && a.type == 0xa1 &&
	      a.payload[PI_DLINK_ANSWER_HEAD] == v1[SIZE - 1]);
	read_args(args, 1000, 480);
	CHECK(ask(&link, PI_DLINK_FILE_READ, args, 8, &a, tx) &&
	      memcmp(a.payload + PI_DLINK_ANSWER_HEAD, v1 + 1000, 480) == 0);

	/* RESULT, malformed. */
	{
		uint8_t code[] = { PI_OS_NONE, PI_OS_RESULT_COUNT, 0xff };

		for (size_t i = 0; i < sizeof(code); i++) {
			n = result_args(args, code[i], 1, "1.1.0", "x", 1);
			CHECK(ask(&link, PI_DLINK_RESULT, args, n, &a, tx) &&
			      error_code(&a) == PI_DLINK_BAD_REQUEST);
		}
		n = result_args(args, PI_OS_APPLIED, 1, "1.1.0", "xy", 2);
		CHECK(ask(&link, PI_DLINK_RESULT, args, n - 1, &a, tx) &&
		      error_code(&a) == PI_DLINK_BAD_REQUEST);
		CHECK(ask(&link, PI_DLINK_RESULT, args, n + 1, &a, tx) &&
		      error_code(&a) == PI_DLINK_BAD_REQUEST);
		CHECK(ask(&link, PI_DLINK_RESULT, args, 39, &a, tx) &&
		      error_code(&a) == PI_DLINK_BAD_REQUEST);
		args[1] = PI_DLINK_REASON_MAX + 1;
		CHECK(ask(&link, PI_DLINK_RESULT, args, PI_DLINK_RESULT_HEAD + PI_DLINK_REASON_MAX + 1, &a,
			  tx) && error_code(&a) == PI_DLINK_BAD_REQUEST);
		n = result_args(args, PI_OS_APPLIED, 1, "1.1.0", "", 0);
		args[2] = 1;
		CHECK(ask(&link, PI_DLINK_RESULT, args, n, &a, tx) &&
		      error_code(&a) == PI_DLINK_BAD_REQUEST);
		CHECK(w.card.file.result == PI_OS_NONE);
	}
	/* For another generation, or another version: acknowledged, not kept. */
	n = result_args(args, PI_OS_REFUSED, 2, "1.1.0", "old", 3);
	CHECK(ask(&link, PI_DLINK_RESULT, args, n, &a, tx) && a.type == 0xa2 && a.payload[5] == 0);
	CHECK(pi_get32(a.payload) == 1 && a.payload[4] == PI_DLINK_FILE_OFFERED);
	n = result_args(args, PI_OS_REFUSED, 1, "1.1.1", "old", 3);
	CHECK(ask(&link, PI_DLINK_RESULT, args, n, &a, tx) && a.payload[5] == 0);
	CHECK(w.card.file.result == PI_OS_NONE);
	/* Applied: kept, on the card. */
	n = result_args(args, PI_OS_APPLIED, 1, "1.1.0", "", 0);
	CHECK(ask(&link, PI_DLINK_RESULT, args, n, &a, tx) && a.payload[5] == 1);
	CHECK(w.card.file.result == PI_OS_APPLIED && w.card.file.offered);
	CHECK(file_after_open(&w).result == PI_OS_APPLIED);
	CHECK(ask(&link, PI_DLINK_FILE_INFO, NULL, 0, &a, tx) && a.payload[16] == PI_OS_APPLIED);
	/* Rolled back, with a reason that is long, and holds what JSON and a console cannot take. */
	{
		static const char reason[] = "health \"check\"\\ failed\n\x1b[31m\xc3\xa9 at 300 s, and more after it";

		n = result_args(args, PI_OS_ROLLED_BACK, 1, "1.1.0", reason, sizeof(reason) - 1);
		CHECK(sizeof(reason) - 1 <= PI_DLINK_REASON_MAX);
		CHECK(ask(&link, PI_DLINK_RESULT, args, n, &a, tx) && a.payload[5] == 1);
		CHECK(w.card.file.result == PI_OS_ROLLED_BACK);
		CHECK(strcmp(w.card.file.reason, "health ?check?? failed??[31m?? a") == 0);
		CHECK(strlen(w.card.file.reason) == PI_OS_REASON_MAX);
		CHECK(strcmp(file_after_open(&w).reason, w.card.file.reason) == 0);
		/* A zero in it ends it, on the card too. */
		n = result_args(args, PI_OS_ROLLED_BACK, 1, "1.1.0", "ab\0cd", 5);
		CHECK(ask(&link, PI_DLINK_RESULT, args, n, &a, tx) && strcmp(w.card.file.reason, "ab") == 0);
		CHECK(w.disk.data[(PI_FILE_HEADER_LBA + w.card.file.copy) * 512 + PI_FILE_AT_REASON + 3] == 0);
	}
	/* A card that cannot be written: refused, so the Pi sends it again. */
	w.disk.fail_writes = true;
	n = result_args(args, PI_OS_CONFIRMED, 1, "1.1.0", "", 0);
	CHECK(ask(&link, PI_DLINK_RESULT, args, n, &a, tx) && error_code(&a) == PI_DLINK_CARD);
	CHECK(w.card.file.result == PI_OS_ROLLED_BACK);
	w.disk.fail_writes = false;

	/* OS_STATUS, malformed: refused, and the last one kept. */
	{
		uint8_t fields[][4] = { { 'c', 'a', 0, 0 }, { 'a', 'x', 0, 0 }, { 'a', 'a', 2, 0 },
					{ 'a', 'a', 0, PI_OS_RESULT_COUNT } };

		for (size_t i = 0; i < sizeof(fields) / sizeof(fields[0]); i++) {
			status_args(args, fields[i][0], fields[i][1], fields[i][2], fields[i][3], "9.9.9");
			CHECK(ask(&link, PI_DLINK_OS_STATUS, args, PI_DLINK_OS_STATUS_SIZE, &a, tx) &&
			      error_code(&a) == PI_DLINK_BAD_REQUEST);
		}
		status_args(args, 'b', 'a', 1, PI_OS_CONFIRMED, "9.9.9");
		CHECK(ask(&link, PI_DLINK_OS_STATUS, args, PI_DLINK_OS_STATUS_SIZE - 1, &a, tx) &&
		      error_code(&a) == PI_DLINK_BAD_REQUEST);
		CHECK(ask(&link, PI_DLINK_OS_STATUS, args, PI_DLINK_OS_STATUS_SIZE + 1, &a, tx) &&
		      error_code(&a) == PI_DLINK_BAD_REQUEST);
		CHECK(strcmp(w.card.os.version, "1.0.0") == 0 && w.card.os.slot == 'a');
	}
	/* On trial in slot b. */
	status_args(args, 'b', 'a', 1, PI_OS_NONE, "1.1.0");
	CHECK(ask(&link, PI_DLINK_OS_STATUS, args, PI_DLINK_OS_STATUS_SIZE, &a, tx) && a.type == 0xa3);
	CHECK(pi_get32(a.payload) == 1 && a.payload[4] == PI_DLINK_FILE_OFFERED);
	CHECK(w.card.os.slot == 'b' && w.card.os.trial == 1 && strcmp(w.card.os.version, "1.1.0") == 0);
	/* A version that is not one: kept as not known. */
	status_args(args, 'b', 'b', 0, PI_OS_CONFIRMED, "1.1.0 \"x\"");
	CHECK(ask(&link, PI_DLINK_OS_STATUS, args, PI_DLINK_OS_STATUS_SIZE, &a, tx) && a.type == 0xa3);
	CHECK(w.card.os.version[0] == '\0' && w.card.os.last == PI_OS_CONFIRMED);
	memset(args, 'z', PI_DLINK_OS_STATUS_SIZE);
	args[0] = 'a';
	args[1] = 'b';
	args[2] = 0;
	args[3] = 0;
	CHECK(ask(&link, PI_DLINK_OS_STATUS, args, PI_DLINK_OS_STATUS_SIZE, &a, tx) && a.type == 0xa3);
	CHECK(w.card.os.version[0] == '\0' && w.card.os.slot == 'a');

	/*
	 * A new file of the same size goes where the last one was: a sector of the old one in the
	 * link's cache is not served for the new one, with the card open all along.
	 */
	read_args(args, SIZE - 100, 100);
	CHECK(ask(&link, PI_DLINK_FILE_READ, args, 8, &a, tx) &&
	      memcmp(a.payload + PI_DLINK_ANSWER_HEAD, v1 + SIZE - 100, 100) == 0);
	{
		uint8_t raw[PI_SECTOR_SIZE];
		uint32_t opens = w.card.opens;

		memset(w.disk.data + (w.card.file.lba + 20) * 512, 0x77, 512);
		CHECK(pi_card_file_load(&w.card, raw) == PI_OK);
		pi_put32(raw + PI_FILE_AT_GEN, w.card.file.generation + 1);
		CHECK(pi_card_file_store(&w.card, raw) == PI_OK && !w.card.file.offered);
		w.card.file.offered = true;
		CHECK(ask(&link, PI_DLINK_FILE_READ, args, 8, &a, tx) && pi_get32(a.payload) == 2);
		CHECK(a.payload[PI_DLINK_ANSWER_HEAD] == 0x77 && w.card.opens == opens);
	}
	offer_file(&w, v2, SIZE, "1.2.0", "1.1.0", 2);
	CHECK(pi_os_run(&w.os, &w.job) == PI_OK && w.card.file.generation == 3);
	CHECK(!w.card.file.offered && w.card.file.read == 0 && w.card.file.result == PI_OS_NONE);
	w.card.file.offered = true;
	CHECK(ask(&link, PI_DLINK_FILE_READ, args, 8, &a, tx) && pi_get32(a.payload) == 3 &&
	      memcmp(a.payload + PI_DLINK_ANSWER_HEAD, v2 + SIZE - 100, 100) == 0);
	CHECK(read_whole(&link, v2, SIZE, 3));
	/* A full image: FILE_INFO's flag. */
	offer_file(&w, v1, SIZE, "2.0.0", "", 3);
	CHECK(pi_os_run(&w.os, &w.job) == PI_OK);
	CHECK(ask(&link, PI_DLINK_FILE_INFO, NULL, 0, &a, tx) && a.payload[3] == PI_DLINK_FILE_FULL);
	CHECK(a.payload[84] == 0 && pi_get32(a.payload + 4) == 4);

	/* The card taken out: no card, and its file is not served. */
	w.card.file.offered = true;
	pi_card_close(&w.card);
	CHECK(ask(&link, PI_DLINK_FILE_INFO, NULL, 0, &a, tx) && a.payload[3] == PI_DLINK_INFO_NO_CARD);
	read_args(args, 0, 16);
	CHECK(ask(&link, PI_DLINK_FILE_READ, args, 8, &a, tx) && error_code(&a) == PI_DLINK_CARD);
	/* Put back: read again, and not offered until the job offers it again. */
	CHECK(pi_card_open(&w.card, MAX_BLOCKS) == PI_OK && !w.card.file.offered);
	CHECK(ask(&link, PI_DLINK_FILE_READ, args, 8, &a, tx) && error_code(&a) == PI_DLINK_NO_IMAGE);
	/* A header the card cannot give back now: FILE_INFO is refused, not made up. */
	w.disk.fail_reads = true;
	CHECK(ask(&link, PI_DLINK_FILE_INFO, NULL, 0, &a, tx) && error_code(&a) == PI_DLINK_CARD);
	w.disk.fail_reads = false;

	/* Messages between the requests: delivered once, and the answers carry their ack. */
	{
		uint8_t rx[PI_FRAME_SIZE];
		struct pi_frame data = { .type = PI_FRAME_DATA, .session = 0x7777, .seq = 5,
					 .length = 2, .payload = (const uint8_t *)"{}" };
		struct pi_frame in;

		memset(rx, 0, sizeof(rx));
		CHECK(pi_frame_encode(rx, sizeof(rx), &data) > 0);
		CHECK(pi_rx_handle(&link_rx, rx, sizeof(rx), &in) == PI_RX_DELIVER);
		CHECK(ask(&link, PI_DLINK_FILE_INFO, NULL, 0, &a, tx) && a.session == 0x7777 && a.ack == 5);
	}

	fake_disk_free(&w.disk);
	free(v1);
	free(v2);
}

/* ------------------------------------------------------------------------------------------- */
/* The job, once offered                                                                        */

static void test_watch(void)
{
	struct pi_card card;
	struct pi_os_job job;

	memset(&card, 0, sizeof(card));
	memset(&job, 0, sizeof(job));
	strcpy(job.version, "1.1.0");
	card.open = true;
	card.file.state = PI_FILE_READY;
	card.file.generation = 4;
	card.file.offered = true;

	CHECK(pi_os_watch(&card, &job, 4) == PI_OS_OFFERED);
	card.file.read = 480;
	CHECK(pi_os_watch(&card, &job, 4) == PI_OS_FETCHED);
	card.file.result = PI_OS_APPLIED;
	CHECK(pi_os_watch(&card, &job, 4) == PI_OS_ON_TRIAL);
	card.file.result = PI_OS_CONFIRMED;
	CHECK(pi_os_watch(&card, &job, 4) == PI_OS_SUCCEEDED);
	card.file.result = PI_OS_ROLLED_BACK;
	CHECK(pi_os_watch(&card, &job, 4) == PI_OS_FAILED);
	card.file.result = PI_OS_REFUSED;
	CHECK(pi_os_watch(&card, &job, 4) == PI_OS_FAILED);
	card.file.result = PI_OS_NONE;

	/* Another generation, or no file: lost. No card: wait. */
	CHECK(pi_os_watch(&card, &job, 3) == PI_OS_LOST);
	card.file.state = PI_FILE_DOWNLOADING;
	CHECK(pi_os_watch(&card, &job, 4) == PI_OS_LOST);
	card.file.state = PI_FILE_READY;
	card.open = false;
	CHECK(pi_os_watch(&card, &job, 4) == PI_OS_WAIT_CARD);

	/* The Pi's status: it runs the job's version off trial, even with no card (a result lost). */
	card.os.known = true;
	strcpy(card.os.version, "1.1.0");
	card.os.trial = 1;
	CHECK(pi_os_watch(&card, &job, 4) == PI_OS_WAIT_CARD && !pi_os_pi_runs(&card, "1.1.0"));
	card.os.trial = 0;
	CHECK(pi_os_watch(&card, &job, 4) == PI_OS_SUCCEEDED && pi_os_pi_runs(&card, "1.1.0"));
	CHECK(!pi_os_pi_runs(&card, "1.1") && !pi_os_pi_runs(&card, "1.1.0.1"));
	strcpy(card.os.version, "1.0.0");
	card.open = true;
	CHECK(pi_os_watch(&card, &job, 4) == PI_OS_FETCHED);
	card.file.read = 0;
	CHECK(pi_os_watch(&card, &job, 4) == PI_OS_OFFERED);
	card.os.version[0] = '\0';
	CHECK(!pi_os_pi_runs(&card, ""));
	card.os.known = false;
	strcpy(card.os.version, "1.1.0");
	CHECK(!pi_os_pi_runs(&card, "1.1.0"));

	CHECK(strcmp(pi_os_watch_name(PI_OS_OFFERED), "offered") == 0);
	CHECK(strcmp(pi_os_watch_name(PI_OS_FETCHED), "fetched") == 0);
	CHECK(strcmp(pi_os_watch_name(PI_OS_ON_TRIAL), "applied") == 0);
	CHECK(strcmp(pi_os_watch_name(200), "offered") == 0);
}

/* {details} is a JSON object whose every value is a string, as AWS IoT Jobs takes statusDetails. */
static bool details_ok(const char *details, const char *key, const char *value)
{
	char json[512];
	cJSON *o;
	const cJSON *item;
	bool ok;

	snprintf(json, sizeof(json), "{%s}", details);
	o = cJSON_Parse(json);
	ok = cJSON_IsObject(o);
	cJSON_ArrayForEach(item, o) {
		ok = ok && cJSON_IsString(item) && item->valuestring[0] != '\0';
	}
	item = cJSON_GetObjectItemCaseSensitive(o, key);
	ok = ok && cJSON_IsString(item) && strcmp(item->valuestring, value) == 0;
	if (!ok) {
		printf("     details: %s\n", details);
	}
	cJSON_Delete(o);
	return ok;
}

static void test_details(void)
{
	char buf[160];

	CHECK(pi_os_details_progress(buf, sizeof(buf), pi_os_step_name(PI_OS_STEP_DOWNLOAD), 512, 1024) > 0);
	CHECK(strcmp(buf, "\"step\":\"download\",\"progress\":\"50\",\"done\":\"512\",\"total\":\"1024\"") == 0);
	CHECK(details_ok(buf, "progress", "50"));
	CHECK(pi_os_details_progress(buf, sizeof(buf), pi_os_step_name(PI_OS_STEP_VERIFY), 9000, 1024) > 0);
	CHECK(details_ok(buf, "done", "1024") && details_ok(buf, "step", "verify"));
	CHECK(pi_os_details_progress(buf, sizeof(buf), pi_os_step_name(PI_OS_STEP_DOWNLOAD), UINT32_MAX, UINT32_MAX) > 0);
	CHECK(details_ok(buf, "progress", "100"));
	CHECK(pi_os_details_progress(buf, 10, "download", 1, 2) == -ENOSPC);
	/* A delta update's, the same report with its step and blocks (pi_delta_ota.c). */
	CHECK(pi_os_details_progress(buf, sizeof(buf), pi_step_name(PI_STEP_BLOCKS), 4, 10) > 0);
	CHECK(strcmp(buf, "\"step\":\"blocks\",\"progress\":\"40\",\"done\":\"4\",\"total\":\"10\"") == 0);
	CHECK(pi_os_details_progress(buf, sizeof(buf), "manifest", 0, 0) > 0 && details_ok(buf, "progress", "0"));

	CHECK(pi_os_details_offer(buf, sizeof(buf), PI_OS_OFFERED, 7, 0, 5000) > 0);
	CHECK(strcmp(buf, "\"step\":\"offered\",\"generation\":\"7\",\"read\":\"0\",\"total\":\"5000\"") == 0);
	CHECK(pi_os_details_offer(buf, sizeof(buf), PI_OS_FETCHED, 7, 2400, 5000) > 0);
	CHECK(details_ok(buf, "step", "fetched") && details_ok(buf, "read", "2400"));
	CHECK(pi_os_details_offer(buf, sizeof(buf), PI_OS_ON_TRIAL, 7, 9999, 5000) > 0);
	CHECK(details_ok(buf, "step", "applied") && details_ok(buf, "read", "5000"));

	CHECK(pi_os_details_succeeded(buf, sizeof(buf), "1.1.0", 7, 5000, 5000, "1.20.2") > 0);
	CHECK(details_ok(buf, "pi_version", "1.1.0") && details_ok(buf, "generation", "7"));
	CHECK(details_ok(buf, "bytes", "5000") && details_ok(buf, "running", "1.20.2"));
	CHECK(pi_os_details_succeeded(buf, sizeof(buf), "9999999999999999999999999999999", UINT32_MAX,
				      UINT64_MAX, UINT32_MAX, "1.20.2+4294967295") > 0);
	CHECK(details_ok(buf, "bytes", "18446744073709551615"));

	CHECK(pi_os_details_failed(buf, sizeof(buf), PI_OS_ROLLED_BACK, "health check failed", "1.20.2") > 0);
	CHECK(details_ok(buf, "reason", "rolled_back") && details_ok(buf, "pi_reason", "health check failed"));
	CHECK(details_ok(buf, "step", "result"));
	CHECK(pi_os_details_failed(buf, sizeof(buf), PI_OS_REFUSED, "a\"b\\c\nd", "1.20.2") > 0);
	CHECK(details_ok(buf, "reason", "refused") && details_ok(buf, "pi_reason", "a?b?c?d"));
	/* The longest reason. */
	CHECK(pi_os_details_failed(buf, sizeof(buf), PI_OS_ROLLED_BACK,
				   "0123456789012345678901234567890123456789", "1.20.2+4294967295") > 0);
	CHECK(details_ok(buf, "pi_reason", "01234567890123456789012345678901"));
	CHECK(pi_os_details_failed(buf, 20, PI_OS_REFUSED, "x", "1.20.2") == -ENOSPC);
}

/* ------------------------------------------------------------------------------------------- */
/* The heartbeat's card report                                                                  */

static bool report_os_is(const struct pi_delta *d, const char *os)
{
	char buf[PI_DELTA_REPORT_MAX];
	char want[PI_DELTA_REPORT_MAX + 64];
	int written = pi_delta_report(d, false, buf, sizeof(buf));
	const char *at = written > 0 ? strstr(buf, ",\"os\":") : NULL;
	cJSON *json = written > 0 ? cJSON_Parse(buf) : NULL;
	cJSON *part = cJSON_GetObjectItemCaseSensitive(json, "os");
	bool ok;

	snprintf(want, sizeof(want), ",\"os\":%s}", os);
	ok = at != NULL && strcmp(at, want) == 0 && cJSON_IsObject(part) &&
	     cJSON_GetArraySize(part) == 7 && written == (int)strlen(buf);
	if (!ok) {
		printf("     report: %s\n", written > 0 ? buf : "(none)");
	}
	cJSON_Delete(json);
	return ok;
}

static void test_report(void)
{
	struct world w;
	struct pi_delta delta;
	struct pi_fetch fetch = { .get = fake_server_get };
	char buf[PI_DELTA_REPORT_MAX];
	uint8_t *v1 = make_file(71, SIZE);

	world_create(&w);
	pi_card_init(&w.card, &fake_disk_ops, &w.disk);
	pi_delta_init(&delta, &w.card, &delta_config, &fetch, fake_verify, NULL);

	/* Nothing from the Pi yet, and no card. */
	CHECK(report_os_is(&delta, "{\"version\":\"\",\"slot\":\"\",\"last\":\"none\",\"file\":\"none\","
				   "\"result\":\"none\",\"done\":0,\"size\":0}"));
	/* What the Pi said. */
	w.card.os.known = true;
	w.card.os.slot = 'b';
	w.card.os.last = PI_OS_CONFIRMED;
	strcpy(w.card.os.version, "1.1.0");
	CHECK(report_os_is(&delta, "{\"version\":\"1.1.0\",\"slot\":\"b\",\"last\":\"confirmed\","
				   "\"file\":\"none\",\"result\":\"none\",\"done\":0,\"size\":0}"));
	/* A version or a slot that are not one are not reported. */
	memcpy(w.card.os.version, "1\"}", 4);
	w.card.os.slot = '"';
	CHECK(report_os_is(&delta, "{\"version\":\"\",\"slot\":\"\",\"last\":\"confirmed\","
				   "\"file\":\"none\",\"result\":\"none\",\"done\":0,\"size\":0}"));
	strcpy(w.card.os.version, "1.1.0");
	w.card.os.slot = 'b';

	/* A file half downloaded, then whole, then offered, then with the Pi's result. */
	CHECK(pi_card_open(&w.card, MAX_BLOCKS) == PI_OK);
	offer_file(&w, v1, SIZE, "1.2.0", "1.1.0", 1);
	w.fetch.get = fake_server_get;
	w.fetch.ctx = &w.server;
	pi_os_init(&w.os, &w.card, &os_config, &w.fetch, w.io, &w.stop);
	w.server.drop_after = 9 * PI_SECTOR_SIZE;
	CHECK(pi_os_run(&w.os, &w.job) == PI_ERR_DOWNLOAD);
	CHECK(report_os_is(&delta, "{\"version\":\"1.1.0\",\"slot\":\"b\",\"last\":\"confirmed\","
				   "\"file\":\"downloading\",\"result\":\"none\",\"done\":4608,\"size\":10340}"));
	CHECK(pi_os_run(&w.os, &w.job) == PI_OK);
	CHECK(report_os_is(&delta, "{\"version\":\"1.1.0\",\"slot\":\"b\",\"last\":\"confirmed\","
				   "\"file\":\"held\",\"result\":\"none\",\"done\":10340,\"size\":10340}"));
	w.card.file.offered = true;
	w.card.file.result = PI_OS_REFUSED;
	CHECK(report_os_is(&delta, "{\"version\":\"1.1.0\",\"slot\":\"b\",\"last\":\"confirmed\","
				   "\"file\":\"ready\",\"result\":\"refused\",\"done\":10340,\"size\":10340}"));
	/* The card taken out: its file is not reported; what the Pi said is. */
	pi_card_close(&w.card);
	CHECK(report_os_is(&delta, "{\"version\":\"1.1.0\",\"slot\":\"b\",\"last\":\"confirmed\","
				   "\"file\":\"none\",\"result\":\"none\",\"done\":0,\"size\":0}"));

	/*
	 * Every field at its longest: PI_DELTA_REPORT_MAX with its terminating zero, exactly, which is
	 * what main.c leaves for it. A byte less is refused.
	 */
	CHECK(pi_card_open(&w.card, MAX_BLOCKS) == PI_OK);
	w.card.st.state = PI_STATE_UPDATING;
	w.card.st.generation = UINT32_MAX;
	memset(w.card.neu.version, 0, sizeof(w.card.neu.version));
	memset(w.card.neu.version, '9', PI_VERSION_MAX);
	delta.step = PI_STEP_MANIFEST;
	delta.stats.blocks_total = UINT32_MAX;
	delta.stats.blocks_done = UINT32_MAX;
	memset(w.card.os.version, 0, sizeof(w.card.os.version));
	memset(w.card.os.version, '8', PI_VERSION_MAX);
	w.card.os.slot = 'a';
	w.card.os.last = PI_OS_ROLLED_BACK;
	w.card.file.state = PI_FILE_DOWNLOADING;
	w.card.file.result = PI_OS_ROLLED_BACK;
	w.card.file.done = UINT32_MAX;
	w.card.file.size = UINT32_MAX;
	CHECK(pi_delta_report(&delta, true, buf, sizeof(buf)) == (int)PI_DELTA_REPORT_MAX - 1);
	{
		cJSON *json = cJSON_Parse(buf);

		CHECK(cJSON_IsObject(cJSON_GetObjectItem(json, "os")));
		cJSON_Delete(json);
	}
	CHECK(pi_delta_report(&delta, true, buf, sizeof(buf) - 1) == -ENOSPC);
	/* Room for the card's part and not the Pi's: refused, not cut. */
	CHECK(pi_delta_report(&delta, true, buf, 150) == -ENOSPC);

	fake_disk_free(&w.disk);
	free(v1);
}

/* ------------------------------------------------------------------------------------------- */
/* The job document                                                                             */

static const char prefix[] = "https://bucket.example/firmware/";

static enum ota_job_result parse_doc(const char *doc, bool in_progress, struct ota_job *job)
{
	char json[1024];

	snprintf(json, sizeof(json),
		 "{\"execution\":{\"jobId\":\"pi-os-1\",\"status\":\"%s\",\"jobDocument\":%s}}",
		 in_progress ? "IN_PROGRESS" : "QUEUED", doc);
	return ota_job_parse(json, strlen(json), prefix, job);
}

static void test_job_document(void)
{
	static struct ota_job job;
	const char *sha = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
	char doc[512];

	snprintf(doc, sizeof(doc),
		 "{\"op\":\"pi_os\",\"v\":1,\"pi\":{\"version\":\"1.1.0\",\"from\":\"1.0.0\","
		 "\"size\":4194304,\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/"
		 "pi-os-1.1.0.update?X-Amz=1\"}}",
		 sha);
	CHECK(parse_doc(doc, true, &job) == OTA_JOB_OK);
	CHECK(job.pi_os && !job.pi_delta && !job.golden && job.in_progress);
	CHECK(strcmp(job.pi_version, "1.1.0") == 0 && strcmp(job.pi_from, "1.0.0") == 0);
	CHECK(job.size == 4194304 && job.sha256[1] == 0x11 && job.sha256[31] == 0xff);
	CHECK(strcmp(job.host, "https://bucket.example") == 0);
	CHECK(strcmp(job.file, "firmware/pi-os-1.1.0.update?X-Amz=1") == 0);
	CHECK(strcmp(job.id, "pi-os-1") == 0);

	/* A full image: from is null. */
	snprintf(doc, sizeof(doc),
		 "{\"op\":\"pi_os\",\"v\":1,\"pi\":{\"version\":\"2.0.0\",\"from\":null,\"size\":4294967295,"
		 "\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/full\"}}",
		 sha);
	CHECK(parse_doc(doc, false, &job) == OTA_JOB_OK);
	CHECK(job.pi_os && job.pi_from[0] == '\0' && job.size == UINT32_MAX && !job.in_progress);
	for (size_t i = 0; i < sizeof(job.pi_from); i++) {
		CHECK(job.pi_from[i] == '\0');
	}

	const char *bad[] = {
		"{\"op\":\"pi_os\",\"v\":1}",
		"{\"op\":\"pi_os\",\"v\":1,\"pi\":\"x\"}",
		/* No from at all. */
		"{\"op\":\"pi_os\",\"v\":1,\"pi\":{\"version\":\"1.1.0\",\"size\":10,\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/x\"}}",
		"{\"op\":\"pi_os\",\"v\":1,\"pi\":{\"version\":\"1.1.0\",\"from\":\"\",\"size\":10,\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/x\"}}",
		"{\"op\":\"pi_os\",\"v\":1,\"pi\":{\"version\":\"1.1.0\",\"from\":\"1 0\",\"size\":10,\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/x\"}}",
		"{\"op\":\"pi_os\",\"v\":1,\"pi\":{\"version\":\"1.1.0\",\"from\":7,\"size\":10,\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/x\"}}",
		"{\"op\":\"pi_os\",\"v\":1,\"pi\":{\"version\":\"1/1\",\"from\":null,\"size\":10,\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/x\"}}",
		"{\"op\":\"pi_os\",\"v\":1,\"pi\":{\"version\":\"0123456789012345678901234567890123\",\"from\":null,\"size\":10,\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/x\"}}",
		"{\"op\":\"pi_os\",\"v\":1,\"pi\":{\"version\":\"1.1.0\",\"from\":null,\"size\":0,\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/x\"}}",
		"{\"op\":\"pi_os\",\"v\":1,\"pi\":{\"version\":\"1.1.0\",\"from\":null,\"size\":4294967296,\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/x\"}}",
		"{\"op\":\"pi_os\",\"v\":1,\"pi\":{\"version\":\"1.1.0\",\"from\":null,\"size\":10.5,\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/x\"}}",
		"{\"op\":\"pi_os\",\"v\":1,\"pi\":{\"version\":\"1.1.0\",\"from\":null,\"size\":\"10\",\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/x\"}}",
		"{\"op\":\"pi_os\",\"v\":1,\"pi\":{\"version\":\"1.1.0\",\"from\":null,\"size\":10,\"sha256\":\"abc\",\"url\":\"https://bucket.example/firmware/x\"}}",
		"{\"op\":\"pi_os\",\"v\":1,\"pi\":{\"version\":\"1.1.0\",\"from\":null,\"size\":10,\"sha256\":\"%s\"}}",
	};
	for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
		snprintf(doc, sizeof(doc), bad[i], sha);
		CHECK(parse_doc(doc, false, &job) == OTA_JOB_BAD_DOCUMENT);
		CHECK(strcmp(job.id, "pi-os-1") == 0 && !job.pi_os);
	}
	snprintf(doc, sizeof(doc),
		 "{\"op\":\"pi_os\",\"v\":1,\"pi\":{\"version\":\"1.1.0\",\"from\":null,\"size\":10,"
		 "\"sha256\":\"%s\",\"url\":\"https://elsewhere.example/firmware/x\"}}",
		 sha);
	CHECK(parse_doc(doc, false, &job) == OTA_JOB_URL_NOT_ALLOWED);
	snprintf(doc, sizeof(doc),
		 "{\"op\":\"pi_os\",\"v\":2,\"pi\":{\"version\":\"1.1.0\",\"from\":null,\"size\":10,"
		 "\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/x\"}}",
		 sha);
	CHECK(parse_doc(doc, false, &job) == OTA_JOB_UNSUPPORTED);
}

int main(void)
{
	pi_card_layout_for(MAX_BLOCKS, &layout);
	card_sectors = layout.mirror_lba + 4 * 2048;

	test_file_format();
	test_download();
	test_power_cut_everywhere();
	test_interruptions();
	test_digest();
	test_placement();
	test_delta_takes_a_held_files_room();
	test_link();
	test_watch();
	test_details();
	test_report();
	test_job_document();

	printf("pi_os_tests: %d checks, %d failures\n", checks, failures);
	return failures == 0 ? 0 : 1;
}
