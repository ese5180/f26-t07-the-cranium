/*
 * Raspberry Pi image update: the board's glue (pi_ota.h, docs/pi-ota.md).
 *
 * What it decides is in the parts that the host tests cover: the job (ota_job.c, pi_image.c), the
 * download onto the card (pi_dl.c), the card's files (pi_sd.c), the protocol (pi_xfer.c) and the
 * order of jobs (ota.c). Here are the devices, the thread and the reports. It is built, and not
 * tested on hardware.
 *
 * The download is the firmware's own: the same fota_download library, the same HTTPS connection
 * and the same events, through ota.c. Only the image goes elsewhere: to a custom DFU target, the
 * dfu_target_custom_*() functions here, which write it to the SD card. The board's RAM is nearly
 * all taken (docs/pi-ota.md, "Memory"), so nothing of the downloader is here twice.
 *
 * Threads: the main loop calls everything in pi_ota.h. The downloader's thread calls the DFU
 * target. The thread here runs what blocks for long: the start of a download, which looks at the
 * card, and the transfer to the Pi. Each tells the main loop through `pending`, read by
 * pi_ota_on_tick().
 */

#include "pi_ota.h"

#include <errno.h>
#include <stdarg.h>
#include <string.h>

#include <dfu/dfu_target.h>
#include <dfu/dfu_target_custom.h>
#include <ff.h>
#include <net/fota_download.h>
#include <psa/crypto.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/fs/fs.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>

#include "app_events.h"
#include "cloud.h"
#include "pi_dl.h"
#include "pi_image.h"
#include "pi_key.h"
#include "pi_xfer.h"
#include "pi_sd.h"
#include "version.h"

LOG_MODULE_REGISTER(pi_ota, CONFIG_APP_LOG_LEVEL);

#define PI_OTA_NODE  DT_NODELABEL(pi_ota)
#define PI_XFER_NODE DT_NODELABEL(pi_xfer)

BUILD_ASSERT(DT_NODE_HAS_STATUS(PI_OTA_NODE, okay), "CONFIG_APP_PI_OTA needs the pi_ota node");
BUILD_ASSERT(DT_NODE_HAS_STATUS(PI_XFER_NODE, okay), "CONFIG_APP_PI_OTA needs the pi_xfer node");

#define CHUNK_SIZE         (CONFIG_APP_PI_OTA_CHUNK_KB * 1024)
#define MAX_SIZE           ((uint32_t)CONFIG_APP_PI_OTA_MAX_SIZE_MB * 1024u * 1024u)
#define RETRY_WAIT_SECONDS 10
#define REFRESH_SECONDS    20
/* A progress report on the job at most this often, and the shadow with it. */
#define REPORT_SECONDS     30

enum state {
	STATE_IDLE,
	/* The thread looks at the card: what is there already, and where to start. */
	STATE_PREPARING,
	STATE_DOWNLOADING,
	STATE_RETRY_WAIT,
	/* Asked for the job again, for a fresh download URL. */
	STATE_REFRESHING,
	STATE_SENDING,
};

static const char *const state_names[] = {
	[STATE_IDLE] = "idle",
	[STATE_PREPARING] = "downloading",
	[STATE_DOWNLOADING] = "downloading",
	[STATE_RETRY_WAIT] = "downloading",
	[STATE_REFRESHING] = "downloading",
	[STATE_SENDING] = "sending",
};

/* What the thread tells the main loop. */
enum event {
	EVENT_NONE,
	/* The card is ready: download from where it says. */
	EVENT_PREPARED,
	/* The whole image is on the card and good: send it. */
	EVENT_DOWNLOADED,
	/* Over: value is the pi_err. */
	EVENT_DONE,
};

static struct {
	enum state state;
	int seconds;
	struct pi_target target;
	bool waiting;
	uint8_t attempts;
	uint32_t received_at_attempt;
	int seconds_since_report;
	bool changed;
	/* Connected to AWS IoT at the last tick: each new connection reports "pi" afresh. */
	bool was_connected;
	char last_result[12];
	char last_error[24];
	char installed_version[OTA_PI_VERSION_MAX + 1];
	uint8_t installed_sha256[PI_SHA256_SIZE];
	bool installed_known;
	/* The Pi part of a job with board firmware too: ota.c sends the job's final status. */
	bool bundle;
	/* Send the image to the Pi once it is on the card; otherwise stop there. */
	bool flash;
	/* The outcome of the last step of a bundle, for pi_ota_bundle_take_result(). */
	bool bundle_done;
	enum pi_err bundle_result;
} pi;

/* Written by the threads, read on the main loop. */
static atomic_t pending_event;
static atomic_t pending_value;
static atomic_t progress_percent;
/* The DFU target accepts an image: only while a Pi image is being downloaded. */
static atomic_t expecting;
/* What the card said when the DFU target failed, for the report: a pi_err, or 0. */
static atomic_t target_error;
static volatile bool abort_requested;

static struct pi_dl dl;

enum work {
	WORK_PREPARE,
	WORK_SEND,
};

K_MSGQ_DEFINE(work_queue, sizeof(enum work), 2, 4);
static K_THREAD_STACK_DEFINE(pi_stack, CONFIG_APP_PI_OTA_STACK_SIZE);
static struct k_thread pi_thread;

/* ---- the devices --------------------------------------------------------------------------- */

static const struct gpio_dt_spec ready_gpio = GPIO_DT_SPEC_GET(PI_OTA_NODE, ready_gpios);
static const struct gpio_dt_spec card_detect = GPIO_DT_SPEC_GET(PI_OTA_NODE, cd_gpios);
static const struct spi_dt_spec link_spi =
	SPI_DT_SPEC_GET(PI_XFER_NODE, SPI_WORD_SET(8) | SPI_TRANSFER_MSB | SPI_OP_MODE_MASTER);
/* The same bus with no chip select at all: clocks that no device takes as its own. */
static const struct spi_config release_config = {
	.frequency = 400000,
	.operation = SPI_WORD_SET(8) | SPI_TRANSFER_MSB | SPI_OP_MODE_MASTER,
};

static struct gpio_callback ready_callback;
static K_SEM_DEFINE(ready_edge, 0, 1);

static FATFS fat_fs;
static struct fs_mount_t sd_mount = {
	.type = FS_FATFS,
	.fs_data = &fat_fs,
	.mnt_point = PI_SD_MOUNT,
};
static bool mounted;

/* A chunk of image and its frame: the largest thing here. */
static uint8_t frame_buf[CHUNK_SIZE + PI_XFER_FRAME_OVERHEAD] __aligned(4);

static void on_ready_edge(const struct device *port, struct gpio_callback *cb, uint32_t pins)
{
	ARG_UNUSED(port);
	ARG_UNUSED(cb);
	ARG_UNUSED(pins);
	k_sem_give(&ready_edge);
}

static bool card_present(void)
{
	return gpio_pin_get_dt(&card_detect) > 0;
}

/*
 * At least 8 clocks with both chip selects high: an SD card in SPI mode may hold DO (MISO) after its
 * transaction until it sees them, and the Pi is next on the bus.
 */
static void release_bus(void)
{
	static const uint8_t ones[2] = { 0xff, 0xff };
	const struct spi_buf buf = { .buf = (void *)ones, .len = sizeof(ones) };
	const struct spi_buf_set tx = { .buffers = &buf, .count = 1 };

	(void)spi_write(link_spi.bus, &release_config, &tx);
}

static int64_t now_ms(void)
{
	return k_uptime_get();
}

static const struct pi_sd_hooks sd_hooks = {
	.present = card_present,
	.release_bus = release_bus,
	.now_ms = now_ms,
};

static enum pi_err mount_card(void)
{
	int err;

	if (mounted) {
		return card_present() ? PI_OK : PI_ERR_SD_ABSENT;
	}

	if (!card_present()) {
		return PI_ERR_SD_ABSENT;
	}

	err = fs_mount(&sd_mount);
	release_bus();
	if (err) {
		LOG_WRN("The SD card could not be mounted: %d", err);
		return PI_ERR_SD_IO;
	}

	mounted = true;
	return PI_OK;
}

/* ---- the link's transport and source --------------------------------------------------------- */

static int link_transfer(void *ctx, const uint8_t *tx, uint8_t *rx, size_t len)
{
	const struct spi_buf tx_buf = { .buf = (void *)tx, .len = len };
	const struct spi_buf_set tx_set = { .buffers = &tx_buf, .count = 1 };
	struct spi_buf rx_buf = { .buf = rx, .len = len };
	const struct spi_buf_set rx_set = { .buffers = &rx_buf, .count = 1 };

	ARG_UNUSED(ctx);

	/* Whatever the card did last, it lets go of MISO now. */
	release_bus();
	k_sem_reset(&ready_edge);

	/* One transaction, by EasyDMA, with the Pi's chip select low throughout. */
	return spi_transceive_dt(&link_spi, &tx_set, rx != NULL ? &rx_set : NULL);
}

static int link_wait_ready(void *ctx, int timeout_ms)
{
	ARG_UNUSED(ctx);
	return k_sem_take(&ready_edge, K_MSEC(timeout_ms)) == 0 ? 0 : -ETIMEDOUT;
}

static bool link_ready(void *ctx)
{
	ARG_UNUSED(ctx);
	return gpio_pin_get_dt(&ready_gpio) > 0;
}

static const struct pi_xfer_transport transport = {
	.transfer = link_transfer,
	.wait_ready = link_wait_ready,
	.ready = link_ready,
};

static struct pi_sd_file image_file;

static enum pi_err source_read(void *ctx, uint32_t offset, uint8_t *buf, size_t len)
{
	ARG_UNUSED(ctx);
	return pi_sd_read_at(&image_file, offset, buf, len);
}

static const struct pi_xfer_source source = { .read = source_read };

static void on_link_progress(void *ctx, uint32_t sent, uint32_t total)
{
	ARG_UNUSED(ctx);
	atomic_set(&progress_percent, (atomic_val_t)((uint64_t)sent * 100 / total));
}

/* ---- the manifest's signature ---------------------------------------------------------------- */

static int verify_signature(const uint8_t *msg, size_t len, const uint8_t sig[OTA_PI_SIG_SIZE])
{
	psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
	psa_key_id_t key;
	psa_status_t status;

	psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_PUBLIC_KEY(PSA_ECC_FAMILY_SECP_R1));
	psa_set_key_bits(&attributes, 256);
	psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_VERIFY_MESSAGE);
	psa_set_key_algorithm(&attributes, PSA_ALG_ECDSA(PSA_ALG_SHA_256));

	status = psa_import_key(&attributes, pi_public_key, sizeof(pi_public_key), &key);
	if (status != PSA_SUCCESS) {
		LOG_ERR("The signing key could not be imported: %d", status);
		return -EIO;
	}

	status = psa_verify_message(key, PSA_ALG_ECDSA(PSA_ALG_SHA_256), msg, len, sig,
				    OTA_PI_SIG_SIZE);
	(void)psa_destroy_key(key);
	return status == PSA_SUCCESS ? 0 : -EBADMSG;
}

/* ---- the DFU target: the download's bytes onto the card, on the downloader's thread ------------ */

bool dfu_target_custom_identify(const void *const buf)
{
	ARG_UNUSED(buf);
	/* A Pi image has no header of its own: it is one if one is expected. */
	return atomic_get(&expecting) != 0;
}

static int target_failed(enum pi_err err)
{
	atomic_set(&target_error, err);
	return -EIO;
}

int dfu_target_custom_init(size_t file_size, int img_num, dfu_target_callback_t cb)
{
	uint32_t from;
	enum pi_err err = PI_OK;

	ARG_UNUSED(img_num);
	ARG_UNUSED(cb);

	if (file_size != dl.record.size) {
		return target_failed(PI_ERR_SIZE_MISMATCH);
	}

	/* After an attempt that failed, the file was closed: back to the last checkpoint. */
	if (!dl.image.open) {
		err = pi_dl_resume_point(&dl, true, &from);
	}

	return err == PI_OK ? 0 : target_failed(err);
}

int dfu_target_custom_offset_get(size_t *offset)
{
	*offset = dl.received;
	return 0;
}

int dfu_target_custom_write(const void *const buf, size_t len)
{
	enum pi_err err;

	if (abort_requested) {
		return -ECANCELED;
	}

	err = pi_dl_write(&dl, buf, len);
	if (err != PI_OK) {
		return target_failed(err);
	}

	if (dl.record.size > 0) {
		atomic_set(&progress_percent,
			   (atomic_val_t)((uint64_t)dl.received * 100 / dl.record.size));
	}
	return 0;
}

int dfu_target_custom_done(bool successful)
{
	enum pi_err err;

	if (!successful) {
		/* What is on the card stays: the next attempt goes on from it. */
		return 0;
	}

	err = pi_dl_finish(&dl);
	return err == PI_OK ? 0 : target_failed(err);
}

int dfu_target_custom_reset(void)
{
	enum pi_err err = pi_dl_reset(&dl);

	return err == PI_OK ? 0 : target_failed(err);
}

int dfu_target_custom_schedule_update(int img_num)
{
	ARG_UNUSED(img_num);
	/* Nothing to install on this board: the Pi gets it over SPI. */
	return 0;
}

/* ---- the thread ------------------------------------------------------------------------------ */

static void post(enum event event, int value)
{
	atomic_set(&pending_value, value);
	atomic_set(&pending_event, event);
}

static void send_to_pi(void)
{
	struct pi_xfer_image image = { .size = pi.target.size };
	struct pi_xfer_options options = {
		.chunk_size = CHUNK_SIZE,
		.buf = frame_buf,
		.buf_size = sizeof(frame_buf),
		.attempts = CONFIG_APP_PI_XFER_ATTEMPTS,
		.ready_timeout_ms = CONFIG_APP_PI_XFER_READY_TIMEOUT_MS,
		.begin_timeout_ms = CONFIG_APP_PI_XFER_BEGIN_TIMEOUT_MS,
		.verify_timeout_ms = CONFIG_APP_PI_XFER_VERIFY_TIMEOUT_MS,
		.abort = &abort_requested,
		.progress = on_link_progress,
	};
	struct pi_xfer_result result;
	enum pi_err err;

	memcpy(image.sha256, pi.target.sha256, PI_SHA256_SIZE);
	memcpy(image.version, pi.target.version, sizeof(image.version));

	err = pi_sd_open(&image_file, PI_SD_IMAGE, false, false);
	if (err != PI_OK) {
		post(EVENT_DONE, err);
		return;
	}

	atomic_set(&progress_percent, 0);
	pi_xfer_send(&transport, &source, &image, &options, &result);
	(void)pi_sd_close(&image_file);

	LOG_INF("Transfer to the Pi: %s, %u frames sent again, Pi code %u", pi_err_reason(result.err),
		result.resends, result.pi_code);
	if (result.err == PI_OK) {
		(void)pi_dl_mark_installed(pi.target.sha256, pi.target.version);
	}
	post(EVENT_DONE, result.err);
}

static void thread_main(void *a, void *b, void *c)
{
	enum work work;

	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);

	for (;;) {
		uint32_t from;
		bool complete;
		enum pi_err err;

		(void)k_msgq_get(&work_queue, &work, K_FOREVER);

		if (work == WORK_SEND) {
			send_to_pi();
			continue;
		}

		err = mount_card();
		if (err == PI_OK) {
			err = pi_dl_begin(&dl, &pi.target, &from, &complete);
		}
		if (err != PI_OK) {
			post(EVENT_DONE, err);
		} else {
			post(complete ? EVENT_DOWNLOADED : EVENT_PREPARED, (int)from);
		}
	}
}

static void give_work(enum work work)
{
	if (k_msgq_put(&work_queue, &work, K_NO_WAIT) != 0) {
		LOG_ERR("The Pi update's queue is full");
	}
}

/* ---- the reports ------------------------------------------------------------------------------ */

static void enter(enum state state)
{
	pi.state = state;
	pi.seconds = 0;
	pi.changed = true;
}

static void set_last(const char *result, const char *error)
{
	strncpy(pi.last_result, result, sizeof(pi.last_result) - 1);
	strncpy(pi.last_error, error, sizeof(pi.last_error) - 1);
	pi.changed = true;
}

static void job_update(const char *job_id, const char *status, const char *details_format, ...)
{
	char details[128];
	char body[192];
	va_list args;
	int written;

	va_start(args, details_format);
	written = vsnprintk(details, sizeof(details), details_format, args);
	va_end(args);
	if (written < 0 || written >= (int)sizeof(details)) {
		return;
	}

	written = snprintk(body, sizeof(body), "{\"status\":\"%s\",\"statusDetails\":{%s}}", status,
			   details);
	if (written > 0 && written < (int)sizeof(body)) {
		(void)cloud_jobs_update(job_id, body);
	}
}

static const char *state_name(void)
{
	if (pi.state == STATE_IDLE && pi.waiting) {
		return "waiting_for_firmware";
	}

	return state_names[pi.state];
}

static void report_shadow(void)
{
	/* The longest: every field at its limit, about 250 characters. */
	char reported[288];
	int written;

	/*
	 * "card" (1.20.0) says whether the card-detect switch sees a card. The console offers Pi
	 * images only to boards that report a "pi" object at all, which only a Pi build does.
	 */
	written = snprintk(reported, sizeof(reported),
			   "{\"pi\":{\"state\":\"%s\",\"job\":\"%s\",\"progress\":%d,\"last\":\"%s\","
			   "\"error\":\"%s\",\"installed\":\"%s\",\"card\":%s}}",
			   state_name(), pi.state == STATE_IDLE ? "" : pi.target.id,
			   (int)atomic_get(&progress_percent), pi.last_result, pi.last_error,
			   pi.installed_version, card_present() ? "true" : "false");
	if (written > 0 && written < (int)sizeof(reported)) {
		(void)cloud_shadow_report(reported);
	}
	pi.changed = false;
}

/* The step a job is told about: a Pi image's own, or the Pi part's of a job with firmware too. */
static const char *step_name(bool sending)
{
	if (pi.bundle) {
		return sending ? "flashing_pi" : "downloading_pi";
	}

	return sending ? "sending" : "downloading";
}

static void report_progress(const char *step)
{
	job_update(pi.target.id, "IN_PROGRESS", "\"step\":\"%s\",\"progress\":\"%d\"", step,
		   (int)atomic_get(&progress_percent));
	pi.seconds_since_report = 0;
}

/* A step of a bundle is over: ota.c takes the outcome and answers the job. */
static void finish_bundle(enum pi_err err)
{
	if (err == PI_OK && pi.flash) {
		LOG_INF("Pi image %s is on partition B and verified", pi.target.version);
		memcpy(pi.installed_sha256, pi.target.sha256, PI_SHA256_SIZE);
		memcpy(pi.installed_version, pi.target.version, sizeof(pi.installed_version));
		pi.installed_known = true;
		set_last("succeeded", "");
	} else if (err == PI_OK) {
		LOG_INF("Pi image %s is on the card: it goes to the Pi after the firmware",
			pi.target.version);
		set_last("downloaded", "");
	} else if (err != PI_ERR_ABORTED) {
		LOG_ERR("Pi image update failed: %s", pi_err_reason(err));
		set_last("failed", pi_err_reason(err));
	}

	pi.bundle_result = err;
	pi.bundle_done = true;
	atomic_set(&progress_percent, err == PI_OK ? 100 : 0);
	enter(STATE_IDLE);
	report_shadow();
}

static void finish(enum pi_err err)
{
	atomic_set(&expecting, 0);

	if (pi.bundle) {
		finish_bundle(err);
		return;
	}

	if (err == PI_OK) {
		LOG_INF("Pi image %s is on partition B and verified", pi.target.version);
		job_update(pi.target.id, "SUCCEEDED", "\"pi_version\":\"%s\",\"running\":\"%s\"",
			   pi.target.version, fw_version_running_string());
		memcpy(pi.installed_sha256, pi.target.sha256, PI_SHA256_SIZE);
		memcpy(pi.installed_version, pi.target.version, sizeof(pi.installed_version));
		pi.installed_known = true;
		set_last("succeeded", "");
	} else if (err == PI_ERR_ABORTED) {
		set_last("cancelled", "");
	} else {
		LOG_ERR("Pi image update failed: %s", pi_err_reason(err));
		job_update(pi.target.id, "FAILED", "\"reason\":\"%s\",\"running\":\"%s\"",
			   pi_err_reason(err), fw_version_running_string());
		set_last("failed", pi_err_reason(err));
	}

	atomic_set(&progress_percent, err == PI_OK ? 100 : 0);
	enter(STATE_IDLE);
	report_shadow();
	(void)cloud_jobs_request_next();
}

/* Download from where the card says, with the URL that the last job document brought. */
static void start_download(const struct ota_job *job)
{
	int err;

	atomic_set(&target_error, PI_OK);
	atomic_set(&expecting, 1);
	enter(STATE_DOWNLOADING);
	LOG_INF("Downloading Pi image %s from byte %u of %u", pi.target.version, dl.received,
		pi.target.size);

	/* HTTPS with the root CA's security tag, as the firmware's own download. */
	err = fota_download_start_with_image_type(job->host, job->file, CONFIG_APP_DOWNLOAD_SEC_TAG,
						  0, 0, DFU_TARGET_IMAGE_TYPE_CUSTOM);
	if (err) {
		LOG_WRN("The Pi image download could not start: %d", err);
		enter(STATE_RETRY_WAIT);
	}
}

/* ---- pi_ota.h -------------------------------------------------------------------------------- */

int pi_ota_init(void)
{
	struct pi_record record;
	int err;

	pi_sd_set_hooks(&sd_hooks);
	set_last("none", "");

	if (!gpio_is_ready_dt(&ready_gpio) || !gpio_is_ready_dt(&card_detect) ||
	    !spi_is_ready_dt(&link_spi)) {
		LOG_ERR("The Pi's SPI bus or its pins are not ready");
		return -ENODEV;
	}

	err = gpio_pin_configure_dt(&ready_gpio, GPIO_INPUT);
	err = err ? err : gpio_pin_configure_dt(&card_detect, GPIO_INPUT);
	err = err ? err : gpio_pin_interrupt_configure_dt(&ready_gpio, GPIO_INT_EDGE_TO_ACTIVE);
	if (err) {
		return err;
	}
	gpio_init_callback(&ready_callback, on_ready_edge, BIT(ready_gpio.pin));
	err = gpio_add_callback(ready_gpio.port, &ready_callback);
	if (err) {
		return err;
	}

	/* What the Pi got last, so that the same image is not sent again. */
	if (mount_card() == PI_OK && pi_dl_load_record(&record) == PI_OK &&
	    record.installed_version[0] != '\0') {
		memcpy(pi.installed_sha256, record.installed_sha256, PI_SHA256_SIZE);
		memcpy(pi.installed_version, record.installed_version, sizeof(pi.installed_version));
		pi.installed_known = true;
	} else if (!card_present()) {
		LOG_WRN("No SD card: a Pi image cannot be updated until one is in");
	}

	k_thread_create(&pi_thread, pi_stack, K_THREAD_STACK_SIZEOF(pi_stack), thread_main, NULL,
			NULL, NULL, K_LOWEST_APPLICATION_THREAD_PRIO, 0, K_NO_WAIT);
	k_thread_name_set(&pi_thread, "pi_ota");
	return 0;
}

void pi_ota_on_job(const struct ota_job *job)
{
	enum pi_err verdict;

	if (pi.state != STATE_IDLE) {
		if (pi.state == STATE_REFRESHING && strcmp(job->id, pi.target.id) == 0 &&
		    job->pi_size == pi.target.size &&
		    memcmp(job->pi_sha256, pi.target.sha256, PI_SHA256_SIZE) == 0) {
			/* The fresh URL: go on from where the last attempt stopped. */
			start_download(job);
		}
		return;
	}

	verdict = pi_job_check(job, MAX_SIZE, fw_version_running(),
			       pi.installed_known ? pi.installed_sha256 : NULL, verify_signature);
	pi_target_from_job(&pi.target, job);
	pi.waiting = false;
	if (verdict != PI_OK) {
		LOG_WRN("Refusing Pi image job %s: %s", job->id, pi_err_reason(verdict));
		job_update(job->id, job->in_progress ? "FAILED" : "REJECTED",
			   "\"reason\":\"%s\",\"running\":\"%s\"", pi_err_reason(verdict),
			   fw_version_running_string());
		set_last("refused", pi_err_reason(verdict));
		report_shadow();
		return;
	}

	LOG_INF("Pi image %s (%u bytes) is available: getting it", job->pi_version, job->pi_size);
	pi.bundle = false;
	pi.flash = true;
	abort_requested = false;
	atomic_set(&pending_event, EVENT_NONE);
	atomic_set(&progress_percent, 0);
	pi.attempts = 0;
	pi.received_at_attempt = 0;
	/* Only until the thread has looked at the card: the next document brings a fresh URL. */
	enter(STATE_PREPARING);
	report_progress(step_name(false));
	report_shadow();
	give_work(WORK_PREPARE);
}

enum pi_err pi_ota_bundle_check(const struct ota_job *job)
{
	return pi_job_check(job, MAX_SIZE, &job->version,
			    pi.installed_known ? pi.installed_sha256 : NULL, verify_signature);
}

void pi_ota_bundle(const struct ota_job *job, enum pi_ota_bundle_step step)
{
	if (pi.state != STATE_IDLE) {
		if (pi.state == STATE_REFRESHING && strcmp(job->id, pi.target.id) == 0 &&
		    job->pi_size == pi.target.size &&
		    memcmp(job->pi_sha256, pi.target.sha256, PI_SHA256_SIZE) == 0) {
			start_download(job);
		}
		return;
	}

	pi_target_from_job(&pi.target, job);
	pi.bundle = true;
	pi.flash = step == PI_OTA_BUNDLE_FLASH;
	pi.bundle_done = false;
	pi.waiting = false;
	abort_requested = false;
	atomic_set(&pending_event, EVENT_NONE);
	atomic_set(&progress_percent, 0);
	pi.attempts = 0;
	pi.received_at_attempt = 0;
	LOG_INF("Pi image %s of job %s: %s", pi.target.version, pi.target.id,
		pi.flash ? "to the Pi" : "onto the card");
	/* The card says whether anything is left to download (EVENT_PREPARED or EVENT_DOWNLOADED). */
	enter(STATE_PREPARING);
	report_progress(step_name(pi.flash));
	report_shadow();
	give_work(WORK_PREPARE);
}

bool pi_ota_bundle_take_result(enum pi_err *err)
{
	if (!pi.bundle_done) {
		return false;
	}

	pi.bundle_done = false;
	*err = pi.bundle_result;
	return true;
}

const char *pi_ota_installed_version(void)
{
	return pi.installed_version;
}

bool pi_ota_busy(void)
{
	return pi.state != STATE_IDLE;
}

bool pi_ota_owns(const char *job_id)
{
	return pi.state != STATE_IDLE && strcmp(job_id, pi.target.id) == 0;
}

void pi_ota_withdrawn(void)
{
	if (pi.state == STATE_IDLE) {
		return;
	}

	LOG_INF("Pi image job %s was withdrawn", pi.target.id);
	pi.bundle_done = false;
	abort_requested = true;
	if (pi.state == STATE_DOWNLOADING) {
		(void)fota_download_cancel();
	}
	atomic_set(&expecting, 0);
	/* The thread sees the flag and tells the Pi to drop what it has. */
	set_last("cancelled", "");
	enter(STATE_IDLE);
	report_shadow();
}

void pi_ota_set_waiting(bool waiting)
{
	if (pi.waiting != waiting) {
		pi.waiting = waiting;
		pi.changed = true;
	}
}

void pi_ota_on_download(enum app_download_event what, int value)
{
	enum pi_err err;

	if (pi.state != STATE_DOWNLOADING) {
		return;
	}

	switch (what) {
	case APP_DOWNLOAD_PROGRESS:
		pi.changed = true;
		break;
	case APP_DOWNLOAD_FINISHED:
		/* dfu_target_custom_done() has checked the size and the digest. */
		atomic_set(&expecting, 0);
		atomic_set(&progress_percent, 0);
		if (!pi.flash) {
			/* The first step of a bundle: on the card is as far as it goes for now. */
			finish(PI_OK);
			break;
		}
		enter(STATE_SENDING);
		report_progress(step_name(true));
		give_work(WORK_SEND);
		break;
	case APP_DOWNLOAD_ERROR:
		atomic_set(&expecting, 0);
		err = (enum pi_err)atomic_get(&target_error);
		if (err != PI_OK) {
			/* The card, or the image itself: no new attempt fixes that. */
			finish(err);
			break;
		}
		/* Bytes that got onto the card since the last attempt start the count again. */
		if (dl.received > pi.received_at_attempt) {
			pi.attempts = 0;
		}
		pi.received_at_attempt = dl.received;
		if (++pi.attempts >= CONFIG_APP_PI_OTA_DOWNLOAD_ATTEMPTS) {
			pi_dl_close(&dl);
			finish(PI_ERR_DOWNLOAD);
			break;
		}
		LOG_WRN("Pi image download stopped (%d): going on in %d s", value,
			RETRY_WAIT_SECONDS);
		enter(STATE_RETRY_WAIT);
		break;
	default:
		break;
	}
}

static void on_event(enum event event, int value)
{
	switch (event) {
	case EVENT_PREPARED:
		if (pi.state == STATE_PREPARING) {
			/* A fresh URL for the download, which starts when the document comes. */
			enter(STATE_REFRESHING);
			(void)cloud_jobs_request_next();
		}
		break;
	case EVENT_DOWNLOADED:
		if (pi.state == STATE_PREPARING && !pi.flash) {
			LOG_INF("The image is on the card already");
			finish(PI_OK);
		} else if (pi.state == STATE_PREPARING) {
			LOG_INF("The image is on the card already: sending it");
			atomic_set(&progress_percent, 0);
			enter(STATE_SENDING);
			report_progress(step_name(true));
			give_work(WORK_SEND);
		}
		break;
	case EVENT_DONE:
		if (pi.state == STATE_PREPARING || pi.state == STATE_SENDING) {
			finish((enum pi_err)value);
		}
		break;
	default:
		ARG_UNUSED(value);
		break;
	}
}

void pi_ota_on_tick(void)
{
	enum event event = (enum event)atomic_set(&pending_event, EVENT_NONE);

	if (event != EVENT_NONE) {
		on_event(event, (int)atomic_get(&pending_value));
	}

	pi.seconds++;
	switch (pi.state) {
	case STATE_RETRY_WAIT:
		if (pi.seconds >= RETRY_WAIT_SECONDS) {
			enter(STATE_REFRESHING);
			(void)cloud_jobs_request_next();
		}
		break;
	case STATE_REFRESHING:
		if (pi.seconds >= REFRESH_SECONDS) {
			pi.seconds = 0;
			(void)cloud_jobs_request_next();
		}
		break;
	case STATE_DOWNLOADING:
	case STATE_SENDING:
		if (++pi.seconds_since_report >= REPORT_SECONDS && cloud_is_connected()) {
			report_progress(step_name(pi.state == STATE_SENDING));
			pi.changed = true;
		}
		break;
	default:
		break;
	}

	/*
	 * Each new connection reports "pi", changed or not: the console counts a board as one with a Pi
	 * only when "pi" was reported since the board last started (docs/pi-ota.md, "Reports").
	 */
	bool connected = cloud_is_connected();

	if (connected && !pi.was_connected) {
		pi.changed = true;
	}
	pi.was_connected = connected;

	if (pi.changed && connected) {
		report_shadow();
	}
}
