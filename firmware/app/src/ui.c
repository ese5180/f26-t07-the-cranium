#include "ui.h"

#include <zephyr/drivers/gpio.h>
#include <zephyr/input/input.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>

#include "app_events.h"

#if defined(CONFIG_SOC_NRF5340_CPUAPP)
#include <soc_secure.h>
#endif

LOG_MODULE_REGISTER(ui, CONFIG_APP_LOG_LEVEL);

#define STEP_MS       125
#define STEPS         16
#define LONG_PRESS_MS 5000

static const struct gpio_dt_spec status_led = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);
static const struct gpio_dt_spec second_led = GPIO_DT_SPEC_GET(DT_ALIAS(led1), gpios);

/* LED1: one bit per 125 ms step, least significant bit first: a two-second cycle. */
static const uint16_t patterns[] = {
	[UI_FACTORY] = 0x000f,
	[UI_UNPROVISIONED] = 0x0001,
	[UI_NETWORK_CONNECTING] = 0x00ff,
	[UI_CLOUD_CONNECTING] = 0x0f0f,
	[UI_ONLINE] = 0x3333,
	[UI_UPDATE_OFFERED] = 0x5555,
	[UI_UPDATE_IN_PROGRESS] = 0x0505,
	[UI_UPDATE_TESTING] = 0x0015,
#if defined(CONFIG_APP_BT_OTA)
	[UI_BT_WINDOW] = 0x0055,
#endif
};

/*
 * LED2, in the same steps. It lights only when the board is online, as the opposite of LED1,
 * so that the two take turns. In every other state it stays dark.
 */
static const uint16_t second_patterns[] = {
	[UI_ONLINE] = 0xcccc,
};

/* LED1's pattern in the low 16 bits, LED2's in the next 16. */
static atomic_t current_pattern = ATOMIC_INIT(0x0001);
static int64_t pressed_at[2];
/*
 * Identify's steps still to come, and one more for its end: while there are any, identify_step()
 * has the LEDs and led_step() does not touch them.
 */
static atomic_t identify_steps;

static void led_step(struct k_timer *timer)
{
	static uint8_t step;
	uint32_t both = (uint32_t)atomic_get(&current_pattern);

	ARG_UNUSED(timer);

	/* The pattern goes on counting under identify, so that it takes up where it would be. */
	if (atomic_get(&identify_steps) <= 0) {
		(void)gpio_pin_set_dt(&status_led, (both >> step) & 1U);
		(void)gpio_pin_set_dt(&second_led, (both >> (16 + step)) & 1U);
	}
	step = (step + 1) % STEPS;
}

K_TIMER_DEFINE(led_timer, led_step, NULL);

/*
 * Both LEDs on at an odd count of steps left, off at an even one: on first, off last. The step
 * with one left is the end: it gives the LEDs back to led_step(), whose next step shows the state.
 */
static void identify_step(struct k_timer *timer)
{
	atomic_val_t left = atomic_dec(&identify_steps);

	if (left <= 1) {
		atomic_set(&identify_steps, 0);
		k_timer_stop(timer);
		return;
	}

	(void)gpio_pin_set_dt(&status_led, (left % 2) == 1);
	(void)gpio_pin_set_dt(&second_led, (left % 2) == 1);
}

K_TIMER_DEFINE(identify_timer, identify_step, NULL);

static void on_input(struct input_event *event, void *user_data)
{
	uint8_t button;

	ARG_UNUSED(user_data);

	if (event->type != INPUT_EV_KEY) {
		return;
	}

	if (event->code == INPUT_KEY_0) {
		button = APP_BUTTON_1;
	} else if (event->code == INPUT_KEY_1) {
		button = APP_BUTTON_2;
	} else {
		return;
	}

	if (event->value) {
		pressed_at[button] = k_uptime_get();
		return;
	}

	/*
	 * A release with no press seen: the button was already down when the input driver
	 * started, so its press was never reported. Holding it through a boot says nothing,
	 * and without this check the uptime alone would make it a long press, which is a
	 * factory reset.
	 */
	if (pressed_at[button] == 0) {
		return;
	}

	/* Act on release so that a long press can be told apart from a short one. */
	const struct app_event app_event = {
		.type = APP_EVENT_BUTTON,
		.button = {
			.id = button,
			.long_press = (k_uptime_get() - pressed_at[button]) >= LONG_PRESS_MS,
#if defined(CONFIG_APP_BT_OTA)
			.physical = true,
#endif
		},
	};

	pressed_at[button] = 0;

	(void)app_event_post(&app_event);
}

INPUT_CALLBACK_DEFINE(NULL, on_input, NULL);

int ui_init(void)
{
	int err;

	if (!gpio_is_ready_dt(&status_led)) {
		LOG_ERR("Status LED is not ready");
		return -ENODEV;
	}

	err = gpio_pin_configure_dt(&status_led, GPIO_OUTPUT_INACTIVE);
	if (err) {
		return err;
	}

#if defined(CONFIG_SOC_NRF5340_CPUAPP)
	/*
	 * Before 1.8.0 this core handed LED2 to the network core, whose image blinks it. Take it
	 * back explicitly, in case that choice survived the restart into this image.
	 */
	soc_secure_gpio_pin_mcu_select(NRF_DT_GPIOS_TO_PSEL(DT_ALIAS(led1), gpios),
				       NRF_GPIO_PIN_SEL_APP);
#endif

	/* Nothing depends on LED2, so a failure here only leaves it dark. */
	if (!gpio_is_ready_dt(&second_led) ||
	    gpio_pin_configure_dt(&second_led, GPIO_OUTPUT_INACTIVE) != 0) {
		LOG_WRN("LED2 could not be set up");
	}

	k_timer_start(&led_timer, K_MSEC(STEP_MS), K_MSEC(STEP_MS));
	return 0;
}

void ui_set_state(enum ui_state state)
{
	uint32_t second = 0U;

	if ((size_t)state >= ARRAY_SIZE(patterns)) {
		return;
	}

	if ((size_t)state < ARRAY_SIZE(second_patterns)) {
		second = second_patterns[state];
	}

	atomic_set(&current_pattern, (atomic_val_t)((second << 16) | patterns[state]));
}

void ui_identify(unsigned int seconds)
{
	const unsigned int steps_per_second = MSEC_PER_SEC / UI_IDENTIFY_STEP_MS;

	/* The command allows 60 s at most: this keeps the count far from overflowing, whatever comes. */
	if (seconds > 3600U) {
		seconds = 3600U;
	}

	atomic_set(&identify_steps, (atomic_val_t)(seconds == 0U ? 0 : seconds * steps_per_second + 1));
	if (seconds == 0U) {
		k_timer_stop(&identify_timer);
		return;
	}

	k_timer_start(&identify_timer, K_NO_WAIT, K_MSEC(UI_IDENTIFY_STEP_MS));
}
