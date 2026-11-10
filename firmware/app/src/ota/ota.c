#include "ota.h"

#include <errno.h>
#include <stdarg.h>
#include <string.h>

#include <net/fota_download.h>
#include <psa/crypto.h>
#include <zephyr/dfu/mcuboot.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/logging/log_ctrl.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/reboot.h>

#if defined(CONFIG_APP_BT_OTA)
#include "bt_ota.h"
#endif
#include "identity.h"
#include "health.h"
#include "image_compat.h"
#include "mflt.h"
#include "ota_job.h"
#if defined(CONFIG_APP_PI_OTA)
#include "pi_ota.h"
#endif
#include "store.h"
#include "version.h"

LOG_MODULE_REGISTER(ota, CONFIG_APP_LOG_LEVEL);

#define SECONDARY_SLOT_ID   PARTITION_ID(slot1_partition)
#define SECONDARY_SLOT_SIZE PARTITION_SIZE(slot1_partition)

#define REFRESH_TIMEOUT_SECONDS 20
#define ACK_TIMEOUT_SECONDS     20
/*
 * AWS IoT applies a forced cancellation a few seconds after it is requested (5 to 15
 * were measured), and until then it still accepts this device's announcements. So
 * the device does not restart as soon as the installation is accepted: it waits this
 * long, asks once more, and restarts only if the job is still listed as in progress.
 */
#define SETTLE_SECONDS          20
/* The wait before another download attempt: this many seconds per attempt so far. */
#define RETRY_WAIT_SECONDS      10
#define REPORT_RETRY_SECONDS    30
#define PROGRESS_STEP_PERCENT   10
#define HASH_CHUNK_SIZE         1024

#define RECORD_MAGIC 0x4f544132 /* "OTA2" */

/* BOOT_MAGIC_SZ in MCUboot, at the end of a slot, and what erased internal flash reads as. */
#define TRAILER_MAGIC_SIZE 16
#define TRAILER_ERASED     0xff

enum record_phase {
	/* The trial swap was requested and the device was about to restart. */
	RECORD_ARMED = 1,
	/* The new image has started at least once. */
	RECORD_TESTING = 2,
};

/* How far the Pi part of a job with both has got (ota_record.pi_step). */
enum record_pi_step {
	RECORD_PI_NONE = 0,
	/* On the SD card and checked, before the firmware was handed to the bootloader. */
	RECORD_PI_STAGED = 1,
	/* The firmware is confirmed and the Pi is being sent its image. */
	RECORD_PI_FLASHING = 2,
	/* The Pi verified the image. */
	RECORD_PI_DONE = 3,
	/* The Pi part failed: the low bits are the enum pi_err. */
	RECORD_PI_FAILED = 0x40,
};

/*
 * Survives the restart, so that the outcome can be reported whichever image runs. with_pi and
 * pi_step (1.20.0) sit where the padding after job_id was, which older firmware always wrote as
 * zero, so the record keeps its size and an older image still reads it after a rollback.
 */
struct ota_record {
	uint32_t magic;
	uint8_t phase;
	char job_id[OTA_JOB_ID_MAX + 1];
	/* The job brings a Pi image too, which goes to the Pi once this firmware is confirmed. */
	uint8_t with_pi;
	uint8_t pi_step;
	struct fw_version target;
};

_Static_assert(sizeof(struct ota_record) == 80, "the record's size is fixed: older images read it");

enum final_report {
	REPORT_NONE,
	REPORT_SUCCEEDED,
	REPORT_FAILED,
};

/* First letter of the token on a job update whose reply is waited for. */
#define TOKEN_NONE   '\0'
#define TOKEN_START  's'
#define TOKEN_COMMIT 'c'
#define TOKEN_REPORT 'r'

static struct {
	enum ota_state state;
	int seconds_in_state;

	/* The job being started (or offered), downloaded or installed. */
	struct ota_job job;
	/* The cloud has accepted that this device is working on the job. */
	bool started;
	/* Waiting for the answer to the last look at the job before restarting. */
	bool last_look;
	/* A job this device has just closed. Replies that were already on their way
	 * may still list it; they must not bring it back.
	 */
	char closed_job_id[OTA_JOB_ID_MAX + 1];
	uint8_t download_attempts;
	int progress;

	/* Number of the last job update that was sent with a token. */
	uint16_t sequence;
	uint16_t start_sequence;
	uint16_t commit_sequence;
	uint16_t report_sequence;

	/* An update that was started before the last restart. */
	struct ota_record record;
	bool have_record;
	enum final_report report;
	const char *report_reason;
	int seconds_since_report;

	char last_result[12];
	char last_error[24];
	bool changed;

	/* The job carries a Pi image that goes after its firmware (OTA_JOB_KIND_BUNDLE). */
	bool with_pi;
	/* The record says the Pi still has to get its image: at the next connection. */
	bool resume_pi;

#if defined(CONFIG_APP_BT_OTA)
	/* The cloud update that this boot found installed, or on trial: for the Bluetooth status. */
	struct fw_version installed;
	enum bt_status_outcome installed_outcome;
#endif
} ota;

/* See ota_stuck_progress(). The downloader's thread adds to it as well. */
static atomic_t stuck_progress;

#if defined(CONFIG_APP_PI_OTA)
/*
 * The order of a firmware update and a Pi image (docs/pi-ota.md, "Order"). AWS IoT hands out the
 * oldest pending job first, whatever it is, so before a Pi image starts the board asks for the list
 * of pending jobs. A firmware job in it goes first: the board marks it in progress, which puts it
 * at the head of the list, and the Pi image stays queued until the firmware is done.
 */
static struct {
	/* The Pi image job that the list was asked for. */
	char asked[OTA_JOB_ID_MAX + 1];
	int seconds_asked;
	/* The list had no firmware job before this Pi image: it may start when it is next. */
	char cleared[OTA_JOB_ID_MAX + 1];
	/* The firmware job that was moved ahead of a Pi image: in progress, but not started. */
	char promoted[OTA_JOB_ID_MAX + 1];
} order;
#endif

static const char *const state_names[] = {
	[OTA_IDLE] = "idle",
	[OTA_AWAITING_USER] = "awaiting_user",
	[OTA_RETRY_WAIT] = "downloading",
	[OTA_REFRESHING] = "downloading",
	[OTA_STARTING] = "downloading",
	[OTA_DOWNLOADING] = "downloading",
	[OTA_VERIFYING] = "verifying",
	[OTA_COMMITTING] = "verifying",
	[OTA_REBOOTING] = "rebooting",
	[OTA_TESTING] = "testing",
	[OTA_STAGING_PI] = "downloading_pi",
	[OTA_FLASHING_PI] = "flashing_pi",
#if defined(CONFIG_APP_BT_OTA)
	[OTA_BLUETOOTH] = "bluetooth",
#endif
};

static void enter(enum ota_state state)
{
	ota.state = state;
	ota.seconds_in_state = 0;
	ota.changed = true;
}

static void set_last(const char *result, const char *error)
{
	strncpy(ota.last_result, result, sizeof(ota.last_result) - 1);
	ota.last_result[sizeof(ota.last_result) - 1] = '\0';
	strncpy(ota.last_error, error, sizeof(ota.last_error) - 1);
	ota.last_error[sizeof(ota.last_error) - 1] = '\0';
	ota.changed = true;
}

/*
 * Send a job execution update. details is a comma-separated list of "key":"value"
 * pairs built only from values this firmware controls (step names, numbers, versions);
 * the service accepts only non-empty strings as values.
 *
 * With a token the reply comes back through ota_on_job_ack(); *sequence then receives
 * the number that reply will carry.
 */
static int job_update(const char *job_id, const char *status, char token, uint16_t *sequence,
		      const char *details_format, ...)
{
	char details[160];
	char body[256];
	va_list args;
	int written;

	va_start(args, details_format);
	written = vsnprintk(details, sizeof(details), details_format, args);
	va_end(args);

	if (written < 0 || written >= (int)sizeof(details)) {
		return -ENOSPC;
	}

	if (token != TOKEN_NONE) {
		if (++ota.sequence == 0) {
			ota.sequence = 1;
		}
		*sequence = ota.sequence;
		written = snprintk(body, sizeof(body),
				   "{\"status\":\"%s\",\"statusDetails\":{%s},\"clientToken\":\"%c%u\"}",
				   status, details, token, ota.sequence);
	} else {
		written = snprintk(body, sizeof(body), "{\"status\":\"%s\",\"statusDetails\":{%s}}",
				   status, details);
	}

	if (written < 0 || written >= (int)sizeof(body)) {
		return -ENOSPC;
	}

	return cloud_jobs_update(job_id, body);
}

/* What the Bluetooth status says of the last cloud update (ota_bt_cloud_update()). */
static void note_installed(enum bt_status_outcome outcome)
{
#if defined(CONFIG_APP_BT_OTA)
	ota.installed = ota.record.target;
	ota.installed_outcome = outcome;
#else
	ARG_UNUSED(outcome);
#endif
}

static void record_clear(void)
{
	(void)store_erase(STORE_OTA_RECORD);
	ota.have_record = false;
	ota.report = REPORT_NONE;
	memset(&ota.record, 0, sizeof(ota.record));
}

/* Report the outcome of an update that finished across a restart. */
static void send_final_report(void)
{
	int err;

	if (ota.report == REPORT_NONE || !ota.have_record) {
		return;
	}

#if defined(CONFIG_APP_PI_OTA)
	if (ota.record.with_pi && ota.report == REPORT_SUCCEEDED) {
		const char *pi_version = pi_ota_installed_version();

		err = job_update(ota.record.job_id, "SUCCEEDED", TOKEN_REPORT, &ota.report_sequence,
				 "\"running\":\"%s\",\"pi_version\":\"%s\"",
				 fw_version_running_string(), pi_version[0] != '\0' ? pi_version : "unknown");
	} else if (ota.record.with_pi) {
		/* Either the firmware did not stay, and the Pi was left alone, or the Pi failed. */
		bool firmware_kept = ota.record.pi_step >= RECORD_PI_FAILED;

		err = job_update(ota.record.job_id, "FAILED", TOKEN_REPORT, &ota.report_sequence,
				 "\"reason\":\"%s\",\"running\":\"%s\",\"nrf\":\"%s\",\"pi\":\"%s\"",
				 ota.report_reason, fw_version_running_string(),
				 firmware_kept ? "installed" : "not_installed",
				 firmware_kept ? "failed" : "not_flashed");
	} else
#else
	if (ota.record.with_pi && ota.report == REPORT_SUCCEEDED) {
		/*
		 * A job with a Pi image installed this, a build that cannot send one: the job's own
		 * firmware was not a Pi build. It stays, and the Pi was left alone. Said as it is.
		 */
		err = job_update(ota.record.job_id, "FAILED", TOKEN_REPORT, &ota.report_sequence,
				 "\"reason\":\"pi_unsupported\",\"running\":\"%s\",\"nrf\":\"installed\","
				 "\"pi\":\"not_flashed\"",
				 fw_version_running_string());
	} else
#endif
	if (ota.report == REPORT_SUCCEEDED) {
		err = job_update(ota.record.job_id, "SUCCEEDED", TOKEN_REPORT, &ota.report_sequence,
				 "\"running\":\"%s\"", fw_version_running_string());
	} else {
		err = job_update(ota.record.job_id, "FAILED", TOKEN_REPORT, &ota.report_sequence,
				 "\"reason\":\"%s\",\"running\":\"%s\"", ota.report_reason,
				 fw_version_running_string());
	}

	ota.seconds_since_report = 0;
	if (err) {
		LOG_WRN("Final update report could not be sent yet: %d", err);
	}
}

/* Back to waiting for the next job. */
static void go_idle(void)
{
	ota.started = false;
	ota.with_pi = false;
	/* A job with both parts is over: replies keep the firmware's URL again. */
	cloud_jobs_set_part(OTA_JOB_PART_FIRMWARE);
	enter(OTA_IDLE);
}

/* Remember a job that this device has given a final answer to. */
static void close_job(const char *job_id)
{
	strncpy(ota.closed_job_id, job_id, sizeof(ota.closed_job_id) - 1);
	ota.closed_job_id[sizeof(ota.closed_job_id) - 1] = '\0';
}

/* Remove a downloaded image that will not be installed. */
static void discard_download(void)
{
	int err = boot_erase_img_bank(SECONDARY_SLOT_ID);

	if (err) {
		LOG_WRN("The secondary slot could not be erased: %d", err);
	}
}

/* Give up on the job this device had started and tell the cloud why. */
static void fail_job(const char *reason, const char *detail)
{
	LOG_ERR("Update %s failed: %s (%s)", ota.job.id, reason, detail);
	(void)job_update(ota.job.id, "FAILED", TOKEN_NONE, NULL,
			 "\"reason\":\"%s\",\"detail\":\"%s\",\"running\":\"%s\"", reason, detail,
			 fw_version_running_string());
	close_job(ota.job.id);
	set_last("failed", reason);
	mflt_note_update_end(MFLT_UPDATE_FAILED, reason, detail);
	go_idle();
	(void)cloud_jobs_request_next();
}

/*
 * Refuse a job without attempting it. The service only takes a rejection for an
 * execution that is still queued; one that is already in progress has to fail.
 */
static void refuse_job(const char *job_id, bool in_progress, const char *reason)
{
	LOG_WRN("Refusing update job %s: %s", job_id, reason);
	(void)job_update(job_id, in_progress ? "FAILED" : "REJECTED", TOKEN_NONE, NULL,
			 "\"reason\":\"%s\",\"running\":\"%s\"", reason,
			 fw_version_running_string());
	close_job(job_id);
	set_last("refused", reason);
	mflt_note_update_end(MFLT_UPDATE_REFUSED, reason, job_id);
}

/* The job was cancelled, timed out or deleted while this device was working on it. */
static void abandon_job(bool downloaded)
{
	LOG_INF("Update job %s was withdrawn", ota.job.id);
	if (downloaded) {
		discard_download();
	}
	set_last("cancelled", "");
	go_idle();
}

static void download_callback(const struct fota_download_evt *download_event)
{
	static int last_step = -1;
	struct app_event event = { .type = APP_EVENT_DOWNLOAD };

	/*
	 * Any event counts, also the pieces that the filter below keeps from the main loop. An error
	 * counts too: attempts are limited, and a stall is not what that is.
	 */
	atomic_inc(&stuck_progress);

	/* Runs on the downloader thread: only translate and hand over. */
	switch (download_event->id) {
	case FOTA_DOWNLOAD_EVT_PROGRESS:
		if (download_event->progress / PROGRESS_STEP_PERCENT == last_step) {
			return;
		}
		last_step = download_event->progress / PROGRESS_STEP_PERCENT;
		event.download.what = APP_DOWNLOAD_PROGRESS;
		event.download.value = (int16_t)download_event->progress;
		break;
	case FOTA_DOWNLOAD_EVT_FINISHED:
		last_step = -1;
		event.download.what = APP_DOWNLOAD_FINISHED;
		break;
	case FOTA_DOWNLOAD_EVT_ERROR:
		last_step = -1;
		event.download.what = APP_DOWNLOAD_ERROR;
		event.download.value = (int16_t)download_event->cause;
		break;
	case FOTA_DOWNLOAD_EVT_CANCELLED:
		last_step = -1;
		event.download.what = APP_DOWNLOAD_CANCELLED;
		break;
	default:
		return;
	}

	(void)app_event_post(&event);
}

/* This attempt is over: wait before the next one, or give up when none is left. */
static void download_failed(int cause)
{
	char detail[24];

	if (ota.download_attempts < CONFIG_APP_OTA_DOWNLOAD_ATTEMPTS) {
		LOG_WRN("Download failed (%d): trying again in %d s with a fresh URL", cause,
			RETRY_WAIT_SECONDS * ota.download_attempts);
		enter(OTA_RETRY_WAIT);
	} else {
		(void)snprintk(detail, sizeof(detail), "cause %d", cause);
		fail_job("download_failed", detail);
	}
}

static void start_download(void)
{
	int err;

	ota.download_attempts++;
	ota.progress = 0;
	atomic_inc(&stuck_progress);
	enter(OTA_DOWNLOADING);
	if (ota.download_attempts == 1) {
		mflt_note_update_started();
	}

	LOG_INF("Downloading %u bytes of firmware %u.%u.%u+%u (attempt %u)", ota.job.size,
		ota.job.version.major, ota.job.version.minor, ota.job.version.revision,
		ota.job.version.build, ota.download_attempts);

	/*
	 * HTTPS only: the host string carries the scheme and a TLS security tag is always
	 * given, so the server certificate is verified against the provisioned root CA.
	 * That tag holds no client certificate, so the device key is not used here.
	 */
	err = fota_download_start(ota.job.host, ota.job.file, CONFIG_APP_DOWNLOAD_SEC_TAG, 0, 0);
	if (err) {
		download_failed(err);
	}
}

/* Ask for the job document again; the reply carries a newly signed download URL. */
static void refresh_document(void)
{
	enter(OTA_REFRESHING);
	if (cloud_jobs_request_next() != 0) {
		LOG_WRN("Could not request the job document; will retry");
	}
}

/*
 * Tell the cloud that this device starts the update. The download begins only when
 * the cloud accepts that: an update that was cancelled meanwhile is rejected here.
 */
static void announce_start(void)
{
	enter(OTA_STARTING);
	if (job_update(ota.job.id, "IN_PROGRESS", TOKEN_START, &ota.start_sequence,
		       "\"step\":\"downloading\"") != 0) {
		LOG_WRN("Could not announce the start of the update; will retry");
	}
}

/* Tell the cloud that the verified image is about to be installed. */
static void announce_commit(void)
{
	if (job_update(ota.job.id, "IN_PROGRESS", TOKEN_COMMIT, &ota.commit_sequence,
		       "\"step\":\"rebooting\"") != 0) {
		LOG_WRN("Could not announce the installation; will retry");
	}
}

/*
 * Compare the SHA-256 of what is now in the secondary slot with the digest in the job.
 * This catches a damaged or substituted download before a restart is spent on it. It
 * is not what makes the image trustworthy: the bootloader checks the signature.
 */
static int verify_download(const char **reason)
{
	static uint8_t chunk[HASH_CHUNK_SIZE];
	psa_hash_operation_t operation = PSA_HASH_OPERATION_INIT;
	uint8_t digest[OTA_SHA256_SIZE];
	struct mcuboot_img_header header;
	const struct flash_area *area;
	size_t digest_length = 0;
	psa_status_t status;
	uint32_t offset = 0;
	int err;

	*reason = "flash_error";

	err = boot_read_bank_header(SECONDARY_SLOT_ID, &header, sizeof(header));
	if (err || header.mcuboot_version != 1) {
		*reason = "header_mismatch";
		return -EBADMSG;
	}

	/* The image must be the version the job announced, not merely any signed image. */
	if (header.h.v1.sem_ver.major != ota.job.version.major ||
	    header.h.v1.sem_ver.minor != ota.job.version.minor ||
	    header.h.v1.sem_ver.revision != ota.job.version.revision ||
	    header.h.v1.sem_ver.build_num != ota.job.version.build ||
	    header.h.v1.image_size > ota.job.size) {
		*reason = "header_mismatch";
		return -EBADMSG;
	}

	/*
	 * Only this code asks the bootloader for a swap, and only for a trial. A file
	 * long enough to bring a swap request of its own could make the update permanent
	 * without one, so nothing may be pending yet.
	 */
	if (mcuboot_swap_type_multi(0) != BOOT_SWAP_TYPE_NONE) {
		*reason = "header_mismatch";
		return -EBADMSG;
	}

	err = flash_area_open(SECONDARY_SLOT_ID, &area);
	if (err) {
		return err;
	}

	status = psa_hash_setup(&operation, PSA_ALG_SHA_256);
	while (status == PSA_SUCCESS && offset < ota.job.size) {
		size_t length = MIN(sizeof(chunk), ota.job.size - offset);

		err = flash_area_read(area, offset, chunk, length);
		if (err) {
			break;
		}

		status = psa_hash_update(&operation, chunk, length);
		offset += length;
	}

	flash_area_close(area);

	if (err || status != PSA_SUCCESS) {
		(void)psa_hash_abort(&operation);
		return err ? err : -EIO;
	}

	status = psa_hash_finish(&operation, digest, sizeof(digest), &digest_length);
	if (status != PSA_SUCCESS || digest_length != sizeof(digest)) {
		return -EIO;
	}

	/* Not a secret comparison, but constant time costs nothing here. */
	uint8_t difference = 0;

	for (size_t i = 0; i < sizeof(digest); i++) {
		difference |= digest[i] ^ ota.job.sha256[i];
	}

	if (difference != 0) {
		*reason = "digest_mismatch";
		return -EBADMSG;
	}

	return 0;
}

/*
 * The image in the secondary slot against this board, from its protected TLVs (image_compat.h):
 * NULL if it is for this board type and flash layout, or else the reason to fail with, and what
 * the image says, in detail.
 */
static const char *incompatible(char *detail, size_t len)
{
	struct image_compat found;
	enum image_compat_verdict verdict = image_compat_check_slot(SECONDARY_SLOT_ID, &found);

	switch (verdict) {
	case IMAGE_COMPAT_OK:
		return NULL;
	case IMAGE_COMPAT_OTHER_BOARD:
		(void)snprintk(detail, len, "image is for %s", found.board);
		break;
	case IMAGE_COMPAT_OTHER_LAYOUT:
		(void)snprintk(detail, len, "image is for flash layout %u", (unsigned int)found.layout);
		break;
	case IMAGE_COMPAT_MALFORMED:
		(void)snprintk(detail, len, "image metadata malformed");
		break;
	default:
		(void)snprintk(detail, len, "image metadata unreadable");
		break;
	}

	return image_compat_reason(verdict);
}

/* The download is complete: check it, then ask the cloud whether to go on. */
static void check_download(void)
{
	char detail[40];
	const char *reason;

	enter(OTA_VERIFYING);

	if (verify_download(&reason) != 0) {
		discard_download();
		fail_job(reason, "image in secondary slot rejected");
		return;
	}

	/* What the job announced, and for another board or flash layout: never installed. */
	reason = incompatible(detail, sizeof(detail));
	if (reason != NULL) {
		discard_download();
		fail_job(reason, detail);
		return;
	}

	LOG_INF("Image verified");
	atomic_inc(&stuck_progress);
#if defined(CONFIG_APP_PI_OTA)
	if (ota.with_pi) {
		/*
		 * Both downloads before anything is installed: the Pi image goes onto the card now, and
		 * the firmware is handed over only once that is done (on_pi_staged()).
		 */
		LOG_INF("Now the Pi image of the same job, onto the SD card");
		enter(OTA_STAGING_PI);
		cloud_jobs_set_part(OTA_JOB_PART_PI);
		pi_ota_bundle(&ota.job, PI_OTA_BUNDLE_STAGE);
		return;
	}
#endif
	enter(OTA_COMMITTING);
	announce_commit();
}

/* The cloud agreed to the installation: wait before acting on it (see SETTLE_SECONDS). */
static void begin_settling(void)
{
	LOG_INF("Installation accepted. Looking at the job once more in %d s", SETTLE_SECONDS);
	ota.last_look = false;
	atomic_inc(&stuck_progress);
	enter(OTA_REBOOTING);
}

/*
 * The job is still wanted after the settle time: hand the image to the bootloader and
 * restart. Nothing was requested from the bootloader before this point, so a reset
 * during the wait installs nothing.
 */
static void install_download(void)
{
	char detail[40];
	const char *reason;
	int err;

	/* Looked at again right before the bootloader is asked: nothing else marks an image. */
	reason = incompatible(detail, sizeof(detail));
	if (reason != NULL) {
		discard_download();
		fail_job(reason, detail);
		return;
	}

	/* Remember the job across the restart before anything irreversible happens. */
	memset(&ota.record, 0, sizeof(ota.record));
	ota.record.magic = RECORD_MAGIC;
	ota.record.phase = RECORD_ARMED;
	memcpy(ota.record.job_id, ota.job.id, sizeof(ota.record.job_id));
	ota.record.target = ota.job.version;
	ota.record.with_pi = ota.with_pi ? 1 : 0;
	ota.record.pi_step = ota.with_pi ? RECORD_PI_STAGED : RECORD_PI_NONE;

	err = store_write(STORE_OTA_RECORD, &ota.record, sizeof(ota.record));
	if (err) {
		discard_download();
		fail_job("flash_error", "could not record the update");
		return;
	}
	ota.have_record = true;

	/* A trial swap: the bootloader reverts unless the new image confirms itself. */
	err = boot_request_upgrade_multi(0, BOOT_UPGRADE_TEST);
	if (err) {
		record_clear();
		discard_download();
		fail_job("flash_error", "could not request the swap");
		return;
	}

	LOG_INF("Restarting into the bootloader to install the image");
	cloud_disconnect();
	mflt_reboot_mark(MFLT_REBOOT_UPDATE);
	LOG_PANIC();
	sys_reboot(SYS_REBOOT_COLD);
}

/*
 * A job that passed every check. It starts now, with the download link that just came with
 * it. Only with CONFIG_APP_OTA_REQUIRE_USER_CONSENT is it offered instead: nothing is sent to
 * the cloud, so the execution stays queued and whoever created the job can still take it back.
 */
static void accept_job(const struct ota_job *job)
{
	ota.job = *job;
	ota.started = false;
	ota.with_pi = false;
	ota.download_attempts = 0;
	ota.progress = 0;

	if (IS_ENABLED(CONFIG_APP_OTA_REQUIRE_USER_CONSENT)) {
		LOG_INF("Firmware %u.%u.%u+%u is available: press Button 1 to install it, "
			"Button 2 to decline",
			job->version.major, job->version.minor, job->version.revision,
			job->version.build);
		enter(OTA_AWAITING_USER);
	} else {
		LOG_INF("Firmware %u.%u.%u+%u is available: installing it", job->version.major,
			job->version.minor, job->version.revision, job->version.build);
		announce_start();
	}
}

/* The cloud no longer lists the job this device was working on. */
static void on_job_withdrawn(void)
{
	switch (ota.state) {
	case OTA_AWAITING_USER:
	case OTA_RETRY_WAIT:
	case OTA_REFRESHING:
	case OTA_STARTING:
		abandon_job(false);
		break;
	case OTA_DOWNLOADING:
		/* The partial image stays where it is: without a swap request the
		 * bootloader ignores it, and the next download overwrites it.
		 */
		(void)fota_download_cancel();
		abandon_job(false);
		break;
	case OTA_COMMITTING:
	case OTA_REBOOTING:
		/* Downloaded and checked, but not handed to the bootloader yet. */
		abandon_job(true);
		break;
#if defined(CONFIG_APP_PI_OTA)
	case OTA_STAGING_PI:
		/* The firmware goes; the Pi image stays on the card, for a later job to go on from. */
		pi_ota_withdrawn();
		abandon_job(true);
		break;
	case OTA_FLASHING_PI:
		/* The firmware stays, it is confirmed. The Pi is told to drop what it got. */
		pi_ota_withdrawn();
		record_clear();
		abandon_job(false);
		break;
#endif
	default:
		/* Idle, or running a new image on trial. */
		break;
	}
}

/*
 * The cloud lists an execution as in progress that this device knows nothing about:
 * it restarted in the middle of that update. Nothing was handed to the bootloader
 * (that leaves a record), so close the execution with what is actually running.
 */
static void settle_interrupted_job(const struct ota_job *job)
{
	close_job(job->id);

	if (fw_version_compare(&job->version, fw_version_running()) == 0) {
		(void)job_update(job->id, "SUCCEEDED", TOKEN_NONE, NULL, "\"running\":\"%s\"",
				 fw_version_running_string());
		return;
	}

	LOG_WRN("Update job %s was interrupted by a restart", job->id);
	(void)job_update(job->id, "FAILED", TOKEN_NONE, NULL,
			 "\"reason\":\"interrupted\",\"running\":\"%s\"",
			 fw_version_running_string());
	set_last("failed", "interrupted");
	mflt_note_update_end(MFLT_UPDATE_FAILED, "interrupted", job->id);
}

/* True if the document still describes the image that this update started with. */
static bool same_image(const struct ota_job *a, const struct ota_job *b)
{
	return fw_version_compare(&a->version, &b->version) == 0 && a->size == b->size &&
	       memcmp(a->sha256, b->sha256, sizeof(a->sha256)) == 0 && a->kind == b->kind &&
	       a->pi_size == b->pi_size && memcmp(a->pi_sha256, b->pi_sha256, sizeof(a->pi_sha256)) == 0;
}

#if defined(CONFIG_APP_PI_OTA)
static void save_record(void)
{
	if (store_write(STORE_OTA_RECORD, &ota.record, sizeof(ota.record)) != 0) {
		LOG_WRN("The update record could not be saved");
	}
}

/*
 * The firmware of a job with both is confirmed: the Pi's turn. The job's document is asked for again,
 * with the Pi image's URL, and on_job() hands it to pi_ota.c, which sends what is on the card and
 * downloads first whatever is not.
 */
static void begin_pi_flash(void)
{
	LOG_INF("Firmware confirmed: the Pi gets its image (job %s)", ota.record.job_id);
	ota.record.pi_step = RECORD_PI_FLASHING;
	save_record();
	memcpy(ota.job.id, ota.record.job_id, sizeof(ota.job.id));
	ota.job.kind = OTA_JOB_KIND_BUNDLE;
	ota.with_pi = true;
	ota.started = true;
	cloud_jobs_set_part(OTA_JOB_PART_PI);
	enter(OTA_FLASHING_PI);
	(void)job_update(ota.record.job_id, "IN_PROGRESS", TOKEN_NONE, NULL,
			 "\"step\":\"flashing_pi\",\"progress\":\"0\",\"running\":\"%s\"",
			 fw_version_running_string());
	(void)cloud_jobs_request_next();
}

/* The Pi part of a job with both has ended a step: see pi_ota_bundle_take_result(). */
static void on_pi_bundle_result(enum pi_err err)
{
	if (err == PI_ERR_ABORTED) {
		/* Withdrawn: on_job_withdrawn() has dealt with it. */
		return;
	}

	if (ota.state == OTA_STAGING_PI) {
		cloud_jobs_set_part(OTA_JOB_PART_FIRMWARE);
		if (err != PI_OK) {
			/* Nothing is installed, neither part: the firmware leaves the slot too. */
			discard_download();
			fail_job(pi_err_reason(err), "Pi image not on the card; nothing installed");
			return;
		}
		LOG_INF("Both images are here and checked: installing the firmware");
		atomic_inc(&stuck_progress);
		enter(OTA_COMMITTING);
		announce_commit();
		return;
	}

	if (ota.state != OTA_FLASHING_PI) {
		return;
	}

	if (err == PI_OK) {
		ota.record.pi_step = RECORD_PI_DONE;
		ota.report = REPORT_SUCCEEDED;
		set_last("succeeded", "");
	} else {
		ota.record.pi_step = RECORD_PI_FAILED | (uint8_t)err;
		ota.report = REPORT_FAILED;
		ota.report_reason = pi_err_reason(err);
		set_last("failed", ota.report_reason);
	}
	save_record();
	go_idle();
	send_final_report();
}

/*
 * A job with both that is in progress, and that this board has no record of: it restarted before
 * the firmware went to the bootloader. Both parts start again: the firmware from its first byte, the
 * Pi image from its last checkpoint on the card. If the firmware it brings already runs, the record
 * was lost after the installation, and only the Pi is left to do.
 */
static void resume_bundle(const struct ota_job *job)
{
	enum pi_err pi_verdict = pi_ota_bundle_check(job);

	if (pi_verdict != PI_OK && pi_verdict != PI_ERR_ALREADY_INSTALLED) {
		refuse_job(job->id, true, pi_err_reason(pi_verdict));
		return;
	}

	if (fw_version_compare(&job->version, fw_version_running()) == 0) {
		if (pi_verdict == PI_ERR_ALREADY_INSTALLED) {
			settle_interrupted_job(job);
			return;
		}
		memset(&ota.record, 0, sizeof(ota.record));
		ota.record.magic = RECORD_MAGIC;
		ota.record.phase = RECORD_TESTING;
		memcpy(ota.record.job_id, job->id, sizeof(ota.record.job_id));
		ota.record.target = job->version;
		ota.record.with_pi = 1;
		ota.have_record = true;
		begin_pi_flash();
		return;
	}

	if (ota_job_check(job, fw_version_running(), SECONDARY_SLOT_SIZE) != OTA_JOB_OK) {
		settle_interrupted_job(job);
		return;
	}

	LOG_INF("Job %s was cut off by a restart: both parts again, the Pi image from the card",
		job->id);
	ota.job = *job;
	ota.with_pi = pi_verdict == PI_OK;
	ota.started = true;
	ota.download_attempts = 0;
	ota.progress = 0;
	start_download();
}

/* Ask for the list of pending jobs, to see whether firmware has to go before this Pi image. */
static void ask_for_list(const char *pi_job_id)
{
	strncpy(order.asked, pi_job_id, sizeof(order.asked) - 1);
	order.asked[sizeof(order.asked) - 1] = '\0';
	order.seconds_asked = 0;
	if (cloud_jobs_request_list() != 0) {
		LOG_WRN("Could not ask for the list of jobs; will retry");
	}
}

static void on_pi_job(const struct ota_job *incoming)
{
	/* A job with both parts is under way: its Pi image goes first, this one waits, queued. */
	if (ota.state == OTA_STAGING_PI || ota.state == OTA_FLASHING_PI) {
		pi_ota_set_waiting(true);
		return;
	}

	/* The one under way, with a fresh URL, or one that a restart cut off: it goes on. */
	if (pi_ota_owns(incoming->id) || (incoming->in_progress && !pi_ota_busy())) {
		pi_ota_on_job(incoming);
		return;
	}

	if (pi_ota_busy()) {
		return;
	}

	/* A firmware update under way, or on trial: the Pi image stays queued until it is over. */
	if (ota.state != OTA_IDLE) {
		pi_ota_set_waiting(true);
		return;
	}

	if (strcmp(order.cleared, incoming->id) == 0 || !cloud_jobs_list_available()) {
		/* No firmware job before it, or no way to know: a cloud whose device policy is older
		 * than console 2.25.0 (cloud.h). Then the order is the cloud's.
		 */
		order.cleared[0] = '\0';
		pi_ota_set_waiting(false);
		pi_ota_on_job(incoming);
		return;
	}

	ask_for_list(incoming->id);
}

/* The list of pending jobs, asked for by ask_for_list(). */
static void on_job_list(enum ota_job_result result, const struct ota_job *firmware)
{
	if (order.asked[0] == '\0') {
		return;
	}

	switch (result) {
	case OTA_JOB_OK:
		if (ota.state != OTA_IDLE) {
			/* Busy already: the Pi image is asked about again when that is over. */
			order.asked[0] = '\0';
			pi_ota_set_waiting(true);
			return;
		}
		/*
		 * Firmware first. Marked in progress, it is the next job that the cloud names, and the
		 * Pi image stays queued: nothing about it changes.
		 */
		LOG_INF("Firmware job %s goes before Pi image job %s", firmware->id, order.asked);
		strncpy(order.promoted, firmware->id, sizeof(order.promoted) - 1);
		order.asked[0] = '\0';
		pi_ota_set_waiting(true);
		(void)job_update(firmware->id, "IN_PROGRESS", TOKEN_NONE, NULL,
				 "\"step\":\"before_pi_image\"");
		(void)cloud_jobs_request_next();
		break;
	case OTA_JOB_NONE:
		memcpy(order.cleared, order.asked, sizeof(order.cleared));
		order.asked[0] = '\0';
		(void)cloud_jobs_request_next();
		break;
	default:
		/* Unreadable: the tick asks again. */
		break;
	}
}
#endif

static void on_job(const struct ota_job *incoming)
{
	bool same_job = strcmp(incoming->id, ota.job.id) == 0;
	bool promoted = false;
	enum ota_job_result verdict;

#if defined(CONFIG_APP_PI_OTA)
	/* The Pi part's turn, and the document with its URL, as begin_pi_flash() asked. */
	if (ota.state == OTA_FLASHING_PI) {
		if (ota.have_record && strcmp(incoming->id, ota.record.job_id) == 0) {
			if (incoming->kind == OTA_JOB_KIND_BUNDLE) {
				pi_ota_bundle(incoming, PI_OTA_BUNDLE_FLASH);
			}
			return;
		}
		/* AWS IoT names the job in progress first: another one means this one is gone. */
		on_job_withdrawn();
	}

	/* A fresh URL for the Pi image of the job whose firmware waits in the slot. */
	if (ota.state == OTA_STAGING_PI && same_job) {
		if (incoming->kind == OTA_JOB_KIND_BUNDLE) {
			pi_ota_bundle(incoming, PI_OTA_BUNDLE_STAGE);
		}
		return;
	}
#endif

	/* The job whose outcome is about to be reported is not a new offer, and neither
	 * is one that was just answered.
	 */
	if ((ota.have_record && strcmp(incoming->id, ota.record.job_id) == 0) ||
	    strcmp(incoming->id, ota.closed_job_id) == 0) {
		return;
	}

	if (incoming->kind == OTA_JOB_KIND_PI_IMAGE) {
#if defined(CONFIG_APP_PI_OTA)
		on_pi_job(incoming);
#else
		/* What a board without a Pi has always answered to a document it does not know. */
		if (ota.state == OTA_IDLE) {
			refuse_job(incoming->id, incoming->in_progress, "unsupported");
		}
#endif
		return;
	}

#if !defined(CONFIG_APP_PI_OTA)
	/* Firmware with a Pi image: only a build for a board wired to a Pi takes that. */
	if (incoming->kind == OTA_JOB_KIND_BUNDLE) {
		if (ota.state == OTA_IDLE) {
			refuse_job(incoming->id, incoming->in_progress, "unsupported");
		}
		return;
	}
#endif

#if defined(CONFIG_APP_PI_OTA)
	/* Another job is next while a Pi image is under way: the Pi image's job is gone. */
	if (pi_ota_busy()) {
		pi_ota_withdrawn();
	}

	promoted = order.promoted[0] != '\0' && strcmp(order.promoted, incoming->id) == 0;
	if (promoted && ota.state == OTA_IDLE) {
		/* Moved ahead of a Pi image: in progress by this board's hand, so new all the same. */
		order.promoted[0] = '\0';
	} else {
		promoted = false;
	}
#endif

	if (ota.state == OTA_REBOOTING && same_job) {
		/* The last look: still in progress after the settle time means go. */
		if (ota.last_look && incoming->in_progress) {
			install_download();
		}
		return;
	}

	/*
	 * AWS IoT lists a job that is in progress before any other. If it names a
	 * different one while this device is working on a job, that job is gone.
	 */
	if (!same_job && (ota.state == OTA_RETRY_WAIT || ota.state == OTA_STARTING ||
			  ota.state == OTA_DOWNLOADING || ota.state == OTA_COMMITTING ||
			  ota.state == OTA_REBOOTING || ota.state == OTA_STAGING_PI)) {
		on_job_withdrawn();
	}

	switch (ota.state) {
	case OTA_IDLE:
		break;
	case OTA_AWAITING_USER:
		if (same_job) {
			return;
		}
		/* A different job is next now: the one on offer is gone. */
		abandon_job(false);
		break;
	case OTA_REFRESHING:
		if (same_job) {
			if (!same_image(incoming, &ota.job)) {
				refuse_job(incoming->id, incoming->in_progress, "bad_document");
				go_idle();
				return;
			}

			/* Take the fresh download URL. */
			ota.job = *incoming;
			if (incoming->in_progress) {
				ota.started = true;
				start_download();
			} else {
				announce_start();
			}
			return;
		}
		abandon_job(false);
		break;
	default:
		/* Busy with a download or an installation: look again afterwards. */
		return;
	}

#if defined(CONFIG_APP_PI_OTA)
	if (incoming->kind == OTA_JOB_KIND_BUNDLE && incoming->in_progress && !promoted) {
		resume_bundle(incoming);
		return;
	}
#endif

	if (incoming->in_progress && !promoted) {
		settle_interrupted_job(incoming);
		return;
	}

	verdict = ota_job_check(incoming, fw_version_running(), SECONDARY_SLOT_SIZE);
	if (verdict != OTA_JOB_OK) {
		/* One that was moved ahead is in progress: it can only fail. */
		refuse_job(incoming->id, promoted, ota_job_result_reason(verdict));
		return;
	}

#if defined(CONFIG_APP_PI_OTA)
	if (incoming->kind == OTA_JOB_KIND_BUNDLE) {
		/* The Pi part is checked before anything of either part is downloaded. */
		enum pi_err pi_verdict = pi_ota_bundle_check(incoming);

		if (pi_verdict != PI_OK && pi_verdict != PI_ERR_ALREADY_INSTALLED) {
			refuse_job(incoming->id, promoted, pi_err_reason(pi_verdict));
			return;
		}
		accept_job(incoming);
		/* The Pi has that image already: the firmware alone, as a firmware job. */
		ota.with_pi = pi_verdict == PI_OK;
		return;
	}
#endif

	accept_job(incoming);
}

/*
 * A swap leaves its magic number in the last bytes of the slot. Those are erased if the image got
 * there another way, and boot_is_img_confirmed() cannot tell that from a confirmed image. A read
 * that fails says nothing, so it does not change what is reported.
 */
static bool primary_has_trailer(void)
{
	const struct flash_area *area;
	uint8_t magic[TRAILER_MAGIC_SIZE];
	bool found = true;

	if (flash_area_open(PARTITION_ID(slot0_partition), &area) != 0) {
		return true;
	}

	if (flash_area_read(area, area->fa_size - sizeof(magic), magic, sizeof(magic)) == 0) {
		found = false;
		for (size_t i = 0; i < sizeof(magic); i++) {
			found = found || magic[i] != TRAILER_ERASED;
		}
	}

	flash_area_close(area);
	return found;
}

int ota_init(void)
{
	static struct ota_record stored;
	bool on_trial;
	int err;

	strcpy(ota.last_result, "none");

	/*
	 * REVERT means: this image runs on trial and is swapped out again at the next restart unless
	 * it is confirmed. Its deadline starts here, before anything below can return early: an image
	 * that cannot even start this module has to go back as well.
	 */
	on_trial = mcuboot_swap_type_multi(0) == BOOT_SWAP_TYPE_REVERT;
	if (on_trial) {
		health_trial_begin();
	}

	if (psa_crypto_init() != PSA_SUCCESS) {
		LOG_ERR("PSA crypto is not available");
		return -EIO;
	}

#if defined(CONFIG_APP_PI_OTA)
	/* A Pi without its update is no reason to give up the board's own. */
	if (pi_ota_init() != 0) {
		LOG_ERR("Pi image update could not start");
	}
#endif

	err = fota_download_init(download_callback);
	if (err) {
		LOG_ERR("Download library could not be initialised: %d", err);
		return err;
	}

	if (store_read(STORE_OTA_RECORD, &stored, sizeof(stored)) == 0 &&
	    stored.magic == RECORD_MAGIC) {
		stored.job_id[OTA_JOB_ID_MAX] = '\0';
		ota.record = stored;
		ota.have_record = true;
	}

	if (ota.have_record) {
		bool running_target = fw_version_compare(&ota.record.target, fw_version_running()) == 0;

		switch (ota_restart_outcome(running_target, on_trial, primary_has_trailer(),
					    ota.record.phase == RECORD_TESTING)) {
		case OTA_RESTART_ON_TRIAL:
			LOG_INF("Running new firmware %s on trial", fw_version_running_string());
			ota.record.phase = RECORD_TESTING;
			(void)store_write(STORE_OTA_RECORD, &ota.record, sizeof(ota.record));
			enter(OTA_TESTING);
			note_installed(BT_STATUS_OUTCOME_PENDING);
			break;
		case OTA_RESTART_CONFIRMED:
#if defined(CONFIG_APP_PI_OTA)
			if (ota.record.with_pi && (ota.record.pi_step == RECORD_PI_STAGED ||
						   ota.record.pi_step == RECORD_PI_FLASHING)) {
				/* Cut off while the Pi got its image, or right before: again. */
				LOG_INF("The Pi has yet to get the image of job %s", ota.record.job_id);
				ota.resume_pi = true;
				break;
			}
			if (ota.record.with_pi && ota.record.pi_step >= RECORD_PI_FAILED) {
				/* The Pi failed, and the report did not get out. */
				ota.report = REPORT_FAILED;
				ota.report_reason = pi_err_reason(
					(enum pi_err)(ota.record.pi_step & ~RECORD_PI_FAILED));
				set_last("failed", ota.report_reason);
				break;
			}
#endif
			/* Confirmed earlier, but the report did not get out. */
			ota.report = REPORT_SUCCEEDED;
			set_last("succeeded", "");
			note_installed(BT_STATUS_OUTCOME_KEPT);
			break;
		case OTA_RESTART_TRIAL_LOST:
			LOG_ERR("This image runs with no trailer: its trial was lost, and it proved nothing");
			ota.report = REPORT_FAILED;
			ota.report_reason = "trial_lost";
			set_last("failed", "trial_lost");
			mflt_note_update_end(MFLT_UPDATE_ROLLED_BACK, "trial_lost",
					     fw_version_running_string());
			note_installed(BT_STATUS_OUTCOME_TRIAL_LOST);
			break;
		case OTA_RESTART_ROLLED_BACK:
			LOG_ERR("The updated firmware was not confirmed: the bootloader reverted it");
			ota.report = REPORT_FAILED;
			ota.report_reason = "rolled_back";
			set_last("rolled_back", "not confirmed");
			mflt_note_update_end(MFLT_UPDATE_ROLLED_BACK, "rolled_back",
					     fw_version_running_string());
			note_installed(BT_STATUS_OUTCOME_ROLLED_BACK);
			break;
		default:
			LOG_ERR("The bootloader did not install the downloaded image");
			ota.report = REPORT_FAILED;
			ota.report_reason = "not_installed";
			set_last("failed", "not_installed");
			mflt_note_update_end(MFLT_UPDATE_FAILED, "not_installed",
					     fw_version_running_string());
			note_installed(BT_STATUS_OUTCOME_NOT_INSTALLED);
			break;
		}
	} else if (on_trial) {
		/* On trial with no record of an update: the record was lost, or something other
		 * than this code asked for the swap. It still has to prove itself.
		 */
		enter(OTA_TESTING);
	} else if (!boot_is_img_confirmed()) {
		/* A trailer that says neither confirmed nor on trial. An image with no trailer does
		 * not come here, written over the debug port, through serial recovery or by a golden
		 * image restore: boot_is_img_confirmed() counts it as confirmed, and nothing is written.
		 */
		(void)boot_write_img_confirmed();
	}

#if defined(CONFIG_APP_BT_OTA)
	bt_ota_on_boot(on_trial, primary_has_trailer(), ota.have_record);
#endif

	return 0;
}

void ota_on_cloud_up(void)
{
	if (ota.state == OTA_TESTING && !IS_ENABLED(CONFIG_APP_TEST_FAULT_NO_CONFIRM)) {
		/*
		 * The trial: this image booted, joined Wi-Fi, authenticated to AWS IoT with the
		 * device certificate and subscribed to its topics. It can therefore receive a
		 * further update, so it is safe to keep.
		 */
		int err = boot_write_img_confirmed();

		if (err) {
			LOG_ERR("Image could not be confirmed: %d", err);
			return;
		}

		health_trial_passed();
		LOG_INF("Firmware %s confirmed", fw_version_running_string());
		set_last("succeeded", "");
		mflt_note_update_end(MFLT_UPDATE_SUCCEEDED, "succeeded", fw_version_running_string());
		go_idle();

		if (ota.have_record) {
			ota.report = REPORT_SUCCEEDED;
			note_installed(BT_STATUS_OUTCOME_KEPT);
		}
#if defined(CONFIG_APP_PI_OTA)
		if (ota.have_record && ota.record.with_pi) {
			/* Not over yet: the job's Pi image goes now, and only now. */
			ota.report = REPORT_NONE;
			ota.resume_pi = true;
		}
#endif
#if defined(CONFIG_APP_BT_OTA)
		bt_ota_on_cloud_proof();
#endif
	}

#if defined(CONFIG_APP_PI_OTA)
	if (ota.resume_pi && ota.state == OTA_IDLE && ota.have_record) {
		ota.resume_pi = false;
		begin_pi_flash();
		return;
	}
#endif

	send_final_report();
#if defined(CONFIG_APP_BT_OTA)
	bt_ota_on_cloud_up();
#endif

	/* After a reconnect the cloud's list is the truth again: an answer that was lost
	 * with the old connection gets given once more.
	 */
	ota.closed_job_id[0] = '\0';

	if (ota.state == OTA_COMMITTING) {
		/* The connection dropped while the answer was outstanding: ask again. */
		ota.seconds_in_state = 0;
		announce_commit();
	}

	(void)cloud_jobs_request_next();
}

void ota_on_job_message(enum cloud_job_message kind, enum ota_job_result result,
			const struct ota_job *incoming)
{
	const struct identity_settings *config = identity_settings_get();

	if (kind == CLOUD_JOB_NOTIFY_NEXT) {
		/* Something changed in the list of pending jobs: fetch the next one. */
		(void)cloud_jobs_request_next();
		return;
	}

	if (kind == CLOUD_JOB_GET_REJECTED) {
		LOG_WRN("The cloud rejected the request for the next job");
		return;
	}

	if (config == NULL) {
		return;
	}

	if (kind == CLOUD_JOB_LIST) {
#if defined(CONFIG_APP_PI_OTA)
		on_job_list(result, incoming);
#endif
		return;
	}

	/* Read on the MQTT library's thread already, with this connection's prefix: cloud.h. */
	switch (result) {
	case OTA_JOB_OK:
		on_job(incoming);
		break;
	case OTA_JOB_NONE:
		/*
		 * Not while the start is being announced. With no button in between, the start follows
		 * the list that named the job at once, and an older list, asked for before the job
		 * existed, could still be on its way. The answer to the announcement says whether the
		 * job is gone, and without one the tick asks for the list again.
		 */
		if (ota.state != OTA_STARTING) {
			on_job_withdrawn();
		}
#if defined(CONFIG_APP_PI_OTA)
		if (pi_ota_busy()) {
			pi_ota_withdrawn();
		}
		pi_ota_set_waiting(false);
		order.asked[0] = '\0';
#endif
		break;
	case OTA_JOB_MALFORMED:
		LOG_WRN("Ignoring a jobs message that could not be parsed");
		break;
	default:
		/* Identified but unusable: refuse it so that it does not block later jobs. */
		if ((ota.have_record && strcmp(incoming->id, ota.record.job_id) == 0) ||
		    strcmp(incoming->id, ota.closed_job_id) == 0) {
			break;
		}
		if (ota.state == OTA_IDLE || ota.state == OTA_AWAITING_USER ||
		    ota.state == OTA_REFRESHING) {
			refuse_job(incoming->id, incoming->in_progress, ota_job_result_reason(result));
			if (ota.state != OTA_IDLE) {
				go_idle();
			}
		}
		break;
	}
}

void ota_on_job_ack(char kind, uint16_t sequence, bool accepted, bool permanent)
{
	switch (kind) {
	case TOKEN_START:
		if (ota.state != OTA_STARTING || sequence != ota.start_sequence) {
			break;
		}
		if (accepted) {
			ota.started = true;
			start_download();
		} else if (permanent) {
			abandon_job(false);
		}
		/* Otherwise the service was busy: the tick asks again. */
		break;
	case TOKEN_COMMIT:
		if (ota.state != OTA_COMMITTING || sequence != ota.commit_sequence) {
			break;
		}
		if (accepted) {
			begin_settling();
		} else if (permanent) {
			abandon_job(true);
		}
		break;
	case TOKEN_REPORT:
		if (ota.report == REPORT_NONE || sequence != ota.report_sequence) {
			break;
		}
		if (accepted || permanent) {
			/* Rejected for good means the job was cancelled, timed out or deleted
			 * in the meantime: there is nobody left to tell.
			 */
			LOG_INF("Final update report %s by the cloud",
				accepted ? "accepted" : "rejected");
			/* A list of jobs that was already on its way may still name this one. */
			close_job(ota.record.job_id);
			record_clear();
			ota.changed = true;
		}
		break;
	default:
		break;
	}
}

void ota_on_button(enum app_button button)
{
	if (ota.state != OTA_AWAITING_USER) {
		return;
	}

	if (button == APP_BUTTON_1) {
		LOG_INF("Update accepted on the device");
		refresh_document();
	} else {
		LOG_INF("Update declined on the device");
		(void)job_update(ota.job.id, "REJECTED", TOKEN_NONE, NULL,
				 "\"reason\":\"declined\",\"running\":\"%s\"",
				 fw_version_running_string());
		close_job(ota.job.id);
		set_last("declined", "");
		go_idle();
	}
}

void ota_on_download(enum app_download_event what, int value)
{
#if defined(CONFIG_APP_PI_OTA)
	/* A Pi image comes through the same downloader, while the firmware's own download does not. */
	if ((ota.state == OTA_IDLE || ota.state == OTA_STAGING_PI || ota.state == OTA_FLASHING_PI) &&
	    pi_ota_busy()) {
		pi_ota_on_download(what, value);
		return;
	}
#endif

	if (ota.state != OTA_DOWNLOADING) {
		return;
	}

	switch (what) {
	case APP_DOWNLOAD_PROGRESS:
		/* Shown through the device shadow only; the job is told about milestones. */
		ota.progress = value;
		ota.changed = true;
		break;
	case APP_DOWNLOAD_FINISHED:
		ota.progress = 100;
		check_download();
		break;
	case APP_DOWNLOAD_ERROR:
		download_failed(value);
		break;
	case APP_DOWNLOAD_CANCELLED:
	default:
		break;
	}
}

void ota_on_tick(void)
{
	ota.seconds_in_state++;

	switch (ota.state) {
	case OTA_RETRY_WAIT:
		if (ota.seconds_in_state >= RETRY_WAIT_SECONDS * ota.download_attempts) {
			refresh_document();
		}
		break;
	case OTA_REFRESHING:
		if (ota.seconds_in_state >= REFRESH_TIMEOUT_SECONDS) {
			ota.seconds_in_state = 0;
			(void)cloud_jobs_request_next();
		}
		break;
	case OTA_STARTING:
		/* No answer: fetch the document again, which shows whether the job still
		 * exists and whether the cloud already counts it as started.
		 */
		if (ota.seconds_in_state >= ACK_TIMEOUT_SECONDS) {
			refresh_document();
		}
		break;
	case OTA_COMMITTING:
		if (ota.seconds_in_state >= ACK_TIMEOUT_SECONDS) {
			ota.seconds_in_state = 0;
			if (cloud_is_connected()) {
				announce_commit();
			}
		}
		break;
	case OTA_REBOOTING:
		/* After the settle time, look at the job once more. The reply decides: see
		 * on_job() and on_job_withdrawn(). Without a connection there is no reply, and so
		 * no installation, until the cloud is reachable again. If that takes longer than
		 * STUCK_UPDATE_STALL_SECONDS, stuck.c restarts the board with nothing installed.
		 */
		if (!ota.last_look && ota.seconds_in_state >= SETTLE_SECONDS) {
			if (cloud_jobs_request_next() == 0) {
				ota.last_look = true;
				ota.seconds_in_state = 0;
			}
		} else if (ota.last_look && ota.seconds_in_state >= REFRESH_TIMEOUT_SECONDS) {
			/* No answer: ask again. */
			ota.last_look = false;
			ota.seconds_in_state = SETTLE_SECONDS;
		}
		break;
	default:
		break;
	}

	if (ota.report != REPORT_NONE && cloud_is_connected() &&
	    ++ota.seconds_since_report >= REPORT_RETRY_SECONDS) {
		send_final_report();
	}

#if defined(CONFIG_APP_PI_OTA)
	if (order.asked[0] != '\0' && ++order.seconds_asked >= REFRESH_TIMEOUT_SECONDS &&
	    cloud_is_connected()) {
		char again[OTA_JOB_ID_MAX + 1];

		memcpy(again, order.asked, sizeof(again));
		ask_for_list(again);
	}

	pi_ota_on_tick();

	{
		enum pi_err pi_result;

		if (pi_ota_bundle_take_result(&pi_result)) {
			on_pi_bundle_result(pi_result);
		}
	}

	/* The Pi's turn, and no document has come to start it: ask again. */
	if (ota.state == OTA_FLASHING_PI && !pi_ota_busy() &&
	    ota.seconds_in_state >= REFRESH_TIMEOUT_SECONDS && cloud_is_connected()) {
		ota.seconds_in_state = 0;
		(void)cloud_jobs_request_next();
	}
#endif
}

enum ota_state ota_state(void)
{
	return ota.state;
}

const char *ota_state_name(void)
{
	return state_names[ota.state];
}

const char *ota_job_id(void)
{
#if defined(CONFIG_APP_BT_OTA)
	/* What is left in ota.job is an older update's. */
	if (ota.state == OTA_BLUETOOTH) {
		return NULL;
	}
#endif

	if ((ota.state == OTA_TESTING || ota.state == OTA_FLASHING_PI) && ota.have_record) {
		return ota.record.job_id;
	}

	return (ota.state == OTA_IDLE || ota.job.id[0] == '\0') ? NULL : ota.job.id;
}

int ota_progress(void)
{
	return ota.state == OTA_DOWNLOADING || ota.state == OTA_VERIFYING ||
	       ota.state == OTA_COMMITTING || ota.state == OTA_REBOOTING ? ota.progress : 0;
}

const char *ota_last_result(void)
{
	return ota.last_result;
}

const char *ota_last_error(void)
{
	return ota.last_error;
}

bool ota_take_changed(void)
{
	bool changed = ota.changed;

	ota.changed = false;
	return changed;
}

uint32_t ota_stuck_progress(void)
{
	return (uint32_t)atomic_get(&stuck_progress);
}

#if defined(CONFIG_APP_TEST_FAULT_WIFI_DEAD)
bool ota_image_has_trailer(void)
{
	return primary_has_trailer();
}
#endif

#if defined(CONFIG_APP_BT_OTA)
bool ota_bt_has_job(void)
{
	return ota.have_record;
}

void ota_bt_enter(void)
{
	enter(OTA_BLUETOOTH);
}

void ota_bt_leave(void)
{
	if (ota.state == OTA_BLUETOOTH) {
		go_idle();
		/* A job that came up meanwhile was left where it was: see on_job(). */
		(void)cloud_jobs_request_next();
	}
}

int ota_bt_confirm(void)
{
	int err;

	if (ota.state != OTA_TESTING || ota.have_record ||
	    IS_ENABLED(CONFIG_APP_TEST_FAULT_NO_CONFIRM)) {
		return -EPERM;
	}

	err = boot_write_img_confirmed();
	if (err) {
		LOG_ERR("Image could not be confirmed: %d", err);
		return err;
	}

	health_trial_passed();
	LOG_INF("Firmware %s confirmed", fw_version_running_string());
	set_last("succeeded", "");
	go_idle();
	return 0;
}

enum bt_status_outcome ota_bt_cloud_update(struct fw_version *target)
{
	*target = ota.installed;
	return ota.installed_outcome;
}
#endif /* CONFIG_APP_BT_OTA */
