/*
 * "matter selftest": the board checks its own Matter pieces with known answers and prints one line each,
 *   SELFTEST <name> PASS|FAIL [detail]
 * and a last line SELFTEST RESULT PASS|FAIL, which tools/matter_check.py reads. The answers are the Matter
 * specification's and the Matter SDK's test vectors (the same as the host tests), run here through PSA.
 */
#include <string.h>

#include <openthread.h>
#include <openthread/srp_server.h>
#include <psa/crypto.h>
#include <zephyr/shell/shell.h>
#include <zephyr/storage/flash_map.h>

#include "matter_policy.h"
#include "mt_attest.h"
#include "mt_case_msg.h"
#include "mt_cert.h"
#include "mt_crypto.h"
#include "mt_fabric.h"
#include "mt_node.h"
#include "mt_tlv.h"
#include "ot_leader.h"

static const uint8_t root_pub[65] = {
	0x04, 0x4a, 0x9f, 0x42, 0xb1, 0xca, 0x48, 0x40, 0xd3, 0x72, 0x92, 0xbb, 0xc7, 0xf6, 0xa7, 0xe1, 0x1e,
	0x22, 0x20, 0x0c, 0x97, 0x6f, 0xc9, 0x00, 0xdb, 0xc9, 0x8a, 0x7a, 0x38, 0x3a, 0x64, 0x1c, 0xb8, 0x25,
	0x4a, 0x2e, 0x56, 0xd4, 0xe2, 0x95, 0xa8, 0x47, 0x94, 0x3b, 0x4e, 0x38, 0x97, 0xc4, 0xa7, 0x73, 0xe9,
	0x30, 0x27, 0x7b, 0x4d, 0x9f, 0xbe, 0xde, 0x8a, 0x05, 0x26, 0x86, 0xbf, 0xac, 0xfa,
};

static bool t_tlv(void)
{
	uint8_t b[8];
	struct mt_tlv_writer w;
	static const uint8_t want[] = {0x15, 0x20, 0x00, 0x2a, 0x20, 0x01, 0xef, 0x18};

	mt_tlv_writer_init(&w, b, sizeof(b));
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_int(&w, 0, 42);
	mt_tlv_put_int(&w, 1, -17);
	mt_tlv_end(&w);
	return mt_tlv_finish(&w) == 8 && memcmp(b, want, 8) == 0;
}

static bool t_sha256(void)
{
	static const uint8_t want[4] = {0xba, 0x78, 0x16, 0xbf};
	const uint8_t *p[] = {(const uint8_t *)"abc"};
	size_t l[] = {3};
	uint8_t h[32];

	return mt_sha256(p, l, 1, h) == 0 && memcmp(h, want, 4) == 0;
}

static bool t_destination_id(void)
{
	static const uint8_t ipk[16] = {0x9b, 0xc6, 0x1c, 0xd9, 0xc6, 0x2a, 0x2d, 0xf6,
					0xd6, 0x4d, 0xfc, 0xaa, 0x9d, 0xc4, 0x72, 0xd4};
	static const uint8_t random[32] = {
		0x7e, 0x17, 0x12, 0x31, 0x56, 0x8d, 0xfa, 0x17, 0x20, 0x6b, 0x3a, 0xcc, 0xf8, 0xfa, 0xec, 0x2f,
		0x4d, 0x21, 0xb5, 0x80, 0x11, 0x31, 0x96, 0xf4, 0x7c, 0x7c, 0x4d, 0xeb, 0x81, 0x0a, 0x73, 0xdc,
	};
	static const uint8_t want[4] = {0xdc, 0x35, 0xdd, 0x5f};
	uint8_t msg[113];
	uint8_t out[32];
	size_t n = mt_case_destination_message(msg, random, root_pub, 0x2906C908D115D362ull, 0xCD5544AA7B13EF14ull);

	return mt_hmac_sha256(ipk, 16, msg, n, out) == 0 && memcmp(out, want, 4) == 0;
}

static bool t_fabric_ids(void)
{
	static const uint8_t want_cfid[8] = {0x87, 0xe1, 0xb0, 0x04, 0xe2, 0x35, 0xa1, 0x30};
	static const uint8_t want_ipk[4] = {0xc5, 0xf2, 0x69, 0x01};
	static const uint8_t salt[8] = {0x29, 0x06, 0xC9, 0x08, 0xD1, 0x15, 0xD3, 0x62};
	uint8_t cfid[8];
	uint8_t ipk[16];
	uint8_t epoch[16] = {0};

	return mt_hkdf(&root_pub[1], 64, salt, 8, (const uint8_t *)"CompressedFabric", 16, cfid, 8) == 0 &&
	       memcmp(cfid, want_cfid, 8) == 0 &&
	       mt_hkdf(epoch, 16, cfid, 8, (const uint8_t *)"GroupKey v1.0", 13, ipk, 16) == 0 &&
	       memcmp(ipk, want_ipk, 4) == 0;
}

/* SPAKE2+ both ways on the board: the commissioner's prover against the device's verifier. */
static bool t_spake2p(void)
{
	struct mt_spake prover;
	struct mt_spake verifier;
	uint8_t ctx[32] = {1};
	uint8_t pa[65];
	uint8_t pb[65];
	uint8_t ca[32];
	uint8_t cb[32];
	psa_key_id_t k1 = PSA_KEY_ID_NULL;
	psa_key_id_t k2 = PSA_KEY_ID_NULL;
	uint8_t s1[16];
	uint8_t s2[16];
	bool ok = mt_node_init() == 0 &&
		  mt_spake_begin(&prover, MT_NODE_PASSCODE, mt_node_salt(), 32, MT_NODE_PBKDF_ITER, ctx) == 0 &&
		  mt_spake_begin_verifier(&verifier, mt_node_verifier(), ctx) == 0 && mt_spake_round1(&prover, pa) == 0 &&
		  mt_spake_verifier_round(&verifier, pa, pb, cb) == 0 && mt_spake_round2(&prover, pb, ca) == 0 &&
		  mt_spake_verifier_confirm(&verifier, ca, &k2) == 0 && mt_spake_confirm(&prover, cb, &k1) == 0 &&
		  mt_hkdf_from_key(k1, NULL, 0, (const uint8_t *)"x", 1, s1, 16) == 0 &&
		  mt_hkdf_from_key(k2, NULL, 0, (const uint8_t *)"x", 1, s2, 16) == 0 && memcmp(s1, s2, 16) == 0;

	mt_spake_abort(&prover);
	mt_spake_abort(&verifier);
	psa_destroy_key(k1);
	psa_destroy_key(k2);
	return ok;
}

static bool t_ecdh_ccm(void)
{
	psa_key_id_t a;
	psa_key_id_t b;
	uint8_t pa[65];
	uint8_t pb[65];
	uint8_t sa[32];
	uint8_t sb[32];
	uint8_t text[20] = "matter selftest data";
	uint8_t mic[16];
	static const uint8_t nonce[13] = "NCASE_Sigma2N";
	bool ok = mt_ecdh_new(&a, pa) == 0 && mt_ecdh_new(&b, pb) == 0 && mt_ecdh_shared(a, pb, sa) == 0 &&
		  mt_ecdh_shared(b, pa, sb) == 0 && memcmp(sa, sb, 32) == 0 &&
		  mt_ccm_once(true, sa, nonce, text, sizeof(text), mic) == 0 &&
		  mt_ccm_once(false, sb, nonce, text, sizeof(text), mic) == 0 && memcmp(text, "matter selftest data", 20) == 0;

	psa_destroy_key(a);
	psa_destroy_key(b);
	return ok;
}

/* The fabric's root certificate verifies with its own key, through the TLV-to-DER conversion. */
static bool t_certificates(void)
{
	const struct mt_fabric *f = mt_fabric();
	uint8_t der[MT_CERT_DER_MAX];
	struct mt_x509 x;
	int n;

	if (mt_fabric_init() != 0) {
		return false;
	}
	n = mt_cert_to_der(f->rcac, f->rcac_len, der, sizeof(der), NULL, NULL);
	return n > 0 && mt_x509_parse(der, (size_t)n, &x) && mt_verify(f->root_public_key, x.tbs, x.tbs_len, x.signature);
}

static bool t_onboarding(void)
{
	char qr[23];
	char manual[12];

	mp_qr_payload(MT_NODE_VENDOR_ID, MT_NODE_PRODUCT_ID, 0x02, MT_NODE_DISCRIMINATOR, MT_NODE_PASSCODE, qr);
	mp_manual_code(MT_NODE_DISCRIMINATOR, MT_NODE_PASSCODE, manual);
	return strcmp(qr, "MT:Y.K9042C00KA0648G00") == 0 && strcmp(manual, "34970112332") == 0;
}

static bool t_thread(const char **detail)
{
	*detail = ot_leader_role();
	return strcmp(*detail, "leader") == 0 || strcmp(*detail, "router") == 0;
}

static bool t_srp(void)
{
	otSrpServerState st;

	openthread_mutex_lock();
	st = otSrpServerGetState(openthread_get_default_instance());
	openthread_mutex_unlock();
	return st == OT_SRP_SERVER_STATE_RUNNING;
}

static bool t_flash(void)
{
	const struct flash_area *fa;
	uint8_t b[32];
	bool ok = flash_area_open(PARTITION_ID(ota_store_partition), &fa) == 0;

	if (ok) {
		ok = flash_area_read(fa, 0, b, sizeof(b)) == 0;
		flash_area_close(fa);
	}
	if (ok && flash_area_open(PARTITION_ID(slot1_partition), &fa) == 0) {
		ok = flash_area_read(fa, 0, b, sizeof(b)) == 0;
		flash_area_close(fa);
	} else {
		ok = false;
	}
	return ok;
}

int matter_selftest_cmd(const struct shell *sh, size_t argc, char **argv)
{
	const char *thread_role = "";
	bool all = true;
	struct {
		const char *name;
		bool ok;
	} r[] = {
		{"tlv", t_tlv()},
		{"sha256", t_sha256()},
		{"case_destination_id", t_destination_id()},
		{"fabric_ids", t_fabric_ids()},
		{"spake2p", t_spake2p()},
		{"ecdh_aes_ccm", t_ecdh_ccm()},
		{"certificates", t_certificates()},
		{"onboarding_codes", t_onboarding()},
		{"thread_leader", t_thread(&thread_role)},
		{"srp_server", t_srp()},
		{"flash_areas", t_flash()},
	};

	ARG_UNUSED(argc);
	ARG_UNUSED(argv);
	for (size_t i = 0; i < ARRAY_SIZE(r); i++) {
		shell_print(sh, "SELFTEST %s %s%s%s", r[i].name, r[i].ok ? "PASS" : "FAIL",
			    strcmp(r[i].name, "thread_leader") == 0 ? " role=" : "",
			    strcmp(r[i].name, "thread_leader") == 0 ? thread_role : "");
		all &= r[i].ok;
	}
	shell_print(sh, "SELFTEST RESULT %s", all ? "PASS" : "FAIL");
	return all ? 0 : -EIO;
}

