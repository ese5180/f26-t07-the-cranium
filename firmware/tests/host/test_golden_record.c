/*
 * Host-side tests of golden image promotion (firmware 1.19.3): the record's format as the
 * bootloader and the application read it, the bootloader's decision on a record, the state page
 * that keeps its pin and counter, the application's decision on a job, and the job document.
 *
 * The signature check itself is MCUboot's own ECDSA code, which is not built here:
 * firmware/tests/hil/test_golden_promote.py signs and verifies records with the same bytes, and the
 * board test promotes one for real.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "golden_job_policy.h"
#include "golden_record.h"
#include "ota_job.h"

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

static struct golden_record sample(uint32_t counter)
{
	struct golden_record record;

	memset(&record, 0, sizeof(record));
	record.pin.counter = counter;
	record.pin.size = 759058;
	record.pin.version = (struct golden_version){ 1, 19, 2, 0 };
	for (int i = 0; i < GOLDEN_HASH_SIZE; i++) {
		record.pin.sha256[i] = (uint8_t)(0xa0 + i);
	}
	record.sig_len = 70;
	for (int i = 0; i < record.sig_len; i++) {
		record.sig[i] = (uint8_t)(i + 1);
	}
	return record;
}

static void test_format(void)
{
	struct golden_record record = sample(7);
	struct golden_record parsed;
	uint8_t bytes[GOLDEN_RECORD_SIZE];
	uint8_t bad[GOLDEN_RECORD_SIZE];

	CHECK(GOLDEN_RECORD_SIZE == 130);
	CHECK(OTA_GOLDEN_RECORD_SIZE == GOLDEN_RECORD_SIZE);

	golden_record_encode(&record, bytes);
	CHECK(memcmp(bytes, "CGLD\x01\0\0\0", 8) == 0);
	/* Little-endian counter at 8, size at 12, version at 16, digest at 24. */
	CHECK(bytes[8] == 7 && bytes[9] == 0);
	CHECK(bytes[12] == (759058 & 0xff) && bytes[14] == (759058 >> 16));
	CHECK(bytes[16] == 1 && bytes[17] == 19 && bytes[18] == 2 && bytes[19] == 0);
	CHECK(bytes[24] == 0xa0 && bytes[55] == 0xa0 + 31);
	CHECK(bytes[56] == 70 && bytes[57] == 0 && bytes[58] == 1 && bytes[127] == 70);
	CHECK(bytes[128] == 0 && bytes[129] == 0);

	CHECK(golden_record_parse(bytes, sizeof(bytes), &parsed));
	CHECK(golden_pin_equal(&parsed.pin, &record.pin));
	CHECK(parsed.sig_len == 70 && memcmp(parsed.sig, record.sig, 70) == 0);

	CHECK(!golden_record_parse(NULL, sizeof(bytes), &parsed));
	CHECK(!golden_record_parse(bytes, sizeof(bytes) - 1, &parsed));

	/* Each byte the parser checks, one at a time. */
	static const struct {
		int at;
		uint8_t value;
	} breaks[] = {
		{ 0, 'X' }, { 3, 'X' }, { 4, 2 }, { 5, 1 }, { 7, 1 }, { 56, 7 }, { 56, 73 }, { 57, 1 },
		{ 128, 1 },
	};
	for (size_t i = 0; i < sizeof(breaks) / sizeof(breaks[0]); i++) {
		memcpy(bad, bytes, sizeof(bad));
		bad[breaks[i].at] = breaks[i].value;
		CHECK(!golden_record_parse(bad, sizeof(bad), &parsed));
	}

	/* A counter of 0 and a size of 0 mean nothing. */
	memcpy(bad, bytes, sizeof(bad));
	memset(bad + 8, 0, 4);
	CHECK(!golden_record_parse(bad, sizeof(bad), &parsed));
	memcpy(bad, bytes, sizeof(bad));
	memset(bad + 12, 0, 4);
	CHECK(!golden_record_parse(bad, sizeof(bad), &parsed));

	/* Erased flash is no record. */
	memset(bad, 0xff, sizeof(bad));
	CHECK(golden_erased(bad, sizeof(bad)));
	CHECK(!golden_erased(bytes, sizeof(bytes)));
	CHECK(!golden_record_parse(bad, sizeof(bad), &parsed));
}

static void test_status(void)
{
	CHECK(golden_status_from_word(0xffffffffu) == GOLDEN_STATUS_PENDING);
	CHECK(golden_status_word(GOLDEN_STATUS_PENDING) == 0xffffffffu);
	for (int status = GOLDEN_STATUS_SEALED; status < GOLDEN_STATUS_UNKNOWN; status++) {
		CHECK(golden_status_from_word(golden_status_word((enum golden_status)status)) == (enum golden_status)status);
	}
	/* Anything else written there is not an answer this bootloader gives. */
	CHECK(golden_status_from_word(0) == GOLDEN_STATUS_UNKNOWN);
	CHECK(golden_status_from_word(GOLDEN_STATUS_TAG) == GOLDEN_STATUS_UNKNOWN);
	CHECK(golden_status_from_word(GOLDEN_STATUS_TAG | 0x40) == GOLDEN_STATUS_UNKNOWN);
	CHECK(golden_status_from_word(0x12000001u) == GOLDEN_STATUS_UNKNOWN);
	CHECK(strcmp(golden_status_name(GOLDEN_STATUS_SEALED), "sealed") == 0);
	CHECK(strcmp(golden_status_name(GOLDEN_STATUS_NOT_NEWER), "not_newer") == 0);
	CHECK(strcmp(golden_status_name(GOLDEN_STATUS_UNKNOWN), "unknown") == 0);
}

static struct golden_running running_of(const struct golden_record *record)
{
	struct golden_running running = {
		.valid = true,
		.confirmed = true,
		.size = record->pin.size,
		.version = record->pin.version,
	};

	memcpy(running.sha256, record->pin.sha256, GOLDEN_HASH_SIZE);
	return running;
}

static void test_bootloader_decides(void)
{
	struct golden_record record = sample(5);
	struct golden_running running = running_of(&record);
	struct golden_running other;

	CHECK(golden_promote_decide(&record, true, 4, &running) == GOLDEN_STATUS_SEALED);
	CHECK(golden_promote_decide(&record, true, 0, &running) == GOLDEN_STATUS_SEALED);

	/* A stolen image key signs no record: without the golden key's signature, nothing else counts. */
	CHECK(golden_promote_decide(&record, false, 4, &running) == GOLDEN_STATUS_BAD_SIGNATURE);
	CHECK(golden_promote_decide(&record, false, 9, &running) == GOLDEN_STATUS_BAD_SIGNATURE);

	/* The floor: an older golden image never comes back, and a record is good for one seal. */
	CHECK(golden_promote_decide(&record, true, 5, &running) == GOLDEN_STATUS_NOT_NEWER);
	CHECK(golden_promote_decide(&record, true, 6, &running) == GOLDEN_STATUS_NOT_NEWER);
	CHECK(golden_promote_decide(&record, true, UINT32_MAX, &running) == GOLDEN_STATUS_NOT_NEWER);

	/* Only the image that runs: digest, size and version all. */
	other = running;
	other.sha256[31] ^= 1;
	CHECK(golden_promote_decide(&record, true, 4, &other) == GOLDEN_STATUS_NOT_RUNNING);
	other = running;
	other.size++;
	CHECK(golden_promote_decide(&record, true, 4, &other) == GOLDEN_STATUS_NOT_RUNNING);
	other = running;
	other.version.build = 1;
	CHECK(golden_promote_decide(&record, true, 4, &other) == GOLDEN_STATUS_NOT_RUNNING);
	other = running;
	other.valid = false;
	CHECK(golden_promote_decide(&record, true, 4, &other) == GOLDEN_STATUS_NOT_RUNNING);

	/* Only an image that has proved itself on this board: not one on trial. */
	other = running;
	other.confirmed = false;
	CHECK(golden_promote_decide(&record, true, 4, &other) == GOLDEN_STATUS_NOT_CONFIRMED);
}

#define PAGE 4096

static const struct golden_pin *pin_of(uint32_t counter)
{
	static struct golden_record record;

	record = sample(counter);
	return &record.pin;
}

static void test_state_page(void)
{
	static uint8_t page[PAGE];
	uint8_t entry[GOLDEN_STATE_ENTRY_SIZE];
	struct golden_pin found;
	struct golden_record first = sample(1);
	struct golden_record second = sample(2);
	size_t next;

	/* Erased: nothing found, and the compiled-in pin is used. The first entry goes at 0. */
	memset(page, 0xff, sizeof(page));
	CHECK(!golden_state_scan(page, sizeof(page), &found, &next));
	CHECK(next == 0);

	golden_state_entry_encode(&first.pin, entry);
	CHECK(entry[48] == (uint8_t)~1u);
	memcpy(page, entry, sizeof(entry));
	CHECK(golden_state_scan(page, sizeof(page), &found, &next));
	CHECK(golden_pin_equal(&found, &first.pin));
	CHECK(next == GOLDEN_STATE_ENTRY_SIZE);

	golden_state_entry_encode(&second.pin, entry);
	memcpy(page + GOLDEN_STATE_ENTRY_SIZE, entry, sizeof(entry));
	CHECK(golden_state_scan(page, sizeof(page), &found, &next));
	CHECK(found.counter == 2);
	CHECK(next == 2 * GOLDEN_STATE_ENTRY_SIZE);

	/* Cut off before its magic: it does not count, and it is never written over. */
	golden_state_entry_encode(pin_of(3), entry);
	memset(entry + 60, 0xff, 4);
	memcpy(page + 2 * GOLDEN_STATE_ENTRY_SIZE, entry, sizeof(entry));
	CHECK(golden_state_scan(page, sizeof(page), &found, &next));
	CHECK(found.counter == 2);
	CHECK(next == 3 * GOLDEN_STATE_ENTRY_SIZE);

	/* A damaged check word: not counted either. */
	golden_state_entry_encode(pin_of(9), entry);
	entry[48] ^= 1;
	memcpy(page + 3 * GOLDEN_STATE_ENTRY_SIZE, entry, sizeof(entry));
	CHECK(golden_state_scan(page, sizeof(page), &found, &next));
	CHECK(found.counter == 2);

	/* The highest counter wins, wherever it is. */
	golden_state_entry_encode(pin_of(4), entry);
	memcpy(page + 4 * GOLDEN_STATE_ENTRY_SIZE, entry, sizeof(entry));
	golden_state_entry_encode(pin_of(3), entry);
	memcpy(page + 5 * GOLDEN_STATE_ENTRY_SIZE, entry, sizeof(entry));
	CHECK(golden_state_scan(page, sizeof(page), &found, &next));
	CHECK(found.counter == 4);
	CHECK(next == 6 * GOLDEN_STATE_ENTRY_SIZE);

	/* Full: the next entry needs an erase first. */
	for (size_t at = 0; at < PAGE; at += GOLDEN_STATE_ENTRY_SIZE) {
		golden_state_entry_encode(pin_of((uint32_t)(at / GOLDEN_STATE_ENTRY_SIZE + 1)), entry);
		memcpy(page + at, entry, sizeof(entry));
	}
	CHECK(golden_state_scan(page, sizeof(page), &found, &next));
	CHECK(next == PAGE);
	CHECK(found.counter == PAGE / GOLDEN_STATE_ENTRY_SIZE);

	/* Junk that is neither erased nor an entry: no pin from it. */
	memset(page, 0x00, sizeof(page));
	CHECK(!golden_state_scan(page, sizeof(page), &found, &next));
	CHECK(next == PAGE);
}

static void unhex(const char *text, uint8_t *out)
{
	for (size_t i = 0; text[2 * i] != '\0'; i++) {
		unsigned int byte;

		sscanf(text + 2 * i, "%2x", &byte);
		out[i] = (uint8_t)byte;
	}
}

/* A signature made by Python's cryptography, as tools/golden_promote.py sign makes them. */
static void test_der_signature(void)
{
	static const char der_hex[] =
		"3045022100995beba3678e928d96d23c37ec86e6518619c9ca3a9aeb91196a04d8068657a8"
		"022000bd73c6e770585eada5c1fadaf72065c70c1ad8b5d88cc30bc3dae1b7ab6aef";
	uint8_t der[71];
	uint8_t bad[71];
	uint8_t rs[64];
	uint8_t want[64];

	unhex(der_hex, der);
	unhex("995beba3678e928d96d23c37ec86e6518619c9ca3a9aeb91196a04d8068657a8"
	      "00bd73c6e770585eada5c1fadaf72065c70c1ad8b5d88cc30bc3dae1b7ab6aef",
	      want);
	CHECK(golden_der_signature(der, sizeof(der), rs));
	CHECK(memcmp(rs, want, sizeof(want)) == 0);

	CHECK(!golden_der_signature(der, sizeof(der) - 1, rs));
	CHECK(!golden_der_signature(NULL, sizeof(der), rs));
	/* Each byte of the structure, wrong. */
	static const struct {
		int at;
		uint8_t value;
	} breaks[] = { { 0, 0x31 }, { 1, 0x44 }, { 2, 0x03 }, { 3, 0x22 }, { 4, 0x01 }, { 37, 0x04 },
		       { 38, 0x21 }, { 39, 0x80 } };
	for (size_t i = 0; i < sizeof(breaks) / sizeof(breaks[0]); i++) {
		memcpy(bad, der, sizeof(bad));
		bad[breaks[i].at] = breaks[i].value;
		CHECK(!golden_der_signature(bad, sizeof(bad), rs));
	}
}

static void test_versions(void)
{
	struct golden_version a = { 1, 19, 2, 0 };
	struct golden_version b = a;

	CHECK(golden_version_compare(&a, &b) == 0);
	b.build = 1;
	CHECK(golden_version_compare(&a, &b) < 0);
	b = a;
	b.revision = 1;
	CHECK(golden_version_compare(&a, &b) > 0);
	b = a;
	b.major = 2;
	CHECK(golden_version_compare(&a, &b) < 0);
}

static struct golden_job_view view_for(const struct golden_record *record)
{
	struct golden_job_view view = {
		.record = record,
		.request_status = GOLDEN_STATUS_PENDING,
		.running = record->pin.version,
		.running_confirmed = true,
	};
	return view;
}

static void test_job_policy(void)
{
	struct golden_record record = sample(3);
	struct golden_job_view view;
	const char *reason;

	/* A new record for the image that runs: hand it over. */
	view = view_for(&record);
	CHECK(golden_job_decide(&view, &reason) == GOLDEN_JOB_START);
	view.info_present = true;
	view.info = sample(2).pin;
	CHECK(golden_job_decide(&view, &reason) == GOLDEN_JOB_START);

	/* Golden already: succeeded, whatever the request sector says. */
	view.info = record.pin;
	view.request_is_this = true;
	view.request_status = GOLDEN_STATUS_NOT_NEWER;
	CHECK(golden_job_decide(&view, &reason) == GOLDEN_JOB_SUCCEEDED);

	/* The bootloader's answer, after the restart. */
	view = view_for(&record);
	view.request_is_this = true;
	view.request_status = GOLDEN_STATUS_SEALED;
	CHECK(golden_job_decide(&view, &reason) == GOLDEN_JOB_SUCCEEDED);
	view.request_status = GOLDEN_STATUS_BAD_SIGNATURE;
	CHECK(golden_job_decide(&view, &reason) == GOLDEN_JOB_FAILED);
	CHECK(strcmp(reason, "bad_signature") == 0);
	view.request_status = GOLDEN_STATUS_NOT_CONFIRMED;
	CHECK(golden_job_decide(&view, &reason) == GOLDEN_JOB_FAILED);
	CHECK(strcmp(reason, "not_confirmed") == 0);

	/* No answer: waiting in this boot, and after a restart a bootloader without promotion. */
	view.request_status = GOLDEN_STATUS_PENDING;
	view.handed_over = true;
	CHECK(golden_job_decide(&view, &reason) == GOLDEN_JOB_WAIT);
	view.handed_over = false;
	CHECK(golden_job_decide(&view, &reason) == GOLDEN_JOB_FAILED);
	CHECK(strcmp(reason, "bootloader_unsupported") == 0);

	/* Refused before any restart. */
	view = view_for(&record);
	view.running.minor = 18;
	CHECK(golden_job_decide(&view, &reason) == GOLDEN_JOB_REFUSE);
	CHECK(strcmp(reason, "not_running") == 0);
	view = view_for(&record);
	view.running_confirmed = false;
	CHECK(golden_job_decide(&view, &reason) == GOLDEN_JOB_REFUSE);
	CHECK(strcmp(reason, "not_confirmed") == 0);
	view = view_for(&record);
	view.info_present = true;
	view.info = sample(3).pin;
	view.info.sha256[0] ^= 1;
	CHECK(golden_job_decide(&view, &reason) == GOLDEN_JOB_REFUSE);
	CHECK(strcmp(reason, "not_newer") == 0);
	view.info.counter = 9;
	CHECK(golden_job_decide(&view, &reason) == GOLDEN_JOB_REFUSE);
}

static void hex(const uint8_t *bytes, size_t len, char *out)
{
	for (size_t i = 0; i < len; i++) {
		snprintf(out + 2 * i, 3, "%02x", bytes[i]);
	}
}

static void test_job_document(void)
{
	static char json[1024];
	static char record_hex[2 * GOLDEN_RECORD_SIZE + 1];
	static struct ota_job job;
	struct golden_record record = sample(4);
	uint8_t bytes[GOLDEN_RECORD_SIZE];

	golden_record_encode(&record, bytes);
	hex(bytes, sizeof(bytes), record_hex);

	snprintf(json, sizeof(json),
		 "{\"execution\":{\"jobId\":\"gold-1-19-2-b0-c4-x\",\"status\":\"QUEUED\","
		 "\"jobDocument\":{\"op\":\"golden_promote\",\"v\":1,\"record\":\"%s\"}}}",
		 record_hex);
	CHECK(ota_job_parse(json, strlen(json), "https://example.com/firmware/", &job) == OTA_JOB_OK);
	CHECK(job.golden);
	CHECK(!job.in_progress);
	CHECK(strcmp(job.id, "gold-1-19-2-b0-c4-x") == 0);
	CHECK(memcmp(job.golden_record, bytes, sizeof(bytes)) == 0);

	/* The record has to be all there, in lower-case hex. */
	record_hex[10] = 'G';
	snprintf(json, sizeof(json),
		 "{\"execution\":{\"jobId\":\"g1\",\"status\":\"IN_PROGRESS\","
		 "\"jobDocument\":{\"op\":\"golden_promote\",\"v\":1,\"record\":\"%s\"}}}",
		 record_hex);
	CHECK(ota_job_parse(json, strlen(json), "https://example.com/firmware/", &job) ==
	      OTA_JOB_BAD_DOCUMENT);
	CHECK(strcmp(job.id, "g1") == 0 && job.in_progress && !job.golden);

	snprintf(json, sizeof(json),
		 "{\"execution\":{\"jobId\":\"g2\",\"jobDocument\":{\"op\":\"golden_promote\",\"v\":1,"
		 "\"record\":\"abcd\"}}}");
	CHECK(ota_job_parse(json, strlen(json), "https://example.com/firmware/", &job) ==
	      OTA_JOB_BAD_DOCUMENT);

	/* Another version of the document is not this one. */
	snprintf(json, sizeof(json),
		 "{\"execution\":{\"jobId\":\"g3\",\"jobDocument\":{\"op\":\"golden_promote\",\"v\":2,"
		 "\"record\":\"abcd\"}}}");
	CHECK(ota_job_parse(json, strlen(json), "https://example.com/firmware/", &job) ==
	      OTA_JOB_UNSUPPORTED);
}

int main(void)
{
	test_format();
	test_status();
	test_bootloader_decides();
	test_state_page();
	test_der_signature();
	test_versions();
	test_job_policy();
	test_job_document();

	printf("golden_record_tests: %d checks, %d failures\n", checks, failures);
	return failures == 0 ? 0 : 1;
}
