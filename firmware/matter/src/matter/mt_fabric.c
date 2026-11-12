/*
 * See mt_fabric.h. The two private keys (fabric root, own operational) are persistent PSA keys and never leave
 * PSA; everything else is in settings under "mt/".
 */
#include "mt_fabric.h"

#include <errno.h>
#include <string.h>

#include <psa/crypto.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>

#include "mt_crypto.h"

LOG_MODULE_REGISTER(mt_fabric, LOG_LEVEL_INF);

#define ROOT_KEY_ID ((psa_key_id_t)0x4D540001)
#define OWN_KEY_ID  ((psa_key_id_t)0x4D540002)

/* The certificates say "valid from" 2026-01-01 and never expire: the board has no trusted clock. */
#define NOT_BEFORE_2026 820540800u

static struct mt_fabric fab;
static bool loaded;

struct stored {
	uint64_t fabric_id;
	uint64_t rcac_id;
	uint64_t own_node_id;
	uint64_t next_node_id;
	uint8_t epoch_key[16];
};

static int settings_set(const char *name, size_t len, settings_read_cb read_cb, void *cb_arg)
{
	if (strcmp(name, "fab") == 0 && len == sizeof(struct stored)) {
		struct stored s;

		if (read_cb(cb_arg, &s, sizeof(s)) == sizeof(s)) {
			fab.fabric_id = s.fabric_id;
			fab.rcac_id = s.rcac_id;
			fab.own_node_id = s.own_node_id;
			fab.next_node_id = s.next_node_id;
			memcpy(fab.epoch_key, s.epoch_key, 16);
			loaded = true;
		}
	} else if (strcmp(name, "rcac") == 0 && len <= sizeof(fab.rcac)) {
		ssize_t n = read_cb(cb_arg, fab.rcac, sizeof(fab.rcac));

		fab.rcac_len = n > 0 ? (size_t)n : 0;
	} else if (strcmp(name, "noc") == 0 && len <= sizeof(fab.own_noc)) {
		ssize_t n = read_cb(cb_arg, fab.own_noc, sizeof(fab.own_noc));

		fab.own_noc_len = n > 0 ? (size_t)n : 0;
	} else if (strcmp(name, "nodes") == 0 && len == sizeof(fab.nodes)) {
		(void)read_cb(cb_arg, fab.nodes, sizeof(fab.nodes));
	}
	return 0;
}

SETTINGS_STATIC_HANDLER_DEFINE(mt_fabric, "mt", NULL, settings_set, NULL, NULL);

static int save(void)
{
	struct stored s = {
		.fabric_id = fab.fabric_id, .rcac_id = fab.rcac_id, .own_node_id = fab.own_node_id,
		.next_node_id = fab.next_node_id,
	};
	int err;

	memcpy(s.epoch_key, fab.epoch_key, 16);
	err = settings_save_one("mt/fab", &s, sizeof(s));
	if (!err) {
		err = settings_save_one("mt/rcac", fab.rcac, fab.rcac_len);
	}
	if (!err) {
		err = settings_save_one("mt/noc", fab.own_noc, fab.own_noc_len);
	}
	if (!err) {
		err = settings_save_one("mt/nodes", fab.nodes, sizeof(fab.nodes));
	}
	return err;
}

static int key_pair(psa_key_id_t id, uint8_t pub[65], bool create)
{
	psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
	psa_key_id_t got;
	size_t n;
	psa_status_t s = psa_export_public_key(id, pub, 65, &n);

	if (s == PSA_SUCCESS) {
		return 0;
	}
	if (!create) {
		return -ENOENT;
	}
	psa_set_key_id(&a, id);
	psa_set_key_lifetime(&a, PSA_KEY_LIFETIME_PERSISTENT);
	psa_set_key_type(&a, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
	psa_set_key_bits(&a, 256);
	psa_set_key_algorithm(&a, PSA_ALG_ECDSA(PSA_ALG_SHA_256));
	psa_set_key_usage_flags(&a, PSA_KEY_USAGE_SIGN_MESSAGE | PSA_KEY_USAGE_SIGN_HASH);
	s = psa_generate_key(&a, &got);
	if (s == PSA_SUCCESS) {
		s = psa_export_public_key(id, pub, 65, &n);
	}
	return s == PSA_SUCCESS ? 0 : -EIO;
}

static int sign_with(void *ctx, const uint8_t *data, size_t len, uint8_t sig[64])
{
	psa_key_id_t id = (psa_key_id_t)(uintptr_t)ctx;
	size_t n;

	return psa_sign_message(id, PSA_ALG_ECDSA(PSA_ALG_SHA_256), data, len, sig, 64, &n) == PSA_SUCCESS && n == 64
		       ? 0
		       : -EIO;
}

bool mt_verify(const uint8_t public_key[65], const uint8_t *data, size_t len, const uint8_t sig[64])
{
	psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
	psa_key_id_t id;
	bool ok;

	psa_set_key_type(&a, PSA_KEY_TYPE_ECC_PUBLIC_KEY(PSA_ECC_FAMILY_SECP_R1));
	psa_set_key_bits(&a, 256);
	psa_set_key_algorithm(&a, PSA_ALG_ECDSA(PSA_ALG_SHA_256));
	psa_set_key_usage_flags(&a, PSA_KEY_USAGE_VERIFY_MESSAGE);
	if (psa_import_key(&a, public_key, 65, &id) != PSA_SUCCESS) {
		return false;
	}
	ok = psa_verify_message(id, PSA_ALG_ECDSA(PSA_ALG_SHA_256), data, len, sig, 64) == PSA_SUCCESS;
	psa_destroy_key(id);
	return ok;
}

/* Key identifiers: the first 20 bytes of SHA-256 of the public key. */
static void key_id(const uint8_t pub[65], uint8_t id[20])
{
	uint8_t h[32];
	const uint8_t *parts[] = {pub};
	size_t lens[] = {65};

	(void)mt_sha256(parts, lens, 1, h);
	memcpy(id, h, 20);
}

/* Compressed fabric ID and operational IPK (Matter specification 4.3.2.2 and 4.15.2). */
static int derive_ids(void)
{
	psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
	psa_key_id_t k;
	uint8_t salt[8];
	int err;

	for (int i = 0; i < 8; i++) {
		salt[i] = (uint8_t)(fab.fabric_id >> (56 - 8 * i));
	}
	psa_set_key_type(&a, PSA_KEY_TYPE_DERIVE);
	psa_set_key_usage_flags(&a, PSA_KEY_USAGE_DERIVE);
	psa_set_key_algorithm(&a, PSA_ALG_HKDF(PSA_ALG_SHA_256));
	if (psa_import_key(&a, &fab.root_public_key[1], 64, &k) != PSA_SUCCESS) {
		return -EIO;
	}
	static const uint8_t info1[] = "CompressedFabric";

	err = mt_hkdf_from_key(k, salt, 8, info1, sizeof(info1) - 1, fab.compressed_id, 8);
	psa_destroy_key(k);
	if (err) {
		return err;
	}
	if (psa_import_key(&a, fab.epoch_key, 16, &k) != PSA_SUCCESS) {
		return -EIO;
	}
	static const uint8_t info2[] = "GroupKey v1.0";

	err = mt_hkdf_from_key(k, fab.compressed_id, 8, info2, sizeof(info2) - 1, fab.operational_ipk, 16);
	psa_destroy_key(k);
	return err;
}

int mt_fabric_init(void)
{
	int err;

	(void)settings_load_subtree("mt");
	err = key_pair(ROOT_KEY_ID, fab.root_public_key, !loaded);
	if (err) {
		return err;
	}
	uint8_t own_pub[65];

	err = key_pair(OWN_KEY_ID, own_pub, !loaded);
	if (err) {
		return err;
	}
	if (!loaded || fab.rcac_len == 0 || fab.own_noc_len == 0) {
		struct mt_cert_params p;

		memset(&fab.nodes, 0, sizeof(fab.nodes));
		(void)mt_random((uint8_t *)&fab.fabric_id, 8);
		fab.fabric_id |= 1;
		(void)mt_random((uint8_t *)&fab.rcac_id, 4);
		fab.rcac_id &= 0xFFFFFFFFu;
		fab.rcac_id |= 1;
		/* Operational node IDs: 0x0000_0000_0000_0001 to 0xFFFF_FFEF_FFFF_FFFF; this board takes 1. */
		fab.own_node_id = 1;
		fab.next_node_id = 2;
		(void)mt_random(fab.epoch_key, sizeof(fab.epoch_key));

		memset(&p, 0, sizeof(p));
		p.is_root = true;
		p.serial = 1;
		p.rcac_id = fab.rcac_id;
		p.not_before = NOT_BEFORE_2026;
		memcpy(p.public_key, fab.root_public_key, 65);
		key_id(fab.root_public_key, p.subject_key_id);
		memcpy(p.authority_key_id, p.subject_key_id, 20);
		int n = mt_cert_make(&p, sign_with, (void *)(uintptr_t)ROOT_KEY_ID, fab.rcac, sizeof(fab.rcac));

		if (n < 0) {
			return n;
		}
		fab.rcac_len = (size_t)n;
		p.is_root = false;
		p.serial = 2;
		p.node_id = fab.own_node_id;
		p.fabric_id = fab.fabric_id;
		memcpy(p.public_key, own_pub, 65);
		key_id(own_pub, p.subject_key_id);
		key_id(fab.root_public_key, p.authority_key_id);
		n = mt_cert_make(&p, sign_with, (void *)(uintptr_t)ROOT_KEY_ID, fab.own_noc, sizeof(fab.own_noc));
		if (n < 0) {
			return n;
		}
		fab.own_noc_len = (size_t)n;
		err = save();
		if (err) {
			return err;
		}
		LOG_INF("new fabric 0x%016llx", (unsigned long long)fab.fabric_id);
	}
	return derive_ids();
}

const struct mt_fabric *mt_fabric(void)
{
	return &fab;
}

int mt_fabric_issue_noc(const uint8_t public_key[65], uint64_t *node_id, uint8_t *out, size_t cap)
{
	struct mt_cert_params p;
	uint64_t serial;

	memset(&p, 0, sizeof(p));
	(void)mt_random((uint8_t *)&serial, sizeof(serial));
	p.serial = serial & 0x7FFFFFFFFFFFFFFFull;
	p.rcac_id = fab.rcac_id;
	p.node_id = fab.next_node_id;
	p.fabric_id = fab.fabric_id;
	p.not_before = NOT_BEFORE_2026;
	memcpy(p.public_key, public_key, 65);
	key_id(public_key, p.subject_key_id);
	key_id(fab.root_public_key, p.authority_key_id);
	int n = mt_cert_make(&p, sign_with, (void *)(uintptr_t)ROOT_KEY_ID, out, cap);

	if (n < 0) {
		return n;
	}
	*node_id = fab.next_node_id++;
	(void)save();
	return n;
}

int mt_fabric_sign_own(const uint8_t *data, size_t len, uint8_t sig[64])
{
	return sign_with((void *)(uintptr_t)OWN_KEY_ID, data, len, sig);
}

int mt_fabric_add_node(uint64_t node_id, uint16_t vid, uint16_t pid)
{
	struct mt_node *free_slot = NULL;

	for (int i = 0; i < MT_MAX_NODES; i++) {
		if (fab.nodes[i].in_use && fab.nodes[i].node_id == node_id) {
			free_slot = &fab.nodes[i];
			break;
		}
		if (!fab.nodes[i].in_use && free_slot == NULL) {
			free_slot = &fab.nodes[i];
		}
	}
	if (free_slot == NULL) {
		return -ENOMEM;
	}
	free_slot->in_use = true;
	free_slot->node_id = node_id;
	free_slot->vendor_id = vid;
	free_slot->product_id = pid;
	return save();
}

int mt_fabric_remove_node(uint64_t node_id)
{
	for (int i = 0; i < MT_MAX_NODES; i++) {
		if (fab.nodes[i].in_use && fab.nodes[i].node_id == node_id) {
			fab.nodes[i].in_use = false;
			return save();
		}
	}
	return -ENOENT;
}

const struct mt_node *mt_fabric_node(uint64_t node_id)
{
	for (int i = 0; i < MT_MAX_NODES; i++) {
		if (fab.nodes[i].in_use && fab.nodes[i].node_id == node_id) {
			return &fab.nodes[i];
		}
	}
	return NULL;
}
