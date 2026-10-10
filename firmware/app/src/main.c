/*
 * Cranium firmware, application core (non-secure application on top of TF-M).
 */

#include <zephyr/kernel.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/dfu/mcuboot.h>
#include <zephyr/logging/log.h>
#include <app_version.h>

LOG_MODULE_REGISTER(app, CONFIG_APP_LOG_LEVEL);

static const struct gpio_dt_spec status_led = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);

int main(void)
{
	LOG_INF("Cranium firmware %s", APP_VERSION_STRING);
	LOG_INF("Image confirmed: %s, swap type: %d", boot_is_img_confirmed() ? "yes" : "no",
		mcuboot_swap_type_multi(0));

	if (gpio_is_ready_dt(&status_led)) {
		(void)gpio_pin_configure_dt(&status_led, GPIO_OUTPUT_INACTIVE);
	}

	while (true) {
		(void)gpio_pin_toggle_dt(&status_led);
		k_msleep(250);
	}

	return 0;
}
