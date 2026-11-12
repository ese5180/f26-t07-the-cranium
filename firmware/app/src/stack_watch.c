#include "stack_watch.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "stack_policy.h"

LOG_MODULE_REGISTER(stack_watch, CONFIG_APP_LOG_LEVEL);

BUILD_ASSERT(IS_ENABLED(CONFIG_INIT_STACKS) && IS_ENABLED(CONFIG_THREAD_STACK_INFO) &&
		     IS_ENABLED(CONFIG_THREAD_MONITOR),
	     "the stack report needs filled stacks, their sizes and the list of threads");

K_KERNEL_STACK_ARRAY_DECLARE(z_interrupt_stacks, CONFIG_MP_MAX_NUM_CPUS, CONFIG_ISR_STACK_SIZE);

static void note(struct stack_report *report, const char *name, size_t size, size_t unused)
{
	if (stack_over_warning(size, unused)) {
		LOG_WRN("Stack of %s: %u of %u bytes used (%u%%)", name != NULL && name[0] != '\0' ? name : "?",
			(unsigned int)(size - unused), (unsigned int)size, stack_used_pct(size, unused));
	}
	stack_report_add(report, name, size, unused);
}

static void one_thread(const struct k_thread *thread, void *user_data)
{
	struct stack_report *report = user_data;
	size_t unused;

	if (k_thread_stack_space_get(thread, &unused) != 0) {
		return;
	}
	note(report, k_thread_name_get((k_tid_t)thread), thread->stack_info.size, unused);
}

/* The interrupt stack has no thread: what is still the fill (0xaa, from its bottom) was never used. */
static void isr_stack(struct stack_report *report)
{
	const uint8_t *buf = K_KERNEL_STACK_BUFFER(z_interrupt_stacks[0]);
	size_t size = K_KERNEL_STACK_SIZEOF(z_interrupt_stacks[0]);
	size_t unused = 0;

	while (unused < size && buf[unused] == 0xaaU) {
		unused++;
	}
	note(report, "isr", size, unused);
}

int stack_watch_report(char *buf, size_t len)
{
	struct stack_report report;

	stack_report_begin(&report, buf, len);
	isr_stack(&report);
	k_thread_foreach_unlocked(one_thread, &report);
	return stack_report_end(&report);
}
