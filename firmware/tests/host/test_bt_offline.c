/*
 * Host-side tests of the offline Bluetooth mode (src/policy/bt_offline_policy.c): the status payload byte
 * by byte, the UUIDs, what the one write may do, and how the board's own passkey is drawn.
 *
 * The phone apps parse the same bytes: their tests take the payload that sample() makes here, printed
 * by `build/bt_offline_tests --print`.
 */

#include <stdio.h>
#include <string.h>

#include "bt_offline_policy.h"
#include "bt_passkey_policy.h"

static int failures;
static int checks;

#define CHECK(condition)                                                                           \
	do {                                                                                       \
		checks++;                                                                          \
		if (!(condition)) {                                                                \
			failures++;                                                                \
			printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);               \
		}                                                                                  \
	} while (0)

/* An update from a phone waits on a board that runs 1.18.2+7, with no Wi-Fi or cloud, after a watchdog. */
static struct bt_offline_status sample(void)
{
	return (struct bt_offline_status){
		.running = { 1, 18, 0x0102, 0x0a0b0c0d },
		.wifi = BT_OFFLINE_WIFI_DOWN,
		.cloud = BT_OFFLINE_CLOUD_DOWN,
		.update = BT_OFFLINE_UPDATE_BT_WAITING,
		.reboot = 2,
		.uptime_seconds = 0x01020304,
		.waiting = { 1, 19, 0, 0 },
	};
}

static void test_payload(void)
{
	static const uint8_t expected[BT_OFFLINE_LEN] = {
		1, 1, 1, 4, 2, 0, 1, 18, 0x02, 0x01, 0x0d, 0x0c, 0x0b, 0x0a, 0x04, 0x03, 0x02, 0x01, 1, 19,
	};
	struct bt_offline_status status = sample();
	uint8_t out[BT_OFFLINE_LEN];

	bt_offline_encode(&status, out);
	CHECK(memcmp(out, expected, sizeof(out)) == 0);

	/* The waiting version is only in the payload while an update waits. */
	status.update = BT_OFFLINE_UPDATE_IDLE;
	bt_offline_encode(&status, out);
	CHECK(out[3] == 0 && out[18] == 0 && out[19] == 0);

	/* No Wi-Fi and no cloud on a board that has none. */
	status.wifi = BT_OFFLINE_WIFI_NONE;
	status.cloud = BT_OFFLINE_CLOUD_NONE;
	bt_offline_encode(&status, out);
	CHECK(out[1] == 0 && out[2] == 0);
}

static void test_uuids(void)
{
	static const uint8_t service[16] = { BT_OFFLINE_SERVICE_UUID_VAL };
	static const uint8_t status[16] = { BT_OFFLINE_STATUS_UUID_VAL };
	static const uint8_t control[16] = { BT_OFFLINE_CONTROL_UUID_VAL };
	/* 9112B1B6-2A51-40F0-94D3-A76440F0E6CC, on the air: last byte of the text first. */
	static const uint8_t b6[16] = { 0xcc, 0xe6, 0xf0, 0x40, 0x64, 0xa7, 0xd3, 0x94,
					0xf0, 0x40, 0x51, 0x2a, 0xb6, 0xb1, 0x12, 0x91 };

	CHECK(memcmp(service, b6, 16) == 0);
	CHECK(status[12] == 0xb7 && memcmp(status, service, 12) == 0 && memcmp(status + 13, service + 13, 3) == 0);
	CHECK(control[12] == 0xb8 && memcmp(control, service, 12) == 0 && memcmp(control + 13, service + 13, 3) == 0);
}

static void test_accept(void)
{
	const struct bt_offline_version waiting = { 1, 19, 3, 9 };
	const uint8_t good[3] = { BT_OFFLINE_OP_ACCEPT, 1, 19 };
	const uint8_t other_version[3] = { BT_OFFLINE_OP_ACCEPT, 1, 18 };
	const uint8_t other_op[3] = { 2, 1, 19 };
	const uint8_t too_long[4] = { BT_OFFLINE_OP_ACCEPT, 1, 19, 0 };

	CHECK(bt_offline_accept_check(good, 3, true, &waiting) == BT_OFFLINE_ACCEPT_OK);
	CHECK(bt_offline_accept_check(good, 3, false, &waiting) == BT_OFFLINE_ACCEPT_NOTHING_WAITING);
	CHECK(bt_offline_accept_check(good, 3, true, NULL) == BT_OFFLINE_ACCEPT_NOTHING_WAITING);
	CHECK(bt_offline_accept_check(other_version, 3, true, &waiting) == BT_OFFLINE_ACCEPT_VERSION_MISMATCH);
	CHECK(bt_offline_accept_check(other_op, 3, true, &waiting) == BT_OFFLINE_ACCEPT_MALFORMED);
	CHECK(bt_offline_accept_check(too_long, 4, true, &waiting) == BT_OFFLINE_ACCEPT_MALFORMED);
	CHECK(bt_offline_accept_check(good, 2, true, &waiting) == BT_OFFLINE_ACCEPT_MALFORMED);
	CHECK(bt_offline_accept_check(NULL, 0, true, &waiting) == BT_OFFLINE_ACCEPT_MALFORMED);
	/* Malformed is answered before anything else, so a stray write never says what waits. */
	CHECK(bt_offline_accept_check(other_op, 3, false, &waiting) == BT_OFFLINE_ACCEPT_MALFORMED);
}

static void test_passkey_draw(void)
{
	uint32_t words[4];
	uint32_t passkey = 0;
	uint16_t tag = 0;

	/* The first good word wins, and the next one names the board. */
	words[0] = 123456U;
	words[1] = 0x0000abcdU;
	CHECK(bt_passkey_weak(123456U));
	CHECK(bt_offline_passkey_from_random(words, 2, &passkey, &tag) == false);

	words[0] = 482913U;
	CHECK(bt_offline_passkey_from_random(words, 2, &passkey, &tag));
	CHECK(passkey == 482913U && tag == 0xabcd);

	/* Reduced modulo a million. */
	words[0] = 2000482913U;
	CHECK(bt_offline_passkey_from_random(words, 2, &passkey, &tag) && passkey == 482913U);

	/* Words that would favour small passkeys are skipped, and so are weak ones. */
	words[0] = 4294967295U;
	words[1] = 555555U;
	words[2] = 719305U;
	words[3] = 0x1234;
	CHECK(bt_offline_passkey_from_random(words, 4, &passkey, &tag) && passkey == 719305U && tag == 0x1234);

	/* Nothing usable, or not enough words. */
	words[2] = 111111U;
	CHECK(!bt_offline_passkey_from_random(words, 4, &passkey, &tag));
	CHECK(!bt_offline_passkey_from_random(words, 1, &passkey, &tag));
	CHECK(!bt_offline_passkey_from_random(NULL, 4, &passkey, &tag));

	/* Whatever it returns parses as a passkey the board accepts. */
	for (uint32_t i = 0; i < 200000; i++) {
		uint32_t w[2] = { i * 21474u + 12345u, i };

		if (bt_offline_passkey_from_random(w, 2, &passkey, &tag)) {
			CHECK(passkey <= BT_PASSKEY_MAX && !bt_passkey_weak(passkey));
		}
	}
}

int main(int argc, char **argv)
{
	if (argc > 1 && strcmp(argv[1], "--print") == 0) {
		struct bt_offline_status status = sample();
		uint8_t out[BT_OFFLINE_LEN];

		bt_offline_encode(&status, out);
		for (size_t i = 0; i < sizeof(out); i++) {
			printf("%02x", out[i]);
		}
		printf("\n");
		return 0;
	}

	test_payload();
	test_uuids();
	test_accept();
	test_passkey_draw();

	printf("bt_offline: %d checks, %d failures\n", checks, failures);
	return failures == 0 ? 0 : 1;
}
