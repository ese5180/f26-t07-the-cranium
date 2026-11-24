/*
 * The board's side of a Raspberry Pi delta update (src/pi/), on the host, for
 * firmware/tests/hil/test_pi_delta.py and tools/pi_delta_sim.py. The SD card is a file; the server
 * is a package file that tools/pi_image.py built; the signature is checked for real, with MCUboot's
 * own ECDSA (tinycrypt), against the public key given.
 *
 *   pi_delta_harness update CARD PACKAGE VERSION SHA256 PUBKEY [options]
 *       Run the update onto CARD (created if missing). PUBKEY is the uncompressed P-256 point, in
 *       hex. Prints one line: result=<reason> already=0|1 fetched= skipped= bytes= requests=
 *       changed= total=.
 *       --max-blocks N         the layout of a new card (1024)
 *       --card-sectors N       the size of a new card (the layout plus 4 MiB)
 *       --drop-after BYTES     the connection drops after that many bytes
 *       --cut-after-writes N   the power goes at that write, half way through it
 *       --corrupt-at OFFSET    the byte at that offset of the package comes wrong, every time
 *
 *   pi_delta_harness serve CARD [--max-blocks N]
 *       Be the SPI target: each 512 bytes on stdin is what the Pi clocked in during a transfer;
 *       for each, the 512 bytes the board clocked out during it go to stdout (the answer it had
 *       ready before), and then it handles what came in.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <tinycrypt/constants.h>
#include <tinycrypt/ecc.h>
#include <tinycrypt/ecc_dsa.h>

#include "pi_card.h"
#include "pi_delta.h"
#include "pi_delta_fakes.h"
#include "pi_dlink.h"
#include "pi_frame.h"
#include "pi_sha256.h"

static uint8_t public_key[64];

/* tinycrypt wants a random source for signing; the harness only verifies, so it never runs. */
int default_CSPRNG(uint8_t *dest, unsigned int size);
int default_CSPRNG(uint8_t *dest, unsigned int size)
{
	(void)dest;
	(void)size;
	return 0;
}

static bool tinycrypt_verify(const uint8_t *msg, size_t len, const uint8_t sig[PI_SIG_SIZE])
{
	struct pi_sha256 sha;
	uint8_t hash[PI_HASH_SIZE];

	pi_sha256_init(&sha);
	pi_sha256_update(&sha, msg, len);
	pi_sha256_final(&sha, hash);
	return uECC_verify(public_key, hash, sizeof(hash), sig, uECC_secp256r1()) == TC_CRYPTO_SUCCESS;
}

static int hex_nibble(char c)
{
	if (c >= '0' && c <= '9') {
		return c - '0';
	}
	if (c >= 'a' && c <= 'f') {
		return c - 'a' + 10;
	}
	return -1;
}

static bool parse_hex(const char *text, uint8_t *out, size_t size)
{
	if (strlen(text) != 2 * size) {
		return false;
	}
	for (size_t i = 0; i < size; i++) {
		int hi = hex_nibble(text[2 * i]);
		int lo = hex_nibble(text[2 * i + 1]);

		if (hi < 0 || lo < 0) {
			return false;
		}
		out[i] = (uint8_t)(hi << 4 | lo);
	}
	return true;
}

static uint8_t *read_file(const char *path, uint64_t *size)
{
	FILE *f = fopen(path, "rb");
	uint8_t *data;
	long length;

	if (f == NULL) {
		return NULL;
	}
	fseek(f, 0, SEEK_END);
	length = ftell(f);
	fseek(f, 0, SEEK_SET);
	data = malloc(length > 0 ? (size_t)length : 1);
	if (data == NULL || fread(data, 1, (size_t)length, f) != (size_t)length) {
		fclose(f);
		free(data);
		return NULL;
	}
	fclose(f);
	*size = (uint64_t)length;
	return data;
}

static bool load_card(struct fake_disk *disk, const char *path, uint64_t sectors)
{
	uint64_t size = 0;
	uint8_t *data = read_file(path, &size);

	if (data == NULL) {
		fake_disk_create(disk, sectors);
		return disk->data != NULL;
	}
	memset(disk, 0, sizeof(*disk));
	disk->data = data;
	disk->sectors = size / PI_SECTOR_SIZE;
	disk->writes_left = -1;
	disk->pull_after = -1;
	return true;
}

static bool save_card(const struct fake_disk *disk, const char *path)
{
	FILE *f = fopen(path, "wb");
	bool ok;

	if (f == NULL) {
		return false;
	}
	ok = fwrite(disk->data, PI_SECTOR_SIZE, (size_t)disk->sectors, f) == disk->sectors;
	return fclose(f) == 0 && ok;
}

static long long option(int argc, char **argv, const char *name, long long fallback)
{
	for (int i = 0; i + 1 < argc; i++) {
		if (strcmp(argv[i], name) == 0) {
			return strtoll(argv[i + 1], NULL, 0);
		}
	}
	return fallback;
}

static int update(int argc, char **argv)
{
	struct pi_delta_config config = {
		.default_max_blocks = (uint32_t)option(argc, argv, "--max-blocks", 1024),
		.run_blocks = 16,
		.block_attempts = 3,
		.skip_save_every = 64,
		.table_save_every = 64,
	};
	struct pi_card_layout layout;
	struct fake_disk disk;
	struct fake_server server;
	struct pi_card card;
	struct pi_delta delta;
	struct pi_fetch fetch = { .get = fake_server_get, .ctx = &server };
	struct pi_delta_job job;
	uint8_t point[65];
	uint64_t package_size = 0;
	uint8_t *package;
	bool already = false;
	enum pi_err err;
	long long cut;

	if (argc < 7) {
		return 2;
	}
	memset(&job, 0, sizeof(job));
	if (strlen(argv[4]) > PI_VERSION_MAX || !parse_hex(argv[5], job.sha256, PI_HASH_SIZE) ||
	    !parse_hex(argv[6], point, sizeof(point)) || point[0] != 0x04) {
		fprintf(stderr, "bad arguments\n");
		return 2;
	}
	strcpy(job.version, argv[4]);
	memcpy(public_key, point + 1, sizeof(public_key));

	pi_card_layout_for(config.default_max_blocks, &layout);
	if (!load_card(&disk, argv[2],
		       (uint64_t)option(argc, argv, "--card-sectors",
					(long long)(layout.mirror_lba + 8192)))) {
		fprintf(stderr, "cannot make the card\n");
		return 2;
	}
	package = read_file(argv[3], &package_size);
	if (package == NULL) {
		fprintf(stderr, "cannot read the package\n");
		return 2;
	}
	memset(&server, 0, sizeof(server));
	server.package = package;
	server.size = package_size;
	server.max_piece = 2048;
	server.seed = 99;
	server.drop_after = option(argc, argv, "--drop-after", -1);
	server.stop_after = -1;
	if (option(argc, argv, "--corrupt-at", -1) >= 0) {
		server.corrupt_from = (uint64_t)option(argc, argv, "--corrupt-at", -1);
		server.corrupt_to = server.corrupt_from + 1;
		server.corrupt_times = 1 << 30;
	}
	cut = option(argc, argv, "--cut-after-writes", -1);
	disk.writes_left = (long)cut;

	pi_card_init(&card, &fake_disk_ops, &disk);
	pi_delta_init(&delta, &card, &config, &fetch, tinycrypt_verify, NULL);
	err = pi_delta_run(&delta, &job, &already);

	printf("result=%s already=%d fetched=%u skipped=%u bytes=%llu requests=%u changed=%u total=%u\n",
	       pi_err_reason(err), already ? 1 : 0, delta.stats.blocks_fetched,
	       delta.stats.blocks_skipped, (unsigned long long)delta.stats.bytes_fetched,
	       delta.stats.requests, delta.stats.changed, delta.stats.blocks_total);
	if (!save_card(&disk, argv[2])) {
		fprintf(stderr, "cannot write the card\n");
		return 2;
	}
	free(package);
	fake_disk_free(&disk);
	return 0;
}

static int serve(int argc, char **argv)
{
	struct fake_disk disk;
	struct pi_card card;
	struct pi_dlink link;
	uint8_t rx[PI_FRAME_SIZE];
	uint8_t tx[PI_FRAME_SIZE];

	if (argc < 3 || !load_card(&disk, argv[2], 0) || disk.sectors == 0) {
		fprintf(stderr, "cannot read the card\n");
		return 2;
	}
	pi_card_init(&card, &fake_disk_ops, &disk);
	(void)pi_card_open(&card, (uint32_t)option(argc, argv, "--max-blocks", 1024));
	pi_dlink_init(&link, &card);
	/* Before the first answer, the board clocks out its default character. */
	memset(tx, 0xff, sizeof(tx));

	while (fread(rx, 1, sizeof(rx), stdin) == sizeof(rx)) {
		if (fwrite(tx, 1, sizeof(tx), stdout) != sizeof(tx)) {
			return 3;
		}
		fflush(stdout);
		(void)pi_dlink_handle(&link, rx, sizeof(rx), tx);
	}
	fprintf(stderr, "answered=%u errors=%u bad_frames=%u polls=%u\n", link.answered, link.errors,
		link.bad_frames, link.polls);
	fake_disk_free(&disk);
	return 0;
}

int main(int argc, char **argv)
{
	if (argc >= 2 && strcmp(argv[1], "update") == 0) {
		return update(argc, argv);
	}
	if (argc >= 2 && strcmp(argv[1], "serve") == 0) {
		return serve(argc, argv);
	}
	fprintf(stderr, "usage: pi_delta_harness update|serve ... (see the top of pi_delta_harness.c)\n");
	return 2;
}
