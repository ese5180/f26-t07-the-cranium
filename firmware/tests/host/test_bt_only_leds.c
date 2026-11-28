/*
 * Host-side tests of src/bt_only/bt_only_leds.c: what LED3 and LED4 of a board with Bluetooth only show, as
 * bt_only.h says. The real file is compiled here, to get at the patterns it hands its timer.
 */

#include <stdio.h>
#include <stdlib.h>

#include "bt_only_leds.c"

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

static int timer_starts;

void k_timer_start(struct k_timer *timer, k_timeout_t duration, k_timeout_t period)
{
	CHECK(timer == &bt_only_led_timer);
	CHECK(duration == STEP_MS && period == STEP_MS);
	timer_starts++;
}

static uint16_t led3(void)
{
	return (uint16_t)atomic_get(&current);
}

static uint16_t led4(void)
{
	return (uint16_t)((uint32_t)atomic_get(&current) >> 16);
}

static void test_led3_shows_the_phone(void)
{
	CHECK(bt_only_leds_init() == 0);
	CHECK(timer_starts == 1);
	CHECK(led3() == 0 && led4() == 0);

	bt_only_leds_link(BT_OTA_LINK_CONNECTED);
	CHECK(led3() == 0xffff);
	bt_only_leds_link(BT_OTA_LINK_RECEIVING);
	/* Fast: on and off every 125 ms. */
	CHECK(led3() == 0x5555);
	bt_only_leds_link(BT_OTA_LINK_NONE);
	CHECK(led3() == 0);
	CHECK(led4() == 0);
}

static void test_led4_shows_trouble_for_30_seconds(void)
{
	bt_only_leds_link(BT_OTA_LINK_CONNECTED);
	bt_only_leds_trouble();
	CHECK(led4() == 0xffff && led3() == 0xffff);

	/* The link changes under it, and the trouble stays. */
	bt_only_leds_link(BT_OTA_LINK_NONE);
	CHECK(led4() == 0xffff && led3() == 0);

	for (int second = 1; second < BT_ONLY_TROUBLE_SECONDS; second++) {
		bt_only_leds_tick();
	}
	CHECK(led4() == 0xffff);
	bt_only_leds_tick();
	CHECK(led4() == 0);
	bt_only_leds_tick();
	CHECK(led4() == 0);

	/* More trouble starts the 30 s again. */
	bt_only_leds_trouble();
	for (int second = 1; second < 20; second++) {
		bt_only_leds_tick();
	}
	bt_only_leds_trouble();
	for (int second = 1; second < BT_ONLY_TROUBLE_SECONDS; second++) {
		bt_only_leds_tick();
	}
	CHECK(led4() == 0xffff);
	bt_only_leds_tick();
	CHECK(led4() == 0);
}

static void test_a_step_goes_round_the_pattern(void)
{
	/* Two seconds of steps: it does not run off the end of the pattern. */
	for (int i = 0; i < 64; i++) {
		led_step(NULL);
	}
	CHECK(true);
}

int main(void)
{
	test_led3_shows_the_phone();
	test_led4_shows_trouble_for_30_seconds();
	test_a_step_goes_round_the_pattern();

	printf("%d LED checks, %d failed\n", checks, failed_checks);
	return failed_checks == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
