/*
 * Diagnostics for the console: what changes slowly and the heartbeat does not carry. It goes into
 * the device shadow as its own report, when the board reaches the cloud and every
 * CONFIG_APP_DIAG_INTERVAL_SECONDS after:
 *
 *   {"diag":{"mac":"f4:ce:36:12:34:56","channel":6,"heap":{"free":21312,"least":9840,"size":44240}}}
 *
 * mac is the Wi-Fi interface's address, for networks that admit devices by address. channel is the
 * Wi-Fi channel, 0 when not associated. heap is the system heap: what is free now, the least it has
 * been since the board started, and its size, in bytes. Nothing here is secret, and nothing names
 * the network.
 */

#ifndef DIAG_H_
#define DIAG_H_

#include <stddef.h>
#include <stdint.h>

struct diag_values {
	char mac[18];
	unsigned int channel;
	uint32_t heap_free;
	uint32_t heap_least;
	uint32_t heap_size;
};

/* Fill in what can be read now; what cannot is left as "unknown" or 0. */
void diag_collect(struct diag_values *values);

/* The report as JSON, for cloud_shadow_report(). Returns its length, or a negative error. */
int diag_format(const struct diag_values *values, char *buf, size_t len);

#endif /* DIAG_H_ */
