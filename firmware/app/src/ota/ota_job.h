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
 * or, from 1.19.3, a golden image promotion (src/ota/golden_promote.c), whose record is the
 * 130 bytes of sysbuild/mcuboot/golden/src/golden_record.h in lower-case hex:
 *
 *   { "op": "golden_promote", "v": 1, "record": "<260 hex digits>" }
 *
 * or, from 1.20.0 in a build for a board wired to a Raspberry Pi (CONFIG_APP_PI_DELTA), a delta
 * update of the Pi's image (docs/pi-delta-update.md, src/pi/pi_delta_ota.c). The URL is the
 * package that tools/pi_image.py builds: the signed manifest, its table and the image, which the
 * board fetches in ranges. Version and digest have to match what the signed manifest says:
 *
 *   { "op": "pi_delta", "v": 1,
 *     "pi": { "version": "2026.11.24-1", "sha256": "<64 hex digits: the whole image>",
 *             "url": "https://<host>/<path>?<query>" } }
 *
 * Any other build answers that "op" as unsupported, as it always has an "op" it does not know.
 *
 * or, from 1.20.2 in a Pi build, an update of the Pi's own system with its A/B slots and tryboot
 * (docs/pi-os-update.md, src/pi/pi_os.c): one file that cranium_ota.py made, downloaded whole and
 * offered to the Pi. "from" is the Pi version the file updates from, or null for a full image:
 *
 *   { "op": "pi_os", "v": 1,
 *     "pi": { "version": "1.1.0", "from": "1.0.0", "size": 4194304,
 *             "sha256": "<64 hex digits: the file>", "url": "https://<host>/<path>?<query>" } }
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
/* GOLDEN_RECORD_SIZE: golden_promote.c checks that they agree. */
#define OTA_GOLDEN_RECORD_SIZE 130
/* A Pi image's version: 1 to 31 of A-Z a-z 0-9 . _ + - (PI_VERSION_MAX in src/pi/pi_delta_fmt.h). */
#define OTA_PI_VERSION_MAX 31

struct ota_job {
	char id[OTA_JOB_ID_MAX + 1];
	/* The cloud lists this execution as in progress; otherwise it is still queued. */
	bool in_progress;
	struct fw_version version;
	uint32_t size;
	uint8_t sha256[OTA_SHA256_SIZE];
	/* "https://" followed by the host name. */
	char host[OTA_JOB_HOST_MAX + 1];
	/* A golden image promotion: only id, in_progress and golden_record are valid. */
	bool golden;
#if defined(CONFIG_APP_PI_DELTA)
	/*
	 * A Raspberry Pi delta update: id, in_progress, sha256 (the image's), host, file and
	 * pi_version are valid. Only in a Pi build, so that no other build keeps it in RAM.
	 */
	bool pi_delta;
	/*
	 * From 1.20.2, a Raspberry Pi OS update: id, in_progress, size, sha256 (the file's), host,
	 * file, pi_version and pi_from (zeros for a full image) are valid.
	 */
	bool pi_os;
	char pi_version[OTA_PI_VERSION_MAX + 1];
	char pi_from[OTA_PI_VERSION_MAX + 1];
#endif
	/* A promotion has no download, so its record takes the place of the URL's path: no RAM more. */
	union {
		/* Everything after the slash that follows the host name. */
		char file[OTA_JOB_FILE_MAX + 1];
		uint8_t golden_record[OTA_GOLDEN_RECORD_SIZE];
	};
};

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
 * Policy for a parsed job: it must be strictly newer than the running firmware and
 * fit in the image slot.
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
