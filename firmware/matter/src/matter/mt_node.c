/*
 * See mt_node.h.
 */
#include "mt_node.h"

#include <errno.h>
#include <string.h>

#include <psa/crypto.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>

#include "mt_attest.h"
#include "mt_crypto.h"
#include "mt_csr.h"
#include "mt_fabric.h"

LOG_MODULE_REGISTER(mt_node, LOG_LEVEL_INF);

/* Generated at build time from the Matter SDK's test credentials (scripts/gen_test_credentials.py). */
extern const uint8_t mt_test_dac_key[];

#define OP_KEY_ID ((psa_key_id_t)0x4D540003)
/* A fixed salt: the passcode is the SDK's test passcode, the salt need not be secret. */
static const uint8_t salt[32] = "Cranium Matter test PBKDF salt!";

static struct mt_node_fabric nf;
static struct mt_node_fabric committed_copy;
static uint8_t verifier[97];
static psa_key_id_t dac_key = PSA_KEY_ID_NULL;
static bool failsafe;
static uint64_t breadcrumb;
static uint8_t pending_root[MT_CERT_TLV_MAX];
static size_t pending_root_len;
static struct k_work_delayable failsafe_work;

static int settings_set(const char *name, size_t len, settings_read_cb read_cb, void *cb_arg)
{
	if (strcmp(name, "fab") == 0 && len == sizeof(nf)) {
		(void)read_cb(cb_arg, &nf, sizeof(nf));
		committed_copy = nf;
	}
	return 0;
}

SETTINGS_STATIC_HANDLER_DEFINE(mt_node, "mtn", NULL, settings_set, NULL, NULL);

static int save(void)
{
	return settings_save_one("mtn/fab", &nf, sizeof(nf));
}

static void failsafe_expired(struct k_work *w)
{
	ARG_UNUSED(w);
	if (!failsafe) {
		return;
	}
	LOG_WRN("fail-safe expired: back to how the board was before commissioning");
	failsafe = false;
	breadcrumb = 0;
	pending_root_len = 0;
	nf = committed_copy;
	(void)save();
}

static int make_verifier(void)
{
	psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
	psa_key_derivation_operation_t op = PSA_KEY_DERIVATION_OPERATION_INIT;
	psa_key_id_t pw = PSA_KEY_ID_NULL;
	psa_key_id_t spake = PSA_KEY_ID_NULL;
	uint8_t pin[4] = {(uint8_t)MT_NODE_PASSCODE, (uint8_t)(MT_NODE_PASSCODE >> 8),
			  (uint8_t)(MT_NODE_PASSCODE >> 16), (uint8_t)(MT_NODE_PASSCODE >> 24)};
	size_t n;

	psa_set_key_usage_flags(&a, PSA_KEY_USAGE_DERIVE);
	psa_set_key_algorithm(&a, PSA_ALG_PBKDF2_HMAC(PSA_ALG_SHA_256));
	psa_set_key_type(&a, PSA_KEY_TYPE_PASSWORD);
	psa_status_t s = psa_import_key(&a, pin, sizeof(pin), &pw);

	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_setup(&op, PSA_ALG_PBKDF2_HMAC(PSA_ALG_SHA_256));
	}
	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_input_integer(&op, PSA_KEY_DERIVATION_INPUT_COST, MT_NODE_PBKDF_ITER);
	}
	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_SALT, salt, sizeof(salt));
	}
	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_input_key(&op, PSA_KEY_DERIVATION_INPUT_PASSWORD, pw);
	}
	if (s == PSA_SUCCESS) {
		psa_key_attributes_t k = PSA_KEY_ATTRIBUTES_INIT;

		psa_set_key_usage_flags(&k, PSA_KEY_USAGE_DERIVE | PSA_KEY_USAGE_EXPORT);
		psa_set_key_algorithm(&k, PSA_ALG_SPAKE2P_MATTER);
		psa_set_key_type(&k, PSA_KEY_TYPE_SPAKE2P_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
		psa_set_key_bits(&k, 256);
		s = psa_key_derivation_output_key(&k, &op, &spake);
	}
	if (s == PSA_SUCCESS) {
		s = psa_export_public_key(spake, verifier, sizeof(verifier), &n);
	}
	psa_key_derivation_abort(&op);
	psa_destroy_key(pw);
	psa_destroy_key(spake);
	return s == PSA_SUCCESS && n == sizeof(verifier) ? 0 : -EIO;
}

static int op_key(uint8_t pub[65], bool fresh)
{
	psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
	psa_key_id_t got;
	size_t n;

	if (fresh) {
		(void)psa_destroy_key(OP_KEY_ID);
	} else if (psa_export_public_key(OP_KEY_ID, pub, 65, &n) == PSA_SUCCESS) {
		return 0;
	}
	psa_set_key_id(&a, OP_KEY_ID);
	psa_set_key_lifetime(&a, PSA_KEY_LIFETIME_PERSISTENT);
	psa_set_key_type(&a, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
	psa_set_key_bits(&a, 256);
	psa_set_key_algorithm(&a, PSA_ALG_ECDSA(PSA_ALG_SHA_256));
	psa_set_key_usage_flags(&a, PSA_KEY_USAGE_SIGN_MESSAGE | PSA_KEY_USAGE_SIGN_HASH);
	if (psa_generate_key(&a, &got) != PSA_SUCCESS || psa_export_public_key(OP_KEY_ID, pub, 65, &n) != PSA_SUCCESS) {
		return -EIO;
	}
	return 0;
}

int mt_node_init(void)
{
	static bool done;
	psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;

	if (done) {
		return 0;
	}
	k_work_init_delayable(&failsafe_work, failsafe_expired);
	(void)settings_load_subtree("mtn");
	psa_set_key_type(&a, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
	psa_set_key_bits(&a, 256);
	psa_set_key_algorithm(&a, PSA_ALG_ECDSA(PSA_ALG_SHA_256));
	psa_set_key_usage_flags(&a, PSA_KEY_USAGE_SIGN_MESSAGE);
	if (psa_import_key(&a, mt_test_dac_key, 32, &dac_key) != PSA_SUCCESS) {
		return -EIO;
	}
	int err = make_verifier();

	if (err) {
		return err;
	}
	done = true;
	return 0;
}

const struct mt_node_fabric *mt_node_fabric(void)
{
	return &nf;
}

bool mt_node_commissionable(void)
{
	return !nf.committed;
}

const uint8_t *mt_node_verifier(void)
{
	return verifier;
}

const uint8_t *mt_node_salt(void)
{
	return salt;
}

static int sign_with(psa_key_id_t id, const uint8_t *data, size_t len, uint8_t sig[64])
{
	size_t n;

	return psa_sign_message(id, PSA_ALG_ECDSA(PSA_ALG_SHA_256), data, len, sig, 64, &n) == PSA_SUCCESS && n == 64
		       ? 0
		       : -EIO;
}

int mt_node_sign_dac(const uint8_t *data, size_t len, uint8_t sig[64])
{
	return sign_with(dac_key, data, len, sig);
}

int mt_node_sign_operational(const uint8_t *data, size_t len, uint8_t sig[64])
{
	return sign_with(OP_KEY_ID, data, len, sig);
}

int mt_node_arm_fail_safe(uint16_t seconds, uint64_t bc)
{
	if (seconds == 0) {
		/* Disarming before CommissioningComplete rolls back like an expiry. */
		k_work_cancel_delayable(&failsafe_work);
		if (failsafe && !nf.committed) {
			failsafe_expired(NULL);
		}
		failsafe = false;
		return 0;
	}
	if (!failsafe) {
		committed_copy = nf;
	}
	failsafe = true;
	breadcrumb = bc;
	k_work_reschedule(&failsafe_work, K_SECONDS(seconds));
	return 0;
}

bool mt_node_fail_safe_armed(void)
{
	return failsafe;
}

uint64_t mt_node_breadcrumb(void)
{
	return breadcrumb;
}

void mt_node_set_breadcrumb(uint64_t v)
{
	breadcrumb = v;
}

static int sign_op(void *ctx, const uint8_t *data, size_t len, uint8_t sig[64])
{
	ARG_UNUSED(ctx);
	return mt_node_sign_operational(data, len, sig);
}

int mt_node_csr(uint8_t *csr, size_t cap)
{
	uint8_t pub[65];

	if (!failsafe) {
		return -EPERM;
	}
	/* A new key for each commissioning: the old fabric's key goes with it. */
	int err = op_key(pub, !nf.present);

	if (err) {
		return err;
	}
	return mt_csr_make(pub, sign_op, NULL, csr, cap);
}

int mt_node_add_root(const uint8_t *rcac, size_t len)
{
	uint8_t pub[65];
	uint64_t node;
	uint64_t fabric;

	if (!failsafe || len > sizeof(pending_root) || !mt_cert_read(rcac, len, pub, &node, &fabric)) {
		return -EINVAL;
	}
	memcpy(pending_root, rcac, len);
	pending_root_len = len;
	return 0;
}

/* child is issued by the holder of parent_pub */
static bool signed_by(const uint8_t *child, size_t len, const uint8_t parent_pub[65])
{
	uint8_t der[MT_CERT_DER_MAX];
	struct mt_x509 x;
	int n = mt_cert_to_der(child, len, der, sizeof(der), NULL, NULL);

	return n > 0 && mt_x509_parse(der, (size_t)n, &x) && mt_verify(parent_pub, x.tbs, x.tbs_len, x.signature);
}

int mt_node_add_noc(const uint8_t *noc, size_t noc_len, const uint8_t *icac, size_t icac_len, const uint8_t ipk[16],
		    uint64_t admin_subject, uint16_t admin_vendor)
{
	uint8_t root_pub[65];
	uint8_t icac_pub[65];
	uint8_t noc_pub[65];
	uint8_t own_pub[65];
	uint64_t node;
	uint64_t fabric;
	uint64_t x;
	uint64_t y;
	size_t n;

	if (!failsafe || pending_root_len == 0) {
		return 3; /* InvalidNOC: no root yet */
	}
	if (nf.present) {
		return 7; /* TableFull: one phone fabric */
	}
	if (noc_len > sizeof(nf.noc) || icac_len > sizeof(nf.icac) ||
	    !mt_cert_read(pending_root, pending_root_len, root_pub, &x, &y) ||
	    !mt_cert_read(noc, noc_len, noc_pub, &node, &fabric)) {
		return 3;
	}
	if (psa_export_public_key(OP_KEY_ID, own_pub, 65, &n) != PSA_SUCCESS || memcmp(own_pub, noc_pub, 65) != 0) {
		return 1; /* InvalidPublicKey */
	}
	if (node == 0 || node > 0xFFFFFFEFFFFFFFFFull) {
		return 2; /* InvalidNodeOpId */
	}
	if (icac) {
		if (!mt_cert_read(icac, icac_len, icac_pub, &x, &y) || !signed_by(icac, icac_len, root_pub) ||
		    !signed_by(noc, noc_len, icac_pub)) {
			return 3;
		}
	} else if (!signed_by(noc, noc_len, root_pub)) {
		return 3;
	}
	memset(&nf, 0, sizeof(nf));
	nf.present = true;
	nf.fabric_id = fabric;
	nf.node_id = node;
	nf.vendor_id = admin_vendor;
	nf.admin_subject = admin_subject;
	memcpy(nf.root_public_key, root_pub, 65);
	memcpy(nf.rcac, pending_root, pending_root_len);
	nf.rcac_len = pending_root_len;
	memcpy(nf.noc, noc, noc_len);
	nf.noc_len = noc_len;
	if (icac) {
		memcpy(nf.icac, icac, icac_len);
		nf.icac_len = icac_len;
	}
	/* compressed fabric ID and the operational IPK, as for this board's own fabric */
	uint8_t s[8];

	for (int i = 0; i < 8; i++) {
		s[i] = (uint8_t)(fabric >> (56 - 8 * i));
	}
	if (mt_hkdf(&root_pub[1], 64, s, 8, (const uint8_t *)"CompressedFabric", 16, nf.compressed_id, 8) != 0 ||
	    mt_hkdf(ipk, 16, nf.compressed_id, 8, (const uint8_t *)"GroupKey v1.0", 13, nf.ipk, 16) != 0) {
		memset(&nf, 0, sizeof(nf));
		return 3;
	}
	LOG_INF("on the phone's fabric 0x%016llx as node 0x%016llx", (unsigned long long)fabric,
		(unsigned long long)node);
	return save() == 0 ? 0 : 3;
}

int mt_node_commissioning_complete(void)
{
	if (!failsafe || !nf.present) {
		return -EPERM;
	}
	nf.committed = true;
	failsafe = false;
	breadcrumb = 0;
	k_work_cancel_delayable(&failsafe_work);
	committed_copy = nf;
	LOG_INF("commissioned by the phone");
	return save();
}

int mt_node_set_label(const char *label, size_t len)
{
	if (len >= sizeof(nf.label)) {
		return -EINVAL;
	}
	memcpy(nf.label, label, len);
	nf.label[len] = '\0';
	return save();
}

int mt_node_remove_fabric(void)
{
	memset(&nf, 0, sizeof(nf));
	committed_copy = nf;
	(void)psa_destroy_key(OP_KEY_ID);
	return save();
}

int mt_node_set_ota_provider(uint64_t node, uint16_t endpoint)
{
	nf.ota_provider_node = node;
	nf.ota_provider_endpoint = endpoint;
	return save();
}
