/*
 * Host-side tests of src/bt/bt_ota.c on a board with Bluetooth only (CONFIG_APP_BT_ONLY): the nRF5340 DK.
 * No cloud, no Wi-Fi and a passkey of its own (src/bt/bt_passkey.h), with the status a phone reads
 * (bt_status.h) as on every board.
 *
 * This takes test_bt_ota.c whole, with its fakes of the Bluetooth host, MCUmgr and the bootloader, and
 * runs every one of its tests that is about a window, a link, an upload, an install or the status and
 * not about the cloud, now on this board. Then the tests of what is different here: the passkey, the
 * name, the status after a restart, which has nothing to wait for, the board type of an image, and the
 * trial, which only a person can end with a kept image.
 */

#define CONFIG_APP_BT_ONLY                      1
#define CONFIG_APP_BT_STATIC_PASSKEY            1
#define CONFIG_APP_BT_PASSKEY_FAILURE_BUDGET    3
#define CONFIG_BT_APP_PASSKEY                   1
#define CONFIG_APP_BOARD_TYPE                   "nrf5340dk"
#define CONFIG_APP_IMAGE_LAYOUT                 1
#define CONFIG_APP_OTA_SELF_TEST_TIMEOUT_SECONDS 300
#define TEST_BT_OTA_NO_MAIN                     1

#include "test_bt_ota.c"

/* ---- the board's own passkey ------------------------------------------------------------ */

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

/* A board with Bluetooth only, out of factory mode, with no cloud settings and no network: provisioned. */
static void fresh_bt_only_board(void)
{
	fresh_board();
	fake.has_settings = false;
	fake.has_network = false;
	fake.wifi_answered = false;
	memset(&own, 0, sizeof(own));
	own.state = BT_PASSKEY_STATE_SET;
	own.passkey = 284913;
	own.tag = 0x3f9c;
}

/* What the phone does when it pairs with the passkey the console gave it. */
static uint32_t phone_pairs_with_the_boards_own(void)
{
	uint32_t passkey;

	phone_connects();
	CHECK(fake.auth->pairing_accept(&phone, NULL) == BT_SECURITY_ERR_SUCCESS);
	CHECK(fake.auth->app_passkey != NULL);
	passkey = fake.auth->app_passkey(&phone);
	fake.auth->passkey_display(&phone, passkey == BT_PASSKEY_RAND ? 123456 : passkey);
	return passkey;
}

/* ---- tests ----------------------------------------------------------------------------- */

static void test_no_cloud_is_needed_to_open_a_window(void)
{
	fresh_bt_only_board();
	hold_button_1();
	CHECK(window.phase == BT_OTA_OPEN);
	CHECK(strstr(fake.console, "[BT] open for 120 s") != NULL);

	/* Factory mode is still not provisioned. */
	fresh_bt_only_board();
	fake.factory = true;
	CHECK(bt_ota_on_button(APP_BUTTON_1, true, true));
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(strstr(fake.console, "factory mode") != NULL);
}

static void test_the_boards_own_passkey_is_used_and_never_shown(void)
{
	fresh_bt_only_board();
	open_by_hand();
	CHECK(own.opens == 1);
	bt_ota_on_tick();
	CHECK(strstr(fake.console, "[BT] advertising as Cranium-3F9C") != NULL);

	CHECK(phone_pairs_with_the_boards_own() == 284913);
	run_what_was_posted();
	bt_ota_on_tick();
	CHECK(strstr(fake.console, "pairing with the board's own passkey, which the console has") != NULL);
	CHECK(strstr(fake.console, "284913") == NULL);
	CHECK(atomic_get(&passkey_to_say) == 0);

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
	fresh_bt_only_board();
	own.state = BT_PASSKEY_STATE_NONE;
	open_by_hand();
	bt_ota_on_tick();
	/* No name of its own either: the console knows no passkey for it. */
	CHECK(strstr(fake.console, "advertising as Cranium-ABAB") != NULL);
	CHECK(phone_pairs_with_the_boards_own() == BT_PASSKEY_RAND);
	run_what_was_posted();
	CHECK(strstr(fake.console, "[BT] passkey 123456") != NULL);
	CHECK(strstr(fake.console, "board's own") == NULL);

	/* Locked works the same way. */
	fresh_bt_only_board();
	own.state = BT_PASSKEY_STATE_LOCKED;
	open_by_hand();
	CHECK(phone_pairs_with_the_boards_own() == BT_PASSKEY_RAND);
}

static void test_only_a_wrong_guess_at_the_boards_own_counts(void)
{
	fresh_bt_only_board();
	open_by_hand();

	CHECK(phone_pairs_with_the_boards_own() == 284913);
	fake.auth_info->pairing_failed(&phone, BT_SECURITY_ERR_AUTH_FAIL);
	CHECK(own.counted == 1);

	/* Failing for another reason gives no bit of the passkey away. */
	CHECK(phone_pairs_with_the_boards_own() == 284913);
	fake.auth_info->pairing_failed(&phone, BT_SECURITY_ERR_PAIR_NOT_ALLOWED);
	CHECK(own.counted == 1);

	/* The third failure of the window: from then on the host draws them, and those do not count. */
	CHECK(phone_pairs_with_the_boards_own() == 284913);
	fake.auth_info->pairing_failed(&phone, BT_SECURITY_ERR_AUTH_FAIL);
	CHECK(own.counted == 2);
	CHECK(phone_pairs_with_the_boards_own() == BT_PASSKEY_RAND);
	fake.auth_info->pairing_failed(&phone, BT_SECURITY_ERR_AUTH_FAIL);
	CHECK(own.counted == 2);

	bt_ota_on_tick();
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(strstr(fake.console, "too many failed pairings") != NULL);
}

static void test_the_count_is_written_every_tick_and_a_lock_is_trouble(void)
{
	fresh_bt_only_board();
	bt_ota_on_tick();
	CHECK(own.persists == 1);
	CHECK(!bt_ota_take_trouble());

	own.lock_on_persist = true;
	bt_ota_on_tick();
	CHECK(own.persists == 2);
	CHECK(bt_ota_take_trouble());
}

/* An update over Bluetooth that has restarted into the new image, on trial: what the record says. */
static void bt_only_trial(void)
{
	fake.stored = true;
	fake.stored_record = (struct bt_ota_record){
		.magic = BT_OTA_RECORD_MAGIC,
		.phase = BT_OTA_RECORD_ARMED,
		.result = BT_OTA_RESULT_PENDING,
		.count = 1,
		.from = { 0, 0, 0, 0 },
		.target = *fw_version_running(),
	};
	fake.ota = OTA_TESTING;
	bt_ota_on_boot(true, true, false);
	CHECK(bluetooth_trial);
}

/*
 * The trial with no Wi-Fi and no cloud: the person holds Button 1 once the image has run 60 s, pairs,
 * and the phone reads the image list. That is all: no Wi-Fi stack has to have answered, as it has on a
 * board with Wi-Fi, and there is no cloud to wait for. Then it is kept: ota_bt_confirm(), which
 * bt_only_ota.c turns into a confirmed image (test_bt_only_ota.c).
 */
static void test_a_person_keeps_it_with_no_wifi_at_all(void)
{
	fresh_bt_only_board();
	fake.uptime_ms = 30000;
	bt_only_trial();
	CHECK(strstr(fake.console, "to keep it, once it has run 60 s, hold Button 1, pair, and read the "
				   "image list: otherwise it reverts at 300 s") != NULL);
	CHECK(fake.store_writes == 1 && fake.stored_record.phase == BT_OTA_RECORD_TESTING);

	hold_button_1();
	CHECK(window.phase == BT_OTA_OPEN && window.proof_only);
	on_bt_ready(0);
	(void)phone_pairs_with_the_boards_own();
	connection_callbacks.security_changed(&phone, BT_SECURITY_L4, BT_SECURITY_ERR_SUCCESS);
	bt_ota_on_tick();
	CHECK(read_list() == 0);

	/* Too soon. */
	bt_ota_on_tick();
	CHECK(strstr(fake.console, "trial: this image has not run for long enough yet") != NULL);
	CHECK(fake.confirms == 0);

	/* After 60 s, with the Wi-Fi stack never having said anything, because there is none. */
	fake.uptime_ms = 61000;
	bt_ota_on_tick();
	CHECK(fake.confirms == 1);
	CHECK(fake.stored_record.result == BT_OTA_RESULT_SUCCEEDED);
	CHECK(fake.stored_record.proof == BT_OTA_PROOF_BY_PERSON);
	CHECK(strstr(fake.console, "succeeded, proof person") != NULL);
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(strstr(fake.console, "Wi-Fi") == NULL);
	CHECK(fake.shadow_reports == 0);
}

/*
 * After the restart into an image that came over Bluetooth, the board advertises its status for 2
 * minutes, as an nRF7002 DK does. One with Bluetooth only has no Wi-Fi or TLS to leave the heap to
 * first, and no cloud that would come, so it starts at the first tick instead of after 30 s. It goes
 * by the board's own name, the one the phone knows it by, and a phone that reads it never pairs.
 */
static void test_after_the_restart_its_status_is_advertised_at_once(void)
{
	uint8_t got[BT_STATUS_LEN];

	fresh_bt_only_board();
	fake.uptime_ms = 1000;
	bt_only_trial();
	CHECK(status_due);
	bt_ota_on_tick();
	CHECK(fake.enables == 1);
	CHECK(atomic_get(&gate) == GATE_STATUS);
	CHECK(strstr(fake.console, "status advertised for 120 s") != NULL);

	on_bt_ready(0);
	bt_ota_on_tick();
	CHECK(fake.advertising);
	CHECK(memcmp(fake.adv_uuid, status_uuid, 16) == 0);
	CHECK(strstr(fake.console, "advertising as Cranium-3F9C") != NULL);

	phone_connects();
	run_what_was_posted();
	bt_ota_on_tick();
	CHECK(atomic_get(&status_link) == 1);
	CHECK(bt_ota_link_view() == BT_OTA_LINK_CONNECTED);
	read_as_a_phone(got);
	CHECK(got[1] == BT_STATUS_WINDOW_STATUS);
	CHECK((got[28] & 1) == 1);
	CHECK(got[29] == BT_STATUS_VIA_BLUETOOTH);
	CHECK(got[30] == BT_STATUS_OUTCOME_PENDING);

	/* No pairing, so the board's own passkey is never read for it. */
	CHECK(fake.auth->pairing_accept(&phone, NULL) == BT_SECURITY_ERR_PAIR_NOT_ALLOWED);
	CHECK(own.opens == 0 && !own.loaded);
	CHECK(fake.shadow_reports == 0);

	/* The phone goes, and so does LED3's link. */
	fake.connected = false;
	connection_callbacks.disconnected(&phone, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
	bt_ota_on_tick();
	CHECK(bt_ota_link_view() == BT_OTA_LINK_NONE);
}

/* With nobody there, nothing confirms it: the trial's deadline restarts the board and it reverts. */
static void test_with_nobody_there_it_is_not_kept(void)
{
	fresh_bt_only_board();
	fake.uptime_ms = 30000;
	bt_only_trial();
	for (int second = 30; second < 300; second++) {
		fake.uptime_ms = second * 1000;
		bt_ota_on_tick();
	}
	CHECK(fake.confirms == 0);
	CHECK(fake.stored_record.result == BT_OTA_RESULT_PENDING);
	CHECK(fake.stored_record.phase == BT_OTA_RECORD_TESTING);

	/* And a window that a person opens and does not finish keeps nothing either. */
	hold_button_1();
	on_bt_ready(0);
	(void)phone_pairs_with_the_boards_own();
	connection_callbacks.security_changed(&phone, BT_SECURITY_L4, BT_SECURITY_ERR_SUCCESS);
	for (int i = 0; i < 10; i++) {
		bt_ota_on_tick();
	}
	CHECK(fake.confirms == 0);

	/* After the restart the bootloader has gone back: what the record says then. */
	fresh_bt_only_board();
	fake.stored = true;
	fake.stored_record.magic = BT_OTA_RECORD_MAGIC;
	fake.stored_record.phase = BT_OTA_RECORD_TESTING;
	fake.stored_record.target = (struct fw_version){ 9, 9, 9, 9 };
	bt_ota_on_boot(false, true, false);
	CHECK(fake.stored_record.result == BT_OTA_RESULT_ROLLED_BACK);
	CHECK(bt_ota_take_trouble());
}

static void test_a_proof_needs_the_passkey_to_be_readable(void)
{
	fresh_bt_only_board();
	fake.uptime_ms = 61000;
	bt_only_trial();
	own.state = BT_PASSKEY_STATE_UNREADABLE;
	hold_button_1();
	on_bt_ready(0);
	(void)phone_pairs_with_the_boards_own();
	connection_callbacks.security_changed(&phone, BT_SECURITY_L4, BT_SECURITY_ERR_SUCCESS);
	bt_ota_on_tick();
	CHECK(read_list() == 0);
	bt_ota_on_tick();
	CHECK(strstr(fake.console, "trial: this board is not provisioned") != NULL);
	CHECK(fake.confirms == 0);
}

static void test_a_trial_nothing_explains_reverts(void)
{
	fresh_bt_only_board();
	fake.ota = OTA_TESTING;
	bt_ota_on_boot(true, true, false);
	CHECK(!bluetooth_trial);
	CHECK(bt_ota_on_button(APP_BUTTON_1, true, true));
	CHECK(window.phase == BT_OTA_CLOSED);
	CHECK(strstr(fake.console, "not opening: nothing says how this image got here") != NULL);
}

/*
 * What image_compat.c finds in the slot before an offer: an nRF7002 DK's image, as every release up
 * to 1.12.0 is, or this board's type with a layout it does not have, is never offered or marked.
 */
static void test_only_an_image_for_this_board_is_offered(void)
{
	fresh_bt_only_board();
	image_on_offer();
	CHECK(window.phase == BT_OTA_READY);
	CHECK(strstr(fake.console, "has arrived") != NULL);

	for (int i = 0; i < 2; i++) {
		fresh_bt_only_board();
		fake.compat = i == 0 ? IMAGE_COMPAT_OTHER_BOARD : IMAGE_COMPAT_OTHER_LAYOUT;
		strcpy(fake.compat_found.board, i == 0 ? "nrf7002dk" : "nrf5340dk");
		fake.compat_found.layout = i == 0 ? 1 : 2;
		open_by_hand();
		phone_pairs();
		bt_ota_on_tick();
		CHECK(first_piece(RUNNING_MAJOR, RUNNING_MINOR + 1, 700000, 0) == 0);
		upload_finishes();
		bt_ota_on_tick();
		CHECK(window.phase == BT_OTA_CLOSED);
		CHECK(fake.requests == 0 && fake.erases == 1);
		CHECK(strstr(fake.console, i == 0 ? "refused the image: it is for nrf7002dk, and this "
						    "board is nrf5340dk"
						  : "refused the image: it is for flash layout 2, and "
						    "this board has 1") != NULL);
		CHECK(fake.stored_record.result == (i == 0 ? BT_OTA_RESULT_INCOMPATIBLE_BOARD
							     : BT_OTA_RESULT_INCOMPATIBLE_LAYOUT));
		/* LED4. */
		CHECK(bt_ota_take_trouble());
	}
}

/* The upload hook: an image for another board or layout stops as its protected area goes past. */
static void test_an_upload_for_another_board_stops_at_its_tlvs(void)
{
	static uint8_t data[2048];
	size_t length;
	int rc;

	/* An nRF7002 DK's release of 1.13.0 or later, which says what it is for. */
	fresh_bt_only_board();
	open_by_hand();
	phone_pairs();
	length = whole_image(data, "nrf7002dk", "1");
	CHECK(upload_in_pieces(data, length, 64, &rc) < length);
	CHECK(rc == MGMT_ERR_EBADSTATE);
	CHECK(strstr(fake.console, "refused an upload: it is for nrf7002dk, and this board is nrf5340dk") !=
	      NULL);
	CHECK(bt_ota_take_trouble());

	/* One from before 1.13.0, with no protected area: an nRF7002 DK's, at the first piece. */
	fresh_bt_only_board();
	open_by_hand();
	phone_pairs();
	length = whole_image(data, NULL, NULL);
	data[10] = 0;
	data[11] = 0;
	CHECK(upload_in_pieces(data, length, 64, &rc) == 0);
	CHECK(rc == MGMT_ERR_EBADSTATE);

	/* This board's type, of a layout it does not have. */
	fresh_bt_only_board();
	open_by_hand();
	phone_pairs();
	length = whole_image(data, "nrf5340dk", "2");
	CHECK(upload_in_pieces(data, length, 64, &rc) < length);
	CHECK(strstr(fake.console, "refused an upload: it is for flash layout 2, and this board has 1") !=
	      NULL);

	/* Its own goes all the way. */
	fresh_bt_only_board();
	open_by_hand();
	phone_pairs();
	length = whole_image(data, "nrf5340dk", "1");
	CHECK(upload_in_pieces(data, length, 64, &rc) == length);
	CHECK(rc == 0);
	CHECK(strstr(fake.console, "refused") == NULL);
}

static void test_an_install_touches_no_cloud(void)
{
	fresh_bt_only_board();
	image_on_offer();
	CHECK(bt_ota_on_button(APP_BUTTON_1, false, true));
	CHECK(fake.requests == 1 && fake.reboots == 1);
	/* app_restart(), which bt_only_main.c has: nothing to flush to a console in the cloud. */
	CHECK(strstr(fake.ops, "restart") != NULL);
	CHECK(strstr(fake.ops, "cloud_disconnect") == NULL);
	CHECK(fake.shadow_reports == 0);
}

int main(void)
{
	/* test_bt_ota.c's, on this board. */
	test_every_event_reaches_a_hook_that_asked_for_it();
	test_only_a_real_press_opens_a_window();
	test_a_tick_on_a_closed_board_does_nothing_on_the_air();
	test_a_console_press_cannot_install_or_erase();
	test_a_failed_start_of_the_controller_closes_the_window();
	test_the_failed_start_of_a_closed_window_still_counts();
	test_a_phone_from_the_last_window_gets_no_way_into_the_next();
	test_button_1_on_a_cloud_update_on_offer_stays_what_it_was();
	test_a_network_core_without_a_controller_is_said_once_and_harmless();
	test_it_advertises_for_the_window_and_then_stops();
	test_it_waits_for_the_controller_before_advertising();
	test_a_late_connection_is_turned_away();
	test_pairing_is_only_accepted_while_open();
	test_a_passkey_comes_out_on_the_main_loop();
	test_the_console_says_what_the_link_negotiated();
	test_a_refused_security_level_and_a_lost_link_are_explained();
	test_an_offline_board_keeps_the_passkey_on_its_console();
	test_a_full_queue_only_makes_it_wait_for_the_tick();
	test_the_bluetooth_threads_do_not_print();
	test_three_failed_pairings_close_it();
	test_a_new_window_starts_with_a_clean_count();
	test_button_2_closes_it_and_a_link_goes_with_it();
	test_only_a_full_strength_link_counts();
	test_a_link_that_cannot_ask_for_security_is_dropped();
	test_a_new_connection_starts_with_nothing();
	test_security_that_gets_lost_is_gone();
	test_a_link_goes_when_the_phone_does();
	test_every_command_needs_the_link();
	test_a_phone_can_ask_for_no_swap_no_confirm_and_no_erase();
	test_a_refusal_is_an_answer_and_only_a_good_answer_counts_as_a_read();
	test_a_closed_window_shuts_the_gate_on_a_link_still_up();
	test_what_may_not_be_uploaded_is_refused_at_the_first_piece();
	test_a_later_piece_is_not_taken_for_a_header();
	test_a_piece_that_got_past_the_gate_stops_at_the_upload_hook();
	test_when_it_has_arrived_nothing_more_goes_in();
	test_what_arrived_is_looked_at_again_before_it_is_offered();
	test_the_link_is_seen_as_connected_and_then_receiving();
	test_trouble_is_said_once();
	test_a_swap_request_of_its_own_stops_the_install();
	test_nothing_is_installed_without_a_record();
	test_a_refused_swap_is_said_and_recorded();
	test_button_2_erases_the_image();
	test_what_the_policy_says_to_erase_is_erased();
	test_an_offer_nobody_takes_is_erased();
	test_a_whole_image_does_not_stay_behind_a_closed_window();
	test_an_image_that_arrives_late_gets_the_whole_offer();
	test_what_became_of_it_is_worked_out_and_recorded();
	test_no_record_or_a_bad_one_is_nothing();
	test_nothing_is_confirmed_on_boot_or_by_itself();
	test_a_proof_window_is_not_a_way_in();
	test_closing_a_proof_window_never_erases_the_way_back();
	test_not_too_soon();
	test_a_list_read_on_an_old_link_does_not_count();
	test_a_confirmation_that_fails_stays_on_trial();
	test_what_led1_shows();
	test_the_status_service_is_readable_without_pairing_and_writes_nothing();
	test_the_status_follows_the_window();
	test_button_2_is_told_to_the_phone_before_its_link_goes();
	test_an_offer_nobody_takes_is_told_as_timed_out();
	test_button_1_is_told_to_the_phone_and_then_the_board_restarts();
	test_a_refused_image_says_why();
	test_a_notification_waits_for_a_link_that_can_take_it();
	test_a_status_link_stays_for_the_trial_and_no_longer_than_the_limit();
	test_the_boot_that_went_back_advertises_its_status_too();
	test_a_normal_boot_does_not_advertise();
	test_a_closed_board_reads_no_trailer_for_the_status();
	test_a_window_opened_first_takes_the_place_of_the_status();
	test_a_status_phone_gives_way_to_a_window_and_cannot_pair_in_it();

	/* What a board with Bluetooth only does differently. */
	test_no_cloud_is_needed_to_open_a_window();
	test_the_boards_own_passkey_is_used_and_never_shown();
	test_without_one_the_host_draws_a_new_one_each_time();
	test_only_a_wrong_guess_at_the_boards_own_counts();
	test_the_count_is_written_every_tick_and_a_lock_is_trouble();
	test_after_the_restart_its_status_is_advertised_at_once();
	test_a_person_keeps_it_with_no_wifi_at_all();
	test_with_nobody_there_it_is_not_kept();
	test_a_proof_needs_the_passkey_to_be_readable();
	test_a_trial_nothing_explains_reverts();
	test_only_an_image_for_this_board_is_offered();
	test_an_upload_for_another_board_stops_at_its_tlvs();
	test_an_install_touches_no_cloud();

	printf("%d Bluetooth-only update checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
