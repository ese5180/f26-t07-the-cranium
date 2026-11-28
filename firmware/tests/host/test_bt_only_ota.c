/*
 * Host-side tests of src/bt_only/bt_only_ota.c, the update manager of a board with Bluetooth only, with the
 * real trial deadline of src/health.c: what the bootloader did at boot, and what becomes of an image
 * installed over Bluetooth with no Wi-Fi and no cloud. It is kept when a person proves it, which is
 * bt_ota.c's proof ending in ota_bt_confirm() (test_bt_only.c has that part), and it reverts without:
 * the deadline restarts the board with nothing confirmed, and the bootloader goes back.
 *
 * Both files are compiled here, to get at what they keep static, against a fake of the bootloader's
 * API, the flash and the watchdog.
 */

#define CONFIG_APP_OTA_SELF_TEST_TIMEOUT_SECONDS 300
#define CONFIG_APP_WATCHDOG_TIMEOUT_SECONDS      120

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bt_only_ota.c"
#include "health.c"

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

static struct {
	int swap_type;
	bool confirmed;
	int confirm_result;
	int confirms;
	bool trailer;
	int reboots;
	int feeds;
	long long uptime_ms;
	int boots;
	bool boot_on_trial;
	bool boot_has_trailer;
	bool boot_job_record;
} board;

const struct device host_uart;

bool device_is_ready(const struct device *dev)
{
	return dev == &host_uart;
}

int wdt_install_timeout(const struct device *dev, const struct wdt_timeout_cfg *cfg)
{
	(void)dev;
	CHECK(cfg->window.max == CONFIG_APP_WATCHDOG_TIMEOUT_SECONDS * 1000);
	return 0;
}

int wdt_setup(const struct device *dev, uint8_t options)
{
	(void)dev;
	(void)options;
	return 0;
}

int wdt_feed(const struct device *dev, int channel_id)
{
	(void)dev;
	(void)channel_id;
	board.feeds++;
	return 0;
}

long long k_uptime_get(void)
{
	return board.uptime_ms;
}

void host_log_panic(void)
{
}

void sys_reboot(int type)
{
	CHECK(type == SYS_REBOOT_COLD);
	board.reboots++;
}

int mcuboot_swap_type_multi(int image_index)
{
	CHECK(image_index == 0);
	return board.swap_type;
}

bool boot_is_img_confirmed(void)
{
	return board.confirmed;
}

int boot_write_img_confirmed(void)
{
	board.confirms++;
	if (board.confirm_result == 0) {
		board.confirmed = true;
	}
	return board.confirm_result;
}

int flash_area_open(uint8_t id, const struct flash_area **area)
{
	static const struct flash_area primary = { .fa_id = 1, .fa_size = 0xe4000 };

	(void)id;
	*area = &primary;
	return 0;
}

/* The primary slot's trailer: its magic, written by a swap, or erased flash. */
int flash_area_read(const struct flash_area *area, long offset, void *data, size_t length)
{
	CHECK((size_t)offset + length == area->fa_size);
	memset(data, board.trailer ? 0x77 : 0xff, length);
	return 0;
}

void flash_area_close(const struct flash_area *area)
{
	(void)area;
}

void bt_ota_on_boot(bool on_trial, bool has_trailer, bool job_record)
{
	board.boots++;
	board.boot_on_trial = on_trial;
	board.boot_has_trailer = has_trailer;
	board.boot_job_record = job_record;
}

/* A restart: this image's state starts over, and the watchdog with it. */
static void boot(int swap_type, bool confirmed, bool trailer)
{
	memset(&board, 0, sizeof(board));
	board.swap_type = swap_type;
	board.confirmed = confirmed;
	board.trailer = trailer;
	state = OTA_IDLE;
	last_result = "none";
	changed = false;
	trial_active = false;
	watchdog_channel = -1;
	CHECK(health_init() == 0);
	CHECK(ota_init() == 0);
}

/* The main loop's tick until then, as bt_only_main.c feeds the watchdog. */
static void run_until(int seconds)
{
	while (board.uptime_ms < (long long)seconds * 1000 && board.reboots == 0) {
		board.uptime_ms += 1000;
		health_feed();
	}
}

static void test_an_image_installed_over_bluetooth_is_on_trial(void)
{
	boot(BOOT_SWAP_TYPE_REVERT, false, true);
	CHECK(ota_state() == OTA_TESTING);
	CHECK(strcmp(ota_state_name(), "testing") == 0);
	CHECK(health_trial_active());
	CHECK(board.boots == 1 && board.boot_on_trial && board.boot_has_trailer);
	/* No cloud job can have a record on this board. */
	CHECK(!board.boot_job_record);
	CHECK(!ota_bt_has_job());
	/* Nor a cloud update for the status to tell of: the last update is the Bluetooth one. */
	{
		struct fw_version target = { 9, 9, 9, 9 };

		CHECK(ota_bt_cloud_update(&target) == BT_STATUS_OUTCOME_NONE);
		CHECK(target.major == 9);
	}
	CHECK(board.confirms == 0);
	CHECK(ota_take_changed());
	CHECK(!ota_take_changed());
}

static void test_a_person_proves_it_and_it_is_kept(void)
{
	boot(BOOT_SWAP_TYPE_REVERT, false, true);
	run_until(61);

	/* bt_ota.c's proof: Button 1, a pairing, the image list, after 60 s. */
	CHECK(ota_bt_confirm() == 0);
	CHECK(board.confirms == 1 && board.confirmed);
	CHECK(ota_state() == OTA_IDLE);
	CHECK(strcmp(ota_last_result(), "succeeded") == 0);
	CHECK(!health_trial_active());

	/* Past the deadline: nothing restarts it, and the bootloader keeps it. */
	run_until(400);
	CHECK(board.reboots == 0);

	/* A second proof is no proof. */
	CHECK(ota_bt_confirm() == -EPERM);
	CHECK(board.confirms == 1);
}

static void test_with_no_proof_it_reverts(void)
{
	boot(BOOT_SWAP_TYPE_REVERT, false, true);
	run_until(300);
	CHECK(board.reboots == 0);
	run_until(302);
	CHECK(board.reboots == 1);
	CHECK(board.confirms == 0);
	CHECK(!board.confirmed);

	/* The bootloader puts the old image back, and boots it confirmed: nothing more to do. */
	boot(BOOT_SWAP_TYPE_NONE, true, true);
	CHECK(ota_state() == OTA_IDLE);
	CHECK(!health_trial_active());
	CHECK(board.confirms == 0);
	CHECK(board.boots == 1 && !board.boot_on_trial);
}

static void test_a_confirmation_that_fails_stays_on_trial_and_reverts(void)
{
	boot(BOOT_SWAP_TYPE_REVERT, false, true);
	run_until(61);
	board.confirm_result = -EIO;
	CHECK(ota_bt_confirm() == -EIO);
	CHECK(ota_state() == OTA_TESTING);
	CHECK(health_trial_active());
	run_until(302);
	CHECK(board.reboots == 1);
}

static void test_what_came_with_no_trial(void)
{
	/* Through serial recovery or the debug port: no trailer, confirmed as it is, nothing written. */
	boot(BOOT_SWAP_TYPE_NONE, true, false);
	CHECK(ota_state() == OTA_IDLE);
	CHECK(board.confirms == 0);
	CHECK(board.boots == 1 && !board.boot_has_trailer);
	CHECK(ota_bt_confirm() == -EPERM);

	/* A trailer that says neither: confirmed at boot, as ota.c does. */
	boot(BOOT_SWAP_TYPE_NONE, false, true);
	CHECK(board.confirms == 1);
	CHECK(!health_trial_active());
}

static void test_a_window_takes_the_state_and_gives_it_back(void)
{
	boot(BOOT_SWAP_TYPE_NONE, true, true);
	ota_bt_enter();
	CHECK(ota_state() == OTA_BLUETOOTH);
	CHECK(strcmp(ota_state_name(), "bluetooth") == 0);
	ota_bt_leave();
	CHECK(ota_state() == OTA_IDLE);
	CHECK(strcmp(ota_state_name(), "idle") == 0);

	/* A proof window leaves the trial as it is. */
	boot(BOOT_SWAP_TYPE_REVERT, false, true);
	ota_bt_leave();
	CHECK(ota_state() == OTA_TESTING);
}

int main(void)
{
	test_an_image_installed_over_bluetooth_is_on_trial();
	test_a_person_proves_it_and_it_is_kept();
	test_with_no_proof_it_reverts();
	test_a_confirmation_that_fails_stays_on_trial_and_reverts();
	test_what_came_with_no_trial();
	test_a_window_takes_the_state_and_gives_it_back();

	printf("%d Bluetooth-only update manager checks, %d failed\n", checks, failed_checks);
	return failed_checks == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
