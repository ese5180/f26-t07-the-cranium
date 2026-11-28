/*
 * Host-side tests of the serial console as every nRF7002 DK has it: offline mode (CONFIG_APP_BT_OFFLINE)
 * and with it the board's own passkey (CONFIG_APP_BT_STATIC_PASSKEY). BT_PASSKEY stores a passkey and
 * never shows it, BT_OFFLINE|NEW draws one on the board and shows it once, STATUS|bluetooth says what
 * the board has, every change is an event for the cloud without the passkey, and a factory reset takes
 * the passkey with everything else. The console's code runs as it is, against the fake board in
 * console_fakes.c and a fake of src/bt/bt_passkey.c and bt_offline.c.
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

/* Set up with INIT. */
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

static void test_status_bluetooth_says_what_the_board_has(void)
{
	operating_board();
	bt.state = BT_PASSKEY_STATE_SET;
	bt.tag = 0x3f9c;
	bt.failures = 1;

	command("STATUS");
	CHECK_TEXT(final_line(), "OK");
	CHECK_TEXT(value_of("bt passkey"), "set");
	CHECK_TEXT(value_of("bt failures"), "1 of 3");
	CHECK_TEXT(value_of("bt name"), "Cranium-3F9C");
	CHECK_TEXT(value_of("bt window"), "closed");
	/* The nRF7002 DK's Wi-Fi and cloud are there as well. */
	CHECK(strcmp(value_of("wifi password"), "<none>") != 0);

	command("STATUS|bluetooth");
	CHECK_TEXT(final_line(), "OK");
	CHECK_TEXT(value_of("bt passkey"), "set");
	CHECK_TEXT(value_of("bt name"), "Cranium-3F9C");
	CHECK_TEXT(value_of("wifi password"), "<none>");

	bt.state = BT_PASSKEY_STATE_LOCKED;
	command("STATUS|bluetooth");
	CHECK_TEXT(value_of("bt passkey"), "locked");
	CHECK_TEXT(value_of("bt name"), "a new one for each window");

	bt.state = BT_PASSKEY_STATE_NONE;
	bt.window_open = true;
	command("STATUS|BLUETOOTH");
	CHECK_TEXT(value_of("bt passkey"), "unset");
	CHECK_TEXT(value_of("bt name"), "a new one for each window");
	CHECK_TEXT(value_of("bt window"), "open");

	command("STATUS|nonsense");
	CHECK(strncmp(final_line(), "ERR unknown section, use one of:", 32) == 0);
	CHECK(strstr(final_line(), " bluetooth") != NULL);
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

static void test_bt_offline_new_draws_one_and_shows_it_once(void)
{
	operating_board();
	command("BT_OFFLINE|NEW");
	CHECK(fake.finals == 1);
	CHECK_TEXT(final_line(), "OK passkey 517294, advertising as Cranium-2A7C; this is the only time it is shown");
	CHECK(bt.stores == 1 && bt.state == BT_PASSKEY_STATE_SET);

	/* Nothing shows it again. */
	command("STATUS|bluetooth");
	CHECK(strstr(fake.output, "517294") == NULL);
	CHECK_TEXT(value_of("bt passkey"), "set");
	CHECK_TEXT(value_of("bt name"), "Cranium-2A7C");

	command("BT_OFFLINE");
	CHECK_TEXT(final_line(), "ERR usage: BT_OFFLINE|NEW");
	command("BT_OFFLINE|OLD");
	CHECK_TEXT(final_line(), "ERR usage: BT_OFFLINE|NEW");

	bt.window_open = true;
	command("BT_OFFLINE|NEW");
	CHECK_TEXT(final_line(), "ERR Bluetooth is open: close it with Button 2 first");
	CHECK(bt.stores == 1);
	bt.window_open = false;

	fake.ota = OTA_TESTING;
	command("BT_OFFLINE|NEW");
	CHECK_TEXT(final_line(), "ERR update in progress");
	CHECK(bt.stores == 1);
}

static void test_a_factory_reset_takes_the_passkey_with_the_rest(void)
{
	operating_board();
	bt.state = BT_PASSKEY_STATE_SET;
	command("FACTORY_RESET");
	CHECK_TEXT(final_line(), "OK erased, rebooting into factory mode");
	CHECK(bt.erases == 1);
	CHECK(strstr(fake.ops, "bt-erase") != NULL);
	/* And, on this board, the network and the cloud's key and certificate too. */
	CHECK(strstr(fake.ops, "wifi-clear") != NULL);
	CHECK(strstr(fake.ops, "tls-delete") != NULL);

	/* INIT erases everything first as well. */
	factory_board();
	command("INIT|CRVIHAAN01");
	CHECK(bt.erases == 1);
}

int main(void)
{
	test_status_bluetooth_says_what_the_board_has();
	test_bt_passkey_stores_it_and_never_shows_it();
	test_bt_passkey_refuses_what_is_not_a_passkey();
	test_bt_passkey_waits_for_a_quiet_board();
	test_bt_offline_new_draws_one_and_shows_it_once();
	test_bluetooth_passkey_changes_go_to_the_cloud();
	test_a_factory_reset_takes_the_passkey_with_the_rest();

	printf("%d offline Bluetooth console checks, %d failed\n", checks, failed_checks);
	return failed_checks == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
