/*
 * Raspberry Pi delta updates on a board: see pi_delta_ota.h.
 *
 * The update (pi_delta.c) runs on this module's thread and fetches its ranges here, over one TLS
 * connection kept alive between them (pi_http.h says why not the firmware's downloader). A range
 * that fails ends the call; the main loop then asks the cloud for the job again, for a fresh
 * presigned URL, and calls again, which goes on from what the card says. A call that got nothing
 * further counts as a failed attempt; CONFIG_APP_PI_DELTA_DOWNLOAD_ATTEMPTS of them in a row fail
 * the job.
 *
 * From 1.20.2 the same thread, downloader and retries also run a "pi_os" job (pi_os.h): one file into
 * the card's file area. Once it is there and checked, the job is offered to the Pi and waits, on the
 * main loop, for what the Pi says: the result of that file, or a status that shows it runs it.
 */

#include "pi_delta_ota.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

#include <psa/crypto.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/socket.h>
#include <zephyr/net/tls_credentials.h>
#include <zephyr/sys/atomic.h>

#include "cloud.h"
#include "pi_card.h"
#include "pi_card_disk.h"
#include "pi_delta.h"
#include "pi_frame.h"
#include "pi_link.h"
#include "pi_http.h"
#include "pi_os.h"
#include "pi_key.h"
#include "version.h"

LOG_MODULE_REGISTER(pi_delta, CONFIG_APP_LOG_LEVEL);

#define URL_SCHEME            "https://"
#define REPORT_SECONDS        30
#define URL_WAIT_SECONDS      20
#define RETRY_WAIT_SECONDS    10
/* The longest the heartbeat waits for the card's lock: a card operation in progress ends sooner. */
#define REPORT_LOCK_MS        500
/* The longest a tick waits for it while a Pi OS update is offered: the next tick looks again. */
#define WATCH_LOCK_MS         50

enum phase {
	PHASE_IDLE,
	/* The thread runs the update. */
	PHASE_RUNNING,
	/* The last call failed to download: waiting to ask for the job again, for a fresh URL. */
	PHASE_RETRY_WAIT,
	/* Asked for the job again: waiting for it. */
	PHASE_REFRESHING,
	/* A Pi OS update's file is on the card and offered: waiting for the Pi. The thread is idle. */
	PHASE_OFFERED,
};

static const struct pi_delta_config config = {
	.default_max_blocks = CONFIG_APP_PI_DELTA_MAX_BLOCKS,
	.run_blocks = CONFIG_APP_PI_DELTA_RUN_BLOCKS,
	.block_attempts = 3,
	.skip_save_every = 64,
	.table_save_every = 64,
};

static const struct pi_os_config os_config = {
	.default_max_blocks = CONFIG_APP_PI_DELTA_MAX_BLOCKS,
	/* 32 KiB: a power cut costs that much of the file at most. */
	.save_every = 64,
	/* A file that reads back wrong is downloaded once more before the job fails. */
	.attempts = 2,
};

static struct {
	enum phase phase;
	int seconds;
	int since_report;
	char job_id[OTA_JOB_ID_MAX + 1];
	char closed_id[OTA_JOB_ID_MAX + 1];
	/* From 1.20.2: the job is a Pi OS update (os_job), not a delta update (job). */
	bool os_kind;
	/* A Pi OS update, once offered: what its reports said last (enum pi_os_watch, bytes read). */
	uint8_t watch;
	/* Both start with the version, so job.version is the version of either. */
	union {
		struct pi_delta_job job;
		struct pi_os_job os_job;
	};
	uint32_t offered_generation;
	uint32_t watch_read;
	/* "https://" and the host; the path and query. Only changed while the thread is idle. */
	char host[OTA_JOB_HOST_MAX + 1];
	char file[OTA_JOB_FILE_MAX + 1];
	uint8_t attempts;
	bool withdrawn;
	bool card_ok;
	uint32_t mark;
	/* Set by the thread when a call ends. */
	atomic_t done;
	enum pi_err result;
} pi;

static volatile bool stop;
static struct pi_card card;
static struct pi_delta delta;
/* Pi OS updates (pi_os.h): lent the delta update's sector, as the thread runs one at a time. */
static struct pi_os os;
static int sock = -1;
/* A response's head, then pieces of its body. */
static uint8_t http_buf[CONFIG_APP_PI_DELTA_HTTP_BUF];

static K_THREAD_STACK_DEFINE(thread_stack, CONFIG_APP_PI_DELTA_STACK_SIZE);
static struct k_thread thread;
static K_SEM_DEFINE(start, 0, 1);
/* The thread is asked only to read the card again (one put in while idle), not to update it. */
static atomic_t open_only;
/* How often an idle board looks at the card-detect switch and, with a card in, at the card. */
#define CARD_CHECK_SECONDS 5

/* ------------------------------------------------------------------------------------------- */
/* The signature: the project's firmware signing key, with PSA.                                  */

static bool verify_signature(const uint8_t *msg, size_t len, const uint8_t sig[PI_SIG_SIZE])
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
		LOG_ERR("The Pi image key could not be imported: %d", (int)status);
		return false;
	}
	status = psa_verify_message(key, PSA_ALG_ECDSA(PSA_ALG_SHA_256), msg, len, sig, PI_SIG_SIZE);
	(void)psa_destroy_key(key);
	return status == PSA_SUCCESS;
}

/* ------------------------------------------------------------------------------------------- */
/* Range requests, on the thread                                                                */

static const char *host_name(void)
{
	return pi.host + strlen(URL_SCHEME);
}

static void http_close(void)
{
	if (sock >= 0) {
		(void)zsock_close(sock);
		sock = -1;
	}
}

static int http_connect(void)
{
	static const sec_tag_t tags[] = { CONFIG_APP_DOWNLOAD_SEC_TAG };
	struct zsock_addrinfo hints = { .ai_family = NET_AF_INET, .ai_socktype = NET_SOCK_STREAM };
	struct zsock_addrinfo *ai = NULL;
	struct zsock_timeval timeout = { .tv_sec = CONFIG_APP_PI_DELTA_HTTP_TIMEOUT_S };
	int verify = ZSOCK_TLS_PEER_VERIFY_REQUIRED;
	int err;

	err = zsock_getaddrinfo(host_name(), "443", &hints, &ai);
	if (err != 0 || ai == NULL) {
		LOG_WRN("Could not resolve the image's host: %d", err);
		return -EHOSTUNREACH;
	}
	sock = zsock_socket(ai->ai_family, NET_SOCK_STREAM, NET_IPPROTO_TLS_1_2);
	if (sock < 0) {
		zsock_freeaddrinfo(ai);
		return -errno;
	}
	err = zsock_setsockopt(sock, ZSOCK_SOL_TLS, ZSOCK_TLS_SEC_TAG_LIST, tags, sizeof(tags));
	if (err == 0) {
		err = zsock_setsockopt(sock, ZSOCK_SOL_TLS, ZSOCK_TLS_HOSTNAME, host_name(),
				       strlen(host_name()));
	}
	if (err == 0) {
		err = zsock_setsockopt(sock, ZSOCK_SOL_TLS, ZSOCK_TLS_PEER_VERIFY, &verify,
				       sizeof(verify));
	}
	if (err == 0) {
		err = zsock_setsockopt(sock, ZSOCK_SOL_SOCKET, ZSOCK_SO_RCVTIMEO, &timeout,
				       sizeof(timeout));
	}
	if (err == 0) {
		err = zsock_setsockopt(sock, ZSOCK_SOL_SOCKET, ZSOCK_SO_SNDTIMEO, &timeout,
				       sizeof(timeout));
	}
	if (err == 0) {
		err = zsock_connect(sock, ai->ai_addr, ai->ai_addrlen);
	}
	zsock_freeaddrinfo(ai);
	if (err != 0) {
		err = -errno;
		LOG_WRN("Could not connect for the Pi image: %d", err);
		http_close();
		return err;
	}
	return 0;
}

static int send_all(const void *data, size_t len)
{
	const uint8_t *at = data;

	while (len > 0) {
		ssize_t sent = zsock_send(sock, at, len, 0);

		if (sent <= 0) {
			return sent == 0 ? -ECONNRESET : -errno;
		}
		at += sent;
		len -= (size_t)sent;
	}
	return 0;
}

/* Send the request and read the head of the answer into http_buf. *have: bytes read in all. */
static int request(uint64_t first, uint64_t last, size_t *head_end, size_t *have)
{
	char tail[128 + OTA_JOB_HOST_MAX];
	int length = pi_http_request_tail(tail, sizeof(tail), host_name(), first, last);
	int err;

	if (length < 0) {
		return -ENOMEM;
	}
	err = send_all("GET /", 5);
	if (err == 0) {
		err = send_all(pi.file, strlen(pi.file));
	}
	if (err == 0) {
		err = send_all(tail, (size_t)length);
	}
	*have = 0;
	while (err == 0 && (*head_end = pi_http_head_end((const char *)http_buf, *have)) == 0) {
		ssize_t got;

		if (*have == sizeof(http_buf)) {
			return -E2BIG;
		}
		got = zsock_recv(sock, http_buf + *have, sizeof(http_buf) - *have, 0);
		if (got <= 0) {
			err = got == 0 ? -ECONNRESET : -errno;
			break;
		}
		*have += (size_t)got;
	}
	return err;
}

static int fetch_get(void *ctx, uint64_t offset, uint64_t len, pi_sink_fn sink, void *sink_ctx)
{
	uint64_t last = offset + len - 1;
	struct pi_http_head head;
	size_t head_end = 0;
	size_t have = 0;
	uint64_t left = len;
	int verdict = 0;
	int err = -ECONNRESET;

	ARG_UNUSED(ctx);
	/* A kept-alive connection the server has closed since: once more, on a new one. */
	for (int attempt = 0; attempt < 2 && err != 0; attempt++) {
		if (stop) {
			return -EINTR;
		}
		if (sock < 0) {
			err = http_connect();
			if (err != 0) {
				return err;
			}
		}
		err = request(offset, last, &head_end, &have);
		if (err != 0) {
			http_close();
			if (have > 0 || (err != -ECONNRESET && err != -EPIPE && err != -ENOTCONN)) {
				return err;
			}
		}
	}
	if (err != 0) {
		return err;
	}
	if (pi_http_parse_head((const char *)http_buf, head_end, &head) != 0) {
		http_close();
		return -EBADMSG;
	}
	if (!pi_http_is_range(&head, offset, last)) {
		LOG_WRN("Range %llu-%llu: HTTP %d", (unsigned long long)offset, (unsigned long long)last,
			head.status);
		http_close();
		/* 403: the presigned URL has expired, and the job is asked for again. */
		return head.status == 403 ? -EACCES : -EBADMSG;
	}

	if (have > head_end) {
		size_t extra = have - head_end;

		if (extra > left) {
			http_close();
			return -EBADMSG;
		}
		left -= extra;
		verdict = sink(sink_ctx, http_buf + head_end, extra);
	}
	while (left > 0 && verdict == 0) {
		size_t want = left < sizeof(http_buf) ? (size_t)left : sizeof(http_buf);
		ssize_t got = zsock_recv(sock, http_buf, want, 0);

		if (got <= 0) {
			http_close();
			return got == 0 ? -ECONNRESET : -errno;
		}
		left -= (uint64_t)got;
		verdict = sink(sink_ctx, http_buf, (size_t)got);
	}
	if (left > 0 || head.close) {
		/* Bytes of this answer are still on their way: the connection is no use for the next. */
		http_close();
	}
	return verdict < 0 ? -EINTR : 0;
}

static const struct pi_fetch fetch = { .get = fetch_get };

static void thread_main(void *a, void *b, void *c)
{
	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);

	for (;;) {
		bool already = false;
		enum pi_err err;

		(void)k_sem_take(&start, K_FOREVER);
		if (atomic_cas(&open_only, 1, 0)) {
			if (pi_card_open(&card, CONFIG_APP_PI_DELTA_MAX_BLOCKS) == PI_OK) {
				LOG_INF("Pi image card: %s, generation %u",
					card.st.state == PI_STATE_READY ? card.cur.version : "no image",
					(unsigned int)card.st.generation);
			}
			continue;
		}
		err = pi.os_kind ? pi_os_run(&os, &pi.os_job) : pi_delta_run(&delta, &pi.job, &already);
		http_close();
		pi.result = err;
		pi.card_ok = card.open;
		atomic_set(&pi.done, 1);
	}
}

/* ------------------------------------------------------------------------------------------- */
/* The job, on the main loop                                                                    */

static void job_update(const char *status, const char *details)
{
	char body[320];
	int written = snprintf(body, sizeof(body), "{\"status\":\"%s\",\"statusDetails\":{%s}}", status,
			       details);

	/* Never so: the longest details (finish_succeeded()'s) make 266 bytes. */
	if (written < 0 || written >= (int)sizeof(body)) {
		return;
	}
	if (cloud_jobs_update(pi.job_id, body) != 0) {
		LOG_WRN("Pi job %s: the report did not go out", pi.job_id);
	}
}

/* Either kind's progress: blocks of a delta update, bytes of an OS update's file. */
static void report_progress(void)
{
	char details[160];

	if (pi_os_details_progress(details, sizeof(details),
				   pi.os_kind ? pi_os_step_name(os.step) : pi_step_name(delta.step),
				   pi.os_kind ? os.done : delta.stats.blocks_done,
				   pi.os_kind ? os.size : delta.stats.blocks_total) > 0) {
		job_update("IN_PROGRESS", details);
	}
	pi.since_report = 0;
}

/* A Pi OS update's file stays on the card, but the Pi is offered nothing without a job. */
static void stop_offering(void)
{
	if (pi.os_kind) {
		pi_card_lock(&card);
		card.file.offered = false;
		pi_card_unlock(&card);
	}
}

static void finish(void)
{
	stop_offering();
	strncpy(pi.closed_id, pi.job_id, sizeof(pi.closed_id) - 1);
	pi.phase = PHASE_IDLE;
	(void)cloud_jobs_request_next();
}

static void finish_succeeded(void)
{
	char details[224];

	if (pi.os_kind) {
		(void)pi_os_details_succeeded(details, sizeof(details), pi.os_job.version,
					      pi.offered_generation, os.bytes_fetched, pi.watch_read,
					      fw_version_running_string());
		job_update("SUCCEEDED", details);
		finish();
		return;
	}
	(void)snprintf(details, sizeof(details),
		       "\"pi_version\":\"%s\",\"generation\":\"%u\",\"fetched\":\"%u\",\"changed\":\"%u\","
		       "\"bytes\":\"%llu\",\"running\":\"%s\"",
		       pi.job.version, (unsigned int)card.st.generation,
		       (unsigned int)delta.stats.blocks_fetched, (unsigned int)delta.stats.changed,
		       (unsigned long long)delta.stats.bytes_fetched, fw_version_running_string());
	/* fetched says whether it was there already (0). */
	LOG_INF("Pi image %s is on the card", pi.job.version);
	job_update("SUCCEEDED", details);
	finish();
}

static void finish_failed(enum pi_err err)
{
	char details[160];

	(void)snprintf(details, sizeof(details), "\"reason\":\"%s\",\"step\":\"%s\",\"running\":\"%s\"",
		       pi_err_reason(err),
		       pi.os_kind ? pi_os_step_name(os.step) : pi_step_name(delta.step),
		       fw_version_running_string());
	LOG_ERR("Pi job %s failed: %s", pi.job_id, pi_err_reason(err));
	job_update("FAILED", details);
	finish();
}

static void run(void)
{
	atomic_set(&open_only, 0);
	stop = false;
	pi.withdrawn = false;
	pi.phase = PHASE_RUNNING;
	pi.seconds = 0;
	atomic_set(&pi.done, 0);
	k_sem_give(&start);
}

/* A job named again, for a fresh URL, is for what the one under way was after. */
static bool same_target(const struct ota_job *job)
{
	if (job->pi_os != pi.os_kind || strcmp(job->pi_version, pi.job.version) != 0) {
		return false;
	}
	if (pi.os_kind) {
		return memcmp(job->sha256, pi.os_job.sha256, PI_HASH_SIZE) == 0 &&
		       memcmp(job->pi_from, pi.os_job.from, sizeof(pi.os_job.from)) == 0 &&
		       job->size == pi.os_job.size;
	}
	return memcmp(job->sha256, pi.job.sha256, PI_HASH_SIZE) == 0;
}

/* A Pi OS update: the Pi's last status says it runs the job's version, off trial. */
static bool pi_runs_job(void)
{
	bool runs;

	if (pi_card_disk_lock_within(WATCH_LOCK_MS) != 0) {
		return false;
	}
	runs = pi_os_pi_runs(&card, pi.os_job.version);
	pi_card_unlock(&card);
	return runs;
}

void pi_delta_ota_on_job(const struct ota_job *job)
{
	if (strcmp(job->id, pi.closed_id) == 0) {
		return;
	}
	if (pi.phase != PHASE_IDLE) {
		if (strcmp(job->id, pi.job_id) != 0) {
			/* AWS IoT names the job in progress first: another one means it is gone. */
			pi_delta_ota_withdrawn();
			return;
		}
		if (pi.phase == PHASE_REFRESHING || pi.phase == PHASE_RETRY_WAIT) {
			/* The fresh URL. The image has to be the one the call before was after. */
			if (!same_target(job)) {
				finish_failed(PI_ERR_MANIFEST_MISMATCH);
				return;
			}
			memcpy(pi.host, job->host, sizeof(pi.host));
			memcpy(pi.file, job->file, sizeof(pi.file));
			run();
		}
		return;
	}

	memset(&pi.os_job, 0, sizeof(pi.os_job));
	memcpy(pi.job_id, job->id, sizeof(pi.job_id));
	pi.os_kind = job->pi_os;
	if (pi.os_kind) {
		memcpy(pi.os_job.version, job->pi_version, sizeof(pi.os_job.version));
		memcpy(pi.os_job.from, job->pi_from, sizeof(pi.os_job.from));
		memcpy(pi.os_job.sha256, job->sha256, PI_HASH_SIZE);
		pi.os_job.size = job->size;
		pi.os_job.tag = pi_crc32((const uint8_t *)job->id, strlen(job->id));
	} else {
		memcpy(pi.job.version, job->pi_version, sizeof(pi.job.version));
		memcpy(pi.job.sha256, job->sha256, PI_HASH_SIZE);
	}
	memcpy(pi.host, job->host, sizeof(pi.host));
	memcpy(pi.file, job->file, sizeof(pi.file));
	pi.attempts = 0;
	pi.mark = 0;
	pi.offered_generation = 0;
	pi.watch = PI_OS_WAIT_CARD;
	pi.watch_read = 0;
	os.bytes_fetched = 0;
	LOG_INF("Pi %s %s: %s", pi.os_kind ? "OS" : "image", pi.job.version,
		job->in_progress ? "going on" : "starting");
	job_update("IN_PROGRESS", pi.os_kind ? "\"step\":\"download\"" : "\"step\":\"manifest\"");
	pi.since_report = 0;
	if (pi.os_kind && pi_runs_job()) {
		/* The Pi said it runs this version already: nothing to download. */
		pi.phase = PHASE_RUNNING;
		finish_succeeded();
		return;
	}
	run();
}

bool pi_delta_ota_busy(void)
{
	return pi.phase != PHASE_IDLE;
}

void pi_delta_ota_withdrawn(void)
{
	if (pi.phase == PHASE_IDLE) {
		return;
	}
	LOG_INF("Pi job %s was withdrawn", pi.job_id);
	pi.withdrawn = true;
	stop_offering();
	if (pi.phase == PHASE_RUNNING) {
		/* The thread stops at its next piece; on_tick() then goes idle. */
		stop = true;
	} else {
		pi.phase = PHASE_IDLE;
	}
}

/* ------------------------------------------------------------------------------------------- */
/* A Pi OS update, offered: on the main loop, while the thread is idle                          */

static void report_offer(uint8_t watch, uint32_t read)
{
	char details[160];

	if (pi_os_details_offer(details, sizeof(details), watch, pi.offered_generation, read,
				pi.os_job.size) > 0) {
		job_update("IN_PROGRESS", details);
	}
	pi.watch = watch;
	pi.watch_read = read;
	pi.since_report = 0;
}

static void finish_refused(uint8_t result, const char *reason)
{
	char details[160];

	(void)pi_os_details_failed(details, sizeof(details), result, reason,
				   fw_version_running_string());
	LOG_ERR("Pi job %s: the Pi says %s (%s)", pi.job_id, pi_os_result_name(result), reason);
	job_update("FAILED", details);
	finish();
}

/* The file is on the card and checked: the Pi may take it now. */
static void offer(void)
{
	pi.offered_generation = os.generation;
	pi_card_lock(&card);
	if (card.open && card.file.state == PI_FILE_READY &&
	    card.file.generation == pi.offered_generation) {
		card.file.offered = true;
	}
	pi_card_unlock(&card);
	LOG_INF("Pi OS %s: offered to the Pi (generation %u)", pi.os_job.version,
		(unsigned int)pi.offered_generation);
	pi.phase = PHASE_OFFERED;
	pi.seconds = 0;
	report_offer(PI_OS_OFFERED, 0);
}

/* What the Pi has done with the offered file, once a second. */
static void watch_offer(void)
{
	char reason[PI_OS_REASON_MAX + 1];
	enum pi_os_watch watch;
	uint8_t result;
	uint32_t read;

	if (pi_card_disk_lock_within(WATCH_LOCK_MS) != 0) {
		return;
	}
	/* Offered again after the card was taken out and put back, if it still holds the file. */
	if (card.open && card.file.state == PI_FILE_READY &&
	    card.file.generation == pi.offered_generation) {
		card.file.offered = true;
	}
	watch = pi_os_watch(&card, &pi.os_job, pi.offered_generation);
	result = card.file.result;
	read = card.file.read;
	memcpy(reason, card.file.reason, sizeof(reason));
	pi_card_unlock(&card);

	switch (watch) {
	case PI_OS_SUCCEEDED:
		pi.watch_read = read > pi.watch_read ? read : pi.watch_read;
		finish_succeeded();
		break;
	case PI_OS_FAILED:
		finish_refused(result, reason);
		break;
	case PI_OS_LOST:
		/* Another card, or the file gone from it: take the file again, and offer it again. */
		run();
		break;
	case PI_OS_WAIT_CARD:
		break;
	default:
		if (watch != pi.watch ||
		    (read != pi.watch_read && pi.since_report >= REPORT_SECONDS)) {
			report_offer((uint8_t)watch, read);
		}
		break;
	}
}

static void on_result(void)
{
	enum pi_err err = pi.result;
	uint32_t progress = pi.os_kind ? os.done + (uint32_t)os.step
				       : delta.stats.blocks_done + (uint32_t)delta.step * 0x1000000u;

	if (pi.withdrawn) {
		pi.phase = PHASE_IDLE;
		(void)cloud_jobs_request_next();
		return;
	}
	if (err == PI_OK && pi.os_kind) {
		offer();
		return;
	}
	if (err == PI_OK) {
		finish_succeeded();
		return;
	}
	if (err != PI_ERR_DOWNLOAD && err != PI_ERR_SD_IO) {
		finish_failed(err);
		return;
	}
	/* Something arrived since the last call: the count starts again. */
	if (progress != pi.mark || delta.stats.blocks_fetched > 0 ||
	    (pi.os_kind && os.bytes_fetched > 0)) {
		pi.attempts = 0;
	}
	pi.mark = progress;
	if (++pi.attempts >= CONFIG_APP_PI_DELTA_DOWNLOAD_ATTEMPTS) {
		finish_failed(err);
		return;
	}
	LOG_WRN("Pi image %s: %s, again in %d s", pi.job.version, pi_err_reason(err),
		RETRY_WAIT_SECONDS * pi.attempts);
	pi.phase = PHASE_RETRY_WAIT;
	pi.seconds = 0;
}

/*
 * While no job runs: a card taken out is forgotten at once, so that the Pi is never answered from
 * the state of a card that is gone, and a card put in is read, so that the Pi can ask about it.
 */
static void watch_card(void)
{
	static int seconds;
	bool present = pi_card_disk_ops.present(NULL);

	if (card.open && !present) {
		LOG_INF("The Pi image card was taken out");
		pi_card_close(&card);
	}
	if (++seconds < CARD_CHECK_SECONDS) {
		return;
	}
	seconds = 0;
	if (!card.open && present && atomic_get(&open_only) == 0) {
		atomic_set(&open_only, 1);
		k_sem_give(&start);
	}
}

void pi_delta_ota_on_tick(void)
{
	pi.seconds++;
	pi.since_report++;

	if (pi.phase == PHASE_IDLE || pi.phase == PHASE_OFFERED) {
		watch_card();
	}

	switch (pi.phase) {
	case PHASE_RUNNING:
		if (atomic_cas(&pi.done, 1, 0)) {
			on_result();
		} else if (pi.since_report >= REPORT_SECONDS && cloud_is_connected()) {
			report_progress();
		}
		break;
	case PHASE_RETRY_WAIT:
		if (pi.seconds >= RETRY_WAIT_SECONDS * pi.attempts && cloud_is_connected()) {
			/* The job again, for a fresh URL: it is in progress, so it is the one named. */
			pi.phase = PHASE_REFRESHING;
			pi.seconds = 0;
			(void)cloud_jobs_request_next();
		}
		break;
	case PHASE_REFRESHING:
		if (pi.seconds >= URL_WAIT_SECONDS) {
			pi.seconds = 0;
			(void)cloud_jobs_request_next();
		}
		break;
	case PHASE_OFFERED:
		if (cloud_is_connected()) {
			watch_offer();
		}
		break;
	default:
		break;
	}
}

int pi_delta_ota_report(char *buf, size_t len)
{
	int written;

	/* pi_delta_ota_init() has not run (ota_init() stopped first): nothing to report. */
	if (delta.card == NULL) {
		return -ENODEV;
	}
	/*
	 * The card's state, its version and generation, change under its lock, on the update's thread
	 * and the link's queue. A card that keeps it longer than REPORT_LOCK_MS (one that fails, in the
	 * SD stack's timeouts) leaves this report out rather than hold up the main loop.
	 */
	if (pi_card_disk_lock_within(REPORT_LOCK_MS) != 0) {
		return -EBUSY;
	}
	written = pi_delta_report(&delta, pi.phase != PHASE_IDLE && !pi.os_kind, buf, len);
	pi_card_unlock(&card);
	return written;
}

int pi_delta_ota_init(void)
{
	int err;

	pi_card_init(&card, &pi_card_disk_ops, NULL);
	pi_delta_init(&delta, &card, &config, &fetch, verify_signature, &stop);
	pi_os_init(&os, &card, &os_config, &fetch, delta.io, &stop);

	err = pi_card_disk_init();
	if (err != 0) {
		LOG_WRN("The SD card's detect pin is not ready: %d", err);
	}
	/* The card is read at once, on the thread, so that the Pi can ask about it before any job. */
	atomic_set(&open_only, 1);

	/* The Pi's link (pi_link.c), started before this, answers its requests from this card now. */
	pi_link_serve_card(&card);

	k_thread_create(&thread, thread_stack, K_THREAD_STACK_SIZEOF(thread_stack), thread_main,
			NULL, NULL, NULL, CONFIG_APP_PI_DELTA_PRIORITY, 0, K_NO_WAIT);
	k_thread_name_set(&thread, "pi_delta");
	k_sem_give(&start);
	return 0;
}
