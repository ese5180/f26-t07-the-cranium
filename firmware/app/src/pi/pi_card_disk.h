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

/*
 * The same lock as pi_card_lock(), for a reader that must not wait long (the heartbeat): 0 with it
 * taken, or a negative errno when another thread still holds it after wait_ms. pi_card_unlock()
 * gives it back.
 */
int pi_card_disk_lock_within(int32_t wait_ms);

#endif /* PI_CARD_DISK_H_ */
