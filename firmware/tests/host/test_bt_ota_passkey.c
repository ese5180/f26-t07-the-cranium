/*
 * Host-side tests of src/bt/bt_ota.c built as every nRF7002 DK ships it: offline mode
 * (CONFIG_APP_BT_OFFLINE) selects a passkey of the board's own (CONFIG_APP_BT_STATIC_PASSKEY,
 * src/bt/bt_passkey.h), so the host is handed that passkey when there is one.
 *
 * This takes test_bt_ota.c whole, with its fakes of the Bluetooth host, MCUmgr and the bootloader,
 * and runs every one of its tests in this build, with no passkey stored. Then the tests of the
 * passkey itself: handed to the host and never shown, here or in the shadow; the host's own when
 * there is none or it is locked; which failures count against it; the count written every tick; and
 * a proof that needs the passkey to be readable. A fake stands in for src/bt/bt_passkey.c, which
 * bt_passkey_tests tests on its own.
 */

#define CONFIG_APP_BT_STATIC_PASSKEY         1
#define CONFIG_APP_BT_PASSKEY_FAILURE_BUDGET 3
#define CONFIG_BT_APP_PASSKEY                1
#define TEST_BT_OTA_NO_MAIN                  1

#include "test_bt_ota.c"

/* ---- the board's own passkey, as src/bt/bt_passkey.c keeps it ------------------------------ */

static struct {
	enum bt_passkey_state state;
	uint32_t passkey;
	uint16_t tag;
	uint32_t failures;
	bool loaded;
	int opens;
	int closes;
	int counted;
	bool lock_on_persist;
	int persists;
} own;

enum bt_passkey_state bt_passkey_state(void)
{
	return own.state;
}

uint32_t bt_passkey_failures(void)
{
	return own.failures;
}

bool bt_passkey_tag(uint16_t *tag)
{
	if (own.state != BT_PASSKEY_STATE_SET) {
		return false;
	}
	*tag = own.tag;
	return true;
}

/* As bt_passkey.c: read for a window, before the gate lets anything in, and wiped after it has shut. */
void bt_passkey_window_open(void)
{
	CHECK(atomic_get(&gate) == 0);
	own.opens++;
	own.loaded = own.state == BT_PASSKEY_STATE_SET;
}

void bt_passkey_window_close(void)
{
	CHECK(atomic_get(&gate) == 0);
	own.closes++;
	own.loaded = false;
}

uint32_t bt_passkey_for_pairing(uint32_t window_failures)
{
	return own.loaded && window_failures < BT_OTA_MAX_FAILED_PAIRINGS ? own.passkey
									  : BT_PASSKEY_NONE;
}

void bt_passkey_count_failure(void)
{
	own.counted++;
}

bool bt_passkey_persist(void)
{
	own.persists++;
	if (own.lock_on_persist) {
		own.lock_on_persist = false;
		own.state = BT_PASSKEY_STATE_LOCKED;
		return true;
	}
	return false;
}

/* An nRF7002 DK, provisioned and online, that has a passkey of its own (BT_OFFLINE|NEW drew it). */
static void board_with_its_own_passkey(void)
{
	fresh_board();
	fake.cloud_up = true;
	memset(&own, 0, sizeof(own));
	own.state = BT_PASSKEY_STATE_SET;
	own.passkey = 284913;
	own.tag = 0x3f9c;
}

/* What the phone does when it pairs: the host asks the board for a passkey first, then shows one. */
static uint32_t phone_pairs_asking_for_the_boards_own(void)
{
	uint32_t passkey;

	phone_connects();
	CHECK(fake.auth->pairing_accept(&phone, NULL) == BT_SECURITY_ERR_SUCCESS);
	CHECK(fake.auth->app_passkey != NULL);
	passkey = fake.auth->app_passkey(&phone);
	fake.auth->passkey_display(&phone, passkey == BT_PASSKEY_RAND ? 123456 : passkey);
	return passkey;
}

/* ---- tests -------------------------------------------------------------------------------- */

static void test_the_boards_own_passkey_is_used_and_never_shown(void)
{
	board_with_its_own_passkey();
	open_by_hand();
	CHECK(own.opens == 1);
	bt_ota_on_tick();
	CHECK(strstr(fake.console, "[BT] advertising as Cranium-3F9C") != NULL);

	CHECK(phone_pairs_asking_for_the_boards_own() == 284913);
	run_what_was_posted();
	bt_ota_on_tick();
	CHECK(strstr(fake.console, "pairing with the board's own passkey: it is never shown here") != NULL);
	CHECK(strstr(fake.console, "284913") == NULL);
	CHECK(atomic_get(&passkey_to_say) == 0);
	/* Online, and still not in the shadow, where a passkey the host draws would go. */
	CHECK(!pairing_reported);
	CHECK(strstr(fake.last_shadow, "284913") == NULL);

	connection_callbacks.security_changed(&phone, BT_SECURITY_L4, BT_SECURITY_ERR_SUCCESS);
	bt_ota_on_tick();
	CHECK(window.phase == BT_OTA_LINKED);

	/* Closed: the passkey goes out of memory, after the gate. */
	CHECK(bt_ota_on_button(APP_BUTTON_2, false, true));
	CHECK(own.closes == 1 && !own.loaded);
	CHECK(strstr(fake.console, "284913") == NULL);
}

static void test_without_one_the_host_draws_a_new_one_each_time(void)
{
	board_with_its_own_passkey();
	own.state = BT_PASSKEY_STATE_NONE;
	open_by_hand();
	bt_ota_on_tick();
	/* No name of its own either. */
	CHECK(strstr(fake.console, "advertising as Cranium-ABAB") != NULL);
	CHECK(phone_pairs_asking_for_the_boards_own() == BT_PASSKEY_RAND);
	run_what_was_posted();
	CHECK(strstr(fake.console, "[BT] passkey 123456") != NULL);
	CHECK(strstr(fake.console, "board's own") == NULL);
	/* That one is for this attempt only, so an online board puts it in its shadow for the phone. */
	CHECK(pairing_reported);

	/* Locked works the same way. */
	board_with_its_own_passkey();
	own.state = BT_PASSKEY_STATE_LOCKED;
	open_by_hand();
	CHECK(phone_pairs_asking_for_the_boards_own() == BT_PASSKEY_RAND);
}

static void test_only_a_wrong_guess_at_the_boards_own_counts(void)
{
	board_with_its_own_passkey();
	open_by_hand();

	CHECK(phone_pairs_asking_for_the_boards_own() == 284913);
	fake.auth_info->pairing_failed(&phone, BT_SECURITY_ERR_AUTH_FAIL);
	CHECK(own.counted == 1);

	/* Failing for another reason gives no bit of the passkey away. */
	CHECK(phone_pairs_asking_for_the_boards_own() == 284913);
	fake.auth_info->pairing_failed(&phone, BT_SECURITY_ERR_PAIR_NOT_ALLOWED);
	CHECK(own.counted == 1);

	/* The third failure of the window: from then on the host draws them, and those do not count. */
	CHECK(phone_pairs_asking_for_the_boards_own() == 284913);
	fake.auth_info->pairing_failed(&phone, BT_SECURITY_ERR_AUTH_FAIL);
	CHECK(own.counted == 2);
	CHECK(phone_pairs_asking_for_the_boards_own() == BT_PASSKEY_RAND);
	fake.auth_info->pairing_failed(&phone, BT_SECURITY_ERR_AUTH_FAIL);
	CHECK(own.counted == 2);

	bt_ota_on_tick();
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(strstr(fake.console, "too many failed pairings") != NULL);
}

static void test_the_count_is_written_every_tick_and_a_lock_takes_the_passkey_away(void)
{
	board_with_its_own_passkey();
	bt_ota_on_tick();
	CHECK(own.persists == 1);
	bt_ota_on_tick();
	CHECK(own.persists == 2);

	/* The count that was written locked it: the next window gets passkeys from the host. */
	own.lock_on_persist = true;
	bt_ota_on_tick();
	CHECK(own.persists == 3 && own.state == BT_PASSKEY_STATE_LOCKED);
	open_by_hand();
	CHECK(phone_pairs_asking_for_the_boards_own() == BT_PASSKEY_RAND);
}

static void test_a_proof_needs_the_passkey_to_be_readable(void)
{
	board_with_its_own_passkey();
	on_bluetooth_trial();
	fake.wifi_answered = true;
	own.state = BT_PASSKEY_STATE_UNREADABLE;
	proof_up_to_the_list();
	CHECK(read_list() == 0);
	bt_ota_on_tick();
	CHECK(strstr(fake.console, "trial: this board is not provisioned") != NULL);
	CHECK(fake.confirms == 0);

	/* Readable again, the same proof keeps the image. */
	own.state = BT_PASSKEY_STATE_SET;
	bt_ota_on_tick();
	CHECK(fake.confirms == 1);
}

int main(void)
{
	/* test_bt_ota.c's, in this build, with no passkey stored. */
	run_bt_ota_tests();

	/* The board's own passkey. */
	test_the_boards_own_passkey_is_used_and_never_shown();
	test_without_one_the_host_draws_a_new_one_each_time();
	test_only_a_wrong_guess_at_the_boards_own_counts();
	test_the_count_is_written_every_tick_and_a_lock_takes_the_passkey_away();
	test_a_proof_needs_the_passkey_to_be_readable();

	printf("%d Bluetooth update checks with the board's own passkey, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
