#include "diag.h"

#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "net.h"

#if defined(CONFIG_SYS_HEAP_RUNTIME_STATS)
#include <zephyr/kernel.h>
#include <zephyr/sys/sys_heap.h>
#endif

/* Only what an address looks like goes into the report: the shadow is JSON. */
static bool is_mac_text(const char *text)
{
	for (int i = 0; i < 17; i++) {
		char c = text[i];
		bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

		if ((i % 3 == 2) ? c != ':' : !hex) {
			return false;
		}
	}
	return text[17] == '\0';
}

void diag_collect(struct diag_values *values)
{
	memset(values, 0, sizeof(*values));
	if (device_id_valid(device_id())) {
		strncpy(values->id, device_id(), sizeof(values->id) - 1);
	}
	if (net_mac_address(values->mac, sizeof(values->mac)) < 0 || !is_mac_text(values->mac)) {
		strcpy(values->mac, "unknown");
	}
	values->channel = net_channel();

#if defined(CONFIG_SYS_HEAP_RUNTIME_STATS)
	extern struct k_heap _system_heap;
	struct sys_memory_stats stats = { 0 };

	if (sys_heap_runtime_stats_get(&_system_heap.heap, &stats) == 0) {
		size_t size = stats.free_bytes + stats.allocated_bytes;

		values->heap_free = (uint32_t)stats.free_bytes;
		values->heap_size = (uint32_t)size;
		values->heap_least =
			(uint32_t)(size > stats.max_allocated_bytes ? size - stats.max_allocated_bytes : 0);
	}
#endif
}

int diag_format(const struct diag_values *values, char *buf, size_t len)
{
	const char *mac = is_mac_text(values->mac) ? values->mac : "unknown";
	/* Letters and digits only (device_id_valid), so it can go into the JSON as it is. */
	bool has_id = values->id[0] != '\0' && device_id_valid(values->id);
	int written = snprintf(buf, len,
			       "{\"diag\":{%s%s%s\"mac\":\"%s\",\"channel\":%u,"
			       "\"heap\":{\"free\":%u,\"least\":%u,\"size\":%u}}}",
			       has_id ? "\"id\":\"" : "", has_id ? values->id : "", has_id ? "\"," : "",
			       mac, values->channel, (unsigned int)values->heap_free,
			       (unsigned int)values->heap_least, (unsigned int)values->heap_size);

	return (written < 0 || (size_t)written >= len) ? -ENOSPC : written;
}
