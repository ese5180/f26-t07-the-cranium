/*
 * The two LEDs and the two buttons.
 *
 * LED1 shows what the security domain is doing. From 1.8.0, LED2 is driven here too: it
 * lights only when the board is online, taking turns with LED1. Before 1.8.0 it belonged
 * to the network core.
 */

#ifndef UI_H_
#define UI_H_

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

int ui_init(void);
void ui_set_state(enum ui_state state);

#endif /* UI_H_ */
