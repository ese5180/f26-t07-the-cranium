/*
 * See mt_controller.h.
 */
#include "mt_controller.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

#include <openthread.h>
#include <openthread/srp_server.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/socket.h>

#include "matter_policy.h"
#include "mt_attest.h"
#include "mt_case_msg.h"
#include "mt_cert.h"
#include "mt_crypto.h"
#include "mt_fabric.h"
#include "mt_identity.h"
#include "mt_im.h"
#include "mt_msg.h"
#include "mt_server.h"

LOG_MODULE_REGISTER(mt_ctl, LOG_LEVEL_INF);

#define MATTER_PORT 5540
#define MSG_MAX 1280
#define MAX_SESSIONS 4
#define MRP_TRIES 5
#define MRP_FIRST_MS 1000
#define REPLY_TIMEOUT_MS 15000

struct session {
	bool in_use;
	enum mt_identity_kind kind;
	uint64_t own_node_id;
	uint64_t node_id;
	struct sockaddr_in6 addr;
	uint16_t local_id;
	uint16_t peer_id;
	psa_key_id_t i2r;
	psa_key_id_t r2i;
	uint32_t counter;
	struct mt_counter_window peer_counters;
};

static struct session sessions[MAX_SESSIONS];
static int sock = -1;
static K_THREAD_STACK_DEFINE(wq_stack, 8192);
static struct k_work_q wq;
static K_THREAD_STACK_DEFINE(rx_stack, 2048);
static struct k_thread rx_thread;

/* The one operation running: on which fabric, to which address if it is known */
static struct mt_case_identity id;
static bool have_addr;
static struct sockaddr_in6 given_addr;
static void (*op_fields)(const uint8_t *fields, size_t len);
static void (*op_exchange_rx)(uint8_t protocol_opcode, uint16_t protocol, const uint8_t *body, size_t len);

/* The one operation running */
enum op_state { OP_IDLE, OP_RESOLVE, OP_SIGMA2, OP_SIGMA_STATUS, OP_INVOKE, OP_EXCHANGE };
static enum op_state op;
static uint64_t op_node;
static mt_ctl_done op_done;
static struct session *op_session;
static uint8_t invoke_body[512];
static size_t invoke_len;
static bool invoke_pending;
static int resolve_tries;

/* The message layer for the running exchange */
static uint64_t ephemeral_node;
static uint32_t unsecured_counter;
static uint16_t exchange_id;
static uint8_t tx[MSG_MAX];
static size_t tx_len;
static int tx_tries;
static bool tx_waiting_ack;
static uint32_t tx_counter;
static bool ack_pending;
static uint32_t ack_counter;
static bool ack_secure;

/* CASE */
static psa_key_id_t eph_key = PSA_KEY_ID_NULL;
static uint8_t eph_pub[65];
static uint8_t sigma1[200];
static size_t sigma1_len;
static uint8_t sigma2[MSG_MAX];
static size_t sigma2_len;
static uint8_t sigma3[700];
static size_t sigma3_len;
static uint8_t shared[32];
static uint16_t case_local_id;

static struct k_work_delayable retransmit_work;
static struct k_work_delayable timeout_work;
static struct k_work_delayable resolve_work;

/* Received datagrams, copied for the work queue */
struct rx_item {
	struct sockaddr_in6 from;
	uint16_t len;
	uint8_t data[MSG_MAX];
};
static struct rx_item rx_slot;
static struct k_sem rx_free;
static struct k_work rx_work;

static void finish(int result)
{
	mt_ctl_done done = op_done;
	uint64_t node = op_node;

	k_work_cancel_delayable(&retransmit_work);
	k_work_cancel_delayable(&timeout_work);
	k_work_cancel_delayable(&resolve_work);
	if (eph_key != PSA_KEY_ID_NULL) {
		psa_destroy_key(eph_key);
		eph_key = PSA_KEY_ID_NULL;
	}
	memset(shared, 0, sizeof(shared));
	op = OP_IDLE;
	op_done = NULL;
	op_fields = NULL;
	op_exchange_rx = NULL;
	tx_waiting_ack = false;
	if (done) {
		done(node, result);
	}
}

static struct session *find_session(uint64_t node)
{
	for (int i = 0; i < MAX_SESSIONS; i++) {
		if (sessions[i].in_use && sessions[i].node_id == node && sessions[i].kind == id.kind) {
			return &sessions[i];
		}
	}
	return NULL;
}

static void free_session(struct session *s)
{
	if (s->i2r != PSA_KEY_ID_NULL) {
		psa_destroy_key(s->i2r);
	}
	if (s->r2i != PSA_KEY_ID_NULL) {
		psa_destroy_key(s->r2i);
	}
	memset(s, 0, sizeof(*s));
}

static struct session *new_session(uint64_t node)
{
	struct session *s = find_session(node);

	if (s) {
		free_session(s);
	} else {
		for (int i = 0; i < MAX_SESSIONS && !s; i++) {
			if (!sessions[i].in_use) {
				s = &sessions[i];
			}
		}
		if (!s) {
			s = &sessions[0]; /* the oldest goes */
			free_session(s);
		}
	}
	s->in_use = true;
	s->node_id = node;
	s->kind = id.kind;
	s->own_node_id = id.own_node_id;
	return s;
}

/* Builds a message into tx: header, protocol header, body; encrypted on a session. */
static int build(struct session *s, uint16_t protocol, uint8_t opcode, const uint8_t *body, size_t body_len,
		 bool reliable)
{
	struct mt_msg_header h = {0};
	struct mt_proto_header p = {0};
	size_t n;

	if (s) {
		h.session_id = s->peer_id;
		h.counter = s->counter++;
	} else {
		h.counter = unsecured_counter++;
		h.has_source = true;
		h.source_node = ephemeral_node;
	}
	tx_counter = h.counter;
	n = mt_msg_encode_header(&h, tx, sizeof(tx));
	size_t hdr = n;

	p.exchange_flags = MT_EX_INITIATOR | (reliable ? MT_EX_RELIABLE : 0);
	p.opcode = opcode;
	p.exchange_id = exchange_id;
	p.protocol_id = protocol;
	if (ack_pending && ack_secure == (s != NULL)) {
		p.has_ack = true;
		p.ack_counter = ack_counter;
		ack_pending = false;
	}
	n += mt_msg_encode_proto(&p, &tx[n], sizeof(tx) - n);
	if (n + body_len + MT_MIC_LEN > sizeof(tx)) {
		return -EMSGSIZE;
	}
	memcpy(&tx[n], body, body_len);
	n += body_len;
	if (s) {
		uint8_t nonce[MT_NONCE_LEN];

		/* CASE: the nonce carries the sender's operational node ID. */
		mt_msg_nonce(&h, s->own_node_id, nonce);
		int err = mt_ccm_encrypt(s->i2r, nonce, tx, hdr, &tx[hdr], n - hdr, &tx[n]);

		if (err) {
			return err;
		}
		n += MT_MIC_LEN;
	}
	tx_len = n;
	return 0;
}

static struct sockaddr_in6 peer_addr;

static void send_tx(void)
{
	if (zsock_sendto(sock, tx, tx_len, 0, (struct sockaddr *)&peer_addr, sizeof(peer_addr)) < 0) {
		LOG_WRN("send failed: %d", errno);
	}
}

static int send_reliable(struct session *s, uint16_t protocol, uint8_t opcode, const uint8_t *body, size_t len,
			 bool new_exchange)
{
	if (new_exchange) {
		exchange_id++;
	}
	int err = build(s, protocol, opcode, body, len, true);

	if (err) {
		return err;
	}
	tx_tries = 0;
	tx_waiting_ack = true;
	send_tx();
	k_work_reschedule_for_queue(&wq, &retransmit_work, K_MSEC(MRP_FIRST_MS));
	k_work_reschedule_for_queue(&wq, &timeout_work, K_MSEC(REPLY_TIMEOUT_MS));
	return 0;
}

static void send_standalone_ack(struct session *s)
{
	uint8_t saved[MSG_MAX];
	size_t saved_len = tx_len;
	uint32_t saved_counter = tx_counter;

	memcpy(saved, tx, tx_len);
	if (build(s, MT_PROTO_SECURE_CHANNEL, MT_SC_STANDALONE_ACK, NULL, 0, false) == 0) {
		send_tx();
	}
	memcpy(tx, saved, saved_len);
	tx_len = saved_len;
	tx_counter = saved_counter;
}

static void retransmit(struct k_work *w)
{
	ARG_UNUSED(w);
	if (!tx_waiting_ack) {
		return;
	}
	if (++tx_tries >= MRP_TRIES) {
		LOG_WRN("node 0x%016llx does not answer", (unsigned long long)op_node);
		finish(-ETIMEDOUT);
		return;
	}
	send_tx();
	k_work_reschedule_for_queue(&wq, &retransmit_work, K_MSEC(mp_backoff_ms(tx_tries, MRP_FIRST_MS, 8000)));
}

static void timed_out(struct k_work *w)
{
	ARG_UNUSED(w);
	if (op != OP_IDLE) {
		LOG_WRN("no answer from node 0x%016llx", (unsigned long long)op_node);
		finish(-ETIMEDOUT);
	}
}

/* The device's operational address, from the SRP registration of "<compressed fabric ID>-<node ID>". */
static bool resolve(uint64_t node, struct sockaddr_in6 *out)
{
	char want[34];
	const uint8_t *cf = id.compressed_id;
	const otSrpServerHost *host = NULL;
	bool found = false;
	otInstance *ot = openthread_get_default_instance();

	snprintf(want, sizeof(want), "%02X%02X%02X%02X%02X%02X%02X%02X-%016llX", cf[0], cf[1], cf[2], cf[3], cf[4],
		 cf[5], cf[6], cf[7], (unsigned long long)node);
	openthread_mutex_lock();
	while (!found && (host = otSrpServerGetNextHost(ot, host)) != NULL) {
		const otSrpServerService *svc = NULL;

		if (otSrpServerHostIsDeleted(host)) {
			continue;
		}
		while ((svc = otSrpServerHostGetNextService(host, svc)) != NULL) {
			const char *name = otSrpServerServiceGetInstanceName(svc);
			uint8_t count = 0;
			const otIp6Address *addrs;

			if (otSrpServerServiceIsDeleted(svc) || name == NULL || strncmp(name, want, 33) != 0) {
				continue;
			}
			addrs = otSrpServerHostGetAddresses(host, &count);
			if (count == 0) {
				continue;
			}
			memset(out, 0, sizeof(*out));
			out->sin6_family = AF_INET6;
			out->sin6_port = htons(otSrpServerServiceGetPort(svc));
			/* Prefer a routable address over link-local. */
			const otIp6Address *pick = &addrs[0];

			for (uint8_t i = 0; i < count; i++) {
				if (addrs[i].mFields.m8[0] != 0xfe) {
					pick = &addrs[i];
					break;
				}
			}
			memcpy(&out->sin6_addr, pick->mFields.m8, 16);
			found = true;
			break;
		}
	}
	openthread_mutex_unlock();
	return found;
}

static void start_case(void)
{
	uint8_t random[32];
	uint8_t dest_msg[113];
	uint8_t dest[32];
	int err;

	(void)mt_random((uint8_t *)&ephemeral_node, sizeof(ephemeral_node));
	(void)mt_random((uint8_t *)&case_local_id, sizeof(case_local_id));
	case_local_id |= 1;
	err = mt_random(random, sizeof(random));
	if (!err) {
		err = mt_ecdh_new(&eph_key, eph_pub);
	}
	if (!err) {
		size_t n = mt_case_destination_message(dest_msg, random, id.root_public_key, id.fabric_id, op_node);

		err = mt_hmac_sha256(id.ipk, 16, dest_msg, n, dest);
	}
	int n = err ? -1 : mt_case_sigma1(sigma1, sizeof(sigma1), random, case_local_id, dest, eph_pub);

	if (n < 0) {
		finish(err ? err : -ENOBUFS);
		return;
	}
	sigma1_len = (size_t)n;
	op = OP_SIGMA2;
	err = send_reliable(NULL, MT_PROTO_SECURE_CHANNEL, MT_SC_SIGMA1, sigma1, sigma1_len, true);
	if (err) {
		finish(err);
	}
}

static void resolve_step(struct k_work *w)
{
	ARG_UNUSED(w);
	if (op != OP_RESOLVE) {
		return;
	}
	if (have_addr) {
		peer_addr = given_addr;
		start_case();
		return;
	}
	if (resolve(op_node, &peer_addr)) {
		LOG_INF("node 0x%016llx found; opening CASE", (unsigned long long)op_node);
		start_case();
		return;
	}
	if (++resolve_tries >= 30) {
		LOG_WRN("node 0x%016llx is not registered with this board's SRP server", (unsigned long long)op_node);
		finish(-EHOSTUNREACH);
		return;
	}
	k_work_reschedule_for_queue(&wq, &resolve_work, K_SECONDS(2));
}

static void handle_sigma2(const uint8_t *body, size_t len)
{
	struct mt_case_sigma2 s2;
	struct mt_case_tbe2 t2;
	uint8_t salt[16 + 32 + 65 + 32];
	uint8_t s2k[16];
	uint8_t s3k[16];
	uint8_t tbe[MSG_MAX];
	uint8_t tbs[700];
	uint8_t peer_pub[65];
	uint8_t sig[64];
	static const uint8_t n2[13] = "NCASE_Sigma2N";
	static const uint8_t n3[13] = "NCASE_Sigma3N";
	int err;

	if (len > sizeof(sigma2) || !mt_case_parse_sigma2(body, len, &s2) || s2.encrypted_len - 16 > sizeof(tbe)) {
		finish(-EBADMSG);
		return;
	}
	memcpy(sigma2, body, len);
	sigma2_len = len;
	err = mt_ecdh_shared(eph_key, s2.eph_pub, shared);
	if (err) {
		finish(err);
		return;
	}
	/* S2K: salt = IPK || responder random || responder ephemeral key || SHA-256(Sigma1) */
	const uint8_t *p1[] = {sigma1};
	size_t l1[] = {sigma1_len};

	memcpy(salt, id.ipk, 16);
	memcpy(&salt[16], s2.random, 32);
	memcpy(&salt[48], s2.eph_pub, 65);
	err = mt_sha256(p1, l1, 1, &salt[113]);
	if (!err) {
		err = mt_hkdf(shared, 32, salt, sizeof(salt), (const uint8_t *)"Sigma2", 6, s2k, 16);
	}
	size_t tlen = s2.encrypted_len - 16;

	memcpy(tbe, s2.encrypted, tlen);
	if (!err) {
		err = mt_ccm_once(false, s2k, n2, tbe, tlen, (uint8_t *)&s2.encrypted[tlen]);
	}
	uint64_t peer_node_id;

	if (err || !mt_case_parse_tbe2(tbe, tlen, &t2) ||
	    !mt_identity_check_peer(&id, t2.noc, t2.noc_len, t2.icac, t2.icac_len, op_node, peer_pub, &peer_node_id)) {
		LOG_WRN("Sigma2 refused: %d", err);
		finish(-EACCES);
		return;
	}
	int n = mt_case_tbs(tbs, sizeof(tbs), t2.noc, t2.noc_len, t2.icac, t2.icac_len, s2.eph_pub, eph_pub);

	if (n < 0 || !mt_verify(peer_pub, tbs, (size_t)n, t2.signature)) {
		LOG_WRN("Sigma2 signature does not verify");
		finish(-EACCES);
		return;
	}
	/* Sigma3 */
	n = mt_case_tbs(tbs, sizeof(tbs), id.noc, id.noc_len, id.icac, id.icac_len, eph_pub, s2.eph_pub);
	err = n < 0 ? -ENOBUFS : id.sign(tbs, (size_t)n, sig);
	n = err ? -1 : mt_case_tbe3(tbe, sizeof(tbe) - 16, id.noc, id.noc_len, id.icac, id.icac_len, sig);
	if (n < 0) {
		finish(err ? err : -ENOBUFS);
		return;
	}
	const uint8_t *p2[] = {sigma1, sigma2};
	size_t l2[] = {sigma1_len, sigma2_len};

	err = mt_sha256(p2, l2, 2, &salt[16]);
	if (!err) {
		err = mt_hkdf(shared, 32, salt, 48, (const uint8_t *)"Sigma3", 6, s3k, 16);
	}
	if (!err) {
		err = mt_ccm_once(true, s3k, n3, tbe, (size_t)n, &tbe[n]);
	}
	int m = err ? -1 : mt_case_sigma3(sigma3, sizeof(sigma3), tbe, (size_t)n + 16);

	if (m < 0) {
		finish(err ? err : -ENOBUFS);
		return;
	}
	sigma3_len = (size_t)m;
	op_session = new_session(op_node);
	op_session->peer_id = s2.session_id;
	op_session->local_id = case_local_id;
	op_session->addr = peer_addr;
	op = OP_SIGMA_STATUS;
	err = send_reliable(NULL, MT_PROTO_SECURE_CHANNEL, MT_SC_SIGMA3, sigma3, sigma3_len, false);
	if (err) {
		finish(err);
	}
}

static void send_invoke(void)
{
	op = OP_INVOKE;
	int err = send_reliable(op_session, MT_PROTO_IM, MT_IM_INVOKE_REQUEST, invoke_body, invoke_len, true);

	if (err) {
		finish(err);
	}
}

static void handle_sigma_status(const uint8_t *body, size_t len)
{
	uint16_t general;
	uint32_t proto;
	uint16_t code;
	uint8_t salt[48];
	uint8_t keys[48];
	int err;

	if (!mt_status_report_parse(body, len, &general, &proto, &code) || general != 0 || code != 0) {
		LOG_WRN("CASE refused by the node");
		free_session(op_session);
		finish(-EACCES);
		return;
	}
	const uint8_t *p[] = {sigma1, sigma2, sigma3};
	size_t l[] = {sigma1_len, sigma2_len, sigma3_len};

	memcpy(salt, id.ipk, 16);
	err = mt_sha256(p, l, 3, &salt[16]);
	if (!err) {
		err = mt_hkdf(shared, 32, salt, sizeof(salt), (const uint8_t *)"SessionKeys", 11, keys, 48);
	}
	if (!err) {
		err = mt_ccm_import(&keys[0], &op_session->i2r);
	}
	if (!err) {
		err = mt_ccm_import(&keys[16], &op_session->r2i);
	}
	memset(keys, 0, sizeof(keys));
	if (err) {
		free_session(op_session);
		finish(err);
		return;
	}
	(void)mt_random((uint8_t *)&op_session->counter, sizeof(op_session->counter));
	op_session->counter = (op_session->counter & 0x0FFFFFFFu) + 1;
	LOG_INF("CASE session up with node 0x%016llx", (unsigned long long)op_node);
	if (invoke_pending) {
		invoke_pending = false;
		send_invoke();
	} else {
		finish(0);
	}
}

static void handle_invoke_response(const uint8_t *body, size_t len)
{
	struct mt_im_invoke_result res;

	if (!mt_im_parse_invoke_response(body, len, &res)) {
		finish(-EBADMSG);
		return;
	}
	if (!res.has_fields) {
		finish(res.status); /* 0 is success */
		return;
	}
	struct mt_tlv_reader r;
	struct mt_tlv_element e;

	if (op_fields) {
		op_fields(res.fields, res.fields_len);
	}
	mt_tlv_reader_init(&r, res.fields, res.fields_len);
	if (mt_tlv_next(&r, &e) && mt_tlv_find(&r, 0, &e) && e.type == MT_TLV_UINT && e.v.u != 0 && !op_fields) {
		finish((int)e.v.u);
		return;
	}
	finish(0);
}

static void rx_handler(struct k_work *w)
{
	struct mt_msg_header h;
	struct mt_proto_header p;
	struct session *s = NULL;
	uint8_t *msg = rx_slot.data;
	size_t len = rx_slot.len;
	size_t hdr;

	ARG_UNUSED(w);
	/* Exchanges a device starts (CASE to this board, OTA) are the server's. */
	if (mt_server_rx(msg, len, &rx_slot.from)) {
		goto done;
	}
	hdr = mt_msg_decode_header(msg, len, &h);
	if (hdr == 0) {
		goto done;
	}
	if (h.session_id != 0) {
		for (int i = 0; i < MAX_SESSIONS; i++) {
			if (sessions[i].in_use && sessions[i].local_id == h.session_id && sessions[i].i2r) {
				s = &sessions[i];
			}
		}
		if (s == NULL || len < hdr + MT_MIC_LEN) {
			goto done;
		}
		uint8_t nonce[MT_NONCE_LEN];

		mt_msg_nonce(&h, s->node_id, nonce);
		if (mt_ccm_decrypt(s->r2i, nonce, msg, hdr, &msg[hdr], len - hdr - MT_MIC_LEN,
				   &msg[len - MT_MIC_LEN]) != 0) {
			goto done;
		}
		len -= MT_MIC_LEN;
		if (!mt_counter_accept(&s->peer_counters, h.counter)) {
			/* a duplicate: acknowledge again, do nothing else */
			ack_pending = true;
			ack_counter = h.counter;
			ack_secure = true;
			send_standalone_ack(s);
			goto done;
		}
	}
	size_t ph = mt_msg_decode_proto(&msg[hdr], len - hdr, &p);

	if (ph == 0 || p.exchange_id != exchange_id) {
		goto done;
	}
	if (p.has_ack && tx_waiting_ack && p.ack_counter == tx_counter) {
		tx_waiting_ack = false;
		k_work_cancel_delayable(&retransmit_work);
	}
	if (p.protocol_id == MT_PROTO_SECURE_CHANNEL && p.opcode == MT_SC_STANDALONE_ACK) {
		goto done;
	}
	if (p.exchange_flags & MT_EX_RELIABLE) {
		ack_pending = true;
		ack_counter = h.counter;
		ack_secure = s != NULL;
	}
	const uint8_t *body = &msg[hdr + ph];
	size_t blen = len - hdr - ph;

	if (op == OP_SIGMA2 && s == NULL && p.opcode == MT_SC_SIGMA2) {
		handle_sigma2(body, blen); /* Sigma3 carries the acknowledgement */
	} else if (op == OP_SIGMA_STATUS && s == NULL && p.opcode == MT_SC_STATUS_REPORT) {
		send_standalone_ack(NULL);
		handle_sigma_status(body, blen);
	} else if (op == OP_INVOKE && s == op_session && p.protocol_id == MT_PROTO_IM &&
		   p.opcode == MT_IM_INVOKE_RESPONSE) {
		send_standalone_ack(s);
		handle_invoke_response(body, blen);
	} else if (op == OP_EXCHANGE && s == op_session && op_exchange_rx) {
		k_work_cancel_delayable(&timeout_work);
		op_exchange_rx(p.opcode, p.protocol_id, body, blen); /* answers carry the acknowledgement */
	} else if (op == OP_SIGMA2 && p.opcode == MT_SC_STATUS_REPORT) {
		send_standalone_ack(NULL);
		finish(-EACCES);
	} else if (ack_pending) {
		send_standalone_ack(s);
	}
done:
	k_sem_give(&rx_free);
}

static void rx_loop(void *a, void *b, void *c)
{
	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);
	for (;;) {
		k_sem_take(&rx_free, K_FOREVER);
		socklen_t fl = sizeof(rx_slot.from);
		ssize_t n = zsock_recvfrom(sock, rx_slot.data, sizeof(rx_slot.data), 0, (struct sockaddr *)&rx_slot.from,
					   &fl);

		if (n <= 0) {
			k_sem_give(&rx_free);
			k_sleep(K_MSEC(100));
			continue;
		}
		rx_slot.len = (uint16_t)n;
		k_work_submit_to_queue(&wq, &rx_work);
	}
}

int mt_ctl_sendto(const uint8_t *buf, size_t len, const struct sockaddr_in6 *to)
{
	return zsock_sendto(sock, buf, len, 0, (const struct sockaddr *)to, sizeof(*to)) < 0 ? -errno : 0;
}

void mt_ctl_schedule(struct k_work_delayable *work, k_timeout_t delay)
{
	k_work_reschedule_for_queue(&wq, work, delay);
}

int mt_ctl_init(void)
{
	struct sockaddr_in6 any = {.sin6_family = AF_INET6, .sin6_port = htons(MATTER_PORT)};

	if (sock >= 0) {
		return 0;
	}
	sock = zsock_socket(AF_INET6, SOCK_DGRAM, IPPROTO_UDP);
	if (sock < 0) {
		return -errno;
	}
	if (zsock_bind(sock, (struct sockaddr *)&any, sizeof(any)) < 0) {
		zsock_close(sock);
		sock = -1;
		return -errno;
	}
	(void)mt_random((uint8_t *)&unsecured_counter, sizeof(unsecured_counter));
	(void)mt_random((uint8_t *)&exchange_id, sizeof(exchange_id));
	k_work_queue_init(&wq);
	k_work_queue_start(&wq, wq_stack, K_THREAD_STACK_SIZEOF(wq_stack), K_PRIO_PREEMPT(9), NULL);
	k_work_init_delayable(&retransmit_work, retransmit);
	k_work_init_delayable(&timeout_work, timed_out);
	k_work_init_delayable(&resolve_work, resolve_step);
	k_work_init(&rx_work, rx_handler);
	k_sem_init(&rx_free, 1, 1);
	k_thread_create(&rx_thread, rx_stack, K_THREAD_STACK_SIZEOF(rx_stack), rx_loop, NULL, NULL, NULL,
			K_PRIO_PREEMPT(9), 0, K_NO_WAIT);
	return 0;
}

static int start_op_raw(uint64_t node, mt_ctl_done done);

static int start_op(uint64_t node, mt_ctl_done done)
{
	if (!mt_identity_get(MT_ID_OWN_FABRIC, &id)) {
		return -ENOENT;
	}
	have_addr = false;
	return start_op_raw(node, done);
}

static int start_op_raw(uint64_t node, mt_ctl_done done)
{
	if (sock < 0) {
		int err = mt_ctl_init();

		if (err) {
			return err;
		}
	}
	if (op != OP_IDLE) {
		return -EBUSY;
	}
	op_node = node;
	op_done = done;
	return 0;
}

static int start_op_raw(uint64_t node, mt_ctl_done done);
static void connect_work_fn(struct k_work *w)
{
	ARG_UNUSED(w);
	op_session = find_session(op_node);
	if (op_session && op_session->i2r) {
		peer_addr = op_session->addr;
		if (invoke_pending) {
			invoke_pending = false;
			send_invoke();
		} else {
			finish(0);
		}
		return;
	}
	op = OP_RESOLVE;
	resolve_tries = 0;
	resolve_step(NULL);
}
static K_WORK_DEFINE(connect_work, connect_work_fn);

int mt_ctl_connect(uint64_t node_id, mt_ctl_done done)
{
	int err = start_op(node_id, done);

	if (err) {
		return err;
	}
	invoke_pending = false;
	op = OP_RESOLVE;
	k_work_submit_to_queue(&wq, &connect_work);
	return 0;
}

int mt_ctl_invoke(uint64_t node_id, uint16_t endpoint, uint32_t cluster, uint32_t command,
		  void (*fields)(struct mt_tlv_writer *w, void *ctx), void *ctx, mt_ctl_done done)
{
	struct mt_tlv_writer w;
	int err = start_op(node_id, done);

	if (err) {
		return err;
	}
	mt_tlv_writer_init(&w, invoke_body, sizeof(invoke_body));
	mt_im_invoke_begin(&w, endpoint, cluster, command, false);
	if (fields) {
		fields(&w, ctx);
	}
	int n = mt_im_invoke_end(&w);

	if (n < 0) {
		op_done = NULL;
		return -ENOBUFS;
	}
	invoke_len = (size_t)n;
	invoke_pending = true;
	op = OP_RESOLVE;
	k_work_submit_to_queue(&wq, &connect_work);
	return 0;
}

void mt_ctl_drop(uint64_t node_id)
{
	struct session *s = find_session(node_id);

	if (s) {
		free_session(s);
	}
}

bool mt_ctl_busy(void)
{
	return op != OP_IDLE;
}

/* Reconnecting after a restart: one node at a time, each retried with a growing delay. */
static int reconnect_index;
static uint32_t reconnect_attempt;
static void reconnect_next(struct k_work *w);
static K_WORK_DELAYABLE_DEFINE(reconnect_work, reconnect_next);

static void reconnected(uint64_t node, int result)
{
	if (result == 0) {
		LOG_INF("node 0x%016llx is back", (unsigned long long)node);
		reconnect_index++;
		reconnect_attempt = 0;
		k_work_reschedule(&reconnect_work, K_NO_WAIT);
	} else {
		uint32_t ms = mp_backoff_ms(reconnect_attempt++, MP_RECONNECT_FIRST_MS, MP_RETRY_CAP_MS);

		LOG_INF("node 0x%016llx not reachable yet (%d), again in %u s", (unsigned long long)node, result,
			ms / 1000);
		k_work_reschedule(&reconnect_work, K_MSEC(ms));
	}
}

static void reconnect_next(struct k_work *w)
{
	const struct mt_fabric *f = mt_fabric();

	ARG_UNUSED(w);
	while (reconnect_index < MT_MAX_NODES && !f->nodes[reconnect_index].in_use) {
		reconnect_index++;
	}
	if (reconnect_index >= MT_MAX_NODES) {
		return;
	}
	if (mt_ctl_connect(f->nodes[reconnect_index].node_id, reconnected) == -EBUSY) {
		k_work_reschedule(&reconnect_work, K_SECONDS(5));
	}
}

void mt_ctl_reconnect_all(void)
{
	reconnect_index = 0;
	reconnect_attempt = 0;
	/* Mains-powered devices rejoin Thread within seconds of the board. */
	k_work_reschedule(&reconnect_work, K_MSEC(MP_RECONNECT_FIRST_MS));
}

int mt_ctl_invoke_phone(uint64_t node_id, const struct sockaddr_in6 *addr, uint16_t endpoint, uint32_t cluster,
			uint32_t command, void (*fields)(struct mt_tlv_writer *w, void *ctx), void *ctx,
			void (*response)(const uint8_t *fields, size_t len), mt_ctl_done done)
{
	struct mt_tlv_writer w;

	if (op != OP_IDLE) {
		return -EBUSY;
	}
	if (!mt_identity_get(MT_ID_PHONE_FABRIC, &id)) {
		return -ENOENT;
	}
	have_addr = addr != NULL;
	if (addr) {
		given_addr = *addr;
	}
	int err = start_op_raw(node_id, done);

	if (err) {
		return err;
	}
	op_fields = response;
	mt_tlv_writer_init(&w, invoke_body, sizeof(invoke_body));
	mt_im_invoke_begin(&w, endpoint, cluster, command, false);
	if (fields) {
		fields(&w, ctx);
	}
	int n = mt_im_invoke_end(&w);

	if (n < 0) {
		op_done = NULL;
		return -ENOBUFS;
	}
	invoke_len = (size_t)n;
	invoke_pending = true;
	op = OP_RESOLVE;
	k_work_submit_to_queue(&wq, &connect_work);
	return 0;
}

int mt_ctl_exchange_begin(void (*rx)(uint8_t opcode, uint16_t protocol, const uint8_t *body, size_t len),
			  mt_ctl_done done)
{
	if (op != OP_IDLE || op_session == NULL || op_session->i2r == PSA_KEY_ID_NULL) {
		return -ENOTCONN;
	}
	op = OP_EXCHANGE;
	op_exchange_rx = rx;
	op_done = done;
	return 0;
}

int mt_ctl_exchange_send(uint16_t protocol, uint8_t opcode, const uint8_t *body, size_t len, bool new_exchange)
{
	if (op != OP_EXCHANGE) {
		return -ENOTCONN;
	}
	return send_reliable(op_session, protocol, opcode, body, len, new_exchange);
}

void mt_ctl_exchange_end(int result)
{
	if (op == OP_EXCHANGE) {
		if (ack_pending) {
			send_standalone_ack(op_session);
		}
		finish(result);
	}
}

void mt_ctl_submit(struct k_work *work)
{
	k_work_submit_to_queue(&wq, work);
}
