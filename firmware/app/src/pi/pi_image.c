#include "pi_image.h"

#include <stdio.h>
#include <string.h>

static const char *const reasons[PI_ERR_COUNT] = {
	[PI_OK] = "ok",
	[PI_ERR_BAD_SIGNATURE] = "bad_signature",
	[PI_ERR_TOO_LARGE] = "too_large",
	[PI_ERR_ALREADY_INSTALLED] = "already_installed",
	[PI_ERR_FIRMWARE_TOO_OLD] = "firmware_too_old",
	[PI_ERR_SD_ABSENT] = "sd_absent",
	[PI_ERR_SD_IO] = "sd_io",
	[PI_ERR_SD_FULL] = "sd_full",
	[PI_ERR_SD_TIMEOUT] = "sd_timeout",
	[PI_ERR_DOWNLOAD] = "download_failed",
	[PI_ERR_SIZE_MISMATCH] = "size_mismatch",
	[PI_ERR_DIGEST_MISMATCH] = "digest_mismatch",
	[PI_ERR_SD_READBACK] = "sd_readback_mismatch",
	[PI_ERR_PI_NOT_READY] = "pi_not_ready",
	[PI_ERR_PI_TIMEOUT] = "pi_timeout",
	[PI_ERR_PI_REJECTED] = "pi_rejected",
	[PI_ERR_PI_VERIFY] = "pi_verify_failed",
	[PI_ERR_LINK_IO] = "link_io",
	[PI_ERR_ABORTED] = "aborted",
};

const char *pi_err_reason(enum pi_err err)
{
	if ((unsigned int)err >= PI_ERR_COUNT) {
		return "unknown";
	}

	return reasons[err];
}

void pi_target_from_job(struct pi_target *target, const struct ota_job *job)
{
	memset(target, 0, sizeof(*target));
	memcpy(target->id, job->id, sizeof(target->id));
	memcpy(target->version, job->pi_version, sizeof(target->version));
	target->size = job->pi_size;
	memcpy(target->sha256, job->pi_sha256, PI_SHA256_SIZE);
}

int pi_manifest_text(const struct ota_job *job, char *out, size_t out_size)
{
	char hex[2 * PI_SHA256_SIZE + 1];
	char minimum[FW_VERSION_STRING_MAX] = "none";
	int written;

	for (size_t i = 0; i < PI_SHA256_SIZE; i++) {
		static const char digits[] = "0123456789abcdef";

		hex[2 * i] = digits[job->pi_sha256[i] >> 4];
		hex[2 * i + 1] = digits[job->pi_sha256[i] & 0x0f];
	}
	hex[sizeof(hex) - 1] = '\0';

	if (job->pi_has_min_firmware &&
	    fw_version_to_string(&job->pi_min_firmware, minimum, sizeof(minimum)) != 0) {
		return -1;
	}

	written = snprintf(out, out_size, "%s\nversion=%s\nsize=%lu\nsha256=%s\nmin_firmware=%s\n",
			   PI_MANIFEST_MAGIC, job->pi_version, (unsigned long)job->pi_size, hex,
			   minimum);
	if (written < 0 || (size_t)written >= out_size) {
		return -1;
	}

	return written;
}

enum pi_err pi_job_check(const struct ota_job *job, uint32_t max_size,
			 const struct fw_version *running, const uint8_t *installed_sha256,
			 pi_verify_fn verify)
{
	char manifest[PI_MANIFEST_MAX];
	int length;

	if ((job->kind != OTA_JOB_KIND_PI_IMAGE && job->kind != OTA_JOB_KIND_BUNDLE) ||
	    verify == NULL) {
		return PI_ERR_BAD_SIGNATURE;
	}

	/* The signature first: nothing else about an unauthenticated job is worth an answer. */
	length = pi_manifest_text(job, manifest, sizeof(manifest));
	if (length < 0 || verify((const uint8_t *)manifest, (size_t)length, job->pi_sig) != 0) {
		return PI_ERR_BAD_SIGNATURE;
	}

	if (job->pi_size > max_size) {
		return PI_ERR_TOO_LARGE;
	}

	if (job->pi_has_min_firmware && fw_version_compare(running, &job->pi_min_firmware) < 0) {
		return PI_ERR_FIRMWARE_TOO_OLD;
	}

	if (installed_sha256 != NULL &&
	    memcmp(installed_sha256, job->pi_sha256, PI_SHA256_SIZE) == 0) {
		return PI_ERR_ALREADY_INSTALLED;
	}

	return PI_OK;
}

uint32_t pi_image_crc32(uint32_t crc, const void *data, size_t len)
{
	/* Four bits at a time: a table of 16 words, fast enough for frames of 16 KiB. */
	static const uint32_t table[16] = {
		0x00000000, 0x1db71064, 0x3b6e20c8, 0x26d930ac, 0x76dc4190, 0x6b6b51f4,
		0x4db26158, 0x5005713c, 0xedb88320, 0xf00f9344, 0xd6d6a3e8, 0xcb61b38c,
		0x9b64c2b0, 0x86d3d2d4, 0xa00ae278, 0xbdbdf21c,
	};
	const uint8_t *bytes = data;

	crc = ~crc;
	for (size_t i = 0; i < len; i++) {
		crc = table[(crc ^ bytes[i]) & 0x0f] ^ (crc >> 4);
		crc = table[(crc ^ (bytes[i] >> 4)) & 0x0f] ^ (crc >> 4);
	}

	return ~crc;
}

void pi_record_seal(struct pi_record *record)
{
	record->magic = PI_RECORD_MAGIC;
	record->format = PI_RECORD_VERSION;
	record->crc = pi_image_crc32(0, record, offsetof(struct pi_record, crc));
}

bool pi_record_valid(const struct pi_record *record)
{
	return record->magic == PI_RECORD_MAGIC && record->format == PI_RECORD_VERSION &&
	       record->crc == pi_image_crc32(0, record, offsetof(struct pi_record, crc)) &&
	       record->job_id[OTA_JOB_ID_MAX] == '\0' && record->version[OTA_PI_VERSION_MAX] == '\0' &&
	       record->installed_version[OTA_PI_VERSION_MAX] == '\0' &&
	       record->done <= record->size && record->hash.length == record->done &&
	       record->hash.used == record->done % 64;
}
