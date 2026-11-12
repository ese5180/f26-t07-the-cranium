/*
 * See mt_ble.h. Lessons from the earlier commissioner, kept here: GATT discovery ends with attr == NULL, which is
 * not a match and must not be treated as one; stop the scan before creating the connection; one write in flight.
 */
#include "mt_ble.h"

#include <errno.h>
#include <string.h>

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(mt_ble, LOG_LEVEL_INF);

#define CHIPOBLE_UUID 0xFFF6
static struct bt_uuid_16 svc_uuid = BT_UUID_INIT_16(CHIPOBLE_UUID);
/* C1 18EE2EF5-263D-4559-959F-4F9C429F9D11, C2 ...9D12 */
static struct bt_uuid_128 c1_uuid = BT_UUID_INIT_128(0x11, 0x9D, 0x9F, 0x42, 0x9C, 0x4F, 0x9F, 0x95, 0x59, 0x45,
						     0x3D, 0x26, 0xF5, 0x2E, 0xEE, 0x18);
static struct bt_uuid_128 c2_uuid = BT_UUID_INIT_128(0x12, 0x9D, 0x9F, 0x42, 0x9C, 0x4F, 0x9F, 0x95, 0x59, 0x45,
						     0x3D, 0x26, 0xF5, 0x2E, 0xEE, 0x18);

static const struct mt_ble_callbacks *cbs;
static struct bt_conn *conn;
static uint16_t want_disc;
static bool want_short;
static uint16_t svc_end;
static uint16_t c1_handle;
static uint16_t c2_handle;
static struct bt_gatt_discover_params disc;
static struct bt_gatt_subscribe_params sub;
static struct bt_gatt_exchange_params mtu_params;
static struct bt_gatt_write_params wr;
static uint8_t wr_buf[247];
static struct k_work_delayable scan_timeout;
static bool scanning;

static void finish(int reason)
{
	if (scanning) {
		bt_le_scan_stop();
		scanning = false;
	}
	k_work_cancel_delayable(&scan_timeout);
	if (conn) {
		bt_conn_disconnect(conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
		bt_conn_unref(conn);
		conn = NULL;
	}
	if (cbs && cbs->closed) {
		const struct mt_ble_callbacks *c = cbs;

		cbs = NULL;
		c->closed(reason);
	}
}

static void timeout_work(struct k_work *w)
{
	ARG_UNUSED(w);
	LOG_WRN("no commissionable device with that discriminator");
	finish(-ETIMEDOUT);
}

static uint8_t on_indicate(struct bt_conn *c, struct bt_gatt_subscribe_params *p, const void *data, uint16_t len)
{
	ARG_UNUSED(c);
	if (data == NULL) {
		p->value_handle = 0;
		return BT_GATT_ITER_STOP;
	}
	if (cbs && cbs->received) {
		cbs->received(data, len);
	}
	return BT_GATT_ITER_CONTINUE;
}

static void on_subscribed(struct bt_conn *c, uint8_t err, struct bt_gatt_subscribe_params *p)
{
	ARG_UNUSED(p);
	if (err) {
		LOG_ERR("subscribe to C2 failed: %u", err);
		finish(-EIO);
		return;
	}
	if (cbs && cbs->ready) {
		cbs->ready(bt_gatt_get_mtu(c));
	}
}

static uint8_t on_discover(struct bt_conn *c, const struct bt_gatt_attr *attr, struct bt_gatt_discover_params *p)
{
	if (attr == NULL) {
		/* The end of this discovery step, which is not a match. */
		if (p->type == BT_GATT_DISCOVER_PRIMARY) {
			LOG_ERR("no CHIPoBLE service");
			finish(-ENOENT);
		} else if (c1_handle == 0 || c2_handle == 0) {
			LOG_ERR("CHIPoBLE characteristics missing");
			finish(-ENOENT);
		}
		return BT_GATT_ITER_STOP;
	}
	if (p->type == BT_GATT_DISCOVER_PRIMARY) {
		const struct bt_gatt_service_val *svc = attr->user_data;

		svc_end = svc->end_handle;
		p->uuid = NULL;
		p->start_handle = attr->handle + 1;
		p->end_handle = svc_end;
		p->type = BT_GATT_DISCOVER_CHARACTERISTIC;
		if (bt_gatt_discover(c, p) != 0) {
			finish(-EIO);
		}
		return BT_GATT_ITER_STOP;
	}
	if (p->type == BT_GATT_DISCOVER_CHARACTERISTIC) {
		const struct bt_gatt_chrc *ch = attr->user_data;

		if (bt_uuid_cmp(ch->uuid, &c1_uuid.uuid) == 0) {
			c1_handle = ch->value_handle;
		} else if (bt_uuid_cmp(ch->uuid, &c2_uuid.uuid) == 0) {
			c2_handle = ch->value_handle;
		}
		if (c1_handle && c2_handle) {
			memset(&sub, 0, sizeof(sub));
			sub.notify = on_indicate;
			sub.subscribe = on_subscribed;
			sub.value = BT_GATT_CCC_INDICATE;
			sub.value_handle = c2_handle;
			sub.ccc_handle = 0; /* found by the stack */
			sub.end_handle = svc_end;
			sub.disc_params = &disc;
			if (bt_gatt_subscribe(c, &sub) != 0) {
				finish(-EIO);
			}
			return BT_GATT_ITER_STOP;
		}
		return BT_GATT_ITER_CONTINUE;
	}
	return BT_GATT_ITER_STOP;
}

static void on_mtu(struct bt_conn *c, uint8_t err, struct bt_gatt_exchange_params *p)
{
	ARG_UNUSED(p);
	if (err) {
		LOG_WRN("MTU exchange failed (%u): BTP runs on the default", err);
	}
	memset(&disc, 0, sizeof(disc));
	disc.uuid = &svc_uuid.uuid;
	disc.func = on_discover;
	disc.start_handle = BT_ATT_FIRST_ATTRIBUTE_HANDLE;
	disc.end_handle = BT_ATT_LAST_ATTRIBUTE_HANDLE;
	disc.type = BT_GATT_DISCOVER_PRIMARY;
	if (bt_gatt_discover(c, &disc) != 0) {
		finish(-EIO);
	}
}

static void connected(struct bt_conn *c, uint8_t err)
{
	if (c != conn) {
		return;
	}
	if (err) {
		LOG_ERR("connection failed: %u", err);
		bt_conn_unref(conn);
		conn = NULL;
		finish(-ECONNREFUSED);
		return;
	}
	mtu_params.func = on_mtu;
	if (bt_gatt_exchange_mtu(c, &mtu_params) != 0) {
		on_mtu(c, 1, &mtu_params);
	}
}

static void disconnected(struct bt_conn *c, uint8_t reason)
{
	if (c != conn) {
		return;
	}
	LOG_INF("device disconnected (%u)", reason);
	bt_conn_unref(conn);
	conn = NULL;
	finish(-ECONNRESET);
}

BT_CONN_CB_DEFINE(mt_ble_conn_cb) = {
	.connected = connected,
	.disconnected = disconnected,
};

struct adv_match {
	bool found;
};

static bool adv_field(struct bt_data *d, void *user)
{
	struct adv_match *m = user;
	uint16_t disc;
	uint16_t vid;
	uint16_t pid;

	if (d->type != BT_DATA_SVC_DATA16 || d->data_len < 2) {
		return true;
	}
	if ((d->data[0] | (d->data[1] << 8)) != CHIPOBLE_UUID) {
		return true;
	}
	if (!mt_ble_parse_service_data(&d->data[2], d->data_len - 2, &disc, &vid, &pid)) {
		return true;
	}
	m->found = want_short ? (disc >> 8) == (want_disc & 0x0Fu) : disc == want_disc;
	return !m->found;
}

static void scan_cb(const bt_addr_le_t *addr, int8_t rssi, uint8_t type, struct net_buf_simple *ad)
{
	struct adv_match m = {false};

	ARG_UNUSED(rssi);
	if (!scanning || conn || (type != BT_GAP_ADV_TYPE_ADV_IND && type != BT_GAP_ADV_TYPE_ADV_SCAN_IND &&
				  type != BT_GAP_ADV_TYPE_EXT_ADV)) {
		return;
	}
	bt_data_parse(ad, adv_field, &m);
	if (!m.found) {
		return;
	}
	bt_le_scan_stop();
	scanning = false;
	k_work_cancel_delayable(&scan_timeout);
	c1_handle = 0;
	c2_handle = 0;
	if (bt_conn_le_create(addr, BT_CONN_LE_CREATE_CONN, BT_LE_CONN_PARAM_DEFAULT, &conn) != 0) {
		LOG_ERR("could not connect to the device");
		finish(-EIO);
	}
}

int mt_ble_connect(uint16_t discriminator, bool is_short, uint32_t timeout_ms, const struct mt_ble_callbacks *cb)
{
	static bool init;

	if (cbs != NULL) {
		return -EBUSY;
	}
	if (!init) {
		k_work_init_delayable(&scan_timeout, timeout_work);
		init = true;
	}
	cbs = cb;
	want_disc = discriminator;
	want_short = is_short;
	int err = bt_le_scan_start(BT_LE_SCAN_ACTIVE, scan_cb);

	if (err) {
		cbs = NULL;
		return err;
	}
	scanning = true;
	k_work_schedule(&scan_timeout, K_MSEC(timeout_ms));
	return 0;
}

static void on_written(struct bt_conn *c, uint8_t err, struct bt_gatt_write_params *p)
{
	ARG_UNUSED(c);
	ARG_UNUSED(p);
	if (cbs && cbs->written) {
		cbs->written(err ? -EIO : 0);
	}
}

int mt_ble_write(const uint8_t *pkt, size_t len)
{
	if (conn == NULL || c1_handle == 0 || len > sizeof(wr_buf)) {
		return -ENOTCONN;
	}
	memcpy(wr_buf, pkt, len);
	wr.func = on_written;
	wr.handle = c1_handle;
	wr.offset = 0;
	wr.data = wr_buf;
	wr.length = (uint16_t)len;
	return bt_gatt_write(conn, &wr);
}

void mt_ble_close(void)
{
	finish(0);
}
