#include "golden_promote.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/flash.h>
#include <zephyr/dfu/mcuboot.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "app_events.h"
#include "cloud.h"
#include "golden_job_policy.h"
#include "golden_record.h"
#include "mflt.h"
#include "version.h"

LOG_MODULE_REGISTER(golden, CONFIG_APP_LOG_LEVEL);

BUILD_ASSERT(OTA_GOLDEN_RECORD_SIZE == GOLDEN_RECORD_SIZE, "ota_job.h and golden_record.h disagree");

/* The external flash that holds the secondary slot, the golden image and these two sectors. */
#define EXT_FLASH DT_CHOSEN(nordic_pm_ext_flash)

/* After the record is handed over: this long idle, so that the job's update gets out first. */
#define RESTART_IDLE_SECONDS 10

static const struct device *const ext = DEVICE_DT_GET(EXT_FLASH);

static struct {
	/* Handed over in this boot, for this job: the restart is due. */
	bool handed_over;
	int idle_seconds;
	/* For the report. */
	bool info_present;
	struct golden_pin info;
	bool request_present;
	enum golden_status request_status;
} golden;

static int read_record(uint32_t offset, struct golden_record *record, uint8_t *bytes)
{
	if (!device_is_ready(ext)) {
		return -ENODEV;
	}

	if (flash_read(ext, offset, bytes, GOLDEN_RECORD_SIZE) != 0) {
		return -EIO;
	}

	return golden_record_parse(bytes, GOLDEN_RECORD_SIZE, record) ? 0 : -ENOENT;
}

static enum golden_status read_status(void)
{
	uint32_t word;

	if (flash_read(ext, GOLDEN_REQUEST_OFFSET + GOLDEN_STATUS_OFFSET, &word, sizeof(word)) != 0) {
		return GOLDEN_STATUS_UNKNOWN;
	}

	return golden_status_from_word(word);
}

/* What the two sectors say now. *request_bytes gets the request sector's record, if any. */
static void refresh(uint8_t request_bytes[GOLDEN_RECORD_SIZE])
{
	struct golden_record record;

	/* The info sector's bytes are not kept: they go where the request's will be. */
	golden.info_present = read_record(GOLDEN_INFO_OFFSET, &record, request_bytes) == 0;
	if (golden.info_present) {
		golden.info = record.pin;
	}

	golden.request_present = read_record(GOLDEN_REQUEST_OFFSET, &record, request_bytes) == 0;
	golden.request_status =
		golden.request_present ? read_status() : GOLDEN_STATUS_PENDING;
}

static int request_erase(void)
{
	return flash_erase(ext, GOLDEN_REQUEST_OFFSET, GOLDEN_EXT_SECTOR);
}

static void job_report(const char *job_id, const char *status, const char *reason)
{
	char body[200];
	int written;

	if (reason[0] == '\0') {
		written = snprintf(body, sizeof(body),
				   "{\"status\":\"%s\",\"statusDetails\":{\"running\":\"%s\"}}", status,
				   fw_version_running_string());
	} else {
		written = snprintf(body, sizeof(body),
				   "{\"status\":\"%s\",\"statusDetails\":{\"reason\":\"%s\","
				   "\"running\":\"%s\"}}",
				   status, reason, fw_version_running_string());
	}

	if (written > 0 && written < (int)sizeof(body)) {
		(void)cloud_jobs_update(job_id, body);
	}
}

void golden_promote_init(void)
{
	uint8_t bytes[GOLDEN_RECORD_SIZE];

	refresh(bytes);
	if (golden.info_present) {
		LOG_INF("Golden image %u.%u.%u+%u, counter %u", golden.info.version.major,
			golden.info.version.minor, golden.info.version.revision,
			golden.info.version.build, golden.info.counter);
	}
}

void golden_promote_on_job(const struct ota_job *job)
{
	/* On the main loop's stack, as everything here: no RAM of its own. */
	uint8_t request[GOLDEN_RECORD_SIZE];
	struct golden_record record;
	struct golden_job_view view;
	const struct fw_version *running = fw_version_running();
	enum golden_job_action action;
	const char *reason;

	if (golden.handed_over) {
		/* The restart is due: nothing else starts, and this job is answered after it. */
		return;
	}

	if (!golden_record_parse(job->golden_record, sizeof(job->golden_record), &record)) {
		job_report(job->id, job->in_progress ? "FAILED" : "REJECTED", "bad_record");
		return;
	}

	refresh(request);
	memset(&view, 0, sizeof(view));
	view.record = &record;
	view.info_present = golden.info_present;
	view.info = golden.info;
	view.request_is_this = golden.request_present &&
			       memcmp(request, job->golden_record, GOLDEN_RECORD_SIZE) == 0;
	view.request_status = golden.request_status;
	view.handed_over = false;
	view.running.major = running->major;
	view.running.minor = running->minor;
	view.running.revision = running->revision;
	view.running.build = running->build;
	view.running_confirmed = boot_is_img_confirmed();

	action = golden_job_decide(&view, &reason);
	switch (action) {
	case GOLDEN_JOB_SUCCEEDED:
		LOG_INF("Golden image promotion %s: sealed", job->id);
		job_report(job->id, "SUCCEEDED", "");
		break;
	case GOLDEN_JOB_FAILED:
		LOG_WRN("Golden image promotion %s failed: %s", job->id, reason);
		if (strcmp(reason, "bootloader_unsupported") == 0) {
			/* A later bootloader must not find it and act on a job long closed. */
			(void)request_erase();
			refresh(request);
		}
		job_report(job->id, "FAILED", reason);
		break;
	case GOLDEN_JOB_REFUSE:
		LOG_WRN("Golden image promotion %s refused: %s", job->id, reason);
		job_report(job->id, job->in_progress ? "FAILED" : "REJECTED", reason);
		break;
	case GOLDEN_JOB_START:
		if (request_erase() != 0 ||
		    flash_write(ext, GOLDEN_REQUEST_OFFSET, job->golden_record, GOLDEN_RECORD_SIZE) != 0) {
			job_report(job->id, job->in_progress ? "FAILED" : "REJECTED", "flash_error");
			break;
		}
		LOG_INF("Golden image promotion %s handed to the bootloader: restarting when idle",
			job->id);
		job_report(job->id, "IN_PROGRESS", "");
		golden.handed_over = true;
		golden.idle_seconds = 0;
		refresh(request);
		break;
	default:
		break;
	}
}

void golden_promote_on_tick(bool idle)
{
	if (!golden.handed_over) {
		return;
	}

	golden.idle_seconds = idle ? golden.idle_seconds + 1 : 0;
	if (golden.idle_seconds >= RESTART_IDLE_SECONDS) {
		LOG_INF("Restarting for the bootloader to seal the golden image");
		app_restart(MFLT_REBOOT_UPDATE);
	}
}

bool golden_promote_busy(void)
{
	return golden.handed_over;
}

int golden_promote_report(char *buf, size_t len)
{
	char version[32] = "null";
	const char *state = "none";
	int written;

	if (golden.info_present) {
		(void)snprintf(version, sizeof(version), "\"%u.%u.%u+%u\"", golden.info.version.major,
			       golden.info.version.minor, golden.info.version.revision,
			       golden.info.version.build);
	}

	if (golden.request_present) {
		state = golden_status_name(golden.request_status);
	}

	written = snprintf(buf, len, "\"golden\":{\"version\":%s,\"counter\":%u,\"state\":\"%s\"}",
			   version, golden.info_present ? golden.info.counter : 0U, state);
	return (written < 0 || (size_t)written >= len) ? -ENOSPC : written;
}
