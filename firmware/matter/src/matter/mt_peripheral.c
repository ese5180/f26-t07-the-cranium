/*
 * See mt_peripheral.h. Everything after the radio runs on one work queue.
 */
#include "mt_peripheral.h"

#include <errno.h>
#include <string.h>

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "mt_btp.h"
#include "mt_crypto.h"
#include "mt_dev_im.h"
#include "mt_msg.h"
#include "mt_node.h"
#include "mt_pase_msg.h"
#include "mt_tlv.h"

LOG_MODULE_REGISTER(mt_periph, LOG_LEVEL_INF);

#define MSG_MAX 1280
#define ADVERTISE_S (15 * 60)

static struct bt_uuid_128 c1_uuid = BT_UUID_INIT_128(0x11, 0x9D, 0x9F, 0x42, 0x9C, 0x4F, 0x9F, 0x95, 0x59, 0x45,
						     0x3D, 0x26, 0xF5, 0x2E, 0xEE, 0x18);
static struct bt_uuid_128 c2_uuid = BT_UUID_INIT_128(0x12, 0x9D, 0x9F, 0x42, 0x9C, 0x4F, 0x9F, 0x95, 0x59, 0x45,
						     0x3D, 0x26, 0xF5, 0x2E, 0xEE, 0x18);

static struct bt_conn *conn;
static bool subscribed;
static bool advertising;
static struct mt_btp btp;
static bool btp_up;

static K_THREAD_STACK_DEFINE(wq_stack, 6144);
static struct k_work_q wq;
static bool wq_started;

struct rx_pkt {
	uint16_t len;
	uint8_t data[247];
};
K_MSGQ_DEFINE(periph_rx_q, sizeof(struct rx_pkt), 4, 4);
static struct k_work rx_work;
static struct k_work indicated_work;
static struct k_work_delayable adv_stop_work;

/* outgoing message, indicated one BTP packet at a time */
static uint8_t tx_msg[MSG_MAX];
static size_t tx_len;
static size_t tx_off;
static bool tx_busy;
static struct bt_gatt_indicate_params ind;
static uint8_t ind_buf[247];

/* the PASE session */
static enum { P_NONE, P_PBKDF, P_PAKE1, P_PAKE3, P_SESSION } pase;
static uint8_t pbkdf_req[100];
static size_t pbkdf_req_len;
static uint8_t pbkdf_resp[150];
static size_t pbkdf_resp_len;
static struct mt_spake spake;
static uint16_t peer_sid;
static uint16_t local_sid;
static uint64_t peer_ephemeral;
static uint32_t counter;
static uint32_t unsecured_counter;
static psa_key_id_t key_i2r = PSA_KEY_ID_NULL;
static psa_key_id_t key_r2i = PSA_KEY_ID_NULL;
static uint8_t challenge[16];
static struct mt_counter_window peer_counters;

static ssize_t c1_write(struct bt_conn *c, const struct bt_gatt_attr *attr, const void *buf, uint16_t len,
			uint16_t offset, uint8_t flags);
static void c2_ccc(const struct bt_gatt_attr *attr, uint16_t value);

BT_GATT_SERVICE_DEFINE(chipoble_svc,
	BT_GATT_PRIMARY_SERVICE(BT_UUID_DECLARE_16(0xFFF6)),
	BT_GATT_CHARACTERISTIC(&c1_uuid.uuid, BT_GATT_CHRC_WRITE, BT_GATT_PERM_WRITE, NULL, c1_write, NULL),
	BT_GATT_CHARACTERISTIC(&c2_uuid.uuid, BT_GATT_CHRC_INDICATE, BT_GATT_PERM_NONE, NULL, NULL, NULL),
	BT_GATT_CCC(c2_ccc, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

static void destroy_session(void)
{
	mt_spake_abort(&spake);
	if (key_i2r != PSA_KEY_ID_NULL) {
		psa_destroy_key(key_i2r);
		key_i2r = PSA_KEY_ID_NULL;
	}
	if (key_r2i != PSA_KEY_ID_NULL) {
		psa_destroy_key(key_r2i);
		key_r2i = PSA_KEY_ID_NULL;
	}
	pase = P_NONE;
	btp_up = false;
	subscribed = false;
	tx_busy = false;
}

static void on_indicated(struct bt_conn *c, struct bt_gatt_indicate_params *params, uint8_t err)
{
	ARG_UNUSED(c);
	ARG_UNUSED(params);
	ARG_UNUSED(err);
	k_work_submit_to_queue(&wq, &indicated_work);
}

static void send_next(void)
{
	if (tx_off >= tx_len || conn == NULL) {
		tx_busy = false;
		return;
	}
	size_t n = mt_btp_segment(&btp, tx_msg, tx_len, &tx_off, ind_buf);

	memset(&ind, 0, sizeof(ind));
	ind.attr = &chipoble_svc.attrs[4];
	ind.data = ind_buf;
	ind.len = (uint16_t)n;
	ind.func = on_indicated;
	if (bt_gatt_indicate(conn, &ind) != 0) {
		tx_busy = false;
	}
}

static void indicate_raw(const uint8_t *data, size_t len)
{
	memcpy(ind_buf, data, len);
	memset(&ind, 0, sizeof(ind));
	ind.attr = &chipoble_svc.attrs[4];
	ind.data = ind_buf;
	ind.len = (uint16_t)len;
	(void)bt_gatt_indicate(conn, &ind);
}

static int send(bool secure, uint16_t exchange, uint16_t protocol, uint8_t opcode, const uint8_t *body, size_t len,
		uint32_t ack)
{
	struct mt_msg_header h = {0};
	struct mt_proto_header p = {0};
	size_t n;

	if (tx_busy) {
		return -EBUSY;
	}
	if (secure) {
		h.session_id = peer_sid;
		h.counter = counter++;
	} else {
		h.counter = unsecured_counter++;
		h.has_dest = true;
		h.dest_node = peer_ephemeral;
	}
	n = mt_msg_encode_header(&h, tx_msg, sizeof(tx_msg));
	size_t hdr = n;

	p.opcode = opcode;
	p.exchange_id = exchange;
	p.protocol_id = protocol;
	p.has_ack = false; /* BTP is reliable: no MRP over Bluetooth */
	(void)ack;
	n += mt_msg_encode_proto(&p, &tx_msg[n], sizeof(tx_msg) - n);
	if (n + len + MT_MIC_LEN > sizeof(tx_msg)) {
		return -EMSGSIZE;
	}
	memcpy(&tx_msg[n], body, len);
	n += len;
	if (secure) {
		uint8_t nonce[MT_NONCE_LEN];
		int err;

		mt_msg_nonce(&h, 0, nonce);
		err = mt_ccm_encrypt(key_r2i, nonce, tx_msg, hdr, &tx_msg[hdr], n - hdr, &tx_msg[n]);
		if (err) {
			return err;
		}
		n += MT_MIC_LEN;
	}
	tx_len = n;
	tx_off = 0;
	tx_busy = true;
	send_next();
	return 0;
}

static void pase_fail(uint16_t exchange)
{
	uint8_t sr[8];

	LOG_WRN("PASE failed");
	(void)send(false, exchange, MT_PROTO_SECURE_CHANNEL, MT_SC_STATUS_REPORT, sr,
		   mt_status_report(sr, 1, 0, 2), 0);
	mt_spake_abort(&spake);
	pase = P_NONE;
}

static void pase_in(uint8_t opcode, const uint8_t *body, size_t len, uint16_t exchange)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;

	if (opcode == MT_SC_PBKDF_REQ) {
		struct mt_tlv_writer w;
		uint8_t random[32];
		const uint8_t *their_random = NULL;

		mt_tlv_reader_init(&r, body, len);
		if (len > sizeof(pbkdf_req) || !mt_tlv_next(&r, &e)) {
			return;
		}
		while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
			if (e.context && e.tag == 1 && e.type == MT_TLV_BYTES && e.len == 32) {
				their_random = e.data;
			} else if (e.context && e.tag == 2 && e.type == MT_TLV_UINT) {
				peer_sid = (uint16_t)e.v.u;
			} else if (e.type == MT_TLV_STRUCT) {
				(void)mt_tlv_skip_container(&r);
			}
		}
		if (their_random == NULL) {
			return;
		}
		memcpy(pbkdf_req, body, len);
		pbkdf_req_len = len;
		(void)mt_random(random, sizeof(random));
		(void)mt_random((uint8_t *)&local_sid, sizeof(local_sid));
		local_sid |= 1;
		mt_tlv_writer_init(&w, pbkdf_resp, sizeof(pbkdf_resp));
		mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
		mt_tlv_put_bytes(&w, 1, their_random, 32);
		mt_tlv_put_bytes(&w, 2, random, 32);
		mt_tlv_put_uint(&w, 3, local_sid);
		mt_tlv_start(&w, 4, MT_TLV_STRUCT);
		mt_tlv_put_uint(&w, 1, MT_NODE_PBKDF_ITER);
		mt_tlv_put_bytes(&w, 2, mt_node_salt(), 32);
		mt_tlv_end(&w);
		mt_tlv_end(&w);
		int n = mt_tlv_finish(&w);

		if (n < 0) {
			return;
		}
		pbkdf_resp_len = (size_t)n;
		pase = P_PAKE1;
		(void)send(false, exchange, MT_PROTO_SECURE_CHANNEL, MT_SC_PBKDF_RESP, pbkdf_resp, pbkdf_resp_len, 0);
	} else if (opcode == MT_SC_PAKE1 && pase == P_PAKE1) {
		uint8_t context[32];
		static const char prefix[] = "CHIP PAKE V1 Commissioning";
		const uint8_t *parts[] = {(const uint8_t *)prefix, pbkdf_req, pbkdf_resp};
		size_t lens[] = {sizeof(prefix) - 1, pbkdf_req_len, pbkdf_resp_len};
		uint8_t pb[65];
		uint8_t cb[32];
		uint8_t out[120];
		struct mt_tlv_writer w;

		mt_tlv_reader_init(&r, body, len);
		if (!mt_tlv_next(&r, &e) || !mt_tlv_find(&r, 1, &e) || e.type != MT_TLV_BYTES || e.len != 65 ||
		    mt_sha256(parts, lens, 3, context) != 0 ||
		    mt_spake_begin_verifier(&spake, mt_node_verifier(), context) != 0 ||
		    mt_spake_verifier_round(&spake, e.data, pb, cb) != 0) {
			pase_fail(exchange);
			return;
		}
		mt_tlv_writer_init(&w, out, sizeof(out));
		mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
		mt_tlv_put_bytes(&w, 1, pb, 65);
		mt_tlv_put_bytes(&w, 2, cb, 32);
		mt_tlv_end(&w);
		pase = P_PAKE3;
		(void)send(false, exchange, MT_PROTO_SECURE_CHANNEL, MT_SC_PAKE2, out, (size_t)mt_tlv_finish(&w), 0);
	} else if (opcode == MT_SC_PAKE3 && pase == P_PAKE3) {
		psa_key_id_t shared = PSA_KEY_ID_NULL;
		uint8_t keys[48];
		uint8_t sr[8];
		static const uint8_t info[] = "SessionKeys";

		mt_tlv_reader_init(&r, body, len);
		if (!mt_tlv_next(&r, &e) || !mt_tlv_find(&r, 1, &e) || e.type != MT_TLV_BYTES || e.len != 32 ||
		    mt_spake_verifier_confirm(&spake, e.data, &shared) != 0 ||
		    mt_hkdf_from_key(shared, NULL, 0, info, sizeof(info) - 1, keys, sizeof(keys)) != 0 ||
		    mt_ccm_import(&keys[0], &key_i2r) != 0 || mt_ccm_import(&keys[16], &key_r2i) != 0) {
			psa_destroy_key(shared);
			pase_fail(exchange);
			return;
		}
		psa_destroy_key(shared);
		memcpy(challenge, &keys[32], 16);
		memset(keys, 0, sizeof(keys));
		(void)mt_random((uint8_t *)&counter, sizeof(counter));
		counter = (counter & 0x0FFFFFFFu) + 1;
		memset(&peer_counters, 0, sizeof(peer_counters));
		pase = P_SESSION;
		LOG_INF("PASE session up with the phone");
		(void)send(false, exchange, MT_PROTO_SECURE_CHANNEL, MT_SC_STATUS_REPORT, sr, mt_status_report(sr, 0, 0, 0),
			   0);
	}
}

static void rx_handler(struct k_work *w)
{
	struct rx_pkt pkt;
	static uint8_t out[MSG_MAX];

	ARG_UNUSED(w);
	while (k_msgq_get(&periph_rx_q, &pkt, K_NO_WAIT) == 0) {
		if (!btp_up) {
			uint16_t mtu;
			uint8_t win;
			uint8_t resp[6];

			if (!mt_btp_parse_handshake_request(pkt.data, pkt.len, &mtu, &win)) {
				continue;
			}
			uint16_t att = bt_gatt_get_mtu(conn);

			mt_btp_server_accept(&btp, resp, MIN(mtu, att), MIN(win, 4));
			btp_up = true;
			indicate_raw(resp, sizeof(resp));
			continue;
		}
		enum mt_btp_rx rr = mt_btp_receive(&btp, pkt.data, pkt.len);

		if (rr == MT_BTP_RX_ERROR) {
			LOG_WRN("BTP error: closing");
			bt_conn_disconnect(conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
			return;
		}
		if (rr != MT_BTP_RX_MESSAGE) {
			continue;
		}
		struct mt_msg_header h;
		struct mt_proto_header p;
		uint8_t *msg = btp.rx_buf;
		size_t len = btp.rx_len;
		size_t hdr = mt_msg_decode_header(msg, len, &h);

		if (hdr == 0) {
			continue;
		}
		if (h.session_id != 0) {
			uint8_t nonce[MT_NONCE_LEN];

			if (pase != P_SESSION || h.session_id != local_sid || len < hdr + MT_MIC_LEN) {
				continue;
			}
			mt_msg_nonce(&h, 0, nonce);
			if (mt_ccm_decrypt(key_i2r, nonce, msg, hdr, &msg[hdr], len - hdr - MT_MIC_LEN,
					   &msg[len - MT_MIC_LEN]) != 0 ||
			    !mt_counter_accept(&peer_counters, h.counter)) {
				continue;
			}
			len -= MT_MIC_LEN;
		} else if (h.has_source) {
			peer_ephemeral = h.source_node;
		}
		size_t ph = mt_msg_decode_proto(&msg[hdr], len - hdr, &p);

		if (ph == 0) {
			continue;
		}
		const uint8_t *body = &msg[hdr + ph];
		size_t blen = len - hdr - ph;

		if (h.session_id == 0 && p.protocol_id == MT_PROTO_SECURE_CHANNEL) {
			pase_in(p.opcode, body, blen, p.exchange_id);
		} else if (h.session_id != 0 && p.protocol_id == MT_PROTO_IM) {
			struct mt_dev_session s = {
				.pase = true, .challenge = challenge,
				.fabric_index = mt_node_fabric()->present ? MT_NODE_FABRIC_INDEX : 0,
			};
			uint8_t op;
			int n = mt_dev_im(&s, p.opcode, body, blen, &op, out, sizeof(out) - 64);

			if (n >= 0) {
				(void)send(true, p.exchange_id, MT_PROTO_IM, op, out, (size_t)n, h.counter);
			}
		}
	}
}

static void indicated_handler(struct k_work *w)
{
	ARG_UNUSED(w);
	if (tx_busy) {
		send_next();
	}
}

static ssize_t c1_write(struct bt_conn *c, const struct bt_gatt_attr *attr, const void *buf, uint16_t len,
			uint16_t offset, uint8_t flags)
{
	struct rx_pkt pkt;

	ARG_UNUSED(attr);
	ARG_UNUSED(flags);
	if (c != conn || offset != 0 || len > sizeof(pkt.data)) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
	}
	pkt.len = len;
	memcpy(pkt.data, buf, len);
	if (k_msgq_put(&periph_rx_q, &pkt, K_NO_WAIT) != 0) {
		return BT_GATT_ERR(BT_ATT_ERR_PREPARE_QUEUE_FULL);
	}
	k_work_submit_to_queue(&wq, &rx_work);
	return len;
}

static void c2_ccc(const struct bt_gatt_attr *attr, uint16_t value)
{
	ARG_UNUSED(attr);
	subscribed = value == BT_GATT_CCC_INDICATE;
}

static void on_connected(struct bt_conn *c, uint8_t err)
{
	struct bt_conn_info info;

	if (err || bt_conn_get_info(c, &info) != 0 || info.role != BT_CONN_ROLE_PERIPHERAL || conn != NULL ||
	    !advertising) {
		return;
	}
	conn = bt_conn_ref(c);
	advertising = false;
	LOG_INF("a phone connected for commissioning");
}

static void on_disconnected(struct bt_conn *c, uint8_t reason)
{
	ARG_UNUSED(reason);
	if (c != conn) {
		return;
	}
	bt_conn_unref(conn);
	conn = NULL;
	destroy_session();
	k_msgq_purge(&periph_rx_q);
	/* still not commissioned: advertise again */
	if (mt_node_commissionable()) {
		(void)mt_peripheral_open();
	}
}

BT_CONN_CB_DEFINE(mt_periph_conn_cb) = {
	.connected = on_connected,
	.disconnected = on_disconnected,
};

static void adv_stop(struct k_work *w)
{
	ARG_UNUSED(w);
	mt_peripheral_close();
	LOG_INF("commissioning window closed: matter open to open it again");
}

int mt_peripheral_open(void)
{
	static uint8_t svc_data[10];
	int err;

	if (!wq_started) {
		k_work_queue_init(&wq);
		k_work_queue_start(&wq, wq_stack, K_THREAD_STACK_SIZEOF(wq_stack), K_PRIO_PREEMPT(8), NULL);
		k_work_init(&rx_work, rx_handler);
		k_work_init(&indicated_work, indicated_handler);
		k_work_init_delayable(&adv_stop_work, adv_stop);
		wq_started = true;
	}
	if (conn) {
		return -EBUSY;
	}
	if (mt_node_init() != 0) {
		return -EIO;
	}
	/* service data: UUID 0xFFF6, opcode 0, discriminator and version, vendor, product, flags */
	svc_data[0] = 0xF6;
	svc_data[1] = 0xFF;
	svc_data[2] = 0x00;
	svc_data[3] = (uint8_t)MT_NODE_DISCRIMINATOR;
	svc_data[4] = (uint8_t)((MT_NODE_DISCRIMINATOR >> 8) & 0x0F);
	svc_data[5] = (uint8_t)MT_NODE_VENDOR_ID;
	svc_data[6] = (uint8_t)(MT_NODE_VENDOR_ID >> 8);
	svc_data[7] = (uint8_t)MT_NODE_PRODUCT_ID;
	svc_data[8] = (uint8_t)(MT_NODE_PRODUCT_ID >> 8);
	svc_data[9] = 0;
	const struct bt_data ad[] = {
		BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
		BT_DATA(BT_DATA_SVC_DATA16, svc_data, sizeof(svc_data)),
	};
	err = bt_le_adv_start(BT_LE_ADV_PARAM(BT_LE_ADV_OPT_CONN, BT_GAP_ADV_FAST_INT_MIN_2,
					      BT_GAP_ADV_FAST_INT_MAX_2, NULL),
			      ad, ARRAY_SIZE(ad), NULL, 0);
	if (err == 0 || err == -EALREADY) {
		advertising = true;
		k_work_reschedule_for_queue(&wq, &adv_stop_work, K_SECONDS(ADVERTISE_S));
		LOG_INF("commissionable over Bluetooth for %d minutes (discriminator %u)", ADVERTISE_S / 60,
			MT_NODE_DISCRIMINATOR);
		return 0;
	}
	return err;
}

void mt_peripheral_close(void)
{
	(void)bt_le_adv_stop();
	advertising = false;
}

bool mt_peripheral_advertising(void)
{
	return advertising;
}
