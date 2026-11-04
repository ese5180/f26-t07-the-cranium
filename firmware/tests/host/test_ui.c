/*
 * Host-side tests of ui.c: what a button does, and above all what it must not do. A release
 * with no press seen has to be ignored, because a button held through a boot would otherwise
 * count as a long press, and a long press of Button 2 is a factory reset. Then the LEDs: what
 * each state shows, and the console's identify command, from 1.13.0, on its own timer.
 *
 * The real file is compiled here, to get at its input callback and its timers, which are static.
 */

#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "ui.c"

static int failures;
static int checks;

#define CHECK(condition)                                                                     \
	do {                                                                                 \
		checks++;                                                                    \
		if (!(condition)) {                                                          \
			failures++;                                                          \
			printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);         \
		}                                                                            \
	} while (0)

static int64_t uptime_ms;
static struct app_event posted[8];
static int posted_count;

long long k_uptime_get(void)
{
	return uptime_ms;
}

int app_event_post(const struct app_event *event)
{
	if (posted_count < (int)ARRAY_SIZE(posted)) {
		posted[posted_count] = *event;
	}
	posted_count++;
	return 0;
}

/* The two timers, as the kernel would run them, on a clock of their own. */
static struct {
	long long now_ms;
	long long last_led_ms;
	/* How often LED1's step has run: the step it is at, as led_step() counts. */
	unsigned int led_steps;
	bool identify_running;
	long long identify_next_ms;
	int identify_period_ms;
	int identify_starts;
} timers = { .last_led_ms = -1 };

void k_timer_start(struct k_timer *timer, k_timeout_t duration, k_timeout_t period)
{
	if (timer == &identify_timer) {
		timers.identify_running = true;
		timers.identify_next_ms = timers.now_ms + duration;
		timers.identify_period_ms = period;
		timers.identify_starts++;
	} else {
		CHECK(timer == &led_timer);
		CHECK(duration == STEP_MS && period == STEP_MS);
	}
}

void k_timer_stop(struct k_timer *timer)
{
	if (timer == &identify_timer) {
		timers.identify_running = false;
	}
}

static void key(uint16_t code, bool pressed)
{
	struct input_event event = { .type = INPUT_EV_KEY, .code = code, .value = pressed };

	host_input_callback(&event, NULL);
}

static void fresh_boot(void)
{
	pressed_at[APP_BUTTON_1] = 0;
	pressed_at[APP_BUTTON_2] = 0;
	posted_count = 0;
	uptime_ms = 0;
}

static void test_button_held_through_a_boot_is_no_factory_reset(void)
{
	fresh_boot();
	/* The driver saw the button down when it started, and reports no press for that. */
	uptime_ms = 70000;
	key(INPUT_KEY_1, false);
	CHECK(posted_count == 0);

	/* Button 1 the same way: it would have declined or accepted an update. */
	key(INPUT_KEY_0, false);
	CHECK(posted_count == 0);
}

static void test_the_next_press_after_that_counts_again(void)
{
	fresh_boot();
	uptime_ms = 70000;
	key(INPUT_KEY_1, false);
	CHECK(posted_count == 0);

	uptime_ms = 71000;
	key(INPUT_KEY_1, true);
	uptime_ms = 71200;
	key(INPUT_KEY_1, false);
	CHECK(posted_count == 1);
	CHECK(posted[0].type == APP_EVENT_BUTTON);
	CHECK(posted[0].button.id == APP_BUTTON_2);
	CHECK(!posted[0].button.long_press);
}

static void test_short_press(void)
{
	fresh_boot();
	uptime_ms = 10000;
	key(INPUT_KEY_0, true);
	CHECK(posted_count == 0);

	uptime_ms = 14999;
	key(INPUT_KEY_0, false);
	CHECK(posted_count == 1);
	CHECK(posted[0].button.id == APP_BUTTON_1);
	CHECK(!posted[0].button.long_press);
}

static void test_long_press_is_still_a_long_press(void)
{
	fresh_boot();
	uptime_ms = 10000;
	key(INPUT_KEY_1, true);
	uptime_ms = 15000;
	key(INPUT_KEY_1, false);
	CHECK(posted_count == 1);
	CHECK(posted[0].button.id == APP_BUTTON_2);
	CHECK(posted[0].button.long_press);
}

static void test_a_press_counts_once(void)
{
	fresh_boot();
	uptime_ms = 10000;
	key(INPUT_KEY_1, true);
	uptime_ms = 10100;
	key(INPUT_KEY_1, false);
	CHECK(posted_count == 1);

	/* The press has been used up: a second release must not be measured against it. */
	uptime_ms = 20000;
	key(INPUT_KEY_1, false);
	CHECK(posted_count == 1);
}

static void test_the_buttons_do_not_share_a_press(void)
{
	fresh_boot();
	uptime_ms = 10000;
	key(INPUT_KEY_0, true);

	/* Button 2 was down from before the boot; Button 1's press says nothing about it. */
	uptime_ms = 20000;
	key(INPUT_KEY_1, false);
	CHECK(posted_count == 0);

	key(INPUT_KEY_0, false);
	CHECK(posted_count == 1);
	CHECK(posted[0].button.id == APP_BUTTON_1);
	CHECK(posted[0].button.long_press);
}

#if defined(CONFIG_APP_BT_OTA)
static void test_a_real_press_says_it_is_one(void)
{
	fresh_boot();
	uptime_ms = 10000;
	key(INPUT_KEY_0, true);
	uptime_ms = 15000;
	key(INPUT_KEY_0, false);
	CHECK(posted_count == 1);
	CHECK(posted[0].button.physical);
	CHECK(posted[0].button.long_press);
}

static void test_the_window_has_a_pattern_of_its_own(void)
{
	for (size_t i = 0; i < ARRAY_SIZE(patterns); i++) {
		CHECK(i == UI_BT_WINDOW || patterns[i] != patterns[UI_BT_WINDOW]);
	}
}
#endif

static uint16_t led1_of(enum ui_state state)
{
	ui_set_state(state);
	return (uint16_t)((uint32_t)atomic_get(&current_pattern) & 0xffffU);
}

static uint16_t led2_of(enum ui_state state)
{
	ui_set_state(state);
	return (uint16_t)((uint32_t)atomic_get(&current_pattern) >> 16);
}

static void test_online_the_leds_take_turns(void)
{
	/* At every step exactly one of the two is on, and each one does blink. */
	CHECK((uint16_t)(led1_of(UI_ONLINE) ^ led2_of(UI_ONLINE)) == 0xffffU);
	CHECK(led1_of(UI_ONLINE) != 0U && led1_of(UI_ONLINE) != 0xffffU);
}

static void test_led2_is_dark_in_every_other_state(void)
{
	for (size_t i = 0; i < ARRAY_SIZE(patterns); i++) {
		if (i != UI_ONLINE) {
			CHECK(led2_of((enum ui_state)i) == 0U);
			CHECK(led1_of((enum ui_state)i) == patterns[i]);
		}
	}
}

static void test_online_looks_like_nothing_else_on_led1(void)
{
	/* Even with LED2 out of sight, LED1 alone has to tell online from every other state. */
	for (size_t i = 0; i < ARRAY_SIZE(patterns); i++) {
		CHECK(i == UI_ONLINE || patterns[i] != patterns[UI_ONLINE]);
	}
}

static void test_other_input_is_ignored(void)
{
	struct input_event not_a_key = { .type = INPUT_EV_REL, .code = INPUT_KEY_1, .value = 1 };

	fresh_boot();
	uptime_ms = 10000;
	host_input_callback(&not_a_key, NULL);
	CHECK(pressed_at[APP_BUTTON_2] == 0);

	key(INPUT_KEY_2, true);
	key(INPUT_KEY_2, false);
	CHECK(posted_count == 0);
}

/* What is due now: LED1's step every 125 ms from 0, and identify's from when it started. */
static void timers_fire(void)
{
	if (timers.now_ms % STEP_MS == 0 && timers.last_led_ms != timers.now_ms) {
		timers.last_led_ms = timers.now_ms;
		led_timer.expiry(&led_timer);
		timers.led_steps++;
	}

	while (timers.identify_running && timers.identify_next_ms <= timers.now_ms) {
		timers.identify_next_ms += timers.identify_period_ms;
		identify_timer.expiry(&identify_timer);
	}
}

/* Time passes in steps of 25 ms. each, if given, sees the LEDs after every one. */
static void run_for(long long ms, void (*each)(void))
{
	long long end = timers.now_ms + ms;

	timers_fire();
	if (each != NULL) {
		each();
	}
	while (timers.now_ms < end) {
		timers.now_ms += 25;
		timers_fire();
		if (each != NULL) {
			each();
		}
	}
}

/* What LED1 shows of a state after its last step: the step counts on, identify or not. */
static int led1_now(enum ui_state state)
{
	return (patterns[state] >> ((timers.led_steps - 1) % STEPS)) & 1;
}

static struct {
	int rises;
	int apart;
	int last;
	long long on_since;
	int short_on;
	int long_on;
} seen;

static void watch_identify(void)
{
	int led1 = host_gpio_value[0];

	seen.apart += led1 != host_gpio_value[1];
	if (led1 && !seen.last) {
		seen.rises++;
		seen.on_since = timers.now_ms;
	} else if (!led1 && seen.last) {
		long long on = timers.now_ms - seen.on_since;

		seen.short_on += on < UI_IDENTIFY_STEP_MS;
		seen.long_on += on > UI_IDENTIFY_STEP_MS;
	}
	seen.last = led1;
}

static void check_shows(enum ui_state state, long long ms)
{
	/* At each of LED1's steps, what the state's pattern says, and LED2 too. */
	for (long long end = timers.now_ms + ms; timers.now_ms < end;) {
		run_for(STEP_MS, NULL);
		CHECK(host_gpio_value[0] == led1_now(state));
		if (state == UI_ONLINE) {
			CHECK(host_gpio_value[1] == !host_gpio_value[0]);
		} else {
			CHECK(host_gpio_value[1] == 0);
		}
	}
}

static void test_identify_blinks_both_and_gives_them_back(void)
{
	CHECK(ui_init() == 0);
	ui_set_state(UI_ONLINE);
	timers.now_ms = 1000;
	check_shows(UI_ONLINE, 2000);

	/* Both together, a tenth of a second on and a tenth off: 5 Hz, for 15 s. */
	timers.now_ms += 50;
	memset(&seen, 0, sizeof(seen));
	ui_identify(15);
	CHECK(timers.identify_starts == 1);
	CHECK(timers.identify_period_ms == UI_IDENTIFY_STEP_MS);
	CHECK(timers.identify_next_ms == timers.now_ms);
	run_for(15000 - 25, watch_identify);
	CHECK(seen.rises == 15 * 5);
	CHECK(seen.apart == 0);
	CHECK(seen.short_on == 0 && seen.long_on == 0);
	CHECK(timers.identify_running);

	/* Then what the state shows, at the step it would have been at, and the timer is stopped. */
	run_for(100, NULL);
	CHECK(!timers.identify_running);
	check_shows(UI_ONLINE, 4000);
	CHECK(atomic_get(&identify_steps) == 0);
}

static void test_identify_ends_on_the_state_as_it_is_then(void)
{
	timers.now_ms = 100000;
	ui_set_state(UI_ONLINE);
	ui_identify(3);
	run_for(1000, NULL);

	/* The state changes under identify: it is kept, and not shown until identify is over. */
	ui_set_state(UI_UPDATE_IN_PROGRESS);
	memset(&seen, 0, sizeof(seen));
	run_for(1900, watch_identify);
	CHECK(seen.apart == 0);
	run_for(200, NULL);
	CHECK(!timers.identify_running);
	check_shows(UI_UPDATE_IN_PROGRESS, 2000);
}

static void test_identify_again_starts_the_time_again_and_0_ends_it(void)
{
	timers.now_ms = 200000;
	ui_set_state(UI_CLOUD_CONNECTING);

	ui_identify(5);
	run_for(3000, NULL);
	memset(&seen, 0, sizeof(seen));
	ui_identify(5);
	run_for(5000 - 25, watch_identify);
	CHECK(timers.identify_running);
	CHECK(seen.rises == 25 && seen.apart == 0);
	run_for(100, NULL);
	CHECK(!timers.identify_running);
	check_shows(UI_CLOUD_CONNECTING, 2000);

	/* 0: over at once, and the next step of LED1 is the state's. */
	ui_identify(10);
	run_for(2000, NULL);
	ui_identify(0);
	CHECK(!timers.identify_running);
	CHECK(atomic_get(&identify_steps) == 0);
	check_shows(UI_CLOUD_CONNECTING, 2000);

	/* However long it is asked for, the count stays far from overflowing. */
	ui_identify(4000000000U);
	CHECK(atomic_get(&identify_steps) == 3600 * (1000 / UI_IDENTIFY_STEP_MS) + 1);
	ui_identify(0);
}

int main(void)
{
	test_button_held_through_a_boot_is_no_factory_reset();
	test_the_next_press_after_that_counts_again();
	test_short_press();
	test_long_press_is_still_a_long_press();
	test_a_press_counts_once();
	test_the_buttons_do_not_share_a_press();
	test_other_input_is_ignored();
	test_online_the_leds_take_turns();
	test_led2_is_dark_in_every_other_state();
	test_online_looks_like_nothing_else_on_led1();
	test_identify_blinks_both_and_gives_them_back();
	test_identify_ends_on_the_state_as_it_is_then();
	test_identify_again_starts_the_time_again_and_0_ends_it();
#if defined(CONFIG_APP_BT_OTA)
	test_a_real_press_says_it_is_one();
	test_the_window_has_a_pattern_of_its_own();
#endif

	printf("%d button checks, %d failed\n", checks, failures);
	return failures ? 1 : 0;
}
