/*
 * The SD card of a Raspberry Pi delta update on a board: Zephyr's disk access to the "SD" disk
 * (the zephyr,sdmmc-disk on the SD host over SPI, boards/pi_delta.overlay), the card-detect pin,
 * and a lock that the update and the Pi's link share (pi_card.h).
 */

#ifndef PI_CARD_DISK_H_
#define PI_CARD_DISK_H_

#include "pi_card.h"

extern const struct pi_disk_ops pi_card_disk_ops;

/* Sets up the card-detect pin. 0, or a negative errno. */
int pi_card_disk_init(void);

#endif /* PI_CARD_DISK_H_ */
