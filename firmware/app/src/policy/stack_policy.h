/*
 * How much of each thread's stack has been used, and the report of it in the device shadow
 * (src/stack_watch.h). Plain C, with no kernel call, so that it is tested on the build machine
 * (firmware/tests/host/test_stack_policy.c).
 *
 * The report is its own shadow member, next to "diag", one number per thread: the most of its stack
 * the thread has ever used, in bytes, and the highest share of any of them, in percent:
 *
 *   {"stacks":{"max_pct":61,"main":3712,"sysworkq":2440,"isr":1180}}
 *
 * The size of each stack is fixed in the image (docs/firmware-memory.md has the table); these are
 * the numbers that tell whether it is too big or too small. A thread with no name is "t" and its
 * place in the walk. A name keeps letters, digits, '_' and '-'; anything else becomes '_'. When the
 * report would not fit, the threads that did not fit are counted in "more" and go into the next
 * report, which the shadow merges into the same "stacks". max_pct is over every thread, in each one.
 *
 * The peak of every heap goes in a report of its own, as [size, most ever allocated] in bytes, in
 * the order the heaps were set up; they have no names, and their sizes tell them apart:
 *
 *   {"heaps":[[44048,28832],[20000,9120],[59856,41200]]}
 */

#ifndef STACK_POLICY_H_
#define STACK_POLICY_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* A thread that has used more than this share of its stack gets a warning in the log. */
#define STACK_WARN_PCT 80
/* The longest thread name that goes into the report. */
#define STACK_NAME_MAX 16
/* What the report is written into: it has to fit the shadow document (SHADOW_MAX in cloud.c). */
#define STACK_REPORT_MAX 448

/* The share of a stack of `size` bytes used when `unused` of them have never been touched, in whole
 * percent rounded up, so that a stack that is used at all is never 0 % and 100 % means full.
 */
unsigned int stack_used_pct(size_t size, size_t unused);

/* Whether that is past STACK_WARN_PCT. */
bool stack_over_warning(size_t size, size_t unused);

struct stack_report {
	char *buf;
	size_t len;
	size_t at;
	unsigned int count;
	unsigned int more;
	unsigned int max_pct;
	/* How many threads earlier reports of the same walk had: an unnamed thread is "t" and its place
	 * in the whole walk.
	 */
	unsigned int base;
};

/* Start a report in buf, of len bytes, at least STACK_REPORT_MAX. */
void stack_report_begin(struct stack_report *report, char *buf, size_t len);

/* One thread. name may be NULL or empty. Returns false when the report is full: the thread is counted
 * in "more", and goes into the next report.
 */
bool stack_report_add(struct stack_report *report, const char *name, size_t size, size_t unused);

/* A thread that an earlier report of the same walk had: it only counts towards max_pct. */
void stack_report_note(struct stack_report *report, size_t size, size_t unused);

/* Finish it. Returns its length, or a negative error when buf could not hold even an empty report. */
int stack_report_end(struct stack_report *report);

/* What the heap report is written into: CONFIG_SYS_HEAP_ARRAY_SIZE (8) heaps of any size fit. */
#define HEAP_REPORT_MAX 208

struct heap_use {
	size_t size;
	size_t peak;
};

/* The heap report of n heaps. Returns its length, or -ENOSPC when it does not fit len. */
int heap_report_format(const struct heap_use *heaps, size_t n, char *buf, size_t len);

#endif /* STACK_POLICY_H_ */
