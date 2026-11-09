/*
 * Host-side tests of the Raspberry Pi image update, from 1.15.0 (docs/pi-ota.md): SHA-256 and its
 * saved state, CRC-32, the job document and the list of pending jobs, the signed manifest and the
 * checks on a job, the SD card's layer (src/pi_sd.c) on an in-memory file system with faults, and
 * the download onto the card (src/pi_dl.c) with a fake HTTP server: resume after a lost
 * connection, after a card that failed and after a restart, a digest or a size that is wrong, a
 * full card, a missing card, and a download that is stopped.
 *
 * The SPI protocol is tested against tools/pi_link_sim.py (firmware/tests/hil/test_pi_link.py),
 * through pi_link_harness.c. The real card, the bus and the Pi are not here: docs/pi-ota.md says
 * what is untested on hardware.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ota_job.h"
#include "pi_dl.h"
#include "pi_image.h"
#include "pi_sd.h"
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

#define PREFIX "https://fw-bucket.s3.us-east-1.amazonaws.com/firmware/"

/* ---- an in-memory file system, with faults ------------------------------------------------- */

#define FILES_MAX 8

struct file {
	bool used;
	char path[64];
	uint8_t *data;
	size_t size;
	size_t capacity;
};

struct handle {
	bool used;
	int file;
	size_t position;
};

/* Open files: a pool, so that one a simulated restart abandons is no leak. */
#define HANDLES_MAX 64

static struct {
	struct file files[FILES_MAX];
	struct handle handles[HANDLES_MAX];
	bool card_in;
	/* Bytes the volume holds, all files together. */
	size_t volume;
	/*
	 * Writes fail with -EIO once this many bytes of writes have gone through, 0: never. As many
	 * writes in a row as fail_writes, then no more; 0 counts as 1.
	 */
	size_t fail_write_after;
	int fail_writes;
	size_t written;
	/* Every operation takes this long. */
	int64_t op_ms;
	int64_t now;
	int releases;
	int opens;
} fs;

static size_t used_bytes(void)
{
	size_t total = 0;

	for (int i = 0; i < FILES_MAX; i++) {
		total += fs.files[i].used ? fs.files[i].size : 0;
	}
	return total;
}

static int find(const char *path)
{
	for (int i = 0; i < FILES_MAX; i++) {
		if (fs.files[i].used && strcmp(fs.files[i].path, path) == 0) {
			return i;
		}
	}
	return -1;
}

static void tick(void)
{
	fs.now += fs.op_ms;
}

static void resize(struct file *f, size_t size)
{
	if (size > f->capacity) {
		f->capacity = size * 2 + 64;
		f->data = realloc(f->data, f->capacity);
	}
	if (size > f->size) {
		memset(f->data + f->size, 0, size - f->size);
	}
	f->size = size;
}

int fs_open(struct fs_file_t *zfp, const char *file_name, fs_mode_t flags)
{
	int index = find(file_name);
	struct handle *h;

	tick();
	if (!fs.card_in) {
		return -EIO;
	}

	if (index < 0) {
		if (!(flags & FS_O_CREATE)) {
			return -ENOENT;
		}
		for (index = 0; index < FILES_MAX && fs.files[index].used; index++) {
		}
		CHECK(index < FILES_MAX);
		memset(&fs.files[index], 0, sizeof(fs.files[index]));
		fs.files[index].used = true;
		strncpy(fs.files[index].path, file_name, sizeof(fs.files[index].path) - 1);
	}

	for (h = fs.handles; h < fs.handles + HANDLES_MAX && h->used; h++) {
	}
	if (h == fs.handles + HANDLES_MAX) {
		return -ENFILE;
	}
	h->used = true;
	h->file = index;
	h->position = 0;
	zfp->filep = h;
	zfp->flags = flags;
	fs.opens++;
	return 0;
}

int fs_close(struct fs_file_t *zfp)
{
	tick();
	((struct handle *)zfp->filep)->used = false;
	zfp->filep = NULL;
	fs.opens--;
	return 0;
}

ssize_t fs_read(struct fs_file_t *zfp, void *ptr, size_t size)
{
	struct handle *h = zfp->filep;
	struct file *f = &fs.files[h->file];
	size_t take;

	tick();
	if (!fs.card_in) {
		return -EIO;
	}

	take = h->position >= f->size ? 0 : f->size - h->position;
	take = take < size ? take : size;
	memcpy(ptr, f->data + h->position, take);
	h->position += take;
	return (ssize_t)take;
}

ssize_t fs_write(struct fs_file_t *zfp, const void *ptr, size_t size)
{
	struct handle *h = zfp->filep;
	struct file *f = &fs.files[h->file];
	size_t room;
	size_t end;

	tick();
	if (!fs.card_in) {
		return -EIO;
	}

	if (!(zfp->flags & FS_O_WRITE)) {
		return -EACCES;
	}

	if (fs.fail_write_after != 0 && fs.written + size > fs.fail_write_after) {
		if (--fs.fail_writes <= 0) {
			fs.fail_write_after = 0;
		}
		return -EIO;
	}

	/* A full volume takes what fits, as FatFS does. */
	end = h->position + size;
	room = fs.volume - used_bytes() + f->size;
	if (end > room) {
		if (h->position >= room) {
			return 0;
		}
		size = room - h->position;
		end = room;
	}

	if (end > f->size) {
		resize(f, end);
	}
	memcpy(f->data + h->position, ptr, size);
	h->position += size;
	fs.written += size;
	return (ssize_t)size;
}

int fs_seek(struct fs_file_t *zfp, off_t offset, int whence)
{
	struct handle *h = zfp->filep;

	tick();
	CHECK(whence == FS_SEEK_SET);
	if (offset > (off_t)fs.files[h->file].size) {
		/* FatFS extends a file opened for writing; nothing here needs that. */
		return -EINVAL;
	}
	h->position = (size_t)offset;
	return 0;
}

off_t fs_tell(struct fs_file_t *zfp)
{
	return (off_t)((struct handle *)zfp->filep)->position;
}

int fs_truncate(struct fs_file_t *zfp, off_t length)
{
	struct handle *h = zfp->filep;

	tick();
	if (!fs.card_in) {
		return -EIO;
	}
	resize(&fs.files[h->file], (size_t)length);
	return 0;
}

int fs_sync(struct fs_file_t *zfp)
{
	(void)zfp;
	tick();
	return fs.card_in ? 0 : -EIO;
}

int fs_stat(const char *path, struct fs_dirent *entry)
{
	int index = find(path);

	tick();
	if (!fs.card_in) {
		return -EIO;
	}
	if (index < 0) {
		return -ENOENT;
	}
	entry->size = fs.files[index].size;
	return 0;
}

int fs_statvfs(const char *path, struct fs_statvfs *stat)
{
	(void)path;
	tick();
	if (!fs.card_in) {
		return -EIO;
	}
	stat->f_bsize = 512;
	stat->f_frsize = 512;
	stat->f_blocks = fs.volume / 512;
	stat->f_bfree = (fs.volume - used_bytes()) / 512;
	return 0;
}

int fs_unlink(const char *path)
{
	int index = find(path);

	tick();
	if (!fs.card_in) {
		return -EIO;
	}
	if (index < 0) {
		return -ENOENT;
	}
	free(fs.files[index].data);
	memset(&fs.files[index], 0, sizeof(fs.files[index]));
	return 0;
}

int fs_rename(const char *from, const char *to)
{
	int index = find(from);

	tick();
	if (index < 0) {
		return -ENOENT;
	}
	if (find(to) >= 0) {
		return -EEXIST;
	}
	strncpy(fs.files[index].path, to, sizeof(fs.files[index].path) - 1);
	return 0;
}

int fs_mkdir(const char *path)
{
	(void)path;
	tick();
	return fs.card_in ? 0 : -EIO;
}

static bool card_present(void)
{
	return fs.card_in;
}

static void release_bus(void)
{
	fs.releases++;
}

static int64_t now_ms(void)
{
	return fs.now;
}

static const struct pi_sd_hooks hooks = {
	.present = card_present,
	.release_bus = release_bus,
	.now_ms = now_ms,
};

static void fresh_card(size_t volume)
{
	for (int i = 0; i < FILES_MAX; i++) {
		free(fs.files[i].data);
	}
	memset(&fs, 0, sizeof(fs));
	fs.card_in = true;
	fs.volume = volume;
	pi_sd_set_hooks(&hooks);
}

/* ---- helpers ------------------------------------------------------------------------------- */

static void hex(const uint8_t *bytes, size_t len, char *out)
{
	for (size_t i = 0; i < len; i++) {
		snprintf(out + 2 * i, 3, "%02x", bytes[i]);
	}
}

static bool digest_is(const void *data, size_t len, const char *expected)
{
	struct pi_sha256 ctx;
	uint8_t digest[32];
	char text[65];

	pi_sha256_init(&ctx);
	pi_sha256_update(&ctx, data, len);
	pi_sha256_final(&ctx, digest);
	hex(digest, sizeof(digest), text);
	return strcmp(text, expected) == 0;
}

/* An image of size bytes, with a pattern that no offset repeats soon. */
static uint8_t *make_image(uint32_t size)
{
	uint8_t *image = malloc(size);

	for (uint32_t i = 0; i < size; i++) {
		image[i] = (uint8_t)((i * 2654435761u) >> 24);
	}
	return image;
}

static void image_job(struct pi_target *job, const uint8_t *image, uint32_t size)
{
	struct pi_sha256 ctx;

	memset(job, 0, sizeof(*job));
	strcpy(job->id, "pi-2026-11-06-ab12");
	strcpy(job->version, "2026.11.06-1");
	job->size = size;
	pi_sha256_init(&ctx);
	pi_sha256_update(&ctx, image, size);
	pi_sha256_final(&ctx, job->sha256);
}

/*
 * The fake HTTP server: the image from byte `from`, in pieces of `piece` bytes, until `stop`
 * (a lost connection) or the end. Returns the first error from the download, or PI_OK.
 */
static enum pi_err serve(struct pi_dl *dl, const uint8_t *image, uint32_t size, uint32_t from,
			 uint32_t stop, uint32_t piece)
{
	for (uint32_t at = from; at < size && at < stop;) {
		uint32_t len = size - at < piece ? size - at : piece;
		enum pi_err err;

		if (stop - at < len) {
			len = stop - at;
		}
		err = pi_dl_write(dl, image + at, len);
		if (err != PI_OK) {
			return err;
		}
		at += len;
	}
	return PI_OK;
}

static bool card_holds(const uint8_t *image, uint32_t size)
{
	int index = find(PI_SD_IMAGE);

	return index >= 0 && fs.files[index].size == size &&
	       memcmp(fs.files[index].data, image, size) == 0;
}

/* ---- SHA-256 and CRC-32 -------------------------------------------------------------------- */

static void test_sha256_known_answers(void)
{
	static uint8_t million[1000000];
	struct pi_sha256 ctx;
	struct pi_sha256 saved;
	uint8_t one[32];
	uint8_t two[32];

	CHECK(digest_is("", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
	CHECK(digest_is("abc", 3, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
	CHECK(digest_is("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", 56,
			"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"));
	memset(million, 'a', sizeof(million));
	CHECK(digest_is(million, sizeof(million),
			"cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"));

	/* Fed in odd pieces, and saved and taken up again midway, it is the same hash. */
	pi_sha256_init(&ctx);
	for (size_t at = 0; at < sizeof(million);) {
		size_t len = (at % 7) * 13 + 1;

		len = len < sizeof(million) - at ? len : sizeof(million) - at;
		pi_sha256_update(&ctx, million + at, len);
		at += len;
		if (at > 500000 && at < 500100) {
			memcpy(&saved, &ctx, sizeof(saved));
			memset(&ctx, 0xa5, sizeof(ctx));
			memcpy(&ctx, &saved, sizeof(ctx));
		}
	}
	pi_sha256_peek(&ctx, one);
	pi_sha256_final(&ctx, two);
	CHECK(memcmp(one, two, 32) == 0);
	CHECK(digest_is(million, sizeof(million),
			"cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"));
	pi_sha256_init(&ctx);
	pi_sha256_update(&ctx, million, sizeof(million));
	pi_sha256_final(&ctx, one);
	CHECK(memcmp(one, two, 32) == 0);
}

static void test_crc32_is_zlibs(void)
{
	CHECK(pi_crc32(0, "123456789", 9) == 0xcbf43926u);
	CHECK(pi_crc32(0, "", 0) == 0);
	/* Continued, it is the same as at once. */
	CHECK(pi_crc32(pi_crc32(0, "1234", 4), "56789", 5) == 0xcbf43926u);
}

/* ---- the job document and the list -------------------------------------------------------- */

static char message[4096];

static enum ota_job_result parse_pi(const char *fields, struct ota_job *job)
{
	snprintf(message, sizeof(message),
		 "{\"execution\":{\"jobId\":\"pi-1\",\"status\":\"QUEUED\",\"jobDocument\":"
		 "{\"op\":\"pi_image\",\"v\":1,\"pi\":{%s}}}}",
		 fields);
	return ota_job_parse(message, strlen(message), PREFIX, job);
}

#define SHA_HEX "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
#define SIG_HEX SHA_HEX SHA_HEX
#define GOOD_FIELDS                                                                           \
	"\"version\":\"2026.11.06-1\",\"size\":104857600,\"sha256\":\"" SHA_HEX "\","            \
	"\"sig\":\"" SIG_HEX "\",\"url\":\"" PREFIX "pi-x.img?X-Amz-Signature=abc\""

static void test_a_pi_image_document_is_read(void)
{
	struct ota_job job;

	CHECK(parse_pi(GOOD_FIELDS, &job) == OTA_JOB_OK);
	CHECK(job.kind == OTA_JOB_KIND_PI_IMAGE);
	CHECK(strcmp(job.id, "pi-1") == 0);
	CHECK(strcmp(job.pi_version, "2026.11.06-1") == 0);
	CHECK(job.size == 104857600u);
	CHECK(job.sha256[0] == 0x00 && job.sha256[31] == 0x1f);
	CHECK(job.pi_sig[0] == 0x00 && job.pi_sig[63] == 0x1f);
	CHECK(!job.pi_has_min_firmware);
	CHECK(strcmp(job.host, "https://fw-bucket.s3.us-east-1.amazonaws.com") == 0);
	CHECK(strncmp(job.file, "firmware/pi-x.img?", 18) == 0);

	CHECK(parse_pi(GOOD_FIELDS ",\"minFirmware\":\"1.15.0\"", &job) == OTA_JOB_OK);
	CHECK(job.pi_has_min_firmware);
	CHECK(job.pi_min_firmware.major == 1 && job.pi_min_firmware.minor == 15);

	/* A firmware document is still one, of the other kind. */
	snprintf(message, sizeof(message),
		 "{\"execution\":{\"jobId\":\"cranium-1\",\"status\":\"QUEUED\",\"jobDocument\":"
		 "{\"op\":\"fw_update\",\"v\":1,\"fw\":{\"version\":\"1.15.0\",\"size\":1000,"
		 "\"sha256\":\"" SHA_HEX "\",\"url\":\"" PREFIX "x.bin\"}}}}");
	CHECK(ota_job_parse(message, strlen(message), PREFIX, &job) == OTA_JOB_OK);
	CHECK(job.kind == OTA_JOB_KIND_FIRMWARE);
}

static void test_a_bad_pi_image_document_is_refused(void)
{
	static const char *const bad[] = {
		/* Each field missing. */
		"\"size\":1,\"sha256\":\"" SHA_HEX "\",\"sig\":\"" SIG_HEX "\",\"url\":\"" PREFIX "a\"",
		"\"version\":\"1\",\"sha256\":\"" SHA_HEX "\",\"sig\":\"" SIG_HEX "\",\"url\":\"" PREFIX
		"a\"",
		"\"version\":\"1\",\"size\":1,\"sig\":\"" SIG_HEX "\",\"url\":\"" PREFIX "a\"",
		"\"version\":\"1\",\"size\":1,\"sha256\":\"" SHA_HEX "\",\"url\":\"" PREFIX "a\"",
		/* A version that would break the manifest, or too long. */
		"\"version\":\"1\\n2\",\"size\":1,\"sha256\":\"" SHA_HEX "\",\"sig\":\"" SIG_HEX
		"\",\"url\":\"" PREFIX "a\"",
		"\"version\":\"a b\",\"size\":1,\"sha256\":\"" SHA_HEX "\",\"sig\":\"" SIG_HEX
		"\",\"url\":\"" PREFIX "a\"",
		"\"version\":\"12345678901234567890123456789012\",\"size\":1,\"sha256\":\"" SHA_HEX
		"\",\"sig\":\"" SIG_HEX "\",\"url\":\"" PREFIX "a\"",
		/* Sizes. */
		"\"version\":\"1\",\"size\":0,\"sha256\":\"" SHA_HEX "\",\"sig\":\"" SIG_HEX
		"\",\"url\":\"" PREFIX "a\"",
		"\"version\":\"1\",\"size\":4294967296,\"sha256\":\"" SHA_HEX "\",\"sig\":\"" SIG_HEX
		"\",\"url\":\"" PREFIX "a\"",
		"\"version\":\"1\",\"size\":1.5,\"sha256\":\"" SHA_HEX "\",\"sig\":\"" SIG_HEX
		"\",\"url\":\"" PREFIX "a\"",
		/* A short signature, upper case hex, a minFirmware that is no version. */
		"\"version\":\"1\",\"size\":1,\"sha256\":\"" SHA_HEX "\",\"sig\":\"" SHA_HEX
		"\",\"url\":\"" PREFIX "a\"",
		"\"version\":\"1\",\"size\":1,\"sha256\":\"" SHA_HEX "\",\"sig\":\"" SIG_HEX
		"\",\"url\":\"" PREFIX "a\",\"minFirmware\":\"latest\"",
		"\"version\":\"1\",\"size\":1,\"sha256\":\"" SHA_HEX "\",\"sig\":\"" SIG_HEX
		"\",\"url\":\"" PREFIX "a\",\"minFirmware\":1",
	};
	struct ota_job job;

	for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
		CHECK(parse_pi(bad[i], &job) == OTA_JOB_BAD_DOCUMENT);
		/* What is left identifies the job, to refuse it. */
		CHECK(strcmp(job.id, "pi-1") == 0);
	}

	/* From anywhere but the provisioned place. */
	CHECK(parse_pi("\"version\":\"1\",\"size\":1,\"sha256\":\"" SHA_HEX "\",\"sig\":\"" SIG_HEX
		       "\",\"url\":\"https://elsewhere.example/firmware/a\"",
		       &job) == OTA_JOB_URL_NOT_ALLOWED);
}

static enum ota_job_result list(const char *json, struct ota_job *job)
{
	return ota_job_list_parse(json, strlen(json), job);
}

static void test_the_list_of_pending_jobs_names_the_firmware_job(void)
{
	struct ota_job job;

	CHECK(list("{\"inProgressJobs\":[],\"queuedJobs\":[{\"jobId\":\"pi-a\"},"
		   "{\"jobId\":\"cranium-1-15-1-b0-20261107T000000Z-abcd\"}]}",
		   &job) == OTA_JOB_OK);
	CHECK(strcmp(job.id, "cranium-1-15-1-b0-20261107T000000Z-abcd") == 0);
	CHECK(!job.in_progress);

	/* In progress before queued. */
	CHECK(list("{\"inProgressJobs\":[{\"jobId\":\"fw-b\"}],\"queuedJobs\":[{\"jobId\":"
		   "\"fw-a\"}]}",
		   &job) == OTA_JOB_OK);
	CHECK(strcmp(job.id, "fw-b") == 0 && job.in_progress);

	/* Only Pi images, or nothing at all. */
	CHECK(list("{\"inProgressJobs\":[],\"queuedJobs\":[{\"jobId\":\"pi-a\"}]}", &job) ==
	      OTA_JOB_NONE);
	CHECK(list("{\"clientToken\":\"x\"}", &job) == OTA_JOB_NONE);

	/* What cannot be trusted. */
	CHECK(list("not json", &job) == OTA_JOB_MALFORMED);
	CHECK(list("{\"queuedJobs\":{}}", &job) == OTA_JOB_MALFORMED);
	CHECK(list("[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]", &job) == OTA_JOB_MALFORMED);
	/* An ID that could not go into a topic is passed over. */
	CHECK(list("{\"queuedJobs\":[{\"jobId\":\"a/b\"},{\"jobId\":\"c\"}]}", &job) == OTA_JOB_OK);
	CHECK(strcmp(job.id, "c") == 0);
}

/* ---- the manifest and the checks on a job ------------------------------------------------- */

#define GOLDEN_MANIFEST                                                                       \
	"cranium-pi-image-v1\nversion=2026.11.06-1\nsize=104857600\nsha256=" SHA_HEX             \
	"\nmin_firmware=none\n"

static char verified[PI_MANIFEST_MAX];
static int verify_answer;

static int fake_verify(const uint8_t *msg, size_t len, const uint8_t sig[OTA_PI_SIG_SIZE])
{
	memcpy(verified, msg, len);
	verified[len] = '\0';
	CHECK(sig[0] == 0x00 && sig[63] == 0x1f);
	return verify_answer;
}

static void test_the_manifest_is_the_one_tools_pi_image_py_signs(void)
{
	struct ota_job job;
	struct fw_version running = { .major = 1, .minor = 15 };
	uint8_t installed[32];
	char text[PI_MANIFEST_MAX];

	CHECK(parse_pi(GOOD_FIELDS, &job) == OTA_JOB_OK);
	CHECK(pi_manifest_text(&job, text, sizeof(text)) == (int)strlen(GOLDEN_MANIFEST));
	CHECK(strcmp(text, GOLDEN_MANIFEST) == 0);
	CHECK(pi_manifest_text(&job, text, 20) == -1);

	verify_answer = 0;
	CHECK(pi_job_check(&job, 200u << 20, &running, NULL, fake_verify) == PI_OK);
	CHECK(strcmp(verified, GOLDEN_MANIFEST) == 0);

	/* The signature does not hold: nothing else is looked at. */
	verify_answer = -1;
	CHECK(pi_job_check(&job, 1, &running, NULL, fake_verify) == PI_ERR_BAD_SIGNATURE);
	CHECK(strcmp(pi_err_reason(PI_ERR_BAD_SIGNATURE), "bad_signature") == 0);
	verify_answer = 0;

	CHECK(pi_job_check(&job, 100u << 20, &running, NULL, fake_verify) == PI_OK);
	CHECK(pi_job_check(&job, (100u << 20) - 1, &running, NULL, fake_verify) ==
	      PI_ERR_TOO_LARGE);

	memcpy(installed, job.sha256, sizeof(installed));
	CHECK(pi_job_check(&job, 200u << 20, &running, installed, fake_verify) ==
	      PI_ERR_ALREADY_INSTALLED);
	installed[5] ^= 1;
	CHECK(pi_job_check(&job, 200u << 20, &running, installed, fake_verify) == PI_OK);

	/* minFirmware is signed too, and refuses a board that runs older. */
	CHECK(parse_pi(GOOD_FIELDS ",\"minFirmware\":\"1.15.1\"", &job) == OTA_JOB_OK);
	CHECK(pi_job_check(&job, 200u << 20, &running, NULL, fake_verify) ==
	      PI_ERR_FIRMWARE_TOO_OLD);
	CHECK(strstr(verified, "\nmin_firmware=1.15.1+0\n") != NULL);
	CHECK(strcmp(pi_err_reason(PI_ERR_FIRMWARE_TOO_OLD), "firmware_too_old") == 0);
	running.revision = 1;
	CHECK(pi_job_check(&job, 200u << 20, &running, NULL, fake_verify) == PI_OK);

	/* A firmware job is never a Pi image. */
	job.kind = OTA_JOB_KIND_FIRMWARE;
	CHECK(pi_job_check(&job, 200u << 20, &running, NULL, fake_verify) == PI_ERR_BAD_SIGNATURE);

	/* Every reason has a name. */
	for (int e = 0; e < PI_ERR_COUNT; e++) {
		CHECK(pi_err_reason((enum pi_err)e) != NULL);
		CHECK(strcmp(pi_err_reason((enum pi_err)e), "unknown") != 0);
	}
	CHECK(strcmp(pi_err_reason(PI_ERR_COUNT), "unknown") == 0);
}

static void test_a_record_is_sealed(void)
{
	struct pi_record record;

	memset(&record, 0, sizeof(record));
	pi_sha256_init(&record.hash);
	pi_record_seal(&record);
	CHECK(pi_record_valid(&record));

	record.done = 5;
	CHECK(!pi_record_valid(&record));
	record.size = 10;
	pi_sha256_update(&record.hash, "hello", 5);
	pi_record_seal(&record);
	CHECK(pi_record_valid(&record));
	record.sha256[3] ^= 1;
	CHECK(!pi_record_valid(&record));
}

/* ---- the SD card's layer ------------------------------------------------------------------- */

static void test_the_card_layer(void)
{
	struct pi_sd_file f;
	uint8_t buf[16];
	uint32_t size;
	uint64_t free_bytes;
	bool exists;

	fresh_card(1 << 20);
	CHECK(pi_sd_check() == PI_OK);
	CHECK(pi_sd_mkdir(PI_SD_DIR) == PI_OK);

	CHECK(pi_sd_open(&f, PI_SD_IMAGE, true, false) == PI_ERR_SD_IO);
	CHECK(pi_sd_open(&f, PI_SD_IMAGE, true, true) == PI_OK);
	CHECK(pi_sd_write(&f, "0123456789", 10) == PI_OK);
	CHECK(pi_sd_read_at(&f, 3, buf, 4) == PI_OK && memcmp(buf, "3456", 4) == 0);
	/* Past the end is an error, not a short read. */
	CHECK(pi_sd_read_at(&f, 8, buf, 4) == PI_ERR_SD_IO);
	CHECK(pi_sd_truncate(&f, 6) == PI_OK);
	CHECK(pi_sd_seek(&f, 6) == PI_OK);
	CHECK(pi_sd_write(&f, "ab", 2) == PI_OK);
	CHECK(pi_sd_sync(&f) == PI_OK);
	CHECK(pi_sd_close(&f) == PI_OK);
	CHECK(pi_sd_close(&f) == PI_OK);
	CHECK(pi_sd_size(PI_SD_IMAGE, &size, &exists) == PI_OK && exists && size == 8);
	CHECK(pi_sd_size(PI_SD_TEMP, &size, &exists) == PI_OK && !exists && size == 0);
	CHECK(pi_sd_free(PI_SD_MOUNT, &free_bytes) == PI_OK);
	CHECK(free_bytes == ((1 << 20) - 8) / 512 * 512);
	CHECK(pi_sd_remove(PI_SD_IMAGE) == PI_OK);
	CHECK(pi_sd_remove(PI_SD_IMAGE) == PI_OK);
	CHECK(fs.opens == 0);

	/* After every operation the bus is let go, for the Pi. */
	CHECK(fs.releases > 10);

	/* Saved whole, and read back; a missing one, or one of another size, is no record. */
	CHECK(pi_sd_save(PI_SD_RECORD, PI_SD_TEMP, "record!", 7) == PI_OK);
	CHECK(pi_sd_load(PI_SD_RECORD, PI_SD_TEMP, buf, 7) == PI_OK);
	CHECK(memcmp(buf, "record!", 7) == 0);
	CHECK(pi_sd_load(PI_SD_RECORD, PI_SD_TEMP, buf, 8) == PI_ERR_SD_IO);
	CHECK(find(PI_SD_TEMP) < 0);
	/* A reset between the two steps of a save leaves the new copy under its temporary name. */
	CHECK(fs_rename(PI_SD_RECORD, PI_SD_TEMP) == 0);
	CHECK(pi_sd_load(PI_SD_RECORD, PI_SD_TEMP, buf, 7) == PI_OK);

	/* A write that fails once is written again. */
	CHECK(pi_sd_open(&f, PI_SD_IMAGE, true, true) == PI_OK);
	fs.fail_write_after = fs.written + 1;
	CHECK(pi_sd_write(&f, "xyz", 3) == PI_OK);
	CHECK(pi_sd_read_at(&f, 0, buf, 3) == PI_OK && memcmp(buf, "xyz", 3) == 0);

	/* A full card. */
	fs.volume = used_bytes() + 2;
	CHECK(pi_sd_seek(&f, 3) == PI_OK);
	CHECK(pi_sd_write(&f, "abcd", 4) == PI_ERR_SD_FULL);

	/* A slow one. */
	fs.op_ms = CONFIG_APP_PI_SD_TIMEOUT_MS + 1;
	CHECK(pi_sd_sync(&f) == PI_ERR_SD_TIMEOUT);
	fs.op_ms = 0;

	/* A card that is pulled out. */
	fs.card_in = false;
	CHECK(pi_sd_check() == PI_ERR_SD_ABSENT);
	CHECK(pi_sd_read_at(&f, 0, buf, 3) == PI_ERR_SD_ABSENT);
	CHECK(pi_sd_write(&f, "a", 1) == PI_ERR_SD_ABSENT);
	CHECK(pi_sd_open(&f, PI_SD_RECORD, false, false) == PI_ERR_SD_ABSENT);
	fs.card_in = true;
	CHECK(pi_sd_close(&f) == PI_OK);
	CHECK(pi_sd_write(&f, "a", 1) == PI_ERR_SD_IO);
}

/* ---- the download onto the card ----------------------------------------------------------- */

#define IMAGE_SIZE (5u * 1024u * 1024u + 12345u)

static void test_a_download_from_start_to_end(void)
{
	uint8_t *image = make_image(IMAGE_SIZE);
	struct pi_target job;
	static struct pi_dl dl;
	struct pi_record record;
	uint32_t from;
	bool complete;

	fresh_card(64u << 20);
	image_job(&job, image, IMAGE_SIZE);

	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK);
	CHECK(from == 0 && !complete);
	CHECK(serve(&dl, image, IMAGE_SIZE, 0, IMAGE_SIZE, 1400) == PI_OK);
	CHECK(pi_dl_finish(&dl) == PI_OK);
	CHECK(card_holds(image, IMAGE_SIZE));
	CHECK(fs.opens == 0);

	CHECK(pi_dl_load_record(&record) == PI_OK);
	CHECK(record.phase == PI_PHASE_DOWNLOADED && record.done == IMAGE_SIZE);
	CHECK(strcmp(record.job_id, job.id) == 0);

	/* The same image again, by another job: nothing to download. */
	strcpy(job.id, "pi-again");
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK);
	CHECK(complete && from == IMAGE_SIZE);

	/* The Pi has it: remembered, with the rest of the record intact. */
	CHECK(pi_dl_mark_installed(job.sha256, job.version) == PI_OK);
	CHECK(pi_dl_load_record(&record) == PI_OK);
	CHECK(memcmp(record.installed_sha256, job.sha256, 32) == 0);
	CHECK(strcmp(record.installed_version, "2026.11.06-1") == 0);
	CHECK(record.phase == PI_PHASE_DOWNLOADED);

	/* A new image keeps what the Pi has installed. */
	image[0] ^= 0xff;
	image_job(&job, image, IMAGE_SIZE);
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK && from == 0 && !complete);
	CHECK(pi_dl_load_record(&record) == PI_OK);
	CHECK(record.installed_version[0] != '\0');
	pi_dl_close(&dl);
	free(image);
}

static void test_a_lost_connection_goes_on_where_it_stopped(void)
{
	uint8_t *image = make_image(IMAGE_SIZE);
	struct pi_target job;
	static struct pi_dl dl;
	uint32_t from;
	bool complete;

	fresh_card(64u << 20);
	image_job(&job, image, IMAGE_SIZE);
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK);

	/* The connection drops twice, at odd places. */
	CHECK(serve(&dl, image, IMAGE_SIZE, 0, 1234567, 1400) == PI_OK);
	CHECK(pi_dl_resume_point(&dl, false, &from) == PI_OK);
	CHECK(from == 1234567);
	CHECK(serve(&dl, image, IMAGE_SIZE, from, 3000001, 1000) == PI_OK);
	CHECK(pi_dl_resume_point(&dl, false, &from) == PI_OK);
	CHECK(from == 3000001);
	CHECK(serve(&dl, image, IMAGE_SIZE, from, IMAGE_SIZE, 2048) == PI_OK);
	CHECK(pi_dl_finish(&dl) == PI_OK);
	CHECK(card_holds(image, IMAGE_SIZE));
	free(image);
}

static void test_a_card_that_failed_goes_back_to_the_checkpoint(void)
{
	uint8_t *image = make_image(IMAGE_SIZE);
	struct pi_target job;
	static struct pi_dl dl;
	uint32_t from;
	bool complete;

	fresh_card(64u << 20);
	image_job(&job, image, IMAGE_SIZE);
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK);

	/* Two writes in a row fail just after 2.5 MiB: no retry gets it through. */
	fs.fail_write_after = 2621440 + 100;
	fs.fail_writes = 2;
	CHECK(serve(&dl, image, IMAGE_SIZE, 0, IMAGE_SIZE, 1000) == PI_ERR_SD_IO);
	CHECK(dl.received > 2u * 1024u * 1024u && dl.received < 3u * 1024u * 1024u);
	CHECK(pi_dl_resume_point(&dl, true, &from) == PI_OK);
	/* Back to the last checkpoint, at 2 MiB. */
	CHECK(from == 2u * 1024u * 1024u);
	CHECK(serve(&dl, image, IMAGE_SIZE, from, IMAGE_SIZE, 1000) == PI_OK);
	CHECK(pi_dl_finish(&dl) == PI_OK);
	CHECK(card_holds(image, IMAGE_SIZE));
	free(image);
}

static void test_a_restart_goes_on_from_the_checkpoint(void)
{
	uint8_t *image = make_image(IMAGE_SIZE);
	struct pi_target job;
	static struct pi_dl dl;
	uint32_t from;
	bool complete;

	fresh_card(64u << 20);
	image_job(&job, image, IMAGE_SIZE);
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK);
	CHECK(serve(&dl, image, IMAGE_SIZE, 0, 3500000, 1400) == PI_OK);

	/* The board restarts: what is in RAM is gone, the card and its record stay. */
	memset(&dl, 0, sizeof(dl));
	fs.opens = 0;
	memset(fs.handles, 0, sizeof(fs.handles));

	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK);
	CHECK(!complete);
	CHECK(from == 3u * 1024u * 1024u);
	CHECK(serve(&dl, image, IMAGE_SIZE, from, IMAGE_SIZE, 1400) == PI_OK);
	CHECK(pi_dl_finish(&dl) == PI_OK);
	CHECK(card_holds(image, IMAGE_SIZE));

	/* A restart with a damaged record starts from nothing. */
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK && complete);
	fs.files[find(PI_SD_RECORD)].data[20] ^= 1;
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK);
	CHECK(!complete && from == 0);
	pi_dl_close(&dl);

	/* So does one whose image on the card is shorter than its checkpoint: another card. */
	CHECK(serve(&dl, image, IMAGE_SIZE, 0, 0, 1) == PI_OK);
	fresh_card(64u << 20);
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK);
	CHECK(serve(&dl, image, IMAGE_SIZE, 0, 2200000, 1400) == PI_OK);
	pi_dl_close(&dl);
	{
		int index = find(PI_SD_IMAGE);

		fs.files[index].size = 1000;
	}
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK);
	CHECK(from == 0);
	pi_dl_close(&dl);
	free(image);
}

static void test_a_wrong_image_is_thrown_away(void)
{
	uint8_t *image = make_image(IMAGE_SIZE);
	struct pi_target job;
	static struct pi_dl dl;
	struct pi_record record;
	uint32_t from;
	bool complete;

	fresh_card(64u << 20);
	image_job(&job, image, IMAGE_SIZE);
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK);

	/* A byte changed on the way: the digest does not match. */
	image[4000000] ^= 0x40;
	CHECK(serve(&dl, image, IMAGE_SIZE, 0, IMAGE_SIZE, 4096) == PI_OK);
	CHECK(pi_dl_finish(&dl) == PI_ERR_DIGEST_MISMATCH);
	CHECK(strcmp(pi_err_reason(PI_ERR_DIGEST_MISMATCH), "digest_mismatch") == 0);
	CHECK(find(PI_SD_IMAGE) < 0);
	CHECK(pi_dl_load_record(&record) == PI_OK && record.phase == PI_PHASE_NONE);

	/* The next attempt starts from nothing. */
	image[4000000] ^= 0x40;
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK && from == 0);

	/* Too short, or too long. */
	CHECK(serve(&dl, image, IMAGE_SIZE, 0, IMAGE_SIZE - 1, 4096) == PI_OK);
	CHECK(pi_dl_finish(&dl) == PI_ERR_SIZE_MISMATCH);
	CHECK(serve(&dl, image, IMAGE_SIZE, IMAGE_SIZE - 1, IMAGE_SIZE, 4096) == PI_OK);
	CHECK(pi_dl_write(&dl, "x", 1) == PI_ERR_SIZE_MISMATCH);
	CHECK(pi_dl_finish(&dl) == PI_OK);
	free(image);
}

static void test_no_room_and_no_card(void)
{
	uint8_t *image = make_image(IMAGE_SIZE);
	struct pi_target job;
	static struct pi_dl dl;
	uint32_t from;
	bool complete;

	/* Not enough room: nothing is downloaded. */
	fresh_card(IMAGE_SIZE);
	image_job(&job, image, IMAGE_SIZE);
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_ERR_SD_FULL);
	CHECK(strcmp(pi_err_reason(PI_ERR_SD_FULL), "sd_full") == 0);

	/* The room of an old image counts. */
	fresh_card(IMAGE_SIZE + PI_DL_FREE_MARGIN + 4096);
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK);
	CHECK(serve(&dl, image, IMAGE_SIZE, 0, IMAGE_SIZE, 4096) == PI_OK);
	CHECK(pi_dl_finish(&dl) == PI_OK);
	image[0] ^= 1;
	image_job(&job, image, IMAGE_SIZE);
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK);
	pi_dl_close(&dl);

	/* No card. */
	fresh_card(64u << 20);
	fs.card_in = false;
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_ERR_SD_ABSENT);
	CHECK(pi_dl_load_record(&(struct pi_record){ 0 }) == PI_ERR_SD_ABSENT);

	/* Pulled out in the middle. */
	fs.card_in = true;
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK);
	CHECK(serve(&dl, image, IMAGE_SIZE, 0, 100000, 4096) == PI_OK);
	fs.card_in = false;
	CHECK(serve(&dl, image, IMAGE_SIZE, 100000, IMAGE_SIZE, 4096) == PI_ERR_SD_ABSENT);
	CHECK(pi_dl_resume_point(&dl, true, &from) == PI_ERR_SD_ABSENT);
	pi_dl_close(&dl);
	free(image);
}

static void test_a_stopped_download_is_taken_up_again(void)
{
	uint8_t *image = make_image(IMAGE_SIZE);
	struct pi_target job;
	static struct pi_dl dl;
	uint32_t from;
	bool complete;

	fresh_card(64u << 20);
	image_job(&job, image, IMAGE_SIZE);
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK);
	CHECK(serve(&dl, image, IMAGE_SIZE, 0, 1500000, 4096) == PI_OK);

	/* The job is withdrawn: the file is closed, the checkpoint stays. */
	pi_dl_close(&dl);
	CHECK(fs.opens == 0);
	CHECK(pi_dl_write(&dl, image, 1) == PI_ERR_SD_IO);
	CHECK(pi_dl_finish(&dl) == PI_ERR_SD_IO);

	/* Deployed again, it goes on from there. */
	strcpy(job.id, "pi-second-try");
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK);
	CHECK(from == 1024u * 1024u);
	CHECK(serve(&dl, image, IMAGE_SIZE, from, IMAGE_SIZE, 4096) == PI_OK);
	CHECK(pi_dl_finish(&dl) == PI_OK);
	CHECK(card_holds(image, IMAGE_SIZE));

	/* Started again from nothing, when the downloader asks for that. */
	CHECK(pi_dl_begin(&dl, &job, &from, &complete) == PI_OK && complete);
	CHECK(pi_dl_reset(&dl) == PI_OK);
	CHECK(dl.received == 0 && find(PI_SD_IMAGE) >= 0 && fs.files[find(PI_SD_IMAGE)].size == 0);
	CHECK(serve(&dl, image, IMAGE_SIZE, 0, IMAGE_SIZE, 4096) == PI_OK);
	CHECK(pi_dl_finish(&dl) == PI_OK);
	CHECK(card_holds(image, IMAGE_SIZE));
	free(image);
}

int main(void)
{
	test_sha256_known_answers();
	test_crc32_is_zlibs();
	test_a_pi_image_document_is_read();
	test_a_bad_pi_image_document_is_refused();
	test_the_list_of_pending_jobs_names_the_firmware_job();
	test_the_manifest_is_the_one_tools_pi_image_py_signs();
	test_a_record_is_sealed();
	test_the_card_layer();
	test_a_download_from_start_to_end();
	test_a_lost_connection_goes_on_where_it_stopped();
	test_a_card_that_failed_goes_back_to_the_checkpoint();
	test_a_restart_goes_on_from_the_checkpoint();
	test_a_wrong_image_is_thrown_away();
	test_no_room_and_no_card();
	test_a_stopped_download_is_taken_up_again();

	fresh_card(0);
	printf("pi_ota: %d checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
