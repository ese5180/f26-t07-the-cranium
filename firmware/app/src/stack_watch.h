/*
 * The stack use of every thread and of the interrupt stack, from the high-water mark the kernel
 * keeps (CONFIG_INIT_STACKS fills each stack at its start, and what is still the fill has never been
 * used). main.c sends it into the device shadow with the diagnostics report, and each thread past
 * STACK_WARN_PCT of its stack is a warning in the log, every time it is looked at. The format is in
 * src/policy/stack_policy.h. The stacks themselves stay guarded as before: the stack limit register
 * and the MPU (CONFIG_HW_STACK_PROTECTION) stop an overflow; this says how close each one comes.
 */

#ifndef STACK_WATCH_H_
#define STACK_WATCH_H_

#include <stddef.h>

/* Write the report into buf (at least STACK_REPORT_MAX bytes). Returns its length or a negative error. */
int stack_watch_report(char *buf, size_t len);

#endif /* STACK_WATCH_H_ */
