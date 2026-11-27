/*
 * Host tests of the board's glue for Raspberry Pi updates (src/pi/pi_delta_ota.c): a job taken, the
 * update's thread, the retries for a fresh URL, the offer of a Pi OS update's file and the watch for
 * the Pi's result, as the main loop runs them once a second.
 *
 * The real source is compiled here, with what it calls replaced: the SD card is the fakes' card in
 * memory (one of two, as if swapped in the slot), the cloud records each job report, the network
 * cannot be reached (every range request fails), and the update's thread runs when it has been
 * given work, until it waits again (setjmp and longjmp take it out of its wait).
 */

#include <setjmp.h>

#include "pi_delta_ota.c"

#include "pi_delta_fakes.h"

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

#define FILE_SIZE 10000u

/* ------------------------------------------------------------------------------------------- */
/* The card in the slot: one of two                                                            */

static struct fake_disk disks[2];
static struct fake_disk *slot = &disks[0];

static int slot_read(void *ctx, uint64_t lba, uint8_t *buf, uint32_t count)
{
	(void)ctx;
	return fake_disk_ops.read(slot, lba, buf, count);
}

static int slot_write(void *ctx, uint64_t lba, const uint8_t *buf, uint32_t count)
{
	(void)ctx;
	return fake_disk_ops.write(slot, lba, buf, count);
}

static int slot_open(void *ctx, uint64_t *sectors)
{
	(void)ctx;
	return fake_disk_ops.open(slot, sectors);
}

static bool slot_present(void *ctx)
{
	(void)ctx;
	return fake_disk_ops.present(slot);
}

const struct pi_disk_ops pi_card_disk_ops = {
	.read = slot_read,
	.write = slot_write,
	.open = slot_open,
	.present = slot_present,
};

int pi_card_disk_init(void)
{
	return 0;
}

int pi_card_disk_lock_within(int32_t wait_ms)
{
	(void)wait_ms;
	return 0;
}

void pi_link_serve_card(struct pi_card *served)
{
	(void)served;
}

/* ------------------------------------------------------------------------------------------- */
/* The update's thread                                                                          */

static void (*thread_entry)(void *, void *, void *);
static jmp_buf thread_waits;
static bool in_thread;

void k_thread_create(struct k_thread *t, char *stack, size_t size,
		     void (*entry)(void *, void *, void *), void *a, void *b, void *c, int priority,
		     int options, k_timeout_t delay)
{
	(void)t;
	(void)stack;
	(void)size;
	(void)a;
	(void)b;
	(void)c;
	(void)priority;
	(void)options;
	(void)delay;
	thread_entry = entry;
}

int k_thread_name_set(struct k_thread *t, const char *name)
{
	(void)t;
	(void)name;
	return 0;
}

int k_sem_take(struct k_sem *sem, k_timeout_t timeout)
{
	(void)timeout;
	if (sem->count > 0) {
		sem->count--;
		return 0;
	}
	if (in_thread) {
		/* It waits for work: back to the test. */
		longjmp(thread_waits, 1);
	}
	return -EAGAIN;
}

void k_sem_give(struct k_sem *sem)
{
	if (sem->count < 1) {
		sem->count++;
	}
}

/* The thread does what it has been given, if anything, and waits again. */
static void thread_runs(void)
{
	if (setjmp(thread_waits) == 0) {
		in_thread = true;
		thread_entry(NULL, NULL, NULL);
	}
	in_thread = false;
}

/* ------------------------------------------------------------------------------------------- */
/* The cloud, the network and the rest                                                          */

static int job_requests;
static int reports;
static int succeeded;
static int failed;
static char last_report[400];

bool cloud_is_connected(void)
{
	return true;
}

int cloud_jobs_request_next(void)
{
	job_requests++;
	return 0;
}

int cloud_jobs_update(const char *job_id, const char *body_json)
{
	(void)job_id;
	reports++;
	snprintf(last_report, sizeof(last_report), "%s", body_json);
	succeeded += strstr(body_json, "\"SUCCEEDED\"") != NULL;
	failed += strstr(body_json, "\"FAILED\"") != NULL;
	return 0;
}

const char *fw_version_running_string(void)
{
	return "1.20.2";
}

/* No network: every range request fails at once, as with the Wi-Fi down or a host that cannot be found. */
static int lookups;

int zsock_getaddrinfo(const char *host, const char *service, const struct zsock_addrinfo *hints,
		      struct zsock_addrinfo **res)
{
	(void)host;
	(void)service;
	(void)hints;
	*res = NULL;
	lookups++;
	return -1;
}

void zsock_freeaddrinfo(struct zsock_addrinfo *ai)
{
	(void)ai;
}

int zsock_socket(int family, int type, int proto)
{
	(void)family;
	(void)type;
	(void)proto;
	return -1;
}

int zsock_setsockopt(int sock, int level, int optname, const void *optval, size_t optlen)
{
	(void)sock;
	(void)level;
	(void)optname;
	(void)optval;
	(void)optlen;
	return -1;
}

int zsock_connect(int sock, const struct net_sockaddr *addr, int addrlen)
{
	(void)sock;
	(void)addr;
	(void)addrlen;
	return -1;
}

ssize_t zsock_send(int sock, const void *buf, size_t len, int flags)
{
	(void)sock;
	(void)buf;
	(void)len;
	(void)flags;
	return -1;
}

ssize_t zsock_recv(int sock, void *buf, size_t max_len, int flags)
{
	(void)sock;
	(void)buf;
	(void)max_len;
	(void)flags;
	return -1;
}

int zsock_close(int sock)
{
	(void)sock;
	return 0;
}

void psa_set_key_type(psa_key_attributes_t *attributes, int type)
{
	(void)attributes;
	(void)type;
}

void psa_set_key_bits(psa_key_attributes_t *attributes, size_t bits)
{
	(void)attributes;
	(void)bits;
}

void psa_set_key_usage_flags(psa_key_attributes_t *attributes, int usage)
{
	(void)attributes;
	(void)usage;
}

void psa_set_key_algorithm(psa_key_attributes_t *attributes, int algorithm)
{
	(void)attributes;
	(void)algorithm;
}

psa_status_t psa_import_key(const psa_key_attributes_t *attributes, const uint8_t *data,
			    size_t length, psa_key_id_t *key)
{
	(void)attributes;
	(void)data;
	(void)length;
	*key = 1;
	return PSA_SUCCESS;
}

psa_status_t psa_verify_message(psa_key_id_t key, int algorithm, const uint8_t *input,
				size_t input_length, const uint8_t *signature, size_t signature_length)
{
	(void)key;
	(void)algorithm;
	(void)input;
	(void)input_length;
	(void)signature;
	(void)signature_length;
	return -1;
}

psa_status_t psa_destroy_key(psa_key_id_t key)
{
	(void)key;
	return PSA_SUCCESS;
}

/* ------------------------------------------------------------------------------------------- */

static uint64_t card_sectors(void)
{
	struct pi_card_layout layout;

	pi_card_layout_for(CONFIG_APP_PI_DELTA_MAX_BLOCKS, &layout);
	return layout.mirror_lba + 4 * 2048;
}

static uint8_t file_bytes[FILE_SIZE];
static uint8_t other_bytes[FILE_SIZE];

static void sha_of(const uint8_t *data, size_t len, uint8_t out[PI_HASH_SIZE])
{
	struct pi_sha256 sha;

	pi_sha256_init(&sha);
	pi_sha256_update(&sha, data, len);
	pi_sha256_final(&sha, out);
}

/* What the cloud names: a "pi_os" job for file_bytes. */
static void os_job(struct ota_job *job, const char *id, bool in_progress)
{
	memset(job, 0, sizeof(*job));
	strcpy(job->id, id);
	job->in_progress = in_progress;
	job->pi_os = true;
	strcpy(job->pi_version, "1.1.0");
	strcpy(job->pi_from, "1.0.0");
	job->size = FILE_SIZE;
	sha_of(file_bytes, FILE_SIZE, job->sha256);
	strcpy(job->host, "https://bucket.example");
	strcpy(job->file, "firmware/pi-os-1.1.0.update");
}

/*
 * A file onto a card directly, as an earlier job left it there (pi_os.c with the fakes' server):
 * its generation, and the card's file state, as they are after.
 */
static uint32_t put_file(struct fake_disk *disk, const uint8_t *bytes, const char *version,
			 uint32_t tag, uint8_t result)
{
	struct fake_server server;
	struct pi_card c;
	struct pi_os o;
	struct pi_fetch fetch = { .get = fake_server_get, .ctx = &server };
	static const struct pi_os_config config = { CONFIG_APP_PI_DELTA_MAX_BLOCKS, 64, 2 };
	struct pi_os_job job;
	uint8_t io[PI_SECTOR_SIZE];

	memset(&server, 0, sizeof(server));
	server.package = bytes;
	server.size = FILE_SIZE;
	server.max_piece = 900;
	server.drop_after = -1;
	server.stop_after = -1;
	memset(&job, 0, sizeof(job));
	strcpy(job.version, version);
	strcpy(job.from, "1.0.0");
	sha_of(bytes, FILE_SIZE, job.sha256);
	job.size = FILE_SIZE;
	job.tag = tag;
	pi_card_init(&c, &fake_disk_ops, disk);
	pi_os_init(&o, &c, &config, &fetch, io, NULL);
	CHECK(pi_os_run(&o, &job) == PI_OK);
	if (result != PI_OS_NONE) {
		CHECK(pi_card_file_load(&c, io) == PI_OK);
		io[PI_FILE_AT_RESULT] = result;
		CHECK(pi_card_file_store(&c, io) == PI_OK);
	}
	return c.file.generation;
}

/* The board's start, with the card in the slot. */
static void board_starts(void)
{
	CHECK(pi_delta_ota_init() == 0);
	thread_runs();
	CHECK(card.open);
}

/* One second of the main loop: the thread's work first, then the tick; the cloud answers a refresh. */
static void second(const struct ota_job *again)
{
	thread_runs();
	pi_delta_ota_on_tick();
	if (pi.phase == PHASE_REFRESHING && again != NULL) {
		pi_delta_ota_on_job(again);
	}
}

/* ------------------------------------------------------------------------------------------- */

/*
 * A "pi_os" job whose download fails every time fails the job after
 * CONFIG_APP_PI_DELTA_DOWNLOAD_ATTEMPTS calls in a row, also on a board whose last delta update
 * fetched blocks: those counts are the delta update's, not progress of this one.
 */
static void test_a_failing_download_ends(bool delta_before)
{
	struct ota_job job;
	struct ota_job again;
	int calls = 0;

	fake_disk_create(&disks[0], card_sectors());
	slot = &disks[0];
	board_starts();
	if (delta_before) {
		/* As a delta update that downloaded blocks leaves them. */
		delta.stats.blocks_fetched = 3;
		delta.stats.bytes_fetched = 3 * 65536;
	}
	os_job(&job, delta_before ? "pi-os-fail-2" : "pi-os-fail-1", false);
	os_job(&again, job.id, true);
	succeeded = failed = 0;
	lookups = 0;

	pi_delta_ota_on_job(&job);
	CHECK(pi.phase == PHASE_RUNNING && pi.os_kind);
	for (int s = 0; s < 3000 && failed == 0; s++) {
		int before = lookups;

		second(&again);
		calls += lookups > before;
	}
	CHECK(failed == 1 && succeeded == 0);
	CHECK(calls == CONFIG_APP_PI_DELTA_DOWNLOAD_ATTEMPTS);
	CHECK(strstr(last_report, "\"reason\":\"download_failed\"") != NULL);
	CHECK(strstr(last_report, "\"step\":\"download\"") != NULL);
	CHECK(pi.phase == PHASE_IDLE && !card.file.offered);
	/* What was on the card stays, for a later job: the file, downloading, nothing of it there. */
	CHECK(card.file.state == PI_FILE_DOWNLOADING && card.file.done == 0);
	fake_disk_free(&disks[0]);
}

/*
 * The card is swapped while a file is offered, for one whose file has the same generation and a
 * stored "confirmed": that card's file is not offered, its result does not end this job, and the
 * job takes its own file onto it. The first card put back is offered again at once.
 */
static void test_a_card_swapped_while_offered(void)
{
	struct ota_job job;
	struct ota_job again;
	uint8_t raw[PI_SECTOR_SIZE];
	uint32_t generation;

	fake_disk_create(&disks[0], card_sectors());
	fake_disk_create(&disks[1], card_sectors());
	/* Card A holds this job's file from an earlier job; card B two other files, the last confirmed. */
	CHECK(put_file(&disks[0], file_bytes, "1.1.0", 0x99, PI_OS_NONE) == 1);
	CHECK(put_file(&disks[1], other_bytes, "1.0.5", 7, PI_OS_NONE) == 1);
	CHECK(put_file(&disks[1], other_bytes, "1.0.6", 8, PI_OS_CONFIRMED) == 2);

	slot = &disks[0];
	board_starts();
	os_job(&job, "pi-os-swap", false);
	os_job(&again, job.id, true);
	succeeded = failed = 0;
	lookups = 0;

	/* Taken under the next generation, with nothing downloaded, and offered. */
	pi_delta_ota_on_job(&job);
	second(&again);
	CHECK(pi.phase == PHASE_OFFERED && card.file.offered && card.file.generation == 2);
	CHECK(pi.offered_generation == 2 && lookups == 0);
	CHECK(strstr(last_report, "\"step\":\"offered\"") != NULL);
	generation = card.file.generation;

	/* Card A out: nothing offered. */
	disks[0].absent = true;
	second(&again);
	CHECK(!card.open && pi.phase == PHASE_OFFERED);

	/* Card B in: read at the next look at the slot, with the same generation and a "confirmed". */
	slot = &disks[1];
	for (int s = 0; s < CARD_CHECK_SECONDS + 1 && card.open == false; s++) {
		second(&again);
	}
	CHECK(card.open && card.file.generation == generation && card.file.result == PI_OS_CONFIRMED);
	/* The next tick sees another open of the card: the job takes its file again. */
	second(&again);
	CHECK(succeeded == 0 && failed == 0);
	CHECK(!card.file.offered);
	/* On card B: this job's file, a new generation, downloading (the network is down here). */
	for (int s = 0; s < 5; s++) {
		second(&again);
	}
	CHECK(succeeded == 0 && failed == 0 && lookups > 0);
	CHECK(card.file.generation == 3 && card.file.state == PI_FILE_DOWNLOADING && !card.file.offered);

	/* Card A put back: its file, with this job's tag, is offered again at once, under its generation. */
	slot = &disks[0];
	disks[0].absent = false;
	for (int s = 0; s < 200 && pi.phase != PHASE_OFFERED; s++) {
		second(&again);
	}
	CHECK(pi.phase == PHASE_OFFERED && card.file.offered && card.file.generation == 2);
	CHECK(succeeded == 0 && failed == 0);

	/* The Pi's result for it, on card A, ends the job. */
	CHECK(pi_card_file_load(&card, raw) == PI_OK);
	raw[PI_FILE_AT_RESULT] = PI_OS_CONFIRMED;
	CHECK(pi_card_file_store(&card, raw) == PI_OK);
	second(&again);
	CHECK(succeeded == 1 && failed == 0 && pi.phase == PHASE_IDLE);
	CHECK(strstr(last_report, "\"pi_version\":\"1.1.0\"") != NULL &&
	      strstr(last_report, "\"generation\":\"2\"") != NULL);
	CHECK(!card.file.offered);

	fake_disk_free(&disks[0]);
	fake_disk_free(&disks[1]);
}

/* The same card taken out and put back while offered: offered again at once, nothing downloaded. */
static void test_the_same_card_put_back(void)
{
	struct ota_job job;
	struct ota_job again;

	fake_disk_create(&disks[0], card_sectors());
	CHECK(put_file(&disks[0], file_bytes, "1.1.0", 0x55, PI_OS_NONE) == 1);
	slot = &disks[0];
	board_starts();
	os_job(&job, "pi-os-back", false);
	os_job(&again, job.id, true);
	succeeded = failed = 0;
	lookups = 0;
	pi_delta_ota_on_job(&job);
	second(&again);
	CHECK(pi.phase == PHASE_OFFERED && card.file.offered);

	disks[0].absent = true;
	second(&again);
	disks[0].absent = false;
	for (int s = 0; s < 20 && !(pi.phase == PHASE_OFFERED && card.file.offered && card.open); s++) {
		second(&again);
	}
	CHECK(pi.phase == PHASE_OFFERED && card.file.offered && card.file.generation == 2);
	CHECK(lookups == 0 && succeeded == 0 && failed == 0);

	/* Withdrawn: nothing offered any more. */
	pi_delta_ota_withdrawn();
	CHECK(pi.phase == PHASE_IDLE && !card.file.offered);
	fake_disk_free(&disks[0]);
}

int main(void)
{
	for (uint32_t i = 0; i < FILE_SIZE; i++) {
		file_bytes[i] = (uint8_t)(i * 7 + 3);
		other_bytes[i] = (uint8_t)(i * 13 + 1);
	}

	test_a_failing_download_ends(false);
	test_a_failing_download_ends(true);
	test_a_card_swapped_while_offered();
	test_the_same_card_put_back();

	printf("pi_delta_ota_tests: %d checks, %d failures\n", checks, failures);
	return failures == 0 ? 0 : 1;
}
