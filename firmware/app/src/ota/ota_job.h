/*
 * Parsing and checking of firmware-update job documents.
 *
 * Everything in a job message is input from outside the device. This module has no
 * side effects and no hardware dependencies, so it can be tested on a host.
 *
 * Job document format:
 *
 *   {
 *     "op": "fw_update",
 *     "v": 1,
 *     "fw": {
 *       "version": "1.2.0+7",
 *       "size": 712345,
 *       "sha256": "<64 hex digits>",
 *       "url": "https://<host>/<path>?<query>"
 *     }
 *   }
 *
 * From 1.20.0 a job can carry a Raspberry Pi image instead (docs/pi-ota.md):
 *
 *   {
 *     "op": "pi_image",
 *     "v": 1,
 *     "pi": {
 *       "version": "2026.11.06-1",
 *       "size": 104857600,
 *       "sha256": "<64 hex digits>",
 *       "sig": "<128 hex digits: ECDSA P-256 r||s over the manifest, pi_image.h>",
 *       "url": "https://<host>/<path>?<query>"
 *     }
 *   }
 *
 * From 1.20.0 a job can carry both, for a board and its Pi updated together (docs/pi-ota.md,
 * "Both at once"): "op": "fw_pi_update", with "fw" as in a firmware job and "pi" as in a Pi image's.
 * Both parts are checked, but only one download URL is kept, the one of the part that is being
 * downloaded (ota_job_parse_part()): a second would double what every copy of the job takes in RAM.
 *
 * A Pi build (CONFIG_APP_PI_OTA) parses all three. Any other build parses firmware jobs only and
 * returns OTA_JOB_UNSUPPORTED for the other two, which the board refuses as "unsupported".
 */

#ifndef OTA_JOB_H_
#define OTA_JOB_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "version.h"

#define OTA_JOB_ID_MAX   64
#define OTA_SHA256_SIZE  32
/* "https://" and a host name of up to 255 characters. */
#define OTA_JOB_HOST_MAX 263
/* Path and query string: the limit of the HTTP download client. */
#define OTA_JOB_FILE_MAX 2047
/* A Pi image's version: letters, digits and ".-_+", 1 to 31 of them. */
#define OTA_PI_VERSION_MAX 31
/* The manifest's signature: ECDSA P-256, r and s of 32 bytes each. */
#define OTA_PI_SIG_SIZE    64

enum ota_job_kind {
	/* "fw_update": an image for this board's MCUboot slot. */
	OTA_JOB_KIND_FIRMWARE = 0,
	/* "pi_image": an image for the Raspberry Pi's partition B, through the SD card. */
	OTA_JOB_KIND_PI_IMAGE = 1,
	/*
	 * "fw_pi_update": board firmware and a Pi image in one job. Both are downloaded first, then the
	 * firmware is installed, and the Pi gets its image once that firmware is confirmed (ota.c).
	 */
	OTA_JOB_KIND_BUNDLE = 2,
};

/* Which part's download URL ota_job_parse_part() keeps in host and file. */
enum ota_job_part {
	OTA_JOB_PART_FIRMWARE = 0,
	OTA_JOB_PART_PI = 1,
};

struct ota_job {
	char id[OTA_JOB_ID_MAX + 1];
	/* The cloud lists this execution as in progress; otherwise it is still queued. */
	bool in_progress;
	/* enum ota_job_kind, in a byte: it sits in what was padding, so the record is no larger. */
	uint8_t kind;
	/* A firmware job's version; all zero for a Pi image. */
	struct fw_version version;
	/* The firmware's size and digest; for a job with a Pi image only, the image's (as pi_size). */
	uint32_t size;
	uint8_t sha256[OTA_SHA256_SIZE];
	/* "https://" followed by the host name. */
	char host[OTA_JOB_HOST_MAX + 1];
	/* Everything after the slash that follows the host name. */
	char file[OTA_JOB_FILE_MAX + 1];
#if defined(CONFIG_APP_PI_OTA)
	/*
	 * A Pi image's version, size, digest and the signature over its manifest. Empty for firmware.
	 * Only in a Pi build: any other build answers a job with a Pi image as unsupported from its
	 * "op" alone, so it keeps none of this in RAM.
	 */
	char pi_version[OTA_PI_VERSION_MAX + 1];
	uint32_t pi_size;
	uint8_t pi_sha256[OTA_SHA256_SIZE];
	uint8_t pi_sig[OTA_PI_SIG_SIZE];
	/* A Pi image's optional "minFirmware": the oldest board firmware it may go out with. */
	bool pi_has_min_firmware;
	struct fw_version pi_min_firmware;
#endif
};

/*
 * How a job's ID says what it is, for the list of pending jobs, which carries no documents: the
 * console's firmware jobs start with "cranium-", and a Pi image's with this (tools/pi_image.py).
 */
#define OTA_PI_JOB_ID_PREFIX "pi-"

enum ota_job_result {
	OTA_JOB_OK = 0,
	/* The message carries no job execution: nothing is pending. */
	OTA_JOB_NONE,
	/* Not usable and not attributable to a job, so it cannot even be refused. */
	OTA_JOB_MALFORMED,
	/* The job is identified (job->id is valid) but its document is not acceptable. */
	OTA_JOB_BAD_DOCUMENT,
	OTA_JOB_UNSUPPORTED,
	OTA_JOB_URL_NOT_ALLOWED,
	OTA_JOB_NOT_NEWER,
	OTA_JOB_TOO_LARGE,
};

/*
 * Parse the reply to a request for the next job execution.
 *
 * allowed_url_prefix is the only place firmware may be downloaded from; it must start
 * with "https://" and contain the complete host name followed by a slash.
 *
 * On OTA_JOB_OK every field of job is valid. On OTA_JOB_BAD_DOCUMENT,
 * OTA_JOB_UNSUPPORTED and OTA_JOB_URL_NOT_ALLOWED only job->id and job->in_progress
 * are valid.
 */
enum ota_job_result ota_job_parse(const char *json, size_t len, const char *allowed_url_prefix,
				  struct ota_job *job);

/*
 * The same, keeping the URL of `part` for a job that carries both (OTA_JOB_KIND_BUNDLE). Both URLs
 * have to pass. For any other job, part makes no difference. ota_job_parse() keeps the firmware's.
 */
enum ota_job_result ota_job_parse_part(const char *json, size_t len, const char *allowed_url_prefix,
				       enum ota_job_part part, struct ota_job *job);

/*
 * Parse the reply to a request for the list of pending job executions (GetPendingJobExecutions):
 * {"inProgressJobs":[{"jobId":...},...],"queuedJobs":[...]}. It carries no documents. On OTA_JOB_OK
 * job->id is the first job that is not a Pi image's, by its ID, in progress before queued, and
 * job->in_progress says which; OTA_JOB_NONE if there is no such job. Nothing else of job is set.
 */
enum ota_job_result ota_job_list_parse(const char *json, size_t len, struct ota_job *job);

/*
 * Policy for a parsed job: it must be strictly newer than the running firmware and
 * fit in the image slot. For a job with a Pi image too, this is the firmware's part only.
 */
enum ota_job_result ota_job_check(const struct ota_job *job, const struct fw_version *running,
				  size_t slot_size);

/* Short machine-readable reason, used in the status sent back to the cloud. */
const char *ota_job_result_reason(enum ota_job_result result);

/* What a stored record of an update means, once the device has restarted. */
enum ota_restart_outcome {
	/* The target runs and has yet to prove itself. */
	OTA_RESTART_ON_TRIAL,
	/* The target runs and was confirmed earlier: the report did not get out. */
	OTA_RESTART_CONFIRMED,
	/* The target runs with no trailer, so with nothing to revert to, and nothing proved it. */
	OTA_RESTART_TRIAL_LOST,
	/* Another image runs, and the target had started: the bootloader went back. */
	OTA_RESTART_ROLLED_BACK,
	/* Another image runs, and the target never started. */
	OTA_RESTART_NOT_INSTALLED,
};

/*
 * running_target: the running version is the one in the record. on_trial: the bootloader will
 * revert this image unless it is confirmed. has_trailer: the primary slot has a trailer, which a
 * swap always leaves, so a confirmed update has one. An image with none got there another way,
 * for example a golden image restore that was cut off just after it erased the trailer.
 * was_testing: the record says that the target has started.
 */
enum ota_restart_outcome ota_restart_outcome(bool running_target, bool on_trial, bool has_trailer,
					     bool was_testing);

#endif /* OTA_JOB_H_ */
