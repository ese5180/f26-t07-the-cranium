/*
 * Cranium firmware on a board with Bluetooth and no Wi-Fi (CONFIG_APP_BT_ONLY): the nRF5340 DK. The
 * main loop, in place of main.c.
 *
 * The same shape as main.c, one event loop over the same queue, with what this board has: the console,
 * the buttons, the LEDs, the watchdog and the trial, the boot diary and the update over Bluetooth. There
 * is no network, no connection to AWS IoT, no heartbeat, no device shadow, no jobs and no events: the
 * board never reaches the cloud by itself. A phone that updates it tells the console what it saw.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/logging/log_ctrl.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/reboot.h>

#include "app_events.h"
#if defined(CONFIG_APP_BOOT_DIARY)
#include "boot_diary.h"
#endif
#include "bt_only.h"
#include "bt_ota.h"
#if defined(CONFIG_APP_BT_OFFLINE)
#include "bt_offline.h"
#endif
#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
#include "bt_passkey.h"
#endif
#include "console.h"
#include "device.h"
#include "factory.h"
#include "health.h"
#include "identity.h"
#include "mflt.h"
#include "ota.h"
#include "ui.h"
#include "version.h"

/* The faults that only make sense with Wi-Fi or with the golden image, which this board has neither of. */
#if defined(CONFIG_APP_TEST_FAULT_WIFI_DEAD) || defined(CONFIG_APP_TEST_FAULT_WRECK_SLOTS) || \
	defined(CONFIG_APP_TEST_FAULT_GOLDEN_FLIP)
#error "This test fault is not on a board with Bluetooth only"
#endif

LOG_MODULE_REGISTER(app, CONFIG_APP_LOG_LEVEL);

K_MSGQ_DEFINE(event_queue, sizeof(struct app_event), 32, 4);

/* A tick is in the queue. A main loop that is held up must not come back to a queue full of them. */
static atomic_t tick_queued;

int app_event_post(const struct app_event *event)
{
	return k_msgq_put(&event_queue, event, K_NO_WAIT);
}

int app_event_post_simple(enum app_event_type type)
{
	const struct app_event event = { .type = type };

	return app_event_post(&event);
}

/* No cloud to connect to: the console's MQTT command, which says "not on this board", asks this. */
int app_cloud_retry_in(void)
{
	return -1;
}

/*
 * As main.c's, for Button 1 on an image that came over Bluetooth: the phone has had its last status
 * already (src/bt/bt_ota.c). There is no console in the cloud to wait for, so the restart is at once, and
 * Memfault, which would keep the reason, is not on this board (src/mflt/mflt.h makes the mark nothing).
 */
void app_restart(int why)
{
	mflt_reboot_mark((enum mflt_reboot)why);
	LOG_PANIC();
	sys_reboot(SYS_REBOOT_COLD);
}

static void on_tick_timer(struct k_timer *timer)
{
	ARG_UNUSED(timer);

	if (atomic_cas(&tick_queued, 0, 1) && app_event_post_simple(APP_EVENT_TICK) != 0) {
		atomic_set(&tick_queued, 0);
	}
}

K_TIMER_DEFINE(tick_timer, on_tick_timer, NULL);

/* A phone cannot pair with the board without the serial console: provisioning gives it a passkey. */
static bool has_own_passkey(void)
{
#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
	return bt_passkey_state() == BT_PASSKEY_STATE_SET;
#else
	return false;
#endif
}

/* See bt_only.h for what each LED shows. */
static void update_ui(void)
{
	bt_only_leds_link(bt_ota_link_view());

	if (bt_ota_is_open()) {
		ui_set_state(bt_ota_ui_state());
	} else if (ota_state() == OTA_TESTING) {
		ui_set_state(UI_UPDATE_TESTING);
	} else if (device_is_factory()) {
		ui_set_state(UI_FACTORY);
	} else if (!has_own_passkey()) {
		ui_set_state(UI_UNPROVISIONED);
	} else {
		/* The pattern of "connected, nothing to do" on a board with a cloud: all is well. */
		ui_set_state(UI_ONLINE);
	}
}

static void on_tick(void)
{
	health_feed();
	bt_ota_on_tick();
#if defined(CONFIG_APP_BT_OFFLINE)
	bt_offline_on_tick();
#endif

	if (bt_ota_take_trouble()) {
		bt_only_leds_trouble();
	}

	bt_only_leds_tick();
	(void)ota_take_changed();
	update_ui();
}

static void on_button(const struct app_event *event)
{
	if (bt_ota_on_button(event->button.id, event->button.long_press, event->button.physical)) {
		return;
	}

	/* Holding Button 2 erases everything that was provisioned onto the device, the passkey too. */
	if (event->button.id == APP_BUTTON_2 && event->button.long_press) {
		if (ota_state() != OTA_IDLE) {
			LOG_WRN("Factory reset ignored while an update is in progress");
			return;
		}

		(void)factory_reset();
		LOG_PANIC();
		sys_reboot(SYS_REBOOT_COLD);
	}
}

static void decide_mode(void)
{
	switch (device_boot()) {
	case DEVICE_BOOT_MIGRATED:
		console_event("CONSOLE", "migrated: device id set to %s", device_id());
		break;
	case DEVICE_BOOT_MIGRATION_FAILED:
		LOG_ERR("The device id could not be stored; will try again at the next boot");
		break;
	case DEVICE_BOOT_UNREADABLE:
		LOG_ERR("Storage could not be read; running as provisioned, nothing was written");
		break;
	default:
		break;
	}
}

static void handle(const struct app_event *event)
{
	switch (event->type) {
	case APP_EVENT_BUTTON:
		on_button(event);
		break;
	case APP_EVENT_TICK:
		atomic_set(&tick_queued, 0);
		on_tick();
		return;
	case APP_EVENT_CALL:
		event->call.function();
		break;
	default:
		/* What the network, the cloud and the downloader post on another board: nothing does here. */
		break;
	}

	update_ui();
}

int main(void)
{
	struct app_event event;

	LOG_INF("Cranium firmware %s, %s, Bluetooth only", fw_version_running_string(),
		CONFIG_APP_BOARD_TYPE);

#if defined(CONFIG_APP_BOOT_DIARY)
	boot_diary_begin();
#endif

	if (health_init() != 0) {
		LOG_WRN("Running without a watchdog");
	}

	(void)ui_init();
	(void)bt_only_leds_init();

	if (identity_init() != 0) {
		LOG_ERR("Device identity is not available");
	}

	LOG_INF("Thing name: %s", identity_thing_name());

	decide_mode();
#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
	bt_passkey_init();
#endif
	console_start();

	if (ota_init() != 0) {
		LOG_ERR("Update manager could not start");
	}

#if defined(CONFIG_APP_BOOT_DIARY)
	boot_diary_stage(BOOT_DIARY_OTA_READY);
#endif

	if (device_is_factory()) {
		LOG_WRN("Factory mode: send INIT|<id> on the console");
	} else if (!has_own_passkey()) {
		LOG_WRN("No passkey of its own: each pairing shows a new one on this console. Provision it "
			"with tools/provision_device.py --board %s", CONFIG_APP_BOARD_TYPE);
	}

	update_ui();
	k_timer_start(&tick_timer, K_SECONDS(1), K_SECONDS(1));

	if (IS_ENABLED(CONFIG_APP_TEST_FAULT_CRASH)) {
		LOG_ERR("Test image: crashing on purpose");
		LOG_PANIC();
		k_oops();
	}

	if (IS_ENABLED(CONFIG_APP_TEST_FAULT_HANG)) {
		LOG_ERR("Test image: hanging on purpose, the watchdog will fire");
		while (true) {
			k_msleep(MSEC_PER_SEC);
		}
	}

	while (true) {
		(void)k_msgq_get(&event_queue, &event, K_FOREVER);
		handle(&event);
	}

	return 0;
}
