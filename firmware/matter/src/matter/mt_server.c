/*
 * See mt_server.h. One responder session at a time is enough for one OTA transfer; it is kept until the device
 * closes it or another device opens one. Runs on the controller's work queue (mt_controller.c calls in).
 */
#include "mt_server.h"

#include <errno.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "mt_attest.h"
#include "mt_bdx.h"
#include "mt_case_msg.h"
#include "mt_cert.h"
#include "mt_controller.h"
#include "mt_crypto.h"
#include "mt_fabric.h"
#include "mt_im.h"
#include "mt_msg.h"
#include "mt_ota.h"
#include "mt_ota_store.h"

LOG_MODULE_REGISTER(mt_server, LOG_LEVEL_INF);

#define MSG_MAX 1280
#define BLOCK_MAX 1024
#define MRP_TRIES 5

/* the controller's socket */
extern int mt_ctl_sendto(const uint8_t *buf, size_t len, const struct sockaddr_in6 *to);
extern void mt_ctl_schedule(struct k_work_delayable *work, k_timeout_t delay);

enum state { S_IDLE, S_SIGMA3, S_SESSION };
static enum state state;
static struct sockaddr_in6 peer;
static uint64_t peer_node;
static uint16_t local_sid;
static uint16_t peer_sid;
static psa_key_id_t key_i2r = PSA_KEY_ID_NULL;
static psa_key_id_t key_r2i = PSA_KEY_ID_NULL;
static uint32_t counter;
static uint32_t unsecured_counter;
static struct mt_counter_window peer_counters;

/* CASE as responder */
static uint8_t sigma1[200];
static size_t sigma1_len;
static uint8_t sigma2[700];
static size_t sigma2_len;
static uint8_t shared[32];
static uint8_t own_eph_pub[65];
static uint8_t peer_eph_pub[65];
static uint64_t peer_ephemeral_node;

/* the last reliable message, for retransmission */
static uint8_t tx[MSG_MAX];
static size_t tx_len;
static uint32_t tx_counter;
static bool tx_waiting;
static int tx_tries;
static struct k_work_delayable retx;
static bool init;

/* OTA */
static uint8_t token[8];
static struct mt_ota_image image;
static bool transfer_active;
static uint16_t block_size;
static uint32_t blocks_sent;

static void reset(void)
{
	if (key_i2r != PSA_KEY_ID_NULL) {
		psa_destroy_key(key_i2r);
		key_i2r = PSA_KEY_ID_NULL;
	}
	if (key_r2i != PSA_KEY_ID_NULL) {
		psa_destroy_key(key_r2i);
		key_r2i = PSA_KEY_ID_NULL;
	}
	memset(shared, 0, sizeof(shared));
	state = S_IDLE;
	tx_waiting = false;
	transfer_active = false;
}

static void retransmit(struct k_work *w)
{
	ARG_UNUSED(w);
	if (!tx_waiting) {
		return;
	}
	if (++tx_tries >= MRP_TRIES) {
		LOG_WRN("device 0x%016llx stopped answering", (unsigned long long)peer_node);
		reset();
		return;
	}
	(void)mt_ctl_sendto(tx, tx_len, &peer);
	mt_ctl_schedule(&retx, K_MSEC(1000u << tx_tries));
}

/* Sends a response on the peer's exchange: reliable, acknowledging what it answers. */
static int respond(bool secure, uint16_t exchange, uint16_t protocol, uint8_t opcode, const uint8_t *body,
		   size_t len, bool has_ack, uint32_t ack, bool reliable)
{
	struct mt_msg_header h = {0};
	struct mt_proto_header p = {0};
	size_t n;

	if (secure) {
		h.session_id = peer_sid;
		h.counter = counter++;
	} else {
		h.counter = unsecured_counter++;
		h.has_dest = true;
		h.dest_node = peer_ephemeral_node;
	}
	n = mt_msg_encode_header(&h, tx, sizeof(tx));
	size_t hdr = n;

	p.exchange_flags = reliable ? MT_EX_RELIABLE : 0; /* the responder: no initiator flag */
	p.opcode = opcode;
	p.exchange_id = exchange;
	p.protocol_id = protocol;
	p.has_ack = has_ack;
	p.ack_counter = ack;
	n += mt_msg_encode_proto(&p, &tx[n], sizeof(tx) - n);
	if (n + len + MT_MIC_LEN > sizeof(tx)) {
		return -EMSGSIZE;
	}
	memcpy(&tx[n], body, len);
	n += len;
	if (secure) {
		uint8_t nonce[MT_NONCE_LEN];

		mt_msg_nonce(&h, mt_fabric()->own_node_id, nonce);
		int err = mt_ccm_encrypt(key_r2i, nonce, tx, hdr, &tx[hdr], n - hdr, &tx[n]);

		if (err) {
			return err;
		}
		n += MT_MIC_LEN;
	}
	tx_len = n;
	tx_counter = h.counter;
	(void)mt_ctl_sendto(tx, tx_len, &peer);
	if (reliable) {
		tx_waiting = true;
		tx_tries = 0;
		mt_ctl_schedule(&retx, K_MSEC(1000));
	}
	return 0;
}

static void sigma1_in(const uint8_t *body, size_t len, uint16_t exchange, uint32_t ack)
{
	const struct mt_fabric *f = mt_fabric();
	struct mt_case_sigma1 s1;
	uint8_t msg[113];
	uint8_t want[32];
	uint8_t random[32];
	uint8_t salt[16 + 32 + 65 + 32];
	uint8_t s2k[16];
	uint8_t tbs[600];
	uint8_t tbe[600];
	uint8_t sig[64];
	uint8_t resume[16];
	psa_key_id_t eph = PSA_KEY_ID_NULL;
	static const uint8_t n2[13] = "NCASE_Sigma2N";
	int err;

	if (len > sizeof(sigma1) || !mt_case_parse_sigma1(body, len, &s1)) {
		return;
	}
	/* Addressed to this board in this fabric? */
	size_t m = mt_case_destination_message(msg, s1.random, f->root_public_key, f->fabric_id, f->own_node_id);

	if (mt_hmac_sha256(f->operational_ipk, 16, msg, m, want) != 0 || memcmp(want, s1.destination_id, 32) != 0) {
		return;
	}
	reset();
	memcpy(sigma1, body, len);
	sigma1_len = len;
	peer_sid = s1.session_id;
	memcpy(peer_eph_pub, s1.eph_pub, 65);
	(void)mt_random((uint8_t *)&local_sid, sizeof(local_sid));
	local_sid |= 1;
	err = mt_random(random, sizeof(random));
	if (!err) {
		err = mt_ecdh_new(&eph, own_eph_pub);
	}
	if (!err) {
		err = mt_ecdh_shared(eph, s1.eph_pub, shared);
	}
	if (eph != PSA_KEY_ID_NULL) {
		psa_destroy_key(eph);
	}
	int n = err ? -1 : mt_case_tbs(tbs, sizeof(tbs), f->own_noc, f->own_noc_len, NULL, 0, own_eph_pub, s1.eph_pub);

	err = n < 0 ? -EIO : mt_fabric_sign_own(tbs, (size_t)n, sig);
	if (!err) {
		err = mt_random(resume, sizeof(resume));
	}
	n = err ? -1 : mt_case_tbe2(tbe, sizeof(tbe) - 16, f->own_noc, f->own_noc_len, sig, resume);
	const uint8_t *p1[] = {sigma1};
	size_t l1[] = {sigma1_len};

	memcpy(salt, f->operational_ipk, 16);
	memcpy(&salt[16], random, 32);
	memcpy(&salt[48], own_eph_pub, 65);
	if (n > 0 && mt_sha256(p1, l1, 1, &salt[113]) == 0 &&
	    mt_hkdf(shared, 32, salt, sizeof(salt), (const uint8_t *)"Sigma2", 6, s2k, 16) == 0 &&
	    mt_ccm_once(true, s2k, n2, tbe, (size_t)n, &tbe[n]) == 0) {
		int m2 = mt_case_sigma2(sigma2, sizeof(sigma2), random, local_sid, own_eph_pub, tbe, (size_t)n + 16);

		if (m2 > 0) {
			sigma2_len = (size_t)m2;
			state = S_SIGMA3;
			(void)respond(false, exchange, MT_PROTO_SECURE_CHANNEL, MT_SC_SIGMA2, sigma2, sigma2_len, true,
				      ack, true);
			return;
		}
	}
	LOG_WRN("CASE as responder failed");
	reset();
}

static void sigma3_in(const uint8_t *body, size_t len, uint16_t exchange, uint32_t ack)
{
	const struct mt_fabric *f = mt_fabric();
	const uint8_t *enc;
	size_t enc_len;
	uint8_t tbe[600];
	uint8_t tbs[600];
	uint8_t salt[48];
	uint8_t s3k[16];
	uint8_t keys[48];
	const uint8_t *noc;
	size_t noc_len;
	const uint8_t *sig;
	uint8_t pub[65];
	uint64_t node;
	uint64_t fabric;
	uint8_t der[MT_CERT_DER_MAX];
	struct mt_x509 x;
	uint8_t status[8];
	static const uint8_t n3[13] = "NCASE_Sigma3N";

	if (!mt_case_parse_sigma3(body, len, &enc, &enc_len) || enc_len - 16 > sizeof(tbe)) {
		goto refuse;
	}
	const uint8_t *p2[] = {sigma1, sigma2};
	size_t l2[] = {sigma1_len, sigma2_len};

	memcpy(salt, f->operational_ipk, 16);
	memcpy(tbe, enc, enc_len - 16);
	if (mt_sha256(p2, l2, 2, &salt[16]) != 0 ||
	    mt_hkdf(shared, 32, salt, 48, (const uint8_t *)"Sigma3", 6, s3k, 16) != 0 ||
	    mt_ccm_once(false, s3k, n3, tbe, enc_len - 16, (uint8_t *)&enc[enc_len - 16]) != 0 ||
	    !mt_case_parse_tbe3(tbe, enc_len - 16, &noc, &noc_len, &sig) ||
	    !mt_cert_read(noc, noc_len, pub, &node, &fabric) || fabric != f->fabric_id ||
	    mt_fabric_node(node) == NULL) {
		goto refuse;
	}
	int n = mt_cert_to_der(noc, noc_len, der, sizeof(der), NULL, NULL);

	if (n <= 0 || !mt_x509_parse(der, (size_t)n, &x) ||
	    !mt_verify(f->root_public_key, x.tbs, x.tbs_len, x.signature)) {
		goto refuse;
	}
	n = mt_case_tbs(tbs, sizeof(tbs), noc, noc_len, NULL, 0, peer_eph_pub, own_eph_pub);
	if (n < 0 || !mt_verify(pub, tbs, (size_t)n, sig)) {
		goto refuse;
	}
	const uint8_t *p3[] = {sigma1, sigma2, body};
	size_t l3[] = {sigma1_len, sigma2_len, len};

	if (mt_sha256(p3, l3, 3, &salt[16]) != 0 ||
	    mt_hkdf(shared, 32, salt, sizeof(salt), (const uint8_t *)"SessionKeys", 11, keys, 48) != 0 ||
	    mt_ccm_import(&keys[0], &key_i2r) != 0 || mt_ccm_import(&keys[16], &key_r2i) != 0) {
		memset(keys, 0, sizeof(keys));
		goto refuse;
	}
	memset(keys, 0, sizeof(keys));
	peer_node = node;
	memset(&peer_counters, 0, sizeof(peer_counters));
	(void)mt_random((uint8_t *)&counter, sizeof(counter));
	counter = (counter & 0x0FFFFFFFu) + 1;
	state = S_SESSION;
	tx_waiting = false;
	LOG_INF("node 0x%016llx opened a session (OTA)", (unsigned long long)node);
	(void)respond(false, exchange, MT_PROTO_SECURE_CHANNEL, MT_SC_STATUS_REPORT, status,
		      mt_status_report(status, 0, 0, 0), true, ack, true);
	return;
refuse:
	LOG_WRN("Sigma3 refused");
	(void)respond(false, exchange, MT_PROTO_SECURE_CHANNEL, MT_SC_STATUS_REPORT, status,
		      mt_status_report(status, 1, 0, 2), true, ack, false);
	reset();
}

static void invoke_in(const uint8_t *body, size_t len, uint16_t exchange, uint32_t ack)
{
	struct mt_im_invoke_request req;
	struct mt_tlv_writer w;
	uint8_t out[300];
	int n;

	if (!mt_im_parse_invoke_request(body, len, &req)) {
		return;
	}
	mt_tlv_writer_init(&w, out, sizeof(out));
	if (req.cluster != MT_CL_OTA_PROVIDER) {
		n = mt_im_response_status(out, sizeof(out), &req, MT_IM_STATUS_UNSUPPORTED_CLUSTER);
	} else if (req.command == MT_OTA_QUERY_IMAGE) {
		struct mt_ota_query q;
		bool have = mt_ota_store_image(&image);
		int status;

		if (!mt_ota_parse_query(req.fields, req.fields_len, &q)) {
			n = mt_im_response_status(out, sizeof(out), &req, MT_IM_STATUS_INVALID_COMMAND);
		} else {
			status = mt_ota_decide(&q, &image, have, transfer_active);
			(void)mt_random(token, sizeof(token));
			LOG_INF("QueryImage from node 0x%016llx at version %u: %s", (unsigned long long)peer_node,
				q.software_version, status == MT_OTA_STATUS_AVAILABLE ? "update offered" : "nothing");
			mt_im_response_begin(&w, req.endpoint, MT_CL_OTA_PROVIDER, MT_OTA_QUERY_IMAGE_RESPONSE);
			mt_ota_query_response(&w, status, mt_fabric()->own_node_id, &image, token);
			n = mt_im_invoke_end(&w);
		}
	} else if (req.command == MT_OTA_APPLY_UPDATE) {
		uint32_t v;

		if (!mt_ota_parse_apply(req.fields, req.fields_len, token, &v)) {
			n = mt_im_response_status(out, sizeof(out), &req, MT_IM_STATUS_INVALID_COMMAND);
		} else {
			LOG_INF("node 0x%016llx applies version %u", (unsigned long long)peer_node, v);
			mt_im_response_begin(&w, req.endpoint, MT_CL_OTA_PROVIDER, MT_OTA_APPLY_UPDATE_RESPONSE);
			mt_ota_apply_response(&w);
			n = mt_im_invoke_end(&w);
		}
	} else if (req.command == MT_OTA_NOTIFY_APPLIED) {
		LOG_INF("node 0x%016llx runs the new version", (unsigned long long)peer_node);
		n = mt_im_response_status(out, sizeof(out), &req, 0);
	} else {
		n = mt_im_response_status(out, sizeof(out), &req, MT_IM_STATUS_UNSUPPORTED_COMMAND);
	}
	if (n > 0) {
		(void)respond(true, exchange, MT_PROTO_IM, MT_IM_INVOKE_RESPONSE, out, (size_t)n, true, ack, true);
	}
}

static void send_block(uint16_t exchange, uint32_t ack, uint32_t index)
{
	uint8_t out[4 + BLOCK_MAX];
	uint32_t offset = index * block_size;

	if (offset >= image.length) {
		return;
	}
	size_t take = image.length - offset < block_size ? image.length - offset : block_size;
	bool last = offset + take >= image.length;

	mt_bdx_block_header(out, index);
	if (mt_ota_store_read(offset, &out[4], take) != 0) {
		return;
	}
	(void)respond(true, exchange, MT_PROTO_BDX, last ? MT_BDX_BLOCK_EOF : MT_BDX_BLOCK, out, 4 + take, true, ack,
		      true);
	blocks_sent = index + 1;
}

static void bdx_in(uint8_t opcode, const uint8_t *body, size_t len, uint16_t exchange, uint32_t ack)
{
	uint32_t c;
	uint64_t skip;

	if (opcode == MT_BDX_RECEIVE_INIT) {
		struct mt_bdx_init in;
		uint8_t out[12];

		if (!mt_bdx_parse_init(body, len, &in) || !(in.transfer_control & MT_BDX_RECEIVER_DRIVE) ||
		    !mt_ota_store_image(&image) || in.start_offset != 0 ||
		    in.file_designator_len != strlen(image.name) ||
		    memcmp(in.file_designator, image.name, in.file_designator_len) != 0) {
			uint8_t sr[8];

			(void)respond(true, exchange, MT_PROTO_SECURE_CHANNEL, MT_SC_STATUS_REPORT, sr,
				      mt_status_report(sr, 1, MT_PROTO_BDX, 0x0052), true, ack, false);
			return;
		}
		block_size = in.max_block_size < BLOCK_MAX ? in.max_block_size : BLOCK_MAX;
		transfer_active = true;
		blocks_sent = 0;
		LOG_INF("sending %s (%u bytes) to node 0x%016llx", image.name, image.length,
			(unsigned long long)peer_node);
		(void)respond(true, exchange, MT_PROTO_BDX, MT_BDX_RECEIVE_ACCEPT, out,
			      mt_bdx_receive_accept(out, block_size, image.length), true, ack, true);
	} else if (opcode == MT_BDX_BLOCK_QUERY && transfer_active && mt_bdx_parse_counter(body, len, &c)) {
		send_block(exchange, ack, c);
	} else if (opcode == MT_BDX_BLOCK_QUERY_SKIP && transfer_active &&
		   mt_bdx_parse_query_skip(body, len, &c, &skip)) {
		send_block(exchange, ack, c); /* skips are whole blocks in practice */
	} else if (opcode == MT_BDX_BLOCK_ACK_EOF && transfer_active) {
		transfer_active = false;
		tx_waiting = false;
		LOG_INF("image sent to node 0x%016llx", (unsigned long long)peer_node);
		uint8_t empty;

		(void)respond(true, exchange, MT_PROTO_SECURE_CHANNEL, MT_SC_STANDALONE_ACK, &empty, 0, true, ack, false);
	}
}

bool mt_server_rx(uint8_t *msg, size_t len, const struct sockaddr_in6 *from)
{
	struct mt_msg_header h;
	struct mt_proto_header p;
	size_t hdr = mt_msg_decode_header(msg, len, &h);

	if (!init) {
		k_work_init_delayable(&retx, retransmit);
		(void)mt_random((uint8_t *)&unsecured_counter, sizeof(unsecured_counter));
		init = true;
	}
	if (hdr == 0) {
		return false;
	}
	bool secure = h.session_id != 0;

	if (secure) {
		uint8_t nonce[MT_NONCE_LEN];

		if (state != S_SESSION || h.session_id != local_sid || len < hdr + MT_MIC_LEN) {
			return false;
		}
		mt_msg_nonce(&h, peer_node, nonce);
		if (mt_ccm_decrypt(key_i2r, nonce, msg, hdr, &msg[hdr], len - hdr - MT_MIC_LEN,
				   &msg[len - MT_MIC_LEN]) != 0) {
			return true;
		}
		len -= MT_MIC_LEN;
		if (!mt_counter_accept(&peer_counters, h.counter)) {
			return true;
		}
	}
	size_t ph = mt_msg_decode_proto(&msg[hdr], len - hdr, &p);

	if (ph == 0) {
		return false;
	}
	/* Only exchanges the device started are the server's. */
	if (!(p.exchange_flags & MT_EX_INITIATOR)) {
		return false;
	}
	if (!secure && !(p.opcode == MT_SC_SIGMA1 || (p.opcode == MT_SC_SIGMA3 && state == S_SIGMA3) ||
			 (p.opcode == MT_SC_STANDALONE_ACK && state != S_IDLE))) {
		return false;
	}
	if (p.has_ack && tx_waiting && p.ack_counter == tx_counter) {
		tx_waiting = false;
		k_work_cancel_delayable(&retx);
	}
	const uint8_t *body = &msg[hdr + ph];
	size_t blen = len - hdr - ph;
	bool reliable = p.exchange_flags & MT_EX_RELIABLE;

	if (!secure && p.protocol_id == MT_PROTO_SECURE_CHANNEL && p.opcode == MT_SC_SIGMA1) {
		peer = *from;
		peer_ephemeral_node = h.has_source ? h.source_node : 0;
		sigma1_in(body, blen, p.exchange_id, h.counter);
	} else if (!secure && p.opcode == MT_SC_SIGMA3) {
		sigma3_in(body, blen, p.exchange_id, h.counter);
	} else if (secure && p.protocol_id == MT_PROTO_IM && p.opcode == MT_IM_INVOKE_REQUEST) {
		invoke_in(body, blen, p.exchange_id, h.counter);
	} else if (secure && p.protocol_id == MT_PROTO_BDX) {
		bdx_in(p.opcode, body, blen, p.exchange_id, h.counter);
	} else if (reliable) {
		uint8_t empty;

		(void)respond(secure, p.exchange_id, MT_PROTO_SECURE_CHANNEL, MT_SC_STANDALONE_ACK, &empty, 0, true,
			      h.counter, false);
	}
	return true;
}

static void announce_fields(struct mt_tlv_writer *w, void *ctx)
{
	ARG_UNUSED(ctx);
	mt_ota_announce(w, mt_fabric()->own_node_id, 0xFFF1, 0);
}

int mt_server_announce(uint64_t node_id, void (*done)(uint64_t node, int result))
{
	/* The requestor cluster is on the device's endpoint 0. */
	return mt_ctl_invoke(node_id, 0, MT_CL_OTA_REQUESTOR, MT_OTA_ANNOUNCE_PROVIDER, announce_fields, NULL, done);
}

const char *mt_server_state(void)
{
	return transfer_active ? "sending an image" : state == S_SESSION ? "session open" : "idle";
}
