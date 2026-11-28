/*
 * What a board's own Bluetooth passkey may be, and when it is used, with no Bluetooth and no storage in
 * it. With CONFIG_APP_BT_STATIC_PASSKEY, on a board with Bluetooth only. src/bt/bt_passkey.h has the
 * reasons, and src/bt/bt_passkey.c does what these functions decide. No side effects and no hardware
 * dependencies, so firmware/tests/host runs it.
 */

#ifndef BT_PASSKEY_POLICY_H_
#define BT_PASSKEY_POLICY_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define BT_PASSKEY_DIGITS     6
#define BT_PASSKEY_MAX        999999U
#define BT_PASSKEY_TAG_DIGITS 4
/* What the Bluetooth host takes as "draw one yourself": BT_PASSKEY_RAND. bt_ota.c checks that. */
#define BT_PASSKEY_NONE       0xffffffffU

#define BT_PASSKEY_RECORD_MAGIC 0x42545031U /* "BTP1" */

/*
 * What TF-M's protected storage keeps. One record of one size: see store_read(). The passkey is the
 * only secret in it, and it never leaves the board but to the Bluetooth host.
 */
struct bt_passkey_record {
	uint32_t magic;
	uint32_t passkey;
	/* The four hexadecimal digits of the name it advertises: Cranium-3F9C. */
	uint16_t tag;
	uint16_t reserved;
	/* Pairings with it that failed on the passkey, since it was stored, across restarts. */
	uint32_t failures;
};

/*
 * Exactly six decimal digits that are not a pattern a person would pick: six of the same digit, or
 * a run up or down, such as 123456 or 987654. tools/provision_device.py draws one at random and leaves
 * those out too, so a passkey that comes this way was typed in by somebody.
 */
bool bt_passkey_parse(const char *text, uint32_t *passkey);
bool bt_passkey_weak(uint32_t passkey);

/* Exactly four hexadecimal digits, in either case: the part of the name after "Cranium-". */
bool bt_passkey_parse_tag(const char *text, uint16_t *tag);

/* A record that this firmware wrote: its magic, a passkey in range, and not weak. */
bool bt_passkey_record_valid(const struct bt_passkey_record *record);

/* The stored passkey has failed this often, and is not used any more until a new one is stored. */
bool bt_passkey_locked(uint32_t failures, uint32_t budget);

/*
 * The passkey for the next pairing: the stored one, or BT_PASSKEY_NONE for one that the Bluetooth host
 * draws and the console shows. record is NULL if none is stored or it could not be read. failures is
 * the count that includes what has not been written yet, window_failures what this window has had of
 * any kind, and window_max what closes a window (BT_OTA_MAX_FAILED_PAIRINGS).
 */
uint32_t bt_passkey_choose(const struct bt_passkey_record *record, uint32_t failures,
			   uint32_t budget, uint32_t window_failures, uint32_t window_max);

/* "Cranium-3F9C" for tag 0x3f9c and prefix "Cranium". Returns the length, or -ENOSPC. */
int bt_passkey_name(uint16_t tag, const char *prefix, char *buf, size_t len);

#endif /* BT_PASSKEY_POLICY_H_ */
