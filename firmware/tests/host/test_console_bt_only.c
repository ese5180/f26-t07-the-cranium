/*
 * Host-side tests of the serial console on a board with Bluetooth only (CONFIG_APP_BT_ONLY): the
 * nRF5340 DK. Its Wi-Fi, cloud and certificate commands say that they are not on this board, HELP and
 * STATUS leave them out, STATUS and the boxes say what the board is, and BT_PASSKEY stores the board's
 * own passkey without ever showing it. The console's code runs as it is, against the fake board in
 * console_fakes.c and a fake of src/bt/bt_passkey.c.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bt_ota.h"
#include "bt_passkey.h"
#include "console_cmd.h"
#include "console_fakes.h"
#include "device.h"
#include "identity.h"

static int failed_checks;
static int checks;

#define CHECK(condition)                                                                     \
	do {                                                                                 \
		checks++;                                                                    \
		if (!(condition)) {                                                          \
			failed_checks++;                                                     \
			printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);         \
		}                                                                            \
	} while (0)

#define CHECK_TEXT(actual, expected)                                                         \
	do {                                                                                 \
		const char *actual_ = (actual);                                              \
		checks++;                                                                    \
		if (strcmp(actual_, (expected)) != 0) {                                      \
			failed_checks++;                                                     \
			printf("FAIL %s:%d: \"%s\", expected \"%s\"\n", __FILE__, __LINE__,  \
			       actual_, (expected));                                         \
		}                                                                            \
	} while (0)

#define NOT_HERE "ERR not on this board: an nrf5340dk has Bluetooth only, no Wi-Fi and no cloud"

/* ---- bt_passkey.h and bt_ota.h, as far as the console asks ------------------------------ */

static struct {
	enum bt_passkey_state state;
	uint32_t passkey;
	uint16_t tag;
	uint32_t failures;
	int stores;
	int erases;
	int store_result;
	bool window_open;
} bt;

enum bt_passkey_state bt_passkey_state(void)
{
	return bt.state;
}

const char *bt_passkey_state_name(enum bt_passkey_state state)
{
	return state == BT_PASSKEY_STATE_SET ? "set" : state == BT_PASSKEY_STATE_LOCKED ? "locked" : "unset";
}

uint32_t bt_passkey_failures(void)
{
	return bt.failures;
}

bool bt_passkey_tag(uint16_t *tag)
{
	*tag = bt.tag;
	return bt.state == BT_PASSKEY_STATE_SET;
}

int bt_passkey_store(uint32_t passkey, uint16_t tag)
{
	fake_note_op("bt-store");
	bt.stores++;
	if (bt.store_result != 0) {
		return bt.store_result;
	}
	bt.passkey = passkey;
	bt.tag = tag;
	bt.failures = 0;
	bt.state = BT_PASSKEY_STATE_SET;
	return 0;
}

int bt_passkey_erase(void)
{
	fake_note_op("bt-erase");
	bt.erases++;
	bt.state = BT_PASSKEY_STATE_NONE;
	bt.passkey = 0;
	return 0;
}

bool bt_ota_is_open(void)
{
	return bt.window_open;
}

/* bt_offline.h: a new passkey and name, as bt_offline.c draws them. */
int bt_offline_new_passkey(uint32_t *passkey, uint16_t *tag)
{
	if (bt.window_open) {
		return -EBUSY;
	}
	fake_note_op("bt-offline-new");
	bt.stores++;
	bt.passkey = 517294;
	bt.tag = 0x2a7c;
	bt.state = BT_PASSKEY_STATE_SET;
	*passkey = bt.passkey;
	*tag = bt.tag;
	return 0;
}

/* ---- helpers, as test_console.c has them ----------------------------------------------- */

static void feed(const char *text)
{
	for (; *text != '\0'; text++) {
		console_cmd_feed(*text);
	}
}

static void command(const char *line)
{
	fake_clear_log();
	feed(line);
	feed("\r");
}

static const char *final_line(void)
{
	static char line[512];
	size_t length = strlen(fake.output);
	const char *start;

	if (length == 0) {
		return "";
	}

	start = fake.output + length - 1;
	while (start > fake.output && start[-1] != '\n') {
		start--;
	}

	snprintf(line, sizeof(line), "%.*s", (int)(fake.output + length - 1 - start), start);
	return line;
}

static const char *value_of(const char *key)
{
	static char value[256];
	const char *at = fake.output;

	while (at != NULL && *at != '\0') {
		const char *end = strchr(at, '\n');
		size_t key_length = strlen(key);

		if (strncmp(at, key, key_length) == 0 && at[key_length] == ' ') {
			const char *text = at + key_length;

			while (*text == ' ') {
				text++;
			}

			snprintf(value, sizeof(value), "%.*s", (int)(end - text), text);
			return value;
		}

		at = end != NULL ? end + 1 : NULL;
	}

	return "<none>";
}

static void boot(void)
{
	fake.cut_after = -1;
	CHECK(identity_init() == 0);
	(void)device_boot();
	console_cmd_init();
	feed("ECHO|OFF\r");
	fake_clear_log();
}

static void factory_board(void)
{
	fake_reset();
	memset(&bt, 0, sizeof(bt));
	boot();
}

/* Set up with INIT, and nothing else: no network, no cloud, no certificate on this board. */
static void operating_board(void)
{
	factory_board();
	command("INIT|CRVIHAAN01");
	CHECK(fake.reboots == 1);
	/* INIT erased the passkey, which there was none of. */
	CHECK(bt.erases == 1);
	memset(&bt, 0, sizeof(bt));
	boot();
	CHECK(!device_is_factory());
	fake_clear_log();
}

/* ---- tests ----------------------------------------------------------------------------- */

static void test_wifi_cloud_and_certificates_are_not_on_this_board(void)
{
	static const char *const lines[] = {
		"WIFI|MyNetwork|correct-horse-battery",
		"WIFI_SEC|MyNetwork|WPA3_SAE|correct-horse-battery",
		"CLEAR_WIFI",
		"NET",
		"CLOUD|example-ats.iot.us-east-1.amazonaws.com|https://bucket.s3.amazonaws.com/firmware/",
		"CLOUD|",
		"KEYGEN",
		"KEYGEN|REPLACE",
		"MQTT",
		"MQTT_HOST|example-ats.iot.us-east-1.amazonaws.com",
		"MQTT_RECONNECT",
		"RESET_CONFIG",
		"STREAM_START|100|1|abcd|CA",
		"STREAM_CHUNK|0|AAAA",
		"STREAM_STATUS",
		"STREAM_CANCEL",
		"wifi|MyNetwork|correct-horse-battery",
	};

	operating_board();
	for (size_t i = 0; i < sizeof(lines) / sizeof(lines[0]); i++) {
		command(lines[i]);
		CHECK(fake.finals == 1);
		CHECK_TEXT(final_line(), NOT_HERE);
		/* Not even the arguments come back, where a password can be. */
		CHECK(strstr(fake.output, "correct-horse-battery") == NULL);
	}

	CHECK(!fake.wifi_stored);
	CHECK(strstr(fake.ops, "wifi") == NULL);
	CHECK(fake.joins == 0 && fake.cloud_changes == 0 && fake.key_stores == 0);

	/* In factory mode as well: that is what the board is, before it is anything else. */
	factory_board();
	command("WIFI|MyNetwork|correct-horse-battery");
	CHECK_TEXT(final_line(), NOT_HERE);
	command("SET_ID|X");
	CHECK_TEXT(final_line(), "ERR factory mode, send INIT|<id> first");
}

static void test_help_lists_what_this_board_has(void)
{
	operating_board();
	command("HELP");
	CHECK(fake.finals == 1);
	CHECK_TEXT(final_line(), "OK");
	CHECK(strstr(fake.output, "+-- Device ") != NULL);
	CHECK(strstr(fake.output, "+-- Bluetooth ") != NULL);
	CHECK(strstr(fake.output, "BT_PASSKEY") != NULL);
	CHECK(strstr(fake.output, "+-- Status ") != NULL);
	CHECK(strstr(fake.output, "Wi-Fi") == NULL);
	CHECK(strstr(fake.output, "Cloud") == NULL);
	CHECK(strstr(fake.output, "certificate") == NULL);
	CHECK(strstr(fake.output, "WIFI") == NULL);
	CHECK(strstr(fake.output, "MQTT") == NULL);
	CHECK(strstr(fake.output, "KEYGEN") == NULL);
	CHECK(strstr(fake.output, "RESET_CONFIG") == NULL);
	CHECK(strstr(fake.output, "STREAM_") == NULL);
	/* STATUS takes the sections this board has, in a column that wraps. */
	CHECK(strstr(fake.output, "[<device or") != NULL);
	CHECK(strstr(fake.output, " bluetooth") != NULL);
	CHECK(strstr(fake.output, "update>]") != NULL);
	CHECK(strstr(fake.output, "certs") == NULL);
}

static void test_status_says_what_the_board_is(void)
{
	operating_board();
	bt.state = BT_PASSKEY_STATE_SET;
	bt.tag = 0x3f9c;
	bt.failures = 1;

	command("STATUS");
	CHECK_TEXT(final_line(), "OK");
	CHECK_TEXT(value_of("board"), "nrf5340dk");
	CHECK_TEXT(value_of("layout"), "1");
	CHECK_TEXT(value_of("id"), "CRVIHAAN01");
	CHECK_TEXT(value_of("thing name"), "cranium-fe5b26c0c5b1dcd7");
	CHECK_TEXT(value_of("bt passkey"), "set");
	CHECK_TEXT(value_of("bt failures"), "1 of 3");
	CHECK_TEXT(value_of("bt name"), "Cranium-3F9C");
	CHECK_TEXT(value_of("bt window"), "closed");
	CHECK_TEXT(value_of("update"), "idle (last: none)");
	CHECK_TEXT(value_of("wifi network"), "<none>");
	CHECK_TEXT(value_of("endpoint"), "<none>");
	CHECK_TEXT(value_of("root CA"), "<none>");

	command("STATUS|bluetooth");
	CHECK_TEXT(final_line(), "OK");
	CHECK_TEXT(value_of("bt passkey"), "set");
	CHECK_TEXT(value_of("board"), "<none>");

	bt.state = BT_PASSKEY_STATE_NONE;
	bt.window_open = true;
	command("STATUS|BLUETOOTH");
	CHECK_TEXT(value_of("bt passkey"), "unset");
	CHECK_TEXT(value_of("bt name"), "a new one for each window");
	CHECK_TEXT(value_of("bt window"), "open");

	command("STATUS|wifi");
	CHECK_TEXT(final_line(), NOT_HERE);
	command("STATUS|certs");
	CHECK_TEXT(final_line(), NOT_HERE);
	command("STATUS|nonsense");
	CHECK_TEXT(final_line(), "ERR unknown section, use one of: device bluetooth update");
}

static void test_the_boxes_say_bluetooth_only(void)
{
	operating_board();
	command("STATS");
	CHECK(strstr(fake.output, "| Board     nrf5340dk, Bluetooth only") != NULL);
	CHECK(strstr(fake.output, "WiFi") == NULL);

	fake_clear_log();
	console_cmd_boot_box();
	CHECK(strstr(fake.output, "[BOOT] | Board     nrf5340dk, Bluetooth only") != NULL);
	CHECK(strstr(fake.output, "WiFi") == NULL);
}

static void test_bt_passkey_stores_it_and_never_shows_it(void)
{
	operating_board();
	command("BT_PASSKEY|284913|3f9c");
	CHECK(fake.finals == 1);
	CHECK_TEXT(final_line(), "OK passkey stored, advertising as Cranium-3F9C");
	CHECK(bt.stores == 1 && bt.passkey == 284913 && bt.tag == 0x3f9c);
	CHECK(strstr(fake.output, "284913") == NULL);
	CHECK(strstr(fake.events, "284913") == NULL);
	CHECK(strstr(fake.cloud_events, "284913") == NULL);

	command("STATUS|bluetooth");
	CHECK(strstr(fake.output, "284913") == NULL);
	CHECK_TEXT(value_of("bt passkey"), "set");

	command("BT_PASSKEY|clear");
	CHECK_TEXT(final_line(), "OK passkey erased: each pairing now shows a new passkey here");
	CHECK(bt.erases == 1 && bt.state == BT_PASSKEY_STATE_NONE);
}

/*
 * A Bluetooth passkey changed at the serial console is an event for the console in the cloud, as every
 * other change of the board is: never with the passkey, and in words that src/cloud/cloud_events.c and
 * the cloud's own check send and store, which a line with "passkey" in it never is.
 */
static void test_bluetooth_passkey_changes_go_to_the_cloud(void)
{
	static const char *const stored = "CONSOLE|Bluetooth pairing code changed\n";

	operating_board();
	command("BT_PASSKEY|284913|3F9C");
	CHECK_TEXT(fake.cloud_events, stored);

	operating_board();
	command("BT_PASSKEY|CLEAR");
	CHECK_TEXT(fake.cloud_events, stored);

	operating_board();
	command("BT_OFFLINE|NEW");
	CHECK(strncmp(final_line(), "OK passkey 517294", 17) == 0);
	CHECK_TEXT(fake.cloud_events, stored);
	CHECK(strstr(fake.cloud_events, "517294") == NULL);

	/* What did not work changed nothing, and is no event. */
	operating_board();
	command("BT_PASSKEY|123456|3F9C");
	CHECK_TEXT(fake.cloud_events, "");
	operating_board();
	bt.window_open = true;
	command("BT_OFFLINE|NEW");
	CHECK_TEXT(fake.cloud_events, "");
	bt.window_open = false;

	/* No word that the cloud refuses to store is in it. */
	CHECK(strcasestr(stored, "passkey") == NULL);
}

static void test_bt_passkey_refuses_what_is_not_a_passkey(void)
{
	static const char *const lines[] = {
		"BT_PASSKEY|28491|3F9C",   "BT_PASSKEY|2849133|3F9C", "BT_PASSKEY|28491a|3F9C",
		"BT_PASSKEY|123456|3F9C",  "BT_PASSKEY|000000|3F9C",  "BT_PASSKEY|284913",
		"BT_PASSKEY|284913|3F9",   "BT_PASSKEY|284913|3G9C",  "BT_PASSKEY|284913|3F9C|x",
		"BT_PASSKEY|CLEAR|3F9C",
	};

	operating_board();
	for (size_t i = 0; i < sizeof(lines) / sizeof(lines[0]); i++) {
		command(lines[i]);
		CHECK(fake.finals == 1);
		CHECK(strncmp(final_line(), "ERR usage: BT_PASSKEY|<6 digits>|<4 hex digits>", 47) == 0);
	}
	command("BT_PASSKEY");
	CHECK(strncmp(final_line(), "ERR usage: BT_PASSKEY|", 22) == 0);
	CHECK(bt.stores == 0 && bt.erases == 0);
	CHECK(strstr(fake.output, "284913") == NULL);
}

static void test_bt_passkey_waits_for_a_quiet_board(void)
{
	operating_board();
	fake.ota = OTA_TESTING;
	command("BT_PASSKEY|284913|3F9C");
	CHECK_TEXT(final_line(), "ERR update in progress");
	fake.ota = OTA_BLUETOOTH;
	command("BT_PASSKEY|CLEAR");
	CHECK_TEXT(final_line(), "ERR update in progress");
	fake.ota = OTA_IDLE;

	bt.window_open = true;
	command("BT_PASSKEY|284913|3F9C");
	CHECK_TEXT(final_line(), "ERR Bluetooth is open: close it with Button 2 first");
	bt.window_open = false;

	bt.store_result = -EIO;
	command("BT_PASSKEY|284913|3F9C");
	CHECK_TEXT(final_line(), "ERR the passkey could not be stored (-5)");
	CHECK(bt.stores == 1);

	factory_board();
	command("BT_PASSKEY|284913|3F9C");
	CHECK_TEXT(final_line(), "ERR factory mode, send INIT|<id> first");
	CHECK(bt.stores == 0);
}

static void test_a_factory_reset_takes_the_passkey_and_nothing_of_the_cloud(void)
{
	operating_board();
	bt.state = BT_PASSKEY_STATE_SET;
	command("FACTORY_RESET");
	CHECK(strncmp(final_line(), "OK erased", 9) == 0);
	CHECK(bt.erases == 1);
	CHECK(strstr(fake.ops, "bt-erase") != NULL);
	/* No network to clear, and no key or certificate to delete. */
	CHECK(strstr(fake.ops, "wifi-clear") == NULL);
	CHECK(strstr(fake.ops, "tls") == NULL);

	/* INIT erases everything first as well. */
	factory_board();
	command("INIT|CRVIHAAN01");
	CHECK(bt.erases == 1);
}

static void test_what_every_board_has_is_still_there(void)
{
	operating_board();
	command("GET_ID");
	CHECK(strncmp(final_line(), "OK CRVIHAAN01|", 14) == 0);
	command("THING");
	CHECK_TEXT(final_line(), "OK cranium-fe5b26c0c5b1dcd7");
	command("SET_ID|BENCH2");
	CHECK_TEXT(final_line(), "OK id set to BENCH2");
	command("BUTTON|1");
	CHECK_TEXT(final_line(), "OK button 1");
	command("ECHO|ON");
	CHECK_TEXT(final_line(), "OK echo on");
}

int main(void)
{
	test_wifi_cloud_and_certificates_are_not_on_this_board();
	test_help_lists_what_this_board_has();
	test_status_says_what_the_board_is();
	test_the_boxes_say_bluetooth_only();
	test_bt_passkey_stores_it_and_never_shows_it();
	test_bt_passkey_refuses_what_is_not_a_passkey();
	test_bt_passkey_waits_for_a_quiet_board();
	test_bluetooth_passkey_changes_go_to_the_cloud();
	test_a_factory_reset_takes_the_passkey_and_nothing_of_the_cloud();
	test_what_every_board_has_is_still_there();

	printf("%d Bluetooth-only console checks, %d failed\n", checks, failed_checks);
	return failed_checks == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
