/*
 * Host-side tests of the Bluetooth status (src/bt/bt_status.c) and of what src/policy/bt_ota_policy.c decides
 * for it: the payload byte by byte, the UUIDs as the phones write them, what counts as news, how a
 * window's end is told, and when the board advertises its status after a restart, and for how long.
 *
 * The phone apps parse the same bytes: their tests (BoardStatusTests.swift, BoardStatusTest.kt) take
 * the payload that sample_payload() makes here, printed by `build/bt_status_tests --print`.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bt_ota_policy.h"
#include "bt_status.h"

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

/* An offer of 1.14.1+0 on a board that runs 1.14.0+0 on trial, after a Bluetooth update before. */
static struct bt_status sample(void)
{
	struct bt_status status = {
		.window = BT_STATUS_WINDOW_OFFER,
		.seconds_left = 0x0102,
		.image = BT_STATUS_IMAGE_VERIFIED,
		.refusal = BT_STATUS_REFUSAL_NONE,
		.image_bytes = 0x000d4e38,
		.image_version = { 1, 14, 1, 0 },
		.result = BT_STATUS_RESULT_NONE,
		.closed = 0,
		.running = { 1, 14, 0, 0 },
		.on_trial = true,
		.swap = BT_STATUS_SWAP_REVERT,
		.last_via = BT_STATUS_VIA_BLUETOOTH,
		.last_outcome = BT_STATUS_OUTCOME_PENDING,
		.last_proof = BT_STATUS_PROOF_NONE,
		.last_target = { 1, 14, 0, 0 },
		.last_from = { 1, 13, 2, 7 },
		.last_hash = { 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04 },
		.last_count = 3,
		.uptime_seconds = 0x01020304,
	};

	return status;
}

static void test_the_payload_byte_by_byte(void)
{
	const struct bt_status status = sample();
	static const uint8_t expected[BT_STATUS_LEN] = {
		/* format, window, seconds left */
		0x01, 0x03, 0x02, 0x01,
		/* image, refusal, bytes */
		0x03, 0x00, 0x38, 0x4e, 0x0d, 0x00,
		/* image version 1.14.1+0 */
		0x01, 0x0e, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
		/* result, closed */
		0x00, 0x00,
		/* running 1.14.0+0 */
		0x01, 0x0e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		/* on trial, swap revert; via, outcome, proof */
		0x07, 0x01, 0x01, 0x00,
		/* last target 1.14.0+0, from 1.13.2+7 */
		0x01, 0x0e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x01, 0x0d, 0x02, 0x00, 0x07, 0x00, 0x00, 0x00,
		/* hash, count, uptime, reserved */
		0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04,
		0x03, 0x00, 0x04, 0x03, 0x02, 0x01, 0x00, 0x00,
	};
	uint8_t out[BT_STATUS_LEN];

	memset(out, 0xee, sizeof(out));
	bt_status_encode(&status, out);
	CHECK(memcmp(out, expected, sizeof(out)) == 0);
	for (size_t i = 0; i < sizeof(out); i++) {
		if (out[i] != expected[i]) {
			printf("  byte %zu: %02x, expected %02x\n", i, out[i], expected[i]);
		}
	}
}

static void test_a_board_with_nothing_to_say(void)
{
	const struct bt_status status = { .running = { 1, 14, 0, 0 } };
	uint8_t out[BT_STATUS_LEN];

	bt_status_encode(&status, out);
	CHECK(out[0] == BT_STATUS_FORMAT);
	CHECK(out[20] == 1 && out[21] == 14);
	for (size_t i = 1; i < sizeof(out); i++) {
		if (i != 20 && i != 21) {
			CHECK(out[i] == 0);
		}
	}
}

/* As the phones write them, most significant byte first. */
static void uuid_text(const uint8_t bytes[16], char out[37])
{
	size_t at = 0;

	for (int i = 15; i >= 0; i--) {
		at += (size_t)snprintf(out + at, 37 - at, "%02X", bytes[i]);
		if (i == 12 || i == 10 || i == 8 || i == 6) {
			out[at++] = '-';
		}
	}
	out[at] = '\0';
}

static void test_the_uuids_are_the_ones_the_phones_use(void)
{
	static const uint8_t service[16] = { BT_STATUS_SERVICE_UUID_VAL };
	static const uint8_t characteristic[16] = { BT_STATUS_CHAR_UUID_VAL };
	char text[37];

	uuid_text(service, text);
	CHECK(strcmp(text, "9112B1B4-2A51-40F0-94D3-A76440F0E6CC") == 0);
	uuid_text(characteristic, text);
	CHECK(strcmp(text, "9112B1B5-2A51-40F0-94D3-A76440F0E6CC") == 0);
}

static void test_what_counts_as_news(void)
{
	struct bt_status status = sample();
	uint8_t before[BT_STATUS_LEN];
	uint8_t after[BT_STATUS_LEN];

	bt_status_encode(&status, before);

	/* What counts by itself. */
	status.seconds_left--;
	status.image_bytes += 4096;
	status.uptime_seconds++;
	bt_status_encode(&status, after);
	CHECK(!bt_status_news(before, after));

	/* Anything else. */
	status.result = BT_STATUS_RESULT_INSTALLING;
	bt_status_encode(&status, after);
	CHECK(bt_status_news(before, after));

	status = sample();
	status.last_outcome = BT_STATUS_OUTCOME_KEPT;
	bt_status_encode(&status, after);
	CHECK(bt_status_news(before, after));

	status = sample();
	status.on_trial = false;
	bt_status_encode(&status, after);
	CHECK(bt_status_news(before, after));
}

static void test_how_a_window_ended(void)
{
	CHECK(bt_ota_status_result(BT_OTA_CLOSED_BY_BUTTON, true, false) == BT_STATUS_RESULT_DISCARDED);
	CHECK(bt_ota_status_result(BT_OTA_CLOSED_BY_BUTTON, false, false) == BT_STATUS_RESULT_CLOSED);
	CHECK(bt_ota_status_result(BT_OTA_CLOSED_OFFER_EXPIRED, true, false) ==
	      BT_STATUS_RESULT_TIMED_OUT);
	/* The same reason, for an image that could not be offered. */
	CHECK(bt_ota_status_result(BT_OTA_CLOSED_OFFER_EXPIRED, false, true) ==
	      BT_STATUS_RESULT_CLOSED);
	CHECK(bt_ota_status_result(BT_OTA_CLOSED_TIME_UP, false, false) == BT_STATUS_RESULT_TIMED_OUT);
	CHECK(bt_ota_status_result(BT_OTA_CLOSED_PAIRING_FAILED, false, false) ==
	      BT_STATUS_RESULT_CLOSED);
	CHECK(bt_ota_status_result(BT_OTA_CLOSED_SESSION_LIMIT, false, false) ==
	      BT_STATUS_RESULT_CLOSED);
	CHECK(bt_ota_status_result(BT_OTA_CLOSED_TRIAL_OVER, false, false) == BT_STATUS_RESULT_CLOSED);
}

static void test_refusals_and_outcomes_in_the_status_words(void)
{
	CHECK(bt_ota_status_refusal(BT_OTA_UPLOAD_OK) == BT_STATUS_REFUSAL_NONE);
	CHECK(bt_ota_status_refusal(BT_OTA_UPLOAD_NOT_NEWER) == BT_STATUS_REFUSAL_OLDER);
	CHECK(bt_ota_status_refusal(BT_OTA_UPLOAD_NOT_IMAGE_0) == BT_STATUS_REFUSAL_NOT_IMAGE_0);
	CHECK(bt_ota_status_refusal(BT_OTA_UPLOAD_NO_HEADER) == BT_STATUS_REFUSAL_NO_HEADER);
	CHECK(bt_ota_status_refusal(BT_OTA_UPLOAD_TOO_LARGE) == BT_STATUS_REFUSAL_TOO_LARGE);
	CHECK(bt_ota_status_refusal(BT_OTA_UPLOAD_BAD_SIZES) == BT_STATUS_REFUSAL_BAD_SIZES);

	CHECK(bt_ota_status_outcome(BT_OTA_RESULT_PENDING) == BT_STATUS_OUTCOME_PENDING);
	CHECK(bt_ota_status_outcome(BT_OTA_RESULT_SUCCEEDED) == BT_STATUS_OUTCOME_KEPT);
	CHECK(bt_ota_status_outcome(BT_OTA_RESULT_ROLLED_BACK) == BT_STATUS_OUTCOME_ROLLED_BACK);
	CHECK(bt_ota_status_outcome(BT_OTA_RESULT_NOT_INSTALLED) == BT_STATUS_OUTCOME_NOT_INSTALLED);
	CHECK(bt_ota_status_outcome(BT_OTA_RESULT_TRIAL_LOST) == BT_STATUS_OUTCOME_TRIAL_LOST);
	CHECK(bt_ota_status_outcome(BT_OTA_RESULT_SUPERSEDED) == BT_STATUS_OUTCOME_SUPERSEDED);
	CHECK(bt_ota_status_outcome(BT_OTA_RESULT_FLASH_ERROR) == BT_STATUS_OUTCOME_FLASH_ERROR);
	CHECK(bt_ota_status_outcome(BT_OTA_RESULT_INCOMPATIBLE_BOARD) ==
	      BT_STATUS_OUTCOME_INCOMPATIBLE_BOARD);
	CHECK(bt_ota_status_outcome(BT_OTA_RESULT_INCOMPATIBLE_LAYOUT) ==
	      BT_STATUS_OUTCOME_INCOMPATIBLE_LAYOUT);
	CHECK(BT_STATUS_PROOF_CLOUD == (int)BT_OTA_PROOF_BY_CLOUD);
	CHECK(BT_STATUS_PROOF_PERSON == (int)BT_OTA_PROOF_BY_PERSON);
}

static void test_which_boots_advertise_their_status(void)
{
	/* The first boot of the new image, and the boot that went back or never got there. */
	CHECK(bt_ota_status_due(BT_OTA_RECORD_ARMED, BT_OTA_RESULT_PENDING));
	CHECK(bt_ota_status_due(BT_OTA_RECORD_TESTING, BT_OTA_RESULT_ROLLED_BACK));
	CHECK(bt_ota_status_due(BT_OTA_RECORD_ARMED, BT_OTA_RESULT_NOT_INSTALLED));
	CHECK(bt_ota_status_due(BT_OTA_RECORD_TESTING, BT_OTA_RESULT_TRIAL_LOST));
	CHECK(bt_ota_status_due(BT_OTA_RECORD_TESTING, BT_OTA_RESULT_SUCCEEDED));

	/* Nothing was under way, or a cloud job came after it. */
	CHECK(!bt_ota_status_due(BT_OTA_RECORD_DONE, BT_OTA_RESULT_SUCCEEDED));
	CHECK(!bt_ota_status_due(BT_OTA_RECORD_DONE, BT_OTA_RESULT_ROLLED_BACK));
	CHECK(!bt_ota_status_due(0, BT_OTA_RESULT_PENDING));
	CHECK(!bt_ota_status_due(BT_OTA_RECORD_ARMED, BT_OTA_RESULT_SUPERSEDED));
}

static void test_bluetooth_starts_after_the_cloud_or_half_a_minute(void)
{
	CHECK(!bt_ota_status_may_start(0, false));
	CHECK(!bt_ota_status_may_start(BT_OTA_STATUS_START_SECONDS - 1, false));
	CHECK(bt_ota_status_may_start(BT_OTA_STATUS_START_SECONDS, false));
	CHECK(bt_ota_status_may_start(3, true));
}

static void test_the_status_window_on_its_own(void)
{
	struct bt_ota_status_window status = { 0 };
	int advertised = 0;
	uint32_t actions = 0;

	/* Closed: nothing. */
	CHECK(bt_ota_status_tick(&status, true, true) == 0);

	/* Two minutes of advertising, and then the end. */
	bt_ota_status_open(&status);
	for (int second = 0; second < BT_OTA_STATUS_SECONDS; second++) {
		actions = bt_ota_status_tick(&status, false, true);
		advertised += (actions & BT_OTA_STATUS_DO_ADVERTISE) != 0;
	}
	CHECK(advertised == BT_OTA_STATUS_SECONDS);
	CHECK(status.open);
	actions = bt_ota_status_tick(&status, false, true);
	CHECK(actions == (BT_OTA_STATUS_DO_STOP | BT_OTA_STATUS_DO_CLOSE));
	CHECK(!status.open);
}

static void test_a_status_link_while_the_trial_lasts(void)
{
	struct bt_ota_status_window status;
	uint32_t actions = 0;
	int second;

	/* No advertising while a phone is there. */
	bt_ota_status_open(&status);
	CHECK(bt_ota_status_tick(&status, true, true) == 0);

	/* On trial past the two minutes: it stays. Once the trial is over, a moment more. */
	for (second = 1; second < BT_OTA_STATUS_SECONDS + 30; second++) {
		actions = bt_ota_status_tick(&status, true, true);
	}
	CHECK(status.open);
	CHECK(actions == BT_OTA_STATUS_DO_STOP);
	for (second = 0; second < BT_OTA_STATUS_LINGER_SECONDS; second++) {
		CHECK(bt_ota_status_tick(&status, true, false) == BT_OTA_STATUS_DO_STOP);
	}
	CHECK(bt_ota_status_tick(&status, true, false) ==
	      (BT_OTA_STATUS_DO_STOP | BT_OTA_STATUS_DO_DISCONNECT | BT_OTA_STATUS_DO_CLOSE));

	/* A trial that never ends: no longer than the limit. */
	bt_ota_status_open(&status);
	for (second = 1; second < BT_OTA_STATUS_LIMIT_SECONDS; second++) {
		actions = bt_ota_status_tick(&status, true, true);
		CHECK((actions & BT_OTA_STATUS_DO_CLOSE) == 0);
	}
	CHECK(bt_ota_status_tick(&status, true, true) ==
	      (BT_OTA_STATUS_DO_STOP | BT_OTA_STATUS_DO_DISCONNECT | BT_OTA_STATUS_DO_CLOSE));

	/* A phone that leaves after the two minutes ends it. */
	bt_ota_status_open(&status);
	for (second = 0; second < BT_OTA_STATUS_SECONDS; second++) {
		(void)bt_ota_status_tick(&status, true, true);
	}
	CHECK(bt_ota_status_tick(&status, false, true) ==
	      (BT_OTA_STATUS_DO_STOP | BT_OTA_STATUS_DO_CLOSE));
}

/* For the apps' tests: the sample, as hex. */
static void print_sample(void)
{
	const struct bt_status status = sample();
	uint8_t out[BT_STATUS_LEN];

	bt_status_encode(&status, out);
	for (size_t i = 0; i < sizeof(out); i++) {
		printf("%02x", out[i]);
	}
	printf("\n");
}

int main(int argc, char **argv)
{
	if (argc > 1 && strcmp(argv[1], "--print") == 0) {
		print_sample();
		return EXIT_SUCCESS;
	}

	test_the_payload_byte_by_byte();
	test_a_board_with_nothing_to_say();
	test_the_uuids_are_the_ones_the_phones_use();
	test_what_counts_as_news();
	test_how_a_window_ended();
	test_refusals_and_outcomes_in_the_status_words();
	test_which_boots_advertise_their_status();
	test_bluetooth_starts_after_the_cloud_or_half_a_minute();
	test_the_status_window_on_its_own();
	test_a_status_link_while_the_trial_lasts();

	printf("%d Bluetooth status checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
