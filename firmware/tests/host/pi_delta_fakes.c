/*
 * Fakes for the Raspberry Pi delta update's host tests: see pi_delta_fakes.h.
 */

#include "pi_delta_fakes.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#include "pi_sha256.h"

static int disk_read(void *ctx, uint64_t lba, uint8_t *buf, uint32_t count)
{
	struct fake_disk *disk = ctx;

	if (disk->dead || disk->absent || disk->fail_reads || lba + count > disk->sectors) {
		return -EIO;
	}
	disk->reads += count;
	memcpy(buf, disk->data + lba * PI_SECTOR_SIZE, (size_t)count * PI_SECTOR_SIZE);
	return 0;
}

static int disk_write(void *ctx, uint64_t lba, const uint8_t *buf, uint32_t count)
{
	struct fake_disk *disk = ctx;

	if (disk->dead || disk->absent || disk->fail_writes || lba + count > disk->sectors) {
		return -EIO;
	}
	if (disk->writes_left == 0) {
		/* The power goes in the middle of this write: half of the first sector is new. */
		memcpy(disk->data + lba * PI_SECTOR_SIZE, buf, PI_SECTOR_SIZE / 2);
		disk->dead = true;
		return -EIO;
	}
	if (disk->writes_left > 0) {
		disk->writes_left--;
	}
	if (disk->pull_after == 0) {
		disk->absent = true;
		disk->pull_after = -1;
		return -EIO;
	}
	if (disk->pull_after > 0) {
		disk->pull_after--;
	}
	disk->writes += count;
	memcpy(disk->data + lba * PI_SECTOR_SIZE, buf, (size_t)count * PI_SECTOR_SIZE);
	if (disk->flip_times > 0 && lba >= disk->flip_from && lba < disk->flip_to) {
		/* A card that says it wrote what it did not. */
		disk->data[lba * PI_SECTOR_SIZE + 17] ^= 0x40;
		disk->flip_times--;
	}
	return 0;
}

static int disk_open(void *ctx, uint64_t *sectors)
{
	struct fake_disk *disk = ctx;

	if (disk->dead || disk->absent) {
		return -EIO;
	}
	*sectors = disk->sectors;
	return 0;
}

static bool disk_present(void *ctx)
{
	const struct fake_disk *disk = ctx;

	return !disk->absent;
}

const struct pi_disk_ops fake_disk_ops = {
	.read = disk_read,
	.write = disk_write,
	.open = disk_open,
	.present = disk_present,
};

void fake_disk_create(struct fake_disk *disk, uint64_t sectors)
{
	memset(disk, 0, sizeof(*disk));
	disk->data = calloc((size_t)sectors, PI_SECTOR_SIZE);
	disk->sectors = sectors;
	disk->writes_left = -1;
	disk->pull_after = -1;
}

void fake_disk_free(struct fake_disk *disk)
{
	free(disk->data);
	disk->data = NULL;
}

void fake_disk_power_on(struct fake_disk *disk)
{
	disk->dead = false;
	disk->writes_left = -1;
}

static uint32_t next_random(uint32_t *seed)
{
	*seed = *seed * 1103515245u + 12345u;
	return (*seed >> 8) & 0xffffffu;
}

int fake_server_get(void *ctx, uint64_t offset, uint64_t len, pi_sink_fn sink, void *sink_ctx)
{
	struct fake_server *server = ctx;
	uint8_t piece[4096];
	uint64_t done = 0;
	bool corrupted = false;

	if (server->requests < sizeof(server->log_offset) / sizeof(server->log_offset[0])) {
		server->log_offset[server->requests] = offset;
		server->log_len[server->requests] = len;
	}
	server->requests++;
	if (len == 0 || offset + len > server->size) {
		/* 416, as S3 answers a range past the end. */
		return -EINVAL;
	}

	while (done < len) {
		uint32_t limit = server->max_piece == 0 ? 1460 : server->max_piece;
		uint64_t take = 1 + next_random(&server->seed) % limit;
		int rc;

		if (take > len - done) {
			take = len - done;
		}
		if (take > sizeof(piece)) {
			take = sizeof(piece);
		}
		if (server->drop_after >= 0 && server->sent + take > (uint64_t)server->drop_after) {
			uint64_t last = (uint64_t)server->drop_after - server->sent;

			if (last > 0) {
				memcpy(piece, server->package + offset + done, (size_t)last);
				server->sent += last;
				(void)sink(sink_ctx, piece, (size_t)last);
			}
			server->drop_after = -1;
			return -ECONNRESET;
		}
		memcpy(piece, server->package + offset + done, (size_t)take);
		if (server->corrupt_times > 0) {
			for (uint64_t i = 0; i < take; i++) {
				uint64_t at = offset + done + i;

				if (at >= server->corrupt_from && at < server->corrupt_to) {
					piece[i] ^= 0x10;
					corrupted = true;
				}
			}
		}
		server->sent += take;
		done += take;
		if (server->stop_flag != NULL && server->stop_after >= 0 &&
		    server->sent >= (uint64_t)server->stop_after) {
			*server->stop_flag = true;
			server->stop_after = -1;
		}
		rc = sink(sink_ctx, piece, (size_t)take);
		if (rc != 0) {
			if (corrupted) {
				server->corrupt_times--;
			}
			return rc > 0 ? 0 : -EINTR;
		}
	}
	if (corrupted) {
		server->corrupt_times--;
	}
	return 0;
}

void fake_sign(const uint8_t *msg, size_t len, uint8_t sig[PI_SIG_SIZE])
{
	struct pi_sha256 sha;

	pi_sha256_init(&sha);
	pi_sha256_update(&sha, msg, len);
	pi_sha256_final(&sha, sig);
	memset(sig + 32, 0xa5, 32);
}

bool fake_verify(const uint8_t *msg, size_t len, const uint8_t sig[PI_SIG_SIZE])
{
	uint8_t want[PI_SIG_SIZE];

	fake_sign(msg, len, want);
	return memcmp(want, sig, PI_SIG_SIZE) == 0;
}

uint8_t *fake_package(const uint8_t *image, uint64_t image_size, uint32_t block_size,
		      const char *version, uint64_t *size, struct pi_manifest *m)
{
	uint32_t count = (uint32_t)((image_size + block_size - 1) / block_size);
	uint64_t table = (uint64_t)count * PI_HASH_SIZE;
	uint64_t image_offset = (PI_MANIFEST_SIZE + table + PI_IMAGE_ALIGN - 1) / PI_IMAGE_ALIGN *
				PI_IMAGE_ALIGN;
	uint8_t *package = calloc(1, (size_t)(image_offset + image_size));
	struct pi_sha256 sha;

	memset(m, 0, sizeof(*m));
	m->block_size = block_size;
	m->block_count = count;
	m->image_size = image_size;
	m->table_offset = PI_MANIFEST_SIZE;
	m->image_offset = image_offset;
	strncpy(m->version, version, PI_VERSION_MAX);

	for (uint32_t i = 0; i < count; i++) {
		uint64_t start = (uint64_t)i * block_size;
		uint64_t len = image_size - start < block_size ? image_size - start : block_size;

		pi_sha256_init(&sha);
		pi_sha256_update(&sha, image + start, (size_t)len);
		pi_sha256_final(&sha, package + PI_MANIFEST_SIZE + (uint64_t)i * PI_HASH_SIZE);
	}
	pi_sha256_init(&sha);
	pi_sha256_update(&sha, package + PI_MANIFEST_SIZE, (size_t)table);
	pi_sha256_final(&sha, m->table_sha256);
	pi_sha256_init(&sha);
	pi_sha256_update(&sha, image, (size_t)image_size);
	pi_sha256_final(&sha, m->image_sha256);

	pi_manifest_encode(m, package);
	fake_sign(package, PI_MANIFEST_SIGNED_SIZE, m->sig);
	pi_manifest_encode(m, package);
	memcpy(package + image_offset, image, (size_t)image_size);
	*size = image_offset + image_size;
	return package;
}
