#include "stack_watch.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/sys_heap.h>

#include "stack_policy.h"

LOG_MODULE_REGISTER(stack_watch, CONFIG_APP_LOG_LEVEL);

BUILD_ASSERT(IS_ENABLED(CONFIG_INIT_STACKS) && IS_ENABLED(CONFIG_THREAD_STACK_INFO) &&
		     IS_ENABLED(CONFIG_THREAD_MONITOR) && IS_ENABLED(CONFIG_SYS_HEAP_RUNTIME_STATS),
	     "the report needs filled stacks, their sizes, the list of threads and the heaps' statistics");
BUILD_ASSERT(CONFIG_SYS_HEAP_ARRAY_SIZE > 0, "the heap report needs the list of heaps");

/* More than enough for every thread: the walk stops after this many reports all the same. */
#define REPORTS_MAX 4

K_KERNEL_STACK_ARRAY_DECLARE(z_interrupt_stacks, CONFIG_MP_MAX_NUM_CPUS, CONFIG_ISR_STACK_SIZE);

struct walk {
	struct stack_report report;
	/* The threads (the interrupt stack first) that earlier reports had, and the index of this one. */
	unsigned int skip;
	unsigned int index;
	bool first;
};

static void one_stack(struct walk *walk, const char *name, size_t size, size_t unused)
{
	/* A warning once per look, not once per report. */
	if (walk->first && stack_over_warning(size, unused)) {
		LOG_WRN("Stack of %s: %u of %u bytes used (%u%%)",
			name != NULL && name[0] != '\0' ? name : "?", (unsigned int)(size - unused),
			(unsigned int)size, stack_used_pct(size, unused));
	}
	if (walk->index++ < walk->skip) {
		stack_report_note(&walk->report, size, unused);
	} else {
		(void)stack_report_add(&walk->report, name, size, unused);
	}
}

static void one_thread(const struct k_thread *thread, void *user_data)
{
	size_t unused;

	if (k_thread_stack_space_get(thread, &unused) != 0) {
		return;
	}
	one_stack(user_data, k_thread_name_get((k_tid_t)thread), thread->stack_info.size, unused);
}

/* The interrupt stack has no thread: what is still the fill (0xaa, from its bottom) was never used. */
static void isr_stack(struct walk *walk)
{
	const uint8_t *buf = K_KERNEL_STACK_BUFFER(z_interrupt_stacks[0]);
	size_t size = K_KERNEL_STACK_SIZEOF(z_interrupt_stacks[0]);
	size_t unused = 0;

	while (unused < size && buf[unused] == 0xaaU) {
		unused++;
	}
	one_stack(walk, "isr", size, unused);
}

static void publish_heaps(int (*report)(const char *json))
{
	struct sys_heap **heaps;
	struct heap_use use[CONFIG_SYS_HEAP_ARRAY_SIZE];
	size_t n = 0;
	char text[HEAP_REPORT_MAX];
	int count = sys_heap_array_get(&heaps);

	for (int i = 0; i < count && n < ARRAY_SIZE(use); i++) {
		struct sys_memory_stats stats;

		if (sys_heap_runtime_stats_get(heaps[i], &stats) == 0) {
			use[n].size = stats.free_bytes + stats.allocated_bytes;
			use[n].peak = stats.max_allocated_bytes;
			n++;
		}
	}
	if (heap_report_format(use, n, text, sizeof(text)) > 0) {
		(void)report(text);
	}
}

void stack_watch_publish(int (*report)(const char *json))
{
	char text[STACK_REPORT_MAX];
	struct walk walk = { .first = true };

	for (int i = 0; i < REPORTS_MAX; i++) {
		walk.index = 0;
		stack_report_begin(&walk.report, text, sizeof(text));
		walk.report.base = walk.skip;
		isr_stack(&walk);
		k_thread_foreach_unlocked(one_thread, &walk);
		walk.first = false;
		if (stack_report_end(&walk.report) <= 0 || walk.report.count == 0) {
			break;
		}
		(void)report(text);
		if (walk.report.more == 0) {
			break;
		}
		walk.skip += walk.report.count;
	}
	publish_heaps(report);
}
