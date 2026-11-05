/*
 * Host build: the watchdog API, as far as health.c uses it. Functions are only declared here: a test
 * that compiles health.c defines them.
 */
#ifndef HOST_STUB_WATCHDOG_H_
#define HOST_STUB_WATCHDOG_H_

#include <stdint.h>

#include <zephyr/device.h>

#ifndef DT_ALIAS
#define DT_ALIAS(alias) 0
#endif

#define WDT_FLAG_RESET_SOC          1
#define WDT_OPT_PAUSE_HALTED_BY_DBG 2

struct wdt_window {
	uint32_t min;
	uint32_t max;
};

struct wdt_timeout_cfg {
	struct wdt_window window;
	void (*callback)(const struct device *dev, int channel_id);
	uint8_t flags;
};

int wdt_install_timeout(const struct device *dev, const struct wdt_timeout_cfg *cfg);
int wdt_setup(const struct device *dev, uint8_t options);
int wdt_feed(const struct device *dev, int channel_id);

#endif
