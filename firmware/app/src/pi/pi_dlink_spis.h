/*
 * The Pi's SPI link on a board, for Raspberry Pi delta updates: SPIS3 as the target on the Arduino
 * SPI pins and READY on D9, the pins and frames of the Pi's message link (PR #58,
 * docs/pi-delta-update.md, "Wiring"). Each transfer goes to pi_dlink.c on a work queue of its own,
 * so that a read from the SD card never holds up the system work queue.
 */

#ifndef PI_DLINK_SPIS_H_
#define PI_DLINK_SPIS_H_

#include <stdbool.h>
#include <stdint.h>

#include "pi_card.h"

struct pi_dlink_spis_view {
	bool running;
	int error;
	uint32_t answered;
	uint32_t errors;
	uint32_t bad_frames;
	uint32_t polls;
};

/* Starts the link on that card. 0, or a negative errno. */
int pi_dlink_spis_start(struct pi_card *card);

void pi_dlink_spis_view(struct pi_dlink_spis_view *view);

#endif /* PI_DLINK_SPIS_H_ */
