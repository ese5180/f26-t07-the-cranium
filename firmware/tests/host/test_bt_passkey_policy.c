/*
 * Host-side tests of src/policy/bt_passkey_policy.c: what a board's own passkey may be, its name, and when
 * it is used for a pairing and when the Bluetooth host draws a new one instead.
 */

#include <stdio.h>
#include <string.h>

#include "bt_passkey_policy.h"

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

/* What tools/provision_device.py leaves out as well: tested against the same list there. */
static bool weak_by_hand(uint32_t passkey)
{
	char text[8];

	snprintf(text, sizeof(text), "%06u", (unsigned int)passkey);
	for (char c = '0'; c <= '9'; c++) {
		char same[7];

		memset(same, c, 6);
		same[6] = '\0';
		if (strcmp(text, same) == 0) {
			return true;
		}
	}

	return strstr("0123456789", text) != NULL || strstr("9876543210", text) != NULL;
}

static void test_six_digits_and_nothing_else(void)
{
	uint32_t passkey = 7;

	CHECK(bt_passkey_parse("284913", &passkey) && passkey == 284913);
	CHECK(bt_passkey_parse("000001", &passkey) && passkey == 1);
	CHECK(bt_passkey_parse("999998", &passkey) && passkey == 999998);

	passkey = 7;
	CHECK(!bt_passkey_parse("28491", &passkey));
	CHECK(!bt_passkey_parse("2849133", &passkey));
	CHECK(!bt_passkey_parse("28491a", &passkey));
	CHECK(!bt_passkey_parse(" 84913", &passkey));
	CHECK(!bt_passkey_parse("-84913", &passkey));
	CHECK(!bt_passkey_parse("", &passkey));
	CHECK(!bt_passkey_parse(NULL, &passkey));
	CHECK(passkey == 7);
}

static void test_a_pattern_a_person_would_pick_is_refused(void)
{
	uint32_t passkey;
	int weak = 0;

	CHECK(!bt_passkey_parse("000000", &passkey));
	CHECK(!bt_passkey_parse("111111", &passkey));
	CHECK(!bt_passkey_parse("123456", &passkey));
	CHECK(!bt_passkey_parse("012345", &passkey));
	CHECK(!bt_passkey_parse("456789", &passkey));
	CHECK(!bt_passkey_parse("987654", &passkey));
	CHECK(!bt_passkey_parse("543210", &passkey));
	CHECK(bt_passkey_parse("123457", &passkey));
	CHECK(bt_passkey_parse("135791", &passkey));

	/*
	 * Every passkey there is: the same answer as by hand, and only 20 of them, ten of one digit, five
	 * runs up and five down.
	 */
	for (uint32_t key = 0; key <= BT_PASSKEY_MAX; key++) {
		bool is_weak = bt_passkey_weak(key);

		if (is_weak != weak_by_hand(key)) {
			CHECK(is_weak == weak_by_hand(key));
			break;
		}
		weak += is_weak ? 1 : 0;
	}
	CHECK(weak == 20);
	CHECK(bt_passkey_weak(BT_PASSKEY_MAX + 1));
	CHECK(bt_passkey_weak(BT_PASSKEY_NONE));
}

static void test_the_name_is_four_hex_digits(void)
{
	uint16_t tag = 0;
	char name[16];

	CHECK(bt_passkey_parse_tag("3F9C", &tag) && tag == 0x3f9c);
	CHECK(bt_passkey_parse_tag("3f9c", &tag) && tag == 0x3f9c);
	CHECK(bt_passkey_parse_tag("0000", &tag) && tag == 0);
	CHECK(!bt_passkey_parse_tag("3F9", &tag));
	CHECK(!bt_passkey_parse_tag("3F9C0", &tag));
	CHECK(!bt_passkey_parse_tag("3G9C", &tag));
	CHECK(!bt_passkey_parse_tag(NULL, &tag));

	CHECK(bt_passkey_name(0x3f9c, "Cranium", name, sizeof(name)) == 12);
	CHECK(strcmp(name, "Cranium-3F9C") == 0);
	CHECK(bt_passkey_name(0x000a, "Cranium", name, sizeof(name)) == 12);
	CHECK(strcmp(name, "Cranium-000A") == 0);
	CHECK(bt_passkey_name(0x3f9c, "Cranium", name, 12) < 0);
}

static struct bt_passkey_record stored(uint32_t passkey)
{
	return (struct bt_passkey_record){ .magic = BT_PASSKEY_RECORD_MAGIC, .passkey = passkey,
					   .tag = 0x3f9c };
}

static void test_a_record_is_only_ours(void)
{
	struct bt_passkey_record record = stored(284913);

	CHECK(bt_passkey_record_valid(&record));
	record.magic++;
	CHECK(!bt_passkey_record_valid(&record));
	record = stored(123456);
	CHECK(!bt_passkey_record_valid(&record));
	record = stored(BT_PASSKEY_MAX + 1);
	CHECK(!bt_passkey_record_valid(&record));
}

static void test_the_stored_passkey_until_its_failures_run_out(void)
{
	struct bt_passkey_record record = stored(284913);

	CHECK(bt_passkey_choose(&record, 0, 3, 0, 3) == 284913);
	CHECK(bt_passkey_choose(&record, 2, 3, 2, 3) == 284913);

	/* The budget, counted across windows and restarts. */
	CHECK(bt_passkey_choose(&record, 3, 3, 0, 3) == BT_PASSKEY_NONE);
	CHECK(bt_passkey_choose(&record, 9, 3, 0, 3) == BT_PASSKEY_NONE);
	CHECK(bt_passkey_locked(3, 3));
	CHECK(!bt_passkey_locked(2, 3));

	/* A window that has had its three closes, and nothing in it guesses at the stored passkey. */
	CHECK(bt_passkey_choose(&record, 0, 6, 3, 3) == BT_PASSKEY_NONE);

	/* Nothing stored, or something that is not ours. */
	CHECK(bt_passkey_choose(NULL, 0, 3, 0, 3) == BT_PASSKEY_NONE);
	record.magic = 0;
	CHECK(bt_passkey_choose(&record, 0, 3, 0, 3) == BT_PASSKEY_NONE);
}

int main(void)
{
	test_six_digits_and_nothing_else();
	test_a_pattern_a_person_would_pick_is_refused();
	test_the_name_is_four_hex_digits();
	test_a_record_is_only_ours();
	test_the_stored_passkey_until_its_failures_run_out();

	printf("%d passkey policy checks, %d failed\n", checks, failures);
	return failures == 0 ? 0 : 1;
}
