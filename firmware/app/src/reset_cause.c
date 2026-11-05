/*
 * Why the last boot ended: see reset_cause.h.
 */

#include "reset_cause.h"

#include <stdbool.h>

#include <zephyr/drivers/hwinfo.h>
#include <zephyr/init.h>
#include <zephyr/sys/util.h>

static uint32_t cause;
static bool captured;

void reset_cause_capture(void)
{
	uint32_t found = 0;

	if (captured) {
		return;
	}
	captured = true;

	/* A cause that cannot be read is no cause, and nothing is cleared that was not read. */
	if (hwinfo_get_reset_cause(&found) == 0) {
		cause = found;
		(void)hwinfo_clear_reset_cause();
	}
}

uint32_t reset_cause_get(void)
{
	return cause;
}

enum reset_kind reset_cause_kind(uint32_t bits)
{
	/*
	 * The Memfault SDK's own table, in its order (prv_zephyr_to_memfault_reboot_reason() in
	 * ports/zephyr/common/memfault_platform_core.c): a software reset can come with other bits,
	 * and a pin reset with any, so they come last.
	 */
	static const struct {
		uint32_t bit;
		enum reset_kind kind;
	} order[] = {
		{ RESET_BROWNOUT, RESET_KIND_BROWNOUT },
		{ RESET_POR, RESET_KIND_POWER_ON },
		{ RESET_WATCHDOG, RESET_KIND_WATCHDOG },
		{ RESET_DEBUG, RESET_KIND_DEBUG },
		{ RESET_SECURITY, RESET_KIND_SECURITY },
		{ RESET_LOW_POWER_WAKE, RESET_KIND_LOW_POWER_WAKE },
		{ RESET_CPU_LOCKUP, RESET_KIND_LOCKUP },
		{ RESET_PARITY, RESET_KIND_PARITY },
		{ RESET_PLL, RESET_KIND_CLOCK },
		{ RESET_CLOCK, RESET_KIND_CLOCK },
		{ RESET_HARDWARE, RESET_KIND_HARDWARE },
		{ RESET_USER, RESET_KIND_USER },
		{ RESET_TEMPERATURE, RESET_KIND_TEMPERATURE },
		{ RESET_SOFTWARE, RESET_KIND_SOFTWARE },
		{ RESET_PIN, RESET_KIND_PIN },
	};

	/* The nRF5340 has no bit for a power-on: none is one. */
	if (bits == 0) {
		return RESET_KIND_POWER_ON;
	}

	for (size_t i = 0; i < ARRAY_SIZE(order); i++) {
		if (bits & order[i].bit) {
			return order[i].kind;
		}
	}

	return RESET_KIND_UNKNOWN;
}

/* Unused only in a host test, where SYS_INIT is nothing. */
static __attribute__((unused)) int reset_cause_init(void)
{
	reset_cause_capture();
	return 0;
}

/* Before the console (POST_KERNEL) and the Memfault SDK (APPLICATION) look at it. */
SYS_INIT(reset_cause_init, PRE_KERNEL_1, 0);
