/*
 * The update manager of a board with Bluetooth only (CONFIG_APP_BT_ONLY), in place of ota.c: what the
 * bootloader did at boot, the trial and its deadline, and the state that a window over Bluetooth takes.
 * There are no jobs, no downloads and no cloud. An image comes over Bluetooth, through bt_ota.c, or
 * over USB, through the debug port or serial recovery, which leaves no trailer and so no trial.
 *
 * The rule of the trial is the same as on a board with a cloud: an image is kept when it has been shown
 * that it can receive a further update, and reverts otherwise. Here the only way to show that is a person:
 * bt_ota.c's proof, with ota_bt_confirm(). health.c's deadline restarts the board without it.
 *
 * Only the functions of ota.h that something on this board calls are here: the link fails on any other.
 */

#include "ota.h"

#include <errno.h>
#include <string.h>

#include <zephyr/dfu/mcuboot.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/storage/flash_map.h>

#include "bt_ota.h"
#include "health.h"
#include "version.h"

LOG_MODULE_REGISTER(ota, CONFIG_APP_LOG_LEVEL);

/* BOOT_MAGIC_SZ in MCUboot, at the end of a slot, and what erased internal flash reads as. */
#define TRAILER_MAGIC_SIZE 16
#define TRAILER_ERASED     0xff

static enum ota_state state = OTA_IDLE;
static const char *last_result = "none";
static bool changed;

static void enter(enum ota_state now)
{
	state = now;
	changed = true;
}

/* The same as ota.c's: an image that got here with no swap has no trailer. A read that fails says nothing. */
static bool primary_has_trailer(void)
{
	const struct flash_area *area;
	uint8_t magic[TRAILER_MAGIC_SIZE];
	bool found = true;

	if (flash_area_open(PARTITION_ID(slot0_partition), &area) != 0) {
		return true;
	}

	if (flash_area_read(area, area->fa_size - sizeof(magic), magic, sizeof(magic)) == 0) {
		found = false;
		for (size_t i = 0; i < sizeof(magic); i++) {
			found = found || magic[i] != TRAILER_ERASED;
		}
	}

	flash_area_close(area);
	return found;
}

int ota_init(void)
{
	/* As in ota.c: the deadline starts first, so that an image that falls over here goes back too. */
	bool on_trial = mcuboot_swap_type_multi(0) == BOOT_SWAP_TYPE_REVERT;

	if (on_trial) {
		health_trial_begin();
		LOG_INF("Running new firmware %s on trial", fw_version_running_string());
		enter(OTA_TESTING);
	} else if (!boot_is_img_confirmed()) {
		/* A trailer that says neither confirmed nor on trial: see ota_init() in ota.c. */
		(void)boot_write_img_confirmed();
	}

	/* No cloud job can have a record here. */
	bt_ota_on_boot(on_trial, primary_has_trailer(), false);
	return 0;
}

enum ota_state ota_state(void)
{
	return state;
}

const char *ota_state_name(void)
{
	switch (state) {
	case OTA_TESTING:
		return "testing";
	case OTA_BLUETOOTH:
		return "bluetooth";
	default:
		return "idle";
	}
}

const char *ota_last_result(void)
{
	return last_result;
}

bool ota_take_changed(void)
{
	bool was = changed;

	changed = false;
	return was;
}

bool ota_bt_has_job(void)
{
	return false;
}

/* For the status a phone reads: no cloud update ever, so the last update is the Bluetooth one, if any. */
enum bt_status_outcome ota_bt_cloud_update(struct fw_version *target)
{
	ARG_UNUSED(target);
	return BT_STATUS_OUTCOME_NONE;
}

void ota_bt_enter(void)
{
	enter(OTA_BLUETOOTH);
}

void ota_bt_leave(void)
{
	if (state == OTA_BLUETOOTH) {
		enter(OTA_IDLE);
	}
}

int ota_bt_confirm(void)
{
	int err;

	if (state != OTA_TESTING || IS_ENABLED(CONFIG_APP_TEST_FAULT_NO_CONFIRM)) {
		return -EPERM;
	}

	err = boot_write_img_confirmed();
	if (err) {
		LOG_ERR("Image could not be confirmed: %d", err);
		return err;
	}

	health_trial_passed();
	LOG_INF("Firmware %s confirmed", fw_version_running_string());
	last_result = "succeeded";
	enter(OTA_IDLE);
	return 0;
}
