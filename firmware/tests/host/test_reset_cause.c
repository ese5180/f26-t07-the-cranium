/*
 * Host-side tests of src/reset_cause.c, from 1.14.0 the one reader of why the last boot ended: it
 * reads the register once and clears it once, so that the console, the boot diary and Memfault all
 * see the same cause, and Memfault no longer finds it cleared by the console. The real file is
 * included here, against a fake of the register that keeps its bits until they are cleared, as the
 * nRF5340's RESETREAS does. Also what each set of bits comes down to, in Memfault's order.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "reset_cause.c"

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

static struct {
	uint32_t reg;
	int read_result;
	int reads;
	int clears;
} fake;

int hwinfo_get_reset_cause(uint32_t *found)
{
	fake.reads++;
	if (fake.read_result != 0) {
		return fake.read_result;
	}
	*found = fake.reg;
	return 0;
}

int hwinfo_clear_reset_cause(void)
{
	fake.clears++;
	fake.reg = 0;
	return 0;
}

/* A new boot: the register as the hardware left it, and this module as it starts. */
static void boot_with(uint32_t reg)
{
	memset(&fake, 0, sizeof(fake));
	fake.reg = reg;
	cause = 0;
	captured = false;
}

static void test_read_once_and_cleared_once(void)
{
	boot_with(RESET_WATCHDOG | RESET_PIN);
	CHECK(reset_cause_get() == 0);

	reset_cause_capture();
	CHECK(fake.reads == 1 && fake.clears == 1);
	CHECK(reset_cause_get() == (RESET_WATCHDOG | RESET_PIN));
	/* The register is empty now: the next boot sees only what happens next. */
	CHECK(fake.reg == 0);

	/* Whoever asks later gets what was there, and nobody reads or clears it again. */
	reset_cause_capture();
	reset_cause_capture();
	CHECK(fake.reads == 1 && fake.clears == 1);
	CHECK(reset_cause_get() == (RESET_WATCHDOG | RESET_PIN));
	CHECK(reset_cause_kind(reset_cause_get()) == RESET_KIND_WATCHDOG);
}

static void test_a_register_that_cannot_be_read_is_not_cleared(void)
{
	boot_with(RESET_SOFTWARE);
	fake.read_result = -5;
	reset_cause_capture();
	CHECK(fake.reads == 1 && fake.clears == 0);
	CHECK(reset_cause_get() == 0);
	CHECK(fake.reg == RESET_SOFTWARE);
}

static void test_bits_from_one_boot_do_not_reach_the_next(void)
{
	/* A software reset, then a power cut: a board that kept the bits would say software again. */
	boot_with(RESET_SOFTWARE);
	reset_cause_capture();
	CHECK(reset_cause_kind(reset_cause_get()) == RESET_KIND_SOFTWARE);

	{
		uint32_t left = fake.reg;

		boot_with(left);
	}
	reset_cause_capture();
	CHECK(reset_cause_get() == 0);
	CHECK(reset_cause_kind(reset_cause_get()) == RESET_KIND_POWER_ON);
}

static void test_what_the_bits_come_down_to(void)
{
	static const struct {
		uint32_t bits;
		enum reset_kind kind;
	} cases[] = {
		/* None, on this SoC, is a power-on. */
		{ 0, RESET_KIND_POWER_ON },
		{ RESET_POR, RESET_KIND_POWER_ON },
		{ RESET_PIN, RESET_KIND_PIN },
		{ RESET_SOFTWARE, RESET_KIND_SOFTWARE },
		{ RESET_WATCHDOG, RESET_KIND_WATCHDOG },
		{ RESET_CPU_LOCKUP, RESET_KIND_LOCKUP },
		{ RESET_DEBUG, RESET_KIND_DEBUG },
		{ RESET_LOW_POWER_WAKE, RESET_KIND_LOW_POWER_WAKE },
		{ RESET_BROWNOUT, RESET_KIND_BROWNOUT },
		{ RESET_SECURITY, RESET_KIND_SECURITY },
		{ RESET_PARITY, RESET_KIND_PARITY },
		{ RESET_PLL, RESET_KIND_CLOCK },
		{ RESET_CLOCK, RESET_KIND_CLOCK },
		{ RESET_HARDWARE, RESET_KIND_HARDWARE },
		{ RESET_USER, RESET_KIND_USER },
		{ RESET_TEMPERATURE, RESET_KIND_TEMPERATURE },
		/* Bits that mean nothing here. */
		{ RESET_BOOTLOADER, RESET_KIND_UNKNOWN },
		{ RESET_FLASH | (1u << 30), RESET_KIND_UNKNOWN },
		/* Together: a pin or a software reset comes with others, and the other one says more. */
		{ RESET_PIN | RESET_SOFTWARE, RESET_KIND_SOFTWARE },
		{ RESET_PIN | RESET_WATCHDOG, RESET_KIND_WATCHDOG },
		{ RESET_SOFTWARE | RESET_CPU_LOCKUP, RESET_KIND_LOCKUP },
		{ RESET_SOFTWARE | RESET_DEBUG, RESET_KIND_DEBUG },
		{ RESET_WATCHDOG | RESET_BROWNOUT, RESET_KIND_BROWNOUT },
		{ RESET_POR | RESET_WATCHDOG, RESET_KIND_POWER_ON },
		{ RESET_PIN | RESET_BOOTLOADER, RESET_KIND_PIN },
		{ 0xffffffffu, RESET_KIND_BROWNOUT },
	};

	for (size_t i = 0; i < ARRAY_SIZE(cases); i++) {
		enum reset_kind kind = reset_cause_kind(cases[i].bits);

		if (kind != cases[i].kind) {
			printf("bits 0x%x gave %d, expected %d\n", (unsigned int)cases[i].bits, kind,
			       cases[i].kind);
		}
		CHECK(kind == cases[i].kind);
	}
}

int main(void)
{
	test_read_once_and_cleared_once();
	test_a_register_that_cannot_be_read_is_not_cleared();
	test_bits_from_one_boot_do_not_reach_the_next();
	test_what_the_bits_come_down_to();

	printf("%d reset cause checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
