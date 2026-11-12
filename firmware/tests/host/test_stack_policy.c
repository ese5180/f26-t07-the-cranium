/*
 * Host-side tests of src/policy/stack_policy.c: the share of a stack that has been used, when that
 * is a warning, and the report that goes into the shadow. A wrong share hides a thread that is about
 * to overflow its stack; a wrong report is JSON the shadow refuses, or one too long for the
 * document it goes in.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "stack_policy.h"

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

static void test_the_share_used(void)
{
	CHECK(stack_used_pct(4096, 4096) == 0);
	CHECK(stack_used_pct(4096, 0) == 100);
	CHECK(stack_used_pct(4096, 2048) == 50);
	/* One byte used is 1 %, not 0 %: rounded up. */
	CHECK(stack_used_pct(4096, 4095) == 1);
	CHECK(stack_used_pct(1000, 199) == 81);
	/* What cannot be is nothing used, not a division by zero or a wrap. */
	CHECK(stack_used_pct(0, 0) == 0);
	CHECK(stack_used_pct(100, 200) == 0);
}

static void test_the_warning_is_past_eighty_percent(void)
{
	CHECK(!stack_over_warning(1000, 200)); /* 80 % exactly */
	CHECK(stack_over_warning(1000, 199));  /* 80.1 % */
	CHECK(stack_over_warning(6144, 0));
	CHECK(!stack_over_warning(6144, 6144));
	CHECK(!stack_over_warning(0, 0));
	CHECK(!stack_over_warning(100, 101));
	/* Large stacks do not overflow the arithmetic. */
	CHECK(stack_over_warning(81920, 16000));
	CHECK(!stack_over_warning(81920, 16384));
}

static void test_the_report(void)
{
	char buf[STACK_REPORT_MAX];
	struct stack_report report;

	stack_report_begin(&report, buf, sizeof(buf));
	stack_report_add(&report, "isr", 2048, 1024);
	stack_report_add(&report, "main", 6144, 1536);
	stack_report_add(&report, "sysworkq", 4096, 4000);
	int len = stack_report_end(&report);

	CHECK(len > 0);
	CHECK(strcmp(buf, "{\"stacks\":{\"max_pct\":75,\"isr\":1024,\"main\":4608,\"sysworkq\":96}}") == 0);
	CHECK((size_t)len == strlen(buf));
}

static void test_an_empty_report(void)
{
	char buf[STACK_REPORT_MAX];
	struct stack_report report;

	stack_report_begin(&report, buf, sizeof(buf));
	CHECK(stack_report_end(&report) > 0);
	CHECK(strcmp(buf, "{\"stacks\":{\"max_pct\":0}}") == 0);
}

static void test_names_are_made_safe_for_json(void)
{
	char buf[STACK_REPORT_MAX];
	struct stack_report report;

	stack_report_begin(&report, buf, sizeof(buf));
	stack_report_add(&report, "BT RX", 2048, 1048);
	stack_report_add(&report, "a\"b\\c}", 100, 50);
	stack_report_add(&report, NULL, 100, 100);
	stack_report_add(&report, "", 100, 100);
	stack_report_add(&report, "a_name_longer_than_sixteen", 100, 100);
	CHECK(stack_report_end(&report) > 0);
	CHECK(strcmp(buf, "{\"stacks\":{\"max_pct\":50,\"BT_RX\":1000,\"a_b_c_\":50,\"t2\":0,\"t3\":0,"
			  "\"a_name_longer_th\":0}}") == 0);
}

/* Many threads: what does not fit is counted and left out, and what is sent is still whole JSON. */
static void test_a_report_too_long_is_cut_and_says_so(void)
{
	char buf[STACK_REPORT_MAX];
	struct stack_report report;
	char name[STACK_NAME_MAX + 1];

	stack_report_begin(&report, buf, sizeof(buf));
	for (int i = 0; i < 60; i++) {
		snprintf(name, sizeof(name), "thread_%08d", i);
		stack_report_add(&report, name, 65536, i == 59 ? 0 : 65536 - 100);
	}
	int len = stack_report_end(&report);

	CHECK(len > 0);
	CHECK((size_t)len < sizeof(buf));
	CHECK(report.more > 0);
	CHECK(report.count + report.more == 60);
	/* max_pct counts the threads that were left out too. */
	CHECK(strncmp(buf, "{\"stacks\":{\"max_pct\":100,", 25) == 0);
	char tail[32];

	snprintf(tail, sizeof(tail), ",\"more\":%u}}", report.more);
	CHECK(strcmp(buf + len - strlen(tail), tail) == 0);
	/* Every entry that made it is whole: as many ':' as entries, plus max_pct, more, and stacks. */
	int colons = 0;

	for (int i = 0; i < len; i++) {
		colons += buf[i] == ':';
	}
	CHECK(colons == (int)report.count + 3);
}

/* The longest report it can write still fits the shadow document around it in cloud.c. */
static void test_the_longest_report_fits_the_shadow_document(void)
{
	char buf[STACK_REPORT_MAX];
	struct stack_report report;

	stack_report_begin(&report, buf, sizeof(buf));
	for (int i = 0; i < 100; i++) {
		stack_report_add(&report, "abcdefghijklmnop", 100000, 0);
	}
	int len = stack_report_end(&report);

	CHECK(len > 0 && len < STACK_REPORT_MAX);
	/* {"state":{"reported":...}} and the end of the string, in SHADOW_MAX (512). */
	CHECK(len + (int)strlen("{\"state\":{\"reported\":}}") + 1 <= 512);
}

static void test_a_buffer_too_small_is_an_error(void)
{
	char buf[16];
	struct stack_report report;

	stack_report_begin(&report, buf, sizeof(buf));
	stack_report_add(&report, "main", 100, 50);
	CHECK(stack_report_end(&report) < 0);
	stack_report_begin(&report, NULL, 0);
	stack_report_add(&report, "main", 100, 50);
	CHECK(stack_report_end(&report) < 0);
}

int main(void)
{
	test_the_share_used();
	test_the_warning_is_past_eighty_percent();
	test_the_report();
	test_an_empty_report();
	test_names_are_made_safe_for_json();
	test_a_report_too_long_is_cut_and_says_so();
	test_the_longest_report_fits_the_shadow_document();
	test_a_buffer_too_small_is_an_error();

	printf("stack_policy: %d checks, %d failures\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
