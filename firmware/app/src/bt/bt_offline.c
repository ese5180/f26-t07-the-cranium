#include "bt_offline.h"

#include <errno.h>
#include <string.h>

#include <zephyr/bluetooth/att.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/kernel.h>
#include <zephyr/random/random.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/util.h>

#include "bt_offline_policy.h"
#include "bt_ota.h"
#include "bt_passkey.h"
#include "ota.h"
#include "reset_cause.h"
#include "version.h"
#if !defined(CONFIG_APP_BT_ONLY)
#include "cloud.h"
#include "net.h"
#endif

/*
 * What a phone reads and what its write is checked against, copied by the main loop under the lock and
 * read by the Bluetooth host's thread. Nothing else is shared with it but the accept flag.
 */
static struct k_spinlock lock;
static uint8_t payload[BT_OFFLINE_LEN];
static bool waiting;
static struct bt_offline_version waiting_version;
static atomic_t accept_pending;

static ssize_t read_status(struct bt_conn *conn, const struct bt_gatt_attr *attr, void *buf,
			   uint16_t len, uint16_t offset)
{
	uint8_t copy[BT_OFFLINE_LEN];
	k_spinlock_key_t key = k_spin_lock(&lock);

	memcpy(copy, payload, sizeof(copy));
	k_spin_unlock(&lock, key);
	return bt_gatt_attr_read(conn, attr, buf, len, offset, copy, sizeof(copy));
}

/* On the Bluetooth host's thread. The link is authenticated already: the attribute's permission says so. */
static ssize_t write_control(struct bt_conn *conn, const struct bt_gatt_attr *attr, const void *buf,
			     uint16_t len, uint16_t offset, uint8_t flags)
{
	struct bt_offline_version version;
	bool is_waiting;
	k_spinlock_key_t key;

	ARG_UNUSED(conn);
	ARG_UNUSED(attr);
	ARG_UNUSED(flags);

	if (offset != 0) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_OFFSET);
	}

	key = k_spin_lock(&lock);
	is_waiting = waiting;
	version = waiting_version;
	k_spin_unlock(&lock, key);

	switch (bt_offline_accept_check(buf, len, is_waiting, &version)) {
	case BT_OFFLINE_ACCEPT_OK:
		(void)atomic_set(&accept_pending, 1);
		return len;
	case BT_OFFLINE_ACCEPT_MALFORMED:
		return BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
	default:
		/* Nothing waits, or not the version the phone was showing: the phone reads and asks again. */
		return BT_GATT_ERR(BT_ATT_ERR_UNLIKELY);
	}
}

/*
 * Both attributes need encryption with an authenticated key: a link that paired with the passkey (LE
 * Secure Connections, MITM). Without it the host answers the phone itself and these functions do not run.
 */
BT_GATT_SERVICE_DEFINE(offline_service,
	BT_GATT_PRIMARY_SERVICE(BT_UUID_DECLARE_128(BT_OFFLINE_SERVICE_UUID_VAL)),
	BT_GATT_CHARACTERISTIC(BT_UUID_DECLARE_128(BT_OFFLINE_STATUS_UUID_VAL), BT_GATT_CHRC_READ,
			       BT_GATT_PERM_READ_AUTHEN, read_status, NULL, NULL),
	BT_GATT_CHARACTERISTIC(BT_UUID_DECLARE_128(BT_OFFLINE_CONTROL_UUID_VAL), BT_GATT_CHRC_WRITE,
			       BT_GATT_PERM_WRITE_AUTHEN, NULL, write_control, NULL),
);

static struct bt_offline_version to_offline(const struct fw_version *version)
{
	return (struct bt_offline_version){ version->major, version->minor, version->revision,
					    version->build };
}

static enum bt_offline_update update_state(int upload)
{
	if (upload == BT_OTA_UPLOAD_WAITING) {
		return BT_OFFLINE_UPDATE_BT_WAITING;
	}

	if (upload == BT_OTA_UPLOAD_RECEIVING) {
		return BT_OFFLINE_UPDATE_BT_RECEIVING;
	}

	switch (ota_state()) {
	case OTA_AWAITING_USER:
		return BT_OFFLINE_UPDATE_CLOUD_OFFER;
	case OTA_TESTING:
		return BT_OFFLINE_UPDATE_TRIAL;
	case OTA_RETRY_WAIT:
	case OTA_REFRESHING:
	case OTA_STARTING:
	case OTA_DOWNLOADING:
	case OTA_VERIFYING:
	case OTA_COMMITTING:
	case OTA_REBOOTING:
		return BT_OFFLINE_UPDATE_CLOUD_BUSY;
	default:
		return BT_OFFLINE_UPDATE_IDLE;
	}
}

void bt_offline_on_tick(void)
{
	struct bt_offline_status status = { 0 };
	struct fw_version image = { 0 };
	k_spinlock_key_t key;
	int upload = bt_ota_upload_view(&image);

	/* A write that was checked on the Bluetooth thread, and is done here, where the window lives. */
	if (atomic_set(&accept_pending, 0) != 0) {
		(void)bt_ota_accept_offer();
		upload = bt_ota_upload_view(&image);
	}

	status.running = to_offline(fw_version_running());
	status.update = update_state(upload);
	status.reboot = (uint8_t)reset_cause_kind(reset_cause_get());
	status.uptime_seconds = (uint32_t)(k_uptime_get() / MSEC_PER_SEC);
	if (upload == BT_OTA_UPLOAD_WAITING) {
		status.waiting = to_offline(&image);
	}
#if !defined(CONFIG_APP_BT_ONLY)
	status.wifi = net_is_up() ? BT_OFFLINE_WIFI_UP : BT_OFFLINE_WIFI_DOWN;
	status.cloud = cloud_is_connected() ? BT_OFFLINE_CLOUD_UP : BT_OFFLINE_CLOUD_DOWN;
#endif

	key = k_spin_lock(&lock);
	bt_offline_encode(&status, payload);
	waiting = upload == BT_OTA_UPLOAD_WAITING;
	waiting_version = status.waiting;
	k_spin_unlock(&lock, key);
}

int bt_offline_new_passkey(uint32_t *passkey, uint16_t *tag)
{
	uint32_t words[8];
	int err = -EIO;

	if (bt_ota_is_open()) {
		return -EBUSY;
	}

	for (int attempt = 0; attempt < 4 && err != 0; attempt++) {
		if (sys_csrand_get(words, sizeof(words)) != 0) {
			err = -EIO;
			continue;
		}

		err = bt_offline_passkey_from_random(words, ARRAY_SIZE(words), passkey, tag) ? 0 : -EAGAIN;
	}

	memset(words, 0, sizeof(words));
	if (err != 0) {
		return err;
	}

	return bt_passkey_store(*passkey, *tag);
}
