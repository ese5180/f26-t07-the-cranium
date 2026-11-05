/*
 * A board's own Bluetooth passkey, with CONFIG_APP_BT_STATIC_PASSKEY: the nRF5340 DK, which has
 * Bluetooth only.
 *
 * On an nRF7002 DK the Bluetooth host draws a new passkey for every attempt, the console shows it, and
 * a board that is online also puts it into its device shadow for 150 s, where a release manager's phone
 * reads it. A board with no cloud has no shadow, and nobody need be at its serial port, so the phone
 * could never learn the passkey. So this board keeps one:
 *
 *   - tools/provision_device.py --board nrf5340dk draws a 6-digit passkey at random and four hex digits
 *     for the name, registers both with the console for this thing, and sends them with BT_PASSKEY.
 *     The board keeps them in TF-M's protected storage, encrypted with a key derived from the
 *     hardware unique key, as the other secrets of a board are. Nothing reads the passkey back out:
 *     the console says only "set", and it is never printed or sent anywhere.
 *   - It advertises as Cranium- and those four digits in every window, so that the phone knows which
 *     board it has found before it pairs, and asks the console's pairing route for that name.
 *   - The Bluetooth host is handed this passkey for LE Secure Connections pairing with MITM protection
 *     (CONFIG_BT_APP_PASSKEY), with everything else as before: a person holds Button 1 for a window,
 *     no bonds, three failed pairings close the window.
 *   - Each pairing that fails on the passkey counts, in storage and across restarts. After
 *     CONFIG_APP_BT_PASSKEY_FAILURE_BUDGET of them (3) it is locked: the board goes back to a new
 *     passkey for each attempt, on the console, until a new one is stored.
 *
 * What this costs, against a new passkey for each attempt:
 *
 *   - A passkey that does not change can be learnt over the air. LE Secure Connections' passkey entry
 *     commits to the passkey one bit at a time, and reveals the nonces of each round as it goes, so
 *     anyone who records a whole pairing, with a sniffer in range during a window, can work all 20 bits
 *     out afterwards. A fresh passkey is worthless by then. This one is good for the next window, in
 *     which that person can then pair as the phone could, or sit in the middle of the phone's pairing.
 *   - An active attacker in range during a window can guess. A guess that fails gives away the bit it
 *     failed on, and every bit it got right before that: two bits on average. With a new passkey each
 *     time that is worth nothing, and three guesses pair with a chance of 0.0003%. Here the bits add
 *     up, so the failures are counted across windows and restarts, and 3 of them lock the passkey: an
 *     attacker who keeps guessing from the start pairs before that with a chance of 0.02%. With a budget
 *     of 6 it would be 2%.
 *   - The console holds a copy, so whoever can read the console's pairing route, a release manager, can
 *     pair with any of these boards whenever a person has opened a window on it. Each read is logged.
 *
 * What does not change: no window opens without a person holding Button 1 for 5 s, and it closes after
 * 3 minutes; nothing but a newer image signed with this project's key can be uploaded; nothing is
 * installed without a second press of Button 1; the image runs on trial and reverts unless a person
 * proves it; no bond is kept. A passkey that got out lets someone in range during a window upload a
 * signed newer image, which a person then has to choose to install, or read the board's status. Store
 * a new one (provision_device.py --board nrf5340dk --new-passkey) whenever that may have happened:
 * after a pairing near people with radios, or when STATUS|bluetooth shows failures nobody explains.
 */

#ifndef BT_PASSKEY_H_
#define BT_PASSKEY_H_

#include <stdbool.h>
#include <stdint.h>

#include "bt_passkey_policy.h"

enum bt_passkey_state {
	/* None stored: the Bluetooth host draws one for each attempt, and the console shows it. */
	BT_PASSKEY_STATE_NONE,
	BT_PASSKEY_STATE_SET,
	/* Stored, and it has failed CONFIG_APP_BT_PASSKEY_FAILURE_BUDGET times: as NONE until a new one. */
	BT_PASSKEY_STATE_LOCKED,
	/* Protected storage did not answer, or holds something this firmware did not write: as NONE. */
	BT_PASSKEY_STATE_UNREADABLE,
};

/* At boot, on the main loop: read what is stored. The passkey itself does not stay in memory. */
void bt_passkey_init(void);

enum bt_passkey_state bt_passkey_state(void);
const char *bt_passkey_state_name(enum bt_passkey_state state);

/* Failed pairings with the stored passkey since it was stored, written or not yet. */
uint32_t bt_passkey_failures(void);

/*
 * The four hex digits of the name to advertise, while the stored passkey can be used. Otherwise, with none
 * stored or locked, a new name each window: the console knows no passkey for it.
 */
bool bt_passkey_tag(uint16_t *tag);

/*
 * The main loop's, as a window opens and closes: the passkey is read out of storage for the window, and
 * wiped from memory when it closes. Open before the window lets anything in, close after it has shut.
 */
void bt_passkey_window_open(void);
void bt_passkey_window_close(void);

/*
 * On a Bluetooth thread, as a pairing needs its passkey: the stored one, or BT_PASSKEY_NONE for one
 * the host draws. window_failures: the failed pairings of this window so far.
 */
uint32_t bt_passkey_for_pairing(uint32_t window_failures);

/* On a Bluetooth thread: a pairing with the stored passkey failed on the passkey. Never waits. */
void bt_passkey_count_failure(void);

/*
 * The main loop's, once a second: write a count that has changed. Returns true once, when the passkey
 * has just been locked by it.
 */
bool bt_passkey_persist(void);

/* The main loop's, with no window open: store a new passkey and name, with no failures. */
int bt_passkey_store(uint32_t passkey, uint16_t tag);

/* The main loop's: erase it. A factory reset does this. Erasing what is not there is no error. */
int bt_passkey_erase(void);

#endif /* BT_PASSKEY_H_ */
