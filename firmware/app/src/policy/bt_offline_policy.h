/*
 * The offline Bluetooth mode, as bytes and decisions, with no Bluetooth and no storage in it: what a
 * phone reads of the board's state when there is no Wi-Fi and no cloud, the one thing it may write
 * (accept the update that waits), and how the board's own passkey is drawn. src/bt/bt_offline.c does
 * the Bluetooth, and firmware/tests/host runs this. From 1.19.0.
 *
 * The status is read-only and needs an encrypted, authenticated link (the passkey). Nothing in it is
 * secret from the person at the board, but it says how the board is connected, so it is not offered
 * to a phone that has not paired.
 */

#ifndef BT_OFFLINE_POLICY_H_
#define BT_OFFLINE_POLICY_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * 9112B1B6-2A51-40F0-94D3-A76440F0E6CC, the service, ...B7 the status and ...B8 the control point,
 * as the bytes go on the air: least significant first.
 */
#define BT_OFFLINE_SERVICE_UUID_VAL                                                                \
	0xcc, 0xe6, 0xf0, 0x40, 0x64, 0xa7, 0xd3, 0x94, 0xf0, 0x40, 0x51, 0x2a, 0xb6, 0xb1, 0x12, 0x91
#define BT_OFFLINE_STATUS_UUID_VAL                                                                 \
	0xcc, 0xe6, 0xf0, 0x40, 0x64, 0xa7, 0xd3, 0x94, 0xf0, 0x40, 0x51, 0x2a, 0xb7, 0xb1, 0x12, 0x91
#define BT_OFFLINE_CONTROL_UUID_VAL                                                                \
	0xcc, 0xe6, 0xf0, 0x40, 0x64, 0xa7, 0xd3, 0x94, 0xf0, 0x40, 0x51, 0x2a, 0xb8, 0xb1, 0x12, 0x91

#define BT_OFFLINE_FORMAT 1
#define BT_OFFLINE_LEN    20

enum bt_offline_wifi {
	/* No Wi-Fi on this board. */
	BT_OFFLINE_WIFI_NONE = 0,
	BT_OFFLINE_WIFI_DOWN = 1,
	BT_OFFLINE_WIFI_UP = 2,
};

enum bt_offline_cloud {
	/* No cloud on this board. */
	BT_OFFLINE_CLOUD_NONE = 0,
	BT_OFFLINE_CLOUD_DOWN = 1,
	BT_OFFLINE_CLOUD_UP = 2,
};

enum bt_offline_update {
	BT_OFFLINE_UPDATE_IDLE = 0,
	/* A cloud update is on offer and waits for a button. */
	BT_OFFLINE_UPDATE_CLOUD_OFFER = 1,
	/* A cloud update is downloading, installing or being checked. */
	BT_OFFLINE_UPDATE_CLOUD_BUSY = 2,
	/* The running image is on trial. */
	BT_OFFLINE_UPDATE_TRIAL = 3,
	/* An image sent over Bluetooth is complete and waits: a phone may accept it. */
	BT_OFFLINE_UPDATE_BT_WAITING = 4,
	/* An image is arriving over Bluetooth. */
	BT_OFFLINE_UPDATE_BT_RECEIVING = 5,
};

struct bt_offline_version {
	uint8_t major;
	uint8_t minor;
	uint16_t revision;
	uint32_t build;
};

struct bt_offline_status {
	struct bt_offline_version running;
	enum bt_offline_wifi wifi;
	enum bt_offline_cloud cloud;
	enum bt_offline_update update;
	/* enum reset_kind (reset_cause.h); 0xff when it is not known. */
	uint8_t reboot;
	uint32_t uptime_seconds;
	/* While an update waits: the version a phone is asked to confirm. */
	struct bt_offline_version waiting;
};

/*
 * Format 1, least significant byte first, 20 bytes:
 *    0 format (1)   1 Wi-Fi   2 cloud   3 update   4 reboot reason   5 reserved (0)
 *    6 running version: major, minor, revision (2), build (4), ending at 13
 *   14 uptime in seconds (4)
 *   18 the waiting update's major, 19 its minor; 0 unless the update state is 4
 * An update that waits is named by its major and minor only, which is what a person is shown. The
 * accept is checked against those two numbers and nothing more (bt_offline_accept_check): two waiting
 * images of the same major and minor, differing in revision or build, are not told apart here. The
 * image itself was checked for board, layout and version when it arrived, and its signature is
 * checked by the bootloader.
 */
void bt_offline_encode(const struct bt_offline_status *status, uint8_t out[BT_OFFLINE_LEN]);

/* The control point takes one write: [BT_OFFLINE_OP_ACCEPT, major, minor]. Nothing else is a command. */
#define BT_OFFLINE_OP_ACCEPT  0x01
#define BT_OFFLINE_ACCEPT_LEN 3

enum bt_offline_verdict {
	BT_OFFLINE_ACCEPT_OK = 0,
	/* Not three bytes, or another opcode. */
	BT_OFFLINE_ACCEPT_MALFORMED,
	/* No update waits: nothing to accept. */
	BT_OFFLINE_ACCEPT_NOTHING_WAITING,
	/* The person was shown another version than the one that waits now. */
	BT_OFFLINE_ACCEPT_VERSION_MISMATCH,
};

enum bt_offline_verdict bt_offline_accept_check(const uint8_t *data, size_t len, bool update_waiting,
						const struct bt_offline_version *waiting);

/*
 * A passkey from random 32-bit words drawn from the board's entropy source: the first word below
 * 4,294,000,000 that, modulo 1,000,000, is not a weak pattern (bt_passkey_weak). The tag for the
 * name, four hex digits, is the low 16 bits of the word after it. False if every word is refused,
 * which the caller answers by drawing again. The caller wipes the words.
 */
bool bt_offline_passkey_from_random(const uint32_t *words, size_t n, uint32_t *passkey, uint16_t *tag);

#endif /* BT_OFFLINE_POLICY_H_ */
