/*
 * The hardware self-test, from 1.17.0: the SELFTEST console command (console_cmd.c) runs these checks one
 * at a time, on the console task, and reports each as pass, fail, skip or visual. Nothing here runs at boot
 * or by itself; only that command calls it. Not for a board with Bluetooth only (CMakeLists.txt).
 *
 *   leds     blinks LED1, then LED2, then both: only a person can see it, so the result is "visual".
 *   buttons  the state of Button 1 and Button 2 now; with the button step, waits for Button 1.
 *   wifi     one scan, and how many networks the chip saw. Their names are never read.
 *   flash    the external flash's JEDEC ID, then one scratch sector written, read back and erased.
 *   ram      the heap's free bytes, and one small allocation written and checked.
 */

#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <string.h>

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/flash.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/net/net_if.h>
#include <zephyr/net/net_mgmt.h>
#include <zephyr/net/wifi_mgmt.h>
#include <zephyr/storage/flash_map.h>

#include "console_port.h"
#include "ui.h"

#define LED_STEP_MS       300
#define SCAN_TIMEOUT_MS   15000
#define BUTTON_POLL_MS    20
#define BUTTON_MUTE_AFTER_MS 500
/* Time allowed for the finger to leave Button 1 after the press that was seen. */
#define BUTTON_RELEASE_MS 3000
#define HEAP_TEST_BYTES   256
#define FLASH_PATTERN_LEN 32

/*
 * The scratch sector of the external flash. The MX25R64 is 8 MiB. Its first 0xe4000 bytes are the
 * secondary image slot (slot1_partition) and 0x700000 to 0x7e4000 is the golden image (MCUboot's
 * overlay; this application does not declare it). Nothing else is stored there. The sector is
 * 0x400000, in the unused middle, 4 KiB long: the build stops if the slot ever grows into it.
 */
#define SCRATCH_OFFSET 0x400000
#define SCRATCH_SIZE   0x1000
#define GOLDEN_OFFSET  0x700000
#define EXTERNAL_FLASH DT_NODELABEL(mx25r64)

BUILD_ASSERT(SCRATCH_OFFSET >= DT_REG_ADDR(DT_NODELABEL(slot1_partition)) +
					       DT_REG_SIZE(DT_NODELABEL(slot1_partition)),
	     "the self-test's scratch sector must be outside the secondary image slot");
BUILD_ASSERT(SCRATCH_OFFSET + SCRATCH_SIZE <= GOLDEN_OFFSET,
	     "the self-test's scratch sector must be outside the golden image");

static const struct gpio_dt_spec buttons[] = {
	GPIO_DT_SPEC_GET(DT_ALIAS(sw0), gpios),
	GPIO_DT_SPEC_GET(DT_ALIAS(sw1), gpios),
};

static void __printf_like(3, 4)
set_detail(struct console_selftest_check *out, enum console_selftest_result result, const char *format, ...)
{
	va_list args;

	out->result = result;
	va_start(args, format);
	(void)vsnprintk(out->detail, sizeof(out->detail), format, args);
	va_end(args);
}

static void check_leds(struct console_selftest_check *out)
{
	ui_leds_hold(true);
	/* LED1 alone, LED2 alone, both. */
	for (unsigned int step = 0; step < 3; step++) {
		ui_leds_set(step != 1, step != 0);
		k_sleep(K_MSEC(LED_STEP_MS));
	}
	ui_leds_hold(false);

	set_detail(out, SELFTEST_VISUAL, "LED1, LED2, then both lit: look at the board");
}

static int read_buttons(int state[2])
{
	for (size_t i = 0; i < ARRAY_SIZE(buttons); i++) {
		if (!gpio_is_ready_dt(&buttons[i])) {
			return -ENODEV;
		}

		state[i] = gpio_pin_get_dt(&buttons[i]);
		if (state[i] < 0) {
			return state[i];
		}
	}

	return 0;
}

static void check_buttons(struct console_selftest_check *out, bool press_button)
{
	int state[2];
	int err = read_buttons(state);

	if (err != 0) {
		set_detail(out, SELFTEST_FAIL, "could not read a button (%d)", err);
		return;
	}

	if (!press_button) {
		set_detail(out, SELFTEST_PASS, "Button 1 %s, Button 2 %s", state[0] ? "down" : "up",
			   state[1] ? "down" : "up");
		return;
	}

	/* The press is for this check alone: not an acceptance of an update that waits. */
	ui_buttons_mute(CONSOLE_SELFTEST_BUTTON_MS + BUTTON_MUTE_AFTER_MS);
	for (int waited = 0; waited < CONSOLE_SELFTEST_BUTTON_MS; waited += BUTTON_POLL_MS) {
		if (read_buttons(state) == 0 && state[0] > 0) {
			/* Held for as long as it takes to let go, and a little after, for the bounce. */
			ui_buttons_mute(BUTTON_RELEASE_MS + BUTTON_MUTE_AFTER_MS);
			set_detail(out, SELFTEST_PASS, "Button 1 pressed after %d ms", waited);
			return;
		}

		k_sleep(K_MSEC(BUTTON_POLL_MS));
	}

	ui_buttons_mute(BUTTON_MUTE_AFTER_MS);
	set_detail(out, SELFTEST_FAIL, "Button 1 not pressed in %d s", CONSOLE_SELFTEST_BUTTON_MS / 1000);
}

/* ---- Wi-Fi scan ----------------------------------------------------------------- */

static struct net_mgmt_event_callback scan_callback;
static K_SEM_DEFINE(scan_done, 0, 1);
static atomic_t scan_seen;
static atomic_t scan_status;

/* Counts the results. It reads nothing from them: a network's name stays where it is. */
static void on_scan_event(struct net_mgmt_event_callback *callback, uint64_t event, struct net_if *iface)
{
	ARG_UNUSED(iface);

	if (event == NET_EVENT_WIFI_SCAN_RESULT) {
		atomic_inc(&scan_seen);
	} else if (event == NET_EVENT_WIFI_SCAN_DONE) {
		const struct wifi_status *status = callback->info;

		atomic_set(&scan_status, status != NULL ? status->status : 0);
		k_sem_give(&scan_done);
	}
}

static void check_wifi(struct console_selftest_check *out)
{
	struct net_if *iface = net_if_get_first_wifi();
	struct wifi_scan_params params = { 0 };
	int err;

	if (iface == NULL) {
		set_detail(out, SELFTEST_SKIP, "no Wi-Fi interface");
		return;
	}

	atomic_set(&scan_seen, 0);
	atomic_set(&scan_status, 0);
	k_sem_reset(&scan_done);
	net_mgmt_init_event_callback(&scan_callback, on_scan_event,
				     NET_EVENT_WIFI_SCAN_RESULT | NET_EVENT_WIFI_SCAN_DONE);
	net_mgmt_add_event_callback(&scan_callback);

	err = net_mgmt(NET_REQUEST_WIFI_SCAN, iface, &params, sizeof(params));
	if (err != 0) {
		net_mgmt_del_event_callback(&scan_callback);
		set_detail(out, SELFTEST_FAIL, "scan refused (%d)", err);
		return;
	}

	err = k_sem_take(&scan_done, K_MSEC(SCAN_TIMEOUT_MS));
	net_mgmt_del_event_callback(&scan_callback);

	if (err != 0) {
		set_detail(out, SELFTEST_FAIL, "scan did not finish in %d s", SCAN_TIMEOUT_MS / 1000);
	} else if (atomic_get(&scan_status) != 0) {
		set_detail(out, SELFTEST_FAIL, "scan failed (%d)", (int)atomic_get(&scan_status));
	} else if (atomic_get(&scan_seen) == 0) {
		set_detail(out, SELFTEST_FAIL, "scan finished, 0 networks seen");
	} else {
		set_detail(out, SELFTEST_PASS, "%d networks seen", (int)atomic_get(&scan_seen));
	}
}

/* ---- external flash ------------------------------------------------------------- */

static bool all_erased(const uint8_t *data, size_t length)
{
	for (size_t i = 0; i < length; i++) {
		if (data[i] != 0xff) {
			return false;
		}
	}

	return true;
}

static void check_flash(struct console_selftest_check *out)
{
	const struct device *flash = DEVICE_DT_GET(EXTERNAL_FLASH);
	uint8_t id[3];
	uint8_t pattern[FLASH_PATTERN_LEN];
	uint8_t back[FLASH_PATTERN_LEN];
	int err;

	if (!device_is_ready(flash)) {
		set_detail(out, SELFTEST_FAIL, "external flash not ready");
		return;
	}

	err = flash_read_jedec_id(flash, id);
	if (err != 0) {
		set_detail(out, SELFTEST_FAIL, "JEDEC ID unreadable (%d)", err);
		return;
	}

	for (size_t i = 0; i < sizeof(pattern); i++) {
		pattern[i] = (uint8_t)(0xa5 ^ (i * 7));
	}

	err = flash_erase(flash, SCRATCH_OFFSET, SCRATCH_SIZE);
	if (err == 0) {
		err = flash_write(flash, SCRATCH_OFFSET, pattern, sizeof(pattern));
	}
	if (err == 0) {
		err = flash_read(flash, SCRATCH_OFFSET, back, sizeof(back));
	}
	if (err != 0) {
		set_detail(out, SELFTEST_FAIL, "ID %02x%02x%02x, write/read error (%d)", id[0], id[1], id[2],
			   err);
		return;
	}

	if (memcmp(pattern, back, sizeof(back)) != 0) {
		/* Leave the sector erased whatever happened. */
		(void)flash_erase(flash, SCRATCH_OFFSET, SCRATCH_SIZE);
		set_detail(out, SELFTEST_FAIL, "ID %02x%02x%02x, read-back differs", id[0], id[1], id[2]);
		return;
	}

	err = flash_erase(flash, SCRATCH_OFFSET, SCRATCH_SIZE);
	if (err == 0) {
		err = flash_read(flash, SCRATCH_OFFSET, back, sizeof(back));
	}
	if (err != 0 || !all_erased(back, sizeof(back))) {
		set_detail(out, SELFTEST_FAIL, "ID %02x%02x%02x, erase failed (%d)", id[0], id[1], id[2], err);
		return;
	}

	set_detail(out, SELFTEST_PASS, "ID %02x%02x%02x, sector written, read, erased", id[0], id[1], id[2]);
}

/* ---- RAM ------------------------------------------------------------------------ */

static void check_ram(struct console_selftest_check *out)
{
	size_t free_before = console_port_free_heap();
	uint8_t *block = k_malloc(HEAP_TEST_BYTES);
	bool intact = true;

	if (block == NULL) {
		set_detail(out, SELFTEST_FAIL, "heap %u B free, %d B allocation failed",
			   (unsigned int)free_before, HEAP_TEST_BYTES);
		return;
	}

	memset(block, 0xa5, HEAP_TEST_BYTES);
	for (size_t i = 0; i < HEAP_TEST_BYTES; i++) {
		intact = intact && block[i] == 0xa5;
	}

	k_free(block);

	if (intact) {
		set_detail(out, SELFTEST_PASS, "heap %u B free, %d B allocated and checked",
			   (unsigned int)free_before, HEAP_TEST_BYTES);
	} else {
		set_detail(out, SELFTEST_FAIL, "heap %u B free, allocation read back wrong",
			   (unsigned int)free_before);
	}
}

bool console_port_selftest(unsigned int index, bool press_button, struct console_selftest_check *out)
{
	static const char *const names[] = { "leds", "buttons", "wifi", "flash", "ram" };

	if (index >= ARRAY_SIZE(names)) {
		return false;
	}

	out->name = names[index];
	switch (index) {
	case 0:
		check_leds(out);
		break;
	case 1:
		check_buttons(out, press_button);
		break;
	case 2:
		check_wifi(out);
		break;
	case 3:
		check_flash(out);
		break;
	default:
		check_ram(out);
		break;
	}

	return true;
}
