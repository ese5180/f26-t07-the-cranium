/*
 * Host build: the little of the GPIO API that ui.c uses. The pin goes nowhere, but what was last set
 * on it is kept, by the alias's number, for a test that looks: LED1 is led0, LED2 is led1.
 */
#ifndef HOST_STUB_GPIO_H_
#define HOST_STUB_GPIO_H_

#include <stdbool.h>

struct gpio_dt_spec {
	int pin;
};

#define DT_ALIAS(alias)                 HOST_DT_ALIAS_##alias
#define HOST_DT_ALIAS_led0              0
#define HOST_DT_ALIAS_led1              1
#define HOST_GPIO_PINS                  2
#define GPIO_DT_SPEC_GET(node, prop)    { node }
#define GPIO_OUTPUT_INACTIVE            0

static inline bool gpio_is_ready_dt(const struct gpio_dt_spec *spec)
{
	(void)spec;
	return true;
}

static inline int gpio_pin_configure_dt(const struct gpio_dt_spec *spec, int flags)
{
	(void)spec;
	(void)flags;
	return 0;
}

/* What was last set on each pin, and how often it was set, in this file of a test. */
static int host_gpio_value[HOST_GPIO_PINS];
static int host_gpio_sets[HOST_GPIO_PINS];

static inline int gpio_pin_set_dt(const struct gpio_dt_spec *spec, int value)
{
	if (spec->pin >= 0 && spec->pin < HOST_GPIO_PINS) {
		host_gpio_value[spec->pin] = value;
		host_gpio_sets[spec->pin]++;
	}
	return 0;
}

#endif
