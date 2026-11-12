/*
 * Host tests of this board as a Matter device (firmware/matter/src/matter/mt_dev_im.c, mt_csr.c, mt_btp.c's
 * server side): the commissioning commands a phone sends, in order, against a stand-in for the node's keys and
 * storage, and the reads it makes. Crypto and flash are the board's; here they are stubs that record calls.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mt_attest.h"
#include "mt_btp.h"
#include "mt_csr.h"
#include "mt_dev_im.h"
#include "mt_im.h"
#include "mt_node.h"
#include "mt_ota.h"
#include "mt_tlv.h"

static int failures;
static int checks;

#define CHECK(condition)                                                                     \
	do {                                                                                 \
		checks++;                                                                    \
		if (!(condition)) {                                                          \
			failures++;                                                          \
			printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);         \
		}                                                                            \
	} while (0)

/* ---- stand-ins for the board ---- */
const uint8_t mt_test_dac[] = {0x30, 0x03, 0x02, 0x01, 0x01};
const size_t mt_test_dac_len = sizeof(mt_test_dac);
const uint8_t mt_test_pai[] = {0x30, 0x03, 0x02, 0x01, 0x02};
const size_t mt_test_pai_len = sizeof(mt_test_pai);
const uint8_t mt_test_cd[] = {0x30, 0x03, 0x02, 0x01, 0x03};
const size_t mt_test_cd_len = sizeof(mt_test_cd);

static struct mt_node_fabric nf;
static bool failsafe;
static uint64_t breadcrumb;
static size_t last_signed_len;
static uint8_t last_signed[800];
static int roots_added;
static int nocs_added;
static bool complete;

const struct mt_node_fabric *mt_node_fabric(void) { return &nf; }
int mt_node_sign_dac(const uint8_t *d, size_t n, uint8_t sig[64])
{
	memcpy(last_signed, d, n);
	last_signed_len = n;
	memset(sig, 0xD5, 64);
	return 0;
}
int mt_node_arm_fail_safe(uint16_t s, uint64_t bc) { failsafe = s > 0; breadcrumb = bc; return 0; }
bool mt_node_fail_safe_armed(void) { return failsafe; }
uint64_t mt_node_breadcrumb(void) { return breadcrumb; }
void mt_node_set_breadcrumb(uint64_t v) { breadcrumb = v; }
static int fake_sign(void *c, const uint8_t *d, size_t n, uint8_t sig[64]) { (void)c; (void)d; (void)n; memset(sig, 0x80, 64); return 0; }
int mt_node_csr(uint8_t *csr, size_t cap)
{
	uint8_t pub[65];

	memset(pub, 4, sizeof(pub));
	return failsafe ? mt_csr_make(pub, fake_sign, NULL, csr, cap) : -1;
}
int mt_node_add_root(const uint8_t *r, size_t n) { (void)r; (void)n; roots_added++; return failsafe ? 0 : -1; }
int mt_node_add_noc(const uint8_t *noc, size_t nl, const uint8_t *icac, size_t il, const uint8_t ipk[16], uint64_t subj,
		    uint16_t vendor)
{
	(void)noc; (void)icac; (void)il; (void)ipk;
	nocs_added++;
	nf.present = true;
	nf.noc_len = nl;
	nf.admin_subject = subj;
	nf.vendor_id = vendor;
	return 0;
}
int mt_node_commissioning_complete(void) { complete = nf.present && failsafe; return complete ? 0 : -1; }
int mt_node_set_label(const char *l, size_t n) { memcpy(nf.label, l, n); nf.label[n] = 0; return 0; }
int mt_node_remove_fabric(void) { memset(&nf, 0, sizeof(nf)); return 0; }
int mt_node_set_ota_provider(uint64_t node, uint16_t ep) { nf.ota_provider_node = node; nf.ota_provider_endpoint = ep; return 0; }

static uint8_t wifi_ssid[33];
static int wifi_connects;
static uint64_t announced;
static int wadd(const uint8_t *s, size_t sl, const uint8_t *p, size_t pl) { (void)p; (void)pl; memcpy(wifi_ssid, s, sl); return 0; }
static int wconn(void) { wifi_connects++; return 0; }
static int tadd(const uint8_t *d, size_t n) { (void)d; (void)n; return 0; }
static void ann(uint64_t node, uint16_t ep) { (void)ep; announced = node; }
static int light;
static void onoff(bool on) { light = on ? 1 : 2; }
static const struct mt_dev_platform platform = {
	.wifi_add = wadd, .wifi_connect = wconn, .thread_add = tadd, .wifi = true, .software_version = 0x011500,
	.software_version_string = "1.21.0", .ota_announced = ann, .set_onoff = onoff,
};

/* ---- helpers ---- */
static uint8_t req[1024];
static uint8_t resp[1280];
static const uint8_t challenge[16] = {0xC1, 0xC2};

static int invoke(bool pase, uint32_t cluster, uint32_t cmd, void (*fields)(struct mt_tlv_writer *),
		  struct mt_im_invoke_result *res)
{
	struct mt_tlv_writer w;
	struct mt_dev_session s = {.pase = pase, .challenge = challenge, .fabric_index = pase ? 0 : 1};
	uint8_t op = 0;

	mt_tlv_writer_init(&w, req, sizeof(req));
	mt_im_invoke_begin(&w, 0, cluster, cmd, false);
	if (fields) {
		fields(&w);
	}
	int n = mt_im_invoke_end(&w);
	int m = mt_dev_im(&s, MT_IM_INVOKE_REQUEST, req, (size_t)n, &op, resp, sizeof(resp));

	CHECK(op == MT_IM_INVOKE_RESPONSE);
	CHECK(m > 0 && mt_im_parse_invoke_response(resp, (size_t)m, res));
	return m;
}

static uint64_t field_uint(const struct mt_im_invoke_result *r, uint8_t tag)
{
	struct mt_tlv_reader rd;
	struct mt_tlv_element e;

	mt_tlv_reader_init(&rd, r->fields, r->fields_len);
	return mt_tlv_next(&rd, &e) && mt_tlv_find(&rd, tag, &e) && e.type == MT_TLV_UINT ? e.v.u : 0xDEAD;
}

static bool field_bytes(const struct mt_im_invoke_result *r, uint8_t tag, struct mt_tlv_element *e)
{
	struct mt_tlv_reader rd;

	mt_tlv_reader_init(&rd, r->fields, r->fields_len);
	return mt_tlv_next(&rd, e) && mt_tlv_find(&rd, tag, e) && e->type == MT_TLV_BYTES;
}

static void f_arm(struct mt_tlv_writer *w) { mt_tlv_put_uint(w, 0, 60); mt_tlv_put_uint(w, 1, 1); }
static void f_reg(struct mt_tlv_writer *w) { mt_tlv_put_uint(w, 0, 0); mt_tlv_put_str(w, 1, "US"); mt_tlv_put_uint(w, 2, 2); }
static void f_pai(struct mt_tlv_writer *w) { mt_tlv_put_uint(w, 0, 2); }
static void f_dac(struct mt_tlv_writer *w) { mt_tlv_put_uint(w, 0, 1); }
static uint8_t nonce[32] = {0x99};
static void f_nonce(struct mt_tlv_writer *w) { mt_tlv_put_bytes(w, 0, nonce, 32); }
static void f_root(struct mt_tlv_writer *w) { static const uint8_t r[] = {0x15, 0x18}; mt_tlv_put_bytes(w, 0, r, 2); }
static void f_noc(struct mt_tlv_writer *w)
{
	static const uint8_t noc[100] = {0x15};
	static const uint8_t ipk[16] = {1};

	mt_tlv_put_bytes(w, 0, noc, sizeof(noc));
	mt_tlv_put_bytes(w, 2, ipk, 16);
	mt_tlv_put_uint(w, 3, 0x1122334455667788ull);
	mt_tlv_put_uint(w, 4, 0x1349);
}
static void f_wifi(struct mt_tlv_writer *w)
{
	mt_tlv_put_bytes(w, 0, (const uint8_t *)"home", 4);
	mt_tlv_put_bytes(w, 1, (const uint8_t *)"secret12", 8);
	mt_tlv_put_uint(w, 2, 3);
}
static void f_connect(struct mt_tlv_writer *w) { mt_tlv_put_bytes(w, 0, (const uint8_t *)"home", 4); mt_tlv_put_uint(w, 1, 4); }
static void f_announce(struct mt_tlv_writer *w)
{
	mt_tlv_put_uint(w, 0, 0xABCDull);
	mt_tlv_put_uint(w, 1, 0xFFF1);
	mt_tlv_put_uint(w, 2, 0);
	mt_tlv_put_uint(w, 4, 0);
}

static bool accept_all(const uint8_t k[65], const uint8_t *d, size_t n, const uint8_t s[64])
{
	(void)k; (void)d; (void)n; (void)s;
	return true;
}

static void test_commissioning(void)
{
	struct mt_im_invoke_result r;
	struct mt_tlv_element e;

	mt_dev_im_set_platform(&platform);
	/* Network commands before the fail-safe: refused */
	invoke(true, 0x31, 2, f_wifi, &r);
	CHECK(!r.has_fields && r.status == 0xCA);

	invoke(true, MT_CL_GENERAL_COMMISSIONING, MT_CMD_ARM_FAIL_SAFE, f_arm, &r);
	CHECK(r.has_fields && r.command == 1 && field_uint(&r, 0) == 0 && failsafe && breadcrumb == 1);
	invoke(true, MT_CL_GENERAL_COMMISSIONING, MT_CMD_SET_REGULATORY_CONFIG, f_reg, &r);
	CHECK(r.command == 3 && field_uint(&r, 0) == 0 && breadcrumb == 2);

	invoke(true, MT_CL_OPERATIONAL_CREDS, MT_CMD_CERT_CHAIN_REQUEST, f_pai, &r);
	CHECK(r.command == 3 && field_bytes(&r, 0, &e) && e.len == sizeof(mt_test_pai) && e.data[4] == 2);
	invoke(true, MT_CL_OPERATIONAL_CREDS, MT_CMD_CERT_CHAIN_REQUEST, f_dac, &r);
	CHECK(field_bytes(&r, 0, &e) && e.data[4] == 1);

	/* AttestationResponse: elements {1 CD, 2 nonce, 3 time}, signed over elements || challenge */
	invoke(true, MT_CL_OPERATIONAL_CREDS, MT_CMD_ATTESTATION_REQUEST, f_nonce, &r);
	CHECK(r.command == 1 && field_bytes(&r, 0, &e));
	CHECK(last_signed_len == e.len + 16 && memcmp(last_signed, e.data, e.len) == 0 &&
	      memcmp(&last_signed[e.len], challenge, 16) == 0);
	{
		struct mt_tlv_reader rd;
		struct mt_tlv_element x;

		mt_tlv_reader_init(&rd, e.data, e.len);
		CHECK(mt_tlv_next(&rd, &x) && mt_tlv_find(&rd, 1, &x) && x.len == sizeof(mt_test_cd));
		CHECK(mt_tlv_find(&rd, 2, &x) && x.len == 32 && x.data[0] == 0x99);
	}
	CHECK(field_bytes(&r, 1, &e) && e.len == 64 && e.data[0] == 0xD5);

	/* CSRResponse: NOCSRElements {1 CSR, 2 nonce}; the CSR is a PKCS#10 with our key */
	invoke(true, MT_CL_OPERATIONAL_CREDS, MT_CMD_CSR_REQUEST, f_nonce, &r);
	CHECK(r.command == 5 && field_bytes(&r, 0, &e));
	{
		struct mt_tlv_element sig;
		uint8_t dac_pub[65] = {4};
		uint8_t node_pub[65];

		CHECK(field_bytes(&r, 1, &sig) && sig.len == 64);
		/* the commissioner's own CSR check reads it (signatures are stand-ins here) */
		CHECK(mt_attest_csr(e.data, e.len, sig.data, nonce, challenge, dac_pub, accept_all, node_pub));
		CHECK(node_pub[0] == 4 && node_pub[64] == 4);
	}

	invoke(true, MT_CL_OPERATIONAL_CREDS, MT_CMD_ADD_TRUSTED_ROOT, f_root, &r);
	CHECK(!r.has_fields && r.status == 0 && roots_added == 1);
	invoke(true, MT_CL_OPERATIONAL_CREDS, MT_CMD_ADD_NOC, f_noc, &r);
	CHECK(r.command == 8 && field_uint(&r, 0) == 0 && field_uint(&r, 1) == 1 && nocs_added == 1);
	CHECK(nf.admin_subject == 0x1122334455667788ull && nf.vendor_id == 0x1349);

	invoke(true, 0x31, 2, f_wifi, &r);
	CHECK(r.command == 5 && field_uint(&r, 0) == 0 && memcmp(wifi_ssid, "home", 4) == 0 && breadcrumb == 3);
	invoke(true, 0x31, 6, f_connect, &r);
	CHECK(r.command == 7 && field_uint(&r, 0) == 0 && wifi_connects == 1);

	/* CommissioningComplete only over CASE */
	invoke(true, MT_CL_GENERAL_COMMISSIONING, MT_CMD_COMMISSIONING_COMPLETE, NULL, &r);
	CHECK(field_uint(&r, 0) != 0 && !complete);
	invoke(false, MT_CL_GENERAL_COMMISSIONING, MT_CMD_COMMISSIONING_COMPLETE, NULL, &r);
	CHECK(r.command == 5 && field_uint(&r, 0) == 0 && complete);

	/* The phone announces itself as OTA provider */
	invoke(false, MT_CL_OTA_REQUESTOR, MT_OTA_ANNOUNCE_PROVIDER, f_announce, &r);
	CHECK(!r.has_fields && r.status == 0 && announced == 0xABCD && nf.ota_provider_node == 0xABCD);

	/* Something not here */
	invoke(false, 0x0006, 1, NULL, &r);
	CHECK(r.status == MT_IM_STATUS_UNSUPPORTED_CLUSTER);
}

static void test_reads(void)
{
	struct mt_tlv_writer w;
	struct mt_dev_session s = {.pase = true, .challenge = challenge};
	uint8_t op;
	struct mt_attr_path paths[] = {
		{0, 0x30, 1}, {0, 0x28, 2}, {0, 0x28, 4}, {0, 0x31, 0xFFFC}, {0, 0x30, 0x77}, {0, 0x0006, 0},
	};
	int n = mt_im_read_request(req, sizeof(req), paths, 6);
	int m = mt_dev_im(&s, MT_IM_READ_REQUEST, req, (size_t)n, &op, resp, sizeof(resp));

	CHECK(op == MT_IM_REPORT_DATA && m > 0);
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	int data = 0;
	int statuses = 0;
	bool vid = false;
	bool wifi = false;

	mt_tlv_reader_init(&r, resp, (size_t)m);
	while (mt_tlv_next(&r, &e)) {
		if (e.context && e.tag == 1 && e.type == MT_TLV_STRUCT && r.depth == 4) {
			data++;
		}
		if (e.context && e.tag == 0 && e.type == MT_TLV_STRUCT && r.depth == 4) {
			statuses++;
		}
		if (e.context && e.tag == 2 && e.type == MT_TLV_UINT && e.v.u == 0xFFF1) {
			vid = true;
		}
		if (e.context && e.tag == 2 && e.type == MT_TLV_UINT && e.v.u == 1 && r.depth == 4) {
			wifi = true; /* FeatureMap: Wi-Fi */
		}
	}
	CHECK(!r.error && r.depth == 0);
	CHECK(data == 4 && statuses == 2 && vid && wifi);

	/* A wildcard read of the whole endpoint fits in a message and stays well formed */
	struct mt_attr_path all = {0};

	mt_tlv_writer_init(&w, req, sizeof(req));
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_start(&w, 0, MT_TLV_ARRAY);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_LIST);
	mt_tlv_put_uint(&w, 2, 0);
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	mt_tlv_put_bool(&w, 3, false);
	mt_tlv_end(&w);
	n = mt_tlv_finish(&w);
	(void)all;
	m = mt_dev_im(&s, MT_IM_READ_REQUEST, req, (size_t)n, &op, resp, 1000);
	CHECK(m > 0 && m <= 1000);
	mt_tlv_reader_init(&r, resp, (size_t)m);
	while (mt_tlv_next(&r, &e)) {
	}
	CHECK(!r.error && r.depth == 0);

	/* Subscribe over PASE: refused cleanly */
	m = mt_dev_im(&s, 0x03, req, (size_t)n, &op, resp, sizeof(resp));
	CHECK(op == MT_IM_STATUS_RESPONSE && m > 0);
}

static void test_btp_server(void)
{
	struct mt_btp c;
	struct mt_btp p;
	uint8_t pkt[256];
	uint16_t mtu;
	uint8_t win;
	size_t off = 0;
	static uint8_t msg[400];

	CHECK(mt_btp_handshake_request(pkt, 247, 4) == 9);
	CHECK(mt_btp_parse_handshake_request(pkt, 9, &mtu, &win) && mtu == 247 && win == 4);
	size_t n = mt_btp_server_accept(&p, pkt, 247, 4);

	CHECK(n == 6 && mt_btp_handshake_response(&c, pkt, n, 247));
	memset(msg, 0x3c, sizeof(msg));
	enum mt_btp_rx rr = MT_BTP_RX_MORE;

	while (off < sizeof(msg)) {
		n = mt_btp_segment(&c, msg, sizeof(msg), &off, pkt);
		rr = mt_btp_receive(&p, pkt, n);
	}
	CHECK(rr == MT_BTP_RX_MESSAGE && p.rx_len == sizeof(msg) && p.tx_unacked == 0);
	/* and back */
	off = 0;
	while (off < 100) {
		n = mt_btp_segment(&p, msg, 100, &off, pkt);
		rr = mt_btp_receive(&c, pkt, n);
	}
	CHECK(rr == MT_BTP_RX_MESSAGE && c.rx_len == 100);
	uint8_t bad[9] = {0x65, 0x6c, 0x03, 0, 0, 0, 247, 0, 4};

	CHECK(!mt_btp_parse_handshake_request(bad, 9, &mtu, &win));
}

static int invoke_ep(uint16_t ep, uint32_t cluster, uint32_t cmd, struct mt_im_invoke_result *res)
{
	struct mt_tlv_writer w;
	struct mt_dev_session s = {.pase = false, .challenge = challenge, .fabric_index = 1};
	uint8_t op = 0;

	mt_tlv_writer_init(&w, req, sizeof(req));
	mt_im_invoke_begin(&w, ep, cluster, cmd, false);
	int n = mt_im_invoke_end(&w);
	int m = mt_dev_im(&s, MT_IM_INVOKE_REQUEST, req, (size_t)n, &op, resp, sizeof(resp));

	CHECK(m > 0 && mt_im_parse_invoke_response(resp, (size_t)m, res));
	return m;
}

/* finds a uint/bool attribute value in a report: endpoint, cluster, attribute */
static bool report_value(const uint8_t *buf, size_t len, uint32_t ep, uint32_t cl, uint32_t at, uint64_t *v,
			 bool *has_sub, uint64_t *sub_id)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	uint64_t pe = 99, pc = 99, pa = 99;
	bool found = false;

	*has_sub = false;
	mt_tlv_reader_init(&r, buf, len);
	while (mt_tlv_next(&r, &e)) {
		if (r.depth == 1 && e.context && e.tag == 0 && e.type == MT_TLV_UINT) {
			*has_sub = true;
			*sub_id = e.v.u;
		}
		if (e.context && e.type == MT_TLV_UINT && r.depth == 5) {
			if (e.tag == 2) pe = e.v.u;
			if (e.tag == 3) pc = e.v.u;
			if (e.tag == 4) pa = e.v.u;
		}
		if (e.context && e.tag == 2 && r.depth == 4 && pe == ep && pc == cl && pa == at) {
			*v = e.type == MT_TLV_BOOL ? e.v.b : e.v.u;
			found = true;
		}
	}
	return found && !r.error && r.depth == 0;
}

static void test_light_and_subscription(void)
{
	struct mt_im_invoke_result r;
	struct mt_dev_session s = {.pase = false, .challenge = challenge, .fabric_index = 1};
	uint8_t op;
	uint64_t v = 7;
	bool has_sub;
	uint64_t sub_id = 0;

	mt_dev_im_set_platform(&platform);
	invoke_ep(1, 0x0006, 1, &r); /* On */
	CHECK(!r.has_fields && r.status == 0 && light == 1 && mt_dev_im_onoff());
	invoke_ep(1, 0x0006, 2, &r); /* Toggle */
	CHECK(r.status == 0 && light == 2 && !mt_dev_im_onoff());
	invoke_ep(1, 0x0003, 0, &r); /* Identify */
	CHECK(r.status == 0);
	invoke_ep(1, 0x0008, 0, &r); /* Level: not here */
	CHECK(r.status == MT_IM_STATUS_UNSUPPORTED_CLUSTER);
	invoke_ep(2, 0x0006, 0, &r);
	CHECK(r.status == 0x7F);

	/* read: the light's device type and its OnOff */
	struct mt_attr_path paths[] = {{1, 0x1D, 0}, {1, 0x06, 0}, {0, 0x1D, 3}};
	int n = mt_im_read_request(req, sizeof(req), paths, 3);
	int m = mt_dev_im(&s, MT_IM_READ_REQUEST, req, (size_t)n, &op, resp, sizeof(resp));

	CHECK(m > 0 && report_value(resp, (size_t)m, 1, 0x06, 0, &v, &has_sub, &sub_id) && v == 0 && !has_sub);

	/* subscribe to endpoint 1, max interval ceiling 30 */
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, req, sizeof(req));
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bool(&w, 0, false);
	mt_tlv_put_uint(&w, 1, 0);
	mt_tlv_put_uint(&w, 2, 30);
	mt_tlv_start(&w, 3, MT_TLV_ARRAY);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_LIST);
	mt_tlv_put_uint(&w, 2, 1);
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	mt_tlv_put_bool(&w, 7, true);
	mt_tlv_put_uint(&w, 0xFF, MT_IM_REVISION);
	mt_tlv_end(&w);
	n = mt_tlv_finish(&w);
	m = mt_dev_im(&s, 0x03, req, (size_t)n, &op, resp, sizeof(resp));
	CHECK(op == MT_IM_REPORT_DATA && m > 0);
	CHECK(report_value(resp, (size_t)m, 1, 0x06, 0, &v, &has_sub, &sub_id) && has_sub && sub_id > 0);
	uint64_t first_id = sub_id;

	CHECK(mt_dev_sub_max_interval() == 0); /* not active until the client took the priming report */
	m = mt_dev_sub_status(&op, resp, sizeof(resp));
	CHECK(m > 0 && op == 0x04 && mt_dev_sub_max_interval() == 30);
	CHECK(mt_dev_sub_status(&op, resp, sizeof(resp)) == -1); /* only once */

	/* a change: only OnOff is reported */
	mt_dev_im_changed = false;
	invoke_ep(1, 0x0006, 1, &r);
	CHECK(mt_dev_im_changed);
	m = mt_dev_sub_report(true, resp, sizeof(resp));
	CHECK(m > 0 && report_value(resp, (size_t)m, 1, 0x06, 0, &v, &has_sub, &sub_id) && v == 1 && sub_id == first_id);
	/* a keep-alive: no reports, the subscription ID */
	m = mt_dev_sub_report(false, resp, sizeof(resp));
	CHECK(m > 0 && m < 20);
	mt_dev_sub_end();
	CHECK(mt_dev_sub_report(false, resp, sizeof(resp)) == -1);
	/* not over PASE */
	s.pase = true;
	m = mt_dev_im(&s, 0x03, req, (size_t)n, &op, resp, sizeof(resp));
	CHECK(op == MT_IM_STATUS_RESPONSE);
}

int main(void)
{
	test_light_and_subscription();
	test_commissioning();
	test_reads();
	test_btp_server();
	printf("matter device: %d checks, %d failures\n", checks, failures);
	return failures ? EXIT_FAILURE : EXIT_SUCCESS;
}
