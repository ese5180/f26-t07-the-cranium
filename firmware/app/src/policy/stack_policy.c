#include "stack_policy.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

/* `,"more":N}}` and the end of the string: what end() may still have to add. */
#define TAIL_RESERVE 24
/* `{"stacks":{"max_pct":100`: written by end(), kept free from the start. */
#define HEAD "{\"stacks\":{\"max_pct\":"
#define HEAD_RESERVE (sizeof(HEAD) - 1 + 3)

unsigned int stack_used_pct(size_t size, size_t unused)
{
	if (size == 0) {
		return 0;
	}
	if (unused >= size) {
		return 0;
	}
	size_t used = size - unused;

	return (unsigned int)((used * 100U + size - 1U) / size);
}

bool stack_over_warning(size_t size, size_t unused)
{
	if (size == 0 || unused >= size) {
		return false;
	}
	/* used / size > STACK_WARN_PCT / 100, in integers. */
	return (size - unused) * 100U > size * STACK_WARN_PCT;
}

static bool name_char(char c)
{
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' ||
	       c == '-';
}

void stack_report_begin(struct stack_report *report, char *buf, size_t len)
{
	memset(report, 0, sizeof(*report));
	report->buf = buf;
	report->len = len;
	/* The entries are written after room for the head, which end() fills in once max_pct is known. */
	report->at = HEAD_RESERVE;
	if (buf != NULL && len > 0) {
		buf[0] = '\0';
	}
}

void stack_report_add(struct stack_report *report, const char *name, size_t size, size_t unused)
{
	unsigned int pct = stack_used_pct(size, unused);
	size_t used = unused >= size ? 0 : size - unused;
	char clean[STACK_NAME_MAX + 1];
	size_t n = 0;

	if (pct > report->max_pct) {
		report->max_pct = pct;
	}

	if (name != NULL) {
		for (; name[n] != '\0' && n < STACK_NAME_MAX; n++) {
			clean[n] = name_char(name[n]) ? name[n] : '_';
		}
	}
	clean[n] = '\0';
	if (n == 0) {
		snprintf(clean, sizeof(clean), "t%u", report->count + report->more);
	}

	if (report->buf == NULL || report->at + TAIL_RESERVE >= report->len) {
		report->more++;
		return;
	}
	size_t room = report->len - TAIL_RESERVE - report->at;
	int written = snprintf(report->buf + report->at, room, ",\"%s\":%u", clean, (unsigned int)used);

	if (written < 0 || (size_t)written >= room) {
		report->more++;
		return;
	}
	report->at += (size_t)written;
	report->count++;
}

int stack_report_end(struct stack_report *report)
{
	char head[HEAD_RESERVE + 1];

	if (report->buf == NULL || report->len < HEAD_RESERVE + TAIL_RESERVE) {
		return -ENOSPC;
	}
	int head_len = snprintf(head, sizeof(head), HEAD "%u", report->max_pct > 100 ? 100 : report->max_pct);

	if (head_len < 0 || (size_t)head_len > HEAD_RESERVE) {
		return -ENOSPC;
	}
	/* The entries move down to just after the head. */
	size_t body = report->at - HEAD_RESERVE;

	memmove(report->buf + head_len, report->buf + HEAD_RESERVE, body);
	memcpy(report->buf, head, (size_t)head_len);
	size_t at = (size_t)head_len + body;
	int tail = report->more > 0
			   ? snprintf(report->buf + at, report->len - at, ",\"more\":%u}}", report->more)
			   : snprintf(report->buf + at, report->len - at, "}}");

	if (tail < 0 || (size_t)tail >= report->len - at) {
		return -ENOSPC;
	}
	return (int)(at + (size_t)tail);
}
