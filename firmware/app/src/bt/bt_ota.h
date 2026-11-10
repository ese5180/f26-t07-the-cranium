/*
 * Firmware update over Bluetooth LE, behind CONFIG_APP_BT_OTA.
 *
 * Bluetooth is off until a person holds Button 1 for five seconds and lets go. That opens a
 * window of limited time: the board advertises, a phone connects and pairs with the passkey
 * that comes out on the console, and it can upload an image to the secondary slot over
 * MCUmgr. The image is then offered, as a cloud update is: Button 1 asks the bootloader for a
 * trial swap and restarts, and Button 2 erases it. The bootloader checks the signature, and the
 * image stays on trial. See "Firmware update over Bluetooth" in firmware/README.md.
 *
 * All functions run on the main loop, unless they say otherwise.
 */

#ifndef BT_OTA_H_
#define BT_OTA_H_

#include <stdbool.h>
#include <stdint.h>

#include "bt_ota_policy.h"
#include "ui.h"
#include "version.h"

/* Called by ota_init(), which knows what the bootloader did. job_record: see ota_bt_has_job(). */
void bt_ota_on_boot(bool on_trial, bool has_trailer, bool job_record);

/*
 * A button was let go. Returns true if that was for this module, and nothing else should act
 * on it. physical: a real press of a real button, which a command on the console is not.
 */
bool bt_ota_on_button(uint8_t button, bool long_press, bool physical);

void bt_ota_on_tick(void);

/* The image on trial has been confirmed because it reached the cloud. */
void bt_ota_on_cloud_proof(void);

#if !defined(CONFIG_APP_BT_ONLY)
/* Connected to the cloud: tell it about the last update over Bluetooth. */
void bt_ota_on_cloud_up(void);
#endif

/*
 * Offline mode (src/bt/bt_offline.c), from 1.19.0. Whether an image from a phone is arriving or has
 * arrived and waits for the person's go-ahead; for a waiting one, its version.
 */
#define BT_OTA_UPLOAD_NONE      0
#define BT_OTA_UPLOAD_RECEIVING 1
#define BT_OTA_UPLOAD_WAITING   2
int bt_ota_upload_view(struct fw_version *version);

/*
 * What a press of the install button does, for a phone that has proved the passkey: true if an image
 * was waiting and the install has been asked for. The main loop's only.
 */
bool bt_ota_accept_offer(void);

bool bt_ota_is_open(void);
enum ui_state bt_ota_ui_state(void);

#if defined(CONFIG_APP_BT_ONLY)
/* What a phone is doing, as of the last tick: for the LEDs of a board with Bluetooth only. */
enum bt_ota_link_view {
	BT_OTA_LINK_NONE,
	/* A phone is connected, pairing or paired. */
	BT_OTA_LINK_CONNECTED,
	/* Commands came in the last second, in a window that takes an image: it is arriving. */
	BT_OTA_LINK_RECEIVING,
};

enum bt_ota_link_view bt_ota_link_view(void);

/*
 * True once after something went wrong that a person at the board should see: a pairing that failed,
 * a command or an upload refused, an image that arrived and cannot be installed, a controller that did
 * not start, a passkey that got locked, or a record at boot that says the last update did not stay.
 */
bool bt_ota_take_trouble(void);
#endif /* CONFIG_APP_BT_ONLY */

#endif /* BT_OTA_H_ */
