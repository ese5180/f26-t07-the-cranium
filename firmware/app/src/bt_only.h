/*
 * A board with Bluetooth and no Wi-Fi, with CONFIG_APP_BT_ONLY: the nRF5340 DK. See "The nRF5340 DK
 * (Bluetooth only)" in firmware/README.md.
 *
 *   bt_only_main.c   the main loop, in place of main.c
 *   bt_only_ota.c    the update manager, in place of ota.c: the trial and Bluetooth, no jobs
 *   bt_only_leds.c   LED3 and LED4, which the nRF7002 DK does not have
 *   bt_only_stubs.c  what the shared code asks of Wi-Fi and the cloud, answered with "there is none"
 *
 * The LEDs, all four, as this board shows them:
 *
 *   LED1, LED2  ui.c, with the patterns of the nRF7002 DK where its states exist here:
 *               a long flash every 2 s     factory mode, waiting for INIT
 *               a short flash every 2 s    set up, but no passkey of its own: a phone cannot pair
 *                                          without the serial console (provision it)
 *               LED1 and LED2 taking turns ready: nothing to do, a window can be opened
 *               four short flashes         Bluetooth is open, and no phone is paired yet
 *               double flash               a phone is paired
 *               fast blink                 an image has arrived: Button 1 installs it, Button 2 erases it
 *               triple flash               a new image is running on trial: a person has to prove it
 *   LED3        the phone: on while one is connected, blinking fast while an image arrives
 *   LED4        trouble: on for 30 s after something went wrong (bt_ota_take_trouble())
 *
 * While the bootloader swaps an image in, which takes about a minute and a half, every LED is dark.
 */

#ifndef BT_ONLY_H_
#define BT_ONLY_H_

#include "bt_ota.h"

/* How long LED4 stays on after something went wrong. */
#define BT_ONLY_TROUBLE_SECONDS 30

int bt_only_leds_init(void);

/* What LED3 shows. */
void bt_only_leds_link(enum bt_ota_link_view view);

/* Light LED4 for BT_ONLY_TROUBLE_SECONDS, from now. */
void bt_only_leds_trouble(void);

/* Once a second, on the main loop: count LED4's time down. */
void bt_only_leds_tick(void);

#endif /* BT_ONLY_H_ */
