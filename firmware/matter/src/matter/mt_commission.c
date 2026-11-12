/*
 * See mt_commission.h. Everything runs on one work queue: Bluetooth callbacks copy what they get and hand it over.
 */
#include "mt_commission.h"

#include <errno.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "matter_policy.h"
#include "mt_ble.h"
#include "mt_btp.h"
#include "mt_crypto.h"
#include "mt_im.h"
#include "mt_msg.h"
#include "mt_pase_msg.h"
#include "mt_tlv.h"
#include "ot_leader.h"

LOG_MODULE_REGISTER(mt_commission, LOG_LEVEL_INF);

#define MSG_MAX 1280
#define BTP_WINDOW 4

static K_THREAD_STACK_DEFINE(wq_stack, 6144);
static struct k_work_q wq;
static struct k_work rx_work;
static struct k_work ready_work;
static struct k_work written_work;
static struct k_work closed_work;

static enum mt_stage stage = MT_STAGE_IDLE;
static struct mp_manual_code code;
static uint16_t fail_safe_s;
static uint16_t att_mtu;
static struct mt_btp btp;
static bool handshaken;

/* Packets from the radio, copied for the work queue. */
struct rx_pkt {
	uint16_t len;
	uint8_t data[247];
};
K_MSGQ_DEFINE(rx_q, sizeof(struct rx_pkt), 4, 4);

/* The message on its way out, cut into BTP packets one write at a time. */
static uint8_t tx_msg[MSG_MAX];
static size_t tx_len;
static size_t tx_off;
static bool tx_busy;

/* The message layer */
static uint64_t ephemeral_node;
static uint32_t unsecured_counter;
static uint16_t exchange_id;
static uint16_t local_session_id;
static uint16_t peer_session_id;
static bool secure;
static uint32_t secure_counter;
static psa_key_id_t key_i2r;
static psa_key_id_t key_r2i;
static struct mt_counter_window peer_counters;

/* PASE */
static uint8_t pase_random[MT_PASE_RANDOM_LEN];
static uint8_t pbkdf_req[64];
static size_t pbkdf_req_len;
static struct mt_spake spake;

static void fail(const char *why, int err)
{
	LOG_ERR("commissioning failed at %s: %s (%d)", mt_stage_name(stage), why, err);
	stage = MT_STAGE_FAILED;
	mt_ble_close();
}

static void destroy_keys(void)
{
	if (key_i2r != PSA_KEY_ID_NULL) {
		psa_destroy_key(key_i2r);
		key_i2r = PSA_KEY_ID_NULL;
	}
	if (key_r2i != PSA_KEY_ID_NULL) {
		psa_destroy_key(key_r2i);
		key_r2i = PSA_KEY_ID_NULL;
	}
}

static void send_next_packet(void)
{
	uint8_t pkt[247];

	if (tx_off >= tx_len) {
		tx_busy = false;
		return;
	}
	size_t n = mt_btp_segment(&btp, tx_msg, tx_len, &tx_off, pkt);
	int err = mt_ble_write(pkt, n);

	if (err) {
		fail("write", err);
	}
}

/* Builds and sends a message: protocol header and body, encrypted on a secure session. */
static int send_message(uint16_t protocol, uint8_t opcode, const uint8_t *body, size_t body_len, bool new_exchange)
{
	struct mt_msg_header h = {0};
	struct mt_proto_header p = {0};
	size_t n;

	if (tx_busy) {
		return -EBUSY;
	}
	if (new_exchange) {
		exchange_id++;
	}
	if (secure) {
		h.session_id = peer_session_id;
		h.counter = secure_counter++;
	} else {
		h.session_id = 0;
		h.counter = unsecured_counter++;
		h.has_source = true;
		h.source_node = ephemeral_node;
	}
	n = mt_msg_encode_header(&h, tx_msg, sizeof(tx_msg));
	size_t hdr = n;

	p.exchange_flags = MT_EX_INITIATOR; /* BTP is reliable: no MRP */
	p.opcode = opcode;
	p.exchange_id = exchange_id;
	p.protocol_id = protocol;
	n += mt_msg_encode_proto(&p, &tx_msg[n], sizeof(tx_msg) - n);
	if (n + body_len + MT_MIC_LEN > sizeof(tx_msg)) {
		return -EMSGSIZE;
	}
	memcpy(&tx_msg[n], body, body_len);
	n += body_len;
	if (secure) {
		uint8_t nonce[MT_NONCE_LEN];
		int err;

		mt_msg_nonce(&h, 0, nonce); /* PASE: no node IDs */
		err = mt_ccm_encrypt(key_i2r, nonce, tx_msg, hdr, &tx_msg[hdr], n - hdr, &tx_msg[n]);
		if (err) {
			return err;
		}
		n += MT_MIC_LEN;
	}
	tx_len = n;
	tx_off = 0;
	tx_busy = true;
	send_next_packet();
	return 0;
}

/* Opens a received message: header, decryption on a secure session, protocol header. */
static bool open_message(uint8_t *msg, size_t len, struct mt_proto_header *p, const uint8_t **body,
			 size_t *body_len)
{
	struct mt_msg_header h;
	size_t hdr = mt_msg_decode_header(msg, len, &h);

	if (hdr == 0) {
		return false;
	}
	if (secure) {
		uint8_t nonce[MT_NONCE_LEN];

		if (h.session_id != local_session_id || len < hdr + MT_MIC_LEN) {
			return false;
		}
		mt_msg_nonce(&h, 0, nonce);
		if (mt_ccm_decrypt(key_r2i, nonce, msg, hdr, &msg[hdr], len - hdr - MT_MIC_LEN,
				   &msg[len - MT_MIC_LEN]) != 0) {
			return false;
		}
		len -= MT_MIC_LEN;
		if (!mt_counter_accept(&peer_counters, h.counter)) {
			return false;
		}
	} else if (h.session_id != 0) {
		return false;
	}
	size_t ph = mt_msg_decode_proto(&msg[hdr], len - hdr, p);

	if (ph == 0) {
		return false;
	}
	*body = &msg[hdr + ph];
	*body_len = len - hdr - ph;
	return true;
}

static int invoke(uint16_t endpoint, uint32_t cluster, uint32_t command, void (*fields)(struct mt_tlv_writer *))
{
	static uint8_t body[512];
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, body, sizeof(body));
	mt_im_invoke_begin(&w, endpoint, cluster, command, false);
	if (fields) {
		fields(&w);
	}
	int n = mt_im_invoke_end(&w);

	if (n < 0) {
		return -ENOBUFS;
	}
	return send_message(MT_PROTO_IM, MT_IM_INVOKE_REQUEST, body, (size_t)n, true);
}

static void fields_arm(struct mt_tlv_writer *w)
{
	mt_tlv_put_uint(w, 0, fail_safe_s); /* ExpiryLengthSeconds */
	mt_tlv_put_uint(w, 1, 1);           /* Breadcrumb */
}

static void fields_regulatory(struct mt_tlv_writer *w)
{
	mt_tlv_put_uint(w, 0, 0); /* NewRegulatoryConfig: indoor */
	mt_tlv_put_str(w, 1, "XX"); /* CountryCode: unknown */
	mt_tlv_put_uint(w, 2, 2); /* Breadcrumb */
}

static uint8_t dataset[254];
static size_t dataset_len;

static void fields_thread(struct mt_tlv_writer *w)
{
	mt_tlv_put_bytes(w, 0, dataset, dataset_len); /* OperationalDataset */
	mt_tlv_put_uint(w, 1, 3);                     /* Breadcrumb */
}

static uint8_t ext_panid[8];

static void fields_connect(struct mt_tlv_writer *w)
{
	mt_tlv_put_bytes(w, 0, ext_panid, sizeof(ext_panid)); /* NetworkID: the extended PAN ID */
	mt_tlv_put_uint(w, 1, 4);                             /* Breadcrumb */
}

/* The extended PAN ID from the dataset TLVs (type 2, length 8). */
static bool dataset_ext_panid(void)
{
	for (size_t i = 0; i + 2 <= dataset_len;) {
		uint8_t t = dataset[i];
		uint8_t l = dataset[i + 1];

		if (i + 2 + l > dataset_len) {
			return false;
		}
		if (t == 2 && l == 8) {
			memcpy(ext_panid, &dataset[i + 2], 8);
			return true;
		}
		i += 2u + l;
	}
	return false;
}

static void next_step(void)
{
	int err = 0;

	switch (stage) {
	case MT_STAGE_ARM_FAIL_SAFE:
		err = invoke(0, MT_CL_GENERAL_COMMISSIONING, MT_CMD_ARM_FAIL_SAFE, fields_arm);
		break;
	case MT_STAGE_REGULATORY:
		err = invoke(0, MT_CL_GENERAL_COMMISSIONING, MT_CMD_SET_REGULATORY_CONFIG, fields_regulatory);
		break;
	case MT_STAGE_THREAD_NETWORK:
		err = ot_leader_dataset(dataset, sizeof(dataset), &dataset_len);
		if (err == 0 && !dataset_ext_panid()) {
			err = -EINVAL;
		}
		if (err == 0) {
			err = invoke(0, MT_CL_NETWORK_COMMISSIONING, MT_CMD_ADD_OR_UPDATE_THREAD, fields_thread);
		}
		break;
	case MT_STAGE_CONNECT_NETWORK:
		err = invoke(0, MT_CL_NETWORK_COMMISSIONING, MT_CMD_CONNECT_NETWORK, fields_connect);
		break;
	default:
		break;
	}
	if (err) {
		fail("send", err);
	}
}

/* An InvokeResponse: success means the command's response says 0 (its first field) or a status of 0. */
static void handle_invoke_response(const uint8_t *body, size_t len)
{
	struct mt_im_invoke_result res;

	if (!mt_im_parse_invoke_response(body, len, &res)) {
		fail("unreadable response", -EBADMSG);
		return;
	}
	if (!res.has_fields && res.status != 0) {
		fail("command refused", res.status);
		return;
	}
	if (res.has_fields) {
		struct mt_tlv_reader r;
		struct mt_tlv_element e;

		mt_tlv_reader_init(&r, res.fields, res.fields_len);
		if (mt_tlv_next(&r, &e) && mt_tlv_find(&r, 0, &e) && e.type == MT_TLV_UINT && e.v.u != 0) {
			fail("command answered with an error", (int)e.v.u);
			return;
		}
	}
	stage++;
	if (stage == MT_STAGE_ON_THREAD) {
		LOG_INF("the device is joining this board's Thread network; CASE and its certificates are not in this "
			"version, so it leaves again when its fail-safe of %u s ends", fail_safe_s);
		mt_ble_close();
		return;
	}
	next_step();
}

static void pase_start(void)
{
	stage = MT_STAGE_PASE;
	(void)mt_random(pase_random, sizeof(pase_random));
	(void)mt_random((uint8_t *)&local_session_id, sizeof(local_session_id));
	local_session_id = (uint16_t)(local_session_id | 1u); /* never 0, the unsecured session */
	int n = mt_pase_pbkdf_request(pbkdf_req, sizeof(pbkdf_req), pase_random, local_session_id);

	if (n < 0) {
		fail("PBKDFParamRequest", -ENOBUFS);
		return;
	}
	pbkdf_req_len = (size_t)n;
	int err = send_message(MT_PROTO_SECURE_CHANNEL, MT_SC_PBKDF_REQ, pbkdf_req, pbkdf_req_len, true);

	if (err) {
		fail("send", err);
	}
}

static void pase_handle(uint8_t opcode, const uint8_t *body, size_t len)
{
	int err = 0;

	if (opcode == MT_SC_PBKDF_RESP) {
		struct mt_pase_pbkdf_response resp;
		uint8_t context[32];
		static const char prefix[] = "CHIP PAKE V1 Commissioning";
		const uint8_t *parts[] = {(const uint8_t *)prefix, pbkdf_req, body};
		size_t lens[] = {sizeof(prefix) - 1, pbkdf_req_len, len};
		uint8_t pa[MT_PASE_POINT_LEN];
		uint8_t out[96];

		if (!mt_pase_parse_pbkdf_response(body, len, pase_random, &resp)) {
			fail("PBKDFParamResponse", -EBADMSG);
			return;
		}
		peer_session_id = resp.responder_session_id;
		err = mt_sha256(parts, lens, 3, context);
		if (!err) {
			err = mt_spake_begin(&spake, code.passcode, resp.salt, resp.salt_len, resp.iterations, context);
		}
		if (!err) {
			err = mt_spake_round1(&spake, pa);
		}
		int n = err ? -1 : mt_pase_pake1(out, sizeof(out), pa);

		if (n < 0) {
			fail("Pake1", err ? err : -ENOBUFS);
			return;
		}
		err = send_message(MT_PROTO_SECURE_CHANNEL, MT_SC_PAKE1, out, (size_t)n, false);
	} else if (opcode == MT_SC_PAKE2) {
		uint8_t pb[MT_PASE_POINT_LEN];
		uint8_t cb[MT_PASE_HASH_LEN];
		uint8_t ca[MT_PASE_HASH_LEN];
		uint8_t out[48];
		psa_key_id_t shared = PSA_KEY_ID_NULL;
		uint8_t keys[48];
		static const uint8_t info[] = "SessionKeys";

		if (!mt_pase_parse_pake2(body, len, pb, cb)) {
			fail("Pake2", -EBADMSG);
			return;
		}
		err = mt_spake_round2(&spake, pb, ca);
		if (!err) {
			err = mt_spake_confirm(&spake, cb, &shared);
		}
		if (err) {
			fail(err == -EACCES ? "wrong setup code" : "SPAKE2+", err);
			return;
		}
		int n = mt_pase_pake3(out, sizeof(out), ca);

		err = n < 0 ? -ENOBUFS : send_message(MT_PROTO_SECURE_CHANNEL, MT_SC_PAKE3, out, (size_t)n, false);
		/* The session keys: I2R, R2I, attestation challenge. */
		if (!err) {
			err = mt_hkdf_from_key(shared, NULL, 0, info, sizeof(info) - 1, keys, sizeof(keys));
		}
		psa_destroy_key(shared);
		if (!err) {
			err = mt_ccm_import(&keys[0], &key_i2r);
		}
		if (!err) {
			err = mt_ccm_import(&keys[16], &key_r2i);
		}
		memset(keys, 0, sizeof(keys));
	} else if (opcode == MT_SC_STATUS_REPORT) {
		uint16_t general;
		uint32_t proto;
		uint16_t pcode;

		if (!mt_status_report_parse(body, len, &general, &proto, &pcode) || general != 0 || pcode != 0) {
			fail("PASE refused by the device", -EACCES);
			return;
		}
		/* PASE is done: everything from here is on the secure session. */
		secure = true;
		(void)mt_random((uint8_t *)&secure_counter, sizeof(secure_counter));
		secure_counter = (secure_counter & 0x0FFFFFFFu) + 1u;
		memset(&peer_counters, 0, sizeof(peer_counters));
		LOG_INF("PASE session up");
		stage = MT_STAGE_ARM_FAIL_SAFE;
		next_step();
		return;
	} else {
		fail("unexpected message", opcode);
		return;
	}
	if (err) {
		fail("PASE", err);
	}
}

static void rx_handler(struct k_work *w)
{
	struct rx_pkt pkt;

	ARG_UNUSED(w);
	while (k_msgq_get(&rx_q, &pkt, K_NO_WAIT) == 0) {
		if (!handshaken) {
			if (!mt_btp_handshake_response(&btp, pkt.data, pkt.len, att_mtu)) {
				fail("BTP handshake", -EPROTO);
				return;
			}
			handshaken = true;
			LOG_INF("BTP up: segments of %u bytes", btp.segment_size);
			pase_start();
			continue;
		}
		enum mt_btp_rx r = mt_btp_receive(&btp, pkt.data, pkt.len);

		if (r == MT_BTP_RX_ERROR) {
			fail("BTP", -EPROTO);
			return;
		}
		if (r != MT_BTP_RX_MESSAGE) {
			continue;
		}
		struct mt_proto_header p;
		const uint8_t *body;
		size_t len;

		if (!open_message(btp.rx_buf, btp.rx_len, &p, &body, &len)) {
			LOG_WRN("message dropped");
			continue;
		}
		if (p.protocol_id == MT_PROTO_SECURE_CHANNEL && p.opcode == MT_SC_STANDALONE_ACK) {
			continue;
		}
		if (stage == MT_STAGE_PASE && p.protocol_id == MT_PROTO_SECURE_CHANNEL) {
			pase_handle(p.opcode, body, len);
		} else if (stage >= MT_STAGE_ARM_FAIL_SAFE && stage < MT_STAGE_ON_THREAD &&
			   p.protocol_id == MT_PROTO_IM && p.opcode == MT_IM_INVOKE_RESPONSE) {
			handle_invoke_response(body, len);
		} else {
			LOG_WRN("unexpected message: protocol %u opcode 0x%02x", p.protocol_id, p.opcode);
		}
	}
}

static void ready_handler(struct k_work *w)
{
	uint8_t req[MT_BTP_HANDSHAKE_REQ_LEN];

	ARG_UNUSED(w);
	stage = MT_STAGE_BTP;
	handshaken = false;
	mt_btp_handshake_request(req, att_mtu, BTP_WINDOW);
	int err = mt_ble_write(req, sizeof(req));

	if (err) {
		fail("BTP handshake write", err);
	}
}

static void written_handler(struct k_work *w)
{
	ARG_UNUSED(w);
	if (tx_busy) {
		send_next_packet();
	}
}

static void closed_handler(struct k_work *w)
{
	ARG_UNUSED(w);
	destroy_keys();
	mt_spake_abort(&spake);
	secure = false;
	tx_busy = false;
	if (stage != MT_STAGE_ON_THREAD && stage != MT_STAGE_FAILED && stage != MT_STAGE_IDLE) {
		LOG_ERR("commissioning stopped at %s: the device went away", mt_stage_name(stage));
		stage = MT_STAGE_FAILED;
	}
}

static void on_ready(uint16_t mtu)
{
	att_mtu = mtu;
	k_work_submit_to_queue(&wq, &ready_work);
}

static void on_received(const uint8_t *data, size_t len)
{
	struct rx_pkt pkt;

	if (len > sizeof(pkt.data)) {
		return;
	}
	pkt.len = (uint16_t)len;
	memcpy(pkt.data, data, len);
	if (k_msgq_put(&rx_q, &pkt, K_NO_WAIT) != 0) {
		LOG_WRN("BTP packet dropped: queue full");
	}
	k_work_submit_to_queue(&wq, &rx_work);
}

static void on_written(int err)
{
	if (err) {
		LOG_ERR("BTP write failed");
	}
	k_work_submit_to_queue(&wq, &written_work);
}

static void on_closed(int reason)
{
	ARG_UNUSED(reason);
	k_work_submit_to_queue(&wq, &closed_work);
}

static const struct mt_ble_callbacks ble_cbs = {
	.ready = on_ready,
	.received = on_received,
	.written = on_written,
	.closed = on_closed,
};

int mt_commission_start(const char *setup_code, uint16_t fail_safe)
{
	static bool init;

	if (!init) {
		k_work_queue_init(&wq);
		k_work_queue_start(&wq, wq_stack, K_THREAD_STACK_SIZEOF(wq_stack), K_PRIO_PREEMPT(8), NULL);
		k_work_init(&rx_work, rx_handler);
		k_work_init(&ready_work, ready_handler);
		k_work_init(&written_work, written_handler);
		k_work_init(&closed_work, closed_handler);
		init = true;
	}
	if (stage != MT_STAGE_IDLE && stage != MT_STAGE_ON_THREAD && stage != MT_STAGE_FAILED) {
		return -EBUSY;
	}
	/* Checked before anything starts: a typo never leaves the commissioner busy. */
	if (mp_parse_manual_code(setup_code, &code) != MP_CODE_OK) {
		return -EINVAL;
	}
	fail_safe_s = fail_safe;
	(void)mt_random((uint8_t *)&ephemeral_node, sizeof(ephemeral_node));
	(void)mt_random((uint8_t *)&unsecured_counter, sizeof(unsecured_counter));
	(void)mt_random((uint8_t *)&exchange_id, sizeof(exchange_id));
	secure = false;
	k_msgq_purge(&rx_q);
	stage = MT_STAGE_SCANNING;
	int err = mt_ble_connect(code.short_discriminator, true, 60000, &ble_cbs);

	if (err) {
		stage = MT_STAGE_FAILED;
	}
	return err;
}

enum mt_stage mt_commission_stage(void)
{
	return stage;
}

const char *mt_stage_name(enum mt_stage s)
{
	static const char *const names[] = {
		"idle", "scanning", "BTP", "PASE", "ArmFailSafe", "SetRegulatoryConfig",
		"AddOrUpdateThreadNetwork", "ConnectNetwork", "on Thread", "failed",
	};

	return (unsigned int)s < sizeof(names) / sizeof(names[0]) ? names[s] : "?";
}

void mt_commission_cancel(void)
{
	mt_ble_close();
}
