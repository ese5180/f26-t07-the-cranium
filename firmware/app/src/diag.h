/*
 * Diagnostics for the console: what changes slowly and the heartbeat does not carry. It goes into
 * the device shadow as its own report, when the board reaches the cloud and every
 * CONFIG_APP_DIAG_INTERVAL_SECONDS after:
 *
 *   {"diag":{"id":"CRVIHAAN01","mac":"f4:ce:36:12:34:56","channel":6,"heap":{"free":21312,"least":9840,"size":44240},"board":"nrf7002dk","layout":1}}
 *
 * id is the board's own device ID, which a person sets with INIT or SET_ID (from 1.11.4; left out when
 * there is none), and which the console shows as the board's name: the thing name stays its AWS
 * identity. It is also sent as soon as it changes. mac is the Wi-Fi interface's address, for networks that admit devices by address. channel is the
 * Wi-Fi channel, 0 when not associated. heap is the system heap: what is free now, the least it has
 * been since the board started, and its size, in bytes. board and layout, from 1.13.0, are the
 * board type and the flash layout number (CONFIG_APP_BOARD_TYPE, CONFIG_APP_IMAGE_LAYOUT,
 * docs/fleet.md), the same as its image carries. Nothing here is secret, and nothing names the
 * network.
 *
 * From 1.19.3, on a board with golden image promotion (CONFIG_APP_GOLDEN_PROMOTE), the same report
 * also says which image is golden, next to "diag": "golden":{"version":"1.19.2+0","counter":1,
 * "state":"sealed"} (src/ota/golden_promote.h).
 */

#ifndef DIAG_H_
#define DIAG_H_

#include <stddef.h>
#include <stdint.h>

#include "device.h"

/* The longest board type that goes into the report: lower-case letters and digits. */
#define DIAG_BOARD_MAX 16
/* What main.c holds the report in: the longest, with every number at its largest, fits. */
#define DIAG_REPORT_MAX 336
/* The "golden" member, as golden_promote_report() writes it: empty on a board without it. */
#define DIAG_GOLDEN_MAX 96

struct diag_values {
	char id[DEVICE_ID_MAX + 1];
	char mac[18];
	unsigned int channel;
	uint32_t heap_free;
	uint32_t heap_least;
	uint32_t heap_size;
	char board[DIAG_BOARD_MAX + 1];
	uint32_t layout;
	char golden[DIAG_GOLDEN_MAX];
};

/* Fill in what can be read now; what cannot is left as "unknown" or 0. */
void diag_collect(struct diag_values *values);

/* The report as JSON, for cloud_shadow_report(). Returns its length, or a negative error. */
int diag_format(const struct diag_values *values, char *buf, size_t len);

#endif /* DIAG_H_ */
