/*
 * Host tests of Raspberry Pi delta updates (firmware 1.20.0, docs/pi-delta-update.md): the formats
 * (src/pi/pi_delta_fmt.c), the card (pi_card.c), the update (pi_delta.c), the Pi's link
 * (pi_dlink.c, behind the message link's pi_rx.c, as pi_link.c has them) and the "pi_delta" job
 * document (src/ota/ota_job.c).
 *
 * The card is in memory and can lose power at any write, be pulled out or fail; the server hands
 * out ranges in pieces of any size and can drop the connection or send wrong bytes; the signature is
 * a fake one only these tests make (firmware/tests/hil/test_pi_delta.py checks the real ECDSA, with
 * tools/pi_image.py and pi_delta_harness.c).
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
#include "pi_http.h"
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

#define BS        4096u
#define MAX_BLOCKS 256u
#define BLOCKS    40u

static const struct pi_delta_config config = {
	.default_max_blocks = MAX_BLOCKS,
	.run_blocks = 4,
	.block_attempts = 3,
	.skip_save_every = 8,
	.table_save_every = 1,
};

static struct pi_card_layout layout;
static uint64_t disk_sectors;

/* ------------------------------------------------------------------------------------------- */

static uint32_t seed_state;

static uint8_t random_byte(void)
{
	seed_state = seed_state * 1664525u + 1013904223u;
	return (uint8_t)(seed_state >> 24);
}

/* An image of `blocks` blocks: random, with blocks 3 and 4 all zero, as free space in a disk image is. */
static uint8_t *make_image(uint32_t seed, uint32_t blocks, uint64_t *size)
{
	uint8_t *image;

	*size = (uint64_t)blocks * BS;
	image = malloc((size_t)*size);
	seed_state = seed;
	for (uint64_t i = 0; i < *size; i++) {
		image[i] = random_byte();
	}
	if (blocks > 4) {
		memset(image + 3 * BS, 0, 2 * BS);
	}
	return image;
}

static void change_block(uint8_t *image, uint32_t block, uint8_t value)
{
	memset(image + (uint64_t)block * BS + 100, value, 700);
}

struct world {
	struct fake_disk disk;
	struct fake_server server;
	struct pi_card card;
	struct pi_delta delta;
	struct pi_fetch fetch;
	volatile bool stop;
	uint8_t *package;
	struct pi_manifest m;
	struct pi_delta_job job;
};

static void world_create(struct world *w)
{
	memset(w, 0, sizeof(*w));
	fake_disk_create(&w->disk, disk_sectors);
}

static void world_free(struct world *w)
{
	fake_disk_free(&w->disk);
	free(w->package);
	w->package = NULL;
}

/* A new package for the server, and the job that names it. */
static void serve(struct world *w, const uint8_t *image, uint64_t size, const char *version)
{
	uint64_t package_size;

	free(w->package);
	w->package = fake_package(image, size, BS, version, &package_size, &w->m);
	memset(&w->server, 0, sizeof(w->server));
	w->server.package = w->package;
	w->server.size = package_size;
	w->server.max_piece = 1500;
	w->server.seed = 7;
	w->server.drop_after = -1;
	w->server.stop_after = -1;
	w->server.stop_flag = &w->stop;
	memset(&w->job, 0, sizeof(w->job));
	strncpy(w->job.version, version, PI_VERSION_MAX);
	memcpy(w->job.sha256, w->m.image_sha256, PI_HASH_SIZE);
}

/* One call, as after a restart: everything in RAM is new, the card is what it was. */
static enum pi_err run(struct world *w, bool *already)
{
	bool ignored;

	pi_card_init(&w->card, &fake_disk_ops, &w->disk);
	w->fetch.get = fake_server_get;
	w->fetch.ctx = &w->server;
	pi_delta_init(&w->delta, &w->card, &config, &w->fetch, fake_verify, &w->stop);
	return pi_delta_run(&w->delta, &w->job, already != NULL ? already : &ignored);
}

static bool mirror_is(const struct world *w, const uint8_t *image, uint64_t size)
{
	return memcmp(w->disk.data + layout.mirror_lba * PI_SECTOR_SIZE, image, (size_t)size) == 0;
}

/* The blocks the server sent, from its log of ranges. */
static uint32_t blocks_requested(const struct world *w, bool *which, uint32_t count)
{
	uint32_t total = 0;

	memset(which, 0, count);
	for (uint32_t r = 0; r < w->server.requests && r < 4096; r++) {
		uint64_t from = w->server.log_offset[r];
		uint64_t to = from + w->server.log_len[r];

		if (from < w->m.image_offset) {
			continue;
		}
		for (uint64_t b = (from - w->m.image_offset) / BS;
		     b < (to - w->m.image_offset + BS - 1) / BS && b < count; b++) {
			if (!which[b]) {
				which[b] = true;
				total++;
			}
		}
	}
	return total;
}

static struct pi_card_state state_on_card(struct world *w)
{
	struct pi_card card;

	pi_card_init(&card, &fake_disk_ops, &w->disk);
	(void)pi_card_open(&card, MAX_BLOCKS);
	return card.st;
}

/* ------------------------------------------------------------------------------------------- */

static void test_manifest_format(void)
{
	uint8_t image[3 * BS];
	uint8_t raw[PI_MANIFEST_SIZE];
	uint8_t bad[PI_MANIFEST_SIZE];
	struct pi_manifest m, back;
	uint64_t size;
	uint8_t *package;

	memset(image, 0x42, sizeof(image));
	package = fake_package(image, sizeof(image) - 512, BS, "2026.11.24-1", &size, &m);
	memcpy(raw, package, sizeof(raw));
	CHECK(pi_manifest_decode(raw, &back) == PI_OK);
	CHECK(back.block_size == BS && back.block_count == 3 && back.image_size == 3 * BS - 512);
	CHECK(back.table_offset == 512 && back.image_offset == 4096);
	CHECK(strcmp(back.version, "2026.11.24-1") == 0);
	CHECK(memcmp(back.sig, m.sig, PI_SIG_SIZE) == 0);
	CHECK(fake_verify(raw, PI_MANIFEST_SIGNED_SIZE, back.sig));
	CHECK(pi_manifest_block_len(&back, 0) == BS && pi_manifest_block_len(&back, 2) == BS - 512);
	CHECK(pi_manifest_block_len(&back, 3) == 0);
	CHECK(size == 4096 + 3 * BS - 512);

	/* Every field that can be wrong is refused. */
	struct {
		size_t at;
		uint8_t value;
	} breaks[] = {
		{ 0, 'X' },     /* magic */
		{ 4, 2 },       /* format */
		{ 7, 0 },       /* header size */
		{ 9, 0x11 },    /* block size, not a power of two */
		{ 10, 0x40 },   /* block size above 1 MiB */
		{ 12, 4 },      /* block count */
		{ 16, 1 },      /* image size, not whole sectors */
		{ 25, 0 },      /* table offset */
		{ 33, 0 },      /* image offset before the end of the table */
		{ 32, 1 },      /* image offset not aligned */
		{ 104, '/' },   /* a character a version may not have */
		{ 104, 0 },     /* an empty version */
		{ 135, 'x' },   /* a version with no room for its end */
		{ 136, 1 },     /* flags */
		{ 300, 1 },     /* the zeros */
	};
	for (size_t i = 0; i < sizeof(breaks) / sizeof(breaks[0]); i++) {
		memcpy(bad, raw, sizeof(bad));
		bad[breaks[i].at] = breaks[i].value;
		CHECK(pi_manifest_decode(bad, &back) == PI_ERR_BAD_MANIFEST);
	}
	/* A block size under 4 KiB. */
	memcpy(bad, raw, sizeof(bad));
	pi_put32(bad + 8, 2048);
	CHECK(pi_manifest_decode(bad, &back) == PI_ERR_BAD_MANIFEST);
	/* The signature covers bytes 0 to 447 only. */
	memcpy(bad, raw, sizeof(bad));
	bad[20] ^= 1;
	CHECK(!fake_verify(bad, PI_MANIFEST_SIGNED_SIZE, back.sig));

	{
		char field[32] = "1.2.3+4_a-B";

		CHECK(pi_version_valid(field, sizeof(field)));
		memset(field, 0, sizeof(field));
		CHECK(!pi_version_valid(field, sizeof(field)));
		strcpy(field, "a b");
		CHECK(!pi_version_valid(field, sizeof(field)));
		memset(field, 'a', sizeof(field));
		CHECK(!pi_version_valid(field, sizeof(field)));
	}
	CHECK(strcmp(pi_err_reason(PI_ERR_BAD_SIGNATURE), "bad_signature") == 0);
	CHECK(strcmp(pi_err_reason(PI_ERR_COUNT), "unknown") == 0);
	free(package);
}

static void test_state_format(void)
{
	struct pi_card_state st, back;
	uint8_t raw[PI_SECTOR_SIZE];
	struct pi_card_layout l;

	memset(&st, 0, sizeof(st));
	st.seq = 9;
	st.max_blocks = 1000;
	st.state = PI_STATE_UPDATING;
	st.cur_slot = 1;
	st.new_slot = 0;
	st.phase = PI_PHASE_BLOCKS;
	st.flags = PI_FLAG_HAS_CUR | PI_FLAG_DIRTY;
	st.generation = 4;
	st.changed_count = 17;
	st.next = 3;
	strcpy(st.base_version, "v1");
	st.base_sha256[0] = 0xab;
	pi_card_state_encode(&st, raw);
	CHECK(pi_card_state_decode(raw, &back));
	CHECK(memcmp(&st, &back, sizeof(st)) == 0);

	raw[100] ^= 1;
	CHECK(!pi_card_state_decode(raw, &back));

	/* States that cannot go together. */
	st.phase = PI_PHASE_NONE;
	pi_card_state_encode(&st, raw);
	CHECK(!pi_card_state_decode(raw, &back));
	st.phase = PI_PHASE_BLOCKS;
	st.new_slot = 1;
	pi_card_state_encode(&st, raw);
	CHECK(!pi_card_state_decode(raw, &back));
	st.new_slot = 0;
	st.state = PI_STATE_READY;
	pi_card_state_encode(&st, raw);
	CHECK(!pi_card_state_decode(raw, &back));
	st.state = PI_STATE_EMPTY;
	st.phase = PI_PHASE_NONE;
	pi_card_state_encode(&st, raw);
	CHECK(!pi_card_state_decode(raw, &back));
	st.flags = 0x80;
	pi_card_state_encode(&st, raw);
	CHECK(!pi_card_state_decode(raw, &back));

	/* The layout: in order, aligned, apart. */
	pi_card_layout_for(262144, &l);
	CHECK(l.state_lba[0] == 2048 && l.state_lba[1] == 2049);
	CHECK(l.slot_lba[0] == 4096);
	CHECK(l.slot_lba[0] % 2048 == 0 && l.slot_lba[1] % 2048 == 0 && l.list_lba % 2048 == 0);
	CHECK(l.slot_lba[1] - l.slot_lba[0] >= 1 + 262144 * 32 / 512);
	CHECK(l.list_lba - l.slot_lba[1] >= 1 + 262144 * 32 / 512);
	CHECK(l.staging_lba - l.list_lba >= 262144 * 4 / 512);
	CHECK(l.mirror_lba - l.staging_lba >= 2048 && l.mirror_lba % 8192 == 0);
	/* 16 GiB of 64 KiB blocks takes 20 MiB of the card besides the mirror. */
	CHECK(l.mirror_lba * 512 <= 24ull * 1024 * 1024);
}

static void test_card(void)
{
	struct world w;
	struct pi_card card;

	world_create(&w);
	pi_card_init(&card, &fake_disk_ops, &w.disk);

	/* A blank card is empty, and nothing is written to it until something is saved. */
	CHECK(pi_card_open(&card, MAX_BLOCKS) == PI_OK);
	CHECK(card.st.state == PI_STATE_EMPTY && card.st.max_blocks == MAX_BLOCKS);
	CHECK(w.disk.writes == 0);

	/* Saves alternate between the two copies; the later one counts. */
	card.st.generation = 5;
	CHECK(pi_card_save(&card) == PI_OK);
	card.st.generation = 6;
	CHECK(pi_card_save(&card) == PI_OK);
	pi_card_init(&card, &fake_disk_ops, &w.disk);
	CHECK(pi_card_open(&card, MAX_BLOCKS) == PI_OK);
	CHECK(card.st.generation == 6);

	/* A save the power cut in half: the other copy still holds the one before. */
	card.st.generation = 7;
	w.disk.writes_left = 0;
	CHECK(pi_card_save(&card) == PI_ERR_SD_IO);
	fake_disk_power_on(&w.disk);
	pi_card_init(&card, &fake_disk_ops, &w.disk);
	CHECK(pi_card_open(&card, MAX_BLOCKS) == PI_OK);
	CHECK(card.st.generation == 6);

	/* No card, and a card that fails. */
	w.disk.absent = true;
	CHECK(pi_card_open(&card, MAX_BLOCKS) == PI_ERR_SD_ABSENT);
	w.disk.absent = false;
	w.disk.fail_reads = true;
	CHECK(pi_card_open(&card, MAX_BLOCKS) == PI_ERR_SD_IO);
	w.disk.fail_reads = false;

	/* A card too small for its layout. */
	{
		struct fake_disk small;
		struct pi_card c;

		fake_disk_create(&small, layout.mirror_lba);
		pi_card_init(&c, &fake_disk_ops, &small);
		CHECK(pi_card_open(&c, MAX_BLOCKS) == PI_ERR_TOO_LARGE);
		fake_disk_free(&small);
	}
	world_free(&w);
}

/* ------------------------------------------------------------------------------------------- */

static void install(struct world *w, const uint8_t *image, uint64_t size, const char *version)
{
	serve(w, image, size, version);
	CHECK(run(w, NULL) == PI_OK);
	CHECK(mirror_is(w, image, size));
}

static void test_first_and_delta(void)
{
	struct world w;
	uint64_t size;
	uint8_t *v1 = make_image(1, BLOCKS, &size);
	uint8_t *v2 = malloc((size_t)size);
	bool which[BLOCKS];
	bool already;
	struct pi_card_state st;

	world_create(&w);

	/* An empty card: every block is downloaded, except those already right (the zero ones). */
	serve(&w, v1, size, "v1");
	CHECK(run(&w, &already) == PI_OK);
	CHECK(!already);
	CHECK(mirror_is(&w, v1, size));
	CHECK(w.delta.stats.blocks_total == BLOCKS);
	CHECK(w.delta.stats.blocks_skipped == 2);
	CHECK(w.delta.stats.blocks_fetched == BLOCKS - 2);
	CHECK(blocks_requested(&w, which, BLOCKS) == BLOCKS - 2);
	CHECK(!which[3] && !which[4]);
	st = state_on_card(&w);
	CHECK(st.state == PI_STATE_READY && st.generation == 1);
	CHECK((st.flags & PI_FLAG_LIST_VALID) && st.changed_count == BLOCKS);
	CHECK(st.base_version[0] == '\0');

	/* The same image again: nothing to do, and nothing downloaded. */
	CHECK(run(&w, &already) == PI_OK);
	CHECK(already);
	CHECK(w.delta.stats.requests == 0);

	/* Four blocks change: only they come, in three range requests (5 and 6 are neighbours). */
	memcpy(v2, v1, (size_t)size);
	change_block(v2, 0, 1);
	change_block(v2, 5, 2);
	change_block(v2, 6, 3);
	change_block(v2, 39, 4);
	serve(&w, v2, size, "v2");
	CHECK(run(&w, &already) == PI_OK);
	CHECK(!already);
	CHECK(mirror_is(&w, v2, size));
	CHECK(blocks_requested(&w, which, BLOCKS) == 4);
	CHECK(which[0] && which[5] && which[6] && which[39]);
	/* Header, table, then the runs 0, 5-6 and 39. */
	CHECK(w.server.requests == 5);
	CHECK(w.delta.stats.blocks_fetched == 4 && w.delta.stats.changed == 4);
	CHECK(w.server.sent == 512 + BLOCKS * 32 + 4 * BS);
	st = state_on_card(&w);
	CHECK(st.state == PI_STATE_READY && st.generation == 2 && st.changed_count == 4);
	CHECK(strcmp(st.base_version, "v1") == 0);

	/* A larger image: the blocks past the old end are new. A smaller one: only what changed. */
	{
		uint64_t big_size;
		uint8_t *v3 = make_image(1, BLOCKS + 5, &big_size);

		memcpy(v3, v2, (size_t)size);
		serve(&w, v3, big_size, "v3");
		CHECK(run(&w, NULL) == PI_OK);
		CHECK(mirror_is(&w, v3, big_size));
		CHECK(blocks_requested(&w, which, BLOCKS) == 0);
		CHECK(w.delta.stats.changed == 5);

		serve(&w, v1, size - BS, "v4");
		CHECK(run(&w, NULL) == PI_OK);
		CHECK(mirror_is(&w, v1, size - BS));
		CHECK(w.delta.stats.changed == 3);
		st = state_on_card(&w);
		CHECK(st.generation == 4 && strcmp(st.base_version, "v3") == 0);
		free(v3);
	}
	world_free(&w);
	free(v1);
	free(v2);
}

static void test_refusals(void)
{
	struct world w;
	uint64_t size;
	uint8_t *v1 = make_image(2, BLOCKS, &size);
	uint8_t *v2 = malloc((size_t)size);
	uint8_t *before;
	struct pi_card_state st;

	world_create(&w);
	install(&w, v1, size, "v1");
	memcpy(v2, v1, (size_t)size);
	change_block(v2, 10, 9);
	before = malloc((size_t)(disk_sectors * PI_SECTOR_SIZE));
	memcpy(before, w.disk.data, (size_t)(disk_sectors * PI_SECTOR_SIZE));

	/* A bad signature: refused before anything is written. */
	serve(&w, v2, size, "v2");
	w.package[PI_MANIFEST_SIGNED_SIZE + 3] ^= 1;
	CHECK(run(&w, NULL) == PI_ERR_BAD_SIGNATURE);
	CHECK(memcmp(before, w.disk.data, (size_t)(disk_sectors * PI_SECTOR_SIZE)) == 0);
	CHECK(w.server.requests == 1);

	/* A header changed after it was signed. */
	serve(&w, v2, size, "v2");
	w.package[40] ^= 1;
	CHECK(run(&w, NULL) == PI_ERR_BAD_SIGNATURE);

	/* A header that is not one. */
	serve(&w, v2, size, "v2");
	w.package[0] = 'X';
	CHECK(run(&w, NULL) == PI_ERR_BAD_MANIFEST);

	/* A job that names another version, or another digest, than the signed header. */
	serve(&w, v2, size, "v2");
	strcpy(w.job.version, "v3");
	CHECK(run(&w, NULL) == PI_ERR_MANIFEST_MISMATCH);
	serve(&w, v2, size, "v2");
	w.job.sha256[0] ^= 1;
	CHECK(run(&w, NULL) == PI_ERR_MANIFEST_MISMATCH);
	CHECK(memcmp(before, w.disk.data, (size_t)(disk_sectors * PI_SECTOR_SIZE)) == 0);

	/* A table that is not the one the header signs: the mirror is not touched, and stays ready. */
	serve(&w, v2, size, "v2");
	w.package[PI_MANIFEST_SIZE + 5] ^= 1;
	CHECK(run(&w, NULL) == PI_ERR_MANIFEST_MISMATCH);
	CHECK(mirror_is(&w, v1, size));
	st = state_on_card(&w);
	CHECK(st.state == PI_STATE_READY && st.phase == PI_PHASE_TABLE && st.next == 0);
	CHECK(!(st.flags & PI_FLAG_LIST_VALID));

	/* An image with more blocks than the card's layout. */
	{
		uint64_t huge_size;
		uint8_t *huge = make_image(3, MAX_BLOCKS + 1, &huge_size);

		serve(&w, huge, huge_size, "huge");
		CHECK(run(&w, NULL) == PI_ERR_TOO_LARGE);
		free(huge);
	}

	/* No signature check at all is no signature. */
	serve(&w, v2, size, "v2");
	pi_card_init(&w.card, &fake_disk_ops, &w.disk);
	w.fetch.get = fake_server_get;
	w.fetch.ctx = &w.server;
	{
		bool already;

		pi_delta_init(&w.delta, &w.card, &config, &w.fetch, NULL, NULL);
		CHECK(pi_delta_run(&w.delta, &w.job, &already) == PI_ERR_BAD_SIGNATURE);
	}

	/* And then the good one still goes through. */
	serve(&w, v2, size, "v2");
	CHECK(run(&w, NULL) == PI_OK);
	CHECK(mirror_is(&w, v2, size));
	free(before);
	world_free(&w);
	free(v1);
	free(v2);
}

static void test_corrupt_block(void)
{
	struct world w;
	uint64_t size;
	uint8_t *v1 = make_image(4, BLOCKS, &size);
	uint8_t *v2 = malloc((size_t)size);
	struct pi_card_state st;

	world_create(&w);
	install(&w, v1, size, "v1");
	memcpy(v2, v1, (size_t)size);
	change_block(v2, 7, 1);
	change_block(v2, 8, 1);
	change_block(v2, 20, 1);

	/* Block 8 comes wrong once: it is fetched again, and the update finishes. */
	serve(&w, v2, size, "v2");
	w.server.corrupt_from = w.m.image_offset + 8 * BS + 1000;
	w.server.corrupt_to = w.server.corrupt_from + 1;
	w.server.corrupt_times = 1;
	CHECK(run(&w, NULL) == PI_OK);
	CHECK(mirror_is(&w, v2, size));

	/* Block 20 comes wrong every time: the job fails, and the mirror's block 20 is still v2's... */
	{
		uint8_t *v3 = malloc((size_t)size);

		memcpy(v3, v2, (size_t)size);
		change_block(v3, 20, 2);
		change_block(v3, 30, 2);
		serve(&w, v3, size, "v3");
		w.server.corrupt_from = w.m.image_offset + 20 * BS + 5;
		w.server.corrupt_to = w.server.corrupt_from + 1;
		w.server.corrupt_times = 1000;
		CHECK(run(&w, NULL) == PI_ERR_DIGEST_MISMATCH);
		/* ...because a block is checked before it is written: nothing wrong reaches the mirror. */
		CHECK(memcmp(w.disk.data + (layout.mirror_lba + 20 * BS / 512) * 512, v2 + 20 * BS, BS) ==
		      0);
		st = state_on_card(&w);
		CHECK(st.state == PI_STATE_UPDATING);

		/* The server is fixed: the same job goes on and finishes. */
		w.server.corrupt_times = 0;
		CHECK(run(&w, NULL) == PI_OK);
		CHECK(mirror_is(&w, v3, size));
		free(v3);
	}

	/* A card that writes the mirror wrong once: read back, found, written again. */
	memcpy(v1, v2, (size_t)size);
	change_block(v2, 33, 4);
	serve(&w, v2, size, "v4");
	w.disk.flip_from = layout.mirror_lba;
	w.disk.flip_to = layout.mirror_lba + (uint64_t)BLOCKS * BS / PI_SECTOR_SIZE;
	w.disk.flip_times = 1;
	CHECK(run(&w, NULL) == PI_OK);
	CHECK(mirror_is(&w, v2, size));
	/* It came twice: the bytes of one block more than the update needs. */
	CHECK(w.disk.flip_times == 0);
	CHECK(w.delta.stats.bytes_fetched ==
	      512 + BLOCKS * 32 + ((uint64_t)w.delta.stats.changed + 1) * BS);

	/* Every time: the job fails, and the card does not say ready. */
	change_block(v2, 34, 4);
	serve(&w, v2, size, "v5");
	w.disk.flip_times = 1000;
	CHECK(run(&w, NULL) == PI_ERR_SD_READBACK);
	st = state_on_card(&w);
	CHECK(st.state == PI_STATE_UPDATING);
	w.disk.flip_times = 0;
	CHECK(run(&w, NULL) == PI_OK);
	CHECK(mirror_is(&w, v2, size));
	world_free(&w);
	free(v1);
	free(v2);
}

static void test_power_cut_everywhere(void)
{
	uint64_t size;
	uint8_t *v1 = make_image(5, BLOCKS, &size);
	uint8_t *v2 = malloc((size_t)size);
	struct world w;
	uint8_t *start;
	uint64_t writes_needed;
	int cuts = 0;
	int good = 0;
	int refetched_too_much = 0;

	memcpy(v2, v1, (size_t)size);
	for (uint32_t b = 0; b < BLOCKS; b += 4) {
		change_block(v2, b, (uint8_t)b);
	}
	change_block(v2, 13, 1);
	change_block(v2, 14, 1);

	world_create(&w);
	install(&w, v1, size, "v1");
	start = malloc((size_t)(disk_sectors * PI_SECTOR_SIZE));
	memcpy(start, w.disk.data, (size_t)(disk_sectors * PI_SECTOR_SIZE));

	/* How many writes the update takes with no cut. */
	serve(&w, v2, size, "v2");
	w.disk.writes = 0;
	CHECK(run(&w, NULL) == PI_OK);
	writes_needed = w.disk.writes;
	CHECK(writes_needed > 100);

	/* The power goes at every one of them in turn, the write cut in half. After it, it goes on. */
	for (uint64_t cut = 0; cut < writes_needed; cut++) {
		uint64_t sent_before;
		uint32_t blocks_before;
		enum pi_err first;
		enum pi_err second;
		struct pi_card_state st;

		memcpy(w.disk.data, start, (size_t)(disk_sectors * PI_SECTOR_SIZE));
		serve(&w, v2, size, "v2");
		w.disk.writes_left = (long)cut;
		first = run(&w, NULL);
		cuts++;
		CHECK(first == PI_ERR_SD_IO);
		blocks_before = w.delta.stats.blocks_fetched;

		/* While it is cut, the card never says ready with anything but v1 in the mirror. */
		fake_disk_power_on(&w.disk);
		st = state_on_card(&w);
		if (st.state == PI_STATE_READY && st.generation == 1) {
			CHECK(mirror_is(&w, v1, size));
		}

		sent_before = w.server.sent;
		second = run(&w, NULL);
		CHECK(second == PI_OK);
		if (second == PI_OK && mirror_is(&w, v2, size)) {
			good++;
		}
		/* Blocks done before the cut are not downloaded again: at most the one in flight. */
		if (w.delta.stats.blocks_fetched + blocks_before > 12 + 1) {
			refetched_too_much++;
		}
		(void)sent_before;
		st = state_on_card(&w);
		CHECK(st.state == PI_STATE_READY && st.generation == 2 && st.changed_count == 12);
	}
	CHECK(good == cuts);
	CHECK(refetched_too_much == 0);
	printf("power cut at each of %d writes: all %d resumed to the new image\n", cuts, good);

	free(start);
	world_free(&w);
	free(v1);
	free(v2);
}

static void test_interruptions(void)
{
	uint64_t size;
	uint8_t *v1 = make_image(6, BLOCKS, &size);
	uint8_t *v2 = malloc((size_t)size);
	uint8_t *v3 = malloc((size_t)size);
	struct world w;
	struct pi_card_state st;
	bool which[BLOCKS];

	memcpy(v2, v1, (size_t)size);
	for (uint32_t b = 10; b < 30; b++) {
		change_block(v2, b, 7);
	}
	world_create(&w);
	install(&w, v1, size, "v1");

	/* The connection drops in the middle of a block, three times: each call goes on. */
	serve(&w, v2, size, "v2");
	w.server.drop_after = 512 + BLOCKS * 32 + 5 * BS + 1234;
	CHECK(run(&w, NULL) == PI_ERR_DOWNLOAD);
	st = state_on_card(&w);
	CHECK(st.state == PI_STATE_UPDATING && st.next == 5);
	w.server.drop_after = (long long)w.server.sent + 3 * BS + 7;
	CHECK(run(&w, NULL) == PI_ERR_DOWNLOAD);
	w.server.drop_after = (long long)w.server.sent + 100;
	CHECK(run(&w, NULL) == PI_ERR_DOWNLOAD);
	w.server.requests = 0;
	CHECK(run(&w, NULL) == PI_OK);
	CHECK(mirror_is(&w, v2, size));
	/* The last call fetched only what was left: block 17 on (two more were done in between). */
	CHECK(blocks_requested(&w, which, BLOCKS) == 13);
	CHECK(which[17] && !which[16]);

	/* The connection drops in the table. */
	memcpy(v3, v2, (size_t)size);
	change_block(v3, 1, 1);
	serve(&w, v3, size, "v3");
	w.server.drop_after = 512 + 700;
	CHECK(run(&w, NULL) == PI_ERR_DOWNLOAD);
	st = state_on_card(&w);
	CHECK(st.state == PI_STATE_READY && st.phase == PI_PHASE_TABLE && st.next == 512);
	CHECK(mirror_is(&w, v2, size));
	CHECK(run(&w, NULL) == PI_OK);
	CHECK(mirror_is(&w, v3, size));

	/* The card is pulled out half way through the blocks, then put back. */
	memcpy(v2, v3, (size_t)size);
	for (uint32_t b = 0; b < BLOCKS; b += 2) {
		change_block(v2, b, 3);
	}
	serve(&w, v2, size, "v5");
	w.disk.pull_after = 150;
	CHECK(run(&w, NULL) == PI_ERR_SD_ABSENT);
	CHECK(run(&w, NULL) == PI_ERR_SD_ABSENT);
	w.disk.absent = false;
	st = state_on_card(&w);
	CHECK(st.state == PI_STATE_UPDATING && st.next > 0);
	CHECK(run(&w, NULL) == PI_OK);
	CHECK(mirror_is(&w, v2, size));

	/* The job is withdrawn half way: it stops, and the same job later goes on. */
	memcpy(v3, v2, (size_t)size);
	for (uint32_t b = 1; b < BLOCKS; b += 2) {
		change_block(v3, b, 5);
	}
	serve(&w, v3, size, "v6");
	w.server.stop_after = 512 + BLOCKS * 32 + 3 * BS + 10;
	CHECK(run(&w, NULL) == PI_ERR_ABORTED);
	st = state_on_card(&w);
	CHECK(st.state == PI_STATE_UPDATING && st.next == 3);
	w.stop = false;
	CHECK(run(&w, NULL) == PI_OK);
	CHECK(mirror_is(&w, v3, size));

	world_free(&w);
	free(v1);
	free(v2);
	free(v3);
}

/* An update cut off and replaced by one for another image: every block is checked. */
static void test_other_image_half_way(void)
{
	uint64_t size;
	uint8_t *v1 = make_image(7, BLOCKS, &size);
	uint8_t *t1 = malloc((size_t)size);
	uint8_t *t2 = malloc((size_t)size);
	struct world w;
	struct pi_card_state st;
	bool which[BLOCKS];

	memcpy(t1, v1, (size_t)size);
	memcpy(t2, v1, (size_t)size);
	for (uint32_t b = 0; b < 20; b++) {
		change_block(t1, b, 1);
	}
	change_block(t2, 30, 2);
	world_create(&w);
	install(&w, v1, size, "v1");

	serve(&w, t1, size, "t1");
	w.server.drop_after = 512 + BLOCKS * 32 + 8 * BS;
	CHECK(run(&w, NULL) == PI_ERR_DOWNLOAD);
	st = state_on_card(&w);
	CHECK(st.state == PI_STATE_UPDATING && st.next == 8);

	/* t2's job: the power goes at its second write, between the slot header and the state. */
	serve(&w, t2, size, "t2");
	w.disk.writes_left = 1;
	CHECK(run(&w, NULL) == PI_ERR_SD_IO);
	fake_disk_power_on(&w.disk);

	/* t2 differs from v1 in block 30 only, but blocks 0 to 7 are t1's now. */
	serve(&w, t2, size, "t2");
	CHECK(run(&w, NULL) == PI_OK);
	CHECK(mirror_is(&w, t2, size));
	CHECK(blocks_requested(&w, which, BLOCKS) == 9);
	CHECK(which[30] && which[0] && which[7] && !which[8]);
	st = state_on_card(&w);
	/* For the Pi, the list is still v1 to t2: the Pi never took t1. */
	CHECK(st.changed_count == 1 && strcmp(st.base_version, "v1") == 0);
	CHECK(!(st.flags & PI_FLAG_DIRTY));
	world_free(&w);
	free(v1);
	free(t1);
	free(t2);
}

/* ------------------------------------------------------------------------------------------- */
/* The link                                                                                     */

static uint16_t request_seq;

static size_t request(uint8_t *rx, uint8_t type, const uint8_t *payload, uint16_t length)
{
	struct pi_frame frame = {
		.type = type,
		.session = 0x1234,
		.seq = ++request_seq,
		.length = length,
		.payload = payload,
	};

	memset(rx, 0, PI_FRAME_SIZE);
	return pi_frame_encode(rx, PI_FRAME_SIZE, &frame) > 0 ? PI_FRAME_SIZE : 0;
}

/* The message link's receiver, which every frame goes through first, as in pi_link.c. */
static struct pi_rx link_rx;

/*
 * One transfer, as pi_link.c takes it: the frame goes to pi_rx_handle(), then pi_dlink_answer()
 * writes what the board sends in the next transfer, and the SPI peripheral's overrun character
 * (0xff) follows it. Returns the answer's length.
 */
static size_t transfer(struct pi_dlink *link, struct pi_rx *rx, const uint8_t *in, size_t received,
		       uint8_t *tx, enum pi_rx_result *result)
{
	struct pi_frame frame;
	enum pi_rx_result r = pi_rx_handle(rx, in, received, &frame);

	memset(tx, 0xff, PI_FRAME_SIZE);
	if (result != NULL) {
		*result = r;
	}
	return pi_dlink_answer(link, rx, r, &frame, tx, PI_FRAME_SIZE);
}

/* The frame is the message link's STATUS, naming that session and seq (0 and 0: none yet). */
static bool is_status(const uint8_t *tx, uint16_t session, uint16_t ack)
{
	struct pi_frame f;

	return pi_frame_decode(tx, PI_FRAME_SIZE, &f) == PI_FRAME_OK && f.type == PI_FRAME_STATUS &&
	       f.session == session && f.ack == ack && f.seq == 0 && f.length == 0;
}

/*
 * Ask, and read the answer as the Pi would in the next transfer: its seq is the request's, and its
 * session and ack are the message link's, as in STATUS.
 */
static bool ask(struct pi_dlink *link, uint8_t type, const uint8_t *payload, uint16_t length,
		struct pi_frame *answer, uint8_t *tx)
{
	uint8_t rx[PI_FRAME_SIZE];
	enum pi_rx_result result;
	size_t n;

	request(rx, type, payload, length);
	n = transfer(link, &link_rx, rx, sizeof(rx), tx, &result);
	return result == PI_RX_DELTA && pi_frame_decode(tx, PI_FRAME_SIZE, answer) == PI_FRAME_OK &&
	       n == PI_FRAME_HEADER + (size_t)answer->length + PI_FRAME_CRC &&
	       answer->seq == request_seq &&
	       answer->session == (link_rx.accepted_any ? link_rx.session : 0) &&
	       answer->ack == (link_rx.accepted_any ? link_rx.seq : 0);
}

static uint8_t error_code(const struct pi_frame *answer)
{
	return answer->type == PI_DLINK_ERROR ? answer->payload[0] : 0;
}

static void read_args(uint8_t *p, uint32_t block, uint32_t offset, uint16_t length)
{
	memset(p, 0, 12);
	pi_put32(p, block);
	pi_put32(p + 4, offset);
	pi_put16(p + 8, length);
}

static void range_args(uint8_t *p, uint32_t first, uint16_t count)
{
	memset(p, 0, 8);
	pi_put32(p, first);
	pi_put16(p + 4, count);
}

/* The Pi's side, in C: take only the listed blocks over the link, onto a copy of its old image. */
static bool pi_takes_changes(struct pi_dlink *link, uint8_t *pi_image, uint64_t size,
			     uint8_t digest[PI_HASH_SIZE], uint32_t *blocks_taken)
{
	uint8_t tx[PI_FRAME_SIZE];
	uint8_t args[12];
	struct pi_frame a;
	uint32_t total;
	uint32_t generation;
	struct pi_sha256 sha;

	*blocks_taken = 0;
	if (!ask(link, PI_DLINK_INFO, NULL, 0, &a, tx) || a.type != (PI_DLINK_INFO | 0x80)) {
		return false;
	}
	generation = pi_get32(a.payload + 4);
	total = pi_get32(a.payload + 120);
	for (uint32_t first = 0; first < total;) {
		uint32_t count;

		range_args(args, first, PI_DLINK_CHANGED_MAX);
		if (!ask(link, PI_DLINK_CHANGED, args, 8, &a, tx) || a.type != (PI_DLINK_CHANGED | 0x80) ||
		    pi_get32(a.payload) != generation) {
			return false;
		}
		count = pi_get16(a.payload + 12);
		uint32_t blocks[PI_DLINK_CHANGED_MAX];

		for (uint32_t i = 0; i < count; i++) {
			blocks[i] = pi_get32(a.payload + 16 + 4 * i);
		}
		for (uint32_t i = 0; i < count; i++) {
			uint32_t block = blocks[i];

			for (uint32_t off = 0; off < BS; off += PI_DLINK_READ_MAX) {
				uint16_t len = (uint16_t)(BS - off < PI_DLINK_READ_MAX ? BS - off
										 : PI_DLINK_READ_MAX);
				struct pi_frame r;

				if ((uint64_t)block * BS + off >= size) {
					break;
				}
				read_args(args, block, off, len);
				if (!ask(link, PI_DLINK_READ, args, 12, &r, tx) ||
				    r.type != (PI_DLINK_READ | 0x80) || pi_get32(r.payload) != generation) {
					return false;
				}
				memcpy(pi_image + (uint64_t)block * BS + off, r.payload + 16, len);
			}
			(*blocks_taken)++;
		}
		first += count;
	}
	pi_sha256_init(&sha);
	pi_sha256_update(&sha, pi_image, (size_t)size);
	pi_sha256_final(&sha, digest);
	return true;
}

static void test_link(void)
{
	uint64_t size;
	uint8_t *v1 = make_image(8, BLOCKS, &size);
	uint8_t *v2 = malloc((size_t)size);
	uint8_t *pi = malloc((size_t)size);
	struct world w;
	struct pi_card card;
	struct pi_dlink link;
	struct pi_frame a;
	uint64_t reads;
	uint8_t tx[PI_FRAME_SIZE];
	uint8_t rx[PI_FRAME_SIZE];
	uint8_t args[16];
	uint8_t digest[PI_HASH_SIZE];
	uint32_t taken;

	world_create(&w);

	/* No card open yet: INFO says so, the rest is refused. */
	pi_card_init(&card, &fake_disk_ops, &w.disk);
	pi_dlink_init(&link, &card);
	pi_rx_init(&link_rx);
	CHECK(ask(&link, PI_DLINK_INFO, NULL, 0, &a, tx));
	CHECK(a.type == 0x90 && a.length == PI_DLINK_INFO_SIZE && a.payload[3] == PI_DLINK_INFO_NO_CARD);
	read_args(args, 0, 0, 16);
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && error_code(&a) == PI_DLINK_CARD);

	/* An empty card. */
	CHECK(pi_card_open(&card, MAX_BLOCKS) == PI_OK);
	CHECK(ask(&link, PI_DLINK_INFO, NULL, 0, &a, tx) && a.payload[2] == PI_STATE_EMPTY);
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && error_code(&a) == PI_DLINK_NO_IMAGE);
	CHECK(a.payload[1] == PI_STATE_EMPTY && a.payload[8] == PI_DLINK_READ);

	/* v1 on the card: INFO describes it. */
	install(&w, v1, size, "v1");
	CHECK(pi_card_open(&card, MAX_BLOCKS) == PI_OK);
	CHECK(ask(&link, PI_DLINK_INFO, NULL, 0, &a, tx));
	CHECK(pi_get16(a.payload) == PI_DLINK_VERSION && a.payload[2] == PI_STATE_READY);
	CHECK(a.payload[3] == PI_DLINK_INFO_LIST && pi_get32(a.payload + 4) == 1);
	CHECK(pi_get32(a.payload + 8) == BS && pi_get32(a.payload + 12) == BLOCKS);
	CHECK(pi_get64(a.payload + 16) == size);
	CHECK(memcmp(a.payload + 24, w.m.image_sha256, 32) == 0);
	CHECK(memcmp(a.payload + 56, w.m.table_sha256, 32) == 0);
	CHECK(strcmp((const char *)a.payload + 88, "v1") == 0);
	CHECK(pi_get32(a.payload + 120) == BLOCKS && a.payload[124] == '\0');

	/* MANIFEST: hashes as in the package's table, clamped at the end, refused past it. */
	range_args(args, 2, 15);
	CHECK(ask(&link, PI_DLINK_MANIFEST, args, 8, &a, tx) && a.type == 0x91);
	CHECK(pi_get32(a.payload + 4) == 2 && pi_get16(a.payload + 8) == 15);
	CHECK(a.length == 16 + 15 * 32);
	CHECK(memcmp(a.payload + 16, w.package + 512 + 2 * 32, 15 * 32) == 0);
	range_args(args, BLOCKS - 3, 15);
	CHECK(ask(&link, PI_DLINK_MANIFEST, args, 8, &a, tx) && pi_get16(a.payload + 8) == 3);
	CHECK(memcmp(a.payload + 16, w.package + 512 + (BLOCKS - 3) * 32, 3 * 32) == 0);
	range_args(args, BLOCKS, 1);
	CHECK(ask(&link, PI_DLINK_MANIFEST, args, 8, &a, tx) && error_code(&a) == PI_DLINK_OUT_OF_RANGE);
	range_args(args, 0, 0);
	CHECK(ask(&link, PI_DLINK_MANIFEST, args, 8, &a, tx) && error_code(&a) == PI_DLINK_BAD_REQUEST);
	range_args(args, 0, 16);
	CHECK(ask(&link, PI_DLINK_MANIFEST, args, 8, &a, tx) && error_code(&a) == PI_DLINK_BAD_REQUEST);
	range_args(args, 0, 1);
	args[6] = 1;
	CHECK(ask(&link, PI_DLINK_MANIFEST, args, 8, &a, tx) && error_code(&a) == PI_DLINK_BAD_REQUEST);
	CHECK(ask(&link, PI_DLINK_MANIFEST, args, 6, &a, tx) && error_code(&a) == PI_DLINK_BAD_REQUEST);

	/* READ: within a block, across a sector, at its end; and every way to ask wrongly. */
	read_args(args, 7, 300, 480);
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && a.type == 0x93 && a.length == 16 + 480);
	CHECK(pi_get32(a.payload + 4) == 7 && pi_get32(a.payload + 8) == 300 &&
	      pi_get16(a.payload + 12) == 480);
	CHECK(memcmp(a.payload + 16, v1 + 7 * BS + 300, 480) == 0);
	read_args(args, BLOCKS - 1, BS - 1, 1);
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && a.payload[16] == v1[size - 1]);
	read_args(args, BLOCKS - 1, BS - 1, 2);
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && error_code(&a) == PI_DLINK_OUT_OF_RANGE);
	read_args(args, BLOCKS, 0, 1);
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && error_code(&a) == PI_DLINK_OUT_OF_RANGE);
	read_args(args, 0, 0, 0);
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && error_code(&a) == PI_DLINK_BAD_REQUEST);
	read_args(args, 0, 0, 481);
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && error_code(&a) == PI_DLINK_BAD_REQUEST);
	read_args(args, 0, 0, 4);
	args[11] = 9;
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && error_code(&a) == PI_DLINK_BAD_REQUEST);
	CHECK(ask(&link, PI_DLINK_READ, args, 13, &a, tx) && error_code(&a) == PI_DLINK_BAD_REQUEST);
	CHECK(ask(&link, PI_DLINK_INFO, args, 1, &a, tx) && error_code(&a) == PI_DLINK_BAD_REQUEST);

	/*
	 * Frames that are not delta requests go to the message link: DATA, a damaged frame, a type
	 * nobody takes. Each is answered with STATUS, as the message link answers it, and never
	 * reaches pi_dlink; the Pi sends its request again. test_shared_link() has more.
	 */
	{
		uint32_t answered = link.answered;
		uint32_t errors = link.errors;
		enum pi_rx_result result;

		request(rx, 0x01, (const uint8_t *)"{}", 2);
		CHECK(transfer(&link, &link_rx, rx, sizeof(rx), tx, &result) == 16 &&
		      result == PI_RX_DELIVER && is_status(tx, 0x1234, request_seq));
		request(rx, 0x7e, NULL, 0);
		transfer(&link, &link_rx, rx, sizeof(rx), tx, &result);
		CHECK(result == PI_RX_BAD && link_rx.unknown == 1 && is_status(tx, 0x1234, request_seq - 1));
		request(rx, PI_DLINK_INFO, NULL, 0);
		rx[13] ^= 1; /* the CRC */
		transfer(&link, &link_rx, rx, sizeof(rx), tx, &result);
		CHECK(result == PI_RX_BAD && link_rx.bad_crc == 1 && is_status(tx, 0x1234, request_seq - 2));
		request(rx, PI_DLINK_INFO, NULL, 0);
		rx[0] = 'X';
		transfer(&link, &link_rx, rx, sizeof(rx), tx, &result);
		CHECK(result == PI_RX_BAD && is_status(tx, 0x1234, request_seq - 3));
		request(rx, PI_DLINK_INFO, NULL, 0);
		transfer(&link, &link_rx, rx, 10, tx, &result);
		CHECK(result == PI_RX_BAD && is_status(tx, 0x1234, request_seq - 4));
		request(rx, PI_DLINK_INFO, NULL, 0);
		pi_put16(rx + 10, 600); /* a length past the frame */
		transfer(&link, &link_rx, rx, sizeof(rx), tx, &result);
		CHECK(result == PI_RX_BAD && is_status(tx, 0x1234, request_seq - 5));
		CHECK(link.answered == answered && link.errors == errors);

		/* A POLL, or a transfer with nothing in it, is answered with STATUS: not the last answer again. */
		CHECK(ask(&link, PI_DLINK_INFO, NULL, 0, &a, tx));
		request(rx, PI_FRAME_POLL, NULL, 0);
		transfer(&link, &link_rx, rx, sizeof(rx), tx, &result);
		CHECK(result == PI_RX_POLL && is_status(tx, 0x1234, request_seq - 7));
		CHECK(ask(&link, PI_DLINK_INFO, NULL, 0, &a, tx));
		memset(rx, 0xff, sizeof(rx));
		transfer(&link, &link_rx, rx, sizeof(rx), tx, &result);
		CHECK(result == PI_RX_NOTHING && is_status(tx, 0x1234, request_seq - 8));
		memset(rx, 0, sizeof(rx));
		transfer(&link, &link_rx, rx, sizeof(rx), tx, &result);
		CHECK(result == PI_RX_NOTHING && is_status(tx, 0x1234, request_seq - 8));
		CHECK(link_rx.polls == 1 && link_rx.delivered == 1);
	}

	/* v2: the Pi, on v1, takes only the listed blocks, and ends with v2's digest. */
	memcpy(v2, v1, (size_t)size);
	change_block(v2, 2, 1);
	change_block(v2, 3, 1);
	change_block(v2, 33, 1);
	serve(&w, v2, size, "v2");

	/* While the table downloads, the mirror is still v1's and may be read; CHANGED may not. */
	w.server.drop_after = 512 + 100;
	CHECK(run(&w, NULL) == PI_ERR_DOWNLOAD);
	CHECK(pi_card_open(&card, MAX_BLOCKS) == PI_OK);
	CHECK(ask(&link, PI_DLINK_INFO, NULL, 0, &a, tx));
	CHECK(a.payload[2] == PI_STATE_READY && a.payload[3] == PI_DLINK_INFO_PREPARING);
	read_args(args, 7, 0, 64);
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && memcmp(a.payload + 16, v1 + 7 * BS, 64) == 0);
	range_args(args, 0, 10);
	CHECK(ask(&link, PI_DLINK_CHANGED, args, 8, &a, tx) && error_code(&a) == PI_DLINK_NO_LIST);

	/* Half way through the blocks: nothing may be read. */
	w.server.drop_after = (long long)w.server.sent + BLOCKS * 32 + 2 * BS;
	CHECK(run(&w, NULL) == PI_ERR_DOWNLOAD);
	CHECK(pi_card_open(&card, MAX_BLOCKS) == PI_OK);
	CHECK(ask(&link, PI_DLINK_INFO, NULL, 0, &a, tx));
	CHECK(a.payload[2] == PI_STATE_UPDATING && strcmp((const char *)a.payload + 88, "v2") == 0);
	CHECK(pi_get32(a.payload + 188) == 1 && pi_get32(a.payload + 192) == 3);
	CHECK(strcmp((const char *)a.payload + 124, "v1") == 0);
	read_args(args, 7, 0, 64);
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && error_code(&a) == PI_DLINK_UPDATING);
	CHECK(a.payload[1] == PI_STATE_UPDATING);
	range_args(args, 0, 1);
	CHECK(ask(&link, PI_DLINK_MANIFEST, args, 8, &a, tx) && error_code(&a) == PI_DLINK_UPDATING);
	CHECK(ask(&link, PI_DLINK_CHANGED, args, 8, &a, tx) && error_code(&a) == PI_DLINK_UPDATING);

	CHECK(run(&w, NULL) == PI_OK);
	CHECK(pi_card_open(&card, MAX_BLOCKS) == PI_OK);
	memcpy(pi, v1, (size_t)size);
	CHECK(pi_takes_changes(&link, pi, size, digest, &taken));
	CHECK(taken == 3);
	CHECK(memcmp(digest, w.m.image_sha256, PI_HASH_SIZE) == 0);
	CHECK(memcmp(pi, v2, (size_t)size) == 0);
	range_args(args, 0, 120);
	CHECK(ask(&link, PI_DLINK_CHANGED, args, 8, &a, tx) && pi_get32(a.payload + 4) == 3);
	CHECK(pi_get16(a.payload + 12) == 3 && pi_get32(a.payload + 16) == 2 &&
	      pi_get32(a.payload + 20) == 3 && pi_get32(a.payload + 24) == 33);
	range_args(args, 3, 1);
	CHECK(ask(&link, PI_DLINK_CHANGED, args, 8, &a, tx) && error_code(&a) == PI_DLINK_OUT_OF_RANGE);
	range_args(args, 0, 121);
	CHECK(ask(&link, PI_DLINK_CHANGED, args, 8, &a, tx) && error_code(&a) == PI_DLINK_BAD_REQUEST);

	/* A cached sector of the old image is not served after an update. */
	CHECK(ask(&link, PI_DLINK_INFO, NULL, 0, &a, tx) && pi_get32(a.payload + 4) == 2);
	read_args(args, 33, 100, 50);
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && memcmp(a.payload + 16, v2 + 33 * BS + 100, 50) == 0);

	/* The card fails under a read. */
	w.disk.fail_reads = true;
	read_args(args, 20, 0, 50);
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && error_code(&a) == PI_DLINK_CARD);
	w.disk.fail_reads = false;
	CHECK(link.answered > 20 && link.errors > 15);

	/*
	 * A card taken out and one put in may say the same generation (two cards seeded alike): the
	 * sector cached from the card before is not served, the new card is read.
	 */
	read_args(args, 33, 100, 50);
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && a.type == (PI_DLINK_READ | 0x80));
	reads = w.disk.reads;
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && w.disk.reads == reads);
	pi_card_close(&card);
	CHECK(pi_card_open(&card, MAX_BLOCKS) == PI_OK);
	reads = w.disk.reads;
	CHECK(ask(&link, PI_DLINK_READ, args, 12, &a, tx) && w.disk.reads > reads);
	CHECK(memcmp(a.payload + 16, v2 + 33 * BS + 100, 50) == 0);

	world_free(&w);
	free(v1);
	free(v2);
	free(pi);
}

/* A frame from the Pi: any type, session and seq. */
static void frame_to(uint8_t *in, uint8_t type, uint16_t session, uint16_t seq, const void *payload,
		     uint16_t length)
{
	struct pi_frame f = {
		.type = type,
		.session = session,
		.seq = seq,
		.length = length,
		.payload = payload,
	};

	memset(in, 0, PI_FRAME_SIZE);
	CHECK(pi_frame_encode(in, PI_FRAME_SIZE, &f) > 0);
}

/*
 * The message link and the delta requests on one link, a mixed sequence as pi_link.c takes it. One
 * rule: each frame is answered in the next transfer, a delta request with its answer and anything
 * else with STATUS. DATA and POLL work as on the message link alone (docs/pi-link.md); a delta
 * answer carries the message link's session and ack, so a sender of messages is told nothing new.
 */
static void test_shared_link(void)
{
	uint64_t size;
	uint8_t *v1 = make_image(21, BLOCKS, &size);
	struct world w;
	struct pi_card card;
	struct pi_dlink link;
	struct pi_dlink no_card;
	struct pi_rx rx;
	struct pi_frame a;
	struct pi_frame f;
	enum pi_rx_result r;
	uint8_t in[PI_FRAME_SIZE];
	uint8_t tx[PI_FRAME_SIZE];
	uint8_t small[PI_FRAME_HEADER + PI_FRAME_CRC];
	uint8_t args[16];
	static const char hb[] = "{\"t\":\"hb\",\"mx\":1}";
	size_t n;

	world_create(&w);
	install(&w, v1, size, "v1");
	pi_card_init(&card, &fake_disk_ops, &w.disk);
	CHECK(pi_card_open(&card, MAX_BLOCKS) == PI_OK);
	pi_dlink_init(&link, &card);
	pi_rx_init(&rx);

	/* Before any DATA: a delta answer names no session, as STATUS does. */
	frame_to(in, PI_DLINK_INFO, 0x5a5a, 40, NULL, 0);
	n = transfer(&link, &rx, in, sizeof(in), tx, &r);
	CHECK(r == PI_RX_DELTA && n == PI_FRAME_HEADER + PI_DLINK_INFO_SIZE + PI_FRAME_CRC);
	CHECK(pi_frame_decode(tx, sizeof(tx), &a) == PI_FRAME_OK && a.type == 0x90 && a.seq == 40 &&
	      a.session == 0 && a.ack == 0 && a.payload[2] == PI_STATE_READY);

	/* DATA: delivered, and the next transfer's STATUS acknowledges it, 16 bytes and then 0xff. */
	frame_to(in, PI_FRAME_DATA, 0x4242, 7, hb, sizeof(hb) - 1);
	n = transfer(&link, &rx, in, sizeof(in), tx, &r);
	CHECK(r == PI_RX_DELIVER && n == PI_FRAME_HEADER + PI_FRAME_CRC && is_status(tx, 0x4242, 7));
	CHECK(tx[16] == 0xff && tx[PI_FRAME_SIZE - 1] == 0xff);

	/* A delta request: its answer, with the message link's session and ack and the request's seq. */
	read_args(args, 3, 100, 200);
	frame_to(in, PI_DLINK_READ, 0x5a5a, 41, args, 12);
	n = transfer(&link, &rx, in, sizeof(in), tx, &r);
	CHECK(r == PI_RX_DELTA && n == PI_FRAME_HEADER + PI_DLINK_ANSWER_HEAD + 200 + PI_FRAME_CRC);
	CHECK(pi_frame_decode(tx, sizeof(tx), &a) == PI_FRAME_OK && a.type == 0x93 && a.seq == 41 &&
	      a.session == 0x4242 && a.ack == 7);
	CHECK(memcmp(a.payload + PI_DLINK_ANSWER_HEAD, v1 + 3 * BS + 100, 200) == 0);
	CHECK(tx[n] == 0xff);

	/* POLL: STATUS, not the delta answer again. */
	frame_to(in, PI_FRAME_POLL, 0x5a5a, 0, NULL, 0);
	CHECK(transfer(&link, &rx, in, sizeof(in), tx, &r) == 16 && r == PI_RX_POLL &&
	      is_status(tx, 0x4242, 7));

	/* The same DATA again, after a delta request: acknowledged, and not delivered twice. */
	frame_to(in, PI_DLINK_INFO, 0x5a5a, 42, NULL, 0);
	CHECK(transfer(&link, &rx, in, sizeof(in), tx, &r) > 16 && r == PI_RX_DELTA);
	frame_to(in, PI_FRAME_DATA, 0x4242, 7, hb, sizeof(hb) - 1);
	CHECK(transfer(&link, &rx, in, sizeof(in), tx, &r) == 16 && r == PI_RX_DUPLICATE &&
	      is_status(tx, 0x4242, 7));

	/* Types nobody takes, next to the delta requests or an answer's own: unknown, and STATUS. */
	frame_to(in, 0x14, 0x5a5a, 43, NULL, 0);
	CHECK(transfer(&link, &rx, in, sizeof(in), tx, &r) == 16 && r == PI_RX_BAD &&
	      is_status(tx, 0x4242, 7));
	frame_to(in, 0x0f, 0x5a5a, 44, NULL, 0);
	CHECK(transfer(&link, &rx, in, sizeof(in), tx, &r) == 16 && r == PI_RX_BAD);
	frame_to(in, 0x93, 0x5a5a, 45, NULL, 0);
	CHECK(transfer(&link, &rx, in, sizeof(in), tx, &r) == 16 && r == PI_RX_BAD);
	CHECK(rx.unknown == 3 && rx.bad == 3);

	/* A delta request with a bad CRC: bad, and STATUS; it never reaches the card. */
	frame_to(in, PI_DLINK_READ, 0x5a5a, 46, args, 12);
	in[PI_FRAME_HEADER + 12] ^= 0x01;
	CHECK(transfer(&link, &rx, in, sizeof(in), tx, &r) == 16 && r == PI_RX_BAD &&
	      is_status(tx, 0x4242, 7));
	CHECK(rx.bad_crc == 1 && rx.bad == 4);

	/* Nothing clocked in: STATUS. */
	memset(in, 0xff, sizeof(in));
	CHECK(transfer(&link, &rx, in, sizeof(in), tx, &r) == 16 && r == PI_RX_NOTHING &&
	      is_status(tx, 0x4242, 7));

	/* A refused request (past the end): ERROR, with the message link's session and ack too. */
	read_args(args, BLOCKS, 0, 16);
	frame_to(in, PI_DLINK_READ, 0x5a5a, 47, args, 12);
	CHECK(transfer(&link, &rx, in, sizeof(in), tx, &r) == PI_FRAME_HEADER + 12 + PI_FRAME_CRC);
	CHECK(pi_frame_decode(tx, sizeof(tx), &a) == PI_FRAME_OK && a.type == PI_DLINK_ERROR &&
	      a.seq == 47 && a.session == 0x4242 && a.ack == 7 &&
	      error_code(&a) == PI_DLINK_OUT_OF_RANGE && a.payload[8] == PI_DLINK_READ);

	/* A new message: the next delta answer carries its ack. */
	frame_to(in, PI_FRAME_DATA, 0x4242, 8, "{}", 2);
	CHECK(transfer(&link, &rx, in, sizeof(in), tx, &r) == 16 && r == PI_RX_DELIVER &&
	      is_status(tx, 0x4242, 8));
	frame_to(in, PI_DLINK_INFO, 0x5a5a, 48, NULL, 0);
	CHECK(transfer(&link, &rx, in, sizeof(in), tx, &r) > 16 && r == PI_RX_DELTA);
	CHECK(pi_frame_decode(tx, sizeof(tx), &a) == PI_FRAME_OK && a.type == 0x90 && a.ack == 8);

	CHECK(rx.delivered == 2 && rx.duplicates == 1 && rx.polls == 1 && rx.delta == 5);
	CHECK(link.answered == 4 && link.errors == 1);

	/* Before pi_link.c is given the card: INFO says there is none, the rest is refused. */
	pi_dlink_init(&no_card, NULL);
	frame_to(in, PI_DLINK_INFO, 0x5a5a, 49, NULL, 0);
	CHECK(transfer(&no_card, &rx, in, sizeof(in), tx, &r) > 16 && r == PI_RX_DELTA);
	CHECK(pi_frame_decode(tx, sizeof(tx), &a) == PI_FRAME_OK && a.type == 0x90 &&
	      a.payload[3] == PI_DLINK_INFO_NO_CARD);
	read_args(args, 0, 0, 16);
	frame_to(in, PI_DLINK_READ, 0x5a5a, 50, args, 12);
	transfer(&no_card, &rx, in, sizeof(in), tx, &r);
	CHECK(pi_frame_decode(tx, sizeof(tx), &a) == PI_FRAME_OK && error_code(&a) == PI_DLINK_CARD &&
	      a.payload[1] == PI_STATE_EMPTY);
	range_args(args, 0, 1);
	frame_to(in, PI_DLINK_MANIFEST, 0x5a5a, 51, args, 8);
	transfer(&no_card, &rx, in, sizeof(in), tx, &r);
	CHECK(pi_frame_decode(tx, sizeof(tx), &a) == PI_FRAME_OK && error_code(&a) == PI_DLINK_CARD);

	/* A transmit buffer too small for a delta answer (the message link's 16 bytes) gets STATUS. */
	frame_to(in, PI_DLINK_INFO, 0x5a5a, 52, NULL, 0);
	CHECK(pi_rx_handle(&rx, in, sizeof(in), &f) == PI_RX_DELTA);
	CHECK(pi_dlink_answer(&link, &rx, PI_RX_DELTA, &f, small, sizeof(small)) == sizeof(small));
	CHECK(pi_frame_decode(small, sizeof(small), &a) == PI_FRAME_OK && a.type == PI_FRAME_STATUS);

	world_free(&w);
	free(v1);
}

/* ------------------------------------------------------------------------------------------- */

static const char *const prefix = "https://bucket.example/firmware/";

static enum ota_job_result parse_doc(const char *doc, struct ota_job *job)
{
	char json[1024];

	snprintf(json, sizeof(json),
		 "{\"execution\":{\"jobId\":\"pi-delta-1\",\"status\":\"QUEUED\",\"jobDocument\":%s}}",
		 doc);
	return ota_job_parse(json, strlen(json), prefix, job);
}

static void test_job_document(void)
{
	static struct ota_job job;
	const char *sha = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
	char doc[512];

	snprintf(doc, sizeof(doc),
		 "{\"op\":\"pi_delta\",\"v\":1,\"pi\":{\"version\":\"2026.11.24-1\",\"sha256\":\"%s\","
		 "\"url\":\"https://bucket.example/firmware/pi-2026.11.24-1.cpd?X-Amz=1\"}}",
		 sha);
	CHECK(parse_doc(doc, &job) == OTA_JOB_OK);
	CHECK(job.pi_delta && !job.golden);
	CHECK(strcmp(job.pi_version, "2026.11.24-1") == 0);
	CHECK(job.sha256[0] == 0x00 && job.sha256[1] == 0x11 && job.sha256[31] == 0xff);
	CHECK(strcmp(job.host, "https://bucket.example") == 0);
	CHECK(strcmp(job.file, "firmware/pi-2026.11.24-1.cpd?X-Amz=1") == 0);
	CHECK(strcmp(job.id, "pi-delta-1") == 0 && !job.in_progress);

	/* As a string, as other interfaces give it. */
	{
		char json[1024];
		char escaped[600];
		size_t j = 0;

		for (size_t i = 0; doc[i] != '\0' && j < sizeof(escaped) - 2; i++) {
			if (doc[i] == '"') {
				escaped[j++] = '\\';
			}
			escaped[j++] = doc[i];
		}
		escaped[j] = '\0';
		snprintf(json, sizeof(json),
			 "{\"execution\":{\"jobId\":\"pi-delta-2\",\"status\":\"IN_PROGRESS\","
			 "\"jobDocument\":\"%s\"}}",
			 escaped);
		CHECK(ota_job_parse(json, strlen(json), prefix, &job) == OTA_JOB_OK);
		CHECK(job.pi_delta && job.in_progress);
	}

	const char *bad[] = {
		"{\"op\":\"pi_delta\",\"v\":1}",
		"{\"op\":\"pi_delta\",\"v\":1,\"pi\":{\"version\":\"a b\",\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/x\"}}",
		"{\"op\":\"pi_delta\",\"v\":1,\"pi\":{\"version\":\"\",\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/x\"}}",
		"{\"op\":\"pi_delta\",\"v\":1,\"pi\":{\"version\":\"0123456789012345678901234567890123\",\"sha256\":\"%s\",\"url\":\"https://bucket.example/firmware/x\"}}",
		"{\"op\":\"pi_delta\",\"v\":1,\"pi\":{\"version\":\"v1\",\"sha256\":\"abc\",\"url\":\"https://bucket.example/firmware/x\"}}",
		"{\"op\":\"pi_delta\",\"v\":1,\"pi\":{\"version\":\"v1\",\"sha256\":\"%s\"}}",
		"{\"op\":\"pi_delta\",\"v\":1,\"pi\":\"x\"}",
	};
	for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
		snprintf(doc, sizeof(doc), bad[i], sha);
		CHECK(parse_doc(doc, &job) == OTA_JOB_BAD_DOCUMENT);
		CHECK(strcmp(job.id, "pi-delta-1") == 0 && !job.pi_delta);
	}
	snprintf(doc, sizeof(doc),
		 "{\"op\":\"pi_delta\",\"v\":1,\"pi\":{\"version\":\"v1\",\"sha256\":\"%s\","
		 "\"url\":\"https://elsewhere.example/firmware/x\"}}",
		 sha);
	CHECK(parse_doc(doc, &job) == OTA_JOB_URL_NOT_ALLOWED);
	snprintf(doc, sizeof(doc),
		 "{\"op\":\"pi_delta\",\"v\":2,\"pi\":{\"version\":\"v1\",\"sha256\":\"%s\","
		 "\"url\":\"https://bucket.example/firmware/x\"}}",
		 sha);
	CHECK(parse_doc(doc, &job) == OTA_JOB_UNSUPPORTED);
	/* #196's full-image document is not this firmware's any more. */
	CHECK(parse_doc("{\"op\":\"pi_image\",\"v\":1,\"pi\":{}}", &job) == OTA_JOB_UNSUPPORTED);
}

static void test_http(void)
{
	struct pi_http_head h;
	char buf[256];
	const char *ok = "HTTP/1.1 206 Partial Content\r\nx-amz-id-2: a:b\r\nCONTENT-RANGE: bytes "
			 "5000000000-5000065535/6000000000\r\nContent-Length: 65536\r\n"
			 "Content-Type: application/octet-stream\r\n\r\nBODY";
	size_t end = pi_http_head_end(ok, strlen(ok));

	CHECK(end == strlen(ok) - 4);
	CHECK(pi_http_head_end(ok, end - 1) == 0);
	CHECK(pi_http_parse_head(ok, end, &h) == 0);
	CHECK(h.status == 206 && !h.close && h.has_length && h.content_length == 65536);
	CHECK(h.has_range && h.range_first == 5000000000ull && h.range_last == 5000065535ull &&
	      h.range_total == 6000000000ull);
	CHECK(pi_http_is_range(&h, 5000000000ull, 5000065535ull));
	CHECK(!pi_http_is_range(&h, 5000000000ull, 5000065534ull));

	const char *expired = "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 10\r\n\r\n";
	CHECK(pi_http_parse_head(expired, strlen(expired), &h) == 0 && h.status == 403 && h.close);
	CHECK(!pi_http_is_range(&h, 0, 9));
	const char *whole = "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n";
	CHECK(pi_http_parse_head(whole, strlen(whole), &h) == 0 && !pi_http_is_range(&h, 0, 9));
	const char *old = "HTTP/1.0 206 Partial\r\nContent-Range: bytes 0-9/10\r\n\r\n";
	CHECK(pi_http_parse_head(old, strlen(old), &h) == 0 && h.close && pi_http_is_range(&h, 0, 9));

	const char *bad[] = {
		"HTTP/2 206 x\r\n\r\n",
		"HTTP/1.1 2O6 x\r\n\r\n",
		"HTTP/1.1 206 x\r\nContent-Length: 12a\r\n\r\n",
		"HTTP/1.1 206 x\r\nContent-Range: bytes 1-2\r\n\r\n",
		"HTTP/1.1 206 x\r\nContent-Range: items 1-2/3\r\n\r\n",
		"HTTP/1.1 206 x\r\nContent-Length: 99999999999999999999\r\n\r\n",
		"HTTP/1.1 206 x\r\nno end",
	};
	for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
		CHECK(pi_http_parse_head(bad[i], strlen(bad[i]), &h) == -1);
	}

	CHECK(pi_http_request_tail(buf, sizeof(buf), "bucket.example", 5000000000ull, 5000065535ull) > 0);
	CHECK(strstr(buf, "\r\nHost: bucket.example\r\n") != NULL);
	CHECK(strstr(buf, "\r\nRange: bytes=5000000000-5000065535\r\n") != NULL);
	CHECK(strncmp(buf, " HTTP/1.1\r\n", 11) == 0);
	CHECK(strcmp(buf + strlen(buf) - 4, "\r\n\r\n") == 0);
	CHECK(pi_http_request_tail(buf, 20, "bucket.example", 0, 1) == -1);
}

/* ------------------------------------------------------------------------------------------- */
/* The report that goes with the heartbeat (pi_delta_report(), as main.c's "pi")                */

/* The report is exactly `expected`, and JSON: an object with the six keys. */
static bool report_is(const struct world *w, bool job, const char *expected)
{
	static const char *const keys[] = { "card", "version", "generation", "step", "done", "total" };
	char buf[PI_DELTA_REPORT_MAX];
	int written = pi_delta_report(&w->delta, job, buf, sizeof(buf));
	cJSON *json = written > 0 ? cJSON_Parse(buf) : NULL;
	bool ok = written == (int)strlen(expected) && strcmp(buf, expected) == 0 && cJSON_IsObject(json);

	for (size_t i = 0; ok && i < sizeof(keys) / sizeof(keys[0]); i++) {
		ok = cJSON_HasObjectItem(json, keys[i]);
	}
	if (!ok) {
		printf("     report: %s\n", written > 0 ? buf : "(none)");
	}
	cJSON_Delete(json);
	return ok;
}

static void test_report(void)
{
	uint64_t size;
	uint8_t *v1 = make_image(9, BLOCKS, &size);
	uint8_t *v2 = malloc((size_t)size);
	char buf[PI_DELTA_REPORT_MAX];
	struct world w;

	memcpy(v2, v1, (size_t)size);
	for (uint32_t b = 10; b < 30; b++) {
		change_block(v2, b, 9);
	}
	world_create(&w);
	pi_card_init(&w.card, &fake_disk_ops, &w.disk);
	pi_delta_init(&w.delta, &w.card, &config, &w.fetch, fake_verify, &w.stop);

	/* Before the card is read, and with the slot empty: no card. */
	CHECK(report_is(&w, false,
			"{\"card\":\"no_card\",\"version\":\"\",\"generation\":0,\"step\":\"idle\",\"done\":0,"
			"\"total\":0}"));
	w.disk.absent = true;
	CHECK(pi_card_open(&w.card, MAX_BLOCKS) == PI_ERR_SD_ABSENT);
	CHECK(report_is(&w, false,
			"{\"card\":\"no_card\",\"version\":\"\",\"generation\":0,\"step\":\"idle\",\"done\":0,"
			"\"total\":0}"));
	w.disk.absent = false;

	/* A new card: empty, with no version. */
	CHECK(pi_card_open(&w.card, MAX_BLOCKS) == PI_OK);
	CHECK(report_is(&w, false,
			"{\"card\":\"empty\",\"version\":\"\",\"generation\":0,\"step\":\"idle\",\"done\":0,"
			"\"total\":0}"));

	/* An image on it: ready, its version and generation. The step is the job's, while it has one. */
	install(&w, v1, size, "v1");
	CHECK(report_is(&w, false,
			"{\"card\":\"ready\",\"version\":\"v1\",\"generation\":1,\"step\":\"idle\",\"done\":40,"
			"\"total\":40}"));
	CHECK(report_is(&w, true,
			"{\"card\":\"ready\",\"version\":\"v1\",\"generation\":1,\"step\":\"done\",\"done\":40,"
			"\"total\":40}"));

	/* Cut off five of twenty changed blocks in: updating, to the new image, with the update's numbers. */
	serve(&w, v2, size, "v2");
	w.server.drop_after = 512 + BLOCKS * 32 + 5 * BS + 1234;
	CHECK(run(&w, NULL) == PI_ERR_DOWNLOAD);
	CHECK(report_is(&w, true,
			"{\"card\":\"updating\",\"version\":\"v2\",\"generation\":1,\"step\":\"blocks\",\"done\":5,"
			"\"total\":20}"));
	/* Between calls (waiting for a fresh URL), the step is the one it stopped in. Withdrawn: idle. */
	CHECK(report_is(&w, false,
			"{\"card\":\"updating\",\"version\":\"v2\",\"generation\":1,\"step\":\"idle\",\"done\":5,"
			"\"total\":20}"));

	/* The thread writes the counts one at a time, and a report can come in between: done stays within total. */
	w.delta.stats.blocks_done = 21;
	CHECK(report_is(&w, true,
			"{\"card\":\"updating\",\"version\":\"v2\",\"generation\":1,\"step\":\"blocks\",\"done\":20,"
			"\"total\":20}"));
	w.delta.stats.blocks_total = 0;
	CHECK(report_is(&w, true,
			"{\"card\":\"updating\",\"version\":\"v2\",\"generation\":1,\"step\":\"blocks\",\"done\":0,"
			"\"total\":0}"));

	/*
	 * A version that is not one never reaches the JSON: one with a quote, a backslash and a control
	 * character, and one that fills its field with no terminating zero. The card's bytes are only
	 * ever decoded and checked, but a report must not be able to break the heartbeat it goes in.
	 */
	{
		struct pi_manifest kept = w.card.neu;

		memset(w.card.neu.version, 0, sizeof(w.card.neu.version));
		memcpy(w.card.neu.version, "v2\",\"x\":\"\\\n", 11);
		CHECK(report_is(&w, false,
				"{\"card\":\"updating\",\"version\":\"\",\"generation\":1,\"step\":\"idle\",\"done\":0,"
				"\"total\":0}"));
		memset(w.card.neu.version, 'a', sizeof(w.card.neu.version));
		CHECK(report_is(&w, false,
				"{\"card\":\"updating\",\"version\":\"\",\"generation\":1,\"step\":\"idle\",\"done\":0,"
				"\"total\":0}"));
		w.card.neu = kept;
	}

	/* The rest of it: ready with the new image, a generation on. */
	CHECK(run(&w, NULL) == PI_OK);
	CHECK(mirror_is(&w, v2, size));
	CHECK(report_is(&w, true,
			"{\"card\":\"ready\",\"version\":\"v2\",\"generation\":2,\"step\":\"done\",\"done\":20,"
			"\"total\":20}"));

	/* Taken out: no card, and nothing of the one that was there. */
	pi_card_close(&w.card);
	CHECK(report_is(&w, false,
			"{\"card\":\"no_card\",\"version\":\"\",\"generation\":0,\"step\":\"idle\",\"done\":20,"
			"\"total\":20}"));

	/*
	 * Every field at its longest is PI_DELTA_REPORT_MAX with the terminating zero, exactly, which is
	 * what main.c leaves for it. A byte less is refused, and a step it does not know is "idle".
	 */
	CHECK(pi_card_open(&w.card, MAX_BLOCKS) == PI_OK);
	w.card.st.state = PI_STATE_UPDATING;
	w.card.st.generation = UINT32_MAX;
	memset(w.card.neu.version, 0, sizeof(w.card.neu.version));
	memset(w.card.neu.version, '9', PI_VERSION_MAX);
	w.delta.step = PI_STEP_MANIFEST;
	w.delta.stats.blocks_total = UINT32_MAX;
	w.delta.stats.blocks_done = UINT32_MAX;
	CHECK(pi_delta_report(&w.delta, true, buf, sizeof(buf)) == (int)PI_DELTA_REPORT_MAX - 1);
	CHECK(strstr(buf, "\"version\":\"9999999999999999999999999999999\"") != NULL);
	CHECK(pi_delta_report(&w.delta, true, buf, sizeof(buf) - 1) == -ENOSPC);
	w.delta.step = 77;
	CHECK(pi_delta_report(&w.delta, true, buf, sizeof(buf)) > 0 && strstr(buf, "\"step\":\"idle\"") != NULL);
	CHECK(strcmp(pi_step_name(PI_STEP_COMPARE), "compare") == 0 && strcmp(pi_step_name(PI_STEP_TABLE), "table") == 0);

	world_free(&w);
	free(v1);
	free(v2);
}

int main(void)
{
	pi_card_layout_for(MAX_BLOCKS, &layout);
	disk_sectors = layout.mirror_lba + (uint64_t)(MAX_BLOCKS + 8) * BS / PI_SECTOR_SIZE;

	test_manifest_format();
	test_state_format();
	test_card();
	test_first_and_delta();
	test_refusals();
	test_corrupt_block();
	test_power_cut_everywhere();
	test_interruptions();
	test_other_image_half_way();
	test_link();
	test_shared_link();
	test_job_document();
	test_http();
	test_report();

	printf("pi_delta_tests: %d checks, %d failures\n", checks, failures);
	return failures == 0 ? 0 : 1;
}
