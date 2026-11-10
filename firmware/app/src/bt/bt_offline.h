/*
 * Offline Bluetooth mode, behind CONFIG_APP_BT_OFFLINE (from 1.19.0): a phone talks to the board
 * directly when there is no Wi-Fi and no cloud.
 *
 * A GATT service of its own (policy/bt_offline_policy.h has the bytes) with
 *   - a status characteristic, read-only: firmware version, uptime, Wi-Fi, cloud, update state and why
 *     the board last restarted; and
 *   - a control point with one write, "accept the waiting update", which installs an image that a
 *     phone sent over Bluetooth and that waits, as the install button would.
 * Both need an authenticated, encrypted link: LE Secure Connections with the board's own passkey
 * (src/bt/bt_passkey.h). The link lasts as long as the connection: nothing is bonded, because the
 * board keeps no bonds (bt_ota.conf), so a phone pairs again each time a person opens a window with
 * Button 1.
 *
 * The passkey is drawn on the board, by BT_OFFLINE|NEW over the serial console, shown once in the reply
 * and kept in protected storage; nothing prints or sends it again.
 */

#ifndef BT_OFFLINE_H_
#define BT_OFFLINE_H_

#include <stdbool.h>
#include <stdint.h>

/* Once a second, on the main loop: refresh what a phone reads, and carry out an accepted write. */
void bt_offline_on_tick(void);

/*
 * On the main loop, with no window open: draw a new passkey and name, store them, and give the
 * passkey in *passkey for the one reply that shows it. The caller wipes it. -EBUSY with a window open.
 */
int bt_offline_new_passkey(uint32_t *passkey, uint16_t *tag);

#endif /* BT_OFFLINE_H_ */
