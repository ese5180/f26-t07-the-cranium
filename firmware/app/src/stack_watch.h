/*
 * The stack use of every thread and of the interrupt stack, from the high-water mark the kernel
 * keeps (CONFIG_INIT_STACKS fills each stack at its start, and what is still the fill has never been
 * used), and the peak of every heap. main.c sends both into the device shadow with the diagnostics
 * report, and each thread past STACK_WARN_PCT of its stack is a warning in the log, every time it is
 * looked at. The format is in src/policy/stack_policy.h. The stacks themselves stay guarded as before: the stack limit register
 * and the MPU (CONFIG_HW_STACK_PROTECTION) stop an overflow; this says how close each one comes.
 */

#ifndef STACK_WATCH_H_
#define STACK_WATCH_H_

#include <stddef.h>

/* Send the stack report, in as many parts as it takes, and the heap report, each through report()
 * (cloud_shadow_report()), and log a warning for each stack past STACK_WARN_PCT.
 */
void stack_watch_publish(int (*report)(const char *json));

#endif /* STACK_WATCH_H_ */
