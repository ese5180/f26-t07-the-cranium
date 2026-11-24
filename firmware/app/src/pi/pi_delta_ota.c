/*
 * Raspberry Pi delta updates on a board: see pi_delta_ota.h.
 *
 * The update (pi_delta.c) runs on this module's thread and fetches its ranges here, over one TLS
 * connection kept alive between them (pi_http.h says why not the firmware's downloader). A range
 * that fails ends the call; the main loop then asks the cloud for the job again, for a fresh
 * presigned URL, and calls again, which goes on from what the card says. A call that got nothing
 * further counts as a failed attempt; CONFIG_APP_PI_DELTA_DOWNLOAD_ATTEMPTS of them in a row fail
 * the job.
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
#include "pi_dlink_spis.h"
#include "pi_http.h"
#include "pi_key.h"
#include "version.h"

LOG_MODULE_REGISTER(pi_delta, CONFIG_APP_LOG_LEVEL);

#define URL_SCHEME            "https://"
#define REPORT_SECONDS        30
#define URL_WAIT_SECONDS      20
#define RETRY_WAIT_SECONDS    10

enum phase {
	PHASE_IDLE,
	/* The thread runs the update. */
	PHASE_RUNNING,
	/* The last call failed to download: waiting to ask for the job again, for a fresh URL. */
	PHASE_RETRY_WAIT,
	/* Asked for the job again: waiting for it. */
	PHASE_REFRESHING,
};

static const struct pi_delta_config config = {
	.default_max_blocks = CONFIG_APP_PI_DELTA_MAX_BLOCKS,
	.run_blocks = CONFIG_APP_PI_DELTA_RUN_BLOCKS,
	.block_attempts = 3,
	.skip_save_every = 64,
	.table_save_every = 64,
};

static struct {
	enum phase phase;
	int seconds;
	int since_report;
	char job_id[OTA_JOB_ID_MAX + 1];
	char closed_id[OTA_JOB_ID_MAX + 1];
	struct pi_delta_job job;
	/* "https://" and the host; the path and query. Only changed while the thread is idle. */
	char host[OTA_JOB_HOST_MAX + 1];
	char file[OTA_JOB_FILE_MAX + 1];
	uint8_t attempts;
	uint32_t mark;
	bool withdrawn;
	/* Set by the thread when a call ends. */
	atomic_t done;
	enum pi_err result;
	bool already;
	bool card_ok;
} pi;

static volatile bool stop;
static struct pi_card card;
static struct pi_delta delta;
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
		err = pi_delta_run(&delta, &pi.job, &already);
		http_close();
		pi.result = err;
		pi.already = already;
		pi.card_ok = card.open;
		atomic_set(&pi.done, 1);
	}
}

/* ------------------------------------------------------------------------------------------- */
/* The job, on the main loop                                                                    */

static const char *step_name(uint8_t step)
{
	switch (step) {
	case PI_STEP_MANIFEST:
		return "manifest";
	case PI_STEP_TABLE:
		return "table";
	case PI_STEP_COMPARE:
		return "compare";
	case PI_STEP_BLOCKS:
		return "blocks";
	case PI_STEP_DONE:
		return "done";
	default:
		return "idle";
	}
}

static void job_update(const char *status, const char *details)
{
	char body[320];
	int written = snprintf(body, sizeof(body), "{\"status\":\"%s\",\"statusDetails\":{%s}}", status,
			       details);

	if (written < 0 || written >= (int)sizeof(body)) {
		LOG_ERR("Pi job report too long");
		return;
	}
	if (cloud_jobs_update(pi.job_id, body) != 0) {
		LOG_WRN("Pi job %s: the report did not go out", pi.job_id);
	}
}

static void report_progress(void)
{
	char details[160];
	uint32_t total = delta.stats.blocks_total;
	uint32_t done = delta.stats.blocks_done;

	(void)snprintf(details, sizeof(details),
		       "\"step\":\"%s\",\"progress\":\"%u\",\"done\":\"%u\",\"total\":\"%u\"",
		       step_name(delta.step), total == 0 ? 0u : (unsigned int)(100ull * done / total),
		       (unsigned int)done, (unsigned int)total);
	job_update("IN_PROGRESS", details);
	pi.since_report = 0;
}

static void finish(void)
{
	strncpy(pi.closed_id, pi.job_id, sizeof(pi.closed_id) - 1);
	pi.phase = PHASE_IDLE;
	(void)cloud_jobs_request_next();
}

static void finish_succeeded(void)
{
	char details[224];

	(void)snprintf(details, sizeof(details),
		       "\"pi_version\":\"%s\",\"generation\":\"%u\",\"fetched\":\"%u\",\"changed\":\"%u\","
		       "\"bytes\":\"%llu\",\"running\":\"%s\"",
		       pi.job.version, (unsigned int)card.st.generation,
		       (unsigned int)delta.stats.blocks_fetched, (unsigned int)delta.stats.changed,
		       (unsigned long long)delta.stats.bytes_fetched, fw_version_running_string());
	LOG_INF("Pi image %s is on the card (%s)", pi.job.version,
		pi.already ? "it was already" : "updated");
	job_update("SUCCEEDED", details);
	finish();
}

static void finish_failed(enum pi_err err)
{
	char details[160];

	(void)snprintf(details, sizeof(details), "\"reason\":\"%s\",\"step\":\"%s\",\"running\":\"%s\"",
		       pi_err_reason(err), step_name(delta.step), fw_version_running_string());
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
			if (strcmp(job->pi_version, pi.job.version) != 0 ||
			    memcmp(job->sha256, pi.job.sha256, PI_HASH_SIZE) != 0) {
				finish_failed(PI_ERR_MANIFEST_MISMATCH);
				return;
			}
			memcpy(pi.host, job->host, sizeof(pi.host));
			memcpy(pi.file, job->file, sizeof(pi.file));
			run();
		}
		return;
	}

	memset(&pi.job, 0, sizeof(pi.job));
	memcpy(pi.job_id, job->id, sizeof(pi.job_id));
	memcpy(pi.job.version, job->pi_version, sizeof(pi.job.version));
	memcpy(pi.job.sha256, job->sha256, PI_HASH_SIZE);
	memcpy(pi.host, job->host, sizeof(pi.host));
	memcpy(pi.file, job->file, sizeof(pi.file));
	pi.attempts = 0;
	pi.mark = 0;
	LOG_INF("Pi image %s: %s", pi.job.version, job->in_progress ? "going on" : "starting");
	job_update("IN_PROGRESS", "\"step\":\"manifest\"");
	pi.since_report = 0;
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
	if (pi.phase == PHASE_RUNNING) {
		/* The thread stops at its next piece; on_tick() then goes idle. */
		stop = true;
	} else {
		pi.phase = PHASE_IDLE;
	}
}

static void on_result(void)
{
	enum pi_err err = pi.result;
	uint32_t progress = delta.stats.blocks_done + (uint32_t)delta.step * 0x1000000u;

	if (pi.withdrawn) {
		pi.phase = PHASE_IDLE;
		(void)cloud_jobs_request_next();
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
	if (progress != pi.mark || delta.stats.blocks_fetched > 0) {
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

	if (pi.phase == PHASE_IDLE) {
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
	default:
		break;
	}
}

int pi_delta_ota_report(char *buf, size_t len)
{
	static const char *const states[] = { "empty", "ready", "updating" };
	const char *state = card.open && card.st.state <= PI_STATE_UPDATING ? states[card.st.state]
									      : "no_card";
	const struct pi_manifest *m = card.st.state == PI_STATE_UPDATING ? &card.neu : &card.cur;
	int written;

	written = snprintf(buf, len,
			   "{\"card\":\"%s\",\"version\":\"%s\",\"generation\":%u,\"step\":\"%s\","
			   "\"done\":%u,\"total\":%u}",
			   state, card.open && card.st.state != PI_STATE_EMPTY ? m->version : "",
			   (unsigned int)card.st.generation,
			   pi.phase == PHASE_IDLE ? "idle" : step_name(delta.step),
			   (unsigned int)delta.stats.blocks_done, (unsigned int)delta.stats.blocks_total);
	return written < 0 || (size_t)written >= len ? -ENOSPC : written;
}

int pi_delta_ota_init(void)
{
	int err;

	pi_card_init(&card, &pi_card_disk_ops, NULL);
	pi_delta_init(&delta, &card, &config, &fetch, verify_signature, &stop);

	err = pi_card_disk_init();
	if (err != 0) {
		LOG_WRN("The SD card's detect pin is not ready: %d", err);
	}
	/* The card is read at once, on the thread, so that the Pi can ask about it before any job. */
	atomic_set(&open_only, 1);

	err = pi_dlink_spis_start(&card);
	if (err != 0) {
		LOG_ERR("The Pi's SPI link did not start: %d", err);
	}

	k_thread_create(&thread, thread_stack, K_THREAD_STACK_SIZEOF(thread_stack), thread_main,
			NULL, NULL, NULL, CONFIG_APP_PI_DELTA_PRIORITY, 0, K_NO_WAIT);
	k_thread_name_set(&thread, "pi_delta");
	k_sem_give(&start);
	return 0;
}
