/*
 * The board's own account of an update over Bluetooth, for a phone: one characteristic, read and
 * notify, in a small GATT service of its own. From 1.14.0. A phone reads it without pairing, because
 * nothing in it is secret: never the passkey, never a key, nothing that names the board or its
 * network. Only versions, counts, seconds and states, all of which the person at the board can see on
 * its console as well. Anything that writes still takes the authenticated link it took before: the
 * SMP characteristic, whose permission and hooks are unchanged (src/bt_ota.c).
 *
 * The board is only connectable while a window is open (Button 1 held), and for 2 minutes after the
 * restart that an update over Bluetooth asked for, so a phone that sent an image can come back and
 * see how it went. See "The status characteristic" in docs/mobile-apps.md.
 *
 * This file and bt_status.c have no Bluetooth in them, so that the payload is tested on a host.
 */

#ifndef BT_STATUS_H_
#define BT_STATUS_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "version.h"

/*
 * 9112B1B4-2A51-40F0-94D3-A76440F0E6CC, the service, and 9112B1B5-..., its characteristic, as the
 * bytes go on the air: least significant first. The phones scan for the service after a restart.
 */
#define BT_STATUS_SERVICE_UUID_VAL                                                                 \
	0xcc, 0xe6, 0xf0, 0x40, 0x64, 0xa7, 0xd3, 0x94, 0xf0, 0x40, 0x51, 0x2a, 0xb4, 0xb1, 0x12, 0x91
#define BT_STATUS_CHAR_UUID_VAL                                                                    \
	0xcc, 0xe6, 0xf0, 0x40, 0x64, 0xa7, 0xd3, 0x94, 0xf0, 0x40, 0x51, 0x2a, 0xb5, 0xb1, 0x12, 0x91

/* What the first byte says. A phone that knows another number reads nothing else. */
#define BT_STATUS_FORMAT 1
/* Every payload of format 1 is this long. A notification needs an ATT MTU of at least 67. */
#define BT_STATUS_LEN    64

/* The window, as bt_ota.c has it. */
enum bt_status_window {
	BT_STATUS_WINDOW_CLOSED = 0,
	/* Advertising for an upload, or a phone is connected that has not paired yet. */
	BT_STATUS_WINDOW_OPEN = 1,
	/* An authenticated link. */
	BT_STATUS_WINDOW_LINKED = 2,
	/* A whole image has arrived and waits for a button: the seconds are the offer's. */
	BT_STATUS_WINDOW_OFFER = 3,
	/* After a restart that a Bluetooth update asked for: status only, no pairing, no uploads. */
	BT_STATUS_WINDOW_STATUS = 4,
};

/* The image of this window. */
enum bt_status_image {
	BT_STATUS_IMAGE_NONE = 0,
	/* Pieces are arriving: the bytes so far, and the version from the first piece. */
	BT_STATUS_IMAGE_RECEIVING = 1,
	/* All of it is in the secondary slot, and the board has yet to look at it. */
	BT_STATUS_IMAGE_RECEIVED = 2,
	/* Looked at, and offered to the person at the board. */
	BT_STATUS_IMAGE_VERIFIED = 3,
	/* Refused: the reason says why. An upload refused at its start can be followed by another. */
	BT_STATUS_IMAGE_REFUSED = 4,
};

/*
 * Why an image was refused. The bootloader checks the signature only at the restart: an image that it
 * does not take shows up after it as the last update's outcome, not_installed.
 */
enum bt_status_refusal {
	BT_STATUS_REFUSAL_NONE = 0,
	/* Not newer than what runs. */
	BT_STATUS_REFUSAL_OLDER = 1,
	BT_STATUS_REFUSAL_NOT_IMAGE_0 = 2,
	BT_STATUS_REFUSAL_NO_HEADER = 3,
	/* It would reach the trailer at the end of the slot. */
	BT_STATUS_REFUSAL_TOO_LARGE = 4,
	/* Its header claims more than the file holds. */
	BT_STATUS_REFUSAL_BAD_SIZES = 5,
	BT_STATUS_REFUSAL_INCOMPATIBLE_BOARD = 6,
	BT_STATUS_REFUSAL_INCOMPATIBLE_LAYOUT = 7,
	/* Its signed metadata is malformed, or what arrived cannot be read back. */
	BT_STATUS_REFUSAL_MALFORMED = 8,
	/* The bootloader has a swap to do already. */
	BT_STATUS_REFUSAL_SWAP_PENDING = 9,
	/* The record or the swap request could not be written. */
	BT_STATUS_REFUSAL_CANNOT_INSTALL = 10,
};

/* How the window ended. */
enum bt_status_result {
	BT_STATUS_RESULT_NONE = 0,
	/* Button 1: recorded, a trial swap asked for, and the board restarts. */
	BT_STATUS_RESULT_INSTALLING = 1,
	/* Button 2. */
	BT_STATUS_RESULT_DISCARDED = 2,
	/* Nobody pressed a button in the 2 minutes of an offer, or the window's time ran out. */
	BT_STATUS_RESULT_TIMED_OUT = 3,
	/* Anything else: the closing reason says what. */
	BT_STATUS_RESULT_CLOSED = 4,
};

/* What the bootloader is to do at the next restart, from the trailer of the primary slot. */
enum bt_status_swap {
	BT_STATUS_SWAP_NONE = 0,
	BT_STATUS_SWAP_TEST = 1,
	BT_STATUS_SWAP_PERMANENT = 2,
	/* The image that runs is on trial: the old one comes back unless it is confirmed. */
	BT_STATUS_SWAP_REVERT = 3,
	BT_STATUS_SWAP_FAIL = 4,
};

enum bt_status_via {
	BT_STATUS_VIA_NONE = 0,
	BT_STATUS_VIA_BLUETOOTH = 1,
	/* A cloud job, over Wi-Fi. */
	BT_STATUS_VIA_WIFI = 2,
};

/* The last update's outcome, as the board recorded it. */
enum bt_status_outcome {
	BT_STATUS_OUTCOME_NONE = 0,
	/* On trial, or about to be. */
	BT_STATUS_OUTCOME_PENDING = 1,
	BT_STATUS_OUTCOME_KEPT = 2,
	BT_STATUS_OUTCOME_ROLLED_BACK = 3,
	BT_STATUS_OUTCOME_NOT_INSTALLED = 4,
	BT_STATUS_OUTCOME_TRIAL_LOST = 5,
	/* A cloud job installed something else after this one. */
	BT_STATUS_OUTCOME_SUPERSEDED = 6,
	BT_STATUS_OUTCOME_FLASH_ERROR = 7,
	BT_STATUS_OUTCOME_INCOMPATIBLE_BOARD = 8,
	BT_STATUS_OUTCOME_INCOMPATIBLE_LAYOUT = 9,
	/* A cloud update that failed in another way. */
	BT_STATUS_OUTCOME_FAILED = 10,
};

/* Who kept it: as enum bt_ota_proof_by. */
enum bt_status_proof {
	BT_STATUS_PROOF_NONE = 0,
	BT_STATUS_PROOF_CLOUD = 1,
	BT_STATUS_PROOF_PERSON = 2,
};

#define BT_STATUS_HASH_LEN 8

struct bt_status {
	enum bt_status_window window;
	/* Of the window, of the offer while one waits, or of the advertising after a restart. */
	uint16_t seconds_left;
	enum bt_status_image image;
	enum bt_status_refusal refusal;
	/* So far while receiving, and then the image's size. */
	uint32_t image_bytes;
	/* From the image's header, once the first piece has arrived. */
	struct fw_version image_version;
	enum bt_status_result result;
	/* enum bt_ota_closed + 1 once the window has closed, and 0 before. */
	uint8_t closed;

	struct fw_version running;
	bool on_trial;
	enum bt_status_swap swap;

	enum bt_status_via last_via;
	enum bt_status_outcome last_outcome;
	enum bt_status_proof last_proof;
	struct fw_version last_target;
	struct fw_version last_from;
	/* The first bytes of the image's SHA-256, of an update over Bluetooth only. */
	uint8_t last_hash[BT_STATUS_HASH_LEN];
	/* Of updates over Bluetooth on this board, the last one included. */
	uint16_t last_count;

	uint32_t uptime_seconds;
};

/*
 * Format 1, least significant byte first:
 *
 *    0  format (1)          18  result            32  last update: target version
 *    1  window              19  closed reason     40  last update: from version
 *    2  seconds left (2)    20  running version   48  last update: hash (8)
 *    4  image               28  flags: bit 0 on   56  last update: count (2)
 *    5  refusal                 trial, bits 1-3   58  uptime in seconds (4)
 *    6  image bytes (4)         the swap          62  reserved, 0 (2)
 *   10  image version       29  last update: via
 *                           30  last update: outcome
 *                           31  last update: proof
 *
 * A version is 8 bytes: major, minor, revision (2), build (4).
 */
void bt_status_encode(const struct bt_status *status, uint8_t out[BT_STATUS_LEN]);

/*
 * The two payloads say something different, beyond what counts down or up by itself: the seconds
 * left, the bytes received and the uptime. A change like that alone is told less often.
 */
bool bt_status_news(const uint8_t a[BT_STATUS_LEN], const uint8_t b[BT_STATUS_LEN]);

#endif /* BT_STATUS_H_ */
