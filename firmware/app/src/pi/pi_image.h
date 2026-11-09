/*
 * A Raspberry Pi image for the Pi's partition B: what a job's manifest says, how it is
 * authenticated, the errors a Pi update reports, and the record of a download that is kept on
 * the SD card next to the image (docs/pi-ota.md).
 *
 * The manifest is the text that the signature covers. It is built here from the job's fields and
 * never sent: the job carries the fields and the signature, so a field changed on the way makes
 * the signature fail. tools/pi_image.py builds the same text to sign it:
 *
 *   cranium-pi-image-v1\n
 *   version=<version>\n
 *   size=<decimal bytes>\n
 *   sha256=<64 lowercase hex digits>\n
 *   min_firmware=<major.minor.revision+build, or none>\n
 *
 * The first line keeps the signature to this use: an MCUboot image signature is over a hash of an
 * image header, never over text that starts like this, and the reverse holds too. That is why one
 * key, the project's firmware signing key, can sign both (docs/pi-ota.md, "Signing").
 *
 * No hardware dependency: tested on the host.
 */

#ifndef PI_IMAGE_H_
#define PI_IMAGE_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ota_job.h"
#include "pi_sha256.h"

#define PI_MANIFEST_MAGIC "cranium-pi-image-v1"
/* Room for the longest manifest: a 31-character version, 10 digits of size, the longest version. */
#define PI_MANIFEST_MAX   256

/* The reasons a Pi update fails, as it reports them (pi_err_reason()). */
enum pi_err {
	PI_OK = 0,
	/* The job: refused before anything was downloaded. */
	PI_ERR_BAD_SIGNATURE,
	PI_ERR_TOO_LARGE,
	PI_ERR_ALREADY_INSTALLED,
	/* The job's minFirmware is newer than what the board runs. */
	PI_ERR_FIRMWARE_TOO_OLD,
	/* The SD card. */
	PI_ERR_SD_ABSENT,
	PI_ERR_SD_IO,
	PI_ERR_SD_FULL,
	PI_ERR_SD_TIMEOUT,
	/* The download. */
	PI_ERR_DOWNLOAD,
	PI_ERR_SIZE_MISMATCH,
	PI_ERR_DIGEST_MISMATCH,
	/* Sending to the Pi. */
	PI_ERR_SD_READBACK,
	PI_ERR_PI_NOT_READY,
	PI_ERR_PI_TIMEOUT,
	PI_ERR_PI_REJECTED,
	PI_ERR_PI_VERIFY,
	PI_ERR_LINK_IO,
	/* The job was withdrawn, or a person stopped it. */
	PI_ERR_ABORTED,
	PI_ERR_COUNT,
};

/* Short machine-readable reason, for the job's statusDetails and the shadow. */
const char *pi_err_reason(enum pi_err err);

/* What a download and a transfer need of a Pi job: small, where struct ota_job holds its URL too. */
struct pi_target {
	char id[OTA_JOB_ID_MAX + 1];
	char version[OTA_PI_VERSION_MAX + 1];
	uint32_t size;
	uint8_t sha256[PI_SHA256_SIZE];
};

void pi_target_from_job(struct pi_target *target, const struct ota_job *job);

/* The manifest text for a Pi job's fields. Returns its length, or -1 if out is too small. */
int pi_manifest_text(const struct ota_job *job, char *out, size_t out_size);

/* Verify an ECDSA P-256 signature (r||s) over msg with the built-in public key: 0 if it holds. */
typedef int (*pi_verify_fn)(const uint8_t *msg, size_t len, const uint8_t sig[OTA_PI_SIG_SIZE]);

/*
 * Whether a parsed Pi job may start: a signature that holds over its manifest, its size within
 * max_size, a minFirmware that the running firmware meets, and not the image the Pi already got
 * (installed_sha256, or NULL if none is known).
 */
enum pi_err pi_job_check(const struct ota_job *job, uint32_t max_size,
			 const struct fw_version *running, const uint8_t *installed_sha256,
			 pi_verify_fn verify);

/* What the record on the SD card says of the image file next to it. */
enum pi_phase {
	PI_PHASE_NONE = 0,
	/* Being downloaded: `done` bytes of it are on the card and hashed into `hash`. */
	PI_PHASE_DOWNLOADING = 1,
	/* All of it is on the card and its digest matched. */
	PI_PHASE_DOWNLOADED = 2,
};

#define PI_RECORD_MAGIC   0x52504943u /* "CIPR" */
#define PI_RECORD_VERSION 1

/* Kept on the SD card, so that a download continues after a restart or a lost connection. */
struct pi_record {
	uint32_t magic;
	uint32_t format;
	uint32_t phase;
	char job_id[OTA_JOB_ID_MAX + 1];
	char version[OTA_PI_VERSION_MAX + 1];
	uint32_t size;
	uint8_t sha256[PI_SHA256_SIZE];
	/* Bytes of the image on the card that the last checkpoint vouches for. */
	uint32_t done;
	/* The hash over those bytes. */
	struct pi_sha256 hash;
	/* The last image that the Pi verified: its digest and version. All zero if none. */
	uint8_t installed_sha256[PI_SHA256_SIZE];
	char installed_version[OTA_PI_VERSION_MAX + 1];
	/* CRC-32 of everything above. */
	uint32_t crc;
};

/* Seal a record: set its magic, format and CRC. */
void pi_record_seal(struct pi_record *record);
/* True if a record read back is whole and of this format. */
bool pi_record_valid(const struct pi_record *record);

/* CRC-32 (IEEE 802.3, the one zlib.crc32 computes), continued from crc (0 to start). */
uint32_t pi_crc32(uint32_t crc, const void *data, size_t len);

#endif /* PI_IMAGE_H_ */
