/*
 * The two LEDs and the two buttons.
 *
 * LED1 shows what the security domain is doing. From 1.8.0, LED2 is driven here too: it
 * lights only when the board is online, taking turns with LED1. Before 1.8.0 it belonged
 * to the network core. From 1.13.0 the console's identify command blinks both for a while.
 */

#ifndef UI_H_
#define UI_H_

#include <stdbool.h>

enum ui_state {
	/* Long flash every two seconds: factory mode, waiting for INIT. */
	UI_FACTORY,
	/* Short flash every two seconds: set up, but not provisioned yet. */
	UI_UNPROVISIONED,
	/* Slow blink: joining Wi-Fi. */
	UI_NETWORK_CONNECTING,
	/* Medium blink: Wi-Fi is up, connecting to the cloud. */
	UI_CLOUD_CONNECTING,
	/* LED1 and LED2 take turns, a quarter of a second each: connected, nothing to do. */
	UI_ONLINE,
	/* Fast blink: an update is waiting for a button press. */
	UI_UPDATE_OFFERED,
	/* Double flash: downloading or checking an update. */
	UI_UPDATE_IN_PROGRESS,
	/* Triple flash: a new image is running on trial. */
	UI_UPDATE_TESTING,
#if defined(CONFIG_APP_BT_OTA)
	/* Four flashes: Bluetooth is open, and no phone is linked yet. */
	UI_BT_WINDOW,
#endif
};

/* One step of identify: both LEDs on for one, off for the next, which is a blink at 5 Hz. */
#define UI_IDENTIFY_STEP_MS 100

int ui_init(void);
void ui_set_state(enum ui_state state);

/*
 * From 1.13.0, the console's identify command: LED1 and LED2 blink together, on and off every
 * UI_IDENTIFY_STEP_MS, for this many seconds, and then show the state again as it is by then. The
 * state goes on being kept meanwhile. Another call starts the time again. 0 ends it at once.
 */
void ui_identify(unsigned int seconds);

/*
 * From 1.17.0, for the hardware self-test (selftest.c): while held, the state's pattern stops driving
 * the LEDs, and ui_leds_set() lights them as asked. Release when done; the pattern takes up at its next step.
 */
void ui_leds_hold(bool hold);
void ui_leds_set(bool led1, bool led2);

#endif /* UI_H_ */
