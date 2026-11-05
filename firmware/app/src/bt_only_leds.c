/*
 * LED3 and LED4 of a board with Bluetooth only: see bt_only.h. LED1 and LED2 stay with ui.c.
 */

#include "bt_only.h"

#include <errno.h>

#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>

LOG_MODULE_REGISTER(bt_only_leds, CONFIG_APP_LOG_LEVEL);

#define STEP_MS 125
#define STEPS   16

static const struct gpio_dt_spec link_led = GPIO_DT_SPEC_GET(DT_ALIAS(led2), gpios);
static const struct gpio_dt_spec trouble_led = GPIO_DT_SPEC_GET(DT_ALIAS(led3), gpios);

/* One bit per 125 ms step, as in ui.c: a two-second cycle. */
static const uint16_t link_patterns[] = {
	[BT_OTA_LINK_NONE] = 0x0000,
	[BT_OTA_LINK_CONNECTED] = 0xffff,
	[BT_OTA_LINK_RECEIVING] = 0x5555,
};

/* LED3's pattern in the low 16 bits, LED4's in the next 16. */
static atomic_t current;
static int trouble_left;
static enum bt_ota_link_view shown_view;

static void led_step(struct k_timer *timer)
{
	static uint8_t step;
	uint32_t both = (uint32_t)atomic_get(&current);

	ARG_UNUSED(timer);

	(void)gpio_pin_set_dt(&link_led, (both >> step) & 1U);
	(void)gpio_pin_set_dt(&trouble_led, (both >> (16 + step)) & 1U);
	step = (step + 1) % STEPS;
}

K_TIMER_DEFINE(bt_only_led_timer, led_step, NULL);

static void show(enum bt_ota_link_view view)
{
	uint32_t link = (size_t)view < ARRAY_SIZE(link_patterns) ? link_patterns[view] : 0U;
	uint32_t trouble = trouble_left > 0 ? 0xffffU : 0U;

	(void)atomic_set(&current, (atomic_val_t)((trouble << 16) | link));
}

int bt_only_leds_init(void)
{
	/* Nothing depends on these two, so a failure only leaves them dark. */
	if (!gpio_is_ready_dt(&link_led) || !gpio_is_ready_dt(&trouble_led) ||
	    gpio_pin_configure_dt(&link_led, GPIO_OUTPUT_INACTIVE) != 0 ||
	    gpio_pin_configure_dt(&trouble_led, GPIO_OUTPUT_INACTIVE) != 0) {
		LOG_WRN("LED3 and LED4 could not be set up");
		return -ENODEV;
	}

	k_timer_start(&bt_only_led_timer, K_MSEC(STEP_MS), K_MSEC(STEP_MS));
	return 0;
}

void bt_only_leds_link(enum bt_ota_link_view view)
{
	shown_view = view;
	show(view);
}

void bt_only_leds_trouble(void)
{
	trouble_left = BT_ONLY_TROUBLE_SECONDS;
	show(shown_view);
}

void bt_only_leds_tick(void)
{
	if (trouble_left > 0 && --trouble_left == 0) {
		show(shown_view);
	}
}
