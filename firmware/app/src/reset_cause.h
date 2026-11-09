/*
 * Why the last boot ended, from 1.14.0 the one place that reads it.
 *
 * Zephyr's hwinfo reset cause is a register that keeps its bits until they are cleared, so one
 * reader has to read it once and clear it. Up to 1.13.0 that was the console, at its own start,
 * and the Memfault SDK, which reads it later, would have found it empty. Now this module reads it
 * as the kernel starts, before either, and clears it: the console's STATS, the boot diary and
 * Memfault's reboot reason (src/mflt/mflt.c) all take it from here. A build with no console clears it
 * too, which nothing did before.
 */

#ifndef RESET_CAUSE_H_
#define RESET_CAUSE_H_

#include <stdint.h>

/* What one cause comes down to, in the order of precedence that the Memfault SDK uses. */
enum reset_kind {
	RESET_KIND_BROWNOUT,
	RESET_KIND_POWER_ON,
	RESET_KIND_WATCHDOG,
	RESET_KIND_DEBUG,
	RESET_KIND_SECURITY,
	RESET_KIND_LOW_POWER_WAKE,
	RESET_KIND_LOCKUP,
	RESET_KIND_PARITY,
	RESET_KIND_CLOCK,
	RESET_KIND_HARDWARE,
	RESET_KIND_USER,
	RESET_KIND_TEMPERATURE,
	RESET_KIND_SOFTWARE,
	RESET_KIND_PIN,
	/* Bits, and none that this knows. */
	RESET_KIND_UNKNOWN,
};

/*
 * Read the cause and clear it, once: a second call changes nothing. The kernel calls it as it
 * starts; host tests call it themselves.
 */
void reset_cause_capture(void);

/* The hwinfo RESET_ bits that the capture found: 0 for none, as after a power-on on this SoC. */
uint32_t reset_cause_get(void);

/*
 * The one kind that the bits come down to: the first that matches, in the order of enum
 * reset_kind. No bits is a power-on, which is how this SoC reports one.
 */
enum reset_kind reset_cause_kind(uint32_t cause);

#endif /* RESET_CAUSE_H_ */
